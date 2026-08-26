import type {
  ApiProvider,
  CallApiContextParams,
  ProviderResponse,
} from "promptfoo";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryTraceStore, sanitizeTraceEvent, Tracer } from "@dkagent/trace";
import { AgentLoop } from "../../packages/agent/src/agent/loop.js";
import { AGENT_SYSTEM_PROMPT } from "../../packages/agent/src/agent/prompt.js";
import { loadConfig } from "../../packages/agent/src/config.js";
import { ContextManager, ProviderTokenCounter } from "../../packages/agent/src/context/index.js";
import { OpenAICompatibleProvider } from "../../packages/agent/src/query-engine/providers/openai-compatible.js";
import { QueryEngine } from "../../packages/agent/src/query-engine/query-engine.js";
import { createFindFilesTool } from "../../packages/agent/src/tools/filesystem/find-files.js";
import { createGrepFilesTool } from "../../packages/agent/src/tools/filesystem/grep-files.js";
import { createReadFileTool } from "../../packages/agent/src/tools/filesystem/read-file.js";
import { createWriteFileTool } from "../../packages/agent/src/tools/filesystem/write-file.js";
import { ToolRegistry } from "../../packages/agent/src/tools/registry.js";
import type { LLMProvider } from "../../packages/agent/src/query-engine/provider.js";
import type { TraceEvent } from "@dkagent/trace";
import type { AgentEvalRunMetadata } from "./assertions.js";
import { cleanupRunRoot } from "./internal/cleanup.js";
import { findUnpairedToolCallIds, selectToolCalls, selectToolResults } from "./trace-selectors.js";

export type AgentEvalToolName =
  | "read_file"
  | "find_files"
  | "grep_files"
  | "write_file";

export interface RunAgentEvalCaseOptions {
  caseId: string;
  prompt: string;
  enabledTools: Array<AgentEvalToolName>;
  captureFiles?: string[];
  provider: LLMProvider;
  model: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  secrets?: string[];
}

const FIXTURES_ROOT = fileURLToPath(new URL("./fixtures/", import.meta.url));
const REDACTED = "[REDACTED]";
const UNSAFE_SECRET_ERROR = "评测配置不安全，无法安全返回运行结果";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactionSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets)]
    .filter((secret) => secret !== "")
    .sort((left, right) => right.length - left.length);
}

function redactText(value: string, secrets: readonly string[]): string {
  return secrets
    .reduce((text, secret) => text.split(secret).join(REDACTED), value);
}

type RedactionScope = "payload" | "metadata" | "trace";

function isAgentEvalRunMetadata(value: unknown): value is AgentEvalRunMetadata {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).caseId === "string"
    && Array.isArray((value as Record<string, unknown>).traceEvents);
}

export function redactMetadata<T>(value: T, secrets: readonly string[]): T {
  const usableSecrets = redactionSecrets(secrets);
  const redacted = redactMetadataValue(value, usableSecrets, "payload");
  assertTraceSelectorsRemainParseable(value, redacted);
  return redacted as T;
}

function redactMetadataValue(
  value: unknown,
  secrets: readonly string[],
  scope: RedactionScope,
): unknown {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactMetadataValue(item, secrets, scope));
  }
  if (value && typeof value === "object") {
    const objectScope = isAgentEvalRunMetadata(value)
      ? "metadata"
      : isTraceEvent(value) ? "trace" : scope;
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const redactedKey = redactText(key, secrets);
      if (objectScope !== "payload" && redactedKey !== key) {
        throw new Error(UNSAFE_SECRET_ERROR);
      }
      const childScope = objectScope === "trace" && key === "data"
        ? "payload"
        : objectScope === "metadata" && key === "traceEvents"
          ? "trace"
          : objectScope;
      redacted[redactedKey] = redactMetadataValue(item, secrets, childScope);
    }
    return redacted;
  }
  return value;
}

function isTraceEvent(value: unknown): value is TraceEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.traceId === "string"
    && typeof record.sequence === "number"
    && typeof record.timestamp === "string"
    && typeof record.name === "string"
    && typeof record.phase === "string"
    && Object.hasOwn(record, "data");
}

function assertTraceEventStructure(original: TraceEvent, redacted: unknown): void {
  if (!isTraceEvent(redacted)) {
    throw new Error(UNSAFE_SECRET_ERROR);
  }
  const originalStructure = { ...original } as Record<string, unknown>;
  const redactedStructure = { ...redacted } as Record<string, unknown>;
  delete originalStructure.data;
  delete redactedStructure.data;
  if (JSON.stringify(originalStructure) !== JSON.stringify(redactedStructure)) {
    throw new Error(UNSAFE_SECRET_ERROR);
  }
}

function assertAgentEvalRunStructure(
  original: AgentEvalRunMetadata,
  redacted: unknown,
): void {
  if (!isAgentEvalRunMetadata(redacted)) {
    throw new Error(UNSAFE_SECRET_ERROR);
  }
  const redactedMetadata = redacted as AgentEvalRunMetadata;
  if (original.caseId !== redactedMetadata.caseId
    || original.traceEvents.length !== redactedMetadata.traceEvents.length) {
    throw new Error(UNSAFE_SECRET_ERROR);
  }
  original.traceEvents.forEach((event, index) => {
    assertTraceEventStructure(event, redactedMetadata.traceEvents[index]);
  });
  if (original.runError !== undefined
    && original.runError.stage !== redactedMetadata.runError?.stage) {
    throw new Error(UNSAFE_SECRET_ERROR);
  }
}

function assertTraceSelectorArray(
  original: readonly TraceEvent[],
  redacted: readonly TraceEvent[],
): void {
  original.forEach((event, index) => {
    assertTraceEventStructure(event, redacted[index]);
  });
  if (original.some((event, index) => (
    event.name !== redacted[index]?.name || event.phase !== redacted[index]?.phase
  ))) {
    throw new Error(UNSAFE_SECRET_ERROR);
  }
  const originalCalls = selectToolCalls(original);
  const redactedCalls = selectToolCalls(redacted);
  const originalResults = selectToolResults(original);
  const redactedResults = selectToolResults(redacted);
  if (
    originalCalls.length !== redactedCalls.length
    || originalResults.length !== redactedResults.length
    || JSON.stringify(originalCalls.map((call) => [call.id, call.name]))
      !== JSON.stringify(redactedCalls.map((call) => [call.id, call.name]))
    || JSON.stringify(originalResults.map((result) => [
      result.toolCallId,
      result.name,
      result.result.success,
    ])) !== JSON.stringify(redactedResults.map((result) => [
      result.toolCallId,
      result.name,
      result.result.success,
    ]))
    || JSON.stringify(findUnpairedToolCallIds(original)) !== JSON.stringify(findUnpairedToolCallIds(redacted))
  ) {
    throw new Error(UNSAFE_SECRET_ERROR);
  }
}

function assertTraceSelectorsRemainParseable(original: unknown, redacted: unknown): void {
  if (isAgentEvalRunMetadata(original)) {
    assertAgentEvalRunStructure(original, redacted);
  }
  if (Array.isArray(original) && original.every(isTraceEvent)) {
    if (!Array.isArray(redacted) || redacted.length !== original.length || !redacted.every(isTraceEvent)) {
      throw new Error(UNSAFE_SECRET_ERROR);
    }
    assertTraceSelectorArray(original, redacted);
    return;
  }
  if (
    typeof original !== "object"
    || original === null
    || Array.isArray(original)
    || typeof redacted !== "object"
    || redacted === null
    || Array.isArray(redacted)
  ) return;

  const redactedRecord = redacted as Record<string, unknown>;
  for (const [key, item] of Object.entries(original)) {
    if (Array.isArray(item) && item.every(isTraceEvent) && !Object.hasOwn(redactedRecord, key)) {
      throw new Error(UNSAFE_SECRET_ERROR);
    }
    if (Object.hasOwn(redactedRecord, key)) {
      assertTraceSelectorsRemainParseable(item, redactedRecord[key]);
    }
  }
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate);
  return path !== ""
    && path !== ".."
    && !path.startsWith(`..${sep}`)
    && !isAbsolute(path);
}

function fixturePath(caseId: string): string {
  const candidate = resolve(FIXTURES_ROOT, caseId);
  if (!isWithinDirectory(FIXTURES_ROOT, candidate)) {
    throw new Error(`非法 Case ID: ${caseId}`);
  }
  return candidate;
}

function capturePath(workspace: string, name: string): string {
  const candidate = resolve(workspace, name);
  if (!isWithinDirectory(workspace, candidate)) {
    throw new Error(`captureFiles 必须位于临时 workspace 内: ${name}`);
  }
  return candidate;
}

function classifyRunError(
  error: unknown,
  traceEvents: readonly import("@dkagent/trace").TraceEvent[],
): NonNullable<AgentEvalRunMetadata["runError"]> {
  const stage = traceEvents.some(
    (event) => event.name === "model.request" && event.phase === "error",
  )
    ? "model"
    : "agent";
  return { stage, message: errorMessage(error) };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

function registerEnabledTools(
  registry: ToolRegistry,
  enabledTools: readonly AgentEvalToolName[],
  workspace: string,
): void {
  for (const name of enabledTools) {
    switch (name) {
      case "read_file":
        registry.register(createReadFileTool(workspace));
        break;
      case "find_files":
        registry.register(createFindFilesTool(workspace));
        break;
      case "grep_files":
        registry.register(createGrepFilesTool(workspace));
        break;
      case "write_file":
        registry.register(createWriteFileTool(workspace));
        break;
      default:
        throw new Error(`不支持的评测 Tool: ${String(name)}`);
    }
  }
}

function safeProviderSetupMessage(error: unknown): string {
  const values = [
    process.env.LLM_API_KEY,
    process.env.QWEN_API_KEY,
    process.env.DEEPSEEK_API_KEY,
  ].filter((value): value is string => Boolean(value));
  return redactText(errorMessage(error), redactionSecrets(values));
}

export async function runAgentEvalCase(
  options: RunAgentEvalCaseOptions,
): Promise<ProviderResponse> {
  const secrets = options.secrets ?? [];
  const evalRun: AgentEvalRunMetadata = {
    caseId: options.caseId,
    traceEvents: [],
  };
  const response: ProviderResponse = {
    output: "",
    metadata: { evalRun },
  };
  let runRoot: string | undefined;
  let traceStore: MemoryTraceStore | undefined;
  let workspace: string | undefined;
  let setupComplete = false;
  let agent: AgentLoop | undefined;

  const refreshTrace = (): void => {
    evalRun.traceEvents = traceStore?.list().map((event) => sanitizeTraceEvent(event)) ?? [];
  };

  const recordRunError = (
    stage: NonNullable<AgentEvalRunMetadata["runError"]>["stage"],
    error: unknown,
  ): void => {
    if (stage === "cleanup") {
      evalRun.runError = {
        stage,
        message: evalRun.runError === undefined
          ? "评测临时 workspace 清理失败"
          : "评测运行失败，且临时 workspace 清理失败",
      };
      return;
    }
    if (evalRun.runError === undefined) {
      evalRun.runError = { stage, message: errorMessage(error) };
    }
  };

  try {
    runRoot = await mkdtemp(join(tmpdir(), "dkagent-agent-eval-"));
    workspace = join(runRoot, "workspace");
    await cp(fixturePath(options.caseId), workspace, { recursive: true });

    traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const queryEngine = new QueryEngine(options.provider);
    const contextManager = new ContextManager(
      new ProviderTokenCounter(options.provider),
      undefined,
      tracer,
    );
    const toolRegistry = new ToolRegistry();
    registerEnabledTools(toolRegistry, options.enabledTools, workspace);
    agent = new AgentLoop({
      queryEngine,
      toolRegistry,
      contextManager,
      model: options.model,
      maxContextTokens: options.maxContextTokens,
      maxOutputTokens: options.maxOutputTokens,
      maxSteps: 12,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      tracer,
    });
    setupComplete = true;
  } catch (error: unknown) {
    refreshTrace();
    recordRunError("setup", error);
  }

  try {
    if (setupComplete && agent && workspace) {
      try {
        response.output = await agent.run(options.prompt);
      } catch (error: unknown) {
        refreshTrace();
        const runError = classifyRunError(error, evalRun.traceEvents);
        recordRunError(runError.stage, error);
      }

      if (options.captureFiles !== undefined) {
        evalRun.finalFiles = {};
        for (const name of options.captureFiles) {
          try {
            const path = capturePath(workspace, name);
            evalRun.finalFiles[name] = await readFile(path, "utf8");
          } catch (error: unknown) {
            if (!isMissingFileError(error)) {
              recordRunError("capture", error);
            }
          }
        }
      }
    }
  } finally {
    refreshTrace();
    if (runRoot !== undefined) {
      try {
        await cleanupRunRoot(runRoot);
      } catch (error: unknown) {
        recordRunError("cleanup", error);
      }
    }
  }

  try {
    const redactedEvalRun = redactMetadata(evalRun, secrets);
    const redactedOutput = redactText(response.output, redactionSecrets(secrets));
    response.output = redactedOutput;
    response.metadata = { evalRun: redactedEvalRun };
    return response;
  } catch {
    return { error: UNSAFE_SECRET_ERROR };
  }
}

export class DkAgentEvalProvider implements ApiProvider {
  public readonly label = "DKAgent AgentLoop";
  private readonly enabledTools: AgentEvalToolName[];

  public constructor(enabledTools: AgentEvalToolName[]) {
    this.enabledTools = [...enabledTools];
    // Promptfoo renders JavaScript configs recursively before loading them.
    // Own bound methods survive that traversal, so the ApiProvider contract is
    // retained when this instance is passed directly in `providers`.
    this.id = this.id.bind(this);
    this.callApi = this.callApi.bind(this);
  }

  public id(): string {
    return "dkagent-agent-loop";
  }

  public async callApi(
    prompt: string,
    context?: CallApiContextParams,
  ): Promise<ProviderResponse> {
    try {
      const caseId = context?.vars?.caseId;
      if (typeof caseId !== "string" || caseId.length === 0) {
        throw new Error("缺少字符串变量 caseId");
      }

      const captureFilesValue = context?.vars?.captureFiles;
      let captureFiles: string[] | undefined;
      if (captureFilesValue !== undefined) {
        if (!Array.isArray(captureFilesValue) || !captureFilesValue.every((value) => typeof value === "string")) {
          throw new Error("变量 captureFiles 必须是字符串数组");
        }
        captureFiles = [...captureFilesValue];
      }

      const config = loadConfig();
      const provider = new OpenAICompatibleProvider(config.apiKey, config.baseURL);
      return await runAgentEvalCase({
        caseId,
        prompt,
        enabledTools: this.enabledTools,
        ...(captureFiles === undefined ? {} : { captureFiles }),
        provider,
        model: config.model,
        maxContextTokens: config.maxContextTokens,
        maxOutputTokens: config.maxOutputTokens,
        secrets: [config.apiKey],
      });
    } catch (error: unknown) {
      return { error: safeProviderSetupMessage(error) };
    }
  }
}

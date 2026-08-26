import type {
  ApiProvider,
  CallApiContextParams,
  ProviderResponse,
} from "promptfoo";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
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
import type { AgentEvalRunMetadata } from "./assertions.js";

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
const MIN_REDACTABLE_SECRET_LENGTH = 4;
const STRUCTURAL_SECRET_TOKENS = [
  "agent.turn",
  "agent.step",
  "context.build",
  "context.snapshot.created",
  "context.tokens.counted",
  "context.threshold.checked",
  "context.compaction.planned",
  "context.summary.request",
  "context.summary.response",
  "context.compaction.completed",
  "model.request",
  "model.response",
  "tool.call",
  "tool.result",
  "memory.recall",
  "memory.extract",
  "memory.write",
  "skill.run",
  "skill.stage",
  "artifact.created",
  "artifact.resolved",
  "setup",
  "capture",
  "cleanup",
  "start",
  "event",
  "end",
  "error",
  "read_file",
  "find_files",
  "grep_files",
  "write_file",
  "sessionId",
  "module",
  "operation",
  "id",
  "traceId",
  "spanId",
  "parentSpanId",
  "sequence",
  "timestamp",
  "durationMs",
  "name",
  "phase",
  "step",
  "data",
  "input",
  "toolCallId",
  "result",
  "success",
  "content",
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStructuralSecret(secret: string): boolean {
  const normalized = secret.toLowerCase();
  return STRUCTURAL_SECRET_TOKENS.some((token) => {
    const structural = token.toLowerCase();
    return structural === normalized || structural.includes(normalized);
  });
}

function redactionSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets)]
    .filter((secret) => secret.trim().length > 0
      && secret.length >= MIN_REDACTABLE_SECRET_LENGTH
      && !isStructuralSecret(secret))
    .sort((left, right) => right.length - left.length);
}

function redactText(value: string, secrets: readonly string[]): string {
  return secrets
    .reduce((text, secret) => text.split(secret).join(REDACTED), value);
}

export function redactMetadata<T>(value: T, secrets: readonly string[]): T {
  const usableSecrets = redactionSecrets(secrets);
  return redactMetadataValue(value, usableSecrets) as T;
}

function redactMetadataValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactMetadataValue(item, secrets));
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[redactText(key, secrets)] = redactMetadataValue(item, secrets);
    }
    return redacted;
  }
  return value;
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
        await rm(runRoot, { recursive: true, force: true });
      } catch (error: unknown) {
        recordRunError("cleanup", error);
      }
    }
  }

  response.metadata = { evalRun: redactMetadata(evalRun, secrets) };
  return response;
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

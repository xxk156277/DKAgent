import type { UnifiedConfig } from "promptfoo";
import { config } from "../../packages/rag-v2/src/config.js";
import { readEvaluationQuestions } from "../../packages/rag-v2/src/evaluation/evaluate.js";
import { buildPromptfooTests } from "./cases.js";
import { RagPromptfooProvider } from "./provider.js";

const answerable = await readEvaluationQuestions(
  `${config.packageRoot}/eval/interview-questions.v1.jsonl`,
);
const refusals = await readEvaluationQuestions(
  `${config.packageRoot}/eval/refusal-questions.v1.jsonl`,
);

/** 所有模型评分统一使用当前 DeepSeek OpenAI-compatible 服务。 */
const grader = {
  id: `openai:chat:${config.generation.model}`,
  config: {
    apiBaseUrl: config.generation.baseUrl,
    apiKeyEnvar: "DEEPSEEK_API_KEY",
    temperature: 0,
  },
};

const promptfooConfig: UnifiedConfig = {
  description: "DKAgent RAG v2 语义质量评估",
  prompts: ["{{query}}"],
  // Promptfoo 的配置类型偏向声明式 Provider，运行时也支持 Provider 实例。
  providers: [new RagPromptfooProvider()] as unknown as NonNullable<UnifiedConfig["providers"]>,
  defaultTest: {
    options: { provider: grader },
  },
  evaluateOptions: {
    // 串行执行，保证基线结果不受并发限流影响。
    maxConcurrency: 1,
  },
  tests: buildPromptfooTests([...answerable, ...refusals]),
};

export default promptfooConfig;


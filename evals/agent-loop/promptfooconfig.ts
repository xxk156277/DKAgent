import type { UnifiedConfig } from "promptfoo";
import { gradeAgentRun } from "./assertions.js";
import { DkAgentEvalProvider } from "./provider.js";

const config: UnifiedConfig = {
  description: "DKAgent AgentLoop file Tool evaluation",
  prompts: ["{{input}}"],
  // Promptfoo's config declaration models provider references, while its runtime
  // accepts an ApiProvider instance here.
  providers: [new DkAgentEvalProvider(["read_file"])] as unknown as NonNullable<UnifiedConfig["providers"]>,
  tests: [{
    description: "M1 read_file reads a fixture and returns its marker",
    vars: {
      caseId: "read-file",
      input: "请读取 notes.txt，并告诉我其中的验证码。",
    },
    metadata: { milestone: "M1" },
    options: { runSerially: true },
    assert: [{
      type: "javascript",
      value: gradeAgentRun,
      config: {
        requiredTools: ["read_file"],
        outputIncludes: "DKAGENT_EVAL_7319",
      },
    }],
  }],
};

export default config;

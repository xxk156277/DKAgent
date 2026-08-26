import type { UnifiedConfig } from "promptfoo";
import { gradeAgentRun } from "./assertions.js";
import { DkAgentEvalProvider } from "./provider.js";

const config: UnifiedConfig = {
  description: "DKAgent AgentLoop file Tool evaluation",
  prompts: ["{{input}}"],
  // Promptfoo's config declaration models provider references, while its runtime
  // accepts an ApiProvider instance here.
  providers: [new DkAgentEvalProvider(["read_file", "find_files", "grep_files", "write_file"])] as unknown as NonNullable<UnifiedConfig["providers"]>,
  tests: [
    {
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
    },
    {
      description: "M2 no-tool answers directly",
      vars: {
        caseId: "no-tool",
        input: "请直接回复：READY。不要调用任何工具。",
      },
      metadata: { milestone: "M2" },
      options: { runSerially: true },
      assert: [{
        type: "javascript",
        value: gradeAgentRun,
        config: { requireNoTools: true, outputIncludes: "READY" },
      }],
    },
    {
      description: "M2 find_files lists TypeScript files",
      vars: {
        caseId: "find-files",
        input: "请查找 src 目录下的所有 TypeScript 文件，并列出结果。",
      },
      metadata: { milestone: "M2" },
      options: { runSerially: true },
      assert: [{
        type: "javascript",
        value: gradeAgentRun,
        config: {
          requiredTools: ["find_files"],
          forbiddenTools: ["write_file"],
          expectedFindFiles: ["src/a.ts", "src/b.ts"],
        },
      }],
    },
    {
      description: "M2 grep_files finds the marker",
      vars: {
        caseId: "grep-files",
        input: "请搜索哪些文件包含 DKAGENT_GREP_4821，并告诉我文件名。",
      },
      metadata: { milestone: "M2" },
      options: { runSerially: true },
      assert: [{
        type: "javascript",
        value: gradeAgentRun,
        config: {
          requiredTools: ["grep_files"],
          forbiddenTools: ["write_file"],
          expectedGrep: { path: "hit.txt", text: "DKAGENT_GREP_4821" },
        },
      }],
    },
    {
      description: "M3 reads source.txt and writes exact result.txt",
      vars: {
        caseId: "read-then-write",
        input: "请读取 source.txt 的完整内容，将内容原样写入新的 result.txt，不要修改 source.txt。",
        captureFiles: ["result.txt"],
      },
      metadata: { milestone: "M3" },
      options: { runSerially: true, disableVarExpansion: true },
      assert: [{
        type: "javascript",
        value: gradeAgentRun,
        config: {
          requiredTools: ["read_file", "write_file"],
          expectedSequence: ["read_file", "write_file"],
          expectedFinalFiles: {
            "result.txt": "DKAgent write evaluation payload\nline two remains unchanged\n",
          },
        },
      }],
    },
  ],
};

export default config;

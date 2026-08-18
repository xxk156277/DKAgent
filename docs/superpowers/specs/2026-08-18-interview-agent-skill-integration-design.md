# 面试分析 Agent 与 Skill 接入设计

## 1. 目标

把已经验证的面试分析原子能力接入 DKAgent，形成第一条可由自然语言触发的业务闭环：

1. Agent 引导用户定位并确认面试文字稿。
2. Agent 收集可选元数据和 JD。
3. Agent 调用唯一业务入口 `analyze_interview`。
4. `diagnose-transcript` Skill 固定编排面试分析步骤。
5. Agent 返回核心结论、暂定分、待确认问题和完整 Markdown 报告路径。

本阶段只生成 `provisional` 暂定报告，不实现用户补充后的局部重跑、最终报告、任务暂停恢复或 Memory 时间线。

## 2. 已确认决策

- 用户不必一开始提供完整路径，可以提供文件名、关键词和大致目录。
- Agent 使用现有 `find_files` 查找文件，得到候选路径后必须让用户确认。
- 采用“Agent 调用单一业务 Tool，Skill 内部固定编排原子能力”的接入方式。
- 聊天展示核心结论，完整报告写成 Markdown 文件并返回路径。
- 用户提供 JD 时生成岗位匹配分析，但岗位匹配不影响通用面试总分。
- 报告写在原稿同目录，文件名带时间戳，不覆盖原稿或已有报告。

## 3. 当前实现边界

当前分支已经实现并验证：

- 长文字稿解析和原文位置保留。
- 高置信转写纠错及表达痕迹保护。
- 问题、回答和问题簇结构化。
- 项目事实、表达和逐题分析。
- 簇内平均、问题簇等权评分。
- 暂定两层报告和确定性 Markdown 渲染。

当前 `packages/agent/src/skills/diagnose-transcript.ts` 使用旧 Tool 契约，并引用现有 `SkillContext` 不具备的 Session、Hooks 和 KnowledgeBase 字段，不能作为可运行实现复用。下一阶段用新契约替换它，不保留两套面试分析流程。

## 4. 架构

```text
用户
  ↓
AgentLoop
  ├─ find_files：根据用户给出的目录和关键词查找文件
  ├─ 对话确认：文字稿路径、元数据、可选 JD
  └─ analyze_interview：唯一面试分析业务入口
       ↓
diagnose-transcript Skill
  ├─ read_file
  ├─ parseTranscript
  ├─ preprocess_transcript
  ├─ structureInterview
  ├─ extract_project_facts
  ├─ analyze_expression
  ├─ query_knowledge_base（仅需要技术核验时）
  ├─ analyze_answer（逐题）
  ├─ generate_report(provisional，含可选 JD 岗位匹配)
  └─ write_file
       ↓
精简 Tool Result → Agent → 用户
```

不新增 Workflow Engine、关键词命令路由、多 Agent 或第二套模型调用层。

## 5. 组件职责

### 5.1 Agent

Agent 负责：

- 识别用户的面试分析意图。
- 引导用户提供文件名、关键词和大致目录。
- 调用 `find_files` 并展示候选文件。
- 等待用户确认文字稿和可选 JD 的实际路径。
- 收集公司、岗位、日期、轮次等可选元数据。
- 调用 `analyze_interview`。
- 展示精简结论、报告路径和待确认问题。

Agent 不负责：

- 决定逐题分析顺序。
- 直接调用内部分析原子 Tool。
- 计算或修改分数。
- 把暂定结果写入 Memory。

### 5.2 `analyze_interview` 业务 Tool

这是 Agent 能看到的唯一面试分析业务 Tool。它负责：

- 校验已确认的绝对文件路径和输入字段。
- 创建并运行 `diagnose-transcript` Skill。
- 把完整 Markdown 报告安全写入文件。
- 只向 Agent 返回精简结果。

它不暴露逐题循环、模型 Prompt 或中间大对象给 Agent。

### 5.3 `diagnose-transcript` Skill

Skill 是 TypeScript 业务编排器，负责固定 SOP、失败策略和完成条件。它直接持有内部原子 Tool 依赖；这些 Tool 不注册到 Agent 的公共 `ToolRegistry`。

Skill 不通过自由模型调用决定下一步。模型只在既有原子能力内部完成受 Schema 和证据规则约束的语义判断。

### 5.4 原子能力

继续复用现有实现：

- `read_file`、`write_file`
- `parseTranscript`
- `preprocess_transcript`
- `structureInterview`
- `extract_project_facts`
- `analyze_expression`
- `analyze_answer`
- `generate_report`

知识检索只用于知识题和需要事实核验的技术问题。项目题不以参考答案相似度评分。

`read_file` 默认只返回 500 行。Skill 必须根据 `totalLines` 分页读取直到文件末尾，再拼接完整原文；不得把默认 500 行误当成完整文字稿。JD文件使用同一读取规则。

## 6. 文件发现与确认

### 6.1 Agent 对话规则

1. 用户给出完整路径时，Agent展示该路径并要求确认。
2. 用户只给文件名或关键词且提供了大致目录时，Agent调用 `find_files`。
3. 用户没有提供搜索目录时，Agent先询问大致位置，不扫描整个用户目录。
4. 没有匹配时，Agent要求补充目录或关键词。
5. 唯一匹配时，Agent展示组合后的绝对路径并要求确认。
6. 多个匹配时，Agent最多展示五个候选项，让用户选择。
7. 未经确认不得调用 `analyze_interview`。

确认文字稿时，Agent在同一条消息中：

- 展示文字稿绝对路径。
- 展示从用户输入和文件名得到的元数据；未知字段标记为“未提供”，不猜测。
- 询问用户是否提供 JD；JD可以是粘贴文本或已确认文件路径。

### 6.2 未来上传兼容性

本阶段 `analyze_interview` 接收本地绝对路径。未来上传功能只需先把上传内容保存为受控临时文件，再向同一业务入口传入路径；Skill 和后续原子能力不需要改变。当前不为未来上传预建文件对象抽象。

## 7. 业务 Tool 契约

### 7.1 输入

```ts
interface AnalyzeInterviewInput {
    transcriptPath: string;
    metadata?: {
        company?: string;
        position?: string;
        date?: string;
        round?: string;
    };
    jdText?: string;
    jdPath?: string;
}
```

约束：

- `transcriptPath` 必须是已确认的绝对路径。
- `jdText` 和 `jdPath` 最多提供一个。
- `jdPath` 必须是已确认的绝对路径。
- 元数据允许缺失；缺失字段保持未知。
- Tool 不根据文件内容补造元数据。

### 7.2 输出

```ts
interface AnalyzeInterviewOutput {
    reportPath: string;
    levelSummary: string;
    totalScore: number;
    analyzedCount: number;
    questionCount: number;
    pendingClarifications: ClarificationCandidate[];
    jobMatchSummary: string | null;
}
```

完整 `InterviewReport` 和完整问题列表不进入 Tool Result。它们只存在于 Skill 内部并写入 Markdown 文件，避免长报告再次占用 Agent Context。

报告结构增加已确认元数据和可选岗位匹配：

```ts
interface InterviewMetadata {
    company: string | null;
    position: string | null;
    date: string | null;
    round: string | null;
}

interface InterviewReport {
    // 保留现有字段
    metadata: InterviewMetadata;
    jobMatchStatus: "not_provided" | "completed" | "failed";
    jobMatch: JobMatchAnalysis | null;
}
```

缺失元数据渲染为“未提供”，不参与任何评分。
没有 JD 时不展示岗位匹配章节；JD 分析失败时展示“岗位匹配：不可评价”，不能与“未提供 JD”混为一谈。

## 8. Skill 执行流程

1. 使用 `read_file` 分页读取完整文字稿；提供 `jdPath` 时用相同方式读取完整 JD。
2. 使用 `parseTranscript` 解析角色轮次和原文位置。
3. 调用 `preprocess_transcript`，只应用高置信转写纠错并保留口头语、重复、停顿和卡壳。
4. 调用 `structureInterview`，形成全部具体问题、回答和问题簇。
5. 按项目问题簇调用 `extract_project_facts`。
6. 按具体问题调用 `analyze_expression`。
7. 需要技术核验时检索知识库；检索失败按无参考资料继续并降低置信度。
8. 按原文顺序调用 `analyze_answer`；流程题保留但不评分。
9. 单题失败时保存 `failed` 结果并继续，不丢弃其他问题。
10. 调用 `generate_report` 生成 `provisional` 报告。
11. 提供 JD 时生成岗位匹配内容。
12. 使用 `write_file` 写入完整 Markdown。
13. 写入成功后返回精简结果。

Skill 顺序执行，不增加并行模型调用。AbortSignal 必须传递给每个内部步骤。

知识检索通过可选的 `InterviewReferenceRetriever` 端口注入。运行时仅在显式配置 `KNOWLEDGE_DATABASE_PATH` 且数据库存在时创建 FTS 检索适配器；未配置、数据库不存在或单次检索失败时返回空参考资料，由既有知识题置信度上限处理。运行时不得为了查询自动创建一个空知识库并声称检索成功。

## 9. JD 岗位匹配

岗位匹配作为 `InterviewReport` 的可选字段，由报告阶段生成：

```ts
interface JobMatchAnalysis {
    summary: string;
    matches: Array<{
        text: string;
        jdEvidenceQuote: string;
        questionIds: string[];
    }>;
    gaps: Array<{
        text: string;
        jdEvidenceQuote: string;
        questionIds: string[];
    }>;
}
```

规则：

- `jdEvidenceQuote` 必须是 JD 原文子串。
- `questionIds` 必须引用已存在的问题。
- 没有面试证据时不得声称候选人满足或不满足某项要求。
- JD 分析失败时，通用报告仍可成功；岗位匹配标记为“不可评价”。
- 岗位匹配不生成数值分数，不修改通用总分或五维分数。

## 10. 报告文件

报告默认写入文字稿所在目录：

```text
<原文件名>-面试分析-<YYYYMMDD-HHmmss>.md
```

规则：

- 不修改或覆盖原始文字稿。
- 时间戳按本地时间生成。
- `write_file` 增加可选的 `overwrite` 参数，默认值保持 `true` 以兼容现有调用；报告写入必须传 `overwrite: false`，底层使用排他创建。
- 若发生同秒文件名冲突，Skill追加递增序号并重试，绝不先覆盖再判断。
- 只有 `write_file` 成功后，业务 Tool 才返回成功和 `reportPath`。
- Markdown包含暂定总览、可选岗位匹配、待确认问题和完整逐题列表。

## 11. 错误与降级

| 场景 | 行为 |
|---|---|
| 文字稿路径不存在、不是文件或不可读 | 整体失败，不启动分析 |
| 角色无法识别、没有问题或证据映射非法 | 整体失败，不生成报告 |
| 单题表达或回答分析失败 | 该题标记失败，继续其他问题 |
| 知识库失败 | 按无参考资料继续并降低置信度 |
| JD读取失败 | 整体输入失败，要求用户修正JD路径 |
| JD岗位匹配模型失败或证据非法 | 通用报告成功，岗位匹配标记不可评价 |
| 没有任何可评分问题 | 报告生成失败 |
| 报告写入失败 | 整体返回失败，不声称完成 |
| 用户中止 | 停止后续步骤，不写入完成报告 |

本阶段没有持久化检查点。进程退出或整体失败后重新运行完整分析，这是范围 A 的明确限制。

## 12. Prompt 与公共 Tool

公共 `ToolRegistry` 保留基础文件 Tool，并新增 `analyze_interview`。内部面试分析 Tool 不注册给 Agent。

System Prompt 必须约束：

- 普通聊天直接回答。
- 面试分析可以先通过目录和关键词查找文件，不强制用户在同一消息提供完整路径。
- 缺少搜索目录时先询问，不扫描整个用户目录。
- Agent必须展示并等待用户确认实际路径。
- 未确认路径时不得调用 `analyze_interview`。
- 不得猜测、编造或替用户选择路径。

现有“同一条消息必须提供完整文件路径”的 Prompt 测试已经与本设计冲突，应被新行为契约替换，而不是继续保留为基线失败。

## 13. 测试

### 13.1 Agent 行为测试

- 普通聊天不调用 Tool。
- 只有文件名但没有目录时先询问目录。
- 有目录和关键词时调用 `find_files`。
- 唯一或多个匹配后先让用户确认，不立即分析。
- 用户确认路径并处理JD选择后调用 `analyze_interview`。
- Agent最终只展示精简结果，不回显完整 Tool 内部对象。

### 13.2 Skill 集成测试

使用临时文字稿、FakeProvider 和真实临时输出目录验证：

- 内部步骤按固定顺序调用。
- 所有问题和原回答进入最终 Markdown。
- 单题失败不阻断其他问题。
- 知识库失败正确降级。
- JD证据合法时出现岗位匹配，非法时只降级岗位匹配。
- 输出文件不覆盖已有文件。
- 超过500行的文字稿会被完整读取，最后一题仍进入报告。
- Tool Result不包含完整问题列表和完整 Markdown。
- 不写入 Session 诊断状态或 Memory。

### 13.3 回归验收

- 面试域测试全部通过。
- Phase1 Prompt 测试替换为新路径发现契约并全部通过。
- Agent包全量测试全部通过。
- 面试专用和 Agent全量 TypeScript 类型检查通过。
- `git diff --check` 无输出。

## 14. 完成标准

用户可以在 DKAgent 中用自然语言完成：

```text
提出面试分析
→ 提供目录/关键词
→ 选择并确认文字稿
→ 确认元数据和可选JD
→ Agent调用一个业务Tool
→ Skill跑完整暂定分析
→ 聊天得到核心结论
→ 本地得到完整Markdown报告
```

完成后仍明确不包含：

- 用户事实确认后的局部重跑。
- `final` 最终报告。
- 诊断任务的 Session 暂停恢复。
- 面试表现 Memory 时间线。
- 文件上传接口。

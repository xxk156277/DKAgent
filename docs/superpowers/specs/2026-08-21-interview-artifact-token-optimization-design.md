# 面试分析 Artifact Token 优化设计

## 目标

减少 `diagnose-transcript` 最小链路中，大段原文和结构化 JSON 经由 Agent Tool Call/Result 反复进入模型上下文造成的 Token 消耗。

最小链路保持为：

```text
read_file -> parse_transcript -> structure_interview -> analyze_answer -> generate_report
```

Tool 之间改为传递 Artifact 引用和必要摘要，完整数据保留在当前 Session 的程序内存中。

## 非目标

- 不实现长文档分窗或跨窗合并。
- 不引入向量库、知识库或检索。
- 不持久化 Artifact，进程重启后引用失效。
- 不支持跨 Session 共享 Artifact。
- 不增加 TTL、容量淘汰或复杂任务调度。
- 不改变最终报告必须对用户可见的要求。

## 方案选择

### 采用：Session 级内存 Artifact Store

完整文件、解析稿、结构化面试和逐题分析保存在 `InMemoryArtifactStore`。Tool Result 只向 Agent 返回 Artifact ID、数量、状态和分数等小字段。

该方案直接减少 Agent 后续 Step 重复携带大 JSON 的输入 Token。

### 不采用：仅在 structure_interview 内部分窗

分窗解决单次模型请求过长，但会重复系统 Prompt，并可能因为窗口重叠增加总输入 Token。它与 Artifact 方案正交，后续可独立加入。

### 不采用：压缩 JSON 字段名

缩短字段名只能减少少量结构 Token，无法消除原文和分析对象在 Agent 历史中的重复传递，并会降低可读性。

## 数据流

```text
read_file(storeAsArtifact=true)
  -> { artifactId, path, characterCount, lineCount }

parse_transcript({ sourceArtifactId })
  -> { artifactId, turnCount }

structure_interview({ transcriptArtifactId })
  -> { artifactId, clusterCount, questionIds }

analyze_answer({ structuredInterviewArtifactId, questionId })
  -> { artifactId, questionId, status, score }

generate_report({ structuredInterviewArtifactId, analysisArtifactIds, stage })
  -> { report, markdown }
```

最终报告是用户需要消费的产物，因此 `generate_report` 仍返回完整报告与 Markdown。中间 Artifact 不返回完整正文。

## Artifact Store

### 类型

```ts
type ArtifactKind =
    | "file_text"
    | "parsed_transcript"
    | "structured_interview"
    | "question_analysis";

interface ArtifactRecord<T> {
    id: string;
    kind: ArtifactKind;
    value: T;
    createdAt: string;
    metadata: {
        characterCount?: number;
        itemCount?: number;
        producer: string;
    };
}
```

### 最小接口

```ts
interface ArtifactStore {
    put<T>(kind: ArtifactKind, value: T, metadata: ArtifactMetadata): string;
    get<T>(id: string, expectedKind: ArtifactKind): T;
}
```

- ID 使用不可预测的 UUID。
- `get` 同时校验存在性和 Artifact 类型。
- 不提供列举全部 Artifact 的 Tool 能力。
- Store 随当前 Session 创建和释放，避免 Session 间数据串用。

## Tool 契约

### read_file

保留现有默认行为。读取 Skill、小型配置或普通文件时仍返回正文。

新增可选参数 `storeAsArtifact: true`：

- 文件正文写入 `file_text` Artifact。
- Tool Result 不包含 `content`。
- 返回 `artifactId`、路径、字符数和行数。

### parse_transcript

面试 Tool 只接受 `sourceArtifactId`，读取 `file_text` 后解析并写入 `parsed_transcript`。领域函数 `parseTranscript(source)` 保持不变，供 Tool 内部和领域测试使用；不再保留由 Agent 向 Tool 直接传递完整字符串的入口。

### structure_interview

通过 `transcriptArtifactId` 读取解析稿。内部 LLM 行为与现有版本一致，输出写入 `structured_interview`。

Tool Result 只返回 Artifact ID、问题簇数量和问题 ID，不返回完整问题及回答正文。

### analyze_answer

输入 `structuredInterviewArtifactId + questionId`。Tool 在 Store 中定位当前问题、问题簇和簇内问题，继续在内部计算 `ExpressionStats` 并调用一次 LLM。

完整 `QuestionAnalysis` 写入 `question_analysis`。Tool Result 只返回 Artifact ID、状态、题目 ID 和程序分数。

### generate_report

输入结构化面试 Artifact ID 和逐题分析 Artifact ID 列表。Tool 读取完整对象、执行一致性校验、程序算分和报告摘要。

最终返回完整报告与 Markdown，不要求 Agent 再复制中间 JSON。

## 生命周期与错误处理

- Artifact 仅在当前 Session 和进程内有效。
- `/new` 创建新 Session 时使用新的空 Store。
- DKAgent 重启后，历史消息中的 Artifact ID 不再可解析。
- 引用不存在或已失效：返回 `input_error`，明确说明 Artifact 不存在或已过期。
- Artifact 类型不匹配：返回 `input_error`，不尝试类型转换。
- 不因 Artifact 读取失败回退为让 Agent 重传完整 JSON。
- AbortSignal 和现有 LLM 失败边界保持不变。

## Trace

新增事件：

```text
artifact.created
artifact.resolved
```

Trace 模块新增 `artifact`。事件只记录元数据：

```ts
interface ArtifactTraceData {
    artifactId: string;
    artifactType: ArtifactKind;
    producer?: string;
    consumer?: string;
    characterCount?: number;
    itemCount?: number;
    exposedCharacterCount?: number;
    omittedCharacterCount?: number;
    hit?: boolean;
}
```

约束：

- 不记录 Artifact `value`、面试原文或完整分析 JSON。
- `artifact.created` 体现存储规模和向 Agent 暴露的摘要规模。
- `artifact.resolved` 体现消费者和是否命中。
- Web Tap 只增加事件和模块的中文名称映射，不新增专用页面。
- 原有 `model.response.usage.inputTokens` 继续作为实际 Token 使用证据。

## 测试与成功标准

### 单元测试

- Store 能按 ID 和期望类型读写 Artifact。
- Store 拒绝未知 ID 和错误类型。
- Artifact ID 不可通过 Tool 枚举。
- `read_file` 默认模式仍返回正文。
- `read_file(storeAsArtifact=true)` 不返回正文。
- 四个面试 Tool 能通过 Artifact 引用串联。
- `analyze_answer` 仍只调用一次分析 LLM，并由程序计算表达统计和分数。
- Trace 产生创建和读取事件，事件序列化结果不包含原文。

### 集成验证

使用 `test.md` 运行完整 Skill：

- 所有最小链路 Tool 成功。
- 逐题覆盖率等于识别出的评分题数量。
- `generate_report` 成功返回 Markdown。
- Agent 历史中的中间 Tool Result 不包含完整文稿、完整结构化面试或完整逐题分析。
- Trace 能关联每个 Artifact 的生产者与消费者。

## 后续扩展

当单次 `structure_interview` 的输入接近模型安全上下文上限时，再独立加入：

```text
长度门控 -> 按完整轮次分窗 -> 分窗结构化 -> 程序合并
```

该扩展只改变 Artifact 内部处理方式，不需要重新把大 JSON 暴露给 Agent。

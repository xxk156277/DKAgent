## 1. LLM 擅长 JSON 吗？

结论：**LLM 能较好理解和生成 JSON，但不应信任“纯 Prompt 生成 JSON”；也不需要刻意避免 JSON。**

### 读取 JSON：擅长语义，不擅长大规模精确计算

LLM 能理解字段关系、分类和枚举，但面对超长数组、深层嵌套、精确计数时容易遗漏。
大 JSON 应先由程序过滤，只传必要字段。

### 生成 JSON：格式正确不等于内容正确

要区分两种正确性：

```
语法正确：括号、引号、字段类型符合 Schema
语义正确：事实、证据、字段关系真的合理
```

Structured Outputs 可以约束模型遵守 JSON Schema，但不能保证内容事实正确。OpenAI 也推荐在支持时使用 `json_schema`，而不是旧的 JSON Mode；Anthropic 的 Tool Use 同样通过 `input_schema` 描述参数。[OpenAI API](https://platform.openai.com/docs/api-reference/responses-streaming/response/refusal/delta?lang=curl)、[Anthropic Tool Use](https://docs.anthropic.com/ko/docs/agents-and-tools/tool-use/implement-tool-use)

### 不要避免 JSON，要避免“无约束 JSON”

成熟 Agent 的选择通常是：

```
给人阅读              → 普通文本
程序需要读取结果       → Structured Outputs
模型需要调用能力       → Tool Call + JSON Schema
只靠 Prompt 要求 JSON  → 尽量避免
```

因此，更准确的原则是：

> JSON 适合作为模型与程序之间的协议，不适合作为所有模型回答的默认格式。

如果结果只展示给用户，就输出自然语言；如果下一步需要程序校验、路由、存储或执行，就应输出受 Schema 约束的结构化数据。

下一次可以专门回答第 2 个问题：哪些 Agent 场景确实需要模型输出 JSON。


## 2. 什么场景需要模型输出 JSON？

结论：**当模型结果需要被程序继续消费，而不是直接给人阅读时，才需要结构化输出。**

### 典型场景

1. **调用 Tool**

模型需要把自然语言转成可执行参数：

```
interface SearchFilesInput {
  /** 搜索目录的绝对路径。 */
  directory: string;

  /** 文件名或内容关键词。 */
  keyword: string;

  /** 最大返回数量。 */
  limit: number;
}
```

程序必须准确读取参数，所以适合 Tool Calling，而不是自由文本。

2. **信息抽取与分类**

例如从面试原文识别：

- 问题类型：`project | knowledge | open`
- 原文证据ID
- 是否需要追问
- 置信度

这些结果会进入后续 Workflow，因此需要固定 Schema。

3. **路由和状态决策**

```
模型判断意图
→ { intent: "analyze_interview", confidence: 0.91 }
→ 程序决定调用哪个Skill
```

注意：模型只负责语义判断，程序负责真正执行状态切换。

4. **多步骤任务的中间结果**

```
项目事实提取
→ ProjectFactSet
→ 逐题分析
→ QuestionAnalysis
→ 报告汇总
```

每一步由不同模块消费时，JSON可以形成稳定的数据契约，避免依赖自然语言解析。

5. **批量评估和自动化测试**

例如模型输出标签、分数、证据和失败原因，程序需要批量统计、比较或生成报表。

### 不应该让模型输出 JSON 的场景

- 最终内容主要给人阅读，例如总结、文章、解释。
- 加减乘除、排序、去重等确定性计算。
- 简单文本切分、字段映射和格式转换。
- 可以直接由程序从已有数据得到的结果。
- 要求模型精确处理超大、深层嵌套 JSON。

判断标准可以简化为：

```
下游是人 → 优先自然语言
下游是程序 → 优先结构化输出
结果是确定性计算 → 直接写程序
结果需要语义理解 → 模型 + Schema
```

JSON的价值不是“看起来专业”，而是让模型的语义判断能够安全进入程序流程。


## 3. JSON 不合规有哪些情况，怎么处理？

结论：不要把所有错误都当成“JSON解析失败”。成熟 Agent 会分层处理：**生成状态 → JSON语法 → Schema → 业务规则 → 证据真实性**。

|错误类型|例子|处理方式|
|---|---|---|
|输出被截断|缺少末尾括号，`finish_reason=length`|不修补；增加输出预算、缩小输入或分段后重试|
|JSON语法错误|多余说明、代码块、引号未转义|优先使用Structured Outputs；否则清理代码块并有限重试|
|Schema不匹配|缺字段、类型错误、额外字段、非法枚举|Zod校验；把具体错误反馈给模型，要求重新生成|
|业务规则错误|分数超范围、问题ID不存在、状态相互冲突|程序校验；针对错误字段重试，不能靠Schema完全解决|
|证据或事实错误|evidenceId存在，但证据不支持结论|回到原文验证；删除无证据结论、降低置信度或标记未知|
|拒绝或空输出|安全拒绝、内容过滤、空字符串|单独识别为拒绝/服务失败，不能作为普通JSON重试|

### 推荐处理顺序

```
1. 检查 stopReason / finishReason
2. JSON.parse
3. Zod / JSON Schema校验
4. 业务关系校验
5. 原文证据校验
6. 确认通过后才执行或保存
```

### 重试策略

建议最多自动重试1～2次：

```
第一次失败
→ 带上精简的校验错误重新生成

第二次失败
→ 降级、跳过当前节点或请求人工确认
```

不要无限重试，也不要把整个错误对象和完整原文再次传给模型。

### 不建议的处理

- 用正则盲目补括号、引号。
- 自动把 `"80"` 转成数字 `80`，掩盖模型错误。
- Schema通过后直接信任内容。
- JSON不合规却继续执行Tool。
- 截断输出仍尝试局部解析并写入数据库。

DeepSeek官方也明确提示：达到 `max_tokens` 时JSON可能被截断，普通Tool参数也可能生成无效JSON，因此应用侧仍需校验。[DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/)

最终原则：

> 格式错误可以重试，业务错误必须校验，证据错误必须拒绝；任何不确定结果都不能直接执行。
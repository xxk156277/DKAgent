# 上下文工程 - GSSC

Gather：收集
Select：筛选
Structure：组织
Compress：压缩

## Gather

从哪里收集：
系统提示词、当前用户画像、长期记忆、工具列表、RAG外部知识

下一阶段进入“上下文工程”。先把核心概念定死：

> 上下文不是 `messages[]`。  
> 上下文是每次调用模型前，Harness 为模型组装出的完整输入快照。

## 一、它在 DKAgent 中的位置

当前调用链：

```mermaid
flowchart LR
    U["用户输入"] --> Loop["AgentLoop.run()"]
    Loop --> Messages["messages.push(user)"]
    Messages --> Query["QueryEngine.query()"]
    Query --> LLM["LLM"]
    LLM --> Tool["Tool Call"]
    Tool --> Messages
```

当前代码实际是：

```typescript
queryEngine.query({
    systemPrompt,
    messages: [...this.messages],
    tools,
});
```

也就是：

```text
模型上下文 = System Prompt + 全部历史消息 + Tool Schema
```

以后目标是：

```mermaid
flowchart LR
    Loop["AgentLoop"] --> CM["ContextManager.build()"]

    System["系统规则"] --> CM
    History["历史对话"] --> CM
    Current["当前用户任务"] --> CM
    ToolResult["Tool 结果"] --> CM
    RAG["RAG 检索结果"] --> CM
    Memory["长期记忆（以后）"] -.-> CM

    CM --> Snapshot["ContextSnapshot"]
    Snapshot --> Query["QueryEngine"]
    Query --> LLM["LLM"]
```

换句话说，AgentLoop 不再自己随便把所有消息扔给模型，而是：

```typescript
const context = await contextManager.build({
    messages,
    systemPrompt,
    tools,
    currentInput,
});

await queryEngine.query(context);
```

---

## 二、Context、Messages、RAG、Memory 的区别

```mermaid
flowchart TB
    Context["Context<br/>本次模型真正看到的内容"]

    System["System Prompt<br/>身份、规则、权限"]
    Messages["Messages<br/>当前会话历史"]
    RAG["RAG<br/>外部面试知识"]
    Tool["Tool Result<br/>本轮执行证据"]
    Memory["Memory<br/>跨会话用户经验"]

    System --> Context
    Messages --> Context
    RAG --> Context
    Tool --> Context
    Memory -. "以后实现" .-> Context
```

### Messages

```typescript
[
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好，我是 DKAgent" },
];
```

它只是上下文的一个来源。

### RAG

```typescript
[
    {
        question: "闭包是什么？",
        expertAnswer: "闭包是函数与词法环境的组合。",
        sourceFile: "javascript/closure.md",
    },
];
```

它是外部知识，不应该永久塞进聊天历史。

### Memory

例如：

```text
用户是前端工程师
用户偏好简洁回答
用户最近在准备 Agent 面试
```

它通常跨会话保存。第一阶段暂时不做。

### Context

最终发给模型的请求：

```typescript
{
  systemPrompt: "你是 DKAgent……",

  messages: [
    // 筛选后的历史消息
    { role: "user", content: "帮我分析闭包回答" },

    // 本轮临时注入的 RAG 证据
    {
      role: "user",
      content: `
        以下是知识库证据：
        闭包是函数与词法环境的组合。
        来源：javascript/closure.md
      `,
    },
  ],

  tools: [...],
}
```

---

## 三、为什么当前 `messages[]` 不够

目前 AgentLoop 会不断追加消息：

```text
第 1 轮：2 条
第 10 轮：20 条
第 50 轮：100 条
```

最终会出现四个问题。

```mermaid
flowchart TD
    All["把全部 messages 发送给模型"]

    All --> Token["Token 越来越多"]
    All --> Cost["请求越来越贵"]
    All --> Noise["旧对话干扰当前任务"]
    All --> Overflow["超过模型上下文长度"]
    All --> ToolNoise["超长 Tool Result 占满上下文"]
```

尤其是面试记录 Tool，结果可能非常长：

```typescript
{
  role: "tool",
  content: JSON.stringify(几万字面试记录),
}
```

如果一直保留，后面每轮都会重新发送这几万字。

所以需要一个独立模块决定：

```text
哪些必须保留？
哪些可以删？
哪些可以压缩？
哪些只在当前 Run 临时存在？
```

---

## 四、上下文工程的四个阶段：GSSC

```mermaid
flowchart LR
    G["Gather<br/>收集"] --> S1["Select<br/>筛选"]
    S1 --> S2["Structure<br/>组织"]
    S2 --> C["Compress<br/>压缩"]
    C --> Snapshot["ContextSnapshot"]
```

## 1. Gather：从哪里收集

```typescript
const packets = [systemPromptPacket, currentUserPacket, ...historyPackets, ...toolResultPackets, ...ragPackets];
```

统一成一种中间类型：

```typescript
interface ContextPacket {
    id: string;

    // system、message、tool、rag
    kind: ContextKind;

    // 最终准备交给模型的内容
    content: string;

    // 越大越不能删除
    priority: number;

    // 估算占用多少 Token
    estimatedTokens: number;

    // 是否必须保留
    required: boolean;
}
```

---

## 2. Select：选择哪些内容

第一阶段不需要复杂算法，先用确定性规则。

```mermaid
flowchart TD
    Packets["ContextPacket[]"] --> Required["保留 required 内容"]
    Required --> Current["保留当前用户消息"]
    Current --> ToolPair["保留完整 Tool Call / Tool Result 对"]
    ToolPair --> Recent["从新到旧加入历史消息"]
    Recent --> Budget{"超过 Token 预算？"}
    Budget -- "没有" --> Add["继续加入"]
    Budget -- "超过" --> Stop["停止加入旧消息"]
```

伪代码：

```typescript
function selectPackets(packets: ContextPacket[], tokenBudget: number): ContextPacket[] {
    const selected = [];
    let usedTokens = 0;

    // System Prompt、当前用户任务一定保留
    for (const packet of packets.filter((item) => item.required)) {
        selected.push(packet);
        usedTokens += packet.estimatedTokens;
    }

    // 其他内容按优先级和时间选择
    const candidates = packets.filter((item) => !item.required).sort(comparePriorityAndRecency);

    for (const packet of candidates) {
        if (usedTokens + packet.estimatedTokens > tokenBudget) {
            continue;
        }

        selected.push(packet);
        usedTokens += packet.estimatedTokens;
    }

    return selected;
}
```

---

## 3. Structure：组织成模型输入

ContextManager 内部使用 `ContextPacket[]`，但 QueryEngine 仍然只认识：

```typescript
{
  systemPrompt,
  messages,
  tools,
}
```

因此需要转换：

```mermaid
flowchart LR
    Packets["ContextPacket[]"] --> System["System Prompt"]
    Packets --> History["历史 Messages"]
    Packets --> Evidence["RAG / Tool Evidence"]
    System --> Request["QueryEngine Request"]
    History --> Request
    Evidence --> Request
```

伪代码：

```typescript
function structureContext(packets: ContextPacket[]): ContextSnapshot {
    return {
        systemPrompt: buildSystemPrompt(packets),

        messages: packets.filter(canConvertToMessage).map(convertToAgentMessage),

        estimatedTokens: sumTokens(packets),
    };
}
```

---

## 4. Compress：超出预算怎么办

压缩顺序必须明确。

```mermaid
flowchart TD
    Overflow["超过 Token 预算"] --> Tool["先裁剪超长 Tool Result"]
    Tool --> Old["再删除较旧普通对话"]
    Old --> RAG["减少低排名 RAG 结果"]
    RAG --> Summary["以后：总结历史对话"]

    Keep["始终优先保留"]
    Keep --> System["System Prompt"]
    Keep --> Current["当前任务"]
    Keep --> ToolChain["当前 Tool 调用链"]
    Keep --> Output["输出约束"]
```

第一阶段不要调用模型做摘要，因为那会引入：

- 额外模型调用
- 摘要失真
- 成本和失败重试
- 更复杂的状态管理

先做确定性压缩：

```typescript
function compressPackets(packets, budget) {
    return packets
        .map(truncateLongToolResults)
        .filter(removeOldLowPriorityMessages)
        .filter(removeLowRankedRagEvidence)
        .sliceUntilTokenBudget(budget);
}
```

---

## 五、DKAgent 第一阶段应该做到什么

不要一次做完整 GSSC 平台。第一阶段只实现：

```text
ContextManager
├── 收集 System Prompt
├── 收集 messages
├── 估算 Token
├── 保留当前消息
├── 保留完整 Tool Call / Tool Result
├── 从旧到新裁剪普通历史
└── 生成 ContextSnapshot
```

暂时不做：

```text
× 长期 Memory
× 模型摘要
× 向量化历史对话
× 多 Agent 上下文共享
× 复杂相关度打分
× 自动把 RAG 注入每一次对话
```

---

## 六、建议模块结构

```text
src/context/
├── types.ts
├── token-counter.ts
├── message-grouper.ts
├── selector.ts
├── context-manager.ts
└── index.ts
```

```mermaid
flowchart LR
    Types["types.ts<br/>上下文领域类型"]

    Counter["token-counter.ts<br/>Token 估算"]
    Grouper["message-grouper.ts<br/>保护 Tool 消息组"]
    Selector["selector.ts<br/>预算内筛选"]
    Manager["context-manager.ts<br/>编排"]
    Index["index.ts<br/>统一导出"]

    Types --> Counter
    Types --> Grouper
    Counter --> Selector
    Grouper --> Selector
    Selector --> Manager
    Manager --> Index
```

核心接口：

```typescript
interface ContextBuildInput {
    systemPrompt?: string;
    messages: readonly AgentMessage[];
    tools: readonly ToolSchema[];
    maxInputTokens: number;
    reservedOutputTokens: number;
}

interface ContextSnapshot {
    systemPrompt?: string;
    messages: AgentMessage[];
    tools: ToolSchema[];

    estimatedInputTokens: number;
    droppedMessageCount: number;
}

interface ContextManager {
    build(input: ContextBuildInput): Promise<ContextSnapshot>;
}
```

---

## 七、改造后的 AgentLoop

现在：

```typescript
const response = await queryEngine.query({
    model,
    messages: [...this.messages],
    tools,
    systemPrompt,
});
```

目标：

```typescript
const snapshot = await contextManager.build({
    systemPrompt,
    messages: this.messages,
    tools: toolRegistry.getSchemas(),

    // 模型最大上下文预算
    maxInputTokens: 16_000,

    // 给模型输出预留空间
    reservedOutputTokens: 2_000,
});

const response = await queryEngine.query({
    model,
    systemPrompt: snapshot.systemPrompt,
    messages: snapshot.messages,
    tools: snapshot.tools,
});
```

注意：

```text
AgentLoop.messages = 完整会话状态
ContextSnapshot.messages = 本次模型请求的裁剪快照
```

不能为了减少 Token，直接删除 `AgentLoop.messages`。

```mermaid
flowchart LR
    Full["完整 messages<br/>Agent 状态"] --> Builder["ContextManager"]
    Builder --> Snapshot1["第 N 轮请求快照"]
    Full --> Builder2["ContextManager"]
    Builder2 --> Snapshot2["第 N+1 轮请求快照"]

    Snapshot1 -. "不会反向修改" .-> Full
    Snapshot2 -. "不会反向修改" .-> Full
```

这就是上下文模块第一阶段最重要的边界。

# 问题

### 如何理解每轮计算前，都需要「模型最大TOKEN-本轮预留TOKEN」

假设：
模型最大TOKEN = 10_000;
本轮预留TOKEN = 2_000;
那么：
可用TOKEN = 10_000 - 2_000;

整体容量分配：

```text
模型最大上下文：10000 Token
├── 本次输入最多：8000 Token
│   ├── System Prompt
│   ├── 历史摘要
│   ├── 对话消息
│   └── Tool Schema
└── 本轮输出预留：2000 Token
```

### 为什么必须预留输出

假如不减：
输入已经占用 10000 Token
模型最大容量 10000 Token
模型就没有空间生成回答，可能出现：
1.上下文超限。
2.输出被严重截断。
3.Provider 直接拒绝请求。
4.Tool Call 参数生成到一半停止。

### 不同Token阈值之间的关系和结构

```text
主体结构：
maxContextTokens                         模型总容量，硬上限
│
├── reservedOutputTokens                 输出预留
│   └── 当前等于 maxOutputTokens
│
└── availableInputTokens                 输入硬上限
    │
    ├── triggerTokens                    80% 压缩触发线
    │   └── availableInputTokens × triggerRatio
    │
    └── targetTokens                     60% 压缩目标线
        └── availableInputTokens × targetRatio
            │
            ├── fixedTokens              System + Tool Schema
            ├── maxSummaryTokens         摘要最大预算
            └── rawMessageBudget         最近原始消息预算

旁路结构：
maxToolResultChars
└── Tool Result 进入摘要前的字符上限

Compressor maxTokens
└── 某段文本或某次摘要的局部 Token 上限

0.9
└── 文本截断算法内部的 10% 误差缓冲
```

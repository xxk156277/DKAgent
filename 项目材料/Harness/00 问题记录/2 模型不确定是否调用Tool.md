
> 缺少Harness 工具授权层 - Agent 系统的**安全边界设计**:
> 
> "谁来决定工具能不能被调用"
> **把"该不该调这个工具"完全托付给模型判断**
> 

### 核心问题

Agent 拿到 LLM 的 tool call 后，**执行之前**，谁来把关？

| 把关方式       | 谁做判断         | 特点                       |
| ---------- | ------------ | ------------------------ |
| **无授权层**   | 只有 LLM       | 模型凭 prompt 自觉判断，不可靠      |
| **确定性授权层** | Harness 代码规则 | 每条 tool call 都过一道硬检查，可预测 |

### Schema 缺了什么

你列的 Schema 只有：

```
name / description / parameters   ← 告诉模型"这个工具能干嘛"
```

缺的是"约束模型何时该用、用了要不要人批准"的字段：

```
risk              → 这个工具危险等级（读文件=低，删库=高）
requiresApproval  → 调用前是否需要人工确认
whenToUse         → 明确的使用时机规则
```

### 两个典型后果

**1. 重复确认**

模型不确定该不该动手，于是反复问你：

```
"我检测到需要调用 delete_file，是否继续？"
→ 你回答继续
→ 它又犹豫，再次确认
```

因为判断标准是模糊的自然语言，模型每次都"重新思考"，没有稳定的规则可依。

**2. 行为漂移**

同一类操作，这次直接执行，下次却停下来问你；或者换一个会话、换一个模型，行为就变了。因为规则存在 prompt 里，而 prompt 的解读有随机性。

### 确定性授权层长什么样

在 Harness 代码里，每条工具调用执行前，先过一道**不依赖 LLM 的判断**：

```typescript
interface ToolSchema {
  name: string;
  description: string;
  parameters: Schema;
  
  // ↓ 确定性授权字段
  risk: "low" | "medium" | "high";
  requiresApproval: boolean;
  whenToUse: string[];
}

function authorize(toolCall, tool): AuthorizationResult {
  // 规则是写死的，不靠 LLM
  if (tool.risk === "high" && !tool.requiresApproval) {
    return { block: true, reason: "高危工具必须人工批准" };
  }
  if (tool.risk === "high" && !isApproved(toolCall)) {
    return { needApproval: true };
  }
  return { allow: true };
}
```

你之前学的 Pi Agent 的 `beforeToolCall` 钩子，其实就是这个层的雏形：

```typescript
beforeToolCall: async ({ toolCall }) => {
  if (toolCall.name === "bash") {
    return { block: true, reason: "bash is disabled" };
  }
}
```

`beforeToolCall` 就是**确定性授权点**——它在工具执行前、用代码规则（而非 LLM）决定放行还是拦截。

### 你的判断对不对

你问"是否确认完全交给模型判断"——**这个担忧是对的**。当前 Schema 把授权职责全压在了模型上，正确做法是：

```
工具声明（给模型看）         授权规则（给 Harness 看）
description / whenToUse   +   risk / requiresApproval（代码强制）
```

两个维度分开：

- **description / whenToUse**：引导模型"什么时候该考虑这个工具"（软约束）
- **risk / requiresApproval**：Harness 强制执行"能不能真调"（硬约束）

软约束管"建议"，硬约束管"底线"。两者配合才是一个有确定性授权层的 Harness。
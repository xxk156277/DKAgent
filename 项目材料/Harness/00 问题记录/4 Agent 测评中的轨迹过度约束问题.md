## 1. 这是什么问题，属于什么问题

这是一个 Agent 测评的“假阴性”问题：

> Agent 实际完成了任务，但测评规则将其错误判定为失败。

更准确地说，它属于“执行轨迹过度约束”：

- 任务目标：读取源文件并正确写入目标文件。
- 测评规则：Tool 调用必须严格等于 `read_file → write_file`。
- 实际行为：`read_file → write_file → read_file`，Agent 写完后又读取文件进行验证。
- 最终结果：文件内容正确，但因为多了一次合理调用而失败。

这不是 Agent 能力失败，而是测评器的判定规则没有准确表达业务目标。

## 2. 为什么会这样

根本原因是把“参考执行路径”误当成了“唯一正确路径”。

设计 Case 时，我们预想的最短路径是：

```
read_file(source.txt)
→ write_file(result.txt)
```

于是直接用完整数组相等判断：

```
actualSequence === ["read_file", "write_file"]
```

但 Agent 的执行具有自主性。同一个正确目标可能存在多条有效轨迹：

```
路径 A：read → write
路径 B：read → write → read，写后验证
路径 C：read → read → write，分段确认后写入
```

如果业务真正关心的是“读取后正确写入”，那么额外的合理验证行为不应该导致失败。

本质上混淆了三类要求：

- Outcome：最终文件是否正确。
- Invariant：必须先读后写，不能凭空生成。
- Exact trajectory：必须恰好调用两次 Tool。

前两项是本次业务目标，第三项只有在调用次数、成本或协议顺序本身是需求时才成立。

## 3. 如何解决

推荐采用“结果 + 因果约束”，不再要求完整轨迹绝对相等。

### 核心断言

- 至少成功调用一次 `read_file(source.txt)`。
- 至少成功调用一次 `write_file(result.txt)`。
- 首次写入前必须已经成功读取源文件。
- `write_file` 的 Tool Result 必须成功。
- 最终 `result.txt` 内容必须与期望完全一致。
- Tool Call/Result 必须完整配对。
- Agent 必须正常结束。
- 写入后的验证性读取允许存在。

例如下面的轨迹都应通过：

```
read(source) → write(result)
read(source) → write(result) → read(result)
read(source) → read(source) → write(result)
```

下面的轨迹应失败：

```
write(result)                         // 未读取源文件
write(result) → read(source)          // 因果顺序错误
read(source) → write(result)失败       // Tool 执行失败
read(source) → write(result)          // 最终内容错误
```

### 设计原则

Agent 测评优先级建议为：

```
最终结果正确
→ 关键业务不变量成立
→ Tool 协议完整
→ 轨迹效率与调用次数
```

“严格调用序列”应该只用于以下情况：

- 协议明确规定调用顺序。
- 多一次调用会产生费用或副作用。
- 写操作不可重复。
- 正在专项测评最短路径或执行效率。

否则，应允许多条语义等价的有效轨迹，避免把 Agent 的自主验证行为误判为失败。

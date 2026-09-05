
> 当模型报错后，Session数据库中存了Tool的调用，但是没存Result，导致Session复原后，模型报错；


结论：Tool Call 和 Result 不是同时产生的，所以运行中允许“暂时只有 Tool Call”；但不应把这种半完成状态当作可恢复的完整会话。  
这次大概率是 `analyze_interview` 执行期间进程重启：Tool Call 写于 14:40，当前观察进程启动于 14:41，Result 来不及写入。  
你说得对：SQL 和模型请求之间必须设置“完整性边界”，但不适合简单地在第一条消息入库前校验。

## 1. 为什么有 Tool 没有 Result

当前时序是：

```
保存 assistant.toolCall
→ 执行 Tool
→ 保存 tool.result
```

[loop.ts (line 156)](/Users/xuxiaokang/apps/DKAgent/packages/agent/src/agent/loop.ts:156) 先写 Tool Call；只有 `dispatchToolCall()` 成功返回后，[loop.ts (line 190)](/Users/xuxiaokang/apps/DKAgent/packages/agent/src/agent/loop.ts:190) 才写 Result。

中间出现以下情况就会断链：

- Tool 抛异常或进程被杀；
- 用户中断、程序重启；
- 多 Tool Call 执行到一半失败；
- Result 入库失败。

本次只能确认发生过进程切换；具体为何退出，旧进程 Trace 没保留下来，无法确定。

## 2. 入库前怎么校验

第一条 Tool Call 入库时，Result 尚未产生，因此无法校验“完整”。有两种设计：

### DKAgent 当前阶段推荐：整组事务入库

```
内存记录 Tool Call
→ 执行所有 Tool
→ 失败也转换成 Tool Result
→ SQL 事务写入 assistant + 全部 results
```

进程中途退出时，SQL 中不会留下半组消息。简单、容易理解，适合当前项目。

### 更完整的 Harness 设计

把 Tool Call 写成 `pending`：

```
pending → completed
        → failed
        → interrupted
```

恢复 Session 时只把 `completed` 组发送给模型；`pending` 需要恢复、重试或生成 interrupted Result。

无论采用哪种方案，发送 Provider 前都应无条件调用 `groupContextMessages()` 校验。目前 [ContextManager (line 136)](/Users/xuxiaokang/apps/DKAgent/packages/agent/src/context/manager.ts:136) 在未达到压缩阈值时跳过了校验，这是另一个必须修复的漏洞。
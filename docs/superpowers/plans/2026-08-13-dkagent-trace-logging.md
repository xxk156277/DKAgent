# DKAgent Trace Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用内存结构化 Trace 替换 Agent 内部 Runtime Events，让 Tap 展示 Agent Loop、Context 压缩、模型与 Tool 的完整过程。

**Architecture:** 新增 `@dkagent/trace`，由它拥有事件、Tracer、脱敏和内存 Store。Agent、ContextManager 与 Compressor 只调用注入的 Tracer；Tap 通过 Store 的 `list()` 与 `subscribe()` 读取事件并投影为现有三栏界面。

**Tech Stack:** TypeScript、Node.js AsyncLocalStorage、React、Ant Design、Zustand、HTTP/SSE。

## Global Constraints

- 第一版只使用内存，不写 JSONL、数据库或其他日志文件。
- 模型输入输出、Tool 参数结果、Context 前后内容全部记录。
- API Key、Authorization、Headers、环境变量始终脱敏。
- 前端只做事件名和常用字段的词级汉化，不引入 i18n 框架。
- Trace 失败不得影响 Agent。
- 不采用 TDD，不新增专项测试；只做开发自审、类型检查、现有回归与手工 Tap 验证。
- 审核 Agent 固定使用 `gpt-5.6-terra`、`medium`，且不继承完整对话。

---

### Task 1: 新增独立 Trace 包

**Files:**
- Create: `packages/trace/package.json`
- Create: `packages/trace/tsconfig.json`
- Create: `packages/trace/src/types.ts`
- Create: `packages/trace/src/tracer.ts`
- Create: `packages/trace/src/memory-store.ts`
- Create: `packages/trace/src/sanitize.ts`
- Create: `packages/trace/src/index.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `TraceEvent`、`TraceSink`、`TraceStore`、`TraceSpan`、`Tracer`、`MemoryTraceStore`。

- [ ] 创建 `@dkagent/trace` workspace，导出上述公共 API。
- [ ] `Tracer.span(name, input, operation, options?)` 使用 AsyncLocalStorage 关联 `traceId`、父 Span 和 Step；自动发送 start/end/error。
- [ ] `TraceSpan.event()` 记录过程，`setOutput()` 记录结束输出；所有 Sink 异常在 Tracer 内吞掉。
- [ ] `sanitize.ts` 通过一次 JSON round-trip 深拷贝并脱敏敏感 Key，循环引用降级为安全描述。
- [ ] `MemoryTraceStore` 固定容量保存事件，提供同步 `list()` 与 `subscribe()`；先脱敏再同时用于历史和实时订阅。
- [ ] 执行 `npm install --package-lock-only` 更新 workspace lockfile。
- [ ] 自审后提交：`feat(trace): add in-memory structured tracing`。

### Task 2: Agent、Context 与 Compressor 接入 Trace

**Files:**
- Modify: `packages/agent/package.json`
- Modify: `packages/agent/src/agent/types.ts`
- Modify: `packages/agent/src/agent/loop.ts`
- Modify: `packages/agent/src/cli/run.ts`
- Modify: `packages/agent/src/context/types.ts`
- Modify: `packages/agent/src/context/manager.ts`
- Modify: `packages/agent/src/context/compressor.ts`
- Delete: `packages/agent/src/runtime/events.ts`
- Modify existing tests only as required for imports/fixtures; add no new test cases.

**Interfaces:**
- Consumes: `Tracer` from `@dkagent/trace`.
- Produces: `runAgentCli({ tracer? })` and `AgentLoopOptions.tracer?: Tracer`。

- [ ] CLI 组合根创建或接收一个 Tracer，并把同一实例注入 Compressor、ContextManager 与 AgentLoop。
- [ ] AgentLoop 用 `agent.turn` 包裹一次用户输入，用 `agent.step` 标记循环；记录 `model.request/response`、`tool.call/result`。
- [ ] ContextManager 记录 `context.build`、原始快照、Token 计数、阈值判断、压缩计划和完成结果。
- [ ] Compressor 记录摘要模型的实际请求、响应和错误。
- [ ] `ConversationContextState` 只保留 `summary`、`firstKeptMessageIndex`；`ContextSnapshot` 移除只为 Tap 服务的统计字段，统计改由 Trace 事件承载。
- [ ] 删除 Agent 自有 Runtime Event Publisher；迁移现有引用到 `@dkagent/trace`。
- [ ] 自审普通回答、Tool、压缩成功、摘要兜底和异常路径后提交：`refactor(agent): emit trace events outside business state`。

### Task 3: Tap 改为消费内存 Trace

**Files:**
- Modify: `packages/web-tap/package.json`
- Modify: `packages/web-tap/src/observe.ts`
- Delete: `packages/web-tap/src/tap/recorder.ts`
- Modify: `packages/web-tap/src/tap/server.ts`
- Modify: `packages/web-tap/src/tap/viewer-state.ts`
- Modify: `packages/web-tap/src/web/api/event-feed.ts`
- Modify: `packages/web-tap/src/web/store/tap-store.ts`
- Modify: `packages/web-tap/src/web/model/types.ts`
- Modify: `packages/web-tap/src/web/model/project-events.ts`
- Modify: `packages/web-tap/src/web/features/compaction/ContextCompactionDetail.tsx`
- Modify: `packages/web-tap/src/web/features/node-detail/FieldDescriptions.tsx`
- Modify existing tests only as required for imports/fixtures; add no new test cases.

**Interfaces:**
- Consumes: `TraceEvent`、`TraceStore`、`MemoryTraceStore` from `@dkagent/trace`.
- Preserves: `/api/events`、`/api/events/stream` and current Turn/Step/Node UI structure.

- [ ] observe 创建 `MemoryTraceStore` 和 Tracer；Server 与 Agent 使用同一个 Store，删除 `.traces/events.jsonl` 路径和 flush。
- [ ] Server 的历史接口调用 `store.list()`，SSE 调用 `store.subscribe()`。
- [ ] 前端所有事件类型改为 `TraceEvent`，按 `traceId + step + sequence` 合并与选择最新节点。
- [ ] Projector 把 Trace start/event/end/error 映射为中文节点；压缩阶段逐个成为右侧导航节点。
- [ ] Context 压缩详情展示压缩前 Token、压缩后 Token、节省量、节省比例、摘要/保留消息数和兜底状态。
- [ ] 扩充字段词典；未知事件继续显示通用节点和原始 JSON。
- [ ] 自审三栏交互与降级逻辑后提交：`feat(web-tap): visualize structured trace events`。

### Task 4: 主 Agent 验证与 Terra 独立审核

**Files:**
- Review all files changed since commit `2dca982`.

- [ ] 主 Agent 运行 `npm run typecheck -w @dkagent/trace`、Agent/Web Tap typecheck 与现有相关回归。
- [ ] 主 Agent 启动 `npm run observe`，手工检查普通模型循环与 Context 压缩节点、Token 对比、中文词语和 SSE。
- [ ] 创建 `gpt-5.6-terra`、`medium`、`fork_turns: none` 的审核 Agent；只提供设计文档、提交范围和审核清单。
- [ ] Terra 审核模块边界、敏感信息、错误隔离，并重复类型检查、现有回归和 Tap 验证。
- [ ] 主 Agent 处理审核问题；若修改代码，重新执行受影响检查并提交修复。

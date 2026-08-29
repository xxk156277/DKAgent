## Context

P1 已提供 SQLite TraceStore、TraceSummary、TraceDocument、SpanChange 和 CLI recent/show。Web Tap 仍使用 TraceEvent 类型与 V1 事件接口，因此当前 Web 类型检查失败，且其节点语义无法与 CLI JSON 对齐。详见 proposal.md 与本 change 的 delta specs。

约束是保持现有 SQLite ER、Session 页面与服务器安全边界，并让 Trace/Tap 故障继续被 Agent 隔离。Memory 已在 CLI 入口暂时下线，不属于本阶段。

## Goals / Non-Goals

**Goals:**

- 让 Trace 包提供 Web 和 CLI 共用的最小只读契约与完整性构建逻辑。
- 让服务端 API、SSE、客户端 Store 和界面全程使用 canonical Typed Span。
- 用有限、可测试的纯函数完成 revision 合并、Span 投影和指标计算。

**Non-Goals:**

- 不改数据库表、Trace 写入协议或 Agent 执行链路。
- 不实现采样、成本、评测器、OTel、保留任务或 V1 兼容。
- 不重新设计整套 UI；只迁移数据模型和必要展示。

## Decisions

### 1. TraceReader 是 TraceStore 的只读子契约

新增最小 TraceReader，包含 Session Summary 查询、单文档读取和 Session 是否存在 Trace。SQLite Store 实现该接口，Tap Server 仅依赖读取与订阅所需能力。

选择它而不是让 Web 直接查询 SQLite，是为了保留 Trace 包对版本、上限和完整性的唯一解释；也不引入通用 Repository，避免 MVP 抽象过度。

### 2. 抽取共享 TraceDocument 构建函数

把现有 SQLite Reader 内的 Span 排序、上限和完整性诊断抽成 Trace 包纯函数。SQLite show 与 Web 历史/实时合并后都调用它，确保 complete 与 diagnostics 不产生两套规则。

不让 Web 自己复制诊断，也不把 UI 状态放进 Trace 包。

### 3. SSE 只传 SpanChange，客户端先连再读

`/api/traces/stream` 直接发送成功提交后的 SpanChange。Session 页面先建立 SSE，再读取 TraceSummary 与当前 Document；历史结果进入 Store 时逐 Span 与已有实时快照比较 revision。

这比服务端维护每个浏览器的增量游标更小，仍能覆盖“连接与历史读取之间”的竞态。断线后使用相同流程补读，不增加持久化游标。

### 4. Store 以 canonical Document 为主

Store 保存 Session 的 Summary 列表、按 traceId 的 Document、当前 trace/span、followLive 和连接状态。合并规则只接受更高 revision，并检查 traceId、parentSpanId、name、kind、sequence 身份不变；相同或更低 revision 忽略。

选择 Document 而不是平行维护事件数组，是为了让 UI 输入与 CLI JSON 同构，减少转换层。

### 5. projectSpans 保持一对一投影

每个 Span 生成一个节点，ID 为 spanId。节点通过最近的 `agent.step` 祖先归组；没有 Step 祖先的放入 Turn 级分组。所有节点按 sequence 排序并保留 parentSpanId。

Token 与耗时在投影层用纯函数计算：直接 Token 取当前 Span；子树 Token 汇总当前及后代模型 Span；自身耗时为 canonical durationMs 减去裁剪到父区间后的直接子 Span 时间区间并集。这样避免嵌套和并发重复扣减。

### 6. 复用现有页面骨架

保留 Session 路由、导航和样式结构，将旧 Event props 替换为 TraceSummary/TraceDocument/投影节点。Context 只从 typed input/output 读取已存在指标，不猜测缺失字段；外部证据类评价固定显示“待评测”。

## Risks / Trade-offs

- [首次 SSE 没有服务端 replay id] → 连接后立即补读数据库，并用 revision 合并覆盖窗口；MVP 不增加游标协议。
- [Document 达到 1000 Span 后不完整] → 沿用 Reader 上限并通过 complete/diagnostics 明示，不做无界加载。
- [旧 UI 组件与 TraceEvent 耦合较深] → 只替换直接依赖的类型和投影，保持布局与样式，避免顺手重构。
- [直接子 Span 区间可能越过父区间] → 计算前裁剪到父区间，非法或缺失时间返回无法计算。
- [Tap Reader/订阅异常] → 服务端返回安全错误或断开单个客户端，不传播到 Agent Trace 写入路径。

## Migration Plan

1. 先增加 TraceReader 与共享 Document 构建，保持 CLI 测试通过。
2. 用 V2 API 替换服务端旧路由并删除旧 API 测试。
3. 迁移 Store、SSE 客户端和 projectSpans，再替换页面输入。
4. 删除因迁移产生的 V1 类型、投影和夹具。
5. 通过 Trace、Agent、Web 全量门禁，并用 test2.md 对比 Web 与 CLI JSON。

本 change 未改变持久化格式；若 P2 需要回退，只回退 Web/Reader 代码，P1 SQLite 数据仍可被 CLI 读取。

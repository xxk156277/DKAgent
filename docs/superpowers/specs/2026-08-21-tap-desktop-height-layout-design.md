# Web Tap 桌面端高度布局设计

## 背景

Session 详情页新增 `tap-session-backbar` 后出现两个问题：Backbar 位于产品栏之前；页面总高度没有把 Backbar 纳入统一约束，导致内容撑出视口并产生页面级滚动。

本次只处理宽度不小于 `768px` 的 Web 桌面端高度链；移动端保留现有页面布局，只将 Session Backbar 放在 `TapApp` 外部，避免改变移动端产品栏顺序。

## 目标

1. DOM 与视觉顺序固定为 `tap-product-header`、`tap-session-backbar`、主工作区。
2. Session 详情页所有模块合计刚好占满 `100dvh`。
3. 轮次、节点、详情和 Agent 指标内容超高时，只在各自模块内部滚动。
4. 不改变模块宽度、业务数据、Store、Session API 和移动端行为。

## 方案

`SessionDetailPage` 继续负责构造 Session 导航，并通过 `useTapViewport` 区分移动端与桌面端。桌面 Trace 详情将其作为 `sessionNavigation` 插槽传给 `TapApp`，由 `TapApp` 在 `TapHeader` 后、`tap-app-body` 前渲染；移动 Trace 详情将 Backbar 保持为详情 shell 的直接子项，位于 `TapApp` 之前。

这样既能保证真实 DOM 顺序，也避免 `TapApp` 直接依赖 React Router 或 Session 页面逻辑。AntD `App` 增加稳定的 `tap-ant-app` class，参与桌面 Trace 的完整 flex 高度链。

```text
桌面 Trace:
tap-session-detail-shell.is-trace-view  height: 100dvh; overflow: hidden
└─ tap-ant-app           display: flex; flex: 1; flex-direction: column; min-height: 0
   └─ tap-app-shell      flex: 1; min-height: 0
      ├─ tap-product-header  flex: 0 0 52px
      ├─ tap-session-backbar flex: 0 0 40px
      └─ tap-app-body        flex: 1; min-height: 0
         ├─ tap-turn-region  overflow-y: auto
         └─ tap-workspace    min-height: 0
            ├─ tap-turn-header
            └─ tap-workspace-content  min-height: 0; overflow: hidden
               ├─ tap-node-region     overflow-y: auto
               ├─ tap-detail-region   overflow-y: auto
               └─ tap-insights-rail   overflow-y: auto

移动 Trace:
tap-session-detail-shell.is-trace-view
├─ tap-session-backbar
└─ tap-ant-app
   └─ tap-app-shell
      ├─ tap-product-header
      └─ tap-app-body
```

## 组件改动

- `TapApp`：增加可选 `sessionNavigation: ReactNode`，紧随 `TapHeader` 渲染；给 AntD `App` 增加 `tap-ant-app` class。
- `SessionDetailPage`：有 Trace 时增加 `is-trace-view` 状态；移动端将 Backbar 外置，桌面端通过插槽传入 `TapApp`；无 Trace 的历史页面保持 Backbar + `SessionHistory` 和自然页面滚动。
- `styles.css`：仅在桌面媒体查询内为 `is-trace-view` 补齐详情 shell → `tap-ant-app` → `tap-app-shell` 的固定视口 flex 高度链、`min-height: 0` 和内容 `overflow: hidden`。

## 验证

- 组件测试断言产品栏在 Backbar 之前，Backbar 在工作区之前。
- CSS 契约测试断言桌面端根容器固定为 `100dvh`，中间 flex 父级可收缩，页面不发生纵向滚动。
- 运行 Web Tap 现有测试、类型检查和构建；不修改既有 Session 数据库和无关测试。

## 非目标

- 不调整移动端工作区和抽屉；仅保持移动 Trace 的 Backbar 外置顺序。
- 不调整模块视觉样式、宽度或响应式断点。
- 不重构 Session 列表页和无 Trace 历史页的产品栏。

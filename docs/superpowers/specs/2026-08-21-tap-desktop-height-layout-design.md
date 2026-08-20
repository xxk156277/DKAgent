# Web Tap 桌面端高度布局设计

## 背景

Session 详情页新增 `tap-session-backbar` 后出现两个问题：Backbar 位于产品栏之前；页面总高度没有把 Backbar 纳入统一约束，导致内容撑出视口并产生页面级滚动。

本次只处理宽度不小于 `768px` 的 Web 桌面端，不调整移动端布局。

## 目标

1. DOM 与视觉顺序固定为 `tap-product-header`、`tap-session-backbar`、主工作区。
2. Session 详情页所有模块合计刚好占满 `100dvh`。
3. 轮次、节点、详情和 Agent 指标内容超高时，只在各自模块内部滚动。
4. 不改变模块宽度、业务数据、Store、Session API 和移动端行为。

## 方案

`SessionDetailPage` 继续负责构造 Session 导航，但将其作为 `sessionNavigation` 插槽传给 `TapApp`。`TapApp` 在 `TapHeader` 后、`tap-app-body` 前渲染该插槽。

这样既能保证真实 DOM 顺序，也避免 `TapApp` 直接依赖 React Router 或 Session 页面逻辑。

```text
tap-session-detail-shell  height: 100dvh; overflow: hidden
└─ tap-app-shell          flex: 1; min-height: 0
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
```

## 组件改动

- `TapApp`：增加可选 `sessionNavigation: ReactNode`，紧随 `TapHeader` 渲染。
- `SessionDetailPage`：有 Trace 时把 Backbar 传入 `TapApp`；无 Trace 的历史页面保持当前结构，本次不扩大范围。
- `styles.css`：仅在桌面媒体查询内补齐固定视口高度、`min-height: 0` 和父级 `overflow: hidden`。

## 验证

- 组件测试断言产品栏在 Backbar 之前，Backbar 在工作区之前。
- CSS 契约测试断言桌面端根容器固定为 `100dvh`，中间 flex 父级可收缩，页面不发生纵向滚动。
- 运行 Web Tap 现有测试、类型检查和构建；不修改既有 Session 数据库和无关测试。

## 非目标

- 不处理移动端布局和抽屉。
- 不调整模块视觉样式、宽度或响应式断点。
- 不重构 Session 列表页和无 Trace 历史页的产品栏。

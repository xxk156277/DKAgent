# Web Tap Flex Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Web Tap 三栏改为 Turn、Node、Detail，并让 Node 固定 280px、Detail 随窗口伸缩。

**Architecture:** 保持现有 React 组件和 Zustand 数据流不变，只调整 `TapApp` 的 DOM 顺序与页面级 CSS。桌面使用单行 Flex；中等宽度使用 Flex 换行；移动端改为纵向 Flex。

**Tech Stack:** React 19、Ant Design、CSS Flexbox、Vitest、Testing Library

## Global Constraints

- 桌面 DOM 与视觉顺序必须为 Turn、Node、Detail。
- Turn 固定 240px，Node 固定 280px，Detail 使用剩余空间且允许收缩。
- 390px 宽度不能出现页面级水平溢出。
- 不修改事件投影、Zustand Store、Agent 或服务端。
- 保留工作区中已有的 `TapApp.tsx` Node/Detail 顺序调整。

---

### Task 1: 改造三栏 Flex 布局

**Files:**
- Modify: `packages/web-tap/src/web/app/TapApp.tsx`
- Modify: `packages/web-tap/src/web/styles.css`
- Modify: `packages/web-tap/test/web/tap-app.test.tsx`

**Interfaces:**
- Consumes: `TurnList`、`NodeNav`、`NodeDetailBoundary` 现有组件。
- Produces: DOM 顺序为 Turn、Node、Detail 的弹性三栏页面。

- [ ] **Step 1: 写布局契约测试**

在 `tap-app.test.tsx` 增加断言，使用区域角色确认 `complementary` Turn、`complementary` Node、`main` Detail 的 DOM 顺序为 Turn → Node → Detail；读取 `styles.css`，断言主布局包含 `display: flex`、Node 包含 `flex: 0 0 280px`、Detail 包含 `flex: 1 1 auto` 和 `min-width: 0`。

- [ ] **Step 2: 运行测试并确认 RED**

```bash
npm run test:web -w @dkagent/web-tap -- --run test/web/tap-app.test.tsx
```

预期：CSS 契约失败，因为当前仍使用 Grid。

- [ ] **Step 3: 实现桌面 Flex 布局**

将 `.tap-app-shell` 改为：

```css
.tap-app-shell {
  display: flex;
  align-items: stretch;
}

.tap-turn-region { flex: 0 0 240px; }
.tap-node-region { flex: 0 0 280px; }
.tap-detail-region {
  flex: 1 1 auto;
  min-width: 0;
}
```

删除所有 `grid-area`、`grid-template-areas`、`grid-template-columns`。保持 `TapApp.tsx` 的 Turn → Node → Detail 顺序。

- [ ] **Step 4: 实现响应式 Flex**

`< 960px` 时设置 `flex-wrap: wrap`，Turn 保持 240px，Detail 使用 `calc(100% - 240px)`，Node 通过 `order: 3; flex-basis: 100%` 移至下一行。`< 640px` 时三栏均为 `flex: 0 0 100%`，顺序为 Turn → Node → Detail，并清理栏间边框。

- [ ] **Step 5: 运行验证**

```bash
npm run test:web -w @dkagent/web-tap -- --run test/web/tap-app.test.tsx
npm run typecheck -w @dkagent/web-tap
npm run build -w @dkagent/web-tap
git diff --check
```

预期：测试、类型检查、构建和 diff 检查全部通过；构建可能保留既有 chunk-size warning。

- [ ] **Step 6: 提交布局改动**

```bash
git add packages/web-tap/src/web/app/TapApp.tsx packages/web-tap/src/web/styles.css packages/web-tap/test/web/tap-app.test.tsx
git commit -m "style(web-tap): make detail layout flexible"
```

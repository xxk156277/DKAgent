# Web Tap Desktop Height Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Session Trace 详情页按“产品栏、Session 返回栏、工作区”排列，并在桌面端恰好占满视口且仅允许模块内部滚动。

**Architecture:** `SessionDetailPage` 仍负责构造 Session 导航，并用 `useTapViewport` 保持移动 Trace 的 Backbar 外置、桌面 Trace 的 `sessionNavigation` 插槽。`TapApp` 在产品栏之后渲染桌面插槽，并给 AntD `App` 增加 `tap-ant-app` class。桌面端使用 `SessionDetailPage → tap-ant-app → tap-app-shell` 的完整 flex 高度链约束视口，叶子模块继续复用现有 `overflow-y: auto`。

**Tech Stack:** React 19、TypeScript、Vite、Ant Design 6、Zustand、Vitest、Testing Library、CSS Flexbox

## Global Constraints

- 只新增宽度不小于 `768px` 的 Web 桌面端高度约束；移动端工作区和抽屉布局不变，Trace Backbar 保持外置。
- 不改变模块宽度、业务数据、Store、Session API 和现有滚动模块职责。
- 不引入新依赖，不重构 Session 列表页和无 Trace 历史页。
- 不暂存或提交 `.dkagent/sessions.db`。

---

### Task 1: 调整 Session Trace 详情页顺序与高度链

**Files:**
- Modify: `packages/web-tap/src/web/app/TapApp.tsx`
- Modify: `packages/web-tap/src/web/app/WebTapRouter.tsx`
- Modify: `packages/web-tap/src/web/styles.css`
- Test: `packages/web-tap/test/web/session-pages.test.tsx`
- Test: `packages/web-tap/test/web/tap-app.test.tsx`

**Interfaces:**
- Consumes: `SessionDetailPage` 已有的 Session Backbar JSX；现有 `.tap-turn-region`、`.tap-node-region`、`.tap-detail-region`、`.tap-insights-rail` 内部滚动能力。
- Produces: `TapAppProps.sessionNavigation?: ReactNode`；`tap-session-detail-shell.is-trace-view`；产品栏、Session Backbar、主工作区的稳定 DOM 顺序；桌面端 `100dvh` 高度契约。

- [ ] **Step 1: 写入 DOM 顺序失败测试**

在 `session-pages.test.tsx` 的“无 Trace 详情持续监听并在首个事件到达后切换到运行工作区”测试中保留 `container`，首个 Trace 到达后断言三个相邻节点的顺序：

```tsx
const { container } = render(
  <MemoryRouter initialEntries={["/sessions/session-live"]}>
    <WebTapRoutes />
  </MemoryRouter>,
);

const detailShell = container.querySelector(".tap-session-detail-shell");
expect(detailShell).not.toHaveClass("is-trace-view");

// 首个事件到达并出现工作区后
const productHeader = container.querySelector(".tap-product-header");
const backbar = container.querySelector(".tap-session-backbar");
const appBody = container.querySelector(".tap-app-body");

expect(productHeader).not.toBeNull();
expect(productHeader?.nextElementSibling).toBe(backbar);
expect(backbar?.nextElementSibling).toBe(appBody);
expect(detailShell).toHaveClass("is-trace-view");
```

- [ ] **Step 2: 写入桌面高度契约失败测试**

在 `tap-app.test.tsx` 中读取 `styles.css`，断言桌面媒体查询具备固定视口、可收缩父级和内容裁切：

```tsx
it("uses a desktop viewport and internal-scroll height contract", () => {
  const styles = readFileSync(resolve(process.cwd(), "src/web/styles.css"), "utf8");
  expect(styles).toMatch(/@media\s*\(min-width:\s*768px\)[\s\S]*?\.tap-session-detail-shell\.is-trace-view\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/s);
  expect(styles).toMatch(/@media\s*\(min-width:\s*768px\)[\s\S]*?\.tap-session-detail-shell\.is-trace-view\s+\.tap-app-shell[^}]*min-height:\s*0;/s);
  expect(styles).toMatch(/@media\s*\(min-width:\s*768px\)[\s\S]*?\.tap-workspace\s*\{[^}]*min-height:\s*0;/s);
  expect(styles).toMatch(/@media\s*\(min-width:\s*768px\)[\s\S]*?\.tap-workspace-content\s*\{[^}]*overflow:\s*hidden;/s);
  expect(styles).toMatch(/\.tap-turn-region\s*\{[^}]*overflow-y:\s*auto;/s);
  expect(styles).toMatch(/\.tap-node-region\s*\{[^}]*overflow-y:\s*auto;/s);
  expect(styles).toMatch(/\.tap-detail-region\s*\{[^}]*overflow-y:\s*auto;/s);
  expect(styles).toMatch(/\.tap-insights-rail\s*\{[^}]*overflow-y:\s*auto;/s);
});
```

- [ ] **Step 3: 运行聚焦测试并确认失败原因**

Run:

```bash
npm run test:web -w @dkagent/web-tap -- --run test/web/session-pages.test.tsx test/web/tap-app.test.tsx
```

Expected: FAIL；DOM 测试显示产品栏不是 Backbar 的前一个兄弟节点，高度契约测试找不到桌面媒体查询规则。

- [ ] **Step 4: 给 TapApp 增加导航插槽**

在 `TapApp.tsx` 导入 `ReactNode` 类型：

```tsx
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
```

扩展 Props 和函数参数：

```tsx
interface TapAppProps {
  store?: StoreApi<TapState>;
  sessionId?: string;
  connectLive?: boolean;
  sessionNavigation?: ReactNode;
}

export function TapApp({
  store = tapStore,
  sessionId,
  connectLive = true,
  sessionNavigation,
}: TapAppProps) {
```

给 `AntdApp` 增加稳定 class，并在已有 `TapHeader` 结束标签和 `tap-app-body` 之间插入桌面导航：

```tsx
<AntdApp className="tap-ant-app">
<TapHeader
  connectionStatus={connectionStatus}
  mobile={mobile}
  attentionCount={attentionCount}
  onOpenTurns={() => setTurnsOpen(true)}
  onOpenInsights={() => setInsightsOpen(true)}
/>
{sessionNavigation}
<div className="tap-app-body">
```

- [ ] **Step 5: 从 SessionDetailPage 传入 Backbar**

在 `WebTapRouter.tsx` 中只构造一次 Backbar。使用 `useTapViewport`：移动 Trace 将 Backbar 作为详情 shell 的直接子项并置于 `TapApp` 前；桌面 Trace 通过插槽传入 `TapApp`；无 Trace 分支保持 Backbar + `SessionHistory`：

```tsx
const sessionNavigation = (
  <nav className="tap-session-backbar" aria-label="Session 导航">
    <Link to="/">← 返回 Sessions</Link>
    <Typography.Text code>{session.id}</Typography.Text>
  </nav>
);
const isTraceView = eventCount > 0;
const mobile = useTapViewport() === "mobile";

return (
  <div className={`tap-session-detail-shell${isTraceView ? " is-trace-view" : ""}`}>
    {isTraceView && mobile ? sessionNavigation : null}
    {isTraceView ? (
      <TapApp
        connectLive={false}
        store={store}
        sessionId={sessionId}
        sessionNavigation={mobile ? undefined : sessionNavigation}
      />
    ) : (
      <>
        {sessionNavigation}
        <SessionHistory session={session} />
      </>
    )}
  </div>
);
```

- [ ] **Step 6: 补齐桌面端 flex 高度链**

在 `styles.css` 的响应式区域新增桌面规则，不修改现有移动端媒体查询；让直接子级 `tap-ant-app` 闭合详情 shell 到 `tap-app-shell` 的高度链：

```css
@media (min-width: 768px) {
  .tap-session-detail-shell.is-trace-view {
    height: 100vh;
    height: 100dvh;
    min-height: 0;
    overflow: hidden;
  }

  .tap-session-detail-shell.is-trace-view > .tap-ant-app {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }

  .tap-session-detail-shell.is-trace-view .tap-app-shell,
  .tap-workspace {
    flex: 1 1 auto;
    min-height: 0;
  }

  .tap-workspace-content {
    overflow: hidden;
  }
}
```

- [ ] **Step 7: 运行聚焦测试并确认通过**

Run:

```bash
npm run test:web -w @dkagent/web-tap -- --run test/web/session-pages.test.tsx test/web/tap-app.test.tsx
```

Expected: 两个测试文件全部 PASS。

- [ ] **Step 8: 运行 Web Tap 回归、类型检查、构建与差异检查**

Run:

```bash
npm run test:web -w @dkagent/web-tap -- --run
npm run typecheck -w @dkagent/web-tap
npm run build -w @dkagent/web-tap
git diff --check
```

Expected: 测试、类型检查、构建和差异检查全部退出码为 `0`；允许保留既有 Vite 大 Chunk 警告。

- [ ] **Step 9: 只提交本任务文件**

```bash
git add \
  packages/web-tap/src/web/app/TapApp.tsx \
  packages/web-tap/src/web/app/WebTapRouter.tsx \
  packages/web-tap/src/web/styles.css \
  packages/web-tap/test/web/session-pages.test.tsx \
  packages/web-tap/test/web/tap-app.test.tsx
git commit -m "fix(web-tap): constrain desktop session layout"
```

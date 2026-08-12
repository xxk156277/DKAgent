# Web Tap Flex 布局调整

## 目标

将 Session 详情主区域调整为：

`Turn 列表 | Node 导航 | Detail 详情`

Node 导航保持固定宽度，Detail 随浏览器宽度伸缩。

## 桌面布局

- 主容器使用 Flex，不再使用 CSS Grid。
- Turn 列表：`flex: 0 0 240px`。
- Node 导航：`flex: 0 0 280px`。
- Detail：`flex: 1 1 auto; min-width: 0`。
- DOM 顺序保持 Turn、Node、Detail，与视觉顺序一致。

## 响应式

- `< 960px`：允许换行，Turn 与 Detail 位于首行，Node 占下一行。
- `< 640px`：Turn、Node、Detail 按 DOM 顺序纵向排列，每列宽度为 100%。
- Detail 内长文本和 JSON 必须在自身区域内滚动或换行，不能撑宽页面。

## 范围

- 修改 `TapApp.tsx` 的栏位顺序和 `styles.css` 的布局规则。
- 更新布局相关测试。
- 不修改事件投影、Zustand Store、Agent 或服务端。

## 验收

- 桌面端 Node 宽度为 280px，Detail 自动占据剩余空间。
- 390px 宽度下无水平溢出。
- Turn、Node、Detail 的视觉顺序与 DOM 顺序一致。

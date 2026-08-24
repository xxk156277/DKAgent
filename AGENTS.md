# DKAgent Agent Instructions

## 项目事实

- 对当前检出做结论前，读取当前源码、测试、`desginDocs/`、活跃 OpenSpec 和 Git 状态。
- 明确区分当前实现、目标设计、参考 Worktree、用户事实、推断和未验证结果。
- 文件、计划、Telemetry、局部测试或提交存在，都不能单独证明端到端能力。

## 开发规则

- 实现前陈述假设，只做能追溯到需求的最小修改，不重构无关代码。
- 保留用户已有改动；按风险运行聚焦测试、类型检查和 `git diff --check`。

## 项目管理

- 编码前使用 `$dkagent-project-manager` 的 `worker-start`；实现和验证后使用 `worker-finish`。
- 优先复用 `docs/project/BACKLOG.md` 的任务 ID；计划外工作必须先生成事件 ID。
- WIP=1 适用于每个 Agent/Worktree；独立模块可以并行。
- Worker Worktree 不直接修改 `AGENTS.md`、`docs/project/STATUS.md`、`docs/project/BACKLOG.md`；只有项目管家向配置的管理 Worktree 汇总。
- 没有行为相关验证时不得把代码任务标为完成；失败或跳过验证使用 `needs_verification`。
- 删除、延期或改变待办目标前必须询问用户。

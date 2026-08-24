# DKAgent Project Manager Final Gate Fix Report

## 结论

基于 `53589d6` 完成最终审查中的全部 Important 与 Minor 修复。改动保持在仓库级项目管家 Skill、helper、契约文档和回归测试范围内；没有进入 DKAgent 业务运行时，没有实现通用文档渲染平台，也没有改写 STATUS/BACKLOG 为虚假真实进度。

## 修复

1. 锁恢复只允许 ownerless 或 owner PID 两次明确为 `ESRCH` 的锁；live、`EPERM`、PID 复用、live intent 和 owned tombstone 均阻塞。补充 CLI acquire 进程退出后的恢复测试与 Skill 操作流程。
2. Snapshot 同时检测“同 task 多 worktree”和“同 worktree 多 active task”，返回带 `kind` 的稳定排序 shape；覆盖 pending 与 processed+pending 重放。
3. `test`、`typecheck`、`build` 证据严格匹配命令类型；`git diff --check`、`node --check`、Skill validator 和 commit 不作为行为完成证据。缺证据、失败证据或仅 commit 的 `finished/completed` 在 emit 时保留 action 并降级为 `needs_verification`。
4. ACK 除精确文档 hash 外，还要求每个待处理 taskId 出现在可见 STATUS task marker 或合法 8 列 BACKLOG 行。注释、正文、title-only、empty-title 和空 event list 均拒绝并保留 pending。三 worktree fixture 会渲染三个任务的 title、status 和 evidence 后再经 CLI ACK。
5. 所有持久化自由文本拒绝 CR/LF 和 Markdown heading 注入。
6. 已存在 repo/worktree/common-dir 使用 canonical realpath，覆盖 symlink 与 macOS `/var`/`/private/var` 等价路径，同时保留跨仓库和 hashes 文件 containment/symlink escape 防护。

## TDD 证据

每类行为都先增加可观察失败测试，再做最小实现并回归。专项测试由基线 35 个扩展为 49 个，覆盖正常路径、processed/pending、CLI 子进程、恢复竞态保守分支和 ACK 欺骗负例。

## 验证

- `npm run test:project-manager`：49/49 PASS。
- `npm test`：exit 0；Agent 231、Trace 6、Web Node 17、Web Vitest 68、Project Manager 49 均通过，Vite build 成功。
- `npm run typecheck`：exit 0。
- `python3 /Users/xuxiaokang/.codex/skills/.system/skill-creator/scripts/quick_validate.py .codex/skills/dkagent-project-manager`：`Skill is valid!`。
- `node --check .codex/skills/dkagent-project-manager/scripts/project-events.mjs`：exit 0。
- `git diff --check`：exit 0，无输出。

## 风险与边界

- evidence 命令分类器有意保持窄白名单；未声明的新 runner/脚本会拒绝，而不会猜测种类。
- STATUS marker 是最小 ACK 契约，不是通用 Markdown 渲染器；业务优先级和内容仍由项目管家按 Skill 判断。
- 本次未在 main 初始化真实共享状态，也未运行新的 Codex task 验证 Skill 自动选择；这些动作不属于当前 feature worktree 的最终 Gate 修复授权。
- 包含本报告的最终提交 SHA 以提交后的 `git log -1` 为准。

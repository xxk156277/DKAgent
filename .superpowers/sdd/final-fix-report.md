# DKAgent Project Manager Final Gate Fix Report

## 结论

基于 `53589d6` 完成七轮最终审查修复。改动仅限仓库级项目管家 Skill、helper、契约文档和回归测试；没有进入 DKAgent 业务运行时，没有实现通用文档渲染平台，也没有把虚假真实进度写入 STATUS/BACKLOG。

## 修复

1. 合法 lock owner 被定义为跨短命 CLI 进程的 Agent lease：无论其记录的 PID 是否仍存活，`recover-lock` 都不能强拆。丢失本地 token 时，先从 `lock-status.owner.token` 取回，并在 acquiredAt、baseline 和当前上下文一致时调用 `release-lock`；事实冲突时停止并人工确认。恢复仅处理 invalid/legacy ownerless lock、stale creating 和 stale intent。
2. taskId 采用 canonical 格式 `^DKA-[A-Z0-9][A-Z0-9-]{2,63}$`，拒绝首尾空白、小写和静默规范化；dependency 使用同一规则。
3. `project` helper/CLI 为事件生成 canonical event projection：人类可读 task 行和带 SHA-256 digest 的完整 payload 行。payload 除全部业务语义外，还固定绑定 schemaVersion、canonical worktreePath、branch、headSha 和 createdAt；人类行同样显示来源与时间。缺少来源或伪造旧 HEAD 均不能 ACK。
4. ACK 要求事件的两行 canonical projection 精确存在于同一份 STATUS.md 或 BACKLOG.md。文档保存 latest current projection：同 taskId 的后续事件替换旧 block，避免同时展示 `in_progress` 和完成态；完整审计历史保留在 processed event JSON，而不在文档永久堆积旧 block。
5. ACK 在移动任何事件前，以当前 state 和全部 pending 重新计算“双向 WIP=1”冲突；同 worktree 多 active task 或同 task 多 worktree 均拒绝，并保留 lock 与 pending events。
6. Snapshot 同样返回带 `kind` 的稳定排序冲突 shape，并覆盖 pending 与 processed+pending 重放。
7. `test`、`typecheck`、`build` 证据严格匹配命令类型；缺少成功行为证据、失败证据或只有 commit 证据的 `finished/completed` 保留 action，并确定性降级为 `needs_verification`。
8. 所有持久化自由文本拒绝 CR/LF 和 Markdown heading 注入；已存在 repo/worktree/common-dir 使用 canonical realpath，兼容 macOS `/var` 与 `/private/var`，同时保留路径 containment 和 symlink escape 防护。
9. `project` 与 ACK 按 `(createdAt,eventId)` 排序并按 taskId 折叠，只要求 folded latest projection；成功后仍逐事件写入 processed，保留完整审计。ACK 要求 selected task 覆盖全部 pending，并扫描 STATUS+BACKLOG，拒绝旧新并存、同文件重复、跨文件重复和 only-old current block。
10. processed directory 是派生 state 的 source of truth。Snapshot 无锁只读协调全部合法 processed 事件并返回 `recoveryEvents`；ACK 先用协调后的 claims 与全部 pending 检查 WIP，要求 recovery IDs 全部进入投影与 ACK，成功后再从目录持久化完整 sorted IDs 与 active claims。
11. 增加 common-root two-phase ACK journal：全部校验通过后原子发布固定 schema intent，再依次移动 events、写协调 state、删除 intent、释放 owner。Snapshot 仅在 owner、branch、expected hashes 与合法 state phase 全匹配时暴露 `ack_intent` 恢复；intent 前、move 后、state 后崩溃均可用原参数幂等恢复，漂移和参数不匹配硬阻断。
12. ACK、release、recover 统一使用独占 lifecycle marker；acquire 在发布 owner 前后检查 marker。ACK 从入口持有 marker 到 journal/state 完成并在同一 lifecycle 内删除 owner，且在 journal、event move、state write 前重验 token，因此 release/recover/acquire 不能穿透 ACK 临界区，旧 ACK 也不能在替换 owner 下写 state。任何其他 lifecycle marker 无论 PID 是否存活都硬阻塞，当前操作只清理自己的 marker。
13. ACK journal 一经发布即冻结 eventIds 与 expected hashes。首次发布前仍以全部 pending 做 WIP 与 selected-task 完整性检查；恢复现有 journal 时只处理冻结事件，拒绝添加新 ID，journal 后到达的 pending 事件保留到下一轮 snapshot/project/ACK。

## TDD 证据

回归测试覆盖合法 lease 的 token 取回、canonical taskId、projection helper/CLI、完整来源与 HEAD 防伪、folded latest projection、部分 ACK 防倒退、唯一 current block、processed 审计历史、orphan state 协调、ACK journal 四个崩溃窗口与冻结边界、lifecycle 三操作互斥、owner 重验、严格 schema、漂移/身份/参数阻断、owner 保留、三 worktree 完整投影、证据降级、自由文本与 canonical path。每类修复均先用失败断言复现，再做最小实现。

## 验证

- `npm run test:project-manager`：77/77 PASS。
- `npm test`：exit 0，包含 Project Manager 77/77 与 Vite build。
- `npm run typecheck`：exit 0。
- `python3 /Users/xuxiaokang/.codex/skills/.system/skill-creator/scripts/quick_validate.py .codex/skills/dkagent-project-manager`：`Skill is valid!`。
- `node --check .codex/skills/dkagent-project-manager/scripts/project-events.mjs`：exit 0。
- `git diff --check`：exit 0，无输出。

## 风险与边界

- evidence 命令分类器有意保持窄白名单；未知 runner/脚本会拒绝，而不会猜测种类。
- canonical event projection 是最小 ACK 证明，不是通用 Markdown 渲染器；业务优先级仍由项目管家按 Skill 判断。
- 合法 owner 的身份或上下文无法确认时必须人工处理，不能用进程存活状态推断 lease 已结束。
- 本次未在 main 初始化真实共享状态，也未 merge 或 push。

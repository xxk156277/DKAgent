# 面试分析 SOP、Agent 节点与 Skill 编排

## 1. 当前可运行边界

```text
用户 ↔ AgentLoop → analyze_interview Tool → diagnose-transcript Skill
  ├─ find_files / read_file / write_file                 └─ 内部原子分析 Tool → LLM
  └─ 路径确认、元数据与可选 JD                                  └─ 暂定 Markdown 报告
```

| 层级 | 当前职责 | 当前不负责 |
|---|---|---|
| Agent | 根据提示词引导目录与关键词查找、展示绝对路径并等待确认；收集公司、岗位、日期、轮次和可选 JD | 不直接运行内部分析步骤，不计算分数，不写入面试 Memory |
| `analyze_interview` Tool | 校验文字稿/JD 的绝对路径与 JD 二选一；读取 JD 文件并启动 Skill；只返回精简摘要 | 不搜索文件，不暴露 Markdown、逐题列表或中间对象 |
| `diagnose-transcript` Skill | 固定顺序读取、结构化、逐题分析、生成报告并排他写入 | 不暂停恢复，不按用户补充局部重跑，不生成 final 报告 |
| 内部原子 Tool | 完成项目事实提取、逐题分析和报告生成 | 不决定后续调用顺序，不注册到公共 ToolRegistry |
| LLM | 在现有 Schema、Rubric 和证据校验内完成结构化及语义分析 | 不修改原稿，不决定工作流，不直接写文件、Session 或 Memory |

公共 ToolRegistry 当前只注册：`read_file`、`find_files`、`grep_files`、`write_file`、`analyze_interview`。`extract_project_facts`、`analyze_answer`、`generate_report` 只由 Skill 持有。

## 2. 已实现 SOP

1. 用户可给出完整路径，或“目录 + 文件名/关键词”。缺目录时 Agent 先询问，不能扫描整个用户目录；找到候选后最多展示 5 个绝对路径并等待确认。
2. 确认后，Agent 通过唯一业务入口提交文字稿路径、可选元数据和 JD。文字稿与 JD 路径必须为绝对路径，`jdText` 与 `jdPath` 不能同时传入。
3. Skill 使用分页 `read_file` 读完文字稿（默认每页 500 行），解析角色和原文位置，并直接基于原始轮次完成问题/问题簇结构化。
4. Skill 仅对项目问题簇提取项目事实；程序从每道题原回答计算表达统计，知识题可使用可选 FTS 参考资料，再由一次逐题 LLM 请求同时分析内容与表达。单题、项目事实和知识检索失败均按既有降级策略继续。
5. Skill 生成 `provisional` 两层报告；JD 存在时单独做证据受限的岗位匹配，不改变通用总分。报告以排他创建写在原稿同目录，发生同秒冲突时追加序号。
6. 业务 Tool 仅返回报告路径、水平说明、总分、已分析/总题数、待确认数和岗位匹配状态；完整 Markdown 与逐题结果只留在报告文件中。

## 3. 实现状态

- 已实现：Agent 文件查找与路径确认约束、`analyze_interview` 业务 Tool、`diagnose-transcript` Skill 顺序编排、可选 FTS 参考资料、元数据和 JD 岗位匹配、暂定报告落盘。
- 已验证：FakeProvider 完整链路覆盖超过 500 行的文字稿、项目题、知识题、流程题、单题降级、JD 证据校验与不覆盖写入。
- 尚未接入：用户事实确认后的局部重跑、`final` 最终报告、诊断 Session 暂停恢复、面试表现 Memory 时间线和文件上传接口。

当前 CLI 只有显式配置且文件存在的 `KNOWLEDGE_DATABASE_PATH` 才打开知识库并注入 FTS 检索；未配置、文件不存在或单次查询失败时，知识题按无参考资料继续。Skill 本身不创建知识库、Session 或 Memory。

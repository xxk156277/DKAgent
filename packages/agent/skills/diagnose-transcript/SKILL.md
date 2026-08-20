---
name: diagnose-transcript
description: 分析完整面试文字稿，生成有证据边界的逐题复盘、评分和 Markdown 报告。用户要求分析面试记录或复盘面试表现时使用。
---

# Diagnose Transcript

## 使用条件

- 用户要求分析、诊断或复盘完整面试文字稿时使用。
- 用户只要求查看、概括或回答文件内容时，不使用本 Skill。
- 必须使用用户已提供或已确认的文字稿路径，不得猜测路径。

## 工作流

1. 使用 `read_file` 读取完整文字稿。根据 `totalLines` 继续分页，直到 `endLine >= totalLines`。提供 JD 路径时以相同方式读取完整 JD。
2. 调用 `parse_transcript`，输入完整文字稿内容，得到原始 `transcript`。
3. 调用 `preprocess_transcript`，输入 `transcript`，得到 `corrections` 和 `correctedTurns`。失败时停止，不得跳过纠错后继续。
4. 调用 `structure_interview`，输入 `transcript` 和 `correctedTurns`，得到 `clusters`、`questions`、`nonQuestionTurnIds`。将它们与 `transcript`、`corrections` 合并为 `structuredInterview`。
5. 对包含项目题的每个问题簇调用 `extract_project_facts`。某个簇失败时，该簇不提供项目事实并继续后续问题。
6. 对每个非流程题调用 `analyze_expression`。流程题不调用该工具。
7. 对知识题，仅当运行时提供 `search_interview_reference` 时检索参考资料。能力不存在或检索失败时使用空参考资料，不得编造资料。
8. 对每个问题调用 `analyze_answer`。项目题传入同簇项目事实；非流程题传入对应表达分析；知识题传入检索结果。单题失败时保留 `{ status: "failed", questionId, clusterId, error }`，继续分析其他题。
9. 收集全部逐题结果后调用 `generate_report`，传入 `structuredInterview`、`analyses`、`projectFactSets`、`stage: "provisional"`、可选元数据和 JD 原文。
10. `generate_report` 成功即表示分析完成。直接向用户返回结论、待确认项和生成的 Markdown，不得再询问是否生成正式复盘报告。

## 保存规则

- 完成分析不等于保存文件，默认不得调用 `write_file`。
- 只有用户明确要求保存报告时，才调用 `write_file`。
- 保存时使用 `generate_report` 返回的完整 `markdown`，并设置 `overwrite: false`。
- 未获得明确保存要求时，不得声称已经创建报告文件。

## 失败边界

- 文件读取、解析、纠错、结构化或报告生成失败：停止并如实返回错误。
- 项目事实、知识检索或单题分析失败：按工作流降级，不得将失败包装成成功结论。
- 所有用户经历、分数、日期和项目事实必须来自文字稿、JD、工具结果或用户确认；缺少证据时标记为“不确定”或“待确认”。

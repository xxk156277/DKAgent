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

1. 调用 `read_file`，传入文字稿 `path` 和 `storeAsArtifact: true`，记录返回的 `artifactId` 为 `sourceArtifactId`。Artifact 模式一次读取完整文件，不得分页或复制正文。
2. 调用 `parse_transcript({ sourceArtifactId })`，记录返回的 `artifactId` 为 `transcriptArtifactId`。
3. 调用 `structure_interview({ transcriptArtifactId })`，记录返回的 `artifactId` 为 `structuredInterviewArtifactId`，并保留 `questionIds`。
4. 按 `questionIds` 顺序逐题调用 `analyze_answer({ structuredInterviewArtifactId, questionId })`。每次都收集返回的 `artifactId`；`completed`、`not_scored`、`failed` 都继续下一题。
5. 全部题目处理后，用户未要求保存时调用 `generate_report({ structuredInterviewArtifactId, analysisArtifactIds, stage: "provisional", returnDirectly: true })`；用户明确要求保存时传 `returnDirectly: false`。`analysisArtifactIds` 是上一步按题目顺序收集的全部 Artifact ID。不得复制问题、回答或分析 JSON。
6. `returnDirectly: true` 时，`generate_report` 成功即由宿主直接交付完整 Markdown；`returnDirectly: false` 时，必须完成 `write_file` 后再确认保存路径。不得再询问是否生成正式复盘报告。

## 保存规则

- 完成分析不等于保存文件，默认不得调用 `write_file`。
- 只有用户明确要求保存报告时，才调用 `write_file`。
- 保存时使用 `generate_report(returnDirectly: false)` 返回的完整 `markdown`，紧接着调用 `write_file`，并设置 `overwrite: false`。
- 未获得明确保存要求时，不得声称已经创建报告文件。

## 失败边界

- 文件读取、解析、结构化或报告生成失败：停止并如实返回错误。
- `analyze_answer` 返回 `status: "failed"`：保留其 `artifactId` 并继续；Tool 本身返回错误时停止并如实返回错误。
- 所有用户经历、分数和日期必须来自文字稿、工具结果或用户确认；缺少证据时标记为“不确定”或“待确认”。


当前 DKAgent 默认暴露 11 个 Tool；配置知识库后额外暴露 `search_interview_reference`。  
其中 4 个完全使用 LLM，2 个部分使用 LLM，其余为确定性程序能力。

| Tool                         | 功能                    | 输入 → 输出                                                                                            | 使用 LLM                            |
| ---------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------- |
| `read_file`                  | 分页读取 UTF-8 文本         | `path, offset?, limit?` → `content, startLine, endLine, totalLines`                                | 否                                 |
| `find_files`                 | 按 Glob 查找文件           | `pattern, path?, limit?` → 文件路径列表                                                                  | 否                                 |
| `grep_files`                 | 搜索文件内容                | `pattern, path?, glob?, limit?` → 路径、行号、匹配文本                                                       | 否                                 |
| `write_file`                 | 创建或覆盖文本文件             | `path, content, overwrite?` → `path, bytesWritten, overwritten`                                    | 否                                 |
| `parse_transcript`           | 将文字稿解析为说话轮次           | `content` → `ParsedTranscript`：原文和轮次                                                               | 否                                 |
| `preprocess_transcript`      | 识别高置信转写错误，不清理口头语      | `transcript` → `corrections, correctedTurns`                                                       | **是**                             |
| `structure_interview`        | 识别问题、回答、问题簇和流程题       | `transcript, correctedTurns` → `clusters, questions, nonQuestionTurnIds`                           | **是**                             |
| `extract_project_facts`      | 提取可回溯原文的项目事实          | `transcript, cluster, questions` → `ProjectFactSet`                                                | **是**                             |
| `analyze_expression`         | 统计口头语、重复、长句并判断理解影响    | `questionId, answer` → `ExpressionAnalysis`                                                        | **部分**：统计由程序完成，影响判断使用 LLM         |
| `search_interview_reference` | 为知识题检索参考资料；仅配置知识库后暴露  | `question` → `references[]`                                                                        | 否，使用本地知识库检索                       |
| `analyze_answer`             | 根据题型、证据、表达和参考资料分析单题   | `question, cluster, clusterQuestions, projectFacts?, expression, references?` → `QuestionAnalysis` | **是**；流程题直接返回，不调用 LLM             |
| `generate_report`            | 计算分数、汇总结果并渲染 Markdown | `structuredInterview, analyses, projectFactSets, stage, metadata?, jdText?` → `report, markdown`   | **部分**：评分和渲染由程序完成，总结及 JD 匹配使用 LLM |
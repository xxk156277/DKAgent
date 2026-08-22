// import { z } from "zod";
// import type {
//     ClarificationCandidate,
//     ProjectFact,
//     ProjectFactSet,
// } from "../../interview/analysis-types.js";
// import { queryModelJson } from "../../interview/model-json.js";
// import type {
//     InterviewQuestion,
//     ParsedTranscript,
//     QuestionCluster,
// } from "../../interview/types.js";
// import type { Tool } from "../types.js";
//
// const projectFactSchema = z.object({
//     localKey: z.string().trim().min(1),
//     category: z.enum([
//         "background",
//         "responsibility",
//         "decision",
//         "implementation",
//         "metric",
//         "result",
//     ]),
//     value: z.string().nullable(),
//     status: z.enum(["stated", "inferred", "unknown"]),
//     evidenceTurnIds: z.array(z.string().min(1)),
//     evidenceQuote: z.string().nullable(),
//     affectedQuestionIds: z.array(z.string().min(1)),
//     clarificationQuestion: z.string().nullable(),
//     impact: z.enum(["high", "medium", "low"]),
// }).strict();
//
// const projectFactsSchema = z.object({
//     facts: z.array(projectFactSchema),
// }).strict();
//
// export interface ExtractProjectFactsInput {
//     transcript: ParsedTranscript;
//     cluster: QuestionCluster;
//     questions: InterviewQuestion[];
// }
//
// function sameMembers(left: string[], right: string[]): boolean {
//     const sortedLeft = [...left].sort();
//     const sortedRight = [...right].sort();
//     return sortedLeft.length === sortedRight.length
//         && sortedLeft.every((value, index) => value === sortedRight[index]);
// }
//
// function hasText(value: string | null): value is string {
//     return Boolean(value?.trim());
// }
//
// function validateFacts(input: {
//     facts: ProjectFact[];
//     allowedEvidenceTurnIds: Set<string>;
//     allowedQuestionIds: Set<string>;
//     candidateContentByTurnId: Map<string, string>;
// }): void {
//     const factKeys = input.facts.map((fact) => fact.key);
//     if (new Set(factKeys).size !== factKeys.length) {
//         throw new Error("事实键重复或冲突");
//     }
//
//     for (const fact of input.facts) {
//         if (fact.affectedQuestionIds.some((id) => !input.allowedQuestionIds.has(id))) {
//             throw new Error(`事实引用了当前问题簇外的问题: ${fact.key}`);
//         }
//         if (fact.evidenceTurnIds.some((id) => !input.allowedEvidenceTurnIds.has(id))) {
//             throw new Error(`事实引用了非候选人回答轮次: ${fact.key}`);
//         }
//
//         if (
//             fact.status === "stated"
//             && (!hasText(fact.value) || !fact.evidenceTurnIds.length || !hasText(fact.evidenceQuote))
//         ) {
//             throw new Error(`明确事实必须有值、候选人轮次和逐字证据: ${fact.key}`);
//         }
//         if (
//             fact.status === "unknown"
//             && (
//                 fact.value !== null
//                 || fact.evidenceTurnIds.length
//                 || fact.evidenceQuote !== null
//                 || !hasText(fact.clarificationQuestion)
//             )
//         ) {
//             throw new Error(`未知事实必须没有值和证据，并给出澄清问题: ${fact.key}`);
//         }
//         if (
//             fact.status === "inferred"
//             && (
//                 !hasText(fact.value)
//                 || !fact.evidenceTurnIds.length
//                 || !hasText(fact.evidenceQuote)
//                 || !hasText(fact.clarificationQuestion)
//             )
//         ) {
//             throw new Error(`推断事实必须有值、候选人轮次、逐字证据和澄清问题: ${fact.key}`);
//         }
//         if (
//             fact.status !== "unknown"
//             && hasText(fact.evidenceQuote)
//             && !fact.evidenceTurnIds.some((turnId) => (
//                 input.candidateContentByTurnId.get(turnId)?.includes(fact.evidenceQuote!)
//             ))
//         ) {
//             throw new Error(`逐字证据无法回到候选人原文: ${fact.key}`);
//         }
//         if (
//             fact.status === "stated"
//             && hasText(fact.value)
//             && hasText(fact.evidenceQuote)
//             && !fact.evidenceQuote.includes(fact.value)
//         ) {
//             throw new Error(`stated value 必须逐字来自 evidenceQuote: ${fact.key}`);
//         }
//     }
// }
//
// function buildClarificationCandidates(facts: ProjectFact[]): ClarificationCandidate[] {
//     return facts.flatMap((fact) => (
//         (fact.status === "unknown" || fact.status === "inferred")
//         && hasText(fact.clarificationQuestion)
//             ? [{
//                 factKey: fact.key,
//                 question: fact.clarificationQuestion,
//                 affectedQuestionIds: fact.affectedQuestionIds,
//                 impact: fact.impact,
//             }]
//             : []
//     ));
// }
//
// export function createExtractProjectFactsTool(
//     model: string,
// ): Tool<ExtractProjectFactsInput, ProjectFactSet> {
//     return {
//         name: "extract_project_facts",
//         description: "从单个项目问题簇提取可回溯到候选人原文的项目事实。",
//         parameters: {
//             type: "object",
//             properties: {
//                 transcript: { type: "object", description: "原始解析面试稿" },
//                 cluster: { type: "object", description: "当前项目问题簇" },
//                 questions: { type: "array", description: "结构化面试问题" },
//             },
//             required: ["transcript", "cluster", "questions"],
//             additionalProperties: false,
//         },
//         async execute(input, ctx) {
//             try {
//                 const clusterQuestions = input.questions.filter(
//                     (question) => question.clusterId === input.cluster.id,
//                 );
//                 const clusterQuestionIds = clusterQuestions.map((question) => question.id);
//                 if (!sameMembers(input.cluster.questionIds, clusterQuestionIds)) {
//                     throw new Error(`问题簇与输入问题不一致: ${input.cluster.id}`);
//                 }
//
//                 const turnById = new Map(input.transcript.turns.map((turn) => [turn.id, turn]));
//                 const allowedEvidenceTurnIds = new Set(
//                     clusterQuestions.flatMap((question) => question.answerTurnIds),
//                 );
//                 for (const turnId of allowedEvidenceTurnIds) {
//                     if (turnById.get(turnId)?.speaker !== "candidate") {
//                         throw new Error(`问题回答不是候选人轮次: ${turnId}`);
//                     }
//                 }
//
//                 const response = await queryModelJson({
//                     queryEngine: ctx.queryEngine,
//                     model,
//                     abortSignal: ctx.abortSignal,
//                     tracer: ctx.tracer,
//                     traceOperation: "extract_project_facts",
//                     schema: projectFactsSchema,
//                     systemPrompt: [
//                         "从当前项目问题簇提取事实，严格输出 JSON。",
//                         "每条事实只返回当前簇内的 localKey（如 role、metric），不得返回完整 key；代码会添加 clusterId 命名空间。",
//                         "stated 只表示候选人在原文明确陈述，不代表外部真实性已确认。",
//                         "不得根据常识补全职责、指标、上线范围或项目结果。",
//                         "unknown 的 value 必须为 null；所有证据只能引用输入中的候选人 turnId。",
//                         "stated 和 inferred 必须给出 evidenceQuote，且逐字复制自所引用的候选人轮次；unknown 的 evidenceQuote 必须为 null。",
//                         "stated 的 value 必须是 evidenceQuote 的逐字子串；任何语义概括都必须标为 inferred。",
//                         "inferred 仅用于有候选人证据但仍需澄清的推断；不确定时用 unknown。",
//                     ].join("\n"),
//                     userContent: JSON.stringify({
//                         cluster: {
//                             id: input.cluster.id,
//                             title: input.cluster.title,
//                             keyNamespace: `${input.cluster.id}.`,
//                         },
//                         questions: clusterQuestions.map((question) => ({
//                             id: question.id,
//                             originalQuestion: question.originalQuestion,
//                             originalAnswer: question.originalAnswer,
//                             candidateTurns: question.answerTurnIds.map((turnId) => ({
//                                 id: turnId,
//                                 content: turnById.get(turnId)?.content,
//                             })),
//                         })),
//                     }),
//                 });
//                 const facts: ProjectFact[] = response.facts.map(({ localKey, ...fact }) => ({
//                     ...fact,
//                     key: `${input.cluster.id}.${localKey}`,
//                 }));
//                 validateFacts({
//                     facts,
//                     allowedEvidenceTurnIds,
//                     allowedQuestionIds: new Set(input.cluster.questionIds),
//                     candidateContentByTurnId: new Map(
//                         [...allowedEvidenceTurnIds].map((turnId) => [
//                             turnId,
//                             turnById.get(turnId)!.content,
//                         ]),
//                     ),
//                 });
//
//                 return {
//                     success: true,
//                     data: {
//                         clusterId: input.cluster.id,
//                         facts,
//                         clarificationCandidates: buildClarificationCandidates(facts),
//                     },
//                 };
//             } catch (error) {
//                 return {
//                     success: false,
//                     error: {
//                         code: "service_error",
//                         message: error instanceof Error ? error.message : "项目事实提取失败",
//                     },
//                 };
//             }
//         },
//     };
// }

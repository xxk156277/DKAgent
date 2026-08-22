// import type { InterviewReferenceRetriever } from "../../skills/interview-reference-retriever.js";
// import type { Tool } from "../types.js";
//
// export interface SearchInterviewReferenceInput {
//     question: string;
// }
//
// export interface SearchInterviewReferenceOutput {
//     references: string[];
// }
//
// export function createSearchInterviewReferenceTool(
//     retriever: InterviewReferenceRetriever,
// ): Tool<SearchInterviewReferenceInput, SearchInterviewReferenceOutput> {
//     return {
//         name: "search_interview_reference",
//         description: "为知识类面试题检索可用的参考资料；没有结果时返回空数组。",
//         parameters: {
//             type: "object",
//             properties: {
//                 question: { type: "string", description: "需要检索参考资料的面试问题原文" },
//             },
//             required: ["question"],
//             additionalProperties: false,
//         },
//         async execute(input) {
//             if (!input.question?.trim()) {
//                 return {
//                     success: false,
//                     error: { code: "input_error", message: "面试问题不能为空" },
//                 };
//             }
//             try {
//                 return {
//                     success: true,
//                     data: { references: await retriever.search(input.question) },
//                 };
//             } catch (error) {
//                 return {
//                     success: false,
//                     error: {
//                         code: "service_error",
//                         message: error instanceof Error ? error.message : "面试参考资料检索失败",
//                     },
//                 };
//             }
//         },
//     };
// }

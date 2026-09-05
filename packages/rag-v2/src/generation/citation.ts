import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, Output } from "ai";
import { z } from "zod";
import type { EvidenceBundle } from "./context.js";

const CitationVerificationSchema = z.object({
    citationSupported: z.boolean(),
    unsupportedClaims: z.array(z.string()),
    coveredFactIndexes: z.array(z.number().int().nonnegative()),
});

/** 语义引用验证结果；它来自模型裁判，不等同于人工真值。 */
export interface CitationVerification {
    citationSupported: boolean;
    unsupportedClaims: string[];
    coveredFactIndexes: number[];
}

/** 校验答案至少引用一个现有来源，且不存在越界编号。 */
export function hasValidCitations(answer: string, sourceCount: number): boolean {
    const references = [...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    return references.length > 0 && references.every((value) => value >= 1 && value <= sourceCount);
}

/** 去重并过滤模型返回的越界 expected fact 序号。 */
export function normalizeCitationVerification(
    value: CitationVerification,
    expectedFactCount: number,
): CitationVerification {
    return {
        citationSupported: value.citationSupported,
        unsupportedClaims: value.unsupportedClaims,
        coveredFactIndexes: [...new Set(value.coveredFactIndexes)]
            .filter((index) => index < expectedFactCount)
            .sort((left, right) => left - right),
    };
}

/** 使用结构化模型输出判断答案结论是否被其引用证据支持。 */
export async function verifyCitationSupport(input: {
    query: string;
    answer: string;
    evidence: EvidenceBundle;
    expectedFacts?: string[] | undefined;
    generation: { apiKey: string; baseUrl: string; model: string };
}): Promise<{
    verification: CitationVerification;
    usage: { inputTokens?: number | undefined; outputTokens?: number | undefined; totalTokens?: number | undefined };
}> {
    const provider = createOpenAICompatible({
        name: "deepseek-citation-verifier",
        apiKey: input.generation.apiKey,
        baseURL: input.generation.baseUrl,
    });
    const expectedFacts = input.expectedFacts ?? [];
    const result = await generateText({
        model: provider(input.generation.model),
        temperature: 0,
        output: Output.object({ schema: CitationVerificationSchema }),
        system: [
            "你是保守的 RAG 证据审查器。",
            "逐项检查答案中的事实性结论是否被结论后引用的 [n] 资料直接支持。",
            "引用编号合法但资料没有对应事实，或关键事实没有引用，都视为不支持。",
            "不要使用外部知识，不要因为结论看起来正确就判为支持。",
            "coveredFactIndexes 只填写答案已覆盖的 expectedFacts 下标；没有 expectedFacts 时返回空数组。",
        ].join("\n"),
        prompt: [
            `问题：${input.query}`,
            `草稿答案：\n${input.answer}`,
            `编号资料：\n${input.evidence.text}`,
            `expectedFacts（仅用于评估覆盖率，不用于改写答案）：\n${expectedFacts
                .map((fact, index) => `${index}: ${fact}`)
                .join("\n")}`,
        ].join("\n\n"),
    });
    return {
        verification: normalizeCitationVerification(result.output, expectedFacts.length),
        usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
        },
    };
}

import type { KnowledgeSearch } from "../knowledge/search.js";
import type { InterviewReferenceRetriever } from "./interview-reference-retriever.js";

export function createKnowledgeReferenceRetriever(
    search: KnowledgeSearch,
): InterviewReferenceRetriever {
    return {
        async search(question) {
            const results = await search.search({ query: question, method: "fts", limit: 3 });
            return results.map((result) => result.entry.expertAnswer || result.entry.content);
        },
    };
}

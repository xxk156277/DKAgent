import type { ExpressionStats } from "./analysis-types.js";

const FILLER_WORDS = ["嗯", "呃", "额", "然后", "就是", "那个"] as const;

function countOccurrences(text: string, word: string): number {
    let count = 0;
    let fromIndex = 0;
    while (fromIndex < text.length) {
        const index = text.indexOf(word, fromIndex);
        if (index < 0) break;
        count += 1;
        fromIndex = index + word.length;
    }
    return count;
}

function countAdjacentRepetitions(text: string): number {
    let count = 0;
    let index = 0;
    while (index < text.length) {
        let matched = false;
        for (let size = 1; size <= 6 && index + size * 2 <= text.length; size += 1) {
            const chunk = text.slice(index, index + size);
            if (chunk === text.slice(index + size, index + size * 2)) {
                count += 1;
                index += size * 2;
                matched = true;
                break;
            }
        }
        if (!matched) index += 1;
    }
    return count;
}

export function collectExpressionStats(answer: string): ExpressionStats {
    const fillerWords = FILLER_WORDS.flatMap((word) => {
        const count = countOccurrences(answer, word);
        return count ? [{ word, count }] : [];
    });
    const sentences = answer
        .split(/[。！？!?]/)
        .filter((sentence) => sentence.trim().length > 0);

    return {
        fillerWords,
        fillerCount: fillerWords.reduce((total, item) => total + item.count, 0),
        adjacentRepetitionCount: countAdjacentRepetitions(answer),
        characterCount: answer.replace(/\s/g, "").length,
        sentenceCount: sentences.length,
        longSentenceCount: sentences.filter(
            (sentence) => sentence.replace(/\s/g, "").length > 120,
        ).length,
    };
}

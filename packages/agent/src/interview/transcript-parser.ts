import type { InterviewSpeaker, ParsedTranscript, TranscriptTurn } from "./types.js";

const HEADING =
    /^(?<label>面试官|求职者|候选人|发言人\s*[12])(?:\s+(?<time>\d{1,2}:\d{2}(?::\d{2})?))?\s*(?:[：:]\s*(?<inline>.*))?$/;

function toSpeaker(label: string): InterviewSpeaker {
    return /^(?:面试官|发言人\s*1)$/.test(label) ? "interviewer" : "candidate";
}

export function parseTranscript(source: string): ParsedTranscript {
    const lines = source.match(/.*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
    const turns: TranscriptTurn[] = [];
    let offset = 0;
    let previousEndingLength = 0;
    let current: Omit<TranscriptTurn, "id" | "sourceEnd"> | undefined;

    const closeCurrent = (end: number): void => {
        if (!current) return;
        turns.push({
            ...current,
            id: `turn-${String(turns.length + 1).padStart(4, "0")}`,
            content: current.content.trimEnd(),
            sourceEnd: end,
        });
    };

    for (const rawLine of lines) {
        const endingLength = rawLine.endsWith("\r\n") ? 2 : /[\r\n]$/.test(rawLine) ? 1 : 0;
        const line = endingLength ? rawLine.slice(0, -endingLength) : rawLine;
        const match = line.match(HEADING);

        if (match?.groups?.label) {
            closeCurrent(offset - previousEndingLength);
            const label = match.groups.label.replace(/\s+/g, " ");
            const timestamp = match.groups.time;
            current = {
                speaker: toSpeaker(label),
                speakerLabel: label,
                ...(timestamp ? { timestamp } : {}),
                content: match.groups.inline || "",
                sourceStart: offset,
            };
        } else if (current) {
            current.content += `${current.content ? "\n" : ""}${line}`;
        }

        offset += rawLine.length;
        previousEndingLength = endingLength;
    }

    closeCurrent(source.length - previousEndingLength);
    if (turns.length === 0) {
        throw new Error("没有识别到说话人标题");
    }

    return { source, turns };
}

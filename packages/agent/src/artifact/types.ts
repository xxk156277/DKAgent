export type ArtifactKind =
    | "file_text"
    | "parsed_transcript"
    | "structured_interview"
    | "question_analysis";

export interface ArtifactMetadata {
    producer: string;
    characterCount?: number;
    itemCount?: number;
    exposedCharacterCount?: number;
}

export interface ArtifactStore {
    put<T>(kind: ArtifactKind, value: T, metadata: ArtifactMetadata): string;
    get<T>(id: string, expectedKind: ArtifactKind, consumer: string): T;
}

export class ArtifactAccessError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "ArtifactAccessError";
    }
}

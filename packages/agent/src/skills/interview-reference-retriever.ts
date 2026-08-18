export interface InterviewReferenceRetriever {
    search(question: string): Promise<string[]>;
}

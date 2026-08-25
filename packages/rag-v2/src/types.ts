export interface ImageReference {
  kind: "markdown" | "obsidian";
  target: string;
  alt?: string;
}

export interface ParentDocument {
  id: string;
  sourcePath: string;
  title: string;
  content: string;
  contentHash: string;
  frontmatter: Record<string, unknown>;
  modifiedAt: Date;
}

export interface ChildChunk {
  id: string;
  parentId: string;
  sourcePath: string;
  headingPath: string[];
  headingOrdinal: number;
  splitIndex: number;
  content: string;
  contentHash: string;
  imageRefs: ImageReference[];
  needsVision: boolean;
}

export interface ParsedDocument {
  parent: ParentDocument;
  chunks: ChildChunk[];
}

export interface SearchHit {
  parentId: string;
  sourcePath: string;
  documentTitle: string;
  chunkId: string;
  headingPath: string[];
  content: string;
  similarity: number;
  needsVision: boolean;
}

export interface Citation {
  index: number;
  sourcePath: string;
  headingPath: string[];
}

export interface IngestReport {
  scannedFiles: number;
  indexedDocuments: number;
  unchangedDocuments: number;
  deletedDocuments: number;
  skippedFiles: Array<{ path: string; reason: string }>;
  chunksEmbedded: number;
  embeddingTokens?: number;
  durationMs: number;
}

export interface EvaluationQuestion {
  query: string;
  relevantSourcePaths: string[];
  expectedFacts: string[];
  shouldRefuse: boolean;
}

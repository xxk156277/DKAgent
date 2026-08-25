import type { TraceReader } from "@dkagent/trace";

interface SessionSummarySource {
  id: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionSnapshotSource extends SessionSummarySource {
  messages: unknown[];
  contextState: { summary: string };
}

export interface SessionSource {
  list(): SessionSummarySource[];
  load(sessionId: string): SessionSnapshotSource | null;
}

export interface TapSessionSummary extends SessionSummarySource {
  preview: string;
  messageCount: number;
  turnCount: number;
  hasTrace: boolean;
}

export interface TapSessionDetail extends SessionSummarySource {
  messages: unknown[];
  contextSummary: string;
}

export interface TapSessionReader {
  list(): TapSessionSummary[];
  load(sessionId: string): TapSessionDetail | null;
}

/** 把 Agent Session 的真实状态投影为 Tap 专用只读字段。 */
export function createTapSessionReader(
  sessions: SessionSource,
  traces: TraceReader,
): TapSessionReader {
  return {
    list() {
      return sessions.list().flatMap((summary) => {
        const snapshot = sessions.load(summary.id);
        if (!snapshot) return [];
        const userMessages = snapshot.messages.filter(isUserMessage);
        return [{
          ...summary,
          preview: firstUserContent(userMessages) ?? "未命名对话",
          messageCount: snapshot.messages.length,
          turnCount: userMessages.length,
          hasTrace: traces.hasTraceForSession(summary.id),
        }];
      });
    },
    load(sessionId) {
      const snapshot = sessions.load(sessionId);
      return snapshot ? {
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        messages: snapshot.messages,
        contextSummary: snapshot.contextState.summary,
      } : null;
    },
  };
}

function isUserMessage(value: unknown): value is { role: "user"; content?: unknown } {
  return isRecord(value) && value.role === "user";
}

function firstUserContent(messages: { content?: unknown }[]): string | undefined {
  const content = messages.find((message) => (
    typeof message.content === "string" && message.content.trim().length > 0
  ))?.content;
  return typeof content === "string" ? content.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

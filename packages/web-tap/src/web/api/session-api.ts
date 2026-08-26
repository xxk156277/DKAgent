import type { TraceEvent } from "@dkagent/trace";

export interface TapSessionSummary {
    id: string;
    createdAt: string;
    updatedAt: string;
    preview: string;
    messageCount: number;
    turnCount: number;
    hasTrace: boolean;
}

export interface TapSessionDetail {
    id: string;
    createdAt: string;
    updatedAt: string;
    messages: unknown[];
    contextSummary: string;
}

type FetchLike = (url: string) => Promise<Pick<Response, "ok" | "status" | "json">>;

export class SessionApiError extends Error {
    public constructor(
        message: string,
        public readonly status: number,
    ) {
        super(message);
    }
}

export async function loadSessions(fetchImpl: FetchLike = globalThis.fetch): Promise<TapSessionSummary[]> {
    return readJson<TapSessionSummary[]>(await fetchImpl("/api/sessions"));
}

export async function loadSessionBundle(
    sessionId: string,
    fetchImpl: FetchLike = globalThis.fetch,
): Promise<{ session: TapSessionDetail; events: TraceEvent[] }> {
    const encodedId = encodeURIComponent(sessionId);
    const [sessionResponse, eventsResponse] = await Promise.all([
        fetchImpl(`/api/sessions/${encodedId}`),
        fetchImpl(`/api/sessions/${encodedId}/events`),
    ]);
    return {
        session: await readJson<TapSessionDetail>(sessionResponse),
        events: await readJson<TraceEvent[]>(eventsResponse),
    };
}

async function readJson<T>(response: Pick<Response, "ok" | "status" | "json">): Promise<T> {
    const value = await response.json();
    if (response.ok) return value as T;
    const message = isRecord(value) && typeof value.error === "string" ? value.error : "Tap 读取失败";
    throw new SessionApiError(message, response.status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

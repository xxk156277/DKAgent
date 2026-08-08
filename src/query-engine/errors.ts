import Anthropic from 'anthropic';

export type ErrorCategory =
    | 'rate_limit'      // 429，应该等待后重试
    | 'overloaded'      // 529/503，服务过载，退避重试
    | 'timeout'         // 请求超时，可重试
    | 'network'         // 网络错误，可重试
    | 'invalid_request' // 400，参数错误，不可重试
    | 'auth'            // 401/403，鉴权失败，不可重试
    | 'context_length'  // 上下文超长，需要压缩后重试
    | 'unknown';        // 未知错误

export class QueryEngineError extends Error {
    constructor(
        message: string,
        public category: ErrorCategory,
        public retryable: boolean,
        public retryAfterMs?: number,
    ) {
        super(message);
    }
}

export function classifyError(err: any): QueryEngineError {
    if (err instanceof Anthropic.RateLimitError) {
        const retryAfter = parseInt(err.headers?.['retry-after'] ?? '5') * 1000;
        return new QueryEngineError('Rate limited', 'rate_limit', true, retryAfter);
    }

    if (err instanceof Anthropic.APIStatusError) {
        if (err.status === 529) {
            return new QueryEngineError('Overloaded', 'overloaded', true, 10000);
        }
        if (err.status === 400) {
            return new QueryEngineError(err.message, 'invalid_request', false);
        }
        if (err.status === 401) {
            return new QueryEngineError('Auth failed', 'auth', false);
        }
    }

    if (err instanceof Error && err.message.includes('timeout')) {
        return new QueryEngineError('Timeout', 'timeout', true, 3000);
    }

    return new QueryEngineError(String(err), 'unknown', false);
}
import type { QueryEngineError } from './errors.js';
import { classifyError } from './errors.js';

export interface RetryConfig {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
};

export async function withRetry<T>(
    fn: () => Promise<T>,
    config: RetryConfig = DEFAULT_RETRY_CONFIG,
): Promise<T> {
    let lastError: QueryEngineError | undefined;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const classified = classifyError(err);

            if (!classified.retryable || attempt === config.maxRetries) {
                throw classified;
            }

            lastError = classified;
            const delay = classified.retryAfterMs ??
                Math.min(
                    config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt),
                    config.maxDelayMs,
                );

            await sleep(delay);
        }
    }

    throw lastError;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
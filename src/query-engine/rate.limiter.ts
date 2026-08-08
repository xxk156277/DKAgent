export class TokenBucketLimiter {
    private tokens: number;
    private lastRefill: number;
    private queue: Array<{ resolve: () => void }> = [];

    constructor(
        private maxTokens: number,        // 桶容量
        private refillRate: number,       // 每秒补充多少
    ) {
        this.tokens = maxTokens;
        this.lastRefill = Date.now();
    }

    async acquire(): Promise<void> {
        this.refill();

        if (this.tokens >= 1) {
            this.tokens -= 1;
            return;
        }

        // 桶空了，排队等待
        return new Promise(resolve => {
            this.queue.push({ resolve });
            setTimeout(() => this.processQueue(), 1000 / this.refillRate);
        });
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;
    }

    private processQueue(): void {
        this.refill();
        while (this.tokens >= 1 && this.queue.length > 0) {
            this.tokens -= 1;
            this.queue.shift()!.resolve();
        }
    }
}

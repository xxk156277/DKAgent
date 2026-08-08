import type { TokenUsage } from './provider.js';

export interface TokenBudget {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxTotalCost: number;     // 单位：美元
    spent: {
        inputTokens: number;
        outputTokens: number;
        totalCost: number;
        requests: number;
    };
}

export class TokenCounter {
    private budget: TokenBudget;

    constructor(budget: Partial<TokenBudget> = {}) {
        this.budget = {
            maxInputTokens: budget.maxInputTokens ?? 500_000,
            maxOutputTokens: budget.maxOutputTokens ?? 100_000,
            maxTotalCost: budget.maxTotalCost ?? 1.0,
            spent: { inputTokens: 0, outputTokens: 0, totalCost: 0, requests: 0 },
        };
    }

    record(usage: TokenUsage, provider: string): void {
        this.budget.spent.inputTokens += usage.inputTokens;
        this.budget.spent.outputTokens += usage.outputTokens;
        this.budget.spent.totalCost += this.calculateCost(usage, provider);
        this.budget.spent.requests += 1;
    }

    checkBudget(): { ok: boolean; reason?: string } {
        if (this.budget.spent.totalCost >= this.budget.maxTotalCost) {
            return { ok: false, reason: `Cost limit reached: $${this.budget.spent.totalCost.toFixed(4)}` };
        }
        if (this.budget.spent.inputTokens >= this.budget.maxInputTokens) {
            return { ok: false, reason: 'Input token limit reached' };
        }
        return { ok: true };
    }

    getSummary(): string {
        const { spent } = this.budget;
        return `Requests: ${spent.requests} | Tokens: ${spent.inputTokens}in + ${spent.outputTokens}out | Cost: $${spent.totalCost.toFixed(4)}`;
    }

    private calculateCost(usage: TokenUsage, provider: string): number {
        const pricing: Record<string, { input: number; output: number }> = {
            claude: { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
            openai: { input: 2.5 / 1_000_000, output: 10.0 / 1_000_000 },
            deepseek: { input: 0.27 / 1_000_000, output: 1.10 / 1_000_000 },
        };
        const p = pricing[provider] ?? pricing.claude;
        return usage.inputTokens * p.input + usage.outputTokens * p.output;
    }
}
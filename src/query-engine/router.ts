export interface RouteRule {
    task: string;              // 任务标识
    provider: string;          // provider name
    model: string;             // 模型 id
    reason: string;            // 路由原因（debug 用）
}

const DEFAULT_ROUTES: RouteRule[] = [
    { task: 'diagnose_content', provider: 'claude', model: 'claude-sonnet-4-20250514', reason: '需要深度分析能力' },
    { task: 'diagnose_expression', provider: 'claude', model: 'claude-sonnet-4-20250514', reason: '需要语言理解能力' },
    { task: 'generate_report', provider: 'claude', model: 'claude-sonnet-4-20250514', reason: '长文本生成' },
    { task: 'knowledge_summary', provider: 'deepseek', model: 'deepseek-chat', reason: '轻量摘要，成本低' },
    { task: 'split_qa', provider: 'deepseek', model: 'deepseek-chat', reason: '结构化拆分，简单任务' },
    { task: 'cross_validate', provider: 'openai', model: 'gpt-4o', reason: '多模型交叉验证，避免单一偏差' },
    { task: 'embedding', provider: 'openai', model: 'text-embedding-3-small', reason: '向量化' },
];

export class ModelRouter {
    private rules: RouteRule[];

    constructor(rules?: RouteRule[]) {
        this.rules = rules ?? DEFAULT_ROUTES;
    }

    resolve(task: string): { provider: string; model: string } {
        const rule = this.rules.find(r => r.task === task);
        if (!rule) {
            // 默认走 Claude
            return { provider: 'claude', model: 'claude-sonnet-4-20250514' };
        }
        return { provider: rule.provider, model: rule.model };
    }
}
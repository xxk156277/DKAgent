// skills/types.ts
import type { ToolRegistry } from '../tools/registry.js';
import type { QueryEngine } from '../query-engine/queryEngine.js';

// skill 定义
export interface Skill {
    name: string;
    description: string;
    triggers: string[];          // 触发关键词
    requiredTools: string[];     // 依赖的 tools
    execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput>;
}

// skill 输入输出定义
export interface SkillInput {
    // 用户原始输入
    rawInput: string;
    // 可选的解析参数，通常由模型解析用户输入后生成
    parsedArgs?: Record<string, unknown>;
}

// skill 上下文
export interface SkillContext {
    // 工具集
    toolRegistry: ToolRegistry;
    // 模型调用引擎
    queryEngine: QueryEngine;
    // 
    // session: Session;
    // 
    // hooks: HookPipeline;
}

// skill 输出定义
export interface SkillOutput {
    success: boolean;
    result?: unknown;
    report?: string;             // 可直接输出给用户的文本
    error?: string;
}
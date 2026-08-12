import type { AnyTool, ToolSchema } from "./types.js";

export class ToolRegistry {
    private readonly tools = new Map<string, AnyTool>();

    register(tool: AnyTool): void {
        if (this.tools.has(tool.name)) {
            throw new Error(`工具 ${tool.name} 已经注册`);
        }
        this.tools.set(tool.name, tool);
    }

    resolve(name: string): AnyTool {
        const tool = this.tools.get(name);
        if (!tool) throw new Error(`未找到工具: ${name}`);
        return tool;
    }

    getSchemas(): ToolSchema[] {
        return [...this.tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        }));
    }

    list(): Array<{ name: string; description: string }> {
        return [...this.tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
        }));
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }
}

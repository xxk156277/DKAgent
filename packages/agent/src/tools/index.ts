import { ToolRegistry } from "./registry.js";
import { splitQaTool } from "./tool-item/split.js";

export function createToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(splitQaTool);
    return registry;
}

import { createFindFilesTool } from "./filesystem/find-files.js";
import { createGrepFilesTool } from "./filesystem/grep-files.js";
import { createReadFileTool } from "./filesystem/read-file.js";
import { createWriteFileTool } from "./filesystem/write-file.js";
import { ToolRegistry } from "./registry.js";
import { splitQaTool } from "./tool-item/split.js";

export function createToolRegistry(cwd = process.cwd()): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(splitQaTool);
    registry.register(createReadFileTool(cwd));
    registry.register(createFindFilesTool(cwd));
    registry.register(createGrepFilesTool(cwd));
    registry.register(createWriteFileTool(cwd));
    return registry;
}

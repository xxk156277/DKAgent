import { fileURLToPath } from "node:url";
import type { SkillMetadata } from "./types.js";

export function createSkillRegistry(): SkillMetadata[] {
    return [{
        name: "diagnose-transcript",
        description: "分析完整面试文字稿，生成有证据边界的逐题复盘、评分和 Markdown 报告。用户要求分析面试记录或复盘面试表现时使用。",
        location: fileURLToPath(
            new URL("../../skills/diagnose-transcript/SKILL.md", import.meta.url),
        ),
    }];
}

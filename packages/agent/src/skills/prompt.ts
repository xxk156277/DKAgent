import type { SkillMetadata } from "./types.js";

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

export function formatAvailableSkills(skills: SkillMetadata[]): string {
    if (!skills.length) return "";

    return [
        "以下 Skill 提供按需加载的知识或工作流。",
        "任务与 Skill 描述匹配时，先使用 read_file 读取完整 Skill 文件，再按照其中的步骤工作；不得仅凭摘要猜测流程。",
        "<available_skills>",
        ...skills.flatMap((skill) => [
            "  <skill>",
            `    <name>${escapeXml(skill.name)}</name>`,
            `    <description>${escapeXml(skill.description)}</description>`,
            `    <location>${escapeXml(skill.location)}</location>`,
            "  </skill>",
        ]),
        "</available_skills>",
    ].join("\n");
}

export function appendAvailableSkills(
    systemPrompt: string,
    skills: SkillMetadata[],
): string {
    const block = formatAvailableSkills(skills);
    return block ? `${systemPrompt}\n\n${block}` : systemPrompt;
}

import { Tag } from "antd";
import type { TapModuleKind } from "../model/types.js";

const modulePresentation: Record<TapModuleKind, { color: string; label: string }> = {
  session: { color: "geekblue", label: "会话" },
  context: { color: "blue", label: "上下文" },
  memory: { color: "purple", label: "记忆" },
  skill: { color: "cyan", label: "技能" },
  tool: { color: "gold", label: "工具" },
  model: { color: "magenta", label: "模型" },
  agent: { color: "default", label: "Agent" },
  other: { color: "default", label: "其他" },
};

export function ModuleTag({ module }: { module: TapModuleKind }) {
  const presentation = modulePresentation[module];
  return (
    <Tag className="tap-module-tag" color={presentation.color} variant="filled">
      {presentation.label}
    </Tag>
  );
}

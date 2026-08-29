import { Tag } from "antd";
import type { TapModuleKind } from "../model/types.js";

const modulePresentation: Record<TapModuleKind, { color: string; label: string }> = {
  context: { color: "blue", label: "上下文" },
  memory: { color: "purple", label: "记忆" },
  artifact: { color: "green", label: "产物" },
  tool: { color: "gold", label: "工具" },
  model: { color: "magenta", label: "模型" },
  agent: { color: "default", label: "Agent" },
};

export function ModuleTag({ module }: { module: TapModuleKind }) {
  const presentation = modulePresentation[module];
  return (
    <Tag className="tap-module-tag" color={presentation.color} variant="filled">
      {presentation.label}
    </Tag>
  );
}

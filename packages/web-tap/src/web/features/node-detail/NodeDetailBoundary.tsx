import { Alert, Card } from "antd";
import { Component, type ReactNode } from "react";
import type { TapNodeView } from "../../model/types.js";

interface NodeDetailBoundaryProps {
  node: TapNodeView | undefined;
  children: ReactNode;
}

interface NodeDetailBoundaryState {
  failed: boolean;
}

/** 仅隔离选中节点详情，避免单个异常数据拖垮左右导航。 */
export class NodeDetailBoundary extends Component<NodeDetailBoundaryProps, NodeDetailBoundaryState> {
  state: NodeDetailBoundaryState = { failed: false };

  static getDerivedStateFromError(): NodeDetailBoundaryState {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="tap-node-detail" aria-label="节点详情异常">
        <Alert
          type="error"
          showIcon
          title="节点详情展示失败"
          description="该节点包含无法正常渲染的数据，已保留左右导航并展示安全的原始 JSON。"
        />
        <Card className="tap-data-card" size="small" title="安全原始 JSON">
          <pre className="tap-json-block">{safeJsonStringify(this.props.node?.rawEvents ?? [])}</pre>
        </Card>
      </section>
    );
  }
}

/** 循环引用、BigInt 或异常 getter 都只能影响 JSON 内容，不能让 fallback 再次抛错。 */
function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, current) => {
      if (typeof current === "bigint") return `${current.toString()}n`;
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
      }
      return current;
    }, 2) ?? String(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知序列化错误";
    return JSON.stringify({ serializationError: message }, null, 2);
  }
}

import Markdown from "react-markdown";

/** 仅解析 Markdown；react-markdown 默认不会执行内容中的原始 HTML。 */
export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="tap-markdown-content">
      <Markdown>{content}</Markdown>
    </div>
  );
}

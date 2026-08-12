import { App as AntdApp, Button, Collapse } from "antd";

interface RawJsonProps {
  rawEvents: unknown[];
}

/** 原始事件默认收起；复制失败只提示，不影响当前详情。 */
export function RawJson({ rawEvents }: RawJsonProps) {
  const { message } = AntdApp.useApp();
  const json = JSON.stringify(rawEvents, null, 2);
  const copyJson = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(json);
    } catch {
      void message.error("复制失败，请检查剪贴板权限");
    }
  };

  return (
    <Collapse
      className="tap-raw-json"
      items={[{
        key: "raw",
        label: "原始 JSON",
        children: (
          <div className="tap-json-panel">
            <Button htmlType="button" onClick={() => void copyJson()}>复制 JSON</Button>
            <pre className="tap-json-block">{json}</pre>
          </div>
        ),
      }]}
    />
  );
}

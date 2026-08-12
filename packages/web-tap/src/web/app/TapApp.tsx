import { Collapse, Descriptions, Empty, Layout, Typography } from "antd";
import { useEffect } from "react";
import { connectEventFeed } from "../api/event-feed.js";
import { tapStore, useTapStore } from "../store/tap-store.js";

const { Content, Sider } = Layout;

/**
 * TAP 三栏入口；生命周期仅在顶层建立一次事件连接。
 */
export function TapApp() {
  const connectionStatus = useTapStore((state) => state.connectionStatus);

  useEffect(() => connectEventFeed(tapStore), []);

  return (
    <Layout className="tap-app">
      <Sider className="tap-sidebar" theme="light" width={280}>
        <aside aria-labelledby="turn-list-heading">
          <Typography.Title id="turn-list-heading" level={2}>
            对话轮次
          </Typography.Title>
          <Typography.Text aria-live="polite" type="secondary">
            连接状态：{connectionStatus}
          </Typography.Text>
          <Empty description="暂无对话轮次" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </aside>
      </Sider>

      <Content className="tap-content">
        <main aria-labelledby="node-detail-heading">
          <Typography.Title id="node-detail-heading" level={2}>
            节点详情
          </Typography.Title>
          <Descriptions
            bordered
            column={1}
            items={[
              { key: "selection", label: "当前节点", children: "尚未选择节点" },
            ]}
          />
          <Collapse
            className="tap-node-payload"
            items={[
              {
                key: "payload",
                label: "节点数据",
                children: <Empty description="暂无节点数据" />,
              },
            ]}
          />
        </main>
      </Content>

      <Sider className="tap-sidebar" theme="light" width={320}>
        <aside aria-labelledby="node-navigation-heading">
          <Typography.Title id="node-navigation-heading" level={2}>
            节点导航
          </Typography.Title>
          <Empty description="暂无可导航节点" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </aside>
      </Sider>
    </Layout>
  );
}

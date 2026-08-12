import { App as AntdApp, ConfigProvider } from "antd";
import { createRoot } from "react-dom/client";

import { TapApp } from "./app/TapApp.js";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("TAP root element is missing");
}

createRoot(rootElement).render(
  <ConfigProvider>
    <AntdApp>
      <TapApp />
    </AntdApp>
  </ConfigProvider>,
);

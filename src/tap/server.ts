import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TapRecorder } from "./recorder.js";
import { VIEWER_HTML } from "./viewer.js";

export interface TapServerHandle {
  url: string;
  close(): Promise<void>;
}

/** 启动只读 Tap Viewer；所有观测端异常都与 Agent 主流程隔离。 */
export async function startTapServer(options: {
  recorder: TapRecorder;
  host?: string;
  port?: number;
}): Promise<TapServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const clients = new Set<ServerResponse>();
  const unsubscribe = options.recorder.subscribe((event) => {
    let frame: string;
    try {
      frame = `data: ${JSON.stringify(event)}\n\n`;
    } catch {
      // 非序列化事件不能让 Tap 订阅者破坏 Agent。
      return;
    }
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  });
  const server = createServer((request, response) => {
    void handleRequest(request.url, response, options.recorder, clients);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port ?? 4319, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host}:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => {
      unsubscribe();
      for (const client of clients) client.end();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

/** HTTP 读取失败仅返回 500，不传播到宿主 Agent 进程。 */
async function handleRequest(
  url: string | undefined,
  response: ServerResponse,
  recorder: TapRecorder,
  clients: Set<ServerResponse>,
): Promise<void> {
  try {
    if (url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(VIEWER_HTML);
      return;
    }
    if (url === "/api/events") {
      const events = await recorder.readEvents();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(events));
      return;
    }
    if (url === "/api/events/stream") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.flushHeaders();
      clients.add(response);
      response.once("close", () => clients.delete(response));
      response.once("error", () => clients.delete(response));
      return;
    }
    response.writeHead(404).end();
  } catch {
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Tap Viewer 读取失败" }));
  }
}

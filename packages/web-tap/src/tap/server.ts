import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { TraceStore } from "@dkagent/trace";
import type { TapSessionReader } from "./session-reader.js";

export interface TapServerHandle {
  url: string;
  close(): Promise<void>;
}

/** 启动只读 Tap Viewer；所有观测端异常都与 Agent 主流程隔离。 */
export async function startTapServer(options: {
  store: TraceStore;
  sessions?: TapSessionReader;
  webRoot: string;
  host?: string;
  port?: number;
}): Promise<TapServerHandle> {
  if (options.host !== undefined && options.host !== "127.0.0.1") {
    throw new Error("Tap Viewer 仅支持监听 127.0.0.1");
  }
  const host = "127.0.0.1";
  const clients = new Set<ServerResponse>();
  const unsubscribe = options.store.subscribe((event) => {
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
  let server: ReturnType<typeof createServer> | undefined;

  try {
    const webRoot = await validateWebRoot(options.webRoot);
    server = createServer((request, response) => {
      void handleRequest(
        request.url,
        response,
        options.store,
        options.sessions,
        clients,
        webRoot,
      );
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server?.once("error", onError);
      server?.listen(options.port ?? 4319, host, () => {
        server?.off("error", onError);
        resolve();
      });
    });
  } catch (error: unknown) {
    // 启动失败时撤销 Tap 订阅，但保留 reject 给组合根处理。
    unsubscribe();
    throw error;
  }
  // 此处已经完成监听，server 必然存在。
  if (!server) throw new Error("Tap Viewer 启动失败");
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
  store: TraceStore,
  sessions: TapSessionReader | undefined,
  clients: Set<ServerResponse>,
  webRoot: string,
): Promise<void> {
  try {
    const pathname = new URL(url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/api/events") {
      sendJson(response, 200, store.list());
      return;
    }
    if (pathname === "/api/events/stream") {
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
    if (pathname === "/api/sessions") {
      sendJson(response, 200, sessions?.list() ?? []);
      return;
    }
    const sessionEventsMatch = /^\/api\/sessions\/([^/]+)\/events$/u.exec(pathname);
    if (sessionEventsMatch) {
      const sessionId = decodeURIComponent(sessionEventsMatch[1] ?? "");
      sendJson(response, 200, store.list().filter((event) => event.sessionId === sessionId));
      return;
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)$/u.exec(pathname);
    if (sessionMatch) {
      const session = sessions?.load(decodeURIComponent(sessionMatch[1] ?? ""));
      if (!session) {
        sendJson(response, 404, { error: "Session 不存在" });
        return;
      }
      sendJson(response, 200, session);
      return;
    }
    if (pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "接口不存在" });
      return;
    }
    const file = await resolveStaticFile(pathname, webRoot)
      ?? (isPageRoute(pathname) ? join(webRoot, "index.html") : undefined);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": contentTypeFor(file) });
    response.end(await readFile(file));
  } catch {
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Tap Viewer 读取失败" }));
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function isPageRoute(pathname: string): boolean {
  return !pathname.startsWith("/api/") && extname(pathname) === "";
}

/** 启动前验证构建产物，失败时由组合根降级到 Agent-only。 */
async function validateWebRoot(webRoot: string): Promise<string> {
  const canonicalRoot = await realpath(resolve(webRoot));
  const rootStats = await stat(canonicalRoot);
  if (!rootStats.isDirectory()) throw new Error("Tap Viewer webRoot 不是目录");

  const indexPath = await realpath(join(canonicalRoot, "index.html"));
  if (!isWithinRoot(canonicalRoot, indexPath) || !(await stat(indexPath)).isFile()) {
    throw new Error("Tap Viewer 缺少 index.html");
  }
  await access(indexPath, constants.R_OK);
  return canonicalRoot;
}

/** 解码后拒绝 `..`，并用 realpath 阻断指向 webRoot 外部的符号链接。 */
async function resolveStaticFile(url: string | undefined, webRoot: string): Promise<string | undefined> {
  if (!url) return undefined;
  const rawPath = url.split("?", 1)[0] ?? "";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  if (decodedPath.includes("\0") || decodedPath.split(/[\\/]+/u).includes("..")) return undefined;

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const candidate = resolve(webRoot, relativePath);
  if (!isWithinRoot(webRoot, candidate)) return undefined;

  try {
    const canonicalFile = await realpath(candidate);
    if (!isWithinRoot(webRoot, canonicalFile)) return undefined;
    return (await stat(canonicalFile)).isFile() ? canonicalFile : undefined;
  } catch {
    return undefined;
  }
}

function isWithinRoot(webRoot: string, candidate: string): boolean {
  const pathFromRoot = relative(webRoot, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function contentTypeFor(file: string): string {
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  return contentTypes[extname(file).toLowerCase()] ?? "application/octet-stream";
}

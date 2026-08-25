import "dotenv/config";
import { SqliteTraceStore, Tracer } from "@dkagent/trace";
import { createInterface } from "node:readline";
// import { existsSync } from "node:fs";
import { AgentLoop } from "../agent/loop.js";
import { AGENT_SYSTEM_PROMPT } from "../agent/prompt.js";
import { loadConfig } from "../config.js";
import {
    Compressor,
    ContextManager,
    ProviderTokenCounter,
} from "../context/index.js";
import { OpenAICompatibleProvider } from "../query-engine/providers/openai-compatible.js";
import { QueryEngine } from "../query-engine/query-engine.js";
import {
    SqliteSessionStore,
    type SessionSnapshot,
    type SessionStore,
} from "../session/index.js";
import {
    SqliteMemoryStore,
    type MemoryType,
} from "../memory/index.js";
import { createToolRegistry } from "../tools/index.js";
import { InMemoryArtifactStore, type ArtifactStore } from "../artifact/index.js";
// import {
//     KnowledgeRepository,
//     KnowledgeSearch,
//     openKnowledgeDatabase,
// } from "../knowledge/index.js";
// import { createKnowledgeReferenceRetriever } from "../skills/knowledge-reference-retriever.js";
import { appendAvailableSkills } from "../skills/prompt.js";
import { createSkillRegistry } from "../skills/registry.js";
import { createSafePrompt } from "./safe-prompt.js";

/**
 * 原始命令行 Agent 入口；观测能力仅通过可选端口注入，核心无需依赖 Tap。
 */
export async function runAgentCli(options: {
    tracer?: Tracer;
    sessionStore?: SessionStore;
    artifactStoreFactory?: () => ArtifactStore;
} = {}): Promise<void> {
    const config = loadConfig();
    const provider = new OpenAICompatibleProvider(config.apiKey, config.baseURL);
    // const knowledgeDatabase = config.knowledgeDatabasePath
    //     && existsSync(config.knowledgeDatabasePath)
    //     ? openKnowledgeDatabase(config.knowledgeDatabasePath)
    //     : undefined;
    // const referenceRetriever = knowledgeDatabase
    //     ? createKnowledgeReferenceRetriever(
    //         new KnowledgeSearch(new KnowledgeRepository(knowledgeDatabase)),
    //     )
    //     : undefined;
    const toolRegistry = createToolRegistry({
        model: config.model,
        // ...(referenceRetriever ? { referenceRetriever } : {}),
    });
    const systemPrompt = appendAvailableSkills(
        AGENT_SYSTEM_PROMPT,
        createSkillRegistry(),
    );
    let memoryStore: SqliteMemoryStore;
    try {
        memoryStore = new SqliteMemoryStore(".dkagent/memory.db");
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Memory 数据库初始化失败：${message}`);
    }
    let ownedSessionStore: SqliteSessionStore | undefined;
    let sessionStore = options.sessionStore;
    if (!sessionStore) {
        try {
            ownedSessionStore = new SqliteSessionStore(".dkagent/sessions.db");
            sessionStore = ownedSessionStore;
        } catch (error: unknown) {
            try {
                memoryStore.close();
            } catch {
                // Session 初始化失败时，Memory 关闭失败不能掩盖原始错误。
            }
            throw error;
        }
    }
    let ownedTraceStore: SqliteTraceStore | undefined;
    let tracer = options.tracer;
    if (!tracer) {
        try {
            ownedTraceStore = new SqliteTraceStore(".dkagent/sessions.db");
            tracer = new Tracer(ownedTraceStore, {
                onWriteError: () => console.warn("DKAgent Trace 写入失败，本轮业务继续运行。"),
            });
        } catch {
            console.warn("DKAgent Trace 初始化失败，将继续运行 Agent。");
            tracer = new Tracer();
        }
    }
    const queryEngine = new QueryEngine(provider, tracer);
    // 摘要复用统一 QueryEngine；Compressor 不直接依赖具体 Provider。
    const compressor = new Compressor(queryEngine);
    const contextManager = new ContextManager(new ProviderTokenCounter(provider), compressor);
    try {
    // Demo 阶段暂时下线自动 Memory 召回/提取/写入；手动 Memory 命令继续可用。
    const artifactStores = new Map<string, ArtifactStore>();
    const getOrCreateArtifactStore = (sessionId: string): ArtifactStore => {
        const existingStore = artifactStores.get(sessionId);
        if (existingStore) return existingStore;

        const artifactStore = options.artifactStoreFactory?.()
            ?? new InMemoryArtifactStore(tracer);
        artifactStores.set(sessionId, artifactStore);
        return artifactStore;
    };

    const createAgent = (
        snapshot: SessionSnapshot
    ): AgentLoop => {
        return new AgentLoop({
            queryEngine,
            toolRegistry,
            contextManager,
            model: config.model,
            maxContextTokens: config.maxContextTokens,
            maxOutputTokens: config.maxOutputTokens,
            contextCompaction: config.contextCompaction,
            summaryModel: config.summaryModel,
            maxSteps: 12,
            systemPrompt,
            onTextDelta: (text) => process.stdout.write(text),
            tracer,
            session: {
                snapshot,
                store: sessionStore,
            },
            artifactStore: getOrCreateArtifactStore(snapshot.id),
        });
    }


    const restored = sessionStore.loadLatest();
    let currentSession = restored ?? sessionStore.create();
    let agent = createAgent(currentSession);

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const startupMessage = restored
        ? `DKAgent 已恢复 Session ${currentSession.id}，输入 /new 创建新会话。`
        : `DKAgent 已创建 Session ${currentSession.id}，输入自然语言开始对话。`;
    console.log(`${startupMessage}\n`);
    readline.setPrompt("> ");
    const prompt = createSafePrompt(readline);
    prompt();

    // 在提示符处按 Ctrl+C 时优雅退出：结束 readline 输入循环，
    // 循环结束后由 finally 统一调用 sessionStore.close() 保存并关闭数据库。
    readline.on("SIGINT", () => {
        readline.close();
    });

        for await (const input of readline) {
            const userInput = input.trim();
            if (!userInput) {
                prompt();
                continue;
            }
            if (userInput === "/new") {
                currentSession = sessionStore.create();
                agent = createAgent(currentSession);
                console.log(`已创建 Session ${currentSession.id}\n`);
                prompt();
                continue;
            }
            if (userInput === "/sessions") {
                const sessions = sessionStore.list();
                const lines = sessions.map((session) => {
                    const marker = session.id === currentSession.id ? "*" : " ";
                    return `${marker} ${session.id}  ${session.updatedAt}`;
                });
                console.log(`${lines.join("\n")}\n`);
                prompt();
                continue;
            }

            if (userInput === "/switch" || /^\/switch\s/.test(userInput)) {
                const sessionId = userInput.slice("/switch".length).trim();
                if (!sessionId) {
                    console.log("用法：/switch <sessionId>\n");
                    prompt();
                    continue;
                }
                if (sessionId === currentSession.id) {
                    console.log(`已经是当前 Session ${sessionId}\n`);
                    prompt();
                    continue;
                }

                const snapshot = sessionStore.load(sessionId);
                if (!snapshot) {
                    console.log(`Session ${sessionId} 不存在\n`);
                    prompt();
                    continue;
                }

                const nextAgent = createAgent(snapshot);
                currentSession = snapshot;
                agent = nextAgent;
                console.log(`已切换到 Session ${sessionId}\n`);
                prompt();
                continue;
            }

            if (userInput === "/delete" || /^\/delete\s/.test(userInput)) {
                const sessionId = userInput.slice("/delete".length).trim();
                if (!sessionId) {
                    console.log("用法：/delete <sessionId>\n");
                    prompt();
                    continue;
                }
                if (sessionId === currentSession.id) {
                    console.log("不能删除当前 Session，请先执行 /new 或 /switch。\n");
                    prompt();
                    continue;
                }
                if (!sessionStore.delete(sessionId)) {
                    console.log(`Session ${sessionId} 不存在\n`);
                    prompt();
                    continue;
                }
                artifactStores.delete(sessionId);

                console.log(`已删除 Session ${sessionId}\n`);
                prompt();
                continue;
            }

            if (/^\/remember(?:\s|$)/.test(userInput)) {
                const match = /^\/remember\s+(\S+)\s+(\S+)\s+(.+)$/.exec(userInput);
                const [, type, key, content] = match ?? [];
                if (!type || !key || !content) {
                    console.log(
                        "用法：/remember <profile|preference|decision> <key> <content>\n",
                    );
                    prompt();
                    continue;
                }

                try {
                    const memory = memoryStore.upsert({
                        type: type as MemoryType,
                        key,
                        content,
                        source: "explicit",
                        sourceSessionId: currentSession.id,
                    });
                    console.log(`已保存 Memory ${memory.id}\n`);
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.log(`Memory 操作失败：${message}\n`);
                }
                prompt();
                continue;
            }

            if (/^\/memories(?:\s|$)/.test(userInput)) {
                if (userInput !== "/memories") {
                    console.log("用法：/memories\n");
                    prompt();
                    continue;
                }
                try {
                    const memories = memoryStore.list();
                    if (memories.length === 0) {
                        console.log("暂无 Memory\n");
                    } else {
                        console.log(`${memories.map((memory) => (
                            `[${memory.type}] ${memory.key} = ${memory.content} (${memory.source}, ${memory.id})`
                        )).join("\n")}\n`);
                    }
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.log(`Memory 操作失败：${message}\n`);
                }
                prompt();
                continue;
            }

            if (/^\/forget(?:\s|$)/.test(userInput)) {
                const [, memoryId, ...extra] = userInput.split(/\s+/);
                if (!memoryId || extra.length > 0) {
                    console.log("用法：/forget <memoryId>\n");
                    prompt();
                    continue;
                }

                try {
                    if (memoryStore.delete(memoryId)) {
                        console.log(`已删除 Memory ${memoryId}\n`);
                    } else {
                        console.log(`Memory ${memoryId} 不存在\n`);
                    }
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.log(`Memory 操作失败：${message}\n`);
                }
                prompt();
                continue;
            }

            try {
                await tracer.withSession(
                    currentSession.id,
                    () => agent.run(userInput),
                );
                process.stdout.write("\n\n");
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`\nAgent 运行失败：${message}\n`);
            }
            prompt();
        }
    } finally {
        let closeError: unknown;
        try {
            memoryStore.close();
        } catch (error: unknown) {
            closeError = error;
        }
        if (ownedTraceStore) {
            try {
                ownedTraceStore.close();
            } catch {
                console.warn("DKAgent Trace 关闭失败，Session 与业务结果不受影响。");
            }
        }
        if (ownedSessionStore) {
            try {
                ownedSessionStore.close();
            } catch (error: unknown) {
                closeError ??= error;
            }
        }
        // try {
        //     knowledgeDatabase?.close();
        // } catch (error: unknown) {
        //     closeError ??= error;
        // }
        if (closeError) throw closeError;
    }
}

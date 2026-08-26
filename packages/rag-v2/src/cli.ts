#!/usr/bin/env node
/**
 * RAG v2 命令行入口
 *
 * 支持 db:migrate / ingest / search / inspect / stats / evaluate / ask 子命令，
 * 负责装配配置、数据库与 Embedding 服务，并把参数分发到对应业务模块。
 */
import path from "node:path";
import { inspect } from "node:util";
import { config, requireSecret } from "./config.js";
import { EmbeddingService } from "./embedding/embedding.js";
import { evaluateRetrieval, readEvaluationQuestions } from "./evaluation/evaluate.js";
import { askKnowledgeBase } from "./generation/ask.js";
import { ingestKnowledgeBase } from "./ingestion/ingest.js";
import { searchKnowledge } from "./retrieval/search.js";
import { formatCliError } from "./shared/errors.js";
import { RagDatabase } from "./storage/database.js";

/** 打印命令帮助信息。 */
function printHelp(): void {
    console.log(`大康 Note RAG

用法：
  pnpm rag db:migrate
  pnpm rag ingest
  pnpm rag search "问题" [--top-k 3]
  pnpm rag inspect --document <id或相对路径>
  pnpm rag inspect --chunk <id>
  pnpm rag stats
  pnpm rag evaluate [JSONL路径]
  pnpm rag ask "问题"
`);
}

/** 读取形如 `--name value` 的旗标参数值。 */
function readFlag(args: string[], name: string): string | undefined {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

/** 把非旗标的参数拼接为查询文本（支持含空格的提问）。 */
function readQuery(args: string[]): string {
    return args
        .filter((value, index) => !value.startsWith("--") && !args[index - 1]?.startsWith("--"))
        .join(" ")
        .trim();
}

/** 按配置创建 Embedding 服务（校验必填的 SILICONFLOW_API_KEY）。 */
function createEmbedding(): EmbeddingService {
    return new EmbeddingService(
        {
            apiKey: requireSecret(config.embedding.apiKey, "SILICONFLOW_API_KEY"),
            baseUrl: config.embedding.baseUrl,
            model: config.embedding.model,
        },
        config.embedding.dimensions,
        /**
         * CLI 主入口：解析子命令并分发执行，最后统一关闭数据库连接。
         */
    );
}

async function main(): Promise<void> {
    const [command, ...args] = process.argv.slice(2);

    if (!command || command === "help" || command === "--help") {
        printHelp();
        return;
    }
    const database = new RagDatabase(config.databaseUrl);
    try {
        if (command === "db:migrate") {
            await database.migrate();
            console.log("数据库迁移完成：vector 扩展、父子表和 HNSW 索引已就绪。");
            return;
        }
        if (command === "ingest") {
            await database.migrate();
            const report = await ingestKnowledgeBase({
                database,
                embedding: createEmbedding(),
                vaultPath: config.vaultPath,
                sourceGlobs: config.sourceGlobs,
            });
            console.log(JSON.stringify(report, null, 2));
            return;
        }
        if (command === "search") {
            const topK = Number(readFlag(args, "--top-k") ?? 3);
            const query = readQuery(args);
            if (!query) throw new Error("search 需要问题文本");
            const result = await searchKnowledge({ database, embedding: createEmbedding(), query, topK });
            console.log(
                `Top-${topK}，耗时 ${result.durationMs}ms，Embedding tokens=${result.embeddingTokens ?? "未知"}`,
            );
            result.hits.forEach((hit, index) => {
                console.log(`\n${index + 1}. ${hit.sourcePath}#${hit.headingPath.join(" > ") || "全文"}`);
                console.log(`   similarity=${hit.similarity.toFixed(4)} needsVision=${hit.needsVision}`);
                console.log(`   ${hit.content.replace(/\s+/g, " ").slice(0, 240)}`);
            });
            return;
        }
        if (command === "inspect") {
            const documentId = readFlag(args, "--document");
            const chunkId = readFlag(args, "--chunk");
            if (!documentId && !chunkId) throw new Error("inspect 需要 --document 或 --chunk");
            const document = documentId
                ? await database.getDocument(documentId)
                : await database.getDocumentByChunk(chunkId!);
            if (!document) throw new Error("没有找到对应文档或子块");
            console.log(inspect(document, { depth: 6, colors: true, maxStringLength: 1200 }));
            return;
        }
        if (command === "stats") {
            console.log(JSON.stringify(await database.stats(), null, 2));
            return;
        }
        if (command === "evaluate") {
            const evaluationPath = path.resolve(args[0] ?? path.join(config.packageRoot, "eval/questions.jsonl"));
            const questions = await readEvaluationQuestions(evaluationPath);
            const report = await evaluateRetrieval({ database, embedding: createEmbedding(), questions });
            console.log(JSON.stringify(report, null, 2));
            return;
        }
        if (command === "ask") {
            const query = readQuery(args);
            if (!query) throw new Error("ask 需要问题文本");
            const result = await askKnowledgeBase({
                database,
                embedding: createEmbedding(),
                query,
                generation: {
                    apiKey: requireSecret(config.generation.apiKey, "DEEPSEEK_API_KEY"),
                    baseUrl: config.generation.baseUrl,
                    model: config.generation.model,
                },
                minSimilarity: config.minSimilarity,
            });
            console.log(result.answer);
            console.log(`\n耗时：${result.durationMs}ms`);
            console.log(`调用量：${JSON.stringify(result.usage)}`);
            console.log("检索来源：");
            result.hits.forEach((hit, index) =>
                console.log(
                    `[${index + 1}] ${hit.sourcePath}#${hit.headingPath.join(" > ") || "全文"} (${hit.similarity.toFixed(4)})`,
                ),
            );
            return;
        }
        throw new Error(`未知命令：${command}`);
    } finally {
        await database.close();
    }
}

main().catch((error) => {
    console.error(formatCliError(error));
    process.exitCode = 1;
});

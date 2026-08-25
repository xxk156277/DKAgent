import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
dotenv.config({ path: path.join(repositoryRoot, ".env"), quiet: true });

const defaultVault =
  "/Users/xuxiaokang/Library/Mobile Documents/iCloud~md~obsidian/Documents/大康note";

const EnvSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://rag:rag@localhost:5438/rag"),
  RAG_VAULT_PATH: z.string().default(defaultVault),
  SILICONFLOW_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().default("https://api.siliconflow.cn/v1"),
  EMBEDDING_MODEL: z.string().default("BAAI/bge-m3"),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().default("https://api.deepseek.com/v1"),
  DEEPSEEK_MODEL: z.string().default("deepseek-chat"),
  RAG_MIN_SIMILARITY: z.coerce.number().min(-1).max(1).optional(),
});

const env = EnvSchema.parse(process.env);

export const config = {
  packageRoot,
  repositoryRoot,
  databaseUrl: env.DATABASE_URL,
  vaultPath: env.RAG_VAULT_PATH,
  sourceGlobs: [
    "C-前端学习/**/*.md",
    "CICD/**/*.md",
    "个人Agent项目/**/*.md",
    "学习笔记/**/*.md",
  ],
  embedding: {
    apiKey: env.SILICONFLOW_API_KEY,
    baseUrl: env.EMBEDDING_BASE_URL,
    model: env.EMBEDDING_MODEL,
    dimensions: 1024,
  },
  generation: {
    apiKey: env.DEEPSEEK_API_KEY,
    baseUrl: env.DEEPSEEK_BASE_URL,
    model: env.DEEPSEEK_MODEL,
  },
  minSimilarity: env.RAG_MIN_SIMILARITY,
} as const;

export function requireSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`缺少 ${name}，请在仓库根目录 .env 中配置`);
  return value;
}

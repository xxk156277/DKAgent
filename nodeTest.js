import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseMarkdownDocument } from "./packages/rag-v2/src/parser";

const fsPath = path.join(process.cwd(), "packages/rag-v2/LEARNING.md");

async function test() {
    const content = await readFile(fsPath);
    const statData = await stat(fsPath);
    const content_utf8 = await readFile(fsPath, "utf-8");
    const content_base64 = await readFile(fsPath, "base64");
    console.log(statData);
    console.log(content + "\n");
    console.log(content_utf8 + "\n");
    console.log(content_base64 + "\n");
    const parsed = parseMarkdownDocument(absolutePath, vaultRoot, content, stat.mtime);
}

test();

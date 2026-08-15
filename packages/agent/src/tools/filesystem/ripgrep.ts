import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { rgPath } from "@vscode/ripgrep";

const execFile = promisify(execFileCallback);
const MAX_BUFFER = 10 * 1024 * 1024;

export async function runRipgrep(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
    try {
        const { stdout } = await execFile(rgPath, args, {
            cwd,
            signal,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER,
        });
        return stdout;
    } catch (error) {
        const result = error as { code?: number; stdout?: string };
        if (result.code === 1) return result.stdout ?? "";
        throw error;
    }
}

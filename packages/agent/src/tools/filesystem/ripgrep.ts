import { execFile } from "node:child_process";

export interface RipgrepResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export function runRipgrep(
    args: string[],
    cwd: string,
    signal: AbortSignal,
): Promise<RipgrepResult> {
    return new Promise((resolve, reject) => {
        execFile(
            "rg",
            args,
            { cwd, encoding: "utf8", maxBuffer: 1024 * 1024, signal },
            (error, stdout, stderr) => {
                if (!error) {
                    resolve({ stdout, stderr, exitCode: 0 });
                    return;
                }
                const code = (error as Error & { code?: string | number }).code;
                if (code === 1 || code === "1") {
                    resolve({ stdout, stderr, exitCode: 1 });
                    return;
                }
                reject(error);
            },
        );
    });
}

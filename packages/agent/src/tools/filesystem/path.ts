import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function resolveToolPath(inputPath: string, cwd: string): string {
    if (inputPath === "~") return homedir();
    if (inputPath.startsWith("~/")) return resolve(join(homedir(), inputPath.slice(2)));
    return isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
}

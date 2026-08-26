import { rm } from "node:fs/promises";

type RemoveRunRoot = (runRoot: string) => Promise<void>;

const removeRunRoot = (runRoot: string): Promise<void> => (
  rm(runRoot, { recursive: true, force: true })
);

let cleanupOverride: RemoveRunRoot | undefined;

export async function cleanupRunRoot(runRoot: string): Promise<void> {
  await (cleanupOverride ?? removeRunRoot)(runRoot);
}

export function setCleanupForTest(override: RemoveRunRoot | undefined): void {
  cleanupOverride = override;
}

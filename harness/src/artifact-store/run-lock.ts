import { type FileHandle, open, readFile, rm } from "node:fs/promises";
import { canonicalJson } from "./canonical.js";
import { isNodeError, resolveRunPath } from "./path-policy.js";
import { StoreError } from "./store-error.js";

interface LockOwner {
  readonly pid: number;
  readonly created_at: string;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

async function removeStaleLock(filename: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(filename, "utf8")) as Partial<LockOwner>;
    if (typeof owner.pid === "number" && processExists(owner.pid)) {
      return false;
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return true;
    }
  }
  await rm(filename, { force: true });
  return true;
}

export async function withRunLock<T>(runRoot: string, action: () => Promise<T>): Promise<T> {
  const filename = await resolveRunPath(runRoot, ".store/write.lock", { createParents: true });
  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(filename, "wx", 0o600);
      break;
    } catch (error) {
      if (!isNodeError(error, "EEXIST") || !(await removeStaleLock(filename))) {
        throw new StoreError("run.write_locked", "another writer owns the Run", {});
      }
    }
  }
  if (!handle) {
    throw new StoreError("run.write_locked", "could not acquire Run writer lock", {});
  }
  try {
    const owner: LockOwner = { pid: process.pid, created_at: new Date().toISOString() };
    await handle.writeFile(`${canonicalJson(owner)}\n`, "utf8");
    await handle.sync();
    return await action();
  } finally {
    await handle.close();
    await rm(filename, { force: true });
  }
}

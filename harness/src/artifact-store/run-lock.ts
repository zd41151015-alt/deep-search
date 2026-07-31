import { randomUUID } from "node:crypto";
import { link, open, readFile, rm } from "node:fs/promises";
import { canonicalJson, operationKey, sha256Hex } from "./canonical.js";
import { isNodeError, prepareRunsRoot, resolveRunPath, validateRunId } from "./path-policy.js";
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

async function withLock<T>(
  runRoot: string,
  lockPath: string,
  errorCode: string,
  action: () => Promise<T>,
): Promise<T> {
  const filename = await resolveRunPath(runRoot, lockPath, { createParents: true });
  const temporary = await resolveRunPath(
    runRoot,
    `.store/temp/lock-${process.pid}-${randomUUID()}.tmp`,
    { createParents: true },
  );
  const owner: LockOwner = { pid: process.pid, created_at: new Date().toISOString() };
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalJson(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(temporary, filename);
        acquired = true;
        break;
      } catch (error) {
        if (!isNodeError(error, "EEXIST") || !(await removeStaleLock(filename))) {
          throw new StoreError(errorCode, "another writer owns the Run operation", {});
        }
      }
    }
    if (!acquired) {
      throw new StoreError(errorCode, "could not acquire Run operation lock", {});
    }
    await rm(temporary, { force: true });
    return await action();
  } finally {
    await rm(temporary, { force: true });
    if (acquired) {
      await rm(filename, { force: true });
    }
  }
}

export async function withRunLock<T>(runRoot: string, action: () => Promise<T>): Promise<T> {
  return withLock(runRoot, ".store/write.lock", "run.write_locked", action);
}

export async function withRunCreationLock<T>(
  runsRoot: string,
  runId: string,
  action: (validatedRunsRoot: string) => Promise<T>,
): Promise<T> {
  validateRunId(runId);
  const root = await prepareRunsRoot(runsRoot);
  const lockId = sha256Hex(operationKey("create_run_lock", { run_id: runId }));
  return withLock(root, `.create-locks/${lockId}.lock`, "run.create_locked", () => action(root));
}

export async function withReportLock<T>(runRoot: string, action: () => Promise<T>): Promise<T> {
  return withLock(runRoot, ".store/report.write.lock", "report.write_locked", action);
}

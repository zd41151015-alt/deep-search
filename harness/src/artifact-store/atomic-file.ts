import { type FileHandle, link, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isNodeError, resolveRunPath } from "./path-policy.js";
import { StoreError } from "./store-error.js";

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeSyncedTemp(
  runRoot: string,
  relativePath: string,
  contents: string | Uint8Array,
): Promise<string> {
  const filename = await resolveRunPath(runRoot, relativePath, { createParents: true });
  let handle: FileHandle;
  try {
    handle = await open(filename, "wx", 0o600);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) {
      throw error;
    }
    const existing = await readFile(filename);
    const expected = typeof contents === "string" ? Buffer.from(contents) : Buffer.from(contents);
    if (!existing.equals(expected)) {
      throw new StoreError("write.temp_conflict", "temporary path contains different bytes", {
        path: relativePath,
      });
    }
    return filename;
  }
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return filename;
}

export async function publishTemp(
  runRoot: string,
  temporaryPath: string,
  targetPath: string,
): Promise<void> {
  const source = await resolveRunPath(runRoot, temporaryPath);
  const target = await resolveRunPath(runRoot, targetPath, { createParents: true });
  try {
    await link(source, target);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new StoreError("write.conflict", "formal path is already occupied", {
        path: targetPath,
      });
    }
    throw error;
  }
  await rm(source);
  await syncDirectory(path.dirname(target));
}

export async function atomicReplace(
  runRoot: string,
  targetPath: string,
  contents: string,
  operationSuffix: string,
): Promise<void> {
  const temporaryPath = `.store/temp/${operationSuffix}.replace.tmp`;
  const temporary = await writeSyncedTemp(runRoot, temporaryPath, contents);
  const target = await resolveRunPath(runRoot, targetPath, { createParents: true });
  await rename(temporary, target);
  await syncDirectory(path.dirname(target));
}

export async function removeTemp(runRoot: string, relativePath: string): Promise<void> {
  const filename = await resolveRunPath(runRoot, relativePath, { createParents: true });
  await rm(filename, { force: true });
}

import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { StoreError } from "./store-error.js";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RELATIVE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const FRAGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

async function statOrNull(filename: string) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

export function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

export function validateRunId(runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new StoreError("path.invalid_run_id", "run id violates the published Run boundary", {
      runId,
    });
  }
  return runId;
}

export function validateRelativePath(relativePath: string): string {
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    !RELATIVE_PATH.test(relativePath) ||
    relativePath.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new StoreError(
      "path.invalid_relative_path",
      "path must be an unambiguous Run-relative path",
      { path: relativePath },
    );
  }
  return relativePath;
}

export function validateArtifactRef(ref: string): {
  readonly path: string;
  readonly fragment: string | null;
} {
  const pieces = ref.split("#");
  if (pieces.length > 2 || !pieces[0]) {
    throw new StoreError("reference.invalid", "artifact ref is not Run-relative", { ref });
  }
  const relativePath = validateRelativePath(pieces[0]);
  const fragment = pieces[1] ?? null;
  if (fragment !== null && !FRAGMENT.test(fragment)) {
    throw new StoreError("reference.invalid_fragment", "artifact ref fragment is invalid", { ref });
  }
  return { path: relativePath, fragment };
}

export async function prepareRunsRoot(runsRoot: string): Promise<string> {
  await mkdir(runsRoot, { recursive: true });
  const stat = await lstat(runsRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new StoreError("path.unsafe_runs_root", "runs root must be a real directory", {
      runsRoot,
    });
  }
  return realpath(runsRoot);
}

export async function createRunDirectory(runsRoot: string, runId: string): Promise<string> {
  validateRunId(runId);
  const root = await prepareRunsRoot(runsRoot);
  const target = path.join(root, runId);
  try {
    await mkdir(target);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new StoreError("run.already_exists", "run id is already occupied", { runId });
    }
    throw error;
  }
  return target;
}

export async function openRunDirectory(runsRoot: string, runId: string): Promise<string> {
  validateRunId(runId);
  const root = await prepareRunsRoot(runsRoot);
  return openRunDirectoryWithinRoot(root, runId);
}

export async function openRunDirectoryReadOnly(runsRoot: string, runId: string): Promise<string> {
  validateRunId(runId);
  return openRunDirectoryWithinRoot(await openRunsRootReadOnly(runsRoot), runId);
}

export async function openRunsRootReadOnly(runsRoot: string): Promise<string> {
  const rootStat = await statOrNull(runsRoot);
  if (!rootStat) {
    throw new StoreError("run.not_found", "runs root does not exist", { runsRoot });
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new StoreError("path.unsafe_runs_root", "runs root must be a real directory", {
      runsRoot,
    });
  }
  return realpath(runsRoot);
}

async function openRunDirectoryWithinRoot(root: string, runId: string): Promise<string> {
  const target = path.join(root, runId);
  const stat = await statOrNull(target);
  if (!stat) {
    throw new StoreError("run.not_found", "run does not exist", { runId });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new StoreError("path.symlink_escape", "run path must not be a symlink", { runId });
  }
  const resolved = await realpath(target);
  if (path.dirname(resolved) !== root) {
    throw new StoreError("path.symlink_escape", "run resolves outside the runs root", { runId });
  }
  return resolved;
}

export async function resolveRunPath(
  runRoot: string,
  relativePath: string,
  options: { readonly createParents?: boolean } = {},
): Promise<string> {
  validateRelativePath(relativePath);
  const segments = relativePath.split("/");
  let current = runRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await statOrNull(current);
    if (!stat && options.createParents) {
      await mkdir(current);
    } else if (!stat) {
      throw new StoreError("path.parent_missing", "artifact parent directory is missing", {
        path: relativePath,
      });
    }
    const verified = await lstat(current);
    if (!verified.isDirectory() || verified.isSymbolicLink()) {
      throw new StoreError("path.symlink_escape", "path traverses a symlink or non-directory", {
        path: relativePath,
      });
    }
  }
  const target = path.join(runRoot, ...segments);
  const stat = await statOrNull(target);
  if (stat?.isSymbolicLink()) {
    throw new StoreError("path.symlink_escape", "target path is a symlink", {
      path: relativePath,
    });
  }
  return target;
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { StoreError, storeErrorResult } from "../artifact-store/store-error.js";
import { createArtifactValidator } from "../validators/artifact-validator.js";
import { buildArtifactScaffold } from "./artifact-scaffolds.js";
import { DeclarativeRuntimeCompiler } from "./declarative-runtime.js";
import { LaneResultMaterializer } from "./lane-materializer.js";

function argumentsByName(args: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !name.startsWith("--") ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new StoreError(
        "command.invalid_arguments",
        "arguments must be unique --name value pairs",
      );
    }
    values.set(name, value);
  }
  const unsupported = [...values.keys()].filter(
    (name) => name !== "--file" && name !== "--runs-root",
  );
  if (unsupported.length > 0) {
    throw new StoreError("command.invalid_arguments", "unsupported command arguments", {
      arguments: unsupported.sort(),
    });
  }
  return values;
}

export async function runCompileArtifacts(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  try {
    const parsed = argumentsByName(args);
    const file = parsed.get("--file");
    if (file === undefined) {
      throw new StoreError("command.invalid_arguments", "missing required argument --file");
    }
    const request = JSON.parse(await readFile(file, "utf8")) as unknown;
    const validator = await createArtifactValidator(repositoryRoot);
    const runsRoot = parsed.get("--runs-root") ?? path.join(repositoryRoot, "runs");
    const result = await new DeclarativeRuntimeCompiler(
      runsRoot,
      validator,
      repositoryRoot,
    ).compile(request);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: "startup_opportunity.store_error.v1",
        status: "failed",
        error: storeErrorResult(error),
      })}\n`,
    );
    return error instanceof StoreError && error.code === "command.invalid_arguments" ? 64 : 1;
  }
}

export async function runMaterializeLaneResult(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  try {
    const parsed = argumentsByName(args);
    const file = parsed.get("--file");
    if (file === undefined) {
      throw new StoreError("command.invalid_arguments", "missing required argument --file");
    }
    const staging = JSON.parse(await readFile(file, "utf8")) as unknown;
    const validator = await createArtifactValidator(repositoryRoot);
    const runsRoot = parsed.get("--runs-root") ?? path.join(repositoryRoot, "runs");
    const result = await new LaneResultMaterializer(
      runsRoot,
      validator,
      repositoryRoot,
    ).materialize(staging);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: "startup_opportunity.store_error.v1",
        status: "failed",
        error: storeErrorResult(error),
      })}\n`,
    );
    return error instanceof StoreError && error.code === "command.invalid_arguments" ? 64 : 1;
  }
}

export async function runScaffoldArtifact(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  try {
    const parsed = argumentsByName(args);
    const file = parsed.get("--file");
    if (file === undefined) {
      throw new StoreError("command.invalid_arguments", "missing required argument --file");
    }
    const request = JSON.parse(await readFile(file, "utf8")) as unknown;
    const validator = await createArtifactValidator(repositoryRoot);
    process.stdout.write(`${JSON.stringify(buildArtifactScaffold(request, validator), null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: "startup_opportunity.store_error.v1",
        status: "failed",
        error: storeErrorResult(error),
      })}\n`,
    );
    return error instanceof StoreError && error.code === "command.invalid_arguments" ? 64 : 1;
  }
}

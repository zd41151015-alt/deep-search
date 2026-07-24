import { readFile } from "node:fs/promises";
import path from "node:path";
import { StoreError, storeErrorResult } from "../artifact-store/store-error.js";
import { EvidenceStore } from "../evidence-store/evidence-store.js";
import { createArtifactValidator } from "../validators/artifact-validator.js";
import {
  type BeliefSummary,
  type CheckpointRunInput,
  type CreateRunInput,
  type RunMode,
  RunStore,
} from "./run-store.js";

interface ParsedArguments {
  readonly values: ReadonlyMap<string, string>;
  readonly repeated: ReadonlyMap<string, readonly string[]>;
}

function parseArguments(
  args: readonly string[],
  repeatedNames: readonly string[] = [],
): ParsedArguments {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new StoreError("command.invalid_arguments", "arguments must be --name value pairs", {
        argument: name ?? null,
      });
    }
    if (repeatedNames.includes(name)) {
      repeated.set(name, [...(repeated.get(name) ?? []), value]);
    } else if (values.has(name)) {
      throw new StoreError("command.invalid_arguments", "argument must not be repeated", { name });
    } else {
      values.set(name, value);
    }
    index += 1;
  }
  return { values, repeated };
}

function required(parsed: ParsedArguments, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined) {
    throw new StoreError("command.invalid_arguments", `missing required argument ${name}`, {
      name,
    });
  }
  return value;
}

function rejectUnknown(parsed: ParsedArguments, allowed: readonly string[]): void {
  const unknown = [...parsed.values.keys(), ...parsed.repeated.keys()].filter(
    (name) => !allowed.includes(name),
  );
  if (unknown.length > 0) {
    throw new StoreError("command.invalid_arguments", "unsupported command arguments", {
      arguments: unknown.sort(),
    });
  }
}

function roots(parsed: ParsedArguments, repositoryRoot: string): string {
  return parsed.values.get("--runs-root") ?? path.join(repositoryRoot, "runs");
}

function writeResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runCommand(action: () => Promise<unknown>): Promise<number> {
  try {
    writeResult(await action());
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

export async function runCreateRun(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, [
      "--run-id",
      "--mode",
      "--created-at",
      "--parent-run-id",
      "--skill-version",
      "--policy-version",
      "--git-commit",
      "--runs-root",
    ]);
    const mode = required(parsed, "--mode");
    if (mode !== "opportunity_discovery" && mode !== "concept_evidence_assessment") {
      throw new StoreError("command.invalid_arguments", "--mode is not a published Run mode", {
        mode,
      });
    }
    const createdAt = parsed.values.get("--created-at");
    const parentRunId = parsed.values.get("--parent-run-id");
    const skillVersion = parsed.values.get("--skill-version");
    const policyVersion = parsed.values.get("--policy-version");
    const gitCommit = parsed.values.get("--git-commit");
    const input: CreateRunInput = {
      runId: required(parsed, "--run-id"),
      mode: mode as RunMode,
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(parentRunId === undefined ? {} : { parentRunId }),
      ...(skillVersion === undefined ? {} : { skillVersion }),
      ...(policyVersion === undefined ? {} : { policyVersion }),
      ...(gitCommit === undefined ? {} : { gitCommit }),
    };
    const validator = await createArtifactValidator(repositoryRoot);
    return new RunStore(roots(parsed, repositoryRoot), validator).create(input);
  });
}

export async function runLoadRun(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, ["--run-id", "--runs-root"]);
    const validator = await createArtifactValidator(repositoryRoot);
    return new RunStore(roots(parsed, repositoryRoot), validator).load(
      required(parsed, "--run-id"),
    );
  });
}

export async function runRecordEvidence(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, [
      "--run-id",
      "--unit-id",
      "--url",
      "--research-goal",
      "--content-file",
      "--recorded-at",
      "--operation-key",
      "--runs-root",
    ]);
    const store = new EvidenceStore(roots(parsed, repositoryRoot));
    const recordedAt = parsed.values.get("--recorded-at");
    const suppliedOperationKey = parsed.values.get("--operation-key");
    return store.record({
      runId: required(parsed, "--run-id"),
      unitId: required(parsed, "--unit-id"),
      url: required(parsed, "--url"),
      researchGoal: required(parsed, "--research-goal"),
      rawContent: await readFile(required(parsed, "--content-file")),
      ...(recordedAt === undefined ? {} : { recordedAt }),
      ...(suppliedOperationKey === undefined ? {} : { operationKey: suppliedOperationKey }),
    });
  });
}

export async function runCheckpointRun(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, ["--file", "--runs-root"]);
    const value = JSON.parse(await readFile(required(parsed, "--file"), "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new StoreError("command.invalid_arguments", "checkpoint input must be a JSON object");
    }
    const record = value as Record<string, unknown>;
    const belief = record.belief_summary;
    if (typeof belief !== "object" || belief === null || Array.isArray(belief)) {
      throw new StoreError("command.invalid_arguments", "checkpoint belief_summary is required");
    }
    const input: CheckpointRunInput = {
      runId: String(record.run_id ?? ""),
      checkpointId: String(record.checkpoint_id ?? ""),
      createdAt: String(record.created_at ?? ""),
      nextStep: String(record.next_step ?? ""),
      beliefSummary: belief as unknown as BeliefSummary,
      unresolvedGapRefs: Array.isArray(record.unresolved_gap_refs)
        ? (record.unresolved_gap_refs as string[])
        : [],
      inputRefs: Array.isArray(record.input_refs) ? (record.input_refs as string[]) : [],
    };
    const validator = await createArtifactValidator(repositoryRoot);
    return new RunStore(roots(parsed, repositoryRoot), validator).checkpoint(input);
  });
}

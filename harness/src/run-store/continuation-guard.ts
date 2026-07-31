import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalContentHash, isSha256 } from "../artifact-store/canonical.js";
import { isNodeError, validateRunId } from "../artifact-store/path-policy.js";
import { StoreError } from "../artifact-store/store-error.js";

interface ContinuationChildIdentity {
  readonly run_id: string;
  readonly mode: "opportunity_discovery" | "concept_evidence_assessment";
  readonly parent_run_id: string;
  readonly created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function childIdentity(
  value: unknown,
  expectedRunId: string,
  expectedParentRunId: string,
): ContinuationChildIdentity | null {
  if (
    !isRecord(value) ||
    value.schema_version !== "startup_opportunity.run_manifest.v1" ||
    value.run_id !== expectedRunId ||
    value.parent_run_id !== expectedParentRunId ||
    (value.mode !== "opportunity_discovery" && value.mode !== "concept_evidence_assessment") ||
    !validTimestamp(value.created_at)
  ) {
    return null;
  }
  return {
    run_id: value.run_id,
    mode: value.mode,
    parent_run_id: value.parent_run_id,
    created_at: value.created_at,
  };
}

async function inspectChildren(
  runsRoot: string,
  parentRunId: string,
): Promise<{ readonly childRunIds: readonly string[]; readonly issues: readonly string[] }> {
  const directory = path.join(runsRoot, ".continuations", parentRunId);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { childRunIds: [], issues: [] };
    }
    return { childRunIds: [], issues: ["continuation.index_unreadable"] };
  }

  const childRunIds: string[] = [];
  const issues: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRunId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
    try {
      validateRunId(childRunId);
    } catch {
      issues.push("continuation.index_filename_invalid");
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      issues.push(`continuation.index_entry_invalid:${childRunId}`);
      continue;
    }
    try {
      const indexValue = JSON.parse(
        await readFile(path.join(directory, entry.name), "utf8"),
      ) as unknown;
      if (
        !isRecord(indexValue) ||
        !hasExactlyKeys(indexValue, [
          "schema_version",
          "parent_run_id",
          "child_run_id",
          "child_identity_hash",
          "state",
          "created_at",
        ]) ||
        indexValue.schema_version !== "startup_opportunity.continuation_lineage_entry.v1" ||
        indexValue.parent_run_id !== parentRunId ||
        indexValue.child_run_id !== childRunId ||
        !isSha256(indexValue.child_identity_hash) ||
        !validTimestamp(indexValue.created_at) ||
        (indexValue.state !== "pending" && indexValue.state !== "committed")
      ) {
        issues.push(`continuation.index_entry_invalid:${childRunId}`);
        continue;
      }
      if (indexValue.state === "pending") {
        issues.push(`continuation.index_pending:${childRunId}`);
        continue;
      }
      const manifestValue = JSON.parse(
        await readFile(path.join(runsRoot, childRunId, "manifest.json"), "utf8"),
      ) as unknown;
      const identity = childIdentity(manifestValue, childRunId, parentRunId);
      if (
        identity === null ||
        canonicalContentHash(identity) !== indexValue.child_identity_hash ||
        identity.created_at !== indexValue.created_at
      ) {
        issues.push(`continuation.child_identity_mismatch:${childRunId}`);
        continue;
      }
      childRunIds.push(childRunId);
    } catch {
      issues.push(`continuation.child_unreadable:${childRunId}`);
    }
  }
  if (childRunIds.length > 1) {
    issues.push(`continuation.multiple_children:${parentRunId}`);
  }
  return {
    childRunIds: [...new Set(childRunIds)].sort(),
    issues: [...new Set(issues)].sort(),
  };
}

export async function assertRunIsCurrentContinuationLeaf(
  runsRoot: string,
  runId: string,
): Promise<void> {
  validateRunId(runId);
  const chain = [runId];
  const seen = new Set(chain);
  let cursor = runId;
  while (true) {
    const inspection = await inspectChildren(runsRoot, cursor);
    if (inspection.issues.length > 0) {
      throw new StoreError(
        "run.continuation_indeterminate",
        "Run continuation lineage cannot be resolved safely",
        { runId, continuationChain: chain, issues: inspection.issues },
      );
    }
    const childRunId = inspection.childRunIds[0];
    if (childRunId === undefined) {
      break;
    }
    if (seen.has(childRunId)) {
      throw new StoreError(
        "run.continuation_indeterminate",
        "Run continuation lineage cannot be resolved safely",
        { runId, continuationChain: chain, issues: [`continuation.cycle:${childRunId}`] },
      );
    }
    seen.add(childRunId);
    chain.push(childRunId);
    cursor = childRunId;
  }
  if (cursor !== runId) {
    throw new StoreError("run.not_current_leaf", "Run has an authoritative continuation leaf", {
      runId,
      currentLeafRunId: cursor,
      continuationChain: chain,
    });
  }
}

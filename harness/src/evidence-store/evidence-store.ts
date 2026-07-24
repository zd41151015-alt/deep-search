import { open, readdir, readFile, rm, stat, truncate } from "node:fs/promises";
import { publishTemp, removeTemp, writeSyncedTemp } from "../artifact-store/atomic-file.js";
import {
  canonicalJson,
  operationKey,
  sha256Bytes,
  sha256Hex,
} from "../artifact-store/canonical.js";
import {
  isNodeError,
  openRunDirectory,
  resolveRunPath,
  validateRunId,
} from "../artifact-store/path-policy.js";
import { withRunLock } from "../artifact-store/run-lock.js";
import { StoreError } from "../artifact-store/store-error.js";

export type EvidenceFaultBoundary = "after_raw_temp" | "after_intent" | "after_raw_publish";

export interface RecordEvidenceInput {
  readonly runId: string;
  readonly unitId: string;
  readonly url: string;
  readonly researchGoal: string;
  readonly rawContent: string | Uint8Array;
  readonly recordedAt?: string;
  readonly operationKey?: string;
  readonly faultAt?: EvidenceFaultBoundary;
}

export interface EvidenceStoreRecord extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.evidence_store_record.v1";
  readonly evidence_id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly canonical_url: string;
  readonly source_hash: string;
  readonly content_hash: string;
  readonly research_goal: string;
  readonly raw_content_ref: string;
  readonly operation_key: string;
  readonly recorded_at: string;
}

interface EvidenceOperationReceipt {
  readonly schema_version: "startup_opportunity.evidence_store_operation.v1";
  readonly operation_key: string;
  readonly record: EvidenceStoreRecord;
}

export interface RecordEvidenceResult {
  readonly schemaVersion: "startup_opportunity.record_evidence_result.v1";
  readonly status: "recorded" | "idempotent_replay";
  readonly record: EvidenceStoreRecord;
}

export interface EvidenceRecoveryResult {
  readonly truncatedBytes: number;
  readonly replayedEvidenceIds: readonly string[];
  readonly recoveredRawContentRefs: readonly string[];
  readonly removedTemporaryPaths: readonly string[];
}

export function canonicalizeSourceUrl(input: string): string {
  let source: URL;
  try {
    source = new URL(input);
  } catch {
    throw new StoreError("evidence.invalid_url", "evidence source URL is invalid", { url: input });
  }
  if (
    (source.protocol !== "https:" && source.protocol !== "http:") ||
    source.username ||
    source.password
  ) {
    throw new StoreError(
      "evidence.invalid_url",
      "evidence source URL must use http(s) without credentials",
      { url: input },
    );
  }
  source.hash = "";
  return source.href;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new StoreError("evidence.invalid_input", `${field} must not be empty`, { field });
  }
}

function parseManifest(contents: Buffer): {
  readonly records: EvidenceStoreRecord[];
  readonly validBytes: number;
} {
  const records: EvidenceStoreRecord[] = [];
  let offset = 0;
  let validBytes = 0;
  while (offset < contents.length) {
    const newline = contents.indexOf(0x0a, offset);
    if (newline < 0) {
      break;
    }
    const line = contents.subarray(offset, newline).toString("utf8");
    if (line.length > 0) {
      let value: EvidenceStoreRecord;
      try {
        value = JSON.parse(line) as EvidenceStoreRecord;
      } catch {
        throw new StoreError(
          "evidence.corrupt_manifest",
          "evidence manifest contains corrupt complete JSONL",
          { offset },
        );
      }
      if (
        value.schema_version !== "startup_opportunity.evidence_store_record.v1" ||
        typeof value.evidence_id !== "string" ||
        typeof value.operation_key !== "string"
      ) {
        throw new StoreError(
          "evidence.corrupt_manifest",
          "evidence manifest contains an invalid record",
          { offset },
        );
      }
      records.push(value);
    }
    validBytes = newline + 1;
    offset = newline + 1;
  }
  return { records, validBytes };
}

async function appendRecord(filename: string, record: EvidenceStoreRecord): Promise<void> {
  const handle = await open(filename, "a", 0o600);
  try {
    await handle.write(`${canonicalJson(record)}\n`, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class EvidenceStore {
  constructor(private readonly runsRoot: string) {}

  async record(input: RecordEvidenceInput): Promise<RecordEvidenceResult> {
    validateRunId(input.runId);
    assertNonEmpty(input.unitId, "unitId");
    assertNonEmpty(input.researchGoal, "researchGoal");
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, () => this.recordLocked(runRoot, input));
  }

  async recordLocked(runRoot: string, input: RecordEvidenceInput): Promise<RecordEvidenceResult> {
    const canonicalUrl = canonicalizeSourceUrl(input.url);
    const rawBytes =
      typeof input.rawContent === "string"
        ? Buffer.from(input.rawContent, "utf8")
        : Buffer.from(input.rawContent);
    const contentHash = sha256Bytes(rawBytes);
    const stableOperationKey =
      input.operationKey ??
      operationKey("record_evidence", {
        canonical_url: canonicalUrl,
        content_hash: contentHash,
        research_goal: input.researchGoal,
      });
    const operationHex = sha256Hex(stableOperationKey);
    const contentHex = sha256Hex(contentHash);
    let record: EvidenceStoreRecord = {
      schema_version: "startup_opportunity.evidence_store_record.v1",
      evidence_id: `ev_${operationHex}`,
      run_id: input.runId,
      unit_id: input.unitId,
      canonical_url: canonicalUrl,
      source_hash: sha256Bytes(canonicalUrl),
      content_hash: contentHash,
      research_goal: input.researchGoal,
      raw_content_ref: `evidence/raw/sha256-${contentHex}.bin`,
      operation_key: stableOperationKey,
      recorded_at: input.recordedAt ?? new Date().toISOString(),
    };
    const receipt: EvidenceOperationReceipt = {
      schema_version: "startup_opportunity.evidence_store_operation.v1",
      operation_key: stableOperationKey,
      record,
    };
    const rawTempPath = `.store/temp/evidence-${operationHex}.raw.tmp`;
    await writeSyncedTemp(runRoot, rawTempPath, rawBytes);
    if (input.faultAt === "after_raw_temp") {
      throw new StoreError("fault.injected", "injected failure after evidence raw temp");
    }
    const receiptPath = `.store/operations/evidence-${operationHex}.json`;
    const receiptFile = await resolveRunPath(runRoot, receiptPath, { createParents: true });
    try {
      const existing = JSON.parse(await readFile(receiptFile, "utf8")) as EvidenceOperationReceipt;
      if (
        existing.schema_version !== "startup_opportunity.evidence_store_operation.v1" ||
        existing.operation_key !== stableOperationKey ||
        existing.record.run_id !== input.runId ||
        existing.record.canonical_url !== canonicalUrl ||
        existing.record.content_hash !== contentHash ||
        existing.record.research_goal !== input.researchGoal
      ) {
        throw new StoreError(
          "write.operation_conflict",
          "operation key was previously used with different evidence content",
          { operationKey: stableOperationKey },
        );
      }
      record = existing.record;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
      const receiptTemp = `.store/temp/evidence-${operationHex}.receipt.tmp`;
      await writeSyncedTemp(runRoot, receiptTemp, `${canonicalJson(receipt)}\n`);
      await publishTemp(runRoot, receiptTemp, receiptPath);
    }
    if (input.faultAt === "after_intent") {
      throw new StoreError("fault.injected", "injected failure after evidence intent");
    }

    const rawTarget = await resolveRunPath(runRoot, record.raw_content_ref, {
      createParents: true,
    });
    try {
      const existingRaw = await readFile(rawTarget);
      if (!existingRaw.equals(rawBytes)) {
        throw new StoreError("write.conflict", "raw content hash path contains different bytes", {
          path: record.raw_content_ref,
        });
      }
      await removeTemp(runRoot, rawTempPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
      await publishTemp(runRoot, rawTempPath, record.raw_content_ref);
    }
    if (input.faultAt === "after_raw_publish") {
      throw new StoreError("fault.injected", "injected failure after evidence raw publish");
    }

    const manifestFile = await resolveRunPath(runRoot, "evidence/manifest.jsonl");
    const contents = await readFile(manifestFile);
    const parsed = parseManifest(contents);
    if (parsed.validBytes !== contents.length) {
      throw new StoreError("evidence.corrupt_tail", "repair evidence manifest before appending");
    }
    const existingRecord = parsed.records.find((item) => item.operation_key === stableOperationKey);
    if (existingRecord) {
      if (canonicalJson(existingRecord) !== canonicalJson(record)) {
        throw new StoreError(
          "write.conflict",
          "evidence operation has different manifest content",
          {
            operationKey: stableOperationKey,
          },
        );
      }
      return {
        schemaVersion: "startup_opportunity.record_evidence_result.v1",
        status: "idempotent_replay",
        record,
      };
    }
    await appendRecord(manifestFile, record);
    return {
      schemaVersion: "startup_opportunity.record_evidence_result.v1",
      status: "recorded",
      record,
    };
  }

  async recoverLocked(runRoot: string, runId: string): Promise<EvidenceRecoveryResult> {
    const manifestFile = await resolveRunPath(runRoot, "evidence/manifest.jsonl");
    const manifestContents = await readFile(manifestFile);
    const parsed = parseManifest(manifestContents);
    const truncatedBytes = manifestContents.length - parsed.validBytes;
    if (truncatedBytes > 0) {
      await truncate(manifestFile, parsed.validBytes);
    }
    const records = [...parsed.records];
    for (const record of records) {
      if (
        record.run_id !== runId ||
        record.source_hash !== sha256Bytes(record.canonical_url) ||
        canonicalizeSourceUrl(record.canonical_url) !== record.canonical_url
      ) {
        throw new StoreError(
          "evidence.corrupt_manifest",
          "evidence record identity or source hash is invalid",
          { evidenceId: record.evidence_id },
        );
      }
      const raw = await readFile(await resolveRunPath(runRoot, record.raw_content_ref));
      if (sha256Bytes(raw) !== record.content_hash) {
        throw new StoreError("artifact.hash_mismatch", "stored evidence raw bytes do not match", {
          evidenceId: record.evidence_id,
          path: record.raw_content_ref,
        });
      }
    }
    const replayed: string[] = [];
    const recoveredRaw: string[] = [];
    const retainedTemps = new Set<string>();
    const operationDirectory = await resolveRunPath(runRoot, ".store/operations", {
      createParents: true,
    });
    for (const entry of (await readdir(operationDirectory)).sort()) {
      if (!entry.startsWith("evidence-") || !entry.endsWith(".json")) {
        continue;
      }
      const receiptPath = `.store/operations/${entry}`;
      const receipt = JSON.parse(
        await readFile(await resolveRunPath(runRoot, receiptPath), "utf8"),
      ) as EvidenceOperationReceipt;
      if (
        receipt.schema_version !== "startup_opportunity.evidence_store_operation.v1" ||
        receipt.record.run_id !== runId ||
        receipt.operation_key !== receipt.record.operation_key
      ) {
        throw new StoreError("recovery.invalid_operation", "evidence operation is invalid", {
          path: receiptPath,
        });
      }
      const operationHex = sha256Hex(receipt.operation_key);
      const rawTempPath = `.store/temp/evidence-${operationHex}.raw.tmp`;
      const rawTarget = await resolveRunPath(runRoot, receipt.record.raw_content_ref, {
        createParents: true,
      });
      try {
        const metadata = await stat(rawTarget);
        if (!metadata.isFile()) {
          throw new StoreError("evidence.raw_missing", "raw evidence target is not a file", {
            path: receipt.record.raw_content_ref,
          });
        }
        const raw = await readFile(rawTarget);
        if (sha256Bytes(raw) !== receipt.record.content_hash) {
          throw new StoreError("artifact.hash_mismatch", "stored evidence raw bytes do not match", {
            path: receipt.record.raw_content_ref,
          });
        }
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
        try {
          const tempFile = await resolveRunPath(runRoot, rawTempPath);
          const raw = await readFile(tempFile);
          if (sha256Bytes(raw) !== receipt.record.content_hash) {
            throw new StoreError("artifact.hash_mismatch", "evidence raw temp hash differs", {
              path: rawTempPath,
            });
          }
          retainedTemps.add(rawTempPath.split("/").at(-1) ?? "");
          await publishTemp(runRoot, rawTempPath, receipt.record.raw_content_ref);
          recoveredRaw.push(receipt.record.raw_content_ref);
        } catch (tempError) {
          if (!isNodeError(tempError, "ENOENT")) {
            throw tempError;
          }
          await rm(await resolveRunPath(runRoot, receiptPath), { force: true });
          continue;
        }
      }
      const existing = records.find((record) => record.operation_key === receipt.operation_key);
      if (existing && canonicalJson(existing) !== canonicalJson(receipt.record)) {
        throw new StoreError("write.conflict", "evidence manifest conflicts with operation", {
          operationKey: receipt.operation_key,
        });
      }
      if (!existing) {
        await appendRecord(manifestFile, receipt.record);
        records.push(receipt.record);
        replayed.push(receipt.record.evidence_id);
      }
    }

    const tempDirectory = await resolveRunPath(runRoot, ".store/temp", { createParents: true });
    const removedTemps: string[] = [];
    for (const entry of (await readdir(tempDirectory)).sort()) {
      if (entry.startsWith("evidence-") && !retainedTemps.has(entry)) {
        await removeTemp(runRoot, `.store/temp/${entry}`);
        removedTemps.push(`.store/temp/${entry}`);
      }
    }
    return {
      truncatedBytes,
      replayedEvidenceIds: replayed.sort(),
      recoveredRawContentRefs: recoveredRaw.sort(),
      removedTemporaryPaths: removedTemps.sort(),
    };
  }
}

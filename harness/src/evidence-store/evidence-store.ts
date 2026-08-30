import { open, readdir, readFile, rm, stat, truncate } from "node:fs/promises";
import { publishTemp, removeTemp, writeSyncedTemp } from "../artifact-store/atomic-file.js";
import {
  canonicalJson,
  isSha256,
  operationKey,
  sha256Bytes,
  sha256Hex,
} from "../artifact-store/canonical.js";
import {
  isNodeError,
  openRunDirectory,
  openRunDirectoryReadOnly,
  resolveRunPath,
  validateRunId,
} from "../artifact-store/path-policy.js";
import { withRunLock } from "../artifact-store/run-lock.js";
import { StoreError } from "../artifact-store/store-error.js";
import { assertRunIsCurrentContinuationLeaf } from "../run-store/continuation-guard.js";
import { assertScopeAllowsStorageMutationLocked } from "../run-store/scope-write-guard.js";

export type EvidenceFaultBoundary = "after_raw_temp" | "after_intent" | "after_raw_publish";

interface RecordEvidenceInputBase {
  readonly runId: string;
  readonly unitId: string;
  readonly unitAttempt?: number;
  readonly acquisitionGoal?: string;
  readonly rawContent: string | Uint8Array;
  readonly recordedAt?: string;
  readonly operationKey?: string;
  readonly faultAt?: EvidenceFaultBoundary;
}

export interface PublicEvidenceSource {
  readonly kind: "public_url";
  readonly canonical_url: string;
}

export interface UserProvidedEvidenceSource {
  readonly kind: "user_provided";
  readonly canonical_uri: string;
}

export type CanonicalEvidenceSource = PublicEvidenceSource | UserProvidedEvidenceSource;

export interface EvidenceHandoffBinding {
  readonly handoff_ref: string;
  readonly handoff_item_id: string;
  readonly source_run_id: string;
  readonly source_evidence_path: string;
  readonly source_record_hash: string;
  readonly source_raw_content_hash: string;
  readonly source_recorded_at: string;
  readonly freshness_disposition: "current" | "historical" | "unknown";
  readonly applicability_disposition: "applicable" | "partially_applicable" | "unknown";
  readonly revalidation_status: "not_required" | "required";
}

export interface RecordEvidenceInput extends RecordEvidenceInputBase {
  readonly source: CanonicalEvidenceSource;
  readonly handoffBinding?: EvidenceHandoffBinding;
}

export interface EvidenceStoreRecord extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.evidence_store_record.v2";
  readonly evidence_id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly unit_attempt: number;
  readonly source: CanonicalEvidenceSource;
  readonly source_hash: string;
  readonly content_hash: string;
  readonly acquisition_goal: string;
  readonly raw_content_ref: string;
  readonly operation_key: string;
  readonly recorded_at: string;
  readonly handoff_binding?: EvidenceHandoffBinding;
}

interface EvidenceOperationReceipt {
  readonly schema_version: "startup_opportunity.evidence_store_operation.current";
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

export interface EvidenceRecordCapture {
  readonly record: EvidenceStoreRecord;
  readonly recordBytes: Uint8Array;
  readonly rawBytes: Uint8Array;
}

export interface EvidenceStoreStatistics {
  readonly record_count: number;
  readonly unique_source_count: number;
  readonly unique_raw_count: number;
  readonly unique_source_raw_count: number;
}

export interface PreparedEvidenceRecord {
  readonly record: EvidenceStoreRecord;
  readonly rawBytes: Uint8Array;
}

export function prepareEvidenceRecord(input: RecordEvidenceInput): PreparedEvidenceRecord {
  validateRunId(input.runId);
  assertNonEmpty(input.unitId, "unitId");
  const acquisitionGoal = inputAcquisitionGoal(input);
  const unitAttempt = input.unitAttempt ?? 1;
  if (!Number.isInteger(unitAttempt) || unitAttempt < 1) {
    throw new StoreError("evidence.invalid_input", "unitAttempt must be a positive integer", {
      unitAttempt,
    });
  }
  const rawBytes =
    typeof input.rawContent === "string"
      ? Buffer.from(input.rawContent, "utf8")
      : Buffer.from(input.rawContent);
  const contentHash = sha256Bytes(rawBytes);
  const source = canonicalizeSource(input.source);
  const handoffBinding = validateHandoffBinding(input.handoffBinding);
  const stableOperationKey = expectedEvidenceOperationKey(
    input.runId,
    input.unitId,
    unitAttempt,
    source,
    contentHash,
    acquisitionGoal,
    handoffBinding,
  );
  if (input.operationKey !== undefined && input.operationKey !== stableOperationKey) {
    throw new StoreError(
      "operation.key_mismatch",
      "Evidence operation key must match the canonical source/content/acquisition-goal tuple",
      { expected: stableOperationKey, actual: input.operationKey },
    );
  }
  const operationHex = sha256Hex(stableOperationKey);
  const contentHex = sha256Hex(contentHash);
  const record = validateEvidenceRecord(
    {
      schema_version: "startup_opportunity.evidence_store_record.v2",
      evidence_id: `ev_${operationHex}`,
      run_id: input.runId,
      unit_id: input.unitId,
      unit_attempt: unitAttempt,
      content_hash: contentHash,
      acquisition_goal: acquisitionGoal,
      raw_content_ref: `evidence/raw/sha256-${contentHex}.bin`,
      operation_key: stableOperationKey,
      recorded_at: input.recordedAt ?? new Date().toISOString(),
      source,
      source_hash: sha256Bytes(canonicalJson(source)),
      ...(handoffBinding === undefined ? {} : { handoff_binding: handoffBinding }),
    },
    input.runId,
  );
  return { record, rawBytes };
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

function inputAcquisitionGoal(input: RecordEvidenceInputBase): string {
  if (input.acquisitionGoal === undefined) {
    throw new StoreError("evidence.invalid_input", "acquisitionGoal must not be empty", {
      field: "acquisitionGoal",
    });
  }
  assertNonEmpty(input.acquisitionGoal, "acquisitionGoal");
  return input.acquisitionGoal;
}

function pathBasename(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function canonicalizeSource(source: CanonicalEvidenceSource): CanonicalEvidenceSource {
  if (source.kind === "public_url") {
    return { kind: "public_url", canonical_url: canonicalizeSourceUrl(source.canonical_url) };
  }
  if (
    !/^urn:startup-opportunity:user-provided:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
      source.canonical_uri,
    )
  ) {
    throw new StoreError(
      "evidence.invalid_source",
      "user-provided Evidence source must use the reserved canonical URN namespace",
      { canonicalUri: source.canonical_uri },
    );
  }
  return { kind: "user_provided", canonical_uri: source.canonical_uri };
}

function expectedEvidenceOperationKey(
  runId: string,
  unitId: string,
  unitAttempt: number,
  source: CanonicalEvidenceSource,
  contentHash: string,
  acquisitionGoal: string,
  handoffBinding?: EvidenceHandoffBinding,
): string {
  return operationKey("record_evidence", {
    run_id: runId,
    unit_id: unitId,
    unit_attempt: unitAttempt,
    source,
    content_hash: contentHash,
    acquisition_goal: acquisitionGoal,
    ...(handoffBinding === undefined ? {} : { handoff_binding: handoffBinding }),
  });
}

function validateHandoffBinding(value: unknown): EvidenceHandoffBinding | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "handoff_ref",
      "handoff_item_id",
      "source_run_id",
      "source_evidence_path",
      "source_record_hash",
      "source_raw_content_hash",
      "source_recorded_at",
      "freshness_disposition",
      "applicability_disposition",
      "revalidation_status",
    ]) ||
    typeof value.handoff_ref !== "string" ||
    !/^artifacts\/research-handoffs\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.json$/.test(
      value.handoff_ref,
    ) ||
    typeof value.handoff_item_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.handoff_item_id) ||
    typeof value.source_run_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.source_run_id) ||
    typeof value.source_evidence_path !== "string" ||
    !/^evidence\/manifest\.jsonl#ev_[a-f0-9]{64}$/.test(value.source_evidence_path) ||
    !isSha256(value.source_record_hash) ||
    !isSha256(value.source_raw_content_hash) ||
    typeof value.source_recorded_at !== "string" ||
    !Number.isFinite(Date.parse(value.source_recorded_at)) ||
    !["current", "historical", "unknown"].includes(String(value.freshness_disposition)) ||
    !["applicable", "partially_applicable", "unknown"].includes(
      String(value.applicability_disposition),
    ) ||
    !["not_required", "required"].includes(String(value.revalidation_status))
  ) {
    invalidEvidenceRecord("Evidence handoff binding is invalid");
  }
  return value as unknown as EvidenceHandoffBinding;
}

function invalidEvidenceRecord(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new StoreError("evidence.invalid_record", message, details);
}

function validateEvidenceRecord(value: unknown, runId: string): EvidenceStoreRecord {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "evidence_id",
      "run_id",
      "unit_id",
      "unit_attempt",
      "source",
      "source_hash",
      "content_hash",
      "acquisition_goal",
      "raw_content_ref",
      "operation_key",
      "recorded_at",
      ...(value.handoff_binding === undefined ? [] : ["handoff_binding"]),
    ]) ||
    value.schema_version !== "startup_opportunity.evidence_store_record.v2" ||
    value.run_id !== runId ||
    typeof value.unit_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.unit_id) ||
    !Number.isInteger(value.unit_attempt) ||
    (value.unit_attempt as number) < 1 ||
    !isRecord(value.source) ||
    typeof value.acquisition_goal !== "string" ||
    value.acquisition_goal.trim().length === 0 ||
    typeof value.recorded_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value.recorded_at,
    ) ||
    !Number.isFinite(Date.parse(value.recorded_at)) ||
    !isSha256(value.source_hash) ||
    !isSha256(value.content_hash) ||
    !isSha256(value.operation_key) ||
    typeof value.evidence_id !== "string" ||
    typeof value.raw_content_ref !== "string"
  ) {
    return invalidEvidenceRecord(
      "Evidence substrate record shape or primitive identity is invalid",
    );
  }
  let source: CanonicalEvidenceSource;
  let handoffBinding: EvidenceHandoffBinding | undefined;
  try {
    source = canonicalizeSource(value.source as unknown as CanonicalEvidenceSource);
    handoffBinding = validateHandoffBinding(value.handoff_binding);
  } catch {
    return invalidEvidenceRecord("Evidence substrate canonical source is invalid");
  }
  const operationHex = sha256Hex(value.operation_key);
  const contentHex = sha256Hex(value.content_hash);
  if (
    canonicalJson(source) !== canonicalJson(value.source) ||
    value.source_hash !== sha256Bytes(canonicalJson(source)) ||
    value.operation_key !==
      expectedEvidenceOperationKey(
        value.run_id,
        value.unit_id,
        value.unit_attempt as number,
        source,
        value.content_hash,
        value.acquisition_goal,
        handoffBinding,
      ) ||
    value.evidence_id !== `ev_${operationHex}` ||
    value.raw_content_ref !== `evidence/raw/sha256-${contentHex}.bin`
  ) {
    return invalidEvidenceRecord("Evidence substrate stable identity fields are inconsistent", {
      evidenceId: value.evidence_id,
    });
  }
  return value as unknown as EvidenceStoreRecord;
}

function validateEvidenceReceipt(
  value: unknown,
  filename: string,
  runId: string,
): EvidenceOperationReceipt {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ["schema_version", "operation_key", "record"]) ||
    value.schema_version !== "startup_opportunity.evidence_store_operation.current" ||
    !isSha256(value.operation_key)
  ) {
    throw new StoreError("recovery.invalid_operation", "Evidence operation receipt is invalid", {
      path: `.store/operations/${filename}`,
    });
  }
  let record: EvidenceStoreRecord;
  try {
    record = validateEvidenceRecord(value.record, runId);
  } catch (error) {
    throw new StoreError(
      "recovery.invalid_operation",
      "Evidence receipt contains an invalid record",
      {
        path: `.store/operations/${filename}`,
        cause: error instanceof StoreError ? error.code : "evidence.invalid_record",
      },
    );
  }
  const expectedKey = expectedEvidenceOperationKey(
    record.run_id,
    record.unit_id,
    record.unit_attempt,
    record.source,
    record.content_hash,
    record.acquisition_goal,
    record.handoff_binding,
  );
  const expectedFilename = `evidence-${sha256Hex(value.operation_key)}.json`;
  if (
    filename !== expectedFilename ||
    value.schema_version !== "startup_opportunity.evidence_store_operation.current" ||
    value.operation_key !== record.operation_key ||
    value.operation_key !== expectedKey
  ) {
    throw new StoreError(
      "recovery.invalid_operation",
      "Evidence receipt identity differs from its filename or record",
      { path: `.store/operations/${filename}` },
    );
  }
  return value as unknown as EvidenceOperationReceipt;
}

function parseManifest(
  contents: Buffer,
  runId: string,
): {
  readonly records: EvidenceStoreRecord[];
  readonly validBytes: number;
} {
  const records: EvidenceStoreRecord[] = [];
  const operationKeys = new Set<string>();
  const evidenceIds = new Set<string>();
  let offset = 0;
  let validBytes = 0;
  while (offset < contents.length) {
    const newline = contents.indexOf(0x0a, offset);
    if (newline < 0) {
      break;
    }
    const line = contents.subarray(offset, newline).toString("utf8");
    if (line.length > 0) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new StoreError(
          "evidence.corrupt_manifest",
          "evidence manifest contains corrupt complete JSONL",
          { offset },
        );
      }
      const record = validateEvidenceRecord(value, runId);
      if (operationKeys.has(record.operation_key) || evidenceIds.has(record.evidence_id)) {
        throw new StoreError(
          "evidence.duplicate_identity",
          "Evidence manifest contains a duplicate operation key or stable id",
          { offset, evidenceId: record.evidence_id },
        );
      }
      operationKeys.add(record.operation_key);
      evidenceIds.add(record.evidence_id);
      records.push(record);
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

function evidenceStatistics(records: readonly EvidenceStoreRecord[]): EvidenceStoreStatistics {
  return {
    record_count: records.length,
    unique_source_count: new Set(records.map((record) => record.source_hash)).size,
    unique_raw_count: new Set(records.map((record) => record.content_hash)).size,
    unique_source_raw_count: new Set(
      records.map((record) => `${record.source_hash}\u0000${record.content_hash}`),
    ).size,
  };
}

export class EvidenceStore {
  constructor(private readonly runsRoot: string) {}

  async record(input: RecordEvidenceInput): Promise<RecordEvidenceResult> {
    if (input.handoffBinding !== undefined) {
      throw new StoreError(
        "research_handoff.dedicated_entry_required",
        "imported Evidence must be created by the target-owned research handoff operation",
      );
    }
    validateRunId(input.runId);
    assertNonEmpty(input.unitId, "unitId");
    inputAcquisitionGoal(input);
    await assertRunIsCurrentContinuationLeaf(this.runsRoot, input.runId);
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      await assertRunIsCurrentContinuationLeaf(this.runsRoot, input.runId);
      return this.recordLocked(runRoot, input);
    });
  }

  async recordLocked(runRoot: string, input: RecordEvidenceInput): Promise<RecordEvidenceResult> {
    if (input.handoffBinding !== undefined) {
      throw new StoreError(
        "research_handoff.dedicated_entry_required",
        "imported Evidence must be created by the target-owned research handoff operation",
      );
    }
    return this.recordPreparedLocked(runRoot, input);
  }

  async recordResearchHandoffImportLocked(
    runRoot: string,
    input: RecordEvidenceInput & { readonly handoffBinding: EvidenceHandoffBinding },
    continueCommittedHandoff = false,
  ): Promise<RecordEvidenceResult> {
    return this.recordPreparedLocked(runRoot, input, continueCommittedHandoff);
  }

  private async recordPreparedLocked(
    runRoot: string,
    input: RecordEvidenceInput,
    scopeMutationPrevalidated = false,
  ): Promise<RecordEvidenceResult> {
    validateRunId(input.runId);
    assertNonEmpty(input.unitId, "unitId");
    inputAcquisitionGoal(input);
    await assertRunIsCurrentContinuationLeaf(this.runsRoot, input.runId);
    if (!scopeMutationPrevalidated) {
      await assertScopeAllowsStorageMutationLocked(this.runsRoot, runRoot, input.runId, {
        kind: "evidence",
      });
    }
    const prepared = prepareEvidenceRecord(input);
    const rawBytes = Buffer.from(prepared.rawBytes);
    const { record: preparedRecord } = prepared;
    const stableOperationKey = preparedRecord.operation_key;
    const operationHex = sha256Hex(stableOperationKey);
    let record = preparedRecord;
    const receipt: EvidenceOperationReceipt = {
      schema_version: "startup_opportunity.evidence_store_operation.current",
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
      const existing = validateEvidenceReceipt(
        JSON.parse(await readFile(receiptFile, "utf8")) as unknown,
        pathBasename(receiptPath),
        input.runId,
      );
      if (existing.operation_key !== stableOperationKey) {
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
    const parsed = parseManifest(contents, input.runId);
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

  async readExactRecord(runId: string, ref: string): Promise<EvidenceStoreRecord> {
    validateRunId(runId);
    const runRoot = await openRunDirectory(this.runsRoot, runId);
    return withRunLock(runRoot, () => this.readExactRecordLocked(runRoot, runId, ref));
  }

  async readExactCapture(runId: string, ref: string): Promise<EvidenceRecordCapture> {
    validateRunId(runId);
    const runRoot = await openRunDirectoryReadOnly(this.runsRoot, runId);
    const record = await this.readExactRecordLocked(runRoot, runId, ref);
    const manifest = await readFile(await resolveRunPath(runRoot, "evidence/manifest.jsonl"));
    const recordLine = manifest
      .toString("utf8")
      .split("\n")
      .find((line) => {
        if (line.length === 0) return false;
        try {
          const candidate = JSON.parse(line) as unknown;
          return isRecord(candidate) && candidate.evidence_id === record.evidence_id;
        } catch {
          return false;
        }
      });
    if (recordLine === undefined) {
      throw new StoreError("reference.missing", "exact Evidence record bytes are missing", { ref });
    }
    const rawBytes = await readFile(await resolveRunPath(runRoot, record.raw_content_ref));
    if (sha256Bytes(rawBytes) !== record.content_hash) {
      throw new StoreError("artifact.hash_mismatch", "stored evidence raw bytes do not match", {
        ref,
        path: record.raw_content_ref,
      });
    }
    return { record, recordBytes: Buffer.from(recordLine, "utf8"), rawBytes };
  }

  async listRecords(runId: string): Promise<readonly EvidenceStoreRecord[]> {
    validateRunId(runId);
    const runRoot = await openRunDirectoryReadOnly(this.runsRoot, runId);
    return this.listRecordsLocked(runRoot, runId);
  }

  async statistics(runId: string): Promise<EvidenceStoreStatistics> {
    validateRunId(runId);
    const runRoot = await openRunDirectoryReadOnly(this.runsRoot, runId);
    return this.statisticsLocked(runRoot, runId);
  }

  async readExactRecordLocked(
    runRoot: string,
    runId: string,
    ref: string,
  ): Promise<EvidenceStoreRecord> {
    const match = /^evidence\/manifest\.jsonl#(ev_[a-f0-9]{64})$/.exec(ref);
    if (match?.[1] === undefined) {
      throw new StoreError(
        "reference.type_mismatch",
        "Evidence substrate ref must target one exact manifest record",
        { ref },
      );
    }
    const manifestFile = await resolveRunPath(runRoot, "evidence/manifest.jsonl");
    const contents = await readFile(manifestFile);
    const parsed = parseManifest(contents, runId);
    if (parsed.validBytes !== contents.length) {
      throw new StoreError(
        "evidence.corrupt_tail",
        "repair evidence manifest before resolving exact records",
      );
    }
    const matches = parsed.records.filter((record) => record.evidence_id === match[1]);
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new StoreError(
        matches.length === 0 ? "reference.missing" : "evidence.duplicate_identity",
        "Evidence substrate ref must resolve to exactly one record",
        { ref, count: matches.length },
      );
    }
    return matches[0];
  }

  async listRecordsLocked(runRoot: string, runId: string): Promise<readonly EvidenceStoreRecord[]> {
    const contents = await readFile(await resolveRunPath(runRoot, "evidence/manifest.jsonl"));
    const parsed = parseManifest(contents, runId);
    if (parsed.validBytes !== contents.length) {
      throw new StoreError("evidence.corrupt_tail", "repair evidence manifest before reading");
    }
    return parsed.records;
  }

  async statisticsLocked(runRoot: string, runId: string): Promise<EvidenceStoreStatistics> {
    return evidenceStatistics(await this.listRecordsLocked(runRoot, runId));
  }

  async recoverLocked(runRoot: string, runId: string): Promise<EvidenceRecoveryResult> {
    const manifestFile = await resolveRunPath(runRoot, "evidence/manifest.jsonl");
    const manifestContents = await readFile(manifestFile);
    const parsed = parseManifest(manifestContents, runId);
    const truncatedBytes = manifestContents.length - parsed.validBytes;
    if (truncatedBytes > 0) {
      await truncate(manifestFile, parsed.validBytes);
    }
    const records = [...parsed.records];
    for (const record of records) {
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
    const receiptsByOperationKey = new Map<string, EvidenceOperationReceipt>();
    for (const entry of (await readdir(operationDirectory)).sort()) {
      if (!entry.startsWith("evidence-") || !entry.endsWith(".json")) {
        continue;
      }
      const receiptPath = `.store/operations/${entry}`;
      const receipt = validateEvidenceReceipt(
        JSON.parse(await readFile(await resolveRunPath(runRoot, receiptPath), "utf8")) as unknown,
        entry,
        runId,
      );
      if (receiptsByOperationKey.has(receipt.operation_key)) {
        throw new StoreError("recovery.invalid_operation", "Evidence operation is duplicated", {
          path: receiptPath,
          operationKey: receipt.operation_key,
        });
      }
      receiptsByOperationKey.set(receipt.operation_key, receipt);
    }
    for (const record of records) {
      const receipt = receiptsByOperationKey.get(record.operation_key);
      if (!receipt || canonicalJson(receipt.record) !== canonicalJson(record)) {
        throw new StoreError(
          "recovery.missing_operation",
          "Evidence record does not have one matching operation receipt",
          { evidenceId: record.evidence_id, operationKey: record.operation_key },
        );
      }
    }

    const operations: {
      readonly receipt: EvidenceOperationReceipt;
      readonly receiptPath: string;
      readonly rawTempPath: string;
      readonly action: "complete" | "recover" | "discard";
    }[] = [];
    for (const receipt of receiptsByOperationKey.values()) {
      const receiptPath = `.store/operations/evidence-${sha256Hex(receipt.operation_key)}.json`;
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
        operations.push({ receipt, receiptPath, rawTempPath, action: "complete" });
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
          operations.push({ receipt, receiptPath, rawTempPath, action: "recover" });
        } catch (tempError) {
          if (!isNodeError(tempError, "ENOENT")) {
            throw tempError;
          }
          operations.push({ receipt, receiptPath, rawTempPath, action: "discard" });
        }
      }
      const existing = records.find((record) => record.operation_key === receipt.operation_key);
      if (existing && canonicalJson(existing) !== canonicalJson(receipt.record)) {
        throw new StoreError("write.conflict", "evidence manifest conflicts with operation", {
          operationKey: receipt.operation_key,
        });
      }
    }

    for (const operation of operations) {
      if (operation.action === "recover") {
        retainedTemps.add(operation.rawTempPath.split("/").at(-1) ?? "");
        await publishTemp(runRoot, operation.rawTempPath, operation.receipt.record.raw_content_ref);
        recoveredRaw.push(operation.receipt.record.raw_content_ref);
      } else if (operation.action === "discard") {
        await rm(await resolveRunPath(runRoot, operation.receiptPath), { force: true });
        continue;
      }
      if (!records.some((record) => record.operation_key === operation.receipt.operation_key)) {
        await appendRecord(manifestFile, operation.receipt.record);
        records.push(operation.receipt.record);
        replayed.push(operation.receipt.record.evidence_id);
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

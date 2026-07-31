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

export type EvidenceFaultBoundary = "after_raw_temp" | "after_intent" | "after_raw_publish";

interface RecordEvidenceInputBase {
  readonly runId: string;
  readonly unitId: string;
  readonly researchGoal: string;
  readonly rawContent: string | Uint8Array;
  readonly recordedAt?: string;
  readonly operationKey?: string;
  readonly faultAt?: EvidenceFaultBoundary;
}

export interface RecordLegacyEvidenceInput extends RecordEvidenceInputBase {
  readonly url: string;
  readonly source?: never;
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

export interface RecordMaterializedEvidenceInput extends RecordEvidenceInputBase {
  readonly source: CanonicalEvidenceSource;
  readonly url?: never;
}

export type RecordEvidenceInput = RecordLegacyEvidenceInput | RecordMaterializedEvidenceInput;

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

export interface EvidenceStoreRecordV2 extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.evidence_store_record.v2";
  readonly evidence_id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly source: CanonicalEvidenceSource;
  readonly source_hash: string;
  readonly content_hash: string;
  readonly research_goal: string;
  readonly raw_content_ref: string;
  readonly operation_key: string;
  readonly recorded_at: string;
}

export type EvidenceSubstrateRecord = EvidenceStoreRecord | EvidenceStoreRecordV2;

interface EvidenceOperationReceipt {
  readonly schema_version:
    | "startup_opportunity.evidence_store_operation.v1"
    | "startup_opportunity.evidence_store_operation.v2";
  readonly operation_key: string;
  readonly record: EvidenceSubstrateRecord;
}

export interface RecordEvidenceResult<T extends EvidenceSubstrateRecord = EvidenceSubstrateRecord> {
  readonly schemaVersion: "startup_opportunity.record_evidence_result.v1";
  readonly status: "recorded" | "idempotent_replay";
  readonly record: T;
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

function expectedEvidenceOperationKey(
  canonicalUrl: string,
  contentHash: string,
  researchGoal: string,
): string {
  return operationKey("record_evidence", {
    canonical_url: canonicalUrl,
    content_hash: contentHash,
    research_goal: researchGoal,
  });
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

function expectedEvidenceOperationKeyV2(
  source: CanonicalEvidenceSource,
  contentHash: string,
  researchGoal: string,
): string {
  return operationKey("record_evidence_v2", {
    source,
    content_hash: contentHash,
    research_goal: researchGoal,
  });
}

function invalidEvidenceRecord(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new StoreError("evidence.invalid_record", message, details);
}

function validateLegacyEvidenceRecord(value: unknown, runId: string): EvidenceStoreRecord {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "evidence_id",
      "run_id",
      "unit_id",
      "canonical_url",
      "source_hash",
      "content_hash",
      "research_goal",
      "raw_content_ref",
      "operation_key",
      "recorded_at",
    ]) ||
    value.schema_version !== "startup_opportunity.evidence_store_record.v1" ||
    value.run_id !== runId ||
    typeof value.unit_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.unit_id) ||
    typeof value.canonical_url !== "string" ||
    typeof value.research_goal !== "string" ||
    value.research_goal.trim().length === 0 ||
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
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeSourceUrl(value.canonical_url);
  } catch {
    return invalidEvidenceRecord("Evidence canonical URL is invalid");
  }
  const operationHex = sha256Hex(value.operation_key);
  const contentHex = sha256Hex(value.content_hash);
  if (
    canonicalUrl !== value.canonical_url ||
    value.source_hash !== sha256Bytes(canonicalUrl) ||
    value.operation_key !==
      expectedEvidenceOperationKey(canonicalUrl, value.content_hash, value.research_goal) ||
    value.evidence_id !== `ev_${operationHex}` ||
    value.raw_content_ref !== `evidence/raw/sha256-${contentHex}.bin`
  ) {
    return invalidEvidenceRecord("Evidence substrate stable identity fields are inconsistent", {
      evidenceId: value.evidence_id,
    });
  }
  return value as unknown as EvidenceStoreRecord;
}

function validateMaterializedEvidenceRecord(value: unknown, runId: string): EvidenceStoreRecordV2 {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "evidence_id",
      "run_id",
      "unit_id",
      "source",
      "source_hash",
      "content_hash",
      "research_goal",
      "raw_content_ref",
      "operation_key",
      "recorded_at",
    ]) ||
    value.schema_version !== "startup_opportunity.evidence_store_record.v2" ||
    value.run_id !== runId ||
    typeof value.unit_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.unit_id) ||
    !isRecord(value.source) ||
    typeof value.research_goal !== "string" ||
    value.research_goal.trim().length === 0 ||
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
      "Evidence substrate v2 record shape or primitive identity is invalid",
    );
  }
  let source: CanonicalEvidenceSource;
  try {
    source = canonicalizeSource(value.source as unknown as CanonicalEvidenceSource);
  } catch {
    return invalidEvidenceRecord("Evidence substrate v2 canonical source is invalid");
  }
  const operationHex = sha256Hex(value.operation_key);
  const contentHex = sha256Hex(value.content_hash);
  if (
    canonicalJson(source) !== canonicalJson(value.source) ||
    value.source_hash !== sha256Bytes(canonicalJson(source)) ||
    value.operation_key !==
      expectedEvidenceOperationKeyV2(source, value.content_hash, value.research_goal) ||
    value.evidence_id !== `ev_${operationHex}` ||
    value.raw_content_ref !== `evidence/raw/sha256-${contentHex}.bin`
  ) {
    return invalidEvidenceRecord("Evidence substrate v2 stable identity fields are inconsistent", {
      evidenceId: value.evidence_id,
    });
  }
  return value as unknown as EvidenceStoreRecordV2;
}

function validateEvidenceRecord(value: unknown, runId: string): EvidenceSubstrateRecord {
  if (isRecord(value) && value.schema_version === "startup_opportunity.evidence_store_record.v1") {
    return validateLegacyEvidenceRecord(value, runId);
  }
  return validateMaterializedEvidenceRecord(value, runId);
}

function validateEvidenceReceipt(
  value: unknown,
  filename: string,
  runId: string,
): EvidenceOperationReceipt {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ["schema_version", "operation_key", "record"]) ||
    (value.schema_version !== "startup_opportunity.evidence_store_operation.v1" &&
      value.schema_version !== "startup_opportunity.evidence_store_operation.v2") ||
    !isSha256(value.operation_key)
  ) {
    throw new StoreError("recovery.invalid_operation", "Evidence operation receipt is invalid", {
      path: `.store/operations/${filename}`,
    });
  }
  let record: EvidenceSubstrateRecord;
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
  const expectedReceiptVersion =
    record.schema_version === "startup_opportunity.evidence_store_record.v1"
      ? "startup_opportunity.evidence_store_operation.v1"
      : "startup_opportunity.evidence_store_operation.v2";
  const expectedKey =
    record.schema_version === "startup_opportunity.evidence_store_record.v1"
      ? expectedEvidenceOperationKey(
          record.canonical_url,
          record.content_hash,
          record.research_goal,
        )
      : expectedEvidenceOperationKeyV2(record.source, record.content_hash, record.research_goal);
  const expectedFilename = `evidence-${sha256Hex(value.operation_key)}.json`;
  if (
    filename !== expectedFilename ||
    value.schema_version !== expectedReceiptVersion ||
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
  readonly records: EvidenceSubstrateRecord[];
  readonly validBytes: number;
} {
  const records: EvidenceSubstrateRecord[] = [];
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

async function appendRecord(filename: string, record: EvidenceSubstrateRecord): Promise<void> {
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

  async record(
    input: RecordLegacyEvidenceInput,
  ): Promise<RecordEvidenceResult<EvidenceStoreRecord>>;
  async record(
    input: RecordMaterializedEvidenceInput,
  ): Promise<RecordEvidenceResult<EvidenceStoreRecordV2>>;
  async record(input: RecordEvidenceInput): Promise<RecordEvidenceResult>;
  async record(input: RecordEvidenceInput): Promise<RecordEvidenceResult> {
    validateRunId(input.runId);
    assertNonEmpty(input.unitId, "unitId");
    assertNonEmpty(input.researchGoal, "researchGoal");
    await assertRunIsCurrentContinuationLeaf(this.runsRoot, input.runId);
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      await assertRunIsCurrentContinuationLeaf(this.runsRoot, input.runId);
      return this.recordLocked(runRoot, input);
    });
  }

  async recordLocked(runRoot: string, input: RecordEvidenceInput): Promise<RecordEvidenceResult> {
    const rawBytes =
      typeof input.rawContent === "string"
        ? Buffer.from(input.rawContent, "utf8")
        : Buffer.from(input.rawContent);
    const contentHash = sha256Bytes(rawBytes);
    const identity =
      "url" in input && typeof input.url === "string"
        ? ({ version: "v1", canonicalUrl: canonicalizeSourceUrl(input.url) } as const)
        : ({ version: "v2", source: canonicalizeSource(input.source) } as const);
    const stableOperationKey =
      identity.version === "v1"
        ? expectedEvidenceOperationKey(identity.canonicalUrl, contentHash, input.researchGoal)
        : expectedEvidenceOperationKeyV2(identity.source, contentHash, input.researchGoal);
    if (input.operationKey !== undefined && input.operationKey !== stableOperationKey) {
      throw new StoreError(
        "operation.key_mismatch",
        "Evidence operation key must match the canonical source/content/goal tuple",
        { expected: stableOperationKey, actual: input.operationKey },
      );
    }
    const operationHex = sha256Hex(stableOperationKey);
    const contentHex = sha256Hex(contentHash);
    const common = {
      evidence_id: `ev_${operationHex}`,
      run_id: input.runId,
      unit_id: input.unitId,
      content_hash: contentHash,
      research_goal: input.researchGoal,
      raw_content_ref: `evidence/raw/sha256-${contentHex}.bin`,
      operation_key: stableOperationKey,
      recorded_at: input.recordedAt ?? new Date().toISOString(),
    };
    let record: EvidenceSubstrateRecord =
      identity.version === "v1"
        ? {
            schema_version: "startup_opportunity.evidence_store_record.v1",
            ...common,
            canonical_url: identity.canonicalUrl,
            source_hash: sha256Bytes(identity.canonicalUrl),
          }
        : {
            schema_version: "startup_opportunity.evidence_store_record.v2",
            ...common,
            source: identity.source,
            source_hash: sha256Bytes(canonicalJson(identity.source)),
          };
    record = validateEvidenceRecord(record, input.runId);
    const receipt: EvidenceOperationReceipt = {
      schema_version:
        identity.version === "v1"
          ? "startup_opportunity.evidence_store_operation.v1"
          : "startup_opportunity.evidence_store_operation.v2",
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

  async readExactRecord(runId: string, ref: string): Promise<EvidenceSubstrateRecord> {
    validateRunId(runId);
    const runRoot = await openRunDirectory(this.runsRoot, runId);
    return withRunLock(runRoot, () => this.readExactRecordLocked(runRoot, runId, ref));
  }

  async listRecords(runId: string): Promise<readonly EvidenceSubstrateRecord[]> {
    validateRunId(runId);
    const runRoot = await openRunDirectoryReadOnly(this.runsRoot, runId);
    return this.listRecordsLocked(runRoot, runId);
  }

  async readExactRecordLocked(
    runRoot: string,
    runId: string,
    ref: string,
  ): Promise<EvidenceSubstrateRecord> {
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

  async listRecordsLocked(
    runRoot: string,
    runId: string,
  ): Promise<readonly EvidenceSubstrateRecord[]> {
    const contents = await readFile(await resolveRunPath(runRoot, "evidence/manifest.jsonl"));
    const parsed = parseManifest(contents, runId);
    if (parsed.validBytes !== contents.length) {
      throw new StoreError("evidence.corrupt_tail", "repair evidence manifest before reading");
    }
    return parsed.records;
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

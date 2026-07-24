import { open, readdir, readFile, truncate } from "node:fs/promises";
import { publishTemp, writeSyncedTemp } from "../artifact-store/atomic-file.js";
import { canonicalJson, isSha256, operationKey, sha256Hex } from "../artifact-store/canonical.js";
import { isNodeError, resolveRunPath, validateArtifactRef } from "../artifact-store/path-policy.js";
import { StoreError } from "../artifact-store/store-error.js";
import type { ArtifactValidator } from "../validators/artifact-validator.js";

export type JsonlPath = "events.jsonl" | "decisions.jsonl";

interface LogOperationReceipt {
  readonly schema_version: "startup_opportunity.jsonl_operation.v1";
  readonly operation_key: string;
  readonly run_id: string;
  readonly log_path: JsonlPath;
  readonly record_id: string;
  readonly record: Record<string, unknown>;
}

export interface JsonlRepairResult {
  readonly path: string;
  readonly truncatedBytes: number;
  readonly replayedRecordIds: readonly string[];
}

function recordId(record: Record<string, unknown>): string {
  const id = record.event_id ?? record.decision_id;
  if (typeof id !== "string") {
    throw new StoreError("log.missing_id", "JSONL record requires an event or decision id");
  }
  return id;
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

function expectedLogOperationKey(
  runId: string,
  logPath: JsonlPath,
  record: Record<string, unknown>,
): string {
  return operationKey("append_jsonl", { run_id: runId, log_path: logPath, record });
}

function parseCompleteLines(
  contents: Buffer,
  logPath: string,
): {
  readonly records: readonly Record<string, unknown>[];
  readonly validBytes: number;
} {
  const records: Record<string, unknown>[] = [];
  const recordsById = new Map<string, Record<string, unknown>>();
  let validBytes = 0;
  let offset = 0;
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
      } catch (error) {
        throw new StoreError("log.corrupt_middle", "JSONL contains a corrupt complete record", {
          path: logPath,
          offset,
          reason: error instanceof Error ? error.message : "invalid JSON",
        });
      }
      if (!isRecord(value)) {
        throw new StoreError("log.corrupt_middle", "JSONL complete record is not an object", {
          path: logPath,
          offset,
        });
      }
      const id = recordId(value);
      const previous = recordsById.get(id);
      if (previous) {
        throw new StoreError(
          canonicalJson(previous) === canonicalJson(value) ? "log.duplicate_id" : "log.id_conflict",
          "JSONL contains a duplicate record id",
          { path: logPath, recordId: id, offset },
        );
      }
      recordsById.set(id, value);
      records.push(value);
    }
    validBytes = newline + 1;
    offset = newline + 1;
  }
  return { records, validBytes };
}

async function appendBytes(filename: string, contents: string): Promise<void> {
  const handle = await open(filename, "a", 0o600);
  try {
    await handle.write(contents, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function expectedRecordSchema(logPath: JsonlPath): string {
  return logPath === "events.jsonl"
    ? "startup_opportunity.event.v1"
    : "startup_opportunity.decision.v1";
}

function validateLogOperationReceipt(
  value: unknown,
  filename: string,
  runId: string,
  validator: ArtifactValidator,
): LogOperationReceipt {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "operation_key",
      "run_id",
      "log_path",
      "record_id",
      "record",
    ]) ||
    value.schema_version !== "startup_opportunity.jsonl_operation.v1" ||
    !isSha256(value.operation_key) ||
    value.run_id !== runId ||
    (value.log_path !== "events.jsonl" && value.log_path !== "decisions.jsonl") ||
    !isRecord(value.record)
  ) {
    throw new StoreError("recovery.invalid_operation", "JSONL operation receipt is invalid", {
      path: `.store/operations/${filename}`,
    });
  }
  const receipt = value as unknown as LogOperationReceipt;
  let payloadRecordId: string;
  try {
    payloadRecordId = recordId(receipt.record);
  } catch {
    throw new StoreError(
      "recovery.invalid_operation",
      "JSONL receipt payload has no valid record id",
      { path: `.store/operations/${filename}` },
    );
  }
  if (
    filename !== `log-${sha256Hex(receipt.operation_key)}.json` ||
    receipt.record_id !== payloadRecordId ||
    receipt.operation_key !==
      expectedLogOperationKey(receipt.run_id, receipt.log_path, receipt.record) ||
    receipt.record.schema_version !== expectedRecordSchema(receipt.log_path)
  ) {
    throw new StoreError(
      "recovery.invalid_operation",
      "JSONL receipt identity differs from its filename, log type, or record",
      { path: `.store/operations/${filename}` },
    );
  }
  const validation = validator.validateDocument(receipt.record, receipt.log_path);
  if (!validation.valid || receipt.record.run_id !== runId) {
    throw new StoreError("recovery.invalid_operation", "JSONL receipt record is invalid", {
      path: `.store/operations/${filename}`,
      errors: validation.errors,
    });
  }
  return receipt;
}

export class JsonlStore {
  constructor(private readonly validator: ArtifactValidator) {}

  async appendValidated(
    runRoot: string,
    runId: string,
    logPath: JsonlPath,
    record: Record<string, unknown>,
    suppliedOperationKey?: string,
  ): Promise<"appended" | "idempotent_replay"> {
    const validation = this.validator.validateDocument(record, logPath);
    if (!validation.valid || record.schema_version !== expectedRecordSchema(logPath)) {
      throw new StoreError("log.schema_invalid", "JSONL record is not schema-valid", {
        errors: validation.errors,
      });
    }
    if (record.run_id !== runId) {
      throw new StoreError("reference.run_mismatch", "JSONL record belongs to another Run", {
        runId,
        recordRunId: record.run_id,
      });
    }
    const id = recordId(record);
    const filename = await resolveRunPath(runRoot, logPath);
    const contents = await readFile(filename);
    const parsed = parseCompleteLines(contents, logPath);
    const existingRecord = parsed.records.find((item) => recordId(item) === id);
    if (existingRecord && canonicalJson(existingRecord) !== canonicalJson(record)) {
      throw new StoreError("write.conflict", "JSONL record id has different content", {
        path: logPath,
        recordId: id,
      });
    }
    if (parsed.validBytes !== contents.length) {
      throw new StoreError("log.corrupt_tail", "repair JSONL tail before appending", {
        path: logPath,
      });
    }
    const stableOperationKey = expectedLogOperationKey(runId, logPath, record);
    if (suppliedOperationKey !== undefined && suppliedOperationKey !== stableOperationKey) {
      throw new StoreError(
        "operation.key_mismatch",
        "JSONL operation key must match the canonical record identity",
        { expected: stableOperationKey, actual: suppliedOperationKey },
      );
    }
    const hex = sha256Hex(stableOperationKey);
    const receipt: LogOperationReceipt = {
      schema_version: "startup_opportunity.jsonl_operation.v1",
      operation_key: stableOperationKey,
      run_id: runId,
      log_path: logPath,
      record_id: id,
      record,
    };
    const receiptPath = `.store/operations/log-${hex}.json`;
    const receiptFile = await resolveRunPath(runRoot, receiptPath, { createParents: true });
    try {
      const existing = JSON.parse(await readFile(receiptFile, "utf8")) as unknown;
      if (canonicalJson(existing) !== canonicalJson(receipt)) {
        throw new StoreError(
          "write.operation_conflict",
          "operation key was previously used with different log content",
          { operationKey: stableOperationKey },
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
      const tempPath = `.store/temp/log-${hex}.receipt.tmp`;
      await writeSyncedTemp(runRoot, tempPath, `${canonicalJson(receipt)}\n`);
      await publishTemp(runRoot, tempPath, receiptPath);
    }

    if (existingRecord) {
      return "idempotent_replay";
    }
    await appendBytes(filename, `${canonicalJson(record)}\n`);
    return "appended";
  }

  async readExactRecord(
    runRoot: string,
    runId: string,
    ref: string,
    expectedLogPath?: JsonlPath,
  ): Promise<Record<string, unknown>> {
    const parsedRef = validateArtifactRef(ref);
    if (
      (parsedRef.path !== "events.jsonl" && parsedRef.path !== "decisions.jsonl") ||
      (expectedLogPath !== undefined && parsedRef.path !== expectedLogPath)
    ) {
      throw new StoreError(
        "reference.type_mismatch",
        "ref does not target the expected JSONL log",
        {
          ref,
          expectedLogPath,
        },
      );
    }
    if (parsedRef.fragment === null) {
      throw new StoreError(
        "reference.fragment_missing",
        "JSONL ref must identify one exact record fragment",
        { ref },
      );
    }
    const logPath = parsedRef.path;
    const contents = await readFile(await resolveRunPath(runRoot, logPath));
    const parsed = parseCompleteLines(contents, logPath);
    if (parsed.validBytes !== contents.length) {
      throw new StoreError("log.corrupt_tail", "JSONL ref cannot resolve through a partial tail", {
        path: logPath,
      });
    }
    const record = parsed.records.find((candidate) => recordId(candidate) === parsedRef.fragment);
    if (record === undefined) {
      throw new StoreError("reference.fragment_missing", "JSONL record fragment is missing", {
        ref,
      });
    }
    const validation = this.validator.validateDocument(record, logPath);
    if (!validation.valid || record.schema_version !== expectedRecordSchema(logPath)) {
      throw new StoreError("reference.type_mismatch", "JSONL record has the wrong document type", {
        ref,
        expectedSchemaVersion: expectedRecordSchema(logPath),
        actualSchemaVersion: record.schema_version,
        errors: validation.errors,
      });
    }
    if (record.run_id !== runId) {
      throw new StoreError("reference.run_mismatch", "JSONL record belongs to another Run", {
        ref,
        runId,
        recordRunId: record.run_id,
      });
    }
    const operationKey = expectedLogOperationKey(runId, logPath, record);
    const receiptName = `log-${sha256Hex(operationKey)}.json`;
    let receiptValue: unknown;
    try {
      receiptValue = JSON.parse(
        await readFile(await resolveRunPath(runRoot, `.store/operations/${receiptName}`), "utf8"),
      ) as unknown;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new StoreError(
          "recovery.missing_operation",
          "JSONL record does not have its deterministic operation receipt",
          { ref },
        );
      }
      throw error;
    }
    const receipt = validateLogOperationReceipt(receiptValue, receiptName, runId, this.validator);
    if (
      receipt.log_path !== logPath ||
      receipt.record_id !== parsedRef.fragment ||
      canonicalJson(receipt.record) !== canonicalJson(record)
    ) {
      throw new StoreError(
        "write.conflict",
        "JSONL record differs from its deterministic operation receipt",
        { ref },
      );
    }
    return record;
  }

  async repair(runRoot: string, runId: string, logPath: JsonlPath): Promise<JsonlRepairResult> {
    const filename = await resolveRunPath(runRoot, logPath);
    const contents = await readFile(filename);
    const parsed = parseCompleteLines(contents, logPath);
    const truncatedBytes = contents.length - parsed.validBytes;
    if (truncatedBytes > 0) {
      await truncate(filename, parsed.validBytes);
    }
    for (const record of parsed.records) {
      const validation = this.validator.validateDocument(record, logPath);
      if (!validation.valid || record.run_id !== runId) {
        throw new StoreError("log.invalid_record", "JSONL contains an invalid complete record", {
          path: logPath,
          recordId: recordId(record),
          errors: validation.errors,
        });
      }
    }

    const records = [...parsed.records];
    const receiptsByRecordId = new Map<string, LogOperationReceipt>();
    const operations = await resolveRunPath(runRoot, ".store/operations", { createParents: true });
    const replayed: string[] = [];
    for (const entry of (await readdir(operations)).sort()) {
      if (!entry.startsWith("log-") || !entry.endsWith(".json")) {
        continue;
      }
      const value = JSON.parse(await readFile(`${operations}/${entry}`, "utf8")) as unknown;
      const receipt = validateLogOperationReceipt(value, entry, runId, this.validator);
      if (receipt.log_path !== logPath) {
        continue;
      }
      if (receiptsByRecordId.has(receipt.record_id)) {
        throw new StoreError("recovery.invalid_operation", "record id has multiple receipts", {
          path: `.store/operations/${entry}`,
          recordId: receipt.record_id,
        });
      }
      receiptsByRecordId.set(receipt.record_id, receipt);
      const matching = records.find((record) => recordId(record) === receipt.record_id);
      if (matching && canonicalJson(matching) !== canonicalJson(receipt.record)) {
        throw new StoreError("write.conflict", "JSONL operation conflicts with stored record", {
          path: logPath,
          recordId: receipt.record_id,
        });
      }
    }
    for (const record of records) {
      const id = recordId(record);
      const receipt = receiptsByRecordId.get(id);
      if (!receipt || canonicalJson(receipt.record) !== canonicalJson(record)) {
        throw new StoreError(
          "recovery.missing_operation",
          "JSONL record does not have one matching operation receipt",
          { path: logPath, recordId: id },
        );
      }
    }
    for (const receipt of receiptsByRecordId.values()) {
      if (!records.some((record) => recordId(record) === receipt.record_id)) {
        await appendBytes(filename, `${canonicalJson(receipt.record)}\n`);
        records.push(receipt.record);
        replayed.push(receipt.record_id);
      }
    }
    return { path: logPath, truncatedBytes, replayedRecordIds: replayed.sort() };
  }
}

import { open, readdir, readFile, truncate } from "node:fs/promises";
import { publishTemp, writeSyncedTemp } from "../artifact-store/atomic-file.js";
import { canonicalJson, operationKey, sha256Hex } from "../artifact-store/canonical.js";
import { isNodeError, resolveRunPath } from "../artifact-store/path-policy.js";
import { StoreError } from "../artifact-store/store-error.js";
import type { ArtifactValidator } from "../validators/artifact-validator.js";

interface LogOperationReceipt {
  readonly schema_version: "startup_opportunity.jsonl_operation.v1";
  readonly operation_key: string;
  readonly run_id: string;
  readonly log_path: "events.jsonl" | "decisions.jsonl";
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

function parseCompleteLines(
  contents: Buffer,
  logPath: string,
): {
  readonly records: readonly Record<string, unknown>[];
  readonly validBytes: number;
} {
  const records: Record<string, unknown>[] = [];
  let validBytes = 0;
  let offset = 0;
  while (offset < contents.length) {
    const newline = contents.indexOf(0x0a, offset);
    if (newline < 0) {
      break;
    }
    const line = contents.subarray(offset, newline).toString("utf8");
    if (line.length > 0) {
      try {
        const value = JSON.parse(line) as unknown;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new Error("record is not an object");
        }
        records.push(value as Record<string, unknown>);
      } catch (error) {
        throw new StoreError("log.corrupt_middle", "JSONL contains a corrupt complete record", {
          path: logPath,
          offset,
          reason: error instanceof Error ? error.message : "invalid JSON",
        });
      }
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

export class JsonlStore {
  constructor(private readonly validator: ArtifactValidator) {}

  async appendValidated(
    runRoot: string,
    runId: string,
    logPath: "events.jsonl" | "decisions.jsonl",
    record: Record<string, unknown>,
    suppliedOperationKey?: string,
  ): Promise<"appended" | "idempotent_replay"> {
    const validation = this.validator.validateDocument(record, logPath);
    if (!validation.valid) {
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
    const stableOperationKey =
      suppliedOperationKey ??
      operationKey("append_jsonl", { run_id: runId, log_path: logPath, record });
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

  async repair(
    runRoot: string,
    runId: string,
    logPath: "events.jsonl" | "decisions.jsonl",
  ): Promise<JsonlRepairResult> {
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
    const operations = await resolveRunPath(runRoot, ".store/operations", { createParents: true });
    const replayed: string[] = [];
    for (const entry of (await readdir(operations)).sort()) {
      if (!entry.startsWith("log-") || !entry.endsWith(".json")) {
        continue;
      }
      const receipt = JSON.parse(
        await readFile(`${operations}/${entry}`, "utf8"),
      ) as LogOperationReceipt;
      if (
        receipt.schema_version !== "startup_opportunity.jsonl_operation.v1" ||
        receipt.run_id !== runId ||
        receipt.log_path !== logPath
      ) {
        continue;
      }
      const matching = records.find((record) => recordId(record) === receipt.record_id);
      if (matching && canonicalJson(matching) !== canonicalJson(receipt.record)) {
        throw new StoreError("write.conflict", "JSONL operation conflicts with stored record", {
          path: logPath,
          recordId: receipt.record_id,
        });
      }
      if (!matching) {
        const validation = this.validator.validateDocument(receipt.record, logPath);
        if (!validation.valid) {
          throw new StoreError("recovery.invalid_operation", "JSONL operation record is invalid", {
            path: logPath,
            errors: validation.errors,
          });
        }
        await appendBytes(filename, `${canonicalJson(receipt.record)}\n`);
        records.push(receipt.record);
        replayed.push(receipt.record_id);
      }
    }
    return { path: logPath, truncatedBytes, replayedRecordIds: replayed.sort() };
  }
}

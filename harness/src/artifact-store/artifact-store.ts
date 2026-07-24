import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ArtifactValidator, DocumentBundleEntry } from "../validators/artifact-validator.js";
import { publishTemp, removeTemp, writeSyncedTemp } from "./atomic-file.js";
import { canonicalContentHash, canonicalJson, operationKey, sha256Hex } from "./canonical.js";
import {
  isNodeError,
  openRunDirectory,
  resolveRunPath,
  validateArtifactRef,
  validateRelativePath,
  validateRunId,
} from "./path-policy.js";
import { withRunLock } from "./run-lock.js";
import { StoreError } from "./store-error.js";

export type ArtifactFaultBoundary = "after_intent" | "after_temp_write" | "after_publish";

export interface FormalArtifactEnvelope extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.artifact_envelope.v1";
  readonly artifact_type: string;
  readonly artifact_path: string;
  readonly run_id: string;
  readonly created_at: string;
  readonly producer_role: string;
  readonly input_refs: readonly string[];
  readonly content_hash: string;
  readonly document: Record<string, unknown>;
}

interface ArtifactOperationReceipt {
  readonly schema_version: "startup_opportunity.artifact_store_operation.v1";
  readonly operation_key: string;
  readonly run_id: string;
  readonly artifact_path: string;
  readonly artifact_type: string;
  readonly content_hash: string;
  readonly envelope: FormalArtifactEnvelope;
}

export interface PublishArtifactInput {
  readonly runId: string;
  readonly envelope: FormalArtifactEnvelope;
  readonly operationKey?: string;
  readonly faultAt?: ArtifactFaultBoundary;
}

export interface PublishArtifactResult {
  readonly schemaVersion: "startup_opportunity.artifact_publish_result.v1";
  readonly runId: string;
  readonly artifactPath: string;
  readonly contentHash: string;
  readonly operationKey: string;
  readonly status: "published" | "idempotent_replay";
}

export interface ArtifactRecoveryResult {
  readonly recoveredArtifactPaths: readonly string[];
  readonly removedTemporaryPaths: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvelope(value: unknown): value is FormalArtifactEnvelope {
  return (
    isRecord(value) &&
    value.schema_version === "startup_opportunity.artifact_envelope.v1" &&
    typeof value.artifact_path === "string" &&
    typeof value.run_id === "string" &&
    typeof value.artifact_type === "string" &&
    typeof value.content_hash === "string" &&
    isRecord(value.document)
  );
}

function assertFault(boundary: ArtifactFaultBoundary, requested?: ArtifactFaultBoundary): void {
  if (boundary === requested) {
    throw new StoreError("fault.injected", `injected failure at ${boundary}`, { boundary });
  }
}

function isFormalTargetAllowed(relativePath: string): boolean {
  return !(
    relativePath === "manifest.json" ||
    relativePath === "events.jsonl" ||
    relativePath === "decisions.jsonl" ||
    relativePath.startsWith(".store/") ||
    relativePath === "evidence/manifest.jsonl" ||
    relativePath.startsWith("evidence/raw/")
  );
}

function pathLikeRef(ref: string): boolean {
  const target = ref.split("#", 1)[0] ?? "";
  return target.includes("/") || target.endsWith(".json") || target.endsWith(".jsonl");
}

function collectPathRefs(envelope: FormalArtifactEnvelope): readonly string[] {
  const refs = new Set<string>();
  for (const ref of envelope.input_refs) {
    if (pathLikeRef(ref)) {
      refs.add(ref);
    }
  }
  const visit = (value: unknown, key = ""): void => {
    if (Array.isArray(value)) {
      if (key.endsWith("_refs") || key === "artifact_refs" || key === "input_refs") {
        for (const item of value) {
          if (typeof item === "string" && pathLikeRef(item)) {
            refs.add(item);
          }
        }
      } else {
        for (const item of value) {
          visit(item);
        }
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, childKey);
    }
  };
  visit(envelope.document);
  return [...refs].sort();
}

async function listFiles(directory: string, prefix = ""): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (relative === ".store" || relative === "evidence/raw") {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new StoreError("path.symlink_escape", "Run contains a symlink", { path: relative });
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path.join(directory, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

async function jsonlFragmentExists(filename: string, fragment: string): Promise<boolean> {
  const lines = (await readFile(filename, "utf8")).split("\n").filter(Boolean);
  return lines.some((line) => {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      return record.event_id === fragment || record.decision_id === fragment;
    } catch {
      return false;
    }
  });
}

function fragmentExists(value: unknown, fragment: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => fragmentExists(item, fragment));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.event_id === fragment ||
    value.decision_id === fragment ||
    value.gap_id === fragment ||
    value.checkpoint_id === fragment
  ) {
    return true;
  }
  return Object.values(value).some((child) => fragmentExists(child, fragment));
}

async function assertReferenceExists(
  runRoot: string,
  ref: string,
  pending: FormalArtifactEnvelope,
): Promise<void> {
  const parsed = validateArtifactRef(ref);
  if (parsed.path === pending.artifact_path) {
    if (parsed.fragment !== null && !fragmentExists(pending, parsed.fragment)) {
      throw new StoreError("reference.fragment_missing", "pending artifact fragment is missing", {
        ref,
      });
    }
    return;
  }
  const filename = await resolveRunPath(runRoot, parsed.path);
  try {
    const metadata = await stat(filename);
    if (!metadata.isFile()) {
      throw new StoreError("reference.missing", "artifact ref target is not a file", { ref });
    }
  } catch (error) {
    if (
      isNodeError(error, "ENOENT") ||
      (error instanceof StoreError && error.code === "path.parent_missing")
    ) {
      throw new StoreError("reference.missing", "artifact ref target is missing", { ref });
    }
    throw error;
  }
  if (parsed.fragment === null) {
    return;
  }
  const exists = parsed.path.endsWith(".jsonl")
    ? await jsonlFragmentExists(filename, parsed.fragment)
    : fragmentExists(JSON.parse(await readFile(filename, "utf8")) as unknown, parsed.fragment);
  if (!exists) {
    throw new StoreError("reference.fragment_missing", "artifact ref fragment is missing", { ref });
  }
}

export class ArtifactStore {
  constructor(
    private readonly runsRoot: string,
    private readonly validator: ArtifactValidator,
  ) {}

  async publish(input: PublishArtifactInput): Promise<PublishArtifactResult> {
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, () => this.publishLocked(runRoot, input));
  }

  async publishLocked(
    runRoot: string,
    input: PublishArtifactInput,
  ): Promise<PublishArtifactResult> {
    validateRunId(input.runId);
    this.validateEnvelopeBoundary(input.runId, input.envelope);
    await this.validateEnvelopeReferences(runRoot, input.envelope);

    const computedOperationKey = operationKey("publish_artifact", {
      run_id: input.runId,
      artifact_path: input.envelope.artifact_path,
      artifact_type: input.envelope.artifact_type,
      content_hash: input.envelope.content_hash,
    });
    const stableOperationKey = input.operationKey ?? computedOperationKey;
    const operationHex = sha256Hex(stableOperationKey);
    const receipt: ArtifactOperationReceipt = {
      schema_version: "startup_opportunity.artifact_store_operation.v1",
      operation_key: stableOperationKey,
      run_id: input.runId,
      artifact_path: input.envelope.artifact_path,
      artifact_type: input.envelope.artifact_type,
      content_hash: input.envelope.content_hash,
      envelope: input.envelope,
    };
    const receiptPath = `.store/operations/artifact-${operationHex}.json`;
    const receiptFilename = await resolveRunPath(runRoot, receiptPath, { createParents: true });
    let receiptExisted = false;
    try {
      const existing = JSON.parse(await readFile(receiptFilename, "utf8")) as unknown;
      receiptExisted = true;
      if (canonicalJson(existing) !== canonicalJson(receipt)) {
        throw new StoreError(
          "write.operation_conflict",
          "operation key was previously used with different content",
          { operationKey: stableOperationKey },
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }

    const target = await resolveRunPath(runRoot, input.envelope.artifact_path, {
      createParents: true,
    });
    try {
      const existing = JSON.parse(await readFile(target, "utf8")) as unknown;
      if (receiptExisted && canonicalJson(existing) === canonicalJson(input.envelope)) {
        return {
          schemaVersion: "startup_opportunity.artifact_publish_result.v1",
          runId: input.runId,
          artifactPath: input.envelope.artifact_path,
          contentHash: input.envelope.content_hash,
          operationKey: stableOperationKey,
          status: "idempotent_replay",
        };
      }
      throw new StoreError("write.conflict", "formal artifact path is already occupied", {
        path: input.envelope.artifact_path,
      });
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }

    if (!receiptExisted) {
      const receiptTemp = `.store/temp/artifact-${operationHex}.receipt.tmp`;
      await writeSyncedTemp(runRoot, receiptTemp, `${canonicalJson(receipt)}\n`);
      await publishTemp(runRoot, receiptTemp, receiptPath);
    }
    assertFault("after_intent", input.faultAt);

    const temporaryPath = `.store/temp/artifact-${operationHex}.publish.tmp`;
    await writeSyncedTemp(runRoot, temporaryPath, `${canonicalJson(input.envelope)}\n`);
    assertFault("after_temp_write", input.faultAt);
    await publishTemp(runRoot, temporaryPath, input.envelope.artifact_path);
    assertFault("after_publish", input.faultAt);
    return {
      schemaVersion: "startup_opportunity.artifact_publish_result.v1",
      runId: input.runId,
      artifactPath: input.envelope.artifact_path,
      contentHash: input.envelope.content_hash,
      operationKey: stableOperationKey,
      status: "published",
    };
  }

  async recoverLocked(runRoot: string, runId: string): Promise<ArtifactRecoveryResult> {
    const operationDirectory = await resolveRunPath(runRoot, ".store/operations", {
      createParents: true,
    });
    const tempDirectory = await resolveRunPath(runRoot, ".store/temp", { createParents: true });
    const recovered: string[] = [];
    const retainedTemps = new Set<string>();
    for (const entry of (await readdir(operationDirectory)).sort()) {
      if (!entry.startsWith("artifact-") || !entry.endsWith(".json")) {
        continue;
      }
      const receiptPath = `.store/operations/${entry}`;
      const receipt = JSON.parse(
        await readFile(await resolveRunPath(runRoot, receiptPath), "utf8"),
      ) as ArtifactOperationReceipt;
      if (
        receipt.schema_version !== "startup_opportunity.artifact_store_operation.v1" ||
        receipt.run_id !== runId ||
        !isEnvelope(receipt.envelope)
      ) {
        throw new StoreError(
          "recovery.invalid_operation",
          "artifact operation receipt is invalid",
          {
            path: receiptPath,
          },
        );
      }
      this.validateEnvelopeBoundary(runId, receipt.envelope);
      const hex = sha256Hex(receipt.operation_key);
      const tempPath = `.store/temp/artifact-${hex}.publish.tmp`;
      const target = await resolveRunPath(runRoot, receipt.artifact_path, { createParents: true });
      try {
        const current = JSON.parse(await readFile(target, "utf8")) as unknown;
        if (canonicalJson(current) !== canonicalJson(receipt.envelope)) {
          if (receipt.artifact_path.startsWith("checkpoints/")) {
            continue;
          }
          throw new StoreError("write.conflict", "published artifact differs from operation", {
            path: receipt.artifact_path,
          });
        }
        continue;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
      }
      try {
        const temporary = JSON.parse(
          await readFile(await resolveRunPath(runRoot, tempPath), "utf8"),
        ) as unknown;
        if (canonicalJson(temporary) !== canonicalJson(receipt.envelope)) {
          throw new StoreError("write.temp_conflict", "temporary artifact differs from operation", {
            path: tempPath,
          });
        }
        retainedTemps.add(path.basename(tempPath));
        await publishTemp(runRoot, tempPath, receipt.artifact_path);
        recovered.push(receipt.artifact_path);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
        await rm(await resolveRunPath(runRoot, receiptPath), { force: true });
      }
    }

    const removedTemps: string[] = [];
    for (const entry of (await readdir(tempDirectory)).sort()) {
      if (entry.startsWith("artifact-") && !retainedTemps.has(entry)) {
        await removeTemp(runRoot, `.store/temp/${entry}`);
        removedTemps.push(`.store/temp/${entry}`);
      }
    }
    return {
      recoveredArtifactPaths: recovered.sort(),
      removedTemporaryPaths: removedTemps.sort(),
    };
  }

  async listFormalDocuments(runRoot: string): Promise<readonly DocumentBundleEntry[]> {
    const documents: DocumentBundleEntry[] = [];
    for (const relativePath of await listFiles(runRoot)) {
      if (!relativePath.endsWith(".json") || relativePath === "manifest.json") {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(
          await readFile(await resolveRunPath(runRoot, relativePath), "utf8"),
        ) as unknown;
      } catch {
        documents.push({
          path: relativePath,
          document: { schema_version: "startup_opportunity.corrupt_stored_json.v1" },
        });
        continue;
      }
      if (isEnvelope(value)) {
        documents.push({ path: relativePath, document: value });
      } else if (isRecord(value)) {
        documents.push({ path: relativePath, document: value });
      }
    }
    return documents.sort((left, right) => left.path.localeCompare(right.path));
  }

  validateEnvelopeBoundary(runId: string, envelope: FormalArtifactEnvelope): void {
    const result = this.validator.validateDocument(envelope, envelope.artifact_path);
    if (!result.valid) {
      throw new StoreError("artifact.schema_invalid", "formal artifact envelope is invalid", {
        errors: result.errors,
      });
    }
    validateRelativePath(envelope.artifact_path);
    if (!isFormalTargetAllowed(envelope.artifact_path)) {
      throw new StoreError("path.reserved", "formal artifact path is reserved for Store state", {
        path: envelope.artifact_path,
      });
    }
    if (envelope.run_id !== runId || envelope.document.run_id !== runId) {
      throw new StoreError("reference.run_mismatch", "artifact belongs to a different Run", {
        runId,
        envelopeRunId: envelope.run_id,
        documentRunId: envelope.document.run_id,
      });
    }
    const computedHash = canonicalContentHash(envelope.document);
    if (computedHash !== envelope.content_hash) {
      throw new StoreError(
        "artifact.hash_mismatch",
        "content hash does not match canonical document",
        {
          expected: computedHash,
          actual: envelope.content_hash,
        },
      );
    }
  }

  async validateStoredEnvelope(
    runRoot: string,
    runId: string,
    envelope: FormalArtifactEnvelope,
  ): Promise<void> {
    this.validateEnvelopeBoundary(runId, envelope);
    for (const ref of collectPathRefs(envelope)) {
      await assertReferenceExists(runRoot, ref, envelope);
    }
  }

  private async validateEnvelopeReferences(
    runRoot: string,
    envelope: FormalArtifactEnvelope,
  ): Promise<void> {
    for (const ref of collectPathRefs(envelope)) {
      await assertReferenceExists(runRoot, ref, envelope);
    }
    const documents = [...(await this.listFormalDocuments(runRoot))];
    try {
      const manifest = JSON.parse(
        await readFile(await resolveRunPath(runRoot, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      documents.push({ path: "manifest.json", document: manifest });
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
    const existingIndex = documents.findIndex((entry) => entry.path === envelope.artifact_path);
    if (existingIndex >= 0) {
      documents.splice(existingIndex, 1);
    }
    documents.push({ path: envelope.artifact_path, document: envelope });
    const bundleResult = this.validator.validateDocumentBundle({
      schema_version: "startup_opportunity.document_bundle.v1",
      documents,
    });
    if (!bundleResult.valid) {
      throw new StoreError("artifact.reference_invalid", "formal artifact references are invalid", {
        bundleErrors: bundleResult.bundleErrors,
        documentErrors: bundleResult.documents.flatMap((document) => document.errors),
        referenceErrors: bundleResult.referenceErrors,
      });
    }
  }
}

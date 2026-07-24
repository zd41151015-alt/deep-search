import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore, type FormalArtifactEnvelope } from "../artifact-store/artifact-store.js";
import { atomicReplace, publishTemp, writeSyncedTemp } from "../artifact-store/atomic-file.js";
import {
  canonicalContentHash,
  canonicalJson,
  isSha256,
  operationKey,
  sha256Hex,
} from "../artifact-store/canonical.js";
import { openRunDirectory, resolveRunPath, validateRunId } from "../artifact-store/path-policy.js";
import { withRunLock } from "../artifact-store/run-lock.js";
import { StoreError } from "../artifact-store/store-error.js";
import { type JsonlStore, JsonlStore as RuntimeJsonlStore } from "../run-store/jsonl-store.js";
import type { BeliefSummary, RunManifest } from "../run-store/run-store.js";
import type { ArtifactValidator, DocumentBundle } from "../validators/artifact-validator.js";
import { createArtifactValidator } from "../validators/artifact-validator.js";
import { planningRunStateHash } from "../validators/planning-contract-identities.js";
import {
  type AdaptationPolicyValidator,
  createAdaptationPolicyValidator,
} from "./adaptation-validator.js";
import { loadPlanRevisionApplyPolicy } from "./apply-policy.js";
import { documentMap, type EffectiveDocument, effectiveDocuments, isRecord } from "./contracts.js";
import {
  type AdaptationInputDocument,
  type PlanTransformationResult,
  transformPlan,
} from "./plan-transformer.js";
import { createPlanSemanticValidator, type PlanSemanticValidator } from "./plan-validator.js";

export const PLAN_APPLY_RESULT_VERSION = "startup_opportunity.plan_apply_result.v1" as const;

export type PlanApplyFaultBoundary =
  | "after_intent"
  | "after_control_artifacts"
  | "after_manifest_update"
  | "after_checkpoint_publish";

export interface ApplyPlanRevisionInput {
  readonly runId: string;
  readonly adaptationBundle: DocumentBundle;
  readonly adaptationRefs: readonly string[];
  readonly candidateBundle?: DocumentBundle;
  readonly createdAt: string;
  readonly checkpointCreatedAt: string;
  readonly nextStep: string;
  readonly beliefSummary: BeliefSummary;
  readonly operationKey?: string;
  readonly faultAt?: PlanApplyFaultBoundary;
}

export interface PlanApplyResult {
  readonly schemaVersion: typeof PLAN_APPLY_RESULT_VERSION;
  readonly runId: string;
  readonly operationKey: string;
  readonly status: "applied" | "idempotent_replay";
  readonly revisionCreated: boolean;
  readonly currentPlanRef: string;
  readonly planRevision: number;
  readonly checkpointRef: string;
  readonly adaptationRefs: readonly string[];
}

interface PlanOperationReceipt {
  readonly schema_version: "startup_opportunity.plan_revision_operation.v1";
  readonly operation_key: string;
  readonly run_id: string;
  readonly base_plan_ref: string;
  readonly base_plan_hash: string;
  readonly adaptation_refs: readonly string[];
  readonly adaptation_hashes: readonly string[];
  readonly revision_created: boolean;
  readonly result_plan_ref: string;
  readonly result_plan_hash: string | null;
  readonly control_envelopes: readonly FormalArtifactEnvelope[];
  readonly checkpoint_envelope: FormalArtifactEnvelope;
  readonly manifest: RunManifest;
  readonly events: readonly Record<string, unknown>[];
}

export interface PlanOperationRecoveryResult {
  readonly completedOperationKeys: readonly string[];
  readonly pendingOperationKeys: readonly string[];
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isUniqueSortedStringArray(values: readonly unknown[]): boolean {
  return (
    values.every((value): value is string => typeof value === "string") &&
    canonicalJson(values) === canonicalJson(uniqueSorted(values))
  );
}

function manifestSetsAreDisjoint(manifest: RunManifest): boolean {
  for (const fields of [
    [
      "pending_adaptation_refs",
      "validated_adaptation_refs",
      "rejected_adaptation_refs",
      "applied_adaptation_refs",
    ],
    [
      "completed_units",
      "active_units",
      "failed_units",
      "invalidated_units",
      "skipped_units",
      "cancelled_units",
      "superseded_units",
    ],
  ] as const) {
    const seen = new Set<string>();
    for (const field of fields) {
      const values = manifest[field];
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
        return false;
      }
      for (const value of values) {
        if (seen.has(value)) {
          return false;
        }
        seen.add(value);
      }
    }
  }
  return true;
}

function assertFault(boundary: PlanApplyFaultBoundary, requested?: PlanApplyFaultBoundary): void {
  if (boundary === requested) {
    throw new StoreError("fault.injected", `injected failure at ${boundary}`, { boundary });
  }
}

function receiptPath(operationKey: string): string {
  return `.store/operations/plan-revision-${sha256Hex(operationKey)}.json`;
}

function event(
  runId: string,
  planOperationKey: string,
  eventType: string,
  timestamp: string,
  artifactRefs: readonly string[],
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.event.v1",
    event_id: `${eventType}_${sha256Hex(
      operationKey("plan_runtime_event", {
        operation_key: planOperationKey,
        event_type: eventType,
        artifact_refs: artifactRefs,
      }),
    )}`,
    run_id: runId,
    event_type: eventType,
    timestamp,
    actor: "harness",
    reason: `The validated Plan/Adaptation runtime recorded ${eventType}.`,
    artifact_refs: uniqueSorted(artifactRefs),
  };
}

function envelope(
  runId: string,
  artifactPath: string,
  document: Record<string, unknown>,
  producerRole: string,
  inputRefs: readonly string[],
  createdAt: string,
  version: FormalArtifactEnvelope["schema_version"] = "startup_opportunity.artifact_envelope.v3",
): FormalArtifactEnvelope {
  return {
    schema_version: version,
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    run_id: runId,
    created_at: createdAt,
    producer_role: producerRole,
    input_refs: uniqueSorted(inputRefs),
    content_hash: canonicalContentHash(document),
    document,
  };
}

function validateReceipt(value: unknown, filename: string, runId: string): PlanOperationReceipt {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "operation_key",
      "run_id",
      "base_plan_ref",
      "base_plan_hash",
      "adaptation_refs",
      "adaptation_hashes",
      "revision_created",
      "result_plan_ref",
      "result_plan_hash",
      "control_envelopes",
      "checkpoint_envelope",
      "manifest",
      "events",
    ]) ||
    value.schema_version !== "startup_opportunity.plan_revision_operation.v1" ||
    !isSha256(value.operation_key) ||
    value.run_id !== runId ||
    typeof value.base_plan_ref !== "string" ||
    !isSha256(value.base_plan_hash) ||
    !Array.isArray(value.adaptation_refs) ||
    !Array.isArray(value.adaptation_hashes) ||
    typeof value.revision_created !== "boolean" ||
    typeof value.result_plan_ref !== "string" ||
    !Array.isArray(value.control_envelopes) ||
    !isRecord(value.checkpoint_envelope) ||
    !isRecord(value.manifest) ||
    !Array.isArray(value.events)
  ) {
    throw new StoreError("recovery.invalid_plan_operation", "Plan operation receipt is invalid", {
      filename,
    });
  }
  const receipt = value as unknown as PlanOperationReceipt;
  const expectedOperationKey = operationKey("apply_plan_revision", {
    parent_plan_hash: receipt.base_plan_hash,
    adaptation_refs: uniqueSorted(
      receipt.adaptation_refs.filter((ref): ref is string => typeof ref === "string"),
    ),
  });
  if (
    filename !== path.basename(receiptPath(receipt.operation_key)) ||
    receipt.operation_key !== expectedOperationKey ||
    receipt.adaptation_refs.length === 0 ||
    receipt.adaptation_refs.length !== receipt.adaptation_hashes.length ||
    !isUniqueSortedStringArray(receipt.adaptation_refs) ||
    receipt.adaptation_hashes.some((hash) => !isSha256(hash)) ||
    receipt.manifest.run_id !== runId ||
    receipt.manifest.current_plan_ref !== receipt.result_plan_ref ||
    !receipt.adaptation_refs.every((ref) =>
      receipt.manifest.applied_adaptation_refs.includes(ref),
    ) ||
    !manifestSetsAreDisjoint(receipt.manifest) ||
    (receipt.revision_created
      ? receipt.result_plan_ref === receipt.base_plan_ref || !isSha256(receipt.result_plan_hash)
      : receipt.result_plan_ref !== receipt.base_plan_ref || receipt.result_plan_hash !== null)
  ) {
    throw new StoreError(
      "recovery.invalid_plan_operation",
      "Plan operation receipt identity is inconsistent",
      { filename },
    );
  }
  return receipt;
}

function validateReceiptDocuments(
  receipt: PlanOperationReceipt,
  validator: ArtifactValidator,
  artifacts: ArtifactStore,
): void {
  const manifestValidation = validator.validateDocument(receipt.manifest, "manifest.json");
  const checkpoint = receipt.checkpoint_envelope;
  const checkpointDocument = checkpoint.document;
  const controlPaths = receipt.control_envelopes.map((item) => item.artifact_path);
  const resultPlanEnvelope = receipt.control_envelopes.find(
    (item) => item.artifact_path === receipt.result_plan_ref,
  );
  const eventsValid = receipt.events.every((record) => {
    const result = validator.validateDocument(record, "events.jsonl");
    return result.valid && record.run_id === receipt.run_id;
  });
  let envelopesValid = true;
  try {
    for (const controlEnvelope of receipt.control_envelopes) {
      artifacts.validateEnvelopeBoundary(receipt.run_id, controlEnvelope);
    }
    artifacts.validateEnvelopeBoundary(receipt.run_id, checkpoint);
  } catch {
    envelopesValid = false;
  }
  if (!envelopesValid || !isRecord(checkpointDocument)) {
    throw new StoreError(
      "recovery.invalid_plan_operation",
      "Plan operation receipt envelopes are invalid",
      { operationKey: receipt.operation_key },
    );
  }
  if (
    !manifestValidation.valid ||
    !eventsValid ||
    new Set(controlPaths).size !== controlPaths.length ||
    checkpoint.schema_version !== "startup_opportunity.artifact_envelope.v3" ||
    checkpoint.artifact_type !== "startup_opportunity.checkpoint.v1" ||
    checkpoint.artifact_path !== receipt.manifest.checkpoint_ref ||
    checkpoint.created_at !== receipt.manifest.updated_at ||
    canonicalJson(checkpoint.input_refs) !== canonicalJson(checkpointDocument.input_refs) ||
    canonicalJson(checkpointDocument.manifest_snapshot) !== canonicalJson(receipt.manifest) ||
    checkpointDocument.current_plan_ref !== receipt.manifest.current_plan_ref ||
    checkpointDocument.plan_revision !== receipt.manifest.plan_revision ||
    canonicalJson(checkpointDocument.completed_units) !==
      canonicalJson(receipt.manifest.completed_units) ||
    canonicalJson(checkpointDocument.invalidated_units) !==
      canonicalJson(receipt.manifest.invalidated_units) ||
    canonicalJson(checkpointDocument.artifact_refs) !==
      canonicalJson(receipt.manifest.artifact_refs) ||
    checkpointDocument.latest_gap_snapshot_ref !== receipt.manifest.latest_gap_snapshot_ref ||
    canonicalJson(checkpointDocument.applied_adaptation_refs) !==
      canonicalJson(receipt.manifest.applied_adaptation_refs) ||
    canonicalJson(checkpointDocument.pending_adaptation_refs) !==
      canonicalJson(receipt.manifest.pending_adaptation_refs) ||
    (receipt.revision_created
      ? resultPlanEnvelope?.artifact_type !== "startup_opportunity.research_plan.v1" ||
        resultPlanEnvelope.content_hash !== receipt.result_plan_hash
      : receipt.control_envelopes.length !== 0)
  ) {
    throw new StoreError(
      "recovery.invalid_plan_operation",
      "Plan operation receipt documents are inconsistent",
      { operationKey: receipt.operation_key },
    );
  }
}

async function validateReceiptSources(
  runRoot: string,
  receipt: PlanOperationReceipt,
): Promise<void> {
  try {
    const basePlan = await storedEffectiveDocument(runRoot, receipt.base_plan_ref);
    if (canonicalContentHash(basePlan) !== receipt.base_plan_hash) {
      throw new Error("base hash mismatch");
    }
    for (const [index, adaptationRef] of receipt.adaptation_refs.entries()) {
      const decision = await storedEffectiveDocument(runRoot, adaptationRef);
      if (canonicalContentHash(decision) !== receipt.adaptation_hashes[index]) {
        throw new Error("adaptation hash mismatch");
      }
    }
  } catch (_error) {
    throw new StoreError(
      "recovery.invalid_plan_operation",
      "Plan operation receipt source hashes do not match immutable artifacts",
      { operationKey: receipt.operation_key },
    );
  }
}

async function readManifest(runRoot: string, validator: ArtifactValidator): Promise<RunManifest> {
  const value = JSON.parse(
    await readFile(await resolveRunPath(runRoot, "manifest.json"), "utf8"),
  ) as unknown;
  const validation = validator.validateDocument(value, "manifest.json");
  if (!validation.valid || !isRecord(value)) {
    throw new StoreError("manifest.schema_invalid", "manifest is not schema-valid", {
      errors: validation.errors,
    });
  }
  const manifest = value as RunManifest;
  if (!manifestSetsAreDisjoint(manifest)) {
    throw new StoreError("manifest.state_overlap", "manifest state sets must be disjoint");
  }
  return manifest;
}

async function writeManifest(
  runRoot: string,
  manifest: RunManifest,
  validator: ArtifactValidator,
): Promise<void> {
  const validation = validator.validateDocument(manifest, "manifest.json");
  if (!validation.valid) {
    throw new StoreError("manifest.schema_invalid", "result manifest is not schema-valid", {
      errors: validation.errors,
    });
  }
  if (!manifestSetsAreDisjoint(manifest)) {
    throw new StoreError("manifest.state_overlap", "manifest state sets must be disjoint");
  }
  await atomicReplace(
    runRoot,
    "manifest.json",
    `${canonicalJson(manifest)}\n`,
    sha256Hex(canonicalContentHash(manifest)),
  );
}

async function storedEffectiveDocument(
  runRoot: string,
  relativePath: string,
): Promise<Record<string, unknown>> {
  const value = JSON.parse(
    await readFile(await resolveRunPath(runRoot, relativePath), "utf8"),
  ) as unknown;
  if (!isRecord(value)) {
    throw new StoreError("artifact.invalid", "stored document is not an object", {
      path: relativePath,
    });
  }
  return isRecord(value.document) &&
    [
      "startup_opportunity.artifact_envelope.v1",
      "startup_opportunity.artifact_envelope.v2",
      "startup_opportunity.artifact_envelope.v3",
    ].includes(String(value.schema_version))
    ? value.document
    : value;
}

function isFormalArtifactEnvelope(value: unknown): value is FormalArtifactEnvelope {
  return (
    isRecord(value) &&
    (value.schema_version === "startup_opportunity.artifact_envelope.v1" ||
      value.schema_version === "startup_opportunity.artifact_envelope.v2" ||
      value.schema_version === "startup_opportunity.artifact_envelope.v3") &&
    typeof value.artifact_type === "string" &&
    typeof value.artifact_path === "string" &&
    typeof value.run_id === "string" &&
    isRecord(value.document)
  );
}

async function assertAdaptationBundleMatchesStoredArtifacts(
  runRoot: string,
  runId: string,
  documents: readonly EffectiveDocument[],
  artifacts: ArtifactStore,
): Promise<void> {
  for (const supplied of [...documents]
    .filter((document) => document.path !== "manifest.json")
    .sort((left, right) => left.path.localeCompare(right.path))) {
    let stored: unknown;
    try {
      stored = JSON.parse(
        await readFile(await resolveRunPath(runRoot, supplied.path), "utf8"),
      ) as unknown;
    } catch (_error) {
      throw new StoreError(
        "adaptation.stored_artifact_missing",
        "adaptation bundle document has no readable immutable stored Artifact",
        { artifactPath: supplied.path },
      );
    }
    if (!isFormalArtifactEnvelope(stored)) {
      throw new StoreError(
        "adaptation.stored_artifact_invalid",
        "adaptation bundle document does not resolve to a formal Artifact envelope",
        { artifactPath: supplied.path },
      );
    }
    await artifacts.validateStoredEnvelope(runRoot, runId, stored);
    if (
      stored.artifact_path !== supplied.path ||
      stored.artifact_type !== supplied.schemaVersion ||
      canonicalJson(stored.document) !== canonicalJson(supplied.document) ||
      (supplied.envelope !== null && canonicalJson(stored) !== canonicalJson(supplied.envelope))
    ) {
      throw new StoreError(
        "adaptation.stored_content_mismatch",
        "adaptation bundle document differs from its immutable stored Artifact",
        { artifactPath: supplied.path },
      );
    }
  }
}

async function publishReceipt(
  runRoot: string,
  receipt: PlanOperationReceipt,
): Promise<"created" | "existing"> {
  const relativePath = receiptPath(receipt.operation_key);
  const filename = await resolveRunPath(runRoot, relativePath, { createParents: true });
  try {
    const existing = JSON.parse(await readFile(filename, "utf8")) as unknown;
    const validated = validateReceipt(existing, path.basename(relativePath), receipt.run_id);
    if (canonicalJson(validated) !== canonicalJson(receipt)) {
      throw new StoreError(
        "write.operation_conflict",
        "Plan operation key was previously used with different content",
        { operationKey: receipt.operation_key },
      );
    }
    return "existing";
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const temporary = `.store/temp/plan-revision-${sha256Hex(receipt.operation_key)}.receipt.tmp`;
  await writeSyncedTemp(runRoot, temporary, `${canonicalJson(receipt)}\n`);
  await publishTemp(runRoot, temporary, relativePath);
  return "created";
}

async function appendOperationEvents(
  runRoot: string,
  runId: string,
  receipt: PlanOperationReceipt,
  logs: JsonlStore,
): Promise<boolean> {
  let changed = false;
  for (const record of receipt.events) {
    if ((await logs.appendValidated(runRoot, runId, "events.jsonl", record)) === "appended") {
      changed = true;
    }
  }
  return changed;
}

async function validateStoredControlEnvelopes(
  runRoot: string,
  receipt: PlanOperationReceipt,
  artifacts: ArtifactStore,
): Promise<void> {
  for (const expected of receipt.control_envelopes) {
    let stored: unknown;
    try {
      stored = JSON.parse(
        await readFile(await resolveRunPath(runRoot, expected.artifact_path), "utf8"),
      ) as unknown;
    } catch (_error) {
      throw new StoreError(
        "recovery.control_artifact_missing",
        "applied Plan operation is missing a control Artifact",
        { artifactPath: expected.artifact_path },
      );
    }
    if (canonicalJson(stored) !== canonicalJson(expected)) {
      throw new StoreError(
        "recovery.control_artifact_conflict",
        "stored control Artifact differs from the Plan operation receipt",
        { artifactPath: expected.artifact_path },
      );
    }
    await artifacts.validateStoredEnvelope(runRoot, receipt.run_id, expected);
  }
}

async function completeOperation(
  runRoot: string,
  receipt: PlanOperationReceipt,
  artifacts: ArtifactStore,
  logs: JsonlStore,
  validator: ArtifactValidator,
  faultAt?: PlanApplyFaultBoundary,
): Promise<boolean> {
  let changed = false;
  const current = await readManifest(runRoot, validator);
  if (
    current.current_plan_ref !== receipt.base_plan_ref &&
    current.current_plan_ref !== receipt.result_plan_ref
  ) {
    throw new StoreError("apply.stale_base", "manifest current plan changed before CAS", {
      expectedBase: receipt.base_plan_ref,
      actual: current.current_plan_ref,
    });
  }

  if (canonicalJson(current) === canonicalJson(receipt.manifest)) {
    await validateStoredControlEnvelopes(runRoot, receipt, artifacts);
    assertFault("after_control_artifacts", faultAt);
    if (
      (
        await artifacts.publishLocked(runRoot, {
          runId: receipt.run_id,
          envelope: receipt.checkpoint_envelope,
        })
      ).status === "published"
    ) {
      changed = true;
    }
    assertFault("after_checkpoint_publish", faultAt);
    return (await appendOperationEvents(runRoot, receipt.run_id, receipt, logs)) || changed;
  }

  if (current.current_plan_ref !== receipt.base_plan_ref) {
    throw new StoreError(
      "apply.result_manifest_conflict",
      "current plan matches the result but manifest content differs from the operation receipt",
    );
  }
  for (const controlEnvelope of receipt.control_envelopes) {
    if (
      (
        await artifacts.publishLocked(runRoot, {
          runId: receipt.run_id,
          envelope: controlEnvelope,
        })
      ).status === "published"
    ) {
      changed = true;
    }
  }
  assertFault("after_control_artifacts", faultAt);
  await writeManifest(runRoot, receipt.manifest, validator);
  changed = true;
  assertFault("after_manifest_update", faultAt);
  if (
    (
      await artifacts.publishLocked(runRoot, {
        runId: receipt.run_id,
        envelope: receipt.checkpoint_envelope,
      })
    ).status === "published"
  ) {
    changed = true;
  }
  assertFault("after_checkpoint_publish", faultAt);
  return (await appendOperationEvents(runRoot, receipt.run_id, receipt, logs)) || changed;
}

function createEvents(
  input: ApplyPlanRevisionInput,
  transformed: Pick<
    PlanTransformationResult,
    "operationKey" | "revisionCreated" | "planPath" | "adaptationRefs" | "actionNames"
  >,
  checkpointRef: string,
): readonly Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const adaptationRef of transformed.adaptationRefs) {
    records.push(
      event(input.runId, transformed.operationKey, "adaptation_validated", input.createdAt, [
        adaptationRef,
      ]),
      event(input.runId, transformed.operationKey, "adaptation_applied", input.createdAt, [
        adaptationRef,
        ...(transformed.revisionCreated ? [transformed.planPath] : []),
      ]),
    );
  }
  if (transformed.revisionCreated) {
    records.push(
      event(input.runId, transformed.operationKey, "plan_revision_created", input.createdAt, [
        transformed.planPath,
        ...transformed.adaptationRefs,
      ]),
    );
  }
  if (transformed.actionNames.some((action) => action === "stop_followup")) {
    records.push(
      event(input.runId, transformed.operationKey, "followup_stopped", input.createdAt, [
        ...transformed.adaptationRefs,
      ]),
    );
  }
  records.push(
    event(input.runId, transformed.operationKey, "checkpoint_written", input.checkpointCreatedAt, [
      checkpointRef,
    ]),
  );
  return records;
}

export class PlanRevisionRuntime {
  private readonly artifacts: ArtifactStore;
  private readonly logs: JsonlStore;

  constructor(
    private readonly runsRoot: string,
    private readonly validator: ArtifactValidator,
    private readonly plans: PlanSemanticValidator,
    private readonly adaptations: AdaptationPolicyValidator,
  ) {
    this.artifacts = new ArtifactStore(runsRoot, validator);
    this.logs = new RuntimeJsonlStore(validator);
  }

  async apply(input: ApplyPlanRevisionInput): Promise<PlanApplyResult> {
    validateRunId(input.runId);
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, () => this.applyLocked(runRoot, input));
  }

  private async applyLocked(
    runRoot: string,
    input: ApplyPlanRevisionInput,
  ): Promise<PlanApplyResult> {
    const manifest = await readManifest(runRoot, this.validator);
    if (manifest.current_plan_ref === null || manifest.plan_revision < 1) {
      throw new StoreError("apply.current_plan_missing", "Run has no current plan");
    }
    const bundleDocuments = effectiveDocuments(input.adaptationBundle);
    const selectedRefs = uniqueSorted(input.adaptationRefs);
    const selectedDecisions: AdaptationInputDocument[] = selectedRefs.map((adaptationRef) => {
      const decision = bundleDocuments.find((document) => document.path === adaptationRef);
      if (decision?.schemaVersion !== "startup_opportunity.adaptation_decision.v2") {
        throw new StoreError(
          "adaptation.ref_missing",
          "selected Adaptation Decision is absent or not v2",
          { adaptationRef },
        );
      }
      return { path: adaptationRef, document: decision.document };
    });
    const baseRefs = uniqueSorted(
      selectedDecisions.map((decision) => String(decision.document.based_on_plan_ref)),
    );
    if (baseRefs.length !== 1) {
      throw new StoreError(
        "adaptation.base_conflict",
        "all decisions in one apply operation must use the same base plan",
      );
    }
    const basePlanRef = baseRefs[0] as string;
    const suppliedPlan = bundleDocuments.find((document) => document.path === basePlanRef);
    if (suppliedPlan?.schemaVersion !== "startup_opportunity.research_plan.v1") {
      throw new StoreError("apply.base_plan_missing", "adaptation bundle is missing its base plan");
    }
    const expectedOperationKey = operationKey("apply_plan_revision", {
      parent_plan_hash: canonicalContentHash(suppliedPlan.document),
      adaptation_refs: selectedRefs,
    });
    if (input.operationKey !== undefined && input.operationKey !== expectedOperationKey) {
      throw new StoreError(
        "operation.key_mismatch",
        "Plan operation key differs from the canonical parent/adaptation identity",
        { expected: expectedOperationKey, actual: input.operationKey },
      );
    }
    let existingReceipt: PlanOperationReceipt | null = null;
    try {
      const filename = await resolveRunPath(runRoot, receiptPath(expectedOperationKey), {
        createParents: true,
      });
      existingReceipt = validateReceipt(
        JSON.parse(await readFile(filename, "utf8")) as unknown,
        path.basename(filename),
        input.runId,
      );
      validateReceiptDocuments(existingReceipt, this.validator, this.artifacts);
      await validateReceiptSources(runRoot, existingReceipt);
      await assertAdaptationBundleMatchesStoredArtifacts(
        runRoot,
        input.runId,
        bundleDocuments,
        this.artifacts,
      );
      const expectedHashes = selectedDecisions.map((decision) =>
        canonicalContentHash(decision.document),
      );
      if (
        existingReceipt.base_plan_ref !== basePlanRef ||
        existingReceipt.base_plan_hash !== canonicalContentHash(suppliedPlan.document) ||
        canonicalJson(existingReceipt.adaptation_refs) !== canonicalJson(selectedRefs) ||
        canonicalJson(existingReceipt.adaptation_hashes) !== canonicalJson(expectedHashes)
      ) {
        throw new StoreError(
          "write.operation_conflict",
          "existing Plan operation receipt differs from the requested replay",
          { operationKey: expectedOperationKey },
        );
      }
      if (
        canonicalJson(existingReceipt.events) !==
        canonicalJson(
          createEvents(
            input,
            {
              operationKey: existingReceipt.operation_key,
              revisionCreated: existingReceipt.revision_created,
              planPath: existingReceipt.result_plan_ref,
              adaptationRefs: existingReceipt.adaptation_refs,
              actionNames: selectedDecisions.map((decision) => String(decision.document.action)),
            },
            existingReceipt.checkpoint_envelope.artifact_path,
          ),
        )
      ) {
        throw new StoreError(
          "write.operation_conflict",
          "Plan operation replay changed Event content",
          { operationKey: expectedOperationKey },
        );
      }
      const checkpointDocument = existingReceipt.checkpoint_envelope.document;
      if (
        existingReceipt.checkpoint_envelope.created_at !== input.checkpointCreatedAt ||
        checkpointDocument.next_step !== input.nextStep ||
        canonicalJson(checkpointDocument.belief_summary) !== canonicalJson(input.beliefSummary)
      ) {
        throw new StoreError(
          "write.operation_conflict",
          "Plan operation replay changed checkpoint metadata",
          { operationKey: expectedOperationKey },
        );
      }
      if (existingReceipt.revision_created) {
        if (input.candidateBundle === undefined) {
          throw new StoreError(
            "write.operation_conflict",
            "Plan operation replay omitted its candidate bundle",
          );
        }
        const replayDocuments = documentMap(input.candidateBundle);
        for (const storedEnvelope of existingReceipt.control_envelopes) {
          const supplied = replayDocuments.get(storedEnvelope.artifact_path);
          if (
            supplied === undefined ||
            canonicalJson(supplied.document) !== canonicalJson(storedEnvelope.document)
          ) {
            throw new StoreError(
              "write.operation_conflict",
              "Plan operation replay changed candidate control content",
              { artifactPath: storedEnvelope.artifact_path },
            );
          }
        }
      } else if (input.candidateBundle !== undefined) {
        throw new StoreError(
          "write.operation_conflict",
          "non-revision operation replay added a candidate bundle",
        );
      }
      if (manifest.current_plan_ref === existingReceipt.result_plan_ref) {
        await completeOperation(
          runRoot,
          existingReceipt,
          this.artifacts,
          this.logs,
          this.validator,
          input.faultAt,
        );
        return this.result(existingReceipt, "idempotent_replay");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    const basePlan = await storedEffectiveDocument(runRoot, manifest.current_plan_ref);
    const createdTime = Date.parse(input.createdAt);
    const checkpointTime = Date.parse(input.checkpointCreatedAt);
    if (
      existingReceipt === null &&
      (!Number.isFinite(createdTime) ||
        !Number.isFinite(checkpointTime) ||
        createdTime <= Date.parse(manifest.updated_at) ||
        checkpointTime <= createdTime)
    ) {
      throw new StoreError(
        "apply.non_monotonic_time",
        "apply and checkpoint timestamps must advance durable Run time",
        {
          manifestUpdatedAt: manifest.updated_at,
          createdAt: input.createdAt,
          checkpointCreatedAt: input.checkpointCreatedAt,
        },
      );
    }
    const suppliedManifest = bundleDocuments.find((document) => document.path === "manifest.json");
    if (
      suppliedManifest?.schemaVersion !== "startup_opportunity.run_manifest.v1" ||
      basePlanRef !== manifest.current_plan_ref ||
      suppliedManifest.document.run_id !== manifest.run_id ||
      suppliedManifest.document.current_plan_ref !== manifest.current_plan_ref ||
      suppliedManifest.document.plan_revision !== manifest.plan_revision ||
      canonicalJson(suppliedPlan.document) !== canonicalJson(basePlan)
    ) {
      throw new StoreError(
        "apply.stale_input_bundle",
        "adaptation bundle does not bind the on-disk current plan",
      );
    }
    await assertAdaptationBundleMatchesStoredArtifacts(
      runRoot,
      input.runId,
      bundleDocuments,
      this.artifacts,
    );
    const patchedBundle: DocumentBundle = {
      ...input.adaptationBundle,
      documents: input.adaptationBundle.documents.map((entry) =>
        entry.path === "manifest.json" ? { path: "manifest.json", document: manifest } : entry,
      ),
    };
    const adaptationValidation = this.adaptations.validateDocumentBundle(patchedBundle);
    if (!adaptationValidation.valid) {
      throw new StoreError(
        "adaptation.policy_invalid",
        "Adaptation Decision batch failed policy validation",
        { result: adaptationValidation },
      );
    }
    if (
      adaptationValidation.adaptationRefs.some((ref) => !selectedRefs.includes(ref)) ||
      selectedRefs.some((ref) => !adaptationValidation.adaptationRefs.includes(ref))
    ) {
      throw new StoreError(
        "adaptation.batch_selection_mismatch",
        "apply must select exactly the validated Adaptation Decision batch",
      );
    }
    for (const decision of selectedDecisions) {
      const stored = await storedEffectiveDocument(runRoot, decision.path);
      if (canonicalJson(stored) !== canonicalJson(decision.document)) {
        throw new StoreError(
          "adaptation.stored_content_mismatch",
          "selected Adaptation Decision differs from its immutable stored artifact",
          { adaptationRef: decision.path },
        );
      }
    }

    const transformed = transformPlan(
      manifest.current_plan_ref,
      basePlan,
      manifest,
      selectedDecisions,
      input.createdAt,
    );
    if (transformed.operationKey !== expectedOperationKey) {
      throw new StoreError(
        "operation.identity_drift",
        "Plan transformer operation identity drifted",
      );
    }

    const controlEnvelopes: FormalArtifactEnvelope[] = [];
    if (transformed.revisionCreated) {
      if (input.candidateBundle === undefined || transformed.plan === null) {
        throw new StoreError(
          "apply.candidate_bundle_missing",
          "revision actions require an explicit candidate Planning Context bundle",
        );
      }
      const candidateValidation = this.plans.validateDocumentBundle(input.candidateBundle);
      if (!candidateValidation.valid) {
        throw new StoreError(
          "apply.candidate_plan_invalid",
          "candidate plan failed full validation",
          {
            result: candidateValidation,
          },
        );
      }
      const candidateDocuments = documentMap(input.candidateBundle);
      const candidatePlan = candidateDocuments.get(transformed.planPath);
      const candidateContexts = [...candidateDocuments.values()].filter(
        (document) =>
          document.schemaVersion === "startup_opportunity.planning_context.v2" &&
          isRecord(document.document.target_plan_binding) &&
          document.document.target_plan_binding.plan_ref === transformed.planPath,
      );
      if (
        candidatePlan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
        canonicalJson(candidatePlan.document) !== canonicalJson(transformed.plan) ||
        candidateContexts.length !== 1 ||
        candidateContexts[0]?.document.validation_stage !== "candidate_revision"
      ) {
        throw new StoreError(
          "apply.candidate_transform_mismatch",
          "candidate bundle does not contain the deterministic Plan Revision result",
        );
      }
      const context = candidateContexts[0];
      const aiCoverage = context.document.ai_mandatory_coverage;
      const basis = isRecord(aiCoverage) ? aiCoverage.basis : null;
      if (isRecord(basis) && typeof basis.source_ref === "string") {
        const source = candidateDocuments.get(basis.source_ref);
        if (source?.schemaVersion !== "startup_opportunity.ai_trigger_source_attestation.v1") {
          throw new StoreError(
            "apply.candidate_source_missing",
            "candidate Planning Context source attestation is missing",
          );
        }
        controlEnvelopes.push(
          envelope(
            input.runId,
            source.path,
            source.document,
            "main_agent",
            [],
            String(source.document.created_at),
          ),
        );
      }
      controlEnvelopes.push(
        envelope(
          input.runId,
          transformed.planPath,
          transformed.plan,
          "harness",
          [manifest.current_plan_ref, ...transformed.adaptationRefs],
          input.createdAt,
        ),
        envelope(
          input.runId,
          context.path,
          context.document,
          "main_agent",
          [
            "manifest.json",
            transformed.planPath,
            ...(isRecord(basis) && typeof basis.source_ref === "string" ? [basis.source_ref] : []),
          ],
          String(context.document.created_at),
        ),
      );
    } else if (input.candidateBundle !== undefined) {
      throw new StoreError(
        "apply.unexpected_candidate_bundle",
        "non-revision actions do not accept a candidate plan bundle",
      );
    }

    const checkpointRef = `checkpoints/checkpoint-plan-apply-${sha256Hex(
      transformed.operationKey,
    ).slice(0, 20)}.json`;
    const controlPaths = controlEnvelopes.map((item) => item.artifact_path);
    const finalManifest: RunManifest = {
      ...transformed.manifest,
      updated_at: input.checkpointCreatedAt,
      schema_bundle_version:
        controlEnvelopes.length > 0 ? "2.2.0" : transformed.manifest.schema_bundle_version,
      artifact_refs: uniqueSorted([...transformed.manifest.artifact_refs, ...controlPaths]),
      checkpoint_ref: checkpointRef,
    };
    const triggerGapRefs = uniqueSorted(
      selectedDecisions.flatMap((decision) =>
        Array.isArray(decision.document.trigger_gap_refs)
          ? decision.document.trigger_gap_refs.filter(
              (ref): ref is string => typeof ref === "string",
            )
          : [],
      ),
    );
    const checkpointDocument: Record<string, unknown> = {
      schema_version: "startup_opportunity.checkpoint.v1",
      checkpoint_id: `checkpoint_plan_apply_${sha256Hex(transformed.operationKey).slice(0, 20)}`,
      run_id: input.runId,
      created_at: input.checkpointCreatedAt,
      producer_role: "harness",
      input_refs: uniqueSorted(["manifest.json", ...transformed.adaptationRefs, ...controlPaths]),
      manifest_snapshot: finalManifest,
      current_plan_ref: finalManifest.current_plan_ref,
      plan_revision: finalManifest.plan_revision,
      completed_units: finalManifest.completed_units,
      invalidated_units: finalManifest.invalidated_units,
      artifact_refs: finalManifest.artifact_refs,
      latest_gap_snapshot_ref: finalManifest.latest_gap_snapshot_ref,
      applied_adaptation_refs: finalManifest.applied_adaptation_refs,
      pending_adaptation_refs: finalManifest.pending_adaptation_refs,
      unresolved_gap_refs: triggerGapRefs,
      next_step: input.nextStep,
      belief_summary: input.beliefSummary,
    };
    const checkpointEnvelope = envelope(
      input.runId,
      checkpointRef,
      checkpointDocument,
      "harness",
      checkpointDocument.input_refs as readonly string[],
      input.checkpointCreatedAt,
      "startup_opportunity.artifact_envelope.v3",
    );
    const receipt: PlanOperationReceipt = {
      schema_version: "startup_opportunity.plan_revision_operation.v1",
      operation_key: transformed.operationKey,
      run_id: input.runId,
      base_plan_ref: manifest.current_plan_ref,
      base_plan_hash: canonicalContentHash(basePlan),
      adaptation_refs: transformed.adaptationRefs,
      adaptation_hashes: selectedDecisions.map((decision) =>
        canonicalContentHash(decision.document),
      ),
      revision_created: transformed.revisionCreated,
      result_plan_ref: transformed.planPath,
      result_plan_hash: transformed.plan === null ? null : canonicalContentHash(transformed.plan),
      control_envelopes: controlEnvelopes,
      checkpoint_envelope: checkpointEnvelope,
      manifest: finalManifest,
      events: createEvents(input, transformed, checkpointRef),
    };
    validateReceiptDocuments(receipt, this.validator, this.artifacts);
    if (existingReceipt !== null) {
      if (canonicalJson(existingReceipt) !== canonicalJson(receipt)) {
        throw new StoreError(
          "write.operation_conflict",
          "existing Plan operation receipt differs from the requested replay",
          { operationKey: transformed.operationKey },
        );
      }
      await completeOperation(
        runRoot,
        existingReceipt,
        this.artifacts,
        this.logs,
        this.validator,
        input.faultAt,
      );
      return this.result(existingReceipt, "idempotent_replay");
    }
    await publishReceipt(runRoot, receipt);
    assertFault("after_intent", input.faultAt);
    await completeOperation(
      runRoot,
      receipt,
      this.artifacts,
      this.logs,
      this.validator,
      input.faultAt,
    );
    return this.result(receipt, "applied");
  }

  private result(
    receipt: PlanOperationReceipt,
    status: PlanApplyResult["status"],
  ): PlanApplyResult {
    return {
      schemaVersion: PLAN_APPLY_RESULT_VERSION,
      runId: receipt.run_id,
      operationKey: receipt.operation_key,
      status,
      revisionCreated: receipt.revision_created,
      currentPlanRef: receipt.result_plan_ref,
      planRevision: receipt.manifest.plan_revision,
      checkpointRef: receipt.checkpoint_envelope.artifact_path,
      adaptationRefs: receipt.adaptation_refs,
    };
  }
}

export async function recoverPlanRevisionOperationsLocked(
  runRoot: string,
  runId: string,
  validator: ArtifactValidator,
  artifacts: ArtifactStore,
  logs: JsonlStore,
): Promise<PlanOperationRecoveryResult> {
  const directory = await resolveRunPath(runRoot, ".store/operations", { createParents: true });
  const completed: string[] = [];
  const pending: string[] = [];
  for (const filename of (await readdir(directory)).sort()) {
    if (!filename.startsWith("plan-revision-") || !filename.endsWith(".json")) {
      continue;
    }
    const receipt = validateReceipt(
      JSON.parse(await readFile(path.join(directory, filename), "utf8")) as unknown,
      filename,
      runId,
    );
    validateReceiptDocuments(receipt, validator, artifacts);
    await validateReceiptSources(runRoot, receipt);
    const current = await readManifest(runRoot, validator);
    if (current.current_plan_ref === receipt.result_plan_ref) {
      if (await completeOperation(runRoot, receipt, artifacts, logs, validator)) {
        completed.push(receipt.operation_key);
      }
    } else if (current.current_plan_ref === receipt.base_plan_ref) {
      pending.push(receipt.operation_key);
    } else {
      throw new StoreError(
        "recovery.stale_plan_operation",
        "Plan operation base/result no longer matches manifest current plan",
        { operationKey: receipt.operation_key, currentPlanRef: current.current_plan_ref },
      );
    }
  }
  return {
    completedOperationKeys: completed.sort(),
    pendingOperationKeys: pending.sort(),
  };
}

export async function createPlanRevisionRuntime(
  root = process.cwd(),
  runsRoot = path.join(root, "runs"),
): Promise<PlanRevisionRuntime> {
  await loadPlanRevisionApplyPolicy(root);
  const validator = await createArtifactValidator(root);
  return new PlanRevisionRuntime(
    runsRoot,
    validator,
    await createPlanSemanticValidator(root),
    await createAdaptationPolicyValidator(root),
  );
}

export function currentPlanningRunStateHash(manifest: RunManifest): string {
  return planningRunStateHash({
    manifest_ref: "manifest.json",
    manifest_schema_version: manifest.schema_version,
    run_id: manifest.run_id,
    mode: manifest.mode,
    current_plan_ref: manifest.current_plan_ref,
    current_plan_revision: manifest.plan_revision,
  });
}

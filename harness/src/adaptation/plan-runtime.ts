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
import {
  isNodeError,
  openRunDirectory,
  resolveRunPath,
  validateRunId,
} from "../artifact-store/path-policy.js";
import { withRunLock } from "../artifact-store/run-lock.js";
import { StoreError } from "../artifact-store/store-error.js";
import { EvidenceStore } from "../evidence-store/evidence-store.js";
import {
  type BuildReportResult,
  type ReportFaultBoundary,
  ReportRuntime,
} from "../reporting/report-runtime.js";
import { type JsonlStore, JsonlStore as RuntimeJsonlStore } from "../run-store/jsonl-store.js";
import type { BeliefSummary, RunManifest } from "../run-store/run-store.js";
import type {
  ArtifactValidator,
  DocumentBundle,
  DocumentBundleReferenceContext,
  HistoricalDiscoveryPlanBinding,
} from "../validators/artifact-validator.js";
import {
  artifactRefsForDocument,
  createArtifactValidator,
} from "../validators/artifact-validator.js";
import { planningRunStateHash } from "../validators/planning-contract-identities.js";
import {
  type AdaptationPolicyValidator,
  createAdaptationPolicyValidator,
} from "./adaptation-validator.js";
import { loadPlanRevisionApplyPolicy } from "./apply-policy.js";
import { documentMap, type EffectiveDocument, effectiveDocuments, isRecord } from "./contracts.js";
import {
  type AdaptationInputDocument,
  type AssessmentPlanTransformationResult,
  type PlanTransformationResult,
  transformAssessmentPlan,
  transformPlan,
} from "./plan-transformer.js";
import {
  createAssessmentPlanSemanticValidator,
  createPlanSemanticValidator,
  type PlanSemanticValidator,
} from "./plan-validator.js";

export const PLAN_APPLY_RESULT_VERSION = "startup_opportunity.plan_apply_result.v1" as const;
const DISCOVERY_PLAN_OPERATION_VERSION =
  "startup_opportunity.plan_revision_operation.discovery.current" as const;
const ASSESSMENT_PLAN_OPERATION_VERSION =
  "startup_opportunity.plan_revision_operation.assessment.current" as const;

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
  readonly terminalReportEnvelope?: FormalArtifactEnvelope;
  readonly terminalReportFaultAt?: ReportFaultBoundary;
}

export interface PlanApplyResult {
  readonly schemaVersion: typeof PLAN_APPLY_RESULT_VERSION;
  readonly runId: string;
  readonly operationKey: string;
  readonly status: "applied" | "idempotent_replay";
  readonly revisionCreated: boolean;
  readonly currentPlanRef: string;
  readonly planRevision: number;
  readonly currentAssessmentPlanRef: string | null;
  readonly checkpointRef: string;
  readonly adaptationRefs: readonly string[];
  readonly terminalReport: BuildReportResult | null;
}

interface PlanOperationReceipt {
  readonly schema_version:
    | typeof DISCOVERY_PLAN_OPERATION_VERSION
    | typeof ASSESSMENT_PLAN_OPERATION_VERSION;
  readonly operation_key: string;
  readonly run_id: string;
  readonly base_plan_ref: string;
  readonly base_plan_hash: string;
  readonly adaptation_refs: readonly string[];
  readonly adaptation_hashes: readonly string[];
  readonly revision_created: boolean;
  readonly result_plan_ref: string;
  readonly result_plan_hash: string | null;
  readonly base_assessment_plan_ref?: string;
  readonly base_assessment_plan_hash?: string;
  readonly result_assessment_plan_ref?: string;
  readonly result_assessment_plan_hash?: string | null;
  readonly candidate_bindings?: readonly PlanCandidateBinding[];
  readonly control_envelopes: readonly FormalArtifactEnvelope[];
  readonly checkpoint_envelope: FormalArtifactEnvelope;
  readonly manifest: RunManifest;
  readonly events: readonly Record<string, unknown>[];
}

interface PlanCandidateBinding {
  readonly candidate_ref: string;
  readonly candidate_schema_version: "startup_opportunity.discovery_candidate.v1";
  readonly candidate_envelope_version: string;
  readonly candidate_content_hash: string;
  readonly candidate_envelope_hash: string;
  readonly run_id: string;
  readonly research_plan_ref: string;
  readonly plan_revision: number;
}

export interface PlanOperationRecoveryResult {
  readonly completedOperationKeys: readonly string[];
  readonly pendingOperationKeys: readonly string[];
  readonly candidateBoundOperationKeys: readonly string[];
  readonly historicalDiscoveryPlanBindings: readonly HistoricalDiscoveryPlanBinding[];
}

function historicalDiscoveryPlanBindings(
  receipt: PlanOperationReceipt,
): readonly HistoricalDiscoveryPlanBinding[] {
  if (
    receipt.schema_version !== DISCOVERY_PLAN_OPERATION_VERSION ||
    receipt.candidate_bindings === undefined ||
    receipt.candidate_bindings.length === 0
  ) {
    return [];
  }
  const revisions = new Set(receipt.candidate_bindings.map((binding) => binding.plan_revision));
  if (revisions.size !== 1) {
    throw new StoreError(
      "recovery.invalid_plan_operation",
      "candidate-bound Plan receipt contains inconsistent historical Plan revisions",
      { operationKey: receipt.operation_key },
    );
  }
  return [
    {
      planRef: receipt.base_plan_ref,
      planHash: receipt.base_plan_hash,
      planRevision: receipt.candidate_bindings[0]?.plan_revision ?? 0,
      candidateRefs: uniqueSorted(
        receipt.candidate_bindings.map((binding) => binding.candidate_ref),
      ),
    },
  ];
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
  version: FormalArtifactEnvelope["schema_version"] = "startup_opportunity.artifact_envelope.current",
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
  const commonKeys = [
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
  ];
  const assessmentKeys = [
    "base_assessment_plan_ref",
    "base_assessment_plan_hash",
    "result_assessment_plan_ref",
    "result_assessment_plan_hash",
  ];
  const candidateKeys = ["candidate_bindings"];
  const receiptVersion = isRecord(value) ? value.schema_version : null;
  if (
    !isRecord(value) ||
    (receiptVersion !== DISCOVERY_PLAN_OPERATION_VERSION &&
      receiptVersion !== ASSESSMENT_PLAN_OPERATION_VERSION) ||
    !hasExactlyKeys(
      value,
      receiptVersion === ASSESSMENT_PLAN_OPERATION_VERSION
        ? [...commonKeys, ...assessmentKeys]
        : [...commonKeys, ...candidateKeys],
    ) ||
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
    !Array.isArray(value.events) ||
    (receiptVersion === DISCOVERY_PLAN_OPERATION_VERSION &&
      !Array.isArray(value.candidate_bindings))
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
      : receipt.result_plan_ref !== receipt.base_plan_ref || receipt.result_plan_hash !== null) ||
    (receipt.schema_version === ASSESSMENT_PLAN_OPERATION_VERSION &&
      (typeof receipt.base_assessment_plan_ref !== "string" ||
        !isSha256(receipt.base_assessment_plan_hash) ||
        typeof receipt.result_assessment_plan_ref !== "string" ||
        (receipt.revision_created
          ? receipt.result_assessment_plan_ref === receipt.base_assessment_plan_ref ||
            !isSha256(receipt.result_assessment_plan_hash)
          : receipt.result_assessment_plan_ref !== receipt.base_assessment_plan_ref ||
            receipt.result_assessment_plan_hash !== null))) ||
    (receipt.schema_version === DISCOVERY_PLAN_OPERATION_VERSION &&
      receipt.candidate_bindings?.some(
        (binding) =>
          !isRecord(binding) ||
          !hasExactlyKeys(binding, [
            "candidate_ref",
            "candidate_schema_version",
            "candidate_envelope_version",
            "candidate_content_hash",
            "candidate_envelope_hash",
            "run_id",
            "research_plan_ref",
            "plan_revision",
          ]) ||
          binding.candidate_schema_version !== "startup_opportunity.discovery_candidate.v1" ||
          binding.run_id !== runId ||
          binding.research_plan_ref !== receipt.base_plan_ref ||
          !Number.isInteger(binding.plan_revision) ||
          binding.plan_revision < 1 ||
          !isSha256(binding.candidate_content_hash) ||
          !isSha256(binding.candidate_envelope_hash),
      ))
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
  const resultAssessmentPlanEnvelope = receipt.control_envelopes.find(
    (item) => item.artifact_path === receipt.result_assessment_plan_ref,
  );
  const expectedEnvelopeVersion = "startup_opportunity.artifact_envelope.current";
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
    checkpoint.schema_version !== expectedEnvelopeVersion ||
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
        resultPlanEnvelope.content_hash !== receipt.result_plan_hash ||
        (receipt.schema_version === ASSESSMENT_PLAN_OPERATION_VERSION &&
          (resultAssessmentPlanEnvelope?.artifact_type !==
            "startup_opportunity.concept_evidence_assessment_plan.v1" ||
            resultAssessmentPlanEnvelope.content_hash !== receipt.result_assessment_plan_hash))
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
  logs: JsonlStore,
  artifacts: ArtifactStore,
): Promise<void> {
  try {
    const basePlan = await storedEffectiveDocument(runRoot, receipt.base_plan_ref);
    if (canonicalContentHash(basePlan) !== receipt.base_plan_hash) {
      throw new Error("base hash mismatch");
    }
    if (receipt.schema_version === ASSESSMENT_PLAN_OPERATION_VERSION) {
      const baseAssessmentPlan = await storedEffectiveDocument(
        runRoot,
        receipt.base_assessment_plan_ref as string,
      );
      if (canonicalContentHash(baseAssessmentPlan) !== receipt.base_assessment_plan_hash) {
        throw new Error("base assessment plan hash mismatch");
      }
    }
    for (const binding of receipt.candidate_bindings ?? []) {
      const stored = JSON.parse(
        await readFile(await resolveRunPath(runRoot, binding.candidate_ref), "utf8"),
      ) as unknown;
      if (
        !isFormalArtifactEnvelope(stored) ||
        stored.schema_version !== binding.candidate_envelope_version ||
        stored.artifact_type !== binding.candidate_schema_version ||
        stored.artifact_path !== binding.candidate_ref ||
        stored.run_id !== binding.run_id ||
        stored.document.run_id !== binding.run_id ||
        stored.document.research_plan_ref !== binding.research_plan_ref ||
        stored.content_hash !== binding.candidate_content_hash ||
        canonicalContentHash(stored) !== binding.candidate_envelope_hash ||
        canonicalContentHash(stored.document) !== binding.candidate_content_hash ||
        Number(basePlan.revision) !== binding.plan_revision
      ) {
        throw new Error("candidate binding mismatch");
      }
      artifacts.validateEnvelopeBoundary(receipt.run_id, stored);
    }
    for (const [index, adaptationRef] of receipt.adaptation_refs.entries()) {
      const decision = await storedEffectiveDocument(runRoot, adaptationRef);
      if (canonicalContentHash(decision) !== receipt.adaptation_hashes[index]) {
        throw new Error("adaptation hash mismatch");
      }
      if (decision.requested_by === "user") {
        if (typeof decision.user_decision_ref !== "string") {
          throw new Error("user decision ref missing");
        }
        await logs.readExactRecord(
          runRoot,
          receipt.run_id,
          decision.user_decision_ref,
          "decisions.jsonl",
        );
      }
      if (Array.isArray(decision.trigger_gap_refs)) {
        for (const gapRef of decision.trigger_gap_refs) {
          if (typeof gapRef !== "string") {
            continue;
          }
          const [gapPath = "", gapId] = gapRef.split("#", 2);
          const gap = await storedEffectiveDocument(runRoot, gapPath);
          if (receipt.schema_version === ASSESSMENT_PLAN_OPERATION_VERSION) {
            const gapEntry = Array.isArray(gap.gaps)
              ? gap.gaps.find((candidate) => isRecord(candidate) && candidate.gap_id === gapId)
              : undefined;
            if (
              gap.schema_version !== "startup_opportunity.gap_snapshot.assessment.current" ||
              !isRecord(gapEntry) ||
              gap.run_id !== receipt.run_id ||
              gap.based_on_plan_ref !== receipt.base_plan_ref ||
              gap.based_on_plan_hash !== receipt.base_plan_hash ||
              gap.assessment_plan_ref !== receipt.base_assessment_plan_ref ||
              gap.assessment_plan_hash !== receipt.base_assessment_plan_hash ||
              decision.coverage_key !== gap.coverage_key ||
              decision.coverage_key !== gapEntry.coverage_key
            ) {
              throw new Error("assessment Gap Snapshot binding mismatch");
            }
            for (const observation of Array.isArray(gap.observed_artifacts)
              ? gap.observed_artifacts
              : []) {
              if (!isRecord(observation)) {
                throw new Error("assessment observation invalid");
              }
              const observed = await storedEffectiveDocument(
                runRoot,
                String(observation.artifact_ref),
              );
              const task = await storedEffectiveDocument(runRoot, String(observation.task_ref));
              if (
                canonicalContentHash(observed) !== observation.content_hash ||
                canonicalContentHash(task) !== observation.task_hash
              ) {
                throw new Error("assessment observed Artifact hash mismatch");
              }
            }
          }
          if (typeof gap.trigger_event_ref === "string") {
            await logs.readExactRecord(
              runRoot,
              receipt.run_id,
              gap.trigger_event_ref,
              "events.jsonl",
            );
          }
        }
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
    value.schema_version === "startup_opportunity.artifact_envelope.current"
    ? value.document
    : value;
}

function isFormalArtifactEnvelope(value: unknown): value is FormalArtifactEnvelope {
  return (
    isRecord(value) &&
    value.schema_version === "startup_opportunity.artifact_envelope.current" &&
    typeof value.artifact_type === "string" &&
    typeof value.artifact_path === "string" &&
    typeof value.run_id === "string" &&
    isRecord(value.document)
  );
}

async function storedFormalEnvelope(
  runRoot: string,
  runId: string,
  artifactRef: string,
  artifacts: ArtifactStore,
): Promise<FormalArtifactEnvelope> {
  const stored = JSON.parse(
    await readFile(await resolveRunPath(runRoot, artifactRef), "utf8"),
  ) as unknown;
  if (!isFormalArtifactEnvelope(stored) || stored.artifact_path !== artifactRef) {
    throw new StoreError(
      "adaptation.stored_artifact_invalid",
      "selected Adaptation Decision does not resolve to its formal envelope",
      { artifactPath: artifactRef },
    );
  }
  await artifacts.validateStoredEnvelope(runRoot, runId, stored);
  return stored;
}

function preKillCandidateBindings(
  documents: readonly EffectiveDocument[],
  decisions: readonly AdaptationInputDocument[],
  runId: string,
  planRef: string,
  planRevision: number,
): readonly PlanCandidateBinding[] {
  const byPath = new Map(documents.map((document) => [document.path, document]));
  const subjects = new Set<string>();
  for (const decision of decisions) {
    for (const gapRef of Array.isArray(decision.document.trigger_gap_refs)
      ? decision.document.trigger_gap_refs
      : []) {
      if (typeof gapRef !== "string") {
        continue;
      }
      const [gapPath = "", gapId] = gapRef.split("#", 2);
      const snapshot = byPath.get(gapPath);
      const gap = Array.isArray(snapshot?.document.gaps)
        ? snapshot.document.gaps.find(
            (candidate) => isRecord(candidate) && candidate.gap_id === gapId,
          )
        : undefined;
      if (isRecord(gap) && gap.gap_type === "candidate_pre_killed") {
        if (typeof gap.subject_ref !== "string") {
          throw new StoreError(
            "adaptation.pre_kill_candidate_binding_invalid",
            "candidate_pre_killed has no exact typed candidate subject",
          );
        }
        subjects.add(gap.subject_ref);
      }
    }
  }
  return [...subjects].sort().map((candidateRef) => {
    const candidate = byPath.get(candidateRef);
    const envelopeValue = candidate?.envelope;
    if (
      candidate?.schemaVersion !== "startup_opportunity.discovery_candidate.v1" ||
      envelopeValue === null ||
      !isFormalArtifactEnvelope(envelopeValue) ||
      envelopeValue.artifact_path !== candidateRef ||
      envelopeValue.artifact_type !== "startup_opportunity.discovery_candidate.v1" ||
      envelopeValue.run_id !== runId ||
      candidate.document.run_id !== runId ||
      candidate.document.research_plan_ref !== planRef ||
      envelopeValue.content_hash !== canonicalContentHash(candidate.document)
    ) {
      throw new StoreError(
        "adaptation.pre_kill_candidate_binding_invalid",
        "candidate_pre_killed must bind the exact same-Run typed candidate envelope and current Plan revision",
        { candidateRef, planRef, planRevision },
      );
    }
    return {
      candidate_ref: candidateRef,
      candidate_schema_version: "startup_opportunity.discovery_candidate.v1",
      candidate_envelope_version: envelopeValue.schema_version,
      candidate_content_hash: envelopeValue.content_hash,
      candidate_envelope_hash: canonicalContentHash(envelopeValue),
      run_id: runId,
      research_plan_ref: planRef,
      plan_revision: planRevision,
    };
  });
}

function scopeReconciliationAuthorized(
  manifest: RunManifest,
  decisions: readonly AdaptationInputDocument[],
  documents: readonly EffectiveDocument[],
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
): boolean {
  if (
    manifest.status !== "needs_clarification" ||
    manifest.scope_confirmation_ref === null ||
    manifest.scope_confirmation_hash === null
  ) {
    return false;
  }
  const confirmation = exactRecords.get(manifest.scope_confirmation_ref);
  if (
    confirmation?.schema_version !== "startup_opportunity.decision.v1" ||
    confirmation.decision_type !== "scope_changed_by_user" ||
    confirmation.run_id !== manifest.run_id ||
    confirmation.scope_revision !== manifest.scope_revision ||
    canonicalContentHash(confirmation) !== manifest.scope_confirmation_hash
  ) {
    return false;
  }
  const byPath = new Map(documents.map((document) => [document.path, document]));
  return decisions.some((decision) =>
    (Array.isArray(decision.document.trigger_gap_refs)
      ? decision.document.trigger_gap_refs
      : []
    ).some((ref) => {
      if (typeof ref !== "string") return false;
      const [gapPath = "", gapId] = ref.split("#", 2);
      const snapshot = byPath.get(gapPath);
      const gap = Array.isArray(snapshot?.document.gaps)
        ? snapshot.document.gaps.find(
            (candidate) => isRecord(candidate) && candidate.gap_id === gapId,
          )
        : undefined;
      return (
        snapshot?.document.run_id === manifest.run_id &&
        snapshot.document.based_on_plan_ref === manifest.current_plan_ref &&
        snapshot.document.trigger_kind === "resume_reconciliation" &&
        isRecord(gap) &&
        gap.gap_type === "scope_invalidated" &&
        Array.isArray(gap.basis_refs) &&
        gap.basis_refs.includes(manifest.scope_confirmation_ref)
      );
    }),
  );
}

async function durableDiscoveryCandidateBindings(
  runRoot: string,
  manifest: RunManifest,
  runId: string,
  planRef: string,
  planRevision: number,
  artifacts: ArtifactStore,
): Promise<readonly PlanCandidateBinding[]> {
  const bindings: PlanCandidateBinding[] = [];
  for (const candidateRef of manifest.artifact_refs
    .filter((ref) => ref.startsWith("artifacts/discovery/candidates/"))
    .sort()) {
    try {
      const stored = JSON.parse(
        await readFile(await resolveRunPath(runRoot, candidateRef), "utf8"),
      ) as unknown;
      if (
        !isFormalArtifactEnvelope(stored) ||
        stored.artifact_type !== "startup_opportunity.discovery_candidate.v1" ||
        stored.artifact_path !== candidateRef ||
        stored.run_id !== runId ||
        stored.document.run_id !== runId ||
        stored.content_hash !== canonicalContentHash(stored.document)
      ) {
        throw new Error("candidate envelope mismatch");
      }
      artifacts.validateEnvelopeBoundary(runId, stored);
      await artifacts.validateStoredEnvelope(runRoot, runId, stored);
      if (stored.document.research_plan_ref !== planRef) {
        continue;
      }
      bindings.push({
        candidate_ref: candidateRef,
        candidate_schema_version: "startup_opportunity.discovery_candidate.v1",
        candidate_envelope_version: stored.schema_version,
        candidate_content_hash: stored.content_hash,
        candidate_envelope_hash: canonicalContentHash(stored),
        run_id: runId,
        research_plan_ref: planRef,
        plan_revision: planRevision,
      });
    } catch (_error) {
      throw new StoreError(
        "adaptation.discovery_candidate_binding_invalid",
        "durable discovery candidate bytes cannot establish an exact historical Plan binding",
        { candidateRef, planRef, planRevision },
      );
    }
  }
  return bindings;
}

async function assertStoredCandidateBindings(
  runRoot: string,
  bindings: readonly PlanCandidateBinding[],
  artifacts: ArtifactStore,
): Promise<void> {
  for (const binding of bindings) {
    try {
      const stored = JSON.parse(
        await readFile(await resolveRunPath(runRoot, binding.candidate_ref), "utf8"),
      ) as unknown;
      if (
        !isFormalArtifactEnvelope(stored) ||
        stored.schema_version !== binding.candidate_envelope_version ||
        stored.artifact_type !== binding.candidate_schema_version ||
        stored.artifact_path !== binding.candidate_ref ||
        stored.run_id !== binding.run_id ||
        stored.document.run_id !== binding.run_id ||
        stored.document.research_plan_ref !== binding.research_plan_ref ||
        stored.content_hash !== binding.candidate_content_hash ||
        canonicalContentHash(stored.document) !== binding.candidate_content_hash ||
        canonicalContentHash(stored) !== binding.candidate_envelope_hash
      ) {
        throw new Error("candidate binding mismatch");
      }
      artifacts.validateEnvelopeBoundary(binding.run_id, stored);
      await artifacts.validateStoredEnvelope(runRoot, binding.run_id, stored);
    } catch (_error) {
      throw new StoreError(
        "adaptation.pre_kill_candidate_binding_invalid",
        "candidate_pre_killed durable candidate bytes differ from the exact typed binding",
        { candidateRef: binding.candidate_ref },
      );
    }
  }
}

async function assertAdaptationBundleMatchesStoredArtifacts(
  runRoot: string,
  runId: string,
  documents: readonly EffectiveDocument[],
  artifacts: ArtifactStore,
  logs: JsonlStore,
  evidence: EvidenceStore,
): Promise<DocumentBundleReferenceContext> {
  const exactJsonlRecords = new Map<string, Record<string, unknown>>();
  for (const supplied of [...documents].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const referencedRecords = artifactRefsForDocument({
      path: supplied.path,
      document: supplied.envelope ?? supplied.document,
    });
    for (const ref of referencedRecords) {
      if (ref.startsWith("evidence/manifest.jsonl#")) {
        exactJsonlRecords.set(ref, await evidence.readExactRecordLocked(runRoot, runId, ref));
      } else if (ref.startsWith("events.jsonl#")) {
        exactJsonlRecords.set(ref, await logs.readExactRecord(runRoot, runId, ref, "events.jsonl"));
      } else if (ref.startsWith("decisions.jsonl#")) {
        exactJsonlRecords.set(
          ref,
          await logs.readExactRecord(runRoot, runId, ref, "decisions.jsonl"),
        );
      }
    }
  }
  const suppliedManifest = documents.find(
    (document) => document.schemaVersion === "startup_opportunity.run_manifest.v1",
  );
  if (suppliedManifest !== undefined) {
    for (const field of ["scope_proposal_ref", "scope_confirmation_ref"] as const) {
      const scopeRef = suppliedManifest.document[field];
      if (typeof scopeRef === "string") {
        exactJsonlRecords.set(
          scopeRef,
          await logs.readExactRecord(runRoot, runId, scopeRef, "decisions.jsonl"),
        );
      }
    }
  }
  for (const supplied of documents) {
    if (
      supplied.schemaVersion === "startup_opportunity.adaptation_decision.discovery.current" &&
      supplied.document.requested_by === "user"
    ) {
      if (typeof supplied.document.user_decision_ref !== "string") {
        throw new StoreError(
          "reference.fragment_missing",
          "user-requested adaptation requires an exact Decision log ref",
          { artifactPath: supplied.path },
        );
      }
      exactJsonlRecords.set(
        supplied.document.user_decision_ref,
        await logs.readExactRecord(
          runRoot,
          runId,
          supplied.document.user_decision_ref,
          "decisions.jsonl",
        ),
      );
    }
    if (
      (supplied.schemaVersion === "startup_opportunity.gap_snapshot.discovery.plan.current" ||
        supplied.schemaVersion === "startup_opportunity.gap_snapshot.discovery.readiness.current" ||
        supplied.schemaVersion === "startup_opportunity.gap_snapshot.assessment.current") &&
      typeof supplied.document.trigger_event_ref === "string"
    ) {
      exactJsonlRecords.set(
        supplied.document.trigger_event_ref,
        await logs.readExactRecord(
          runRoot,
          runId,
          supplied.document.trigger_event_ref,
          "events.jsonl",
        ),
      );
    }
  }
  for (const supplied of [...documents]
    .filter((document) => document.path !== "manifest.json")
    .sort((left, right) => left.path.localeCompare(right.path))) {
    if (supplied.path === "events.jsonl" || supplied.path === "decisions.jsonl") {
      const id =
        supplied.path === "events.jsonl"
          ? supplied.document.event_id
          : supplied.document.decision_id;
      if (typeof id !== "string" || supplied.envelope !== null) {
        throw new StoreError(
          "adaptation.stored_artifact_invalid",
          "adaptation JSONL input must be one effective record with the correct id",
          { artifactPath: supplied.path },
        );
      }
      const storedRecord = await logs.readExactRecord(
        runRoot,
        runId,
        `${supplied.path}#${id}`,
        supplied.path,
      );
      if (canonicalJson(storedRecord) !== canonicalJson(supplied.document)) {
        throw new StoreError(
          "adaptation.stored_content_mismatch",
          "adaptation bundle JSONL record differs from its durable log record",
          { artifactPath: supplied.path, recordId: id },
        );
      }
      exactJsonlRecords.set(`${supplied.path}#${id}`, storedRecord);
      continue;
    }
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
  return { exactJsonlRecords };
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

async function assertNoDivergentPendingOperation(
  runRoot: string,
  runId: string,
  manifest: RunManifest,
  basePlanRef: string,
  expectedOperationKey: string,
  validator: ArtifactValidator,
  artifacts: ArtifactStore,
  logs: JsonlStore,
): Promise<void> {
  const directory = await resolveRunPath(runRoot, ".store/operations", { createParents: true });
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
    await validateReceiptSources(runRoot, receipt, logs, artifacts);
    const completed = await planOperationCompletionIsDurable(
      runRoot,
      manifest,
      receipt,
      artifacts,
      logs,
    );
    if (
      receipt.operation_key !== expectedOperationKey &&
      receipt.base_plan_ref === basePlanRef &&
      manifest.current_plan_ref === receipt.base_plan_ref &&
      !completed
    ) {
      throw new StoreError(
        "apply.pending_operation_conflict",
        "another Plan operation intent must be replayed before applying a divergent operation",
        {
          pendingOperationKey: receipt.operation_key,
          requestedOperationKey: expectedOperationKey,
          basePlanRef,
        },
      );
    }
  }
}

async function planOperationCompletionIsDurable(
  runRoot: string,
  manifest: RunManifest,
  receipt: PlanOperationReceipt,
  artifacts: ArtifactStore,
  logs: JsonlStore,
): Promise<boolean> {
  if (
    manifest.current_plan_ref !== receipt.result_plan_ref ||
    !receipt.adaptation_refs.every((ref) => manifest.applied_adaptation_refs.includes(ref)) ||
    receipt.adaptation_refs.some(
      (ref) =>
        manifest.pending_adaptation_refs.includes(ref) ||
        manifest.validated_adaptation_refs.includes(ref) ||
        manifest.rejected_adaptation_refs.includes(ref),
    )
  ) {
    return false;
  }

  return planOperationRecordsAreDurable(runRoot, receipt, artifacts, logs);
}

async function planOperationRecordsAreDurable(
  runRoot: string,
  receipt: PlanOperationReceipt,
  artifacts: ArtifactStore,
  logs: JsonlStore,
): Promise<boolean> {
  for (const expected of [...receipt.control_envelopes, receipt.checkpoint_envelope]) {
    let stored: unknown;
    try {
      stored = JSON.parse(
        await readFile(await resolveRunPath(runRoot, expected.artifact_path), "utf8"),
      ) as unknown;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
    if (canonicalJson(stored) !== canonicalJson(expected)) {
      throw new StoreError(
        "recovery.plan_operation_completion_conflict",
        "completed Plan operation Artifact differs from its immutable receipt",
        { operationKey: receipt.operation_key, artifactPath: expected.artifact_path },
      );
    }
    await artifacts.validateStoredEnvelope(runRoot, receipt.run_id, expected);
  }

  for (const expected of receipt.events) {
    let stored: Record<string, unknown>;
    try {
      stored = await logs.readExactRecord(
        runRoot,
        receipt.run_id,
        `events.jsonl#${String(expected.event_id)}`,
        "events.jsonl",
      );
    } catch (error) {
      if (
        isNodeError(error, "ENOENT") ||
        (error instanceof StoreError && error.code === "reference.fragment_missing")
      ) {
        return false;
      }
      throw error;
    }
    if (canonicalJson(stored) !== canonicalJson(expected)) {
      throw new StoreError(
        "recovery.plan_operation_completion_conflict",
        "completed Plan operation Event differs from its immutable receipt",
        { operationKey: receipt.operation_key, eventId: expected.event_id },
      );
    }
  }
  return true;
}

async function planLineageContains(
  runRoot: string,
  currentPlanRef: string | null,
  targetPlanRef: string,
): Promise<boolean> {
  let cursor = currentPlanRef;
  const visited = new Set<string>();
  while (cursor !== null && !visited.has(cursor)) {
    if (cursor === targetPlanRef) {
      return true;
    }
    visited.add(cursor);
    const plan = await storedEffectiveDocument(runRoot, cursor);
    cursor = typeof plan.parent_plan_ref === "string" ? plan.parent_plan_ref : null;
  }
  return false;
}

async function historicalPlanOperationCompletionIsDurable(
  runRoot: string,
  manifest: RunManifest,
  receipt: PlanOperationReceipt,
  artifacts: ArtifactStore,
  logs: JsonlStore,
): Promise<boolean> {
  if (
    !(await planLineageContains(runRoot, manifest.current_plan_ref, receipt.result_plan_ref)) ||
    !receipt.adaptation_refs.every((ref) => manifest.applied_adaptation_refs.includes(ref)) ||
    receipt.adaptation_refs.some(
      (ref) =>
        manifest.pending_adaptation_refs.includes(ref) ||
        manifest.validated_adaptation_refs.includes(ref) ||
        manifest.rejected_adaptation_refs.includes(ref),
    )
  ) {
    return false;
  }
  return planOperationRecordsAreDurable(runRoot, receipt, artifacts, logs);
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
    await artifacts.validateStoredEnvelope(runRoot, receipt.run_id, receipt.checkpoint_envelope);
    if (
      (
        await artifacts.publishLocked(
          runRoot,
          {
            runId: receipt.run_id,
            envelope: receipt.checkpoint_envelope,
          },
          true,
        )
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
  if (receipt.control_envelopes.length > 1) {
    if (
      (
        await artifacts.publishBundleLocked(
          runRoot,
          {
            runId: receipt.run_id,
            envelopes: receipt.control_envelopes,
          },
          {
            historicalDiscoveryPlanBindings: historicalDiscoveryPlanBindings(receipt),
          },
        )
      ).status === "published"
    ) {
      changed = true;
    }
  } else if (receipt.control_envelopes[0] !== undefined) {
    if (
      (
        await artifacts.publishLocked(runRoot, {
          runId: receipt.run_id,
          envelope: receipt.control_envelopes[0],
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
  await artifacts.validateStoredEnvelope(runRoot, receipt.run_id, receipt.checkpoint_envelope);
  if (
    (
      await artifacts.publishLocked(
        runRoot,
        {
          runId: receipt.run_id,
          envelope: receipt.checkpoint_envelope,
        },
        true,
      )
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
  private readonly evidence: EvidenceStore;
  private readonly logs: JsonlStore;
  private readonly reports: ReportRuntime;

  constructor(
    private readonly runsRoot: string,
    private readonly validator: ArtifactValidator,
    private readonly plans: PlanSemanticValidator,
    private readonly assessmentPlans: PlanSemanticValidator,
    private readonly adaptations: AdaptationPolicyValidator,
  ) {
    this.artifacts = new ArtifactStore(runsRoot, validator);
    this.evidence = new EvidenceStore(runsRoot);
    this.logs = new RuntimeJsonlStore(validator);
    this.reports = new ReportRuntime(runsRoot, validator);
  }

  async apply(input: ApplyPlanRevisionInput): Promise<PlanApplyResult> {
    validateRunId(input.runId);
    const selected = effectiveDocuments(input.adaptationBundle).filter((document) =>
      input.adaptationRefs.includes(document.path),
    );
    const requiresTerminalReport = selected.some(
      (document) =>
        document.document.action === "terminate_insufficient_evidence" ||
        document.document.action === "record_runtime_failure",
    );
    if (!requiresTerminalReport && input.terminalReportEnvelope !== undefined) {
      throw new StoreError(
        "apply.unexpected_terminal_report_source",
        "non-terminal adaptation cannot publish a terminal report source",
      );
    }
    if (input.terminalReportFaultAt !== undefined && input.terminalReportEnvelope === undefined) {
      throw new StoreError(
        "apply.unexpected_terminal_report_fault",
        "terminal report fault injection requires a terminal report source",
      );
    }
    if (input.terminalReportEnvelope !== undefined) {
      const source = input.terminalReportEnvelope;
      const validation = this.validator.validateDocument(source, source.artifact_path);
      if (
        !validation.valid ||
        source.schema_version !== "startup_opportunity.artifact_envelope.current" ||
        source.artifact_type !== "startup_opportunity.terminal_report_source.v1" ||
        source.run_id !== input.runId ||
        source.producer_role !== "main_agent" ||
        !input.adaptationRefs.every((ref) => source.input_refs.includes(ref))
      ) {
        throw new StoreError(
          "apply.terminal_report_source_invalid",
          "terminal report source must be a valid v17 main-agent envelope bound to the applied adaptations",
          { errors: validation.errors },
        );
      }
    }
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    const applied = await withRunLock(runRoot, () => this.applyLocked(runRoot, input));
    if (input.terminalReportEnvelope === undefined) {
      return applied;
    }
    return {
      ...applied,
      terminalReport: await this.reports.build({
        reportEnvelope: input.terminalReportEnvelope,
        ...(input.terminalReportFaultAt === undefined
          ? {}
          : { faultAt: input.terminalReportFaultAt }),
      }),
    };
  }

  private async applyLocked(
    runRoot: string,
    input: ApplyPlanRevisionInput,
  ): Promise<PlanApplyResult> {
    const planOperationRecovery = await recoverPlanRevisionOperationsLocked(
      runRoot,
      input.runId,
      this.validator,
      this.artifacts,
      this.logs,
    );
    const manifest = await readManifest(runRoot, this.validator);
    if (
      manifest.status === "awaiting_scope_confirmation" ||
      manifest.scope_confirmation_ref === null ||
      manifest.scope_confirmation_hash === null
    ) {
      throw new StoreError(
        "run.scope_confirmation_required",
        "Plan revision is blocked until confirmation binds the exact Scope proposal",
        {
          scopeProposalRef: manifest.scope_proposal_ref,
          scopeProposalHash: manifest.scope_proposal_hash,
        },
      );
    }
    if (manifest.current_plan_ref === null || manifest.plan_revision < 1) {
      throw new StoreError("apply.current_plan_missing", "Run has no current plan");
    }
    const bundleDocuments = effectiveDocuments(input.adaptationBundle);
    const selectedRefs = uniqueSorted(input.adaptationRefs);
    const assessmentAdaptation = manifest.mode === "concept_evidence_assessment";
    const expectedDecisionType = assessmentAdaptation
      ? "startup_opportunity.adaptation_decision.assessment.current"
      : "startup_opportunity.adaptation_decision.discovery.current";
    const selectedDecisions: AdaptationInputDocument[] = selectedRefs.map((adaptationRef) => {
      const decision = bundleDocuments.find((document) => document.path === adaptationRef);
      if (decision?.schemaVersion !== expectedDecisionType) {
        throw new StoreError(
          decision === undefined ? "adaptation.ref_missing" : "adaptation.run_mode_mismatch",
          decision === undefined
            ? "selected Adaptation Decision is absent"
            : "selected Adaptation Decision identity does not match the current Run mode",
          { adaptationRef, mode: manifest.mode, artifactType: decision?.schemaVersion },
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
    const preKillBindings = preKillCandidateBindings(
      bundleDocuments,
      selectedDecisions,
      input.runId,
      basePlanRef,
      Number(suppliedPlan.document.revision),
    );
    const candidateBindings =
      preKillBindings.length > 0
        ? preKillBindings
        : assessmentAdaptation
          ? []
          : await durableDiscoveryCandidateBindings(
              runRoot,
              manifest,
              input.runId,
              basePlanRef,
              Number(suppliedPlan.document.revision),
              this.artifacts,
            );
    const assessmentPlanRefs = uniqueSorted(
      selectedDecisions.flatMap((decision) =>
        typeof decision.document.assessment_plan_ref === "string"
          ? [decision.document.assessment_plan_ref]
          : [],
      ),
    );
    if (assessmentAdaptation && assessmentPlanRefs.length !== 1) {
      throw new StoreError(
        "adaptation.assessment_base_conflict",
        "Assessment Adaptation Decisions must bind one exact current assessment plan",
      );
    }
    const baseAssessmentPlanRef = assessmentAdaptation ? (assessmentPlanRefs[0] as string) : null;
    const suppliedAssessmentPlan =
      baseAssessmentPlanRef === null
        ? null
        : bundleDocuments.find((document) => document.path === baseAssessmentPlanRef);
    if (
      assessmentAdaptation &&
      suppliedAssessmentPlan?.schemaVersion !==
        "startup_opportunity.concept_evidence_assessment_plan.v1"
    ) {
      throw new StoreError(
        "apply.base_assessment_plan_missing",
        "adaptation bundle is missing its exact base assessment plan",
      );
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
      await validateReceiptSources(runRoot, existingReceipt, this.logs, this.artifacts);
      await assertAdaptationBundleMatchesStoredArtifacts(
        runRoot,
        input.runId,
        bundleDocuments,
        this.artifacts,
        this.logs,
        this.evidence,
      );
      const expectedHashes = selectedDecisions.map((decision) =>
        canonicalContentHash(decision.document),
      );
      if (
        existingReceipt.base_plan_ref !== basePlanRef ||
        existingReceipt.base_plan_hash !== canonicalContentHash(suppliedPlan.document) ||
        existingReceipt.schema_version !==
          (assessmentAdaptation
            ? ASSESSMENT_PLAN_OPERATION_VERSION
            : DISCOVERY_PLAN_OPERATION_VERSION) ||
        (assessmentAdaptation &&
          (existingReceipt.schema_version !== ASSESSMENT_PLAN_OPERATION_VERSION ||
            existingReceipt.base_assessment_plan_ref !== baseAssessmentPlanRef ||
            existingReceipt.base_assessment_plan_hash !==
              canonicalContentHash(suppliedAssessmentPlan?.document ?? {}))) ||
        canonicalJson(existingReceipt.adaptation_refs) !== canonicalJson(selectedRefs) ||
        canonicalJson(existingReceipt.adaptation_hashes) !== canonicalJson(expectedHashes) ||
        (existingReceipt.schema_version === DISCOVERY_PLAN_OPERATION_VERSION &&
          canonicalJson(existingReceipt.candidate_bindings) !== canonicalJson(candidateBindings))
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
        if (
          !(await planOperationCompletionIsDurable(
            runRoot,
            manifest,
            existingReceipt,
            this.artifacts,
            this.logs,
          ))
        ) {
          await completeOperation(
            runRoot,
            existingReceipt,
            this.artifacts,
            this.logs,
            this.validator,
            input.faultAt,
          );
        }
        return this.result(existingReceipt, "idempotent_replay");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    await assertNoDivergentPendingOperation(
      runRoot,
      input.runId,
      manifest,
      basePlanRef,
      expectedOperationKey,
      this.validator,
      this.artifacts,
      this.logs,
    );

    await assertStoredCandidateBindings(runRoot, candidateBindings, this.artifacts);

    const basePlan = await storedEffectiveDocument(runRoot, manifest.current_plan_ref);
    const baseAssessmentPlan =
      baseAssessmentPlanRef === null
        ? null
        : await storedEffectiveDocument(runRoot, baseAssessmentPlanRef);
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
      canonicalJson(suppliedPlan.document) !== canonicalJson(basePlan) ||
      (assessmentAdaptation &&
        (suppliedAssessmentPlan == null ||
          baseAssessmentPlan === null ||
          canonicalJson(suppliedAssessmentPlan.document) !== canonicalJson(baseAssessmentPlan)))
    ) {
      throw new StoreError(
        "apply.stale_input_bundle",
        "adaptation bundle does not bind the on-disk current plan",
      );
    }
    const referenceContext = await assertAdaptationBundleMatchesStoredArtifacts(
      runRoot,
      input.runId,
      bundleDocuments,
      this.artifacts,
      this.logs,
      this.evidence,
    );
    const manifestAdaptationRefs = uniqueSorted([
      ...manifest.pending_adaptation_refs,
      ...manifest.validated_adaptation_refs,
      ...manifest.rejected_adaptation_refs,
      ...manifest.applied_adaptation_refs,
    ]);
    const storedDecisionEnvelopes = new Map(
      await Promise.all(
        manifestAdaptationRefs.map(
          async (ref) =>
            [ref, await storedFormalEnvelope(runRoot, input.runId, ref, this.artifacts)] as const,
        ),
      ),
    );
    const historicalBindingsByPlan = new Map(
      planOperationRecovery.historicalDiscoveryPlanBindings.map((binding) => [
        binding.planRef,
        binding,
      ]),
    );
    if (candidateBindings.length > 0) {
      const currentBinding: HistoricalDiscoveryPlanBinding = {
        planRef: basePlanRef,
        planHash: canonicalContentHash(basePlan),
        planRevision: Number(basePlan.revision),
        candidateRefs: uniqueSorted(candidateBindings.map((binding) => binding.candidate_ref)),
      };
      const recoveredBinding = historicalBindingsByPlan.get(basePlanRef);
      if (
        recoveredBinding !== undefined &&
        canonicalJson(recoveredBinding) !== canonicalJson(currentBinding)
      ) {
        throw new StoreError(
          "adaptation.discovery_candidate_binding_conflict",
          "current discovery candidates conflict with the receipt-bound Plan view",
          { planRef: basePlanRef },
        );
      }
      historicalBindingsByPlan.set(basePlanRef, currentBinding);
    }
    const planReferenceContext: DocumentBundleReferenceContext =
      historicalBindingsByPlan.size === 0
        ? referenceContext
        : {
            ...referenceContext,
            historicalDiscoveryPlanBindings: [...historicalBindingsByPlan.values()].sort(
              (left, right) => left.planRef.localeCompare(right.planRef),
            ),
          };
    const suppliedDocumentPaths = new Set(
      input.adaptationBundle.documents.map((entry) => entry.path),
    );
    const patchedBundle: DocumentBundle = {
      ...input.adaptationBundle,
      exact_records: [],
      documents: [
        ...input.adaptationBundle.documents.map((entry) => {
          if (entry.path === "manifest.json") {
            return { path: "manifest.json", document: manifest };
          }
          const storedDecision = storedDecisionEnvelopes.get(entry.path);
          return storedDecision === undefined
            ? entry
            : { path: entry.path, document: storedDecision };
        }),
        ...manifestAdaptationRefs
          .filter((ref) => !suppliedDocumentPaths.has(ref))
          .map((ref) => ({
            path: ref,
            document: storedDecisionEnvelopes.get(ref) as FormalArtifactEnvelope,
          })),
      ],
    };
    const adaptationValidation = this.adaptations.validateDocumentBundle(
      patchedBundle,
      planReferenceContext,
      selectedRefs,
    );
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
    if (
      selectedDecisions.some(
        (decision) =>
          decision.document.action === "terminate_insufficient_evidence" ||
          decision.document.action === "record_runtime_failure",
      ) &&
      input.terminalReportEnvelope === undefined
    ) {
      throw new StoreError(
        "apply.terminal_report_source_required",
        "terminal adaptation requires an explicit main-agent terminal report source",
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
      scopeReconciliationAuthorized(
        manifest,
        selectedDecisions,
        effectiveDocuments(patchedBundle),
        new Map(referenceContext.exactJsonlRecords ?? []),
      ),
    );
    if (transformed.operationKey !== expectedOperationKey) {
      throw new StoreError(
        "operation.identity_drift",
        "Plan transformer operation identity drifted",
      );
    }
    const transformedAssessment: AssessmentPlanTransformationResult | null = assessmentAdaptation
      ? transformAssessmentPlan(
          baseAssessmentPlanRef as string,
          baseAssessmentPlan as Record<string, unknown>,
          transformed.planPath,
          selectedDecisions,
          input.createdAt,
        )
      : null;
    if (
      transformedAssessment !== null &&
      transformedAssessment.revisionCreated !== transformed.revisionCreated
    ) {
      throw new StoreError(
        "operation.assessment_revision_drift",
        "Research Plan and assessment plan revision decisions diverged",
      );
    }

    const controlEnvelopes: FormalArtifactEnvelope[] = [];
    const controlEnvelopeVersion: FormalArtifactEnvelope["schema_version"] =
      "startup_opportunity.artifact_envelope.current";
    if (transformed.revisionCreated) {
      if (input.candidateBundle === undefined || transformed.plan === null) {
        throw new StoreError(
          "apply.candidate_bundle_missing",
          "revision actions require an explicit candidate Planning Context bundle",
        );
      }
      const candidateValidationBundle: DocumentBundle = {
        ...input.candidateBundle,
        exact_records: [],
      };
      const candidateValidation = (
        assessmentAdaptation ? this.assessmentPlans : this.plans
      ).validateDocumentBundle(candidateValidationBundle, planReferenceContext);
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
      const candidateAssessmentPlan =
        transformedAssessment?.revisionCreated === true
          ? candidateDocuments.get(transformedAssessment.planPath)
          : null;
      const candidateContexts = [...candidateDocuments.values()].filter(
        (document) =>
          document.schemaVersion ===
            "startup_opportunity.planning_context.ai_source_bound.current" &&
          isRecord(document.document.target_plan_binding) &&
          document.document.target_plan_binding.plan_ref === transformed.planPath,
      );
      if (
        candidatePlan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
        canonicalJson(candidatePlan.document) !== canonicalJson(transformed.plan) ||
        (transformedAssessment?.revisionCreated === true &&
          (candidateAssessmentPlan?.schemaVersion !==
            "startup_opportunity.concept_evidence_assessment_plan.v1" ||
            canonicalJson(candidateAssessmentPlan.document) !==
              canonicalJson(transformedAssessment.plan))) ||
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
      if (!assessmentAdaptation && isRecord(basis) && typeof basis.source_ref === "string") {
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
            controlEnvelopeVersion,
          ),
        );
      }
      if (transformedAssessment?.revisionCreated === true && transformedAssessment.plan !== null) {
        controlEnvelopes.push(
          envelope(
            input.runId,
            transformedAssessment.planPath,
            transformedAssessment.plan,
            "harness",
            [baseAssessmentPlanRef as string, transformed.planPath, ...transformed.adaptationRefs],
            input.createdAt,
            controlEnvelopeVersion,
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
          controlEnvelopeVersion,
        ),
        envelope(
          input.runId,
          context.path,
          context.document,
          "main_agent",
          [
            "manifest.json",
            transformed.planPath,
            ...(transformedAssessment?.revisionCreated === true
              ? [transformedAssessment.planPath]
              : []),
            ...(isRecord(basis) && typeof basis.source_ref === "string" ? [basis.source_ref] : []),
          ],
          String(context.document.created_at),
          controlEnvelopeVersion,
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
      controlEnvelopeVersion,
    );
    const receipt: PlanOperationReceipt = {
      schema_version: assessmentAdaptation
        ? ASSESSMENT_PLAN_OPERATION_VERSION
        : DISCOVERY_PLAN_OPERATION_VERSION,
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
      ...(assessmentAdaptation && transformedAssessment !== null
        ? {
            base_assessment_plan_ref: baseAssessmentPlanRef as string,
            base_assessment_plan_hash: canonicalContentHash(
              baseAssessmentPlan as Record<string, unknown>,
            ),
            result_assessment_plan_ref: transformedAssessment.planPath,
            result_assessment_plan_hash:
              transformedAssessment.plan === null
                ? null
                : canonicalContentHash(transformedAssessment.plan),
          }
        : {}),
      ...(!assessmentAdaptation ? { candidate_bindings: candidateBindings } : {}),
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
      currentAssessmentPlanRef: receipt.result_assessment_plan_ref ?? null,
      checkpointRef: receipt.checkpoint_envelope.artifact_path,
      adaptationRefs: receipt.adaptation_refs,
      terminalReport: null,
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
  const candidateBound: string[] = [];
  const historicalBindings: HistoricalDiscoveryPlanBinding[] = [];
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
    await validateReceiptSources(runRoot, receipt, logs, artifacts);
    if (
      receipt.schema_version === DISCOVERY_PLAN_OPERATION_VERSION &&
      (receipt.candidate_bindings?.length ?? 0) > 0
    ) {
      candidateBound.push(receipt.operation_key);
      historicalBindings.push(...historicalDiscoveryPlanBindings(receipt));
    }
    const current = await readManifest(runRoot, validator);
    if (current.current_plan_ref === receipt.result_plan_ref) {
      if (await planOperationCompletionIsDurable(runRoot, current, receipt, artifacts, logs)) {
        continue;
      }
      if (await completeOperation(runRoot, receipt, artifacts, logs, validator)) {
        completed.push(receipt.operation_key);
      }
    } else if (current.current_plan_ref === receipt.base_plan_ref) {
      pending.push(receipt.operation_key);
    } else if (
      !(await historicalPlanOperationCompletionIsDurable(
        runRoot,
        current,
        receipt,
        artifacts,
        logs,
      ))
    ) {
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
    candidateBoundOperationKeys: candidateBound.sort(),
    historicalDiscoveryPlanBindings: historicalBindings.sort((left, right) =>
      left.planRef.localeCompare(right.planRef),
    ),
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
    await createAssessmentPlanSemanticValidator(root),
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

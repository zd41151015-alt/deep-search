import type { Dirent } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  type PlanOperationRecoveryResult,
  recoverPlanRevisionOperationsLocked,
} from "../adaptation/plan-runtime.js";
import {
  createAssessmentPlanSemanticValidator,
  createPlanSemanticValidator,
} from "../adaptation/plan-validator.js";
import {
  ArtifactStore,
  type FormalArtifactEnvelope,
  type PublishArtifactBundleInput,
  type PublishArtifactBundleResult,
  type PublishArtifactInput,
  type PublishArtifactResult,
} from "../artifact-store/artifact-store.js";
import {
  atomicReplace,
  publishTemp,
  syncDirectory,
  writeSyncedTemp,
} from "../artifact-store/atomic-file.js";
import {
  canonicalContentHash,
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
  validateArtifactRef,
  validateRelativePath,
  validateRunId,
} from "../artifact-store/path-policy.js";
import {
  ARTIFACT_ENVELOPE_SCHEMA_VERSION,
  DOCUMENT_BUNDLE_SCHEMA_VERSION,
} from "../artifact-store/publication-policy.js";
import { withRunCreationLock, withRunLock } from "../artifact-store/run-lock.js";
import { StoreError } from "../artifact-store/store-error.js";
import {
  type EvidenceRecoveryResult,
  EvidenceStore,
  type EvidenceStoreRecord,
  prepareEvidenceRecord,
} from "../evidence-store/evidence-store.js";
import {
  type DecisionSubjectKind,
  subjectRevisionDescriptor,
  subjectSchemaAllowed,
} from "../reporting/decision-subject-reformation.js";
import {
  type ReportRecoveryResult,
  recoverReportOperationsLocked,
} from "../reporting/report-runtime.js";
import {
  canonicalLaneLifecycleId,
  canonicalLaneLifecyclePath,
  dispatchLaunchRegistrationPath,
  dispatchLaunchRequestFromRegistration,
} from "../runtime/lane-lifecycle-identity.js";
import { type OperationObserver, operationTrace } from "../runtime/operation-observability.js";
import {
  type ArtifactValidator,
  artifactRefsForDocument,
  type DocumentBundle,
  type DocumentBundleEntry,
  type DocumentBundleReferenceContext,
} from "../validators/artifact-validator.js";
import { isDiscoverySynthesisSchemaVersion } from "../validators/discovery-synthesis-validator.js";
import {
  researchHandoffCapturedPayloadValid,
  researchHandoffSourceRoleAllowed,
} from "../validators/research-handoff-validator.js";
import { validateTerminalReportingContract } from "../validators/terminal-reporting-validator.js";
import { type JsonlRepairResult, JsonlStore } from "./jsonl-store.js";
import { scopeReconciliationArtifactTypeAllowed } from "./scope-write-guard.js";

export type RunMode = "opportunity_discovery" | "concept_evidence_assessment";

export interface RunManifest extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.run_manifest.v1";
  readonly run_id: string;
  readonly mode: RunMode;
  readonly status: string;
  readonly status_before_clarification: string | null;
  readonly parent_run_id: string | null;
  readonly scope_proposal_ref: string;
  readonly scope_proposal_hash: string;
  readonly scope_confirmation_ref: string | null;
  readonly scope_confirmation_hash: string | null;
  readonly scope_revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly current_phase: string | null;
  readonly current_plan_ref: string | null;
  readonly plan_revision: number;
  readonly current_decision_subject_snapshot_ref: string | null;
  readonly current_decision_subject_snapshot_hash: string | null;
  readonly followup_round: number;
  readonly latest_gap_snapshot_ref: string | null;
  readonly pending_adaptation_refs: readonly string[];
  readonly validated_adaptation_refs: readonly string[];
  readonly rejected_adaptation_refs: readonly string[];
  readonly applied_adaptation_refs: readonly string[];
  readonly completed_units: readonly string[];
  readonly active_units: readonly string[];
  readonly failed_units: readonly string[];
  readonly invalidated_units: readonly string[];
  readonly skipped_units: readonly string[];
  readonly cancelled_units: readonly string[];
  readonly superseded_units: readonly string[];
  readonly ignored_late_artifact_refs: readonly string[];
  readonly artifact_refs: readonly string[];
  readonly checkpoint_ref: string | null;
  readonly limitations: readonly string[];
}

export interface PublishDispatchLaunchRegistrationInput {
  readonly runId: string;
  readonly envelopes: readonly FormalArtifactEnvelope[];
}

export interface ResearchScope {
  readonly geography: string;
  readonly customerModel: "b2c" | "b2b" | "b2b2c" | "mixed";
  readonly targetUsers: readonly string[];
  readonly decisionGoal: string;
  readonly researchLanguage: string;
}

export interface CreateRunInput {
  readonly runId: string;
  readonly mode: RunMode;
  readonly createdAt?: string;
  readonly parentRunId?: string | null;
  readonly scopeProposal: ResearchScope;
  readonly faultAt?: "before_publish";
}

export interface ProposeScopeInput {
  readonly runId: string;
  readonly expectedScopeRevision: number;
  readonly scopeProposal: ResearchScope;
  readonly proposedAt?: string;
  readonly reason: string;
}

export interface ConfirmScopeInput {
  readonly runId: string;
  readonly expectedScopeProposalRevision: number;
  readonly expectedScopeProposalRef: string;
  readonly expectedScopeProposalHash: string;
  readonly confirmedAt?: string;
  readonly userConfirmationAttestation: string;
}

export interface ProposeScopeResult {
  readonly schemaVersion: "startup_opportunity.propose_scope_result.v1";
  readonly runId: string;
  readonly scopeRevision: number;
  readonly scopeProposalRef: string;
  readonly scopeProposalHash: string;
  readonly scopeProposal: ResearchScope;
  readonly status: "proposed" | "idempotent_replay";
}

export interface ConfirmScopeResult {
  readonly schemaVersion: "startup_opportunity.confirm_scope_result.v1";
  readonly runId: string;
  readonly scopeRevision: number;
  readonly scopeConfirmationRef: string;
  readonly scopeConfirmationHash: string;
  readonly confirmedScope: ResearchScope;
  readonly confirmationBasis: "caller_attested_user_confirmation";
  readonly harnessIdentityVerification: "not_available";
  readonly status: "confirmed" | "idempotent_replay";
}

export interface AdmitPriorInputInput {
  readonly runId: string;
  readonly priorInputId: string;
  readonly sourceRunId: string;
  readonly sourceArtifactPath: string;
  readonly targetArtifactPath: string;
  readonly consumer: "discovery_maps" | "discovery_candidates";
  readonly reason: string;
  readonly admittedAt?: string;
}

export interface AdmitPriorInputResult {
  readonly schemaVersion: "startup_opportunity.admit_prior_input_result.v1";
  readonly runId: string;
  readonly priorInputId: string;
  readonly decisionRef: string;
  readonly decisionHash: string;
  readonly sourceRunId: string;
  readonly sourceArtifactPath: string;
  readonly targetArtifactPath: string;
  readonly sourceContentHash: string;
  readonly consumer: "discovery_maps" | "discovery_candidates";
  readonly useBoundary: "hypothesis_input_only";
  readonly status: "appended" | "idempotent_replay";
}

export interface ReadPriorInputInput {
  readonly runId: string;
  readonly admissionRef: string;
  readonly consumedAt?: string;
}

export interface ReadPriorInputResult {
  readonly schemaVersion: "startup_opportunity.read_prior_input_result.v1";
  readonly runId: string;
  readonly admissionRef: string;
  readonly consumptionDecisionRef: string;
  readonly consumptionDecisionHash: string;
  readonly sourceRunId: string;
  readonly sourceArtifactPath: string;
  readonly sourceContentHash: string;
  readonly targetArtifactPath: string;
  readonly consumer: "discovery_maps" | "discovery_candidates";
  readonly useBoundary: "hypothesis_input_only";
  readonly sourceText: string;
  readonly status: "appended" | "idempotent_replay";
}

export type ResearchHandoffRole =
  | "user_authorized_input"
  | "reusable_evidence"
  | "prior_synthesis"
  | "revalidation_required";

export interface CreateResearchHandoffItemInput {
  readonly itemId: string;
  readonly sourceArtifactPath: string;
  readonly role: ResearchHandoffRole;
  readonly expectedSourceByteHash: string;
  readonly expectedSourceContentHash: string;
  readonly freshnessDisposition: "current" | "historical" | "unknown";
  readonly applicabilityDisposition: "applicable" | "partially_applicable" | "unknown";
  readonly revalidationStatus: "not_required" | "required";
  readonly targetArtifactRef?: string;
  readonly targetUnitId?: string;
  readonly targetResearchGoal?: string;
}

export interface CreateResearchHandoffInput {
  readonly runId: string;
  readonly handoffId: string;
  readonly sourceRunId: string;
  readonly userAuthorizationAttestation: string;
  readonly targetPurpose: string;
  readonly capturedAt?: string;
  readonly items: readonly CreateResearchHandoffItemInput[];
  readonly faultAt?: ResearchHandoffFaultBoundary;
}

export type ResearchHandoffFaultBoundary =
  | "after_intent"
  | "after_evidence_imports"
  | "after_handoff_publish";

export interface CreateResearchHandoffResult {
  readonly schemaVersion: "startup_opportunity.create_research_handoff_result.v1";
  readonly runId: string;
  readonly handoffRef: string;
  readonly handoffContentHash: string;
  readonly importedEvidenceRefs: readonly string[];
  readonly status: "published" | "idempotent_replay";
}

export interface ReadResearchHandoffInput {
  readonly runId: string;
  readonly handoffRef: string;
  readonly itemIds: readonly string[];
  readonly consumedAt?: string;
}

export interface ReadResearchHandoffResult {
  readonly schemaVersion: "startup_opportunity.read_research_handoff_result.v1";
  readonly runId: string;
  readonly handoffRef: string;
  readonly handoffContentHash: string;
  readonly consumptionDecisionRef: string;
  readonly consumptionDecisionHash: string;
  readonly status: "appended" | "idempotent_replay";
  readonly items: readonly {
    readonly itemId: string;
    readonly role: ResearchHandoffRole;
    readonly decisionBoundary: "hypothesis_input_only" | "evidence_reuse_with_current_weighting";
    readonly sourcePayload: string;
    readonly targetEvidenceRef: string | null;
  }[];
}

interface ResearchHandoffOperationIntent {
  readonly schema_version: "startup_opportunity.research_handoff_operation.current";
  readonly operation_key: string;
  readonly run_id: string;
  readonly handoff_ref: string;
  readonly request_identity: Record<string, unknown>;
  readonly envelope: FormalArtifactEnvelope;
  readonly evidence_imports: readonly {
    readonly record: EvidenceStoreRecord;
    readonly raw_content_base64: string;
  }[];
}

export interface ReformDecisionSubjectInput {
  readonly runId: string;
  readonly terminalSnapshotRef: string;
  readonly terminalSubjectId: string;
  readonly reformedSubjectRef: string;
  readonly reformationInputRefs: readonly string[];
  readonly reason: string;
  readonly reformedAt?: string;
}

export interface ReformDecisionSubjectResult {
  readonly schemaVersion: "startup_opportunity.reform_decision_subject_result.v1";
  readonly runId: string;
  readonly decisionRef: string;
  readonly decisionHash: string;
  readonly terminalSnapshotRef: string;
  readonly terminalSubjectRef: string;
  readonly reformedSubjectRef: string;
  readonly reformationInputHashes: readonly {
    readonly ref: string;
    readonly content_hash: string;
    readonly publication_ordinal: number;
  }[];
  readonly status: "appended" | "idempotent_replay";
}

export interface CreateRunResult {
  readonly schemaVersion: "startup_opportunity.create_run_result.v1";
  readonly status: "created" | "idempotent_replay";
  readonly runId: string;
  readonly manifest: RunManifest;
  readonly checkpointRef: string;
  readonly workingDirectory: string;
  readonly scopeProposalRef: string;
  readonly scopeProposalHash: string;
  readonly scopeProposal: ResearchScope;
}

export interface BeliefSummary {
  readonly current_belief: string;
  readonly evidence_that_changed_belief: readonly string[];
  readonly unchanged_assumptions: readonly string[];
  readonly remaining_disagreement: readonly string[];
  readonly next_decision_relevant_question: string;
}

export interface CheckpointRunInput {
  readonly runId: string;
  readonly checkpointId: string;
  readonly createdAt: string;
  readonly nextStep: string;
  readonly beliefSummary: BeliefSummary;
  readonly unresolvedGapRefs?: readonly string[];
  readonly inputRefs?: readonly string[];
  readonly faultAt?: "after_checkpoint_publish" | "after_manifest_update";
}

export interface CheckpointRunResult {
  readonly schemaVersion: "startup_opportunity.checkpoint_result.v1";
  readonly runId: string;
  readonly checkpointRef: string;
  readonly contentHash: string;
  readonly status: "published" | "idempotent_replay";
}

export interface LoadRunResult {
  readonly schemaVersion: "startup_opportunity.load_run_result.v1";
  readonly runId: string;
  readonly manifest: RunManifest;
  readonly recovered: boolean;
  readonly lastValidCheckpointRef: string;
  readonly recoveredArtifactPaths: readonly string[];
  readonly ignoredInvalidCheckpointPaths: readonly string[];
  readonly logRepairs: readonly JsonlRepairResult[];
  readonly evidenceRecovery: EvidenceRecoveryResult;
  readonly planOperationRecovery: PlanOperationRecoveryResult;
  readonly reportRecovery: ReportRecoveryResult;
  readonly orphanActiveUnits: readonly string[];
}

export interface StatusRunResult {
  readonly schemaVersion: "startup_opportunity.status_run_result.v1";
  readonly runId: string;
  readonly manifest: RunManifest;
  readonly continuationRunIds: readonly string[];
  readonly derivedExecutionDisposition: "current" | "continued" | "terminal" | "indeterminate";
  readonly currentLeafRunId: string | null;
  readonly continuationChain: readonly string[];
  readonly executionResolutionIssues: readonly string[];
  readonly terminalReportDisposition: "not_required" | "missing" | "invalid" | "ready";
  readonly terminalReportIssues: readonly string[];
  readonly workingDirectory: string;
  readonly resumeContext: {
    readonly runId: string;
    readonly mode: RunMode;
    readonly status: string;
    readonly currentPhase: string | null;
    readonly currentPlanRef: string | null;
    readonly checkpointRef: string | null;
    readonly activeUnitIds: readonly string[];
    readonly blockingReasons: readonly string[];
    readonly doctorRequired: false;
  };
  readonly observability: {
    readonly stageTimings: readonly {
      readonly stageId: string;
      readonly startedAt: string;
      readonly endedAt: string | null;
      readonly durationMs: number | null;
    }[];
    readonly laneTimings: readonly {
      readonly unitId: string;
      readonly attempt: number;
      readonly executionAttemptId: string;
      readonly attemptCount: number;
      readonly retryCount: number;
      readonly state: string;
      readonly startedAt: string;
      readonly endedAt: string | null;
      readonly durationMs: number | null;
    }[];
    readonly operationTimings: readonly {
      readonly operationId: string;
      readonly operation: "runtime_compile_publish";
      readonly attemptCount: number;
      readonly retryCount: number;
      readonly latestOutcome: "published" | "failed";
      readonly startedAt: string;
      readonly endedAt: string;
      readonly durationMs: number;
    }[];
    readonly validationRetryCount: number;
    readonly publishRetryCount: number;
    readonly failureClassifications: Readonly<Record<string, number>>;
    readonly artifactCount: number;
    readonly evidenceCount: number;
    readonly blockingReasons: readonly string[];
  };
}

export interface RuntimeOperationObservationInput {
  readonly runId: string;
  readonly operationId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly outcome: "published" | "failed";
  readonly failureClassification:
    | "validation_failed"
    | "publication_failed"
    | "runtime_blocked"
    | null;
  readonly errorCode: string | null;
  readonly artifactRefs: readonly string[];
}

export interface RunExecutionResolution {
  readonly schemaVersion: "startup_opportunity.run_execution_resolution.v1";
  readonly requestedRunId: string;
  readonly disposition: "current" | "continued" | "terminal" | "indeterminate";
  readonly currentLeafRunId: string | null;
  readonly continuationChain: readonly string[];
  readonly directContinuationRunIds: readonly string[];
  readonly issues: readonly string[];
}

export interface BuildValidationContextResult {
  readonly schemaVersion: "startup_opportunity.validation_context.v1";
  readonly bundle: DocumentBundle;
  readonly referenceContext: DocumentBundleReferenceContext;
  readonly planOperationRecovery: PlanOperationRecoveryResult;
}

const RUN_DIRECTORIES = [
  ".store/operations",
  ".store/temp",
  "adaptations/gap-snapshots",
  "adaptations/decisions",
  "artifacts/discovery",
  "artifacts/lanes",
  "artifacts/audits",
  "artifacts/assessment",
  "artifacts/traceability",
  "artifacts/reporting",
  "artifacts/synthesis",
  "artifacts/reviews",
  "artifacts/research-handoffs",
  "artifacts/comparison",
  "checkpoints",
  "claims",
  "evidence/raw",
  "findings",
  "insights",
  "judgments",
  "plans",
] as const;

function isCurrentEnvelopeSchema(value: unknown): boolean {
  return value === ARTIFACT_ENVELOPE_SCHEMA_VERSION;
}

const DISCOVERY_MAP_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.seed_probe.v1",
  "startup_opportunity.opportunity_space_map.v1",
  "startup_opportunity.solution_space_map.v1",
]);

const DISCOVERY_MAP_AGGREGATE_ROOTS = [
  "decision-context.json",
  "intake.json",
  "scope-frame.json",
] as const;

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "insufficient_evidence",
  "cancelled",
]);

interface ContinuationLineageEntry extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.continuation_lineage_entry.v1";
  readonly parent_run_id: string;
  readonly child_run_id: string;
  readonly child_identity_hash: string;
  readonly state: "pending" | "committed";
  readonly created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function researchHandoffOperationFilename(operationKeyValue: string): string {
  return `research-handoff-${sha256Hex(operationKeyValue)}.json`;
}

function isResearchHandoffFormationRef(ref: string): boolean {
  return (
    [
      "artifacts/discovery/seed-probe.r1.json",
      "artifacts/discovery/opportunity-space-map.r1.json",
      "artifacts/discovery/solution-space-map.r1.json",
      "concept-hypothesis.json",
    ].includes(ref) ||
    /^artifacts\/discovery\/candidates\/[A-Za-z0-9._-]+\.r[1-9][0-9]*\.json$/.test(ref) ||
    /^artifacts\/discovery\/opportunities\/[A-Za-z0-9._-]+\.r[1-9][0-9]*\.json$/.test(ref) ||
    /^artifacts\/assessment\/concepts\/[A-Za-z0-9._-]+\.r[1-9][0-9]*\.json$/.test(ref)
  );
}

function validateResearchHandoffOperationIntent(
  value: unknown,
  filename: string,
  runId: string,
): ResearchHandoffOperationIntent {
  if (
    !isRecord(value) ||
    value.schema_version !== "startup_opportunity.research_handoff_operation.current" ||
    typeof value.operation_key !== "string" ||
    value.run_id !== runId ||
    typeof value.handoff_ref !== "string" ||
    !isRecord(value.request_identity) ||
    !isRecord(value.envelope) ||
    !Array.isArray(value.evidence_imports) ||
    filename !== researchHandoffOperationFilename(value.operation_key)
  ) {
    throw new StoreError(
      "recovery.invalid_research_handoff_operation",
      "Research handoff operation intent is invalid",
      { path: `.store/operations/${filename}` },
    );
  }
  const intent = value as unknown as ResearchHandoffOperationIntent;
  const request = intent.request_identity;
  const handoffDocument = intent.envelope.document;
  const requestItems = records(request.items);
  const capturedItems = records(handoffDocument.items);
  const capturedById = new Map(capturedItems.map((item) => [String(item.item_id), item]));
  const expectedInputRefs = [
    handoffDocument.target_scope_ref,
    ...(handoffDocument.target_plan_ref === null ? [] : [handoffDocument.target_plan_ref]),
  ].sort();
  const requestItemsValid =
    requestItems.length > 0 &&
    requestItems.length === capturedItems.length &&
    requestItems.every((item) => {
      const captured = capturedById.get(String(item.itemId));
      if (captured === undefined) return false;
      const evidence = captured.source_kind === "evidence_substrate";
      return (
        captured.source_artifact_path === item.sourceArtifactPath &&
        captured.role === item.role &&
        captured.source_byte_hash === item.expectedSourceByteHash &&
        (evidence
          ? captured.source_record_hash === item.expectedSourceContentHash
          : captured.source_content_hash === item.expectedSourceContentHash) &&
        captured.freshness_disposition === item.freshnessDisposition &&
        captured.applicability_disposition === item.applicabilityDisposition &&
        captured.revalidation_status === item.revalidationStatus &&
        (evidence
          ? captured.target_unit_id === item.targetUnitId &&
            captured.target_research_goal === item.targetResearchGoal &&
            captured.target_artifact_ref === null
          : captured.target_unit_id === null &&
            captured.target_research_goal === null &&
            captured.target_artifact_ref === item.targetArtifactRef)
      );
    });
  const capturedItemsValid = capturedItems.every(
    (item) =>
      researchHandoffCapturedPayloadValid(item, handoffDocument.source_run_id) &&
      researchHandoffSourceRoleAllowed(String(item.source_schema_version), String(item.role)) &&
      item.source_captured_at === handoffDocument.captured_at &&
      item.source_payload_encoding === "base64" &&
      item.decision_boundary ===
        (item.source_kind === "evidence_substrate"
          ? "evidence_reuse_with_current_weighting"
          : "hypothesis_input_only"),
  );
  const evidenceImportsValid = intent.evidence_imports.every((entry) => {
    if (
      !isRecord(entry) ||
      !isRecord(entry.record) ||
      typeof entry.raw_content_base64 !== "string"
    ) {
      return false;
    }
    try {
      const prepared = prepareEvidenceRecord({
        runId,
        unitId: entry.record.unit_id,
        source: entry.record.source,
        researchGoal: entry.record.research_goal,
        rawContent: Buffer.from(entry.raw_content_base64, "base64"),
        recordedAt: entry.record.recorded_at,
        operationKey: entry.record.operation_key,
        ...(entry.record.handoff_binding === undefined
          ? {}
          : { handoffBinding: entry.record.handoff_binding }),
      });
      return canonicalJson(prepared.record) === canonicalJson(entry.record);
    } catch {
      return false;
    }
  });
  const evidenceItems = capturedItems.filter((item) => item.source_kind === "evidence_substrate");
  const evidenceImportItemIds = intent.evidence_imports.flatMap((entry) => {
    const binding = isRecord(entry.record.handoff_binding) ? entry.record.handoff_binding : null;
    return typeof binding?.handoff_item_id === "string" ? [binding.handoff_item_id] : [];
  });
  const evidenceClosureValid =
    intent.evidence_imports.length === evidenceItems.length &&
    new Set(evidenceImportItemIds).size === evidenceItems.length &&
    evidenceItems.every((item) => evidenceImportItemIds.includes(String(item.item_id))) &&
    intent.evidence_imports.every((entry) => {
      const binding = isRecord(entry.record.handoff_binding)
        ? entry.record.handoff_binding
        : undefined;
      const captured = capturedItems.find(
        (item) => binding !== undefined && item.item_id === binding.handoff_item_id,
      );
      return (
        binding !== undefined &&
        captured?.source_kind === "evidence_substrate" &&
        binding.handoff_ref === intent.handoff_ref &&
        binding.source_run_id === handoffDocument.source_run_id &&
        binding.source_evidence_path === captured.source_artifact_path &&
        binding.source_record_hash === captured.source_record_hash &&
        binding.source_raw_content_hash === captured.source_raw_content_hash &&
        `evidence/manifest.jsonl#${entry.record.evidence_id}` === captured.target_evidence_ref &&
        canonicalContentHash(entry.record) === captured.target_evidence_record_hash
      );
    });
  if (
    intent.operation_key !== operationKey("create_research_handoff", intent.request_identity) ||
    intent.envelope.schema_version !== ARTIFACT_ENVELOPE_SCHEMA_VERSION ||
    intent.envelope.artifact_path !== intent.handoff_ref ||
    intent.handoff_ref !== `artifacts/research-handoffs/${String(request.handoff_id)}.json` ||
    intent.envelope.run_id !== runId ||
    intent.envelope.artifact_type !== "startup_opportunity.research_handoff.current" ||
    intent.envelope.producer_role !== "harness" ||
    intent.envelope.created_at !== request.captured_at ||
    canonicalJson([...intent.envelope.input_refs].sort()) !== canonicalJson(expectedInputRefs) ||
    intent.envelope.content_hash !== canonicalContentHash(intent.envelope.document) ||
    handoffDocument.schema_version !== "startup_opportunity.research_handoff.current" ||
    handoffDocument.run_id !== runId ||
    handoffDocument.handoff_id !== request.handoff_id ||
    handoffDocument.source_run_id !== request.source_run_id ||
    handoffDocument.target_formation_stage !== request.target_formation_stage ||
    handoffDocument.user_authorization_attestation !== request.user_authorization_attestation ||
    handoffDocument.target_purpose !== request.target_purpose ||
    handoffDocument.captured_at !== request.captured_at ||
    handoffDocument.target_scope_ref !== request.target_scope_ref ||
    handoffDocument.target_scope_hash !== request.target_scope_hash ||
    handoffDocument.target_scope_revision !== request.target_scope_revision ||
    handoffDocument.target_scope_confirmation_ref !== request.target_scope_confirmation_ref ||
    handoffDocument.target_scope_confirmation_hash !== request.target_scope_confirmation_hash ||
    handoffDocument.target_plan_ref !== request.target_plan_ref ||
    handoffDocument.target_plan_hash !== request.target_plan_hash ||
    !requestItemsValid ||
    !capturedItemsValid ||
    !evidenceImportsValid ||
    !evidenceClosureValid
  ) {
    throw new StoreError(
      "recovery.invalid_research_handoff_operation",
      "Research handoff operation identity, envelope, or Evidence bytes are inconsistent",
      { path: `.store/operations/${filename}` },
    );
  }
  return intent;
}

function assertDisjoint(manifest: RunManifest, fields: readonly string[]): void {
  const owner = new Map<string, string>();
  for (const field of fields) {
    const values = manifest[field];
    if (!Array.isArray(values)) {
      continue;
    }
    for (const value of values) {
      if (typeof value !== "string") {
        continue;
      }
      const previous = owner.get(value);
      if (previous) {
        throw new StoreError("manifest.mutually_exclusive", "manifest status sets overlap", {
          value,
          fields: [previous, field],
        });
      }
      owner.set(value, field);
    }
  }
}

function checkpointDocument(envelope: FormalArtifactEnvelope): Record<string, unknown> | null {
  return envelope.artifact_type === "startup_opportunity.checkpoint.v1" ? envelope.document : null;
}

function recoveryTransitionRank(envelope: FormalArtifactEnvelope): number {
  if (envelope.artifact_type === "startup_opportunity.research_plan.v1") {
    return -1;
  }
  if (
    envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current" ||
    envelope.artifact_type === "startup_opportunity.dispatch_batch.assessment.current" ||
    envelope.artifact_type === "startup_opportunity.research_task.assessment.current" ||
    envelope.artifact_type === "startup_opportunity.research_task.discovery_candidate.current" ||
    envelope.artifact_type === "startup_opportunity.research_task.discovery_evaluation.current"
  ) {
    return 0;
  }
  if (
    envelope.artifact_type === "startup_opportunity.discovery_generation_result.v1" ||
    envelope.artifact_type === "startup_opportunity.assessment_lane_result.v1" ||
    envelope.artifact_type === "startup_opportunity.concept_evidence_assessment_branch_result.v1" ||
    envelope.artifact_type === "startup_opportunity.discovery_lane_result.v1" ||
    envelope.artifact_type === "startup_opportunity.enrichment_branch_result.v1"
  ) {
    return 2;
  }
  if (envelope.artifact_type === "startup_opportunity.assessment_stage_gate.v1") {
    return 3;
  }
  return 1;
}

function makeManifest(input: CreateRunInput, createdAt: string): RunManifest {
  const proposal = scopeProposalRecord(
    input.runId,
    1,
    input.scopeProposal,
    createdAt,
    "Caller proposed this Scope for user review; no user confirmation is asserted.",
  );
  return {
    schema_version: "startup_opportunity.run_manifest.v1",
    run_id: input.runId,
    mode: input.mode,
    status: "awaiting_scope_confirmation",
    status_before_clarification: null,
    parent_run_id: input.parentRunId ?? null,
    scope_proposal_ref: `decisions.jsonl#${String(proposal.decision_id)}`,
    scope_proposal_hash: canonicalContentHash(proposal),
    scope_confirmation_ref: null,
    scope_confirmation_hash: null,
    scope_revision: 1,
    created_at: createdAt,
    updated_at: createdAt,
    current_phase: null,
    current_plan_ref: null,
    plan_revision: 0,
    current_decision_subject_snapshot_ref: null,
    current_decision_subject_snapshot_hash: null,
    followup_round: 0,
    latest_gap_snapshot_ref: null,
    pending_adaptation_refs: [],
    validated_adaptation_refs: [],
    rejected_adaptation_refs: [],
    applied_adaptation_refs: [],
    completed_units: [],
    active_units: [],
    failed_units: [],
    invalidated_units: [],
    skipped_units: [],
    cancelled_units: [],
    superseded_units: [],
    ignored_late_artifact_refs: [],
    artifact_refs: [],
    checkpoint_ref: null,
    limitations: [],
  };
}

const RESEARCH_LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const RESEARCH_LANGUAGE_ALIASES = new Map<string, string>([
  ["中文", "zh-CN"],
  ["简体中文", "zh-CN"],
  ["簡體中文", "zh-CN"],
  ["繁体中文", "zh-TW"],
  ["繁體中文", "zh-TW"],
]);

export function canonicalResearchLanguage(value: string): string {
  const input = value.trim();
  const candidate = RESEARCH_LANGUAGE_ALIASES.get(input) ?? input;
  let canonical: string;
  try {
    canonical = Intl.getCanonicalLocales(candidate)[0] ?? "";
  } catch {
    throw new StoreError(
      "run.research_language_invalid",
      "researchLanguage must be a supported language name or canonicalizable BCP-47 tag",
      { researchLanguage: value },
    );
  }
  if (!RESEARCH_LANGUAGE_PATTERN.test(canonical)) {
    throw new StoreError(
      "run.research_language_invalid",
      "researchLanguage canonicalization produced an unsupported BCP-47 shape",
      { researchLanguage: value, canonicalResearchLanguage: canonical },
    );
  }
  return canonical;
}

function canonicalResearchScope(scope: ResearchScope): ResearchScope {
  return {
    ...scope,
    researchLanguage: canonicalResearchLanguage(scope.researchLanguage),
  };
}

function researchScopeFromDocument(scope: Record<string, unknown>): ResearchScope {
  return {
    geography: String(scope.geography),
    customerModel: scope.customer_model as ResearchScope["customerModel"],
    targetUsers: Array.isArray(scope.target_users)
      ? scope.target_users.filter((value): value is string => typeof value === "string")
      : [],
    decisionGoal: String(scope.decision_goal),
    researchLanguage: canonicalResearchLanguage(String(scope.research_language)),
  };
}

function scopeDocument(scope: ResearchScope, revision: number): Record<string, unknown> {
  const canonicalScope = canonicalResearchScope(scope);
  return {
    revision,
    geography: canonicalScope.geography,
    customer_model: canonicalScope.customerModel,
    target_users: [...canonicalScope.targetUsers],
    decision_goal: canonicalScope.decisionGoal,
    research_language: canonicalScope.researchLanguage,
  };
}

function scopeProposalRecord(
  runId: string,
  revision: number,
  scope: ResearchScope,
  timestamp: string,
  reason: string,
): Record<string, unknown> {
  const document = scopeDocument(scope, revision);
  const scopeHash = canonicalContentHash(document);
  return {
    schema_version: "startup_opportunity.decision.v1",
    decision_id: `scope_proposal_r${revision}_${sha256Hex(scopeHash)}`,
    run_id: runId,
    decision_type: "scope_proposed",
    timestamp,
    actor: "main_agent",
    reason,
    artifact_refs: [],
    scope_revision: revision,
    scope_hash: scopeHash,
    scope: document,
  };
}

function scopeConfirmationRecord(
  runId: string,
  proposal: Record<string, unknown>,
  timestamp: string,
  userConfirmationAttestation: string,
  supersededFormationRefs: readonly string[],
): Record<string, unknown> {
  const revision = Number(proposal.scope_revision);
  const proposalRef = `decisions.jsonl#${String(proposal.decision_id)}`;
  const scopeHash = String(proposal.scope_hash);
  return {
    schema_version: "startup_opportunity.decision.v1",
    decision_id: `scope_confirmation_r${revision}_${sha256Hex(scopeHash)}`,
    run_id: runId,
    decision_type: revision === 1 ? "scope_assumption_confirmed" : "scope_changed_by_user",
    timestamp,
    actor: "main_agent",
    reason: userConfirmationAttestation,
    artifact_refs: [],
    scope_revision: revision,
    scope_hash: scopeHash,
    scope: proposal.scope,
    scope_proposal_ref: proposalRef,
    scope_proposal_hash: canonicalContentHash(proposal),
    confirmation_basis: "caller_attested_user_confirmation",
    harness_identity_verification: "not_available",
    superseded_formation_refs: [...supersededFormationRefs].sort(),
  };
}

const PRE_PLAN_FORMATION_TYPES = new Set([
  "startup_opportunity.intake.v1",
  "startup_opportunity.decision_context.v1",
  "startup_opportunity.scope_frame.discovery.current",
  "startup_opportunity.scope_frame.assessment.current",
  "startup_opportunity.concept_hypothesis.assessment.current",
  "startup_opportunity.concept_hypothesis.assessment_intake.current",
]);

const PLANNING_PUBLICATION_TYPES = new Set([
  "startup_opportunity.research_plan.v1",
  "startup_opportunity.concept_evidence_assessment_plan.v1",
  "startup_opportunity.planning_context.general.current",
  "startup_opportunity.planning_context.ai_source_bound.current",
  "startup_opportunity.ai_trigger_source_attestation.v1",
]);

function prospectiveInitialPlanManifest(
  manifest: RunManifest,
  envelopes: readonly FormalArtifactEnvelope[],
): RunManifest | null {
  const initialPlan = envelopes.find(
    (envelope) =>
      envelope.artifact_type === "startup_opportunity.research_plan.v1" &&
      envelope.document.revision === 1,
  );
  if (initialPlan === undefined || manifest.current_plan_ref !== null) return null;
  return {
    ...manifest,
    status: "planned",
    status_before_clarification: null,
    current_phase: manifest.mode === "opportunity_discovery" ? "discovery" : "assessment",
    current_plan_ref: initialPlan.artifact_path,
    plan_revision: 1,
    artifact_refs: [
      ...new Set([
        ...manifest.artifact_refs,
        ...envelopes.map((envelope) => envelope.artifact_path),
      ]),
    ].sort(),
  };
}

interface ScopeBindingState {
  readonly proposal: Record<string, unknown>;
  readonly proposalRef: string;
  readonly proposalHash: string;
  readonly confirmation: Record<string, unknown> | null;
  readonly confirmationRef: string | null;
  readonly confirmationHash: string | null;
}

function continuationIdentity(manifest: RunManifest): Record<string, unknown> {
  return {
    run_id: manifest.run_id,
    mode: manifest.mode,
    parent_run_id: manifest.parent_run_id,
    created_at: manifest.created_at,
  };
}

export class RunStore {
  private readonly artifacts: ArtifactStore;
  private readonly logs: JsonlStore;
  private readonly evidence: EvidenceStore;

  constructor(
    private readonly runsRoot: string,
    private readonly validator: ArtifactValidator,
  ) {
    this.artifacts = new ArtifactStore(runsRoot, validator);
    this.logs = new JsonlStore(validator);
    this.evidence = new EvidenceStore(runsRoot);
  }

  private workingDirectory(runId: string): string {
    return `dist/research-working/${runId}`;
  }

  private async ensureWorkingDirectory(runId: string): Promise<void> {
    await mkdir(path.join(path.dirname(this.runsRoot), this.workingDirectory(runId)), {
      recursive: true,
    });
  }

  private async latestScopeState(runRoot: string, runId: string): Promise<ScopeBindingState> {
    const records = await this.logs.listValidatedRecords(runRoot, runId, "decisions.jsonl");
    const proposals = records
      .filter((record) => record.decision_type === "scope_proposed")
      .sort((left, right) => Number(left.scope_revision) - Number(right.scope_revision));
    const confirmations = records.filter((record) =>
      ["scope_assumption_confirmed", "scope_changed_by_user"].includes(
        String(record.decision_type),
      ),
    );
    if (proposals.length === 0) {
      throw new StoreError("run.scope_proposal_missing", "Run has no durable Scope proposal", {
        runId,
      });
    }
    for (const [index, proposal] of proposals.entries()) {
      const revision = index + 1;
      if (
        proposal.scope_revision !== revision ||
        !isRecord(proposal.scope) ||
        proposal.scope.revision !== revision ||
        proposal.scope_hash !== canonicalContentHash(proposal.scope) ||
        proposal.actor !== "main_agent" ||
        canonicalResearchLanguage(String(proposal.scope.research_language)) !==
          proposal.scope.research_language
      ) {
        throw new StoreError(
          "run.scope_proposal_invalid",
          "Scope proposals must form a contiguous immutable revision history",
          { runId, revision },
        );
      }
      const proposalRef = `decisions.jsonl#${String(proposal.decision_id)}`;
      const proposalHash = canonicalContentHash(proposal);
      const matches = confirmations.filter((candidate) => candidate.scope_revision === revision);
      if (matches.length > 1 || (index < proposals.length - 1 && matches.length !== 1)) {
        throw new StoreError(
          "run.scope_confirmation_invalid",
          "every superseded Scope proposal must have exactly one confirmation record",
          { runId, revision, confirmationCount: matches.length },
        );
      }
      const confirmation = matches[0];
      if (
        confirmation !== undefined &&
        (confirmation.decision_type !==
          (revision === 1 ? "scope_assumption_confirmed" : "scope_changed_by_user") ||
          confirmation.actor !== "main_agent" ||
          confirmation.scope_hash !== proposal.scope_hash ||
          canonicalJson(confirmation.scope) !== canonicalJson(proposal.scope) ||
          confirmation.scope_proposal_ref !== proposalRef ||
          confirmation.scope_proposal_hash !== proposalHash ||
          confirmation.confirmation_basis !== "caller_attested_user_confirmation" ||
          confirmation.harness_identity_verification !== "not_available")
      ) {
        throw new StoreError(
          "run.scope_confirmation_invalid",
          "Scope confirmation must bind the exact durable proposal and disclose the Harness identity boundary",
          { runId, revision },
        );
      }
    }
    if (
      confirmations.some(
        (confirmation) =>
          !proposals.some((proposal) => proposal.scope_revision === confirmation.scope_revision),
      )
    ) {
      throw new StoreError(
        "run.scope_confirmation_invalid",
        "Scope confirmation cannot exist without its exact proposal revision",
        { runId },
      );
    }
    const proposal = proposals.at(-1) as Record<string, unknown>;
    const confirmation =
      confirmations.find((candidate) => candidate.scope_revision === proposal.scope_revision) ??
      null;
    return {
      proposal,
      proposalRef: `decisions.jsonl#${String(proposal.decision_id)}`,
      proposalHash: canonicalContentHash(proposal),
      confirmation,
      confirmationRef:
        confirmation === null ? null : `decisions.jsonl#${String(confirmation.decision_id)}`,
      confirmationHash: confirmation === null ? null : canonicalContentHash(confirmation),
    };
  }

  private async assertScopeBindingLocked(
    runRoot: string,
    manifest: RunManifest,
  ): Promise<ScopeBindingState> {
    const latest = await this.latestScopeState(runRoot, manifest.run_id);
    if (
      manifest.scope_revision !== latest.proposal.scope_revision ||
      manifest.scope_proposal_ref !== latest.proposalRef ||
      manifest.scope_proposal_hash !== latest.proposalHash ||
      manifest.scope_confirmation_ref !== latest.confirmationRef ||
      manifest.scope_confirmation_hash !== latest.confirmationHash ||
      (latest.confirmation === null) !== (manifest.status === "awaiting_scope_confirmation")
    ) {
      throw new StoreError(
        "run.scope_binding_mismatch",
        "Manifest does not bind the latest durable Scope proposal and confirmation records",
        {
          expectedRevision: latest.proposal.scope_revision,
          expectedProposalRef: latest.proposalRef,
          expectedProposalHash: latest.proposalHash,
          expectedConfirmationRef: latest.confirmationRef,
          expectedConfirmationHash: latest.confirmationHash,
        },
      );
    }
    return latest;
  }

  private async bindLatestScopeState(runRoot: string, manifest: RunManifest): Promise<RunManifest> {
    const latest = await this.latestScopeState(runRoot, manifest.run_id);
    const revision = Number(latest.proposal.scope_revision);
    const proposalAdvanced =
      revision > manifest.scope_revision || manifest.scope_proposal_ref !== latest.proposalRef;
    const confirmationAdvanced = manifest.scope_confirmation_ref !== latest.confirmationRef;
    const priorStatus = proposalAdvanced
      ? manifest.status === "awaiting_scope_confirmation" ||
        manifest.status === "needs_clarification"
        ? (manifest.status_before_clarification ??
          (manifest.current_plan_ref === null ? "created" : null))
        : manifest.status
      : manifest.status_before_clarification;
    const status =
      latest.confirmation === null
        ? "awaiting_scope_confirmation"
        : confirmationAdvanced
          ? revision === 1
            ? "created"
            : "needs_clarification"
          : manifest.status;
    const timestamps = [latest.proposal.timestamp, latest.confirmation?.timestamp]
      .filter((value): value is string => typeof value === "string")
      .sort();
    const latestTimestamp = timestamps.at(-1);
    const supersededAdaptationRefs =
      latest.confirmation !== null && confirmationAdvanced && revision > 1
        ? [...manifest.pending_adaptation_refs, ...manifest.validated_adaptation_refs]
        : [];
    return {
      ...manifest,
      status,
      status_before_clarification:
        latest.confirmation === null ? priorStatus : revision === 1 ? null : priorStatus,
      scope_revision: revision,
      scope_proposal_ref: latest.proposalRef,
      scope_proposal_hash: latest.proposalHash,
      scope_confirmation_ref: latest.confirmationRef,
      scope_confirmation_hash: latest.confirmationHash,
      pending_adaptation_refs:
        supersededAdaptationRefs.length > 0 ? [] : manifest.pending_adaptation_refs,
      validated_adaptation_refs:
        supersededAdaptationRefs.length > 0 ? [] : manifest.validated_adaptation_refs,
      rejected_adaptation_refs: [
        ...new Set([...manifest.rejected_adaptation_refs, ...supersededAdaptationRefs]),
      ].sort(),
      updated_at:
        latestTimestamp !== undefined &&
        Date.parse(latestTimestamp) > Date.parse(manifest.updated_at)
          ? latestTimestamp
          : manifest.updated_at,
    };
  }

  async assertScopeConfirmed(runId: string): Promise<void> {
    validateRunId(runId);
    const runRoot = await openRunDirectoryReadOnly(this.runsRoot, runId);
    const manifest = await this.readManifest(runRoot);
    const state = await this.assertScopeBindingLocked(runRoot, manifest);
    if (state.confirmation === null) {
      throw new StoreError(
        "run.scope_confirmation_required",
        "research requires an independent confirmation bound to the exact Scope proposal",
        { scopeProposalRef: state.proposalRef, scopeProposalHash: state.proposalHash },
      );
    }
  }

  async assertResearchExecutionAllowed(runId: string): Promise<void> {
    validateRunId(runId);
    const runRoot = await openRunDirectoryReadOnly(this.runsRoot, runId);
    const manifest = await this.readManifest(runRoot);
    const state = await this.assertScopeBindingLocked(runRoot, manifest);
    if (state.confirmation === null) {
      throw new StoreError(
        "run.scope_confirmation_required",
        "research is blocked until the exact Scope proposal is independently confirmed",
        { scopeProposalRef: state.proposalRef, scopeProposalHash: state.proposalHash },
      );
    }
    if (manifest.status === "needs_clarification") {
      throw new StoreError(
        "run.scope_revision_unresolved",
        "the latest user Scope revision must be reconciled through the current Plan workflow before research continues",
        { scopeRevision: manifest.scope_revision },
      );
    }
  }

  async proposeScope(input: ProposeScopeInput): Promise<ProposeScopeResult> {
    validateRunId(input.runId);
    await this.assertCurrentLeaf(input.runId);
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      const manifest = await this.readManifest(runRoot);
      const state = await this.assertScopeBindingLocked(runRoot, manifest);
      if (TERMINAL_RUN_STATUSES.has(manifest.status) || manifest.status === "reporting") {
        throw new StoreError(
          "run.scope_change_terminal",
          "terminal or reporting Runs cannot change Scope",
          {
            status: manifest.status,
          },
        );
      }
      const revision = input.expectedScopeRevision + 1;
      const proposal = scopeProposalRecord(
        input.runId,
        revision,
        input.scopeProposal,
        input.proposedAt ?? new Date().toISOString(),
        input.reason,
      );
      const proposalRef = `decisions.jsonl#${String(proposal.decision_id)}`;
      const proposalHash = canonicalContentHash(proposal);
      if (state.confirmation === null) {
        if (
          state.proposal.scope_revision === revision &&
          state.proposalRef === proposalRef &&
          state.proposalHash === proposalHash
        ) {
          return {
            schemaVersion: "startup_opportunity.propose_scope_result.v1",
            runId: input.runId,
            scopeRevision: revision,
            scopeProposalRef: proposalRef,
            scopeProposalHash: proposalHash,
            scopeProposal: researchScopeFromDocument(proposal.scope as Record<string, unknown>),
            status: "idempotent_replay",
          };
        }
        throw new StoreError(
          "run.scope_proposal_pending",
          "the current Scope proposal must be confirmed before proposing another revision",
          { scopeProposalRef: state.proposalRef },
        );
      }
      if (manifest.scope_revision !== input.expectedScopeRevision) {
        throw new StoreError(
          "run.scope_revision_conflict",
          "Scope proposal expected a different confirmed revision",
          { expected: input.expectedScopeRevision, actual: manifest.scope_revision },
        );
      }
      const appendStatus = await this.logs.appendValidated(
        runRoot,
        input.runId,
        "decisions.jsonl",
        proposal,
      );
      const nextManifest: RunManifest = {
        ...manifest,
        status: "awaiting_scope_confirmation",
        status_before_clarification:
          manifest.status === "needs_clarification"
            ? manifest.status_before_clarification
            : manifest.status,
        scope_revision: revision,
        scope_proposal_ref: proposalRef,
        scope_proposal_hash: proposalHash,
        scope_confirmation_ref: null,
        scope_confirmation_hash: null,
        updated_at: String(proposal.timestamp),
      };
      await this.writeManifest(runRoot, nextManifest);
      return {
        schemaVersion: "startup_opportunity.propose_scope_result.v1",
        runId: input.runId,
        scopeRevision: revision,
        scopeProposalRef: proposalRef,
        scopeProposalHash: proposalHash,
        scopeProposal: researchScopeFromDocument(proposal.scope as Record<string, unknown>),
        status: appendStatus === "appended" ? "proposed" : "idempotent_replay",
      };
    });
  }

  async confirmScope(input: ConfirmScopeInput): Promise<ConfirmScopeResult> {
    validateRunId(input.runId);
    await this.assertCurrentLeaf(input.runId);
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      const manifest = await this.readManifest(runRoot);
      const state = await this.assertScopeBindingLocked(runRoot, manifest);
      if (TERMINAL_RUN_STATUSES.has(manifest.status) || manifest.status === "reporting") {
        throw new StoreError(
          "run.scope_change_terminal",
          "terminal or reporting Runs cannot change Scope",
          { status: manifest.status },
        );
      }
      const revision = input.expectedScopeProposalRevision;
      if (
        state.proposal.scope_revision !== revision ||
        state.proposalRef !== input.expectedScopeProposalRef ||
        state.proposalHash !== input.expectedScopeProposalHash
      ) {
        throw new StoreError(
          "run.scope_proposal_binding_mismatch",
          "confirmation must bind the exact Scope proposal revision, ref, and hash shown to the user",
          {
            expectedRevision: state.proposal.scope_revision,
            expectedRef: state.proposalRef,
            expectedHash: state.proposalHash,
          },
        );
      }
      const supersededFormationRefs =
        state.confirmation === null
          ? manifest.current_plan_ref === null
            ? await this.prePlanFormationRefsLocked(runRoot)
            : []
          : [...strings(state.confirmation.superseded_formation_refs)].sort();
      const decision = scopeConfirmationRecord(
        input.runId,
        state.proposal,
        input.confirmedAt ?? new Date().toISOString(),
        input.userConfirmationAttestation,
        supersededFormationRefs,
      );
      const decisionRef = `decisions.jsonl#${String(decision.decision_id)}`;
      const decisionHash = canonicalContentHash(decision);
      if (state.confirmation !== null) {
        if (
          state.confirmationRef !== decisionRef ||
          state.confirmationHash !== decisionHash ||
          canonicalJson(state.confirmation) !== canonicalJson(decision)
        ) {
          throw new StoreError(
            "run.scope_confirmation_conflict",
            "the Scope proposal was already confirmed with a different attestation",
            { scopeProposalRef: state.proposalRef },
          );
        }
        return {
          schemaVersion: "startup_opportunity.confirm_scope_result.v1",
          runId: input.runId,
          scopeRevision: revision,
          scopeConfirmationRef: decisionRef,
          scopeConfirmationHash: decisionHash,
          confirmedScope: researchScopeFromDocument(
            state.proposal.scope as Record<string, unknown>,
          ),
          confirmationBasis: "caller_attested_user_confirmation",
          harnessIdentityVerification: "not_available",
          status: "idempotent_replay",
        };
      }
      const status = await this.logs.appendValidated(
        runRoot,
        input.runId,
        "decisions.jsonl",
        decision,
      );
      const nextManifest: RunManifest = {
        ...manifest,
        status: revision === 1 ? "created" : "needs_clarification",
        status_before_clarification: revision === 1 ? null : manifest.status_before_clarification,
        scope_confirmation_ref: decisionRef,
        scope_confirmation_hash: decisionHash,
        pending_adaptation_refs: revision === 1 ? manifest.pending_adaptation_refs : [],
        validated_adaptation_refs: revision === 1 ? manifest.validated_adaptation_refs : [],
        rejected_adaptation_refs:
          revision === 1
            ? manifest.rejected_adaptation_refs
            : [
                ...new Set([
                  ...manifest.rejected_adaptation_refs,
                  ...manifest.pending_adaptation_refs,
                  ...manifest.validated_adaptation_refs,
                ]),
              ].sort(),
        artifact_refs:
          revision > 1 && supersededFormationRefs.length > 0
            ? manifest.artifact_refs.filter((ref) => !supersededFormationRefs.includes(ref))
            : manifest.artifact_refs,
        updated_at: String(decision.timestamp),
      };
      await this.writeManifest(runRoot, nextManifest);
      return {
        schemaVersion: "startup_opportunity.confirm_scope_result.v1",
        runId: input.runId,
        scopeRevision: revision,
        scopeConfirmationRef: decisionRef,
        scopeConfirmationHash: decisionHash,
        confirmedScope: researchScopeFromDocument(state.proposal.scope as Record<string, unknown>),
        confirmationBasis: "caller_attested_user_confirmation",
        harnessIdentityVerification: "not_available",
        status: status === "appended" ? "confirmed" : "idempotent_replay",
      };
    });
  }

  private async registerContinuation(
    validatedRunsRoot: string,
    manifest: RunManifest,
    state: ContinuationLineageEntry["state"] = "committed",
  ): Promise<void> {
    if (manifest.parent_run_id === null) {
      return;
    }
    const entry: ContinuationLineageEntry = {
      schema_version: "startup_opportunity.continuation_lineage_entry.v1",
      parent_run_id: manifest.parent_run_id,
      child_run_id: manifest.run_id,
      child_identity_hash: canonicalContentHash(continuationIdentity(manifest)),
      state,
      created_at: manifest.created_at,
    };
    const validation = this.validator.validateDocument(entry);
    if (!validation.valid) {
      throw new StoreError(
        "continuation.index_invalid",
        "continuation lineage entry is not schema-valid",
        { errors: validation.errors },
      );
    }
    await mkdir(path.join(validatedRunsRoot, ".store", "temp"), { recursive: true });
    await atomicReplace(
      validatedRunsRoot,
      `.continuations/${manifest.parent_run_id}/${manifest.run_id}.json`,
      `${canonicalJson(entry)}\n`,
      `continuation-${sha256Hex(operationKey("continuation_index", entry))}`,
    );
  }

  async create(input: CreateRunInput): Promise<CreateRunResult> {
    validateRunId(input.runId);
    if (input.parentRunId !== undefined && input.parentRunId !== null) {
      validateRunId(input.parentRunId);
      if (input.parentRunId === input.runId) {
        throw new StoreError("run.invalid_parent", "Run cannot be its own parent", {
          runId: input.runId,
        });
      }
      const resolution = await this.resolveExecution(input.parentRunId);
      if (
        resolution.disposition === "indeterminate" ||
        resolution.currentLeafRunId !== input.parentRunId
      ) {
        throw new StoreError(
          "run.parent_not_current_leaf",
          "continuation parent must be the authoritative current leaf",
          {
            parentRunId: input.parentRunId,
            currentLeafRunId: resolution.currentLeafRunId,
            issues: resolution.issues,
          },
        );
      }
      const parentRoot = await openRunDirectoryReadOnly(this.runsRoot, input.parentRunId);
      const parent = await this.readManifest(parentRoot);
      if (TERMINAL_RUN_STATUSES.has(parent.status) || parent.status === "reporting") {
        throw new StoreError(
          "run.reporting_continuation_forbidden",
          "terminal reporting must be completed on the original research Run",
          { parentRunId: input.parentRunId, parentStatus: parent.status },
        );
      }
      if (parent.mode !== input.mode) {
        throw new StoreError("run.parent_mode_mismatch", "continuation cannot change Run mode", {
          parentMode: parent.mode,
          requestedMode: input.mode,
        });
      }
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const manifest = makeManifest(input, createdAt);
    this.validateManifest(manifest);
    const proposalRecord = scopeProposalRecord(
      input.runId,
      1,
      input.scopeProposal,
      createdAt,
      "Caller proposed this Scope for user review; no user confirmation is asserted.",
    );
    const proposalRef = `decisions.jsonl#${String(proposalRecord.decision_id)}`;
    const proposalHash = canonicalContentHash(proposalRecord);
    const scopeValidation = this.validator.validateDocument(proposalRecord, "decisions.jsonl");
    if (!scopeValidation.valid) {
      throw new StoreError(
        "run.scope_proposal_invalid",
        "initial Scope proposal is not schema-valid",
        { errors: scopeValidation.errors },
      );
    }
    const event = {
      schema_version: "startup_opportunity.event.v1",
      event_id: `run_created_${sha256Hex(operationKey("run_created", { run_id: input.runId }))}`,
      run_id: input.runId,
      event_type: "run_created",
      timestamp: createdAt,
      actor: "harness",
      reason: "The deterministic Run Store created the Run boundary.",
      artifact_refs: [],
    };
    const eventValidation = this.validator.validateDocument(event, "events.jsonl");
    if (!eventValidation.valid) {
      throw new StoreError("run.initial_event_invalid", "initial Run Event is not schema-valid", {
        errors: eventValidation.errors,
      });
    }

    return withRunCreationLock(this.runsRoot, input.runId, async (runsRoot) => {
      const target = path.join(runsRoot, input.runId);
      try {
        await lstat(target);
        let loaded: LoadRunResult;
        try {
          loaded = await this.load(input.runId);
        } catch (error) {
          if (
            isNodeError(error, "ENOENT") ||
            (error instanceof StoreError && error.code === "path.parent_missing")
          ) {
            throw new StoreError(
              "run.incomplete",
              "existing Run boundary is missing required durable state",
              { runId: input.runId },
            );
          }
          throw error;
        }
        const initialProposal = await this.logs.readExactRecord(
          target,
          input.runId,
          proposalRef,
          "decisions.jsonl",
        );
        if (
          loaded.manifest.mode !== input.mode ||
          loaded.manifest.parent_run_id !== (input.parentRunId ?? null) ||
          initialProposal.scope_hash !== proposalRecord.scope_hash ||
          canonicalJson(initialProposal.scope) !== canonicalJson(proposalRecord.scope)
        ) {
          throw new StoreError("write.conflict", "existing Run has different create parameters", {
            runId: input.runId,
          });
        }
        await this.registerContinuation(runsRoot, loaded.manifest);
        await this.ensureWorkingDirectory(input.runId);
        return {
          schemaVersion: "startup_opportunity.create_run_result.v1",
          status: "idempotent_replay",
          runId: input.runId,
          manifest: loaded.manifest,
          checkpointRef: loaded.lastValidCheckpointRef,
          workingDirectory: this.workingDirectory(input.runId),
          scopeProposalRef: proposalRef,
          scopeProposalHash: canonicalContentHash(initialProposal),
          scopeProposal: researchScopeFromDocument(
            initialProposal.scope as Record<string, unknown>,
          ),
        };
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
      }

      const stagingRoot = await mkdtemp(path.join(runsRoot, `.create-${input.runId}-`));
      let continuationPending = false;
      let published = false;
      try {
        for (const directory of RUN_DIRECTORIES) {
          await mkdir(path.join(stagingRoot, directory), { recursive: true });
        }
        for (const logPath of [
          "events.jsonl",
          "decisions.jsonl",
          "evidence/manifest.jsonl",
        ] as const) {
          const temporary = `.store/temp/create-${logPath.replaceAll("/", "-")}.tmp`;
          await writeSyncedTemp(stagingRoot, temporary, "");
          await publishTemp(stagingRoot, temporary, logPath);
        }
        await this.writeManifest(stagingRoot, manifest);
        await this.logs.appendValidated(
          stagingRoot,
          input.runId,
          "decisions.jsonl",
          proposalRecord,
        );
        await this.logs.appendValidated(stagingRoot, input.runId, "events.jsonl", event);
        const checkpoint = await this.checkpointLocked(stagingRoot, {
          runId: input.runId,
          checkpointId: "checkpoint_initial",
          createdAt,
          nextStep: "Present the exact Scope proposal and obtain explicit confirmation.",
          beliefSummary: {
            current_belief: "No research belief has been recorded.",
            evidence_that_changed_belief: [],
            unchanged_assumptions: [],
            remaining_disagreement: [],
            next_decision_relevant_question: "What decision should this Run answer?",
          },
          inputRefs: [`events.jsonl#${event.event_id}`, proposalRef],
        });
        const finalManifest = await this.readManifest(stagingRoot);
        if (input.faultAt === "before_publish") {
          throw new StoreError("fault.injected", "injected failure before atomic Run publication");
        }
        if (finalManifest.parent_run_id !== null) {
          await this.registerContinuation(runsRoot, finalManifest, "pending");
          continuationPending = true;
        }
        try {
          await rename(stagingRoot, target);
          published = true;
          await syncDirectory(runsRoot);
          await this.registerContinuation(runsRoot, finalManifest);
        } catch (error) {
          if (continuationPending && !published && finalManifest.parent_run_id !== null) {
            await rm(
              path.join(
                runsRoot,
                ".continuations",
                finalManifest.parent_run_id,
                `${finalManifest.run_id}.json`,
              ),
              { force: true },
            );
          }
          throw error;
        }
        await this.ensureWorkingDirectory(input.runId);
        return {
          schemaVersion: "startup_opportunity.create_run_result.v1",
          status: "created",
          runId: input.runId,
          manifest: finalManifest,
          checkpointRef: checkpoint.checkpointRef,
          workingDirectory: this.workingDirectory(input.runId),
          scopeProposalRef: proposalRef,
          scopeProposalHash: proposalHash,
          scopeProposal: researchScopeFromDocument(proposalRecord.scope as Record<string, unknown>),
        };
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    });
  }

  async load(
    runId: string,
    options: { readonly observe?: OperationObserver | undefined } = {},
  ): Promise<LoadRunResult> {
    const trace = operationTrace("run_recovery", options.observe);
    trace.start("operation");
    try {
      trace.start("execution_resolution");
      const resolution = await this.resolveExecution(runId);
      if (resolution.disposition === "indeterminate") {
        throw new StoreError(
          "run.continuation_indeterminate",
          "Run continuation lineage cannot be resolved safely",
          { runId, issues: resolution.issues },
        );
      }
      if (resolution.currentLeafRunId !== runId) {
        throw new StoreError("run.not_current_leaf", "Run has an authoritative continuation leaf", {
          runId,
          currentLeafRunId: resolution.currentLeafRunId,
        });
      }
      trace.complete("execution_resolution", {
        continuation_depth: resolution.continuationChain.length,
      });
      trace.start("recovery_validation");
      const runRoot = await openRunDirectory(this.runsRoot, runId);
      const result = await withRunLock(runRoot, () => this.recoverLocked(runRoot, runId));
      const recoveredArtifacts =
        result.recoveredArtifactPaths.length +
        result.reportRecovery.recoveredFormalArtifactPaths.length +
        result.reportRecovery.recoveredMaterializedPaths.length;
      trace.complete("recovery_validation", {
        recovered_artifacts: recoveredArtifacts,
        repaired_logs: result.logRepairs.length,
        orphan_active_units: result.orphanActiveUnits.length,
      });
      trace.complete("operation", {
        recovered_artifacts: recoveredArtifacts,
        repaired_logs: result.logRepairs.length,
      });
      return result;
    } catch (error) {
      trace.fail("operation", error instanceof StoreError ? error.code : "recovery.unexpected");
      throw error;
    }
  }

  private async continuationChildren(parentRunId: string): Promise<{
    readonly children: readonly RunManifest[];
    readonly recognizedRunIds: readonly string[];
    readonly issues: readonly string[];
  }> {
    const directory = path.join(this.runsRoot, ".continuations", parentRunId);
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { children: [], recognizedRunIds: [], issues: [] };
      }
      return { children: [], recognizedRunIds: [], issues: ["continuation.index_unreadable"] };
    }
    const children: RunManifest[] = [];
    const recognizedRunIds: string[] = [];
    const issues: string[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRunId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
      try {
        validateRunId(childRunId);
        recognizedRunIds.push(childRunId);
      } catch {
        issues.push("continuation.index_filename_invalid");
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        issues.push(`continuation.index_entry_invalid:${childRunId}`);
        continue;
      }
      try {
        const value = JSON.parse(
          await readFile(path.join(directory, entry.name), "utf8"),
        ) as unknown;
        const validation = this.validator.validateDocument(value);
        if (
          !validation.valid ||
          !isRecord(value) ||
          value.schema_version !== "startup_opportunity.continuation_lineage_entry.v1" ||
          value.parent_run_id !== parentRunId ||
          value.child_run_id !== childRunId ||
          (value.state !== "pending" && value.state !== "committed")
        ) {
          issues.push(`continuation.index_entry_invalid:${childRunId}`);
          continue;
        }
        if (value.state === "pending") {
          issues.push(`continuation.index_pending:${childRunId}`);
          continue;
        }
        const childRoot = await openRunDirectoryReadOnly(this.runsRoot, childRunId);
        const child = await this.readManifest(childRoot);
        if (
          child.parent_run_id !== parentRunId ||
          canonicalContentHash(continuationIdentity(child)) !== value.child_identity_hash
        ) {
          issues.push(`continuation.child_identity_mismatch:${childRunId}`);
          continue;
        }
        children.push(child);
      } catch (error) {
        issues.push(
          `${error instanceof StoreError ? error.code : "continuation.child_unreadable"}:${childRunId}`,
        );
      }
    }
    return {
      children: children.sort((left, right) => left.run_id.localeCompare(right.run_id)),
      recognizedRunIds: [...new Set(recognizedRunIds)].sort(),
      issues: [...new Set(issues)].sort(),
    };
  }

  async resolveExecution(runId: string): Promise<RunExecutionResolution> {
    validateRunId(runId);
    let cursor = await this.readManifest(await openRunDirectoryReadOnly(this.runsRoot, runId));
    const chain = [runId];
    const seen = new Set(chain);
    let directContinuationRunIds: readonly string[] = [];
    while (true) {
      const indexed = await this.continuationChildren(cursor.run_id);
      if (chain.length === 1) {
        directContinuationRunIds = indexed.recognizedRunIds;
      }
      const issues = [...indexed.issues];
      if (indexed.children.length > 1) {
        issues.push(`continuation.multiple_children:${cursor.run_id}`);
      }
      if (issues.length > 0 || indexed.children.length > 1) {
        return {
          schemaVersion: "startup_opportunity.run_execution_resolution.v1",
          requestedRunId: runId,
          disposition: "indeterminate",
          currentLeafRunId: null,
          continuationChain: chain,
          directContinuationRunIds,
          issues: [...new Set(issues)].sort(),
        };
      }
      const child = indexed.children[0];
      if (child === undefined) {
        return {
          schemaVersion: "startup_opportunity.run_execution_resolution.v1",
          requestedRunId: runId,
          disposition:
            chain.length > 1
              ? "continued"
              : TERMINAL_RUN_STATUSES.has(cursor.status)
                ? "terminal"
                : "current",
          currentLeafRunId: cursor.run_id,
          continuationChain: chain,
          directContinuationRunIds,
          issues: [],
        };
      }
      if (seen.has(child.run_id)) {
        return {
          schemaVersion: "startup_opportunity.run_execution_resolution.v1",
          requestedRunId: runId,
          disposition: "indeterminate",
          currentLeafRunId: null,
          continuationChain: chain,
          directContinuationRunIds,
          issues: [`continuation.cycle:${child.run_id}`],
        };
      }
      seen.add(child.run_id);
      chain.push(child.run_id);
      cursor = child;
    }
  }

  async status(runId: string): Promise<StatusRunResult> {
    const runRoot = await openRunDirectoryReadOnly(this.runsRoot, runId);
    const manifest = await this.readManifest(runRoot);
    await this.assertScopeBindingLocked(runRoot, manifest);
    const resolution = await this.resolveExecution(runId);
    const terminalReportStatus = TERMINAL_RUN_STATUSES.has(manifest.status)
      ? await this.terminalReportStatus(runId, runRoot, manifest)
      : { disposition: "not_required" as const, issues: [] };
    const formal = await this.artifacts.listFormalDocuments(runRoot);
    const events = await this.logs.listValidatedRecords(runRoot, runId, "events.jsonl");
    const effective = formal.map((entry) => {
      const envelope = entry.document as FormalArtifactEnvelope;
      return {
        path: entry.path,
        createdAt:
          typeof envelope.created_at === "string" ? envelope.created_at : manifest.updated_at,
        artifactType: typeof envelope.artifact_type === "string" ? envelope.artifact_type : "",
        document: isRecord(envelope.document) ? envelope.document : entry.document,
      };
    });
    const readinessByStage = new Map<string, string>();
    for (const entry of effective) {
      if (
        entry.artifactType === "startup_opportunity.discovery_stage_readiness.v1" &&
        typeof entry.document.stage_id === "string"
      ) {
        readinessByStage.set(entry.document.stage_id, entry.createdAt);
      }
      if (
        entry.artifactType === "startup_opportunity.assessment_stage_gate.v1" &&
        typeof entry.document.stage_id === "string"
      ) {
        readinessByStage.set(entry.document.stage_id, entry.createdAt);
      }
    }
    const stageTimings = effective
      .filter((entry) =>
        [
          "startup_opportunity.dispatch_batch.discovery.current",
          "startup_opportunity.dispatch_batch.assessment.current",
        ].includes(entry.artifactType),
      )
      .flatMap((entry) => {
        const stageId = entry.document.stage_id;
        const startedAt = entry.document.dispatch_requested_at ?? entry.document.requested_at;
        if (typeof stageId !== "string" || typeof startedAt !== "string") return [];
        const endedAt = readinessByStage.get(stageId) ?? null;
        return [
          {
            stageId,
            startedAt,
            endedAt,
            durationMs:
              endedAt === null ? null : Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
          },
        ];
      })
      .sort((left, right) => left.stageId.localeCompare(right.stageId));
    const lifecycle = new Map<string, (typeof effective)[number][]>();
    for (const entry of effective.filter(
      (candidate) => candidate.artifactType === "startup_opportunity.lane_lifecycle.v1",
    )) {
      if (typeof entry.document.unit_id !== "string") continue;
      lifecycle.set(entry.document.unit_id, [
        ...(lifecycle.get(entry.document.unit_id) ?? []),
        entry,
      ]);
    }
    const failureClassifications: Record<string, number> = {};
    const laneTimings = [...lifecycle.entries()]
      .map(([unitId, history]) => {
        const attempts = new Map<string, (typeof history)[number]>();
        for (const candidate of history) {
          const attemptId = String(candidate.document.execution_attempt_id);
          const previous = attempts.get(attemptId);
          if (
            previous === undefined ||
            Number(candidate.document.revision) > Number(previous.document.revision)
          ) {
            attempts.set(attemptId, candidate);
          }
        }
        const completedAttempts = [...attempts.values()].sort((left, right) => {
          const ordinal = Number(left.document.attempt) - Number(right.document.attempt);
          return ordinal === 0 ? left.createdAt.localeCompare(right.createdAt) : ordinal;
        });
        for (const attempt of completedAttempts) {
          const failure = isRecord(attempt.document.failure) ? attempt.document.failure : null;
          if (typeof failure?.kind === "string") {
            failureClassifications[failure.kind] = (failureClassifications[failure.kind] ?? 0) + 1;
          }
        }
        const entry = completedAttempts.at(-1) ?? history[history.length - 1];
        if (entry === undefined) {
          throw new StoreError("status.lifecycle_missing", "lane lifecycle history is empty", {
            unitId,
          });
        }
        const timestamps = isRecord(entry.document.timestamps) ? entry.document.timestamps : {};
        const startedAt =
          completedAttempts
            .map((attempt) => {
              const values = isRecord(attempt.document.timestamps)
                ? attempt.document.timestamps
                : {};
              return String(values.dispatch_requested_at ?? attempt.createdAt);
            })
            .sort()[0] ?? String(timestamps.dispatch_requested_at ?? entry.createdAt);
        const endedAt =
          [
            timestamps.published_at,
            timestamps.formalization_validated_at,
            timestamps.handoff_ready_at,
            timestamps.evidence_recorded_at,
            timestamps.agent_started_at,
          ].find((value): value is string => typeof value === "string") ?? null;
        return {
          unitId,
          attempt: Number(entry.document.attempt),
          executionAttemptId: String(entry.document.execution_attempt_id),
          attemptCount: attempts.size,
          retryCount: Math.max(0, attempts.size - 1),
          state: String(entry.document.state),
          startedAt,
          endedAt,
          durationMs:
            endedAt === null ? null : Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
        };
      })
      .sort((left, right) => left.unitId.localeCompare(right.unitId));
    const operationHistory = new Map<string, Record<string, unknown>[]>();
    for (const event of events) {
      if (event.event_type !== "runtime_operation_observed") continue;
      const observation = isRecord(event.operation_observation)
        ? event.operation_observation
        : null;
      if (
        observation?.operation !== "runtime_compile_publish" ||
        typeof observation.operation_id !== "string"
      ) {
        continue;
      }
      operationHistory.set(observation.operation_id, [
        ...(operationHistory.get(observation.operation_id) ?? []),
        observation,
      ]);
      if (typeof observation.failure_classification === "string") {
        failureClassifications[observation.failure_classification] =
          (failureClassifications[observation.failure_classification] ?? 0) + 1;
      }
    }
    const operationTimings = [...operationHistory.entries()]
      .map(([operationId, attempts]) => {
        const ordered = attempts.sort(
          (left, right) => Number(left.attempt) - Number(right.attempt),
        );
        const first = ordered[0];
        const latest = ordered.at(-1);
        if (first === undefined || latest === undefined) {
          throw new StoreError(
            "status.operation_observation_missing",
            "runtime operation observation history is empty",
            { operationId },
          );
        }
        return {
          operationId,
          operation: "runtime_compile_publish" as const,
          attemptCount: ordered.length,
          retryCount: Math.max(0, ordered.length - 1),
          latestOutcome: String(latest.outcome) as "published" | "failed",
          startedAt: String(first.started_at),
          endedAt: String(latest.completed_at),
          durationMs: ordered.reduce(
            (total, attempt) => total + Math.max(0, Number(attempt.duration_ms)),
            0,
          ),
        };
      })
      .sort((left, right) => left.operationId.localeCompare(right.operationId));
    const latestGap =
      manifest.latest_gap_snapshot_ref === null
        ? null
        : effective.find((entry) => entry.path === manifest.latest_gap_snapshot_ref)?.document;
    const blockingGapIds =
      latestGap !== null && Array.isArray(latestGap?.gaps)
        ? latestGap.gaps
            .filter(
              (gap): gap is Record<string, unknown> => isRecord(gap) && gap.severity === "blocking",
            )
            .map((gap) => String(gap.gap_id))
        : [];
    const blockingReasons = [
      ...(manifest.status === "needs_clarification"
        ? [`scope_revision_requires_plan_reconciliation:${manifest.scope_revision}`]
        : []),
      ...blockingGapIds.map((id) => `blocking_gap:${id}`),
      ...manifest.pending_adaptation_refs.map((ref) => `pending_adaptation:${ref}`),
      ...manifest.failed_units.map((unitId) => `failed_unit:${unitId}`),
      ...resolution.issues,
      ...terminalReportStatus.issues,
    ].sort();
    const evidenceCount = (await this.evidence.listRecords(runId)).length;
    return {
      schemaVersion: "startup_opportunity.status_run_result.v1",
      runId,
      manifest,
      continuationRunIds: resolution.directContinuationRunIds,
      derivedExecutionDisposition: resolution.disposition,
      currentLeafRunId: resolution.currentLeafRunId,
      continuationChain: resolution.continuationChain,
      executionResolutionIssues: resolution.issues,
      terminalReportDisposition: terminalReportStatus.disposition,
      terminalReportIssues: terminalReportStatus.issues,
      workingDirectory: this.workingDirectory(runId),
      resumeContext: {
        runId,
        mode: manifest.mode,
        status: manifest.status,
        currentPhase: manifest.current_phase,
        currentPlanRef: manifest.current_plan_ref,
        checkpointRef: manifest.checkpoint_ref,
        activeUnitIds: manifest.active_units,
        blockingReasons,
        doctorRequired: false,
      },
      observability: {
        stageTimings,
        laneTimings,
        operationTimings,
        validationRetryCount: failureClassifications.validation_failed ?? 0,
        publishRetryCount: failureClassifications.publication_failed ?? 0,
        failureClassifications: Object.fromEntries(
          Object.entries(failureClassifications).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
        artifactCount: manifest.artifact_refs.length,
        evidenceCount,
        blockingReasons,
      },
    };
  }

  private async assertCurrentLeaf(runId: string): Promise<void> {
    const resolution = await this.resolveExecution(runId);
    if (resolution.disposition === "indeterminate") {
      throw new StoreError(
        "run.continuation_indeterminate",
        "Run continuation lineage cannot be resolved safely",
        { runId, issues: resolution.issues },
      );
    }
    if (resolution.currentLeafRunId !== runId) {
      throw new StoreError("run.not_current_leaf", "Run has an authoritative continuation leaf", {
        runId,
        currentLeafRunId: resolution.currentLeafRunId,
      });
    }
  }

  private async terminalReportStatus(
    runId: string,
    runRoot: string,
    manifest: RunManifest,
  ): Promise<{
    readonly disposition: StatusRunResult["terminalReportDisposition"];
    readonly issues: readonly string[];
  }> {
    const requiredTypes = [
      "startup_opportunity.terminal_report_source.v1",
      "startup_opportunity.decision_brief.terminal.current",
      "startup_opportunity.terminal_report_view.v1",
      "startup_opportunity.report_consistency_evaluation.terminal.current",
    ] as const;
    const formal = await this.artifacts.listFormalDocuments(runRoot);
    const reporting = requiredTypes.map((artifactType) =>
      formal.filter(
        (entry) =>
          isRecord(entry.document) &&
          entry.document.artifact_type === artifactType &&
          isRecord(entry.document.document),
      ),
    );
    if (reporting.some((entries) => entries.length === 0)) {
      return { disposition: "missing", issues: ["terminal_report.artifact_missing"] };
    }
    if (reporting.some((entries) => entries.length !== 1)) {
      return { disposition: "invalid", issues: ["terminal_report.artifact_cardinality"] };
    }
    const entries = reporting.flat();
    try {
      const terminalDocuments = entries.map((entry) => {
        const envelope = entry.document as FormalArtifactEnvelope;
        return {
          path: entry.path,
          schemaVersion: envelope.artifact_type,
          document: envelope.document,
          envelope,
        };
      });
      for (const document of terminalDocuments) {
        await this.artifacts.validateStoredEnvelope(
          runRoot,
          runId,
          document.envelope as FormalArtifactEnvelope,
        );
      }
      const terminalIssues = validateTerminalReportingContract(
        [
          {
            path: "manifest.json",
            schemaVersion: manifest.schema_version,
            document: manifest,
            envelope: null,
          },
          ...formal
            .filter(
              (entry) => !entries.some((reportingEntry) => reportingEntry.path === entry.path),
            )
            .flatMap((entry) => {
              const envelope = entry.document as FormalArtifactEnvelope;
              return isRecord(envelope.document) && typeof envelope.artifact_type === "string"
                ? [
                    {
                      path: entry.path,
                      schemaVersion: envelope.artifact_type,
                      document: envelope.document,
                      envelope,
                    },
                  ]
                : [];
            }),
          ...terminalDocuments,
        ],
        this.validator.publicationPolicy.document
          .commercial_research_contract as unknown as import("../validators/commercial-research-validator.js").CommercialResearchPolicy,
        new Map([
          ...(await this.evidence.listRecordsLocked(runRoot, runId)).map(
            (record) =>
              [
                `evidence/manifest.jsonl#${record.evidence_id}`,
                record as Record<string, unknown>,
              ] as const,
          ),
          ...(await this.logs.listValidatedRecords(runRoot, runId, "decisions.jsonl")).map(
            (record) =>
              [
                `decisions.jsonl#${String(record.decision_id)}`,
                record as Record<string, unknown>,
              ] as const,
          ),
        ]),
      );
      const searchClosureWarningAllowed =
        terminalIssues.length > 0 &&
        terminalIssues.every(
          (issue) => issue.code === "terminal_reporting.search_closure_incomplete",
        ) &&
        (await this.runtimeFailureMayOmitSearchClosures(
          runId,
          runRoot,
          manifest,
          formal,
          terminalDocuments,
        ));
      if (terminalIssues.length > 0 && !searchClosureWarningAllowed) {
        return {
          disposition: "invalid",
          issues: terminalIssues.map((issue) => issue.code),
        };
      }
      const effective = entries.map((entry) => entry.document.document as Record<string, unknown>);
      const source = effective.find(
        (document) => document.schema_version === "startup_opportunity.terminal_report_source.v1",
      );
      const brief = effective.find(
        (document) =>
          document.schema_version === "startup_opportunity.decision_brief.terminal.current",
      );
      const view = effective.find(
        (document) => document.schema_version === "startup_opportunity.terminal_report_view.v1",
      );
      if (
        source === undefined ||
        typeof brief?.markdown !== "string" ||
        typeof view?.markdown !== "string"
      ) {
        return { disposition: "invalid", issues: ["terminal_report.document_shape"] };
      }
      const expected = new Map([
        ["report.json", `${canonicalJson(source)}\n`],
        ["decision-brief.md", brief.markdown],
        ["report.md", view.markdown],
        ["audit-appendix.md", view.audit_appendix_markdown],
      ]);
      for (const [relativePath, bytes] of expected) {
        if ((await readFile(await resolveRunPath(runRoot, relativePath), "utf8")) !== bytes) {
          return {
            disposition: "invalid",
            issues: [`terminal_report.materialized_drift:${relativePath}`],
          };
        }
      }
      return { disposition: "ready", issues: [] };
    } catch (error) {
      return isNodeError(error, "ENOENT")
        ? { disposition: "missing", issues: ["terminal_report.materialized_missing"] }
        : {
            disposition: "invalid",
            issues: [
              error instanceof StoreError ? error.code : "terminal_report.status_validation_failed",
            ],
          };
    }
  }

  private async runtimeFailureMayOmitSearchClosures(
    runId: string,
    runRoot: string,
    manifest: RunManifest,
    formal: readonly DocumentBundleEntry[],
    terminalDocuments: readonly {
      readonly path: string;
      readonly schemaVersion: string;
      readonly document: Record<string, unknown>;
      readonly envelope: FormalArtifactEnvelope;
    }[],
  ): Promise<boolean> {
    if (
      manifest.status !== "failed" ||
      manifest.current_plan_ref === null ||
      manifest.latest_gap_snapshot_ref === null
    ) {
      return false;
    }
    const source = terminalDocuments.find(
      (entry) => entry.schemaVersion === "startup_opportunity.terminal_report_source.v1",
    );
    const runtimeHealth = isRecord(source?.document.runtime_health)
      ? source.document.runtime_health
      : {};
    const execution = isRecord(source?.document.execution) ? source.document.execution : {};
    const incompleteStages = records(execution.incomplete_stages);
    const sourceAuditRefs = new Set(strings(source?.document.audit_refs));
    const sourceInputRefs = new Set(source?.envelope.input_refs ?? []);
    if (
      source === undefined ||
      !["blocked", "failed"].includes(String(source.document.terminal_outcome)) ||
      runtimeHealth.status !== "blocked" ||
      records(runtimeHealth.issues).length === 0 ||
      !["partial", "not_started"].includes(String(execution.completeness)) ||
      !incompleteStages.some(
        (stage) =>
          stage.cause === "runtime_blocked" &&
          strings(stage.related_refs).includes(manifest.latest_gap_snapshot_ref as string),
      ) ||
      !sourceAuditRefs.has(manifest.latest_gap_snapshot_ref) ||
      !sourceInputRefs.has(manifest.latest_gap_snapshot_ref)
    ) {
      return false;
    }

    const currentArtifactRefs = new Set(manifest.artifact_refs);
    const currentEnvelopes = new Map<string, FormalArtifactEnvelope>();
    for (const entry of formal) {
      if (!currentArtifactRefs.has(entry.path) || !isRecord(entry.document)) continue;
      const envelope = entry.document as FormalArtifactEnvelope;
      if (
        envelope.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
        envelope.artifact_path === entry.path &&
        isRecord(envelope.document)
      ) {
        currentEnvelopes.set(entry.path, envelope);
      }
    }
    const gapEnvelope = currentEnvelopes.get(manifest.latest_gap_snapshot_ref);
    if (
      gapEnvelope === undefined ||
      gapEnvelope.artifact_type !== "startup_opportunity.gap_snapshot.discovery.plan.current" ||
      gapEnvelope.document.based_on_plan_ref !== manifest.current_plan_ref ||
      !strings(gapEnvelope.document.stop_signals).includes("runtime_blocked")
    ) {
      return false;
    }
    const runtimeBlockingGapIds = new Set(
      records(gapEnvelope.document.gaps)
        .filter((gap) => gap.gap_type === "runtime_blocked" && gap.severity === "blocking")
        .map((gap) => String(gap.gap_id)),
    );
    if (runtimeBlockingGapIds.size === 0) return false;

    for (const decisionRef of manifest.applied_adaptation_refs) {
      const decisionEnvelope = currentEnvelopes.get(decisionRef);
      if (
        decisionEnvelope === undefined ||
        ![
          "startup_opportunity.adaptation_decision.discovery.current",
          "startup_opportunity.adaptation_decision.assessment.current",
        ].includes(decisionEnvelope.artifact_type) ||
        decisionEnvelope.document.action !== "record_runtime_failure" ||
        decisionEnvelope.document.based_on_plan_ref !== manifest.current_plan_ref ||
        !sourceAuditRefs.has(decisionRef) ||
        !sourceInputRefs.has(decisionRef)
      ) {
        continue;
      }
      const closesCurrentRuntimeGap = strings(decisionEnvelope.document.trigger_gap_refs).some(
        (ref) => {
          const prefix = `${manifest.latest_gap_snapshot_ref}#`;
          return ref.startsWith(prefix) && runtimeBlockingGapIds.has(ref.slice(prefix.length));
        },
      );
      if (!closesCurrentRuntimeGap) continue;
      await this.artifacts.validateStoredEnvelope(runRoot, runId, gapEnvelope);
      await this.artifacts.validateStoredEnvelope(runRoot, runId, decisionEnvelope);
      return true;
    }
    return false;
  }

  async buildValidationContext(
    runId: string,
    input: DocumentBundle,
    options: {
      readonly includeAllFormalArtifacts?: boolean;
      readonly topLevelFormalRefs?: readonly string[];
      readonly prospectiveArtifactPaths?: readonly string[];
      readonly prospectiveManifest?: RunManifest;
      readonly exactRecordRefs?: readonly string[];
      readonly recoverPlanOperations?: boolean;
    } = {},
  ): Promise<BuildValidationContextResult> {
    validateRunId(runId);
    await this.assertCurrentLeaf(runId);
    const inputValidation = this.validator.validateDocument(input);
    if (!inputValidation.valid) {
      throw new StoreError(
        "validation_context.bundle_invalid",
        "validation context input is not a schema-valid Document Bundle",
        { errors: inputValidation.errors },
      );
    }
    const runRoot = await openRunDirectory(this.runsRoot, runId);
    return withRunLock(runRoot, () =>
      this.buildValidationContextLocked(
        runRoot,
        runId,
        input,
        options.includeAllFormalArtifacts === true,
        new Set(options.prospectiveArtifactPaths ?? []),
        options.prospectiveManifest,
        new Set(options.exactRecordRefs ?? []),
        new Set(options.topLevelFormalRefs ?? []),
        options.recoverPlanOperations !== false,
      ),
    );
  }

  async buildValidationContextLocked(
    runRoot: string,
    runId: string,
    input: DocumentBundle,
    includeAllFormalArtifacts = false,
    prospectiveArtifactPaths: ReadonlySet<string> = new Set(),
    prospectiveManifest?: RunManifest,
    requestedExactRecordRefs: Set<string> = new Set(),
    requestedTopLevelFormalRefs: ReadonlySet<string> = new Set(),
    recoverPlanOperations = true,
  ): Promise<BuildValidationContextResult> {
    const storedManifest = await this.readManifest(runRoot);
    await this.assertScopeBindingLocked(runRoot, storedManifest);
    const manifest = prospectiveManifest ?? storedManifest;
    if (prospectiveManifest !== undefined) {
      const validation = this.validator.validateDocument(prospectiveManifest, "manifest.json");
      if (
        !validation.valid ||
        prospectiveManifest.run_id !== storedManifest.run_id ||
        prospectiveManifest.scope_revision !== storedManifest.scope_revision ||
        prospectiveManifest.scope_confirmation_ref !== storedManifest.scope_confirmation_ref ||
        prospectiveManifest.scope_confirmation_hash !== storedManifest.scope_confirmation_hash
      ) {
        throw new StoreError(
          "validation_context.prospective_manifest_invalid",
          "prospective Manifest must preserve the exact current Run and Scope authority",
          { errors: validation.errors },
        );
      }
    }
    const stored = new Map(
      (await this.artifacts.listFormalDocuments(runRoot)).map((entry) => [entry.path, entry]),
    );
    const selected = new Map<string, DocumentBundleEntry>();
    const reservedLogs = new Set(["events.jsonl", "decisions.jsonl", "evidence/manifest.jsonl"]);
    for (const entry of input.documents) {
      if (reservedLogs.has(entry.path)) {
        continue;
      }
      if (selected.has(entry.path)) {
        throw new StoreError(
          "validation_context.duplicate_path",
          "validation context input contains a duplicate document path",
          { path: entry.path },
        );
      }
      selected.set(entry.path, entry);
    }

    const effective = (document: Record<string, unknown>): Record<string, unknown> =>
      isCurrentEnvelopeSchema(document.schema_version) && isRecord(document.document)
        ? document.document
        : document;
    const addAuthority = async (entry: DocumentBundleEntry): Promise<void> => {
      const supplied = selected.get(entry.path);
      const authorityDocument = effective(entry.document);
      if (
        supplied !== undefined &&
        canonicalJson(effective(supplied.document)) !== canonicalJson(authorityDocument) &&
        !prospectiveArtifactPaths.has(entry.path)
      ) {
        throw new StoreError(
          "validation_context.authority_conflict",
          "caller-supplied document differs from validated Run authority",
          { path: entry.path },
        );
      }
      if (supplied !== undefined && prospectiveArtifactPaths.has(entry.path)) {
        return;
      }
      if (
        isCurrentEnvelopeSchema(entry.document.schema_version) &&
        isRecord(entry.document.document)
      ) {
        await this.artifacts.validateStoredEnvelope(
          runRoot,
          runId,
          entry.document as FormalArtifactEnvelope,
        );
      }
      const validation = this.validator.validateDocument(authorityDocument, entry.path);
      if (!validation.valid) {
        throw new StoreError(
          "validation_context.stored_document_invalid",
          "stored validation-context document is not schema-valid",
          { path: entry.path, errors: validation.errors },
        );
      }
      selected.set(entry.path, {
        path: entry.path,
        document: isCurrentEnvelopeSchema(entry.document.schema_version)
          ? entry.document
          : authorityDocument,
      });
    };

    await addAuthority({ path: "manifest.json", document: manifest });
    for (const ref of [...requestedTopLevelFormalRefs].sort()) {
      const parsed = validateArtifactRef(ref);
      if (parsed.path === "manifest.json") continue;
      if (parsed.path.endsWith(".jsonl")) {
        if (parsed.fragment === null) {
          throw new StoreError(
            "validation_context.exact_record_ref_invalid",
            "top-level JSONL refs must identify one exact record",
            { ref },
          );
        }
        requestedExactRecordRefs.add(ref);
        continue;
      }
      const authority = stored.get(parsed.path);
      if (authority === undefined) {
        throw new StoreError(
          "validation_context.top_level_ref_missing",
          "an explicitly selected top-level formal ref is absent from the current Run",
          { ref },
        );
      }
      await addAuthority(authority);
    }
    const terminalReportRequested = [...selected.values()].some(
      (entry) =>
        effective(entry.document).schema_version ===
        "startup_opportunity.terminal_report_source.v1",
    );
    if (terminalReportRequested || includeAllFormalArtifacts) {
      const authorities = [...stored.values()]
        .filter((authority) =>
          includeAllFormalArtifacts ? manifest.artifact_refs.includes(authority.path) : true,
        )
        .sort((left, right) => left.path.localeCompare(right.path));
      for (const authority of authorities) {
        await addAuthority(authority);
      }
    }
    const exactRecords = new Map<string, Record<string, unknown>>();
    for (const ref of [...requestedExactRecordRefs].sort()) {
      const parsed = validateArtifactRef(ref);
      if (parsed.fragment === null) {
        throw new StoreError(
          "validation_context.exact_record_ref_invalid",
          "requested exact record refs must identify one JSONL record",
          { ref },
        );
      }
      if (parsed.path === "events.jsonl" || parsed.path === "decisions.jsonl") {
        exactRecords.set(ref, await this.logs.readExactRecord(runRoot, runId, ref, parsed.path));
      } else if (parsed.path === "evidence/manifest.jsonl") {
        exactRecords.set(
          ref,
          (await this.evidence.readExactRecordLocked(runRoot, runId, ref)) as Record<
            string,
            unknown
          >,
        );
      } else {
        throw new StoreError(
          "validation_context.exact_record_ref_invalid",
          "requested exact record refs must target the current Run JSONL stores",
          { ref },
        );
      }
    }
    const processed = new Set<string>();
    while (true) {
      const next = [...selected.values()]
        .sort((left, right) => left.path.localeCompare(right.path))
        .find((entry) => !processed.has(entry.path));
      if (next === undefined) {
        break;
      }
      processed.add(next.path);
      const nextDocument = effective(next.document);
      if (DISCOVERY_MAP_SCHEMA_VERSIONS.has(String(nextDocument.schema_version))) {
        for (const rootPath of DISCOVERY_MAP_AGGREGATE_ROOTS) {
          const authority = stored.get(rootPath);
          if (authority !== undefined) {
            await addAuthority(authority);
          }
        }
      }
      for (const ref of artifactRefsForDocument(next)) {
        const parsed = validateArtifactRef(ref);
        if (parsed.path === "events.jsonl" || parsed.path === "decisions.jsonl") {
          exactRecords.set(ref, await this.logs.readExactRecord(runRoot, runId, ref, parsed.path));
          continue;
        }
        if (parsed.path === "evidence/manifest.jsonl") {
          exactRecords.set(
            ref,
            (await this.evidence.readExactRecordLocked(runRoot, runId, ref)) as Record<
              string,
              unknown
            >,
          );
          continue;
        }
        if (parsed.path === "manifest.json") {
          continue;
        }
        const authority = stored.get(parsed.path);
        if (authority !== undefined) {
          await addAuthority(authority);
        }
      }
    }

    const planOperationRecovery = await recoverPlanRevisionOperationsLocked(
      runRoot,
      runId,
      this.validator,
      this.artifacts,
      this.logs,
      recoverPlanOperations,
    );
    for (const decision of await this.logs.listValidatedRecords(
      runRoot,
      runId,
      "decisions.jsonl",
    )) {
      if (
        decision.decision_type === "prior_input_admitted" ||
        decision.decision_type === "prior_input_consumed" ||
        decision.decision_type === "research_handoff_consumed" ||
        decision.decision_type === "subject_reformed"
      ) {
        exactRecords.set(`decisions.jsonl#${String(decision.decision_id)}`, decision);
      }
    }
    if (terminalReportRequested || includeAllFormalArtifacts) {
      for (const record of await this.evidence.listRecordsLocked(runRoot, runId)) {
        exactRecords.set(
          `evidence/manifest.jsonl#${record.evidence_id}`,
          record as Record<string, unknown>,
        );
      }
    }

    return {
      schemaVersion: "startup_opportunity.validation_context.v1",
      bundle: {
        schema_version: input.schema_version,
        documents: [...selected.values()].sort((left, right) =>
          left.path.localeCompare(right.path),
        ),
        ...(input.schema_version === DOCUMENT_BUNDLE_SCHEMA_VERSION ? { exact_records: [] } : {}),
      },
      referenceContext: {
        exactJsonlRecords: new Map(
          [...exactRecords.entries()].sort(([left], [right]) => left.localeCompare(right)),
        ),
        historicalDiscoveryPlanBindings: planOperationRecovery.historicalDiscoveryPlanBindings,
        artifactPublicationRecords: await this.artifacts.publicationRecordsLocked(runRoot, runId),
      },
      planOperationRecovery,
    };
  }

  async publishArtifact(input: PublishArtifactInput): Promise<PublishArtifactResult> {
    await this.assertCurrentLeaf(input.runId);
    this.artifacts.validateEnvelopeVersionBoundary(input.envelope.schema_version);
    if (input.envelope.artifact_type === "startup_opportunity.checkpoint.v1") {
      throw new StoreError(
        "checkpoint.dedicated_entry_required",
        "checkpoints must use the monotonic checkpoint operation",
      );
    }
    if (input.envelope.artifact_type === "startup_opportunity.research_handoff.current") {
      throw new StoreError(
        "research_handoff.dedicated_entry_required",
        "research handoffs must use createResearchHandoff() so the Store captures exact authorized source bytes",
      );
    }
    if (input.envelope.artifact_type === "startup_opportunity.terminal_report_source.v1") {
      throw new StoreError(
        "report.terminal_dedicated_entry_required",
        "terminal report sources must use apply-plan-revision atomic closeout",
      );
    }
    if (
      input.envelope.artifact_type === "startup_opportunity.dispatch_launch_registration.v1" ||
      (input.envelope.artifact_type === "startup_opportunity.lane_lifecycle.v1" &&
        input.envelope.document.revision === 1 &&
        typeof input.envelope.document.launch_registration_ref === "string")
    ) {
      throw new StoreError(
        "artifact.dispatch_launch_registration_entry_required",
        "registered lifecycle roots must use the dedicated atomic Dispatch launch entry",
      );
    }
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      const manifest = await this.readManifest(runRoot);
      if (
        input.expectedManifestContentHash !== undefined &&
        canonicalContentHash(manifest) !== input.expectedManifestContentHash &&
        !manifest.artifact_refs.includes(input.envelope.artifact_path) &&
        !manifest.ignored_late_artifact_refs.includes(input.envelope.artifact_path)
      ) {
        throw new StoreError(
          "artifact.manifest_stale",
          "artifact publication no longer binds the exact planned Manifest",
          {
            expected: input.expectedManifestContentHash,
            actual: canonicalContentHash(manifest),
          },
        );
      }
      if (
        [
          "startup_opportunity.dispatch_batch.discovery.current",
          "startup_opportunity.dispatch_batch.assessment.current",
          "startup_opportunity.research_task.discovery_candidate.current",
          "startup_opportunity.research_task.discovery_evaluation.current",
        ].includes(input.envelope.artifact_type) &&
        !manifest.artifact_refs.includes(input.envelope.artifact_path)
      ) {
        throw new StoreError(
          "artifact.wave_bundle_required",
          "a new dispatch batch or canonical task must be published through the whole-wave bundle boundary",
          { artifactPath: input.envelope.artifact_path },
        );
      }
      await this.assertScopeBindingLocked(runRoot, manifest);
      await this.assertTransitionReadyLocked(runRoot, manifest, [input.envelope]);
      await this.assertProspectiveScopeFormationLocked(runRoot, manifest, [input.envelope]);
      await this.assertProspectivePlanningPublicationLocked(runRoot, manifest, [input.envelope]);
      this.assertAdaptationArtifactMode(manifest, input.envelope);
      const taskPublicationMode = await this.researchTaskPublicationMode(
        runRoot,
        manifest,
        input.envelope,
      );
      const plannedArtifact = await this.classifyPlannedArtifact(
        runRoot,
        manifest,
        input.envelope.artifact_path,
      );
      const ignoredLate =
        plannedArtifact.ignoredLate ||
        (input.envelope.artifact_type === "startup_opportunity.enrichment_branch_result.v1" &&
          ["ignored_late", "superseded"].includes(String(input.envelope.document.status)));
      if (
        plannedArtifact.expectedArtifactType !== null &&
        plannedArtifact.expectedArtifactType !== input.envelope.artifact_type
      ) {
        throw new StoreError(
          "artifact.unit_schema_mismatch",
          "unit output must use its exact required_artifact_schema",
          {
            artifactPath: input.envelope.artifact_path,
            expected: plannedArtifact.expectedArtifactType,
            actual: input.envelope.artifact_type,
          },
        );
      }
      this.assertBranchPublicationTransition(manifest, input.envelope, ignoredLate);
      this.assertDiscoveryLanePublicationTransition(manifest, input.envelope, ignoredLate);
      this.assertEnrichmentBranchPublicationTransition(manifest, input.envelope, ignoredLate);
      this.assertDeclarativeRuntimeTransition(manifest, input.envelope, new Set());
      await this.assertDecisionSubjectPublicationTransition(runRoot, manifest, input.envelope);
      const planOperationRecovery = await recoverPlanRevisionOperationsLocked(
        runRoot,
        input.runId,
        this.validator,
        this.artifacts,
        this.logs,
      );
      const prospectiveManifest = prospectiveInitialPlanManifest(manifest, [input.envelope]);
      const result = await this.artifacts.publishLocked(runRoot, input, false, {
        historicalDiscoveryPlanBindings: planOperationRecovery.historicalDiscoveryPlanBindings,
        ...(prospectiveManifest === null ? {} : { prospectiveManifest }),
      });
      if (taskPublicationMode === "replay") {
        return result;
      }
      const nextManifest = await this.applyPublishedEnvelope(
        runRoot,
        manifest,
        input.envelope,
        ignoredLate,
        result.status === "idempotent_replay",
      );
      if (canonicalJson(nextManifest) !== canonicalJson(manifest)) {
        await this.writeManifest(runRoot, nextManifest);
      }
      return result;
    });
  }

  async publishArtifactBundle(
    input: PublishArtifactBundleInput,
  ): Promise<PublishArtifactBundleResult> {
    await this.assertCurrentLeaf(input.runId);
    if (
      input.envelopes.some(
        (envelope) => envelope.artifact_type === "startup_opportunity.research_handoff.current",
      )
    ) {
      throw new StoreError(
        "research_handoff.dedicated_entry_required",
        "research handoffs must use createResearchHandoff() so the Store captures exact authorized source bytes",
      );
    }
    if (
      input.envelopes.some(
        (envelope) =>
          envelope.artifact_type === "startup_opportunity.dispatch_launch_registration.v1" ||
          (envelope.artifact_type === "startup_opportunity.lane_lifecycle.v1" &&
            envelope.document.revision === 1 &&
            typeof envelope.document.launch_registration_ref === "string"),
      )
    ) {
      throw new StoreError(
        "artifact.dispatch_launch_registration_entry_required",
        "registered lifecycle roots must use the dedicated atomic Dispatch launch entry",
      );
    }
    if (
      input.envelopes.some(
        (envelope) => envelope.artifact_type === "startup_opportunity.terminal_report_source.v1",
      )
    ) {
      throw new StoreError(
        "report.terminal_dedicated_entry_required",
        "terminal report sources must use apply-plan-revision atomic closeout",
      );
    }
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      let manifest = await this.readManifest(runRoot);
      const trackedPaths = new Set([
        ...manifest.artifact_refs,
        ...manifest.ignored_late_artifact_refs,
      ]);
      if (
        input.expectedManifestContentHash !== undefined &&
        canonicalContentHash(manifest) !== input.expectedManifestContentHash &&
        !input.envelopes.every((envelope) => trackedPaths.has(envelope.artifact_path))
      ) {
        throw new StoreError(
          "artifact.manifest_stale",
          "artifact bundle publication no longer binds the exact planned Manifest",
          {
            expected: input.expectedManifestContentHash,
            actual: canonicalContentHash(manifest),
          },
        );
      }
      await this.assertScopeBindingLocked(runRoot, manifest);
      await this.assertTransitionReadyLocked(runRoot, manifest, input.envelopes);
      await this.assertProspectiveScopeFormationLocked(runRoot, manifest, input.envelopes);
      await this.assertProspectivePlanningPublicationLocked(runRoot, manifest, input.envelopes);
      this.assertAtomicDispatchWaveBundle(manifest, input.envelopes);
      const originalManifest = manifest;
      const classifications = new Map<
        string,
        { readonly ignoredLate: boolean; readonly expectedArtifactType: string | null }
      >();
      const taskPublicationModes = new Map<string, "not_task" | "transition" | "replay">();
      const transitioningTaskUnits = new Set<string>();
      const runtimeActivations = new Set<string>();
      for (const envelope of input.envelopes) {
        if (
          envelope.artifact_type !== "startup_opportunity.dispatch_batch.discovery.current" &&
          envelope.artifact_type !== "startup_opportunity.dispatch_batch.assessment.current"
        ) {
          continue;
        }
        for (const task of Array.isArray(envelope.document.tasks) ? envelope.document.tasks : []) {
          if (isRecord(task) && typeof task.unit_id === "string") {
            if (runtimeActivations.has(task.unit_id)) {
              throw new StoreError(
                "artifact.dispatch_transition_invalid",
                "one publication bundle cannot dispatch the same unit more than once",
                { unitId: task.unit_id },
              );
            }
            runtimeActivations.add(task.unit_id);
          }
        }
      }
      for (const envelope of input.envelopes) {
        this.assertAdaptationArtifactMode(manifest, envelope);
        const taskPublicationMode = await this.researchTaskPublicationMode(
          runRoot,
          manifest,
          envelope,
        );
        taskPublicationModes.set(envelope.artifact_path, taskPublicationMode);
        if (taskPublicationMode === "transition" && typeof envelope.document.unit_id === "string") {
          if (transitioningTaskUnits.has(envelope.document.unit_id)) {
            throw new StoreError(
              "artifact.task_transition_invalid",
              "one publication bundle cannot activate the same research unit more than once",
              { unitId: envelope.document.unit_id },
            );
          }
          transitioningTaskUnits.add(envelope.document.unit_id);
        }
        const planned = await this.classifyPlannedArtifact(
          runRoot,
          manifest,
          envelope.artifact_path,
        );
        const effectiveClassification = {
          ...planned,
          ignoredLate:
            planned.ignoredLate ||
            (envelope.artifact_type === "startup_opportunity.enrichment_branch_result.v1" &&
              ["ignored_late", "superseded"].includes(String(envelope.document.status))),
        };
        if (
          planned.expectedArtifactType !== null &&
          planned.expectedArtifactType !== envelope.artifact_type
        ) {
          throw new StoreError(
            "artifact.unit_schema_mismatch",
            "unit output must use its exact required_artifact_schema",
            {
              artifactPath: envelope.artifact_path,
              expected: planned.expectedArtifactType,
              actual: envelope.artifact_type,
            },
          );
        }
        this.assertBranchPublicationTransition(
          manifest,
          envelope,
          effectiveClassification.ignoredLate,
        );
        this.assertDiscoveryLanePublicationTransition(
          manifest,
          envelope,
          effectiveClassification.ignoredLate,
        );
        this.assertEnrichmentBranchPublicationTransition(
          manifest,
          envelope,
          effectiveClassification.ignoredLate,
        );
        this.assertDeclarativeRuntimeTransition(manifest, envelope, runtimeActivations);
        await this.assertDecisionSubjectPublicationTransition(runRoot, manifest, envelope);
        classifications.set(envelope.artifact_path, effectiveClassification);
      }
      const planOperationRecovery = await recoverPlanRevisionOperationsLocked(
        runRoot,
        input.runId,
        this.validator,
        this.artifacts,
        this.logs,
      );
      const prospectiveManifest = prospectiveInitialPlanManifest(originalManifest, input.envelopes);
      const result = await this.artifacts.publishBundleLocked(runRoot, input, {
        historicalDiscoveryPlanBindings: planOperationRecovery.historicalDiscoveryPlanBindings,
        ...(prospectiveManifest === null ? {} : { prospectiveManifest }),
      });
      const publicationResults = new Map(
        result.artifacts.map((artifact) => [artifact.artifactPath, artifact.status]),
      );
      const projectionRank = (envelope: FormalArtifactEnvelope): number =>
        envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current" ||
        envelope.artifact_type === "startup_opportunity.dispatch_batch.assessment.current"
          ? 0
          : envelope.artifact_type === "startup_opportunity.discovery_generation_result.v1"
            ? 2
            : 1;
      for (const envelope of [...input.envelopes].sort(
        (left, right) =>
          projectionRank(left) - projectionRank(right) ||
          left.artifact_path.localeCompare(right.artifact_path),
      )) {
        if (taskPublicationModes.get(envelope.artifact_path) === "replay") {
          continue;
        }
        manifest = await this.applyPublishedEnvelope(
          runRoot,
          manifest,
          envelope,
          classifications.get(envelope.artifact_path)?.ignoredLate ?? false,
          publicationResults.get(envelope.artifact_path) === "idempotent_replay",
        );
      }
      if (canonicalJson(manifest) !== canonicalJson(originalManifest)) {
        await this.writeManifest(runRoot, manifest);
      }
      return result;
    });
  }

  async publishDispatchLaunchRegistration(
    input: PublishDispatchLaunchRegistrationInput,
  ): Promise<PublishArtifactBundleResult> {
    await this.assertCurrentLeaf(input.runId);
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      let manifest = await this.readManifest(runRoot);
      await this.assertScopeBindingLocked(runRoot, manifest);
      if (TERMINAL_RUN_STATUSES.has(manifest.status) || manifest.status === "reporting") {
        throw new StoreError(
          "run.dispatch_launch_registration_terminal",
          "terminal or reporting Runs cannot accept a Dispatch launch registration",
          { status: manifest.status },
        );
      }
      const registration = input.envelopes.find(
        (envelope) =>
          envelope.artifact_type === "startup_opportunity.dispatch_launch_registration.v1",
      );
      const lifecycles = input.envelopes.filter(
        (envelope) => envelope.artifact_type === "startup_opportunity.lane_lifecycle.v1",
      );
      if (
        registration === undefined ||
        input.envelopes.length !== lifecycles.length + 1 ||
        lifecycles.length === 0
      ) {
        throw new StoreError(
          "artifact.dispatch_launch_registration_bundle_invalid",
          "launch registration requires one formal registration and at least one lifecycle root",
        );
      }
      const lockedPreflight = await this.artifacts.preflightDispatchLaunchBundleLocked(runRoot, {
        runId: input.runId,
        envelopes: input.envelopes,
      });
      if (
        lockedPreflight === "idempotent_replay" &&
        input.envelopes.every((envelope) => manifest.artifact_refs.includes(envelope.artifact_path))
      ) {
        return this.artifacts.publishDispatchLaunchBundleLocked(runRoot, {
          runId: input.runId,
          envelopes: input.envelopes,
        });
      }
      const disposed = new Set([
        ...manifest.completed_units,
        ...manifest.failed_units,
        ...manifest.invalidated_units,
        ...manifest.skipped_units,
        ...manifest.cancelled_units,
        ...manifest.superseded_units,
      ]);
      const disposedUnitIds = lifecycles
        .map((envelope) => String(envelope.document.unit_id))
        .filter((unitId) => disposed.has(unitId))
        .sort();
      if (disposedUnitIds.length > 0) {
        throw new StoreError(
          "run.dispatch_launch_registration_unit_disposed",
          "a Dispatch task cannot be launch-registered after formal Unit disposition",
          { unitIds: disposedUnitIds },
        );
      }
      const inactiveUnitIds = lifecycles
        .map((envelope) => String(envelope.document.unit_id))
        .filter((unitId) => !manifest.active_units.includes(unitId))
        .sort();
      const storedDispatch = (await this.artifacts.listFormalDocuments(runRoot)).find(
        (entry) => entry.path === registration.document.dispatch_ref,
      )?.document as FormalArtifactEnvelope | undefined;
      if (
        inactiveUnitIds.length > 0 ||
        storedDispatch === undefined ||
        ![
          "startup_opportunity.dispatch_batch.discovery.current",
          "startup_opportunity.dispatch_batch.assessment.current",
        ].includes(storedDispatch.artifact_type) ||
        storedDispatch.document.research_plan_ref !== manifest.current_plan_ref
      ) {
        throw new StoreError(
          "run.dispatch_launch_registration_task_not_current",
          "launch registration requires active tasks from the current non-superseded Dispatch",
          {
            inactiveUnitIds,
            dispatchRef: registration.document.dispatch_ref,
            currentPlanRef: manifest.current_plan_ref,
            dispatchPlanRef: storedDispatch?.document.research_plan_ref,
          },
        );
      }
      await this.assertTransitionReadyLocked(runRoot, manifest, input.envelopes);
      const validationContext = await this.buildValidationContextLocked(
        runRoot,
        input.runId,
        {
          schema_version: DOCUMENT_BUNDLE_SCHEMA_VERSION,
          documents: input.envelopes.map((envelope) => ({
            path: envelope.artifact_path,
            document: envelope,
          })),
          exact_records: [],
        },
        false,
        new Set(input.envelopes.map((envelope) => envelope.artifact_path)),
      );
      const validation = this.validator.validateDocumentBundle(
        validationContext.bundle,
        validationContext.referenceContext,
      );
      if (!validation.valid) {
        throw new StoreError(
          "artifact.dispatch_launch_registration_validation_failed",
          "Dispatch launch registration bundle does not satisfy the current formal closure",
          {
            bundleErrors: validation.bundleErrors,
            documentErrors: validation.documents.flatMap((document) => document.errors),
            referenceErrors: validation.referenceErrors,
          },
        );
      }
      const planOperationRecovery = await recoverPlanRevisionOperationsLocked(
        runRoot,
        input.runId,
        this.validator,
        this.artifacts,
        this.logs,
      );
      const result = await this.artifacts.publishDispatchLaunchBundleLocked(
        runRoot,
        { runId: input.runId, envelopes: input.envelopes },
        { historicalDiscoveryPlanBindings: planOperationRecovery.historicalDiscoveryPlanBindings },
      );
      const statuses = new Map(
        result.artifacts.map((artifact) => [artifact.artifactPath, artifact.status]),
      );
      for (const envelope of input.envelopes) {
        manifest = await this.applyPublishedEnvelope(
          runRoot,
          manifest,
          envelope,
          false,
          statuses.get(envelope.artifact_path) === "idempotent_replay",
        );
      }
      const original = await this.readManifest(runRoot);
      if (canonicalJson(manifest) !== canonicalJson(original)) {
        await this.writeManifest(runRoot, manifest);
      }
      return result;
    });
  }

  private assertAdaptationArtifactMode(
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
  ): void {
    const discoveryTypes = new Set([
      "startup_opportunity.adaptation_decision.discovery.current",
      "startup_opportunity.gap_snapshot.discovery.plan.current",
      "startup_opportunity.gap_snapshot.discovery.readiness.current",
    ]);
    const assessmentTypes = new Set([
      "startup_opportunity.adaptation_decision.assessment.current",
      "startup_opportunity.gap_snapshot.assessment.current",
    ]);
    const adaptationTypes = new Set([...discoveryTypes, ...assessmentTypes]);
    const allowed = manifest.mode === "opportunity_discovery" ? discoveryTypes : assessmentTypes;
    if (adaptationTypes.has(envelope.artifact_type) && !allowed.has(envelope.artifact_type)) {
      throw new StoreError(
        "artifact.run_mode_mismatch",
        "Adaptation Artifact identity does not match the current Run mode",
        { mode: manifest.mode, artifactType: envelope.artifact_type },
      );
    }
  }

  private async assertProspectivePlanningPublicationLocked(
    runRoot: string,
    manifest: RunManifest,
    envelopes: readonly FormalArtifactEnvelope[],
  ): Promise<void> {
    if (!envelopes.some((envelope) => PLANNING_PUBLICATION_TYPES.has(envelope.artifact_type))) {
      return;
    }
    await this.assertReconciledPrePlanFormationLocked(runRoot, manifest, envelopes);
    const stored = new Map(
      (await this.artifacts.listFormalDocuments(runRoot)).map((entry) => [entry.path, entry]),
    );
    const planningEnvelopes = envelopes.filter((envelope) =>
      PLANNING_PUBLICATION_TYPES.has(envelope.artifact_type),
    );
    const exactPlanningAuthorityReplay = planningEnvelopes.every((envelope) => {
      const existing = stored.get(envelope.artifact_path)?.document;
      return existing !== undefined && canonicalJson(existing) === canonicalJson(envelope);
    });
    if (exactPlanningAuthorityReplay) return;
    if (manifest.current_plan_ref !== null) {
      throw new StoreError(
        "artifact.planning_authority_entry_required",
        "New Plan or leaf planning authority must publish through PlanRevisionRuntime",
        { currentPlanRef: manifest.current_plan_ref },
      );
    }
    const input: DocumentBundle = {
      schema_version: DOCUMENT_BUNDLE_SCHEMA_VERSION,
      documents: envelopes.map((envelope) => ({
        path: envelope.artifact_path,
        document: envelope,
      })),
      exact_records: [],
    };
    const context = await this.buildValidationContextLocked(
      runRoot,
      manifest.run_id,
      input,
      false,
      new Set(envelopes.map((envelope) => envelope.artifact_path)),
    );
    const prospectiveManifest = prospectiveInitialPlanManifest(manifest, envelopes);
    const validationBundle =
      prospectiveManifest === null
        ? context.bundle
        : {
            ...context.bundle,
            documents: context.bundle.documents.map((entry) =>
              entry.path === "manifest.json"
                ? { path: entry.path, document: prospectiveManifest }
                : entry,
            ),
          };
    const closure = this.validator.validateDocumentBundle(
      validationBundle,
      context.referenceContext,
    );
    const closureIssues = [
      ...closure.bundleErrors,
      ...closure.documents.flatMap((document) => document.errors),
      ...closure.referenceErrors,
    ];
    const planValidator =
      manifest.mode === "concept_evidence_assessment"
        ? await createAssessmentPlanSemanticValidator(this.validator.repositoryRoot)
        : await createPlanSemanticValidator(this.validator.repositoryRoot);
    const semantic = planValidator.validateDocumentBundle(
      validationBundle,
      context.referenceContext,
    );
    const semanticIssues = [...semantic.planningContract.contractErrors, ...semantic.planErrors];
    if (!closure.valid || !semantic.valid) {
      throw new StoreError(
        "artifact.planning_preflight_failed",
        "prospective Plan, Planning Context, and AI source policy closure is not publishable",
        {
          issues: [...closureIssues, ...semanticIssues],
          contractErrors: semantic.planningContract.contractErrors,
          planErrors: semantic.planErrors,
        },
      );
    }
  }

  private async prePlanFormationRefsLocked(runRoot: string): Promise<readonly string[]> {
    return (await this.artifacts.listFormalDocuments(runRoot))
      .filter(
        (entry) =>
          isRecord(entry.document) &&
          isCurrentEnvelopeSchema(entry.document.schema_version) &&
          (PRE_PLAN_FORMATION_TYPES.has(String(entry.document.artifact_type)) ||
            (entry.document.artifact_type === "startup_opportunity.research_handoff.current" &&
              isRecord(entry.document.document) &&
              entry.document.document.target_formation_stage === "pre_plan_assessment_formation")),
      )
      .map((entry) => entry.path)
      .sort();
  }

  private async prospectiveFormationDocumentsLocked(
    runRoot: string,
    envelopes: readonly FormalArtifactEnvelope[],
  ): Promise<ReadonlyMap<string, FormalArtifactEnvelope>> {
    const documents = new Map<string, FormalArtifactEnvelope>();
    for (const entry of await this.artifacts.listFormalDocuments(runRoot)) {
      if (
        isRecord(entry.document) &&
        isCurrentEnvelopeSchema(entry.document.schema_version) &&
        PRE_PLAN_FORMATION_TYPES.has(String(entry.document.artifact_type))
      ) {
        documents.set(entry.path, entry.document as FormalArtifactEnvelope);
      }
    }
    for (const envelope of envelopes) {
      if (PRE_PLAN_FORMATION_TYPES.has(envelope.artifact_type)) {
        documents.set(envelope.artifact_path, envelope);
      }
    }
    return documents;
  }

  private async currentScopeFormationAuthorityLocked(
    runRoot: string,
    manifest: RunManifest,
  ): Promise<{
    readonly scope: Record<string, unknown>;
    readonly staleRefs: ReadonlySet<string>;
  }> {
    const state = await this.assertScopeBindingLocked(runRoot, manifest);
    if (state.confirmation === null || !isRecord(state.confirmation.scope)) {
      throw new StoreError(
        "run.scope_confirmation_required",
        "pre-Plan formation requires the exact current Scope confirmation",
      );
    }
    return {
      scope: state.confirmation.scope,
      staleRefs: new Set(strings(state.confirmation.superseded_formation_refs)),
    };
  }

  private scopeFormationMismatch(
    artifactPath: string,
    message: string,
    details: Record<string, unknown> = {},
  ): never {
    throw new StoreError("run.scope_formation_binding_invalid", message, {
      artifactPath,
      ...details,
    });
  }

  private assertFormationDocumentMatchesScope(
    envelope: FormalArtifactEnvelope,
    scope: Record<string, unknown>,
  ): void {
    const document = envelope.document;
    const expectedScopeConfirmation = {
      geography: scope.geography,
      customer_model: scope.customer_model,
      target_users: scope.target_users,
      decision_goal: scope.decision_goal,
      research_language: scope.research_language,
      user_confirmed: true,
    };
    const intakeConstraints = isRecord(document.explicit_constraints)
      ? document.explicit_constraints
      : null;
    if (
      envelope.artifact_type === "startup_opportunity.intake.v1" &&
      (canonicalJson(document.scope_confirmation) !== canonicalJson(expectedScopeConfirmation) ||
        document.market !== scope.geography ||
        document.language !== scope.research_language ||
        intakeConstraints === null ||
        intakeConstraints.target_market !== scope.geography ||
        intakeConstraints.target_language !== scope.research_language ||
        canonicalJson(intakeConstraints.target_users) !== canonicalJson(scope.target_users))
    ) {
      this.scopeFormationMismatch(
        envelope.artifact_path,
        "Intake must project the exact current confirmed Scope",
      );
    }
    if (
      envelope.artifact_type === "startup_opportunity.scope_frame.discovery.current" &&
      (document.market !== scope.geography ||
        document.language !== scope.research_language ||
        canonicalJson(document.target_users) !== canonicalJson(scope.target_users))
    ) {
      this.scopeFormationMismatch(
        envelope.artifact_path,
        "Discovery ScopeFrame must project the exact current confirmed Scope",
      );
    }
    if (
      envelope.artifact_type === "startup_opportunity.scope_frame.assessment.current" &&
      (document.market !== scope.geography ||
        document.language !== scope.research_language ||
        canonicalJson(document.target_user) !== canonicalJson(scope.target_users))
    ) {
      this.scopeFormationMismatch(
        envelope.artifact_path,
        "Assessment ScopeFrame must project the exact current confirmed Scope",
      );
    }
  }

  private async assertProspectiveScopeFormationLocked(
    runRoot: string,
    manifest: RunManifest,
    envelopes: readonly FormalArtifactEnvelope[],
  ): Promise<void> {
    if (
      manifest.status !== "needs_clarification" ||
      manifest.current_plan_ref !== null ||
      !envelopes.some((envelope) => PRE_PLAN_FORMATION_TYPES.has(envelope.artifact_type))
    ) {
      return;
    }
    const authority = await this.currentScopeFormationAuthorityLocked(runRoot, manifest);
    const formation = await this.prospectiveFormationDocumentsLocked(runRoot, envelopes);
    for (const envelope of envelopes) {
      if (!PRE_PLAN_FORMATION_TYPES.has(envelope.artifact_type)) continue;
      if (authority.staleRefs.has(envelope.artifact_path)) {
        this.scopeFormationMismatch(
          envelope.artifact_path,
          "a Scope revision cannot reuse formation bytes superseded at confirmation",
        );
      }
      this.assertFormationDocumentMatchesScope(envelope, authority.scope);
      if (
        [
          "startup_opportunity.concept_hypothesis.assessment.current",
          "startup_opportunity.concept_hypothesis.assessment_intake.current",
        ].includes(envelope.artifact_type)
      ) {
        const scopeRef = envelope.document.scope_frame_ref;
        const scopeEnvelope = typeof scopeRef === "string" ? formation.get(scopeRef) : undefined;
        if (
          typeof scopeRef !== "string" ||
          authority.staleRefs.has(scopeRef) ||
          scopeEnvelope?.artifact_type !== "startup_opportunity.scope_frame.assessment.current"
        ) {
          this.scopeFormationMismatch(
            envelope.artifact_path,
            "Assessment Concept formation must bind the exact current non-superseded ScopeFrame",
          );
        }
        this.assertFormationDocumentMatchesScope(scopeEnvelope, authority.scope);
      }
    }
  }

  private async exactAssessmentPrePlanScopeLocked(
    runRoot: string,
    manifest: RunManifest,
  ): Promise<FormalArtifactEnvelope> {
    const authority = await this.currentScopeFormationAuthorityLocked(runRoot, manifest);
    const formation = await this.prospectiveFormationDocumentsLocked(runRoot, []);
    const candidates = [...formation.entries()]
      .filter(
        ([ref, envelope]) =>
          !authority.staleRefs.has(ref) &&
          envelope.artifact_type === "startup_opportunity.scope_frame.assessment.current",
      )
      .filter(([, envelope]) => {
        try {
          this.assertFormationDocumentMatchesScope(envelope, authority.scope);
          return true;
        } catch (error) {
          if (error instanceof StoreError && error.code === "run.scope_formation_binding_invalid") {
            return false;
          }
          throw error;
        }
      })
      .filter(([, scope]) => {
        const decisionRef = scope.document.decision_context_ref;
        const decision = typeof decisionRef === "string" ? formation.get(decisionRef) : undefined;
        return (
          typeof decisionRef === "string" &&
          !authority.staleRefs.has(decisionRef) &&
          decision?.artifact_type === "startup_opportunity.decision_context.v1" &&
          [...formation.entries()].some(
            ([intakeRef, intake]) =>
              !authority.staleRefs.has(intakeRef) &&
              intake.artifact_type === "startup_opportunity.intake.v1" &&
              intake.document.decision_context_ref === decisionRef &&
              (() => {
                try {
                  this.assertFormationDocumentMatchesScope(intake, authority.scope);
                  return true;
                } catch (error) {
                  if (
                    error instanceof StoreError &&
                    error.code === "run.scope_formation_binding_invalid"
                  ) {
                    return false;
                  }
                  throw error;
                }
              })(),
          )
        );
      });
    if (candidates.length !== 1 || candidates[0] === undefined) {
      const matchesScope = (envelope: FormalArtifactEnvelope): boolean => {
        try {
          this.assertFormationDocumentMatchesScope(envelope, authority.scope);
          return true;
        } catch (error) {
          if (error instanceof StoreError && error.code === "run.scope_formation_binding_invalid") {
            return false;
          }
          throw error;
        }
      };
      throw new StoreError(
        "run.scope_formation_binding_invalid",
        "pre-Plan Assessment handoff requires one exact current Intake, DecisionContext, and ScopeFrame closure",
        {
          scopeRevision: manifest.scope_revision,
          candidateCount: candidates.length,
          confirmedScope: authority.scope,
          staleRefs: [...authority.staleRefs].sort(),
          formation: [...formation.entries()].map(([ref, envelope]) => ({
            ref,
            artifactType: envelope.artifact_type,
            matchesScope: matchesScope(envelope),
            decisionContextRef: envelope.document.decision_context_ref ?? null,
            scopeProjection: {
              market: envelope.document.market ?? null,
              language: envelope.document.language ?? null,
              targetUsers: envelope.document.target_users ?? envelope.document.target_user ?? null,
              scopeConfirmation: envelope.document.scope_confirmation ?? null,
              explicitConstraints: envelope.document.explicit_constraints ?? null,
            },
          })),
        },
      );
    }
    return candidates[0][1];
  }

  private async assertReconciledPrePlanFormationLocked(
    runRoot: string,
    manifest: RunManifest,
    envelopes: readonly FormalArtifactEnvelope[],
  ): Promise<void> {
    if (
      manifest.status !== "needs_clarification" ||
      manifest.current_plan_ref !== null ||
      !envelopes.some(
        (envelope) =>
          envelope.artifact_type === "startup_opportunity.research_plan.v1" &&
          envelope.document.revision === 1,
      )
    ) {
      return;
    }
    const authority = await this.currentScopeFormationAuthorityLocked(runRoot, manifest);
    const formation = await this.prospectiveFormationDocumentsLocked(runRoot, envelopes);
    const current = [...formation.entries()].filter(([ref, envelope]) => {
      if (authority.staleRefs.has(ref)) return false;
      try {
        this.assertFormationDocumentMatchesScope(envelope, authority.scope);
        return true;
      } catch (error) {
        if (error instanceof StoreError && error.code === "run.scope_formation_binding_invalid") {
          return false;
        }
        throw error;
      }
    });
    const byType = (artifactType: string) =>
      current.filter(([, envelope]) => envelope.artifact_type === artifactType);
    const plans = envelopes.filter(
      (envelope) => envelope.artifact_type === "startup_opportunity.research_plan.v1",
    );
    const planRefs = new Set(
      plans.flatMap((envelope) =>
        records(envelope.document.waves).flatMap((wave) =>
          records(wave.units).flatMap((unit) => strings(unit.input_refs)),
        ),
      ),
    );
    const intakes = byType("startup_opportunity.intake.v1");
    const scopeType =
      manifest.mode === "opportunity_discovery"
        ? "startup_opportunity.scope_frame.discovery.current"
        : "startup_opportunity.scope_frame.assessment.current";
    const scopes = byType(scopeType);
    const concepts = [
      ...byType("startup_opportunity.concept_hypothesis.assessment.current"),
      ...byType("startup_opportunity.concept_hypothesis.assessment_intake.current"),
    ];
    const closureExists = scopes.some(([scopeRef, scopeEnvelope]) => {
      const decisionRef = scopeEnvelope.document.decision_context_ref;
      if (typeof decisionRef !== "string") return false;
      const decision = formation.get(decisionRef);
      if (
        decision === undefined ||
        authority.staleRefs.has(decisionRef) ||
        decision.artifact_type !== "startup_opportunity.decision_context.v1"
      ) {
        return false;
      }
      const intakeMatches = intakes.some(
        ([, intake]) => intake.document.decision_context_ref === decisionRef,
      );
      if (!intakeMatches) return false;
      if (manifest.mode === "opportunity_discovery") return planRefs.has(scopeRef);
      return concepts.some(
        ([conceptRef, concept]) =>
          concept.document.scope_frame_ref === scopeRef && planRefs.has(conceptRef),
      );
    });
    if (!closureExists) {
      this.scopeFormationMismatch(
        plans[0]?.artifact_path ?? "plans/research-plan.r1.json",
        "the first Plan must causally close over exact current non-superseded Intake, DecisionContext, ScopeFrame, and mode-specific Concept formation",
        { scopeRevision: manifest.scope_revision },
      );
    }
  }

  async assertTransitionReady(
    runId: string,
    envelopes: readonly FormalArtifactEnvelope[],
  ): Promise<void> {
    await this.assertCurrentLeaf(runId);
    const runRoot = await openRunDirectory(this.runsRoot, runId);
    await withRunLock(runRoot, async () => {
      const manifest = await this.readManifest(runRoot);
      await this.assertScopeBindingLocked(runRoot, manifest);
      await this.assertTransitionReadyLocked(runRoot, manifest, envelopes);
    });
  }

  private async assertTransitionReadyLocked(
    runRoot: string,
    manifest: RunManifest,
    envelopes: readonly FormalArtifactEnvelope[],
  ): Promise<void> {
    await this.assertScopeBindingLocked(runRoot, manifest);
    await this.assertLaneLifecycleLaunchIdentitiesLocked(runRoot, manifest, envelopes);
    if (manifest.status === "awaiting_scope_confirmation") {
      throw new StoreError(
        "run.scope_confirmation_required",
        "research publication is blocked until confirmation binds the exact Scope proposal",
        {
          scopeProposalRef: manifest.scope_proposal_ref,
          scopeProposalHash: manifest.scope_proposal_hash,
        },
      );
    }
    if (
      manifest.status === "needs_clarification" &&
      envelopes.some(
        (envelope) => !scopeReconciliationArtifactTypeAllowed(manifest, envelope.artifact_type),
      )
    ) {
      throw new StoreError(
        "run.scope_revision_unresolved",
        "research publication is blocked until the latest confirmed Scope is reconciled through Gap, Adaptation Decision, and Plan Revision",
        { scopeRevision: manifest.scope_revision },
      );
    }
    const downstreamTypes = new Set([
      "startup_opportunity.discovery_candidate.v1",
      "startup_opportunity.discovery_candidate_conversion.v2",
      "startup_opportunity.discovery_fan_in.v2",
      "startup_opportunity.concept_evidence_assessment_fan_in.v1",
      "startup_opportunity.enrichment_fan_in.v1",
      "startup_opportunity.demand_thesis.v1",
      "startup_opportunity.baseline_option.v1",
      "startup_opportunity.solution_hypothesis.v1",
      "startup_opportunity.solution_evaluation.v1",
      "startup_opportunity.opportunity_thesis.v1",
      "startup_opportunity.opportunity_comparison.v1",
      "startup_opportunity.portfolio_view.v1",
      "startup_opportunity.report.v1",
      "startup_opportunity.terminal_report_source.v1",
    ]);
    const fanInOrConversionTypes = new Set([
      "startup_opportunity.discovery_candidate_conversion.v2",
      "startup_opportunity.discovery_fan_in.v2",
      "startup_opportunity.concept_evidence_assessment_fan_in.v1",
      "startup_opportunity.enrichment_fan_in.v1",
    ]);
    const launchClosureTypes = new Set([
      ...downstreamTypes,
      "startup_opportunity.discovery_stage_readiness.v1",
      "startup_opportunity.assessment_stage_gate.v1",
    ]);
    await this.assertDispatchLaunchClosureLocked(runRoot, manifest, envelopes, launchClosureTypes);
    if (!envelopes.some((envelope) => downstreamTypes.has(envelope.artifact_type))) return;

    const publishingIdentities = new Set(
      envelopes.map(
        (envelope) =>
          `${envelope.artifact_path}:${envelope.artifact_type}:${envelope.content_hash}`,
      ),
    );
    const operationDirectory = path.join(runRoot, ".store", "operations");
    const pendingOperations: string[] = [];
    let evidenceRecords: readonly Record<string, unknown>[] | null = null;
    for (const entry of await readdir(operationDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let receipt: unknown;
      try {
        receipt = JSON.parse(await readFile(path.join(operationDirectory, entry.name), "utf8"));
      } catch {
        pendingOperations.push(entry.name);
        continue;
      }
      if (!isRecord(receipt)) {
        pendingOperations.push(entry.name);
        continue;
      }
      if (receipt.schema_version === "startup_opportunity.research_handoff_operation.current") {
        try {
          const intent = validateResearchHandoffOperationIntent(
            receipt,
            entry.name,
            manifest.run_id,
          );
          const handoffExists = manifest.artifact_refs.includes(intent.handoff_ref);
          evidenceRecords ??= (await this.evidence.listRecordsLocked(
            runRoot,
            manifest.run_id,
          )) as readonly Record<string, unknown>[];
          const importedEvidenceCount = intent.evidence_imports.filter((evidenceImport) =>
            evidenceRecords?.some(
              (record) => record.operation_key === evidenceImport.record.operation_key,
            ),
          ).length;
          const complete =
            handoffExists && importedEvidenceCount === intent.evidence_imports.length;
          const started = handoffExists || importedEvidenceCount > 0;
          if (
            !complete &&
            (started || (await this.researchHandoffIntentStillApplicable(runRoot, intent)))
          ) {
            pendingOperations.push(entry.name);
          }
        } catch {
          pendingOperations.push(entry.name);
        }
        continue;
      }
      if (receipt.schema_version === "startup_opportunity.jsonl_operation.v1") {
        if (
          (receipt.log_path !== "events.jsonl" && receipt.log_path !== "decisions.jsonl") ||
          typeof receipt.record_id !== "string" ||
          !isRecord(receipt.record)
        ) {
          pendingOperations.push(entry.name);
          continue;
        }
        try {
          const durable = await this.logs.readExactRecord(
            runRoot,
            manifest.run_id,
            `${receipt.log_path}#${receipt.record_id}`,
            receipt.log_path,
          );
          if (canonicalJson(durable) !== canonicalJson(receipt.record)) {
            pendingOperations.push(entry.name);
          }
        } catch {
          pendingOperations.push(entry.name);
        }
        continue;
      }
      if (receipt.schema_version === "startup_opportunity.evidence_store_operation.current") {
        if (!isRecord(receipt.record)) {
          pendingOperations.push(entry.name);
          continue;
        }
        evidenceRecords ??= (await this.evidence.listRecordsLocked(
          runRoot,
          manifest.run_id,
        )) as readonly Record<string, unknown>[];
        const record = receipt.record;
        const durable = evidenceRecords.find(
          (candidate) => candidate.evidence_id === record.evidence_id,
        );
        try {
          const raw = await readFile(
            await resolveRunPath(runRoot, String(record.raw_content_ref ?? "")),
          );
          if (
            durable === undefined ||
            canonicalJson(durable) !== canonicalJson(record) ||
            sha256Bytes(raw) !== record.content_hash
          ) {
            pendingOperations.push(entry.name);
          }
        } catch {
          pendingOperations.push(entry.name);
        }
        continue;
      }
      if (receipt.schema_version === "startup_opportunity.report_materialization_operation.v1") {
        try {
          const bytes = await readFile(
            await resolveRunPath(runRoot, String(receipt.target_path ?? "")),
          );
          if (sha256Bytes(bytes) !== receipt.materialized_content_hash) {
            pendingOperations.push(entry.name);
          }
        } catch {
          pendingOperations.push(entry.name);
        }
        continue;
      }
      if (
        receipt.schema_version ===
          "startup_opportunity.plan_revision_operation.discovery.current" ||
        receipt.schema_version === "startup_opportunity.plan_revision_operation.assessment.current"
      ) {
        const expectedEnvelopes = [
          ...(Array.isArray(receipt.control_envelopes)
            ? receipt.control_envelopes.filter(isRecord)
            : []),
          ...(isRecord(receipt.checkpoint_envelope) ? [receipt.checkpoint_envelope] : []),
        ];
        let complete = expectedEnvelopes.length > 0;
        for (const expected of expectedEnvelopes) {
          try {
            const stored = JSON.parse(
              await readFile(
                await resolveRunPath(runRoot, String(expected.artifact_path ?? "")),
                "utf8",
              ),
            ) as unknown;
            if (canonicalJson(stored) !== canonicalJson(expected)) complete = false;
          } catch {
            complete = false;
          }
        }
        if (!complete) pendingOperations.push(entry.name);
        continue;
      }
      if (receipt.schema_version === "startup_opportunity.artifact_bundle_operation.current") {
        const expectedEnvelopes = Array.isArray(receipt.envelopes)
          ? receipt.envelopes.filter(isRecord)
          : [];
        let complete = expectedEnvelopes.length >= 2;
        for (const expected of expectedEnvelopes) {
          const identity = `${String(expected.artifact_path)}:${String(expected.artifact_type)}:${String(expected.content_hash)}`;
          try {
            const stored = JSON.parse(
              await readFile(
                await resolveRunPath(runRoot, String(expected.artifact_path ?? "")),
                "utf8",
              ),
            ) as unknown;
            if (canonicalJson(stored) !== canonicalJson(expected)) complete = false;
          } catch (error) {
            if (!publishingIdentities.has(identity) || !isNodeError(error, "ENOENT")) {
              complete = false;
            }
          }
        }
        if (!complete) pendingOperations.push(entry.name);
        continue;
      }
      if (!isRecord(receipt.envelope)) {
        pendingOperations.push(entry.name);
        continue;
      }
      const envelope = receipt.envelope;
      if (
        typeof envelope.artifact_path !== "string" ||
        typeof envelope.artifact_type !== "string" ||
        typeof envelope.content_hash !== "string"
      ) {
        pendingOperations.push(entry.name);
        continue;
      }
      try {
        const persisted = JSON.parse(
          await readFile(await resolveRunPath(runRoot, envelope.artifact_path), "utf8"),
        ) as unknown;
        if (canonicalJson(persisted) !== canonicalJson(envelope))
          pendingOperations.push(entry.name);
      } catch (error) {
        const identity = `${envelope.artifact_path}:${envelope.artifact_type}:${envelope.content_hash}`;
        if (!publishingIdentities.has(identity) || !isNodeError(error, "ENOENT")) {
          pendingOperations.push(entry.name);
        }
      }
    }
    if (pendingOperations.length > 0) {
      throw new StoreError(
        "run.transition_pending_operation",
        "downstream publication is blocked by an unfinished Store operation",
        { pendingOperations: pendingOperations.sort() },
      );
    }

    await this.assertDiscoverySynthesisReadinessLocked(runRoot, manifest, envelopes);

    let unresolvedBlockingGapIds: string[] = [];
    if (manifest.latest_gap_snapshot_ref !== null) {
      const stored = JSON.parse(
        await readFile(await resolveRunPath(runRoot, manifest.latest_gap_snapshot_ref), "utf8"),
      ) as unknown;
      const gapDocument =
        isRecord(stored) && isRecord(stored.document)
          ? stored.document
          : isRecord(stored)
            ? stored
            : null;
      unresolvedBlockingGapIds = Array.isArray(gapDocument?.gaps)
        ? gapDocument.gaps
            .filter(
              (gap): gap is Record<string, unknown> => isRecord(gap) && gap.severity === "blocking",
            )
            .map((gap) => String(gap.gap_id))
        : [];
      if (unresolvedBlockingGapIds.length > 0) {
        const handledGapIds = new Set<string>();
        for (const ref of manifest.applied_adaptation_refs) {
          try {
            const storedDecision = JSON.parse(
              await readFile(await resolveRunPath(runRoot, ref.split("#", 1)[0] ?? ref), "utf8"),
            ) as unknown;
            const decision =
              isRecord(storedDecision) && isRecord(storedDecision.document)
                ? storedDecision.document
                : isRecord(storedDecision)
                  ? storedDecision
                  : null;
            for (const triggerRef of Array.isArray(decision?.trigger_gap_refs)
              ? decision.trigger_gap_refs
              : []) {
              if (
                typeof triggerRef === "string" &&
                triggerRef.startsWith(`${manifest.latest_gap_snapshot_ref}#`)
              ) {
                handledGapIds.add(triggerRef.slice(triggerRef.indexOf("#") + 1));
              }
            }
          } catch {
            // Ordinary validation reports corrupt applied decisions; this gate treats them as absent.
          }
        }
        const appliedForGap = unresolvedBlockingGapIds.every((gapId) => handledGapIds.has(gapId));
        if (!appliedForGap) {
          throw new StoreError(
            "run.transition_blocking_gap_unresolved",
            "downstream publication requires a validated and applied Adaptation Decision for every blocking Gap",
            {
              gapSnapshotRef: manifest.latest_gap_snapshot_ref,
              gapIds: unresolvedBlockingGapIds.sort(),
              pendingAdaptationRefs: manifest.pending_adaptation_refs,
            },
          );
        }
      }
    }
    if (manifest.pending_adaptation_refs.length > 0) {
      throw new StoreError(
        "run.transition_adaptation_pending",
        "downstream publication is blocked until pending Adaptation Decisions are applied or rejected",
        { pendingAdaptationRefs: manifest.pending_adaptation_refs },
      );
    }
    if (
      envelopes.some((envelope) => fanInOrConversionTypes.has(envelope.artifact_type)) &&
      manifest.active_units.some(
        (unitId) =>
          !envelopes.some(
            (envelope) =>
              envelope.document.unit_id === unitId &&
              [
                "startup_opportunity.discovery_generation_result.v1",
                "startup_opportunity.assessment_lane_result.v1",
                "startup_opportunity.concept_evidence_assessment_branch_result.v1",
                "startup_opportunity.discovery_lane_result.v1",
                "startup_opportunity.enrichment_branch_result.v1",
              ].includes(envelope.artifact_type),
          ),
      )
    ) {
      const closingUnitIds = new Set(
        envelopes
          .map((envelope) => envelope.document.unit_id)
          .filter((unitId): unitId is string => typeof unitId === "string"),
      );
      throw new StoreError(
        "run.transition_fan_in_dead_end",
        "fan-in or conversion cannot publish while its Run still has active units",
        { activeUnitIds: manifest.active_units.filter((unitId) => !closingUnitIds.has(unitId)) },
      );
    }
    if (
      envelopes.some(
        (envelope) => envelope.artifact_type === "startup_opportunity.terminal_report_source.v1",
      )
    ) {
      const context = await this.buildValidationContextLocked(runRoot, manifest.run_id, {
        schema_version: DOCUMENT_BUNDLE_SCHEMA_VERSION,
        documents: envelopes.map((envelope) => ({
          path: envelope.artifact_path,
          document: envelope,
        })),
        exact_records: [],
      });
      const validation = this.validator.validateDocumentBundle(
        context.bundle,
        context.referenceContext,
      );
      if (!validation.valid) {
        throw new StoreError(
          "run.transition_terminal_report_invalid",
          "terminal reporting must validate against the original Run's complete Manifest and Evidence set",
          {
            bundleErrors: validation.bundleErrors,
            documentErrors: validation.documents.flatMap((document) => document.errors),
            referenceErrors: validation.referenceErrors,
          },
        );
      }
    }
  }

  private async assertDiscoverySynthesisReadinessLocked(
    runRoot: string,
    manifest: RunManifest,
    envelopes: readonly FormalArtifactEnvelope[],
  ): Promise<void> {
    const synthesis = envelopes.filter((envelope) =>
      isDiscoverySynthesisSchemaVersion(envelope.artifact_type),
    );
    if (
      synthesis.length === 0 ||
      synthesis.every((envelope) => manifest.artifact_refs.includes(envelope.artifact_path))
    ) {
      return;
    }

    const planRef = manifest.current_plan_ref;
    const latestGapRef = manifest.latest_gap_snapshot_ref;
    if (planRef === null || latestGapRef === null) {
      throw new StoreError(
        "run.discovery_synthesis_readiness_required",
        "new G2.3 publication requires an immutable current Readiness and readiness Gap",
        { currentPlanRef: planRef, latestGapSnapshotRef: latestGapRef },
      );
    }

    const formal = await this.artifacts.listFormalDocuments(runRoot);
    const currentRefs = new Set(manifest.artifact_refs);
    const current = formal.filter((entry) => currentRefs.has(entry.path));
    const byPath = new Map(current.map((entry) => [entry.path, entry] as const));
    const envelopeAt = async (
      artifactRef: string,
      expectedType: string,
      code: string,
    ): Promise<FormalArtifactEnvelope> => {
      const stored = byPath.get(artifactRef)?.document;
      if (
        !isRecord(stored) ||
        !isCurrentEnvelopeSchema(stored.schema_version) ||
        stored.artifact_path !== artifactRef ||
        stored.artifact_type !== expectedType ||
        !isRecord(stored.document)
      ) {
        throw new StoreError(code, "G2.3 readiness authority is missing or has the wrong type", {
          artifactRef,
          expectedType,
          actualType: isRecord(stored) ? (stored.artifact_type ?? null) : null,
        });
      }
      const envelope = stored as FormalArtifactEnvelope;
      await this.artifacts.validateStoredEnvelope(runRoot, manifest.run_id, envelope);
      return envelope;
    };
    const latestByCreation = (
      candidates: readonly FormalArtifactEnvelope[],
    ): FormalArtifactEnvelope | null =>
      [...candidates].sort((left, right) => {
        const createdDifference = Date.parse(right.created_at) - Date.parse(left.created_at);
        if (createdDifference !== 0) return createdDifference;
        const revisionDifference =
          Number(right.document.revision ?? 0) - Number(left.document.revision ?? 0);
        return revisionDifference !== 0
          ? revisionDifference
          : right.artifact_path.localeCompare(left.artifact_path);
      })[0] ?? null;

    const gap = await envelopeAt(
      latestGapRef,
      "startup_opportunity.gap_snapshot.discovery.readiness.current",
      "run.discovery_synthesis_readiness_gap_required",
    );
    const readinessRef = gap.document.readiness_ref;
    if (typeof readinessRef !== "string") {
      throw new StoreError(
        "run.discovery_synthesis_readiness_binding_invalid",
        "the current readiness Gap does not identify an exact Readiness artifact",
        { latestGapRef },
      );
    }
    const readiness = await envelopeAt(
      readinessRef,
      "startup_opportunity.discovery_stage_readiness.v1",
      "run.discovery_synthesis_readiness_required",
    );
    const latestReadiness = latestByCreation(
      current
        .map((entry) => entry.document)
        .filter(
          (candidate): candidate is FormalArtifactEnvelope =>
            isRecord(candidate) &&
            isCurrentEnvelopeSchema(candidate.schema_version) &&
            candidate.artifact_type === "startup_opportunity.discovery_stage_readiness.v1" &&
            isRecord(candidate.document) &&
            candidate.document.research_plan_ref === planRef,
        ),
    );
    if (latestReadiness?.artifact_path !== readiness.artifact_path) {
      throw new StoreError(
        "run.discovery_synthesis_readiness_stale",
        "the current readiness Gap must bind the latest exact Readiness for the current Plan",
        {
          readinessRef: readiness.artifact_path,
          latestReadinessRef: latestReadiness?.artifact_path ?? null,
        },
      );
    }

    const plan = await envelopeAt(
      planRef,
      "startup_opportunity.research_plan.v1",
      "run.discovery_synthesis_readiness_binding_invalid",
    );
    const fanInRefs = [
      ...new Set(
        synthesis
          .map((envelope) => envelope.document.discovery_fan_in_ref)
          .filter((ref): ref is string => typeof ref === "string"),
      ),
    ];
    const fanInRef = fanInRefs[0];
    if (fanInRefs.length !== 1 || fanInRef === undefined) {
      throw new StoreError(
        "run.discovery_synthesis_readiness_binding_invalid",
        "new G2.3 artifacts must share one exact discovery fan-in",
        { fanInRefs },
      );
    }
    if (synthesis.some((envelope) => envelope.document.research_plan_ref !== planRef)) {
      throw new StoreError(
        "run.discovery_synthesis_readiness_binding_invalid",
        "new G2.3 artifacts must bind the current Manifest Plan",
        { planRef },
      );
    }
    const fanIn = await envelopeAt(
      fanInRef,
      "startup_opportunity.discovery_fan_in.v2",
      "run.discovery_synthesis_readiness_binding_invalid",
    );
    const executionRef = readiness.document.execution_plan_ref;
    if (typeof executionRef !== "string") {
      throw new StoreError(
        "run.discovery_synthesis_readiness_binding_invalid",
        "G2.3 Readiness must identify the exact current execution overlay",
      );
    }
    const execution = await envelopeAt(
      executionRef,
      "startup_opportunity.research_execution_plan.discovery.current",
      "run.discovery_synthesis_readiness_binding_invalid",
    );
    const currentExecutions = current
      .map((entry) => entry.document)
      .filter(
        (candidate): candidate is FormalArtifactEnvelope =>
          isRecord(candidate) &&
          isCurrentEnvelopeSchema(candidate.schema_version) &&
          candidate.artifact_type ===
            "startup_opportunity.research_execution_plan.discovery.current" &&
          isRecord(candidate.document) &&
          candidate.document.research_plan_ref === planRef,
      );
    const latestExecution = [...currentExecutions].sort(
      (left, right) =>
        Number(right.document.revision ?? 0) - Number(left.document.revision ?? 0) ||
        right.artifact_path.localeCompare(left.artifact_path),
    )[0];
    const nextStage = records(execution.document.stages).find(
      (stage) => stage.stage_id === readiness.document.next_stage_id,
    );
    const expectedQuestionRefs = records(plan.document.research_questions).map(
      (question) => `${planRef}#${String(question.question_id)}`,
    );
    const coverage = records(readiness.document.question_coverage);
    const coveredQuestionRefs = coverage.map((question) => String(question.question_ref));
    const questionsAnswered =
      canonicalJson([...new Set(expectedQuestionRefs)].sort()) ===
        canonicalJson([...new Set(coveredQuestionRefs)].sort()) &&
      coverage.every(
        (question) => question.status === "answered" && strings(question.judgment_refs).length > 0,
      );
    if (
      latestExecution?.artifact_path !== execution.artifact_path ||
      readiness.document.run_id !== manifest.run_id ||
      readiness.document.research_plan_ref !== planRef ||
      readiness.document.source_fan_in_ref !== fanInRef ||
      gap.document.run_id !== manifest.run_id ||
      gap.document.based_on_plan_ref !== planRef ||
      gap.document.fan_in_ref !== fanInRef ||
      fanIn.document.run_id !== manifest.run_id ||
      fanIn.document.research_plan_ref !== planRef ||
      execution.document.run_id !== manifest.run_id ||
      execution.document.research_plan_ref !== planRef ||
      nextStage?.stage_kind !== "discovery_synthesis" ||
      nextStage.gate_before !== readiness.artifact_path
    ) {
      throw new StoreError(
        "run.discovery_synthesis_readiness_binding_invalid",
        "G2.3 Readiness and readiness Gap must bind the current Plan, execution stage, and fan-in",
        {
          planRef,
          fanInRef,
          executionRef,
          latestExecutionRef: latestExecution?.artifact_path ?? null,
          readinessRef: readiness.artifact_path,
          readinessGapRef: gap.artifact_path,
        },
      );
    }
    if (
      readiness.document.next_stage_readiness !== "ready" ||
      records(readiness.document.blockers).length > 0 ||
      !questionsAnswered ||
      strings(gap.document.unresolved_decision_relevant_questions).length > 0
    ) {
      throw new StoreError(
        "run.discovery_synthesis_not_ready",
        "G2.3 requires ready disposition, no blockers, and Judgment-backed answers for every current Plan question",
        {
          readiness: readiness.document.next_stage_readiness,
          blockerCount: records(readiness.document.blockers).length,
          questionsAnswered,
          unresolvedQuestionRefs: gap.document.unresolved_decision_relevant_questions,
        },
      );
    }
  }

  private async assertLaneLifecycleLaunchIdentitiesLocked(
    runRoot: string,
    manifest: RunManifest,
    envelopes: readonly FormalArtifactEnvelope[],
  ): Promise<void> {
    const incoming = envelopes.filter(
      (envelope) => envelope.artifact_type === "startup_opportunity.lane_lifecycle.v1",
    );
    if (incoming.length === 0) return;
    const stored = (await this.artifacts.listFormalDocuments(runRoot))
      .filter(
        (entry) =>
          manifest.artifact_refs.includes(entry.path) &&
          entry.document.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
          entry.document.artifact_type === "startup_opportunity.lane_lifecycle.v1",
      )
      .map((entry) => entry.document as FormalArtifactEnvelope);
    const identities = new Map<
      string,
      { readonly unitId: unknown; readonly taskRef: unknown; readonly attempt: unknown }
    >();
    const requestHashes = new Map<string, string>();
    const revisions = new Map<string, FormalArtifactEnvelope>();
    const byPath = new Map(
      [...stored, ...incoming].map((envelope) => [envelope.artifact_path, envelope]),
    );
    for (const lifecycle of [...stored, ...incoming]) {
      const document = lifecycle.document;
      const lifecycleId = canonicalLaneLifecycleId(document);
      const lifecyclePath = canonicalLaneLifecyclePath(document, Number(document.revision));
      if (document.lifecycle_id !== lifecycleId || lifecycle.artifact_path !== lifecyclePath) {
        throw new StoreError(
          "artifact.lifecycle_identity_invalid",
          "Lane Lifecycle id and path must be the canonical execution-attempt identity",
          {
            artifactPath: lifecycle.artifact_path,
            expectedLifecycleId: lifecycleId,
            lifecyclePath,
          },
        );
      }
      if (document.revision === 1 && document.parent_lifecycle_ref !== null) {
        throw new StoreError(
          "artifact.lifecycle_root_invalid",
          "Lane Lifecycle revision one must have no parent",
          { artifactPath: lifecycle.artifact_path },
        );
      }
      if (Number(document.revision) > 1) {
        const expectedParentRef = canonicalLaneLifecyclePath(
          document,
          Number(document.revision) - 1,
        );
        const parent = byPath.get(expectedParentRef);
        if (
          document.parent_lifecycle_ref !== expectedParentRef ||
          parent?.artifact_type !== "startup_opportunity.lane_lifecycle.v1" ||
          Number(parent.document.revision) + 1 !== Number(document.revision) ||
          parent.document.lifecycle_id !== document.lifecycle_id ||
          parent.document.run_id !== document.run_id ||
          parent.document.unit_id !== document.unit_id ||
          parent.document.attempt !== document.attempt ||
          parent.document.execution_attempt_id !== document.execution_attempt_id ||
          parent.document.dispatch_batch_ref !== document.dispatch_batch_ref ||
          parent.document.dispatch_batch_hash !== document.dispatch_batch_hash ||
          parent.document.task_ref !== document.task_ref ||
          parent.document.task_id !== document.task_id ||
          parent.document.launch_registration_ref !== document.launch_registration_ref ||
          parent.document.launch_registration_id !== document.launch_registration_id ||
          parent.document.launch_registration_hash !== document.launch_registration_hash
        ) {
          throw new StoreError(
            "artifact.lifecycle_parent_invalid",
            "Lane Lifecycle revisions must preserve the exact canonical parent and launch provenance",
            { artifactPath: lifecycle.artifact_path, expectedParentRef },
          );
        }
      }
      const revisionKey = `${lifecycleId}:${String(document.revision)}`;
      const priorRevision = revisions.get(revisionKey);
      if (
        priorRevision !== undefined &&
        (priorRevision.artifact_path !== lifecycle.artifact_path ||
          priorRevision.content_hash !== lifecycle.content_hash)
      ) {
        throw new StoreError(
          "artifact.lifecycle_revision_conflict",
          "one lifecycle identity can publish only one immutable document per revision",
          { lifecycleId, revision: document.revision },
        );
      }
      revisions.set(revisionKey, lifecycle);
      const executionAttemptId = String(document.execution_attempt_id ?? "");
      const identity = {
        unitId: document.unit_id,
        taskRef: document.task_ref,
        attempt: document.attempt,
      };
      const priorIdentity = identities.get(executionAttemptId);
      if (priorIdentity !== undefined && canonicalJson(priorIdentity) !== canonicalJson(identity)) {
        throw new StoreError(
          "artifact.lifecycle_execution_attempt_conflict",
          "one execution attempt id cannot identify different Dispatch tasks",
          { executionAttemptId, priorIdentity, identity },
        );
      }
      identities.set(executionAttemptId, identity);
      if (typeof document.launch_registration_id !== "string") continue;
      const registrationId = document.launch_registration_id;
      const registrationHash = String(document.launch_registration_hash ?? "");
      const priorHash = requestHashes.get(registrationId);
      if (priorHash !== undefined && priorHash !== registrationHash) {
        throw new StoreError(
          "artifact.lifecycle_launch_request_conflict",
          "one launch registration id cannot identify different request content",
          { registrationId, priorHash, registrationHash },
        );
      }
      requestHashes.set(registrationId, registrationHash);
    }
  }

  private async registeredDispatchLaunchLifecycleRefsLocked(
    runRoot: string,
    manifest: RunManifest,
  ): Promise<ReadonlySet<string>> {
    const tracked = new Set(manifest.artifact_refs);
    const stored = (await this.artifacts.listFormalDocuments(runRoot))
      .filter(
        (entry) =>
          tracked.has(entry.path) &&
          entry.document.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION,
      )
      .map((entry) => entry.document as FormalArtifactEnvelope);
    const byPath = new Map(stored.map((envelope) => [envelope.artifact_path, envelope]));
    const authorized = new Set<string>();
    for (const registration of stored.filter(
      (envelope) =>
        envelope.artifact_type === "startup_opportunity.dispatch_launch_registration.v1",
    )) {
      const document = registration.document;
      const expectedPath = dispatchLaunchRegistrationPath(String(document.registration_id));
      const authority = await this.artifacts.dispatchLaunchBundleAuthorityLocked(
        runRoot,
        manifest.run_id,
        registration.artifact_path,
        tracked,
      );
      if (
        registration.artifact_path !== expectedPath ||
        document.run_id !== manifest.run_id ||
        document.request_hash !==
          canonicalContentHash(dispatchLaunchRequestFromRegistration(document)) ||
        authority === null
      ) {
        throw new StoreError(
          "artifact.dispatch_launch_registration_authority_invalid",
          "stored launch registration lacks its exact dedicated Store publication authority",
          { registrationRef: registration.artifact_path },
        );
      }
      const authorityPaths = new Set(authority.map((envelope) => envelope.artifact_path));
      const items = Array.isArray(document.registrations)
        ? document.registrations.filter(isRecord)
        : [];
      if (authority.length !== items.length + 1) {
        throw new StoreError(
          "artifact.dispatch_launch_registration_authority_invalid",
          "launch registration bundle membership differs from its exact registered roots",
          { registrationRef: registration.artifact_path },
        );
      }
      for (const item of items) {
        const lifecycleRef = String(item.lifecycle_ref ?? "");
        const lifecycle = byPath.get(lifecycleRef);
        if (
          !authorityPaths.has(lifecycleRef) ||
          lifecycle?.artifact_type !== "startup_opportunity.lane_lifecycle.v1" ||
          lifecycle.content_hash !== item.lifecycle_hash ||
          lifecycle.document.revision !== 1 ||
          lifecycle.document.parent_lifecycle_ref !== null ||
          lifecycle.document.launch_registration_ref !== registration.artifact_path ||
          lifecycle.document.launch_registration_id !== document.registration_id ||
          lifecycle.document.launch_registration_hash !== document.request_hash ||
          lifecycle.document.unit_id !== item.unit_id ||
          lifecycle.document.task_ref !== item.task_ref ||
          lifecycle.document.task_id !== item.task_id ||
          lifecycle.document.attempt !== item.attempt ||
          lifecycle.document.execution_attempt_id !== item.execution_attempt_id ||
          lifecycle.document.lifecycle_id !== canonicalLaneLifecycleId(lifecycle.document) ||
          lifecycle.artifact_path !== canonicalLaneLifecyclePath(lifecycle.document, 1)
        ) {
          throw new StoreError(
            "artifact.dispatch_launch_registration_authority_invalid",
            "launch registration does not resolve one exact canonical lifecycle root",
            { registrationRef: registration.artifact_path, lifecycleRef },
          );
        }
        authorized.add(lifecycleRef);
      }
    }
    return authorized;
  }

  async registeredDispatchLaunchLifecycleRefs(runId: string): Promise<readonly string[]> {
    await this.assertCurrentLeaf(runId);
    const runRoot = await openRunDirectoryReadOnly(this.runsRoot, runId);
    return withRunLock(runRoot, async () => {
      const manifest = await this.readManifest(runRoot);
      return [
        ...(await this.registeredDispatchLaunchLifecycleRefsLocked(runRoot, manifest)),
      ].sort();
    });
  }

  private async assertDispatchLaunchClosureLocked(
    runRoot: string,
    manifest: RunManifest,
    envelopes: readonly FormalArtifactEnvelope[],
    downstreamTypes: ReadonlySet<string>,
  ): Promise<void> {
    if (!envelopes.some((envelope) => downstreamTypes.has(envelope.artifact_type))) return;
    const stored = (await this.artifacts.listFormalDocuments(runRoot))
      .filter(
        (entry) =>
          manifest.artifact_refs.includes(entry.path) &&
          entry.document.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION,
      )
      .map((entry) => entry.document as FormalArtifactEnvelope);
    const all = [...stored, ...envelopes];
    const authorizedLifecycleRefs = await this.registeredDispatchLaunchLifecycleRefsLocked(
      runRoot,
      manifest,
    );
    const disposed = new Set([
      ...manifest.completed_units,
      ...manifest.failed_units,
      ...manifest.invalidated_units,
      ...manifest.skipped_units,
      ...manifest.cancelled_units,
      ...manifest.superseded_units,
    ]);
    const unresolved: { readonly dispatchRef: string; readonly unitId: string }[] = [];
    for (const dispatch of all.filter(
      (envelope) =>
        envelope.document.launch_registration_required === true &&
        [
          "startup_opportunity.dispatch_batch.discovery.current",
          "startup_opportunity.dispatch_batch.assessment.current",
        ].includes(envelope.artifact_type),
    )) {
      for (const task of Array.isArray(dispatch.document.tasks)
        ? dispatch.document.tasks.filter(isRecord)
        : []) {
        const unitId = String(task.unit_id ?? "");
        const dispatchTaskRef = `${dispatch.artifact_path}#${String(task.task_id)}`;
        const started = stored.some(
          (lifecycle) =>
            authorizedLifecycleRefs.has(lifecycle.artifact_path) &&
            lifecycle.document.dispatch_batch_ref === dispatchTaskRef &&
            lifecycle.document.dispatch_batch_hash === dispatch.content_hash &&
            lifecycle.document.unit_id === unitId &&
            lifecycle.document.state !== "dispatch_requested",
        );
        if (!started && !disposed.has(unitId)) {
          unresolved.push({ dispatchRef: dispatch.artifact_path, unitId });
        }
      }
    }
    if (unresolved.length > 0) {
      throw new StoreError(
        "run.transition_dispatch_launch_open",
        "downstream closure cannot silently bypass Dispatch lanes without a launch registration or formal disposition",
        {
          unresolved: unresolved.sort(
            (left, right) =>
              left.dispatchRef.localeCompare(right.dispatchRef) ||
              left.unitId.localeCompare(right.unitId),
          ),
        },
      );
    }
  }

  private async researchTaskPublicationMode(
    runRoot: string,
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
  ): Promise<"not_task" | "transition" | "replay"> {
    const isCurrentEnvelope = isCurrentEnvelopeSchema(envelope.schema_version);
    const isAssessmentTask =
      isCurrentEnvelope &&
      envelope.artifact_type === "startup_opportunity.research_task.assessment.current";
    const isDiscoveryTask =
      isCurrentEnvelope &&
      envelope.artifact_type === "startup_opportunity.research_task.discovery_candidate.current";
    const isEnrichmentTask =
      isCurrentEnvelope &&
      envelope.artifact_type === "startup_opportunity.research_task.discovery_evaluation.current";
    if (!isAssessmentTask && !isDiscoveryTask && !isEnrichmentTask) {
      return "not_task";
    }
    const unitId = envelope.document.unit_id;
    const researchPlanRef = envelope.document.research_plan_ref;
    if (typeof unitId !== "string" || typeof researchPlanRef !== "string") {
      return "transition";
    }
    const statusFields = [
      "completed_units",
      "active_units",
      "failed_units",
      "invalidated_units",
      "skipped_units",
      "cancelled_units",
      "superseded_units",
    ] as const;
    const existingState = statusFields.find((field) => manifest[field].includes(unitId));
    if (existingState === undefined) {
      if (manifest.current_plan_ref !== researchPlanRef) {
        throw new StoreError(
          "artifact.task_transition_invalid",
          "research task must activate a pending unit in the current immutable Research Plan",
          {
            unitId,
            currentPlanRef: manifest.current_plan_ref,
            taskPlanRef: researchPlanRef,
          },
        );
      }
      if (isEnrichmentTask) {
        await this.assertEnrichmentTaskPlanUnit(runRoot, manifest, envelope);
      }
      return "transition";
    }
    if (!manifest.artifact_refs.includes(envelope.artifact_path)) {
      throw new StoreError(
        "artifact.task_transition_invalid",
        "research task publication only permits pending-to-active or exact replay",
        { unitId, existingState },
      );
    }
    let persisted: unknown;
    try {
      persisted = JSON.parse(
        await readFile(await resolveRunPath(runRoot, envelope.artifact_path), "utf8"),
      ) as unknown;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new StoreError(
          "artifact.task_transition_invalid",
          "research task replay target is missing",
          { unitId, existingState, artifactPath: envelope.artifact_path },
        );
      }
      throw error;
    }
    if (canonicalJson(persisted) !== canonicalJson(envelope)) {
      throw new StoreError(
        "artifact.task_transition_invalid",
        "research task replay must match the immutable published envelope",
        { unitId, existingState, artifactPath: envelope.artifact_path },
      );
    }
    return "replay";
  }

  private assertAtomicDispatchWaveBundle(
    manifest: RunManifest,
    envelopes: readonly FormalArtifactEnvelope[],
  ): void {
    const dispatches = envelopes.filter(
      (envelope) =>
        [
          "startup_opportunity.dispatch_batch.discovery.current",
          "startup_opportunity.dispatch_batch.assessment.current",
        ].includes(envelope.artifact_type) &&
        !manifest.artifact_refs.includes(envelope.artifact_path),
    );
    const canonicalTasks = envelopes.filter((envelope) =>
      [
        "startup_opportunity.research_task.discovery_candidate.current",
        "startup_opportunity.research_task.discovery_evaluation.current",
      ].includes(envelope.artifact_type),
    );
    const newCanonicalTasks = canonicalTasks.filter(
      (task) => !manifest.artifact_refs.includes(task.artifact_path),
    );
    if (dispatches.length === 0 && newCanonicalTasks.length > 0) {
      throw new StoreError(
        "artifact.wave_bundle_incomplete",
        "new canonical discovery tasks require their Dispatch in the same whole-wave bundle",
        { taskPaths: newCanonicalTasks.map((task) => task.artifact_path).sort() },
      );
    }
    const claimedTaskPaths = new Set<string>();
    for (const dispatch of dispatches) {
      const expectedExecutionType =
        dispatch.artifact_type === "startup_opportunity.dispatch_batch.discovery.current"
          ? "startup_opportunity.research_execution_plan.discovery.current"
          : "startup_opportunity.research_execution_plan.assessment.current";
      const executionMatches = envelopes.filter(
        (envelope) =>
          envelope.artifact_path === dispatch.document.execution_plan_ref &&
          envelope.artifact_type === expectedExecutionType,
      );
      if (executionMatches.length !== 1) {
        throw new StoreError(
          "artifact.wave_bundle_incomplete",
          "each new Dispatch requires its exact execution overlay in the same whole-wave bundle",
          {
            dispatchPath: dispatch.artifact_path,
            executionPlanRef: dispatch.document.execution_plan_ref,
            executionOverlayCount: executionMatches.length,
          },
        );
      }
      if (dispatch.artifact_type !== "startup_opportunity.dispatch_batch.discovery.current") {
        continue;
      }
      const dispatchedTasks = (
        Array.isArray(dispatch.document.tasks) ? dispatch.document.tasks : []
      )
        .filter(isRecord)
        .filter(
          (task) =>
            task.required_artifact_schema === "startup_opportunity.discovery_lane_result.v1" ||
            task.required_artifact_schema ===
              "startup_opportunity.discovery_generation_result.v1" ||
            task.required_artifact_schema === "startup_opportunity.enrichment_branch_result.v1",
        );
      for (const dispatched of dispatchedTasks) {
        const matches = canonicalTasks.filter(
          (task) =>
            !claimedTaskPaths.has(task.artifact_path) &&
            task.document.unit_id === dispatched.unit_id,
        );
        if (matches.length !== 1) {
          throw new StoreError(
            "artifact.wave_bundle_incomplete",
            "each discovery dispatch unit requires exactly one canonical task in the same bundle",
            {
              dispatchPath: dispatch.artifact_path,
              unitId: dispatched.unit_id,
              canonicalTaskCount: matches.length,
            },
          );
        }
        const task = matches[0] as FormalArtifactEnvelope;
        const mismatches = [
          ["task_id", dispatched.task_id, task.document.task_id],
          ["unit_id", dispatched.unit_id, task.document.unit_id],
          [
            "research_plan_ref",
            dispatch.document.research_plan_ref,
            task.document.research_plan_ref,
          ],
          ["research_goal", dispatched.research_goal, task.document.research_goal],
          [
            "allowed_output_path",
            dispatched.allowed_output_path,
            task.document.allowed_output_path,
          ],
          [
            "required_artifact_schema",
            dispatched.required_artifact_schema,
            task.document.required_artifact_schema,
          ],
          [
            "incumbent_response_assignment",
            dispatched.incumbent_response_assignment,
            isRecord(task.document.commercial_research_requirements)
              ? task.document.commercial_research_requirements.incumbent_response_assignment
              : undefined,
          ],
        ].flatMap(([field, expected, actual]) =>
          canonicalJson(expected) === canonicalJson(actual) ? [] : [field],
        );
        const dispatchInputs = Array.isArray(dispatched.input_refs)
          ? dispatched.input_refs.filter((value): value is string => typeof value === "string")
          : [];
        const taskInputs = Array.isArray(task.document.input_refs)
          ? task.document.input_refs.filter((value): value is string => typeof value === "string")
          : [];
        if (canonicalJson([...dispatchInputs].sort()) !== canonicalJson([...taskInputs].sort())) {
          mismatches.push("input_refs");
        }
        if (mismatches.length > 0) {
          throw new StoreError(
            "artifact.wave_task_mismatch",
            "canonical task differs from its dispatch fragment",
            {
              dispatchPath: dispatch.artifact_path,
              taskPath: task.artifact_path,
              unitId: dispatched.unit_id,
              mismatches,
            },
          );
        }
        claimedTaskPaths.add(task.artifact_path);
      }
    }
    const unclaimedTaskPaths = newCanonicalTasks
      .filter((task) => !claimedTaskPaths.has(task.artifact_path))
      .map((task) => task.artifact_path)
      .sort();
    if (unclaimedTaskPaths.length > 0) {
      throw new StoreError(
        "artifact.wave_bundle_incomplete",
        "every new canonical discovery task must be uniquely claimed by a Dispatch in the same whole-wave bundle",
        { taskPaths: unclaimedTaskPaths },
      );
    }
  }

  private async assertEnrichmentTaskPlanUnit(
    runRoot: string,
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
  ): Promise<void> {
    const planRef = manifest.current_plan_ref;
    let storedPlan: unknown;
    try {
      storedPlan =
        planRef === null
          ? null
          : (JSON.parse(await readFile(await resolveRunPath(runRoot, planRef), "utf8")) as unknown);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        storedPlan = null;
      } else {
        throw error;
      }
    }
    const plan =
      isRecord(storedPlan) &&
      isCurrentEnvelopeSchema(storedPlan.schema_version) &&
      isRecord(storedPlan.document)
        ? storedPlan.document
        : storedPlan;
    const unitId = envelope.document.unit_id;
    let binding: { readonly waveId: unknown; readonly unit: Record<string, unknown> } | null = null;
    if (isRecord(plan) && Array.isArray(plan.waves)) {
      for (const wave of plan.waves) {
        if (!isRecord(wave) || !Array.isArray(wave.units)) {
          continue;
        }
        const unit = wave.units.find(
          (candidate) => isRecord(candidate) && candidate.unit_id === unitId,
        );
        if (isRecord(unit)) {
          binding = { waveId: wave.wave_id, unit };
          break;
        }
      }
    }
    const exactFields: readonly [string, string][] = [
      ["wave_id", "waveId"],
      ["unit_type", "unit_type"],
      ["research_goal", "research_goal"],
      ["attempt", "attempt"],
      ["agent_role", "agent_role"],
      ["allowed_output_path", "output_path"],
      ["required_artifact_schema", "required_artifact_schema"],
    ];
    const mismatchFields = exactFields
      .filter(
        ([taskField, unitField]) =>
          envelope.document[taskField] !==
          (unitField === "waveId" ? binding?.waveId : binding?.unit[unitField]),
      )
      .map(([taskField]) => taskField);
    const taskInputs = Array.isArray(envelope.document.input_refs)
      ? envelope.document.input_refs.filter((value): value is string => typeof value === "string")
      : [];
    const unitInputs = Array.isArray(binding?.unit.input_refs)
      ? binding.unit.input_refs.filter((value): value is string => typeof value === "string")
      : [];
    if (
      !isRecord(plan) ||
      plan.schema_version !== "startup_opportunity.research_plan.v1" ||
      binding === null ||
      binding.unit.plan_disposition !== "enabled" ||
      mismatchFields.length > 0 ||
      canonicalJson([...taskInputs].sort()) !== canonicalJson([...unitInputs].sort())
    ) {
      throw new StoreError(
        "artifact.task_plan_unit_mismatch",
        "enrichment task must match one enabled unit in the current immutable Research Plan",
        {
          unitId,
          planRef,
          planDisposition: binding?.unit.plan_disposition ?? null,
          mismatchFields,
        },
      );
    }
  }

  async checkpoint(input: CheckpointRunInput): Promise<CheckpointRunResult> {
    await this.assertCurrentLeaf(input.runId);
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, () => this.checkpointLocked(runRoot, input));
  }

  async recordRuntimeOperationObservation(input: RuntimeOperationObservationInput): Promise<void> {
    await this.assertCurrentLeaf(input.runId);
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    await withRunLock(runRoot, async () => {
      const events = await this.logs.listValidatedRecords(runRoot, input.runId, "events.jsonl");
      const attempt =
        events.filter(
          (event) =>
            event.event_type === "runtime_operation_observed" &&
            isRecord(event.operation_observation) &&
            event.operation_observation.operation === "runtime_compile_publish" &&
            event.operation_observation.operation_id === input.operationId,
        ).length + 1;
      const identity = {
        run_id: input.runId,
        operation: "runtime_compile_publish",
        operation_id: input.operationId,
        attempt,
      };
      const event = {
        schema_version: "startup_opportunity.event.v1",
        event_id: `runtime_operation_${sha256Hex(sha256Bytes(canonicalJson(identity)))}`,
        run_id: input.runId,
        event_type: "runtime_operation_observed",
        timestamp: input.completedAt,
        actor: "harness",
        reason:
          input.outcome === "published"
            ? "The declarative Runtime published the validated compilation request."
            : `The declarative Runtime attempt failed with ${input.errorCode ?? "an unclassified error"}.`,
        artifact_refs: [...new Set(input.artifactRefs)].sort(),
        operation_observation: {
          operation: "runtime_compile_publish",
          operation_id: input.operationId,
          attempt,
          started_at: input.startedAt,
          completed_at: input.completedAt,
          duration_ms: Math.max(0, input.durationMs),
          outcome: input.outcome,
          failure_classification: input.failureClassification,
          error_code: input.errorCode,
        },
      };
      await this.assertRecordRefsExist(runRoot, event);
      await this.logs.appendValidated(runRoot, input.runId, "events.jsonl", event);
    });
  }

  async runtimeOperationNeedsCompletionObservation(
    runId: string,
    operationId: string,
  ): Promise<boolean> {
    const runRoot = await openRunDirectoryReadOnly(this.runsRoot, runId);
    const events = await this.logs.listValidatedRecords(runRoot, runId, "events.jsonl");
    const outcomes = events.flatMap((event) => {
      const observation = isRecord(event.operation_observation)
        ? event.operation_observation
        : null;
      return event.event_type === "runtime_operation_observed" &&
        observation?.operation === "runtime_compile_publish" &&
        observation.operation_id === operationId &&
        typeof observation.outcome === "string"
        ? [observation.outcome]
        : [];
    });
    return outcomes.includes("failed") && !outcomes.includes("published");
  }

  async appendEvent(
    runId: string,
    event: Record<string, unknown>,
    suppliedOperationKey?: string,
  ): Promise<"appended" | "idempotent_replay"> {
    await this.assertCurrentLeaf(runId);
    const runRoot = await openRunDirectory(this.runsRoot, runId);
    return withRunLock(runRoot, async () => {
      await this.assertRecordRefsExist(runRoot, event);
      return this.logs.appendValidated(runRoot, runId, "events.jsonl", event, suppliedOperationKey);
    });
  }

  async appendDecision(
    runId: string,
    decision: Record<string, unknown>,
    suppliedOperationKey?: string,
  ): Promise<"appended" | "idempotent_replay"> {
    if (
      decision.decision_type === "scope_proposed" ||
      decision.decision_type === "scope_assumption_confirmed" ||
      decision.decision_type === "scope_changed_by_user" ||
      decision.decision_type === "prior_input_admitted" ||
      decision.decision_type === "prior_input_consumed" ||
      decision.decision_type === "research_handoff_consumed" ||
      decision.decision_type === "subject_reformed"
    ) {
      throw new StoreError(
        decision.decision_type === "subject_reformed"
          ? "run.subject_reformation_dedicated_path_required"
          : decision.decision_type === "prior_input_admitted" ||
              decision.decision_type === "prior_input_consumed" ||
              decision.decision_type === "research_handoff_consumed"
            ? "run.prior_input_dedicated_path_required"
            : "run.scope_confirmation_dedicated_path_required",
        decision.decision_type === "prior_input_admitted"
          ? "prior input admission must use admitPriorInput() so the Store hashes the exact explicitly named source bytes"
          : decision.decision_type === "research_handoff_consumed"
            ? "research handoff consumption must use readResearchHandoff() so the Store freezes its exact provenance boundary before returning bytes"
            : decision.decision_type === "subject_reformed"
              ? "subject reformation must use reformDecisionSubject() so the Store verifies terminal lineage and post-terminal causal inputs"
              : "Scope proposals and confirmations must use the dedicated proposeScope() and confirmScope() paths",
        { decisionType: decision.decision_type },
      );
    }
    await this.assertCurrentLeaf(runId);
    const runRoot = await openRunDirectory(this.runsRoot, runId);
    return withRunLock(runRoot, async () => {
      await this.assertRecordRefsExist(runRoot, decision);
      return this.logs.appendValidated(
        runRoot,
        runId,
        "decisions.jsonl",
        decision,
        suppliedOperationKey,
      );
    });
  }

  async admitPriorInput(input: AdmitPriorInputInput): Promise<AdmitPriorInputResult> {
    await this.assertCurrentLeaf(input.runId);
    validateRunId(input.sourceRunId);
    validateRelativePath(input.sourceArtifactPath);
    validateRelativePath(input.targetArtifactPath);
    const validMapTargets = new Set([
      "artifacts/discovery/seed-probe.r1.json",
      "artifacts/discovery/opportunity-space-map.r1.json",
      "artifacts/discovery/solution-space-map.r1.json",
    ]);
    if (
      !["discovery_maps", "discovery_candidates"].includes(input.consumer) ||
      (input.consumer === "discovery_maps" && !validMapTargets.has(input.targetArtifactPath)) ||
      (input.consumer === "discovery_candidates" &&
        !/^artifacts\/discovery\/candidates\/[A-Za-z0-9._-]+\.r[1-9][0-9]*\.json$/.test(
          input.targetArtifactPath,
        ))
    ) {
      throw new StoreError(
        "prior_input.target_consumer_invalid",
        "prior input consumer must bind one exact current Map or Candidate target artifact path",
        { consumer: input.consumer, targetArtifactPath: input.targetArtifactPath },
      );
    }
    if (input.sourceRunId === input.runId) {
      throw new StoreError(
        "prior_input.source_run_invalid",
        "prior input admission requires an explicitly named different source Run",
        { runId: input.runId, sourceRunId: input.sourceRunId },
      );
    }
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    const sourceRunRoot = await openRunDirectoryReadOnly(this.runsRoot, input.sourceRunId);
    return withRunLock(runRoot, async () => {
      const manifest = await this.readManifest(runRoot);
      await this.assertScopeBindingLocked(runRoot, manifest);
      if (
        manifest.mode !== "opportunity_discovery" ||
        manifest.scope_confirmation_ref === null ||
        manifest.scope_confirmation_hash === null ||
        manifest.current_plan_ref === null
      ) {
        throw new StoreError(
          "prior_input.current_scope_plan_required",
          "prior input admission requires an opportunity-discovery Run with an exact confirmed current Scope and Research Plan",
        );
      }
      if (manifest.artifact_refs.includes(input.targetArtifactPath)) {
        throw new StoreError(
          "prior_input.target_already_published",
          "prior input must be admitted before its unique current target artifact is published",
          { targetArtifactPath: input.targetArtifactPath },
        );
      }
      const sourceBytes = await readFile(
        await resolveRunPath(sourceRunRoot, input.sourceArtifactPath),
      );
      const sourceContentHash = sha256Bytes(sourceBytes);
      const decisionIdentity = {
        run_id: input.runId,
        prior_input_id: input.priorInputId,
        prior_source_run_id: input.sourceRunId,
        prior_source_artifact_path: input.sourceArtifactPath,
        prior_source_content_hash: sourceContentHash,
        prior_target_artifact_path: input.targetArtifactPath,
        prior_input_consumer: input.consumer,
      };
      const decisionId = `prior_input_admitted_${sha256Hex(
        operationKey("prior_input_admission_identity", decisionIdentity),
      ).slice(0, 24)}`;
      const existing = (
        await this.logs.listValidatedRecords(runRoot, input.runId, "decisions.jsonl")
      ).find((record) => record.decision_id === decisionId);
      if (existing !== undefined) {
        if (
          existing.reason !== input.reason ||
          (input.admittedAt !== undefined && existing.timestamp !== input.admittedAt)
        ) {
          throw new StoreError(
            "prior_input.admission_conflict",
            "prior input admission identity is already bound to different provenance metadata",
            { decisionId },
          );
        }
        return {
          schemaVersion: "startup_opportunity.admit_prior_input_result.v1",
          runId: input.runId,
          priorInputId: input.priorInputId,
          decisionRef: `decisions.jsonl#${decisionId}`,
          decisionHash: canonicalContentHash(existing),
          sourceRunId: input.sourceRunId,
          sourceArtifactPath: input.sourceArtifactPath,
          targetArtifactPath: input.targetArtifactPath,
          sourceContentHash,
          consumer: input.consumer,
          useBoundary: "hypothesis_input_only",
          status: "idempotent_replay",
        };
      }
      const decision = {
        schema_version: "startup_opportunity.decision.v1",
        decision_id: decisionId,
        run_id: input.runId,
        decision_type: "prior_input_admitted",
        timestamp: input.admittedAt ?? new Date().toISOString(),
        actor: "main_agent",
        reason: input.reason,
        artifact_refs: [],
        prior_input_id: input.priorInputId,
        prior_source_run_id: input.sourceRunId,
        prior_source_artifact_path: input.sourceArtifactPath,
        prior_source_content_hash: sourceContentHash,
        prior_target_artifact_path: input.targetArtifactPath,
        prior_input_consumer: input.consumer,
        prior_use_boundary: "hypothesis_input_only",
      };
      const status = await this.logs.appendValidated(
        runRoot,
        input.runId,
        "decisions.jsonl",
        decision,
      );
      return {
        schemaVersion: "startup_opportunity.admit_prior_input_result.v1",
        runId: input.runId,
        priorInputId: input.priorInputId,
        decisionRef: `decisions.jsonl#${decisionId}`,
        decisionHash: canonicalContentHash(decision),
        sourceRunId: input.sourceRunId,
        sourceArtifactPath: input.sourceArtifactPath,
        targetArtifactPath: input.targetArtifactPath,
        sourceContentHash,
        consumer: input.consumer,
        useBoundary: "hypothesis_input_only",
        status,
      };
    });
  }

  async readPriorInput(input: ReadPriorInputInput): Promise<ReadPriorInputResult> {
    await this.assertCurrentLeaf(input.runId);
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      const manifest = await this.readManifest(runRoot);
      await this.assertScopeBindingLocked(runRoot, manifest);
      if (
        manifest.mode !== "opportunity_discovery" ||
        manifest.scope_confirmation_ref === null ||
        manifest.current_plan_ref === null
      ) {
        throw new StoreError(
          "prior_input.current_scope_plan_required",
          "prior input reading requires an opportunity-discovery Run with confirmed Scope and a current Plan",
        );
      }
      const admission = await this.logs.readExactRecord(
        runRoot,
        input.runId,
        input.admissionRef,
        "decisions.jsonl",
      );
      if (
        admission.decision_type !== "prior_input_admitted" ||
        admission.actor !== "main_agent" ||
        admission.prior_use_boundary !== "hypothesis_input_only" ||
        typeof admission.prior_source_run_id !== "string" ||
        typeof admission.prior_source_artifact_path !== "string" ||
        typeof admission.prior_source_content_hash !== "string" ||
        typeof admission.prior_target_artifact_path !== "string" ||
        (admission.prior_input_consumer !== "discovery_maps" &&
          admission.prior_input_consumer !== "discovery_candidates")
      ) {
        throw new StoreError(
          "prior_input.admission_invalid",
          "controlled prior input reading requires an exact Store-authored admission decision",
          { admissionRef: input.admissionRef },
        );
      }
      const sourceRunRoot = await openRunDirectoryReadOnly(
        this.runsRoot,
        admission.prior_source_run_id,
      );
      const sourceBytes = await readFile(
        await resolveRunPath(sourceRunRoot, admission.prior_source_artifact_path),
      );
      const sourceContentHash = sha256Bytes(sourceBytes);
      if (sourceContentHash !== admission.prior_source_content_hash) {
        throw new StoreError(
          "prior_input.source_drift",
          "admitted prior input bytes changed before the controlled read",
          {
            admissionRef: input.admissionRef,
            expected: admission.prior_source_content_hash,
            actual: sourceContentHash,
          },
        );
      }
      const admissionHash = canonicalContentHash(admission);
      const decisionId = `prior_input_consumed_${sha256Hex(
        operationKey("prior_input_consumption_identity", {
          run_id: input.runId,
          prior_admission_ref: input.admissionRef,
          prior_admission_hash: admissionHash,
        }),
      ).slice(0, 24)}`;
      const immutableIdentity = {
        prior_input_id: admission.prior_input_id,
        prior_admission_ref: input.admissionRef,
        prior_admission_hash: admissionHash,
        prior_source_run_id: admission.prior_source_run_id,
        prior_source_artifact_path: admission.prior_source_artifact_path,
        prior_source_content_hash: sourceContentHash,
        prior_input_consumer: admission.prior_input_consumer,
        prior_target_artifact_path: admission.prior_target_artifact_path,
        prior_use_boundary: "hypothesis_input_only",
      };
      const existing = (
        await this.logs.listValidatedRecords(runRoot, input.runId, "decisions.jsonl")
      ).find((record) => record.decision_id === decisionId);
      const existingExemptArtifactRefs = Array.isArray(existing?.prior_taint_exempt_artifact_refs)
        ? existing.prior_taint_exempt_artifact_refs.filter(
            (ref): ref is string => typeof ref === "string",
          )
        : null;
      const isDiscoveryArtifactRef = (ref: string): boolean =>
        [
          "artifacts/discovery/seed-probe.r1.json",
          "artifacts/discovery/opportunity-space-map.r1.json",
          "artifacts/discovery/solution-space-map.r1.json",
        ].includes(ref) ||
        /^artifacts\/discovery\/candidates\/[A-Za-z0-9._-]+\.r[1-9][0-9]*\.json$/.test(ref);
      if (
        existing !== undefined &&
        (existing.schema_version !== "startup_opportunity.decision.v1" ||
          existing.run_id !== input.runId ||
          existing.decision_type !== "prior_input_consumed" ||
          existing.actor !== "main_agent" ||
          canonicalJson(existing.artifact_refs) !== canonicalJson([input.admissionRef]) ||
          canonicalJson(
            Object.fromEntries(Object.keys(immutableIdentity).map((key) => [key, existing[key]])),
          ) !== canonicalJson(immutableIdentity) ||
          existingExemptArtifactRefs === null ||
          existingExemptArtifactRefs.length !==
            (existing.prior_taint_exempt_artifact_refs as unknown[]).length ||
          existingExemptArtifactRefs.some((ref) => !isDiscoveryArtifactRef(ref)) ||
          (input.consumedAt !== undefined && existing.timestamp !== input.consumedAt))
      ) {
        throw new StoreError(
          "prior_input.consumption_conflict",
          "prior input consumption identity is already bound to different provenance metadata",
          { decisionId },
        );
      }
      const exemptArtifactRefs =
        existingExemptArtifactRefs ?? manifest.artifact_refs.filter(isDiscoveryArtifactRef).sort();
      const identity = {
        ...immutableIdentity,
        prior_taint_exempt_artifact_refs: exemptArtifactRefs,
      };
      const decision =
        existing ??
        ({
          schema_version: "startup_opportunity.decision.v1",
          decision_id: decisionId,
          run_id: input.runId,
          decision_type: "prior_input_consumed",
          timestamp: input.consumedAt ?? new Date().toISOString(),
          actor: "main_agent",
          reason:
            "Controlled read of an admitted prior input; all later discovery artifacts inherit hypothesis-only provenance.",
          artifact_refs: [input.admissionRef],
          ...identity,
        } satisfies Record<string, unknown>);
      const status =
        existing === undefined
          ? await this.logs.appendValidated(runRoot, input.runId, "decisions.jsonl", decision)
          : "idempotent_replay";
      return {
        schemaVersion: "startup_opportunity.read_prior_input_result.v1",
        runId: input.runId,
        admissionRef: input.admissionRef,
        consumptionDecisionRef: `decisions.jsonl#${decisionId}`,
        consumptionDecisionHash: canonicalContentHash(decision),
        sourceRunId: admission.prior_source_run_id,
        sourceArtifactPath: admission.prior_source_artifact_path,
        sourceContentHash,
        targetArtifactPath: admission.prior_target_artifact_path,
        consumer: admission.prior_input_consumer,
        useBoundary: "hypothesis_input_only",
        sourceText: sourceBytes.toString("utf8"),
        status,
      };
    });
  }

  async createResearchHandoff(
    input: CreateResearchHandoffInput,
  ): Promise<CreateResearchHandoffResult> {
    validateRunId(input.runId);
    validateRunId(input.sourceRunId);
    if (input.runId === input.sourceRunId) {
      throw new StoreError(
        "research_handoff.source_run_invalid",
        "Research handoff source Run must differ from the target Run",
      );
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.handoffId) ||
      input.userAuthorizationAttestation.trim().length === 0 ||
      input.targetPurpose.trim().length === 0 ||
      (input.capturedAt !== undefined &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          input.capturedAt,
        ) ||
          !Number.isFinite(Date.parse(input.capturedAt)))) ||
      (input.faultAt !== undefined &&
        !["after_intent", "after_evidence_imports", "after_handoff_publish"].includes(
          input.faultAt,
        )) ||
      input.items.length === 0
    ) {
      throw new StoreError(
        "research_handoff.request_invalid",
        "Research handoff requires stable ids, explicit user authorization, a target purpose, and at least one item",
      );
    }
    const itemIds = input.items.map((item) => item.itemId);
    const sourcePaths = input.items.map((item) => item.sourceArtifactPath);
    if (
      new Set(itemIds).size !== itemIds.length ||
      new Set(sourcePaths).size !== sourcePaths.length ||
      itemIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))
    ) {
      throw new StoreError(
        "research_handoff.item_identity_invalid",
        "Research handoff item ids and exact source paths must be valid and unique",
      );
    }
    for (const item of input.items) {
      if (
        ![
          "user_authorized_input",
          "reusable_evidence",
          "prior_synthesis",
          "revalidation_required",
        ].includes(item.role) ||
        !isSha256(item.expectedSourceByteHash) ||
        !isSha256(item.expectedSourceContentHash) ||
        !["current", "historical", "unknown"].includes(item.freshnessDisposition) ||
        !["applicable", "partially_applicable", "unknown"].includes(
          item.applicabilityDisposition,
        ) ||
        !["not_required", "required"].includes(item.revalidationStatus) ||
        (["prior_synthesis", "revalidation_required"].includes(item.role) &&
          item.revalidationStatus !== "required") ||
        (item.role === "reusable_evidence" &&
          (item.targetUnitId === undefined ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.targetUnitId) ||
            item.targetResearchGoal === undefined ||
            item.targetResearchGoal.trim().length === 0)) ||
        (item.role === "reusable_evidence" && item.targetArtifactRef !== undefined) ||
        (item.role !== "reusable_evidence" &&
          (item.targetArtifactRef === undefined ||
            item.targetUnitId !== undefined ||
            item.targetResearchGoal !== undefined))
      ) {
        throw new StoreError(
          "research_handoff.item_contract_invalid",
          "Research handoff item role, hashes, dispositions, revalidation, or Evidence target metadata is invalid",
          { itemId: item.itemId },
        );
      }
      if (
        item.targetArtifactRef !== undefined &&
        !isResearchHandoffFormationRef(item.targetArtifactRef)
      ) {
        throw new StoreError(
          "research_handoff.item_contract_invalid",
          "A non-Evidence handoff item must target one supported immutable formation Artifact",
          { itemId: item.itemId, targetArtifactRef: item.targetArtifactRef },
        );
      }
    }
    await this.assertCurrentLeaf(input.runId);
    const targetRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(targetRoot, async () => {
      let manifest = await this.readManifest(targetRoot);
      const scopeState = await this.assertScopeBindingLocked(targetRoot, manifest);
      if (scopeState.confirmation === null) {
        throw new StoreError(
          "research_handoff.target_scope_plan_required",
          "Research handoff requires a confirmed target Scope",
        );
      }
      const handoffRef = `artifacts/research-handoffs/${input.handoffId}.json`;
      const operationsDirectory = await resolveRunPath(targetRoot, ".store/operations", {
        createParents: true,
      });
      const existingIntents: ResearchHandoffOperationIntent[] = [];
      for (const filename of (await readdir(operationsDirectory)).sort()) {
        if (!filename.startsWith("research-handoff-") || !filename.endsWith(".json")) continue;
        const candidate = validateResearchHandoffOperationIntent(
          JSON.parse(
            await readFile(
              await resolveRunPath(targetRoot, `.store/operations/${filename}`),
              "utf8",
            ),
          ) as unknown,
          filename,
          input.runId,
        );
        if (candidate.handoff_ref === handoffRef) existingIntents.push(candidate);
      }
      if (existingIntents.length > 1) {
        throw new StoreError(
          "research_handoff.operation_conflict",
          "Research handoff ref is bound to multiple operation intents",
          { handoffRef },
        );
      }
      const existingIntent = existingIntents[0];
      if (existingIntent !== undefined) {
        const expectedRequest = {
          ...existingIntent.request_identity,
          run_id: input.runId,
          handoff_id: input.handoffId,
          source_run_id: input.sourceRunId,
          user_authorization_attestation: input.userAuthorizationAttestation,
          target_purpose: input.targetPurpose,
          items: input.items,
          ...(input.capturedAt === undefined ? {} : { captured_at: input.capturedAt }),
        };
        if (canonicalJson(existingIntent.request_identity) !== canonicalJson(expectedRequest)) {
          throw new StoreError(
            "research_handoff.operation_conflict",
            "Research handoff ref is already bound to a different immutable request",
            { handoffRef },
          );
        }
        const replayed = await this.replayResearchHandoffIntentLocked(
          targetRoot,
          input.runId,
          existingIntent,
        );
        if (replayed.artifactStatus === null) {
          throw new StoreError(
            "research_handoff.intent_applicability_expired",
            "An uncommitted handoff intent cannot be replayed after its exact target Scope or Plan changed",
            { handoffRef },
          );
        }
        manifest = await this.applyPublishedEnvelope(
          targetRoot,
          manifest,
          existingIntent.envelope,
          false,
          true,
        );
        await this.writeManifest(targetRoot, manifest);
        return {
          schemaVersion: "startup_opportunity.create_research_handoff_result.v1",
          runId: input.runId,
          handoffRef,
          handoffContentHash: existingIntent.envelope.content_hash,
          importedEvidenceRefs: existingIntent.evidence_imports
            .map((entry) => `evidence/manifest.jsonl#${entry.record.evidence_id}`)
            .sort(),
          status: replayed.artifactStatus,
        };
      }
      if (TERMINAL_RUN_STATUSES.has(manifest.status) || manifest.status === "reporting") {
        throw new StoreError(
          "research_handoff.target_terminal",
          "A terminal or reporting Run cannot admit a new cross-Run research handoff",
        );
      }
      const prePlanAssessmentFormation =
        manifest.current_plan_ref === null && manifest.mode === "concept_evidence_assessment";
      let prePlanAssessmentScope: FormalArtifactEnvelope | null = null;
      if (prePlanAssessmentFormation) {
        prePlanAssessmentScope = await this.exactAssessmentPrePlanScopeLocked(targetRoot, manifest);
      } else if (manifest.status === "needs_clarification") {
        throw new StoreError(
          "run.scope_revision_unresolved",
          "A new research handoff is blocked until the confirmed Scope is reconciled through a Plan Revision",
          { scopeRevision: manifest.scope_revision },
        );
      }
      if (manifest.current_plan_ref === null && !prePlanAssessmentFormation) {
        throw new StoreError(
          "research_handoff.target_scope_plan_required",
          "A new research handoff requires the target Run current Research Plan unless it forms the initial Assessment intake Concept",
        );
      }
      const targetFormal = new Map(
        (await this.artifacts.listFormalDocuments(targetRoot)).map((entry) => [entry.path, entry]),
      );
      if (
        prePlanAssessmentFormation &&
        manifest.artifact_refs.includes("concept-hypothesis.json")
      ) {
        throw new StoreError(
          "research_handoff.target_scope_plan_required",
          "A pre-Plan Assessment handoff can only be created before the initial intake Concept",
        );
      }
      if (
        prePlanAssessmentFormation &&
        (input.items.every((item) => item.role === "reusable_evidence") ||
          input.items.some(
            (item) =>
              item.role !== "reusable_evidence" &&
              item.targetArtifactRef !== "concept-hypothesis.json",
          ))
      ) {
        throw new StoreError(
          "research_handoff.item_contract_invalid",
          "A pre-Plan Assessment handoff requires a non-Evidence input bound to the initial intake Concept",
        );
      }
      const scope =
        prePlanAssessmentScope === null
          ? targetFormal.get("scope-frame.json")
          : {
              path: prePlanAssessmentScope.artifact_path,
              document: prePlanAssessmentScope,
            };
      const plan =
        manifest.current_plan_ref === null
          ? undefined
          : targetFormal.get(manifest.current_plan_ref);
      if (
        scope === undefined ||
        ![
          "startup_opportunity.scope_frame.discovery.current",
          "startup_opportunity.scope_frame.assessment.current",
        ].includes(String(scope.document.artifact_type)) ||
        (prePlanAssessmentFormation
          ? scope.document.artifact_type !== "startup_opportunity.scope_frame.assessment.current"
          : plan?.document.artifact_type !== "startup_opportunity.research_plan.v1")
      ) {
        throw new StoreError(
          "research_handoff.target_scope_plan_required",
          "Research handoff target Scope and, when required, Plan must be formal current-Run artifacts",
        );
      }
      const scopeEnvelope = scope.document as FormalArtifactEnvelope;
      const planEnvelope = plan?.document as FormalArtifactEnvelope | undefined;
      await this.artifacts.validateStoredEnvelope(targetRoot, input.runId, scopeEnvelope);
      if (planEnvelope !== undefined) {
        await this.artifacts.validateStoredEnvelope(targetRoot, input.runId, planEnvelope);
      }
      const capturedAt = input.capturedAt ?? new Date().toISOString();
      const requestIdentity = {
        run_id: input.runId,
        handoff_id: input.handoffId,
        source_run_id: input.sourceRunId,
        user_authorization_attestation: input.userAuthorizationAttestation,
        target_purpose: input.targetPurpose,
        captured_at: capturedAt,
        target_formation_stage: prePlanAssessmentFormation
          ? "pre_plan_assessment_formation"
          : "plan_bound",
        target_scope_ref: scopeEnvelope.artifact_path,
        target_scope_hash: scopeEnvelope.content_hash,
        target_scope_revision: manifest.scope_revision,
        target_scope_confirmation_ref: manifest.scope_confirmation_ref,
        target_scope_confirmation_hash: manifest.scope_confirmation_hash,
        target_plan_ref: planEnvelope?.artifact_path ?? null,
        target_plan_hash: planEnvelope?.content_hash ?? null,
        items: input.items,
      };
      const handoffOperationKey = operationKey("create_research_handoff", requestIdentity);
      const intentPath = `.store/operations/${researchHandoffOperationFilename(handoffOperationKey)}`;
      const sourceRoot = await openRunDirectoryReadOnly(this.runsRoot, input.sourceRunId);
      await this.readManifest(sourceRoot);
      const sourceFormal = new Map(
        (await this.artifacts.listFormalDocuments(sourceRoot)).map((entry) => [entry.path, entry]),
      );
      const capturedItems: Record<string, unknown>[] = [];
      const evidenceImports: ResearchHandoffOperationIntent["evidence_imports"][number][] = [];
      for (const item of input.items) {
        validateArtifactRef(item.sourceArtifactPath);
        const evidenceSource = item.sourceArtifactPath.startsWith("evidence/manifest.jsonl#");
        if (evidenceSource) {
          const capture = await this.evidence.readExactCapture(
            input.sourceRunId,
            item.sourceArtifactPath,
          );
          const sourceByteHash = sha256Bytes(capture.recordBytes);
          const sourceRecordHash = canonicalContentHash(capture.record);
          if (
            item.role !== "reusable_evidence" ||
            !researchHandoffSourceRoleAllowed(capture.record.schema_version, item.role) ||
            sourceByteHash !== item.expectedSourceByteHash ||
            sourceRecordHash !== item.expectedSourceContentHash ||
            item.targetUnitId === undefined ||
            item.targetResearchGoal === undefined ||
            item.targetUnitId.trim().length === 0 ||
            item.targetResearchGoal.trim().length === 0
          ) {
            throw new StoreError(
              "research_handoff.source_binding_mismatch",
              "Reusable Evidence import must bind exact source record bytes/hash and target unit/goal",
              { itemId: item.itemId },
            );
          }
          const evidenceInput = {
            runId: input.runId,
            unitId: item.targetUnitId,
            source: capture.record.source,
            researchGoal: item.targetResearchGoal,
            rawContent: capture.rawBytes,
            recordedAt: capturedAt,
            handoffBinding: {
              handoff_ref: handoffRef,
              handoff_item_id: item.itemId,
              source_run_id: input.sourceRunId,
              source_evidence_path: item.sourceArtifactPath,
              source_record_hash: sourceRecordHash,
              source_raw_content_hash: capture.record.content_hash,
              source_recorded_at: capture.record.recorded_at,
              freshness_disposition: item.freshnessDisposition,
              applicability_disposition: item.applicabilityDisposition,
              revalidation_status: item.revalidationStatus,
            },
          } as const;
          const imported = prepareEvidenceRecord(evidenceInput);
          const targetEvidenceRef = `evidence/manifest.jsonl#${imported.record.evidence_id}`;
          evidenceImports.push({
            record: imported.record,
            raw_content_base64: Buffer.from(imported.rawBytes).toString("base64"),
          });
          capturedItems.push({
            item_id: item.itemId,
            source_kind: "evidence_substrate",
            source_artifact_path: item.sourceArtifactPath,
            source_schema_version: capture.record.schema_version,
            source_byte_hash: sourceByteHash,
            source_record_hash: sourceRecordHash,
            source_content_hash: capture.record.content_hash,
            source_raw_content_hash: capture.record.content_hash,
            source_captured_at: capturedAt,
            source_payload_encoding: "base64",
            source_payload_base64: Buffer.from(capture.recordBytes).toString("base64"),
            role: item.role,
            decision_boundary: "evidence_reuse_with_current_weighting",
            freshness_disposition: item.freshnessDisposition,
            applicability_disposition: item.applicabilityDisposition,
            revalidation_status: item.revalidationStatus,
            target_unit_id: item.targetUnitId,
            target_research_goal: item.targetResearchGoal,
            target_artifact_ref: null,
            target_evidence_ref: targetEvidenceRef,
            target_evidence_record_hash: canonicalContentHash(imported.record),
          });
          continue;
        }
        if (item.role === "reusable_evidence") {
          throw new StoreError(
            "research_handoff.role_mismatch",
            "Reusable Evidence role requires an exact source Evidence substrate record",
            { itemId: item.itemId },
          );
        }
        const parsed = validateArtifactRef(item.sourceArtifactPath);
        const sourceEntry = sourceFormal.get(parsed.path);
        if (sourceEntry === undefined) {
          throw new StoreError("research_handoff.source_missing", "source artifact is missing", {
            itemId: item.itemId,
            sourcePath: item.sourceArtifactPath,
          });
        }
        const sourceEnvelope = sourceEntry.document as FormalArtifactEnvelope;
        await this.artifacts.validateStoredEnvelope(sourceRoot, input.sourceRunId, sourceEnvelope);
        const sourceBytes = await readFile(await resolveRunPath(sourceRoot, parsed.path));
        const sourceByteHash = sha256Bytes(sourceBytes);
        if (
          parsed.fragment !== null ||
          !researchHandoffSourceRoleAllowed(sourceEnvelope.artifact_type, item.role) ||
          sourceByteHash !== item.expectedSourceByteHash ||
          sourceEnvelope.content_hash !== item.expectedSourceContentHash
        ) {
          throw new StoreError(
            "research_handoff.source_binding_mismatch",
            "Formal handoff source must bind exact whole-artifact bytes and content hash",
            { itemId: item.itemId },
          );
        }
        capturedItems.push({
          item_id: item.itemId,
          source_kind: "formal_artifact",
          source_artifact_path: item.sourceArtifactPath,
          source_schema_version: sourceEnvelope.artifact_type,
          source_byte_hash: sourceByteHash,
          source_record_hash: canonicalContentHash(sourceEnvelope),
          source_content_hash: sourceEnvelope.content_hash,
          source_raw_content_hash: null,
          source_captured_at: capturedAt,
          source_payload_encoding: "base64",
          source_payload_base64: sourceBytes.toString("base64"),
          role: item.role,
          decision_boundary: "hypothesis_input_only",
          freshness_disposition: item.freshnessDisposition,
          applicability_disposition: item.applicabilityDisposition,
          revalidation_status: item.revalidationStatus,
          target_unit_id: null,
          target_research_goal: null,
          target_artifact_ref: item.targetArtifactRef,
          target_evidence_ref: null,
          target_evidence_record_hash: null,
        });
      }
      const document = {
        schema_version: "startup_opportunity.research_handoff.current",
        handoff_id: input.handoffId,
        run_id: input.runId,
        source_run_id: input.sourceRunId,
        target_formation_stage: requestIdentity.target_formation_stage,
        target_scope_ref: scopeEnvelope.artifact_path,
        target_scope_hash: scopeEnvelope.content_hash,
        target_scope_revision: requestIdentity.target_scope_revision,
        target_scope_confirmation_ref: requestIdentity.target_scope_confirmation_ref,
        target_scope_confirmation_hash: requestIdentity.target_scope_confirmation_hash,
        target_plan_ref: requestIdentity.target_plan_ref,
        target_plan_hash: requestIdentity.target_plan_hash,
        user_authorization_attestation: input.userAuthorizationAttestation,
        target_purpose: input.targetPurpose,
        captured_at: capturedAt,
        items: capturedItems.sort((left, right) =>
          String(left.item_id).localeCompare(String(right.item_id)),
        ),
      };
      const envelope: FormalArtifactEnvelope = {
        schema_version: ARTIFACT_ENVELOPE_SCHEMA_VERSION,
        artifact_type: "startup_opportunity.research_handoff.current",
        artifact_path: handoffRef,
        run_id: input.runId,
        created_at: capturedAt,
        producer_role: "harness",
        input_refs: [
          scopeEnvelope.artifact_path,
          ...(planEnvelope ? [planEnvelope.artifact_path] : []),
        ].sort(),
        content_hash: canonicalContentHash(document),
        document,
      };
      const intent: ResearchHandoffOperationIntent = {
        schema_version: "startup_opportunity.research_handoff_operation.current",
        operation_key: handoffOperationKey,
        run_id: input.runId,
        handoff_ref: handoffRef,
        request_identity: requestIdentity,
        envelope,
        evidence_imports: evidenceImports,
      };
      validateResearchHandoffOperationIntent(intent, path.basename(intentPath), input.runId);
      const intentTemp = `.store/temp/research-handoff-${sha256Hex(handoffOperationKey)}.tmp`;
      await writeSyncedTemp(targetRoot, intentTemp, `${canonicalJson(intent)}\n`);
      await publishTemp(targetRoot, intentTemp, intentPath);
      if (input.faultAt === "after_intent") {
        throw new StoreError("fault.injected", "injected failure after research handoff intent");
      }
      for (const evidenceImport of evidenceImports) {
        const handoffBinding = evidenceImport.record.handoff_binding;
        if (handoffBinding === undefined) {
          throw new StoreError(
            "recovery.invalid_research_handoff_operation",
            "Research handoff Evidence import is missing its immutable binding",
          );
        }
        await this.evidence.recordResearchHandoffImportLocked(targetRoot, {
          runId: input.runId,
          unitId: evidenceImport.record.unit_id,
          source: evidenceImport.record.source,
          researchGoal: evidenceImport.record.research_goal,
          rawContent: Buffer.from(evidenceImport.raw_content_base64, "base64"),
          recordedAt: evidenceImport.record.recorded_at,
          operationKey: evidenceImport.record.operation_key,
          handoffBinding,
        });
      }
      if (input.faultAt === "after_evidence_imports") {
        throw new StoreError(
          "fault.injected",
          "injected failure after research handoff Evidence imports",
        );
      }
      await this.assertTransitionReadyLocked(targetRoot, manifest, [envelope]);
      const planOperationRecovery = await recoverPlanRevisionOperationsLocked(
        targetRoot,
        input.runId,
        this.validator,
        this.artifacts,
        this.logs,
      );
      const published = await this.artifacts.publishResearchHandoffLocked(
        targetRoot,
        { runId: input.runId, envelope },
        {
          historicalDiscoveryPlanBindings: planOperationRecovery.historicalDiscoveryPlanBindings,
        },
      );
      if (input.faultAt === "after_handoff_publish") {
        throw new StoreError(
          "fault.injected",
          "injected failure after research handoff publication",
        );
      }
      manifest = await this.applyPublishedEnvelope(
        targetRoot,
        manifest,
        envelope,
        false,
        published.status === "idempotent_replay",
      );
      await this.writeManifest(targetRoot, manifest);
      return {
        schemaVersion: "startup_opportunity.create_research_handoff_result.v1",
        runId: input.runId,
        handoffRef,
        handoffContentHash: envelope.content_hash,
        importedEvidenceRefs: evidenceImports
          .map((entry) => `evidence/manifest.jsonl#${entry.record.evidence_id}`)
          .sort(),
        status: published.status,
      };
    });
  }

  async readResearchHandoff(input: ReadResearchHandoffInput): Promise<ReadResearchHandoffResult> {
    validateRunId(input.runId);
    validateRelativePath(input.handoffRef);
    await this.assertCurrentLeaf(input.runId);
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      const manifest = await this.readManifest(runRoot);
      const value = JSON.parse(
        await readFile(await resolveRunPath(runRoot, input.handoffRef), "utf8"),
      ) as unknown;
      if (!isRecord(value) || !isCurrentEnvelopeSchema(value.schema_version)) {
        throw new StoreError("research_handoff.invalid", "Research handoff envelope is invalid");
      }
      const envelope = value as FormalArtifactEnvelope;
      await this.artifacts.validateStoredEnvelope(runRoot, input.runId, envelope);
      if (
        envelope.artifact_type !== "startup_opportunity.research_handoff.current" ||
        envelope.artifact_path !== input.handoffRef ||
        envelope.document.run_id !== input.runId
      ) {
        throw new StoreError("research_handoff.invalid", "Research handoff identity is invalid");
      }
      const uniqueItemIds = [...new Set(input.itemIds)].sort();
      if (uniqueItemIds.length === 0 || uniqueItemIds.length !== input.itemIds.length) {
        throw new StoreError(
          "research_handoff.item_selection_invalid",
          "Controlled handoff read requires a non-empty unique item selection",
        );
      }
      const items = records(envelope.document.items);
      const selected = uniqueItemIds.map((itemId) => {
        const item = items.find((candidate) => candidate.item_id === itemId);
        if (item === undefined) {
          throw new StoreError("research_handoff.item_missing", "Handoff item is missing", {
            itemId,
          });
        }
        return item;
      });
      const itemRefs = selected.map((item) => `${input.handoffRef}#${String(item.item_id)}`);
      const targetArtifactRefs = selected
        .flatMap((item) =>
          typeof item.target_artifact_ref === "string" ? [item.target_artifact_ref] : [],
        )
        .sort();
      const decisionId = `research_handoff_consumed_${sha256Hex(
        operationKey("research_handoff_consumption_identity", {
          run_id: input.runId,
          handoff_ref: input.handoffRef,
          handoff_hash: envelope.content_hash,
          item_refs: itemRefs,
        }),
      ).slice(0, 24)}`;
      const existing = (
        await this.logs.listValidatedRecords(runRoot, input.runId, "decisions.jsonl")
      ).find((record) => record.decision_id === decisionId);
      if (existing === undefined) {
        if (TERMINAL_RUN_STATUSES.has(manifest.status) || manifest.status === "reporting") {
          throw new StoreError(
            "research_handoff.consumption_closed",
            "A reporting or terminal Run cannot consume a new research handoff item",
            { handoffRef: input.handoffRef },
          );
        }
        const targetScopeStateMatches =
          manifest.scope_revision === envelope.document.target_scope_revision &&
          manifest.scope_confirmation_ref === envelope.document.target_scope_confirmation_ref &&
          manifest.scope_confirmation_hash === envelope.document.target_scope_confirmation_hash;
        const currentPrePlanAssessmentScope =
          envelope.document.target_formation_stage === "pre_plan_assessment_formation" &&
          manifest.current_plan_ref === null &&
          targetScopeStateMatches
            ? await this.exactAssessmentPrePlanScopeLocked(runRoot, manifest)
            : null;
        if (
          manifest.scope_revision !== envelope.document.target_scope_revision ||
          manifest.scope_confirmation_ref !== envelope.document.target_scope_confirmation_ref ||
          manifest.scope_confirmation_hash !== envelope.document.target_scope_confirmation_hash ||
          manifest.status === "awaiting_scope_confirmation" ||
          (envelope.document.target_formation_stage === "pre_plan_assessment_formation" &&
            (currentPrePlanAssessmentScope === null ||
              currentPrePlanAssessmentScope.artifact_path !== envelope.document.target_scope_ref ||
              currentPrePlanAssessmentScope.content_hash !==
                envelope.document.target_scope_hash)) ||
          (envelope.document.target_formation_stage === "plan_bound" &&
            manifest.current_plan_ref !== envelope.document.target_plan_ref)
        ) {
          throw new StoreError(
            "research_handoff.applicability_expired",
            "A new controlled read requires the handoff's exact confirmed Scope and target Plan",
            { handoffRef: input.handoffRef },
          );
        }
        const alreadyFormed = targetArtifactRefs.filter((ref) =>
          manifest.artifact_refs.includes(ref),
        );
        if (alreadyFormed.length > 0) {
          throw new StoreError(
            "research_handoff.formation_closed",
            "A handoff item must be consumed before its exact target Artifact is formed",
            { targetArtifactRefs: alreadyFormed },
          );
        }
      }
      if (
        existing === undefined &&
        envelope.document.target_formation_stage === "pre_plan_assessment_formation" &&
        manifest.artifact_refs.includes("concept-hypothesis.json")
      ) {
        throw new StoreError(
          "research_handoff.intake_formation_closed",
          "A pre-Plan Assessment handoff must be read before the initial intake Concept is published",
          { handoffRef: input.handoffRef },
        );
      }
      const immutableIdentity = {
        research_handoff_ref: input.handoffRef,
        research_handoff_hash: envelope.content_hash,
        research_handoff_item_refs: itemRefs,
        research_handoff_target_artifact_refs: targetArtifactRefs,
      };
      if (
        existing !== undefined &&
        (existing.schema_version !== "startup_opportunity.decision.v1" ||
          existing.run_id !== input.runId ||
          existing.decision_type !== "research_handoff_consumed" ||
          existing.actor !== "main_agent" ||
          canonicalJson(existing.artifact_refs) !== canonicalJson(itemRefs) ||
          canonicalJson(
            Object.fromEntries(Object.keys(immutableIdentity).map((key) => [key, existing[key]])),
          ) !== canonicalJson(immutableIdentity) ||
          (input.consumedAt !== undefined && existing.timestamp !== input.consumedAt))
      ) {
        throw new StoreError(
          "research_handoff.consumption_conflict",
          "research handoff consumption is already bound to different immutable provenance",
          { decisionId },
        );
      }
      const decision =
        existing ??
        ({
          schema_version: "startup_opportunity.decision.v1",
          decision_id: decisionId,
          run_id: input.runId,
          decision_type: "research_handoff_consumed",
          timestamp: input.consumedAt ?? new Date().toISOString(),
          actor: "main_agent",
          reason:
            "Controlled read of target-owned handoff bytes; later subject formation retains hypothesis-only provenance.",
          artifact_refs: itemRefs,
          ...immutableIdentity,
        } satisfies Record<string, unknown>);
      const status =
        existing === undefined
          ? await this.logs.appendValidated(runRoot, input.runId, "decisions.jsonl", decision)
          : "idempotent_replay";
      return {
        schemaVersion: "startup_opportunity.read_research_handoff_result.v1",
        runId: input.runId,
        handoffRef: input.handoffRef,
        handoffContentHash: envelope.content_hash,
        consumptionDecisionRef: `decisions.jsonl#${decisionId}`,
        consumptionDecisionHash: canonicalContentHash(decision),
        status,
        items: selected.map((item) => ({
          itemId: String(item.item_id),
          role: item.role as ResearchHandoffRole,
          decisionBoundary: item.decision_boundary as
            | "hypothesis_input_only"
            | "evidence_reuse_with_current_weighting",
          sourcePayload: Buffer.from(String(item.source_payload_base64), "base64").toString("utf8"),
          targetEvidenceRef:
            typeof item.target_evidence_ref === "string" ? item.target_evidence_ref : null,
        })),
      };
    });
  }

  async reformDecisionSubject(
    input: ReformDecisionSubjectInput,
  ): Promise<ReformDecisionSubjectResult> {
    await this.assertCurrentLeaf(input.runId);
    validateRelativePath(input.terminalSnapshotRef);
    validateRelativePath(input.reformedSubjectRef);
    if (input.reformationInputRefs.length === 0) {
      throw new StoreError(
        "subject_reformation.input_required",
        "subject reformation requires at least one newly formed causal input",
      );
    }
    const uniqueInputRefs = [...new Set(input.reformationInputRefs)].sort();
    if (uniqueInputRefs.length !== input.reformationInputRefs.length) {
      throw new StoreError(
        "subject_reformation.input_duplicate",
        "subject reformation inputs must be unique exact artifact refs",
      );
    }
    for (const ref of uniqueInputRefs) validateRelativePath(ref);
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      const manifest = await this.readManifest(runRoot);
      const readEnvelope = async (ref: string): Promise<FormalArtifactEnvelope> => {
        if (!manifest.artifact_refs.includes(ref)) {
          throw new StoreError(
            "subject_reformation.artifact_unpublished",
            "subject reformation may bind only immutable artifacts already published in this Run",
            { ref },
          );
        }
        const value = JSON.parse(
          await readFile(await resolveRunPath(runRoot, ref), "utf8"),
        ) as unknown;
        if (
          !isRecord(value) ||
          value.schema_version !== ARTIFACT_ENVELOPE_SCHEMA_VERSION ||
          value.artifact_path !== ref ||
          value.run_id !== input.runId ||
          !isRecord(value.document) ||
          value.content_hash !== canonicalContentHash(value.document)
        ) {
          throw new StoreError(
            "subject_reformation.artifact_invalid",
            "subject reformation requires exact same-Run immutable formal envelopes",
            { ref },
          );
        }
        return value as FormalArtifactEnvelope;
      };
      if (manifest.current_decision_subject_snapshot_ref === null) {
        throw new StoreError(
          "subject_reformation.snapshot_required",
          "subject reformation requires a published decision subject snapshot authority",
        );
      }
      const snapshotChain: FormalArtifactEnvelope[] = [];
      const visited = new Set<string>();
      let snapshotRef: string | null = manifest.current_decision_subject_snapshot_ref;
      while (snapshotRef !== null && !visited.has(snapshotRef)) {
        visited.add(snapshotRef);
        const snapshot = await readEnvelope(snapshotRef);
        if (snapshot.artifact_type !== "startup_opportunity.decision_subject_snapshot.current") {
          break;
        }
        snapshotChain.push(snapshot);
        snapshotRef =
          typeof snapshot.document.parent_snapshot_ref === "string"
            ? snapshot.document.parent_snapshot_ref
            : null;
      }
      const terminalSnapshot = snapshotChain.find(
        (snapshot) => snapshot.artifact_path === input.terminalSnapshotRef,
      );
      const terminalSubject = (
        Array.isArray(terminalSnapshot?.document.subjects)
          ? terminalSnapshot.document.subjects.filter(isRecord)
          : []
      ).find(
        (subject) =>
          subject.subject_id === input.terminalSubjectId &&
          ["dropped", "superseded"].includes(String(subject.lifecycle_status)),
      );
      if (terminalSnapshot === undefined || terminalSubject === undefined) {
        throw new StoreError(
          "subject_reformation.terminal_binding_invalid",
          "terminal snapshot must be in the authoritative ancestry and contain the named dropped or superseded subject",
        );
      }
      const terminalSubjectRef = String(terminalSubject.subject_ref);
      const terminalArtifact = await readEnvelope(terminalSubjectRef);
      const reformedArtifact = await readEnvelope(input.reformedSubjectRef);
      const subjectKind = terminalSubject.subject_kind as DecisionSubjectKind;
      const supportedSubjectKinds = new Set<DecisionSubjectKind>([
        "discovery_candidate",
        "opportunity_thesis",
        "concept_hypothesis",
      ]);
      if (
        !supportedSubjectKinds.has(subjectKind) ||
        !subjectSchemaAllowed(subjectKind, terminalArtifact.artifact_type) ||
        !subjectSchemaAllowed(subjectKind, reformedArtifact.artifact_type)
      ) {
        throw new StoreError(
          "subject_reformation.subject_kind_invalid",
          "subject reformation requires a supported exact subject kind and schema",
          { subjectKind },
        );
      }
      const terminalRevision = subjectRevisionDescriptor(subjectKind, terminalArtifact.document);
      const reformedRevision = subjectRevisionDescriptor(subjectKind, reformedArtifact.document);
      if (
        terminalSubject.subject_content_hash !== terminalArtifact.content_hash ||
        reformedArtifact.artifact_path === terminalArtifact.artifact_path ||
        reformedRevision.parentRef !== terminalArtifact.artifact_path ||
        reformedRevision.parentContentHash !== terminalArtifact.content_hash ||
        reformedRevision.subjectId !== terminalRevision.subjectId ||
        reformedRevision.subjectId !== input.terminalSubjectId ||
        reformedRevision.revision !== terminalRevision.revision + 1 ||
        (reformedRevision.expectedPath !== null &&
          reformedArtifact.artifact_path !== reformedRevision.expectedPath)
      ) {
        throw new StoreError(
          "subject_reformation.revision_lineage_invalid",
          "reformed subject must be the direct next immutable revision of the exact terminal subject kind and identity",
        );
      }
      if (canonicalJson(reformedRevision.semantics) === canonicalJson(terminalRevision.semantics)) {
        throw new StoreError(
          "subject_reformation.semantics_unchanged",
          "reformation must materially change the subject's business semantics",
        );
      }
      if (subjectKind === "concept_hypothesis") {
        for (const binding of reformedRevision.formationBindings) {
          const formationInput = await readEnvelope(binding.ref);
          if (binding.contentHash !== formationInput.content_hash) {
            throw new StoreError(
              "subject_reformation.formation_input_hash_mismatch",
              "Concept reformation must bind every formation input to its exact published content hash",
              {
                ref: binding.ref,
                declaredContentHash: binding.contentHash,
                actualContentHash: formationInput.content_hash,
              },
            );
          }
        }
      }
      const publicationRecords = await this.artifacts.publicationRecordsLocked(
        runRoot,
        input.runId,
      );
      const terminalSnapshotPublication = publicationRecords.get(terminalSnapshot.artifact_path);
      const reformedSubjectPublication = publicationRecords.get(reformedArtifact.artifact_path);
      if (
        terminalSnapshotPublication === undefined ||
        reformedSubjectPublication === undefined ||
        terminalSnapshotPublication.contentHash !== terminalSnapshot.content_hash ||
        reformedSubjectPublication.contentHash !== reformedArtifact.content_hash ||
        reformedSubjectPublication.publicationOrdinal <=
          terminalSnapshotPublication.publicationOrdinal
      ) {
        throw new StoreError(
          "subject_reformation.publication_order_invalid",
          "Store-owned publication order must place the new subject after the terminal snapshot",
        );
      }
      const reformationInputHashes = [] as {
        ref: string;
        content_hash: string;
        publication_ordinal: number;
      }[];
      for (const ref of uniqueInputRefs) {
        if (
          [
            terminalSnapshot.artifact_path,
            terminalArtifact.artifact_path,
            reformedArtifact.artifact_path,
          ].includes(ref) ||
          !reformedRevision.closureRefs.has(ref) ||
          terminalRevision.closureRefs.has(ref)
        ) {
          throw new StoreError(
            "subject_reformation.input_unrelated",
            "each reformation input must be newly added to the new subject's kind-specific formation or synthesis closure",
            { ref },
          );
        }
        const artifact = await readEnvelope(ref);
        const inputPublication = publicationRecords.get(ref);
        if (
          inputPublication === undefined ||
          inputPublication.contentHash !== artifact.content_hash ||
          inputPublication.publicationOrdinal <= terminalSnapshotPublication.publicationOrdinal ||
          inputPublication.publicationOrdinal >= reformedSubjectPublication.publicationOrdinal
        ) {
          throw new StoreError(
            "subject_reformation.input_not_post_terminal",
            "Store-owned publication order must place each causal input after the terminal snapshot and before the new subject",
            { ref },
          );
        }
        reformationInputHashes.push({
          ref,
          content_hash: artifact.content_hash,
          publication_ordinal: inputPublication.publicationOrdinal,
        });
      }
      const identity = {
        run_id: input.runId,
        terminal_snapshot_ref: terminalSnapshot.artifact_path,
        terminal_snapshot_hash: terminalSnapshot.content_hash,
        terminal_snapshot_publication_ordinal: terminalSnapshotPublication.publicationOrdinal,
        reformation_subject_kind: subjectKind,
        terminal_subject_id: input.terminalSubjectId,
        terminal_subject_ref: terminalArtifact.artifact_path,
        terminal_subject_content_hash: terminalArtifact.content_hash,
        reformed_subject_ref: reformedArtifact.artifact_path,
        reformed_subject_content_hash: reformedArtifact.content_hash,
        reformed_subject_publication_ordinal: reformedSubjectPublication.publicationOrdinal,
        reformation_input_hashes: reformationInputHashes,
      };
      const decisionId = `subject_reformed_${sha256Hex(
        operationKey("subject_reformation_identity", identity),
      ).slice(0, 24)}`;
      const existing = (
        await this.logs.listValidatedRecords(runRoot, input.runId, "decisions.jsonl")
      ).find((record) => record.decision_id === decisionId);
      if (
        existing !== undefined &&
        (existing.reason !== input.reason ||
          (input.reformedAt !== undefined && existing.timestamp !== input.reformedAt))
      ) {
        throw new StoreError(
          "subject_reformation.decision_conflict",
          "subject reformation identity is already bound to different reason or timestamp metadata",
        );
      }
      const decision =
        existing ??
        ({
          schema_version: "startup_opportunity.decision.v1",
          decision_id: decisionId,
          decision_type: "subject_reformed",
          timestamp: input.reformedAt ?? new Date().toISOString(),
          actor: "main_agent",
          reason: input.reason,
          artifact_refs: [
            terminalSnapshot.artifact_path,
            terminalArtifact.artifact_path,
            reformedArtifact.artifact_path,
            ...uniqueInputRefs,
          ].sort(),
          ...identity,
        } satisfies Record<string, unknown>);
      const status =
        existing === undefined
          ? await this.logs.appendValidated(runRoot, input.runId, "decisions.jsonl", decision)
          : "idempotent_replay";
      return {
        schemaVersion: "startup_opportunity.reform_decision_subject_result.v1",
        runId: input.runId,
        decisionRef: `decisions.jsonl#${decisionId}`,
        decisionHash: canonicalContentHash(decision),
        terminalSnapshotRef: terminalSnapshot.artifact_path,
        terminalSubjectRef: terminalArtifact.artifact_path,
        reformedSubjectRef: reformedArtifact.artifact_path,
        reformationInputHashes,
        status,
      };
    });
  }

  private async applyPublishedEnvelope(
    runRoot: string,
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
    ignoredLate: boolean,
    exactReplay: boolean,
    prePlanScopeReconciliationAllowed = true,
  ): Promise<RunManifest> {
    const reconcilesPrePlanScope =
      prePlanScopeReconciliationAllowed &&
      manifest.status === "needs_clarification" &&
      manifest.current_plan_ref === null &&
      envelope.artifact_type === "startup_opportunity.research_plan.v1" &&
      envelope.document.revision === 1;
    const clarificationState =
      manifest.status === "needs_clarification" && !reconcilesPrePlanScope
        ? {
            status: manifest.status,
            status_before_clarification: manifest.status_before_clarification,
          }
        : null;
    this.assertBranchPublicationTransition(manifest, envelope, ignoredLate);
    this.assertDiscoveryLanePublicationTransition(manifest, envelope, ignoredLate);
    this.assertEnrichmentBranchPublicationTransition(manifest, envelope, ignoredLate);
    const artifactWasTracked =
      manifest.artifact_refs.includes(envelope.artifact_path) ||
      manifest.ignored_late_artifact_refs.includes(envelope.artifact_path);
    const artifactRefs = ignoredLate
      ? manifest.artifact_refs.filter((ref) => ref !== envelope.artifact_path)
      : [...new Set([...manifest.artifact_refs, envelope.artifact_path])].sort();
    const ignoredLateArtifactRefs = ignoredLate
      ? [...new Set([...manifest.ignored_late_artifact_refs, envelope.artifact_path])].sort()
      : manifest.ignored_late_artifact_refs.filter((ref) => ref !== envelope.artifact_path);
    let next: RunManifest = {
      ...manifest,
      updated_at:
        Date.parse(envelope.created_at) > Date.parse(manifest.updated_at)
          ? envelope.created_at
          : manifest.updated_at,
      artifact_refs: artifactRefs,
      ignored_late_artifact_refs: ignoredLateArtifactRefs,
    };
    if (
      !ignoredLate &&
      envelope.artifact_type === "startup_opportunity.research_plan.v1" &&
      next.current_plan_ref === null &&
      envelope.document.revision === 1
    ) {
      next = {
        ...next,
        status: "planned",
        current_phase: next.mode === "opportunity_discovery" ? "discovery" : "assessment",
        current_plan_ref: envelope.artifact_path,
        plan_revision: 1,
        status_before_clarification: null,
      };
    }
    if (
      !ignoredLate &&
      (!exactReplay || !artifactWasTracked) &&
      envelope.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
      [
        "startup_opportunity.dispatch_batch.discovery.current",
        "startup_opportunity.dispatch_batch.assessment.current",
      ].includes(envelope.artifact_type)
    ) {
      for (const task of Array.isArray(envelope.document.tasks) ? envelope.document.tasks : []) {
        if (isRecord(task) && typeof task.unit_id === "string") {
          next = this.moveUnit(next, task.unit_id, "active_units");
        }
      }
      next = {
        ...next,
        status: "researching",
        current_phase: next.mode === "opportunity_discovery" ? "discovery" : "assessment",
      };
    }
    if (
      !ignoredLate &&
      (!exactReplay || !artifactWasTracked) &&
      envelope.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
      envelope.artifact_type === "startup_opportunity.discovery_generation_result.v1" &&
      typeof envelope.document.unit_id === "string"
    ) {
      next = this.moveUnit(
        next,
        envelope.document.unit_id,
        envelope.document.status === "failed" ? "failed_units" : "completed_units",
      );
    }
    if (
      !ignoredLate &&
      (!exactReplay || !artifactWasTracked) &&
      envelope.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
      envelope.artifact_type === "startup_opportunity.assessment_lane_result.v1" &&
      typeof envelope.document.unit_id === "string"
    ) {
      next = this.moveUnit(
        next,
        envelope.document.unit_id,
        envelope.document.status === "failed" ? "failed_units" : "completed_units",
      );
    }
    if (
      !ignoredLate &&
      (!exactReplay || !artifactWasTracked) &&
      envelope.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
      envelope.artifact_type === "startup_opportunity.assessment_stage_gate.v1" &&
      envelope.document.outcome !== "continue"
    ) {
      for (const unitId of Array.isArray(envelope.document.not_started_unit_ids)
        ? envelope.document.not_started_unit_ids
        : []) {
        if (typeof unitId === "string") next = this.moveUnit(next, unitId, "skipped_units");
      }
    }
    if (
      !ignoredLate &&
      (!exactReplay || !artifactWasTracked) &&
      envelope.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
      envelope.artifact_type === "startup_opportunity.decision_subject_snapshot.current"
    ) {
      next = {
        ...next,
        current_decision_subject_snapshot_ref: envelope.artifact_path,
        current_decision_subject_snapshot_hash: envelope.content_hash,
      };
    }
    if (
      !ignoredLate &&
      envelope.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
      [
        "startup_opportunity.research_task.assessment.current",
        "startup_opportunity.research_task.discovery_candidate.current",
        "startup_opportunity.research_task.discovery_evaluation.current",
      ].includes(envelope.artifact_type) &&
      typeof envelope.document.unit_id === "string"
    ) {
      const unitId = envelope.document.unit_id;
      next = this.moveUnit(next, unitId, "active_units");
      next = {
        ...next,
        status: "researching",
        current_phase:
          envelope.artifact_type ===
            "startup_opportunity.research_task.discovery_candidate.current" ||
          envelope.artifact_type ===
            "startup_opportunity.research_task.discovery_evaluation.current"
            ? "discovery"
            : "assessment",
      };
    }
    if (
      !ignoredLate &&
      envelope.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
      envelope.artifact_type ===
        "startup_opportunity.concept_evidence_assessment_branch_result.v1" &&
      typeof envelope.document.unit_id === "string" &&
      typeof envelope.document.branch_status === "string"
    ) {
      const target =
        this.validator.publicationPolicy.document.branch_status_projection[
          envelope.document.branch_status
        ];
      if (target === "completed_units" || target === "failed_units") {
        next = this.moveUnit(next, envelope.document.unit_id, target);
      } else if (target === "cancelled_units_existing") {
        next = this.moveUnit(next, envelope.document.unit_id, "cancelled_units");
      } else if (target === "skipped_units_existing") {
        next = this.moveUnit(next, envelope.document.unit_id, "skipped_units");
      } else if (target === "superseded_units_existing") {
        next = this.moveUnit(next, envelope.document.unit_id, "superseded_units");
      }
    }
    if (
      !ignoredLate &&
      envelope.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
      envelope.artifact_type === "startup_opportunity.discovery_lane_result.v1" &&
      typeof envelope.document.unit_id === "string" &&
      typeof envelope.document.status === "string"
    ) {
      const target =
        this.validator.publicationPolicy.document.discovery_lane_status_projection[
          envelope.document.status
        ];
      if (target === "completed_units" || target === "failed_units") {
        next = this.moveUnit(next, envelope.document.unit_id, target);
      }
    }
    if (
      !ignoredLate &&
      envelope.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
      envelope.artifact_type === "startup_opportunity.enrichment_branch_result.v1" &&
      typeof envelope.document.unit_id === "string" &&
      typeof envelope.document.status === "string"
    ) {
      const target =
        this.validator.publicationPolicy.document.enrichment_branch_status_projection[
          envelope.document.status
        ];
      if (target === "completed_units" || target === "failed_units") {
        next = this.moveUnit(next, envelope.document.unit_id, target);
      }
    }
    if (
      !ignoredLate &&
      envelope.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
      [
        "startup_opportunity.gap_snapshot.discovery.plan.current",
        "startup_opportunity.gap_snapshot.assessment.current",
        "startup_opportunity.gap_snapshot.discovery.readiness.current",
      ].includes(envelope.artifact_type)
    ) {
      const advancesLatest =
        !exactReplay ||
        (!artifactWasTracked && (await this.gapReplayAdvancesLatest(runRoot, next, envelope)));
      if (advancesLatest) {
        next = { ...next, latest_gap_snapshot_ref: envelope.artifact_path };
      }
    }
    if (
      !ignoredLate &&
      envelope.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
      [
        "startup_opportunity.adaptation_decision.discovery.current",
        "startup_opportunity.adaptation_decision.assessment.current",
      ].includes(envelope.artifact_type)
    ) {
      const lifecycleFields = [
        "pending_adaptation_refs",
        "validated_adaptation_refs",
        "rejected_adaptation_refs",
        "applied_adaptation_refs",
      ] as const;
      const alreadyTracked = lifecycleFields.some((field) =>
        next[field].includes(envelope.artifact_path),
      );
      if (!alreadyTracked) {
        next = {
          ...next,
          pending_adaptation_refs: [
            ...new Set([...next.pending_adaptation_refs, envelope.artifact_path]),
          ].sort(),
        };
      }
    }
    if (clarificationState !== null) {
      next = { ...next, ...clarificationState };
    }
    this.validateManifest(next);
    return next;
  }

  private assertDeclarativeRuntimeTransition(
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
    sameBundleActivations: ReadonlySet<string>,
  ): void {
    if (envelope.schema_version !== ARTIFACT_ENVELOPE_SCHEMA_VERSION) {
      return;
    }
    const tracked =
      manifest.artifact_refs.includes(envelope.artifact_path) ||
      manifest.ignored_late_artifact_refs.includes(envelope.artifact_path);
    if (tracked) {
      return;
    }
    const stateFields = [
      "completed_units",
      "active_units",
      "failed_units",
      "invalidated_units",
      "skipped_units",
      "cancelled_units",
      "superseded_units",
    ] as const;
    const stateOf = (unitId: string): string | null =>
      stateFields.find((field) => manifest[field].includes(unitId)) ?? null;
    if (
      envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current" ||
      envelope.artifact_type === "startup_opportunity.dispatch_batch.assessment.current"
    ) {
      if (envelope.document.research_plan_ref !== manifest.current_plan_ref) {
        throw new StoreError(
          "artifact.dispatch_transition_invalid",
          "dispatch batch must activate units from the current immutable Research Plan",
          {
            currentPlanRef: manifest.current_plan_ref,
            batchPlanRef: envelope.document.research_plan_ref,
          },
        );
      }
      const seen = new Set<string>();
      for (const task of Array.isArray(envelope.document.tasks) ? envelope.document.tasks : []) {
        if (!isRecord(task) || typeof task.unit_id !== "string") {
          continue;
        }
        const state = stateOf(task.unit_id);
        if (seen.has(task.unit_id) || state !== null) {
          throw new StoreError(
            "artifact.dispatch_transition_invalid",
            "dispatch batch only permits one pending-to-active transition per unit",
            { unitId: task.unit_id, state },
          );
        }
        seen.add(task.unit_id);
      }
    }
    if (
      envelope.artifact_type === "startup_opportunity.discovery_generation_result.v1" &&
      typeof envelope.document.unit_id === "string"
    ) {
      const state = stateOf(envelope.document.unit_id);
      if (state !== "active_units" && !sameBundleActivations.has(envelope.document.unit_id)) {
        throw new StoreError(
          "artifact.generation_transition_invalid",
          "Discovery generation result requires an active dispatch task",
          { unitId: envelope.document.unit_id, state },
        );
      }
    }
    if (
      envelope.artifact_type === "startup_opportunity.assessment_lane_result.v1" &&
      typeof envelope.document.unit_id === "string"
    ) {
      const state = stateOf(envelope.document.unit_id);
      if (state !== "active_units" && !sameBundleActivations.has(envelope.document.unit_id)) {
        throw new StoreError(
          "artifact.assessment_lane_transition_invalid",
          "Assessment lane result requires an active dispatch task",
          { unitId: envelope.document.unit_id, state },
        );
      }
    }
  }

  private async assertDecisionSubjectPublicationTransition(
    runRoot: string,
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
  ): Promise<void> {
    if (envelope.artifact_type !== "startup_opportunity.decision_subject_snapshot.current") {
      return;
    }
    const currentRef = manifest.current_decision_subject_snapshot_ref;
    const currentHash = manifest.current_decision_subject_snapshot_hash;
    if (manifest.artifact_refs.includes(envelope.artifact_path)) {
      return;
    }
    if (currentRef === envelope.artifact_path && currentHash === envelope.content_hash) {
      return;
    }
    if (manifest.current_plan_ref === null) {
      throw new StoreError(
        "artifact.decision_subject_snapshot_plan_invalid",
        "a new decision subject snapshot requires a current Research Plan",
      );
    }
    const currentPlan = JSON.parse(
      await readFile(await resolveRunPath(runRoot, manifest.current_plan_ref), "utf8"),
    ) as unknown;
    if (!isRecord(currentPlan) || !isCurrentEnvelopeSchema(currentPlan.schema_version)) {
      throw new StoreError(
        "artifact.decision_subject_snapshot_plan_invalid",
        "Manifest current Plan must resolve to a formal envelope before snapshot publication",
        { currentPlanRef: manifest.current_plan_ref },
      );
    }
    const currentPlanEnvelope = currentPlan as FormalArtifactEnvelope;
    await this.artifacts.validateStoredEnvelope(runRoot, manifest.run_id, currentPlanEnvelope);
    if (
      currentPlanEnvelope.artifact_type !== "startup_opportunity.research_plan.v1" ||
      currentPlanEnvelope.artifact_path !== manifest.current_plan_ref ||
      envelope.document.research_plan_ref !== manifest.current_plan_ref ||
      envelope.document.research_plan_hash !== currentPlanEnvelope.content_hash
    ) {
      throw new StoreError(
        "artifact.decision_subject_snapshot_plan_invalid",
        "a new decision subject snapshot must bind the Manifest current Plan exact ref and content hash",
        {
          currentPlanRef: manifest.current_plan_ref,
          currentPlanHash: currentPlanEnvelope.content_hash,
          snapshotPlanRef: envelope.document.research_plan_ref,
          snapshotPlanHash: envelope.document.research_plan_hash,
        },
      );
    }
    const currentRevision =
      currentRef === null
        ? 0
        : Number(
            currentRef.match(
              /^artifacts\/reporting\/decision-subject-snapshot\.r([1-9][0-9]*)\.json$/,
            )?.[1] ?? Number.NaN,
          );
    if (
      !Number.isInteger(currentRevision) ||
      envelope.document.revision !== currentRevision + 1 ||
      envelope.document.parent_snapshot_ref !== currentRef ||
      envelope.document.parent_snapshot_hash !== currentHash
    ) {
      throw new StoreError(
        "artifact.decision_subject_snapshot_transition_invalid",
        "decision subject snapshot must advance the Manifest-selected immutable revision exactly",
        {
          currentRef,
          currentHash,
          revision: envelope.document.revision,
          parentRef: envelope.document.parent_snapshot_ref,
          parentHash: envelope.document.parent_snapshot_hash,
        },
      );
    }
  }

  private async gapReplayAdvancesLatest(
    runRoot: string,
    manifest: RunManifest,
    replayedEnvelope: FormalArtifactEnvelope,
  ): Promise<boolean> {
    const currentRef = manifest.latest_gap_snapshot_ref;
    if (currentRef === null) {
      return true;
    }
    if (currentRef === replayedEnvelope.artifact_path) {
      return false;
    }
    const currentValue = JSON.parse(
      await readFile(await resolveRunPath(runRoot, currentRef), "utf8"),
    ) as unknown;
    if (!isRecord(currentValue) || !isCurrentEnvelopeSchema(currentValue.schema_version)) {
      throw new StoreError(
        "manifest.latest_gap_invalid",
        "latest Gap Snapshot ref does not target a formal envelope",
        { currentRef },
      );
    }
    const currentEnvelope = currentValue as FormalArtifactEnvelope;
    await this.artifacts.validateStoredEnvelope(runRoot, manifest.run_id, currentEnvelope);
    if (
      currentEnvelope.artifact_path !== currentRef ||
      ![
        "startup_opportunity.gap_snapshot.discovery.plan.current",
        "startup_opportunity.gap_snapshot.assessment.current",
        "startup_opportunity.gap_snapshot.discovery.readiness.current",
      ].includes(currentEnvelope.artifact_type)
    ) {
      throw new StoreError(
        "manifest.latest_gap_invalid",
        "latest Gap Snapshot ref targets another Artifact identity",
        { currentRef, artifactType: currentEnvelope.artifact_type },
      );
    }
    const replayedTime = Date.parse(replayedEnvelope.created_at);
    const currentTime = Date.parse(currentEnvelope.created_at);
    return (
      replayedTime > currentTime ||
      (replayedTime === currentTime &&
        replayedEnvelope.artifact_path.localeCompare(currentEnvelope.artifact_path) > 0)
    );
  }

  private assertBranchPublicationTransition(
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
    ignoredLate: boolean,
  ): void {
    if (
      envelope.schema_version !== "startup_opportunity.artifact_envelope.current" ||
      envelope.artifact_type !==
        "startup_opportunity.concept_evidence_assessment_branch_result.v1" ||
      typeof envelope.document.unit_id !== "string" ||
      typeof envelope.document.branch_status !== "string"
    ) {
      return;
    }
    const unitId = envelope.document.unit_id;
    const statusFields = [
      "completed_units",
      "active_units",
      "failed_units",
      "invalidated_units",
      "skipped_units",
      "cancelled_units",
      "superseded_units",
    ] as const;
    const existingState = statusFields.find((field) => manifest[field].includes(unitId));
    const target =
      this.validator.publicationPolicy.document.branch_status_projection[
        envelope.document.branch_status
      ];
    const allowedStates =
      target === "completed_units"
        ? ["active_units", "completed_units"]
        : target === "failed_units"
          ? ["active_units", "failed_units"]
          : target === "cancelled_units_existing"
            ? ["cancelled_units"]
            : target === "skipped_units_existing"
              ? ["skipped_units"]
              : target === "superseded_units_existing"
                ? ["superseded_units"]
                : target === "ignored_late_artifact_refs"
                  ? ["invalidated_units", "skipped_units", "cancelled_units", "superseded_units"]
                  : [];
    const expectsIgnoredLate = !["completed_units", "failed_units"].includes(String(target));
    if (!allowedStates.includes(existingState ?? "") || ignoredLate !== expectsIgnoredLate) {
      throw new StoreError(
        "artifact.branch_transition_invalid",
        "branch publication status does not match the existing Run unit state",
        {
          branchStatus: envelope.document.branch_status,
          existingState: existingState ?? null,
          ignoredLate,
          unitId,
        },
      );
    }
  }

  private assertDiscoveryLanePublicationTransition(
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
    ignoredLate: boolean,
  ): void {
    if (
      envelope.schema_version !== "startup_opportunity.artifact_envelope.current" ||
      envelope.artifact_type !== "startup_opportunity.discovery_lane_result.v1" ||
      typeof envelope.document.unit_id !== "string" ||
      typeof envelope.document.status !== "string"
    ) {
      return;
    }
    const unitId = envelope.document.unit_id;
    const statusFields = [
      "completed_units",
      "active_units",
      "failed_units",
      "invalidated_units",
      "skipped_units",
      "cancelled_units",
      "superseded_units",
    ] as const;
    const existingState = statusFields.find((field) => manifest[field].includes(unitId));
    const target =
      this.validator.publicationPolicy.document.discovery_lane_status_projection[
        envelope.document.status
      ];
    const allowedStates =
      target === "completed_units"
        ? ["active_units", "completed_units"]
        : target === "failed_units"
          ? ["active_units", "failed_units"]
          : target === "superseded_units_existing"
            ? ["superseded_units"]
            : target === "ignored_late_artifact_refs"
              ? ["invalidated_units", "skipped_units", "cancelled_units", "superseded_units"]
              : [];
    const expectsIgnoredLate = !["completed_units", "failed_units"].includes(String(target));
    if (!allowedStates.includes(existingState ?? "") || ignoredLate !== expectsIgnoredLate) {
      throw new StoreError(
        "artifact.discovery_lane_transition_invalid",
        "discovery lane publication status does not match the existing Run unit state",
        {
          laneStatus: envelope.document.status,
          existingState: existingState ?? null,
          ignoredLate,
          unitId,
        },
      );
    }
  }

  private assertEnrichmentBranchPublicationTransition(
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
    ignoredLate: boolean,
  ): void {
    if (
      envelope.schema_version !== ARTIFACT_ENVELOPE_SCHEMA_VERSION ||
      envelope.artifact_type !== "startup_opportunity.enrichment_branch_result.v1" ||
      typeof envelope.document.unit_id !== "string" ||
      typeof envelope.document.status !== "string"
    ) {
      return;
    }
    const unitId = envelope.document.unit_id;
    const statusFields = [
      "completed_units",
      "active_units",
      "failed_units",
      "invalidated_units",
      "skipped_units",
      "cancelled_units",
      "superseded_units",
    ] as const;
    const existingState = statusFields.find((field) => manifest[field].includes(unitId));
    const target =
      this.validator.publicationPolicy.document.enrichment_branch_status_projection[
        envelope.document.status
      ];
    const allowedStates =
      target === "completed_units"
        ? ["active_units", "completed_units"]
        : target === "failed_units"
          ? ["active_units", "failed_units"]
          : target === "superseded_units_existing"
            ? ["superseded_units"]
            : target === "ignored_late_artifact_refs"
              ? ["invalidated_units", "skipped_units", "cancelled_units", "superseded_units"]
              : [];
    const expectsIgnoredLate = !["completed_units", "failed_units"].includes(String(target));
    if (!allowedStates.includes(existingState ?? "") || ignoredLate !== expectsIgnoredLate) {
      throw new StoreError(
        "artifact.enrichment_branch_transition_invalid",
        "enrichment branch publication status does not match the existing Run unit state",
        {
          branchStatus: envelope.document.status,
          existingState: existingState ?? null,
          ignoredLate,
          unitId,
        },
      );
    }
  }

  private moveUnit(
    manifest: RunManifest,
    unitId: string,
    target:
      | "completed_units"
      | "active_units"
      | "failed_units"
      | "skipped_units"
      | "cancelled_units"
      | "superseded_units",
  ): RunManifest {
    const fields = [
      "completed_units",
      "active_units",
      "failed_units",
      "invalidated_units",
      "skipped_units",
      "cancelled_units",
      "superseded_units",
    ] as const;
    return Object.fromEntries(
      Object.entries(manifest).map(([field, value]) =>
        fields.includes(field as (typeof fields)[number])
          ? [
              field,
              field === target
                ? [...new Set([...(value as readonly string[]), unitId])].sort()
                : (value as readonly string[]).filter((candidate) => candidate !== unitId),
            ]
          : [field, value],
      ),
    ) as unknown as RunManifest;
  }

  private async checkpointLocked(
    runRoot: string,
    input: CheckpointRunInput,
  ): Promise<CheckpointRunResult> {
    const planOperationRecovery = await recoverPlanRevisionOperationsLocked(
      runRoot,
      input.runId,
      this.validator,
      this.artifacts,
      this.logs,
    );
    const referenceContext: DocumentBundleReferenceContext = {
      historicalDiscoveryPlanBindings: planOperationRecovery.historicalDiscoveryPlanBindings,
    };
    const manifest = await this.readManifest(runRoot);
    await this.assertScopeBindingLocked(runRoot, manifest);
    const checkpointRef = `checkpoints/${input.checkpointId.replaceAll("_", "-")}.json`;
    validateArtifactRef(checkpointRef);
    const formalDocuments = await this.artifacts.listFormalDocuments(runRoot);
    const existingEntry = formalDocuments.find((entry) => entry.path === checkpointRef);
    if (existingEntry !== undefined) {
      const existing = await this.validateCheckpointEntry(runRoot, input.runId, existingEntry);
      const replayIdentity = {
        checkpoint_id: input.checkpointId,
        run_id: input.runId,
        created_at: input.createdAt,
        input_refs: ["manifest.json", ...(input.inputRefs ?? [])],
        unresolved_gap_refs: input.unresolvedGapRefs ?? [],
        next_step: input.nextStep,
        belief_summary: input.beliefSummary,
      };
      const storedIdentity = {
        checkpoint_id: existing.document.checkpoint_id,
        run_id: existing.document.run_id,
        created_at: existing.document.created_at,
        input_refs: existing.document.input_refs,
        unresolved_gap_refs: existing.document.unresolved_gap_refs,
        next_step: existing.document.next_step,
        belief_summary: existing.document.belief_summary,
      };
      if (canonicalJson(replayIdentity) !== canonicalJson(storedIdentity)) {
        throw new StoreError("write.conflict", "checkpoint path is already occupied", {
          path: checkpointRef,
        });
      }
      await this.artifacts.publishLocked(
        runRoot,
        {
          runId: input.runId,
          envelope: existing.envelope,
        },
        false,
        referenceContext,
      );
      await this.recoverLocked(runRoot, input.runId);
      return {
        schemaVersion: "startup_opportunity.checkpoint_result.v1",
        runId: input.runId,
        checkpointRef,
        contentHash: existing.envelope.content_hash,
        status: "idempotent_replay",
      };
    }
    const checkpointTime = Date.parse(input.createdAt);
    const currentTime = Date.parse(manifest.updated_at);
    let latestCheckpointTime: number | null = null;
    for (const entry of formalDocuments.filter((item) => item.path.startsWith("checkpoints/"))) {
      try {
        const checkpoint = await this.validateCheckpointEntry(runRoot, input.runId, entry);
        const candidate = Date.parse(String(checkpoint.document.created_at));
        latestCheckpointTime = Math.max(latestCheckpointTime ?? candidate, candidate);
      } catch {
        // Invalid checkpoints are handled by reopen and cannot define durable order.
      }
    }
    const durableTime = Math.max(currentTime, latestCheckpointTime ?? currentTime);
    const initialCheckpoint = manifest.checkpoint_ref === null && latestCheckpointTime === null;
    if (
      !Number.isFinite(checkpointTime) ||
      !Number.isFinite(currentTime) ||
      !Number.isFinite(durableTime) ||
      (initialCheckpoint ? checkpointTime < durableTime : checkpointTime <= durableTime)
    ) {
      throw new StoreError(
        "checkpoint.non_monotonic_time",
        "checkpoint created_at must advance the durable Run timestamp",
        {
          checkpointCreatedAt: input.createdAt,
          currentUpdatedAt: manifest.updated_at,
          latestCheckpointAt:
            latestCheckpointTime === null ? null : new Date(latestCheckpointTime).toISOString(),
          initialCheckpoint,
        },
      );
    }
    const snapshot: RunManifest = {
      ...manifest,
      updated_at: input.createdAt,
      checkpoint_ref: checkpointRef,
    };
    this.validateManifest(snapshot);
    const document = {
      schema_version: "startup_opportunity.checkpoint.v1",
      checkpoint_id: input.checkpointId,
      run_id: input.runId,
      created_at: input.createdAt,
      producer_role: "harness",
      input_refs: ["manifest.json", ...(input.inputRefs ?? [])],
      manifest_snapshot: snapshot,
      current_plan_ref: snapshot.current_plan_ref,
      plan_revision: snapshot.plan_revision,
      completed_units: snapshot.completed_units,
      invalidated_units: snapshot.invalidated_units,
      artifact_refs: snapshot.artifact_refs,
      latest_gap_snapshot_ref: snapshot.latest_gap_snapshot_ref,
      applied_adaptation_refs: snapshot.applied_adaptation_refs,
      pending_adaptation_refs: snapshot.pending_adaptation_refs,
      unresolved_gap_refs: input.unresolvedGapRefs ?? [],
      next_step: input.nextStep,
      belief_summary: input.beliefSummary,
    };
    const envelope: FormalArtifactEnvelope = {
      schema_version: ARTIFACT_ENVELOPE_SCHEMA_VERSION,
      artifact_type: "startup_opportunity.checkpoint.v1",
      artifact_path: checkpointRef,
      run_id: input.runId,
      created_at: input.createdAt,
      producer_role: "harness",
      input_refs: document.input_refs,
      content_hash: canonicalContentHash(document),
      document,
    };
    const published = await this.artifacts.publishLocked(
      runRoot,
      {
        runId: input.runId,
        envelope,
      },
      false,
      referenceContext,
    );
    if (input.faultAt === "after_checkpoint_publish") {
      throw new StoreError("fault.injected", "injected failure after checkpoint publish");
    }
    await this.writeManifest(runRoot, snapshot);
    if (input.faultAt === "after_manifest_update") {
      throw new StoreError("fault.injected", "injected failure after manifest update");
    }
    await this.logs.appendValidated(runRoot, input.runId, "events.jsonl", {
      schema_version: "startup_opportunity.event.v1",
      event_id: `checkpoint_written_${sha256Hex(envelope.content_hash)}`,
      run_id: input.runId,
      event_type: "checkpoint_written",
      timestamp: input.createdAt,
      actor: "harness",
      reason: "The Run Store published a validated checkpoint.",
      artifact_refs: [checkpointRef],
    });
    return {
      schemaVersion: "startup_opportunity.checkpoint_result.v1",
      runId: input.runId,
      checkpointRef,
      contentHash: envelope.content_hash,
      status: published.status,
    };
  }

  private async recoverLocked(runRoot: string, runId: string): Promise<LoadRunResult> {
    const evidenceRecovery = await this.evidence.recoverLocked(runRoot, runId);
    const artifactRecovery = await this.artifacts.recoverLocked(runRoot, runId);
    const handoffRecovery = await this.recoverResearchHandoffOperationsLocked(runRoot, runId);
    const logRepairs = [
      await this.logs.repair(runRoot, runId, "events.jsonl"),
      await this.logs.repair(runRoot, runId, "decisions.jsonl"),
    ];
    const planOperationRecovery = await recoverPlanRevisionOperationsLocked(
      runRoot,
      runId,
      this.validator,
      this.artifacts,
      this.logs,
    );
    const reportRecovery = await recoverReportOperationsLocked(
      runRoot,
      runId,
      this.validator,
      this.artifacts,
    );
    await this.validateLogRefs(runRoot, "events.jsonl");
    await this.validateLogRefs(runRoot, "decisions.jsonl");
    const currentManifest = await this.readManifest(runRoot);
    const formalDocuments = await this.artifacts.listFormalDocuments(runRoot);
    const invalidCheckpoints: string[] = [];
    const validCheckpoints: {
      readonly path: string;
      readonly envelope: FormalArtifactEnvelope;
      readonly document: Record<string, unknown>;
    }[] = [];

    for (const entry of formalDocuments.filter((item) => !item.path.startsWith("checkpoints/"))) {
      if (!isRecord(entry.document) || !isCurrentEnvelopeSchema(entry.document.schema_version)) {
        throw new StoreError("recovery.invalid_artifact", "formal artifact is not an envelope", {
          path: entry.path,
        });
      }
      await this.artifacts.validateStoredEnvelope(
        runRoot,
        runId,
        entry.document as FormalArtifactEnvelope,
      );
    }

    for (const entry of formalDocuments.filter((item) => item.path.startsWith("checkpoints/"))) {
      try {
        validCheckpoints.push(await this.validateCheckpointEntry(runRoot, runId, entry));
      } catch {
        invalidCheckpoints.push(entry.path);
      }
    }
    validCheckpoints.sort((left, right) => {
      const time =
        Date.parse(String(left.document.created_at)) -
        Date.parse(String(right.document.created_at));
      return time === 0 ? left.path.localeCompare(right.path) : time;
    });
    const latest = validCheckpoints.at(-1);
    if (!latest || !isRecord(latest.document.manifest_snapshot)) {
      throw new StoreError("recovery.no_valid_checkpoint", "Run has no valid checkpoint", {
        runId,
      });
    }
    const snapshot = latest.document.manifest_snapshot as RunManifest;
    this.validateManifest(snapshot);

    const formalArtifactPaths = formalDocuments
      .filter((entry) => !entry.path.startsWith("checkpoints/"))
      .map((entry) => entry.path)
      .sort();
    const latestArtifactTime = formalDocuments
      .filter((entry) => !entry.path.startsWith("checkpoints/"))
      .map((entry) =>
        isRecord(entry.document) && typeof entry.document.created_at === "string"
          ? entry.document.created_at
          : snapshot.updated_at,
      )
      .reduce(
        (latestTime, candidate) =>
          Date.parse(candidate) > Date.parse(latestTime) ? candidate : latestTime,
        snapshot.updated_at,
      );
    const provisionalManifest: RunManifest = {
      ...snapshot,
      updated_at: latestArtifactTime,
      checkpoint_ref: latest.path,
    };
    const ignoredLateArtifactPaths: string[] = [];
    const currentArtifactPaths: string[] = [];
    for (const artifactPath of formalArtifactPaths) {
      const storedEntry = formalDocuments.find((entry) => entry.path === artifactPath);
      const storedEnvelope =
        storedEntry !== undefined &&
        isRecord(storedEntry.document) &&
        isCurrentEnvelopeSchema(storedEntry.document.schema_version)
          ? (storedEntry.document as FormalArtifactEnvelope)
          : null;
      const enrichmentTerminalResult =
        storedEnvelope?.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
        storedEnvelope.artifact_type === "startup_opportunity.enrichment_branch_result.v1" &&
        ["ignored_late", "superseded"].includes(String(storedEnvelope.document.status));
      if (
        enrichmentTerminalResult ||
        (await this.classifyPlannedArtifact(runRoot, provisionalManifest, artifactPath)).ignoredLate
      ) {
        ignoredLateArtifactPaths.push(artifactPath);
      } else {
        currentArtifactPaths.push(artifactPath);
      }
    }
    let recoveredManifest: RunManifest = await this.bindLatestScopeState(runRoot, {
      ...provisionalManifest,
      status_before_clarification:
        currentManifest.status_before_clarification ??
        provisionalManifest.status_before_clarification,
      artifact_refs: [...new Set([...snapshot.artifact_refs, ...currentArtifactPaths])]
        .filter((ref) => !ignoredLateArtifactPaths.includes(ref))
        .sort(),
      ignored_late_artifact_refs: [
        ...new Set([...snapshot.ignored_late_artifact_refs, ...ignoredLateArtifactPaths]),
      ].sort(),
    });
    const recoveredScopeState = await this.assertScopeBindingLocked(runRoot, recoveredManifest);
    const supersededFormationRefs = new Set(
      recoveredManifest.scope_revision > 1
        ? strings(recoveredScopeState.confirmation?.superseded_formation_refs)
        : [],
    );
    if (supersededFormationRefs.size > 0) {
      recoveredManifest = {
        ...recoveredManifest,
        artifact_refs: recoveredManifest.artifact_refs.filter(
          (ref) => !supersededFormationRefs.has(ref),
        ),
      };
    }
    const checkpointKnownPaths = new Set([
      ...snapshot.artifact_refs,
      ...snapshot.ignored_late_artifact_refs,
    ]);
    const artifactPublicationRecords = await this.artifacts.publicationRecordsLocked(
      runRoot,
      runId,
    );
    const postCheckpointEnvelopes = formalDocuments
      .filter(
        (entry) =>
          !entry.path.startsWith("checkpoints/") &&
          !checkpointKnownPaths.has(entry.path) &&
          !supersededFormationRefs.has(entry.path) &&
          isRecord(entry.document) &&
          isCurrentEnvelopeSchema(entry.document.schema_version),
      )
      .map((entry) => entry.document as FormalArtifactEnvelope)
      .sort((left, right) => {
        const leftOrdinal = artifactPublicationRecords.get(left.artifact_path)?.publicationOrdinal;
        const rightOrdinal = artifactPublicationRecords.get(
          right.artifact_path,
        )?.publicationOrdinal;
        if (leftOrdinal !== undefined && rightOrdinal !== undefined) {
          return leftOrdinal - rightOrdinal;
        }
        const rank = recoveryTransitionRank(left) - recoveryTransitionRank(right);
        return rank === 0 ? left.artifact_path.localeCompare(right.artifact_path) : rank;
      });
    const prePlanScopeReconciliationAllowed =
      currentManifest.current_plan_ref === null ||
      (currentManifest.scope_revision === recoveredManifest.scope_revision &&
        currentManifest.status !== "needs_clarification");
    for (const envelope of postCheckpointEnvelopes) {
      recoveredManifest = await this.applyPublishedEnvelope(
        runRoot,
        recoveredManifest,
        envelope,
        ignoredLateArtifactPaths.includes(envelope.artifact_path),
        false,
        prePlanScopeReconciliationAllowed,
      );
    }
    this.validateManifest(recoveredManifest);
    await this.assertScopeBindingLocked(runRoot, recoveredManifest);
    await this.assertManifestRefsExist(runRoot, recoveredManifest);
    const recoveryDocuments: DocumentBundleEntry[] = [
      { path: "manifest.json", document: recoveredManifest },
      ...formalDocuments.filter(
        (entry) =>
          !invalidCheckpoints.includes(entry.path) && !supersededFormationRefs.has(entry.path),
      ),
    ];
    const recoveryDocumentPaths = new Set(recoveryDocuments.map((entry) => entry.path));
    const typedJsonlRefs = recoveryDocuments.flatMap((entry) => artifactRefsForDocument(entry));
    const exactJsonlRecords = new Map<string, Record<string, unknown>>();
    for (const ref of [...new Set(typedJsonlRefs)].sort()) {
      const logPath = ref.split("#", 1)[0];
      if (logPath !== "events.jsonl" && logPath !== "decisions.jsonl") {
        continue;
      }
      exactJsonlRecords.set(ref, await this.logs.readExactRecord(runRoot, runId, ref, logPath));
    }
    for (const record of await this.evidence.listRecordsLocked(runRoot, runId)) {
      if (record.schema_version === "startup_opportunity.evidence_store_record.v2") {
        const handoffBinding = isRecord(record.handoff_binding) ? record.handoff_binding : null;
        if (
          typeof handoffBinding?.handoff_ref === "string" &&
          !recoveryDocumentPaths.has(handoffBinding.handoff_ref)
        ) {
          continue;
        }
        exactJsonlRecords.set(`evidence/manifest.jsonl#${record.evidence_id}`, record);
      }
    }
    for (const decision of await this.logs.listValidatedRecords(
      runRoot,
      runId,
      "decisions.jsonl",
    )) {
      if (decision.decision_type === "research_handoff_consumed") {
        exactJsonlRecords.set(`decisions.jsonl#${String(decision.decision_id)}`, decision);
      }
    }
    const bundle = this.validator.validateDocumentBundle(
      {
        schema_version: DOCUMENT_BUNDLE_SCHEMA_VERSION,
        documents: recoveryDocuments,
        exact_records: [],
      },
      {
        exactJsonlRecords,
        historicalDiscoveryPlanBindings: planOperationRecovery.historicalDiscoveryPlanBindings,
        artifactPublicationRecords,
      },
    );
    if (!bundle.valid) {
      throw new StoreError(
        "recovery.reference_invalid",
        "Run references or plan lineage are invalid",
        {
          bundleErrors: bundle.bundleErrors,
          documentErrors: bundle.documents.flatMap((document) => document.errors),
          referenceErrors: bundle.referenceErrors,
          referenceErrorCodes: bundle.referenceErrors.map((error) => error.code),
        },
      );
    }

    const manifestChanged = canonicalJson(currentManifest) !== canonicalJson(recoveredManifest);
    if (manifestChanged) {
      await this.writeManifest(runRoot, recoveredManifest);
    }
    const checkpointEventId = `checkpoint_written_${sha256Hex(latest.envelope.content_hash)}`;
    const eventStatus = await this.logs.appendValidated(runRoot, runId, "events.jsonl", {
      schema_version: "startup_opportunity.event.v1",
      event_id: checkpointEventId,
      run_id: runId,
      event_type: "checkpoint_written",
      timestamp: latest.document.created_at,
      actor: "harness",
      reason: "The Run Store published a validated checkpoint.",
      artifact_refs: [latest.path],
    });
    return {
      schemaVersion: "startup_opportunity.load_run_result.v1",
      runId,
      manifest: recoveredManifest,
      recovered:
        manifestChanged ||
        eventStatus === "appended" ||
        artifactRecovery.recoveredArtifactPaths.length > 0 ||
        handoffRecovery.length > 0 ||
        logRepairs.some(
          (repair) => repair.truncatedBytes > 0 || repair.replayedRecordIds.length > 0,
        ) ||
        evidenceRecovery.truncatedBytes > 0 ||
        evidenceRecovery.replayedEvidenceIds.length > 0 ||
        evidenceRecovery.recoveredRawContentRefs.length > 0 ||
        planOperationRecovery.completedOperationKeys.length > 0 ||
        reportRecovery.recoveredFormalArtifactPaths.length > 0 ||
        reportRecovery.recoveredMaterializedPaths.length > 0,
      lastValidCheckpointRef: latest.path,
      recoveredArtifactPaths: artifactRecovery.recoveredArtifactPaths,
      ignoredInvalidCheckpointPaths: invalidCheckpoints.sort(),
      logRepairs,
      evidenceRecovery,
      planOperationRecovery,
      reportRecovery,
      orphanActiveUnits: currentManifest.active_units,
    };
  }

  private async recoverResearchHandoffOperationsLocked(
    runRoot: string,
    runId: string,
  ): Promise<readonly string[]> {
    const operationsDirectory = await resolveRunPath(runRoot, ".store/operations", {
      createParents: true,
    });
    const recovered: string[] = [];
    for (const filename of (await readdir(operationsDirectory)).sort()) {
      if (!filename.startsWith("research-handoff-") || !filename.endsWith(".json")) continue;
      const intent = validateResearchHandoffOperationIntent(
        JSON.parse(
          await readFile(await resolveRunPath(runRoot, `.store/operations/${filename}`), "utf8"),
        ) as unknown,
        filename,
        runId,
      );
      const result = await this.replayResearchHandoffIntentLocked(runRoot, runId, intent, true);
      recovered.push(...result.recoveredRefs);
    }
    return recovered.sort();
  }

  private async replayResearchHandoffIntentLocked(
    runRoot: string,
    runId: string,
    intent: ResearchHandoffOperationIntent,
    recovery = false,
  ): Promise<{
    readonly artifactStatus: "published" | "idempotent_replay" | null;
    readonly recoveredRefs: readonly string[];
  }> {
    const recovered: string[] = [];
    const existingEvidence = new Map(
      (await this.evidence.listRecordsLocked(runRoot, runId)).map((record) => [
        record.operation_key,
        record,
      ]),
    );
    const formal = await this.artifacts.listFormalDocuments(runRoot);
    const existingHandoff = formal.find((entry) => entry.path === intent.handoff_ref);
    const durableEvidenceCount = intent.evidence_imports.filter((entry) =>
      existingEvidence.has(entry.record.operation_key),
    ).length;
    const transactionStarted = existingHandoff !== undefined || durableEvidenceCount > 0;

    if (existingHandoff !== undefined) {
      if (canonicalJson(existingHandoff.document) !== canonicalJson(intent.envelope)) {
        throw new StoreError(
          "recovery.invalid_research_handoff_operation",
          "Durable handoff Artifact differs from its immutable operation intent",
          { handoffRef: intent.handoff_ref },
        );
      }
      await this.artifacts.validateStoredEnvelope(runRoot, runId, intent.envelope);
    }
    for (const evidenceImport of intent.evidence_imports) {
      const existing = existingEvidence.get(evidenceImport.record.operation_key);
      if (existing === undefined) continue;
      const rawBytes = Buffer.from(evidenceImport.raw_content_base64, "base64");
      if (
        canonicalJson(existing) !== canonicalJson(evidenceImport.record) ||
        sha256Bytes(rawBytes) !== existing.content_hash ||
        !(await readFile(await resolveRunPath(runRoot, existing.raw_content_ref))).equals(rawBytes)
      ) {
        throw new StoreError(
          "recovery.invalid_research_handoff_operation",
          "Durable handoff Evidence differs from its immutable operation intent",
          { evidenceId: evidenceImport.record.evidence_id },
        );
      }
    }
    if (existingHandoff !== undefined && durableEvidenceCount === intent.evidence_imports.length) {
      return { artifactStatus: "idempotent_replay", recoveredRefs: [] };
    }
    let scopeMutationPrevalidated = transactionStarted;
    if (!transactionStarted) {
      scopeMutationPrevalidated = await this.researchHandoffIntentStillApplicable(runRoot, intent);
      if (!scopeMutationPrevalidated) {
        if (!recovery) {
          throw new StoreError(
            "research_handoff.intent_applicability_expired",
            "An uncommitted handoff intent cannot start after its exact target Scope or Plan changed",
            { handoffRef: intent.handoff_ref },
          );
        }
        return { artifactStatus: null, recoveredRefs: [] };
      }
    }
    for (const evidenceImport of intent.evidence_imports) {
      const handoffBinding = evidenceImport.record.handoff_binding;
      if (handoffBinding === undefined) {
        throw new StoreError(
          "recovery.invalid_research_handoff_operation",
          "Research handoff Evidence import is missing its immutable binding",
        );
      }
      const result = await this.evidence.recordResearchHandoffImportLocked(
        runRoot,
        {
          runId,
          unitId: evidenceImport.record.unit_id,
          source: evidenceImport.record.source,
          researchGoal: evidenceImport.record.research_goal,
          rawContent: Buffer.from(evidenceImport.raw_content_base64, "base64"),
          recordedAt: evidenceImport.record.recorded_at,
          operationKey: evidenceImport.record.operation_key,
          handoffBinding,
        },
        scopeMutationPrevalidated,
      );
      if (result.status === "recorded") recovered.push(`evidence:${result.record.evidence_id}`);
    }
    const publication = await this.artifacts.publishResearchHandoffLocked(
      runRoot,
      {
        runId,
        envelope: intent.envelope,
      },
      {},
      scopeMutationPrevalidated || durableEvidenceCount > 0,
    );
    if (existingHandoff === undefined || publication.status === "published")
      recovered.push(intent.handoff_ref);
    return { artifactStatus: publication.status, recoveredRefs: recovered.sort() };
  }

  private async researchHandoffIntentStillApplicable(
    runRoot: string,
    intent: ResearchHandoffOperationIntent,
  ): Promise<boolean> {
    const manifest = await this.readManifest(runRoot);
    const document = intent.envelope.document;
    if (
      manifest.scope_revision !== document.target_scope_revision ||
      manifest.scope_confirmation_ref !== document.target_scope_confirmation_ref ||
      manifest.scope_confirmation_hash !== document.target_scope_confirmation_hash ||
      manifest.status === "awaiting_scope_confirmation" ||
      TERMINAL_RUN_STATUSES.has(manifest.status) ||
      manifest.status === "reporting"
    ) {
      return false;
    }
    if (document.target_formation_stage === "pre_plan_assessment_formation") {
      if (
        manifest.current_plan_ref !== null ||
        manifest.mode !== "concept_evidence_assessment" ||
        manifest.artifact_refs.includes("concept-hypothesis.json")
      ) {
        return false;
      }
      try {
        const scope = await this.exactAssessmentPrePlanScopeLocked(runRoot, manifest);
        return (
          scope.artifact_path === document.target_scope_ref &&
          scope.content_hash === document.target_scope_hash
        );
      } catch (error) {
        if (error instanceof StoreError && error.code === "run.scope_formation_binding_invalid") {
          return false;
        }
        throw error;
      }
    }
    if (manifest.status === "needs_clarification") return false;
    if (
      manifest.current_plan_ref !== document.target_plan_ref ||
      manifest.current_plan_ref === null
    ) {
      return false;
    }
    try {
      const value = JSON.parse(
        await readFile(await resolveRunPath(runRoot, manifest.current_plan_ref), "utf8"),
      ) as unknown;
      return (
        isRecord(value) &&
        isCurrentEnvelopeSchema(value.schema_version) &&
        value.content_hash === document.target_plan_hash
      );
    } catch {
      return false;
    }
  }

  private async validateCheckpointEntry(
    runRoot: string,
    runId: string,
    entry: DocumentBundleEntry,
  ): Promise<{
    readonly path: string;
    readonly envelope: FormalArtifactEnvelope;
    readonly document: Record<string, unknown>;
  }> {
    if (!isRecord(entry.document) || !isCurrentEnvelopeSchema(entry.document.schema_version)) {
      throw new StoreError("checkpoint.invalid", "checkpoint is not a formal envelope", {
        path: entry.path,
      });
    }
    const envelope = entry.document as FormalArtifactEnvelope;
    await this.artifacts.validateStoredEnvelope(runRoot, runId, envelope);
    const document = checkpointDocument(envelope);
    if (!document || document.manifest_snapshot === undefined) {
      throw new StoreError("checkpoint.invalid", "checkpoint document is missing its snapshot");
    }
    const checkpointTime = Date.parse(String(document.created_at));
    const snapshot = document.manifest_snapshot;
    if (
      !isRecord(snapshot) ||
      envelope.created_at !== document.created_at ||
      snapshot.updated_at !== document.created_at ||
      snapshot.checkpoint_ref !== entry.path ||
      !Number.isFinite(checkpointTime) ||
      checkpointTime < Date.parse(String(snapshot.created_at))
    ) {
      throw new StoreError(
        "checkpoint.invalid_order",
        "checkpoint time and manifest snapshot identity are inconsistent",
        { path: entry.path },
      );
    }
    return { path: entry.path, envelope, document };
  }

  private async readManifest(runRoot: string): Promise<RunManifest> {
    const filename = await resolveRunPath(runRoot, "manifest.json");
    const value = JSON.parse(await readFile(filename, "utf8")) as unknown;
    if (!isRecord(value)) {
      throw new StoreError("manifest.invalid", "manifest is not an object");
    }
    const manifest = value as RunManifest;
    this.validateManifest(manifest);
    return manifest;
  }

  private validateManifest(manifest: RunManifest): void {
    const result = this.validator.validateDocument(manifest, "manifest.json");
    if (!result.valid) {
      throw new StoreError("manifest.schema_invalid", "manifest is not schema-valid", {
        errors: result.errors,
      });
    }
    assertDisjoint(manifest, [
      "pending_adaptation_refs",
      "validated_adaptation_refs",
      "rejected_adaptation_refs",
      "applied_adaptation_refs",
    ]);
    assertDisjoint(manifest, [
      "completed_units",
      "active_units",
      "failed_units",
      "invalidated_units",
      "skipped_units",
      "cancelled_units",
      "superseded_units",
    ]);
  }

  private async writeManifest(runRoot: string, manifest: RunManifest): Promise<void> {
    this.validateManifest(manifest);
    const suffix = sha256Hex(operationKey("replace_manifest", manifest));
    await atomicReplace(runRoot, "manifest.json", `${canonicalJson(manifest)}\n`, suffix);
  }

  private async assertRecordRefsExist(
    runRoot: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    if (!Array.isArray(record.artifact_refs)) {
      return;
    }
    for (const ref of record.artifact_refs) {
      if (typeof ref === "string" && this.isPathRef(ref)) {
        await this.assertPathRefExists(runRoot, ref);
      }
    }
  }

  private async validateLogRefs(
    runRoot: string,
    logPath: "events.jsonl" | "decisions.jsonl",
  ): Promise<void> {
    const contents = await readFile(await resolveRunPath(runRoot, logPath), "utf8");
    for (const line of contents.split("\n").filter(Boolean)) {
      await this.assertRecordRefsExist(runRoot, JSON.parse(line) as Record<string, unknown>);
    }
  }

  private async assertManifestRefsExist(runRoot: string, manifest: RunManifest): Promise<void> {
    const refs = [
      ...manifest.artifact_refs,
      ...manifest.ignored_late_artifact_refs,
      ...(manifest.checkpoint_ref === null ? [] : [manifest.checkpoint_ref]),
    ];
    for (const ref of refs) {
      if (this.isPathRef(ref)) {
        await this.assertPathRefExists(runRoot, ref);
      }
    }
  }

  private async classifyPlannedArtifact(
    runRoot: string,
    manifest: RunManifest,
    artifactPath: string,
  ): Promise<{ readonly ignoredLate: boolean; readonly expectedArtifactType: string | null }> {
    const discoveryTaskClassification = await this.classifyDiscoveryTaskArtifact(
      runRoot,
      manifest,
      artifactPath,
    );
    if (discoveryTaskClassification !== null) {
      return discoveryTaskClassification;
    }
    if (manifest.current_plan_ref === null) {
      return { ignoredLate: false, expectedArtifactType: null };
    }
    let storedPlan: unknown;
    try {
      storedPlan = JSON.parse(
        await readFile(await resolveRunPath(runRoot, manifest.current_plan_ref), "utf8"),
      ) as unknown;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { ignoredLate: false, expectedArtifactType: null };
      }
      throw error;
    }
    if (!isRecord(storedPlan)) {
      return { ignoredLate: false, expectedArtifactType: null };
    }
    const plan =
      isCurrentEnvelopeSchema(storedPlan.schema_version) && isRecord(storedPlan.document)
        ? storedPlan.document
        : storedPlan;
    if (!Array.isArray(plan.waves)) {
      return { ignoredLate: false, expectedArtifactType: null };
    }
    for (const wave of plan.waves) {
      if (!isRecord(wave) || !Array.isArray(wave.units)) {
        continue;
      }
      for (const unit of wave.units) {
        if (
          !isRecord(unit) ||
          unit.output_path !== artifactPath ||
          typeof unit.unit_id !== "string"
        ) {
          continue;
        }
        return {
          ignoredLate:
            manifest.invalidated_units.includes(unit.unit_id) ||
            manifest.skipped_units.includes(unit.unit_id) ||
            manifest.cancelled_units.includes(unit.unit_id) ||
            manifest.superseded_units.includes(unit.unit_id),
          expectedArtifactType:
            typeof unit.required_artifact_schema === "string"
              ? unit.required_artifact_schema
              : null,
        };
      }
    }
    return { ignoredLate: false, expectedArtifactType: null };
  }

  private async classifyDiscoveryTaskArtifact(
    runRoot: string,
    manifest: RunManifest,
    artifactPath: string,
  ): Promise<{
    readonly ignoredLate: boolean;
    readonly expectedArtifactType: string | null;
  } | null> {
    const matches = (await this.artifacts.listFormalDocuments(runRoot)).filter((entry) => {
      const envelope = entry.document;
      return (
        envelope.schema_version === "startup_opportunity.artifact_envelope.current" &&
        envelope.artifact_type ===
          "startup_opportunity.research_task.discovery_candidate.current" &&
        isRecord(envelope.document) &&
        envelope.document.allowed_output_path === artifactPath
      );
    });
    if (matches.length > 1) {
      throw new StoreError(
        "artifact.discovery_task_output_ambiguous",
        "multiple immutable discovery tasks claim the same output path",
        { artifactPath, taskRefs: matches.map((entry) => entry.path).sort() },
      );
    }
    const match = matches[0];
    if (match === undefined || !isRecord(match.document.document)) {
      return null;
    }
    const task = match.document.document;
    const unitId = task.unit_id;
    if (typeof unitId !== "string") {
      return null;
    }
    return {
      ignoredLate:
        manifest.invalidated_units.includes(unitId) ||
        manifest.skipped_units.includes(unitId) ||
        manifest.cancelled_units.includes(unitId) ||
        manifest.superseded_units.includes(unitId),
      expectedArtifactType:
        typeof task.required_artifact_schema === "string" ? task.required_artifact_schema : null,
    };
  }

  private isPathRef(ref: string): boolean {
    const target = ref.split("#", 1)[0] ?? "";
    return target.includes("/") || target.endsWith(".json") || target.endsWith(".jsonl");
  }

  private async assertPathRefExists(runRoot: string, ref: string): Promise<void> {
    const parsed = validateArtifactRef(ref);
    let filename: string;
    try {
      filename = await resolveRunPath(runRoot, parsed.path);
      await readFile(filename);
    } catch (error) {
      if (
        isNodeError(error, "ENOENT") ||
        (error instanceof StoreError && error.code === "path.parent_missing")
      ) {
        throw new StoreError("reference.missing", "Run-relative reference target is missing", {
          ref,
        });
      }
      throw error;
    }
    if (parsed.fragment === null) {
      return;
    }
    const text = await readFile(filename, "utf8");
    const candidates = parsed.path.endsWith(".jsonl") ? text.split("\n").filter(Boolean) : [text];
    const found = candidates.some((candidate) => {
      try {
        return canonicalJson(JSON.parse(candidate) as unknown).includes(
          JSON.stringify(parsed.fragment),
        );
      } catch {
        return false;
      }
    });
    if (!found) {
      throw new StoreError("reference.fragment_missing", "Run-relative ref fragment is missing", {
        ref,
      });
    }
  }
}

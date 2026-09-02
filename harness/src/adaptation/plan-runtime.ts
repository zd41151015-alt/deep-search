import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ArtifactStore,
  type FormalArtifactEnvelope,
  isPlanRuntimeOwnedCloseoutEnvelope,
} from "../artifact-store/artifact-store.js";
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
  openRunDirectoryReadOnly,
  resolveRunPath,
  validateRunId,
} from "../artifact-store/path-policy.js";
import { withRunLock } from "../artifact-store/run-lock.js";
import { StoreError } from "../artifact-store/store-error.js";
import { EvidenceStore } from "../evidence-store/evidence-store.js";
import {
  type BuildReportResult,
  completePreparedTerminalReportLocked,
  type PreparedTerminalReportOperation,
  preparedTerminalReportIsDurableLocked,
  type ReportFaultBoundary,
  ReportRuntime,
  terminalReportArtifactPaths,
  validatePreparedTerminalReportOperation,
} from "../reporting/report-runtime.js";
import { type JsonlStore, JsonlStore as RuntimeJsonlStore } from "../run-store/jsonl-store.js";
import type { BeliefSummary, RunManifest } from "../run-store/run-store.js";
import {
  canonicalExecutionStageCloseoutId,
  canonicalExecutionStageCloseoutPath,
} from "../runtime/execution-stage-closeout-identity.js";
import { canonicalLaneLifecyclePath } from "../runtime/lane-lifecycle-identity.js";
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
import {
  documentMap,
  type EffectiveDocument,
  effectiveDocuments,
  isRecord,
  leafPlanningContexts,
  statusOfUnit,
  unitEntries,
} from "./contracts.js";
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
const DISCOVERY_GENERATION_RESULT_SCHEMA =
  "startup_opportunity.discovery_generation_result.v1" as const;

const TERMINAL_ACTIONS = new Set([
  "terminate_insufficient_evidence",
  "record_runtime_failure",
  "complete_research",
  "cancel_research",
]);

const TERMINAL_LIFECYCLE_STATES = new Set(["published", "partial", "failed", "late_ignored"]);

export function isTerminalAdaptationAction(action: string): boolean {
  return TERMINAL_ACTIONS.has(action);
}

function projectPlanningPhase(
  bundle: DocumentBundle,
  contextPath: string,
  phase: string,
): DocumentBundle {
  return {
    ...bundle,
    documents: bundle.documents.map((entry) => {
      if (entry.path !== contextPath) return entry;
      if (
        entry.document.schema_version === "startup_opportunity.artifact_envelope.current" &&
        entry.document.artifact_type ===
          "startup_opportunity.planning_context.ai_source_bound.current" &&
        isRecord(entry.document.document)
      ) {
        const projectedContext = { ...entry.document.document, phase };
        return {
          path: entry.path,
          document: {
            ...entry.document,
            content_hash: canonicalContentHash(projectedContext),
            document: projectedContext,
          },
        };
      }
      return { path: entry.path, document: { ...entry.document, phase } };
    }),
  };
}

export function terminalOutcomeMatchesAction(action: string, outcome: unknown): boolean {
  switch (action) {
    case "terminate_insufficient_evidence":
      return outcome === "insufficient_evidence";
    case "record_runtime_failure":
      return outcome === "failed" || outcome === "blocked";
    case "complete_research":
      return outcome === "completed" || outcome === "deprioritized";
    case "cancel_research":
      return outcome === "cancelled";
    default:
      return false;
  }
}

function terminalOutcomeMatchesManifest(status: string, outcome: unknown): boolean {
  switch (status) {
    case "completed":
      return outcome === "completed" || outcome === "deprioritized";
    case "insufficient_evidence":
      return outcome === "insufficient_evidence";
    case "failed":
      return outcome === "failed" || outcome === "blocked";
    case "cancelled":
      return outcome === "cancelled";
    default:
      return false;
  }
}

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
  readonly expectedManifestContentHash?: string;
  readonly recoverPlanOperations?: boolean;
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

export interface PlanApplyPreflightResult {
  readonly operationKey: string;
  readonly checkpointRef: string;
  readonly finalManifestContentHash: string;
  readonly terminalReportArtifactPaths: readonly string[];
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
  readonly applied_at: string;
  readonly base_manifest: RunManifest;
  readonly base_manifest_hash: string;
  readonly control_envelope_bindings: readonly ControlEnvelopeBinding[];
  readonly control_envelopes: readonly FormalArtifactEnvelope[];
  readonly checkpoint_envelope: FormalArtifactEnvelope;
  readonly terminal_report_operation: PreparedTerminalReportOperation | null;
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

interface ControlEnvelopeBinding {
  readonly artifact_path: string;
  readonly artifact_type: string;
  readonly content_hash: string;
  readonly envelope_hash: string;
}

export interface PlanOperationRecoveryResult {
  readonly completedOperationKeys: readonly string[];
  readonly pendingOperationKeys: readonly string[];
  readonly pendingControlArtifactRefs: readonly string[];
  readonly candidateBoundOperationKeys: readonly string[];
  readonly historicalDiscoveryPlanBindings: readonly HistoricalDiscoveryPlanBinding[];
}

function historicalDiscoveryPlanBindings(
  receipt: PlanOperationReceipt,
): readonly HistoricalDiscoveryPlanBinding[] {
  if (receipt.schema_version !== DISCOVERY_PLAN_OPERATION_VERSION) {
    return [];
  }
  const planRevisionMatch = receipt.base_plan_ref.match(
    /^plans\/research-plan\.r([1-9][0-9]*)\.json$/u,
  );
  const fallbackPlanRevision =
    planRevisionMatch?.[1] === undefined ? 0 : Number.parseInt(planRevisionMatch[1], 10);
  const candidateBindings = receipt.candidate_bindings ?? [];
  const generationTaskRefs = historicalGenerationTaskRefs(receipt);
  if (candidateBindings.length === 0) {
    return receipt.revision_created
      ? [
          {
            planRef: receipt.base_plan_ref,
            planHash: receipt.base_plan_hash,
            planRevision: fallbackPlanRevision,
            candidateRefs: [],
            ...(generationTaskRefs.length === 0 ? {} : { generationTaskRefs }),
          },
        ]
      : [];
  }
  const revisions = new Set(candidateBindings.map((binding) => binding.plan_revision));
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
      planRevision: candidateBindings[0]?.plan_revision ?? fallbackPlanRevision,
      candidateRefs: uniqueSorted(candidateBindings.map((binding) => binding.candidate_ref)),
      ...(generationTaskRefs.length === 0 ? {} : { generationTaskRefs }),
    },
  ];
}

function historicalGenerationTaskRefs(receipt: PlanOperationReceipt): readonly string[] {
  if (!receipt.revision_created) return [];
  const resultPlanEnvelope = receipt.control_envelopes.find(
    (envelope) =>
      envelope.artifact_path === receipt.result_plan_ref &&
      envelope.artifact_type === "startup_opportunity.research_plan.v1",
  );
  const resultPlan = isRecord(resultPlanEnvelope?.document) ? resultPlanEnvelope.document : null;
  if (resultPlan === null) return [];
  return uniqueSorted(
    unitEntries(resultPlan).flatMap((entry) => {
      const unit = entry.unit;
      const attempt = typeof unit.attempt === "number" ? unit.attempt : null;
      const supersedes =
        typeof unit.supersedes_unit_ref === "string" ? unit.supersedes_unit_ref : "";
      const [planRef = "", supersededUnitId = ""] = supersedes.split("#", 2);
      if (
        unit.required_artifact_schema !== DISCOVERY_GENERATION_RESULT_SCHEMA ||
        attempt === null ||
        !Number.isInteger(attempt) ||
        attempt <= 1 ||
        planRef !== receipt.base_plan_ref ||
        supersededUnitId.length === 0
      ) {
        return [];
      }
      return [`tasks/discovery/${supersededUnitId}.attempt-${String(attempt - 1)}.json`];
    }),
  );
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

function controlEnvelopeBindings(
  envelopes: readonly FormalArtifactEnvelope[],
): readonly ControlEnvelopeBinding[] {
  return envelopes
    .map((envelope) => ({
      artifact_path: envelope.artifact_path,
      artifact_type: envelope.artifact_type,
      content_hash: envelope.content_hash,
      envelope_hash: canonicalContentHash(envelope),
    }))
    .sort((left, right) => left.artifact_path.localeCompare(right.artifact_path));
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRuntimeFailureCloseoutEnvelope(envelope: FormalArtifactEnvelope): boolean {
  return isPlanRuntimeOwnedCloseoutEnvelope(envelope);
}

function nonRevisionControlEnvelopesAreAllowed(receipt: PlanOperationReceipt): boolean {
  return (
    receipt.control_envelopes.length === 0 ||
    (receipt.manifest.status === "failed" &&
      receipt.terminal_report_operation !== null &&
      receipt.control_envelopes.every(isRuntimeFailureCloseoutEnvelope))
  );
}

interface RuntimeFailureAuthority {
  readonly decision: AdaptationInputDocument;
  readonly decisionRef: string;
  readonly gapRefs: readonly string[];
  readonly basisRefs: readonly string[];
  readonly detail: string;
}

interface StoredFormalEnvelope {
  readonly path: string;
  readonly envelope: FormalArtifactEnvelope;
  readonly artifactType: string;
  readonly document: Record<string, unknown>;
  readonly createdAt: string;
}

interface StageUnitDisposition {
  readonly unit_id: string;
  readonly dispatch_task_ref: string;
  readonly dispatch_task_hash: string;
  readonly lifecycle_ref: string | null;
  readonly lifecycle_hash: string | null;
  readonly disposition:
    | "completed"
    | "runtime_failed"
    | "failed"
    | "partial"
    | "late_ignored"
    | "not_started";
}

function runtimeFailureAuthority(
  decisions: readonly AdaptationInputDocument[],
  documents: readonly EffectiveDocument[],
): RuntimeFailureAuthority | null {
  const runtimeDecisions = decisions.filter(
    (decision) => decision.document.action === "record_runtime_failure",
  );
  if (runtimeDecisions.length === 0) return null;
  const decision = runtimeDecisions[0];
  if (decision === undefined || runtimeDecisions.length !== 1) {
    throw new StoreError(
      "apply.runtime_failure_authority_invalid",
      "record_runtime_failure closeout requires one exact Adaptation Decision",
    );
  }
  const byPath = new Map(documents.map((document) => [document.path, document]));
  const triggerGapRefs = strings(decision.document.trigger_gap_refs);
  const runtimeGapRefs = triggerGapRefs.filter((gapRef) => {
    const [gapPath = "", gapId = ""] = gapRef.split("#", 2);
    const snapshot = byPath.get(gapPath);
    if (
      snapshot === undefined ||
      ![
        "startup_opportunity.gap_snapshot.discovery.plan.current",
        "startup_opportunity.gap_snapshot.discovery.readiness.current",
        "startup_opportunity.gap_snapshot.assessment.current",
      ].includes(snapshot.schemaVersion)
    ) {
      return false;
    }
    const gap = records(snapshot.document.gaps).find(
      (candidate) => gapId.length === 0 || candidate.gap_id === gapId,
    );
    return gap?.gap_type === "runtime_blocked" && gap.severity === "blocking";
  });
  if (runtimeGapRefs.length === 0) {
    throw new StoreError(
      "apply.runtime_failure_authority_missing",
      "record_runtime_failure closeout requires a blocking runtime_blocked Gap",
    );
  }
  const detail = canonicalJson({
    action: "record_runtime_failure",
    decision_ref: decision.path,
    gap_refs: uniqueSorted(runtimeGapRefs),
    reason: String(decision.document.reason),
    stop_condition:
      typeof decision.document.stop_condition === "string"
        ? decision.document.stop_condition
        : null,
  });
  return {
    decision,
    decisionRef: decision.path,
    gapRefs: uniqueSorted(runtimeGapRefs),
    basisRefs: uniqueSorted([decision.path, ...runtimeGapRefs]),
    detail,
  };
}

async function authenticatedTrackedFormalEnvelopes(
  runRoot: string,
  runId: string,
  manifest: RunManifest,
  artifacts: ArtifactStore,
): Promise<readonly StoredFormalEnvelope[]> {
  const tracked = new Set(manifest.artifact_refs);
  const ledger = await artifacts.publicationLedgerLocked(runRoot, runId);
  const ledgerByPath = new Map(ledger.map((entry) => [entry.artifactPath, entry]));
  const envelopes: StoredFormalEnvelope[] = [];
  for (const artifactPath of [...tracked].sort()) {
    const ledgerEntry = ledgerByPath.get(artifactPath);
    if (
      ledgerEntry === undefined ||
      ledgerEntry.contentHash !== ledgerEntry.envelope.content_hash ||
      ledgerEntry.envelope.artifact_path !== artifactPath ||
      ledgerEntry.envelope.run_id !== runId ||
      !isFormalArtifactEnvelope(ledgerEntry.envelope)
    ) {
      throw new StoreError(
        "apply.runtime_failure_source_unauthenticated",
        "runtime failure closeout sources must be current Manifest Artifacts with exact Store publication authority",
        { artifactPath },
      );
    }
    const stored = JSON.parse(
      await readFile(await resolveRunPath(runRoot, artifactPath), "utf8"),
    ) as unknown;
    if (canonicalJson(stored) !== canonicalJson(ledgerEntry.envelope)) {
      throw new StoreError(
        "apply.runtime_failure_source_tampered",
        "runtime failure closeout source bytes differ from their exact Store publication receipt",
        { artifactPath },
      );
    }
    await artifacts.validateStoredEnvelope(runRoot, runId, ledgerEntry.envelope);
    envelopes.push({
      path: artifactPath,
      envelope: ledgerEntry.envelope,
      artifactType: ledgerEntry.envelope.artifact_type,
      document: ledgerEntry.envelope.document,
      createdAt: ledgerEntry.envelope.created_at,
    });
  }
  return envelopes;
}

function latestLifecycleEnvelopes(
  envelopes: readonly StoredFormalEnvelope[],
): readonly StoredFormalEnvelope[] {
  const latest = new Map<string, StoredFormalEnvelope>();
  for (const envelope of envelopes.filter(
    (entry) => entry.artifactType === "startup_opportunity.lane_lifecycle.v1",
  )) {
    const lifecycleId = String(envelope.document.lifecycle_id ?? "");
    const revision = Number(envelope.document.revision);
    const previous = latest.get(lifecycleId);
    if (
      previous === undefined ||
      revision > Number(previous.document.revision) ||
      (revision === Number(previous.document.revision) &&
        envelope.path.localeCompare(previous.path) > 0)
    ) {
      latest.set(lifecycleId, envelope);
    }
  }
  return [...latest.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function runtimeFailureCurrentUnitIds(
  manifest: RunManifest,
  plan: Record<string, unknown>,
): ReadonlySet<string> {
  return new Set(
    unitEntries(plan)
      .map((entry) => String(entry.unit.unit_id))
      .filter((unitId) => ["active", "pending"].includes(statusOfUnit(manifest, unitId))),
  );
}

async function runtimeFailureLaneCloseoutEnvelopes(
  runRoot: string,
  runId: string,
  manifest: RunManifest,
  plan: Record<string, unknown>,
  trackedEnvelopes: readonly StoredFormalEnvelope[],
  authority: RuntimeFailureAuthority,
  createdAt: string,
  envelopeVersion: FormalArtifactEnvelope["schema_version"],
  artifacts: ArtifactStore,
): Promise<readonly FormalArtifactEnvelope[]> {
  const currentUnitIds = runtimeFailureCurrentUnitIds(manifest, plan);
  const closeouts: FormalArtifactEnvelope[] = [];
  for (const lifecycle of latestLifecycleEnvelopes(trackedEnvelopes)) {
    const unitId = String(lifecycle.document.unit_id ?? "");
    if (
      !currentUnitIds.has(unitId) ||
      TERMINAL_LIFECYCLE_STATES.has(String(lifecycle.document.state))
    ) {
      continue;
    }
    await artifacts.validateStoredEnvelope(runRoot, runId, lifecycle.envelope);
    const revision = Number(lifecycle.document.revision);
    if (!Number.isInteger(revision) || revision < 1) {
      throw new StoreError(
        "apply.runtime_failure_lifecycle_invalid",
        "runtime failure closeout requires a valid current lifecycle revision",
        { lifecycleRef: lifecycle.path },
      );
    }
    const nextDocument: Record<string, unknown> = structuredClone(lifecycle.document);
    nextDocument.revision = revision + 1;
    nextDocument.parent_lifecycle_ref = lifecycle.path;
    nextDocument.state = "failed";
    nextDocument.timestamps = {
      ...(isRecord(lifecycle.document.timestamps) ? lifecycle.document.timestamps : {}),
      ended_at: createdAt,
    };
    nextDocument.failure = {
      kind: "runtime_blocked",
      detail: authority.detail,
      retryable: false,
    };
    nextDocument.limitations = uniqueSorted([
      ...strings(lifecycle.document.limitations),
      "Runtime blocker closed this execution attempt without changing research conclusions.",
    ]);
    const artifactPath = canonicalLaneLifecyclePath(nextDocument, Number(nextDocument.revision));
    closeouts.push(
      envelope(
        runId,
        artifactPath,
        nextDocument,
        "main_agent",
        uniqueSorted([
          lifecycle.path,
          ...authority.basisRefs,
          String(lifecycle.document.dispatch_batch_ref).split("#", 1)[0] ?? "",
          String(lifecycle.document.task_ref).split("#", 1)[0] ?? "",
          ...(typeof lifecycle.document.launch_registration_ref === "string"
            ? [lifecycle.document.launch_registration_ref]
            : []),
        ]).filter((ref) => ref.length > 0),
        createdAt,
        envelopeVersion,
      ),
    );
  }
  return closeouts;
}

function closeoutPathKey(ref: unknown): string {
  return typeof ref === "string" ? (ref.split("#", 1)[0] ?? ref) : "";
}

function lifecycleCloseoutRefsForDispatch(
  dispatchPath: string,
  lifecycleCloseouts: readonly FormalArtifactEnvelope[],
): readonly string[] {
  return lifecycleCloseouts
    .filter(
      (lifecycle) =>
        closeoutPathKey(lifecycle.document.dispatch_batch_ref) === dispatchPath &&
        lifecycle.artifact_type === "startup_opportunity.lane_lifecycle.v1",
    )
    .map((lifecycle) => lifecycle.artifact_path)
    .sort();
}

function storedControlEnvelope(envelope: FormalArtifactEnvelope): StoredFormalEnvelope {
  return {
    path: envelope.artifact_path,
    envelope,
    artifactType: envelope.artifact_type,
    document: envelope.document,
    createdAt: envelope.created_at,
  };
}

function compareLifecycleAttempts(left: StoredFormalEnvelope, right: StoredFormalEnvelope): number {
  const attempt = Number(left.document.attempt) - Number(right.document.attempt);
  if (attempt !== 0) return attempt;
  const revision = Number(left.document.revision) - Number(right.document.revision);
  if (revision !== 0) return revision;
  return left.path.localeCompare(right.path);
}

function latestLifecycleForDispatchTask(
  envelopes: readonly StoredFormalEnvelope[],
  dispatchTaskRef: string,
  unitId: string,
): StoredFormalEnvelope | null {
  return (
    envelopes
      .filter(
        (entry) =>
          entry.artifactType === "startup_opportunity.lane_lifecycle.v1" &&
          entry.document.dispatch_batch_ref === dispatchTaskRef &&
          entry.document.task_ref === dispatchTaskRef &&
          entry.document.unit_id === unitId,
      )
      .sort(compareLifecycleAttempts)
      .at(-1) ?? null
  );
}

function lifecycleDisposition(
  lifecycle: StoredFormalEnvelope | null,
): "completed" | "runtime_failed" | "failed" | "partial" | "late_ignored" | null {
  if (lifecycle === null) return null;
  const state = String(lifecycle.document.state);
  if (state === "published") return "completed";
  if (state === "partial") return "partial";
  if (state === "late_ignored") return "late_ignored";
  if (state === "failed") {
    const failure = isRecord(lifecycle.document.failure) ? lifecycle.document.failure : {};
    return failure.kind === "runtime_blocked" ? "runtime_failed" : "failed";
  }
  return null;
}

function resultDisposition(
  envelopes: readonly StoredFormalEnvelope[],
  task: Record<string, unknown>,
  unitId: string,
): StageUnitDisposition["disposition"] | null {
  const outputPath =
    typeof task.allowed_output_path === "string"
      ? task.allowed_output_path
      : typeof task.submission_path === "string"
        ? task.submission_path
        : null;
  const requiredSchema =
    typeof task.required_artifact_schema === "string"
      ? task.required_artifact_schema
      : typeof task.submission_schema === "string"
        ? task.submission_schema
        : null;
  if (outputPath === null || requiredSchema === null) return null;
  const result = envelopes.find(
    (entry) =>
      entry.path === outputPath &&
      entry.artifactType === requiredSchema &&
      entry.document.unit_id === unitId,
  );
  if (result === undefined) return null;
  const status = String(result.document.status ?? result.document.branch_status ?? "");
  if (status === "failed") return "failed";
  if (status === "partial") return "partial";
  if (status === "late_ignored") return "late_ignored";
  return "completed";
}

function manifestDisposition(
  manifest: RunManifest,
  unitId: string,
): StageUnitDisposition["disposition"] | null {
  const state = statusOfUnit(manifest, unitId);
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  return null;
}

function stageCloseoutAlreadyTracked(
  executionRef: string,
  dispatchRef: string,
  stageId: string,
  envelopes: readonly StoredFormalEnvelope[],
): boolean {
  return envelopes.some(
    (entry) =>
      entry.artifactType === "startup_opportunity.execution_stage_closeout.v1" &&
      entry.document.execution_plan_ref === executionRef &&
      entry.document.dispatch_ref === dispatchRef &&
      entry.document.stage_id === stageId,
  );
}

function stageAlreadyClosedByResearchArtifact(
  executionRef: string,
  stageId: string,
  envelopes: readonly StoredFormalEnvelope[],
): boolean {
  return envelopes.some(
    (entry) =>
      (entry.artifactType === "startup_opportunity.discovery_stage_readiness.v1" &&
        entry.document.execution_plan_ref === executionRef &&
        entry.document.stage_id === stageId) ||
      (entry.artifactType === "startup_opportunity.assessment_stage_gate.v1" &&
        entry.document.execution_plan_ref === executionRef &&
        entry.document.stage_id === stageId),
  );
}

function runtimeFailureExecutionStageCloseout(
  runId: string,
  manifest: RunManifest,
  execution: StoredFormalEnvelope,
  dispatch: StoredFormalEnvelope,
  stage: Record<string, unknown>,
  stageIndex: number,
  authority: RuntimeFailureAuthority,
  basisRefs: readonly string[],
  lifecyclePool: readonly StoredFormalEnvelope[],
  currentUnitIds: ReadonlySet<string>,
  createdAt: string,
): { readonly path: string; readonly document: Record<string, unknown> } {
  const stageId = String(stage.stage_id ?? "");
  const stageKind = String(stage.stage_kind ?? "");
  const dispatchRef = dispatch.path;
  const dispatchHash = canonicalContentHash(dispatch.document);
  const executionHash = canonicalContentHash(execution.document);
  const stageTasks = [...records(dispatch.document.tasks)].sort((left, right) =>
    String(left.unit_id).localeCompare(String(right.unit_id)),
  );
  if (stageTasks.length === 0) {
    throw new StoreError(
      "apply.runtime_failure_stage_binding_invalid",
      "runtime failure stage closeout requires at least one Dispatch task",
      { dispatchRef },
    );
  }
  const dispositions: StageUnitDisposition[] = stageTasks.map((task) => {
    const unitId = String(task.unit_id ?? "");
    const taskId = String(task.task_id ?? "");
    const dispatchTaskRef = `${dispatchRef}#${taskId}`;
    const lifecycle = latestLifecycleForDispatchTask(lifecyclePool, dispatchTaskRef, unitId);
    const lifecycleStateDisposition = lifecycleDisposition(lifecycle);
    const resultStateDisposition = resultDisposition(lifecyclePool, task, unitId);
    const disposition =
      lifecycleStateDisposition ??
      resultStateDisposition ??
      manifestDisposition(manifest, unitId) ??
      "not_started";
    const bindsLifecycle =
      lifecycle !== null &&
      (lifecycleStateDisposition !== null ||
        (disposition === "runtime_failed" && currentUnitIds.has(unitId)));
    return {
      unit_id: unitId,
      dispatch_task_ref: dispatchTaskRef,
      dispatch_task_hash: dispatchHash,
      lifecycle_ref: bindsLifecycle ? lifecycle.path : null,
      lifecycle_hash: bindsLifecycle ? canonicalContentHash(lifecycle.document) : null,
      disposition,
    };
  });
  const unexpectedOpen = dispositions.find((disposition) => {
    if (disposition.lifecycle_ref === null) return false;
    const lifecycle = lifecyclePool.find((entry) => entry.path === disposition.lifecycle_ref);
    return (
      lifecycle !== undefined &&
      !TERMINAL_LIFECYCLE_STATES.has(String(lifecycle.document.state)) &&
      currentUnitIds.has(String(disposition.unit_id))
    );
  });
  if (unexpectedOpen !== undefined) {
    throw new StoreError(
      "apply.runtime_failure_lifecycle_closeout_missing",
      "runtime failure stage closeout cannot leave a current Dispatch lifecycle open",
      { unitId: unexpectedOpen.unit_id, lifecycleRef: unexpectedOpen.lifecycle_ref },
    );
  }
  const completedUnitIds = dispositions
    .filter((disposition) => disposition.disposition === "completed")
    .map((disposition) => disposition.unit_id);
  const failedUnitIds = dispositions
    .filter((disposition) => ["runtime_failed", "failed"].includes(String(disposition.disposition)))
    .map((disposition) => disposition.unit_id);
  const notStartedUnitIds = dispositions
    .filter((disposition) => disposition.disposition === "not_started")
    .map((disposition) => disposition.unit_id);
  const incompleteUnitIds = dispositions
    .filter((disposition) => disposition.disposition !== "completed")
    .map((disposition) => disposition.unit_id);
  const startedUnitIds = dispositions
    .filter(
      (disposition) =>
        disposition.lifecycle_ref !== null || disposition.disposition !== "not_started",
    )
    .map((disposition) => disposition.unit_id);
  const startedAt = String(
    dispatch.document.dispatch_requested_at ?? dispatch.document.requested_at ?? createdAt,
  );
  const document: Record<string, unknown> = {
    schema_version: "startup_opportunity.execution_stage_closeout.v1",
    closeout_id: "stage_closeout_pending",
    revision: 1,
    run_id: runId,
    mode: manifest.mode,
    research_plan_ref: manifest.current_plan_ref,
    execution_plan_ref: execution.path,
    execution_plan_hash: executionHash,
    dispatch_ref: dispatchRef,
    dispatch_hash: dispatchHash,
    stage_id: stageId,
    stage_kind: stageKind,
    stage_index: stageIndex,
    stage_state: "failed",
    failure: {
      kind: "runtime_blocked",
      detail: authority.detail,
      retryable: false,
    },
    started_at: startedAt,
    ended_at: createdAt,
    started_unit_ids: uniqueSorted(startedUnitIds),
    completed_unit_ids: uniqueSorted(completedUnitIds),
    failed_unit_ids: uniqueSorted(failedUnitIds),
    incomplete_unit_ids: uniqueSorted(incompleteUnitIds),
    not_started_unit_ids: uniqueSorted(notStartedUnitIds),
    unit_dispositions: dispositions.sort((left, right) =>
      String(left.unit_id).localeCompare(String(right.unit_id)),
    ),
    basis_refs: basisRefs,
    limitations: [
      "Runtime blocker closed this execution stage without changing research conclusions.",
    ],
  };
  document.closeout_id = canonicalExecutionStageCloseoutId(document);
  return {
    path: canonicalExecutionStageCloseoutPath(document),
    document,
  };
}

async function runtimeFailureStageCloseoutEnvelopes(
  runRoot: string,
  runId: string,
  manifest: RunManifest,
  plan: Record<string, unknown>,
  trackedEnvelopes: readonly StoredFormalEnvelope[],
  lifecycleCloseouts: readonly FormalArtifactEnvelope[],
  authority: RuntimeFailureAuthority,
  createdAt: string,
  envelopeVersion: FormalArtifactEnvelope["schema_version"],
  artifacts: ArtifactStore,
): Promise<readonly FormalArtifactEnvelope[]> {
  const closeouts: FormalArtifactEnvelope[] = [];
  const envelopesByPath = new Map(trackedEnvelopes.map((entry) => [entry.path, entry]));
  const seenStages = new Set<string>();
  const dispatchTypes = [
    "startup_opportunity.dispatch_batch.discovery.current",
    "startup_opportunity.dispatch_batch.assessment.current",
  ];
  const dispatches = trackedEnvelopes
    .filter(
      (entry) =>
        dispatchTypes.includes(entry.artifactType) &&
        entry.document.run_id === runId &&
        entry.document.research_plan_ref === manifest.current_plan_ref,
    )
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const dispatch of dispatches) {
    const executionRef = String(dispatch.document.execution_plan_ref ?? "");
    const execution = envelopesByPath.get(executionRef);
    const stageId = String(dispatch.document.stage_id ?? "");
    const expectedExecutionType =
      dispatch.artifactType === "startup_opportunity.dispatch_batch.assessment.current"
        ? "startup_opportunity.research_execution_plan.assessment.current"
        : "startup_opportunity.research_execution_plan.discovery.current";
    if (execution === undefined || execution.artifactType !== expectedExecutionType) {
      throw new StoreError(
        "apply.runtime_failure_stage_binding_invalid",
        "runtime failure closeout requires the current Dispatch execution plan",
        { dispatchRef: dispatch.path, executionRef, expectedExecutionType },
      );
    }
    const stages = records(execution.document.stages);
    const stageIndex = stages.findIndex((candidate) => candidate.stage_id === stageId);
    const stage = stageIndex < 0 ? undefined : stages[stageIndex];
    if (stage === undefined) {
      throw new StoreError(
        "apply.runtime_failure_stage_binding_invalid",
        "runtime failure closeout requires the Dispatch stage in the execution plan",
        { dispatchRef: dispatch.path, executionRef, stageId },
      );
    }
    const stageKey = `${executionRef}#${stageId}#${dispatch.path}`;
    const currentUnitIds = runtimeFailureCurrentUnitIds(manifest, plan);
    const lifecyclePool = [
      ...trackedEnvelopes,
      ...lifecycleCloseouts.map((closeout) => storedControlEnvelope(closeout)),
    ];
    if (
      seenStages.has(stageKey) ||
      stageCloseoutAlreadyTracked(executionRef, dispatch.path, stageId, trackedEnvelopes) ||
      stageAlreadyClosedByResearchArtifact(executionRef, stageId, trackedEnvelopes)
    ) {
      continue;
    }
    seenStages.add(stageKey);
    await artifacts.validateStoredEnvelope(runRoot, runId, dispatch.envelope);
    await artifacts.validateStoredEnvelope(runRoot, runId, execution.envelope);
    const lifecycleRefs = lifecycleCloseoutRefsForDispatch(dispatch.path, lifecycleCloseouts);
    const basisRefs = uniqueSorted([...authority.basisRefs, dispatch.path, ...lifecycleRefs]);
    const stageCloseout = runtimeFailureExecutionStageCloseout(
      runId,
      manifest,
      execution,
      dispatch,
      stage,
      stageIndex,
      authority,
      basisRefs,
      lifecyclePool,
      currentUnitIds,
      createdAt,
    );
    closeouts.push(
      envelope(
        runId,
        stageCloseout.path,
        stageCloseout.document,
        "harness",
        uniqueSorted([
          executionRef,
          dispatch.path,
          ...basisRefs,
          ...(manifest.mode === "concept_evidence_assessment" &&
          typeof execution.document.concept_hypothesis_ref === "string"
            ? [execution.document.concept_hypothesis_ref]
            : []),
        ]),
        createdAt,
        envelopeVersion,
      ),
    );
  }
  return closeouts;
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

function manifestMatchesExactBase(left: Record<string, unknown>, right: RunManifest): boolean {
  return (
    canonicalJson(left) === canonicalJson(right) &&
    canonicalContentHash(left) === canonicalContentHash(right)
  );
}

function assertSuppliedManifestMatchesCurrent(
  suppliedManifest: EffectiveDocument,
  manifest: RunManifest,
): void {
  const suppliedManifestHash = canonicalContentHash(suppliedManifest.document);
  const currentManifestHash = canonicalContentHash(manifest);
  if (
    canonicalJson(suppliedManifest.document) !== canonicalJson(manifest) ||
    suppliedManifestHash !== currentManifestHash
  ) {
    throw new StoreError(
      "apply.stale_input_bundle",
      "adaptation bundle does not bind the exact on-disk current Manifest for this Plan operation",
      {
        expected: currentManifestHash,
        actual: suppliedManifestHash,
      },
    );
  }
}

function suppliedManifestAuthenticatesReceipt(
  suppliedManifest: EffectiveDocument | undefined,
  manifest: RunManifest,
  receipt: PlanOperationReceipt,
): boolean {
  if (
    suppliedManifest?.schemaVersion !== "startup_opportunity.run_manifest.v1" ||
    suppliedManifest.document.run_id !== receipt.run_id
  ) {
    return false;
  }
  const suppliedManifestHash = canonicalContentHash(suppliedManifest.document);
  return (
    (canonicalJson(suppliedManifest.document) === canonicalJson(receipt.base_manifest) &&
      suppliedManifestHash === receipt.base_manifest_hash) ||
    (canonicalJson(suppliedManifest.document) === canonicalJson(manifest) &&
      suppliedManifestHash === canonicalContentHash(manifest))
  );
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
    "applied_at",
    "base_manifest",
    "base_manifest_hash",
    "control_envelope_bindings",
    "control_envelopes",
    "checkpoint_envelope",
    "terminal_report_operation",
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
    typeof value.applied_at !== "string" ||
    !isRecord(value.base_manifest) ||
    !isSha256(value.base_manifest_hash) ||
    !Array.isArray(value.control_envelope_bindings) ||
    !Array.isArray(value.control_envelopes) ||
    !isRecord(value.checkpoint_envelope) ||
    (value.terminal_report_operation !== null && !isRecord(value.terminal_report_operation)) ||
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
  const planOperationKey = operationKey("apply_plan_revision", {
    parent_plan_hash: receipt.base_plan_hash,
    base_manifest_hash: receipt.base_manifest_hash,
    adaptation_refs: uniqueSorted(
      receipt.adaptation_refs.filter((ref): ref is string => typeof ref === "string"),
    ),
  });
  const expectedOperationKey =
    receipt.terminal_report_operation === null
      ? planOperationKey
      : operationKey("apply_terminal_closeout", {
          plan_operation_key: planOperationKey,
          report_request_hash: canonicalContentHash(
            receipt.terminal_report_operation.request_envelope,
          ),
        });
  if (
    filename !== path.basename(receiptPath(receipt.operation_key)) ||
    receipt.operation_key !== expectedOperationKey ||
    receipt.adaptation_refs.length === 0 ||
    receipt.adaptation_refs.length !== receipt.adaptation_hashes.length ||
    !isUniqueSortedStringArray(receipt.adaptation_refs) ||
    receipt.adaptation_hashes.some((hash) => !isSha256(hash)) ||
    !Number.isFinite(Date.parse(receipt.applied_at)) ||
    receipt.base_manifest.run_id !== runId ||
    receipt.base_manifest.current_plan_ref !== receipt.base_plan_ref ||
    canonicalContentHash(receipt.base_manifest) !== receipt.base_manifest_hash ||
    !manifestSetsAreDisjoint(receipt.base_manifest) ||
    canonicalJson(receipt.control_envelope_bindings) !==
      canonicalJson(controlEnvelopeBindings(receipt.control_envelopes)) ||
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
  const baseManifestValidation = validator.validateDocument(receipt.base_manifest, "manifest.json");
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
    if (receipt.terminal_report_operation !== null) {
      validatePreparedTerminalReportOperation(
        receipt.terminal_report_operation,
        receipt.run_id,
        validator,
      );
    }
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
    !baseManifestValidation.valid ||
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
    ["completed", "failed", "insufficient_evidence", "cancelled"].includes(
      receipt.manifest.status,
    ) !==
      (receipt.terminal_report_operation !== null) ||
    (receipt.terminal_report_operation !== null &&
      [
        receipt.terminal_report_operation.source_envelope,
        ...receipt.terminal_report_operation.derived_envelopes,
      ].some((entry) => !receipt.manifest.artifact_refs.includes(entry.artifact_path))) ||
    (receipt.terminal_report_operation !== null &&
      !terminalOutcomeMatchesManifest(
        receipt.manifest.status,
        receipt.terminal_report_operation.source_envelope.document.terminal_outcome,
      )) ||
    (receipt.revision_created
      ? resultPlanEnvelope?.artifact_type !== "startup_opportunity.research_plan.v1" ||
        resultPlanEnvelope.content_hash !== receipt.result_plan_hash ||
        (receipt.schema_version === ASSESSMENT_PLAN_OPERATION_VERSION &&
          (resultAssessmentPlanEnvelope?.artifact_type !==
            "startup_opportunity.concept_evidence_assessment_plan.v1" ||
            resultAssessmentPlanEnvelope.content_hash !== receipt.result_assessment_plan_hash))
      : !nonRevisionControlEnvelopesAreAllowed(receipt))
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
    const terminalActions: string[] = [];
    const sourceDocuments = new Map<string, EffectiveDocument>();
    const decisions: AdaptationInputDocument[] = [];
    const addSourceDocument = (documentPath: string, document: Record<string, unknown>) => {
      sourceDocuments.set(documentPath, {
        path: documentPath,
        schemaVersion: String(document.schema_version ?? ""),
        document,
        envelope: null,
      });
    };
    addSourceDocument("manifest.json", receipt.base_manifest as unknown as Record<string, unknown>);
    const basePlan = await storedEffectiveDocument(runRoot, receipt.base_plan_ref);
    addSourceDocument(receipt.base_plan_ref, basePlan);
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
      addSourceDocument(adaptationRef, decision);
      decisions.push({ path: adaptationRef, document: decision });
      if (canonicalContentHash(decision) !== receipt.adaptation_hashes[index]) {
        throw new Error("adaptation hash mismatch");
      }
      if (typeof decision.action === "string" && TERMINAL_ACTIONS.has(decision.action)) {
        terminalActions.push(decision.action);
      }
      if (decision.requested_by === "user") {
        if (typeof decision.user_decision_ref !== "string") {
          throw new Error("user decision ref missing");
        }
        const userDecision = await logs.readExactRecord(
          runRoot,
          receipt.run_id,
          decision.user_decision_ref,
          "decisions.jsonl",
        );
        const legacyCancellationAuthority =
          userDecision.schema_version === "startup_opportunity.decision.v1" &&
          userDecision.decision_type === "run_cancelled" &&
          userDecision.actor === "user";
        const preCandidateStopAuthority =
          userDecision.schema_version === "startup_opportunity.decision.v1" &&
          userDecision.decision_type === "pre_candidate_interest_confirmed" &&
          userDecision.actor === "main_agent" &&
          userDecision.pre_candidate_next_action === "stop_current_run" &&
          userDecision.confirmation_basis === "caller_attested_user_confirmation" &&
          userDecision.harness_identity_verification === "not_available";
        if (
          decision.action === "cancel_research" &&
          (userDecision.run_id !== receipt.run_id ||
            (!legacyCancellationAuthority && !preCandidateStopAuthority))
        ) {
          throw new Error("cancellation authority mismatch");
        }
      }
      if (Array.isArray(decision.trigger_gap_refs)) {
        for (const gapRef of decision.trigger_gap_refs) {
          if (typeof gapRef !== "string") {
            continue;
          }
          const [gapPath = "", gapId] = gapRef.split("#", 2);
          const gap = await storedEffectiveDocument(runRoot, gapPath);
          addSourceDocument(gapPath, gap);
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
    if (
      receipt.terminal_report_operation === null
        ? terminalActions.length !== 0
        : terminalActions.length !== 1 ||
          !terminalOutcomeMatchesAction(
            terminalActions[0] as string,
            receipt.terminal_report_operation.source_envelope.document.terminal_outcome,
          )
    ) {
      throw new Error("terminal Adaptation action mismatch");
    }
    if (terminalActions[0] === "record_runtime_failure") {
      const authority = runtimeFailureAuthority(decisions, [...sourceDocuments.values()]);
      if (authority === null) {
        throw new Error("runtime failure authority missing");
      }
      const trackedEnvelopes = await authenticatedTrackedFormalEnvelopes(
        runRoot,
        receipt.run_id,
        receipt.base_manifest,
        artifacts,
      );
      const lifecycleCloseouts = await runtimeFailureLaneCloseoutEnvelopes(
        runRoot,
        receipt.run_id,
        receipt.base_manifest,
        basePlan,
        trackedEnvelopes,
        authority,
        receipt.applied_at,
        "startup_opportunity.artifact_envelope.current",
        artifacts,
      );
      const stageCloseouts = await runtimeFailureStageCloseoutEnvelopes(
        runRoot,
        receipt.run_id,
        receipt.base_manifest,
        basePlan,
        trackedEnvelopes,
        lifecycleCloseouts,
        authority,
        receipt.applied_at,
        "startup_opportunity.artifact_envelope.current",
        artifacts,
      );
      const expectedCloseouts = [...lifecycleCloseouts, ...stageCloseouts];
      const actualCloseouts = receipt.control_envelopes.filter(isRuntimeFailureCloseoutEnvelope);
      if (
        canonicalJson(actualCloseouts) !== canonicalJson(expectedCloseouts) ||
        receipt.control_envelopes.some(
          (controlEnvelope) => !isRuntimeFailureCloseoutEnvelope(controlEnvelope),
        )
      ) {
        throw new Error("runtime failure closeout drift");
      }
    }
  } catch (error) {
    throw new StoreError(
      "recovery.invalid_plan_operation",
      "Plan operation receipt source hashes do not match immutable artifacts",
      {
        operationKey: receipt.operation_key,
        cause: error instanceof Error ? error.message : String(error),
      },
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

function mergeCandidateBindings(
  ...groups: readonly (readonly PlanCandidateBinding[])[]
): readonly PlanCandidateBinding[] {
  const byRef = new Map<string, PlanCandidateBinding>();
  for (const binding of groups.flat()) {
    const existing = byRef.get(binding.candidate_ref);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(binding)) {
      throw new StoreError(
        "adaptation.discovery_candidate_binding_conflict",
        "candidate-bound Plan receipt contains conflicting candidate membership bytes",
        { candidateRef: binding.candidate_ref },
      );
    }
    byRef.set(binding.candidate_ref, binding);
  }
  return [...byRef.values()].sort((left, right) =>
    left.candidate_ref.localeCompare(right.candidate_ref),
  );
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
  if (
    decisions.length !== 1 ||
    decisions[0]?.document.action !== "reconcile_scope" ||
    decisions[0].document.based_on_plan_ref !== manifest.current_plan_ref
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
  return decisions.every((decision) =>
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
  if (
    receipt.terminal_report_operation !== null &&
    !(await preparedTerminalReportIsDurableLocked(
      runRoot,
      receipt.terminal_report_operation,
      artifacts,
    ))
  ) {
    return false;
  }
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
  terminalReportFaultAt?: ReportFaultBoundary,
): Promise<{
  readonly changed: boolean;
  readonly terminalReport: BuildReportResult | null;
}> {
  let changed = false;
  let terminalReport: BuildReportResult | null = null;
  const current = await readManifest(runRoot, validator);
  const currentManifestHash = canonicalContentHash(current);
  const currentMatchesReceiptBase =
    canonicalJson(current) === canonicalJson(receipt.base_manifest) &&
    currentManifestHash === receipt.base_manifest_hash;
  const currentMatchesReceiptResult = canonicalJson(current) === canonicalJson(receipt.manifest);
  if (
    current.current_plan_ref !== receipt.base_plan_ref &&
    current.current_plan_ref !== receipt.result_plan_ref
  ) {
    throw new StoreError("apply.stale_base", "manifest current plan changed before CAS", {
      expectedBase: receipt.base_plan_ref,
      actual: current.current_plan_ref,
    });
  }
  const publishControlEnvelopes = async (): Promise<boolean> => {
    if (receipt.control_envelopes.length > 1) {
      const publishControlBundle = receipt.control_envelopes.every(isRuntimeFailureCloseoutEnvelope)
        ? artifacts.publishPlanRuntimeCloseoutBundleLocked.bind(artifacts)
        : artifacts.publishBundleLocked.bind(artifacts);
      return (
        (
          await publishControlBundle(
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
      );
    }
    const controlEnvelope = receipt.control_envelopes[0];
    if (controlEnvelope === undefined) return false;
    const publishControl = isRuntimeFailureCloseoutEnvelope(controlEnvelope)
      ? artifacts.publishPlanRuntimeCloseoutLocked.bind(artifacts)
      : artifacts.publishLocked.bind(artifacts);
    return (
      (
        await publishControl(runRoot, {
          runId: receipt.run_id,
          envelope: controlEnvelope,
        })
      ).status === "published"
    );
  };

  if (currentMatchesReceiptResult) {
    await validateStoredControlEnvelopes(runRoot, receipt, artifacts);
    assertFault("after_control_artifacts", faultAt);
    if (receipt.terminal_report_operation !== null) {
      if (
        !(await preparedTerminalReportIsDurableLocked(
          runRoot,
          receipt.terminal_report_operation,
          artifacts,
        ))
      ) {
        throw new StoreError(
          "recovery.terminal_report_missing_after_commit",
          "terminal Manifest is committed but its immutable report operation is incomplete",
          { operationKey: receipt.operation_key },
        );
      }
      terminalReport = thisTerminalReportResult(receipt.terminal_report_operation);
    }
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
    return {
      changed: (await appendOperationEvents(runRoot, receipt.run_id, receipt, logs)) || changed,
      terminalReport,
    };
  }

  if (current.current_plan_ref === receipt.base_plan_ref && !currentMatchesReceiptBase) {
    throw new StoreError(
      "apply.base_manifest_conflict",
      "current Manifest differs from the exact receipt-authenticated base Manifest before CAS",
      {
        operationKey: receipt.operation_key,
        expected: receipt.base_manifest_hash,
        actual: currentManifestHash,
      },
    );
  }

  if (current.current_plan_ref !== receipt.base_plan_ref) {
    throw new StoreError(
      "apply.result_manifest_conflict",
      "current plan matches the result but manifest content differs from the operation receipt",
    );
  }
  if (!currentMatchesReceiptBase) {
    throw new StoreError(
      "apply.base_manifest_conflict",
      "Plan operation cannot publish closeout artifacts from a mutated base Manifest",
      {
        operationKey: receipt.operation_key,
        expected: receipt.base_manifest_hash,
        actual: currentManifestHash,
      },
    );
  }
  if (await publishControlEnvelopes()) {
    changed = true;
  }
  assertFault("after_control_artifacts", faultAt);
  if (receipt.terminal_report_operation !== null) {
    terminalReport = await completePreparedTerminalReportLocked(
      runRoot,
      receipt.terminal_report_operation,
      artifacts,
      validator,
      terminalReportFaultAt,
    );
    if (terminalReport.status === "published") changed = true;
  }
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
  return {
    changed: (await appendOperationEvents(runRoot, receipt.run_id, receipt, logs)) || changed,
    terminalReport,
  };
}

function thisTerminalReportResult(operation: PreparedTerminalReportOperation): BuildReportResult {
  return {
    schemaVersion: "startup_opportunity.build_report_result.v1",
    runId: operation.run_id,
    status: "idempotent_replay",
    formalArtifactPaths: [
      operation.source_envelope.artifact_path,
      ...operation.derived_envelopes.map((entry) => entry.artifact_path),
    ],
    materializedPaths: operation.materialized_outputs.map((entry) => entry.target_path),
    consistencyEvaluationRef: operation.derived_envelopes[2]?.artifact_path ?? "",
  };
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

  async hasExactOperation(runId: string, requestedOperationKey: string): Promise<boolean> {
    validateRunId(runId);
    const runRoot = await openRunDirectoryReadOnly(this.runsRoot, runId);
    try {
      const filename = await resolveRunPath(runRoot, receiptPath(requestedOperationKey));
      const receipt = validateReceipt(
        JSON.parse(await readFile(filename, "utf8")) as unknown,
        path.basename(filename),
        runId,
      );
      validateReceiptDocuments(receipt, this.validator, this.artifacts);
      await validateReceiptSources(runRoot, receipt, this.logs, this.artifacts);
      return true;
    } catch (error) {
      if (
        isNodeError(error, "ENOENT") ||
        (error instanceof StoreError && error.code === "path.parent_missing")
      ) {
        return false;
      }
      throw error;
    }
  }

  async preflight(input: ApplyPlanRevisionInput): Promise<PlanApplyPreflightResult> {
    validateRunId(input.runId);
    const runRoot = await openRunDirectoryReadOnly(this.runsRoot, input.runId);
    return withRunLock(runRoot, () => this.preflightLocked(runRoot, input));
  }

  async apply(input: ApplyPlanRevisionInput): Promise<PlanApplyResult> {
    validateRunId(input.runId);
    const selected = effectiveDocuments(input.adaptationBundle).filter((document) =>
      input.adaptationRefs.includes(document.path),
    );
    const terminalActions = selected
      .map((document) => String(document.document.action))
      .filter((action) => TERMINAL_ACTIONS.has(action));
    const requiresTerminalReport = terminalActions.length > 0;
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
        terminalActions.length !== 1 ||
        !terminalOutcomeMatchesAction(
          terminalActions[0] as string,
          source.document.terminal_outcome,
        ) ||
        !input.adaptationRefs.every((ref) => source.input_refs.includes(ref))
      ) {
        throw new StoreError(
          "apply.terminal_report_source_invalid",
          "terminal report source must be valid, bound to one terminal action, and use its exact outcome",
          { errors: validation.errors },
        );
      }
    }
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, () => this.applyLocked(runRoot, input));
  }

  private async preflightLocked(
    runRoot: string,
    input: ApplyPlanRevisionInput,
  ): Promise<PlanApplyPreflightResult> {
    const prepared = await this.prepareOperationLocked(runRoot, input, {
      allowExistingReceipt: false,
      allowPendingRecovery: false,
    });
    return {
      operationKey: prepared.receipt.operation_key,
      checkpointRef: prepared.receipt.checkpoint_envelope.artifact_path,
      finalManifestContentHash: canonicalContentHash(prepared.receipt.manifest),
      terminalReportArtifactPaths:
        prepared.receipt.terminal_report_operation === null
          ? []
          : terminalReportArtifactPaths(input.terminalReportEnvelope?.artifact_path ?? ""),
    };
  }

  private async applyLocked(
    runRoot: string,
    input: ApplyPlanRevisionInput,
  ): Promise<PlanApplyResult> {
    const prepared = await this.prepareOperationLocked(runRoot, input, {
      allowExistingReceipt: true,
      allowPendingRecovery: true,
    });
    if (prepared.existingReceipt !== null) {
      const manifest = await readManifest(runRoot, this.validator);
      if (
        !(await planOperationCompletionIsDurable(
          runRoot,
          manifest,
          prepared.existingReceipt,
          this.artifacts,
          this.logs,
        ))
      ) {
        const completion = await completeOperation(
          runRoot,
          prepared.existingReceipt,
          this.artifacts,
          this.logs,
          this.validator,
          input.faultAt,
          input.terminalReportFaultAt,
        );
        return this.result(
          prepared.existingReceipt,
          "idempotent_replay",
          completion.terminalReport,
        );
      }
      return this.result(prepared.existingReceipt, "idempotent_replay");
    }
    await publishReceipt(runRoot, prepared.receipt);
    assertFault("after_intent", input.faultAt);
    const completion = await completeOperation(
      runRoot,
      prepared.receipt,
      this.artifacts,
      this.logs,
      this.validator,
      input.faultAt,
      input.terminalReportFaultAt,
    );
    return this.result(prepared.receipt, "applied", completion.terminalReport);
  }

  private async prepareOperationLocked(
    runRoot: string,
    input: ApplyPlanRevisionInput,
    _options: {
      readonly allowExistingReceipt: boolean;
      readonly allowPendingRecovery: boolean;
    },
  ): Promise<{
    readonly receipt: PlanOperationReceipt;
    readonly existingReceipt: PlanOperationReceipt | null;
  }> {
    const planOperationRecovery = await recoverPlanRevisionOperationsLocked(
      runRoot,
      input.runId,
      this.validator,
      this.artifacts,
      this.logs,
      false,
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
    const durableCandidateBindings = assessmentAdaptation
      ? []
      : await durableDiscoveryCandidateBindings(
          runRoot,
          manifest,
          input.runId,
          basePlanRef,
          Number(suppliedPlan.document.revision),
          this.artifacts,
        );
    const candidateBindings = assessmentAdaptation
      ? []
      : mergeCandidateBindings(preKillBindings, durableCandidateBindings);
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
    const suppliedManifest = bundleDocuments.find((document) => document.path === "manifest.json");
    if (input.operationKey !== undefined) {
      try {
        const filename = await resolveRunPath(runRoot, receiptPath(input.operationKey), {
          createParents: true,
        });
        const exactReceipt = validateReceipt(
          JSON.parse(await readFile(filename, "utf8")) as unknown,
          path.basename(filename),
          input.runId,
        );
        validateReceiptDocuments(exactReceipt, this.validator, this.artifacts);
        await validateReceiptSources(runRoot, exactReceipt, this.logs, this.artifacts);
        const selectedDecisionHashes = selectedDecisions.map((decision) =>
          canonicalContentHash(decision.document),
        );
        const terminalRequestMatches =
          (input.terminalReportEnvelope === undefined) ===
            (exactReceipt.terminal_report_operation === null) &&
          (input.terminalReportEnvelope === undefined ||
            canonicalJson(input.terminalReportEnvelope) ===
              canonicalJson(exactReceipt.terminal_report_operation?.request_envelope));
        if (
          exactReceipt.base_plan_ref === basePlanRef &&
          exactReceipt.base_plan_hash === canonicalContentHash(suppliedPlan.document) &&
          exactReceipt.schema_version ===
            (assessmentAdaptation
              ? ASSESSMENT_PLAN_OPERATION_VERSION
              : DISCOVERY_PLAN_OPERATION_VERSION) &&
          (!assessmentAdaptation ||
            (exactReceipt.schema_version === ASSESSMENT_PLAN_OPERATION_VERSION &&
              exactReceipt.base_assessment_plan_ref === baseAssessmentPlanRef &&
              exactReceipt.base_assessment_plan_hash ===
                canonicalContentHash(suppliedAssessmentPlan?.document ?? {}))) &&
          canonicalJson(exactReceipt.adaptation_refs) === canonicalJson(selectedRefs) &&
          canonicalJson(exactReceipt.adaptation_hashes) === canonicalJson(selectedDecisionHashes) &&
          terminalRequestMatches &&
          suppliedManifestAuthenticatesReceipt(suppliedManifest, manifest, exactReceipt) &&
          (manifest.current_plan_ref === exactReceipt.result_plan_ref ||
            (manifest.current_plan_ref === exactReceipt.base_plan_ref &&
              manifestMatchesExactBase(manifest, exactReceipt.base_manifest)))
        ) {
          return { receipt: exactReceipt, existingReceipt: exactReceipt };
        }
        throw new StoreError(
          "write.operation_conflict",
          "existing Plan operation receipt differs from the requested exact replay",
          { operationKey: input.operationKey },
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }
    if (
      suppliedManifest?.schemaVersion !== "startup_opportunity.run_manifest.v1" ||
      suppliedManifest.document.run_id !== manifest.run_id ||
      suppliedManifest.document.current_plan_ref !== basePlanRef ||
      suppliedManifest.document.plan_revision !== Number(suppliedPlan.document.revision)
    ) {
      throw new StoreError(
        "apply.stale_input_bundle",
        "adaptation bundle does not bind the exact base Manifest for this Plan operation",
      );
    }
    const baseManifest = suppliedManifest.document as RunManifest;
    const baseManifestHash = canonicalContentHash(baseManifest);
    const planOperationKey = operationKey("apply_plan_revision", {
      parent_plan_hash: canonicalContentHash(suppliedPlan.document),
      base_manifest_hash: baseManifestHash,
      adaptation_refs: selectedRefs,
    });
    const expectedOperationKey =
      input.terminalReportEnvelope === undefined
        ? planOperationKey
        : operationKey("apply_terminal_closeout", {
            plan_operation_key: planOperationKey,
            report_request_hash: canonicalContentHash(input.terminalReportEnvelope),
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
        existingReceipt.base_manifest_hash !== baseManifestHash ||
        canonicalJson(existingReceipt.base_manifest) !== canonicalJson(baseManifest) ||
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
        (input.terminalReportEnvelope === undefined) !==
          (existingReceipt.terminal_report_operation === null) ||
        (input.terminalReportEnvelope !== undefined &&
          canonicalJson(input.terminalReportEnvelope) !==
            canonicalJson(existingReceipt.terminal_report_operation?.request_envelope))
      ) {
        throw new StoreError(
          "write.operation_conflict",
          "Plan operation replay changed its terminal report source bytes",
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
      if (
        manifest.current_plan_ref === existingReceipt.result_plan_ref ||
        (manifest.current_plan_ref === existingReceipt.base_plan_ref &&
          manifestMatchesExactBase(manifest, existingReceipt.base_manifest))
      ) {
        return { receipt: existingReceipt, existingReceipt };
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    assertSuppliedManifestMatchesCurrent(suppliedManifest, manifest);

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

    if (
      input.expectedManifestContentHash !== undefined &&
      canonicalContentHash(manifest) !== input.expectedManifestContentHash
    ) {
      throw new StoreError(
        "apply.manifest_stale",
        "Plan apply input no longer binds the exact current Manifest",
        {
          expected: input.expectedManifestContentHash,
          actual: canonicalContentHash(manifest),
        },
      );
    }

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
    if (
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
    if (transformed.operationKey !== planOperationKey) {
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

    let candidateDocuments: ReadonlyMap<string, EffectiveDocument> | null = null;
    let candidateContext: EffectiveDocument | null = null;
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
      candidateDocuments = documentMap(input.candidateBundle);
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
      const context = candidateContexts[0];
      if (
        candidatePlan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
        canonicalJson(candidatePlan.document) !== canonicalJson(transformed.plan) ||
        (transformedAssessment?.revisionCreated === true &&
          (candidateAssessmentPlan?.schemaVersion !==
            "startup_opportunity.concept_evidence_assessment_plan.v1" ||
            canonicalJson(candidateAssessmentPlan.document) !==
              canonicalJson(transformedAssessment.plan))) ||
        candidateContexts.length !== 1 ||
        context?.document.validation_stage !== "candidate_revision"
      ) {
        throw new StoreError(
          "apply.candidate_transform_mismatch",
          "candidate bundle does not contain the deterministic Plan Revision result",
        );
      }
      candidateContext = context;
    } else if (input.candidateBundle !== undefined) {
      throw new StoreError(
        "apply.unexpected_candidate_bundle",
        "non-revision actions do not accept a candidate plan bundle",
      );
    }

    const currentContexts = leafPlanningContexts(patchedBundle);
    const currentContext = currentContexts.length === 1 ? currentContexts[0] : undefined;
    const candidatePhase = candidateContext?.document.phase;
    // Candidate validation authenticates the transition; this phase-only view is never published.
    const adaptationPolicyBundle =
      currentContext !== undefined && typeof candidatePhase === "string"
        ? projectPlanningPhase(patchedBundle, currentContext.path, candidatePhase)
        : patchedBundle;
    const adaptationValidation = this.adaptations.validateDocumentBundle(
      adaptationPolicyBundle,
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
      selectedDecisions.some((decision) =>
        TERMINAL_ACTIONS.has(String(decision.document.action)),
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

    const controlEnvelopes: FormalArtifactEnvelope[] = [];
    const controlEnvelopeVersion: FormalArtifactEnvelope["schema_version"] =
      "startup_opportunity.artifact_envelope.current";
    const runtimeFailure = runtimeFailureAuthority(
      selectedDecisions,
      effectiveDocuments(patchedBundle),
    );
    const trackedEnvelopes =
      runtimeFailure === null
        ? []
        : await authenticatedTrackedFormalEnvelopes(runRoot, input.runId, manifest, this.artifacts);
    if (candidateContext !== null && candidateDocuments !== null && transformed.plan !== null) {
      const context = candidateContext;
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
    }
    if (runtimeFailure !== null) {
      const lifecycleCloseouts = await runtimeFailureLaneCloseoutEnvelopes(
        runRoot,
        input.runId,
        manifest,
        basePlan,
        trackedEnvelopes,
        runtimeFailure,
        input.createdAt,
        controlEnvelopeVersion,
        this.artifacts,
      );
      controlEnvelopes.push(...lifecycleCloseouts);
      controlEnvelopes.push(
        ...(await runtimeFailureStageCloseoutEnvelopes(
          runRoot,
          input.runId,
          manifest,
          basePlan,
          trackedEnvelopes,
          lifecycleCloseouts,
          runtimeFailure,
          input.createdAt,
          controlEnvelopeVersion,
          this.artifacts,
        )),
      );
    }

    const checkpointRef = `checkpoints/checkpoint-plan-apply-${sha256Hex(
      expectedOperationKey,
    ).slice(0, 20)}.json`;
    const controlPaths = controlEnvelopes.map((item) => item.artifact_path);
    const terminalReportPaths =
      input.terminalReportEnvelope === undefined
        ? []
        : terminalReportArtifactPaths(input.terminalReportEnvelope.artifact_path);
    const finalManifest: RunManifest = {
      ...transformed.manifest,
      updated_at: input.checkpointCreatedAt,
      artifact_refs: uniqueSorted([
        ...transformed.manifest.artifact_refs,
        ...controlPaths,
        ...terminalReportPaths,
      ]),
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
      checkpoint_id: `checkpoint_plan_apply_${sha256Hex(expectedOperationKey).slice(0, 20)}`,
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
    const terminalReportOperation =
      input.terminalReportEnvelope === undefined
        ? null
        : await this.reports.prepareTerminalLocked(runRoot, {
            reportEnvelope: input.terminalReportEnvelope,
            prospectiveManifest: finalManifest,
            supportingEnvelopes: [...controlEnvelopes, checkpointEnvelope],
          });
    const receipt: PlanOperationReceipt = {
      schema_version: assessmentAdaptation
        ? ASSESSMENT_PLAN_OPERATION_VERSION
        : DISCOVERY_PLAN_OPERATION_VERSION,
      operation_key: expectedOperationKey,
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
      applied_at: input.createdAt,
      base_manifest: manifest,
      base_manifest_hash: baseManifestHash,
      control_envelope_bindings: controlEnvelopeBindings(controlEnvelopes),
      control_envelopes: controlEnvelopes,
      checkpoint_envelope: checkpointEnvelope,
      terminal_report_operation: terminalReportOperation,
      manifest: finalManifest,
      events: createEvents(
        input,
        { ...transformed, operationKey: expectedOperationKey },
        checkpointRef,
      ),
    };
    validateReceiptDocuments(receipt, this.validator, this.artifacts);
    if (existingReceipt !== null) {
      if (canonicalJson(existingReceipt) !== canonicalJson(receipt)) {
        throw new StoreError(
          "write.operation_conflict",
          "existing Plan operation receipt differs from the requested replay",
          { operationKey: expectedOperationKey },
        );
      }
      return { receipt: existingReceipt, existingReceipt };
    }
    return { receipt, existingReceipt: null };
  }

  private result(
    receipt: PlanOperationReceipt,
    status: PlanApplyResult["status"],
    terminalReport?: BuildReportResult | null,
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
      terminalReport:
        terminalReport ??
        (receipt.terminal_report_operation === null
          ? null
          : thisTerminalReportResult(receipt.terminal_report_operation)),
    };
  }
}

export async function recoverPlanRevisionOperationsLocked(
  runRoot: string,
  runId: string,
  validator: ArtifactValidator,
  artifacts: ArtifactStore,
  logs: JsonlStore,
  completePendingOperations = true,
): Promise<PlanOperationRecoveryResult> {
  const directory = await resolveRunPath(runRoot, ".store/operations", { createParents: true });
  const completed: string[] = [];
  const pending: string[] = [];
  const pendingControlArtifactRefs: string[] = [];
  const candidateBound: string[] = [];
  const historicalBindings: HistoricalDiscoveryPlanBinding[] = [];
  const recordPending = (receipt: PlanOperationReceipt): void => {
    pending.push(receipt.operation_key);
    pendingControlArtifactRefs.push(
      ...receipt.control_envelopes.map((envelope) => envelope.artifact_path),
    );
  };
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
    }
    if (receipt.schema_version === DISCOVERY_PLAN_OPERATION_VERSION) {
      historicalBindings.push(...historicalDiscoveryPlanBindings(receipt));
    }
    const current = await readManifest(runRoot, validator);
    if (current.current_plan_ref === receipt.result_plan_ref) {
      if (await planOperationCompletionIsDurable(runRoot, current, receipt, artifacts, logs)) {
        continue;
      }
      if (!completePendingOperations) {
        recordPending(receipt);
        continue;
      }
      if ((await completeOperation(runRoot, receipt, artifacts, logs, validator)).changed) {
        completed.push(receipt.operation_key);
      }
    } else if (current.current_plan_ref === receipt.base_plan_ref) {
      if (
        canonicalJson(current) !== canonicalJson(receipt.base_manifest) ||
        canonicalContentHash(current) !== receipt.base_manifest_hash
      ) {
        throw new StoreError(
          "recovery.invalid_plan_operation",
          "pending Plan operation base Manifest differs from the exact on-disk current Manifest",
          {
            operationKey: receipt.operation_key,
            expected: receipt.base_manifest_hash,
            actual: canonicalContentHash(current),
          },
        );
      }
      recordPending(receipt);
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
    pendingControlArtifactRefs: uniqueSorted(pendingControlArtifactRefs),
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

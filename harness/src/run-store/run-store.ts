import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type PlanOperationRecoveryResult,
  recoverPlanRevisionOperationsLocked,
} from "../adaptation/plan-runtime.js";
import {
  ArtifactStore,
  type FormalArtifactEnvelope,
  type PublishArtifactBundleInput,
  type PublishArtifactBundleResult,
  type PublishArtifactInput,
  type PublishArtifactResult,
} from "../artifact-store/artifact-store.js";
import { atomicReplace, publishTemp, writeSyncedTemp } from "../artifact-store/atomic-file.js";
import {
  canonicalContentHash,
  canonicalJson,
  operationKey,
  sha256Hex,
} from "../artifact-store/canonical.js";
import {
  createRunDirectory,
  isNodeError,
  openRunDirectory,
  resolveRunPath,
  validateArtifactRef,
  validateRunId,
} from "../artifact-store/path-policy.js";
import { withRunLock } from "../artifact-store/run-lock.js";
import { StoreError } from "../artifact-store/store-error.js";
import { type EvidenceRecoveryResult, EvidenceStore } from "../evidence-store/evidence-store.js";
import {
  type ReportRecoveryResult,
  recoverReportOperationsLocked,
} from "../reporting/report-runtime.js";
import type { ArtifactValidator, DocumentBundleEntry } from "../validators/artifact-validator.js";
import { type JsonlRepairResult, JsonlStore } from "./jsonl-store.js";

export type RunMode = "opportunity_discovery" | "concept_evidence_assessment";

export interface RunManifest extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.run_manifest.v1";
  readonly run_id: string;
  readonly mode: RunMode;
  readonly status: string;
  readonly status_before_clarification: string | null;
  readonly parent_run_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly skill_version: string;
  readonly policy_version: string;
  readonly schema_bundle_version: string;
  readonly git_commit: string | null;
  readonly current_phase: string | null;
  readonly current_plan_ref: string | null;
  readonly plan_revision: number;
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

export interface CreateRunInput {
  readonly runId: string;
  readonly mode: RunMode;
  readonly createdAt?: string;
  readonly parentRunId?: string | null;
  readonly skillVersion?: string;
  readonly policyVersion?: string;
  readonly gitCommit?: string | null;
}

export interface CreateRunResult {
  readonly schemaVersion: "startup_opportunity.create_run_result.v1";
  readonly status: "created" | "idempotent_replay";
  readonly runId: string;
  readonly manifest: RunManifest;
  readonly checkpointRef: string;
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
  "artifacts/comparison",
  "checkpoints",
  "claims",
  "evidence/raw",
  "findings",
  "insights",
  "judgments",
  "plans",
] as const;

const STORE_ENVELOPE_VERSIONS = new Set([
  "startup_opportunity.artifact_envelope.v1",
  "startup_opportunity.artifact_envelope.v2",
  "startup_opportunity.artifact_envelope.v3",
  "startup_opportunity.artifact_envelope.v4",
  "startup_opportunity.artifact_envelope.v5",
  "startup_opportunity.artifact_envelope.v6",
  "startup_opportunity.artifact_envelope.v7",
  "startup_opportunity.artifact_envelope.v8",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function makeManifest(input: CreateRunInput, createdAt: string): RunManifest {
  return {
    schema_version: "startup_opportunity.run_manifest.v1",
    run_id: input.runId,
    mode: input.mode,
    status: "created",
    status_before_clarification: null,
    parent_run_id: input.parentRunId ?? null,
    created_at: createdAt,
    updated_at: createdAt,
    skill_version: input.skillVersion ?? "1.0.0",
    policy_version: input.policyVersion ?? "1.0.0",
    schema_bundle_version: "1.0.0",
    git_commit: input.gitCommit ?? null,
    current_phase: null,
    current_plan_ref: null,
    plan_revision: 0,
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

  async create(input: CreateRunInput): Promise<CreateRunResult> {
    validateRunId(input.runId);
    if (input.parentRunId !== undefined && input.parentRunId !== null) {
      validateRunId(input.parentRunId);
      if (input.parentRunId === input.runId) {
        throw new StoreError("run.invalid_parent", "Run cannot be its own parent", {
          runId: input.runId,
        });
      }
    }
    let runRoot: string;
    try {
      runRoot = await createRunDirectory(this.runsRoot, input.runId);
    } catch (error) {
      if (!(error instanceof StoreError) || error.code !== "run.already_exists") {
        throw error;
      }
      const loaded = await this.load(input.runId);
      if (
        loaded.manifest.mode !== input.mode ||
        loaded.manifest.parent_run_id !== (input.parentRunId ?? null) ||
        loaded.manifest.skill_version !== (input.skillVersion ?? "1.0.0") ||
        loaded.manifest.policy_version !== (input.policyVersion ?? "1.0.0")
      ) {
        throw new StoreError("write.conflict", "existing Run has different create parameters", {
          runId: input.runId,
        });
      }
      return {
        schemaVersion: "startup_opportunity.create_run_result.v1",
        status: "idempotent_replay",
        runId: input.runId,
        manifest: loaded.manifest,
        checkpointRef: loaded.lastValidCheckpointRef,
      };
    }

    for (const directory of RUN_DIRECTORIES) {
      await mkdir(path.join(runRoot, directory), { recursive: true });
    }
    for (const logPath of ["events.jsonl", "decisions.jsonl", "evidence/manifest.jsonl"] as const) {
      const temporary = `.store/temp/create-${logPath.replaceAll("/", "-")}.tmp`;
      await writeSyncedTemp(runRoot, temporary, "");
      await publishTemp(runRoot, temporary, logPath);
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const manifest = makeManifest(input, createdAt);
    await this.writeManifest(runRoot, manifest);

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
    await this.logs.appendValidated(runRoot, input.runId, "events.jsonl", event);
    const checkpoint = await this.checkpointLocked(runRoot, {
      runId: input.runId,
      checkpointId: "checkpoint_initial",
      createdAt,
      nextStep: "Write and validate DecisionContext.",
      beliefSummary: {
        current_belief: "No research belief has been recorded.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "What decision should this Run answer?",
      },
      inputRefs: [`events.jsonl#${event.event_id}`],
    });
    const finalManifest = await this.readManifest(runRoot);
    return {
      schemaVersion: "startup_opportunity.create_run_result.v1",
      status: "created",
      runId: input.runId,
      manifest: finalManifest,
      checkpointRef: checkpoint.checkpointRef,
    };
  }

  async load(runId: string): Promise<LoadRunResult> {
    const runRoot = await openRunDirectory(this.runsRoot, runId);
    return withRunLock(runRoot, () => this.recoverLocked(runRoot, runId));
  }

  async publishArtifact(input: PublishArtifactInput): Promise<PublishArtifactResult> {
    this.artifacts.validateEnvelopeVersionBoundary(input.envelope.schema_version);
    if (input.envelope.artifact_type === "startup_opportunity.checkpoint.v1") {
      throw new StoreError(
        "checkpoint.dedicated_entry_required",
        "checkpoints must use the monotonic checkpoint operation",
      );
    }
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      const manifest = await this.readManifest(runRoot);
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
      this.assertBranchPublicationTransition(manifest, input.envelope, plannedArtifact.ignoredLate);
      const result = await this.artifacts.publishLocked(runRoot, input);
      if (taskPublicationMode === "replay") {
        return result;
      }
      const ignoredLate = plannedArtifact.ignoredLate;
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
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      let manifest = await this.readManifest(runRoot);
      const originalManifest = manifest;
      const classifications = new Map<
        string,
        { readonly ignoredLate: boolean; readonly expectedArtifactType: string | null }
      >();
      const taskPublicationModes = new Map<string, "not_task" | "transition" | "replay">();
      const transitioningTaskUnits = new Set<string>();
      for (const envelope of input.envelopes) {
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
        this.assertBranchPublicationTransition(manifest, envelope, planned.ignoredLate);
        classifications.set(envelope.artifact_path, planned);
      }
      const result = await this.artifacts.publishBundleLocked(runRoot, input);
      const publicationResults = new Map(
        result.artifacts.map((artifact) => [artifact.artifactPath, artifact.status]),
      );
      for (const envelope of [...input.envelopes].sort((left, right) =>
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

  private async researchTaskPublicationMode(
    runRoot: string,
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
  ): Promise<"not_task" | "transition" | "replay"> {
    if (
      envelope.schema_version !== "startup_opportunity.artifact_envelope.v5" ||
      envelope.artifact_type !== "startup_opportunity.research_task.v1"
    ) {
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

  async checkpoint(input: CheckpointRunInput): Promise<CheckpointRunResult> {
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, () => this.checkpointLocked(runRoot, input));
  }

  async appendEvent(
    runId: string,
    event: Record<string, unknown>,
    suppliedOperationKey?: string,
  ): Promise<"appended" | "idempotent_replay"> {
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

  private async applyPublishedEnvelope(
    runRoot: string,
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
    ignoredLate: boolean,
    exactReplay: boolean,
  ): Promise<RunManifest> {
    this.assertBranchPublicationTransition(manifest, envelope, ignoredLate);
    const adapter = this.validator.publicationAdapter(envelope.schema_version);
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
      schema_bundle_version:
        adapter.manifest_schema_bundle_version ?? manifest.schema_bundle_version,
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
      };
    }
    if (
      !ignoredLate &&
      envelope.schema_version === "startup_opportunity.artifact_envelope.v5" &&
      envelope.artifact_type === "startup_opportunity.research_task.v1" &&
      typeof envelope.document.unit_id === "string"
    ) {
      const unitId = envelope.document.unit_id;
      next = this.moveUnit(next, unitId, "active_units");
      next = { ...next, status: "researching", current_phase: "assessment" };
    }
    if (
      !ignoredLate &&
      envelope.schema_version === "startup_opportunity.artifact_envelope.v5" &&
      envelope.artifact_type ===
        "startup_opportunity.concept_evidence_assessment_branch_result.v1" &&
      typeof envelope.document.unit_id === "string" &&
      typeof envelope.document.branch_status === "string"
    ) {
      const target =
        this.validator.publicationPolicy.document.branch_status_adapter[
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
      envelope.schema_version === "startup_opportunity.artifact_envelope.v6" &&
      envelope.artifact_type === "startup_opportunity.gap_snapshot.v2"
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
      envelope.schema_version === "startup_opportunity.artifact_envelope.v6" &&
      envelope.artifact_type === "startup_opportunity.adaptation_decision.v3"
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
    this.validateManifest(next);
    return next;
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
    if (
      !isRecord(currentValue) ||
      !STORE_ENVELOPE_VERSIONS.has(String(currentValue.schema_version))
    ) {
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
      !["startup_opportunity.gap_snapshot.v1", "startup_opportunity.gap_snapshot.v2"].includes(
        currentEnvelope.artifact_type,
      )
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
      envelope.schema_version !== "startup_opportunity.artifact_envelope.v5" ||
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
      this.validator.publicationPolicy.document.branch_status_adapter[
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
    const manifest = await this.readManifest(runRoot);
    const checkpointTime = Date.parse(input.createdAt);
    const currentTime = Date.parse(manifest.updated_at);
    let latestCheckpointTime: number | null = null;
    for (const entry of (await this.artifacts.listFormalDocuments(runRoot)).filter((item) =>
      item.path.startsWith("checkpoints/"),
    )) {
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
    const checkpointRef = `checkpoints/${input.checkpointId.replaceAll("_", "-")}.json`;
    validateArtifactRef(checkpointRef);
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
      schema_version: this.validator.publicationPolicy.checkpointEnvelopeForBundle(
        manifest.schema_bundle_version,
      ),
      artifact_type: "startup_opportunity.checkpoint.v1",
      artifact_path: checkpointRef,
      run_id: input.runId,
      created_at: input.createdAt,
      producer_role: "harness",
      input_refs: document.input_refs,
      content_hash: canonicalContentHash(document),
      document,
    };
    const published = await this.artifacts.publishLocked(runRoot, {
      runId: input.runId,
      envelope,
    });
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
    const reportRecovery = await recoverReportOperationsLocked(
      runRoot,
      runId,
      this.validator,
      this.artifacts,
    );
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
      if (
        !isRecord(entry.document) ||
        !STORE_ENVELOPE_VERSIONS.has(String(entry.document.schema_version))
      ) {
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
      if (
        (await this.classifyPlannedArtifact(runRoot, provisionalManifest, artifactPath)).ignoredLate
      ) {
        ignoredLateArtifactPaths.push(artifactPath);
      } else {
        currentArtifactPaths.push(artifactPath);
      }
    }
    let recoveredManifest: RunManifest = {
      ...provisionalManifest,
      artifact_refs: [...new Set([...snapshot.artifact_refs, ...currentArtifactPaths])]
        .filter((ref) => !ignoredLateArtifactPaths.includes(ref))
        .sort(),
      ignored_late_artifact_refs: [
        ...new Set([...snapshot.ignored_late_artifact_refs, ...ignoredLateArtifactPaths]),
      ].sort(),
    };
    const checkpointKnownPaths = new Set([
      ...snapshot.artifact_refs,
      ...snapshot.ignored_late_artifact_refs,
    ]);
    const postCheckpointEnvelopes = formalDocuments
      .filter(
        (entry) =>
          !entry.path.startsWith("checkpoints/") &&
          !checkpointKnownPaths.has(entry.path) &&
          isRecord(entry.document) &&
          STORE_ENVELOPE_VERSIONS.has(String(entry.document.schema_version)),
      )
      .map((entry) => entry.document as FormalArtifactEnvelope)
      .sort((left, right) => {
        const time = Date.parse(left.created_at) - Date.parse(right.created_at);
        return time === 0 ? left.artifact_path.localeCompare(right.artifact_path) : time;
      });
    for (const envelope of postCheckpointEnvelopes) {
      recoveredManifest = await this.applyPublishedEnvelope(
        runRoot,
        recoveredManifest,
        envelope,
        ignoredLateArtifactPaths.includes(envelope.artifact_path),
        false,
      );
    }
    this.validateManifest(recoveredManifest);
    await this.assertManifestRefsExist(runRoot, recoveredManifest);
    const recoveryDocuments: DocumentBundleEntry[] = [
      { path: "manifest.json", document: recoveredManifest },
      ...formalDocuments.filter((entry) => !invalidCheckpoints.includes(entry.path)),
    ];
    const typedJsonlRefs = recoveryDocuments
      .flatMap((entry) => {
        const effective =
          isRecord(entry.document.document) &&
          STORE_ENVELOPE_VERSIONS.has(String(entry.document.schema_version))
            ? entry.document.document
            : entry.document;
        return [effective.trigger_event_ref, effective.user_decision_ref];
      })
      .filter((ref): ref is string => typeof ref === "string");
    const exactJsonlRecords = new Map<string, Record<string, unknown>>();
    for (const ref of [...new Set(typedJsonlRefs)].sort()) {
      const logPath = ref.split("#", 1)[0];
      if (logPath !== "events.jsonl" && logPath !== "decisions.jsonl") {
        continue;
      }
      exactJsonlRecords.set(ref, await this.logs.readExactRecord(runRoot, runId, ref, logPath));
    }
    const envelopeVersions = recoveryDocuments
      .map((entry) => entry.document.schema_version)
      .filter((version) => STORE_ENVELOPE_VERSIONS.has(String(version)));
    const recoveryBundleVersion = this.validator.publicationPolicy.highestBundleForEnvelopes(
      envelopeVersions.length > 0
        ? envelopeVersions
        : [
            this.validator.publicationPolicy.checkpointEnvelopeForBundle(
              snapshot.schema_bundle_version,
            ),
          ],
    );
    if (
      recoveryBundleVersion === "startup_opportunity.document_bundle.v5" ||
      recoveryBundleVersion === "startup_opportunity.document_bundle.v6" ||
      recoveryBundleVersion === "startup_opportunity.document_bundle.v7" ||
      recoveryBundleVersion === "startup_opportunity.document_bundle.v8"
    ) {
      for (const record of await this.evidence.listRecordsLocked(runRoot, runId)) {
        if (record.schema_version === "startup_opportunity.evidence_store_record.v2") {
          exactJsonlRecords.set(`evidence/manifest.jsonl#${record.evidence_id}`, record);
        }
      }
    }
    const bundle = this.validator.validateDocumentBundle(
      {
        schema_version: recoveryBundleVersion,
        documents: recoveryDocuments,
        ...(recoveryBundleVersion === "startup_opportunity.document_bundle.v5" ||
        recoveryBundleVersion === "startup_opportunity.document_bundle.v6" ||
        recoveryBundleVersion === "startup_opportunity.document_bundle.v7" ||
        recoveryBundleVersion === "startup_opportunity.document_bundle.v8"
          ? { exact_records: [] }
          : {}),
      },
      { exactJsonlRecords },
    );
    if (!bundle.valid) {
      throw new StoreError(
        "recovery.reference_invalid",
        "Run references or plan lineage are invalid",
        {
          bundleErrors: bundle.bundleErrors,
          documentErrors: bundle.documents.flatMap((document) => document.errors),
          referenceErrors: bundle.referenceErrors,
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

  private async validateCheckpointEntry(
    runRoot: string,
    runId: string,
    entry: DocumentBundleEntry,
  ): Promise<{
    readonly path: string;
    readonly envelope: FormalArtifactEnvelope;
    readonly document: Record<string, unknown>;
  }> {
    if (
      !isRecord(entry.document) ||
      !STORE_ENVELOPE_VERSIONS.has(String(entry.document.schema_version))
    ) {
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
      STORE_ENVELOPE_VERSIONS.has(String(storedPlan.schema_version)) &&
      isRecord(storedPlan.document)
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

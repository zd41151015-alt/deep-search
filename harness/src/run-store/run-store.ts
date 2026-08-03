import type { Dirent } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
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
import {
  atomicReplace,
  publishTemp,
  syncDirectory,
  writeSyncedTemp,
} from "../artifact-store/atomic-file.js";
import {
  canonicalContentHash,
  canonicalJson,
  operationKey,
  sha256Hex,
} from "../artifact-store/canonical.js";
import {
  isNodeError,
  openRunDirectory,
  openRunDirectoryReadOnly,
  resolveRunPath,
  validateArtifactRef,
  validateRunId,
} from "../artifact-store/path-policy.js";
import { withRunCreationLock, withRunLock } from "../artifact-store/run-lock.js";
import { StoreError } from "../artifact-store/store-error.js";
import { type EvidenceRecoveryResult, EvidenceStore } from "../evidence-store/evidence-store.js";
import {
  type ReportRecoveryResult,
  recoverReportOperationsLocked,
} from "../reporting/report-runtime.js";
import {
  type ArtifactValidator,
  artifactRefsForDocument,
  type DocumentBundle,
  type DocumentBundleEntry,
  type DocumentBundleReferenceContext,
} from "../validators/artifact-validator.js";
import { SCHEMA_BUNDLE_VERSION } from "../validators/schema-bundle.js";
import { validateTerminalReportingContract } from "../validators/terminal-reporting-validator.js";
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
  readonly faultAt?: "before_publish";
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
  "startup_opportunity.artifact_envelope.v10",
  "startup_opportunity.artifact_envelope.v11",
  "startup_opportunity.artifact_envelope.v12",
  "startup_opportunity.artifact_envelope.v13",
  "startup_opportunity.artifact_envelope.v14",
  "startup_opportunity.artifact_envelope.v15",
  "startup_opportunity.artifact_envelope.v16",
  "startup_opportunity.artifact_envelope.v17",
  "startup_opportunity.artifact_envelope.v18",
  "startup_opportunity.artifact_envelope.v19",
]);

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

function highestSchemaBundleVersion(current: string, candidate: string | null): string {
  if (candidate === null) {
    return current;
  }
  const parts = (value: string): readonly number[] => value.split(".").map((part) => Number(part));
  const left = parts(current);
  const right = parts(candidate);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) {
      return rightPart > leftPart ? candidate : current;
    }
  }
  return current;
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
  if (
    envelope.artifact_type === "startup_opportunity.dispatch_batch.v1" ||
    envelope.artifact_type === "startup_opportunity.dispatch_batch.v2" ||
    envelope.artifact_type === "startup_opportunity.research_task.v1" ||
    envelope.artifact_type === "startup_opportunity.research_task.v2" ||
    envelope.artifact_type === "startup_opportunity.research_task.v3"
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
  return 1;
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
    schema_bundle_version: SCHEMA_BUNDLE_VERSION,
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
        await this.registerContinuation(runsRoot, loaded.manifest);
        return {
          schemaVersion: "startup_opportunity.create_run_result.v1",
          status: "idempotent_replay",
          runId: input.runId,
          manifest: loaded.manifest,
          checkpointRef: loaded.lastValidCheckpointRef,
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
        await this.logs.appendValidated(stagingRoot, input.runId, "events.jsonl", event);
        const checkpoint = await this.checkpointLocked(stagingRoot, {
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
        return {
          schemaVersion: "startup_opportunity.create_run_result.v1",
          status: "created",
          runId: input.runId,
          manifest: finalManifest,
          checkpointRef: checkpoint.checkpointRef,
        };
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    });
  }

  async load(runId: string): Promise<LoadRunResult> {
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
    const runRoot = await openRunDirectory(this.runsRoot, runId);
    return withRunLock(runRoot, () => this.recoverLocked(runRoot, runId));
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
    const resolution = await this.resolveExecution(runId);
    const terminalReportStatus = TERMINAL_RUN_STATUSES.has(manifest.status)
      ? await this.terminalReportStatus(runId, runRoot, manifest)
      : { disposition: "not_required" as const, issues: [] };
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
      "startup_opportunity.decision_brief.v3",
      "startup_opportunity.terminal_report_view.v1",
      "startup_opportunity.report_consistency_evaluation.v4",
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
      const terminalIssues = validateTerminalReportingContract([
        {
          path: "manifest.json",
          schemaVersion: manifest.schema_version,
          document: manifest,
          envelope: null,
        },
        ...terminalDocuments,
      ]);
      if (terminalIssues.length > 0) {
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
        (document) => document.schema_version === "startup_opportunity.decision_brief.v3",
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

  async buildValidationContext(
    runId: string,
    input: DocumentBundle,
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
    return withRunLock(runRoot, async () => {
      const manifest = await this.readManifest(runRoot);
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
        STORE_ENVELOPE_VERSIONS.has(String(document.schema_version)) && isRecord(document.document)
          ? document.document
          : document;
      const addAuthority = async (entry: DocumentBundleEntry): Promise<void> => {
        const supplied = selected.get(entry.path);
        const authorityDocument = effective(entry.document);
        if (
          supplied !== undefined &&
          canonicalJson(effective(supplied.document)) !== canonicalJson(authorityDocument)
        ) {
          throw new StoreError(
            "validation_context.authority_conflict",
            "caller-supplied document differs from validated Run authority",
            { path: entry.path },
          );
        }
        if (
          STORE_ENVELOPE_VERSIONS.has(String(entry.document.schema_version)) &&
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
          document: STORE_ENVELOPE_VERSIONS.has(String(entry.document.schema_version))
            ? entry.document
            : authorityDocument,
        });
      };

      await addAuthority({ path: "manifest.json", document: manifest });
      const exactRecords = new Map<string, Record<string, unknown>>();
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
            exactRecords.set(
              ref,
              await this.logs.readExactRecord(runRoot, runId, ref, parsed.path),
            );
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

      return {
        schemaVersion: "startup_opportunity.validation_context.v1",
        bundle: {
          schema_version: input.schema_version,
          documents: [...selected.values()].sort((left, right) =>
            left.path.localeCompare(right.path),
          ),
          ...(input.schema_version === "startup_opportunity.document_bundle.v5" ||
          input.schema_version === "startup_opportunity.document_bundle.v6" ||
          input.schema_version === "startup_opportunity.document_bundle.v7" ||
          input.schema_version === "startup_opportunity.document_bundle.v8" ||
          input.schema_version === "startup_opportunity.document_bundle.v10" ||
          input.schema_version === "startup_opportunity.document_bundle.v11" ||
          input.schema_version === "startup_opportunity.document_bundle.v12" ||
          input.schema_version === "startup_opportunity.document_bundle.v13" ||
          input.schema_version === "startup_opportunity.document_bundle.v14" ||
          input.schema_version === "startup_opportunity.document_bundle.v15" ||
          input.schema_version === "startup_opportunity.document_bundle.v16" ||
          input.schema_version === "startup_opportunity.document_bundle.v17" ||
          input.schema_version === "startup_opportunity.document_bundle.v18" ||
          input.schema_version === "startup_opportunity.document_bundle.v19"
            ? { exact_records: [] }
            : {}),
        },
        referenceContext: {
          exactJsonlRecords: new Map(
            [...exactRecords.entries()].sort(([left], [right]) => left.localeCompare(right)),
          ),
        },
      };
    });
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
      const result = await this.artifacts.publishLocked(runRoot, input);
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
      const runtimeActivations = new Set<string>();
      for (const envelope of input.envelopes) {
        if (
          envelope.artifact_type !== "startup_opportunity.dispatch_batch.v1" &&
          envelope.artifact_type !== "startup_opportunity.dispatch_batch.v2"
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
        classifications.set(envelope.artifact_path, effectiveClassification);
      }
      const result = await this.artifacts.publishBundleLocked(runRoot, input);
      const publicationResults = new Map(
        result.artifacts.map((artifact) => [artifact.artifactPath, artifact.status]),
      );
      const projectionRank = (envelope: FormalArtifactEnvelope): number =>
        envelope.artifact_type === "startup_opportunity.dispatch_batch.v1" ||
        envelope.artifact_type === "startup_opportunity.dispatch_batch.v2"
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

  private async researchTaskPublicationMode(
    runRoot: string,
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
  ): Promise<"not_task" | "transition" | "replay"> {
    const isAssessmentTask =
      envelope.schema_version === "startup_opportunity.artifact_envelope.v5" &&
      envelope.artifact_type === "startup_opportunity.research_task.v1";
    const isDiscoveryTask =
      envelope.schema_version === "startup_opportunity.artifact_envelope.v10" &&
      envelope.artifact_type === "startup_opportunity.research_task.v2";
    const isEnrichmentTask =
      (envelope.schema_version === "startup_opportunity.artifact_envelope.v12" ||
        envelope.schema_version === "startup_opportunity.artifact_envelope.v13" ||
        envelope.schema_version === "startup_opportunity.artifact_envelope.v14" ||
        envelope.schema_version === "startup_opportunity.artifact_envelope.v15") &&
      envelope.artifact_type === "startup_opportunity.research_task.v3";
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
    if (
      isDiscoveryTask &&
      existingState === "active_units" &&
      !manifest.artifact_refs.includes(envelope.artifact_path) &&
      manifest.current_plan_ref === researchPlanRef
    ) {
      await this.assertDiscoveryTaskDispatchBridge(runRoot, manifest, envelope);
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

  private async assertDiscoveryTaskDispatchBridge(
    runRoot: string,
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
  ): Promise<void> {
    const planRef = manifest.current_plan_ref;
    const storedPlan =
      planRef === null
        ? null
        : (JSON.parse(await readFile(await resolveRunPath(runRoot, planRef), "utf8")) as unknown);
    const plan =
      isRecord(storedPlan) &&
      STORE_ENVELOPE_VERSIONS.has(String(storedPlan.schema_version)) &&
      isRecord(storedPlan.document)
        ? storedPlan.document
        : storedPlan;
    const plannedWave = isRecord(plan)
      ? (Array.isArray(plan.waves) ? plan.waves : [])
          .filter(isRecord)
          .find(
            (wave) =>
              Array.isArray(wave.units) &&
              wave.units
                .filter(isRecord)
                .some((unit) => unit.unit_id === envelope.document.unit_id),
          )
      : undefined;
    const plannedUnit =
      plannedWave !== undefined && Array.isArray(plannedWave.units)
        ? plannedWave.units
            .filter(isRecord)
            .find((unit) => unit.unit_id === envelope.document.unit_id)
        : undefined;
    if (
      plannedUnit === undefined ||
      plannedWave?.wave_id !== envelope.document.wave_id ||
      plannedUnit.unit_type !== envelope.document.unit_type ||
      plannedUnit.research_goal !== envelope.document.research_goal ||
      plannedUnit.attempt !== envelope.document.attempt ||
      plannedUnit.agent_role !== envelope.document.agent_role ||
      plannedUnit.output_path !== envelope.document.allowed_output_path ||
      plannedUnit.required_artifact_schema !== envelope.document.required_artifact_schema
    ) {
      throw new StoreError(
        "artifact.task_transition_invalid",
        "active discovery task must match the exact current Plan unit before canonical publication",
        { unitId: envelope.document.unit_id, planRef },
      );
    }

    for (const dispatchRef of manifest.artifact_refs.filter((ref) =>
      ref.startsWith("tasks/dispatch/"),
    )) {
      const value = JSON.parse(
        await readFile(await resolveRunPath(runRoot, dispatchRef), "utf8"),
      ) as unknown;
      if (
        !isRecord(value) ||
        value.schema_version !== "startup_opportunity.artifact_envelope.v18" ||
        value.artifact_type !== "startup_opportunity.dispatch_batch.v1" ||
        value.run_id !== manifest.run_id ||
        !isRecord(value.document) ||
        value.document.research_plan_ref !== planRef
      ) {
        continue;
      }
      await this.artifacts.validateStoredEnvelope(
        runRoot,
        manifest.run_id,
        value as FormalArtifactEnvelope,
      );
      const dispatched = (Array.isArray(value.document.tasks) ? value.document.tasks : [])
        .filter(isRecord)
        .find((task) => task.unit_id === envelope.document.unit_id);
      if (
        dispatched !== undefined &&
        dispatched.research_goal === envelope.document.research_goal &&
        dispatched.allowed_output_path === envelope.document.allowed_output_path &&
        dispatched.required_artifact_schema === envelope.document.required_artifact_schema
      ) {
        return;
      }
    }
    throw new StoreError(
      "artifact.task_transition_invalid",
      "active discovery task requires an exact current dispatch before canonical publication",
      { unitId: envelope.document.unit_id, planRef },
    );
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
      STORE_ENVELOPE_VERSIONS.has(String(storedPlan.schema_version)) &&
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

  private async applyPublishedEnvelope(
    runRoot: string,
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
    ignoredLate: boolean,
    exactReplay: boolean,
  ): Promise<RunManifest> {
    this.assertBranchPublicationTransition(manifest, envelope, ignoredLate);
    this.assertDiscoveryLanePublicationTransition(manifest, envelope, ignoredLate);
    this.assertEnrichmentBranchPublicationTransition(manifest, envelope, ignoredLate);
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
      schema_bundle_version: highestSchemaBundleVersion(
        manifest.schema_bundle_version,
        adapter.manifest_schema_bundle_version,
      ),
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
      (!exactReplay || !artifactWasTracked) &&
      ((envelope.schema_version === "startup_opportunity.artifact_envelope.v18" &&
        envelope.artifact_type === "startup_opportunity.dispatch_batch.v1") ||
        (envelope.schema_version === "startup_opportunity.artifact_envelope.v19" &&
          envelope.artifact_type === "startup_opportunity.dispatch_batch.v2"))
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
      envelope.schema_version === "startup_opportunity.artifact_envelope.v18" &&
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
      envelope.schema_version === "startup_opportunity.artifact_envelope.v19" &&
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
      envelope.schema_version === "startup_opportunity.artifact_envelope.v19" &&
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
      ((envelope.schema_version === "startup_opportunity.artifact_envelope.v5" &&
        envelope.artifact_type === "startup_opportunity.research_task.v1") ||
        (envelope.schema_version === "startup_opportunity.artifact_envelope.v10" &&
          envelope.artifact_type === "startup_opportunity.research_task.v2") ||
        ((envelope.schema_version === "startup_opportunity.artifact_envelope.v12" ||
          envelope.schema_version === "startup_opportunity.artifact_envelope.v13" ||
          envelope.schema_version === "startup_opportunity.artifact_envelope.v14" ||
          envelope.schema_version === "startup_opportunity.artifact_envelope.v15") &&
          envelope.artifact_type === "startup_opportunity.research_task.v3")) &&
      typeof envelope.document.unit_id === "string"
    ) {
      const unitId = envelope.document.unit_id;
      next = this.moveUnit(next, unitId, "active_units");
      next = {
        ...next,
        status: "researching",
        current_phase:
          envelope.artifact_type === "startup_opportunity.research_task.v2" ||
          envelope.artifact_type === "startup_opportunity.research_task.v3"
            ? "discovery"
            : "assessment",
      };
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
      envelope.schema_version === "startup_opportunity.artifact_envelope.v10" &&
      envelope.artifact_type === "startup_opportunity.discovery_lane_result.v1" &&
      typeof envelope.document.unit_id === "string" &&
      typeof envelope.document.status === "string"
    ) {
      const target =
        this.validator.publicationPolicy.document.discovery_lane_status_adapter[
          envelope.document.status
        ];
      if (target === "completed_units" || target === "failed_units") {
        next = this.moveUnit(next, envelope.document.unit_id, target);
      }
    }
    if (
      !ignoredLate &&
      (envelope.schema_version === "startup_opportunity.artifact_envelope.v12" ||
        envelope.schema_version === "startup_opportunity.artifact_envelope.v13" ||
        envelope.schema_version === "startup_opportunity.artifact_envelope.v14" ||
        envelope.schema_version === "startup_opportunity.artifact_envelope.v15") &&
      envelope.artifact_type === "startup_opportunity.enrichment_branch_result.v1" &&
      typeof envelope.document.unit_id === "string" &&
      typeof envelope.document.status === "string"
    ) {
      const target =
        this.validator.publicationPolicy.document.enrichment_branch_status_adapter[
          envelope.document.status
        ];
      if (target === "completed_units" || target === "failed_units") {
        next = this.moveUnit(next, envelope.document.unit_id, target);
      }
    }
    if (
      !ignoredLate &&
      ((envelope.schema_version === "startup_opportunity.artifact_envelope.v5" &&
        envelope.artifact_type === "startup_opportunity.gap_snapshot.v1") ||
        (envelope.schema_version === "startup_opportunity.artifact_envelope.v6" &&
          envelope.artifact_type === "startup_opportunity.gap_snapshot.v2") ||
        (envelope.schema_version === "startup_opportunity.artifact_envelope.v18" &&
          envelope.artifact_type === "startup_opportunity.gap_snapshot.v3"))
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
      ((envelope.schema_version === "startup_opportunity.artifact_envelope.v5" &&
        envelope.artifact_type === "startup_opportunity.adaptation_decision.v2") ||
        (envelope.schema_version === "startup_opportunity.artifact_envelope.v6" &&
          envelope.artifact_type === "startup_opportunity.adaptation_decision.v3") ||
        (envelope.schema_version === "startup_opportunity.artifact_envelope.v18" &&
          envelope.artifact_type === "startup_opportunity.adaptation_decision.v2"))
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

  private assertDeclarativeRuntimeTransition(
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
    sameBundleActivations: ReadonlySet<string>,
  ): void {
    if (
      envelope.schema_version !== "startup_opportunity.artifact_envelope.v18" &&
      envelope.schema_version !== "startup_opportunity.artifact_envelope.v19"
    ) {
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
      envelope.artifact_type === "startup_opportunity.dispatch_batch.v1" ||
      envelope.artifact_type === "startup_opportunity.dispatch_batch.v2"
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
      ![
        "startup_opportunity.gap_snapshot.v1",
        "startup_opportunity.gap_snapshot.v2",
        "startup_opportunity.gap_snapshot.v3",
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

  private assertDiscoveryLanePublicationTransition(
    manifest: RunManifest,
    envelope: FormalArtifactEnvelope,
    ignoredLate: boolean,
  ): void {
    if (
      envelope.schema_version !== "startup_opportunity.artifact_envelope.v10" ||
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
      this.validator.publicationPolicy.document.discovery_lane_status_adapter[
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
      (envelope.schema_version !== "startup_opportunity.artifact_envelope.v12" &&
        envelope.schema_version !== "startup_opportunity.artifact_envelope.v13" &&
        envelope.schema_version !== "startup_opportunity.artifact_envelope.v14" &&
        envelope.schema_version !== "startup_opportunity.artifact_envelope.v15") ||
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
      this.validator.publicationPolicy.document.enrichment_branch_status_adapter[
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
      const storedEntry = formalDocuments.find((entry) => entry.path === artifactPath);
      const storedEnvelope =
        storedEntry !== undefined &&
        isRecord(storedEntry.document) &&
        STORE_ENVELOPE_VERSIONS.has(String(storedEntry.document.schema_version))
          ? (storedEntry.document as FormalArtifactEnvelope)
          : null;
      const enrichmentTerminalResult =
        (storedEnvelope?.schema_version === "startup_opportunity.artifact_envelope.v12" ||
          storedEnvelope?.schema_version === "startup_opportunity.artifact_envelope.v13" ||
          storedEnvelope?.schema_version === "startup_opportunity.artifact_envelope.v14" ||
          storedEnvelope?.schema_version === "startup_opportunity.artifact_envelope.v15") &&
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
        if (time !== 0) {
          return time;
        }
        const rank = recoveryTransitionRank(left) - recoveryTransitionRank(right);
        return rank === 0 ? left.artifact_path.localeCompare(right.artifact_path) : rank;
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
      recoveryBundleVersion === "startup_opportunity.document_bundle.v8" ||
      recoveryBundleVersion === "startup_opportunity.document_bundle.v10" ||
      recoveryBundleVersion === "startup_opportunity.document_bundle.v11" ||
      recoveryBundleVersion === "startup_opportunity.document_bundle.v12" ||
      recoveryBundleVersion === "startup_opportunity.document_bundle.v13" ||
      recoveryBundleVersion === "startup_opportunity.document_bundle.v14" ||
      recoveryBundleVersion === "startup_opportunity.document_bundle.v15" ||
      recoveryBundleVersion === "startup_opportunity.document_bundle.v16" ||
      recoveryBundleVersion === "startup_opportunity.document_bundle.v17" ||
      recoveryBundleVersion === "startup_opportunity.document_bundle.v18" ||
      recoveryBundleVersion === "startup_opportunity.document_bundle.v19"
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
        recoveryBundleVersion === "startup_opportunity.document_bundle.v8" ||
        recoveryBundleVersion === "startup_opportunity.document_bundle.v10" ||
        recoveryBundleVersion === "startup_opportunity.document_bundle.v11" ||
        recoveryBundleVersion === "startup_opportunity.document_bundle.v12" ||
        recoveryBundleVersion === "startup_opportunity.document_bundle.v13" ||
        recoveryBundleVersion === "startup_opportunity.document_bundle.v14" ||
        recoveryBundleVersion === "startup_opportunity.document_bundle.v15" ||
        recoveryBundleVersion === "startup_opportunity.document_bundle.v16" ||
        recoveryBundleVersion === "startup_opportunity.document_bundle.v17" ||
        recoveryBundleVersion === "startup_opportunity.document_bundle.v18" ||
        recoveryBundleVersion === "startup_opportunity.document_bundle.v19"
          ? { exact_records: [] }
          : {}),
      },
      {
        exactJsonlRecords,
        historicalDiscoveryPlanBindings: planOperationRecovery.historicalDiscoveryPlanBindings,
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
    if (manifest.schema_bundle_version !== SCHEMA_BUNDLE_VERSION) {
      throw new StoreError(
        "run.unsupported_run_version",
        "Run was created with an unsupported schema bundle; restart with a new run_id",
        {
          actualSchemaBundleVersion: manifest.schema_bundle_version,
          currentSchemaBundleVersion: SCHEMA_BUNDLE_VERSION,
          restartRequired: true,
        },
      );
    }
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
        envelope.schema_version === "startup_opportunity.artifact_envelope.v10" &&
        envelope.artifact_type === "startup_opportunity.research_task.v2" &&
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

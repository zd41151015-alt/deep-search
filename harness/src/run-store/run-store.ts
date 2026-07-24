import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ArtifactStore,
  type FormalArtifactEnvelope,
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
import type { ArtifactValidator } from "../validators/artifact-validator.js";
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
  readonly orphanActiveUnits: readonly string[];
}

const RUN_DIRECTORIES = [
  ".store/operations",
  ".store/temp",
  "adaptations/gap-snapshots",
  "adaptations/decisions",
  "artifacts/lanes",
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
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      const result = await this.artifacts.publishLocked(runRoot, input);
      const manifest = await this.readManifest(runRoot);
      const artifactRefs = [...new Set([...manifest.artifact_refs, result.artifactPath])].sort();
      await this.writeManifest(runRoot, {
        ...manifest,
        updated_at: input.envelope.created_at,
        artifact_refs: artifactRefs,
      });
      return result;
    });
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

  private async checkpointLocked(
    runRoot: string,
    input: CheckpointRunInput,
  ): Promise<CheckpointRunResult> {
    const manifest = await this.readManifest(runRoot);
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
      schema_version: "startup_opportunity.artifact_envelope.v1",
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
      operationKey: operationKey("checkpoint_run", {
        run_id: input.runId,
        checkpoint_id: input.checkpointId,
        content_hash: envelope.content_hash,
      }),
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
    const logRepairs = [
      await this.logs.repair(runRoot, runId, "events.jsonl"),
      await this.logs.repair(runRoot, runId, "decisions.jsonl"),
    ];
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
        entry.document.schema_version !== "startup_opportunity.artifact_envelope.v1"
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
      if (
        !isRecord(entry.document) ||
        entry.document.schema_version !== "startup_opportunity.artifact_envelope.v1"
      ) {
        invalidCheckpoints.push(entry.path);
        continue;
      }
      const envelope = entry.document as FormalArtifactEnvelope;
      try {
        await this.artifacts.validateStoredEnvelope(runRoot, runId, envelope);
        const document = checkpointDocument(envelope);
        if (!document || document.manifest_snapshot === undefined) {
          throw new StoreError("checkpoint.invalid", "checkpoint document is missing its snapshot");
        }
        validCheckpoints.push({ path: entry.path, envelope, document });
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
    const recoveredManifest: RunManifest = {
      ...snapshot,
      updated_at: latestArtifactTime,
      artifact_refs: [...new Set([...snapshot.artifact_refs, ...formalArtifactPaths])].sort(),
      checkpoint_ref: latest.path,
    };
    this.validateManifest(recoveredManifest);
    await this.assertManifestRefsExist(runRoot, recoveredManifest);
    const bundle = this.validator.validateDocumentBundle({
      schema_version: "startup_opportunity.document_bundle.v1",
      documents: [
        { path: "manifest.json", document: recoveredManifest },
        ...formalDocuments.filter((entry) => !invalidCheckpoints.includes(entry.path)),
      ],
    });
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
        evidenceRecovery.recoveredRawContentRefs.length > 0,
      lastValidCheckpointRef: latest.path,
      recoveredArtifactPaths: artifactRecovery.recoveredArtifactPaths,
      ignoredInvalidCheckpointPaths: invalidCheckpoints.sort(),
      logRepairs,
      evidenceRecovery,
      orphanActiveUnits: currentManifest.active_units,
    };
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

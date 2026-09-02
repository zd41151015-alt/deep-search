import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalContentHash, canonicalJson, operationKey } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import { DISCOVERY_MAPS_POLICY_PATH } from "../current-policy-paths.js";
import { RunStore } from "../run-store/run-store.js";
import type { ArtifactValidator } from "../validators/artifact-validator.js";
import {
  createFormalStageRuntimeCompiler,
  type DeclarativeRuntimeCompiler,
  type RuntimeArtifactCompilationResult,
  type RuntimePublicationPlan,
  runtimePublicationPlansEquivalentForScopedClosure,
} from "./declarative-runtime.js";
import {
  type CandidateFanInAuthority,
  type CompilerReadyArtifact,
  type DiscoveryObjectDeclaration,
  type DiscoveryStageProjectionContext,
  projectCandidateFanIn,
  projectDiscoverySetup,
  projectDiscoverySynthesis,
} from "./discovery-stage-projections.js";
import {
  DISCOVERY_REVIEW_TASK_SCHEMA,
  discoveryTaskProjectionForRequiredArtifactSchema,
  discoveryWaveLaneProjectionIssues,
} from "./discovery-wave-contracts.js";
import { deriveLaneSubmissionContract } from "./lane-submission-contract.js";

export type FormalStageKind =
  | "discovery_wave"
  | "discovery_setup"
  | "candidate_fan_in"
  | "g2_3_synthesis";

export interface FormalStageMaterializationRequest extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.formal_stage_materialization_request.current";
  readonly request_id: string;
  readonly run_id: string;
  readonly operation: "validate_only" | "publish";
  readonly created_at: string;
  readonly stage_kind: FormalStageKind;
  readonly wave?: WaveDeclaration;
  readonly artifacts?: readonly CallerFormalArtifact[];
  readonly fan_in?: CandidateFanInAuthority;
  readonly top_level_formal_refs?: readonly string[];
  readonly publication_plan?: RuntimePublicationPlan;
}

export interface WaveDeclaration {
  readonly wave_id: string;
  readonly stage_id: string;
  readonly stage_kind:
    | "discovery_generation"
    | "hard_gate_scan"
    | "candidate_evaluation"
    | "retained_candidate_deep_review"
    | "review"
    | "discovery_synthesis";
  readonly unit_ids: readonly string[];
  readonly lanes: readonly WaveLaneDeclaration[];
  readonly research_depth: "quick" | "standard" | "deep";
  readonly total_time_budget_minutes: number;
  readonly resource_allocation: Record<string, unknown>;
  readonly gate_before: string | null;
  readonly gate_after: "required" | "terminal_allowed" | "none";
  readonly dispatch_group?: string;
  readonly limitations: readonly string[];
}

export interface WaveLaneDeclaration extends Record<string, unknown> {
  readonly unit_id: string;
  readonly lane_role: "opportunity" | "evaluation" | "risk" | "review";
  readonly candidate_scope: Record<string, unknown>;
  readonly incumbent_response_assignment: Record<string, unknown>;
  readonly reporting_dimensions: readonly string[];
  readonly time_budget_minutes: number;
  readonly max_sources: number;
  readonly straggler_policy: Record<string, unknown>;
  readonly commercial_research_semantics: Record<string, unknown>;
  readonly task_semantics: Record<string, unknown>;
}

export interface CallerFormalArtifact extends DiscoveryObjectDeclaration {}

export interface FormalStageMaterializationResult {
  readonly schema_version: "startup_opportunity.formal_stage_materialization_result.current";
  readonly request_id: string;
  readonly run_id: string;
  readonly stage_kind: FormalStageKind;
  readonly status: "validated" | "published" | "idempotent_replay";
  readonly artifacts: readonly {
    readonly artifact_type: string;
    readonly artifact_path: string;
    readonly content_hash: string;
  }[];
  readonly diagnostics: readonly Record<string, unknown>[];
  readonly compilation: RuntimeArtifactCompilationResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
function effective(document: Record<string, unknown>): Record<string, unknown> {
  return document.schema_version === "startup_opportunity.artifact_envelope.current" &&
    isRecord(document.document)
    ? document.document
    : document;
}
function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function researchPlanQuestionRefs(
  planRef: string,
  plan: Record<string, unknown>,
): readonly string[] {
  return unique(
    records(plan.research_questions).flatMap((question) =>
      typeof question.question_id === "string" ? [`${planRef}#${question.question_id}`] : [],
    ),
  );
}

function relationTargets(request: FormalStageMaterializationRequest): readonly string[] {
  const localKeys = new Set((request.artifacts ?? []).flatMap((entry) => entry.local_key ?? []));
  return (request.artifacts ?? []).flatMap((entry) =>
    Object.values(entry.local_refs ?? {}).flatMap((target) =>
      (typeof target === "string" ? [target] : target).filter(
        (ref) => !localKeys.has(ref) && (ref.includes(".json") || ref.includes(".jsonl")),
      ),
    ),
  );
}

function requestUsesRetainedCandidateScope(request: FormalStageMaterializationRequest): boolean {
  return (
    request.stage_kind === "discovery_wave" &&
    records(request.wave?.lanes).some((lane) => {
      const scope = isRecord(lane.candidate_scope) ? lane.candidate_scope : {};
      return scope.kind === "retained";
    })
  );
}

function automaticAuthorityRefs(
  request: FormalStageMaterializationRequest,
  manifest: {
    readonly artifact_refs: readonly string[];
    readonly current_discovery_fan_in_ref?: unknown;
  },
): readonly string[] {
  const manifestRefs = manifest.artifact_refs;
  const fanInRefs =
    request.fan_in === undefined
      ? []
      : [
          request.fan_in.dispatch_ref,
          ...request.fan_in.lanes.flatMap((lane) => [
            ...(lane.lane_result_ref === undefined ? [] : [lane.lane_result_ref]),
            ...(lane.delivery_receipt_ref === undefined ? [] : [lane.delivery_receipt_ref]),
            ...lane.adopted_artifact_refs,
          ]),
        ];
  const explicit = relationTargets(request);
  const revisionFamilies = explicit
    .map((ref) => ref.split("#", 1)[0] ?? ref)
    .filter((ref) => /\.r[1-9][0-9]*\.json$/u.test(ref))
    .map((ref) => ref.replace(/\.r[1-9][0-9]*\.json$/u, ".r"));
  const retainedFanInRefs = requestUsesRetainedCandidateScope(request)
    ? typeof manifest.current_discovery_fan_in_ref === "string"
      ? [manifest.current_discovery_fan_in_ref]
      : []
    : [];
  return unique([
    ...(request.top_level_formal_refs ?? []),
    ...fanInRefs,
    ...explicit,
    ...retainedFanInRefs,
    ...manifestRefs.filter((ref) => revisionFamilies.some((prefix) => ref.startsWith(prefix))),
  ]);
}

function retainedCandidateScopeAuthority(
  byPath: ReadonlyMap<string, Record<string, unknown>>,
  planRef: string,
  currentFanInRef: unknown,
): Readonly<{ candidateRefs: readonly string[]; authorityRefs: readonly string[] }> {
  const fanIn = typeof currentFanInRef === "string" ? byPath.get(currentFanInRef) : undefined;
  const fanIns =
    fanIn?.schema_version === "startup_opportunity.discovery_fan_in.v2" &&
    fanIn.research_plan_ref === planRef
      ? [[currentFanInRef as string, fanIn] as const]
      : [];
  return {
    candidateRefs: unique(
      fanIns.flatMap(([, document]) => strings(document.retained_candidate_refs)),
    ),
    authorityRefs: unique(fanIns.map(([ref]) => ref)),
  };
}

export class FormalStageMaterializer {
  private readonly runs: RunStore;
  private readonly compiler: DeclarativeRuntimeCompiler;
  constructor(
    runsRoot: string,
    private readonly validator: ArtifactValidator,
    private readonly repositoryRoot = process.cwd(),
  ) {
    this.runs = new RunStore(runsRoot, validator);
    this.compiler = createFormalStageRuntimeCompiler(runsRoot, validator, repositoryRoot);
  }

  async materialize(value: unknown): Promise<FormalStageMaterializationResult> {
    if (!isRecord(value))
      throw new StoreError("formal_materialization.request_invalid", "request must be an object");
    const request = value as FormalStageMaterializationRequest;
    const validation = this.validator.validateDocument(request);
    if (!validation.valid)
      throw new StoreError(
        "formal_materialization.request_invalid",
        "formal stage request is not schema-valid",
        { errors: validation.errors },
      );
    const status = await this.runs.status(request.run_id);
    await this.runs.assertCurrentLeafWritable(request.run_id);
    if (status.manifest.current_plan_ref === null) {
      throw new StoreError(
        "formal_materialization.current_plan_missing",
        "formal materialization requires the current Run leaf and Plan",
      );
    }
    const topRefs = unique([
      "manifest.json",
      status.manifest.current_plan_ref,
      ...status.manifest.artifact_refs.filter((ref) =>
        ref.startsWith("plans/research-execution.r"),
      ),
      ...automaticAuthorityRefs(request, status.manifest),
    ]);
    const context = await this.runs.buildValidationContext(
      request.run_id,
      {
        schema_version: "startup_opportunity.document_bundle.current",
        documents: [{ path: "manifest.json", document: status.manifest }],
        exact_records: [],
      },
      {
        topLevelFormalRefs: topRefs,
        recoverPlanOperations: request.operation === "publish",
      },
    );
    const byPath = new Map(
      context.bundle.documents.map((entry) => [entry.path, effective(entry.document)]),
    );
    const plan = byPath.get(status.manifest.current_plan_ref);
    if (plan === undefined || plan.schema_version !== "startup_opportunity.research_plan.v1")
      throw new StoreError(
        "formal_materialization.current_plan_invalid",
        "current Plan authority is missing or invalid",
      );
    const planRef = status.manifest.current_plan_ref;
    const suppliedPlan = request.publication_plan;
    const trackedPaths = new Set([
      ...status.manifest.artifact_refs,
      ...status.manifest.ignored_late_artifact_refs,
    ]);
    const replay =
      request.operation === "publish" &&
      suppliedPlan?.publication.every((entry) => trackedPaths.has(entry.artifact_path));
    let compilation: RuntimeArtifactCompilationResult;
    if (replay && suppliedPlan !== undefined) {
      await this.assertReplayRequestBindings(
        request,
        suppliedPlan,
        planRef,
        plan,
        byPath,
        status.manifest.current_discovery_fan_in_ref,
      );
      compilation = await this.compiler.compile({
        schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
        request_id: request.request_id,
        run_id: request.run_id,
        operation: "publish",
        created_at: request.created_at,
        artifacts: [],
        publication_plan: suppliedPlan,
      });
    } else {
      const artifacts = this.projectArtifacts(
        request,
        planRef,
        plan,
        byPath,
        status.manifest.current_discovery_fan_in_ref,
      );
      const compiledArtifacts = artifacts;
      if (request.operation === "validate_only") {
        compilation = await this.compiler.compile({
          schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
          request_id: request.request_id,
          run_id: request.run_id,
          operation: "validate_only",
          created_at: request.created_at,
          artifacts: compiledArtifacts,
        });
      } else {
        const validated = await this.compiler.compile({
          schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
          request_id: request.request_id,
          run_id: request.run_id,
          operation: "validate_only",
          created_at: request.created_at,
          artifacts: compiledArtifacts,
        });
        if (
          !runtimePublicationPlansEquivalentForScopedClosure(
            validated.publication_plan,
            suppliedPlan,
          )
        ) {
          throw new StoreError(
            "formal_materialization.publication_plan_stale",
            "publish requires the exact plan produced for these authored semantics and current Manifest",
            {
              suppliedPlanId: suppliedPlan?.plan_id ?? null,
              currentPlanId: validated.publication_plan.plan_id,
            },
          );
        }
        compilation = await this.compiler.compile({
          schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
          request_id: request.request_id,
          run_id: request.run_id,
          operation: "publish",
          created_at: request.created_at,
          artifacts: [],
          publication_plan: suppliedPlan as RuntimePublicationPlan,
        });
      }
    }
    const result: FormalStageMaterializationResult = {
      schema_version: "startup_opportunity.formal_stage_materialization_result.current",
      request_id: request.request_id,
      run_id: request.run_id,
      stage_kind: request.stage_kind,
      status: compilation.status,
      artifacts: compilation.compiled_envelopes.map((entry) => ({
        artifact_type: entry.artifact_type,
        artifact_path: entry.artifact_path,
        content_hash: entry.content_hash,
      })),
      diagnostics: [],
      compilation,
    };
    const resultValidation = this.validator.validateDocument(result);
    if (!resultValidation.valid) {
      throw new StoreError(
        "formal_materialization.result_invalid",
        "derived formal-stage result failed its current contract",
        { errors: resultValidation.errors },
      );
    }
    return result;
  }

  private assertReplayRequestBindings(
    request: FormalStageMaterializationRequest,
    plan: RuntimePublicationPlan,
    planRef: string,
    currentPlan: Record<string, unknown>,
    byPath: ReadonlyMap<string, Record<string, unknown>>,
    currentFanInRef: unknown,
  ): Promise<void> {
    if (
      plan.request_id !== request.request_id ||
      plan.run_id !== request.run_id ||
      plan.created_at !== request.created_at
    ) {
      throw new StoreError(
        "formal_materialization.publication_plan_request_mismatch",
        "publication plan identity must match the exact formal-stage request",
      );
    }
    return this.assertReplayRequestBindingsAsync(
      request,
      plan,
      planRef,
      currentPlan,
      byPath,
      currentFanInRef,
    );
  }

  private async assertReplayRequestBindingsAsync(
    request: FormalStageMaterializationRequest,
    plan: RuntimePublicationPlan,
    planRef: string,
    currentPlan: Record<string, unknown>,
    byPath: ReadonlyMap<string, Record<string, unknown>>,
    currentFanInRef: unknown,
  ): Promise<void> {
    const replayProjectionContext = new Map(byPath);
    for (const envelope of plan.compiled_envelopes) {
      replayProjectionContext.delete(envelope.artifact_path);
    }
    let projectedArtifacts: readonly CompilerReadyArtifact[];
    try {
      projectedArtifacts = this.projectArtifacts(
        request,
        planRef,
        currentPlan,
        replayProjectionContext,
        currentFanInRef,
      );
    } catch (error) {
      if (error instanceof StoreError) {
        throw new StoreError(
          "formal_materialization.publication_plan_semantics_mismatch",
          "authored stage semantics differ from the exact replay publication plan",
          { cause_code: error.code, cause_details: error.details },
        );
      }
      throw error;
    }
    let projectedCompilation: RuntimeArtifactCompilationResult;
    try {
      projectedCompilation = await this.compiler.compile(
        {
          schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
          request_id: request.request_id,
          run_id: request.run_id,
          operation: "validate_only",
          created_at: request.created_at,
          artifacts: projectedArtifacts,
        },
        { recoverPlanOperations: false },
      );
    } catch (error) {
      if (error instanceof StoreError) {
        throw new StoreError(
          "formal_materialization.publication_plan_semantics_mismatch",
          "authored stage semantics no longer compile to the exact replay publication plan",
          { cause_code: error.code, cause_details: error.details },
        );
      }
      throw error;
    }
    if (
      canonicalJson(projectedCompilation.compiled_envelopes) !==
        canonicalJson(plan.compiled_envelopes) ||
      canonicalJson(plan.publication) !==
        canonicalJson(
          plan.compiled_envelopes.map((envelope) => ({
            artifact_path: envelope.artifact_path,
            content_hash: envelope.content_hash,
          })),
        )
    ) {
      throw new StoreError(
        "formal_materialization.publication_plan_semantics_mismatch",
        "authored stage semantics differ from the exact replay publication plan",
      );
    }
  }

  private projectArtifacts(
    request: FormalStageMaterializationRequest,
    planRef: string,
    plan: Record<string, unknown>,
    byPath: ReadonlyMap<string, Record<string, unknown>>,
    currentFanInRef: unknown,
  ): readonly CompilerReadyArtifact[] {
    return request.stage_kind === "discovery_wave"
      ? this.projectWave(request, planRef, plan, byPath, currentFanInRef)
      : this.projectObjects(request, planRef, plan, byPath);
  }

  private projectWave(
    request: FormalStageMaterializationRequest,
    planRef: string,
    plan: Record<string, unknown>,
    byPath: ReadonlyMap<string, Record<string, unknown>>,
    currentFanInRef: unknown,
  ): readonly CompilerReadyArtifact[] {
    const wave = request.wave;
    if (wave === undefined)
      throw new StoreError(
        "formal_materialization.wave_missing",
        "discovery_wave requires one wave declaration",
      );
    if (plan.mode !== "opportunity_discovery") {
      throw new StoreError(
        "formal_materialization.wave_mode_invalid",
        "Discovery wave materialization requires an opportunity-discovery Plan",
      );
    }
    const planWaves = records(plan.waves);
    const selected = planWaves.find((entry) => entry.wave_id === wave.wave_id);
    if (selected === undefined)
      throw new StoreError(
        "formal_materialization.wave_missing",
        "declared wave is absent from current Plan",
        { waveId: wave.wave_id },
      );
    const units = records(selected.units);
    const selectedIds = unique(wave.unit_ids);
    const declaredIds = unique(wave.lanes.map((lane) => lane.unit_id));
    if (
      canonicalJson(selectedIds) !== canonicalJson(declaredIds) ||
      selectedIds.length === 0 ||
      selectedIds.length !== wave.unit_ids.length ||
      declaredIds.length !== wave.lanes.length
    ) {
      throw new StoreError(
        "formal_materialization.wave_lane_set_mismatch",
        "wave Unit and Lane sets must be non-empty, unique, and match exactly",
      );
    }
    const planUnits = new Map(units.map((unit) => [String(unit.unit_id), unit]));
    const retainedScopeAuthority = retainedCandidateScopeAuthority(
      byPath,
      planRef,
      currentFanInRef,
    );
    const scopeEntries = [...byPath.entries()].filter(([, document]) =>
      String(document.schema_version).startsWith("startup_opportunity.scope_frame."),
    );
    if (scopeEntries.length !== 1) {
      throw new StoreError(
        "formal_materialization.scope_frame_ambiguous",
        "the current Plan closure must identify exactly one same-Run Scope Frame",
        { scopeFrameRefs: scopeEntries.map(([ref]) => ref).sort() },
      );
    }
    const scopeFrameRef = scopeEntries[0]?.[0] as string;
    const executionRevision =
      Math.max(
        0,
        ...[...byPath.values()]
          .filter(
            (document) =>
              document.schema_version ===
              "startup_opportunity.research_execution_plan.discovery.current",
          )
          .map((document) => Number(document.revision) || 0),
      ) + 1;
    const executionPath = `plans/research-execution.r${executionRevision}.json`;
    const parentExecutionRef =
      executionRevision === 1 ? null : `plans/research-execution.r${executionRevision - 1}.json`;
    const dispatchDigest = operationKey("formal_dispatch", {
      request_id: request.request_id,
      wave_id: wave.wave_id,
    }).replace(/^sha256:/u, "");
    const dispatchGroup = wave.dispatch_group ?? `dispatch_${dispatchDigest.slice(0, 16)}`;
    const dispatchPath = `tasks/dispatch/${dispatchGroup}.r1.json`;
    const executionLanes: Record<string, unknown>[] = [];
    const dispatchTasks: Record<string, unknown>[] = [];
    const canonicalTasks: CompilerReadyArtifact[] = [];
    for (const lane of wave.lanes) {
      const unit = planUnits.get(lane.unit_id);
      if (unit === undefined || unit.plan_disposition !== "enabled")
        throw new StoreError(
          "formal_materialization.unit_invalid",
          "wave must select enabled current Plan units",
          { unitId: lane.unit_id },
        );
      const submissionPath = String(unit.output_path ?? "");
      const submissionSchema = String(unit.required_artifact_schema ?? "");
      const taskProjection = discoveryTaskProjectionForRequiredArtifactSchema(submissionSchema);
      if (taskProjection === null) {
        throw new StoreError(
          "formal_materialization.unit_output_unsupported",
          "selected Plan Unit has no canonical Discovery Task projection",
          { unitId: lane.unit_id, requiredArtifactSchema: submissionSchema },
        );
      }
      const laneProjectionIssues = discoveryWaveLaneProjectionIssues(wave.stage_kind, unit, lane, {
        retainedAuthorityRefs: retainedScopeAuthority.authorityRefs,
        retainedCandidateRefs: retainedScopeAuthority.candidateRefs,
      });
      if (laneProjectionIssues.length > 0) {
        throw new StoreError(
          "formal_materialization.wave_lane_semantics_invalid",
          "declared wave Lane semantics cannot be projected into the selected Plan Unit contract",
          { unitId: lane.unit_id, issues: laneProjectionIssues },
        );
      }
      const taskType = taskProjection.taskType;
      const reviewTask = taskType === DISCOVERY_REVIEW_TASK_SCHEMA;
      const taskSemantics = isRecord(lane.task_semantics) ? lane.task_semantics : {};
      const allPlanQuestionRefs = researchPlanQuestionRefs(planRef, plan);
      const hasExplicitQuestionAssignment = Object.hasOwn(
        taskSemantics,
        "assigned_plan_question_refs",
      );
      const assignedPlanQuestionRefs = reviewTask
        ? unique(
            hasExplicitQuestionAssignment
              ? strings(taskSemantics.assigned_plan_question_refs)
              : allPlanQuestionRefs,
          )
        : [];
      if (
        reviewTask &&
        (assignedPlanQuestionRefs.length === 0 ||
          assignedPlanQuestionRefs.some((ref) => !allPlanQuestionRefs.includes(ref)))
      ) {
        throw new StoreError(
          "formal_materialization.review_question_assignment_invalid",
          "Discovery adversarial review must assign a non-empty exact subset of current Plan questions",
          {
            unitId: lane.unit_id,
            assignedPlanQuestionRefs,
            currentPlanQuestionRefs: allPlanQuestionRefs,
          },
        );
      }
      const attempt = Number(unit.attempt);
      const taskDirectory = taskProjection.taskDirectory;
      const taskPath = `${taskDirectory}/${lane.unit_id}.attempt-${String(attempt)}.json`;
      const supersededUnitId =
        typeof unit.supersedes_unit_ref === "string"
          ? unit.supersedes_unit_ref.split("#", 2)[1]
          : undefined;
      if (attempt > 1 && (supersededUnitId === undefined || supersededUnitId === "")) {
        throw new StoreError(
          "formal_materialization.retry_binding_missing",
          "a retry Unit must identify the superseded Plan Unit",
          { unitId: lane.unit_id, supersedesUnitRef: unit.supersedes_unit_ref ?? null },
        );
      }
      const supersedesTaskRef =
        attempt === 1
          ? null
          : `${taskDirectory}/${supersededUnitId as string}.attempt-${String(attempt - 1)}.json`;
      const commercialResearchRequirements = {
        ...structuredClone(lane.commercial_research_semantics),
        resource_allocation: structuredClone(wave.resource_allocation),
        incumbent_response_assignment: structuredClone(lane.incumbent_response_assignment),
      } as Record<string, unknown>;
      const taskSemanticsForTask = structuredClone(taskSemantics);
      if (!reviewTask) {
        delete taskSemanticsForTask.assigned_plan_question_refs;
      }
      const laneSubmissionContract = deriveLaneSubmissionContract({
        runId: request.run_id,
        unitId: lane.unit_id,
        taskId: `task_${lane.unit_id}_attempt_${String(attempt)}`,
        attempt,
        formalOutputPath: submissionPath,
        formalArtifactSchema: submissionSchema,
        commercialAuditOutputPath:
          reviewTask ||
          typeof commercialResearchRequirements.commercial_audit_output_path !== "string"
            ? null
            : commercialResearchRequirements.commercial_audit_output_path,
      });
      const commercialAuditOutputPath =
        !reviewTask &&
        typeof commercialResearchRequirements.commercial_audit_output_path === "string"
          ? commercialResearchRequirements.commercial_audit_output_path
          : null;
      const taskDocument = {
        ...taskSemanticsForTask,
        schema_version: taskType,
        task_id: `task_${lane.unit_id}_attempt_${String(attempt)}`,
        run_id: request.run_id,
        unit_id: lane.unit_id,
        mode: plan.mode,
        phase: taskProjection.taskPhase,
        wave_id: wave.wave_id,
        unit_type: unit.unit_type,
        research_goal: unit.research_goal,
        commercial_research_requirements: commercialResearchRequirements,
        input_refs: unit.input_refs ?? [],
        attempt,
        supersedes_task_ref: supersedesTaskRef,
        agent_role: unit.agent_role,
        research_plan_ref: planRef,
        scope_frame_ref: scopeFrameRef,
        allowed_output_path: submissionPath,
        required_artifact_schema: submissionSchema,
        ...(reviewTask ? { assigned_plan_question_refs: assignedPlanQuestionRefs } : {}),
        lane_submission_contract: laneSubmissionContract,
        dispatched_at: request.created_at,
        completion_message_contract: {
          formal_artifact_authority: false,
          include_artifact_path: true,
          include_limitations: true,
        },
      };
      const executionLane = {
        unit_id: lane.unit_id,
        lane_role: lane.lane_role,
        candidate_scope: lane.candidate_scope,
        incumbent_response_assignment: lane.incumbent_response_assignment,
        reporting_dimensions: lane.reporting_dimensions,
        ...(reviewTask ? { assigned_plan_question_refs: assignedPlanQuestionRefs } : {}),
        submission_path: submissionPath,
        submission_schema: submissionSchema,
        commercial_audit_output_path: commercialAuditOutputPath,
        lane_submission_contract: laneSubmissionContract,
        time_budget_minutes: lane.time_budget_minutes,
        max_sources: lane.max_sources,
        straggler_policy: lane.straggler_policy,
        dispatch_group: dispatchGroup,
      };
      executionLanes.push(executionLane);
      dispatchTasks.push({
        task_id: taskDocument.task_id,
        unit_id: lane.unit_id,
        lane_role: lane.lane_role,
        incumbent_response_assignment: lane.incumbent_response_assignment,
        research_goal: unit.research_goal,
        input_refs: unit.input_refs ?? [],
        ...(reviewTask ? { assigned_plan_question_refs: assignedPlanQuestionRefs } : {}),
        allowed_output_path: submissionPath,
        required_artifact_schema: submissionSchema,
        commercial_audit_output_path: commercialAuditOutputPath,
        lane_submission_contract: laneSubmissionContract,
        time_budget_minutes: lane.time_budget_minutes,
        max_sources: lane.max_sources,
        straggler_policy: lane.straggler_policy,
      });
      canonicalTasks.push({
        artifact_type: taskType,
        artifact_path: taskPath,
        producer_role: "main_agent",
        input_refs: unique(request.top_level_formal_refs ?? []),
        document: taskDocument,
      });
    }
    const execution = {
      schema_version: "startup_opportunity.research_execution_plan.discovery.current",
      execution_plan_id: `execution_${wave.wave_id}_${dispatchGroup}`,
      run_id: request.run_id,
      mode: plan.mode,
      revision: executionRevision,
      parent_execution_plan_ref: parentExecutionRef,
      research_plan_ref: planRef,
      research_plan_hash: canonicalContentHash(plan),
      created_at: request.created_at,
      research_depth: wave.research_depth,
      total_time_budget_minutes: wave.total_time_budget_minutes,
      resource_allocation: wave.resource_allocation,
      stages: [
        {
          stage_id: wave.stage_id,
          stage_kind: wave.stage_kind,
          depends_on: [],
          gate_before: wave.gate_before,
          gate_after: wave.gate_after,
          lanes: executionLanes,
        },
      ],
      limitations: wave.limitations,
    };
    const dispatch = {
      schema_version: "startup_opportunity.dispatch_batch.discovery.current",
      batch_id: dispatchGroup,
      revision: 1,
      run_id: request.run_id,
      mode: plan.mode,
      execution_plan_ref: executionPath,
      research_plan_ref: planRef,
      stage_id: wave.stage_id,
      dispatch_group: dispatchGroup,
      task_ready_at: request.created_at,
      dispatch_requested_at: request.created_at,
      dispatch_mode: "parallel_immediate",
      tasks: dispatchTasks,
      agent_dispatch_performed: false,
      launch_registration_required: true,
      limitations: wave.limitations,
    };
    return [
      {
        artifact_type: execution.schema_version,
        artifact_path: executionPath,
        producer_role: "main_agent",
        input_refs: unique(request.top_level_formal_refs ?? []),
        document: execution,
      },
      {
        artifact_type: dispatch.schema_version,
        artifact_path: dispatchPath,
        producer_role: "harness",
        input_refs: unique(request.top_level_formal_refs ?? []),
        document: dispatch,
      },
      ...canonicalTasks,
    ];
  }

  private projectObjects(
    request: FormalStageMaterializationRequest,
    planRef: string,
    plan: Record<string, unknown>,
    byPath: ReadonlyMap<string, Record<string, unknown>>,
  ): readonly CompilerReadyArtifact[] {
    const artifacts = request.artifacts ?? [];
    if (artifacts.length === 0)
      throw new StoreError(
        "formal_materialization.artifacts_missing",
        "object materialization requires explicit semantic artifacts",
      );
    const scopeEntries = [...byPath.entries()].filter(
      ([, document]) =>
        String(document.schema_version).startsWith("startup_opportunity.scope_frame.") &&
        document.run_id === request.run_id,
    );
    if (scopeEntries.length !== 1 || scopeEntries[0] === undefined) {
      throw new StoreError(
        "formal_materialization.current_scope_invalid",
        "formal object projection requires exactly one selected current same-Run Scope Frame",
        { scopeCount: scopeEntries.length },
      );
    }
    const [scopeRef, scope] = scopeEntries[0];
    const projectionContext: DiscoveryStageProjectionContext = {
      runId: request.run_id,
      currentPlanRef: planRef,
      currentPlan: plan,
      currentScopeRef: scopeRef,
      currentScope: scope,
      documentsByPath: byPath,
    };
    if (request.stage_kind === "discovery_setup") {
      const policyDocument = JSON.parse(
        readFileSync(path.join(this.repositoryRoot, DISCOVERY_MAPS_POLICY_PATH), "utf8"),
      ) as Record<string, unknown>;
      return projectDiscoverySetup(artifacts, projectionContext, {
        policyRef: DISCOVERY_MAPS_POLICY_PATH,
        document: policyDocument,
      });
    }
    if (request.stage_kind === "candidate_fan_in") {
      if (request.fan_in === undefined) {
        throw new StoreError(
          "formal_materialization.fan_in_authority_missing",
          "candidate fan-in requires one explicit Dispatch and per-Lane authority declaration",
        );
      }
      return projectCandidateFanIn(artifacts, request.fan_in, projectionContext);
    }
    return projectDiscoverySynthesis(artifacts, projectionContext);
  }
}

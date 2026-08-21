import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import {
  deriveLaneScopeFormalClosure,
  laneScopeCoverageFromClosure,
} from "../runtime/lane-delivery-closure.js";
import {
  canonicalLaneLifecycleId,
  canonicalLaneLifecyclePath,
  dispatchLaunchRegistrationPath,
  dispatchLaunchRequestFromRegistration,
} from "../runtime/lane-lifecycle-identity.js";
import { sortIssues, type ValidationIssue } from "./schema-bundle.js";

export interface DeclarativeRuntimeDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

const RUNTIME_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.research_execution_plan.discovery.current",
  "startup_opportunity.dispatch_batch.discovery.current",
  "startup_opportunity.lane_lifecycle.v1",
  "startup_opportunity.dispatch_launch_registration.v1",
  "startup_opportunity.candidate_neutral_evidence.v1",
  "startup_opportunity.discovery_generation_result.v1",
  "startup_opportunity.discovery_stage_readiness.v1",
  "startup_opportunity.source_manifest.discovery_runtime.current",
  "startup_opportunity.gap_snapshot.discovery.readiness.current",
  "startup_opportunity.lane_delivery_receipt.current",
]);

const DISCOVERY_SYNTHESIS_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.discovery_candidate_conversion.v2",
  "startup_opportunity.demand_thesis.v1",
  "startup_opportunity.baseline_option.v1",
  "startup_opportunity.solution_hypothesis.v1",
  "startup_opportunity.solution_evaluation.v1",
  "startup_opportunity.opportunity_thesis.v1",
  "startup_opportunity.thesis_evaluation_snapshot.v1",
  "startup_opportunity.merge.v1",
]);

const DISCOVERY_JUDGMENT_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.judgment_assessment.discovery_candidate.current",
  "startup_opportunity.judgment_assessment.discovery_evaluation.current",
]);

const STAGE_ORDER = [
  "discovery_generation",
  "hard_gate_scan",
  "candidate_evaluation",
  "retained_candidate_deep_review",
  "discovery_synthesis",
] as const;

const LIFECYCLE_STATES = [
  "dispatch_requested",
  "agent_started",
  "researching",
  "evidence_recorded",
  "handoff_ready",
  "formalization_validated",
  "published",
] as const;

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

function issue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "declarative_runtime",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson([...new Set(left)].sort()) === canonicalJson([...new Set(right)].sort());
}

function latestDocument(
  documents: readonly DeclarativeRuntimeDocument[],
): DeclarativeRuntimeDocument | null {
  return (
    [...documents].sort((left, right) => {
      const createdDifference =
        Date.parse(String(right.envelope?.created_at ?? right.document.created_at ?? "")) -
        Date.parse(String(left.envelope?.created_at ?? left.document.created_at ?? ""));
      if (Number.isFinite(createdDifference) && createdDifference !== 0) return createdDifference;
      const revisionDifference =
        Number(right.document.revision ?? 0) - Number(left.document.revision ?? 0);
      return revisionDifference !== 0 ? revisionDifference : right.path.localeCompare(left.path);
    })[0] ?? null
  );
}

function target(
  byPath: ReadonlyMap<string, DeclarativeRuntimeDocument>,
  ref: unknown,
): DeclarativeRuntimeDocument | null {
  return typeof ref === "string" ? (byPath.get(ref.split("#", 1)[0] ?? "") ?? null) : null;
}

function planUnits(plan: Record<string, unknown>): readonly {
  readonly waveId: string;
  readonly unit: Record<string, unknown>;
}[] {
  return records(plan.waves).flatMap((wave) =>
    typeof wave.wave_id === "string"
      ? records(wave.units).map((unit) => ({ waveId: wave.wave_id as string, unit }))
      : [],
  );
}

function stageById(
  execution: Record<string, unknown>,
  stageId: unknown,
): Record<string, unknown> | null {
  return records(execution.stages).find((stage) => stage.stage_id === stageId) ?? null;
}

function laneByUnit(
  execution: Record<string, unknown>,
  unitId: unknown,
): { readonly stage: Record<string, unknown>; readonly lane: Record<string, unknown> } | null {
  for (const stage of records(execution.stages)) {
    const lane = records(stage.lanes).find((entry) => entry.unit_id === unitId);
    if (lane !== undefined) {
      return { stage, lane };
    }
  }
  return null;
}

function dependencyClosure(
  stages: ReadonlyMap<string, Record<string, unknown>>,
  stageId: string,
): ReadonlySet<string> {
  const closure = new Set<string>();
  const pending = [...strings(stages.get(stageId)?.depends_on)];
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (dependency === undefined || closure.has(dependency)) {
      continue;
    }
    closure.add(dependency);
    pending.push(...strings(stages.get(dependency)?.depends_on));
  }
  return closure;
}

function validateExecutionPlan(
  entry: DeclarativeRuntimeDocument,
  byPath: ReadonlyMap<string, DeclarativeRuntimeDocument>,
  errors: ValidationIssue[],
): void {
  const execution = entry.document;
  const plan = target(byPath, execution.research_plan_ref);
  if (plan?.schemaVersion !== "startup_opportunity.research_plan.v1") {
    return;
  }
  if (
    execution.run_id !== plan.document.run_id ||
    execution.mode !== plan.document.mode ||
    execution.research_plan_hash !== canonicalContentHash(plan.document)
  ) {
    errors.push(
      issue(
        "runtime.execution_plan_binding_mismatch",
        entry.path,
        "execution plan must bind the exact same-Run Research Plan content",
      ),
    );
  }
  const expectedPath = `plans/research-execution.r${String(execution.revision)}.json`;
  if (entry.path !== expectedPath) {
    errors.push(
      issue(
        "runtime.execution_plan_path_mismatch",
        entry.path,
        "execution plan path must match revision",
        {
          expectedPath,
        },
      ),
    );
  }
  const units = new Map(
    planUnits(plan.document).map((item) => [String(item.unit.unit_id), item] as const),
  );
  const stages = records(execution.stages);
  const stagesById = new Map(
    stages
      .filter((stage) => typeof stage.stage_id === "string")
      .map((stage) => [stage.stage_id as string, stage] as const),
  );
  if (stagesById.size !== stages.length) {
    errors.push(issue("runtime.stage_identity_conflict", entry.path, "stage ids must be unique"));
  }
  for (const stage of stages) {
    const stageId = String(stage.stage_id ?? "");
    for (const dependency of strings(stage.depends_on)) {
      if (!stagesById.has(dependency) || dependency === stageId) {
        errors.push(
          issue(
            "runtime.stage_dependency_invalid",
            `${entry.path}#${stageId}`,
            "stage dependency must identify another stage",
            { dependency },
          ),
        );
      }
    }
  }
  const seenUnits = new Set<string>();
  const dispatchWaves = new Map<string, Set<string>>();
  for (const stage of stages) {
    const stageId = String(stage.stage_id ?? "");
    const kind = String(stage.stage_kind ?? "");
    const stageLanes = records(stage.lanes);
    const incumbentOwners = stageLanes.filter((lane) => {
      const assignment = isRecord(lane.incumbent_response_assignment)
        ? lane.incumbent_response_assignment
        : {};
      return assignment.assignment_role === "owner";
    });
    const incumbentReviewers = stageLanes.filter((lane) => {
      const assignment = isRecord(lane.incumbent_response_assignment)
        ? lane.incumbent_response_assignment
        : {};
      return assignment.assignment_role === "independent_review";
    });
    const responseStage = ["candidate_evaluation", "retained_candidate_deep_review"].includes(kind);
    if (
      (responseStage && incumbentOwners.length !== 1) ||
      (!responseStage && incumbentOwners.length !== 0) ||
      (incumbentReviewers.length > 0 && incumbentOwners.length !== 1)
    ) {
      errors.push(
        issue(
          "runtime.incumbent_response_owner_invalid",
          `${entry.path}#${stageId}/lanes`,
          "each incumbent response stage requires exactly one explicit owner; independent review is allowed only alongside that owner",
          {
            stageKind: kind,
            ownerUnitIds: incumbentOwners.map((lane) => lane.unit_id),
            reviewerUnitIds: incumbentReviewers.map((lane) => lane.unit_id),
          },
        ),
      );
    }
    for (const lane of stageLanes) {
      const unitId = String(lane.unit_id ?? "");
      const planned = units.get(unitId);
      if (seenUnits.has(unitId)) {
        errors.push(
          issue(
            "runtime.execution_unit_duplicate",
            `${entry.path}#${stageId}`,
            "one Research Plan unit cannot be scheduled by multiple semantic stages",
            { unitId },
          ),
        );
      }
      seenUnits.add(unitId);
      if (planned === undefined || planned.unit.plan_disposition !== "enabled") {
        errors.push(
          issue(
            "runtime.execution_unit_missing",
            `${entry.path}#${stageId}`,
            "execution lane must bind one enabled Research Plan unit",
            { unitId },
          ),
        );
        continue;
      }
      const scope = isRecord(lane.candidate_scope) ? lane.candidate_scope : {};
      const candidateRefs = strings(scope.candidate_refs);
      const incumbentAssignment = isRecord(lane.incumbent_response_assignment)
        ? lane.incumbent_response_assignment
        : {};
      const allowedIncumbentDepths =
        kind === "candidate_evaluation"
          ? ["not_assigned", "lightweight_scan"]
          : kind === "retained_candidate_deep_review"
            ? ["not_assigned", "targeted_deep_dive"]
            : ["not_assigned"];
      const assigned = incumbentAssignment.analysis_depth !== "not_assigned";
      if (
        !allowedIncumbentDepths.includes(String(incumbentAssignment.analysis_depth)) ||
        (assigned &&
          !["owner", "independent_review"].includes(String(incumbentAssignment.assignment_role))) ||
        (!assigned && incumbentAssignment.assignment_role !== "none") ||
        (!assigned && strings(incumbentAssignment.subject_refs).length !== 0) ||
        (assigned && strings(incumbentAssignment.subject_refs).length === 0) ||
        (scope.kind === "explicit" &&
          assigned &&
          !sameStrings(strings(incumbentAssignment.subject_refs), candidateRefs))
      ) {
        errors.push(
          issue(
            "runtime.incumbent_response_assignment_invalid",
            `${entry.path}#${stageId}/${unitId}/incumbent_response_assignment`,
            "incumbent response work must start after candidate formation, use lightweight candidate scans, and reserve targeted deep dives for retained candidates",
            { allowedIncumbentDepths },
          ),
        );
      }
      if (
        (scope.kind === "none" && candidateRefs.length !== 0) ||
        (scope.kind === "retained" && candidateRefs.length !== 0) ||
        (scope.kind === "explicit" && candidateRefs.length === 0)
      ) {
        errors.push(
          issue(
            "runtime.candidate_scope_invalid",
            `${entry.path}#${stageId}/${unitId}`,
            "candidate scope kind and explicit candidate refs disagree",
          ),
        );
      }
      if (
        kind === "discovery_generation" &&
        (lane.lane_role !== "opportunity" ||
          scope.kind !== "none" ||
          lane.submission_schema !== "startup_opportunity.discovery_generation_result.v1")
      ) {
        errors.push(
          issue(
            "runtime.generation_not_candidate_neutral",
            `${entry.path}#${stageId}/${unitId}`,
            "Discovery generation must be an opportunity lane with no candidate scope and a neutral submission",
          ),
        );
      }
      if (
        kind !== "discovery_generation" &&
        (lane.submission_path !== planned.unit.output_path ||
          lane.submission_schema !== planned.unit.required_artifact_schema)
      ) {
        errors.push(
          issue(
            "runtime.execution_unit_contract_mismatch",
            `${entry.path}#${stageId}/${unitId}`,
            "non-generation lane submission must equal its immutable Research Plan output contract",
          ),
        );
      }
      if (kind === "hard_gate_scan" && lane.lane_role !== "risk") {
        errors.push(
          issue(
            "runtime.hard_gate_role_invalid",
            `${entry.path}#${stageId}/${unitId}`,
            "hard-gate scans must use the bounded risk role",
          ),
        );
      }
      if (kind === "candidate_evaluation" && lane.lane_role !== "evaluation") {
        errors.push(
          issue(
            "runtime.evaluation_role_invalid",
            `${entry.path}#${stageId}/${unitId}`,
            "candidate evaluation must use evaluation lanes",
          ),
        );
      }
      if (kind === "retained_candidate_deep_review" && scope.kind !== "retained") {
        errors.push(
          issue(
            "runtime.deep_review_scope_invalid",
            `${entry.path}#${stageId}/${unitId}`,
            "deep review must operate on the retained-candidate scope",
          ),
        );
      }
      if (Number(lane.time_budget_minutes) > Number(execution.total_time_budget_minutes)) {
        errors.push(
          issue(
            "runtime.lane_budget_exceeds_total",
            `${entry.path}#${stageId}/${unitId}`,
            "lane time budget cannot exceed the Run research budget",
          ),
        );
      }
      const group = String(lane.dispatch_group ?? "");
      const waveSet = dispatchWaves.get(group) ?? new Set<string>();
      waveSet.add(planned.waveId);
      dispatchWaves.set(group, waveSet);
    }
  }
  for (const [group, waves] of dispatchWaves) {
    if (waves.size > 1) {
      errors.push(
        issue(
          "runtime.dispatch_group_crosses_wave",
          entry.path,
          "one dispatch group must remain within one immutable Research Plan wave",
          { dispatchGroup: group, waves: [...waves].sort() },
        ),
      );
    }
  }
  if (execution.mode === "opportunity_discovery") {
    const stageForKind = new Map(
      stages.map((stage) => [String(stage.stage_kind), String(stage.stage_id)] as const),
    );
    for (let index = 1; index < STAGE_ORDER.length; index += 1) {
      const current = stageForKind.get(STAGE_ORDER[index] ?? "");
      if (current === undefined) {
        continue;
      }
      const requiredPriorKinds = STAGE_ORDER.slice(0, index);
      const prior = [...requiredPriorKinds]
        .reverse()
        .map((stageKind) => stageForKind.get(stageKind))
        .find((value): value is string => value !== undefined);
      if (prior !== undefined && !dependencyClosure(stagesById, current).has(prior)) {
        errors.push(
          issue(
            "runtime.discovery_stage_order_invalid",
            `${entry.path}#${current}`,
            "Discovery evaluation and review stages must depend on the preceding semantic stage",
            { requiredDependency: prior },
          ),
        );
      }
    }
    const hardGate = stageForKind.get("hard_gate_scan");
    const deepReview = stageForKind.get("retained_candidate_deep_review");
    if (hardGate !== undefined && deepReview !== undefined && hardGate === deepReview) {
      errors.push(
        issue(
          "runtime.hard_gate_deep_review_not_separate",
          entry.path,
          "hard-gate scan and retained-candidate deep review must be separate stages",
        ),
      );
    }
  }
  const costByStage = new Map(
    stages.map((stage) => [
      String(stage.stage_id),
      Math.max(0, ...records(stage.lanes).map((lane) => Number(lane.time_budget_minutes) || 0)),
    ]),
  );
  const memo = new Map<string, number>();
  const visitCost = (stageId: string, visiting = new Set<string>()): number => {
    if (visiting.has(stageId)) {
      errors.push(
        issue(
          "runtime.stage_dependency_cycle",
          `${entry.path}#${stageId}`,
          "stage graph is cyclic",
        ),
      );
      return Number.POSITIVE_INFINITY;
    }
    const cached = memo.get(stageId);
    if (cached !== undefined) {
      return cached;
    }
    const nextVisiting = new Set(visiting).add(stageId);
    const prior = Math.max(
      0,
      ...strings(stagesById.get(stageId)?.depends_on).map((dependency) =>
        visitCost(dependency, nextVisiting),
      ),
    );
    const cost = prior + (costByStage.get(stageId) ?? 0);
    memo.set(stageId, cost);
    return cost;
  };
  const minimumBudget = Math.max(0, ...[...stagesById.keys()].map((stageId) => visitCost(stageId)));
  if (Number(execution.total_time_budget_minutes) < minimumBudget) {
    errors.push(
      issue(
        "runtime.total_budget_underdeclared",
        `${entry.path}#/total_time_budget_minutes`,
        "total budget must cover the longest sequential stage path while allowing same-group parallelism",
        { minimumBudget },
      ),
    );
  }
}

function validateDispatchBatch(
  entry: DeclarativeRuntimeDocument,
  byPath: ReadonlyMap<string, DeclarativeRuntimeDocument>,
  errors: ValidationIssue[],
): void {
  const batch = entry.document;
  const execution = target(byPath, batch.execution_plan_ref);
  const plan = target(byPath, batch.research_plan_ref);
  if (
    execution?.schemaVersion !== "startup_opportunity.research_execution_plan.discovery.current" ||
    plan?.schemaVersion !== "startup_opportunity.research_plan.v1"
  ) {
    return;
  }
  const stage = stageById(execution.document, batch.stage_id);
  if (
    stage === null ||
    batch.run_id !== execution.document.run_id ||
    batch.run_id !== plan.document.run_id ||
    batch.mode !== execution.document.mode ||
    execution.document.research_plan_ref !== batch.research_plan_ref
  ) {
    errors.push(
      issue(
        "runtime.dispatch_binding_mismatch",
        entry.path,
        "dispatch batch must bind one exact execution stage and Research Plan",
      ),
    );
    return;
  }
  if (Date.parse(String(batch.task_ready_at)) > Date.parse(String(batch.dispatch_requested_at))) {
    errors.push(
      issue(
        "runtime.dispatch_time_order_invalid",
        entry.path,
        "dispatch request cannot precede task readiness",
      ),
    );
  }
  const expectedLanes = records(stage.lanes).filter(
    (lane) => lane.dispatch_group === batch.dispatch_group,
  );
  const tasks = records(batch.tasks);
  if (
    expectedLanes.length === 0 ||
    !sameStrings(
      expectedLanes.map((lane) => String(lane.unit_id)),
      tasks.map((task) => String(task.unit_id)),
    )
  ) {
    errors.push(
      issue(
        "runtime.dispatch_group_incomplete",
        entry.path,
        "dispatch batch must contain the complete same-stage dispatch group",
      ),
    );
  }
  const units = new Map(
    planUnits(plan.document).map((item) => [String(item.unit.unit_id), item.unit]),
  );
  const lanes = new Map(expectedLanes.map((lane) => [String(lane.unit_id), lane]));
  const taskIds = tasks.map((task) => String(task.task_id));
  if (new Set(taskIds).size !== taskIds.length) {
    errors.push(
      issue("runtime.dispatch_task_identity_conflict", entry.path, "task ids must be unique"),
    );
  }
  for (const task of tasks) {
    const unitId = String(task.unit_id ?? "");
    const unit = units.get(unitId);
    const lane = lanes.get(unitId);
    if (
      unit === undefined ||
      lane === undefined ||
      task.lane_role !== lane.lane_role ||
      canonicalJson(task.incumbent_response_assignment) !==
        canonicalJson(lane.incumbent_response_assignment) ||
      task.research_goal !== unit.research_goal ||
      !sameStrings(strings(task.input_refs), strings(unit.input_refs)) ||
      task.allowed_output_path !== lane.submission_path ||
      task.required_artifact_schema !== lane.submission_schema ||
      task.time_budget_minutes !== lane.time_budget_minutes ||
      task.max_sources !== lane.max_sources ||
      canonicalJson(task.straggler_policy) !== canonicalJson(lane.straggler_policy)
    ) {
      errors.push(
        issue(
          "runtime.dispatch_task_contract_mismatch",
          `${entry.path}#${String(task.task_id)}`,
          "dispatch task must be a deterministic projection of its Plan unit and execution overlay lane",
          { unitId },
        ),
      );
    }
  }
}

function validateLifecycle(
  entry: DeclarativeRuntimeDocument,
  byPath: ReadonlyMap<string, DeclarativeRuntimeDocument>,
  errors: ValidationIssue[],
): void {
  const lifecycle = entry.document;
  const revision = Number(lifecycle.revision);
  const expectedLifecycleId = canonicalLaneLifecycleId(lifecycle);
  const expectedPath = canonicalLaneLifecyclePath(lifecycle, revision);
  if (lifecycle.lifecycle_id !== expectedLifecycleId || entry.path !== expectedPath) {
    errors.push(
      issue(
        "runtime.lifecycle_identity_invalid",
        entry.path,
        "lifecycle id and path must be the canonical projection of one exact execution attempt",
        { expectedLifecycleId, expectedPath },
      ),
    );
  }
  const batch = target(byPath, lifecycle.dispatch_batch_ref);
  if (
    batch === null ||
    ![
      "startup_opportunity.dispatch_batch.discovery.current",
      "startup_opportunity.dispatch_batch.assessment.current",
    ].includes(batch.schemaVersion)
  ) {
    return;
  }
  const taskId = String(lifecycle.dispatch_batch_ref).split("#", 2)[1];
  const task = records(batch.document.tasks).find((candidate) => candidate.task_id === taskId);
  if (
    task === undefined ||
    lifecycle.run_id !== batch.document.run_id ||
    lifecycle.unit_id !== task.unit_id ||
    lifecycle.task_id !== task.task_id ||
    lifecycle.task_ref !== lifecycle.dispatch_batch_ref ||
    lifecycle.dispatch_batch_hash !== canonicalContentHash(batch.document)
  ) {
    errors.push(
      issue(
        "runtime.lifecycle_dispatch_mismatch",
        entry.path,
        "lifecycle observation must bind the exact dispatch task",
      ),
    );
  }
  const timestamps = isRecord(lifecycle.timestamps) ? lifecycle.timestamps : {};
  const taskReadyAt = batch.document.task_ready_at ?? batch.document.requested_at;
  const dispatchRequestedAt = batch.document.dispatch_requested_at ?? batch.document.requested_at;
  if (
    timestamps.task_ready_at !== taskReadyAt ||
    timestamps.dispatch_requested_at !== dispatchRequestedAt
  ) {
    errors.push(
      issue(
        "runtime.lifecycle_dispatch_time_mismatch",
        entry.path,
        "lifecycle readiness and dispatch timestamps must come from the batch",
      ),
    );
  }
  const orderedTimestampFields = [
    "task_ready_at",
    "dispatch_requested_at",
    "agent_started_at",
    "evidence_recorded_at",
    "handoff_ready_at",
    "formalization_validated_at",
    "published_at",
  ] as const;
  let previous = Number.NEGATIVE_INFINITY;
  let nullSeen = false;
  for (const field of orderedTimestampFields) {
    const value = timestamps[field];
    if (value === null) {
      nullSeen = true;
      continue;
    }
    if (typeof value !== "string") {
      continue;
    }
    const current = Date.parse(value);
    if (nullSeen || current < previous) {
      errors.push(
        issue(
          "runtime.lifecycle_time_order_invalid",
          `${entry.path}#/timestamps/${field}`,
          "lifecycle timestamps must be a monotonic populated prefix",
        ),
      );
    }
    previous = current;
  }
  const state = String(lifecycle.state ?? "");
  const stateIndex = LIFECYCLE_STATES.indexOf(state as (typeof LIFECYCLE_STATES)[number]);
  const requiredTimestampIndex = new Map([
    ["agent_started", 2],
    ["researching", 2],
    ["evidence_recorded", 3],
    ["handoff_ready", 4],
    ["formalization_validated", 5],
    ["published", 6],
  ]).get(state);
  if (
    requiredTimestampIndex !== undefined &&
    timestamps[orderedTimestampFields[requiredTimestampIndex] as string] === null
  ) {
    errors.push(
      issue(
        "runtime.lifecycle_state_time_mismatch",
        entry.path,
        "lifecycle state requires its corresponding timestamp",
      ),
    );
  }
  const failureState = ["failed", "partial", "late_ignored"].includes(state);
  if (failureState !== isRecord(lifecycle.failure)) {
    errors.push(
      issue(
        "runtime.lifecycle_failure_mismatch",
        entry.path,
        "terminal exceptional lifecycle states require failure detail and normal states forbid it",
      ),
    );
  }
  const lifecycleRootRef = canonicalLaneLifecyclePath(lifecycle, 1);
  const lifecycleRoot = target(byPath, lifecycleRootRef);
  const registration = target(byPath, lifecycle.launch_registration_ref);
  if (typeof lifecycle.launch_registration_ref === "string") {
    const registrationEntry = records(registration?.document.registrations).find(
      (candidate) => candidate.lifecycle_ref === lifecycleRootRef,
    );
    if (
      registration?.schemaVersion !== "startup_opportunity.dispatch_launch_registration.v1" ||
      lifecycleRoot?.schemaVersion !== "startup_opportunity.lane_lifecycle.v1" ||
      lifecycleRoot.document.revision !== 1 ||
      registration?.document.registration_id !== lifecycle.launch_registration_id ||
      registration?.document.request_hash !== lifecycle.launch_registration_hash ||
      registration?.document.run_id !== lifecycle.run_id ||
      registration?.document.dispatch_ref !==
        String(lifecycle.dispatch_batch_ref).split("#", 1)[0] ||
      registration?.document.dispatch_hash !== lifecycle.dispatch_batch_hash ||
      registrationEntry === undefined ||
      registrationEntry.unit_id !== lifecycle.unit_id ||
      registrationEntry.task_ref !== lifecycle.task_ref ||
      registrationEntry.task_id !== lifecycle.task_id ||
      registrationEntry.attempt !== lifecycle.attempt ||
      registrationEntry.execution_attempt_id !== lifecycle.execution_attempt_id ||
      registrationEntry.lifecycle_hash !== canonicalContentHash(lifecycleRoot.document)
    ) {
      errors.push(
        issue(
          "runtime.lifecycle_launch_registration_invalid",
          entry.path,
          "launch lifecycle must resolve to the exact formal registration and registered root hash",
        ),
      );
    }
  }
  const parent = target(byPath, lifecycle.parent_lifecycle_ref);
  if (revision === 1) {
    if (lifecycle.parent_lifecycle_ref !== null) {
      errors.push(
        issue(
          "runtime.lifecycle_root_invalid",
          entry.path,
          "lifecycle revision one must be the single canonical root with no parent",
        ),
      );
    }
    return;
  }
  const expectedParentRef = canonicalLaneLifecyclePath(lifecycle, revision - 1);
  if (
    lifecycle.parent_lifecycle_ref !== expectedParentRef ||
    parent?.schemaVersion !== "startup_opportunity.lane_lifecycle.v1" ||
    Number(parent.document.revision) + 1 !== revision ||
    parent.document.lifecycle_id !== lifecycle.lifecycle_id ||
    parent.document.run_id !== lifecycle.run_id ||
    parent.document.unit_id !== lifecycle.unit_id ||
    parent.document.attempt !== lifecycle.attempt ||
    parent.document.execution_attempt_id !== lifecycle.execution_attempt_id ||
    parent.document.dispatch_batch_ref !== lifecycle.dispatch_batch_ref ||
    parent.document.dispatch_batch_hash !== lifecycle.dispatch_batch_hash ||
    parent.document.task_ref !== lifecycle.task_ref ||
    parent.document.task_id !== lifecycle.task_id ||
    parent.document.launch_registration_ref !== lifecycle.launch_registration_ref ||
    parent.document.launch_registration_id !== lifecycle.launch_registration_id ||
    parent.document.launch_registration_hash !== lifecycle.launch_registration_hash
  ) {
    errors.push(
      issue(
        "runtime.lifecycle_lineage_invalid",
        entry.path,
        "lifecycle revision must advance one immutable observation for the same dispatch attempt",
      ),
    );
    return;
  }
  const parentIndex = LIFECYCLE_STATES.indexOf(
    String(parent.document.state) as (typeof LIFECYCLE_STATES)[number],
  );
  if (stateIndex >= 0 && parentIndex >= 0 && stateIndex < parentIndex) {
    errors.push(
      issue("runtime.lifecycle_state_regression", entry.path, "lifecycle state cannot regress"),
    );
  }
}

function validateDispatchLaunchRegistration(
  entry: DeclarativeRuntimeDocument,
  byPath: ReadonlyMap<string, DeclarativeRuntimeDocument>,
  errors: ValidationIssue[],
): void {
  const registration = entry.document;
  const items = records(registration.registrations);
  const expectedPath = dispatchLaunchRegistrationPath(String(registration.registration_id));
  const request = dispatchLaunchRequestFromRegistration(registration);
  const batch = target(byPath, registration.dispatch_ref);
  if (
    entry.path !== expectedPath ||
    registration.request_hash !== canonicalContentHash(request) ||
    batch === null ||
    ![
      "startup_opportunity.dispatch_batch.discovery.current",
      "startup_opportunity.dispatch_batch.assessment.current",
    ].includes(batch.schemaVersion) ||
    batch.document.run_id !== registration.run_id ||
    canonicalContentHash(batch.document) !== registration.dispatch_hash
  ) {
    errors.push(
      issue(
        "runtime.launch_registration_authority_invalid",
        entry.path,
        "formal launch registration must bind its canonical path, exact request, and Dispatch",
        { expectedPath },
      ),
    );
  }
  const unitAttempts = new Set<string>();
  const executionAttempts = new Set<string>();
  const lifecycleRefs = new Set<string>();
  for (const item of items) {
    const unitAttempt = canonicalJson({
      unit_id: item.unit_id,
      task_ref: item.task_ref,
      task_id: item.task_id,
      attempt: item.attempt,
    });
    const executionAttempt = String(item.execution_attempt_id ?? "");
    const lifecycleRef = String(item.lifecycle_ref ?? "");
    if (
      unitAttempts.has(unitAttempt) ||
      executionAttempts.has(executionAttempt) ||
      lifecycleRefs.has(lifecycleRef)
    ) {
      errors.push(
        issue(
          "runtime.launch_registration_items_conflict",
          `${entry.path}#/registrations`,
          "one registration batch cannot repeat a Dispatch task, execution attempt, or lifecycle root",
        ),
      );
    }
    unitAttempts.add(unitAttempt);
    executionAttempts.add(executionAttempt);
    lifecycleRefs.add(lifecycleRef);
    const lifecycle = target(byPath, item.lifecycle_ref);
    if (
      lifecycle?.schemaVersion !== "startup_opportunity.lane_lifecycle.v1" ||
      lifecycle.document.revision !== 1 ||
      lifecycle.document.launch_registration_ref !== entry.path ||
      lifecycle.document.launch_registration_id !== registration.registration_id ||
      lifecycle.document.launch_registration_hash !== registration.request_hash ||
      lifecycle.document.unit_id !== item.unit_id ||
      lifecycle.document.task_ref !== item.task_ref ||
      lifecycle.document.task_id !== item.task_id ||
      lifecycle.document.attempt !== item.attempt ||
      lifecycle.document.execution_attempt_id !== item.execution_attempt_id ||
      item.lifecycle_hash !== canonicalContentHash(lifecycle.document)
    ) {
      errors.push(
        issue(
          "runtime.launch_registration_lifecycle_invalid",
          `${entry.path}#/registrations`,
          "each formal registration item must bind one exact canonical lifecycle root",
          { lifecycleRef: item.lifecycle_ref },
        ),
      );
    }
  }
}

function validateGenerationResult(
  entry: DeclarativeRuntimeDocument,
  byPath: ReadonlyMap<string, DeclarativeRuntimeDocument>,
  errors: ValidationIssue[],
): void {
  const result = entry.document;
  const batch = target(byPath, result.dispatch_batch_ref);
  if (batch?.schemaVersion !== "startup_opportunity.dispatch_batch.discovery.current") {
    return;
  }
  const taskId = String(result.dispatch_batch_ref).split("#", 2)[1];
  const task = records(batch.document.tasks).find((candidate) => candidate.task_id === taskId);
  const execution = target(byPath, batch.document.execution_plan_ref);
  const lane =
    execution?.schemaVersion === "startup_opportunity.research_execution_plan.discovery.current"
      ? laneByUnit(execution.document, result.unit_id)
      : null;
  if (
    task === undefined ||
    lane === null ||
    lane.stage.stage_kind !== "discovery_generation" ||
    task.unit_id !== result.unit_id ||
    task.required_artifact_schema !== result.schema_version ||
    task.allowed_output_path !== entry.path ||
    result.run_id !== batch.document.run_id ||
    result.research_plan_ref !== batch.document.research_plan_ref
  ) {
    errors.push(
      issue(
        "runtime.generation_dispatch_mismatch",
        entry.path,
        "generation result must be the candidate-neutral submission for its exact generation task",
      ),
    );
  }
  const manifest = target(byPath, result.source_manifest_ref);
  if (
    manifest?.schemaVersion !== "startup_opportunity.source_manifest.discovery_runtime.current" ||
    manifest.document.unit_id !== result.unit_id ||
    manifest.document.research_phase_role !== "candidate_generation"
  ) {
    errors.push(
      issue(
        "runtime.generation_source_manifest_mismatch",
        entry.path,
        "generation result must bind a candidate-generation Source Manifest for the same unit",
      ),
    );
  }
}

function validateCandidateNeutralEvidence(
  entry: DeclarativeRuntimeDocument,
  byPath: ReadonlyMap<string, DeclarativeRuntimeDocument>,
  exactJsonlRecords: ReadonlyMap<string, Record<string, unknown>>,
  errors: ValidationIssue[],
): void {
  const evidence = entry.document;
  const batch = target(byPath, evidence.dispatch_batch_ref);
  if (batch?.schemaVersion !== "startup_opportunity.dispatch_batch.discovery.current") {
    return;
  }
  const taskId = String(evidence.dispatch_batch_ref).split("#", 2)[1];
  const task = records(batch.document.tasks).find((candidate) => candidate.task_id === taskId);
  const execution = target(byPath, batch.document.execution_plan_ref);
  const lane =
    execution?.schemaVersion === "startup_opportunity.research_execution_plan.discovery.current"
      ? laneByUnit(execution.document, evidence.unit_id)
      : null;
  if (
    task === undefined ||
    lane === null ||
    lane.stage.stage_kind !== "discovery_generation" ||
    task.unit_id !== evidence.unit_id ||
    task.research_goal !== evidence.research_goal ||
    evidence.run_id !== batch.document.run_id ||
    evidence.research_plan_ref !== batch.document.research_plan_ref
  ) {
    errors.push(
      issue(
        "runtime.candidate_neutral_evidence_binding_mismatch",
        entry.path,
        "candidate-neutral Evidence must bind the exact generation task without a candidate identity",
      ),
    );
  }
  const binding = isRecord(evidence.mechanical_binding) ? evidence.mechanical_binding : {};
  const substrateRef = binding.substrate_record_ref;
  const substrate =
    typeof substrateRef === "string" ? exactJsonlRecords.get(substrateRef) : undefined;
  if (substrate?.schema_version !== "startup_opportunity.evidence_store_record.v2") {
    errors.push(
      issue(
        "runtime.candidate_neutral_substrate_missing",
        `${entry.path}#/mechanical_binding/substrate_record_ref`,
        "candidate-neutral Evidence must bind one exact v2 Evidence Store record",
        { substrateRef },
      ),
    );
    return;
  }
  const identityFields = ["evidence_id", "run_id", "unit_id", "research_goal"] as const;
  const mechanicalFields = [
    "source_hash",
    "content_hash",
    "raw_content_ref",
    "operation_key",
    "recorded_at",
  ] as const;
  if (
    identityFields.some((field) => evidence[field] !== substrate[field]) ||
    mechanicalFields.some((field) => binding[field] !== substrate[field])
  ) {
    errors.push(
      issue(
        "runtime.candidate_neutral_substrate_mismatch",
        `${entry.path}#/mechanical_binding`,
        "candidate-neutral Evidence identity and mechanical binding must equal its substrate record",
      ),
    );
  }
}

function validateSourceManifest(
  entry: DeclarativeRuntimeDocument,
  byPath: ReadonlyMap<string, DeclarativeRuntimeDocument>,
  errors: ValidationIssue[],
): void {
  const manifest = entry.document;
  const batch = target(byPath, manifest.dispatch_batch_ref);
  const taskId = String(manifest.dispatch_batch_ref).split("#", 2)[1];
  const task = records(batch?.document.tasks).find((candidate) => candidate.task_id === taskId);
  if (
    batch?.schemaVersion !== "startup_opportunity.dispatch_batch.discovery.current" ||
    task === undefined ||
    task.unit_id !== manifest.unit_id ||
    batch.document.research_plan_ref !== manifest.research_plan_ref ||
    batch.document.execution_plan_ref !== manifest.execution_plan_ref ||
    batch.document.run_id !== manifest.run_id
  ) {
    errors.push(
      issue(
        "runtime.source_manifest_dispatch_mismatch",
        entry.path,
        "Source Manifest must bind its exact dispatch task, execution plan, and Research Plan",
      ),
    );
  }
  const acceptedRefs = strings(manifest.accepted_evidence_refs);
  const evidence = acceptedRefs
    .map((ref) => byPath.get(ref))
    .filter(
      (candidate): candidate is DeclarativeRuntimeDocument =>
        candidate?.schemaVersion === "startup_opportunity.evidence.discovery_candidate.current" ||
        candidate?.schemaVersion === "startup_opportunity.candidate_neutral_evidence.v1",
    );
  if (evidence.length !== acceptedRefs.length) {
    return;
  }
  const freshness = { active: 0, stale: 0, unverified: 0, superseded: 0 };
  const dates: string[] = [];
  const stances = new Set<string>();
  for (const item of evidence) {
    const lifecycle = item.document.evidence_lifecycle_status;
    if (
      lifecycle === "active" ||
      lifecycle === "stale" ||
      lifecycle === "unverified" ||
      lifecycle === "superseded"
    ) {
      freshness[lifecycle] += 1;
    }
    if (typeof item.document.valid_as_of === "string") {
      dates.push(item.document.valid_as_of);
    }
    if (typeof item.document.evidence_role === "string") {
      stances.add(item.document.evidence_role);
    }
  }
  dates.sort();
  const expectedTime = {
    earliest_valid_as_of: dates[0] ?? null,
    latest_valid_as_of: dates.at(-1) ?? null,
    accepted_evidence_count: evidence.length,
  };
  if (
    canonicalJson(manifest.freshness_summary) !== canonicalJson(freshness) ||
    !sameStrings(strings(manifest.stance_coverage), [...stances]) ||
    canonicalJson(manifest.time_coverage) !== canonicalJson(expectedTime)
  ) {
    errors.push(
      issue(
        "runtime.source_manifest_summary_mismatch",
        entry.path,
        "Source Manifest freshness, stance, and structured date bounds must be derived from accepted Evidence",
        { expectedFreshness: freshness, expectedStances: [...stances].sort(), expectedTime },
      ),
    );
  }
}

function validateReadiness(
  entry: DeclarativeRuntimeDocument,
  byPath: ReadonlyMap<string, DeclarativeRuntimeDocument>,
  errors: ValidationIssue[],
): void {
  const readiness = entry.document;
  const execution = target(byPath, readiness.execution_plan_ref);
  const plan = target(byPath, readiness.research_plan_ref);
  if (
    execution?.schemaVersion !== "startup_opportunity.research_execution_plan.discovery.current" ||
    plan?.schemaVersion !== "startup_opportunity.research_plan.v1"
  ) {
    return;
  }
  const stage = stageById(execution.document, readiness.stage_id);
  const nextStage =
    typeof readiness.next_stage_id === "string"
      ? stageById(execution.document, readiness.next_stage_id)
      : null;
  const terminalAfterFinalStage =
    readiness.next_stage_readiness === "terminal" && readiness.next_stage_id === null;
  const validDependentNextStage =
    nextStage !== null &&
    dependencyClosure(
      new Map(
        records(execution.document.stages).map((item) => [String(item.stage_id), item] as const),
      ),
      String(readiness.next_stage_id),
    ).has(String(readiness.stage_id));
  if (
    stage === null ||
    (!terminalAfterFinalStage && !validDependentNextStage) ||
    readiness.run_id !== execution.document.run_id ||
    execution.document.research_plan_ref !== readiness.research_plan_ref
  ) {
    errors.push(
      issue(
        "runtime.readiness_stage_binding_mismatch",
        entry.path,
        "readiness must gate a directly or transitively dependent next execution stage",
      ),
    );
  }
  if (nextStage !== null && nextStage.gate_before !== entry.path) {
    errors.push(
      issue(
        "runtime.readiness_gate_binding_mismatch",
        entry.path,
        "the dependent next execution stage must name this exact Readiness artifact as its entry gate",
      ),
    );
  }
  const expectedQuestions = records(plan.document.research_questions).map(
    (question) => `${String(readiness.research_plan_ref)}#${String(question.question_id)}`,
  );
  const coveredQuestions = records(readiness.question_coverage).map((item) =>
    String(item.question_ref),
  );
  if (!sameStrings(expectedQuestions, coveredQuestions)) {
    errors.push(
      issue(
        "runtime.readiness_question_coverage_incomplete",
        entry.path,
        "readiness must explicitly disposition every current Research Plan question",
      ),
    );
  }
  const questionCoverage = records(readiness.question_coverage);
  for (const coverage of questionCoverage) {
    const judgmentRefs = strings(coverage.judgment_refs);
    const invalidJudgmentRefs = judgmentRefs.filter((ref) => {
      const judgment = target(byPath, ref);
      return (
        judgment === null ||
        !DISCOVERY_JUDGMENT_SCHEMA_VERSIONS.has(judgment.schemaVersion) ||
        judgment.document.run_id !== readiness.run_id
      );
    });
    if (coverage.status === "answered" && judgmentRefs.length === 0) {
      errors.push(
        issue(
          "runtime.readiness_question_judgment_missing",
          `${entry.path}#${String(coverage.question_ref)}`,
          "an answered Plan question requires at least one formal Judgment disposition",
        ),
      );
    }
    if (invalidJudgmentRefs.length > 0) {
      errors.push(
        issue(
          "runtime.readiness_question_judgment_invalid",
          `${entry.path}#${String(coverage.question_ref)}`,
          "Readiness question coverage may bind only exact same-Run discovery Judgments",
          { invalidJudgmentRefs },
        ),
      );
    }
  }
  const fanIn = target(byPath, readiness.source_fan_in_ref);
  const dispositions = new Map<string, string>();
  const preCandidateDispositions = new Map<string, string>();
  if (fanIn?.schemaVersion === "startup_opportunity.discovery_fan_in.v2") {
    for (const disposition of records(fanIn.document.candidate_dispositions)) {
      dispositions.set(String(disposition.candidate_ref), String(disposition.disposition));
    }
    for (const disposition of records(fanIn.document.pre_candidate_dispositions)) {
      preCandidateDispositions.set(
        String(disposition.pre_candidate_ref),
        String(disposition.disposition),
      );
    }
  }
  const expectedRoles = records(readiness.candidate_roles).map((role) => {
    const candidate = byPath.get(String(role.candidate_ref));
    const kind = candidate?.document.candidate_kind;
    const reportingRole =
      kind === "demand_seed"
        ? "opportunity_direction"
        : kind === "baseline_seed"
          ? "comparison_baseline"
          : kind === "solution_seed"
            ? "solution_hypothesis"
            : null;
    if (
      candidate?.schemaVersion !== "startup_opportunity.discovery_candidate.v1" ||
      role.candidate_kind !== kind ||
      role.reporting_role !== reportingRole ||
      (fanIn !== null && role.disposition !== dispositions.get(String(role.candidate_ref)))
    ) {
      errors.push(
        issue(
          "runtime.readiness_candidate_role_mismatch",
          `${entry.path}#${String(role.candidate_ref)}`,
          "candidate role and disposition must be derived from the typed candidate and fan-in",
        ),
      );
    }
    return String(kind ?? "");
  });
  const preCandidateRoles = records(readiness.pre_candidate_roles);
  const preCandidateRoleRefs = preCandidateRoles.map((role) => String(role.pre_candidate_ref));
  if (!sameStrings(preCandidateRoleRefs, [...preCandidateDispositions.keys()])) {
    errors.push(
      issue(
        "runtime.readiness_pre_candidate_role_closure_mismatch",
        entry.path,
        "pre-candidate roles must close the exact concrete pre-candidate disposition set from source fan-in",
        {
          expectedRefs: [...preCandidateDispositions.keys()].sort(),
          actualRefs: [...preCandidateRoleRefs].sort(),
        },
      ),
    );
  }
  for (const role of preCandidateRoles) {
    const preCandidate = byPath.get(String(role.pre_candidate_ref));
    if (
      preCandidate?.schemaVersion !== "startup_opportunity.concrete_pre_candidate.v1" ||
      preCandidate.document.run_id !== readiness.run_id ||
      role.disposition !== preCandidateDispositions.get(String(role.pre_candidate_ref))
    ) {
      errors.push(
        issue(
          "runtime.readiness_pre_candidate_role_mismatch",
          `${entry.path}#${String(role.pre_candidate_ref)}`,
          "pre-candidate role and disposition must be derived from the concrete pre-candidate and fan-in",
        ),
      );
    }
  }
  const requiredKinds = strings(readiness.required_candidate_kinds);
  const missingKinds = requiredKinds.filter((kind) => !expectedRoles.includes(kind)).sort();
  if (!sameStrings(missingKinds, strings(readiness.missing_candidate_kinds))) {
    errors.push(
      issue(
        "runtime.readiness_missing_candidate_kinds_mismatch",
        entry.path,
        "missing candidate kinds must be derived from typed candidate roles",
        { expectedMissingKinds: missingKinds },
      ),
    );
  }
  if (
    [
      "hard_gate_scan",
      "candidate_evaluation",
      "retained_candidate_deep_review",
      "discovery_synthesis",
    ].includes(String(nextStage?.stage_kind)) &&
    !sameStrings(requiredKinds, ["demand_seed", "baseline_seed", "solution_seed"])
  ) {
    errors.push(
      issue(
        "runtime.readiness_required_candidate_kinds_invalid",
        entry.path,
        "Discovery evaluation readiness requires demand, baseline, and solution candidate kinds",
      ),
    );
  }
  const blockers = records(readiness.blockers);
  const requiredQuestionBlockers = [
    ["method_boundary", "method_boundary"],
    ["runtime_blocked", "runtime_blocked"],
  ] as const;
  for (const [coverageStatus, blockerKind] of requiredQuestionBlockers) {
    const questionRefs = questionCoverage
      .filter((coverage) => coverage.status === coverageStatus)
      .map((coverage) => String(coverage.question_ref));
    if (
      questionRefs.length > 0 &&
      !blockers.some((blocker) => blocker.blocker_kind === blockerKind)
    ) {
      errors.push(
        issue(
          "runtime.readiness_question_blocker_mismatch",
          entry.path,
          "method-boundary and runtime-blocked question dispositions require a matching readiness blocker",
          { coverageStatus, requiredBlockerKind: blockerKind, questionRefs },
        ),
      );
    }
  }
  for (const kind of missingKinds) {
    const blocker = blockers.find(
      (candidate) =>
        candidate.blocker_kind === "candidate_kind_missing" && candidate.candidate_kind === kind,
    );
    const requiredAction = kind === "solution_seed" ? "run_solution_generation" : "add_unit";
    if (blocker === undefined || !strings(blocker.allowed_actions).includes(requiredAction)) {
      errors.push(
        issue(
          "runtime.readiness_missing_candidate_action_missing",
          entry.path,
          "each missing candidate kind requires its bounded generation action",
          { candidateKind: kind, requiredAction },
        ),
      );
    }
  }
  const blockerActions = [
    ...new Set(blockers.flatMap((blocker) => strings(blocker.allowed_actions))),
  ];
  const declaredActions = strings(readiness.allowed_next_actions);
  if (!blockerActions.every((action) => declaredActions.includes(action))) {
    errors.push(
      issue(
        "runtime.readiness_allowed_actions_incomplete",
        entry.path,
        "top-level allowed next actions must include every blocker disposition",
      ),
    );
  }
  const disposition = readiness.next_stage_readiness;
  const boundedActions = new Set([
    "continue_stage",
    "add_unit",
    "run_solution_generation",
    "run_candidate_evaluation",
  ]);
  if (
    (disposition === "ready" &&
      (blockers.length > 0 ||
        missingKinds.length > 0 ||
        questionCoverage.some((coverage) => coverage.status !== "answered") ||
        !declaredActions.includes("continue_stage"))) ||
    (disposition === "blocked" && (blockers.length === 0 || readiness.stop_basis !== null)) ||
    (disposition === "terminal" &&
      (readiness.stop_basis === null ||
        blockers.some((blocker) => blocker.blocker_kind === "runtime_blocked") ||
        declaredActions.some((action) => boundedActions.has(action))))
  ) {
    errors.push(
      issue(
        "runtime.readiness_disposition_invalid",
        entry.path,
        "ready, blocked, and terminal dispositions must reflect blockers, bounded actions, and stop basis",
      ),
    );
  }
}

function validateDiscoverySynthesisReadinessBoundary(
  documents: readonly DeclarativeRuntimeDocument[],
  byPath: ReadonlyMap<string, DeclarativeRuntimeDocument>,
  errors: ValidationIssue[],
): void {
  const synthesis = documents.filter((entry) =>
    DISCOVERY_SYNTHESIS_SCHEMA_VERSIONS.has(entry.schemaVersion),
  );
  if (synthesis.length === 0) return;

  const planRefs = [
    ...new Set(
      synthesis
        .map((entry) => entry.document.research_plan_ref)
        .filter((ref): ref is string => typeof ref === "string"),
    ),
  ];
  const fanInRefs = [
    ...new Set(
      synthesis
        .map((entry) => entry.document.discovery_fan_in_ref)
        .filter((ref): ref is string => typeof ref === "string"),
    ),
  ];
  if (planRefs.length !== 1 || fanInRefs.length !== 1) {
    errors.push(
      issue(
        "runtime.discovery_synthesis_readiness_binding_mismatch",
        synthesis[0]?.path ?? "/",
        "G2.3 artifacts must share one exact current Plan and discovery fan-in before readiness can be evaluated",
        { planRefs, fanInRefs },
      ),
    );
    return;
  }
  const planRef = planRefs[0] as string;
  const fanInRef = fanInRefs[0] as string;
  const latestReadiness = latestDocument(
    documents.filter(
      (entry) =>
        entry.schemaVersion === "startup_opportunity.discovery_stage_readiness.v1" &&
        entry.document.research_plan_ref === planRef,
    ),
  );
  if (latestReadiness === null) {
    errors.push(
      issue(
        "runtime.discovery_synthesis_readiness_missing",
        synthesis[0]?.path ?? "/",
        "G2.3 requires a current post-fan-in Stage Readiness artifact",
        { planRef, fanInRef },
      ),
    );
    return;
  }
  const readinessGaps = documents.filter(
    (entry) =>
      entry.schemaVersion === "startup_opportunity.gap_snapshot.discovery.readiness.current" &&
      entry.document.readiness_ref === latestReadiness.path,
  );
  const readinessGap = latestDocument(readinessGaps);
  const execution = target(byPath, latestReadiness.document.execution_plan_ref);
  const fanIn = target(byPath, fanInRef);
  const nextStage =
    execution?.schemaVersion === "startup_opportunity.research_execution_plan.discovery.current"
      ? stageById(execution.document, latestReadiness.document.next_stage_id)
      : null;
  const questionCoverage = records(latestReadiness.document.question_coverage);
  if (
    readinessGap === null ||
    readinessGap.document.based_on_plan_ref !== planRef ||
    readinessGap.document.fan_in_ref !== fanInRef ||
    latestReadiness.document.source_fan_in_ref !== fanInRef ||
    execution?.document.research_plan_ref !== planRef ||
    fanIn?.schemaVersion !== "startup_opportunity.discovery_fan_in.v2" ||
    fanIn.document.research_plan_ref !== planRef ||
    nextStage?.stage_kind !== "discovery_synthesis"
  ) {
    errors.push(
      issue(
        "runtime.discovery_synthesis_readiness_binding_mismatch",
        latestReadiness.path,
        "G2.3 Readiness and readiness Gap must bind the exact Plan, execution stage, and fan-in",
        {
          readinessGapRef: readinessGap?.path ?? null,
          executionPlanRef: latestReadiness.document.execution_plan_ref,
          fanInRef,
        },
      ),
    );
    return;
  }
  if (
    latestReadiness.document.next_stage_readiness !== "ready" ||
    records(latestReadiness.document.blockers).length > 0 ||
    questionCoverage.some(
      (coverage) => coverage.status !== "answered" || strings(coverage.judgment_refs).length === 0,
    ) ||
    strings(readinessGap.document.unresolved_decision_relevant_questions).length > 0
  ) {
    errors.push(
      issue(
        "runtime.discovery_synthesis_not_ready",
        latestReadiness.path,
        "G2.3 requires ready disposition, no blockers, and Judgment-backed answers for every Plan question",
      ),
    );
  }
  const retainedPreCandidates = strings(fanIn.document.retained_pre_candidate_refs);
  const sourcePreCandidateRefs = [
    ...new Set(
      synthesis
        .map((entry) => entry.document.source_pre_candidate_ref)
        .filter((ref): ref is string => typeof ref === "string"),
    ),
  ];
  const readinessPreCandidateRefs = records(latestReadiness.document.pre_candidate_roles)
    .filter((role) => role.disposition === "retained")
    .map((role) => String(role.pre_candidate_ref));
  if (
    sourcePreCandidateRefs.length > 0 &&
    (!sourcePreCandidateRefs.every((ref) => retainedPreCandidates.includes(ref)) ||
      !sourcePreCandidateRefs.every((ref) => readinessPreCandidateRefs.includes(ref)))
  ) {
    errors.push(
      issue(
        "runtime.discovery_synthesis_pre_candidate_not_retained",
        latestReadiness.path,
        "G2.3 artifacts may source only retained concrete pre-candidates visible in readiness",
        { sourcePreCandidateRefs, retainedPreCandidates, readinessPreCandidateRefs },
      ),
    );
  }
}

function validateGapSnapshot(
  entry: DeclarativeRuntimeDocument,
  byPath: ReadonlyMap<string, DeclarativeRuntimeDocument>,
  errors: ValidationIssue[],
): void {
  const snapshot = entry.document;
  const readiness = target(byPath, snapshot.readiness_ref);
  if (
    readiness?.schemaVersion !== "startup_opportunity.discovery_stage_readiness.v1" ||
    readiness.document.run_id !== snapshot.run_id ||
    readiness.document.research_plan_ref !== snapshot.based_on_plan_ref ||
    readiness.document.source_fan_in_ref !== snapshot.fan_in_ref
  ) {
    errors.push(
      issue(
        "runtime.gap_readiness_binding_mismatch",
        entry.path,
        "Gap Snapshot must bind the exact readiness and fan-in state",
      ),
    );
    return;
  }
  const expectedQuestions = records(readiness.document.question_coverage)
    .filter((coverage) => coverage.status !== "answered")
    .map((coverage) => String(coverage.question_ref));
  if (!sameStrings(expectedQuestions, strings(snapshot.unresolved_decision_relevant_questions))) {
    errors.push(
      issue(
        "runtime.gap_unresolved_questions_mismatch",
        entry.path,
        "Gap Snapshot unresolved questions must be derived from readiness coverage",
      ),
    );
  }
  const observed = strings(snapshot.observed_artifact_refs);
  const requiredObserved = [
    String(snapshot.readiness_ref),
    ...(typeof snapshot.fan_in_ref === "string" ? [snapshot.fan_in_ref] : []),
    ...strings(readiness.document.generation_result_refs),
  ];
  if (!requiredObserved.every((ref) => observed.includes(ref))) {
    errors.push(
      issue(
        "runtime.gap_observation_closure_incomplete",
        entry.path,
        "Gap Snapshot observations must include readiness, fan-in, and generation bases",
      ),
    );
  }
  const gaps = records(snapshot.gaps);
  for (const blocker of records(readiness.document.blockers)) {
    const match = gaps.find(
      (gap) =>
        gap.gap_type === blocker.blocker_kind &&
        strings(gap.basis_refs).includes(String(snapshot.readiness_ref)) &&
        strings(blocker.basis_refs).every((ref) => strings(gap.basis_refs).includes(ref)),
    );
    if (match === undefined) {
      errors.push(
        issue(
          "runtime.gap_blocker_missing",
          entry.path,
          "every readiness blocker requires a basis-closed Gap disposition",
          { blockerId: blocker.blocker_id },
        ),
      );
    }
  }
  const hasRuntimeBlocker = records(readiness.document.blockers).some(
    (blocker) => blocker.blocker_kind === "runtime_blocked",
  );
  if (hasRuntimeBlocker && !strings(snapshot.stop_signals).includes("runtime_blocked")) {
    errors.push(
      issue(
        "runtime.gap_runtime_blocker_unprojected",
        entry.path,
        "runtime failure must remain explicit and cannot be rewritten as research insufficiency",
      ),
    );
  }
  const expectedPath = `adaptations/gap-snapshots/${String(snapshot.snapshot_id)}.r${String(snapshot.revision)}.json`;
  if (entry.path !== expectedPath) {
    errors.push(
      issue(
        "runtime.gap_path_mismatch",
        entry.path,
        "Gap Snapshot path must match identity and revision",
        {
          expectedPath,
        },
      ),
    );
  }
}

function validateLaneDeliveryReceipt(
  entry: DeclarativeRuntimeDocument,
  documents: readonly DeclarativeRuntimeDocument[],
  errors: ValidationIssue[],
): void {
  const assignedScope = strings(entry.document.assigned_scope);
  const delivered = records(entry.document.delivered_artifacts);
  const rootRefs = delivered.map((artifact) => String(artifact.artifact_ref));
  const artifacts = documents
    .filter((document) => document.envelope !== null)
    .map((document) => ({
      artifact_ref: document.path,
      artifact_type: document.schemaVersion,
      content_hash:
        typeof document.envelope?.content_hash === "string"
          ? document.envelope.content_hash
          : canonicalContentHash(document.document),
      document: document.document,
    }));
  const artifactsByPath = new Map(artifacts.map((artifact) => [artifact.artifact_ref, artifact]));
  for (const [index, deliveredArtifact] of delivered.entries()) {
    const artifactRef = String(deliveredArtifact.artifact_ref);
    const actual = artifactsByPath.get(artifactRef);
    if (
      actual === undefined ||
      actual.artifact_type !== deliveredArtifact.artifact_type ||
      actual.content_hash !== deliveredArtifact.content_hash
    ) {
      errors.push(
        issue(
          "runtime.lane_delivery_artifact_binding_mismatch",
          `/delivered_artifacts/${String(index)}`,
          "Lane delivery receipt must bind the exact current formal Artifact type and content hash",
          { artifactRef, expected: deliveredArtifact, actual: actual ?? null },
        ),
      );
    }
  }
  const derived = deriveLaneScopeFormalClosure(assignedScope, artifacts, rootRefs);
  if (derived.issues.length > 0) {
    errors.push(
      ...derived.issues.map((closureIssue) =>
        issue(`runtime.${closureIssue.code}`, "/scope_formal_closure", closureIssue.message, {
          scopeKey: closureIssue.scopeKey,
          expected: closureIssue.expected,
          actual: closureIssue.actual,
        }),
      ),
    );
  }
  if (canonicalJson(entry.document.scope_formal_closure) !== canonicalJson(derived.closure)) {
    errors.push(
      issue(
        "runtime.lane_delivery_scope_closure_mismatch",
        "/scope_formal_closure",
        "Lane delivery receipt scope closure must equal the closure recomputed from exact formal Artifacts",
        { expected: derived.closure, actual: entry.document.scope_formal_closure },
      ),
    );
  }
  const coverage = laneScopeCoverageFromClosure(derived.closure);
  if (canonicalJson(entry.document.scope_coverage) !== canonicalJson(coverage)) {
    errors.push(
      issue(
        "runtime.lane_delivery_scope_coverage_mismatch",
        "/scope_coverage",
        "Lane delivery receipt scope coverage must equal the coverage derived from exact formal Artifacts",
        { expected: coverage, actual: entry.document.scope_coverage },
      ),
    );
  }
}

export function isDeclarativeRuntimeSchemaVersion(schemaVersion: string): boolean {
  return RUNTIME_SCHEMA_VERSIONS.has(schemaVersion);
}

export function validateDeclarativeRuntimeContract(
  documents: readonly DeclarativeRuntimeDocument[],
  exactJsonlRecords: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): readonly ValidationIssue[] {
  if (
    !documents.some(
      (entry) =>
        isDeclarativeRuntimeSchemaVersion(entry.schemaVersion) ||
        DISCOVERY_SYNTHESIS_SCHEMA_VERSIONS.has(entry.schemaVersion),
    )
  ) {
    return [];
  }
  const errors: ValidationIssue[] = [];
  const byPath = new Map(documents.map((entry) => [entry.path, entry]));
  for (const entry of documents) {
    switch (entry.schemaVersion) {
      case "startup_opportunity.research_execution_plan.discovery.current":
        validateExecutionPlan(entry, byPath, errors);
        break;
      case "startup_opportunity.dispatch_batch.discovery.current":
        validateDispatchBatch(entry, byPath, errors);
        break;
      case "startup_opportunity.lane_lifecycle.v1":
        validateLifecycle(entry, byPath, errors);
        break;
      case "startup_opportunity.dispatch_launch_registration.v1":
        validateDispatchLaunchRegistration(entry, byPath, errors);
        break;
      case "startup_opportunity.discovery_generation_result.v1":
        validateGenerationResult(entry, byPath, errors);
        break;
      case "startup_opportunity.candidate_neutral_evidence.v1":
        validateCandidateNeutralEvidence(entry, byPath, exactJsonlRecords, errors);
        break;
      case "startup_opportunity.source_manifest.discovery_runtime.current":
        validateSourceManifest(entry, byPath, errors);
        break;
      case "startup_opportunity.discovery_stage_readiness.v1":
        validateReadiness(entry, byPath, errors);
        break;
      case "startup_opportunity.gap_snapshot.discovery.readiness.current":
        validateGapSnapshot(entry, byPath, errors);
        break;
      case "startup_opportunity.lane_delivery_receipt.current":
        validateLaneDeliveryReceipt(entry, documents, errors);
        break;
    }
  }
  validateDiscoverySynthesisReadinessBoundary(documents, byPath, errors);
  const lifecycles = documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.lane_lifecycle.v1",
  );
  const rootsByLifecycleId = new Map<string, DeclarativeRuntimeDocument[]>();
  const revisionsByIdentity = new Map<string, DeclarativeRuntimeDocument[]>();
  for (const entry of lifecycles) {
    const lifecycleId = String(entry.document.lifecycle_id ?? "");
    const revisionIdentity = `${lifecycleId}:${String(entry.document.revision)}`;
    revisionsByIdentity.set(revisionIdentity, [
      ...(revisionsByIdentity.get(revisionIdentity) ?? []),
      entry,
    ]);
    if (entry.document.revision === 1) {
      rootsByLifecycleId.set(lifecycleId, [...(rootsByLifecycleId.get(lifecycleId) ?? []), entry]);
    }
  }
  for (const entries of [...rootsByLifecycleId.values(), ...revisionsByIdentity.values()]) {
    if (entries.length > 1) {
      errors.push(
        issue(
          "runtime.lifecycle_revision_conflict",
          entries[0]?.path ?? "lane_lifecycle",
          "one canonical lifecycle identity can have only one root and one document per revision",
          { paths: entries.map((entry) => entry.path).sort() },
        ),
      );
    }
  }
  const launched = lifecycles.filter(
    (entry) => typeof entry.document.launch_registration_id === "string",
  );
  const byDispatchedAttempt = new Map<string, DeclarativeRuntimeDocument[]>();
  const byExecutionAttempt = new Map<string, DeclarativeRuntimeDocument[]>();
  for (const entry of launched) {
    const dispatchedAttempt = canonicalJson({
      dispatchBatchRef: entry.document.dispatch_batch_ref,
      dispatchBatchHash: entry.document.dispatch_batch_hash,
      unitId: entry.document.unit_id,
      taskRef: entry.document.task_ref,
      taskId: entry.document.task_id,
      attempt: entry.document.attempt,
    });
    byDispatchedAttempt.set(dispatchedAttempt, [
      ...(byDispatchedAttempt.get(dispatchedAttempt) ?? []),
      entry,
    ]);
    const executionAttemptId = String(entry.document.execution_attempt_id ?? "");
    byExecutionAttempt.set(executionAttemptId, [
      ...(byExecutionAttempt.get(executionAttemptId) ?? []),
      entry,
    ]);
  }
  for (const entries of byDispatchedAttempt.values()) {
    const attempts = new Set(entries.map((entry) => entry.document.execution_attempt_id));
    const lifecycleIds = new Set(entries.map((entry) => entry.document.lifecycle_id));
    if (attempts.size > 1 || lifecycleIds.size > 1) {
      errors.push(
        issue(
          "runtime.lifecycle_launch_conflict",
          entries[0]?.path ?? "lane_lifecycle",
          "one exact Dispatch task attempt cannot have multiple launch registrations",
          { paths: entries.map((entry) => entry.path).sort() },
        ),
      );
    }
  }
  for (const [executionAttemptId, entries] of byExecutionAttempt) {
    const identities = new Set(
      entries.map((entry) =>
        canonicalJson({
          unitId: entry.document.unit_id,
          taskRef: entry.document.task_ref,
          attempt: entry.document.attempt,
        }),
      ),
    );
    if (identities.size > 1) {
      errors.push(
        issue(
          "runtime.lifecycle_execution_attempt_conflict",
          entries[0]?.path ?? "lane_lifecycle",
          "one execution attempt id cannot identify different Dispatch tasks",
          { executionAttemptId, paths: entries.map((entry) => entry.path).sort() },
        ),
      );
    }
  }
  return sortIssues(errors);
}

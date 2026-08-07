import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import { evaluateAssessmentFollowupInformationGain } from "../runtime/assessment-information-gain.js";
import type { AssessmentExecutionPolicy } from "./assessment-execution-policy.js";
import { sortIssues, type ValidationIssue } from "./schema-bundle.js";

export interface AssessmentExecutionDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

const PROVENANCE_FIELDS = [
  "product_thesis",
  "target_user",
  "buyer",
  "entry_scene",
  "claimed_value",
  "current_alternative",
  "delivery_form",
  "business_model",
  "acquisition_hypothesis",
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function duplicateStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function issue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "assessment_execution",
    instancePath,
    schemaPath: "",
    message,
    details: Object.fromEntries(
      Object.entries(details).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function targetByRef(
  documents: ReadonlyMap<string, AssessmentExecutionDocument>,
  ref: unknown,
): AssessmentExecutionDocument | null {
  if (typeof ref !== "string") return null;
  return documents.get(ref.split("#", 1)[0] ?? "") ?? null;
}

function planUnits(plan: AssessmentExecutionDocument | null): readonly Record<string, unknown>[] {
  return plan?.schemaVersion === "startup_opportunity.research_plan.v1"
    ? records(plan.document.waves).flatMap((wave) => records(wave.units))
    : [];
}

function nonEmptyField(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;
}

function validateConcept(
  concept: AssessmentExecutionDocument,
  documents: ReadonlyMap<string, AssessmentExecutionDocument>,
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
  errors: ValidationIssue[],
): void {
  const provenance = records(concept.document.field_provenance);
  const names = provenance.map((entry) => String(entry.field_name ?? ""));
  if (!sameStrings(names, PROVENANCE_FIELDS)) {
    errors.push(
      issue(
        "assessment_execution.provenance_fields_mismatch",
        `${concept.path}#/field_provenance`,
        "Concept Hypothesis provenance must cover each direction-setting field exactly once",
        { duplicates: duplicateStrings(names) },
      ),
    );
  }
  let clarificationRequired = false;
  for (const entry of provenance) {
    const field = String(entry.field_name ?? "");
    const value = concept.document[field];
    const sourceKind = entry.source_kind;
    const basisRefs = strings(entry.basis_refs);
    if (sourceKind === "unknown") {
      clarificationRequired = true;
      if (nonEmptyField(value)) {
        errors.push(
          issue(
            "assessment_execution.unknown_field_has_value",
            `${concept.path}#/${field}`,
            "an unknown thesis field must remain null or empty until clarified",
          ),
        );
      }
      continue;
    }
    if (!nonEmptyField(value)) {
      errors.push(
        issue(
          "assessment_execution.provenance_value_missing",
          `${concept.path}#/${field}`,
          "a provided or authorized thesis field requires an explicit value",
        ),
      );
    }
    const callerAttestedScopeConfirmation = basisRefs.some((ref) => {
      const record = exactRecords.get(ref);
      return (
        record?.schema_version === "startup_opportunity.decision.v1" &&
        record.run_id === concept.document.run_id &&
        record.actor === "main_agent" &&
        ["scope_assumption_confirmed", "scope_changed_by_user"].includes(
          String(record.decision_type),
        ) &&
        record.confirmation_basis === "caller_attested_user_confirmation" &&
        record.harness_identity_verification === "not_available"
      );
    });
    const intakeBasis = basisRefs.some(
      (ref) => targetByRef(documents, ref)?.schemaVersion === "startup_opportunity.intake.v1",
    );
    if (
      (sourceKind === "agent_assumed" && !callerAttestedScopeConfirmation) ||
      (sourceKind === "user_provided" && !callerAttestedScopeConfirmation && !intakeBasis)
    ) {
      errors.push(
        issue(
          "assessment_execution.provenance_basis_invalid",
          `${concept.path}#/field_provenance/${field}/basis_refs`,
          "field provenance is not bound to user intake or an exact caller-attested Scope confirmation Decision",
        ),
      );
    }
  }
  const expectedReadiness = clarificationRequired ? "clarification_required" : "ready";
  if (concept.document.research_readiness !== expectedReadiness) {
    errors.push(
      issue(
        "assessment_execution.research_readiness_mismatch",
        `${concept.path}#/research_readiness`,
        "research readiness must reflect unresolved direction-setting fields",
        { expectedReadiness },
      ),
    );
  }
}

function validateAssessmentEvidence(
  evidence: AssessmentExecutionDocument,
  documents: ReadonlyMap<string, AssessmentExecutionDocument>,
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
  errors: ValidationIssue[],
): void {
  const dispatchRef = String(evidence.document.dispatch_batch_ref ?? "");
  const [dispatchPath, taskId] = dispatchRef.split("#", 2);
  const dispatch = documents.get(dispatchPath ?? "") ?? null;
  const task = records(dispatch?.document.tasks).find((entry) => entry.task_id === taskId);
  const concept = targetByRef(documents, evidence.document.concept_hypothesis_ref);
  const plan = targetByRef(documents, evidence.document.research_plan_ref);
  const execution = targetByRef(documents, evidence.document.execution_plan_ref);
  const unit = planUnits(plan).find((entry) => entry.unit_id === evidence.document.unit_id);
  if (
    dispatch?.schemaVersion !== "startup_opportunity.dispatch_batch.assessment.current" ||
    dispatch.document.run_id !== evidence.document.run_id ||
    dispatch.document.research_plan_ref !== evidence.document.research_plan_ref ||
    dispatch.document.execution_plan_ref !== evidence.document.execution_plan_ref ||
    task?.unit_id !== evidence.document.unit_id ||
    concept?.schemaVersion !== "startup_opportunity.concept_hypothesis.assessment_intake.current" ||
    concept.document.run_id !== evidence.document.run_id ||
    plan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
    plan.document.run_id !== evidence.document.run_id ||
    execution?.schemaVersion !== "startup_opportunity.research_execution_plan.assessment.current" ||
    execution.document.run_id !== evidence.document.run_id ||
    execution.document.concept_hypothesis_ref !== evidence.document.concept_hypothesis_ref ||
    unit?.research_goal !== evidence.document.research_goal
  ) {
    errors.push(
      issue(
        "assessment_execution.evidence_binding_invalid",
        evidence.path,
        "Assessment Evidence must bind one exact dispatched task, frozen thesis, and current Plans",
      ),
    );
  }
  const mechanical = isRecord(evidence.document.mechanical_binding)
    ? evidence.document.mechanical_binding
    : {};
  const substrateRef = mechanical.substrate_record_ref;
  const substrate = typeof substrateRef === "string" ? exactRecords.get(substrateRef) : undefined;
  if (
    substrate?.schema_version !== "startup_opportunity.evidence_store_record.v2" ||
    substrate.run_id !== evidence.document.run_id ||
    substrate.unit_id !== evidence.document.unit_id ||
    substrate.evidence_id !== evidence.document.evidence_id ||
    substrate.research_goal !== evidence.document.research_goal ||
    substrate.source_hash !== mechanical.source_hash ||
    substrate.content_hash !== mechanical.content_hash ||
    substrate.raw_content_ref !== mechanical.raw_content_ref ||
    substrate.operation_key !== mechanical.operation_key ||
    substrate.recorded_at !== mechanical.recorded_at
  ) {
    errors.push(
      issue(
        "assessment_execution.evidence_substrate_invalid",
        `${evidence.path}#/mechanical_binding`,
        "Assessment Evidence must reproduce its exact Evidence Store identity and mechanical binding",
      ),
    );
  }
}

function validateExecutionPlan(
  execution: AssessmentExecutionDocument,
  documents: ReadonlyMap<string, AssessmentExecutionDocument>,
  policy: AssessmentExecutionPolicy,
  errors: ValidationIssue[],
): void {
  const plan = targetByRef(documents, execution.document.research_plan_ref);
  const concept = targetByRef(documents, execution.document.concept_hypothesis_ref);
  if (
    plan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
    plan.document.run_id !== execution.document.run_id ||
    plan.document.mode !== "concept_evidence_assessment" ||
    canonicalContentHash(plan.document) !== execution.document.research_plan_hash
  ) {
    errors.push(
      issue(
        "assessment_execution.research_plan_binding_invalid",
        `${execution.path}#/research_plan_ref`,
        "execution plan must bind the exact immutable assessment Research Plan",
      ),
    );
  }
  if (
    concept?.schemaVersion !== "startup_opportunity.concept_hypothesis.assessment_intake.current" ||
    concept.document.run_id !== execution.document.run_id ||
    concept.document.research_readiness !== "ready"
  ) {
    errors.push(
      issue(
        "assessment_execution.concept_not_ready",
        `${execution.path}#/concept_hypothesis_ref`,
        "assessment execution cannot start before the thesis is confirmed or explicitly authorized",
      ),
    );
  }
  const revision = Number(execution.document.revision);
  if (execution.path !== `plans/research-execution.r${revision}.json`) {
    errors.push(
      issue(
        "assessment_execution.path_revision_mismatch",
        execution.path,
        "execution plan path must match its revision",
      ),
    );
  }
  if (revision > 1) {
    const parent = targetByRef(documents, execution.document.parent_execution_plan_ref);
    if (
      parent?.schemaVersion !== "startup_opportunity.research_execution_plan.assessment.current" ||
      parent.document.execution_plan_id !== execution.document.execution_plan_id ||
      parent.document.revision !== revision - 1 ||
      Number(execution.document.followup_round) !== Number(parent.document.followup_round) + 1
    ) {
      errors.push(
        issue(
          "assessment_execution.plan_lineage_invalid",
          `${execution.path}#/parent_execution_plan_ref`,
          "follow-up execution plan must descend one immutable revision and round",
        ),
      );
    }
  }

  const stages = records(execution.document.stages);
  const stageIds = stages.map((stage) => String(stage.stage_id ?? ""));
  const stageById = new Map(stages.map((stage) => [String(stage.stage_id), stage]));
  if (new Set(stageIds).size !== stages.length) {
    errors.push(
      issue(
        "assessment_execution.stage_identity_conflict",
        `${execution.path}#/stages`,
        "assessment stage ids must be unique",
      ),
    );
  }
  for (const stage of stages) {
    for (const dependency of strings(stage.depends_on)) {
      if (!stageById.has(dependency) || dependency === stage.stage_id) {
        errors.push(
          issue(
            "assessment_execution.stage_dependency_invalid",
            `${execution.path}#${String(stage.stage_id)}`,
            "stage dependencies must identify another assessment stage",
          ),
        );
      }
    }
  }
  const baseStages = policy.stage_order.map((kind) =>
    stages.find((stage) => stage.stage_kind === kind),
  );
  if (baseStages.some((stage) => stage === undefined)) {
    errors.push(
      issue(
        "assessment_execution.staged_model_incomplete",
        `${execution.path}#/stages`,
        "assessment execution requires early-kill, commercial, and delivery stages",
      ),
    );
  } else {
    const early = baseStages[0] as Record<string, unknown>;
    const commercial = baseStages[1] as Record<string, unknown>;
    const delivery = baseStages[2] as Record<string, unknown>;
    if (
      early.gate_before !== null ||
      !strings(commercial.depends_on).includes(String(early.stage_id)) ||
      commercial.gate_before !== early.gate_after ||
      !strings(delivery.depends_on).includes(String(commercial.stage_id)) ||
      delivery.gate_before !== commercial.gate_after
    ) {
      errors.push(
        issue(
          "assessment_execution.stage_gate_order_invalid",
          `${execution.path}#/stages`,
          "commercial and delivery research must wait for the preceding explicit gate",
        ),
      );
    }
  }

  const lanes = stages.flatMap((stage) => records(stage.lanes).map((lane) => ({ lane, stage })));
  for (const { lane, stage } of lanes) {
    const assignment = isRecord(lane.incumbent_response_assignment)
      ? lane.incumbent_response_assignment
      : {};
    const expectedDepth =
      stage.stage_kind === "assessment_commercial" ? "targeted_deep_dive" : "not_assigned";
    if (
      assignment.analysis_depth !== expectedDepth ||
      (expectedDepth === "not_assigned" && strings(assignment.subject_refs).length !== 0) ||
      (expectedDepth === "targeted_deep_dive" &&
        !sameStrings(strings(assignment.subject_refs), [
          String(execution.document.concept_hypothesis_ref),
        ]))
    ) {
      errors.push(
        issue(
          "assessment_execution.incumbent_response_assignment_invalid",
          `${execution.path}#${String(stage.stage_id)}/${String(lane.unit_id)}/incumbent_response_assignment`,
          "only the post-hypothesis commercial stage may run the concept-bound targeted incumbent response deep dive",
          { expectedDepth },
        ),
      );
    }
  }
  const initialLanes = lanes.filter((item) => item.stage.stage_kind !== "assessment_followup");
  if (
    initialLanes.length < policy.initial_lane_count.minimum ||
    initialLanes.length > policy.initial_lane_count.maximum
  ) {
    errors.push(
      issue(
        "assessment_execution.initial_lane_count_invalid",
        `${execution.path}#/stages`,
        "the ten reporting dimensions must use four or five initial evidence workflows",
        { laneCount: initialLanes.length },
      ),
    );
  }
  const coverage = initialLanes.flatMap((item) => strings(item.lane.reporting_dimensions));
  if (!sameStrings(coverage, policy.mandatory_reporting_dimensions)) {
    errors.push(
      issue(
        "assessment_execution.reporting_coverage_invalid",
        `${execution.path}#/stages`,
        "initial lanes must cover all ten reporting dimensions exactly once",
        { duplicates: duplicateStrings(coverage) },
      ),
    );
  }
  if (!initialLanes.some((item) => strings(item.lane.reporting_dimensions).length > 1)) {
    errors.push(
      issue(
        "assessment_execution.dimensions_not_decoupled",
        `${execution.path}#/stages`,
        "at least one evidence workflow must provide typed outputs for multiple report dimensions",
      ),
    );
  }
  const requiredByStage = new Map<string, string[]>([
    [
      "assessment_early_kill",
      [
        "target_user_and_jtbd",
        "demand_and_behavior",
        "current_alternatives_and_solution_failure",
        "compliance_and_platform_risk",
        "counter_evidence",
      ],
    ],
    [
      "assessment_commercial",
      [
        "competitor_saturation_and_differentiation",
        "buyer_language_and_willingness_to_pay",
        "acquisition_and_distribution",
      ],
    ],
    ["assessment_delivery", ["business_engine_viability", "delivery_feasibility"]],
  ]);
  for (const [kind, required] of requiredByStage) {
    const stageCoverage = lanes
      .filter((item) => item.stage.stage_kind === kind)
      .flatMap((item) => strings(item.lane.reporting_dimensions));
    if (!sameStrings(stageCoverage, required)) {
      errors.push(
        issue(
          "assessment_execution.stage_coverage_invalid",
          `${execution.path}#${kind}`,
          "assessment dimensions are assigned to the wrong staged evidence workflow",
          { required },
        ),
      );
    }
  }

  const units = new Map(planUnits(plan).map((unit) => [String(unit.unit_id), unit]));
  for (const { lane, stage } of lanes) {
    const unit = units.get(String(lane.unit_id));
    if (
      unit?.plan_disposition !== "enabled" ||
      unit.output_path !== lane.submission_path ||
      unit.required_artifact_schema !== "startup_opportunity.assessment_lane_result.v1"
    ) {
      errors.push(
        issue(
          "assessment_execution.lane_plan_mismatch",
          `${execution.path}#${String(stage.stage_id)}/${String(lane.unit_id)}`,
          "execution lane must bind one enabled immutable Research Plan unit and output",
        ),
      );
    }
  }
  const stageCost = stages.map((stage) =>
    Math.max(0, ...records(stage.lanes).map((lane) => Number(lane.time_budget_minutes) || 0)),
  );
  if (
    stageCost.reduce((total, cost) => total + cost, 0) >
    Number(execution.document.total_time_budget_minutes)
  ) {
    errors.push(
      issue(
        "assessment_execution.total_budget_understated",
        `${execution.path}#/total_time_budget_minutes`,
        "total budget must cover the longest staged path while allowing same-stage parallelism",
      ),
    );
  }
}

function laneForResult(
  result: AssessmentExecutionDocument,
  documents: ReadonlyMap<string, AssessmentExecutionDocument>,
): { readonly lane: Record<string, unknown>; readonly stage: Record<string, unknown> } | null {
  const execution = targetByRef(documents, result.document.execution_plan_ref);
  if (execution?.schemaVersion !== "startup_opportunity.research_execution_plan.assessment.current")
    return null;
  for (const stage of records(execution.document.stages)) {
    const lane = records(stage.lanes).find(
      (candidate) => candidate.unit_id === result.document.unit_id,
    );
    if (lane) return { lane, stage };
  }
  return null;
}

function validateLaneResult(
  result: AssessmentExecutionDocument,
  documents: ReadonlyMap<string, AssessmentExecutionDocument>,
  errors: ValidationIssue[],
): void {
  const binding = laneForResult(result, documents);
  const execution = targetByRef(documents, result.document.execution_plan_ref);
  const dimensions = records(result.document.dimension_results);
  const dimensionIds = dimensions.map((entry) => String(entry.dimension_id ?? ""));
  if (
    binding === null ||
    execution === null ||
    execution.document.run_id !== result.document.run_id ||
    execution.document.concept_hypothesis_ref !== result.document.concept_hypothesis_ref ||
    binding.stage.stage_id !== result.document.stage_id ||
    binding.lane.submission_path !== result.path ||
    !sameStrings(strings(binding.lane.reporting_dimensions), dimensionIds)
  ) {
    errors.push(
      issue(
        "assessment_execution.lane_result_binding_invalid",
        result.path,
        "lane result must cover exactly the dimensions assigned by its execution lane",
      ),
    );
  }
  for (const dimension of dimensions) {
    const judgments = strings(dimension.judgment_assessment_refs)
      .map((ref) => targetByRef(documents, ref))
      .filter((entry): entry is AssessmentExecutionDocument => entry !== null);
    if (
      result.document.status !== "failed" &&
      (judgments.length === 0 ||
        judgments.some(
          (judgment) =>
            ![
              "startup_opportunity.judgment_assessment.assessment.current",
              "startup_opportunity.judgment_assessment.discovery_candidate.current",
              "startup_opportunity.judgment_assessment.discovery_evaluation.current",
            ].includes(judgment.schemaVersion) ||
            judgment.document.subject_ref !== result.document.concept_hypothesis_ref ||
            judgment.document.dimension !== dimension.dimension_id,
        ))
    ) {
      errors.push(
        issue(
          "assessment_execution.dimension_judgment_invalid",
          `${result.path}#${String(dimension.dimension_id)}`,
          "each usable lane dimension requires a typed Judgment bound to the frozen thesis",
        ),
      );
    }
  }
}

function validateStageGate(
  gate: AssessmentExecutionDocument,
  documents: ReadonlyMap<string, AssessmentExecutionDocument>,
  errors: ValidationIssue[],
): void {
  const execution = targetByRef(documents, gate.document.execution_plan_ref);
  const stage = records(execution?.document.stages).find(
    (candidate) => candidate.stage_id === gate.document.stage_id,
  );
  const laneRefs = strings(gate.document.evaluated_lane_refs);
  const laneResults = laneRefs
    .map((ref) => targetByRef(documents, ref))
    .filter((entry): entry is AssessmentExecutionDocument => entry !== null);
  const expectedUnits = records(stage?.lanes).map((lane) => String(lane.unit_id));
  const actualUnits = laneResults.map((result) => String(result.document.unit_id));
  const expectedGateKind =
    stage?.stage_kind === "assessment_early_kill"
      ? "early_kill"
      : stage?.stage_kind === "assessment_commercial"
        ? "commercial"
        : stage?.stage_kind === "assessment_delivery"
          ? "delivery"
          : "followup";
  if (
    execution?.schemaVersion !== "startup_opportunity.research_execution_plan.assessment.current" ||
    execution.document.run_id !== gate.document.run_id ||
    execution.document.concept_hypothesis_ref !== gate.document.concept_hypothesis_ref ||
    stage?.gate_after !== gate.path ||
    gate.document.gate_kind !== expectedGateKind ||
    !sameStrings(expectedUnits, actualUnits)
  ) {
    errors.push(
      issue(
        "assessment_execution.gate_binding_invalid",
        gate.path,
        "stage gate must evaluate every lane assigned to the exact completed stage",
      ),
    );
    return;
  }
  const resultDimensions = laneResults.flatMap((result) =>
    records(result.document.dimension_results),
  );
  const decisions = records(gate.document.dimension_decisions);
  if (
    !sameStrings(
      decisions.map((item) => String(item.dimension_id)),
      resultDimensions.map((item) => String(item.dimension_id)),
    )
  ) {
    errors.push(
      issue(
        "assessment_execution.gate_dimension_coverage_invalid",
        `${gate.path}#/dimension_decisions`,
        "stage gate decisions must cover each staged lane dimension exactly once",
      ),
    );
  }
  for (const decision of decisions) {
    const laneResult = targetByRef(documents, decision.lane_result_ref);
    const dimension = records(laneResult?.document.dimension_results).find(
      (candidate) => candidate.dimension_id === decision.dimension_id,
    );
    if (
      dimension === undefined ||
      dimension.dimension_decision !== decision.decision ||
      dimension.decision_sufficiency !== decision.decision_sufficiency ||
      !laneRefs.includes(String(decision.lane_result_ref))
    ) {
      errors.push(
        issue(
          "assessment_execution.gate_decision_drift",
          `${gate.path}#${String(decision.dimension_id)}`,
          "stage gate cannot rewrite a lane's per-dimension Judgment result",
        ),
      );
    }
  }
  const decisiveOpposition = decisions.some(
    (decision) => decision.decision === "opposes" && decision.decision_sufficiency === "sufficient",
  );
  const failed = laneResults.some((result) => result.document.status === "failed");
  const insufficient = decisions.some((decision) =>
    ["insufficient", "blocked"].includes(String(decision.decision_sufficiency)),
  );
  const expectedOutcome = failed
    ? "runtime_blocked"
    : decisiveOpposition
      ? "deprioritize"
      : insufficient
        ? "insufficient_evidence"
        : "continue";
  if (
    gate.document.outcome !== expectedOutcome ||
    gate.document.thesis_killing_opposition !== decisiveOpposition
  ) {
    errors.push(
      issue(
        "assessment_execution.gate_outcome_invalid",
        `${gate.path}#/outcome`,
        "early-kill outcome must preserve decisive opposition, insufficiency, and runtime failure",
        { expectedOutcome },
      ),
    );
  }
  const stageIndex = records(execution.document.stages).findIndex(
    (candidate) => candidate.stage_id === stage.stage_id,
  );
  const laterUnits = records(execution.document.stages)
    .slice(stageIndex + 1)
    .flatMap((candidate) => records(candidate.lanes).map((lane) => String(lane.unit_id)));
  const expectedNotStarted = expectedOutcome === "continue" ? [] : laterUnits;
  if (!sameStrings(strings(gate.document.not_started_unit_ids), expectedNotStarted)) {
    errors.push(
      issue(
        "assessment_execution.gate_not_started_invalid",
        `${gate.path}#/not_started_unit_ids`,
        "a terminal gate must explicitly retain every later unit as not started",
        { expectedNotStarted },
      ),
    );
  }
}

function validateDispatch(
  dispatch: AssessmentExecutionDocument,
  documents: ReadonlyMap<string, AssessmentExecutionDocument>,
  errors: ValidationIssue[],
): void {
  const execution = targetByRef(documents, dispatch.document.execution_plan_ref);
  const plan = targetByRef(documents, dispatch.document.research_plan_ref);
  const stage = records(execution?.document.stages).find(
    (candidate) => candidate.stage_id === dispatch.document.stage_id,
  );
  const tasks = records(dispatch.document.tasks);
  const lanes = records(stage?.lanes);
  if (
    execution?.schemaVersion !== "startup_opportunity.research_execution_plan.assessment.current" ||
    plan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
    execution.document.research_plan_ref !== plan.path ||
    dispatch.document.run_id !== execution.document.run_id ||
    !sameStrings(
      tasks.map((task) => String(task.unit_id)),
      lanes.map((lane) => String(lane.unit_id)),
    )
  ) {
    errors.push(
      issue(
        "assessment_execution.dispatch_group_invalid",
        dispatch.path,
        "dispatch batch must include the complete selected assessment stage",
      ),
    );
  }
  for (const task of tasks) {
    const lane = lanes.find((candidate) => candidate.unit_id === task.unit_id);
    if (
      lane === undefined ||
      lane.lane_role !== task.lane_role ||
      canonicalJson(lane.incumbent_response_assignment) !==
        canonicalJson(task.incumbent_response_assignment) ||
      lane.submission_path !== task.submission_path ||
      !sameStrings(strings(lane.reporting_dimensions), strings(task.reporting_dimensions))
    ) {
      errors.push(
        issue(
          "assessment_execution.dispatch_task_drift",
          `${dispatch.path}#${String(task.unit_id)}`,
          "dispatch task differs from its immutable execution lane",
        ),
      );
    }
  }
  if (stage?.gate_before === null) {
    if (dispatch.document.gate_ref !== null) {
      errors.push(
        issue(
          "assessment_execution.dispatch_gate_invalid",
          `${dispatch.path}#/gate_ref`,
          "the first assessment stage cannot claim a predecessor gate",
        ),
      );
    }
  } else {
    const gate = targetByRef(documents, dispatch.document.gate_ref);
    if (
      dispatch.document.gate_ref !== stage?.gate_before ||
      gate?.schemaVersion !== "startup_opportunity.assessment_stage_gate.v1" ||
      gate.document.outcome !== "continue"
    ) {
      errors.push(
        issue(
          "assessment_execution.dispatch_gate_invalid",
          `${dispatch.path}#/gate_ref`,
          "later assessment stages require an exact preceding continue gate",
        ),
      );
    }
  }
}

function validateFollowup(
  decision: AssessmentExecutionDocument,
  documents: ReadonlyMap<string, AssessmentExecutionDocument>,
  policy: AssessmentExecutionPolicy,
  errors: ValidationIssue[],
): void {
  const execution = targetByRef(documents, decision.document.based_on_execution_plan_ref);
  const plan = targetByRef(documents, decision.document.based_on_research_plan_ref);
  const gate = targetByRef(documents, decision.document.stage_gate_ref);
  if (
    execution?.schemaVersion !== "startup_opportunity.research_execution_plan.assessment.current" ||
    plan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
    gate?.schemaVersion !== "startup_opportunity.assessment_stage_gate.v1" ||
    decision.document.run_id !== execution.document.run_id ||
    decision.document.concept_hypothesis_ref !== execution.document.concept_hypothesis_ref ||
    decision.document.based_on_execution_plan_revision !== execution.document.revision ||
    decision.document.based_on_execution_plan_hash !== canonicalContentHash(execution.document) ||
    decision.document.based_on_research_plan_revision !== plan.document.revision ||
    decision.document.based_on_research_plan_hash !== canonicalContentHash(plan.document) ||
    gate.document.execution_plan_ref !== execution.path ||
    decision.document.current_followup_round !== execution.document.followup_round
  ) {
    errors.push(
      issue(
        "assessment_execution.followup_binding_invalid",
        decision.path,
        "follow-up decision must bind the exact current plans, stage gate, and thesis",
      ),
    );
    return;
  }
  const dimension = String(decision.document.dimension_id);
  const gateDimension = records(gate.document.dimension_decisions).find(
    (candidate) => candidate.dimension_id === dimension,
  );
  const allowedUnit = policy.followup.dimension_unit_types.find(
    (rule) => rule.dimension_id === dimension,
  )?.unit_type;
  const previousAdds = [...documents.values()].filter(
    (entry) =>
      entry.schemaVersion === "startup_opportunity.assessment_followup_decision.v1" &&
      entry.path !== decision.path &&
      entry.document.action === "add_bounded_followup" &&
      entry.document.dimension_id === dimension &&
      entry.document.concept_hypothesis_ref === decision.document.concept_hypothesis_ref,
  );
  if (decision.document.action === "add_bounded_followup") {
    const target = isRecord(decision.document.target_unit) ? decision.document.target_unit : null;
    const nextPlanRef = `plans/research-plan.r${Number(plan.document.revision) + 1}.json`;
    const nextExecutionRef = `plans/research-execution.r${Number(execution.document.revision) + 1}.json`;
    if (
      !gateDimension ||
      gateDimension.decision_sufficiency === "sufficient" ||
      !strings(gate.document.allowed_next_actions).includes("add_bounded_followup") ||
      Number(execution.document.followup_round) >= policy.followup.max_rounds ||
      previousAdds.length >= policy.followup.max_additions_per_dimension ||
      target === null ||
      target.unit_type !== allowedUnit ||
      target.agent_role !== "lane-researcher" ||
      target.required_artifact_schema !== "startup_opportunity.assessment_lane_result.v1" ||
      !strings(target.input_refs).includes(String(decision.document.concept_hypothesis_ref)) ||
      !strings(target.input_refs).includes(String(decision.document.stage_gate_ref)) ||
      decision.document.candidate_research_plan_ref !== nextPlanRef ||
      decision.document.candidate_execution_plan_ref !== nextExecutionRef
    ) {
      errors.push(
        issue(
          "assessment_execution.followup_not_allowed",
          decision.path,
          "follow-up must use the closed dimension mapping, cap, gate, and next Plan revisions",
          { allowedUnit },
        ),
      );
    }
    for (const informationGainIssue of evaluateAssessmentFollowupInformationGain(
      decision.document,
      policy.followup.information_gain_gate,
    )) {
      errors.push(
        issue(
          informationGainIssue.code,
          `${decision.path}#${informationGainIssue.path}`,
          informationGainIssue.message,
          { likelyCause: informationGainIssue.likelyCause },
        ),
      );
    }
  } else if (!strings(gate.document.allowed_next_actions).includes("stop_followup")) {
    errors.push(
      issue(
        "assessment_execution.followup_stop_invalid",
        decision.path,
        "stop_followup requires an explicit gate disposition",
      ),
    );
  }
}

function validateReportDisclosures(
  documents: readonly AssessmentExecutionDocument[],
  documentsByPath: ReadonlyMap<string, AssessmentExecutionDocument>,
  errors: ValidationIssue[],
): void {
  for (const report of documents.filter(
    (entry) =>
      entry.schemaVersion === "startup_opportunity.terminal_report_source.v1" &&
      entry.document.mode === "concept_evidence_assessment",
  )) {
    const auditRefs = strings(report.document.audit_refs);
    const runConcepts = documents.filter(
      (entry) =>
        entry.schemaVersion ===
          "startup_opportunity.concept_hypothesis.assessment_intake.current" &&
        entry.document.run_id === report.document.run_id,
    );
    const concepts = auditRefs
      .map((ref) => targetByRef(documentsByPath, ref))
      .filter(
        (entry): entry is AssessmentExecutionDocument =>
          entry?.schemaVersion ===
          "startup_opportunity.concept_hypothesis.assessment_intake.current",
      );
    const missingConceptRefs = runConcepts
      .map((concept) => concept.path)
      .filter((conceptRef) => !auditRefs.includes(conceptRef));
    if (missingConceptRefs.length > 0) {
      errors.push(
        issue(
          "assessment_execution.report_omits_thesis_provenance",
          `${report.path}#/audit_refs`,
          "terminal Assessment report must audit-bind the current provenance-bearing thesis",
          { missingConceptRefs },
        ),
      );
    }
    for (const concept of concepts) {
      const disclosures = records(concept.document.field_provenance)
        .filter((entry) => entry.source_kind !== "user_provided")
        .map((entry) => entry.reporting_disclosure)
        .filter((value): value is string => typeof value === "string");
      const missing = disclosures.filter(
        (disclosure) => !strings(report.document.limitations).includes(disclosure),
      );
      if (missing.length > 0) {
        errors.push(
          issue(
            "assessment_execution.report_omits_thesis_provenance",
            `${report.path}#/limitations`,
            "terminal report must disclose every non-user-provided thesis field",
            { missing },
          ),
        );
      }
    }
  }
}

export function validateAssessmentExecutionContract(
  documents: readonly AssessmentExecutionDocument[],
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
  policy: AssessmentExecutionPolicy,
): readonly ValidationIssue[] {
  const relevant = documents.filter((entry) =>
    [
      "startup_opportunity.concept_hypothesis.assessment_intake.current",
      "startup_opportunity.research_execution_plan.assessment.current",
      "startup_opportunity.dispatch_batch.assessment.current",
      "startup_opportunity.assessment_evidence.v1",
      "startup_opportunity.assessment_lane_result.v1",
      "startup_opportunity.assessment_stage_gate.v1",
      "startup_opportunity.assessment_followup_decision.v1",
    ].includes(entry.schemaVersion),
  );
  if (relevant.length === 0) return [];
  const errors: ValidationIssue[] = [];
  const documentsByPath = new Map(documents.map((entry) => [entry.path, entry]));
  for (const concept of relevant.filter(
    (entry) =>
      entry.schemaVersion === "startup_opportunity.concept_hypothesis.assessment_intake.current",
  )) {
    validateConcept(concept, documentsByPath, exactRecords, errors);
  }
  for (const execution of relevant.filter(
    (entry) =>
      entry.schemaVersion === "startup_opportunity.research_execution_plan.assessment.current",
  )) {
    validateExecutionPlan(execution, documentsByPath, policy, errors);
  }
  for (const evidence of relevant.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.assessment_evidence.v1",
  )) {
    validateAssessmentEvidence(evidence, documentsByPath, exactRecords, errors);
  }
  for (const result of relevant.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.assessment_lane_result.v1",
  )) {
    validateLaneResult(result, documentsByPath, errors);
  }
  for (const gate of relevant.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.assessment_stage_gate.v1",
  )) {
    validateStageGate(gate, documentsByPath, errors);
  }
  for (const dispatch of relevant.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.dispatch_batch.assessment.current",
  )) {
    validateDispatch(dispatch, documentsByPath, errors);
  }
  for (const decision of relevant.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.assessment_followup_decision.v1",
  )) {
    validateFollowup(decision, documentsByPath, policy, errors);
  }
  validateReportDisclosures(documents, documentsByPath, errors);
  return sortIssues(errors);
}

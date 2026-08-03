import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type AssessmentExecutionDocument,
  type AssessmentExecutionPolicy,
  canonicalContentHash,
  createArtifactValidator,
  DeclarativeRuntimeCompiler,
  deriveAssessmentFollowupRevision,
  type FormalArtifactEnvelope,
  RunStore,
  StoreError,
  validateAssessmentExecutionContract,
} from "../harness/src/index.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixturePath = path.join(
  repositoryRoot,
  "tests/fixtures/g1.1/valid-assess-contract-bundle.json",
);
const createdAt = "2026-08-02T16:00:00Z";
const conceptPath = "concept-hypothesis.json";
const planPath = "plans/research-plan.r1.json";
const executionPath = "plans/research-execution.r1.json";

const dimensions = [
  "target_user_and_jtbd",
  "demand_and_behavior",
  "current_alternatives_and_solution_failure",
  "competitor_saturation_and_differentiation",
  "buyer_language_and_willingness_to_pay",
  "acquisition_and_distribution",
  "business_engine_viability",
  "delivery_feasibility",
  "compliance_and_platform_risk",
  "counter_evidence",
] as const;

type ProducerRole = "main_agent" | "lane-researcher" | "harness";

function recordAt(
  records: readonly Record<string, unknown>[],
  index: number,
  label: string,
): Record<string, unknown> {
  const record = records.at(index);
  assert.ok(record, `missing ${label}`);
  return record;
}

function entry(pathname: string, document: Record<string, unknown>): AssessmentExecutionDocument {
  return {
    path: pathname,
    schemaVersion: String(document.schema_version),
    document,
    envelope: null,
  };
}

function unit(
  unitId: string,
  unitType: string,
  outputPath: string,
  inputRefs: readonly string[] = [conceptPath],
): Record<string, unknown> {
  return {
    unit_id: unitId,
    unit_type: unitType,
    plan_disposition: "enabled",
    priority_band: "normal",
    attempt: 1,
    supersedes_unit_ref: null,
    research_goal: `SYNTHETIC contract goal for ${unitId}; no research is performed.`,
    input_refs: inputRefs,
    agent_role: "lane-researcher",
    output_path: outputPath,
    required_artifact_schema: "startup_opportunity.assessment_lane_result.v1",
    source_preferences: [],
    required_outputs: ["dimension_results"],
    stop_conditions: ["Stop at the bounded contract fixture boundary."],
    ...(unitType === "bounded_domain_research" ? { lane_kind: unitId } : {}),
  };
}

function assessmentPlan(runId: string): Record<string, unknown> {
  const problem = unit(
    "unit_problem_evidence",
    "bounded_domain_research",
    "artifacts/assessment/lanes/problem-evidence.attempt-1.json",
  );
  const counter = unit(
    "unit_counter_risk",
    "counter_evidence",
    "artifacts/assessment/lanes/counter-risk.attempt-1.json",
  );
  const commercial = unit(
    "unit_commercial",
    "bounded_domain_research",
    "artifacts/assessment/lanes/commercial.attempt-1.json",
  );
  const delivery = unit(
    "unit_business_delivery",
    "bounded_domain_research",
    "artifacts/assessment/lanes/business-delivery.attempt-1.json",
  );
  return {
    schema_version: "startup_opportunity.research_plan.v1",
    plan_id: "plan_assessment_p2_synthetic",
    run_id: runId,
    mode: "concept_evidence_assessment",
    revision: 1,
    parent_plan_ref: null,
    triggered_by_adaptation_refs: [],
    created_at: createdAt,
    research_questions: [
      {
        question_id: "rq_assessment_p2_synthetic",
        question: "Which current signals would change this synthetic concept decision?",
        decision_impact: "concept assessment",
        uncertainty: "high",
        expected_information_gain: "high",
        stop_condition: "Each reporting dimension has one typed result.",
      },
    ],
    candidate_retention_policy: {
      minimum_evidence_requirement: "This is a single-thesis Assessment fixture.",
      candidate_retention_threshold: "Keep one immutable thesis identity.",
      candidate_diversity_policy: ["Not applicable to this single-thesis fixture."],
      counterfactual_candidate_requirement: false,
    },
    exploration_policy: {
      require_seed_independent_demand_unit: true,
      require_counterfactual_unit: true,
      initial_hypotheses_are_questions_not_truth: true,
      separate_generation_and_evaluation_sources: true,
      freeze_thesis_before_enrichment: true,
      require_independent_challenger_queries: true,
    },
    waves: [
      { wave_id: "assessment_wave_early", depends_on: [], units: [problem, counter] },
      {
        wave_id: "assessment_wave_commercial",
        depends_on: ["assessment_wave_early"],
        units: [commercial],
      },
      {
        wave_id: "assessment_wave_delivery",
        depends_on: ["assessment_wave_commercial"],
        units: [delivery],
      },
    ],
    adaptation_policy_ref: "harness/policies/adaptation.v1.json",
    followup_policy: {
      max_followup_rounds: 2,
      require_decision_relevance: true,
      stop_when_no_material_new_evidence: true,
    },
  };
}

function concept(runId: string): Record<string, unknown> {
  const fields = [
    "product_thesis",
    "target_user",
    "buyer",
    "entry_scene",
    "claimed_value",
    "current_alternative",
    "delivery_form",
    "business_model",
    "acquisition_hypothesis",
  ];
  return {
    schema_version: "startup_opportunity.concept_hypothesis.v2",
    run_id: runId,
    concept_hypothesis_id: "concept_assessment_p2_synthetic",
    scope_frame_ref: "scope-frame.json",
    product_thesis: "A synthetic shared workflow may reduce missed household coordination.",
    target_user: ["synthetic household coordinator"],
    buyer: ["synthetic household payer"],
    entry_scene: "A synthetic shared task needs confirmation.",
    claimed_value: "Reduce synthetic coordination omissions.",
    current_alternative: ["status quo"],
    delivery_form: "mobile_web",
    business_model: "subscription",
    acquisition_hypothesis: "A synthetic community distribution hypothesis.",
    uses_ai: false,
    assumptions: [],
    unknowns: [],
    kill_criteria: ["A current alternative already solves the synthetic task."],
    field_provenance: fields.map((field) => ({
      field_name: field,
      source_kind: "user_provided",
      confirmation_status: "user_confirmed",
      basis_refs: ["intake.json"],
      reporting_disclosure: null,
    })),
    research_readiness: "ready",
  };
}

function lane(
  unitId: string,
  laneRole: string,
  reportingDimensions: readonly string[],
  submissionPath: string,
  dispatchGroup: string,
): Record<string, unknown> {
  return {
    unit_id: unitId,
    lane_role: laneRole,
    reporting_dimensions: reportingDimensions,
    submission_path: submissionPath,
    submission_schema: "startup_opportunity.assessment_lane_result.v1",
    time_budget_minutes: 15,
    max_sources: 10,
    straggler_policy: { on_timeout: "publish_partial", grace_minutes: 0, blocks_stage: false },
    dispatch_group: dispatchGroup,
  };
}

function executionPlan(runId: string, plan: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.research_execution_plan.v2",
    execution_plan_id: "execution_assessment_p2_synthetic",
    run_id: runId,
    mode: "concept_evidence_assessment",
    revision: 1,
    parent_execution_plan_ref: null,
    research_plan_ref: planPath,
    research_plan_hash: canonicalContentHash(plan),
    concept_hypothesis_ref: conceptPath,
    created_at: createdAt,
    research_depth: "quick",
    total_time_budget_minutes: 45,
    followup_round: 0,
    stages: [
      {
        stage_id: "assessment_stage_early",
        stage_kind: "assessment_early_kill",
        depends_on: [],
        gate_before: null,
        gate_after: "artifacts/assessment/gates/early.r1.json",
        lanes: [
          lane(
            "unit_problem_evidence",
            "evidence",
            dimensions.slice(0, 3),
            "artifacts/assessment/lanes/problem-evidence.attempt-1.json",
            "assessment_early",
          ),
          lane(
            "unit_counter_risk",
            "counter_evidence",
            dimensions.slice(8, 10),
            "artifacts/assessment/lanes/counter-risk.attempt-1.json",
            "assessment_early",
          ),
        ],
      },
      {
        stage_id: "assessment_stage_commercial",
        stage_kind: "assessment_commercial",
        depends_on: ["assessment_stage_early"],
        gate_before: "artifacts/assessment/gates/early.r1.json",
        gate_after: "artifacts/assessment/gates/commercial.r1.json",
        lanes: [
          lane(
            "unit_commercial",
            "commercial",
            dimensions.slice(3, 6),
            "artifacts/assessment/lanes/commercial.attempt-1.json",
            "assessment_commercial",
          ),
        ],
      },
      {
        stage_id: "assessment_stage_delivery",
        stage_kind: "assessment_delivery",
        depends_on: ["assessment_stage_commercial"],
        gate_before: "artifacts/assessment/gates/commercial.r1.json",
        gate_after: "artifacts/assessment/gates/delivery.r1.json",
        lanes: [
          lane(
            "unit_business_delivery",
            "feasibility",
            dimensions.slice(6, 8),
            "artifacts/assessment/lanes/business-delivery.attempt-1.json",
            "assessment_delivery",
          ),
        ],
      },
    ],
    limitations: ["SYNTHETIC contract fixture; no research or external validation was performed."],
  };
}

function intake(runId: string): AssessmentExecutionDocument {
  return entry("intake.json", {
    schema_version: "startup_opportunity.intake.v1",
    run_id: runId,
  });
}

function baseDocuments(
  runId: string,
  plan = assessmentPlan(runId),
  execution = executionPlan(runId, plan),
  hypothesis = concept(runId),
): readonly AssessmentExecutionDocument[] {
  return [
    intake(runId),
    entry(conceptPath, hypothesis),
    entry(planPath, plan),
    entry(executionPath, execution),
  ];
}

function contractCodes(
  documents: readonly AssessmentExecutionDocument[],
  policy: AssessmentExecutionPolicy,
  exactRecords: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): readonly string[] {
  return validateAssessmentExecutionContract(documents, exactRecords, policy).map(
    (issue) => issue.code,
  );
}

function resultForLane(
  runId: string,
  stage: Record<string, unknown>,
  selectedLane: Record<string, unknown>,
  disposition: "supports" | "opposes" | "insufficient_evidence" = "supports",
  status: "completed" | "failed" = "completed",
): AssessmentExecutionDocument {
  const unitId = String(selectedLane.unit_id);
  const resultPath = String(selectedLane.submission_path);
  const dimensionResults = (selectedLane.reporting_dimensions as string[]).map(
    (dimensionId, index) => ({
      dimension_id: dimensionId,
      evidence_refs: [],
      supporting_claim_refs: [],
      opposing_claim_refs: [],
      judgment_assessment_refs:
        status === "failed" ? [] : [`judgments/${unitId}-${String(index)}.json`],
      dimension_decision: disposition,
      decision_sufficiency: disposition === "insufficient_evidence" ? "insufficient" : "sufficient",
      insufficiency_reasons: disposition === "insufficient_evidence" ? ["no_signal"] : [],
      what_would_change_decision: ["A bounded synthetic contract observation."],
      limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
    }),
  );
  return entry(resultPath, {
    schema_version: "startup_opportunity.assessment_lane_result.v1",
    lane_result_id: `result_${unitId}`,
    run_id: runId,
    unit_id: unitId,
    concept_hypothesis_ref: conceptPath,
    execution_plan_ref: executionPath,
    stage_id: stage.stage_id,
    status,
    dimension_results: dimensionResults,
    source_manifest_refs: [],
    limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
  });
}

function judgmentEntries(
  results: readonly AssessmentExecutionDocument[],
): readonly AssessmentExecutionDocument[] {
  return results.flatMap((result) =>
    (result.document.dimension_results as Record<string, unknown>[]).flatMap((dimension, index) => {
      const ref = (dimension.judgment_assessment_refs as string[])[0];
      return ref === undefined
        ? []
        : [
            entry(ref, {
              schema_version: "startup_opportunity.judgment_assessment.v1",
              run_id: result.document.run_id,
              subject_ref: conceptPath,
              dimension: dimension.dimension_id,
              judgment_id: `judgment_${String(result.document.unit_id)}_${String(index)}`,
            }),
          ];
    }),
  );
}

function gateForStage(
  runId: string,
  execution: Record<string, unknown>,
  stageIndex: number,
  results: readonly AssessmentExecutionDocument[],
  outcome: "continue" | "deprioritize" | "insufficient_evidence" | "runtime_blocked",
): AssessmentExecutionDocument {
  const stages = execution.stages as Record<string, unknown>[];
  const stage = stages[stageIndex];
  assert.ok(stage);
  const laterUnits = stages
    .slice(stageIndex + 1)
    .flatMap((candidate) =>
      (candidate.lanes as Record<string, unknown>[]).map((item) => String(item.unit_id)),
    );
  const decisions = results.flatMap((result) =>
    (result.document.dimension_results as Record<string, unknown>[]).map((dimension) => ({
      dimension_id: dimension.dimension_id,
      lane_result_ref: result.path,
      decision: dimension.dimension_decision,
      decision_sufficiency: dimension.decision_sufficiency,
      decisive_refs: [],
    })),
  );
  return entry(String(stage.gate_after), {
    schema_version: "startup_opportunity.assessment_stage_gate.v1",
    gate_id: `gate_${String(stage.stage_id)}`,
    run_id: runId,
    execution_plan_ref: executionPath,
    concept_hypothesis_ref: conceptPath,
    stage_id: stage.stage_id,
    gate_kind: stageIndex === 0 ? "early_kill" : stageIndex === 1 ? "commercial" : "delivery",
    evaluated_lane_refs: results.map((result) => result.path),
    dimension_decisions: decisions,
    outcome,
    thesis_killing_opposition: outcome === "deprioritize",
    completed_stage_ids: stages.slice(0, stageIndex + 1).map((candidate) => candidate.stage_id),
    not_started_unit_ids: outcome === "continue" ? [] : laterUnits,
    allowed_next_actions:
      outcome === "continue"
        ? ["continue_next_stage"]
        : outcome === "deprioritize"
          ? ["terminate_deprioritized"]
          : outcome === "runtime_blocked"
            ? ["record_runtime_failure"]
            : ["add_bounded_followup", "stop_followup", "terminate_insufficient_evidence"],
    basis_refs: results.map((result) => result.path),
    rationale: "SYNTHETIC deterministic stage gate.",
    created_at: createdAt,
    limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
  });
}

function dispatchForStage(
  runId: string,
  execution: Record<string, unknown>,
  stageIndex: number,
  gateRef: string | null,
): AssessmentExecutionDocument {
  const stage = (execution.stages as Record<string, unknown>[])[stageIndex];
  assert.ok(stage);
  const tasks = (stage.lanes as Record<string, unknown>[]).map((selectedLane) => ({
    task_id: `task_${String(selectedLane.unit_id)}`,
    unit_id: selectedLane.unit_id,
    lane_role: selectedLane.lane_role,
    reporting_dimensions: selectedLane.reporting_dimensions,
    submission_path: selectedLane.submission_path,
    time_budget_minutes: selectedLane.time_budget_minutes,
    max_sources: selectedLane.max_sources,
  }));
  return entry(`tasks/dispatch/${String(stage.stage_id)}.r1.json`, {
    schema_version: "startup_opportunity.dispatch_batch.v2",
    dispatch_batch_id: `dispatch_${String(stage.stage_id)}`,
    run_id: runId,
    execution_plan_ref: executionPath,
    research_plan_ref: planPath,
    stage_id: stage.stage_id,
    wave_id: `wave_${String(stage.stage_id)}`,
    gate_ref: gateRef,
    requested_at: createdAt,
    agent_dispatch_performed: false,
    tasks,
  });
}

function followupDecision(
  runId: string,
  plan: Record<string, unknown>,
  execution: Record<string, unknown>,
  gate: AssessmentExecutionDocument,
  dimensionId: string,
  unitType: string,
  suffix = "one",
): AssessmentExecutionDocument {
  const decisionPath = `adaptations/decisions/followup-${suffix}.json`;
  return entry(decisionPath, {
    schema_version: "startup_opportunity.assessment_followup_decision.v1",
    decision_id: `followup_${suffix}`,
    run_id: runId,
    concept_hypothesis_ref: conceptPath,
    based_on_execution_plan_ref: executionPath,
    based_on_execution_plan_revision: execution.revision,
    based_on_execution_plan_hash: canonicalContentHash(execution),
    based_on_research_plan_ref: planPath,
    based_on_research_plan_revision: plan.revision,
    based_on_research_plan_hash: canonicalContentHash(plan),
    stage_gate_ref: gate.path,
    dimension_id: dimensionId,
    gap_type: "decision_relevant_evidence_gap",
    action: "add_bounded_followup",
    current_followup_round: execution.followup_round,
    target_unit: unit(
      `unit_followup_${suffix}`,
      unitType,
      `artifacts/assessment/lanes/followup-${suffix}.attempt-1.json`,
      [conceptPath, gate.path],
    ),
    candidate_research_plan_ref: "plans/research-plan.r2.json",
    candidate_execution_plan_ref: "plans/research-execution.r2.json",
    reason: "A decision-relevant synthetic evidence gap remains.",
    stop_condition: "Stop after one bounded follow-up result.",
    created_at: createdAt,
  });
}

function runtimeArtifact(
  artifactPath: string,
  document: Record<string, unknown>,
  producerRole: ProducerRole,
): Record<string, unknown> {
  return {
    artifact_type: document.schema_version,
    artifact_path: artifactPath,
    producer_role: producerRole,
    document,
  };
}

function compilationRequest(
  runId: string,
  artifacts: readonly Record<string, unknown>[],
  requestId: string,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: requestId,
    run_id: runId,
    operation: "publish",
    created_at: createdAt,
    artifacts,
  };
}

function v4Envelope(
  runId: string,
  artifactPath: string,
  document: Record<string, unknown>,
  inputRefs: readonly string[],
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.v4",
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    run_id: runId,
    created_at: createdAt,
    producer_role: "main_agent",
    input_refs: inputRefs,
    content_hash: canonicalContentHash(document),
    document,
  };
}

async function prepareStoreRun(context: TestContext, suffix: string) {
  const root = await mkdtemp(path.join(tmpdir(), `startup-opportunity-p2-${suffix}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = `p2-${suffix}-synthetic`;
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await store.create({ runId, mode: "concept_evidence_assessment", createdAt });
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    documents: { path: string; document: Record<string, unknown> }[];
  };
  const core = fixture.documents.slice(0, 3).map((item) => ({
    ...item,
    document: { ...item.document, run_id: runId },
  }));
  await store.publishArtifactBundle({
    runId,
    envelopes: core.map((item) =>
      v4Envelope(
        runId,
        item.path,
        item.document,
        item.path === "decision-context.json" ? [] : ["decision-context.json"],
      ),
    ),
  });
  const compiler = new DeclarativeRuntimeCompiler(runsRoot, validator);
  const hypothesis = concept(runId);
  await compiler.compile(
    compilationRequest(
      runId,
      [runtimeArtifact(conceptPath, hypothesis, "main_agent")],
      `compile_concept_${suffix}`,
    ),
  );
  const plan = assessmentPlan(runId);
  await store.publishArtifact({
    runId,
    envelope: v4Envelope(runId, planPath, plan, [conceptPath]),
  });
  return { root, runsRoot, runId, validator, store, compiler, hypothesis, plan };
}

test("four staged workflows cover ten report dimensions and ten one-dimension lanes are rejected", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const runId = "p2-plan-contract-synthetic";
  const plan = assessmentPlan(runId);
  const execution = executionPlan(runId, plan);
  assert.equal(validator.validateDocument(concept(runId)).valid, true);
  assert.equal(validator.validateDocument(execution).valid, true);
  assert.deepEqual(
    contractCodes(baseDocuments(runId, plan, execution), validator.assessmentExecutionPolicy),
    [],
  );

  const split = structuredClone(execution);
  const stages = split.stages as Record<string, unknown>[];
  const splitEarlyStage = recordAt(stages, 0, "split early stage");
  const splitCommercialStage = recordAt(stages, 1, "split commercial stage");
  const splitDeliveryStage = recordAt(stages, 2, "split delivery stage");
  splitEarlyStage.lanes = dimensions
    .slice(0, 3)
    .map((dimension, index) =>
      lane(
        `split_early_${String(index)}`,
        "evidence",
        [dimension],
        `artifacts/assessment/lanes/split-early-${String(index)}.attempt-1.json`,
        "split_early",
      ),
    );
  splitEarlyStage.lanes = [
    ...(splitEarlyStage.lanes as Record<string, unknown>[]),
    ...dimensions
      .slice(8, 10)
      .map((dimension, index) =>
        lane(
          `split_risk_${String(index)}`,
          "risk",
          [dimension],
          `artifacts/assessment/lanes/split-risk-${String(index)}.attempt-1.json`,
          "split_early",
        ),
      ),
  ];
  splitCommercialStage.lanes = dimensions
    .slice(3, 6)
    .map((dimension, index) =>
      lane(
        `split_commercial_${String(index)}`,
        "commercial",
        [dimension],
        `artifacts/assessment/lanes/split-commercial-${String(index)}.attempt-1.json`,
        "split_commercial",
      ),
    );
  splitDeliveryStage.lanes = dimensions
    .slice(6, 8)
    .map((dimension, index) =>
      lane(
        `split_delivery_${String(index)}`,
        "feasibility",
        [dimension],
        `artifacts/assessment/lanes/split-delivery-${String(index)}.attempt-1.json`,
        "split_delivery",
      ),
    );
  const splitCodes = contractCodes(
    baseDocuments(runId, plan, split),
    validator.assessmentExecutionPolicy,
  );
  assert.ok(splitCodes.includes("assessment_execution.initial_lane_count_invalid"));
  assert.ok(splitCodes.includes("assessment_execution.dimensions_not_decoupled"));

  const duplicate = structuredClone(execution);
  const duplicateEarlyStage = recordAt(
    duplicate.stages as Record<string, unknown>[],
    0,
    "duplicate early stage",
  );
  const firstLane = recordAt(
    duplicateEarlyStage.lanes as Record<string, unknown>[],
    0,
    "duplicate first lane",
  );
  firstLane.reporting_dimensions = [dimensions[0], dimensions[0], dimensions[2]];
  const duplicateCodes = contractCodes(
    baseDocuments(runId, plan, duplicate),
    validator.assessmentExecutionPolicy,
  );
  assert.ok(duplicateCodes.includes("assessment_execution.reporting_coverage_invalid"));
  assert.ok(duplicateCodes.includes("assessment_execution.stage_coverage_invalid"));
});

test("multi-dimension results preserve lane coverage and early-kill gates stop later stages", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const runId = "p2-gate-contract-synthetic";
  const plan = assessmentPlan(runId);
  const execution = executionPlan(runId, plan);
  const earlyStage = recordAt(execution.stages as Record<string, unknown>[], 0, "early stage");
  const lanes = earlyStage.lanes as Record<string, unknown>[];
  const problemLane = recordAt(lanes, 0, "problem lane");
  const riskLane = recordAt(lanes, 1, "risk lane");
  const problem = resultForLane(runId, earlyStage, problemLane, "opposes");
  const risk = resultForLane(runId, earlyStage, riskLane);
  const results = [problem, risk];
  const gate = gateForStage(runId, execution, 0, results, "deprioritize");
  const documents = [
    ...baseDocuments(runId, plan, execution),
    ...results,
    ...judgmentEntries(results),
    gate,
  ];
  const codes = contractCodes(documents, validator.assessmentExecutionPolicy);
  assert.deepEqual(codes, []);
  assert.equal((problem.document.dimension_results as unknown[]).length, 3);
  assert.deepEqual(gate.document.not_started_unit_ids, [
    "unit_commercial",
    "unit_business_delivery",
  ]);

  const terminalDispatch = dispatchForStage(runId, execution, 1, gate.path);
  assert.ok(
    contractCodes([...documents, terminalDispatch], validator.assessmentExecutionPolicy).includes(
      "assessment_execution.dispatch_gate_invalid",
    ),
  );

  const continuingResults = [
    resultForLane(runId, earlyStage, problemLane),
    resultForLane(runId, earlyStage, riskLane),
  ];
  const continueGate = gateForStage(runId, execution, 0, continuingResults, "continue");
  const allowedDispatch = dispatchForStage(runId, execution, 1, continueGate.path);
  assert.ok(
    !contractCodes(
      [
        ...baseDocuments(runId, plan, execution),
        ...continuingResults,
        ...judgmentEntries(continuingResults),
        continueGate,
        allowedDispatch,
      ],
      validator.assessmentExecutionPolicy,
    ).includes("assessment_execution.dispatch_gate_invalid"),
  );
});

test("follow-up is closed by dimension, round, repetition, exact hashes, and deterministic revisions", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const runId = "p2-followup-contract-synthetic";
  const plan = assessmentPlan(runId);
  const execution = executionPlan(runId, plan);
  const cases = [
    { dimension: "demand_and_behavior", unitType: "bounded_domain_research", stage: 0 },
    {
      dimension: "competitor_saturation_and_differentiation",
      unitType: "competitor_gap",
      stage: 1,
    },
    { dimension: "delivery_feasibility", unitType: "delivery_feasibility", stage: 2 },
    { dimension: "compliance_and_platform_risk", unitType: "compliance_risk", stage: 0 },
  ] as const;
  let demandDecision: AssessmentExecutionDocument | null = null;
  for (const item of cases) {
    const stage = recordAt(
      execution.stages as Record<string, unknown>[],
      item.stage,
      `follow-up stage ${String(item.stage)}`,
    );
    const results = (stage.lanes as Record<string, unknown>[]).map((selectedLane) =>
      resultForLane(runId, stage, selectedLane, "insufficient_evidence"),
    );
    const gate = gateForStage(runId, execution, item.stage, results, "insufficient_evidence");
    const decision = followupDecision(
      runId,
      plan,
      execution,
      gate,
      item.dimension,
      item.unitType,
      item.dimension,
    );
    const codes = contractCodes(
      [
        ...baseDocuments(runId, plan, execution),
        ...results,
        ...judgmentEntries(results),
        gate,
        decision,
      ],
      validator.assessmentExecutionPolicy,
    );
    assert.ok(
      !codes.some((code) => code.startsWith("assessment_execution.followup")),
      item.dimension,
    );
    if (item.dimension === "demand_and_behavior") demandDecision = decision;
  }
  assert.ok(demandDecision);

  const stage = recordAt(execution.stages as Record<string, unknown>[], 0, "follow-up early stage");
  const results = (stage.lanes as Record<string, unknown>[]).map((selectedLane) =>
    resultForLane(runId, stage, selectedLane, "insufficient_evidence"),
  );
  const gate = gateForStage(runId, execution, 0, results, "insufficient_evidence");
  const stale = structuredClone(demandDecision.document);
  stale.based_on_execution_plan_hash = `sha256:${"0".repeat(64)}`;
  assert.ok(
    contractCodes(
      [...baseDocuments(runId, plan, execution), gate, entry(demandDecision.path, stale)],
      validator.assessmentExecutionPolicy,
    ).includes("assessment_execution.followup_binding_invalid"),
  );

  const arbitrary = structuredClone(demandDecision.document);
  (arbitrary.target_unit as Record<string, unknown>).unit_type = "buyer_language";
  assert.ok(
    contractCodes(
      [...baseDocuments(runId, plan, execution), gate, entry(demandDecision.path, arbitrary)],
      validator.assessmentExecutionPolicy,
    ).includes("assessment_execution.followup_not_allowed"),
  );

  const repeated = followupDecision(
    runId,
    plan,
    execution,
    gate,
    "demand_and_behavior",
    "bounded_domain_research",
    "repeated",
  );
  assert.ok(
    contractCodes(
      [...baseDocuments(runId, plan, execution), gate, demandDecision, repeated],
      validator.assessmentExecutionPolicy,
    ).includes("assessment_execution.followup_not_allowed"),
  );

  const exhaustedExecution = structuredClone(execution);
  exhaustedExecution.followup_round = 2;
  const exhaustedDecision = structuredClone(demandDecision.document);
  exhaustedDecision.current_followup_round = 2;
  exhaustedDecision.based_on_execution_plan_hash = canonicalContentHash(exhaustedExecution);
  assert.ok(
    contractCodes(
      [
        ...baseDocuments(runId, plan, exhaustedExecution),
        gate,
        entry(demandDecision.path, exhaustedDecision),
      ],
      validator.assessmentExecutionPolicy,
    ).includes("assessment_execution.followup_not_allowed"),
  );

  const derived = deriveAssessmentFollowupRevision(
    planPath,
    plan,
    executionPath,
    execution,
    demandDecision.path,
    demandDecision.document,
    "2026-08-02T16:30:00Z",
  );
  const replay = deriveAssessmentFollowupRevision(
    planPath,
    plan,
    executionPath,
    execution,
    demandDecision.path,
    demandDecision.document,
    "2026-08-02T16:30:00Z",
  );
  assert.deepEqual(derived, replay);
  assert.equal(derived.researchPlanPath, "plans/research-plan.r2.json");
  assert.equal(derived.executionPlanPath, "plans/research-execution.r2.json");
  const derivedWaves = derived.researchPlan.waves as Record<string, unknown>[];
  assert.deepEqual(derivedWaves.at(-1)?.depends_on, ["assessment_wave_early"]);
  assert.equal(
    derived.executionPlan.research_plan_hash,
    canonicalContentHash(derived.researchPlan),
  );
  assert.equal(validator.validateDocument(derived.researchPlan).valid, true);
  assert.equal(validator.validateDocument(derived.executionPlan).valid, true);
});

test("thesis provenance blocks unknowns, requires exact user confirmation, and reaches reports", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const runId = "p2-provenance-contract-synthetic";
  const policy = validator.assessmentExecutionPolicy;
  const plan = assessmentPlan(runId);
  const execution = executionPlan(runId, plan);
  const unknown = concept(runId);
  unknown.product_thesis = null;
  unknown.research_readiness = "clarification_required";
  const unknownProvenance = recordAt(
    unknown.field_provenance as Record<string, unknown>[],
    0,
    "product thesis provenance",
  );
  unknownProvenance.source_kind = "unknown";
  unknownProvenance.confirmation_status = "clarification_required";
  unknownProvenance.basis_refs = [];
  unknownProvenance.reporting_disclosure = "The product thesis remains unknown.";
  const unknownCodes = contractCodes(baseDocuments(runId, plan, execution, unknown), policy);
  assert.ok(unknownCodes.includes("assessment_execution.concept_not_ready"));
  assert.ok(!unknownCodes.includes("assessment_execution.research_readiness_mismatch"));

  const assumed = concept(runId);
  const disclosure = "The acquisition hypothesis is an agent assumption authorized by the user.";
  const assumedProvenance = recordAt(
    assumed.field_provenance as Record<string, unknown>[],
    -1,
    "acquisition hypothesis provenance",
  );
  assumedProvenance.source_kind = "agent_assumed";
  assumedProvenance.confirmation_status = "user_authorized_assumption";
  assumedProvenance.basis_refs = ["decisions.jsonl#decision_assumption_synthetic"];
  assumedProvenance.reporting_disclosure = disclosure;
  assert.ok(
    contractCodes(baseDocuments(runId, plan, execution, assumed), policy).includes(
      "assessment_execution.provenance_basis_invalid",
    ),
  );
  const exactRecords = new Map<string, Record<string, unknown>>([
    [
      "decisions.jsonl#decision_assumption_synthetic",
      {
        schema_version: "startup_opportunity.decision.v1",
        decision_id: "decision_assumption_synthetic",
        run_id: runId,
        actor: "user",
        decision_type: "scope_assumption_confirmed",
      },
    ],
  ]);
  assert.ok(
    !contractCodes(baseDocuments(runId, plan, execution, assumed), policy, exactRecords).includes(
      "assessment_execution.provenance_basis_invalid",
    ),
  );

  const report = entry("report.json", {
    schema_version: "startup_opportunity.terminal_report_source.v1",
    run_id: runId,
    mode: "concept_evidence_assessment",
    audit_refs: [],
    limitations: [],
  });
  assert.ok(
    contractCodes(
      [...baseDocuments(runId, plan, execution, assumed), report],
      policy,
      exactRecords,
    ).includes("assessment_execution.report_omits_thesis_provenance"),
  );
  report.document.audit_refs = [conceptPath];
  assert.ok(
    contractCodes(
      [...baseDocuments(runId, plan, execution, assumed), report],
      policy,
      exactRecords,
    ).includes("assessment_execution.report_omits_thesis_provenance"),
  );
  report.document.limitations = [disclosure];
  assert.ok(
    !contractCodes(
      [...baseDocuments(runId, plan, execution, assumed), report],
      policy,
      exactRecords,
    ).includes("assessment_execution.report_omits_thesis_provenance"),
  );
});

test("v19 compiler publishes, rejects mixed surfaces, recovers faults, and projects terminal staging", async (t) => {
  const state = await prepareStoreRun(t, "runtime");
  const execution = executionPlan(state.runId, state.plan);
  const executionArtifact = runtimeArtifact(executionPath, execution, "main_agent");
  const request = compilationRequest(
    state.runId,
    [executionArtifact],
    "compile_execution_p2_synthetic",
  );
  await assert.rejects(
    state.compiler.compile(request, { faultAt: "after_temp_write" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.deepEqual(reopened.recoveredArtifactPaths, [executionPath]);
  const replay = await state.compiler.compile(request);
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(
    replay.compiled_envelopes[0]?.schema_version,
    "startup_opportunity.artifact_envelope.v19",
  );
  assert.equal(
    replay.validation_closure.document_bundle_version,
    "startup_opportunity.document_bundle.v19",
  );

  const mixed = compilationRequest(
    state.runId,
    [
      runtimeArtifact(conceptPath, state.hypothesis, "main_agent"),
      runtimeArtifact(
        "plans/discovery-execution.r1.json",
        { schema_version: "startup_opportunity.research_execution_plan.v1", run_id: state.runId },
        "main_agent",
      ),
    ],
    "compile_mixed_p2_synthetic",
  );
  await assert.rejects(
    state.compiler.compile(mixed),
    (error: unknown) =>
      error instanceof StoreError && error.code === "runtime.compilation_version_mixed",
  );

  const earlyStage = recordAt(
    execution.stages as Record<string, unknown>[],
    0,
    "runtime early stage",
  );
  const dispatch = dispatchForStage(state.runId, execution, 0, null);
  await state.compiler.compile(
    compilationRequest(
      state.runId,
      [runtimeArtifact(dispatch.path, dispatch.document, "harness")],
      "compile_dispatch_p2_synthetic",
    ),
  );
  assert.deepEqual((await state.store.status(state.runId)).manifest.active_units, [
    "unit_counter_risk",
    "unit_problem_evidence",
  ]);

  const failedResults = (earlyStage.lanes as Record<string, unknown>[]).map((selectedLane) =>
    resultForLane(state.runId, earlyStage, selectedLane, "insufficient_evidence", "failed"),
  );
  await state.compiler.compile(
    compilationRequest(
      state.runId,
      failedResults.map((result) =>
        runtimeArtifact(result.path, result.document, "lane-researcher"),
      ),
      "compile_failed_lanes_p2_synthetic",
    ),
  );
  const gate = gateForStage(state.runId, execution, 0, failedResults, "runtime_blocked");
  await state.compiler.compile(
    compilationRequest(
      state.runId,
      [runtimeArtifact(gate.path, gate.document, "main_agent")],
      "compile_terminal_gate_p2_synthetic",
    ),
  );
  const manifest = (await state.store.status(state.runId)).manifest;
  assert.deepEqual(manifest.failed_units, ["unit_counter_risk", "unit_problem_evidence"]);
  assert.deepEqual(manifest.skipped_units, ["unit_business_delivery", "unit_commercial"]);
  assert.deepEqual(manifest.active_units, []);

  const forbiddenDispatch = dispatchForStage(state.runId, execution, 1, gate.path);
  await assert.rejects(
    state.compiler.compile(
      compilationRequest(
        state.runId,
        [runtimeArtifact(forbiddenDispatch.path, forbiddenDispatch.document, "harness")],
        "compile_after_terminal_gate_p2_synthetic",
      ),
    ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "runtime.compilation_validation_failed",
  );
  assert.deepEqual((await state.store.status(state.runId)).manifest, manifest);
});

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
  DispatchLaunchRegistry,
  deriveAssessmentFollowupRevision,
  deriveAssessmentInformationGainAuthority,
  EvidenceStore,
  type FormalArtifactEnvelope,
  LaneResultMaterializer,
  RunStore,
  StoreError,
  validateAssessmentExecutionContract,
} from "../harness/src/index.js";
import { createConfirmedRun, publishInitialPlanBundle } from "./helpers/current-run.js";

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

type ProducerRole = "main_agent" | "lane_researcher" | "harness";

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
    adaptation_policy_ref: "harness/policies/adaptation.current.json",
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
    schema_version: "startup_opportunity.concept_hypothesis.assessment_intake.current",
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
  analysisDepth: "not_assigned" | "targeted_deep_dive" = "not_assigned",
): Record<string, unknown> {
  return {
    unit_id: unitId,
    lane_role: laneRole,
    incumbent_response_assignment: {
      analysis_depth: analysisDepth,
      assignment_role: analysisDepth === "targeted_deep_dive" ? "owner" : "none",
      subject_refs: analysisDepth === "targeted_deep_dive" ? [conceptPath] : [],
      rationale:
        analysisDepth === "targeted_deep_dive"
          ? "The formed concept receives a targeted incumbent response deep dive."
          : "This lane is outside the assigned incumbent response scope.",
    },
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
    schema_version: "startup_opportunity.research_execution_plan.assessment.current",
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
    resource_allocation: {
      customer_commercial_percent: 65,
      market_structure_percent: 17,
      academic_percent: 18,
    },
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
            "targeted_deep_dive",
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
      coverage_disposition: "partial",
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
              schema_version: "startup_opportunity.judgment_assessment.assessment.current",
              run_id: result.document.run_id,
              subject_ref: conceptPath,
              dimension: dimension.dimension_id,
              judgment_id: `judgment_${String(result.document.unit_id)}_${String(index)}`,
              judgment_signal:
                dimension.dimension_decision === "opposes"
                  ? "opposed"
                  : dimension.dimension_decision === "supports"
                    ? "supported"
                    : dimension.dimension_decision === "insufficient_evidence"
                      ? "no_signal"
                      : "mixed",
              evidence_tier_summary: [],
              supporting_claim_refs:
                dimension.dimension_decision === "supports" ? [conceptPath] : [],
              opposing_claim_refs: dimension.dimension_decision === "opposes" ? [conceptPath] : [],
              representativeness: "SYNTHETIC contract judgment; not market Evidence.",
              independence: "SYNTHETIC contract judgment with no independence claim.",
              decision_sufficiency: dimension.decision_sufficiency,
              insufficiency_reasons: dimension.insufficiency_reasons,
              what_would_change_the_decision: dimension.what_would_change_decision,
              valid_as_of: "2026-08-02",
              limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
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
    incumbent_response_assignment: structuredClone(selectedLane.incumbent_response_assignment),
    reporting_dimensions: selectedLane.reporting_dimensions,
    submission_path: selectedLane.submission_path,
    time_budget_minutes: selectedLane.time_budget_minutes,
    max_sources: selectedLane.max_sources,
  }));
  return entry(`tasks/dispatch/${String(stage.stage_id)}.r1.json`, {
    schema_version: "startup_opportunity.dispatch_batch.assessment.current",
    dispatch_batch_id: `dispatch_${String(stage.stage_id)}`,
    run_id: runId,
    execution_plan_ref: executionPath,
    research_plan_ref: planPath,
    stage_id: stage.stage_id,
    wave_id: `wave_${String(stage.stage_id)}`,
    gate_ref: gateRef,
    requested_at: createdAt,
    dispatch_mode: "parallel_immediate",
    agent_dispatch_performed: false,
    launch_registration_required: true,
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
    target_decision: "key_confidence",
    blocking_gap: "A decision-critical synthetic confidence gap remains after Wave 1.",
    expected_evidence: ["A new synthetic observation from an independent public source."],
    gap_resolution_class: "public_web_resolvable",
    acquisition_route: "public_web",
    availability: "available_now",
    expected_decision_change: "key_confidence",
    wave_1_evidence_overlap: {
      overlap_level: "none",
      overlapping_evidence_refs: [],
      novelty_rationale: "The proposed source and signal were not covered in Wave 1.",
    },
    information_gain_assessment: {
      rationale:
        "The researcher explains the intended gain; the Harness derives actual gain from exact Lane and Evidence closure.",
    },
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

function assessmentEvidence(
  runId: string,
  plan: Record<string, unknown>,
  dispatch: AssessmentExecutionDocument,
  record: Record<string, unknown>,
): AssessmentExecutionDocument {
  const unitId = String(record.unit_id);
  const planUnit = (plan.waves as Record<string, unknown>[])
    .flatMap((wave) => wave.units as Record<string, unknown>[])
    .find((unit) => unit.unit_id === unitId);
  assert.ok(planUnit);
  const task = (dispatch.document.tasks as Record<string, unknown>[]).find(
    (candidate) => candidate.unit_id === unitId,
  );
  assert.ok(task);
  return entry(`evidence/records/${String(record.evidence_id)}.json`, {
    schema_version: "startup_opportunity.assessment_evidence.v1",
    evidence_id: record.evidence_id,
    run_id: runId,
    unit_id: unitId,
    dispatch_batch_ref: `${dispatch.path}#${String(task.task_id)}`,
    concept_hypothesis_ref: conceptPath,
    research_plan_ref: planPath,
    execution_plan_ref: executionPath,
    source_type: "web_page",
    source_name: "Synthetic assessment Evidence contract source",
    research_goal: planUnit.research_goal,
    source_group_id: "source_synthetic_assessment_contract",
    mechanical_binding: {
      substrate_record_ref: `evidence/manifest.jsonl#${String(record.evidence_id)}`,
      source_hash: record.source_hash,
      content_hash: record.content_hash,
      raw_content_ref: record.raw_content_ref,
      operation_key: record.operation_key,
      recorded_at: record.recorded_at,
    },
    provenance: {
      acquisition_method: "synthetic_fixture_only",
      source_owner: "Synthetic test fixture",
      original_creator: "Synthetic test fixture",
      method_notes: "Synthetic bytes exercise the current Assessment Evidence binding only.",
    },
    source_assessment: {
      independence: "unknown",
      canonical_source_group: "source_synthetic_assessment_contract",
      shared_dataset_group: null,
      syndication_group: null,
      biases: ["sampling_method_unknown"],
      bias_notes: "Synthetic contract material is not research Evidence.",
    },
    evidence_tier: "model_inference_only",
    evidence_lifecycle_status: "active",
    evidence_role: "context",
    representativeness: "Only the deterministic current-contract test path is represented.",
    valid_as_of: "2026-08-02",
    freshness_policy: "immutable_historical_record",
    limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
  });
}

function v4Envelope(
  runId: string,
  artifactPath: string,
  document: Record<string, unknown>,
  inputRefs: readonly string[],
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
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

async function prepareCoreStoreRun(context: TestContext, suffix: string) {
  const root = await mkdtemp(path.join(tmpdir(), `startup-opportunity-p2-${suffix}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = `p2-${suffix}-synthetic`;
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  const created = await createConfirmedRun(store, {
    runId,
    mode: "concept_evidence_assessment",
    createdAt,
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
  });
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
  return { root, runsRoot, runId, validator, store, compiler, created };
}

async function prepareStoreRun(context: TestContext, suffix: string) {
  const core = await prepareCoreStoreRun(context, suffix);
  const { runId, store, compiler } = core;
  const hypothesis = concept(runId);
  await compiler.compile(
    compilationRequest(
      runId,
      [runtimeArtifact(conceptPath, hypothesis, "main_agent")],
      `compile_concept_${suffix}`,
    ),
  );
  const plan = assessmentPlan(runId);
  await publishInitialPlanBundle(
    store,
    runId,
    [v4Envelope(runId, planPath, plan, [conceptPath])],
    "assessment",
  );
  return { ...core, hypothesis, plan };
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

  const explicitNoEvidence = structuredClone(problem);
  const explicitNoEvidenceDimension = recordAt(
    explicitNoEvidence.document.dimension_results as Record<string, unknown>[],
    0,
    "explicit no-Evidence dimension",
  );
  explicitNoEvidenceDimension.coverage_disposition = "no_evidence_found";
  explicitNoEvidenceDimension.dimension_decision = "insufficient_evidence";
  explicitNoEvidenceDimension.decision_sufficiency = "insufficient";
  explicitNoEvidenceDimension.evidence_refs = [];
  explicitNoEvidenceDimension.supporting_claim_refs = [];
  explicitNoEvidenceDimension.opposing_claim_refs = [];
  explicitNoEvidenceDimension.insufficiency_reasons = ["no_signal"];
  assert.equal(validator.validateDocument(explicitNoEvidence.document).valid, true);
  assert.ok(
    !contractCodes(
      [...baseDocuments(runId, plan, execution), explicitNoEvidence],
      validator.assessmentExecutionPolicy,
    ).includes("assessment_execution.dimension_coverage_disposition_invalid"),
  );

  const blockedNoEvidence = structuredClone(explicitNoEvidence);
  const blockedDimension = recordAt(
    blockedNoEvidence.document.dimension_results as Record<string, unknown>[],
    0,
    "blocked no-Evidence dimension",
  );
  blockedDimension.decision_sufficiency = "blocked";
  assert.equal(validator.validateDocument(blockedNoEvidence.document).valid, false);
  assert.ok(
    contractCodes(
      [...baseDocuments(runId, plan, execution), blockedNoEvidence],
      validator.assessmentExecutionPolicy,
    ).includes("assessment_execution.dimension_coverage_disposition_invalid"),
  );

  const blockedCovered = structuredClone(blockedNoEvidence);
  const blockedCoveredDimension = recordAt(
    blockedCovered.document.dimension_results as Record<string, unknown>[],
    0,
    "blocked covered dimension",
  );
  blockedCoveredDimension.coverage_disposition = "covered";
  assert.equal(validator.validateDocument(blockedCovered.document).valid, false);
  assert.ok(
    contractCodes(
      [...baseDocuments(runId, plan, execution), blockedCovered],
      validator.assessmentExecutionPolicy,
    ).includes("assessment_execution.dimension_coverage_disposition_invalid"),
  );

  const blockedPartial = structuredClone(blockedCovered);
  const blockedPartialDimension = recordAt(
    blockedPartial.document.dimension_results as Record<string, unknown>[],
    0,
    "blocked partial dimension",
  );
  blockedPartialDimension.coverage_disposition = "partial";
  assert.equal(validator.validateDocument(blockedPartial.document).valid, true);
  assert.ok(
    !contractCodes(
      [...baseDocuments(runId, plan, execution), blockedPartial],
      validator.assessmentExecutionPolicy,
    ).includes("assessment_execution.dimension_coverage_disposition_invalid"),
  );

  const dispatch = dispatchForStage(runId, execution, 0, null);
  const problemPlanUnit = (plan.waves as Record<string, unknown>[])
    .flatMap((wave) => wave.units as Record<string, unknown>[])
    .find((unit) => unit.unit_id === problemLane.unit_id);
  assert.ok(problemPlanUnit);
  const evidenceHash = "1".repeat(64);
  const contentHash = "2".repeat(64);
  const substrate = {
    schema_version: "startup_opportunity.evidence_store_record.v2",
    evidence_id: `ev_${evidenceHash}`,
    run_id: runId,
    unit_id: problemLane.unit_id,
    source: {
      kind: "public_url",
      canonical_url: "https://orthogonal-coverage.synthetic.invalid/evidence",
    },
    source_hash: `sha256:${evidenceHash}`,
    content_hash: `sha256:${contentHash}`,
    research_goal: problemPlanUnit.research_goal,
    raw_content_ref: `evidence/raw/sha256-${contentHash}.bin`,
    operation_key: `sha256:${"3".repeat(64)}`,
    recorded_at: createdAt,
  };
  const formalEvidence = assessmentEvidence(runId, plan, dispatch, substrate);
  const exactRecords = new Map<string, Record<string, unknown>>([
    [`evidence/manifest.jsonl#${substrate.evidence_id}`, substrate as Record<string, unknown>],
  ]);
  for (const [coverageDisposition, decisionSufficiency] of [
    ["covered", "insufficient"],
    ["partial", "sufficient"],
  ] as const) {
    const orthogonal = structuredClone(problem);
    const orthogonalDimension = recordAt(
      orthogonal.document.dimension_results as Record<string, unknown>[],
      0,
      `${coverageDisposition} ${decisionSufficiency} dimension`,
    );
    orthogonalDimension.coverage_disposition = coverageDisposition;
    orthogonalDimension.decision_sufficiency = decisionSufficiency;
    orthogonalDimension.dimension_decision =
      decisionSufficiency === "sufficient" ? "opposes" : "insufficient_evidence";
    orthogonalDimension.evidence_refs = [formalEvidence.path];
    orthogonalDimension.insufficiency_reasons =
      decisionSufficiency === "insufficient" ? ["conflicting_signal"] : [];
    assert.equal(validator.validateDocument(orthogonal.document).valid, true);
    const orthogonalCodes = contractCodes(
      [
        ...baseDocuments(runId, plan, execution),
        dispatch,
        formalEvidence,
        orthogonal,
        ...judgmentEntries([orthogonal]),
      ],
      validator.assessmentExecutionPolicy,
      exactRecords,
    );
    assert.ok(
      !orthogonalCodes.includes("assessment_execution.dimension_coverage_disposition_invalid"),
    );
    assert.ok(
      !orthogonalCodes.includes("assessment_execution.dimension_coverage_evidence_invalid"),
    );
    assert.ok(!orthogonalCodes.includes("assessment_execution.evidence_binding_invalid"));
    assert.ok(!orthogonalCodes.includes("assessment_execution.evidence_substrate_invalid"));
  }
  const falseNoEvidence = structuredClone(problem);
  const falseNoEvidenceDimension = recordAt(
    falseNoEvidence.document.dimension_results as Record<string, unknown>[],
    0,
    "false no-Evidence dimension",
  );
  falseNoEvidenceDimension.coverage_disposition = "no_evidence_found";
  falseNoEvidenceDimension.dimension_decision = "insufficient_evidence";
  falseNoEvidenceDimension.decision_sufficiency = "insufficient";
  falseNoEvidenceDimension.evidence_refs = [formalEvidence.path];
  falseNoEvidenceDimension.insufficiency_reasons = ["conflicting_signal"];
  assert.equal(validator.validateDocument(falseNoEvidence.document).valid, true);
  assert.ok(
    contractCodes(
      [
        ...baseDocuments(runId, plan, execution),
        dispatch,
        formalEvidence,
        falseNoEvidence,
        ...judgmentEntries([falseNoEvidence]),
      ],
      validator.assessmentExecutionPolicy,
      exactRecords,
    ).includes("assessment_execution.dimension_coverage_evidence_invalid"),
  );
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

  const externalOnly = structuredClone(demandDecision.document);
  externalOnly.gap_resolution_class = "external_validation_only";
  externalOnly.acquisition_route = "external_validation";
  externalOnly.availability = "external_validation_only";
  const externalIssues = validateAssessmentExecutionContract(
    [...baseDocuments(runId, plan, execution), gate, entry(demandDecision.path, externalOnly)],
    new Map(),
    validator.assessmentExecutionPolicy,
  );
  assert.ok(
    externalIssues.some(
      (issue) =>
        issue.code === "assessment_information_gain.gap_not_researchable" &&
        issue.details.likelyCause ===
          "The gap requires external validation or cannot change the decision.",
    ),
  );
  assert.ok(
    externalIssues.some(
      (issue) => issue.code === "assessment_information_gain.evidence_unavailable",
    ),
  );
  assert.throws(
    () =>
      deriveAssessmentFollowupRevision(
        planPath,
        plan,
        executionPath,
        execution,
        demandDecision.path,
        externalOnly,
        "2026-08-02T16:30:00Z",
        [...baseDocuments(runId, plan, execution), gate],
        new Map(),
      ),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "assessment.followup_information_gain_ineligible",
  );

  const duplicative = structuredClone(demandDecision.document);
  duplicative.wave_1_evidence_overlap = {
    overlap_level: "duplicate",
    overlapping_evidence_refs: [gate.path],
    novelty_rationale: "The proposed task repeats the Wave 1 gate basis.",
  };
  assert.ok(
    contractCodes(
      [...baseDocuments(runId, plan, execution), gate, entry(demandDecision.path, duplicative)],
      validator.assessmentExecutionPolicy,
    ).includes("assessment_information_gain.wave_1_overlap_excessive"),
  );

  const noChange = structuredClone(demandDecision.document);
  noChange.gap_resolution_class = "non_decision_relevant";
  noChange.acquisition_route = "none";
  noChange.availability = "unavailable";
  noChange.expected_decision_change = "none";
  assert.ok(
    contractCodes(
      [...baseDocuments(runId, plan, execution), gate, entry(demandDecision.path, noChange)],
      validator.assessmentExecutionPolicy,
    ).includes("assessment_information_gain.decision_change_missing"),
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
    [...baseDocuments(runId, plan, execution), gate],
    new Map(),
  );
  const replay = deriveAssessmentFollowupRevision(
    planPath,
    plan,
    executionPath,
    execution,
    demandDecision.path,
    demandDecision.document,
    "2026-08-02T16:30:00Z",
    [...baseDocuments(runId, plan, execution), gate],
    new Map(),
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

  const revisionOneDocuments = [
    ...baseDocuments(runId, plan, execution),
    ...results,
    ...judgmentEntries(results),
    gate,
    demandDecision,
  ];
  const derivedPlanEntry = entry(derived.researchPlanPath, derived.researchPlan);
  const derivedExecutionEntry = entry(derived.executionPlanPath, derived.executionPlan);
  const followupStage = recordAt(
    derived.executionPlan.stages as Record<string, unknown>[],
    3,
    "first follow-up stage",
  );
  const followupLane = recordAt(
    followupStage.lanes as Record<string, unknown>[],
    0,
    "first follow-up lane",
  );
  const followupResult = resultForLane(runId, followupStage, followupLane, "insufficient_evidence");
  followupResult.document.execution_plan_ref = derived.executionPlanPath;
  const followupGate = gateForStage(
    runId,
    derived.executionPlan,
    3,
    [followupResult],
    "insufficient_evidence",
  );
  followupGate.document.execution_plan_ref = derived.executionPlanPath;
  followupGate.document.gate_kind = "followup";
  const second = followupDecision(
    runId,
    derived.researchPlan,
    derived.executionPlan,
    followupGate,
    "demand_and_behavior",
    "bounded_domain_research",
    "two",
  );
  second.document.based_on_research_plan_ref = derived.researchPlanPath;
  second.document.based_on_execution_plan_ref = derived.executionPlanPath;
  second.document.candidate_research_plan_ref = "plans/research-plan.r3.json";
  second.document.candidate_execution_plan_ref = "plans/research-execution.r3.json";
  const throughFirstFollowup = [
    ...revisionOneDocuments,
    derivedPlanEntry,
    derivedExecutionEntry,
    followupResult,
    ...judgmentEntries([followupResult]),
    followupGate,
  ];
  const repeatedRouteCodes = contractCodes(
    [...throughFirstFollowup, second],
    validator.assessmentExecutionPolicy,
  );
  assert.ok(repeatedRouteCodes.includes("assessment_information_gain.route_switch_required"));
  assert.ok(!repeatedRouteCodes.includes("assessment_execution.followup_not_allowed"));

  const sibling = {
    ...structuredClone(demandDecision),
    path: "adaptations/decisions/followup-sibling.json",
  };
  sibling.document.decision_id = "followup_sibling";
  sibling.document.dimension_id = "delivery_feasibility";
  sibling.document.candidate_execution_plan_ref = derived.executionPlanPath;
  const historyWithoutSibling = deriveAssessmentInformationGainAuthority(
    second,
    new Map([...throughFirstFollowup, sibling].map((document) => [document.path, document])),
    new Map(),
  );
  assert.equal(historyWithoutSibling.route_history.length, 1);

  const switched = structuredClone(second);
  switched.document.gap_resolution_class = "api_or_professional_data_resolvable";
  switched.document.acquisition_route = "public_api";
  switched.document.availability = "available_with_authorized_access";
  const switchedCodes = contractCodes(
    [...throughFirstFollowup, switched],
    validator.assessmentExecutionPolicy,
  );
  assert.ok(!switchedCodes.includes("assessment_information_gain.route_switch_required"));
  assert.ok(!switchedCodes.includes("assessment_execution.followup_not_allowed"));
  const derivedSecond = deriveAssessmentFollowupRevision(
    derived.researchPlanPath,
    derived.researchPlan,
    derived.executionPlanPath,
    derived.executionPlan,
    switched.path,
    switched.document,
    "2026-08-02T17:00:00Z",
    throughFirstFollowup,
    new Map(),
  );
  assert.equal(derivedSecond.executionPlan.followup_round, 2);

  const secondPlanEntry = entry(derivedSecond.researchPlanPath, derivedSecond.researchPlan);
  const secondExecutionEntry = entry(derivedSecond.executionPlanPath, derivedSecond.executionPlan);
  const secondStage = recordAt(
    derivedSecond.executionPlan.stages as Record<string, unknown>[],
    4,
    "second follow-up stage",
  );
  const secondLane = recordAt(
    secondStage.lanes as Record<string, unknown>[],
    0,
    "second follow-up lane",
  );
  const secondResult = resultForLane(runId, secondStage, secondLane, "insufficient_evidence");
  secondResult.document.execution_plan_ref = derivedSecond.executionPlanPath;
  const secondGate = gateForStage(
    runId,
    derivedSecond.executionPlan,
    4,
    [secondResult],
    "insufficient_evidence",
  );
  secondGate.document.execution_plan_ref = derivedSecond.executionPlanPath;
  secondGate.document.gate_kind = "followup";
  const throughSecondFollowup = [
    ...throughFirstFollowup,
    switched,
    secondPlanEntry,
    secondExecutionEntry,
    secondResult,
    ...judgmentEntries([secondResult]),
    secondGate,
  ];
  const third = followupDecision(
    runId,
    derivedSecond.researchPlan,
    derivedSecond.executionPlan,
    secondGate,
    "demand_and_behavior",
    "bounded_domain_research",
    "three",
  );
  third.document.based_on_research_plan_ref = derivedSecond.researchPlanPath;
  third.document.based_on_execution_plan_ref = derivedSecond.executionPlanPath;
  third.document.candidate_research_plan_ref = "plans/research-plan.r4.json";
  third.document.candidate_execution_plan_ref = "plans/research-execution.r4.json";
  const thirdCodes = contractCodes(
    [...throughSecondFollowup, third],
    validator.assessmentExecutionPolicy,
  );
  assert.ok(thirdCodes.includes("assessment_information_gain.stop_required"));
  assert.ok(thirdCodes.includes("assessment_execution.followup_not_allowed"));

  const stop = {
    ...structuredClone(third),
    path: "adaptations/decisions/followup-stop.json",
  };
  stop.document.decision_id = "followup_stop";
  stop.document.action = "stop_followup";
  stop.document.target_unit = null;
  stop.document.candidate_research_plan_ref = null;
  stop.document.candidate_execution_plan_ref = null;
  const stopCodes = contractCodes(
    [...throughSecondFollowup, stop],
    validator.assessmentExecutionPolicy,
  );
  assert.ok(!stopCodes.includes("assessment_execution.followup_stop_invalid"));
  assert.ok(!stopCodes.includes("assessment_execution.followup_binding_invalid"));

  const emptyAuthority = deriveAssessmentInformationGainAuthority(
    demandDecision,
    new Map(
      [...baseDocuments(runId, plan, execution), ...results, ...judgmentEntries(results), gate].map(
        (document) => [document.path, document],
      ),
    ),
    new Map(),
  );
  assert.deepEqual(emptyAuthority.current.evidence_refs, []);
  assert.deepEqual(emptyAuthority.route_history, []);
  const forgedRationale = structuredClone(demandDecision.document);
  forgedRationale.information_gain_assessment = {
    rationale:
      "This prose claims updated independent counterevidence, but no formal Evidence closure exists.",
  };
  const forgedAuthority = deriveAssessmentInformationGainAuthority(
    entry(demandDecision.path, forgedRationale),
    new Map(
      [...baseDocuments(runId, plan, execution), ...results, ...judgmentEntries(results), gate].map(
        (document) => [document.path, document],
      ),
    ),
    new Map(),
  );
  assert.deepEqual(forgedAuthority, emptyAuthority);
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
        actor: "main_agent",
        decision_type: "scope_assumption_confirmed",
        confirmation_basis: "caller_attested_user_confirmation",
        harness_identity_verification: "not_available",
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

test("authorized Thesis provenance publishes, recovers a fault, and exactly replays", async (t) => {
  const state = await prepareCoreStoreRun(t, "provenance-publication");
  const assumed = concept(state.runId);
  const disclosure = "The acquisition hypothesis is an agent assumption authorized by the user.";
  const decisionRef = state.created.manifest.scope_confirmation_ref;
  const provenance = recordAt(
    assumed.field_provenance as Record<string, unknown>[],
    -1,
    "acquisition hypothesis provenance",
  );
  provenance.source_kind = "agent_assumed";
  provenance.confirmation_status = "user_authorized_assumption";
  provenance.basis_refs = [decisionRef];
  provenance.reporting_disclosure = disclosure;
  const request = compilationRequest(
    state.runId,
    [runtimeArtifact(conceptPath, assumed, "main_agent")],
    "compile_assumed_concept_publication_synthetic",
  );
  await assert.rejects(
    state.compiler.compile(request, { faultAt: "after_temp_write" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await state.store.load(state.runId);
  assert.deepEqual(reopened.recoveredArtifactPaths, [conceptPath]);
  const replay = await state.compiler.compile(request);
  assert.equal(replay.status, "idempotent_replay");
  assert.ok(replay.validation_closure.exact_record_count >= 1);
  assert.ok(replay.compiled_envelopes[0]?.input_refs.includes(decisionRef as string));
});

test("Assessment Evidence binds a current dispatch task and exact Evidence Store substrate", async (t) => {
  const state = await prepareStoreRun(t, "evidence");
  const execution = executionPlan(state.runId, state.plan);
  await state.compiler.compile(
    compilationRequest(
      state.runId,
      [runtimeArtifact(executionPath, execution, "main_agent")],
      "compile_execution_evidence_synthetic",
    ),
  );
  const dispatch = dispatchForStage(state.runId, execution, 0, null);
  await state.compiler.compile(
    compilationRequest(
      state.runId,
      [
        runtimeArtifact(executionPath, execution, "main_agent"),
        runtimeArtifact(dispatch.path, dispatch.document, "harness"),
      ],
      "compile_dispatch_evidence_synthetic",
    ),
  );
  const planUnit = (state.plan.waves as Record<string, unknown>[])
    .flatMap((wave) => wave.units as Record<string, unknown>[])
    .find((unit) => unit.unit_id === "unit_problem_evidence");
  assert.ok(planUnit);
  const substrate = (
    await new EvidenceStore(state.runsRoot).record({
      runId: state.runId,
      unitId: "unit_problem_evidence",
      researchGoal: String(planUnit.research_goal),
      source: {
        kind: "public_url",
        canonical_url: "https://assessment-evidence.synthetic.invalid/current-contract",
      },
      rawContent: "SYNTHETIC current Assessment Evidence bytes; not market Evidence.",
      recordedAt: createdAt,
    })
  ).record;
  const evidence = assessmentEvidence(state.runId, state.plan, dispatch, substrate);
  assert.equal(state.validator.validateDocument(evidence.document).valid, true);
  const exactRecords = new Map([
    [`evidence/manifest.jsonl#${substrate.evidence_id}`, substrate as Record<string, unknown>],
  ]);
  assert.deepEqual(
    contractCodes(
      [...baseDocuments(state.runId, state.plan, execution), dispatch, evidence],
      state.validator.assessmentExecutionPolicy,
      exactRecords,
    ),
    [],
  );
  const published = await state.compiler
    .compile(
      compilationRequest(
        state.runId,
        [runtimeArtifact(evidence.path, evidence.document, "lane_researcher")],
        "compile_assessment_evidence_synthetic",
      ),
    )
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
      }
      throw error;
    });
  assert.equal(published.status, "published");
  assert.equal(
    published.compiled_envelopes[0]?.schema_version,
    "startup_opportunity.artifact_envelope.current",
  );

  const reportPath = "artifacts/reporting/terminal-report-source.r1.json";
  const report = entry(reportPath, {
    schema_version: "startup_opportunity.terminal_report_source.v1",
    run_id: state.runId,
    sources: [{ evidence_ref: evidence.path }],
  });
  const bundleDocuments = [
    ...baseDocuments(state.runId, state.plan, execution),
    dispatch,
    evidence,
    report,
  ].map((document) => ({ path: document.path, document: document.document }));
  const currentEvidenceResult = state.validator.validateDocumentBundle({
    schema_version: "startup_opportunity.document_bundle.current",
    documents: bundleDocuments,
    exact_records: [
      { ref: `evidence/manifest.jsonl#${substrate.evidence_id}`, document: substrate },
    ],
  });
  assert.ok(
    !currentEvidenceResult.referenceErrors.some(
      (error) =>
        error.code === "reference.type_mismatch" &&
        error.instancePath === `${reportPath}#/sources/0/evidence_ref`,
    ),
    JSON.stringify(currentEvidenceResult.referenceErrors, null, 2),
  );

  const wrongTerminalSource = structuredClone(report.document);
  (wrongTerminalSource.sources as Record<string, unknown>[])[0] = {
    evidence_ref: conceptPath,
  };
  const wrongSourceResult = state.validator.validateDocumentBundle({
    schema_version: "startup_opportunity.document_bundle.current",
    documents: bundleDocuments.map((document) =>
      document.path === reportPath ? { path: reportPath, document: wrongTerminalSource } : document,
    ),
    exact_records: [
      { ref: `evidence/manifest.jsonl#${substrate.evidence_id}`, document: substrate },
    ],
  });
  assert.ok(
    wrongSourceResult.referenceErrors.some(
      (error) =>
        error.code === "reference.type_mismatch" &&
        error.instancePath === `${reportPath}#/sources/0/evidence_ref` &&
        error.details?.actualSchemaVersion ===
          "startup_opportunity.concept_hypothesis.assessment_intake.current",
    ),
    JSON.stringify(wrongSourceResult.referenceErrors, null, 2),
  );

  const wrongUnit = structuredClone(evidence.document);
  wrongUnit.unit_id = "unit_counter_risk";
  const wrongUnitCodes = contractCodes(
    [
      ...baseDocuments(state.runId, state.plan, execution),
      dispatch,
      entry(evidence.path, wrongUnit),
    ],
    state.validator.assessmentExecutionPolicy,
    exactRecords,
  );
  assert.ok(wrongUnitCodes.includes("assessment_execution.evidence_binding_invalid"));
  assert.ok(wrongUnitCodes.includes("assessment_execution.evidence_substrate_invalid"));

  const wrongBinding = structuredClone(evidence.document);
  (wrongBinding.mechanical_binding as Record<string, unknown>).operation_key =
    `sha256:${"0".repeat(64)}`;
  assert.ok(
    contractCodes(
      [
        ...baseDocuments(state.runId, state.plan, execution),
        dispatch,
        entry(evidence.path, wrongBinding),
      ],
      state.validator.assessmentExecutionPolicy,
      exactRecords,
    ).includes("assessment_execution.evidence_substrate_invalid"),
  );
});

test("Assessment Dispatch checklist registers every exact task fragment without a second Task contract", async (t) => {
  const state = await prepareStoreRun(t, "launch-checklist");
  const execution = executionPlan(state.runId, state.plan);
  const dispatch = dispatchForStage(state.runId, execution, 0, null);
  const compiled = await state.compiler.compile(
    compilationRequest(
      state.runId,
      [
        runtimeArtifact(executionPath, execution, "main_agent"),
        runtimeArtifact(dispatch.path, dispatch.document, "harness"),
      ],
      "compile_assessment_launch_checklist",
    ),
  );
  const checklist = compiled.dispatch_launch_checklists[0];
  assert.ok(checklist);
  assert.equal(checklist.status, "open");
  assert.ok(
    checklist.checklist.every(
      (item) =>
        item.task_ref === `${dispatch.path}#${item.task_id}` &&
        item.required_artifact_schema === "startup_opportunity.assessment_lane_result.v1" &&
        item.attempt === 1,
    ),
  );
  const registry = new DispatchLaunchRegistry(state.runsRoot, state.validator, repositoryRoot);
  const closed = await registry.register({
    schema_version: "startup_opportunity.dispatch_launch_registration_request.v1",
    request_id: "assessment_launch_registration",
    run_id: state.runId,
    dispatch_ref: dispatch.path,
    dispatch_hash: canonicalContentHash(dispatch.document),
    registered_at: "2026-08-02T16:00:01Z",
    registrations: checklist.checklist.map((item) => ({
      unit_id: item.unit_id,
      task_ref: item.task_ref,
      task_id: item.task_id,
      attempt: item.attempt,
      execution_attempt_id: `external_${item.unit_id}_attempt_1`,
    })),
  });
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.not_started_unit_ids, []);
  assert.deepEqual(closed.started_unit_ids, checklist.not_started_unit_ids);
});

test("Assessment gates close later units without directly making the Run terminal", async (t) => {
  const cases = [
    { outcome: "deprioritize", disposition: "opposes" },
    {
      outcome: "insufficient_evidence",
      disposition: "insufficient_evidence",
    },
    { outcome: "runtime_blocked", disposition: "insufficient_evidence" },
  ] as const;
  for (const item of cases) {
    const state = await prepareStoreRun(t, `terminal-${item.outcome}`);
    const execution = executionPlan(state.runId, state.plan);
    await state.compiler.compile(
      compilationRequest(
        state.runId,
        [runtimeArtifact(executionPath, execution, "main_agent")],
        `compile_execution_${item.outcome}`,
      ),
    );
    const dispatch = dispatchForStage(state.runId, execution, 0, null);
    await state.compiler.compile(
      compilationRequest(
        state.runId,
        [
          runtimeArtifact(executionPath, execution, "main_agent"),
          runtimeArtifact(dispatch.path, dispatch.document, "harness"),
        ],
        `compile_dispatch_${item.outcome}`,
      ),
    );
    const earlyStage = recordAt(
      execution.stages as Record<string, unknown>[],
      0,
      `${item.outcome} early stage`,
    );
    const failed = item.outcome === "runtime_blocked";
    const results = (earlyStage.lanes as Record<string, unknown>[]).map((selectedLane) =>
      resultForLane(
        state.runId,
        earlyStage,
        selectedLane,
        item.disposition,
        failed ? "failed" : "completed",
      ),
    );
    if (!failed) {
      await state.store.publishArtifactBundle({
        runId: state.runId,
        envelopes: judgmentEntries(results).map((judgment) =>
          v4Envelope(state.runId, judgment.path, judgment.document, [conceptPath]),
        ),
      });
    }
    await state.compiler.compile(
      compilationRequest(
        state.runId,
        results.map((result) => runtimeArtifact(result.path, result.document, "lane_researcher")),
        `compile_results_${item.outcome}`,
      ),
    );
    const gate = gateForStage(state.runId, execution, 0, results, item.outcome);
    const gateRequest = compilationRequest(
      state.runId,
      [runtimeArtifact(gate.path, gate.document, "main_agent")],
      `compile_gate_${item.outcome}`,
    );
    if (item.outcome === "deprioritize") {
      await assert.rejects(
        state.compiler.compile(gateRequest, { faultAt: "after_temp_write" }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      const reopened = await state.store.load(state.runId);
      assert.deepEqual(reopened.recoveredArtifactPaths, [gate.path]);
    } else {
      assert.equal((await state.compiler.compile(gateRequest)).status, "published");
    }
    const manifest = (await state.store.status(state.runId)).manifest;
    assert.equal(manifest.status, "researching");
    assert.deepEqual(manifest.skipped_units, ["unit_business_delivery", "unit_commercial"]);
    assert.equal((await state.compiler.compile(gateRequest)).status, "idempotent_replay");
    assert.deepEqual((await state.store.status(state.runId)).manifest, manifest);

    const forbiddenDispatch = dispatchForStage(state.runId, execution, 1, gate.path);
    await assert.rejects(
      state.compiler.compile(
        compilationRequest(
          state.runId,
          [runtimeArtifact(forbiddenDispatch.path, forbiddenDispatch.document, "harness")],
          `compile_forbidden_${item.outcome}`,
        ),
      ),
      (error: unknown) =>
        error instanceof StoreError && error.code === "runtime.compilation_validation_failed",
    );
    assert.deepEqual((await state.store.status(state.runId)).manifest, manifest);
  }
});

test("current Assessment compiler publishes, rejects mixed surfaces, recovers faults, and projects terminal staging", async (t) => {
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
    "startup_opportunity.artifact_envelope.current",
  );
  assert.equal(
    replay.validation_closure.document_bundle_schema_version,
    "startup_opportunity.document_bundle.current",
  );

  const mixed = compilationRequest(
    state.runId,
    [
      runtimeArtifact(conceptPath, state.hypothesis, "main_agent"),
      runtimeArtifact(
        "plans/discovery-execution.r1.json",
        {
          schema_version: "startup_opportunity.research_execution_plan.discovery.current",
          run_id: state.runId,
        },
        "main_agent",
      ),
    ],
    "compile_mixed_p2_synthetic",
  );
  await assert.rejects(
    state.compiler.compile(mixed),
    (error: unknown) =>
      error instanceof StoreError && error.code === "runtime.compilation_artifact_family_mixed",
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
      [
        runtimeArtifact(executionPath, execution, "main_agent"),
        runtimeArtifact(dispatch.path, dispatch.document, "harness"),
      ],
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
        runtimeArtifact(result.path, result.document, "lane_researcher"),
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

test("Assessment Lane delivery derives its Dispatch contract and atomically publishes one complete bundle", async (t) => {
  const state = await prepareStoreRun(t, "lane-delivery");
  const execution = executionPlan(state.runId, state.plan);
  const earlyStage = recordAt(execution.stages as Record<string, unknown>[], 0, "early stage");
  const selectedLane = recordAt(
    earlyStage.lanes as Record<string, unknown>[],
    0,
    "assessment lane",
  );
  const dispatch = dispatchForStage(state.runId, execution, 0, null);
  await state.compiler.compile(
    compilationRequest(
      state.runId,
      [
        runtimeArtifact(executionPath, execution, "main_agent"),
        runtimeArtifact(dispatch.path, dispatch.document, "harness"),
      ],
      "compile_assessment_lane_authority_synthetic",
    ),
  );
  const laneResult = resultForLane(
    state.runId,
    earlyStage,
    selectedLane,
    "insufficient_evidence",
    "failed",
  );
  const laneSemantics = structuredClone(laneResult.document);
  for (const field of [
    "schema_version",
    "lane_result_id",
    "run_id",
    "unit_id",
    "concept_hypothesis_ref",
    "execution_plan_ref",
    "stage_id",
  ])
    delete laneSemantics[field];
  const staging = {
    schema_version: "startup_opportunity.lane_staging_document.current",
    staging_id: "staging_assessment_lane_synthetic",
    run_id: state.runId,
    task_ref: `${dispatch.path}#task_${String(selectedLane.unit_id)}`,
    created_at: createdAt,
    producer_role: "lane_researcher",
    operation: "validate_only",
    evidence_receipt_refs: [],
    delivery_contract: {
      search_closure: {
        status: "completed",
        acquisition_routes_attempted: ["repository_source"],
        unresolved_gaps: ["No external research was performed."],
        stop_reason: "The deterministic contract fixture reached its bounded stop.",
      },
    },
    agent_documents: [{ artifact_family: "lane_result", document: laneSemantics }],
  };
  const materializer = new LaneResultMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const before = (await state.store.status(state.runId)).manifest;
  const validated = await materializer.materialize(staging);
  assert.equal(validated.compilation.status, "validated");
  assert.deepEqual((await state.store.status(state.runId)).manifest, before);
  assert.deepEqual(
    validated.delivery_receipt.document.assigned_scope,
    [...(selectedLane.reporting_dimensions as string[])].sort(),
  );
  assert.deepEqual(validated.delivery_receipt.document.assigned_subject_refs, [conceptPath]);
  const publish = structuredClone(staging);
  publish.operation = "publish";
  (publish as typeof publish & { publication_plan: unknown }).publication_plan =
    validated.compilation.publication_plan;
  const published = await materializer.materialize(publish);
  assert.equal(published.compilation.status, "published");
  assert.deepEqual(
    published.compilation.compiled_envelopes,
    validated.compilation.compiled_envelopes,
  );
  const replay = await materializer.materialize(publish);
  assert.equal(replay.compilation.status, "idempotent_replay");
  const reopened = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.ok(reopened.manifest.artifact_refs.includes(laneResult.path));
  assert.ok(reopened.manifest.artifact_refs.includes(published.delivery_receipt.artifact_path));
  const publishedLane = published.compilation.compiled_envelopes.find(
    (envelope) => envelope.artifact_path === laneResult.path,
  );
  assert.ok(publishedLane);
  for (const [field, semanticValue] of Object.entries(laneSemantics)) {
    assert.deepEqual(publishedLane.document[field], semanticValue, field);
  }
  assert.equal(publishedLane.document.lane_result_id, `result_${String(selectedLane.unit_id)}`);
  assert.equal(publishedLane.document.execution_plan_ref, executionPath);

  const unauthorizedAudit = structuredClone(staging);
  unauthorizedAudit.staging_id = "staging_assessment_unassigned_audit_synthetic";
  unauthorizedAudit.agent_documents.push({
    artifact_family: "commercial_audit",
    document: {
      schema_version: "startup_opportunity.commercial_research_delivery.current",
      run_id: state.runId,
      unit_id: selectedLane.unit_id,
    },
  });
  await assert.rejects(
    materializer.materialize(unauthorizedAudit),
    (error: unknown) =>
      error instanceof StoreError && error.code === "runtime.lane_staging_invalid",
  );
});

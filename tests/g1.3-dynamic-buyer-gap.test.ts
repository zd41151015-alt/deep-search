import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  canonicalExecutionStageCloseoutPath,
  canonicalJson,
  canonicalLaneLifecyclePath,
  createAdaptationPolicyValidator,
  createArtifactValidator,
  createAssessmentGapAnalyzer,
  createAssessmentPlanSemanticValidator,
  createPlanRevisionRuntime,
  DispatchLaunchRegistry,
  type DocumentBundle,
  deriveLaneSubmissionContract,
  type FormalArtifactEnvelope,
  type PlanApplyFaultBoundary,
  RunStore,
  StoreError,
  validateAssessmentAdaptationContract,
} from "../harness/src/index.js";
import { createFormalStageRuntimeCompiler } from "../harness/src/runtime/declarative-runtime.js";
import {
  assessmentCoverageKey,
  assessmentSnapshotCycleKey,
} from "../harness/src/validators/assessment-adaptation-identities.js";
import {
  addUnitDecision,
  bundleFromRun,
  candidateBundle,
  formalEnvelope,
  G13_ACQUISITION_BRANCH,
  G13_BUYER_BRANCH,
  type G13FixtureState,
  prepareG13Run,
  publishAdditionalG13Branch,
  stopDecision,
} from "./fixtures/g1.3/assessment-adaptation-fixture.js";
import { createConfirmedRun, publishInitialPlanBundle } from "./helpers/current-run.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const G13_PLAN_REF = "plans/research-plan.r1.json";
const G13_ASSESSMENT_PLAN_REF = "plans/concept-evidence-assessment-plan.r1.json";
const G13_CONTEXT_REF = "decision-context.json";
const G13_SCOPE_FRAME_REF = "scope-frame.json";
const G13_CONCEPT_REF = "concept-hypothesis.json";
const G13_DECISION_SUBJECT_SNAPSHOT_REF = "artifacts/reporting/decision-subject-snapshot.r1.json";
const G13_ASSESSMENT_DIMENSIONS = [
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function effectiveDocument(bundle: DocumentBundle, targetPath: string): Record<string, unknown> {
  const entry = bundle.documents.find((candidate) => candidate.path === targetPath);
  assert.ok(entry, `missing ${targetPath}`);
  const version = String(entry.document.schema_version);
  return version.startsWith("startup_opportunity.artifact_envelope.")
    ? (entry.document.document as Record<string, unknown>)
    : entry.document;
}

function refreshEnvelope(bundle: DocumentBundle, targetPath: string): void {
  const entry = bundle.documents.find((candidate) => candidate.path === targetPath);
  assert.ok(entry);
  if (String(entry.document.schema_version).startsWith("startup_opportunity.artifact_envelope.")) {
    entry.document.content_hash = canonicalContentHash(entry.document.document);
  }
}

function excludeFormalEvidence(
  terminal: Awaited<ReturnType<typeof prepareTerminalReporting>>,
  evidenceRefs: readonly string[],
): void {
  terminal.reportEnvelope.document.excluded_evidence = evidenceRefs.map((ref, index) => ({
    evidence_ref: ref,
    reason: `SYNTHETIC formal Evidence ${index + 1} is explicitly excluded from the terminal conclusion.`,
  }));
  terminal.reportEnvelope.document.audit_refs = [
    ...new Set([
      ...((terminal.reportEnvelope.document.audit_refs as string[]) ?? []),
      ...evidenceRefs,
    ]),
  ].sort();
  (terminal.reportEnvelope as unknown as { input_refs: string[] }).input_refs = [
    ...new Set([
      ...((terminal.reportEnvelope as unknown as { input_refs?: string[] }).input_refs ?? []),
      ...evidenceRefs,
    ]),
  ].sort();
  (terminal.reportEnvelope as { content_hash: string }).content_hash = canonicalContentHash(
    terminal.reportEnvelope.document,
  );
}

async function snapshotTree(root: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        snapshot[relative] = (await readFile(absolute)).toString("base64");
      }
    }
  };
  await visit(root);
  return Object.fromEntries(
    Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right)),
  );
}

const adaptationLifecycleFields = [
  "pending_adaptation_refs",
  "validated_adaptation_refs",
  "rejected_adaptation_refs",
  "applied_adaptation_refs",
] as const;

async function moveDecisionLifecycle(
  state: G13FixtureState,
  decisionRef: string,
  target: (typeof adaptationLifecycleFields)[number],
): Promise<void> {
  const manifestPath = path.join(state.runRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  for (const field of adaptationLifecycleFields) {
    const refs = manifest[field] as string[];
    manifest[field] = refs.filter((ref) => ref !== decisionRef);
  }
  manifest[target] = [...new Set([...(manifest[target] as string[]), decisionRef])].sort();
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
}

async function createGap(
  state: G13FixtureState,
  options: {
    readonly snapshotId?: string;
    readonly materialNewEvidenceObserved?: boolean;
    readonly bundle?: DocumentBundle;
    readonly branch?: typeof G13_BUYER_BRANCH | typeof G13_ACQUISITION_BRANCH;
    readonly createdAt?: string;
  } = {},
) {
  const currentBundle = options.bundle ?? (await bundleFromRun(state));
  const branch = options.branch ?? state.branch;
  const result = (await createAssessmentGapAnalyzer(repositoryRoot)).analyze({
    documentBundle: currentBundle,
    snapshotId:
      options.snapshotId ??
      (branch.unitId === "unit_acquisition" ? "acquisition-gap-current" : "buyer-gap-current"),
    createdAt: options.createdAt ?? "2026-07-25T16:21:00Z",
    triggerKind: "wave_completed",
    waveId: "assessment_wave_1",
    triggerEventRef: null,
    dimensionId: branch.dimensionId as
      | "buyer_language_and_willingness_to_pay"
      | "acquisition_and_distribution",
    observedArtifactRefs: [branch.outputPath],
    materialNewEvidenceObserved: options.materialNewEvidenceObserved ?? true,
    limitations: ["Synthetic fixture only; no external validation was performed."],
  });
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.ok(result.snapshotPath);
  assert.ok(result.snapshot);
  return { currentBundle, result };
}

async function publishGapAndDecision(
  state: G13FixtureState,
  kind: "add" | "stop" = "add",
  materialNewEvidenceObserved = true,
  branch?: typeof G13_BUYER_BRANCH | typeof G13_ACQUISITION_BRANCH,
) {
  const selectedBranch = branch ?? state.branch;
  const { result } = await createGap(state, {
    materialNewEvidenceObserved,
    branch: selectedBranch,
  });
  const gapPath = result.snapshotPath as string;
  const snapshot = result.snapshot as Record<string, unknown>;
  const gapEnvelope = formalEnvelope(
    state.runId,
    gapPath,
    snapshot,
    "startup_opportunity.artifact_envelope.current",
    "harness",
    (snapshot.gaps as Record<string, unknown>[])[0]?.basis_refs as readonly string[],
    "2026-07-25T16:21:00Z",
  );
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: gapEnvelope,
  });
  const decision =
    kind === "add"
      ? addUnitDecision(state.runId, gapPath, snapshot)
      : stopDecision(state.runId, gapPath, snapshot);
  const decisionEnvelope = formalEnvelope(
    state.runId,
    decision.path,
    decision.document,
    "startup_opportunity.artifact_envelope.current",
    "main_agent",
    [
      `${gapPath}#${String((snapshot.gaps as Record<string, unknown>[])[0]?.gap_id)}`,
      String(snapshot.based_on_plan_ref),
      String(snapshot.assessment_plan_ref),
      String(snapshot.subject_ref),
      String(snapshot.scope_frame_ref),
    ],
    "2026-07-25T16:22:00Z",
  );
  await state.store.publishArtifact({ runId: state.runId, envelope: decisionEnvelope });
  return {
    gapPath,
    snapshot,
    decision,
    gapEnvelope,
    decisionEnvelope,
    adaptationBundle: await bundleFromRun(state),
  };
}

async function publishRuntimeFailureGapAndDecision(state: G13FixtureState) {
  const { result } = await createGap(state, { materialNewEvidenceObserved: true });
  const gapPath = result.snapshotPath as string;
  const snapshot = result.snapshot as Record<string, unknown>;
  const runtimeGap = (snapshot.gaps as Record<string, unknown>[])[0];
  assert.ok(runtimeGap, JSON.stringify(snapshot, null, 2));
  const runtimeBlockedGap = {
    gap_id: String(runtimeGap.gap_id),
    coverage_key: String(runtimeGap.coverage_key),
    subject_ref: String(runtimeGap.subject_ref),
    dimension_id: String(runtimeGap.dimension_id),
    gap_type: "runtime_blocked",
    detection_mode: "deterministic",
    coverage_status: "insufficient",
    decision_impact: ["execution_validity"],
    severity: "blocking",
    research_goal: "The Run is blocked by a deterministic runtime failure.",
    basis_refs: [
      ...new Set(
        Array.isArray(runtimeGap.basis_refs)
          ? runtimeGap.basis_refs.filter((ref): ref is string => typeof ref === "string")
          : [G13_PLAN_REF],
      ),
    ].sort(),
    evidence_refs: [
      ...new Set(
        Array.isArray(runtimeGap.evidence_refs)
          ? runtimeGap.evidence_refs.filter((ref): ref is string => typeof ref === "string")
          : [],
      ),
    ].sort(),
    recommended_unit_type: null,
    followup_status: "stop",
    limitations: [
      ...new Set(
        Array.isArray(runtimeGap.limitations)
          ? runtimeGap.limitations.filter((entry): entry is string => typeof entry === "string")
          : [],
      ),
    ].sort(),
  };
  snapshot.gaps = [runtimeBlockedGap];
  snapshot.stop_signals = ["runtime_blocked"];
  const gapEnvelope = formalEnvelope(
    state.runId,
    gapPath,
    snapshot,
    "startup_opportunity.artifact_envelope.current",
    "harness",
    (runtimeGap.basis_refs as readonly string[]) ?? [G13_PLAN_REF],
    "2026-07-25T16:21:00Z",
  );
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: gapEnvelope,
  });
  const decision = runtimeFailureDecision(state.runId, gapPath, snapshot);
  const decisionEnvelope = formalEnvelope(
    state.runId,
    decision.path,
    decision.document,
    "startup_opportunity.artifact_envelope.current",
    "main_agent",
    [
      `${gapPath}#${String(runtimeGap.gap_id)}`,
      String(snapshot.based_on_plan_ref),
      String(snapshot.assessment_plan_ref),
      String(snapshot.subject_ref),
      String(snapshot.scope_frame_ref),
    ],
    "2026-07-25T16:22:00Z",
  );
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: decisionEnvelope,
  });
  return {
    gapPath,
    snapshot,
    decision,
    gapEnvelope,
    decisionEnvelope,
    adaptationBundle: await bundleFromRun(state),
  };
}

function runtimeFailureDecision(
  runId: string,
  gapPath: string,
  snapshot: Record<string, unknown>,
): { readonly path: string; readonly document: Record<string, unknown> } {
  const runtimeGap = (snapshot.gaps as Record<string, unknown>[]).find(
    (gap) => gap?.gap_type === "runtime_blocked",
  );
  assert.ok(runtimeGap, JSON.stringify(snapshot, null, 2));
  return {
    path: "adaptations/decisions/runtime-failure-terminal.json",
    document: {
      schema_version: "startup_opportunity.adaptation_decision.assessment.current",
      adaptation_id: "adapt_runtime_failure_terminal",
      run_id: runId,
      based_on_plan_ref: snapshot.based_on_plan_ref,
      based_on_plan_revision: snapshot.based_on_plan_revision,
      based_on_plan_hash: snapshot.based_on_plan_hash,
      assessment_plan_ref: snapshot.assessment_plan_ref,
      assessment_plan_revision: snapshot.assessment_plan_revision,
      assessment_plan_hash: snapshot.assessment_plan_hash,
      subject_ref: snapshot.subject_ref,
      scope_frame_ref: snapshot.scope_frame_ref,
      scope_frame_hash: snapshot.scope_frame_hash,
      trigger_gap_refs: [`${gapPath}#${String(runtimeGap.gap_id)}`],
      coverage_key: snapshot.coverage_key,
      action: "record_runtime_failure",
      reason: "The deterministic runtime blocker prevents the Run from completing.",
      expected_decision_impact: runtimeGap.decision_impact,
      stop_condition: "The blocking runtime failure remains unresolved.",
      requested_by: "main_agent",
      created_at: "2026-07-25T16:22:00Z",
    },
  };
}

function applyInput(
  state: G13FixtureState,
  prepared: Awaited<ReturnType<typeof publishGapAndDecision>>,
  candidate?: DocumentBundle,
  faultAt?: PlanApplyFaultBoundary,
) {
  return {
    runId: state.runId,
    adaptationBundle: prepared.adaptationBundle,
    adaptationRefs: [prepared.decision.path],
    ...(candidate === undefined ? {} : { candidateBundle: candidate }),
    createdAt: "2026-07-25T16:25:00Z",
    checkpointCreatedAt: "2026-07-25T16:26:00Z",
    nextStep: "Execute only the bounded buyer follow-up unit, or retain the closed limitation.",
    beliefSummary: {
      current_belief: "Only synthetic G1.3 mechanics have been exercised.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["No real market Evidence was collected."],
      remaining_disagreement: ["The buyer thesis remains unverified."],
      next_decision_relevant_question: "Does bounded real Evidence change the buyer assessment?",
    },
    ...(faultAt === undefined ? {} : { faultAt }),
  } as const;
}

async function prepareTerminalReporting(
  state: G13FixtureState,
  gapRef: string,
  decisionRef: string,
  generatedAt = "2026-07-25T16:25:30Z",
) {
  const baseBundle = await bundleFromRun(state);
  const decisionContext = effectiveDocument(baseBundle, G13_CONTEXT_REF);
  const scopeFrame = effectiveDocument(baseBundle, G13_SCOPE_FRAME_REF);
  const plan = effectiveDocument(baseBundle, G13_PLAN_REF);
  const snapshotDocument = {
    schema_version: "startup_opportunity.decision_subject_snapshot.current",
    snapshot_id: `decision_subjects_${state.runId.replaceAll("-", "_")}`,
    revision: 1,
    parent_snapshot_ref: null,
    parent_snapshot_hash: null,
    run_id: state.runId,
    mode: "concept_evidence_assessment",
    scope_frame_ref: G13_SCOPE_FRAME_REF,
    scope_frame_hash: canonicalContentHash(scopeFrame),
    research_plan_ref: G13_PLAN_REF,
    research_plan_hash: canonicalContentHash(plan),
    synthesis_input_hashes: [],
    created_at: generatedAt,
    subjects: [],
    limitations: [
      "SYNTHETIC empty authority: the Run stopped before any final decision subject formed.",
    ],
  };
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: formalEnvelope(
      state.runId,
      G13_DECISION_SUBJECT_SNAPSHOT_REF,
      snapshotDocument,
      "startup_opportunity.artifact_envelope.current",
      "main_agent",
      [G13_PLAN_REF, G13_SCOPE_FRAME_REF],
      generatedAt,
    ),
  });
  const snapshot = formalEnvelope(
    state.runId,
    G13_DECISION_SUBJECT_SNAPSHOT_REF,
    snapshotDocument,
    "startup_opportunity.artifact_envelope.current",
    "main_agent",
    [G13_PLAN_REF, G13_SCOPE_FRAME_REF],
    generatedAt,
  );
  const adaptationBundle = await bundleFromRun(state);
  const reportDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.terminal_report_source.v1",
    report_id: "terminal_report_runtime_1",
    run_id: state.runId,
    mode: "concept_evidence_assessment",
    research_language: "en-US",
    producer_role: "main_agent",
    owned_output_path: "artifacts/reporting/terminal-report-source.r1.json",
    materialized_path: "report.json",
    generated_at: generatedAt,
    decision_subject_snapshot_ref: snapshot.artifact_path,
    decision_subject_snapshot_hash: snapshot.content_hash,
    decision_subject_synthesis_hashes: [],
    current_decision_subject_ids: [],
    terminal_outcome: "failed",
    decision_question: String(
      decisionContext.decision_question ?? "Synthetic terminal assessment question.",
    ),
    execution: {
      completeness: "partial",
      completed_stages: ["第一轮评估"],
      incomplete_stages: [
        {
          stage: "评估综合",
          cause: "runtime_blocked",
          detail: "合成运行时故障阻止了后续执行。",
          conclusion_impact: "不能形成、排序或推荐任何机会方向。",
          related_refs: [gapRef],
        },
      ],
      required_followups: [
        {
          followup_id: "bounded_followup",
          status: "legally_closed",
          detail: "当前范围内的有界追加调研已经按最新缺口决定关闭。",
          related_refs: [gapRef],
        },
      ],
      pending_operation_refs: [],
    },
    research_conclusion: {
      outcome: "no_recommendation",
      current_recommendation: "本次运行失败，不能形成研究建议。",
      meaning: "运行问题阻止了完整执行，不能把失败解释为市场结论。",
      evidence_strength: "insufficient",
      allowed_claim: "本次运行在完成机会综合前失败。",
    },
    runtime_health: {
      status: "blocked",
      issues: [
        {
          code: "synthetic_runtime_failure",
          stage: "评估综合",
          detail: "合成运行时故障阻止了后续执行。",
          conclusion_impact: "不能形成、排序或推荐任何机会方向。",
          related_refs: [gapRef],
        },
      ],
    },
    directions: [],
    sources: [],
    excluded_evidence: [],
    commercial_research_audit_refs: [],
    commercial_uncertainties: [],
    quantitative_signal_rows: [],
    competitive_substitute_rows: [],
    incumbent_response_risk_rows: [],
    research_coverage_gaps: [],
    commercial_subject_aggregates: [],
    commercial_background_material: [],
    commercial_research_status: {
      state: "not_planned",
      planned_task_refs: [],
      missing_task_refs: [],
      submitted_audit_refs: [],
    },
    gate_warnings: [],
    ordered_validation_plan: [],
    freshness: {
      earliest_valid_as_of: null,
      latest_valid_as_of: null,
      summary: "合成 assessment fixture 没有引用市场材料。",
    },
    limitations: ["仅为合成合同测试；没有执行真实市场调研或外部验证。"],
    external_action_boundary: {
      execution_owner: "user",
      execution_supported: false,
      result_tracking_supported: false,
      external_validation_claimed: false,
    },
    audit_refs: [decisionRef, gapRef, G13_CONCEPT_REF, G13_PLAN_REF].sort(),
  };
  return {
    adaptationBundle,
    reportEnvelope: formalEnvelope(
      state.runId,
      "artifacts/reporting/terminal-report-source.r1.json",
      reportDocument,
      "startup_opportunity.artifact_envelope.current",
      "main_agent",
      [snapshot.artifact_path, decisionRef, gapRef, G13_CONCEPT_REF, G13_PLAN_REF],
      generatedAt,
    ),
  };
}

type AssessmentRuntimeMixedState = {
  readonly repositoryRoot: string;
  readonly runsRoot: string;
  readonly runRoot: string;
  readonly runId: string;
  readonly branch: typeof G13_BUYER_BRANCH;
  readonly store: RunStore;
  readonly validator: Awaited<ReturnType<typeof createArtifactValidator>>;
  readonly baseBundle: G13FixtureState["baseBundle"];
  readonly records: [];
};

function assessmentLaneContract(
  runId: string,
  unitId: string,
  taskId: string,
  outputPath: string,
): Record<string, unknown> {
  return deriveLaneSubmissionContract({
    runId,
    unitId,
    taskId,
    attempt: 1,
    formalOutputPath: outputPath,
    formalArtifactSchema: "startup_opportunity.assessment_lane_result.v1",
    commercialAuditOutputPath: null,
  });
}

function assessmentExecutionLane(
  runId: string,
  unitId: string,
  laneRole: "evidence" | "commercial" | "risk" | "feasibility" | "counter_evidence",
  dimensions: readonly string[],
  owner = false,
): Record<string, unknown> {
  const submissionPath = `artifacts/assessment/lanes/${unitId}.attempt-1.json`;
  return {
    unit_id: unitId,
    lane_role: laneRole,
    incumbent_response_assignment: {
      analysis_depth: owner ? "targeted_deep_dive" : "not_assigned",
      assignment_role: owner ? "owner" : "none",
      subject_refs: owner ? [G13_CONCEPT_REF] : [],
      rationale: "SYNTHETIC assessment runtime fixture only.",
    },
    reporting_dimensions: [...dimensions],
    submission_path: submissionPath,
    submission_schema: "startup_opportunity.assessment_lane_result.v1",
    lane_submission_contract: assessmentLaneContract(
      runId,
      unitId,
      `task_${unitId}`,
      submissionPath,
    ),
    time_budget_minutes: 15,
    max_sources: 10,
    straggler_policy: { on_timeout: "publish_partial", grace_minutes: 0, blocks_stage: false },
    dispatch_group: "assessment_runtime_mixed",
  };
}

function currentAssessmentConcept(runId: string): Record<string, unknown> {
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
    concept_hypothesis_id: "concept_assessment_runtime_mixed",
    scope_frame_ref: G13_SCOPE_FRAME_REF,
    product_thesis: "A synthetic workflow may reduce household coordination misses.",
    target_user: ["synthetic household coordinator"],
    buyer: ["synthetic household payer"],
    entry_scene: "A shared task needs confirmation.",
    claimed_value: "Reduce synthetic coordination omissions.",
    current_alternative: ["status quo"],
    delivery_form: "mobile_web",
    business_model: "subscription",
    acquisition_hypothesis: "A synthetic community distribution route.",
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

function currentAssessmentResearchUnit(
  unitId: string,
  unitType: string,
  outputPath: string,
  requiredArtifactSchema = "startup_opportunity.assessment_lane_result.v1",
  inputRefs: readonly string[] = [G13_CONCEPT_REF],
): Record<string, unknown> {
  return {
    unit_id: unitId,
    unit_type: unitType,
    plan_disposition: "enabled",
    priority_band: "normal",
    attempt: 1,
    supersedes_unit_ref: null,
    research_goal: `SYNTHETIC current Assessment goal for ${unitId}; no research is performed.`,
    input_refs: [...inputRefs],
    agent_role: "lane-researcher",
    output_path: outputPath,
    required_artifact_schema: requiredArtifactSchema,
    source_preferences: [],
    required_outputs:
      requiredArtifactSchema === "startup_opportunity.assessment_lane_result.v1"
        ? ["dimension_results"]
        : ["judgment_assessment_refs"],
    stop_conditions: ["Stop at the bounded synthetic fixture boundary."],
    ...(unitType === "bounded_domain_research" ? { lane_kind: unitId } : {}),
  };
}

function currentAssessmentResearchPlan(runId: string): Record<string, unknown> {
  const executionUnit = (unitId: string, unitType: string) =>
    currentAssessmentResearchUnit(
      unitId,
      unitType,
      `artifacts/assessment/lanes/${unitId}.attempt-1.json`,
    );
  const branchUnit = (unitId: string, unitType: string) =>
    currentAssessmentResearchUnit(
      unitId,
      unitType,
      `artifacts/lanes/${unitId}.json`,
      "startup_opportunity.concept_evidence_assessment_branch_result.v1",
      [G13_CONCEPT_REF, G13_ASSESSMENT_PLAN_REF],
    );
  return {
    schema_version: "startup_opportunity.research_plan.v1",
    plan_id: "plan_assessment_runtime_mixed",
    run_id: runId,
    mode: "concept_evidence_assessment",
    revision: 1,
    parent_plan_ref: null,
    triggered_by_adaptation_refs: [],
    created_at: "2026-07-25T16:01:00Z",
    research_questions: [
      {
        question_id: "rq_assessment_runtime_mixed",
        question: "Which current signals would change this synthetic concept decision?",
        decision_impact: "concept_assessment",
        uncertainty: "high",
        expected_information_gain: "high",
        stop_condition:
          "Each reporting dimension has one typed result or honest execution closeout.",
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
      {
        wave_id: "assessment_runtime_early_wave",
        depends_on: [],
        units: [
          branchUnit("unit_target_user_branch", "audience_pain"),
          branchUnit("unit_demand_branch", "jtbd_workflow"),
          branchUnit("unit_alternatives_branch", "solution_failure"),
          branchUnit("unit_compliance_branch", "compliance_risk"),
          branchUnit("unit_counter_branch", "counter_evidence"),
          executionUnit("unit_target_user", "bounded_domain_research"),
        ],
      },
      {
        wave_id: "assessment_runtime_mixed_wave",
        depends_on: ["assessment_runtime_early_wave"],
        units: [
          branchUnit("unit_competitor_branch", "competitor_gap"),
          branchUnit("unit_buyer_branch", "buyer_language"),
          branchUnit("unit_acquisition_branch", "acquisition"),
          executionUnit("unit_competitor", "competitor_gap"),
          executionUnit("unit_buyer", "buyer_language"),
          executionUnit("unit_acquisition", "acquisition"),
        ],
      },
      {
        wave_id: "assessment_runtime_delivery_wave",
        depends_on: ["assessment_runtime_mixed_wave"],
        units: [
          branchUnit("unit_business_branch", "business_engine"),
          branchUnit("unit_delivery_branch", "delivery_feasibility"),
          executionUnit("unit_business", "business_engine"),
        ],
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

function currentAssessmentExecutionRef(execution: Record<string, unknown>): string {
  return `plans/research-execution.r${String(execution.revision)}.json`;
}

function currentAssessmentExecution(
  runId: string,
  plan: Record<string, unknown>,
  revision = 1,
): Record<string, unknown> {
  const earlyGateRef = "artifacts/assessment/gates/runtime-early.r1.json";
  const commercialGateRef = "artifacts/assessment/gates/runtime-mixed.r1.json";
  const mixedStage = {
    stage_id: "assessment_runtime_mixed",
    stage_kind: "assessment_commercial",
    depends_on: ["assessment_runtime_early"],
    gate_before: earlyGateRef,
    gate_after: commercialGateRef,
    lanes: [
      assessmentExecutionLane(runId, "unit_competitor", "risk", [G13_ASSESSMENT_DIMENSIONS[3]]),
      assessmentExecutionLane(
        runId,
        "unit_buyer",
        "commercial",
        [G13_ASSESSMENT_DIMENSIONS[4]],
        true,
      ),
      assessmentExecutionLane(runId, "unit_acquisition", "commercial", [
        G13_ASSESSMENT_DIMENSIONS[5],
      ]),
    ],
  };
  return {
    schema_version: "startup_opportunity.research_execution_plan.assessment.current",
    execution_plan_id: "execution_assessment_runtime_mixed",
    run_id: runId,
    mode: "concept_evidence_assessment",
    revision,
    parent_execution_plan_ref:
      revision === 1 ? null : `plans/research-execution.r${String(revision - 1)}.json`,
    research_plan_ref: G13_PLAN_REF,
    research_plan_hash: canonicalContentHash(plan),
    concept_hypothesis_ref: G13_CONCEPT_REF,
    created_at: "2026-07-25T16:18:00Z",
    research_depth: "quick",
    total_time_budget_minutes: 45,
    resource_allocation: {
      customer_commercial_percent: 65,
      market_structure_percent: 17,
      academic_percent: 18,
    },
    followup_round: revision - 1,
    stages: [
      {
        stage_id: "assessment_runtime_early",
        stage_kind: "assessment_early_kill",
        depends_on: [],
        gate_before: null,
        gate_after: earlyGateRef,
        lanes: [
          assessmentExecutionLane(runId, "unit_target_user", "evidence", [
            G13_ASSESSMENT_DIMENSIONS[0],
            G13_ASSESSMENT_DIMENSIONS[1],
            G13_ASSESSMENT_DIMENSIONS[2],
            G13_ASSESSMENT_DIMENSIONS[8],
            G13_ASSESSMENT_DIMENSIONS[9],
          ]),
        ],
      },
      mixedStage,
      {
        stage_id: "assessment_runtime_delivery",
        stage_kind: "assessment_delivery",
        depends_on: ["assessment_runtime_mixed"],
        gate_before: commercialGateRef,
        gate_after: "artifacts/assessment/gates/runtime-delivery.r1.json",
        lanes: [
          assessmentExecutionLane(runId, "unit_business", "feasibility", [
            G13_ASSESSMENT_DIMENSIONS[6],
            G13_ASSESSMENT_DIMENSIONS[7],
          ]),
        ],
      },
    ],
    limitations: ["SYNTHETIC assessment current execution; no market research was performed."],
  };
}

function currentAssessmentDispatch(
  runId: string,
  execution: Record<string, unknown>,
  stageId = "assessment_runtime_mixed",
  gateRef: string | null = "artifacts/assessment/gates/runtime-early.r1.json",
  requestedAt = "2026-07-25T16:19:30Z",
): FormalArtifactEnvelope {
  const stage = (execution.stages as Record<string, unknown>[]).find(
    (candidate) => candidate.stage_id === stageId,
  );
  assert.ok(stage);
  const tasks = (stage.lanes as Record<string, unknown>[]).map((lane) => ({
    task_id: `task_${String(lane.unit_id)}`,
    unit_id: lane.unit_id,
    lane_role: lane.lane_role,
    incumbent_response_assignment: structuredClone(lane.incumbent_response_assignment),
    reporting_dimensions: lane.reporting_dimensions,
    submission_path: lane.submission_path,
    lane_submission_contract: lane.lane_submission_contract,
    time_budget_minutes: lane.time_budget_minutes,
    max_sources: lane.max_sources,
  }));
  const document = {
    schema_version: "startup_opportunity.dispatch_batch.assessment.current",
    dispatch_batch_id: `dispatch_${String(stage.stage_id)}`,
    run_id: runId,
    execution_plan_ref: currentAssessmentExecutionRef(execution),
    research_plan_ref: G13_PLAN_REF,
    stage_id: stage.stage_id,
    wave_id: `${String(stage.stage_id)}_wave`,
    gate_ref: gateRef,
    requested_at: requestedAt,
    dispatch_mode: "parallel_immediate",
    agent_dispatch_performed: false,
    launch_registration_required: true,
    tasks,
  };
  return formalEnvelope(
    runId,
    `tasks/dispatch/${String(stage.stage_id).replaceAll("_", "-")}.r1.json`,
    document,
    "startup_opportunity.artifact_envelope.current",
    "harness",
    [currentAssessmentExecutionRef(execution), G13_PLAN_REF],
    requestedAt,
  );
}

function currentAssessmentGate(
  runId: string,
  execution: Record<string, unknown>,
  stageId: string,
  results: readonly FormalArtifactEnvelope[],
): FormalArtifactEnvelope {
  const stages = execution.stages as Record<string, unknown>[];
  const stageIndex = stages.findIndex((candidate) => candidate.stage_id === stageId);
  const stage = stages[stageIndex];
  assert.ok(stage);
  const decisions = results.flatMap((result) =>
    (result.document.dimension_results as Record<string, unknown>[]).map((dimension) => ({
      dimension_id: dimension.dimension_id,
      lane_result_ref: result.artifact_path,
      decision: dimension.dimension_decision,
      decision_sufficiency: dimension.decision_sufficiency,
      decisive_refs: [],
    })),
  );
  const document = {
    schema_version: "startup_opportunity.assessment_stage_gate.v1",
    gate_id: `gate_${String(stage.stage_id)}`,
    run_id: runId,
    execution_plan_ref: currentAssessmentExecutionRef(execution),
    concept_hypothesis_ref: G13_CONCEPT_REF,
    stage_id: stage.stage_id,
    gate_kind: stageIndex === 0 ? "early_kill" : "commercial",
    evaluated_lane_refs: results.map((result) => result.artifact_path),
    dimension_decisions: decisions,
    outcome: "continue",
    thesis_killing_opposition: false,
    completed_stage_ids: stages.slice(0, stageIndex + 1).map((candidate) => candidate.stage_id),
    not_started_unit_ids: [],
    allowed_next_actions: ["continue_next_stage"],
    basis_refs: results.map((result) => result.artifact_path),
    rationale: "SYNTHETIC deterministic continue gate.",
    created_at: "2026-07-25T16:19:25Z",
    limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
  };
  return formalEnvelope(
    runId,
    String(stage.gate_after),
    document,
    "startup_opportunity.artifact_envelope.current",
    "main_agent",
    results.map((result) => result.artifact_path),
    "2026-07-25T16:19:25Z",
  );
}

function currentAssessmentLaneResult(
  runId: string,
  execution: Record<string, unknown>,
  unitId: string,
  dimensionDecision: "supports" | "insufficient_evidence" = "insufficient_evidence",
): FormalArtifactEnvelope {
  const stage = (execution.stages as Record<string, unknown>[]).find((candidate) =>
    (candidate.lanes as Record<string, unknown>[]).some((lane) => lane.unit_id === unitId),
  );
  assert.ok(stage);
  const lane = (stage.lanes as Record<string, unknown>[]).find(
    (candidate) => candidate.unit_id === unitId,
  );
  assert.ok(lane);
  const dimensions = lane.reporting_dimensions as string[];
  const document = {
    schema_version: "startup_opportunity.assessment_lane_result.v1",
    lane_result_id: `result_${unitId}`,
    run_id: runId,
    unit_id: unitId,
    concept_hypothesis_ref: G13_CONCEPT_REF,
    execution_plan_ref: currentAssessmentExecutionRef(execution),
    stage_id: stage.stage_id,
    status: "completed",
    dimension_results: dimensions.map((dimensionId, index) => ({
      dimension_id: dimensionId,
      evidence_refs: [],
      supporting_claim_refs: [],
      opposing_claim_refs: [],
      judgment_assessment_refs: [`judgments/${unitId}-${String(index)}.json`],
      coverage_disposition: "partial",
      dimension_decision: dimensionDecision,
      decision_sufficiency: dimensionDecision === "supports" ? "sufficient" : "insufficient",
      insufficiency_reasons: dimensionDecision === "supports" ? [] : ["no_signal"],
      what_would_change_decision: ["A bounded synthetic contract observation."],
      limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
    })),
    source_manifest_refs: [],
    limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
  };
  return formalEnvelope(
    runId,
    String(lane.submission_path),
    document,
    "startup_opportunity.artifact_envelope.current",
    "lane_researcher",
    [currentAssessmentExecutionRef(execution), G13_CONCEPT_REF],
    "2026-07-25T16:19:20Z",
  );
}

function currentAssessmentJudgmentEnvelopes(
  runId: string,
  result: FormalArtifactEnvelope,
): FormalArtifactEnvelope[] {
  return ((result.document.dimension_results as Record<string, unknown>[]) ?? []).map(
    (dimension, index) => {
      const ref = (dimension.judgment_assessment_refs as string[])[0];
      assert.ok(ref);
      const document = {
        schema_version: "startup_opportunity.judgment_assessment.assessment.current",
        run_id: runId,
        subject_ref: G13_CONCEPT_REF,
        dimension: dimension.dimension_id,
        judgment_id: `judgment_${String(result.document.unit_id)}_${String(index)}`,
        judgment_signal: "no_signal",
        evidence_tier_summary: [],
        supporting_claim_refs: [],
        opposing_claim_refs: [],
        representativeness: "SYNTHETIC contract judgment; not market Evidence.",
        independence: "SYNTHETIC contract judgment with no independence claim.",
        decision_sufficiency: "insufficient",
        insufficiency_reasons: ["no_signal"],
        what_would_change_the_decision: dimension.what_would_change_decision,
        valid_as_of: "2026-07-25",
        limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
      };
      return formalEnvelope(
        runId,
        ref,
        document,
        "startup_opportunity.artifact_envelope.current",
        "lane_researcher",
        [G13_CONCEPT_REF],
        "2026-07-25T16:19:10Z",
      );
    },
  );
}

async function latestLifecycleEnvelopeForUnit(
  runRoot: string,
  unitId: string,
): Promise<FormalArtifactEnvelope> {
  const manifest = JSON.parse(
    await readFile(path.join(runRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  const envelopes = await Promise.all(
    ((manifest.artifact_refs as string[]) ?? []).map(
      async (artifactRef) =>
        JSON.parse(
          await readFile(path.join(runRoot, artifactRef), "utf8"),
        ) as FormalArtifactEnvelope,
    ),
  );
  const lifecycles = envelopes
    .filter(
      (envelope) =>
        envelope.artifact_type === "startup_opportunity.lane_lifecycle.v1" &&
        envelope.document.unit_id === unitId,
    )
    .sort(
      (left, right) =>
        Number(left.document.revision) - Number(right.document.revision) ||
        left.artifact_path.localeCompare(right.artifact_path),
    );
  const lifecycle = lifecycles.at(-1);
  assert.ok(lifecycle, `missing lifecycle for ${unitId}`);
  return lifecycle;
}

function publishedLifecycleEnvelope(
  runId: string,
  lifecycle: FormalArtifactEnvelope,
  result: FormalArtifactEnvelope,
  publishedAt: string,
): FormalArtifactEnvelope {
  const document = structuredClone(lifecycle.document) as Record<string, unknown>;
  document.revision = Number(document.revision) + 1;
  document.parent_lifecycle_ref = lifecycle.artifact_path;
  document.state = "published";
  document.timestamps = {
    ...((document.timestamps as Record<string, unknown>) ?? {}),
    evidence_recorded_at: publishedAt,
    handoff_ready_at: publishedAt,
    formalization_validated_at: publishedAt,
    published_at: publishedAt,
    ended_at: null,
  };
  document.failure = null;
  document.limitations = [
    ...new Set([
      ...(((document.limitations as string[]) ?? []) as string[]),
      "SYNTHETIC lifecycle publication for completed Assessment lane fixture.",
    ]),
  ].sort();
  const artifactPath = canonicalLaneLifecyclePath(document, Number(document.revision));
  return formalEnvelope(
    runId,
    artifactPath,
    document,
    "startup_opportunity.artifact_envelope.current",
    "main_agent",
    [lifecycle.artifact_path, result.artifact_path],
    publishedAt,
  );
}

async function publishJudgments(
  store: RunStore,
  runId: string,
  envelopes: readonly FormalArtifactEnvelope[],
): Promise<void> {
  if (envelopes.length === 1) {
    await store.publishArtifact({ runId, envelope: envelopes[0] as FormalArtifactEnvelope });
    return;
  }
  await store.publishArtifactBundle({ runId, envelopes });
}

async function prepareAssessmentRuntimeMixedRun(
  context: TestContext,
  runId: string,
): Promise<AssessmentRuntimeMixedState> {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g1-3-current-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runRoot = path.join(runsRoot, runId);
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "concept_evidence_assessment",
    createdAt: "2026-07-25T16:00:00Z",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
  });
  const baseBundle = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "tests/fixtures/g1.1/valid-assess-contract-bundle.json"),
      "utf8",
    ),
  ) as G13FixtureState["baseBundle"];
  const initialPaths = new Set([
    "intake.json",
    G13_CONTEXT_REF,
    G13_SCOPE_FRAME_REF,
    G13_CONCEPT_REF,
    G13_PLAN_REF,
    G13_ASSESSMENT_PLAN_REF,
  ]);
  const runtimeConcept = currentAssessmentConcept(runId);
  const currentPlan = currentAssessmentResearchPlan(runId);
  await publishInitialPlanBundle(
    store,
    runId,
    baseBundle.documents
      .filter((entry) => initialPaths.has(entry.path))
      .map((entry) => {
        const document =
          entry.path === G13_CONCEPT_REF
            ? runtimeConcept
            : entry.path === G13_PLAN_REF
              ? currentPlan
              : { ...clone(entry.document), run_id: runId };
        return formalEnvelope(
          runId,
          entry.path,
          document,
          "startup_opportunity.artifact_envelope.current",
          "main_agent",
          [],
          "2026-07-25T16:01:00Z",
        );
      }),
    "assessment",
  );
  const planEnvelope = JSON.parse(
    await readFile(path.join(runRoot, G13_PLAN_REF), "utf8"),
  ) as FormalArtifactEnvelope;
  const executionDocument = currentAssessmentExecution(runId, planEnvelope.document, 1);
  const executionEnvelope = formalEnvelope(
    runId,
    currentAssessmentExecutionRef(executionDocument),
    executionDocument,
    "startup_opportunity.artifact_envelope.current",
    "main_agent",
    [G13_PLAN_REF, G13_CONCEPT_REF],
    "2026-07-25T16:18:00Z",
  );
  const compiler = createFormalStageRuntimeCompiler(runsRoot, validator, repositoryRoot);
  const earlyDispatchEnvelope = currentAssessmentDispatch(
    runId,
    executionDocument,
    "assessment_runtime_early",
    null,
    "2026-07-25T16:18:00Z",
  );
  await compiler.compile({
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: "request_g1_3_assessment_early_runtime",
    run_id: runId,
    operation: "publish",
    created_at: "2026-07-25T16:18:00Z",
    artifacts: [executionEnvelope, earlyDispatchEnvelope].map((envelope) => ({
      artifact_type: envelope.artifact_type,
      artifact_path: envelope.artifact_path,
      producer_role: envelope.producer_role,
      input_refs: envelope.input_refs,
      document: envelope.document,
    })),
  });
  const earlyRegistry = new DispatchLaunchRegistry(runsRoot, validator, repositoryRoot);
  const earlyChecklist = await earlyRegistry.check(
    runId,
    earlyDispatchEnvelope.artifact_path,
    earlyDispatchEnvelope.content_hash,
  );
  const earlyTask = earlyChecklist.checklist.find((entry) => entry.unit_id === "unit_target_user");
  assert.ok(earlyTask);
  await earlyRegistry.register({
    schema_version: "startup_opportunity.dispatch_launch_registration_request.v1",
    request_id: "launch_g1_3_assessment_early",
    run_id: runId,
    dispatch_ref: earlyDispatchEnvelope.artifact_path,
    dispatch_hash: earlyDispatchEnvelope.content_hash,
    registered_at: "2026-07-25T16:18:30Z",
    registrations: [
      {
        unit_id: earlyTask.unit_id,
        task_ref: earlyTask.task_ref,
        task_id: earlyTask.task_id,
        attempt: earlyTask.attempt,
        execution_attempt_id: "exec_g1_3_unit_target_user_attempt_1",
      },
    ],
  });
  const earlyResult = currentAssessmentLaneResult(
    runId,
    executionDocument,
    "unit_target_user",
    "supports",
  );
  await publishJudgments(store, runId, currentAssessmentJudgmentEnvelopes(runId, earlyResult));
  await compiler.compile({
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: "request_g1_3_assessment_early_result",
    run_id: runId,
    operation: "publish",
    created_at: "2026-07-25T16:19:20Z",
    artifacts: [
      {
        artifact_type: earlyResult.artifact_type,
        artifact_path: earlyResult.artifact_path,
        producer_role: earlyResult.producer_role,
        input_refs: earlyResult.input_refs,
        document: earlyResult.document,
      },
    ],
  });
  const earlyPublishedLifecycle = publishedLifecycleEnvelope(
    runId,
    await latestLifecycleEnvelopeForUnit(runRoot, "unit_target_user"),
    earlyResult,
    "2026-07-25T16:19:21Z",
  );
  await compiler.compile({
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: "request_g1_3_assessment_early_lifecycle_published",
    run_id: runId,
    operation: "publish",
    created_at: "2026-07-25T16:19:21Z",
    artifacts: [
      {
        artifact_type: earlyPublishedLifecycle.artifact_type,
        artifact_path: earlyPublishedLifecycle.artifact_path,
        producer_role: earlyPublishedLifecycle.producer_role,
        input_refs: earlyPublishedLifecycle.input_refs,
        document: earlyPublishedLifecycle.document,
      },
    ],
  });
  const earlyGate = currentAssessmentGate(runId, executionDocument, "assessment_runtime_early", [
    earlyResult,
  ]);
  await compiler.compile({
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: "request_g1_3_assessment_early_gate",
    run_id: runId,
    operation: "publish",
    created_at: "2026-07-25T16:19:25Z",
    artifacts: [
      {
        artifact_type: earlyGate.artifact_type,
        artifact_path: earlyGate.artifact_path,
        producer_role: earlyGate.producer_role,
        input_refs: earlyGate.input_refs,
        document: earlyGate.document,
      },
    ],
  });
  const executionDocumentR2 = currentAssessmentExecution(runId, planEnvelope.document, 2);
  const executionEnvelopeR2 = formalEnvelope(
    runId,
    currentAssessmentExecutionRef(executionDocumentR2),
    executionDocumentR2,
    "startup_opportunity.artifact_envelope.current",
    "main_agent",
    [
      G13_PLAN_REF,
      G13_CONCEPT_REF,
      currentAssessmentExecutionRef(executionDocument),
      earlyGate.artifact_path,
    ],
    "2026-07-25T16:19:28Z",
  );
  const dispatchEnvelope = currentAssessmentDispatch(runId, executionDocumentR2);
  await compiler.compile({
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: "request_g1_3_assessment_current_runtime",
    run_id: runId,
    operation: "publish",
    created_at: "2026-07-25T16:19:30Z",
    artifacts: [executionEnvelopeR2, dispatchEnvelope].map((envelope) => ({
      artifact_type: envelope.artifact_type,
      artifact_path: envelope.artifact_path,
      producer_role: envelope.producer_role,
      input_refs: envelope.input_refs,
      document: envelope.document,
    })),
  });
  const registry = new DispatchLaunchRegistry(runsRoot, validator, repositoryRoot);
  const checklist = await registry.check(
    runId,
    dispatchEnvelope.artifact_path,
    dispatchEnvelope.content_hash,
  );
  const acquisitionTask = checklist.checklist.find((entry) => entry.unit_id === "unit_acquisition");
  const buyerTask = checklist.checklist.find((entry) => entry.unit_id === "unit_buyer");
  assert.ok(acquisitionTask);
  assert.ok(buyerTask);
  await registry.register({
    schema_version: "startup_opportunity.dispatch_launch_registration_request.v1",
    request_id: "launch_g1_3_assessment_runtime_mixed",
    run_id: runId,
    dispatch_ref: dispatchEnvelope.artifact_path,
    dispatch_hash: dispatchEnvelope.content_hash,
    registered_at: "2026-07-25T16:19:30Z",
    registrations: [
      {
        unit_id: buyerTask.unit_id,
        task_ref: buyerTask.task_ref,
        task_id: buyerTask.task_id,
        attempt: buyerTask.attempt,
        execution_attempt_id: "exec_g1_3_unit_buyer_attempt_1",
      },
      {
        unit_id: acquisitionTask.unit_id,
        task_ref: acquisitionTask.task_ref,
        task_id: acquisitionTask.task_id,
        attempt: acquisitionTask.attempt,
        execution_attempt_id: "exec_g1_3_unit_acquisition_attempt_1",
      },
    ],
  });
  const manifestPath = path.join(runRoot, "manifest.json");
  let manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.completed_units = ["unit_target_user"];
  manifest.active_units = ["unit_acquisition", "unit_buyer"];
  manifest.failed_units = [];
  manifest.invalidated_units = [
    ...(((manifest.invalidated_units as string[]) ?? []) as string[]),
    "unit_competitor",
  ].sort();
  manifest.updated_at = "2026-07-25T16:19:35Z";
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
  const buyerResult = currentAssessmentLaneResult(runId, executionDocumentR2, "unit_buyer");
  await publishJudgments(store, runId, currentAssessmentJudgmentEnvelopes(runId, buyerResult));
  await compiler.compile({
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: "request_g1_3_assessment_buyer_result",
    run_id: runId,
    operation: "publish",
    created_at: "2026-07-25T16:19:40Z",
    artifacts: [
      {
        artifact_type: buyerResult.artifact_type,
        artifact_path: buyerResult.artifact_path,
        producer_role: buyerResult.producer_role,
        input_refs: buyerResult.input_refs,
        document: buyerResult.document,
      },
    ],
  });
  const buyerPublishedLifecycle = publishedLifecycleEnvelope(
    runId,
    await latestLifecycleEnvelopeForUnit(runRoot, "unit_buyer"),
    buyerResult,
    "2026-07-25T16:19:45Z",
  );
  await compiler.compile({
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: "request_g1_3_assessment_buyer_lifecycle_published",
    run_id: runId,
    operation: "publish",
    created_at: "2026-07-25T16:19:45Z",
    artifacts: [
      {
        artifact_type: buyerPublishedLifecycle.artifact_type,
        artifact_path: buyerPublishedLifecycle.artifact_path,
        producer_role: buyerPublishedLifecycle.producer_role,
        input_refs: buyerPublishedLifecycle.input_refs,
        document: buyerPublishedLifecycle.document,
      },
    ],
  });
  manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.status = "researching";
  manifest.current_phase = "assessment";
  manifest.completed_units = ["unit_buyer", "unit_target_user"];
  manifest.active_units = ["unit_acquisition"];
  manifest.failed_units = [];
  manifest.invalidated_units = [
    "unit_acquisition_branch",
    "unit_alternatives_branch",
    "unit_business",
    "unit_business_branch",
    "unit_buyer_branch",
    "unit_compliance_branch",
    "unit_counter_branch",
    "unit_delivery_branch",
    "unit_demand_branch",
    "unit_target_user_branch",
  ];
  manifest.updated_at = "2026-07-25T16:20:00Z";
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
  return {
    repositoryRoot,
    runsRoot,
    runRoot,
    runId,
    branch: G13_BUYER_BRANCH,
    store,
    validator,
    baseBundle,
    records: [],
  };
}

async function publishAssessmentRuntimeFailureAuthority(
  state: AssessmentRuntimeMixedState,
): Promise<Awaited<ReturnType<typeof publishRuntimeFailureGapAndDecision>>> {
  const planEnvelope = JSON.parse(
    await readFile(path.join(state.runRoot, G13_PLAN_REF), "utf8"),
  ) as FormalArtifactEnvelope;
  const assessmentPlanEnvelope = JSON.parse(
    await readFile(path.join(state.runRoot, G13_ASSESSMENT_PLAN_REF), "utf8"),
  ) as FormalArtifactEnvelope;
  const scopeFrameEnvelope = JSON.parse(
    await readFile(path.join(state.runRoot, G13_SCOPE_FRAME_REF), "utf8"),
  ) as FormalArtifactEnvelope;
  const gapPath = "adaptations/gap-snapshots/assessment-runtime-mixed.r1.json";
  const coverageKey = assessmentCoverageKey({
    schema_version: "startup_opportunity.assessment_coverage_identity.v1",
    run_id: state.runId,
    subject_ref: G13_CONCEPT_REF,
    scope_frame_ref: G13_SCOPE_FRAME_REF,
    scope_frame_hash: scopeFrameEnvelope.content_hash,
    research_plan_ref: G13_PLAN_REF,
    research_plan_revision: 1,
    research_plan_hash: planEnvelope.content_hash,
    assessment_plan_ref: G13_ASSESSMENT_PLAN_REF,
    assessment_plan_revision: 1,
    assessment_plan_hash: assessmentPlanEnvelope.content_hash,
    dimension_id: "acquisition_and_distribution",
    observed_artifacts: [],
  });
  const snapshotCycleKey = assessmentSnapshotCycleKey({
    coverage_key: coverageKey,
    trigger_kind: "wave_completed",
    wave_id: "assessment_runtime_mixed_wave",
    trigger_event_ref: null,
  });
  const snapshot: Record<string, unknown> = {
    schema_version: "startup_opportunity.gap_snapshot.assessment.current",
    snapshot_id: "assessment_runtime_mixed",
    snapshot_cycle_key: snapshotCycleKey,
    coverage_key: coverageKey,
    run_id: state.runId,
    based_on_plan_ref: G13_PLAN_REF,
    based_on_plan_revision: 1,
    based_on_plan_hash: planEnvelope.content_hash,
    assessment_plan_ref: G13_ASSESSMENT_PLAN_REF,
    assessment_plan_revision: 1,
    assessment_plan_hash: assessmentPlanEnvelope.content_hash,
    subject_ref: G13_CONCEPT_REF,
    scope_frame_ref: G13_SCOPE_FRAME_REF,
    scope_frame_hash: scopeFrameEnvelope.content_hash,
    revision: 1,
    parent_snapshot_ref: null,
    created_at: "2026-07-25T16:21:00Z",
    trigger_kind: "wave_completed",
    trigger_event_ref: null,
    phase: "assessment",
    wave_id: "assessment_runtime_mixed_wave",
    observed_artifacts: [],
    gaps: [
      {
        gap_id: "gap_assessment_runtime_mixed",
        coverage_key: coverageKey,
        subject_ref: G13_CONCEPT_REF,
        dimension_id: "acquisition_and_distribution",
        gap_type: "runtime_blocked",
        detection_mode: "deterministic",
        coverage_status: "insufficient",
        decision_impact: ["execution_validity"],
        severity: "blocking",
        research_goal:
          "The current Assessment execution is blocked by a deterministic runtime failure.",
        basis_refs: [
          G13_PLAN_REF,
          G13_ASSESSMENT_PLAN_REF,
          G13_CONCEPT_REF,
          G13_SCOPE_FRAME_REF,
          "tasks/dispatch/assessment-runtime-mixed.r1.json",
        ],
        evidence_refs: [],
        recommended_unit_type: null,
        followup_status: "stop",
        limitations: ["SYNTHETIC runtime blocker; not a market conclusion."],
      },
    ],
    material_new_evidence_observed: false,
    stop_signals: ["runtime_blocked"],
    limitations: ["SYNTHETIC assessment runtime failure authority."],
  };
  await state.store
    .publishArtifact({
      runId: state.runId,
      envelope: formalEnvelope(
        state.runId,
        gapPath,
        snapshot,
        "startup_opportunity.artifact_envelope.current",
        "harness",
        [
          G13_PLAN_REF,
          G13_ASSESSMENT_PLAN_REF,
          G13_CONCEPT_REF,
          G13_SCOPE_FRAME_REF,
          "tasks/dispatch/assessment-runtime-mixed.r1.json",
        ],
        "2026-07-25T16:21:00Z",
      ),
    })
    .catch((error: unknown) => {
      assert.fail(
        JSON.stringify(
          error instanceof Error && "details" in error
            ? (error as Error & { details?: unknown }).details
            : error,
          null,
          2,
        ),
      );
    });
  const decision = runtimeFailureDecision(state.runId, gapPath, snapshot);
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: formalEnvelope(
      state.runId,
      decision.path,
      decision.document,
      "startup_opportunity.artifact_envelope.current",
      "main_agent",
      [
        `${gapPath}#gap_assessment_runtime_mixed`,
        G13_PLAN_REF,
        G13_ASSESSMENT_PLAN_REF,
        G13_CONCEPT_REF,
        G13_SCOPE_FRAME_REF,
      ],
      "2026-07-25T16:22:00Z",
    ),
  });
  const manifestPath = path.join(state.runRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.latest_gap_snapshot_ref = gapPath;
  manifest.pending_adaptation_refs = [decision.path];
  manifest.updated_at = "2026-07-25T16:22:30Z";
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
  return {
    gapPath,
    snapshot,
    decision,
    gapEnvelope: {} as FormalArtifactEnvelope,
    decisionEnvelope: {} as FormalArtifactEnvelope,
    adaptationBundle: await bundleFromRun(state as unknown as G13FixtureState),
  };
}

test("G1.3 buyer Gap creates exact Research Plan r2 and assessment plan r2 atomically", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_buyer_add_001");
  const prepared = await publishGapAndDecision(state);
  const adaptationValidation = (
    await createAdaptationPolicyValidator(repositoryRoot)
  ).validateDocumentBundle(prepared.adaptationBundle);
  assert.equal(adaptationValidation.valid, true, JSON.stringify(adaptationValidation));
  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const candidateValidation = (
    await createAssessmentPlanSemanticValidator(repositoryRoot)
  ).validateDocumentBundle(candidate);
  assert.equal(candidateValidation.valid, true, JSON.stringify(candidateValidation));

  const basePlanBytes = await readFile(path.join(state.runRoot, "plans/research-plan.r1.json"));
  const baseAssessmentBytes = await readFile(
    path.join(state.runRoot, "plans/concept-evidence-assessment-plan.r1.json"),
  );
  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  const input = applyInput(state, prepared, candidate);
  const first = await runtime.apply(input).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }));
    }
    throw error;
  });
  assert.equal(first.status, "applied");
  assert.equal(first.revisionCreated, true);
  assert.equal(first.currentPlanRef, "plans/research-plan.r2.json");
  assert.equal(first.currentAssessmentPlanRef, "plans/concept-evidence-assessment-plan.r2.json");
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");

  assert.deepEqual(
    await readFile(path.join(state.runRoot, "plans/research-plan.r1.json")),
    basePlanBytes,
  );
  assert.deepEqual(
    await readFile(path.join(state.runRoot, "plans/concept-evidence-assessment-plan.r1.json")),
    baseAssessmentBytes,
  );
  const researchR2 = JSON.parse(
    await readFile(path.join(state.runRoot, "plans/research-plan.r2.json"), "utf8"),
  ) as Record<string, unknown>;
  const assessmentR2 = JSON.parse(
    await readFile(
      path.join(state.runRoot, "plans/concept-evidence-assessment-plan.r2.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(researchR2.schema_version, "startup_opportunity.artifact_envelope.current");
  assert.equal(assessmentR2.schema_version, "startup_opportunity.artifact_envelope.current");
  const reopened = await state.store.load(state.runId);
  assert.equal(reopened.manifest.current_plan_ref, "plans/research-plan.r2.json");
  assert.equal(reopened.manifest.plan_revision, 2);
});

test("assessment Scope reconciliation creates semantic-copy Plans and recovers after Manifest CAS", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_scope_reconcile_001");
  const beforeScope = await state.store.load(state.runId);
  const proposal = await state.store.proposeScope({
    runId: state.runId,
    expectedScopeRevision: 1,
    proposedAt: "2026-07-25T16:20:10Z",
    reason: "The user revised the assessment geography after the current unit completed.",
    scopeProposal: {
      geography: "Synthetic revised geography",
      customerModel: "b2c",
      targetUsers: ["synthetic revised assessment user"],
      decisionGoal: "reconcile the revised Scope without inventing assessment work",
      researchLanguage: "en-US",
    },
  });
  const confirmation = await state.store.confirmScope({
    runId: state.runId,
    expectedScopeProposalRevision: proposal.scopeRevision,
    expectedScopeProposalRef: proposal.scopeProposalRef,
    expectedScopeProposalHash: proposal.scopeProposalHash,
    confirmedAt: "2026-07-25T16:20:20Z",
    userConfirmationAttestation:
      "The fixture caller attests exact confirmation of the revised assessment Scope.",
  });
  const trigger = {
    schema_version: "startup_opportunity.event.v1",
    event_id: "assessment_scope_reconciliation_trigger",
    run_id: state.runId,
    event_type: "artifact_validation_failed",
    timestamp: "2026-07-25T16:20:30Z",
    actor: "harness",
    reason: "The current assessment Plan predates the confirmed Scope revision.",
    artifact_refs: [confirmation.scopeConfirmationRef],
  };
  await state.store.appendEvent(state.runId, trigger);
  const triggerRef = `events.jsonl#${trigger.event_id}`;
  const baseBundle = await bundleFromRun(state);
  const exactRecords = new Map(
    (baseBundle.exact_records ?? []).map((entry) => [entry.ref, entry.document]),
  );
  exactRecords.set(triggerRef, trigger);
  const analysis = (await createAssessmentGapAnalyzer(repositoryRoot)).analyze({
    documentBundle: { ...baseBundle, exact_records: [] },
    referenceContext: { exactJsonlRecords: exactRecords },
    snapshotId: "assessment-scope-reconciliation",
    createdAt: "2026-07-25T16:20:40Z",
    triggerKind: "resume_reconciliation",
    waveId: "assessment_wave_1",
    triggerEventRef: triggerRef,
    observedArtifactRefs: [],
    materialNewEvidenceObserved: false,
    limitations: ["Scope reconciliation adds no research Evidence."],
  });
  assert.equal(analysis.valid, true, JSON.stringify(analysis, null, 2));
  assert.ok(analysis.snapshot && analysis.snapshotPath);
  const snapshot = analysis.snapshot;
  const gap = (snapshot.gaps as Record<string, unknown>[])[0];
  assert.ok(gap);
  assert.match(String(gap.gap_id), /^gap_scope_alignment_[0-9a-f]{16}$/u);
  assert.equal(gap.dimension_id, "scope_alignment");
  assert.equal(gap.gap_type, "scope_invalidated");
  assert.deepEqual(snapshot.observed_artifacts, []);
  assert.ok((gap.basis_refs as string[]).includes(confirmation.scopeConfirmationRef));
  const gapEnvelope = formalEnvelope(
    state.runId,
    analysis.snapshotPath,
    snapshot,
    "startup_opportunity.artifact_envelope.current",
    "harness",
    [...(gap.basis_refs as string[]), triggerRef],
    "2026-07-25T16:20:40Z",
  );
  await state.store.publishArtifact({ runId: state.runId, envelope: gapEnvelope });

  const decision = {
    path: "adaptations/decisions/assessment-scope-reconciliation.json",
    document: {
      schema_version: "startup_opportunity.adaptation_decision.assessment.current",
      adaptation_id: "assessment_scope_reconciliation",
      run_id: state.runId,
      based_on_plan_ref: snapshot.based_on_plan_ref,
      based_on_plan_revision: snapshot.based_on_plan_revision,
      based_on_plan_hash: snapshot.based_on_plan_hash,
      assessment_plan_ref: snapshot.assessment_plan_ref,
      assessment_plan_revision: snapshot.assessment_plan_revision,
      assessment_plan_hash: snapshot.assessment_plan_hash,
      subject_ref: snapshot.subject_ref,
      scope_frame_ref: snapshot.scope_frame_ref,
      scope_frame_hash: snapshot.scope_frame_hash,
      trigger_gap_refs: [`${analysis.snapshotPath}#${String(gap.gap_id)}`],
      coverage_key: snapshot.coverage_key,
      action: "reconcile_scope",
      reason: "Rebind immutable Plan authority to the exact revised Scope.",
      expected_decision_impact: ["execution_validity"],
      requested_by: "main_agent",
      created_at: "2026-07-25T16:20:50Z",
    },
  };
  const decisionEnvelope = formalEnvelope(
    state.runId,
    decision.path,
    decision.document,
    "startup_opportunity.artifact_envelope.current",
    "main_agent",
    [analysis.snapshotPath, String(snapshot.based_on_plan_ref)],
    "2026-07-25T16:20:50Z",
  );
  await state.store.publishArtifact({ runId: state.runId, envelope: decisionEnvelope });
  const currentContext = JSON.parse(
    await readFile(path.join(state.runRoot, "plans/planning-context.r1.json"), "utf8"),
  ) as Record<string, unknown>;
  const assembled = await state.store.buildValidationContext(state.runId, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: analysis.snapshotPath, document: gapEnvelope },
      { path: decision.path, document: decisionEnvelope },
      { path: "plans/planning-context.r1.json", document: currentContext },
    ],
    exact_records: [],
  });
  const adaptationValidation = (
    await createAdaptationPolicyValidator(repositoryRoot)
  ).validateDocumentBundle(assembled.bundle, assembled.referenceContext);
  assert.equal(adaptationValidation.valid, true, JSON.stringify(adaptationValidation, null, 2));
  const semanticDrift = clone(assembled.bundle);
  const driftedSnapshot = effectiveDocument(semanticDrift, analysis.snapshotPath);
  driftedSnapshot.material_new_evidence_observed = true;
  const driftedGap = (driftedSnapshot.gaps as Record<string, unknown>[])[0];
  assert.ok(driftedGap);
  driftedGap.evidence_refs = [String(snapshot.subject_ref)];
  refreshEnvelope(semanticDrift, analysis.snapshotPath);
  const driftValidation = (await createArtifactValidator(repositoryRoot)).validateDocumentBundle(
    semanticDrift,
    assembled.referenceContext,
  );
  assert.ok(
    [
      ...driftValidation.bundleErrors,
      ...driftValidation.documents.flatMap((entry) => entry.errors),
      ...driftValidation.referenceErrors,
    ].some(
      (issue) => issue.code === "assessment_adaptation.scope_reconciliation_semantics_invalid",
    ),
  );
  const candidate = candidateBundle(assembled.bundle, decision);
  const candidateValidation = (
    await createAssessmentPlanSemanticValidator(repositoryRoot)
  ).validateDocumentBundle(candidate, assembled.referenceContext);
  assert.equal(candidateValidation.valid, true, JSON.stringify(candidateValidation, null, 2));

  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  const input = {
    runId: state.runId,
    adaptationBundle: assembled.bundle,
    adaptationRefs: [decision.path],
    candidateBundle: candidate,
    createdAt: "2026-07-25T16:25:00Z",
    checkpointCreatedAt: "2026-07-25T16:26:00Z",
    nextStep: "Resume only under the Scope-reconciled Plan authority.",
    beliefSummary: {
      current_belief: "Scope authority changed; research observations did not.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["No new Evidence was claimed by reconciliation."],
      remaining_disagreement: ["The assessment conclusion remains unchanged."],
      next_decision_relevant_question: "What future Evidence would change the assessment?",
    },
  } as const;
  await assert.rejects(
    runtime.apply({ ...input, faultAt: "after_manifest_update" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await state.store.load(state.runId);
  assert.equal(reopened.manifest.current_plan_ref, "plans/research-plan.r2.json");
  assert.equal(reopened.manifest.status, beforeScope.manifest.status);
  assert.equal(reopened.manifest.status_before_clarification, null);
  assert.equal(reopened.manifest.followup_round, beforeScope.manifest.followup_round);
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");
  const researchR1 = effectiveDocument(await bundleFromRun(state), "plans/research-plan.r1.json");
  const researchR2 = effectiveDocument(await bundleFromRun(state), "plans/research-plan.r2.json");
  assert.deepEqual(researchR2.waves, researchR1.waves);
  const assessmentR1 = effectiveDocument(
    await bundleFromRun(state),
    "plans/concept-evidence-assessment-plan.r1.json",
  );
  const assessmentR2 = effectiveDocument(
    await bundleFromRun(state),
    "plans/concept-evidence-assessment-plan.r2.json",
  );
  assert.deepEqual(assessmentR2.dimensions, assessmentR1.dimensions);
});

test("G1.3 exact Decision replay preserves every existing lifecycle state byte-for-byte", async (context) => {
  for (const [index, lifecycle] of [
    "pending_adaptation_refs",
    "validated_adaptation_refs",
    "rejected_adaptation_refs",
  ].entries()) {
    await context.test(lifecycle, async (subcontext) => {
      const state = await prepareG13Run(
        subcontext,
        repositoryRoot,
        `run_g1_3_decision_replay_${String(index + 1)}`,
      );
      const prepared = await publishGapAndDecision(state);
      await moveDecisionLifecycle(
        state,
        prepared.decision.path,
        lifecycle as (typeof adaptationLifecycleFields)[number],
      );
      const before = await snapshotTree(state.runRoot);

      const replay = await state.store.publishArtifact({
        runId: state.runId,
        envelope: prepared.decisionEnvelope,
      });

      assert.equal(replay.status, "idempotent_replay");
      assert.deepEqual(await snapshotTree(state.runRoot), before);
      const manifest = JSON.parse(
        await readFile(path.join(state.runRoot, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      for (const field of adaptationLifecycleFields) {
        assert.equal(
          (manifest[field] as string[]).includes(prepared.decision.path),
          field === lifecycle,
        );
      }
    });
  }
});

test("G1.3 current receipts recover interrupted Gap and Decision Manifest projection", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_receipt_replay_001");
  const { result } = await createGap(state);
  const gapPath = result.snapshotPath as string;
  const snapshot = result.snapshot as Record<string, unknown>;
  const gapEnvelope = formalEnvelope(
    state.runId,
    gapPath,
    snapshot,
    "startup_opportunity.artifact_envelope.current",
    "harness",
    (snapshot.gaps as Record<string, unknown>[])[0]?.basis_refs as readonly string[],
    "2026-07-25T16:21:00Z",
  );
  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: gapEnvelope,
      faultAt: "after_publish",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const beforeGapReplay = JSON.parse(
    await readFile(path.join(state.runRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.ok(!(beforeGapReplay.artifact_refs as string[]).includes(gapPath));
  assert.equal(beforeGapReplay.latest_gap_snapshot_ref, null);
  assert.equal(
    (await state.store.publishArtifact({ runId: state.runId, envelope: gapEnvelope })).status,
    "idempotent_replay",
  );

  const decision = addUnitDecision(state.runId, gapPath, snapshot);
  const decisionEnvelope = formalEnvelope(
    state.runId,
    decision.path,
    decision.document,
    "startup_opportunity.artifact_envelope.current",
    "main_agent",
    [
      `${gapPath}#${String((snapshot.gaps as Record<string, unknown>[])[0]?.gap_id)}`,
      String(snapshot.based_on_plan_ref),
      String(snapshot.assessment_plan_ref),
      String(snapshot.subject_ref),
      String(snapshot.scope_frame_ref),
    ],
    "2026-07-25T16:22:00Z",
  );
  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: decisionEnvelope,
      faultAt: "after_publish",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const beforeReopen = JSON.parse(
    await readFile(path.join(state.runRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.ok(!(beforeReopen.artifact_refs as string[]).includes(decision.path));
  assert.ok(!(beforeReopen.pending_adaptation_refs as string[]).includes(decision.path));

  const reopened = await state.store.load(state.runId);
  assert.equal(reopened.manifest.latest_gap_snapshot_ref, gapPath);
  assert.ok(reopened.manifest.pending_adaptation_refs.includes(decision.path));
  const operationDirectory = path.join(state.runRoot, ".store/operations");
  const receipts = await Promise.all(
    (await readdir(operationDirectory))
      .filter((entry) => entry.startsWith("artifact-") && entry.endsWith(".json"))
      .map(async (entry) =>
        JSON.parse(await readFile(path.join(operationDirectory, entry), "utf8")),
      ),
  );
  const controlReceipts = receipts.filter((receipt) =>
    [gapPath, decision.path].includes(String(receipt.artifact_path)),
  );
  assert.deepEqual(controlReceipts.map((receipt) => receipt.schema_version).sort(), [
    "startup_opportunity.artifact_store_operation.current",
    "startup_opportunity.artifact_store_operation.current",
  ]);
  const beforeExactReplay = await snapshotTree(state.runRoot);
  assert.equal(
    (await state.store.publishArtifact({ runId: state.runId, envelope: decisionEnvelope })).status,
    "idempotent_replay",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), beforeExactReplay);
});

test("G1.3 applied Decision replay is byte-stable through single, bundle, reopen, and conflict", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_applied_replay_001");
  const prepared = await publishGapAndDecision(state);
  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  assert.equal((await runtime.apply(applyInput(state, prepared, candidate))).status, "applied");
  const appliedManifest = (await state.store.load(state.runId)).manifest;
  assert.ok(appliedManifest.applied_adaptation_refs.includes(prepared.decision.path));
  assert.ok(!appliedManifest.pending_adaptation_refs.includes(prepared.decision.path));

  const initialBundleReplay = await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [prepared.gapEnvelope, prepared.decisionEnvelope],
  });
  assert.equal(initialBundleReplay.status, "idempotent_replay");
  const before = await snapshotTree(state.runRoot);

  const singleReplay = await state.store.publishArtifact({
    runId: state.runId,
    envelope: prepared.decisionEnvelope,
  });
  assert.equal(singleReplay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(state.runRoot), before);

  const bundleReplay = await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [prepared.gapEnvelope, prepared.decisionEnvelope],
  });
  assert.equal(bundleReplay.status, "idempotent_replay");
  assert.ok(bundleReplay.artifacts.every((artifact) => artifact.status === "idempotent_replay"));
  assert.deepEqual(await snapshotTree(state.runRoot), before);

  const reopened = await state.store.load(state.runId);
  assert.ok(reopened.manifest.applied_adaptation_refs.includes(prepared.decision.path));
  assert.ok(!reopened.manifest.pending_adaptation_refs.includes(prepared.decision.path));
  assert.deepEqual(await snapshotTree(state.runRoot), before);

  const conflictingDocument = {
    ...prepared.decisionEnvelope.document,
    reason: "Conflicting synthetic replay content must fail closed.",
  };
  const conflictingEnvelope = {
    ...prepared.decisionEnvelope,
    content_hash: canonicalContentHash(conflictingDocument),
    document: conflictingDocument,
  };
  await assert.rejects(
    state.store.publishArtifact({ runId: state.runId, envelope: conflictingEnvelope }),
    (error: unknown) => error instanceof StoreError && error.code === "write.conflict",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), before);
});

test("G1.3 historical Gap replay cannot replace a later latest Gap", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_gap_replay_001");
  await publishAdditionalG13Branch(state, G13_ACQUISITION_BRANCH);
  const historical = await publishGapAndDecision(state);
  const createdAt = "2026-07-25T16:25:00Z";
  const current = await createGap(state, {
    branch: G13_ACQUISITION_BRANCH,
    snapshotId: "acquisition-gap-latest",
    createdAt,
  });
  const currentPath = current.result.snapshotPath as string;
  const currentSnapshot = current.result.snapshot as Record<string, unknown>;
  const currentEnvelope = formalEnvelope(
    state.runId,
    currentPath,
    currentSnapshot,
    "startup_opportunity.artifact_envelope.current",
    "harness",
    (currentSnapshot.gaps as Record<string, unknown>[])[0]?.basis_refs as readonly string[],
    createdAt,
  );
  await state.store.publishArtifact({ runId: state.runId, envelope: currentEnvelope });
  assert.equal((await state.store.load(state.runId)).manifest.latest_gap_snapshot_ref, currentPath);

  const initialBundleReplay = await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [historical.gapEnvelope, historical.decisionEnvelope],
  });
  assert.equal(initialBundleReplay.status, "idempotent_replay");
  const before = await snapshotTree(state.runRoot);

  const singleReplay = await state.store.publishArtifact({
    runId: state.runId,
    envelope: historical.gapEnvelope,
  });
  assert.equal(singleReplay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(state.runRoot), before);

  const bundleReplay = await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [historical.gapEnvelope, historical.decisionEnvelope],
  });
  assert.equal(bundleReplay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(state.runRoot), before);

  const reopened = await state.store.load(state.runId);
  assert.equal(reopened.manifest.latest_gap_snapshot_ref, currentPath);
  assert.deepEqual(await snapshotTree(state.runRoot), before);
});

test("G1.3 acquisition Gap maps only to a bounded acquisition add_unit", async (context) => {
  const state = await prepareG13Run(
    context,
    repositoryRoot,
    "run_g1_3_acquisition_add_001",
    G13_ACQUISITION_BRANCH,
  );
  const prepared = await publishGapAndDecision(state);
  const gap = (prepared.snapshot.gaps as Record<string, unknown>[])[0];
  assert.equal(gap?.gap_type, "acquisition_evidence_insufficient");
  assert.equal(gap?.recommended_unit_type, "acquisition");
  assert.equal(
    (prepared.decision.document.target_unit as Record<string, unknown>).unit_type,
    "acquisition",
  );
  const validation = (await createAdaptationPolicyValidator(repositoryRoot)).validateDocumentBundle(
    prepared.adaptationBundle,
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));
  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const candidateValidation = (
    await createAssessmentPlanSemanticValidator(repositoryRoot)
  ).validateDocumentBundle(candidate);
  assert.equal(candidateValidation.valid, true, JSON.stringify(candidateValidation));
});

test("G1.3 historical Gap and Decision remain valid only through complete Plan ancestry", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_deep_ancestry_001");
  const prepared = await publishGapAndDecision(state);
  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  assert.equal((await runtime.apply(applyInput(state, prepared, candidate))).status, "applied");

  const persisted = await bundleFromRun(state);
  const documents = persisted.documents.map((entry) => {
    const envelopeVersion = String(entry.document.schema_version);
    return envelopeVersion.startsWith("startup_opportunity.artifact_envelope.")
      ? {
          path: entry.path,
          schemaVersion: String(entry.document.artifact_type),
          document: entry.document.document as Record<string, unknown>,
        }
      : {
          path: entry.path,
          schemaVersion: envelopeVersion,
          document: entry.document,
        };
  });
  const manifest = documents.find((entry) => entry.path === "manifest.json");
  const researchR2 = documents.find((entry) => entry.path === "plans/research-plan.r2.json");
  assert.ok(manifest);
  assert.ok(researchR2);
  const researchR3 = clone(researchR2.document);
  researchR3.revision = 3;
  researchR3.parent_plan_ref = researchR2.path;
  researchR3.triggered_by_adaptation_refs = ["adaptations/decisions/synthetic-r3.json"];
  manifest.document.current_plan_ref = "plans/research-plan.r3.json";
  manifest.document.plan_revision = 3;
  const deepAncestry = [
    ...documents,
    {
      path: "plans/research-plan.r3.json",
      schemaVersion: "startup_opportunity.research_plan.v1",
      document: researchR3,
    },
  ];
  assert.deepEqual(validateAssessmentAdaptationContract(deepAncestry), []);

  const branched = clone(deepAncestry);
  const branchedR3 = branched.find((entry) => entry.path === "plans/research-plan.r3.json");
  assert.ok(branchedR3);
  branchedR3.document.parent_plan_ref = "plans/research-plan.r1.json";
  const errors = validateAssessmentAdaptationContract(branched);
  assert.ok(errors.some((error) => error.code === "assessment_adaptation.plan_stale"));
  assert.ok(
    errors.some((error) => error.code === "assessment_adaptation.decision_binding_mismatch"),
  );
});

test("G1.3 assessment_gap_analysis_input.v1 is wired through Harness and Skill CLI", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_cli_gap_001");
  const inputFile = path.join(path.dirname(state.runsRoot), "assessment-gap-input.json");
  await writeFile(
    inputFile,
    `${canonicalJson({
      schema_version: "startup_opportunity.assessment_gap_analysis_input.v1",
      document_bundle: await bundleFromRun(state),
      snapshot_id: "buyer-gap-cli",
      created_at: "2026-07-25T16:21:00Z",
      trigger_kind: "wave_completed",
      wave_id: "assessment_wave_1",
      trigger_event_ref: null,
      dimension_id: "buyer_language_and_willingness_to_pay",
      observed_artifact_refs: [G13_BUYER_BRANCH.outputPath],
      material_new_evidence_observed: true,
      limitations: ["Synthetic CLI fixture only; no external validation was performed."],
    })}\n`,
  );
  for (const script of [
    "harness/src/cli.ts",
    ".agents/skills/startup-opportunity/scripts/analyze-gaps.ts",
  ]) {
    const args = ["--import", "tsx", script];
    if (script === "harness/src/cli.ts") {
      args.push("analyze-gaps");
    }
    args.push("--file", inputFile);
    const result = spawnSync(process.execPath, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    const output = JSON.parse(result.stdout) as {
      valid?: boolean;
      snapshot?: { schema_version?: string };
    };
    assert.equal(output.valid, true);
    assert.equal(
      output.snapshot?.schema_version,
      "startup_opportunity.gap_snapshot.assessment.current",
    );
  }
});

test("G1.3 no-new-Evidence stop_followup closes without an unbounded revision", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_stop_001");
  const prepared = await publishGapAndDecision(state, "stop", false);
  const gap = (prepared.snapshot.gaps as Record<string, unknown>[])[0];
  assert.equal(gap?.gap_type, "no_material_new_evidence");
  assert.equal(gap?.followup_status, "stop");
  const validation = (await createAdaptationPolicyValidator(repositoryRoot)).validateDocumentBundle(
    prepared.adaptationBundle,
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));

  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  const input = applyInput(state, prepared);
  const result = await runtime.apply(input);
  assert.equal(result.revisionCreated, false);
  assert.equal(result.currentPlanRef, "plans/research-plan.r1.json");
  assert.equal(result.currentAssessmentPlanRef, "plans/concept-evidence-assessment-plan.r1.json");
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");
  await assert.rejects(readFile(path.join(state.runRoot, "plans/research-plan.r2.json")));
  await assert.rejects(
    readFile(path.join(state.runRoot, "plans/concept-evidence-assessment-plan.r2.json")),
  );
});

test("G1.3 runtime failure with no active assessment units is terminal and replay-safe", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_runtime_failure_001");

  const preStatus = await state.store.status(state.runId);
  assert.deepEqual(preStatus.manifest.active_units, [], JSON.stringify(preStatus, null, 2));
  assert.deepEqual(
    preStatus.manifest.completed_units,
    ["unit_buyer"],
    JSON.stringify(preStatus, null, 2),
  );
  assert.equal(preStatus.observability.laneTimings.length, 0, JSON.stringify(preStatus, null, 2));

  const validator = await createAdaptationPolicyValidator(repositoryRoot);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  const prepared = await publishRuntimeFailureGapAndDecision(state);
  const runtimeGap = prepared.snapshot.gaps as Record<string, unknown>[];
  assert.equal(
    runtimeGap[0]?.gap_type,
    "runtime_blocked",
    JSON.stringify(prepared.snapshot, null, 2),
  );
  assert.deepEqual(
    prepared.snapshot.stop_signals,
    ["runtime_blocked"],
    JSON.stringify(prepared.snapshot, null, 2),
  );
  const terminal = await prepareTerminalReporting(state, prepared.gapPath, prepared.decision.path);
  excludeFormalEvidence(
    terminal,
    state.records.map((record) => `evidence/records/${record.evidence_id}.json`),
  );
  const runtimeBundle = terminal.adaptationBundle;
  const runtimeDecision = effectiveDocument(runtimeBundle, prepared.decision.path);
  assert.equal(runtimeDecision.action, "record_runtime_failure");

  const validation = validator.validateDocumentBundle(runtimeBundle);
  assert.equal(validation.valid, true, JSON.stringify(validation, null, 2));

  const invalidBundle = clone(runtimeBundle);
  const invalidGap = (
    effectiveDocument(invalidBundle, prepared.gapPath).gaps as Record<string, unknown>[]
  )[0];
  assert.ok(invalidGap, JSON.stringify(invalidBundle, null, 2));
  invalidGap.gap_type = "buyer_evidence_insufficient";
  invalidGap.coverage_status = "insufficient";
  invalidGap.followup_status = "executable";
  invalidGap.recommended_unit_type = "buyer_language";
  invalidGap.severity = "blocking";
  invalidGap.research_goal =
    "Resolve current buyer_language_and_willingness_to_pay decision coverage for the frozen concept.";
  effectiveDocument(invalidBundle, prepared.gapPath).stop_signals = [];
  refreshEnvelope(invalidBundle, prepared.gapPath);
  const invalidValidation = validator.validateDocumentBundle(invalidBundle);
  assert.ok(
    invalidValidation.adaptationErrors.some(
      (error) => error.code === "adaptation.runtime_failure_basis_missing",
    ),
    JSON.stringify(invalidValidation, null, 2),
  );
  const input = {
    runId: state.runId,
    adaptationBundle: runtimeBundle,
    adaptationRefs: [prepared.decision.path],
    terminalReportEnvelope: terminal.reportEnvelope,
    createdAt: "2026-07-25T16:26:00Z",
    checkpointCreatedAt: "2026-07-25T16:27:00Z",
    nextStep: "Treat the runtime blocker as terminal for the current Run only.",
    beliefSummary: {
      current_belief: "The current assessment Run hit a deterministic runtime blocker.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Can a repaired runtime start a new Run?",
    },
  } as const;
  const first = await runtime.apply(input);
  assert.equal(first.status, "applied", JSON.stringify(first, null, 2));
  assert.equal(first.terminalReport?.status, "published", JSON.stringify(first, null, 2));
  assert.equal(
    (await runtime.apply(input)).status,
    "idempotent_replay",
    JSON.stringify(first, null, 2),
  );

  const status = await state.store.status(state.runId);
  assert.equal(status.manifest.status, "failed", JSON.stringify(status, null, 2));
  assert.deepEqual(status.manifest.active_units, [], JSON.stringify(status, null, 2));
  assert.deepEqual(
    status.manifest.completed_units,
    ["unit_buyer"],
    JSON.stringify(status, null, 2),
  );
  assert.deepEqual(status.manifest.failed_units, [], JSON.stringify(status, null, 2));
  assert.deepEqual(
    [...status.manifest.invalidated_units].sort(),
    [
      "unit_acquisition",
      "unit_alternatives",
      "unit_business",
      "unit_competitor",
      "unit_compliance",
      "unit_counter",
      "unit_delivery",
      "unit_demand",
      "unit_target_user",
    ],
    JSON.stringify(status, null, 2),
  );
  assert.deepEqual(status.manifest.pending_adaptation_refs, [], JSON.stringify(status, null, 2));
  assert.equal(status.terminalReportDisposition, "ready", JSON.stringify(status, null, 2));
  assert.deepEqual(status.terminalReportIssues, [], JSON.stringify(status, null, 2));
  assert.equal(status.resumeContext.status, "failed", JSON.stringify(status, null, 2));
  assert.equal(status.observability.stageTimings.length, 1, JSON.stringify(status, null, 2));
  assert.equal(status.observability.stageTimings[0]?.state, "failed");
  assert.equal(status.observability.stageTimings[0]?.failureKind, "runtime_blocked");
  assert.equal(
    status.observability.stageTimings[0]?.endedAt,
    "2026-07-25T16:26:00Z",
    JSON.stringify(status, null, 2),
  );
  assert.ok(
    typeof status.observability.stageTimings[0]?.durationMs === "number" &&
      status.observability.stageTimings[0].durationMs > 0,
    JSON.stringify(status, null, 2),
  );
  assert.equal(status.observability.failureClassifications.runtime_blocked, 1);
  assert.equal(status.observability.laneTimings.length, 0, JSON.stringify(status, null, 2));
  assert.ok(
    !status.observability.blockingReasons.includes("terminal_reporting.search_closure_incomplete"),
    JSON.stringify(status, null, 2),
  );
  const publishedEnvelopes = await Promise.all(
    status.manifest.artifact_refs.map(
      async (artifactRef) =>
        JSON.parse(
          await readFile(path.join(state.runRoot, artifactRef), "utf8"),
        ) as FormalArtifactEnvelope,
    ),
  );
  assert.equal(
    publishedEnvelopes.filter(
      (envelope) =>
        envelope.artifact_type === "startup_opportunity.discovery_stage_readiness.v1" &&
        envelope.document.stop_basis === "runtime_blocked",
    ).length,
    0,
  );
  assert.equal(
    publishedEnvelopes.filter(
      (envelope) =>
        envelope.artifact_type === "startup_opportunity.assessment_stage_gate.v1" &&
        envelope.document.outcome === "runtime_blocked" &&
        Array.isArray(envelope.document.evaluated_lane_refs) &&
        envelope.document.evaluated_lane_refs.length === 0,
    ).length,
    0,
  );
  const stageCloseouts = publishedEnvelopes.filter(
    (envelope) => envelope.artifact_type === "startup_opportunity.execution_stage_closeout.v1",
  );
  assert.equal(stageCloseouts.length, 1, JSON.stringify(stageCloseouts, null, 2));
  const stageCloseout = stageCloseouts[0];
  assert.ok(stageCloseout);
  assert.equal(
    stageCloseout.artifact_path,
    canonicalExecutionStageCloseoutPath(stageCloseout.document),
  );
  assert.equal(stageCloseout.created_at, "2026-07-25T16:26:00Z");
  assert.equal(stageCloseout.producer_role, "harness");
  assert.equal(stageCloseout.document.run_id, state.runId);
  assert.equal(stageCloseout.document.execution_plan_ref, "plans/research-execution.r1.json");
  assert.equal(stageCloseout.document.stage_id, "commercial_research");
  assert.equal(stageCloseout.document.stage_state, "failed");
  assert.equal((stageCloseout.document.failure as Record<string, unknown>).kind, "runtime_blocked");
  assert.equal((stageCloseout.document.failure as Record<string, unknown>).retryable, false);
  assert.deepEqual(stageCloseout.document.started_unit_ids, ["unit_buyer"]);
  assert.deepEqual(stageCloseout.document.completed_unit_ids, ["unit_buyer"]);
  assert.deepEqual(stageCloseout.document.failed_unit_ids, []);
  assert.deepEqual(stageCloseout.document.incomplete_unit_ids, []);
  assert.deepEqual(stageCloseout.document.not_started_unit_ids, []);
  const dispositions = stageCloseout.document.unit_dispositions as Record<string, unknown>[];
  assert.equal(dispositions.length, 1, JSON.stringify(stageCloseout, null, 2));
  assert.equal(dispositions[0]?.unit_id, "unit_buyer");
  assert.equal(dispositions[0]?.disposition, "completed");
  assert.equal(dispositions[0]?.lifecycle_ref, null);
  assert.equal(dispositions[0]?.lifecycle_hash, null);
  const basisRefs = stageCloseout.document.basis_refs as string[];
  const runtimeGapEntry = (prepared.snapshot.gaps as Record<string, unknown>[])[0];
  assert.ok(runtimeGapEntry);
  const gapRef = `${prepared.gapPath}#${String(runtimeGapEntry.gap_id)}`;
  assert.ok(basisRefs.includes(gapRef), JSON.stringify(stageCloseout, null, 2));
  assert.ok(basisRefs.includes(prepared.decision.path), JSON.stringify(stageCloseout, null, 2));
  assert.ok(
    basisRefs.includes("tasks/dispatch/commercial-research.r1.json"),
    JSON.stringify(stageCloseout, null, 2),
  );
});

test("G1.3 runtime failure closes true current Assessment mixed stage dispositions", async (context) => {
  const state = await prepareAssessmentRuntimeMixedRun(
    context,
    "run-g1-3-runtime-failure-current-mixed",
  );
  const preStatus = await state.store.status(state.runId);
  assert.deepEqual(
    [...preStatus.manifest.completed_units].sort(),
    ["unit_buyer", "unit_target_user"],
    JSON.stringify(preStatus),
  );
  assert.deepEqual(
    preStatus.manifest.active_units,
    ["unit_acquisition"],
    JSON.stringify(preStatus),
  );
  assert.ok(!preStatus.manifest.invalidated_units.includes("unit_competitor"));
  const preAcquisitionLane = preStatus.observability.laneTimings.find(
    (timing) => timing.unitId === "unit_acquisition",
  );
  assert.ok(preAcquisitionLane, JSON.stringify(preStatus, null, 2));
  assert.equal(preAcquisitionLane.state, "agent_started");
  assert.equal(preAcquisitionLane.endedAt, null);
  assert.equal(
    preStatus.observability.laneTimings.find((timing) => timing.unitId === "unit_buyer")?.state,
    "published",
    JSON.stringify(preStatus, null, 2),
  );
  const preMixedStage = preStatus.observability.stageTimings.find(
    (timing) =>
      timing.executionPlanRef === "plans/research-execution.r2.json" &&
      timing.stageId === "assessment_runtime_mixed",
  );
  assert.ok(preMixedStage, JSON.stringify(preStatus, null, 2));
  assert.equal(preMixedStage.state, "active");
  assert.equal(preMixedStage.endedAt, null);

  const prepared = await publishAssessmentRuntimeFailureAuthority(state);
  const terminal = await prepareTerminalReporting(
    state as unknown as G13FixtureState,
    prepared.gapPath,
    prepared.decision.path,
  );
  const preApplyStatus = await state.store.status(state.runId);
  assert.deepEqual(
    preApplyStatus.manifest.active_units,
    ["unit_acquisition", "unit_competitor"],
    JSON.stringify(preApplyStatus.manifest),
  );
  assert.ok(
    !preApplyStatus.manifest.invalidated_units.includes("unit_competitor"),
    JSON.stringify(preApplyStatus.manifest),
  );
  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  const input = {
    runId: state.runId,
    adaptationBundle: terminal.adaptationBundle,
    adaptationRefs: [prepared.decision.path],
    terminalReportEnvelope: terminal.reportEnvelope,
    createdAt: "2026-07-25T16:26:00Z",
    checkpointCreatedAt: "2026-07-25T16:27:00Z",
    nextStep: "Treat the runtime blocker as terminal for this Assessment Run only.",
    beliefSummary: {
      current_belief: "The current assessment Run hit a deterministic runtime blocker.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Can a repaired runtime start a new Run?",
    },
  } as const;
  const applied = await runtime.apply(input);
  assert.equal(applied.status, "applied", JSON.stringify(applied, null, 2));
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");

  const status = await state.store.status(state.runId);
  assert.equal(status.manifest.status, "failed", JSON.stringify(status, null, 2));
  assert.deepEqual(status.manifest.active_units, [], JSON.stringify(status, null, 2));
  assert.deepEqual(
    [...status.manifest.completed_units].sort(),
    ["unit_buyer", "unit_target_user"],
    JSON.stringify(status, null, 2),
  );
  assert.ok(
    status.manifest.failed_units.includes("unit_acquisition"),
    JSON.stringify(status.manifest),
  );
  assert.ok(
    status.manifest.failed_units.includes("unit_competitor"),
    JSON.stringify(status.manifest),
  );
  assert.ok(
    status.manifest.invalidated_units.includes("unit_business"),
    JSON.stringify(status.manifest),
  );
  assert.equal(status.terminalReportDisposition, "ready", JSON.stringify(status, null, 2));
  const acquisitionLane = status.observability.laneTimings.find(
    (timing) => timing.unitId === "unit_acquisition",
  );
  assert.ok(acquisitionLane, JSON.stringify(status, null, 2));
  assert.equal(acquisitionLane.state, "failed");
  assert.equal(acquisitionLane.endedAt, "2026-07-25T16:26:00Z");
  assert.equal(
    status.observability.laneTimings.find((timing) => timing.unitId === "unit_buyer")?.state,
    "published",
    JSON.stringify(status, null, 2),
  );
  const mixedStage = status.observability.stageTimings.find(
    (timing) =>
      timing.executionPlanRef === "plans/research-execution.r2.json" &&
      timing.stageId === "assessment_runtime_mixed",
  );
  assert.ok(mixedStage, JSON.stringify(status, null, 2));
  assert.equal(mixedStage.state, "failed");
  assert.equal(mixedStage.failureKind, "runtime_blocked");
  assert.equal(mixedStage.endedAt, "2026-07-25T16:26:00Z");

  const publishedEnvelopes = await Promise.all(
    status.manifest.artifact_refs.map(
      async (artifactRef) =>
        JSON.parse(
          await readFile(path.join(state.runRoot, artifactRef), "utf8"),
        ) as FormalArtifactEnvelope,
    ),
  );
  assert.equal(
    publishedEnvelopes.filter(
      (envelope) =>
        envelope.artifact_type === "startup_opportunity.assessment_stage_gate.v1" &&
        envelope.document.outcome === "runtime_blocked",
    ).length,
    0,
  );
  const stageCloseouts = publishedEnvelopes.filter(
    (envelope) => envelope.artifact_type === "startup_opportunity.execution_stage_closeout.v1",
  );
  assert.equal(stageCloseouts.length, 1, JSON.stringify(stageCloseouts, null, 2));
  const stageCloseout = stageCloseouts[0];
  assert.ok(stageCloseout);
  assert.equal(
    stageCloseout.artifact_path,
    canonicalExecutionStageCloseoutPath(stageCloseout.document),
  );
  assert.equal(stageCloseout.document.execution_plan_ref, "plans/research-execution.r2.json");
  assert.deepEqual(stageCloseout.document.started_unit_ids, ["unit_acquisition", "unit_buyer"]);
  assert.deepEqual(stageCloseout.document.completed_unit_ids, ["unit_buyer"]);
  assert.deepEqual(stageCloseout.document.failed_unit_ids, ["unit_acquisition"]);
  assert.deepEqual(stageCloseout.document.incomplete_unit_ids, [
    "unit_acquisition",
    "unit_competitor",
  ]);
  assert.deepEqual(stageCloseout.document.not_started_unit_ids, ["unit_competitor"]);
  const dispositions = stageCloseout.document.unit_dispositions as Record<string, unknown>[];
  assert.deepEqual(
    dispositions.map((disposition) => [disposition.unit_id, disposition.disposition]),
    [
      ["unit_acquisition", "runtime_failed"],
      ["unit_buyer", "completed"],
      ["unit_competitor", "not_started"],
    ],
  );
  const buyerDisposition = dispositions.find((disposition) => disposition.unit_id === "unit_buyer");
  assert.ok(buyerDisposition);
  assert.equal(typeof buyerDisposition.lifecycle_ref, "string");
  assert.equal(typeof buyerDisposition.lifecycle_hash, "string");
});

test("G1.3 sufficient and non-executable buyer coverage deterministically stop", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_stop_matrix_001");
  const base = await bundleFromRun(state);

  const sufficientBundle = clone(base);
  const sufficientBranch = effectiveDocument(sufficientBundle, G13_BUYER_BRANCH.outputPath);
  sufficientBranch.branch_status = "completed";
  sufficientBranch.dimension_decision = "mixed";
  sufficientBranch.decision_sufficiency = "sufficient";
  sufficientBranch.insufficiency_reasons = [];
  refreshEnvelope(sufficientBundle, G13_BUYER_BRANCH.outputPath);
  const sufficientJudgment = effectiveDocument(sufficientBundle, G13_BUYER_BRANCH.judgmentRef);
  sufficientJudgment.judgment_signal = "mixed";
  sufficientJudgment.supporting_claim_refs = ["claim_unit_buyer_support"];
  sufficientJudgment.opposing_claim_refs = ["claim_unit_buyer_oppose"];
  sufficientJudgment.decision_sufficiency = "sufficient";
  sufficientJudgment.insufficiency_reasons = [];
  refreshEnvelope(sufficientBundle, G13_BUYER_BRANCH.judgmentRef);
  const sufficient = await createGap(state, {
    snapshotId: "buyer-coverage-sufficient",
    bundle: sufficientBundle,
  });
  const sufficientGaps = sufficient.result.snapshot?.gaps as Record<string, unknown>[] | undefined;
  assert.equal(sufficientGaps?.[0]?.gap_type, "coverage_sufficient");
  assert.deepEqual(sufficient.result.snapshot?.stop_signals, ["coverage_sufficient"]);

  const exhaustedBundle = clone(base);
  effectiveDocument(exhaustedBundle, "manifest.json").followup_round = 2;
  const exhausted = await createGap(state, {
    snapshotId: "buyer-followup-exhausted",
    bundle: exhaustedBundle,
  });
  const exhaustedGaps = exhausted.result.snapshot?.gaps as Record<string, unknown>[] | undefined;
  assert.equal(exhaustedGaps?.[0]?.gap_type, "no_executable_followup");
  assert.deepEqual(exhausted.result.snapshot?.stop_signals, [
    "max_followup_rounds_reached",
    "no_executable_followup",
  ]);

  const duplicateBundle: DocumentBundle = {
    ...clone(sufficientBundle),
    documents: [
      ...sufficientBundle.documents,
      {
        path: sufficient.result.snapshotPath as string,
        document: sufficient.result.snapshot as Record<string, unknown>,
      },
    ],
  };
  const duplicate = (await createAssessmentGapAnalyzer(repositoryRoot)).analyze({
    documentBundle: duplicateBundle,
    snapshotId: "buyer-coverage-duplicate",
    createdAt: "2026-07-25T16:21:00Z",
    triggerKind: "wave_completed",
    waveId: "assessment_wave_1",
    triggerEventRef: null,
    dimensionId: "buyer_language_and_willingness_to_pay",
    observedArtifactRefs: [G13_BUYER_BRANCH.outputPath],
    materialNewEvidenceObserved: true,
  });
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.errors.some((error) => error.code === "assessment_gap.coverage_duplicate"));
});

test("G1.3 rejects fabricated closed stop bases before filesystem publication", async (context) => {
  const cases = [
    {
      id: "coverage_sufficient",
      coverageStatus: "sufficient",
      stopSignals: ["coverage_sufficient"],
    },
    {
      id: "no_material_new_evidence",
      coverageStatus: "insufficient",
      stopSignals: ["no_material_new_evidence"],
    },
    {
      id: "no_executable_followup",
      coverageStatus: "no_executable_followup",
      stopSignals: ["no_executable_followup"],
    },
  ] as const;

  for (const [index, fixture] of cases.entries()) {
    await context.test(fixture.id, async (subcontext) => {
      const state = await prepareG13Run(
        subcontext,
        repositoryRoot,
        `run_g1_3_forged_stop_${String(index + 1)}`,
      );
      const { result } = await createGap(state, {
        snapshotId: `forged-${fixture.id}`,
        materialNewEvidenceObserved: true,
      });
      const snapshot = clone(result.snapshot as Record<string, unknown>);
      const gap = (snapshot.gaps as Record<string, unknown>[])[0];
      assert.ok(gap);
      gap.gap_type = fixture.id;
      gap.coverage_status = fixture.coverageStatus;
      gap.recommended_unit_type = null;
      gap.followup_status = "stop";
      gap.severity = "material";
      snapshot.stop_signals = fixture.stopSignals;
      const gapPath = result.snapshotPath as string;
      const envelope = formalEnvelope(
        state.runId,
        gapPath,
        snapshot,
        "startup_opportunity.artifact_envelope.current",
        "harness",
        gap.basis_refs as readonly string[],
        "2026-07-25T16:21:00Z",
      );
      const before = await snapshotTree(state.runRoot);

      await assert.rejects(
        state.store.publishArtifact({ runId: state.runId, envelope }),
        (error: unknown) =>
          error instanceof StoreError &&
          error.code === "artifact.reference_invalid" &&
          JSON.stringify(error.details).includes("assessment_adaptation.gap_semantics_mismatch"),
      );
      assert.deepEqual(await snapshotTree(state.runRoot), before);
    });
  }
});

test("G1.3 contract rejects closed-action, identity, ancestry, and observed Artifact drift", async (context) => {
  const catalog = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "tests/fixtures/g1.3/assessment-adaptation-cases.json"),
      "utf8",
    ),
  ) as { positive_cases: string[]; negative_cases: string[] };
  assert.equal(catalog.positive_cases.length, 16);
  assert.equal(catalog.negative_cases.length, 16);

  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_negative_001");
  const prepared = await publishGapAndDecision(state);
  const validator = await createAdaptationPolicyValidator(repositoryRoot);
  assert.equal(validator.validateDocumentBundle(prepared.adaptationBundle).valid, true);

  const modeMismatch = clone(prepared.adaptationBundle);
  effectiveDocument(modeMismatch, "manifest.json").mode = "opportunity_discovery";
  assert.ok(
    validator
      .validateDocumentBundle(modeMismatch)
      .adaptationErrors.some((error) => error.code === "adaptation.run_mode_mismatch"),
  );

  const cases: readonly {
    readonly id: string;
    readonly mutate: (bundle: DocumentBundle) => void;
    readonly expectedCode: string;
  }[] = [
    {
      id: "stale_base",
      mutate: (bundle) => {
        effectiveDocument(bundle, prepared.decision.path).based_on_plan_revision = 2;
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "assessment_adaptation.decision_binding_mismatch",
    },
    {
      id: "illegal_action",
      mutate: (bundle) => {
        effectiveDocument(bundle, prepared.decision.path).action = "retry_unit";
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "schema.enum",
    },
    {
      id: "illegal_target",
      mutate: (bundle) => {
        const decision = effectiveDocument(bundle, prepared.decision.path);
        (decision.target_unit as Record<string, unknown>).unit_type = "acquisition";
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "assessment_adaptation.add_unit_invalid",
    },
    {
      id: "wrong_run",
      mutate: (bundle) => {
        effectiveDocument(bundle, prepared.decision.path).run_id = "run_foreign_g1_3";
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "reference.envelope_run_mismatch",
    },
    {
      id: "wrong_subject",
      mutate: (bundle) => {
        effectiveDocument(bundle, prepared.decision.path).subject_ref = "scope-frame.json";
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "reference.type_mismatch",
    },
    {
      id: "wrong_scope",
      mutate: (bundle) => {
        effectiveDocument(bundle, prepared.decision.path).scope_frame_hash =
          `sha256:${"0".repeat(64)}`;
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "assessment_adaptation.decision_binding_mismatch",
    },
    {
      id: "wrong_coverage_key",
      mutate: (bundle) => {
        effectiveDocument(bundle, prepared.decision.path).coverage_key = `sha256:${"1".repeat(64)}`;
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "assessment_adaptation.decision_binding_mismatch",
    },
    {
      id: "forged_observed_artifact_hash",
      mutate: (bundle) => {
        const snapshot = effectiveDocument(bundle, prepared.gapPath);
        const observation = (snapshot.observed_artifacts as Record<string, unknown>[])[0];
        assert.ok(observation);
        observation.content_hash = `sha256:${"2".repeat(64)}`;
        refreshEnvelope(bundle, prepared.gapPath);
      },
      expectedCode: "assessment_adaptation.observed_artifact_mismatch",
    },
  ];
  for (const fixture of cases) {
    const changed = clone(prepared.adaptationBundle);
    fixture.mutate(changed);
    const result = validator.validateDocumentBundle(changed);
    assert.equal(result.valid, false, `${fixture.id} unexpectedly passed`);
    const codes = [
      ...result.planValidation.planningContract.documentBundle.documents.flatMap((entry) =>
        entry.errors.map((error) => error.code),
      ),
      ...result.planValidation.planningContract.documentBundle.referenceErrors.map(
        (error) => error.code,
      ),
      ...result.adaptationErrors.map((error) => error.code),
    ];
    assert.ok(codes.includes(fixture.expectedCode), `${fixture.id}: ${JSON.stringify(codes)}`);
  }

  const originalDecisionEntry = prepared.adaptationBundle.documents.find(
    (entry) => entry.path === prepared.decision.path,
  );
  assert.ok(originalDecisionEntry);
  const originalDecisionEnvelope = clone(originalDecisionEntry);
  const duplicateDecisionPath = "adaptations/decisions/add-buyer-followup-duplicate.json";
  originalDecisionEnvelope.document.artifact_path = duplicateDecisionPath;
  (originalDecisionEnvelope.document.document as Record<string, unknown>).adaptation_id =
    "adapt_add_buyer_followup_duplicate";
  originalDecisionEnvelope.document.content_hash = canonicalContentHash(
    originalDecisionEnvelope.document.document,
  );
  const decisionEnvelope = {
    path: duplicateDecisionPath,
    document: originalDecisionEnvelope.document,
  };
  const duplicateDecision: DocumentBundle = {
    ...clone(prepared.adaptationBundle),
    documents: [...prepared.adaptationBundle.documents, decisionEnvelope],
  };
  const duplicateDecisionResult = validator.validateDocumentBundle(duplicateDecision);
  assert.equal(duplicateDecisionResult.valid, false);
  assert.ok(
    duplicateDecisionResult.adaptationErrors.some(
      (error) => error.code === "adaptation.coverage_duplicate",
    ),
  );

  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const branched = clone(candidate);
  const assessmentR2 = effectiveDocument(
    branched,
    "plans/concept-evidence-assessment-plan.r2.json",
  );
  assessmentR2.parent_plan_ref = null;
  const branchedResult = (
    await createAssessmentPlanSemanticValidator(repositoryRoot)
  ).validateDocumentBundle(branched);
  assert.equal(branchedResult.valid, false);
  assert.ok(
    branchedResult.planningContract.documentBundle.documents.some((entry) =>
      entry.errors.some((error) => error.code === "schema.type"),
    ),
  );
});

test("G1.3 runtime rejects stored drift and supplied operation-key conflict before Plan writes", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_drift_001");
  const prepared = await publishGapAndDecision(state);
  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  await assert.rejects(
    runtime.apply({
      ...applyInput(state, prepared, candidate),
      operationKey: `sha256:${"0".repeat(64)}`,
    }),
    (error: unknown) => error instanceof StoreError && error.code === "operation.key_mismatch",
  );
  await assert.rejects(readFile(path.join(state.runRoot, "plans/research-plan.r2.json")));

  const storedGap = JSON.parse(
    await readFile(path.join(state.runRoot, prepared.gapPath), "utf8"),
  ) as Record<string, unknown>;
  const storedGapDocument = storedGap.document as Record<string, unknown>;
  storedGapDocument.limitations = [
    ...(storedGapDocument.limitations as string[]),
    "Injected drift for deterministic rejection.",
  ];
  storedGap.content_hash = canonicalContentHash(storedGapDocument);
  await writeFile(path.join(state.runRoot, prepared.gapPath), `${canonicalJson(storedGap)}\n`);
  await assert.rejects(
    runtime.apply(applyInput(state, prepared, candidate)),
    (error: unknown) =>
      error instanceof StoreError && error.code === "adaptation.stored_content_mismatch",
  );
  await assert.rejects(readFile(path.join(state.runRoot, "plans/research-plan.r2.json")));
});

test("G1.3 concurrent same-operation apply is CAS-safe and idempotent", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_concurrent_001");
  const prepared = await publishGapAndDecision(state);
  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const firstRuntime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  const secondRuntime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  const results = await Promise.allSettled([
    firstRuntime.apply(applyInput(state, prepared, candidate)),
    secondRuntime.apply(applyInput(state, prepared, candidate)),
  ]);
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof firstRuntime.apply>>> =>
      result.status === "fulfilled",
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.ok(fulfilled.some((result) => result.value.status === "applied"));
  assert.ok(
    fulfilled.some((result) => result.value.status === "idempotent_replay") ||
      rejected.some(
        (result) =>
          result.reason instanceof StoreError && result.reason.code === "run.write_locked",
      ),
  );
  assert.equal(
    (await secondRuntime.apply(applyInput(state, prepared, candidate))).status,
    "idempotent_replay",
  );
  assert.equal((await state.store.load(state.runId)).manifest.plan_revision, 2);
});

test("G1.3 receipt recovery closes every published crash boundary", async (context) => {
  for (const [index, boundary] of [
    "after_intent",
    "after_control_artifacts",
    "after_manifest_update",
    "after_checkpoint_publish",
  ].entries()) {
    await context.test(boundary, async (subcontext) => {
      const state = await prepareG13Run(
        subcontext,
        repositoryRoot,
        `run_g1_3_fault_${String(index + 1)}`,
      );
      const prepared = await publishGapAndDecision(state);
      const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
      const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
      await assert.rejects(
        runtime.apply(applyInput(state, prepared, candidate, boundary as PlanApplyFaultBoundary)),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      const reopened = await state.store.load(state.runId);
      if (boundary === "after_intent" || boundary === "after_control_artifacts") {
        assert.equal(reopened.manifest.plan_revision, 1);
      } else {
        assert.equal(reopened.manifest.plan_revision, 2);
      }
      const replay = await runtime.apply(applyInput(state, prepared, candidate));
      assert.equal(replay.status, "idempotent_replay");
      assert.equal((await state.store.load(state.runId)).manifest.plan_revision, 2);
    });
  }
});

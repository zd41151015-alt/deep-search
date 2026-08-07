import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../harness/src/artifact-store/canonical.js";
import {
  type ApplyPlanRevisionInput,
  canonicalContentHash,
  canonicalJson,
  coverageKey,
  createAdaptationPolicyValidator,
  createArtifactValidator,
  createGapAnalyzer,
  createPlanRevisionRuntime,
  createPlanSemanticValidator,
  type DocumentBundle,
  EvidenceStore,
  type FormalArtifactEnvelope,
  operationKey,
  planningRunStateHash,
  RunStore,
  StoreError,
  transformPlan,
} from "../harness/src/index.js";
import {
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
  G21_SOLUTION_REF,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  createDiscoveryRuntimeFixture,
  runtimeEnvelope,
} from "./fixtures/g2.2/discovery-runtime-fixture.js";
import { createConfirmedRun } from "./helpers/current-run.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const PLAN_REF = "plans/research-plan.r1.json";
const CONTEXT_REF = "plans/planning-context.r1.json";
const GAP_REF = "adaptations/gap-snapshots/gap-runtime.r1.json";
const DECISION_REF = "adaptations/decisions/adapt-retry-runtime.json";
const SUBJECT_REF = "subject_001";
const PRE_KILL_CANDIDATE_REF = "artifacts/discovery/candidates/candidate_demand.r1.json";
const RETAINED_SHARED_CANDIDATE_REF = "artifacts/discovery/candidates/candidate_solution.r1.json";
const PRE_KILL_APPLY_AT = "2026-07-28T12:08:00Z";
const PRE_KILL_CONTEXT_AT = "2026-07-28T12:08:30Z";
const PRE_KILL_CHECKPOINT_AT = "2026-07-28T12:09:00Z";
const CONFIRMED_SCOPE = {
  revision: 1,
  geography: "Synthetic",
  customer_model: "b2c",
  target_users: ["synthetic user"],
  decision_goal: "test current contract",
  research_language: "en-US",
};

function scopeDecisions(runId: string): readonly Record<string, unknown>[] {
  const scopeHash = canonicalContentHash(CONFIRMED_SCOPE);
  const proposal = {
    schema_version: "startup_opportunity.decision.v1",
    decision_id: `scope_proposal_r1_${sha256Hex(scopeHash)}`,
    run_id: runId,
    decision_type: "scope_proposed",
    timestamp: "2026-07-24T12:00:00Z",
    actor: "main_agent",
    reason: "The main agent proposed the exact visible research scope.",
    artifact_refs: [],
    scope_revision: 1,
    scope_hash: scopeHash,
    scope: CONFIRMED_SCOPE,
  };
  return [
    proposal,
    {
      ...proposal,
      decision_id: `scope_confirmation_r1_${sha256Hex(scopeHash)}`,
      decision_type: "scope_assumption_confirmed",
      reason: "The fixture caller attests exact user confirmation of the visible proposal.",
      scope_proposal_ref: `decisions.jsonl#${String(proposal.decision_id)}`,
      scope_proposal_hash: canonicalContentHash(proposal),
      confirmation_basis: "caller_attested_user_confirmation",
      harness_identity_verification: "not_available",
    },
  ];
}

function runScript(script: string, args: readonly string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function unit(
  unitId: string,
  unitType: string,
  outputPath: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    unit_id: unitId,
    unit_type: unitType,
    plan_disposition: "enabled",
    priority_band: "normal",
    attempt: 1,
    supersedes_unit_ref: null,
    research_goal: `Research ${unitId} for the explicit subject.`,
    input_refs: [SUBJECT_REF],
    depends_on: [],
    agent_role: "lane-researcher",
    output_path: outputPath,
    required_artifact_schema: "startup_opportunity.enrichment_branch_result.v1",
    source_preferences: [],
    required_outputs: ["closed_result"],
    stop_conditions: [],
    ...overrides,
  };
}

function basePlan(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.research_plan.v1",
    plan_id: `plan_${runId.replaceAll("-", "_")}`,
    run_id: runId,
    mode: "opportunity_discovery",
    revision: 1,
    parent_plan_ref: null,
    triggered_by_adaptation_refs: [],
    created_at: "2026-07-24T12:01:00Z",
    research_questions: [
      {
        question_id: "rq_runtime_001",
        question: "Which mechanical gap still affects the next decision?",
        decision_impact: "May change execution validity.",
        uncertainty: "high",
        expected_information_gain: "high",
        stop_condition: "The explicit machine check is resolved.",
      },
    ],
    candidate_retention_policy: {
      minimum_evidence_requirement: "One referenced formal result.",
      candidate_retention_threshold: "Retain until explicit pre-kill.",
      candidate_diversity_policy: ["Retain one counterfactual subject."],
      counterfactual_candidate_requirement: true,
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
        wave_id: "wave_runtime_1",
        depends_on: [],
        units: [
          unit(
            "counter_completed",
            "counter_evidence",
            "artifacts/discovery/enrichment/branches/counter_completed.attempt-1.json",
          ),
          unit(
            "acquisition_failed",
            "acquisition",
            "artifacts/discovery/enrichment/branches/acquisition_failed.attempt-1.json",
          ),
        ],
      },
      {
        wave_id: "wave_runtime_2",
        depends_on: ["wave_runtime_1"],
        units: [
          unit(
            "buyer_active",
            "buyer_language",
            "artifacts/discovery/enrichment/branches/buyer_active.attempt-1.json",
            {
              depends_on: ["counter_completed"],
            },
          ),
          unit(
            "value_pending",
            "value_layer",
            "artifacts/discovery/enrichment/branches/value_pending.attempt-1.json",
            {
              depends_on: ["counter_completed"],
            },
          ),
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

function manifest(runId: string, plan: Record<string, unknown>): Record<string, unknown> {
  const [scopeProposal, scopeConfirmation] = scopeDecisions(runId);
  if (scopeProposal === undefined || scopeConfirmation === undefined) {
    throw new Error("synthetic Scope Decisions are incomplete");
  }
  return {
    schema_version: "startup_opportunity.run_manifest.v1",
    run_id: runId,
    mode: "opportunity_discovery",
    status: "researching",
    status_before_clarification: null,
    parent_run_id: null,
    scope_proposal_ref: `decisions.jsonl#${String(scopeProposal.decision_id)}`,
    scope_proposal_hash: canonicalContentHash(scopeProposal),
    scope_confirmation_ref: `decisions.jsonl#${String(scopeConfirmation.decision_id)}`,
    scope_confirmation_hash: canonicalContentHash(scopeConfirmation),
    scope_revision: 1,
    created_at: "2026-07-24T12:00:00Z",
    updated_at: "2026-07-24T12:06:00Z",
    current_phase: "enrichment",
    current_plan_ref: PLAN_REF,
    plan_revision: plan.revision,
    followup_round: 0,
    latest_gap_snapshot_ref: GAP_REF,
    pending_adaptation_refs: [DECISION_REF],
    validated_adaptation_refs: [],
    rejected_adaptation_refs: [],
    applied_adaptation_refs: [],
    completed_units: ["counter_completed"],
    active_units: ["buyer_active"],
    failed_units: ["acquisition_failed"],
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

function context(
  runManifest: Record<string, unknown>,
  plan: Record<string, unknown>,
  options: {
    readonly path: string;
    readonly revision: number;
    readonly parentRef: string | null;
    readonly stage: "current_plan" | "candidate_revision";
    readonly createdAt: string;
  },
): { readonly path: string; readonly document: Record<string, unknown> } {
  return {
    path: options.path,
    document: {
      schema_version: "startup_opportunity.planning_context.ai_source_bound.current",
      context_id: `planning_context_${String(runManifest.run_id).replaceAll("-", "_")}`,
      revision: options.revision,
      parent_context_ref: options.parentRef,
      run_id: runManifest.run_id,
      mode: runManifest.mode,
      phase: runManifest.current_phase,
      validation_stage: options.stage,
      manifest_binding: {
        manifest_ref: "manifest.json",
        manifest_schema_version: "startup_opportunity.run_manifest.v1",
        run_id: runManifest.run_id,
        mode: runManifest.mode,
        current_plan_ref: runManifest.current_plan_ref,
        current_plan_revision: runManifest.plan_revision,
        run_state_hash: planningRunStateHash({
          manifest_ref: "manifest.json",
          manifest_schema_version: "startup_opportunity.run_manifest.v1",
          run_id: String(runManifest.run_id),
          mode: String(runManifest.mode),
          current_plan_ref: runManifest.current_plan_ref as string,
          current_plan_revision: Number(runManifest.plan_revision),
        }),
      },
      target_plan_binding: {
        plan_ref: options.stage === "candidate_revision" ? "plans/research-plan.r2.json" : PLAN_REF,
        plan_schema_version: "startup_opportunity.research_plan.v1",
        plan_id: plan.plan_id,
        plan_revision: plan.revision,
        plan_content_hash: canonicalContentHash(plan),
      },
      ai_mandatory_coverage: {
        status: "not_required",
        trigger_version: "startup_opportunity.ai_mandatory_coverage_trigger.v1",
        basis: {
          signal: "none",
          declared_value: "not_applicable",
          subject_ref: null,
          source_ref: null,
          source_schema_version: null,
          source_content_hash: null,
        },
        required_dimensions: [],
      },
      producer_role: "main_agent",
      created_at: options.createdAt,
    },
  };
}

function gapSnapshot(
  runId: string,
  gapType = "unit_failed",
  subjectRef = `${PLAN_REF}#acquisition_failed`,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.gap_snapshot.discovery.plan.current",
    snapshot_id: "gap_runtime_snapshot_001",
    snapshot_cycle_key: "enrichment:wave_runtime_1:fixture",
    run_id: runId,
    based_on_plan_ref: PLAN_REF,
    revision: 1,
    parent_snapshot_ref: null,
    created_at: "2026-07-24T12:04:00Z",
    trigger_kind: "wave_completed",
    trigger_event_ref: null,
    phase: "enrichment",
    wave_id: "wave_runtime_1",
    observed_artifact_refs: [],
    gaps: [
      {
        gap_id: "gap_runtime_001",
        subject_ref: subjectRef,
        gap_type: gapType,
        detection_mode: "deterministic",
        triggered_by: {
          check_id: "fixture_machine_check",
          observed_artifact_refs: [],
          detail: "The explicit fixture state triggers this closed machine gap.",
        },
        decision_impact: ["execution_validity"],
        severity: "blocking",
        basis_refs: ["manifest.json", PLAN_REF],
        evidence_refs: [],
        recommended_unit_types: gapType === "unit_failed" ? ["acquisition"] : [],
      },
    ],
    material_new_evidence_observed: gapType !== "no_material_new_evidence",
    unresolved_decision_relevant_questions: ["rq_runtime_001"],
    stop_signals: gapType === "no_material_new_evidence" ? ["no_material_new_evidence"] : [],
  };
}

function triggerEvent(runId: string, eventId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.event.v1",
    event_id: eventId,
    run_id: runId,
    event_type: "artifact_validation_failed",
    timestamp: "2026-07-24T12:08:00Z",
    actor: "harness",
    reason: "The explicit event triggered deterministic gap analysis.",
    artifact_refs: [],
  };
}

function eventGapCycleKey(
  plan: Record<string, unknown>,
  eventRef: string,
  eventId: string,
): string {
  return operationKey("gap_snapshot_cycle", {
    base_plan: {
      ref: PLAN_REF,
      content_hash: canonicalContentHash(plan),
    },
    trigger: {
      kind: "artifact_validation_failed",
      event_ref: eventRef,
      event_id: eventId,
    },
    observed_artifacts: [],
  });
}

function userPlanDecision(runId: string, decisionId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.decision.v1",
    decision_id: decisionId,
    run_id: runId,
    decision_type: "plan_change_requested_by_user",
    timestamp: "2026-07-24T12:04:30Z",
    actor: "user",
    reason: "The user requested the explicit failed-unit retry.",
    artifact_refs: [GAP_REF],
  };
}

function retryDecision(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.adaptation_decision.discovery.current",
    adaptation_id: "adapt_retry_runtime_001",
    run_id: runId,
    based_on_plan_ref: PLAN_REF,
    trigger_gap_refs: [`${GAP_REF}#gap_runtime_001`],
    action: "retry_unit",
    target_unit_ref: `${PLAN_REF}#acquisition_failed`,
    target_unit: unit(
      "acquisition_retry_2",
      "acquisition",
      "artifacts/discovery/enrichment/branches/acquisition_retry_2.attempt-2.json",
      {
        attempt: 2,
        supersedes_unit_ref: `${PLAN_REF}#acquisition_failed`,
      },
    ),
    retry_basis: {
      kind: "manifest_failed_unit",
      manifest_ref: "manifest.json",
      unit_id: "acquisition_failed",
      manifest_state: "failed",
    },
    reason: "The exact Manifest failed_units state permits one retry.",
    expected_decision_impact: ["execution_validity"],
    success_condition: "A new immutable output revision is produced.",
    requested_by: "main_agent",
    created_at: "2026-07-24T12:05:00Z",
  };
}

function stopFollowupDecision(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.adaptation_decision.discovery.current",
    adaptation_id: "adapt_stop_followup_runtime_001",
    run_id: runId,
    based_on_plan_ref: PLAN_REF,
    trigger_gap_refs: [`${GAP_REF}#gap_runtime_001`],
    action: "stop_followup",
    reason: "No material new evidence remains in the bounded follow-up cycle.",
    expected_decision_impact: ["execution_validity"],
    stop_condition: "The explicit no-new-evidence stop signal is present.",
    requested_by: "main_agent",
    created_at: "2026-07-24T12:05:00Z",
  };
}

function clarificationDecision(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.adaptation_decision.discovery.current",
    adaptation_id: "adapt_request_clarification_runtime_001",
    run_id: runId,
    based_on_plan_ref: PLAN_REF,
    trigger_gap_refs: [`${GAP_REF}#gap_runtime_001`],
    action: "request_clarification",
    clarification_question: "Which explicit scope should the Run use?",
    reason: "The unresolved scope changes the decision-relevant research boundary.",
    expected_decision_impact: ["execution_validity"],
    success_condition: "The user supplies the missing scope value.",
    requested_by: "main_agent",
    created_at: "2026-07-24T12:05:00Z",
  };
}

function terminationDecision(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.adaptation_decision.discovery.current",
    adaptation_id: "adapt_terminate_runtime_001",
    run_id: runId,
    based_on_plan_ref: PLAN_REF,
    trigger_gap_refs: [`${GAP_REF}#gap_runtime_001`],
    action: "terminate_insufficient_evidence",
    reason: "The blocking evidence gap cannot be resolved within the bounded Run.",
    expected_decision_impact: ["execution_validity"],
    stop_condition: "No bounded follow-up remains available.",
    requested_by: "main_agent",
    created_at: "2026-07-24T12:05:00Z",
  };
}

function runtimeFailureDecision(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.adaptation_decision.discovery.current",
    adaptation_id: "adapt_runtime_failure_001",
    run_id: runId,
    based_on_plan_ref: PLAN_REF,
    trigger_gap_refs: [`${GAP_REF}#gap_runtime_001`],
    action: "record_runtime_failure",
    reason: "The deterministic runtime blocker prevents the Run from completing.",
    expected_decision_impact: ["execution_validity"],
    stop_condition: "The blocking runtime failure remains unresolved.",
    requested_by: "main_agent",
    created_at: "2026-07-24T12:05:00Z",
  };
}

function supersedeDecision(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.adaptation_decision.discovery.current",
    adaptation_id: "adapt_supersede_runtime_001",
    run_id: runId,
    based_on_plan_ref: PLAN_REF,
    trigger_gap_refs: [`${GAP_REF}#gap_runtime_001`],
    action: "supersede_unit",
    target_unit_ref: `${PLAN_REF}#buyer_active`,
    target_unit: unit(
      "buyer_superseding",
      "buyer_language",
      "artifacts/discovery/enrichment/branches/buyer_superseding.attempt-2.json",
      { attempt: 2, supersedes_unit_ref: `${PLAN_REF}#buyer_active` },
    ),
    reason: "The active unit must be replaced by an immutable successor.",
    expected_decision_impact: ["execution_validity"],
    success_condition: "The replacement unit owns a new output path.",
    requested_by: "main_agent",
    created_at: "2026-07-24T12:05:00Z",
  };
}

function preKillSkipDecision(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.adaptation_decision.discovery.current",
    adaptation_id: "adapt_pre_kill_skip_runtime_001",
    run_id: runId,
    based_on_plan_ref: PLAN_REF,
    trigger_gap_refs: [`${GAP_REF}#gap_runtime_001`],
    action: "skip_unit",
    target_unit_ref: `${PLAN_REF}#value_pending`,
    reason: "The exact pre-killed candidate is the pending unit's sole candidate input.",
    expected_decision_impact: ["execution_validity"],
    success_condition: "The exclusive pending candidate unit remains unstarted.",
    requested_by: "main_agent",
    created_at: "2026-07-24T12:05:00Z",
  };
}

function bundle(
  runManifest: Record<string, unknown>,
  plan: Record<string, unknown>,
  planningContext: { readonly path: string; readonly document: Record<string, unknown> },
  gap: Record<string, unknown>,
  decision: Record<string, unknown>,
  extras: readonly { readonly path: string; readonly document: Record<string, unknown> }[] = [],
): DocumentBundle {
  return {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: "manifest.json", document: runManifest },
      { path: PLAN_REF, document: plan },
      planningContext,
      { path: GAP_REF, document: gap },
      { path: DECISION_REF, document: decision },
      ...extras,
    ],
    exact_records: scopeDecisions(String(runManifest.run_id)).map((document) => ({
      ref: `decisions.jsonl#${String(document.decision_id)}`,
      document,
    })),
  };
}

function formalEnvelope(
  runId: string,
  artifactPath: string,
  document: Record<string, unknown>,
  inputRefs: readonly string[] = [],
  version: FormalArtifactEnvelope["schema_version"] = "startup_opportunity.artifact_envelope.current",
): FormalArtifactEnvelope {
  const artifactType = String(document.schema_version);
  return {
    schema_version: version,
    artifact_type: artifactType,
    artifact_path: artifactPath,
    run_id: runId,
    created_at: String(document.created_at ?? "2026-07-24T12:01:00Z"),
    producer_role:
      document.producer_role === "main_agent" ||
      artifactType === "startup_opportunity.adaptation_decision.discovery.current" ||
      artifactType === "startup_opportunity.adaptation_decision.assessment.current"
        ? "main_agent"
        : "harness",
    input_refs: inputRefs,
    content_hash: canonicalContentHash(document),
    document,
  };
}

function terminalReportSource(runId: string, runtimeFailure = false): FormalArtifactEnvelope {
  const artifactPath = "artifacts/reporting/terminal-report-source.r1.json";
  const auditRefs = [DECISION_REF, GAP_REF, PLAN_REF].sort();
  const document: Record<string, unknown> = {
    schema_version: "startup_opportunity.terminal_report_source.v1",
    report_id: "terminal_report_runtime_1",
    run_id: runId,
    mode: "opportunity_discovery",
    research_language: "zh-CN",
    producer_role: "main_agent",
    owned_output_path: artifactPath,
    materialized_path: "report.json",
    generated_at: "2026-07-24T12:09:30Z",
    terminal_outcome: runtimeFailure ? "failed" : "insufficient_evidence",
    decision_question: "合成测试：这次有边界的机会发现是否应继续？",
    execution: {
      completeness: "partial",
      completed_stages: ["初轮机会发现"],
      incomplete_stages: [
        {
          stage: "机会综合",
          cause: "evidence_ceiling",
          detail: "合成材料不足以支持继续形成机会结论。",
          conclusion_impact: "本次仅部分执行，不能据此排序任何方向。",
          related_refs: [GAP_REF],
        },
      ],
      required_followups: [
        {
          followup_id: "bounded_followup",
          status: "legally_closed",
          detail: "当前范围内的有界追加调研已经按最新缺口决定关闭。",
          related_refs: [GAP_REF],
        },
      ],
      pending_operation_refs: [],
    },
    research_conclusion: runtimeFailure
      ? {
          outcome: "no_recommendation",
          current_recommendation: "本次运行失败，不能形成研究建议。",
          meaning: "运行问题阻止了完整执行，不能把失败解释为市场结论。",
          evidence_strength: "insufficient",
          allowed_claim: "本次运行在完成机会综合前失败。",
        }
      : {
          outcome: "insufficient_evidence",
          current_recommendation: "暂缓形成或排序创业机会。",
          meaning: "当前只完成初轮发现，证据不足以支持机会结论。",
          evidence_strength: "insufficient",
          allowed_claim: "初轮发现已完成，但后续机会综合未执行。",
        },
    runtime_health: runtimeFailure
      ? {
          status: "blocked",
          issues: [
            {
              code: "synthetic_runtime_failure",
              stage: "机会综合",
              detail: "合成运行时故障阻止了后续执行。",
              conclusion_impact: "不能形成、排序或推荐任何机会方向。",
              related_refs: [GAP_REF],
            },
          ],
        }
      : { status: "healthy", issues: [] },
    directions: [],
    sources: [],
    excluded_evidence: [],
    commercial_research_audit_refs: [],
    commercial_uncertainties: [],
    quantitative_signal_rows: [],
    competitive_substitute_rows: [],
    research_coverage_gaps: [],
    gate_warnings: [],
    ordered_validation_plan: [],
    freshness: {
      earliest_valid_as_of: null,
      latest_valid_as_of: null,
      summary: "合成运行合同测试没有引用市场材料。",
    },
    limitations: ["仅为合成合同测试；没有执行真实市场调研或外部验证。"],
    external_action_boundary: {
      execution_owner: "user",
      execution_supported: false,
      result_tracking_supported: false,
      external_validation_claimed: false,
    },
    audit_refs: auditRefs,
  };
  const source = formalEnvelope(
    runId,
    artifactPath,
    document,
    auditRefs,
    "startup_opportunity.artifact_envelope.current",
  );
  return { ...source, created_at: "2026-07-24T12:09:30Z" };
}

async function setupPersistedRun(
  contextTest: TestContext,
  runId: string,
  action:
    | "retry"
    | "supersede"
    | "stop-followup"
    | "request-clarification"
    | "terminate"
    | "terminate-unclosed"
    | "runtime-failure"
    | "pre-kill-exact"
    | "pre-kill-missing"
    | "pre-kill-shared"
    | "post-g2-add" = "retry",
  requestedByUser = false,
  eventDriven = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g04-"));
  contextTest.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-24T12:00:00Z",
  });
  const preKill = action.startsWith("pre-kill-");
  const discoveryBacked = preKill || action === "post-g2-add";
  let discoveryBundle: DocumentBundle | null = null;
  let plan: Record<string, unknown>;
  if (discoveryBacked) {
    const evidence = new EvidenceStore(runsRoot);
    const record = async (unitId: string, label: string) =>
      (
        await evidence.record({
          runId,
          unitId,
          source: {
            kind: "user_provided",
            canonical_uri: `urn:startup-opportunity:user-provided:${runId}-${label}`,
          },
          researchGoal: `SYNTHETIC ${label} pre-kill binding substrate; not Evidence.`,
          rawContent: `SYNTHETIC ${label} bytes; not Evidence or validation.`,
          recordedAt: "2026-07-24T12:00:30Z",
        })
      ).record;
    const targetInputRefs =
      action === "post-g2-add"
        ? [PRE_KILL_CANDIDATE_REF]
        : action === "pre-kill-missing"
          ? [SUBJECT_REF]
          : action === "pre-kill-shared"
            ? [PRE_KILL_CANDIDATE_REF, RETAINED_SHARED_CANDIDATE_REF]
            : [PRE_KILL_CANDIDATE_REF];
    discoveryBundle = await createDiscoveryRuntimeFixture(
      runId,
      {
        generation: await record("unit_seed_independent_demand", "generation"),
        evaluation: await record("unit_counterfactual", "evaluation"),
      },
      [
        {
          wave_id: "wave_enrichment",
          depends_on: ["wave_discovery_synthetic"],
          units: [
            {
              unit_id: "value_pending",
              unit_type: "counter_evidence",
              plan_disposition: "enabled",
              priority_band: "high",
              attempt: 1,
              supersedes_unit_ref: null,
              research_goal: "SYNTHETIC candidate-specific enrichment remains pending.",
              input_refs: targetInputRefs,
              agent_role: "lane-researcher",
              output_path: "artifacts/discovery/lanes/value_pending.attempt-1.json",
              required_artifact_schema: "startup_opportunity.discovery_lane_result.v1",
              source_preferences: ["SYNTHETIC no source preference."],
              required_outputs: ["SYNTHETIC typed branch result."],
              stop_conditions: ["SYNTHETIC pre-kill decision."],
            },
          ],
        },
      ],
      "general",
      true,
    );
    const bootstrapManifest = (await store.load(runId)).manifest as unknown as Record<
      string,
      unknown
    >;
    bootstrapManifest.current_plan_ref = PLAN_REF;
    bootstrapManifest.plan_revision = 1;
    bootstrapManifest.current_phase = "discovery";
    await writeFile(
      path.join(runsRoot, runId, "manifest.json"),
      `${canonicalJson(bootstrapManifest)}\n`,
    );
    await store.publishArtifactBundle({
      runId,
      envelopes: [
        ...G21_CORE_REFS.map((ref) => fixtureEnvelope(discoveryBundle as DocumentBundle, ref)),
        ...G21_MAP_REFS.map((ref) => fixtureEnvelope(discoveryBundle as DocumentBundle, ref)),
        ...[
          PRE_KILL_CANDIDATE_REF,
          "artifacts/discovery/candidates/candidate_baseline.r1.json",
          RETAINED_SHARED_CANDIDATE_REF,
        ].map((ref) => runtimeEnvelope(discoveryBundle as DocumentBundle, ref)),
      ],
    });
    plan = runtimeEnvelope(discoveryBundle, PLAN_REF).document;
  } else {
    plan = basePlan(runId);
    await store.publishArtifact({
      runId,
      envelope: formalEnvelope(runId, PLAN_REF, plan),
    });
  }
  const runRoot = path.join(runsRoot, runId);
  const persistedManifest = manifest(runId, plan);
  const storeManifest = (await store.load(runId)).manifest;
  persistedManifest.scope_proposal_ref = storeManifest.scope_proposal_ref;
  persistedManifest.scope_proposal_hash = storeManifest.scope_proposal_hash;
  persistedManifest.scope_confirmation_ref = storeManifest.scope_confirmation_ref;
  persistedManifest.scope_confirmation_hash = storeManifest.scope_confirmation_hash;
  persistedManifest.current_phase = discoveryBacked ? "discovery" : "enrichment";
  persistedManifest.artifact_refs = discoveryBacked ? storeManifest.artifact_refs : [PLAN_REF];
  persistedManifest.latest_gap_snapshot_ref = null;
  persistedManifest.pending_adaptation_refs = [];
  if (action === "terminate" || action === "terminate-unclosed") {
    persistedManifest.followup_round = 2;
  }
  await writeFile(path.join(runRoot, "manifest.json"), `${canonicalJson(persistedManifest)}\n`);
  const planningContext = context(persistedManifest, plan, {
    path: CONTEXT_REF,
    revision: 1,
    parentRef: null,
    stage: "current_plan",
    createdAt: "2026-07-24T12:03:00Z",
  });
  const gap = preKill
    ? gapSnapshot(runId, "candidate_pre_killed", PRE_KILL_CANDIDATE_REF)
    : action === "stop-followup"
      ? gapSnapshot(runId, "no_material_new_evidence", PLAN_REF)
      : action === "runtime-failure"
        ? gapSnapshot(runId, "runtime_blocked", PLAN_REF)
        : action === "post-g2-add"
          ? gapSnapshot(runId, "evidence_insufficient", PRE_KILL_CANDIDATE_REF)
          : gapSnapshot(runId);
  if (action === "runtime-failure") {
    gap.stop_signals = ["runtime_blocked"];
  }
  if (action === "post-g2-add") {
    const gapEntry = (gap.gaps as Record<string, unknown>[])[0];
    assert.ok(gapEntry);
    gapEntry.recommended_unit_types = ["counter_evidence"];
  }
  const triggerEventRecord = eventDriven
    ? triggerEvent(runId, `gap_trigger_${runId.replaceAll("-", "_")}`)
    : null;
  if (triggerEventRecord !== null) {
    gap.trigger_kind = "artifact_validation_failed";
    gap.trigger_event_ref = `events.jsonl#${String(triggerEventRecord.event_id)}`;
    gap.wave_id = null;
    gap.snapshot_cycle_key = eventGapCycleKey(
      plan,
      String(gap.trigger_event_ref),
      String(triggerEventRecord.event_id),
    );
  }
  const decision = preKill
    ? preKillSkipDecision(runId)
    : action === "stop-followup"
      ? stopFollowupDecision(runId)
      : action === "request-clarification"
        ? clarificationDecision(runId)
        : action === "terminate" || action === "terminate-unclosed"
          ? terminationDecision(runId)
          : action === "runtime-failure"
            ? runtimeFailureDecision(runId)
            : action === "retry"
              ? retryDecision(runId)
              : action === "supersede"
                ? supersedeDecision(runId)
                : retryDecision(runId);
  if (action === "post-g2-add") {
    decision.adaptation_id = "adapt_add_post_g2";
    decision.action = "add_unit";
    delete decision.target_unit_ref;
    delete decision.retry_basis;
    decision.target_unit = {
      unit_id: "post_g2_followup",
      unit_type: "counter_evidence",
      plan_disposition: "enabled",
      priority_band: "high",
      attempt: 1,
      supersedes_unit_ref: null,
      research_goal: "SYNTHETIC post-G2 follow-up remains unvalidated.",
      input_refs: [PRE_KILL_CANDIDATE_REF],
      depends_on: [],
      agent_role: "lane-researcher",
      output_path: "artifacts/discovery/lanes/post_g2_followup.attempt-1.json",
      required_artifact_schema: "startup_opportunity.discovery_lane_result.v1",
      source_preferences: [],
      required_outputs: ["SYNTHETIC typed discovery result."],
      stop_conditions: ["SYNTHETIC bounded follow-up only."],
    };
    decision.success_condition = "The added unit publishes one typed discovery result.";
  }
  const userDecision = requestedByUser
    ? userPlanDecision(runId, `decision_${runId.replaceAll("-", "_")}`)
    : null;
  if (userDecision !== null) {
    decision.requested_by = "user";
    decision.user_decision_ref = `decisions.jsonl#${String(userDecision.decision_id)}`;
  }
  await store.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, CONTEXT_REF, planningContext.document, [
      "manifest.json",
      PLAN_REF,
    ]),
  });
  if (triggerEventRecord !== null) {
    await store.appendEvent(runId, triggerEventRecord);
  }
  await store.publishArtifact({
    runId,
    envelope: formalEnvelope(
      runId,
      GAP_REF,
      gap,
      [PLAN_REF, ...(triggerEventRecord === null ? [] : [String(gap.trigger_event_ref)])],
      undefined,
    ),
  });
  if (userDecision !== null) {
    await store.appendDecision(runId, userDecision);
  }
  await store.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, DECISION_REF, decision, [
      PLAN_REF,
      GAP_REF,
      ...(action === "terminate-unclosed" ? [CONTEXT_REF] : []),
      ...(userDecision === null ? [] : [String(decision.user_decision_ref)]),
    ]),
  });
  const beforeCheckpoint = JSON.parse(
    await readFile(path.join(runRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  beforeCheckpoint.latest_gap_snapshot_ref = GAP_REF;
  beforeCheckpoint.pending_adaptation_refs = [DECISION_REF];
  beforeCheckpoint.completed_units = discoveryBacked ? [] : ["counter_completed"];
  beforeCheckpoint.active_units = discoveryBacked ? [] : ["buyer_active"];
  beforeCheckpoint.failed_units = discoveryBacked ? [] : ["acquisition_failed"];
  beforeCheckpoint.updated_at = "2026-07-24T12:06:00Z";
  await writeFile(path.join(runRoot, "manifest.json"), `${canonicalJson(beforeCheckpoint)}\n`);
  await store.checkpoint({
    runId,
    checkpointId: "checkpoint_planned_runtime",
    createdAt: "2026-07-24T12:07:00Z",
    nextStep: "Apply the validated retry decision.",
    beliefSummary: {
      current_belief: "The failed unit requires a mechanical retry decision.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does the retry produce a valid result?",
    },
    unresolvedGapRefs: [`${GAP_REF}#gap_runtime_001`],
    inputRefs: [CONTEXT_REF, GAP_REF, DECISION_REF],
  });
  const loaded = await store.load(runId);
  const currentManifest = loaded.manifest as unknown as Record<string, unknown>;
  const checkpointEnvelope = JSON.parse(
    await readFile(path.join(runRoot, loaded.lastValidCheckpointRef), "utf8"),
  ) as FormalArtifactEnvelope;
  const checkpointEntry = {
    path: loaded.lastValidCheckpointRef,
    document: checkpointEnvelope.document,
  };
  const adaptationBundle = bundle(currentManifest, plan, planningContext, gap, decision, [
    checkpointEntry,
    ...(discoveryBundle === null
      ? []
      : [
          {
            path: PRE_KILL_CANDIDATE_REF,
            document: runtimeEnvelope(discoveryBundle, PRE_KILL_CANDIDATE_REF),
          },
        ]),
    ...(userDecision === null ? [] : [{ path: "decisions.jsonl", document: userDecision }]),
    ...(triggerEventRecord === null
      ? []
      : [{ path: "events.jsonl", document: triggerEventRecord }]),
  ]);
  return {
    root,
    runsRoot,
    runRoot,
    store,
    plan,
    gap,
    decision,
    userDecision,
    triggerEventRecord,
    planningContext,
    currentManifest,
    adaptationBundle,
    checkpointEntry,
    discoveryBundle,
  };
}

function currentDiscoveryAdaptationBundle(
  setup: Awaited<ReturnType<typeof setupPersistedRun>>,
): DocumentBundle {
  assert.ok(setup.discoveryBundle);
  const selected = new Map<string, DocumentBundle["documents"][number]>(
    [
      ...G21_CORE_REFS,
      ...G21_MAP_REFS,
      "artifacts/discovery/candidates/candidate_baseline.r1.json",
      PRE_KILL_CANDIDATE_REF,
      RETAINED_SHARED_CANDIDATE_REF,
    ].map((artifactPath) => [
      artifactPath,
      {
        path: artifactPath,
        document: (artifactPath.startsWith("artifacts/discovery/candidates/")
          ? runtimeEnvelope(setup.discoveryBundle as DocumentBundle, artifactPath)
          : fixtureEnvelope(
              setup.discoveryBundle as DocumentBundle,
              artifactPath,
            )) as unknown as Record<string, unknown>,
      },
    ]),
  );
  for (const entry of setup.adaptationBundle.documents) {
    if (entry.path !== PLAN_REF) {
      selected.set(entry.path, structuredClone(entry));
    }
  }
  return {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [...selected.values()].sort((left, right) => left.path.localeCompare(right.path)),
    exact_records: structuredClone(setup.adaptationBundle.exact_records ?? []),
  };
}

async function planApplyBoundaryState(runRoot: string) {
  return {
    manifest: await readFile(path.join(runRoot, "manifest.json"), "utf8"),
    plans: (await readdir(path.join(runRoot, "plans"))).sort(),
    adaptationDecisions: (await readdir(path.join(runRoot, "adaptations/decisions"))).sort(),
    checkpoints: (await readdir(path.join(runRoot, "checkpoints"))).sort(),
    operationReceipts: (await readdir(path.join(runRoot, ".store/operations"))).sort(),
  };
}

async function planReceiptFile(runRoot: string): Promise<string> {
  const operationDirectory = path.join(runRoot, ".store/operations");
  const receiptName = (await readdir(operationDirectory)).find((name) =>
    name.startsWith("plan-revision-"),
  );
  assert.ok(receiptName);
  return path.join(operationDirectory, receiptName);
}

async function rewriteStoredArtifactAndReceipt(
  runRoot: string,
  artifactPath: string,
  mutate: (document: Record<string, unknown>) => void,
): Promise<void> {
  const operations = path.join(runRoot, ".store/operations");
  let receiptFile: string | null = null;
  let receipt: Record<string, unknown> | null = null;
  for (const filename of (await readdir(operations)).sort()) {
    if (!filename.startsWith("artifact-") || !filename.endsWith(".json")) {
      continue;
    }
    const candidate = JSON.parse(await readFile(path.join(operations, filename), "utf8")) as Record<
      string,
      unknown
    >;
    if (candidate.artifact_path === artifactPath) {
      receiptFile = path.join(operations, filename);
      receipt = candidate;
      break;
    }
  }
  assert.ok(receiptFile, artifactPath);
  assert.ok(receipt, artifactPath);
  const envelope = clone(receipt.envelope as Record<string, unknown>);
  const document = envelope.document as Record<string, unknown>;
  mutate(document);
  envelope.content_hash = canonicalContentHash(document);
  const nextOperationKey = operationKey("publish_artifact", {
    run_id: envelope.run_id,
    artifact_path: envelope.artifact_path,
    artifact_type: envelope.artifact_type,
    content_hash: envelope.content_hash,
  });
  const nextReceipt = {
    ...receipt,
    operation_key: nextOperationKey,
    content_hash: envelope.content_hash,
    envelope,
  };
  const nextReceiptFile = path.join(operations, `artifact-${sha256Hex(nextOperationKey)}.json`);
  await writeFile(path.join(runRoot, artifactPath), `${canonicalJson(envelope)}\n`);
  await writeFile(nextReceiptFile, `${canonicalJson(nextReceipt)}\n`);
  if (receiptFile !== nextReceiptFile) {
    await rm(receiptFile);
  }

  for (const filename of (await readdir(operations)).sort()) {
    if (!filename.startsWith("bundle-") || !filename.endsWith(".json")) {
      continue;
    }
    const bundleFile = path.join(operations, filename);
    const bundleReceipt = JSON.parse(await readFile(bundleFile, "utf8")) as Record<string, unknown>;
    const envelopes = bundleReceipt.envelopes as Record<string, unknown>[];
    if (!envelopes.some((candidate) => candidate.artifact_path === artifactPath)) {
      continue;
    }
    const nextEnvelopes = envelopes
      .map((candidate) => (candidate.artifact_path === artifactPath ? envelope : candidate))
      .sort((left, right) => String(left.artifact_path).localeCompare(String(right.artifact_path)));
    const nextBundleOperationKey = operationKey("publish_artifact_bundle", {
      run_id: bundleReceipt.run_id,
      envelopes: nextEnvelopes,
    });
    const nextBundleReceipt = {
      ...bundleReceipt,
      operation_key: nextBundleOperationKey,
      envelopes: nextEnvelopes,
    };
    const nextBundleFile = path.join(
      operations,
      `bundle-${sha256Hex(nextBundleOperationKey)}.json`,
    );
    await writeFile(nextBundleFile, `${canonicalJson(nextBundleReceipt)}\n`);
    if (bundleFile !== nextBundleFile) {
      await rm(bundleFile);
    }
  }
}

function storeReferenceCodes(error: StoreError): readonly string[] {
  const referenceErrors = error.details.referenceErrors;
  return Array.isArray(referenceErrors)
    ? referenceErrors.flatMap((entry) =>
        typeof entry === "object" && entry !== null && "code" in entry ? [String(entry.code)] : [],
      )
    : [];
}

function candidateFor(
  setup: Awaited<ReturnType<typeof setupPersistedRun>>,
  createdAt = "2026-07-24T12:08:00Z",
  candidateContextCreatedAt = "2026-07-24T12:08:30Z",
) {
  const transformed = transformPlan(
    PLAN_REF,
    setup.plan,
    setup.currentManifest as never,
    [{ path: DECISION_REF, document: setup.decision }],
    createdAt,
  );
  assert.ok(transformed.plan);
  const candidateContext = context(setup.currentManifest, transformed.plan, {
    path: "plans/planning-context.r2.json",
    revision: 2,
    parentRef: CONTEXT_REF,
    stage: "candidate_revision",
    createdAt: candidateContextCreatedAt,
  });
  const candidateBundle: DocumentBundle = {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: "manifest.json", document: setup.currentManifest },
      { path: PLAN_REF, document: setup.plan },
      { path: transformed.planPath, document: transformed.plan },
      setup.planningContext,
      candidateContext,
      { path: GAP_REF, document: setup.gap },
      { path: DECISION_REF, document: setup.decision },
      setup.checkpointEntry,
      ...(setup.userDecision === null
        ? []
        : [{ path: "decisions.jsonl", document: setup.userDecision }]),
      ...(setup.triggerEventRecord === null
        ? []
        : [{ path: "events.jsonl", document: setup.triggerEventRecord }]),
    ],
    exact_records: structuredClone(setup.adaptationBundle.exact_records ?? []),
  };
  return { transformed, candidateBundle };
}

function preKillApplyInput(
  setup: Awaited<ReturnType<typeof setupPersistedRun>>,
  candidateBundle: DocumentBundle,
  overrides: Partial<ApplyPlanRevisionInput> = {},
): ApplyPlanRevisionInput {
  return {
    runId: String(setup.currentManifest.run_id),
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: PRE_KILL_APPLY_AT,
    checkpointCreatedAt: PRE_KILL_CHECKPOINT_AT,
    nextStep: "Keep the exact pre-killed candidate unit skipped.",
    beliefSummary: {
      current_belief: "Only the exact immutable candidate binding may authorize the skip.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does the candidate binding still match durable state?",
    },
    ...overrides,
  };
}

function mutableBundleEntry(bundleValue: DocumentBundle, entryPath: string) {
  const entry = bundleValue.documents.find((candidate) => candidate.path === entryPath);
  assert.ok(entry);
  return entry as { path: string; document: Record<string, unknown> };
}

function mutablePreKillEnvelope(bundleValue: DocumentBundle): Record<string, unknown> {
  return mutableBundleEntry(bundleValue, PRE_KILL_CANDIDATE_REF).document;
}

async function publishSecondJsonlBackedPair(setup: Awaited<ReturnType<typeof setupPersistedRun>>) {
  const runId = String(setup.currentManifest.run_id);
  const eventRecord = triggerEvent(runId, `gap_trigger_second_${runId.replaceAll("-", "_")}`);
  eventRecord.timestamp = "2026-07-24T12:08:10Z";
  await setup.store.appendEvent(runId, eventRecord);

  const gapPath = "adaptations/gap-snapshots/gap-runtime-second.r1.json";
  const gap = gapSnapshot(runId, "scope_invalidated", `${PLAN_REF}#buyer_active`);
  gap.snapshot_id = "gap_runtime_snapshot_002";
  gap.created_at = "2026-07-24T12:08:20Z";
  gap.trigger_kind = "artifact_validation_failed";
  gap.trigger_event_ref = `events.jsonl#${String(eventRecord.event_id)}`;
  gap.wave_id = null;
  gap.snapshot_cycle_key = eventGapCycleKey(
    setup.plan,
    String(gap.trigger_event_ref),
    String(eventRecord.event_id),
  );
  const gapRecord = (gap.gaps as Record<string, unknown>[])[0] as Record<string, unknown>;
  gapRecord.gap_id = "gap_runtime_002";
  gapRecord.recommended_unit_types = ["buyer_language"];
  await setup.store.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, gapPath, gap, [PLAN_REF, String(gap.trigger_event_ref)]),
  });

  const userDecision = userPlanDecision(runId, `decision_second_${runId.replaceAll("-", "_")}`);
  userDecision.timestamp = "2026-07-24T12:08:30Z";
  userDecision.reason = "The user requested the second exact scope supersession.";
  userDecision.artifact_refs = [gapPath];
  await setup.store.appendDecision(runId, userDecision);

  const decisionPath = "adaptations/decisions/adapt-supersede-runtime-second.json";
  const decision = supersedeDecision(runId);
  decision.adaptation_id = "adapt_supersede_runtime_002";
  decision.trigger_gap_refs = [`${gapPath}#gap_runtime_002`];
  decision.requested_by = "user";
  decision.user_decision_ref = `decisions.jsonl#${String(userDecision.decision_id)}`;
  decision.created_at = "2026-07-24T12:08:40Z";
  await setup.store.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, decisionPath, decision, [
      PLAN_REF,
      gapPath,
      String(decision.user_decision_ref),
    ]),
  });
  return { eventRecord, gapPath, gap, userDecision, decisionPath, decision };
}

async function multiDecisionApplyInput(
  setup: Awaited<ReturnType<typeof setupPersistedRun>>,
  second: Awaited<ReturnType<typeof publishSecondJsonlBackedPair>>,
) {
  const loaded = await setup.store.load(String(setup.currentManifest.run_id));
  const currentManifest = loaded.manifest as unknown as Record<string, unknown>;
  const checkpointEnvelope = JSON.parse(
    await readFile(path.join(setup.runRoot, loaded.lastValidCheckpointRef), "utf8"),
  ) as FormalArtifactEnvelope;
  const checkpointEntry = {
    path: loaded.lastValidCheckpointRef,
    document: checkpointEnvelope.document,
  };
  const decisions = [
    { path: DECISION_REF, document: setup.decision },
    { path: second.decisionPath, document: second.decision },
  ];
  const transformed = transformPlan(
    PLAN_REF,
    setup.plan,
    currentManifest as never,
    decisions,
    "2026-07-24T12:10:00Z",
  );
  assert.ok(transformed.plan);
  const candidateContext = context(currentManifest, transformed.plan, {
    path: "plans/planning-context.r2.json",
    revision: 2,
    parentRef: CONTEXT_REF,
    stage: "candidate_revision",
    createdAt: "2026-07-24T12:10:30Z",
  });
  const commonDocuments = [
    { path: "manifest.json", document: currentManifest },
    { path: PLAN_REF, document: setup.plan },
    setup.planningContext,
    { path: GAP_REF, document: setup.gap },
    { path: second.gapPath, document: second.gap },
    ...decisions,
    checkpointEntry,
  ];
  const adaptationBundle: DocumentBundle = {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: commonDocuments,
    exact_records: structuredClone(setup.adaptationBundle.exact_records ?? []),
  };
  const candidateBundle: DocumentBundle = {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      ...commonDocuments,
      { path: transformed.planPath, document: transformed.plan },
      candidateContext,
    ],
    exact_records: structuredClone(setup.adaptationBundle.exact_records ?? []),
  };
  return {
    input: {
      runId: String(currentManifest.run_id),
      adaptationBundle,
      adaptationRefs: [DECISION_REF, second.decisionPath],
      candidateBundle,
      createdAt: "2026-07-24T12:10:00Z",
      checkpointCreatedAt: "2026-07-24T12:11:00Z",
      nextStep: "Resume both independently authorized replacement units.",
      beliefSummary: {
        current_belief: "Each user Decision fragment independently authorizes one closed action.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Do both replacement units produce valid Artifacts?",
      },
    },
    transformed,
  };
}

async function receiptForRecord(runRoot: string, recordId: string): Promise<string> {
  const operations = path.join(runRoot, ".store/operations");
  for (const name of (await readdir(operations)).sort()) {
    if (!name.startsWith("log-") || !name.endsWith(".json")) {
      continue;
    }
    const filename = path.join(operations, name);
    const value = JSON.parse(await readFile(filename, "utf8")) as Record<string, unknown>;
    if (value.record_id === recordId) {
      return filename;
    }
  }
  throw new Error(`missing receipt for ${recordId}`);
}

test("Plan semantic validation enforces DAG, output uniqueness, policy tuple, and current bindings", async () => {
  const runId = "plan-semantic-fixture";
  const plan = basePlan(runId);
  const runManifest = manifest(runId, plan);
  const planningContext = context(runManifest, plan, {
    path: CONTEXT_REF,
    revision: 1,
    parentRef: null,
    stage: "current_plan",
    createdAt: "2026-07-24T12:03:00Z",
  });
  const validBundle = bundle(
    runManifest,
    plan,
    planningContext,
    gapSnapshot(runId),
    retryDecision(runId),
  );
  const validator = await createPlanSemanticValidator(repositoryRoot);
  assert.equal(validator.validateDocumentBundle(validBundle).valid, true);

  const cycle = clone(validBundle);
  const cyclePlan = cycle.documents.find((entry) => entry.path === PLAN_REF)?.document as Record<
    string,
    unknown
  >;
  ((cyclePlan.waves as Record<string, unknown>[])[0] as Record<string, unknown>).depends_on = [
    "wave_runtime_2",
  ];
  assert.ok(
    validator
      .validateDocumentBundle(cycle)
      .planErrors.some((error) => error.code === "plan.wave_cycle"),
  );

  const duplicate = clone(validBundle);
  const duplicatePlan = duplicate.documents.find((entry) => entry.path === PLAN_REF)
    ?.document as Record<string, unknown>;
  const duplicateUnits = (duplicatePlan.waves as { units: Record<string, unknown>[] }[])[1]?.units;
  assert.ok(duplicateUnits);
  const firstDuplicateUnit = duplicateUnits[0];
  const secondDuplicateUnit = duplicateUnits[1];
  assert.ok(firstDuplicateUnit && secondDuplicateUnit);
  secondDuplicateUnit.output_path = firstDuplicateUnit.output_path;
  assert.ok(
    validator
      .validateDocumentBundle(duplicate)
      .planErrors.some((error) => error.code === "plan.output_path_conflict"),
  );

  const obsoleteOutputPath = clone(validBundle);
  const obsoleteOutputPlan = obsoleteOutputPath.documents.find((entry) => entry.path === PLAN_REF)
    ?.document as Record<string, unknown>;
  const obsoleteOutputUnit = (obsoleteOutputPlan.waves as { units: Record<string, unknown>[] }[])[0]
    ?.units[0];
  assert.ok(obsoleteOutputUnit);
  obsoleteOutputUnit.output_path = "artifacts/lanes/counter-completed.json";
  assert.ok(
    validator
      .validateDocumentBundle(obsoleteOutputPath)
      .planErrors.some((error) => error.code === "plan.output_path_contract_mismatch"),
  );

  const tuple = clone(validBundle);
  const tuplePlan = tuple.documents.find((entry) => entry.path === PLAN_REF)?.document as Record<
    string,
    unknown
  >;
  (
    (tuplePlan.waves as { units: Record<string, unknown>[] }[])[0]?.units[0] as Record<
      string,
      unknown
    >
  ).agent_role = "evidence-auditor";
  assert.ok(
    validator
      .validateDocumentBundle(tuple)
      .planningContract.contractErrors.some(
        (error) => error.code === "contract.unit_tuple_not_allowed",
      ),
  );
});

test("Gap analyzer emits only deterministic machine-observable gaps and stop signals", async () => {
  const runId = "gap-analysis-fixture";
  const plan = basePlan(runId);
  const runManifest = manifest(runId, plan);
  runManifest.followup_round = 2;
  const planningContext = context(runManifest, plan, {
    path: CONTEXT_REF,
    revision: 1,
    parentRef: null,
    stage: "current_plan",
    createdAt: "2026-07-24T12:03:00Z",
  });
  const currentBundle = bundle(
    runManifest,
    plan,
    planningContext,
    gapSnapshot(runId),
    retryDecision(runId),
  );
  const analyzer = await createGapAnalyzer(repositoryRoot);
  const input = {
    documentBundle: currentBundle,
    snapshotId: "gap_machine_draft_001",
    createdAt: "2026-07-24T12:09:00Z",
    triggerKind: "wave_completed" as const,
    phase: "enrichment",
    waveId: "wave_runtime_1",
    triggerEventRef: null,
    observedArtifactRefs: [],
    materialNewEvidenceObserved: false,
  };
  const first = analyzer.analyze(input);
  const second = analyzer.analyze(input);
  assert.equal(first.valid, true, JSON.stringify(first.errors));
  assert.equal(canonicalJson(first), canonicalJson(second));
  const gaps = first.snapshot?.gaps as Record<string, unknown>[];
  assert.deepEqual(gaps.map((gap) => gap.gap_type).sort(), [
    "no_material_new_evidence",
    "unit_failed",
  ]);
  assert.deepEqual(first.snapshot?.stop_signals, [
    "max_followup_rounds_reached",
    "no_material_new_evidence",
  ]);

  const invalid = analyzer.analyze({
    ...input,
    observedArtifactRefs: ["artifacts/lanes/missing.json"],
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.code === "gap.reference_missing"));

  const questionFragment = analyzer.analyze({
    ...input,
    materialNewEvidenceObserved: true,
    machineChecks: [
      {
        checkId: "question_fragment_check",
        gapType: "mandatory_dimension_missing",
        subjectRef: `${PLAN_REF}#rq_runtime_001`,
        basisRefs: [`${PLAN_REF}#rq_runtime_001`],
        decisionImpact: ["execution_validity"],
        severity: "material",
        recommendedUnitTypes: [],
        detail: "The exact research question remains decision-relevant.",
      },
    ],
  });
  assert.equal(questionFragment.valid, true, JSON.stringify(questionFragment.errors));
  const missingQuestionFragment = analyzer.analyze({
    ...input,
    machineChecks: [
      {
        checkId: "missing_question_fragment_check",
        gapType: "mandatory_dimension_missing",
        subjectRef: `${PLAN_REF}#rq_missing`,
        basisRefs: [`${PLAN_REF}#rq_missing`],
        decisionImpact: ["execution_validity"],
        severity: "material",
        recommendedUnitTypes: [],
        detail: "The missing research question must fail closed.",
      },
    ],
  });
  assert.ok(
    missingQuestionFragment.errors.some((error) => error.code === "gap.reference_fragment_missing"),
  );
});

test("run_id validation context assembles persisted authority and exact records", async (contextTest) => {
  const runId = "runtime-validation-context";
  const setup = await setupPersistedRun(contextTest, runId, "retry", false, true);
  const semanticBundle: DocumentBundle = {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [{ path: PLAN_REF, document: setup.plan }, setup.planningContext],
  };
  const assembled = await setup.store.buildValidationContext(runId, semanticBundle);
  assert.ok(assembled.bundle.documents.some((entry) => entry.path === "manifest.json"));
  assert.ok(
    assembled.bundle.documents.some((entry) => entry.path === setup.currentManifest.checkpoint_ref),
  );
  assert.equal(
    assembled.referenceContext.exactJsonlRecords?.has(String(setup.gap.trigger_event_ref)),
    true,
  );
  const artifactValidation = (await createArtifactValidator(repositoryRoot)).validateDocumentBundle(
    assembled.bundle,
    assembled.referenceContext,
  );
  assert.equal(artifactValidation.valid, true, JSON.stringify(artifactValidation, null, 2));
  const validation = (await createPlanSemanticValidator(repositoryRoot)).validateDocumentBundle(
    assembled.bundle,
    assembled.referenceContext,
  );
  assert.equal(validation.valid, true, JSON.stringify(validation, null, 2));

  const driftedBundle = clone(semanticBundle);
  const driftedPlan = driftedBundle.documents.find((entry) => entry.path === PLAN_REF)?.document;
  assert.ok(driftedPlan);
  driftedPlan.stop_conditions = ["Caller-supplied bytes must not replace Run authority."];
  await assert.rejects(
    setup.store.buildValidationContext(runId, driftedBundle),
    (error: unknown) =>
      error instanceof StoreError && error.code === "validation_context.authority_conflict",
  );

  const inputPath = path.join(setup.root, "semantic-plan-bundle.json");
  await writeFile(inputPath, `${canonicalJson(semanticBundle)}\n`);
  const cli = runScript(path.join(repositoryRoot, "harness/src/cli.ts"), [
    "validate-plan",
    "--bundle",
    inputPath,
    "--run-id",
    runId,
    "--runs-root",
    setup.runsRoot,
    "--json",
  ]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal((JSON.parse(cli.stdout) as Record<string, unknown>).valid, true);
});

test("Store and Gap analysis share exact Plan question fragment semantics", async (contextTest) => {
  const runId = "runtime-plan-question-fragment";
  const setup = await setupPersistedRun(contextTest, runId);
  const probe = triggerEvent(runId, "plan_question_fragment_probe");
  const probePath = "artifacts/audits/plan-question-fragment.json";
  await setup.store.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, probePath, probe, [`${PLAN_REF}#rq_runtime_001`]),
  });
  assert.equal(
    (
      JSON.parse(await readFile(path.join(setup.runRoot, probePath), "utf8")) as Record<
        string,
        unknown
      >
    ).artifact_path,
    probePath,
  );

  const missingPath = "artifacts/audits/missing-plan-question-fragment.json";
  const missing = triggerEvent(runId, "missing_plan_question_fragment_probe");
  await assert.rejects(
    setup.store.publishArtifact({
      runId,
      envelope: formalEnvelope(runId, missingPath, missing, [`${PLAN_REF}#rq_missing`]),
    }),
    (error: unknown) => error instanceof StoreError && error.code === "reference.fragment_missing",
  );
  await assert.rejects(readFile(path.join(setup.runRoot, missingPath), "utf8"));
});

test("Gap cycle identity binds base Plan, exact event, and observed Artifact hashes", async () => {
  const runId = "gap-cycle-identity";
  const plan = basePlan(runId);
  const runManifest = manifest(runId, plan);
  const planningContext = context(runManifest, plan, {
    path: CONTEXT_REF,
    revision: 1,
    parentRef: null,
    stage: "current_plan",
    createdAt: "2026-07-24T12:03:00Z",
  });
  const firstEventRef = "events.jsonl";
  const secondEventRef = "events/gap-trigger-two.json";
  const wrongTypeEventRef = "events/wrong-trigger-type.json";
  const foreignEventRef = "events/foreign-trigger.json";
  const firstEvent = triggerEvent(runId, "gap_trigger_one");
  const secondEvent = triggerEvent(runId, "gap_trigger_two");
  const wrongTypeDocument = {
    schema_version: "startup_opportunity.decision.v1",
    decision_id: "wrong_trigger_type",
    run_id: runId,
    decision_type: "plan_change_requested_by_user",
    timestamp: "2026-07-24T12:08:00Z",
    actor: "main_agent",
    reason: "This valid Decision must not be accepted as an Event.",
    artifact_refs: [],
  };
  const foreignEvent = triggerEvent("gap-cycle-foreign-run", "gap_trigger_foreign");
  const currentBundle = bundle(
    runManifest,
    plan,
    planningContext,
    gapSnapshot(runId),
    retryDecision(runId),
    [
      { path: firstEventRef, document: firstEvent },
      { path: secondEventRef, document: secondEvent },
      { path: wrongTypeEventRef, document: wrongTypeDocument },
      { path: foreignEventRef, document: foreignEvent },
    ],
  );
  const analyzer = await createGapAnalyzer(repositoryRoot);
  const input = {
    documentBundle: currentBundle,
    snapshotId: "gap_event_cycle_001",
    createdAt: "2026-07-24T12:09:00Z",
    triggerKind: "artifact_validation_failed" as const,
    phase: "enrichment",
    waveId: null,
    triggerEventRef: `${firstEventRef}#gap_trigger_one`,
    observedArtifactRefs: [`${GAP_REF}#gap_runtime_001`],
    materialNewEvidenceObserved: true,
  };
  const first = analyzer.analyze(input);
  const replay = analyzer.analyze(input);
  assert.equal(first.valid, true, JSON.stringify(first.errors));
  assert.equal(first.snapshot?.snapshot_cycle_key, replay.snapshot?.snapshot_cycle_key);
  assert.equal(first.snapshot?.revision, 1);

  const secondEventCycle = analyzer.analyze({
    ...input,
    snapshotId: "gap_event_cycle_002",
    triggerEventRef: secondEventRef,
  });
  assert.equal(secondEventCycle.valid, true, JSON.stringify(secondEventCycle.errors));
  assert.notEqual(
    secondEventCycle.snapshot?.snapshot_cycle_key,
    first.snapshot?.snapshot_cycle_key,
  );
  assert.equal(secondEventCycle.snapshot?.revision, 1);

  const changedPlanBundle = clone(currentBundle);
  const changedPlan = changedPlanBundle.documents.find((entry) => entry.path === PLAN_REF)
    ?.document as Record<string, unknown>;
  const questions = changedPlan.research_questions as Record<string, unknown>[];
  assert.ok(questions[0]);
  questions[0].question = "Which changed base Plan identity governs this same event?";
  const changedContext = changedPlanBundle.documents.find((entry) => entry.path === CONTEXT_REF)
    ?.document as Record<string, unknown>;
  const targetBinding = changedContext.target_plan_binding as Record<string, unknown>;
  targetBinding.plan_content_hash = canonicalContentHash(changedPlan);
  const changedPlanCycle = analyzer.analyze({
    ...input,
    documentBundle: changedPlanBundle,
    snapshotId: "gap_event_cycle_003",
  });
  assert.equal(changedPlanCycle.valid, true, JSON.stringify(changedPlanCycle.errors));
  assert.notEqual(
    changedPlanCycle.snapshot?.snapshot_cycle_key,
    first.snapshot?.snapshot_cycle_key,
  );
  assert.equal(changedPlanCycle.snapshot?.revision, 1);

  const wrongEventType = analyzer.analyze({
    ...input,
    triggerEventRef: wrongTypeEventRef,
  });
  assert.equal(wrongEventType.valid, false);
  assert.ok(
    wrongEventType.errors.some((error) => error.code === "gap.trigger_event_type_mismatch"),
  );

  const missingEventFragment = analyzer.analyze({
    ...input,
    triggerEventRef: `${firstEventRef}#missing_event`,
  });
  assert.equal(missingEventFragment.valid, false);
  assert.ok(
    missingEventFragment.errors.some((error) => error.code === "gap.reference_fragment_missing"),
  );

  const missingObservedFragment = analyzer.analyze({
    ...input,
    observedArtifactRefs: [`${GAP_REF}#missing_gap`],
  });
  assert.equal(missingObservedFragment.valid, false);
  assert.ok(
    missingObservedFragment.errors.some((error) => error.code === "gap.reference_fragment_missing"),
  );

  const assertRunMismatch = (result: ReturnType<typeof analyzer.analyze>) => {
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === "gap.reference_run_mismatch"));
  };
  assertRunMismatch(
    analyzer.analyze({
      ...input,
      observedArtifactRefs: [`${foreignEventRef}#gap_trigger_foreign`],
    }),
  );
  assertRunMismatch(
    analyzer.analyze({
      ...input,
      machineChecks: [
        {
          checkId: "foreign_basis",
          gapType: "freshness_failed",
          subjectRef: PLAN_REF,
          basisRefs: [`${foreignEventRef}#gap_trigger_foreign`],
          evidenceRefs: [],
          decisionImpact: ["execution_validity"],
          severity: "blocking",
          detail: "A foreign-Run basis must be rejected.",
        },
      ],
    }),
  );
  assertRunMismatch(
    analyzer.analyze({
      ...input,
      machineChecks: [
        {
          checkId: "foreign_evidence",
          gapType: "freshness_failed",
          subjectRef: PLAN_REF,
          basisRefs: [PLAN_REF],
          evidenceRefs: [`${foreignEventRef}#gap_trigger_foreign`],
          decisionImpact: ["execution_validity"],
          severity: "blocking",
          detail: "Foreign-Run evidence must be rejected.",
        },
      ],
    }),
  );
  assertRunMismatch(
    analyzer.analyze({
      ...input,
      triggerEventRef: `${foreignEventRef}#gap_trigger_foreign`,
    }),
  );
  assertRunMismatch(
    analyzer.analyze({
      ...input,
      repeatedSourceRefs: [`${foreignEventRef}#gap_trigger_foreign`],
    }),
  );
});

test("Adaptation validator accepts all closed actions and rejects retry outside failed_units", async () => {
  const scenario = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "tests/fixtures/g0.4/plan-adaptation-cases.json"),
      "utf8",
    ),
  ) as { valid_actions: string[] };
  const validator = await createAdaptationPolicyValidator(repositoryRoot);
  for (const action of scenario.valid_actions) {
    const runId = `adapt-${action.replaceAll("_", "-")}`;
    const plan = basePlan(runId);
    const runManifest = manifest(runId, plan);
    let gap = gapSnapshot(runId);
    const decision = retryDecision(runId);
    decision.adaptation_id = `adapt_${action}`;
    decision.action = action;
    decision.created_at = "2026-07-24T12:05:00Z";
    delete decision.target_unit;
    delete decision.target_unit_ref;
    delete decision.retry_basis;
    delete decision.priority_band;
    delete decision.coverage_attestation_ref;
    delete decision.clarification_question;
    delete decision.stop_condition;
    delete decision.success_condition;
    const extras: { path: string; document: Record<string, unknown> }[] = [];
    if (action === "add_unit") {
      decision.target_unit = unit(
        "added_unit",
        "acquisition",
        "artifacts/discovery/enrichment/branches/added_unit.attempt-1.json",
      );
      decision.success_condition = "The new unit resolves the explicit gap.";
    } else if (action === "cancel_unit") {
      decision.target_unit_ref = `${PLAN_REF}#buyer_active`;
      decision.success_condition = "The active unit stops or its result is ignored.";
    } else if (action === "skip_unit") {
      decision.target_unit_ref = `${PLAN_REF}#value_pending`;
      decision.success_condition = "The pending unit remains unstarted.";
    } else if (action === "reprioritize_unit") {
      decision.target_unit_ref = `${PLAN_REF}#value_pending`;
      decision.priority_band = "high";
      decision.success_condition = "The pending unit uses the new priority.";
    } else if (action === "retry_unit") {
      Object.assign(decision, retryDecision(runId));
    } else if (action === "supersede_unit") {
      decision.target_unit_ref = `${PLAN_REF}#buyer_active`;
      decision.target_unit = unit(
        "buyer_superseding",
        "buyer_language",
        "artifacts/discovery/enrichment/branches/buyer_superseding.attempt-2.json",
        { attempt: 2, supersedes_unit_ref: `${PLAN_REF}#buyer_active` },
      );
      decision.success_condition = "The replacement unit produces a new output.";
    } else if (action === "continue_existing_plan") {
      gap = gapSnapshot(runId, "evidence_insufficient", SUBJECT_REF);
      const gapRef = `${GAP_REF}#gap_runtime_001`;
      const targetRef = `${PLAN_REF}#value_pending`;
      const identity = {
        schema_version: "startup_opportunity.coverage_attestation.v1" as const,
        relation: "same_subject_and_semantically_equivalent_research_goal" as const,
        run_id: runId,
        based_on_plan_ref: PLAN_REF,
        based_on_plan_revision: 1,
        based_on_plan_hash: canonicalContentHash(plan),
        gap_ref: gapRef,
        subject_ref: SUBJECT_REF,
        target_unit_ref: targetRef,
        gap_research_goal: "Resolve the explicit evidence gap.",
        target_research_goal: "Research value_pending for the explicit subject.",
      };
      const coverage = {
        ...identity,
        coverage_key: coverageKey(identity),
        semantic_equivalence_declared: true,
        declared_by: "main_agent",
        created_at: "2026-07-24T12:04:30Z",
      };
      const coverageRef = "adaptations/coverage/coverage-runtime.json";
      extras.push({ path: coverageRef, document: coverage });
      decision.target_unit_ref = targetRef;
      decision.coverage_attestation_ref = coverageRef;
      decision.success_condition = "The existing unit resolves the same declared goal.";
    } else if (action === "request_clarification") {
      decision.clarification_question = "Which explicit scope should the Run use?";
      decision.success_condition = "The user supplies the missing scope value.";
    } else if (action === "stop_followup") {
      gap = gapSnapshot(runId, "no_material_new_evidence", PLAN_REF);
      decision.stop_condition = "The explicit no-new-evidence stop signal is present.";
    } else if (action === "record_runtime_failure") {
      gap = gapSnapshot(runId, "runtime_blocked", PLAN_REF);
      gap.stop_signals = ["runtime_blocked"];
      decision.stop_condition = "The blocking runtime failure remains unresolved.";
    } else if (action === "terminate_insufficient_evidence") {
      decision.stop_condition = "The blocking gap cannot be resolved under current scope.";
      runManifest.followup_round = 2;
    }
    const planningContext = context(runManifest, plan, {
      path: CONTEXT_REF,
      revision: 1,
      parentRef: null,
      stage: "current_plan",
      createdAt: "2026-07-24T12:03:00Z",
    });
    const result = validator.validateDocumentBundle(
      bundle(runManifest, plan, planningContext, gap, decision, extras),
    );
    assert.equal(result.valid, true, `${action}: ${JSON.stringify(result, null, 2)}`);
  }

  const modeMismatchRunId = "adapt-mode-mismatch";
  const modeMismatchPlan = basePlan(modeMismatchRunId);
  const modeMismatchManifest = manifest(modeMismatchRunId, modeMismatchPlan);
  modeMismatchManifest.mode = "concept_evidence_assessment";
  const modeMismatchContext = context(modeMismatchManifest, modeMismatchPlan, {
    path: CONTEXT_REF,
    revision: 1,
    parentRef: null,
    stage: "current_plan",
    createdAt: "2026-07-24T12:03:00Z",
  });
  const modeMismatch = validator.validateDocumentBundle(
    bundle(
      modeMismatchManifest,
      modeMismatchPlan,
      modeMismatchContext,
      gapSnapshot(modeMismatchRunId),
      retryDecision(modeMismatchRunId),
    ),
  );
  assert.ok(
    modeMismatch.adaptationErrors.some((error) => error.code === "adaptation.run_mode_mismatch"),
  );

  const runId = "adapt-retry-not-failed";
  const plan = basePlan(runId);
  const runManifest = manifest(runId, plan);
  runManifest.failed_units = [];
  runManifest.completed_units = ["counter_completed", "acquisition_failed"];
  const planningContext = context(runManifest, plan, {
    path: CONTEXT_REF,
    revision: 1,
    parentRef: null,
    stage: "current_plan",
    createdAt: "2026-07-24T12:03:00Z",
  });
  const result = validator.validateDocumentBundle(
    bundle(runManifest, plan, planningContext, gapSnapshot(runId), retryDecision(runId)),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.planValidation.planningContract.contractErrors.some(
      (error) => error.code === "contract.retry_target_not_failed",
    ),
  );

  const terminateRunId = "adapt-terminate-followup-available";
  const terminatePlan = basePlan(terminateRunId);
  const terminateManifest = manifest(terminateRunId, terminatePlan);
  const terminateContext = context(terminateManifest, terminatePlan, {
    path: CONTEXT_REF,
    revision: 1,
    parentRef: null,
    stage: "current_plan",
    createdAt: "2026-07-24T12:03:00Z",
  });
  const terminateGap = gapSnapshot(terminateRunId);
  const terminateDecision = retryDecision(terminateRunId);
  terminateDecision.action = "terminate_insufficient_evidence";
  terminateDecision.stop_condition = "The blocking gap cannot be resolved under current scope.";
  delete terminateDecision.target_unit_ref;
  delete terminateDecision.target_unit;
  delete terminateDecision.retry_basis;
  delete terminateDecision.success_condition;
  const available = validator.validateDocumentBundle(
    bundle(terminateManifest, terminatePlan, terminateContext, terminateGap, terminateDecision),
  );
  assert.ok(
    available.adaptationErrors.some(
      (error) => error.code === "adaptation.termination_followup_available",
    ),
  );
  const runtimeBlockedGap = gapSnapshot(terminateRunId);
  const runtimeBlockedEntry = (runtimeBlockedGap.gaps as Record<string, unknown>[])[0];
  assert.ok(runtimeBlockedEntry);
  runtimeBlockedEntry.gap_type = "runtime_blocked";
  runtimeBlockedEntry.recommended_unit_types = [];
  runtimeBlockedGap.stop_signals = ["runtime_blocked"];
  const runtimeBlocked = validator.validateDocumentBundle(
    bundle(
      terminateManifest,
      terminatePlan,
      terminateContext,
      runtimeBlockedGap,
      terminateDecision,
    ),
  );
  assert.ok(
    runtimeBlocked.adaptationErrors.some(
      (error) => error.code === "adaptation.termination_runtime_blocked",
    ),
  );
  const unclosed = bundle(
    terminateManifest,
    terminatePlan,
    terminateContext,
    terminateGap,
    terminateDecision,
  );
  const unclosedDecision = unclosed.documents.find((entry) => entry.path === DECISION_REF) as
    | { path: string; document: Record<string, unknown> }
    | undefined;
  assert.ok(unclosedDecision);
  unclosedDecision.document = formalEnvelope(
    terminateRunId,
    DECISION_REF,
    terminateDecision,
    [PLAN_REF, GAP_REF, CONTEXT_REF],
    "startup_opportunity.artifact_envelope.current",
  );
  assert.ok(
    validator
      .validateDocumentBundle(unclosed)
      .adaptationErrors.some((error) => error.code === "adaptation.termination_basis_unclosed"),
  );
  terminateManifest.followup_round = 2;
  assert.equal(
    validator.validateDocumentBundle(
      bundle(terminateManifest, terminatePlan, terminateContext, terminateGap, terminateDecision),
    ).valid,
    true,
  );
});

test("current Gap and Decision publication and recovery project Manifest lifecycle", async (contextTest) => {
  const runId = "runtime-v5-control-projection";
  const setup = await setupPersistedRun(contextTest, runId);
  const gapPath = "adaptations/gap-snapshots/gap-runtime-v5.r2.json";
  const gap = clone(setup.gap);
  gap.snapshot_id = "gap_runtime_snapshot_v5";
  gap.revision = 2;
  gap.parent_snapshot_ref = GAP_REF;
  gap.created_at = "2026-07-24T12:08:00Z";
  const gapEntry = (gap.gaps as Record<string, unknown>[])[0];
  assert.ok(gapEntry);
  gapEntry.gap_id = "gap_runtime_v5";
  const gapEnvelope = formalEnvelope(
    runId,
    gapPath,
    gap,
    [PLAN_REF],
    "startup_opportunity.artifact_envelope.current",
  );
  await assert.rejects(
    setup.store.publishArtifact({ runId, envelope: gapEnvelope, faultAt: "after_publish" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  assert.equal((await setup.store.load(runId)).manifest.latest_gap_snapshot_ref, gapPath);

  const decisionPath = "adaptations/decisions/adapt-retry-runtime-v5.json";
  const decision = retryDecision(runId);
  decision.adaptation_id = "adapt_retry_runtime_v5";
  decision.trigger_gap_refs = [`${gapPath}#gap_runtime_v5`];
  decision.created_at = "2026-07-24T12:09:00Z";
  const decisionEnvelope = formalEnvelope(
    runId,
    decisionPath,
    decision,
    [PLAN_REF, gapPath],
    "startup_opportunity.artifact_envelope.current",
  );
  await assert.rejects(
    setup.store.publishArtifact({
      runId,
      envelope: decisionEnvelope,
      faultAt: "after_publish",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await setup.store.load(runId);
  assert.equal(reopened.manifest.latest_gap_snapshot_ref, gapPath);
  assert.ok(reopened.manifest.pending_adaptation_refs.includes(decisionPath));
});

test("candidate pre-kill skips only an exact exclusive pending unit and replays immutably", async (contextTest) => {
  const runId = "runtime-pre-kill-exact";
  const setup = await setupPersistedRun(contextTest, runId, "pre-kill-exact");
  const validator = await createAdaptationPolicyValidator(repositoryRoot);
  const preflight = validator.validateDocumentBundle(setup.adaptationBundle);
  assert.equal(preflight.valid, true, JSON.stringify(preflight, null, 2));
  const { candidateBundle } = candidateFor(setup, PRE_KILL_APPLY_AT, PRE_KILL_CONTEXT_AT);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = preKillApplyInput(setup, candidateBundle);
  assert.equal((await runtime.apply(input)).status, "applied");
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");
  const reopened = await setup.store.load(runId);
  assert.equal(reopened.manifest.current_plan_ref, "plans/research-plan.r2.json");
  assert.ok(reopened.manifest.skipped_units.includes("value_pending"));
  const currentPlan = JSON.parse(
    await readFile(path.join(setup.runRoot, "plans/research-plan.r2.json"), "utf8"),
  ) as FormalArtifactEnvelope;
  const units = (currentPlan.document.waves as { units: Record<string, unknown>[] }[]).flatMap(
    (wave) => wave.units,
  );
  assert.equal(
    units.find((candidate) => candidate.unit_id === "value_pending")?.plan_disposition,
    "skipped",
  );
  assert.deepEqual(reopened.planOperationRecovery.historicalDiscoveryPlanBindings, [
    {
      planRef: PLAN_REF,
      planHash: canonicalContentHash(setup.plan),
      planRevision: 1,
      candidateRefs: [PRE_KILL_CANDIDATE_REF],
    },
  ]);
  const assembled = await setup.store.buildValidationContext(runId, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [{ path: "plans/research-plan.r2.json", document: currentPlan }],
    exact_records: [],
  });
  assert.deepEqual(
    assembled.referenceContext.historicalDiscoveryPlanBindings,
    reopened.planOperationRecovery.historicalDiscoveryPlanBindings,
  );
});

test("candidate-bound historical Plan views always revalidate G2.1 maps and G2.2 candidates", async (t) => {
  for (const scenario of [
    {
      name: "g2-1-map-profile-drift",
      artifactPath: G21_SOLUTION_REF,
      expectedDomainCode: "discovery_maps.profile_mismatch",
      mutate: (document: Record<string, unknown>) => {
        document.discovery_profile = "industry_first";
      },
    },
    {
      name: "g2-2-unbound-candidate-profile-drift",
      artifactPath: RETAINED_SHARED_CANDIDATE_REF,
      expectedDomainCode: "discovery_candidate.scope_identity_mismatch",
      mutate: (document: Record<string, unknown>) => {
        document.discovery_profile = "industry_first";
      },
    },
  ] as const) {
    await t.test(`${scenario.name}-reopen`, async (contextTest) => {
      const runId = `runtime-historical-${scenario.name}-reopen`;
      const setup = await setupPersistedRun(contextTest, runId, "pre-kill-exact");
      const { candidateBundle } = candidateFor(setup, PRE_KILL_APPLY_AT, PRE_KILL_CONTEXT_AT);
      await (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply(
        preKillApplyInput(setup, candidateBundle),
      );
      await rewriteStoredArtifactAndReceipt(setup.runRoot, scenario.artifactPath, scenario.mutate);
      await assert.rejects(setup.store.load(runId), (error: unknown) => {
        return (
          error instanceof StoreError &&
          error.code === "recovery.reference_invalid" &&
          storeReferenceCodes(error).includes(scenario.expectedDomainCode)
        );
      });
    });

    await t.test(`${scenario.name}-pending-replay`, async (contextTest) => {
      const runId = `runtime-historical-${scenario.name}-replay`;
      const setup = await setupPersistedRun(contextTest, runId, "pre-kill-exact");
      const { candidateBundle } = candidateFor(setup, PRE_KILL_APPLY_AT, PRE_KILL_CONTEXT_AT);
      const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
      const input = preKillApplyInput(setup, candidateBundle, { faultAt: "after_intent" });
      await assert.rejects(
        runtime.apply(input),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      await rewriteStoredArtifactAndReceipt(setup.runRoot, scenario.artifactPath, scenario.mutate);
      const { faultAt: _faultAt, ...replayInput } = input;
      await assert.rejects(runtime.apply(replayInput), (error: unknown) => {
        return (
          error instanceof StoreError &&
          error.code === "artifact.reference_invalid" &&
          storeReferenceCodes(error).includes(scenario.expectedDomainCode)
        );
      });
      assert.ok(
        !(await readdir(path.join(setup.runRoot, "plans"))).includes("research-plan.r2.json"),
      );
    });
  }
});

test("candidate pre-kill rejects malformed typed candidate bindings before every write", async (t) => {
  const scenarios: readonly {
    readonly name: string;
    readonly mutate: (bundleValue: DocumentBundle) => void;
  }[] = [
    {
      name: "missing-envelope",
      mutate: (bundleValue) => {
        const entries = bundleValue.documents as {
          path: string;
          document: Record<string, unknown>;
        }[];
        const index = entries.findIndex((entry) => entry.path === PRE_KILL_CANDIDATE_REF);
        assert.notEqual(index, -1);
        entries.splice(index, 1);
      },
    },
    {
      name: "null-envelope",
      mutate: (bundleValue) => {
        mutableBundleEntry(bundleValue, PRE_KILL_CANDIDATE_REF).document = null as never;
      },
    },
    {
      name: "non-envelope",
      mutate: (bundleValue) => {
        const entry = mutableBundleEntry(bundleValue, PRE_KILL_CANDIDATE_REF);
        const envelopeValue = entry.document;
        assert.ok(typeof envelopeValue.document === "object" && envelopeValue.document !== null);
        entry.document = clone(envelopeValue.document as Record<string, unknown>);
      },
    },
    {
      name: "wrong-artifact-type",
      mutate: (bundleValue) => {
        mutablePreKillEnvelope(bundleValue).artifact_type =
          "startup_opportunity.solution_hypothesis.v1";
      },
    },
    {
      name: "wrong-run",
      mutate: (bundleValue) => {
        mutablePreKillEnvelope(bundleValue).run_id = "runtime-pre-kill-another-run";
      },
    },
    {
      name: "wrong-plan",
      mutate: (bundleValue) => {
        const envelopeValue = mutablePreKillEnvelope(bundleValue);
        const document = envelopeValue.document as Record<string, unknown>;
        document.research_plan_ref = "plans/research-plan.r9.json";
        envelopeValue.content_hash = canonicalContentHash(document);
      },
    },
    {
      name: "wrong-content-hash",
      mutate: (bundleValue) => {
        mutablePreKillEnvelope(bundleValue).content_hash = `sha256:${"0".repeat(64)}`;
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (contextTest) => {
      const runId = `runtime-pre-kill-binding-${scenario.name}`;
      const setup = await setupPersistedRun(contextTest, runId, "pre-kill-exact");
      const malformed = clone(setup.adaptationBundle);
      scenario.mutate(malformed);
      const validation = (
        await createAdaptationPolicyValidator(repositoryRoot)
      ).validateDocumentBundle(malformed);
      assert.equal(validation.valid, false);
      assert.ok(
        validation.adaptationErrors.some(
          (error) => error.code === "adaptation.pre_kill_candidate_binding_invalid",
        ),
        JSON.stringify(validation, null, 2),
      );

      const before = await planApplyBoundaryState(setup.runRoot);
      const { candidateBundle } = candidateFor(setup, PRE_KILL_APPLY_AT, PRE_KILL_CONTEXT_AT);
      await assert.rejects(
        (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
          ...preKillApplyInput(setup, candidateBundle),
          adaptationBundle: malformed,
        }),
        (error: unknown) =>
          error instanceof StoreError &&
          error.code === "adaptation.pre_kill_candidate_binding_invalid",
      );
      assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
    });
  }
});

test("candidate pre-kill rejects missing and shared target bindings before writes", async (t) => {
  for (const scenario of [
    {
      suffix: "missing",
      action: "pre-kill-missing",
      expectedCode: "adaptation.pre_kill_candidate_target_mismatch",
    },
    {
      suffix: "shared",
      action: "pre-kill-shared",
      expectedCode: "adaptation.pre_kill_shared_candidate_skip_forbidden",
    },
  ] as const) {
    await t.test(scenario.suffix, async (contextTest) => {
      const runId = `runtime-pre-kill-${scenario.suffix}`;
      const setup = await setupPersistedRun(contextTest, runId, scenario.action);
      const result = (await createAdaptationPolicyValidator(repositoryRoot)).validateDocumentBundle(
        setup.adaptationBundle,
      );
      assert.equal(result.valid, false);
      assert.ok(
        result.adaptationErrors.some((error) => error.code === scenario.expectedCode),
        JSON.stringify(result.adaptationErrors, null, 2),
      );
      const before = await planApplyBoundaryState(setup.runRoot);
      const { candidateBundle } = candidateFor(setup, PRE_KILL_APPLY_AT, PRE_KILL_CONTEXT_AT);
      await assert.rejects(
        (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
          runId,
          adaptationBundle: setup.adaptationBundle,
          adaptationRefs: [DECISION_REF],
          candidateBundle,
          createdAt: PRE_KILL_APPLY_AT,
          checkpointCreatedAt: PRE_KILL_CHECKPOINT_AT,
          nextStep: "Reject a candidate pre-kill target that is not exclusive.",
          beliefSummary: {
            current_belief: "Shared or unrelated candidate units must remain current.",
            evidence_that_changed_belief: [],
            unchanged_assumptions: [],
            remaining_disagreement: [],
            next_decision_relevant_question: "Is the exact target candidate the sole input?",
          },
        }),
        (error: unknown) => {
          if (!(error instanceof StoreError) || error.code !== "adaptation.policy_invalid") {
            return false;
          }
          const validation = error.details.result as
            | { adaptationErrors?: readonly { code?: string }[] }
            | undefined;
          return validation?.adaptationErrors?.some(
            (candidate) => candidate.code === scenario.expectedCode,
          );
        },
      );
      assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
      const reopened = await setup.store.load(runId);
      assert.equal(reopened.manifest.current_plan_ref, PLAN_REF);
      assert.ok(!reopened.manifest.skipped_units.includes("value_pending"));
    });
  }
});

test("candidate pre-kill crash leaves a pending intent and exact replay completes recovery", async (contextTest) => {
  const runId = "runtime-pre-kill-crash";
  const setup = await setupPersistedRun(contextTest, runId, "pre-kill-exact");
  const { candidateBundle } = candidateFor(setup, PRE_KILL_APPLY_AT, PRE_KILL_CONTEXT_AT);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = {
    runId,
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: PRE_KILL_APPLY_AT,
    checkpointCreatedAt: PRE_KILL_CHECKPOINT_AT,
    nextStep: "Recover the exact candidate pre-kill decision.",
    beliefSummary: {
      current_belief: "The pre-kill skip is not current before Plan CAS.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Can the validated intent replay exactly?",
    },
    faultAt: "after_intent" as const,
  };
  await assert.rejects(
    runtime.apply(input),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await setup.store.load(runId);
  assert.equal(reopened.manifest.current_plan_ref, PLAN_REF);
  assert.equal(reopened.planOperationRecovery.pendingOperationKeys.length, 1);
  const { faultAt: _faultAt, ...replayInput } = input;
  assert.equal((await runtime.apply(replayInput)).status, "idempotent_replay");
  const recovered = await setup.store.load(runId);
  assert.equal(recovered.manifest.current_plan_ref, "plans/research-plan.r2.json");
  assert.ok(recovered.manifest.skipped_units.includes("value_pending"));
});

test("ordinary post-G2 add_unit receipts bind every durable base-Plan candidate", async (contextTest) => {
  const runId = "runtime-post-g2-add";
  const setup = await setupPersistedRun(contextTest, runId, "post-g2-add");
  const { candidateBundle } = candidateFor(setup, PRE_KILL_APPLY_AT, PRE_KILL_CONTEXT_AT);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const result = await runtime.apply({
    runId,
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: PRE_KILL_APPLY_AT,
    checkpointCreatedAt: PRE_KILL_CHECKPOINT_AT,
    nextStep: "Run the bounded post-G2 follow-up unit.",
    beliefSummary: {
      current_belief: "The durable G2 candidates remain bound to the base Plan.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does the follow-up change the candidate set?",
    },
  });
  assert.equal(result.status, "applied");

  const receipt = JSON.parse(
    await readFile(await planReceiptFile(setup.runRoot), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(
    receipt.schema_version,
    "startup_opportunity.plan_revision_operation.discovery.current",
  );
  const bindings = receipt.candidate_bindings as Record<string, unknown>[];
  assert.deepEqual(
    bindings.map((binding) => binding.candidate_ref),
    [
      "artifacts/discovery/candidates/candidate_baseline.r1.json",
      PRE_KILL_CANDIDATE_REF,
      RETAINED_SHARED_CANDIDATE_REF,
    ],
  );

  const reopened = await setup.store.load(runId);
  assert.equal(reopened.manifest.current_plan_ref, "plans/research-plan.r2.json");
  assert.deepEqual(reopened.planOperationRecovery.historicalDiscoveryPlanBindings, [
    {
      planRef: PLAN_REF,
      planHash: canonicalContentHash(setup.plan),
      planRevision: 1,
      candidateRefs: [
        "artifacts/discovery/candidates/candidate_baseline.r1.json",
        PRE_KILL_CANDIDATE_REF,
        RETAINED_SHARED_CANDIDATE_REF,
      ],
    },
  ]);
});

test("a later same-Run adaptation preserves receipt-bound historical discovery validation", async (contextTest) => {
  const runId = "runtime-post-g2-historical-followup";
  const setup = await setupPersistedRun(contextTest, runId, "post-g2-add");
  const { candidateBundle } = candidateFor(setup, PRE_KILL_APPLY_AT, PRE_KILL_CONTEXT_AT);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const first = await runtime.apply({
    runId,
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: PRE_KILL_APPLY_AT,
    checkpointCreatedAt: PRE_KILL_CHECKPOINT_AT,
    nextStep: "Observe the next bounded Gap on the revised Plan.",
    beliefSummary: {
      current_belief: "The G2 candidates remain bound to the Plan that produced them.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does the next bounded cycle add material evidence?",
    },
  });
  assert.equal(first.currentPlanRef, "plans/research-plan.r2.json");

  const gapPath = "adaptations/gap-snapshots/gap-post-g2-followup.r2.json";
  const gap = gapSnapshot(runId, "no_material_new_evidence", first.currentPlanRef);
  gap.snapshot_id = "gap_post_g2_followup";
  gap.snapshot_cycle_key = setup.gap.snapshot_cycle_key;
  gap.based_on_plan_ref = first.currentPlanRef;
  gap.revision = 2;
  gap.parent_snapshot_ref = GAP_REF;
  gap.created_at = "2026-07-28T12:10:00Z";
  const gapEntry = (gap.gaps as Record<string, unknown>[])[0];
  assert.ok(gapEntry);
  gapEntry.gap_id = "gap_post_g2_followup";
  gapEntry.basis_refs = ["manifest.json", first.currentPlanRef];
  const gapEnvelope = formalEnvelope(
    runId,
    gapPath,
    gap,
    [first.currentPlanRef, GAP_REF],
    "startup_opportunity.artifact_envelope.current",
  );
  await setup.store.publishArtifact({ runId, envelope: gapEnvelope });

  const decisionPath = "adaptations/decisions/adapt-post-g2-followup-stop.json";
  const decision = stopFollowupDecision(runId);
  decision.adaptation_id = "adapt_post_g2_followup_stop";
  decision.based_on_plan_ref = first.currentPlanRef;
  decision.trigger_gap_refs = [`${gapPath}#gap_post_g2_followup`];
  decision.created_at = "2026-07-28T12:11:00Z";
  const decisionEnvelope = formalEnvelope(
    runId,
    decisionPath,
    decision,
    [first.currentPlanRef, gapPath],
    "startup_opportunity.artifact_envelope.current",
  );
  await setup.store.publishArtifact({ runId, envelope: decisionEnvelope });

  const currentContextPath = "plans/planning-context.r2.json";
  const currentContextEnvelope = JSON.parse(
    await readFile(path.join(setup.runRoot, currentContextPath), "utf8"),
  ) as FormalArtifactEnvelope;
  const historicalClosurePaths = [
    ...G21_MAP_REFS,
    "artifacts/discovery/candidates/candidate_baseline.r1.json",
    PRE_KILL_CANDIDATE_REF,
    RETAINED_SHARED_CANDIDATE_REF,
  ];
  const historicalClosure = await Promise.all(
    historicalClosurePaths.map(async (artifactPath) => ({
      path: artifactPath,
      document: JSON.parse(
        await readFile(path.join(setup.runRoot, artifactPath), "utf8"),
      ) as FormalArtifactEnvelope,
    })),
  );
  const assembled = await setup.store.buildValidationContext(runId, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: decisionPath, document: decisionEnvelope },
      { path: currentContextPath, document: currentContextEnvelope },
      ...historicalClosure,
    ],
    exact_records: [],
  });
  const assembledContexts = assembled.bundle.documents.flatMap((entry) => {
    const envelope = entry.document as Record<string, unknown>;
    const document =
      envelope.artifact_type === "startup_opportunity.planning_context.ai_source_bound.current"
        ? (envelope.document as Record<string, unknown>)
        : envelope.schema_version === "startup_opportunity.planning_context.ai_source_bound.current"
          ? envelope
          : null;
    return document === null
      ? []
      : [
          {
            path: entry.path,
            stage: document.validation_stage,
            parent: document.parent_context_ref,
            target: (document.target_plan_binding as Record<string, unknown>).plan_ref,
          },
        ];
  });
  assert.deepEqual(assembledContexts, [
    {
      path: CONTEXT_REF,
      stage: "current_plan",
      parent: null,
      target: PLAN_REF,
    },
    {
      path: currentContextPath,
      stage: "candidate_revision",
      parent: CONTEXT_REF,
      target: first.currentPlanRef,
    },
  ]);
  const second = await runtime.apply({
    runId,
    adaptationBundle: assembled.bundle,
    adaptationRefs: [decisionPath],
    createdAt: "2026-07-28T12:12:00Z",
    checkpointCreatedAt: "2026-07-28T12:13:00Z",
    nextStep: "Keep the revised Plan and close the bounded follow-up.",
    beliefSummary: {
      current_belief: "The bounded follow-up added no material evidence.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "What new evidence would change the decision?",
    },
  });
  assert.equal(second.status, "applied");
  assert.equal(second.revisionCreated, false);
  assert.equal(second.currentPlanRef, first.currentPlanRef);
});

test("current adaptation planning preserves the complete G2.1/G2.2 envelope closure", async (contextTest) => {
  const runId = "runtime-current-discovery-adaptation-closure";
  const setup = await setupPersistedRun(contextTest, runId, "post-g2-add");
  const adaptationBundle = currentDiscoveryAdaptationBundle(setup);
  const effective = (artifactPath: string) => {
    const document = adaptationBundle.documents.find(
      (entry) => entry.path === artifactPath,
    )?.document;
    assert.ok(document);
    return typeof document.artifact_type === "string"
      ? (document.document as Record<string, unknown>)
      : document;
  };
  const currentManifest = effective("manifest.json");
  const currentPlan = effective(PLAN_REF);
  const currentContext = effective(CONTEXT_REF);
  const currentDecision = effective(DECISION_REF);
  assert.deepEqual(
    {
      manifestPlanRef: currentManifest.current_plan_ref,
      manifestPlanRevision: currentManifest.plan_revision,
      planRef: PLAN_REF,
      planRevision: currentPlan.revision,
      contextPlanRef: (currentContext.target_plan_binding as Record<string, unknown>).plan_ref,
      contextStage: currentContext.validation_stage,
      decisionPlanRef: currentDecision.based_on_plan_ref,
    },
    {
      manifestPlanRef: PLAN_REF,
      manifestPlanRevision: 1,
      planRef: PLAN_REF,
      planRevision: 1,
      contextPlanRef: PLAN_REF,
      contextStage: "current_plan",
      decisionPlanRef: PLAN_REF,
    },
  );
  const validator = await createAdaptationPolicyValidator(repositoryRoot);
  const validation = validator.validateDocumentBundle(adaptationBundle);
  assert.equal(validation.valid, true, JSON.stringify(validation, null, 2));

  const candidate = adaptationBundle.documents.find(
    (entry) => entry.path === PRE_KILL_CANDIDATE_REF,
  );
  assert.equal(candidate?.document.schema_version, "startup_opportunity.artifact_envelope.current");
  const map = adaptationBundle.documents.find((entry) => entry.path === G21_MAP_REFS[0]);
  assert.equal(map?.document.schema_version, "startup_opportunity.artifact_envelope.current");

  const tampered = structuredClone(adaptationBundle);
  const tamperedCandidate = tampered.documents.find(
    (entry) => entry.path === PRE_KILL_CANDIDATE_REF,
  )?.document;
  assert.ok(tamperedCandidate);
  tamperedCandidate.producer_role = "lane_researcher";
  const rejected = validator.validateDocumentBundle(tampered);
  assert.equal(rejected.valid, false);
  assert.ok(
    rejected.planValidation.planningContract.documentBundle.documents.some(
      (document) => document.documentPath === PRE_KILL_CANDIDATE_REF && document.valid === false,
    ),
    JSON.stringify(rejected, null, 2),
  );
});

test("current Plan projection excludes an applied stale Decision and validates only the pending Decision", async (contextTest) => {
  const runId = "runtime-current-plan-projection";
  const setup = await setupPersistedRun(contextTest, runId, "post-g2-add");
  const { transformed, candidateBundle } = candidateFor(
    setup,
    PRE_KILL_APPLY_AT,
    PRE_KILL_CONTEXT_AT,
  );
  assert.ok(transformed.plan);
  const currentPlanRef = transformed.planPath;
  const currentContext = candidateBundle.documents.find(
    (entry) => entry.path === "plans/planning-context.r2.json",
  );
  assert.ok(currentContext);

  const gapPath = "adaptations/gap-snapshots/gap-runtime.r2.json";
  const currentGap = gapSnapshot(runId, "no_material_new_evidence", currentPlanRef);
  currentGap.snapshot_id = "gap_current_plan_projection";
  currentGap.snapshot_cycle_key = setup.gap.snapshot_cycle_key;
  currentGap.based_on_plan_ref = currentPlanRef;
  currentGap.revision = 2;
  currentGap.parent_snapshot_ref = GAP_REF;
  currentGap.created_at = "2026-07-28T12:10:00Z";
  const currentGapEntry = (currentGap.gaps as Record<string, unknown>[])[0];
  assert.ok(currentGapEntry);
  currentGapEntry.gap_id = "gap_current_plan_projection";
  currentGapEntry.basis_refs = ["manifest.json", currentPlanRef];

  const decisionPath = "adaptations/decisions/adapt-current-plan-stop.json";
  const currentDecision = stopFollowupDecision(runId);
  currentDecision.adaptation_id = "adapt_current_plan_stop";
  currentDecision.based_on_plan_ref = currentPlanRef;
  currentDecision.trigger_gap_refs = [`${gapPath}#gap_current_plan_projection`];
  currentDecision.created_at = "2026-07-28T12:11:00Z";

  const currentManifest = structuredClone(transformed.manifest) as unknown as Record<
    string,
    unknown
  >;
  currentManifest.latest_gap_snapshot_ref = gapPath;
  currentManifest.pending_adaptation_refs = [decisionPath];
  currentManifest.applied_adaptation_refs = [DECISION_REF];
  currentManifest.updated_at = "2026-07-28T12:11:00Z";

  const projectionBundle = currentDiscoveryAdaptationBundle(setup);
  const byPath = new Map(projectionBundle.documents.map((entry) => [entry.path, entry]));
  byPath.set("manifest.json", { path: "manifest.json", document: currentManifest });
  byPath.set(currentPlanRef, {
    path: currentPlanRef,
    document: transformed.plan,
  });
  byPath.set(currentContext.path, structuredClone(currentContext));
  byPath.set(gapPath, { path: gapPath, document: currentGap });
  byPath.set(decisionPath, { path: decisionPath, document: currentDecision });
  const currentBundle: DocumentBundle = {
    ...projectionBundle,
    documents: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };

  const referenceContext = {
    historicalDiscoveryPlanBindings: [
      {
        planRef: PLAN_REF,
        planHash: canonicalContentHash(setup.plan),
        planRevision: 1,
        candidateRefs: [
          "artifacts/discovery/candidates/candidate_baseline.r1.json",
          PRE_KILL_CANDIDATE_REF,
          RETAINED_SHARED_CANDIDATE_REF,
        ],
      },
    ],
  };
  const validator = await createAdaptationPolicyValidator(repositoryRoot);
  const validation = validator.validateDocumentBundle(currentBundle, referenceContext);
  assert.equal(validation.valid, true, JSON.stringify(validation, null, 2));
  assert.deepEqual(validation.adaptationRefs, [decisionPath]);

  const stale = structuredClone(currentBundle);
  const staleDecision = stale.documents.find((entry) => entry.path === decisionPath)?.document;
  assert.ok(staleDecision);
  staleDecision.based_on_plan_ref = PLAN_REF;
  const rejected = validator.validateDocumentBundle(stale, referenceContext);
  assert.equal(rejected.valid, false);
  assert.ok(
    rejected.planValidation.planningContract.contractErrors.some(
      (error) => error.code === "contract.adaptation_stale_plan",
    ),
    JSON.stringify(rejected, null, 2),
  );
});

test("a divergent lifecycle operation cannot cross an unresolved Plan intent", async (contextTest) => {
  const runId = "runtime-pending-operation-conflict";
  const setup = await setupPersistedRun(contextTest, runId);
  const terminateRef = "adaptations/decisions/adapt-terminate-runtime.json";
  const terminate = retryDecision(runId);
  terminate.adaptation_id = "adapt_terminate_runtime";
  terminate.action = "terminate_insufficient_evidence";
  terminate.created_at = "2026-07-24T12:07:30Z";
  terminate.stop_condition = "The blocking gap cannot be resolved under the current scope.";
  delete terminate.target_unit_ref;
  delete terminate.target_unit;
  delete terminate.retry_basis;
  delete terminate.success_condition;
  await setup.store.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, terminateRef, terminate, [PLAN_REF, GAP_REF]),
  });
  const manifestWithBothDecisions = (await setup.store.status(runId)).manifest as unknown as Record<
    string,
    unknown
  >;
  const terminateBundle = bundle(
    manifestWithBothDecisions,
    setup.plan,
    setup.planningContext,
    setup.gap,
    terminate,
    [setup.checkpointEntry],
  );
  (
    terminateBundle.documents.find((entry) => entry.path === DECISION_REF) as { path: string }
  ).path = terminateRef;

  const { candidateBundle } = candidateFor(setup);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const retryInput = {
    runId,
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Resolve the retry intent before any lifecycle change.",
    beliefSummary: {
      current_belief: "The failed unit has one pending retry intent.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Can the exact retry replay?",
    },
  };
  await assert.rejects(
    runtime.apply({ ...retryInput, faultAt: "after_intent" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  await assert.rejects(
    runtime.apply({
      runId,
      adaptationBundle: terminateBundle,
      adaptationRefs: [terminateRef],
      createdAt: "2026-07-24T12:10:00Z",
      checkpointCreatedAt: "2026-07-24T12:11:00Z",
      nextStep: "Do not terminate across an unresolved Plan intent.",
      beliefSummary: {
        current_belief: "The prior retry intent remains unresolved.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Was the pending intent resolved?",
      },
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "apply.pending_operation_conflict",
  );
  assert.equal((await setup.store.status(runId)).manifest.status, "researching");
  assert.equal((await runtime.apply(retryInput)).status, "idempotent_replay");
});

test("terminal adaptation requires and materializes a validated main-agent decision brief", async (contextTest) => {
  const runId = "runtime-terminal-finalizer";
  const setup = await setupPersistedRun(contextTest, runId, "terminate");
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const baseInput = {
    runId,
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Deliver the validated terminal Decision Brief.",
    beliefSummary: {
      current_belief: "SYNTHETIC evidence remains insufficient after the bounded cycle.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["No market validation is claimed."],
      remaining_disagreement: ["A concrete opportunity remains unproven."],
      next_decision_relevant_question: "What evidence would justify resuming research?",
    },
  };
  const before = await planApplyBoundaryState(setup.runRoot);
  await assert.rejects(
    runtime.apply(baseInput),
    (error: unknown) =>
      error instanceof StoreError && error.code === "apply.terminal_report_source_required",
  );
  assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);

  const input = { ...baseInput, terminalReportEnvelope: terminalReportSource(runId) };
  const result = await runtime.apply(input);
  assert.equal(result.status, "applied");
  assert.equal(result.terminalReport?.status, "published");
  const terminalStatus = await setup.store.status(runId);
  assert.equal(terminalStatus.manifest.status, "insufficient_evidence");
  assert.equal(
    terminalStatus.terminalReportDisposition,
    "ready",
    JSON.stringify(terminalStatus, null, 2),
  );
  const brief = await readFile(path.join(setup.runRoot, "decision-brief.md"), "utf8");
  assert.match(brief, /暂缓形成或排序创业机会/);
  assert.doesNotMatch(brief, /insufficient_evidence/);

  const replay = await runtime.apply(input);
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.terminalReport?.status, "idempotent_replay");
});

test("Discovery runtime failure terminates and reports from the original Run", async (contextTest) => {
  const runId = "runtime-failure-original-run";
  const setup = await setupPersistedRun(contextTest, runId, "runtime-failure");
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = {
    runId,
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    terminalReportEnvelope: terminalReportSource(runId, true),
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Report the runtime failure without creating a continuation Run.",
    beliefSummary: {
      current_belief: "The runtime failure prevents a research conclusion.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Can a new Run execute after the runtime fault is fixed?",
    },
  };
  const result = await runtime.apply(input);
  assert.equal(result.status, "applied");
  assert.equal(result.terminalReport?.status, "published");
  const status = await setup.store.status(runId);
  assert.equal(status.manifest.status, "failed");
  assert.equal(status.continuationRunIds.length, 0);
  assert.equal(status.terminalReportDisposition, "ready", JSON.stringify(status, null, 2));
  const brief = await readFile(path.join(setup.runRoot, "decision-brief.md"), "utf8");
  assert.match(brief, /本次运行失败/);
  assert.match(brief, /运行受阻/);
});

test("terminal report publication fault recovers from the immutable source on reopen", async (contextTest) => {
  const runId = "runtime-terminal-report-fault";
  const setup = await setupPersistedRun(contextTest, runId, "terminate");
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  await assert.rejects(
    runtime.apply({
      runId,
      adaptationBundle: setup.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      terminalReportEnvelope: terminalReportSource(runId),
      terminalReportFaultAt: "after_report_sidecar",
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Recover terminal materialization from the immutable source.",
      beliefSummary: {
        current_belief: "The terminal source is durable before view recovery.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Can reopen complete every derived view?",
      },
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const interrupted = await setup.store.status(runId);
  assert.equal(interrupted.manifest.status, "insufficient_evidence");
  assert.equal(interrupted.terminalReportDisposition, "missing");
  const reopened = await setup.store.load(runId);
  assert.ok(
    reopened.reportRecovery.recoveredFormalArtifactPaths.includes(
      "artifacts/reporting/decision-brief.r1.json",
    ),
  );
  assert.equal(
    (await readFile(path.join(setup.runRoot, "decision-brief.md"), "utf8")).length > 0,
    true,
  );
  assert.equal((await setup.store.status(runId)).terminalReportDisposition, "ready");
});

test("post-manifest terminal fault is visible until exact replay finalizes delivery", async (contextTest) => {
  const runId = "runtime-terminal-plan-fault";
  const setup = await setupPersistedRun(contextTest, runId, "terminate");
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = {
    runId,
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    terminalReportEnvelope: terminalReportSource(runId),
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Replay terminal delivery after the Plan operation fault.",
    beliefSummary: {
      current_belief: "The terminal Plan state and terminal delivery are distinct.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Did the terminal finalizer complete?",
    },
  };
  await assert.rejects(
    runtime.apply({ ...input, faultAt: "after_manifest_update" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const interrupted = await setup.store.status(runId);
  assert.equal(interrupted.derivedExecutionDisposition, "terminal");
  assert.equal(interrupted.terminalReportDisposition, "missing");

  const replay = await runtime.apply(input);
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.terminalReport?.status, "published");
  assert.equal((await setup.store.status(runId)).terminalReportDisposition, "ready");
});

test("a completed no-revision operation does not block the next same-Plan adaptation", async (contextTest) => {
  const runId = "runtime-completed-no-revision";
  const setup = await setupPersistedRun(contextTest, runId, "stop-followup");
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const first = await runtime.apply({
    runId,
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Observe a later decision-relevant Gap on the same Plan.",
    beliefSummary: {
      current_belief: "The first bounded follow-up has stopped.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does a later Gap require another disposition?",
    },
  });
  assert.equal(first.revisionCreated, false);
  assert.equal(first.currentPlanRef, PLAN_REF);

  const nextGapRef = "adaptations/gap-snapshots/gap-runtime.r2.json";
  const nextGap = clone(setup.gap);
  nextGap.snapshot_id = "gap_runtime_snapshot_002";
  nextGap.revision = 2;
  nextGap.parent_snapshot_ref = GAP_REF;
  nextGap.created_at = "2026-07-24T12:10:00Z";
  const nextGapEntry = (nextGap.gaps as Record<string, unknown>[])[0];
  assert.ok(nextGapEntry);
  nextGapEntry.gap_id = "gap_runtime_002";
  await setup.store.publishArtifact({
    runId,
    envelope: formalEnvelope(
      runId,
      nextGapRef,
      nextGap,
      [PLAN_REF],
      "startup_opportunity.artifact_envelope.current",
    ),
  });

  const nextDecisionRef = "adaptations/decisions/adapt-stop-followup-runtime-2.json";
  const nextDecision = clone(setup.decision);
  nextDecision.adaptation_id = "adapt_stop_followup_runtime_002";
  nextDecision.trigger_gap_refs = [`${nextGapRef}#gap_runtime_002`];
  nextDecision.reason = "The later bounded cycle also reached its explicit stop signal.";
  nextDecision.created_at = "2026-07-24T12:11:00Z";
  await setup.store.publishArtifact({
    runId,
    envelope: formalEnvelope(
      runId,
      nextDecisionRef,
      nextDecision,
      [PLAN_REF, nextGapRef],
      "startup_opportunity.artifact_envelope.current",
    ),
  });

  const currentManifest = (await setup.store.status(runId)).manifest;
  const checkpointRef = currentManifest.checkpoint_ref;
  assert.ok(checkpointRef);
  const checkpointEnvelope = JSON.parse(
    await readFile(path.join(setup.runRoot, checkpointRef), "utf8"),
  ) as FormalArtifactEnvelope;
  const nextBundle: DocumentBundle = {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: "manifest.json", document: currentManifest },
      { path: PLAN_REF, document: setup.plan },
      setup.planningContext,
      { path: GAP_REF, document: setup.gap },
      { path: DECISION_REF, document: setup.decision },
      { path: nextGapRef, document: nextGap },
      { path: nextDecisionRef, document: nextDecision },
      { path: checkpointRef, document: checkpointEnvelope.document },
    ],
  };
  const second = await runtime.apply({
    runId,
    adaptationBundle: nextBundle,
    adaptationRefs: [nextDecisionRef],
    createdAt: "2026-07-24T12:12:00Z",
    checkpointCreatedAt: "2026-07-24T12:13:00Z",
    nextStep: "Continue only if a future Gap changes the decision boundary.",
    beliefSummary: {
      current_belief: "Both bounded follow-up cycles have explicit stop signals.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "What new Evidence would change the decision?",
    },
  });
  assert.equal(second.status, "applied");
  assert.equal(second.revisionCreated, false);
  assert.deepEqual((await setup.store.load(runId)).manifest.applied_adaptation_refs, [
    DECISION_REF,
    nextDecisionRef,
  ]);
});

test("a completed clarification operation remains complete across user Decision and resume", async (contextTest) => {
  const runId = "runtime-completed-clarification";
  const setup = await setupPersistedRun(contextTest, runId, "request-clarification");
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = {
    runId,
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Wait for the exact user scope Decision before resume reconciliation.",
    beliefSummary: {
      current_belief: "The Run cannot safely infer the missing scope.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Which scope boundary did the user choose?",
    },
  };
  const applied = await runtime.apply(input);
  assert.equal(applied.revisionCreated, false);
  const paused = await setup.store.status(runId);
  assert.equal(paused.manifest.status, "needs_clarification");
  assert.equal(paused.manifest.status_before_clarification, "researching");

  const proposal = await setup.store.proposeScope({
    runId,
    expectedScopeRevision: 1,
    reason: "The user supplied the explicit scope needed for later reconciliation.",
    scopeProposal: {
      geography: "Synthetic clarified geography",
      customerModel: "b2c",
      targetUsers: ["synthetic clarified user"],
      decisionGoal: "reconcile the explicit scope before resuming research",
      researchLanguage: "en-US",
    },
  });
  await setup.store.confirmScope({
    runId,
    expectedScopeProposalRevision: proposal.scopeRevision,
    expectedScopeProposalRef: proposal.scopeProposalRef,
    expectedScopeProposalHash: proposal.scopeProposalHash,
    confirmedAt: "2026-07-24T12:10:00Z",
    userConfirmationAttestation:
      "The fixture caller attests that the user reviewed and confirmed the exact clarified Scope proposal.",
  });
  const resumed = await setup.store.load(runId);
  assert.equal(resumed.planOperationRecovery.pendingOperationKeys.length, 0);
  assert.equal(resumed.manifest.status, "needs_clarification");
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");
});

test("termination basis closure is identical for bare and enveloped Decisions", async (contextTest) => {
  for (const representation of ["bare", "enveloped"] as const) {
    await contextTest.test(representation, async (subcontext) => {
      const runId = `runtime-termination-closure-${representation}`;
      const setup = await setupPersistedRun(subcontext, runId, "terminate-unclosed");
      const adaptationBundle = clone(setup.adaptationBundle);
      if (representation === "enveloped") {
        const decisionEntry = adaptationBundle.documents.find(
          (entry) => entry.path === DECISION_REF,
        );
        assert.ok(decisionEntry);
        (decisionEntry as { document: Record<string, unknown> }).document = JSON.parse(
          await readFile(path.join(setup.runRoot, DECISION_REF), "utf8"),
        ) as FormalArtifactEnvelope;
      }
      const before = await planApplyBoundaryState(setup.runRoot);
      await assert.rejects(
        (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
          runId,
          adaptationBundle,
          adaptationRefs: [DECISION_REF],
          createdAt: "2026-07-24T12:08:00Z",
          checkpointCreatedAt: "2026-07-24T12:09:00Z",
          nextStep: "Reject termination whose formal inputs exceed the latest Gap basis.",
          beliefSummary: {
            current_belief: "Termination authority must remain closed by the latest Gap.",
            evidence_that_changed_belief: [],
            unchanged_assumptions: [],
            remaining_disagreement: [],
            next_decision_relevant_question: "Are all termination inputs Gap-bound?",
          },
        }),
        (error: unknown) => {
          if (!(error instanceof StoreError) || error.code !== "adaptation.policy_invalid") {
            return false;
          }
          const result = error.details.result as {
            adaptationErrors?: readonly { code?: string }[];
          };
          return Boolean(
            result.adaptationErrors?.some(
              (issue) => issue.code === "adaptation.termination_basis_unclosed",
            ),
          );
        },
      );
      assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
    });
  }
});

test("candidate pre-kill rejects a durable null candidate before creating a receipt", async (contextTest) => {
  const runId = "runtime-pre-kill-durable-null";
  const setup = await setupPersistedRun(contextTest, runId, "pre-kill-exact");
  const validation = (await createAdaptationPolicyValidator(repositoryRoot)).validateDocumentBundle(
    setup.adaptationBundle,
  );
  assert.equal(validation.valid, true, JSON.stringify(validation, null, 2));
  await writeFile(path.join(setup.runRoot, PRE_KILL_CANDIDATE_REF), "null\n");
  const before = await planApplyBoundaryState(setup.runRoot);
  const { candidateBundle } = candidateFor(setup, PRE_KILL_APPLY_AT, PRE_KILL_CONTEXT_AT);
  await assert.rejects(
    (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply(
      preKillApplyInput(setup, candidateBundle),
    ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "adaptation.pre_kill_candidate_binding_invalid",
  );
  assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
});

test("candidate pre-kill receipt revalidates candidate, Plan, and binding revision", async (t) => {
  const scenarios: readonly {
    readonly name: string;
    readonly applied: boolean;
    readonly reopenCode: "write.conflict" | "recovery.invalid_plan_operation";
    readonly mutate: (
      setup: Awaited<ReturnType<typeof setupPersistedRun>>,
      receiptPath: string,
    ) => Promise<void>;
  }[] = [
    {
      name: "applied-candidate-null",
      applied: true,
      reopenCode: "write.conflict",
      mutate: async (setup) => {
        await writeFile(path.join(setup.runRoot, PRE_KILL_CANDIDATE_REF), "null\n");
      },
    },
    {
      name: "pending-candidate-envelope-drift",
      applied: false,
      reopenCode: "write.conflict",
      mutate: async (setup) => {
        const candidatePath = path.join(setup.runRoot, PRE_KILL_CANDIDATE_REF);
        const envelopeValue = JSON.parse(await readFile(candidatePath, "utf8")) as Record<
          string,
          unknown
        >;
        envelopeValue.producer_role = "harness";
        await writeFile(candidatePath, `${canonicalJson(envelopeValue)}\n`);
      },
    },
    {
      name: "pending-base-plan-hash-drift",
      applied: false,
      reopenCode: "write.conflict",
      mutate: async (setup) => {
        const planPath = path.join(setup.runRoot, PLAN_REF);
        const envelopeValue = JSON.parse(await readFile(planPath, "utf8")) as Record<
          string,
          unknown
        >;
        const document = envelopeValue.document as Record<string, unknown>;
        document.created_at = "2026-07-24T12:01:01Z";
        envelopeValue.content_hash = canonicalContentHash(document);
        await writeFile(planPath, `${canonicalJson(envelopeValue)}\n`);
      },
    },
    {
      name: "pending-binding-plan-revision-drift",
      applied: false,
      reopenCode: "recovery.invalid_plan_operation",
      mutate: async (_setup, receiptPath) => {
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
        const bindings = receipt.candidate_bindings as Record<string, unknown>[];
        assert.ok(bindings[0]);
        bindings[0].plan_revision = 2;
        await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (contextTest) => {
      const runId = `runtime-pre-kill-receipt-${scenario.name}`;
      const setup = await setupPersistedRun(contextTest, runId, "pre-kill-exact");
      const { candidateBundle } = candidateFor(setup, PRE_KILL_APPLY_AT, PRE_KILL_CONTEXT_AT);
      const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
      const input = preKillApplyInput(setup, candidateBundle, {
        ...(scenario.applied ? {} : { faultAt: "after_intent" as const }),
      });
      if (scenario.applied) {
        assert.equal((await runtime.apply(input)).status, "applied");
      } else {
        await assert.rejects(
          runtime.apply(input),
          (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
        );
      }
      const receiptPath = await planReceiptFile(setup.runRoot);
      await scenario.mutate(setup, receiptPath);
      const { faultAt: _faultAt, ...replayInput } = input;
      await assert.rejects(
        runtime.apply(replayInput),
        (error: unknown) =>
          error instanceof StoreError && error.code === "recovery.invalid_plan_operation",
      );
      await assert.rejects(
        setup.store.load(runId),
        (error: unknown) => error instanceof StoreError && error.code === scenario.reopenCode,
      );
    });
  }
});

test("Plan apply rejects an in-memory Gap Snapshot that differs from disk before writes", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-gap-bundle-tamper");
  const tamperedBundle = clone(setup.adaptationBundle);
  const gap = tamperedBundle.documents.find((entry) => entry.path === GAP_REF)?.document;
  const gaps = gap?.gaps as Record<string, unknown>[];
  const triggeredBy = gaps[0]?.triggered_by as Record<string, unknown>;
  triggeredBy.detail = "Caller-only tampering must not become policy input.";
  const before = await planApplyBoundaryState(setup.runRoot);
  const { candidateBundle } = candidateFor(setup);

  await assert.rejects(
    (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
      runId: "runtime-gap-bundle-tamper",
      adaptationBundle: tamperedBundle,
      adaptationRefs: [DECISION_REF],
      candidateBundle,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Reject caller-only Gap content.",
      beliefSummary: {
        current_belief: "Only immutable stored policy inputs may be applied.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Does the bundle match disk exactly?",
      },
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "adaptation.stored_content_mismatch",
  );
  assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
});

test("Plan apply rejects an in-memory Planning Context that differs from disk before writes", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-context-bundle-tamper");
  const tamperedBundle = clone(setup.adaptationBundle);
  const planningContext = tamperedBundle.documents.find(
    (entry) => entry.path === CONTEXT_REF,
  )?.document;
  assert.ok(planningContext);
  planningContext.created_at = "2026-07-24T12:03:01Z";
  const before = await planApplyBoundaryState(setup.runRoot);
  const { candidateBundle } = candidateFor(setup);

  await assert.rejects(
    (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
      runId: "runtime-context-bundle-tamper",
      adaptationBundle: tamperedBundle,
      adaptationRefs: [DECISION_REF],
      candidateBundle,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Reject caller-only Planning Context content.",
      beliefSummary: {
        current_belief: "Only immutable stored policy inputs may be applied.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Does the bundle match disk exactly?",
      },
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "adaptation.stored_content_mismatch",
  );
  assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
});

test("user-requested Adaptation applies and replays from an exact Decision log record", async (contextTest) => {
  const runId = "runtime-user-decision-apply";
  const setup = await setupPersistedRun(contextTest, runId, "retry", true, true);
  assert.ok(setup.userDecision);
  assert.ok(setup.triggerEventRecord);
  const { candidateBundle } = candidateFor(setup);
  const preflight = (await createAdaptationPolicyValidator(repositoryRoot)).validateDocumentBundle(
    setup.adaptationBundle,
  );
  assert.equal(preflight.valid, true, JSON.stringify(preflight));
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = {
    runId,
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Continue from the user-requested retry.",
    beliefSummary: {
      current_belief: "The exact durable user Decision authorizes the retry.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does the retry produce a valid result?",
    },
  };
  assert.equal((await runtime.apply(input)).status, "applied");
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");
  const reopened = await setup.store.load(runId);
  assert.equal(reopened.manifest.current_plan_ref, "plans/research-plan.r2.json");
  assert.deepEqual(reopened.manifest.applied_adaptation_refs, [DECISION_REF]);
});

test("user-requested apply rejects forged or drifted Decision log inputs before Plan writes", async (contextTest) => {
  const scenarios: readonly {
    readonly name: string;
    readonly expectedCode: string;
    readonly mutate: (
      setup: Awaited<ReturnType<typeof setupPersistedRun>>,
      adaptationBundle: DocumentBundle,
    ) => Promise<void>;
  }[] = [
    {
      name: "caller-record-altered",
      expectedCode: "adaptation.stored_content_mismatch",
      mutate: async (_setup, adaptationBundle) => {
        const record = adaptationBundle.documents.find(
          (entry) => entry.path === "decisions.jsonl",
        )?.document;
        assert.ok(record);
        record.reason = "Caller-only content must not replace the durable Decision record.";
      },
    },
    {
      name: "missing-fragment",
      expectedCode: "reference.fragment_missing",
      mutate: async (_setup, adaptationBundle) => {
        const adaptation = adaptationBundle.documents.find(
          (entry) => entry.path === DECISION_REF,
        )?.document;
        assert.ok(adaptation);
        adaptation.user_decision_ref = "decisions.jsonl";
      },
    },
    {
      name: "wrong-log-type",
      expectedCode: "reference.type_mismatch",
      mutate: async (setup, adaptationBundle) => {
        const events = (await readFile(path.join(setup.runRoot, "events.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const eventId = events[0]?.event_id;
        assert.equal(typeof eventId, "string");
        const adaptation = adaptationBundle.documents.find(
          (entry) => entry.path === DECISION_REF,
        )?.document;
        assert.ok(adaptation);
        adaptation.user_decision_ref = `events.jsonl#${String(eventId)}`;
      },
    },
    {
      name: "wrong-run-record",
      expectedCode: "reference.run_mismatch",
      mutate: async (setup) => {
        assert.ok(setup.userDecision);
        const foreign = clone(setup.userDecision);
        foreign.run_id = "runtime-user-foreign-run";
        const records = (await readFile(path.join(setup.runRoot, "decisions.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        await writeFile(
          path.join(setup.runRoot, "decisions.jsonl"),
          `${records
            .map((record) =>
              record.decision_id === setup.userDecision?.decision_id
                ? canonicalJson(foreign)
                : canonicalJson(record),
            )
            .join("\n")}\n`,
        );
      },
    },
    {
      name: "receipt-drift",
      expectedCode: "recovery.invalid_operation",
      mutate: async (setup) => {
        assert.ok(setup.userDecision);
        const key = operationKey("append_jsonl", {
          run_id: String(setup.userDecision.run_id),
          log_path: "decisions.jsonl",
          record: setup.userDecision,
        });
        const receiptPath = path.join(
          setup.runRoot,
          ".store/operations",
          `log-${key.slice("sha256:".length)}.json`,
        );
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
        const receiptRecord = receipt.record as Record<string, unknown>;
        receiptRecord.reason = "The receipt no longer matches its operation identity.";
        await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
      },
    },
    {
      name: "log-drift",
      expectedCode: "recovery.missing_operation",
      mutate: async (setup) => {
        assert.ok(setup.userDecision);
        const drifted = clone(setup.userDecision);
        drifted.reason = "The log record no longer matches its durable receipt.";
        const records = (await readFile(path.join(setup.runRoot, "decisions.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        await writeFile(
          path.join(setup.runRoot, "decisions.jsonl"),
          `${records
            .map((record) =>
              record.decision_id === setup.userDecision?.decision_id
                ? canonicalJson(drifted)
                : canonicalJson(record),
            )
            .join("\n")}\n`,
        );
      },
    },
  ];

  for (const scenario of scenarios) {
    const runId = `runtime-user-${scenario.name}`;
    const setup = await setupPersistedRun(contextTest, runId, "retry", true);
    const { candidateBundle } = candidateFor(setup);
    const adaptationBundle = clone(setup.adaptationBundle);
    await scenario.mutate(setup, adaptationBundle);
    const before = await planApplyBoundaryState(setup.runRoot);
    await assert.rejects(
      (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
        runId,
        adaptationBundle,
        adaptationRefs: [DECISION_REF],
        candidateBundle,
        createdAt: "2026-07-24T12:08:00Z",
        checkpointCreatedAt: "2026-07-24T12:09:00Z",
        nextStep: "Reject unbound user Decision input.",
        beliefSummary: {
          current_belief: "Only exact durable Decision log records may authorize apply.",
          evidence_that_changed_belief: [],
          unchanged_assumptions: [],
          remaining_disagreement: [],
          next_decision_relevant_question: "Does the Decision record match disk and receipt?",
        },
      }),
      (error: unknown) => error instanceof StoreError && error.code === scenario.expectedCode,
      scenario.name,
    );
    assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before, scenario.name);
  }
});

test("Decision log binding remains fail-closed across pending, applied, and reopen recovery", async (contextTest) => {
  const makeInput = (
    runId: string,
    setup: Awaited<ReturnType<typeof setupPersistedRun>>,
    candidateBundle: DocumentBundle,
  ) => ({
    runId,
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Keep Decision log recovery fail closed.",
    beliefSummary: {
      current_belief: "Recovery requires the exact durable user Decision.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does the Decision still match its receipt?",
    },
  });
  const decisionReceiptPath = (setup: Awaited<ReturnType<typeof setupPersistedRun>>): string => {
    assert.ok(setup.userDecision);
    const key = operationKey("append_jsonl", {
      run_id: String(setup.userDecision.run_id),
      log_path: "decisions.jsonl",
      record: setup.userDecision,
    });
    return path.join(setup.runRoot, ".store/operations", `log-${key.slice("sha256:".length)}.json`);
  };
  const corruptReceipt = async (setup: Awaited<ReturnType<typeof setupPersistedRun>>) => {
    const receiptPath = decisionReceiptPath(setup);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    const record = receipt.record as Record<string, unknown>;
    record.reason = "Recovery must reject this receipt identity drift.";
    await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
  };
  const driftLog = async (setup: Awaited<ReturnType<typeof setupPersistedRun>>) => {
    assert.ok(setup.userDecision);
    const record = clone(setup.userDecision);
    record.reason = "Recovery must reject this log content drift.";
    await writeFile(path.join(setup.runRoot, "decisions.jsonl"), `${canonicalJson(record)}\n`);
  };

  {
    const runId = "runtime-user-pending-replay-drift";
    const setup = await setupPersistedRun(contextTest, runId, "retry", true);
    const { candidateBundle } = candidateFor(setup);
    const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
    const input = makeInput(runId, setup, candidateBundle);
    await assert.rejects(
      runtime.apply({ ...input, faultAt: "after_intent" }),
      (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
    );
    await corruptReceipt(setup);
    const before = await planApplyBoundaryState(setup.runRoot);
    await assert.rejects(
      runtime.apply(input),
      (error: unknown) =>
        error instanceof StoreError && error.code === "recovery.invalid_plan_operation",
    );
    assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
  }

  {
    const runId = "runtime-user-applied-replay-drift";
    const setup = await setupPersistedRun(contextTest, runId, "retry", true);
    const { candidateBundle } = candidateFor(setup);
    const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
    const input = makeInput(runId, setup, candidateBundle);
    assert.equal((await runtime.apply(input)).status, "applied");
    await driftLog(setup);
    const before = await planApplyBoundaryState(setup.runRoot);
    await assert.rejects(
      runtime.apply(input),
      (error: unknown) =>
        error instanceof StoreError && error.code === "recovery.invalid_plan_operation",
    );
    assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
  }

  {
    const runId = "runtime-user-reopen-receipt-drift";
    const setup = await setupPersistedRun(contextTest, runId, "retry", true);
    const { candidateBundle } = candidateFor(setup);
    const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
    assert.equal((await runtime.apply(makeInput(runId, setup, candidateBundle))).status, "applied");
    await corruptReceipt(setup);
    const before = await planApplyBoundaryState(setup.runRoot);
    await assert.rejects(
      setup.store.load(runId),
      (error: unknown) =>
        error instanceof StoreError && error.code === "recovery.invalid_operation",
    );
    assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
  }
});

test("multiple exact Event and Decision fragments publish and reopen in one Run", async (contextTest) => {
  const setup = await setupPersistedRun(
    contextTest,
    "runtime-multiple-jsonl-fragments",
    "retry",
    true,
    true,
  );
  const second = await publishSecondJsonlBackedPair(setup);

  const reopened = await setup.store.load("runtime-multiple-jsonl-fragments");
  assert.ok(reopened.manifest.artifact_refs.includes(GAP_REF));
  assert.ok(reopened.manifest.artifact_refs.includes(second.gapPath));
  assert.ok(reopened.manifest.artifact_refs.includes(DECISION_REF));
  assert.ok(reopened.manifest.artifact_refs.includes(second.decisionPath));
});

test("multi-record user Decisions apply, replay, and reopen through exact fragments", async (contextTest) => {
  const setup = await setupPersistedRun(
    contextTest,
    "runtime-multiple-decision-apply",
    "retry",
    true,
    true,
  );
  const second = await publishSecondJsonlBackedPair(setup);
  const { input } = await multiDecisionApplyInput(setup, second);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);

  assert.equal((await runtime.apply(input)).status, "applied");
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");
  const reopened = await setup.store.load("runtime-multiple-decision-apply");
  assert.equal(reopened.manifest.current_plan_ref, "plans/research-plan.r2.json");
  assert.deepEqual(reopened.manifest.applied_adaptation_refs, [DECISION_REF, second.decisionPath]);
  assert.ok(reopened.manifest.superseded_units.includes("acquisition_failed"));
  assert.ok(reopened.manifest.superseded_units.includes("buyer_active"));
});

test("G0.R replays two exact Event and Decision chains through one filesystem batch", async (contextTest) => {
  const runId = "foundation-regression-exact-jsonl";
  const setup = await setupPersistedRun(contextTest, runId, "retry", true, true);
  const second = await publishSecondJsonlBackedPair(setup);
  assert.ok(setup.triggerEventRecord);
  assert.ok(setup.userDecision);

  const firstEventRef = String(setup.gap.trigger_event_ref);
  const secondEventRef = String(second.gap.trigger_event_ref);
  assert.equal(
    setup.gap.snapshot_cycle_key,
    eventGapCycleKey(setup.plan, firstEventRef, String(setup.triggerEventRecord.event_id)),
  );
  assert.equal(
    second.gap.snapshot_cycle_key,
    eventGapCycleKey(setup.plan, secondEventRef, String(second.eventRecord.event_id)),
  );
  assert.notEqual(setup.gap.snapshot_cycle_key, second.gap.snapshot_cycle_key);

  const eventRecords = (await readFile(path.join(setup.runRoot, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const decisionRecords = (await readFile(path.join(setup.runRoot, "decisions.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(
    eventRecords.filter((record) =>
      [setup.triggerEventRecord?.event_id, second.eventRecord.event_id].includes(record.event_id),
    ).length,
    2,
  );
  assert.equal(
    decisionRecords.filter((record) =>
      [setup.userDecision?.decision_id, second.userDecision.decision_id].includes(
        record.decision_id,
      ),
    ).length,
    2,
  );
  const exactReceiptPaths = await Promise.all([
    receiptForRecord(setup.runRoot, String(setup.triggerEventRecord.event_id)),
    receiptForRecord(setup.runRoot, String(second.eventRecord.event_id)),
    receiptForRecord(setup.runRoot, String(setup.userDecision.decision_id)),
    receiptForRecord(setup.runRoot, String(second.userDecision.decision_id)),
  ]);
  assert.equal(new Set(exactReceiptPaths).size, 4);

  const immutablePaths = [GAP_REF, second.gapPath, DECISION_REF, second.decisionPath];
  const beforeApply = await Promise.all(
    immutablePaths.map((artifactPath) => readFile(path.join(setup.runRoot, artifactPath), "utf8")),
  );
  const { input } = await multiDecisionApplyInput(setup, second);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  assert.equal((await runtime.apply(input)).status, "applied");
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");
  const reopened = await setup.store.load(runId);
  assert.equal(reopened.manifest.current_plan_ref, "plans/research-plan.r2.json");
  assert.deepEqual(reopened.manifest.applied_adaptation_refs, [DECISION_REF, second.decisionPath]);
  assert.deepEqual(
    await Promise.all(
      immutablePaths.map((artifactPath) =>
        readFile(path.join(setup.runRoot, artifactPath), "utf8"),
      ),
    ),
    beforeApply,
  );

  const artifactValidator = await createArtifactValidator(repositoryRoot);
  const duplicatePathBundle = artifactValidator.validateDocumentBundle(
    {
      schema_version: "startup_opportunity.document_bundle.current",
      documents: [
        { path: "events.jsonl", document: setup.triggerEventRecord },
        { path: "events.jsonl", document: second.eventRecord },
      ],
    },
    {
      exactJsonlRecords: new Map([
        [firstEventRef, setup.triggerEventRecord],
        [secondEventRef, second.eventRecord],
      ]),
    },
  );
  assert.equal(duplicatePathBundle.valid, false);
  assert.ok(
    duplicatePathBundle.referenceErrors.some((error) => error.code === "reference.duplicate_path"),
  );
});

test("G0.R reopen rejects a missing newer Event receipt before Plan state writes", async (contextTest) => {
  const runId = "foundation-regression-new-event-receipt";
  const setup = await setupPersistedRun(contextTest, runId, "retry", true, true);
  const second = await publishSecondJsonlBackedPair(setup);
  await rm(await receiptForRecord(setup.runRoot, String(second.eventRecord.event_id)), {
    force: true,
  });

  const before = await planApplyBoundaryState(setup.runRoot);
  await assert.rejects(
    setup.store.load(runId),
    (error: unknown) => error instanceof StoreError && error.code === "recovery.missing_operation",
  );
  assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
});

test("multi-record apply never substitutes another Decision fragment", async (contextTest) => {
  await contextTest.test(
    "altered old record is rejected while the newer record remains valid",
    async (subtest) => {
      const setup = await setupPersistedRun(
        subtest,
        "runtime-multiple-decision-old-drift",
        "retry",
        true,
        true,
      );
      const second = await publishSecondJsonlBackedPair(setup);
      const { input } = await multiDecisionApplyInput(setup, second);
      const decisionId = String(setup.userDecision?.decision_id);
      const records = (await readFile(path.join(setup.runRoot, "decisions.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const oldRecord = records.find((record) => record.decision_id === decisionId);
      assert.ok(oldRecord);
      oldRecord.reason = "Caller-altered old record that must not resolve to the newer Decision.";
      await writeFile(
        path.join(setup.runRoot, "decisions.jsonl"),
        `${records.map((record) => canonicalJson(record)).join("\n")}\n`,
      );
      const before = await planApplyBoundaryState(setup.runRoot);
      await assert.rejects(
        (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply(input),
        (error: unknown) =>
          error instanceof StoreError && error.code === "recovery.missing_operation",
      );
      assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
    },
  );

  await contextTest.test(
    "missing old receipt is rejected while the newer receipt remains",
    async (subtest) => {
      const setup = await setupPersistedRun(
        subtest,
        "runtime-multiple-decision-receipt-missing",
        "retry",
        true,
        true,
      );
      const second = await publishSecondJsonlBackedPair(setup);
      const { input } = await multiDecisionApplyInput(setup, second);
      await rm(await receiptForRecord(setup.runRoot, String(setup.userDecision?.decision_id)), {
        force: true,
      });
      const before = await planApplyBoundaryState(setup.runRoot);
      await assert.rejects(
        (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply(input),
        (error: unknown) =>
          error instanceof StoreError && error.code === "recovery.missing_operation",
      );
      assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
    },
  );

  await contextTest.test(
    "altered old receipt is rejected while the newer receipt remains",
    async (subtest) => {
      const setup = await setupPersistedRun(
        subtest,
        "runtime-multiple-decision-receipt-drift",
        "retry",
        true,
        true,
      );
      const second = await publishSecondJsonlBackedPair(setup);
      const { input } = await multiDecisionApplyInput(setup, second);
      const receiptPath = await receiptForRecord(
        setup.runRoot,
        String(setup.userDecision?.decision_id),
      );
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
      const record = receipt.record as Record<string, unknown>;
      record.reason = "The old receipt was altered while the newer receipt remains valid.";
      await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
      const before = await planApplyBoundaryState(setup.runRoot);
      await assert.rejects(
        (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply(input),
        (error: unknown) =>
          error instanceof StoreError && error.code === "recovery.invalid_operation",
      );
      assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
    },
  );

  await contextTest.test(
    "missing old fragment is not replaced by the newer record",
    async (subtest) => {
      const setup = await setupPersistedRun(
        subtest,
        "runtime-multiple-decision-fragment-missing",
        "retry",
        true,
        true,
      );
      const second = await publishSecondJsonlBackedPair(setup);
      const { input } = await multiDecisionApplyInput(setup, second);
      const oldDecision = input.adaptationBundle.documents.find(
        (entry) => entry.path === DECISION_REF,
      )?.document;
      assert.ok(oldDecision);
      oldDecision.user_decision_ref = "decisions.jsonl#decision_missing_old";
      const before = await planApplyBoundaryState(setup.runRoot);
      await assert.rejects(
        (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply(input),
        (error: unknown) =>
          error instanceof StoreError && error.code === "reference.fragment_missing",
      );
      assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
    },
  );

  await contextTest.test(
    "wrong log type is not replaced by a matching Event fragment",
    async (subtest) => {
      const setup = await setupPersistedRun(
        subtest,
        "runtime-multiple-decision-wrong-type",
        "retry",
        true,
        true,
      );
      const second = await publishSecondJsonlBackedPair(setup);
      const { input } = await multiDecisionApplyInput(setup, second);
      const oldDecision = input.adaptationBundle.documents.find(
        (entry) => entry.path === DECISION_REF,
      )?.document;
      assert.ok(oldDecision);
      oldDecision.user_decision_ref = `events.jsonl#${String(second.eventRecord.event_id)}`;
      const before = await planApplyBoundaryState(setup.runRoot);
      await assert.rejects(
        (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply(input),
        (error: unknown) => error instanceof StoreError && error.code === "reference.type_mismatch",
      );
      assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
    },
  );

  await contextTest.test(
    "wrong record type is not replaced by the newer Decision",
    async (subtest) => {
      const setup = await setupPersistedRun(
        subtest,
        "runtime-multiple-decision-record-type",
        "retry",
        true,
        true,
      );
      const second = await publishSecondJsonlBackedPair(setup);
      const { input } = await multiDecisionApplyInput(setup, second);
      const decisionId = String(setup.userDecision?.decision_id);
      const records = (await readFile(path.join(setup.runRoot, "decisions.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const oldRecord = records.find((record) => record.decision_id === decisionId);
      assert.ok(oldRecord);
      oldRecord.schema_version = "startup_opportunity.event.v1";
      await writeFile(
        path.join(setup.runRoot, "decisions.jsonl"),
        `${records.map((record) => canonicalJson(record)).join("\n")}\n`,
      );
      const before = await planApplyBoundaryState(setup.runRoot);
      await assert.rejects(
        (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply(input),
        (error: unknown) => error instanceof StoreError && error.code === "reference.type_mismatch",
      );
      assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
    },
  );

  await contextTest.test(
    "wrong-Run old record is rejected while the newer record remains valid",
    async (subtest) => {
      const setup = await setupPersistedRun(
        subtest,
        "runtime-multiple-decision-wrong-run",
        "retry",
        true,
        true,
      );
      const second = await publishSecondJsonlBackedPair(setup);
      const { input } = await multiDecisionApplyInput(setup, second);
      const decisionId = String(setup.userDecision?.decision_id);
      const records = (await readFile(path.join(setup.runRoot, "decisions.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const oldRecord = records.find((record) => record.decision_id === decisionId);
      assert.ok(oldRecord);
      oldRecord.run_id = "run_foreign_001";
      await writeFile(
        path.join(setup.runRoot, "decisions.jsonl"),
        `${records.map((record) => canonicalJson(record)).join("\n")}\n`,
      );
      const before = await planApplyBoundaryState(setup.runRoot);
      await assert.rejects(
        (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply(input),
        (error: unknown) => error instanceof StoreError && error.code === "reference.run_mismatch",
      );
      assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
    },
  );
});

test("multi-record reopen binds each Event receipt independently", async (contextTest) => {
  const setup = await setupPersistedRun(
    contextTest,
    "runtime-multiple-event-receipt-drift",
    "retry",
    true,
    true,
  );
  await publishSecondJsonlBackedPair(setup);
  const receiptPath = await receiptForRecord(
    setup.runRoot,
    String(setup.triggerEventRecord?.event_id),
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  const record = receipt.record as Record<string, unknown>;
  record.reason = "The old Event receipt was altered while the newer Event remains valid.";
  await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);

  await assert.rejects(
    setup.store.load("runtime-multiple-event-receipt-drift"),
    (error: unknown) => error instanceof StoreError && error.code === "recovery.invalid_operation",
  );
});

test("Plan Revision apply is CAS-safe, immutable, and idempotent on a real Run", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-apply-success");
  const { transformed, candidateBundle } = candidateFor(setup);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const preflight = (await createAdaptationPolicyValidator(repositoryRoot)).validateDocumentBundle(
    setup.adaptationBundle,
  );
  assert.equal(preflight.valid, true, JSON.stringify(preflight));
  const candidatePreflight = (
    await createPlanSemanticValidator(repositoryRoot)
  ).validateDocumentBundle(candidateBundle);
  assert.equal(candidatePreflight.valid, true, JSON.stringify(candidatePreflight));
  const input = {
    runId: "runtime-apply-success",
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Run the approved retry unit.",
    beliefSummary: {
      current_belief: "The failed unit has one approved retry.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does the retry produce a valid result?",
    },
  };
  const applied = await runtime.apply(input);
  assert.equal(applied.status, "applied");
  assert.equal(applied.currentPlanRef, "plans/research-plan.r2.json");
  assert.equal(
    canonicalJson(
      (
        JSON.parse(
          await readFile(path.join(setup.runRoot, "plans/research-plan.r2.json"), "utf8"),
        ) as FormalArtifactEnvelope
      ).document,
    ),
    canonicalJson(transformed.plan),
  );
  const reopened = await setup.store.load("runtime-apply-success");
  assert.equal(reopened.manifest.plan_revision, 2);
  assert.ok(reopened.manifest.superseded_units.includes("acquisition_failed"));
  assert.ok(reopened.manifest.applied_adaptation_refs.includes(DECISION_REF));
  const replay = await runtime.apply(input);
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.operationKey, applied.operationKey);

  const conflictingReplay = clone(input);
  conflictingReplay.nextStep = "Use different checkpoint metadata.";
  await assert.rejects(
    runtime.apply(conflictingReplay),
    (error: unknown) => error instanceof StoreError && error.code === "write.operation_conflict",
  );

  const stale = clone(input);
  const staleDecisionRef = "adaptations/decisions/adapt-retry-stale.json";
  const staleDecisionEntry = stale.adaptationBundle.documents.find(
    (entry) => entry.path === DECISION_REF,
  ) as { path: string; document: Record<string, unknown> } | undefined;
  assert.ok(staleDecisionEntry);
  staleDecisionEntry.path = staleDecisionRef;
  staleDecisionEntry.document.adaptation_id = "adapt_retry_stale_001";
  stale.adaptationRefs = [staleDecisionRef];
  stale.createdAt = "2026-07-24T12:10:00Z";
  stale.checkpointCreatedAt = "2026-07-24T12:11:00Z";
  await assert.rejects(
    runtime.apply(stale),
    (error: unknown) => error instanceof StoreError && error.code === "apply.stale_input_bundle",
  );
});

test("pre-CAS crash keeps base current; replay completes the immutable revision", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-crash-before-cas");
  const { candidateBundle } = candidateFor(setup);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = {
    runId: "runtime-crash-before-cas",
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Run the approved retry unit.",
    beliefSummary: {
      current_belief: "The retry is approved but not current before CAS.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Can the operation replay safely?",
    },
    faultAt: "after_control_artifacts" as const,
  };
  await assert.rejects(
    runtime.apply(input),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await setup.store.load("runtime-crash-before-cas");
  assert.equal(reopened.manifest.current_plan_ref, PLAN_REF);
  assert.equal(reopened.planOperationRecovery.pendingOperationKeys.length, 1);
  const { faultAt: _faultAt, ...replayInput } = input;
  const replay = await runtime.apply(replayInput);
  assert.equal(replay.status, "idempotent_replay");
  assert.equal((await setup.store.load("runtime-crash-before-cas")).manifest.plan_revision, 2);
});

test("post-manifest crash is completed during reopen from validated receipt state", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-crash-after-cas");
  const { candidateBundle } = candidateFor(setup);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  await assert.rejects(
    runtime.apply({
      runId: "runtime-crash-after-cas",
      adaptationBundle: setup.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      candidateBundle,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Run the approved retry unit.",
      beliefSummary: {
        current_belief: "Manifest CAS succeeded and recovery must finish the checkpoint.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Did reopen complete the durable boundary?",
      },
      faultAt: "after_manifest_update",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await setup.store.load("runtime-crash-after-cas");
  assert.equal(reopened.manifest.plan_revision, 2);
  assert.equal(reopened.planOperationRecovery.completedOperationKeys.length, 1);
  assert.equal(reopened.manifest.checkpoint_ref?.includes("checkpoint-plan-apply"), true);
  assert.equal((await setup.store.load("runtime-crash-after-cas")).recovered, false);
});

test("candidate content must equal the deterministic Plan transformation", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-candidate-conflict");
  const { candidateBundle } = candidateFor(setup);
  const changed = clone(candidateBundle);
  const candidatePlan = changed.documents.find(
    (entry) => entry.path === "plans/research-plan.r2.json",
  )?.document;
  const candidateContext = changed.documents.find(
    (entry) => entry.path === "plans/planning-context.r2.json",
  )?.document;
  assert.ok(candidatePlan && candidateContext);
  const questions = candidatePlan.research_questions as Record<string, unknown>[];
  assert.ok(questions[0]);
  questions[0].question = "A schema-valid but non-deterministic candidate mutation.";
  const targetBinding = candidateContext.target_plan_binding as Record<string, unknown>;
  targetBinding.plan_content_hash = canonicalContentHash(candidatePlan);

  await assert.rejects(
    (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
      runId: "runtime-candidate-conflict",
      adaptationBundle: setup.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      candidateBundle: changed,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Reject the non-deterministic candidate.",
      beliefSummary: {
        current_belief: "Only the deterministic transform may become current.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Does the candidate match the closed transform?",
      },
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "apply.candidate_transform_mismatch",
  );
});

test("supersede apply replaces active work without mutating the parent Plan", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-supersede-success", "supersede");
  const parentBefore = canonicalJson(setup.plan);
  const { candidateBundle } = candidateFor(setup);
  const applied = await (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
    runId: "runtime-supersede-success",
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Run the validated superseding unit.",
    beliefSummary: {
      current_belief: "The active unit has an immutable successor.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does the successor produce a valid result?",
    },
  });
  assert.equal(applied.status, "applied");
  const loaded = await setup.store.load("runtime-supersede-success");
  assert.equal(loaded.manifest.superseded_units.includes("buyer_active"), true);
  assert.equal(loaded.manifest.active_units.includes("buyer_active"), false);
  assert.equal(canonicalJson(setup.plan), parentBefore);
  const candidatePlan = JSON.parse(
    await readFile(path.join(setup.runRoot, "plans/research-plan.r2.json"), "utf8"),
  ) as FormalArtifactEnvelope;
  const units = (candidatePlan.document.waves as { units: Record<string, unknown>[] }[]).flatMap(
    (wave) => wave.units,
  );
  assert.equal(
    units.find((entry) => entry.unit_id === "buyer_active")?.plan_disposition,
    "superseded",
  );
  assert.equal(
    units.find((entry) => entry.unit_id === "buyer_superseding")?.supersedes_unit_ref,
    `${PLAN_REF}#buyer_active`,
  );
});

test("intent and checkpoint crash boundaries reopen without partial current state", async (contextTest) => {
  for (const scenario of [
    {
      runId: "runtime-crash-after-intent",
      faultAt: "after_intent" as const,
      revisionAfterFault: 1,
    },
    {
      runId: "runtime-crash-after-checkpoint",
      faultAt: "after_checkpoint_publish" as const,
      revisionAfterFault: 2,
    },
  ]) {
    const setup = await setupPersistedRun(contextTest, scenario.runId);
    const { candidateBundle } = candidateFor(setup);
    const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
    const input = {
      runId: scenario.runId,
      adaptationBundle: setup.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      candidateBundle,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Recover the injected operation boundary.",
      beliefSummary: {
        current_belief: "The operation receipt is the durable recovery intent.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Can the Run reopen from validated disk state?",
      },
      faultAt: scenario.faultAt,
    };
    await assert.rejects(
      runtime.apply(input),
      (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
    );
    const manifestAfterFault = JSON.parse(
      await readFile(path.join(setup.runRoot, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(manifestAfterFault.plan_revision, scenario.revisionAfterFault);

    const loaded = await setup.store.load(scenario.runId);
    if (scenario.faultAt === "after_intent") {
      assert.equal(loaded.planOperationRecovery.pendingOperationKeys.length, 1);
      const { faultAt: _faultAt, ...replayInput } = input;
      assert.equal((await runtime.apply(replayInput)).status, "idempotent_replay");
    } else {
      assert.equal(loaded.planOperationRecovery.completedOperationKeys.length, 1);
    }
    assert.equal((await setup.store.load(scenario.runId)).manifest.plan_revision, 2);
  }
});

test("reopen rejects Plan operation receipt document drift", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-receipt-drift");
  const { candidateBundle } = candidateFor(setup);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  await assert.rejects(
    runtime.apply({
      runId: "runtime-receipt-drift",
      adaptationBundle: setup.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      candidateBundle,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Leave a receipt before its CAS boundary.",
      beliefSummary: {
        current_belief: "Recovery must reject receipt document drift.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Does receipt validation fail closed?",
      },
      faultAt: "after_intent",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const operationDirectory = path.join(setup.runRoot, ".store/operations");
  const receiptName = (await readdir(operationDirectory)).find((name) =>
    name.startsWith("plan-revision-"),
  );
  assert.ok(receiptName);
  const receiptPath = path.join(operationDirectory, receiptName);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  const receiptManifest = receipt.manifest as Record<string, unknown>;
  receiptManifest.status = "insufficient_evidence";
  await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);

  await assert.rejects(
    setup.store.load("runtime-receipt-drift"),
    (error: unknown) =>
      error instanceof StoreError && error.code === "recovery.invalid_plan_operation",
  );
});

test("late Artifact is persisted only as ignored and remains ignored after reopen", async (contextTest) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g04-late-"));
  contextTest.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "runtime-late-artifact";
  const store = new RunStore(runsRoot, await createArtifactValidator(repositoryRoot));
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-24T12:00:00Z",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
  });
  const plan = basePlan(runId);
  const cancelledUnit = (plan.waves as { units: Record<string, unknown>[] }[])[0]?.units[1];
  assert.ok(cancelledUnit);
  const latePath = "artifacts/lanes/acquisition-late-event.json";
  cancelledUnit.output_path = latePath;
  cancelledUnit.required_artifact_schema = "startup_opportunity.event.v1";
  await store.publishArtifact({ runId, envelope: formalEnvelope(runId, PLAN_REF, plan) });

  const runRoot = path.join(runsRoot, runId);
  const current = JSON.parse(await readFile(path.join(runRoot, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
  Object.assign(current, {
    current_phase: "enrichment",
    current_plan_ref: PLAN_REF,
    plan_revision: 1,
    failed_units: [],
    cancelled_units: ["acquisition_failed"],
    artifact_refs: [PLAN_REF],
    updated_at: "2026-07-24T12:06:00Z",
  });
  await writeFile(path.join(runRoot, "manifest.json"), `${canonicalJson(current)}\n`);
  await store.checkpoint({
    runId,
    checkpointId: "checkpoint_late_boundary",
    createdAt: "2026-07-24T12:07:00Z",
    nextStep: "Ignore any result arriving for the cancelled unit.",
    beliefSummary: {
      current_belief: "The cancelled unit cannot affect the current plan.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does a late result remain excluded?",
    },
  });

  const lateDocument = {
    schema_version: "startup_opportunity.event.v1",
    event_id: "late_unit_result_fixture",
    run_id: runId,
    event_type: "research_unit_completed",
    timestamp: "2026-07-24T12:08:00Z",
    actor: "lane_researcher",
    reason: "A result arrived after its owning unit was cancelled.",
    artifact_refs: [],
  };
  await store.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, latePath, lateDocument),
  });
  const afterLatePublish = JSON.parse(
    await readFile(path.join(runRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(afterLatePublish.updated_at, "2026-07-24T12:07:00Z");
  let loaded = await store.load(runId);
  assert.equal(loaded.manifest.artifact_refs.includes(latePath), false);
  assert.equal(loaded.manifest.ignored_late_artifact_refs.includes(latePath), true);
  loaded = await store.load(runId);
  assert.equal(loaded.manifest.artifact_refs.includes(latePath), false);
  assert.equal(loaded.manifest.ignored_late_artifact_refs.includes(latePath), true);

  await assert.rejects(
    store.publishArtifact({
      runId,
      envelope: formalEnvelope(runId, latePath, gapSnapshot(runId)),
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.unit_schema_mismatch",
  );

  const futurePath = "artifacts/lanes/buyer-active.json";
  const futureDocument = {
    schema_version: "startup_opportunity.enrichment_branch_result.v1",
    run_id: runId,
  };
  await assert.rejects(
    store.publishArtifact({
      runId,
      envelope: formalEnvelope(runId, futurePath, futureDocument),
    }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.schema_invalid",
  );
});

test("Harness CLI and repo-local Skill scripts run all four G0.4 entries", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-cli-entries");
  const { candidateBundle } = candidateFor(setup);
  const bundleFile = path.join(setup.root, "planning-bundle.json");
  const gapInputFile = path.join(setup.root, "gap-input.json");
  const applyInputFile = path.join(setup.root, "apply-input.json");
  await writeFile(bundleFile, `${canonicalJson(setup.adaptationBundle)}\n`);
  await writeFile(
    gapInputFile,
    `${canonicalJson({
      schema_version: "startup_opportunity.gap_analysis_input.v1",
      document_bundle: setup.adaptationBundle,
      snapshot_id: "gap_cli_draft_001",
      created_at: "2026-07-24T12:08:00Z",
      trigger_kind: "wave_completed",
      phase: "enrichment",
      wave_id: "wave_runtime_1",
      trigger_event_ref: null,
      observed_artifact_refs: [],
      material_new_evidence_observed: false,
      repeated_source_refs: [],
      machine_checks: [],
    })}\n`,
  );
  await writeFile(
    applyInputFile,
    `${canonicalJson({
      schema_version: "startup_opportunity.plan_revision_apply_input.v1",
      run_id: "runtime-cli-entries",
      adaptation_bundle: setup.adaptationBundle,
      adaptation_refs: [DECISION_REF],
      candidate_bundle: candidateBundle,
      created_at: "2026-07-24T12:08:00Z",
      checkpoint_created_at: "2026-07-24T12:09:00Z",
      next_step: "Run the approved retry unit.",
      belief_summary: {
        current_belief: "The failed unit has one validated retry.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Does the retry produce a valid result?",
      },
    })}\n`,
  );

  for (const [command, skillScript, flag, filename] of [
    ["validate-plan", "validate-plan.ts", "--bundle", bundleFile],
    ["analyze-gaps", "analyze-gaps.ts", "--file", gapInputFile],
    ["validate-adaptation", "validate-adaptation.ts", "--bundle", bundleFile],
  ] as const) {
    for (const [script, args] of [
      ["harness/src/cli.ts", [command, flag, filename]],
      [`.agents/skills/startup-opportunity/scripts/${skillScript}`, [flag, filename]],
    ] as const) {
      const result = runScript(script, args);
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
      assert.equal((JSON.parse(result.stdout) as { valid: boolean }).valid, true);
    }
  }

  const harnessApply = runScript("harness/src/cli.ts", [
    "apply-plan-revision",
    "--file",
    applyInputFile,
    "--runs-root",
    setup.runsRoot,
  ]);
  assert.equal(harnessApply.status, 0, harnessApply.stderr);
  assert.equal((JSON.parse(harnessApply.stdout) as { status: string }).status, "applied");
  const skillApply = runScript(
    ".agents/skills/startup-opportunity/scripts/apply-plan-revision.ts",
    ["--file", applyInputFile, "--runs-root", setup.runsRoot],
  );
  assert.equal(skillApply.status, 0, skillApply.stderr);
  assert.equal((JSON.parse(skillApply.stdout) as { status: string }).status, "idempotent_replay");

  for (const script of [
    "validate-plan.ts",
    "analyze-gaps.ts",
    "validate-adaptation.ts",
    "apply-plan-revision.ts",
  ]) {
    const failure = runScript(`.agents/skills/startup-opportunity/scripts/${script}`, []);
    assert.equal(failure.status, 64, `${script}: ${failure.stderr}`);
    assert.equal(
      (JSON.parse(failure.stderr) as { error: { code: string } }).error.code,
      "command.invalid_arguments",
    );
  }
});

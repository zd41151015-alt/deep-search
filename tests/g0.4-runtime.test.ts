import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../harness/src/artifact-store/canonical.js";
import {
  type ApplyPlanRevisionInput,
  ArtifactStore,
  canonicalContentHash,
  canonicalExecutionStageCloseoutPath,
  canonicalJson,
  canonicalLaneLifecyclePath,
  coverageKey,
  createAdaptationAuthorRuntime,
  createAdaptationPolicyValidator,
  createArtifactValidator,
  createGapAnalyzer,
  createPlanRevisionRuntime,
  createPlanSemanticValidator,
  DispatchLaunchRegistry,
  type DocumentBundle,
  deriveLaneSubmissionContract,
  EvidenceStore,
  type FormalArtifactEnvelope,
  FormalStageMaterializer,
  operationKey,
  planningRunStateHash,
  RunStore,
  StoreError,
  sha256Bytes,
  transformPlan,
} from "../harness/src/index.js";
import {
  localizedTerminalUserViewIssues,
  renderTerminalAuditAppendix,
  renderTerminalDecisionBrief,
  renderTerminalFullReport,
} from "../harness/src/reporting/terminal-reporting.js";
import { createFormalStageRuntimeCompiler } from "../harness/src/runtime/declarative-runtime.js";
import { deriveResearchProvenance } from "../harness/src/validators/research-handoff-validator.js";
import {
  createDiscoveryMapsFixture,
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
  G21_OPPORTUNITY_REF,
  G21_SOLUTION_REF,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  fixtureEffective,
  G22_DEMAND_EVALUATION_JUDGMENT,
  G22_DEMAND_R2,
  G22_EVALUATION_CLAIM,
  G22_EVALUATION_LANE,
  G22_EVALUATION_MANIFEST,
  G22_EVALUATION_TASK,
  G22_FAN_IN,
  G22_GENERATION_CLAIM,
  G22_GENERATION_LANE,
  G22_GENERATION_MANIFEST,
  G22_JUDGMENT,
  G22_PRE_CANDIDATE_RELATION,
  G22_REJECTED_PRE_CANDIDATE,
  G22_RETAINED_PRE_CANDIDATE,
  G22_WATCHLIST_PRE_CANDIDATE,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";
import {
  createDiscoveryRuntimeFixture,
  runtimeEnvelope,
} from "./fixtures/g2.2/discovery-runtime-fixture.js";
import {
  createDiscoverySynthesisFixture,
  discoverySynthesisReadinessEnvelopes,
  G23_READINESS,
  G23_READINESS_GAP,
} from "./fixtures/g2.3/discovery-synthesis-fixture.js";
import {
  createConfirmedRun,
  initialPlanBundleEnvelopes,
  publishInitialPlanBundle,
} from "./helpers/current-run.js";
import { discoveryWaveEnvelopes } from "./helpers/discovery-wave.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const PLAN_REF = "plans/research-plan.r1.json";
const CONTEXT_REF = "plans/planning-context.r1.json";
const CANDIDATE_CONTEXT_REF = "plans/planning-context.r2.json";
const GAP_REF = "adaptations/gap-snapshots/gap-runtime.r1.json";
const DECISION_REF = "adaptations/decisions/adapt-retry-runtime.json";
const DECISION_CONTEXT_REF = "decision-context.json";
const SCOPE_FRAME_REF = "scope-frame.json";
const DECISION_SUBJECT_SNAPSHOT_REF = "artifacts/reporting/decision-subject-snapshot.r1.json";
const SUBJECT_REF = "subject_001";
const PRE_KILL_CANDIDATE_REF = "artifacts/discovery/candidates/candidate_demand.r1.json";
const RETAINED_SHARED_CANDIDATE_REF = "artifacts/discovery/candidates/candidate_solution.r1.json";
const PRE_KILL_APPLY_AT = "2026-07-28T12:12:00Z";
const PRE_KILL_CONTEXT_AT = "2026-07-28T12:12:30Z";
const PRE_KILL_CHECKPOINT_AT = "2026-07-28T12:13:00Z";
const CONFIRMED_SCOPE = {
  revision: 1,
  geography: "Synthetic",
  customer_model: "b2c",
  target_users: ["synthetic user"],
  decision_goal: "test current contract",
  research_language: "en-US",
  team_context: {
    hard_constraints: [],
    known_strengths_and_gaps: [],
    other_team_conditions: {
      status: "unknown",
      source_kind: "unknown",
      confirmation_status: "unknown",
      reporting_disclosure:
        "Team conditions not explicitly captured as hard constraints or known strengths and gaps remain unknown.",
    },
  },
};

function confirmedScope(
  researchLanguage = CONFIRMED_SCOPE.research_language,
): Record<string, unknown> {
  return researchLanguage === CONFIRMED_SCOPE.research_language
    ? CONFIRMED_SCOPE
    : { ...CONFIRMED_SCOPE, research_language: researchLanguage };
}

function scopeDecisions(
  runId: string,
  researchLanguage = CONFIRMED_SCOPE.research_language,
): readonly Record<string, unknown>[] {
  const scope = confirmedScope(researchLanguage);
  const scopeHash = canonicalContentHash(scope);
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
    scope,
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

async function snapshotRunTree(root: string): Promise<readonly [string, string][]> {
  const files: [string, string][] = [];
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile())
        files.push([relative, (await readFile(absolute)).toString("base64")]);
    }
  };
  await visit(root);
  return files;
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
    current_decision_subject_snapshot_ref: null,
    current_decision_subject_snapshot_hash: null,
    current_discovery_fan_in_ref: null,
    current_discovery_fan_in_hash: null,
    current_pre_candidate_confirmation_ref: null,
    current_pre_candidate_confirmation_hash: null,
    current_pre_candidate_confirmation_action: null,
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
    readonly targetPlanRef?: string;
    readonly phase?: string;
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
      phase: options.phase ?? runManifest.current_phase,
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
        plan_ref:
          options.targetPlanRef ??
          (options.stage === "candidate_revision" ? "plans/research-plan.r2.json" : PLAN_REF),
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
    solution_exploration_observations: [],
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

function userCancellationDecision(runId: string, decisionId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.decision.v1",
    decision_id: decisionId,
    run_id: runId,
    decision_type: "run_cancelled",
    timestamp: "2026-07-24T12:04:30Z",
    actor: "user",
    reason: "The user cancelled the current research Run.",
    artifact_refs: [PLAN_REF],
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

function generationRetryDecision(runId: string): Record<string, unknown> {
  return {
    ...retryDecision(runId),
    adaptation_id: "adapt_generation_retry_runtime_001",
    target_unit: unit(
      "unit_user_language_v2",
      "user_language_mining",
      "artifacts/discovery/generation/unit_user_language_v2.r1.json",
      {
        attempt: 2,
        supersedes_unit_ref: `${PLAN_REF}#acquisition_failed`,
        required_artifact_schema: "startup_opportunity.discovery_generation_result.v1",
        required_outputs: ["startup_opportunity.discovery_generation_result.v1"],
      },
    ),
    reason:
      "The failed candidate-neutral generation unit requires a retry without coupling Artifact revision to execution attempt.",
    success_condition: "A new generation Artifact revision path remains independently valid.",
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

function quantitativeCompetitiveScope(): Record<string, unknown> {
  return {
    scan_mode: "broad_scan",
    required_metric_families: [
      "demand_scale",
      "usage_behavior",
      "commercial_behavior",
      "growth_change",
      "competitive_intensity",
      "distribution",
      "retention_outcomes",
      "unit_economics",
    ],
    required_competitor_types: [
      "direct_product",
      "adjacent_product",
      "service",
      "platform",
      "manual_workaround",
      "status_quo",
      "non_consumption",
    ],
    api_is_optional: true,
    provider_allowlist_enforced: false,
    acquisition_execution_owner: "research_agent_or_caller",
    harness_hidden_network_calls: false,
    prohibited_access_methods: [
      "bypass_access_control",
      "circumvent_login",
      "circumvent_paywall",
      "circumvent_captcha",
      "store_credentials",
    ],
  };
}

function taskSourceBoundary(): Record<string, unknown> {
  return {
    chat_is_artifact: false,
    task_completion_is_artifact: false,
    hidden_llm_calls: false,
    harness_dispatches_agent: false,
    external_validation_supported: false,
    publication_implies_validation: false,
  };
}

function terminalDecisionContext(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.decision_context.v1",
    run_id: runId,
    decision_to_make: "choose_opportunity",
    decision_question: "SYNTHETIC terminal fixture question; not market Evidence.",
    decision_options: ["SYNTHETIC stop without a recommendation."],
    venture_goal: "strategic_exploration",
    decision_horizon: "SYNTHETIC no validated decision horizon.",
    founder_advantages: [],
    non_negotiable_constraints: ["SYNTHETIC external validation remains out of scope."],
    team_capability_refs: [],
    risk_preferences: ["SYNTHETIC preserve an insufficient-evidence conclusion."],
    initial_belief: "SYNTHETIC no opportunity has been established.",
    favored_hypothesis: null,
    assumed_truths: [],
    final_decision_owner: "user",
    assumptions: ["SYNTHETIC fixture content is not Evidence."],
    open_questions: ["SYNTHETIC demand remains unknown."],
  };
}

function terminalScopeFrame(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.scope_frame.discovery.current",
    run_id: runId,
    mode: "opportunity_discovery",
    decision_context_ref: DECISION_CONTEXT_REF,
    direction: "SYNTHETIC bounded opportunity discovery fixture.",
    discovery_profile: "general",
    research_axes: ["user_language", "jtbd_workflow"],
    market: "Synthetic",
    language: "en-US",
    target_users: ["synthetic user"],
    excluded_users: [],
    platform: "SYNTHETIC delivery platform remains unknown.",
    market_motion: "consumer",
    acquisition_motion: ["direct"],
    buyer_models: ["self_payer"],
    payment_modes: ["subscription"],
    native_app_required: false,
    delivery_form_preferences: [],
    business_model_preferences: [],
    team_context: CONFIRMED_SCOPE.team_context,
    risk_preferences: ["SYNTHETIC avoid unsupported conclusions."],
    ai_scope: "optional",
    assumptions: ["SYNTHETIC Scope is not market Evidence."],
    open_questions: ["SYNTHETIC all demand questions remain open."],
  };
}

function incompleteExecutionPlanEnvelope(
  runId: string,
  plan: Record<string, unknown>,
): FormalArtifactEnvelope {
  const plannedUnit = (plan.waves as Record<string, unknown>[])
    .flatMap((wave) => wave.units as Record<string, unknown>[])
    .find((candidate) => candidate.unit_id === "value_pending");
  assert.ok(plannedUnit);
  const commercialAuditOutputPath = "artifacts/research-audits/value_pending.json";
  const envelope = formalEnvelope(
    runId,
    "plans/research-execution.r1.json",
    {
      schema_version: "startup_opportunity.research_execution_plan.discovery.current",
      execution_plan_id: `execution_incomplete_${runId.replaceAll("-", "_")}`,
      run_id: runId,
      mode: "opportunity_discovery",
      revision: 1,
      parent_execution_plan_ref: null,
      research_plan_ref: PLAN_REF,
      research_plan_hash: canonicalContentHash(plan),
      created_at: "2026-07-24T12:07:15Z",
      research_depth: "quick",
      total_time_budget_minutes: 10,
      resource_allocation: {
        customer_commercial_percent: 65,
        market_structure_percent: 17,
        academic_percent: 18,
      },
      stages: [
        {
          stage_id: "stage_incomplete_runtime",
          stage_kind: "discovery_generation",
          depends_on: [],
          gate_before: null,
          gate_after: "terminal_allowed",
          lanes: [
            {
              unit_id: plannedUnit.unit_id,
              lane_role: "opportunity",
              candidate_scope: { kind: "none", candidate_refs: [] },
              incumbent_response_assignment: {
                analysis_depth: "not_assigned",
                assignment_role: "none",
                subject_refs: [],
                rationale: "The synthetic lane has no assigned incumbent response analysis.",
              },
              reporting_dimensions: ["demand"],
              submission_path: "artifacts/discovery/generation/value_pending.r1.json",
              submission_schema: "startup_opportunity.discovery_generation_result.v1",
              commercial_audit_output_path: commercialAuditOutputPath,
              lane_submission_contract: deriveLaneSubmissionContract({
                runId,
                unitId: String(plannedUnit.unit_id),
                taskId: `task_${String(plannedUnit.unit_id)}`,
                attempt: 1,
                formalOutputPath: "artifacts/discovery/generation/value_pending.r1.json",
                formalArtifactSchema: "startup_opportunity.discovery_generation_result.v1",
                commercialAuditOutputPath,
              }),
              time_budget_minutes: 10,
              max_sources: 5,
              straggler_policy: {
                on_timeout: "publish_partial",
                grace_minutes: 0,
                blocks_stage: false,
              },
              dispatch_group: "incomplete_runtime",
            },
          ],
        },
      ],
      limitations: [
        "SYNTHETIC execution plan used to verify truthful pre-Closure runtime failure reporting.",
      ],
    },
    [PLAN_REF],
  );
  return { ...envelope, producer_role: "main_agent" };
}

function incompleteExecutionWaveEnvelopes(
  runId: string,
  plan: Record<string, unknown>,
): readonly FormalArtifactEnvelope[] {
  const executionEnvelope = incompleteExecutionPlanEnvelope(runId, plan);
  const execution = executionEnvelope.document;
  const stage = (execution.stages as Record<string, unknown>[])[0];
  assert.ok(stage);
  const lane = (stage.lanes as Record<string, unknown>[])[0];
  assert.ok(lane);
  const unitId = String(lane.unit_id);
  const wave = (plan.waves as Record<string, unknown>[]).find((candidate) =>
    (candidate.units as Record<string, unknown>[]).some((unit) => unit.unit_id === unitId),
  );
  assert.ok(wave);
  const plannedUnit = (wave.units as Record<string, unknown>[]).find(
    (candidate) => candidate.unit_id === unitId,
  );
  assert.ok(plannedUnit);
  const laneSubmissionContract = lane.lane_submission_contract as Record<string, unknown>;
  const taskId = String(laneSubmissionContract.task_id);
  const taskPath = `tasks/discovery/${unitId}.attempt-1.json`;
  const commercialAuditOutputPath = String(lane.commercial_audit_output_path);
  const decisionContextEnvelope = formalEnvelope(
    runId,
    DECISION_CONTEXT_REF,
    terminalDecisionContext(runId),
  );
  const scopeFrameEnvelope = formalEnvelope(runId, SCOPE_FRAME_REF, terminalScopeFrame(runId), [
    DECISION_CONTEXT_REF,
  ]);
  const taskDocument = {
    schema_version: "startup_opportunity.research_task.discovery_candidate.current",
    task_id: taskId,
    run_id: runId,
    unit_id: unitId,
    mode: "opportunity_discovery",
    phase: "discovery",
    wave_id: wave.wave_id,
    unit_type: plannedUnit.unit_type,
    research_goal: plannedUnit.research_goal,
    commercial_research_requirements: {
      research_stage: "solution_neutral_scan",
      resource_allocation: execution.resource_allocation,
      planned_queries: [
        {
          query: "SYNTHETIC runtime failure lane query; contract fixture only, not Evidence.",
          commercial_dimensions: [
            "user_language",
            "purchase",
            "alternatives",
            "usage",
            "distribution",
            "counterevidence",
          ],
        },
      ],
      quantitative_competitive_scope: quantitativeCompetitiveScope(),
      incumbent_response_assignment: structuredClone(lane.incumbent_response_assignment),
      required_commercial_dimensions: [
        "recent_user_language",
        "purchase_signal",
        "alternatives_pricing_usage",
        "distribution_channel",
        "independent_counterevidence",
      ],
      commercial_audit_output_path: commercialAuditOutputPath,
    },
    target_candidate_refs: [],
    scope_frame_ref: SCOPE_FRAME_REF,
    research_plan_ref: PLAN_REF,
    input_refs: plannedUnit.input_refs,
    attempt: 1,
    supersedes_task_ref: null,
    agent_role: plannedUnit.agent_role,
    source_phase: "candidate_generation",
    required_source_group_ids: ["synthetic_runtime_failure_sources"],
    allowed_output_path: lane.submission_path,
    required_artifact_schema: lane.submission_schema,
    lane_submission_contract: laneSubmissionContract,
    required_stances: ["support", "oppose"],
    stop_conditions: ["SYNTHETIC stop after deterministic runtime failure fixture coverage."],
    completion_message_contract: {
      formal_artifact_authority: false,
      include_artifact_path: true,
      include_limitations: true,
    },
    execution_contract: taskSourceBoundary(),
    dispatched_at: "2026-07-24T12:07:16Z",
  };
  const taskEnvelope = {
    ...formalEnvelope(runId, taskPath, taskDocument, [PLAN_REF, SCOPE_FRAME_REF]),
    producer_role: "main_agent",
  } as FormalArtifactEnvelope;
  const dispatch = {
    schema_version: "startup_opportunity.dispatch_batch.discovery.current",
    batch_id: "batch_incomplete_runtime",
    revision: 1,
    run_id: runId,
    mode: "opportunity_discovery",
    execution_plan_ref: executionEnvelope.artifact_path,
    research_plan_ref: PLAN_REF,
    stage_id: stage.stage_id,
    dispatch_group: lane.dispatch_group,
    task_ready_at: "2026-07-24T12:07:16Z",
    dispatch_requested_at: "2026-07-24T12:07:17Z",
    dispatch_mode: "parallel_immediate",
    tasks: [
      {
        task_id: taskId,
        unit_id: unitId,
        lane_role: lane.lane_role,
        incumbent_response_assignment: structuredClone(lane.incumbent_response_assignment),
        research_goal: plannedUnit.research_goal,
        input_refs: plannedUnit.input_refs,
        allowed_output_path: lane.submission_path,
        required_artifact_schema: lane.submission_schema,
        commercial_audit_output_path: commercialAuditOutputPath,
        lane_submission_contract: laneSubmissionContract,
        time_budget_minutes: lane.time_budget_minutes,
        max_sources: lane.max_sources,
        straggler_policy: structuredClone(lane.straggler_policy),
      },
    ],
    agent_dispatch_performed: false,
    launch_registration_required: true,
    limitations: [
      "SYNTHETIC dispatch closes the incomplete runtime Execution without starting agents.",
    ],
  };
  const dispatchEnvelope = formalEnvelope(
    runId,
    "tasks/dispatch/incomplete-runtime.r1.json",
    dispatch,
    [executionEnvelope.artifact_path, taskPath],
  );
  return [
    decisionContextEnvelope,
    scopeFrameEnvelope,
    taskEnvelope,
    executionEnvelope,
    dispatchEnvelope,
  ];
}

function retargetIncompleteExecutionWave(
  runId: string,
  plan: Record<string, unknown>,
  options: {
    readonly unitId: string;
    readonly executionRevision: number;
    readonly parentExecutionPlanRef: string | null;
    readonly dispatchPath: string;
    readonly taskReadyAt: string;
    readonly dispatchRequestedAt: string;
  },
): readonly FormalArtifactEnvelope[] {
  const base = incompleteExecutionWaveEnvelopes(runId, plan);
  const taskTemplate = structuredClone(base[2]?.document ?? {}) as Record<string, unknown>;
  const executionTemplate = structuredClone(base[3]?.document ?? {}) as Record<string, unknown>;
  const dispatchTemplate = structuredClone(base[4]?.document ?? {}) as Record<string, unknown>;
  const plannedUnit = (plan.waves as Record<string, unknown>[])
    .flatMap((wave) => wave.units as Record<string, unknown>[])
    .find((candidate) => candidate.unit_id === options.unitId);
  assert.ok(plannedUnit);
  const wave = (plan.waves as Record<string, unknown>[]).find((candidate) =>
    (candidate.units as Record<string, unknown>[]).some((unitEntry) => unitEntry === plannedUnit),
  );
  assert.ok(wave);
  const taskId = `task_${options.unitId}`;
  const taskPath = `tasks/discovery/${options.unitId}.attempt-1.json`;
  const formalOutputPath = `artifacts/discovery/generation/${options.unitId}.r1.json`;
  const commercialAuditOutputPath = `artifacts/research-audits/${options.unitId}.json`;
  const laneSubmissionContract = deriveLaneSubmissionContract({
    runId,
    unitId: options.unitId,
    taskId,
    attempt: 1,
    formalOutputPath,
    formalArtifactSchema: "startup_opportunity.discovery_generation_result.v1",
    commercialAuditOutputPath,
  });
  const executionPath = `plans/research-execution.r${String(options.executionRevision)}.json`;
  const executionStages = executionTemplate.stages as Record<string, unknown>[];
  const templateLanes = executionStages[0]?.lanes as Record<string, unknown>[] | undefined;
  assert.ok(templateLanes?.[0]);
  const lane: Record<string, unknown> = {
    ...templateLanes[0],
    unit_id: options.unitId,
    submission_path: formalOutputPath,
    commercial_audit_output_path: commercialAuditOutputPath,
    lane_submission_contract: laneSubmissionContract,
  };
  const executionDocument = {
    ...executionTemplate,
    execution_plan_id: `execution_incomplete_${runId.replaceAll("-", "_")}_r${String(
      options.executionRevision,
    )}`,
    revision: options.executionRevision,
    parent_execution_plan_ref: options.parentExecutionPlanRef,
    created_at: options.taskReadyAt,
    stages: [
      {
        ...((executionTemplate.stages as Record<string, unknown>[])[0] ?? {}),
        lanes: [lane],
      },
    ],
  };
  const taskDocument = {
    ...taskTemplate,
    task_id: taskId,
    unit_id: options.unitId,
    wave_id: wave.wave_id,
    unit_type: plannedUnit.unit_type,
    research_goal: plannedUnit.research_goal,
    input_refs: plannedUnit.input_refs,
    target_candidate_refs: [],
    allowed_output_path: formalOutputPath,
    lane_submission_contract: laneSubmissionContract,
    dispatched_at: options.taskReadyAt,
    commercial_research_requirements: {
      ...(taskTemplate.commercial_research_requirements as Record<string, unknown>),
      commercial_audit_output_path: commercialAuditOutputPath,
      incumbent_response_assignment: structuredClone(lane.incumbent_response_assignment),
    },
  };
  const dispatchTask = {
    ...((dispatchTemplate.tasks as Record<string, unknown>[])[0] ?? {}),
    task_id: taskId,
    unit_id: options.unitId,
    incumbent_response_assignment: structuredClone(lane.incumbent_response_assignment),
    research_goal: plannedUnit.research_goal,
    input_refs: plannedUnit.input_refs,
    allowed_output_path: formalOutputPath,
    commercial_audit_output_path: commercialAuditOutputPath,
    lane_submission_contract: laneSubmissionContract,
  };
  const dispatchDocument = {
    ...dispatchTemplate,
    batch_id: `batch_incomplete_runtime_r${String(options.executionRevision)}`,
    execution_plan_ref: executionPath,
    dispatch_group: lane.dispatch_group,
    task_ready_at: options.taskReadyAt,
    dispatch_requested_at: options.dispatchRequestedAt,
    tasks: [dispatchTask],
  };
  return [
    {
      ...formalEnvelope(runId, taskPath, taskDocument, [PLAN_REF, SCOPE_FRAME_REF]),
      producer_role: "main_agent",
    },
    {
      ...formalEnvelope(runId, executionPath, executionDocument, [PLAN_REF]),
      producer_role: "main_agent",
    },
    formalEnvelope(runId, options.dispatchPath, dispatchDocument, [executionPath, taskPath]),
  ];
}

function completionDecision(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.adaptation_decision.discovery.current",
    adaptation_id: "adapt_complete_research_001",
    run_id: runId,
    based_on_plan_ref: PLAN_REF,
    trigger_gap_refs: [],
    action: "complete_research",
    reason: "Every current Plan unit has a non-failed terminal disposition.",
    expected_decision_impact: ["execution_validity"],
    stop_condition: "The current Plan execution closure is complete.",
    requested_by: "main_agent",
    created_at: "2026-07-24T12:05:00Z",
  };
}

function cancellationAdaptationDecision(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.adaptation_decision.discovery.current",
    adaptation_id: "adapt_cancel_research_001",
    run_id: runId,
    based_on_plan_ref: PLAN_REF,
    trigger_gap_refs: [],
    action: "cancel_research",
    reason: "The exact user Decision cancels the current research Run.",
    expected_decision_impact: ["execution_validity"],
    stop_condition: "The user cancellation authority is exact and current.",
    requested_by: "user",
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
  researchLanguage = CONFIRMED_SCOPE.research_language,
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
    exact_records: scopeDecisions(String(runManifest.run_id), researchLanguage).map((document) => ({
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
      artifactType === "startup_opportunity.adaptation_decision.assessment.current" ||
      artifactType === "startup_opportunity.decision_context.v1" ||
      artifactType === "startup_opportunity.scope_frame.discovery.current" ||
      artifactType === "startup_opportunity.decision_subject_snapshot.current"
        ? "main_agent"
        : "harness",
    input_refs: inputRefs,
    content_hash: canonicalContentHash(document),
    document,
  };
}

function sourceBoundaryContract(): Record<string, unknown> {
  return {
    chat_is_artifact: false,
    task_completion_is_artifact: false,
    hidden_llm_calls: false,
    harness_dispatches_agent: false,
    external_validation_supported: false,
    publication_implies_validation: false,
  };
}

function quantitativeCompetitiveScopeContract(): Record<string, unknown> {
  return {
    scan_mode: "broad_scan",
    required_metric_families: [
      "demand_scale",
      "usage_behavior",
      "commercial_behavior",
      "growth_change",
      "competitive_intensity",
      "distribution",
      "retention_outcomes",
      "unit_economics",
    ],
    required_competitor_types: [
      "direct_product",
      "adjacent_product",
      "service",
      "platform",
      "manual_workaround",
      "status_quo",
      "non_consumption",
    ],
    api_is_optional: true,
    provider_allowlist_enforced: false,
    acquisition_execution_owner: "research_agent_or_caller",
    harness_hidden_network_calls: false,
    prohibited_access_methods: [
      "bypass_access_control",
      "circumvent_login",
      "circumvent_paywall",
      "circumvent_captcha",
      "store_credentials",
    ],
  };
}

function generationFormalWaveRequest(
  runId: string,
  waveId: string,
  unitId: string,
  requestId: string,
  createdAtValue: string,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.formal_stage_materialization_request.current",
    request_id: requestId,
    run_id: runId,
    operation: "validate_only",
    created_at: createdAtValue,
    stage_kind: "discovery_wave",
    wave: {
      wave_id: waveId,
      stage_id: `stage_${requestId}`,
      stage_kind: "discovery_generation",
      unit_ids: [unitId],
      lanes: [
        {
          unit_id: unitId,
          lane_role: "opportunity",
          candidate_scope: { kind: "none", candidate_refs: [] },
          incumbent_response_assignment: {
            analysis_depth: "not_assigned",
            assignment_role: "none",
            subject_refs: [],
            rationale: "Candidate-neutral generation has no incumbent response assignment.",
          },
          reporting_dimensions: ["recent_user_language"],
          time_budget_minutes: 10,
          max_sources: 5,
          straggler_policy: {
            on_timeout: "publish_partial",
            grace_minutes: 2,
            blocks_stage: true,
          },
          commercial_research_semantics: {
            research_stage: "solution_neutral_scan",
            planned_queries: [
              {
                query: "SYNTHETIC candidate-neutral generation query; not external research.",
                commercial_dimensions: ["user_language"],
              },
            ],
            quantitative_competitive_scope: quantitativeCompetitiveScopeContract(),
            required_commercial_dimensions: ["recent_user_language"],
            commercial_audit_output_path: `artifacts/research-audits/${unitId}_${requestId}.json`,
          },
          task_semantics: {
            target_candidate_refs: [],
            source_phase: "candidate_generation",
            required_source_group_ids: [`source_group_${requestId}`],
            required_stances: ["support", "oppose"],
            stop_conditions: ["SYNTHETIC bounded generation stop condition."],
            execution_contract: sourceBoundaryContract(),
          },
        },
      ],
      research_depth: "quick",
      total_time_budget_minutes: 10,
      resource_allocation: {
        customer_commercial_percent: 65,
        market_structure_percent: 17,
        academic_percent: 18,
      },
      gate_before: null,
      gate_after: "required",
      limitations: ["SYNTHETIC generation retry materialization; no research was performed."],
    },
  };
}

function terminalReportSource(
  runId: string,
  decisionSubjectSnapshotHash: string,
  runtimeFailure = false,
  decisionSubjectSnapshotRef = DECISION_SUBJECT_SNAPSHOT_REF,
  currentPlanRef = PLAN_REF,
  generatedAt = "2026-07-24T12:09:30Z",
  terminalOutcomeOverride?: "completed" | "cancelled",
  researchLanguage = CONFIRMED_SCOPE.research_language,
  auditRefs: readonly string[] = [DECISION_REF, GAP_REF, currentPlanRef].sort(),
  relatedGapRef = GAP_REF,
): FormalArtifactEnvelope {
  const artifactPath = "artifacts/reporting/terminal-report-source.r1.json";
  const reportAuditRefs = [...auditRefs].sort();
  const document: Record<string, unknown> = {
    schema_version: "startup_opportunity.terminal_report_source.v1",
    report_id: "terminal_report_runtime_1",
    run_id: runId,
    mode: "opportunity_discovery",
    research_language: researchLanguage,
    producer_role: "main_agent",
    owned_output_path: artifactPath,
    materialized_path: "report.json",
    generated_at: generatedAt,
    decision_subject_snapshot_ref: decisionSubjectSnapshotRef,
    decision_subject_snapshot_hash: decisionSubjectSnapshotHash,
    decision_subject_synthesis_hashes: [],
    current_decision_subject_ids: [],
    terminal_outcome:
      terminalOutcomeOverride ?? (runtimeFailure ? "failed" : "insufficient_evidence"),
    decision_question: "合成测试：这次有边界的机会发现是否应继续？",
    execution: {
      completeness: terminalOutcomeOverride === "completed" ? "complete" : "partial",
      completed_stages:
        terminalOutcomeOverride === "completed" ? ["完整研究计划"] : ["初轮机会发现"],
      incomplete_stages:
        terminalOutcomeOverride === "completed"
          ? []
          : [
              {
                stage: "机会综合",
                cause:
                  terminalOutcomeOverride === "cancelled"
                    ? "user_stopped"
                    : runtimeFailure
                      ? "runtime_blocked"
                      : "evidence_ceiling",
                detail:
                  terminalOutcomeOverride === "cancelled"
                    ? "用户取消了当前研究 Run。"
                    : "合成材料不足以支持继续形成机会结论。",
                conclusion_impact: "本次仅部分执行，不能据此排序任何方向。",
                related_refs: [relatedGapRef],
              },
            ],
      required_followups: [
        {
          followup_id: "bounded_followup",
          status: "legally_closed",
          detail: "当前范围内的有界追加调研已经按最新缺口决定关闭。",
          related_refs: [relatedGapRef],
        },
      ],
      pending_operation_refs: [],
    },
    research_conclusion:
      terminalOutcomeOverride === "completed"
        ? {
            outcome: "no_recommendation",
            current_recommendation: "研究计划已完整执行，但没有形成可支持的机会方向。",
            meaning: "执行完整不代表证据充分，也不自动产生推荐。",
            evidence_strength: "insufficient",
            allowed_claim: "当前研究计划已经完整执行。",
          }
        : terminalOutcomeOverride === "cancelled"
          ? {
              outcome: "no_recommendation",
              current_recommendation: "用户已取消本次研究，不形成研究建议。",
              meaning: "取消是用户生命周期决定，不是市场结论。",
              evidence_strength: "insufficient",
              allowed_claim: "本次研究由用户取消。",
            }
          : runtimeFailure
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
              related_refs: [relatedGapRef],
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
      summary: "合成运行合同测试没有引用市场材料。",
    },
    limitations: ["仅为合成合同测试；没有执行真实市场调研或外部验证。"],
    external_action_boundary: {
      execution_owner: "user",
      execution_supported: false,
      result_tracking_supported: false,
      external_validation_claimed: false,
    },
    audit_refs: reportAuditRefs,
  };
  const source = formalEnvelope(
    runId,
    artifactPath,
    document,
    [...reportAuditRefs, decisionSubjectSnapshotRef].sort(),
    "startup_opportunity.artifact_envelope.current",
  );
  return { ...source, created_at: generatedAt };
}

async function seedRuntimeFailureSubstrateOnlyEvidence(
  runsRoot: string,
  runId: string,
): Promise<readonly Record<string, unknown>[]> {
  const evidence = new EvidenceStore(runsRoot);
  const records: Record<string, unknown>[] = [];
  for (let index = 0; index < 17; index += 1) {
    const publicIndex = index < 12;
    const repeatedUrlBucket = index % 3;
    const recorded = await evidence.record({
      runId,
      unitId: `runtime_failure_capture_${String(index + 1).padStart(2, "0")}`,
      source: publicIndex
        ? {
            kind: "public_url",
            canonical_url:
              index < 6
                ? `https://synthetic.invalid/runtime-failure/shared-${repeatedUrlBucket}`
                : `https://synthetic.invalid/runtime-failure/source-${index + 1}`,
          }
        : {
            kind: "user_provided",
            canonical_uri: `urn:startup-opportunity:user-provided:${runId}-capture-${index + 1}`,
          },
      acquisitionGoal: `SYNTHETIC runtime failure captured source ${index + 1}; retained only as substrate and not formal Evidence.`,
      rawContent: `SYNTHETIC runtime failure raw bytes ${index + 1}; not formal Evidence and not a conclusion source.`,
      recordedAt: `2026-07-24T12:${String(10 + index).padStart(2, "0")}:00Z`,
    });
    records.push(recorded.record as Record<string, unknown>);
  }
  return records;
}

function forgedReadableSource(evidenceRef: string): Record<string, unknown> {
  return {
    source_id: "forged_substrate_source",
    title: "Forged substrate source",
    url: "https://synthetic.invalid/forged-substrate-source",
    source_access: "public",
    retrieved_at: "2026-07-24T12:30:00Z",
    published_at: null,
    observed_at: null,
    data_period_end: null,
    valid_as_of: null,
    freshness_status: "undated",
    claim_type: "vendor_statement",
    claim_state: "observed",
    inference: null,
    source_kind: "vendor",
    evidence_character: "vendor_claim",
    independence: "interested_party",
    commercial_coverage_keys: [],
    stance: "supports",
    strength: "weak",
    claim: "This forged source attempts to turn substrate into conclusion Evidence.",
    evidence_ref: evidenceRef,
  };
}

async function assertNoTerminalReportOutputs(runRoot: string): Promise<void> {
  for (const relativePath of [
    "report.json",
    "decision-brief.md",
    "report.md",
    "audit-appendix.md",
  ]) {
    await assert.rejects(readFile(path.join(runRoot, relativePath), "utf8"));
  }
}

function terminalSourceWithCapturedSubstrateInventory(
  mutate: (inventory: Record<string, unknown>) => void,
): Record<string, unknown> {
  const source = clone(
    terminalReportSource(
      "runtime-renderer-fail-closed",
      sha256Bytes("synthetic decision subject snapshot"),
      true,
      DECISION_SUBJECT_SNAPSHOT_REF,
      PLAN_REF,
      "2026-07-24T12:09:30Z",
      undefined,
      "zh-CN",
    ).document,
  );
  const inventory = {
    status: "captured_not_formalized",
    unformalized_reason: "runtime_failure",
    conclusion_support_status: "does_not_support_conclusions",
    items: [
      {
        evidence_ref: `evidence/manifest.jsonl#ev_${"1".repeat(64)}`,
        source: {
          kind: "public_url",
          canonical_url: "https://synthetic.invalid/runtime-renderer/source",
        },
        research_goal: "SYNTHETIC captured substrate audit identity.",
        recorded_at: "2026-07-24T12:30:00Z",
        status: "captured_not_formalized",
      },
    ],
  };
  mutate(inventory);
  source.research_provenance = {
    available_handoff_count: 0,
    captured_item_count: 0,
    causal_handoff_refs: [],
    consumed_item_refs: [],
    used_handoff_items: [],
    imported_substrate_refs: [],
    formal_inherited_evidence_refs: [],
    adopted_inherited_evidence_refs: [],
    cited_inherited_evidence_refs: [],
    formal_current_evidence_refs: [],
    adopted_current_evidence_refs: [],
    cited_current_evidence_refs: [],
    captured_substrate_inventory: inventory,
    revalidation_gaps: [],
  };
  return source;
}

function terminalApplyInput(
  setup: Awaited<ReturnType<typeof setupPersistedRun>>,
  terminal: Awaited<ReturnType<typeof prepareTerminalReporting>>,
  currentBelief: string,
  times: {
    readonly createdAt: string;
    readonly checkpointCreatedAt: string;
  } = {
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
  },
) {
  return {
    runId: String(setup.currentManifest.run_id),
    adaptationBundle: terminal.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    terminalReportEnvelope: terminal.reportEnvelope,
    createdAt: times.createdAt,
    checkpointCreatedAt: times.checkpointCreatedAt,
    nextStep: "Publish the exact terminal report source.",
    beliefSummary: {
      current_belief: currentBelief,
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Can a later current Run proceed from clean authority?",
    },
  };
}

function discoveryRuntimeEnvelopes(
  setup: Awaited<ReturnType<typeof setupPersistedRun>>,
  artifactTypes: readonly string[],
): readonly FormalArtifactEnvelope[] {
  assert.ok(setup.discoveryBundle);
  return setup.discoveryBundle.documents.flatMap((entry) => {
    const document = entry.document;
    return document.schema_version === "startup_opportunity.artifact_envelope.current" &&
      artifactTypes.includes(String(document.artifact_type))
      ? [document as unknown as FormalArtifactEnvelope]
      : [];
  });
}

function bundleEnvelopesByType(
  bundleValue: DocumentBundle,
  ...artifactTypes: readonly string[]
): readonly FormalArtifactEnvelope[] {
  return bundleValue.documents.flatMap((entry) => {
    const document = entry.document;
    return isRecord(document) &&
      document.schema_version === "startup_opportunity.artifact_envelope.current" &&
      artifactTypes.includes(String(document.artifact_type))
      ? [document as unknown as FormalArtifactEnvelope]
      : [];
  });
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
    | "runtime-failure-discovery"
    | "generation-retry"
    | "runtime-failure-maps"
    | "complete"
    | "cancel"
    | "pre-kill-exact"
    | "pre-kill-missing"
    | "pre-kill-shared"
    | "post-g2-add"
    | "phase-transition-add" = "retry",
  requestedByUser = false,
  eventDriven = false,
  researchLanguage = CONFIRMED_SCOPE.research_language,
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
      researchLanguage,
    },
    createdAt: "2026-07-24T12:00:00Z",
  });
  const preKill = action.startsWith("pre-kill-");
  const runtimeFailure =
    action === "runtime-failure" ||
    action === "runtime-failure-discovery" ||
    action === "runtime-failure-maps";
  const discoveryBacked =
    preKill ||
    action === "post-g2-add" ||
    action === "phase-transition-add" ||
    action === "runtime-failure-discovery" ||
    action === "runtime-failure-maps";
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
          acquisitionGoal: `SYNTHETIC ${label} pre-kill binding substrate; not Evidence.`,
          rawContent: `SYNTHETIC ${label} bytes; not Evidence or validation.`,
          recordedAt: "2026-07-24T12:00:30Z",
        })
      ).record;
    const targetInputRefs =
      action === "post-g2-add" || action === "phase-transition-add"
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
      researchLanguage,
    );
    const bootstrapManifest = (await store.load(runId)).manifest as unknown as Record<
      string,
      unknown
    >;
    bootstrapManifest.current_phase = "discovery";
    await writeFile(
      path.join(runsRoot, runId, "manifest.json"),
      `${canonicalJson(bootstrapManifest)}\n`,
    );
    await publishInitialPlanBundle(store, runId, [
      ...G21_CORE_REFS.map((ref) => fixtureEnvelope(discoveryBundle as DocumentBundle, ref)),
      ...G21_MAP_REFS.map((ref) => fixtureEnvelope(discoveryBundle as DocumentBundle, ref)),
      ...[
        PRE_KILL_CANDIDATE_REF,
        "artifacts/discovery/candidates/candidate_baseline.r1.json",
        RETAINED_SHARED_CANDIDATE_REF,
      ].map((ref) => runtimeEnvelope(discoveryBundle as DocumentBundle, ref)),
    ]);
    plan = runtimeEnvelope(discoveryBundle, PLAN_REF).document;
  } else {
    plan = basePlan(runId);
    let initialPlanningEnvelopes: readonly FormalArtifactEnvelope[] = [
      formalEnvelope(runId, PLAN_REF, plan),
    ];
    if (action === "generation-retry") {
      const generationTarget = (plan.waves as Record<string, unknown>[])
        .flatMap((wave) => wave.units as Record<string, unknown>[])
        .find((unitEntry) => unitEntry.unit_id === "acquisition_failed");
      assert.ok(generationTarget);
      generationTarget.unit_type = "user_language_mining";
      generationTarget.output_path = "artifacts/discovery/generation/acquisition_failed.r1.json";
      generationTarget.required_artifact_schema =
        "startup_opportunity.discovery_generation_result.v1";
      generationTarget.required_outputs = ["startup_opportunity.discovery_generation_result.v1"];
      const formationBundle = await createDiscoveryMapsFixture("general", runId);
      initialPlanningEnvelopes = [
        ...[DECISION_CONTEXT_REF, "intake.json", SCOPE_FRAME_REF].map((ref) =>
          fixtureEnvelope(formationBundle, ref),
        ),
        formalEnvelope(runId, PLAN_REF, plan, [SCOPE_FRAME_REF]),
      ];
    }
    await publishInitialPlanBundle(
      store,
      runId,
      initialPlanningEnvelopes,
      action === "generation-retry" ? "discovery" : "enrichment",
    );
    if (action === "generation-retry") {
      const materializer = new FormalStageMaterializer(runsRoot, validator, repositoryRoot);
      const request = generationFormalWaveRequest(
        runId,
        "wave_runtime_1",
        "acquisition_failed",
        "initial_generation_wave",
        "2026-07-24T12:02:00Z",
      );
      const validated = await materializer.materialize(request);
      await materializer.materialize({
        ...request,
        operation: "publish",
        publication_plan: validated.compilation.publication_plan,
      });
    }
  }
  const runRoot = path.join(runsRoot, runId);
  const persistedManifest = manifest(runId, plan);
  const storeManifest = (await store.load(runId)).manifest;
  persistedManifest.scope_proposal_ref = storeManifest.scope_proposal_ref;
  persistedManifest.scope_proposal_hash = storeManifest.scope_proposal_hash;
  persistedManifest.scope_confirmation_ref = storeManifest.scope_confirmation_ref;
  persistedManifest.scope_confirmation_hash = storeManifest.scope_confirmation_hash;
  persistedManifest.current_phase =
    discoveryBacked || action === "generation-retry" ? "discovery" : "enrichment";
  persistedManifest.artifact_refs = discoveryBacked
    ? storeManifest.artifact_refs
    : action === "generation-retry"
      ? storeManifest.artifact_refs
      : [PLAN_REF, CONTEXT_REF];
  persistedManifest.latest_gap_snapshot_ref = null;
  persistedManifest.pending_adaptation_refs = [];
  if (action === "terminate" || action === "terminate-unclosed") {
    persistedManifest.followup_round = 2;
  }
  await writeFile(path.join(runRoot, "manifest.json"), `${canonicalJson(persistedManifest)}\n`);
  const planningContext = {
    path: CONTEXT_REF,
    document: JSON.parse(
      await readFile(path.join(runRoot, CONTEXT_REF), "utf8"),
    ) as FormalArtifactEnvelope as unknown as Record<string, unknown>,
  };
  const gap = preKill
    ? gapSnapshot(runId, "candidate_pre_killed", PRE_KILL_CANDIDATE_REF)
    : action === "stop-followup"
      ? gapSnapshot(runId, "no_material_new_evidence", PLAN_REF)
      : runtimeFailure
        ? gapSnapshot(runId, "runtime_blocked", PLAN_REF)
        : action === "post-g2-add"
          ? gapSnapshot(runId, "evidence_insufficient", PRE_KILL_CANDIDATE_REF)
          : gapSnapshot(runId);
  if (action === "complete") {
    gap.gaps = [];
    gap.unresolved_decision_relevant_questions = [];
  }
  if (runtimeFailure) {
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
          : runtimeFailure
            ? runtimeFailureDecision(runId)
            : action === "complete"
              ? completionDecision(runId)
              : action === "cancel"
                ? cancellationAdaptationDecision(runId)
                : action === "retry"
                  ? retryDecision(runId)
                  : action === "generation-retry"
                    ? generationRetryDecision(runId)
                    : action === "supersede"
                      ? supersedeDecision(runId)
                      : retryDecision(runId);
  if (action === "post-g2-add" || action === "phase-transition-add") {
    const phaseTransition = action === "phase-transition-add";
    decision.adaptation_id = phaseTransition
      ? "adapt_add_enrichment_after_discovery"
      : "adapt_add_post_g2";
    decision.action = "add_unit";
    delete decision.target_unit_ref;
    delete decision.retry_basis;
    decision.target_unit = {
      unit_id: phaseTransition ? "enrichment_market_space" : "post_g2_followup",
      unit_type: phaseTransition ? "market_space" : "counter_evidence",
      plan_disposition: "enabled",
      priority_band: "high",
      attempt: 1,
      supersedes_unit_ref: null,
      research_goal: phaseTransition
        ? "SYNTHETIC enrichment evaluates retained market-space evidence."
        : "SYNTHETIC post-G2 follow-up remains unvalidated.",
      input_refs: [PRE_KILL_CANDIDATE_REF],
      depends_on: [],
      agent_role: "lane-researcher",
      output_path: phaseTransition
        ? "artifacts/discovery/enrichment/branches/enrichment_market_space.attempt-1.json"
        : "artifacts/discovery/lanes/post_g2_followup.attempt-1.json",
      required_artifact_schema: phaseTransition
        ? "startup_opportunity.enrichment_branch_result.v1"
        : "startup_opportunity.discovery_lane_result.v1",
      source_preferences: [],
      required_outputs: ["SYNTHETIC typed discovery result."],
      stop_conditions: ["SYNTHETIC bounded follow-up only."],
    };
    decision.success_condition = "The added unit publishes one typed discovery result.";
  }
  const userDecision =
    action === "cancel"
      ? userCancellationDecision(runId, `decision_${runId.replaceAll("-", "_")}`)
      : requestedByUser
        ? userPlanDecision(runId, `decision_${runId.replaceAll("-", "_")}`)
        : null;
  if (userDecision !== null) {
    decision.requested_by = "user";
    decision.user_decision_ref = `decisions.jsonl#${String(userDecision.decision_id)}`;
  }
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
  if (action === "complete") {
    beforeCheckpoint.completed_units = [
      "acquisition_failed",
      "buyer_active",
      "counter_completed",
      "value_pending",
    ];
    beforeCheckpoint.active_units = [];
    beforeCheckpoint.failed_units = [];
  }
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
    unresolvedGapRefs: action === "complete" ? [] : [`${GAP_REF}#gap_runtime_001`],
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
  const adaptationBundle = bundle(
    currentManifest,
    plan,
    planningContext,
    gap,
    decision,
    [
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
    ],
    researchLanguage,
  );
  return {
    root,
    runsRoot,
    runRoot,
    store,
    validator,
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
    researchLanguage,
  };
}

async function publishRuntimeEnvelopesAsFormalStage(
  setup: Awaited<ReturnType<typeof setupPersistedRun>>,
  envelopes: readonly FormalArtifactEnvelope[],
  requestId: string,
): Promise<void> {
  const compiler = createFormalStageRuntimeCompiler(
    setup.runsRoot,
    setup.validator,
    repositoryRoot,
  );
  await compiler.compile({
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: requestId,
    run_id: String(envelopes[0]?.run_id ?? ""),
    operation: "publish",
    created_at: String(envelopes[0]?.created_at ?? "2026-07-24T12:07:00Z"),
    artifacts: envelopes.map((envelope) => ({
      artifact_type: envelope.artifact_type,
      artifact_path: envelope.artifact_path,
      producer_role: envelope.producer_role,
      input_refs: envelope.input_refs,
      document: envelope.document,
    })),
  });
}

async function registerRuntimeLaunch(
  setup: Awaited<ReturnType<typeof setupPersistedRun>>,
  dispatchEnvelope: FormalArtifactEnvelope,
  registeredAt: string,
): Promise<void> {
  const registry = new DispatchLaunchRegistry(setup.runsRoot, setup.validator, repositoryRoot);
  const dispatchHash = canonicalContentHash(dispatchEnvelope.document);
  const runId = String(setup.currentManifest.run_id);
  const check = await registry.check(runId, dispatchEnvelope.artifact_path, dispatchHash);
  await registry.register({
    schema_version: "startup_opportunity.dispatch_launch_registration_request.v1",
    request_id: `launch_${runId.replaceAll("-", "_")}`,
    run_id: runId,
    dispatch_ref: dispatchEnvelope.artifact_path,
    dispatch_hash: dispatchHash,
    registered_at: registeredAt,
    registrations: check.checklist.map((item) => ({
      unit_id: item.unit_id,
      task_ref: item.task_ref,
      task_id: item.task_id,
      attempt: item.attempt,
      execution_attempt_id: `external_${item.unit_id}_attempt_1`,
    })),
  });
}

async function publishTerminalLifecycleRevision(
  setup: Awaited<ReturnType<typeof setupPersistedRun>>,
  dispatchEnvelope: FormalArtifactEnvelope,
): Promise<FormalArtifactEnvelope> {
  const runId = String(setup.currentManifest.run_id);
  const statusAfterLaunch = await setup.store.status(runId);
  const lifecycleRoot = (
    await Promise.all(
      statusAfterLaunch.manifest.artifact_refs.map(async (artifactRef) => {
        const envelope = JSON.parse(
          await readFile(path.join(setup.runRoot, artifactRef), "utf8"),
        ) as FormalArtifactEnvelope;
        return envelope.artifact_type === "startup_opportunity.lane_lifecycle.v1" &&
          envelope.document.state === "agent_started"
          ? envelope
          : null;
      }),
    )
  ).find((envelope): envelope is FormalArtifactEnvelope => envelope !== null);
  assert.ok(lifecycleRoot);
  const terminalLifecycleDocument = structuredClone(lifecycleRoot.document);
  terminalLifecycleDocument.revision = 2;
  terminalLifecycleDocument.parent_lifecycle_ref = lifecycleRoot.artifact_path;
  terminalLifecycleDocument.state = "published";
  terminalLifecycleDocument.failure = null;
  terminalLifecycleDocument.timestamps = {
    ...(terminalLifecycleDocument.timestamps as Record<string, unknown>),
    evidence_recorded_at: "2026-07-24T12:07:26Z",
    handoff_ready_at: "2026-07-24T12:07:27Z",
    formalization_validated_at: "2026-07-24T12:07:28Z",
    published_at: "2026-07-24T12:07:29Z",
    ended_at: null,
  };
  const terminalLifecycle = {
    ...formalEnvelope(
      runId,
      canonicalLaneLifecyclePath(terminalLifecycleDocument, 2),
      terminalLifecycleDocument,
      [lifecycleRoot.artifact_path, dispatchEnvelope.artifact_path],
    ),
    producer_role: "main_agent",
  } as FormalArtifactEnvelope;
  await setup.store.publishArtifact({ runId, envelope: terminalLifecycle });
  return terminalLifecycle;
}

async function prepareTerminalReporting(
  setup: Awaited<ReturnType<typeof setupPersistedRun>>,
  runtimeFailure = false,
  terminalOutcomeOverride?: "completed" | "cancelled",
  researchLanguage = setup.researchLanguage,
  generatedAt = "2026-07-24T12:09:30Z",
  auditRefs?: readonly string[],
  relatedGapRef?: string,
) {
  const runId = String(setup.currentManifest.run_id);
  const storedDecisionContextEnvelope =
    setup.discoveryBundle === null
      ? null
      : fixtureEnvelope(setup.discoveryBundle, DECISION_CONTEXT_REF);
  const storedScopeFrameEnvelope =
    setup.discoveryBundle === null ? null : fixtureEnvelope(setup.discoveryBundle, SCOPE_FRAME_REF);
  const decisionContext =
    storedDecisionContextEnvelope?.document ??
    ({
      schema_version: "startup_opportunity.decision_context.v1",
      run_id: runId,
      decision_to_make: "choose_opportunity",
      decision_question: "SYNTHETIC terminal fixture question; not market Evidence.",
      decision_options: ["SYNTHETIC stop without a recommendation."],
      venture_goal: "strategic_exploration",
      decision_horizon: "SYNTHETIC no validated decision horizon.",
      founder_advantages: [],
      non_negotiable_constraints: ["SYNTHETIC external validation remains out of scope."],
      team_capability_refs: [],
      risk_preferences: ["SYNTHETIC preserve an insufficient-evidence conclusion."],
      initial_belief: "SYNTHETIC no opportunity has been established.",
      favored_hypothesis: null,
      assumed_truths: [],
      final_decision_owner: "user",
      assumptions: ["SYNTHETIC fixture content is not Evidence."],
      open_questions: ["SYNTHETIC demand remains unknown."],
    } satisfies Record<string, unknown>);
  const scopeFrame =
    storedScopeFrameEnvelope?.document ??
    ({
      schema_version: "startup_opportunity.scope_frame.discovery.current",
      run_id: runId,
      mode: "opportunity_discovery",
      decision_context_ref: DECISION_CONTEXT_REF,
      direction: "SYNTHETIC bounded opportunity discovery fixture.",
      discovery_profile: "general",
      research_axes: ["user_language", "jtbd_workflow"],
      market: "Synthetic",
      language: researchLanguage,
      target_users: ["synthetic user"],
      excluded_users: [],
      platform: "SYNTHETIC delivery platform remains unknown.",
      market_motion: "consumer",
      acquisition_motion: ["direct"],
      buyer_models: ["self_payer"],
      payment_modes: ["subscription"],
      native_app_required: false,
      delivery_form_preferences: [],
      business_model_preferences: [],
      team_context: CONFIRMED_SCOPE.team_context,
      risk_preferences: ["SYNTHETIC avoid unsupported conclusions."],
      ai_scope: "optional",
      assumptions: ["SYNTHETIC Scope is not market Evidence."],
      open_questions: ["SYNTHETIC all demand questions remain open."],
    } satisfies Record<string, unknown>);
  const snapshotDocument = {
    schema_version: "startup_opportunity.decision_subject_snapshot.current",
    snapshot_id: `decision_subjects_${runId.replaceAll("-", "_")}`,
    revision: 1,
    parent_snapshot_ref: null,
    parent_snapshot_hash: null,
    run_id: runId,
    mode: "opportunity_discovery",
    scope_frame_ref: SCOPE_FRAME_REF,
    scope_frame_hash: canonicalContentHash(scopeFrame),
    research_plan_ref: PLAN_REF,
    research_plan_hash: canonicalContentHash(setup.plan),
    synthesis_input_hashes: [],
    created_at: "2026-07-24T12:07:30Z",
    subjects: [],
    limitations: [
      "SYNTHETIC empty authority: the Run stopped before any final decision subject formed.",
    ],
  };
  const decisionContextEnvelope =
    storedDecisionContextEnvelope ?? formalEnvelope(runId, DECISION_CONTEXT_REF, decisionContext);
  const scopeFrameEnvelope =
    storedScopeFrameEnvelope ??
    formalEnvelope(runId, SCOPE_FRAME_REF, scopeFrame, [DECISION_CONTEXT_REF]);
  const snapshotEnvelope = formalEnvelope(runId, DECISION_SUBJECT_SNAPSHOT_REF, snapshotDocument, [
    PLAN_REF,
    SCOPE_FRAME_REF,
  ]);
  await setup.store.publishArtifactBundle({
    runId,
    envelopes: [decisionContextEnvelope, scopeFrameEnvelope, snapshotEnvelope],
  });

  const currentManifest = (await setup.store.status(runId)).manifest;
  const documentsByPath = new Map(
    structuredClone(setup.adaptationBundle.documents).map((entry) => [entry.path, entry]),
  );
  documentsByPath.set("manifest.json", {
    path: "manifest.json",
    document: currentManifest as unknown as Record<string, unknown>,
  });
  for (const envelope of [decisionContextEnvelope, scopeFrameEnvelope, snapshotEnvelope]) {
    documentsByPath.set(envelope.artifact_path, {
      path: envelope.artifact_path,
      document: envelope as unknown as Record<string, unknown>,
    });
  }
  const adaptationBundle: DocumentBundle = {
    ...setup.adaptationBundle,
    documents: [...documentsByPath.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
  return {
    adaptationBundle,
    reportEnvelope: terminalReportSource(
      runId,
      snapshotEnvelope.content_hash,
      runtimeFailure,
      DECISION_SUBJECT_SNAPSHOT_REF,
      PLAN_REF,
      generatedAt,
      terminalOutcomeOverride,
      researchLanguage,
      auditRefs,
      relatedGapRef,
    ),
  };
}

function sameSyntheticScopeProposal() {
  return {
    geography: "Synthetic",
    customerModel: "b2c" as const,
    targetUsers: ["synthetic user"],
    decisionGoal: "test current contract",
    researchLanguage: "en-US",
  };
}

function formalStageWaveRequest(
  runId: string,
  task: Record<string, unknown>,
  operation: "validate_only" | "publish" = "validate_only",
): Record<string, unknown> {
  const commercial = task.commercial_research_requirements as Record<string, unknown>;
  const candidateRefs = Array.isArray(task.target_candidate_refs)
    ? task.target_candidate_refs.filter((ref): ref is string => typeof ref === "string")
    : [];
  const sourceGroupIds = Array.isArray(task.required_source_group_ids)
    ? task.required_source_group_ids.filter((ref): ref is string => typeof ref === "string")
    : [];
  const stopConditions = Array.isArray(task.stop_conditions)
    ? task.stop_conditions.filter((ref): ref is string => typeof ref === "string")
    : [];
  return {
    schema_version: "startup_opportunity.formal_stage_materialization_request.current",
    request_id: "formal_wave_request",
    run_id: runId,
    operation,
    created_at: "2026-07-28T12:08:00Z",
    stage_kind: "discovery_wave",
    wave: {
      wave_id: String(task.wave_id ?? "wave_discovery_synthetic"),
      stage_id: "stage_candidate_evaluation",
      stage_kind: "candidate_evaluation",
      unit_ids: [String(task.unit_id ?? "unit_counterfactual")],
      lanes: [
        {
          unit_id: String(task.unit_id ?? "unit_counterfactual"),
          lane_role: "evaluation",
          candidate_scope: {
            kind: "explicit",
            candidate_refs: candidateRefs,
          },
          incumbent_response_assignment: {
            analysis_depth: "lightweight_scan",
            assignment_role: "owner",
            subject_refs: candidateRefs,
            rationale: "SYNTHETIC bounded incumbent scan; no research was performed.",
          },
          reporting_dimensions: ["demand", "buyer", "counterevidence"],
          time_budget_minutes: 10,
          max_sources: 5,
          straggler_policy: {
            on_timeout: "publish_partial",
            grace_minutes: 2,
            blocks_stage: true,
          },
          commercial_research_semantics: {
            research_stage: commercial.research_stage,
            planned_queries: commercial.planned_queries,
            quantitative_competitive_scope: commercial.quantitative_competitive_scope,
            required_commercial_dimensions: commercial.required_commercial_dimensions,
            commercial_audit_output_path: commercial.commercial_audit_output_path,
          },
          task_semantics: {
            target_candidate_refs: candidateRefs,
            source_phase: String(task.source_phase ?? "candidate_evaluation"),
            required_source_group_ids: sourceGroupIds,
            required_stances: ["support", "oppose"],
            stop_conditions: stopConditions,
            execution_contract: task.execution_contract,
          },
        },
      ],
      research_depth: "quick",
      total_time_budget_minutes: 10,
      resource_allocation: commercial.resource_allocation,
      gate_before: null,
      gate_after: "required",
      limitations: ["SYNTHETIC materialization test; no research was performed."],
    },
  };
}

function executionPlan(runId: string, plan: Record<string, unknown>): Record<string, unknown> {
  const waves = Array.isArray(plan.waves) ? (plan.waves as Record<string, unknown>[]) : [];
  const stageIdByWaveId = new Map<string, string>();
  for (const [index, wave] of waves.entries()) {
    const waveId = String(wave.wave_id ?? index);
    stageIdByWaveId.set(waveId, `stage_generation_${waveId.replaceAll("-", "_")}`);
  }
  const stages = waves.map((wave, index) => {
    const waveId = String(wave.wave_id ?? index);
    const lanes = (Array.isArray(wave.units) ? (wave.units as Record<string, unknown>[]) : []).map(
      (unit) => ({
        ...(() => {
          const unitId = String(unit.unit_id);
          const formalOutputPath = `artifacts/discovery/generation/${unitId}.r1.json`;
          const commercialAuditOutputPath = `artifacts/research-audits/${unitId}.json`;
          return {
            commercial_audit_output_path: commercialAuditOutputPath,
            lane_submission_contract: deriveLaneSubmissionContract({
              runId,
              unitId,
              taskId: `task_${unitId}`,
              attempt: 1,
              formalOutputPath,
              formalArtifactSchema: "startup_opportunity.discovery_generation_result.v1",
              commercialAuditOutputPath,
            }),
          };
        })(),
        unit_id: unit.unit_id,
        lane_role: "opportunity",
        candidate_scope: { kind: "none", candidate_refs: [] },
        incumbent_response_assignment: {
          analysis_depth: "not_assigned",
          assignment_role: "none",
          subject_refs: [],
          rationale: "This lane is not the assigned incumbent response owner.",
        },
        reporting_dimensions: ["demand", "buyer"],
        submission_path: `artifacts/discovery/generation/${String(unit.unit_id)}.r1.json`,
        submission_schema: "startup_opportunity.discovery_generation_result.v1",
        time_budget_minutes: 10,
        max_sources: 5,
        straggler_policy: {
          on_timeout: "publish_partial",
          grace_minutes: 2,
          blocks_stage: true,
        },
        dispatch_group: `group_generation_${waveId}`,
      }),
    );
    return {
      stage_id: String(
        stageIdByWaveId.get(waveId) ?? `stage_generation_${waveId.replaceAll("-", "_")}`,
      ),
      stage_kind: "discovery_generation",
      depends_on: Array.isArray(wave.depends_on)
        ? wave.depends_on
            .filter((dep): dep is string => typeof dep === "string")
            .map((dep) => stageIdByWaveId.get(dep) ?? dep)
        : [],
      gate_before: null,
      gate_after: "required",
      lanes,
    };
  });
  return {
    schema_version: "startup_opportunity.research_execution_plan.discovery.current",
    execution_plan_id: `execution_generation_synthetic_${runId}`,
    run_id: runId,
    mode: "opportunity_discovery",
    revision: 1,
    parent_execution_plan_ref: null,
    research_plan_ref: PLAN_REF,
    research_plan_hash: canonicalContentHash(plan),
    created_at: "2026-07-28T12:08:00Z",
    research_depth: "quick",
    total_time_budget_minutes: 20,
    resource_allocation: {
      customer_commercial_percent: 65,
      market_structure_percent: 17,
      academic_percent: 18,
    },
    stages,
    limitations: ["SYNTHETIC contract execution overlay; no research was performed."],
  };
}

function runtimeArtifact(
  artifactPath: string,
  document: Record<string, unknown>,
  producerRole: "main_agent" | "lane_researcher" | "harness",
): Record<string, unknown> {
  return {
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    producer_role: producerRole,
    document,
  };
}

function compilationRequest(
  runId: string,
  operation: "validate_only" | "publish",
  artifacts: readonly Record<string, unknown>[],
  requestId = "request_runtime_synthetic",
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: requestId,
    run_id: runId,
    operation,
    created_at: "2026-07-28T12:08:00Z",
    artifacts,
  };
}

async function terminalRuntimeFailureSource(
  contextTest: TestContext,
  runId: string,
  withMaps = false,
) {
  const setup = await setupPersistedRun(
    contextTest,
    runId,
    withMaps ? "runtime-failure-maps" : "runtime-failure",
  );
  const terminal = await prepareTerminalReporting(setup, true);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  await runtime.apply({
    runId,
    adaptationBundle: terminal.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    terminalReportEnvelope: terminal.reportEnvelope,
    createdAt: "2026-07-28T12:08:00Z",
    checkpointCreatedAt: "2026-07-28T12:09:00Z",
    nextStep: "Report the runtime failure and require any repaired execution to use a new Run.",
    beliefSummary: {
      current_belief: "A technical runtime failure prevents a research conclusion.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Can a repaired runtime attempt start under a new Run id?",
    },
  });
  const status = await setup.store.status(runId);
  assert.equal(status.manifest.status, "failed");
  assert.equal(status.terminalReportDisposition, "ready", JSON.stringify(status, null, 2));
  const sourceEnvelope = JSON.parse(
    await readFile(path.join(setup.runRoot, terminal.reportEnvelope.artifact_path), "utf8"),
  ) as FormalArtifactEnvelope;
  return {
    setup,
    terminal,
    sourceStatus: status,
    sourceManifestHash: canonicalContentHash(status.manifest),
    sourceTerminalReportSourceRef: sourceEnvelope.artifact_path,
    sourceTerminalReportSourceHash: sourceEnvelope.content_hash,
  };
}

function technicalRestartDeclaration(
  sourceRunId: string,
  sourceManifestHash: string,
  sourceTerminalReportSourceRef: string,
  sourceTerminalReportSourceHash: string,
  overrides: Partial<{
    readonly sourceRunId: string;
    readonly sourceManifestHash: string;
    readonly sourceTerminalReportSourceRef: string;
    readonly sourceTerminalReportSourceHash: string;
    readonly userAuthorizationAttestation: string;
  }> = {},
) {
  return {
    sourceRunId,
    sourceManifestHash,
    sourceTerminalReportSourceRef,
    sourceTerminalReportSourceHash,
    userAuthorizationAttestation:
      "The fixture caller explicitly authorizes a technical restart after the runtime fix.",
    ...overrides,
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

type DiscoverySynthesisRuntimeState = {
  readonly root: string;
  readonly runsRoot: string;
  readonly runRoot: string;
  readonly runId: string;
  readonly store: RunStore;
  readonly validator: Awaited<ReturnType<typeof createArtifactValidator>>;
  readonly bundle: DocumentBundle;
  readonly plan: Record<string, unknown>;
};

async function setupDiscoverySynthesisRuntimeRun(
  contextTest: TestContext,
  runId: string,
): Promise<DiscoverySynthesisRuntimeState> {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g04-g23-"));
  contextTest.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runRoot = path.join(runsRoot, runId);
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: sameSyntheticScopeProposal(),
    createdAt: "2026-07-27T17:30:00Z",
  });
  const evidence = new EvidenceStore(runsRoot);
  const generation = (
    await evidence.record({
      runId,
      unitId: "unit_seed_independent_demand",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:${runId}-generation`,
      },
      acquisitionGoal: "SYNTHETIC G2.3 generation substrate; not Evidence.",
      rawContent: "SYNTHETIC G2.3 generation bytes; not Evidence.",
      recordedAt: "2026-07-27T17:40:00Z",
    })
  ).record;
  const evaluation = (
    await evidence.record({
      runId,
      unitId: "unit_counterfactual",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:${runId}-evaluation`,
      },
      acquisitionGoal: "SYNTHETIC G2.3 evaluation substrate; not Evidence.",
      rawContent: "SYNTHETIC G2.3 evaluation bytes; not Evidence.",
      recordedAt: "2026-07-27T17:41:00Z",
    })
  ).record;
  const bundleValue = await createDiscoverySynthesisFixture(
    runId,
    { generation, evaluation },
    [],
    "general",
    "en-US",
  );
  await publishInitialPlanBundle(
    store,
    runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(bundleValue, ref)),
  );
  await store.publishArtifactBundle({
    runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundleValue, ref)),
  });
  return {
    root,
    runsRoot,
    runRoot,
    runId,
    store,
    validator,
    bundle: bundleValue,
    plan: fixtureEffective(bundleValue, PLAN_REF),
  };
}

async function publishRuntimeEnvelopesForState(
  state: Pick<DiscoverySynthesisRuntimeState, "runsRoot" | "validator" | "runId">,
  envelopes: readonly FormalArtifactEnvelope[],
  requestId: string,
): Promise<void> {
  await createFormalStageRuntimeCompiler(state.runsRoot, state.validator, repositoryRoot).compile({
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: requestId,
    run_id: state.runId,
    operation: "publish",
    created_at: String(envelopes[0]?.created_at ?? "2026-07-27T18:00:00Z"),
    artifacts: envelopes.map((envelope) => ({
      artifact_type: envelope.artifact_type,
      artifact_path: envelope.artifact_path,
      producer_role: envelope.producer_role,
      input_refs: envelope.input_refs,
      document: envelope.document,
    })),
  });
}

async function publishDiscoverySynthesisReadiness(
  state: DiscoverySynthesisRuntimeState,
): Promise<void> {
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: bundleEnvelopesByType(
      state.bundle,
      "startup_opportunity.discovery_candidate.v1",
    ).filter((candidate) => candidate.document.revision === 1),
  });
  const candidateRuntimeEnvelopes = discoveryWaveEnvelopes(
    state.bundle,
    state.runId,
    "startup_opportunity.research_task.discovery_candidate.current",
    1,
    "candidate_runtime",
  );
  await publishRuntimeEnvelopesForState(
    state,
    candidateRuntimeEnvelopes,
    "request_g0_4_g23_candidate_runtime_wave",
  );
  const dispatchEnvelope = candidateRuntimeEnvelopes.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(dispatchEnvelope);
  const registry = new DispatchLaunchRegistry(state.runsRoot, state.validator, repositoryRoot);
  const checklist = await registry.check(
    state.runId,
    dispatchEnvelope.artifact_path,
    dispatchEnvelope.content_hash,
  );
  await registry.register({
    schema_version: "startup_opportunity.dispatch_launch_registration_request.v1",
    request_id: "launch_g0_4_g23_candidate_runtime",
    run_id: state.runId,
    dispatch_ref: dispatchEnvelope.artifact_path,
    dispatch_hash: dispatchEnvelope.content_hash,
    registered_at: "2026-07-27T18:02:00Z",
    registrations: checklist.checklist.map((entry) => ({
      unit_id: entry.unit_id,
      task_ref: entry.task_ref,
      task_id: entry.task_id,
      attempt: entry.attempt,
      execution_attempt_id: `exec_g0_4_g23_${entry.unit_id}`,
    })),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: bundleEnvelopesByType(
      state.bundle,
      "startup_opportunity.evidence.discovery_candidate.current",
      "startup_opportunity.claim.discovery_candidate.current",
      "startup_opportunity.finding.discovery_candidate.current",
      "startup_opportunity.insight.discovery_candidate.current",
      "startup_opportunity.judgment_assessment.discovery_candidate.current",
      "startup_opportunity.source_manifest.discovery_candidate.current",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: bundleEnvelopesByType(state.bundle, "startup_opportunity.discovery_lane_result.v1"),
  });
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: runtimeEnvelope(state.bundle, G22_DEMAND_R2),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [
      G22_RETAINED_PRE_CANDIDATE,
      G22_WATCHLIST_PRE_CANDIDATE,
      G22_REJECTED_PRE_CANDIDATE,
    ].map((artifactPath) => runtimeEnvelope(state.bundle, artifactPath)),
  });
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: runtimeEnvelope(state.bundle, G22_PRE_CANDIDATE_RELATION),
  });
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: runtimeEnvelope(state.bundle, G22_FAN_IN),
  });
  await state.store.confirmPreCandidates({
    runId: state.runId,
    expectedFanInRef: G22_FAN_IN,
    expectedFanInHash: runtimeEnvelope(state.bundle, G22_FAN_IN).content_hash,
    selectedPreCandidateRefs: [G22_RETAINED_PRE_CANDIDATE],
    nextAction: "proceed_with_selected",
    userConfirmationAttestation:
      "SYNTHETIC caller attests that the user selected the retained pre-candidate for continuation.",
    confirmedAt: "2026-07-27T19:59:00Z",
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: discoverySynthesisReadinessEnvelopes(state.bundle),
  });
}

async function publishedBundleFromRun(
  state: Pick<DiscoverySynthesisRuntimeState, "store" | "runRoot" | "runId">,
): Promise<DocumentBundle> {
  const loaded = await state.store.load(state.runId);
  const documents: { path: string; document: Record<string, unknown> }[] = [
    { path: "manifest.json", document: loaded.manifest as unknown as Record<string, unknown> },
  ];
  for (const artifactRef of [
    ...new Set([
      ...loaded.manifest.artifact_refs,
      ...(loaded.manifest.checkpoint_ref === null ? [] : [loaded.manifest.checkpoint_ref]),
    ]),
  ].sort()) {
    documents.push({
      path: artifactRef,
      document: JSON.parse(await readFile(path.join(state.runRoot, artifactRef), "utf8")) as Record<
        string,
        unknown
      >,
    });
  }
  const decisionRecords = (await readFile(path.join(state.runRoot, "decisions.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    schema_version: "startup_opportunity.document_bundle.current",
    documents,
    exact_records: decisionRecords.map((record) => ({
      ref: `decisions.jsonl#${String(record.decision_id)}`,
      document: record,
    })),
  };
}

async function publishRuntimeFailureAuthorityForDiscovery(
  state: DiscoverySynthesisRuntimeState,
): Promise<DocumentBundle> {
  const gap = gapSnapshot(state.runId, "runtime_blocked", PLAN_REF);
  gap.snapshot_id = "gap_runtime_preserve_discovery";
  gap.snapshot_cycle_key = canonicalContentHash({
    run_id: state.runId,
    base: PLAN_REF,
    runtime_failure: true,
  });
  gap.created_at = "2026-07-27T20:12:00Z";
  gap.phase = "discovery";
  gap.wave_id = "wave_discovery_synthetic";
  gap.observed_artifact_refs = [G23_READINESS, G23_READINESS_GAP, G22_FAN_IN];
  const gapEntry = (gap.gaps as Record<string, unknown>[])[0];
  assert.ok(gapEntry);
  gapEntry.basis_refs = ["manifest.json", PLAN_REF, G23_READINESS, G23_READINESS_GAP, G22_FAN_IN];
  gapEntry.evidence_refs = [];
  gapEntry.decision_impact = ["execution_validity"];
  gapEntry.recommended_unit_types = [];
  gap.stop_signals = ["runtime_blocked"];
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: formalEnvelope(
      state.runId,
      GAP_REF,
      gap,
      [PLAN_REF, G23_READINESS, G23_READINESS_GAP, G22_FAN_IN],
      "startup_opportunity.artifact_envelope.current",
    ),
  });
  const decision = runtimeFailureDecision(state.runId);
  decision.created_at = "2026-07-27T20:13:00Z";
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: formalEnvelope(state.runId, DECISION_REF, decision, [PLAN_REF, GAP_REF]),
  });
  const manifestPath = path.join(state.runRoot, "manifest.json");
  const currentManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  currentManifest.latest_gap_snapshot_ref = GAP_REF;
  currentManifest.pending_adaptation_refs = [DECISION_REF];
  currentManifest.validated_adaptation_refs = [];
  currentManifest.rejected_adaptation_refs = [];
  currentManifest.applied_adaptation_refs = [];
  currentManifest.updated_at = "2026-07-27T20:13:30Z";
  await writeFile(manifestPath, `${canonicalJson(currentManifest)}\n`);
  return publishedBundleFromRun(state);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refreshStoredEnvelope(envelope: Record<string, unknown>): void {
  assert.ok(isRecord(envelope.document));
  envelope.content_hash = canonicalContentHash(envelope.document);
}

function refreshPlanReceiptControlBindings(receipt: Record<string, unknown>): void {
  const controlEnvelopes = Array.isArray(receipt.control_envelopes)
    ? receipt.control_envelopes.filter(isRecord)
    : [];
  receipt.control_envelope_bindings = controlEnvelopes
    .map((envelope) => ({
      artifact_path: String(envelope.artifact_path),
      artifact_type: String(envelope.artifact_type),
      content_hash: String(envelope.content_hash),
      envelope_hash: canonicalContentHash(envelope),
    }))
    .sort((left, right) => left.artifact_path.localeCompare(right.artifact_path));
}

async function tamperRuntimeFailurePlanReceipt(
  runRoot: string,
  mutate: (receipt: Record<string, unknown>, controlEnvelopes: Record<string, unknown>[]) => void,
): Promise<void> {
  const receiptPath = await planReceiptFile(runRoot);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  const controlEnvelopes = Array.isArray(receipt.control_envelopes)
    ? receipt.control_envelopes.filter(isRecord)
    : [];
  mutate(receipt, controlEnvelopes);
  for (const envelope of controlEnvelopes) {
    if (isRecord(envelope.document)) {
      refreshStoredEnvelope(envelope);
    }
  }
  refreshPlanReceiptControlBindings(receipt);
  await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
}

async function tamperPlanReceiptBaseManifestWithCoordinatedIdentity(
  runRoot: string,
  mutateBaseManifest: (baseManifest: Record<string, unknown>) => void,
): Promise<void> {
  const priorReceiptPath = await planReceiptFile(runRoot);
  const receipt = JSON.parse(await readFile(priorReceiptPath, "utf8")) as Record<string, unknown>;
  const baseManifest = receipt.base_manifest as Record<string, unknown>;
  mutateBaseManifest(baseManifest);
  receipt.base_manifest_hash = canonicalContentHash(baseManifest);
  const planOperationKey = operationKey("apply_plan_revision", {
    parent_plan_hash: receipt.base_plan_hash,
    base_manifest_hash: receipt.base_manifest_hash,
    adaptation_refs: receipt.adaptation_refs,
  });
  const terminalOperation = receipt.terminal_report_operation as Record<string, unknown> | null;
  const nextOperationKey =
    terminalOperation === null
      ? planOperationKey
      : operationKey("apply_terminal_closeout", {
          plan_operation_key: planOperationKey,
          report_request_hash: canonicalContentHash(terminalOperation.request_envelope),
        });
  receipt.operation_key = nextOperationKey;
  for (const eventRecord of Array.isArray(receipt.events) ? receipt.events.filter(isRecord) : []) {
    eventRecord.event_id = `${String(eventRecord.event_type)}_${sha256Hex(
      operationKey("plan_runtime_event", {
        operation_key: nextOperationKey,
        event_type: eventRecord.event_type,
        artifact_refs: eventRecord.artifact_refs,
      }),
    )}`;
  }
  const nextReceiptPath = path.join(
    path.dirname(priorReceiptPath),
    `plan-revision-${sha256Hex(nextOperationKey)}.json`,
  );
  await writeFile(nextReceiptPath, `${canonicalJson(receipt)}\n`);
  if (nextReceiptPath !== priorReceiptPath) {
    await rm(priorReceiptPath);
  }
}

async function tamperStoredEnvelopeOnly(
  runRoot: string,
  artifactPath: string,
  mutateDocument: (document: Record<string, unknown>) => void,
): Promise<void> {
  const targetPath = path.join(runRoot, artifactPath);
  const envelope = JSON.parse(await readFile(targetPath, "utf8")) as Record<string, unknown>;
  assert.ok(isRecord(envelope.document));
  mutateDocument(envelope.document);
  refreshStoredEnvelope(envelope);
  await writeFile(targetPath, `${canonicalJson(envelope)}\n`);
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

  const publications = path.join(runRoot, ".store/publications");
  const commits = await Promise.all(
    (await readdir(publications)).map(
      async (filename) =>
        JSON.parse(await readFile(path.join(publications, filename), "utf8")) as Record<
          string,
          unknown
        >,
    ),
  );
  commits.sort(
    (left, right) => Number(left.publication_ordinal) - Number(right.publication_ordinal),
  );
  let previousCommitHash: string | null = null;
  let rewriteChain = false;
  for (const commit of commits) {
    if (commit.artifact_path === artifactPath) {
      commit.operation_key = nextOperationKey;
      commit.content_hash = envelope.content_hash;
      rewriteChain = true;
    }
    if (rewriteChain) {
      commit.previous_commit_hash = previousCommitHash;
      const { publication_commit_hash: _discarded, ...identity } = commit;
      commit.publication_commit_hash = canonicalContentHash(identity);
    }
    previousCommitHash = String(commit.publication_commit_hash);
  }
  assert.equal(rewriteChain, true, artifactPath);
  await rm(publications, { recursive: true, force: true });
  await mkdir(publications, { recursive: true });
  for (const commit of commits) {
    const filename = `publication-${String(commit.publication_ordinal).padStart(12, "0")}-${sha256Hex(
      String(commit.publication_commit_hash),
    )}.json`;
    await writeFile(path.join(publications, filename), `${canonicalJson(commit)}\n`);
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
  phase?: string,
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
    path: CANDIDATE_CONTEXT_REF,
    revision: 2,
    parentRef: CONTEXT_REF,
    stage: "candidate_revision",
    createdAt: candidateContextCreatedAt,
    ...(phase === undefined ? {} : { phase }),
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

function setupWithCurrentManifest(
  setup: Awaited<ReturnType<typeof setupPersistedRun>>,
  currentManifest: Record<string, unknown>,
): Awaited<ReturnType<typeof setupPersistedRun>> {
  const documents = structuredClone([...setup.adaptationBundle.documents]) as {
    path: string;
    document: Record<string, unknown>;
  }[];
  const manifestEntry = documents.find((entry) => entry.path === "manifest.json");
  if (manifestEntry === undefined) {
    documents.push({
      path: "manifest.json",
      document: structuredClone(currentManifest),
    });
  } else {
    manifestEntry.document = structuredClone(currentManifest);
  }
  const adaptationBundle: DocumentBundle = {
    ...structuredClone(setup.adaptationBundle),
    documents,
  };
  return {
    ...setup,
    currentManifest: structuredClone(currentManifest),
    adaptationBundle,
  };
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
    path: CANDIDATE_CONTEXT_REF,
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

  const generation = clone(validBundle);
  const generationPlan = generation.documents.find((entry) => entry.path === PLAN_REF)
    ?.document as Record<string, unknown>;
  const generationUnits = (generationPlan.waves as { units: Record<string, unknown>[] }[])[0]
    ?.units;
  assert.ok(generationUnits);
  generationUnits.push(
    unit(
      "user_language_mining_001",
      "user_language_mining",
      "artifacts/discovery/generation/user_language_mining_001.r1.json",
      {
        required_artifact_schema: "startup_opportunity.discovery_generation_result.v1",
      },
    ),
  );
  generationUnits.push(
    unit(
      "unit_user_language_v2",
      "user_language_mining",
      "artifacts/discovery/generation/unit_user_language_v2.r1.json",
      {
        attempt: 2,
        supersedes_unit_ref: `${PLAN_REF}#user_language_mining_001`,
        required_artifact_schema: "startup_opportunity.discovery_generation_result.v1",
      },
    ),
  );
  const generationPlanHash = canonicalContentHash(generationPlan);
  const generationContext = generation.documents.find((entry) => entry.path === CONTEXT_REF)
    ?.document as Record<string, unknown>;
  assert.ok(generationContext);
  (generationContext.target_plan_binding as Record<string, unknown>).plan_content_hash =
    generationPlanHash;
  assert.equal(validator.validateDocumentBundle(generation).valid, true);

  const obsoleteGenerationPath = clone(generation);
  const obsoleteGenerationPlan = obsoleteGenerationPath.documents.find(
    (entry) => entry.path === PLAN_REF,
  )?.document as Record<string, unknown>;
  const obsoleteGenerationUnit = (
    obsoleteGenerationPlan.waves as { units: Record<string, unknown>[] }[]
  )[0]?.units.find((candidate) => candidate.unit_id === "user_language_mining_001");
  assert.ok(obsoleteGenerationUnit);
  obsoleteGenerationUnit.output_path =
    "artifacts/discovery/generation/user_language_mining_001.attempt-1.json";
  assert.ok(
    validator
      .validateDocumentBundle(obsoleteGenerationPath)
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

test("public RunStore and publish-artifact reject an illegal initial Plan before any write", async (contextTest) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-plan-publication-"));
  contextTest.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "public-plan-semantic-preflight";
  const store = new RunStore(runsRoot, await createArtifactValidator(repositoryRoot));
  const fixture = await createDiscoveryMapsFixture("general", runId);
  const intake = fixtureEnvelope(fixture, "intake.json").document;
  const confirmedScope = intake.scope_confirmation as Record<string, unknown>;
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-28T08:00:00Z",
    scopeProposal: {
      geography: String(confirmedScope.geography),
      customerModel: String(confirmedScope.customer_model) as "b2c",
      targetUsers: confirmedScope.target_users as string[],
      decisionGoal: String(confirmedScope.decision_goal),
      researchLanguage: String(confirmedScope.research_language),
    },
  });
  await store.publishArtifactBundle({
    runId,
    envelopes: G21_CORE_REFS.filter((ref) => ref !== PLAN_REF).map((ref) =>
      fixtureEnvelope(fixture, ref),
    ),
  });

  const legalPlan = structuredClone(fixtureEnvelope(fixture, PLAN_REF));
  const units = (legalPlan.document.waves as { units: Record<string, unknown>[] }[])[0]?.units;
  assert.ok(units?.[0] && units[1]);
  units.push({
    ...structuredClone(units[1]),
    unit_id: "unit_bounded_domain_research",
    unit_type: "bounded_domain_research",
    lane_kind: "buyer_commercial_research",
    output_path: "artifacts/discovery/lanes/unit_bounded_domain_research.attempt-1.json",
  });
  (legalPlan as { content_hash: string }).content_hash = canonicalContentHash(legalPlan.document);
  const illegalPlan = structuredClone(legalPlan);
  const illegalUnit = (illegalPlan.document.waves as { units: Record<string, unknown>[] }[])[0]
    ?.units[0];
  assert.ok(illegalUnit);
  illegalUnit.unit_type = "buyer_language";
  (illegalPlan as { content_hash: string }).content_hash = canonicalContentHash(
    illegalPlan.document,
  );
  const illegalBundleEnvelopes = await initialPlanBundleEnvelopes(store, runId, [illegalPlan]);
  const runRoot = path.join(runsRoot, runId);
  const before = await snapshotRunTree(runRoot);
  const rejectsPlanning = (error: unknown) =>
    error instanceof StoreError && error.code === "artifact.planning_preflight_failed";
  const rejectsTuple = (error: unknown) =>
    error instanceof StoreError &&
    error.code === "artifact.planning_preflight_failed" &&
    JSON.stringify(error.details).includes("contract.unit_tuple_not_allowed");

  await assert.rejects(store.publishArtifact({ runId, envelope: illegalPlan }), rejectsPlanning);
  assert.deepEqual(await snapshotRunTree(runRoot), before);
  await assert.rejects(
    store.publishArtifactBundle({ runId, envelopes: illegalBundleEnvelopes }),
    rejectsTuple,
  );
  assert.deepEqual(await snapshotRunTree(runRoot), before);

  const cliBundleFile = path.join(root, "illegal-plan-bundle.json");
  await writeFile(
    cliBundleFile,
    `${canonicalJson({
      schema_version: "startup_opportunity.document_bundle.current",
      documents: illegalBundleEnvelopes.map((envelope) => ({
        path: envelope.artifact_path,
        document: envelope,
      })),
    })}\n`,
  );
  const cli = runScript("harness/src/cli.ts", [
    "publish-artifact",
    "--runs-root",
    runsRoot,
    "--file",
    cliBundleFile,
  ]);
  assert.equal(cli.status, 1, cli.stderr || cli.stdout);
  assert.match(cli.stderr, /contract\.unit_tuple_not_allowed/u);
  assert.deepEqual(await snapshotRunTree(runRoot), before);

  const legalBundleEnvelopes = await initialPlanBundleEnvelopes(store, runId, [legalPlan]);
  const published = await store
    .publishArtifactBundle({ runId, envelopes: legalBundleEnvelopes })
    .catch((error: unknown) => {
      if (error instanceof StoreError) assert.fail(JSON.stringify(error.details, null, 2));
      throw error;
    });
  assert.equal(published.status, "published");
  assert.equal(
    (await store.publishArtifactBundle({ runId, envelopes: legalBundleEnvelopes })).status,
    "idempotent_replay",
  );
  const reopened = await new RunStore(runsRoot, await createArtifactValidator(repositoryRoot)).load(
    runId,
  );
  assert.equal(reopened.manifest.current_plan_ref, PLAN_REF);
  assert.equal(reopened.manifest.status, "planned");
  assert.deepEqual(
    (legalPlan.document.waves as { units: Record<string, unknown>[] }[])[0]?.units.map(
      (unit) => unit.unit_type,
    ),
    ["user_language_mining", "counter_evidence", "bounded_domain_research"],
  );
});

test("public publication cannot replace leaf planning authority after the initial Plan", async (contextTest) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-planning-authority-"));
  contextTest.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "public-planning-authority-boundary";
  const store = new RunStore(runsRoot, await createArtifactValidator(repositoryRoot));
  const fixture = await createDiscoveryMapsFixture("general", runId);
  const intake = fixtureEnvelope(fixture, "intake.json").document;
  const confirmedScope = intake.scope_confirmation as Record<string, unknown>;
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-28T08:00:00Z",
    scopeProposal: {
      geography: String(confirmedScope.geography),
      customerModel: String(confirmedScope.customer_model) as "b2c",
      targetUsers: confirmedScope.target_users as string[],
      decisionGoal: String(confirmedScope.decision_goal),
      researchLanguage: String(confirmedScope.research_language),
    },
  });
  await store.publishArtifactBundle({
    runId,
    envelopes: G21_CORE_REFS.filter((ref) => ref !== PLAN_REF).map((ref) =>
      fixtureEnvelope(fixture, ref),
    ),
  });
  const initialPlanning = await initialPlanBundleEnvelopes(store, runId, [
    fixtureEnvelope(fixture, PLAN_REF),
  ]);
  assert.equal(
    (await store.publishArtifactBundle({ runId, envelopes: initialPlanning })).status,
    "published",
  );
  const initialContext = initialPlanning.find(
    (envelope) =>
      envelope.artifact_type === "startup_opportunity.planning_context.ai_source_bound.current",
  );
  assert.ok(initialContext);
  const currentManifest = (await store.load(runId)).manifest;
  assert.equal(currentManifest.current_phase, "discovery");
  assert.equal(currentManifest.current_plan_ref, PLAN_REF);

  const driftedContextDocument = structuredClone(initialContext.document);
  driftedContextDocument.revision = 2;
  driftedContextDocument.parent_context_ref = CONTEXT_REF;
  driftedContextDocument.phase = "enrichment";
  driftedContextDocument.validation_stage = "current_plan";
  driftedContextDocument.created_at = "2026-07-28T08:02:00Z";
  driftedContextDocument.manifest_binding = {
    manifest_ref: "manifest.json",
    manifest_schema_version: "startup_opportunity.run_manifest.v1",
    run_id: runId,
    mode: currentManifest.mode,
    current_plan_ref: currentManifest.current_plan_ref,
    current_plan_revision: currentManifest.plan_revision,
    run_state_hash: planningRunStateHash({
      manifest_ref: "manifest.json",
      manifest_schema_version: "startup_opportunity.run_manifest.v1",
      run_id: runId,
      mode: currentManifest.mode,
      current_plan_ref: currentManifest.current_plan_ref as string,
      current_plan_revision: currentManifest.plan_revision,
    }),
  };
  const driftedContext: FormalArtifactEnvelope = {
    ...initialContext,
    artifact_path: "plans/planning-context.r2.json",
    created_at: "2026-07-28T08:02:00Z",
    input_refs: ["manifest.json", PLAN_REF, CONTEXT_REF],
    content_hash: canonicalContentHash(driftedContextDocument),
    document: driftedContextDocument,
  };

  const triggerDocument = {
    schema_version: "startup_opportunity.ai_trigger_source_attestation.v1",
    attestation_id: "ai_trigger_source_public_injection",
    run_id: runId,
    mode: currentManifest.mode,
    planning_context_binding: {
      context_id: initialContext.document.context_id,
      context_revision: initialContext.document.revision,
    },
    subject_ref: "scope-frame.json",
    trigger: {
      trigger_version: "startup_opportunity.ai_mandatory_coverage_trigger.v1",
      signal: "uses_ai",
      declared_value: "true",
    },
    producer_role: "main_agent",
    created_at: "2026-07-28T08:02:00Z",
  };
  const triggerEnvelope: FormalArtifactEnvelope = {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: "startup_opportunity.ai_trigger_source_attestation.v1",
    artifact_path: "plans/ai-trigger-source.r1.json",
    run_id: runId,
    created_at: String(triggerDocument.created_at),
    producer_role: "main_agent",
    input_refs: [CONTEXT_REF, "scope-frame.json"],
    content_hash: canonicalContentHash(triggerDocument),
    document: triggerDocument,
  };
  const runRoot = path.join(runsRoot, runId);
  const before = await snapshotRunTree(runRoot);
  const rejectsAuthority = (error: unknown) =>
    error instanceof StoreError && error.code === "artifact.planning_authority_entry_required";

  await assert.rejects(
    store.publishArtifact({ runId, envelope: driftedContext }),
    rejectsAuthority,
  );
  assert.deepEqual(await snapshotRunTree(runRoot), before);
  await assert.rejects(
    store.publishArtifactBundle({ runId, envelopes: [driftedContext] }),
    rejectsAuthority,
  );
  assert.deepEqual(await snapshotRunTree(runRoot), before);

  const cliInput = path.join(root, "drifted-planning-context.json");
  await writeFile(cliInput, `${canonicalJson(driftedContext)}\n`);
  const cli = runScript("harness/src/cli.ts", [
    "publish-artifact",
    "--runs-root",
    runsRoot,
    "--file",
    cliInput,
  ]);
  assert.equal(cli.status, 1, cli.stderr || cli.stdout);
  assert.match(cli.stderr, /artifact\.planning_authority_entry_required/u);
  assert.deepEqual(await snapshotRunTree(runRoot), before);

  await assert.rejects(
    store.publishArtifact({ runId, envelope: triggerEnvelope }),
    rejectsAuthority,
  );
  assert.deepEqual(await snapshotRunTree(runRoot), before);
  await assert.rejects(
    store.publishArtifactBundle({ runId, envelopes: [initialContext, triggerEnvelope] }),
    rejectsAuthority,
  );
  assert.deepEqual(await snapshotRunTree(runRoot), before);

  const reopened = new RunStore(runsRoot, await createArtifactValidator(repositoryRoot));
  assert.equal(
    (await reopened.publishArtifact({ runId, envelope: initialContext })).status,
    "idempotent_replay",
  );
  assert.deepEqual(await snapshotRunTree(runRoot), before);
});

test("Gap analyzer emits deterministic checks and preserves explicit semantic gaps", async () => {
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
    agentDeclaredGaps: [
      {
        declarationId: "question_fragment_check",
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
    agentDeclaredGaps: [
      {
        declarationId: "missing_question_fragment_check",
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

  const semanticConflict = analyzer.analyze({
    ...input,
    materialNewEvidenceObserved: true,
    agentDeclaredGaps: [
      {
        declarationId: "semantic_conflict",
        gapType: "evidence_conflict",
        subjectRef: `${PLAN_REF}#rq_runtime_001`,
        basisRefs: [`${PLAN_REF}#rq_runtime_001`],
        evidenceRefs: [],
        decisionImpact: ["next_action"],
        severity: "advisory",
        recommendedUnitTypes: ["counter_evidence"],
        detail: "The current evidence has unresolved conflict.",
      },
    ],
  });
  assert.equal(semanticConflict.valid, true, JSON.stringify(semanticConflict.errors));
  assert.ok(semanticConflict.snapshot);
  const semanticGap = (semanticConflict.snapshot.gaps as Record<string, unknown>[]).find(
    (gap) => gap.detection_mode === "agent_semantic",
  );
  assert.deepEqual(semanticGap?.triggered_by, {
    declaration_id: "semantic_conflict",
    declared_by: "main_agent",
    observed_artifact_refs: [],
    detail: "The current evidence has unresolved conflict.",
  });
  assert.deepEqual(semanticGap?.evidence_refs, []);
  assert.equal(semanticGap?.gap_type, "evidence_conflict");

  const semanticWithoutBasis = analyzer.analyze({
    ...input,
    agentDeclaredGaps: [
      {
        declarationId: "semantic_without_basis",
        gapType: "evidence_insufficient",
        subjectRef: `${PLAN_REF}#rq_runtime_001`,
        basisRefs: [],
        evidenceRefs: [],
        decisionImpact: ["next_action"],
        severity: "material",
        recommendedUnitTypes: [],
        detail: "The evidence is not sufficient for the next decision.",
      },
    ],
  });
  assert.ok(
    semanticWithoutBasis.errors.some((error) => error.code === "gap.agent_declaration_invalid"),
  );
});

test("Gap CLI rejects caller machine checks and malformed Agent declarations", async (contextTest) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-gap-cli-authority-"));
  contextTest.after(() => rm(root, { recursive: true, force: true }));
  const machineInput = path.join(root, "machine-input.json");
  await writeFile(
    machineInput,
    `${canonicalJson({
      schema_version: "startup_opportunity.gap_analysis_input.v1",
      machine_checks: [],
    })}\n`,
  );
  const machineResult = runScript("harness/src/cli.ts", ["analyze-gaps", "--file", machineInput]);
  assert.equal(machineResult.status, 64);
  assert.equal(
    (JSON.parse(machineResult.stderr) as { error: { code: string } }).error.code,
    "command.invalid_arguments",
  );

  const malformedInput = path.join(root, "malformed-agent-input.json");
  await writeFile(
    malformedInput,
    `${canonicalJson({
      schema_version: "startup_opportunity.gap_analysis_input.v1",
      agent_declared_gaps: "not-an-array",
    })}\n`,
  );
  const malformedResult = runScript("harness/src/cli.ts", [
    "analyze-gaps",
    "--file",
    malformedInput,
  ]);
  assert.equal(malformedResult.status, 64);
  assert.equal(
    (JSON.parse(malformedResult.stderr) as { error: { code: string } }).error.code,
    "command.invalid_arguments",
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
      agentDeclaredGaps: [
        {
          declarationId: "foreign_basis",
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
      agentDeclaredGaps: [
        {
          declarationId: "foreign_evidence",
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
      candidateRefs: [
        "artifacts/discovery/candidates/candidate_baseline.r1.json",
        PRE_KILL_CANDIDATE_REF,
        RETAINED_SHARED_CANDIDATE_REF,
      ],
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

test("plan-bound handoff exact replay survives Plan r2 while new consumption stays bound to r1", async (contextTest) => {
  const runId = "runtime-handoff-plan-applicability";
  const sourceRunId = "runtime-handoff-plan-source";
  const setup = await setupPersistedRun(contextTest, runId, "pre-kill-exact");
  const sourceBundle = await createDiscoveryMapsFixture("general", sourceRunId);
  await createConfirmedRun(setup.store, {
    runId: sourceRunId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-24T11:00:00Z",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic prior handoff user"],
      decisionGoal: "supply exact authorized prior inputs for Plan applicability testing",
      researchLanguage: "en-US",
    },
  });
  await publishInitialPlanBundle(
    setup.store,
    sourceRunId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(sourceBundle, ref)),
  );
  await setup.store.publishArtifactBundle({
    runId: sourceRunId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(sourceBundle, ref)),
  });
  const sourceItems = await Promise.all(
    [
      {
        itemId: "prior_opportunity",
        sourceArtifactPath: G21_OPPORTUNITY_REF,
        targetArtifactRef: "artifacts/discovery/opportunities/opportunity_a.r1.json",
      },
      {
        itemId: "prior_solution",
        sourceArtifactPath: G21_SOLUTION_REF,
        targetArtifactRef: "artifacts/discovery/opportunities/opportunity_b.r1.json",
      },
    ].map(async (item) => {
      const bytes = await readFile(path.join(setup.runsRoot, sourceRunId, item.sourceArtifactPath));
      const envelope = JSON.parse(bytes.toString("utf8")) as FormalArtifactEnvelope;
      return {
        ...item,
        role: "prior_synthesis" as const,
        expectedSourceByteHash: sha256Bytes(bytes),
        expectedSourceContentHash: envelope.content_hash,
        freshnessDisposition: "historical" as const,
        applicabilityDisposition: "partially_applicable" as const,
        revalidationStatus: "required" as const,
      };
    }),
  );
  const handoff = await setup.store.createResearchHandoff({
    runId,
    handoffId: "handoff_plan_r1",
    sourceRunId,
    userAuthorizationAttestation:
      "The fixture caller attests explicit authorization for these exact prior items.",
    targetPurpose: "Use prior synthesis only as an r1-bound hypothesis input.",
    capturedAt: "2026-07-24T12:07:30Z",
    items: sourceItems,
  });
  const consumed = await setup.store.readResearchHandoff({
    runId,
    handoffRef: handoff.handoffRef,
    itemIds: ["prior_opportunity"],
    consumedAt: "2026-07-24T12:07:40Z",
  });

  const afterHandoff = setupWithCurrentManifest(
    setup,
    (await setup.store.status(runId)).manifest as unknown as Record<string, unknown>,
  );
  const { candidateBundle } = candidateFor(afterHandoff, PRE_KILL_APPLY_AT, PRE_KILL_CONTEXT_AT);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  assert.equal(
    (await runtime.apply(preKillApplyInput(afterHandoff, candidateBundle))).currentPlanRef,
    "plans/research-plan.r2.json",
  );
  const replay = await setup.store.readResearchHandoff({
    runId,
    handoffRef: handoff.handoffRef,
    itemIds: ["prior_opportunity"],
    consumedAt: "2026-07-24T12:07:40Z",
  });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.consumptionDecisionHash, consumed.consumptionDecisionHash);
  await assert.rejects(
    setup.store.readResearchHandoff({
      runId,
      handoffRef: handoff.handoffRef,
      itemIds: ["prior_solution"],
      consumedAt: "2026-07-24T12:09:10Z",
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.applicability_expired",
  );

  const reopenedStore = new RunStore(setup.runsRoot, await createArtifactValidator(repositoryRoot));
  assert.equal(
    (await reopenedStore.load(runId)).manifest.current_plan_ref,
    "plans/research-plan.r2.json",
  );
  assert.equal(
    (
      await reopenedStore.readResearchHandoff({
        runId,
        handoffRef: handoff.handoffRef,
        itemIds: ["prior_opportunity"],
        consumedAt: "2026-07-24T12:07:40Z",
      })
    ).status,
    "idempotent_replay",
  );
});

test("a confirmed pre-Plan Scope revision still reaches formation and the first immutable Plan", async (contextTest) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-pre-plan-scope-"));
  contextTest.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "runtime-pre-plan-scope-reconciliation";
  const store = new RunStore(runsRoot, await createArtifactValidator(repositoryRoot));
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-28T09:00:00Z",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "form the first Plan only after explicit Scope confirmation",
      researchLanguage: "en-US",
    },
  });
  const proposal = await store.proposeScope({
    runId,
    expectedScopeRevision: 1,
    proposedAt: "2026-07-28T09:01:00Z",
    reason: "The user corrected the initial target before any Plan existed.",
    scopeProposal: {
      geography: "Synthetic revised geography",
      customerModel: "b2c",
      targetUsers: ["synthetic revised user"],
      decisionGoal: "form the first Plan from the revised confirmed Scope",
      researchLanguage: "en-US",
    },
  });
  await store.confirmScope({
    runId,
    expectedScopeProposalRevision: 2,
    expectedScopeProposalRef: proposal.scopeProposalRef,
    expectedScopeProposalHash: proposal.scopeProposalHash,
    confirmedAt: "2026-07-28T09:02:00Z",
    userConfirmationAttestation:
      "The fixture caller attests exact user confirmation before first-Plan formation.",
  });
  const paused = await store.load(runId);
  assert.equal(paused.manifest.status, "needs_clarification");
  assert.equal(paused.manifest.status_before_clarification, "created");
  assert.equal(paused.manifest.current_plan_ref, null);

  const formation = await createDiscoveryMapsFixture("general", runId);
  const formationEnvelopes = G21_CORE_REFS.filter((ref) => ref !== PLAN_REF).map((ref) =>
    structuredClone(fixtureEnvelope(formation, ref)),
  );
  const intakeEnvelope = formationEnvelopes.find(
    (envelope) => envelope.artifact_path === "intake.json",
  );
  const scopeEnvelope = formationEnvelopes.find(
    (envelope) => envelope.artifact_path === "scope-frame.json",
  );
  assert.ok(intakeEnvelope && scopeEnvelope);
  intakeEnvelope.document.market = "Synthetic revised geography";
  intakeEnvelope.document.language = "en-US";
  intakeEnvelope.document.scope_confirmation = {
    geography: "Synthetic revised geography",
    customer_model: "b2c",
    target_users: ["synthetic revised user"],
    decision_goal: "form the first Plan from the revised confirmed Scope",
    research_language: "en-US",
    team_context: CONFIRMED_SCOPE.team_context,
    user_confirmed: true,
  };
  const constraints = intakeEnvelope.document.explicit_constraints as Record<string, unknown>;
  constraints.target_market = "Synthetic revised geography";
  constraints.target_language = "en-US";
  constraints.target_users = ["synthetic revised user"];
  (intakeEnvelope as { content_hash: string }).content_hash = canonicalContentHash(
    intakeEnvelope.document,
  );
  scopeEnvelope.document.market = "Synthetic revised geography";
  scopeEnvelope.document.language = "en-US";
  scopeEnvelope.document.target_users = ["synthetic revised user"];
  scopeEnvelope.document.team_context = CONFIRMED_SCOPE.team_context;
  (scopeEnvelope as { content_hash: string }).content_hash = canonicalContentHash(
    scopeEnvelope.document,
  );
  await store.publishArtifactBundle({
    runId,
    envelopes: formationEnvelopes,
  });
  const planEnvelope = fixtureEnvelope(formation, PLAN_REF);
  assert.equal((await publishInitialPlanBundle(store, runId, [planEnvelope])).status, "published");
  assert.equal(
    (await store.publishArtifact({ runId, envelope: planEnvelope })).status,
    "idempotent_replay",
  );
  const reopened = await new RunStore(runsRoot, await createArtifactValidator(repositoryRoot))
    .load(runId)
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
      }
      throw error;
    });
  assert.equal(reopened.manifest.scope_revision, 2);
  assert.equal(reopened.manifest.status, "planned");
  assert.equal(reopened.manifest.status_before_clarification, null);
  assert.equal(reopened.manifest.current_plan_ref, PLAN_REF);
  assert.equal(reopened.manifest.plan_revision, 1);
});

test("first Plan after a pre-Plan Scope correction requires an exact immutable r2 formation closure", async (contextTest) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-scope-r2-formation-"));
  contextTest.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "runtime-scope-r2-exact-formation";
  const store = new RunStore(runsRoot, await createArtifactValidator(repositoryRoot));
  const fixture = await createDiscoveryMapsFixture("general", runId);
  const r1Formation = G21_CORE_REFS.filter((ref) => ref !== PLAN_REF).map((ref) =>
    structuredClone(fixtureEnvelope(fixture, ref)),
  );
  const r1Scope = fixtureEnvelope(fixture, "intake.json").document.scope_confirmation as Record<
    string,
    unknown
  >;
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-28T09:00:00Z",
    scopeProposal: {
      geography: String(r1Scope.geography),
      customerModel: String(r1Scope.customer_model) as "b2c",
      targetUsers: r1Scope.target_users as string[],
      decisionGoal: String(r1Scope.decision_goal),
      researchLanguage: String(r1Scope.research_language),
    },
  });
  await store.publishArtifactBundle({ runId, envelopes: r1Formation });
  const proposal = await store.proposeScope({
    runId,
    expectedScopeRevision: 1,
    proposedAt: "2026-07-28T09:01:00Z",
    reason: "The user corrected the exact pre-Plan research population.",
    scopeProposal: {
      geography: "Synthetic r2 geography",
      customerModel: "b2c",
      targetUsers: ["synthetic r2 user"],
      decisionGoal: "form the first Plan from exact r2 formation",
      researchLanguage: "en-US",
    },
  });
  await store.confirmScope({
    runId,
    expectedScopeProposalRevision: 2,
    expectedScopeProposalRef: proposal.scopeProposalRef,
    expectedScopeProposalHash: proposal.scopeProposalHash,
    confirmedAt: "2026-07-28T09:02:00Z",
    userConfirmationAttestation: "The fixture caller attests exact confirmation of Scope r2.",
  });
  const runRoot = path.join(runsRoot, runId);
  const confirmationId = String((await store.status(runId)).manifest.scope_confirmation_ref).split(
    "#",
  )[1];
  const decisions = (await readFile(path.join(runRoot, "decisions.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const confirmation = decisions.find((decision) => decision.decision_id === confirmationId);
  assert.deepEqual(confirmation?.superseded_formation_refs, [
    "decision-context.json",
    "intake.json",
    "scope-frame.json",
  ]);
  assert.equal((await store.status(runId)).manifest.artifact_refs.includes("intake.json"), false);
  assert.equal(
    (await store.status(runId)).manifest.artifact_refs.includes("decision-context.json"),
    false,
  );
  assert.equal(
    (await store.status(runId)).manifest.artifact_refs.includes("scope-frame.json"),
    false,
  );

  const beforeRejected = await snapshotRunTree(runRoot);
  await assert.rejects(
    publishInitialPlanBundle(store, runId, [fixtureEnvelope(fixture, PLAN_REF)]),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.scope_formation_binding_invalid",
  );
  assert.deepEqual(await snapshotRunTree(runRoot), beforeRejected);

  const replacements = new Map([
    ["decision-context.json", "decision-context.r2.json"],
    ["intake.json", "intake.r2.json"],
    ["scope-frame.json", "scope-frame.r2.json"],
  ]);
  const replaceRefs = (value: unknown): unknown => {
    if (typeof value === "string") return replacements.get(value) ?? value;
    if (Array.isArray(value)) return value.map(replaceRefs);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceRefs(entry)]),
    );
  };
  const remap = (source: FormalArtifactEnvelope): FormalArtifactEnvelope => {
    const envelope = replaceRefs(structuredClone(source)) as FormalArtifactEnvelope;
    return { ...envelope, content_hash: canonicalContentHash(envelope.document) };
  };
  const r2Formation = r1Formation.map(remap);
  const r2Intake = r2Formation.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.intake.v1",
  );
  const r2Scope = r2Formation.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.scope_frame.discovery.current",
  );
  assert.ok(r2Intake && r2Scope);
  r2Intake.document.market = "Synthetic r2 geography";
  r2Intake.document.language = "en-US";
  r2Intake.document.scope_confirmation = {
    geography: "Synthetic r2 geography",
    customer_model: "b2c",
    target_users: ["synthetic r2 user"],
    decision_goal: "form the first Plan from exact r2 formation",
    research_language: "en-US",
    team_context: CONFIRMED_SCOPE.team_context,
    user_confirmed: true,
  };
  const r2Constraints = r2Intake.document.explicit_constraints as Record<string, unknown>;
  r2Constraints.target_market = "Synthetic r2 geography";
  r2Constraints.target_users = ["synthetic r2 user"];
  r2Constraints.target_language = "en-US";
  (r2Intake as { content_hash: string }).content_hash = canonicalContentHash(r2Intake.document);
  r2Scope.document.market = "Synthetic r2 geography";
  r2Scope.document.language = "en-US";
  r2Scope.document.target_users = ["synthetic r2 user"];
  r2Scope.document.team_context = CONFIRMED_SCOPE.team_context;
  (r2Scope as { content_hash: string }).content_hash = canonicalContentHash(r2Scope.document);

  for (const mismatch of [
    (() => {
      const envelopes = structuredClone(r2Formation);
      const intake = envelopes.find(
        (envelope) => envelope.artifact_type === "startup_opportunity.intake.v1",
      );
      assert.ok(intake);
      intake.document.market = "Wrong geography";
      (intake as { content_hash: string }).content_hash = canonicalContentHash(intake.document);
      return envelopes;
    })(),
    (() => {
      const envelopes = structuredClone(r2Formation);
      const scope = envelopes.find(
        (envelope) =>
          envelope.artifact_type === "startup_opportunity.scope_frame.discovery.current",
      );
      assert.ok(scope);
      scope.document.target_users = ["wrong user"];
      (scope as { content_hash: string }).content_hash = canonicalContentHash(scope.document);
      return envelopes;
    })(),
  ]) {
    await assert.rejects(
      store.publishArtifactBundle({ runId, envelopes: mismatch }),
      (error: unknown) =>
        error instanceof StoreError && error.code === "run.scope_formation_binding_invalid",
    );
    assert.deepEqual(await snapshotRunTree(runRoot), beforeRejected);
  }
  const r2Decision = r2Formation.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.decision_context.v1",
  );
  assert.ok(r2Decision);
  await assert.rejects(
    store.publishArtifact({ runId, envelope: r2Decision, faultAt: "after_temp_write" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const recoveredFormation = await store.load(runId);
  assert.deepEqual(recoveredFormation.recoveredArtifactPaths, ["decision-context.r2.json"]);
  assert.ok(recoveredFormation.manifest.artifact_refs.includes("decision-context.r2.json"));
  await store.publishArtifactBundle({
    runId,
    envelopes: r2Formation.filter((envelope) => envelope !== r2Decision),
  });

  const correctPlan = remap(fixtureEnvelope(fixture, PLAN_REF));
  const forgedPlan = structuredClone(fixtureEnvelope(fixture, PLAN_REF));
  (forgedPlan as { input_refs: readonly string[] }).input_refs = ["scope-frame.r2.json"];
  const beforeForged = await snapshotRunTree(runRoot);
  await assert.rejects(
    publishInitialPlanBundle(store, runId, [forgedPlan]),
    (error: unknown) => error instanceof StoreError,
  );
  assert.deepEqual(await snapshotRunTree(runRoot), beforeForged);

  const planning = await initialPlanBundleEnvelopes(store, runId, [correctPlan]);
  assert.equal(
    (await store.publishArtifactBundle({ runId, envelopes: planning })).status,
    "published",
  );
  assert.equal(
    (await store.publishArtifactBundle({ runId, envelopes: planning })).status,
    "idempotent_replay",
  );
  await store.checkpoint({
    runId,
    checkpointId: "checkpoint_scope_r2_first_plan",
    createdAt: "2026-07-28T09:04:00Z",
    nextStep: "Begin only the exact Scope r2 Plan.",
    beliefSummary: {
      current_belief: "The first Plan is bound to immutable Scope r2 formation.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "What does the first bounded research wave find?",
    },
    inputRefs: ["scope-frame.r2.json", PLAN_REF, "plans/planning-context.r1.json"],
  });
  const reopened = await new RunStore(runsRoot, await createArtifactValidator(repositoryRoot)).load(
    runId,
  );
  assert.equal(reopened.manifest.scope_revision, 2);
  assert.equal(reopened.manifest.current_plan_ref, PLAN_REF);
  assert.equal(reopened.manifest.checkpoint_ref, "checkpoints/checkpoint-scope-r2-first-plan.json");
});

test("Scope revision handoff replay survives Gap and Plan reconciliation", async (contextTest) => {
  const runId = "runtime-handoff-scope-reconciliation";
  const sourceRunId = "runtime-handoff-scope-source";
  const setup = await setupPersistedRun(contextTest, runId, "retry");
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const decisionContext = {
    schema_version: "startup_opportunity.decision_context.v1",
    run_id: runId,
    decision_to_make: "choose_opportunity",
    decision_question: "SYNTHETIC Scope reconciliation fixture question.",
    decision_options: ["SYNTHETIC continue only after explicit reconciliation."],
    venture_goal: "strategic_exploration",
    decision_horizon: "SYNTHETIC no validated decision horizon.",
    founder_advantages: [],
    non_negotiable_constraints: ["SYNTHETIC external validation remains out of scope."],
    team_capability_refs: [],
    risk_preferences: ["SYNTHETIC preserve exact Scope and Plan ownership."],
    initial_belief: "SYNTHETIC no opportunity has been established.",
    favored_hypothesis: null,
    assumed_truths: [],
    final_decision_owner: "user",
    assumptions: ["SYNTHETIC fixture content is not Evidence."],
    open_questions: ["SYNTHETIC demand remains unknown."],
  } satisfies Record<string, unknown>;
  const scopeFrame = {
    schema_version: "startup_opportunity.scope_frame.discovery.current",
    run_id: runId,
    mode: "opportunity_discovery",
    decision_context_ref: DECISION_CONTEXT_REF,
    direction: "SYNTHETIC bounded opportunity discovery fixture.",
    discovery_profile: "general",
    research_axes: ["user_language", "jtbd_workflow"],
    market: "Synthetic",
    language: "en-US",
    target_users: ["synthetic user"],
    excluded_users: [],
    platform: "SYNTHETIC delivery platform remains unknown.",
    market_motion: "consumer",
    acquisition_motion: ["direct"],
    buyer_models: ["self_payer"],
    payment_modes: ["subscription"],
    native_app_required: false,
    delivery_form_preferences: [],
    business_model_preferences: [],
    team_context: CONFIRMED_SCOPE.team_context,
    risk_preferences: ["SYNTHETIC avoid unsupported conclusions."],
    ai_scope: "optional",
    assumptions: ["SYNTHETIC Scope is not market Evidence."],
    open_questions: ["SYNTHETIC all demand questions remain open."],
  } satisfies Record<string, unknown>;
  await setup.store.publishArtifactBundle({
    runId,
    envelopes: [
      formalEnvelope(runId, DECISION_CONTEXT_REF, decisionContext),
      formalEnvelope(runId, SCOPE_FRAME_REF, scopeFrame, [DECISION_CONTEXT_REF]),
    ],
  });
  const sourceBundle = await createDiscoveryMapsFixture("general", sourceRunId);
  await createConfirmedRun(setup.store, {
    runId: sourceRunId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-24T11:00:00Z",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic scope reconciliation source"],
      decisionGoal: "provide one exact historical handoff input",
      researchLanguage: "en-US",
    },
  });
  await publishInitialPlanBundle(
    setup.store,
    sourceRunId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(sourceBundle, ref)),
  );
  await setup.store.publishArtifactBundle({
    runId: sourceRunId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(sourceBundle, ref)),
  });
  const sourcePath = G21_OPPORTUNITY_REF;
  const sourceBytes = await readFile(path.join(setup.runsRoot, sourceRunId, sourcePath));
  const sourceEnvelope = JSON.parse(sourceBytes.toString("utf8")) as FormalArtifactEnvelope;
  const handoff = await setup.store.createResearchHandoff({
    runId,
    handoffId: "handoff_scope_r1",
    sourceRunId,
    userAuthorizationAttestation:
      "The fixture caller attests explicit authorization for this exact prior input.",
    targetPurpose: "Use the exact r1 input only as a hypothesis input.",
    capturedAt: "2026-07-28T12:10:00Z",
    items: [
      {
        itemId: "prior_opportunity",
        sourceArtifactPath: sourcePath,
        role: "prior_synthesis",
        expectedSourceByteHash: sha256Bytes(sourceBytes),
        expectedSourceContentHash: sourceEnvelope.content_hash,
        freshnessDisposition: "historical",
        applicabilityDisposition: "partially_applicable",
        revalidationStatus: "required",
        targetArtifactRef: "artifacts/discovery/opportunities/opportunity_scope.r1.json",
      },
    ],
  });
  const consumed = await setup.store.readResearchHandoff({
    runId,
    handoffRef: handoff.handoffRef,
    itemIds: ["prior_opportunity"],
    consumedAt: "2026-07-28T12:10:10Z",
  });

  const proposal = await setup.store.proposeScope({
    runId,
    expectedScopeRevision: 1,
    proposedAt: "2026-07-28T12:10:20Z",
    reason: "The user changed the exact target population before further research.",
    scopeProposal: {
      geography: "Synthetic revised geography",
      customerModel: "b2c",
      targetUsers: ["synthetic revised user"],
      decisionGoal: "reconcile the confirmed revised Scope into a new Plan",
      researchLanguage: "en-US",
    },
  });
  const confirmation = await setup.store.confirmScope({
    runId,
    expectedScopeProposalRevision: proposal.scopeRevision,
    expectedScopeProposalRef: proposal.scopeProposalRef,
    expectedScopeProposalHash: proposal.scopeProposalHash,
    confirmedAt: "2026-07-28T12:10:30Z",
    userConfirmationAttestation:
      "The fixture caller attests exact user confirmation of the revised Scope.",
  });
  let current = await setup.store.load(runId);
  assert.equal(current.manifest.status, "needs_clarification");
  assert.equal(current.manifest.status_before_clarification, "researching");
  const reopenedBeforeReconciliation = new RunStore(
    setup.runsRoot,
    await createArtifactValidator(repositoryRoot),
  );
  current = await reopenedBeforeReconciliation.load(runId);
  assert.equal(current.manifest.status, "needs_clarification");

  for (const action of ["retry_unit", "supersede_unit"] as const) {
    const ordinaryDecision = structuredClone(setup.decision);
    ordinaryDecision.action = action;
    const ordinaryRevision = transformPlan(
      PLAN_REF,
      setup.plan,
      current.manifest,
      [{ path: `adaptations/decisions/ordinary-${action}.json`, document: ordinaryDecision }],
      "2026-07-28T12:10:35Z",
    );
    assert.equal(ordinaryRevision.manifest.status, "needs_clarification");
    assert.equal(ordinaryRevision.manifest.status_before_clarification, "researching");
  }

  const event = triggerEvent(runId, "scope_reconciliation_event");
  event.timestamp = "2026-07-28T12:10:40Z";
  event.reason = "The confirmed Scope revision invalidated the current Plan.";
  await reopenedBeforeReconciliation.appendEvent(runId, event);
  const eventRef = `events.jsonl#${String(event.event_id)}`;
  const gapPath = "adaptations/gap-snapshots/gap-scope-reconciliation.r1.json";
  const currentContextEnvelope = JSON.parse(
    await readFile(path.join(setup.runRoot, CONTEXT_REF), "utf8"),
  ) as FormalArtifactEnvelope;
  const gapInputFile = path.join(setup.root, "scope-reconciliation-gap-input.json");
  const gapInput = {
    schema_version: "startup_opportunity.gap_analysis_input.v1",
    document_bundle: {
      schema_version: "startup_opportunity.document_bundle.current",
      documents: [{ path: CONTEXT_REF, document: currentContextEnvelope }],
      exact_records: [],
    },
    snapshot_id: "gap_scope_reconciliation",
    created_at: "2026-07-28T12:10:50Z",
    trigger_kind: "resume_reconciliation",
    phase: "enrichment",
    wave_id: null,
    trigger_event_ref: eventRef,
    observed_artifact_refs: [],
    material_new_evidence_observed: false,
    repeated_source_refs: [],
    agent_declared_gaps: [],
  };
  await writeFile(gapInputFile, `${canonicalJson(gapInput)}\n`);
  const gapCommand = runScript("harness/src/cli.ts", [
    "analyze-gaps",
    "--file",
    gapInputFile,
    "--run-id",
    runId,
    "--runs-root",
    setup.runsRoot,
  ]);
  assert.equal(gapCommand.status, 0, gapCommand.stderr || gapCommand.stdout);
  const gapAnalysis = JSON.parse(gapCommand.stdout) as {
    valid: boolean;
    snapshot: Record<string, unknown> | null;
    errors: { code: string }[];
  };
  assert.equal(gapAnalysis.valid, true, JSON.stringify(gapAnalysis.errors, null, 2));
  assert.ok(gapAnalysis.snapshot);
  const gap = gapAnalysis.snapshot;
  const gapEntry = (gap.gaps as Record<string, unknown>[])[0];
  assert.ok(gapEntry);
  assert.equal((gap.gaps as unknown[]).length, 1);
  assert.equal(gapEntry.gap_type, "scope_invalidated");
  assert.deepEqual(gap.stop_signals, []);
  assert.equal(gap.material_new_evidence_observed, false);
  await writeFile(
    gapInputFile,
    `${canonicalJson({ ...gapInput, material_new_evidence_observed: true })}\n`,
  );
  const falseEvidenceCommand = runScript("harness/src/cli.ts", [
    "analyze-gaps",
    "--file",
    gapInputFile,
    "--run-id",
    runId,
    "--runs-root",
    setup.runsRoot,
  ]);
  assert.equal(falseEvidenceCommand.status, 1, falseEvidenceCommand.stderr);
  const falseEvidence = JSON.parse(falseEvidenceCommand.stdout) as {
    errors: { code: string }[];
  };
  assert.ok(
    falseEvidence.errors.some((error) => error.code === "gap.scope_reconciliation_input_invalid"),
  );
  await reopenedBeforeReconciliation.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, gapPath, gap, [
      PLAN_REF,
      eventRef,
      confirmation.scopeConfirmationRef,
    ]),
  });

  const decisionPath = "adaptations/decisions/adapt-scope-reconciliation.json";
  const decision = retryDecision(runId);
  decision.adaptation_id = "adapt_scope_reconciliation";
  decision.action = "reconcile_scope";
  decision.based_on_plan_ref = PLAN_REF;
  delete decision.target_unit_ref;
  delete decision.target_unit;
  delete decision.retry_basis;
  delete decision.success_condition;
  decision.trigger_gap_refs = [`${gapPath}#${String(gapEntry.gap_id)}`];
  decision.reason = "Reconcile the exact confirmed Scope without inventing new research work.";
  decision.expected_decision_impact = ["execution_validity"];
  decision.created_at = "2026-07-28T12:11:00Z";
  await reopenedBeforeReconciliation.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, decisionPath, decision, [PLAN_REF, gapPath]),
  });

  current = await reopenedBeforeReconciliation.load(runId);
  const currentManifest = current.manifest as unknown as Record<string, unknown>;
  const transformed = transformPlan(
    PLAN_REF,
    setup.plan,
    currentManifest as never,
    [{ path: decisionPath, document: decision }],
    "2026-07-28T12:11:10Z",
  );
  assert.ok(transformed.plan);
  assert.deepEqual(transformed.plan.waves, setup.plan.waves);
  assert.deepEqual(transformed.plan.research_questions, setup.plan.research_questions);
  assert.equal(transformed.manifest.followup_round, currentManifest.followup_round);
  const candidateContext = context(currentManifest, transformed.plan, {
    path: CANDIDATE_CONTEXT_REF,
    revision: 2,
    parentRef: CONTEXT_REF,
    stage: "candidate_revision",
    createdAt: "2026-07-28T12:11:20Z",
    targetPlanRef: transformed.planPath,
  });
  const assembled = await reopenedBeforeReconciliation.buildValidationContext(runId, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      {
        path: CONTEXT_REF,
        document: JSON.parse(
          await readFile(path.join(setup.runRoot, CONTEXT_REF), "utf8"),
        ) as FormalArtifactEnvelope,
      },
      {
        path: decisionPath,
        document: formalEnvelope(runId, decisionPath, decision, [PLAN_REF, gapPath]),
      },
    ],
    exact_records: [],
  });
  const adaptationBundle: DocumentBundle = {
    ...assembled.bundle,
    exact_records: [],
  };
  const candidateBundle: DocumentBundle = {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      ...assembled.bundle.documents,
      { path: transformed.planPath, document: transformed.plan },
      candidateContext,
    ],
    exact_records: [],
  };
  const reconciled = await runtime
    .apply({
      runId,
      adaptationBundle,
      adaptationRefs: [decisionPath],
      candidateBundle,
      createdAt: "2026-07-28T12:11:10Z",
      checkpointCreatedAt: "2026-07-28T12:11:30Z",
      nextStep: "Resume research only under the reconciled Plan.",
      beliefSummary: {
        current_belief: "The revised Scope requires an explicit new Plan.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "What current-Run Evidence supports the revised Scope?",
      },
    })
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
      }
      throw error;
    });
  assert.equal(reconciled.currentPlanRef, "plans/research-plan.r2.json");
  const reopened = new RunStore(setup.runsRoot, await createArtifactValidator(repositoryRoot));
  const final = await reopened.load(runId);
  assert.equal(final.manifest.status, "researching");
  assert.equal(final.manifest.status_before_clarification, null);
  assert.equal(final.manifest.scope_revision, 2);
  assert.equal(final.manifest.followup_round, currentManifest.followup_round);
  assert.deepEqual(final.manifest.rejected_adaptation_refs, [DECISION_REF]);
  assert.ok(final.manifest.applied_adaptation_refs.includes(decisionPath));
  const replay = await runtime.apply({
    runId,
    adaptationBundle,
    adaptationRefs: [decisionPath],
    candidateBundle,
    createdAt: "2026-07-28T12:11:10Z",
    checkpointCreatedAt: "2026-07-28T12:11:30Z",
    nextStep: "Resume research only under the reconciled Plan.",
    beliefSummary: {
      current_belief: "The revised Scope requires an explicit new Plan.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "What current-Run Evidence supports the revised Scope?",
    },
  });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(
    (
      await reopened.readResearchHandoff({
        runId,
        handoffRef: handoff.handoffRef,
        itemIds: ["prior_opportunity"],
        consumedAt: "2026-07-28T12:10:10Z",
      })
    ).status,
    "idempotent_replay",
  );
  assert.equal(
    (
      await reopened.readResearchHandoff({
        runId,
        handoffRef: handoff.handoffRef,
        itemIds: ["prior_opportunity"],
        consumedAt: "2026-07-28T12:10:10Z",
      })
    ).consumptionDecisionHash,
    consumed.consumptionDecisionHash,
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
      name: "g2-2-bound-candidate-profile-drift",
      artifactPath: RETAINED_SHARED_CANDIDATE_REF,
      expectedDomainCode: null,
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
        if (scenario.expectedDomainCode === null) {
          return error instanceof StoreError && error.code === "recovery.invalid_plan_operation";
        }
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
        if (scenario.expectedDomainCode === null) {
          return error instanceof StoreError && error.code === "recovery.invalid_plan_operation";
        }
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
  assert.equal(reopened.manifest.current_discovery_fan_in_ref, null);
  assert.equal(reopened.manifest.current_discovery_fan_in_hash, null);
  assert.equal(reopened.manifest.current_pre_candidate_confirmation_ref, null);
  assert.equal(reopened.manifest.current_pre_candidate_confirmation_hash, null);
  assert.equal(reopened.manifest.current_pre_candidate_confirmation_action, null);
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
  gap.created_at = "2026-07-28T12:13:10Z";
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
  decision.created_at = "2026-07-28T12:13:20Z";
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
      stage: "initial_plan",
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
  const runAwareBundleFile = path.join(setup.root, "run-aware-r2-adaptation-bundle.json");
  const runAwareGapInputFile = path.join(setup.root, "run-aware-r2-gap-input.json");
  await writeFile(runAwareBundleFile, `${canonicalJson(assembled.bundle)}\n`);
  await writeFile(
    runAwareGapInputFile,
    `${canonicalJson({
      schema_version: "startup_opportunity.gap_analysis_input.v1",
      document_bundle: assembled.bundle,
      snapshot_id: "gap_run_aware_cli_draft_r2",
      created_at: "2026-07-28T12:13:30Z",
      trigger_kind: "wave_completed",
      phase: "discovery",
      wave_id: "wave_discovery_synthetic",
      trigger_event_ref: null,
      observed_artifact_refs: [],
      material_new_evidence_observed: false,
      repeated_source_refs: [],
      agent_declared_gaps: [],
    })}\n`,
  );
  for (const [command, skillScript, flag, filename] of [
    ["validate-adaptation", "validate-adaptation.ts", "--bundle", runAwareBundleFile],
    ["analyze-gaps", "analyze-gaps.ts", "--file", runAwareGapInputFile],
  ] as const) {
    for (const [script, args] of [
      [
        "harness/src/cli.ts",
        [command, flag, filename, "--run-id", runId, "--runs-root", setup.runsRoot],
      ],
      [
        `.agents/skills/startup-opportunity/scripts/${skillScript}`,
        [flag, filename, "--run-id", runId, "--runs-root", setup.runsRoot],
      ],
    ] as const) {
      const result = runScript(script, args);
      assert.equal(result.status, 0, `${command} ${script}: ${result.stderr || result.stdout}`);
      assert.equal((JSON.parse(result.stdout) as { valid: boolean }).valid, true);
    }
  }

  const staleContextBundle = structuredClone(assembled.bundle);
  const staleContextEnvelope = staleContextBundle.documents.find(
    (entry) => entry.path === CANDIDATE_CONTEXT_REF,
  )?.document as FormalArtifactEnvelope | undefined;
  assert.ok(staleContextEnvelope);
  const staleContext = staleContextEnvelope.document;
  const staleTarget = staleContext.target_plan_binding as Record<string, unknown>;
  staleTarget.plan_ref = PLAN_REF;
  (staleContextEnvelope as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(staleContext);
  const staleContextFile = path.join(setup.root, "run-aware-stale-current-context.json");
  await writeFile(staleContextFile, `${canonicalJson(staleContextBundle)}\n`);
  const staleResult = runScript("harness/src/cli.ts", [
    "validate-adaptation",
    "--bundle",
    staleContextFile,
    "--run-id",
    runId,
    "--runs-root",
    setup.runsRoot,
  ]);
  assert.equal(staleResult.status, 1);
  assert.equal(
    (JSON.parse(staleResult.stderr) as { error: { code: string } }).error.code,
    "validation_context.authority_conflict",
  );
  const reopenedBeforeSecondApply = await new RunStore(
    setup.runsRoot,
    await createArtifactValidator(repositoryRoot),
  ).load(runId);
  assert.equal(reopenedBeforeSecondApply.manifest.current_plan_ref, first.currentPlanRef);
  assert.deepEqual(
    reopenedBeforeSecondApply.planOperationRecovery.historicalDiscoveryPlanBindings,
    assembled.referenceContext.historicalDiscoveryPlanBindings,
  );
  const second = await runtime.apply({
    runId,
    adaptationBundle: assembled.bundle,
    adaptationRefs: [decisionPath],
    createdAt: "2026-07-28T12:14:00Z",
    checkpointCreatedAt: "2026-07-28T12:15:00Z",
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
      contextStage: "initial_plan",
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
    (entry) => entry.path === CANDIDATE_CONTEXT_REF,
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
      error instanceof StoreError &&
      ["apply.pending_operation_conflict", "recovery.invalid_plan_operation"].includes(error.code),
  );
  assert.equal((await setup.store.status(runId)).manifest.status, "researching");
  const retryReceipt = JSON.parse(await readFile(await planReceiptFile(setup.runRoot), "utf8")) as
    | Record<string, unknown>
    | undefined;
  assert.ok(retryReceipt);
  await assert.rejects(
    runtime.apply({ ...retryInput, operationKey: String(retryReceipt.operation_key) }),
    (error: unknown) =>
      error instanceof StoreError &&
      ["apply.base_manifest_conflict", "recovery.invalid_plan_operation"].includes(error.code),
  );
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

  let terminal = await prepareTerminalReporting(setup);
  const sourceRunId = "runtime-terminal-handoff-source";
  const sourceBundle = await createDiscoveryMapsFixture("general", sourceRunId);
  await createConfirmedRun(setup.store, {
    runId: sourceRunId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-24T11:00:00Z",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic terminal handoff source user"],
      decisionGoal: "supply exact prior items for terminal consumption closure testing",
      researchLanguage: "en-US",
    },
  });
  await publishInitialPlanBundle(
    setup.store,
    sourceRunId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(sourceBundle, ref)),
  );
  await setup.store.publishArtifactBundle({
    runId: sourceRunId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(sourceBundle, ref)),
  });
  const terminalHandoffItems = await Promise.all(
    [
      {
        itemId: "consumed_before_terminal",
        sourceArtifactPath: G21_OPPORTUNITY_REF,
        targetArtifactRef: "artifacts/discovery/opportunities/terminal_a.r1.json",
      },
      {
        itemId: "unread_before_terminal",
        sourceArtifactPath: G21_SOLUTION_REF,
        targetArtifactRef: "artifacts/discovery/opportunities/terminal_b.r1.json",
      },
    ].map(async (item) => {
      const bytes = await readFile(path.join(setup.runsRoot, sourceRunId, item.sourceArtifactPath));
      const sourceEnvelope = JSON.parse(bytes.toString("utf8")) as FormalArtifactEnvelope;
      return {
        ...item,
        role: "prior_synthesis" as const,
        expectedSourceByteHash: sha256Bytes(bytes),
        expectedSourceContentHash: sourceEnvelope.content_hash,
        freshnessDisposition: "historical" as const,
        applicabilityDisposition: "partially_applicable" as const,
        revalidationStatus: "required" as const,
      };
    }),
  );
  const terminalHandoff = await setup.store.createResearchHandoff({
    runId,
    handoffId: "handoff_terminal_consumption",
    sourceRunId,
    userAuthorizationAttestation:
      "The fixture caller attests explicit authorization for these exact prior items.",
    targetPurpose:
      "Verify terminal consumption closure without using prior synthesis in a subject.",
    capturedAt: "2026-07-24T12:07:40Z",
    items: terminalHandoffItems,
  });
  const consumedBeforeTerminal = await setup.store.readResearchHandoff({
    runId,
    handoffRef: terminalHandoff.handoffRef,
    itemIds: ["consumed_before_terminal"],
    consumedAt: "2026-07-24T12:07:50Z",
  });
  terminal = await prepareTerminalReporting(setup);
  const input = {
    ...baseInput,
    adaptationBundle: terminal.adaptationBundle,
    terminalReportEnvelope: terminal.reportEnvelope,
  };
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
  assert.match(brief, /Research conclusion: insufficient evidence/);

  const replay = await runtime.apply(input);
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.terminalReport?.status, "idempotent_replay");
  const handoffReplay = await setup.store.readResearchHandoff({
    runId,
    handoffRef: terminalHandoff.handoffRef,
    itemIds: ["consumed_before_terminal"],
    consumedAt: "2026-07-24T12:07:50Z",
  });
  assert.equal(handoffReplay.status, "idempotent_replay");
  assert.equal(
    handoffReplay.consumptionDecisionHash,
    consumedBeforeTerminal.consumptionDecisionHash,
  );
  await assert.rejects(
    setup.store.readResearchHandoff({
      runId,
      handoffRef: terminalHandoff.handoffRef,
      itemIds: ["unread_before_terminal"],
      consumedAt: "2026-07-24T12:10:00Z",
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.consumption_closed",
  );
});

test("completed and cancelled outcomes use the atomic terminal Plan closeout", async (contextTest) => {
  for (const lifecycle of ["complete", "cancel"] as const) {
    const runId = `runtime-terminal-${lifecycle}`;
    const setup = await setupPersistedRun(contextTest, runId, lifecycle);
    const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
    const outcome = lifecycle === "complete" ? "completed" : "cancelled";
    const terminal = await prepareTerminalReporting(setup, false, outcome);
    const input = {
      runId,
      adaptationBundle: terminal.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      terminalReportEnvelope: terminal.reportEnvelope,
      createdAt: "2026-07-24T12:10:00Z",
      checkpointCreatedAt: "2026-07-24T12:11:00Z",
      nextStep: "Deliver the exact atomic terminal result.",
      beliefSummary: {
        current_belief: `The Run is ready for ${outcome} closeout.`,
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Is the terminal report closure durable?",
      },
    };
    const result = await runtime.apply(input);
    assert.equal(result.terminalReport?.status, "published");
    const manifest = (await setup.store.status(runId)).manifest;
    assert.equal(manifest.status, outcome);
    assert.equal((await setup.store.status(runId)).terminalReportDisposition, "ready");
    if (lifecycle === "cancel") {
      assert.deepEqual(manifest.active_units, []);
      assert.deepEqual(manifest.cancelled_units, ["buyer_active", "value_pending"]);
      assert.deepEqual(manifest.failed_units, ["acquisition_failed"]);
    }
    const replay = await runtime.apply(input);
    assert.equal(replay.status, "idempotent_replay");
    assert.equal(replay.terminalReport?.status, "idempotent_replay");
    const reopened = await new RunStore(
      setup.runsRoot,
      await createArtifactValidator(repositoryRoot),
    ).load(runId);
    assert.equal(reopened.manifest.status, outcome);
  }
});

test("completed terminal report omits substrate-only inventory while preserving empty readable-source authority", async (contextTest) => {
  const runId = "runtime-terminal-completed-substrate-omit";
  const setup = await setupPersistedRun(contextTest, runId, "complete");
  await seedRuntimeFailureSubstrateOnlyEvidence(setup.runsRoot, runId);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const terminal = await prepareTerminalReporting(setup, false, "completed");
  const result = await runtime.apply(
    terminalApplyInput(
      setup,
      terminal,
      "A completed terminal lifecycle must not project audit-only substrate inventory.",
    ),
  );
  assert.equal(result.status, "applied");
  assert.equal(result.terminalReport?.status, "published");
  const report = JSON.parse(
    await readFile(path.join(setup.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  const provenance = report.research_provenance as Record<string, unknown>;
  assert.equal(provenance.captured_substrate_inventory, undefined);
  assert.equal((report.sources as unknown[]).length, 0);
  assert.equal((report.excluded_evidence as unknown[]).length, 0);
  assert.equal((report.report_citations as unknown[]).length, 0);
  assert.equal((report.report_statistics as Record<string, unknown>).readable_source_count, 0);
  assert.equal((await setup.store.status(runId)).manifest.status, "completed");
  const capturedInventorySurfacePattern =
    /Captured But Not Formalized Materials|Captured but not formalized substrate inventory|已采集但未正式化材料|已采集但未正式化的材料/u;
  for (const relativePath of ["decision-brief.md", "report.md", "audit-appendix.md"] as const) {
    assert.doesNotMatch(
      await readFile(path.join(setup.runRoot, relativePath), "utf8"),
      capturedInventorySurfacePattern,
    );
  }
  const zhCompletedSource = clone(report);
  zhCompletedSource.research_language = "zh-CN";
  for (const markdown of [
    renderTerminalDecisionBrief(zhCompletedSource),
    renderTerminalFullReport(zhCompletedSource),
    renderTerminalAuditAppendix(zhCompletedSource),
  ]) {
    assert.doesNotMatch(markdown, capturedInventorySurfacePattern);
  }
});

test("insufficient-evidence terminal report keeps mixed formal and unformalized substrate separate", async (contextTest) => {
  const runId = "runtime-terminal-insufficient-mixed-substrate";
  const setup = await setupPersistedRun(contextTest, runId, "pre-kill-exact");
  const formalEvidenceEnvelopes = discoveryRuntimeEnvelopes(setup, [
    "startup_opportunity.evidence.discovery_candidate.current",
  ]);
  const formalEvidenceRefs = formalEvidenceEnvelopes
    .map((envelope) => envelope.artifact_path)
    .sort();
  assert.equal(formalEvidenceRefs.length, 2);
  const unformalizedRecords = await seedRuntimeFailureSubstrateOnlyEvidence(setup.runsRoot, runId);
  const terminal = await prepareTerminalReporting(
    setup,
    false,
    undefined,
    setup.researchLanguage,
    "2026-07-28T12:09:30Z",
  );
  terminal.reportEnvelope.document.runtime_health = {
    status: "blocked",
    issues: [
      {
        code: "synthetic_blocked_health_does_not_change_terminal_outcome_reason",
        stage: "synthetic-insufficient-evidence",
        detail:
          "SYNTHETIC runtime health is blocked but terminal outcome is insufficient_evidence.",
        conclusion_impact: "The inventory reason must remain insufficient_evidence.",
        related_refs: [GAP_REF],
      },
    ],
  };
  excludeFormalEvidence(terminal, formalEvidenceRefs);
  terminal.reportEnvelope.document.report_citations = [];
  terminal.reportEnvelope.document.report_statistics = {
    readable_source_count: 0,
    quantitative_signal_count: 0,
    decision_grade_quantitative_signal_count: 0,
    directional_or_context_quantitative_signal_count: 0,
    competitive_object_count: 0,
    full_gap_row_count: 0,
    critical_gap_group_count: 0,
  };
  const evidenceStore = new EvidenceStore(setup.runsRoot);
  const exactRecords = new Map(
    (await evidenceStore.listRecords(runId)).map(
      (record) =>
        [
          `evidence/manifest.jsonl#${record.evidence_id}`,
          record as Record<string, unknown>,
        ] as const,
    ),
  );
  const derivedProvenance = deriveResearchProvenance(
    runId,
    [
      {
        path: terminal.reportEnvelope.artifact_path,
        schemaVersion: terminal.reportEnvelope.artifact_type,
        document: terminal.reportEnvelope.document,
        envelope: terminal.reportEnvelope as unknown as Record<string, unknown>,
      },
      ...formalEvidenceEnvelopes.map((envelope) => ({
        path: envelope.artifact_path,
        schemaVersion: envelope.artifact_type,
        document: envelope.document,
        envelope: envelope as unknown as Record<string, unknown>,
      })),
    ],
    exactRecords,
    terminal.reportEnvelope.artifact_path,
  );
  terminal.reportEnvelope.document.research_provenance = derivedProvenance;
  const report = terminal.reportEnvelope.document;
  const reportProvenance = report.research_provenance as Record<string, unknown>;
  const inventory = reportProvenance.captured_substrate_inventory as Record<string, unknown>;
  assert.ok(inventory);
  assert.equal(inventory.unformalized_reason, "insufficient_evidence");
  assert.equal(inventory.conclusion_support_status, "does_not_support_conclusions");
  assert.deepEqual(
    (reportProvenance.formal_current_evidence_refs as string[]).sort(),
    formalEvidenceRefs,
  );
  assert.deepEqual(reportProvenance.adopted_current_evidence_refs as unknown[], []);
  assert.deepEqual(reportProvenance.cited_current_evidence_refs as unknown[], []);
  const inventoryItems = inventory.items as Record<string, unknown>[];
  const inventoryRefs = inventoryItems.map((item) => String(item.evidence_ref));
  assert.equal(inventoryRefs.length, unformalizedRecords.length);
  assert.equal(new Set(inventoryRefs).size, unformalizedRecords.length);
  assert.deepEqual(
    inventoryRefs.sort(),
    unformalizedRecords
      .map((record) => `evidence/manifest.jsonl#${String(record.evidence_id)}`)
      .sort(),
  );
  const repeatedSourceItems = inventoryItems.filter(
    (item) =>
      (item.source as Record<string, unknown>).canonical_url ===
      "https://synthetic.invalid/runtime-failure/shared-0",
  );
  assert.equal(repeatedSourceItems.length, 2);
  assert.equal(new Set(repeatedSourceItems.map((item) => item.evidence_ref)).size, 2);
  for (const formalRef of formalEvidenceRefs) {
    const formalEnvelope = formalEvidenceEnvelopes.find(
      (envelope) => envelope.artifact_path === formalRef,
    );
    assert.ok(formalEnvelope);
    const binding = formalEnvelope.document.mechanical_binding as Record<string, unknown>;
    assert.equal(inventoryRefs.includes(String(binding.substrate_record_ref)), false);
  }
  assert.deepEqual(
    (report.excluded_evidence as Record<string, unknown>[])
      .map((entry) => String(entry.evidence_ref))
      .sort(),
    formalEvidenceRefs,
  );
  assert.deepEqual(report.sources as unknown[], []);
  assert.deepEqual(report.report_citations as unknown[], []);
  assert.equal((report.report_statistics as Record<string, unknown>).readable_source_count, 0);
  assert.equal(
    (report.research_conclusion as Record<string, unknown>).outcome,
    "insufficient_evidence",
  );
  assert.equal(
    (report.research_conclusion as Record<string, unknown>).evidence_strength,
    "insufficient",
  );
  assert.deepEqual(report.directions as unknown[], []);
  assert.deepEqual(report.gate_warnings as unknown[], []);
  const reportMarkdown = renderTerminalFullReport(report);
  assert.match(reportMarkdown, /Captured but not formalized substrate inventory: 17/);
  assert.equal(reportMarkdown.includes(formalEvidenceRefs[0] ?? "unreachable"), false);
});

test("complete_research rejects incomplete current Plan unit closure before an intent", async (contextTest) => {
  const runId = "runtime-terminal-complete-incomplete";
  const setup = await setupPersistedRun(contextTest, runId, "complete");
  const incomplete = structuredClone(setup.adaptationBundle);
  const manifestEntry = incomplete.documents.find((entry) => entry.path === "manifest.json");
  assert.ok(manifestEntry);
  const manifest = manifestEntry.document;
  manifest.completed_units = ["counter_completed"];
  manifest.active_units = ["buyer_active"];
  manifest.failed_units = ["acquisition_failed"];
  const before = await planApplyBoundaryState(setup.runRoot);
  const validation = (await createAdaptationPolicyValidator(repositoryRoot)).validateDocumentBundle(
    incomplete,
    undefined,
    [DECISION_REF],
  );
  assert.ok(
    validation.adaptationErrors.some(
      (issue) => issue.code === "adaptation.completion_closure_incomplete",
    ),
    JSON.stringify(validation, null, 2),
  );
  assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
});

test("decision subject authority survives Plan r2 transition, terminal reporting, checkpoint, and reopen", async (contextTest) => {
  const runId = "runtime-decision-subject-plan-transition";
  const setup = await setupPersistedRun(contextTest, runId, "post-g2-add");
  const terminalAuthority = await prepareTerminalReporting(setup).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
    }
    throw error;
  });
  const afterR1 = await setup.store.status(runId);
  assert.equal(
    afterR1.manifest.current_decision_subject_snapshot_ref,
    DECISION_SUBJECT_SNAPSHOT_REF,
  );

  const transitionSetup = {
    ...setup,
    currentManifest: afterR1.manifest as unknown as Record<string, unknown>,
    adaptationBundle: terminalAuthority.adaptationBundle,
  };
  const { candidateBundle: baseCandidateBundle } = candidateFor(
    transitionSetup,
    PRE_KILL_APPLY_AT,
    PRE_KILL_CONTEXT_AT,
  );
  const candidateAuthorityEntries = [
    DECISION_CONTEXT_REF,
    SCOPE_FRAME_REF,
    DECISION_SUBJECT_SNAPSHOT_REF,
  ].map((ref) => {
    const entry = terminalAuthority.adaptationBundle.documents.find(
      (candidate) => candidate.path === ref,
    );
    assert.ok(entry);
    return structuredClone(entry);
  });
  const candidateBundle: DocumentBundle = {
    ...baseCandidateBundle,
    documents: [...baseCandidateBundle.documents, ...candidateAuthorityEntries],
  };
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const applied = await runtime
    .apply({
      runId,
      adaptationBundle: terminalAuthority.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      candidateBundle,
      createdAt: PRE_KILL_APPLY_AT,
      checkpointCreatedAt: PRE_KILL_CHECKPOINT_AT,
      nextStep: "Publish a new decision subject snapshot for the revised Plan.",
      beliefSummary: {
        current_belief: "SYNTHETIC Plan r2 requires a refreshed decision subject authority.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Does snapshot r2 bind the revised Plan exactly?",
      },
    })
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
      }
      throw error;
    });
  assert.equal(applied.currentPlanRef, "plans/research-plan.r2.json");
  const afterPlanR2 = await setup.store.load(runId);
  assert.equal(afterPlanR2.manifest.current_plan_ref, "plans/research-plan.r2.json");
  assert.equal(
    afterPlanR2.manifest.current_decision_subject_snapshot_ref,
    DECISION_SUBJECT_SNAPSHOT_REF,
  );

  const r1Envelope = JSON.parse(
    await readFile(path.join(setup.runRoot, DECISION_SUBJECT_SNAPSHOT_REF), "utf8"),
  ) as FormalArtifactEnvelope;
  const planR2Envelope = JSON.parse(
    await readFile(path.join(setup.runRoot, "plans/research-plan.r2.json"), "utf8"),
  ) as FormalArtifactEnvelope;
  const snapshotR2Ref = "artifacts/reporting/decision-subject-snapshot.r2.json";
  const snapshotR2Document = {
    ...structuredClone(r1Envelope.document),
    revision: 2,
    parent_snapshot_ref: DECISION_SUBJECT_SNAPSHOT_REF,
    parent_snapshot_hash: r1Envelope.content_hash,
    research_plan_ref: planR2Envelope.artifact_path,
    research_plan_hash: planR2Envelope.content_hash,
    created_at: "2026-07-28T12:14:00Z",
  };
  const snapshotR2Envelope = formalEnvelope(runId, snapshotR2Ref, snapshotR2Document, [
    DECISION_SUBJECT_SNAPSHOT_REF,
    SCOPE_FRAME_REF,
    planR2Envelope.artifact_path,
  ]);
  await setup.store.publishArtifact({ runId, envelope: snapshotR2Envelope });
  assert.equal(
    (await setup.store.status(runId)).manifest.current_decision_subject_snapshot_ref,
    snapshotR2Ref,
  );

  const terminalGapRef = "adaptations/gap-snapshots/gap-runtime-terminal.r2.json";
  const terminalGap = gapSnapshot(runId, "runtime_blocked", planR2Envelope.artifact_path);
  terminalGap.revision = 2;
  terminalGap.parent_snapshot_ref = GAP_REF;
  terminalGap.based_on_plan_ref = planR2Envelope.artifact_path;
  terminalGap.created_at = "2026-07-28T12:14:15Z";
  terminalGap.snapshot_cycle_key = "enrichment:wave_runtime_1:fixture";
  terminalGap.stop_signals = ["runtime_blocked"];
  const terminalGapEntry = (terminalGap.gaps as Record<string, unknown>[])[0];
  assert.ok(terminalGapEntry);
  terminalGapEntry.gap_id = "gap_runtime_terminal_r2";
  terminalGapEntry.basis_refs = ["manifest.json", planR2Envelope.artifact_path];
  terminalGapEntry.recommended_unit_types = [];
  const terminalGapEnvelope = formalEnvelope(runId, terminalGapRef, terminalGap, [
    GAP_REF,
    planR2Envelope.artifact_path,
  ]);
  await setup.store
    .publishArtifact({ runId, envelope: terminalGapEnvelope })
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
      }
      throw error;
    });

  const terminalDecisionRef = "adaptations/decisions/adapt-runtime-terminal-r2.json";
  const terminalDecision = runtimeFailureDecision(runId);
  terminalDecision.adaptation_id = "adapt_runtime_terminal_r2";
  terminalDecision.based_on_plan_ref = planR2Envelope.artifact_path;
  terminalDecision.trigger_gap_refs = [`${terminalGapRef}#gap_runtime_terminal_r2`];
  terminalDecision.created_at = "2026-07-28T12:14:30Z";
  const terminalDecisionEnvelope = formalEnvelope(runId, terminalDecisionRef, terminalDecision, [
    planR2Envelope.artifact_path,
    terminalGapRef,
  ]);
  await setup.store.publishArtifact({ runId, envelope: terminalDecisionEnvelope });

  const reportEnvelope = terminalReportSource(
    runId,
    snapshotR2Envelope.content_hash,
    true,
    snapshotR2Ref,
    planR2Envelope.artifact_path,
    "2026-07-28T12:15:00Z",
  );
  reportEnvelope.document.audit_refs = [
    DECISION_REF,
    GAP_REF,
    terminalDecisionRef,
    terminalGapRef,
    planR2Envelope.artifact_path,
  ].sort();
  (reportEnvelope as unknown as { input_refs: string[] }).input_refs = [
    ...(reportEnvelope.document.audit_refs as string[]),
    snapshotR2Ref,
  ].sort();
  (reportEnvelope as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    reportEnvelope.document,
  );
  const terminalClosurePaths = [
    "plans/planning-context.r2.json",
    ...G21_MAP_REFS,
    "artifacts/discovery/candidates/candidate_baseline.r1.json",
    PRE_KILL_CANDIDATE_REF,
    RETAINED_SHARED_CANDIDATE_REF,
  ];
  const terminalClosure = await Promise.all(
    terminalClosurePaths.map(async (artifactPath) => ({
      path: artifactPath,
      document: JSON.parse(
        await readFile(path.join(setup.runRoot, artifactPath), "utf8"),
      ) as FormalArtifactEnvelope,
    })),
  );
  const assembledTerminal = await setup.store.buildValidationContext(runId, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: terminalGapRef, document: terminalGapEnvelope },
      { path: terminalDecisionRef, document: terminalDecisionEnvelope },
      ...terminalClosure,
    ],
    exact_records: [],
  });
  const terminated = await runtime
    .apply({
      runId,
      adaptationBundle: assembledTerminal.bundle,
      adaptationRefs: [terminalDecisionRef],
      terminalReportEnvelope: reportEnvelope,
      createdAt: "2026-07-28T12:15:15Z",
      checkpointCreatedAt: "2026-07-28T12:15:30Z",
      nextStep: "Deliver the terminal report bound to snapshot r2 and Plan r2.",
      beliefSummary: {
        current_belief: "SYNTHETIC runtime failure prevents a research conclusion.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Can a future new Run proceed after the runtime fix?",
      },
    })
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
      }
      throw error;
    });
  assert.equal(terminated.terminalReport?.status, "published");
  assert.equal((await setup.store.status(runId)).manifest.status, "failed");
  const checkpoint = await setup.store
    .checkpoint({
      runId,
      checkpointId: "checkpoint_decision_subject_plan_r2",
      createdAt: "2026-07-28T12:16:00Z",
      nextStep: "Reopen and verify snapshot r2 remains authoritative.",
      beliefSummary: {
        current_belief: "SYNTHETIC report is bound to snapshot r2 and Plan r2.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Does exact historical replay preserve r2 authority?",
      },
      inputRefs: terminated.terminalReport?.formalArtifactPaths ?? [],
    })
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
      }
      throw error;
    });
  assert.equal(checkpoint.status, "published");
  const reopened = await setup.store.load(runId);
  assert.equal(reopened.manifest.current_decision_subject_snapshot_ref, snapshotR2Ref);
  assert.equal(
    reopened.manifest.current_decision_subject_snapshot_hash,
    snapshotR2Envelope.content_hash,
  );

  const replay = await setup.store.publishArtifact({ runId, envelope: r1Envelope });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(
    (await setup.store.status(runId)).manifest.current_decision_subject_snapshot_ref,
    snapshotR2Ref,
  );
});

test("Discovery runtime failure terminates and reports from the original Run", async (contextTest) => {
  const runId = "runtime-failure-original-run";
  const setup = await setupPersistedRun(contextTest, runId, "runtime-failure");
  const substrateRecords = await seedRuntimeFailureSubstrateOnlyEvidence(setup.runsRoot, runId);
  const terminal = await prepareTerminalReporting(setup, true);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = {
    runId,
    adaptationBundle: terminal.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    terminalReportEnvelope: terminal.reportEnvelope,
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
  const report = JSON.parse(
    await readFile(path.join(setup.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  const provenance = report.research_provenance as Record<string, unknown>;
  assert.equal(provenance.captured_item_count, 0);
  const inventory = provenance.captured_substrate_inventory as Record<string, unknown>;
  assert.ok(inventory);
  assert.equal(inventory.status, "captured_not_formalized");
  assert.equal(inventory.unformalized_reason, "runtime_failure");
  assert.equal(inventory.conclusion_support_status, "does_not_support_conclusions");
  const capturedItems = inventory.items as Record<string, unknown>[];
  assert.equal(capturedItems.length, 17);
  assert.deepEqual(
    capturedItems.map((item) => item.evidence_ref).sort(),
    substrateRecords
      .map((record) => `evidence/manifest.jsonl#${String(record.evidence_id)}`)
      .sort(),
  );
  assert.equal(new Set(capturedItems.map((item) => item.evidence_ref)).size, 17);
  const repeatedSourceItems = capturedItems.filter(
    (item) =>
      (item.source as Record<string, unknown>).canonical_url ===
      "https://synthetic.invalid/runtime-failure/shared-0",
  );
  assert.equal(repeatedSourceItems.length, 2);
  assert.equal(new Set(repeatedSourceItems.map((item) => item.evidence_ref)).size, 2);
  assert.equal((report.sources as unknown[]).length, 0);
  assert.equal((report.excluded_evidence as unknown[]).length, 0);
  assert.equal((provenance.formal_current_evidence_refs as unknown[]).length, 0);
  assert.equal((provenance.adopted_current_evidence_refs as unknown[]).length, 0);
  assert.equal((provenance.cited_current_evidence_refs as unknown[]).length, 0);
  const statistics = report.report_statistics as Record<string, unknown>;
  assert.equal(statistics.readable_source_count, 0);
  assert.equal(
    (report.research_conclusion as Record<string, unknown>).outcome,
    "no_recommendation",
  );
  assert.equal(
    (report.research_conclusion as Record<string, unknown>).evidence_strength,
    "insufficient",
  );
  const brief = await readFile(path.join(setup.runRoot, "decision-brief.md"), "utf8");
  assert.match(brief, /本次运行失败/);
  assert.match(brief, /Status: blocked/);
  const full = await readFile(path.join(setup.runRoot, "report.md"), "utf8");
  assert.match(full, /Captured but not formalized substrate inventory: 17/);
  assert.match(full, /conclusion boundary: does not support any research conclusion/);
  for (const record of substrateRecords) {
    assert.match(full, new RegExp(`evidence/manifest\\.jsonl#${String(record.evidence_id)}`));
    assert.match(full, new RegExp(String(record.recorded_at)));
  }
  assert.match(full, /https:\/\/synthetic\.invalid\/runtime-failure\/shared-0/);
  assert.match(
    full,
    /urn:startup-opportunity:user-provided:runtime-failure-original-run-capture-13/,
  );
});

test("Chinese runtime failure reports exact captured substrate inventory without global ref exemption", async (contextTest) => {
  const runId = "runtime-failure-zh-substrate-inventory";
  const setup = await setupPersistedRun(
    contextTest,
    runId,
    "runtime-failure",
    false,
    false,
    "zh-CN",
  );
  const substrateRecords = await seedRuntimeFailureSubstrateOnlyEvidence(setup.runsRoot, runId);
  const terminal = await prepareTerminalReporting(setup, true);
  const result = await (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply(
    terminalApplyInput(
      setup,
      terminal,
      "The runtime failure must remain visible without supporting a research conclusion.",
    ),
  );
  assert.equal(result.status, "applied");
  assert.equal(result.terminalReport?.status, "published");

  const report = JSON.parse(
    await readFile(path.join(setup.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  const provenance = report.research_provenance as Record<string, unknown>;
  const inventory = provenance.captured_substrate_inventory as Record<string, unknown>;
  assert.ok(inventory);
  assert.equal(inventory.unformalized_reason, "runtime_failure");
  assert.equal(inventory.conclusion_support_status, "does_not_support_conclusions");
  const capturedItems = inventory.items as Record<string, unknown>[];
  assert.equal(capturedItems.length, 17);
  assert.equal((report.sources as unknown[]).length, 0);
  assert.equal((report.excluded_evidence as unknown[]).length, 0);
  assert.equal((report.report_citations as unknown[]).length, 0);
  assert.equal((report.report_statistics as Record<string, unknown>).readable_source_count, 0);
  assert.equal(
    (report.research_conclusion as Record<string, unknown>).outcome,
    "no_recommendation",
  );
  assert.equal(
    (report.research_conclusion as Record<string, unknown>).evidence_strength,
    "insufficient",
  );

  const renderedSurfaces = await Promise.all(
    (["decision-brief.md", "report.md", "audit-appendix.md"] as const).map(
      async (relativePath) =>
        [relativePath, await readFile(path.join(setup.runRoot, relativePath), "utf8")] as const,
    ),
  );
  const renderedByPath = new Map(renderedSurfaces);
  const firstRef = `evidence/manifest.jsonl#${String(substrateRecords[0]?.evidence_id)}`;
  const brief = renderedByPath.get("decision-brief.md");
  assert.ok(brief);
  assert.match(brief, /已采集但未正式化材料/);
  assert.match(brief, /已采集但未正式化的材料: 17/);
  assert.match(brief, /结论边界: 不支持任何研究结论/);
  assert.equal(brief.includes(firstRef), false);
  for (const record of substrateRecords) {
    assert.equal(brief.includes(`evidence/manifest.jsonl#${String(record.evidence_id)}`), false);
    assert.equal(brief.includes(String(record.recorded_at)), false);
  }
  assert.deepEqual(
    localizedTerminalUserViewIssues(report, brief, "decision_brief"),
    [],
    "decision-brief.md",
  );

  for (const relativePath of ["report.md", "audit-appendix.md"] as const) {
    const markdown = renderedByPath.get(relativePath);
    assert.ok(markdown);
    assert.match(markdown, /已采集但未正式化的材料: 17/);
    assert.match(markdown, /结论边界: 不支持任何研究结论/);
    assert.equal(markdown.includes(firstRef), true, relativePath);
    for (const record of substrateRecords) {
      assert.equal(
        markdown.includes(`evidence/manifest.jsonl#${String(record.evidence_id)}`),
        true,
        relativePath,
      );
      assert.equal(markdown.includes(String(record.recorded_at)), true, relativePath);
    }
    assert.deepEqual(
      localizedTerminalUserViewIssues(
        report,
        markdown,
        relativePath === "audit-appendix.md" ? "audit_appendix" : "report",
      ),
      [],
      relativePath,
    );
  }
});

test("terminal substrate inventory preserves caller prose without lexical eligibility authority", () => {
  const sourceTitleDiagnosticLiteral = "contract.unit_tuple_not_allowed";
  const citationLabelDiagnosticLiteral = "plans/private-terminal-state.json";
  const base = terminalSourceWithCapturedSubstrateInventory(() => {});
  const baseMarkdown = renderTerminalFullReport(base);
  const inventoryFragment = baseMarkdown.match(
    /- 已采集但未正式化的材料: 1[\s\S]*?(?=\n## |$)/u,
  )?.[0];
  assert.ok(inventoryFragment);
  const source = terminalSourceWithCapturedSubstrateInventory(() => {});
  const conclusion = source.research_conclusion as Record<string, unknown>;
  conclusion.current_recommendation = `${inventoryFragment}\n\n本次运行失败，不能形成研究建议。`;
  source.decision_question = `${inventoryFragment}\n\n用户问题保留 literal evidence/manifest.jsonl#ev_${"1".repeat(
    64,
  )} 和 terminal_reporting.localized_internal_term。`;
  source.sources = [
    {
      ...forgedReadableSource("artifacts/synthetic/formal-evidence.r1.json"),
      title: sourceTitleDiagnosticLiteral,
      claim: `${inventoryFragment}\n\nSource claim literal plans/private-terminal-state.json after contract.unit_tuple_not_allowed.`,
    },
  ];
  source.report_citations = [
    {
      evidence_ref: "artifacts/synthetic/formal-evidence.r1.json",
      label: citationLabelDiagnosticLiteral,
      source_access: "public",
      url: "https://synthetic.invalid/citation-literal",
    },
  ];
  source.commercial_uncertainties = [
    {
      coverage_key: "purchase_signal",
      statement: `${inventoryFragment}\n\nCommercial uncertainty literal evidence/manifest.jsonl#ev_${"1".repeat(
        64,
      )} and runtime_blocked.`,
      starting_point: "Caller prose may preserve exact internal-looking strings literally.",
      reasoning: "Caller prose is not a structured diagnostic renderer.",
      uncertainty: "The literal string is research prose, not an authority leak.",
      validation_needed: "No lexical validation should decide report eligibility from this prose.",
      related_subject_ids: [],
      related_source_ids: [],
    },
  ];
  const canonicalMarkdown = renderTerminalFullReport(source);
  assert.equal(canonicalMarkdown.split(inventoryFragment).length - 1, 4);
  assert.match(canonicalMarkdown, /\[contract\.unit_tuple_not_allowed\]/u);
  assert.deepEqual(localizedTerminalUserViewIssues(source, canonicalMarkdown, "report"), []);
  assert.deepEqual(
    localizedTerminalUserViewIssues(
      {
        research_language: "zh-CN",
        sources: [
          {
            title: sourceTitleDiagnosticLiteral,
            url: "https://example.invalid",
          },
        ],
        report_citations: [],
      },
      `结构化诊断: ${sourceTitleDiagnosticLiteral}`,
    ),
    [],
  );
});

test("captured substrate research goal cannot impersonate audit section boundaries", () => {
  const source = terminalSourceWithCapturedSubstrateInventory((inventory) => {
    const item = (inventory.items as Record<string, unknown>[])[0];
    assert.ok(item);
    item.research_goal =
      "Caller research goal keeps literal headings:\n## 研究来源沿袭\n## 材料采用、限制与排除";
  });
  const appendix = renderTerminalAuditAppendix(source);
  assert.match(appendix, /Caller research goal keeps literal headings/u);
  assert.deepEqual(localizedTerminalUserViewIssues(source, appendix, "audit_appendix"), []);
});

function syntheticEvidenceRecord(
  runId: string,
  hex: string,
  recordedAt: string,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.evidence_store_record.v2",
    run_id: runId,
    evidence_id: `ev_${hex.repeat(64)}`,
    unit_id: "synthetic_unit",
    unit_attempt: 1,
    source: {
      kind: "public_url",
      canonical_url: "https://synthetic.invalid/formal-authority/shared",
    },
    acquisition_goal: `SYNTHETIC substrate ${hex}; preserve exact formalization boundary.`,
    recorded_at: recordedAt,
  };
}

function provenanceDocument(
  pathValue: string,
  schemaVersion: string,
  document: Record<string, unknown>,
  inputRefs: readonly string[] = [],
) {
  return {
    path: pathValue,
    schemaVersion,
    document,
    envelope: { input_refs: inputRefs },
  };
}

test("research provenance uses the shared formal Evidence authority for runtime substrate inventory", () => {
  for (const [schemaVersion, formalPath, sourceManifestVersion] of [
    [
      "startup_opportunity.assessment_evidence.v1",
      "artifacts/assessment/evidence/formal-assessment.r1.json",
      "startup_opportunity.source_manifest.assessment.current",
    ],
    [
      "startup_opportunity.candidate_neutral_evidence.v1",
      "artifacts/discovery/evidence/candidate-neutral.r1.json",
      "startup_opportunity.source_manifest.discovery_candidate.current",
    ],
  ] as const) {
    const runId = `runtime-formal-authority-${schemaVersion
      .replaceAll("startup_opportunity.", "")
      .replaceAll(".", "-")}`;
    const formalRecord = syntheticEvidenceRecord(runId, "a", "2026-07-24T12:10:00Z");
    const unformalizedOne = syntheticEvidenceRecord(runId, "b", "2026-07-24T12:11:00Z");
    const unformalizedTwo = syntheticEvidenceRecord(runId, "c", "2026-07-24T12:12:00Z");
    const exactRecords = new Map(
      [formalRecord, unformalizedOne, unformalizedTwo].map(
        (record) => [`evidence/manifest.jsonl#${String(record.evidence_id)}`, record] as const,
      ),
    );
    const sourceManifestPath = `artifacts/source-manifests/${schemaVersion.replaceAll(
      ".",
      "-",
    )}.json`;
    const reportPath = "artifacts/reporting/terminal-report-source.r1.json";
    const projection = deriveResearchProvenance(
      runId,
      [
        provenanceDocument(
          reportPath,
          "startup_opportunity.terminal_report_source.v1",
          {
            terminal_outcome: "failed",
            runtime_health: { status: "blocked", issues: [] },
            sources: [{ evidence_ref: formalPath }],
          },
          [formalPath, sourceManifestPath],
        ),
        provenanceDocument(formalPath, schemaVersion, {
          schema_version: schemaVersion,
          mechanical_binding: {
            substrate_record_ref: `evidence/manifest.jsonl#${String(formalRecord.evidence_id)}`,
          },
        }),
        provenanceDocument(sourceManifestPath, sourceManifestVersion, {
          schema_version: sourceManifestVersion,
          accepted_evidence_refs: [formalPath],
        }),
      ],
      exactRecords,
      reportPath,
    );
    assert.deepEqual(projection.formal_current_evidence_refs, [formalPath], schemaVersion);
    assert.deepEqual(projection.adopted_current_evidence_refs, [formalPath], schemaVersion);
    assert.deepEqual(projection.cited_current_evidence_refs, [formalPath], schemaVersion);
    const inventory = projection.captured_substrate_inventory as Record<string, unknown>;
    assert.ok(inventory, schemaVersion);
    const inventoryRefs = (inventory.items as Record<string, unknown>[]).map((item) =>
      String(item.evidence_ref),
    );
    assert.deepEqual(
      inventoryRefs,
      [
        `evidence/manifest.jsonl#${String(unformalizedOne.evidence_id)}`,
        `evidence/manifest.jsonl#${String(unformalizedTwo.evidence_id)}`,
      ],
      schemaVersion,
    );
    assert.equal(
      inventoryRefs.includes(`evidence/manifest.jsonl#${String(formalRecord.evidence_id)}`),
      false,
      schemaVersion,
    );
    assert.equal(new Set(inventoryRefs).size, 2, schemaVersion);
    assert.equal(
      new Set(
        (inventory.items as Record<string, unknown>[]).map(
          (item) => (item.source as Record<string, unknown>).canonical_url,
        ),
      ).size,
      1,
      schemaVersion,
    );
  }
});

test("captured substrate inventory renderer fails closed on unknown structured values", () => {
  const valid = terminalSourceWithCapturedSubstrateInventory(() => {});
  assert.doesNotThrow(() => renderTerminalFullReport(valid));
  for (const [label, mutate, pattern] of [
    [
      "inventory status",
      (inventory: Record<string, unknown>) => {
        inventory.status = "available";
      },
      /captured substrate status/u,
    ],
    [
      "inventory reason",
      (inventory: Record<string, unknown>) => {
        inventory.unformalized_reason = "raw_runtime_failure";
      },
      /unformalized_reason/u,
    ],
    [
      "unreachable inventory reason",
      (inventory: Record<string, unknown>) => {
        inventory.unformalized_reason = "other_early_stop";
      },
      /unformalized_reason/u,
    ],
    [
      "conclusion boundary",
      (inventory: Record<string, unknown>) => {
        inventory.conclusion_support_status = "supports_conclusions";
      },
      /conclusion_support_status/u,
    ],
    [
      "item status",
      (inventory: Record<string, unknown>) => {
        const item = (inventory.items as Record<string, unknown>[])[0];
        assert.ok(item);
        item.status = "available";
      },
      /captured substrate status/u,
    ],
    [
      "source kind",
      (inventory: Record<string, unknown>) => {
        const item = (inventory.items as Record<string, unknown>[])[0];
        assert.ok(item);
        item.source = { kind: "private_url", canonical_url: "https://synthetic.invalid/private" };
      },
      /source kind/u,
    ],
    [
      "source identity",
      (inventory: Record<string, unknown>) => {
        const item = (inventory.items as Record<string, unknown>[])[0];
        assert.ok(item);
        item.source = { kind: "public_url" };
      },
      /canonical_url/u,
    ],
  ] as const) {
    const source = terminalSourceWithCapturedSubstrateInventory(mutate);
    assert.throws(() => renderTerminalFullReport(source), pattern, label);
  }
});

test("runtime failure substrate cannot be promoted into terminal report sources", async (contextTest) => {
  const runId = "runtime-failure-forged-substrate-source";
  const setup = await setupPersistedRun(contextTest, runId, "runtime-failure");
  const substrateRecords = await seedRuntimeFailureSubstrateOnlyEvidence(setup.runsRoot, runId);
  const firstRecord = substrateRecords[0];
  assert.ok(firstRecord);
  const substrateRef = `evidence/manifest.jsonl#${String(firstRecord.evidence_id)}`;
  const terminal = await prepareTerminalReporting(setup, true);
  const forged = clone(terminal.reportEnvelope);
  forged.document.sources = [forgedReadableSource(substrateRef)];
  (forged as { content_hash: string }).content_hash = canonicalContentHash(forged.document);
  await assert.rejects(
    (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
      runId,
      adaptationBundle: terminal.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      terminalReportEnvelope: forged,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Reject substrate-only material as a formal report source.",
      beliefSummary: {
        current_belief: "Substrate records remain audit-only after a runtime failure.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Can a later repaired Run formalize these materials?",
      },
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "report.source_invalid" &&
      JSON.stringify(error.details).includes(substrateRef),
  );
  assert.equal((await setup.store.status(runId)).manifest.status, "researching");
  for (const relativePath of ["report.json", "decision-brief.md", "report.md"]) {
    await assert.rejects(readFile(path.join(setup.runRoot, relativePath), "utf8"));
  }
});

test("runtime failure rejects cross-Run or broken caller substrate provenance", async (contextTest) => {
  const runId = "runtime-failure-forged-substrate-provenance";
  const setup = await setupPersistedRun(contextTest, runId, "runtime-failure");
  const sourceRunId = "runtime-failure-cross-run-substrate-source";
  await createConfirmedRun(setup.store, {
    runId: sourceRunId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic source user"],
      decisionGoal: "provide a cross-Run substrate record that must not project",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-24T11:00:00Z",
  });
  const crossRunRecords = await seedRuntimeFailureSubstrateOnlyEvidence(
    setup.runsRoot,
    sourceRunId,
  );
  const crossRunRecord = crossRunRecords[0];
  assert.ok(crossRunRecord);
  const crossRunRef = `evidence/manifest.jsonl#${String(crossRunRecord.evidence_id)}`;
  const brokenRef = `evidence/manifest.jsonl#ev_${"0".repeat(64)}`;
  const terminal = await prepareTerminalReporting(setup, true);
  const forged = clone(terminal.reportEnvelope);
  forged.document.research_provenance = {
    available_handoff_count: 0,
    captured_item_count: 0,
    causal_handoff_refs: [],
    consumed_item_refs: [],
    used_handoff_items: [],
    imported_substrate_refs: [],
    formal_inherited_evidence_refs: [],
    adopted_inherited_evidence_refs: [],
    cited_inherited_evidence_refs: [],
    formal_current_evidence_refs: [],
    adopted_current_evidence_refs: [],
    cited_current_evidence_refs: [],
    captured_substrate_inventory: {
      status: "captured_not_formalized",
      unformalized_reason: "runtime_failure",
      conclusion_support_status: "does_not_support_conclusions",
      items: [
        {
          evidence_ref: crossRunRef,
          source: crossRunRecord.source,
          research_goal: crossRunRecord.acquisition_goal,
          recorded_at: crossRunRecord.recorded_at,
          status: "captured_not_formalized",
        },
        {
          evidence_ref: brokenRef,
          source: {
            kind: "public_url",
            canonical_url: "https://synthetic.invalid/runtime-failure/broken-ref",
          },
          research_goal: "SYNTHETIC broken ref must not be accepted into terminal provenance.",
          recorded_at: "2026-07-24T12:30:00Z",
          status: "captured_not_formalized",
        },
      ],
    },
    revalidation_gaps: [],
  };
  (forged as { content_hash: string }).content_hash = canonicalContentHash(forged.document);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  await assert.rejects(
    runtime.apply({
      runId,
      adaptationBundle: terminal.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      terminalReportEnvelope: forged,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Reject cross-Run or broken substrate provenance.",
      beliefSummary: {
        current_belief: "Only exact same-Run Evidence Store records may be projected.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Can a clean terminal report omit foreign records?",
      },
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "report.source_invalid" &&
      error.message.includes("research provenance"),
  );
  assert.equal((await setup.store.status(runId)).manifest.status, "researching");

  const clean = await runtime.apply({
    runId,
    adaptationBundle: terminal.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    terminalReportEnvelope: terminal.reportEnvelope,
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Publish only exact same-Run terminal provenance.",
    beliefSummary: {
      current_belief: "The target Run has no same-Run substrate records to project.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Can a repaired Run capture formal Evidence?",
    },
  });
  assert.equal(clean.status, "applied");
  const report = JSON.parse(
    await readFile(path.join(setup.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  const provenance = report.research_provenance as Record<string, unknown>;
  assert.equal(provenance.captured_substrate_inventory, undefined);
  assert.doesNotMatch(await readFile(path.join(setup.runRoot, "report.md"), "utf8"), /cross-run/iu);
  assert.doesNotMatch(
    await readFile(path.join(setup.runRoot, "report.md"), "utf8"),
    new RegExp(String(crossRunRecord.evidence_id)),
  );
});

test("runtime failure rejects caller substrate provenance from another Run before report writes", async (contextTest) => {
  const runId = "runtime-failure-cross-run-substrate-provenance";
  const setup = await setupPersistedRun(contextTest, runId, "runtime-failure");
  const sourceRunId = "runtime-failure-cross-run-only-source";
  await createConfirmedRun(setup.store, {
    runId: sourceRunId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic source user"],
      decisionGoal: "provide a cross-Run substrate record that must not project",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-24T11:00:00Z",
  });
  const crossRunRecords = await seedRuntimeFailureSubstrateOnlyEvidence(
    setup.runsRoot,
    sourceRunId,
  );
  const crossRunRecord = crossRunRecords[0];
  assert.ok(crossRunRecord);
  const crossRunRef = `evidence/manifest.jsonl#${String(crossRunRecord.evidence_id)}`;
  const terminal = await prepareTerminalReporting(setup, true);
  const forged = clone(terminal.reportEnvelope);
  forged.document.research_provenance = {
    available_handoff_count: 0,
    captured_item_count: 0,
    causal_handoff_refs: [],
    consumed_item_refs: [],
    used_handoff_items: [],
    imported_substrate_refs: [],
    formal_inherited_evidence_refs: [],
    adopted_inherited_evidence_refs: [],
    cited_inherited_evidence_refs: [],
    formal_current_evidence_refs: [],
    adopted_current_evidence_refs: [],
    cited_current_evidence_refs: [],
    captured_substrate_inventory: {
      status: "captured_not_formalized",
      unformalized_reason: "runtime_failure",
      conclusion_support_status: "does_not_support_conclusions",
      items: [
        {
          evidence_ref: crossRunRef,
          source: crossRunRecord.source,
          research_goal: crossRunRecord.acquisition_goal,
          recorded_at: crossRunRecord.recorded_at,
          status: "captured_not_formalized",
        },
      ],
    },
    revalidation_gaps: [],
  };
  (forged as { content_hash: string }).content_hash = canonicalContentHash(forged.document);
  await assert.rejects(
    (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
      ...terminalApplyInput(
        setup,
        { ...terminal, reportEnvelope: forged },
        "Foreign substrate records must remain outside this Run's terminal provenance.",
      ),
      terminalReportEnvelope: forged,
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "report.source_invalid" &&
      error.message.includes("research provenance"),
  );
  assert.equal((await setup.store.status(runId)).manifest.status, "researching");
  await assertNoTerminalReportOutputs(setup.runRoot);
});

test("runtime failure rejects missing caller substrate provenance before report writes", async (contextTest) => {
  const runId = "runtime-failure-missing-substrate-provenance";
  const setup = await setupPersistedRun(contextTest, runId, "runtime-failure");
  const missingRef = `evidence/manifest.jsonl#ev_${"0".repeat(64)}`;
  const terminal = await prepareTerminalReporting(setup, true);
  const forged = clone(terminal.reportEnvelope);
  forged.document.research_provenance = {
    available_handoff_count: 0,
    captured_item_count: 0,
    causal_handoff_refs: [],
    consumed_item_refs: [],
    used_handoff_items: [],
    imported_substrate_refs: [],
    formal_inherited_evidence_refs: [],
    adopted_inherited_evidence_refs: [],
    cited_inherited_evidence_refs: [],
    formal_current_evidence_refs: [],
    adopted_current_evidence_refs: [],
    cited_current_evidence_refs: [],
    captured_substrate_inventory: {
      status: "captured_not_formalized",
      unformalized_reason: "runtime_failure",
      conclusion_support_status: "does_not_support_conclusions",
      items: [
        {
          evidence_ref: missingRef,
          source: {
            kind: "public_url",
            canonical_url: "https://synthetic.invalid/runtime-failure/missing-ref",
          },
          research_goal: "SYNTHETIC missing ref must not be accepted into terminal provenance.",
          recorded_at: "2026-07-24T12:30:00Z",
          status: "captured_not_formalized",
        },
      ],
    },
    revalidation_gaps: [],
  };
  (forged as { content_hash: string }).content_hash = canonicalContentHash(forged.document);
  await assert.rejects(
    (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
      ...terminalApplyInput(
        setup,
        { ...terminal, reportEnvelope: forged },
        "Missing substrate refs must fail closed before terminal outputs are written.",
      ),
      terminalReportEnvelope: forged,
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "report.source_invalid" &&
      error.message.includes("research provenance"),
  );
  assert.equal((await setup.store.status(runId)).manifest.status, "researching");
  await assertNoTerminalReportOutputs(setup.runRoot);
});

test("runtime failure substrate inventory fails closed on broken Evidence Store hashes", async (contextTest) => {
  const runId = "runtime-failure-broken-substrate-hash";
  const setup = await setupPersistedRun(contextTest, runId, "runtime-failure");
  await seedRuntimeFailureSubstrateOnlyEvidence(setup.runsRoot, runId);
  const terminal = await prepareTerminalReporting(setup, true);
  const manifestPath = path.join(setup.runRoot, "evidence/manifest.jsonl");
  const lines = (await readFile(manifestPath, "utf8")).trimEnd().split("\n");
  assert.ok(lines[0]);
  const tampered = JSON.parse(lines[0]) as Record<string, unknown>;
  tampered.source_hash = sha256Bytes("synthetic wrong source hash");
  lines[0] = canonicalJson(tampered);
  await writeFile(manifestPath, `${lines.join("\n")}\n`);
  await assert.rejects(
    (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
      runId,
      adaptationBundle: terminal.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      terminalReportEnvelope: terminal.reportEnvelope,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Reject a runtime failure report whose substrate store is corrupt.",
      beliefSummary: {
        current_belief: "Evidence Store hash integrity is required even for audit-only projection.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Can the store be repaired before reporting?",
      },
    }),
    (error: unknown) => error instanceof StoreError && error.code === "evidence.invalid_record",
  );
  await assert.rejects(
    setup.store.status(runId),
    (error: unknown) => error instanceof StoreError && error.code === "evidence.invalid_record",
  );
  for (const relativePath of ["report.json", "decision-brief.md", "report.md"]) {
    await assert.rejects(readFile(path.join(setup.runRoot, relativePath), "utf8"));
  }
});

test("technical restart binds a new current Run to an exact terminal runtime failure", async (contextTest) => {
  const sourceRunId = "runtime-failure-technical-restart-source";
  const replacementRunId = "runtime-failure-technical-restart-new-attempt";
  const {
    setup,
    sourceStatus,
    sourceManifestHash,
    sourceTerminalReportSourceRef,
    sourceTerminalReportSourceHash,
  } = await terminalRuntimeFailureSource(contextTest, sourceRunId, true);
  assert.equal(sourceStatus.derivedExecutionDisposition, "terminal");
  assert.ok(
    G21_MAP_REFS.every((ref) => sourceStatus.manifest.artifact_refs.includes(ref)),
    JSON.stringify(sourceStatus.manifest.artifact_refs, null, 2),
  );

  const createInput = {
    runId: replacementRunId,
    mode: "opportunity_discovery" as const,
    createdAt: "2026-07-25T00:00:00Z",
    scopeProposal: sameSyntheticScopeProposal(),
    technicalRestart: technicalRestartDeclaration(
      sourceRunId,
      sourceManifestHash,
      sourceTerminalReportSourceRef,
      sourceTerminalReportSourceHash,
    ),
  };
  const created = await setup.store.create(createInput);
  assert.equal(created.status, "created");
  assert.equal(created.manifest.parent_run_id, null);
  assert.equal(created.manifest.status, "awaiting_scope_confirmation");
  assert.equal(created.manifest.current_phase, null);
  assert.equal(created.manifest.current_plan_ref, null);
  assert.equal(created.manifest.plan_revision, 0);
  assert.equal(created.manifest.current_decision_subject_snapshot_ref, null);
  assert.deepEqual(created.manifest.artifact_refs, []);
  assert.deepEqual(created.manifest.completed_units, []);
  assert.deepEqual(created.manifest.active_units, []);
  assert.deepEqual(created.manifest.failed_units, []);
  assert.deepEqual(created.manifest.applied_adaptation_refs, []);
  const provenance = created.technicalRestartProvenance;
  assert.ok(provenance);
  assert.equal(provenance.sourceRunId, sourceRunId);
  assert.equal(provenance.replacementRunId, replacementRunId);
  assert.equal(provenance.sourceManifestHash, sourceManifestHash);
  assert.equal(provenance.sourceTerminalReportSourceRef, sourceTerminalReportSourceRef);
  assert.equal(provenance.sourceTerminalReportSourceHash, sourceTerminalReportSourceHash);
  assert.equal(provenance.terminalAuthority, "record_runtime_failure");
  assert.equal(provenance.restartBoundary, "technical_fix_new_attempt");
  assert.equal(provenance.relationshipBasis, "caller_declared_exact_terminal_runtime_failure");
  assert.equal(provenance.inheritedRunState, "none");

  const replayed = await setup.store.create(createInput);
  assert.equal(replayed.status, "idempotent_replay");
  assert.deepEqual(replayed.technicalRestartProvenance, provenance);

  const sourceAfterRestart = await setup.store.status(sourceRunId);
  assert.equal(sourceAfterRestart.manifest.status, "failed");
  assert.equal(sourceAfterRestart.derivedExecutionDisposition, "superseded_by_new_attempt");
  assert.equal(sourceAfterRestart.terminalReportDisposition, "ready");
  assert.deepEqual(sourceAfterRestart.technicalRestartReplacementRunIds, [replacementRunId]);
  assert.ok(
    sourceAfterRestart.resumeContext.blockingReasons.includes(
      `technical_restart_replacement:${replacementRunId}`,
    ),
  );

  const replacementStatus = await setup.store.status(replacementRunId);
  assert.equal(replacementStatus.derivedExecutionDisposition, "current");
  assert.equal(replacementStatus.currentLeafRunId, replacementRunId);
  assert.deepEqual(replacementStatus.technicalRestartReplacementRunIds, []);
  assert.deepEqual(replacementStatus.technicalRestartProvenance, provenance);
  assert.equal(replacementStatus.terminalReportDisposition, "not_required");
  assert.equal(replacementStatus.manifest.current_plan_ref, null);
  assert.deepEqual(replacementStatus.manifest.artifact_refs, []);

  const reopenedStore = new RunStore(setup.runsRoot, await createArtifactValidator(repositoryRoot));
  const reopenedSourceStatus = await reopenedStore.status(sourceRunId);
  assert.equal(reopenedSourceStatus.manifest.status, "failed");
  assert.equal(reopenedSourceStatus.derivedExecutionDisposition, "superseded_by_new_attempt");
  await assert.rejects(
    reopenedStore.load(sourceRunId),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.superseded_by_new_attempt",
  );
  const reopenedReplacement = await reopenedStore.load(replacementRunId);
  assert.equal(reopenedReplacement.manifest.parent_run_id, null);
  assert.equal(reopenedReplacement.manifest.current_plan_ref, null);
  assert.deepEqual(reopenedReplacement.manifest.artifact_refs, []);
  await assert.rejects(
    setup.store.assertResearchExecutionAllowed(sourceRunId),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.superseded_by_new_attempt",
  );
  const sourceTreeBeforeBlockedWrite = await snapshotRunTree(setup.runRoot);
  await assert.rejects(
    setup.store.publishArtifact({
      runId: sourceRunId,
      envelope: formalEnvelope(sourceRunId, PLAN_REF, setup.plan),
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.superseded_by_new_attempt",
  );
  assert.deepEqual(await snapshotRunTree(setup.runRoot), sourceTreeBeforeBlockedWrite);

  await assert.rejects(
    setup.store.proposeScope({
      runId: sourceRunId,
      expectedScopeRevision: 1,
      proposedAt: "2026-07-25T00:01:00Z",
      reason: "A superseded terminal source cannot be mutated after the restart boundary.",
      scopeProposal: {
        ...sameSyntheticScopeProposal(),
        decisionGoal: "attempt an invalid source mutation",
      },
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.superseded_by_new_attempt",
  );

  await setup.store.confirmScope({
    runId: replacementRunId,
    expectedScopeProposalRevision: 1,
    expectedScopeProposalRef: created.scopeProposalRef,
    expectedScopeProposalHash: created.scopeProposalHash,
    confirmedAt: "2026-07-25T00:02:00Z",
    userConfirmationAttestation:
      "The fixture caller attests exact user confirmation of the replacement Scope.",
  });
  await assert.rejects(
    setup.store.publishArtifact({
      runId: replacementRunId,
      envelope: formalEnvelope(sourceRunId, PLAN_REF, setup.plan),
    }),
    (error: unknown) => error instanceof StoreError,
  );
  const replacementAfterRejectedImport = await setup.store.status(replacementRunId);
  assert.equal(replacementAfterRejectedImport.manifest.current_plan_ref, null);
  assert.deepEqual(replacementAfterRejectedImport.manifest.artifact_refs, []);
});

test("technical restart replays every crash boundary and stays non-superseded until the closure is committed", async (contextTest) => {
  const scenarios = [
    {
      name: "before publish",
      faultAt: "before_publish" as const,
      expectedSourceDisposition: "indeterminate" as const,
      expectedReplacementDisposition: "not_found" as const,
      expectedReplayStatus: "created" as const,
    },
    {
      name: "after run publish",
      faultAt: "technical_restart_after_run_publish" as const,
      expectedSourceDisposition: "indeterminate" as const,
      expectedReplacementDisposition: "indeterminate" as const,
      expectedReplayStatus: "idempotent_replay" as const,
    },
    {
      name: "after source commit",
      faultAt: "technical_restart_after_source_commit" as const,
      expectedSourceDisposition: "indeterminate" as const,
      expectedReplacementDisposition: "indeterminate" as const,
      expectedReplayStatus: "idempotent_replay" as const,
    },
    {
      name: "after replacement commit",
      faultAt: "technical_restart_after_replacement_commit" as const,
      expectedSourceDisposition: "superseded_by_new_attempt" as const,
      expectedReplacementDisposition: "current" as const,
      expectedReplayStatus: "idempotent_replay" as const,
    },
  ] as const;

  for (const scenario of scenarios) {
    await contextTest.test(scenario.name, async (subcontext) => {
      const sourceRunId = `runtime-failure-technical-restart-${scenario.name.replaceAll(" ", "-")}-source`;
      const replacementRunId = `runtime-failure-technical-restart-${scenario.name.replaceAll(" ", "-")}-new-attempt`;
      const {
        setup,
        sourceManifestHash,
        sourceTerminalReportSourceRef,
        sourceTerminalReportSourceHash,
      } = await terminalRuntimeFailureSource(subcontext, sourceRunId, true);

      const createInput = {
        runId: replacementRunId,
        mode: "opportunity_discovery" as const,
        createdAt: "2026-07-25T00:05:00Z",
        scopeProposal: sameSyntheticScopeProposal(),
        technicalRestart: technicalRestartDeclaration(
          sourceRunId,
          sourceManifestHash,
          sourceTerminalReportSourceRef,
          sourceTerminalReportSourceHash,
        ),
      };

      await assert.rejects(
        setup.store.create({ ...createInput, faultAt: scenario.faultAt }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );

      const sourceBeforeReplay = await setup.store.status(sourceRunId);
      assert.equal(
        sourceBeforeReplay.derivedExecutionDisposition,
        scenario.expectedSourceDisposition,
      );
      assert.equal(
        sourceBeforeReplay.currentLeafRunId,
        scenario.name === "after replacement commit" ? sourceRunId : null,
      );
      if (scenario.expectedReplacementDisposition === "not_found") {
        await assert.rejects(
          setup.store.status(replacementRunId),
          (error: unknown) => error instanceof StoreError && error.code === "run.not_found",
        );
      } else {
        const replacementBeforeReplay = await setup.store.status(replacementRunId);
        assert.equal(
          replacementBeforeReplay.derivedExecutionDisposition,
          scenario.expectedReplacementDisposition,
        );
      }

      const replay = await setup.store.create(createInput);
      assert.equal(replay.status, scenario.expectedReplayStatus);

      const reopenedStore = new RunStore(
        setup.runsRoot,
        await createArtifactValidator(repositoryRoot),
      );
      const sourceAfterReplay = await reopenedStore.status(sourceRunId);
      assert.equal(sourceAfterReplay.derivedExecutionDisposition, "superseded_by_new_attempt");
      assert.deepEqual(sourceAfterReplay.technicalRestartReplacementRunIds, [replacementRunId]);
      assert.equal(sourceAfterReplay.currentLeafRunId, sourceRunId);
      await assert.rejects(
        reopenedStore.load(sourceRunId),
        (error: unknown) =>
          error instanceof StoreError && error.code === "run.superseded_by_new_attempt",
      );
      const replacementAfterReplay = await reopenedStore.status(replacementRunId);
      assert.equal(replacementAfterReplay.derivedExecutionDisposition, "current");
      assert.equal(replacementAfterReplay.currentLeafRunId, replacementRunId);
    });
  }
});

test("technical restart exact replay reuses pending created_at and blocks occupied replacement ids", async (contextTest) => {
  const sourceRunId = "runtime-failure-technical-restart-pending-replay-source";
  const replacementRunId = "runtime-failure-technical-restart-pending-replay-new-attempt";
  const {
    setup,
    sourceManifestHash,
    sourceTerminalReportSourceRef,
    sourceTerminalReportSourceHash,
  } = await terminalRuntimeFailureSource(contextTest, sourceRunId, true);
  const createInput = {
    runId: replacementRunId,
    mode: "opportunity_discovery" as const,
    createdAt: "2026-07-25T00:05:00Z",
    scopeProposal: sameSyntheticScopeProposal(),
    technicalRestart: technicalRestartDeclaration(
      sourceRunId,
      sourceManifestHash,
      sourceTerminalReportSourceRef,
      sourceTerminalReportSourceHash,
    ),
  };

  await assert.rejects(
    setup.store.create({ ...createInput, faultAt: "before_publish" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const pendingTree = await snapshotRunTree(setup.runRoot);
  await assert.rejects(
    setup.store.create({
      runId: replacementRunId,
      mode: "opportunity_discovery",
      scopeProposal: sameSyntheticScopeProposal(),
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "technical_restart.declaration_conflict",
  );
  assert.deepEqual(await snapshotRunTree(setup.runRoot), pendingTree);
  await assert.rejects(
    setup.store.create({
      ...createInput,
      createdAt: "2026-07-25T00:05:30Z",
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "technical_restart.declaration_conflict",
  );
  assert.deepEqual(await snapshotRunTree(setup.runRoot), pendingTree);

  const { createdAt: _createdAt, ...replayInput } = createInput;
  const replay = await setup.store.create(replayInput);
  assert.equal(replay.status, "created");
  assert.equal(replay.manifest.created_at, createInput.createdAt);
  const sourceAfterReplay = await setup.store.status(sourceRunId);
  assert.equal(sourceAfterReplay.derivedExecutionDisposition, "superseded_by_new_attempt");
  assert.deepEqual(sourceAfterReplay.technicalRestartReplacementRunIds, [replacementRunId]);
});

test("technical restart existing-target replay reuses stored created_at when omitted", async (contextTest) => {
  const scenarios = [
    {
      name: "after run publish",
      faultAt: "technical_restart_after_run_publish" as const,
    },
    {
      name: "after source commit",
      faultAt: "technical_restart_after_source_commit" as const,
    },
  ] as const;

  for (const scenario of scenarios) {
    await contextTest.test(scenario.name, async (subcontext) => {
      const sourceRunId = `runtime-failure-technical-restart-existing-target-${scenario.name.replaceAll(
        " ",
        "-",
      )}-source`;
      const replacementRunId = `runtime-failure-technical-restart-existing-target-${scenario.name.replaceAll(
        " ",
        "-",
      )}-new-attempt`;
      const {
        setup,
        sourceManifestHash,
        sourceTerminalReportSourceRef,
        sourceTerminalReportSourceHash,
      } = await terminalRuntimeFailureSource(subcontext, sourceRunId, true);

      const createInput = {
        runId: replacementRunId,
        mode: "opportunity_discovery" as const,
        createdAt: "2026-07-25T00:06:00Z",
        scopeProposal: sameSyntheticScopeProposal(),
        technicalRestart: technicalRestartDeclaration(
          sourceRunId,
          sourceManifestHash,
          sourceTerminalReportSourceRef,
          sourceTerminalReportSourceHash,
        ),
      };

      await assert.rejects(
        setup.store.create({ ...createInput, faultAt: scenario.faultAt }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );

      const sourceBeforeReplay = await setup.store.status(sourceRunId);
      assert.equal(sourceBeforeReplay.derivedExecutionDisposition, "indeterminate");

      const { createdAt: _createdAt, ...replayInput } = createInput;
      const replay = await setup.store.create(replayInput);
      assert.equal(replay.status, "idempotent_replay");
      assert.equal(replay.manifest.created_at, createInput.createdAt);
      assert.equal(replay.technicalRestartProvenance?.declaredAt, createInput.createdAt);

      const sourceAfterReplay = await setup.store.status(sourceRunId);
      assert.equal(sourceAfterReplay.derivedExecutionDisposition, "superseded_by_new_attempt");
      assert.deepEqual(sourceAfterReplay.technicalRestartReplacementRunIds, [replacementRunId]);
    });
  }
});

test("technical restart current-only gates block compile and formal-stage on a real superseded source", async (contextTest) => {
  const sourceRunId = "runtime-failure-technical-restart-real-gated-source";
  const replacementRunId = "runtime-failure-technical-restart-real-gated-new-attempt";
  const {
    setup,
    sourceManifestHash,
    sourceTerminalReportSourceRef,
    sourceTerminalReportSourceHash,
  } = await terminalRuntimeFailureSource(contextTest, sourceRunId, true);
  const validator = await createArtifactValidator(repositoryRoot);
  const compiler = createFormalStageRuntimeCompiler(setup.runsRoot, validator, repositoryRoot);
  const materializer = new FormalStageMaterializer(setup.runsRoot, validator, repositoryRoot);
  const planQuestion = (setup.plan.research_questions as Record<string, unknown>[])[0];
  assert.ok(planQuestion);
  const policyRef = "harness/policies/adaptation.current.json";
  const fragmentRef = `${PLAN_REF}#${String(planQuestion.question_id)}`;
  const compileArtifact = {
    ...runtimeArtifact(
      "plans/research-execution.r1.json",
      executionPlan(sourceRunId, setup.plan),
      "main_agent",
    ),
    input_refs: [policyRef, fragmentRef],
  };
  const compileRequest = compilationRequest(
    sourceRunId,
    "validate_only",
    [compileArtifact],
    "request_superseded_real_compile",
  );
  const task = fixtureEffective(setup.discoveryBundle as DocumentBundle, G22_EVALUATION_TASK);
  const waveRequest = formalStageWaveRequest(sourceRunId, task);
  const validatedWave = await materializer.materialize(waveRequest).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
    }
    throw error;
  });

  const createInput = {
    runId: replacementRunId,
    mode: "opportunity_discovery" as const,
    createdAt: "2026-07-25T00:07:00Z",
    scopeProposal: sameSyntheticScopeProposal(),
    technicalRestart: technicalRestartDeclaration(
      sourceRunId,
      sourceManifestHash,
      sourceTerminalReportSourceRef,
      sourceTerminalReportSourceHash,
    ),
  };
  await setup.store.create(createInput);
  const sourceAfterRestart = await setup.store.status(sourceRunId);
  assert.equal(sourceAfterRestart.derivedExecutionDisposition, "superseded_by_new_attempt");
  assert.deepEqual(sourceAfterRestart.technicalRestartReplacementRunIds, [replacementRunId]);

  const beforeBlockedWrites = await snapshotRunTree(setup.runRoot);
  await assert.rejects(
    compiler.compile(compileRequest),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.superseded_by_new_attempt",
  );
  assert.deepEqual(await snapshotRunTree(setup.runRoot), beforeBlockedWrites);
  await assert.rejects(
    compiler.compile({
      ...compileRequest,
      request_id: "request_superseded_real_compile_publish",
      operation: "publish",
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.superseded_by_new_attempt",
  );
  assert.deepEqual(await snapshotRunTree(setup.runRoot), beforeBlockedWrites);
  await assert.rejects(
    materializer.materialize(waveRequest),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.superseded_by_new_attempt",
  );
  assert.deepEqual(await snapshotRunTree(setup.runRoot), beforeBlockedWrites);
  await assert.rejects(
    materializer.materialize({
      ...waveRequest,
      operation: "publish",
      publication_plan: validatedWave.compilation.publication_plan,
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.superseded_by_new_attempt",
  );
  assert.deepEqual(await snapshotRunTree(setup.runRoot), beforeBlockedWrites);
});

test("technical restart rejects non-terminal, cross-root, and forged source authority", async (contextTest) => {
  await contextTest.test("non-terminal source", async (subcontext) => {
    const sourceRunId = "technical-restart-non-terminal-source";
    const setup = await setupPersistedRun(subcontext, sourceRunId, "runtime-failure-maps");
    const sourceManifestHash = canonicalContentHash(
      (await setup.store.status(sourceRunId)).manifest,
    );
    await assert.rejects(
      setup.store.create({
        runId: "technical-restart-from-non-terminal",
        mode: "opportunity_discovery",
        createdAt: "2026-07-25T00:10:00Z",
        scopeProposal: sameSyntheticScopeProposal(),
        technicalRestart: {
          sourceRunId,
          sourceManifestHash,
          sourceTerminalReportSourceRef: "artifacts/reporting/terminal-report-source.r1.json",
          sourceTerminalReportSourceHash: sha256Bytes("missing terminal source"),
          userAuthorizationAttestation:
            "The fixture caller attempts a restart before terminal closeout.",
        },
      }),
      (error: unknown) =>
        error instanceof StoreError && error.code === "technical_restart.source_not_runtime_failed",
    );
  });

  await contextTest.test("missing source id in same root", async (subcontext) => {
    const sourceRunId = "technical-restart-missing-source-authority";
    const {
      setup,
      sourceManifestHash,
      sourceTerminalReportSourceRef,
      sourceTerminalReportSourceHash,
    } = await terminalRuntimeFailureSource(
      subcontext,
      "technical-restart-existing-source-for-missing-id",
    );
    await assert.rejects(
      setup.store.create({
        runId: "technical-restart-forged-source-id",
        mode: "opportunity_discovery",
        createdAt: "2026-07-25T00:11:00Z",
        scopeProposal: sameSyntheticScopeProposal(),
        technicalRestart: technicalRestartDeclaration(
          sourceRunId,
          sourceManifestHash,
          sourceTerminalReportSourceRef,
          sourceTerminalReportSourceHash,
        ),
      }),
      (error: unknown) => error instanceof StoreError && error.code === "run.not_found",
    );
  });

  await contextTest.test("cross-root source", async (subcontext) => {
    const sourceRunId = "technical-restart-cross-root-source";
    const {
      setup,
      sourceManifestHash,
      sourceTerminalReportSourceRef,
      sourceTerminalReportSourceHash,
    } = await terminalRuntimeFailureSource(subcontext, sourceRunId);
    const otherRoot = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g04-cross-root-"));
    subcontext.after(() => rm(otherRoot, { recursive: true, force: true }));
    const otherStore = new RunStore(
      path.join(otherRoot, "runs"),
      await createArtifactValidator(repositoryRoot),
    );
    await assert.rejects(
      otherStore.create({
        runId: "technical-restart-cross-root-replacement",
        mode: "opportunity_discovery",
        createdAt: "2026-07-25T00:12:00Z",
        scopeProposal: sameSyntheticScopeProposal(),
        technicalRestart: technicalRestartDeclaration(
          sourceRunId,
          sourceManifestHash,
          sourceTerminalReportSourceRef,
          sourceTerminalReportSourceHash,
        ),
      }),
      (error: unknown) => error instanceof StoreError && error.code === "run.not_found",
    );
    assert.equal((await setup.store.status(sourceRunId)).derivedExecutionDisposition, "terminal");
  });

  await contextTest.test("source manifest hash mismatch", async (subcontext) => {
    const sourceRunId = "technical-restart-forged-manifest-source";
    const {
      setup,
      sourceManifestHash,
      sourceTerminalReportSourceRef,
      sourceTerminalReportSourceHash,
    } = await terminalRuntimeFailureSource(subcontext, sourceRunId);
    await assert.rejects(
      setup.store.create({
        runId: "technical-restart-forged-manifest-replacement",
        mode: "opportunity_discovery",
        createdAt: "2026-07-25T00:13:00Z",
        scopeProposal: sameSyntheticScopeProposal(),
        technicalRestart: technicalRestartDeclaration(
          sourceRunId,
          sourceManifestHash,
          sourceTerminalReportSourceRef,
          sourceTerminalReportSourceHash,
          {
            sourceManifestHash: sha256Bytes("forged manifest hash"),
          },
        ),
      }),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code === "technical_restart.source_manifest_hash_mismatch",
    );
  });

  await contextTest.test("terminal report source ref and hash mismatch", async (subcontext) => {
    const sourceRunId = "technical-restart-forged-terminal-source";
    const {
      setup,
      sourceManifestHash,
      sourceTerminalReportSourceRef,
      sourceTerminalReportSourceHash,
    } = await terminalRuntimeFailureSource(subcontext, sourceRunId);
    await assert.rejects(
      setup.store.create({
        runId: "technical-restart-forged-terminal-ref",
        mode: "opportunity_discovery",
        createdAt: "2026-07-25T00:14:00Z",
        scopeProposal: sameSyntheticScopeProposal(),
        technicalRestart: technicalRestartDeclaration(
          sourceRunId,
          sourceManifestHash,
          sourceTerminalReportSourceRef,
          sourceTerminalReportSourceHash,
          {
            sourceTerminalReportSourceRef: `${sourceTerminalReportSourceRef}#fragment`,
          },
        ),
      }),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code === "technical_restart.terminal_report_ref_invalid",
    );
    await assert.rejects(
      setup.store.create({
        runId: "technical-restart-forged-terminal-hash",
        mode: "opportunity_discovery",
        createdAt: "2026-07-25T00:15:00Z",
        scopeProposal: sameSyntheticScopeProposal(),
        technicalRestart: technicalRestartDeclaration(
          sourceRunId,
          sourceManifestHash,
          sourceTerminalReportSourceRef,
          sourceTerminalReportSourceHash,
          {
            sourceTerminalReportSourceHash: sha256Bytes("forged terminal source hash"),
          },
        ),
      }),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code === "technical_restart.terminal_report_source_hash_mismatch",
    );
  });
});

test("technical restart keeps ordinary same-scope Runs independent", async (contextTest) => {
  const sourceRunId = "technical-restart-silent-same-scope-source";
  const newRunId = "technical-restart-silent-same-scope-new-run";
  const { setup } = await terminalRuntimeFailureSource(contextTest, sourceRunId, true);
  const created = await setup.store.create({
    runId: newRunId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-25T00:20:00Z",
    scopeProposal: sameSyntheticScopeProposal(),
  });
  assert.equal(created.technicalRestartProvenance, null);
  const sourceStatus = await setup.store.status(sourceRunId);
  assert.equal(sourceStatus.derivedExecutionDisposition, "terminal");
  assert.deepEqual(sourceStatus.technicalRestartReplacementRunIds, []);
  const newRunStatus = await setup.store.status(newRunId);
  assert.equal(newRunStatus.derivedExecutionDisposition, "current");
  assert.equal(newRunStatus.technicalRestartProvenance, null);
  assert.deepEqual(newRunStatus.continuationRunIds, []);
});

test("technical restart lookups tolerate an absent technical-restarts tree on a fresh store", async (contextTest) => {
  const runId = "technical-restart-absent-index-tree";
  const { setup } = await terminalRuntimeFailureSource(contextTest, runId);
  await rm(path.join(setup.runsRoot, ".technical-restarts"), { recursive: true, force: true });
  const status = await setup.store.status(runId);
  assert.equal(status.derivedExecutionDisposition, "terminal");
  assert.deepEqual(status.technicalRestartReplacementRunIds, []);
  const reopenedStore = new RunStore(setup.runsRoot, await createArtifactValidator(repositoryRoot));
  const reopened = await reopenedStore.load(runId);
  assert.equal(reopened.manifest.run_id, runId);
});

test("technical restart rejects continuation parents and duplicate replacement attempts", async (contextTest) => {
  await contextTest.test("parent_run_id is forbidden", async (subcontext) => {
    const sourceRunId = "technical-restart-parent-forbidden-source";
    const {
      setup,
      sourceManifestHash,
      sourceTerminalReportSourceRef,
      sourceTerminalReportSourceHash,
    } = await terminalRuntimeFailureSource(subcontext, sourceRunId);
    await assert.rejects(
      setup.store.create({
        runId: "technical-restart-parent-forbidden-replacement",
        mode: "opportunity_discovery",
        createdAt: "2026-07-25T00:30:00Z",
        parentRunId: sourceRunId,
        scopeProposal: sameSyntheticScopeProposal(),
        technicalRestart: technicalRestartDeclaration(
          sourceRunId,
          sourceManifestHash,
          sourceTerminalReportSourceRef,
          sourceTerminalReportSourceHash,
        ),
      }),
      (error: unknown) =>
        error instanceof StoreError && error.code === "technical_restart.parent_forbidden",
    );
  });

  await contextTest.test(
    "source can have only one authoritative replacement",
    async (subcontext) => {
      const sourceRunId = "technical-restart-duplicate-source";
      const {
        setup,
        sourceManifestHash,
        sourceTerminalReportSourceRef,
        sourceTerminalReportSourceHash,
      } = await terminalRuntimeFailureSource(subcontext, sourceRunId);
      await setup.store.create({
        runId: "technical-restart-first-replacement",
        mode: "opportunity_discovery",
        createdAt: "2026-07-25T00:31:00Z",
        scopeProposal: sameSyntheticScopeProposal(),
        technicalRestart: technicalRestartDeclaration(
          sourceRunId,
          sourceManifestHash,
          sourceTerminalReportSourceRef,
          sourceTerminalReportSourceHash,
        ),
      });
      await assert.rejects(
        setup.store.create({
          runId: "technical-restart-second-replacement",
          mode: "opportunity_discovery",
          createdAt: "2026-07-25T00:32:00Z",
          scopeProposal: sameSyntheticScopeProposal(),
          technicalRestart: technicalRestartDeclaration(
            sourceRunId,
            sourceManifestHash,
            sourceTerminalReportSourceRef,
            sourceTerminalReportSourceHash,
          ),
        }),
        (error: unknown) =>
          error instanceof StoreError && error.code === "technical_restart.source_already_replaced",
      );
    },
  );
});

test("technical restart serializes concurrent replacement attempts on one source Run", async (contextTest) => {
  const sourceRunId = "technical-restart-concurrent-source";
  const {
    setup,
    sourceManifestHash,
    sourceTerminalReportSourceRef,
    sourceTerminalReportSourceHash,
  } = await terminalRuntimeFailureSource(contextTest, sourceRunId);
  const declaration = technicalRestartDeclaration(
    sourceRunId,
    sourceManifestHash,
    sourceTerminalReportSourceRef,
    sourceTerminalReportSourceHash,
  );
  const firstRunId = "technical-restart-concurrent-first";
  const secondRunId = "technical-restart-concurrent-second";
  const results = await Promise.allSettled([
    setup.store.create({
      runId: firstRunId,
      mode: "opportunity_discovery",
      createdAt: "2026-07-25T00:33:00Z",
      scopeProposal: sameSyntheticScopeProposal(),
      technicalRestart: declaration,
    }),
    setup.store.create({
      runId: secondRunId,
      mode: "opportunity_discovery",
      createdAt: "2026-07-25T00:33:30Z",
      scopeProposal: sameSyntheticScopeProposal(),
      technicalRestart: declaration,
    }),
  ]);
  const fulfilled = results.find((result) => result.status === "fulfilled");
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(fulfilled && fulfilled.status === "fulfilled", JSON.stringify(results, null, 2));
  assert.ok(rejected && rejected.status === "rejected", JSON.stringify(results, null, 2));
  const winnerRunId = (fulfilled.value as { runId: string }).runId;
  const loserRunId = winnerRunId === firstRunId ? secondRunId : firstRunId;
  const loserReason = rejected.reason as unknown;
  assert.ok(
    loserReason instanceof StoreError &&
      [
        "technical_restart.source_already_replaced",
        "technical_restart.declaration_conflict",
      ].includes(loserReason.code),
    JSON.stringify(loserReason, null, 2),
  );
  assert.equal(
    (await setup.store.status(sourceRunId)).derivedExecutionDisposition,
    "superseded_by_new_attempt",
  );
  assert.deepEqual((await setup.store.status(sourceRunId)).technicalRestartReplacementRunIds, [
    winnerRunId,
  ]);
  assert.equal((await setup.store.status(winnerRunId)).derivedExecutionDisposition, "current");
  await assert.rejects(
    setup.store.status(loserRunId),
    (error: unknown) => error instanceof StoreError && error.code === "run.not_found",
  );
});

test("technical restart fails closed when either side of the closure is deleted or tampered", async (contextTest) => {
  for (const scenario of [
    {
      name: "source receipt deleted",
      mutate: async (sourceReceiptPath: string, _projectionPath: string) => {
        await rm(sourceReceiptPath, { force: true });
      },
      expectedIssue: "technical_restart.source_receipt_missing",
    },
    {
      name: "source receipt directory deleted",
      mutate: async (sourceReceiptPath: string, _projectionPath: string) => {
        await rm(path.dirname(sourceReceiptPath), { recursive: true, force: true });
      },
      expectedIssue: "technical_restart.source_receipt_missing",
    },
    {
      name: "sources tree deleted",
      mutate: async (sourceReceiptPath: string, _projectionPath: string) => {
        await rm(path.dirname(path.dirname(sourceReceiptPath)), {
          recursive: true,
          force: true,
        });
      },
      expectedIssue: "technical_restart.source_receipt_missing",
    },
    {
      name: "replacement projection deleted",
      mutate: async (_sourceReceiptPath: string, projectionPath: string) => {
        await rm(projectionPath, { force: true });
      },
      expectedIssue: "technical_restart.replacement_projection_missing",
    },
    {
      name: "replacement projection tampered",
      mutate: async (_sourceReceiptPath: string, projectionPath: string) => {
        const entry = JSON.parse(await readFile(projectionPath, "utf8")) as Record<string, unknown>;
        entry.source_manifest_hash = sha256Bytes("tampered technical restart projection");
        await writeFile(projectionPath, `${canonicalJson(entry)}\n`);
      },
      expectedIssue: "technical_restart.replacement_projection_mismatch",
    },
  ] as const) {
    await contextTest.test(scenario.name, async (subcontext) => {
      const sourceRunId = `technical-restart-${scenario.name.replaceAll(" ", "-")}-source`;
      const replacementRunId = `technical-restart-${scenario.name.replaceAll(" ", "-")}-new-attempt`;
      const {
        setup,
        sourceManifestHash,
        sourceTerminalReportSourceRef,
        sourceTerminalReportSourceHash,
      } = await terminalRuntimeFailureSource(subcontext, sourceRunId, true);
      await setup.store.create({
        runId: replacementRunId,
        mode: "opportunity_discovery",
        createdAt: "2026-07-25T00:36:00Z",
        scopeProposal: sameSyntheticScopeProposal(),
        technicalRestart: technicalRestartDeclaration(
          sourceRunId,
          sourceManifestHash,
          sourceTerminalReportSourceRef,
          sourceTerminalReportSourceHash,
        ),
      });
      const sourceReceiptPath = path.join(
        setup.runsRoot,
        ".technical-restarts",
        "sources",
        sourceRunId,
        `${replacementRunId}.json`,
      );
      const projectionPath = path.join(
        setup.runsRoot,
        ".technical-restarts",
        "replacements",
        `${replacementRunId}.json`,
      );
      await scenario.mutate(sourceReceiptPath, projectionPath);
      const status = await setup.store.status(sourceRunId);
      assert.equal(status.derivedExecutionDisposition, "indeterminate");
      assert.deepEqual(status.technicalRestartReplacementRunIds, [replacementRunId]);
      assert.ok(
        status.executionResolutionIssues.some((issue) => issue.startsWith(scenario.expectedIssue)),
        JSON.stringify(status.executionResolutionIssues, null, 2),
      );
      await assert.rejects(
        setup.store.load(sourceRunId),
        (error: unknown) =>
          error instanceof StoreError && error.code === "run.continuation_indeterminate",
      );
    });
  }
});

test("technical restart rejects symlinked source and replacement parent directories", async (contextTest) => {
  for (const scenario of [
    {
      name: "source directory symlink",
      mutate: async (runsRoot: string, outside: string) => {
        await rm(path.join(runsRoot, ".technical-restarts", "sources"), {
          recursive: true,
          force: true,
        });
        await symlink(outside, path.join(runsRoot, ".technical-restarts", "sources"));
      },
      expectReject: true,
    },
    {
      name: "replacement directory symlink",
      mutate: async (runsRoot: string, outside: string) => {
        await rm(path.join(runsRoot, ".technical-restarts", "replacements"), {
          recursive: true,
          force: true,
        });
        await symlink(outside, path.join(runsRoot, ".technical-restarts", "replacements"));
      },
      expectReject: true,
    },
  ] as const) {
    await contextTest.test(scenario.name, async (subcontext) => {
      const sourceRunId = `technical-restart-${scenario.name.replaceAll(" ", "-")}-source`;
      const replacementRunId = `technical-restart-${scenario.name.replaceAll(" ", "-")}-new-attempt`;
      const {
        setup,
        sourceManifestHash,
        sourceTerminalReportSourceRef,
        sourceTerminalReportSourceHash,
      } = await terminalRuntimeFailureSource(subcontext, sourceRunId, true);
      await setup.store.create({
        runId: replacementRunId,
        mode: "opportunity_discovery",
        createdAt: "2026-07-25T00:37:00Z",
        scopeProposal: sameSyntheticScopeProposal(),
        technicalRestart: technicalRestartDeclaration(
          sourceRunId,
          sourceManifestHash,
          sourceTerminalReportSourceRef,
          sourceTerminalReportSourceHash,
        ),
      });
      const outside = await mkdtemp(
        path.join(tmpdir(), "startup-opportunity-tech-restart-symlink-"),
      );
      subcontext.after(() => rm(outside, { recursive: true, force: true }));
      await scenario.mutate(setup.runsRoot, outside);
      if (scenario.expectReject) {
        await assert.rejects(
          setup.store.status(sourceRunId),
          (error: unknown) => error instanceof StoreError && error.code === "path.symlink_escape",
        );
      } else {
        const status = await setup.store.status(sourceRunId);
        assert.equal(status.derivedExecutionDisposition, "indeterminate");
        assert.ok(
          status.executionResolutionIssues.some(
            (issue) =>
              issue.startsWith("technical_restart.index_unreadable") ||
              issue.startsWith("technical_restart.replacement_projection_unreadable"),
          ),
          JSON.stringify(status.executionResolutionIssues, null, 2),
        );
      }
    });
  }
});

test("technical restart status fails closed on corrupt or pending restart indexes", async (contextTest) => {
  for (const scenario of [
    {
      name: "corrupt",
      expectedIssue: "technical_restart.index_entry_invalid",
      mutate: async (indexPath: string) => {
        await writeFile(indexPath, `${canonicalJson({ not_schema_valid: true })}\n`);
      },
    },
    {
      name: "pending",
      expectedIssue: "technical_restart.index_pending",
      mutate: async (indexPath: string) => {
        const entry = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>;
        entry.state = "pending";
        await writeFile(indexPath, `${canonicalJson(entry)}\n`);
      },
    },
  ] as const) {
    await contextTest.test(scenario.name, async (subcontext) => {
      const sourceRunId = `technical-restart-${scenario.name}-index-source`;
      const replacementRunId = `technical-restart-${scenario.name}-index-replacement`;
      const {
        setup,
        sourceManifestHash,
        sourceTerminalReportSourceRef,
        sourceTerminalReportSourceHash,
      } = await terminalRuntimeFailureSource(subcontext, sourceRunId);
      await setup.store.create({
        runId: replacementRunId,
        mode: "opportunity_discovery",
        createdAt: "2026-07-25T00:40:00Z",
        scopeProposal: sameSyntheticScopeProposal(),
        technicalRestart: technicalRestartDeclaration(
          sourceRunId,
          sourceManifestHash,
          sourceTerminalReportSourceRef,
          sourceTerminalReportSourceHash,
        ),
      });
      await scenario.mutate(
        path.join(
          setup.runsRoot,
          ".technical-restarts",
          "sources",
          sourceRunId,
          `${replacementRunId}.json`,
        ),
      );
      const status = await setup.store.status(sourceRunId);
      assert.equal(status.derivedExecutionDisposition, "indeterminate");
      assert.equal(status.currentLeafRunId, null);
      assert.deepEqual(status.technicalRestartReplacementRunIds, [replacementRunId]);
      assert.ok(
        status.executionResolutionIssues.some((issue) => issue.startsWith(scenario.expectedIssue)),
        JSON.stringify(status.executionResolutionIssues, null, 2),
      );
    });
  }
});

test("runtime failure alone may close with a disclosed missing Search Closure", async (contextTest) => {
  await contextTest.test("strict runtime-failure closure is ready", async (subcontext) => {
    const runId = "runtime-failure-before-search-closure";
    const setup = await setupPersistedRun(subcontext, runId, "runtime-failure");
    await publishRuntimeEnvelopesAsFormalStage(
      setup,
      incompleteExecutionWaveEnvelopes(runId, setup.plan),
      `request_g0_4_incomplete_runtime_${runId}`,
    ).catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
      }
      throw error;
    });
    const terminal = await prepareTerminalReporting(setup, true);
    const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
    await runtime.apply({
      runId,
      adaptationBundle: terminal.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      terminalReportEnvelope: terminal.reportEnvelope,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Disclose the runtime failure and repair it only in a new Run.",
      beliefSummary: {
        current_belief: "The runtime failed before the planned lane could publish Search Closure.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Can the repaired runtime execute a new Run?",
      },
    });
    const status = await setup.store.status(runId);
    assert.equal(status.terminalReportDisposition, "ready", JSON.stringify(status, null, 2));
    assert.deepEqual(status.terminalReportIssues, []);
    const report = JSON.parse(
      await readFile(path.join(setup.runRoot, "report.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.ok(
      (report.gate_warnings as Record<string, unknown>[]).some(
        (warning) => warning.code === "terminal_reporting.search_closure_incomplete",
      ),
    );

    const manifestPath = path.join(setup.runRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.applied_adaptation_refs = [];
    await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
    const corrupted = await setup.store.status(runId);
    assert.equal(corrupted.terminalReportDisposition, "invalid");
    assert.ok(
      corrupted.terminalReportIssues.includes("terminal_reporting.search_closure_incomplete"),
    );
  });

  await contextTest.test(
    "evidence closeout cannot use the runtime exception",
    async (subcontext) => {
      const runId = "insufficient-evidence-before-search-closure";
      const setup = await setupPersistedRun(subcontext, runId, "terminate");
      await publishRuntimeEnvelopesAsFormalStage(
        setup,
        incompleteExecutionWaveEnvelopes(runId, setup.plan),
        `request_g0_4_incomplete_runtime_${runId}`,
      );
      const terminal = await prepareTerminalReporting(setup);
      const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
      await runtime.apply({
        runId,
        adaptationBundle: terminal.adaptationBundle,
        adaptationRefs: [DECISION_REF],
        terminalReportEnvelope: terminal.reportEnvelope,
        createdAt: "2026-07-24T12:08:00Z",
        checkpointCreatedAt: "2026-07-24T12:09:00Z",
        nextStep: "Retain the unresolved Search Closure requirement.",
        beliefSummary: {
          current_belief:
            "Evidence is insufficient and the planned Search Closure is also missing.",
          evidence_that_changed_belief: [],
          unchanged_assumptions: [],
          remaining_disagreement: [],
          next_decision_relevant_question: "What bounded research remains necessary?",
        },
      });
      const status = await setup.store.status(runId);
      assert.equal(status.terminalReportDisposition, "invalid");
      assert.ok(
        status.terminalReportIssues.includes("terminal_reporting.search_closure_incomplete"),
      );
    },
  );
});

test("runtime failure closes active discovery units after launch registration", async (contextTest) => {
  const runId = "runtime-failure-active-discovery";
  const setup = await setupPersistedRun(contextTest, runId, "runtime-failure");
  const launchEnvelopes = incompleteExecutionWaveEnvelopes(runId, setup.plan);
  const dispatchEnvelope = launchEnvelopes.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(dispatchEnvelope);
  await publishRuntimeEnvelopesAsFormalStage(
    setup,
    launchEnvelopes,
    `request_g0_4_runtime_launch_${runId}`,
  );
  await registerRuntimeLaunch(setup, dispatchEnvelope, "2026-07-24T12:07:18Z");

  const preStatus = await setup.store.status(runId);
  assert.deepEqual([...preStatus.manifest.active_units].sort(), ["buyer_active", "value_pending"]);
  assert.equal(preStatus.observability.laneTimings.length, 1);
  assert.equal(preStatus.observability.laneTimings[0]?.unitId, "value_pending");
  assert.equal(preStatus.observability.laneTimings[0]?.state, "agent_started");
  assert.equal(preStatus.observability.laneTimings[0]?.endedAt, null);

  const terminal = await prepareTerminalReporting(setup, true);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = terminalApplyInput(
    setup,
    terminal,
    "The runtime failure prevents a research conclusion.",
  );
  const applied = await runtime.apply(input);
  assert.equal(applied.status, "applied");
  assert.equal(applied.terminalReport?.status, "published");
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");

  const status = await setup.store.status(runId);
  assert.equal(status.manifest.status, "failed");
  assert.deepEqual(status.manifest.active_units, []);
  assert.ok(status.manifest.failed_units.includes("buyer_active"));
  assert.ok(status.manifest.failed_units.includes("value_pending"));
  assert.deepEqual(status.manifest.pending_adaptation_refs, []);
  assert.equal(status.terminalReportDisposition, "ready", JSON.stringify(status, null, 2));
  assert.equal(status.resumeContext.status, "failed");
  assert.equal(status.observability.laneTimings.length, 1);
  assert.equal(status.observability.laneTimings[0]?.unitId, "value_pending");
  assert.equal(status.observability.laneTimings[0]?.state, "failed");
  assert.equal(status.observability.laneTimings[0]?.endedAt, "2026-07-24T12:08:00Z");
  assert.equal(status.observability.laneTimings[0]?.durationMs, 43_000);
  assert.equal(status.observability.stageTimings.length, 1, JSON.stringify(status, null, 2));
  assert.equal(status.observability.stageTimings[0]?.stageId, "stage_incomplete_runtime");
  assert.equal(status.observability.stageTimings[0]?.state, "failed");
  assert.equal(status.observability.stageTimings[0]?.failureKind, "runtime_blocked");
  assert.equal(status.observability.stageTimings[0]?.endedAt, "2026-07-24T12:08:00Z");
  assert.equal(status.observability.stageTimings[0]?.durationMs, 43_000);
  assert.equal(status.observability.failureClassifications.runtime_blocked, 2);

  const publishedEnvelopes = await Promise.all(
    status.manifest.artifact_refs.map(
      async (artifactRef) =>
        JSON.parse(
          await readFile(path.join(setup.runRoot, artifactRef), "utf8"),
        ) as FormalArtifactEnvelope,
    ),
  );
  const lifecycleHistory = publishedEnvelopes
    .filter((envelope) => envelope.artifact_type === "startup_opportunity.lane_lifecycle.v1")
    .sort((left, right) => Number(left.document.revision) - Number(right.document.revision));
  assert.equal(lifecycleHistory.length, 2, JSON.stringify(lifecycleHistory, null, 2));
  const lifecycleRoot = lifecycleHistory[0];
  const lifecycleCloseout = lifecycleHistory[1];
  assert.ok(lifecycleRoot);
  assert.ok(lifecycleCloseout);
  assert.equal(lifecycleRoot.document.state, "agent_started");
  assert.equal(lifecycleRoot.document.failure, null);
  assert.equal(
    lifecycleCloseout.artifact_path,
    canonicalLaneLifecyclePath(lifecycleCloseout.document, 2),
  );
  assert.equal(lifecycleCloseout.document.revision, 2);
  assert.equal(
    lifecycleCloseout.document.parent_lifecycle_ref,
    canonicalLaneLifecyclePath(lifecycleCloseout.document, 1),
  );
  for (const field of [
    "lifecycle_id",
    "run_id",
    "unit_id",
    "attempt",
    "execution_attempt_id",
    "dispatch_batch_ref",
    "dispatch_batch_hash",
    "task_ref",
    "task_id",
    "launch_registration_ref",
    "launch_registration_id",
    "launch_registration_hash",
  ] as const) {
    assert.equal(lifecycleCloseout.document[field], lifecycleRoot.document[field], field);
  }
  assert.equal(lifecycleCloseout.document.state, "failed");
  assert.deepEqual(lifecycleCloseout.document.failure, {
    kind: "runtime_blocked",
    detail: (lifecycleCloseout.document.failure as Record<string, unknown>).detail,
    retryable: false,
  });
  assert.equal(
    (lifecycleCloseout.document.timestamps as Record<string, unknown>).ended_at,
    "2026-07-24T12:08:00Z",
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
  assert.equal(stageCloseout.created_at, "2026-07-24T12:08:00Z");
  assert.equal(stageCloseout.producer_role, "harness");
  assert.equal(stageCloseout.document.stage_id, "stage_incomplete_runtime");
  assert.equal(stageCloseout.document.stage_state, "failed");
  assert.equal((stageCloseout.document.failure as Record<string, unknown>).kind, "runtime_blocked");
  assert.equal((stageCloseout.document.failure as Record<string, unknown>).retryable, false);
  assert.deepEqual(stageCloseout.document.started_unit_ids, ["value_pending"]);
  assert.deepEqual(stageCloseout.document.completed_unit_ids, []);
  assert.deepEqual(stageCloseout.document.failed_unit_ids, ["value_pending"]);
  assert.deepEqual(stageCloseout.document.incomplete_unit_ids, ["value_pending"]);
  assert.deepEqual(stageCloseout.document.not_started_unit_ids, []);
  const dispositions = stageCloseout.document.unit_dispositions as Record<string, unknown>[];
  assert.equal(dispositions.length, 1, JSON.stringify(stageCloseout, null, 2));
  assert.equal(dispositions[0]?.unit_id, "value_pending");
  assert.equal(dispositions[0]?.disposition, "runtime_failed");
  assert.equal(dispositions[0]?.lifecycle_ref, lifecycleCloseout.artifact_path);
  assert.equal(dispositions[0]?.lifecycle_hash, lifecycleCloseout.content_hash);
  const basisRefs = stageCloseout.document.basis_refs as string[];
  assert.ok(basisRefs.includes(DECISION_REF), JSON.stringify(stageCloseout, null, 2));
  assert.ok(
    basisRefs.includes(`${GAP_REF}#gap_runtime_001`),
    JSON.stringify(stageCloseout, null, 2),
  );
  assert.equal(
    (stageCloseout.document.failure as Record<string, unknown>).detail,
    (lifecycleCloseout.document.failure as Record<string, unknown>).detail,
  );
  assert.equal(
    publishedEnvelopes.filter(
      (envelope) =>
        envelope.artifact_type === "startup_opportunity.discovery_stage_readiness.v1" &&
        envelope.document.stop_basis === "runtime_blocked",
    ).length,
    0,
  );
});

test("status scopes duplicate stage ids by execution plan and dispatch", async (contextTest) => {
  const runId = "runtime-failure-stage-timing-exact-key";
  const setup = await setupPersistedRun(contextTest, runId, "runtime-failure");
  const manifestPath = path.join(setup.runRoot, "manifest.json");
  const mutableManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  mutableManifest.active_units = [];
  mutableManifest.updated_at = "2026-07-24T12:06:30Z";
  await writeFile(manifestPath, `${canonicalJson(mutableManifest)}\n`);

  const firstWave = incompleteExecutionWaveEnvelopes(runId, setup.plan);
  await publishRuntimeEnvelopesAsFormalStage(
    setup,
    firstWave,
    `request_g0_4_duplicate_stage_r1_${runId}`,
  );
  const firstExecution = firstWave.find(
    (envelope) =>
      envelope.artifact_type === "startup_opportunity.research_execution_plan.discovery.current",
  );
  const firstDispatch = firstWave.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(firstExecution);
  assert.ok(firstDispatch);

  const secondWave = retargetIncompleteExecutionWave(runId, setup.plan, {
    unitId: "buyer_active",
    executionRevision: 2,
    parentExecutionPlanRef: firstExecution.artifact_path,
    dispatchPath: "tasks/dispatch/incomplete-runtime-r2.r1.json",
    taskReadyAt: "2026-07-24T12:07:40Z",
    dispatchRequestedAt: "2026-07-24T12:07:45Z",
  });
  await publishRuntimeEnvelopesAsFormalStage(
    setup,
    secondWave,
    `request_g0_4_duplicate_stage_r2_${runId}`,
  );
  const secondDispatch = secondWave.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(secondDispatch);
  await registerRuntimeLaunch(setup, secondDispatch, "2026-07-24T12:07:50Z");

  const preStatus = await setup.store.status(runId);
  const preFirstStage = preStatus.observability.stageTimings.find(
    (timing) =>
      timing.executionPlanRef === "plans/research-execution.r1.json" &&
      timing.stageId === "stage_incomplete_runtime",
  );
  const preSecondStage = preStatus.observability.stageTimings.find(
    (timing) =>
      timing.executionPlanRef === "plans/research-execution.r2.json" &&
      timing.stageId === "stage_incomplete_runtime",
  );
  assert.ok(preFirstStage, JSON.stringify(preStatus.observability.stageTimings, null, 2));
  assert.ok(preSecondStage, JSON.stringify(preStatus.observability.stageTimings, null, 2));
  assert.equal(preFirstStage.state, "active");
  assert.equal(preFirstStage.endedAt, null);
  assert.equal(preSecondStage.state, "active");
  assert.equal(preSecondStage.endedAt, null);

  const terminal = await prepareTerminalReporting(setup, true);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const applied = await runtime.apply(
    terminalApplyInput(
      setup,
      terminal,
      "The runtime failure closes duplicate stage ids through PlanRuntime authority.",
    ),
  );
  assert.equal(applied.status, "applied");

  const status = await setup.store.status(runId);
  const firstStage = status.observability.stageTimings.find(
    (timing) =>
      timing.executionPlanRef === "plans/research-execution.r1.json" &&
      timing.stageId === "stage_incomplete_runtime",
  );
  const secondStage = status.observability.stageTimings.find(
    (timing) =>
      timing.executionPlanRef === "plans/research-execution.r2.json" &&
      timing.stageId === "stage_incomplete_runtime",
  );
  assert.ok(firstStage, JSON.stringify(status.observability.stageTimings, null, 2));
  assert.ok(secondStage, JSON.stringify(status.observability.stageTimings, null, 2));
  assert.equal(firstStage.state, "failed");
  assert.equal(firstStage.failureKind, "runtime_blocked");
  assert.equal(firstStage.endedAt, "2026-07-24T12:08:00Z");
  assert.equal(firstStage.durationMs, 43_000);
  assert.equal(secondStage.state, "failed");
  assert.equal(secondStage.failureKind, "runtime_blocked");
  assert.equal(secondStage.endedAt, "2026-07-24T12:08:00Z");
  assert.equal(secondStage.durationMs, 15_000);
  const publishedEnvelopes = await Promise.all(
    status.manifest.artifact_refs.map(
      async (artifactRef) =>
        JSON.parse(
          await readFile(path.join(setup.runRoot, artifactRef), "utf8"),
        ) as FormalArtifactEnvelope,
    ),
  );
  const stageCloseouts = publishedEnvelopes.filter(
    (envelope) => envelope.artifact_type === "startup_opportunity.execution_stage_closeout.v1",
  );
  assert.equal(stageCloseouts.length, 2, JSON.stringify(stageCloseouts, null, 2));
  const firstCloseout = stageCloseouts.find(
    (envelope) => envelope.document.dispatch_ref === firstDispatch.artifact_path,
  );
  const secondCloseout = stageCloseouts.find(
    (envelope) => envelope.document.dispatch_ref === secondDispatch.artifact_path,
  );
  assert.ok(firstCloseout, JSON.stringify(stageCloseouts, null, 2));
  assert.ok(secondCloseout, JSON.stringify(stageCloseouts, null, 2));
  assert.notEqual(firstCloseout.artifact_path, secondCloseout.artifact_path);
  assert.equal(firstCloseout.document.execution_plan_ref, firstExecution.artifact_path);
  assert.equal(secondCloseout.document.execution_plan_ref, "plans/research-execution.r2.json");
  assert.equal(firstCloseout.document.stage_id, secondCloseout.document.stage_id);
  assert.equal(firstCloseout.document.dispatch_ref, firstDispatch.artifact_path);
  assert.equal(secondCloseout.document.dispatch_ref, secondDispatch.artifact_path);
  assert.equal(firstCloseout.document.ended_at, "2026-07-24T12:08:00Z");
  assert.equal(secondCloseout.document.ended_at, "2026-07-24T12:08:00Z");
  assert.deepEqual(firstCloseout.document.not_started_unit_ids, ["value_pending"]);
  assert.deepEqual(secondCloseout.document.failed_unit_ids, ["buyer_active"]);
});

test("generic Store and CLI entries reject PlanRuntime runtime failure closeouts", async (contextTest) => {
  const runId = "runtime-failure-closeout-public-entry-guard";
  const setup = await setupPersistedRun(contextTest, runId, "runtime-failure");
  const launchEnvelopes = incompleteExecutionWaveEnvelopes(runId, setup.plan);
  const dispatchEnvelope = launchEnvelopes.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(dispatchEnvelope);
  await publishRuntimeEnvelopesAsFormalStage(
    setup,
    launchEnvelopes,
    `request_g0_4_closeout_entry_guard_${runId}`,
  );
  await registerRuntimeLaunch(setup, dispatchEnvelope, "2026-07-24T12:07:18Z");
  const terminal = await prepareTerminalReporting(setup, true);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = terminalApplyInput(
    setup,
    terminal,
    "The runtime failure prepares closeouts that only PlanRuntime may publish.",
  );
  await assert.rejects(
    runtime.apply({ ...input, faultAt: "after_intent" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );

  const receipt = JSON.parse(
    await readFile(await planReceiptFile(setup.runRoot), "utf8"),
  ) as Record<string, unknown>;
  const closeouts = (receipt.control_envelopes as FormalArtifactEnvelope[]).filter(
    (envelope) =>
      envelope.artifact_type === "startup_opportunity.execution_stage_closeout.v1" ||
      (envelope.artifact_type === "startup_opportunity.lane_lifecycle.v1" &&
        envelope.document.state === "failed" &&
        isRecord(envelope.document.failure) &&
        envelope.document.failure.kind === "runtime_blocked"),
  );
  assert.ok(closeouts.length >= 2, JSON.stringify(receipt, null, 2));
  const singleCloseout = closeouts[0] as FormalArtifactEnvelope;
  const closeoutBundle = closeouts.slice(0, 2);
  const artifactStore = new ArtifactStore(setup.runsRoot, setup.validator);
  const beforeAttempts = await snapshotRunTree(setup.runRoot);
  const expectDedicatedEntry = (error: unknown): boolean =>
    error instanceof StoreError && error.code === "artifact.plan_runtime_closeout_entry_required";

  await assert.rejects(
    setup.store.publishArtifact({ runId, envelope: singleCloseout }),
    expectDedicatedEntry,
  );
  await assert.rejects(
    setup.store.publishArtifactBundle({ runId, envelopes: closeoutBundle }),
    expectDedicatedEntry,
  );
  await assert.rejects(
    artifactStore.publish({ runId, envelope: singleCloseout }),
    expectDedicatedEntry,
  );
  await assert.rejects(
    artifactStore.publishBundle({ runId, envelopes: closeoutBundle }),
    expectDedicatedEntry,
  );
  await assert.rejects(
    artifactStore.publishLocked(setup.runRoot, { runId, envelope: singleCloseout }),
    expectDedicatedEntry,
  );
  await assert.rejects(
    artifactStore.publishBundleLocked(setup.runRoot, { runId, envelopes: closeoutBundle }),
    expectDedicatedEntry,
  );

  const singleFile = path.join(setup.root, "runtime-closeout-single.json");
  await writeFile(singleFile, `${canonicalJson(singleCloseout)}\n`);
  const cliSingle = runScript("harness/src/cli.ts", [
    "publish-artifact",
    "--file",
    singleFile,
    "--runs-root",
    setup.runsRoot,
  ]);
  assert.equal(cliSingle.status, 1, cliSingle.stderr || cliSingle.stdout);
  assert.match(cliSingle.stderr, /artifact\.plan_runtime_closeout_entry_required/u);

  const bundleFile = path.join(setup.root, "runtime-closeout-bundle.json");
  await writeFile(
    bundleFile,
    `${canonicalJson({
      schema_version: "startup_opportunity.document_bundle.current",
      documents: closeoutBundle.map((envelope) => ({
        path: envelope.artifact_path,
        document: envelope,
      })),
      exact_records: [],
    })}\n`,
  );
  const cliBundle = runScript("harness/src/cli.ts", [
    "publish-artifact",
    "--file",
    bundleFile,
    "--runs-root",
    setup.runsRoot,
  ]);
  assert.equal(cliBundle.status, 1, cliBundle.stderr || cliBundle.stdout);
  assert.match(cliBundle.stderr, /artifact\.plan_runtime_closeout_entry_required/u);
  assert.deepEqual(await snapshotRunTree(setup.runRoot), beforeAttempts);
});

test("runtime failure lane and stage closeout recover through every Plan fault boundary", async (contextTest) => {
  for (const [index, faultAt] of (
    [
      "after_intent",
      "after_control_artifacts",
      "after_manifest_update",
      "after_checkpoint_publish",
    ] as const
  ).entries()) {
    await contextTest.test(faultAt, async (subcontext) => {
      const runId = `runtime-failure-closeout-fault-${String(index + 1)}`;
      const setup = await setupPersistedRun(subcontext, runId, "runtime-failure");
      const launchEnvelopes = incompleteExecutionWaveEnvelopes(runId, setup.plan);
      const dispatchEnvelope = launchEnvelopes.find(
        (envelope) =>
          envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
      );
      assert.ok(dispatchEnvelope);
      await publishRuntimeEnvelopesAsFormalStage(
        setup,
        launchEnvelopes,
        `request_g0_4_runtime_fault_${runId}`,
      );
      await registerRuntimeLaunch(setup, dispatchEnvelope, "2026-07-24T12:07:18Z");

      const terminal = await prepareTerminalReporting(setup, true);
      const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
      const input = terminalApplyInput(
        setup,
        terminal,
        "The runtime failure prevents a research conclusion.",
      );
      await assert.rejects(
        runtime.apply({ ...input, faultAt }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      const interrupted = await setup.store.status(runId);
      if (faultAt === "after_intent") {
        assert.equal(interrupted.manifest.status, "researching", faultAt);
        assert.equal(interrupted.observability.laneTimings[0]?.state, "agent_started", faultAt);
        assert.equal(interrupted.observability.laneTimings[0]?.endedAt, null, faultAt);
      } else if (faultAt === "after_control_artifacts") {
        assert.equal(interrupted.manifest.status, "researching", faultAt);
        assert.equal(interrupted.observability.laneTimings[0]?.state, "agent_started", faultAt);
        assert.equal(interrupted.observability.laneTimings[0]?.endedAt, null, faultAt);
        assert.equal(interrupted.observability.stageTimings[0]?.state, "active", faultAt);
        assert.equal(interrupted.observability.stageTimings[0]?.failureKind, null, faultAt);
        assert.equal(interrupted.observability.stageTimings[0]?.endedAt, null, faultAt);
        assert.equal(interrupted.terminalReportDisposition, "not_required", faultAt);
      } else {
        assert.equal(interrupted.manifest.status, "failed", faultAt);
        assert.equal(interrupted.observability.laneTimings[0]?.state, "failed", faultAt);
        assert.equal(
          interrupted.observability.stageTimings[0]?.failureKind,
          "runtime_blocked",
          faultAt,
        );
        assert.equal(interrupted.terminalReportDisposition, "ready", faultAt);
      }

      await setup.store.load(runId);
      const replay = await runtime.apply(input);
      assert.equal(replay.status, "idempotent_replay");
      const status = await setup.store.status(runId);
      assert.equal(status.manifest.status, "failed", JSON.stringify(status, null, 2));
      assert.deepEqual(status.manifest.active_units, [], JSON.stringify(status, null, 2));
      assert.equal(status.observability.laneTimings[0]?.state, "failed");
      assert.equal(status.observability.laneTimings[0]?.endedAt, "2026-07-24T12:08:00Z");
      assert.equal(status.observability.stageTimings[0]?.state, "failed");
      assert.equal(status.observability.stageTimings[0]?.failureKind, "runtime_blocked");
      assert.equal(status.observability.stageTimings[0]?.endedAt, "2026-07-24T12:08:00Z");
      assert.equal(status.terminalReportDisposition, "ready", JSON.stringify(status, null, 2));

      const publishedEnvelopes = await Promise.all(
        status.manifest.artifact_refs.map(
          async (artifactRef) =>
            JSON.parse(
              await readFile(path.join(setup.runRoot, artifactRef), "utf8"),
            ) as FormalArtifactEnvelope,
        ),
      );
      const lifecycleRevisions = publishedEnvelopes
        .filter((envelope) => envelope.artifact_type === "startup_opportunity.lane_lifecycle.v1")
        .map((envelope) => Number(envelope.document.revision))
        .sort((left, right) => left - right);
      assert.deepEqual(lifecycleRevisions, [1, 2], JSON.stringify(lifecycleRevisions));
      assert.equal(
        publishedEnvelopes.filter(
          (envelope) =>
            envelope.artifact_type === "startup_opportunity.execution_stage_closeout.v1",
        ).length,
        1,
      );
    });
  }
});

test("runtime failure receipt rejects tampered derived closeout bytes before recovery writes", async (contextTest) => {
  const scenarios: readonly {
    readonly name: string;
    readonly mutate: (
      receipt: Record<string, unknown>,
      controlEnvelopes: Record<string, unknown>[],
    ) => void;
  }[] = [
    {
      name: "lifecycle-detail",
      mutate: (_receipt, controlEnvelopes) => {
        const lifecycle = controlEnvelopes.find(
          (envelope) => envelope.artifact_type === "startup_opportunity.lane_lifecycle.v1",
        );
        assert.ok(isRecord(lifecycle?.document));
        const failure = lifecycle.document.failure as Record<string, unknown>;
        failure.detail = `${String(failure.detail)} forged`;
      },
    },
    {
      name: "lifecycle-ended-at",
      mutate: (_receipt, controlEnvelopes) => {
        const lifecycle = controlEnvelopes.find(
          (envelope) => envelope.artifact_type === "startup_opportunity.lane_lifecycle.v1",
        );
        assert.ok(isRecord(lifecycle?.document));
        const timestamps = lifecycle.document.timestamps as Record<string, unknown>;
        timestamps.ended_at = "2026-07-24T12:08:01Z";
      },
    },
    {
      name: "stage-detail",
      mutate: (_receipt, controlEnvelopes) => {
        const closeout = controlEnvelopes.find(
          (envelope) =>
            envelope.artifact_type === "startup_opportunity.execution_stage_closeout.v1",
        );
        assert.ok(isRecord(closeout?.document));
        const failure = closeout.document.failure as Record<string, unknown>;
        failure.detail = `${String(failure.detail)} forged`;
      },
    },
    {
      name: "stage-ended-at",
      mutate: (_receipt, controlEnvelopes) => {
        const closeout = controlEnvelopes.find(
          (envelope) =>
            envelope.artifact_type === "startup_opportunity.execution_stage_closeout.v1",
        );
        assert.ok(isRecord(closeout?.document));
        closeout.document.ended_at = "2026-07-24T12:08:01Z";
      },
    },
    {
      name: "stage-basis",
      mutate: (_receipt, controlEnvelopes) => {
        const closeout = controlEnvelopes.find(
          (envelope) =>
            envelope.artifact_type === "startup_opportunity.execution_stage_closeout.v1",
        );
        assert.ok(isRecord(closeout?.document));
        closeout.document.basis_refs = (closeout.document.basis_refs as string[]).filter(
          (ref) => ref !== `${GAP_REF}#gap_runtime_001`,
        );
      },
    },
    {
      name: "stage-lifecycle-hash",
      mutate: (_receipt, controlEnvelopes) => {
        const closeout = controlEnvelopes.find(
          (envelope) =>
            envelope.artifact_type === "startup_opportunity.execution_stage_closeout.v1",
        );
        assert.ok(isRecord(closeout?.document));
        const disposition = (closeout.document.unit_dispositions as Record<string, unknown>[])[0];
        assert.ok(disposition);
        disposition.lifecycle_hash = sha256Bytes("forged lifecycle hash");
      },
    },
    {
      name: "base-manifest",
      mutate: (receipt) => {
        const baseManifest = receipt.base_manifest as Record<string, unknown>;
        baseManifest.active_units = [];
        baseManifest.failed_units = ["buyer_active", "value_pending"];
      },
    },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    await contextTest.test(scenario.name, async (subcontext) => {
      const runId = `runtime-failure-receipt-tamper-${index + 1}`;
      const setup = await setupPersistedRun(subcontext, runId, "runtime-failure");
      const launchEnvelopes = incompleteExecutionWaveEnvelopes(runId, setup.plan);
      const dispatchEnvelope = launchEnvelopes.find(
        (envelope) =>
          envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
      );
      assert.ok(dispatchEnvelope);
      await publishRuntimeEnvelopesAsFormalStage(
        setup,
        launchEnvelopes,
        `request_g0_4_receipt_tamper_${index + 1}`,
      );
      await registerRuntimeLaunch(setup, dispatchEnvelope, "2026-07-24T12:07:18Z");
      const terminal = await prepareTerminalReporting(setup, true);
      const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
      const input = terminalApplyInput(
        setup,
        terminal,
        "The runtime failure prevents a research conclusion.",
      );
      await assert.rejects(
        runtime.apply({ ...input, faultAt: "after_intent" }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      await tamperRuntimeFailurePlanReceipt(setup.runRoot, scenario.mutate);
      const beforeRecovery = await snapshotRunTree(setup.runRoot);
      await assert.rejects(
        setup.store.load(runId),
        (error: unknown) =>
          error instanceof StoreError &&
          ["recovery.invalid_plan_operation", "apply.base_manifest_conflict"].includes(error.code),
      );
      assert.deepEqual(await snapshotRunTree(setup.runRoot), beforeRecovery);
      const manifestAfter = JSON.parse(
        await readFile(path.join(setup.runRoot, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(manifestAfter.status, "researching");
      assert.deepEqual([...((manifestAfter.active_units as string[]) ?? [])].sort(), [
        "buyer_active",
        "value_pending",
      ]);
      await assertNoTerminalReportOutputs(setup.runRoot);
    });
  }
});

test("runtime failure receipt rejects coordinated base Manifest tamper at pending recovery", async (contextTest) => {
  for (const faultAt of ["after_intent", "after_control_artifacts"] as const) {
    await contextTest.test(faultAt, async (subcontext) => {
      const runId = `runtime-failure-base-manifest-coordinated-${faultAt.replaceAll("_", "-")}`;
      const setup = await setupPersistedRun(subcontext, runId, "runtime-failure");
      const launchEnvelopes = incompleteExecutionWaveEnvelopes(runId, setup.plan);
      const dispatchEnvelope = launchEnvelopes.find(
        (envelope) =>
          envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
      );
      assert.ok(dispatchEnvelope);
      await publishRuntimeEnvelopesAsFormalStage(
        setup,
        launchEnvelopes,
        `request_g0_4_base_manifest_coordinated_${faultAt}`,
      );
      await registerRuntimeLaunch(setup, dispatchEnvelope, "2026-07-24T12:07:18Z");
      const terminal = await prepareTerminalReporting(setup, true);
      const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
      const input = terminalApplyInput(
        setup,
        terminal,
        "The runtime failure receipt cannot authenticate a forged base Manifest.",
      );
      await assert.rejects(
        runtime.apply({ ...input, faultAt }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      await tamperPlanReceiptBaseManifestWithCoordinatedIdentity(setup.runRoot, (baseManifest) => {
        baseManifest.updated_at = "2026-07-24T12:06:01Z";
        baseManifest.pending_adaptation_refs = [
          ...new Set([
            ...((baseManifest.pending_adaptation_refs as string[]) ?? []),
            "adaptations/decisions/forged-extra-pending.json",
          ]),
        ].sort();
      });
      const beforeRecovery = await snapshotRunTree(setup.runRoot);
      await assert.rejects(
        setup.store.load(runId),
        (error: unknown) =>
          error instanceof StoreError &&
          ["recovery.invalid_plan_operation", "apply.base_manifest_conflict"].includes(error.code),
      );
      assert.deepEqual(await snapshotRunTree(setup.runRoot), beforeRecovery);
      const manifestAfter = JSON.parse(
        await readFile(path.join(setup.runRoot, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(manifestAfter.status, "researching");
      assert.deepEqual([...((manifestAfter.active_units as string[]) ?? [])].sort(), [
        "buyer_active",
        "value_pending",
      ]);
      assert.ok(
        !((manifestAfter.pending_adaptation_refs as string[]) ?? []).includes(
          "adaptations/decisions/forged-extra-pending.json",
        ),
      );
      await assertNoTerminalReportOutputs(setup.runRoot);
    });
  }
});

test("runtime failure prepare rejects tampered already-terminal lifecycle source before writes", async (contextTest) => {
  const runId = "runtime-failure-terminal-lifecycle-source-tamper";
  const setup = await setupPersistedRun(contextTest, runId, "runtime-failure");
  const launchEnvelopes = incompleteExecutionWaveEnvelopes(runId, setup.plan);
  const dispatchEnvelope = launchEnvelopes.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(dispatchEnvelope);
  await publishRuntimeEnvelopesAsFormalStage(
    setup,
    launchEnvelopes,
    `request_g0_4_terminal_lifecycle_tamper_${runId}`,
  );
  await registerRuntimeLaunch(setup, dispatchEnvelope, "2026-07-24T12:07:18Z");
  const terminalLifecycle = await publishTerminalLifecycleRevision(setup, dispatchEnvelope);
  const terminal = await prepareTerminalReporting(setup, true);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = terminalApplyInput(
    setup,
    terminal,
    "The runtime failure cannot derive closeout from tampered terminal lifecycle bytes.",
  );
  await tamperStoredEnvelopeOnly(setup.runRoot, terminalLifecycle.artifact_path, (document) => {
    document.state = "failed";
    document.failure = {
      kind: "validation_failed",
      detail: "SYNTHETIC forged terminal lifecycle failure.",
      retryable: true,
    };
    (document.timestamps as Record<string, unknown>).ended_at = "2026-07-24T12:07:30Z";
  });
  const beforeApply = await snapshotRunTree(setup.runRoot);
  await assert.rejects(
    runtime.apply(input),
    (error: unknown) =>
      error instanceof StoreError && error.code === "apply.runtime_failure_source_tampered",
  );
  assert.deepEqual(await snapshotRunTree(setup.runRoot), beforeApply);
  const manifestAfter = JSON.parse(
    await readFile(path.join(setup.runRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(manifestAfter.status, "researching");
  const artifactRefs = Array.isArray(manifestAfter.artifact_refs)
    ? manifestAfter.artifact_refs
    : [];
  assert.ok(!artifactRefs.includes("report.json"));
  await assertNoTerminalReportOutputs(setup.runRoot);
});

test("runtime failure prepare rejects tampered already-terminal lane result source before writes", async (contextTest) => {
  const runId = "runtime-failure-terminal-result-source-tamper";
  const state = await setupDiscoverySynthesisRuntimeRun(contextTest, runId);
  await publishDiscoverySynthesisReadiness(state);
  const adaptationBundle = await publishRuntimeFailureAuthorityForDiscovery(state);
  const loaded = await state.store.load(runId);
  const setupLike = {
    ...state,
    currentManifest: loaded.manifest as unknown as Record<string, unknown>,
    adaptationBundle,
    discoveryBundle: state.bundle,
    researchLanguage: "en-US",
  } as unknown as Awaited<ReturnType<typeof setupPersistedRun>>;
  const terminal = await prepareTerminalReporting(
    setupLike,
    true,
    undefined,
    "en-US",
    "2026-07-27T20:14:00Z",
  );
  excludeFormalEvidence(
    terminal,
    bundleEnvelopesByType(
      state.bundle,
      "startup_opportunity.evidence.discovery_candidate.current",
    ).map((envelope) => envelope.artifact_path),
  );
  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  await tamperStoredEnvelopeOnly(state.runRoot, G22_GENERATION_LANE, (document) => {
    document.status = "failed";
    document.limitations = [
      ...((document.limitations as string[]) ?? []),
      "SYNTHETIC forged terminal lane result bytes.",
    ];
  });
  const beforeApply = await snapshotRunTree(state.runRoot);
  await assert.rejects(
    runtime.apply(
      terminalApplyInput(
        setupLike,
        terminal,
        "The runtime failure cannot derive closeout from tampered terminal result bytes.",
        {
          createdAt: "2026-07-27T20:15:00Z",
          checkpointCreatedAt: "2026-07-27T20:16:00Z",
        },
      ),
    ),
    (error: unknown) =>
      error instanceof StoreError &&
      ["apply.runtime_failure_source_tampered", "adaptation.stored_content_mismatch"].includes(
        error.code,
      ),
  );
  assert.deepEqual(await snapshotRunTree(state.runRoot), beforeApply);
  const manifestAfter = JSON.parse(
    await readFile(path.join(state.runRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.notEqual(manifestAfter.status, "failed");
  await assertNoTerminalReportOutputs(state.runRoot);
});

test("runtime failure recovery rejects tampered terminal source artifacts before writes", async (contextTest) => {
  await contextTest.test("terminal-lifecycle", async (subcontext) => {
    const runId = "runtime-failure-terminal-lifecycle-recovery-tamper";
    const setup = await setupPersistedRun(subcontext, runId, "runtime-failure");
    const launchEnvelopes = incompleteExecutionWaveEnvelopes(runId, setup.plan);
    const dispatchEnvelope = launchEnvelopes.find(
      (envelope) =>
        envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
    );
    assert.ok(dispatchEnvelope);
    await publishRuntimeEnvelopesAsFormalStage(
      setup,
      launchEnvelopes,
      `request_g0_4_terminal_lifecycle_recovery_tamper_${runId}`,
    );
    await registerRuntimeLaunch(setup, dispatchEnvelope, "2026-07-24T12:07:18Z");
    const terminalLifecycle = await publishTerminalLifecycleRevision(setup, dispatchEnvelope);
    const terminal = await prepareTerminalReporting(setup, true);
    const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
    const input = terminalApplyInput(
      setup,
      terminal,
      "The runtime failure receipt cannot recover from tampered terminal lifecycle bytes.",
    );
    await assert.rejects(
      runtime.apply({ ...input, faultAt: "after_intent" }),
      (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
    );
    await tamperStoredEnvelopeOnly(setup.runRoot, terminalLifecycle.artifact_path, (document) => {
      document.state = "failed";
      document.failure = {
        kind: "validation_failed",
        detail: "SYNTHETIC forged terminal lifecycle recovery failure.",
        retryable: true,
      };
      (document.timestamps as Record<string, unknown>).ended_at = "2026-07-24T12:07:30Z";
    });
    const beforeRecovery = await snapshotRunTree(setup.runRoot);
    await assert.rejects(
      setup.store.load(runId),
      (error: unknown) =>
        error instanceof StoreError &&
        ["recovery.invalid_plan_operation", "write.conflict"].includes(error.code),
    );
    assert.deepEqual(await snapshotRunTree(setup.runRoot), beforeRecovery);
    await assertNoTerminalReportOutputs(setup.runRoot);
  });

  await contextTest.test("terminal-lane-result", async (subcontext) => {
    const runId = "runtime-failure-terminal-result-recovery-tamper";
    const state = await setupDiscoverySynthesisRuntimeRun(subcontext, runId);
    await publishDiscoverySynthesisReadiness(state);
    const adaptationBundle = await publishRuntimeFailureAuthorityForDiscovery(state);
    const loaded = await state.store.load(runId);
    const setupLike = {
      ...state,
      currentManifest: loaded.manifest as unknown as Record<string, unknown>,
      adaptationBundle,
      discoveryBundle: state.bundle,
      researchLanguage: "en-US",
    } as unknown as Awaited<ReturnType<typeof setupPersistedRun>>;
    const terminal = await prepareTerminalReporting(
      setupLike,
      true,
      undefined,
      "en-US",
      "2026-07-27T20:14:00Z",
    );
    excludeFormalEvidence(
      terminal,
      bundleEnvelopesByType(
        state.bundle,
        "startup_opportunity.evidence.discovery_candidate.current",
      ).map((envelope) => envelope.artifact_path),
    );
    const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
    await assert.rejects(
      runtime.apply({
        ...terminalApplyInput(
          setupLike,
          terminal,
          "The runtime failure receipt binds the authenticated terminal result source set.",
          {
            createdAt: "2026-07-27T20:15:00Z",
            checkpointCreatedAt: "2026-07-27T20:16:00Z",
          },
        ),
        faultAt: "after_intent",
      }),
      (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
    );
    await tamperStoredEnvelopeOnly(state.runRoot, G22_GENERATION_LANE, (document) => {
      document.status = "failed";
      document.limitations = [
        ...((document.limitations as string[]) ?? []),
        "SYNTHETIC forged terminal lane result recovery bytes.",
      ];
    });
    const beforeRecovery = await snapshotRunTree(state.runRoot);
    await assert.rejects(
      state.store.load(runId),
      (error: unknown) =>
        error instanceof StoreError &&
        ["recovery.invalid_plan_operation", "write.conflict"].includes(error.code),
    );
    assert.deepEqual(await snapshotRunTree(state.runRoot), beforeRecovery);
    const manifestAfter = JSON.parse(
      await readFile(path.join(state.runRoot, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.notEqual(manifestAfter.status, "failed");
    await assertNoTerminalReportOutputs(state.runRoot);
  });
});

test("runtime failure with no active discovery units is terminal and replay-safe", async (contextTest) => {
  const runId = "runtime-failure-zero-active-discovery";
  const setup = await setupPersistedRun(contextTest, runId, "runtime-failure-discovery");
  const preStatus = await setup.store.status(runId);
  assert.deepEqual(preStatus.manifest.active_units, [], JSON.stringify(preStatus, null, 2));
  assert.equal(preStatus.observability.laneTimings.length, 0, JSON.stringify(preStatus, null, 2));

  const terminal = await prepareTerminalReporting(
    setup,
    true,
    undefined,
    setup.researchLanguage,
    "2026-07-27T18:03:00Z",
  );
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = terminalApplyInput(
    setup,
    terminal,
    "The runtime failure prevents a research conclusion.",
    {
      createdAt: "2026-07-27T18:01:00Z",
      checkpointCreatedAt: "2026-07-27T18:02:00Z",
    },
  );
  const applied = await runtime.apply(input);
  assert.equal(applied.status, "applied", JSON.stringify(applied, null, 2));
  assert.equal(applied.terminalReport?.status, "published", JSON.stringify(applied, null, 2));
  assert.equal(
    (await runtime.apply(input)).status,
    "idempotent_replay",
    JSON.stringify(applied, null, 2),
  );

  const status = await setup.store.status(runId);
  assert.equal(status.manifest.status, "failed", JSON.stringify(status, null, 2));
  assert.deepEqual(status.manifest.active_units, [], JSON.stringify(status, null, 2));
  assert.deepEqual(status.manifest.failed_units, [], JSON.stringify(status, null, 2));
  assert.deepEqual(status.manifest.pending_adaptation_refs, [], JSON.stringify(status, null, 2));
  assert.equal(status.terminalReportDisposition, "ready", JSON.stringify(status, null, 2));
  assert.equal(status.observability.laneTimings.length, 0, JSON.stringify(status, null, 2));
});

test("runtime failure preserves published Discovery readiness and research semantics", async (contextTest) => {
  const runId = "runtime-failure-preserves-discovery-semantics";
  const state = await setupDiscoverySynthesisRuntimeRun(contextTest, runId);
  await publishDiscoverySynthesisReadiness(state);
  const preservedRefs = [
    ...new Set<string>([
      G23_READINESS,
      G23_READINESS_GAP,
      G22_FAN_IN,
      G22_DEMAND_R2,
      G22_RETAINED_PRE_CANDIDATE,
      G22_WATCHLIST_PRE_CANDIDATE,
      G22_REJECTED_PRE_CANDIDATE,
      G22_GENERATION_LANE,
      G22_EVALUATION_LANE,
      G22_GENERATION_CLAIM,
      G22_EVALUATION_CLAIM,
      G22_JUDGMENT,
      G22_DEMAND_EVALUATION_JUDGMENT,
      G22_GENERATION_MANIFEST,
      G22_EVALUATION_MANIFEST,
      ...bundleEnvelopesByType(
        state.bundle,
        "startup_opportunity.evidence.discovery_candidate.current",
      ).map((envelope) => envelope.artifact_path),
    ]),
  ].sort();
  const beforeBytes = new Map(
    await Promise.all(
      preservedRefs.map(
        async (artifactRef): Promise<[string, string]> => [
          artifactRef,
          await readFile(path.join(state.runRoot, artifactRef), "utf8"),
        ],
      ),
    ),
  );
  const readinessBefore = JSON.parse(
    beforeBytes.get(G23_READINESS) ?? "",
  ) as FormalArtifactEnvelope;
  const readinessDocument = readinessBefore.document as Record<string, unknown>;
  assert.ok(
    (readinessDocument.question_coverage as Record<string, unknown>[]).every(
      (coverage) => coverage.status === "answered",
    ),
    JSON.stringify(readinessDocument.question_coverage, null, 2),
  );
  assert.ok((readinessDocument.candidate_roles as Record<string, unknown>[]).length > 0);
  assert.ok((readinessDocument.pre_candidate_roles as Record<string, unknown>[]).length > 0);
  assert.deepEqual(readinessDocument.commercial_signal_gate, {
    demand_signal: true,
    buyer_signal: false,
    purchase_signal: false,
    decision: "continue_research",
  });
  const judgmentBefore = JSON.parse(
    beforeBytes.get(G22_DEMAND_EVALUATION_JUDGMENT) ?? "",
  ) as FormalArtifactEnvelope;
  const judgmentDocument = judgmentBefore.document as Record<string, unknown>;
  assert.equal(judgmentDocument.judgment_signal, "opposed");
  assert.ok((judgmentDocument.opposing_refs as string[]).includes(G22_EVALUATION_CLAIM));

  const adaptationBundle = await publishRuntimeFailureAuthorityForDiscovery(state);
  const loaded = await state.store.load(runId);
  const setupLike = {
    ...state,
    currentManifest: loaded.manifest as unknown as Record<string, unknown>,
    adaptationBundle,
    discoveryBundle: state.bundle,
    researchLanguage: "en-US",
  } as unknown as Awaited<ReturnType<typeof setupPersistedRun>>;
  const terminal = await prepareTerminalReporting(
    setupLike,
    true,
    undefined,
    "en-US",
    "2026-07-27T20:14:00Z",
  );
  const formalEvidenceRefs = bundleEnvelopesByType(
    state.bundle,
    "startup_opportunity.evidence.discovery_candidate.current",
  ).map((envelope) => envelope.artifact_path);
  excludeFormalEvidence(terminal, formalEvidenceRefs);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  await runtime
    .apply(
      terminalApplyInput(
        setupLike,
        terminal,
        "The runtime failure is an execution blocker and not a Discovery conclusion.",
        {
          createdAt: "2026-07-27T20:15:00Z",
          checkpointCreatedAt: "2026-07-27T20:16:00Z",
        },
      ),
    )
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
      }
      throw error;
    });

  const status = await state.store.status(runId);
  assert.equal(status.manifest.status, "failed", JSON.stringify(status, null, 2));
  assert.deepEqual(status.manifest.active_units, [], JSON.stringify(status, null, 2));
  assert.deepEqual(status.manifest.failed_units, [], JSON.stringify(status, null, 2));
  assert.equal(status.terminalReportDisposition, "ready", JSON.stringify(status, null, 2));
  for (const artifactRef of preservedRefs) {
    assert.equal(
      await readFile(path.join(state.runRoot, artifactRef), "utf8"),
      beforeBytes.get(artifactRef),
      artifactRef,
    );
  }
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
  const report = JSON.parse(
    await readFile(path.join(state.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(
    (report.research_conclusion as Record<string, unknown>).outcome,
    "no_recommendation",
  );
  assert.equal(
    (report.research_conclusion as Record<string, unknown>).evidence_strength,
    "insufficient",
  );
  assert.deepEqual(report.sources, []);
});

test("planned commercial Task without Audit is disclosed through the full projection", async (contextTest) => {
  const runId = "runtime-failure-planned-commercial-audit-missing";
  const setup = await setupPersistedRun(contextTest, runId, "runtime-failure-discovery");
  assert.ok(setup.discoveryBundle);
  const wave = discoveryWaveEnvelopes(
    setup.discoveryBundle,
    runId,
    "startup_opportunity.research_task.discovery_candidate.current",
    1,
    "terminal_commercial_missing",
  );
  const plannedTaskRefs = wave
    .filter(
      (envelope) =>
        envelope.artifact_type === "startup_opportunity.research_task.discovery_candidate.current",
    )
    .map((envelope) => envelope.artifact_path)
    .sort();
  assert.ok(plannedTaskRefs.length > 0);
  await publishRuntimeEnvelopesAsFormalStage(
    setup,
    wave,
    `request_g0_4_planned_commercial_${runId}`,
  );

  const terminal = await prepareTerminalReporting(setup, true);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  await runtime.apply({
    runId,
    adaptationBundle: terminal.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    terminalReportEnvelope: terminal.reportEnvelope,
    createdAt: "2026-07-27T18:02:00Z",
    checkpointCreatedAt: "2026-07-27T18:03:00Z",
    nextStep: "Disclose the runtime failure and missing planned commercial Audit.",
    beliefSummary: {
      current_belief:
        "The runtime failed before the planned commercial research Task could publish an Audit.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Can a repaired runtime complete a new Run?",
    },
  });
  const status = await setup.store.status(runId);
  assert.equal(status.manifest.status, "failed");
  assert.equal(status.terminalReportDisposition, "ready", JSON.stringify(status, null, 2));
  assert.deepEqual(status.terminalReportIssues, []);

  const report = JSON.parse(
    await readFile(path.join(setup.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal((report.commercial_research_status as Record<string, unknown>).state, "not_planned");
  const fullProjection = report.full_commercial_projection as Record<string, unknown>;
  const fullStatus = fullProjection.commercial_research_status as Record<string, unknown>;
  assert.equal(fullStatus.state, "planned_but_missing");
  assert.deepEqual([...((fullStatus.planned_task_refs as string[]) ?? [])].sort(), plannedTaskRefs);
  assert.deepEqual([...((fullStatus.missing_task_refs as string[]) ?? [])].sort(), plannedTaskRefs);
  const fullGaps = fullProjection.research_coverage_gaps as Record<string, unknown>[];
  for (const taskRef of plannedTaskRefs) {
    assert.ok(
      fullGaps.some((row) => row.coverage_kind === "execution" && row.task_ref === taskRef),
      taskRef,
    );
  }
  assert.equal(
    (report.report_statistics as Record<string, unknown>).full_gap_row_count,
    fullGaps.length,
  );
  assert.ok(fullGaps.length > 0);
  const warningCodes = new Set(
    (report.gate_warnings as Record<string, unknown>[]).map((warning) => warning.code),
  );
  assert.ok(warningCodes.has("commercial_research.report_audit_closure_incomplete"));
  assert.ok(warningCodes.has("terminal_reporting.search_closure_incomplete"));

  const markdown = await readFile(path.join(setup.runRoot, "report.md"), "utf8");
  assert.match(markdown, /No final research subject is available/u);
  assert.match(markdown, /full gap rows [1-9]/u);
  assert.doesNotMatch(markdown, /No formal commercial research task was planned/u);
  const appendix = await readFile(path.join(setup.runRoot, "audit-appendix.md"), "utf8");
  assert.match(appendix, /execution \/ research/u);
  assert.match(appendix, /planned commercial research task has no current valid Audit artifact/u);
  assert.doesNotMatch(appendix, /No formal commercial research task was planned/u);
});

test("terminal report publication fault recovers from the immutable source on reopen", async (contextTest) => {
  const runId = "runtime-terminal-report-fault";
  const setup = await setupPersistedRun(contextTest, runId, "terminate");
  const terminal = await prepareTerminalReporting(setup);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  await assert.rejects(
    runtime.apply({
      runId,
      adaptationBundle: terminal.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      terminalReportEnvelope: terminal.reportEnvelope,
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
  assert.equal(interrupted.manifest.status, "researching");
  assert.equal(interrupted.terminalReportDisposition, "not_required");
  const reopened = await setup.store.load(runId);
  assert.equal(reopened.manifest.status, "insufficient_evidence");
  assert.equal(reopened.planOperationRecovery.completedOperationKeys.length, 1);
  assert.equal(
    (await readFile(path.join(setup.runRoot, "decision-brief.md"), "utf8")).length > 0,
    true,
  );
  assert.equal((await setup.store.status(runId)).terminalReportDisposition, "ready");
});

test("post-manifest terminal fault already has every report output and exact replay finalizes delivery", async (contextTest) => {
  const runId = "runtime-terminal-plan-fault";
  const setup = await setupPersistedRun(contextTest, runId, "terminate");
  const terminal = await prepareTerminalReporting(setup);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = {
    runId,
    adaptationBundle: terminal.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    terminalReportEnvelope: terminal.reportEnvelope,
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
  assert.equal(interrupted.terminalReportDisposition, "ready");
  for (const relativePath of [
    "report.json",
    "decision-brief.md",
    "report.md",
    "audit-appendix.md",
  ]) {
    assert.equal((await readFile(path.join(setup.runRoot, relativePath), "utf8")).length > 0, true);
  }

  const replay = await runtime.apply(input);
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.terminalReport?.status, "idempotent_replay");
  assert.equal((await setup.store.status(runId)).terminalReportDisposition, "ready");
});

test("every terminal report durable boundary reopens to terminal state with complete reports", async (contextTest) => {
  const boundaries = [
    "after_report_sidecar",
    "after_report_materialization",
    "after_brief_sidecar",
    "after_brief_materialization",
    "after_view_sidecar",
    "after_view_materialization",
    "after_appendix_materialization",
    "after_consistency_sidecar",
  ] as const;
  for (const [index, terminalReportFaultAt] of boundaries.entries()) {
    const runId = `runtime-terminal-report-boundary-${index + 1}`;
    const setup = await setupPersistedRun(contextTest, runId, "terminate");
    const terminal = await prepareTerminalReporting(setup);
    await assert.rejects(
      (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
        runId,
        adaptationBundle: terminal.adaptationBundle,
        adaptationRefs: [DECISION_REF],
        terminalReportEnvelope: terminal.reportEnvelope,
        terminalReportFaultAt,
        createdAt: "2026-07-24T12:08:00Z",
        checkpointCreatedAt: "2026-07-24T12:09:00Z",
        nextStep: "Recover the exact terminal closeout intent.",
        beliefSummary: {
          current_belief: "The report operation must finish before terminal state is visible.",
          evidence_that_changed_belief: [],
          unchanged_assumptions: [],
          remaining_disagreement: [],
          next_decision_relevant_question: "Did reopen finish every report output?",
        },
      }),
      (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      terminalReportFaultAt,
    );
    assert.equal((await setup.store.status(runId)).manifest.status, "researching");
    const reopened = await setup.store.load(runId);
    assert.equal(reopened.manifest.status, "insufficient_evidence");
    assert.equal((await setup.store.status(runId)).terminalReportDisposition, "ready");
    for (const relativePath of [
      "report.json",
      "decision-brief.md",
      "report.md",
      "audit-appendix.md",
    ]) {
      assert.equal(
        (await readFile(path.join(setup.runRoot, relativePath), "utf8")).length > 0,
        true,
      );
    }
  }
});

test("every terminal Plan durable boundary avoids terminal-without-report and recovers exactly", async (contextTest) => {
  const boundaries = [
    "after_intent",
    "after_control_artifacts",
    "after_manifest_update",
    "after_checkpoint_publish",
  ] as const;
  for (const [index, faultAt] of boundaries.entries()) {
    const runId = `runtime-terminal-plan-boundary-${index + 1}`;
    const setup = await setupPersistedRun(contextTest, runId, "terminate");
    const terminal = await prepareTerminalReporting(setup);
    await assert.rejects(
      (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
        runId,
        adaptationBundle: terminal.adaptationBundle,
        adaptationRefs: [DECISION_REF],
        terminalReportEnvelope: terminal.reportEnvelope,
        createdAt: "2026-07-24T12:08:00Z",
        checkpointCreatedAt: "2026-07-24T12:09:00Z",
        nextStep: "Recover the exact terminal Plan intent.",
        beliefSummary: {
          current_belief: "Terminal state is visible only with every report output.",
          evidence_that_changed_belief: [],
          unchanged_assumptions: [],
          remaining_disagreement: [],
          next_decision_relevant_question: "Did the terminal Plan operation finish exactly?",
        },
        faultAt,
      }),
      (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      faultAt,
    );
    const interrupted = await setup.store.status(runId);
    if (faultAt === "after_intent" || faultAt === "after_control_artifacts") {
      assert.equal(interrupted.manifest.status, "researching");
      assert.equal(interrupted.terminalReportDisposition, "not_required");
    } else {
      assert.equal(interrupted.manifest.status, "insufficient_evidence");
      assert.equal(interrupted.terminalReportDisposition, "ready");
    }
    const reopened = await setup.store.load(runId);
    assert.equal(reopened.manifest.status, "insufficient_evidence");
    assert.equal((await setup.store.status(runId)).terminalReportDisposition, "ready");
    assert.equal((await setup.store.load(runId)).recovered, false);
  }
});

test("terminal report preflight failure leaves no closeout intent or formal output", async (contextTest) => {
  const runId = "runtime-terminal-preflight-zero-write";
  const setup = await setupPersistedRun(contextTest, runId, "terminate");
  const terminal = await prepareTerminalReporting(setup);
  const before = await planApplyBoundaryState(setup.runRoot);
  const reportingBefore = (await readdir(path.join(setup.runRoot, "artifacts/reporting"))).sort();
  const languageMismatch = clone(terminal.reportEnvelope);
  languageMismatch.document.research_language = "zh-CN";
  (languageMismatch as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    languageMismatch.document,
  );
  await assert.rejects(
    (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
      runId,
      adaptationBundle: terminal.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      terminalReportEnvelope: languageMismatch,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Reject a report whose language differs from the exact confirmed Scope.",
      beliefSummary: {
        current_belief: "The confirmed Scope remains the report language authority.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Can a language-consistent report close the Run?",
      },
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.research_language_authority_invalid",
  );
  assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
  assert.deepEqual(
    (await readdir(path.join(setup.runRoot, "artifacts/reporting"))).sort(),
    reportingBefore,
  );
  const invalidReport = clone(terminal.reportEnvelope);
  invalidReport.document.terminal_outcome = "completed";
  (invalidReport as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    invalidReport.document,
  );

  await assert.rejects(
    (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
      runId,
      adaptationBundle: terminal.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      terminalReportEnvelope: invalidReport,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Reject a report that disagrees with the prospective terminal Manifest.",
      beliefSummary: {
        current_belief: "Invalid report rendering cannot terminate the Run.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Can a corrected report close the Run?",
      },
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "apply.terminal_report_source_invalid",
  );
  assert.deepEqual(await planApplyBoundaryState(setup.runRoot), before);
  assert.deepEqual(
    (await readdir(path.join(setup.runRoot, "artifacts/reporting"))).sort(),
    reportingBefore,
  );
  assert.equal((await setup.store.status(runId)).manifest.status, "researching");
  for (const relativePath of [
    "report.json",
    "decision-brief.md",
    "report.md",
    "audit-appendix.md",
  ]) {
    await assert.rejects(readFile(path.join(setup.runRoot, relativePath), "utf8"));
  }
});

test("terminal closeout receipt and materialized output drift fail closed on reopen", async (contextTest) => {
  {
    const runId = "runtime-terminal-receipt-tamper";
    const setup = await setupPersistedRun(contextTest, runId, "terminate");
    const terminal = await prepareTerminalReporting(setup);
    await assert.rejects(
      (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
        runId,
        adaptationBundle: terminal.adaptationBundle,
        adaptationRefs: [DECISION_REF],
        terminalReportEnvelope: terminal.reportEnvelope,
        createdAt: "2026-07-24T12:08:00Z",
        checkpointCreatedAt: "2026-07-24T12:09:00Z",
        nextStep: "Leave an immutable terminal closeout intent.",
        beliefSummary: {
          current_belief: "Recovery is bound to exact prepared report bytes.",
          evidence_that_changed_belief: [],
          unchanged_assumptions: [],
          remaining_disagreement: [],
          next_decision_relevant_question: "Does receipt tamper fail closed?",
        },
        faultAt: "after_intent",
      }),
      (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
    );
    const receiptPath = await planReceiptFile(setup.runRoot);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    const operation = receipt.terminal_report_operation as Record<string, unknown>;
    const outputs = operation.materialized_outputs as Record<string, unknown>[];
    assert.deepEqual(outputs.map((output) => output.target_path).sort(), [
      "audit-appendix.md",
      "decision-brief.md",
      "report.json",
      "report.md",
    ]);
    assert.ok(outputs[0]);
    outputs[0].bytes = `${String(outputs[0].bytes)}tampered`;
    await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
    await assert.rejects(
      setup.store.load(runId),
      (error: unknown) =>
        error instanceof StoreError && error.code === "recovery.invalid_plan_operation",
    );
  }

  {
    const runId = "runtime-terminal-output-tamper";
    const setup = await setupPersistedRun(contextTest, runId, "terminate");
    const terminal = await prepareTerminalReporting(setup);
    await (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
      runId,
      adaptationBundle: terminal.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      terminalReportEnvelope: terminal.reportEnvelope,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Publish an exact terminal closeout.",
      beliefSummary: {
        current_belief: "Materialized bytes are part of the terminal operation.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Does output tamper fail closed?",
      },
    });
    await writeFile(path.join(setup.runRoot, "audit-appendix.md"), "tampered\n");
    await assert.rejects(
      setup.store.load(runId),
      (error: unknown) =>
        error instanceof StoreError && error.code === "report.terminal_operation_conflict",
    );
  }
});

test("terminal Manifest with a deleted report output fails closed instead of reconstructing it", async (contextTest) => {
  const runId = "runtime-terminal-output-deleted";
  const setup = await setupPersistedRun(contextTest, runId, "terminate");
  const terminal = await prepareTerminalReporting(setup);
  await (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
    runId,
    adaptationBundle: terminal.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    terminalReportEnvelope: terminal.reportEnvelope,
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Publish an exact terminal closeout.",
    beliefSummary: {
      current_belief: "A committed terminal report cannot be reconstructed after deletion.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does deletion fail closed?",
    },
  });
  await rm(path.join(setup.runRoot, "report.md"));
  await assert.rejects(
    setup.store.load(runId),
    (error: unknown) =>
      error instanceof StoreError && error.code === "recovery.terminal_report_missing_after_commit",
  );
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
      error instanceof StoreError &&
      error.code === "adaptation.discovery_candidate_binding_invalid",
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

test("Plan Revision preflight and apply reject forged supplied base Manifest before receipt writes", async (contextTest) => {
  for (const operation of ["preflight", "apply"] as const) {
    await contextTest.test(operation, async (subcontext) => {
      const runId = `runtime-forged-base-manifest-${operation}`;
      const setup = await setupPersistedRun(subcontext, runId);
      const { candidateBundle } = candidateFor(setup);
      const adaptationBundle = clone(setup.adaptationBundle);
      const manifestEntry = mutableBundleEntry(adaptationBundle, "manifest.json");
      manifestEntry.document.updated_at = "2026-07-24T12:06:01Z";
      const input: ApplyPlanRevisionInput = {
        runId,
        adaptationBundle,
        adaptationRefs: [DECISION_REF],
        candidateBundle,
        createdAt: "2026-07-24T12:08:00Z",
        checkpointCreatedAt: "2026-07-24T12:09:00Z",
        nextStep: "Reject a forged caller-supplied base Manifest before receipt writes.",
        beliefSummary: {
          current_belief: "The caller bundle must bind the exact current Manifest.",
          evidence_that_changed_belief: [],
          unchanged_assumptions: [],
          remaining_disagreement: [],
          next_decision_relevant_question: "Can a forged base Manifest generate a receipt?",
        },
      };
      const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
      const before = await snapshotRunTree(setup.runRoot);
      await assert.rejects(
        operation === "preflight" ? runtime.preflight(input) : runtime.apply(input),
        (error: unknown) =>
          error instanceof StoreError && error.code === "apply.stale_input_bundle",
      );
      assert.deepEqual(await snapshotRunTree(setup.runRoot), before);
      assert.equal(
        (await readdir(path.join(setup.runRoot, ".store/operations"))).filter((name) =>
          name.startsWith("plan-revision-"),
        ).length,
        0,
      );
    });
  }
});

test("Plan Revision apply rejects forged supplied Manifest before pending recovery writes", async (contextTest) => {
  for (const faultAt of ["after_manifest_update", "after_checkpoint_publish"] as const) {
    await contextTest.test(`revision-${faultAt}`, async (subcontext) => {
      const runId = `runtime-forged-pending-recovery-${faultAt.replaceAll("_", "-")}`;
      const setup = await setupPersistedRun(subcontext, runId);
      const { candidateBundle } = candidateFor(setup);
      const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
      const baseInput: ApplyPlanRevisionInput = {
        runId,
        adaptationBundle: setup.adaptationBundle,
        adaptationRefs: [DECISION_REF],
        candidateBundle,
        createdAt: "2026-07-24T12:08:00Z",
        checkpointCreatedAt: "2026-07-24T12:09:00Z",
        nextStep: "Leave an incomplete pending Plan operation for forged retry testing.",
        beliefSummary: {
          current_belief: "A legal Plan apply may be interrupted after Manifest CAS.",
          evidence_that_changed_belief: [],
          unchanged_assumptions: [],
          remaining_disagreement: [],
          next_decision_relevant_question:
            "Can a forged caller Manifest trigger pending recovery writes?",
        },
      };
      await assert.rejects(
        runtime.apply({ ...baseInput, faultAt }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      const beforeForgedRetry = await snapshotRunTree(setup.runRoot);
      const forgedAdaptationBundle = clone(setup.adaptationBundle);
      mutableBundleEntry(forgedAdaptationBundle, "manifest.json").document.updated_at =
        "2026-07-24T12:06:01Z";

      await assert.rejects(
        runtime.apply({ ...baseInput, adaptationBundle: forgedAdaptationBundle }),
        (error: unknown) =>
          error instanceof StoreError && error.code === "apply.stale_input_bundle",
      );
      assert.deepEqual(await snapshotRunTree(setup.runRoot), beforeForgedRetry);
    });

    await contextTest.test(`terminal-${faultAt}`, async (subcontext) => {
      const runId = `runtime-forged-terminal-pending-recovery-${faultAt.replaceAll("_", "-")}`;
      const setup = await setupPersistedRun(subcontext, runId, "runtime-failure");
      const launchEnvelopes = incompleteExecutionWaveEnvelopes(runId, setup.plan);
      const dispatchEnvelope = launchEnvelopes.find(
        (envelope) =>
          envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
      );
      assert.ok(dispatchEnvelope);
      await publishRuntimeEnvelopesAsFormalStage(
        setup,
        launchEnvelopes,
        `request_g0_4_forged_terminal_pending_${faultAt}`,
      );
      await registerRuntimeLaunch(setup, dispatchEnvelope, "2026-07-24T12:07:18Z");
      const terminal = await prepareTerminalReporting(setup, true);
      const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
      const baseInput = terminalApplyInput(
        setup,
        terminal,
        "The legal terminal runtime failure may be interrupted after Manifest CAS.",
      );
      await assert.rejects(
        runtime.apply({ ...baseInput, faultAt }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      const beforeForgedRetry = await snapshotRunTree(setup.runRoot);
      const forgedAdaptationBundle = clone(baseInput.adaptationBundle);
      mutableBundleEntry(forgedAdaptationBundle, "manifest.json").document.updated_at =
        "2026-07-24T12:06:01Z";

      await assert.rejects(
        runtime.apply({ ...baseInput, adaptationBundle: forgedAdaptationBundle }),
        (error: unknown) =>
          error instanceof StoreError && error.code === "apply.stale_input_bundle",
      );
      assert.deepEqual(await snapshotRunTree(setup.runRoot), beforeForgedRetry);
    });
  }
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

test("generation retry attempt two keeps Artifact revision independent through materialization", async (contextTest) => {
  const runId = "runtime-generation-retry-materialization";
  const setup = await setupPersistedRun(contextTest, runId, "generation-retry");
  const applyCreatedAt = "2026-07-26T17:01:00Z";
  const checkpointCreatedAt = "2026-07-26T17:02:00Z";
  const { candidateBundle } = candidateFor(setup, applyCreatedAt, "2026-07-26T17:01:30Z");
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const applied = await runtime.apply({
    runId,
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: applyCreatedAt,
    checkpointCreatedAt,
    nextStep: "Run the approved generation retry unit.",
    beliefSummary: {
      current_belief: "The failed generation unit has one approved retry.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does the retry materialize without forcing Artifact r2?",
    },
  });
  assert.equal(applied.status, "applied");
  const planEnvelope = JSON.parse(
    await readFile(path.join(setup.runRoot, "plans/research-plan.r2.json"), "utf8"),
  ) as FormalArtifactEnvelope;
  const successor = (planEnvelope.document.waves as Record<string, unknown>[])
    .flatMap((wave) => wave.units as Record<string, unknown>[])
    .find((unitEntry) => unitEntry.unit_id === "unit_user_language_v2");
  assert.ok(successor);
  assert.equal(successor.attempt, 2);
  assert.equal(
    successor.output_path,
    "artifacts/discovery/generation/unit_user_language_v2.r1.json",
  );
  const reopenedAfterApply = await setup.store.load(runId);
  assert.deepEqual(reopenedAfterApply.planOperationRecovery.historicalDiscoveryPlanBindings, [
    {
      planRef: PLAN_REF,
      planHash: canonicalContentHash(setup.plan),
      planRevision: 1,
      candidateRefs: [],
      generationTaskRefs: ["tasks/discovery/acquisition_failed.attempt-1.json"],
    },
  ]);

  const materializer = new FormalStageMaterializer(setup.runsRoot, setup.validator, repositoryRoot);
  const request = generationFormalWaveRequest(
    runId,
    "wave_runtime_1",
    "unit_user_language_v2",
    "generation_retry_wave",
    "2026-07-26T17:03:00Z",
  );
  const before = await snapshotRunTree(setup.runRoot);
  const validated = await materializer.materialize(request);
  assert.equal(validated.status, "validated");
  assert.deepEqual(await snapshotRunTree(setup.runRoot), before);
  const published = await materializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: validated.compilation.publication_plan,
  });
  assert.equal(published.status, "published");
  const taskEnvelope = published.compilation.compiled_envelopes.find(
    (entry) =>
      entry.artifact_type === "startup_opportunity.research_task.discovery_candidate.current",
  );
  const dispatchEnvelope = published.compilation.compiled_envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(taskEnvelope);
  assert.ok(dispatchEnvelope);
  assert.equal(taskEnvelope.artifact_path, "tasks/discovery/unit_user_language_v2.attempt-2.json");
  assert.equal(taskEnvelope.document.attempt, 2);
  assert.equal(
    taskEnvelope.document.supersedes_task_ref,
    "tasks/discovery/acquisition_failed.attempt-1.json",
  );
  assert.equal(
    taskEnvelope.document.allowed_output_path,
    "artifacts/discovery/generation/unit_user_language_v2.r1.json",
  );
  assert.equal(
    (dispatchEnvelope.document.tasks as Record<string, unknown>[])[0]?.allowed_output_path,
    taskEnvelope.document.allowed_output_path,
  );
});

test("Plan Revision atomically transitions discovery planning into enrichment", async (contextTest) => {
  const runId = "runtime-discovery-enrichment-transition";
  const setup = await setupPersistedRun(contextTest, runId, "phase-transition-add");
  const planR1Before = await readFile(path.join(setup.runRoot, PLAN_REF));
  const contextR1Before = await readFile(path.join(setup.runRoot, CONTEXT_REF));
  const { candidateBundle } = candidateFor(
    setup,
    PRE_KILL_APPLY_AT,
    PRE_KILL_CONTEXT_AT,
    "enrichment",
  );
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input: ApplyPlanRevisionInput = {
    runId,
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: PRE_KILL_APPLY_AT,
    checkpointCreatedAt: PRE_KILL_CHECKPOINT_AT,
    nextStep: "Run the approved enrichment unit.",
    beliefSummary: {
      current_belief: "Discovery formed a candidate that now requires bounded enrichment.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does enrichment preserve the candidate thesis?",
    },
  };

  const applied = await runtime.apply(input);
  assert.equal(applied.status, "applied");
  assert.equal(applied.currentPlanRef, "plans/research-plan.r2.json");
  assert.deepEqual(await readFile(path.join(setup.runRoot, PLAN_REF)), planR1Before);
  assert.deepEqual(await readFile(path.join(setup.runRoot, CONTEXT_REF)), contextR1Before);

  const contextR2 = JSON.parse(
    await readFile(path.join(setup.runRoot, CANDIDATE_CONTEXT_REF), "utf8"),
  ) as FormalArtifactEnvelope;
  assert.equal(contextR2.document.phase, "enrichment");
  const reopened = await setup.store.load(runId);
  assert.equal(reopened.manifest.current_phase, "discovery");
  assert.equal(reopened.manifest.plan_revision, 2);
  assert.deepEqual(reopened.manifest.pending_adaptation_refs, []);
  assert.ok(reopened.manifest.applied_adaptation_refs.includes(DECISION_REF));
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");
});

test("Plan Revision rejects an enrichment target when the candidate phase remains discovery", async (contextTest) => {
  const runId = "runtime-phase-transition-not-declared";
  const setup = await setupPersistedRun(contextTest, runId, "phase-transition-add");
  const before = await snapshotRunTree(setup.runRoot);
  const { candidateBundle } = candidateFor(
    setup,
    PRE_KILL_APPLY_AT,
    PRE_KILL_CONTEXT_AT,
    "discovery",
  );
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);

  await assert.rejects(
    runtime.apply({
      runId,
      adaptationBundle: setup.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      candidateBundle,
      createdAt: PRE_KILL_APPLY_AT,
      checkpointCreatedAt: PRE_KILL_CHECKPOINT_AT,
      nextStep: "Do not run a phase-incompatible enrichment unit.",
      beliefSummary: {
        current_belief: "The candidate phase does not authorize enrichment work.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Which declared phase authorizes the target tuple?",
      },
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "apply.candidate_plan_invalid" &&
      JSON.stringify(error.details).includes("contract.target_unit_tuple_not_allowed"),
  );
  assert.deepEqual(await snapshotRunTree(setup.runRoot), before);
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
    (entry) => entry.path === CANDIDATE_CONTEXT_REF,
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
  const runId = "runtime-late-artifact";
  const setup = await setupPersistedRun(contextTest, runId, "pre-kill-exact");
  const { store, runRoot } = setup;
  assert.ok(setup.discoveryBundle);
  const preparationEnvelopes = setup.discoveryBundle.documents.flatMap((entry) => {
    const envelope = entry.document as Partial<FormalArtifactEnvelope>;
    if (
      typeof envelope.artifact_type !== "string" ||
      [
        "startup_opportunity.research_plan.v1",
        "startup_opportunity.discovery_lane_result.v1",
        "startup_opportunity.discovery_candidate.v1",
        "startup_opportunity.concrete_pre_candidate.v1",
        "startup_opportunity.pre_candidate_relation.v1",
        "startup_opportunity.discovery_fan_in.v2",
      ].includes(envelope.artifact_type)
    ) {
      return [];
    }
    return [envelope as FormalArtifactEnvelope];
  });
  await publishRuntimeEnvelopesAsFormalStage(
    setup,
    preparationEnvelopes,
    `request_g0_4_late_preparation_${runId}`,
  );
  const planUnit = (setup.plan.waves as { units: Record<string, unknown>[] }[])
    .flatMap((wave) => wave.units)
    .find((unit) => unit.unit_id === "unit_seed_independent_demand");
  assert.ok(planUnit);
  const unitId = String(planUnit.unit_id);
  const latePath = String(planUnit.output_path);
  const current = JSON.parse(await readFile(path.join(runRoot, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
  for (const field of [
    "completed_units",
    "active_units",
    "failed_units",
    "invalidated_units",
    "skipped_units",
    "cancelled_units",
    "superseded_units",
  ]) {
    const values = current[field] as string[];
    current[field] =
      field === "cancelled_units"
        ? [...new Set([...values, unitId])].sort()
        : values.filter((value) => value !== unitId);
  }
  current.updated_at = "2026-07-24T12:07:30Z";
  await writeFile(path.join(runRoot, "manifest.json"), `${canonicalJson(current)}\n`);
  await store.checkpoint({
    runId,
    checkpointId: "checkpoint_late_boundary",
    createdAt: "2026-07-24T12:08:00Z",
    nextStep: "Ignore any result arriving for the cancelled unit.",
    beliefSummary: {
      current_belief: "The cancelled unit cannot affect the current plan.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does a late result remain excluded?",
    },
  });

  const lateEnvelope = structuredClone(runtimeEnvelope(setup.discoveryBundle, latePath));
  lateEnvelope.document.status = "ignored_late";
  lateEnvelope.document.scored_candidates = [];
  lateEnvelope.document.pre_kill_decisions = [];
  lateEnvelope.document.retained_candidate_refs = [];
  lateEnvelope.document.watchlist_candidate_refs = [];
  lateEnvelope.document.rejected_candidate_refs = [];
  const diversity = lateEnvelope.document.candidate_diversity_summary as Record<string, unknown>;
  diversity.diversity_retention_refs = [];
  diversity.counterfactual_candidate_refs = [];
  (lateEnvelope as { content_hash: string }).content_hash = canonicalContentHash(
    lateEnvelope.document,
  );
  (lateEnvelope as { created_at: string }).created_at = "2026-07-24T12:07:45Z";
  await store.publishArtifact({
    runId,
    envelope: lateEnvelope,
  });
  const afterLatePublish = JSON.parse(
    await readFile(path.join(runRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(afterLatePublish.updated_at, "2026-07-24T12:08:00Z");
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
      agent_declared_gaps: [],
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

test("public adaptation author path validates without writes, publishes exact controls, and atomically applies no-change", async (contextTest) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-adaptation-author-"));
  contextTest.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "adaptation-author-public-path";
  const store = new RunStore(runsRoot, await createArtifactValidator(repositoryRoot));
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "verify the current adaptation author path",
      researchLanguage: "en-US",
    },
    createdAt: "2026-08-10T08:00:00Z",
  });
  const plan = basePlan(runId);
  await publishInitialPlanBundle(
    store,
    runId,
    [formalEnvelope(runId, PLAN_REF, plan)],
    "enrichment",
  );
  const initialManifest = (await store.status(runId)).manifest;
  const author = await createAdaptationAuthorRuntime(repositoryRoot, runsRoot);
  const request = {
    schema_version: "startup_opportunity.adaptation_author_request.current",
    request_id: "author_stop_followup",
    run_id: runId,
    operation: "validate_only",
    top_level_formal_refs: [],
    gap: {
      snapshot_id: "gap_author_stop_followup",
      created_at: "2026-08-10T08:10:00Z",
      trigger_kind: "wave_completed",
      trigger_event_ref: null,
      phase: "enrichment",
      wave_id: "wave_runtime_1",
      observed_artifact_refs: [],
      material_new_evidence_observed: false,
      repeated_source_refs: [],
      agent_declared_gaps: [],
    },
    decisions: [
      {
        adaptation_id: "adapt_author_stop_followup",
        cover_all_generated_gaps: true,
        action: "stop_followup",
        reason: "The explicitly bounded cycle produced no material new evidence.",
        expected_decision_impact: ["next_action"],
        stop_condition: "No material new evidence was observed in the bounded cycle.",
        requested_by: "main_agent",
        created_at: "2026-08-10T08:11:00Z",
      },
    ],
    apply_created_at: "2026-08-10T08:12:00Z",
    checkpoint_created_at: "2026-08-10T08:13:00Z",
    next_phase: "enrichment",
    next_step: "Continue with the unchanged Plan under the explicit stop disposition.",
    belief_summary: {
      current_belief: "The bounded follow-up should stop without changing research conclusions.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["No research conclusion is upgraded by this lifecycle decision."],
      remaining_disagreement: [],
      next_decision_relevant_question: "Is the unchanged Plan ready for its next explicit stage?",
    },
  } as const;
  const before = await readFile(path.join(runsRoot, runId, "manifest.json"), "utf8");
  const requestFile = path.join(root, "adaptation-author-request.json");
  await writeFile(requestFile, `${canonicalJson(request)}\n`);
  const cliValidation = runScript("harness/src/cli.ts", [
    "author-plan-adaptation",
    "--file",
    requestFile,
    "--runs-root",
    runsRoot,
  ]);
  assert.equal(cliValidation.status, 0, cliValidation.stderr);
  assert.equal((JSON.parse(cliValidation.stdout) as { status: string }).status, "validated");
  const skillValidation = runScript(
    ".agents/skills/startup-opportunity/scripts/author-plan-adaptation.ts",
    ["--file", requestFile, "--runs-root", runsRoot],
  );
  assert.equal(skillValidation.status, 0, skillValidation.stderr);
  assert.equal((JSON.parse(skillValidation.stdout) as { status: string }).status, "validated");
  const validated = await author.execute(request);
  assert.equal(validated.status, "validated");
  assert.equal(validated.candidate_bundle, null);
  assert.equal(
    await readFile(path.join(runsRoot, runId, "manifest.json"), "utf8"),
    before,
    "validate_only must not mutate Manifest",
  );
  await assert.rejects(
    readFile(path.join(runsRoot, runId, validated.gap_envelope.artifact_path), "utf8"),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
  );

  const published = await author.execute({
    ...request,
    operation: "publish",
    publication_plan: validated.publication_plan,
  });
  assert.equal(published.status, "published");
  const publishedManifest = (await store.status(runId)).manifest;
  assert.equal(publishedManifest.latest_gap_snapshot_ref, published.gap_envelope.artifact_path);
  assert.deepEqual(
    publishedManifest.pending_adaptation_refs,
    published.adaptation_envelopes.map((entry) => entry.artifact_path),
  );
  assert.equal(
    (
      await author.execute({
        ...request,
        operation: "publish",
        publication_plan: validated.publication_plan,
      })
    ).status,
    "idempotent_replay",
  );

  const beforeStaleApply = await readFile(path.join(runsRoot, runId, "manifest.json"), "utf8");
  await assert.rejects(
    author.execute({
      ...request,
      operation: "apply",
      publication_plan: {
        ...published.publication_plan,
        manifest_content_hash: canonicalContentHash(initialManifest),
      },
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "adaptation.author_publication_plan_stale",
  );
  assert.equal(
    await readFile(path.join(runsRoot, runId, "manifest.json"), "utf8"),
    beforeStaleApply,
    "stale apply must leave Manifest unchanged",
  );

  const applied = await author.execute({
    ...request,
    operation: "apply",
    publication_plan: published.publication_plan,
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.apply_result?.revisionCreated, false);
  const finalManifest = (await store.status(runId)).manifest;
  assert.equal(finalManifest.current_plan_ref, PLAN_REF);
  assert.deepEqual(finalManifest.pending_adaptation_refs, []);
  assert.deepEqual(
    finalManifest.applied_adaptation_refs,
    published.adaptation_envelopes.map((entry) => entry.artifact_path),
  );

  const revisionRequest = {
    ...request,
    request_id: "author_reprioritize_unit",
    gap: {
      ...request.gap,
      snapshot_id: "gap_author_reprioritize",
      created_at: "2026-08-10T08:20:00Z",
    },
    decisions: [
      {
        adaptation_id: "adapt_author_reprioritize",
        cover_all_generated_gaps: true,
        action: "reprioritize_unit",
        target_unit_ref: `${PLAN_REF}#value_pending`,
        priority_band: "blocking",
        reason: "The explicit next-stage decision makes this pending unit blocking.",
        expected_decision_impact: ["next_action"],
        success_condition: "The immutable Plan Revision records the explicit priority change.",
        requested_by: "main_agent",
        created_at: "2026-08-10T08:21:00Z",
      },
    ],
    apply_created_at: "2026-08-10T08:22:00Z",
    checkpoint_created_at: "2026-08-10T08:23:00Z",
    next_step: "Execute the explicitly reprioritized pending unit.",
  } as const;
  const revisionValidated = await author.execute(revisionRequest);
  assert.ok(revisionValidated.candidate_bundle);
  assert.deepEqual(revisionValidated.plan_diff.changed_unit_ids, ["value_pending"]);
  const revisionPublished = await author.execute({
    ...revisionRequest,
    operation: "publish",
    publication_plan: revisionValidated.publication_plan,
  });
  assert.equal(
    (
      await author.execute({
        ...revisionRequest,
        operation: "publish",
        publication_plan: revisionValidated.publication_plan,
      })
    ).status,
    "idempotent_replay",
  );
  const revisionApplyRequest = {
    ...revisionRequest,
    operation: "apply" as const,
    publication_plan: revisionPublished.publication_plan,
  };
  await assert.rejects(
    author.execute(revisionApplyRequest, { faultAt: "after_manifest_update" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const interruptedManifest = (await store.status(runId)).manifest;
  assert.equal(interruptedManifest.current_plan_ref, "plans/research-plan.r2.json");
  assert.ok(interruptedManifest.checkpoint_ref);
  await assert.rejects(
    readFile(path.join(runsRoot, runId, interruptedManifest.checkpoint_ref), "utf8"),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
  );
  const revisionApplied = await author.execute(revisionApplyRequest);
  assert.equal(revisionApplied.status, "idempotent_replay");
  assert.equal(revisionApplied.apply_result?.revisionCreated, true);
  assert.equal(
    (await store.status(runId)).manifest.current_plan_ref,
    "plans/research-plan.r2.json",
  );
  assert.equal(
    revisionPublished.gap_envelope.document.parent_snapshot_ref,
    published.gap_envelope.artifact_path,
  );
});

test("public adaptation author path preflights and recovers terminal prose correction", async (contextTest) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-terminal-author-"));
  contextTest.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "adaptation-author-terminal-closeout";
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "verify terminal author closeout recovery",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-24T12:00:00Z",
  });
  const plan = basePlan(runId);
  await publishInitialPlanBundle(
    store,
    runId,
    [formalEnvelope(runId, PLAN_REF, plan)],
    "enrichment",
  );
  const runRoot = path.join(runsRoot, runId);
  const manifestPath = path.join(runRoot, "manifest.json");
  const activeManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  activeManifest.status = "researching";
  activeManifest.current_phase = "enrichment";
  activeManifest.followup_round = 2;
  activeManifest.completed_units = ["counter_completed"];
  activeManifest.active_units = ["buyer_active"];
  activeManifest.failed_units = [];
  activeManifest.updated_at = "2026-07-24T12:06:00Z";
  await writeFile(manifestPath, `${canonicalJson(activeManifest)}\n`);

  const currentManifest = (await store.status(runId)).manifest;
  const planningContextEnvelope = JSON.parse(
    await readFile(path.join(runRoot, CONTEXT_REF), "utf8"),
  ) as FormalArtifactEnvelope;
  const baseAdaptationBundle: DocumentBundle = {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: "manifest.json", document: currentManifest as unknown as Record<string, unknown> },
      { path: PLAN_REF, document: plan },
      {
        path: CONTEXT_REF,
        document: planningContextEnvelope as unknown as Record<string, unknown>,
      },
    ],
    exact_records: scopeDecisions(runId).map((document) => ({
      ref: `decisions.jsonl#${String(document.decision_id)}`,
      document,
    })),
  };
  const gapId = "gap_author_terminal";
  const gapRef = `adaptations/gap-snapshots/${gapId}.r1.json`;
  const adaptationId = "adapt_author_terminal_terminate";
  const adaptationRef = `adaptations/decisions/${adaptationId}.json`;
  const originalDeclarations = [
    {
      declaration_id: "declared_author_terminal_gap",
      gap_type: "evidence_insufficient",
      subject_ref: PLAN_REF,
      basis_refs: ["manifest.json", PLAN_REF],
      evidence_refs: [],
      decision_impact: ["execution_validity"],
      severity: "blocking",
      recommended_unit_types: [],
      detail:
        "The main agent declares the remaining evidence gap is blocking and has no bounded follow-up.",
    },
    {
      declaration_id: "declared_author_terminal_closure_gap",
      gap_type: "evidence_insufficient",
      subject_ref: PLAN_REF,
      basis_refs: ["manifest.json", PLAN_REF],
      evidence_refs: [],
      decision_impact: ["execution_validity"],
      severity: "blocking",
      recommended_unit_types: [],
      detail:
        "The main agent declares a distinct terminal closure gap that must remain bound to the immutable Gap Snapshot.",
    },
  ] as const;
  const terminal = await prepareTerminalReporting(
    {
      root,
      runsRoot,
      runRoot,
      store,
      validator,
      plan,
      gap: {},
      decision: {},
      userDecision: null,
      triggerEventRecord: null,
      planningContext: {
        path: CONTEXT_REF,
        document: planningContextEnvelope as unknown as Record<string, unknown>,
      },
      currentManifest,
      adaptationBundle: baseAdaptationBundle,
      checkpointEntry: { path: "checkpoints/unused.json", document: {} },
      discoveryBundle: null,
      researchLanguage: CONFIRMED_SCOPE.research_language,
    },
    false,
    undefined,
    CONFIRMED_SCOPE.research_language,
    "2026-07-24T12:09:30Z",
    [adaptationRef, gapRef, PLAN_REF],
    gapRef,
  );
  const request = {
    schema_version: "startup_opportunity.adaptation_author_request.current",
    request_id: "author_terminal_closeout",
    run_id: runId,
    operation: "validate_only",
    top_level_formal_refs: [],
    gap: {
      snapshot_id: gapId,
      created_at: "2026-07-24T12:07:40Z",
      trigger_kind: "wave_completed",
      trigger_event_ref: null,
      phase: "enrichment",
      wave_id: "wave_runtime_1",
      observed_artifact_refs: [],
      material_new_evidence_observed: false,
      repeated_source_refs: [],
      agent_declared_gaps: originalDeclarations,
    },
    decisions: [
      {
        adaptation_id: adaptationId,
        cover_all_generated_gaps: true,
        action: "terminate_insufficient_evidence",
        reason: "The blocking evidence gap cannot be resolved within the bounded Run.",
        expected_decision_impact: ["execution_validity", "next_action"],
        stop_condition: "No bounded follow-up remains available.",
        requested_by: "main_agent",
        created_at: "2026-07-24T12:07:50Z",
      },
    ],
    apply_created_at: "2026-07-24T12:10:00Z",
    checkpoint_created_at: "2026-07-24T12:11:00Z",
    next_phase: "enrichment",
    next_step: "Deliver the terminal report from the exact public authoring plan.",
    belief_summary: {
      current_belief: "SYNTHETIC evidence remains insufficient after the bounded cycle.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["No market validation is claimed."],
      remaining_disagreement: ["A concrete opportunity remains unproven."],
      next_decision_relevant_question: "What evidence would justify a new Run?",
    },
    terminal_report_envelope: terminal.reportEnvelope,
  } as const;
  const author = await createAdaptationAuthorRuntime(repositoryRoot, runsRoot);
  const invalidLanguage = clone(terminal.reportEnvelope);
  invalidLanguage.document.research_language = "zh-CN";
  (invalidLanguage as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    invalidLanguage.document,
  );
  const beforeInvalid = await snapshotRunTree(runRoot);
  await assert.rejects(
    author.execute({ ...request, terminal_report_envelope: invalidLanguage }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.research_language_authority_invalid",
  );
  assert.deepEqual(await snapshotRunTree(runRoot), beforeInvalid);
  await assert.rejects(readFile(path.join(runRoot, gapRef), "utf8"));
  await assert.rejects(readFile(path.join(runRoot, adaptationRef), "utf8"));

  const validated = await author.execute(request);
  assert.equal(validated.status, "validated");
  assert.deepEqual(await snapshotRunTree(runRoot), beforeInvalid);
  const published = await author.execute({
    ...request,
    operation: "publish",
    publication_plan: validated.publication_plan,
  });
  assert.equal(published.status, "published");
  assert.equal((await store.status(runId)).manifest.latest_gap_snapshot_ref, gapRef);
  assert.deepEqual((await store.status(runId)).manifest.pending_adaptation_refs, [adaptationRef]);
  const publishedGaps = Array.isArray(published.gap_envelope.document.gaps)
    ? published.gap_envelope.document.gaps.filter(
        (gap): gap is Record<string, unknown> => typeof gap === "object" && gap !== null,
      )
    : [];
  assert.deepEqual(
    publishedGaps
      .filter((gap) => gap.detection_mode === "agent_semantic")
      .map((gap) => {
        const triggeredBy = gap.triggered_by;
        return typeof triggeredBy === "object" &&
          triggeredBy !== null &&
          "declaration_id" in triggeredBy
          ? String(triggeredBy.declaration_id)
          : "";
      })
      .sort(),
    originalDeclarations.map((declaration) => declaration.declaration_id).sort(),
  );

  const publishedLanguageDrift = clone(terminal.reportEnvelope);
  publishedLanguageDrift.document.research_language = "zh-CN";
  (publishedLanguageDrift as unknown as { content_hash: string }).content_hash =
    canonicalContentHash(publishedLanguageDrift.document);
  const afterPublish = await snapshotRunTree(runRoot);
  await assert.rejects(
    author.execute({ ...request, terminal_report_envelope: publishedLanguageDrift }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.research_language_authority_invalid",
  );
  assert.deepEqual(await snapshotRunTree(runRoot), afterPublish);

  const assertNoWritePublishedGapMismatch = async (
    candidate: unknown,
    message: string,
  ): Promise<void> => {
    const before = await snapshotRunTree(runRoot);
    await assert.rejects(
      author.execute(candidate),
      (error: unknown) =>
        error instanceof StoreError && error.code === "adaptation.author_published_gap_mismatch",
    );
    assert.deepEqual(await snapshotRunTree(runRoot), before, message);
  };
  await assertNoWritePublishedGapMismatch(
    {
      ...request,
      gap: { ...request.gap, agent_declared_gaps: originalDeclarations.slice(0, 1) },
    },
    "deleting an agent declaration from a published terminal correction request must write nothing",
  );
  await assertNoWritePublishedGapMismatch(
    {
      ...request,
      gap: {
        ...request.gap,
        agent_declared_gaps: [
          originalDeclarations[0],
          {
            ...originalDeclarations[1],
            declaration_id: "declared_author_terminal_replacement_gap",
          },
        ],
      },
    },
    "replacing an agent declaration id must not reuse the published Gap",
  );
  await assertNoWritePublishedGapMismatch(
    {
      ...request,
      gap: {
        ...request.gap,
        agent_declared_gaps: [
          originalDeclarations[0],
          {
            ...originalDeclarations[1],
            detail: "The main agent declares a changed terminal closure gap after publication.",
          },
        ],
      },
    },
    "changing an agent declaration field must not reuse the published Gap",
  );
  await assertNoWritePublishedGapMismatch(
    {
      ...request,
      gap: {
        ...request.gap,
        agent_declared_gaps: [
          ...originalDeclarations,
          {
            declaration_id: "declared_author_terminal_added_gap",
            gap_type: "evidence_insufficient",
            subject_ref: PLAN_REF,
            basis_refs: ["manifest.json", PLAN_REF],
            evidence_refs: [],
            decision_impact: ["execution_validity"],
            severity: "blocking",
            recommended_unit_types: [],
            detail:
              "The main agent declares an additional terminal gap that cannot be hidden behind the published Gap.",
          },
        ],
      },
    },
    "adding an agent declaration to the same published snapshot id must write nothing",
  );

  const corrected = clone(terminal.reportEnvelope);
  const correctedConclusion = corrected.document.research_conclusion as Record<string, unknown>;
  correctedConclusion.current_recommendation =
    "暂缓形成或排序创业机会；本次更正仅调整终态说明文字。";
  (corrected as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    corrected.document,
  );
  const correctedRequest = { ...request, terminal_report_envelope: corrected };
  const correctedValidated = await author.execute(correctedRequest);
  assert.equal(correctedValidated.status, "validated");
  assert.equal(correctedValidated.publication_plan.gap_ref, gapRef);
  assert.deepEqual(correctedValidated.publication_plan.adaptation_refs, [adaptationRef]);
  assert.equal(
    correctedValidated.publication_plan.gap_content_hash,
    published.publication_plan.gap_content_hash,
  );
  assert.deepEqual(
    correctedValidated.publication_plan.adaptation_content_hashes,
    published.publication_plan.adaptation_content_hashes,
  );
  for (const field of [
    "request_content_hash",
    "operation_key",
    "checkpoint_ref",
    "plan_id",
  ] as const) {
    assert.notEqual(correctedValidated.publication_plan[field], published.publication_plan[field]);
  }
  assert.deepEqual(await snapshotRunTree(runRoot), afterPublish);

  await assert.rejects(
    author.execute({
      ...correctedRequest,
      operation: "apply",
      publication_plan: published.publication_plan,
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "adaptation.author_publication_plan_stale",
  );
  assert.deepEqual(await snapshotRunTree(runRoot), afterPublish);
  await assert.rejects(
    author.execute({
      ...correctedRequest,
      operation: "apply",
      publication_plan: {
        ...correctedValidated.publication_plan,
        operation_key: operationKey("tampered_author_plan", { runId }),
      },
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "adaptation.author_publication_plan_stale",
  );
  assert.deepEqual(await snapshotRunTree(runRoot), afterPublish);

  const correctedApplyRequest = {
    ...correctedRequest,
    operation: "apply" as const,
    publication_plan: correctedValidated.publication_plan,
  };
  await assert.rejects(
    author.execute(correctedApplyRequest, { faultAt: "after_manifest_update" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const interrupted = await store.status(runId);
  assert.equal(interrupted.manifest.status, "insufficient_evidence");
  assert.equal(interrupted.terminalReportDisposition, "ready");
  for (const relativePath of [
    "report.json",
    "decision-brief.md",
    "report.md",
    "audit-appendix.md",
  ]) {
    assert.equal((await readFile(path.join(runRoot, relativePath), "utf8")).length > 0, true);
  }
  const replay = await author.execute(correctedApplyRequest);
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.apply_result?.terminalReport?.status, "idempotent_replay");
  const exactReplay = await author.execute(correctedApplyRequest);
  assert.equal(exactReplay.status, "idempotent_replay");
  assert.deepEqual((await store.status(runId)).manifest.pending_adaptation_refs, []);
  assert.deepEqual((await store.status(runId)).manifest.applied_adaptation_refs, [adaptationRef]);
});

test("adaptation author validate-only does not complete a pending Plan recovery", async (contextTest) => {
  const runId = "adaptation-author-read-only-recovery";
  const setup = await setupPersistedRun(contextTest, runId);
  const { candidateBundle } = candidateFor(setup);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  await assert.rejects(
    runtime.apply({
      runId,
      adaptationBundle: setup.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      candidateBundle,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Leave the injected post-Manifest recovery pending for read-only validation.",
      beliefSummary: {
        current_belief: "The current Plan changed, but its mechanical closeout is still pending.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: ["No research conclusion changes at this recovery boundary."],
        remaining_disagreement: [],
        next_decision_relevant_question:
          "Can validation inspect current authority without recovery writes?",
      },
      faultAt: "after_manifest_update",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );

  const pendingManifest = JSON.parse(
    await readFile(path.join(setup.runRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(pendingManifest.current_plan_ref, "plans/research-plan.r2.json");
  assert.equal(typeof pendingManifest.checkpoint_ref, "string");
  await assert.rejects(
    readFile(path.join(setup.runRoot, String(pendingManifest.checkpoint_ref)), "utf8"),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
  );
  assert.equal(
    (await readdir(path.join(setup.runRoot, ".store/operations"))).filter((entry) =>
      entry.startsWith("plan-revision-"),
    ).length,
    1,
  );
  const before = await snapshotRunTree(setup.runRoot);

  const author = await createAdaptationAuthorRuntime(repositoryRoot, setup.runsRoot);
  await assert.rejects(
    author.execute({
      schema_version: "startup_opportunity.adaptation_author_request.current",
      request_id: "author_read_only_pending_recovery",
      run_id: runId,
      operation: "validate_only",
      top_level_formal_refs: [],
      gap: {
        snapshot_id: "gap_author_read_only_pending_recovery",
        created_at: "2026-08-10T09:02:00Z",
        trigger_kind: "wave_completed",
        trigger_event_ref: null,
        phase: "enrichment",
        wave_id: "wave_runtime_1",
        observed_artifact_refs: [],
        material_new_evidence_observed: false,
        repeated_source_refs: [],
        agent_declared_gaps: [],
      },
      decisions: [
        {
          adaptation_id: "adapt_author_read_only_pending_recovery",
          cover_all_generated_gaps: true,
          action: "stop_followup",
          reason:
            "The caller explicitly stops this bounded follow-up without changing conclusions.",
          expected_decision_impact: ["next_action"],
          stop_condition: "No material new evidence was observed in this bounded follow-up.",
          requested_by: "main_agent",
          created_at: "2026-08-10T09:03:00Z",
        },
      ],
      apply_created_at: "2026-08-10T09:04:00Z",
      checkpoint_created_at: "2026-08-10T09:05:00Z",
      next_phase: "enrichment",
      next_step: "Preserve the pending recovery until an explicit mutating operation resumes it.",
      belief_summary: {
        current_belief: "Read-only validation must not complete pending mechanical recovery.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: ["No research conclusion is upgraded by validation."],
        remaining_disagreement: [],
        next_decision_relevant_question:
          "Will a later mutating path recover the pending operation?",
      },
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "adaptation.author_recovery_pending",
  );
  assert.deepEqual(
    await snapshotRunTree(setup.runRoot),
    before,
    "validate_only must not publish a Checkpoint or complete pending Plan recovery",
  );
});

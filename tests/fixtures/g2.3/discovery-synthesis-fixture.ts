import {
  canonicalContentHash,
  type DiscoveryProfile,
  type DocumentBundle,
  type EvidenceStoreRecord,
  type FormalArtifactEnvelope,
} from "../../../harness/src/index.js";
import { G21_PLAN_REF, G21_SCOPE_REF } from "../g2.1/discovery-maps-fixture.js";
import {
  fixtureEffective,
  fixtureEntry,
  G22_BASELINE_EVALUATION_JUDGMENT,
  G22_BASELINE_GENERATION_JUDGMENT,
  G22_BASELINE_R1,
  G22_DEMAND_EVALUATION_JUDGMENT,
  G22_DEMAND_R2,
  G22_EVALUATION_CLAIM,
  G22_EVALUATION_LANE,
  G22_EVALUATION_MANIFEST,
  G22_FAN_IN,
  G22_GENERATION_CLAIM,
  G22_GENERATION_LANE,
  G22_GENERATION_MANIFEST,
  G22_INSIGHT,
  G22_JUDGMENT,
  G22_RETAINED_PRE_CANDIDATE,
  G22_SOLUTION_EVALUATION_JUDGMENT,
  G22_SOLUTION_GENERATION_JUDGMENT,
  G22_SOLUTION_R1,
} from "../g2.2/discovery-candidate-fixture.js";
import {
  createDiscoveryRuntimeFixture,
  type DiscoveryRuntimeSubstrate,
} from "../g2.2/discovery-runtime-fixture.js";

export const G23_DEMAND_CONVERSION = "artifacts/discovery/conversions/candidate_demand.r1.json";
export const G23_BASELINE_CONVERSION = "artifacts/discovery/conversions/candidate_baseline.r1.json";
export const G23_SOLUTION_CONVERSION = "artifacts/discovery/conversions/candidate_solution.r1.json";
export const G23_DEMAND = "artifacts/discovery/demands/demand_household.r1.json";
export const G23_BASELINE = "artifacts/discovery/baselines/baseline_manual.r1.json";
export const G23_SOLUTION = "artifacts/discovery/solutions/solution_coordination.r1.json";
export const G23_SOLUTION_ALT = "artifacts/discovery/solutions/solution_coordination_alt.r1.json";
export const G23_SOLUTION_REJECTED =
  "artifacts/discovery/solutions/solution_coordination_rejected.r1.json";
export const G23_SOLUTION_ALT_CONVERSION =
  "artifacts/discovery/conversions/candidate_solution_alt.r1.json";
export const G23_SOLUTION_REJECTED_CONVERSION =
  "artifacts/discovery/conversions/candidate_solution_rejected.r1.json";
export const G23_EVALUATION =
  "artifacts/discovery/solution-evaluations/evaluation_household.r1.json";
export const G23_OPPORTUNITY_A = "artifacts/discovery/opportunities/opportunity_household.r1.json";
export const G23_OPPORTUNITY_B =
  "artifacts/discovery/opportunities/opportunity_household_variant.r1.json";
export const G23_SNAPSHOT = "artifacts/discovery/thesis-snapshots/snapshot_household.r1.json";
export const G23_MERGE = "artifacts/discovery/merges/merge_household.r1.json";
export const G23_EXECUTION = "plans/research-execution.r2.json";
export const G23_READINESS = "artifacts/discovery/readiness/discovery-synthesis.r1.json";
export const G23_READINESS_GAP = "adaptations/gap-snapshots/discovery_synthesis_readiness.r1.json";
export const G23_PRE_CANDIDATE_INTEREST_DECISION_REF =
  "decisions.jsonl#pre_candidate_interest_fixture";

const SYNTHETIC = "SYNTHETIC G2.3 fixture only; no real Evidence or validation.";

function boundary(): Record<string, unknown> {
  return {
    source_candidate_mutated: false,
    conversion_is_evidence: false,
    publication_implies_validation: false,
    external_validation_success_claimed: false,
    harness_generated_research: false,
    hidden_llm_calls: false,
  };
}

function sourceGroups(): Record<string, unknown> {
  return {
    generation_source_manifest_refs: [G22_GENERATION_MANIFEST],
    evaluation_source_manifest_refs: [G22_EVALUATION_MANIFEST],
    overlap_disclosures: [],
  };
}

function envelope(
  runId: string,
  path: string,
  document: Record<string, unknown>,
  inputRefs: readonly string[],
  createdAt: string,
  producerRole: "main_agent" | "harness" = "main_agent",
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: String(document.schema_version),
    artifact_path: path,
    run_id: runId,
    created_at: createdAt,
    producer_role: producerRole,
    input_refs: [...new Set(inputRefs)].sort(),
    content_hash: canonicalContentHash(document),
    document,
  } as FormalArtifactEnvelope;
}

function conversion(
  runId: string,
  id: string,
  sourceRef: string,
  kind: "demand_seed" | "baseline_seed" | "solution_seed",
  revision: number,
  sourceHash: string,
  sourcePreCandidateRef: string,
  sourcePreCandidateRevision: number,
  sourcePreCandidateHash: string,
  targetType: string,
  targetRef: string,
  targetHash: string,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.discovery_candidate_conversion.v2",
    conversion_id: `conversion_${id}`,
    revision: 1,
    parent_conversion_ref: null,
    parent_content_hash: null,
    run_id: runId,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    source_candidate_ref: sourceRef,
    source_candidate_schema_version: "startup_opportunity.discovery_candidate.v1",
    source_candidate_kind: kind,
    source_candidate_revision: revision,
    source_candidate_content_hash: sourceHash,
    source_pre_candidate_ref: sourcePreCandidateRef,
    source_pre_candidate_revision: sourcePreCandidateRevision,
    source_pre_candidate_content_hash: sourcePreCandidateHash,
    discovery_fan_in_ref: G22_FAN_IN,
    target_schema_version: targetType,
    target_artifact_ref: targetRef,
    target_content_hash: targetHash,
    promotion_preconditions: {
      source_candidate_is_current_revision: true,
      source_candidate_is_retained: true,
      typed_evidence_lineage_valid: true,
      decision_sufficiency_satisfied: true,
      target_schema_installed: true,
      conversion_evaluator_installed: true,
      promotion_authorized: true,
    },
    conversion_status: "promoted_to_formal_artifact",
    source_boundary: boundary(),
    limitations: [SYNTHETIC],
  };
}

function opportunity(
  runId: string,
  id: string,
  title: string,
  profile: DiscoveryProfile,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.opportunity_thesis.v1",
    opportunity_id: id,
    revision: 1,
    parent_opportunity_ref: null,
    parent_content_hash: null,
    run_id: runId,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    discovery_fan_in_ref: G22_FAN_IN,
    source_pre_candidate_ref: G22_RETAINED_PRE_CANDIDATE,
    title,
    description: SYNTHETIC,
    opportunity_thesis: SYNTHETIC,
    discovery_profile: profile,
    research_axes: ["industry_demand", "jtbd_workflow", "counter_evidence"],
    demand_thesis_ref: G23_DEMAND,
    selected_solution_ref: G23_SOLUTION,
    alternative_solution_refs: [],
    baseline_option_ref: G23_BASELINE,
    solution_evaluation_ref: G23_EVALUATION,
    selected_delivery_form: "mobile_web",
    incremental_value_over_baseline: SYNTHETIC,
    mental_positioning: SYNTHETIC,
    mental_position_occupation: {
      status: "unknown",
      occupied_by: [],
      white_space: SYNTHETIC,
      evidence_refs: [],
    },
    trigger_phrase: SYNTHETIC,
    entry_scene: SYNTHETIC,
    job_to_be_done: SYNTHETIC,
    buyer: [SYNTHETIC],
    payer: [SYNTHETIC],
    decision_maker: [SYNTHETIC],
    buyer_purchase_language: [SYNTHETIC],
    marketing_bridge: {
      user_trigger_phrase: SYNTHETIC,
      buyer_purchase_phrase: SYNTHETIC,
      decision_criteria: [SYNTHETIC],
    },
    beachhead_segment: SYNTHETIC,
    entry_wedge: SYNTHETIC,
    why_now: SYNTHETIC,
    initial_distribution_channels: [SYNTHETIC],
    value_layer: {
      primary: "workflow_outcome",
      output_value: SYNTHETIC,
      workflow_value: SYNTHETIC,
      outcome_metrics: [SYNTHETIC],
    },
    user_state_context_model: {
      state_variables: [SYNTHETIC],
      context_sources: [SYNTHETIC],
      state_update_triggers: [SYNTHETIC],
      feedback_or_ground_truth: [],
      retention_boundary: SYNTHETIC,
      privacy_permission_boundary: SYNTHETIC,
      deletion_export_boundary: SYNTHETIC,
    },
    natural_restatement_test: {
      status: "not_tested",
      test_prompt: SYNTHETIC,
      target_user: SYNTHETIC,
      expected_restatement: SYNTHETIC,
      success_signal: SYNTHETIC,
      failure_signal: SYNTHETIC,
      evidence_refs: [],
      limitations: [SYNTHETIC],
    },
    source_lanes: [G22_GENERATION_LANE, G22_EVALUATION_LANE],
    supporting_insight_refs: [G22_INSIGHT],
    opposing_claim_refs: [G22_EVALUATION_CLAIM],
    judgment_assessment_refs: [G22_JUDGMENT, G22_DEMAND_EVALUATION_JUDGMENT],
    audit_refs: [],
    risks: [SYNTHETIC],
    kill_criteria: [SYNTHETIC],
    comparison_ref: null,
    decision_recommendation_ref: null,
    lifecycle_status: "proposed",
    valid_as_of: "2026-07-27",
    freshness_policy: "revalidate_when_decisive_evidence_expires",
    source_boundary: boundary(),
    limitations: [SYNTHETIC],
  };
}

export async function createDiscoverySynthesisFixture(
  runId: string,
  substrate: DiscoveryRuntimeSubstrate,
  additionalPlanWaves: readonly Record<string, unknown>[] = [],
  profile: DiscoveryProfile = "general",
  researchLanguage = "en-US",
  solutionExplorationVariant: "single" | "compared" = "single",
): Promise<DocumentBundle> {
  const bundle = await createDiscoveryRuntimeFixture(
    runId,
    substrate,
    additionalPlanWaves,
    profile,
    true,
    researchLanguage,
  );
  (bundle as { schema_version: string }).schema_version =
    "startup_opportunity.document_bundle.current";
  const mutable = bundle as unknown as {
    documents: { path: string; document: Record<string, unknown> }[];
    exact_records: { ref: string; document: Record<string, unknown> }[];
  };
  const fanIn = fixtureEffective(bundle, G22_FAN_IN);
  for (const disposition of fanIn.candidate_dispositions as Record<string, unknown>[]) {
    disposition.disposition = "retained";
  }
  fanIn.retained_candidate_refs = [G22_DEMAND_R2, G22_BASELINE_R1, G22_SOLUTION_R1];
  fanIn.watchlist_candidate_refs = [];
  fanIn.rejected_candidate_refs = [];
  (fanIn.candidate_diversity_summary as Record<string, unknown>).diversity_retention_refs = [
    G22_DEMAND_R2,
    G22_BASELINE_R1,
    G22_SOLUTION_R1,
  ];
  fanIn.evidence_sufficiency_summary = {
    status: "sufficient_for_triage",
    insufficiency_reasons: [],
    what_would_change_the_decision: [SYNTHETIC],
  };
  fanIn.pre_kill_summary = ["SYNTHETIC all three typed candidates retained for G2.3 fixture."];
  const fanInEnvelope = fixtureEntry(bundle, G22_FAN_IN);
  fanInEnvelope.content_hash = canonicalContentHash(fanIn);
  const retainedPreCandidate = fixtureEffective(bundle, G22_RETAINED_PRE_CANDIDATE);
  const retainedPreCandidateHash = canonicalContentHash(retainedPreCandidate);
  const materializedPreCandidateRefs = fanIn.materialized_pre_candidate_refs as string[];
  const preCandidateInterestDecision = {
    schema_version: "startup_opportunity.decision.v1",
    decision_id: "pre_candidate_interest_fixture",
    run_id: runId,
    decision_type: "pre_candidate_interest_confirmed",
    timestamp: "2026-07-27T19:59:00Z",
    actor: "main_agent",
    reason:
      "SYNTHETIC caller attests that the user selected the retained pre-candidate for continuation.",
    artifact_refs: [G22_FAN_IN, ...materializedPreCandidateRefs].sort(),
    pre_candidate_source_fan_in_ref: G22_FAN_IN,
    pre_candidate_source_fan_in_hash: fanInEnvelope.content_hash,
    pre_candidate_next_action: "proceed_with_selected",
    pre_candidate_confirmation_sequence: 1,
    pre_candidate_interest_dispositions: materializedPreCandidateRefs.map((ref) => ({
      pre_candidate_ref: ref,
      pre_candidate_content_hash: canonicalContentHash(fixtureEffective(bundle, ref)),
      interest_disposition:
        ref === G22_RETAINED_PRE_CANDIDATE
          ? "selected_for_continuation"
          : "not_selected_current_run",
      followup_interest_disposition: "not_requested_for_additional_discovery",
    })),
    confirmation_basis: "caller_attested_user_confirmation",
    harness_identity_verification: "not_available",
  };
  const sourceSolutionSubject = fixtureEffective(bundle, G22_SOLUTION_R1).subject as Record<
    string,
    unknown
  >;

  const demand = {
    schema_version: "startup_opportunity.demand_thesis.v1",
    demand_id: "demand_household",
    revision: 1,
    parent_demand_ref: null,
    parent_content_hash: null,
    run_id: runId,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    discovery_fan_in_ref: G22_FAN_IN,
    source_conversion_ref: G23_DEMAND_CONVERSION,
    source_candidate_ref: G22_DEMAND_R2,
    source_pre_candidate_ref: G22_RETAINED_PRE_CANDIDATE,
    solution_neutral: true,
    source_groups: sourceGroups(),
    user: [SYNTHETIC],
    buyer: [SYNTHETIC],
    payer: [SYNTHETIC],
    decision_maker: [SYNTHETIC],
    job_to_be_done: SYNTHETIC,
    workflow_step: SYNTHETIC,
    trigger_phrase: SYNTHETIC,
    entry_scene: SYNTHETIC,
    current_alternatives: [SYNTHETIC],
    current_ai_workarounds: [],
    failure_and_loss: SYNTHETIC,
    task_operating_profile: {
      frequency: "unknown",
      volume: "unknown",
      input_modality: ["unknown"],
      output_modality: ["unknown"],
      task_variability: "unknown",
      exception_rate: "unknown",
      context_fragmentation: "unknown",
      judgment_intensity: "unknown",
    },
    execution_constraints: {
      latency_tolerance: "unknown",
      quality_threshold: "unknown",
      error_cost: "unknown",
      auditability_requirement: "unknown",
      human_review_tolerance: "unknown",
      privacy_security_constraints: [],
    },
    data_conditions: {
      existing_digital_trace: false,
      context_sources: [],
      possible_ground_truth: [],
      feedback_frequency: "unknown",
    },
    outcome_metrics: [SYNTHETIC],
    supporting_claim_refs: [G22_GENERATION_CLAIM],
    opposing_claim_refs: [G22_EVALUATION_CLAIM],
    judgment_assessment_refs: [G22_JUDGMENT, G22_DEMAND_EVALUATION_JUDGMENT],
    kill_conditions: [SYNTHETIC],
    audit_refs: [],
    source_boundary: boundary(),
    limitations: [SYNTHETIC],
  };
  const baseline = {
    schema_version: "startup_opportunity.baseline_option.v1",
    baseline_id: "baseline_manual",
    revision: 1,
    parent_baseline_ref: null,
    parent_content_hash: null,
    run_id: runId,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    discovery_fan_in_ref: G22_FAN_IN,
    source_conversion_ref: G23_BASELINE_CONVERSION,
    source_candidate_ref: G22_BASELINE_R1,
    source_pre_candidate_ref: G22_RETAINED_PRE_CANDIDATE,
    demand_thesis_ref: G23_DEMAND,
    current_workflow: SYNTHETIC,
    current_cost: SYNTHETIC,
    current_failure_modes: [SYNTHETIC],
    switching_cost: SYNTHETIC,
    why_users_continue: SYNTHETIC,
    minimum_incremental_value_required: SYNTHETIC,
    judgment_assessment_refs: [G22_BASELINE_GENERATION_JUDGMENT, G22_BASELINE_EVALUATION_JUDGMENT],
    audit_refs: [],
    source_boundary: boundary(),
    limitations: [SYNTHETIC],
  };
  const solution = {
    schema_version: "startup_opportunity.solution_hypothesis.v1",
    solution_id: "solution_coordination",
    revision: 1,
    parent_solution_ref: null,
    parent_content_hash: null,
    run_id: runId,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    discovery_fan_in_ref: G22_FAN_IN,
    source_conversion_ref: G23_SOLUTION_CONVERSION,
    source_candidate_ref: G22_SOLUTION_R1,
    source_pre_candidate_ref: G22_RETAINED_PRE_CANDIDATE,
    demand_thesis_ref: G23_DEMAND,
    baseline_option_ref: G23_BASELINE,
    selected: false,
    delivery_form: String((sourceSolutionSubject.delivery_forms as string[])[0]),
    solution_type: String(sourceSolutionSubject.solution_class),
    uses_ai: sourceSolutionSubject.uses_ai,
    solution_behavior: String(sourceSolutionSubject.description),
    workflow_change: SYNTHETIC,
    required_capabilities: [],
    capability_evidence_refs: [],
    incremental_value_over_baseline: SYNTHETIC,
    market_motion: "consumer",
    acquisition_motion: "community",
    buyer_model: "household_payer",
    payment_mode: "subscription",
    expected_outcomes: [SYNTHETIC],
    risks: [SYNTHETIC],
    kill_criteria: [SYNTHETIC],
    supporting_claim_refs: [G22_GENERATION_CLAIM],
    opposing_claim_refs: [G22_EVALUATION_CLAIM],
    judgment_assessment_refs: [G22_SOLUTION_GENERATION_JUDGMENT, G22_SOLUTION_EVALUATION_JUDGMENT],
    audit_refs: [],
    source_boundary: boundary(),
    limitations: [SYNTHETIC],
  };
  const comparedSolutionAlternative = structuredClone(solution) as Record<string, unknown>;
  comparedSolutionAlternative.solution_id = "solution_coordination_alt";
  comparedSolutionAlternative.source_conversion_ref = G23_SOLUTION_ALT_CONVERSION;
  comparedSolutionAlternative.solution_behavior =
    "SYNTHETIC G2.3 fixture alternative solution behavior; no real Evidence or validation.";
  comparedSolutionAlternative.workflow_change =
    "SYNTHETIC G2.3 fixture alternative workflow change; no real Evidence or validation.";
  comparedSolutionAlternative.incremental_value_over_baseline = SYNTHETIC;
  comparedSolutionAlternative.market_motion = "consumer";
  comparedSolutionAlternative.acquisition_motion = "community";
  comparedSolutionAlternative.buyer_model = "household_payer";
  comparedSolutionAlternative.payment_mode = "subscription";
  comparedSolutionAlternative.expected_outcomes = [
    "SYNTHETIC G2.3 fixture alternative expected outcome; no real Evidence or validation.",
  ];
  comparedSolutionAlternative.risks = [
    "SYNTHETIC G2.3 fixture alternative risk; no real Evidence or validation.",
  ];
  comparedSolutionAlternative.kill_criteria = [
    "SYNTHETIC G2.3 fixture alternative kill criterion; no real Evidence or validation.",
  ];
  const comparedSolutionRejected = structuredClone(solution) as Record<string, unknown>;
  comparedSolutionRejected.solution_id = "solution_coordination_rejected";
  comparedSolutionRejected.source_conversion_ref = G23_SOLUTION_REJECTED_CONVERSION;
  comparedSolutionRejected.solution_behavior =
    "SYNTHETIC G2.3 fixture rejected solution behavior; no real Evidence or validation.";
  comparedSolutionRejected.workflow_change =
    "SYNTHETIC G2.3 fixture rejected workflow change; no real Evidence or validation.";
  comparedSolutionRejected.incremental_value_over_baseline = SYNTHETIC;
  comparedSolutionRejected.market_motion = "consumer";
  comparedSolutionRejected.acquisition_motion = "community";
  comparedSolutionRejected.buyer_model = "household_payer";
  comparedSolutionRejected.payment_mode = "subscription";
  comparedSolutionRejected.expected_outcomes = [
    "SYNTHETIC G2.3 fixture rejected expected outcome; no real Evidence or validation.",
  ];
  comparedSolutionRejected.risks = [
    "SYNTHETIC G2.3 fixture rejected risk; no real Evidence or validation.",
  ];
  comparedSolutionRejected.kill_criteria = [
    "SYNTHETIC G2.3 fixture rejected kill criterion; no real Evidence or validation.",
  ];
  const formalSolutionDocuments = [
    [
      G23_SOLUTION,
      solution,
      "selected",
      G23_SOLUTION_CONVERSION,
      "candidate_solution",
      "2026-07-27T20:01:00Z",
    ],
    [
      G23_SOLUTION_ALT,
      comparedSolutionAlternative,
      "alternative",
      G23_SOLUTION_ALT_CONVERSION,
      "candidate_solution_alt",
      "2026-07-27T20:01:10Z",
    ],
    [
      G23_SOLUTION_REJECTED,
      comparedSolutionRejected,
      "rejected",
      G23_SOLUTION_REJECTED_CONVERSION,
      "candidate_solution_rejected",
      "2026-07-27T20:01:20Z",
    ],
  ] as const;
  const publishedFormalSolutionDocuments =
    solutionExplorationVariant === "compared"
      ? formalSolutionDocuments
      : formalSolutionDocuments.slice(0, 1);
  const formalSolutionRefs =
    solutionExplorationVariant === "compared"
      ? publishedFormalSolutionDocuments.map(([path]) => path)
      : [G23_SOLUTION];
  const evaluation = {
    schema_version: "startup_opportunity.solution_evaluation.v1",
    evaluation_id: "evaluation_household",
    revision: 1,
    parent_evaluation_ref: null,
    parent_content_hash: null,
    run_id: runId,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    discovery_fan_in_ref: G22_FAN_IN,
    demand_thesis_ref: G23_DEMAND,
    baseline_option_ref: G23_BASELINE,
    solution_hypothesis_refs: formalSolutionRefs,
    selected_solution_ref: G23_SOLUTION,
    alternative_solution_refs: solutionExplorationVariant === "compared" ? [G23_SOLUTION_ALT] : [],
    rejected_solutions:
      solutionExplorationVariant === "compared"
        ? [
            {
              solution_ref: G23_SOLUTION_REJECTED,
              reasons: [SYNTHETIC.replace("solution.", "solution rejected.")],
              judgment_assessment_refs: [G22_SOLUTION_EVALUATION_JUDGMENT],
            },
          ]
        : [],
    solution_exploration: {
      status:
        solutionExplorationVariant === "compared"
          ? "compared_multiple_formal_solutions"
          : "not_yet_explored",
      status_rationale:
        solutionExplorationVariant === "compared"
          ? "SYNTHETIC fixture compares three formal solutions with explicit selected/alternative/rejected closure."
          : "SYNTHETIC fixture declares one provisional solution without exploring other implementation approaches.",
      considered_approaches: [],
    },
    baseline_comparisons:
      solutionExplorationVariant === "compared"
        ? formalSolutionDocuments.map(([path, _document, disposition]) => ({
            solution_ref: path,
            incremental_value:
              disposition === "selected"
                ? SYNTHETIC
                : `SYNTHETIC G2.3 fixture ${disposition} baseline comparison; no real Evidence or validation.`,
            migration_cost:
              disposition === "selected"
                ? SYNTHETIC
                : `SYNTHETIC G2.3 fixture ${disposition} migration cost; no real Evidence or validation.`,
            decision: disposition,
          }))
        : [
            {
              solution_ref: G23_SOLUTION,
              incremental_value: SYNTHETIC,
              migration_cost: SYNTHETIC,
              decision: "selected",
            },
          ],
    solution_rationale: SYNTHETIC,
    critical_unknowns: [SYNTHETIC],
    capability_only_signals: [],
    source_groups: sourceGroups(),
    decision_sufficiency: "sufficient_for_thesis",
    judgment_assessment_refs: [G22_SOLUTION_GENERATION_JUDGMENT, G22_SOLUTION_EVALUATION_JUDGMENT],
    audit_refs: [],
    source_boundary: boundary(),
    limitations: [SYNTHETIC],
  };
  const opportunityA = opportunity(
    runId,
    "opportunity_household",
    "SYNTHETIC household workflow",
    profile,
  );
  const opportunityB = opportunity(
    runId,
    "opportunity_household_variant",
    "SYNTHETIC household workflow alternate title",
    profile,
  );
  opportunityA.selected_delivery_form = solution.delivery_form;
  opportunityB.selected_delivery_form = solution.delivery_form;
  const solutionEvaluationSummary = {
    solution_evaluation_ref: G23_EVALUATION,
    solution_evaluation_content_hash: canonicalContentHash(evaluation),
    exploration_status:
      solutionExplorationVariant === "compared"
        ? "compared_multiple_formal_solutions"
        : "not_yet_explored",
    selection_posture:
      solutionExplorationVariant === "compared"
        ? "compared_selection"
        : "provisional_implementation",
    status_rationale:
      solutionExplorationVariant === "compared"
        ? "SYNTHETIC fixture compares three formal solutions with explicit selected/alternative/rejected closure."
        : "SYNTHETIC fixture declares one provisional solution without exploring other implementation approaches.",
    formal_solution_refs:
      solutionExplorationVariant === "compared" ? formalSolutionRefs : [G23_SOLUTION],
    formal_solutions: publishedFormalSolutionDocuments.map(([path, document, disposition]) => ({
      solution_ref: path,
      solution_content_hash: canonicalContentHash(document as Record<string, unknown>),
      disposition,
      solution_id: String((document as Record<string, unknown>).solution_id),
      solution_type: String((document as Record<string, unknown>).solution_type),
      solution_behavior: String((document as Record<string, unknown>).solution_behavior),
      delivery_form: String((document as Record<string, unknown>).delivery_form),
      uses_ai: Boolean((document as Record<string, unknown>).uses_ai),
    })),
    selected_solution_ref: G23_SOLUTION,
    alternative_solution_refs: solutionExplorationVariant === "compared" ? [G23_SOLUTION_ALT] : [],
    rejected_solutions:
      solutionExplorationVariant === "compared"
        ? structuredClone(evaluation.rejected_solutions)
        : [],
    considered_approaches: [],
    critical_unknowns: [SYNTHETIC],
    limitations: [SYNTHETIC],
  };
  opportunityA.solution_evaluation_summary = solutionEvaluationSummary;
  opportunityB.solution_evaluation_summary = structuredClone(solutionEvaluationSummary);
  if (solutionExplorationVariant === "compared") {
    opportunityA.alternative_solution_refs = [G23_SOLUTION_ALT];
    opportunityB.alternative_solution_refs = [G23_SOLUTION_ALT];
  }
  const opportunitySolutionSummaryRefs =
    solutionExplorationVariant === "compared" ? [G22_SOLUTION_EVALUATION_JUDGMENT] : [];
  const snapshot = {
    schema_version: "startup_opportunity.thesis_evaluation_snapshot.v1",
    snapshot_id: "snapshot_household",
    revision: 1,
    parent_snapshot_ref: null,
    parent_content_hash: null,
    run_id: runId,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    subject_refs: [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B],
    demand_thesis_refs: [G23_DEMAND],
    solution_hypothesis_refs: formalSolutionRefs,
    baseline_option_refs: [G23_BASELINE],
    solution_evaluation_refs: [G23_EVALUATION],
    business_model_assumptions: [SYNTHETIC],
    critical_assumptions: [SYNTHETIC],
    kill_criteria: [SYNTHETIC],
    generation_source_groups: [G22_GENERATION_MANIFEST],
    evaluation_source_groups: [G22_EVALUATION_MANIFEST],
    evaluation_questions: [SYNTHETIC],
    frozen_at: "2026-07-27T20:10:00Z",
    revision_policy: "new_immutable_snapshot_revision_required",
    enrichment_started: false,
    source_boundary: boundary(),
    limitations: [SYNTHETIC],
  };
  const merge = {
    schema_version: "startup_opportunity.merge.v1",
    merge_id: "merge_household",
    revision: 1,
    parent_merge_ref: null,
    parent_content_hash: null,
    run_id: runId,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    source_snapshot_ref: G23_SNAPSHOT,
    source_thesis_refs: [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B],
    merged_opportunities: [
      {
        cluster_id: "cluster_household",
        canonical_opportunity_ref: G23_OPPORTUNITY_A,
        member_thesis_refs: [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B],
      },
    ],
    merge_or_split_decisions: [
      {
        decision_id: "decision_merge_household",
        cluster_id: "cluster_household",
        decision: "merge",
        member_thesis_refs: [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B],
        semantic_basis: {
          user: SYNTHETIC,
          job: SYNTHETIC,
          entry_scene: SYNTHETIC,
          baseline: SYNTHETIC,
          solution: SYNTHETIC,
          buyer_logic: SYNTHETIC,
          acquisition_or_compliance_boundary: SYNTHETIC,
        },
        title_similarity_only: false,
        rationale: SYNTHETIC,
      },
    ],
    preserved_variants: [G23_OPPORTUNITY_B],
    opportunity_families: [
      {
        family_id: "family_household_coordination",
        title: "SYNTHETIC shared household coordination mechanism",
        family_relation: "shared_opportunity_family",
        members: [
          {
            opportunity_ref: G23_OPPORTUNITY_A,
            relation_to_family: "segment_variant",
          },
          {
            opportunity_ref: G23_OPPORTUNITY_B,
            relation_to_family: "delivery_or_implementation_variant",
          },
        ],
        shared_value_or_solution_mechanism: {
          state: "inferred",
          description:
            "SYNTHETIC shared coordination loop; this is research semantics, not a Harness inference.",
        },
        shared_assumptions: [SYNTHETIC],
        shared_failure_risks: [SYNTHETIC],
        member_specific_differences: [
          {
            opportunity_ref: G23_OPPORTUNITY_A,
            dimensions: [{ dimension: "user", state: "declared", description: SYNTHETIC }],
          },
          {
            opportunity_ref: G23_OPPORTUNITY_B,
            dimensions: [
              { dimension: "delivery_boundary", state: "partial", description: SYNTHETIC },
            ],
          },
        ],
        evidence_basis: {
          supporting_refs: [],
          opposing_refs: [],
          background_refs: [],
          unknown_refs: [],
          limitations: [SYNTHETIC],
          unresolved_questions: [SYNTHETIC],
        },
      },
    ],
    candidate_diversity_after_merge: {
      covered_users: [SYNTHETIC],
      covered_jobs: [SYNTHETIC],
      covered_entry_scenes: [SYNTHETIC],
      covered_buyer_models: [SYNTHETIC],
      known_blind_spots: [SYNTHETIC],
    },
    conflicts: [],
    audit_refs: [],
    source_boundary: boundary(),
    limitations: [SYNTHETIC],
  };

  const targetDocuments: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    [G23_DEMAND, demand, "2026-07-27T20:01:00Z"],
    [G23_BASELINE, baseline, "2026-07-27T20:01:00Z"],
    ...publishedFormalSolutionDocuments.map(
      ([path, document, , , , createdAt]) => [path, document, createdAt] as const,
    ),
  ] as const;
  const conversions: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    [
      G23_DEMAND_CONVERSION,
      conversion(
        runId,
        "candidate_demand",
        G22_DEMAND_R2,
        "demand_seed",
        2,
        canonicalContentHash(fixtureEffective(bundle, G22_DEMAND_R2)),
        G22_RETAINED_PRE_CANDIDATE,
        Number(retainedPreCandidate.revision),
        retainedPreCandidateHash,
        "startup_opportunity.demand_thesis.v1",
        G23_DEMAND,
        canonicalContentHash(demand),
      ),
    ],
    [
      G23_BASELINE_CONVERSION,
      conversion(
        runId,
        "candidate_baseline",
        G22_BASELINE_R1,
        "baseline_seed",
        1,
        canonicalContentHash(fixtureEffective(bundle, G22_BASELINE_R1)),
        G22_RETAINED_PRE_CANDIDATE,
        Number(retainedPreCandidate.revision),
        retainedPreCandidateHash,
        "startup_opportunity.baseline_option.v1",
        G23_BASELINE,
        canonicalContentHash(baseline),
      ),
    ],
    ...publishedFormalSolutionDocuments.map(
      ([path, document, , conversionRef, conversionId]) =>
        [
          conversionRef,
          conversion(
            runId,
            conversionId,
            G22_SOLUTION_R1,
            "solution_seed",
            1,
            canonicalContentHash(fixtureEffective(bundle, G22_SOLUTION_R1)),
            G22_RETAINED_PRE_CANDIDATE,
            Number(retainedPreCandidate.revision),
            retainedPreCandidateHash,
            "startup_opportunity.solution_hypothesis.v1",
            path,
            canonicalContentHash(document as Record<string, unknown>),
          ),
        ] as const,
    ),
  ] as const;
  const plan = fixtureEffective(bundle, G21_PLAN_REF);
  const priorExecution = fixtureEffective(bundle, "plans/research-execution.r1.json");
  const priorStage = (priorExecution.stages as Record<string, unknown>[])[0];
  const priorLanes = (priorStage?.lanes as Record<string, unknown>[] | undefined) ?? [];
  const ownerLane = priorLanes.find(
    (lane) =>
      (lane.incumbent_response_assignment as Record<string, unknown> | undefined)
        ?.assignment_role === "owner",
  );
  const synthesisLane = priorLanes.find((lane) => lane !== ownerLane);
  if (priorStage === undefined || ownerLane === undefined || synthesisLane === undefined) {
    throw new Error("synthetic G2.3 readiness fixture requires two candidate execution lanes");
  }
  const readinessExecution = {
    ...structuredClone(priorExecution),
    execution_plan_id: "execution_discovery_synthesis",
    revision: 2,
    parent_execution_plan_ref: "plans/research-execution.r1.json",
    created_at: "2026-07-27T19:55:00Z",
    total_time_budget_minutes: 20,
    stages: [
      {
        ...structuredClone(priorStage),
        stage_id: "stage_candidate_fan_in_complete",
        depends_on: [],
        gate_before: null,
        lanes: [structuredClone(ownerLane)],
      },
      {
        ...structuredClone(priorStage),
        stage_id: "stage_discovery_synthesis",
        stage_kind: "discovery_synthesis",
        depends_on: ["stage_candidate_fan_in_complete"],
        gate_before: G23_READINESS,
        gate_after: "required",
        lanes: [
          {
            ...structuredClone(synthesisLane),
            incumbent_response_assignment: {
              analysis_depth: "not_assigned",
              assignment_role: "none",
              subject_refs: [],
              rationale: "SYNTHETIC synthesis stage performs no incumbent response research.",
            },
          },
        ],
      },
    ],
    limitations: [
      "SYNTHETIC G2.3 execution overlay; it records the entry boundary and performs no research.",
    ],
  };
  const judgmentRefs = [
    G22_JUDGMENT,
    G22_DEMAND_EVALUATION_JUDGMENT,
    G22_BASELINE_GENERATION_JUDGMENT,
    G22_BASELINE_EVALUATION_JUDGMENT,
    G22_SOLUTION_GENERATION_JUDGMENT,
    G22_SOLUTION_EVALUATION_JUDGMENT,
  ];
  const questionCoverage = (plan.research_questions as Record<string, unknown>[]).map(
    (question, index) => {
      const judgmentRef = judgmentRefs[index % judgmentRefs.length] as string;
      return {
        question_ref: `${G21_PLAN_REF}#${String(question.question_id)}`,
        status: "answered",
        judgment_refs: [judgmentRef],
        evidence_refs: [],
        basis_refs: [judgmentRef],
      };
    },
  );
  const candidateRoles = (fanIn.candidate_dispositions as Record<string, unknown>[]).map(
    (disposition) => {
      const candidateRef = String(disposition.candidate_ref);
      const candidateKind = String(fixtureEffective(bundle, candidateRef).candidate_kind);
      const reportingRole =
        candidateKind === "demand_seed"
          ? "opportunity_direction"
          : candidateKind === "baseline_seed"
            ? "comparison_baseline"
            : "solution_hypothesis";
      return {
        candidate_ref: candidateRef,
        candidate_kind: candidateKind,
        reporting_role: reportingRole,
        disposition: disposition.disposition,
      };
    },
  );
  const preCandidateRoles = (fanIn.pre_candidate_dispositions as Record<string, unknown>[]).map(
    (disposition) => ({
      pre_candidate_ref: String(disposition.pre_candidate_ref),
      disposition: String(disposition.disposition),
    }),
  );
  const readiness = {
    schema_version: "startup_opportunity.discovery_stage_readiness.v1",
    readiness_id: "readiness_discovery_synthesis",
    revision: 1,
    run_id: runId,
    research_plan_ref: G21_PLAN_REF,
    execution_plan_ref: G23_EXECUTION,
    stage_id: "stage_candidate_fan_in_complete",
    next_stage_id: "stage_discovery_synthesis",
    source_fan_in_ref: G22_FAN_IN,
    generation_result_refs: [],
    candidate_roles: candidateRoles,
    pre_candidate_roles: preCandidateRoles,
    required_candidate_kinds: ["demand_seed", "baseline_seed", "solution_seed"],
    missing_candidate_kinds: [],
    question_coverage: questionCoverage,
    commercial_signal_gate: {
      demand_signal: true,
      buyer_signal: false,
      purchase_signal: false,
      decision: "continue_research",
    },
    next_stage_readiness: "ready",
    blockers: [],
    allowed_next_actions: ["continue_stage"],
    stop_basis: null,
    limitations: [
      "SYNTHETIC readiness: questions are dispositioned by insufficient Judgments; no validation success is claimed.",
    ],
  };
  const readinessGap = {
    schema_version: "startup_opportunity.gap_snapshot.discovery.readiness.current",
    snapshot_id: "discovery_synthesis_readiness",
    snapshot_cycle_key: canonicalContentHash({
      run_id: runId,
      plan_ref: G21_PLAN_REF,
      readiness_ref: G23_READINESS,
      fan_in_ref: G22_FAN_IN,
    }),
    run_id: runId,
    based_on_plan_ref: G21_PLAN_REF,
    revision: 1,
    parent_snapshot_ref: null,
    created_at: "2026-07-27T19:58:00Z",
    trigger_kind: "wave_completed",
    trigger_event_ref: null,
    phase: "discovery",
    wave_id: "wave_discovery_synthetic",
    readiness_ref: G23_READINESS,
    fan_in_ref: G22_FAN_IN,
    observed_artifact_refs: [G23_READINESS, G22_FAN_IN],
    gaps: [],
    material_new_evidence_observed: false,
    unresolved_decision_relevant_questions: [],
    stop_signals: [],
  };
  const entries: FormalArtifactEnvelope[] = [
    envelope(
      runId,
      G23_EXECUTION,
      readinessExecution,
      [G21_PLAN_REF, "plans/research-execution.r1.json"],
      "2026-07-27T19:55:00Z",
    ),
    envelope(
      runId,
      G23_READINESS,
      readiness,
      [
        G21_PLAN_REF,
        G23_EXECUTION,
        G22_FAN_IN,
        ...candidateRoles.map((role) => String(role.candidate_ref)),
        ...preCandidateRoles.map((role) => String(role.pre_candidate_ref)),
        ...judgmentRefs,
      ],
      "2026-07-27T19:57:00Z",
    ),
    envelope(
      runId,
      G23_READINESS_GAP,
      readinessGap,
      [G21_PLAN_REF, G23_READINESS, G22_FAN_IN],
      "2026-07-27T19:58:00Z",
      "harness",
    ),
  ];
  for (const [path, document] of conversions) {
    entries.push(
      envelope(
        runId,
        path,
        document,
        [
          G21_SCOPE_REF,
          G21_PLAN_REF,
          G22_FAN_IN,
          String(document.source_candidate_ref),
          String(document.source_pre_candidate_ref),
          String(document.target_artifact_ref),
        ],
        "2026-07-27T20:00:00Z",
      ),
    );
  }
  const publishedSolutionTargetInputs: readonly [string, readonly string[]][] =
    publishedFormalSolutionDocuments.map(([path, _document, _disposition, conversionRef]) => [
      path,
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        G22_FAN_IN,
        conversionRef,
        G22_SOLUTION_R1,
        G22_RETAINED_PRE_CANDIDATE,
        G23_DEMAND,
        G23_BASELINE,
        G22_GENERATION_CLAIM,
        G22_EVALUATION_CLAIM,
        G22_SOLUTION_GENERATION_JUDGMENT,
        G22_SOLUTION_EVALUATION_JUDGMENT,
      ],
    ]);
  const targetInputs = new Map<string, readonly string[]>([
    [
      G23_DEMAND,
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        G22_FAN_IN,
        G23_DEMAND_CONVERSION,
        G22_DEMAND_R2,
        G22_RETAINED_PRE_CANDIDATE,
        G22_GENERATION_MANIFEST,
        G22_EVALUATION_MANIFEST,
        G22_GENERATION_CLAIM,
        G22_EVALUATION_CLAIM,
        G22_JUDGMENT,
        G22_DEMAND_EVALUATION_JUDGMENT,
      ],
    ],
    [
      G23_BASELINE,
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        G22_FAN_IN,
        G23_BASELINE_CONVERSION,
        G22_BASELINE_R1,
        G22_RETAINED_PRE_CANDIDATE,
        G23_DEMAND,
        G22_BASELINE_GENERATION_JUDGMENT,
        G22_BASELINE_EVALUATION_JUDGMENT,
      ],
    ],
    [
      G23_SOLUTION,
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        G22_FAN_IN,
        G23_SOLUTION_CONVERSION,
        G22_SOLUTION_R1,
        G22_RETAINED_PRE_CANDIDATE,
        G23_DEMAND,
        G23_BASELINE,
        G22_GENERATION_CLAIM,
        G22_EVALUATION_CLAIM,
        G22_SOLUTION_GENERATION_JUDGMENT,
        G22_SOLUTION_EVALUATION_JUDGMENT,
      ],
    ],
    ...publishedSolutionTargetInputs,
  ]);
  for (const [path, document, createdAt] of targetDocuments) {
    entries.push(
      envelope(
        runId,
        path,
        document as Record<string, unknown>,
        targetInputs.get(path) ?? [],
        createdAt,
      ),
    );
  }
  entries.push(
    envelope(
      runId,
      G23_EVALUATION,
      evaluation,
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        G22_FAN_IN,
        G23_DEMAND,
        G23_BASELINE,
        ...formalSolutionRefs,
        G22_GENERATION_MANIFEST,
        G22_EVALUATION_MANIFEST,
        G22_SOLUTION_GENERATION_JUDGMENT,
        G22_SOLUTION_EVALUATION_JUDGMENT,
      ],
      "2026-07-27T20:03:00Z",
    ),
    envelope(
      runId,
      G23_OPPORTUNITY_A,
      opportunityA,
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        G22_FAN_IN,
        G22_RETAINED_PRE_CANDIDATE,
        G23_DEMAND,
        G23_BASELINE,
        ...formalSolutionRefs,
        G23_EVALUATION,
        G22_GENERATION_LANE,
        G22_EVALUATION_LANE,
        G22_INSIGHT,
        G22_EVALUATION_CLAIM,
        G22_JUDGMENT,
        G22_DEMAND_EVALUATION_JUDGMENT,
        ...opportunitySolutionSummaryRefs,
      ],
      "2026-07-27T20:05:00Z",
    ),
    envelope(
      runId,
      G23_OPPORTUNITY_B,
      opportunityB,
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        G22_FAN_IN,
        G22_RETAINED_PRE_CANDIDATE,
        G23_DEMAND,
        G23_BASELINE,
        ...formalSolutionRefs,
        G23_EVALUATION,
        G22_GENERATION_LANE,
        G22_EVALUATION_LANE,
        G22_INSIGHT,
        G22_EVALUATION_CLAIM,
        G22_JUDGMENT,
        G22_DEMAND_EVALUATION_JUDGMENT,
        ...opportunitySolutionSummaryRefs,
      ],
      "2026-07-27T20:06:00Z",
    ),
    envelope(
      runId,
      G23_SNAPSHOT,
      snapshot,
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        G23_OPPORTUNITY_A,
        G23_OPPORTUNITY_B,
        G23_DEMAND,
        G23_BASELINE,
        ...formalSolutionRefs,
        G23_EVALUATION,
        G22_GENERATION_MANIFEST,
        G22_EVALUATION_MANIFEST,
      ],
      "2026-07-27T20:10:00Z",
    ),
    envelope(
      runId,
      G23_MERGE,
      merge,
      [G21_SCOPE_REF, G21_PLAN_REF, G23_SNAPSHOT, G23_OPPORTUNITY_A, G23_OPPORTUNITY_B],
      "2026-07-27T20:11:00Z",
    ),
  );
  mutable.documents.push(
    ...entries.map((document) => ({
      path: document.artifact_path,
      document: document as unknown as Record<string, unknown>,
    })),
  );
  mutable.exact_records.push({
    ref: G23_PRE_CANDIDATE_INTEREST_DECISION_REF,
    document: preCandidateInterestDecision,
  });
  const manifest = fixtureEffective(bundle, "manifest.json");
  manifest.latest_gap_snapshot_ref = G23_READINESS_GAP;
  manifest.current_discovery_fan_in_ref = G22_FAN_IN;
  manifest.current_discovery_fan_in_hash = fanInEnvelope.content_hash;
  manifest.current_pre_candidate_confirmation_ref = G23_PRE_CANDIDATE_INTEREST_DECISION_REF;
  manifest.current_pre_candidate_confirmation_hash = canonicalContentHash(
    preCandidateInterestDecision,
  );
  manifest.current_pre_candidate_confirmation_action = "proceed_with_selected";
  manifest.artifact_refs = [
    ...new Set([
      ...((manifest.artifact_refs as string[] | undefined) ?? []),
      ...entries.map((document) => document.artifact_path),
    ]),
  ].sort();
  return bundle;
}

export function discoverySynthesisReadinessEnvelopes(
  bundle: DocumentBundle,
): readonly FormalArtifactEnvelope[] {
  return [G23_EXECUTION, G23_READINESS, G23_READINESS_GAP].map((artifactPath) =>
    synthesisEnvelope(bundle, artifactPath),
  );
}

export function synthesisEnvelope(
  bundle: DocumentBundle,
  artifactPath: string,
): FormalArtifactEnvelope {
  return fixtureEntry(bundle, artifactPath) as unknown as FormalArtifactEnvelope;
}

export type { DiscoveryRuntimeSubstrate, EvidenceStoreRecord };

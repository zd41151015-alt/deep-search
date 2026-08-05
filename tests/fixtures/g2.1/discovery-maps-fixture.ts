import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  type DiscoveryProfile,
  type DocumentBundle,
  type FormalArtifactEnvelope,
} from "../../../harness/src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export const G21_DECISION_REF = "decision-context.json";
export const G21_INTAKE_REF = "intake.json";
export const G21_SCOPE_REF = "scope-frame.json";
export const G21_PLAN_REF = "plans/research-plan.r1.json";
export const G21_SEED_REF = "artifacts/discovery/seed-probe.r1.json";
export const G21_OPPORTUNITY_REF = "artifacts/discovery/opportunity-space-map.r1.json";
export const G21_SOLUTION_REF = "artifacts/discovery/solution-space-map.r1.json";

export const G21_CORE_REFS = [
  G21_DECISION_REF,
  G21_INTAKE_REF,
  G21_SCOPE_REF,
  G21_PLAN_REF,
] as const;

export const G21_MAP_REFS = [G21_SEED_REF, G21_OPPORTUNITY_REF, G21_SOLUTION_REF] as const;

const createdAt = "2026-07-26T17:00:00Z";

function synthetic(value: string): string {
  return `SYNTHETIC ${value}; not Evidence or external validation.`;
}

function hypothesis(id: string, label: string): Record<string, unknown> {
  return {
    hypothesis_id: id,
    label: synthetic(label),
    status: "unvalidated_hypothesis",
    evidence_refs: [],
  };
}

function question(id: string, kind: string, label: string): Record<string, unknown> {
  return {
    question_id: id,
    question_kind: kind,
    question: synthetic(label),
    decision_impact: synthetic(`answering ${id} may change retained search directions`),
    uncertainty: "unknown",
    expected_information_gain: "high",
    stop_condition: synthetic(`stop ${id} when the future owning lane reaches its source limit`),
    hypothesis_status: "unvalidated_question",
  };
}

function planQuestion(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    [
      "question_id",
      "question",
      "decision_impact",
      "uncertainty",
      "expected_information_gain",
      "stop_condition",
    ].map((key) => [key, value[key]]),
  );
}

function seedEntry(id: string, kind: string): Record<string, unknown> {
  return {
    seed_id: id,
    seed_kind: kind,
    value: synthetic(`${kind} search-entry seed`),
    use: "search_entry_only",
    evidence_use: "forbidden",
  };
}

function sourceBoundary(): Record<string, unknown> {
  return {
    research_performed: false,
    network_accessed: false,
    seeds_are_evidence: false,
    chat_is_artifact: false,
    task_completion_is_artifact: false,
    external_validation_claimed: false,
  };
}

function envelope(
  runId: string,
  artifactPath: string,
  document: Record<string, unknown>,
  inputRefs: readonly string[],
  producerRole = "main_agent",
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    run_id: runId,
    created_at: createdAt,
    producer_role: producerRole,
    input_refs: [...inputRefs],
    content_hash: canonicalContentHash(document),
    document,
  };
}

function unit(
  unitId: string,
  unitType: string,
  inputRefs: readonly string[],
): Record<string, unknown> {
  return {
    unit_id: unitId,
    unit_type: unitType,
    plan_disposition: "enabled",
    priority_band: "high",
    attempt: 1,
    supersedes_unit_ref: null,
    research_goal: synthetic(`${unitType} is future lane work and is not executed by G2.1`),
    input_refs: [...inputRefs],
    agent_role: "lane-researcher",
    output_path: `artifacts/lanes/${unitId}.synthetic.json`,
    required_artifact_schema: "startup_opportunity.discovery_lane_result.v1",
    source_preferences: [synthetic("future source preference")],
    required_outputs: [synthetic("future lane result")],
    stop_conditions: [synthetic("future lane stop boundary")],
  };
}

function solutionCandidate(
  solutionClass: string,
  deliveryForms: readonly string[],
  usesAi = false,
): Record<string, unknown> {
  return {
    candidate_id: `solution_${solutionClass}`,
    solution_class: solutionClass,
    description: synthetic(`${solutionClass} option inside the same demand boundary`),
    delivery_forms: [...deliveryForms],
    uses_ai: usesAi,
    selected: false,
    formal_solution_hypothesis: false,
    status: "unvalidated_option",
    evidence_refs: [],
  };
}

function effective(bundle: DocumentBundle, artifactPath: string): Record<string, unknown> {
  const stored = bundle.documents.find((entry) => entry.path === artifactPath)?.document;
  if (stored === undefined) {
    throw new Error(`missing synthetic fixture document: ${artifactPath}`);
  }
  return String(stored.schema_version).startsWith("startup_opportunity.artifact_envelope.")
    ? (stored.document as Record<string, unknown>)
    : stored;
}

function stored(bundle: DocumentBundle, artifactPath: string): Record<string, unknown> {
  const document = bundle.documents.find((entry) => entry.path === artifactPath)?.document;
  if (document === undefined) {
    throw new Error(`missing synthetic fixture envelope: ${artifactPath}`);
  }
  return document;
}

function replaceInputHashes(
  bundle: DocumentBundle,
  artifactPath: string,
  inputRefs: readonly string[],
): void {
  effective(bundle, artifactPath).input_artifact_hashes = inputRefs.map((ref) => ({
    ref,
    content_hash: String(stored(bundle, ref).content_hash),
  }));
}

export function refreshDiscoveryMapsBundle(bundle: DocumentBundle): DocumentBundle {
  for (const ref of G21_CORE_REFS) {
    const entry = stored(bundle, ref);
    entry.content_hash = canonicalContentHash(entry.document);
  }
  replaceInputHashes(bundle, G21_SEED_REF, [G21_SCOPE_REF, G21_PLAN_REF]);
  stored(bundle, G21_SEED_REF).content_hash = canonicalContentHash(effective(bundle, G21_SEED_REF));
  replaceInputHashes(bundle, G21_OPPORTUNITY_REF, [G21_SCOPE_REF, G21_SEED_REF, G21_PLAN_REF]);
  stored(bundle, G21_OPPORTUNITY_REF).content_hash = canonicalContentHash(
    effective(bundle, G21_OPPORTUNITY_REF),
  );
  replaceInputHashes(bundle, G21_SOLUTION_REF, [
    G21_SCOPE_REF,
    G21_SEED_REF,
    G21_OPPORTUNITY_REF,
    G21_PLAN_REF,
  ]);
  stored(bundle, G21_SOLUTION_REF).content_hash = canonicalContentHash(
    effective(bundle, G21_SOLUTION_REF),
  );
  return bundle;
}

export function fixtureDocument(
  bundle: DocumentBundle,
  artifactPath: string,
): Record<string, unknown> {
  return effective(bundle, artifactPath);
}

export function fixtureEnvelope(
  bundle: DocumentBundle,
  artifactPath: string,
): FormalArtifactEnvelope {
  return stored(bundle, artifactPath) as FormalArtifactEnvelope;
}

export async function createDiscoveryMapsFixture(
  profile: DiscoveryProfile,
  runId = `g2-1-${profile.replaceAll("_", "-")}-synthetic`,
  additionalPlanWaves: readonly Record<string, unknown>[] = [],
): Promise<DocumentBundle> {
  const policy = JSON.parse(
    await readFile(path.join(repositoryRoot, "harness/policies/discovery-maps.v1.json"), "utf8"),
  ) as Record<string, unknown>;
  const policyBinding = {
    policy_ref: "harness/policies/discovery-maps.v1.json",
    policy_schema_version: "startup_opportunity.discovery_maps_policy.v1",
    policy_version: "1.0.0",
    content_hash: canonicalContentHash(policy),
  };
  const questions = [
    question("question_demand", "demand", "which recurring demand exists without seed support"),
    question("question_workflow", "workflow", "where the current workflow breaks"),
    question("question_alternative", "alternative", "which baseline or workaround is preferred"),
    question("question_buyer", "buyer", "which buyer and payer language indicates intent"),
    question(
      "question_counterfactual",
      "counterfactual",
      "whether another user, job, scene, or alternative disproves the seed framing",
    ),
    ...(profile === "ai_first" || profile === "hybrid"
      ? [question("question_ai_boundary", "ai_boundary", "where AI capability should not be used")]
      : []),
  ];
  const decision = {
    schema_version: "startup_opportunity.decision_context.v1",
    run_id: runId,
    decision_to_make: "choose_opportunity",
    decision_question: synthetic("which opportunity deserves later evidence research"),
    decision_options: [synthetic("continue discovery"), synthetic("stop discovery")],
    venture_goal: "strategic_exploration",
    decision_horizon: synthetic("no decision horizon is validated"),
    founder_advantages: [],
    non_negotiable_constraints: [synthetic("G2.1 performs no research")],
    team_capability_refs: [],
    risk_preferences: [synthetic("prefer reversible hypotheses")],
    initial_belief: synthetic("no opportunity is established"),
    favored_hypothesis: null,
    assumed_truths: [],
    final_decision_owner: "user",
    assumptions: [synthetic("all map content is pre-research")],
    open_questions: [synthetic("demand remains unknown")],
  };
  const intake = {
    schema_version: "startup_opportunity.intake.v1",
    run_id: runId,
    action: "discover",
    mode: "opportunity_discovery",
    raw_query: synthetic(`${profile} discovery request`),
    market: "synthetic-primary-market",
    language: "en-SYNTHETIC",
    principal: "synthetic_principal",
    scope_confirmation: {
      geography: "synthetic-primary-market",
      customer_model: "b2c",
      target_users: [synthetic("primary user")],
      decision_goal: synthetic("identify directions that merit further validation"),
      research_language: "en-SYNTHETIC",
      user_confirmed: true,
    },
    decision_context_ref: G21_DECISION_REF,
    attachments: [],
    explicit_constraints: {
      target_market: "synthetic-primary-market",
      target_language: "en-SYNTHETIC",
      venture_goal: "strategic_exploration",
      target_users: [synthetic("primary user")],
      delivery_form_preferences: ["mobile_web"],
      ai_scope: profile === "ai_first" || profile === "hybrid" ? "priority_seed" : "optional",
      research_axes: ["jtbd_workflow", "solution_failure"],
    },
    created_at: createdAt,
  };
  const scope = {
    schema_version: "startup_opportunity.scope_frame.v2",
    run_id: runId,
    mode: "opportunity_discovery",
    decision_context_ref: G21_DECISION_REF,
    direction: synthetic(`${profile} direction`),
    discovery_profile: profile,
    research_axes: ["user_language", "jtbd_workflow", "solution_failure", "buyer_market"],
    market: "synthetic-primary-market",
    language: "en-SYNTHETIC",
    target_users: [synthetic("primary user")],
    excluded_users: [synthetic("excluded user")],
    platform: synthetic("delivery platform is undecided"),
    market_motion: "consumer",
    acquisition_motion: ["direct"],
    buyer_models: ["self_payer"],
    payment_modes: ["subscription"],
    native_app_required: false,
    delivery_form_preferences: ["mobile_web"],
    business_model_preferences: [synthetic("business model is unvalidated")],
    team_capability_constraints: [synthetic("small implementation team")],
    risk_preferences: [synthetic("avoid irreversible external tests")],
    ai_scope: profile === "ai_first" || profile === "hybrid" ? "priority_seed" : "optional",
    assumptions: [synthetic("scope is user supplied and not Evidence")],
    open_questions: [synthetic("all demand questions remain open")],
  };
  const demandUnitId = "unit_seed_independent_demand";
  const counterfactualUnitId = "unit_counterfactual";
  const plan = {
    schema_version: "startup_opportunity.research_plan.v1",
    plan_id: "research_plan_g2_1_synthetic",
    run_id: runId,
    mode: "opportunity_discovery",
    revision: 1,
    parent_plan_ref: null,
    triggered_by_adaptation_refs: [],
    created_at: createdAt,
    research_questions: questions.map(planQuestion),
    candidate_retention_policy: {
      minimum_evidence_requirement: synthetic("future lane evidence minimum"),
      candidate_retention_threshold: synthetic("no fixed TopN at map stage"),
      candidate_diversity_policy: [
        synthetic("retain different users jobs scenes buyers delivery forms and sources"),
      ],
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
        wave_id: "wave_discovery_synthetic",
        depends_on: [],
        units: [
          unit(demandUnitId, "user_language_mining", [G21_SCOPE_REF]),
          unit(counterfactualUnitId, "counter_evidence", [G21_SCOPE_REF]),
        ],
      },
      ...structuredClone(additionalPlanWaves),
    ],
    adaptation_policy_ref: "harness/policies/adaptation.v1.json",
    followup_policy: {
      max_followup_rounds: 1,
      require_decision_relevance: true,
      stop_when_no_material_new_evidence: true,
    },
  };
  const families = Object.fromEntries(
    [
      "direction",
      "audience",
      "scenario",
      "problem",
      "keyword",
      "product",
      "source",
      "capability",
      "model_ecosystem",
    ].map((family) => [family, []]),
  ) as Record<string, Record<string, unknown>[]>;
  const requiredFamilies: Record<DiscoveryProfile, readonly string[]> = {
    general: ["scenario", "problem"],
    industry_first: ["direction", "audience", "problem"],
    ai_first: ["problem", "capability", "model_ecosystem"],
    hybrid: ["direction", "problem", "capability", "model_ecosystem"],
  };
  for (const family of requiredFamilies[profile]) {
    families[family]?.push(seedEntry(`seed_${family}`, family));
  }
  const seed = {
    schema_version: "startup_opportunity.seed_probe.v1",
    seed_probe_id: "seed_probe_g2_1_synthetic",
    revision: 1,
    parent_seed_probe_ref: null,
    run_id: runId,
    mode: "opportunity_discovery",
    discovery_profile: profile,
    market: scope.market,
    language: scope.language,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    seed_families: families,
    initial_questions: questions,
    unit_contracts: {
      seed_independent_demand_task: {
        unit_ref: `${G21_PLAN_REF}#${demandUnitId}`,
        unit_id: demandUnitId,
        input_refs: [G21_SCOPE_REF],
        reads_scope_only: true,
        consumes_product_seeds: false,
        consumes_capability_seeds: false,
      },
      counterfactual: {
        unit_ref: `${G21_PLAN_REF}#${counterfactualUnitId}`,
        unit_id: counterfactualUnitId,
        counterfactual_dimensions: ["user", "job", "scene", "alternative"],
        independent_from_seed_similarity: true,
      },
    },
    seed_policy: {
      expands_search_entry_only: true,
      may_support_startup_opportunity: false,
      may_support_demand_thesis: false,
      may_affect_scoring: false,
      may_claim_success_probability: false,
    },
    input_artifact_hashes: [],
    policy_binding: policyBinding,
    evidence_refs: [],
    audit_refs: [],
    source_boundary: sourceBoundary(),
    limitations: [synthetic("Seed Probe only expands future search entry")],
  };
  const opportunity = {
    schema_version: "startup_opportunity.opportunity_space_map.v1",
    map_id: "opportunity_space_map_g2_1_synthetic",
    revision: 1,
    parent_map_ref: null,
    run_id: runId,
    mode: "opportunity_discovery",
    discovery_profile: profile,
    market: scope.market,
    language: scope.language,
    scope_frame_ref: G21_SCOPE_REF,
    seed_probe_ref: G21_SEED_REF,
    research_plan_ref: G21_PLAN_REF,
    demand_boundary_id: "demand_boundary_g2_1_synthetic",
    solution_neutral: true,
    formal_opportunity_thesis_created: false,
    user_roles: [hypothesis("role_user", "possible user role")],
    buyer_roles: [hypothesis("role_buyer", "possible buyer role")],
    payer_roles: [hypothesis("role_payer", "possible payer role")],
    decision_makers: [hypothesis("role_decision_maker", "possible decision maker")],
    jobs_to_be_done: [hypothesis("jtbd_primary", "possible job to be done")],
    workflow_maps: [hypothesis("workflow_current", "possible current workflow")],
    task_operating_profiles: [
      {
        profile_id: "task_profile_synthetic",
        frequency: synthetic("frequency unknown"),
        volume: synthetic("volume unknown"),
        input_modalities: [synthetic("input modality unknown")],
        output_modalities: [synthetic("output modality unknown")],
        variability: synthetic("variability unknown"),
        exception_rate: synthetic("exception rate unknown"),
        context_fragmentation: synthetic("context fragmentation unknown"),
        judgment_intensity: synthetic("judgment intensity unknown"),
        latency_tolerance: synthetic("latency tolerance unknown"),
        error_cost: synthetic("error cost unknown"),
        human_review_tolerance: synthetic("human review tolerance unknown"),
        status: "unvalidated_hypothesis",
        evidence_refs: [],
      },
    ],
    current_alternatives: [hypothesis("alternative_current", "possible current alternative")],
    baseline_options: [hypothesis("baseline_option", "possible Baseline Option")],
    workaround_patterns: [hypothesis("workaround_pattern", "possible workaround")],
    workflow_friction_points: [hypothesis("friction_point", "possible workflow friction")],
    non_consumption: [hypothesis("non_consumption", "possible non-consumption")],
    software_leverage_points: [hypothesis("software_leverage", "possible software leverage")],
    state_context_opportunities: [hypothesis("state_context", "possible state/context opening")],
    buyer_purchase_language_hypotheses: [
      question("buyer_language_hypothesis", "buyer", "which purchase language is actually used"),
    ],
    initial_demand_hypotheses: [
      {
        hypothesis_id: "demand_seed_independent",
        question: synthetic("does the scoped task recur without any product or capability seed"),
        seed_dependency: "seed_independent",
        status: "unvalidated_question",
        formal_demand_thesis: false,
        evidence_refs: [],
      },
      {
        hypothesis_id: "demand_seed_expanded",
        question: synthetic("does the seed expose another demand search entry"),
        seed_dependency: "seed_expanded",
        status: "unvalidated_question",
        formal_demand_thesis: false,
        evidence_refs: [],
      },
    ],
    disconfirming_questions: [
      question(
        "opportunity_counterfactual",
        "counterfactual",
        "does another user job scene or alternative invalidate this demand boundary",
      ),
    ],
    input_artifact_hashes: [],
    policy_binding: policyBinding,
    evidence_refs: [],
    audit_refs: [],
    source_boundary: sourceBoundary(),
    limitations: [synthetic("Opportunity Space Map contains questions and hypotheses only")],
  };
  const aiHypothesis = (field: string) => [hypothesis(`ai_${field}`, `${field} remains unknown`)];
  const solution = {
    schema_version: "startup_opportunity.solution_space_map.v1",
    map_id: "solution_space_map_g2_1_synthetic",
    revision: 1,
    parent_map_ref: null,
    run_id: runId,
    mode: "opportunity_discovery",
    discovery_profile: profile,
    market: scope.market,
    language: scope.language,
    scope_frame_ref: G21_SCOPE_REF,
    seed_probe_ref: G21_SEED_REF,
    opportunity_space_map_ref: G21_OPPORTUNITY_REF,
    research_plan_ref: G21_PLAN_REF,
    demand_boundary_id: opportunity.demand_boundary_id,
    solution_neutral_demand_boundary: true,
    formal_opportunity_created: false,
    selected_solution_created: false,
    solution_candidates: [
      solutionCandidate("ordinary_software", ["mobile_web"]),
      solutionCandidate("platform_native", ["platform_native"]),
      solutionCandidate("human_or_service_assisted", ["service_assisted"]),
      solutionCandidate("native_app", ["native_app"]),
      solutionCandidate("mini_program", ["mini_program"]),
      solutionCandidate("mobile_web_or_pwa", ["mobile_web", "PWA"]),
      solutionCandidate("hybrid_app", ["hybrid_app"]),
      solutionCandidate("ai_assisted", ["mobile_web"], true),
      solutionCandidate("status_quo", ["status_quo"]),
    ],
    ai_boundary: {
      applicability: "applicable_as_solution_option",
      capability_seed_only_cannot_form_opportunity: true,
      capability_frontier: aiHypothesis("capability_frontier"),
      failure_modes: aiHypothesis("failure_modes"),
      human_review_boundaries: aiHypothesis("human_review_boundaries"),
      data_and_evaluation_requirements: aiHypothesis("data_and_evaluation_requirements"),
      provider_landscape: aiHypothesis("provider_landscape"),
      open_source_landscape: aiHypothesis("open_source_landscape"),
      capability_half_life: aiHypothesis("capability_half_life"),
      evidence_refs: [],
    },
    disconfirming_questions: [
      question("solution_disconfirmation", "solution", "does status quo dominate every option"),
    ],
    input_artifact_hashes: [],
    policy_binding: policyBinding,
    evidence_refs: [],
    audit_refs: [],
    source_boundary: sourceBoundary(),
    limitations: [synthetic("Solution Space Map selects no solution")],
  };
  const coreEnvelopes = [
    envelope(runId, G21_DECISION_REF, decision, []),
    envelope(runId, G21_INTAKE_REF, intake, [G21_DECISION_REF]),
    envelope(runId, G21_SCOPE_REF, scope, [G21_DECISION_REF]),
    envelope(runId, G21_PLAN_REF, plan, [G21_SCOPE_REF]),
  ];
  const mapEnvelopes = [
    envelope(runId, G21_SEED_REF, seed, [G21_SCOPE_REF, G21_PLAN_REF]),
    envelope(runId, G21_OPPORTUNITY_REF, opportunity, [G21_SCOPE_REF, G21_SEED_REF, G21_PLAN_REF]),
    envelope(runId, G21_SOLUTION_REF, solution, [
      G21_SCOPE_REF,
      G21_SEED_REF,
      G21_OPPORTUNITY_REF,
      G21_PLAN_REF,
    ]),
  ];
  const confirmedScope = {
    revision: 1,
    geography: "synthetic-primary-market",
    customer_model: "b2c",
    target_users: [synthetic("primary user")],
    decision_goal: synthetic("identify directions that merit further validation"),
    research_language: "en-SYNTHETIC",
  };
  const scopeProposalDecision = {
    schema_version: "startup_opportunity.decision.v1",
    decision_id: "scope_proposal_r1_fixture",
    run_id: runId,
    decision_type: "scope_proposed",
    timestamp: createdAt,
    actor: "main_agent",
    reason: synthetic("the main agent proposed this exact visible scope"),
    artifact_refs: [],
    scope_revision: 1,
    scope_hash: canonicalContentHash(confirmedScope),
    scope: confirmedScope,
  };
  const scopeProposalRef = "decisions.jsonl#scope_proposal_r1_fixture";
  const scopeConfirmationDecision = {
    ...scopeProposalDecision,
    decision_id: "scope_confirmation_r1_fixture",
    decision_type: "scope_assumption_confirmed",
    reason: synthetic("the fixture caller attests exact user confirmation"),
    scope_proposal_ref: scopeProposalRef,
    scope_proposal_hash: canonicalContentHash(scopeProposalDecision),
    confirmation_basis: "caller_attested_user_confirmation",
    harness_identity_verification: "not_available",
  };
  const manifest = {
    schema_version: "startup_opportunity.run_manifest.v1",
    run_id: runId,
    mode: "opportunity_discovery",
    status: "planned",
    status_before_clarification: null,
    parent_run_id: null,
    scope_proposal_ref: scopeProposalRef,
    scope_proposal_hash: canonicalContentHash(scopeProposalDecision),
    scope_confirmation_ref: "decisions.jsonl#scope_confirmation_r1_fixture",
    scope_confirmation_hash: canonicalContentHash(scopeConfirmationDecision),
    scope_revision: 1,
    created_at: createdAt,
    updated_at: createdAt,
    current_phase: "discovery",
    current_plan_ref: G21_PLAN_REF,
    plan_revision: 1,
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
    artifact_refs: [...G21_CORE_REFS, ...G21_MAP_REFS].sort(),
    checkpoint_ref: null,
    limitations: [synthetic("G2.1 map fixture performs no research")],
  };
  const bundle: DocumentBundle = {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: "manifest.json", document: manifest },
      ...[...coreEnvelopes, ...mapEnvelopes].map((item) => ({
        path: item.artifact_path,
        document: item,
      })),
    ],
    exact_records: [
      {
        ref: scopeProposalRef,
        document: scopeProposalDecision,
      },
      {
        ref: "decisions.jsonl#scope_confirmation_r1_fixture",
        document: scopeConfirmationDecision,
      },
    ],
  };
  return refreshDiscoveryMapsBundle(bundle);
}

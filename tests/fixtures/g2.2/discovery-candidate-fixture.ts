import {
  canonicalContentHash,
  type DiscoveryProfile,
  type DocumentBundle,
} from "../../../harness/src/index.js";
import { discoveryWaveEnvelopes } from "../../helpers/discovery-wave.js";
import {
  createDiscoveryMapsFixture,
  fixtureDocument,
  fixtureEnvelope,
  G21_OPPORTUNITY_REF,
  G21_PLAN_REF,
  G21_SCOPE_REF,
  G21_SOLUTION_REF,
  refreshDiscoveryMapsBundle,
} from "../g2.1/discovery-maps-fixture.js";

export const G22_RUN_ID = "g2-2-contract-synthetic";
export const G22_DEMAND_R1 = "artifacts/discovery/candidates/candidate_demand.r1.json";
export const G22_DEMAND_R2 = "artifacts/discovery/candidates/candidate_demand.r2.json";
export const G22_BASELINE_R1 = "artifacts/discovery/candidates/candidate_baseline.r1.json";
export const G22_SOLUTION_R1 = "artifacts/discovery/candidates/candidate_solution.r1.json";
export const G22_GENERATION_TASK = "tasks/discovery/unit_seed_independent_demand.attempt-1.json";
export const G22_EVALUATION_TASK = "tasks/discovery/unit_counterfactual.attempt-1.json";
export const G22_GENERATION_LANE =
  "artifacts/discovery/lanes/unit_seed_independent_demand.attempt-1.json";
export const G22_EVALUATION_LANE = "artifacts/discovery/lanes/unit_counterfactual.attempt-1.json";
export const G22_GENERATION_EVIDENCE = `evidence/records/ev_${"a".repeat(64)}.json`;
export const G22_EVALUATION_EVIDENCE = `evidence/records/ev_${"b".repeat(64)}.json`;
export const G22_GENERATION_CLAIM = "claims/discovery/claim-generation.json";
export const G22_EVALUATION_CLAIM = "claims/discovery/claim-evaluation.json";
export const G22_FINDING = "findings/discovery/finding-demand.json";
export const G22_INSIGHT = "insights/discovery/insight-demand.json";
export const G22_JUDGMENT = "judgments/discovery/judgment-demand.json";
export const G22_DEMAND_EVALUATION_JUDGMENT = "judgments/discovery/judgment-demand-evaluation.json";
export const G22_BASELINE_GENERATION_JUDGMENT =
  "judgments/discovery/judgment-baseline-generation.json";
export const G22_BASELINE_EVALUATION_JUDGMENT =
  "judgments/discovery/judgment-baseline-evaluation.json";
export const G22_SOLUTION_GENERATION_JUDGMENT =
  "judgments/discovery/judgment-solution-generation.json";
export const G22_SOLUTION_EVALUATION_JUDGMENT =
  "judgments/discovery/judgment-solution-evaluation.json";
export const G22_GENERATION_MANIFEST = "evidence/source-manifests/discovery/generation.json";
export const G22_EVALUATION_MANIFEST = "evidence/source-manifests/discovery/evaluation.json";
export const G22_RETAINED_PRE_CANDIDATE =
  "artifacts/discovery/concrete-pre-candidates/pre_candidate_household_coordination.r1.json";
export const G22_WATCHLIST_PRE_CANDIDATE =
  "artifacts/discovery/concrete-pre-candidates/pre_candidate_adult_microlearning.r1.json";
export const G22_REJECTED_PRE_CANDIDATE =
  "artifacts/discovery/concrete-pre-candidates/pre_candidate_exam_error_drill.r1.json";
export const G22_PRE_CANDIDATE_RELATION =
  "artifacts/discovery/pre-candidate-relations/relation_broad_seed_split.r1.json";
export const G22_FAN_IN = "artifacts/discovery/fan-in.r1.json";

const createdAt = "2026-07-27T18:00:00Z";

function quantitativeCompetitiveScope(scanMode: "broad_scan" | "targeted_deep_dive") {
  return {
    scan_mode: scanMode,
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

function synthetic(value: string): string {
  return `SYNTHETIC ${value}; contract fixture only, not Evidence or validation.`;
}

function emptyEvidenceLineage(): Record<string, unknown> {
  return {
    evidence_refs: [],
    claim_refs: [],
    finding_refs: [],
    insight_refs: [],
    judgment_assessment_refs: [],
    source_manifest_refs: [],
    audit_refs: [],
  };
}

function sourceBoundary(): Record<string, unknown> {
  return {
    chat_is_artifact: false,
    task_completion_is_artifact: false,
    hidden_llm_calls: false,
    harness_dispatches_agent: false,
    external_validation_supported: false,
    publication_implies_validation: false,
  };
}

function preThesisBoundary(): Record<string, unknown> {
  return {
    status: "pre_thesis_unvalidated",
    formal_demand_thesis: false,
    formal_baseline_option: false,
    formal_solution_hypothesis: false,
    external_validation_claimed: false,
    validation_success_claimed: false,
  };
}

function preFormalBoundary(): Record<string, unknown> {
  return {
    formal_opportunity_created: false,
    validated_market_claim: false,
    harness_inferred_candidate: false,
    harness_ranked_candidate: false,
    external_validation_performed: false,
  };
}

function triageDimension(
  state:
    | "observed"
    | "inferred"
    | "partial"
    | "unknown"
    | "unavailable"
    | "conflicting"
    | "not_applicable",
  statements: readonly string[],
  basisMaterialRefs: readonly string[],
): Record<string, unknown> {
  return {
    state,
    statements: [...statements],
    basis_material_refs: [...basisMaterialRefs],
    limitations: [synthetic(`${state} concrete pre-candidate triage state`)],
  };
}

function candidateEnvelope(
  path: string,
  document: Record<string, unknown>,
  producerRole: "main_agent" | "lane_researcher",
  inputRefs: readonly string[],
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: document.schema_version,
    artifact_path: path,
    run_id: G22_RUN_ID,
    created_at: createdAt,
    producer_role: producerRole,
    input_refs: [...inputRefs],
    content_hash: canonicalContentHash(document),
    document,
  };
}

function mapLineage(
  bundle: DocumentBundle,
  mapRef: string,
  pointer: string,
  idField: string,
): Record<string, unknown> {
  const map = fixtureDocument(bundle, mapRef);
  const [collection = "", indexValue = ""] = pointer.slice(1).split("/", 2);
  const fragments = map[collection];
  const fragment = Array.isArray(fragments)
    ? (fragments[Number.parseInt(indexValue, 10)] as Record<string, unknown>)
    : {};
  const fragmentId = String(fragment[idField]);
  return {
    source_map_ref: mapRef,
    source_map_schema_version: map.schema_version,
    source_map_id: map.map_id,
    source_map_revision: map.revision,
    source_map_content_hash: fixtureEnvelope(bundle, mapRef).content_hash,
    fragment_ref: `${mapRef}#${fragmentId}`,
    fragment_pointer: pointer,
    fragment_id: fragmentId,
    fragment_content_hash: canonicalContentHash(fragment),
    fragment_status: fragment.status,
  };
}

function initialCandidate(
  bundle: DocumentBundle,
  candidateId: string,
  kind: "demand_seed" | "baseline_seed" | "solution_seed",
  mapRef: string,
  pointer: string,
  idField: string,
  subject: Record<string, unknown>,
): Record<string, unknown> {
  const scope = fixtureDocument(bundle, G21_SCOPE_REF);
  return {
    schema_version: "startup_opportunity.discovery_candidate.v1",
    candidate_id: candidateId,
    candidate_kind: kind,
    revision: 1,
    parent_candidate_ref: null,
    parent_content_hash: null,
    run_id: G22_RUN_ID,
    mode: "opportunity_discovery",
    phase: "discovery",
    owner_slice: "G2.2",
    discovery_profile: scope.discovery_profile,
    market: scope.market,
    language: scope.language,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    map_lineage: mapLineage(bundle, mapRef, pointer, idField),
    formation: {
      synthesis_origin: "current_run_synthesis",
      current_run_scope_and_plan_used: true,
      scope_frame_hash: fixtureEnvelope(bundle, G21_SCOPE_REF).content_hash,
      research_plan_hash: fixtureEnvelope(bundle, G21_PLAN_REF).content_hash,
      synthesis_input_hashes: [
        { ref: mapRef, content_hash: fixtureEnvelope(bundle, mapRef).content_hash },
      ],
      formation_rationale: synthetic(
        `${kind} formed from this Run Scope, Plan, and exact Map fragment`,
      ),
      prior_input_decision_refs: [],
    },
    subject,
    evidence_lineage: emptyEvidenceLineage(),
    source_partition: {
      generation_source_manifest_refs: [],
      evaluation_source_manifest_refs: [],
      overlap_source_group_ids: [],
      overlap_assessment: "none",
    },
    enrichment: {
      revision_kind: "initial_materialization",
      changed_fields: [],
      basis_refs: [mapRef],
    },
    pre_thesis_boundary: preThesisBoundary(),
    limitations: [synthetic(`${kind} remains pre-thesis and unvalidated`)],
  };
}

function task(
  unitId: string,
  unitType: string,
  sourcePhase: "candidate_generation" | "candidate_evaluation",
  outputPath: string,
  groupId: string,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.research_task.discovery_candidate.current",
    task_id: `task_${unitId}`,
    run_id: G22_RUN_ID,
    unit_id: unitId,
    mode: "opportunity_discovery",
    phase: "discovery",
    wave_id: "wave_discovery_synthetic",
    unit_type: unitType,
    research_goal: synthetic(`${sourcePhase} bounded contract task`),
    commercial_research_requirements: {
      research_stage: "solution_neutral_scan",
      resource_allocation: {
        customer_commercial_percent: 65,
        market_structure_percent: 17,
        academic_percent: 18,
      },
      planned_queries: [
        {
          query: synthetic("user, buyer, price, alternative, and channel behavior scan"),
          commercial_dimensions: [
            "user_language",
            "buyer",
            "purchase",
            "pricing",
            "alternatives",
            "usage",
            "distribution",
          ],
        },
      ],
      quantitative_competitive_scope: quantitativeCompetitiveScope("broad_scan"),
      incumbent_response_assignment: {
        analysis_depth: "not_assigned",
        assignment_role: "none",
        subject_refs: [],
        rationale:
          sourcePhase === "candidate_generation"
            ? "Incumbent response research starts only after candidates form."
            : "The static fixture has no Execution Plan assignment; Runtime projects the unique owner from its Plan.",
      },
      required_commercial_dimensions: [
        "recent_user_language",
        "purchase_signal",
        "alternatives_pricing_usage",
        "distribution_channel",
        "independent_counterevidence",
      ],
      commercial_audit_output_path: `artifacts/research-audits/${unitId}.json`,
    },
    target_candidate_refs: [G22_DEMAND_R1, G22_BASELINE_R1, G22_SOLUTION_R1],
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    input_refs: [G21_SCOPE_REF, G22_DEMAND_R1, G22_BASELINE_R1, G22_SOLUTION_R1],
    attempt: 1,
    supersedes_task_ref: null,
    agent_role: "lane-researcher",
    source_phase: sourcePhase,
    required_source_group_ids: [groupId],
    allowed_output_path: outputPath,
    required_artifact_schema: "startup_opportunity.discovery_lane_result.v1",
    required_stances: ["support", "oppose"],
    stop_conditions: [synthetic("stop after deterministic fixture coverage")],
    completion_message_contract: {
      formal_artifact_authority: false,
      include_artifact_path: true,
      include_limitations: true,
    },
    execution_contract: sourceBoundary(),
    dispatched_at: createdAt,
  };
}

function lineage(taskRef: string): Record<string, unknown> {
  return {
    task_ref: taskRef,
    attempt: 1,
    candidate_refs: [G22_DEMAND_R1, G22_BASELINE_R1, G22_SOLUTION_R1],
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
  };
}

function substrateRecord(
  evidenceId: string,
  unitId: string,
  fill: string,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.evidence_store_record.v2",
    evidence_id: evidenceId,
    run_id: G22_RUN_ID,
    unit_id: unitId,
    unit_attempt: 1,
    source: {
      kind: "user_provided",
      canonical_uri: `urn:startup-opportunity:user-provided:synthetic-contract-${fill}`,
    },
    source_hash: `sha256:${fill.repeat(64)}`,
    content_hash: `sha256:${fill.repeat(64)}`,
    acquisition_goal: synthetic("mechanical synthetic substrate only"),
    raw_content_ref: `evidence/raw/sha256-${fill.repeat(64)}.bin`,
    operation_key: `sha256:${fill.repeat(64)}`,
    recorded_at: createdAt,
  };
}

function evidence(
  evidenceId: string,
  unitId: string,
  taskRef: string,
  role: "candidate_generation" | "candidate_evaluation",
  evidenceRole: "support" | "oppose",
  groupId: string,
  fill: string,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.evidence.discovery_candidate.current",
    evidence_id: evidenceId,
    run_id: G22_RUN_ID,
    unit_id: unitId,
    lineage: lineage(taskRef),
    source_type: "synthetic_contract_fixture",
    source_name: synthetic(`${role} source`),
    research_goal: synthetic("mechanical synthetic substrate only"),
    task_lineage_goal: synthetic(`${role} bounded contract task`),
    research_phase_role: role,
    geo: synthetic("no real geography"),
    language: "en",
    source_group_id: groupId,
    mechanical_binding: {
      substrate_record_ref: `evidence/manifest.jsonl#${evidenceId}`,
      source_hash: `sha256:${fill.repeat(64)}`,
      content_hash: `sha256:${fill.repeat(64)}`,
      raw_content_ref: `evidence/raw/sha256-${fill.repeat(64)}.bin`,
      operation_key: `sha256:${fill.repeat(64)}`,
      recorded_at: createdAt,
    },
    provenance: {
      acquisition_method: "synthetic_fixture_only",
      source_owner: synthetic("fixture owner"),
      original_creator: synthetic("fixture generator"),
      method_notes: synthetic("no research or retrieval occurred"),
    },
    source_assessment: {
      independence: "unknown",
      canonical_source_group: groupId,
      shared_dataset_group: null,
      syndication_group: null,
      biases: ["sampling_method_unknown"],
      bias_notes: synthetic("fixture cannot establish source quality"),
    },
    evidence_tier: "model_inference_only",
    evidence_lifecycle_status: "unverified",
    evidence_role: evidenceRole,
    representativeness: synthetic("not representative"),
    valid_as_of: "2026-07-27",
    freshness_policy: "synthetic_fixture_only",
    limitations: [synthetic("not real Evidence")],
  };
}

function sourceManifest(
  id: string,
  unitId: string,
  taskRef: string,
  phase: "candidate_generation" | "candidate_evaluation",
  evidenceRef: string,
  groupId: string,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.source_manifest.discovery_candidate.current",
    manifest_id: id,
    run_id: G22_RUN_ID,
    unit_id: unitId,
    lineage: lineage(taskRef),
    research_phase_role: phase,
    accepted_evidence_refs: [evidenceRef],
    canonical_source_groups: [{ group_id: groupId, evidence_refs: [evidenceRef] }],
    shared_dataset_groups: [],
    duplicate_or_syndication_groups: [],
    source_type_coverage: ["synthetic_contract_fixture"],
    geo_language_coverage: [synthetic("no actual coverage")],
    time_coverage: [synthetic("fixture date only")],
    stance_coverage: [phase === "candidate_generation" ? "support" : "oppose"],
    known_source_blind_spots: [synthetic("all real sources absent")],
    freshness_summary: { active: 0, stale: 0, unverified: 1, superseded: 0 },
    limitations: [synthetic("source manifest is contract-only")],
  };
}

function judgment(
  id: string,
  unitId: string,
  taskRef: string,
  subjectRef: string,
  dimension: "demand_signal" | "baseline_failure" | "solution_incremental_value",
  signal: "supported" | "opposed",
  claimRef: string,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.judgment_assessment.discovery_candidate.current",
    run_id: G22_RUN_ID,
    unit_id: unitId,
    lineage: lineage(taskRef),
    judgment_id: id,
    subject_ref: subjectRef,
    dimension,
    judgment_signal: signal,
    evidence_tier_summary: ["model_inference_only"],
    supporting_refs: signal === "supported" ? [claimRef] : [],
    opposing_refs: signal === "opposed" ? [claimRef] : [],
    representativeness: synthetic("not representative"),
    independence: synthetic("synthetic source group only"),
    decision_sufficiency: "insufficient",
    insufficiency_reasons: [synthetic("no real Evidence")],
    what_would_change_the_decision: [synthetic("independent real sources")],
    valid_as_of: "2026-07-27",
    limitations: [synthetic("judgment is fixture-only")],
    validation_success_claimed: false,
  };
}

function laneResult(
  id: string,
  unitId: string,
  taskRef: string,
  laneType: string,
  evidenceRef: string,
  claimRef: string,
  sourceManifestRef: string,
  judgmentRefs: readonly [string, string, string],
): Record<string, unknown> {
  const disposition = (
    suffix: string,
    candidateRef: string,
    value: "retained" | "watchlist" | "rejected",
    basis: "counterfactual" | "diversity" | "not_retained",
    judgmentRef: string,
  ) => ({
    disposition_id: `${id}_${suffix}`,
    candidate_ref: candidateRef,
    disposition: value,
    retention_basis: basis,
    reasons: [synthetic(`${value} triage reason`)],
    triggered_kill_conditions: value === "rejected" ? [synthetic("fixture kill condition")] : [],
    missing_required_evidence: [synthetic("real Evidence absent")],
    judgment_assessment_refs: [judgmentRef],
    highest_allowed_stage:
      value === "retained"
        ? "cross_lane_synthesis"
        : value === "watchlist"
          ? "watchlist_only"
          : "none",
    what_would_reverse_decision: [synthetic("real opposing or supporting Evidence")],
  });
  return {
    schema_version: "startup_opportunity.discovery_lane_result.v1",
    lane_result_id: id,
    run_id: G22_RUN_ID,
    unit_id: unitId,
    attempt: 1,
    task_ref: taskRef,
    lane_type: laneType,
    status: "completed",
    owner_role: "lane-researcher",
    research_goals: [synthetic(`${laneType} contract goal`)],
    queries: [synthetic("no query executed")],
    evidence_lineage: {
      evidence_refs: [evidenceRef],
      claim_refs: [claimRef],
      finding_refs: [G22_FINDING],
      insight_refs: [G22_INSIGHT],
      judgment_assessment_refs: [...judgmentRefs],
      source_manifest_refs: [sourceManifestRef],
      audit_refs: [],
    },
    scope_outcomes: [
      {
        scope_key: laneType,
        disposition: "covered",
        evidence_refs: [evidenceRef],
        claim_refs: [claimRef],
        finding_refs: [],
        judgment_assessment_refs: [...judgmentRefs],
        notes: synthetic("the exact Lane Evidence supports this authored scope outcome"),
      },
    ],
    scored_candidates: [
      {
        candidate_ref: G22_DEMAND_R1,
        score: 5,
        supporting_refs: [G22_GENERATION_CLAIM],
        opposing_refs: [G22_EVALUATION_CLAIM],
        rationale: synthetic("lane score is triage only"),
        limitations: [synthetic("not comparable across lanes")],
      },
    ],
    pre_kill_decisions: [
      disposition("demand", G22_DEMAND_R1, "retained", "counterfactual", judgmentRefs[0]),
      disposition("baseline", G22_BASELINE_R1, "watchlist", "not_retained", judgmentRefs[1]),
      disposition("solution", G22_SOLUTION_R1, "rejected", "not_retained", judgmentRefs[2]),
    ],
    retained_candidate_refs: [G22_DEMAND_R1],
    watchlist_candidate_refs: [G22_BASELINE_R1],
    rejected_candidate_refs: [G22_SOLUTION_R1],
    candidate_diversity_summary: {
      covered_users: [synthetic("candidate user")],
      covered_jobs: [synthetic("candidate job")],
      covered_entry_scenes: [synthetic("candidate entry scene")],
      covered_buyer_models: [synthetic("candidate buyer")],
      covered_candidate_kinds: ["demand_seed", "baseline_seed", "solution_seed"],
      diversity_retention_refs: [G22_DEMAND_R1],
      counterfactual_candidate_refs: [G22_DEMAND_R1],
      known_blind_spots: [synthetic("all real research missing")],
    },
    decision_sufficiency_summary: {
      status: "insufficient",
      insufficiency_reasons: [synthetic("fixture has no real Evidence")],
      what_would_change_the_decision: [synthetic("real independent sources")],
    },
    open_questions: [synthetic("whether any demand exists")],
    reference_only: true,
    source_boundary: sourceBoundary(),
    limitations: [synthetic("lane result does not establish validation")],
  };
}

export function fixtureEntry(
  bundle: DocumentBundle,
  artifactPath: string,
): Record<string, unknown> {
  const entry = bundle.documents.find((item) => item.path === artifactPath)?.document;
  if (entry === undefined) {
    throw new Error(`missing G2.2 fixture path ${artifactPath}`);
  }
  return entry;
}

export function fixtureEffective(
  bundle: DocumentBundle,
  artifactPath: string,
): Record<string, unknown> {
  const entry = fixtureEntry(bundle, artifactPath);
  return String(entry.schema_version).startsWith("startup_opportunity.artifact_envelope.")
    ? (entry.document as Record<string, unknown>)
    : entry;
}

export function refreshDiscoveryCandidateFormation(bundle: DocumentBundle): DocumentBundle {
  const hasPath = (artifactPath: string): boolean =>
    bundle.documents.some((item) => item.path === artifactPath);
  for (const candidateRef of [G22_DEMAND_R1, G22_BASELINE_R1, G22_SOLUTION_R1, G22_DEMAND_R2]) {
    const candidate = fixtureEffective(bundle, candidateRef);
    const formation = candidate.formation as Record<string, unknown>;
    formation.scope_frame_hash = fixtureEnvelope(
      bundle,
      String(candidate.scope_frame_ref),
    ).content_hash;
    formation.research_plan_hash = fixtureEnvelope(
      bundle,
      String(candidate.research_plan_ref),
    ).content_hash;
    formation.synthesis_input_hashes = (
      formation.synthesis_input_hashes as Record<string, unknown>[]
    ).map((binding) => ({
      ref: binding.ref,
      content_hash: fixtureEnvelope(bundle, String(binding.ref)).content_hash,
    }));
    const mapLineage = candidate.map_lineage as Record<string, unknown>;
    mapLineage.source_map_content_hash = fixtureEnvelope(
      bundle,
      String(mapLineage.source_map_ref),
    ).content_hash;
    if (typeof candidate.parent_candidate_ref === "string") {
      candidate.parent_content_hash = fixtureEnvelope(
        bundle,
        candidate.parent_candidate_ref,
      ).content_hash;
    }
    (fixtureEnvelope(bundle, candidateRef) as unknown as { content_hash: string }).content_hash =
      canonicalContentHash(candidate);
  }
  const preCandidateRefs = [
    G22_RETAINED_PRE_CANDIDATE,
    G22_WATCHLIST_PRE_CANDIDATE,
    G22_REJECTED_PRE_CANDIDATE,
  ];
  if (preCandidateRefs.every(hasPath)) {
    for (const preCandidateRef of preCandidateRefs) {
      const preCandidate = fixtureEffective(bundle, preCandidateRef);
      for (const binding of preCandidate.seed_bindings as Record<string, unknown>[]) {
        const seed = fixtureEffective(bundle, String(binding.ref));
        binding.schema_version = seed.schema_version;
        binding.candidate_kind = seed.candidate_kind;
        binding.content_hash = canonicalContentHash(seed);
      }
      for (const binding of preCandidate.lane_result_bindings as Record<string, unknown>[]) {
        const lane = fixtureEffective(bundle, String(binding.ref));
        binding.schema_version = lane.schema_version;
        binding.status = lane.status;
        binding.content_hash = canonicalContentHash(lane);
      }
      for (const disposition of preCandidate.material_dispositions as Record<string, unknown>[]) {
        const material = fixtureEffective(bundle, String(disposition.material_ref));
        disposition.material_schema_version = material.schema_version;
        disposition.material_content_hash = canonicalContentHash(material);
      }
      (
        fixtureEnvelope(bundle, preCandidateRef) as unknown as { content_hash: string }
      ).content_hash = canonicalContentHash(preCandidate);
    }
  }
  if (hasPath(G22_PRE_CANDIDATE_RELATION) && preCandidateRefs.every(hasPath)) {
    const relation = fixtureEffective(bundle, G22_PRE_CANDIDATE_RELATION);
    for (const binding of relation.source_seed_bindings as Record<string, unknown>[]) {
      const seed = fixtureEffective(bundle, String(binding.ref));
      binding.content_hash = canonicalContentHash(seed);
    }
    for (const binding of relation.result_candidate_bindings as Record<string, unknown>[]) {
      binding.content_hash = fixtureEnvelope(bundle, String(binding.ref)).content_hash;
    }
    (
      fixtureEnvelope(bundle, G22_PRE_CANDIDATE_RELATION) as unknown as {
        content_hash: string;
      }
    ).content_hash = canonicalContentHash(relation);
  }
  if (hasPath(G22_FAN_IN) && preCandidateRefs.every(hasPath)) {
    const fanIn = fixtureEffective(bundle, G22_FAN_IN);
    for (const disposition of fanIn.pre_candidate_dispositions as Record<string, unknown>[]) {
      disposition.pre_candidate_content_hash = fixtureEnvelope(
        bundle,
        String(disposition.pre_candidate_ref),
      ).content_hash;
    }
    (fixtureEnvelope(bundle, G22_FAN_IN) as unknown as { content_hash: string }).content_hash =
      canonicalContentHash(fanIn);
  }
  return bundle;
}

export async function createDiscoveryCandidateFixture(
  additionalPlanWaves: readonly Record<string, unknown>[] = [],
  profile: DiscoveryProfile = "general",
  researchLanguage = "en-US",
): Promise<DocumentBundle> {
  const bundle = await createDiscoveryMapsFixture(
    profile,
    G22_RUN_ID,
    additionalPlanWaves,
    researchLanguage,
  );
  (bundle as { schema_version: string }).schema_version =
    "startup_opportunity.document_bundle.current";
  const researchPlan = fixtureEffective(bundle, G21_PLAN_REF);
  const outputPathsByUnit = new Map([
    ["unit_seed_independent_demand", G22_GENERATION_LANE],
    ["unit_counterfactual", G22_EVALUATION_LANE],
  ]);
  for (const wave of researchPlan.waves as Record<string, unknown>[]) {
    for (const unit of wave.units as Record<string, unknown>[]) {
      const outputPath = outputPathsByUnit.get(String(unit.unit_id));
      if (outputPath !== undefined) {
        unit.output_path = outputPath;
        unit.required_artifact_schema = "startup_opportunity.discovery_lane_result.v1";
      }
    }
  }
  refreshDiscoveryMapsBundle(bundle);
  const demandR1 = initialCandidate(
    bundle,
    "candidate_demand",
    "demand_seed",
    G21_OPPORTUNITY_REF,
    "/initial_demand_hypotheses/0",
    "hypothesis_id",
    {
      solution_neutral: true,
      user_hypotheses: [synthetic("possible user")],
      job_to_be_done: synthetic("possible job"),
      entry_scene: synthetic("possible entry scene"),
      current_alternatives: [synthetic("possible current alternative")],
      failure_or_loss: synthetic("possible failure or loss"),
      buyer_hypotheses: [synthetic("possible buyer")],
      desired_outcome: synthetic("possible outcome"),
    },
  );
  const baselineR1 = initialCandidate(
    bundle,
    "candidate_baseline",
    "baseline_seed",
    G21_OPPORTUNITY_REF,
    "/baseline_options/0",
    "hypothesis_id",
    {
      demand_candidate_ref: G22_DEMAND_R1,
      current_workflow: synthetic("possible baseline workflow"),
      current_cost_or_burden: synthetic("possible baseline burden"),
      failure_modes: [synthetic("possible baseline failure")],
      switching_cost: synthetic("possible switching cost"),
      why_users_continue: synthetic("possible reason to continue"),
      minimum_incremental_value_required: synthetic("unknown incremental value threshold"),
    },
  );
  (baselineR1.formation as Record<string, unknown>).synthesis_input_hashes = [
    ...((baselineR1.formation as Record<string, unknown>).synthesis_input_hashes as unknown[]),
    { ref: G22_DEMAND_R1, content_hash: canonicalContentHash(demandR1) },
  ];
  const solutionProfile = {
    general: {
      pointer: "/solution_candidates/0",
      solutionClass: "ordinary_software",
      deliveryForms: ["mobile_web"],
      usesAi: false,
    },
    industry_first: {
      pointer: "/solution_candidates/1",
      solutionClass: "platform_native",
      deliveryForms: ["platform_native"],
      usesAi: false,
    },
    ai_first: {
      pointer: "/solution_candidates/7",
      solutionClass: "ai_assisted",
      deliveryForms: ["mobile_web"],
      usesAi: true,
    },
    hybrid: {
      pointer: "/solution_candidates/7",
      solutionClass: "ai_assisted",
      deliveryForms: ["mobile_web"],
      usesAi: true,
    },
  }[profile];
  const solutionR1 = initialCandidate(
    bundle,
    "candidate_solution",
    "solution_seed",
    G21_SOLUTION_REF,
    solutionProfile.pointer,
    "candidate_id",
    {
      demand_candidate_ref: G22_DEMAND_R1,
      baseline_candidate_ref: G22_BASELINE_R1,
      solution_class: solutionProfile.solutionClass,
      description: synthetic(`possible ${profile} ${solutionProfile.solutionClass} option`),
      delivery_forms: solutionProfile.deliveryForms,
      workflow_change: synthetic("possible workflow change"),
      incremental_value_hypothesis: synthetic("unknown baseline delta"),
      uses_ai: solutionProfile.usesAi,
      kill_criteria: [synthetic("baseline remains sufficient")],
    },
  );
  (solutionR1.formation as Record<string, unknown>).synthesis_input_hashes = [
    ...((solutionR1.formation as Record<string, unknown>).synthesis_input_hashes as unknown[]),
    { ref: G22_DEMAND_R1, content_hash: canonicalContentHash(demandR1) },
    { ref: G22_BASELINE_R1, content_hash: canonicalContentHash(baselineR1) },
  ];
  const generationTask = task(
    "unit_seed_independent_demand",
    "user_language_mining",
    "candidate_generation",
    G22_GENERATION_LANE,
    "group_generation",
  );
  const evaluationTask = task(
    "unit_counterfactual",
    "counter_evidence",
    "candidate_evaluation",
    G22_EVALUATION_LANE,
    "group_evaluation",
  );
  const generationEvidenceId = `ev_${"a".repeat(64)}`;
  const evaluationEvidenceId = `ev_${"b".repeat(64)}`;
  const generationEvidence = evidence(
    generationEvidenceId,
    "unit_seed_independent_demand",
    G22_GENERATION_TASK,
    "candidate_generation",
    "support",
    "group_generation",
    "a",
  );
  const evaluationEvidence = evidence(
    evaluationEvidenceId,
    "unit_counterfactual",
    G22_EVALUATION_TASK,
    "candidate_evaluation",
    "oppose",
    "group_evaluation",
    "b",
  );
  const generationClaim = {
    schema_version: "startup_opportunity.claim.discovery_candidate.current",
    claim_id: "claim_generation",
    run_id: G22_RUN_ID,
    unit_id: "unit_seed_independent_demand",
    lineage: lineage(G22_GENERATION_TASK),
    claim_type: "behavior_signal",
    statement: synthetic("supporting claim placeholder"),
    stance: "support",
    evidence_refs: [G22_GENERATION_EVIDENCE],
    confidence_band: "unknown",
    sample_bias: synthetic("fixture-only sample"),
    limitations: [synthetic("not a real claim")],
  };
  const evaluationClaim = {
    schema_version: "startup_opportunity.claim.discovery_candidate.current",
    claim_id: "claim_evaluation",
    run_id: G22_RUN_ID,
    unit_id: "unit_counterfactual",
    lineage: lineage(G22_EVALUATION_TASK),
    claim_type: "counter_evidence",
    statement: synthetic("opposing claim placeholder"),
    stance: "oppose",
    evidence_refs: [G22_EVALUATION_EVIDENCE],
    confidence_band: "unknown",
    sample_bias: synthetic("fixture-only sample"),
    limitations: [synthetic("not a real claim")],
  };
  const finding = {
    schema_version: "startup_opportunity.finding.discovery_candidate.current",
    finding_id: "finding_demand",
    run_id: G22_RUN_ID,
    unit_id: "unit_seed_independent_demand",
    lineage: lineage(G22_GENERATION_TASK),
    summary: synthetic("mixed contract finding"),
    claim_refs: [G22_GENERATION_CLAIM],
    opposing_claim_refs: [G22_EVALUATION_CLAIM],
    confidence_band: "unknown",
    limitations: [synthetic("not a real finding")],
  };
  const insight = {
    schema_version: "startup_opportunity.insight.discovery_candidate.current",
    insight_id: "insight_demand",
    run_id: G22_RUN_ID,
    unit_id: "unit_seed_independent_demand",
    lineage: lineage(G22_GENERATION_TASK),
    source_units: ["unit_seed_independent_demand", "unit_counterfactual"],
    summary: synthetic("candidate should remain unvalidated"),
    finding_refs: [G22_FINDING],
    decision_relevance: "pre_kill",
    confidence_band: "unknown",
    limitations: [synthetic("not a real insight")],
  };
  const demandGenerationJudgment = judgment(
    "judgment_demand_generation",
    "unit_seed_independent_demand",
    G22_GENERATION_TASK,
    G22_DEMAND_R1,
    "demand_signal",
    "supported",
    G22_GENERATION_CLAIM,
  );
  const demandEvaluationJudgment = judgment(
    "judgment_demand_evaluation",
    "unit_counterfactual",
    G22_EVALUATION_TASK,
    G22_DEMAND_R1,
    "demand_signal",
    "opposed",
    G22_EVALUATION_CLAIM,
  );
  const baselineGenerationJudgment = judgment(
    "judgment_baseline_generation",
    "unit_seed_independent_demand",
    G22_GENERATION_TASK,
    G22_BASELINE_R1,
    "baseline_failure",
    "supported",
    G22_GENERATION_CLAIM,
  );
  const baselineEvaluationJudgment = judgment(
    "judgment_baseline_evaluation",
    "unit_counterfactual",
    G22_EVALUATION_TASK,
    G22_BASELINE_R1,
    "baseline_failure",
    "opposed",
    G22_EVALUATION_CLAIM,
  );
  const solutionGenerationJudgment = judgment(
    "judgment_solution_generation",
    "unit_seed_independent_demand",
    G22_GENERATION_TASK,
    G22_SOLUTION_R1,
    "solution_incremental_value",
    "supported",
    G22_GENERATION_CLAIM,
  );
  const solutionEvaluationJudgment = judgment(
    "judgment_solution_evaluation",
    "unit_counterfactual",
    G22_EVALUATION_TASK,
    G22_SOLUTION_R1,
    "solution_incremental_value",
    "opposed",
    G22_EVALUATION_CLAIM,
  );
  const generationManifest = sourceManifest(
    "source_generation",
    "unit_seed_independent_demand",
    G22_GENERATION_TASK,
    "candidate_generation",
    G22_GENERATION_EVIDENCE,
    "group_generation",
  );
  const evaluationManifest = sourceManifest(
    "source_evaluation",
    "unit_counterfactual",
    G22_EVALUATION_TASK,
    "candidate_evaluation",
    G22_EVALUATION_EVIDENCE,
    "group_evaluation",
  );
  const generationLane = laneResult(
    "lane_generation",
    "unit_seed_independent_demand",
    G22_GENERATION_TASK,
    "user_language_mining",
    G22_GENERATION_EVIDENCE,
    G22_GENERATION_CLAIM,
    G22_GENERATION_MANIFEST,
    [G22_JUDGMENT, G22_BASELINE_GENERATION_JUDGMENT, G22_SOLUTION_GENERATION_JUDGMENT],
  );
  const evaluationLane = laneResult(
    "lane_evaluation",
    "unit_counterfactual",
    G22_EVALUATION_TASK,
    "counter_evidence",
    G22_EVALUATION_EVIDENCE,
    G22_EVALUATION_CLAIM,
    G22_EVALUATION_MANIFEST,
    [
      G22_DEMAND_EVALUATION_JUDGMENT,
      G22_BASELINE_EVALUATION_JUDGMENT,
      G22_SOLUTION_EVALUATION_JUDGMENT,
    ],
  );
  const fullEvidenceLineage = {
    evidence_refs: [G22_GENERATION_EVIDENCE, G22_EVALUATION_EVIDENCE],
    claim_refs: [G22_GENERATION_CLAIM, G22_EVALUATION_CLAIM],
    finding_refs: [G22_FINDING],
    insight_refs: [G22_INSIGHT],
    judgment_assessment_refs: [G22_JUDGMENT, G22_DEMAND_EVALUATION_JUDGMENT],
    source_manifest_refs: [G22_GENERATION_MANIFEST, G22_EVALUATION_MANIFEST],
    audit_refs: [],
  };
  const demandR2 = {
    ...structuredClone(demandR1),
    revision: 2,
    parent_candidate_ref: G22_DEMAND_R1,
    parent_content_hash: canonicalContentHash(demandR1),
    evidence_lineage: fullEvidenceLineage,
    source_partition: {
      generation_source_manifest_refs: [G22_GENERATION_MANIFEST],
      evaluation_source_manifest_refs: [G22_EVALUATION_MANIFEST],
      overlap_source_group_ids: [],
      overlap_assessment: "none",
    },
    enrichment: {
      revision_kind: "evidence_enrichment",
      changed_fields: [
        "evidence_lineage.evidence_refs",
        "evidence_lineage.claim_refs",
        "evidence_lineage.finding_refs",
        "evidence_lineage.insight_refs",
        "evidence_lineage.judgment_assessment_refs",
        "evidence_lineage.source_manifest_refs",
        "source_partition",
      ],
      basis_refs: [G22_GENERATION_LANE, G22_EVALUATION_LANE],
    },
  };
  const seedDocs = new Map([
    [G22_DEMAND_R2, demandR2],
    [G22_BASELINE_R1, baselineR1],
    [G22_SOLUTION_R1, solutionR1],
  ]);
  const seedRefs = [G22_DEMAND_R2, G22_BASELINE_R1, G22_SOLUTION_R1] as const;
  const materialDocs = new Map([
    [G22_GENERATION_EVIDENCE, generationEvidence],
    [G22_EVALUATION_EVIDENCE, evaluationEvidence],
    [G22_GENERATION_CLAIM, generationClaim],
    [G22_EVALUATION_CLAIM, evaluationClaim],
    [G22_FINDING, finding],
    [G22_INSIGHT, insight],
    [G22_JUDGMENT, demandGenerationJudgment],
    [G22_DEMAND_EVALUATION_JUDGMENT, demandEvaluationJudgment],
    [G22_BASELINE_GENERATION_JUDGMENT, baselineGenerationJudgment],
    [G22_BASELINE_EVALUATION_JUDGMENT, baselineEvaluationJudgment],
    [G22_SOLUTION_GENERATION_JUDGMENT, solutionGenerationJudgment],
    [G22_SOLUTION_EVALUATION_JUDGMENT, solutionEvaluationJudgment],
  ]);
  const materialRefs = [...materialDocs.keys()];
  const materialDispositions = (
    overrides: Readonly<
      Record<string, "supporting" | "opposing" | "background" | "conflicting" | "not_applicable">
    >,
  ) =>
    materialRefs.map((ref) => {
      const material = materialDocs.get(ref) as Record<string, unknown>;
      const disposition = overrides[ref] ?? "background";
      return {
        material_ref: ref,
        material_schema_version: material.schema_version,
        material_content_hash: canonicalContentHash(material),
        disposition,
        rationale: synthetic(`${disposition} material disposition for concrete pre-candidate`),
      };
    });
  const concretePreCandidate = (
    id: string,
    triageProfile: Record<string, unknown>,
    overrides: Readonly<
      Record<string, "supporting" | "opposing" | "background" | "conflicting" | "not_applicable">
    >,
  ): Record<string, unknown> => ({
    schema_version: "startup_opportunity.concrete_pre_candidate.v1",
    pre_candidate_id: id,
    revision: 1,
    parent_pre_candidate_ref: null,
    parent_content_hash: null,
    run_id: G22_RUN_ID,
    mode: "opportunity_discovery",
    phase: "discovery",
    owner_role: "main_agent",
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    formation: {
      relationship_kind: "split",
      relationship_group_id: "group_broad_seed_split",
    },
    seed_bindings: seedRefs.map((ref) => {
      const seed = seedDocs.get(ref) as Record<string, unknown>;
      return {
        ref,
        schema_version: "startup_opportunity.discovery_candidate.v1",
        candidate_kind: seed.candidate_kind,
        content_hash: canonicalContentHash(seed),
      };
    }),
    lane_result_bindings: [
      {
        ref: G22_GENERATION_LANE,
        schema_version: "startup_opportunity.discovery_lane_result.v1",
        status: generationLane.status,
        content_hash: canonicalContentHash(generationLane),
      },
      {
        ref: G22_EVALUATION_LANE,
        schema_version: "startup_opportunity.discovery_lane_result.v1",
        status: evaluationLane.status,
        content_hash: canonicalContentHash(evaluationLane),
      },
    ],
    triage_profile: triageProfile,
    material_dispositions: materialDispositions(overrides),
    materialization_rationale: synthetic(
      `${id} is an authored concrete pre-candidate split from broad Lane material`,
    ),
    pre_formal_boundary: preFormalBoundary(),
    limitations: [synthetic("concrete pre-candidate remains partial and unvalidated")],
  });
  const retainedPreCandidate = concretePreCandidate(
    "pre_candidate_household_coordination",
    {
      users: triageDimension(
        "partial",
        [synthetic("household learner support user")],
        [G22_JUDGMENT],
      ),
      job_to_be_done: triageDimension(
        "partial",
        [synthetic("coordinate repeated practice")],
        [G22_FINDING],
      ),
      entry_scene: triageDimension("unknown", [synthetic("entry scene not resolved")], []),
      buyer_or_payment_logic: triageDimension(
        "unavailable",
        [synthetic("buyer proof unavailable")],
        [],
      ),
      current_alternatives: triageDimension(
        "conflicting",
        [synthetic("manual alternatives are both plausible and burdensome")],
        [G22_GENERATION_CLAIM, G22_EVALUATION_CLAIM],
      ),
      solution_boundary: triageDimension(
        "partial",
        [synthetic("assistant boundary remains pre-formal")],
        [G22_SOLUTION_GENERATION_JUDGMENT],
      ),
    },
    {
      [G22_GENERATION_EVIDENCE]: "supporting",
      [G22_EVALUATION_EVIDENCE]: "opposing",
      [G22_GENERATION_CLAIM]: "supporting",
      [G22_EVALUATION_CLAIM]: "opposing",
      [G22_JUDGMENT]: "supporting",
      [G22_DEMAND_EVALUATION_JUDGMENT]: "conflicting",
    },
  );
  const watchlistPreCandidate = concretePreCandidate(
    "pre_candidate_adult_microlearning",
    {
      users: triageDimension("inferred", [synthetic("adult learner inferred")], [G22_INSIGHT]),
      job_to_be_done: triageDimension("unknown", [synthetic("job remains unknown")], []),
      entry_scene: triageDimension("partial", [synthetic("fragmented time entry")], [G22_FINDING]),
      buyer_or_payment_logic: triageDimension("unknown", [synthetic("payment logic unknown")], []),
      current_alternatives: triageDimension(
        "partial",
        [synthetic("baseline option weakly observed")],
        [G22_BASELINE_GENERATION_JUDGMENT],
      ),
      solution_boundary: triageDimension(
        "unavailable",
        [synthetic("solution boundary unavailable")],
        [],
      ),
    },
    {
      [G22_BASELINE_GENERATION_JUDGMENT]: "supporting",
      [G22_BASELINE_EVALUATION_JUDGMENT]: "conflicting",
      [G22_GENERATION_CLAIM]: "background",
      [G22_EVALUATION_CLAIM]: "opposing",
    },
  );
  const rejectedPreCandidate = concretePreCandidate(
    "pre_candidate_exam_error_drill",
    {
      users: triageDimension(
        "conflicting",
        [synthetic("exam drill user signal conflicts")],
        [G22_SOLUTION_GENERATION_JUDGMENT, G22_SOLUTION_EVALUATION_JUDGMENT],
      ),
      job_to_be_done: triageDimension(
        "partial",
        [synthetic("repeat mistakes")],
        [G22_SOLUTION_EVALUATION_JUDGMENT],
      ),
      entry_scene: triageDimension("unknown", [synthetic("exam entry scene unknown")], []),
      buyer_or_payment_logic: triageDimension(
        "not_applicable",
        [synthetic("not retained for buyer analysis")],
        [],
      ),
      current_alternatives: triageDimension(
        "unavailable",
        [synthetic("alternative material unavailable")],
        [],
      ),
      solution_boundary: triageDimension(
        "conflicting",
        [synthetic("solution boundary overfit risk")],
        [G22_SOLUTION_GENERATION_JUDGMENT, G22_SOLUTION_EVALUATION_JUDGMENT],
      ),
    },
    {
      [G22_SOLUTION_GENERATION_JUDGMENT]: "conflicting",
      [G22_SOLUTION_EVALUATION_JUDGMENT]: "opposing",
      [G22_EVALUATION_CLAIM]: "opposing",
      [G22_GENERATION_CLAIM]: "not_applicable",
    },
  );
  const relation = {
    schema_version: "startup_opportunity.pre_candidate_relation.v1",
    relation_id: "relation_broad_seed_split",
    revision: 1,
    parent_relation_ref: null,
    parent_content_hash: null,
    run_id: G22_RUN_ID,
    mode: "opportunity_discovery",
    phase: "discovery",
    owner_role: "main_agent",
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    relationship_group_id: "group_broad_seed_split",
    relationship_kind: "split",
    source_seed_bindings: seedRefs.map((ref) => ({
      ref,
      content_hash: canonicalContentHash(seedDocs.get(ref) as Record<string, unknown>),
    })),
    result_candidate_bindings: [
      {
        ref: G22_RETAINED_PRE_CANDIDATE,
        content_hash: canonicalContentHash(retainedPreCandidate),
      },
      {
        ref: G22_WATCHLIST_PRE_CANDIDATE,
        content_hash: canonicalContentHash(watchlistPreCandidate),
      },
      {
        ref: G22_REJECTED_PRE_CANDIDATE,
        content_hash: canonicalContentHash(rejectedPreCandidate),
      },
    ],
    rationale: synthetic("Agent-authored split relation for three concrete directions"),
    harness_inferred: false,
    limitations: [synthetic("relation is explicit but synthetic")],
  };
  const fanIn = {
    schema_version: "startup_opportunity.discovery_fan_in.v2",
    fan_in_id: "fan_in_g2_2_contract",
    revision: 1,
    parent_fan_in_ref: null,
    run_id: G22_RUN_ID,
    mode: "opportunity_discovery",
    phase: "discovery",
    owner_role: "main_agent",
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    lane_result_classification: {
      completed_refs: [G22_GENERATION_LANE, G22_EVALUATION_LANE],
      partial_refs: [],
      insufficient_evidence_refs: [],
      failed_refs: [],
      ignored_late_refs: [],
      superseded_refs: [],
      cancelled_units: [],
      skipped_units: [],
      missing_units: [],
    },
    materialized_pre_candidate_refs: [
      G22_RETAINED_PRE_CANDIDATE,
      G22_WATCHLIST_PRE_CANDIDATE,
      G22_REJECTED_PRE_CANDIDATE,
    ],
    pre_candidate_relation_refs: [G22_PRE_CANDIDATE_RELATION],
    pre_candidate_dispositions: [
      {
        disposition_id: "fan_pre_disposition_household_coordination",
        pre_candidate_ref: G22_RETAINED_PRE_CANDIDATE,
        pre_candidate_content_hash: canonicalContentHash(retainedPreCandidate),
        disposition: "retained",
        supporting_lane_result_refs: [G22_GENERATION_LANE, G22_EVALUATION_LANE],
        judgment_assessment_refs: [G22_JUDGMENT, G22_DEMAND_EVALUATION_JUDGMENT],
        rationale: synthetic("retained concrete direction remains independently triageable"),
        limitations: [synthetic("partial and conflicting material remains visible")],
      },
      {
        disposition_id: "fan_pre_disposition_adult_microlearning",
        pre_candidate_ref: G22_WATCHLIST_PRE_CANDIDATE,
        pre_candidate_content_hash: canonicalContentHash(watchlistPreCandidate),
        disposition: "watchlist",
        supporting_lane_result_refs: [G22_GENERATION_LANE, G22_EVALUATION_LANE],
        judgment_assessment_refs: [
          G22_BASELINE_GENERATION_JUDGMENT,
          G22_BASELINE_EVALUATION_JUDGMENT,
        ],
        rationale: synthetic("watchlist concrete direction is visible but not promoted"),
        limitations: [synthetic("unknown job and payment logic remain")],
      },
      {
        disposition_id: "fan_pre_disposition_exam_error_drill",
        pre_candidate_ref: G22_REJECTED_PRE_CANDIDATE,
        pre_candidate_content_hash: canonicalContentHash(rejectedPreCandidate),
        disposition: "rejected",
        supporting_lane_result_refs: [G22_GENERATION_LANE, G22_EVALUATION_LANE],
        judgment_assessment_refs: [
          G22_SOLUTION_GENERATION_JUDGMENT,
          G22_SOLUTION_EVALUATION_JUDGMENT,
        ],
        rationale: synthetic("rejected concrete direction remains auditable"),
        limitations: [synthetic("not eligible for G2.3 formalization")],
      },
    ],
    candidate_dispositions: [
      {
        disposition_id: "fan_disposition_demand",
        candidate_ref: G22_DEMAND_R2,
        source_candidate_refs: [G22_DEMAND_R1],
        disposition: "retained",
        supporting_lane_result_refs: [G22_GENERATION_LANE, G22_EVALUATION_LANE],
        judgment_assessment_refs: [G22_JUDGMENT, G22_DEMAND_EVALUATION_JUDGMENT],
        rationale: synthetic("retain only as pre-thesis candidate"),
        limitations: [synthetic("not promoted or validated")],
      },
      {
        disposition_id: "fan_disposition_baseline",
        candidate_ref: G22_BASELINE_R1,
        source_candidate_refs: [G22_BASELINE_R1],
        disposition: "watchlist",
        supporting_lane_result_refs: [G22_GENERATION_LANE, G22_EVALUATION_LANE],
        judgment_assessment_refs: [
          G22_BASELINE_GENERATION_JUDGMENT,
          G22_BASELINE_EVALUATION_JUDGMENT,
        ],
        rationale: synthetic("watchlist only"),
        limitations: [synthetic("not a formal Baseline Option")],
      },
      {
        disposition_id: "fan_disposition_solution",
        candidate_ref: G22_SOLUTION_R1,
        source_candidate_refs: [G22_SOLUTION_R1],
        disposition: "rejected",
        supporting_lane_result_refs: [G22_GENERATION_LANE, G22_EVALUATION_LANE],
        judgment_assessment_refs: [
          G22_SOLUTION_GENERATION_JUDGMENT,
          G22_SOLUTION_EVALUATION_JUDGMENT,
        ],
        rationale: synthetic("pre-kill fixture disposition"),
        limitations: [synthetic("not a formal Solution Hypothesis")],
      },
    ],
    retained_pre_candidate_refs: [G22_RETAINED_PRE_CANDIDATE],
    watchlist_pre_candidate_refs: [G22_WATCHLIST_PRE_CANDIDATE],
    rejected_pre_candidate_refs: [G22_REJECTED_PRE_CANDIDATE],
    retained_candidate_refs: [G22_DEMAND_R2],
    watchlist_candidate_refs: [G22_BASELINE_R1],
    rejected_candidate_refs: [G22_SOLUTION_R1],
    judgment_assessment_refs: [
      G22_JUDGMENT,
      G22_DEMAND_EVALUATION_JUDGMENT,
      G22_BASELINE_GENERATION_JUDGMENT,
      G22_BASELINE_EVALUATION_JUDGMENT,
      G22_SOLUTION_GENERATION_JUDGMENT,
      G22_SOLUTION_EVALUATION_JUDGMENT,
    ],
    candidate_diversity_summary: {
      preserved_dimensions: ["user", "job", "entry_scene", "buyer_model", "candidate_kind"],
      diversity_retention_refs: [G22_DEMAND_R2],
      counterfactual_candidate_refs: [G22_DEMAND_R2],
      pre_candidate_diversity_retention_refs: [G22_RETAINED_PRE_CANDIDATE],
      counterfactual_pre_candidate_refs: [G22_RETAINED_PRE_CANDIDATE],
      known_blind_spots: [synthetic("all real research absent")],
    },
    evidence_sufficiency_summary: {
      status: "insufficient",
      insufficiency_reasons: [synthetic("contract fixture only")],
      what_would_change_the_decision: [synthetic("real Evidence")],
    },
    opposing_evidence_summary: [synthetic("opposition placeholder retained")],
    pre_kill_summary: [synthetic("one retained, one watchlist, one rejected")],
    solution_evaluation_required: true,
    reference_only: true,
    manifest_projection: {
      status_projection_required: true,
      late_or_superseded_can_enter_current_refs: false,
    },
    limitations: [synthetic("fan-in is contract-only")],
  };
  const documents: readonly [
    string,
    Record<string, unknown>,
    "main_agent" | "lane_researcher",
    readonly string[],
  ][] = [
    [G22_DEMAND_R1, demandR1, "main_agent", [G21_SCOPE_REF, G21_PLAN_REF, G21_OPPORTUNITY_REF]],
    [
      G22_BASELINE_R1,
      baselineR1,
      "main_agent",
      [G21_SCOPE_REF, G21_PLAN_REF, G21_OPPORTUNITY_REF, G22_DEMAND_R1],
    ],
    [
      G22_SOLUTION_R1,
      solutionR1,
      "main_agent",
      [G21_SCOPE_REF, G21_PLAN_REF, G21_SOLUTION_REF, G22_DEMAND_R1, G22_BASELINE_R1],
    ],
    [
      G22_GENERATION_TASK,
      generationTask,
      "main_agent",
      [G21_SCOPE_REF, G21_PLAN_REF, G22_DEMAND_R1, G22_BASELINE_R1, G22_SOLUTION_R1],
    ],
    [
      G22_EVALUATION_TASK,
      evaluationTask,
      "main_agent",
      [G21_SCOPE_REF, G21_PLAN_REF, G22_DEMAND_R1, G22_BASELINE_R1, G22_SOLUTION_R1],
    ],
    [G22_GENERATION_EVIDENCE, generationEvidence, "lane_researcher", [G22_GENERATION_TASK]],
    [G22_EVALUATION_EVIDENCE, evaluationEvidence, "lane_researcher", [G22_EVALUATION_TASK]],
    [
      G22_GENERATION_CLAIM,
      generationClaim,
      "lane_researcher",
      [G22_GENERATION_TASK, G22_GENERATION_EVIDENCE],
    ],
    [
      G22_EVALUATION_CLAIM,
      evaluationClaim,
      "lane_researcher",
      [G22_EVALUATION_TASK, G22_EVALUATION_EVIDENCE],
    ],
    [
      G22_FINDING,
      finding,
      "lane_researcher",
      [G22_GENERATION_TASK, G22_GENERATION_CLAIM, G22_EVALUATION_CLAIM],
    ],
    [G22_INSIGHT, insight, "lane_researcher", [G22_GENERATION_TASK, G22_FINDING]],
    [
      G22_JUDGMENT,
      demandGenerationJudgment,
      "lane_researcher",
      [G22_GENERATION_TASK, G22_DEMAND_R1, G22_GENERATION_CLAIM],
    ],
    [
      G22_DEMAND_EVALUATION_JUDGMENT,
      demandEvaluationJudgment,
      "lane_researcher",
      [G22_EVALUATION_TASK, G22_DEMAND_R1, G22_EVALUATION_CLAIM],
    ],
    [
      G22_BASELINE_GENERATION_JUDGMENT,
      baselineGenerationJudgment,
      "lane_researcher",
      [G22_GENERATION_TASK, G22_BASELINE_R1, G22_GENERATION_CLAIM],
    ],
    [
      G22_BASELINE_EVALUATION_JUDGMENT,
      baselineEvaluationJudgment,
      "lane_researcher",
      [G22_EVALUATION_TASK, G22_BASELINE_R1, G22_EVALUATION_CLAIM],
    ],
    [
      G22_SOLUTION_GENERATION_JUDGMENT,
      solutionGenerationJudgment,
      "lane_researcher",
      [G22_GENERATION_TASK, G22_SOLUTION_R1, G22_GENERATION_CLAIM],
    ],
    [
      G22_SOLUTION_EVALUATION_JUDGMENT,
      solutionEvaluationJudgment,
      "lane_researcher",
      [G22_EVALUATION_TASK, G22_SOLUTION_R1, G22_EVALUATION_CLAIM],
    ],
    [
      G22_GENERATION_MANIFEST,
      generationManifest,
      "lane_researcher",
      [G22_GENERATION_TASK, G22_GENERATION_EVIDENCE],
    ],
    [
      G22_EVALUATION_MANIFEST,
      evaluationManifest,
      "lane_researcher",
      [G22_EVALUATION_TASK, G22_EVALUATION_EVIDENCE],
    ],
    [
      G22_GENERATION_LANE,
      generationLane,
      "lane_researcher",
      [
        G22_GENERATION_TASK,
        G22_DEMAND_R1,
        G22_BASELINE_R1,
        G22_SOLUTION_R1,
        G22_JUDGMENT,
        G22_BASELINE_GENERATION_JUDGMENT,
        G22_SOLUTION_GENERATION_JUDGMENT,
      ],
    ],
    [
      G22_EVALUATION_LANE,
      evaluationLane,
      "lane_researcher",
      [
        G22_EVALUATION_TASK,
        G22_DEMAND_R1,
        G22_BASELINE_R1,
        G22_SOLUTION_R1,
        G22_DEMAND_EVALUATION_JUDGMENT,
        G22_BASELINE_EVALUATION_JUDGMENT,
        G22_SOLUTION_EVALUATION_JUDGMENT,
      ],
    ],
    [
      G22_DEMAND_R2,
      demandR2,
      "main_agent",
      [G22_DEMAND_R1, G22_GENERATION_LANE, G22_EVALUATION_LANE],
    ],
    [
      G22_RETAINED_PRE_CANDIDATE,
      retainedPreCandidate,
      "main_agent",
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        ...seedRefs,
        G22_GENERATION_LANE,
        G22_EVALUATION_LANE,
        ...materialRefs,
      ],
    ],
    [
      G22_WATCHLIST_PRE_CANDIDATE,
      watchlistPreCandidate,
      "main_agent",
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        ...seedRefs,
        G22_GENERATION_LANE,
        G22_EVALUATION_LANE,
        ...materialRefs,
      ],
    ],
    [
      G22_REJECTED_PRE_CANDIDATE,
      rejectedPreCandidate,
      "main_agent",
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        ...seedRefs,
        G22_GENERATION_LANE,
        G22_EVALUATION_LANE,
        ...materialRefs,
      ],
    ],
    [
      G22_PRE_CANDIDATE_RELATION,
      relation,
      "main_agent",
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        ...seedRefs,
        G22_RETAINED_PRE_CANDIDATE,
        G22_WATCHLIST_PRE_CANDIDATE,
        G22_REJECTED_PRE_CANDIDATE,
      ],
    ],
    [
      G22_FAN_IN,
      fanIn,
      "main_agent",
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        G22_GENERATION_LANE,
        G22_EVALUATION_LANE,
        G22_RETAINED_PRE_CANDIDATE,
        G22_WATCHLIST_PRE_CANDIDATE,
        G22_REJECTED_PRE_CANDIDATE,
        G22_PRE_CANDIDATE_RELATION,
        G22_DEMAND_R1,
        G22_DEMAND_R2,
        G22_BASELINE_R1,
        G22_SOLUTION_R1,
        G22_JUDGMENT,
        G22_DEMAND_EVALUATION_JUDGMENT,
        G22_BASELINE_GENERATION_JUDGMENT,
        G22_BASELINE_EVALUATION_JUDGMENT,
        G22_SOLUTION_GENERATION_JUDGMENT,
        G22_SOLUTION_EVALUATION_JUDGMENT,
      ],
    ],
  ];
  const mutableBundle = bundle as unknown as {
    documents: { path: string; document: Record<string, unknown> }[];
    exact_records: { ref: string; document: Record<string, unknown> }[];
  };
  mutableBundle.documents.push(
    ...documents.map(([path, document, producer, inputRefs]) => ({
      path,
      document: candidateEnvelope(path, document, producer, inputRefs),
    })),
  );
  const runtimeWave = discoveryWaveEnvelopes(
    bundle,
    G22_RUN_ID,
    "startup_opportunity.research_task.discovery_candidate.current",
    1,
    "candidate_runtime",
  );
  for (const artifact of runtimeWave) {
    const entry = {
      path: artifact.artifact_path,
      document: artifact as unknown as Record<string, unknown>,
    };
    const existingIndex = mutableBundle.documents.findIndex(
      (candidate) => candidate.path === artifact.artifact_path,
    );
    if (existingIndex === -1) mutableBundle.documents.push(entry);
    else mutableBundle.documents[existingIndex] = entry;
  }
  mutableBundle.exact_records.push(
    {
      ref: `evidence/manifest.jsonl#${generationEvidenceId}`,
      document: substrateRecord(generationEvidenceId, "unit_seed_independent_demand", "a"),
    },
    {
      ref: `evidence/manifest.jsonl#${evaluationEvidenceId}`,
      document: substrateRecord(evaluationEvidenceId, "unit_counterfactual", "b"),
    },
  );
  return refreshDiscoveryCandidateFormation(bundle);
}

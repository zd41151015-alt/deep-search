import { canonicalContentHash, type DocumentBundle } from "../../../harness/src/index.js";
import {
  createDiscoveryMapsFixture,
  fixtureDocument,
  fixtureEnvelope,
  G21_OPPORTUNITY_REF,
  G21_PLAN_REF,
  G21_SCOPE_REF,
  G21_SOLUTION_REF,
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
export const G22_FAN_IN = "artifacts/discovery/fan-in.r1.json";
export const G22_CONVERSION = "artifacts/discovery/conversions/candidate_demand.r1.json";

const createdAt = "2026-07-27T18:00:00Z";

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

function candidateEnvelope(
  path: string,
  document: Record<string, unknown>,
  producerRole: "main_agent" | "lane_researcher",
  inputRefs: readonly string[],
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.artifact_envelope.v9",
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
    schema_version: "startup_opportunity.research_task.v2",
    task_id: `task_${unitId}`,
    run_id: G22_RUN_ID,
    unit_id: unitId,
    mode: "opportunity_discovery",
    phase: "discovery",
    wave_id: "wave_discovery_synthetic",
    unit_type: unitType,
    research_goal: synthetic(`${sourcePhase} bounded contract task`),
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
    source: {
      kind: "user_provided",
      canonical_uri: `urn:startup-opportunity:user-provided:synthetic-contract-${fill}`,
    },
    source_hash: `sha256:${fill.repeat(64)}`,
    content_hash: `sha256:${fill.repeat(64)}`,
    research_goal: synthetic("mechanical synthetic substrate only"),
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
    schema_version: "startup_opportunity.evidence.v2",
    evidence_id: evidenceId,
    run_id: G22_RUN_ID,
    unit_id: unitId,
    lineage: lineage(taskRef),
    source_type: "synthetic_contract_fixture",
    source_name: synthetic(`${role} source`),
    research_goal: synthetic(`${role} fixture goal`),
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
    schema_version: "startup_opportunity.source_manifest.v2",
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
    schema_version: "startup_opportunity.judgment_assessment.v2",
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
    basis: "diversity" | "not_retained",
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
      disposition("demand", G22_DEMAND_R1, "retained", "diversity", judgmentRefs[0]),
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
      counterfactual_candidate_refs: [],
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

export async function createDiscoveryCandidateFixture(): Promise<DocumentBundle> {
  const bundle = await createDiscoveryMapsFixture("general", G22_RUN_ID);
  (bundle as { schema_version: string }).schema_version = "startup_opportunity.document_bundle.v9";
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
  const solutionR1 = initialCandidate(
    bundle,
    "candidate_solution",
    "solution_seed",
    G21_SOLUTION_REF,
    "/solution_candidates/0",
    "candidate_id",
    {
      demand_candidate_ref: G22_DEMAND_R1,
      baseline_candidate_ref: G22_BASELINE_R1,
      solution_class: "ordinary_software",
      description: synthetic("possible ordinary software option"),
      delivery_forms: ["mobile_web"],
      workflow_change: synthetic("possible workflow change"),
      incremental_value_hypothesis: synthetic("unknown baseline delta"),
      uses_ai: false,
      kill_criteria: [synthetic("baseline remains sufficient")],
    },
  );
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
    schema_version: "startup_opportunity.claim.v2",
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
    schema_version: "startup_opportunity.claim.v2",
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
    schema_version: "startup_opportunity.finding.v2",
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
    schema_version: "startup_opportunity.insight.v2",
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
  const fanIn = {
    schema_version: "startup_opportunity.discovery_fan_in.v1",
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
      counterfactual_candidate_refs: [],
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
    manifest_adapter_boundary: {
      runtime_adapter_installed: false,
      manifest_state_transition_performed: false,
      late_or_superseded_can_enter_current_refs: false,
    },
    limitations: [synthetic("fan-in is contract-only")],
  };
  const conversion = {
    schema_version: "startup_opportunity.discovery_candidate_conversion.v1",
    conversion_id: "conversion_demand_contract",
    revision: 1,
    parent_conversion_ref: null,
    parent_content_hash: null,
    run_id: G22_RUN_ID,
    owner_slice: "G2.3",
    source_candidate_ref: G22_DEMAND_R2,
    source_candidate_schema_version: "startup_opportunity.discovery_candidate.v1",
    source_candidate_kind: "demand_seed",
    source_candidate_revision: 2,
    source_candidate_content_hash: canonicalContentHash(demandR2),
    discovery_fan_in_ref: G22_FAN_IN,
    required_source_disposition: "retained",
    target_schema_version: "startup_opportunity.demand_thesis.v1",
    target_artifact_ref: "artifacts/discovery/demand-theses/candidate_demand.r1.json",
    target_revision: 1,
    conversion_status: "contract_only_not_executable",
    promotion_preconditions: {
      source_candidate_is_current_revision: true,
      source_candidate_is_retained: true,
      typed_evidence_lineage_valid: true,
      decision_sufficiency_satisfied: false,
      g2_3_target_schema_installed: false,
      g2_3_conversion_evaluator_installed: false,
      promotion_authorized: false,
    },
    source_candidate_mutation: "forbidden",
    conversion_is_evidence: false,
    external_validation_success_claimed: false,
    target_published: false,
    target_content_hash: null,
    limitations: [synthetic("does not publish or validate a Demand Thesis")],
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
      G22_FAN_IN,
      fanIn,
      "main_agent",
      [
        G22_GENERATION_LANE,
        G22_EVALUATION_LANE,
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
    [G22_CONVERSION, conversion, "main_agent", [G22_DEMAND_R2, G22_FAN_IN]],
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
  return bundle;
}

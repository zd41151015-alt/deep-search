import {
  canonicalContentHash,
  type DiscoveryProfile,
  type DocumentBundle,
  type EvidenceStoreRecord,
  type FormalArtifactEnvelope,
} from "../../../harness/src/index.js";
import { G21_DECISION_REF, G21_PLAN_REF, G21_SCOPE_REF } from "../g2.1/discovery-maps-fixture.js";
import {
  createDiscoverySynthesisFixture,
  G23_MERGE,
  G23_OPPORTUNITY_A,
  G23_OPPORTUNITY_B,
  G23_SNAPSHOT,
  G23_SOLUTION,
} from "../g2.3/discovery-synthesis-fixture.js";

export const G24_TASK_SUPPORT = "tasks/discovery/enrichment/unit_enrichment_support.attempt-1.json";
export const G24_TASK_CHALLENGE =
  "tasks/discovery/enrichment/unit_enrichment_challenge.attempt-1.json";
export const G24_EVIDENCE_SUPPORT = "evidence/discovery/enrichment/evidence-support.json";
export const G24_EVIDENCE_CHALLENGE = "evidence/discovery/enrichment/evidence-challenge.json";
export const G24_CLAIM_SUPPORT = "claims/discovery/enrichment/claim-support.json";
export const G24_CLAIM_CHALLENGE = "claims/discovery/enrichment/claim-challenge.json";
export const G24_FINDING_SUPPORT = "findings/discovery/enrichment/finding-support.json";
export const G24_FINDING_CHALLENGE = "findings/discovery/enrichment/finding-challenge.json";
export const G24_INSIGHT_SUPPORT = "insights/discovery/enrichment/insight-support.json";
export const G24_INSIGHT_CHALLENGE = "insights/discovery/enrichment/insight-challenge.json";
export const G24_JUDGMENT_A_SUPPORT = "judgments/discovery/enrichment/judgment-a-support.json";
export const G24_JUDGMENT_B_SUPPORT = "judgments/discovery/enrichment/judgment-b-support.json";
export const G24_JUDGMENT_A_CHALLENGE = "judgments/discovery/enrichment/judgment-a-challenge.json";
export const G24_JUDGMENT_B_CHALLENGE = "judgments/discovery/enrichment/judgment-b-challenge.json";
export const G24_MANIFEST_SUPPORT =
  "evidence/discovery/enrichment/source-manifests/manifest-support.json";
export const G24_MANIFEST_CHALLENGE =
  "evidence/discovery/enrichment/source-manifests/manifest-challenge.json";
export const G24_BRANCH_SUPPORT =
  "artifacts/discovery/enrichment/branches/unit_enrichment_support.attempt-1.json";
export const G24_BRANCH_CHALLENGE =
  "artifacts/discovery/enrichment/branches/unit_enrichment_challenge.attempt-1.json";
export const G24_FAN_IN = "artifacts/discovery/enrichment/fan-in.r1.json";
export const G24_VALUE_A = "artifacts/discovery/enrichment/value-layer-a.r1.json";
export const G24_VALUE_B = "artifacts/discovery/enrichment/value-layer-b.r1.json";
export const G24_STATE_A = "artifacts/discovery/enrichment/user-state-a.r1.json";
export const G24_STATE_B = "artifacts/discovery/enrichment/user-state-b.r1.json";
export const G24_BUYER_A = "artifacts/discovery/enrichment/buyer-language-a.r1.json";
export const G24_BUYER_B = "artifacts/discovery/enrichment/buyer-language-b.r1.json";
export const G24_ENGINE_A = "artifacts/discovery/enrichment/business-engine-a.r1.json";
export const G24_ENGINE_B = "artifacts/discovery/enrichment/business-engine-b.r1.json";
export const G24_COMPARISON_A = "artifacts/comparison/opportunities/comparison-a.r1.json";
export const G24_COMPARISON_B = "artifacts/comparison/opportunities/comparison-b.r1.json";
export const G24_SENSITIVITY = "artifacts/comparison/sensitivity.r1.json";
export const G24_PORTFOLIO = "artifacts/comparison/portfolio.r1.json";
export const G24_RECOMMENDATION = "artifacts/comparison/decision-recommendation.r1.json";
export const G24_TRACEABILITY = "artifacts/traceability/discovery-traceability.r1.json";
export const G24_REPORT = "artifacts/reporting/report-json.r1.json";

export const G24_HARD_GATES = [
  "user_jtbd_entry_scene",
  "baseline_delta",
  "buyer_purchase",
  "business_engine",
  "source_independence",
  "generation_evaluation_separation",
  "opposing_evidence",
  "compliance_boundary",
  "ai_mandatory_bundle",
  "ai_baseline_gap",
  "ai_reliability",
  "data_rights",
  "unit_economics",
] as const;

const OPPORTUNITIES = [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B] as const;
const SYNTHETIC = "SYNTHETIC G2.4 contract fixture only; no real Evidence or validation.";

export interface DiscoveryEvaluationSubstrate {
  readonly generation: EvidenceStoreRecord;
  readonly evaluation: EvidenceStoreRecord;
  readonly support: EvidenceStoreRecord;
  readonly challenge: EvidenceStoreRecord;
}

function boundary(): Record<string, unknown> {
  return {
    formal_artifacts_explicit: true,
    harness_generated_research: false,
    harness_generated_judgment: false,
    agent_dispatch: false,
    hidden_llm_calls: false,
    network_research: false,
    external_validation: false,
    publication_implies_validation: false,
  };
}

function externalBoundary(): Record<string, unknown> {
  return {
    execution_owner: "user",
    execution_supported: false,
    result_tracking_supported: false,
    external_validation_claimed: false,
  };
}

function collectRefs(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectRefs);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    if ((key.endsWith("_refs") || key === "input_refs") && Array.isArray(child)) {
      return child.filter(
        (ref): ref is string => typeof ref === "string" && (ref.includes("/") || ref.includes("#")),
      );
    }
    if (
      (key.endsWith("_ref") || key === "ref") &&
      typeof child === "string" &&
      (child.includes("/") || child.includes("#"))
    ) {
      return [child];
    }
    return collectRefs(child);
  });
}

function envelope(
  runId: string,
  artifactPath: string,
  document: Record<string, unknown>,
  createdAt: string,
  producerRole = "main_agent",
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    run_id: runId,
    created_at: createdAt,
    producer_role: producerRole,
    input_refs: [...new Set(collectRefs(document))].filter((ref) => ref !== artifactPath).sort(),
    content_hash: canonicalContentHash(document),
    document,
  } as FormalArtifactEnvelope;
}

function lineage(taskRef: string, unitId: string): Record<string, unknown> {
  return {
    task_ref: taskRef,
    unit_id: unitId,
    attempt: 1,
    opportunity_refs: [...OPPORTUNITIES],
    source_snapshot_ref: G23_SNAPSHOT,
    source_merge_ref: G23_MERGE,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
  };
}

function enrichmentInputRefs(): readonly string[] {
  return [G21_SCOPE_REF];
}

function enrichmentPlanUnit(
  unitId: string,
  outputPath: string,
  sourcePhase: "enrichment_evaluation" | "adversarial_challenger",
): Record<string, unknown> {
  return {
    unit_id: unitId,
    unit_type: sourcePhase === "adversarial_challenger" ? "adversarial_review" : "market_space",
    plan_disposition: "enabled",
    priority_band: "high",
    attempt: 1,
    supersedes_unit_ref: null,
    research_goal: SYNTHETIC,
    input_refs: enrichmentInputRefs(),
    agent_role: "lane-researcher",
    output_path: outputPath,
    required_artifact_schema: "startup_opportunity.enrichment_branch_result.v1",
    source_preferences: [SYNTHETIC],
    required_outputs: [SYNTHETIC],
    stop_conditions: [SYNTHETIC],
  };
}

function task(
  runId: string,
  unitId: string,
  outputPath: string,
  sourcePhase: "enrichment_evaluation" | "adversarial_challenger",
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.research_task.v3",
    task_id: `task_${unitId}`,
    run_id: runId,
    unit_id: unitId,
    mode: "opportunity_discovery",
    phase: "enrichment",
    wave_id: "wave_enrichment",
    unit_type: sourcePhase === "adversarial_challenger" ? "adversarial_review" : "market_space",
    research_goal: SYNTHETIC,
    commercial_research_requirements: {
      research_stage: "solution_specific_evaluation",
      resource_allocation: {
        customer_commercial_percent: 65,
        market_structure_percent: 17,
        academic_percent: 18,
      },
      planned_queries: [
        {
          query: `synthetic ${unitId} pricing, acquisition, retention, and opposition review`,
          commercial_dimensions: [
            "solution_pricing",
            "solution_acquisition",
            "solution_retention",
            "counterevidence",
          ],
        },
      ],
      required_commercial_dimensions: [
        "recent_user_language",
        "purchase_signal",
        "alternatives_pricing_usage",
        "distribution_channel",
        "independent_counterevidence",
      ],
      commercial_audit_output_path: `artifacts/research-audits/${unitId}.json`,
    },
    target_opportunity_refs: [...OPPORTUNITIES],
    source_snapshot_ref: G23_SNAPSHOT,
    source_merge_ref: G23_MERGE,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    input_refs: enrichmentInputRefs(),
    attempt: 1,
    supersedes_task_ref: null,
    agent_role: "lane-researcher",
    source_phase: sourcePhase,
    required_source_group_ids: [`source_group_${unitId}`],
    allowed_output_path: outputPath,
    required_artifact_schema: "startup_opportunity.enrichment_branch_result.v1",
    required_stances: ["support", "oppose"],
    stop_conditions: [SYNTHETIC],
    completion_message_contract: {
      formal_artifact_authority: false,
      include_artifact_path: true,
      include_limitations: true,
    },
    execution_contract: boundary(),
    dispatched_at: "2026-07-27T21:00:00Z",
  };
}

function evidence(
  runId: string,
  unitId: string,
  taskRef: string,
  substrate: EvidenceStoreRecord,
  role: "support" | "oppose",
  phase: "enrichment_evaluation" | "adversarial_challenger",
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.evidence.v3",
    evidence_id: substrate.evidence_id,
    run_id: runId,
    unit_id: unitId,
    lineage: lineage(taskRef, unitId),
    source_type: "synthetic_contract_fixture",
    source_name: SYNTHETIC,
    research_goal: SYNTHETIC,
    research_phase_role: phase,
    geo: "synthetic",
    language: "en",
    source_group_id: `source_group_${unitId}`,
    mechanical_binding: {
      substrate_record_ref: `evidence/manifest.jsonl#${substrate.evidence_id}`,
      source_hash: substrate.source_hash,
      content_hash: substrate.content_hash,
      raw_content_ref: substrate.raw_content_ref,
      operation_key: substrate.operation_key,
      recorded_at: substrate.recorded_at,
    },
    provenance: {
      acquisition_method: "synthetic_fixture_only",
      source_owner: "test fixture",
      original_creator: "test fixture",
      method_notes: SYNTHETIC,
    },
    source_assessment: {
      independence: "unknown",
      canonical_source_group: `source_group_${unitId}`,
      shared_dataset_group: null,
      syndication_group: null,
      biases: ["sampling_method_unknown"],
      bias_notes: SYNTHETIC,
    },
    evidence_tier: "model_inference_only",
    evidence_lifecycle_status: "unverified",
    evidence_role: role,
    representativeness: SYNTHETIC,
    valid_as_of: "2026-07-27",
    freshness_policy: "synthetic_fixture_only",
    limitations: [SYNTHETIC],
  };
}

function judgment(
  runId: string,
  id: string,
  unitId: string,
  taskRef: string,
  opportunityRef: string,
  claimRef: string,
  evidenceRef: string,
  dimension: string,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.judgment_assessment.v3",
    judgment_id: id,
    run_id: runId,
    unit_id: unitId,
    lineage: lineage(taskRef, unitId),
    subject_ref: opportunityRef,
    dimension,
    signal: "unknown",
    supporting_refs: [claimRef, evidenceRef],
    opposing_refs: [],
    evidence_tier: "model_inference_only",
    representativeness: "unknown",
    source_independence: "unknown",
    decision_sufficiency: "insufficient",
    insufficiency_reasons: [SYNTHETIC],
    what_would_change_it: ["Real, current, independent Evidence."],
    valid_as_of: "2026-07-27",
    limitations: [SYNTHETIC],
  };
}

function branch(
  runId: string,
  id: string,
  unitId: string,
  taskRef: string,
  evidenceRef: string,
  claimRef: string,
  findingRef: string,
  insightRef: string,
  judgments: readonly string[],
  manifestRef: string,
  gates: readonly string[],
  usesAi: boolean,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.enrichment_branch_result.v1",
    branch_result_id: id,
    run_id: runId,
    unit_id: unitId,
    attempt: 1,
    task_ref: taskRef,
    source_snapshot_ref: G23_SNAPSHOT,
    source_merge_ref: G23_MERGE,
    opportunity_refs: [...OPPORTUNITIES],
    status: "insufficient_evidence",
    owner_role: "lane-researcher",
    enrichment_dimensions: [
      ...new Set(
        gates.map((gate) =>
          gate === "user_jtbd_entry_scene"
            ? "market_space"
            : gate === "baseline_delta"
              ? "competitor_gap"
              : gate === "buyer_purchase"
                ? "buyer_purchase_language"
                : gate === "unit_economics"
                  ? "early_unit_economics"
                  : gate === "business_engine"
                    ? "business_engine"
                    : "counter_evidence",
        ),
      ),
    ],
    evidence_lineage: {
      evidence_refs: [evidenceRef],
      claim_refs: [claimRef],
      finding_refs: [findingRef],
      insight_refs: [insightRef],
      judgment_assessment_refs: [...judgments],
      source_manifest_refs: [manifestRef],
    },
    hard_gate_inputs: OPPORTUNITIES.flatMap((opportunityRef, index) =>
      gates.map((gate) => ({
        opportunity_ref: opportunityRef,
        gate_id: gate,
        status:
          usesAi && gate === "ai_mandatory_bundle"
            ? "insufficient_evidence"
            : gate.startsWith("ai_")
              ? "not_applicable"
              : "insufficient_evidence",
        judgment_assessment_refs: [judgments[index] as string],
        rationale: SYNTHETIC,
        limitations: [SYNTHETIC],
      })),
    ),
    decision_sufficiency_summary: {
      status: "insufficient",
      conclusion_ceiling: "investigate_further",
      insufficiency_reasons: [SYNTHETIC],
      what_would_change_the_decision: ["Real, current, independent Evidence."],
    },
    open_questions: [SYNTHETIC],
    reference_only: true,
    source_boundary: boundary(),
    limitations: [SYNTHETIC],
  };
}

function domainDocuments(
  runId: string,
  opportunityRef: string,
  suffix: "a" | "b",
  judgmentRefs: readonly string[],
): readonly [string, Record<string, unknown>][] {
  const common = {
    run_id: runId,
    opportunity_ref: opportunityRef,
    source_snapshot_ref: G23_SNAPSHOT,
    enrichment_fan_in_ref: G24_FAN_IN,
    judgment_assessment_refs: [...judgmentRefs],
    limitations: [SYNTHETIC],
  };
  return [
    [
      suffix === "a" ? G24_VALUE_A : G24_VALUE_B,
      {
        schema_version: "startup_opportunity.value_layer_analysis.v1",
        analysis_id: `value_layer_${suffix}`,
        ...common,
        primary_value_layer: "unknown",
        output_value: SYNTHETIC,
        workflow_value: SYNTHETIC,
        outcome_metrics: [SYNTHETIC],
        baseline_outcome: SYNTHETIC,
        expected_delta: SYNTHETIC,
        measurement_feasibility: "unknown",
        supporting_claim_refs: [G24_CLAIM_SUPPORT],
        opposing_claim_refs: [G24_CLAIM_CHALLENGE],
      },
    ],
    [
      suffix === "a" ? G24_STATE_A : G24_STATE_B,
      {
        schema_version: "startup_opportunity.user_state_context_model.v1",
        model_id: `user_state_${suffix}`,
        ...common,
        state_variables: [SYNTHETIC],
        context_sources: [SYNTHETIC],
        state_update_triggers: [SYNTHETIC],
        feedback_or_ground_truth: [],
        collaboration_participants: [SYNTHETIC],
        retention_boundary: SYNTHETIC,
        privacy_permission_boundary: SYNTHETIC,
        deletion_export_boundary: SYNTHETIC,
        data_feedback_moat: "unknown",
        unavailable_or_unreliable_inputs: [SYNTHETIC],
      },
    ],
    [
      suffix === "a" ? G24_BUYER_A : G24_BUYER_B,
      {
        schema_version: "startup_opportunity.buyer_purchase_language.v1",
        language_id: `buyer_language_${suffix}`,
        ...common,
        user_trigger_phrase: SYNTHETIC,
        buyer_purchase_phrase: SYNTHETIC,
        user: [SYNTHETIC],
        buyer: [SYNTHETIC],
        payer: [SYNTHETIC],
        decision_maker: [SYNTHETIC],
        budget_source: SYNTHETIC,
        purchase_trigger: SYNTHETIC,
        decision_criteria: [SYNTHETIC],
        price_or_cost_anchor: SYNTHETIC,
        marketing_bridge: SYNTHETIC,
        supporting_claim_refs: [G24_CLAIM_SUPPORT],
        opposing_claim_refs: [G24_CLAIM_CHALLENGE],
        confidence_band: "unknown",
      },
    ],
    [
      suffix === "a" ? G24_ENGINE_A : G24_ENGINE_B,
      {
        schema_version: "startup_opportunity.business_engine_thesis.v2",
        business_engine_id: `business_engine_${suffix}`,
        run_id: runId,
        subject_ref: opportunityRef,
        source_snapshot_ref: G23_SNAPSHOT,
        enrichment_fan_in_ref: G24_FAN_IN,
        pricing_unit: SYNTHETIC,
        usage_or_purchase_frequency: SYNTHETIC,
        retention_or_repeat_trigger: SYNTHETIC,
        gross_margin_band: "unknown",
        service_and_support_burden: "unknown",
        cac_hypothesis: SYNTHETIC,
        payback_logic: SYNTHETIC,
        reachable_beachhead_market: SYNTHETIC,
        channel_dependency: [SYNTHETIC],
        growth_loop: SYNTHETIC,
        minimum_viable_scale: SYNTHETIC,
        assumptions: [SYNTHETIC],
        supporting_claim_refs: [G24_CLAIM_SUPPORT],
        opposing_claim_refs: [G24_CLAIM_CHALLENGE],
        judgment_assessment_refs: [...judgmentRefs],
        unknowns: [SYNTHETIC],
        limitations: [SYNTHETIC],
      },
    ],
  ];
}

function hashRefs(
  refs: readonly string[],
  documents: ReadonlyMap<string, Record<string, unknown>>,
): readonly Record<string, unknown>[] {
  return refs.map((ref) => ({ ref, content_hash: canonicalContentHash(documents.get(ref) ?? {}) }));
}

function comparison(
  runId: string,
  opportunityRef: string,
  suffix: "a" | "b",
  judgmentRefs: readonly string[],
  documents: ReadonlyMap<string, Record<string, unknown>>,
  usesAi: boolean,
): Record<string, unknown> {
  const domainRefs = [
    suffix === "a" ? G24_VALUE_A : G24_VALUE_B,
    suffix === "a" ? G24_STATE_A : G24_STATE_B,
    suffix === "a" ? G24_BUYER_A : G24_BUYER_B,
    suffix === "a" ? G24_ENGINE_A : G24_ENGINE_B,
  ];
  return {
    schema_version: "startup_opportunity.opportunity_comparison.v1",
    comparison_id: `comparison_${suffix}`,
    revision: 1,
    parent_comparison_ref: null,
    parent_content_hash: null,
    run_id: runId,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    source_snapshot_ref: G23_SNAPSHOT,
    source_merge_ref: G23_MERGE,
    enrichment_fan_in_ref: G24_FAN_IN,
    opportunity_ref: opportunityRef,
    value_layer_analysis_ref: domainRefs[0],
    user_state_context_model_ref: domainRefs[1],
    buyer_purchase_language_ref: domainRefs[2],
    business_engine_ref: domainRefs[3],
    comparison_policy_version: "1.0.0",
    rubric_version: "1.0.0",
    input_artifact_hashes: hashRefs(
      [G23_SNAPSHOT, G23_MERGE, G24_FAN_IN, ...domainRefs],
      documents,
    ),
    hard_gates_evaluated_at: "2026-07-27T21:20:00Z",
    compared_at: "2026-07-27T21:21:00Z",
    hard_gate_results: G24_HARD_GATES.map((gate) => ({
      gate_id: gate,
      status:
        usesAi && gate === "ai_mandatory_bundle"
          ? "insufficient_evidence"
          : gate.startsWith("ai_")
            ? "not_applicable"
            : "insufficient_evidence",
      judgment_assessment_refs: [...judgmentRefs],
      rationale: SYNTHETIC,
      limitations: [SYNTHETIC],
    })),
    hard_gate_outcome: "insufficient_evidence",
    recommendation_band: "investigate_further",
    decision_value_band: "unknown",
    uncertainty_band: "high",
    comparison_panels: [
      "demand_and_market",
      "solution_and_business",
      "evidence_strength",
      "team_fit_and_learning",
    ].map((panel) => ({
      panel_id: panel,
      band: "unknown",
      dimension_assessments: [
        {
          dimension: `dimension_${panel}`,
          band: "unknown",
          observable_anchors: [SYNTHETIC],
          supporting_refs: [G24_CLAIM_SUPPORT, ...judgmentRefs],
          opposing_refs: [G24_CLAIM_CHALLENGE],
          limitations: [SYNTHETIC],
        },
      ],
      decision_sufficiency: "insufficient",
      source_overlap: "unknown",
      limitations: [SYNTHETIC],
    })),
    ordering_mode: "partial_order",
    judgment_assessment_refs: [...judgmentRefs],
    what_would_change_the_decision: ["Real, current, independent Evidence."],
    limitations: [SYNTHETIC],
  };
}

export async function createDiscoveryEvaluationFixture(
  runId: string,
  substrate: DiscoveryEvaluationSubstrate,
  profile: DiscoveryProfile = "general",
): Promise<DocumentBundle> {
  const usesAi = profile === "ai_first" || profile === "hybrid";
  const bundle = await createDiscoverySynthesisFixture(
    runId,
    {
      generation: substrate.generation,
      evaluation: substrate.evaluation,
    },
    [
      {
        wave_id: "wave_enrichment",
        depends_on: ["wave_discovery_synthetic"],
        units: [
          enrichmentPlanUnit(
            "unit_enrichment_support",
            G24_BRANCH_SUPPORT,
            "enrichment_evaluation",
          ),
          enrichmentPlanUnit(
            "unit_enrichment_challenge",
            G24_BRANCH_CHALLENGE,
            "adversarial_challenger",
          ),
        ],
      },
    ],
    profile,
  );
  (bundle as { schema_version: string }).schema_version =
    "startup_opportunity.document_bundle.current";
  const exactRecords = (bundle.exact_records ?? []) as {
    ref: string;
    document: Record<string, unknown>;
  }[];
  exactRecords.push(
    {
      ref: `evidence/manifest.jsonl#${substrate.support.evidence_id}`,
      document: substrate.support,
    },
    {
      ref: `evidence/manifest.jsonl#${substrate.challenge.evidence_id}`,
      document: substrate.challenge,
    },
  );
  const documents = new Map<string, Record<string, unknown>>(
    bundle.documents.map((entry) => {
      const outer = entry.document;
      return [
        entry.path,
        String(outer.schema_version).startsWith("startup_opportunity.artifact_envelope.")
          ? (outer.document as Record<string, unknown>)
          : outer,
      ];
    }),
  );
  const add = (path: string, document: Record<string, unknown>): void => {
    documents.set(path, document);
  };

  add(
    G24_TASK_SUPPORT,
    task(runId, "unit_enrichment_support", G24_BRANCH_SUPPORT, "enrichment_evaluation"),
  );
  add(
    G24_TASK_CHALLENGE,
    task(runId, "unit_enrichment_challenge", G24_BRANCH_CHALLENGE, "adversarial_challenger"),
  );
  add(
    G24_EVIDENCE_SUPPORT,
    evidence(
      runId,
      "unit_enrichment_support",
      G24_TASK_SUPPORT,
      substrate.support,
      "support",
      "enrichment_evaluation",
    ),
  );
  add(
    G24_EVIDENCE_CHALLENGE,
    evidence(
      runId,
      "unit_enrichment_challenge",
      G24_TASK_CHALLENGE,
      substrate.challenge,
      "oppose",
      "adversarial_challenger",
    ),
  );
  for (const side of ["support", "challenge"] as const) {
    const isSupport = side === "support";
    const unitId = `unit_enrichment_${side}`;
    const taskRef = isSupport ? G24_TASK_SUPPORT : G24_TASK_CHALLENGE;
    const evidenceRef = isSupport ? G24_EVIDENCE_SUPPORT : G24_EVIDENCE_CHALLENGE;
    const claimRef = isSupport ? G24_CLAIM_SUPPORT : G24_CLAIM_CHALLENGE;
    const findingRef = isSupport ? G24_FINDING_SUPPORT : G24_FINDING_CHALLENGE;
    const insightRef = isSupport ? G24_INSIGHT_SUPPORT : G24_INSIGHT_CHALLENGE;
    const manifestRef = isSupport ? G24_MANIFEST_SUPPORT : G24_MANIFEST_CHALLENGE;
    add(claimRef, {
      schema_version: "startup_opportunity.claim.v3",
      claim_id: `claim_${side}`,
      run_id: runId,
      unit_id: unitId,
      lineage: lineage(taskRef, unitId),
      claim_type: isSupport ? "market_space" : "counter_evidence",
      statement: SYNTHETIC,
      stance: isSupport ? "support" : "oppose",
      evidence_refs: [evidenceRef],
      confidence_band: "unknown",
      sample_bias: SYNTHETIC,
      limitations: [SYNTHETIC],
    });
    add(findingRef, {
      schema_version: "startup_opportunity.finding.v3",
      finding_id: `finding_${side}`,
      run_id: runId,
      unit_id: unitId,
      lineage: lineage(taskRef, unitId),
      summary: SYNTHETIC,
      claim_refs: [claimRef],
      opposing_claim_refs: [],
      limitations: [SYNTHETIC],
    });
    add(insightRef, {
      schema_version: "startup_opportunity.insight.v3",
      insight_id: `insight_${side}`,
      run_id: runId,
      unit_id: unitId,
      lineage: lineage(taskRef, unitId),
      summary: SYNTHETIC,
      finding_refs: [findingRef],
      decision_impact: "hard_gate",
      limitations: [SYNTHETIC],
    });
    add(manifestRef, {
      schema_version: "startup_opportunity.source_manifest.v3",
      manifest_id: `source_manifest_${side}`,
      run_id: runId,
      unit_id: unitId,
      lineage: lineage(taskRef, unitId),
      research_phase_role: isSupport ? "enrichment_evaluation" : "adversarial_challenger",
      source_group_ids: [`source_group_${unitId}`],
      accepted_evidence_refs: [evidenceRef],
      rejected_sources: [],
      unavailable_sources: [SYNTHETIC],
      canonical_source_groups: [
        { group_id: `source_group_${unitId}`, evidence_refs: [evidenceRef] },
      ],
      overlap_disclosures: [SYNTHETIC],
      valid_as_of: "2026-07-27",
      limitations: [SYNTHETIC],
    });
  }

  add(
    G24_JUDGMENT_A_SUPPORT,
    judgment(
      runId,
      "judgment_a_support",
      "unit_enrichment_support",
      G24_TASK_SUPPORT,
      G23_OPPORTUNITY_A,
      G24_CLAIM_SUPPORT,
      G24_EVIDENCE_SUPPORT,
      "market_space",
    ),
  );
  add(
    G24_JUDGMENT_B_SUPPORT,
    judgment(
      runId,
      "judgment_b_support",
      "unit_enrichment_support",
      G24_TASK_SUPPORT,
      G23_OPPORTUNITY_B,
      G24_CLAIM_SUPPORT,
      G24_EVIDENCE_SUPPORT,
      "market_space",
    ),
  );
  add(
    G24_JUDGMENT_A_CHALLENGE,
    judgment(
      runId,
      "judgment_a_challenge",
      "unit_enrichment_challenge",
      G24_TASK_CHALLENGE,
      G23_OPPORTUNITY_A,
      G24_CLAIM_CHALLENGE,
      G24_EVIDENCE_CHALLENGE,
      "counter_evidence",
    ),
  );
  add(
    G24_JUDGMENT_B_CHALLENGE,
    judgment(
      runId,
      "judgment_b_challenge",
      "unit_enrichment_challenge",
      G24_TASK_CHALLENGE,
      G23_OPPORTUNITY_B,
      G24_CLAIM_CHALLENGE,
      G24_EVIDENCE_CHALLENGE,
      "counter_evidence",
    ),
  );

  const supportGates = G24_HARD_GATES.slice(0, 7);
  const challengeGates = G24_HARD_GATES.slice(7);
  add(
    G24_BRANCH_SUPPORT,
    branch(
      runId,
      "branch_enrichment_support",
      "unit_enrichment_support",
      G24_TASK_SUPPORT,
      G24_EVIDENCE_SUPPORT,
      G24_CLAIM_SUPPORT,
      G24_FINDING_SUPPORT,
      G24_INSIGHT_SUPPORT,
      [G24_JUDGMENT_A_SUPPORT, G24_JUDGMENT_B_SUPPORT],
      G24_MANIFEST_SUPPORT,
      supportGates,
      usesAi,
    ),
  );
  add(
    G24_BRANCH_CHALLENGE,
    branch(
      runId,
      "branch_enrichment_challenge",
      "unit_enrichment_challenge",
      G24_TASK_CHALLENGE,
      G24_EVIDENCE_CHALLENGE,
      G24_CLAIM_CHALLENGE,
      G24_FINDING_CHALLENGE,
      G24_INSIGHT_CHALLENGE,
      [G24_JUDGMENT_A_CHALLENGE, G24_JUDGMENT_B_CHALLENGE],
      G24_MANIFEST_CHALLENGE,
      challengeGates,
      usesAi,
    ),
  );

  const fanGates = OPPORTUNITIES.flatMap((opportunityRef, index) =>
    G24_HARD_GATES.map((gate) => {
      const support = supportGates.includes(gate);
      return {
        opportunity_ref: opportunityRef,
        gate_id: gate,
        status:
          usesAi && gate === "ai_mandatory_bundle"
            ? "insufficient_evidence"
            : gate.startsWith("ai_")
              ? "not_applicable"
              : "insufficient_evidence",
        source_branch_refs: [support ? G24_BRANCH_SUPPORT : G24_BRANCH_CHALLENGE],
        judgment_assessment_refs: [
          support
            ? ([G24_JUDGMENT_A_SUPPORT, G24_JUDGMENT_B_SUPPORT][index] as string)
            : ([G24_JUDGMENT_A_CHALLENGE, G24_JUDGMENT_B_CHALLENGE][index] as string),
        ],
        limitations: [SYNTHETIC],
      };
    }),
  );
  add(G24_FAN_IN, {
    schema_version: "startup_opportunity.enrichment_fan_in.v1",
    fan_in_id: "enrichment_fan_in",
    revision: 1,
    parent_fan_in_ref: null,
    parent_content_hash: null,
    run_id: runId,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    source_snapshot_ref: G23_SNAPSHOT,
    source_merge_ref: G23_MERGE,
    opportunity_refs: [...OPPORTUNITIES],
    branch_result_classification: {
      completed_refs: [],
      partial_refs: [],
      insufficient_evidence_refs: [G24_BRANCH_SUPPORT, G24_BRANCH_CHALLENGE],
      failed_refs: [],
      ignored_late_refs: [],
      superseded_refs: [],
      cancelled_unit_ids: [],
      skipped_unit_ids: [],
      missing_unit_ids: [],
      decision_impact_of_gaps: [SYNTHETIC],
    },
    eligible_branch_refs: [G24_BRANCH_SUPPORT, G24_BRANCH_CHALLENGE],
    evidence_refs: [G24_EVIDENCE_SUPPORT, G24_EVIDENCE_CHALLENGE],
    claim_refs: [G24_CLAIM_SUPPORT, G24_CLAIM_CHALLENGE],
    finding_refs: [G24_FINDING_SUPPORT, G24_FINDING_CHALLENGE],
    insight_refs: [G24_INSIGHT_SUPPORT, G24_INSIGHT_CHALLENGE],
    judgment_assessment_refs: [
      G24_JUDGMENT_A_SUPPORT,
      G24_JUDGMENT_B_SUPPORT,
      G24_JUDGMENT_A_CHALLENGE,
      G24_JUDGMENT_B_CHALLENGE,
    ],
    source_manifest_refs: [G24_MANIFEST_SUPPORT, G24_MANIFEST_CHALLENGE],
    hard_gate_inputs: fanGates,
    opportunity_conclusion_ceilings: OPPORTUNITIES.map((opportunityRef) => ({
      opportunity_ref: opportunityRef,
      decision_sufficiency: "insufficient",
      conclusion_ceiling: "investigate_further",
      basis_branch_refs: [G24_BRANCH_SUPPORT, G24_BRANCH_CHALLENGE],
      limitations: [SYNTHETIC],
    })),
    source_group_overlap_disclosures: [SYNTHETIC],
    reference_only: true,
    source_boundary: boundary(),
    limitations: [SYNTHETIC],
  });

  for (const [path, document] of [
    ...domainDocuments(runId, G23_OPPORTUNITY_A, "a", [
      G24_JUDGMENT_A_SUPPORT,
      G24_JUDGMENT_A_CHALLENGE,
    ]),
    ...domainDocuments(runId, G23_OPPORTUNITY_B, "b", [
      G24_JUDGMENT_B_SUPPORT,
      G24_JUDGMENT_B_CHALLENGE,
    ]),
  ]) {
    add(path, document);
  }
  add(
    G24_COMPARISON_A,
    comparison(
      runId,
      G23_OPPORTUNITY_A,
      "a",
      [G24_JUDGMENT_A_SUPPORT, G24_JUDGMENT_A_CHALLENGE],
      documents,
      usesAi,
    ),
  );
  add(
    G24_COMPARISON_B,
    comparison(
      runId,
      G23_OPPORTUNITY_B,
      "b",
      [G24_JUDGMENT_B_SUPPORT, G24_JUDGMENT_B_CHALLENGE],
      documents,
      usesAi,
    ),
  );
  add(G24_SENSITIVITY, {
    schema_version: "startup_opportunity.sensitivity.v1",
    sensitivity_id: "sensitivity_discovery",
    run_id: runId,
    source_snapshot_ref: G23_SNAPSHOT,
    comparison_refs: [G24_COMPARISON_A, G24_COMPARISON_B],
    comparison_policy_version: "1.0.0",
    scenario_relations: ["downside", "expected", "upside"].map((scenario) => ({
      scenario,
      leader_group_refs: [...OPPORTUNITIES],
      relation: "evidence_insufficient_for_ordering",
      changed_dimensions: [SYNTHETIC],
      limitations: [SYNTHETIC],
    })),
    pairwise_relations: [
      {
        left_opportunity_ref: G23_OPPORTUNITY_A,
        right_opportunity_ref: G23_OPPORTUNITY_B,
        relation: "insufficient_evidence",
        basis_panel_ids: ["demand_and_market", "evidence_strength"],
        limitations: [SYNTHETIC],
      },
    ],
    robust_leader_refs: [],
    close_to_indistinguishable_groups: [],
    evidence_insufficient_for_ordering_refs: [...OPPORTUNITIES],
    most_sensitive_dimensions: [SYNTHETIC],
    stability_band: "unknown",
    global_score_used: false,
    limitations: [SYNTHETIC],
  });
  add(G24_PORTFOLIO, {
    schema_version: "startup_opportunity.portfolio_view.v1",
    portfolio_id: "portfolio_discovery",
    run_id: runId,
    sensitivity_ref: G24_SENSITIVITY,
    comparison_refs: [G24_COMPARISON_A, G24_COMPARISON_B],
    recommended_first_bet: null,
    alternative_bets: [...OPPORTUNITIES],
    watchlist_refs: [],
    rejected_refs: [],
    shared_distribution_or_capabilities: [SYNTHETIC],
    resource_conflicts: [SYNTHETIC],
    risk_correlation: [SYNTHETIC],
    learning_reuse: [SYNTHETIC],
    optimization_claimed: false,
    limitations: [SYNTHETIC],
  });
  add(G24_RECOMMENDATION, {
    schema_version: "startup_opportunity.decision_recommendation.v1",
    recommendation_id: "decision_recommendation_discovery",
    run_id: runId,
    decision_context_ref: G21_DECISION_REF,
    source_snapshot_ref: G23_SNAPSHOT,
    comparison_refs: [G24_COMPARISON_A, G24_COMPARISON_B],
    sensitivity_ref: G24_SENSITIVITY,
    recommended_first_bet: null,
    alternative_bets: [...OPPORTUNITIES],
    rejected_or_watchlist_refs: [],
    decision_tier: "investigate_further",
    decision_value_band: "unknown",
    uncertainty_band: "high",
    decisive_supporting_refs: [G24_CLAIM_SUPPORT],
    decisive_opposing_refs: [G24_CLAIM_CHALLENGE],
    decisive_judgment_assessment_refs: [
      G24_JUDGMENT_A_SUPPORT,
      G24_JUDGMENT_A_CHALLENGE,
      G24_JUDGMENT_B_SUPPORT,
      G24_JUDGMENT_B_CHALLENGE,
    ],
    business_engine_refs: [G24_ENGINE_A, G24_ENGINE_B],
    rationale: SYNTHETIC,
    critical_unknowns: [SYNTHETIC],
    what_would_change_the_decision: ["Real, current, independent Evidence."],
    recommended_next_action:
      "User may decide whether to commission external validation; Harness cannot execute it.",
    belief_update_summary: {
      initial_belief: SYNTHETIC,
      evidence_that_changed_belief: [],
      unchanged_assumptions: [SYNTHETIC],
      remaining_disagreement: [SYNTHETIC],
      final_decision_owner: "user",
    },
    validation_suggestion_refs: [],
    portfolio_view_ref: G24_PORTFOLIO,
    external_action_boundary: externalBoundary(),
    limitations: [SYNTHETIC],
  });
  const traceInputRefs = [
    G23_SNAPSHOT,
    G24_FAN_IN,
    G24_RECOMMENDATION,
    G24_COMPARISON_A,
    G24_COMPARISON_B,
    G24_JUDGMENT_A_SUPPORT,
    G24_JUDGMENT_B_SUPPORT,
  ];
  add(G24_TRACEABILITY, {
    schema_version: "startup_opportunity.traceability.v2",
    traceability_id: "traceability_discovery",
    run_id: runId,
    source_snapshot_ref: G23_SNAPSHOT,
    decision_recommendation_ref: G24_RECOMMENDATION,
    comparison_refs: [G24_COMPARISON_A, G24_COMPARISON_B],
    enrichment_fan_in_ref: G24_FAN_IN,
    decisive_judgment_assessment_refs: [
      G24_JUDGMENT_A_SUPPORT,
      G24_JUDGMENT_A_CHALLENGE,
      G24_JUDGMENT_B_SUPPORT,
      G24_JUDGMENT_B_CHALLENGE,
    ],
    statements: [
      [
        "statement_a",
        G23_OPPORTUNITY_A,
        G24_JUDGMENT_A_SUPPORT,
        G24_CLAIM_SUPPORT,
        G24_EVIDENCE_SUPPORT,
        G24_MANIFEST_SUPPORT,
      ],
      [
        "statement_a_opposition",
        G23_OPPORTUNITY_A,
        G24_JUDGMENT_A_CHALLENGE,
        G24_CLAIM_CHALLENGE,
        G24_EVIDENCE_CHALLENGE,
        G24_MANIFEST_CHALLENGE,
      ],
      [
        "statement_b",
        G23_OPPORTUNITY_B,
        G24_JUDGMENT_B_SUPPORT,
        G24_CLAIM_SUPPORT,
        G24_EVIDENCE_SUPPORT,
        G24_MANIFEST_SUPPORT,
      ],
      [
        "statement_b_opposition",
        G23_OPPORTUNITY_B,
        G24_JUDGMENT_B_CHALLENGE,
        G24_CLAIM_CHALLENGE,
        G24_EVIDENCE_CHALLENGE,
        G24_MANIFEST_CHALLENGE,
      ],
    ].map(([id, subject, judgmentRef, claimRef, evidenceRef, manifestRef]) => ({
      statement_id: id,
      statement_kind: "limitation",
      subject_ref: subject,
      judgment_assessment_ref: judgmentRef,
      claim_refs: [claimRef],
      evidence_refs: [evidenceRef],
      source_manifest_refs: [manifestRef],
      freshness_status: "unknown",
      limitations: [SYNTHETIC],
    })),
    input_artifact_hashes: hashRefs(traceInputRefs, documents),
    freshness_summary: {
      valid_as_of: "2026-07-27",
      current_refs: [],
      stale_refs: [],
      unknown_refs: [G24_EVIDENCE_SUPPORT, G24_EVIDENCE_CHALLENGE],
      conclusion_impact: SYNTHETIC,
    },
    all_decisive_refs_traced: true,
    external_validation_claimed: false,
    limitations: [SYNTHETIC],
  });
  const reportInputRefs = [G24_RECOMMENDATION, G24_PORTFOLIO, G24_SENSITIVITY, G24_TRACEABILITY];
  const reportSections = Object.fromEntries(
    [
      "conclusion_summary",
      "scope_and_profile",
      "decision_recommendation",
      "portfolio",
      "comparison_and_partial_order",
      "method_and_limitations",
      "top_opportunities",
      "watchlist_and_reject",
      "sensitivity",
      "traceability_and_sources",
    ].map((section) => [section, [SYNTHETIC]]),
  );
  add(G24_REPORT, {
    schema_version: "startup_opportunity.report.v1",
    report_id: "discovery_report",
    run_id: runId,
    producer_role: "main_agent",
    owned_output_path: G24_REPORT,
    materialized_path: "report.json",
    report_metadata: {
      mode: "opportunity_discovery",
      generated_at: "2026-07-27T21:30:00Z",
      valid_as_of: "2026-07-27",
      input_artifact_hashes: hashRefs(reportInputRefs, documents),
      external_validation_claimed: false,
      global_score_used: false,
    },
    decision_context_ref: G21_DECISION_REF,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    plan_lineage_refs: [G21_PLAN_REF],
    applied_adaptation_refs: [],
    decision_recommendation_ref: G24_RECOMMENDATION,
    portfolio_view_ref: G24_PORTFOLIO,
    comparison_refs: [G24_COMPARISON_A, G24_COMPARISON_B],
    business_engine_refs: [G24_ENGINE_A, G24_ENGINE_B],
    top_opportunity_refs: [],
    watchlist_refs: [],
    rejected_opportunity_refs: [],
    capability_only_signals: [],
    trend_only_signals: [],
    sensitivity_ref: G24_SENSITIVITY,
    judgment_assessment_refs: [
      G24_JUDGMENT_A_SUPPORT,
      G24_JUDGMENT_A_CHALLENGE,
      G24_JUDGMENT_B_SUPPORT,
      G24_JUDGMENT_B_CHALLENGE,
    ],
    source_manifest_refs: [G24_MANIFEST_SUPPORT, G24_MANIFEST_CHALLENGE],
    traceability_ref: G24_TRACEABILITY,
    curated_judgment_context: {
      decision_question: SYNTHETIC,
      current_recommendation: SYNTHETIC,
      decision_tier: "investigate_further",
      recommendation_meaning: SYNTHETIC,
      recommended_first_bet: null,
      alternative_bets: [...OPPORTUNITIES],
      partial_order_summary: SYNTHETIC,
      decisive_support: [{ summary: SYNTHETIC, refs: [G24_CLAIM_SUPPORT] }],
      decisive_opposition: [{ summary: SYNTHETIC, refs: [G24_CLAIM_CHALLENGE] }],
      critical_unknowns: [SYNTHETIC],
      what_would_change_the_decision: ["Real, current, independent Evidence."],
      belief_update_summary: {
        initial_belief: SYNTHETIC,
        evidence_that_changed_belief: [],
        unchanged_assumptions: [SYNTHETIC],
        remaining_disagreement: [SYNTHETIC],
        final_decision_owner: "user",
      },
      valid_as_of: "2026-07-27",
      scope_summary: SYNTHETIC,
      limitations: [SYNTHETIC],
      external_action_boundary: externalBoundary(),
    },
    report_sections: reportSections,
    freshness_summary: (documents.get(G24_TRACEABILITY)?.freshness_summary ?? {}) as Record<
      string,
      unknown
    >,
    limitations: [SYNTHETIC],
  });

  const v13Paths = [...documents.keys()].filter(
    (path) => !bundle.documents.some((entry) => entry.path === path),
  );
  const aiBinding = usesAi
    ? {
        status: "missing",
        trigger_version: "startup_opportunity.ai_mandatory_coverage_trigger.v1",
        subject_ref: G23_OPPORTUNITY_A,
        selected_solution_ref: G23_SOLUTION,
        bundle_ref: null,
        bundle_content_hash: null,
        coverage_state: "missing",
        conclusion_ceiling: "insufficient_evidence",
        not_required_reason: null,
      }
    : {
        status: "not_required",
        trigger_version: "startup_opportunity.ai_mandatory_coverage_trigger.v1",
        subject_ref: G23_OPPORTUNITY_A,
        selected_solution_ref: G23_SOLUTION,
        bundle_ref: null,
        bundle_content_hash: null,
        coverage_state: "not_required",
        conclusion_ceiling: "not_required",
        not_required_reason: "SYNTHETIC selected Solution has uses_ai=false.",
      };
  const aiConsumerPaths = new Set([
    G24_COMPARISON_A,
    G24_COMPARISON_B,
    G24_RECOMMENDATION,
    G24_TRACEABILITY,
    G24_REPORT,
  ]);
  const createdTimes = new Map<string, string>();
  v13Paths.forEach((path, index) => {
    createdTimes.set(
      path,
      new Date(Date.parse("2026-07-27T21:00:00Z") + index * 1000).toISOString(),
    );
  });
  (bundle.documents as { path: string; document: Record<string, unknown> }[]).push(
    ...v13Paths.map((path) => {
      const document = documents.get(path) as Record<string, unknown>;
      const producerRole =
        String(document.schema_version) === "startup_opportunity.research_task.v3"
          ? "main_agent"
          : [
                "startup_opportunity.evidence.v3",
                "startup_opportunity.claim.v3",
                "startup_opportunity.finding.v3",
                "startup_opportunity.insight.v3",
                "startup_opportunity.judgment_assessment.v3",
                "startup_opportunity.source_manifest.v3",
                "startup_opportunity.enrichment_branch_result.v1",
              ].includes(String(document.schema_version))
            ? "lane_researcher"
            : "main_agent";
      const wrapped = envelope(
        runId,
        path,
        document,
        createdTimes.get(path) as string,
        producerRole,
      );
      if (aiConsumerPaths.has(path)) {
        const consumerBinding = structuredClone(aiBinding);
        const subjectRef = path === G24_COMPARISON_B ? G23_OPPORTUNITY_B : G23_OPPORTUNITY_A;
        consumerBinding.subject_ref = subjectRef;
        wrapped.ai_bundle_binding = consumerBinding;
        (wrapped as { input_refs: readonly string[] }).input_refs = [
          ...new Set([...wrapped.input_refs, subjectRef, G23_SOLUTION]),
        ].sort();
      }
      return { path, document: wrapped as unknown as Record<string, unknown> };
    }),
  );
  const manifestEntry = bundle.documents.find((entry) => entry.path === "manifest.json");
  if (manifestEntry !== undefined) {
  }
  return bundle;
}

export function evaluationEnvelope(
  bundle: DocumentBundle,
  artifactPath: string,
): FormalArtifactEnvelope {
  const entry = bundle.documents.find((candidate) => candidate.path === artifactPath);
  if (entry === undefined) {
    throw new Error(`missing fixture artifact: ${artifactPath}`);
  }
  return entry.document as unknown as FormalArtifactEnvelope;
}

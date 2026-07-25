import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  type DocumentBundle,
  deriveReportEnvelopes,
  type EvidenceStoreRecordV2,
  type FormalArtifactEnvelope,
} from "../../../harness/src/index.js";
import {
  branchResearchEnvelopes,
  type FixtureBranch,
  G12_BASE_TIME,
  G12_RUN_ID,
  taskEnvelope,
} from "../g1.2/research-branch-fixture.js";

export type G14AssessmentResult =
  | "prioritize"
  | "investigate_further"
  | "deprioritize"
  | "insufficient_evidence";

export const G14_RUN_ID = G12_RUN_ID;
export const G14_VALID_AS_OF = "2026-07-25";
export const G14_REPORT_REF = "artifacts/reporting/report-json.r1.json";
export const G14_AUDIT_REF = "artifacts/audits/evidence-audit.r1.json";
export const G14_REVIEW_REF = "artifacts/reviews/adversarial-review.r1.json";
export const G14_ASSESSMENT_REF = "artifacts/assessment/concept-evidence-assessment.r1.json";
export const G14_TRACEABILITY_REF = "artifacts/traceability/traceability.r1.json";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const baseFixturePath = path.join(
  repositoryRoot,
  "tests/fixtures/g1.1/valid-assess-contract-bundle.json",
);

const DIMENSIONS = [
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

const CHALLENGES = [
  "strong_alternatives",
  "non_consumption",
  "buyer",
  "acquisition",
  "compliance",
  "migration",
  "service_burden",
  "ai_generic_platform_open_source_baseline",
  "thesis_killing_opposition",
  "conclusion_flipping_gap",
  "assessment_challenge",
] as const;

const HARD_GATES = [
  "target_user_and_jtbd",
  "baseline_delta",
  "buyer",
  "acquisition",
  "business_engine",
  "delivery_feasibility",
  "compliance_boundary",
  "counter_evidence",
  "evidence_quality",
  "source_independence",
  "freshness",
  "ai_mandatory_bundle",
] as const;

const BRANCHES: readonly FixtureBranch[] = [
  {
    unitId: "unit_target_user",
    dimensionId: "target_user_and_jtbd",
    outputPath: "artifacts/lanes/target-user.json",
    judgmentRef: "judgments/judgment-target-user.json",
    supportClaimType: "pain_point",
    opposeClaimType: "counter_evidence",
  },
  {
    unitId: "unit_demand",
    dimensionId: "demand_and_behavior",
    outputPath: "artifacts/lanes/demand.json",
    judgmentRef: "judgments/judgment-demand.json",
    supportClaimType: "behavior_signal",
    opposeClaimType: "counter_evidence",
  },
  {
    unitId: "unit_alternatives",
    dimensionId: "current_alternatives_and_solution_failure",
    outputPath: "artifacts/lanes/alternatives.json",
    judgmentRef: "judgments/judgment-alternatives.json",
    supportClaimType: "solution_failure",
    opposeClaimType: "alternative",
  },
  {
    unitId: "unit_competitor",
    dimensionId: "competitor_saturation_and_differentiation",
    outputPath: "artifacts/lanes/competitor.json",
    judgmentRef: "judgments/judgment-competitor.json",
    supportClaimType: "competitor_signal",
    opposeClaimType: "alternative",
  },
  {
    unitId: "unit_buyer",
    dimensionId: "buyer_language_and_willingness_to_pay",
    outputPath: "artifacts/lanes/buyer.json",
    judgmentRef: "judgments/judgment-buyer.json",
    supportClaimType: "buyer_signal",
    opposeClaimType: "counter_evidence",
  },
  {
    unitId: "unit_acquisition",
    dimensionId: "acquisition_and_distribution",
    outputPath: "artifacts/lanes/acquisition.json",
    judgmentRef: "judgments/judgment-acquisition.json",
    supportClaimType: "acquisition_signal",
    opposeClaimType: "counter_evidence",
  },
  {
    unitId: "unit_business",
    dimensionId: "business_engine_viability",
    outputPath: "artifacts/lanes/business.json",
    judgmentRef: "judgments/judgment-business.json",
    supportClaimType: "buyer_signal",
    opposeClaimType: "counter_evidence",
  },
  {
    unitId: "unit_delivery",
    dimensionId: "delivery_feasibility",
    outputPath: "artifacts/lanes/delivery.json",
    judgmentRef: "judgments/judgment-delivery.json",
    supportClaimType: "feasibility_signal",
    opposeClaimType: "counter_evidence",
  },
  {
    unitId: "unit_compliance",
    dimensionId: "compliance_and_platform_risk",
    outputPath: "artifacts/lanes/compliance.json",
    judgmentRef: "judgments/judgment-compliance.json",
    supportClaimType: "compliance_risk",
    opposeClaimType: "counter_evidence",
  },
  {
    unitId: "unit_counter",
    dimensionId: "counter_evidence",
    outputPath: "artifacts/lanes/counter.json",
    judgmentRef: "judgments/judgment-counter.json",
    supportClaimType: "counter_evidence",
    opposeClaimType: "counter_evidence",
  },
] as const;

const SUPPORT_EVIDENCE_REF = `evidence/records/ev_${"1".repeat(64)}.json`;
const OPPOSE_EVIDENCE_REF = `evidence/records/ev_${"2".repeat(64)}.json`;
const SUPPORT_CLAIM_REF = "claims/unit_demand-support.json";
const OPPOSE_CLAIM_REF = "claims/unit_demand-oppose.json";
const FINDING_REF = "findings/unit_demand.json";
const INSIGHT_REF = "insights/unit_demand.json";
const SOURCE_MANIFEST_REF = "evidence/source-manifests/unit_demand.json";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hash(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function substrateRecord(
  evidenceDigit: "1" | "2",
  source: EvidenceStoreRecordV2["source"],
  offset: number,
): EvidenceStoreRecordV2 {
  return {
    schema_version: "startup_opportunity.evidence_store_record.v2",
    evidence_id: `ev_${evidenceDigit.repeat(64)}`,
    run_id: G14_RUN_ID,
    unit_id: "unit_demand",
    source,
    source_hash: hash(evidenceDigit === "1" ? "a" : "b"),
    content_hash: hash(evidenceDigit === "1" ? "c" : "d"),
    research_goal: "Exercise a synthetic G1.4 contract scenario without market assertions.",
    raw_content_ref: `evidence/raw/sha256-${evidenceDigit === "1" ? "c".repeat(64) : "d".repeat(64)}.bin`,
    operation_key: hash(evidenceDigit === "1" ? "e" : "f"),
    recorded_at: `2026-07-25T18:0${offset}:00Z`,
  };
}

const SYNTHETIC_RECORDS = [
  substrateRecord(
    "1",
    { kind: "public_url", canonical_url: "https://g1-4-support.synthetic.invalid/source" },
    1,
  ),
  substrateRecord(
    "2",
    {
      kind: "user_provided",
      canonical_uri: "urn:startup-opportunity:user-provided:g1-4:opposition",
    },
    2,
  ),
] as const;

function effectiveDecision(result: G14AssessmentResult, dimension: string): string {
  if (result === "insufficient_evidence") {
    return "insufficient_evidence";
  }
  if (result === "investigate_further" && dimension === "demand_and_behavior") {
    return "mixed";
  }
  if (result === "deprioritize" && dimension === "counter_evidence") {
    return "opposes";
  }
  return "supports";
}

function judgmentSignal(decision: string): string {
  return decision === "supports"
    ? "supported"
    : decision === "opposes"
      ? "opposed"
      : decision === "mixed"
        ? "mixed"
        : "no_signal";
}

function inputHashes(
  documents: ReadonlyMap<string, Record<string, unknown>>,
  refs: readonly string[],
): readonly Record<string, string>[] {
  return [...new Set(refs)].sort().map((ref) => {
    const target = documents.get(ref.split("#", 1)[0] ?? "");
    if (target === undefined) {
      throw new Error(`missing synthetic input hash target ${ref}`);
    }
    return { ref, content_hash: canonicalContentHash(target) };
  });
}

function envelope(
  artifactPath: string,
  document: Record<string, unknown>,
  producerRole: string,
  inputRefs: readonly string[],
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.v7",
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    run_id: G14_RUN_ID,
    created_at: "2026-07-25T19:00:00Z",
    producer_role: producerRole,
    input_refs: [...new Set(inputRefs)].sort(),
    content_hash: canonicalContentHash(document),
    document,
  };
}

function lineage() {
  return {
    concept_hypothesis_ref: "concept-hypothesis.json",
    scope_frame_ref: "scope-frame.json",
    research_plan_ref: "plans/research-plan.r1.json",
    assessment_plan_ref: "plans/concept-evidence-assessment-plan.r1.json",
    plan_lineage_refs: ["plans/research-plan.r1.json"],
    applied_adaptation_refs: [],
  };
}

function makeManifest(): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.run_manifest.v1",
    run_id: G14_RUN_ID,
    mode: "concept_evidence_assessment",
    status: "reporting",
    status_before_clarification: null,
    parent_run_id: null,
    created_at: G12_BASE_TIME,
    updated_at: "2026-07-25T19:00:00Z",
    skill_version: "1.0.0",
    policy_version: "1.0.0",
    schema_bundle_version: "6.0.0",
    git_commit: null,
    current_phase: "assessment",
    current_plan_ref: "plans/research-plan.r1.json",
    plan_revision: 1,
    followup_round: 0,
    latest_gap_snapshot_ref: null,
    pending_adaptation_refs: [],
    validated_adaptation_refs: [],
    rejected_adaptation_refs: [],
    applied_adaptation_refs: [],
    completed_units: BRANCHES.map((branch) => branch.unitId).sort(),
    active_units: [],
    failed_units: [],
    invalidated_units: [],
    skipped_units: [],
    cancelled_units: [],
    superseded_units: [],
    ignored_late_artifact_refs: [],
    artifact_refs: [],
    checkpoint_ref: null,
    limitations: ["SYNTHETIC mechanical contract scenario only."],
  };
}

function externalBoundary() {
  return {
    execution_owner: "user",
    execution_supported: false,
    result_tracking_supported: false,
    external_validation_claimed: false,
  };
}

export async function createG14ContractBundle(
  result: G14AssessmentResult = "insufficient_evidence",
): Promise<DocumentBundle> {
  const base = JSON.parse(await readFile(baseFixturePath, "utf8")) as {
    readonly documents: readonly {
      readonly path: string;
      readonly document: Record<string, unknown>;
    }[];
  };
  const documents = new Map<string, Record<string, unknown>>();
  for (const entry of base.documents) {
    if (entry.path === "artifacts/synthesis/concept-evidence-assessment.json") {
      continue;
    }
    documents.set(entry.path, { ...clone(entry.document), run_id: G14_RUN_ID });
  }
  documents.set("manifest.json", makeManifest());

  for (const branch of BRANCHES) {
    documents.set(
      `tasks/${branch.unitId}.attempt-1.json`,
      clone(taskEnvelope(base, branch, 2).document),
    );
  }

  const demandBranch = BRANCHES.find((branch) => branch.unitId === "unit_demand");
  if (demandBranch === undefined) {
    throw new Error("synthetic demand branch is missing");
  }
  const chain = branchResearchEnvelopes(demandBranch, SYNTHETIC_RECORDS, 0);
  for (const entry of chain) {
    if (entry.artifact_path === demandBranch.outputPath) {
      documents.set(entry.artifact_path, clone(entry.document));
      continue;
    }
    documents.set(entry.artifact_path, clone(entry.document));
  }

  const highQuality = result !== "insufficient_evidence";
  for (const [index, ref] of [SUPPORT_EVIDENCE_REF, OPPOSE_EVIDENCE_REF].entries()) {
    const evidence = documents.get(ref);
    if (evidence === undefined) {
      throw new Error(`missing synthetic Evidence ${ref}`);
    }
    evidence.evidence_tier = highQuality ? "observed_workflow" : "model_inference_only";
    evidence.evidence_lifecycle_status = highQuality ? "active" : "unverified";
    if (highQuality) {
      evidence.source_type = index === 0 ? "public_report" : "user_existing_behavior_record";
    }
    const sourceAssessment = evidence.source_assessment as Record<string, unknown>;
    sourceAssessment.independence = highQuality
      ? index === 0
        ? "primary"
        : "independent_secondary"
      : "unknown";
  }

  for (const branch of BRANCHES) {
    const decision = effectiveDecision(result, branch.dimensionId);
    const sufficiency = decision === "insufficient_evidence" ? "insufficient" : "sufficient";
    const judgment = documents.get(branch.judgmentRef);
    const branchResult = documents.get(branch.outputPath);
    if (judgment === undefined || branchResult === undefined) {
      throw new Error(`missing synthetic branch inputs for ${branch.unitId}`);
    }
    judgment.judgment_signal = judgmentSignal(decision);
    judgment.evidence_tier_summary = highQuality ? ["observed_workflow"] : ["model_inference_only"];
    judgment.supporting_claim_refs = ["claim_unit_demand_support"];
    judgment.opposing_claim_refs = ["claim_unit_demand_oppose"];
    judgment.representativeness = "SYNTHETIC schema/gate scenario; not a population estimate.";
    judgment.independence = highQuality
      ? "two synthetic source groups"
      : "unverified synthetic sources";
    judgment.decision_sufficiency = sufficiency;
    judgment.insufficiency_reasons = sufficiency === "insufficient" ? ["no_signal"] : [];
    judgment.what_would_change_the_decision = [
      "Real same-scope Evidence could change this fixture result.",
    ];
    judgment.valid_as_of = G14_VALID_AS_OF;
    judgment.limitations = ["SYNTHETIC mechanical gate scenario only."];
    branchResult.branch_status =
      decision === "insufficient_evidence" ? "insufficient_evidence" : "completed";
    branchResult.dimension_decision = decision;
    branchResult.decision_sufficiency = sufficiency;
    branchResult.insufficiency_reasons = sufficiency === "insufficient" ? ["no_signal"] : [];
    branchResult.evidence_quality = highQuality ? "high" : "low";
    branchResult.uncertainty = highQuality ? "low" : "high";
    branchResult.what_would_change_decision = [
      "Real same-scope Evidence could change this fixture result.",
    ];
    branchResult.limitations = ["SYNTHETIC schema/gate scenario only."];
  }

  const fanIn = documents.get("artifacts/synthesis/assessment-fan-in.json");
  const matrix = documents.get("artifacts/synthesis/hypothesis-evidence-matrix.json");
  const engine = documents.get("artifacts/synthesis/business-engine.json");
  if (fanIn === undefined || matrix === undefined || engine === undefined) {
    throw new Error("synthetic synthesis inputs are missing");
  }
  for (const summary of fanIn.dimension_summaries as Record<string, unknown>[]) {
    const decision = effectiveDecision(result, String(summary.dimension_id));
    summary.decision_sufficiency =
      decision === "insufficient_evidence" ? "insufficient" : "sufficient";
    summary.insufficiency_reasons = decision === "insufficient_evidence" ? ["no_signal"] : [];
    summary.decisive_supporting_refs = decision === "supports" ? ["claim_unit_demand_support"] : [];
    summary.decisive_opposing_refs = decision === "opposes" ? ["claim_unit_demand_oppose"] : [];
    summary.what_would_change_the_assessment = [
      "Real same-scope Evidence could change this fixture result.",
    ];
  }
  fanIn.evidence_gaps =
    result === "insufficient_evidence" ? ["Only low-tier synthetic inputs exist."] : [];
  fanIn.decision_impact_of_gaps = result === "insufficient_evidence" ? ["concept_assessment"] : [];
  fanIn.limitations = ["SYNTHETIC fan-in scenario only."];

  for (const dimension of matrix.dimensions as Record<string, unknown>[]) {
    const decision = effectiveDecision(result, String(dimension.dimension_id));
    dimension.decision = decision;
    dimension.decision_sufficiency =
      decision === "insufficient_evidence" ? "insufficient" : "sufficient";
    dimension.evidence_quality = highQuality ? "high" : "low";
    dimension.freshness = highQuality ? "current" : "unverified";
    dimension.insufficiency_reasons = decision === "insufficient_evidence" ? ["no_signal"] : [];
    dimension.uncertainty = highQuality ? "low" : "high";
    dimension.what_would_change_decision = [
      "Real same-scope Evidence could change this fixture result.",
    ];
    dimension.limitations = ["SYNTHETIC matrix scenario only."];
  }
  matrix.decisive_evidence_refs = highQuality ? [`ev_${"1".repeat(64)}`] : [];
  matrix.decisive_opposing_refs = result === "deprioritize" ? [`ev_${"2".repeat(64)}`] : [];
  matrix.critical_gaps =
    result === "insufficient_evidence" ? ["Only low-tier synthetic inputs exist."] : [];
  matrix.limitations = ["SYNTHETIC matrix scenario only."];

  Object.assign(engine, {
    pricing_unit: highQuality ? "synthetic_per_account_scenario" : "unknown",
    usage_or_purchase_frequency: highQuality ? "synthetic_monthly_scenario" : "unknown",
    retention_or_repeat_trigger: highQuality ? "synthetic_workflow_repetition" : "unknown",
    gross_margin_band: highQuality ? "medium" : "unknown",
    service_and_support_burden: highQuality ? "medium" : "unknown",
    cac_hypothesis: highQuality ? "synthetic_channel_scenario" : "unknown",
    payback_logic: highQuality ? "synthetic_unverified_payback" : "unknown",
    reachable_beachhead_market: highQuality ? "synthetic_scope_only" : "unknown",
    channel_dependency: highQuality ? ["synthetic_channel"] : [],
    growth_loop: highQuality ? "synthetic_referral_scenario" : "unknown",
    minimum_viable_scale: highQuality ? "synthetic_unverified_scale" : "unknown",
    assumptions: ["All BusinessEngine values are synthetic gate inputs."],
    supporting_claim_refs: ["claim_unit_demand_support"],
    opposing_claim_refs: ["claim_unit_demand_oppose"],
    unknowns: highQuality
      ? []
      : [
          "pricing_unit",
          "retention_or_repeat_trigger",
          "reachable_beachhead_market",
          "service_and_support_burden",
        ],
    limitations: ["SYNTHETIC BusinessEngine scenario; not operating data."],
  });

  const evidenceRefs = [SUPPORT_EVIDENCE_REF, OPPOSE_EVIDENCE_REF];
  const claimRefs = [SUPPORT_CLAIM_REF, OPPOSE_CLAIM_REF];
  const auditDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.evidence_audit.v1",
    audit_id: "evidence_audit_g1_4_synthetic",
    run_id: G14_RUN_ID,
    producer_role: "evidence_auditor",
    owned_output_path: G14_AUDIT_REF,
    lineage: lineage(),
    input_artifact_hashes: inputHashes(documents, [
      SOURCE_MANIFEST_REF,
      ...evidenceRefs,
      ...claimRefs,
    ]),
    source_manifest_refs: [SOURCE_MANIFEST_REF],
    evidence_reviews: evidenceRefs.map((ref, index) => {
      const evidence = documents.get(ref) as Record<string, unknown>;
      const sourceAssessment = evidence.source_assessment as Record<string, unknown>;
      return {
        evidence_ref: ref,
        source_manifest_ref: SOURCE_MANIFEST_REF,
        provenance_status: highQuality ? "verified" : "incomplete",
        canonical_source_group: sourceAssessment.canonical_source_group,
        shared_dataset_group: sourceAssessment.shared_dataset_group,
        syndication_group: sourceAssessment.syndication_group,
        independence: sourceAssessment.independence,
        evidence_tier: evidence.evidence_tier,
        representativeness_status:
          result === "investigate_further" && index === 0
            ? "limited"
            : highQuality
              ? "adequate"
              : "unknown",
        bias_status: highQuality ? "disclosed" : "missing",
        geo: evidence.geo,
        language: evidence.language,
        freshness_status: highQuality ? "current" : "unknown",
        quote_provenance_status: "not_a_quote",
        decisive: true,
        audit_status:
          result === "investigate_further" && index === 0
            ? "limited"
            : highQuality
              ? "accepted"
              : "limited",
        limitations: ["SYNTHETIC evidence quality scenario only."],
      };
    }),
    claim_reviews: claimRefs.map((ref, index) => ({
      claim_ref: ref,
      evidence_refs: [evidenceRefs[index]],
      support_fidelity: "faithful",
      quote_fidelity: "not_a_quote",
      decisive: false,
      limitations: ["No user quote is present."],
    })),
    stance_balance: DIMENSIONS.map((dimension) => ({
      dimension,
      supporting_claim_count: 1,
      opposing_claim_count: 1,
      status: "balanced",
      limitations: ["Counts represent a synthetic gate scenario."],
    })),
    rejected_source_record_count: 0,
    unavailable_source_record_count: 0,
    conclusion_ceiling:
      result === "insufficient_evidence"
        ? "insufficient_evidence_required"
        : result === "investigate_further"
          ? "investigate_further_max"
          : "prioritize_allowed",
    revision_requests: [],
    evaluator_result: result === "insufficient_evidence" ? "insufficient_evidence" : "passed",
    evaluation_issues: [],
    mutates_upstream_artifacts: false,
    valid_as_of: G14_VALID_AS_OF,
    limitations: ["SYNTHETIC audit scenario; no real Evidence was audited."],
  };
  documents.set(G14_AUDIT_REF, auditDocument);

  const reviewDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.adversarial_review.v1",
    review_id: "adversarial_review_g1_4_synthetic",
    run_id: G14_RUN_ID,
    producer_role: "adversarial_reviewer",
    owned_output_path: G14_REVIEW_REF,
    lineage: lineage(),
    input_artifact_hashes: inputHashes(documents, [
      "artifacts/synthesis/hypothesis-evidence-matrix.json",
      "artifacts/synthesis/business-engine.json",
      G14_AUDIT_REF,
      SOURCE_MANIFEST_REF,
    ]),
    hypothesis_evidence_matrix_ref: "artifacts/synthesis/hypothesis-evidence-matrix.json",
    business_engine_ref: "artifacts/synthesis/business-engine.json",
    evidence_audit_ref: G14_AUDIT_REF,
    challenger_source_manifest_refs: [SOURCE_MANIFEST_REF],
    source_group_independence: {
      generation_groups: [],
      evaluation_groups: ["source_group_unit_demand_1"],
      challenger_groups: ["source_group_unit_demand_2"],
      generation_evaluation_overlap: "none",
      challenger_overlap: "none",
      status: "independent",
    },
    challenges: CHALLENGES.map((dimension) => ({
      challenge_id: `challenge_${dimension}`,
      dimension,
      status:
        dimension === "ai_generic_platform_open_source_baseline" ? "not_applicable" : "supported",
      summary: `SYNTHETIC challenge coverage for ${dimension}; no market assertion.`,
      evidence_refs: dimension === "thesis_killing_opposition" ? [OPPOSE_EVIDENCE_REF] : [],
      claim_refs: dimension === "thesis_killing_opposition" ? [OPPOSE_CLAIM_REF] : [],
      severity: dimension === "thesis_killing_opposition" ? "blocking" : "advisory",
      thesis_killing: dimension === "thesis_killing_opposition",
      resolved: !(result === "deprioritize" && dimension === "thesis_killing_opposition"),
      limitations: ["SYNTHETIC adversarial scenario only."],
    })),
    decision_relevant_gaps: [],
    revision_requests: [],
    assessment_challenge: {
      challenged_result: "prioritize",
      recommended_result: result,
      rationale: "The synthetic gate inputs determine only the exercised contract branch.",
      decisive_opposition_refs: result === "deprioritize" ? [OPPOSE_EVIDENCE_REF] : [],
      what_would_reverse_challenge: ["Different validated same-scope Evidence and gate inputs."],
    },
    evaluator_result: "passed",
    evaluation_issues: [],
    mutates_current_plan: false,
    rewrites_final_report: false,
    valid_as_of: G14_VALID_AS_OF,
    limitations: ["SYNTHETIC review scenario; no independent research was performed."],
  };
  documents.set(G14_REVIEW_REF, reviewDocument);

  const gates = HARD_GATES.map((gateId) => {
    let status = result === "insufficient_evidence" ? "insufficient_evidence" : "passed";
    if (gateId === "ai_mandatory_bundle") {
      status = "not_applicable";
    }
    if (result === "deprioritize" && gateId === "baseline_delta") {
      status = "failed";
    }
    return {
      gate_id: gateId,
      status,
      decisive: gateId !== "ai_mandatory_bundle",
      reason: `SYNTHETIC ${gateId} gate scenario.`,
      supporting_refs: highQuality ? [SUPPORT_EVIDENCE_REF] : [],
      opposing_refs: result === "deprioritize" ? [OPPOSE_EVIDENCE_REF] : [],
      limitations: ["Mechanical gate input only."],
    };
  });
  const assessmentDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.concept_evidence_assessment.v2",
    assessment_id: "concept_evidence_assessment_g1_4_synthetic",
    run_id: G14_RUN_ID,
    producer_role: "main_agent",
    owned_output_path: G14_ASSESSMENT_REF,
    lineage: lineage(),
    input_artifact_hashes: inputHashes(documents, [
      "artifacts/synthesis/assessment-fan-in.json",
      "artifacts/synthesis/hypothesis-evidence-matrix.json",
      "artifacts/synthesis/business-engine.json",
      G14_AUDIT_REF,
      G14_REVIEW_REF,
    ]),
    fan_in_ref: "artifacts/synthesis/assessment-fan-in.json",
    hypothesis_evidence_matrix_ref: "artifacts/synthesis/hypothesis-evidence-matrix.json",
    business_engine_ref: "artifacts/synthesis/business-engine.json",
    evidence_audit_ref: G14_AUDIT_REF,
    adversarial_review_ref: G14_REVIEW_REF,
    assessment_profile: "general",
    ai_mandatory_bundle_status: "not_applicable",
    assessment_result: result,
    recommendation_meaning:
      result === "prioritize"
        ? "current_evidence_supports_priority_attention_not_market_validation"
        : result === "investigate_further"
          ? "current_evidence_supports_further_desk_research"
          : result === "deprioritize"
            ? "current_evidence_supports_deprioritization"
            : "current_evidence_cannot_support_a_directional_conclusion",
    market_validation_claimed: false,
    evidence_strength_band: highQuality ? "high" : "low",
    conclusion_ceiling: auditDocument.conclusion_ceiling,
    dimension_decisions: (matrix.dimensions as Record<string, unknown>[]).map((dimension) => ({
      dimension_id: dimension.dimension_id,
      matrix_dimension_ref: `artifacts/synthesis/hypothesis-evidence-matrix.json#${String(dimension.dimension_id)}`,
      decision: dimension.decision,
      decision_sufficiency: dimension.decision_sufficiency,
      decisive: true,
      judgment_assessment_refs: dimension.judgment_assessment_refs,
      limitations: ["SYNTHETIC dimension decision only."],
    })),
    hard_gate_results: gates,
    decisive_evidence_refs: highQuality ? [SUPPORT_EVIDENCE_REF] : [],
    decisive_opposing_refs: result === "deprioritize" ? [OPPOSE_EVIDENCE_REF] : [],
    critical_gaps:
      result === "insufficient_evidence"
        ? ["Only low-tier synthetic inputs exist."]
        : result === "investigate_further"
          ? ["One synthetic representativeness ceiling remains."]
          : [],
    what_would_change_the_decision: ["Real, current, independent same-scope Evidence."],
    conditions: ["The output describes only current desk Evidence mechanics."],
    kill_criteria: ["High-quality opposition can reverse a directional conclusion."],
    belief_update_summary: {
      initial_belief: "No thesis belief is established by a synthetic fixture.",
      evidence_that_changed_belief: highQuality ? [SUPPORT_EVIDENCE_REF] : [],
      unchanged_assumptions: ["No real market Evidence was collected."],
      remaining_disagreement: ["Thesis viability remains outside this fixture."],
      final_decision_owner: "user",
    },
    valid_as_of: G14_VALID_AS_OF,
    external_evidence_absence_effect: "conclusion_ceiling_or_limitation_only",
    external_action_boundary: externalBoundary(),
    limitations: ["SYNTHETIC schema/gate scenario; external validation was not performed."],
    evaluator_result: result === "insufficient_evidence" ? "insufficient_evidence" : "passed",
    evaluation_issues: [],
  };
  documents.set(G14_ASSESSMENT_REF, assessmentDocument);

  const traceabilityDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.traceability.v1",
    traceability_id: "traceability_g1_4_synthetic",
    run_id: G14_RUN_ID,
    producer_role: "harness",
    owned_output_path: G14_TRACEABILITY_REF,
    lineage: lineage(),
    input_artifact_hashes: inputHashes(documents, [
      G14_ASSESSMENT_REF,
      "artifacts/synthesis/hypothesis-evidence-matrix.json",
      "artifacts/synthesis/business-engine.json",
      G14_AUDIT_REF,
      G14_REVIEW_REF,
      "judgments/judgment-demand.json",
      INSIGHT_REF,
      FINDING_REF,
      SUPPORT_CLAIM_REF,
      SUPPORT_EVIDENCE_REF,
    ]),
    assessment_ref: G14_ASSESSMENT_REF,
    hypothesis_evidence_matrix_ref: "artifacts/synthesis/hypothesis-evidence-matrix.json",
    business_engine_ref: "artifacts/synthesis/business-engine.json",
    evidence_audit_ref: G14_AUDIT_REF,
    adversarial_review_ref: G14_REVIEW_REF,
    chains: [
      {
        chain_id: "trace_chain_decisive_1",
        report_statement_id: "report_statement_decisive_1",
        decision_brief_section: "current_recommendation",
        assessment_ref: G14_ASSESSMENT_REF,
        matrix_dimension_ref:
          "artifacts/synthesis/hypothesis-evidence-matrix.json#demand_and_behavior",
        judgment_assessment_ref: "judgments/judgment-demand.json",
        concept_subject_ref: "concept-hypothesis.json",
        insight_ref: INSIGHT_REF,
        finding_ref: FINDING_REF,
        claim_ref: SUPPORT_CLAIM_REF,
        evidence_ref: SUPPORT_EVIDENCE_REF,
        stance: "support",
      },
    ],
    coverage: {
      decisive_statement_count: 1,
      traced_decisive_statement_count: 1,
      untraced_statement_ids: [],
      result: "complete",
    },
    evaluator_result: "passed",
    evaluation_issues: [],
    valid_as_of: G14_VALID_AS_OF,
    limitations: ["SYNTHETIC traceability chain only."],
  };
  documents.set(G14_TRACEABILITY_REF, traceabilityDocument);

  const limitations = ["SYNTHETIC schema/gate scenario; external validation was not performed."];
  const reportDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.concept_evidence_report.v1",
    report_id: "concept_evidence_report_g1_4_synthetic",
    run_id: G14_RUN_ID,
    producer_role: "main_agent",
    owned_output_path: G14_REPORT_REF,
    materialized_path: "report.json",
    report_metadata: {
      mode: "concept_evidence_assessment",
      skill_version: "1.0.0",
      policy_version: "1.0.0",
      schema_bundle_version: "6.0.0",
      generated_at: "2026-07-25T19:00:00Z",
      valid_as_of: G14_VALID_AS_OF,
      input_artifact_hashes: inputHashes(documents, [
        "decision-context.json",
        "scope-frame.json",
        "concept-hypothesis.json",
        "plans/research-plan.r1.json",
        "plans/concept-evidence-assessment-plan.r1.json",
        "artifacts/synthesis/hypothesis-evidence-matrix.json",
        "artifacts/synthesis/business-engine.json",
        G14_AUDIT_REF,
        G14_REVIEW_REF,
        G14_ASSESSMENT_REF,
        G14_TRACEABILITY_REF,
      ]),
      external_validation_claimed: false,
    },
    decision_context_ref: "decision-context.json",
    concept_frame_ref: "scope-frame.json",
    concept_hypothesis_ref: "concept-hypothesis.json",
    evidence_assessment_plan_ref: "plans/concept-evidence-assessment-plan.r1.json",
    research_plan_ref: "plans/research-plan.r1.json",
    plan_lineage_refs: ["plans/research-plan.r1.json"],
    applied_adaptation_refs: [],
    hypothesis_evidence_matrix_ref: "artifacts/synthesis/hypothesis-evidence-matrix.json",
    adversarial_review_ref: G14_REVIEW_REF,
    evidence_audit_ref: G14_AUDIT_REF,
    concept_evidence_assessment_ref: G14_ASSESSMENT_REF,
    business_engine_ref: "artifacts/synthesis/business-engine.json",
    judgment_assessment_refs: BRANCHES.map((branch) => branch.judgmentRef),
    source_manifest_refs: [SOURCE_MANIFEST_REF],
    traceability_ref: G14_TRACEABILITY_REF,
    curated_judgment_context: {
      decision_question: "What does the current synthetic desk-Evidence gate scenario permit?",
      assessment_result: result,
      recommendation_meaning: assessmentDocument.recommendation_meaning,
      current_recommendation: `Apply the ${result} contract meaning only to this synthetic scenario.`,
      decisive_support: highQuality
        ? [
            {
              summary: "Synthetic supporting chain for contract validation.",
              refs: [SUPPORT_EVIDENCE_REF],
            },
          ]
        : [],
      decisive_opposition:
        result === "deprioritize"
          ? [
              {
                summary: "Synthetic opposition triggers the directional hard fail.",
                refs: [OPPOSE_EVIDENCE_REF],
              },
            ]
          : [],
      alternatives_not_selected: [
        "No alternative conclusion may exceed the deterministic ceiling.",
      ],
      critical_unknowns: strings(assessmentDocument.critical_gaps),
      what_would_change_the_decision: assessmentDocument.what_would_change_the_decision,
      belief_update_summary: assessmentDocument.belief_update_summary,
      scope_summary: "SYNTHETIC deterministic contract scenario; no market scope inference.",
      valid_as_of: G14_VALID_AS_OF,
      external_action_boundary: externalBoundary(),
      limitations,
    },
    report_sections: Object.fromEntries(
      [
        "assessment_result_and_evidence_strength",
        "concept_hypothesis",
        "decisive_support_and_opposition",
        "demand_alternatives_solution_failure",
        "competition_and_differentiation",
        "buyer_acquisition_business_engine",
        "feasibility_compliance_ai_bundle",
        "critical_unknowns_and_kill_criteria",
        "decision_recommendation",
        "optional_validation_suggestions",
        "limitations_and_sources",
      ].map((section) => [section, [`SYNTHETIC ${section} contract content only.`]]),
    ),
    statements: [
      {
        statement_id: "report_statement_decisive_1",
        text: "The deterministic gate yields the declared synthetic assessment result.",
        kind: "recommendation",
        decisive: true,
        traceability_chain_refs: ["trace_chain_decisive_1"],
      },
    ],
    freshness_summary: {
      valid_as_of: G14_VALID_AS_OF,
      current_decisive_evidence_count: highQuality ? 2 : 0,
      stale_decisive_evidence_count: 0,
      unknown_freshness_count: highQuality ? 0 : 2,
    },
    limitations,
  };
  documents.set(G14_REPORT_REF, reportDocument);

  const g14Envelopes = [
    envelope(G14_AUDIT_REF, auditDocument, "evidence_auditor", [
      SOURCE_MANIFEST_REF,
      ...evidenceRefs,
      ...claimRefs,
    ]),
    envelope(G14_REVIEW_REF, reviewDocument, "adversarial_reviewer", [
      "artifacts/synthesis/hypothesis-evidence-matrix.json",
      "artifacts/synthesis/business-engine.json",
      G14_AUDIT_REF,
      SOURCE_MANIFEST_REF,
    ]),
    envelope(G14_ASSESSMENT_REF, assessmentDocument, "main_agent", [
      "artifacts/synthesis/assessment-fan-in.json",
      "artifacts/synthesis/hypothesis-evidence-matrix.json",
      "artifacts/synthesis/business-engine.json",
      G14_AUDIT_REF,
      G14_REVIEW_REF,
    ]),
    envelope(G14_TRACEABILITY_REF, traceabilityDocument, "harness", [
      G14_ASSESSMENT_REF,
      "artifacts/synthesis/hypothesis-evidence-matrix.json",
      "artifacts/synthesis/business-engine.json",
      G14_AUDIT_REF,
      G14_REVIEW_REF,
      "judgments/judgment-demand.json",
      INSIGHT_REF,
      FINDING_REF,
      SUPPORT_CLAIM_REF,
      SUPPORT_EVIDENCE_REF,
    ]),
    envelope(G14_REPORT_REF, reportDocument, "main_agent", [
      "decision-context.json",
      "scope-frame.json",
      "concept-hypothesis.json",
      "plans/research-plan.r1.json",
      "plans/concept-evidence-assessment-plan.r1.json",
      "artifacts/synthesis/hypothesis-evidence-matrix.json",
      "artifacts/synthesis/business-engine.json",
      G14_AUDIT_REF,
      G14_REVIEW_REF,
      G14_ASSESSMENT_REF,
      G14_TRACEABILITY_REF,
    ]),
  ];
  const derived = deriveReportEnvelopes(g14Envelopes[4] as FormalArtifactEnvelope);
  const g14ByPath = new Map(
    [...g14Envelopes, ...derived].map((entry) => [entry.artifact_path, entry]),
  );
  const bundleDocuments = [...documents.entries()]
    .filter(([entryPath]) => !g14ByPath.has(entryPath))
    .map(([entryPath, document]) => ({ path: entryPath, document }));
  bundleDocuments.push(
    ...[...g14ByPath.values()].map((entry) => ({ path: entry.artifact_path, document: entry })),
  );
  return {
    schema_version: "startup_opportunity.document_bundle.v7",
    documents: bundleDocuments.sort((left, right) => left.path.localeCompare(right.path)),
    exact_records: SYNTHETIC_RECORDS.map((record) => ({
      ref: `evidence/manifest.jsonl#${record.evidence_id}`,
      document: record,
    })),
  };
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function g14SyntheticRecords(): readonly EvidenceStoreRecordV2[] {
  return clone(SYNTHETIC_RECORDS);
}

export function g14Branches(): readonly FixtureBranch[] {
  return BRANCHES;
}

function replaceStrings(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    return replacements.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceStrings(entry, replacements));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceStrings(entry, replacements)]),
    );
  }
  return value;
}

function effectiveDocument(entry: {
  readonly document: Record<string, unknown>;
}): Record<string, unknown> {
  return entry.document.schema_version === "startup_opportunity.artifact_envelope.v7"
    ? (entry.document.document as Record<string, unknown>)
    : entry.document;
}

export function refreshG14Bundle(input: DocumentBundle): DocumentBundle {
  const bundle = clone(input);
  const documents = bundle.documents as { path: string; document: Record<string, unknown> }[];
  const byPath = new Map(documents.map((entry) => [entry.path, effectiveDocument(entry)]));
  const refreshHashes = (document: Record<string, unknown>): void => {
    if (Array.isArray(document.input_artifact_hashes)) {
      document.input_artifact_hashes = inputHashes(
        byPath,
        document.input_artifact_hashes
          .filter(
            (entry): entry is Record<string, unknown> =>
              entry !== null && typeof entry === "object",
          )
          .map((entry) => String(entry.ref)),
      );
    }
  };
  for (const artifactPath of [
    G14_AUDIT_REF,
    G14_REVIEW_REF,
    G14_ASSESSMENT_REF,
    G14_TRACEABILITY_REF,
  ]) {
    const entry = documents.find((candidate) => candidate.path === artifactPath);
    if (entry === undefined) {
      continue;
    }
    const document = effectiveDocument(entry);
    refreshHashes(document);
    if (entry.document.schema_version === "startup_opportunity.artifact_envelope.v7") {
      entry.document.content_hash = canonicalContentHash(document);
    }
    byPath.set(artifactPath, document);
  }
  const reportEntry = documents.find((entry) => entry.path === G14_REPORT_REF);
  if (reportEntry !== undefined) {
    const report = effectiveDocument(reportEntry);
    const metadata = report.report_metadata as Record<string, unknown>;
    metadata.input_artifact_hashes = inputHashes(
      byPath,
      (metadata.input_artifact_hashes as Record<string, unknown>[]).map((entry) =>
        String(entry.ref),
      ),
    );
    reportEntry.document.content_hash = canonicalContentHash(report);
    byPath.set(G14_REPORT_REF, report);
    const derivedTypes = new Set([
      "startup_opportunity.decision_brief.v1",
      "startup_opportunity.concept_evidence_report_view.v1",
      "startup_opportunity.report_consistency_evaluation.v1",
    ]);
    const retained = documents.filter(
      (entry) => !derivedTypes.has(String(effectiveDocument(entry).schema_version)),
    );
    retained.push(
      ...deriveReportEnvelopes(reportEntry.document as FormalArtifactEnvelope).map((entry) => ({
        path: entry.artifact_path,
        document: entry,
      })),
    );
    return {
      ...bundle,
      documents: retained.sort((left, right) => left.path.localeCompare(right.path)),
    };
  }
  return bundle;
}

export function replaceG14EvidenceRecords(
  input: DocumentBundle,
  records: readonly [EvidenceStoreRecordV2, EvidenceStoreRecordV2],
): DocumentBundle {
  const replacements = new Map<string, string>();
  for (const [index, original] of SYNTHETIC_RECORDS.entries()) {
    const replacement = records[index];
    if (replacement === undefined) {
      throw new Error("synthetic Evidence replacement is incomplete");
    }
    replacements.set(original.evidence_id, replacement.evidence_id);
    replacements.set(
      `evidence/records/${original.evidence_id}.json`,
      `evidence/records/${replacement.evidence_id}.json`,
    );
    replacements.set(
      `evidence/manifest.jsonl#${original.evidence_id}`,
      `evidence/manifest.jsonl#${replacement.evidence_id}`,
    );
    for (const field of [
      "source_hash",
      "content_hash",
      "research_goal",
      "raw_content_ref",
      "operation_key",
      "recorded_at",
    ] as const) {
      replacements.set(String(original[field]), String(replacement[field]));
    }
  }
  const replaced = replaceStrings(clone(input), replacements) as DocumentBundle;
  for (const record of records) {
    const evidenceEntry = replaced.documents.find(
      (entry) => entry.path === `evidence/records/${record.evidence_id}.json`,
    );
    if (evidenceEntry === undefined) {
      throw new Error(`replaced synthetic Evidence ${record.evidence_id} is missing`);
    }
    const evidence = effectiveDocument(evidenceEntry);
    const mechanical = evidence.mechanical_binding as Record<string, unknown>;
    Object.assign(mechanical, {
      substrate_record_ref: `evidence/manifest.jsonl#${record.evidence_id}`,
      source: record.source,
      source_hash: record.source_hash,
      content_hash: record.content_hash,
      raw_content_ref: record.raw_content_ref,
      operation_key: record.operation_key,
      recorded_at: record.recorded_at,
    });
    evidence.retrieved_at = record.recorded_at;
    evidence.research_goal = record.research_goal;
    const provenance = evidence.provenance as Record<string, unknown>;
    provenance.user_provided_at =
      record.source.kind === "user_provided" ? record.recorded_at : null;
  }
  return refreshG14Bundle({
    ...replaced,
    exact_records: records.map((record) => ({
      ref: `evidence/manifest.jsonl#${record.evidence_id}`,
      document: record,
    })),
  });
}

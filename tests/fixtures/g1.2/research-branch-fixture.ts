import type { EvidenceStoreRecord, FormalArtifactEnvelope } from "../../../harness/src/index.js";
import { canonicalContentHash } from "../../../harness/src/index.js";

export const G12_RUN_ID = "run_g1_2_synthetic_001";
export const G12_BASE_TIME = "2026-07-24T20:00:00Z";

export interface FixtureBranch {
  readonly unitId: string;
  readonly dimensionId: string;
  readonly outputPath: string;
  readonly judgmentRef: string;
  readonly supportClaimType: string;
  readonly opposeClaimType: string;
}

export const G12_BRANCHES: readonly FixtureBranch[] = [
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
    unitId: "unit_acquisition",
    dimensionId: "acquisition_and_distribution",
    outputPath: "artifacts/lanes/acquisition.json",
    judgmentRef: "judgments/judgment-acquisition.json",
    supportClaimType: "acquisition_signal",
    opposeClaimType: "buyer_signal",
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

export function envelope(
  document: Record<string, unknown>,
  artifactPath: string,
  producerRole: "main_agent" | "lane_researcher" | "harness" = "main_agent",
  inputRefs: readonly string[] = [],
  createdAt = G12_BASE_TIME,
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    run_id: G12_RUN_ID,
    created_at: createdAt,
    producer_role: producerRole,
    input_refs: [...inputRefs],
    content_hash: canonicalContentHash(document),
    document,
  };
}

export function initialFixtureEnvelopes(baseBundle: {
  readonly documents: readonly {
    readonly path: string;
    readonly document: Record<string, unknown>;
  }[];
}): readonly FormalArtifactEnvelope[] {
  const selectedPaths = new Set([
    "intake.json",
    "decision-context.json",
    "scope-frame.json",
    "concept-hypothesis.json",
    "plans/research-plan.r1.json",
    "plans/concept-evidence-assessment-plan.r1.json",
    ...G12_BRANCHES.map((branch) => branch.judgmentRef),
  ]);
  return baseBundle.documents
    .filter((entry) => selectedPaths.has(entry.path))
    .map((entry) =>
      envelope(
        { ...entry.document, run_id: G12_RUN_ID },
        entry.path,
        "main_agent",
        [],
        "2026-07-24T20:01:00Z",
      ),
    );
}

function planUnit(
  baseBundle: {
    readonly documents: readonly {
      readonly path: string;
      readonly document: Record<string, unknown>;
    }[];
  },
  unitId: string,
): Record<string, unknown> {
  const plan = baseBundle.documents.find(
    (entry) => entry.path === "plans/research-plan.r1.json",
  )?.document;
  const waves = Array.isArray(plan?.waves) ? plan.waves : [];
  for (const wave of waves) {
    if (!wave || typeof wave !== "object" || Array.isArray(wave) || !Array.isArray(wave.units)) {
      continue;
    }
    const unit = wave.units.find(
      (candidate: unknown) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).unit_id === unitId,
    );
    if (unit && typeof unit === "object" && !Array.isArray(unit)) {
      return { ...(unit as Record<string, unknown>) };
    }
  }
  throw new Error(`missing synthetic fixture unit ${unitId}`);
}

export function taskEnvelope(
  baseBundle: {
    readonly documents: readonly {
      readonly path: string;
      readonly document: Record<string, unknown>;
    }[];
  },
  branch: FixtureBranch,
  offset: number,
): FormalArtifactEnvelope {
  const unit = planUnit(baseBundle, branch.unitId);
  const path = `tasks/${branch.unitId}.attempt-1.json`;
  const document = {
    schema_version: "startup_opportunity.research_task.v1",
    task_id: `task_${branch.unitId}`,
    run_id: G12_RUN_ID,
    unit_id: branch.unitId,
    mode: "concept_evidence_assessment",
    phase: "assessment",
    wave_id: "assessment_wave_1",
    unit_type: unit.unit_type,
    research_goal: unit.research_goal,
    target_subject_ref: "concept-hypothesis.json",
    scope_frame_ref: "scope-frame.json",
    research_plan_ref: "plans/research-plan.r1.json",
    assessment_plan_ref: "plans/concept-evidence-assessment-plan.r1.json",
    input_refs: unit.input_refs,
    attempt: 1,
    supersedes_task_ref: null,
    agent_role: "lane-researcher",
    allowed_output_path: branch.outputPath,
    required_artifact_schema: "startup_opportunity.concept_evidence_assessment_branch_result.v1",
    required_stances: ["support", "oppose"],
    tool_guidance: ["Only explicit synthetic fixture inputs are in scope."],
    stop_conditions: ["Stop after the mechanical contract chain is complete."],
    completion_message_contract: {
      include_artifact_path: true,
      include_validation_status: true,
      include_limitations: true,
      include_unresolved_questions: true,
      formal_artifact_authority: false,
    },
    execution_contract: {
      harness_dispatches_agent: false,
      hidden_llm_calls: false,
      hidden_network_research: false,
    },
    dispatched_at: `2026-07-24T20:0${offset}:00Z`,
  };
  return envelope(
    document,
    path,
    "main_agent",
    [
      "concept-hypothesis.json",
      "scope-frame.json",
      "plans/research-plan.r1.json",
      "plans/concept-evidence-assessment-plan.r1.json",
    ],
    document.dispatched_at,
  );
}

function lineage(branch: FixtureBranch) {
  return {
    task_ref: `tasks/${branch.unitId}.attempt-1.json`,
    attempt: 1,
    concept_hypothesis_ref: "concept-hypothesis.json",
    scope_frame_ref: "scope-frame.json",
    research_plan_ref: "plans/research-plan.r1.json",
    assessment_plan_ref: "plans/concept-evidence-assessment-plan.r1.json",
  };
}

export function branchResearchEnvelopes(
  branch: FixtureBranch,
  records: readonly [EvidenceStoreRecord, EvidenceStoreRecord],
  offset: number,
): readonly FormalArtifactEnvelope[] {
  const taskRef = `tasks/${branch.unitId}.attempt-1.json`;
  const evidencePaths = records.map((record) => `evidence/records/${record.evidence_id}.json`);
  const evidenceDocuments = records.map((record, index) => {
    const publicOrigin = record.source.kind === "public_url";
    return {
      schema_version: "startup_opportunity.evidence.v1",
      evidence_id: record.evidence_id,
      run_id: G12_RUN_ID,
      unit_id: branch.unitId,
      lineage: lineage(branch),
      source_type: "synthetic_contract_fixture",
      evidence_origin: publicOrigin ? "public_source" : "user_provided_existing_material",
      source_name: `Synthetic contract fixture ${branch.unitId} ${index + 1}`,
      published_at: null,
      retrieved_at: record.recorded_at,
      research_goal: record.research_goal,
      research_phase_role: index === 0 ? "candidate_evaluation" : "adversarial_challenger",
      geo: "synthetic-not-a-market",
      language: "en",
      sample_size: null,
      mechanical_binding: {
        substrate_record_ref: `evidence/manifest.jsonl#${record.evidence_id}`,
        source: record.source,
        source_hash: record.source_hash,
        content_hash: record.content_hash,
        raw_content_ref: record.raw_content_ref,
        operation_key: record.operation_key,
        recorded_at: record.recorded_at,
      },
      provenance: {
        acquisition_method: publicOrigin ? "public_web_retrieval" : "user_provided_import",
        source_owner: "Synthetic fixture owner",
        original_creator: "Synthetic fixture author",
        method_notes: "Local synthetic bytes supplied solely for deterministic contract testing.",
        user_provided_at: publicOrigin ? null : record.recorded_at,
      },
      source_assessment: {
        independence: "unknown",
        canonical_source_group: `source_group_${branch.unitId}_${index + 1}`,
        shared_dataset_group: null,
        syndication_group: null,
        biases: ["sampling_method_unknown"],
        bias_notes: "Synthetic fixture; no population inference is permitted.",
      },
      evidence_tier: "model_inference_only",
      evidence_lifecycle_status: "unverified",
      evidence_role: index === 0 ? "support" : "oppose",
      representativeness: "Not representative; synthetic contract fixture only.",
      valid_as_of: "2026-07-24",
      freshness_policy: publicOrigin
        ? "immutable_historical_record"
        : "user_material_valid_as_provided",
      limitations: ["Synthetic mechanical fixture; not real market Evidence."],
    };
  });
  const supportClaimPath = `claims/${branch.unitId}-support.json`;
  const opposeClaimPath = `claims/${branch.unitId}-oppose.json`;
  const supportClaimId = `claim_${branch.unitId}_support`;
  const opposeClaimId = `claim_${branch.unitId}_oppose`;
  const claims = [
    {
      schema_version: "startup_opportunity.claim.v1",
      claim_id: supportClaimId,
      run_id: G12_RUN_ID,
      unit_id: branch.unitId,
      lineage: lineage(branch),
      claim_type: branch.supportClaimType,
      statement: "Synthetic fixture support statement; it makes no market assertion.",
      stance: "support",
      evidence_refs: [evidencePaths[0]],
      confidence_band: "low",
      sample_bias: "Synthetic fixture with no sample.",
      limitations: ["Mechanical traceability only."],
    },
    {
      schema_version: "startup_opportunity.claim.v1",
      claim_id: opposeClaimId,
      run_id: G12_RUN_ID,
      unit_id: branch.unitId,
      lineage: lineage(branch),
      claim_type: branch.opposeClaimType,
      statement: "Synthetic fixture opposing statement; it makes no market assertion.",
      stance: "oppose",
      evidence_refs: [evidencePaths[1]],
      confidence_band: "low",
      sample_bias: "Synthetic fixture with no sample.",
      limitations: ["Mechanical traceability only."],
    },
  ] as const;
  const findingPath = `findings/${branch.unitId}.json`;
  const finding = {
    schema_version: "startup_opportunity.finding.v1",
    finding_id: `finding_${branch.unitId}`,
    run_id: G12_RUN_ID,
    unit_id: branch.unitId,
    lineage: lineage(branch),
    summary: "Synthetic fixture demonstrates opposing typed Claim links only.",
    claim_refs: [supportClaimPath],
    opposing_claim_refs: [opposeClaimPath],
    confidence_band: "low",
    limitations: ["No research conclusion may be drawn."],
  };
  const insightPath = `insights/${branch.unitId}.json`;
  const insight = {
    schema_version: "startup_opportunity.insight.v1",
    insight_id: `insight_${branch.unitId}`,
    run_id: G12_RUN_ID,
    unit_id: branch.unitId,
    lineage: lineage(branch),
    source_units: [branch.unitId],
    summary: "Synthetic fixture confirms deterministic traceability mechanics only.",
    finding_refs: [findingPath],
    decision_relevance:
      branch.unitId === "unit_demand"
        ? "demand_validation"
        : branch.unitId === "unit_alternatives"
          ? "baseline_comparison"
          : branch.unitId === "unit_acquisition"
            ? "acquisition_viability"
            : "counter_evidence",
    confidence_band: "low",
    limitations: ["Not decision Evidence."],
  };
  const sourceManifestPath = `evidence/source-manifests/${branch.unitId}.json`;
  const sourceManifest = {
    schema_version: "startup_opportunity.source_manifest.v1",
    manifest_id: `sources_${branch.unitId}`,
    run_id: G12_RUN_ID,
    unit_id: branch.unitId,
    lineage: lineage(branch),
    accepted_evidence_refs: evidencePaths,
    rejected_source_records: [],
    unavailable_source_records: [],
    canonical_source_groups: records.map((_, index) => ({
      group_id: `source_group_${branch.unitId}_${index + 1}`,
      evidence_refs: [evidencePaths[index]],
    })),
    shared_dataset_groups: [],
    duplicate_or_syndication_groups: [],
    source_type_coverage: ["synthetic_contract_fixture"],
    geo_language_coverage: ["synthetic-not-a-market/en"],
    time_coverage: ["2026-07-24 synthetic fixture timestamp"],
    stance_coverage: ["support", "oppose"],
    generation_source_groups: [],
    evaluation_source_groups: [`source_group_${branch.unitId}_1`],
    challenger_source_groups: [`source_group_${branch.unitId}_2`],
    generation_evaluation_overlap: "none",
    known_source_blind_spots: ["All inputs are synthetic."],
    freshness_summary: { active: 0, stale: 0, unverified: 2, superseded: 0 },
    limitations: ["Synthetic Source Manifest; no external validation occurred."],
  };
  const branchResult = {
    schema_version: "startup_opportunity.concept_evidence_assessment_branch_result.v1",
    branch_id: `branch_${branch.unitId}`,
    run_id: G12_RUN_ID,
    unit_id: branch.unitId,
    concept_hypothesis_ref: "concept-hypothesis.json",
    assessment_plan_ref: "plans/concept-evidence-assessment-plan.r1.json",
    dimension_id: branch.dimensionId,
    branch_status: "insufficient_evidence",
    research_questions: ["Can the synthetic contract chain be validated mechanically?"],
    evidence_refs: records.map((record) => record.evidence_id),
    supporting_claim_refs: [supportClaimId],
    opposing_claim_refs: [opposeClaimId],
    judgment_assessment_refs: [branch.judgmentRef],
    finding_refs: [findingPath],
    dimension_decision: "insufficient_evidence",
    decision_sufficiency: "insufficient",
    insufficiency_reasons: ["no_signal"],
    evidence_quality: "low",
    uncertainty: "high",
    what_would_change_decision: ["Real, independently sourced Evidence outside this fixture."],
    open_questions: ["No market question is answered by this fixture."],
    limitations: ["Mechanical success does not establish the thesis or Evidence sufficiency."],
  };
  const createdAt = `2026-07-24T20:${String(10 + offset).padStart(2, "0")}:00Z`;
  return [
    ...evidenceDocuments.map((document, index) =>
      envelope(
        document,
        evidencePaths[index] ?? "",
        "lane_researcher",
        [taskRef, `evidence/manifest.jsonl#${records[index]?.evidence_id ?? ""}`],
        createdAt,
      ),
    ),
    envelope(
      claims[0],
      supportClaimPath,
      "lane_researcher",
      [taskRef, evidencePaths[0] ?? ""],
      createdAt,
    ),
    envelope(
      claims[1],
      opposeClaimPath,
      "lane_researcher",
      [taskRef, evidencePaths[1] ?? ""],
      createdAt,
    ),
    envelope(
      finding,
      findingPath,
      "lane_researcher",
      [taskRef, supportClaimPath, opposeClaimPath],
      createdAt,
    ),
    envelope(insight, insightPath, "lane_researcher", [taskRef, findingPath], createdAt),
    envelope(
      sourceManifest,
      sourceManifestPath,
      "lane_researcher",
      [taskRef, ...evidencePaths],
      createdAt,
    ),
    envelope(
      branchResult,
      branch.outputPath,
      "lane_researcher",
      [taskRef, sourceManifestPath, insightPath],
      createdAt,
    ),
  ];
}

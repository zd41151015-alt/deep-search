import type { EvidenceStoreRecord, FormalArtifactEnvelope } from "../../../harness/src/index.js";
import { canonicalContentHash } from "../../../harness/src/index.js";

export const G12_RUN_ID = "run_g1_2_synthetic_001";
export const G12_BASE_TIME = "2026-07-24T20:00:00Z";

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

export function executionPlanEnvelope(
  baseBundle: {
    readonly documents: readonly {
      readonly path: string;
      readonly document: Record<string, unknown>;
    }[];
  },
  branches: readonly FixtureBranch[] = G12_BRANCHES,
): FormalArtifactEnvelope {
  const sourcePlan = baseBundle.documents.find(
    (entry) => entry.path === "plans/research-plan.r1.json",
  )?.document;
  if (sourcePlan === undefined) throw new Error("missing synthetic Research Plan");
  const researchPlan = { ...sourcePlan, run_id: G12_RUN_ID };
  const tasks = branches.map((branch, index) => taskEnvelope(baseBundle, branch, index + 2));
  const assignmentFor = (task: FormalArtifactEnvelope): Record<string, unknown> => {
    const requirements = task.document.commercial_research_requirements as Record<string, unknown>;
    return structuredClone(requirements.incumbent_response_assignment as Record<string, unknown>);
  };
  const executionPlanRef = "plans/research-execution.r1.json";
  const stageId = "commercial_research";
  const executionPlan = {
    schema_version: "startup_opportunity.research_execution_plan.discovery.current",
    execution_plan_id: "execution_plan_g1_2_synthetic",
    run_id: G12_RUN_ID,
    mode: "concept_evidence_assessment",
    revision: 1,
    parent_execution_plan_ref: null,
    research_plan_ref: "plans/research-plan.r1.json",
    research_plan_hash: canonicalContentHash(researchPlan),
    created_at: "2026-07-24T20:01:30Z",
    research_depth: "standard",
    total_time_budget_minutes: 120,
    resource_allocation: {
      customer_commercial_percent: 65,
      market_structure_percent: 17,
      academic_percent: 18,
    },
    stages: [
      {
        stage_id: stageId,
        stage_kind: "assessment_commercial",
        depends_on: [],
        gate_before: null,
        gate_after: "terminal_allowed",
        lanes: tasks.map((task, index) => ({
          unit_id: task.document.unit_id,
          lane_role: index === tasks.length - 1 ? "risk" : "evaluation",
          candidate_scope: { kind: "none", candidate_refs: [] },
          incumbent_response_assignment: assignmentFor(task),
          reporting_dimensions: [branches[index]?.dimensionId],
          submission_path: task.document.allowed_output_path,
          submission_schema: task.document.required_artifact_schema,
          time_budget_minutes: 10,
          max_sources: 5,
          straggler_policy: {
            on_timeout: "publish_partial",
            grace_minutes: 0,
            blocks_stage: false,
          },
          dispatch_group: "commercial_research",
        })),
      },
    ],
    limitations: ["SYNTHETIC execution plan; no research was performed."],
  };
  return envelope(
    executionPlan,
    executionPlanRef,
    "main_agent",
    ["plans/research-plan.r1.json"],
    "2026-07-24T20:01:30Z",
  );
}

export function initialFixtureEnvelopes(
  baseBundle: {
    readonly documents: readonly {
      readonly path: string;
      readonly document: Record<string, unknown>;
    }[];
  },
  branches: readonly FixtureBranch[] = G12_BRANCHES,
): readonly FormalArtifactEnvelope[] {
  const selectedPaths = new Set([
    "intake.json",
    "decision-context.json",
    "scope-frame.json",
    "concept-hypothesis.json",
    "plans/research-plan.r1.json",
    "plans/concept-evidence-assessment-plan.r1.json",
    ...G12_BRANCHES.map((branch) => branch.judgmentRef),
  ]);
  const initial = baseBundle.documents
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
  return [...initial, executionPlanEnvelope(baseBundle, branches)];
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
    schema_version: "startup_opportunity.research_task.assessment.current",
    task_id: `task_${branch.unitId}`,
    run_id: G12_RUN_ID,
    unit_id: branch.unitId,
    mode: "concept_evidence_assessment",
    phase: "assessment",
    wave_id: "assessment_wave_1",
    unit_type: unit.unit_type,
    research_goal: unit.research_goal,
    commercial_research_requirements: {
      research_stage: "solution_specific_evaluation",
      resource_allocation: {
        customer_commercial_percent: 65,
        market_structure_percent: 17,
        academic_percent: 18,
      },
      planned_queries: [
        {
          query: `synthetic ${branch.unitId} buyer, pricing, and alternative behavior`,
          commercial_dimensions: ["buyer", "purchase", "pricing", "alternatives"],
        },
      ],
      quantitative_competitive_scope: quantitativeCompetitiveScope("targeted_deep_dive"),
      incumbent_response_assignment: {
        analysis_depth: "not_assigned",
        assignment_role: "none",
        subject_refs: [],
        rationale:
          "This synthetic branch does not own the separately planned incumbent response deep dive.",
      },
      required_commercial_dimensions: [
        "recent_user_language",
        "purchase_signal",
        "alternatives_pricing_usage",
        "distribution_channel",
        "independent_counterevidence",
      ],
      commercial_audit_output_path: `artifacts/research-audits/${branch.unitId}.json`,
    },
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

export function dispatchEnvelope(
  baseBundle: {
    readonly documents: readonly {
      readonly path: string;
      readonly document: Record<string, unknown>;
    }[];
  },
  branches: readonly FixtureBranch[] = G12_BRANCHES,
): FormalArtifactEnvelope {
  const tasks = branches.map((branch, index) => taskEnvelope(baseBundle, branch, index + 2));
  const assignmentFor = (task: FormalArtifactEnvelope): Record<string, unknown> => {
    const requirements = task.document.commercial_research_requirements as Record<string, unknown>;
    return structuredClone(requirements.incumbent_response_assignment as Record<string, unknown>);
  };
  const executionPlanRef = "plans/research-execution.r1.json";
  const dispatchPath = "tasks/dispatch/commercial-research.r1.json";
  const document = {
    schema_version: "startup_opportunity.dispatch_batch.discovery.current",
    batch_id: `dispatch_commercial_research_${branches.map((branch) => branch.unitId).join("_")}`,
    revision: 1,
    run_id: G12_RUN_ID,
    mode: "concept_evidence_assessment",
    execution_plan_ref: executionPlanRef,
    research_plan_ref: "plans/research-plan.r1.json",
    stage_id: "commercial_research",
    dispatch_group: "commercial_research",
    task_ready_at: "2026-07-24T20:01:40Z",
    dispatch_requested_at: "2026-07-24T20:01:40Z",
    dispatch_mode: "parallel_immediate",
    tasks: tasks.map((task, index) => ({
      task_id: task.document.task_id,
      unit_id: task.document.unit_id,
      lane_role: index === tasks.length - 1 ? "risk" : "evaluation",
      incumbent_response_assignment: assignmentFor(task),
      research_goal: task.document.research_goal,
      input_refs: task.document.input_refs,
      allowed_output_path: task.document.allowed_output_path,
      required_artifact_schema: task.document.required_artifact_schema,
      time_budget_minutes: 10,
      max_sources: 5,
      straggler_policy: {
        on_timeout: "publish_partial",
        grace_minutes: 0,
        blocks_stage: false,
      },
    })),
    agent_dispatch_performed: false,
    launch_registration_required: true,
    limitations: ["SYNTHETIC dispatch descriptor; no agent dispatch was performed."],
  };
  return envelope(
    document,
    dispatchPath,
    "harness",
    [executionPlanRef, "plans/research-plan.r1.json"],
    "2026-07-24T20:01:40Z",
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
      schema_version: "startup_opportunity.evidence.assessment.current",
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
      schema_version: "startup_opportunity.claim.assessment.current",
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
      schema_version: "startup_opportunity.claim.assessment.current",
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
    schema_version: "startup_opportunity.finding.assessment.current",
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
    schema_version: "startup_opportunity.insight.assessment.current",
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
    schema_version: "startup_opportunity.source_manifest.assessment.current",
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
    coverage_disposition: "covered",
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

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalContentHash } from "../harness/src/artifact-store/canonical.js";
import { compileCommercialResearchDelivery } from "../harness/src/compiler/commercial-research-compiler.js";
import {
  INCUMBENT_RESPONSE_STRATEGIC_CONTEXT,
  INCUMBENT_RESPONSE_UNKNOWN_RATIONALE,
} from "../harness/src/incumbent-response-contract.js";
import {
  artifactRefsForDocument,
  buildArtifactScaffold,
  classifyReference,
  createArtifactValidator,
  validateCommercialResearchContract,
} from "../harness/src/index.js";
import {
  projectCommercialAuditTables,
  renderCompetitiveSubstituteMatrix,
  renderIncumbentResponseRiskTable,
  renderQuantitativeSignalTable,
  renderResearchCoverageGaps,
} from "../harness/src/reporting/commercial-report-tables.js";
import { localizedTerminalUserViewIssues } from "../harness/src/reporting/terminal-reporting.js";
import {
  type CommercialResearchPolicy,
  derivePortfolioRecommendationCeiling,
  deriveSourceDistribution,
  isTraceableDirectSource,
} from "../harness/src/validators/commercial-research-validator.js";
import { isBlockingIssue } from "../harness/src/validators/schema-bundle.js";
import {
  commercialReportProjection,
  unavailableQuantitativeCompetitiveCoverage,
} from "./fixtures/quantitative-competitive-fixture.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function commercialAudit(): Record<string, unknown> {
  const uncovered = [
    "recent_user_language",
    "purchase_signal",
    "alternatives_pricing_usage",
    "distribution_channel",
    "independent_counterevidence",
  ];
  return {
    schema_version: "startup_opportunity.commercial_research_audit.current",
    audit_id: "commercial_audit_synthetic",
    run_id: "current-only-commercial-synthetic",
    unit_id: "unit_commercial_synthetic",
    execution_plan_ref: "plans/research-execution.r1.json",
    dispatch_task_ref: "tasks/dispatch/commercial-synthetic.r1.json#task_commercial_synthetic",
    task_ref: "tasks/discovery/unit_commercial_synthetic.attempt-1.json",
    covered_direction_ids: ["direction_synthetic"],
    research_stage: "solution_neutral_scan",
    audited_at: "2026-08-04T12:10:00Z",
    planned_resource_allocation: {
      customer_commercial_percent: 65,
      market_structure_percent: 17,
      academic_percent: 18,
    },
    adopted_source_distribution: {
      total_adopted_sources: 0,
      customer_commercial_count: 0,
      market_structure_count: 0,
      academic_count: 0,
      customer_commercial_percent: 0,
      market_structure_percent: 0,
      academic_percent: 0,
      guidance_deviation_observed: false,
    },
    research_objectives: ["Exercise current commercial research validation semantics."],
    primary_routes: ["Synthetic fixture route; no external research was performed."],
    findings: [],
    claims: [],
    judgments: [],
    search_log: [
      {
        query_id: "query_commercial_synthetic",
        query: "synthetic user purchase behavior",
        searched_at: "2026-08-04T12:00:00Z",
        commercial_dimensions: ["user_language", "purchase"],
        candidate_results: [
          {
            url: "https://example.invalid/commercial-synthetic",
            title: "Synthetic rejected result",
            retrieved_at: "2026-08-04T12:01:00Z",
            published_at: "2026-08-01T00:00:00Z",
            observed_at: null,
            data_period_end: null,
            derived_valid_as_of: "2026-08-01",
            claim_type: "current_purchase_behavior",
            adopted_evidence_ref: null,
            rejection_reason: "Synthetic result does not contain observed behavior.",
          },
        ],
      },
    ],
    search_closure: {
      closure_id: "search_closure_unit_commercial_synthetic",
      lane_kind: "external_research",
      outcome: "evidence_insufficient",
      query_log_complete: false,
      telemetry_basis: "agent_supplied",
      remaining_gaps: uncovered,
      termination_reason: "Synthetic fixture reached its evidence ceiling.",
    },
    evidence_register: [],
    coverage: Object.fromEntries(
      uncovered.map((key) => [
        key,
        {
          state: "unknown",
          content_covered: false,
          evidence_refs: [],
          data_points: [],
          inference: null,
        },
      ]),
    ),
    uncovered_business_dimensions: uncovered,
    wave1_signals: { demand: false, buyer: false, purchase: false },
    stage_decision: "early_stop_insufficient_evidence",
    ranking_eligibility: "unranked_hypothesis",
    ...unavailableQuantitativeCompetitiveCoverage(["direction_synthetic"], "2026-08-04T12:10:00Z"),
    incumbent_response_assignment: {
      analysis_depth: "not_assigned",
      assignment_role: "none",
      subject_refs: [],
      rationale: "Synthetic baseline does not assign incumbent response research.",
    },
    incumbent_response_assessments: [],
    incumbent_response_coverage: [],
    recommendation_ceiling: {
      maximum_decision_tier: "investigate_further",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
      ],
    },
    subject_recommendation_ceilings: [
      {
        subject_id: "direction_synthetic",
        maximum_decision_tier: "investigate_further",
        reason_codes: [
          "missing_independent_competitor_adoption_data",
          "missing_purchase_or_payment_signal",
          "missing_retention_evidence",
        ],
      },
    ],
    compiler_warnings: [],
    limitations: ["SYNTHETIC contract fixture; no research was performed."],
  };
}

async function commercialPolicy(): Promise<CommercialResearchPolicy> {
  const policy = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "harness/policies/research-publication.current.json"),
      "utf8",
    ),
  ) as { commercial_research_contract: CommercialResearchPolicy };
  return policy.commercial_research_contract;
}

function commercialDelivery(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.commercial_research_delivery.current",
    run_id: "current-only-commercial-synthetic",
    unit_id: "unit_compiler_synthetic",
    audited_at: "2026-08-04T12:10:00Z",
    research_objectives: ["Exercise compiler semantics."],
    primary_routes: ["Synthetic fixture route."],
    search_results: [],
    evidence_sources: [],
    findings: [],
    claims: [],
    judgments: [],
    quantitative_observations: [],
    competitive_observations: [],
    incumbent_response_assessments: [],
    unresolved_gaps: [],
    limitations: ["Synthetic compiler fixture only."],
    stop_reason: "The assigned synthetic route was complete.",
    telemetry_basis: "unavailable",
    query_log_complete: false,
    ...overrides,
  };
}

function commercialCompilerTask(
  taskPath: string,
  subjectRef = "direction_synthetic",
  requiredMetricFamilies: readonly string[] = [],
  requiredCompetitorTypes: readonly string[] = [],
) {
  const unitId = taskPath.match(/\/(unit_[A-Za-z0-9_-]+)\.attempt-/u)?.[1];
  assert.ok(unitId);
  return {
    artifact_type: "startup_opportunity.research_task.discovery_candidate.current",
    artifact_path: taskPath,
    document: {
      schema_version: "startup_opportunity.research_task.discovery_candidate.current",
      unit_id: unitId,
      task_id: `task_${unitId}`,
      source_phase: "candidate_generation",
      target_subject_ref: subjectRef,
      commercial_research_requirements: {
        research_stage: "solution_neutral_scan",
        quantitative_competitive_scope: {
          required_metric_families: requiredMetricFamilies,
          required_competitor_types: requiredCompetitorTypes,
        },
        incumbent_response_assignment: {
          analysis_depth: "not_assigned",
          assignment_role: "none",
          subject_refs: [],
          rationale: "Synthetic compiler task does not assign incumbent response research.",
        },
      },
    },
  };
}

function incumbentResponseTask(
  taskPath: string,
  subjectRefs: readonly string[],
  analysisDepth: "lightweight_scan" | "targeted_deep_dive",
): {
  readonly artifact_type: string;
  readonly artifact_path: string;
  readonly document: Record<string, unknown>;
} {
  const targeted = analysisDepth === "targeted_deep_dive";
  return {
    artifact_type: targeted
      ? "startup_opportunity.research_task.discovery_evaluation.current"
      : "startup_opportunity.research_task.discovery_candidate.current",
    artifact_path: taskPath,
    document: {
      schema_version: targeted
        ? "startup_opportunity.research_task.discovery_evaluation.current"
        : "startup_opportunity.research_task.discovery_candidate.current",
      unit_id: targeted ? "unit_response_targeted" : "unit_response_lightweight",
      task_id: targeted ? "task_response_targeted" : "task_response_lightweight",
      research_plan_ref: "plans/research-plan.r1.json",
      source_phase: targeted ? "enrichment_evaluation" : "candidate_evaluation",
      ...(targeted
        ? { target_opportunity_refs: [...subjectRefs] }
        : { target_candidate_refs: [...subjectRefs] }),
      commercial_research_requirements: {
        research_stage: targeted ? "solution_specific_evaluation" : "solution_neutral_scan",
        resource_allocation: {
          customer_commercial_percent: 65,
          market_structure_percent: 17,
          academic_percent: 18,
        },
        planned_queries: [
          {
            query: "Synthetic bounded incumbent response review.",
            commercial_dimensions: [targeted ? "solution_pricing" : "market_structure"],
          },
        ],
        quantitative_competitive_scope: {
          scan_mode: targeted ? "targeted_deep_dive" : "broad_scan",
          required_metric_families: [],
          required_competitor_types: [],
          api_is_optional: true,
          provider_allowlist_enforced: false,
          acquisition_execution_owner: "research_agent_or_caller",
          harness_hidden_network_calls: false,
          prohibited_access_methods: [
            "bypass_access_control",
            "circumvent_captcha",
            "circumvent_login",
            "circumvent_paywall",
            "store_credentials",
          ],
        },
        incumbent_response_assignment: {
          analysis_depth: analysisDepth,
          assignment_role: "owner",
          subject_refs: [...subjectRefs],
          rationale: targeted
            ? "A retained opportunity receives a bounded targeted response deep dive."
            : "Formed candidates receive a bounded lightweight response scan.",
        },
        required_commercial_dimensions: [
          "recent_user_language",
          "purchase_signal",
          "alternatives_pricing_usage",
          "distribution_channel",
          "independent_counterevidence",
        ],
        commercial_audit_output_path: targeted
          ? "artifacts/research-audits/response-targeted.json"
          : "artifacts/research-audits/response-lightweight.json",
      },
    },
  };
}

function incumbentResponseLineage(
  task: Readonly<{
    readonly document: Record<string, unknown>;
  }>,
): readonly {
  readonly artifact_type: string;
  readonly artifact_path: string;
  readonly document: Record<string, unknown>;
}[] {
  const requirements = task.document.commercial_research_requirements as Record<string, unknown>;
  const assignment = requirements.incumbent_response_assignment as Record<string, unknown>;
  const targeted = assignment.analysis_depth === "targeted_deep_dive";
  const sourcePhase = String(task.document.source_phase);
  const executionPath = "plans/research-execution.r1.json";
  const unitId = String(task.document.unit_id);
  const dispatchPath = `tasks/dispatch/${unitId}.r1.json`;
  const stageId = `stage_${unitId}`;
  const stageKind = targeted
    ? "retained_candidate_deep_review"
    : sourcePhase === "candidate_generation"
      ? "candidate_generation"
      : "candidate_evaluation";
  return [
    {
      artifact_type: "startup_opportunity.research_execution_plan.discovery.current",
      artifact_path: executionPath,
      document: {
        schema_version: "startup_opportunity.research_execution_plan.discovery.current",
        stages: [
          {
            stage_id: stageId,
            stage_kind: stageKind,
            lanes: [
              {
                unit_id: task.document.unit_id,
                incumbent_response_assignment: structuredClone(assignment),
              },
            ],
          },
        ],
      },
    },
    {
      artifact_type: "startup_opportunity.dispatch_batch.discovery.current",
      artifact_path: dispatchPath,
      document: {
        schema_version: "startup_opportunity.dispatch_batch.discovery.current",
        execution_plan_ref: executionPath,
        stage_id: stageId,
        tasks: [
          {
            task_id: task.document.task_id,
            unit_id: task.document.unit_id,
            incumbent_response_assignment: structuredClone(assignment),
          },
        ],
      },
    },
  ];
}

interface CommercialDocumentEntry {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
}

function commercialAuditLineage(
  document: Record<string, unknown>,
): readonly CommercialDocumentEntry[] {
  const executionPlanRef = String(document.execution_plan_ref);
  const [dispatchPath, taskId] = String(document.dispatch_task_ref).split("#", 2);
  const taskRef = String(document.task_ref);
  const unitId = String(document.unit_id);
  const assignment = structuredClone(
    document.incumbent_response_assignment as Record<string, unknown>,
  );
  const stageId = `stage_${unitId}`;
  assert.ok(dispatchPath);
  assert.ok(taskId);
  return [
    {
      path: executionPlanRef,
      schemaVersion: "test.execution-plan-lineage",
      document: {
        stages: [
          {
            stage_id: stageId,
            lanes: [{ unit_id: unitId, incumbent_response_assignment: assignment }],
          },
        ],
      },
    },
    {
      path: dispatchPath,
      schemaVersion: "startup_opportunity.dispatch_batch.discovery.current",
      document: {
        execution_plan_ref: executionPlanRef,
        stage_id: stageId,
        tasks: [{ task_id: taskId, unit_id: unitId, incumbent_response_assignment: assignment }],
      },
    },
    {
      path: taskRef,
      schemaVersion: "test.research-task-lineage",
      document: {
        unit_id: unitId,
        task_id: taskId,
        commercial_research_requirements: { incumbent_response_assignment: assignment },
      },
    },
  ];
}

function commercialAuditDocuments(
  document: Record<string, unknown>,
  auditPath = "artifacts/research-audits/commercial-synthetic.json",
): readonly CommercialDocumentEntry[] {
  return [
    ...commercialAuditLineage(document),
    {
      path: auditPath,
      schemaVersion: String(document.schema_version),
      document,
    },
  ];
}

function responseSubject(
  artifactPath: string,
  subjectId: string,
  kind: "candidate" | "opportunity" = "candidate",
) {
  return {
    artifact_type:
      kind === "candidate"
        ? "startup_opportunity.discovery_candidate.v1"
        : "startup_opportunity.opportunity_thesis.v1",
    artifact_path: artifactPath,
    document: {
      schema_version:
        kind === "candidate"
          ? "startup_opportunity.discovery_candidate.v1"
          : "startup_opportunity.opportunity_thesis.v1",
      [kind === "candidate" ? "candidate_id" : "opportunity_id"]: subjectId,
    },
  };
}

function incumbentResponseSemantic(input: {
  readonly subjectId: string;
  readonly state?: "assessed" | "unknown" | "not_applicable";
  readonly supportingRefs?: readonly string[];
  readonly opposingRefs?: readonly string[];
  readonly backgroundRefs?: readonly string[];
}): Record<string, unknown> {
  const state = input.state ?? "assessed";
  if (state === "unknown") {
    return {
      subject_id: input.subjectId,
      analysis_state: "unknown",
      uncertainty: "Responder identity, intent, timing, and thesis coverage are unresolved.",
      unknowns: ["Potential responder identity and response horizon."],
      data_gaps: [
        "The submitted responder Evidence is insufficient to complete the bounded assessment.",
      ],
      ...(input.supportingRefs === undefined
        ? {}
        : { supporting_evidence_refs: [...input.supportingRefs] }),
      ...(input.opposingRefs === undefined
        ? {}
        : { opposing_evidence_refs: [...input.opposingRefs] }),
      ...(input.backgroundRefs === undefined
        ? {}
        : { background_evidence_refs: [...input.backgroundRefs] }),
    };
  }
  const notApplicable = state === "not_applicable";
  if (notApplicable) {
    return {
      subject_id: input.subjectId,
      analysis_state: "not_applicable",
      rationale:
        "No actor controls a relevant response point for this subject under the bounded scope.",
      background_evidence_refs: [...(input.backgroundRefs ?? [])],
    };
  }
  const rationale =
    "The responder can implement the feature cheaply, but has weak incentive and cannot reproduce the complete workflow.";
  const graded = (level: string) => ({ level, rationale });
  return {
    subject_id: input.subjectId,
    analysis_state: state,
    responder_identity: "Synthetic Suite Leader",
    responder_category: "suite incumbent",
    control_point: "bundled distribution and an adjacent workflow",
    response_modes: ["copy", "bundle", "native_integration"],
    capability_adjacency: graded("high"),
    response_cost: {
      implementation: graded("low"),
      operational: graded("medium"),
      compliance: graded("medium"),
      data: graded("high"),
      distribution: graded("low"),
    },
    incentive: {
      level: "low",
      drivers: ["Protect suite engagement."],
      disincentives: ["The narrow segment does not justify operational complexity."],
      cannibalization: "Bundling may cannibalize a higher-margin adjacent product.",
      rationale,
    },
    plausible_response_horizon: {
      band: "medium_term",
      rationale,
    },
    distribution_leverage: {
      level: "high",
      control_points: ["suite default placement"],
      rationale,
    },
    thesis_coverage: {
      scope: "single_feature",
      covered_elements: ["basic reminder generation"],
      uncovered_elements: ["vertical workflow", "service delivery", "trusted domain context"],
      rationale,
    },
    residual_differentiation: {
      overall_strength: "high",
      dimensions: [
        {
          kind: "vertical_workflow",
          strength: "high",
          rationale: "The full workflow requires specialized delivery and trusted context.",
        },
      ],
      rationale,
    },
    supporting_evidence_refs: [...(input.supportingRefs ?? [])],
    opposing_evidence_refs: [...(input.opposingRefs ?? [])],
    background_evidence_refs: [...(input.backgroundRefs ?? [])],
    inference_boundary: "Ability does not establish incentive, timing, or full-thesis coverage.",
    confidence: "medium",
    uncertainty: "No internal roadmap or commitment is known.",
    unknowns: ["Actual prioritization and launch timing."],
    data_gaps: ["No responder roadmap or full-workflow operating-cost disclosure."],
  };
}

function responseEvidenceSources(): readonly Record<string, unknown>[] {
  const common = {
    retrieved_at: "2026-08-04T12:01:00Z",
    observed_at: null,
    data_period_end: null,
    coverage_keys: [],
    disposition: "adopted",
    exclusion_reason: null,
  };
  return [
    {
      ...common,
      evidence_ref: "evidence/records/response-news.json",
      source_kind: "independent",
      source_profile: {
        type: "news",
        publisher: "Synthetic Newsroom",
        published_at: "2026-08-01T00:00:00Z",
        quotation: "The incumbent is evaluating an adjacent feature.",
        primary_data_traceability_status: "untraced",
        primary_data_ref: null,
      },
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "current_market_change",
      content_summary: "A news item supports capability adjacency but not a launch commitment.",
      published_at: "2026-08-01T00:00:00Z",
    },
    {
      ...common,
      evidence_ref: "evidence/records/response-review.json",
      source_kind: "behavioral",
      source_profile: {
        type: "review",
        platform: "Synthetic Review Forum",
        sample_description: "A bounded set of public product reviews.",
        selection_bias: "Self-selected reviewers.",
        time_range: "2026-07",
      },
      evidence_character: "observed_behavior",
      independence: "unknown",
      claim_type: "current_competitor_usage",
      content_summary: "Reviews oppose the claim that a copied feature covers the whole workflow.",
      published_at: null,
    },
    {
      ...common,
      evidence_ref: "evidence/records/response-company.json",
      source_kind: "vendor",
      source_profile: {
        type: "company_material",
        supported_public_claims: ["product_capability", "company_statement"],
      },
      evidence_character: "vendor_claim",
      independence: "interested_party",
      claim_type: "current_product_capability",
      content_summary: "Company material provides background on current product capability.",
      published_at: "2026-07-30T00:00:00Z",
    },
  ];
}

function commercialCodes(
  document: Record<string, unknown>,
  policy: CommercialResearchPolicy,
): readonly string[] {
  return validateCommercialResearchContract(commercialAuditDocuments(document), policy).map(
    (issue) => issue.code,
  );
}

function quantitativeCommercialFixture(): {
  audit: Record<string, unknown>;
  documents: readonly {
    path: string;
    schemaVersion: string;
    document: Record<string, unknown>;
  }[];
  exactRecords: ReadonlyMap<string, Record<string, unknown>>;
} {
  const audit = commercialAudit();
  const evidenceId = `ev_${"a".repeat(64)}`;
  const evidenceRef = `evidence/records/${evidenceId}.json`;
  const substrateRef = `evidence/manifest.jsonl#${evidenceId}`;
  const rawHash = `sha256:${"b".repeat(64)}`;
  const rawRef = `evidence/raw/sha256-${"b".repeat(64)}.bin`;
  const retrievedAt = "2026-08-04T12:01:00Z";
  const search = (audit.search_log as Record<string, unknown>[])[0];
  assert.ok(search);
  search.candidate_results = [
    {
      url: "https://metrics.example.invalid/rank?market=US&q=synthetic",
      title: "Synthetic public metric response",
      retrieved_at: retrievedAt,
      published_at: null,
      observed_at: "2026-08-04T12:00:00Z",
      data_period_end: "2026-08-04",
      derived_valid_as_of: "2026-08-04",
      claim_type: "current_market_change",
      adopted_evidence_ref: evidenceRef,
      rejection_reason: null,
    },
  ];
  audit.evidence_register = [
    {
      evidence_ref: evidenceRef,
      source_kind: "independent",
      source_profile: { type: "other", description: "Synthetic public metric fixture." },
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "current_market_change",
      content_summary: "Synthetic category-rank observation used only for contract validation.",
      retrieved_at: retrievedAt,
      published_at: null,
      observed_at: "2026-08-04T12:00:00Z",
      data_period_end: "2026-08-04",
      derived_valid_as_of: "2026-08-04",
      freshness_status: "current",
      coverage_keys: [],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  audit.adopted_source_distribution = {
    total_adopted_sources: 1,
    customer_commercial_count: 1,
    market_structure_count: 0,
    academic_count: 0,
    customer_commercial_percent: 100,
    market_structure_percent: 0,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  audit.data_acquisitions = [
    {
      acquisition_id: "acquisition_public_metric",
      acquisition_method: "webpage",
      provider: "Arbitrary Regional Metrics Cooperative",
      endpoint_or_query_redacted: "https://metrics.example.invalid/rank?market=US&q=synthetic",
      retrieved_at: retrievedAt,
      evidence_ref: evidenceRef,
      evidence_substrate_ref: substrateRef,
      raw_response_ref: rawRef,
      raw_response_hash: rawHash,
      access_basis: "public",
      credentials_stored: false,
      sensitive_headers_stored: false,
      access_control_bypassed: false,
      limitations: ["Synthetic metric fixture only."],
    },
  ];
  const observation = {
    observation_id: "observation_rank",
    subject_id: "direction_synthetic",
    metric_family: "demand_scale",
    metric_name: "category rank",
    metric_semantics: "rank",
    value: { shape: "point", value: 17, unit: "rank", currency: null },
    metric_definition: "Position within one synthetic category at the stated as-of date.",
    geography: "United States",
    period: {
      period_start: null,
      period_end: null,
      as_of: "2026-08-04",
      label: "2026-08-04 snapshot",
    },
    measurement_type: "proxy",
    estimation_method: "Platform-relative ordering supplied by the source.",
    sample_or_population: "All entries in one synthetic source category.",
    error_uncertainty: "Category membership and ranking method are source-defined.",
    comparability: {
      comparison_group: null,
      status: "limited",
      category: "synthetic category",
      geography_aligned: false,
      period_aligned: false,
      category_aligned: false,
      definition_aligned: false,
      measurement_aligned: false,
      direct_comparison_allowed: false,
      limitations: ["No cross-market direct comparison is allowed."],
    },
    interpretation_boundaries: [
      "not_purchase_count",
      "not_paid_customer_count",
      "not_market_validation",
    ],
    acquisition_id: "acquisition_public_metric",
    evidence_refs: [evidenceRef],
    limitations: ["Rank is a demand proxy, not a commercial outcome."],
  };
  audit.quantitative_observations = [observation];
  const quantitativeCoverage = audit.quantitative_coverage as Record<string, unknown>[];
  const demandCoverage = quantitativeCoverage.find(
    (coverage) => coverage.metric_family === "demand_scale",
  );
  assert.ok(demandCoverage);
  Object.assign(demandCoverage, {
    state: "observed",
    observation_ids: ["observation_rank"],
    query_attempts: [],
    reason: null,
    alternative_metric: null,
    decision_impact: "The proxy may inform follow-up selection but cannot validate demand.",
  });
  const evidenceDocument = {
    schema_version: "startup_opportunity.evidence.assessment.current",
    mechanical_binding: {
      substrate_record_ref: substrateRef,
      content_hash: rawHash,
      raw_content_ref: rawRef,
    },
  };
  return {
    audit,
    documents: [
      ...commercialAuditLineage(audit),
      {
        path: evidenceRef,
        schemaVersion: "startup_opportunity.evidence.assessment.current",
        document: evidenceDocument,
      },
      {
        path: "artifacts/research-audits/commercial-synthetic.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: audit,
      },
    ],
    exactRecords: new Map([
      [
        substrateRef,
        {
          schema_version: "startup_opportunity.evidence_store_record.v2",
          content_hash: rawHash,
          raw_content_ref: rawRef,
          recorded_at: retrievedAt,
        },
      ],
    ]),
  };
}

function quantitativeCommercialCodes(
  fixture: ReturnType<typeof quantitativeCommercialFixture>,
  policy: CommercialResearchPolicy,
): readonly string[] {
  return validateCommercialResearchContract(fixture.documents, policy, fixture.exactRecords).map(
    (issue) => issue.code,
  );
}

test("current ref classifier separates all canonical reference classes", () => {
  const cases = [
    ["plans/research-plan.r1.json", "run_artifact", "plans/research-plan.r1.json", null],
    [
      "plans/research-plan.r1.json#question_one",
      "run_artifact_fragment",
      "plans/research-plan.r1.json",
      "question_one",
    ],
    [
      "plans/research-plan.r1.json#/research_questions/0",
      "json_pointer",
      "plans/research-plan.r1.json",
      "/research_questions/0",
    ],
    [
      "evidence/manifest.jsonl#ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "evidence_exact_record",
      "evidence/manifest.jsonl",
      "ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
    ["events.jsonl#event_one", "run_exact_record", "events.jsonl", "event_one"],
    [
      "harness/policies/adaptation.current.json#/actions/0",
      "repository_policy",
      "harness/policies/adaptation.current.json",
      "/actions/0",
    ],
    [
      "https://example.invalid/source#section-one",
      "external_url",
      "https://example.invalid/source",
      "section-one",
    ],
  ] as const;
  for (const [ref, kind, targetPath, fragment] of cases) {
    assert.deepEqual(classifyReference(ref), { ref, kind, targetPath, fragment });
  }
});

test("commercial semantic Evidence refs participate in explicit Bundle closure", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const audit = commercialAudit();
  const missingRef = "evidence/records/semantic-missing.json";
  const wrongTypeRef = "evidence/records/semantic-wrong-type.json";
  const crossRunRef = "evidence/records/semantic-cross-run.json";
  audit.findings = [
    {
      finding_id: "finding_semantic",
      statement: "Missing ref fixture.",
      evidence_refs: [missingRef],
    },
  ];
  audit.claims = [
    {
      claim_id: "claim_semantic",
      statement: "Wrong type fixture.",
      evidence_refs: [wrongTypeRef],
      requested_confidence: "low",
      confidence: "low",
      confidence_ceiling_reasons: ["positive_support_not_adopted"],
    },
  ];
  audit.judgments = [
    {
      judgment_id: "judgment_semantic",
      statement: "Cross Run fixture.",
      evidence_refs: [crossRunRef],
    },
  ];
  const discovered = artifactRefsForDocument({
    path: "artifacts/research-audits/commercial-synthetic.json",
    document: audit,
  });
  assert.ok(discovered.includes(missingRef));
  assert.ok(discovered.includes(wrongTypeRef));
  assert.ok(discovered.includes(crossRunRef));

  const result = validator.validateDocumentBundle({
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: "artifacts/research-audits/commercial-synthetic.json", document: audit },
      {
        path: wrongTypeRef,
        document: {
          schema_version: "startup_opportunity.research_plan.v1",
          run_id: "current-only-commercial-synthetic",
        },
      },
      {
        path: crossRunRef,
        document: {
          schema_version: "startup_opportunity.evidence.assessment.current",
          run_id: "different-current-run",
        },
      },
    ],
  });
  assert.ok(
    result.referenceErrors.some(
      (issue) => issue.code === "reference.missing" && issue.details.ref === missingRef,
    ),
  );
  assert.ok(
    result.referenceErrors.some(
      (issue) => issue.code === "reference.type_mismatch" && issue.details.ref === wrongTypeRef,
    ),
  );
  assert.ok(
    result.referenceErrors.some(
      (issue) => issue.code === "reference.run_mismatch" && issue.details.ref === crossRunRef,
    ),
  );
});

test("incumbent response work starts after candidate formation and preserves bounded assignments", async () => {
  const policy = await commercialPolicy();
  const generationTaskPath = "tasks/discovery/unit_pre_candidate.attempt-1.json";
  const generationTask = commercialCompilerTask(generationTaskPath);
  const preCandidate = compileCommercialResearchDelivery(
    commercialDelivery({
      unit_id: "unit_pre_candidate",
      incumbent_response_assessments: [
        incumbentResponseSemantic({ subjectId: "direction_synthetic" }),
      ],
    }),
    generationTaskPath,
    [generationTask, ...incumbentResponseLineage(generationTask)],
    policy,
  );
  assert.ok(
    preCandidate.issues.some(
      (issue) => issue.code === "commercial_research.incumbent_response_before_candidate",
    ),
  );
  assert.deepEqual(preCandidate.document.incumbent_response_assessments, []);

  const generationLineage = incumbentResponseLineage(generationTask);
  const completeUnassigned = compileCommercialResearchDelivery(
    commercialDelivery({ unit_id: "unit_pre_candidate" }),
    generationTaskPath,
    [generationTask, ...generationLineage],
    policy,
  );
  assert.deepEqual(completeUnassigned.issues, []);
  assert.equal(completeUnassigned.document.execution_plan_ref, "plans/research-execution.r1.json");
  assert.equal(
    completeUnassigned.document.dispatch_task_ref,
    "tasks/dispatch/unit_pre_candidate.r1.json#task_unit_pre_candidate",
  );

  const noUnassignedLineage = compileCommercialResearchDelivery(
    commercialDelivery({ unit_id: "unit_pre_candidate" }),
    generationTaskPath,
    [generationTask],
    policy,
  );
  assert.ok(
    noUnassignedLineage.issues.some(
      (issue) =>
        issue.code === "commercial_research.incumbent_response_dispatch_resolution_invalid",
    ),
  );
  assert.ok(
    noUnassignedLineage.issues.some(
      (issue) => issue.code === "commercial_research.incumbent_response_plan_resolution_invalid",
    ),
  );
  const missingUnassignedDispatchCodes = validateCommercialResearchContract(
    [
      {
        path: generationTaskPath,
        schemaVersion: generationTask.artifact_type,
        document: generationTask.document,
      },
    ],
    policy,
  ).map((issue) => issue.code);
  assert.ok(
    missingUnassignedDispatchCodes.includes(
      "commercial_research.incumbent_response_dispatch_projection_missing",
    ),
  );

  const unassignedDispatch = generationLineage.find((artifact) =>
    artifact.artifact_type.includes("dispatch_batch"),
  );
  assert.ok(unassignedDispatch);
  const missingUnassignedPlan = compileCommercialResearchDelivery(
    commercialDelivery({ unit_id: "unit_pre_candidate" }),
    generationTaskPath,
    [generationTask, unassignedDispatch],
    policy,
  );
  assert.ok(
    missingUnassignedPlan.issues.some(
      (issue) => issue.code === "commercial_research.incumbent_response_plan_resolution_invalid",
    ),
  );

  const driftedUnassignedLineage = structuredClone(generationLineage);
  const driftedUnassignedDispatch = driftedUnassignedLineage.find((artifact) =>
    artifact.artifact_type.includes("dispatch_batch"),
  );
  assert.ok(driftedUnassignedDispatch);
  const driftedUnassignedDispatchTask = (
    driftedUnassignedDispatch.document.tasks as Record<string, unknown>[]
  )[0];
  assert.ok(driftedUnassignedDispatchTask);
  (
    driftedUnassignedDispatchTask.incumbent_response_assignment as Record<string, unknown>
  ).rationale = "Dispatch drifted from its Plan authority.";
  const dispatchDrift = compileCommercialResearchDelivery(
    commercialDelivery({ unit_id: "unit_pre_candidate" }),
    generationTaskPath,
    [generationTask, ...driftedUnassignedLineage],
    policy,
  );
  assert.ok(
    dispatchDrift.issues.some(
      (issue) => issue.code === "commercial_research.incumbent_response_plan_dispatch_mismatch",
    ),
  );

  const driftedUnassignedTask = structuredClone(generationTask);
  const driftedUnassignedAssignment = (
    driftedUnassignedTask.document.commercial_research_requirements as Record<string, unknown>
  ).incumbent_response_assignment as Record<string, unknown>;
  driftedUnassignedAssignment.rationale = "Task drifted from its Plan authority.";
  const taskDrift = compileCommercialResearchDelivery(
    commercialDelivery({ unit_id: "unit_pre_candidate" }),
    generationTaskPath,
    [driftedUnassignedTask, ...generationLineage],
    policy,
  );
  assert.ok(
    taskDrift.issues.some(
      (issue) => issue.code === "commercial_research.incumbent_response_plan_task_mismatch",
    ),
  );

  const unassignedAuditDrift = structuredClone(completeUnassigned.document);
  (unassignedAuditDrift.incumbent_response_assignment as Record<string, unknown>).rationale =
    "Audit drifted from its Plan authority.";
  const unassignedAuditDriftCodes = validateCommercialResearchContract(
    [
      {
        path: generationTaskPath,
        schemaVersion: generationTask.artifact_type,
        document: generationTask.document,
      },
      ...generationLineage.map((artifact) => ({
        path: artifact.artifact_path,
        schemaVersion: artifact.artifact_type,
        document: artifact.document,
      })),
      {
        path: "artifacts/research-audits/pre-candidate-drift.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: unassignedAuditDrift,
      },
    ],
    policy,
  ).map((issue) => issue.code);
  assert.ok(
    unassignedAuditDriftCodes.includes(
      "commercial_research.incumbent_response_assignment_mismatch",
    ),
  );

  const candidateARef = "artifacts/discovery/candidates/response-a.r1.json";
  const candidateBRef = "artifacts/discovery/candidates/response-b.r1.json";
  const candidateA = responseSubject(candidateARef, "candidate_response_a");
  const candidateB = responseSubject(candidateBRef, "candidate_response_b");
  const lightweightTaskPath = "tasks/discovery/unit_response_lightweight.attempt-1.json";
  const lightweightTask = incumbentResponseTask(
    lightweightTaskPath,
    [candidateARef, candidateBRef],
    "lightweight_scan",
  );
  const lightweightLineage = incumbentResponseLineage(lightweightTask);
  const lightweight = compileCommercialResearchDelivery(
    commercialDelivery({
      unit_id: "unit_response_lightweight",
      incumbent_response_assessments: [
        incumbentResponseSemantic({
          subjectId: "candidate_response_a",
          state: "not_applicable",
        }),
      ],
    }),
    lightweightTaskPath,
    [lightweightTask, ...lightweightLineage, candidateA, candidateB],
    policy,
  );
  assert.deepEqual(lightweight.issues, []);
  const lightweightAssessments = lightweight.document.incumbent_response_assessments as Record<
    string,
    unknown
  >[];
  assert.deepEqual(
    lightweightAssessments.map((assessment) => ({
      depth: assessment.analysis_depth,
      subject: (assessment.semantic as Record<string, unknown>).subject_id,
      state: (assessment.semantic as Record<string, unknown>).analysis_state,
    })),
    [
      {
        depth: "lightweight_scan",
        subject: "candidate_response_a",
        state: "not_applicable",
      },
      { depth: "lightweight_scan", subject: "candidate_response_b", state: "unknown" },
    ],
  );
  assert.equal(new Set(lightweightAssessments.map((entry) => entry.assessment_id)).size, 2);
  const defaultUnknownSemantic = lightweightAssessments.find(
    (assessment) =>
      (assessment.semantic as Record<string, unknown>).subject_id === "candidate_response_b",
  )?.semantic as Record<string, unknown>;
  assert.equal(defaultUnknownSemantic.inference_boundary, INCUMBENT_RESPONSE_UNKNOWN_RATIONALE);
  assert.equal(
    (defaultUnknownSemantic.capability_adjacency as Record<string, unknown>).rationale,
    INCUMBENT_RESPONSE_UNKNOWN_RATIONALE,
  );
  assert.deepEqual(defaultUnknownSemantic.supporting_evidence_refs, []);
  assert.equal(
    JSON.stringify(defaultUnknownSemantic).includes(
      "No responder-specific assessment was delivered",
    ),
    false,
  );
  const lightweightCoverage = lightweight.document.incumbent_response_coverage as Record<
    string,
    unknown
  >[];
  assert.equal(
    lightweightCoverage.find((row) => row.subject_id === "candidate_response_a")?.state,
    "not_applicable",
  );
  assert.equal(
    lightweightCoverage.find((row) => row.subject_id === "candidate_response_b")?.state,
    "unknown",
  );
  const lightweightClosure = lightweight.document.search_closure as Record<string, unknown>;
  assert.equal(lightweightClosure.outcome, "evidence_insufficient");
  assert.ok(
    (lightweightClosure.remaining_gaps as string[]).some((gap) =>
      gap.includes("candidate_response_b"),
    ),
  );
  const responseGapRows = projectCommercialAuditTables([
    { path: "artifacts/research-audits/response-lightweight.json", document: lightweight.document },
  ]).research_coverage_gaps.filter((row) => row.coverage_kind === "incumbent_response");
  assert.deepEqual(
    responseGapRows.map((row) => (row.coverage as Record<string, unknown>).subject_id),
    ["candidate_response_b"],
  );

  const driftedLineage = structuredClone(lightweightLineage);
  const driftedDispatch = driftedLineage.find((artifact) =>
    artifact.artifact_type.includes("dispatch_batch"),
  );
  assert.ok(driftedDispatch);
  const driftedDispatchTask = (driftedDispatch.document.tasks as Record<string, unknown>[])[0];
  assert.ok(driftedDispatchTask);
  driftedDispatchTask.incumbent_response_assignment = {
    analysis_depth: "not_assigned",
    assignment_role: "none",
    subject_refs: [],
    rationale: "Drifted projection.",
  };
  const driftedAssignment = compileCommercialResearchDelivery(
    commercialDelivery({ unit_id: "unit_response_lightweight" }),
    lightweightTaskPath,
    [lightweightTask, ...driftedLineage, candidateA, candidateB],
    policy,
  );
  assert.ok(
    driftedAssignment.issues.some(
      (issue) => issue.code === "commercial_research.incumbent_response_plan_dispatch_mismatch",
    ),
  );
  const missingDispatchCodes = validateCommercialResearchContract(
    [
      {
        path: lightweightTaskPath,
        schemaVersion: lightweightTask.artifact_type,
        document: lightweightTask.document,
      },
      {
        path: candidateARef,
        schemaVersion: candidateA.artifact_type,
        document: candidateA.document,
      },
      {
        path: candidateBRef,
        schemaVersion: candidateB.artifact_type,
        document: candidateB.document,
      },
    ],
    policy,
  ).map((issue) => issue.code);
  assert.ok(
    missingDispatchCodes.includes(
      "commercial_research.incumbent_response_dispatch_projection_missing",
    ),
  );
  const nullAuditLineage = structuredClone(lightweight.document);
  nullAuditLineage.execution_plan_ref = null;
  nullAuditLineage.dispatch_task_ref = null;
  const nullAuditLineageCodes = validateCommercialResearchContract(
    [
      {
        path: lightweightTaskPath,
        schemaVersion: lightweightTask.artifact_type,
        document: lightweightTask.document,
      },
      ...lightweightLineage.map((artifact) => ({
        path: artifact.artifact_path,
        schemaVersion: artifact.artifact_type,
        document: artifact.document,
      })),
      {
        path: "artifacts/research-audits/response-null-lineage.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: nullAuditLineage,
      },
    ],
    policy,
  ).map((issue) => issue.code);
  assert.ok(
    nullAuditLineageCodes.includes("commercial_research.incumbent_response_lineage_incomplete"),
  );

  const notApplicableTask = incumbentResponseTask(
    lightweightTaskPath,
    [candidateARef],
    "lightweight_scan",
  );
  const notApplicable = compileCommercialResearchDelivery(
    commercialDelivery({
      unit_id: "unit_response_lightweight",
      incumbent_response_assessments: [
        incumbentResponseSemantic({
          subjectId: "candidate_response_a",
          state: "not_applicable",
        }),
      ],
    }),
    lightweightTaskPath,
    [notApplicableTask, ...incumbentResponseLineage(notApplicableTask), candidateA],
    policy,
  ).document;
  assert.equal(
    (notApplicable.incumbent_response_coverage as Record<string, unknown>[])[0]?.state,
    "not_applicable",
  );
  assert.ok(
    !(notApplicable.search_closure as Record<string, unknown>).remaining_gaps
      ?.toString()
      .includes("Incumbent response coverage"),
  );
  assert.equal(
    projectCommercialAuditTables([
      { path: "artifacts/research-audits/response-not-applicable.json", document: notApplicable },
    ]).research_coverage_gaps.some((row) => row.coverage_kind === "incumbent_response"),
    false,
  );

  const crossBound = compileCommercialResearchDelivery(
    commercialDelivery({
      unit_id: "unit_response_lightweight",
      incumbent_response_assessments: [
        incumbentResponseSemantic({ subjectId: "candidate_from_another_lane" }),
      ],
    }),
    lightweightTaskPath,
    [lightweightTask, ...lightweightLineage, candidateA, candidateB],
    policy,
  );
  assert.ok(
    crossBound.issues.some(
      (issue) => issue.code === "commercial_research.delivery_subject_out_of_scope",
    ),
  );

  const opportunityRef = "artifacts/discovery/opportunities/response-top.r1.json";
  const opportunity = responseSubject(opportunityRef, "opportunity_response_top", "opportunity");
  const targetedTaskPath = "tasks/discovery/enrichment/unit_response_targeted.attempt-1.json";
  const targetedTask = incumbentResponseTask(
    targetedTaskPath,
    [opportunityRef],
    "targeted_deep_dive",
  );
  const targetedLineage = incumbentResponseLineage(targetedTask);
  const targeted = compileCommercialResearchDelivery(
    commercialDelivery({ unit_id: "unit_response_targeted" }),
    targetedTaskPath,
    [targetedTask, ...targetedLineage, opportunity],
    policy,
  );
  const targetedAssessment = (
    targeted.document.incumbent_response_assessments as Record<string, unknown>[]
  )[0];
  assert.ok(targetedAssessment);
  assert.equal(targetedAssessment.analysis_depth, "targeted_deep_dive");
  assert.equal((targetedAssessment.semantic as Record<string, unknown>).analysis_state, "unknown");
});

test("high response ability remains judgment context and preserves every Evidence role", async () => {
  const policy = await commercialPolicy();
  assert.deepEqual(policy.incumbent_response_automatic_effects, {
    gate: false,
    ranking_eligibility: false,
    claim_confidence: false,
    recommendation_ceiling: false,
    artifact_publication: false,
  });
  const candidateRef = "artifacts/discovery/candidates/response-risk.r1.json";
  const candidate = responseSubject(candidateRef, "candidate_response_risk");
  const taskPath = "tasks/discovery/unit_response_lightweight.attempt-1.json";
  const task = incumbentResponseTask(taskPath, [candidateRef], "lightweight_scan");
  const lineage = incumbentResponseLineage(task);
  const sources = responseEvidenceSources();
  const baseDelivery = commercialDelivery({
    unit_id: "unit_response_lightweight",
    evidence_sources: sources,
    claims: [
      {
        subject_id: "candidate_response_risk",
        statement: "The incumbent has adjacent implementation capability.",
        evidence_refs: ["evidence/records/response-news.json"],
        confidence: "medium",
      },
    ],
  });
  const unknownDelivery = structuredClone(baseDelivery);
  unknownDelivery.incumbent_response_assessments = [
    incumbentResponseSemantic({
      subjectId: "candidate_response_risk",
      state: "unknown",
      supportingRefs: ["evidence/records/response-news.json"],
      opposingRefs: ["evidence/records/response-review.json"],
      backgroundRefs: ["evidence/records/response-company.json"],
    }),
  ];
  const validator = await createArtifactValidator(repositoryRoot);
  assert.equal(validator.validateDocument(unknownDelivery).valid, true);
  const unknown = compileCommercialResearchDelivery(
    unknownDelivery,
    taskPath,
    [task, ...lineage, candidate],
    policy,
  ).document;
  const unknownSemantic = (unknown.incumbent_response_assessments as Record<string, unknown>[])[0]
    ?.semantic as Record<string, unknown>;
  assert.deepEqual(unknownSemantic.supporting_evidence_refs, [
    "evidence/records/response-news.json",
  ]);
  assert.deepEqual(unknownSemantic.opposing_evidence_refs, [
    "evidence/records/response-review.json",
  ]);
  assert.deepEqual(unknownSemantic.background_evidence_refs, [
    "evidence/records/response-company.json",
  ]);
  assert.equal(unknownSemantic.responder_identity, null);
  assert.equal((unknownSemantic.capability_adjacency as Record<string, unknown>).level, "unknown");
  assert.equal((unknownSemantic.incentive as Record<string, unknown>).level, "unknown");
  assert.equal((unknownSemantic.thesis_coverage as Record<string, unknown>).scope, "unknown");
  assert.equal(unknownSemantic.confidence, "unknown");
  assert.equal(unknownSemantic.inference_boundary, INCUMBENT_RESPONSE_UNKNOWN_RATIONALE);
  assert.equal(
    (unknownSemantic.capability_adjacency as Record<string, unknown>).rationale,
    INCUMBENT_RESPONSE_UNKNOWN_RATIONALE,
  );
  assert.equal(
    JSON.stringify(unknown).includes("No responder-specific assessment was delivered"),
    false,
  );
  const unknownProjection = projectCommercialAuditTables([
    { path: "artifacts/research-audits/response-unknown.json", document: unknown },
  ]);
  const unknownReportRow = unknownProjection.incumbent_response_risk_rows[0] as Record<
    string,
    unknown
  >;
  const projectedUnknownSemantic = (unknownReportRow.assessment as Record<string, unknown>)
    .semantic as Record<string, unknown>;
  assert.deepEqual(
    projectedUnknownSemantic.supporting_evidence_refs,
    unknownSemantic.supporting_evidence_refs,
  );
  assert.deepEqual(
    projectedUnknownSemantic.opposing_evidence_refs,
    unknownSemantic.opposing_evidence_refs,
  );
  assert.deepEqual(
    projectedUnknownSemantic.background_evidence_refs,
    unknownSemantic.background_evidence_refs,
  );
  const unknownTable = renderIncumbentResponseRiskTable(unknownProjection);
  assert.ok(unknownTable.includes("insufficient to form a complete responder-specific conclusion"));
  assert.ok(unknownTable.includes("evidence/records/response-news.json"));
  assert.ok(unknownTable.includes("evidence/records/response-review.json"));
  assert.ok(unknownTable.includes("evidence/records/response-company.json"));
  assert.equal(unknownTable.includes("No responder-specific assessment was delivered"), false);
  const riskDelivery = structuredClone(baseDelivery);
  riskDelivery.incumbent_response_assessments = [
    incumbentResponseSemantic({
      subjectId: "candidate_response_risk",
      supportingRefs: ["evidence/records/response-news.json"],
      opposingRefs: ["evidence/records/response-review.json"],
      backgroundRefs: ["evidence/records/response-company.json"],
    }),
  ];
  assert.equal(validator.validateDocument(riskDelivery).valid, true);
  const compiled = compileCommercialResearchDelivery(
    riskDelivery,
    taskPath,
    [task, ...lineage, candidate],
    policy,
  ).document;

  assert.equal(compiled.ranking_eligibility, unknown.ranking_eligibility);
  assert.deepEqual(compiled.recommendation_ceiling, unknown.recommendation_ceiling);
  assert.equal(
    (compiled.claims as Record<string, unknown>[])[0]?.confidence,
    (unknown.claims as Record<string, unknown>[])[0]?.confidence,
  );
  const assessment = (compiled.incumbent_response_assessments as Record<string, unknown>[])[0];
  const semantic = assessment?.semantic as Record<string, unknown>;
  assert.equal((semantic.capability_adjacency as Record<string, unknown>).level, "high");
  assert.equal((semantic.incentive as Record<string, unknown>).level, "low");
  assert.equal((semantic.thesis_coverage as Record<string, unknown>).scope, "single_feature");
  assert.equal(
    (semantic.residual_differentiation as Record<string, unknown>).overall_strength,
    "high",
  );
  assert.deepEqual(
    (compiled.evidence_register as Record<string, unknown>[]).map(
      (entry) => (entry.source_profile as Record<string, unknown>).type,
    ),
    ["news", "review", "company_material"],
  );
  assert.deepEqual(semantic.supporting_evidence_refs, ["evidence/records/response-news.json"]);
  assert.deepEqual(semantic.opposing_evidence_refs, ["evidence/records/response-review.json"]);
  assert.deepEqual(semantic.background_evidence_refs, ["evidence/records/response-company.json"]);
  assert.equal(semantic.strategic_implication, INCUMBENT_RESPONSE_STRATEGIC_CONTEXT);

  const actionBearingText =
    "Fail this candidate and eliminate it immediately; impose a recommendation ceiling.";
  const actionBearingDelivery = structuredClone(riskDelivery);
  const actionBearingInput = (
    actionBearingDelivery.incumbent_response_assessments as Record<string, unknown>[]
  )[0];
  assert.ok(actionBearingInput);
  actionBearingInput.strategic_implication = actionBearingText;
  assert.equal(validator.validateDocument(actionBearingDelivery).valid, false);
  const actionBearingCompiled = compileCommercialResearchDelivery(
    actionBearingDelivery,
    taskPath,
    [task, ...lineage, candidate],
    policy,
  ).document;
  const actionBearingSemantic = (
    actionBearingCompiled.incumbent_response_assessments as Record<string, unknown>[]
  )[0]?.semantic as Record<string, unknown>;
  assert.equal(actionBearingSemantic.strategic_implication, INCUMBENT_RESPONSE_STRATEGIC_CONTEXT);
  assert.equal(JSON.stringify(actionBearingCompiled).includes(actionBearingText), false);
  assert.equal(validator.validateDocument(actionBearingCompiled).valid, true);
  assert.equal(actionBearingCompiled.ranking_eligibility, compiled.ranking_eligibility);
  assert.deepEqual(actionBearingCompiled.recommendation_ceiling, compiled.recommendation_ceiling);
  assert.deepEqual(actionBearingCompiled.claims, compiled.claims);

  const mutatedAudit = structuredClone(compiled);
  const mutatedAssessment = (
    mutatedAudit.incumbent_response_assessments as Record<string, unknown>[]
  )[0] as Record<string, unknown>;
  const mutatedSemantic = mutatedAssessment.semantic as Record<string, unknown>;
  mutatedSemantic.strategic_implication = actionBearingText;
  const mutatedAssessmentId = `incumbent_response_${canonicalContentHash([
    "unit_response_lightweight",
    mutatedSemantic,
  ]).slice("sha256:".length, "sha256:".length + 24)}`;
  mutatedAssessment.assessment_id = mutatedAssessmentId;
  const mutatedCoverage = (
    mutatedAudit.incumbent_response_coverage as Record<string, unknown>[]
  )[0] as Record<string, unknown>;
  mutatedCoverage.assessment_ids = [mutatedAssessmentId];
  assert.equal(validator.validateDocument(mutatedAudit).valid, false);
  const mutatedCodes = validateCommercialResearchContract(
    [
      { path: taskPath, schemaVersion: task.artifact_type, document: task.document },
      ...lineage.map((artifact) => ({
        path: artifact.artifact_path,
        schemaVersion: artifact.artifact_type,
        document: artifact.document,
      })),
      {
        path: candidateRef,
        schemaVersion: candidate.artifact_type,
        document: candidate.document,
      },
      {
        path: "artifacts/research-audits/response-mutated.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: mutatedAudit,
      },
    ],
    policy,
  ).map((issue) => issue.code);
  assert.ok(
    mutatedCodes.includes("commercial_research.incumbent_response_strategic_context_mismatch"),
  );
  const sanitizedProjection = projectCommercialAuditTables([
    { path: "artifacts/research-audits/response-mutated.json", document: mutatedAudit },
  ]);
  assert.equal(JSON.stringify(sanitizedProjection).includes(actionBearingText), false);
  const sanitizedTable = renderIncumbentResponseRiskTable(sanitizedProjection);
  assert.equal(sanitizedTable.includes(actionBearingText), false);
  assert.ok(sanitizedTable.includes(INCUMBENT_RESPONSE_STRATEGIC_CONTEXT));

  const broken = structuredClone(unknown);
  const brokenAssessment = (
    broken.incumbent_response_assessments as Record<string, unknown>[]
  )[0] as Record<string, unknown>;
  (brokenAssessment.semantic as Record<string, unknown>).opposing_evidence_refs = [
    "evidence/records/missing-response-counterevidence.json",
  ];
  const brokenCodes = validateCommercialResearchContract(
    [
      {
        path: candidateRef,
        schemaVersion: candidate.artifact_type,
        document: candidate.document,
      },
      { path: taskPath, schemaVersion: task.artifact_type, document: task.document },
      ...lineage.map((artifact) => ({
        path: artifact.artifact_path,
        schemaVersion: artifact.artifact_type,
        document: artifact.document,
      })),
      {
        path: "artifacts/research-audits/response-lightweight.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: broken,
      },
    ],
    policy,
  ).map((issue) => issue.code);
  assert.ok(brokenCodes.includes("commercial_research.incumbent_response_evidence_unregistered"));
  const assignmentDrift = structuredClone(compiled);
  (assignmentDrift.incumbent_response_assignment as Record<string, unknown>).rationale =
    "Audit drifted from the Plan authority.";
  const assignmentDriftCodes = validateCommercialResearchContract(
    [
      { path: taskPath, schemaVersion: task.artifact_type, document: task.document },
      ...lineage.map((artifact) => ({
        path: artifact.artifact_path,
        schemaVersion: artifact.artifact_type,
        document: artifact.document,
      })),
      {
        path: "artifacts/research-audits/response-lightweight.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: assignmentDrift,
      },
    ],
    policy,
  ).map((issue) => issue.code);
  assert.ok(
    assignmentDriftCodes.includes("commercial_research.incumbent_response_assignment_mismatch"),
  );
});

test("all formal report sources project response rows and explicit gaps", async () => {
  const policy = await commercialPolicy();
  const candidateARef = "artifacts/discovery/candidates/report-response-a.r1.json";
  const candidateBRef = "artifacts/discovery/candidates/report-response-b.r1.json";
  const candidateA = responseSubject(candidateARef, "candidate_report_response_a");
  const candidateB = responseSubject(candidateBRef, "candidate_report_response_b");
  const taskPath = "tasks/discovery/unit_response_lightweight.attempt-1.json";
  const task = incumbentResponseTask(taskPath, [candidateARef, candidateBRef], "lightweight_scan");
  const lineage = incumbentResponseLineage(task);
  const audit = compileCommercialResearchDelivery(
    commercialDelivery({
      unit_id: "unit_response_lightweight",
      evidence_sources: responseEvidenceSources(),
      incumbent_response_assessments: [
        incumbentResponseSemantic({
          subjectId: "candidate_report_response_a",
          state: "not_applicable",
        }),
        incumbentResponseSemantic({
          subjectId: "candidate_report_response_b",
          state: "unknown",
          supportingRefs: ["evidence/records/response-news.json"],
          opposingRefs: ["evidence/records/response-review.json"],
          backgroundRefs: ["evidence/records/response-company.json"],
        }),
      ],
    }),
    taskPath,
    [task, ...lineage, candidateA, candidateB],
    policy,
  ).document;
  const auditRef = "artifacts/research-audits/response-lightweight.json";
  const projection = commercialReportProjection([{ auditRef, audit }]);
  const reportDocuments = [
    ["artifacts/reporting/discovery-report.json", "startup_opportunity.report.v1"],
    [
      "artifacts/reporting/concept-evidence-report.json",
      "startup_opportunity.concept_evidence_report.v1",
    ],
    ["artifacts/reporting/terminal-source.json", "startup_opportunity.terminal_report_source.v1"],
  ].map(([reportPath, schemaVersion]) => ({
    path: reportPath as string,
    schemaVersion: schemaVersion as string,
    document: { ...projection },
  }));
  const issues = validateCommercialResearchContract(
    [
      {
        path: candidateARef,
        schemaVersion: candidateA.artifact_type,
        document: candidateA.document,
      },
      {
        path: candidateBRef,
        schemaVersion: candidateB.artifact_type,
        document: candidateB.document,
      },
      { path: taskPath, schemaVersion: task.artifact_type, document: task.document },
      ...lineage.map((artifact) => ({
        path: artifact.artifact_path,
        schemaVersion: artifact.artifact_type,
        document: artifact.document,
      })),
      {
        path: auditRef,
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: audit,
      },
      ...reportDocuments,
    ],
    policy,
  );
  assert.equal(
    issues.some(
      (issue) => issue.code === "commercial_research.report_incumbent_response_projection_mismatch",
    ),
    false,
  );
  assert.equal((projection.incumbent_response_risk_rows as unknown[]).length, 2);
  for (const report of reportDocuments) {
    const rows = report.document.incumbent_response_risk_rows as Record<string, unknown>[];
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const reportAssessment = row.assessment as Record<string, unknown>;
      const reportSemantic = reportAssessment.semantic as Record<string, unknown>;
      assert.equal(reportSemantic.strategic_implication, INCUMBENT_RESPONSE_STRATEGIC_CONTEXT);
    }
    assert.equal(
      JSON.stringify(report.document).includes("No responder-specific assessment was delivered"),
      false,
    );
  }
  const table = renderIncumbentResponseRiskTable(projection);
  assert.match(table, /Potential Responder \/ Control Point/);
  assert.match(table, /candidate_report_response_a/);
  assert.match(table, /not_applicable/);
  assert.match(table, /candidate_report_response_b/);
  assert.match(table, /unknown/);
  assert.match(table, /evidence\/records\/response-news\.json/);
  assert.match(table, /evidence\/records\/response-review\.json/);
  assert.match(table, /evidence\/records\/response-company\.json/);
  assert.match(table, /Strategic Implication/);
  assert.ok(table.includes(INCUMBENT_RESPONSE_STRATEGIC_CONTEXT));
  assert.ok(table.includes("insufficient to form a complete responder-specific conclusion"));
  assert.equal(table.includes("No responder-specific assessment was delivered"), false);
  assert.match(table, /Context only: incumbent absorption and response risk is not a Gate/);

  const drifted = structuredClone(reportDocuments);
  for (const report of drifted) report.document.incumbent_response_risk_rows = [];
  const driftCodes = validateCommercialResearchContract(
    [
      { path: taskPath, schemaVersion: task.artifact_type, document: task.document },
      ...lineage.map((artifact) => ({
        path: artifact.artifact_path,
        schemaVersion: artifact.artifact_type,
        document: artifact.document,
      })),
      {
        path: candidateARef,
        schemaVersion: candidateA.artifact_type,
        document: candidateA.document,
      },
      {
        path: candidateBRef,
        schemaVersion: candidateB.artifact_type,
        document: candidateB.document,
      },
      {
        path: auditRef,
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: audit,
      },
      ...drifted,
    ],
    policy,
  ).filter(
    (issue) => issue.code === "commercial_research.report_incumbent_response_projection_mismatch",
  );
  assert.equal(driftCodes.length, 3);

  const unassignedTable = renderIncumbentResponseRiskTable({ incumbent_response_risk_rows: [] });
  assert.match(unassignedTable, /Data gap: post-candidate incumbent absorption/);
  assert.match(unassignedTable, /does not trigger automatic elimination/);
  assert.match(
    unassignedTable,
    /Context only: incumbent absorption and response risk is not a Gate/,
  );
});

test("unknown and not-applicable response inputs are minimal while assessed input remains complete", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const unknownDelivery = commercialDelivery({
    incumbent_response_assessments: [
      incumbentResponseSemantic({ subjectId: "candidate_response_unknown", state: "unknown" }),
    ],
  });
  assert.equal(validator.validateDocument(unknownDelivery).valid, true);
  const notApplicableDelivery = commercialDelivery({
    incumbent_response_assessments: [
      incumbentResponseSemantic({
        subjectId: "candidate_response_na",
        state: "not_applicable",
      }),
    ],
  });
  assert.equal(validator.validateDocument(notApplicableDelivery).valid, true);
  const assessedDelivery = commercialDelivery({
    incumbent_response_assessments: [
      incumbentResponseSemantic({
        subjectId: "candidate_response_assessed",
        backgroundRefs: ["evidence/records/response-company.json"],
      }),
    ],
  });
  assert.equal(validator.validateDocument(assessedDelivery).valid, true);

  const contradictoryUnknown = structuredClone(unknownDelivery);
  (contradictoryUnknown.incumbent_response_assessments as Record<string, unknown>[])[0] = {
    ...((contradictoryUnknown.incumbent_response_assessments as Record<string, unknown>[])[0] ??
      {}),
    responder_identity: "Synthetic Leader",
    capability_adjacency: { level: "high", rationale: "Strong ability." },
    strategic_implication: "The candidate should be eliminated.",
  };
  assert.equal(validator.validateDocument(contradictoryUnknown).valid, false);
  const contradictoryNotApplicable = structuredClone(notApplicableDelivery);
  (contradictoryNotApplicable.incumbent_response_assessments as Record<string, unknown>[])[0] = {
    ...((
      contradictoryNotApplicable.incumbent_response_assessments as Record<string, unknown>[]
    )[0] ?? {}),
    response_modes: ["copy"],
    thesis_coverage: { scope: "full_value_proposition", rationale: "Contradictory." },
  };
  assert.equal(validator.validateDocument(contradictoryNotApplicable).valid, false);

  const policy = await commercialPolicy();
  const subjectRef = "artifacts/discovery/candidates/response-legacy.r1.json";
  const subject = responseSubject(subjectRef, "candidate_response_unknown");
  const taskPath = "tasks/discovery/unit_response_lightweight.attempt-1.json";
  const task = incumbentResponseTask(taskPath, [subjectRef], "lightweight_scan");
  const legacyResult = compileCommercialResearchDelivery(
    {
      ...contradictoryUnknown,
      unit_id: "unit_response_lightweight",
    },
    taskPath,
    [task, ...incumbentResponseLineage(task), subject],
    policy,
  );
  const legacyWarning = legacyResult.issues.find(
    (issue) =>
      issue.code === "commercial_research.incumbent_response_legacy_state_semantics_ignored",
  );
  assert.ok(legacyWarning);
  assert.equal(isBlockingIssue(legacyWarning), false);
  assert.ok(
    (legacyResult.document.compiler_warnings as Record<string, unknown>[]).some(
      (warning) =>
        warning.code === "commercial_research.incumbent_response_legacy_state_semantics_ignored",
    ),
  );
  const normalizedSemantic = (
    legacyResult.document.incumbent_response_assessments as Record<string, unknown>[]
  )[0]?.semantic as Record<string, unknown>;
  assert.equal(normalizedSemantic.analysis_state, "unknown");
  assert.equal(normalizedSemantic.responder_identity, null);
  assert.equal(
    (normalizedSemantic.capability_adjacency as Record<string, unknown>).level,
    "unknown",
  );
});

test("commercial coverage keeps incomplete candidates unranked and rejects academic or vendor substitution", async () => {
  const policy = await commercialPolicy();
  const unranked = commercialAudit();
  assert.deepEqual(commercialCodes(unranked, policy), []);

  const falselyRanked = structuredClone(unranked);
  falselyRanked.ranking_eligibility = "ranked";
  assert.ok(
    commercialCodes(falselyRanked, policy).includes(
      "commercial_research.ranking_eligibility_mismatch",
    ),
  );

  const academic = structuredClone(unranked);
  academic.evidence_register = [
    {
      evidence_ref: "evidence/records/academic-synthetic.json",
      source_kind: "academic",
      evidence_character: "mechanism",
      independence: "independent",
      coverage_keys: ["purchase_signal"],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  const academicCodes = commercialCodes(academic, policy);
  assert.ok(academicCodes.includes("commercial_research.academic_commercial_coverage"));

  const vendor = structuredClone(unranked);
  vendor.evidence_register = [
    {
      evidence_ref: "evidence/records/vendor-synthetic.json",
      source_kind: "vendor",
      evidence_character: "vendor_claim",
      independence: "interested_party",
      claim_type: "vendor_statement",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2018-01-01T00:00:00Z",
      observed_at: "2026-08-04T12:00:00Z",
      data_period_end: null,
      derived_valid_as_of: "2026-08-04",
      freshness_status: "current",
      coverage_keys: ["purchase_signal"],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  const vendorCoverage = vendor.coverage as Record<string, Record<string, unknown>>;
  vendorCoverage.purchase_signal = {
    state: "observed",
    content_covered: true,
    evidence_refs: ["evidence/records/vendor-synthetic.json"],
    data_points: [
      {
        evidence_ref: "evidence/records/vendor-synthetic.json",
        aspect: "purchase",
        fact_or_excerpt: "The vendor states that customers buy the product.",
      },
    ],
    inference: null,
  };
  const vendorCodes = commercialCodes(vendor, policy);
  assert.ok(vendorCodes.includes("commercial_research.vendor_claim_not_cross_validated"));
  assert.ok(vendorCodes.includes("commercial_research.coverage_state_mismatch"));

  const retentionAudit = structuredClone(unranked);
  const mechanismRef = "artifacts/evidence/independent-current-mechanism-synthetic.json";
  retentionAudit.evidence_register = [
    {
      evidence_ref: mechanismRef,
      source_kind: "independent",
      evidence_character: "mechanism",
      independence: "independent",
      claim_type: "academic_mechanism",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: "2026-08-01T00:00:00Z",
      data_period_end: null,
      derived_valid_as_of: "2026-08-01",
      freshness_status: "current",
      coverage_keys: ["purchase_signal"],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  const retentionCoverage = retentionAudit.coverage as Record<string, Record<string, unknown>>;
  retentionCoverage.purchase_signal = {
    state: "observed",
    content_covered: true,
    evidence_refs: [mechanismRef],
    data_points: [
      {
        evidence_ref: mechanismRef,
        aspect: "purchase",
        fact_or_excerpt: "A current independent paper describes a mechanism, not a purchase.",
      },
    ],
    inference: null,
  };
  const retentionDocuments = [
    ...commercialAuditLineage(retentionAudit),
    {
      path: "tasks/discovery/unit_retention_synthetic.attempt-1.json",
      schemaVersion: "startup_opportunity.research_task.discovery_candidate.current",
      document: {
        source_phase: "candidate_generation",
        commercial_research_requirements: {
          commercial_audit_output_path: "artifacts/research-audits/unit_retention_synthetic.json",
        },
      },
    },
    {
      path: "artifacts/research-audits/unit_retention_synthetic.json",
      schemaVersion: "startup_opportunity.commercial_research_audit.current",
      document: retentionAudit,
    },
    {
      path: "artifacts/discovery/lanes/unit_retention_synthetic.attempt-1.json",
      schemaVersion: "startup_opportunity.discovery_lane_result.v1",
      document: {
        task_ref: "tasks/discovery/unit_retention_synthetic.attempt-1.json",
        scored_candidates: [
          {
            candidate_ref: "artifacts/discovery/candidates/retention-synthetic.r1.json",
            supporting_refs: [mechanismRef],
          },
        ],
        pre_kill_decisions: [
          {
            candidate_ref: "artifacts/discovery/candidates/retention-synthetic.r1.json",
            disposition: "retained",
            retention_basis: "evidence",
          },
        ],
      },
    },
  ];
  assert.ok(
    validateCommercialResearchContract(retentionDocuments, policy)
      .map((issue) => issue.code)
      .includes("commercial_research.candidate_retention_without_direct_commercial_evidence"),
  );
});

test("planned search allocation is guidance while adopted distribution is Register-derived", async () => {
  const policy = await commercialPolicy();
  const audit = commercialAudit();
  audit.planned_resource_allocation = {
    customer_commercial_percent: 10,
    market_structure_percent: 10,
    academic_percent: 80,
  };
  assert.deepEqual(commercialCodes(audit, policy), []);

  const falseObservation = structuredClone(audit);
  (falseObservation.adopted_source_distribution as Record<string, unknown>).academic_percent = 80;
  assert.ok(
    commercialCodes(falseObservation, policy).includes(
      "commercial_research.adopted_distribution_mismatch",
    ),
  );

  const marketStructure = commercialAudit();
  const marketRef = "evidence/records/independent-market-structure-synthetic.json";
  const marketQuery = (marketStructure.search_log as Record<string, unknown>[])[0];
  assert.ok(marketQuery);
  const marketResult = (marketQuery.candidate_results as Record<string, unknown>[])[0];
  assert.ok(marketResult);
  Object.assign(marketResult, {
    adopted_evidence_ref: marketRef,
    rejection_reason: null,
    claim_type: "market_structure_regulatory",
    regulatory_effective_status: "effective",
    regulatory_status_verified_at: "2026-08-04T12:00:00Z",
    derived_valid_as_of: "2026-08-04",
  });
  marketStructure.evidence_register = [
    {
      evidence_ref: marketRef,
      source_kind: "independent",
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "market_structure_regulatory",
      regulatory_effective_status: "effective",
      regulatory_status_verified_at: "2026-08-04T12:00:00Z",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: null,
      data_period_end: null,
      derived_valid_as_of: "2026-08-04",
      freshness_status: "current",
      coverage_keys: [],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  marketStructure.adopted_source_distribution = {
    total_adopted_sources: 1,
    customer_commercial_count: 0,
    market_structure_count: 1,
    academic_count: 0,
    customer_commercial_percent: 0,
    market_structure_percent: 100,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  assert.deepEqual(commercialCodes(marketStructure, policy), []);

  const duplicate = structuredClone(marketStructure);
  duplicate.evidence_register = [
    ...(duplicate.evidence_register as Record<string, unknown>[]),
    structuredClone((duplicate.evidence_register as Record<string, unknown>[])[0]),
  ];
  const duplicateCodes = commercialCodes(duplicate, policy);
  assert.ok(duplicateCodes.includes("commercial_research.duplicate_evidence_ref"));
  assert.equal(duplicateCodes.includes("commercial_research.adopted_distribution_mismatch"), false);
});

test("commercial coverage distinguishes observation, inference, and dimension-specific facts", async () => {
  const policy = await commercialPolicy();
  const evidenceRef = "evidence/records/independent-purchase-synthetic.json";
  const inferred = commercialAudit();
  const firstQuery = (inferred.search_log as Record<string, unknown>[])[0];
  assert.ok(firstQuery);
  const searchResult = (firstQuery.candidate_results as Record<string, unknown>[])[0];
  assert.ok(searchResult);
  searchResult.adopted_evidence_ref = evidenceRef;
  searchResult.rejection_reason = null;
  inferred.evidence_register = [
    {
      evidence_ref: evidenceRef,
      source_kind: "independent",
      evidence_character: "inference",
      independence: "independent",
      claim_type: "current_purchase_behavior",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: "2026-08-03T00:00:00Z",
      data_period_end: null,
      derived_valid_as_of: "2026-08-03",
      freshness_status: "current",
      coverage_keys: ["purchase_signal"],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  inferred.adopted_source_distribution = {
    total_adopted_sources: 1,
    customer_commercial_count: 1,
    market_structure_count: 0,
    academic_count: 0,
    customer_commercial_percent: 100,
    market_structure_percent: 0,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  const inferredCoverage = inferred.coverage as Record<string, Record<string, unknown>>;
  inferredCoverage.purchase_signal = {
    state: "inferred",
    content_covered: true,
    evidence_refs: [evidenceRef],
    data_points: [],
    inference: {
      basis_refs: [evidenceRef],
      starting_point: "An independent source describes purchase-adjacent behavior.",
      reasoning: "The behavior may imply purchase intent, but no transaction is observed.",
      uncertainty: "Intent may not convert to payment.",
      validation_needed: "Observe a recent purchase or payment commitment.",
    },
  };
  assert.deepEqual(commercialCodes(inferred, policy), []);
  assert.equal(inferred.ranking_eligibility, "unranked_hypothesis");

  const disguisedObservation = structuredClone(inferred);
  const disguisedCoverage = disguisedObservation.coverage as Record<
    string,
    Record<string, unknown>
  >;
  disguisedCoverage.purchase_signal = {
    state: "observed",
    content_covered: true,
    evidence_refs: [evidenceRef],
    data_points: [
      {
        evidence_ref: evidenceRef,
        aspect: "purchase",
        fact_or_excerpt: "The source contains no directly observed purchase.",
      },
    ],
    inference: null,
  };
  assert.ok(
    commercialCodes(disguisedObservation, policy).includes(
      "commercial_research.coverage_state_mismatch",
    ),
  );

  const reusedFact = structuredClone(disguisedObservation);
  const reusedCoverage = reusedFact.coverage as Record<string, Record<string, unknown>>;
  reusedCoverage.recent_user_language = {
    state: "observed",
    content_covered: true,
    evidence_refs: [evidenceRef],
    data_points: [
      {
        evidence_ref: evidenceRef,
        aspect: "user_language",
        fact_or_excerpt: "The source contains no directly observed purchase.",
      },
    ],
    inference: null,
  };
  assert.ok(
    commercialCodes(reusedFact, policy).includes("commercial_research.coverage_data_point_reused"),
  );
});

test("retrieval time cannot refresh old observations and Search Closure reconciles adopted refs", async () => {
  const policy = await commercialPolicy();
  const stale = commercialAudit();
  const evidenceRef = "evidence/records/stale-user-language-synthetic.json";
  stale.evidence_register = [
    {
      evidence_ref: evidenceRef,
      source_kind: "independent",
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "recent_user_language",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2020-01-02T00:00:00Z",
      observed_at: "2020-01-01T00:00:00Z",
      data_period_end: null,
      derived_valid_as_of: "2020-01-01",
      freshness_status: "current",
      coverage_keys: ["recent_user_language"],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  stale.adopted_source_distribution = {
    total_adopted_sources: 1,
    customer_commercial_count: 1,
    market_structure_count: 0,
    academic_count: 0,
    customer_commercial_percent: 100,
    market_structure_percent: 0,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  const staleCodes = commercialCodes(stale, policy);
  assert.ok(staleCodes.includes("commercial_research.freshness_status_mismatch"));
  assert.equal(staleCodes.includes("commercial_research.search_evidence_reconciliation"), false);

  const recentBehavior = commercialAudit();
  const userRef = "evidence/records/user-language-2024-synthetic.json";
  const purchaseRef = "evidence/records/purchase-2025-synthetic.json";
  const recentQuery = (recentBehavior.search_log as Record<string, unknown>[])[0];
  assert.ok(recentQuery);
  recentQuery.candidate_results = [
    {
      url: "https://example.invalid/user-language-2024",
      title: "Synthetic 2024 user-language data",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2024-09-15T00:00:00Z",
      observed_at: null,
      data_period_end: "2024-09-01",
      derived_valid_as_of: "2024-09-01",
      claim_type: "recent_user_language",
      adopted_evidence_ref: userRef,
      rejection_reason: null,
    },
    {
      url: "https://example.invalid/purchase-2025",
      title: "Synthetic 2025 purchase data",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2025-03-01T00:00:00Z",
      observed_at: null,
      data_period_end: "2025-02-28",
      derived_valid_as_of: "2025-02-28",
      claim_type: "current_purchase_behavior",
      adopted_evidence_ref: purchaseRef,
      rejection_reason: null,
    },
  ];
  recentBehavior.evidence_register = [
    {
      evidence_ref: userRef,
      source_kind: "independent",
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "recent_user_language",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2024-09-15T00:00:00Z",
      observed_at: null,
      data_period_end: "2024-09-01",
      derived_valid_as_of: "2024-09-01",
      freshness_status: "current",
      coverage_keys: [],
      disposition: "adopted",
      exclusion_reason: null,
    },
    {
      evidence_ref: purchaseRef,
      source_kind: "independent",
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "current_purchase_behavior",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2025-03-01T00:00:00Z",
      observed_at: null,
      data_period_end: "2025-02-28",
      derived_valid_as_of: "2025-02-28",
      freshness_status: "current",
      coverage_keys: [],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  recentBehavior.adopted_source_distribution = {
    total_adopted_sources: 2,
    customer_commercial_count: 2,
    market_structure_count: 0,
    academic_count: 0,
    customer_commercial_percent: 100,
    market_structure_percent: 0,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  assert.deepEqual(commercialCodes(recentBehavior, policy), []);

  const stalePrice = structuredClone(recentBehavior);
  const stalePriceItem = (stalePrice.evidence_register as Record<string, unknown>[])[0];
  assert.ok(stalePriceItem);
  stalePriceItem.claim_type = "current_pricing";
  stalePriceItem.data_period_end = null;
  stalePriceItem.observed_at = "2026-01-01T00:00:00Z";
  stalePriceItem.derived_valid_as_of = "2026-01-01";
  const stalePriceIssue = validateCommercialResearchContract(
    [
      {
        path: "artifacts/research-audits/commercial-synthetic.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: stalePrice,
      },
    ],
    policy,
  ).find((issue) => issue.code === "commercial_research.freshness_status_mismatch");
  assert.ok(stalePriceIssue);
  assert.equal(isBlockingIssue(stalePriceIssue), true);

  const oldDataOnRecentPage = structuredClone(stale);
  const oldDataItem = (oldDataOnRecentPage.evidence_register as Record<string, unknown>[])[0];
  assert.ok(oldDataItem);
  oldDataItem.observed_at = "2026-08-03T00:00:00Z";
  oldDataItem.data_period_end = "2020-01-01";
  oldDataItem.derived_valid_as_of = "2026-08-03";
  assert.ok(
    commercialCodes(oldDataOnRecentPage, policy).includes(
      "commercial_research.valid_as_of_not_derived",
    ),
  );

  const closureMismatch = commercialAudit();
  (closureMismatch.search_closure as Record<string, unknown>).outcome = "search_not_required";
  assert.ok(
    commercialCodes(closureMismatch, policy).includes(
      "commercial_research.search_closure_kind_mismatch",
    ),
  );
  const earlyStopBeforeSearch = commercialAudit();
  earlyStopBeforeSearch.search_log = [];
  earlyStopBeforeSearch.search_closure = {
    closure_id: "search_closure_unit_commercial_synthetic",
    lane_kind: "external_research",
    outcome: "early_stop",
    query_log_complete: true,
    telemetry_basis: "agent_supplied",
    remaining_gaps: earlyStopBeforeSearch.uncovered_business_dimensions,
    termination_reason: "An upstream commercial signal gate stopped this lane before search.",
  };
  assert.ok(
    commercialCodes(earlyStopBeforeSearch, policy).includes(
      "commercial_research.search_closure_log_missing",
    ),
  );
  const telemetryOverclaim = commercialAudit();
  telemetryOverclaim.search_closure = {
    closure_id: "search_closure_unit_commercial_synthetic",
    lane_kind: "external_research",
    outcome: "evidence_insufficient",
    query_log_complete: true,
    telemetry_basis: "unavailable",
    remaining_gaps: [],
    termination_reason: "Synthetic telemetry is unavailable.",
  };
  assert.ok(
    commercialCodes(telemetryOverclaim, policy).includes(
      "commercial_research.search_telemetry_overclaimed",
    ),
  );
  const fabricatedHarnessTelemetry = commercialAudit();
  (fabricatedHarnessTelemetry.search_closure as Record<string, unknown>).telemetry_basis =
    "harness_recorded";
  assert.ok(
    commercialCodes(fabricatedHarnessTelemetry, policy).includes(
      "commercial_research.search_telemetry_unobservable",
    ),
  );
});

test("quantitative acquisition is provider-agnostic and APIs remain optional", async () => {
  const policy = await commercialPolicy();
  const fixture = quantitativeCommercialFixture();
  assert.deepEqual(quantitativeCommercialCodes(fixture, policy), []);

  const validator = await createArtifactValidator(repositoryRoot);
  assert.equal(
    validator.validateDocument(fixture.audit, "artifacts/research-audits/commercial-synthetic.json")
      .valid,
    true,
  );
  const acquisition = (fixture.audit.data_acquisitions as Record<string, unknown>[])[0];
  assert.ok(acquisition);
  acquisition.acquisition_method = "authorized_commercial_api";
  acquisition.provider = "Previously Unseen Lawful Data Provider";
  acquisition.access_basis = "caller_authorized_commercial";
  assert.deepEqual(quantitativeCommercialCodes(fixture, policy), []);
  assert.equal(
    validator.validateDocument(fixture.audit, "artifacts/research-audits/commercial-synthetic.json")
      .valid,
    true,
  );
});

test("quantitative acquisition rejects raw binding drift, secrets, and access-control claims", async () => {
  const policy = await commercialPolicy();

  const mismatched = quantitativeCommercialFixture();
  const mismatchedAcquisition = (
    mismatched.audit.data_acquisitions as Record<string, unknown>[]
  )[0];
  assert.ok(mismatchedAcquisition);
  mismatchedAcquisition.raw_response_hash = `sha256:${"c".repeat(64)}`;
  assert.ok(
    quantitativeCommercialCodes(mismatched, policy).includes(
      "commercial_research.acquisition_substrate_binding_mismatch",
    ),
  );

  const exposedSecret = quantitativeCommercialFixture();
  const secretAcquisition = (exposedSecret.audit.data_acquisitions as Record<string, unknown>[])[0];
  assert.ok(secretAcquisition);
  secretAcquisition.endpoint_or_query_redacted =
    "https://metrics.example.invalid/query?access_token=unredacted-secret";
  assert.ok(
    quantitativeCommercialCodes(exposedSecret, policy).includes(
      "commercial_research.acquisition_sensitive_material",
    ),
  );

  const bypassClaim = quantitativeCommercialFixture();
  const bypassAcquisition = (bypassClaim.audit.data_acquisitions as Record<string, unknown>[])[0];
  assert.ok(bypassAcquisition);
  bypassAcquisition.access_control_bypassed = true;
  const validator = await createArtifactValidator(repositoryRoot);
  assert.equal(
    validator.validateDocument(
      bypassClaim.audit,
      "artifacts/research-audits/commercial-synthetic.json",
    ).valid,
    false,
  );
});

test("proxy semantics and direct comparisons fail closed when meanings or scopes drift", async () => {
  const policy = await commercialPolicy();
  const proxy = quantitativeCommercialFixture();
  const proxyObservation = (proxy.audit.quantitative_observations as Record<string, unknown>[])[0];
  assert.ok(proxyObservation);
  proxyObservation.interpretation_boundaries = ["not_paid_customer_count"];
  assert.ok(
    quantitativeCommercialCodes(proxy, policy).includes(
      "commercial_research.proxy_semantic_boundary_missing",
    ),
  );

  const comparison = quantitativeCommercialFixture();
  const first = (comparison.audit.quantitative_observations as Record<string, unknown>[])[0];
  assert.ok(first);
  first.comparability = {
    comparison_group: "comparison_rank",
    status: "comparable",
    category: "synthetic category",
    geography_aligned: true,
    period_aligned: true,
    category_aligned: true,
    definition_aligned: true,
    measurement_aligned: true,
    direct_comparison_allowed: true,
    limitations: [],
  };
  const second = structuredClone(first);
  second.observation_id = "observation_rank_other_region";
  second.metric_family = "usage_behavior";
  second.geography = "Canada";
  (comparison.audit.quantitative_observations as Record<string, unknown>[]).push(second);
  const usageCoverage = (comparison.audit.quantitative_coverage as Record<string, unknown>[]).find(
    (coverage) => coverage.metric_family === "usage_behavior",
  );
  assert.ok(usageCoverage);
  Object.assign(usageCoverage, {
    state: "observed",
    observation_ids: ["observation_rank_other_region"],
    query_attempts: [],
    reason: null,
    alternative_metric: null,
  });
  assert.ok(
    quantitativeCommercialCodes(comparison, policy).includes(
      "commercial_research.quantitative_comparison_group_incompatible",
    ),
  );
});

test("coverage follows assigned metric families and substitute types without fabricating values", async () => {
  const policy = await commercialPolicy();
  const completeGap = commercialAudit();
  assert.deepEqual(commercialCodes(completeGap, policy), []);
  assert.deepEqual(completeGap.quantitative_observations, []);
  assert.deepEqual(completeGap.competitive_objects, []);

  const assignedFamily = structuredClone(completeGap);
  assignedFamily.quantitative_coverage = (
    assignedFamily.quantitative_coverage as Record<string, unknown>[]
  ).filter((entry) => entry.metric_family === "demand_scale");
  assignedFamily.competitive_coverage = (
    assignedFamily.competitive_coverage as Record<string, unknown>[]
  ).filter((entry) => entry.competitor_type === "status_quo");
  const assignedDocuments = commercialAuditDocuments(assignedFamily).map((entry) => ({
    ...entry,
    document: structuredClone(entry.document),
  }));
  const assignedTask = assignedDocuments.find((entry) => entry.path === assignedFamily.task_ref);
  assert.ok(assignedTask);
  assignedTask.schemaVersion = "startup_opportunity.research_task.discovery_candidate.current";
  Object.assign(assignedTask.document, {
    source_phase: "candidate_generation",
    commercial_research_requirements: {
      research_stage: "solution_neutral_scan",
      quantitative_competitive_scope: {
        scan_mode: "broad_scan",
        required_metric_families: ["demand_scale"],
        required_competitor_types: ["status_quo"],
        api_is_optional: true,
        provider_allowlist_enforced: false,
        acquisition_execution_owner: "research_agent_or_caller",
        harness_hidden_network_calls: false,
        prohibited_access_methods: [
          "bypass_access_control",
          "circumvent_captcha",
          "circumvent_login",
          "circumvent_paywall",
          "store_credentials",
        ],
      },
      incumbent_response_assignment: structuredClone(completeGap.incumbent_response_assignment),
    },
  });
  assert.deepEqual(validateCommercialResearchContract(assignedDocuments, policy), []);

  const qualitativeDocuments = structuredClone(assignedDocuments);
  const qualitativeTask = qualitativeDocuments.find(
    (entry) => entry.path === assignedFamily.task_ref,
  );
  const qualitativeAudit = qualitativeDocuments.find(
    (entry) => entry.schemaVersion === "startup_opportunity.commercial_research_audit.current",
  );
  assert.ok(qualitativeTask);
  assert.ok(qualitativeAudit);
  const qualitativeScope = (
    qualitativeTask.document.commercial_research_requirements as Record<string, unknown>
  ).quantitative_competitive_scope as Record<string, unknown>;
  qualitativeScope.required_metric_families = [];
  qualitativeScope.required_competitor_types = [];
  qualitativeAudit.document.quantitative_coverage = [];
  qualitativeAudit.document.competitive_coverage = [];
  assert.deepEqual(validateCommercialResearchContract(qualitativeDocuments, policy), []);

  const missingFamily = structuredClone(assignedDocuments);
  const missingFamilyAudit = missingFamily.find(
    (entry) => entry.schemaVersion === "startup_opportunity.commercial_research_audit.current",
  );
  assert.ok(missingFamilyAudit);
  missingFamilyAudit.document.quantitative_coverage = [];
  const missingFamilyIssue = validateCommercialResearchContract(missingFamily, policy).find(
    (issue) => issue.code === "commercial_research.quantitative_coverage_incomplete",
  );
  assert.ok(missingFamilyIssue);
  assert.equal(isBlockingIssue(missingFamilyIssue), true);

  const missingSubject = structuredClone(completeGap);
  missingSubject.covered_direction_ids = [];
  missingSubject.quantitative_coverage = [];
  missingSubject.competitive_coverage = [];
  assert.ok(
    commercialCodes(missingSubject, policy).includes("commercial_research.covered_subject_missing"),
  );

  const missingAttempt = structuredClone(completeGap);
  const unavailable = (missingAttempt.competitive_coverage as Record<string, unknown>[])[0];
  assert.ok(unavailable);
  unavailable.query_attempts = [];
  unavailable.reason = null;
  assert.ok(
    commercialCodes(missingAttempt, policy).includes(
      "commercial_research.competitive_coverage_state_mismatch",
    ),
  );
});

test("unverified regulatory Evidence blocks only when adopted for a current judgment", async () => {
  const policy = await commercialPolicy();
  const evidenceRef = "evidence/records/regulatory-background-synthetic.json";
  const rejected = commercialAudit();
  rejected.evidence_register = [
    {
      evidence_ref: evidenceRef,
      source_kind: "regulatory",
      source_profile: {
        type: "regulatory",
        effective_status: "unknown",
        verified_at: null,
      },
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "market_structure_regulatory",
      content_summary: "Synthetic unverified regulatory background.",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: null,
      data_period_end: null,
      derived_valid_as_of: "2026-08-01",
      freshness_status: "undated",
      coverage_keys: [],
      disposition: "rejected",
      exclusion_reason: "The effective status was not verified.",
    },
  ];
  const rejectedRegulatory = validateCommercialResearchContract(
    [
      {
        path: "artifacts/research-audits/commercial-synthetic.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: rejected,
      },
    ],
    policy,
  ).filter((issue) => issue.code === "commercial_research.regulatory_status_unverified");
  assert.ok(rejectedRegulatory.length > 0);
  assert.ok(rejectedRegulatory.every((issue) => issue.severity === "warning"));

  const adopted = structuredClone(rejected);
  const adoptedSource = (adopted.evidence_register as Record<string, unknown>[])[0];
  assert.ok(adoptedSource);
  adoptedSource.disposition = "adopted";
  adoptedSource.exclusion_reason = null;
  adoptedSource.coverage_keys = ["mechanism"];
  adopted.adopted_source_distribution = {
    total_adopted_sources: 1,
    customer_commercial_count: 0,
    market_structure_count: 1,
    academic_count: 0,
    customer_commercial_percent: 0,
    market_structure_percent: 100,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  adopted.recommendation_ceiling = {
    maximum_decision_tier: "watch",
    reason_codes: [
      "missing_independent_competitor_adoption_data",
      "missing_purchase_or_payment_signal",
      "missing_retention_evidence",
      "regulatory_status_unconfirmed",
    ],
  };
  const adoptedRegulatory = validateCommercialResearchContract(
    [
      {
        path: "artifacts/research-audits/commercial-synthetic.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: adopted,
      },
    ],
    policy,
  ).filter((issue) => issue.code === "commercial_research.regulatory_status_unverified");
  assert.ok(adoptedRegulatory.some((issue) => issue.severity === "error"));
});

test("formal report projections are exact and render fixed unavailable and gap tables", async () => {
  const policy = await commercialPolicy();
  const audit = commercialAudit();
  const auditRef = "artifacts/research-audits/commercial-synthetic.json";
  const projection = commercialReportProjection([{ auditRef, audit }]);
  const report = {
    commercial_research_audit_refs: [auditRef],
    ...projection,
  };
  const documents = [
    ...commercialAuditLineage(audit),
    {
      path: auditRef,
      schemaVersion: "startup_opportunity.commercial_research_audit.current",
      document: audit,
    },
    {
      path: "artifacts/reporting/report-json.r1.json",
      schemaVersion: "startup_opportunity.report.v1",
      document: report,
    },
  ];
  assert.deepEqual(validateCommercialResearchContract(documents, policy), []);

  const drifted = structuredClone(documents);
  const driftedReport = drifted.find(
    (entry) => entry.schemaVersion === "startup_opportunity.report.v1",
  )?.document as Record<string, unknown>;
  (driftedReport.research_coverage_gaps as Record<string, unknown>[]).pop();
  assert.ok(
    validateCommercialResearchContract(drifted, policy)
      .map((issue) => issue.code)
      .includes("commercial_research.report_gap_projection_mismatch"),
  );

  const quantitativeTable = renderQuantitativeSignalTable(projection);
  const competitiveTable = renderCompetitiveSubstituteMatrix(projection);
  const gapTable = renderResearchCoverageGaps(projection);
  assert.match(quantitativeTable, /Metric Family \/ Metric/);
  assert.match(quantitativeTable, /No observed quantitative signal/);
  assert.match(competitiveTable, /Differentiation Gaps/);
  assert.match(competitiveTable, /No observed competitive object/);
  assert.match(gapTable, /Ranking \/ Decision Impact/);
  assert.match(gapTable, /unavailable/);
  assert.match(gapTable, /synthetic-fixture-provider/);
});

test("Chinese commercial tables keep exact refs in structured data but hide internal audit terms", () => {
  const evidenceRef =
    "evidence/records/ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json";
  const source = {
    quantitative_signal_rows: [
      {
        audit_ref: "artifacts/research-audits/synthetic.json",
        observation: {
          subject_id: "china_b2c_education_alternatives_baseline",
          metric_family: "commercial_behavior",
          metric_name: "前期产品价格",
          metric_semantics: "price",
          value: { shape: "point", value: 99, unit: "每月", currency: "CNY" },
          metric_definition: "pre-thesis baseline evidence price",
          geography: "中国大陆",
          period: {
            period_start: null,
            period_end: null,
            as_of: "2026-08-07",
            label: "页面观察",
          },
          measurement_type: "disclosed",
          comparability: {
            status: "not_comparable",
            category: "candidate_evaluation",
            direct_comparison_allowed: false,
          },
          error_uncertainty: "Evidence is not market validation.",
          evidence_refs: [evidenceRef],
        },
      },
    ],
    competitive_substitute_rows: [
      {
        audit_ref: "artifacts/research-audits/synthetic.json",
        competitive_object: {
          competitor_type: "direct_product",
          name: "合成替代",
          target_segment: "成人学习者",
          scenario: "same-run comparison",
          positioning: "baseline alternative",
          pricing_observation_refs: ["obs_price"],
          traction_observation_refs: ["obs_usage"],
          strengths: ["低成本"],
          weaknesses: ["pre-thesis fit unknown"],
          differentiation_gaps: ["unranked_hypothesis"],
          source_refs: [evidenceRef],
        },
      },
    ],
    research_coverage_gaps: [
      {
        audit_ref: "artifacts/research-audits/synthetic.json",
        coverage_kind: "quantitative",
        coverage: {
          subject_id: "candidate_solution_purchase_decision_dossier",
          metric_family: "unit_economics",
          state: "unavailable",
          query_attempts: [
            {
              acquisition_method: "public_api",
              provider: "synthetic-fixture-provider",
              outcome: "not_found",
              reason: "artifact evidence unavailable",
            },
          ],
          reason: "runtime_blocked evidence gap",
          alternative_metric: null,
          decision_impact: "candidate_evaluation remains unranked_hypothesis",
        },
      },
    ],
  };

  const chinese = [
    renderQuantitativeSignalTable(source, true),
    renderCompetitiveSubstituteMatrix(source, true),
    renderResearchCoverageGaps(source, true),
  ].join("\n");
  assert.deepEqual(
    localizedTerminalUserViewIssues({ research_language: "zh-CN", sources: [] }, chinese),
    [],
  );
  assert.doesNotMatch(chinese, /evidence\/records|artifacts\/research-audits/iu);
  assert.match(chinese, /中国大陆 B2C 教育替代基线/);
  assert.match(chinese, /详见结构化审计/);

  const english = renderQuantitativeSignalTable(source);
  assert.match(english, /china_b2c_education_alternatives_baseline/);
  assert.match(english, /evidence\/records/);
});

test("commercial ceilings bind selected subjects instead of unrelated weak candidates", async () => {
  const policy = await commercialPolicy();
  const audit = commercialAudit();
  const rejectedRef = "evidence/records/rejected-candidate-source.json";
  audit.covered_direction_ids = ["opportunity_selected", "opportunity_rejected"];
  audit.evidence_register = [
    {
      evidence_ref: rejectedRef,
      source_kind: "independent",
      source_profile: { type: "other", description: "Retained weak candidate source." },
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "current_pricing",
      content_summary: "The rejected candidate source was not suitable for positive support.",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: null,
      data_period_end: null,
      derived_valid_as_of: "2026-08-01",
      freshness_status: "current",
      coverage_keys: [],
      disposition: "rejected",
      exclusion_reason: "The source did not support the claimed conclusion.",
    },
  ];
  audit.judgments = [
    {
      judgment_id: "judgment_rejected_candidate",
      subject_id: "opportunity_rejected",
      statement: "The rejected candidate should be prioritized.",
      evidence_refs: [rejectedRef],
    },
  ];
  audit.subject_recommendation_ceilings = [
    {
      subject_id: "opportunity_rejected",
      maximum_decision_tier: "watch",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
        "positive_support_not_adopted",
      ],
    },
    {
      subject_id: "opportunity_selected",
      maximum_decision_tier: "investigate_further",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
      ],
    },
  ];
  audit.recommendation_ceiling = {
    maximum_decision_tier: "watch",
    reason_codes: [
      "missing_independent_competitor_adoption_data",
      "missing_purchase_or_payment_signal",
      "missing_retention_evidence",
      "positive_support_not_adopted",
    ],
  };
  const audits = [{ path: "artifacts/research-audits/multi-subject.json", document: audit }];
  const projection = projectCommercialAuditTables(audits);
  const report = {
    ...projection,
    curated_judgment_context: {
      decision_tier: "investigate_further",
      recommended_first_bet: "opportunity_selected",
    },
    top_opportunity_refs: ["opportunity_selected"],
  };
  const documents = [
    ...audits.map((audit) => ({
      path: audit.path,
      schemaVersion: "startup_opportunity.commercial_research_audit.current",
      document: audit.document,
    })),
    {
      path: "artifacts/reporting/report-json.r1.json",
      schemaVersion: "startup_opportunity.report.v1",
      document: report,
    },
  ];
  const selectedCodes = validateCommercialResearchContract(documents, policy).map(
    (issue) => issue.code,
  );
  assert.equal(selectedCodes.includes("terminal_reporting.recommendation_ceiling_exceeded"), false);
  assert.equal(
    selectedCodes.includes("commercial_research.subject_recommendation_ceiling_mismatch"),
    false,
  );
  assert.equal(
    derivePortfolioRecommendationCeiling(
      [
        {
          subject_id: "opportunity_selected",
          maximum_decision_tier: "prioritize",
          reason_codes: [],
        },
        {
          subject_id: "opportunity_rejected",
          maximum_decision_tier: "prioritize",
          reason_codes: [],
        },
      ],
      [{ statement: "Unbound rejected support.", evidence_refs: [rejectedRef] }],
      audit.evidence_register as Record<string, unknown>[],
    ).maximum_decision_tier,
    "watch",
  );

  Object.assign(report.curated_judgment_context as Record<string, unknown>, {
    decision_tier: "prioritize",
    recommended_first_bet: "opportunity_rejected",
  });
  report.top_opportunity_refs = ["opportunity_rejected"];
  const exceededCodes = validateCommercialResearchContract(documents, policy).map(
    (issue) => issue.code,
  );
  assert.ok(exceededCodes.includes("terminal_reporting.recommendation_ceiling_exceeded"));
});

test("concept prioritize is checked against its bound commercial ceiling", async () => {
  const policy = await commercialPolicy();
  const audit = commercialAudit();
  audit.covered_direction_ids = ["concept-hypothesis.json"];
  audit.subject_recommendation_ceilings = [
    {
      subject_id: "concept-hypothesis.json",
      maximum_decision_tier: "investigate_further",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
      ],
    },
  ];
  const auditRef = "artifacts/research-audits/concept.json";
  const projection = projectCommercialAuditTables([{ path: auditRef, document: audit }]);
  const codes = validateCommercialResearchContract(
    [
      {
        path: auditRef,
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: audit,
      },
      {
        path: "artifacts/reporting/concept-report.r1.json",
        schemaVersion: "startup_opportunity.concept_evidence_report.v1",
        document: {
          ...projection,
          concept_hypothesis_ref: "concept-hypothesis.json",
          curated_judgment_context: { assessment_result: "prioritize" },
        },
      },
    ],
    policy,
  ).map((issue) => issue.code);
  assert.ok(codes.includes("terminal_reporting.recommendation_ceiling_exceeded"));
});

test("untraced news is retained but cannot establish observed purchase coverage", async () => {
  const policy = await commercialPolicy();
  const audit = commercialAudit();
  const evidenceRef = "evidence/records/news-purchase-synthetic.json";
  audit.evidence_register = [
    {
      evidence_ref: evidenceRef,
      source_kind: "independent",
      source_profile: {
        type: "news",
        publisher: "Independent Daily",
        published_at: "2026-08-01T00:00:00Z",
        quotation: "A secondary article reports purchase activity.",
        primary_data_traceability_status: "untraced",
        primary_data_ref: null,
      },
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "current_purchase_behavior",
      content_summary: "A secondary article reports purchase activity without primary data.",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: null,
      data_period_end: null,
      derived_valid_as_of: "2026-08-01",
      freshness_status: "current",
      coverage_keys: ["purchase_signal"],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  audit.adopted_source_distribution = {
    total_adopted_sources: 1,
    customer_commercial_count: 1,
    market_structure_count: 0,
    academic_count: 0,
    customer_commercial_percent: 100,
    market_structure_percent: 0,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  (audit.coverage as Record<string, unknown>).purchase_signal = {
    state: "observed",
    content_covered: true,
    evidence_refs: [evidenceRef],
    data_points: [
      { evidence_ref: evidenceRef, aspect: "purchase", fact_or_excerpt: "Reported purchases." },
    ],
    inference: null,
  };
  const codes = commercialCodes(audit, policy);
  assert.ok(codes.includes("commercial_research.coverage_state_mismatch"));
  assert.equal((audit.evidence_register as unknown[]).length, 1);

  const source = (audit.evidence_register as Record<string, unknown>[])[0];
  assert.ok(source);
  const profile = source.source_profile as Record<string, unknown>;
  profile.primary_data_traceability_status = "traced";
  profile.primary_data_ref = null;
  assert.equal(isTraceableDirectSource(source, new Map([[evidenceRef, source]])), false);
  const missingPrimaryIssues = validateCommercialResearchContract(
    [
      {
        path: "artifacts/research-audits/commercial-synthetic.json",
        schemaVersion: String(audit.schema_version),
        document: audit,
      },
    ],
    policy,
  ).filter((issue) => issue.code === "commercial_research.news_primary_traceability_mismatch");
  assert.ok(missingPrimaryIssues.some(isBlockingIssue));

  const primaryRef = "evidence/records/company-price-primary.json";
  const incompatiblePrimary = {
    evidence_ref: primaryRef,
    source_kind: "vendor",
    source_profile: { type: "company_material", supported_public_claims: ["public_pricing"] },
    evidence_character: "vendor_claim",
    independence: "interested_party",
    claim_type: "vendor_public_pricing",
    content_summary: "The company publishes a current price.",
    retrieved_at: "2026-08-04T12:01:00Z",
    published_at: null,
    observed_at: "2026-08-04T12:00:00Z",
    data_period_end: null,
    derived_valid_as_of: "2026-08-04",
    freshness_status: "current",
    coverage_keys: ["pricing"],
    disposition: "adopted",
    exclusion_reason: null,
  };
  profile.primary_data_ref = primaryRef;
  (audit.evidence_register as Record<string, unknown>[]).push(incompatiblePrimary);
  audit.adopted_source_distribution = deriveSourceDistribution(
    audit.evidence_register as Record<string, unknown>[],
    policy,
  );
  const byRef = new Map(
    (audit.evidence_register as Record<string, unknown>[]).map((item) => [
      String(item.evidence_ref),
      item,
    ]),
  );
  assert.equal(isTraceableDirectSource(source, byRef), false);
  assert.ok(
    commercialCodes(audit, policy).includes(
      "commercial_research.news_primary_traceability_mismatch",
    ),
  );
});

test("source concentration follows provider and shared provenance groups", async () => {
  const policy = await commercialPolicy();
  const audit = commercialAudit();
  const refs = ["evidence/records/provider-a.json", "evidence/records/provider-b.json"];
  audit.evidence_register = refs.map((evidenceRef, index) => ({
    evidence_ref: evidenceRef,
    source_kind: "independent",
    source_profile: {
      type: "news",
      publisher: `Provider ${index + 1}`,
      published_at: "2026-08-01T00:00:00Z",
      quotation: "Synthetic provider statement.",
      primary_data_traceability_status: "not_claimed",
      primary_data_ref: null,
    },
    evidence_character: "counterevidence",
    independence: "independent",
    claim_type: "counterevidence",
    content_summary: "Synthetic counterevidence.",
    retrieved_at: "2026-08-04T12:01:00Z",
    published_at: "2026-08-01T00:00:00Z",
    observed_at: null,
    data_period_end: null,
    derived_valid_as_of: "2026-08-01",
    freshness_status: "current",
    coverage_keys: [],
    disposition: "adopted",
    exclusion_reason: null,
  }));
  audit.adopted_source_distribution = {
    total_adopted_sources: 2,
    customer_commercial_count: 2,
    market_structure_count: 0,
    academic_count: 0,
    customer_commercial_percent: 100,
    market_structure_percent: 0,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  assert.equal(
    commercialCodes(audit, policy).includes("commercial_research.source_concentration"),
    false,
  );

  const documents = refs.map((ref) => ({
    path: ref,
    schemaVersion: "startup_opportunity.evidence.assessment.current",
    document: {
      source_assessment: {
        canonical_source_group: ref.endsWith("a.json") ? "provider_a" : "provider_b",
        shared_dataset_group: "shared_dataset_one",
        syndication_group: null,
      },
    },
  }));
  const issues = validateCommercialResearchContract(
    [
      ...documents,
      {
        path: "artifacts/research-audits/concentrated.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: audit,
      },
    ],
    policy,
  );
  assert.ok(issues.some((issue) => issue.code === "commercial_research.source_concentration"));
});

test("claim confidence uses only related gaps while overall ceiling remains conservative", async () => {
  const policy = await commercialPolicy();
  const evidenceRef = "evidence/records/current-price.json";
  const delivery = {
    schema_version: "startup_opportunity.commercial_research_delivery.current",
    run_id: "current-only-commercial-synthetic",
    unit_id: "unit_price",
    audited_at: "2026-08-04T12:10:00Z",
    research_objectives: ["Record a current public price."],
    primary_routes: ["Public price page."],
    search_results: [],
    evidence_sources: [
      {
        evidence_ref: evidenceRef,
        source_kind: "independent",
        source_profile: { type: "other", description: "Independent current price record." },
        evidence_character: "observed_behavior",
        independence: "independent",
        claim_type: "current_pricing",
        content_summary: "The current public price is $20.",
        retrieved_at: "2026-08-04T12:01:00Z",
        published_at: null,
        observed_at: "2026-08-04T12:00:00Z",
        data_period_end: null,
        coverage_keys: [],
        disposition: "adopted",
        exclusion_reason: null,
      },
    ],
    findings: [],
    claims: [
      {
        statement: "The current public price is $20.",
        evidence_refs: [evidenceRef],
        confidence: "high",
      },
    ],
    judgments: [],
    quantitative_observations: [],
    competitive_observations: [],
    incumbent_response_assessments: [],
    unresolved_gaps: [
      {
        coverage_kind: "quantitative",
        subject_id: "concept-price",
        dimension: "retention_outcomes",
        state: "unavailable",
        query_attempts: [],
        reason: "Retention is unavailable.",
        alternative_metric: null,
        decision_impact: "Overall recommendation remains conservative.",
      },
    ],
    limitations: ["Retention is not known."],
    stop_reason: "The assigned route was complete.",
    telemetry_basis: "unavailable",
    query_log_complete: false,
  };
  const taskPath = "tasks/discovery/unit_price.attempt-1.json";
  const task = {
    artifact_type: "startup_opportunity.research_task.discovery_candidate.current",
    artifact_path: taskPath,
    document: {
      schema_version: "startup_opportunity.research_task.discovery_candidate.current",
      source_phase: "candidate_generation",
      target_subject_ref: "concept-price",
      commercial_research_requirements: {
        research_stage: "solution_neutral_scan",
        quantitative_competitive_scope: {
          required_metric_families: ["retention_outcomes"],
          required_competitor_types: [],
        },
        incumbent_response_assignment: {
          analysis_depth: "not_assigned",
          assignment_role: "none",
          subject_refs: [],
          rationale: "Synthetic price task does not assign incumbent response research.",
        },
      },
    },
  };
  const compiled = compileCommercialResearchDelivery(
    delivery,
    taskPath,
    [task, ...incumbentResponseLineage(task)],
    policy,
  ).document;
  const claim = (compiled.claims as Record<string, unknown>[])[0];
  assert.equal(claim?.confidence, "high");
  assert.equal(
    (compiled.recommendation_ceiling as Record<string, unknown>).maximum_decision_tier,
    "investigate_further",
  );
});

test("rejected counterevidence is allowed while rejected positive support is downgraded", async () => {
  const policy = await commercialPolicy();
  const counter = commercialAudit();
  const ref = "evidence/records/rejected-counter.json";
  counter.evidence_register = [
    {
      evidence_ref: ref,
      source_kind: "independent",
      source_profile: { type: "other", description: "Rejected counterevidence fixture." },
      evidence_character: "counterevidence",
      independence: "independent",
      claim_type: "counterevidence",
      content_summary: "The excluded source is retained as a challenge.",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: null,
      data_period_end: null,
      derived_valid_as_of: "2026-08-01",
      freshness_status: "current",
      coverage_keys: ["independent_counterevidence"],
      disposition: "rejected",
      exclusion_reason: "The sample was not representative.",
    },
  ];
  counter.findings = [
    { finding_id: "finding_counter", statement: "The source was excluded.", evidence_refs: [ref] },
  ];
  assert.equal(
    commercialCodes(counter, policy).includes("commercial_research.positive_support_not_adopted"),
    false,
  );

  const positive = structuredClone(counter);
  const source = (positive.evidence_register as Record<string, unknown>[])[0];
  assert.ok(source);
  source.claim_type = "current_pricing";
  source.evidence_character = "independent_report";
  positive.claims = [
    {
      claim_id: "claim_rejected_positive",
      subject_id: "direction_synthetic",
      statement: "The rejected source establishes the current public price.",
      evidence_refs: [ref],
      requested_confidence: "high",
      confidence: "low",
      confidence_ceiling_reasons: [
        "claim_relevant_coverage_incomplete",
        "positive_support_not_adopted",
      ],
    },
  ];
  positive.recommendation_ceiling = {
    maximum_decision_tier: "watch",
    reason_codes: [
      "missing_independent_competitor_adoption_data",
      "missing_purchase_or_payment_signal",
      "missing_retention_evidence",
      "positive_support_not_adopted",
    ],
  };
  positive.subject_recommendation_ceilings = [
    {
      subject_id: "direction_synthetic",
      maximum_decision_tier: "watch",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
        "positive_support_not_adopted",
      ],
    },
  ];
  const positiveIssues = validateCommercialResearchContract(
    commercialAuditDocuments(positive),
    policy,
  );
  assert.ok(
    positiveIssues.some(
      (issue) => issue.code === "commercial_research.positive_support_not_adopted",
    ),
  );
  assert.equal(positiveIssues.some(isBlockingIssue), false);
});

test("formal Claim confidence drift is blocking while rejected support stays publishable", async () => {
  const policy = await commercialPolicy();
  const taskPath = "tasks/discovery/unit_claim_drift.attempt-1.json";
  const task = commercialCompilerTask(taskPath, "direction_claim_drift");
  const evidenceRef = "evidence/records/rejected-claim-drift.json";
  const delivery = commercialDelivery({
    unit_id: "unit_claim_drift",
    evidence_sources: [
      {
        evidence_ref: evidenceRef,
        source_kind: "independent",
        source_profile: { type: "other", description: "Rejected Claim support fixture." },
        evidence_character: "independent_report",
        independence: "independent",
        claim_type: "current_pricing",
        content_summary: "The rejected source reports a price.",
        retrieved_at: "2026-08-04T12:01:00Z",
        published_at: null,
        observed_at: "2026-08-04T12:00:00Z",
        data_period_end: null,
        coverage_keys: ["pricing"],
        disposition: "rejected",
        exclusion_reason: "The source could not be audited.",
      },
    ],
    claims: [
      {
        subject_id: "direction_claim_drift",
        statement: "The rejected source establishes the current price.",
        evidence_refs: [evidenceRef],
        confidence: "high",
      },
    ],
  });
  const compiled = compileCommercialResearchDelivery(
    delivery,
    taskPath,
    [task, ...incumbentResponseLineage(task)],
    policy,
  ).document;
  const claim = (compiled.claims as Record<string, unknown>[])[0];
  assert.ok(claim);
  assert.equal(claim.confidence, "low");
  assert.deepEqual(claim.confidence_ceiling_reasons, ["positive_support_not_adopted"]);
  const documents = [
    ...incumbentResponseLineage(task).map((artifact) => ({
      path: artifact.artifact_path,
      schemaVersion: artifact.artifact_type,
      document: artifact.document,
    })),
    {
      path: taskPath,
      schemaVersion: String(task.document.schema_version),
      document: task.document,
    },
    {
      path: "artifacts/research-audits/claim-drift.json",
      schemaVersion: String(compiled.schema_version),
      document: compiled,
    },
  ];
  const baseline = validateCommercialResearchContract(documents, policy);
  assert.equal(
    baseline.some((issue) => issue.code === "commercial_research.claim_confidence_mismatch"),
    false,
  );
  assert.ok(
    baseline.some((issue) => issue.code === "commercial_research.positive_support_not_adopted"),
  );

  claim.confidence = "high";
  const driftIssues = validateCommercialResearchContract(documents, policy).filter(
    (issue) => issue.code === "commercial_research.claim_confidence_mismatch",
  );
  assert.ok(driftIssues.some(isBlockingIssue));
});

test("compiler derives regulatory verification from the profile including explicit null", async () => {
  const policy = await commercialPolicy();
  const taskPath = "tasks/discovery/unit_regulatory_profile.attempt-1.json";
  const task = commercialCompilerTask(taskPath, "direction_regulatory_profile");
  const delivery = commercialDelivery({
    unit_id: "unit_regulatory_profile",
    evidence_sources: [
      {
        evidence_ref: "evidence/records/regulatory-profile-null.json",
        source_kind: "regulatory",
        source_profile: { type: "regulatory", effective_status: "unknown", verified_at: null },
        evidence_character: "independent_report",
        independence: "independent",
        claim_type: "market_structure_regulatory",
        content_summary: "A regulation was published, but its current effective state is unknown.",
        regulatory_effective_status: "effective",
        regulatory_status_verified_at: "2026-08-04T12:00:00Z",
        retrieved_at: "2026-08-04T12:01:00Z",
        published_at: "2026-07-01T00:00:00Z",
        observed_at: null,
        data_period_end: null,
        coverage_keys: [],
        disposition: "adopted",
        exclusion_reason: null,
      },
    ],
  });
  const compiled = compileCommercialResearchDelivery(
    delivery,
    taskPath,
    [task, ...incumbentResponseLineage(task)],
    policy,
  ).document;
  const source = (compiled.evidence_register as Record<string, unknown>[])[0];
  assert.ok(source);
  assert.equal(source.regulatory_effective_status, "unknown");
  assert.equal(source.regulatory_status_verified_at, null);
  assert.equal(source.freshness_status, "undated");
  assert.equal(
    (compiled.recommendation_ceiling as Record<string, unknown>).maximum_decision_tier,
    "watch",
  );
});

test("compiler retains undeclared Search objectives and emits a non-blocking warning", async () => {
  const policy = await commercialPolicy();
  const taskPath = "tasks/discovery/unit_search_objective.attempt-1.json";
  const task = commercialCompilerTask(taskPath, "direction_search_objective");
  const delivery = commercialDelivery({
    unit_id: "unit_search_objective",
    research_objectives: ["Declared objective"],
    primary_routes: ["Declared route"],
    search_results: [
      {
        objective: "Additional observed objective",
        route: "Recorded exploratory route",
        url: "https://example.invalid/additional-objective",
        title: "Retained rejected result",
        retrieved_at: "2026-08-04T12:01:00Z",
        published_at: "2026-08-01T00:00:00Z",
        observed_at: null,
        data_period_end: null,
        claim_type: "current_market_change",
        commercial_dimensions: ["market_structure"],
        adopted_evidence_ref: null,
        rejection_reason: "The result was useful only as a recorded lead.",
      },
    ],
  });
  const result = compileCommercialResearchDelivery(
    delivery,
    taskPath,
    [task, ...incumbentResponseLineage(task)],
    policy,
  );
  const warning = result.issues.find(
    (issue) => issue.code === "commercial_research.search_objective_unplanned",
  );
  assert.ok(warning);
  assert.equal(isBlockingIssue(warning), false);
  const retained = (result.document.search_log as Record<string, unknown>[]).find((query) =>
    String(query.query).includes("Additional observed objective"),
  );
  assert.ok(retained);
  assert.equal((retained.candidate_results as unknown[]).length, 1);
  assert.ok(
    (result.document.compiler_warnings as Record<string, unknown>[]).some(
      (entry) => entry.code === "commercial_research.search_objective_unplanned",
    ),
  );
});

test("mixed traceable and untraced observations retain both rows without lowering family coverage", async () => {
  const policy = await commercialPolicy();
  const fixture = quantitativeCommercialFixture();
  const strongEvidence = (fixture.audit.evidence_register as Record<string, unknown>[])[0];
  const formalObservation = (
    fixture.audit.quantitative_observations as Record<string, unknown>[]
  )[0];
  const formalAcquisition = (fixture.audit.data_acquisitions as Record<string, unknown>[])[0];
  assert.ok(strongEvidence);
  assert.ok(formalObservation);
  assert.ok(formalAcquisition);
  const {
    observation_id: _observationId,
    acquisition_id: _acquisitionId,
    ...observationInput
  } = formalObservation;
  const acquisition = {
    acquisition_method: formalAcquisition.acquisition_method,
    provider: formalAcquisition.provider,
    endpoint_or_query_redacted: formalAcquisition.endpoint_or_query_redacted,
    access_basis: formalAcquisition.access_basis,
    limitations: formalAcquisition.limitations,
  };
  const weakRef = "evidence/records/untraced-mixed-metric.json";
  const weakEvidence = {
    ...structuredClone(strongEvidence),
    evidence_ref: weakRef,
    source_profile: {
      type: "news",
      publisher: "Secondary Metrics Daily",
      published_at: "2026-08-01T00:00:00Z",
      quotation: "A secondary report repeats the metric.",
      primary_data_traceability_status: "untraced",
      primary_data_ref: null,
    },
    content_summary: "An untraced secondary report repeats the category rank.",
    published_at: "2026-08-01T00:00:00Z",
    observed_at: null,
    data_period_end: null,
  };
  const taskPath = "tasks/discovery/unit_mixed_metric.attempt-1.json";
  const task = commercialCompilerTask(taskPath, "direction_synthetic", ["demand_scale"]);
  const delivery = commercialDelivery({
    unit_id: "unit_mixed_metric",
    evidence_sources: [strongEvidence, weakEvidence],
    quantitative_observations: [
      { ...observationInput, acquisition },
      {
        ...observationInput,
        metric_name: "secondary category rank",
        evidence_refs: [weakRef],
        acquisition: { ...acquisition, provider: "Secondary Metrics Daily" },
        limitations: ["The secondary report does not expose its primary dataset."],
      },
    ],
  });
  const strongEvidenceArtifact = fixture.documents.find(
    (entry) => entry.path === strongEvidence.evidence_ref,
  );
  assert.ok(strongEvidenceArtifact);
  const availableArtifacts = [
    task,
    ...incumbentResponseLineage(task),
    {
      artifact_type: strongEvidenceArtifact.schemaVersion,
      artifact_path: strongEvidenceArtifact.path,
      document: strongEvidenceArtifact.document,
    },
    {
      artifact_type: strongEvidenceArtifact.schemaVersion,
      artifact_path: weakRef,
      document: structuredClone(strongEvidenceArtifact.document),
    },
  ];
  const result = compileCommercialResearchDelivery(delivery, taskPath, availableArtifacts, policy);
  const coverage = (result.document.quantitative_coverage as Record<string, unknown>[])[0];
  assert.ok(coverage);
  assert.equal(coverage.state, "observed");
  assert.equal((coverage.observation_ids as unknown[]).length, 2);
  assert.equal((result.document.quantitative_observations as unknown[]).length, 2);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "commercial_research.secondary_source_traceability_limited",
    ),
  );
  assert.ok(
    (result.document.compiler_warnings as Record<string, unknown>[]).some(
      (entry) => entry.code === "commercial_research.secondary_source_traceability_limited",
    ),
  );
});

test("company material supports matching public facts while portfolio strength stays conservative", async () => {
  const policy = await commercialPolicy();
  const taskPath = "tasks/discovery/unit_company_material.attempt-1.json";
  const task = commercialCompilerTask(taskPath, "direction_company_material");
  const evidenceRef = "evidence/records/company-public-price.json";
  const source = {
    evidence_ref: evidenceRef,
    source_kind: "vendor",
    source_profile: { type: "company_material", supported_public_claims: ["public_pricing"] },
    evidence_character: "vendor_claim",
    independence: "interested_party",
    claim_type: "vendor_public_pricing",
    content_summary: "The company publicly lists a $20 price.",
    retrieved_at: "2026-08-04T12:01:00Z",
    published_at: null,
    observed_at: "2026-08-04T12:00:00Z",
    data_period_end: null,
    coverage_keys: ["pricing"],
    disposition: "adopted",
    exclusion_reason: null,
  };
  const delivery = commercialDelivery({
    unit_id: "unit_company_material",
    evidence_sources: [source],
    claims: [
      {
        subject_id: "direction_company_material",
        statement: "The company publicly lists a $20 price.",
        evidence_refs: [evidenceRef],
        confidence: "high",
      },
    ],
  });
  const exact = compileCommercialResearchDelivery(
    delivery,
    taskPath,
    [task, ...incumbentResponseLineage(task)],
    policy,
  ).document;
  const exactClaim = (exact.claims as Record<string, unknown>[])[0];
  assert.ok(exactClaim);
  assert.equal(exactClaim.confidence, "high");
  assert.ok(Array.isArray((exact.recommendation_ceiling as Record<string, unknown>).reason_codes));
  assert.ok(
    ((exact.recommendation_ceiling as Record<string, unknown>).reason_codes as string[]).includes(
      "independent_cross_validation_missing",
    ),
  );
  assert.notEqual(
    (exact.recommendation_ceiling as Record<string, unknown>).maximum_decision_tier,
    "prioritize",
  );

  const mismatchedDelivery = structuredClone(delivery);
  const mismatchedSource = (mismatchedDelivery.evidence_sources as Record<string, unknown>[])[0];
  assert.ok(mismatchedSource);
  (mismatchedSource.source_profile as Record<string, unknown>).supported_public_claims = [
    "product_capability",
  ];
  const mismatched = compileCommercialResearchDelivery(
    mismatchedDelivery,
    taskPath,
    [task, ...incumbentResponseLineage(task)],
    policy,
  ).document;
  const mismatchedClaim = (mismatched.claims as Record<string, unknown>[])[0];
  assert.ok(mismatchedClaim);
  assert.equal(mismatchedClaim.confidence, "low");
  const scopeIssues = validateCommercialResearchContract(
    [
      ...incumbentResponseLineage(task).map((artifact) => ({
        path: artifact.artifact_path,
        schemaVersion: artifact.artifact_type,
        document: artifact.document,
      })),
      {
        path: taskPath,
        schemaVersion: String(task.document.schema_version),
        document: task.document,
      },
      {
        path: "artifacts/research-audits/company-material.json",
        schemaVersion: String(mismatched.schema_version),
        document: mismatched,
      },
    ],
    policy,
  ).filter((issue) => issue.code === "commercial_research.vendor_claim_scope_invalid");
  assert.ok(scopeIssues.length > 0);
  assert.ok(scopeIssues.every((issue) => !isBlockingIssue(issue)));
});

test("all deterministic scaffold kinds are schema-valid and preserve runtime boundaries", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const modes = ["opportunity_discovery", "concept_evidence_assessment"] as const;
  const kinds = [
    "intake",
    "planning",
    "task",
    "dispatch",
    "readiness",
    "gap",
    "decision",
    "terminal_report_source",
  ] as const;
  for (const mode of modes) {
    for (const kind of kinds) {
      const runId = `current-only-scaffold-${mode}-synthetic`;
      const result = buildArtifactScaffold(
        {
          schema_version: "startup_opportunity.scaffold_request.current",
          scaffold_id: `scaffold_${mode}_${kind}_synthetic`,
          kind,
          run_id: runId,
          mode,
          created_at: "2026-08-04T12:00:00Z",
          scope_confirmation: {
            geography: "United States",
            customer_model: "b2c",
            target_users: ["synthetic user"],
            decision_goal: "decide whether to continue synthetic research",
            research_language: "en-US",
            user_confirmed: true,
          },
        },
        validator,
      );
      assert.equal(result.schema_valid, true);
      assert.equal(result.semantic_judgment_generated, false);
      assert.equal(result.working_directory, `dist/research-working/${runId}`);
      const compilation = result.compilation_request as Record<string, unknown>;
      const artifacts = compilation.artifacts as Record<string, unknown>[];
      assert.equal(artifacts.length, 1);
      assert.equal(
        validator.validateDocument(artifacts[0]?.document, String(artifacts[0]?.artifact_path))
          .valid,
        true,
      );
    }
  }

  const dispatch = buildArtifactScaffold(
    {
      schema_version: "startup_opportunity.scaffold_request.current",
      scaffold_id: "scaffold_dispatch_tokens_synthetic",
      kind: "dispatch",
      run_id: "current-only-scaffold-synthetic",
      mode: "opportunity_discovery",
      created_at: "2026-08-04T12:00:00Z",
      scope_confirmation: {
        geography: "United States",
        customer_model: "b2c",
        target_users: ["synthetic user"],
        decision_goal: "decide whether to continue synthetic research",
        research_language: "en-US",
        user_confirmed: true,
      },
    },
    validator,
  );
  const compilation = dispatch.compilation_request as Record<string, unknown>;
  const artifact = (compilation.artifacts as Record<string, unknown>[])[0];
  const document = artifact?.document as Record<string, unknown>;
  assert.equal(artifact?.producer_role, "harness");
  assert.equal(document.dispatch_mode, "parallel_immediate");
  assert.equal(document.agent_dispatch_performed, false);
});

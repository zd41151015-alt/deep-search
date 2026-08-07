import { canonicalContentHash } from "../../harness/src/artifact-store/canonical.js";
import { projectCommercialAuditTables } from "../../harness/src/reporting/commercial-report-tables.js";

export const SYNTHETIC_METRIC_FAMILIES = [
  "demand_scale",
  "usage_behavior",
  "commercial_behavior",
  "growth_change",
  "competitive_intensity",
  "distribution",
  "retention_outcomes",
  "unit_economics",
] as const;

export const SYNTHETIC_COMPETITOR_TYPES = [
  "direct_product",
  "adjacent_product",
  "service",
  "platform",
  "manual_workaround",
  "status_quo",
  "non_consumption",
] as const;

export function unavailableQuantitativeCompetitiveCoverage(
  subjectIds: readonly string[],
  attemptedAt: string,
): Record<string, unknown> {
  return {
    data_acquisitions: [],
    quantitative_observations: [],
    quantitative_coverage: subjectIds.flatMap((subjectId) =>
      SYNTHETIC_METRIC_FAMILIES.map((metricFamily) => ({
        subject_id: subjectId,
        metric_family: metricFamily,
        state: "unavailable",
        observation_ids: [],
        query_attempts: [
          {
            attempt_id: `attempt_quant_${subjectId}_${metricFamily}`,
            acquisition_method: "webpage",
            provider: "synthetic-fixture-provider",
            endpoint_or_query_redacted: `synthetic ${subjectId} ${metricFamily} query`,
            attempted_at: attemptedAt,
            outcome: "no_data",
            reason: "Synthetic fixture provides no market data.",
            alternative_metric: "No defensible alternative metric was available.",
            decision_impact: "The metric remains unavailable and cannot support ranking.",
          },
        ],
        reason: "Synthetic fixture provides no market data.",
        alternative_metric: "No defensible alternative metric was available.",
        decision_impact: "The metric remains unavailable and cannot support ranking.",
      })),
    ),
    competitive_objects: [],
    competitive_coverage: subjectIds.flatMap((subjectId) =>
      SYNTHETIC_COMPETITOR_TYPES.map((competitorType) => ({
        subject_id: subjectId,
        competitor_type: competitorType,
        state: "unavailable",
        competitive_object_ids: [],
        query_attempts: [
          {
            attempt_id: `attempt_comp_${subjectId}_${competitorType}`,
            acquisition_method: "webpage",
            provider: "synthetic-fixture-provider",
            endpoint_or_query_redacted: `synthetic ${subjectId} ${competitorType} query`,
            attempted_at: attemptedAt,
            outcome: "no_data",
            reason: "Synthetic fixture provides no competitive market data.",
            alternative_metric: "No defensible substitute coverage proxy was available.",
            decision_impact:
              "The competitive dimension remains unavailable and limits differentiation claims.",
          },
        ],
        reason: "Synthetic fixture provides no competitive market data.",
        alternative_metric: "No defensible substitute coverage proxy was available.",
        decision_impact:
          "The competitive dimension remains unavailable and limits differentiation claims.",
      })),
    ),
  };
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];
}

function unknownIncumbentResponse(subjectId: string): Record<string, unknown> {
  const rationale =
    "No responder-specific assessment was delivered for the assigned subject; the reference risk remains unknown and does not change ranking, confidence, ceilings, or publication.";
  const unknown = () => ({ level: "unknown", rationale });
  return {
    subject_id: subjectId,
    analysis_state: "unknown",
    responder_identity: null,
    responder_category: null,
    control_point: null,
    response_modes: [],
    capability_adjacency: unknown(),
    response_cost: {
      implementation: unknown(),
      operational: unknown(),
      compliance: unknown(),
      data: unknown(),
      distribution: unknown(),
    },
    incentive: {
      level: "unknown",
      drivers: [],
      disincentives: [],
      cannibalization: rationale,
      rationale,
    },
    plausible_response_horizon: { band: "unknown", rationale },
    distribution_leverage: { level: "unknown", control_points: [], rationale },
    thesis_coverage: {
      scope: "unknown",
      covered_elements: [],
      uncovered_elements: [],
      rationale,
    },
    residual_differentiation: {
      overall_strength: "unknown",
      dimensions: [],
      rationale,
    },
    supporting_evidence_refs: [],
    opposing_evidence_refs: [],
    background_evidence_refs: [],
    inference_boundary: rationale,
    confidence: "unknown",
    uncertainty: rationale,
    unknowns: [
      "Potential responder identity, ability, incentive, and response horizon are unknown.",
    ],
    data_gaps: ["No incumbent absorption and response Evidence was delivered."],
    strategic_implication:
      "Treat incumbent response risk as an unresolved strategic question; no automatic candidate or recommendation action follows.",
  };
}

export function unavailableCommercialResearchAudit(input: {
  readonly runId: string;
  readonly taskRef: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly coveredSubjectIds: readonly string[];
  readonly auditedAt: string;
  readonly executionPlanRef?: string | null;
  readonly dispatchTaskRef?: string | null;
}): Record<string, unknown> {
  const requirements = input.task.commercial_research_requirements as Record<string, unknown>;
  const allocation = requirements.resource_allocation as Record<string, unknown>;
  const incumbentAssignment = requirements.incumbent_response_assignment as Record<string, unknown>;
  const unitId = String(input.task.unit_id);
  const coveredSubjectIds = [...input.coveredSubjectIds].sort();
  const uncovered = [
    "recent_user_language",
    "purchase_signal",
    "alternatives_pricing_usage",
    "distribution_channel",
    "independent_counterevidence",
  ];
  const quantitativeCompetitive = unavailableQuantitativeCompetitiveCoverage(
    coveredSubjectIds,
    input.auditedAt,
  );
  const incumbentResponseAssessments =
    incumbentAssignment.analysis_depth === "not_assigned"
      ? []
      : coveredSubjectIds.map((subjectId) => {
          const semantic = unknownIncumbentResponse(subjectId);
          return {
            assessment_id: `incumbent_response_${canonicalContentHash([unitId, semantic]).slice(
              "sha256:".length,
              "sha256:".length + 24,
            )}`,
            analysis_depth: incumbentAssignment.analysis_depth,
            semantic,
          };
        });
  const incumbentResponseCoverage = incumbentResponseAssessments.map((assessment) => {
    const semantic = assessment.semantic as Record<string, unknown>;
    return {
      subject_id: semantic.subject_id,
      analysis_depth: incumbentAssignment.analysis_depth,
      assignment_role: incumbentAssignment.assignment_role,
      state: "unknown",
      assessment_ids: [assessment.assessment_id],
      reason: "Assigned incumbent absorption and response risk remains unknown.",
      data_gaps: semantic.data_gaps,
      decision_impact: "Context only; no automatic decision effect.",
      automatic_effects: {
        ranking_eligibility: false,
        claim_confidence: false,
        recommendation_ceiling: false,
        artifact_publication: false,
      },
    };
  });
  return {
    schema_version: "startup_opportunity.commercial_research_audit.current",
    audit_id: `commercial_audit_${unitId}`,
    run_id: input.runId,
    unit_id: unitId,
    execution_plan_ref: input.executionPlanRef ?? null,
    dispatch_task_ref: input.dispatchTaskRef ?? null,
    task_ref: input.taskRef,
    covered_direction_ids: coveredSubjectIds,
    research_stage: requirements.research_stage,
    audited_at: input.auditedAt,
    planned_resource_allocation: allocation,
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
    research_objectives: ["Record honest commercial coverage limits for this synthetic fixture."],
    primary_routes: ["Synthetic fixture input; no external research route was executed."],
    findings: [],
    claims: [],
    judgments: [],
    search_log: records(requirements.planned_queries).map((query, index) => ({
      query_id: `query_${unitId}_${index + 1}`,
      query: query.query,
      searched_at: input.auditedAt,
      commercial_dimensions: query.commercial_dimensions,
      candidate_results: [],
    })),
    search_closure: {
      closure_id: `search_closure_${unitId}`,
      lane_kind: "external_research",
      outcome: "evidence_insufficient",
      query_log_complete: false,
      telemetry_basis: "unavailable",
      remaining_gaps: [
        ...uncovered,
        ...incumbentResponseCoverage.flatMap((coverage) =>
          (coverage.data_gaps as string[]).map(
            (gap) => `Incumbent response coverage for ${String(coverage.subject_id)}: ${gap}`,
          ),
        ),
      ],
      termination_reason: "Synthetic fixture found no defensible quantitative or competitive data.",
    },
    evidence_register: [],
    ...quantitativeCompetitive,
    incumbent_response_assignment: structuredClone(incumbentAssignment),
    incumbent_response_assessments: incumbentResponseAssessments,
    incumbent_response_coverage: incumbentResponseCoverage,
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
    recommendation_ceiling: {
      maximum_decision_tier: "investigate_further",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
      ],
    },
    subject_recommendation_ceilings: coveredSubjectIds.map((subjectId) => ({
      subject_id: subjectId,
      maximum_decision_tier: "investigate_further",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
      ],
    })),
    compiler_warnings: [],
    limitations: ["SYNTHETIC contract audit; no market research was performed."],
  };
}

export function commercialReportProjection(
  audits: readonly {
    readonly auditRef: string;
    readonly audit: Readonly<Record<string, unknown>>;
  }[],
): Record<string, unknown> {
  return {
    ...projectCommercialAuditTables(
      audits.map(({ auditRef, audit }) => ({
        path: auditRef,
        document: audit as Record<string, unknown>,
      })),
    ),
    gate_warnings: audits.flatMap(({ audit }) => records(audit.compiler_warnings)),
  };
}

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

export function unavailableCommercialResearchAudit(input: {
  readonly runId: string;
  readonly taskRef: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly coveredSubjectIds: readonly string[];
  readonly auditedAt: string;
}): Record<string, unknown> {
  const requirements = input.task.commercial_research_requirements as Record<string, unknown>;
  const allocation = requirements.resource_allocation as Record<string, unknown>;
  const unitId = String(input.task.unit_id);
  const uncovered = [
    "recent_user_language",
    "purchase_signal",
    "alternatives_pricing_usage",
    "distribution_channel",
    "independent_counterevidence",
  ];
  return {
    schema_version: "startup_opportunity.commercial_research_audit.current",
    audit_id: `commercial_audit_${unitId}`,
    run_id: input.runId,
    unit_id: unitId,
    execution_plan_ref: null,
    dispatch_task_ref: null,
    task_ref: input.taskRef,
    covered_direction_ids: [...input.coveredSubjectIds],
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
      remaining_gaps: uncovered,
      termination_reason: "Synthetic fixture found no defensible quantitative or competitive data.",
    },
    evidence_register: [],
    ...unavailableQuantitativeCompetitiveCoverage(input.coveredSubjectIds, input.auditedAt),
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
    commercial_research_audit_refs: audits.map(({ auditRef }) => auditRef),
    quantitative_signal_rows: audits.flatMap(({ auditRef, audit }) =>
      records(audit.quantitative_observations).map((observation) => ({
        audit_ref: auditRef,
        observation,
      })),
    ),
    competitive_substitute_rows: audits.flatMap(({ auditRef, audit }) =>
      records(audit.competitive_objects).map((competitiveObject) => ({
        audit_ref: auditRef,
        competitive_object: competitiveObject,
      })),
    ),
    research_coverage_gaps: audits.flatMap(({ auditRef, audit }) => [
      ...records(audit.quantitative_coverage)
        .filter((coverage) => coverage.state !== "observed")
        .map((coverage) => ({ audit_ref: auditRef, coverage_kind: "quantitative", coverage })),
      ...records(audit.competitive_coverage)
        .filter((coverage) => coverage.state !== "observed")
        .map((coverage) => ({ audit_ref: auditRef, coverage_kind: "competitive", coverage })),
    ]),
  };
}

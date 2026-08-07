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

const SYNTHETIC_BUSINESS_DIMENSIONS = [
  "recent_user_language",
  "purchase_signal",
  "alternatives_pricing_usage",
  "distribution_channel",
  "independent_counterevidence",
] as const;

export function unavailableSubjectAssessments(
  subjectIds: readonly string[],
  quantitativeCompetitive: Readonly<Record<string, unknown>>,
  limitations: readonly string[],
  evidenceRefs: readonly string[] = [],
): readonly Record<string, unknown>[] {
  return subjectIds.map((subjectId) => ({
    subject_id: subjectId,
    evidence_refs: [...evidenceRefs],
    coverage: Object.fromEntries(
      SYNTHETIC_BUSINESS_DIMENSIONS.map((key) => [
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
    uncovered_business_dimensions: [...SYNTHETIC_BUSINESS_DIMENSIONS],
    quantitative_coverage: records(quantitativeCompetitive.quantitative_coverage).filter(
      (row) => row.subject_id === subjectId,
    ),
    competitive_coverage: records(quantitativeCompetitive.competitive_coverage).filter(
      (row) => row.subject_id === subjectId,
    ),
    wave1_signals: { demand: false, buyer: false, purchase: false },
    ranking_eligibility: "unranked_hypothesis",
    recommendation_ceiling: {
      maximum_decision_tier: "investigate_further",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
      ],
    },
    conflict_evidence_refs: [],
    limitations: [...limitations].sort(),
  }));
}

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
  const limitations = ["SYNTHETIC contract audit; no market research was performed."];
  return {
    schema_version: "startup_opportunity.commercial_research_audit.current",
    audit_id: `commercial_audit_${unitId}`,
    run_id: input.runId,
    unit_id: unitId,
    execution_plan_ref: null,
    dispatch_task_ref: null,
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
      remaining_gaps: uncovered.flatMap((dimension) =>
        coveredSubjectIds.map((subjectId) => ({
          subject_ids: [subjectId],
          subject_binding_basis:
            coveredSubjectIds.length === 1 ? "single_subject_auto" : "explicit",
          coverage_kind: "business",
          dimension,
          state: "unavailable",
          reason: `No direct ${dimension} material was available in the synthetic fixture.`,
          alternative_metric: null,
          decision_impact:
            "The subject remains unranked until this business dimension is observed.",
          query_attempts: [],
          task_ref: input.taskRef,
          audit_ref: String(requirements.commercial_audit_output_path),
        })),
      ),
      termination_reason: "Synthetic fixture found no defensible quantitative or competitive data.",
    },
    evidence_register: [],
    ...quantitativeCompetitive,
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
    subject_assessments: unavailableSubjectAssessments(
      coveredSubjectIds,
      quantitativeCompetitive,
      limitations,
    ),
    compiler_warnings: [],
    limitations,
  };
}

export function commercialReportProjection(
  audits: readonly {
    readonly auditRef: string;
    readonly audit: Readonly<Record<string, unknown>>;
  }[],
  tasks: readonly {
    readonly taskRef: string;
    readonly task: Readonly<Record<string, unknown>>;
  }[] = [],
  documentsByPath: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): Record<string, unknown> {
  return {
    ...projectCommercialAuditTables(
      audits.map(({ auditRef, audit }) => ({
        path: auditRef,
        document: audit as Record<string, unknown>,
      })),
      tasks.map(({ taskRef, task }) => ({
        path: taskRef,
        document: task as Record<string, unknown>,
      })),
      documentsByPath,
    ),
    gate_warnings: audits.flatMap(({ audit }) => records(audit.compiler_warnings)),
  };
}

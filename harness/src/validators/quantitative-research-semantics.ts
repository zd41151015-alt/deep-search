export type QuantitativeDecisionGrade = "decision_grade" | "directional_proxy" | "context_only";

export interface QuantitativeDecisionUse {
  readonly grade: QuantitativeDecisionGrade;
  readonly direct_metric_semantics: boolean;
  readonly direct_comparison_allowed: boolean;
  readonly basis_codes: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const DIRECT_SEMANTICS_BY_FAMILY: Readonly<Record<string, ReadonlySet<string>>> = {
  demand_scale: new Set(["market_size"]),
  usage_behavior: new Set(["active_users", "usage_frequency"]),
  commercial_behavior: new Set([
    "transaction_count",
    "purchase_count",
    "paid_customers",
    "revenue",
    "price",
  ]),
  growth_change: new Set(["growth_rate"]),
  competitive_intensity: new Set(["competitor_count"]),
  distribution: new Set(["distribution_reach"]),
  retention_outcomes: new Set(["retention_rate"]),
  unit_economics: new Set(["unit_cost", "unit_margin"]),
};

const PROXY_SEMANTICS = new Set([
  "search_interest",
  "rank",
  "rating_count",
  "review_count",
  "downloads",
  "paid_customers_estimate",
  "revenue_estimate",
  "outcome_rate",
  "other",
]);

const CLAIM_TYPES_BY_FAMILY: Readonly<Record<string, ReadonlySet<string>>> = {
  demand_scale: new Set(["current_market_change"]),
  usage_behavior: new Set(["current_competitor_usage"]),
  commercial_behavior: new Set(["current_purchase_behavior", "current_pricing"]),
  growth_change: new Set(["current_market_change"]),
  competitive_intensity: new Set(["current_competitor_offering"]),
  distribution: new Set(["current_distribution"]),
  retention_outcomes: new Set(["current_retention"]),
  unit_economics: new Set(["current_pricing"]),
};

export function deriveQuantitativeDecisionUse(
  observation: Readonly<Record<string, unknown>>,
  evidenceByRef: ReadonlyMap<string, Record<string, unknown>>,
  traceableDirectSource: (
    source: Readonly<Record<string, unknown>>,
    evidenceByRef: ReadonlyMap<string, Record<string, unknown>>,
  ) => boolean,
): QuantitativeDecisionUse {
  const family = String(observation.metric_family ?? "");
  const semantics = String(observation.metric_semantics ?? "");
  const measurement = String(observation.measurement_type ?? "");
  const comparability = isRecord(observation.comparability) ? observation.comparability : {};
  const comparisonGroupDeclared = typeof comparability.comparison_group === "string";
  const directComparisonAllowed = comparability.direct_comparison_allowed === true;
  const directMetricSemantics = DIRECT_SEMANTICS_BY_FAMILY[family]?.has(semantics) === true;
  const exactEvidence = strings(observation.evidence_refs)
    .map((ref) => evidenceByRef.get(ref))
    .filter((source): source is Record<string, unknown> => source !== undefined);
  const currentTraceableEvidence = exactEvidence.some(
    (source) =>
      source.disposition === "adopted" &&
      source.freshness_status === "current" &&
      strings(source.subject_ids).includes(String(observation.subject_id)) &&
      traceableDirectSource(source, evidenceByRef),
  );
  const semanticallyMatchedEvidence = exactEvidence.some(
    (source) =>
      source.disposition === "adopted" &&
      source.freshness_status === "current" &&
      strings(source.subject_ids).includes(String(observation.subject_id)) &&
      CLAIM_TYPES_BY_FAMILY[family]?.has(String(source.claim_type)) === true &&
      traceableDirectSource(source, evidenceByRef),
  );
  const directMeasurement = ["direct_measurement", "disclosed"].includes(measurement);
  const comparisonUsable = !comparisonGroupDeclared || directComparisonAllowed;
  const structurallyComplete =
    typeof observation.metric_definition === "string" &&
    typeof observation.geography === "string" &&
    typeof observation.sample_or_population === "string" &&
    isRecord(observation.period) &&
    isRecord(observation.value) &&
    typeof observation.value.unit === "string";
  const basisCodes = [
    directMetricSemantics ? "metric_semantics_direct" : "metric_semantics_proxy_or_mismatch",
    directMeasurement ? "measurement_direct_or_disclosed" : "measurement_estimated_or_proxy",
    currentTraceableEvidence
      ? "current_exact_traceable_evidence"
      : "current_exact_traceable_evidence_missing",
    semanticallyMatchedEvidence
      ? "evidence_claim_matches_metric_family"
      : "evidence_claim_metric_mismatch",
    comparisonUsable ? "comparison_scope_usable" : "comparison_scope_incompatible",
    structurallyComplete ? "metric_scope_defined" : "metric_scope_incomplete",
  ];
  const decisionGrade =
    directMetricSemantics &&
    !PROXY_SEMANTICS.has(semantics) &&
    directMeasurement &&
    semanticallyMatchedEvidence &&
    comparisonUsable &&
    structurallyComplete;
  const hasApplicableRetainedEvidence = exactEvidence.some(
    (source) =>
      source.disposition === "adopted" &&
      strings(source.subject_ids).includes(String(observation.subject_id)),
  );
  return {
    grade: decisionGrade
      ? "decision_grade"
      : hasApplicableRetainedEvidence
        ? "directional_proxy"
        : "context_only",
    direct_metric_semantics: directMetricSemantics,
    direct_comparison_allowed: directComparisonAllowed,
    basis_codes: basisCodes.sort(),
  };
}

export function deriveMarketPriorityAndCommercialReadiness(input: {
  readonly coverage: Readonly<Record<string, unknown>>;
  readonly quantitativeCoverage: readonly Record<string, unknown>[];
  readonly quantitativeObservations: readonly Record<string, unknown>[];
  readonly competitiveCoverage: readonly Record<string, unknown>[];
}): Readonly<Record<string, unknown>> {
  const observed = (key: string): boolean =>
    isRecord(input.coverage[key]) && input.coverage[key]?.state === "observed";
  const decisionGradeFamilies = new Set(
    input.quantitativeObservations
      .filter(
        (observation) =>
          isRecord(observation.decision_use) && observation.decision_use.grade === "decision_grade",
      )
      .map((observation) => String(observation.metric_family)),
  );
  const directionalFamilies = new Set(
    input.quantitativeObservations
      .filter(
        (observation) =>
          isRecord(observation.decision_use) &&
          observation.decision_use.grade === "directional_proxy",
      )
      .map((observation) => String(observation.metric_family)),
  );
  const demandDecisionGrade = ["demand_scale", "growth_change"].some((family) =>
    decisionGradeFamilies.has(family),
  );
  const demandDirectional = ["demand_scale", "growth_change"].some((family) =>
    directionalFamilies.has(family),
  );
  const competitionDisposed =
    input.competitiveCoverage.length > 0 &&
    input.competitiveCoverage.every((row) =>
      ["observed", "not_applicable"].includes(String(row.state)),
    );
  const marketPriority =
    (demandDecisionGrade || demandDirectional) && competitionDisposed
      ? "high"
      : demandDecisionGrade || demandDirectional || observed("recent_user_language")
        ? "medium"
        : "low";
  const candidatePricing = input.quantitativeObservations.some(
    (observation) =>
      observation.metric_semantics === "price" &&
      isRecord(observation.decision_use) &&
      observation.decision_use.grade === "decision_grade",
  );
  const readinessChecks = {
    candidate_purchase_or_commitment: observed("purchase_signal"),
    acquisition_or_distribution: observed("distribution_channel"),
    pricing: candidatePricing,
    retention_or_usage:
      decisionGradeFamilies.has("retention_outcomes") ||
      decisionGradeFamilies.has("usage_behavior"),
    unit_economics: decisionGradeFamilies.has("unit_economics"),
  };
  const readyCount = Object.values(readinessChecks).filter(Boolean).length;
  return {
    market_research_priority: {
      level: marketPriority,
      basis_codes: [
        ...(demandDecisionGrade ? ["decision_grade_demand_signal"] : []),
        ...(demandDirectional ? ["directional_demand_signal"] : []),
        ...(observed("recent_user_language") ? ["current_user_language"] : []),
        ...(competitionDisposed ? ["competitive_scope_disposed"] : []),
        ...(marketPriority === "low" ? ["market_priority_signal_limited"] : []),
      ].sort(),
    },
    commercial_validation_readiness: {
      level: readyCount === 5 ? "ready" : readyCount > 0 ? "partial" : "not_ready",
      satisfied_dimensions: Object.entries(readinessChecks)
        .filter(([, satisfied]) => satisfied)
        .map(([dimension]) => dimension)
        .sort(),
      missing_dimensions: Object.entries(readinessChecks)
        .filter(([, satisfied]) => !satisfied)
        .map(([dimension]) => dimension)
        .sort(),
    },
  };
}

import { canonicalJson } from "../artifact-store/canonical.js";
import type { ValidationIssue } from "./schema-bundle.js";

export interface CommercialResearchDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
}

export interface CommercialResearchPolicy {
  readonly default_resource_allocation: Readonly<Record<string, unknown>>;
  readonly resource_allocation_enforcement: "planning_guidance_only";
  readonly actual_distribution_basis: "adopted_evidence_register_records";
  readonly customer_commercial_percent_range: readonly number[];
  readonly market_structure_percent_range: readonly number[];
  readonly academic_percent_maximum: number;
  readonly ranking_coverage_keys: readonly string[];
  readonly academic_allowed_coverage_keys: readonly string[];
  readonly vendor_claim_requires_cross_validation: boolean;
  readonly claim_freshness_windows_days: Readonly<Record<string, number>>;
  readonly historical_claim_types: readonly string[];
  readonly solution_neutral_stage: string;
  readonly solution_specific_stage: string;
  readonly wave1_early_stop_signal_keys: readonly string[];
}

const REQUIRED_RANKING_KEYS = [
  "recent_user_language",
  "purchase_signal",
  "alternatives_pricing_usage",
  "distribution_channel",
  "independent_counterevidence",
] as const;

const ACADEMIC_KEYS = new Set(["mechanism", "effect_boundary", "counterevidence"]);
const VENDOR_CLAIM_TYPES = new Set([
  "vendor_public_pricing",
  "vendor_public_product",
  "vendor_positioning",
  "vendor_statement",
]);

const CLAIM_ASPECTS: Readonly<Record<string, readonly string[]>> = {
  recent_user_language: ["user_language"],
  current_purchase_behavior: ["buyer", "purchase"],
  current_distribution: ["distribution"],
  current_competitor_usage: ["alternative", "usage"],
  current_retention: ["retention"],
  current_pricing: ["pricing"],
  current_product_capability: ["alternative"],
  current_competitor_offering: ["alternative"],
  vendor_public_pricing: ["pricing"],
  vendor_public_product: ["alternative"],
  counterevidence: ["counterevidence"],
};

const TASK_STAGE_BY_VERSION = new Map([
  ["startup_opportunity.research_task.assessment.current", "solution_specific_evaluation"],
  ["startup_opportunity.research_task.discovery_candidate.current", "solution_neutral_scan"],
  [
    "startup_opportunity.research_task.discovery_evaluation.current",
    "solution_specific_evaluation",
  ],
]);

export const QUANTITATIVE_METRIC_FAMILIES = [
  "demand_scale",
  "usage_behavior",
  "commercial_behavior",
  "growth_change",
  "competitive_intensity",
  "distribution",
  "retention_outcomes",
  "unit_economics",
] as const;

export const COMPETITIVE_OBJECT_TYPES = [
  "direct_product",
  "adjacent_product",
  "service",
  "platform",
  "manual_workaround",
  "status_quo",
  "non_consumption",
] as const;

const PROXY_INTERPRETATION_BOUNDARIES = [
  "not_purchase_count",
  "not_paid_customer_count",
  "not_market_validation",
] as const;

const ESTIMATE_SEMANTICS = new Set(["paid_customers_estimate", "revenue_estimate"]);
const PROXY_LIKE_SEMANTICS = new Set([
  "search_interest",
  "rank",
  "rating_count",
  "review_count",
  "downloads",
  "active_users",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function issue(
  code: string,
  path: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "commercial_research",
    instancePath: path,
    schemaPath: "",
    message,
    details,
  };
}

function dateOnly(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value.slice(0, 10);
}

function sameStringSet(left: unknown, right: readonly string[]): boolean {
  return canonicalJson([...strings(left)].sort()) === canonicalJson([...right].sort());
}

function containsUnredactedSensitiveMaterial(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/\b(?:authorization|cookie|set-cookie)\s*:/iu.test(value) || /\bbearer\s+\S+/iu.test(value)) {
    return true;
  }
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Keep the caller-supplied text when it is not URI encoded.
  }
  return /(?:^|[?&;\s])(?:api[_-]?key|access[_-]?token|token|secret|password|session(?:id)?)=(?!(?:\[?redacted\]?|<redacted>)(?:[&;\s]|$))[^&;\s]+/iu.test(
    decoded,
  );
}

export function deriveValidAsOf(source: Readonly<Record<string, unknown>>): string | null {
  if (source.claim_type === "market_structure_regulatory") {
    return (
      dateOnly(source.regulatory_status_verified_at) ??
      dateOnly(source.observed_at) ??
      dateOnly(source.published_at)
    );
  }
  return (
    dateOnly(source.data_period_end) ??
    dateOnly(source.observed_at) ??
    dateOnly(source.published_at)
  );
}

function wholeDaysBetween(earlier: string, later: string): number {
  return Math.floor((Date.parse(later) - Date.parse(earlier)) / 86_400_000);
}

function deriveFreshness(
  source: Readonly<Record<string, unknown>>,
  auditedAt: unknown,
  policy: CommercialResearchPolicy,
): "current" | "historical" | "undated" {
  const validAsOf = deriveValidAsOf(source);
  if (validAsOf === null) return "undated";
  const claimType = String(source.claim_type ?? "");
  if (policy.historical_claim_types.includes(claimType)) return "historical";
  if (
    claimType === "market_structure_regulatory" &&
    dateOnly(source.regulatory_status_verified_at) === null
  ) {
    return "undated";
  }
  const windowDays = policy.claim_freshness_windows_days[claimType];
  const auditDate = dateOnly(auditedAt);
  if (windowDays === undefined || auditDate === null) return "historical";
  const ageDays = wholeDaysBetween(validAsOf, auditDate);
  return ageDays >= 0 && ageDays <= windowDays ? "current" : "historical";
}

function percentage(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 10_000) / 100;
}

function sourceDistribution(
  adopted: readonly Record<string, unknown>[],
  policy: CommercialResearchPolicy,
): Record<string, number | boolean> {
  const uniqueAdopted = [
    ...new Map(
      adopted
        .filter((item) => typeof item.evidence_ref === "string")
        .map((item) => [String(item.evidence_ref), item]),
    ).values(),
  ];
  const academic = uniqueAdopted.filter((item) => item.source_kind === "academic").length;
  const market = uniqueAdopted.filter(
    (item) =>
      item.source_kind !== "academic" &&
      (item.source_kind === "regulatory" || item.claim_type === "market_structure_regulatory"),
  ).length;
  const customer = uniqueAdopted.length - academic - market;
  const total = uniqueAdopted.length;
  const customerPercent = percentage(customer, total);
  const marketPercent = percentage(market, total);
  const academicPercent = percentage(academic, total);
  const [customerMinimum = 60, customerMaximum = 70] = policy.customer_commercial_percent_range;
  const [marketMinimum = 15, marketMaximum = 20] = policy.market_structure_percent_range;
  return {
    total_adopted_sources: total,
    customer_commercial_count: customer,
    market_structure_count: market,
    academic_count: academic,
    customer_commercial_percent: customerPercent,
    market_structure_percent: marketPercent,
    academic_percent: academicPercent,
    guidance_deviation_observed:
      total > 0 &&
      (customerPercent < customerMinimum ||
        customerPercent > customerMaximum ||
        marketPercent < marketMinimum ||
        marketPercent > marketMaximum ||
        academicPercent > policy.academic_percent_maximum),
  };
}

function directObservedSupport(
  item: Record<string, unknown>,
  key: string,
  aspect: unknown,
): boolean {
  if (
    item.disposition !== "adopted" ||
    !strings(item.coverage_keys).includes(key) ||
    item.source_kind === "academic" ||
    item.evidence_character === "inference" ||
    item.evidence_character === "mechanism" ||
    item.evidence_character === "effect_boundary" ||
    item.freshness_status === "undated"
  ) {
    return false;
  }
  if (!CLAIM_ASPECTS[String(item.claim_type)]?.includes(String(aspect))) return false;
  if (key !== "independent_counterevidence" && item.freshness_status !== "current") return false;
  if (item.source_kind === "vendor" || item.evidence_character === "vendor_claim") return false;
  if (key === "independent_counterevidence") return item.independence === "independent";
  return (
    item.evidence_character === "observed_behavior" ||
    item.evidence_character === "independent_report"
  );
}

function validateScopeAndStages(
  documents: readonly CommercialResearchDocument[],
  policy: CommercialResearchPolicy,
): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  for (const entry of documents) {
    if (entry.schemaVersion === "startup_opportunity.intake.v1") {
      const confirmation = isRecord(entry.document.scope_confirmation)
        ? entry.document.scope_confirmation
        : {};
      const constraints = isRecord(entry.document.explicit_constraints)
        ? entry.document.explicit_constraints
        : {};
      const confirmedUsers = strings(confirmation.target_users);
      const constrainedUsers = strings(constraints.target_users);
      if (
        confirmation.user_confirmed !== true ||
        confirmation.research_language !== entry.document.language ||
        (constrainedUsers.length > 0 &&
          canonicalJson([...confirmedUsers].sort()) !== canonicalJson([...constrainedUsers].sort()))
      ) {
        errors.push(
          issue(
            "commercial_research.intake_scope_confirmation_mismatch",
            `${entry.path}#/scope_confirmation`,
            "formal intake requires user-confirmed geography, customer model, users, decision goal, and matching research language",
          ),
        );
      }
    }
    const expectedStage = TASK_STAGE_BY_VERSION.get(entry.schemaVersion);
    if (expectedStage !== undefined) {
      const requirements = isRecord(entry.document.commercial_research_requirements)
        ? entry.document.commercial_research_requirements
        : {};
      if (requirements.research_stage !== expectedStage) {
        errors.push(
          issue(
            "commercial_research.task_stage_mismatch",
            `${entry.path}#/commercial_research_requirements/research_stage`,
            "pre-thesis tasks must remain solution-neutral and post-thesis tasks must use solution-specific evaluation",
            { expectedStage, actualStage: requirements.research_stage },
          ),
        );
      }
      const quantitativeScope = isRecord(requirements.quantitative_competitive_scope)
        ? requirements.quantitative_competitive_scope
        : {};
      const expectedScanMode =
        expectedStage === policy.solution_neutral_stage ? "broad_scan" : "targeted_deep_dive";
      if (
        quantitativeScope.scan_mode !== expectedScanMode ||
        !sameStringSet(quantitativeScope.required_metric_families, QUANTITATIVE_METRIC_FAMILIES) ||
        !sameStringSet(quantitativeScope.required_competitor_types, COMPETITIVE_OBJECT_TYPES) ||
        quantitativeScope.api_is_optional !== true ||
        quantitativeScope.provider_allowlist_enforced !== false ||
        quantitativeScope.acquisition_execution_owner !== "research_agent_or_caller" ||
        quantitativeScope.harness_hidden_network_calls !== false
      ) {
        errors.push(
          issue(
            "commercial_research.quantitative_competitive_scope_invalid",
            `${entry.path}#/commercial_research_requirements/quantitative_competitive_scope`,
            "research tasks must require provider-agnostic quantitative and broad competitive coverage at the stage-appropriate scan depth without hidden Harness acquisition",
            { expectedScanMode },
          ),
        );
      }
      if (
        expectedStage === policy.solution_neutral_stage &&
        records(requirements.planned_queries).some((query) =>
          strings(query.commercial_dimensions).some((dimension) =>
            dimension.startsWith("solution_"),
          ),
        )
      ) {
        errors.push(
          issue(
            "commercial_research.pre_thesis_solution_specific",
            `${entry.path}#/commercial_research_requirements/planned_queries`,
            "solution-neutral discovery cannot plan solution-specific pricing, acquisition, or retention research",
          ),
        );
      }
    }
    if (entry.schemaVersion === "startup_opportunity.discovery_stage_readiness.v1") {
      const gate = isRecord(entry.document.commercial_signal_gate)
        ? entry.document.commercial_signal_gate
        : {};
      const hasSignal =
        gate.demand_signal === true || gate.buyer_signal === true || gate.purchase_signal === true;
      const expectedDecision = hasSignal ? "continue_research" : "early_stop_insufficient_evidence";
      if (gate.decision !== expectedDecision) {
        errors.push(
          issue(
            "commercial_research.readiness_early_stop_mismatch",
            `${entry.path}#/commercial_signal_gate/decision`,
            "Wave 1 without demand, buyer, or purchase signals must stop before solution evaluation",
            { expectedDecision },
          ),
        );
      }
      if (
        !hasSignal &&
        (entry.document.next_stage_readiness !== "terminal" ||
          entry.document.next_stage_id !== null ||
          !strings(entry.document.allowed_next_actions).includes(
            "terminate_insufficient_evidence",
          ) ||
          strings(entry.document.allowed_next_actions).some((action) =>
            ["run_solution_generation", "run_candidate_evaluation"].includes(action),
          ))
      ) {
        errors.push(
          issue(
            "commercial_research.solution_evaluation_after_early_stop",
            entry.path,
            "a failed Wave 1 commercial signal gate must terminate without solution evaluation",
          ),
        );
      }
    }
  }
  return errors;
}

function validateSearchClosure(
  entry: CommercialResearchDocument,
  audit: Record<string, unknown>,
  adoptedEvidenceRefs: ReadonlySet<string>,
): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const queries = records(audit.search_log);
  const closure = isRecord(audit.search_closure) ? audit.search_closure : {};
  const external = closure.lane_kind === "external_research";
  if (closure.closure_id !== `search_closure_${String(audit.unit_id)}`) {
    errors.push(
      issue(
        "commercial_research.search_closure_identity_mismatch",
        `${entry.path}#/search_closure/closure_id`,
        "Search Closure identity must be deterministic for the planned unit",
        { expected: `search_closure_${String(audit.unit_id)}` },
      ),
    );
  }
  if (
    (external && closure.outcome === "search_not_required") ||
    (!external && closure.outcome !== "search_not_required") ||
    (!external && (queries.length > 0 || adoptedEvidenceRefs.size > 0))
  ) {
    errors.push(
      issue(
        "commercial_research.search_closure_kind_mismatch",
        `${entry.path}#/search_closure`,
        "external research and synthesis-only lanes require distinct terminal search closure states",
      ),
    );
  }
  if (external && audit.task_ref !== null && queries.length === 0) {
    errors.push(
      issue(
        "commercial_research.search_closure_log_missing",
        `${entry.path}#/search_log`,
        "an external lane with a Research Task must retain its query and result log at every terminal outcome, including early stop",
      ),
    );
  }
  if (closure.outcome === "failed_before_search" && queries.length > 0) {
    errors.push(
      issue(
        "commercial_research.failed_before_search_mismatch",
        `${entry.path}#/search_closure/outcome`,
        "failed_before_search is valid only when no query was executed",
      ),
    );
  }
  if (
    audit.task_ref === null &&
    !["failed_before_search", "search_not_required"].includes(String(closure.outcome))
  ) {
    errors.push(
      issue(
        "commercial_research.pre_task_closure_mismatch",
        `${entry.path}#/search_closure/outcome`,
        "a lane without a Research Task can close only as failed_before_search or search_not_required",
      ),
    );
  }
  if (closure.telemetry_basis === "unavailable" && closure.query_log_complete !== false) {
    errors.push(
      issue(
        "commercial_research.search_telemetry_overclaimed",
        `${entry.path}#/search_closure/query_log_complete`,
        "unobservable tool telemetry cannot be represented as a complete Harness-recorded search log",
      ),
    );
  }
  if (["harness_recorded", "mixed"].includes(String(closure.telemetry_basis))) {
    errors.push(
      issue(
        "commercial_research.search_telemetry_unobservable",
        `${entry.path}#/search_closure/telemetry_basis`,
        "the current Harness does not observe Codex browser or search tool calls and cannot attest tool telemetry",
      ),
    );
  }
  const adoptedSearchRefs = new Set<string>();
  for (const [queryIndex, query] of queries.entries()) {
    for (const [resultIndex, result] of records(query.candidate_results).entries()) {
      const resultPath = `${entry.path}#/search_log/${queryIndex}/candidate_results/${resultIndex}`;
      const adopted = typeof result.adopted_evidence_ref === "string";
      const rejected = typeof result.rejection_reason === "string";
      if (adopted === rejected) {
        errors.push(
          issue(
            "commercial_research.search_result_disposition",
            resultPath,
            "every candidate result must be either adopted or rejected with a reason",
          ),
        );
      }
      if (adopted) adoptedSearchRefs.add(String(result.adopted_evidence_ref));
      const derived = deriveValidAsOf(result);
      if (result.derived_valid_as_of !== derived) {
        errors.push(
          issue(
            "commercial_research.valid_as_of_not_derived",
            `${resultPath}/derived_valid_as_of`,
            "valid-as-of must be derived from data_period_end, observed_at, or published_at in precedence order; retrieval time is audit-only",
            { expected: derived },
          ),
        );
      }
      const retrieved = dateOnly(result.retrieved_at);
      for (const field of [
        "published_at",
        "observed_at",
        "data_period_end",
        "regulatory_status_verified_at",
      ] as const) {
        const value = dateOnly(result[field]);
        if (value !== null && retrieved !== null && value > retrieved) {
          errors.push(
            issue(
              "commercial_research.source_date_order",
              `${resultPath}/${field}`,
              `${field} cannot be later than retrieved_at`,
            ),
          );
        }
      }
      if (
        result.claim_type === "market_structure_regulatory" &&
        (dateOnly(result.regulatory_status_verified_at) === null ||
          ![
            "effective",
            "partially_effective",
            "not_yet_effective",
            "repealed",
            "unknown",
          ].includes(String(result.regulatory_effective_status)))
      ) {
        errors.push(
          issue(
            "commercial_research.regulatory_status_unverified",
            resultPath,
            "regulatory search results require a recently observed effective state; publication year alone is insufficient",
          ),
        );
      }
    }
  }
  const missingFromSearch = [...adoptedEvidenceRefs].filter((ref) => !adoptedSearchRefs.has(ref));
  const missingFromRegister = [...adoptedSearchRefs].filter((ref) => !adoptedEvidenceRefs.has(ref));
  if (missingFromSearch.length > 0 || missingFromRegister.length > 0) {
    errors.push(
      issue(
        "commercial_research.search_evidence_reconciliation",
        `${entry.path}#/search_closure`,
        "adopted search results and the adopted Evidence Register must reconcile in both directions",
        {
          missingFromSearch: missingFromSearch.sort(),
          missingFromRegister: missingFromRegister.sort(),
        },
      ),
    );
  }
  return errors;
}

function validateQuantitativeCompetitiveAudit(
  entry: CommercialResearchDocument,
  documents: readonly CommercialResearchDocument[],
  exactJsonlRecords: ReadonlyMap<string, Record<string, unknown>>,
): ValidationIssue[] {
  const audit = entry.document;
  const errors: ValidationIssue[] = [];
  const coveredSubjects = strings(audit.covered_direction_ids);
  const coveredSubjectSet = new Set(coveredSubjects);
  if (audit.task_ref !== null && coveredSubjects.length === 0) {
    errors.push(
      issue(
        "commercial_research.covered_subject_missing",
        `${entry.path}#/covered_direction_ids`,
        "a commercial audit tied to a research task must cover at least one explicit subject",
      ),
    );
  }
  const evidenceRegister = records(audit.evidence_register);
  const adoptedEvidenceRefs = new Set(
    evidenceRegister
      .filter((item) => item.disposition === "adopted" && typeof item.evidence_ref === "string")
      .map((item) => String(item.evidence_ref)),
  );
  const documentsByPath = new Map(documents.map((document) => [document.path, document]));

  const acquisitions = records(audit.data_acquisitions);
  const acquisitionsById = new Map<string, Record<string, unknown>>();
  for (const [index, acquisition] of acquisitions.entries()) {
    const acquisitionId = String(acquisition.acquisition_id ?? "");
    const acquisitionPath = `${entry.path}#/data_acquisitions/${index}`;
    if (acquisitionsById.has(acquisitionId)) {
      errors.push(
        issue(
          "commercial_research.acquisition_identity_duplicate",
          acquisitionPath,
          "data acquisition ids must be unique within one commercial audit",
          { acquisitionId },
        ),
      );
    }
    acquisitionsById.set(acquisitionId, acquisition);
    if (containsUnredactedSensitiveMaterial(acquisition.endpoint_or_query_redacted)) {
      errors.push(
        issue(
          "commercial_research.acquisition_sensitive_material",
          `${acquisitionPath}/endpoint_or_query_redacted`,
          "acquisition provenance must redact credentials, cookies, tokens, and sensitive headers",
        ),
      );
    }
    const evidenceRef = String(acquisition.evidence_ref ?? "");
    const substrateRef = String(acquisition.evidence_substrate_ref ?? "");
    const substrate = exactJsonlRecords.get(substrateRef);
    const evidence = documentsByPath.get(evidenceRef)?.document;
    const mechanicalBinding = isRecord(evidence?.mechanical_binding)
      ? evidence.mechanical_binding
      : {};
    if (!adoptedEvidenceRefs.has(evidenceRef)) {
      errors.push(
        issue(
          "commercial_research.acquisition_evidence_not_adopted",
          `${acquisitionPath}/evidence_ref`,
          "every quantitative acquisition must bind adopted formal Evidence",
          { evidenceRef },
        ),
      );
    }
    if (
      substrate?.schema_version !== "startup_opportunity.evidence_store_record.v2" ||
      substrate.content_hash !== acquisition.raw_response_hash ||
      substrate.raw_content_ref !== acquisition.raw_response_ref ||
      substrate.recorded_at !== acquisition.retrieved_at ||
      mechanicalBinding.substrate_record_ref !== substrateRef ||
      mechanicalBinding.content_hash !== acquisition.raw_response_hash ||
      mechanicalBinding.raw_content_ref !== acquisition.raw_response_ref
    ) {
      errors.push(
        issue(
          "commercial_research.acquisition_substrate_binding_mismatch",
          acquisitionPath,
          "acquisition provenance must bind the exact caller-supplied Evidence substrate and raw response hash",
          { evidenceRef, substrateRef },
        ),
      );
    }
  }

  const observations = records(audit.quantitative_observations);
  const observationsById = new Map<string, Record<string, unknown>>();
  const comparisonGroups = new Map<string, Record<string, unknown>[]>();
  for (const [index, observation] of observations.entries()) {
    const observationId = String(observation.observation_id ?? "");
    const observationPath = `${entry.path}#/quantitative_observations/${index}`;
    if (observationsById.has(observationId)) {
      errors.push(
        issue(
          "commercial_research.quantitative_observation_duplicate",
          observationPath,
          "quantitative observation ids must be unique within one commercial audit",
          { observationId },
        ),
      );
    }
    observationsById.set(observationId, observation);
    if (!coveredSubjectSet.has(String(observation.subject_id))) {
      errors.push(
        issue(
          "commercial_research.quantitative_subject_out_of_scope",
          `${observationPath}/subject_id`,
          "quantitative observations must belong to a direction covered by the audit",
        ),
      );
    }
    const acquisition = acquisitionsById.get(String(observation.acquisition_id));
    if (
      acquisition === undefined ||
      strings(observation.evidence_refs).some((ref) => !adoptedEvidenceRefs.has(ref)) ||
      !strings(observation.evidence_refs).includes(String(acquisition?.evidence_ref ?? ""))
    ) {
      errors.push(
        issue(
          "commercial_research.quantitative_evidence_binding_mismatch",
          observationPath,
          "each quantitative observation must cite its acquisition Evidence and only adopted Evidence",
        ),
      );
    }
    const value = isRecord(observation.value) ? observation.value : {};
    if (
      (value.shape === "range" && Number(value.lower_bound) > Number(value.upper_bound)) ||
      (value.shape === "estimate" &&
        ((typeof value.lower_bound === "number" &&
          Number(value.lower_bound) > Number(value.value)) ||
          (typeof value.upper_bound === "number" &&
            Number(value.value) > Number(value.upper_bound))))
    ) {
      errors.push(
        issue(
          "commercial_research.quantitative_value_order_invalid",
          `${observationPath}/value`,
          "range and estimate bounds must be ordered around the reported value",
        ),
      );
    }
    const period = isRecord(observation.period) ? observation.period : {};
    const periodStart = dateOnly(period.period_start);
    const periodEnd = dateOnly(period.period_end);
    const periodAsOf = dateOnly(period.as_of);
    if (
      (periodStart === null && periodEnd === null && periodAsOf === null) ||
      (periodStart !== null && periodEnd !== null && periodStart > periodEnd)
    ) {
      errors.push(
        issue(
          "commercial_research.quantitative_period_invalid",
          `${observationPath}/period`,
          "a quantitative observation requires an as-of date or a valid ordered period",
        ),
      );
    }
    const estimated = ["estimated", "modeled", "proxy"].includes(
      String(observation.measurement_type),
    );
    if (
      (estimated && typeof observation.estimation_method !== "string") ||
      (!estimated && observation.estimation_method !== null) ||
      (ESTIMATE_SEMANTICS.has(String(observation.metric_semantics)) && value.shape !== "estimate")
    ) {
      errors.push(
        issue(
          "commercial_research.quantitative_measurement_mismatch",
          observationPath,
          "estimated, modeled, proxy, and estimate-semantic metrics require explicit compatible value and method semantics",
        ),
      );
    }
    const boundaries = strings(observation.interpretation_boundaries);
    if (
      (observation.measurement_type === "proxy" ||
        PROXY_LIKE_SEMANTICS.has(String(observation.metric_semantics))) &&
      PROXY_INTERPRETATION_BOUNDARIES.some((boundary) => !boundaries.includes(boundary))
    ) {
      errors.push(
        issue(
          "commercial_research.proxy_semantic_boundary_missing",
          `${observationPath}/interpretation_boundaries`,
          "rank, ratings, downloads, active users, search interest, and other proxies must explicitly state that they do not establish purchases, paid customers, or market validation",
        ),
      );
    }
    if (
      ESTIMATE_SEMANTICS.has(String(observation.metric_semantics)) &&
      !boundaries.includes("estimate_not_observation")
    ) {
      errors.push(
        issue(
          "commercial_research.estimate_semantic_boundary_missing",
          `${observationPath}/interpretation_boundaries`,
          "estimated revenue or paid-customer metrics must remain labeled as estimates rather than observations",
        ),
      );
    }
    const comparability = isRecord(observation.comparability) ? observation.comparability : {};
    const aligned = [
      comparability.geography_aligned,
      comparability.period_aligned,
      comparability.category_aligned,
      comparability.definition_aligned,
      comparability.measurement_aligned,
    ].every((value) => value === true);
    const expectedDirect = comparability.status === "comparable" && aligned;
    if (
      comparability.direct_comparison_allowed !== expectedDirect ||
      (expectedDirect && typeof comparability.comparison_group !== "string") ||
      (!expectedDirect && strings(comparability.limitations).length === 0)
    ) {
      errors.push(
        issue(
          "commercial_research.quantitative_comparability_mismatch",
          `${observationPath}/comparability`,
          "direct comparison is allowed only for explicitly aligned geography, period, category, definition, and measurement type; limitations are mandatory otherwise",
        ),
      );
    }
    if (typeof comparability.comparison_group === "string") {
      const grouped = comparisonGroups.get(comparability.comparison_group) ?? [];
      grouped.push(observation);
      comparisonGroups.set(comparability.comparison_group, grouped);
    }
  }
  for (const [comparisonGroup, grouped] of comparisonGroups) {
    const signatures = new Set(
      grouped.map((observation) => {
        const comparability = isRecord(observation.comparability) ? observation.comparability : {};
        return canonicalJson({
          metric_semantics: observation.metric_semantics,
          metric_definition: observation.metric_definition,
          geography: observation.geography,
          period: observation.period,
          category: comparability.category,
          measurement_type: observation.measurement_type,
        });
      }),
    );
    if (
      signatures.size > 1 ||
      grouped.some(
        (observation) =>
          !isRecord(observation.comparability) ||
          observation.comparability.direct_comparison_allowed !== true,
      )
    ) {
      errors.push(
        issue(
          "commercial_research.quantitative_comparison_group_incompatible",
          `${entry.path}#/quantitative_observations`,
          "one comparison group cannot mix regions, periods, categories, definitions, measurement types, or metric semantics",
          { comparisonGroup },
        ),
      );
    }
  }

  const quantitativeCoverage = records(audit.quantitative_coverage);
  const expectedQuantitativeCoverage = new Set(
    coveredSubjects.flatMap((subjectId) =>
      QUANTITATIVE_METRIC_FAMILIES.map((family) => `${subjectId}:${family}`),
    ),
  );
  const actualQuantitativeCoverage = new Set<string>();
  const referencedObservationIds = new Set<string>();
  for (const [index, coverage] of quantitativeCoverage.entries()) {
    const identity = `${String(coverage.subject_id)}:${String(coverage.metric_family)}`;
    const coveragePath = `${entry.path}#/quantitative_coverage/${index}`;
    if (actualQuantitativeCoverage.has(identity)) {
      errors.push(
        issue(
          "commercial_research.quantitative_coverage_duplicate",
          coveragePath,
          "each direction and metric family requires exactly one coverage entry",
          { identity },
        ),
      );
    }
    actualQuantitativeCoverage.add(identity);
    const ids = strings(coverage.observation_ids);
    ids.forEach((id) => {
      referencedObservationIds.add(id);
    });
    const matchingIds = ids.filter((id) => {
      const observation = observationsById.get(id);
      return (
        observation?.subject_id === coverage.subject_id &&
        observation?.metric_family === coverage.metric_family
      );
    });
    const attempts = records(coverage.query_attempts);
    const state = String(coverage.state);
    const validState =
      ((state === "observed" || state === "partial") &&
        ids.length > 0 &&
        matchingIds.length === ids.length &&
        (state !== "partial" || (attempts.length > 0 && typeof coverage.reason === "string"))) ||
      (state === "unavailable" &&
        ids.length === 0 &&
        attempts.length > 0 &&
        typeof coverage.reason === "string") ||
      (state === "not_applicable" && ids.length === 0 && typeof coverage.reason === "string");
    if (!validState) {
      errors.push(
        issue(
          "commercial_research.quantitative_coverage_state_mismatch",
          coveragePath,
          "coverage state must bind real observations or explicit failed attempts/reasons without fabricated values",
        ),
      );
    }
    for (const [attemptIndex, attempt] of attempts.entries()) {
      if (containsUnredactedSensitiveMaterial(attempt.endpoint_or_query_redacted)) {
        errors.push(
          issue(
            "commercial_research.acquisition_sensitive_material",
            `${coveragePath}/query_attempts/${attemptIndex}/endpoint_or_query_redacted`,
            "failed query provenance must also redact credentials, cookies, tokens, and sensitive headers",
          ),
        );
      }
    }
  }
  if (
    canonicalJson([...actualQuantitativeCoverage].sort()) !==
      canonicalJson([...expectedQuantitativeCoverage].sort()) ||
    observations.some(
      (observation) => !referencedObservationIds.has(String(observation.observation_id)),
    )
  ) {
    errors.push(
      issue(
        "commercial_research.quantitative_coverage_incomplete",
        `${entry.path}#/quantitative_coverage`,
        "every covered direction requires all metric families with complete observation closure and an explicit coverage state",
      ),
    );
  }

  const competitiveObjects = records(audit.competitive_objects);
  const competitiveObjectsById = new Map<string, Record<string, unknown>>();
  for (const [index, competitiveObject] of competitiveObjects.entries()) {
    const objectId = String(competitiveObject.competitive_object_id ?? "");
    const objectPath = `${entry.path}#/competitive_objects/${index}`;
    if (competitiveObjectsById.has(objectId)) {
      errors.push(
        issue(
          "commercial_research.competitive_object_duplicate",
          objectPath,
          "competitive object ids must be unique within one commercial audit",
          { objectId },
        ),
      );
    }
    competitiveObjectsById.set(objectId, competitiveObject);
    const metricRefs = [
      ...strings(competitiveObject.pricing_observation_refs),
      ...strings(competitiveObject.traction_observation_refs),
    ];
    if (
      !coveredSubjectSet.has(String(competitiveObject.subject_id)) ||
      metricRefs.some((ref) => !observationsById.has(ref)) ||
      strings(competitiveObject.source_refs).some((ref) => !adoptedEvidenceRefs.has(ref))
    ) {
      errors.push(
        issue(
          "commercial_research.competitive_object_binding_mismatch",
          objectPath,
          "competitive objects must bind the covered subject, known pricing/traction observations, and adopted formal Evidence",
        ),
      );
    }
  }

  const competitiveCoverage = records(audit.competitive_coverage);
  const expectedCompetitiveCoverage = new Set(
    coveredSubjects.flatMap((subjectId) =>
      COMPETITIVE_OBJECT_TYPES.map((type) => `${subjectId}:${type}`),
    ),
  );
  const actualCompetitiveCoverage = new Set<string>();
  const referencedCompetitiveObjectIds = new Set<string>();
  for (const [index, coverage] of competitiveCoverage.entries()) {
    const identity = `${String(coverage.subject_id)}:${String(coverage.competitor_type)}`;
    const coveragePath = `${entry.path}#/competitive_coverage/${index}`;
    if (actualCompetitiveCoverage.has(identity)) {
      errors.push(
        issue(
          "commercial_research.competitive_coverage_duplicate",
          coveragePath,
          "each direction and broad competitor type requires exactly one coverage entry",
          { identity },
        ),
      );
    }
    actualCompetitiveCoverage.add(identity);
    const ids = strings(coverage.competitive_object_ids);
    ids.forEach((id) => {
      referencedCompetitiveObjectIds.add(id);
    });
    const matchingIds = ids.filter((id) => {
      const competitiveObject = competitiveObjectsById.get(id);
      return (
        competitiveObject?.subject_id === coverage.subject_id &&
        competitiveObject?.competitor_type === coverage.competitor_type
      );
    });
    const attempts = records(coverage.query_attempts);
    const state = String(coverage.state);
    const validState =
      ((state === "observed" || state === "partial") &&
        ids.length > 0 &&
        matchingIds.length === ids.length &&
        (state !== "partial" || (attempts.length > 0 && typeof coverage.reason === "string"))) ||
      (state === "unavailable" &&
        ids.length === 0 &&
        attempts.length > 0 &&
        typeof coverage.reason === "string") ||
      (state === "not_applicable" && ids.length === 0 && typeof coverage.reason === "string");
    if (!validState) {
      errors.push(
        issue(
          "commercial_research.competitive_coverage_state_mismatch",
          coveragePath,
          "broad competitive coverage must bind named alternatives or explicit failed attempts/reasons without inventing objects",
        ),
      );
    }
    for (const [attemptIndex, attempt] of attempts.entries()) {
      if (containsUnredactedSensitiveMaterial(attempt.endpoint_or_query_redacted)) {
        errors.push(
          issue(
            "commercial_research.acquisition_sensitive_material",
            `${coveragePath}/query_attempts/${attemptIndex}/endpoint_or_query_redacted`,
            "failed query provenance must also redact credentials, cookies, tokens, and sensitive headers",
          ),
        );
      }
    }
  }
  if (
    canonicalJson([...actualCompetitiveCoverage].sort()) !==
      canonicalJson([...expectedCompetitiveCoverage].sort()) ||
    competitiveObjects.some(
      (competitiveObject) =>
        !referencedCompetitiveObjectIds.has(String(competitiveObject.competitive_object_id)),
    )
  ) {
    errors.push(
      issue(
        "commercial_research.competitive_coverage_incomplete",
        `${entry.path}#/competitive_coverage`,
        "every covered direction requires all broad competitor types with complete object closure and an explicit coverage state",
      ),
    );
  }
  return errors;
}

function validateAudit(
  entry: CommercialResearchDocument,
  policy: CommercialResearchPolicy,
  documents: readonly CommercialResearchDocument[],
  exactJsonlRecords: ReadonlyMap<string, Record<string, unknown>>,
): ValidationIssue[] {
  const audit = entry.document;
  const errors: ValidationIssue[] = [];
  errors.push(...validateQuantitativeCompetitiveAudit(entry, documents, exactJsonlRecords));
  const queries = records(audit.search_log);
  if (
    audit.research_stage === "solution_neutral_scan" &&
    queries.some((query) =>
      strings(query.commercial_dimensions).some((dimension) => dimension.startsWith("solution_")),
    )
  ) {
    errors.push(
      issue(
        "commercial_research.pre_thesis_solution_specific",
        `${entry.path}#/search_log`,
        "solution-neutral discovery cannot perform solution-specific pricing, acquisition, or retention evaluation",
      ),
    );
  }

  const evidence = records(audit.evidence_register);
  const evidenceRefCounts = new Map<string, number>();
  for (const item of evidence) {
    if (typeof item.evidence_ref === "string") {
      evidenceRefCounts.set(item.evidence_ref, (evidenceRefCounts.get(item.evidence_ref) ?? 0) + 1);
    }
  }
  for (const [evidenceRef, count] of evidenceRefCounts) {
    if (count > 1) {
      errors.push(
        issue(
          "commercial_research.duplicate_evidence_ref",
          `${entry.path}#/evidence_register`,
          "each stable Evidence ref may appear only once in the Evidence Register",
          { evidenceRef, count },
        ),
      );
    }
  }
  const adopted = evidence.filter((item) => item.disposition === "adopted");
  const adoptedByRef = new Map(
    adopted
      .filter((item) => typeof item.evidence_ref === "string")
      .map((item) => [String(item.evidence_ref), item]),
  );
  const adoptedRefs = new Set(adoptedByRef.keys());
  errors.push(...validateSearchClosure(entry, audit, adoptedRefs));

  const expectedDistribution = sourceDistribution(adopted, policy);
  if (
    canonicalJson(
      isRecord(audit.adopted_source_distribution) ? audit.adopted_source_distribution : {},
    ) !== canonicalJson(expectedDistribution)
  ) {
    errors.push(
      issue(
        "commercial_research.adopted_distribution_mismatch",
        `${entry.path}#/adopted_source_distribution`,
        "actual source distribution must be derived from adopted Evidence Register records",
        { expected: expectedDistribution },
      ),
    );
  }

  for (const [index, item] of evidence.entries()) {
    const itemPath = `${entry.path}#/evidence_register/${index}`;
    const keys = strings(item.coverage_keys);
    if (item.source_kind === "academic" && keys.some((key) => !ACADEMIC_KEYS.has(key))) {
      errors.push(
        issue(
          "commercial_research.academic_commercial_coverage",
          `${itemPath}/coverage_keys`,
          "academic Evidence may cover only mechanism, effect boundary, or counterevidence",
          { coverageKeys: keys },
        ),
      );
    }
    if (
      item.source_kind === "vendor" &&
      (!VENDOR_CLAIM_TYPES.has(String(item.claim_type)) ||
        item.evidence_character !== "vendor_claim")
    ) {
      errors.push(
        issue(
          "commercial_research.vendor_claim_scope_invalid",
          itemPath,
          "vendor material may directly establish only public pricing, product, positioning, or the vendor's own statement",
        ),
      );
    }
    if (item.disposition === "rejected" && typeof item.exclusion_reason !== "string") {
      errors.push(
        issue(
          "commercial_research.rejected_evidence_reason_missing",
          `${itemPath}/exclusion_reason`,
          "rejected validated Evidence requires an exclusion reason",
        ),
      );
    }
    if (item.disposition === "adopted" && item.exclusion_reason !== null) {
      errors.push(
        issue(
          "commercial_research.adopted_evidence_has_exclusion",
          `${itemPath}/exclusion_reason`,
          "adopted Evidence cannot carry an exclusion reason",
        ),
      );
    }
    if (
      item.claim_type === "market_structure_regulatory" &&
      (dateOnly(item.regulatory_status_verified_at) === null ||
        !["effective", "partially_effective", "not_yet_effective", "repealed", "unknown"].includes(
          String(item.regulatory_effective_status),
        ))
    ) {
      errors.push(
        issue(
          "commercial_research.regulatory_status_unverified",
          itemPath,
          "regulatory claims require an explicit effective-state observation and verification timestamp; enactment or publication year alone is insufficient",
        ),
      );
    }
    const derivedValidAsOf = deriveValidAsOf(item);
    if (item.derived_valid_as_of !== derivedValidAsOf) {
      errors.push(
        issue(
          "commercial_research.valid_as_of_not_derived",
          `${itemPath}/derived_valid_as_of`,
          "valid-as-of must be derived without using retrieved_at",
          { expected: derivedValidAsOf },
        ),
      );
    }
    const expectedFreshness = deriveFreshness(item, audit.audited_at, policy);
    if (item.freshness_status !== expectedFreshness) {
      errors.push(
        issue(
          "commercial_research.freshness_status_mismatch",
          `${itemPath}/freshness_status`,
          "freshness status must follow the claim-specific observation window",
          { expected: expectedFreshness, claimType: item.claim_type },
        ),
      );
    }
  }

  const coverage = isRecord(audit.coverage) ? audit.coverage : {};
  const reusedDataPoints = new Map<string, string>();
  const directlyCovered = new Set<string>();
  for (const key of REQUIRED_RANKING_KEYS) {
    const declared = isRecord(coverage[key]) ? coverage[key] : {};
    const refs = strings(declared.evidence_refs);
    const dataPoints = records(declared.data_points);
    const inference = isRecord(declared.inference) ? declared.inference : null;
    const inferenceBasisRefs = inference === null ? [] : strings(inference.basis_refs);
    const state = declared.state;
    const contentCovered = state !== "unknown";
    if (declared.content_covered !== contentCovered) {
      errors.push(
        issue(
          "commercial_research.coverage_content_mismatch",
          `${entry.path}#/coverage/${key}/content_covered`,
          "inferred content is covered for reporting but only observed content is directly evidenced",
          { expected: contentCovered },
        ),
      );
    }
    for (const [dataIndex, dataPoint] of dataPoints.entries()) {
      const evidenceRef = String(dataPoint.evidence_ref ?? "");
      if (!refs.includes(evidenceRef)) {
        errors.push(
          issue(
            "commercial_research.coverage_data_point_ref_mismatch",
            `${entry.path}#/coverage/${key}/data_points/${dataIndex}`,
            "each dimension-specific fact or excerpt must cite one of that dimension's Evidence refs",
          ),
        );
      }
      const identity = canonicalJson([evidenceRef, dataPoint.fact_or_excerpt]);
      const previousKey = reusedDataPoints.get(identity);
      if (previousKey !== undefined && previousKey !== key) {
        errors.push(
          issue(
            "commercial_research.coverage_data_point_reused",
            `${entry.path}#/coverage/${key}/data_points/${dataIndex}`,
            "one generic fact or excerpt cannot be reused as proof for multiple commercial dimensions",
            { previousCoverageKey: previousKey },
          ),
        );
      } else {
        reusedDataPoints.set(identity, key);
      }
    }
    const eligibleDataPoints = dataPoints.filter((dataPoint) => {
      const evidenceRef = String(dataPoint.evidence_ref ?? "");
      const evidenceItem = adoptedByRef.get(evidenceRef);
      return (
        evidenceItem !== undefined && directObservedSupport(evidenceItem, key, dataPoint.aspect)
      );
    });
    const aspects = new Set(eligibleDataPoints.map((dataPoint) => String(dataPoint.aspect)));
    const requiredAspectsPresent =
      key === "alternatives_pricing_usage"
        ? aspects.has("alternative") && (aspects.has("pricing") || aspects.has("usage"))
        : aspects.has(
            {
              recent_user_language: "user_language",
              purchase_signal: "purchase",
              distribution_channel: "distribution",
              independent_counterevidence: "counterevidence",
            }[key] ?? "",
          );
    if (state === "observed" && requiredAspectsPresent) directlyCovered.add(key);
    if (
      (state === "observed" &&
        (refs.length === 0 ||
          dataPoints.length === 0 ||
          !requiredAspectsPresent ||
          inference !== null)) ||
      (state === "inferred" &&
        (inference === null ||
          inferenceBasisRefs.length === 0 ||
          inferenceBasisRefs.some((ref) => !refs.includes(ref) || !adoptedByRef.has(ref)))) ||
      (state === "unknown" && (refs.length > 0 || dataPoints.length > 0 || inference !== null))
    ) {
      errors.push(
        issue(
          "commercial_research.coverage_state_mismatch",
          `${entry.path}#/coverage/${key}`,
          "coverage state must distinguish direct observations, reasoned inference, and unknown dimensions",
          { state, eligibleDataPointCount: eligibleDataPoints.length },
        ),
      );
    }
    const vendorOnly =
      dataPoints.length > 0 &&
      dataPoints.every((dataPoint) => {
        const item = adoptedByRef.get(String(dataPoint.evidence_ref ?? ""));
        return item?.source_kind === "vendor" || item?.evidence_character === "vendor_claim";
      });
    if (state === "observed" && vendorOnly) {
      errors.push(
        issue(
          "commercial_research.vendor_claim_not_cross_validated",
          `${entry.path}#/coverage/${key}`,
          "vendor-only support remains a low-confidence hypothesis until independently validated",
          { coverageKey: key },
        ),
      );
    }
  }

  const completeCoverage = REQUIRED_RANKING_KEYS.every((key) => directlyCovered.has(key));
  const expectedRanking = completeCoverage ? "ranked" : "unranked_hypothesis";
  if (audit.ranking_eligibility !== expectedRanking) {
    errors.push(
      issue(
        "commercial_research.ranking_eligibility_mismatch",
        `${entry.path}#/ranking_eligibility`,
        "ranking eligibility depends only on direct, current, dimension-specific commercial coverage",
        { expectedRanking },
      ),
    );
  }
  const uncovered = REQUIRED_RANKING_KEYS.filter((key) => !directlyCovered.has(key));
  if (
    canonicalJson([...strings(audit.uncovered_business_dimensions)].sort()) !==
    canonicalJson([...uncovered].sort())
  ) {
    errors.push(
      issue(
        "commercial_research.uncovered_dimensions_mismatch",
        `${entry.path}#/uncovered_business_dimensions`,
        "uncovered dimensions are those without qualifying direct commercial observation",
        { expected: uncovered },
      ),
    );
  }
  const signals = isRecord(audit.wave1_signals) ? audit.wave1_signals : {};
  const hasEarlySignal =
    signals.demand === true || signals.buyer === true || signals.purchase === true;
  const expectedDecision = hasEarlySignal
    ? "continue_research"
    : "early_stop_insufficient_evidence";
  if (audit.stage_decision !== expectedDecision) {
    errors.push(
      issue(
        "commercial_research.early_stop_mismatch",
        `${entry.path}#/stage_decision`,
        "Wave 1 without demand, buyer, or purchase signals must stop before solution evaluation",
        { expectedDecision },
      ),
    );
  }
  return errors;
}

const REPORT_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.concept_evidence_report.v1",
  "startup_opportunity.report.v1",
  "startup_opportunity.terminal_report_source.v1",
]);

function sortedProjection(value: unknown, identity: (entry: Record<string, unknown>) => string) {
  return records(value).toSorted((left, right) => identity(left).localeCompare(identity(right)));
}

function validateCommercialReportProjections(
  documents: readonly CommercialResearchDocument[],
): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const audits = documents
    .filter(
      (entry) => entry.schemaVersion === "startup_opportunity.commercial_research_audit.current",
    )
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const auditsByPath = new Map(audits.map((audit) => [audit.path, audit]));
  const plannedAuditPaths = documents
    .filter((entry) => TASK_STAGE_BY_VERSION.has(entry.schemaVersion))
    .flatMap((task) => {
      const requirements = isRecord(task.document.commercial_research_requirements)
        ? task.document.commercial_research_requirements
        : {};
      return typeof requirements.commercial_audit_output_path === "string"
        ? [requirements.commercial_audit_output_path]
        : [];
    });
  const expectedQuantitativeRows = audits.flatMap((audit) =>
    records(audit.document.quantitative_observations).map((observation) => ({
      audit_ref: audit.path,
      observation,
    })),
  );
  const expectedCompetitiveRows = audits.flatMap((audit) =>
    records(audit.document.competitive_objects).map((competitiveObject) => ({
      audit_ref: audit.path,
      competitive_object: competitiveObject,
    })),
  );
  const expectedGapRows = audits.flatMap((audit) => [
    ...records(audit.document.quantitative_coverage)
      .filter((coverage) => coverage.state !== "observed")
      .map((coverage) => ({
        audit_ref: audit.path,
        coverage_kind: "quantitative",
        coverage,
      })),
    ...records(audit.document.competitive_coverage)
      .filter((coverage) => coverage.state !== "observed")
      .map((coverage) => ({
        audit_ref: audit.path,
        coverage_kind: "competitive",
        coverage,
      })),
  ]);

  for (const report of documents.filter((entry) =>
    REPORT_SCHEMA_VERSIONS.has(entry.schemaVersion),
  )) {
    const reportAuditRefs = strings(report.document.commercial_research_audit_refs);
    const missingPlannedAudits = [...new Set(plannedAuditPaths)].filter(
      (auditPath) => !auditsByPath.has(auditPath),
    );
    if (
      !sameStringSet(
        reportAuditRefs,
        audits.map((audit) => audit.path),
      ) ||
      missingPlannedAudits.length > 0
    ) {
      errors.push(
        issue(
          "commercial_research.report_audit_closure_incomplete",
          `${report.path}#/commercial_research_audit_refs`,
          "formal reporting must include every current commercial research audit and every planned research task must have one",
          { missingPlannedAudits: missingPlannedAudits.sort() },
        ),
      );
    }
    const actualQuantitativeRows = sortedProjection(
      report.document.quantitative_signal_rows,
      (row) =>
        `${String(row.audit_ref)}:${String(isRecord(row.observation) ? row.observation.observation_id : "")}`,
    );
    const sortedExpectedQuantitativeRows = sortedProjection(
      expectedQuantitativeRows,
      (row) =>
        `${String(row.audit_ref)}:${String(isRecord(row.observation) ? row.observation.observation_id : "")}`,
    );
    if (canonicalJson(actualQuantitativeRows) !== canonicalJson(sortedExpectedQuantitativeRows)) {
      errors.push(
        issue(
          "commercial_research.report_quantitative_projection_mismatch",
          `${report.path}#/quantitative_signal_rows`,
          "the quantitative signal table must be the exact, complete projection of cited commercial audits",
        ),
      );
    }
    const actualCompetitiveRows = sortedProjection(
      report.document.competitive_substitute_rows,
      (row) =>
        `${String(row.audit_ref)}:${String(isRecord(row.competitive_object) ? row.competitive_object.competitive_object_id : "")}`,
    );
    const sortedExpectedCompetitiveRows = sortedProjection(
      expectedCompetitiveRows,
      (row) =>
        `${String(row.audit_ref)}:${String(isRecord(row.competitive_object) ? row.competitive_object.competitive_object_id : "")}`,
    );
    if (canonicalJson(actualCompetitiveRows) !== canonicalJson(sortedExpectedCompetitiveRows)) {
      errors.push(
        issue(
          "commercial_research.report_competitive_projection_mismatch",
          `${report.path}#/competitive_substitute_rows`,
          "the competitor and substitute matrix must be the exact, complete projection of cited commercial audits",
        ),
      );
    }
    const actualGapRows = sortedProjection(report.document.research_coverage_gaps, (row) => {
      const coverage = isRecord(row.coverage) ? row.coverage : {};
      const dimension =
        row.coverage_kind === "quantitative" ? coverage.metric_family : coverage.competitor_type;
      return `${String(row.audit_ref)}:${String(row.coverage_kind)}:${String(coverage.subject_id)}:${String(dimension)}`;
    });
    const sortedExpectedGapRows = sortedProjection(expectedGapRows, (row) => {
      const coverage = isRecord(row.coverage) ? row.coverage : {};
      const dimension =
        row.coverage_kind === "quantitative" ? coverage.metric_family : coverage.competitor_type;
      return `${String(row.audit_ref)}:${String(row.coverage_kind)}:${String(coverage.subject_id)}:${String(dimension)}`;
    });
    if (canonicalJson(actualGapRows) !== canonicalJson(sortedExpectedGapRows)) {
      errors.push(
        issue(
          "commercial_research.report_gap_projection_mismatch",
          `${report.path}#/research_coverage_gaps`,
          "formal reporting must show every partial, unavailable, and not-applicable quantitative or competitive dimension with its decision impact",
        ),
      );
    }
  }
  return errors;
}

export function validateCommercialResearchContract(
  documents: readonly CommercialResearchDocument[],
  policy: CommercialResearchPolicy,
  exactJsonlRecords: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): readonly ValidationIssue[] {
  const errors = validateScopeAndStages(documents, policy);
  const byPath = new Map(documents.map((entry) => [entry.path, entry]));
  for (const entry of documents.filter(
    (candidate) => candidate.schemaVersion === "startup_opportunity.discovery_lane_result.v1",
  )) {
    const task = byPath.get(String(entry.document.task_ref));
    const requirements = isRecord(task?.document.commercial_research_requirements)
      ? task.document.commercial_research_requirements
      : {};
    const auditPath = requirements.commercial_audit_output_path;
    const audit = typeof auditPath === "string" ? byPath.get(auditPath) : undefined;
    const register = records(audit?.document.evidence_register);
    const scored = new Map(
      records(entry.document.scored_candidates).map((candidate) => [
        String(candidate.candidate_ref),
        candidate,
      ]),
    );
    for (const [index, decision] of records(entry.document.pre_kill_decisions).entries()) {
      if (decision.disposition !== "retained" || decision.retention_basis !== "evidence") continue;
      const candidate = scored.get(String(decision.candidate_ref));
      const supportingRefs = strings(candidate?.supporting_refs);
      const coverage = isRecord(audit?.document.coverage) ? audit.document.coverage : {};
      const registerByRef = new Map(
        register
          .filter((item) => typeof item.evidence_ref === "string")
          .map((item) => [String(item.evidence_ref), item]),
      );
      const hasDirectCommercialSupport = [
        "recent_user_language",
        "purchase_signal",
        "alternatives_pricing_usage",
        "distribution_channel",
      ].some((coverageKey) => {
        const entry = isRecord(coverage[coverageKey]) ? coverage[coverageKey] : {};
        if (entry.state !== "observed") return false;
        return records(entry.data_points).some((dataPoint) => {
          const evidenceRef = String(dataPoint.evidence_ref ?? "");
          const item = registerByRef.get(evidenceRef);
          return (
            supportingRefs.includes(evidenceRef) &&
            item !== undefined &&
            directObservedSupport(item, coverageKey, dataPoint.aspect)
          );
        });
      });
      if (!hasDirectCommercialSupport) {
        errors.push(
          issue(
            "commercial_research.candidate_retention_without_direct_commercial_evidence",
            `${entry.path}#/pre_kill_decisions/${index}`,
            "Evidence-based retention requires current direct commercial support; academic, inferred, or vendor-only support remains an unranked hypothesis",
            { candidateRef: decision.candidate_ref, supportingRefs },
          ),
        );
      }
    }
  }
  for (const entry of documents.filter(
    (candidate) =>
      candidate.schemaVersion === "startup_opportunity.commercial_research_audit.current",
  )) {
    errors.push(...validateAudit(entry, policy, documents, exactJsonlRecords));
  }
  errors.push(...validateCommercialReportProjections(documents));
  return errors;
}

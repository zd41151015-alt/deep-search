import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import { projectCommercialAuditTables } from "../reporting/commercial-report-tables.js";
import { projectGateWarnings } from "./gate-diagnostics.js";
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
  readonly incumbent_response_research_stage: "post_candidate_only";
  readonly incumbent_response_decision_role: "judgment_context_only";
  readonly incumbent_response_automatic_effects: Readonly<{
    gate: false;
    ranking_eligibility: false;
    claim_confidence: false;
    recommendation_ceiling: false;
    artifact_publication: false;
  }>;
}

export const REQUIRED_RANKING_KEYS = [
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

const CLAIM_METRIC_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  recent_user_language: ["demand_scale"],
  current_purchase_behavior: ["commercial_behavior"],
  current_distribution: ["distribution"],
  current_competitor_usage: ["competitive_intensity", "usage_behavior"],
  current_retention: ["retention_outcomes"],
  current_market_change: ["demand_scale", "growth_change"],
  current_pricing: ["commercial_behavior"],
  current_product_capability: ["competitive_intensity", "usage_behavior"],
  current_competitor_offering: ["competitive_intensity", "usage_behavior"],
  vendor_public_pricing: ["commercial_behavior"],
  vendor_public_product: ["competitive_intensity", "usage_behavior"],
};

const COVERAGE_KEY_METRIC_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  recent_user_language: ["demand_scale"],
  buyer: ["commercial_behavior"],
  purchase_signal: ["commercial_behavior"],
  pricing: ["commercial_behavior"],
  alternatives_pricing_usage: ["competitive_intensity", "usage_behavior"],
  distribution_channel: ["distribution"],
  retention: ["retention_outcomes"],
  unit_economics: ["unit_economics"],
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

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${canonicalContentHash(value).slice("sha256:".length, "sha256:".length + 24)}`;
}

function subjectIdFromRef(
  ref: string,
  documentsByPath: ReadonlyMap<string, CommercialResearchDocument>,
): string {
  const [targetPath = ref, fragment] = ref.split("#", 2);
  if (fragment !== undefined && fragment !== "") return fragment;
  const target = documentsByPath.get(targetPath)?.document ?? {};
  for (const field of [
    "opportunity_id",
    "direction_id",
    "candidate_id",
    "concept_hypothesis_id",
    "hypothesis_id",
  ]) {
    if (typeof target[field] === "string") return target[field];
  }
  return (
    targetPath
      .split("/")
      .at(-1)
      ?.replace(/\.json$/u, "")
      .replace(/[^A-Za-z0-9._:-]+/gu, "_") ?? targetPath
  );
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

function incumbentTargetRefs(document: Readonly<Record<string, unknown>>): readonly string[] {
  return [
    ...strings(document.target_candidate_refs),
    ...strings(document.target_opportunity_refs),
    ...(typeof document.target_subject_ref === "string" ? [document.target_subject_ref] : []),
  ];
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

export function deriveFreshnessStatus(
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

export function deriveSourceDistribution(
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

function supportedCompanyClaim(source: Readonly<Record<string, unknown>>): boolean {
  const profile = isRecord(source.source_profile) ? source.source_profile : {};
  if (profile.type !== "company_material") return false;
  const required = {
    vendor_public_pricing: "public_pricing",
    vendor_public_product: "product_capability",
    vendor_positioning: "company_statement",
    vendor_statement: "company_statement",
  }[String(source.claim_type)];
  return required !== undefined && strings(profile.supported_public_claims).includes(required);
}

export function isTraceableDirectSource(
  source: Readonly<Record<string, unknown>>,
  evidenceByRef: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): boolean {
  const profile = isRecord(source.source_profile) ? source.source_profile : {};
  if (profile.type !== "news") return true;
  if (
    profile.primary_data_traceability_status !== "traced" ||
    typeof profile.primary_data_ref !== "string"
  ) {
    return false;
  }
  const primary = evidenceByRef.get(profile.primary_data_ref);
  if (primary === undefined || primary.disposition !== "adopted") return false;
  const primaryProfile = isRecord(primary.source_profile) ? primary.source_profile : {};
  const sourceClaimType = String(source.claim_type);
  const primaryClaimType = String(primary.claim_type);
  if (primaryProfile.type === "company_material") {
    return (
      supportedCompanyClaim(primary) &&
      ((sourceClaimType === "current_pricing" && primaryClaimType === "vendor_public_pricing") ||
        (["current_product_capability", "current_competitor_offering"].includes(sourceClaimType) &&
          primaryClaimType === "vendor_public_product") ||
        sourceClaimType === primaryClaimType)
    );
  }
  if (primaryProfile.type === "regulatory") {
    return (
      sourceClaimType === "market_structure_regulatory" &&
      primaryClaimType === "market_structure_regulatory"
    );
  }
  return primaryProfile.type === "api_dataset" && sourceClaimType === primaryClaimType;
}

function normalizedSourceIdentity(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim().toLowerCase();
  try {
    const url = new URL(trimmed);
    return url.hostname.replace(/^www\./u, "");
  } catch {
    return trimmed.replace(/\s+/gu, " ");
  }
}

function sourceGroupIdentities(
  source: Readonly<Record<string, unknown>>,
  evidenceDocument: Readonly<Record<string, unknown>> = {},
): readonly string[] {
  const assessment = isRecord(evidenceDocument.source_assessment)
    ? evidenceDocument.source_assessment
    : {};
  const sharedDataset = normalizedSourceIdentity(assessment.shared_dataset_group);
  const syndication = normalizedSourceIdentity(assessment.syndication_group);
  const canonical = normalizedSourceIdentity(assessment.canonical_source_group);
  const profile = isRecord(source.source_profile) ? source.source_profile : {};
  const profiled =
    profile.type === "news"
      ? normalizedSourceIdentity(profile.publisher)
      : profile.type === "review"
        ? normalizedSourceIdentity(profile.platform)
        : profile.type === "api_dataset"
          ? normalizedSourceIdentity(profile.raw_provenance)
          : null;
  const sourceName = normalizedSourceIdentity(evidenceDocument.source_name);
  const provider = canonical ?? profiled ?? sourceName;
  const groups = [
    ...(sharedDataset === null ? [] : [`dataset:${sharedDataset}`]),
    ...(syndication === null ? [] : [`syndication:${syndication}`]),
    ...(provider === null ? [] : [`provider:${provider}`]),
  ];
  return groups.length > 0 ? groups : [`evidence:${String(source.evidence_ref ?? "unknown")}`];
}

export function canonicalSourceGroup(
  source: Readonly<Record<string, unknown>>,
  evidenceDocument: Readonly<Record<string, unknown>> = {},
): string {
  return sourceGroupIdentities(source, evidenceDocument)[0] as string;
}

export function deriveSourceConcentration(
  adopted: readonly Record<string, unknown>[],
  evidenceDocuments: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): {
  readonly concentrated: boolean;
  readonly dominantGroupCount: number;
  readonly dominantGroup: string | null;
} {
  const sourceGroups = adopted.map((source) =>
    sourceGroupIdentities(source, evidenceDocuments.get(String(source.evidence_ref)) ?? {}),
  );
  const groups = [...new Set(sourceGroups.flat())];
  const counts = groups.map((group) => ({
    group,
    count: sourceGroups.filter((candidate) => candidate.includes(group)).length,
  }));
  const dominant = counts.toSorted(
    (left, right) => right.count - left.count || left.group.localeCompare(right.group),
  )[0];
  return {
    concentrated: adopted.length >= 2 && (dominant?.count ?? 0) / adopted.length >= 0.75,
    dominantGroupCount: dominant?.count ?? 0,
    dominantGroup: dominant?.group ?? null,
  };
}

export function deriveRecommendationCeiling(
  coverage: Readonly<Record<string, unknown>>,
  quantitativeCoverage: readonly Record<string, unknown>[],
  competitiveObjects: readonly Record<string, unknown>[],
  evidence: readonly Record<string, unknown>[],
  semanticStatements: readonly Record<string, unknown>[] = [],
  evidenceDocuments: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): Record<string, unknown> {
  const reasons: string[] = [];
  let maximumDecisionTier = "prioritize";
  const purchase = isRecord(coverage.purchase_signal) ? coverage.purchase_signal : {};
  if (purchase.state !== "observed") {
    maximumDecisionTier = "investigate_further";
    reasons.push("missing_purchase_or_payment_signal");
  }
  const independentRefs = new Set(
    evidence
      .filter((item) => item.disposition === "adopted" && item.independence === "independent")
      .map((item) => String(item.evidence_ref)),
  );
  if (
    competitiveObjects.length === 0 ||
    competitiveObjects.every((item) =>
      strings(item.source_refs).every((ref) => !independentRefs.has(ref)),
    )
  ) {
    if (maximumDecisionTier === "prioritize") maximumDecisionTier = "investigate_further";
    reasons.push("missing_independent_competitor_adoption_data");
  }
  const retentionEntries = quantitativeCoverage.filter(
    (item) => item.metric_family === "retention_outcomes",
  );
  if (
    retentionEntries.length === 0 ||
    retentionEntries.every((item) => item.state !== "observed")
  ) {
    if (maximumDecisionTier === "prioritize") maximumDecisionTier = "investigate_further";
    reasons.push("missing_retention_evidence");
  }
  if (
    evidence.some(
      (item) =>
        item.disposition === "adopted" &&
        item.claim_type === "market_structure_regulatory" &&
        (dateOnly(item.regulatory_status_verified_at) === null ||
          item.regulatory_effective_status === undefined),
    )
  ) {
    maximumDecisionTier = "watch";
    reasons.push("regulatory_status_unconfirmed");
  }
  const adopted = evidence.filter((item) => item.disposition === "adopted");
  if (deriveSourceConcentration(adopted, evidenceDocuments).concentrated) {
    if (maximumDecisionTier === "prioritize") maximumDecisionTier = "investigate_further";
    reasons.push("source_concentration");
  }
  if (adopted.length > 0 && !adopted.some((item) => item.independence === "independent")) {
    if (maximumDecisionTier === "prioritize") maximumDecisionTier = "investigate_further";
    reasons.push("independent_cross_validation_missing");
  }
  if (
    adopted.length > 0 &&
    adopted.every(
      (item) =>
        (isRecord(item.source_profile) ? item.source_profile.type : null) === "news" &&
        item.claim_type === "current_market_change",
    )
  ) {
    maximumDecisionTier = "watch";
    reasons.push("news_trend_only");
  }
  const evidenceByRef = new Map(
    evidence
      .filter((item) => typeof item.evidence_ref === "string")
      .map((item) => [String(item.evidence_ref), item]),
  );
  if (
    semanticStatements.some((statement) =>
      strings(statement.evidence_refs).some((ref) => {
        const source = evidenceByRef.get(ref);
        return source?.disposition !== "adopted";
      }),
    )
  ) {
    maximumDecisionTier = "watch";
    reasons.push("positive_support_not_adopted");
  }
  return {
    maximum_decision_tier: maximumDecisionTier,
    reason_codes: [...new Set(reasons)].sort(),
  };
}

export function deriveSubjectRecommendationCeilings(
  coveredSubjectIds: readonly string[],
  globalCoverage: Readonly<Record<string, unknown>>,
  quantitativeCoverage: readonly Record<string, unknown>[],
  quantitativeObservations: readonly Record<string, unknown>[],
  competitiveObjects: readonly Record<string, unknown>[],
  evidence: readonly Record<string, unknown>[],
  semanticStatements: readonly Record<string, unknown>[] = [],
  evidenceDocuments: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): readonly Record<string, unknown>[] {
  const evidenceByRef = new Map(
    evidence
      .filter((item) => typeof item.evidence_ref === "string")
      .map((item) => [String(item.evidence_ref), item]),
  );
  return [...new Set(coveredSubjectIds)].sort().map((subjectId) => {
    const statements = semanticStatements.filter(
      (statement) =>
        statement.subject_id === subjectId ||
        (coveredSubjectIds.length === 1 && statement.subject_id === undefined),
    );
    const subjectRefs = new Set([
      ...quantitativeObservations
        .filter((observation) => observation.subject_id === subjectId)
        .flatMap((observation) => strings(observation.evidence_refs)),
      ...competitiveObjects
        .filter((competitiveObject) => competitiveObject.subject_id === subjectId)
        .flatMap((competitiveObject) => strings(competitiveObject.source_refs)),
      ...statements.flatMap((statement) => strings(statement.evidence_refs)),
    ]);
    const subjectEvidence =
      coveredSubjectIds.length === 1
        ? evidence
        : evidence.filter((item) => subjectRefs.has(String(item.evidence_ref)));
    const subjectCoverage =
      coveredSubjectIds.length === 1
        ? globalCoverage
        : deriveBusinessCoverage(subjectEvidence, evidenceByRef).coverage;
    const ceiling = deriveRecommendationCeiling(
      subjectCoverage,
      quantitativeCoverage.filter((coverage) => coverage.subject_id === subjectId),
      competitiveObjects.filter((competitiveObject) => competitiveObject.subject_id === subjectId),
      subjectEvidence,
      statements,
      evidenceDocuments,
    );
    return { subject_id: subjectId, ...ceiling };
  });
}

export function derivePortfolioRecommendationCeiling(
  subjectCeilings: readonly Record<string, unknown>[],
  semanticStatements: readonly Record<string, unknown>[] = [],
  evidence: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  const rank = { watch: 0, investigate_further: 1, prioritize: 2 } as const;
  let maximumDecisionTier = subjectCeilings.reduce<keyof typeof rank>((current, ceiling) => {
    const candidate = ceiling.maximum_decision_tier;
    return typeof candidate === "string" &&
      candidate in rank &&
      rank[candidate as keyof typeof rank] < rank[current]
      ? (candidate as keyof typeof rank)
      : current;
  }, "prioritize");
  const evidenceByRef = new Map(
    evidence
      .filter((item) => typeof item.evidence_ref === "string")
      .map((item) => [String(item.evidence_ref), item]),
  );
  const unboundPositiveSupportMissing = semanticStatements.some(
    (statement) =>
      statement.subject_id === undefined &&
      strings(statement.evidence_refs).some(
        (ref) => evidenceByRef.get(ref)?.disposition !== "adopted",
      ),
  );
  if (unboundPositiveSupportMissing) maximumDecisionTier = "watch";
  return {
    maximum_decision_tier: maximumDecisionTier,
    reason_codes: [
      ...new Set(subjectCeilings.flatMap((ceiling) => strings(ceiling.reason_codes))),
      ...(unboundPositiveSupportMissing ? ["positive_support_not_adopted"] : []),
    ].sort(),
  };
}

function directObservedSupport(
  item: Record<string, unknown>,
  key: string,
  aspect: unknown,
  evidenceByRef: ReadonlyMap<string, Record<string, unknown>>,
): boolean {
  if (
    item.disposition !== "adopted" ||
    !strings(item.coverage_keys).includes(key) ||
    item.source_kind === "academic" ||
    item.evidence_character === "inference" ||
    item.evidence_character === "mechanism" ||
    item.evidence_character === "effect_boundary" ||
    item.freshness_status === "undated" ||
    !isTraceableDirectSource(item, evidenceByRef)
  ) {
    return false;
  }
  if (!CLAIM_ASPECTS[String(item.claim_type)]?.includes(String(aspect))) return false;
  if (key !== "independent_counterevidence" && item.freshness_status !== "current") return false;
  if (item.source_kind === "vendor" || item.evidence_character === "vendor_claim") {
    return supportedCompanyClaim(item);
  }
  if (key === "independent_counterevidence") return item.independence === "independent";
  return (
    item.evidence_character === "observed_behavior" ||
    item.evidence_character === "independent_report"
  );
}

export function deriveBusinessCoverage(
  evidence: readonly Record<string, unknown>[],
  evidenceByRef: ReadonlyMap<string, Record<string, unknown>> = new Map(
    evidence
      .filter((item) => typeof item.evidence_ref === "string")
      .map((item) => [String(item.evidence_ref), item]),
  ),
): {
  readonly coverage: Readonly<Record<string, unknown>>;
  readonly directlyCovered: ReadonlySet<string>;
} {
  const coverage: Record<string, unknown> = {};
  const directlyCovered = new Set<string>();
  for (const key of REQUIRED_RANKING_KEYS) {
    const matching = evidence.filter(
      (item) => item.disposition === "adopted" && strings(item.coverage_keys).includes(key),
    );
    const dataPoints = matching.flatMap((item) =>
      (CLAIM_ASPECTS[String(item.claim_type)] ?? []).map((aspect) => ({
        evidence_ref: item.evidence_ref,
        aspect,
        fact_or_excerpt: item.content_summary,
      })),
    );
    const directPoints = dataPoints.filter((point) => {
      const source = evidenceByRef.get(String(point.evidence_ref));
      return (
        source !== undefined && directObservedSupport(source, key, point.aspect, evidenceByRef)
      );
    });
    const aspects = new Set(directPoints.map((point) => point.aspect));
    const directlyObserved =
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
    if (directlyObserved) directlyCovered.add(key);
    const refs = [...new Set(matching.map((item) => String(item.evidence_ref)))].sort();
    coverage[key] = directlyObserved
      ? {
          state: "observed",
          content_covered: true,
          evidence_refs: refs,
          data_points: directPoints,
          inference: null,
        }
      : refs.length > 0
        ? {
            state: "inferred",
            content_covered: true,
            evidence_refs: refs,
            data_points: [],
            inference: {
              basis_refs: refs,
              starting_point: `Evidence touching ${key} was found but did not directly observe every required aspect.`,
              reasoning:
                "The compiler preserves the material as a bounded inference and does not promote it to observed coverage.",
              uncertainty: "Direct current commercial observation remains incomplete.",
              validation_needed: `Obtain direct Evidence appropriate to ${key}.`,
            },
          }
        : {
            state: "unknown",
            content_covered: false,
            evidence_refs: [],
            data_points: [],
            inference: null,
          };
  }
  return { coverage, directlyCovered };
}

export function deriveClaimConfidence(
  requested: unknown,
  refs: readonly string[],
  evidenceByRef: ReadonlyMap<string, Record<string, unknown>>,
  quantitativeCoverage: readonly Record<string, unknown>[],
  competitiveCoverage: readonly Record<string, unknown>[],
  allEvidence: readonly Record<string, unknown>[],
  subjectId?: string,
): { readonly confidence: string; readonly reasons: readonly string[] } {
  const sources = refs.map((ref) => evidenceByRef.get(ref)).filter(isRecord);
  const reasons: string[] = [];
  let ceiling = 2;
  const relevantMetricFamilies = new Set(
    sources.flatMap((source) => [
      ...(CLAIM_METRIC_FAMILIES[String(source.claim_type)] ?? []),
      ...strings(source.coverage_keys).flatMap((key) => COVERAGE_KEY_METRIC_FAMILIES[key] ?? []),
    ]),
  );
  const subjectMatches = (coverage: Record<string, unknown>): boolean =>
    subjectId === undefined || coverage.subject_id === subjectId;
  const hasRelevantGap =
    quantitativeCoverage.some(
      (coverage) =>
        subjectMatches(coverage) &&
        relevantMetricFamilies.has(String(coverage.metric_family)) &&
        coverage.state !== "observed",
    ) ||
    (relevantMetricFamilies.has("competitive_intensity") &&
      competitiveCoverage.some(
        (coverage) => subjectMatches(coverage) && coverage.state !== "observed",
      ));
  if (hasRelevantGap) {
    ceiling = Math.min(ceiling, 1);
    reasons.push("claim_relevant_coverage_incomplete");
  }
  if (
    sources.some((source) => source.disposition !== "adopted") ||
    sources.length !== refs.length
  ) {
    ceiling = 0;
    reasons.push("positive_support_not_adopted");
  }
  const companyFactOnly = sources.length > 0 && sources.every(supportedCompanyClaim);
  if (
    sources.length === 0 ||
    (!companyFactOnly &&
      sources.every(
        (source) => source.source_kind === "vendor" || source.independence !== "independent",
      ))
  ) {
    ceiling = 0;
    reasons.push("independent_cross_validation_missing");
  }
  if (
    sources.some(
      (source) =>
        source.freshness_status !== "current" ||
        source.evidence_character === "inference" ||
        (!supportedCompanyClaim(source) && !isTraceableDirectSource(source, evidenceByRef)),
    )
  ) {
    ceiling = Math.min(ceiling, 1);
    reasons.push("direct_current_support_limited");
  }
  const sourceKeys = new Set(sources.flatMap((source) => strings(source.coverage_keys)));
  if (
    sourceKeys.size > 0 &&
    allEvidence.some(
      (source) =>
        source.disposition === "adopted" &&
        (source.evidence_character === "counterevidence" ||
          source.claim_type === "counterevidence") &&
        strings(source.coverage_keys).some((key) => sourceKeys.has(key)),
    )
  ) {
    ceiling = Math.min(ceiling, 1);
    reasons.push("conflicting_evidence_present");
  }
  const requestedRank = { low: 0, medium: 1, high: 2 }[String(requested)] ?? 0;
  return {
    confidence: ["low", "medium", "high"][Math.min(requestedRank, ceiling)] ?? "low",
    reasons: [...new Set(reasons)].sort(),
  };
}

function validateScopeAndStages(
  documents: readonly CommercialResearchDocument[],
  policy: CommercialResearchPolicy,
): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const documentsByPath = new Map(documents.map((entry) => [entry.path, entry]));
  const dispatches = documents.filter((entry) =>
    [
      "startup_opportunity.dispatch_batch.discovery.current",
      "startup_opportunity.dispatch_batch.assessment.current",
    ].includes(entry.schemaVersion),
  );
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
      const incumbentAssignment = isRecord(requirements.incumbent_response_assignment)
        ? requirements.incumbent_response_assignment
        : {};
      const targetRefs = incumbentTargetRefs(entry.document);
      const assignedRefs = strings(incumbentAssignment.subject_refs);
      const analysisDepth = incumbentAssignment.analysis_depth;
      const sourcePhase = entry.document.source_phase;
      const allowedIncumbentDepths =
        entry.schemaVersion === "startup_opportunity.research_task.discovery_candidate.current"
          ? sourcePhase === "candidate_generation"
            ? ["not_assigned"]
            : ["not_assigned", "lightweight_scan"]
          : entry.schemaVersion === "startup_opportunity.research_task.discovery_evaluation.current"
            ? ["not_assigned", "targeted_deep_dive"]
            : ["not_assigned", "targeted_deep_dive"];
      const assigned = analysisDepth !== "not_assigned";
      if (
        !allowedIncumbentDepths.includes(String(analysisDepth)) ||
        (assigned &&
          !["owner", "independent_review"].includes(String(incumbentAssignment.assignment_role))) ||
        (!assigned && incumbentAssignment.assignment_role !== "none")
      ) {
        errors.push(
          issue(
            "commercial_research.incumbent_response_stage_mismatch",
            `${entry.path}#/commercial_research_requirements/incumbent_response_assignment`,
            "incumbent response research must remain absent during candidate generation, use lightweight scans for formed candidates, and reserve targeted deep dives for retained opportunities or formed concepts",
            { allowedIncumbentDepths, actualDepth: analysisDepth, sourcePhase },
          ),
        );
      }
      if (!assigned ? assignedRefs.length !== 0 : !sameStringSet(assignedRefs, targetRefs)) {
        errors.push(
          issue(
            "commercial_research.incumbent_response_subject_binding_mismatch",
            `${entry.path}#/commercial_research_requirements/incumbent_response_assignment/subject_refs`,
            "an assigned incumbent response scan must bind the task's exact candidate, opportunity, or concept subject closure",
            { assignedRefs, targetRefs },
          ),
        );
      }
      const taskId = typeof entry.document.task_id === "string" ? entry.document.task_id : null;
      const unitId = typeof entry.document.unit_id === "string" ? entry.document.unit_id : null;
      const dispatchMatches = dispatches.flatMap((dispatch) =>
        records(dispatch.document.tasks)
          .filter(
            (task) =>
              task.task_id === taskId &&
              task.unit_id === unitId &&
              taskId !== null &&
              unitId !== null,
          )
          .map((task) => ({ dispatch, task })),
      );
      if (assigned && dispatchMatches.length !== 1) {
        errors.push(
          issue(
            "commercial_research.incumbent_response_dispatch_projection_missing",
            `${entry.path}#/commercial_research_requirements/incumbent_response_assignment`,
            "an assigned Research Task requires exactly one Dispatch projection bound by task_id and unit_id",
            { taskId, unitId, dispatchCount: dispatchMatches.length },
          ),
        );
      }
      if (dispatchMatches.length === 1) {
        const match = dispatchMatches[0];
        if (match !== undefined) {
          const planRef = String(match.dispatch.document.execution_plan_ref ?? "");
          const plan = documentsByPath.get(planRef)?.document;
          const stage = records(plan?.stages).find(
            (candidate) => candidate.stage_id === match.dispatch.document.stage_id,
          );
          const lane = records(stage?.lanes).find((candidate) => candidate.unit_id === unitId);
          const planAssignment = isRecord(lane?.incumbent_response_assignment)
            ? lane.incumbent_response_assignment
            : null;
          const dispatchAssignment = isRecord(match.task.incumbent_response_assignment)
            ? match.task.incumbent_response_assignment
            : null;
          if (planAssignment === null) {
            errors.push(
              issue(
                "commercial_research.incumbent_response_plan_projection_missing",
                `${entry.path}#/commercial_research_requirements/incumbent_response_assignment`,
                "Dispatch must resolve the exact Execution Plan stage and lane assignment",
                { planRef, stageId: match.dispatch.document.stage_id, unitId },
              ),
            );
          } else if (
            canonicalJson(planAssignment) !== canonicalJson(dispatchAssignment) ||
            canonicalJson(planAssignment) !== canonicalJson(incumbentAssignment)
          ) {
            errors.push(
              issue(
                "commercial_research.incumbent_response_assignment_projection_mismatch",
                `${entry.path}#/commercial_research_requirements/incumbent_response_assignment`,
                "Execution Plan is the assignment authority and its Dispatch and Task projections must match exactly",
                { expected: planAssignment },
              ),
            );
          }
        }
      }
      const expectedScanMode =
        expectedStage === policy.solution_neutral_stage ? "broad_scan" : "targeted_deep_dive";
      if (
        quantitativeScope.scan_mode !== expectedScanMode ||
        quantitativeScope.api_is_optional !== true ||
        quantitativeScope.provider_allowlist_enforced !== false ||
        quantitativeScope.acquisition_execution_owner !== "research_agent_or_caller" ||
        quantitativeScope.harness_hidden_network_calls !== false
      ) {
        errors.push(
          issue(
            "commercial_research.quantitative_competitive_scope_invalid",
            `${entry.path}#/commercial_research_requirements/quantitative_competitive_scope`,
            "research tasks must assign an explicit provider-agnostic quantitative and competitive scope at the stage-appropriate scan depth without hidden Harness acquisition",
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
  if (
    external &&
    audit.task_ref !== null &&
    queries.length === 0 &&
    closure.telemetry_basis !== "unavailable"
  ) {
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
        errors.push({
          ...issue(
            "commercial_research.regulatory_status_unverified",
            resultPath,
            adopted
              ? "an adopted result supporting a current regulatory judgment requires a verified effective state and verification timestamp"
              : "an unverified regulatory lead is retained only as background or a rejected candidate",
          ),
          severity: adopted ? "error" : "warning",
        });
      }
    }
  }
  const missingFromSearch =
    closure.query_log_complete === true
      ? [...adoptedEvidenceRefs].filter((ref) => !adoptedSearchRefs.has(ref))
      : [];
  const missingFromRegister = [...adoptedSearchRefs].filter((ref) => !adoptedEvidenceRefs.has(ref));
  if (missingFromSearch.length > 0 || missingFromRegister.length > 0) {
    errors.push(
      issue(
        "commercial_research.search_evidence_reconciliation",
        `${entry.path}#/search_closure`,
        "formally recorded search results must reconcile with the Evidence Register; a complete declared log must also cover every adopted Register record",
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
  const evidenceByRef = new Map(
    evidenceRegister
      .filter((item) => typeof item.evidence_ref === "string")
      .map((item) => [String(item.evidence_ref), item]),
  );
  const adoptedEvidenceRefs = new Set(
    evidenceRegister
      .filter((item) => item.disposition === "adopted" && typeof item.evidence_ref === "string")
      .map((item) => String(item.evidence_ref)),
  );
  const documentsByPath = new Map(documents.map((document) => [document.path, document]));
  const task =
    typeof audit.task_ref === "string" ? documentsByPath.get(String(audit.task_ref)) : undefined;
  const requirements = isRecord(task?.document.commercial_research_requirements)
    ? task.document.commercial_research_requirements
    : {};
  const hasAssignedScope = isRecord(requirements.quantitative_competitive_scope);
  const assignedScope = isRecord(requirements.quantitative_competitive_scope)
    ? requirements.quantitative_competitive_scope
    : {};
  const assignedMetricFamilies = strings(assignedScope.required_metric_families);
  const assignedCompetitorTypes = strings(assignedScope.required_competitor_types);

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
      errors.push({
        ...issue(
          "commercial_research.acquisition_evidence_not_adopted",
          `${acquisitionPath}/evidence_ref`,
          "the acquisition is retained, but rejected or unaudited Evidence cannot count as direct quantitative support",
          { evidenceRef },
        ),
        severity: "warning",
      });
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
      !strings(observation.evidence_refs).includes(String(acquisition?.evidence_ref ?? ""))
    ) {
      errors.push(
        issue(
          "commercial_research.quantitative_evidence_binding_mismatch",
          observationPath,
          "each quantitative observation must cite its exact acquisition Evidence",
        ),
      );
    }
    if (strings(observation.evidence_refs).some((ref) => !adoptedEvidenceRefs.has(ref))) {
      errors.push({
        ...issue(
          "commercial_research.quantitative_positive_support_not_adopted",
          observationPath,
          "the numeric observation is retained, but rejected or unaudited Evidence cannot establish direct coverage",
        ),
        severity: "warning",
      });
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
      assignedMetricFamilies.map((family) => `${subjectId}:${family}`),
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
    const directlyTraceableIds = ids.filter((id) => {
      const observation = observationsById.get(id);
      return (
        observation !== undefined &&
        strings(observation.evidence_refs).some((ref) => {
          const source = evidenceByRef.get(ref);
          return (
            source !== undefined &&
            source.disposition === "adopted" &&
            isTraceableDirectSource(source, evidenceByRef)
          );
        })
      );
    });
    const attempts = records(coverage.query_attempts);
    const state = String(coverage.state);
    const validState =
      ((state === "observed" || state === "partial") &&
        ids.length > 0 &&
        matchingIds.length === ids.length &&
        (state !== "partial" || typeof coverage.reason === "string")) ||
      (state === "unavailable" && ids.length === 0 && typeof coverage.reason === "string") ||
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
    if (state === "observed" && directlyTraceableIds.length === 0) {
      errors.push(
        issue(
          "commercial_research.quantitative_coverage_derivation_mismatch",
          coveragePath,
          "a coverage row may be observed only when at least one retained observation has adopted, traceable direct Evidence",
          { directlyTraceableIds, observationIds: ids },
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
    (hasAssignedScope &&
      canonicalJson([...actualQuantitativeCoverage].sort()) !==
        canonicalJson([...expectedQuantitativeCoverage].sort())) ||
    observations.some(
      (observation) => !referencedObservationIds.has(String(observation.observation_id)),
    )
  ) {
    errors.push(
      issue(
        "commercial_research.quantitative_coverage_incomplete",
        `${entry.path}#/quantitative_coverage`,
        "each covered direction must close only the metric families assigned by its Dispatch task, and every observation must belong to that closure",
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
      metricRefs.some((ref) => !observationsById.has(ref))
    ) {
      errors.push(
        issue(
          "commercial_research.competitive_object_binding_mismatch",
          objectPath,
          "competitive objects must bind the covered subject and known pricing/traction observations",
        ),
      );
    }
    if (strings(competitiveObject.source_refs).some((ref) => !adoptedEvidenceRefs.has(ref))) {
      errors.push({
        ...issue(
          "commercial_research.competitive_positive_support_not_adopted",
          objectPath,
          "the substitute observation is retained, but rejected or unaudited Evidence cannot establish direct coverage",
        ),
        severity: "warning",
      });
    }
  }

  const competitiveCoverage = records(audit.competitive_coverage);
  const expectedCompetitiveCoverage = new Set(
    coveredSubjects.flatMap((subjectId) =>
      assignedCompetitorTypes.map((type) => `${subjectId}:${type}`),
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
    const directlySupportedIds = matchingIds.filter((id) => {
      const competitiveObject = competitiveObjectsById.get(id);
      return strings(competitiveObject?.source_refs).some((ref) => adoptedEvidenceRefs.has(ref));
    });
    const attempts = records(coverage.query_attempts);
    const state = String(coverage.state);
    const validState =
      ((state === "observed" || state === "partial") &&
        ids.length > 0 &&
        matchingIds.length === ids.length &&
        (state !== "partial" || typeof coverage.reason === "string")) ||
      (state === "unavailable" && ids.length === 0 && typeof coverage.reason === "string") ||
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
    if (state === "observed" && directlySupportedIds.length === 0) {
      errors.push(
        issue(
          "commercial_research.competitive_coverage_derivation_mismatch",
          coveragePath,
          "competitive coverage may be observed only when at least one retained object has adopted Evidence",
          { directlySupportedIds, competitiveObjectIds: ids },
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
    (hasAssignedScope &&
      canonicalJson([...actualCompetitiveCoverage].sort()) !==
        canonicalJson([...expectedCompetitiveCoverage].sort())) ||
    competitiveObjects.some(
      (competitiveObject) =>
        !referencedCompetitiveObjectIds.has(String(competitiveObject.competitive_object_id)),
    )
  ) {
    errors.push(
      issue(
        "commercial_research.competitive_coverage_incomplete",
        `${entry.path}#/competitive_coverage`,
        "each covered direction must close only the competitor types assigned by its Dispatch task, and every named alternative must belong to that closure",
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
  const evidenceByRef = new Map(
    evidence
      .filter((item) => typeof item.evidence_ref === "string")
      .map((item) => [String(item.evidence_ref), item]),
  );
  const documentsByPath = new Map(documents.map((document) => [document.path, document]));
  const task =
    typeof audit.task_ref === "string" ? documentsByPath.get(audit.task_ref)?.document : undefined;
  const requirements = isRecord(task?.commercial_research_requirements)
    ? task.commercial_research_requirements
    : {};
  const taskAssignment = isRecord(requirements.incumbent_response_assignment)
    ? requirements.incumbent_response_assignment
    : {};
  const [dispatchPath = "", dispatchTaskId = ""] =
    typeof audit.dispatch_task_ref === "string" ? audit.dispatch_task_ref.split("#", 2) : [];
  const dispatch = documentsByPath.get(dispatchPath)?.document;
  const dispatchTask = records(dispatch?.tasks).find(
    (candidate) => candidate.task_id === dispatchTaskId && candidate.unit_id === audit.unit_id,
  );
  const executionPlan =
    typeof audit.execution_plan_ref === "string"
      ? documentsByPath.get(audit.execution_plan_ref)?.document
      : undefined;
  const executionStage = records(executionPlan?.stages).find(
    (candidate) => candidate.stage_id === dispatch?.stage_id,
  );
  const executionLane = records(executionStage?.lanes).find(
    (candidate) => candidate.unit_id === audit.unit_id,
  );
  const expectedAssignment = isRecord(executionLane?.incumbent_response_assignment)
    ? executionLane.incumbent_response_assignment
    : {};
  const dispatchAssignment = isRecord(dispatchTask?.incumbent_response_assignment)
    ? dispatchTask.incumbent_response_assignment
    : {};
  const actualAssignment = isRecord(audit.incumbent_response_assignment)
    ? audit.incumbent_response_assignment
    : {};
  const assignedSomewhere = [
    taskAssignment,
    dispatchAssignment,
    expectedAssignment,
    actualAssignment,
  ].some(
    (assignment) =>
      assignment.analysis_depth !== undefined && assignment.analysis_depth !== "not_assigned",
  );
  if (
    assignedSomewhere &&
    (audit.execution_plan_ref === null ||
      audit.dispatch_task_ref === null ||
      task === undefined ||
      dispatchTask === undefined ||
      executionLane === undefined)
  ) {
    errors.push(
      issue(
        "commercial_research.incumbent_response_lineage_incomplete",
        `${entry.path}#/incumbent_response_assignment`,
        "assigned response research requires exact Plan, Dispatch, Task, and Audit lineage",
        {
          executionPlanRef: audit.execution_plan_ref,
          dispatchTaskRef: audit.dispatch_task_ref,
          taskRef: audit.task_ref,
        },
      ),
    );
  }
  if (
    executionLane !== undefined &&
    [dispatchAssignment, taskAssignment, actualAssignment].some(
      (assignment) => canonicalJson(assignment) !== canonicalJson(expectedAssignment),
    )
  ) {
    errors.push(
      issue(
        "commercial_research.incumbent_response_assignment_mismatch",
        `${entry.path}#/incumbent_response_assignment`,
        "Execution Plan is the incumbent response assignment authority; Dispatch, Task, and Audit must be exact projections",
        { expected: expectedAssignment },
      ),
    );
  }
  const incumbentAssessments = records(audit.incumbent_response_assessments);
  const targetSubjectIds = incumbentTargetRefs(task ?? {}).map((ref) =>
    subjectIdFromRef(ref, documentsByPath),
  );
  if (actualAssignment.analysis_depth === "not_assigned" && incumbentAssessments.length > 0) {
    errors.push(
      issue(
        "commercial_research.incumbent_response_before_candidate",
        `${entry.path}#/incumbent_response_assessments`,
        "candidate-neutral work cannot contain incumbent absorption or response assessments",
      ),
    );
  }
  if (
    actualAssignment.analysis_depth === "not_assigned" &&
    records(audit.incumbent_response_coverage).length > 0
  ) {
    errors.push(
      issue(
        "commercial_research.incumbent_response_coverage_unassigned",
        `${entry.path}#/incumbent_response_coverage`,
        "an unassigned lane cannot publish incumbent response coverage",
      ),
    );
  }
  if (actualAssignment.analysis_depth !== "not_assigned") {
    const assessedSubjectIds = incumbentAssessments.flatMap((assessment) => {
      const semantic = isRecord(assessment.semantic) ? assessment.semantic : {};
      return typeof semantic.subject_id === "string" ? [semantic.subject_id] : [];
    });
    const missingSubjectIds = targetSubjectIds.filter(
      (subjectId) => !assessedSubjectIds.includes(subjectId),
    );
    const outOfScopeSubjectIds = assessedSubjectIds.filter(
      (subjectId) => !targetSubjectIds.includes(subjectId),
    );
    if (missingSubjectIds.length > 0 || outOfScopeSubjectIds.length > 0) {
      errors.push(
        issue(
          "commercial_research.incumbent_response_subject_binding_mismatch",
          `${entry.path}#/incumbent_response_assessments`,
          "each assigned subject must have an explicit assessed, unknown, or not-applicable response row and no row may cross subjects",
          { missingSubjectIds, outOfScopeSubjectIds },
        ),
      );
    }
    for (const [index, assessment] of incumbentAssessments.entries()) {
      const semantic = isRecord(assessment.semantic) ? assessment.semantic : {};
      const expectedId = stableId("incumbent_response", [audit.unit_id, semantic]);
      if (
        assessment.assessment_id !== expectedId ||
        assessment.analysis_depth !== actualAssignment.analysis_depth
      ) {
        errors.push(
          issue(
            "commercial_research.incumbent_response_derivation_mismatch",
            `${entry.path}#/incumbent_response_assessments/${index}`,
            "assessment identity and depth must be derived from the task assignment and submitted semantics",
            { expectedId, expectedDepth: actualAssignment.analysis_depth },
          ),
        );
      }
      const roleRefs = [
        ...strings(semantic.supporting_evidence_refs),
        ...strings(semantic.opposing_evidence_refs),
        ...strings(semantic.background_evidence_refs),
      ];
      const unregisteredRefs = roleRefs.filter((ref) => !evidenceByRef.has(ref));
      if (unregisteredRefs.length > 0) {
        errors.push(
          issue(
            "commercial_research.incumbent_response_evidence_unregistered",
            `${entry.path}#/incumbent_response_assessments/${index}/semantic`,
            "supporting, opposing, and background response Evidence must remain in the same Audit Evidence Register",
            { unregisteredRefs },
          ),
        );
      }
    }
    const expectedCoverage = targetSubjectIds
      .map((subjectId) => {
        const assessments = incumbentAssessments.filter((assessment) => {
          const semantic = isRecord(assessment.semantic) ? assessment.semantic : {};
          return semantic.subject_id === subjectId;
        });
        const states = assessments.map((assessment) => {
          const semantic = isRecord(assessment.semantic) ? assessment.semantic : {};
          return String(semantic.analysis_state);
        });
        const state = states.includes("unknown")
          ? "unknown"
          : states.includes("assessed")
            ? "assessed"
            : "not_applicable";
        const dataGaps = [
          ...new Set(
            assessments.flatMap((assessment) => {
              const semantic = isRecord(assessment.semantic) ? assessment.semantic : {};
              return semantic.analysis_state === "unknown" ? strings(semantic.data_gaps) : [];
            }),
          ),
        ].sort();
        return {
          subject_id: subjectId,
          analysis_depth: actualAssignment.analysis_depth,
          assignment_role: actualAssignment.assignment_role,
          state,
          assessment_ids: assessments.map((assessment) => assessment.assessment_id),
          reason:
            state === "unknown"
              ? "Assigned incumbent absorption and response risk remains unknown."
              : state === "not_applicable"
                ? "No relevant incumbent response assessment applies within the bounded scope."
                : null,
          data_gaps: dataGaps,
          decision_impact: "Context only; no automatic decision effect.",
          automatic_effects: {
            ranking_eligibility: false,
            claim_confidence: false,
            recommendation_ceiling: false,
            artifact_publication: false,
          },
        };
      })
      .sort((left, right) => String(left.subject_id).localeCompare(String(right.subject_id)));
    if (
      canonicalJson(records(audit.incumbent_response_coverage)) !== canonicalJson(expectedCoverage)
    ) {
      errors.push(
        issue(
          "commercial_research.incumbent_response_coverage_mismatch",
          `${entry.path}#/incumbent_response_coverage`,
          "incumbent response coverage must be the deterministic projection of assigned assessment states",
          { expected: expectedCoverage },
        ),
      );
    }
    const responseGapRows = expectedCoverage.filter((coverage) => coverage.state === "unknown");
    const closure = isRecord(audit.search_closure) ? audit.search_closure : {};
    const remainingGaps = strings(closure.remaining_gaps);
    const missingClosureGaps = responseGapRows.filter((coverage) =>
      coverage.data_gaps.some(
        (gap) =>
          !remainingGaps.includes(`Incumbent response coverage for ${coverage.subject_id}: ${gap}`),
      ),
    );
    if (
      missingClosureGaps.length > 0 ||
      (responseGapRows.length > 0 && closure.outcome !== "evidence_insufficient")
    ) {
      errors.push(
        issue(
          "commercial_research.incumbent_response_search_closure_gap_missing",
          `${entry.path}#/search_closure`,
          "unknown incumbent response coverage must remain visible in Search Closure without changing decision mechanics",
          { missingSubjectIds: missingClosureGaps.map((coverage) => coverage.subject_id) },
        ),
      );
    }
  }
  const adoptedRefs = new Set(adoptedByRef.keys());
  errors.push(...validateSearchClosure(entry, audit, adoptedRefs));

  const evidenceDocuments = new Map(
    documents.map((document) => [document.path, document.document]),
  );
  const concentration = deriveSourceConcentration(adopted, evidenceDocuments);
  if (concentration.concentrated) {
    errors.push(
      issue(
        "commercial_research.source_concentration",
        `${entry.path}#/evidence_register`,
        "adopted Evidence is concentrated in one canonical provider, shared dataset, or syndication group; conclusions remain usable but require a lower confidence or disposition ceiling",
        {
          adoptedSourceCount: adopted.length,
          dominantGroupCount: concentration.dominantGroupCount,
          dominantGroup: concentration.dominantGroup,
        },
      ),
    );
  }
  if (
    adopted.some((item) => item.source_kind === "vendor") &&
    !adopted.some((item) => item.independence === "independent")
  ) {
    errors.push(
      issue(
        "commercial_research.independent_cross_validation_missing",
        `${entry.path}#/evidence_register`,
        "vendor Evidence has no independent cross-validation; it may describe the vendor but cannot support a strong market conclusion",
      ),
    );
  }

  const expectedDistribution = deriveSourceDistribution(adopted, policy);
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
    const sourceProfile = isRecord(item.source_profile) ? item.source_profile : {};
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
    if (
      item.source_kind === "vendor" &&
      (sourceProfile.type !== "company_material" || !supportedCompanyClaim(item))
    ) {
      errors.push(
        issue(
          "commercial_research.vendor_claim_scope_invalid",
          `${itemPath}/source_profile`,
          "company material must declare whether it supports only public pricing, product capability, or the company's own statement",
        ),
      );
    }
    if (sourceProfile.type === "news") {
      const primaryRef =
        typeof sourceProfile.primary_data_ref === "string" ? sourceProfile.primary_data_ref : null;
      const traceable = isTraceableDirectSource(item, evidenceByRef);
      if (
        item.published_at !== sourceProfile.published_at ||
        (sourceProfile.primary_data_traceability_status === "traced" && !traceable) ||
        (sourceProfile.primary_data_traceability_status !== "traced" && primaryRef !== null)
      ) {
        errors.push(
          issue(
            "commercial_research.news_primary_traceability_mismatch",
            `${itemPath}/source_profile`,
            "news dates and traced primary-data status must be derived from an adopted API, dataset, regulatory, or official company Evidence ref",
            { primaryRef, traceable },
          ),
        );
      }
    }
    if (
      sourceProfile.type === "regulatory" &&
      (item.regulatory_effective_status !== sourceProfile.effective_status ||
        (item.regulatory_status_verified_at ?? null) !== sourceProfile.verified_at)
    ) {
      errors.push(
        issue(
          "commercial_research.regulatory_profile_derivation_mismatch",
          `${itemPath}/source_profile`,
          "formal regulatory status and verification time must exactly match the typed source profile",
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
    const adoptedForCurrentRegulatoryJudgment =
      item.disposition === "adopted" &&
      item.claim_type === "market_structure_regulatory" &&
      keys.length > 0;
    if (
      item.claim_type === "market_structure_regulatory" &&
      (dateOnly(item.regulatory_status_verified_at) === null ||
        !["effective", "partially_effective", "not_yet_effective", "repealed", "unknown"].includes(
          String(item.regulatory_effective_status),
        ))
    ) {
      errors.push({
        ...issue(
          "commercial_research.regulatory_status_unverified",
          itemPath,
          adoptedForCurrentRegulatoryJudgment
            ? "adopted Evidence used for a current regulatory judgment requires an effective-state observation and verification timestamp"
            : "unverified regulatory Evidence is retained only as a candidate, rejected source, or historical background",
        ),
        severity: adoptedForCurrentRegulatoryJudgment ? "error" : "warning",
      });
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
    const expectedFreshness = deriveFreshnessStatus(item, audit.audited_at, policy);
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

  const findings = records(audit.findings);
  const claims = records(audit.claims);
  const judgments = records(audit.judgments);
  const semanticStatements = [...findings, ...claims, ...judgments];
  for (const statement of semanticStatements) {
    if (
      typeof statement.subject_id === "string" &&
      !strings(audit.covered_direction_ids).includes(statement.subject_id)
    ) {
      errors.push(
        issue(
          "commercial_research.semantic_subject_out_of_scope",
          `${entry.path}#/covered_direction_ids`,
          "semantic statements may bind only a subject assigned to this Audit",
          { subjectId: statement.subject_id },
        ),
      );
    }
    for (const ref of strings(statement.evidence_refs)) {
      const source = evidenceByRef.get(ref);
      if (source === undefined) {
        errors.push(
          issue(
            "commercial_research.semantic_evidence_not_registered",
            `${entry.path}#/evidence_register`,
            "semantic Evidence is in the Run closure but absent from this Audit register, so it cannot count as audited direct support",
            { ref },
          ),
        );
      }
    }
  }
  for (const statement of [...claims, ...judgments]) {
    for (const ref of strings(statement.evidence_refs)) {
      const source = evidenceByRef.get(ref);
      if (source === undefined || source.disposition !== "adopted") {
        errors.push(
          issue(
            "commercial_research.positive_support_not_adopted",
            `${entry.path}#/evidence_register`,
            "rejected Evidence is retained but cannot count as direct positive Claim or Judgment support",
            { ref },
          ),
        );
      }
    }
  }
  for (const [claimIndex, claim] of claims.entries()) {
    const expected = deriveClaimConfidence(
      claim.requested_confidence,
      strings(claim.evidence_refs),
      evidenceByRef,
      records(audit.quantitative_coverage),
      records(audit.competitive_coverage),
      evidence,
      typeof claim.subject_id === "string" ? claim.subject_id : undefined,
    );
    if (
      claim.confidence !== expected.confidence ||
      canonicalJson(strings(claim.confidence_ceiling_reasons)) !== canonicalJson(expected.reasons)
    ) {
      errors.push(
        issue(
          "commercial_research.claim_confidence_mismatch",
          `${entry.path}#/claims/${claimIndex}`,
          "formal Claim confidence and reasons must equal the deterministic Evidence-local ceiling",
          { expected },
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
        evidenceItem !== undefined &&
        directObservedSupport(evidenceItem, key, dataPoint.aspect, evidenceByRef)
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
  const concentrated = concentration.concentrated;
  const hasIndependent = adopted.some((item) => item.independence === "independent");
  const expectedRanking =
    completeCoverage && !concentrated && hasIndependent ? "ranked" : "unranked_hypothesis";
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
  const expectedSubjectCeilings = deriveSubjectRecommendationCeilings(
    strings(audit.covered_direction_ids),
    coverage,
    records(audit.quantitative_coverage),
    records(audit.quantitative_observations),
    records(audit.competitive_objects),
    evidence,
    [...claims, ...judgments],
    evidenceDocuments,
  );
  if (
    canonicalJson(records(audit.subject_recommendation_ceilings)) !==
    canonicalJson(expectedSubjectCeilings)
  ) {
    errors.push(
      issue(
        "commercial_research.subject_recommendation_ceiling_mismatch",
        `${entry.path}#/subject_recommendation_ceilings`,
        "each formal subject ceiling must be derived only from Evidence, observations, statements, and Gaps bound to that subject",
        { expected: expectedSubjectCeilings },
      ),
    );
  }
  const expectedCeiling = derivePortfolioRecommendationCeiling(
    expectedSubjectCeilings,
    [...claims, ...judgments],
    evidence,
  );
  if (canonicalJson(audit.recommendation_ceiling ?? null) !== canonicalJson(expectedCeiling)) {
    errors.push(
      issue(
        "commercial_research.recommendation_ceiling_mismatch",
        `${entry.path}#/recommendation_ceiling`,
        "recommendation ceiling must be the deterministic consequence of decision-relevant research Gaps",
        { expected: expectedCeiling },
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
  const expectedProjection = projectCommercialAuditTables(audits);
  const documentsByPath = new Map(documents.map((document) => [document.path, document.document]));
  const subjectAliases = (subject: string): Set<string> => {
    const path = subject.split("#", 1)[0] ?? subject;
    const fragment = subject.includes("#") ? subject.split("#", 2)[1] : undefined;
    const basename = path
      .split("/")
      .at(-1)
      ?.replace(/\.json$/u, "");
    const target = documentsByPath.get(path) ?? {};
    return new Set(
      [
        subject,
        path,
        fragment,
        basename,
        target.opportunity_id,
        target.direction_id,
        target.candidate_id,
        target.concept_hypothesis_id,
        target.hypothesis_id,
      ].filter((value): value is string => typeof value === "string" && value !== ""),
    );
  };
  const reportDecisionSubjects = (report: CommercialResearchDocument): Set<string> => {
    if (report.schemaVersion === "startup_opportunity.concept_evidence_report.v1") {
      return typeof report.document.concept_hypothesis_ref === "string"
        ? subjectAliases(report.document.concept_hypothesis_ref)
        : new Set();
    }
    if (report.schemaVersion === "startup_opportunity.report.v1") {
      const context = isRecord(report.document.curated_judgment_context)
        ? report.document.curated_judgment_context
        : {};
      const selected = [
        ...(typeof context.recommended_first_bet === "string"
          ? [context.recommended_first_bet]
          : []),
        ...strings(report.document.top_opportunity_refs),
      ];
      return new Set(selected.flatMap((subject) => [...subjectAliases(subject)]));
    }
    if (report.document.mode === "concept_evidence_assessment") {
      const concepts = documents.filter((document) =>
        [
          "startup_opportunity.concept_hypothesis.assessment.current",
          "startup_opportunity.concept_hypothesis.assessment_intake.current",
        ].includes(document.schemaVersion),
      );
      if (concepts.length > 0) {
        return new Set(concepts.flatMap((concept) => [...subjectAliases(concept.path)]));
      }
    }
    const conclusion = isRecord(report.document.research_conclusion)
      ? report.document.research_conclusion
      : {};
    const selected = records(report.document.directions).filter(
      (direction) =>
        direction.action === "invest" ||
        direction.priority === 1 ||
        (direction.action === "validate" && conclusion.outcome === "investigate_further"),
    );
    return new Set(
      selected.flatMap((direction) =>
        typeof direction.direction_id === "string"
          ? [...subjectAliases(direction.direction_id)]
          : [],
      ),
    );
  };

  for (const report of documents.filter((entry) =>
    REPORT_SCHEMA_VERSIONS.has(entry.schemaVersion),
  )) {
    const reportAuditRefs = strings(report.document.commercial_research_audit_refs);
    const missingPlannedAudits = [...new Set(plannedAuditPaths)].filter(
      (auditPath) => !auditsByPath.has(auditPath),
    );
    if (
      !sameStringSet(reportAuditRefs, expectedProjection.commercial_research_audit_refs) ||
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
      expectedProjection.quantitative_signal_rows,
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
      expectedProjection.competitive_substitute_rows,
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
    const actualIncumbentRows = sortedProjection(
      report.document.incumbent_response_risk_rows,
      (row) =>
        `${String(row.audit_ref)}:${String(isRecord(row.assessment) ? row.assessment.assessment_id : "")}`,
    );
    const sortedExpectedIncumbentRows = sortedProjection(
      expectedProjection.incumbent_response_risk_rows,
      (row) =>
        `${String(row.audit_ref)}:${String(isRecord(row.assessment) ? row.assessment.assessment_id : "")}`,
    );
    if (canonicalJson(actualIncumbentRows) !== canonicalJson(sortedExpectedIncumbentRows)) {
      errors.push(
        issue(
          "commercial_research.report_incumbent_response_projection_mismatch",
          `${report.path}#/incumbent_response_risk_rows`,
          "the incumbent absorption and response risk table must be the exact, complete projection of cited commercial audits",
        ),
      );
    }
    const actualGapRows = sortedProjection(report.document.research_coverage_gaps, (row) => {
      const coverage = isRecord(row.coverage) ? row.coverage : {};
      const dimension =
        row.coverage_kind === "quantitative"
          ? coverage.metric_family
          : row.coverage_kind === "competitive"
            ? coverage.competitor_type
            : "response_risk";
      return `${String(row.audit_ref)}:${String(row.coverage_kind)}:${String(coverage.subject_id)}:${String(dimension)}`;
    });
    const sortedExpectedGapRows = sortedProjection(
      expectedProjection.research_coverage_gaps,
      (row) => {
        const coverage = isRecord(row.coverage) ? row.coverage : {};
        const dimension =
          row.coverage_kind === "quantitative"
            ? coverage.metric_family
            : row.coverage_kind === "competitive"
              ? coverage.competitor_type
              : "response_risk";
        return `${String(row.audit_ref)}:${String(row.coverage_kind)}:${String(coverage.subject_id)}:${String(dimension)}`;
      },
    );
    if (canonicalJson(actualGapRows) !== canonicalJson(sortedExpectedGapRows)) {
      errors.push(
        issue(
          "commercial_research.report_gap_projection_mismatch",
          `${report.path}#/research_coverage_gaps`,
          "formal reporting must show every quantitative, competitive, and unknown incumbent-response coverage gap with its decision impact",
        ),
      );
    }
    const ceilingRank = { watch: 0, investigate_further: 1, prioritize: 2 } as const;
    const decisionSubjects = reportDecisionSubjects(report);
    const relevantAudits = audits.filter((audit) => {
      const task =
        typeof audit.document.task_ref === "string"
          ? documentsByPath.get(audit.document.task_ref)
          : undefined;
      const auditSubjects = [
        ...strings(audit.document.covered_direction_ids),
        ...(typeof task?.target_subject_ref === "string" ? [task.target_subject_ref] : []),
        ...strings(task?.target_opportunity_refs),
        ...strings(task?.target_candidate_refs),
      ];
      return auditSubjects.some((subject) =>
        [...subjectAliases(subject)].some((alias) => decisionSubjects.has(alias)),
      );
    });
    const relevantSubjectCeilings = relevantAudits.flatMap((audit) =>
      records(audit.document.subject_recommendation_ceilings)
        .filter(
          (ceiling) =>
            typeof ceiling.subject_id === "string" &&
            [...subjectAliases(ceiling.subject_id)].some((alias) => decisionSubjects.has(alias)),
        )
        .map((ceiling) => ({ auditRef: audit.path, ceiling })),
    );
    const strictestCeiling = relevantSubjectCeilings.reduce<keyof typeof ceilingRank>(
      (current, entry) => {
        const ceiling = entry.ceiling.maximum_decision_tier;
        return typeof ceiling === "string" &&
          ceiling in ceilingRank &&
          ceilingRank[ceiling as keyof typeof ceilingRank] < ceilingRank[current]
          ? (ceiling as keyof typeof ceilingRank)
          : current;
      },
      "prioritize",
    );
    const reportTier =
      report.schemaVersion === "startup_opportunity.terminal_report_source.v1"
        ? isRecord(report.document.research_conclusion)
          ? report.document.research_conclusion.outcome
          : null
        : report.schemaVersion === "startup_opportunity.report.v1" &&
            isRecord(report.document.curated_judgment_context)
          ? report.document.curated_judgment_context.decision_tier
          : report.schemaVersion === "startup_opportunity.concept_evidence_report.v1" &&
              isRecord(report.document.curated_judgment_context)
            ? report.document.curated_judgment_context.assessment_result
            : null;
    const normalizedTier =
      reportTier === "prioritize"
        ? "prioritize"
        : reportTier === "investigate_further"
          ? "investigate_further"
          : "watch";
    if (ceilingRank[normalizedTier] > ceilingRank[strictestCeiling]) {
      errors.push(
        issue(
          "terminal_reporting.recommendation_ceiling_exceeded",
          `${report.path}#/research_conclusion`,
          "the report conclusion exceeds the deterministic ceiling imposed by unresolved commercial research Gaps",
          {
            reportTier,
            strictestCeiling,
            decisionSubjects: [...decisionSubjects].sort(),
            relevantAuditRefs: [...new Set(relevantSubjectCeilings.map((entry) => entry.auditRef))],
          },
        ),
      );
    }
    if (
      normalizedTier === "prioritize" &&
      decisionSubjects.size > 0 &&
      relevantSubjectCeilings.length === 0
    ) {
      errors.push(
        issue(
          "terminal_reporting.recommendation_ceiling_subject_unresolved",
          `${report.path}#/commercial_research_audit_refs`,
          "a prioritize conclusion requires at least one commercial Audit bound to the selected decision subject",
          { decisionSubjects: [...decisionSubjects].sort() },
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
            directObservedSupport(item, coverageKey, dataPoint.aspect, registerByRef)
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
  const auditIssues: ValidationIssue[] = [];
  const auditDocuments = documents.filter(
    (candidate) =>
      candidate.schemaVersion === "startup_opportunity.commercial_research_audit.current",
  );
  for (const entry of auditDocuments) {
    const currentIssues = validateAudit(entry, policy, documents, exactJsonlRecords);
    auditIssues.push(...currentIssues);
    errors.push(...currentIssues);
  }
  const reportProjectionIssues = validateCommercialReportProjections(documents);
  errors.push(...reportProjectionIssues);
  const expectedWarnings = projectGateWarnings([...auditIssues, ...reportProjectionIssues]);
  const compilerWarnings = auditDocuments.flatMap((entry) =>
    records(entry.document.compiler_warnings),
  );
  const allExpectedWarnings = [...expectedWarnings, ...compilerWarnings].toSorted((left, right) =>
    `${String(left.code)}:${String(left.message)}`.localeCompare(
      `${String(right.code)}:${String(right.message)}`,
    ),
  );
  for (const report of documents.filter((entry) =>
    REPORT_SCHEMA_VERSIONS.has(entry.schemaVersion),
  )) {
    const actualWarnings = records(report.document.gate_warnings).toSorted((left, right) =>
      `${String(left.code)}:${String(left.message)}`.localeCompare(
        `${String(right.code)}:${String(right.message)}`,
      ),
    );
    const missingWarnings = allExpectedWarnings.filter(
      (expected) =>
        !actualWarnings.some((actual) => canonicalJson(actual) === canonicalJson(expected)),
    );
    if (missingWarnings.length > 0) {
      errors.push(
        issue(
          "terminal_reporting.gate_warning_missing",
          `${report.path}#/gate_warnings`,
          "formal reporting must deterministically disclose every non-blocking commercial Gate with its decision impact",
          { expected: allExpectedWarnings, missing: missingWarnings },
        ),
      );
    }
  }
  return errors;
}

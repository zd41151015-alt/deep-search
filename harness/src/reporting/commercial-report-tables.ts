import { canonicalJson } from "../artifact-store/canonical.js";
import {
  INCUMBENT_RESPONSE_CONTEXT_ONLY,
  INCUMBENT_RESPONSE_STRATEGIC_CONTEXT,
  INCUMBENT_RESPONSE_STRATEGIC_CONTEXT_ZH,
} from "../incumbent-response-contract.js";
import { deriveSourceConcentration } from "../validators/commercial-source-concentration.js";
import {
  deriveMarketPriorityAndCommercialReadiness,
  hasDecisionGradeQuantitativeSignal,
  isFormalScopeDisposed,
  isQuantitativeCoverageFormallyComplete,
} from "../validators/quantitative-research-semantics.js";

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

interface ReportCitation {
  readonly evidence_ref: string;
  readonly label: string;
  readonly source_access: "public" | "user_provided_non_public";
  readonly url?: string;
  readonly canonical_uri?: string;
}

function reportCitations(
  source: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, ReportCitation> {
  return new Map(
    records(source.report_citations).flatMap((entry) =>
      typeof entry.evidence_ref === "string" &&
      typeof entry.label === "string" &&
      (entry.source_access === "public" || entry.source_access === "user_provided_non_public")
        ? [[entry.evidence_ref, entry as unknown as ReportCitation] as const]
        : [],
    ),
  );
}

function markdownLink(label: string, url: string): string {
  return `[${label.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${url.replaceAll(")", "%29")})`;
}

const ZH_LABELS: Readonly<Record<string, string>> = {
  active_users: "活跃用户",
  adjacent_product: "相邻产品",
  artifact: "研究材料",
  authorized_commercial_api: "已授权商业接口",
  baseline: "基线",
  broad_education_consumers: "广泛教育消费者",
  business: "商业",
  candidate_applied_practice_feedback: "实践反馈候选",
  candidate_learning_execution: "学习执行候选",
  candidate_lifelong_digital_help: "长期数字帮助候选",
  candidate_outcome_verification: "结果核验候选",
  candidate_purchase_decision: "购买决策候选",
  candidate_solution_execution_micro_coaching: "执行微教练方案",
  candidate_solution_outcome_milestone_check: "结果里程碑检查方案",
  candidate_solution_practice_expert_review: "实践专家审阅方案",
  candidate_solution_purchase_decision_dossier: "购买决策档案方案",
  commercial_behavior: "商业行为",
  comparable: "可比较",
  competitive: "竞争与替代",
  competitive_intensity: "竞争强度",
  competitor_count: "竞品数量",
  concept_evidence_assessment: "产品假设证据评估",
  counterfactual: "反向检验",
  demand_scale: "需求规模",
  direct_measurement: "直接测量",
  direct_product: "直接产品",
  disclosed: "公开披露",
  discovery_generation: "方向生成",
  distribution: "分发",
  distribution_reach: "分发覆盖",
  decision_grade: "决策级",
  directional_proxy: "方向性代理指标",
  context_only: "仅作背景",
  assessed: "已评估",
  unknown: "未知",
  lightweight_scan: "轻量扫描",
  targeted_deep_dive: "定向深入研究",
  not_assigned: "未分配",
  copy: "功能复制",
  bundle: "捆绑提供",
  native_integration: "原生集成",
  immediate: "立即",
  near_term: "近期",
  medium_term: "中期",
  long_term: "长期",
  single_feature: "单项功能",
  partial_workflow: "部分工作流",
  full_value_proposition: "完整价值主张",
  high: "高",
  medium: "中",
  low: "低",
  ready: "已就绪",
  not_ready: "未就绪",
  decision_grade_demand_signal: "存在决策级需求信号",
  directional_demand_signal: "存在方向性需求信号",
  current_user_language: "存在当前用户语言材料",
  competitive_scope_disposed: "竞争研究范围已处置",
  market_priority_signal_limited: "市场研究优先级信号有限",
  candidate_purchase_or_commitment: "候选方向付款或承诺",
  acquisition_or_distribution: "获客或分发",
  pricing: "定价",
  retention_or_usage: "留存或使用",
  downloadable_dataset: "可下载数据集",
  downloads: "下载量",
  estimated: "估算",
  estimate: "估算",
  estimate_not_observation: "估算而非直接观察",
  evidence: "证据",
  growth_change: "增长变化",
  growth_rate: "增长率",
  harness: "研究系统",
  independent_counterevidence: "独立反向证据",
  limited: "有限可比",
  manual_workaround: "人工替代",
  market_size: "市场规模",
  modeled: "模型推算",
  non_consumption: "不消费",
  not_applicable: "不适用",
  not_comparable: "不可比较",
  not_executed: "未执行",
  not_found: "未找到",
  observed: "已观察",
  official_dataset: "官方数据集",
  opportunity_discovery: "机会发现",
  other: "其他",
  outcome_rate: "结果达成率",
  paid_customers: "付费客户",
  paid_customers_estimate: "付费客户估算",
  partial: "部分覆盖",
  platform: "平台",
  price: "价格",
  proxy: "代理指标",
  public_api: "公开接口",
  purchase_count: "购买次数",
  quantitative: "量化",
  rank: "排名",
  rate_limited: "受到频率限制",
  rating_count: "评分数",
  repository_dataset: "仓库数据集",
  research: "研究",
  retention_outcomes: "留存与结果",
  retention_rate: "留存率",
  revenue: "收入",
  revenue_estimate: "收入估算",
  review_count: "评论数",
  runtime_blocked: "运行受阻",
  same_run: "同一研究批次",
  search_interest: "搜索兴趣",
  service: "服务",
  status_quo: "现状",
  transaction_count: "交易次数",
  unavailable: "不可用",
  unit_cost: "单位成本",
  unit_economics: "单位经济",
  unit_margin: "单位利润",
  unranked_hypothesis: "未排序待验证假设",
  usage_behavior: "使用行为",
  usage_frequency: "使用频次",
  user_provided_dataset: "用户提供的数据集",
  webpage: "网页",
  china_b2c_education_alternatives_baseline: "中国大陆 B2C 教育替代基线",
};

const ZH_INTERNAL_TEXT_REPLACEMENTS: readonly [RegExp, string][] = [
  [/\bsame[- ]run\b/giu, "同一研究批次"],
  [/\bpre[- ]thesis\b/giu, "前期产品假设"],
  [/\bbaseline\b/giu, "基线"],
  [/\bcounterfactual\b/giu, "反向检验"],
  [/\bevidence\b/giu, "证据"],
  [/\bharness\b/giu, "研究系统"],
  [/\bartifact\b/giu, "研究材料"],
  [/\bopportunity_discovery\b/giu, "机会发现"],
  [/\bconcept_evidence_assessment\b/giu, "产品假设证据评估"],
  [/\bassessment_early_kill\b/giu, "评估提前终止"],
  [/\bassessment_commercial\b/giu, "商业评估"],
  [/\bassessment_delivery\b/giu, "交付评估"],
  [/\bdiscovery_generation\b/giu, "方向生成"],
  [/\bcandidate_evaluation\b/giu, "候选评估"],
  [/\bruntime_blocked\b/giu, "运行受阻"],
  [/\bnot_executed\b/giu, "未执行"],
  [/\bunranked_hypothesis\b/giu, "未排序待验证假设"],
];

function zhText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const raw = String(value);
  const exact = ZH_LABELS[raw];
  if (exact !== undefined) return exact;
  return ZH_INTERNAL_TEXT_REPLACEMENTS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    raw,
  );
}

function display(value: unknown, zh: boolean): string {
  return zh ? zhText(value) : cell(value);
}

function subjectDisplay(
  source: Readonly<Record<string, unknown>>,
  subjectId: unknown,
  zh: boolean,
): string {
  const label = records(source.report_subject_labels).find(
    (entry) => entry.subject_id === subjectId,
  )?.label;
  return display(typeof label === "string" ? label : subjectId, zh);
}

function priorityDisplay(value: unknown, zh: boolean): string {
  if (!zh) return cell(value);
  return (
    ({ high: "高", medium: "中", low: "低" } as Readonly<Record<string, string>>)[String(value)] ??
    zhText(value)
  );
}

function readinessDisplay(value: unknown, zh: boolean): string {
  if (!zh) return cell(value);
  return (
    (
      { ready: "已就绪", partial: "部分就绪", not_ready: "未就绪" } as Readonly<
        Record<string, string>
      >
    )[String(value)] ?? zhText(value)
  );
}

function displayList(value: unknown, zh: boolean): string {
  const values = strings(value);
  return values.length === 0 ? "-" : values.map((entry) => display(entry, zh)).join("<br>");
}

function auditReferenceSummary(
  value: unknown,
  zh: boolean,
  recorded = false,
  citations: ReadonlyMap<string, ReportCitation> = new Map(),
): string {
  const refs = strings(value);
  if (refs.length === 0) return "-";
  const readable = refs.flatMap((ref) => {
    const citation = citations.get(ref);
    return citation === undefined
      ? []
      : citation.source_access === "public" && typeof citation.url === "string"
        ? [markdownLink(citation.label, citation.url)]
        : [
            zh
              ? `${citation.label}（用户提供/非公开）`
              : `${citation.label} (user-provided/non-public)`,
          ];
  });
  const hiddenCount = refs.length - readable.length;
  const auditLabel = zh
    ? `${recorded ? "已记录；" : ""}${hiddenCount} 条仅审计引用`
    : `${recorded ? "recorded; " : ""}${hiddenCount} audit-only reference${hiddenCount === 1 ? "" : "s"}`;
  return [
    ...readable,
    ...(hiddenCount === 0 ? [] : [markdownLink(auditLabel, "audit-appendix.md")]),
  ].join("<br>");
}

const REQUIRED_BUSINESS_DIMENSIONS = [
  "recent_user_language",
  "purchase_signal",
  "alternatives_pricing_usage",
  "distribution_channel",
  "independent_counterevidence",
] as const;

export interface CommercialTaskProjectionInput {
  readonly path: string;
  readonly document: Record<string, unknown>;
}

export interface CommercialAuditProjection {
  readonly commercial_research_audit_refs: readonly string[];
  readonly quantitative_signal_rows: readonly Record<string, unknown>[];
  readonly competitive_substitute_rows: readonly Record<string, unknown>[];
  readonly incumbent_response_risk_rows: readonly Record<string, unknown>[];
  readonly research_coverage_gaps: readonly Record<string, unknown>[];
  readonly commercial_subject_aggregates: readonly Record<string, unknown>[];
  readonly commercial_background_material: readonly Record<string, unknown>[];
  readonly commercial_research_status: Readonly<Record<string, unknown>>;
}

export interface CommercialAuditProjector {
  readonly project: (decisionSubjectIds?: readonly string[]) => CommercialAuditProjection;
  readonly diagnostics: () => {
    readonly projectionComputations: number;
    readonly cacheHits: number;
  };
}

export function createCommercialAuditProjector(
  audits: readonly { readonly path: string; readonly document: Record<string, unknown> }[],
  tasks: readonly CommercialTaskProjectionInput[] = [],
  documentsByPath: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): CommercialAuditProjector {
  const projections = new Map<string, CommercialAuditProjection>();
  let projectionComputations = 0;
  let cacheHits = 0;
  return {
    project(decisionSubjectIds) {
      const normalized =
        decisionSubjectIds === undefined ? undefined : [...new Set(decisionSubjectIds)].sort();
      const key = normalized === undefined ? "*" : canonicalJson(normalized);
      const cached = projections.get(key);
      if (cached !== undefined) {
        cacheHits += 1;
        return cached;
      }
      const projection = projectCommercialAuditTables(audits, tasks, documentsByPath, normalized);
      projections.set(key, projection);
      projectionComputations += 1;
      return projection;
    },
    diagnostics: () => ({ projectionComputations, cacheHits }),
  };
}

export function commercialProjectionRefs(source: Record<string, unknown>): readonly string[] {
  const status = isRecord(source.commercial_research_status)
    ? source.commercial_research_status
    : {};
  return [
    ...strings(source.commercial_research_audit_refs),
    ...records(source.quantitative_signal_rows).flatMap((row) => {
      const observation = isRecord(row.observation) ? row.observation : {};
      return [
        ...(typeof row.audit_ref === "string" ? [row.audit_ref] : []),
        ...strings(observation.evidence_refs),
      ];
    }),
    ...records(source.competitive_substitute_rows).flatMap((row) => {
      const competitiveObject = isRecord(row.competitive_object) ? row.competitive_object : {};
      return [
        ...(typeof row.audit_ref === "string" ? [row.audit_ref] : []),
        ...strings(competitiveObject.source_refs),
      ];
    }),
    ...records(source.incumbent_response_risk_rows).flatMap((row) => {
      const assessment = isRecord(row.assessment) ? row.assessment : {};
      const semantic = isRecord(assessment.semantic) ? assessment.semantic : {};
      return [
        ...(typeof row.audit_ref === "string" ? [row.audit_ref] : []),
        ...strings(semantic.supporting_evidence_refs),
        ...strings(semantic.opposing_evidence_refs),
        ...strings(semantic.background_evidence_refs),
      ];
    }),
    ...records(source.research_coverage_gaps).flatMap((row) => [
      ...(typeof row.audit_ref === "string" ? [row.audit_ref] : []),
      ...strings(row.audit_refs),
      ...(typeof row.task_ref === "string" ? [row.task_ref] : []),
      ...strings(row.task_refs),
    ]),
    ...records(source.commercial_subject_aggregates).flatMap((aggregate) => [
      ...strings(aggregate.audit_refs),
      ...strings(aggregate.task_refs),
      ...strings(aggregate.evidence_refs),
      ...strings(aggregate.conflict_evidence_refs),
      ...strings(aggregate.execution_warning_task_refs),
    ]),
    ...records(source.commercial_background_material).flatMap((material) => [
      ...(typeof material.audit_ref === "string" ? [material.audit_ref] : []),
      ...(typeof material.evidence_ref === "string" ? [material.evidence_ref] : []),
    ]),
    ...strings(status.planned_task_refs),
    ...strings(status.missing_task_refs),
    ...strings(status.submitted_audit_refs),
  ];
}

function subjectIdFromRef(
  ref: string,
  documentsByPath: ReadonlyMap<string, Record<string, unknown>>,
): string {
  const [targetPath = ref, fragment] = ref.split("#", 2);
  if (fragment !== undefined && fragment !== "") return fragment;
  const target = documentsByPath.get(targetPath) ?? {};
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

function taskSubjects(
  task: CommercialTaskProjectionInput,
  documentsByPath: ReadonlyMap<string, Record<string, unknown>>,
): readonly string[] {
  return [
    ...new Set([
      ...strings(task.document.target_opportunity_refs).map((ref) =>
        subjectIdFromRef(ref, documentsByPath),
      ),
      ...strings(task.document.target_candidate_refs).map((ref) =>
        subjectIdFromRef(ref, documentsByPath),
      ),
      ...(typeof task.document.target_subject_ref === "string"
        ? [subjectIdFromRef(task.document.target_subject_ref, documentsByPath)]
        : []),
    ]),
  ].sort();
}

function expectedAuditPath(task: CommercialTaskProjectionInput): string | null {
  const requirements = isRecord(task.document.commercial_research_requirements)
    ? task.document.commercial_research_requirements
    : {};
  return typeof requirements.commercial_audit_output_path === "string"
    ? requirements.commercial_audit_output_path
    : null;
}

function assignedDimensions(task: CommercialTaskProjectionInput): {
  readonly metricFamilies: readonly string[];
  readonly competitorTypes: readonly string[];
  readonly commercialDimensions: readonly string[];
} {
  const requirements = isRecord(task.document.commercial_research_requirements)
    ? task.document.commercial_research_requirements
    : {};
  const scope = isRecord(requirements.quantitative_competitive_scope)
    ? requirements.quantitative_competitive_scope
    : {};
  return {
    metricFamilies: strings(scope.required_metric_families),
    competitorTypes: strings(scope.required_competitor_types),
    commercialDimensions: strings(requirements.required_commercial_dimensions),
  };
}

function mergeBusinessCoverage(
  assessments: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return Object.fromEntries(
    REQUIRED_BUSINESS_DIMENSIONS.map((dimension) => {
      const entries = assessments
        .map((assessment) => (isRecord(assessment.coverage) ? assessment.coverage : {}))
        .map((coverage) => (isRecord(coverage[dimension]) ? coverage[dimension] : {}));
      const observed = entries.filter((entry) => entry.state === "observed");
      if (observed.length > 0) {
        return [
          dimension,
          {
            state: "observed",
            content_covered: true,
            evidence_refs: [
              ...new Set(observed.flatMap((entry) => strings(entry.evidence_refs))),
            ].sort(),
            data_points: observed.flatMap((entry) => records(entry.data_points)),
            inference: null,
          },
        ];
      }
      const inferred = entries.filter((entry) => entry.state === "inferred");
      if (inferred.length > 0) {
        const first = structuredClone(inferred[0] as Record<string, unknown>);
        const inference = isRecord(first.inference) ? first.inference : {};
        const refs = [...new Set(inferred.flatMap((entry) => strings(entry.evidence_refs)))].sort();
        return [
          dimension,
          {
            ...first,
            evidence_refs: refs,
            inference: { ...inference, basis_refs: refs },
          },
        ];
      }
      return [
        dimension,
        {
          state: "unknown",
          content_covered: false,
          evidence_refs: [],
          data_points: [],
          inference: null,
        },
      ];
    }),
  );
}

function mergeCoverageRows(
  rows: readonly Record<string, unknown>[],
  identityField: "metric_family" | "competitor_type",
  referenceField: "observation_ids" | "competitive_object_ids",
): Record<string, unknown> {
  const observed = rows.filter((row) => row.state === "observed");
  const partial = rows.filter((row) => row.state === "partial");
  const notApplicable = rows.filter((row) => row.state === "not_applicable");
  const selected = observed[0] ?? partial[0] ?? notApplicable[0] ?? rows[0] ?? {};
  const state =
    observed.length > 0
      ? "observed"
      : partial.length > 0
        ? "partial"
        : rows.length > 0 && notApplicable.length === rows.length
          ? "not_applicable"
          : "unavailable";
  return {
    ...structuredClone(selected),
    [identityField]: selected[identityField],
    state,
    [referenceField]: [...new Set(rows.flatMap((row) => strings(row[referenceField])))].sort(),
    ...(identityField === "metric_family"
      ? {
          decision_grade_observation_ids: [
            ...new Set(rows.flatMap((row) => strings(row.decision_grade_observation_ids))),
          ].sort(),
          acquisition_plan: rows.map((row) => row.acquisition_plan).find(isRecord) ?? null,
        }
      : {}),
    query_attempts: rows.flatMap((row) => records(row.query_attempts)),
    reason:
      state === "observed"
        ? null
        : (selected.reason ?? "No current Audit closed this assigned research dimension."),
    alternative_metric: state === "observed" ? null : (selected.alternative_metric ?? null),
    decision_impact:
      state === "observed"
        ? "Complementary current Audits closed this assigned dimension for the subject."
        : (selected.decision_impact ??
          "The unresolved assigned dimension limits subject ranking and recommendation strength."),
  };
}

function isCounterInterpretation(source: Readonly<Record<string, unknown>>): boolean {
  return source.evidence_character === "counterevidence" || source.claim_type === "counterevidence";
}

function evidenceInterpretationState(interpretations: readonly Record<string, unknown>[]): {
  readonly counterStates: ReadonlySet<boolean>;
  readonly dispositions: ReadonlySet<string>;
  readonly disagreement: boolean;
  readonly decisionActiveDisagreement: boolean;
  readonly adoptedCounter: boolean;
} {
  const counterStates = new Set(interpretations.map(isCounterInterpretation));
  const dispositions = new Set(interpretations.map((source) => String(source.disposition)));
  const disagreement = counterStates.size > 1 || dispositions.size > 1;
  const hasAdoptedInterpretation = interpretations.some(
    (source) => source.disposition === "adopted",
  );
  return {
    counterStates,
    dispositions,
    disagreement,
    decisionActiveDisagreement: disagreement && hasAdoptedInterpretation,
    adoptedCounter: interpretations.some(
      (source) => source.disposition === "adopted" && isCounterInterpretation(source),
    ),
  };
}

function evidenceInterpretationGroups(
  evidence: readonly Record<string, unknown>[],
): ReadonlyMap<string, readonly Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const source of evidence) {
    const ref = String(source.evidence_ref);
    groups.set(ref, [...(groups.get(ref) ?? []), source]);
  }
  return new Map(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ref, interpretations]) => [
        ref,
        interpretations.toSorted((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right)),
        ),
      ]),
  );
}

function canonicalEvidenceInterpretations(
  groups: ReadonlyMap<string, readonly Record<string, unknown>[]>,
): readonly Record<string, unknown>[] {
  return [...groups.values()].flatMap((interpretations) => {
    const adopted = interpretations.filter((source) => source.disposition === "adopted");
    const selected = adopted[0] ?? interpretations[0];
    return selected === undefined ? [] : [selected];
  });
}

function evidenceInterpretationLimitations(
  groups: ReadonlyMap<string, readonly Record<string, unknown>[]>,
): readonly string[] {
  const limitations: string[] = [];
  for (const [ref, interpretations] of groups) {
    const { counterStates, dispositions } = evidenceInterpretationState(interpretations);
    if (counterStates.size > 1) {
      limitations.push(
        `Evidence ${ref} has conflicting current Lane interpretations as supporting/contextual material and counterevidence.`,
      );
    }
    if (dispositions.size > 1) {
      limitations.push(
        `Evidence ${ref} has conflicting current Lane dispositions: ${[...dispositions].sort().join(", ")}.`,
      );
    }
  }
  return limitations.sort();
}

function aggregateRecommendationCeiling(input: {
  readonly coverage: Readonly<Record<string, unknown>>;
  readonly quantitativeCoverage: readonly Record<string, unknown>[];
  readonly quantitativeObservations: readonly Record<string, unknown>[];
  readonly competitiveObjects: readonly Record<string, unknown>[];
  readonly evidence: readonly Record<string, unknown>[];
  readonly canonicalEvidence: readonly Record<string, unknown>[];
  readonly laneAssessments: readonly Record<string, unknown>[];
  readonly unresolvedGaps: readonly Record<string, unknown>[];
  readonly evidenceDocuments: ReadonlyMap<string, Record<string, unknown>>;
}): Record<string, unknown> {
  const reasons: string[] = [];
  let tier: "prioritize" | "investigate_further" | "watch" = "prioritize";
  const purchase = isRecord(input.coverage.purchase_signal) ? input.coverage.purchase_signal : {};
  const uncoveredBusinessDimensions = REQUIRED_BUSINESS_DIMENSIONS.filter((dimension) => {
    const coverage = isRecord(input.coverage[dimension]) ? input.coverage[dimension] : {};
    return coverage.state !== "observed";
  });
  if (uncoveredBusinessDimensions.length > 0) {
    tier = "investigate_further";
    reasons.push("aggregate_business_coverage_incomplete");
  }
  if (purchase.state !== "observed") {
    tier = "investigate_further";
    reasons.push("missing_purchase_or_payment_signal");
  }
  if (
    !input.quantitativeCoverage.some(
      (row) =>
        row.metric_family === "retention_outcomes" &&
        row.state === "observed" &&
        isQuantitativeCoverageFormallyComplete(row, input.quantitativeObservations),
    )
  ) {
    if (tier === "prioritize") tier = "investigate_further";
    reasons.push("missing_retention_evidence");
  }
  const independentRefs = new Set(
    input.evidence
      .filter((source) => source.disposition === "adopted" && source.independence === "independent")
      .map((source) => String(source.evidence_ref)),
  );
  if (
    input.competitiveObjects.length === 0 ||
    !input.competitiveObjects.some((item) =>
      strings(item.source_refs).some((ref) => independentRefs.has(ref)),
    )
  ) {
    if (tier === "prioritize") tier = "investigate_further";
    reasons.push("missing_independent_competitor_adoption_data");
  }
  const adopted = input.evidence.filter((source) => source.disposition === "adopted");
  const canonicalAdopted = input.canonicalEvidence.filter(
    (source) => source.disposition === "adopted",
  );
  if (deriveSourceConcentration(canonicalAdopted, input.evidenceDocuments).concentrated) {
    if (tier === "prioritize") tier = "investigate_further";
    reasons.push("source_concentration");
  }
  if (adopted.length > 0 && independentRefs.size === 0) {
    if (tier === "prioritize") tier = "investigate_further";
    reasons.push("independent_cross_validation_missing");
  }
  if (
    input.evidence.some(
      (source) => source.disposition === "adopted" && isCounterInterpretation(source),
    )
  ) {
    if (tier === "prioritize") tier = "investigate_further";
    reasons.push("conflicting_evidence_present");
  }
  const interpretationGroups = evidenceInterpretationGroups(input.evidence);
  const decisionActiveDisagreement = [...interpretationGroups.values()].some(
    (interpretations) => evidenceInterpretationState(interpretations).decisionActiveDisagreement,
  );
  if (decisionActiveDisagreement) {
    if (tier === "prioritize") tier = "investigate_further";
    reasons.push("evidence_interpretation_disagreement");
  }
  if (input.unresolvedGaps.some((gap) => gap.state !== "not_applicable")) {
    if (tier === "prioritize") tier = "investigate_further";
    reasons.push("subject_research_gap_present");
  }
  if (
    adopted.length > 0 &&
    adopted.every((source) => {
      const profile = isRecord(source.source_profile) ? source.source_profile : {};
      return profile.type === "news" && source.claim_type === "current_market_change";
    })
  ) {
    tier = "watch";
    reasons.push("news_trend_only");
  }
  const hardLaneReasons = new Set(
    input.laneAssessments.flatMap((assessment) => {
      const ceiling = isRecord(assessment.recommendation_ceiling)
        ? assessment.recommendation_ceiling
        : {};
      return strings(ceiling.reason_codes).filter((reason) =>
        ["regulatory_status_unconfirmed", "positive_support_not_adopted"].includes(reason),
      );
    }),
  );
  if (hardLaneReasons.size > 0) tier = "watch";
  return {
    maximum_decision_tier: tier,
    reason_codes: [...new Set([...reasons, ...hardLaneReasons])].sort(),
  };
}

export function projectCommercialAuditTables(
  audits: readonly { readonly path: string; readonly document: Record<string, unknown> }[],
  tasks: readonly CommercialTaskProjectionInput[] = [],
  documentsByPath: ReadonlyMap<string, Record<string, unknown>> = new Map(),
  decisionSubjectIds?: readonly string[],
): CommercialAuditProjection {
  const sortedAudits = [...audits].sort((left, right) => left.path.localeCompare(right.path));
  const sortedTasks = [...tasks].sort((left, right) => left.path.localeCompare(right.path));
  const decisionSubjectSet = decisionSubjectIds === undefined ? null : new Set(decisionSubjectIds);
  const includesDecisionSubject = (subjectId: unknown): boolean =>
    decisionSubjectSet === null || decisionSubjectSet.has(String(subjectId));
  const relevantTasks =
    decisionSubjectSet === null
      ? sortedTasks
      : sortedTasks.filter((task) =>
          taskSubjects(task, documentsByPath).some((subjectId) =>
            decisionSubjectSet.has(subjectId),
          ),
        );
  const relevantAudits =
    decisionSubjectSet === null
      ? sortedAudits
      : sortedAudits.filter(
          (audit) =>
            records(audit.document.subject_assessments).some((assessment) =>
              includesDecisionSubject(assessment.subject_id),
            ) ||
            strings(audit.document.covered_direction_ids).some((subjectId) =>
              decisionSubjectSet.has(subjectId),
            ),
        );
  const quantitativeRows = sortedAudits.flatMap((audit) =>
    records(audit.document.quantitative_observations)
      .filter((observation) => includesDecisionSubject(observation.subject_id))
      .map((observation) => ({
        audit_ref: audit.path,
        observation,
      })),
  );
  const competitiveRows = sortedAudits.flatMap((audit) =>
    records(audit.document.competitive_objects)
      .filter((competitiveObject) => includesDecisionSubject(competitiveObject.subject_id))
      .map((competitiveObject) => ({
        audit_ref: audit.path,
        competitive_object: competitiveObject,
      })),
  );
  const incumbentResponseRows = sortedAudits.flatMap((audit) =>
    records(audit.document.incumbent_response_assessments)
      .filter((assessment) => {
        const semantic = isRecord(assessment.semantic) ? assessment.semantic : {};
        return includesDecisionSubject(semantic.subject_id);
      })
      .map((assessment) => {
        const projectedAssessment = structuredClone(assessment);
        const semantic = isRecord(projectedAssessment.semantic) ? projectedAssessment.semantic : {};
        return {
          audit_ref: audit.path,
          assessment: {
            ...projectedAssessment,
            semantic: {
              ...semantic,
              strategic_implication: INCUMBENT_RESPONSE_STRATEGIC_CONTEXT,
            },
          },
        };
      }),
  );
  const auditByExpectedPath = new Map(sortedAudits.map((audit) => [audit.path, audit]));
  const missingTasks = relevantTasks.filter((task) => {
    const expected = expectedAuditPath(task);
    return expected !== null && !auditByExpectedPath.has(expected);
  });
  const inferredTaskRefs =
    relevantTasks.length > 0
      ? relevantTasks.map((task) => task.path)
      : relevantAudits.flatMap((audit) =>
          typeof audit.document.task_ref === "string" ? [audit.document.task_ref] : [],
        );
  const subjectIds =
    decisionSubjectIds === undefined
      ? [
          ...new Set([
            ...sortedAudits.flatMap((audit) =>
              records(audit.document.subject_assessments).map((assessment) =>
                String(assessment.subject_id),
              ),
            ),
            ...sortedAudits.flatMap((audit) => strings(audit.document.covered_direction_ids)),
            ...sortedTasks.flatMap((task) => taskSubjects(task, documentsByPath)),
          ]),
        ].sort()
      : [...new Set(decisionSubjectIds)].sort();
  const gapRows: Record<string, unknown>[] = [];
  const subjectAggregates = subjectIds.map((subjectId) => {
    const subjectAudits = sortedAudits.filter((audit) =>
      records(audit.document.subject_assessments).some(
        (assessment) => assessment.subject_id === subjectId,
      ),
    );
    const laneAssessments = subjectAudits.flatMap((audit) =>
      records(audit.document.subject_assessments).filter(
        (assessment) => assessment.subject_id === subjectId,
      ),
    );
    const subjectTasks = sortedTasks.filter((task) =>
      taskSubjects(task, documentsByPath).includes(subjectId),
    );
    const taskRefs =
      subjectTasks.length > 0
        ? subjectTasks.map((task) => task.path)
        : subjectAudits.flatMap((audit) =>
            typeof audit.document.task_ref === "string" ? [audit.document.task_ref] : [],
          );
    const missingSubjectTasks = missingTasks.filter((task) =>
      taskSubjects(task, documentsByPath).includes(subjectId),
    );
    const assignedMetricFamilies = new Set(
      subjectTasks.length > 0
        ? subjectTasks.flatMap((task) => assignedDimensions(task).metricFamilies)
        : subjectAudits.flatMap((audit) =>
            records(audit.document.quantitative_coverage)
              .filter((row) => row.subject_id === subjectId)
              .map((row) => String(row.metric_family)),
          ),
    );
    const assignedCompetitorTypes = new Set(
      subjectTasks.length > 0
        ? subjectTasks.flatMap((task) => assignedDimensions(task).competitorTypes)
        : subjectAudits.flatMap((audit) =>
            records(audit.document.competitive_coverage)
              .filter((row) => row.subject_id === subjectId)
              .map((row) => String(row.competitor_type)),
          ),
    );
    const quantitativeCoverage = [...assignedMetricFamilies].sort().map((metricFamily) => {
      const rows = subjectAudits.flatMap((audit) =>
        records(audit.document.quantitative_coverage).filter(
          (row) => row.subject_id === subjectId && row.metric_family === metricFamily,
        ),
      );
      const merged: Record<string, unknown> = {
        ...mergeCoverageRows(rows, "metric_family", "observation_ids"),
        subject_id: subjectId,
        metric_family: metricFamily,
      };
      const subjectObservations = subjectAudits.flatMap((audit) =>
        records(audit.document.quantitative_observations).filter(
          (observation) => observation.subject_id === subjectId,
        ),
      );
      if (!isQuantitativeCoverageFormallyComplete(merged, subjectObservations)) {
        gapRows.push({
          audit_refs: subjectAudits.map((audit) => audit.path),
          task_refs: taskRefs,
          coverage_kind: "quantitative",
          coverage: merged,
          decision_relevance: merged.acquisition_plan === null ? "non_blocking" : "blocking",
        });
      }
      return merged;
    });
    const competitiveCoverage = [...assignedCompetitorTypes].sort().map((competitorType) => {
      const rows = subjectAudits.flatMap((audit) =>
        records(audit.document.competitive_coverage).filter(
          (row) => row.subject_id === subjectId && row.competitor_type === competitorType,
        ),
      );
      const merged: Record<string, unknown> = {
        ...mergeCoverageRows(rows, "competitor_type", "competitive_object_ids"),
        subject_id: subjectId,
        competitor_type: competitorType,
      };
      if (!isFormalScopeDisposed(merged.state)) {
        gapRows.push({
          audit_refs: subjectAudits.map((audit) => audit.path),
          task_refs: taskRefs,
          coverage_kind: "competitive",
          coverage: merged,
          decision_relevance: "non_blocking",
        });
      }
      return merged;
    });
    const coverage = mergeBusinessCoverage(laneAssessments);
    const uncovered = REQUIRED_BUSINESS_DIMENSIONS.filter((dimension) => {
      const entry = isRecord(coverage[dimension]) ? coverage[dimension] : {};
      return entry.state !== "observed";
    });
    const evidence = subjectAudits.flatMap((audit) =>
      records(audit.document.evidence_register).filter((source) =>
        strings(source.subject_ids).includes(subjectId),
      ),
    );
    const evidenceGroups = evidenceInterpretationGroups(evidence);
    const canonicalEvidence = canonicalEvidenceInterpretations(evidenceGroups);
    const interpretationLimitations = evidenceInterpretationLimitations(evidenceGroups);
    const subjectGapEntries = subjectAudits.flatMap((audit) => {
      const closure = isRecord(audit.document.search_closure) ? audit.document.search_closure : {};
      return records(closure.remaining_gaps)
        .filter((gap) => strings(gap.subject_ids).includes(subjectId))
        .map((gap) => ({ audit, gap }));
    });
    const genericGapEntries = subjectGapEntries.filter(({ gap }) =>
      ["business", "research"].includes(String(gap.coverage_kind)),
    );
    const currentGenericGapEntries = genericGapEntries.filter(({ gap }) => {
      if (gap.coverage_kind !== "business") return true;
      const candidateCoverage = coverage[String(gap.dimension)];
      const dimensionCoverage: Record<string, unknown> = isRecord(candidateCoverage)
        ? candidateCoverage
        : {};
      return dimensionCoverage.state !== "observed";
    });
    for (const { audit, gap } of currentGenericGapEntries) {
      gapRows.push({
        audit_refs: [audit.path],
        task_refs: [
          ...(typeof gap.task_ref === "string"
            ? [gap.task_ref]
            : typeof audit.document.task_ref === "string"
              ? [audit.document.task_ref]
              : []),
        ],
        coverage_kind: gap.coverage_kind,
        subject_ids: [subjectId],
        dimension: gap.dimension,
        state: gap.state,
        reason: gap.reason,
        alternative_metric: gap.alternative_metric,
        decision_impact: gap.decision_impact,
        decision_relevance: gap.decision_relevance ?? "non_blocking",
        query_attempts: records(gap.query_attempts),
      });
    }
    const unresolvedGenericGaps = currentGenericGapEntries
      .map(({ gap }) => gap)
      .filter((gap) => gap.state !== "not_applicable");
    const hasIncumbentResponseGap = subjectAudits.some((audit) =>
      records(audit.document.incumbent_response_coverage).some(
        (responseCoverage) =>
          responseCoverage.subject_id === subjectId && responseCoverage.state === "unknown",
      ),
    );
    const competitiveObjects = subjectAudits.flatMap((audit) =>
      records(audit.document.competitive_objects).filter((item) => item.subject_id === subjectId),
    );
    const ceiling = aggregateRecommendationCeiling({
      coverage,
      quantitativeCoverage,
      quantitativeObservations: subjectAudits.flatMap((audit) =>
        records(audit.document.quantitative_observations).filter(
          (observation) => observation.subject_id === subjectId,
        ),
      ),
      competitiveObjects,
      evidence,
      canonicalEvidence,
      laneAssessments,
      unresolvedGaps: unresolvedGenericGaps,
      evidenceDocuments: documentsByPath,
    });
    const quantitativeObservations = subjectAudits.flatMap((audit) =>
      records(audit.document.quantitative_observations).filter(
        (observation) => observation.subject_id === subjectId,
      ),
    );
    const priorityAndReadiness = deriveMarketPriorityAndCommercialReadiness({
      coverage,
      quantitativeCoverage,
      quantitativeObservations,
      competitiveCoverage,
    });
    const conflicts = [...evidenceGroups.entries()]
      .filter(([, interpretations]) => {
        const state = evidenceInterpretationState(interpretations);
        return state.adoptedCounter || state.decisionActiveDisagreement;
      })
      .map(([ref]) => ref)
      .sort();
    const adopted = canonicalEvidence.filter((source) => source.disposition === "adopted");
    const completeDimensions =
      uncovered.length === 0 &&
      quantitativeCoverage.every((row) =>
        isQuantitativeCoverageFormallyComplete(row, quantitativeObservations),
      ) &&
      competitiveCoverage.every((row) => isFormalScopeDisposed(row.state)) &&
      unresolvedGenericGaps.length === 0;
    if (subjectTasks.length === 0 && subjectAudits.length === 0) {
      gapRows.push({
        audit_refs: [],
        task_refs: [],
        coverage_kind: "research",
        subject_ids: [subjectId],
        dimension: "commercial_research",
        state: "unavailable",
        reason: "No current commercial research task or Audit is bound to this decision subject.",
        alternative_metric: null,
        decision_impact:
          "The subject remains visible, but its commercial evidence coverage is unknown and cannot be borrowed from another subject.",
        decision_relevance: "blocking",
        query_attempts: [],
      });
    }
    return {
      subject_id: subjectId,
      audit_refs: subjectAudits.map((audit) => audit.path),
      task_refs: [...new Set(taskRefs)].sort(),
      evidence_refs: [...evidenceGroups.keys()],
      coverage,
      uncovered_business_dimensions: uncovered,
      quantitative_coverage: quantitativeCoverage,
      competitive_coverage: competitiveCoverage,
      wave1_signals: {
        demand:
          (isRecord(coverage.recent_user_language)
            ? coverage.recent_user_language.state === "observed"
            : false) ||
          hasDecisionGradeQuantitativeSignal(
            quantitativeCoverage,
            ["demand_scale", "growth_change"],
            quantitativeObservations,
          ),
        buyer: laneAssessments.some(
          (assessment) =>
            isRecord(assessment.wave1_signals) && assessment.wave1_signals.buyer === true,
        ),
        purchase: isRecord(coverage.purchase_signal)
          ? coverage.purchase_signal.state === "observed"
          : false,
      },
      ranking_eligibility:
        completeDimensions &&
        adopted.some((source) => source.independence === "independent") &&
        !strings(ceiling.reason_codes).includes("source_concentration")
          ? "ranked"
          : "unranked_hypothesis",
      recommendation_ceiling: ceiling,
      ...priorityAndReadiness,
      conflict_evidence_refs: conflicts,
      limitations: [
        ...new Set(
          subjectAudits.flatMap((audit) => [
            ...strings(audit.document.limitations),
            ...unresolvedGenericGaps.map((gap) => String(gap.reason)),
            ...interpretationLimitations,
          ]),
        ),
      ].sort(),
      research_status:
        subjectTasks.length === 0 && subjectAudits.length === 0
          ? "not_planned"
          : missingSubjectTasks.length > 0 && subjectAudits.length === 0
            ? "planned_but_missing"
            : missingSubjectTasks.length > 0 || !completeDimensions || hasIncumbentResponseGap
              ? "planned_with_gaps"
              : "complete",
      execution_warning_task_refs: missingSubjectTasks.map((task) => task.path),
    };
  });
  for (const audit of sortedAudits) {
    for (const coverage of records(audit.document.incumbent_response_coverage).filter(
      (entry) => entry.state === "unknown" && includesDecisionSubject(entry.subject_id),
    )) {
      gapRows.push({
        audit_ref: audit.path,
        coverage_kind: "incumbent_response",
        coverage,
        decision_relevance: "context_only",
      });
    }
  }
  for (const task of missingTasks) {
    const dimensions = assignedDimensions(task);
    const subjects = taskSubjects(task, documentsByPath).filter((subjectId) =>
      includesDecisionSubject(subjectId),
    );
    if (subjects.length === 0) continue;
    gapRows.push({
      task_ref: task.path,
      coverage_kind: "execution",
      subject_ids: subjects,
      state: "unavailable",
      reason: "The planned commercial research task has no current valid Audit artifact.",
      decision_impact:
        "Execution remains incomplete; only assigned dimensions not closed by another current Audit constrain a subject conclusion.",
      decision_relevance: "blocking",
      assigned_metric_families: dimensions.metricFamilies,
      assigned_competitor_types: dimensions.competitorTypes,
      assigned_commercial_dimensions: dimensions.commercialDimensions,
    });
  }
  for (const audit of decisionSubjectSet === null ? sortedAudits : []) {
    const closure = isRecord(audit.document.search_closure) ? audit.document.search_closure : {};
    for (const gap of records(closure.remaining_gaps).filter(
      (candidate) =>
        strings(candidate.subject_ids).length === 0 &&
        ["business", "research"].includes(String(candidate.coverage_kind)),
    )) {
      gapRows.push({
        audit_refs: [audit.path],
        task_refs:
          typeof gap.task_ref === "string"
            ? [gap.task_ref]
            : typeof audit.document.task_ref === "string"
              ? [audit.document.task_ref]
              : [],
        coverage_kind: gap.coverage_kind,
        subject_ids: [],
        dimension: gap.dimension,
        state: gap.state,
        reason: gap.reason,
        alternative_metric: gap.alternative_metric,
        decision_impact: gap.decision_impact,
        decision_relevance: gap.decision_relevance ?? "non_blocking",
        query_attempts: records(gap.query_attempts),
      });
    }
  }
  const backgroundMaterial = sortedAudits.flatMap((audit) =>
    records(audit.document.evidence_register)
      .filter((source) => source.subject_binding_basis === "unbound")
      .map((source) => ({
        audit_ref: audit.path,
        evidence_ref: source.evidence_ref,
        subject_binding_basis: "unbound",
      })),
  );
  const rowKey = (row: Record<string, unknown>): string => {
    const coverage = isRecord(row.coverage) ? row.coverage : {};
    return row.coverage_kind === "execution"
      ? `execution:${String(row.task_ref)}`
      : ["business", "research"].includes(String(row.coverage_kind))
        ? `${strings(row.audit_refs).join(",")}:${String(row.coverage_kind)}:${strings(row.subject_ids).join(",")}:${String(row.dimension)}:${String(row.reason)}`
        : row.coverage_kind === "incumbent_response"
          ? `${String(row.audit_ref)}:incumbent_response:${String(coverage.subject_id)}:response_risk`
          : `${strings(row.audit_refs).join(",")}:${String(row.coverage_kind)}:${String(coverage.subject_id)}:${String(coverage.metric_family ?? coverage.competitor_type)}`;
  };
  return {
    commercial_research_audit_refs: sortedAudits.map((audit) => audit.path),
    quantitative_signal_rows: quantitativeRows.sort((left, right) =>
      `${left.audit_ref}:${String((left.observation as Record<string, unknown>).observation_id)}`.localeCompare(
        `${right.audit_ref}:${String((right.observation as Record<string, unknown>).observation_id)}`,
      ),
    ),
    competitive_substitute_rows: competitiveRows.sort((left, right) =>
      `${left.audit_ref}:${String((left.competitive_object as Record<string, unknown>).competitive_object_id)}`.localeCompare(
        `${right.audit_ref}:${String((right.competitive_object as Record<string, unknown>).competitive_object_id)}`,
      ),
    ),
    incumbent_response_risk_rows: incumbentResponseRows.sort((left, right) =>
      `${left.audit_ref}:${String((left.assessment as Record<string, unknown>).assessment_id)}`.localeCompare(
        `${right.audit_ref}:${String((right.assessment as Record<string, unknown>).assessment_id)}`,
      ),
    ),
    research_coverage_gaps: gapRows.sort((left, right) =>
      rowKey(left).localeCompare(rowKey(right)),
    ),
    commercial_subject_aggregates: subjectAggregates,
    commercial_background_material: backgroundMaterial.sort((left, right) =>
      `${left.audit_ref}:${String(left.evidence_ref)}`.localeCompare(
        `${right.audit_ref}:${String(right.evidence_ref)}`,
      ),
    ),
    commercial_research_status: {
      state:
        relevantTasks.length === 0 && relevantAudits.length === 0
          ? "not_planned"
          : missingTasks.length > 0 && relevantAudits.length === 0
            ? "planned_but_missing"
            : missingTasks.length > 0 ||
                subjectAggregates.some((aggregate) => aggregate.research_status !== "complete")
              ? "planned_with_gaps"
              : "complete",
      planned_task_refs: [...new Set(inferredTaskRefs)].sort(),
      missing_task_refs: missingTasks.map((task) => task.path),
      submitted_audit_refs: sortedAudits.map((audit) => audit.path),
    },
  };
}

function graded(value: unknown, zh: boolean): string {
  if (!isRecord(value)) return "-";
  return `${display(value.level, zh)}: ${display(value.rationale, zh)}`;
}

export function renderIncumbentResponseDisclosure(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const count = records(source.incumbent_response_risk_rows).length;
  const countText = zh
    ? `已形成 ${count} 条风险评估。`
    : `${count} risk assessment${count === 1 ? "" : "s"} formed.`;
  return `- ${countText} ${zh ? INCUMBENT_RESPONSE_STRATEGIC_CONTEXT_ZH : INCUMBENT_RESPONSE_STRATEGIC_CONTEXT}\n`;
}

function responderNarrativeRows(
  source: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, readonly Record<string, unknown>[]> {
  const bySubject = new Map<string, Record<string, unknown>[]>();
  for (const row of records(source.incumbent_response_risk_rows)) {
    const assessment = isRecord(row.assessment) ? row.assessment : {};
    const semantic = isRecord(assessment.semantic) ? assessment.semantic : {};
    if (typeof semantic.subject_id !== "string") continue;
    bySubject.set(semantic.subject_id, [...(bySubject.get(semantic.subject_id) ?? []), row]);
  }
  return bySubject;
}

export function renderIncumbentResponseNarratives(
  source: Readonly<{
    readonly incumbent_response_risk_rows?: unknown;
    readonly current_decision_subject_ids?: unknown;
    readonly report_subject_labels?: unknown;
    readonly report_citations?: unknown;
  }>,
  zh = false,
): string {
  const report = source as Readonly<Record<string, unknown>>;
  const citations = reportCitations(report);
  const rowsBySubject = responderNarrativeRows(report);
  const explicitSubjects = strings(source.current_decision_subject_ids);
  const labelledSubjects = records(source.report_subject_labels).flatMap((entry) =>
    typeof entry.subject_id === "string" ? [entry.subject_id] : [],
  );
  const subjectIds = [
    ...new Set(
      explicitSubjects.length > 0
        ? explicitSubjects
        : labelledSubjects.length > 0
          ? labelledSubjects
          : [...rowsBySubject.keys()],
    ),
  ].sort();
  const parts = [
    zh
      ? `> ${INCUMBENT_RESPONSE_STRATEGIC_CONTEXT_ZH} 能力邻近度不等于响应意愿；可复制单项功能不等于覆盖完整产品主张。\n`
      : `> ${INCUMBENT_RESPONSE_STRATEGIC_CONTEXT} Capability adjacency is not willingness to respond, and copying one feature is not coverage of the full product thesis.\n`,
  ];
  if (subjectIds.length === 0) {
    parts.push(
      zh
        ? "\n- 未分配或未提交最终研究对象的头部公司响应研究；该项保持未知。\n"
        : "\n- No incumbent-response research was assigned or submitted for a final subject; this context remains unknown.\n",
    );
    return parts.join("");
  }
  for (const subjectId of subjectIds) {
    parts.push(`\n### ${subjectDisplay(report, subjectId, zh)}\n`);
    const rows = rowsBySubject.get(subjectId) ?? [];
    if (rows.length === 0) {
      parts.push(
        zh
          ? "- 未提交该最终研究对象的响应研究；不得从历史、被取代或同级对象借用结论。\n"
          : "- No responder research was submitted for this final subject; conclusions cannot be borrowed from historical, superseded, or sibling subjects.\n",
      );
      continue;
    }
    for (const row of rows) {
      const assessment = isRecord(row.assessment) ? row.assessment : {};
      const semantic = isRecord(assessment.semantic) ? assessment.semantic : {};
      const state = String(semantic.analysis_state);
      if (state === "not_applicable") {
        parts.push(
          `- ${zh ? "不适用" : "Not applicable"}: ${display(semantic.inference_boundary, zh)}\n`,
        );
        parts.push(
          zh
            ? "  - 能力、响应成本、意愿与自我蚕食、响应方式、时间、分发杠杆、产品主张覆盖及剩余差异化在该边界内均保持不适用。\n"
            : "  - Capability, response costs, willingness and cannibalization, response modes, horizon, distribution leverage, thesis coverage, and residual differentiation all remain not applicable within this boundary.\n",
        );
        parts.push(
          `  - ${zh ? "背景来源" : "Background sources"}: ${auditReferenceSummary(semantic.background_evidence_refs, zh, false, citations)}\n`,
        );
        continue;
      }
      if (state === "unknown") {
        parts.push(
          `- ${zh ? "状态" : "State"}: ${zh ? "未知" : "unknown"}. ${display(semantic.uncertainty, zh)}\n`,
        );
        parts.push(
          `  - ${zh ? "推理边界" : "Inference boundary"}: ${display(semantic.inference_boundary, zh)}\n`,
        );
        parts.push(
          zh
            ? "  - 能力、响应成本、意愿与自我蚕食、响应方式、时间、分发杠杆、产品主张覆盖及剩余差异化均保持未知，不能由现有材料补推。\n"
            : "  - Capability, response costs, willingness and cannibalization, response modes, horizon, distribution leverage, thesis coverage, and residual differentiation all remain unknown and cannot be filled in from the available material.\n",
        );
        parts.push(
          `  - ${zh ? "现有材料角色" : "Available material roles"}: ${zh ? "支持" : "supporting"} ${auditReferenceSummary(semantic.supporting_evidence_refs, zh, false, citations)}; ${zh ? "反证" : "opposing"} ${auditReferenceSummary(semantic.opposing_evidence_refs, zh, false, citations)}; ${zh ? "背景" : "background"} ${auditReferenceSummary(semantic.background_evidence_refs, zh, false, citations)}.\n`,
        );
        parts.push(
          `  - ${zh ? "未知与缺口" : "Unknowns and gaps"}: ${displayList(semantic.unknowns, zh)}; ${displayList(semantic.data_gaps, zh)}.\n`,
        );
        continue;
      }
      const costs = isRecord(semantic.response_cost) ? semantic.response_cost : {};
      const incentive = isRecord(semantic.incentive) ? semantic.incentive : {};
      const horizon = isRecord(semantic.plausible_response_horizon)
        ? semantic.plausible_response_horizon
        : {};
      const distribution = isRecord(semantic.distribution_leverage)
        ? semantic.distribution_leverage
        : {};
      const coverage = isRecord(semantic.thesis_coverage) ? semantic.thesis_coverage : {};
      const residual = isRecord(semantic.residual_differentiation)
        ? semantic.residual_differentiation
        : {};
      const residualDimensions = records(residual.dimensions).map(
        (dimension) =>
          `${display(dimension.kind, zh)} (${display(dimension.strength, zh)}): ${display(dimension.rationale, zh)}`,
      );
      parts.push(
        `- ${zh ? "潜在响应者" : "Potential responder"}: ${display(semantic.responder_identity, zh)} (${display(semantic.responder_category, zh)}), ${zh ? "控制点" : "control point"}: ${display(semantic.control_point, zh)}.\n`,
      );
      parts.push(
        `  - ${zh ? "能力（不代表意愿）" : "Ability (not willingness)"}: ${graded(semantic.capability_adjacency, zh)}; ${zh ? "响应方式" : "modes"}: ${displayList(semantic.response_modes, zh)}.\n`,
      );
      parts.push(
        `  - ${zh ? "响应成本" : "Response costs"}: ${zh ? "实施" : "implementation"} ${graded(costs.implementation, zh)}; ${zh ? "运营" : "operations"} ${graded(costs.operational, zh)}; ${zh ? "合规" : "compliance"} ${graded(costs.compliance, zh)}; ${zh ? "数据" : "data"} ${graded(costs.data, zh)}; ${zh ? "分发" : "distribution"} ${graded(costs.distribution, zh)}.\n`,
      );
      parts.push(
        `  - ${zh ? "响应意愿" : "Willingness"}: ${display(incentive.level, zh)}: ${display(incentive.rationale, zh)} ${zh ? "驱动" : "Drivers"}: ${displayList(incentive.drivers, zh)}. ${zh ? "抑制" : "Disincentives"}: ${displayList(incentive.disincentives, zh)}. ${zh ? "自我蚕食" : "Cannibalization"}: ${display(incentive.cannibalization, zh)}.\n`,
      );
      parts.push(
        `  - ${zh ? "时间与分发" : "Horizon and distribution"}: ${display(horizon.band, zh)}: ${display(horizon.rationale, zh)}; ${graded(distribution, zh)}; ${displayList(distribution.control_points, zh)}.\n`,
      );
      parts.push(
        `  - ${zh ? "产品主张覆盖（功能复制不等于完整覆盖）" : "Thesis coverage (feature copying is not full coverage)"}: ${display(coverage.scope, zh)}: ${display(coverage.rationale, zh)} ${zh ? "已覆盖" : "Covered"}: ${displayList(coverage.covered_elements, zh)}. ${zh ? "未覆盖" : "Uncovered"}: ${displayList(coverage.uncovered_elements, zh)}.\n`,
      );
      parts.push(
        `  - ${zh ? "剩余差异化" : "Residual differentiation"}: ${display(residual.overall_strength, zh)}: ${display(residual.rationale, zh)}${residualDimensions.length === 0 ? "" : `; ${residualDimensions.join("; ")}`}.\n`,
      );
      parts.push(
        `  - ${zh ? "材料角色" : "Evidence roles"}: ${zh ? "支持" : "supporting"} ${auditReferenceSummary(semantic.supporting_evidence_refs, zh, false, citations)}; ${zh ? "反证" : "opposing"} ${auditReferenceSummary(semantic.opposing_evidence_refs, zh, false, citations)}; ${zh ? "背景" : "background"} ${auditReferenceSummary(semantic.background_evidence_refs, zh, false, citations)}.\n`,
      );
      parts.push(
        `  - ${zh ? "推理边界与缺口" : "Inference boundary and gaps"}: ${display(semantic.inference_boundary, zh)} ${zh ? "不确定性" : "Uncertainty"}: ${display(semantic.uncertainty, zh)}. ${zh ? "未知" : "Unknowns"}: ${displayList(semantic.unknowns, zh)}. ${zh ? "数据缺口" : "Data gaps"}: ${displayList(semantic.data_gaps, zh)}.\n`,
      );
    }
  }
  return parts.join("");
}

export function renderIncumbentResponseRiskTable(
  source: Readonly<{
    readonly incumbent_response_risk_rows?: unknown;
    readonly current_decision_subject_ids?: unknown;
    readonly report_subject_labels?: unknown;
    readonly report_citations?: unknown;
  }>,
  zh = false,
): string {
  const rows = records(source.incumbent_response_risk_rows);
  const citations = reportCitations(source as Readonly<Record<string, unknown>>);
  const headers = zh
    ? [
        "对象 / 深度",
        "潜在响应者 / 控制点",
        "响应方式",
        "能力邻近度",
        "响应成本",
        "动机 / 抑制因素",
        "响应时间",
        "分发杠杆",
        "可覆盖 Thesis 范围",
        "剩余差异化",
        "支持 / 反证 / 背景来源",
        "不确定性与数据缺口",
        "战略含义",
      ]
    : [
        "Subject / Depth",
        "Potential Responder / Control Point",
        "Response Modes",
        "Capability Adjacency",
        "Response Cost",
        "Incentive / Disincentives",
        "Response Horizon",
        "Distribution Leverage",
        "Thesis Coverage",
        "Residual Differentiation",
        "Supporting / Opposing / Background Evidence",
        "Uncertainty And Data Gaps",
        "Strategic Implication",
      ];
  const body = rows.map((row) => {
    const assessment = isRecord(row.assessment) ? row.assessment : {};
    const semantic = isRecord(assessment.semantic) ? assessment.semantic : {};
    const costs = isRecord(semantic.response_cost) ? semantic.response_cost : {};
    const incentive = isRecord(semantic.incentive) ? semantic.incentive : {};
    const horizon = isRecord(semantic.plausible_response_horizon)
      ? semantic.plausible_response_horizon
      : {};
    const distribution = isRecord(semantic.distribution_leverage)
      ? semantic.distribution_leverage
      : {};
    const coverage = isRecord(semantic.thesis_coverage) ? semantic.thesis_coverage : {};
    const residual = isRecord(semantic.residual_differentiation)
      ? semantic.residual_differentiation
      : {};
    const residualDimensions = records(residual.dimensions).map(
      (dimension) =>
        `${display(dimension.kind, zh)} (${display(dimension.strength, zh)}): ${display(dimension.rationale, zh)}`,
    );
    return [
      `${subjectDisplay(source as Readonly<Record<string, unknown>>, semantic.subject_id, zh)} / ${display(assessment.analysis_depth, zh)} / ${display(semantic.analysis_state, zh)}`,
      `${display(semantic.responder_identity, zh)} / ${display(semantic.responder_category, zh)} / ${display(semantic.control_point, zh)}`,
      displayList(semantic.response_modes, zh),
      graded(semantic.capability_adjacency, zh),
      [
        `${zh ? "实施" : "implementation"}: ${graded(costs.implementation, zh)}`,
        `${zh ? "运营" : "operational"}: ${graded(costs.operational, zh)}`,
        `${zh ? "合规" : "compliance"}: ${graded(costs.compliance, zh)}`,
        `${zh ? "数据" : "data"}: ${graded(costs.data, zh)}`,
        `${zh ? "分发" : "distribution"}: ${graded(costs.distribution, zh)}`,
      ].join("<br>"),
      `${display(incentive.level, zh)}: ${display(incentive.rationale, zh)}<br>${zh ? "驱动" : "drivers"}: ${displayList(incentive.drivers, zh)}<br>${zh ? "抑制" : "disincentives"}: ${displayList(incentive.disincentives, zh)}<br>${zh ? "自我蚕食" : "cannibalization"}: ${display(incentive.cannibalization, zh)}`,
      `${display(horizon.band, zh)}: ${display(horizon.rationale, zh)}`,
      `${graded(distribution, zh)}<br>${displayList(distribution.control_points, zh)}`,
      `${display(coverage.scope, zh)}: ${display(coverage.rationale, zh)}<br>${zh ? "已覆盖" : "covered"}: ${displayList(coverage.covered_elements, zh)}<br>${zh ? "未覆盖" : "uncovered"}: ${displayList(coverage.uncovered_elements, zh)}`,
      `${display(residual.overall_strength, zh)}: ${display(residual.rationale, zh)}${residualDimensions.length === 0 ? "" : `<br>${residualDimensions.join("<br>")}`}`,
      `${zh ? "支持" : "supporting"}: ${auditReferenceSummary(semantic.supporting_evidence_refs, zh, false, citations)}<br>${zh ? "反证" : "opposing"}: ${auditReferenceSummary(semantic.opposing_evidence_refs, zh, false, citations)}<br>${zh ? "背景" : "background"}: ${auditReferenceSummary(semantic.background_evidence_refs, zh, false, citations)}`,
      `${display(semantic.confidence, zh)}: ${display(semantic.uncertainty, zh)}<br>${zh ? "推理边界" : "inference boundary"}: ${display(semantic.inference_boundary, zh)}<br>${zh ? "未知" : "unknowns"}: ${displayList(semantic.unknowns, zh)}<br>${zh ? "数据缺口" : "data gaps"}: ${displayList(semantic.data_gaps, zh)}`,
      zh ? INCUMBENT_RESPONSE_STRATEGIC_CONTEXT_ZH : INCUMBENT_RESPONSE_STRATEGIC_CONTEXT,
    ];
  });
  const assessedSubjectIds = new Set(
    rows.flatMap((row) => {
      const assessment = isRecord(row.assessment) ? row.assessment : {};
      const semantic = isRecord(assessment.semantic) ? assessment.semantic : {};
      return typeof semantic.subject_id === "string" ? [semantic.subject_id] : [];
    }),
  );
  for (const subjectId of strings(source.current_decision_subject_ids).filter(
    (candidate) => !assessedSubjectIds.has(candidate),
  )) {
    body.push([
      `${subjectDisplay(source as Readonly<Record<string, unknown>>, subjectId, zh)} / ${zh ? "未提交" : "not submitted"} / ${zh ? "未知" : "unknown"}`,
      zh
        ? "未知：没有该当前方向的潜在响应者研究"
        : "Unknown: no responder research for this current direction",
      "-",
      zh ? "未知" : "unknown",
      zh ? "未知" : "unknown",
      zh ? "未知" : "unknown",
      zh ? "未知" : "unknown",
      zh ? "未知" : "unknown",
      zh ? "未知" : "unknown",
      zh ? "未知" : "unknown",
      "-",
      zh
        ? "数据缺口：不得从历史或被取代方向补用 incumbent assessment"
        : "Data gap: an incumbent assessment cannot be borrowed from a historical or superseded direction",
      zh
        ? "该风险保持未知，仅作待补战略参考；不触发自动淘汰、降置信度或建议上限。"
        : "The risk remains an open strategic question only; it does not trigger automatic elimination, confidence reduction, or a recommendation ceiling.",
    ]);
  }
  if (body.length === 0) {
    body.push([
      zh ? "报告范围 / 未分配 / 未知" : "Report scope / not assigned / unknown",
      zh
        ? "未知：没有已提交的潜在响应者研究"
        : "Unknown: no potential responder research was submitted",
      "-",
      zh ? "未知" : "unknown",
      zh ? "未知" : "unknown",
      zh ? "未知" : "unknown",
      zh ? "未知" : "unknown",
      zh ? "未知" : "unknown",
      zh ? "未知" : "unknown",
      zh ? "未知" : "unknown",
      "-",
      zh
        ? "数据缺口：未分配或未提交候选形成后的头部公司吸收与响应研究"
        : "Data gap: post-candidate incumbent absorption and response research was not assigned or submitted",
      zh
        ? "该风险保持未知，仅作待补战略参考；不触发自动淘汰、降置信度或建议上限。"
        : "The risk remains an open strategic question only; it does not trigger automatic elimination, confidence reduction, or a recommendation ceiling.",
    ]);
  }
  const contextOnly = zh
    ? "> 仅作背景参考：头部公司吸收与响应风险不是门禁，不会自动淘汰候选、取消排名资格、降低 Claim 置信度、施加建议上限或阻止发布。"
    : "> Context only: incumbent absorption and response risk is not a Gate and does not automatically eliminate or unrank a candidate, reduce Claim confidence, impose a recommendation ceiling, or block publication.";
  return [
    contextOnly,
    "",
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
  ].join("\n");
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function metricValue(value: unknown, zh = false): string {
  if (!isRecord(value)) return "-";
  const unit = display(value.unit, zh);
  const currency = value.currency === null ? "" : ` ${display(value.currency, zh)}`;
  if (value.shape === "range") {
    return `${cell(value.lower_bound)}-${cell(value.upper_bound)} ${unit}${currency}`.trim();
  }
  if (value.shape === "index") {
    return `${cell(value.value)} ${unit} (${display(value.index_base, zh)})`;
  }
  if (value.shape === "estimate") {
    const bounds =
      value.lower_bound === null || value.upper_bound === null
        ? ""
        : ` [${cell(value.lower_bound)}, ${cell(value.upper_bound)}]`;
    return `${cell(value.value)}${bounds} ${unit}${currency} (${zh ? "估算" : "estimate"})`.trim();
  }
  return `${cell(value.value)} ${unit}${currency}`.trim();
}

function period(value: unknown, zh = false): string {
  if (!isRecord(value)) return "-";
  if (value.as_of !== null) {
    return `${display(value.label, zh)}; ${zh ? "截至" : "as of"} ${cell(value.as_of)}`;
  }
  return `${display(value.label, zh)}; ${cell(value.period_start)} ${zh ? "至" : "to"} ${cell(value.period_end)}`;
}

export function renderQuantitativeSignalTable(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const rows = records(source.quantitative_signal_rows);
  const citations = reportCitations(source);
  const headers = zh
    ? [
        "对象",
        "指标族 / 指标",
        "值",
        "口径",
        "地域",
        "周期",
        "决策用途 / 测量类型",
        "可比性",
        "误差/不确定性",
        "来源",
      ]
    : [
        "Subject",
        "Metric Family / Metric",
        "Value",
        "Definition",
        "Geography",
        "Period",
        "Decision Use / Measurement",
        "Comparability",
        "Error / Uncertainty",
        "Sources",
      ];
  const body = rows.map((row) => {
    const observation = isRecord(row.observation) ? row.observation : {};
    const comparability = isRecord(observation.comparability) ? observation.comparability : {};
    return [
      subjectDisplay(source, observation.subject_id, zh),
      `${display(observation.metric_family, zh)} / ${display(observation.metric_name, zh)} (${display(observation.metric_semantics, zh)})`,
      metricValue(observation.value, zh),
      display(observation.metric_definition, zh),
      display(observation.geography, zh),
      period(observation.period, zh),
      `${display(isRecord(observation.decision_use) ? observation.decision_use.grade : "context_only", zh)} / ${display(observation.measurement_type, zh)}`,
      `${display(comparability.status, zh)}; ${display(comparability.category, zh)}; ${
        comparability.direct_comparison_allowed === true
          ? zh
            ? "可直接比较"
            : "direct comparison allowed"
          : zh
            ? "不可直接比较"
            : "no direct comparison"
      }`,
      display(observation.error_uncertainty, zh),
      auditReferenceSummary(observation.evidence_refs, zh, false, citations),
    ];
  });
  if (body.length === 0) {
    body.push([
      zh ? "全部" : "All",
      zh ? "无已观察量化信号" : "No observed quantitative signal",
      "-",
      zh ? "参见数据缺口表" : "See coverage gap table",
      "-",
      "-",
      zh ? "不可用" : "unavailable",
      zh ? "不可比较" : "not comparable",
      zh ? "无可用数值" : "no numeric value available",
      "-",
    ]);
  }
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
  ].join("\n");
}

export function renderMarketPriorityAndCommercialReadiness(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const headers = zh
    ? ["对象", "市场研究优先级", "优先级依据", "商业验证就绪度", "已满足", "仍缺失"]
    : [
        "Subject",
        "Market Research Priority",
        "Priority Basis",
        "Commercial Validation Readiness",
        "Satisfied",
        "Missing",
      ];
  const body = records(source.commercial_subject_aggregates).map((aggregate) => {
    const priority = isRecord(aggregate.market_research_priority)
      ? aggregate.market_research_priority
      : {};
    const readiness = isRecord(aggregate.commercial_validation_readiness)
      ? aggregate.commercial_validation_readiness
      : {};
    return [
      subjectDisplay(source, aggregate.subject_id, zh),
      priorityDisplay(priority.level ?? "low", zh),
      displayList(priority.basis_codes, zh),
      readinessDisplay(readiness.level ?? "not_ready", zh),
      displayList(readiness.satisfied_dimensions, zh),
      displayList(readiness.missing_dimensions, zh),
    ];
  });
  if (body.length === 0) {
    body.push([
      zh ? "无当前对象" : "No current subject",
      zh ? "低" : "low",
      "-",
      zh ? "未就绪" : "not ready",
      "-",
      "-",
    ]);
  }
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
  ].join("\n");
}

function decisionGradeRows(
  source: Readonly<Record<string, unknown>>,
): readonly Record<string, unknown>[] {
  return records(source.quantitative_signal_rows).filter((row) => {
    const observation = isRecord(row.observation) ? row.observation : {};
    const decisionUse = isRecord(observation.decision_use) ? observation.decision_use : {};
    return decisionUse.grade === "decision_grade";
  });
}

export function renderDecisionGradeQuantitativeSummary(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const citations = reportCitations(source);
  const bySubject = new Map<string, Record<string, unknown>[]>();
  for (const row of decisionGradeRows(source)) {
    const observation = isRecord(row.observation) ? row.observation : {};
    const subjectId = String(observation.subject_id);
    const existing = bySubject.get(subjectId) ?? [];
    existing.push(observation);
    bySubject.set(subjectId, existing);
  }
  const subjectIds = [
    ...new Set([
      ...records(source.commercial_subject_aggregates).map((entry) => String(entry.subject_id)),
      ...bySubject.keys(),
    ]),
  ].sort();
  if (subjectIds.length === 0) {
    return zh
      ? "- 当前没有可汇总的最终研究对象。\n"
      : "- No final research subject is available for a quantitative summary.\n";
  }
  return `${subjectIds
    .map((subjectId) => {
      const observations = (bySubject.get(subjectId) ?? []).sort((left, right) =>
        `${String(left.metric_family)}:${String(left.metric_name)}`.localeCompare(
          `${String(right.metric_family)}:${String(right.metric_name)}`,
        ),
      );
      if (observations.length === 0) {
        return `- **${subjectDisplay(source, subjectId, zh)}**: ${zh ? "未取得决策级量化数据；方向性代理指标和背景数字仍保留在审计附录。" : "No decision-grade quantitative data was obtained; directional proxies and context numbers remain in the audit appendix."}`;
      }
      const displayed = observations.slice(0, 5);
      const metrics = displayed.map((observation) => {
        const sources = auditReferenceSummary(observation.evidence_refs, zh, false, citations);
        return `${display(observation.metric_family, zh)} / ${display(observation.metric_name, zh)}: ${metricValue(observation.value, zh)} (${sources})`;
      });
      const omitted = observations.length - displayed.length;
      return `- **${subjectDisplay(source, subjectId, zh)}**: ${metrics.join("; ")}${
        omitted === 0
          ? ""
          : zh
            ? `；其余 ${omitted} 条决策级量化信号见审计附录`
            : `; ${omitted} additional decision-grade signal${omitted === 1 ? "" : "s"} in the audit appendix`
      }`;
    })
    .join("\n")}\n`;
}

function competitorTypesBySubject(
  source: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, readonly string[]> {
  const values = new Map<string, Set<string>>();
  for (const row of records(source.competitive_substitute_rows)) {
    const object = isRecord(row.competitive_object) ? row.competitive_object : {};
    const subjectId = String(object.subject_id);
    const types = values.get(subjectId) ?? new Set<string>();
    if (typeof object.competitor_type === "string") types.add(object.competitor_type);
    values.set(subjectId, types);
  }
  return new Map([...values].map(([subjectId, types]) => [subjectId, [...types].sort()]));
}

export function renderCompetitiveSubjectSummary(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const citations = reportCitations(source);
  const typesBySubject = competitorTypesBySubject(source);
  const aggregates = [...records(source.commercial_subject_aggregates)].sort((left, right) =>
    String(left.subject_id).localeCompare(String(right.subject_id)),
  );
  if (aggregates.length === 0) {
    return zh ? "- 当前没有最终研究对象。\n" : "- No final research subject is available.\n";
  }
  return `${aggregates
    .map((aggregate) => {
      const subjectId = String(aggregate.subject_id);
      const rows = records(source.competitive_substitute_rows).filter((row) => {
        const object = isRecord(row.competitive_object) ? row.competitive_object : {};
        return object.subject_id === subjectId;
      });
      const coverage = records(aggregate.competitive_coverage);
      const disposed = coverage.filter((entry) => entry.state === "not_applicable");
      const gaps = coverage.filter((entry) => !isFormalScopeDisposed(entry.state));
      const objects = rows.slice(0, 5).map((row) => {
        const object = isRecord(row.competitive_object) ? row.competitive_object : {};
        const refs = auditReferenceSummary(object.source_refs, zh, false, citations);
        return `${display(object.competitor_type, zh)}: ${display(object.name, zh)}；${zh ? "定位" : "positioning"}: ${display(object.positioning, zh)}；${zh ? "定价" : "pricing"}: ${auditReferenceSummary(object.pricing_observation_refs, zh, true, citations)}；${zh ? "使用/市场信号" : "usage/market signals"}: ${auditReferenceSummary(object.traction_observation_refs, zh, true, citations)}；${zh ? "优势" : "strengths"}: ${displayList(object.strengths, zh)}；${zh ? "弱点" : "weaknesses"}: ${displayList(object.weaknesses, zh)}；${zh ? "差异化缺口" : "differentiation gaps"}: ${displayList(object.differentiation_gaps, zh)} (${refs})`;
      });
      const lines = [
        `- **${subjectDisplay(source, subjectId, zh)}**: ${objects.length === 0 ? (zh ? "未形成竞品对象" : "no competitive object formed") : objects.join("; ")}`,
        ...(typesBySubject.get(subjectId)?.length
          ? [
              `  ${zh ? "已观察类型" : "Observed types"}: ${(typesBySubject.get(subjectId) ?? []).map((entry) => display(entry, zh)).join(", ")}`,
            ]
          : []),
        ...(disposed.length > 0
          ? [
              `  ${zh ? "明确不适用" : "Explicitly not applicable"}: ${disposed.map((entry) => display(entry.competitor_type, zh)).join(", ")}`,
            ]
          : []),
        ...(gaps.length > 0
          ? [
              `  ${zh ? "仍有缺口" : "Remaining gaps"}: ${gaps.map((entry) => `${display(entry.competitor_type, zh)} (${display(entry.state, zh)})`).join(", ")}`,
            ]
          : []),
        ...(rows.length > 5
          ? [
              `  ${zh ? `其余 ${rows.length - 5} 个竞品/替代对象保留在审计附录` : `${rows.length - 5} additional competitive/substitute object${rows.length - 5 === 1 ? "" : "s"} remain in the audit appendix`}`,
            ]
          : []),
      ];
      return lines.join("\n");
    })
    .join("\n")}\n`;
}

export function renderCompetitiveSubstituteMatrix(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const rows = records(source.competitive_substitute_rows);
  const citations = reportCitations(source);
  const headers = zh
    ? [
        "类型",
        "对象",
        "目标细分",
        "场景",
        "定位",
        "定价观察",
        "使用/市场信号",
        "优势",
        "弱点",
        "差异化缺口",
        "来源",
      ]
    : [
        "Type",
        "Object",
        "Target Segment",
        "Scenario",
        "Positioning",
        "Pricing Observations",
        "Traction Observations",
        "Strengths",
        "Weaknesses",
        "Differentiation Gaps",
        "Sources",
      ];
  const body = rows.map((row) => {
    const competitiveObject = isRecord(row.competitive_object) ? row.competitive_object : {};
    return [
      display(competitiveObject.competitor_type, zh),
      display(competitiveObject.name, zh),
      display(competitiveObject.target_segment, zh),
      display(competitiveObject.scenario, zh),
      display(competitiveObject.positioning, zh),
      auditReferenceSummary(competitiveObject.pricing_observation_refs, zh, true, citations),
      auditReferenceSummary(competitiveObject.traction_observation_refs, zh, true, citations),
      displayList(competitiveObject.strengths, zh),
      displayList(competitiveObject.weaknesses, zh),
      displayList(competitiveObject.differentiation_gaps, zh),
      auditReferenceSummary(competitiveObject.source_refs, zh, false, citations),
    ];
  });
  if (body.length === 0) {
    body.push([
      zh ? "不可用" : "unavailable",
      zh ? "没有已观察竞争对象" : "No observed competitive object",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      zh ? "参见数据缺口表" : "See coverage gap table",
      "-",
    ]);
  }
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
  ].join("\n");
}

export function renderResearchCoverageGaps(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const rows = records(source.research_coverage_gaps);
  const headers = zh
    ? ["对象", "覆盖类型", "维度", "状态", "查询尝试", "原因", "替代指标", "对排序/结论的影响"]
    : [
        "Subject",
        "Coverage Type",
        "Dimension",
        "State",
        "Query Attempts",
        "Reason",
        "Alternative Metric",
        "Ranking / Decision Impact",
      ];
  const body = rows.map((row) => {
    if (row.coverage_kind === "execution") {
      const assignedDimensions = [
        ...strings(row.assigned_commercial_dimensions),
        ...strings(row.assigned_metric_families),
        ...strings(row.assigned_competitor_types),
      ];
      return [
        zh
          ? strings(row.subject_ids)
              .map((subjectId) => subjectDisplay(source, subjectId, true))
              .join("<br>")
          : displayList(row.subject_ids, false),
        zh ? "执行/研究" : "execution / research",
        assignedDimensions.length > 0
          ? assignedDimensions.map((dimension) => display(dimension, zh)).join("<br>")
          : zh
            ? "对应研究任务"
            : display(row.task_ref, false),
        display(row.state, zh),
        "-",
        display(row.reason, zh),
        "-",
        display(row.decision_impact, zh),
      ];
    }
    if (["business", "research"].includes(String(row.coverage_kind))) {
      const attempts = records(row.query_attempts).map(
        (attempt) =>
          `${display(attempt.acquisition_method, zh)} / ${display(attempt.provider, zh)} / ${display(attempt.outcome, zh)}: ${display(attempt.reason, zh)}`,
      );
      return [
        zh
          ? strings(row.subject_ids)
              .map((subjectId) => subjectDisplay(source, subjectId, true))
              .join("<br>")
          : displayList(row.subject_ids, false),
        display(row.coverage_kind, zh),
        display(row.dimension, zh),
        display(row.state, zh),
        attempts.length === 0 ? "-" : attempts.join("<br>"),
        display(row.reason, zh),
        display(row.alternative_metric, zh),
        display(row.decision_impact, zh),
      ];
    }
    const coverage = isRecord(row.coverage) ? row.coverage : {};
    const attempts = records(coverage.query_attempts).map(
      (attempt) =>
        `${display(attempt.acquisition_method, zh)} / ${display(attempt.provider, zh)} / ${display(attempt.outcome, zh)}: ${display(attempt.reason, zh)}`,
    );
    return [
      subjectDisplay(source, coverage.subject_id, zh),
      display(row.coverage_kind, zh),
      display(
        row.coverage_kind === "quantitative"
          ? coverage.metric_family
          : row.coverage_kind === "competitive"
            ? coverage.competitor_type
            : "absorption_and_response_risk",
        zh,
      ),
      display(coverage.state, zh),
      attempts.length === 0 ? "-" : attempts.join("<br>"),
      display(coverage.reason, zh),
      row.coverage_kind === "incumbent_response"
        ? displayList(coverage.data_gaps, zh)
        : display(coverage.alternative_metric, zh),
      display(coverage.decision_impact, zh),
    ];
  });
  if (body.length === 0) {
    const status = isRecord(source.commercial_research_status)
      ? source.commercial_research_status.state
      : "planned_with_gaps";
    const complete = status === "complete";
    const notPlanned = status === "not_planned";
    body.push([
      complete ? (zh ? "全部" : "All") : "-",
      notPlanned
        ? zh
          ? "未计划"
          : "not planned"
        : zh
          ? "量化与竞争"
          : "quantitative and competitive",
      complete
        ? zh
          ? "全部已计划维度"
          : "all planned dimensions"
        : zh
          ? "研究覆盖状态"
          : "research coverage status",
      complete
        ? zh
          ? "已观察"
          : "observed"
        : notPlanned
          ? zh
            ? "未计划"
            : "not planned"
          : zh
            ? "未知"
            : "unknown",
      "-",
      complete
        ? zh
          ? "没有未关闭的已计划维度"
          : "No unresolved planned dimension"
        : notPlanned
          ? zh
            ? "没有正式商业研究任务"
            : "No formal commercial research task was planned"
          : zh
            ? "研究状态不完整；不得解释为空表即全部已观察"
            : "Research status is incomplete; an empty table does not mean all dimensions were observed",
      "-",
      complete
        ? zh
          ? "没有额外缺口影响"
          : "No additional gap impact"
        : zh
          ? "参见每个候选的商业研究聚合"
          : "See the per-subject commercial research aggregates",
    ]);
  }
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
  ].join("\n");
}

interface CriticalGapGroup {
  readonly subjectId: string;
  readonly state: string;
  readonly decisionImpact: string;
  readonly decisionRelevance: "blocking" | "non_blocking";
  readonly dimensions: readonly string[];
  readonly reasons: readonly string[];
}

function gapProjection(row: Record<string, unknown>): {
  readonly subjectIds: readonly string[];
  readonly state: string;
  readonly dimension: string;
  readonly decisionImpact: string;
  readonly decisionRelevance: string;
  readonly reason: string;
} {
  if (row.coverage_kind === "execution") {
    const dimensions = [
      ...strings(row.assigned_commercial_dimensions),
      ...strings(row.assigned_metric_families),
      ...strings(row.assigned_competitor_types),
    ];
    return {
      subjectIds: strings(row.subject_ids),
      state: String(row.state),
      dimension: dimensions.join(", ") || String(row.task_ref),
      decisionImpact: String(row.decision_impact),
      decisionRelevance: String(row.decision_relevance),
      reason: String(row.reason),
    };
  }
  if (["business", "research"].includes(String(row.coverage_kind))) {
    return {
      subjectIds: strings(row.subject_ids),
      state: String(row.state),
      dimension: String(row.dimension),
      decisionImpact: String(row.decision_impact),
      decisionRelevance: String(row.decision_relevance),
      reason: String(row.reason),
    };
  }
  const coverage = isRecord(row.coverage) ? row.coverage : {};
  return {
    subjectIds: typeof coverage.subject_id === "string" ? [coverage.subject_id] : [],
    state: String(coverage.state),
    dimension: String(
      row.coverage_kind === "quantitative"
        ? coverage.metric_family
        : row.coverage_kind === "competitive"
          ? coverage.competitor_type
          : "absorption_and_response_risk",
    ),
    decisionImpact: String(coverage.decision_impact),
    decisionRelevance: String(row.decision_relevance),
    reason: String(coverage.reason),
  };
}

export function criticalResearchGapGroups(
  source: Readonly<Record<string, unknown>>,
): readonly CriticalGapGroup[] {
  const groups = new Map<string, { dimensions: Set<string>; reasons: Set<string> }>();
  for (const row of records(source.research_coverage_gaps)) {
    if (row.coverage_kind === "incumbent_response") continue;
    const projected = gapProjection(row);
    if (
      projected.state === "not_applicable" ||
      projected.decisionImpact === INCUMBENT_RESPONSE_CONTEXT_ONLY ||
      !["blocking", "non_blocking"].includes(projected.decisionRelevance)
    ) {
      continue;
    }
    for (const subjectId of projected.subjectIds) {
      const identity = `${subjectId}\u0000${projected.decisionRelevance}\u0000${projected.state}\u0000${projected.decisionImpact}`;
      const group = groups.get(identity) ?? { dimensions: new Set(), reasons: new Set() };
      group.dimensions.add(projected.dimension);
      group.reasons.add(projected.reason);
      groups.set(identity, group);
    }
  }
  const bySubject = new Map<string, CriticalGapGroup[]>();
  for (const [identity, group] of groups) {
    const [subjectId = "", decisionRelevance = "non_blocking", state = "", decisionImpact = ""] =
      identity.split("\u0000");
    const values = bySubject.get(subjectId) ?? [];
    values.push({
      subjectId,
      state,
      decisionImpact,
      decisionRelevance: decisionRelevance as "blocking" | "non_blocking",
      dimensions: [...group.dimensions].sort(),
      reasons: [...group.reasons].sort(),
    });
    bySubject.set(subjectId, values);
  }
  return [...bySubject]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, values]) =>
      values
        .sort((left, right) => {
          const relevance = { blocking: 0, non_blocking: 1 } as const;
          return (
            relevance[left.decisionRelevance] - relevance[right.decisionRelevance] ||
            `${left.state}:${left.dimensions.join(",")}:${left.decisionImpact}`.localeCompare(
              `${right.state}:${right.dimensions.join(",")}:${right.decisionImpact}`,
            )
          );
        })
        .slice(0, 5),
    );
}

export function deriveReportStatistics(
  source: Readonly<Record<string, unknown>>,
): Readonly<Record<string, number>> {
  const quantitativeRows = records(source.quantitative_signal_rows);
  const decisionGradeCount = quantitativeRows.filter((row) => {
    const observation = isRecord(row.observation) ? row.observation : {};
    const decisionUse = isRecord(observation.decision_use) ? observation.decision_use : {};
    return decisionUse.grade === "decision_grade";
  }).length;
  return {
    readable_source_count: records(source.report_citations).length,
    quantitative_signal_count: quantitativeRows.length,
    decision_grade_quantitative_signal_count: decisionGradeCount,
    directional_or_context_quantitative_signal_count: quantitativeRows.length - decisionGradeCount,
    competitive_object_count: records(source.competitive_substitute_rows).length,
    full_gap_row_count: records(source.research_coverage_gaps).length,
    critical_gap_group_count: criticalResearchGapGroups(source).length,
    excluded_evidence_count: records(source.report_evidence_dispositions).filter(
      (entry) => entry.disposition === "excluded",
    ).length,
  };
}

export function renderCriticalResearchGaps(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const groups = criticalResearchGapGroups(source);
  const subjectIds = [
    ...new Set([
      ...records(source.report_subject_labels).map((entry) => String(entry.subject_id)),
      ...records(source.commercial_subject_aggregates).map((entry) => String(entry.subject_id)),
      ...groups.map((group) => group.subjectId),
    ]),
  ].sort();
  if (subjectIds.length === 0) {
    return zh ? "- 当前没有最终研究对象。\n" : "- No final research subject is available.\n";
  }
  return `${subjectIds
    .flatMap((subjectId) => {
      const subjectGroups = groups.filter((group) => group.subjectId === subjectId);
      return subjectGroups.length === 0
        ? [
            `- **${subjectDisplay(source, subjectId, zh)}**: ${zh ? "当前没有会改变排序或结论的未关闭研究缺口。" : "No unresolved research gap currently changes ranking or conclusion boundaries."}`,
          ]
        : subjectGroups.map(
            (group) =>
              `- **${subjectDisplay(source, group.subjectId, zh)}** / ${display(group.state, zh)} / ${group.dimensions.map((entry) => display(entry, zh)).join(", ")}: ${display(group.decisionImpact, zh)}${group.reasons.length === 0 ? "" : ` (${group.reasons.map((entry) => display(entry, zh)).join("; ")})`}`,
          );
    })
    .join("\n")}\n`;
}

export function renderGateWarnings(source: Readonly<Record<string, unknown>>, zh = false): string {
  const warnings = records(source.gate_warnings);
  if (warnings.length === 0) {
    return zh ? "- 没有非阻塞门禁诊断。\n" : "- No non-blocking Gate diagnostics.\n";
  }
  return `${warnings
    .map((warning) =>
      zh
        ? `- [${display(warning.severity, true)} / ${display(warning.category, true)}] ${display(warning.message, true)} 决策影响: ${display(warning.decision_impact, true)}`
        : `- [${display(warning.severity, false)} / ${display(warning.category, false)}] ${display(warning.code, false)}: ${display(warning.message, false)} Decision impact: ${display(warning.decision_impact, false)}`,
    )
    .join("\n")}\n`;
}

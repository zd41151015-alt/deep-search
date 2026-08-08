import { canonicalJson } from "../artifact-store/canonical.js";
import { deriveSourceConcentration } from "../validators/commercial-source-concentration.js";

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
  downloadable_dataset: "可下载数据集",
  downloads: "下载量",
  estimated: "估算",
  estimate: "估算",
  estimate_not_observation: "估算而非直接观察",
  evidence: "证据",
  growth_change: "增长变化",
  growth_rate: "增长率",
  harness: "研究系统",
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

function displayList(value: unknown, zh: boolean): string {
  const values = strings(value);
  return values.length === 0 ? "-" : values.map((entry) => display(entry, zh)).join("<br>");
}

function auditReferenceSummary(value: unknown, zh: boolean, recorded = false): string {
  if (!zh) return listCell(value);
  if (strings(value).length === 0) return "-";
  return recorded ? "已记录（详见结构化审计）" : "详见结构化审计";
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
      (row) => row.metric_family === "retention_outcomes" && row.state === "observed",
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
): CommercialAuditProjection {
  const sortedAudits = [...audits].sort((left, right) => left.path.localeCompare(right.path));
  const sortedTasks = [...tasks].sort((left, right) => left.path.localeCompare(right.path));
  const quantitativeRows = sortedAudits.flatMap((audit) =>
    records(audit.document.quantitative_observations).map((observation) => ({
      audit_ref: audit.path,
      observation,
    })),
  );
  const competitiveRows = sortedAudits.flatMap((audit) =>
    records(audit.document.competitive_objects).map((competitiveObject) => ({
      audit_ref: audit.path,
      competitive_object: competitiveObject,
    })),
  );
  const incumbentResponseRows = sortedAudits.flatMap((audit) =>
    records(audit.document.incumbent_response_assessments).map((assessment) => ({
      audit_ref: audit.path,
      assessment,
    })),
  );
  const auditByExpectedPath = new Map(sortedAudits.map((audit) => [audit.path, audit]));
  const missingTasks = sortedTasks.filter((task) => {
    const expected = expectedAuditPath(task);
    return expected !== null && !auditByExpectedPath.has(expected);
  });
  const inferredTaskRefs =
    sortedTasks.length > 0
      ? sortedTasks.map((task) => task.path)
      : sortedAudits.flatMap((audit) =>
          typeof audit.document.task_ref === "string" ? [audit.document.task_ref] : [],
        );
  const subjectIds = [
    ...new Set([
      ...sortedAudits.flatMap((audit) =>
        records(audit.document.subject_assessments).map((assessment) =>
          String(assessment.subject_id),
        ),
      ),
      ...sortedAudits.flatMap((audit) => strings(audit.document.covered_direction_ids)),
      ...sortedTasks.flatMap((task) => taskSubjects(task, documentsByPath)),
    ]),
  ].sort();
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
      if (merged.state !== "observed") {
        gapRows.push({
          audit_refs: subjectAudits.map((audit) => audit.path),
          task_refs: taskRefs,
          coverage_kind: "quantitative",
          coverage: merged,
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
      if (merged.state !== "observed") {
        gapRows.push({
          audit_refs: subjectAudits.map((audit) => audit.path),
          task_refs: taskRefs,
          coverage_kind: "competitive",
          coverage: merged,
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
        query_attempts: records(gap.query_attempts),
      });
    }
    const unresolvedGenericGaps = currentGenericGapEntries
      .map(({ gap }) => gap)
      .filter((gap) => gap.state !== "not_applicable");
    const competitiveObjects = subjectAudits.flatMap((audit) =>
      records(audit.document.competitive_objects).filter((item) => item.subject_id === subjectId),
    );
    const ceiling = aggregateRecommendationCeiling({
      coverage,
      quantitativeCoverage,
      competitiveObjects,
      evidence,
      canonicalEvidence,
      laneAssessments,
      unresolvedGaps: unresolvedGenericGaps,
      evidenceDocuments: documentsByPath,
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
      quantitativeCoverage.every((row) => row.state === "observed") &&
      competitiveCoverage.every((row) => row.state === "observed") &&
      unresolvedGenericGaps.length === 0;
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
          quantitativeCoverage.some(
            (row) =>
              row.state === "observed" &&
              ["demand_scale", "growth_change"].includes(String(row.metric_family)),
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
            : missingSubjectTasks.length > 0 || !completeDimensions
              ? "planned_with_gaps"
              : "complete",
      execution_warning_task_refs: missingSubjectTasks.map((task) => task.path),
    };
  });
  for (const task of missingTasks) {
    const dimensions = assignedDimensions(task);
    gapRows.push({
      task_ref: task.path,
      coverage_kind: "execution",
      subject_ids: taskSubjects(task, documentsByPath),
      state: "unavailable",
      reason: "The planned commercial research task has no current valid Audit artifact.",
      decision_impact:
        "Execution remains incomplete; only assigned dimensions not closed by another current Audit constrain a subject conclusion.",
      assigned_metric_families: dimensions.metricFamilies,
      assigned_competitor_types: dimensions.competitorTypes,
      assigned_commercial_dimensions: dimensions.commercialDimensions,
    });
  }
  for (const audit of sortedAudits) {
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
        sortedTasks.length === 0 && sortedAudits.length === 0
          ? "not_planned"
          : missingTasks.length > 0 && sortedAudits.length === 0
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

export function renderIncumbentResponseRiskTable(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const rows = records(source.incumbent_response_risk_rows);
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
      `${display(semantic.subject_id, zh)} / ${display(assessment.analysis_depth, zh)} / ${display(semantic.analysis_state, zh)}`,
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
      `${zh ? "支持" : "supporting"}: ${auditReferenceSummary(semantic.supporting_evidence_refs, zh)}<br>${zh ? "反证" : "opposing"}: ${auditReferenceSummary(semantic.opposing_evidence_refs, zh)}<br>${zh ? "背景" : "background"}: ${auditReferenceSummary(semantic.background_evidence_refs, zh)}`,
      `${display(semantic.confidence, zh)}: ${display(semantic.uncertainty, zh)}<br>${zh ? "推理边界" : "inference boundary"}: ${display(semantic.inference_boundary, zh)}<br>${zh ? "未知" : "unknowns"}: ${displayList(semantic.unknowns, zh)}<br>${zh ? "数据缺口" : "data gaps"}: ${displayList(semantic.data_gaps, zh)}`,
      display(semantic.strategic_implication, zh),
    ];
  });
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
  return [
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

function listCell(value: unknown): string {
  const values = strings(value);
  return values.length === 0 ? "-" : values.map(cell).join("<br>");
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
  const headers = zh
    ? [
        "对象",
        "指标族 / 指标",
        "值",
        "口径",
        "地域",
        "周期",
        "测量类型",
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
        "Measurement",
        "Comparability",
        "Error / Uncertainty",
        "Sources",
      ];
  const body = rows.map((row) => {
    const observation = isRecord(row.observation) ? row.observation : {};
    const comparability = isRecord(observation.comparability) ? observation.comparability : {};
    return [
      display(observation.subject_id, zh),
      `${display(observation.metric_family, zh)} / ${display(observation.metric_name, zh)} (${display(observation.metric_semantics, zh)})`,
      metricValue(observation.value, zh),
      display(observation.metric_definition, zh),
      display(observation.geography, zh),
      period(observation.period, zh),
      display(observation.measurement_type, zh),
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
      auditReferenceSummary(observation.evidence_refs, zh),
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

export function renderCompetitiveSubstituteMatrix(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const rows = records(source.competitive_substitute_rows);
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
      auditReferenceSummary(competitiveObject.pricing_observation_refs, zh, true),
      auditReferenceSummary(competitiveObject.traction_observation_refs, zh, true),
      displayList(competitiveObject.strengths, zh),
      displayList(competitiveObject.weaknesses, zh),
      displayList(competitiveObject.differentiation_gaps, zh),
      auditReferenceSummary(competitiveObject.source_refs, zh),
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
        displayList(row.subject_ids, zh),
        zh ? "执行/研究" : "execution / research",
        assignedDimensions.length > 0
          ? assignedDimensions.map((dimension) => display(dimension, zh)).join("<br>")
          : display(row.task_ref, zh),
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
        displayList(row.subject_ids, zh),
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
      display(coverage.subject_id, zh),
      display(row.coverage_kind, zh),
      display(
        row.coverage_kind === "quantitative" ? coverage.metric_family : coverage.competitor_type,
        zh,
      ),
      display(coverage.state, zh),
      attempts.length === 0 ? "-" : attempts.join("<br>"),
      display(coverage.reason, zh),
      display(coverage.alternative_metric, zh),
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

export function renderGateWarnings(source: Readonly<Record<string, unknown>>, zh = false): string {
  const warnings = records(source.gate_warnings);
  if (warnings.length === 0) {
    return zh ? "- 没有非阻塞门禁诊断。\n" : "- No non-blocking Gate diagnostics.\n";
  }
  return `${warnings
    .map(
      (warning) =>
        `- [${cell(warning.severity)} / ${cell(warning.category)}] ${cell(warning.code)}: ${cell(warning.message)} ${zh ? "决策影响" : "Decision impact"}: ${cell(warning.decision_impact)}`,
    )
    .join("\n")}\n`;
}

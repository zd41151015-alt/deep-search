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

const METRIC_FAMILIES = [
  "demand_scale",
  "usage_behavior",
  "commercial_behavior",
  "growth_change",
  "competitive_intensity",
  "distribution",
  "retention_outcomes",
  "unit_economics",
] as const;

const COMPETITOR_TYPES = [
  "direct_product",
  "adjacent_product",
  "service",
  "platform",
  "manual_workaround",
  "status_quo",
  "non_consumption",
] as const;

export interface CommercialAuditProjection {
  readonly commercial_research_audit_refs: readonly string[];
  readonly quantitative_signal_rows: readonly Record<string, unknown>[];
  readonly competitive_substitute_rows: readonly Record<string, unknown>[];
  readonly research_coverage_gaps: readonly Record<string, unknown>[];
}

export function projectCommercialAuditTables(
  audits: readonly { readonly path: string; readonly document: Record<string, unknown> }[],
): CommercialAuditProjection {
  const sortedAudits = [...audits].sort((left, right) => left.path.localeCompare(right.path));
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
  const gapRows = sortedAudits.flatMap((audit) => [
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
  const auditsBySubject = new Map<string, typeof sortedAudits>();
  for (const audit of sortedAudits) {
    for (const subject of strings(audit.document.covered_direction_ids)) {
      auditsBySubject.set(subject, [...(auditsBySubject.get(subject) ?? []), audit]);
    }
  }
  for (const [subject, subjectAudits] of auditsBySubject) {
    const owner = subjectAudits[0];
    if (owner === undefined) continue;
    const quantitativeCovered = new Set(
      subjectAudits.flatMap((audit) =>
        records(audit.document.quantitative_coverage)
          .filter((entry) => entry.subject_id === subject)
          .map((entry) => String(entry.metric_family)),
      ),
    );
    const competitiveCovered = new Set(
      subjectAudits.flatMap((audit) =>
        records(audit.document.competitive_coverage)
          .filter((entry) => entry.subject_id === subject)
          .map((entry) => String(entry.competitor_type)),
      ),
    );
    for (const family of METRIC_FAMILIES.filter((entry) => !quantitativeCovered.has(entry))) {
      gapRows.push({
        audit_ref: owner.path,
        coverage_kind: "quantitative",
        coverage: {
          subject_id: subject,
          metric_family: family,
          state: "unavailable",
          observation_ids: [],
          query_attempts: [],
          reason: "This metric family was not assigned in any submitted Dispatch for the subject.",
          alternative_metric: null,
          decision_impact:
            "Aggregate completeness is limited; the absence constrains confidence and recommendation strength without invalidating the Lane artifact.",
        },
      });
    }
    for (const type of COMPETITOR_TYPES.filter((entry) => !competitiveCovered.has(entry))) {
      gapRows.push({
        audit_ref: owner.path,
        coverage_kind: "competitive",
        coverage: {
          subject_id: subject,
          competitor_type: type,
          state: "unavailable",
          competitive_object_ids: [],
          query_attempts: [],
          reason:
            "This competitor type was not assigned in any submitted Dispatch for the subject.",
          alternative_metric: null,
          decision_impact:
            "Aggregate substitute coverage is incomplete; ranking and strong recommendation remain constrained.",
        },
      });
    }
  }
  const rowKey = (row: Record<string, unknown>): string => {
    const coverage = isRecord(row.coverage) ? row.coverage : {};
    return `${String(row.audit_ref)}:${String(row.coverage_kind)}:${String(coverage.subject_id)}:${String(coverage.metric_family ?? coverage.competitor_type)}`;
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
    research_coverage_gaps: gapRows.sort((left, right) =>
      rowKey(left).localeCompare(rowKey(right)),
    ),
  };
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
    body.push([
      zh ? "全部" : "All",
      zh ? "量化与竞争" : "quantitative and competitive",
      zh ? "全部必需维度" : "all required dimensions",
      zh ? "已观察" : "observed",
      "-",
      zh ? "没有部分、不可用或不适用维度" : "No partial, unavailable, or not-applicable dimension",
      "-",
      zh ? "没有额外缺口影响" : "No additional gap impact",
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

const ZH_ENUMS: Readonly<Record<string, string>> = {
  blocked: "运行受阻",
  cancelled: "已取消",
  complete: "完整执行",
  completed: "已完成",
  continue_research: "继续研究",
  watch: "持续观察",
  excluded: "未采用",
  deprioritize: "降低优先级",
  deprioritized: "已降低优先级",
  failed: "运行失败",
  insufficient: "证据不足",
  insufficient_evidence: "证据不足",
  included: "已采用",
  investigate_further: "继续验证",
  not_applicable: "不适用",
  partial: "部分完成",
  limited: "受限采用",
  prioritize: "优先关注",
  reject: "淘汰",
  supported: "支持",
  opposed: "反对",
  mixed: "混合",
  no_signal: "暂无信号",
  source_unavailable: "来源不可用",
  unknown: "未知",
  independent_opportunity: "独立机会",
  segment_variant: "细分人群变体",
  delivery_or_implementation_variant: "交付或实施变体",
  unavailable: "来源不可用",
  user: "用户",
  main_agent: "主研究者",
  true: "是",
  false: "否",
};

const ZH_MECHANICAL_AUDIT_REASONS: Readonly<Record<string, string>> = {
  "Accepted by the Evidence Audit and used by the report traceability closure.":
    "已通过证据审计，并进入报告追踪闭包。",
  "Accepted research material was retained outside the report traceability closure.":
    "已保留为研究材料，但未进入报告追踪闭包。",
  "Included in the terminal report source projection.": "已进入终态报告来源投影。",
  "Accepted Discovery material was retained outside decisive report traceability.":
    "发现阶段材料已保留，但未进入决定性报告追踪闭包。",
  "The report traceability records non-current freshness for this material.":
    "报告追踪记录表明该材料并非当前时效。",
  "Accepted by a Discovery Source Manifest and used by report traceability.":
    "已由发现阶段来源清单接纳，并进入报告追踪闭包。",
};

const ZH_FIXED_REPORT_TERMS: Readonly<Record<string, string>> = {
  current_evidence_supports_priority_attention_not_market_validation:
    "当前材料支持优先关注，但不代表市场验证完成",
  current_evidence_supports_further_desk_research: "当前材料支持继续案头研究",
  current_evidence_supports_deprioritization: "当前材料支持降低优先级",
  current_evidence_cannot_support_a_directional_conclusion: "当前材料不足以支持方向性结论",
  assessment_result_and_evidence_strength: "评估结果与材料强度",
  concept_hypothesis: "产品假设",
  decisive_support_and_opposition: "关键支持与反对材料",
  demand_alternatives_solution_failure: "需求、替代方案与现有方案失效",
  quantitative_signals: "量化信号",
  competitive_substitute_matrix: "竞品与广义替代矩阵",
  incumbent_absorption_and_response_risk: "头部公司吸收与响应风险",
  competition_and_differentiation: "竞争与差异化",
  buyer_acquisition_business_engine: "买方、获客与商业模式",
  feasibility_compliance_ai_bundle: "可行性、合规与 AI 边界",
  critical_unknowns_and_kill_criteria: "关键未知与停止条件",
  decision_recommendation: "决策建议",
  optional_validation_suggestions: "可选验证建议",
  research_coverage_gaps: "研究覆盖缺口",
  limitations_and_sources: "限制与来源",
  conclusion_summary: "结论摘要",
  scope_and_profile: "范围与研究画像",
  portfolio: "方向组合",
  comparison_and_partial_order: "比较与局部排序",
  method_and_limitations: "方法与限制",
  top_opportunities: "优先机会",
  watchlist_and_reject: "观察与淘汰方向",
  sensitivity: "敏感性",
  traceability_and_sources: "可追溯性与来源",
};

const ZH_INTERNAL_CODES: readonly [RegExp, string][] = [
  [/\b(?:decision_grade|directional_proxy|context_only)\b/giu, "量化材料等级"],
  [/\b(?:not_ready|unranked_hypothesis)\b/giu, "尚未满足正式判断条件"],
  [/\b(?:opportunity_discovery|concept_evidence_assessment)\b/giu, "当前研究模式"],
  [/\b(?:assessment_early_kill|assessment_commercial|assessment_delivery)\b/giu, "评估阶段"],
  [/\b(?:discovery_generation|candidate_evaluation)\b/giu, "发现阶段"],
  [/\bsame[- ]run\b/giu, "本次研究内"],
  [/\bpre[- ]thesis\b/giu, "机会判断形成前"],
  [/\bbaseline\b/giu, "基线"],
  [/\bcounterfactual\b/giu, "反向检验"],
  [/\bManifest\b/gu, "研究状态索引"],
  [/\bSchema\b/gu, "结构合同"],
  [/\bValidator\b/gu, "校验机制"],
  [/\bGap\b/gu, "研究缺口"],
  [/\bEvidence\b/giu, "证据"],
  [/\bHarness\b/gu, "研究系统"],
  [/\bArtifacts?\b/gu, "研究材料"],
  [/\bcurrent-Run\b/giu, "本次研究"],
  [/\bRun\b/gu, "研究任务"],
];

const artifactRefPattern = (): RegExp =>
  /(?:artifacts|claims|evidence|findings|insights|judgments|plans|tasks)\/[A-Za-z0-9_./:#-]+/gu;

export function isChineseResearchLanguage(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase().startsWith("zh");
}

export function localizedEnum(value: unknown, zh: boolean): string {
  const raw = String(value);
  if (!zh) return raw.replaceAll("_", " ");
  const localized = ZH_ENUMS[raw];
  if (localized === undefined) {
    throw new Error(`report localized enum mapping is missing for ${raw}`);
  }
  return localized;
}

export function userVisibleText(value: unknown, zh: boolean): string {
  let text = String(value ?? "-");
  if (zh) {
    text = Object.entries(ZH_FIXED_REPORT_TERMS).reduce(
      (current, [term, replacement]) => current.replaceAll(term, replacement),
      text,
    );
    text = ZH_INTERNAL_CODES.reduce(
      (current, [pattern, replacement]) => current.replace(pattern, replacement),
      text,
    );
  }
  return text.replace(artifactRefPattern(), zh ? "详见结构化审计" : "see structured audit");
}

export function localizedAuditReason(value: unknown, zh: boolean): string {
  const raw = String(value);
  return zh ? (ZH_MECHANICAL_AUDIT_REASONS[raw] ?? userVisibleText(raw, true)) : raw;
}

export function boundedValues(
  values: readonly string[],
  limit: number,
): { readonly visible: readonly string[]; readonly omitted: number } {
  return { visible: values.slice(0, limit), omitted: Math.max(0, values.length - limit) };
}

export function localizedInternalLeakageIssues(
  language: unknown,
  markdown: string,
): readonly string[] {
  if (!isChineseResearchLanguage(language)) return [];
  const rules = [
    artifactRefPattern(),
    /\b(?:decision_grade|directional_proxy|context_only|not_ready|unranked_hypothesis)\b/iu,
    /\b(?:opportunity_discovery|concept_evidence_assessment|assessment_early_kill|assessment_commercial|assessment_delivery|discovery_generation|candidate_evaluation)\b/iu,
    /(?:决策层级|评估结果|状态|含义)\s*:\s*(?:watch|insufficient_evidence|investigate_further|continue_research|not_applicable|source_unavailable)\b/iu,
  ];
  return [
    ...rules.flatMap((rule, index) =>
      rule.test(markdown) ? [`localized_internal_term_${index + 1}`] : [],
    ),
    ...Object.keys(ZH_FIXED_REPORT_TERMS).flatMap((term) =>
      markdown.includes(term) ? [`localized_internal_term_${term}`] : [],
    ),
  ];
}

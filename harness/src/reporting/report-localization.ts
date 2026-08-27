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
  degraded: "降级运行",
  failed: "运行失败",
  healthy: "正常",
  insufficient: "证据不足",
  insufficient_evidence: "证据不足",
  no_recommendation: "暂无建议",
  included: "已采用",
  investigate_further: "继续验证",
  invest: "投入研究",
  validate: "验证",
  defer: "暂缓",
  not_applicable: "不适用",
  not_started: "尚未开始",
  executed: "已执行",
  legally_closed: "已按边界关闭",
  not_executed: "未执行",
  compared_multiple_formal_solutions: "已比较多个正式方案",
  explored_no_other_formal_solution: "已探索，未形成其他正式方案",
  not_yet_explored: "尚未探索其他实现方式",
  compared_selection: "比较后选定",
  provisional_implementation: "暂定实现",
  selected: "选中",
  alternative: "保留为替代",
  rejected: "未保留",
  partial: "部分完成",
  limited: "受限采用",
  moderate: "中等",
  weak: "较弱",
  strong: "较强",
  prioritize: "优先关注",
  reject: "淘汰",
  ranked: "已排序",
  supported: "支持",
  opposed: "反对",
  supports: "支持",
  opposes: "反对",
  context: "背景",
  mixed: "混合",
  no_signal: "暂无信号",
  source_unavailable: "来源不可用",
  unknown: "未知",
  declared: "已声明",
  inferred: "推断",
  no_evidence_found: "未发现证据",
  independent_opportunity: "独立机会",
  shared_opportunity_family: "共享机会家族",
  segment_variant: "细分人群变体",
  delivery_or_implementation_variant: "交付或实施变体",
  unavailable: "来源不可用",
  warning: "警告",
  info: "提示",
  integrity: "完整性",
  decision_validity: "决策有效性",
  coverage: "覆盖度",
  format: "格式",
  telemetry: "过程记录",
  user: "用户",
  job_to_be_done: "待完成任务",
  entry_scene: "进入场景",
  buyer: "买方",
  acquisition: "获客",
  compliance: "合规",
  delivery_boundary: "交付边界",
  other: "其他",
  main_agent: "主研究者",
  true: "是",
  false: "否",
  problem_space: "问题空间",
  demand_hypothesis: "需求假设",
  solution_seed: "方案种子",
  testable_product_hypothesis: "可测试产品假设",
  supported_opportunity_thesis: "有材料支持的机会论点",
  primary: "一手材料",
  strong_secondary: "强二手材料",
  secondary: "二手材料",
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

const ZH_DELIVERY_FORM_LABELS: Readonly<Record<string, string>> = {
  native_app: "原生应用",
  mini_program: "小程序",
  mobile_web: "移动网页",
  PWA: "渐进式网页应用",
  hybrid_app: "混合应用",
  platform_native: "平台原生形态",
  service_assisted: "服务辅助形态",
  status_quo: "现状",
  not_applicable: "不适用",
};

export interface LocalizedTerminalUserVisibleIssue extends Record<string, unknown> {
  readonly code: string;
  readonly field: string;
  readonly matched_text: string;
  readonly repair_hint: string;
}

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
  const text = String(value ?? "-");
  void zh;
  return text;
}

export function localizedFixedReportTerm(value: unknown, zh: boolean): string {
  const raw = String(value);
  if (!zh) return raw;
  const localized = ZH_FIXED_REPORT_TERMS[raw];
  if (localized === undefined) {
    throw new Error(`report localized fixed term mapping is missing for ${raw}`);
  }
  return localized;
}

export function localizedDeliveryForm(value: unknown, zh: boolean): string {
  const raw = String(value);
  const localized = ZH_DELIVERY_FORM_LABELS[raw];
  if (localized === undefined) {
    throw new Error(`report localized delivery_form mapping is missing for ${raw}`);
  }
  return zh ? localized : raw;
}

export function localizedAuditReason(value: unknown, zh: boolean): string {
  const raw = String(value);
  return zh ? (ZH_MECHANICAL_AUDIT_REASONS[raw] ?? raw) : raw;
}

const ZH_GATE_DIAGNOSTIC_TEMPLATES: Readonly<
  Record<string, { readonly message: string; readonly decisionImpact: string }>
> = {
  "commercial_research.vendor_claim_not_cross_validated": {
    message: "商业支持主要来自利益相关方，尚未被独立材料交叉确认。",
    decisionImpact: "相关判断保持保守，不能单独支持强排序或更高建议。",
  },
  "commercial_research.source_concentration": {
    message: "采用的证据集中在一个来源组。",
    decisionImpact: "证据置信度仍然有限。",
  },
  "commercial_research.independent_cross_validation_missing": {
    message: "当前支持材料缺少独立交叉确认。",
    decisionImpact: "在补充独立材料前，结论和建议强度保持保守。",
  },
  "commercial_research.regulatory_status_unverified": {
    message: "监管背景尚未完成当前有效性确认。",
    decisionImpact: "该材料不能单独支持当前监管结论。",
  },
  "commercial_research.quantitative_coverage_incomplete": {
    message: "量化覆盖尚未完整关闭。",
    decisionImpact: "量化完整性和建议强度保持受限。",
  },
  "commercial_research.competitive_coverage_incomplete": {
    message: "竞争与替代覆盖尚未完整关闭。",
    decisionImpact: "替代方案覆盖和建议强度保持受限。",
  },
  "commercial_research.assigned_scope_undisclosed": {
    message: "一个已分配的商业研究维度没有可用披露。",
    decisionImpact: "该维度按不可用处理，并约束相应置信度。",
  },
  "commercial_research.search_closure_log_missing": {
    message: "搜索完成记录不完整。",
    decisionImpact: "搜索完整性按未知披露；已采用材料仍保持可追溯。",
  },
  "commercial_research.secondary_source_traceability_limited": {
    message: "二手材料的追溯能力有限。",
    decisionImpact: "材料会被保留，但不能单独确立已观察商业指标。",
  },
  "commercial_research.positive_support_not_adopted": {
    message: "存在未被正式采用为正向支持的材料。",
    decisionImpact: "材料保持可追溯，但不能计为直接正向支持。",
  },
  "commercial_research.semantic_evidence_not_registered": {
    message: "引用材料没有进入正式商业研究采用闭包。",
    decisionImpact: "材料保留在研究闭包中，但不能计为已审计直接支持。",
  },
  "commercial_research.evidence_subject_unbound": {
    message: "材料没有绑定到可直接关闭覆盖的研究对象。",
    decisionImpact: "材料只作为背景或组合上下文保留。",
  },
  "commercial_research.gap_subject_unbound": {
    message: "未解决事项没有可确定绑定的具体研究对象。",
    decisionImpact: "该事项作为组合层研究上下文保留，不直接降低单个对象结论。",
  },
  "commercial_research.cross_lane_evidence_interpretation_conflict": {
    message: "当前研究材料存在解释冲突。",
    decisionImpact: "冲突保持可见；涉及已采用解释时，整体建议强度保持受限。",
  },
  "commercial_research.search_objective_unplanned": {
    message: "记录的检索路线未在计划中明确声明。",
    decisionImpact: "材料会被保留，但计划内搜索完整性不能被过度声明。",
  },
  "commercial_research.acquisition_evidence_not_adopted": {
    message: "获客或分发材料未被正式采用为观察结论。",
    decisionImpact: "该材料保持可见，但不能确立已观察量化状态。",
  },
  "commercial_research.quantitative_positive_support_not_adopted": {
    message: "量化正向材料未被正式采用。",
    decisionImpact: "该数值行作为受限材料保留，不能关闭直接量化覆盖。",
  },
  "commercial_research.competitive_positive_support_not_adopted": {
    message: "竞争或替代正向材料未被正式采用。",
    decisionImpact: "该替代材料作为受限材料保留，不能关闭直接竞争覆盖。",
  },
  "commercial_research.report_audit_closure_incomplete": {
    message: "计划中的商业研究记录没有完整进入报告闭包。",
    decisionImpact: "执行完整性保持不完整；只约束未被其他当前记录关闭的维度。",
  },
  "terminal_reporting.search_closure_incomplete": {
    message: "计划中的搜索完成记录缺失。",
    decisionImpact: "报告会披露执行不完整以及相关决策限制。",
  },
};

export function localizedGateDiagnostic(
  warning: Readonly<Record<string, unknown>>,
  zh: boolean,
): { readonly message: string; readonly decisionImpact: string } {
  if (!zh) {
    return {
      message: String(warning.message),
      decisionImpact: String(warning.decision_impact),
    };
  }
  const template = ZH_GATE_DIAGNOSTIC_TEMPLATES[String(warning.code)];
  return (
    template ?? {
      message: "研究系统记录了一条非阻塞诊断；原始诊断详情保留在结构化 report.json 中。",
      decisionImpact: unknownGateDiagnosticDecisionImpact(warning),
    }
  );
}

function optionalLocalizedEnum(value: unknown, zh: boolean): string {
  const raw = String(value);
  return zh ? (ZH_ENUMS[raw] ?? raw) : raw.replaceAll("_", " ");
}

function unknownGateDiagnosticDecisionImpact(warning: Readonly<Record<string, unknown>>): string {
  const severity = optionalLocalizedEnum(warning.severity ?? "warning", true);
  const category = optionalLocalizedEnum(warning.category ?? "unknown", true);
  const categoryImpact =
    warning.category === "decision_validity"
      ? "它可能约束排序、建议或结论强度。"
      : warning.category === "coverage"
        ? "它可能表示覆盖不足，并约束相关排序、建议或结论强度。"
        : warning.category === "integrity"
          ? "它可能表示完整性限制，并约束可交付结论。"
          : warning.category === "telemetry"
            ? "它可能限制过程完整性的声明。"
            : "它可能约束相关报告判断。";
  return `该诊断的级别为${severity}，类别为${category}；${categoryImpact}具体影响以结构化 report.json 中保留的原始决策影响为准。`;
}

export function localizedGateWarningRow(
  warning: Readonly<Record<string, unknown>>,
  zh: boolean,
): string {
  if (!zh) {
    return `- [${optionalLocalizedEnum(warning.severity, false)} / ${optionalLocalizedEnum(warning.category, false)}] ${String(warning.code)}: ${String(warning.message)} Decision impact: ${String(warning.decision_impact)}`;
  }
  const diagnostic = localizedGateDiagnostic(warning, true);
  return `- [${optionalLocalizedEnum(warning.severity, true)} / ${optionalLocalizedEnum(warning.category, true)}] ${diagnostic.message} 决策影响: ${diagnostic.decisionImpact}`;
}

export function boundedValues(
  values: readonly string[],
  limit: number,
): { readonly visible: readonly string[]; readonly omitted: number } {
  return { visible: values.slice(0, limit), omitted: Math.max(0, values.length - limit) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function joinPointer(root: string, part: string | number): string {
  return `${root}/${typeof part === "number" ? String(part) : escapeJsonPointer(part)}`;
}

function uniqueIssues(
  issues: readonly LocalizedTerminalUserVisibleIssue[],
): readonly LocalizedTerminalUserVisibleIssue[] {
  return [
    ...new Map(
      issues.map((issue) => [
        `${issue.code}\u0000${issue.field}\u0000${issue.matched_text}`,
        issue,
      ]),
    ).values(),
  ].sort((left, right) =>
    `${left.field}\u0000${left.code}\u0000${left.matched_text}`.localeCompare(
      `${right.field}\u0000${right.code}\u0000${right.matched_text}`,
    ),
  );
}

export function localizedTerminalSourceIssues(
  source: Readonly<Record<string, unknown>>,
  rootField = "#",
): readonly LocalizedTerminalUserVisibleIssue[] {
  void source;
  void rootField;
  return [];
}

export type LocalizedTerminalUserViewSurface =
  | "decision_brief"
  | "report"
  | "audit_appendix"
  | "markdown";

function auditDiagnosticSectionLines(markdown: string): readonly string[] | null {
  const normalized = markdown.replace(/\r\n?/gu, "\n");
  const coverageHeading = "\n## 完整研究覆盖缺口\n";
  const provenanceHeading = "\n## 研究来源沿袭\n";
  const followingHeading = "\n## 材料采用、限制与排除\n";
  const diagnosticHeading = "\n## 非阻塞诊断\n";
  const followingStart = normalized.lastIndexOf(followingHeading);
  if (followingStart < 0) return null;
  const provenanceStart = normalized.lastIndexOf(provenanceHeading, followingStart);
  if (provenanceStart < 0) return null;
  const coverageStart = normalized.lastIndexOf(coverageHeading, provenanceStart);
  if (coverageStart < 0) return null;
  const sectionStart = normalized.lastIndexOf(diagnosticHeading, provenanceStart);
  if (sectionStart < 0 || sectionStart < coverageStart) return null;
  return normalized
    .slice(sectionStart + diagnosticHeading.length, provenanceStart)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function terminalDiagnosticRowIssues(
  actualRows: readonly string[],
  expectedRows: readonly { readonly row: string; readonly field: string }[],
  rawRows: ReadonlyMap<string, { readonly field: string; readonly expectedRow: string }>,
  gateWarningsField: string,
): readonly LocalizedTerminalUserVisibleIssue[] {
  const remainingExpected = new Map<string, string[]>();
  for (const expected of expectedRows) {
    remainingExpected.set(expected.row, [
      ...(remainingExpected.get(expected.row) ?? []),
      expected.field,
    ]);
  }
  const issues: LocalizedTerminalUserVisibleIssue[] = [];
  for (const row of actualRows) {
    const expectedFields = remainingExpected.get(row);
    if (expectedFields !== undefined) {
      expectedFields.shift();
      if (expectedFields.length === 0) remainingExpected.delete(row);
      continue;
    }
    const rawMatch = rawRows.get(row);
    if (rawMatch !== undefined) remainingExpected.delete(rawMatch.expectedRow);
    issues.push({
      code:
        rawMatch === undefined
          ? "localized_harness_diagnostic_drift"
          : "unlocalized_harness_diagnostic",
      field: rawMatch?.field ?? gateWarningsField,
      matched_text: row,
      repair_hint:
        "Render Harness-owned diagnostics through the localized diagnostic row projection; keep exact code/message/decision_impact only in report.json and audit artifacts.",
    });
  }
  for (const [row, fields] of remainingExpected) {
    for (const field of fields) {
      issues.push({
        code: "localized_harness_diagnostic_missing",
        field,
        matched_text: row,
        repair_hint:
          "Render every expected Harness-owned diagnostic row through the localized audit appendix projection.",
      });
    }
  }
  return issues;
}

function terminalHarnessDiagnosticIssues(
  source: Readonly<Record<string, unknown>>,
  markdown: string,
  rootField: string,
  surface: string,
): readonly LocalizedTerminalUserVisibleIssue[] {
  if (surface !== "audit_appendix") return [];
  const warnings = records(source.gate_warnings);
  const gateWarningsField = joinPointer(rootField, "gate_warnings");
  const expectedRows =
    warnings.length === 0
      ? [
          {
            row: "- 没有非阻塞门禁诊断。",
            field: gateWarningsField,
          },
        ]
      : warnings.map((warning, index) => ({
          row: localizedGateWarningRow(warning, true),
          field: joinPointer(gateWarningsField, index),
        }));
  const rawRows = new Map(
    warnings.map((warning, index) => [
      localizedGateWarningRow(warning, false),
      {
        field: joinPointer(gateWarningsField, index),
        expectedRow: localizedGateWarningRow(warning, true),
      },
    ]),
  );
  const actualRows = auditDiagnosticSectionLines(markdown);
  if (actualRows === null) {
    return [
      {
        code: "localized_harness_diagnostic_section_missing",
        field: gateWarningsField,
        matched_text: "## 非阻塞诊断",
        repair_hint:
          "Render the audit appendix through the Harness-owned localized diagnostic section projection.",
      },
    ];
  }
  return terminalDiagnosticRowIssues(actualRows, expectedRows, rawRows, gateWarningsField);
}

export function localizedTerminalUserViewIssueDetails(
  source: Readonly<Record<string, unknown>>,
  markdown: string,
  surface: LocalizedTerminalUserViewSurface | string = "markdown",
  sourceRootField = "#",
): readonly LocalizedTerminalUserVisibleIssue[] {
  if (!isChineseResearchLanguage(source.research_language)) return [];
  return uniqueIssues(terminalHarnessDiagnosticIssues(source, markdown, sourceRootField, surface));
}

export function localizedTerminalDerivedDocumentIssueDetails(
  source: Readonly<Record<string, unknown>>,
  derivedDocument: Readonly<Record<string, unknown>>,
  sourceRootField = "#",
): readonly LocalizedTerminalUserVisibleIssue[] {
  if (!isChineseResearchLanguage(source.research_language)) return [];
  const materializedPath =
    typeof derivedDocument.materialized_path === "string" ? derivedDocument.materialized_path : "";
  const markdownSurface: LocalizedTerminalUserViewSurface =
    materializedPath === "decision-brief.md" ? "decision_brief" : "report";
  return uniqueIssues([
    ...(typeof derivedDocument.markdown === "string"
      ? localizedTerminalUserViewIssueDetails(
          source,
          derivedDocument.markdown,
          markdownSurface,
          sourceRootField,
        )
      : []),
    ...(typeof derivedDocument.audit_appendix_markdown === "string"
      ? localizedTerminalUserViewIssueDetails(
          source,
          derivedDocument.audit_appendix_markdown,
          "audit_appendix",
          sourceRootField,
        )
      : []),
  ]);
}

export function localizedTerminalUserViewIssues(
  source: Readonly<Record<string, unknown>>,
  markdown: string,
  surface: LocalizedTerminalUserViewSurface | string = "markdown",
): readonly string[] {
  return localizedTerminalUserViewIssueDetails(source, markdown, surface).map(
    (issue) => `${issue.code}:${issue.field}`,
  );
}

export function localizedInternalLeakageIssues(
  language: unknown,
  markdown: string,
): readonly string[] {
  void language;
  void markdown;
  return [];
}

import type { FormalArtifactEnvelope } from "../artifact-store/artifact-store.js";
import { canonicalContentHash, canonicalJson, sha256Bytes } from "../artifact-store/canonical.js";
import {
  deriveReportStatistics,
  renderCompetitiveSubjectSummary,
  renderCompetitiveSubstituteMatrix,
  renderCriticalResearchGaps,
  renderDecisionGradeQuantitativeSummary,
  renderGateWarnings,
  renderIncumbentResponseDisclosure,
  renderIncumbentResponseNarratives,
  renderIncumbentResponseRiskTable,
  renderQuantitativeSignalTable,
  renderResearchCoverageGaps,
} from "./commercial-report-tables.js";
import {
  REPORT_SCAN_CONTRACT_VERSION,
  REPORT_SCAN_SURFACES,
  scanDiscoveryReportSurfaces,
} from "./report-consistency.js";
import { renderEvidenceDispositions } from "./report-evidence-dispositions.js";
import { localizedDeliveryForm, userVisibleText } from "./report-localization.js";

export {
  localizedTerminalDerivedDocumentIssueDetails,
  localizedTerminalUserViewIssues,
} from "./report-localization.js";

const TERMINAL_REPORT_SECTION_IDS = [
  "execution",
  "research_conclusion",
  "runtime_health",
  "directions",
  "decisive_evidence",
  "research_provenance",
  "quantitative_signals",
  "competitive_substitute_matrix",
  "incumbent_absorption_and_response_risk",
  "research_coverage_gaps",
  "ordered_validation_plan",
  "freshness",
  "limitations",
] as const;

const TERMINAL_CONSISTENCY_DIMENSIONS = [
  "execution_conclusion_runtime_separation",
  "terminal_completeness",
  "planned_commercial_execution",
  "source_readability",
  "source_strength",
  "hypothesis_specificity",
  "validation_order",
  "freshness",
  "limitations",
  "external_action_boundary",
  "forbidden_language",
] as const;

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

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function reviewLiteralText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", "\n    ");
}

function callerAuthoredText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

const DISCOVERY_REVIEW_MATERIAL_REF_FIELDS = [
  "supporting_refs",
  "opposing_refs",
  "background_refs",
  "contradictory_refs",
  "unknown_refs",
] as const;

function projectedReviewMaterialVisibility(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const visibility = isRecord(document.material_visibility) ? document.material_visibility : {};
  return Object.fromEntries(
    DISCOVERY_REVIEW_MATERIAL_REF_FIELDS.map((field) => [
      field,
      uniqueSorted(strings(visibility[field])),
    ]),
  );
}

function projectedReviewFindings(
  document: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  return records(document.review_findings)
    .map((finding) => ({
      finding_id: finding.finding_id,
      stance: finding.stance,
      reviewed_plan_question_refs: uniqueSorted(strings(finding.reviewed_plan_question_refs)),
      evidence_state: finding.evidence_state,
      summary: finding.summary,
      supporting_refs: uniqueSorted(strings(finding.supporting_refs)),
      opposing_refs: uniqueSorted(strings(finding.opposing_refs)),
      background_refs: uniqueSorted(strings(finding.background_refs)),
      contradictory_refs: uniqueSorted(strings(finding.contradictory_refs)),
      unknown_refs: uniqueSorted(strings(finding.unknown_refs)),
      limitations: uniqueSorted(strings(finding.limitations)),
    }))
    .sort((left, right) => String(left.finding_id).localeCompare(String(right.finding_id)));
}

function projectedReviewGaps(
  document: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  return records(document.decision_relevant_gaps)
    .map((gap) => ({
      gap_id: gap.gap_id,
      state: gap.state,
      summary: gap.summary,
      basis_refs: uniqueSorted(strings(gap.basis_refs)),
      requires_plan_adaptation: gap.requires_plan_adaptation,
      recommended_follow_up: gap.recommended_follow_up,
      limitations: uniqueSorted(strings(gap.limitations)),
    }))
    .sort((left, right) => String(left.gap_id).localeCompare(String(right.gap_id)));
}

function projectedReviewSearchClosure(document: Record<string, unknown>): Record<string, unknown> {
  const closure = isRecord(document.search_closure) ? document.search_closure : {};
  return {
    status: closure.status,
    acquisition_routes_attempted: uniqueSorted(strings(closure.acquisition_routes_attempted)),
    adopted_source_refs: uniqueSorted(strings(closure.adopted_source_refs)),
    unresolved_gaps: uniqueSorted(strings(closure.unresolved_gaps)),
    stop_reason: closure.stop_reason,
  };
}

export function deriveDiscoveryReviewSummary(input: {
  readonly path: string;
  readonly contentHash: string;
  readonly document: Record<string, unknown>;
}): Record<string, unknown> {
  const subject = isRecord(input.document.review_subject) ? input.document.review_subject : {};
  return {
    review_ref: input.path,
    review_content_hash: input.contentHash,
    review_result_id: input.document.review_result_id,
    status: input.document.status,
    owner_role: input.document.owner_role,
    unit_id: input.document.unit_id,
    attempt: input.document.attempt,
    owned_output_path: input.document.owned_output_path,
    task_ref: input.document.task_ref,
    dispatch_batch_ref: input.document.dispatch_batch_ref,
    execution_plan_ref: input.document.execution_plan_ref,
    scope_frame_ref: input.document.scope_frame_ref,
    research_plan_ref: input.document.research_plan_ref,
    reviewed_plan_question_refs: uniqueSorted(strings(subject.reviewed_plan_question_refs)),
    required_stances: uniqueSorted(strings(input.document.required_stances)),
    review_findings: projectedReviewFindings(input.document),
    material_visibility: projectedReviewMaterialVisibility(input.document),
    decision_relevant_gaps: projectedReviewGaps(input.document),
    search_closure: projectedReviewSearchClosure(input.document),
    authority_boundary: isRecord(input.document.authority_boundary)
      ? {
          reference_only: input.document.authority_boundary.reference_only,
          not_gate: input.document.authority_boundary.not_gate,
          not_ranking: input.document.authority_boundary.not_ranking,
          not_elimination: input.document.authority_boundary.not_elimination,
          not_confidence_ceiling: input.document.authority_boundary.not_confidence_ceiling,
          mutates_current_plan: input.document.authority_boundary.mutates_current_plan,
          rewrites_report: input.document.authority_boundary.rewrites_report,
        }
      : {},
    valid_as_of: input.document.valid_as_of,
    limitations: uniqueSorted(strings(input.document.limitations)),
  };
}

export function deriveDiscoveryReviewSummaries(
  reviews: readonly {
    readonly path: string;
    readonly contentHash: string;
    readonly document: Record<string, unknown>;
  }[],
): readonly Record<string, unknown>[] {
  return reviews
    .map(deriveDiscoveryReviewSummary)
    .sort((left, right) => String(left.review_ref).localeCompare(String(right.review_ref)));
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`terminal report field ${field} must be an object`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`terminal report field ${field} must be a non-empty string`);
  }
  return value;
}

function requiredRecordArray(value: unknown, field: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new Error(`terminal report field ${field} must be an array of objects`);
  }
  return value as readonly Record<string, unknown>[];
}

function markdownListContinuation(value: unknown, field: string): string {
  return requiredString(value, field)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\n", "\n      ");
}

function revisionOf(path: string): string {
  const revision = path.match(
    /^artifacts\/reporting\/terminal-report-source\.(r[1-9][0-9]*)\.json$/,
  )?.[1];
  if (revision === undefined) {
    throw new Error("terminal report source path has no immutable revision");
  }
  return revision;
}

function isChinese(language: unknown): boolean {
  return typeof language === "string" && language.toLowerCase().startsWith("zh");
}

const ZH_ENUMS: Readonly<Record<string, string>> = {
  blocked: "运行受阻",
  captured_not_formalized: "已采集但未正式化",
  cancelled: "已取消",
  complete: "完整执行",
  completed: "已完成",
  degraded: "运行降级",
  deprioritize: "降低优先级",
  deprioritized: "已降低优先级",
  defer: "暂缓",
  failed: "运行失败",
  healthy: "运行正常",
  insufficient: "证据不足",
  insufficient_evidence: "证据不足",
  investigate_further: "继续验证",
  invest: "投入",
  moderate: "中等",
  no_recommendation: "暂不建议",
  not_started: "尚未开始",
  partial: "部分执行",
  prioritize: "优先关注",
  reject: "淘汰",
  runtime_failure: "运行失败阻断正式化",
  strong: "强",
  validate: "验证",
  weak: "弱",
  problem_space: "问题空间",
  demand_hypothesis: "需求假设",
  solution_seed: "方案种子",
  testable_product_hypothesis: "可测试产品假设",
  supported_opportunity_thesis: "已有商业证据支持的机会判断",
  primary: "一手/权威来源",
  strong_secondary: "强二手来源",
  secondary: "二手来源",
  supports: "支持",
  opposes: "反对",
  mixed: "混合",
  context: "背景",
  current: "当前",
  historical: "历史",
  unknown: "未知",
  applicable: "适用",
  partially_applicable: "部分适用",
  executed: "已执行",
  legally_closed: "已合法关闭",
  not_executed: "未执行",
  ranked: "可排序",
  unranked_hypothesis: "未排序待验证假设",
  observed_behavior: "观察到的行为",
  independent_report: "独立来源",
  vendor_claim: "厂商自报",
  inference: "推断",
  mechanism: "作用机制",
  effect_boundary: "作用边界",
  counterevidence: "反对材料",
  decision_grade: "决策级",
  directional_proxy: "方向性代理指标",
  context_only: "仅作背景",
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
  unit_economics: "单位经济",
  compared_multiple_formal_solutions: "已比较多个正式方案",
  explored_no_other_formal_solution: "已探索，未形成其他正式方案",
  not_yet_explored: "尚未探索其他实现方式",
  not_applicable: "不适用",
  compared_selection: "比较后选定",
  provisional_implementation: "暂定实现",
  selected: "选中",
  alternative: "保留为替代",
  rejected: "未保留",
};

function enumLabel(value: unknown, zh: boolean): string {
  const text = String(value);
  if (zh) {
    const localized = ZH_ENUMS[text];
    if (localized === undefined) {
      throw new Error(`terminal report localized enum mapping is missing for ${text}`);
    }
    return localized;
  }
  return text.replaceAll("_", " ");
}

const REVIEW_ENUM_LABELS: Readonly<Record<"zh" | "en", Readonly<Record<string, string>>>> = {
  zh: {
    "adversarial-reviewer": "对抗审阅者",
    completed: "已完成",
    partial: "部分完成",
    insufficient_evidence: "证据不足",
    failed: "失败",
    ignored_late: "已忽略（迟到）",
    superseded: "已被取代",
    support: "支持",
    oppose: "反对",
    mixed: "混合",
    background: "背景",
    unknown: "未知",
    supported: "已支持",
    unavailable: "不可用",
    inferred: "推断",
    not_applicable: "不适用",
    no_evidence_found: "未找到证据",
    add_unit: "添加任务",
    retry_unit: "重试任务",
    wait: "等待",
    manual_review: "人工复核",
    no_action: "无需动作",
    failed_before_search: "搜索前失败",
    search_not_required: "无需搜索",
  },
  en: {
    "adversarial-reviewer": "adversarial reviewer",
    completed: "completed",
    partial: "partial",
    insufficient_evidence: "insufficient evidence",
    failed: "failed",
    ignored_late: "ignored late",
    superseded: "superseded",
    support: "support",
    oppose: "oppose",
    mixed: "mixed",
    background: "background",
    unknown: "unknown",
    supported: "supported",
    unavailable: "unavailable",
    inferred: "inferred",
    not_applicable: "not applicable",
    no_evidence_found: "no evidence found",
    add_unit: "add unit",
    retry_unit: "retry unit",
    wait: "wait",
    manual_review: "manual review",
    no_action: "no action",
    failed_before_search: "failed before search",
    search_not_required: "search not required",
  },
};

function reviewEnumLabel(value: unknown, zh: boolean): string {
  const text = String(value);
  const localized = (zh ? REVIEW_ENUM_LABELS.zh : REVIEW_ENUM_LABELS.en)[text];
  if (localized === undefined) {
    throw new Error(`terminal report review enum mapping is missing for ${text}`);
  }
  return localized;
}

function reviewEnumList(values: readonly string[], zh: boolean): string {
  return values.map((value) => reviewEnumLabel(value, zh)).join(", ");
}

function prose(value: unknown, zh: boolean): string {
  return zh ? userVisibleText(value, true) : String(value);
}

function marketPriorityLabel(value: unknown, zh: boolean): string {
  if (!zh) return enumLabel(value, false);
  return (
    ({ high: "高", medium: "中", low: "低" } as Readonly<Record<string, string>>)[String(value)] ??
    enumLabel(value, true)
  );
}

function commercialReadinessLabel(value: unknown, zh: boolean): string {
  if (!zh) return enumLabel(value, false);
  return (
    (
      { ready: "已就绪", partial: "部分就绪", not_ready: "未就绪" } as Readonly<
        Record<string, string>
      >
    )[String(value)] ?? enumLabel(value, true)
  );
}

function substrateInventoryReasonLabel(value: unknown, zh: boolean): string {
  switch (value) {
    case "runtime_failure":
      return zh ? "运行失败阻断正式化" : "runtime failure";
    case "insufficient_evidence":
      return zh ? "证据不足导致未正式化" : "insufficient evidence";
    case "cancelled":
      return zh ? "已取消导致未正式化" : "cancelled";
    case "deprioritized":
      return zh ? "已降低优先级导致未正式化" : "deprioritized";
    default:
      throw new Error(
        `terminal report captured substrate unformalized_reason is unsupported: ${String(value)}`,
      );
  }
}

function substrateInventoryStatusLabel(value: unknown, zh: boolean): string {
  if (value !== "captured_not_formalized") {
    throw new Error(`terminal report captured substrate status is unsupported: ${String(value)}`);
  }
  return zh ? "已采集但未正式化" : "captured but not formalized";
}

function substrateConclusionBoundaryLabel(value: unknown, zh: boolean): string {
  if (value !== "does_not_support_conclusions") {
    throw new Error(
      `terminal report captured substrate conclusion_support_status is unsupported: ${String(
        value,
      )}`,
    );
  }
  return zh ? "不支持任何研究结论" : "does not support any research conclusion";
}

function substrateEvidenceRef(value: unknown, field: string): string {
  const ref = requiredString(value, field);
  if (!/^evidence\/manifest\.jsonl#ev_[a-f0-9]{64}$/u.test(ref)) {
    throw new Error(`terminal report field ${field} must be an exact Evidence Store ref`);
  }
  return ref;
}

function capturedSubstrateInventory(
  provenance: Record<string, unknown>,
): Record<string, unknown> | null {
  if (provenance.captured_substrate_inventory === undefined) return null;
  return requiredRecord(
    provenance.captured_substrate_inventory,
    "research_provenance.captured_substrate_inventory",
  );
}

function capturedSubstrateInventoryItems(
  inventory: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const items = requiredRecordArray(
    inventory.items,
    "research_provenance.captured_substrate_inventory.items",
  );
  if (items.length === 0) {
    throw new Error("terminal report captured substrate inventory must contain at least one item");
  }
  return items;
}

function substrateSourceDisplay(sourceValue: unknown, zh: boolean): string {
  const source = requiredRecord(
    sourceValue,
    "research_provenance.captured_substrate_inventory.items[].source",
  );
  switch (source.kind) {
    case "public_url": {
      const url = requiredString(
        source.canonical_url,
        "research_provenance.captured_substrate_inventory.items[].source.canonical_url",
      );
      return zh ? `[公开来源](${url})` : `[public source](${url})`;
    }
    case "user_provided": {
      const uri = requiredString(
        source.canonical_uri,
        "research_provenance.captured_substrate_inventory.items[].source.canonical_uri",
      );
      return zh ? `用户提供/非公开 \`${uri}\`` : `user-provided/non-public \`${uri}\``;
    }
    default:
      throw new Error(
        `terminal report captured substrate source kind is unsupported: ${String(source.kind)}`,
      );
  }
}

function renderCapturedSubstrateInventory(
  inventory: Record<string, unknown>,
  zh: boolean,
  detailed: boolean,
): string {
  const items = capturedSubstrateInventoryItems(inventory);
  const lines = [
    `- ${zh ? "已采集但未正式化的材料" : "Captured but not formalized substrate inventory"}: ${String(items.length)} (${zh ? "状态" : "status"}: ${substrateInventoryStatusLabel(inventory.status, zh)}; ${zh ? "原因" : "reason"}: ${substrateInventoryReasonLabel(inventory.unformalized_reason, zh)}; ${zh ? "结论边界" : "conclusion boundary"}: ${substrateConclusionBoundaryLabel(inventory.conclusion_support_status, zh)})`,
  ];
  if (detailed) {
    lines.push(
      ...items.flatMap((item, index) => [
        `  - ${index + 1}. ${substrateEvidenceRef(
          item.evidence_ref,
          "research_provenance.captured_substrate_inventory.items[].evidence_ref",
        )}`,
        `    - ${zh ? "来源" : "Source"}: ${substrateSourceDisplay(item.source, zh)}`,
        `    - ${zh ? "记录时间" : "Recorded at"}: ${requiredString(
          item.recorded_at,
          "research_provenance.captured_substrate_inventory.items[].recorded_at",
        )}`,
        `    - ${zh ? "处置状态" : "Status"}: ${substrateInventoryStatusLabel(item.status, zh)}`,
        `    - ${zh ? "研究目标" : "Research goal"}: ${markdownListContinuation(
          item.research_goal,
          "research_provenance.captured_substrate_inventory.items[].research_goal",
        )}`,
      ]),
    );
  }
  return lines.join("\n");
}

function bulletList(values: readonly string[], emptyText: string): string {
  return values.length === 0
    ? `- ${emptyText}\n`
    : `${values.map((value) => `- ${value}`).join("\n")}\n`;
}

function boundedBulletList(
  values: readonly string[],
  emptyText: string,
  limit: number,
  omittedLabel: (count: number) => string,
): string {
  if (values.length <= limit) return bulletList(values, emptyText);
  return bulletList([...values.slice(0, limit), omittedLabel(values.length - limit)], emptyText);
}

function renderExecution(source: Record<string, unknown>, zh: boolean): string {
  const execution = requiredRecord(source.execution, "execution");
  const completedStages = zh
    ? strings(execution.completed_stages).map((_, index) => `已完成环节 ${index + 1}`)
    : strings(execution.completed_stages);
  const incomplete = records(execution.incomplete_stages).map((stage) => {
    const refs = strings(stage.related_refs);
    const audit = refs.length === 0 ? "" : zh ? "（详见审计附录）" : " (see audit appendix)";
    return `${zh ? "对结论的影响" : "Conclusion impact"}: ${prose(stage.conclusion_impact, zh)}${audit}`;
  });
  const followups = records(execution.required_followups).map(
    (followup) => `${enumLabel(followup.status, zh)} - ${prose(followup.detail, zh)}`,
  );
  return [
    `${zh ? "执行完整度" : "Completeness"}: ${enumLabel(execution.completeness, zh)}\n\n`,
    `${zh ? "已完成阶段" : "Completed stages"}:\n`,
    boundedBulletList(completedStages, zh ? "无" : "None", 5, (count) =>
      zh ? `其余 ${count} 个完成环节见核心报告。` : `${count} more completed stages.`,
    ),
    `\n${zh ? "未完成阶段" : "Incomplete stages"}:\n`,
    boundedBulletList(incomplete, zh ? "无" : "None", 5, (count) =>
      zh
        ? `其余 ${count} 个未完成环节见审计附录。`
        : `${count} more incomplete stages in the audit appendix.`,
    ),
    `\n${zh ? "必需追加调研" : "Required follow-ups"}:\n`,
    boundedBulletList(followups, zh ? "无" : "None", 5, (count) =>
      zh ? `其余 ${count} 项见核心报告。` : `${count} more follow-ups in the core report.`,
    ),
  ].join("");
}

function renderRuntimeHealth(source: Record<string, unknown>, zh: boolean): string {
  const runtime = requiredRecord(source.runtime_health, "runtime_health");
  const issues = records(runtime.issues).map(
    (issue) =>
      `${zh ? "对结论的影响" : "Conclusion impact"}: ${prose(issue.conclusion_impact, zh)}`,
  );
  return [
    `${zh ? "状态" : "Status"}: ${enumLabel(runtime.status, zh)}\n\n`,
    bulletList(issues, zh ? "没有记录运行问题" : "No runtime issues recorded"),
  ].join("");
}

function renderDirections(source: Record<string, unknown>, zh: boolean, compact: boolean): string {
  const allDirections = [...records(source.directions)].sort((left, right) => {
    if (left.priority === null && right.priority === null)
      return String(left.direction_id).localeCompare(String(right.direction_id));
    if (left.priority === null) return 1;
    if (right.priority === null) return -1;
    return Number(left.priority) - Number(right.priority);
  });
  const uncertainties = records(source.commercial_uncertainties);
  const commercialBySubject = new Map(
    records(source.commercial_subject_aggregates).map((aggregate) => [
      String(aggregate.subject_id),
      aggregate,
    ]),
  );
  if (allDirections.length === 0) {
    return zh ? "- 当前没有可交付的方向。\n" : "- No direction is currently deliverable.\n";
  }
  const directions = compact ? allDirections.slice(0, 3) : allDirections;
  const rendered = directions
    .map((direction) => {
      const commercial = commercialBySubject.get(String(direction.direction_id));
      const marketPriority = isRecord(commercial?.market_research_priority)
        ? commercial.market_research_priority
        : null;
      const commercialReadiness = isRecord(commercial?.commercial_validation_readiness)
        ? commercial.commercial_validation_readiness
        : null;
      const lines = compact
        ? [
            `### ${direction.priority === null ? (zh ? "待验证" : "Unranked") : String(direction.priority)}. ${prose(direction.label, zh)}\n`,
            `${zh ? "成熟度 / 当前动作" : "Maturity / action"}: ${enumLabel(direction.maturity, zh)} / ${enumLabel(direction.action, zh)}\n\n`,
            `${zh ? "市场研究优先级" : "Market research priority"}: ${marketPriorityLabel(marketPriority?.level ?? "unknown", zh)}\n\n`,
            `${zh ? "商业验证就绪度" : "Commercial validation readiness"}: ${commercialReadinessLabel(commercialReadiness?.level ?? "not_ready", zh)}\n\n`,
            `${zh ? "核心价值" : "Core value"}: ${prose(direction.core_value, zh)}\n\n`,
            `${zh ? "最先验证的假设" : "First testable assumption"}: ${prose(direction.first_testable_assumption, zh)}\n\n`,
            `${zh ? "排序理由" : "Comparison reason"}: ${prose(direction.comparison_reason, zh)}\n`,
          ]
        : [
            `### ${direction.priority === null ? (zh ? "待验证" : "Unranked") : String(direction.priority)}. ${prose(direction.label, zh)}\n`,
            `${zh ? "排序状态" : "Ranking status"}: ${enumLabel(direction.ranking_status, zh)}\n\n`,
            `${zh ? "成熟度" : "Maturity"}: ${enumLabel(direction.maturity, zh)}\n\n`,
            `${zh ? "当前动作" : "Current action"}: ${enumLabel(direction.action, zh)}\n\n`,
            `${zh ? "市场研究优先级" : "Market research priority"}: ${marketPriorityLabel(marketPriority?.level ?? "unknown", zh)}\n\n`,
            `${zh ? "商业验证就绪度" : "Commercial validation readiness"}: ${commercialReadinessLabel(commercialReadiness?.level ?? "not_ready", zh)}\n\n`,
            `${zh ? "目标用户" : "Target user"}: ${prose(direction.target_user, zh)}\n\n`,
            `${zh ? "窄场景" : "Narrow scenario"}: ${prose(direction.narrow_scenario, zh)}\n\n`,
            `${zh ? "当前替代" : "Current alternative"}: ${prose(direction.current_alternative, zh)}\n\n`,
            `${zh ? "付款方" : "Payer"}: ${prose(direction.payer, zh)}\n\n`,
            `${zh ? "产品/服务形态" : "Product or service form"}: ${prose(direction.product_form, zh)}\n\n`,
            `${zh ? "核心价值" : "Core value"}: ${prose(direction.core_value, zh)}\n\n`,
            `${zh ? "为什么现在值得关注" : "Why now"}: ${prose(direction.why_now, zh)}\n\n`,
            `${zh ? "最先验证的假设" : "First testable assumption"}: ${prose(direction.first_testable_assumption, zh)}\n\n`,
            `${zh ? "排序理由" : "Comparison reason"}: ${prose(direction.comparison_reason, zh)}\n`,
          ];
      if (!compact) {
        lines.push(`\n${zh ? "问题" : "Problem"}: ${prose(direction.problem, zh)}\n`);
        lines.push(`\n${zh ? "关键风险" : "Key risks"}:\n`);
        lines.push(
          bulletList(
            strings(direction.key_risks).map((entry) => prose(entry, zh)),
            zh ? "无" : "None",
          ),
        );
        lines.push(`\n${zh ? "仍未回答" : "Open questions"}:\n`);
        lines.push(
          bulletList(
            strings(direction.open_questions).map((entry) => prose(entry, zh)),
            zh ? "无" : "None",
          ),
        );
      }
      const solutionSummary = isRecord(direction.solution_evaluation_summary)
        ? direction.solution_evaluation_summary
        : null;
      if (solutionSummary !== null) {
        lines.push(
          `\n${zh ? "替代方案探索状态" : "Alternative exploration status"}: ${enumLabel(solutionSummary.exploration_status, zh)}\n\n`,
          `${zh ? "当前方案表述" : "Current solution posture"}: ${enumLabel(solutionSummary.selection_posture, zh)}\n\n`,
          `${zh ? "全部正式方案" : "All formal solutions"}:\n`,
          bulletList(
            records(solutionSummary.formal_solutions).map((solution) => {
              const ai =
                solution.uses_ai === true
                  ? zh
                    ? "使用 AI"
                    : "uses AI"
                  : zh
                    ? "不使用 AI"
                    : "does not use AI";
              return `${enumLabel(solution.disposition, zh)}: ${userVisibleText(solution.solution_behavior, zh)} (${userVisibleText(solution.solution_type, zh)}; ${localizedDeliveryForm(solution.delivery_form, zh)}; ${ai})`;
            }),
            zh ? "无" : "None recorded",
          ),
        );
        if (!compact) {
          lines.push(
            `\n${zh ? "研究过但未正式化的方向" : "Considered but non-formalized approaches"}:\n`,
            bulletList(
              records(solutionSummary.considered_approaches).map(
                (approach) =>
                  `${callerAuthoredText(approach.implementation_direction)}: ${strings(
                    approach.disposition_reasons,
                  )
                    .map((reason) => callerAuthoredText(reason))
                    .join("; ")}`,
              ),
              zh ? "无" : "None recorded",
            ),
          );
        }
      }
      const directionUncertainties = uncertainties.filter(
        (entry) => entry.direction_id === direction.direction_id,
      );
      if (directionUncertainties.length > 0) {
        lines.push(`\n${zh ? "商业判断中的推测与未知" : "Commercial Inferences And Unknowns"}:\n`);
        lines.push(
          bulletList(
            directionUncertainties.map((entry) =>
              entry.state === "inferred"
                ? zh
                  ? `推测：${callerAuthoredText(entry.statement)}；推理起点：${callerAuthoredText(entry.starting_point)}；推理过程：${callerAuthoredText(entry.reasoning)}；不确定性：${callerAuthoredText(entry.uncertainty)}；待验证：${callerAuthoredText(entry.validation_needed)}`
                  : `Inference: ${String(entry.statement)}; starting point: ${String(entry.starting_point)}; reasoning: ${String(entry.reasoning)}; uncertainty: ${String(entry.uncertainty)}; validation needed: ${String(entry.validation_needed)}`
                : zh
                  ? `未知：${callerAuthoredText(entry.statement)}；不确定性：${callerAuthoredText(entry.uncertainty)}；待验证：${callerAuthoredText(entry.validation_needed)}`
                  : `Unknown: ${String(entry.statement)}; uncertainty: ${String(entry.uncertainty)}; validation needed: ${String(entry.validation_needed)}`,
            ),
            zh ? "无" : "None",
          ),
        );
      }
      return lines.join("");
    })
    .join("\n");
  const omitted = allDirections.length - directions.length;
  return `${rendered}${
    omitted === 0
      ? ""
      : `\n- ${zh ? `其余 ${omitted} 个方向保留在核心报告。` : `${omitted} additional direction${omitted === 1 ? "" : "s"} remain in the core report.`}\n`
  }`;
}

function renderSources(source: Record<string, unknown>, zh: boolean, limit?: number): string {
  const allSources = records(source.sources);
  const sources = limit === undefined ? allSources : allSources.slice(0, limit);
  const items = sources.map((entry) => {
    const validity =
      entry.valid_as_of === null ? (zh ? "日期未知" : "date unknown") : String(entry.valid_as_of);
    const sourceLabel =
      entry.source_access === "user_provided_non_public"
        ? zh
          ? `${String(entry.title)}（用户提供/非公开）`
          : `${String(entry.title)} (user-provided/non-public)`
        : `[${String(entry.title)}](${String(entry.url)})`;
    const base = `${sourceLabel} (${validity}; ${enumLabel(entry.stance, zh)}; ${enumLabel(entry.strength, zh)}; ${enumLabel(entry.evidence_character, zh)})`;
    if (entry.claim_state !== "inferred" || !isRecord(entry.inference)) {
      return `${base}: ${prose(entry.claim, zh)}`;
    }
    const inference = entry.inference;
    return zh
      ? `${base}: 推测：${callerAuthoredText(entry.claim)}；推理起点：${callerAuthoredText(inference.starting_point)}；推理过程：${callerAuthoredText(inference.reasoning)}；不确定性：${callerAuthoredText(inference.uncertainty)}；待验证：${callerAuthoredText(inference.validation_needed)}`
      : `${base}: Inference: ${String(entry.claim)}; starting point: ${String(inference.starting_point)}; reasoning: ${String(inference.reasoning)}; uncertainty: ${String(inference.uncertainty)}; validation needed: ${String(inference.validation_needed)}`;
  });
  const omitted = allSources.length - sources.length;
  return `${bulletList(items, zh ? "没有可引用来源" : "No readable source recorded")}${
    omitted === 0
      ? ""
      : `- ${zh ? `其余 ${omitted} 条可读来源保留在核心报告和审计附录。` : `${omitted} additional readable source${omitted === 1 ? "" : "s"} remain in the core report and audit appendix.`}\n`
  }`;
}

function renderStatistics(source: Record<string, unknown>, zh: boolean): string {
  const statistics = isRecord(source.report_statistics) ? source.report_statistics : {};
  return zh
    ? `- 可读来源 ${String(statistics.readable_source_count ?? 0)}；量化信号 ${String(statistics.quantitative_signal_count ?? 0)}（决策级 ${String(statistics.decision_grade_quantitative_signal_count ?? 0)}，方向/背景 ${String(statistics.directional_or_context_quantitative_signal_count ?? 0)}）；竞品/替代对象 ${String(statistics.competitive_object_count ?? 0)}；完整缺口行 ${String(statistics.full_gap_row_count ?? 0)}；核心缺口组 ${String(statistics.critical_gap_group_count ?? 0)}。\n`
    : `- Readable sources ${String(statistics.readable_source_count ?? 0)}; quantitative signals ${String(statistics.quantitative_signal_count ?? 0)} (decision-grade ${String(statistics.decision_grade_quantitative_signal_count ?? 0)}, directional/context ${String(statistics.directional_or_context_quantitative_signal_count ?? 0)}); competitive/substitute objects ${String(statistics.competitive_object_count ?? 0)}; full gap rows ${String(statistics.full_gap_row_count ?? 0)}; critical gap groups ${String(statistics.critical_gap_group_count ?? 0)}.\n`;
}

function userExecutionProjection(source: Record<string, unknown>): Record<string, unknown> {
  const execution = requiredRecord(source.execution, "execution");
  return {
    completeness: execution.completeness,
    completed_stage_count: strings(execution.completed_stages).length,
    incomplete_stage_impacts: records(execution.incomplete_stages).map((stage) => ({
      conclusion_impact: stage.conclusion_impact,
    })),
    required_followups: records(execution.required_followups).map((followup) => ({
      status: followup.status,
      detail: followup.detail,
    })),
  };
}

function userRuntimeHealthProjection(source: Record<string, unknown>): Record<string, unknown> {
  const runtime = requiredRecord(source.runtime_health, "runtime_health");
  return {
    status: runtime.status,
    conclusion_impacts: records(runtime.issues).map((issue) => issue.conclusion_impact),
  };
}

function terminalStatisticsSource(source: Record<string, unknown>): Record<string, unknown> {
  return { ...source, report_statistics: deriveReportStatistics(source) };
}

function terminalFullCommercialProjectionSource(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const fullProjection = isRecord(source.full_commercial_projection)
    ? source.full_commercial_projection
    : null;
  if (fullProjection === null) return source;
  const auditSource = { ...source, ...fullProjection };
  return { ...auditSource, report_statistics: deriveReportStatistics(auditSource) };
}

function renderValidationPlan(
  source: Record<string, unknown>,
  zh: boolean,
  limit?: number,
): string {
  const allSteps = [...records(source.ordered_validation_plan)].sort(
    (left, right) => Number(left.order) - Number(right.order),
  );
  if (allSteps.length === 0) {
    return zh
      ? "- 当前没有建议的验证动作。\n"
      : "- No validation action is currently recommended.\n";
  }
  const steps = limit === undefined ? allSteps : allSteps.slice(0, limit);
  const rendered = steps
    .map((step) =>
      [
        `### ${String(step.order)}. ${prose(step.hypothesis, zh)}\n`,
        `${zh ? "为何先做" : "Why now"}: ${prose(step.why_now, zh)}\n\n`,
        `${zh ? "通过信号" : "Pass signal"}: ${prose(step.pass_signal, zh)}\n\n`,
        `${zh ? "失败信号" : "Fail signal"}: ${prose(step.fail_signal, zh)}\n\n`,
        `${zh ? "如何改变决定" : "Decision effect"}: ${prose(step.decision_effect, zh)}\n\n`,
        zh
          ? "执行边界：涉及外部行动时由用户自行决定和执行，本研究工具不执行或跟踪结果。\n"
          : "Execution boundary: external action remains user-owned; the Harness does not execute or track it.\n",
      ].join(""),
    )
    .join("\n");
  const omitted = allSteps.length - steps.length;
  return `${rendered}${
    omitted === 0
      ? ""
      : `\n- ${zh ? `其余 ${omitted} 项建议保留在核心报告。` : `${omitted} additional recommendation${omitted === 1 ? "" : "s"} remain in the core report.`}\n`
  }`;
}

function renderResearchProvenance(
  source: Record<string, unknown>,
  zh: boolean,
  detailed = false,
): string {
  const provenance = requiredRecord(source.research_provenance, "research_provenance");
  const used = records(provenance.used_handoff_items);
  const imported = strings(provenance.imported_substrate_refs);
  const inherited = strings(provenance.adopted_inherited_evidence_refs);
  const inheritedCited = strings(provenance.cited_inherited_evidence_refs);
  const current = strings(provenance.adopted_current_evidence_refs);
  const currentCited = strings(provenance.cited_current_evidence_refs);
  const revalidation = records(provenance.revalidation_gaps);
  const capturedInventory = capturedSubstrateInventory(provenance);
  const lines = [
    `- ${zh ? "可用交接 / 捕获条目" : "Available handoffs / captured items"}: ${String(provenance.available_handoff_count)} / ${String(provenance.captured_item_count)}`,
    `- ${zh ? "已消费 / 实际用于形成" : "Consumed / used for formation"}: ${strings(provenance.consumed_item_refs).length} / ${used.length}`,
    `- ${zh ? "导入的原始材料" : "Imported substrate inventory"}: ${imported.length}`,
    `- ${zh ? "采用 / 报告引用的继承材料" : "Adopted / cited inherited Evidence"}: ${inherited.length} / ${inheritedCited.length}`,
    `- ${zh ? "采用 / 报告引用的本次材料" : "Adopted / cited current-Run Evidence"}: ${current.length} / ${currentCited.length}`,
    `- ${zh ? "适用性或重验缺口" : "Applicability or revalidation gaps"}: ${revalidation.length}`,
  ];
  if (capturedInventory !== null) {
    lines.push(renderCapturedSubstrateInventory(capturedInventory, zh, detailed));
  }
  if (detailed && revalidation.length > 0) {
    lines.push(
      ...revalidation.map((item, index) =>
        zh
          ? `  - 重验条目 ${index + 1}（${enumLabel(item.freshness_disposition, true)}；${enumLabel(item.applicability_disposition, true)}）`
          : `  - ${String(item.source_artifact_path)} (${String(item.freshness_disposition)}; ${String(item.applicability_disposition)})`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderDiscoveryReviewReferenceNotice(
  source: Record<string, unknown>,
  zh: boolean,
): string {
  const count = records(source.discovery_review_summaries).length;
  if (count === 0) return "";
  return zh
    ? `\n## 发现对抗性复核边界\n\n已发布 ${count} 个发现阶段对抗性复核结果；它们在审计附录中逐项列出，仅供引用，不作为 Gate、排序、淘汰或信心上限依据。\n\n`
    : `\n## Discovery Adversarial Review Boundary\n\n${count} Discovery adversarial review result${count === 1 ? "" : "s"} are listed in the audit appendix as reference-only material; they are not a Gate, ranking, elimination, or confidence-ceiling authority.\n\n`;
}

function renderBriefCapturedSubstrateInventory(
  source: Record<string, unknown>,
  zh: boolean,
): string {
  const provenance = requiredRecord(source.research_provenance, "research_provenance");
  const inventory = capturedSubstrateInventory(provenance);
  if (inventory === null) return "";
  return [
    `\n## ${zh ? "已采集但未正式化材料" : "Captured But Not Formalized Materials"}\n`,
    renderCapturedSubstrateInventory(inventory, zh, false),
    "\n",
  ].join("");
}

export function renderTerminalDecisionBrief(source: Record<string, unknown>): string {
  const zh = isChinese(source.research_language);
  const conclusion = requiredRecord(source.research_conclusion, "research_conclusion");
  const freshness = requiredRecord(source.freshness, "freshness");
  const statisticsSource = terminalStatisticsSource(source);
  return [
    `# ${zh ? "决策简报" : "Decision Brief"}\n\n`,
    `## ${zh ? "现在应该做什么" : "What To Do Now"}\n`,
    `${prose(conclusion.current_recommendation, zh)}\n\n`,
    `${zh ? "研究结论" : "Research conclusion"}: ${enumLabel(conclusion.outcome, zh)}\n\n`,
    `${zh ? "证据强度" : "Evidence strength"}: ${enumLabel(conclusion.evidence_strength, zh)}\n\n`,
    `${zh ? "这意味着" : "Meaning"}: ${prose(conclusion.meaning, zh)}\n\n`,
    `## ${zh ? "研究概览" : "Research At A Glance"}\n`,
    renderStatistics(statisticsSource, zh),
    `## ${zh ? "执行完整度" : "Execution Completeness"}\n`,
    renderExecution(source, zh),
    `\n## ${zh ? "运行健康" : "Runtime Health"}\n`,
    renderRuntimeHealth(source, zh),
    renderBriefCapturedSubstrateInventory(source, zh),
    `\n## ${zh ? "优先方向与可测试产品假设" : "Priority Directions And Testable Product Hypotheses"}\n`,
    renderDirections(source, zh, true),
    `\n## ${zh ? "决定性来源与证据强弱" : "Decisive Sources And Evidence Strength"}\n`,
    renderSources(source, zh, 5),
    `\n## ${zh ? "头部公司吸收与响应风险" : "Incumbent Absorption And Response Risk"}\n`,
    renderIncumbentResponseDisclosure(source, zh),
    `\n## ${zh ? "有顺序的验证建议" : "Ordered Validation Recommendations"}\n`,
    renderValidationPlan(source, zh, 5),
    renderDiscoveryReviewReferenceNotice(source, zh),
    `\n## ${zh ? "有效期与局限" : "Freshness And Limitations"}\n`,
    `${prose(freshness.summary, zh)}\n\n`,
    bulletList(
      strings(source.limitations).map((entry) => prose(entry, zh)),
      zh ? "无" : "None",
    ),
  ].join("");
}

export function renderTerminalFullReport(source: Record<string, unknown>): string {
  const zh = isChinese(source.research_language);
  const conclusion = requiredRecord(source.research_conclusion, "research_conclusion");
  const freshness = requiredRecord(source.freshness, "freshness");
  const statisticsSource = terminalStatisticsSource(source);
  return [
    `# ${zh ? "创业机会研究终态报告" : "Startup Opportunity Terminal Research Report"}\n\n`,
    `${zh ? "决策问题" : "Decision question"}: ${prose(source.decision_question, zh)}\n\n`,
    `## ${zh ? "研究结论" : "Research Conclusion"}\n`,
    `${prose(conclusion.current_recommendation, zh)}\n\n${prose(conclusion.meaning, zh)}\n\n`,
    `${zh ? "允许的结论措辞" : "Allowed claim"}: ${prose(conclusion.allowed_claim, zh)}\n\n`,
    `## ${zh ? "研究概览" : "Research At A Glance"}\n`,
    renderStatistics(statisticsSource, zh),
    `## ${zh ? "执行完整度" : "Execution Completeness"}\n`,
    renderExecution(source, zh),
    `\n## ${zh ? "运行健康" : "Runtime Health"}\n`,
    renderRuntimeHealth(source, zh),
    `\n## ${zh ? "方向、成熟度与产品假设" : "Directions, Maturity, And Product Hypotheses"}\n`,
    renderDirections(source, zh, false),
    `\n## ${zh ? "决策级量化摘要" : "Decision-grade Quantitative Summary"}\n`,
    renderDecisionGradeQuantitativeSummary(source, zh),
    `\n## ${zh ? "最终方向竞品与替代摘要" : "Final-direction Competitive And Substitute Summary"}\n`,
    renderCompetitiveSubjectSummary(source, zh),
    `\n## ${zh ? "头部公司吸收与响应风险" : "Incumbent Absorption And Response Risk"}\n`,
    renderIncumbentResponseNarratives(source, zh),
    `\n## ${zh ? "会改变排序或结论的关键缺口" : "Critical Gaps That Could Change Ranking Or Conclusions"}\n`,
    renderCriticalResearchGaps(source, zh),
    `\n## ${zh ? "来源与证据强弱" : "Sources And Evidence Strength"}\n`,
    renderSources(source, zh),
    `\n## ${zh ? "研究来源沿袭" : "Research Provenance"}\n`,
    renderResearchProvenance(source, zh, true),
    `\n## ${zh ? "有顺序的验证建议" : "Ordered Validation Recommendations"}\n`,
    renderValidationPlan(source, zh),
    renderDiscoveryReviewReferenceNotice(source, zh),
    `\n## ${zh ? "证据新鲜度" : "Evidence Freshness"}\n`,
    `${prose(freshness.summary, zh)}\n\n`,
    `## ${zh ? "局限" : "Limitations"}\n`,
    bulletList(
      strings(source.limitations).map((entry) => prose(entry, zh)),
      zh ? "无" : "None",
    ),
  ].join("");
}

export function renderTerminalAuditAppendix(source: Record<string, unknown>): string {
  const zh = isChinese(source.research_language);
  const auditSource = terminalFullCommercialProjectionSource(source);
  return [
    `# ${zh ? "创业机会研究审计附录" : "Startup Opportunity Research Audit Appendix"}\n\n`,
    `> ${zh ? "本附录与决策摘要和核心报告均从同一份最终结构化报告机械派生；完整审计真值保留在结构化报告中。" : "This appendix is mechanically derived by the Harness from the same final report model as the brief and core report; report.json retains the complete structured truth."}\n\n`,
    `## ${zh ? "机械统计" : "Mechanical Statistics"}\n`,
    renderStatistics(auditSource, zh),
    `\n## ${zh ? "全部量化信号（含代理与背景）" : "All Quantitative Signals (Including Proxies And Context)"}\n`,
    renderQuantitativeSignalTable(auditSource, zh),
    `\n## ${zh ? "完整竞品与广义替代矩阵" : "Full Competitive And Substitute Matrix"}\n`,
    renderCompetitiveSubstituteMatrix(auditSource, zh),
    `\n## ${zh ? "头部公司吸收与响应风险" : "Incumbent Absorption And Response Risk"}\n`,
    renderIncumbentResponseRiskTable(auditSource, zh),
    `\n## ${zh ? "完整研究覆盖缺口" : "Full Research Coverage Gaps"}\n`,
    renderResearchCoverageGaps(auditSource, zh),
    `\n## ${zh ? "非阻塞诊断" : "Non-blocking Diagnostics"}\n`,
    renderGateWarnings(source, zh),
    `\n## ${zh ? "研究来源沿袭" : "Research Provenance"}\n`,
    renderResearchProvenance(source, zh, true),
    `\n## ${zh ? "发现对抗性复核（仅供引用）" : "Discovery Adversarial Reviews (Reference Only)"}\n`,
    renderDiscoveryReviewSummaries(source, zh),
    `\n## ${zh ? "材料采用、限制与排除" : "Material Adoption, Limitations, And Exclusions"}\n`,
    renderEvidenceDispositions(source, zh),
  ].join("");
}

function renderReviewRefs(label: string, refs: readonly string[], zh: boolean): string {
  if (refs.length === 0) return "";
  return `  - ${label}: ${zh ? "详见结构化审计" : "see structured audit"}\n`;
}

function reviewRefPlaceholder(zh: boolean): string {
  return zh ? "详见结构化审计" : "see structured audit";
}

function renderDiscoveryReviewFindings(review: Record<string, unknown>, zh: boolean): string {
  const findings = records(review.review_findings);
  if (findings.length === 0)
    return zh ? "- 未记录结构化发现。\n" : "- No structured findings recorded.\n";
  return findings
    .map((finding) => {
      const lines = [
        `- ${zh ? "立场" : "Stance"}=${reviewEnumLabel(finding.stance, zh)}; ${zh ? "材料状态" : "material state"}=${reviewEnumLabel(finding.evidence_state, zh)}; ${zh ? "问题" : "questions"}=${strings(
          finding.reviewed_plan_question_refs,
        )
          .map(() => reviewRefPlaceholder(zh))
          .join(", ")}`,
        `  - ${zh ? "摘要" : "Summary"}: ${reviewLiteralText(finding.summary)}`,
        renderReviewRefs(zh ? "支持材料" : "Supporting refs", strings(finding.supporting_refs), zh),
        renderReviewRefs(zh ? "反对材料" : "Opposing refs", strings(finding.opposing_refs), zh),
        renderReviewRefs(zh ? "背景材料" : "Background refs", strings(finding.background_refs), zh),
        renderReviewRefs(
          zh ? "矛盾材料" : "Contradictory refs",
          strings(finding.contradictory_refs),
          zh,
        ),
        renderReviewRefs(zh ? "未知材料" : "Unknown refs", strings(finding.unknown_refs), zh),
      ];
      return `${lines.join("\n")}\n`;
    })
    .join("");
}

function renderDiscoveryReviewMaterialVisibility(
  review: Record<string, unknown>,
  zh: boolean,
): string {
  const visibility = isRecord(review.material_visibility) ? review.material_visibility : {};
  const labels: Readonly<Record<(typeof DISCOVERY_REVIEW_MATERIAL_REF_FIELDS)[number], string>> = zh
    ? {
        supporting_refs: "支持材料",
        opposing_refs: "反对材料",
        background_refs: "背景材料",
        contradictory_refs: "矛盾材料",
        unknown_refs: "未知材料",
      }
    : {
        supporting_refs: "Supporting refs",
        opposing_refs: "Opposing refs",
        background_refs: "Background refs",
        contradictory_refs: "Contradictory refs",
        unknown_refs: "Unknown refs",
      };
  return DISCOVERY_REVIEW_MATERIAL_REF_FIELDS.map((field) => {
    const refs = strings(visibility[field]).map(() => reviewRefPlaceholder(zh));
    return `- ${labels[field]}: ${refs.length === 0 ? (zh ? "无" : "None recorded") : refs.join(", ")}\n`;
  }).join("");
}

function renderDiscoveryReviewGaps(review: Record<string, unknown>, zh: boolean): string {
  const gaps = records(review.decision_relevant_gaps);
  if (gaps.length === 0)
    return zh ? "- 未记录决策相关缺口。\n" : "- No decision-relevant gaps recorded.\n";
  return gaps
    .map(
      (gap) =>
        `- ${reviewEnumLabel(gap.state, zh)} / ${reviewEnumLabel(gap.recommended_follow_up, zh)}: ${reviewLiteralText(gap.summary)}\n${renderReviewRefs(
          zh ? "依据材料" : "Basis refs",
          strings(gap.basis_refs),
          zh,
        )}`,
    )
    .join("");
}

function renderDiscoveryReviewSearchClosure(review: Record<string, unknown>, zh: boolean): string {
  const closure = isRecord(review.search_closure) ? review.search_closure : {};
  return [
    `- ${zh ? "终态" : "Status"}: ${reviewEnumLabel(closure.status, zh)}\n`,
    `- ${zh ? "路线" : "Routes"}: ${strings(closure.acquisition_routes_attempted)
      .map((route) => reviewLiteralText(route))
      .join(", ")}\n`,
    renderReviewRefs(
      zh ? "采用来源" : "Adopted source refs",
      strings(closure.adopted_source_refs),
      zh,
    ),
    `- ${zh ? "未解决缺口" : "Unresolved gaps"}: ${
      strings(closure.unresolved_gaps).length === 0
        ? zh
          ? "无"
          : "None"
        : strings(closure.unresolved_gaps)
            .map((gap) => reviewLiteralText(gap))
            .join("; ")
    }\n`,
    `- ${zh ? "停止原因" : "Stop reason"}: ${reviewLiteralText(closure.stop_reason)}\n`,
  ].join("");
}

function renderDiscoveryReviewSummaries(source: Record<string, unknown>, zh: boolean): string {
  const summaries = records(source.discovery_review_summaries);
  if (summaries.length === 0) {
    return zh
      ? "- 未发布发现阶段对抗性复核结果。\n"
      : "- No Discovery adversarial review result was published.\n";
  }
  return summaries
    .map((review) =>
      [
        `### ${reviewLiteralText(review.review_result_id)}\n\n`,
        `- ${zh ? "复核引用" : "Review ref"}: ${reviewRefPlaceholder(zh)}\n`,
        `- ${zh ? "负责人角色" : "Owner role"}: ${reviewEnumLabel(review.owner_role, zh)}\n`,
        `- ${zh ? "结果状态" : "Result status"}: ${reviewEnumLabel(review.status, zh)}\n`,
        `- ${zh ? "任务引用" : "Task ref"}: ${reviewRefPlaceholder(zh)}\n`,
        `- ${zh ? "执行引用" : "Execution ref"}: ${reviewRefPlaceholder(zh)}\n`,
        `- ${zh ? "分派引用" : "Dispatch ref"}: ${reviewRefPlaceholder(zh)}\n`,
        `- ${zh ? "问题引用" : "Question refs"}: ${strings(review.reviewed_plan_question_refs)
          .map(() => reviewRefPlaceholder(zh))
          .join(", ")}\n`,
        `- ${zh ? "要求立场" : "Required stances"}: ${reviewEnumList(strings(review.required_stances), zh)}\n`,
        `- ${zh ? "边界" : "Boundary"}: ${
          zh
            ? "仅引用；不作为 Gate、排序、淘汰或信心上限依据。"
            : "reference-only; not a Gate, ranking, elimination, or confidence-ceiling authority."
        }\n`,
        `\n${zh ? "发现" : "Findings"}:\n`,
        renderDiscoveryReviewFindings(review, zh),
        `\n${zh ? "可见材料" : "Visible material"}:\n`,
        renderDiscoveryReviewMaterialVisibility(review, zh),
        `\n${zh ? "决策相关缺口" : "Decision-relevant gaps"}:\n`,
        renderDiscoveryReviewGaps(review, zh),
        `\n${zh ? "搜索闭合" : "Search Closure"}:\n`,
        renderDiscoveryReviewSearchClosure(review, zh),
      ].join(""),
    )
    .join("\n");
}

function terminalCommercialConsistencyIssues(
  source: Record<string, unknown>,
  reportRef: string,
): readonly Record<string, unknown>[] {
  const fullProjection = terminalFullCommercialProjectionSource(source);
  const expectedStatistics = deriveReportStatistics(source);
  const actualStatistics = isRecord(source.report_statistics) ? source.report_statistics : null;
  const fullStatus = isRecord(fullProjection.commercial_research_status)
    ? fullProjection.commercial_research_status
    : {};
  const fullState = String(fullStatus.state ?? "not_planned");
  const plannedTaskRefs = strings(fullStatus.planned_task_refs);
  const missingTaskRefs = strings(fullStatus.missing_task_refs);
  const submittedAuditRefs = strings(fullStatus.submitted_audit_refs);
  const warningCodes = new Set(
    records(source.gate_warnings).map((warning) => String(warning.code)),
  );
  const execution = isRecord(source.execution) ? source.execution : {};
  const fullGapRows = records(fullProjection.research_coverage_gaps);
  const executionGapTaskRefs = new Set(
    fullGapRows.flatMap((row) =>
      row.coverage_kind === "execution"
        ? [...(typeof row.task_ref === "string" ? [row.task_ref] : []), ...strings(row.task_refs)]
        : [],
    ),
  );
  const issues: Record<string, unknown>[] = [];
  const add = (code: string, field: string, revisionRequest: string): void => {
    issues.push({
      code,
      field,
      artifact_ref: reportRef,
      revision_request: revisionRequest,
    });
  };
  if (
    actualStatistics !== null &&
    canonicalJson(actualStatistics) !== canonicalJson(expectedStatistics)
  ) {
    add(
      "commercial_report_statistics_mismatch",
      "report_statistics",
      "Derive report statistics mechanically from the same full commercial projection used by terminal report surfaces.",
    );
  }
  if (
    fullState === "not_planned" &&
    (plannedTaskRefs.length > 0 ||
      missingTaskRefs.length > 0 ||
      submittedAuditRefs.length > 0 ||
      warningCodes.has("commercial_research.report_audit_closure_incomplete"))
  ) {
    add(
      "commercial_not_planned_status_has_planned_refs",
      "full_commercial_projection.commercial_research_status",
      "Make not_planned exclusive with planned tasks, submitted Audits, missing tasks, and planned-Audit warnings.",
    );
  }
  if (missingTaskRefs.length > 0) {
    if (execution.completeness === "complete") {
      add(
        "commercial_missing_task_claimed_complete_execution",
        "execution.completeness",
        "Keep execution completeness partial or not_started while planned commercial tasks are missing.",
      );
    }
    const missingRows = missingTaskRefs.filter((taskRef) => !executionGapTaskRefs.has(taskRef));
    if (missingRows.length > 0) {
      add(
        "commercial_missing_task_gap_absent",
        "full_commercial_projection.research_coverage_gaps",
        "Project every missing planned commercial task as an execution/research gap with decision impact.",
      );
    }
    if (!warningCodes.has("commercial_research.report_audit_closure_incomplete")) {
      add(
        "commercial_missing_task_warning_absent",
        "gate_warnings",
        "Disclose missing planned commercial Audits as a non-blocking commercial Gate warning.",
      );
    }
  }
  if (
    fullState === "planned_but_missing" &&
    (plannedTaskRefs.length === 0 || missingTaskRefs.length === 0 || submittedAuditRefs.length > 0)
  ) {
    add(
      "commercial_planned_but_missing_status_incoherent",
      "full_commercial_projection.commercial_research_status",
      "Use planned_but_missing only when planned tasks exist, missing tasks exist, and no current Audit closed the planned work.",
    );
  }
  if (
    fullState === "complete" &&
    (missingTaskRefs.length > 0 ||
      fullGapRows.some((row) => row.coverage_kind === "execution") ||
      warningCodes.has("commercial_research.report_audit_closure_incomplete"))
  ) {
    add(
      "commercial_complete_status_has_missing_work",
      "full_commercial_projection.commercial_research_status",
      "Render complete only when planned commercial execution has no missing task or unresolved execution gap.",
    );
  }
  return issues.sort((left, right) =>
    `${String(left.code)}:${String(left.field)}`.localeCompare(
      `${String(right.code)}:${String(right.field)}`,
    ),
  );
}

export interface DerivedTerminalReportDocument {
  readonly artifactPath: string;
  readonly artifactType: string;
  readonly document: Record<string, unknown>;
}

export function deriveTerminalReportDocuments(
  reportEnvelope: FormalArtifactEnvelope,
): readonly DerivedTerminalReportDocument[] {
  const source = reportEnvelope.document;
  const revision = revisionOf(reportEnvelope.artifact_path);
  const reportHash = canonicalContentHash(source);
  const briefPath = `artifacts/reporting/decision-brief.${revision}.json`;
  const viewPath = `artifacts/reporting/report-markdown.${revision}.json`;
  const consistencyPath = `artifacts/reporting/consistency-evaluation.${revision}.json`;
  const briefMarkdown = renderTerminalDecisionBrief(source);
  const viewMarkdown = renderTerminalFullReport(source);
  const auditAppendixMarkdown = renderTerminalAuditAppendix(source);
  const briefDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.decision_brief.terminal.current",
    brief_id: `decision_brief_${revision.slice(1)}`,
    run_id: reportEnvelope.run_id,
    mode: source.mode,
    research_language: source.research_language,
    producer_role: "harness",
    owned_output_path: briefPath,
    materialized_path: "decision-brief.md",
    report_ref: reportEnvelope.artifact_path,
    report_content_hash: reportHash,
    terminal_outcome: source.terminal_outcome,
    decision_question: source.decision_question,
    execution: userExecutionProjection(source),
    research_conclusion: source.research_conclusion,
    runtime_health: userRuntimeHealthProjection(source),
    directions: source.directions,
    sources: source.sources,
    research_provenance: source.research_provenance,
    ordered_validation_plan: source.ordered_validation_plan,
    freshness: source.freshness,
    limitations: source.limitations,
    external_action_boundary: source.external_action_boundary,
    audit_appendix_refs: source.audit_refs,
    markdown: briefMarkdown,
    markdown_content_hash: sha256Bytes(briefMarkdown),
  };
  const viewDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.terminal_report_view.v1",
    view_id: `terminal_report_view_${revision.slice(1)}`,
    run_id: reportEnvelope.run_id,
    mode: source.mode,
    research_language: source.research_language,
    producer_role: "harness",
    owned_output_path: viewPath,
    materialized_path: "report.md",
    audit_appendix_path: "audit-appendix.md",
    report_ref: reportEnvelope.artifact_path,
    report_content_hash: reportHash,
    terminal_outcome: source.terminal_outcome,
    research_provenance: source.research_provenance,
    section_ids: TERMINAL_REPORT_SECTION_IDS,
    limitations: source.limitations,
    audit_appendix_refs: source.audit_refs,
    markdown: viewMarkdown,
    markdown_content_hash: sha256Bytes(viewMarkdown),
    audit_appendix_markdown: auditAppendixMarkdown,
    audit_appendix_content_hash: sha256Bytes(auditAppendixMarkdown),
  };
  const matches = scanDiscoveryReportSurfaces({
    structuredReport: source,
    decisionBrief: briefMarkdown,
    reportView: `${viewMarkdown}\n${auditAppendixMarkdown}`,
  });
  const semanticIssues = terminalCommercialConsistencyIssues(source, reportEnvelope.artifact_path);
  const evaluationIssues = [
    ...matches.map((match) => ({
      code: "forbidden_expression",
      field: match,
      artifact_ref: reportEnvelope.artifact_path,
      revision_request: "Remove the forbidden claim and publish a new immutable report revision.",
    })),
    ...semanticIssues,
  ];
  const consistencyDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.report_consistency_evaluation.terminal.current",
    evaluation_id: `terminal_report_consistency_${revision.slice(1)}`,
    run_id: reportEnvelope.run_id,
    producer_role: "harness",
    owned_output_path: consistencyPath,
    report_ref: reportEnvelope.artifact_path,
    decision_brief_ref: briefPath,
    report_view_ref: viewPath,
    checked_dimensions: TERMINAL_CONSISTENCY_DIMENSIONS,
    scan_contract_version: REPORT_SCAN_CONTRACT_VERSION,
    scanned_surfaces: REPORT_SCAN_SURFACES,
    forbidden_expression_matches: matches,
    evaluator_result: evaluationIssues.length === 0 ? "passed" : "failed",
    evaluation_issues: evaluationIssues,
    input_artifact_hashes: [
      { ref: reportEnvelope.artifact_path, content_hash: reportHash },
      { ref: briefPath, content_hash: canonicalContentHash(briefDocument) },
      { ref: viewPath, content_hash: canonicalContentHash(viewDocument) },
    ],
    limitations: source.limitations,
  };
  return [
    {
      artifactPath: briefPath,
      artifactType: "startup_opportunity.decision_brief.terminal.current",
      document: briefDocument,
    },
    {
      artifactPath: viewPath,
      artifactType: "startup_opportunity.terminal_report_view.v1",
      document: viewDocument,
    },
    {
      artifactPath: consistencyPath,
      artifactType: "startup_opportunity.report_consistency_evaluation.terminal.current",
      document: consistencyDocument,
    },
  ];
}

export function terminalReportDocumentsEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

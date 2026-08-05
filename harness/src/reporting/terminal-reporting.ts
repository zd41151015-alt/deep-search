import type { FormalArtifactEnvelope } from "../artifact-store/artifact-store.js";
import { canonicalContentHash, canonicalJson, sha256Bytes } from "../artifact-store/canonical.js";
import {
  REPORT_SCAN_CONTRACT_VERSION,
  REPORT_SCAN_SURFACES,
  scanDiscoveryReportSurfaces,
} from "./report-consistency.js";

const TERMINAL_REPORT_SECTION_IDS = [
  "execution",
  "research_conclusion",
  "runtime_health",
  "directions",
  "decisive_evidence",
  "ordered_validation_plan",
  "freshness",
  "limitations",
] as const;

const TERMINAL_CONSISTENCY_DIMENSIONS = [
  "execution_conclusion_runtime_separation",
  "terminal_completeness",
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

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`terminal report field ${field} must be an object`);
  }
  return value;
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
};

function enumLabel(value: unknown, zh: boolean): string {
  const text = String(value);
  if (zh) {
    return ZH_ENUMS[text] ?? text;
  }
  return text.replaceAll("_", " ");
}

function bulletList(values: readonly string[], emptyText: string): string {
  return values.length === 0
    ? `- ${emptyText}\n`
    : `${values.map((value) => `- ${value}`).join("\n")}\n`;
}

function renderExecution(source: Record<string, unknown>, zh: boolean): string {
  const execution = requiredRecord(source.execution, "execution");
  const completedStages = zh
    ? strings(execution.completed_stages).map((_, index) => `已完成环节 ${index + 1}`)
    : strings(execution.completed_stages);
  const incomplete = records(execution.incomplete_stages).map((stage) => {
    const refs = strings(stage.related_refs);
    const audit = refs.length === 0 ? "" : zh ? "（详见审计附录）" : " (see audit appendix)";
    return `${zh ? "对结论的影响" : "Conclusion impact"}: ${String(stage.conclusion_impact)}${audit}`;
  });
  const followups = records(execution.required_followups).map(
    (followup) => `${enumLabel(followup.status, zh)} - ${String(followup.detail)}`,
  );
  return [
    `${zh ? "执行完整度" : "Completeness"}: ${enumLabel(execution.completeness, zh)}\n\n`,
    `${zh ? "已完成阶段" : "Completed stages"}:\n`,
    bulletList(completedStages, zh ? "无" : "None"),
    `\n${zh ? "未完成阶段" : "Incomplete stages"}:\n`,
    bulletList(incomplete, zh ? "无" : "None"),
    `\n${zh ? "必需追加调研" : "Required follow-ups"}:\n`,
    bulletList(followups, zh ? "无" : "None"),
  ].join("");
}

function renderRuntimeHealth(source: Record<string, unknown>, zh: boolean): string {
  const runtime = requiredRecord(source.runtime_health, "runtime_health");
  const issues = records(runtime.issues).map(
    (issue) => `${zh ? "对结论的影响" : "Conclusion impact"}: ${String(issue.conclusion_impact)}`,
  );
  return [
    `${zh ? "状态" : "Status"}: ${enumLabel(runtime.status, zh)}\n\n`,
    bulletList(issues, zh ? "没有记录运行问题" : "No runtime issues recorded"),
  ].join("");
}

function renderDirections(source: Record<string, unknown>, zh: boolean, compact: boolean): string {
  const directions = [...records(source.directions)].sort((left, right) => {
    if (left.priority === null && right.priority === null)
      return String(left.direction_id).localeCompare(String(right.direction_id));
    if (left.priority === null) return 1;
    if (right.priority === null) return -1;
    return Number(left.priority) - Number(right.priority);
  });
  const uncertainties = records(source.commercial_uncertainties);
  if (directions.length === 0) {
    return zh ? "- 当前没有可交付的方向。\n" : "- No direction is currently deliverable.\n";
  }
  return directions
    .map((direction) => {
      const lines = [
        `### ${direction.priority === null ? (zh ? "待验证" : "Unranked") : String(direction.priority)}. ${String(direction.label)}\n`,
        `${zh ? "排序状态" : "Ranking status"}: ${enumLabel(direction.ranking_status, zh)}\n\n`,
        `${zh ? "成熟度" : "Maturity"}: ${enumLabel(direction.maturity, zh)}\n\n`,
        `${zh ? "当前动作" : "Current action"}: ${enumLabel(direction.action, zh)}\n\n`,
        `${zh ? "目标用户" : "Target user"}: ${String(direction.target_user)}\n\n`,
        `${zh ? "窄场景" : "Narrow scenario"}: ${String(direction.narrow_scenario)}\n\n`,
        `${zh ? "当前替代" : "Current alternative"}: ${String(direction.current_alternative)}\n\n`,
        `${zh ? "付款方" : "Payer"}: ${String(direction.payer)}\n\n`,
        `${zh ? "产品/服务形态" : "Product or service form"}: ${String(direction.product_form)}\n\n`,
        `${zh ? "核心价值" : "Core value"}: ${String(direction.core_value)}\n\n`,
        `${zh ? "为什么现在值得关注" : "Why now"}: ${String(direction.why_now)}\n\n`,
        `${zh ? "最先验证的假设" : "First testable assumption"}: ${String(direction.first_testable_assumption)}\n\n`,
        `${zh ? "排序理由" : "Comparison reason"}: ${String(direction.comparison_reason)}\n`,
      ];
      if (!compact) {
        lines.push(`\n${zh ? "问题" : "Problem"}: ${String(direction.problem)}\n`);
        lines.push(`\n${zh ? "关键风险" : "Key risks"}:\n`);
        lines.push(bulletList(strings(direction.key_risks), zh ? "无" : "None"));
        lines.push(`\n${zh ? "仍未回答" : "Open questions"}:\n`);
        lines.push(bulletList(strings(direction.open_questions), zh ? "无" : "None"));
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
                  ? `推测：${String(entry.statement)}；推理起点：${String(entry.starting_point)}；推理过程：${String(entry.reasoning)}；不确定性：${String(entry.uncertainty)}；待验证：${String(entry.validation_needed)}`
                  : `Inference: ${String(entry.statement)}; starting point: ${String(entry.starting_point)}; reasoning: ${String(entry.reasoning)}; uncertainty: ${String(entry.uncertainty)}; validation needed: ${String(entry.validation_needed)}`
                : zh
                  ? `未知：${String(entry.statement)}；不确定性：${String(entry.uncertainty)}；待验证：${String(entry.validation_needed)}`
                  : `Unknown: ${String(entry.statement)}; uncertainty: ${String(entry.uncertainty)}; validation needed: ${String(entry.validation_needed)}`,
            ),
            zh ? "无" : "None",
          ),
        );
      }
      return lines.join("");
    })
    .join("\n");
}

function renderSources(source: Record<string, unknown>, zh: boolean): string {
  const items = records(source.sources).map((entry) => {
    const validity =
      entry.valid_as_of === null ? (zh ? "日期未知" : "date unknown") : String(entry.valid_as_of);
    const base = `[${String(entry.title)}](${String(entry.url)}) (${validity}; ${enumLabel(entry.stance, zh)}; ${enumLabel(entry.strength, zh)}; ${enumLabel(entry.evidence_character, zh)})`;
    if (entry.claim_state !== "inferred" || !isRecord(entry.inference)) {
      return `${base}: ${String(entry.claim)}`;
    }
    const inference = entry.inference;
    return zh
      ? `${base}: 推测：${String(entry.claim)}；推理起点：${String(inference.starting_point)}；推理过程：${String(inference.reasoning)}；不确定性：${String(inference.uncertainty)}；待验证：${String(inference.validation_needed)}`
      : `${base}: Inference: ${String(entry.claim)}; starting point: ${String(inference.starting_point)}; reasoning: ${String(inference.reasoning)}; uncertainty: ${String(inference.uncertainty)}; validation needed: ${String(inference.validation_needed)}`;
  });
  return bulletList(items, zh ? "没有可引用来源" : "No readable source recorded");
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

function renderValidationPlan(source: Record<string, unknown>, zh: boolean): string {
  const steps = [...records(source.ordered_validation_plan)].sort(
    (left, right) => Number(left.order) - Number(right.order),
  );
  if (steps.length === 0) {
    return zh
      ? "- 当前没有建议的验证动作。\n"
      : "- No validation action is currently recommended.\n";
  }
  return steps
    .map((step) =>
      [
        `### ${String(step.order)}. ${String(step.hypothesis)}\n`,
        `${zh ? "为何先做" : "Why now"}: ${String(step.why_now)}\n\n`,
        `${zh ? "通过信号" : "Pass signal"}: ${String(step.pass_signal)}\n\n`,
        `${zh ? "失败信号" : "Fail signal"}: ${String(step.fail_signal)}\n\n`,
        `${zh ? "如何改变决定" : "Decision effect"}: ${String(step.decision_effect)}\n\n`,
        zh
          ? "执行边界：涉及外部行动时由用户自行决定和执行，本研究工具不执行或跟踪结果。\n"
          : "Execution boundary: external action remains user-owned; the Harness does not execute or track it.\n",
      ].join(""),
    )
    .join("\n");
}

export function renderTerminalDecisionBrief(source: Record<string, unknown>): string {
  const zh = isChinese(source.research_language);
  const conclusion = requiredRecord(source.research_conclusion, "research_conclusion");
  const freshness = requiredRecord(source.freshness, "freshness");
  return [
    `# ${zh ? "决策简报" : "Decision Brief"}\n\n`,
    `## ${zh ? "现在应该做什么" : "What To Do Now"}\n`,
    `${String(conclusion.current_recommendation)}\n\n`,
    `${zh ? "研究结论" : "Research conclusion"}: ${enumLabel(conclusion.outcome, zh)}\n\n`,
    `${zh ? "证据强度" : "Evidence strength"}: ${enumLabel(conclusion.evidence_strength, zh)}\n\n`,
    `${zh ? "这意味着" : "Meaning"}: ${String(conclusion.meaning)}\n\n`,
    `## ${zh ? "执行完整度" : "Execution Completeness"}\n`,
    renderExecution(source, zh),
    `\n## ${zh ? "运行健康" : "Runtime Health"}\n`,
    renderRuntimeHealth(source, zh),
    `\n## ${zh ? "优先方向与可测试产品假设" : "Priority Directions And Testable Product Hypotheses"}\n`,
    renderDirections(source, zh, true),
    `\n## ${zh ? "决定性来源与证据强弱" : "Decisive Sources And Evidence Strength"}\n`,
    renderSources(source, zh),
    `\n## ${zh ? "有顺序的验证建议" : "Ordered Validation Recommendations"}\n`,
    renderValidationPlan(source, zh),
    `\n## ${zh ? "有效期与局限" : "Freshness And Limitations"}\n`,
    `${String(freshness.summary)}\n\n`,
    bulletList(strings(source.limitations), zh ? "无" : "None"),
  ].join("");
}

export function renderTerminalFullReport(source: Record<string, unknown>): string {
  const zh = isChinese(source.research_language);
  const conclusion = requiredRecord(source.research_conclusion, "research_conclusion");
  const freshness = requiredRecord(source.freshness, "freshness");
  return [
    `# ${zh ? "创业机会研究终态报告" : "Startup Opportunity Terminal Research Report"}\n\n`,
    `${zh ? "决策问题" : "Decision question"}: ${String(source.decision_question)}\n\n`,
    `## ${zh ? "研究结论" : "Research Conclusion"}\n`,
    `${String(conclusion.current_recommendation)}\n\n${String(conclusion.meaning)}\n\n`,
    `${zh ? "允许的结论措辞" : "Allowed claim"}: ${String(conclusion.allowed_claim)}\n\n`,
    `## ${zh ? "执行完整度" : "Execution Completeness"}\n`,
    renderExecution(source, zh),
    `\n## ${zh ? "运行健康" : "Runtime Health"}\n`,
    renderRuntimeHealth(source, zh),
    `\n## ${zh ? "方向、成熟度与产品假设" : "Directions, Maturity, And Product Hypotheses"}\n`,
    renderDirections(source, zh, false),
    `\n## ${zh ? "来源与证据强弱" : "Sources And Evidence Strength"}\n`,
    renderSources(source, zh),
    `\n## ${zh ? "有顺序的验证建议" : "Ordered Validation Recommendations"}\n`,
    renderValidationPlan(source, zh),
    `\n## ${zh ? "证据新鲜度" : "Evidence Freshness"}\n`,
    `${String(freshness.summary)}\n\n`,
    `## ${zh ? "局限" : "Limitations"}\n`,
    bulletList(strings(source.limitations), zh ? "无" : "None"),
  ].join("");
}

const ZH_INTERNAL_TERM_RULES = [
  /\bsame[- ]run\b/iu,
  /\bpre[- ]thesis\b/iu,
  /\bbaseline\b/iu,
  /\bcounterfactual\b/iu,
  /\bevidence\b/iu,
  /\bharness\b/iu,
  /\bartifact\b/iu,
  /\b(?:opportunity_discovery|concept_evidence_assessment|assessment_early_kill|assessment_commercial|assessment_delivery|discovery_generation|candidate_evaluation|runtime_blocked|not_executed|unranked_hypothesis)\b/iu,
] as const;

export function localizedTerminalUserViewIssues(
  source: Record<string, unknown>,
  markdown: string,
): readonly string[] {
  if (!isChinese(source.research_language)) return [];
  let visible = markdown;
  for (const item of records(source.sources)) {
    for (const allowed of [item.title, item.url]) {
      if (typeof allowed === "string") visible = visible.replaceAll(allowed, "");
    }
  }
  return ZH_INTERNAL_TERM_RULES.flatMap((rule, index) =>
    rule.test(visible) ? [`localized_internal_term_${index + 1}`] : [],
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
    report_ref: reportEnvelope.artifact_path,
    report_content_hash: reportHash,
    terminal_outcome: source.terminal_outcome,
    section_ids: TERMINAL_REPORT_SECTION_IDS,
    limitations: source.limitations,
    audit_appendix_refs: source.audit_refs,
    markdown: viewMarkdown,
    markdown_content_hash: sha256Bytes(viewMarkdown),
  };
  const matches = scanDiscoveryReportSurfaces({
    structuredReport: source,
    decisionBrief: briefMarkdown,
    reportView: viewMarkdown,
  });
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
    evaluator_result: matches.length === 0 ? "passed" : "failed",
    evaluation_issues: matches.map((match) => ({
      code: "forbidden_expression",
      field: match,
      artifact_ref: reportEnvelope.artifact_path,
      revision_request: "Remove the forbidden claim and publish a new immutable report revision.",
    })),
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

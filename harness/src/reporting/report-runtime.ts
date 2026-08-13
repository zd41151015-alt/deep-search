import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ArtifactStore,
  type FormalArtifactEnvelope,
  type PublishArtifactResult,
} from "../artifact-store/artifact-store.js";
import { publishTemp, removeTemp, writeSyncedTemp } from "../artifact-store/atomic-file.js";
import {
  canonicalContentHash,
  canonicalJson,
  isSha256,
  operationKey,
  sha256Bytes,
  sha256Hex,
} from "../artifact-store/canonical.js";
import {
  isNodeError,
  openRunDirectory,
  resolveRunPath,
  validateRunId,
} from "../artifact-store/path-policy.js";
import { withReportLock, withRunLock } from "../artifact-store/run-lock.js";
import { StoreError } from "../artifact-store/store-error.js";
import { EvidenceStore } from "../evidence-store/evidence-store.js";
import { type RunManifest, RunStore } from "../run-store/run-store.js";
import type { ArtifactValidator } from "../validators/artifact-validator.js";
import { REQUIRED_REPORT_CONSISTENCY_DIMENSIONS } from "../validators/discovery-evaluation-policy.js";
import { projectGateWarnings } from "../validators/gate-diagnostics.js";
import { deriveResearchProvenance } from "../validators/research-handoff-validator.js";
import {
  commercialProjectionRefs,
  deriveReportStatistics,
  projectCommercialAuditTables,
  renderCompetitiveSubjectSummary,
  renderCompetitiveSubstituteMatrix,
  renderCriticalResearchGaps,
  renderDecisionGradeQuantitativeSummary,
  renderGateWarnings,
  renderIncumbentResponseDisclosure,
  renderIncumbentResponseRiskTable,
  renderMarketPriorityAndCommercialReadiness,
  renderQuantitativeSignalTable,
  renderResearchCoverageGaps,
} from "./commercial-report-tables.js";
import { canonicalizeReadableSources, deriveReportCitations } from "./report-citation-authority.js";
import {
  REPORT_SCAN_CONTRACT_VERSION,
  REPORT_SCAN_SURFACES,
  scanDiscoveryReportSurfaces,
} from "./report-consistency.js";
import { renderEvidenceDispositions } from "./report-evidence-dispositions.js";
import {
  boundedValues,
  isChineseResearchLanguage,
  localizedEnum,
  localizedInternalLeakageIssues,
  userVisibleText,
} from "./report-localization.js";
import {
  deriveConfirmedResearchLanguage,
  deriveNonTerminalReportSubjectIds,
  deriveReportDispositions,
  deriveReportSubjectLabels,
} from "./report-projection-authority.js";
import { deriveTerminalReportDocuments } from "./terminal-reporting.js";

const REPORT_SECTION_ORDER = [
  "assessment_result_and_evidence_strength",
  "concept_hypothesis",
  "decisive_support_and_opposition",
  "demand_alternatives_solution_failure",
  "competition_and_differentiation",
  "buyer_acquisition_business_engine",
  "feasibility_compliance_ai_bundle",
  "critical_unknowns_and_kill_criteria",
  "decision_recommendation",
  "optional_validation_suggestions",
  "limitations_and_sources",
] as const;

const ASSESSMENT_REPORT_SECTION_IDS = [
  "assessment_result_and_evidence_strength",
  "concept_hypothesis",
  "decisive_support_and_opposition",
  "demand_alternatives_solution_failure",
  "quantitative_signals",
  "competitive_substitute_matrix",
  "incumbent_absorption_and_response_risk",
  "competition_and_differentiation",
  "buyer_acquisition_business_engine",
  "feasibility_compliance_ai_bundle",
  "critical_unknowns_and_kill_criteria",
  "decision_recommendation",
  "optional_validation_suggestions",
  "research_coverage_gaps",
  "limitations_and_sources",
] as const;

const REPORT_SECTION_TITLES: Readonly<Record<(typeof REPORT_SECTION_ORDER)[number], string>> = {
  assessment_result_and_evidence_strength: "Assessment Result and Evidence Strength",
  concept_hypothesis: "Concept Hypothesis",
  decisive_support_and_opposition: "Decisive Support and Opposition",
  demand_alternatives_solution_failure: "Demand, Alternatives, and Solution Failure",
  competition_and_differentiation: "Competition and Differentiation",
  buyer_acquisition_business_engine: "Buyer, Acquisition, and Business Engine",
  feasibility_compliance_ai_bundle: "Feasibility, Compliance, and AI Bundle",
  critical_unknowns_and_kill_criteria: "Critical Unknowns and Kill Criteria",
  decision_recommendation: "Decision Recommendation",
  optional_validation_suggestions: "Optional Validation Suggestions",
  limitations_and_sources: "Limitations and Sources",
};

const REPORT_SECTION_TITLES_ZH: Readonly<Record<(typeof REPORT_SECTION_ORDER)[number], string>> = {
  assessment_result_and_evidence_strength: "评估结果与材料强度",
  concept_hypothesis: "产品假设",
  decisive_support_and_opposition: "关键支持与反对材料",
  demand_alternatives_solution_failure: "需求、替代方案与现有方案失效",
  competition_and_differentiation: "竞争与差异化",
  buyer_acquisition_business_engine: "买方、获客与商业模式",
  feasibility_compliance_ai_bundle: "可行性、合规与 AI 边界",
  critical_unknowns_and_kill_criteria: "关键未知与停止条件",
  decision_recommendation: "决策建议",
  optional_validation_suggestions: "可选验证建议",
  limitations_and_sources: "限制与来源",
};

const REPORT_CHECKS = [
  "result",
  "refs",
  "hashes",
  "freshness",
  "limitations",
  "counter_evidence",
  "decision_meaning",
  "external_action_boundary",
  "new_conclusions",
  "market_validation_language",
  "probability_language",
] as const;

const DISCOVERY_REPORT_SECTION_ORDER = [
  "conclusion_summary",
  "scope_and_profile",
  "decision_recommendation",
  "portfolio",
  "comparison_and_partial_order",
  "method_and_limitations",
  "top_opportunities",
  "watchlist_and_reject",
  "sensitivity",
  "traceability_and_sources",
] as const;

const DISCOVERY_REPORT_SECTION_IDS = [
  "conclusion_summary",
  "scope_and_profile",
  "decision_recommendation",
  "portfolio",
  "comparison_and_partial_order",
  "method_and_limitations",
  "quantitative_signals",
  "competitive_substitute_matrix",
  "incumbent_absorption_and_response_risk",
  "top_opportunities",
  "watchlist_and_reject",
  "sensitivity",
  "research_coverage_gaps",
  "traceability_and_sources",
] as const;

const DISCOVERY_SECTION_TITLES_ZH: Readonly<
  Record<(typeof DISCOVERY_REPORT_SECTION_ORDER)[number], string>
> = {
  conclusion_summary: "结论摘要",
  scope_and_profile: "范围与研究画像",
  decision_recommendation: "决策建议",
  portfolio: "方向组合",
  comparison_and_partial_order: "比较与局部排序",
  method_and_limitations: "方法与限制",
  top_opportunities: "优先机会",
  watchlist_and_reject: "观察与淘汰方向",
  sensitivity: "敏感性",
  traceability_and_sources: "可追溯性与来源",
};

export type ReportFaultBoundary =
  | "after_report_sidecar"
  | "after_report_materialization"
  | "after_brief_sidecar"
  | "after_brief_materialization"
  | "after_view_sidecar"
  | "after_view_materialization"
  | "after_appendix_materialization"
  | "after_consistency_sidecar";

type MaterializationFaultBoundary = "after_intent" | "after_temp_write" | "after_publish";

interface ReportMaterializationReceipt {
  readonly schema_version: "startup_opportunity.report_materialization_operation.v1";
  readonly operation_key: string;
  readonly run_id: string;
  readonly source_artifact_path: string;
  readonly source_content_hash: string;
  readonly target_path: "report.json" | "decision-brief.md" | "report.md" | "audit-appendix.md";
  readonly materialized_content_hash: string;
}

export interface ReportMaterializationResult {
  readonly targetPath: "report.json" | "decision-brief.md" | "report.md" | "audit-appendix.md";
  readonly status: "materialized" | "idempotent_replay";
  readonly contentHash: string;
}

export interface ReportRecoveryResult {
  readonly recoveredFormalArtifactPaths: readonly string[];
  readonly recoveredMaterializedPaths: readonly string[];
  readonly removedTemporaryPaths: readonly string[];
}

export interface BuildReportInput {
  readonly reportEnvelope: FormalArtifactEnvelope;
  readonly faultAt?: ReportFaultBoundary;
}

export interface BuildReportResult {
  readonly schemaVersion: "startup_opportunity.build_report_result.v1";
  readonly runId: string;
  readonly status: "published" | "idempotent_replay";
  readonly formalArtifactPaths: readonly string[];
  readonly materializedPaths: readonly string[];
  readonly consistencyEvaluationRef: string;
}

export interface PreparedTerminalReportOperation {
  readonly schema_version: "startup_opportunity.terminal_report_operation.current";
  readonly operation_key: string;
  readonly run_id: string;
  readonly request_envelope: FormalArtifactEnvelope;
  readonly source_envelope: FormalArtifactEnvelope;
  readonly derived_envelopes: readonly FormalArtifactEnvelope[];
  readonly materialized_outputs: readonly {
    readonly source_artifact_path: string;
    readonly target_path: "report.json" | "decision-brief.md" | "report.md" | "audit-appendix.md";
    readonly content_hash: string;
    readonly bytes: string;
  }[];
}

export function terminalReportArtifactPaths(sourcePath: string): readonly string[] {
  const revision = sourcePath.match(
    /^artifacts\/reporting\/terminal-report-source\.(r[1-9][0-9]*)\.json$/,
  )?.[1];
  if (revision === undefined) {
    throw new StoreError(
      "report.path_invalid",
      "terminal report source path has no immutable revision",
      { sourcePath },
    );
  }
  return [
    sourcePath,
    `artifacts/reporting/decision-brief.${revision}.json`,
    `artifacts/reporting/report-markdown.${revision}.json`,
    `artifacts/reporting/consistency-evaluation.${revision}.json`,
  ];
}

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
    throw new StoreError("report.source_invalid", `report field ${field} must be an object`, {
      field,
    });
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StoreError("report.source_invalid", `report field ${field} must be a string`, {
      field,
    });
  }
  return value;
}

function revisionOf(reportPath: string): string {
  const revision = reportPath.match(
    /^artifacts\/reporting\/report-json\.(r[1-9][0-9]*)\.json$/,
  )?.[1];
  if (revision === undefined) {
    throw new StoreError("report.path_invalid", "report sidecar path has no immutable revision", {
      reportPath,
    });
  }
  return revision;
}

function flattenSummaryRefs(value: unknown): readonly string[] {
  return records(value).flatMap((entry) => strings(entry.refs));
}

function markdownList(values: readonly string[], emptyText = "None recorded."): string {
  return values.length === 0
    ? `- ${emptyText}\n`
    : `${values.map((value) => `- ${value}`).join("\n")}\n`;
}

function localizedMarkdownList(value: unknown, zh: boolean): string {
  return markdownList(
    strings(value).map((entry) => userVisibleText(entry, zh)),
    zh ? "无" : "None recorded.",
  );
}

function boundedMarkdownList(value: unknown, zh: boolean, limit = 5): string {
  const values = boundedValues(
    strings(value).map((entry) => userVisibleText(entry, zh)),
    limit,
  );
  return markdownList(
    [
      ...values.visible,
      ...(values.omitted === 0
        ? []
        : [
            zh
              ? `其余 ${values.omitted} 项保留在核心报告和审计附录。`
              : `${values.omitted} additional item${values.omitted === 1 ? "" : "s"} remain in the core report and audit appendix.`,
          ]),
    ],
    zh ? "无" : "None recorded.",
  );
}

function summaryList(value: unknown, zh: boolean, limit?: number): string {
  const summaries = records(value);
  if (summaries.length === 0) {
    return zh ? "- 无\n" : "- None recorded.\n";
  }
  const selected = limit === undefined ? summaries : summaries.slice(0, limit);
  const omitted = summaries.length - selected.length;
  return (
    `${selected.map((entry) => `- ${userVisibleText(entry.summary, zh)}`).join("\n")}\n` +
    (omitted === 0
      ? ""
      : `- ${zh ? `其余 ${omitted} 项及其精确引用保留在核心报告和审计附录。` : `${omitted} additional item${omitted === 1 ? "" : "s"} and exact references remain in the core report and audit appendix.`}\n`)
  );
}

function localizedLeakageGuard(report: Record<string, unknown>, markdown: string): void {
  const issues = localizedInternalLeakageIssues(report.research_language, markdown);
  if (issues.length > 0) {
    throw new StoreError(
      "report.localized_surface_internal_term",
      "localized report surfaces must hide internal codes and Artifact references",
      { issues },
    );
  }
}

function renderReportStatistics(report: Record<string, unknown>, zh = false): string {
  const statistics = isRecord(report.report_statistics) ? report.report_statistics : {};
  return zh
    ? `- 可读来源 ${String(statistics.readable_source_count ?? 0)}；量化信号 ${String(statistics.quantitative_signal_count ?? 0)}（决策级 ${String(statistics.decision_grade_quantitative_signal_count ?? 0)}，方向/背景 ${String(statistics.directional_or_context_quantitative_signal_count ?? 0)}）；竞品/替代对象 ${String(statistics.competitive_object_count ?? 0)}；完整缺口行 ${String(statistics.full_gap_row_count ?? 0)}；核心缺口组 ${String(statistics.critical_gap_group_count ?? 0)}。\n`
    : `- Readable sources ${String(statistics.readable_source_count ?? 0)}; quantitative signals ${String(statistics.quantitative_signal_count ?? 0)} (decision-grade ${String(statistics.decision_grade_quantitative_signal_count ?? 0)}, directional/context ${String(statistics.directional_or_context_quantitative_signal_count ?? 0)}); competitive/substitute objects ${String(statistics.competitive_object_count ?? 0)}; full gap rows ${String(statistics.full_gap_row_count ?? 0)}; critical gap groups ${String(statistics.critical_gap_group_count ?? 0)}.\n`;
}

function renderGenericAuditAppendix(
  report: Record<string, unknown>,
  title: string,
  zh = false,
): string {
  const fullProjection = isRecord(report.full_commercial_projection)
    ? report.full_commercial_projection
    : {};
  const auditModel = { ...report, ...fullProjection };
  return [
    `# ${title}\n\n`,
    `> ${zh ? "本附录由 Harness 从与决策摘要和核心报告相同的最终 report model 机械派生；完整结构化真值保留在 report.json。" : "This appendix is mechanically derived by the Harness from the same final report model as the brief and core report; report.json retains the complete structured truth."}\n\n`,
    `## ${zh ? "机械统计" : "Mechanical Statistics"}\n`,
    renderReportStatistics(
      { ...auditModel, report_statistics: deriveReportStatistics(auditModel) },
      zh,
    ),
    `\n## ${zh ? "全部量化信号" : "All Quantitative Signals"}\n`,
    renderQuantitativeSignalTable(auditModel, zh),
    `\n## ${zh ? "完整竞品与广义替代矩阵" : "Full Competitive And Substitute Matrix"}\n`,
    renderCompetitiveSubstituteMatrix(auditModel, zh),
    `\n## ${zh ? "完整研究覆盖缺口" : "Full Research Coverage Gaps"}\n`,
    renderResearchCoverageGaps(auditModel, zh),
    `\n## ${zh ? "材料采用、限制与排除" : "Material Adoption, Limitations, And Exclusions"}\n`,
    renderEvidenceDispositions(report, zh),
    `\n## ${zh ? "非阻塞诊断" : "Non-blocking Diagnostics"}\n`,
    renderGateWarnings(report, zh),
  ].join("");
}

function renderDecisionBrief(report: Record<string, unknown>): string {
  const zh = isChineseResearchLanguage(report.research_language);
  const context = requiredRecord(report.curated_judgment_context, "curated_judgment_context");
  const belief = requiredRecord(context.belief_update_summary, "belief_update_summary");
  const boundary = requiredRecord(context.external_action_boundary, "external_action_boundary");
  return [
    `# ${zh ? "决策摘要" : "Decision Brief"}\n`,
    `## ${zh ? "决策问题" : "Decision Question"}\n`,
    `${userVisibleText(context.decision_question, zh)}\n\n`,
    `## ${zh ? "当前建议" : "Current Recommendation"}\n`,
    `${userVisibleText(context.current_recommendation, zh)}\n\n`,
    `${zh ? "评估结果" : "Assessment result"}: ${localizedEnum(context.assessment_result, zh)}\n\n`,
    `${zh ? "含义" : "Meaning"}: ${userVisibleText(context.recommendation_meaning, zh)}\n\n`,
    `## ${zh ? "研究概览" : "Key Research Counts"}\n`,
    renderReportStatistics(report, zh),
    `\n## ${zh ? "关键支持材料" : "Decisive Support"}\n`,
    summaryList(context.decisive_support, zh, 4),
    `\n## ${zh ? "关键反对材料" : "Decisive Opposition"}\n`,
    summaryList(context.decisive_opposition, zh, 5),
    `\n## ${zh ? "未选择的替代方向" : "Alternatives Not Selected"}\n`,
    boundedMarkdownList(context.alternatives_not_selected, zh),
    `\n## ${zh ? "关键未知" : "Critical Unknowns"}\n`,
    boundedMarkdownList(context.critical_unknowns, zh),
    `\n## ${zh ? "哪些情况会改变决策" : "What Would Change the Decision"}\n`,
    boundedMarkdownList(context.what_would_change_the_decision, zh),
    `\n## ${zh ? "判断变化" : "Belief Update"}\n`,
    `${zh ? "初始判断" : "Initial belief"}: ${userVisibleText(belief.initial_belief, zh)}\n\n`,
    `${zh ? "改变判断的材料" : "Evidence that changed belief"}:\n`,
    boundedMarkdownList(belief.evidence_that_changed_belief, zh),
    `\n${zh ? "未改变的假设" : "Unchanged assumptions"}:\n`,
    boundedMarkdownList(belief.unchanged_assumptions, zh),
    `\n${zh ? "仍存分歧" : "Remaining disagreement"}:\n`,
    boundedMarkdownList(belief.remaining_disagreement, zh),
    `\n${zh ? "最终决策者" : "Final decision owner"}: ${localizedEnum(belief.final_decision_owner, zh)}\n\n`,
    `## ${zh ? "范围与时效" : "Scope and Freshness"}\n`,
    `${userVisibleText(context.scope_summary, zh)}\n\n${zh ? "有效日期" : "Valid as of"}: ${String(context.valid_as_of)}\n\n`,
    `## ${zh ? "限制" : "Limitations"}\n`,
    boundedMarkdownList(context.limitations, zh),
    `\n## ${zh ? "头部公司吸收与响应风险" : "Incumbent Absorption And Response Risk"}\n`,
    renderIncumbentResponseDisclosure(report, zh),
    `\n## ${zh ? "外部行动边界" : "External Action Boundary"}\n`,
    `${zh ? "执行责任人" : "Execution owner"}: ${localizedEnum(boundary.execution_owner, zh)}\n\n`,
    `${zh ? "是否支持执行" : "Execution supported"}: ${localizedEnum(boundary.execution_supported, zh)}\n\n`,
    `${zh ? "是否支持结果追踪" : "Result tracking supported"}: ${localizedEnum(boundary.result_tracking_supported, zh)}\n\n`,
    `${zh ? "是否声称完成外部验证" : "External validation claimed"}: ${localizedEnum(boundary.external_validation_claimed, zh)}\n`,
  ].join("");
}

function renderFullReport(report: Record<string, unknown>): string {
  const zh = isChineseResearchLanguage(report.research_language);
  const context = requiredRecord(report.curated_judgment_context, "curated_judgment_context");
  const sections = requiredRecord(report.report_sections, "report_sections");
  const metadata = requiredRecord(report.report_metadata, "report_metadata");
  const parts = [
    `# ${zh ? "产品假设证据评估报告" : "Concept Evidence Assessment Report"}\n`,
    `\n${zh ? "评估结果" : "Assessment result"}: ${localizedEnum(context.assessment_result, zh)}\n`,
    `\n${zh ? "建议" : "Recommendation"}: ${userVisibleText(context.current_recommendation, zh)}\n`,
    `\n${zh ? "含义" : "Meaning"}: ${userVisibleText(context.recommendation_meaning, zh)}\n`,
    `\n${zh ? "有效日期" : "Valid as of"}: ${String(context.valid_as_of)}\n`,
    `\n${zh ? "生成时间" : "Generated at"}: ${String(metadata.generated_at)}\n`,
    `\n## ${zh ? "研究概览" : "Key Research Counts"}\n`,
    renderReportStatistics(report, zh),
  ];
  for (const sectionId of REPORT_SECTION_ORDER) {
    if (sectionId === "competition_and_differentiation") {
      parts.push(
        `\n## ${zh ? "市场研究优先级与商业验证就绪度" : "Market Research Priority And Commercial Validation Readiness"}\n`,
      );
      parts.push(renderMarketPriorityAndCommercialReadiness(report, zh));
      parts.push(`\n## ${zh ? "决策级量化摘要" : "Decision-grade Quantitative Summary"}\n`);
      parts.push(renderDecisionGradeQuantitativeSummary(report, zh));
      parts.push(`\n## ${zh ? "竞品与广义替代摘要" : "Competitive And Substitute Summary"}\n`);
      parts.push(renderCompetitiveSubjectSummary(report, zh));
      parts.push(
        `\n## ${zh ? "头部公司吸收与响应风险" : "Incumbent Absorption And Response Risk"}\n`,
      );
      parts.push(renderIncumbentResponseRiskTable(report, zh));
    }
    if (sectionId === "limitations_and_sources") {
      parts.push(`\n## ${zh ? "关键研究缺口" : "Critical Research Gaps"}\n`);
      parts.push(renderCriticalResearchGaps(report, zh));
    }
    parts.push(
      `\n## ${zh ? REPORT_SECTION_TITLES_ZH[sectionId] : REPORT_SECTION_TITLES[sectionId]}\n`,
    );
    parts.push(localizedMarkdownList(sections[sectionId], zh));
  }
  return parts.join("");
}

function renderAssessmentAuditAppendix(report: Record<string, unknown>): string {
  const zh = isChineseResearchLanguage(report.research_language);
  return renderGenericAuditAppendix(
    report,
    zh ? "产品假设证据评估审计附录" : "Concept Evidence Assessment Audit Appendix",
    zh,
  );
}

function reportHashEntry(report: Record<string, unknown>, ref: string): string {
  const metadata = requiredRecord(report.report_metadata, "report_metadata");
  const entry = records(metadata.input_artifact_hashes).find((candidate) => candidate.ref === ref);
  if (entry === undefined || !isSha256(entry.content_hash)) {
    throw new StoreError(
      "report.input_hash_missing",
      "report metadata must bind the Assessment input content hash",
      { ref },
    );
  }
  return entry.content_hash;
}

function formalEnvelope(
  source: FormalArtifactEnvelope,
  artifactPath: string,
  artifactType: string,
  document: Record<string, unknown>,
  _inputRefs: readonly string[],
): FormalArtifactEnvelope {
  const inputRefs = [...new Set(collectDocumentRefs(document))]
    .filter((ref) => ref !== artifactPath)
    .sort();
  if (isRecord(source.ai_bundle_binding)) {
    inputRefs.push(...collectDocumentRefs(source.ai_bundle_binding));
    inputRefs.sort();
  }
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: artifactType,
    artifact_path: artifactPath,
    run_id: source.run_id,
    created_at: source.created_at,
    producer_role: "harness",
    input_refs: [...new Set(inputRefs)].sort(),
    content_hash: canonicalContentHash(document),
    document,
    ...(source.ai_bundle_binding === undefined
      ? {}
      : { ai_bundle_binding: source.ai_bundle_binding }),
  } as FormalArtifactEnvelope;
}

function collectDocumentRefs(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectDocumentRefs);
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    if ((key.endsWith("_refs") || key === "input_refs") && Array.isArray(child)) {
      return strings(child).filter((ref) => ref.includes("/") || ref.includes("#"));
    }
    if (
      (key.endsWith("_ref") || key === "ref") &&
      typeof child === "string" &&
      (child.includes("/") || child.includes("#"))
    ) {
      return [child];
    }
    return collectDocumentRefs(child);
  });
}

function renderDiscoveryDecisionBrief(report: Record<string, unknown>): string {
  const zh = isChineseResearchLanguage(report.research_language);
  const context = requiredRecord(report.curated_judgment_context, "curated_judgment_context");
  return [
    `# ${zh ? "决策摘要" : "Decision Brief"}\n\n`,
    `## ${zh ? "决策问题" : "Decision Question"}\n`,
    `${userVisibleText(context.decision_question, zh)}\n\n`,
    `## ${zh ? "当前建议" : "Current Recommendation"}\n`,
    `${userVisibleText(context.current_recommendation, zh)}\n\n`,
    `${zh ? "决策层级" : "Decision tier"}: ${localizedEnum(context.decision_tier, zh)}\n\n`,
    `${zh ? "含义" : "Meaning"}: ${userVisibleText(context.recommendation_meaning, zh)}\n\n`,
    `## ${zh ? "局部排序" : "Partial Order"}\n`,
    `${userVisibleText(context.partial_order_summary, zh)}\n\n`,
    `## ${zh ? "研究概览" : "Key Research Counts"}\n`,
    renderReportStatistics(report, zh),
    `\n## ${zh ? "关键支持材料" : "Decisive Support"}\n`,
    summaryList(context.decisive_support, zh, 4),
    `\n## ${zh ? "关键反对材料" : "Decisive Opposition"}\n`,
    summaryList(context.decisive_opposition, zh, 5),
    `\n## ${zh ? "关键未知" : "Critical Unknowns"}\n`,
    boundedMarkdownList(context.critical_unknowns, zh),
    `\n## ${zh ? "哪些情况会改变决策" : "What Would Change the Decision"}\n`,
    boundedMarkdownList(context.what_would_change_the_decision, zh),
    `\n## ${zh ? "限制" : "Limitations"}\n`,
    boundedMarkdownList(context.limitations, zh),
    `\n## ${zh ? "头部公司吸收与响应风险" : "Incumbent Absorption And Response Risk"}\n`,
    renderIncumbentResponseDisclosure(report, zh),
  ].join("");
}

function renderDiscoveryFullReport(report: Record<string, unknown>): string {
  const zh = isChineseResearchLanguage(report.research_language);
  const context = requiredRecord(report.curated_judgment_context, "curated_judgment_context");
  const sections = requiredRecord(report.report_sections, "report_sections");
  const metadata = requiredRecord(report.report_metadata, "report_metadata");
  const parts = [
    `# ${zh ? "创业机会发现报告" : "Startup Opportunity Discovery Report"}\n`,
    `\n${zh ? "决策层级" : "Decision tier"}: ${localizedEnum(context.decision_tier, zh)}\n`,
    `\n${zh ? "建议" : "Recommendation"}: ${userVisibleText(context.current_recommendation, zh)}\n`,
    `\n${zh ? "有效日期" : "Valid as of"}: ${String(context.valid_as_of)}\n`,
    `\n${zh ? "生成时间" : "Generated at"}: ${String(metadata.generated_at)}\n`,
    `\n## ${zh ? "研究概览" : "Key Research Counts"}\n`,
    renderReportStatistics(report, zh),
  ];
  for (const sectionId of DISCOVERY_REPORT_SECTION_ORDER) {
    if (sectionId === "top_opportunities") {
      parts.push(
        `\n## ${zh ? "市场研究优先级与商业验证就绪度" : "Market Research Priority And Commercial Validation Readiness"}\n`,
      );
      parts.push(renderMarketPriorityAndCommercialReadiness(report, zh));
      parts.push(`\n## ${zh ? "决策级量化摘要" : "Decision-grade Quantitative Summary"}\n`);
      parts.push(renderDecisionGradeQuantitativeSummary(report, zh));
      parts.push(`\n## ${zh ? "竞品与广义替代摘要" : "Competitive And Substitute Summary"}\n`);
      parts.push(renderCompetitiveSubjectSummary(report, zh));
      parts.push(
        `\n## ${zh ? "头部公司吸收与响应风险" : "Incumbent Absorption And Response Risk"}\n`,
      );
      parts.push(renderIncumbentResponseRiskTable(report, zh));
    }
    if (sectionId === "traceability_and_sources") {
      parts.push(`\n## ${zh ? "关键研究缺口" : "Critical Research Gaps"}\n`);
      parts.push(renderCriticalResearchGaps(report, zh));
    }
    const title = zh
      ? DISCOVERY_SECTION_TITLES_ZH[sectionId]
      : sectionId
          .split("_")
          .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
          .join(" ");
    parts.push(`\n## ${title}\n`);
    parts.push(localizedMarkdownList(sections[sectionId], zh));
  }
  return parts.join("");
}

function renderDiscoveryAuditAppendix(report: Record<string, unknown>): string {
  const zh = isChineseResearchLanguage(report.research_language);
  return renderGenericAuditAppendix(
    report,
    zh ? "创业机会发现审计附录" : "Startup Opportunity Discovery Audit Appendix",
    zh,
  );
}

function deriveDiscoveryReportEnvelopes(
  reportEnvelope: FormalArtifactEnvelope,
): readonly FormalArtifactEnvelope[] {
  const report = reportEnvelope.document;
  const revision = revisionOf(reportEnvelope.artifact_path);
  const context = requiredRecord(report.curated_judgment_context, "curated_judgment_context");
  const reportHash = canonicalContentHash(report);
  const recommendationRef = requiredString(
    report.decision_recommendation_ref,
    "decision_recommendation_ref",
  );
  const traceabilityRef = requiredString(report.traceability_ref, "traceability_ref");
  const supportingRefs = flattenSummaryRefs(context.decisive_support);
  const opposingRefs = flattenSummaryRefs(context.decisive_opposition);
  const decisionBriefPath = `artifacts/reporting/decision-brief.${revision}.json`;
  const reportViewPath = `artifacts/reporting/report-markdown.${revision}.json`;
  const consistencyPath = `artifacts/reporting/consistency-evaluation.${revision}.json`;
  const briefMarkdown = renderDiscoveryDecisionBrief(report);
  localizedLeakageGuard(report, briefMarkdown);
  const briefDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.decision_brief.discovery.current",
    brief_id: `decision_brief_${revision.replace("r", "")}`,
    run_id: reportEnvelope.run_id,
    research_language: report.research_language,
    producer_role: "harness",
    owned_output_path: decisionBriefPath,
    materialized_path: "decision-brief.md",
    report_ref: reportEnvelope.artifact_path,
    report_content_hash: reportHash,
    decision_recommendation_ref: recommendationRef,
    decision_question: context.decision_question,
    decision_tier: context.decision_tier,
    current_recommendation: context.current_recommendation,
    recommendation_meaning: context.recommendation_meaning,
    recommended_first_bet: context.recommended_first_bet,
    alternative_bets: context.alternative_bets,
    partial_order_summary: context.partial_order_summary,
    decisive_supporting_refs: supportingRefs,
    decisive_opposing_refs: opposingRefs,
    critical_unknowns: context.critical_unknowns,
    what_would_change_the_decision: context.what_would_change_the_decision,
    belief_update_summary: context.belief_update_summary,
    valid_as_of: context.valid_as_of,
    scope_summary: context.scope_summary,
    limitations: context.limitations,
    external_action_boundary: context.external_action_boundary,
    markdown: briefMarkdown,
    markdown_content_hash: sha256Bytes(briefMarkdown),
  };
  const briefEnvelope = formalEnvelope(
    reportEnvelope,
    decisionBriefPath,
    "startup_opportunity.decision_brief.discovery.current",
    briefDocument,
    [],
  );
  const reportMarkdown = renderDiscoveryFullReport(report);
  const auditAppendixMarkdown = renderDiscoveryAuditAppendix(report);
  localizedLeakageGuard(report, `${reportMarkdown}\n${auditAppendixMarkdown}`);
  const viewDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.discovery_report_view.v1",
    view_id: `report_markdown_${revision.replace("r", "")}`,
    run_id: reportEnvelope.run_id,
    research_language: report.research_language,
    producer_role: "harness",
    owned_output_path: reportViewPath,
    materialized_path: "report.md",
    audit_appendix_path: "audit-appendix.md",
    report_ref: reportEnvelope.artifact_path,
    report_content_hash: reportHash,
    decision_recommendation_ref: recommendationRef,
    decision_tier: context.decision_tier,
    recommendation_meaning: context.recommendation_meaning,
    recommended_first_bet: context.recommended_first_bet,
    alternative_bets: context.alternative_bets,
    partial_order_summary: context.partial_order_summary,
    decisive_supporting_refs: supportingRefs,
    decisive_opposing_refs: opposingRefs,
    valid_as_of: context.valid_as_of,
    limitations: context.limitations,
    external_action_boundary: context.external_action_boundary,
    section_ids: DISCOVERY_REPORT_SECTION_IDS,
    markdown: reportMarkdown,
    markdown_content_hash: sha256Bytes(reportMarkdown),
    audit_appendix_markdown: auditAppendixMarkdown,
    audit_appendix_content_hash: sha256Bytes(auditAppendixMarkdown),
  };
  const viewEnvelope = formalEnvelope(
    reportEnvelope,
    reportViewPath,
    "startup_opportunity.discovery_report_view.v1",
    viewDocument,
    [],
  );
  const forbiddenExpressionMatches = scanDiscoveryReportSurfaces({
    structuredReport: report,
    decisionBrief: briefMarkdown,
    reportView: `${reportMarkdown}\n${auditAppendixMarkdown}`,
  });
  const evaluatorResult = forbiddenExpressionMatches.length === 0 ? "passed" : "failed";
  const consistencyDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.report_consistency_evaluation.discovery.current",
    evaluation_id: `report_consistency_${revision.replace("r", "")}`,
    run_id: reportEnvelope.run_id,
    producer_role: "harness",
    owned_output_path: consistencyPath,
    report_ref: reportEnvelope.artifact_path,
    decision_brief_ref: decisionBriefPath,
    report_view_ref: reportViewPath,
    decision_recommendation_ref: recommendationRef,
    traceability_ref: traceabilityRef,
    checked_dimensions: REQUIRED_REPORT_CONSISTENCY_DIMENSIONS,
    scan_contract_version: REPORT_SCAN_CONTRACT_VERSION,
    scanned_surfaces: REPORT_SCAN_SURFACES,
    forbidden_expression_matches: forbiddenExpressionMatches,
    evaluator_result: evaluatorResult,
    evaluation_issues: forbiddenExpressionMatches.map((match) => ({
      code: "forbidden_expression",
      field: match,
      artifact_ref: reportEnvelope.artifact_path,
      revision_request: "Remove the forbidden claim and publish a new immutable report revision.",
    })),
    input_artifact_hashes: [
      { ref: reportEnvelope.artifact_path, content_hash: reportHash },
      { ref: decisionBriefPath, content_hash: canonicalContentHash(briefDocument) },
      { ref: reportViewPath, content_hash: canonicalContentHash(viewDocument) },
      { ref: recommendationRef, content_hash: reportHashEntry(report, recommendationRef) },
      { ref: traceabilityRef, content_hash: reportHashEntry(report, traceabilityRef) },
    ],
    valid_as_of: context.valid_as_of,
    limitations: context.limitations,
  };
  return [
    briefEnvelope,
    viewEnvelope,
    formalEnvelope(
      reportEnvelope,
      consistencyPath,
      "startup_opportunity.report_consistency_evaluation.discovery.current",
      consistencyDocument,
      [],
    ),
  ];
}

function assertDerivedConsistencyPassed(derived: readonly FormalArtifactEnvelope[]): void {
  const consistency = derived.find((entry) =>
    [
      "startup_opportunity.report_consistency_evaluation.discovery.current",
      "startup_opportunity.report_consistency_evaluation.terminal.current",
    ].includes(entry.artifact_type),
  );
  if (
    consistency !== undefined &&
    (consistency.document.evaluator_result !== "passed" ||
      strings(consistency.document.forbidden_expression_matches).length > 0)
  ) {
    throw new StoreError(
      "report.forbidden_expression_detected",
      "discovery report contains forbidden validation, probability, or global-score language",
      { matches: consistency.document.forbidden_expression_matches },
    );
  }
}

export function deriveReportEnvelopes(
  reportEnvelope: FormalArtifactEnvelope,
): readonly FormalArtifactEnvelope[] {
  if (
    reportEnvelope.schema_version === "startup_opportunity.artifact_envelope.current" &&
    reportEnvelope.artifact_type === "startup_opportunity.terminal_report_source.v1" &&
    reportEnvelope.producer_role === "main_agent" &&
    reportEnvelope.document.schema_version === "startup_opportunity.terminal_report_source.v1"
  ) {
    return deriveTerminalReportDocuments(reportEnvelope).map((derived) =>
      formalEnvelope(
        reportEnvelope,
        derived.artifactPath,
        derived.artifactType,
        derived.document,
        [],
      ),
    );
  }
  if (
    reportEnvelope.schema_version === "startup_opportunity.artifact_envelope.current" &&
    reportEnvelope.artifact_type === "startup_opportunity.report.v1" &&
    reportEnvelope.producer_role === "main_agent" &&
    reportEnvelope.document.schema_version === "startup_opportunity.report.v1"
  ) {
    return deriveDiscoveryReportEnvelopes(reportEnvelope);
  }
  if (
    reportEnvelope.schema_version !== "startup_opportunity.artifact_envelope.current" ||
    reportEnvelope.artifact_type !== "startup_opportunity.concept_evidence_report.v1" ||
    reportEnvelope.producer_role !== "main_agent" ||
    reportEnvelope.document.schema_version !== "startup_opportunity.concept_evidence_report.v1"
  ) {
    throw new StoreError(
      "report.source_invalid",
      "build-report requires a current main-agent concept report envelope",
    );
  }
  const report = reportEnvelope.document;
  const revision = revisionOf(reportEnvelope.artifact_path);
  const context = requiredRecord(report.curated_judgment_context, "curated_judgment_context");
  const reportHash = canonicalContentHash(report);
  const assessmentRef = requiredString(
    report.concept_evidence_assessment_ref,
    "concept_evidence_assessment_ref",
  );
  const supportingRefs = flattenSummaryRefs(context.decisive_support);
  const opposingRefs = flattenSummaryRefs(context.decisive_opposition);
  const decisionBriefPath = `artifacts/reporting/decision-brief.${revision}.json`;
  const reportViewPath = `artifacts/reporting/report-markdown.${revision}.json`;
  const consistencyPath = `artifacts/reporting/consistency-evaluation.${revision}.json`;
  const briefMarkdown = renderDecisionBrief(report);
  localizedLeakageGuard(report, briefMarkdown);
  const briefDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.decision_brief.assessment.current",
    brief_id: `decision_brief_${revision.replace("r", "")}`,
    run_id: reportEnvelope.run_id,
    research_language: report.research_language,
    producer_role: "harness",
    owned_output_path: decisionBriefPath,
    materialized_path: "decision-brief.md",
    report_ref: reportEnvelope.artifact_path,
    report_content_hash: reportHash,
    assessment_ref: assessmentRef,
    decision_question: context.decision_question,
    assessment_result: context.assessment_result,
    current_recommendation: context.current_recommendation,
    recommendation_meaning: context.recommendation_meaning,
    decisive_supporting_refs: supportingRefs,
    decisive_opposing_refs: opposingRefs,
    alternatives_not_selected: context.alternatives_not_selected,
    critical_unknowns: context.critical_unknowns,
    what_would_change_the_decision: context.what_would_change_the_decision,
    belief_update_summary: context.belief_update_summary,
    valid_as_of: context.valid_as_of,
    scope_summary: context.scope_summary,
    limitations: context.limitations,
    external_action_boundary: context.external_action_boundary,
    markdown: briefMarkdown,
    markdown_content_hash: sha256Bytes(briefMarkdown),
  };
  const briefEnvelope = formalEnvelope(
    reportEnvelope,
    decisionBriefPath,
    "startup_opportunity.decision_brief.assessment.current",
    briefDocument,
    [reportEnvelope.artifact_path, assessmentRef, ...supportingRefs, ...opposingRefs],
  );

  const reportMarkdown = renderFullReport(report);
  const auditAppendixMarkdown = renderAssessmentAuditAppendix(report);
  localizedLeakageGuard(report, `${reportMarkdown}\n${auditAppendixMarkdown}`);
  const viewDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.concept_evidence_report_view.v1",
    view_id: `report_markdown_${revision.replace("r", "")}`,
    run_id: reportEnvelope.run_id,
    research_language: report.research_language,
    producer_role: "harness",
    owned_output_path: reportViewPath,
    materialized_path: "report.md",
    audit_appendix_path: "audit-appendix.md",
    report_ref: reportEnvelope.artifact_path,
    report_content_hash: reportHash,
    assessment_ref: assessmentRef,
    assessment_result: context.assessment_result,
    recommendation_meaning: context.recommendation_meaning,
    decisive_supporting_refs: supportingRefs,
    decisive_opposing_refs: opposingRefs,
    valid_as_of: context.valid_as_of,
    limitations: context.limitations,
    external_action_boundary: context.external_action_boundary,
    section_ids: ASSESSMENT_REPORT_SECTION_IDS,
    markdown: reportMarkdown,
    markdown_content_hash: sha256Bytes(reportMarkdown),
    audit_appendix_markdown: auditAppendixMarkdown,
    audit_appendix_content_hash: sha256Bytes(auditAppendixMarkdown),
  };
  const viewEnvelope = formalEnvelope(
    reportEnvelope,
    reportViewPath,
    "startup_opportunity.concept_evidence_report_view.v1",
    viewDocument,
    [reportEnvelope.artifact_path, assessmentRef, ...supportingRefs, ...opposingRefs],
  );

  const consistencyDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.report_consistency_evaluation.assessment.current",
    evaluation_id: `report_consistency_${revision.replace("r", "")}`,
    run_id: reportEnvelope.run_id,
    producer_role: "harness",
    owned_output_path: consistencyPath,
    report_ref: reportEnvelope.artifact_path,
    decision_brief_ref: decisionBriefPath,
    report_view_ref: reportViewPath,
    assessment_ref: assessmentRef,
    checked_dimensions: REPORT_CHECKS,
    forbidden_expression_matches: [],
    evaluator_result: "passed",
    evaluation_issues: [],
    input_artifact_hashes: [
      { ref: reportEnvelope.artifact_path, content_hash: reportHash },
      { ref: decisionBriefPath, content_hash: canonicalContentHash(briefDocument) },
      { ref: reportViewPath, content_hash: canonicalContentHash(viewDocument) },
      { ref: assessmentRef, content_hash: reportHashEntry(report, assessmentRef) },
    ],
    valid_as_of: context.valid_as_of,
    limitations: context.limitations,
  };
  const consistencyEnvelope = formalEnvelope(
    reportEnvelope,
    consistencyPath,
    "startup_opportunity.report_consistency_evaluation.assessment.current",
    consistencyDocument,
    [reportEnvelope.artifact_path, decisionBriefPath, reportViewPath, assessmentRef],
  );
  return [briefEnvelope, viewEnvelope, consistencyEnvelope];
}

function materializedOutputs(envelope: FormalArtifactEnvelope): readonly {
  readonly targetPath: ReportMaterializationReceipt["target_path"];
  readonly bytes: string;
}[] {
  if (
    envelope.artifact_type === "startup_opportunity.concept_evidence_report.v1" ||
    envelope.artifact_type === "startup_opportunity.report.v1" ||
    envelope.artifact_type === "startup_opportunity.terminal_report_source.v1"
  ) {
    return [{ targetPath: "report.json", bytes: `${canonicalJson(envelope.document)}\n` }];
  }
  if (
    envelope.artifact_type === "startup_opportunity.decision_brief.assessment.current" ||
    envelope.artifact_type === "startup_opportunity.decision_brief.discovery.current" ||
    envelope.artifact_type === "startup_opportunity.decision_brief.terminal.current"
  ) {
    return [
      {
        targetPath: "decision-brief.md",
        bytes: requiredString(envelope.document.markdown, "markdown"),
      },
    ];
  }
  if (
    envelope.artifact_type === "startup_opportunity.concept_evidence_report_view.v1" ||
    envelope.artifact_type === "startup_opportunity.discovery_report_view.v1" ||
    envelope.artifact_type === "startup_opportunity.terminal_report_view.v1"
  ) {
    return [
      {
        targetPath: "report.md",
        bytes: requiredString(envelope.document.markdown, "markdown"),
      },
      {
        targetPath: "audit-appendix.md",
        bytes: requiredString(envelope.document.audit_appendix_markdown, "audit_appendix_markdown"),
      },
    ];
  }
  return [];
}

async function assertMaterializedTargetsCompatibleLocked(
  runRoot: string,
  envelopes: readonly FormalArtifactEnvelope[],
): Promise<void> {
  for (const envelope of envelopes) {
    for (const materialized of materializedOutputs(envelope)) {
      if (
        (materialized.targetPath === "audit-appendix.md"
          ? envelope.document.audit_appendix_path
          : envelope.document.materialized_path) !== materialized.targetPath
      ) {
        throw new StoreError(
          "report.materialized_path_mismatch",
          "report sidecar targets another view path",
          { artifactPath: envelope.artifact_path, targetPath: materialized.targetPath },
        );
      }
      try {
        const existing = await readFile(
          await resolveRunPath(runRoot, materialized.targetPath),
          "utf8",
        );
        if (existing !== materialized.bytes) {
          throw new StoreError(
            "report.materialized_conflict",
            "materialized report bytes differ from sidecar",
            { targetPath: materialized.targetPath },
          );
        }
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }
}

async function assertReportBuildCompatibleLocked(
  runRoot: string,
  source: FormalArtifactEnvelope,
  derived: readonly FormalArtifactEnvelope[],
): Promise<void> {
  const existingReports = (await reportingEnvelopes(runRoot)).filter(
    (envelope) =>
      envelope.artifact_type === "startup_opportunity.concept_evidence_report.v1" ||
      envelope.artifact_type === "startup_opportunity.report.v1" ||
      envelope.artifact_type === "startup_opportunity.terminal_report_source.v1",
  );
  const conflictingReport = existingReports.find(
    (envelope) => canonicalJson(envelope) !== canonicalJson(source),
  );
  if (conflictingReport !== undefined) {
    throw new StoreError(
      "report.final_revision_conflict",
      "a different final report revision is already published for this Run",
      {
        existingArtifactPath: conflictingReport.artifact_path,
        candidateArtifactPath: source.artifact_path,
      },
    );
  }
  await assertMaterializedTargetsCompatibleLocked(runRoot, [source, ...derived]);
}

async function assertNoOtherFinalReportLocked(
  runRoot: string,
  source: FormalArtifactEnvelope,
): Promise<void> {
  const conflictingReport = (await reportingEnvelopes(runRoot)).find(
    (envelope) =>
      (envelope.artifact_type === "startup_opportunity.concept_evidence_report.v1" ||
        envelope.artifact_type === "startup_opportunity.report.v1" ||
        envelope.artifact_type === "startup_opportunity.terminal_report_source.v1") &&
      envelope.artifact_path !== source.artifact_path,
  );
  if (conflictingReport !== undefined) {
    throw new StoreError(
      "report.final_revision_conflict",
      "a different final report revision is already published for this Run",
      {
        existingArtifactPath: conflictingReport.artifact_path,
        candidateArtifactPath: source.artifact_path,
      },
    );
  }
}

function preparedTerminalReportOperation(
  request: FormalArtifactEnvelope,
  source: FormalArtifactEnvelope,
  derived: readonly FormalArtifactEnvelope[],
): PreparedTerminalReportOperation {
  const materializedOutputs = [source, ...derived].flatMap((envelope) => {
    return materializedOutputsForEnvelope(envelope);
  });
  const identity = {
    schema_version: "startup_opportunity.terminal_report_operation.current" as const,
    run_id: source.run_id,
    request_envelope: request,
    source_envelope: source,
    derived_envelopes: derived,
    materialized_outputs: materializedOutputs,
  };
  return { ...identity, operation_key: operationKey("terminal_report_operation", identity) };
}

function materializedOutputsForEnvelope(envelope: FormalArtifactEnvelope) {
  return materializedOutputs(envelope).map((materialized) => ({
    source_artifact_path: envelope.artifact_path,
    target_path: materialized.targetPath,
    content_hash: sha256Bytes(materialized.bytes),
    bytes: materialized.bytes,
  }));
}

export function validatePreparedTerminalReportOperation(
  value: unknown,
  runId: string,
  validator: ArtifactValidator,
): PreparedTerminalReportOperation {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "operation_key",
      "run_id",
      "request_envelope",
      "source_envelope",
      "derived_envelopes",
      "materialized_outputs",
    ]) ||
    value.schema_version !== "startup_opportunity.terminal_report_operation.current" ||
    value.run_id !== runId ||
    !isSha256(value.operation_key) ||
    !isRecord(value.request_envelope) ||
    !isRecord(value.source_envelope) ||
    !Array.isArray(value.derived_envelopes) ||
    !Array.isArray(value.materialized_outputs)
  ) {
    throw new StoreError(
      "report.terminal_operation_invalid",
      "terminal report operation is invalid",
    );
  }
  const operation = value as unknown as PreparedTerminalReportOperation;
  const request = operation.request_envelope;
  const source = operation.source_envelope;
  const derived = operation.derived_envelopes;
  const materializedTargets = operation.materialized_outputs.map((output) => output.target_path);
  const materializedSources = operation.materialized_outputs.map(
    (output) => output.source_artifact_path,
  );
  const expectedMaterializedSources = [source, ...derived].flatMap((envelope) =>
    materializedOutputs(envelope).map(() => envelope.artifact_path),
  );
  if (
    request.run_id !== runId ||
    request.artifact_type !== "startup_opportunity.terminal_report_source.v1" ||
    source.run_id !== runId ||
    source.artifact_type !== "startup_opportunity.terminal_report_source.v1" ||
    derived.length !== 3 ||
    derived.some((envelope) => envelope.run_id !== runId) ||
    operation.materialized_outputs.length !== 4 ||
    new Set(materializedTargets).size !== 4 ||
    !["report.json", "decision-brief.md", "report.md", "audit-appendix.md"].every((target) =>
      materializedTargets.includes(target as ReportMaterializationReceipt["target_path"]),
    ) ||
    canonicalJson(materializedSources) !== canonicalJson(expectedMaterializedSources) ||
    canonicalJson(deriveReportEnvelopes(source)) !== canonicalJson(derived) ||
    canonicalJson(preparedTerminalReportOperation(request, source, derived)) !==
      canonicalJson(operation) ||
    !validator.validateDocument(request, request.artifact_path).valid ||
    !validator.validateDocument(source, source.artifact_path).valid ||
    derived.some((envelope) => !validator.validateDocument(envelope, envelope.artifact_path).valid)
  ) {
    throw new StoreError(
      "report.terminal_operation_invalid",
      "terminal report operation identity or deterministic projection drifted",
    );
  }
  assertDerivedConsistencyPassed(derived);
  return operation;
}

async function assertPreparedOutputsCompatibleLocked(
  runRoot: string,
  operation: PreparedTerminalReportOperation,
): Promise<void> {
  for (const output of operation.materialized_outputs) {
    if (sha256Bytes(output.bytes) !== output.content_hash) {
      throw new StoreError("report.terminal_operation_invalid", "prepared report bytes changed");
    }
    try {
      const existing = await readFile(await resolveRunPath(runRoot, output.target_path), "utf8");
      if (existing !== output.bytes) {
        throw new StoreError(
          "report.materialized_conflict",
          "materialized report bytes differ from the terminal operation",
          { targetPath: output.target_path },
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}

export async function completePreparedTerminalReportLocked(
  runRoot: string,
  operation: PreparedTerminalReportOperation,
  artifacts: ArtifactStore,
  validator: ArtifactValidator,
  faultAt?: ReportFaultBoundary,
): Promise<BuildReportResult> {
  validatePreparedTerminalReportOperation(operation, operation.run_id, validator);
  await assertReportBuildCompatibleLocked(
    runRoot,
    operation.source_envelope,
    operation.derived_envelopes,
  );
  await assertPreparedOutputsCompatibleLocked(runRoot, operation);
  const publication = await artifacts.publishPrevalidatedTerminalReportBundleLocked(
    runRoot,
    {
      runId: operation.run_id,
      envelopes: [operation.source_envelope, ...operation.derived_envelopes],
    },
    (envelope) => {
      const boundary =
        envelope.artifact_type === "startup_opportunity.terminal_report_source.v1"
          ? "after_report_sidecar"
          : envelope.artifact_type === "startup_opportunity.decision_brief.terminal.current"
            ? "after_brief_sidecar"
            : envelope.artifact_type === "startup_opportunity.terminal_report_view.v1"
              ? "after_view_sidecar"
              : "after_consistency_sidecar";
      if (faultAt === boundary) {
        throw new StoreError("fault.injected", `fault injected at ${boundary}`);
      }
    },
  );
  const bySourcePath = new Map(
    [operation.source_envelope, ...operation.derived_envelopes].map((envelope) => [
      envelope.artifact_path,
      envelope,
    ]),
  );
  for (const output of operation.materialized_outputs) {
    const envelope = bySourcePath.get(output.source_artifact_path);
    if (envelope === undefined) {
      throw new StoreError(
        "report.terminal_operation_invalid",
        "materialized output source is missing",
      );
    }
    await materializeLocked(runRoot, envelope, undefined, output.target_path);
    const fault =
      output.target_path === "report.json"
        ? "after_report_materialization"
        : output.target_path === "decision-brief.md"
          ? "after_brief_materialization"
          : output.target_path === "report.md"
            ? "after_view_materialization"
            : "after_appendix_materialization";
    if (faultAt === fault)
      throw new StoreError("fault.injected", `fault injected after ${output.target_path}`);
  }
  return {
    schemaVersion: "startup_opportunity.build_report_result.v1",
    runId: operation.run_id,
    status: publication.status,
    formalArtifactPaths: [
      operation.source_envelope.artifact_path,
      ...operation.derived_envelopes.map((entry) => entry.artifact_path),
    ],
    materializedPaths: operation.materialized_outputs.map((entry) => entry.target_path),
    consistencyEvaluationRef: operation.derived_envelopes[2]?.artifact_path ?? "",
  };
}

export async function preparedTerminalReportIsDurableLocked(
  runRoot: string,
  operation: PreparedTerminalReportOperation,
  artifacts: ArtifactStore,
): Promise<boolean> {
  for (const expected of [operation.source_envelope, ...operation.derived_envelopes]) {
    let stored: unknown;
    try {
      stored = JSON.parse(
        await readFile(await resolveRunPath(runRoot, expected.artifact_path), "utf8"),
      ) as unknown;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
    if (canonicalJson(stored) !== canonicalJson(expected)) {
      throw new StoreError(
        "report.terminal_operation_conflict",
        "stored terminal report Artifact differs from its immutable operation",
        { artifactPath: expected.artifact_path },
      );
    }
    await artifacts.validateStoredEnvelope(runRoot, operation.run_id, expected);
  }
  for (const output of operation.materialized_outputs) {
    let bytes: string;
    try {
      bytes = await readFile(await resolveRunPath(runRoot, output.target_path), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
    if (bytes !== output.bytes || sha256Bytes(bytes) !== output.content_hash) {
      throw new StoreError(
        "report.terminal_operation_conflict",
        "materialized terminal report differs from its immutable operation",
        { targetPath: output.target_path },
      );
    }
  }
  return true;
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function validateReceipt(value: unknown, runId: string): ReportMaterializationReceipt {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "operation_key",
      "run_id",
      "source_artifact_path",
      "source_content_hash",
      "target_path",
      "materialized_content_hash",
    ]) ||
    value.schema_version !== "startup_opportunity.report_materialization_operation.v1" ||
    !isSha256(value.operation_key) ||
    value.run_id !== runId ||
    typeof value.source_artifact_path !== "string" ||
    !isSha256(value.source_content_hash) ||
    (value.target_path !== "report.json" &&
      value.target_path !== "decision-brief.md" &&
      value.target_path !== "report.md" &&
      value.target_path !== "audit-appendix.md") ||
    !isSha256(value.materialized_content_hash)
  ) {
    throw new StoreError(
      "report.recovery_invalid_operation",
      "report materialization receipt is invalid",
    );
  }
  return value as unknown as ReportMaterializationReceipt;
}

function materializationIdentity(
  envelope: FormalArtifactEnvelope,
  targetPath: ReportMaterializationReceipt["target_path"],
  bytes: string,
): ReportMaterializationReceipt {
  const materializedContentHash = sha256Bytes(bytes);
  const stableOperationKey = operationKey("materialize_report_output", {
    run_id: envelope.run_id,
    source_artifact_path: envelope.artifact_path,
    source_content_hash: envelope.content_hash,
    target_path: targetPath,
    materialized_content_hash: materializedContentHash,
  });
  return {
    schema_version: "startup_opportunity.report_materialization_operation.v1",
    operation_key: stableOperationKey,
    run_id: envelope.run_id,
    source_artifact_path: envelope.artifact_path,
    source_content_hash: envelope.content_hash,
    target_path: targetPath,
    materialized_content_hash: materializedContentHash,
  };
}

async function materializeLocked(
  runRoot: string,
  envelope: FormalArtifactEnvelope,
  faultAt?: MaterializationFaultBoundary,
  onlyTarget?: ReportMaterializationReceipt["target_path"],
): Promise<readonly ReportMaterializationResult[]> {
  const outputs = materializedOutputs(envelope).filter(
    (output) => onlyTarget === undefined || output.targetPath === onlyTarget,
  );
  const results: ReportMaterializationResult[] = [];
  for (const materialized of outputs) {
    if (
      (materialized.targetPath === "audit-appendix.md"
        ? envelope.document.audit_appendix_path
        : envelope.document.materialized_path) !== materialized.targetPath
    ) {
      throw new StoreError(
        "report.materialized_path_mismatch",
        "report sidecar targets another view path",
        {
          artifactPath: envelope.artifact_path,
        },
      );
    }
    const receipt = materializationIdentity(envelope, materialized.targetPath, materialized.bytes);
    const operationHex = sha256Hex(receipt.operation_key);
    const receiptPath = `.store/operations/report-${operationHex}.json`;
    const receiptFile = await resolveRunPath(runRoot, receiptPath, { createParents: true });
    let receiptExists = false;
    try {
      const existing = validateReceipt(
        JSON.parse(await readFile(receiptFile, "utf8")) as unknown,
        envelope.run_id,
      );
      receiptExists = true;
      if (canonicalJson(existing) !== canonicalJson(receipt)) {
        throw new StoreError(
          "report.operation_conflict",
          "report materialization receipt drifted",
          {
            receiptPath,
          },
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
    const targetFile = await resolveRunPath(runRoot, materialized.targetPath, {
      createParents: true,
    });
    try {
      const existing = await readFile(targetFile, "utf8");
      if (existing !== materialized.bytes) {
        throw new StoreError(
          "report.materialized_conflict",
          "materialized report bytes differ from sidecar",
          {
            targetPath: materialized.targetPath,
          },
        );
      }
      if (!receiptExists) {
        const receiptTemp = `.store/temp/report-${operationHex}.receipt.tmp`;
        await writeSyncedTemp(runRoot, receiptTemp, `${canonicalJson(receipt)}\n`);
        await publishTemp(runRoot, receiptTemp, receiptPath);
      }
      results.push({
        targetPath: materialized.targetPath,
        status: "idempotent_replay",
        contentHash: receipt.materialized_content_hash,
      });
      continue;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
    if (!receiptExists) {
      const receiptTemp = `.store/temp/report-${operationHex}.receipt.tmp`;
      await writeSyncedTemp(runRoot, receiptTemp, `${canonicalJson(receipt)}\n`);
      await publishTemp(runRoot, receiptTemp, receiptPath);
    }
    if (faultAt === "after_intent") {
      throw new StoreError("fault.injected", "fault injected after report materialization intent");
    }
    const temporaryPath = `.store/temp/report-${operationHex}.publish.tmp`;
    await writeSyncedTemp(runRoot, temporaryPath, materialized.bytes);
    if (faultAt === "after_temp_write") {
      throw new StoreError(
        "fault.injected",
        "fault injected after report materialization temp write",
      );
    }
    await publishTemp(runRoot, temporaryPath, materialized.targetPath);
    if (faultAt === "after_publish") {
      throw new StoreError("fault.injected", "fault injected after report materialization publish");
    }
    results.push({
      targetPath: materialized.targetPath,
      status: "materialized",
      contentHash: receipt.materialized_content_hash,
    });
  }
  return results;
}

async function reportingEnvelopes(runRoot: string): Promise<readonly FormalArtifactEnvelope[]> {
  const directory = await resolveRunPath(runRoot, "artifacts/reporting", { createParents: true });
  const envelopes: FormalArtifactEnvelope[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const value = JSON.parse(await readFile(path.join(directory, entry.name), "utf8")) as unknown;
    if (!isRecord(value)) {
      throw new StoreError("report.sidecar_invalid", "reporting sidecar is not an envelope", {
        path: `artifacts/reporting/${entry.name}`,
      });
    }
    envelopes.push(value as FormalArtifactEnvelope);
  }
  return envelopes;
}

export async function recoverReportOperationsLocked(
  runRoot: string,
  runId: string,
  _validator: ArtifactValidator,
  artifacts: ArtifactStore,
): Promise<ReportRecoveryResult> {
  validateRunId(runId);
  const formalRecovered: string[] = [];
  const materializedRecovered: string[] = [];
  let envelopes = await reportingEnvelopes(runRoot);
  const reports = envelopes.filter(
    (envelope) =>
      envelope.artifact_type === "startup_opportunity.concept_evidence_report.v1" ||
      envelope.artifact_type === "startup_opportunity.report.v1" ||
      envelope.artifact_type === "startup_opportunity.terminal_report_source.v1",
  );
  for (const report of reports) {
    await artifacts.validateStoredEnvelope(runRoot, runId, report);
    const derived = deriveReportEnvelopes(report);
    assertDerivedConsistencyPassed(derived);
    const reportMaterializations = await materializeLocked(runRoot, report);
    for (const materialization of reportMaterializations) {
      if (materialization.status === "materialized") {
        materializedRecovered.push(materialization.targetPath);
      }
    }
    const missingDerivedPaths = new Set<string>();
    for (const derivedEnvelope of derived) {
      const existing = envelopes.find(
        (candidate) => candidate.artifact_path === derivedEnvelope.artifact_path,
      );
      if (existing !== undefined && canonicalJson(existing) !== canonicalJson(derivedEnvelope)) {
        throw new StoreError("report.sidecar_conflict", "derived report sidecar bytes drifted", {
          artifactPath: derivedEnvelope.artifact_path,
        });
      }
      if (existing === undefined) {
        missingDerivedPaths.add(derivedEnvelope.artifact_path);
      }
    }
    const publication =
      missingDerivedPaths.size > 0
        ? await artifacts.publishBundleLocked(runRoot, { runId, envelopes: derived })
        : null;
    for (const derivedEnvelope of derived) {
      const result = publication?.artifacts.find(
        (candidate) => candidate.artifactPath === derivedEnvelope.artifact_path,
      );
      if (publication !== null && result === undefined) {
        throw new StoreError(
          "report.recovery_invalid_operation",
          "derived report publication omitted a bundle result",
          { artifactPath: derivedEnvelope.artifact_path },
        );
      }
      if (
        result?.status === "published" &&
        missingDerivedPaths.has(derivedEnvelope.artifact_path)
      ) {
        formalRecovered.push(derivedEnvelope.artifact_path);
      }
      const derivedMaterializations = await materializeLocked(runRoot, derivedEnvelope);
      for (const materialization of derivedMaterializations) {
        if (materialization.status === "materialized") {
          materializedRecovered.push(materialization.targetPath);
        }
      }
    }
    envelopes = await reportingEnvelopes(runRoot);
  }
  for (const envelope of envelopes) {
    await artifacts.validateStoredEnvelope(runRoot, runId, envelope);
  }
  const tempDirectory = await resolveRunPath(runRoot, ".store/temp", { createParents: true });
  const removedTemps: string[] = [];
  for (const entry of (await readdir(tempDirectory)).sort()) {
    if (entry.startsWith("report-")) {
      await removeTemp(runRoot, `.store/temp/${entry}`);
      removedTemps.push(`.store/temp/${entry}`);
    }
  }
  return {
    recoveredFormalArtifactPaths: formalRecovered.sort(),
    recoveredMaterializedPaths: materializedRecovered.sort(),
    removedTemporaryPaths: removedTemps.sort(),
  };
}

export class ReportRuntime {
  private readonly store: RunStore;
  private readonly artifacts: ArtifactStore;
  private readonly evidence: EvidenceStore;

  constructor(
    private readonly runsRoot: string,
    private readonly validator: ArtifactValidator,
  ) {
    this.store = new RunStore(runsRoot, validator);
    this.artifacts = new ArtifactStore(runsRoot, validator);
    this.evidence = new EvidenceStore(runsRoot);
  }

  async build(input: BuildReportInput): Promise<BuildReportResult> {
    if (input.reportEnvelope.artifact_type === "startup_opportunity.terminal_report_source.v1") {
      throw new StoreError(
        "report.terminal_dedicated_entry_required",
        "terminal report sources must be committed by the atomic terminal Plan closeout entry",
        {
          artifact: input.reportEnvelope.artifact_path,
          dedicatedEntry: "apply-plan-revision",
        },
      );
    }
    const runRoot = await openRunDirectory(this.runsRoot, input.reportEnvelope.run_id);
    return withReportLock(runRoot, async () => {
      await withRunLock(runRoot, () =>
        assertNoOtherFinalReportLocked(runRoot, input.reportEnvelope),
      );
      const source = await this.compileCommercialReportFields(input.reportEnvelope);
      const derived = deriveReportEnvelopes(source);
      assertDerivedConsistencyPassed(derived);
      const validation = this.validator.validateDocument(source, source.artifact_path);
      if (!validation.valid) {
        throw new StoreError("report.source_invalid", "report source envelope is invalid", {
          errors: validation.errors,
        });
      }
      await withRunLock(runRoot, () => assertReportBuildCompatibleLocked(runRoot, source, derived));
      const publicationResults: PublishArtifactResult[] = [];
      publicationResults.push(
        await this.store.publishArtifact({ runId: source.run_id, envelope: source }),
      );
      if (input.faultAt === "after_report_sidecar") {
        throw new StoreError("fault.injected", "fault injected after report sidecar");
      }
      await this.materialize(source);
      if (input.faultAt === "after_report_materialization") {
        throw new StoreError("fault.injected", "fault injected after report materialization");
      }
      publicationResults.push(
        await this.store.publishArtifact({
          runId: source.run_id,
          envelope: derived[0] as FormalArtifactEnvelope,
        }),
      );
      if (input.faultAt === "after_brief_sidecar") {
        throw new StoreError("fault.injected", "fault injected after decision brief sidecar");
      }
      await this.materialize(derived[0] as FormalArtifactEnvelope);
      if (input.faultAt === "after_brief_materialization") {
        throw new StoreError(
          "fault.injected",
          "fault injected after decision brief materialization",
        );
      }
      publicationResults.push(
        await this.store.publishArtifact({
          runId: source.run_id,
          envelope: derived[1] as FormalArtifactEnvelope,
        }),
      );
      if (input.faultAt === "after_view_sidecar") {
        throw new StoreError("fault.injected", "fault injected after full report sidecar");
      }
      await this.materializeTarget(derived[1] as FormalArtifactEnvelope, "report.md");
      if (input.faultAt === "after_view_materialization") {
        throw new StoreError("fault.injected", "fault injected after full report materialization");
      }
      await this.materializeTarget(derived[1] as FormalArtifactEnvelope, "audit-appendix.md");
      if (input.faultAt === "after_appendix_materialization") {
        throw new StoreError(
          "fault.injected",
          "fault injected after audit appendix materialization",
        );
      }
      publicationResults.push(
        await this.store.publishArtifact({
          runId: source.run_id,
          envelope: derived[2] as FormalArtifactEnvelope,
        }),
      );
      if (input.faultAt === "after_consistency_sidecar") {
        throw new StoreError("fault.injected", "fault injected after consistency sidecar");
      }
      return {
        schemaVersion: "startup_opportunity.build_report_result.v1",
        runId: source.run_id,
        status: publicationResults.every((entry) => entry.status === "idempotent_replay")
          ? "idempotent_replay"
          : "published",
        formalArtifactPaths: [source.artifact_path, ...derived.map((entry) => entry.artifact_path)],
        materializedPaths: ["report.json", "decision-brief.md", "report.md", "audit-appendix.md"],
        consistencyEvaluationRef: (derived[2] as FormalArtifactEnvelope).artifact_path,
      };
    });
  }

  async prepareTerminalLocked(
    runRoot: string,
    input: {
      readonly reportEnvelope: FormalArtifactEnvelope;
      readonly prospectiveManifest: RunManifest;
      readonly supportingEnvelopes: readonly FormalArtifactEnvelope[];
    },
  ): Promise<PreparedTerminalReportOperation> {
    if (input.reportEnvelope.artifact_type !== "startup_opportunity.terminal_report_source.v1") {
      throw new StoreError(
        "report.source_invalid",
        "terminal closeout requires a terminal report source",
      );
    }
    await assertNoOtherFinalReportLocked(runRoot, input.reportEnvelope);
    const source = await this.compileCommercialReportFields(
      input.reportEnvelope,
      runRoot,
      input.prospectiveManifest,
      input.supportingEnvelopes,
    );
    const derived = deriveReportEnvelopes(source);
    assertDerivedConsistencyPassed(derived);
    const prospectivePaths = new Set(
      [source, ...derived].map((envelope) => envelope.artifact_path),
    );
    const context = await this.store.buildValidationContextLocked(
      runRoot,
      source.run_id,
      {
        schema_version: "startup_opportunity.document_bundle.current",
        documents: [source, ...derived]
          .map((envelope) => ({
            path: envelope.artifact_path,
            document: envelope,
          }))
          .concat(
            input.supportingEnvelopes.map((envelope) => ({
              path: envelope.artifact_path,
              document: envelope,
            })),
          ),
        exact_records: [],
      },
      true,
      prospectivePaths,
      input.prospectiveManifest,
    );
    const validation = this.validator.validateDocumentBundle(
      context.bundle,
      context.referenceContext,
    );
    if (!validation.valid) {
      throw new StoreError(
        "report.source_invalid",
        "terminal report closeout fails prospective semantic validation",
        {
          errors: [
            ...validation.bundleErrors,
            ...validation.documents.flatMap((entry) => entry.errors),
            ...validation.referenceErrors,
          ],
        },
      );
    }
    await assertReportBuildCompatibleLocked(runRoot, source, derived);
    return preparedTerminalReportOperation(input.reportEnvelope, source, derived);
  }

  private async compileCommercialReportFields(
    source: FormalArtifactEnvelope,
    runRoot?: string,
    prospectiveManifest?: RunManifest,
    supportingEnvelopes: readonly FormalArtifactEnvelope[] = [],
  ): Promise<FormalArtifactEnvelope> {
    if (
      ![
        "startup_opportunity.report.v1",
        "startup_opportunity.concept_evidence_report.v1",
        "startup_opportunity.terminal_report_source.v1",
      ].includes(source.artifact_type)
    ) {
      return source;
    }
    const buildContext = (candidate: FormalArtifactEnvelope) =>
      runRoot === undefined
        ? this.store.buildValidationContext(
            source.run_id,
            {
              schema_version: "startup_opportunity.document_bundle.current",
              documents: [
                { path: source.artifact_path, document: candidate },
                ...supportingEnvelopes.map((envelope) => ({
                  path: envelope.artifact_path,
                  document: envelope,
                })),
              ],
              exact_records: [],
            },
            {
              includeAllFormalArtifacts: true,
              prospectiveArtifactPaths: [source.artifact_path],
            },
          )
        : this.store.buildValidationContextLocked(
            runRoot,
            source.run_id,
            {
              schema_version: "startup_opportunity.document_bundle.current",
              documents: [
                { path: source.artifact_path, document: candidate },
                ...supportingEnvelopes.map((envelope) => ({
                  path: envelope.artifact_path,
                  document: envelope,
                })),
              ],
              exact_records: [],
            },
            true,
            new Set([
              source.artifact_path,
              ...supportingEnvelopes.map((envelope) => envelope.artifact_path),
            ]),
            prospectiveManifest,
          );
    const context = await buildContext(source).catch((error: unknown) => {
      if (error instanceof StoreError && error.code === "validation_context.authority_conflict") {
        throw new StoreError(
          "report.final_revision_conflict",
          "a different immutable report revision already exists",
          error.details,
        );
      }
      throw error;
    });
    const formalDocuments = context.bundle.documents.flatMap((entry) => {
      if (
        entry.document.schema_version !== "startup_opportunity.artifact_envelope.current" ||
        !isRecord(entry.document.document)
      ) {
        return [];
      }
      return [{ path: entry.path, document: entry.document.document }];
    });
    const envelopesByPath = new Map<string, FormalArtifactEnvelope>(
      context.bundle.documents.flatMap((entry) =>
        entry.document.schema_version === "startup_opportunity.artifact_envelope.current" &&
        typeof entry.document.content_hash === "string" &&
        isRecord(entry.document.document)
          ? [[entry.path, entry.document as FormalArtifactEnvelope] as const]
          : [],
      ),
    );
    const documentsByPath = new Map(formalDocuments.map((entry) => [entry.path, entry.document]));
    const tasks = formalDocuments.filter((entry) =>
      [
        "startup_opportunity.research_task.assessment.current",
        "startup_opportunity.research_task.discovery_candidate.current",
        "startup_opportunity.research_task.discovery_evaluation.current",
      ].includes(String(entry.document.schema_version)),
    );
    const audits = context.bundle.documents.flatMap((entry) => {
      if (
        entry.document.schema_version !== "startup_opportunity.artifact_envelope.current" ||
        entry.document.artifact_type !== "startup_opportunity.commercial_research_audit.current" ||
        !isRecord(entry.document.document) ||
        typeof entry.document.content_hash !== "string"
      ) {
        return [];
      }
      return [
        {
          path: entry.path,
          contentHash: entry.document.content_hash,
          document: entry.document.document,
        },
      ];
    });
    const sourceDocument = structuredClone(source.document);
    const provenanceDocuments = context.bundle.documents.flatMap((entry) => {
      if (
        entry.document.schema_version !== "startup_opportunity.artifact_envelope.current" ||
        !isRecord(entry.document.document)
      ) {
        return [];
      }
      return [
        {
          path: entry.path,
          schemaVersion: String(entry.document.artifact_type),
          document: entry.document.document,
          envelope: entry.document,
        },
      ];
    });
    const evidenceRecords =
      runRoot === undefined
        ? await this.evidence.listRecords(source.run_id)
        : await this.evidence.listRecordsLocked(runRoot, source.run_id);
    const exactRecords = new Map(context.referenceContext.exactJsonlRecords ?? []);
    for (const record of evidenceRecords) {
      exactRecords.set(
        `evidence/manifest.jsonl#${record.evidence_id}`,
        record as Record<string, unknown>,
      );
    }
    const manifestEntry = context.bundle.documents.find((entry) => entry.path === "manifest.json");
    const manifest = manifestEntry?.document;
    if (manifest === undefined) {
      throw new StoreError(
        "report.research_language_authority_invalid",
        "report compilation requires the current Manifest",
      );
    }
    const researchLanguage = deriveConfirmedResearchLanguage(manifest, exactRecords);
    if (
      sourceDocument.research_language !== undefined &&
      sourceDocument.research_language !== researchLanguage
    ) {
      throw new StoreError(
        "report.research_language_authority_invalid",
        "caller-supplied report language drifts from the exact confirmed Scope",
      );
    }
    const researchProvenance = deriveResearchProvenance(
      source.run_id,
      provenanceDocuments,
      exactRecords,
      source.artifact_path,
    );
    if (
      source.artifact_type === "startup_opportunity.terminal_report_source.v1" &&
      sourceDocument.research_provenance !== undefined &&
      canonicalJson(sourceDocument.research_provenance) !== canonicalJson(researchProvenance)
    ) {
      throw new StoreError(
        "report.source_invalid",
        "caller-supplied research provenance drifts from exact current-Run handoff and Evidence records",
      );
    }
    const decisionSnapshot =
      source.artifact_type === "startup_opportunity.terminal_report_source.v1" &&
      typeof sourceDocument.decision_subject_snapshot_ref === "string"
        ? documentsByPath.get(sourceDocument.decision_subject_snapshot_ref)
        : undefined;
    const currentDecisionSubjectIds = records(decisionSnapshot?.subjects)
      .filter(
        (subject) => subject.lifecycle_status === "current" && subject.reporting_role === "final",
      )
      .map((subject) => String(subject.subject_id))
      .sort();
    const synthesisBindings = records(sourceDocument.decision_subject_synthesis_hashes);
    const subjectSyntheses = synthesisBindings.map((binding) => {
      const synthesis =
        typeof binding.ref === "string" ? envelopesByPath.get(binding.ref) : undefined;
      if (
        synthesis?.artifact_type !== "startup_opportunity.decision_subject_synthesis.current" ||
        synthesis.content_hash !== binding.content_hash ||
        !isRecord(synthesis.document.direction)
      ) {
        throw new StoreError(
          "report.source_invalid",
          "terminal report references an invalid decision subject synthesis",
          { binding },
        );
      }
      return synthesis;
    });
    const synthesizedDirections = subjectSyntheses
      .map((synthesis) => ({
        direction_id: synthesis.document.subject_id,
        subject_ref: synthesis.document.subject_ref,
        subject_content_hash: synthesis.document.subject_content_hash,
        synthesis_ref: synthesis.artifact_path,
        synthesis_content_hash: synthesis.content_hash,
        ...structuredClone(synthesis.document.direction as Record<string, unknown>),
      }))
      .sort((left, right) => String(left.direction_id).localeCompare(String(right.direction_id)));
    const synthesizedValidationPlan = subjectSyntheses
      .flatMap((synthesis) =>
        records(synthesis.document.validation_steps).map((step) => ({
          order: step.order,
          direction_id: synthesis.document.subject_id,
          subject_ref: synthesis.document.subject_ref,
          subject_content_hash: synthesis.document.subject_content_hash,
          synthesis_ref: synthesis.artifact_path,
          synthesis_content_hash: synthesis.content_hash,
          ...structuredClone(step),
        })),
      )
      .sort((left, right) => Number(left.order) - Number(right.order));
    const projectedSubjectIds =
      source.artifact_type === "startup_opportunity.terminal_report_source.v1"
        ? currentDecisionSubjectIds
        : deriveNonTerminalReportSubjectIds(source.artifact_type, sourceDocument, documentsByPath);
    const reportSubjectLabels = deriveReportSubjectLabels(
      projectedSubjectIds,
      documentsByPath,
      synthesizedDirections,
      researchLanguage,
    );
    if (
      source.artifact_type === "startup_opportunity.terminal_report_source.v1" &&
      ((records(sourceDocument.directions).length > 0 &&
        canonicalJson(records(sourceDocument.directions)) !==
          canonicalJson(synthesizedDirections)) ||
        (records(sourceDocument.ordered_validation_plan).length > 0 &&
          canonicalJson(records(sourceDocument.ordered_validation_plan)) !==
            canonicalJson(synthesizedValidationPlan)))
    ) {
      throw new StoreError(
        "report.source_invalid",
        "caller-supplied Direction or validation-plan text drifts from the exact current-subject synthesis",
      );
    }
    const fullProjection = projectCommercialAuditTables(audits, tasks, documentsByPath);
    const projection = projectCommercialAuditTables(
      audits,
      tasks,
      documentsByPath,
      projectedSubjectIds,
    );
    const currentAuditRefs = new Set(
      records(projection.commercial_subject_aggregates).flatMap((aggregate) =>
        strings(aggregate.audit_refs),
      ),
    );
    const terminalProjection =
      source.artifact_type === "startup_opportunity.terminal_report_source.v1";
    const gateAudits = terminalProjection
      ? audits.filter((audit) => currentAuditRefs.has(audit.path))
      : audits;
    if (
      source.artifact_type === "startup_opportunity.report.v1" ||
      source.artifact_type === "startup_opportunity.concept_evidence_report.v1"
    ) {
      const metadata = isRecord(sourceDocument.report_metadata)
        ? sourceDocument.report_metadata
        : {};
      const inputHashes = new Map(
        records(metadata.input_artifact_hashes)
          .filter(
            (binding) =>
              typeof binding.ref === "string" &&
              !binding.ref.startsWith("artifacts/research-audits/"),
          )
          .map((binding) => [String(binding.ref), binding]),
      );
      for (const audit of audits) {
        inputHashes.set(audit.path, { ref: audit.path, content_hash: audit.contentHash });
      }
      sourceDocument.report_metadata = {
        ...metadata,
        input_artifact_hashes: [...inputHashes.values()].sort((left, right) =>
          String(left.ref).localeCompare(String(right.ref)),
        ),
      };
    }
    const reportSemanticAuthority = {
      ...sourceDocument,
      research_language: researchLanguage,
      ...projection,
      ...(terminalProjection
        ? {
            current_decision_subject_ids: currentDecisionSubjectIds,
            research_provenance: researchProvenance,
            directions: synthesizedDirections,
            ordered_validation_plan: synthesizedValidationPlan,
          }
        : {}),
    };
    const dispositions = deriveReportDispositions(
      source.artifact_type,
      reportSemanticAuthority,
      envelopesByPath,
    );
    const reportCitations = deriveReportCitations(formalDocuments, exactRecords, {
      ...reportSemanticAuthority,
      report_evidence_dispositions: dispositions.reportEvidenceDispositions,
      report_source_dispositions: dispositions.reportSourceDispositions,
    });
    for (const [field, expected] of [
      ["report_subject_labels", reportSubjectLabels],
      ["report_evidence_dispositions", dispositions.reportEvidenceDispositions],
      ["report_source_dispositions", dispositions.reportSourceDispositions],
      ["report_citations", reportCitations],
    ] as const) {
      const supplied = sourceDocument[field];
      if (supplied !== undefined && canonicalJson(supplied) !== canonicalJson(expected)) {
        throw new StoreError(
          "report.mechanical_projection_drift",
          "caller-supplied report mechanics drift from exact current-Run authorities",
          { field },
        );
      }
    }
    const canonicalSources = canonicalizeReadableSources(
      records(sourceDocument.sources),
      reportCitations,
    );
    if (terminalProjection) {
      const suppliedSources = new Map(
        records(sourceDocument.sources).map((entry) => [String(entry.evidence_ref), entry]),
      );
      const authorityDrift = canonicalSources.sources.flatMap((entry) => {
        const supplied = suppliedSources.get(String(entry.evidence_ref));
        if (supplied === undefined) return [String(entry.evidence_ref)];
        const exact =
          entry.source_access === "public"
            ? supplied.url === entry.url && supplied.canonical_uri === undefined
            : supplied.url === undefined && supplied.canonical_uri === entry.canonical_uri;
        return exact ? [] : [String(entry.evidence_ref)];
      });
      if (authorityDrift.length > 0) {
        throw new StoreError(
          "report.source_authority_drift",
          "caller-supplied report source locations drift from canonical Evidence authority",
          { evidenceRefs: authorityDrift.sort() },
        );
      }
    }
    if (terminalProjection && canonicalSources.missingEvidenceRefs.length > 0) {
      throw new StoreError(
        "report.source_invalid",
        "each readable source must close to an exact typed Evidence reference in the final report model",
        { evidenceRefs: canonicalSources.missingEvidenceRefs },
      );
    }
    const projectedAuditRefs = commercialProjectionRefs(
      (source.artifact_type === "startup_opportunity.terminal_report_source.v1"
        ? fullProjection
        : projection) as unknown as Record<string, unknown>,
    );
    const provisionalDocument: Record<string, unknown> = {
      ...sourceDocument,
      research_language: researchLanguage,
      ...projection,
      full_commercial_projection: fullProjection,
      report_evidence_dispositions: dispositions.reportEvidenceDispositions,
      report_source_dispositions: dispositions.reportSourceDispositions,
      ...(source.artifact_type === "startup_opportunity.terminal_report_source.v1"
        ? { sources: canonicalSources.sources }
        : {}),
      report_citations: reportCitations,
      report_subject_labels: reportSubjectLabels,
      ...(source.artifact_type === "startup_opportunity.terminal_report_source.v1"
        ? {
            current_decision_subject_ids: currentDecisionSubjectIds,
            research_provenance: researchProvenance,
            directions: synthesizedDirections,
            ordered_validation_plan: synthesizedValidationPlan,
            audit_refs: [
              ...new Set([...strings(sourceDocument.audit_refs), ...projectedAuditRefs]),
            ].sort(),
          }
        : {}),
      gate_warnings: gateAudits.flatMap((audit) => records(audit.document.compiler_warnings)),
    };
    provisionalDocument.report_statistics = deriveReportStatistics(provisionalDocument);
    const provisional = {
      ...source,
      input_refs: [
        ...new Set([
          ...source.input_refs.filter((ref) => !ref.startsWith("artifacts/research-audits/")),
          ...strings(researchProvenance.causal_handoff_refs),
          ...fullProjection.commercial_research_audit_refs,
          ...reportCitations.map((citation) => citation.evidence_ref),
          ...dispositions.reportEvidenceDispositions.map((entry) => String(entry.evidence_ref)),
          ...synthesisBindings.flatMap((binding) =>
            typeof binding.ref === "string" ? [binding.ref] : [],
          ),
        ]),
      ].sort(),
      content_hash: canonicalContentHash(provisionalDocument),
      document: provisionalDocument,
    };
    const provisionalContext = await buildContext(provisional);
    const provisionalValidation = this.validator.validateDocumentBundle(
      provisionalContext.bundle,
      provisionalContext.referenceContext,
    );
    const provisionalIssues = [
      ...provisionalValidation.bundleErrors,
      ...provisionalValidation.documents.flatMap((entry) => entry.errors),
      ...provisionalValidation.referenceErrors,
    ];
    const auditPaths = new Set(audits.map((audit) => audit.path));
    const reportPaths = new Set(
      formalDocuments
        .filter((entry) =>
          [
            "startup_opportunity.report.v1",
            "startup_opportunity.concept_evidence_report.v1",
            "startup_opportunity.terminal_report_source.v1",
          ].includes(String(entry.document.schema_version)),
        )
        .map((entry) => entry.path),
    );
    const relevantProvisionalIssues = terminalProjection
      ? provisionalIssues.filter((entry) => {
          const artifactPath = entry.instancePath.split("#", 1)[0] ?? "";
          if (auditPaths.has(artifactPath)) return currentAuditRefs.has(artifactPath);
          if (reportPaths.has(artifactPath)) return artifactPath === source.artifact_path;
          return true;
        })
      : provisionalIssues;
    const gateWarnings = [
      ...projectGateWarnings(relevantProvisionalIssues),
      ...gateAudits.flatMap((audit) => records(audit.document.compiler_warnings)),
    ].sort((left, right) =>
      `${String(left.code)}:${String(left.message)}`.localeCompare(
        `${String(right.code)}:${String(right.message)}`,
      ),
    );
    const document = { ...provisionalDocument, gate_warnings: gateWarnings };
    const compiled = {
      ...provisional,
      content_hash: canonicalContentHash(document),
      document,
    };
    assertDerivedConsistencyPassed(deriveReportEnvelopes(compiled));
    const finalContext = await buildContext(compiled);
    const finalValidation = this.validator.validateDocumentBundle(
      finalContext.bundle,
      finalContext.referenceContext,
    );
    if (!finalValidation.valid) {
      throw new StoreError(
        "report.source_invalid",
        "compiled report fails final current-Run semantic validation",
        {
          errors: [
            ...finalValidation.bundleErrors,
            ...finalValidation.documents.flatMap((entry) => entry.errors),
            ...finalValidation.referenceErrors,
          ],
        },
      );
    }
    return compiled;
  }

  async materialize(
    envelope: FormalArtifactEnvelope,
    faultAt?: MaterializationFaultBoundary,
  ): Promise<readonly ReportMaterializationResult[]> {
    const runRoot = await openRunDirectory(this.runsRoot, envelope.run_id);
    return withRunLock(runRoot, async () => {
      await this.artifacts.validateStoredEnvelope(runRoot, envelope.run_id, envelope);
      return materializeLocked(runRoot, envelope, faultAt);
    });
  }

  private async materializeTarget(
    envelope: FormalArtifactEnvelope,
    targetPath: ReportMaterializationReceipt["target_path"],
  ): Promise<readonly ReportMaterializationResult[]> {
    const runRoot = await openRunDirectory(this.runsRoot, envelope.run_id);
    return withRunLock(runRoot, async () => {
      await this.artifacts.validateStoredEnvelope(runRoot, envelope.run_id, envelope);
      return materializeLocked(runRoot, envelope, undefined, targetPath);
    });
  }
}

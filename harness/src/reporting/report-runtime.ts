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
  projectCommercialAuditTables,
  renderCompetitiveSubstituteMatrix,
  renderGateWarnings,
  renderIncumbentResponseRiskTable,
  renderQuantitativeSignalTable,
  renderResearchCoverageGaps,
} from "./commercial-report-tables.js";
import {
  REPORT_SCAN_CONTRACT_VERSION,
  REPORT_SCAN_SURFACES,
  scanDiscoveryReportSurfaces,
} from "./report-consistency.js";
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

export type ReportFaultBoundary =
  | "after_report_sidecar"
  | "after_report_materialization"
  | "after_brief_sidecar"
  | "after_brief_materialization"
  | "after_view_sidecar"
  | "after_view_materialization"
  | "after_consistency_sidecar";

type MaterializationFaultBoundary = "after_intent" | "after_temp_write" | "after_publish";

interface ReportMaterializationReceipt {
  readonly schema_version: "startup_opportunity.report_materialization_operation.v1";
  readonly operation_key: string;
  readonly run_id: string;
  readonly source_artifact_path: string;
  readonly source_content_hash: string;
  readonly target_path: "report.json" | "decision-brief.md" | "report.md";
  readonly materialized_content_hash: string;
}

export interface ReportMaterializationResult {
  readonly targetPath: "report.json" | "decision-brief.md" | "report.md";
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
    readonly target_path: "report.json" | "decision-brief.md" | "report.md";
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

function summaryList(value: unknown): string {
  const summaries = records(value);
  if (summaries.length === 0) {
    return "- None recorded.\n";
  }
  return `${summaries
    .map((entry) => {
      const refs = strings(entry.refs).join(", ");
      return `- ${String(entry.summary)} [${refs}]`;
    })
    .join("\n")}\n`;
}

function renderDecisionBrief(report: Record<string, unknown>): string {
  const context = requiredRecord(report.curated_judgment_context, "curated_judgment_context");
  const belief = requiredRecord(context.belief_update_summary, "belief_update_summary");
  const boundary = requiredRecord(context.external_action_boundary, "external_action_boundary");
  return [
    "# Decision Brief\n",
    "## Decision Question\n",
    `${String(context.decision_question)}\n\n`,
    "## Current Recommendation\n",
    `${String(context.current_recommendation)}\n\n`,
    `Assessment result: ${String(context.assessment_result)}\n\n`,
    `Meaning: ${String(context.recommendation_meaning)}\n\n`,
    "## Decisive Support\n",
    summaryList(context.decisive_support),
    "\n## Decisive Opposition\n",
    summaryList(context.decisive_opposition),
    "\n## Incumbent Absorption And Response Risk\n",
    renderIncumbentResponseRiskTable(report),
    "\n## Alternatives Not Selected\n",
    markdownList(strings(context.alternatives_not_selected)),
    "\n## Critical Unknowns\n",
    markdownList(strings(context.critical_unknowns)),
    "\n## What Would Change the Decision\n",
    markdownList(strings(context.what_would_change_the_decision)),
    "\n## Belief Update\n",
    `Initial belief: ${String(belief.initial_belief)}\n\n`,
    "Evidence that changed belief:\n",
    markdownList(strings(belief.evidence_that_changed_belief)),
    "\nUnchanged assumptions:\n",
    markdownList(strings(belief.unchanged_assumptions)),
    "\nRemaining disagreement:\n",
    markdownList(strings(belief.remaining_disagreement)),
    `\nFinal decision owner: ${String(belief.final_decision_owner)}\n\n`,
    "## Scope and Freshness\n",
    `${String(context.scope_summary)}\n\nValid as of: ${String(context.valid_as_of)}\n\n`,
    "## Limitations\n",
    markdownList(strings(context.limitations)),
    "\n## External Action Boundary\n",
    `Execution owner: ${String(boundary.execution_owner)}\n\n`,
    `Execution supported: ${String(boundary.execution_supported)}\n\n`,
    `Result tracking supported: ${String(boundary.result_tracking_supported)}\n\n`,
    `External validation claimed: ${String(boundary.external_validation_claimed)}\n`,
  ].join("");
}

function renderFullReport(report: Record<string, unknown>): string {
  const context = requiredRecord(report.curated_judgment_context, "curated_judgment_context");
  const sections = requiredRecord(report.report_sections, "report_sections");
  const metadata = requiredRecord(report.report_metadata, "report_metadata");
  const parts = [
    "# Concept Evidence Assessment Report\n",
    `\nAssessment result: ${String(context.assessment_result)}\n`,
    `\nRecommendation: ${String(context.current_recommendation)}\n`,
    `\nMeaning: ${String(context.recommendation_meaning)}\n`,
    `\nValid as of: ${String(context.valid_as_of)}\n`,
    `\nGenerated at: ${String(metadata.generated_at)}\n`,
  ];
  for (const sectionId of REPORT_SECTION_ORDER) {
    if (sectionId === "competition_and_differentiation") {
      parts.push("\n## Quantitative Signals\n");
      parts.push(renderQuantitativeSignalTable(report));
      parts.push("\n## Competitive And Substitute Matrix\n");
      parts.push(renderCompetitiveSubstituteMatrix(report));
      parts.push("\n## Incumbent Absorption And Response Risk\n");
      parts.push(renderIncumbentResponseRiskTable(report));
    }
    if (sectionId === "limitations_and_sources") {
      parts.push("\n## Research Coverage Gaps And Decision Impact\n");
      parts.push(renderResearchCoverageGaps(report));
      parts.push("\n## Gate Warnings And Decision Impact\n");
      parts.push(renderGateWarnings(report));
    }
    parts.push(`\n## ${REPORT_SECTION_TITLES[sectionId]}\n`);
    parts.push(markdownList(strings(sections[sectionId])));
  }
  return parts.join("");
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
  const context = requiredRecord(report.curated_judgment_context, "curated_judgment_context");
  return [
    "# Decision Brief\n\n",
    "## Decision Question\n",
    `${String(context.decision_question)}\n\n`,
    "## Current Recommendation\n",
    `${String(context.current_recommendation)}\n\n`,
    `Decision tier: ${String(context.decision_tier)}\n\n`,
    `Meaning: ${String(context.recommendation_meaning)}\n\n`,
    "## Partial Order\n",
    `${String(context.partial_order_summary)}\n\n`,
    "## Decisive Support\n",
    summaryList(context.decisive_support),
    "\n## Decisive Opposition\n",
    summaryList(context.decisive_opposition),
    "\n## Incumbent Absorption And Response Risk\n",
    renderIncumbentResponseRiskTable(report),
    "\n## Critical Unknowns\n",
    markdownList(strings(context.critical_unknowns)),
    "\n## What Would Change the Decision\n",
    markdownList(strings(context.what_would_change_the_decision)),
    "\n## Limitations\n",
    markdownList(strings(context.limitations)),
  ].join("");
}

function renderDiscoveryFullReport(report: Record<string, unknown>): string {
  const context = requiredRecord(report.curated_judgment_context, "curated_judgment_context");
  const sections = requiredRecord(report.report_sections, "report_sections");
  const metadata = requiredRecord(report.report_metadata, "report_metadata");
  const parts = [
    "# Startup Opportunity Discovery Report\n",
    `\nDecision tier: ${String(context.decision_tier)}\n`,
    `\nRecommendation: ${String(context.current_recommendation)}\n`,
    `\nValid as of: ${String(context.valid_as_of)}\n`,
    `\nGenerated at: ${String(metadata.generated_at)}\n`,
  ];
  for (const sectionId of DISCOVERY_REPORT_SECTION_ORDER) {
    if (sectionId === "top_opportunities") {
      parts.push("\n## Quantitative Signals\n");
      parts.push(renderQuantitativeSignalTable(report));
      parts.push("\n## Competitive And Substitute Matrix\n");
      parts.push(renderCompetitiveSubstituteMatrix(report));
      parts.push("\n## Incumbent Absorption And Response Risk\n");
      parts.push(renderIncumbentResponseRiskTable(report));
    }
    if (sectionId === "traceability_and_sources") {
      parts.push("\n## Research Coverage Gaps And Decision Impact\n");
      parts.push(renderResearchCoverageGaps(report));
      parts.push("\n## Gate Warnings And Decision Impact\n");
      parts.push(renderGateWarnings(report));
    }
    const title = sectionId
      .split("_")
      .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
      .join(" ");
    parts.push(`\n## ${title}\n`);
    parts.push(markdownList(strings(sections[sectionId])));
  }
  return parts.join("");
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
  const briefDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.decision_brief.discovery.current",
    brief_id: `decision_brief_${revision.replace("r", "")}`,
    run_id: reportEnvelope.run_id,
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
  const viewDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.discovery_report_view.v1",
    view_id: `report_markdown_${revision.replace("r", "")}`,
    run_id: reportEnvelope.run_id,
    producer_role: "harness",
    owned_output_path: reportViewPath,
    materialized_path: "report.md",
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
    reportView: reportMarkdown,
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
  const briefDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.decision_brief.assessment.current",
    brief_id: `decision_brief_${revision.replace("r", "")}`,
    run_id: reportEnvelope.run_id,
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
  const viewDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.concept_evidence_report_view.v1",
    view_id: `report_markdown_${revision.replace("r", "")}`,
    run_id: reportEnvelope.run_id,
    producer_role: "harness",
    owned_output_path: reportViewPath,
    materialized_path: "report.md",
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

function materializedBytes(envelope: FormalArtifactEnvelope): {
  readonly targetPath: ReportMaterializationReceipt["target_path"];
  readonly bytes: string;
} | null {
  if (
    envelope.artifact_type === "startup_opportunity.concept_evidence_report.v1" ||
    envelope.artifact_type === "startup_opportunity.report.v1" ||
    envelope.artifact_type === "startup_opportunity.terminal_report_source.v1"
  ) {
    return { targetPath: "report.json", bytes: `${canonicalJson(envelope.document)}\n` };
  }
  if (
    envelope.artifact_type === "startup_opportunity.decision_brief.assessment.current" ||
    envelope.artifact_type === "startup_opportunity.decision_brief.discovery.current" ||
    envelope.artifact_type === "startup_opportunity.decision_brief.terminal.current"
  ) {
    return {
      targetPath: "decision-brief.md",
      bytes: requiredString(envelope.document.markdown, "markdown"),
    };
  }
  if (
    envelope.artifact_type === "startup_opportunity.concept_evidence_report_view.v1" ||
    envelope.artifact_type === "startup_opportunity.discovery_report_view.v1" ||
    envelope.artifact_type === "startup_opportunity.terminal_report_view.v1"
  ) {
    return {
      targetPath: "report.md",
      bytes: requiredString(envelope.document.markdown, "markdown"),
    };
  }
  return null;
}

async function assertMaterializedTargetsCompatibleLocked(
  runRoot: string,
  envelopes: readonly FormalArtifactEnvelope[],
): Promise<void> {
  for (const envelope of envelopes) {
    const materialized = materializedBytes(envelope);
    if (materialized === null) {
      continue;
    }
    if (envelope.document.materialized_path !== materialized.targetPath) {
      throw new StoreError(
        "report.materialized_path_mismatch",
        "report sidecar targets another view path",
        { artifactPath: envelope.artifact_path },
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
      if (!isNodeError(error, "ENOENT")) {
        throw error;
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
    const materialized = materializedBytes(envelope);
    return materialized === null
      ? []
      : [
          {
            source_artifact_path: envelope.artifact_path,
            target_path: materialized.targetPath,
            content_hash: sha256Bytes(materialized.bytes),
            bytes: materialized.bytes,
          },
        ];
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
    materializedBytes(envelope) === null ? [] : [envelope.artifact_path],
  );
  if (
    request.run_id !== runId ||
    request.artifact_type !== "startup_opportunity.terminal_report_source.v1" ||
    source.run_id !== runId ||
    source.artifact_type !== "startup_opportunity.terminal_report_source.v1" ||
    derived.length !== 3 ||
    derived.some((envelope) => envelope.run_id !== runId) ||
    operation.materialized_outputs.length !== 3 ||
    new Set(materializedTargets).size !== 3 ||
    !["report.json", "decision-brief.md", "report.md"].every((target) =>
      materializedTargets.includes(target as "report.json" | "decision-brief.md" | "report.md"),
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
    await materializeLocked(runRoot, envelope);
    const fault =
      output.target_path === "report.json"
        ? "after_report_materialization"
        : output.target_path === "decision-brief.md"
          ? "after_brief_materialization"
          : "after_view_materialization";
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
      value.target_path !== "report.md") ||
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
): Promise<ReportMaterializationResult | null> {
  const materialized = materializedBytes(envelope);
  if (materialized === null) {
    return null;
  }
  if (envelope.document.materialized_path !== materialized.targetPath) {
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
      throw new StoreError("report.operation_conflict", "report materialization receipt drifted", {
        receiptPath,
      });
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
    return {
      targetPath: materialized.targetPath,
      status: "idempotent_replay",
      contentHash: receipt.materialized_content_hash,
    };
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
  return {
    targetPath: materialized.targetPath,
    status: "materialized",
    contentHash: receipt.materialized_content_hash,
  };
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
    const reportMaterialization = await materializeLocked(runRoot, report);
    if (reportMaterialization?.status === "materialized") {
      materializedRecovered.push(reportMaterialization.targetPath);
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
      const derivedMaterialization = await materializeLocked(runRoot, derivedEnvelope);
      if (derivedMaterialization?.status === "materialized") {
        materializedRecovered.push(derivedMaterialization.targetPath);
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
      assertDerivedConsistencyPassed(deriveReportEnvelopes(input.reportEnvelope));
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
      await this.materialize(derived[1] as FormalArtifactEnvelope);
      if (input.faultAt === "after_view_materialization") {
        throw new StoreError("fault.injected", "fault injected after full report materialization");
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
        materializedPaths: ["report.json", "decision-brief.md", "report.md"],
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
    const projection =
      source.artifact_type === "startup_opportunity.terminal_report_source.v1"
        ? projectCommercialAuditTables(audits, tasks, documentsByPath, currentDecisionSubjectIds)
        : fullProjection;
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
    const projectedAuditRefs = commercialProjectionRefs(
      (source.artifact_type === "startup_opportunity.terminal_report_source.v1"
        ? fullProjection
        : projection) as unknown as Record<string, unknown>,
    );
    const provisionalDocument = {
      ...sourceDocument,
      ...projection,
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
    const provisional = {
      ...source,
      input_refs: [
        ...new Set([
          ...source.input_refs.filter((ref) => !ref.startsWith("artifacts/research-audits/")),
          ...strings(researchProvenance.causal_handoff_refs),
          ...projection.commercial_research_audit_refs,
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
  ): Promise<ReportMaterializationResult | null> {
    const runRoot = await openRunDirectory(this.runsRoot, envelope.run_id);
    return withRunLock(runRoot, async () => {
      await this.artifacts.validateStoredEnvelope(runRoot, envelope.run_id, envelope);
      return materializeLocked(runRoot, envelope, faultAt);
    });
  }
}

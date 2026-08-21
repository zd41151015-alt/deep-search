import { sha256Bytes } from "../artifact-store/canonical.js";

export const REPORT_SCAN_CONTRACT_VERSION =
  "startup_opportunity.deterministic_forbidden_expression_scan.v2" as const;

export const REPORT_SCAN_SURFACES = ["structured_report", "decision_brief", "report_view"] as const;

export type ReportScanSurface = (typeof REPORT_SCAN_SURFACES)[number];

export function requiresDeterministicReportScan(envelopeSchemaVersion: unknown): boolean {
  return envelopeSchemaVersion === "startup_opportunity.artifact_envelope.current";
}

const FORBIDDEN_RULES = [
  {
    id: "market_validation_success",
    expression:
      /\b(?:(?:market|demand)\s+(?:has\s+)?(?:been\s+)?validated|validated\s+(?:market|demand)|(?:market|demand)\s+validation\s+(?:has\s+)?(?:been\s+)?(?:success|succeeded|successful|passed|achieved)|validation\s+(?:success|succeeded|successful|passed|achieved)|(?:success|succeeded|successful|passed|achieved)\s+(?:(?:market|demand)\s+)?validation)\b/iu,
  },
  {
    id: "probability_claim",
    expression:
      /\b(?:success\s+(?:of\s+)?probability|probability\s+(?:of\s+)?success|chance\s+of\s+success|probability\s*(?:is|=)?\s*\d+(?:\.\d+)?\s*(?:%|percent)|(?:chance|likely)\s*(?:is|=)?\s*\d+(?:\.\d+)?\s*(?:%|percent)|\d+(?:\.\d+)?\s*(?:%|percent)\s+(?:success\s+probability|probability(?:\s+of\s+success)?|likely|chance))\b/iu,
  },
  {
    id: "global_score",
    expression: /\b(?:global\s+score|score\s+global|overall\s+score|score\s+overall)\b/iu,
  },
  {
    id: "comparative_selection_claim",
    expression:
      /\b(?:best|preferred|preference|preferred\s+selection|best\s+candidate|best\s+solution|top\s+choice|first\s+choice|compared\s+best|compared\s+preferred|selected\s+as\s+best|best\s+fit|optimal|optimum)\b/iu,
  },
] as const;

export const REPORT_FORBIDDEN_RULE_IDS = FORBIDDEN_RULES.map((rule) => rule.id);

function stringValues(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringValues);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.values(value).flatMap(stringValues);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

const DISCOVERY_COMPARATIVE_CONTEXT_FIELDS = new Set([
  "current_recommendation",
  "partial_order_summary",
  "recommendation_meaning",
  "recommended_first_bet",
]);

const DISCOVERY_COMPARATIVE_SECTION_FIELDS = new Set([
  "conclusion_summary",
  "decision_recommendation",
]);

const DISCOVERY_COMPARATIVE_EVALUATION_FIELDS = new Set([
  "comparison_reason",
  "current_recommendation",
  "exploration_status",
  "partial_order_summary",
  "recommendation_meaning",
  "selection_posture",
  "status_rationale",
]);

const TERMINAL_COMPARATIVE_CONCLUSION_FIELDS = new Set(["current_recommendation", "meaning"]);

const TERMINAL_COMPARATIVE_DIRECTION_FIELDS = new Set([
  "comparison_reason",
  "current_recommendation",
  "exploration_status",
  "partial_order_summary",
  "recommendation_meaning",
  "selection_posture",
  "status_rationale",
]);

function recordStringValues(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function hasComparedDiscoveryEvaluation(report: Record<string, unknown>): boolean {
  return Array.isArray(report.solution_evaluations)
    ? report.solution_evaluations.some((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          return false;
        }
        const evaluation =
          typeof entry.evaluation === "object" && entry.evaluation !== null
            ? (entry.evaluation as Record<string, unknown>)
            : {};
        return String(evaluation.exploration_status) === "compared_multiple_formal_solutions";
      })
    : false;
}

function hasComparedTerminalDirection(source: Record<string, unknown>): boolean {
  return Array.isArray(source.directions)
    ? source.directions.some((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          return false;
        }
        const summary =
          typeof entry.solution_evaluation_summary === "object" &&
          entry.solution_evaluation_summary !== null
            ? (entry.solution_evaluation_summary as Record<string, unknown>)
            : {};
        return String(summary.exploration_status) === "compared_multiple_formal_solutions";
      })
    : false;
}

function comparativeSelectionCandidates(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(comparativeSelectionCandidates);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return scanDiscoveryComparativeSelection(value);
}

export function requiresComparativeSelectionClamp(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return true;
  }
  const report = value as Record<string, unknown>;
  const discoveryCompared = hasComparedDiscoveryEvaluation(report);
  const terminalCompared = hasComparedTerminalDirection(report);
  return !discoveryCompared && !terminalCompared;
}

function scanDiscoveryComparativeSelection(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const report = value as Record<string, unknown>;
  const matches = new Set<string>();
  const discoveryCompared = hasComparedDiscoveryEvaluation(report);
  const terminalCompared = hasComparedTerminalDirection(report);
  if (isRecord(report.curated_judgment_context) && !discoveryCompared) {
    for (const key of DISCOVERY_COMPARATIVE_CONTEXT_FIELDS) {
      for (const candidate of recordStringValues(report.curated_judgment_context, key)) {
        matches.add(candidate);
      }
    }
  }
  if (isRecord(report.report_sections) && !discoveryCompared) {
    for (const key of DISCOVERY_COMPARATIVE_SECTION_FIELDS) {
      for (const candidate of recordStringValues(report.report_sections, key)) {
        matches.add(candidate);
      }
    }
  }
  for (const entry of Array.isArray(report.solution_evaluations)
    ? report.solution_evaluations
    : []) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const evaluation =
      typeof entry.evaluation === "object" && entry.evaluation !== null
        ? (entry.evaluation as Record<string, unknown>)
        : null;
    if (
      evaluation === null ||
      String(evaluation.exploration_status) === "compared_multiple_formal_solutions"
    ) {
      continue;
    }
    for (const key of DISCOVERY_COMPARATIVE_EVALUATION_FIELDS) {
      for (const candidate of recordStringValues(evaluation, key)) {
        matches.add(candidate);
      }
    }
  }
  if (isRecord(report.research_conclusion) && !terminalCompared) {
    for (const key of TERMINAL_COMPARATIVE_CONCLUSION_FIELDS) {
      for (const candidate of recordStringValues(report.research_conclusion, key)) {
        matches.add(candidate);
      }
    }
  }
  for (const entry of Array.isArray(report.directions) ? report.directions : []) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const summary =
      typeof entry.solution_evaluation_summary === "object" &&
      entry.solution_evaluation_summary !== null
        ? (entry.solution_evaluation_summary as Record<string, unknown>)
        : null;
    if (
      summary === null ||
      String(summary.exploration_status) === "compared_multiple_formal_solutions"
    ) {
      continue;
    }
    for (const key of TERMINAL_COMPARATIVE_DIRECTION_FIELDS) {
      for (const candidate of recordStringValues(entry, key)) {
        matches.add(candidate);
      }
    }
    for (const candidate of recordStringValues(summary, "status_rationale")) {
      matches.add(candidate);
    }
  }
  return [...matches];
}

export function scanReportSurface(
  surface: ReportScanSurface,
  value: unknown,
  comparativeSelectionClamp = false,
): readonly string[] {
  const matches = new Set<string>();
  const candidates = comparativeSelectionClamp
    ? comparativeSelectionCandidates(value)
    : stringValues(value);
  for (const candidate of candidates) {
    const text = normalized(candidate);
    for (const rule of FORBIDDEN_RULES) {
      if (rule.id === "comparative_selection_claim" && !comparativeSelectionClamp) {
        continue;
      }
      if (rule.expression.test(text)) {
        matches.add(`${rule.id}@${surface}:${sha256Bytes(text)}`);
      }
    }
  }
  return [...matches].sort();
}

export function scanComparativeSelectionSurface(
  surface: ReportScanSurface,
  value: unknown,
): readonly string[] {
  return scanDiscoveryComparativeSelection(value)
    .flatMap((candidate) => scanReportSurface(surface, candidate, true))
    .sort();
}

export function scanDiscoveryReportSurfaces(
  input: {
    readonly structuredReport: unknown;
    readonly decisionBrief: unknown;
    readonly reportView: unknown;
  },
  comparativeSelectionClamp = false,
): readonly string[] {
  const genericMatches = [
    ...scanReportSurface("structured_report", input.structuredReport),
    ...scanReportSurface("decision_brief", input.decisionBrief),
    ...scanReportSurface("report_view", input.reportView),
  ].sort();
  const comparativeMatches = scanComparativeSelectionSurface(
    "structured_report",
    input.structuredReport,
  );
  if (comparativeSelectionClamp || comparativeMatches.length > 0) {
    return [...genericMatches, ...comparativeMatches].sort();
  }
  return genericMatches;
}

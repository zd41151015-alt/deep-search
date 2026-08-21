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

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

export function requiresComparativeSelectionClamp(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return true;
  }
  const report = value as Record<string, unknown>;
  const evaluations = Array.isArray(report.solution_evaluations)
    ? report.solution_evaluations.filter(
        (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
      )
    : [];
  if (evaluations.length === 0) {
    return true;
  }
  return evaluations.some((entry) => {
    const evaluation =
      typeof entry.evaluation === "object" && entry.evaluation !== null
        ? (entry.evaluation as Record<string, unknown>)
        : {};
    return String(evaluation.exploration_status) !== "compared_multiple_formal_solutions";
  });
}

export function scanReportSurface(
  surface: ReportScanSurface,
  value: unknown,
  comparativeSelectionClamp = false,
): readonly string[] {
  const matches = new Set<string>();
  for (const candidate of stringValues(value)) {
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

export function scanDiscoveryReportSurfaces(
  input: {
    readonly structuredReport: unknown;
    readonly decisionBrief: string;
    readonly reportView: string;
  },
  comparativeSelectionClamp = false,
): readonly string[] {
  return [
    ...scanReportSurface("structured_report", input.structuredReport, comparativeSelectionClamp),
    ...scanReportSurface("decision_brief", input.decisionBrief, comparativeSelectionClamp),
    ...scanReportSurface("report_view", input.reportView, comparativeSelectionClamp),
  ].sort();
}

import { sha256Bytes } from "../artifact-store/canonical.js";

export const REPORT_SCAN_CONTRACT_VERSION =
  "startup_opportunity.deterministic_forbidden_expression_scan.v3" as const;

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
export function scanReportSurface(surface: ReportScanSurface, value: unknown): readonly string[] {
  const matches = new Set<string>();
  for (const candidate of stringValues(value)) {
    const text = normalized(candidate);
    for (const rule of FORBIDDEN_RULES) {
      if (rule.expression.test(text)) {
        matches.add(`${rule.id}@${surface}:${sha256Bytes(text)}`);
      }
    }
  }
  return [...matches].sort();
}

export function scanDiscoveryReportSurfaces(input: {
  readonly structuredReport: unknown;
  readonly decisionBrief: unknown;
  readonly reportView: unknown;
}): readonly string[] {
  const genericMatches = [
    ...scanReportSurface("structured_report", input.structuredReport),
    ...scanReportSurface("decision_brief", input.decisionBrief),
    ...scanReportSurface("report_view", input.reportView),
  ].sort();
  return genericMatches;
}

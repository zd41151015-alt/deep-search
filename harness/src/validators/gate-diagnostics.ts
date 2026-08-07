import type { ValidationIssue } from "./schema-bundle.js";
import { withGateMetadata } from "./schema-bundle.js";

export interface GateDiagnosticSummary extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.gate_diagnostics.current";
  readonly triggered_stage: string;
  readonly issues: readonly ValidationIssue[];
  readonly statistics: readonly Record<string, unknown>[];
  readonly downgrade_candidates: readonly Record<string, unknown>[];
}

const DECISION_IMPACT: Readonly<Record<string, string>> = {
  "commercial_research.vendor_claim_not_cross_validated":
    "Vendor-only support lowers Claim confidence and prevents strong ranking eligibility.",
  "commercial_research.source_concentration":
    "Source concentration lowers confidence and can keep a direction unranked.",
  "commercial_research.independent_cross_validation_missing":
    "The disposition ceiling remains conservative until independent Evidence is adopted.",
  "commercial_research.regulatory_status_unverified":
    "Unverified regulatory background cannot support a current regulatory conclusion.",
  "commercial_research.quantitative_coverage_incomplete":
    "Aggregate quantitative completeness and recommendation strength are limited.",
  "commercial_research.competitive_coverage_incomplete":
    "Aggregate substitute coverage and recommendation strength are limited.",
  "commercial_research.assigned_scope_undisclosed":
    "The compiler records the assigned dimension as unavailable and applies the corresponding confidence ceiling.",
  "commercial_research.search_closure_log_missing":
    "Search completeness is disclosed as unknown; Evidence already adopted remains traceable.",
  "commercial_research.secondary_source_traceability_limited":
    "The secondary material is retained, but it cannot by itself establish an observed commercial metric.",
  "commercial_research.positive_support_not_adopted":
    "The material remains traceable, but rejected or unaudited Evidence cannot count as direct positive support.",
  "commercial_research.semantic_evidence_not_registered":
    "The referenced Evidence is preserved in the Run closure but cannot count as audited direct support.",
  "commercial_research.search_objective_unplanned":
    "The recorded result is preserved; the undeclared route limits completeness claims about the planned search.",
  "commercial_research.acquisition_evidence_not_adopted":
    "The acquisition remains visible but cannot establish an observed quantitative state.",
  "commercial_research.quantitative_positive_support_not_adopted":
    "The numeric row is retained as limited material and cannot close direct quantitative coverage.",
  "commercial_research.competitive_positive_support_not_adopted":
    "The substitute row is retained as limited material and cannot close direct competitive coverage.",
  "commercial_research.report_audit_closure_incomplete":
    "A planned commercial Audit is missing; report coverage is partial and cannot authorize a stronger conclusion.",
  "terminal_reporting.search_closure_incomplete":
    "A planned Search Closure is missing; the report discloses incomplete execution and the related decision limit.",
};

export function projectGateWarnings(
  rawIssues: readonly ValidationIssue[],
): readonly Record<string, unknown>[] {
  const unique = new Map<string, ValidationIssue>();
  for (const rawIssue of rawIssues) {
    const issue = withGateMetadata(rawIssue);
    if (issue.severity === "error") continue;
    const key = `${issue.code}\u0000${issue.instancePath}\u0000${issue.message}`;
    unique.set(key, issue);
  }
  return [...unique.values()]
    .sort((left, right) =>
      `${left.code}\u0000${left.instancePath}`.localeCompare(
        `${right.code}\u0000${right.instancePath}`,
      ),
    )
    .map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      category: issue.category,
      message: issue.message,
      decision_impact:
        DECISION_IMPACT[issue.code] ??
        "This diagnostic is disclosed for auditability and does not independently authorize a stronger conclusion.",
      artifact_refs: [artifactFor(issue)].filter((artifact) => artifact !== "unknown_artifact"),
    }));
}

function artifactFor(issue: ValidationIssue): string {
  const path = issue.instancePath.split("#", 1)[0] ?? "";
  return path === "" || path.startsWith("/") ? "unknown_artifact" : path;
}

export function summarizeGateDiagnostics(
  rawIssues: readonly ValidationIssue[],
  triggeredStage: string,
): GateDiagnosticSummary {
  const issues = rawIssues.map(withGateMetadata);
  const grouped = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    grouped.set(issue.code, [...(grouped.get(issue.code) ?? []), issue]);
  }
  const statistics = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, entries]) => {
      const first = withGateMetadata(entries[0] as ValidationIssue);
      return {
        validator_code: code,
        severity: first.severity,
        category: first.category,
        triggered_stage: triggeredStage,
        trigger_count: entries.length,
        first_occurrence_stage: triggeredStage,
        repair_rounds: null,
        repair_time_ms: null,
        artifact_count: new Set(entries.map(artifactFor)).size,
        changed_evidence_claim_or_disposition: null,
        format_only: first.category === "format",
        mechanically_derivable: first.mechanicallyDerivable === true,
      };
    });
  const downgradeCandidates = statistics.flatMap((entry) => {
    if (entry.severity === "error" || entry.category === "integrity") return [];
    const reasons = [
      ...(entry.trigger_count >= 3 ? ["high_frequency"] : []),
      ...(entry.format_only ? ["format_only"] : []),
      ...(entry.mechanically_derivable ? ["mechanically_derivable"] : []),
      ...(entry.changed_evidence_claim_or_disposition === false
        ? ["no_evidence_claim_or_disposition_change"]
        : []),
    ];
    if (reasons.length === 0) return [];
    return [
      {
        validator_code: entry.validator_code,
        candidate_action: entry.mechanically_derivable ? "automate" : "downgrade",
        reason_codes: reasons,
        integrity_gate_automatically_relaxed: false,
      },
    ];
  });
  return {
    schema_version: "startup_opportunity.gate_diagnostics.current",
    triggered_stage: triggeredStage,
    issues,
    statistics,
    downgrade_candidates: downgradeCandidates,
  };
}

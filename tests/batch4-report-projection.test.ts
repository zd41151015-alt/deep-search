import assert from "node:assert/strict";
import test from "node:test";
import {
  criticalResearchGapGroups,
  deriveReportStatistics,
  renderCompetitiveSubjectSummary,
  renderCriticalResearchGaps,
  renderDecisionGradeQuantitativeSummary,
  renderQuantitativeSignalTable,
} from "../harness/src/reporting/commercial-report-tables.js";
import {
  canonicalizeReadableSources,
  deriveReportCitations,
} from "../harness/src/reporting/report-citation-authority.js";
import { renderTerminalAuditAppendix } from "../harness/src/reporting/terminal-reporting.js";

function researchGap(
  subjectId: string,
  dimension: string,
  state: string,
  decisionImpact: string,
): Record<string, unknown> {
  return {
    coverage_kind: "research",
    subject_ids: [subjectId],
    dimension,
    state,
    query_attempts: [],
    reason: `${dimension} remains unresolved.`,
    alternative_metric: null,
    decision_impact: decisionImpact,
  };
}

test("critical gap projection is truthful per subject, state, and decision impact and caps only the view", () => {
  const source = {
    report_subject_labels: [
      { subject_id: "subject_a", label: "Subject A" },
      { subject_id: "subject_b", label: "Subject B" },
      { subject_id: "subject_c", label: "Subject C" },
    ],
    research_coverage_gaps: [
      researchGap("subject_a", "buyer", "partial", "could change ranking"),
      researchGap("subject_a", "pricing", "partial", "could change ranking"),
      researchGap("subject_a", "retention", "unknown", "could change conclusion"),
      researchGap("subject_a", "distribution", "unavailable", "could change ranking"),
      researchGap("subject_a", "competition", "partial", "could change conclusion"),
      researchGap("subject_a", "unit_economics", "unknown", "could change ranking"),
      researchGap("subject_a", "purchase", "unavailable", "could change conclusion"),
      researchGap("subject_b", "buyer", "partial", "could change ranking"),
      researchGap("subject_c", "market", "not_applicable", "no decision effect"),
      {
        coverage_kind: "incumbent_response",
        coverage: {
          subject_id: "subject_c",
          state: "unknown",
          decision_impact: "Context only; no automatic decision effect.",
          reason: "No bounded response assessment was assigned.",
        },
      },
    ],
  };
  const groups = criticalResearchGapGroups(source);
  assert.equal(groups.filter((group) => group.subjectId === "subject_a").length, 5);
  assert.equal(groups.filter((group) => group.subjectId === "subject_b").length, 1);
  assert.equal(groups.filter((group) => group.subjectId === "subject_c").length, 0);
  assert.ok(
    groups.some(
      (group) =>
        group.subjectId === "subject_a" &&
        group.state === "partial" &&
        group.decisionImpact === "could change ranking" &&
        group.dimensions.includes("buyer") &&
        group.dimensions.includes("pricing"),
    ),
  );
  assert.equal(deriveReportStatistics(source).full_gap_row_count, 10);
  const rendered = renderCriticalResearchGaps(source);
  assert.match(rendered, /Subject C.*No unresolved research gap/su);
  assert.doesNotMatch(rendered, /Subject C.*buyer.*partial/su);
});

test("core quantitative summary uses decision-grade rows while full table preserves proxy context", () => {
  const source = {
    report_subject_labels: [{ subject_id: "subject_a", label: "Subject A" }],
    report_citations: [
      {
        evidence_ref: "evidence/decision.json",
        label: "Decision source",
        url: "https://canonical.synthetic.invalid/decision",
      },
      {
        evidence_ref: "evidence/proxy.json",
        label: "Proxy source",
        url: "https://canonical.synthetic.invalid/proxy",
      },
    ],
    quantitative_signal_rows: [
      {
        observation: {
          subject_id: "subject_a",
          metric_family: "commercial_behavior",
          metric_name: "paid customers",
          metric_semantics: "paid_customers",
          value: { shape: "point", value: 12, unit: "customers" },
          metric_definition: "Synthetic direct paid-customer count.",
          geography: "Synthetic",
          period: { label: "2026" },
          measurement_type: "direct_measurement",
          comparability: { status: "comparable", direct_comparison_allowed: true },
          error_uncertainty: "Synthetic fixture only.",
          evidence_refs: ["evidence/decision.json"],
          decision_use: { grade: "decision_grade" },
        },
      },
      {
        observation: {
          subject_id: "subject_a",
          metric_family: "demand_scale",
          metric_name: "review count",
          metric_semantics: "review_count",
          value: { shape: "point", value: 500, unit: "reviews" },
          metric_definition: "Synthetic review-count proxy.",
          geography: "Synthetic",
          period: { label: "2026" },
          measurement_type: "proxy",
          comparability: { status: "not_comparable", direct_comparison_allowed: false },
          error_uncertainty: "Not a purchase or market-size observation.",
          evidence_refs: ["evidence/proxy.json"],
          decision_use: { grade: "directional_proxy" },
        },
      },
    ],
  };
  const core = renderDecisionGradeQuantitativeSummary(source);
  const full = renderQuantitativeSignalTable(source);
  assert.match(core, /paid customers/);
  assert.doesNotMatch(core, /review count/);
  assert.match(full, /paid customers/);
  assert.match(full, /review count/);
  assert.equal(deriveReportStatistics(source).directional_or_context_quantitative_signal_count, 1);
});

test("canonical Evidence authority supplies report URLs and overrides authored source text", () => {
  const evidenceRef = "evidence/formal.json";
  const recordRef = "evidence/manifest.jsonl#ev_synthetic";
  const formalDocuments = [
    {
      path: evidenceRef,
      document: {
        schema_version: "startup_opportunity.evidence.assessment.current",
        source_name: "Canonical Evidence label",
        mechanical_binding: { substrate_record_ref: recordRef },
      },
    },
    {
      path: "evidence/unused.json",
      document: {
        schema_version: "startup_opportunity.evidence.assessment.current",
        source_name: "Unused substrate",
        mechanical_binding: { substrate_record_ref: "evidence/manifest.jsonl#ev_unused" },
      },
    },
  ];
  const exactRecords = new Map([
    [
      recordRef,
      {
        source: {
          kind: "public_url",
          canonical_url: "https://canonical.synthetic.invalid/source",
        },
      },
    ],
    [
      "evidence/manifest.jsonl#ev_unused",
      {
        source: {
          kind: "public_url",
          canonical_url: "https://canonical.synthetic.invalid/unused",
        },
      },
    ],
  ]);
  const citations = deriveReportCitations(formalDocuments, exactRecords, {
    sources: [{ evidence_ref: evidenceRef }],
  });
  const canonical = canonicalizeReadableSources(
    [
      {
        evidence_ref: evidenceRef,
        title: "Forged title",
        url: "https://forged.synthetic.invalid/source",
      },
    ],
    citations,
  );
  assert.deepEqual(canonical.missingEvidenceRefs, []);
  assert.equal(canonical.sources[0]?.title, "Canonical Evidence label");
  assert.equal(canonical.sources[0]?.url, "https://canonical.synthetic.invalid/source");
  assert.equal(citations.length, 1);
});

test("competitive summary preserves not-applicable and unresolved states without inventing objects", () => {
  const source = {
    report_subject_labels: [{ subject_id: "subject_a", label: "Subject A" }],
    report_citations: [],
    competitive_substitute_rows: [],
    commercial_subject_aggregates: [
      {
        subject_id: "subject_a",
        competitive_coverage: [
          { competitor_type: "platform", state: "not_applicable" },
          { competitor_type: "service", state: "partial" },
          { competitor_type: "direct_product", state: "unavailable" },
        ],
      },
    ],
  };
  const summary = renderCompetitiveSubjectSummary(source);
  assert.match(summary, /no competitive object formed/);
  assert.match(summary, /Explicitly not applicable: platform/);
  assert.match(summary, /service \(partial\)/);
  assert.match(summary, /direct_product \(unavailable\)/);
});

test("audit appendix groups exclusions but retains every exact Evidence reference and source", () => {
  const source = {
    research_language: "en-US",
    report_statistics: {},
    report_citations: [
      {
        evidence_ref: "evidence/a.json",
        label: "Source A",
        url: "https://canonical.synthetic.invalid/a",
      },
      {
        evidence_ref: "evidence/b.json",
        label: "Source B",
        url: "https://canonical.synthetic.invalid/b",
      },
    ],
    quantitative_signal_rows: [],
    competitive_substitute_rows: [],
    incumbent_response_risk_rows: [],
    current_decision_subject_ids: [],
    research_coverage_gaps: [],
    gate_warnings: [],
    excluded_evidence: [
      { evidence_ref: "evidence/a.json", reason: "context only" },
      { evidence_ref: "evidence/b.json", reason: "context only" },
    ],
    commercial_research_status: { state: "not_planned" },
    research_provenance: {
      available_handoff_count: 0,
      captured_item_count: 0,
      consumed_item_refs: [],
      used_handoff_items: [],
      imported_substrate_refs: [],
      adopted_inherited_evidence_refs: [],
      cited_inherited_evidence_refs: [],
      adopted_current_evidence_refs: [],
      cited_current_evidence_refs: [],
      revalidation_gaps: [],
    },
  };
  const appendix = renderTerminalAuditAppendix(source);
  assert.equal(appendix.match(/\*\*context only\*\*/gu)?.length, 1);
  assert.match(appendix, /Source A.*evidence\/a\.json/su);
  assert.match(appendix, /Source B.*evidence\/b\.json/su);
});

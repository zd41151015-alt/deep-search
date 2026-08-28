import assert from "node:assert/strict";
import test from "node:test";
import { canonicalContentHash } from "../harness/src/artifact-store/canonical.js";
import type { FormalArtifactEnvelope } from "../harness/src/index.js";
import {
  criticalResearchGapGroups,
  deriveReportStatistics,
  renderCompetitiveSubjectSummary,
  renderCriticalResearchGaps,
  renderDecisionGradeQuantitativeSummary,
  renderGateWarnings,
  renderQuantitativeSignalTable,
  renderResearchCoverageGaps,
} from "../harness/src/reporting/commercial-report-tables.js";
import {
  canonicalizeReadableSources,
  deriveReportCitations,
} from "../harness/src/reporting/report-citation-authority.js";
import {
  localizedDeliveryForm,
  localizedEnum,
  localizedFixedReportTerm,
  localizedInternalLeakageIssues,
  localizedTerminalSourceIssues,
  localizedTerminalUserViewIssueDetails,
  localizedTerminalUserViewIssues,
  userVisibleText,
} from "../harness/src/reporting/report-localization.js";
import {
  deriveNonTerminalReportSubjectAuthorities,
  deriveNonTerminalReportSubjectIds,
  deriveReportDispositions,
  deriveReportSubjectLabels,
} from "../harness/src/reporting/report-projection-authority.js";
import {
  deriveTerminalReportDocuments,
  renderTerminalAuditAppendix,
  terminalReportDocumentsEqual,
} from "../harness/src/reporting/terminal-reporting.js";
import {
  type TerminalReportingDocument,
  validateTerminalReportingContract,
} from "../harness/src/validators/terminal-reporting-validator.js";

function researchGap(
  subjectId: string,
  dimension: string,
  state: string,
  decisionImpact: string,
  decisionRelevance: "blocking" | "non_blocking" | "context_only" = "non_blocking",
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
    decision_relevance: decisionRelevance,
  };
}

function terminalAuditSource(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    research_language: "zh-CN",
    report_statistics: {},
    report_subject_labels: [],
    report_citations: [],
    quantitative_signal_rows: [],
    competitive_substitute_rows: [],
    incumbent_response_risk_rows: [],
    current_decision_subject_ids: [],
    research_coverage_gaps: [],
    gate_warnings: [],
    report_evidence_dispositions: [],
    report_source_dispositions: [],
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
    ...overrides,
  };
}

const TERMINAL_SOURCE_REF = "artifacts/reporting/terminal-report-source.r1.json";
const TERMINAL_MISSING_TASK_REF = "tasks/discovery/evaluation/commercial_missing.attempt-1.json";
const TERMINAL_SUBMITTED_AUDIT_REF = "artifacts/research-audits/commercial_observed.json";
const TERMINAL_SUBJECT_ID = "subject_a";

function terminalExecutionGap(
  taskRef = TERMINAL_MISSING_TASK_REF,
  subjectIds: readonly string[] = [TERMINAL_SUBJECT_ID],
): Record<string, unknown> {
  return {
    task_ref: taskRef,
    coverage_kind: "execution",
    subject_ids: [...subjectIds],
    state: "unavailable",
    reason: "The planned commercial research task has no current valid Audit artifact.",
    decision_impact:
      "Execution remains incomplete; assigned commercial dimensions are not formally delivered.",
    decision_relevance: "blocking",
    assigned_metric_families: ["demand_scale"],
    assigned_competitor_types: ["direct_product"],
    assigned_commercial_dimensions: ["purchase_signal"],
  };
}

function terminalResearchGap(): Record<string, unknown> {
  return {
    coverage_kind: "research",
    subject_ids: [TERMINAL_SUBJECT_ID],
    dimension: "purchase_signal",
    state: "partial",
    query_attempts: [],
    reason: "Submitted commercial research left a bounded purchase-signal gap.",
    alternative_metric: null,
    decision_impact: "The missing purchase signal constrains ranking strength.",
    decision_relevance: "non_blocking",
    audit_refs: [TERMINAL_SUBMITTED_AUDIT_REF],
    task_refs: [TERMINAL_MISSING_TASK_REF],
  };
}

function commercialWarning(taskRef = TERMINAL_MISSING_TASK_REF): Record<string, unknown> {
  return {
    code: "commercial_research.report_audit_closure_incomplete",
    severity: "warning",
    category: "coverage",
    message: "A planned commercial Audit is missing.",
    decision_impact: "The report must disclose that planned commercial execution was incomplete.",
    artifact_refs: [taskRef],
  };
}

function fullCommercialProjection(
  state: "complete" | "planned_with_gaps" | "planned_but_missing" | "not_planned",
  overrides: Partial<{
    plannedTaskRefs: readonly string[];
    missingTaskRefs: readonly string[];
    submittedAuditRefs: readonly string[];
    gaps: readonly Record<string, unknown>[];
    subjectAggregates: readonly Record<string, unknown>[];
  }> = {},
): Record<string, unknown> {
  const plannedTaskRefs =
    overrides.plannedTaskRefs ?? (state === "not_planned" ? [] : [TERMINAL_MISSING_TASK_REF]);
  const missingTaskRefs =
    overrides.missingTaskRefs ?? (state === "planned_but_missing" ? plannedTaskRefs : []);
  const submittedAuditRefs =
    overrides.submittedAuditRefs ??
    (state === "complete" || state === "planned_with_gaps" ? [TERMINAL_SUBMITTED_AUDIT_REF] : []);
  return {
    commercial_research_audit_refs: [...submittedAuditRefs],
    quantitative_signal_rows: [],
    competitive_substitute_rows: [],
    incumbent_response_risk_rows: [],
    research_coverage_gaps: [
      ...(overrides.gaps ??
        (state === "planned_but_missing"
          ? [terminalExecutionGap()]
          : state === "planned_with_gaps"
            ? [terminalResearchGap()]
            : [])),
    ],
    commercial_subject_aggregates: [
      ...(overrides.subjectAggregates ??
        (state === "not_planned"
          ? []
          : [
              {
                subject_id: TERMINAL_SUBJECT_ID,
                audit_refs: [...submittedAuditRefs],
                task_refs: [...plannedTaskRefs],
                quantitative_coverage: [],
                competitive_coverage: [],
                research_status: state,
                execution_warning_task_refs: [...missingTaskRefs],
              },
            ])),
    ],
    commercial_background_material: [],
    commercial_research_status: {
      state,
      planned_task_refs: [...plannedTaskRefs],
      missing_task_refs: [...missingTaskRefs],
      submitted_audit_refs: [...submittedAuditRefs],
    },
  };
}

function terminalSource(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const baseAuditRefs = ["adaptations/decisions/adapt-runtime.json"];
  return {
    schema_version: "startup_opportunity.terminal_report_source.v1",
    report_id: "terminal_projection_fixture",
    run_id: "terminal_projection_fixture",
    mode: "opportunity_discovery",
    research_language: "en-US",
    producer_role: "main_agent",
    owned_output_path: TERMINAL_SOURCE_REF,
    materialized_path: "report.json",
    generated_at: "2026-07-24T12:09:30Z",
    decision_subject_snapshot_ref: "artifacts/reporting/decision-subject-snapshot.r1.json",
    decision_subject_snapshot_hash: `sha256:${"0".repeat(64)}`,
    decision_subject_synthesis_hashes: [],
    current_decision_subject_ids: [],
    terminal_outcome: "failed",
    decision_question: "SYNTHETIC terminal projection question.",
    execution: {
      completeness: "partial",
      completed_stages: ["initial bounded research"],
      incomplete_stages: [
        {
          stage: "commercial audit",
          cause: "runtime_blocked",
          detail: "The synthetic runtime stopped before all planned commercial Audits closed.",
          conclusion_impact: "No final subject or commercial ranking can be delivered.",
          related_refs: baseAuditRefs,
        },
      ],
      required_followups: [
        {
          followup_id: "missing_commercial_audit",
          status: "not_executed",
          detail: "A planned commercial Audit was not formally delivered.",
          related_refs: baseAuditRefs,
        },
      ],
      pending_operation_refs: [],
    },
    research_conclusion: {
      outcome: "no_recommendation",
      current_recommendation: "No research recommendation can be formed from this terminal state.",
      meaning: "The runtime stopped before a final subject was available.",
      evidence_strength: "insufficient",
      allowed_claim: "The bounded Run ended before a final subject was formed.",
    },
    runtime_health: {
      status: "blocked",
      issues: [
        {
          code: "synthetic_runtime_failure",
          stage: "commercial audit",
          detail: "The synthetic runtime failure interrupted formal commercial delivery.",
          conclusion_impact:
            "The report may disclose missing planned work but not infer market truth.",
          related_refs: baseAuditRefs,
        },
      ],
    },
    directions: [],
    sources: [],
    excluded_evidence: [],
    commercial_research_audit_refs: [],
    commercial_uncertainties: [],
    quantitative_signal_rows: [],
    competitive_substitute_rows: [],
    incumbent_response_risk_rows: [],
    research_coverage_gaps: [],
    commercial_subject_aggregates: [],
    commercial_background_material: [],
    commercial_research_status: {
      state: "not_planned",
      planned_task_refs: [],
      missing_task_refs: [],
      submitted_audit_refs: [],
    },
    gate_warnings: [],
    ordered_validation_plan: [],
    freshness: {
      earliest_valid_as_of: null,
      latest_valid_as_of: null,
      summary: "SYNTHETIC fixture has no market-source freshness claim.",
    },
    limitations: ["SYNTHETIC fixture only; no external validation was executed."],
    external_action_boundary: {
      execution_owner: "user",
      execution_supported: false,
      result_tracking_supported: false,
      external_validation_claimed: false,
    },
    audit_refs: baseAuditRefs,
    report_citations: [],
    report_evidence_dispositions: [],
    report_source_dispositions: [],
    report_subject_labels: [],
    research_provenance: {
      available_handoff_count: 0,
      captured_item_count: 0,
      causal_handoff_refs: [],
      consumed_item_refs: [],
      used_handoff_items: [],
      imported_substrate_refs: [],
      formal_inherited_evidence_refs: [],
      adopted_inherited_evidence_refs: [],
      cited_inherited_evidence_refs: [],
      formal_current_evidence_refs: [],
      adopted_current_evidence_refs: [],
      cited_current_evidence_refs: [],
      revalidation_gaps: [],
    },
    ...overrides,
  };
}

function terminalEnvelope(document: Record<string, unknown>): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: String(document.schema_version),
    artifact_path: TERMINAL_SOURCE_REF,
    run_id: String(document.run_id),
    created_at: String(document.generated_at),
    producer_role: "main_agent",
    input_refs: [],
    content_hash: canonicalContentHash(document),
    document,
  } as unknown as FormalArtifactEnvelope;
}

function terminalConsistency(source: Record<string, unknown>): Record<string, unknown> {
  const derived = deriveTerminalReportDocuments(terminalEnvelope(source));
  const consistency = derived.find(
    (entry) =>
      entry.artifactType === "startup_opportunity.report_consistency_evaluation.terminal.current",
  );
  assert.ok(consistency);
  return consistency.document;
}

function reportingDocument(
  path: string,
  schemaVersion: string,
  document: Record<string, unknown>,
): TerminalReportingDocument {
  const envelope = {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: schemaVersion,
    artifact_path: path,
    run_id: String(document.run_id),
    created_at: "2026-07-24T12:09:30Z",
    producer_role:
      schemaVersion === "startup_opportunity.terminal_report_source.v1" ? "main_agent" : "harness",
    input_refs: [],
    content_hash: canonicalContentHash(document),
    document,
  };
  return { path, schemaVersion, document, envelope };
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
      researchGap("subject_a", "retention", "unavailable", "could change conclusion"),
      researchGap("subject_a", "distribution", "unavailable", "could change ranking"),
      researchGap("subject_a", "competition", "partial", "could change conclusion"),
      researchGap("subject_a", "unit_economics", "unavailable", "could change ranking"),
      researchGap("subject_a", "purchase", "unavailable", "could change conclusion", "blocking"),
      researchGap("subject_a", "background", "partial", "context only", "context_only"),
      researchGap("subject_b", "buyer", "partial", "could change ranking"),
      researchGap("subject_c", "market", "not_applicable", "no decision effect"),
      {
        coverage_kind: "incumbent_response",
        coverage: {
          subject_id: "subject_c",
          state: "partial",
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
  assert.ok(
    groups.some(
      (group) =>
        group.subjectId === "subject_a" &&
        group.decisionRelevance === "blocking" &&
        group.dimensions.includes("purchase"),
    ),
  );
  assert.ok(groups.every((group) => !group.dimensions.includes("background")));
  assert.equal(deriveReportStatistics(source).full_gap_row_count, 11);
  const rendered = renderCriticalResearchGaps(source);
  assert.match(rendered, /Subject C.*No unresolved research gap/su);
  assert.doesNotMatch(rendered, /Subject C.*buyer.*partial/su);
});

test("Discovery final-subject authority excludes rejected and watchlist siblings", () => {
  const report = {
    decision_recommendation_ref: "artifacts/recommendation.json",
    portfolio_view_ref: "artifacts/portfolio.json",
    top_opportunity_refs: ["artifacts/opportunity-a.json"],
    curated_judgment_context: {
      alternative_bets: ["artifacts/rejected.json"],
    },
  };
  const documents = new Map<string, Record<string, unknown>>([
    [
      "artifacts/recommendation.json",
      {
        schema_version: "startup_opportunity.decision_recommendation.v1",
        recommended_first_bet: "artifacts/opportunity-a.json",
        alternative_bets: ["artifacts/opportunity-b.json"],
        rejected_or_watchlist_refs: ["artifacts/rejected.json", "artifacts/watch.json"],
      },
    ],
    [
      "artifacts/portfolio.json",
      {
        schema_version: "startup_opportunity.portfolio_view.v1",
        recommended_first_bet: "artifacts/opportunity-a.json",
        alternative_bets: ["artifacts/opportunity-b.json"],
        rejected_refs: ["artifacts/rejected.json"],
        watchlist_refs: ["artifacts/watch.json"],
      },
    ],
    ["artifacts/opportunity-a.json", { opportunity_id: "opportunity_a" }],
    ["artifacts/opportunity-b.json", { opportunity_id: "opportunity_b" }],
    ["artifacts/rejected.json", { opportunity_id: "rejected" }],
    ["artifacts/watch.json", { opportunity_id: "watch" }],
  ]);
  assert.deepEqual(
    deriveNonTerminalReportSubjectIds("startup_opportunity.report.v1", report, documents),
    ["opportunity_a", "opportunity_b"],
  );
});

test("final subject labels bind the exact immutable revision instead of the first matching ID", () => {
  const refR1 = "artifacts/opportunity-c.r1.json";
  const refR2 = "artifacts/opportunity-c.r2.json";
  const envelopes = new Map<string, FormalArtifactEnvelope>([
    [
      "artifacts/recommendation.json",
      {
        artifact_path: "artifacts/recommendation.json",
        artifact_type: "startup_opportunity.decision_recommendation.v1",
        content_hash: `sha256:${"a".repeat(64)}`,
        document: {
          schema_version: "startup_opportunity.decision_recommendation.v1",
          recommended_first_bet: refR2,
          alternative_bets: [],
        },
      } as unknown as FormalArtifactEnvelope,
    ],
    [
      "artifacts/portfolio.json",
      {
        artifact_path: "artifacts/portfolio.json",
        artifact_type: "startup_opportunity.portfolio_view.v1",
        content_hash: `sha256:${"b".repeat(64)}`,
        document: {
          schema_version: "startup_opportunity.portfolio_view.v1",
          recommended_first_bet: refR2,
          alternative_bets: [],
        },
      } as unknown as FormalArtifactEnvelope,
    ],
    ...[
      [refR1, "OLD", "c"],
      [refR2, "CURRENT", "d"],
    ].map(([ref, title, hash]): [string, FormalArtifactEnvelope] => [
      ref as string,
      {
        artifact_path: ref as string,
        artifact_type: "startup_opportunity.opportunity_thesis.v1",
        content_hash: `sha256:${String(hash).repeat(64)}`,
        document: {
          schema_version: "startup_opportunity.opportunity_thesis.v1",
          opportunity_id: "c",
          title,
        },
      } as unknown as FormalArtifactEnvelope,
    ]),
  ]);
  const report = {
    decision_recommendation_ref: "artifacts/recommendation.json",
    portfolio_view_ref: "artifacts/portfolio.json",
    top_opportunity_refs: [refR2],
  };
  const authorities = deriveNonTerminalReportSubjectAuthorities(
    "startup_opportunity.report.v1",
    report,
    envelopes,
  );
  assert.deepEqual(deriveReportSubjectLabels(authorities, envelopes), [
    {
      subject_id: "c",
      subject_ref: refR2,
      subject_content_hash: `sha256:${"d".repeat(64)}`,
      label: "CURRENT",
    },
  ]);
});

test("Chinese report localization maps exact structured values without rewriting research prose", () => {
  assert.equal(
    localizedFixedReportTerm("current_evidence_cannot_support_a_directional_conclusion", true),
    "当前材料不足以支持方向性结论",
  );
  assert.equal(
    userVisibleText("current_evidence_cannot_support_a_directional_conclusion", true),
    "current_evidence_cannot_support_a_directional_conclusion",
  );
  assert.equal(
    userVisibleText(
      "current_evidence_cannot_support_a_directional_conclusion appears as quoted research text.",
      true,
    ),
    "current_evidence_cannot_support_a_directional_conclusion appears as quoted research text.",
  );
  assert.equal(localizedEnum("watch", true), "持续观察");
  assert.throws(() => localizedEnum("new_unmapped_contract_enum", true), /mapping is missing/u);
  assert.deepEqual(
    [
      "native_app",
      "mini_program",
      "mobile_web",
      "PWA",
      "hybrid_app",
      "platform_native",
      "service_assisted",
      "status_quo",
      "not_applicable",
    ].map((value) => localizedDeliveryForm(value, true)),
    [
      "原生应用",
      "小程序",
      "移动网页",
      "渐进式网页应用",
      "混合应用",
      "平台原生形态",
      "服务辅助形态",
      "现状",
      "不适用",
    ],
  );
  assert.equal(localizedDeliveryForm("mobile_web", false), "mobile_web");
  assert.throws(
    () => localizedDeliveryForm("desktop_app", true),
    /report localized delivery_form mapping is missing for desktop_app/u,
  );

  const legitimateProse = [
    "Google Cloud Audit Logs helps users inspect changes.",
    "Schema.org vocabulary",
    "Evidence Based Design",
    "mobile_web.delivery_form",
    "com.example.product_protocol",
    "service",
    "baseline",
    "evidence",
    "platform",
    "普通 dotted 文本 foo.bar 和普通网址 https://example.invalid/source 可以保留。",
  ];
  for (const text of legitimateProse) {
    assert.equal(userVisibleText(text, true), text);
    assert.deepEqual(localizedInternalLeakageIssues("zh-CN", text), []);
    assert.deepEqual(
      localizedTerminalSourceIssues({
        research_language: "zh-CN",
        decision_question: text,
        sources: [],
        report_citations: [],
      }),
      [],
    );
    assert.deepEqual(
      localizedTerminalUserViewIssues(
        { research_language: "zh-CN", sources: [], report_citations: [] },
        text,
      ),
      [],
    );
  }
});

test("Chinese commercial report tables preserve legitimate research terminology", () => {
  const rendered = renderResearchCoverageGaps(
    {
      report_subject_labels: [{ subject_id: "subject_a", label: "service" }],
      research_coverage_gaps: [
        {
          coverage_kind: "research",
          subject_ids: ["subject_a"],
          dimension: "mobile_web.delivery_form",
          state: "unavailable",
          query_attempts: [],
          reason: "baseline",
          alternative_metric: "evidence",
          decision_impact: "platform",
          decision_relevance: "non_blocking",
        },
        {
          coverage_kind: "research",
          subject_ids: ["subject_a"],
          dimension: "open_data.product_protocol",
          state: "partial",
          query_attempts: [
            {
              acquisition_method: "public_api",
              provider: "Google Cloud Audit Logs",
              outcome: "no_data",
              reason: "Schema.org vocabulary and Evidence Based Design are legal source terms.",
            },
          ],
          reason: "Schema.org vocabulary and Evidence Based Design are legal source terms.",
          alternative_metric: "open_data.product_protocol",
          decision_impact: "Google Cloud Audit Logs helps users inspect changes.",
          decision_relevance: "non_blocking",
        },
      ],
    },
    true,
  );
  assert.match(rendered, /\| service \|/u);
  assert.match(rendered, /\| .*baseline.* \| evidence \| platform \|/u);
  assert.match(rendered, /公开接口 \/ Google Cloud Audit Logs \/ 没有数据/u);
  assert.match(rendered, /Google Cloud Audit Logs/u);
  assert.match(rendered, /mobile_web\.delivery_form/u);
  assert.match(rendered, /Schema\.org vocabulary/u);
  assert.match(rendered, /Evidence Based Design/u);
  assert.match(rendered, /open_data\.product_protocol/u);
  assert.doesNotMatch(rendered, /服务/u);
  assert.doesNotMatch(rendered, /基线/u);
  assert.doesNotMatch(rendered, /平台/u);
  assert.doesNotMatch(rendered, /结构合同\.org/u);
  assert.doesNotMatch(rendered, /证据 Based Design/u);
  assert.doesNotMatch(rendered, /结构化诊断/u);
  assert.doesNotMatch(rendered, /商业研究记录 Logs/u);
});

test("Chinese quantitative tables keep free comparability labels while enum fields localize", () => {
  const rendered = renderQuantitativeSignalTable(
    {
      report_subject_labels: [{ subject_id: "subject_a", label: "Subject A" }],
      report_citations: [],
      quantitative_signal_rows: [
        {
          observation: {
            subject_id: "subject_a",
            metric_family: "commercial_behavior",
            metric_name: "paid users",
            metric_semantics: "paid_customers",
            value: { shape: "point", value: 10, unit: "users", currency: null },
            metric_definition: "service",
            geography: "platform",
            period: {
              period_start: null,
              period_end: null,
              as_of: "2026-08-01",
              label: "baseline",
            },
            measurement_type: "direct_measurement",
            comparability: {
              status: "comparable",
              category: "service",
              direct_comparison_allowed: true,
            },
            error_uncertainty: "evidence",
            evidence_refs: [],
            decision_use: { grade: "decision_grade" },
          },
        },
      ],
    },
    true,
  );
  assert.match(rendered, /商业行为 \/ paid users \(付费客户\)/u);
  assert.match(rendered, /决策级 \/ 直接测量/u);
  assert.match(rendered, /可比较; service; 可直接比较/u);
  assert.match(rendered, /\| service \| platform \| baseline; 截至 2026-08-01/u);
  assert.doesNotMatch(rendered, /可比较; 服务; 可直接比较/u);
});

test("Chinese commercial report enum projection fails closed for unmapped enum values", () => {
  assert.throws(
    () =>
      renderResearchCoverageGaps(
        {
          report_subject_labels: [{ subject_id: "subject_a", label: "Subject A" }],
          research_coverage_gaps: [
            {
              coverage_kind: "research",
              subject_ids: ["subject_a"],
              dimension: "query outcome",
              state: "partial",
              query_attempts: [
                {
                  acquisition_method: "public_api",
                  provider: "Synthetic provider",
                  outcome: "new_unknown_outcome",
                  reason: "Synthetic reason.",
                },
              ],
              reason: "Synthetic reason.",
              alternative_metric: null,
              decision_impact: "Synthetic impact.",
              decision_relevance: "non_blocking",
            },
          ],
        },
        true,
      ),
    /commercial report localized enum mapping is missing for query_attempt\.outcome: new_unknown_outcome/u,
  );
});

test("Chinese commercial coverage gap enum projection covers current schema values", () => {
  const rendered = renderResearchCoverageGaps(
    {
      report_subject_labels: [{ subject_id: "subject_a", label: "Subject A" }],
      research_coverage_gaps: [
        {
          coverage_kind: "incumbent_response",
          coverage: {
            subject_id: "subject_a",
            state: "unknown",
            decision_impact: "Context only; no automatic decision effect.",
            reason: "Synthetic responder research gap.",
            data_gaps: ["baseline", "evidence"],
          },
          decision_relevance: "context_only",
        },
      ],
    },
    true,
  );
  assert.match(rendered, /头部公司吸收与响应风险/u);
  assert.match(rendered, /未知/u);
  assert.match(rendered, /baseline<br>evidence/u);
  assert.doesNotMatch(rendered, /incumbent_response/u);
  assert.doesNotMatch(rendered, /absorption_and_response_risk/u);
});

test("Chinese terminal boundary reports only structure-bound Harness diagnostic leaks", () => {
  const source = terminalAuditSource({
    gate_warnings: [
      {
        code: "terminal_reporting.search_closure_incomplete",
        severity: "warning",
        category: "integrity",
        message:
          "A planned Search Closure is missing; the report discloses incomplete execution and the related decision limit.",
        decision_impact:
          "A planned Search Closure is missing; the report discloses incomplete execution and the related decision limit.",
      },
    ],
  });
  const localized = renderTerminalAuditAppendix(source);
  assert.match(localized, /计划中的搜索完成记录缺失/);
  assert.doesNotMatch(localized, /terminal_reporting\.search_closure_incomplete/u);
  assert.doesNotMatch(localized, /A planned Search Closure is missing/u);
  assert.deepEqual(localizedTerminalSourceIssues(source), []);
  assert.deepEqual(localizedTerminalUserViewIssueDetails(source, localized, "audit_appendix"), []);

  const fakeCallerBlock = [
    "## 非阻塞诊断",
    "- [警告 / 覆盖度] Evidence Based Design 决策影响: No decision effect",
    "## 研究来源沿袭",
  ].join("\n");
  const callerInjected = localized.replace(
    "\n## 完整研究覆盖缺口\n",
    `\n${fakeCallerBlock}\n\n## 完整研究覆盖缺口\n`,
  );
  assert.deepEqual(
    localizedTerminalUserViewIssueDetails(source, callerInjected, "audit_appendix"),
    [],
  );

  const rawRow = renderGateWarnings(source, false).trim();
  const broken = localized.replace(renderGateWarnings(source, true).trim(), rawRow);
  const issues = localizedTerminalUserViewIssueDetails(source, broken, "audit_appendix");
  assert.deepEqual(
    issues.map((issue) => [issue.field, issue.matched_text]),
    [["#/gate_warnings/0", rawRow]],
  );

  const missing = localized.replace(renderGateWarnings(source, true).trim(), "");
  assert.deepEqual(
    localizedTerminalUserViewIssueDetails(source, missing, "audit_appendix").map(
      (issue) => issue.code,
    ),
    ["localized_harness_diagnostic_missing"],
  );
  const missingSection = localized.replace(
    `\n## 非阻塞诊断\n${renderGateWarnings(source, true)}\n## 研究来源沿袭\n`,
    "\n## 研究来源沿袭\n",
  );
  assert.deepEqual(
    localizedTerminalUserViewIssueDetails(source, missingSection, "audit_appendix").map(
      (issue) => issue.code,
    ),
    ["localized_harness_diagnostic_section_missing"],
  );

  const extra = localized.replace(
    renderGateWarnings(source, true).trim(),
    `${renderGateWarnings(source, true).trim()}\n- [警告 / 覆盖度] 额外诊断 决策影响: 额外影响`,
  );
  assert.deepEqual(
    localizedTerminalUserViewIssueDetails(source, extra, "audit_appendix").map(
      (issue) => issue.code,
    ),
    ["localized_harness_diagnostic_drift"],
  );

  const drift = localized.replace("计划中的搜索完成记录缺失。", "搜索完成记录已经关闭。");
  assert.deepEqual(
    localizedTerminalUserViewIssueDetails(source, drift, "audit_appendix")
      .map((issue) => issue.code)
      .sort(),
    ["localized_harness_diagnostic_drift", "localized_harness_diagnostic_missing"],
  );
});

test("Chinese terminal audit diagnostic closure ignores earlier legal section-title prose", () => {
  const source = terminalAuditSource();
  const localized = renderTerminalAuditAppendix(source);
  const altered = localized.replace(
    "\n## 完整研究覆盖缺口\n",
    "\n研究原文包含标题：\n## 材料采用、限制与排除\n\n## 完整研究覆盖缺口\n",
  );
  assert.deepEqual(localizedTerminalUserViewIssueDetails(source, altered, "audit_appendix"), []);

  const missingDiagnostic = localized.replace(
    `\n## 非阻塞诊断\n${renderGateWarnings(source, true)}\n## 研究来源沿袭\n`,
    "\n## 研究来源沿袭\n",
  );
  assert.deepEqual(
    localizedTerminalUserViewIssueDetails(source, missingDiagnostic, "audit_appendix").map(
      (issue) => issue.code,
    ),
    ["localized_harness_diagnostic_section_missing"],
  );

  const missingProvenance = localized.replace("\n## 研究来源沿袭\n", "\n## 来源沿袭缺失\n");
  assert.deepEqual(
    localizedTerminalUserViewIssueDetails(source, missingProvenance, "audit_appendix").map(
      (issue) => issue.code,
    ),
    ["localized_harness_diagnostic_section_missing"],
  );
});

test("Chinese terminal warning validation ignores legal prose collisions outside diagnostic rows", () => {
  const source = {
    research_language: "zh-CN",
    sources: [{ title: "Evidence Based Design", url: "https://example.invalid/source" }],
    report_citations: [
      {
        label: "Evidence Based Design",
        url: "https://example.invalid/citation",
        source_access: "public",
      },
    ],
    gate_warnings: [
      {
        code: "third_party.product_protocol",
        severity: "warning",
        category: "coverage",
        message: "Evidence Based Design",
        decision_impact: "No decision effect",
      },
    ],
  };
  const callerProse = [
    "## 非阻塞诊断",
    "- [警告 / 覆盖度] Evidence Based Design 决策影响: No decision effect",
    "[Evidence Based Design](https://example.invalid/source)",
    "[Evidence Based Design](https://example.invalid/citation)",
    "正文 Evidence Based Design 是被评估的产品名称。",
    "供应商原文写道：No decision effect。",
    "第三方 API 标识 third_party.product_protocol 合法出现在研究正文。",
  ].join("\n");
  assert.deepEqual(
    localizedTerminalUserViewIssueDetails(source, callerProse, "decision_brief"),
    [],
  );
  assert.deepEqual(localizedTerminalUserViewIssueDetails(source, callerProse, "report"), []);
  assert.deepEqual(localizedTerminalUserViewIssues(source, callerProse), []);
});

test("Chinese unknown gate diagnostic fallback does not erase possible decision impact", () => {
  const source = terminalAuditSource({
    gate_warnings: [
      {
        code: "synthetic.coverage_blocks_ranking",
        severity: "warning",
        category: "coverage",
        message: "Synthetic coverage warning.",
        decision_impact: "This direction must remain unranked until buyer coverage closes.",
      },
      {
        code: "synthetic.decision_validity_limits_conclusion",
        severity: "warning",
        category: "decision_validity",
        message: "Synthetic decision validity warning.",
        decision_impact: "This report cannot support a directional conclusion.",
      },
    ],
  });
  const rendered = renderGateWarnings(source, true);
  assert.match(rendered, /可能表示覆盖不足，并约束相关排序、建议或结论强度/u);
  assert.match(rendered, /可能约束排序、建议或结论强度/u);
  assert.match(rendered, /原始决策影响/u);
  assert.doesNotMatch(rendered, /只用于审计披露/u);
  assert.doesNotMatch(rendered, /不能提高结论强度/u);
  assert.deepEqual(
    localizedTerminalUserViewIssueDetails(
      source,
      renderTerminalAuditAppendix(source),
      "audit_appendix",
    ),
    [],
  );
});

test("Discovery source dispositions retain exact canonical identity and a distinct specific reason", () => {
  const manifestRef = "evidence/source-manifest.json";
  const traceabilityRef = "artifacts/traceability.json";
  const envelopes = new Map<string, FormalArtifactEnvelope>([
    [
      manifestRef,
      {
        artifact_path: manifestRef,
        artifact_type: "startup_opportunity.source_manifest.discovery_evaluation.current",
        content_hash: `sha256:${"1".repeat(64)}`,
        document: {
          schema_version: "startup_opportunity.source_manifest.discovery_evaluation.current",
          accepted_evidence_refs: [],
          rejected_source_records: [
            {
              source: { kind: "public_url", canonical_url: "https://canonical.invalid/rejected" },
              source_label: "Rejected source",
              rejection_reason: "Duplicate of the accepted primary record.",
            },
          ],
          unavailable_source_records: [
            {
              source: {
                kind: "user_provided",
                canonical_uri: "urn:startup-opportunity:user-provided:missing-sheet",
              },
              source_label: "Missing customer sheet",
              unavailable_reason: "The user did not provide the referenced sheet.",
              notes: "No inference was made from the absent material.",
            },
          ],
        },
      } as unknown as FormalArtifactEnvelope,
    ],
    [
      traceabilityRef,
      {
        artifact_path: traceabilityRef,
        artifact_type: "startup_opportunity.traceability.discovery.current",
        content_hash: `sha256:${"2".repeat(64)}`,
        document: {
          schema_version: "startup_opportunity.traceability.discovery.current",
          statements: [],
        },
      } as unknown as FormalArtifactEnvelope,
    ],
  ]);
  const projection = deriveReportDispositions(
    "startup_opportunity.report.v1",
    { source_manifest_refs: [manifestRef], traceability_ref: traceabilityRef },
    envelopes,
  );
  assert.deepEqual(
    projection.reportSourceDispositions.map((entry) => ({
      source: entry.source,
      label: entry.source_label,
      disposition: entry.disposition,
      reasons: entry.reasons,
      notes: entry.notes,
      authority: entry.authority_bindings,
    })),
    [
      {
        source: { kind: "public_url", canonical_url: "https://canonical.invalid/rejected" },
        label: "Rejected source",
        disposition: "excluded",
        reasons: ["Duplicate of the accepted primary record."],
        notes: undefined,
        authority: [{ ref: manifestRef, content_hash: `sha256:${"1".repeat(64)}` }],
      },
      {
        source: {
          kind: "user_provided",
          canonical_uri: "urn:startup-opportunity:user-provided:missing-sheet",
        },
        label: "Missing customer sheet",
        disposition: "unavailable",
        reasons: ["The user did not provide the referenced sheet."],
        notes: "No inference was made from the absent material.",
        authority: [{ ref: manifestRef, content_hash: `sha256:${"1".repeat(64)}` }],
      },
    ],
  );
});

test("core quantitative summary uses decision-grade rows while full table preserves proxy context", () => {
  const source = {
    report_subject_labels: [{ subject_id: "subject_a", label: "Subject A" }],
    report_citations: [
      {
        evidence_ref: "evidence/decision.json",
        label: "Decision source",
        source_access: "public",
        url: "https://canonical.synthetic.invalid/decision",
      },
      {
        evidence_ref: "evidence/proxy.json",
        label: "Proxy source",
        source_access: "public",
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
  assert.equal(citations[0]?.source_access, "public");
  assert.equal(citations.length, 1);
});

test("user-provided Evidence remains traceable without a forged public URL", () => {
  const evidenceRef = "evidence/user-provided.json";
  const recordRef = "evidence/manifest.jsonl#ev_user";
  const citations = deriveReportCitations(
    [
      {
        path: evidenceRef,
        document: {
          schema_version: "startup_opportunity.evidence.assessment.current",
          source_name: "Customer-provided operating extract",
          mechanical_binding: { substrate_record_ref: recordRef },
        },
      },
    ],
    new Map([
      [
        recordRef,
        {
          source: {
            kind: "user_provided",
            canonical_uri: "urn:startup-opportunity:user-provided:operating-extract",
          },
        },
      ],
    ]),
    { evidence_refs: [evidenceRef] },
  );
  assert.deepEqual(citations, [
    {
      evidence_ref: evidenceRef,
      label: "Customer-provided operating extract",
      source_access: "user_provided_non_public",
      canonical_uri: "urn:startup-opportunity:user-provided:operating-extract",
    },
  ]);
  const canonical = canonicalizeReadableSources(
    [
      {
        evidence_ref: evidenceRef,
        title: "Forged public title",
        url: "https://forged.synthetic.invalid/source",
      },
    ],
    citations,
  );
  assert.equal(canonical.sources[0]?.source_access, "user_provided_non_public");
  assert.equal(
    canonical.sources[0]?.canonical_uri,
    "urn:startup-opportunity:user-provided:operating-extract",
  );
  assert.equal(canonical.sources[0]?.url, undefined);
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
        source_access: "public",
        url: "https://canonical.synthetic.invalid/a",
      },
      {
        evidence_ref: "evidence/b.json",
        label: "Source B",
        source_access: "public",
        url: "https://canonical.synthetic.invalid/b",
      },
    ],
    quantitative_signal_rows: [],
    competitive_substitute_rows: [],
    incumbent_response_risk_rows: [],
    current_decision_subject_ids: [],
    research_coverage_gaps: [],
    gate_warnings: [],
    report_evidence_dispositions: [
      {
        evidence_ref: "evidence/a.json",
        evidence_content_hash: `sha256:${"a".repeat(64)}`,
        disposition: "excluded",
        reasons: ["context only"],
        authority_bindings: [],
      },
      {
        evidence_ref: "evidence/b.json",
        evidence_content_hash: `sha256:${"b".repeat(64)}`,
        disposition: "excluded",
        reasons: ["context only"],
        authority_bindings: [],
      },
    ],
    report_source_dispositions: [],
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
  assert.equal(appendix.match(/\*\*excluded: context only\*\*/gu)?.length, 1);
  assert.match(appendix, /1\. \[Source A\]/u);
  assert.match(appendix, /2\. \[Source B\]/u);
  assert.match(appendix, /Source A.*canonical\.synthetic\.invalid\/a/su);
  assert.match(appendix, /Source B.*canonical\.synthetic\.invalid\/b/su);
  assert.equal(deriveReportStatistics(source).excluded_evidence_count, 2);
});

test("terminal report preserves full planned commercial gaps when core has no final subject", () => {
  const fullProjection = fullCommercialProjection("planned_but_missing");
  const source = terminalSource({
    full_commercial_projection: fullProjection,
    gate_warnings: [commercialWarning()],
    audit_refs: ["adaptations/decisions/adapt-runtime.json", TERMINAL_MISSING_TASK_REF],
  });
  assert.equal((source.commercial_research_status as Record<string, unknown>).state, "not_planned");
  assert.equal(
    (fullProjection.commercial_research_status as Record<string, unknown>).state,
    "planned_but_missing",
  );
  const statistics = deriveReportStatistics(source);
  assert.equal(statistics.full_gap_row_count, 1);
  assert.equal(statistics.critical_gap_group_count, 1);

  const appendix = renderTerminalAuditAppendix(source);
  assert.match(appendix, /critical gap groups 1/u);
  assert.match(appendix, /execution \/ research/u);
  assert.match(appendix, /planned commercial research task has no current valid Audit artifact/u);
  assert.doesNotMatch(appendix, /No formal commercial research task was planned/u);

  const derived = deriveTerminalReportDocuments(terminalEnvelope(source));
  const brief = String(
    derived.find(
      (entry) => entry.artifactType === "startup_opportunity.decision_brief.terminal.current",
    )?.document.markdown,
  );
  const report = String(
    derived.find((entry) => entry.artifactType === "startup_opportunity.terminal_report_view.v1")
      ?.document.markdown,
  );
  assert.match(brief, /full gap rows 1/u);
  assert.match(brief, /critical gap groups 1/u);
  assert.match(report, /full gap rows 1/u);
  assert.match(report, /critical gap groups 1/u);
  assert.doesNotMatch(report, /No formal commercial research task was planned/u);

  const consistency = terminalConsistency(source);
  assert.equal(consistency.evaluator_result, "passed");
  assert.deepEqual(consistency.evaluation_issues, []);
});

test("terminal commercial consistency accepts structured planned execution states", () => {
  const sources = [
    terminalSource({ full_commercial_projection: fullCommercialProjection("complete") }),
    terminalSource({ full_commercial_projection: fullCommercialProjection("planned_with_gaps") }),
    terminalSource({ full_commercial_projection: fullCommercialProjection("not_planned") }),
    terminalSource({
      full_commercial_projection: fullCommercialProjection("planned_but_missing"),
      gate_warnings: [commercialWarning()],
    }),
  ];
  for (const source of sources) {
    const consistency = terminalConsistency(source);
    assert.equal(consistency.evaluator_result, "passed");
    assert.deepEqual(consistency.evaluation_issues, []);
  }
});

test("terminal commercial consistency ignores caller-authored literal prose", () => {
  const base = terminalSource();
  const baseExecution = base.execution as Record<string, unknown>;
  const baseConclusion = base.research_conclusion as Record<string, unknown>;
  const literal =
    "Caller-authored literal: No formal commercial research task was planned; Research status is incomplete.";
  const source = terminalSource({
    execution: {
      ...baseExecution,
      required_followups: [
        {
          followup_id: "caller_literal_followup",
          status: "not_executed",
          detail: literal,
          related_refs: ["adaptations/decisions/adapt-runtime.json"],
        },
      ],
    },
    research_conclusion: {
      ...baseConclusion,
      current_recommendation: literal,
      meaning: "This sentence is caller-authored prose, not a commercial execution status.",
    },
    limitations: [literal],
    full_commercial_projection: fullCommercialProjection("planned_but_missing"),
    gate_warnings: [commercialWarning()],
  });
  const derived = deriveTerminalReportDocuments(terminalEnvelope(source));
  const brief = String(
    derived.find(
      (entry) => entry.artifactType === "startup_opportunity.decision_brief.terminal.current",
    )?.document.markdown,
  );
  const report = String(
    derived.find((entry) => entry.artifactType === "startup_opportunity.terminal_report_view.v1")
      ?.document.markdown,
  );
  assert.match(brief, /No formal commercial research task was planned/u);
  assert.match(report, /Research status is incomplete/u);
  const consistency = terminalConsistency(source);
  assert.equal(consistency.evaluator_result, "passed");
  assert.deepEqual(consistency.evaluation_issues, []);
});

test("terminal commercial consistency fails closed on contradictory structured execution", () => {
  const baseExecution = terminalSource().execution as Record<string, unknown>;
  const cases: readonly {
    readonly source: Record<string, unknown>;
    readonly issueCode: string;
  }[] = [
    {
      source: terminalSource({
        full_commercial_projection: fullCommercialProjection("not_planned", {
          plannedTaskRefs: [TERMINAL_MISSING_TASK_REF],
        }),
        gate_warnings: [commercialWarning()],
      }),
      issueCode: "commercial_not_planned_status_has_planned_refs",
    },
    {
      source: terminalSource({
        full_commercial_projection: fullCommercialProjection("planned_but_missing", { gaps: [] }),
        gate_warnings: [commercialWarning()],
      }),
      issueCode: "commercial_missing_task_gap_absent",
    },
    {
      source: terminalSource({
        full_commercial_projection: fullCommercialProjection("planned_but_missing"),
      }),
      issueCode: "commercial_missing_task_warning_absent",
    },
    {
      source: terminalSource({
        execution: { ...baseExecution, completeness: "complete" },
        full_commercial_projection: fullCommercialProjection("planned_but_missing"),
        gate_warnings: [commercialWarning()],
      }),
      issueCode: "commercial_missing_task_claimed_complete_execution",
    },
    {
      source: terminalSource({
        full_commercial_projection: fullCommercialProjection("planned_but_missing", {
          submittedAuditRefs: [TERMINAL_SUBMITTED_AUDIT_REF],
        }),
        gate_warnings: [commercialWarning()],
      }),
      issueCode: "commercial_planned_but_missing_status_incoherent",
    },
    {
      source: terminalSource({
        full_commercial_projection: fullCommercialProjection("complete"),
        gate_warnings: [commercialWarning()],
      }),
      issueCode: "commercial_complete_status_has_missing_work",
    },
  ];
  for (const { source, issueCode } of cases) {
    const consistency = terminalConsistency(source);
    assert.equal(consistency.evaluator_result, "failed");
    assert.ok(
      (consistency.evaluation_issues as Record<string, unknown>[]).some(
        (issue) => issue.code === issueCode,
      ),
      JSON.stringify(consistency.evaluation_issues, null, 2),
    );
  }
});

test("terminal validator rejects structured sidecar drift", () => {
  const source = terminalSource({
    full_commercial_projection: fullCommercialProjection("planned_but_missing"),
    gate_warnings: [commercialWarning()],
  });
  const derived = deriveTerminalReportDocuments(terminalEnvelope(source));
  const documents = [
    reportingDocument(TERMINAL_SOURCE_REF, "startup_opportunity.terminal_report_source.v1", source),
    ...derived.map((entry) =>
      reportingDocument(entry.artifactPath, entry.artifactType, structuredClone(entry.document)),
    ),
  ];
  const brief = documents.find(
    (entry) => entry.schemaVersion === "startup_opportunity.decision_brief.terminal.current",
  );
  assert.ok(brief);
  const execution = brief.document.execution as Record<string, unknown>;
  brief.document.execution = { ...execution, completeness: "complete" };
  if (brief.envelope !== null) brief.envelope.content_hash = canonicalContentHash(brief.document);
  const expectedBrief = derived.find(
    (entry) => entry.artifactType === "startup_opportunity.decision_brief.terminal.current",
  );
  assert.ok(expectedBrief);
  assert.equal(terminalReportDocumentsEqual(brief.document, expectedBrief.document), false);
  const issues = validateTerminalReportingContract(documents);
  assert.ok(
    issues.some((issue) => issue.code === "terminal_reporting.derived_drift"),
    JSON.stringify(issues, null, 2),
  );
});

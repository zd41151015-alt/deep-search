import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildArtifactScaffold,
  classifyReference,
  createArtifactValidator,
  validateCommercialResearchContract,
} from "../harness/src/index.js";
import {
  renderCompetitiveSubstituteMatrix,
  renderQuantitativeSignalTable,
  renderResearchCoverageGaps,
} from "../harness/src/reporting/commercial-report-tables.js";
import { localizedTerminalUserViewIssues } from "../harness/src/reporting/terminal-reporting.js";
import type { CommercialResearchPolicy } from "../harness/src/validators/commercial-research-validator.js";
import {
  commercialReportProjection,
  unavailableQuantitativeCompetitiveCoverage,
} from "./fixtures/quantitative-competitive-fixture.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function commercialAudit(): Record<string, unknown> {
  const uncovered = [
    "recent_user_language",
    "purchase_signal",
    "alternatives_pricing_usage",
    "distribution_channel",
    "independent_counterevidence",
  ];
  return {
    schema_version: "startup_opportunity.commercial_research_audit.current",
    audit_id: "commercial_audit_synthetic",
    run_id: "current-only-commercial-synthetic",
    unit_id: "unit_commercial_synthetic",
    execution_plan_ref: "plans/research-execution.r1.json",
    dispatch_task_ref: "tasks/dispatch/commercial-synthetic.r1.json#task_commercial_synthetic",
    task_ref: "tasks/discovery/unit_commercial_synthetic.attempt-1.json",
    covered_direction_ids: ["direction_synthetic"],
    research_stage: "solution_neutral_scan",
    audited_at: "2026-08-04T12:10:00Z",
    planned_resource_allocation: {
      customer_commercial_percent: 65,
      market_structure_percent: 17,
      academic_percent: 18,
    },
    adopted_source_distribution: {
      total_adopted_sources: 0,
      customer_commercial_count: 0,
      market_structure_count: 0,
      academic_count: 0,
      customer_commercial_percent: 0,
      market_structure_percent: 0,
      academic_percent: 0,
      guidance_deviation_observed: false,
    },
    search_log: [
      {
        query_id: "query_commercial_synthetic",
        query: "synthetic user purchase behavior",
        searched_at: "2026-08-04T12:00:00Z",
        commercial_dimensions: ["user_language", "purchase"],
        candidate_results: [
          {
            url: "https://example.invalid/commercial-synthetic",
            title: "Synthetic rejected result",
            retrieved_at: "2026-08-04T12:01:00Z",
            published_at: "2026-08-01T00:00:00Z",
            observed_at: null,
            data_period_end: null,
            derived_valid_as_of: "2026-08-01",
            claim_type: "current_purchase_behavior",
            adopted_evidence_ref: null,
            rejection_reason: "Synthetic result does not contain observed behavior.",
          },
        ],
      },
    ],
    search_closure: {
      closure_id: "search_closure_unit_commercial_synthetic",
      lane_kind: "external_research",
      outcome: "evidence_insufficient",
      query_log_complete: false,
      telemetry_basis: "agent_supplied",
      remaining_gaps: uncovered,
      termination_reason: "Synthetic fixture reached its evidence ceiling.",
    },
    evidence_register: [],
    coverage: Object.fromEntries(
      uncovered.map((key) => [
        key,
        {
          state: "unknown",
          content_covered: false,
          evidence_refs: [],
          data_points: [],
          inference: null,
        },
      ]),
    ),
    uncovered_business_dimensions: uncovered,
    wave1_signals: { demand: false, buyer: false, purchase: false },
    stage_decision: "early_stop_insufficient_evidence",
    ranking_eligibility: "unranked_hypothesis",
    ...unavailableQuantitativeCompetitiveCoverage(["direction_synthetic"], "2026-08-04T12:10:00Z"),
    limitations: ["SYNTHETIC contract fixture; no research was performed."],
  };
}

async function commercialPolicy(): Promise<CommercialResearchPolicy> {
  const policy = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "harness/policies/research-publication.current.json"),
      "utf8",
    ),
  ) as { commercial_research_contract: CommercialResearchPolicy };
  return policy.commercial_research_contract;
}

function commercialCodes(
  document: Record<string, unknown>,
  policy: CommercialResearchPolicy,
): readonly string[] {
  return validateCommercialResearchContract(
    [
      {
        path: "artifacts/research-audits/commercial-synthetic.json",
        schemaVersion: String(document.schema_version),
        document,
      },
    ],
    policy,
  ).map((issue) => issue.code);
}

function quantitativeCommercialFixture(): {
  audit: Record<string, unknown>;
  documents: readonly {
    path: string;
    schemaVersion: string;
    document: Record<string, unknown>;
  }[];
  exactRecords: ReadonlyMap<string, Record<string, unknown>>;
} {
  const audit = commercialAudit();
  const evidenceId = `ev_${"a".repeat(64)}`;
  const evidenceRef = `evidence/records/${evidenceId}.json`;
  const substrateRef = `evidence/manifest.jsonl#${evidenceId}`;
  const rawHash = `sha256:${"b".repeat(64)}`;
  const rawRef = `evidence/raw/sha256-${"b".repeat(64)}.bin`;
  const retrievedAt = "2026-08-04T12:01:00Z";
  const search = (audit.search_log as Record<string, unknown>[])[0];
  assert.ok(search);
  search.candidate_results = [
    {
      url: "https://metrics.example.invalid/rank?market=US&q=synthetic",
      title: "Synthetic public metric response",
      retrieved_at: retrievedAt,
      published_at: null,
      observed_at: "2026-08-04T12:00:00Z",
      data_period_end: "2026-08-04",
      derived_valid_as_of: "2026-08-04",
      claim_type: "current_market_change",
      adopted_evidence_ref: evidenceRef,
      rejection_reason: null,
    },
  ];
  audit.evidence_register = [
    {
      evidence_ref: evidenceRef,
      source_kind: "independent",
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "current_market_change",
      retrieved_at: retrievedAt,
      published_at: null,
      observed_at: "2026-08-04T12:00:00Z",
      data_period_end: "2026-08-04",
      derived_valid_as_of: "2026-08-04",
      freshness_status: "current",
      coverage_keys: [],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  audit.adopted_source_distribution = {
    total_adopted_sources: 1,
    customer_commercial_count: 1,
    market_structure_count: 0,
    academic_count: 0,
    customer_commercial_percent: 100,
    market_structure_percent: 0,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  audit.data_acquisitions = [
    {
      acquisition_id: "acquisition_public_metric",
      acquisition_method: "webpage",
      provider: "Arbitrary Regional Metrics Cooperative",
      endpoint_or_query_redacted: "https://metrics.example.invalid/rank?market=US&q=synthetic",
      retrieved_at: retrievedAt,
      evidence_ref: evidenceRef,
      evidence_substrate_ref: substrateRef,
      raw_response_ref: rawRef,
      raw_response_hash: rawHash,
      access_basis: "public",
      credentials_stored: false,
      sensitive_headers_stored: false,
      access_control_bypassed: false,
      limitations: ["Synthetic metric fixture only."],
    },
  ];
  const observation = {
    observation_id: "observation_rank",
    subject_id: "direction_synthetic",
    metric_family: "demand_scale",
    metric_name: "category rank",
    metric_semantics: "rank",
    value: { shape: "point", value: 17, unit: "rank", currency: null },
    metric_definition: "Position within one synthetic category at the stated as-of date.",
    geography: "United States",
    period: {
      period_start: null,
      period_end: null,
      as_of: "2026-08-04",
      label: "2026-08-04 snapshot",
    },
    measurement_type: "proxy",
    estimation_method: "Platform-relative ordering supplied by the source.",
    sample_or_population: "All entries in one synthetic source category.",
    error_uncertainty: "Category membership and ranking method are source-defined.",
    comparability: {
      comparison_group: null,
      status: "limited",
      category: "synthetic category",
      geography_aligned: false,
      period_aligned: false,
      category_aligned: false,
      definition_aligned: false,
      measurement_aligned: false,
      direct_comparison_allowed: false,
      limitations: ["No cross-market direct comparison is allowed."],
    },
    interpretation_boundaries: [
      "not_purchase_count",
      "not_paid_customer_count",
      "not_market_validation",
    ],
    acquisition_id: "acquisition_public_metric",
    evidence_refs: [evidenceRef],
    limitations: ["Rank is a demand proxy, not a commercial outcome."],
  };
  audit.quantitative_observations = [observation];
  const quantitativeCoverage = audit.quantitative_coverage as Record<string, unknown>[];
  const demandCoverage = quantitativeCoverage.find(
    (coverage) => coverage.metric_family === "demand_scale",
  );
  assert.ok(demandCoverage);
  Object.assign(demandCoverage, {
    state: "observed",
    observation_ids: ["observation_rank"],
    query_attempts: [],
    reason: null,
    alternative_metric: null,
    decision_impact: "The proxy may inform follow-up selection but cannot validate demand.",
  });
  const evidenceDocument = {
    schema_version: "startup_opportunity.evidence.assessment.current",
    mechanical_binding: {
      substrate_record_ref: substrateRef,
      content_hash: rawHash,
      raw_content_ref: rawRef,
    },
  };
  return {
    audit,
    documents: [
      {
        path: evidenceRef,
        schemaVersion: "startup_opportunity.evidence.assessment.current",
        document: evidenceDocument,
      },
      {
        path: "artifacts/research-audits/commercial-synthetic.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: audit,
      },
    ],
    exactRecords: new Map([
      [
        substrateRef,
        {
          schema_version: "startup_opportunity.evidence_store_record.v2",
          content_hash: rawHash,
          raw_content_ref: rawRef,
          recorded_at: retrievedAt,
        },
      ],
    ]),
  };
}

function quantitativeCommercialCodes(
  fixture: ReturnType<typeof quantitativeCommercialFixture>,
  policy: CommercialResearchPolicy,
): readonly string[] {
  return validateCommercialResearchContract(fixture.documents, policy, fixture.exactRecords).map(
    (issue) => issue.code,
  );
}

test("current ref classifier separates all canonical reference classes", () => {
  const cases = [
    ["plans/research-plan.r1.json", "run_artifact", "plans/research-plan.r1.json", null],
    [
      "plans/research-plan.r1.json#question_one",
      "run_artifact_fragment",
      "plans/research-plan.r1.json",
      "question_one",
    ],
    [
      "plans/research-plan.r1.json#/research_questions/0",
      "json_pointer",
      "plans/research-plan.r1.json",
      "/research_questions/0",
    ],
    [
      "evidence/manifest.jsonl#ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "evidence_exact_record",
      "evidence/manifest.jsonl",
      "ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
    ["events.jsonl#event_one", "run_exact_record", "events.jsonl", "event_one"],
    [
      "harness/policies/adaptation.current.json#/actions/0",
      "repository_policy",
      "harness/policies/adaptation.current.json",
      "/actions/0",
    ],
    [
      "https://example.invalid/source#section-one",
      "external_url",
      "https://example.invalid/source",
      "section-one",
    ],
  ] as const;
  for (const [ref, kind, targetPath, fragment] of cases) {
    assert.deepEqual(classifyReference(ref), { ref, kind, targetPath, fragment });
  }
});

test("commercial coverage keeps incomplete candidates unranked and rejects academic or vendor substitution", async () => {
  const policy = await commercialPolicy();
  const unranked = commercialAudit();
  assert.deepEqual(commercialCodes(unranked, policy), []);

  const falselyRanked = structuredClone(unranked);
  falselyRanked.ranking_eligibility = "ranked";
  assert.ok(
    commercialCodes(falselyRanked, policy).includes(
      "commercial_research.ranking_eligibility_mismatch",
    ),
  );

  const academic = structuredClone(unranked);
  academic.evidence_register = [
    {
      evidence_ref: "evidence/records/academic-synthetic.json",
      source_kind: "academic",
      evidence_character: "mechanism",
      independence: "independent",
      coverage_keys: ["purchase_signal"],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  const academicCodes = commercialCodes(academic, policy);
  assert.ok(academicCodes.includes("commercial_research.academic_commercial_coverage"));

  const vendor = structuredClone(unranked);
  vendor.evidence_register = [
    {
      evidence_ref: "evidence/records/vendor-synthetic.json",
      source_kind: "vendor",
      evidence_character: "vendor_claim",
      independence: "interested_party",
      claim_type: "vendor_statement",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2018-01-01T00:00:00Z",
      observed_at: "2026-08-04T12:00:00Z",
      data_period_end: null,
      derived_valid_as_of: "2026-08-04",
      freshness_status: "current",
      coverage_keys: ["purchase_signal"],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  const vendorCoverage = vendor.coverage as Record<string, Record<string, unknown>>;
  vendorCoverage.purchase_signal = {
    state: "observed",
    content_covered: true,
    evidence_refs: ["evidence/records/vendor-synthetic.json"],
    data_points: [
      {
        evidence_ref: "evidence/records/vendor-synthetic.json",
        aspect: "purchase",
        fact_or_excerpt: "The vendor states that customers buy the product.",
      },
    ],
    inference: null,
  };
  const vendorCodes = commercialCodes(vendor, policy);
  assert.ok(vendorCodes.includes("commercial_research.vendor_claim_not_cross_validated"));
  assert.ok(vendorCodes.includes("commercial_research.coverage_state_mismatch"));

  const retentionAudit = structuredClone(unranked);
  const mechanismRef = "artifacts/evidence/independent-current-mechanism-synthetic.json";
  retentionAudit.evidence_register = [
    {
      evidence_ref: mechanismRef,
      source_kind: "independent",
      evidence_character: "mechanism",
      independence: "independent",
      claim_type: "academic_mechanism",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: "2026-08-01T00:00:00Z",
      data_period_end: null,
      derived_valid_as_of: "2026-08-01",
      freshness_status: "current",
      coverage_keys: ["purchase_signal"],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  const retentionCoverage = retentionAudit.coverage as Record<string, Record<string, unknown>>;
  retentionCoverage.purchase_signal = {
    state: "observed",
    content_covered: true,
    evidence_refs: [mechanismRef],
    data_points: [
      {
        evidence_ref: mechanismRef,
        aspect: "purchase",
        fact_or_excerpt: "A current independent paper describes a mechanism, not a purchase.",
      },
    ],
    inference: null,
  };
  const retentionDocuments = [
    {
      path: "tasks/discovery/unit_retention_synthetic.attempt-1.json",
      schemaVersion: "startup_opportunity.research_task.discovery_candidate.current",
      document: {
        commercial_research_requirements: {
          commercial_audit_output_path: "artifacts/research-audits/unit_retention_synthetic.json",
        },
      },
    },
    {
      path: "artifacts/research-audits/unit_retention_synthetic.json",
      schemaVersion: "startup_opportunity.commercial_research_audit.current",
      document: retentionAudit,
    },
    {
      path: "artifacts/discovery/lanes/unit_retention_synthetic.attempt-1.json",
      schemaVersion: "startup_opportunity.discovery_lane_result.v1",
      document: {
        task_ref: "tasks/discovery/unit_retention_synthetic.attempt-1.json",
        scored_candidates: [
          {
            candidate_ref: "artifacts/discovery/candidates/retention-synthetic.r1.json",
            supporting_refs: [mechanismRef],
          },
        ],
        pre_kill_decisions: [
          {
            candidate_ref: "artifacts/discovery/candidates/retention-synthetic.r1.json",
            disposition: "retained",
            retention_basis: "evidence",
          },
        ],
      },
    },
  ];
  assert.ok(
    validateCommercialResearchContract(retentionDocuments, policy)
      .map((issue) => issue.code)
      .includes("commercial_research.candidate_retention_without_direct_commercial_evidence"),
  );
});

test("planned search allocation is guidance while adopted distribution is Register-derived", async () => {
  const policy = await commercialPolicy();
  const audit = commercialAudit();
  audit.planned_resource_allocation = {
    customer_commercial_percent: 10,
    market_structure_percent: 10,
    academic_percent: 80,
  };
  assert.deepEqual(commercialCodes(audit, policy), []);

  const falseObservation = structuredClone(audit);
  (falseObservation.adopted_source_distribution as Record<string, unknown>).academic_percent = 80;
  assert.ok(
    commercialCodes(falseObservation, policy).includes(
      "commercial_research.adopted_distribution_mismatch",
    ),
  );

  const marketStructure = commercialAudit();
  const marketRef = "evidence/records/independent-market-structure-synthetic.json";
  const marketQuery = (marketStructure.search_log as Record<string, unknown>[])[0];
  assert.ok(marketQuery);
  const marketResult = (marketQuery.candidate_results as Record<string, unknown>[])[0];
  assert.ok(marketResult);
  Object.assign(marketResult, {
    adopted_evidence_ref: marketRef,
    rejection_reason: null,
    claim_type: "market_structure_regulatory",
    regulatory_effective_status: "effective",
    regulatory_status_verified_at: "2026-08-04T12:00:00Z",
    derived_valid_as_of: "2026-08-04",
  });
  marketStructure.evidence_register = [
    {
      evidence_ref: marketRef,
      source_kind: "independent",
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "market_structure_regulatory",
      regulatory_effective_status: "effective",
      regulatory_status_verified_at: "2026-08-04T12:00:00Z",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: null,
      data_period_end: null,
      derived_valid_as_of: "2026-08-04",
      freshness_status: "current",
      coverage_keys: [],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  marketStructure.adopted_source_distribution = {
    total_adopted_sources: 1,
    customer_commercial_count: 0,
    market_structure_count: 1,
    academic_count: 0,
    customer_commercial_percent: 0,
    market_structure_percent: 100,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  assert.deepEqual(commercialCodes(marketStructure, policy), []);

  const duplicate = structuredClone(marketStructure);
  duplicate.evidence_register = [
    ...(duplicate.evidence_register as Record<string, unknown>[]),
    structuredClone((duplicate.evidence_register as Record<string, unknown>[])[0]),
  ];
  const duplicateCodes = commercialCodes(duplicate, policy);
  assert.ok(duplicateCodes.includes("commercial_research.duplicate_evidence_ref"));
  assert.equal(duplicateCodes.includes("commercial_research.adopted_distribution_mismatch"), false);
});

test("commercial coverage distinguishes observation, inference, and dimension-specific facts", async () => {
  const policy = await commercialPolicy();
  const evidenceRef = "evidence/records/independent-purchase-synthetic.json";
  const inferred = commercialAudit();
  const firstQuery = (inferred.search_log as Record<string, unknown>[])[0];
  assert.ok(firstQuery);
  const searchResult = (firstQuery.candidate_results as Record<string, unknown>[])[0];
  assert.ok(searchResult);
  searchResult.adopted_evidence_ref = evidenceRef;
  searchResult.rejection_reason = null;
  inferred.evidence_register = [
    {
      evidence_ref: evidenceRef,
      source_kind: "independent",
      evidence_character: "inference",
      independence: "independent",
      claim_type: "current_purchase_behavior",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: "2026-08-03T00:00:00Z",
      data_period_end: null,
      derived_valid_as_of: "2026-08-03",
      freshness_status: "current",
      coverage_keys: ["purchase_signal"],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  inferred.adopted_source_distribution = {
    total_adopted_sources: 1,
    customer_commercial_count: 1,
    market_structure_count: 0,
    academic_count: 0,
    customer_commercial_percent: 100,
    market_structure_percent: 0,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  const inferredCoverage = inferred.coverage as Record<string, Record<string, unknown>>;
  inferredCoverage.purchase_signal = {
    state: "inferred",
    content_covered: true,
    evidence_refs: [evidenceRef],
    data_points: [],
    inference: {
      basis_refs: [evidenceRef],
      starting_point: "An independent source describes purchase-adjacent behavior.",
      reasoning: "The behavior may imply purchase intent, but no transaction is observed.",
      uncertainty: "Intent may not convert to payment.",
      validation_needed: "Observe a recent purchase or payment commitment.",
    },
  };
  assert.deepEqual(commercialCodes(inferred, policy), []);
  assert.equal(inferred.ranking_eligibility, "unranked_hypothesis");

  const disguisedObservation = structuredClone(inferred);
  const disguisedCoverage = disguisedObservation.coverage as Record<
    string,
    Record<string, unknown>
  >;
  disguisedCoverage.purchase_signal = {
    state: "observed",
    content_covered: true,
    evidence_refs: [evidenceRef],
    data_points: [
      {
        evidence_ref: evidenceRef,
        aspect: "purchase",
        fact_or_excerpt: "The source contains no directly observed purchase.",
      },
    ],
    inference: null,
  };
  assert.ok(
    commercialCodes(disguisedObservation, policy).includes(
      "commercial_research.coverage_state_mismatch",
    ),
  );

  const reusedFact = structuredClone(disguisedObservation);
  const reusedCoverage = reusedFact.coverage as Record<string, Record<string, unknown>>;
  reusedCoverage.recent_user_language = {
    state: "observed",
    content_covered: true,
    evidence_refs: [evidenceRef],
    data_points: [
      {
        evidence_ref: evidenceRef,
        aspect: "user_language",
        fact_or_excerpt: "The source contains no directly observed purchase.",
      },
    ],
    inference: null,
  };
  assert.ok(
    commercialCodes(reusedFact, policy).includes("commercial_research.coverage_data_point_reused"),
  );
});

test("retrieval time cannot refresh old observations and Search Closure reconciles adopted refs", async () => {
  const policy = await commercialPolicy();
  const stale = commercialAudit();
  const evidenceRef = "evidence/records/stale-user-language-synthetic.json";
  stale.evidence_register = [
    {
      evidence_ref: evidenceRef,
      source_kind: "independent",
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "recent_user_language",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2020-01-02T00:00:00Z",
      observed_at: "2020-01-01T00:00:00Z",
      data_period_end: null,
      derived_valid_as_of: "2020-01-01",
      freshness_status: "current",
      coverage_keys: ["recent_user_language"],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  stale.adopted_source_distribution = {
    total_adopted_sources: 1,
    customer_commercial_count: 1,
    market_structure_count: 0,
    academic_count: 0,
    customer_commercial_percent: 100,
    market_structure_percent: 0,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  const staleCodes = commercialCodes(stale, policy);
  assert.ok(staleCodes.includes("commercial_research.freshness_status_mismatch"));
  assert.ok(staleCodes.includes("commercial_research.search_evidence_reconciliation"));

  const recentBehavior = commercialAudit();
  const userRef = "evidence/records/user-language-2024-synthetic.json";
  const purchaseRef = "evidence/records/purchase-2025-synthetic.json";
  const recentQuery = (recentBehavior.search_log as Record<string, unknown>[])[0];
  assert.ok(recentQuery);
  recentQuery.candidate_results = [
    {
      url: "https://example.invalid/user-language-2024",
      title: "Synthetic 2024 user-language data",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2024-09-15T00:00:00Z",
      observed_at: null,
      data_period_end: "2024-09-01",
      derived_valid_as_of: "2024-09-01",
      claim_type: "recent_user_language",
      adopted_evidence_ref: userRef,
      rejection_reason: null,
    },
    {
      url: "https://example.invalid/purchase-2025",
      title: "Synthetic 2025 purchase data",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2025-03-01T00:00:00Z",
      observed_at: null,
      data_period_end: "2025-02-28",
      derived_valid_as_of: "2025-02-28",
      claim_type: "current_purchase_behavior",
      adopted_evidence_ref: purchaseRef,
      rejection_reason: null,
    },
  ];
  recentBehavior.evidence_register = [
    {
      evidence_ref: userRef,
      source_kind: "independent",
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "recent_user_language",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2024-09-15T00:00:00Z",
      observed_at: null,
      data_period_end: "2024-09-01",
      derived_valid_as_of: "2024-09-01",
      freshness_status: "current",
      coverage_keys: [],
      disposition: "adopted",
      exclusion_reason: null,
    },
    {
      evidence_ref: purchaseRef,
      source_kind: "independent",
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "current_purchase_behavior",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2025-03-01T00:00:00Z",
      observed_at: null,
      data_period_end: "2025-02-28",
      derived_valid_as_of: "2025-02-28",
      freshness_status: "current",
      coverage_keys: [],
      disposition: "adopted",
      exclusion_reason: null,
    },
  ];
  recentBehavior.adopted_source_distribution = {
    total_adopted_sources: 2,
    customer_commercial_count: 2,
    market_structure_count: 0,
    academic_count: 0,
    customer_commercial_percent: 100,
    market_structure_percent: 0,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  assert.deepEqual(commercialCodes(recentBehavior, policy), []);

  const stalePrice = structuredClone(recentBehavior);
  const stalePriceItem = (stalePrice.evidence_register as Record<string, unknown>[])[0];
  assert.ok(stalePriceItem);
  stalePriceItem.claim_type = "current_pricing";
  stalePriceItem.data_period_end = null;
  stalePriceItem.observed_at = "2026-01-01T00:00:00Z";
  stalePriceItem.derived_valid_as_of = "2026-01-01";
  assert.ok(
    commercialCodes(stalePrice, policy).includes("commercial_research.freshness_status_mismatch"),
  );

  const oldDataOnRecentPage = structuredClone(stale);
  const oldDataItem = (oldDataOnRecentPage.evidence_register as Record<string, unknown>[])[0];
  assert.ok(oldDataItem);
  oldDataItem.observed_at = "2026-08-03T00:00:00Z";
  oldDataItem.data_period_end = "2020-01-01";
  oldDataItem.derived_valid_as_of = "2026-08-03";
  assert.ok(
    commercialCodes(oldDataOnRecentPage, policy).includes(
      "commercial_research.valid_as_of_not_derived",
    ),
  );

  const closureMismatch = commercialAudit();
  (closureMismatch.search_closure as Record<string, unknown>).outcome = "search_not_required";
  assert.ok(
    commercialCodes(closureMismatch, policy).includes(
      "commercial_research.search_closure_kind_mismatch",
    ),
  );
  const earlyStopBeforeSearch = commercialAudit();
  earlyStopBeforeSearch.search_log = [];
  earlyStopBeforeSearch.search_closure = {
    closure_id: "search_closure_unit_commercial_synthetic",
    lane_kind: "external_research",
    outcome: "early_stop",
    query_log_complete: true,
    telemetry_basis: "agent_supplied",
    remaining_gaps: earlyStopBeforeSearch.uncovered_business_dimensions,
    termination_reason: "An upstream commercial signal gate stopped this lane before search.",
  };
  assert.ok(
    commercialCodes(earlyStopBeforeSearch, policy).includes(
      "commercial_research.search_closure_log_missing",
    ),
  );
  const telemetryOverclaim = commercialAudit();
  telemetryOverclaim.search_closure = {
    closure_id: "search_closure_unit_commercial_synthetic",
    lane_kind: "external_research",
    outcome: "evidence_insufficient",
    query_log_complete: true,
    telemetry_basis: "unavailable",
    remaining_gaps: [],
    termination_reason: "Synthetic telemetry is unavailable.",
  };
  assert.ok(
    commercialCodes(telemetryOverclaim, policy).includes(
      "commercial_research.search_telemetry_overclaimed",
    ),
  );
  const fabricatedHarnessTelemetry = commercialAudit();
  (fabricatedHarnessTelemetry.search_closure as Record<string, unknown>).telemetry_basis =
    "harness_recorded";
  assert.ok(
    commercialCodes(fabricatedHarnessTelemetry, policy).includes(
      "commercial_research.search_telemetry_unobservable",
    ),
  );
});

test("quantitative acquisition is provider-agnostic and APIs remain optional", async () => {
  const policy = await commercialPolicy();
  const fixture = quantitativeCommercialFixture();
  assert.deepEqual(quantitativeCommercialCodes(fixture, policy), []);

  const validator = await createArtifactValidator(repositoryRoot);
  assert.equal(
    validator.validateDocument(fixture.audit, "artifacts/research-audits/commercial-synthetic.json")
      .valid,
    true,
  );
  const acquisition = (fixture.audit.data_acquisitions as Record<string, unknown>[])[0];
  assert.ok(acquisition);
  acquisition.acquisition_method = "authorized_commercial_api";
  acquisition.provider = "Previously Unseen Lawful Data Provider";
  acquisition.access_basis = "caller_authorized_commercial";
  assert.deepEqual(quantitativeCommercialCodes(fixture, policy), []);
  assert.equal(
    validator.validateDocument(fixture.audit, "artifacts/research-audits/commercial-synthetic.json")
      .valid,
    true,
  );
});

test("quantitative acquisition rejects raw binding drift, secrets, and access-control claims", async () => {
  const policy = await commercialPolicy();

  const mismatched = quantitativeCommercialFixture();
  const mismatchedAcquisition = (
    mismatched.audit.data_acquisitions as Record<string, unknown>[]
  )[0];
  assert.ok(mismatchedAcquisition);
  mismatchedAcquisition.raw_response_hash = `sha256:${"c".repeat(64)}`;
  assert.ok(
    quantitativeCommercialCodes(mismatched, policy).includes(
      "commercial_research.acquisition_substrate_binding_mismatch",
    ),
  );

  const exposedSecret = quantitativeCommercialFixture();
  const secretAcquisition = (exposedSecret.audit.data_acquisitions as Record<string, unknown>[])[0];
  assert.ok(secretAcquisition);
  secretAcquisition.endpoint_or_query_redacted =
    "https://metrics.example.invalid/query?access_token=unredacted-secret";
  assert.ok(
    quantitativeCommercialCodes(exposedSecret, policy).includes(
      "commercial_research.acquisition_sensitive_material",
    ),
  );

  const bypassClaim = quantitativeCommercialFixture();
  const bypassAcquisition = (bypassClaim.audit.data_acquisitions as Record<string, unknown>[])[0];
  assert.ok(bypassAcquisition);
  bypassAcquisition.access_control_bypassed = true;
  const validator = await createArtifactValidator(repositoryRoot);
  assert.equal(
    validator.validateDocument(
      bypassClaim.audit,
      "artifacts/research-audits/commercial-synthetic.json",
    ).valid,
    false,
  );
});

test("proxy semantics and direct comparisons fail closed when meanings or scopes drift", async () => {
  const policy = await commercialPolicy();
  const proxy = quantitativeCommercialFixture();
  const proxyObservation = (proxy.audit.quantitative_observations as Record<string, unknown>[])[0];
  assert.ok(proxyObservation);
  proxyObservation.interpretation_boundaries = ["not_paid_customer_count"];
  assert.ok(
    quantitativeCommercialCodes(proxy, policy).includes(
      "commercial_research.proxy_semantic_boundary_missing",
    ),
  );

  const comparison = quantitativeCommercialFixture();
  const first = (comparison.audit.quantitative_observations as Record<string, unknown>[])[0];
  assert.ok(first);
  first.comparability = {
    comparison_group: "comparison_rank",
    status: "comparable",
    category: "synthetic category",
    geography_aligned: true,
    period_aligned: true,
    category_aligned: true,
    definition_aligned: true,
    measurement_aligned: true,
    direct_comparison_allowed: true,
    limitations: [],
  };
  const second = structuredClone(first);
  second.observation_id = "observation_rank_other_region";
  second.metric_family = "usage_behavior";
  second.geography = "Canada";
  (comparison.audit.quantitative_observations as Record<string, unknown>[]).push(second);
  const usageCoverage = (comparison.audit.quantitative_coverage as Record<string, unknown>[]).find(
    (coverage) => coverage.metric_family === "usage_behavior",
  );
  assert.ok(usageCoverage);
  Object.assign(usageCoverage, {
    state: "observed",
    observation_ids: ["observation_rank_other_region"],
    query_attempts: [],
    reason: null,
    alternative_metric: null,
  });
  assert.ok(
    quantitativeCommercialCodes(comparison, policy).includes(
      "commercial_research.quantitative_comparison_group_incompatible",
    ),
  );
});

test("coverage requires every metric family and substitute type without fabricating values", async () => {
  const policy = await commercialPolicy();
  const completeGap = commercialAudit();
  assert.deepEqual(commercialCodes(completeGap, policy), []);
  assert.deepEqual(completeGap.quantitative_observations, []);
  assert.deepEqual(completeGap.competitive_objects, []);

  const missingFamily = structuredClone(completeGap);
  (missingFamily.quantitative_coverage as Record<string, unknown>[]).pop();
  assert.ok(
    commercialCodes(missingFamily, policy).includes(
      "commercial_research.quantitative_coverage_incomplete",
    ),
  );

  const missingSubject = structuredClone(completeGap);
  missingSubject.covered_direction_ids = [];
  missingSubject.quantitative_coverage = [];
  missingSubject.competitive_coverage = [];
  assert.ok(
    commercialCodes(missingSubject, policy).includes("commercial_research.covered_subject_missing"),
  );

  const missingAttempt = structuredClone(completeGap);
  const unavailable = (missingAttempt.competitive_coverage as Record<string, unknown>[])[0];
  assert.ok(unavailable);
  unavailable.query_attempts = [];
  unavailable.reason = null;
  assert.ok(
    commercialCodes(missingAttempt, policy).includes(
      "commercial_research.competitive_coverage_state_mismatch",
    ),
  );
});

test("formal report projections are exact and render fixed unavailable and gap tables", async () => {
  const policy = await commercialPolicy();
  const audit = commercialAudit();
  const auditRef = "artifacts/research-audits/commercial-synthetic.json";
  const projection = commercialReportProjection([{ auditRef, audit }]);
  const report = {
    commercial_research_audit_refs: [auditRef],
    ...projection,
  };
  const documents = [
    {
      path: auditRef,
      schemaVersion: "startup_opportunity.commercial_research_audit.current",
      document: audit,
    },
    {
      path: "artifacts/reporting/report-json.r1.json",
      schemaVersion: "startup_opportunity.report.v1",
      document: report,
    },
  ];
  assert.deepEqual(validateCommercialResearchContract(documents, policy), []);

  const drifted = structuredClone(documents);
  const driftedReport = drifted[1]?.document as Record<string, unknown>;
  (driftedReport.research_coverage_gaps as Record<string, unknown>[]).pop();
  assert.ok(
    validateCommercialResearchContract(drifted, policy)
      .map((issue) => issue.code)
      .includes("commercial_research.report_gap_projection_mismatch"),
  );

  const quantitativeTable = renderQuantitativeSignalTable(projection);
  const competitiveTable = renderCompetitiveSubstituteMatrix(projection);
  const gapTable = renderResearchCoverageGaps(projection);
  assert.match(quantitativeTable, /Metric Family \/ Metric/);
  assert.match(quantitativeTable, /No observed quantitative signal/);
  assert.match(competitiveTable, /Differentiation Gaps/);
  assert.match(competitiveTable, /No observed competitive object/);
  assert.match(gapTable, /Ranking \/ Decision Impact/);
  assert.match(gapTable, /unavailable/);
  assert.match(gapTable, /synthetic-fixture-provider/);
});

test("Chinese commercial tables keep exact refs in structured data but hide internal audit terms", () => {
  const evidenceRef =
    "evidence/records/ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json";
  const source = {
    quantitative_signal_rows: [
      {
        audit_ref: "artifacts/research-audits/synthetic.json",
        observation: {
          subject_id: "china_b2c_education_alternatives_baseline",
          metric_family: "commercial_behavior",
          metric_name: "前期产品价格",
          metric_semantics: "price",
          value: { shape: "point", value: 99, unit: "每月", currency: "CNY" },
          metric_definition: "pre-thesis baseline evidence price",
          geography: "中国大陆",
          period: {
            period_start: null,
            period_end: null,
            as_of: "2026-08-07",
            label: "页面观察",
          },
          measurement_type: "disclosed",
          comparability: {
            status: "not_comparable",
            category: "candidate_evaluation",
            direct_comparison_allowed: false,
          },
          error_uncertainty: "Evidence is not market validation.",
          evidence_refs: [evidenceRef],
        },
      },
    ],
    competitive_substitute_rows: [
      {
        audit_ref: "artifacts/research-audits/synthetic.json",
        competitive_object: {
          competitor_type: "direct_product",
          name: "合成替代",
          target_segment: "成人学习者",
          scenario: "same-run comparison",
          positioning: "baseline alternative",
          pricing_observation_refs: ["obs_price"],
          traction_observation_refs: ["obs_usage"],
          strengths: ["低成本"],
          weaknesses: ["pre-thesis fit unknown"],
          differentiation_gaps: ["unranked_hypothesis"],
          source_refs: [evidenceRef],
        },
      },
    ],
    research_coverage_gaps: [
      {
        audit_ref: "artifacts/research-audits/synthetic.json",
        coverage_kind: "quantitative",
        coverage: {
          subject_id: "candidate_solution_purchase_decision_dossier",
          metric_family: "unit_economics",
          state: "unavailable",
          query_attempts: [
            {
              acquisition_method: "public_api",
              provider: "synthetic-fixture-provider",
              outcome: "not_found",
              reason: "artifact evidence unavailable",
            },
          ],
          reason: "runtime_blocked evidence gap",
          alternative_metric: null,
          decision_impact: "candidate_evaluation remains unranked_hypothesis",
        },
      },
    ],
  };

  const chinese = [
    renderQuantitativeSignalTable(source, true),
    renderCompetitiveSubstituteMatrix(source, true),
    renderResearchCoverageGaps(source, true),
  ].join("\n");
  assert.deepEqual(
    localizedTerminalUserViewIssues({ research_language: "zh-CN", sources: [] }, chinese),
    [],
  );
  assert.doesNotMatch(chinese, /evidence\/records|artifacts\/research-audits/iu);
  assert.match(chinese, /中国大陆 B2C 教育替代基线/);
  assert.match(chinese, /详见结构化审计/);

  const english = renderQuantitativeSignalTable(source);
  assert.match(english, /china_b2c_education_alternatives_baseline/);
  assert.match(english, /evidence\/records/);
});

test("all deterministic scaffold kinds are schema-valid and preserve runtime boundaries", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const modes = ["opportunity_discovery", "concept_evidence_assessment"] as const;
  const kinds = [
    "intake",
    "planning",
    "task",
    "dispatch",
    "readiness",
    "gap",
    "decision",
    "terminal_report_source",
  ] as const;
  for (const mode of modes) {
    for (const kind of kinds) {
      const runId = `current-only-scaffold-${mode}-synthetic`;
      const result = buildArtifactScaffold(
        {
          schema_version: "startup_opportunity.scaffold_request.current",
          scaffold_id: `scaffold_${mode}_${kind}_synthetic`,
          kind,
          run_id: runId,
          mode,
          created_at: "2026-08-04T12:00:00Z",
          scope_confirmation: {
            geography: "United States",
            customer_model: "b2c",
            target_users: ["synthetic user"],
            decision_goal: "decide whether to continue synthetic research",
            research_language: "en-US",
            user_confirmed: true,
          },
        },
        validator,
      );
      assert.equal(result.schema_valid, true);
      assert.equal(result.semantic_judgment_generated, false);
      assert.equal(result.working_directory, `dist/research-working/${runId}`);
      const compilation = result.compilation_request as Record<string, unknown>;
      const artifacts = compilation.artifacts as Record<string, unknown>[];
      assert.equal(artifacts.length, 1);
      assert.equal(
        validator.validateDocument(artifacts[0]?.document, String(artifacts[0]?.artifact_path))
          .valid,
        true,
      );
    }
  }

  const dispatch = buildArtifactScaffold(
    {
      schema_version: "startup_opportunity.scaffold_request.current",
      scaffold_id: "scaffold_dispatch_tokens_synthetic",
      kind: "dispatch",
      run_id: "current-only-scaffold-synthetic",
      mode: "opportunity_discovery",
      created_at: "2026-08-04T12:00:00Z",
      scope_confirmation: {
        geography: "United States",
        customer_model: "b2c",
        target_users: ["synthetic user"],
        decision_goal: "decide whether to continue synthetic research",
        research_language: "en-US",
        user_confirmed: true,
      },
    },
    validator,
  );
  const compilation = dispatch.compilation_request as Record<string, unknown>;
  const artifact = (compilation.artifacts as Record<string, unknown>[])[0];
  const document = artifact?.document as Record<string, unknown>;
  assert.equal(artifact?.producer_role, "harness");
  assert.equal(document.dispatch_mode, "parallel_immediate");
  assert.equal(document.agent_dispatch_performed, false);
});

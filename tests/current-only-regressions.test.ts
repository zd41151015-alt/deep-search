import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileCommercialResearchDelivery } from "../harness/src/compiler/commercial-research-compiler.js";
import {
  artifactRefsForDocument,
  buildArtifactScaffold,
  classifyReference,
  createArtifactValidator,
  validateCommercialResearchContract,
} from "../harness/src/index.js";
import {
  projectCommercialAuditTables,
  renderCompetitiveSubstituteMatrix,
  renderQuantitativeSignalTable,
  renderResearchCoverageGaps,
} from "../harness/src/reporting/commercial-report-tables.js";
import {
  type CommercialResearchPolicy,
  derivePortfolioRecommendationCeiling,
  deriveSourceDistribution,
  isTraceableDirectSource,
} from "../harness/src/validators/commercial-research-validator.js";
import { isBlockingIssue } from "../harness/src/validators/schema-bundle.js";
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
    research_objectives: ["Exercise current commercial research validation semantics."],
    primary_routes: ["Synthetic fixture route; no external research was performed."],
    findings: [],
    claims: [],
    judgments: [],
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
    recommendation_ceiling: {
      maximum_decision_tier: "investigate_further",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
      ],
    },
    subject_recommendation_ceilings: [
      {
        subject_id: "direction_synthetic",
        maximum_decision_tier: "investigate_further",
        reason_codes: [
          "missing_independent_competitor_adoption_data",
          "missing_purchase_or_payment_signal",
          "missing_retention_evidence",
        ],
      },
    ],
    compiler_warnings: [],
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

function commercialDelivery(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.commercial_research_delivery.current",
    run_id: "current-only-commercial-synthetic",
    unit_id: "unit_compiler_synthetic",
    audited_at: "2026-08-04T12:10:00Z",
    research_objectives: ["Exercise compiler semantics."],
    primary_routes: ["Synthetic fixture route."],
    search_results: [],
    evidence_sources: [],
    findings: [],
    claims: [],
    judgments: [],
    quantitative_observations: [],
    competitive_observations: [],
    unresolved_gaps: [],
    limitations: ["Synthetic compiler fixture only."],
    stop_reason: "The assigned synthetic route was complete.",
    telemetry_basis: "unavailable",
    query_log_complete: false,
    ...overrides,
  };
}

function commercialCompilerTask(
  taskPath: string,
  subjectRef = "direction_synthetic",
  requiredMetricFamilies: readonly string[] = [],
  requiredCompetitorTypes: readonly string[] = [],
) {
  return {
    artifact_type: "startup_opportunity.research_task.discovery_candidate.current",
    artifact_path: taskPath,
    document: {
      schema_version: "startup_opportunity.research_task.discovery_candidate.current",
      target_subject_ref: subjectRef,
      commercial_research_requirements: {
        research_stage: "solution_neutral_scan",
        quantitative_competitive_scope: {
          required_metric_families: requiredMetricFamilies,
          required_competitor_types: requiredCompetitorTypes,
        },
      },
    },
  };
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
      source_profile: { type: "other", description: "Synthetic public metric fixture." },
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "current_market_change",
      content_summary: "Synthetic category-rank observation used only for contract validation.",
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

test("commercial semantic Evidence refs participate in explicit Bundle closure", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const audit = commercialAudit();
  const missingRef = "evidence/records/semantic-missing.json";
  const wrongTypeRef = "evidence/records/semantic-wrong-type.json";
  const crossRunRef = "evidence/records/semantic-cross-run.json";
  audit.findings = [
    {
      finding_id: "finding_semantic",
      statement: "Missing ref fixture.",
      evidence_refs: [missingRef],
    },
  ];
  audit.claims = [
    {
      claim_id: "claim_semantic",
      statement: "Wrong type fixture.",
      evidence_refs: [wrongTypeRef],
      requested_confidence: "low",
      confidence: "low",
      confidence_ceiling_reasons: ["positive_support_not_adopted"],
    },
  ];
  audit.judgments = [
    {
      judgment_id: "judgment_semantic",
      statement: "Cross Run fixture.",
      evidence_refs: [crossRunRef],
    },
  ];
  const discovered = artifactRefsForDocument({
    path: "artifacts/research-audits/commercial-synthetic.json",
    document: audit,
  });
  assert.ok(discovered.includes(missingRef));
  assert.ok(discovered.includes(wrongTypeRef));
  assert.ok(discovered.includes(crossRunRef));

  const result = validator.validateDocumentBundle({
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: "artifacts/research-audits/commercial-synthetic.json", document: audit },
      {
        path: wrongTypeRef,
        document: {
          schema_version: "startup_opportunity.research_plan.v1",
          run_id: "current-only-commercial-synthetic",
        },
      },
      {
        path: crossRunRef,
        document: {
          schema_version: "startup_opportunity.evidence.assessment.current",
          run_id: "different-current-run",
        },
      },
    ],
  });
  assert.ok(
    result.referenceErrors.some(
      (issue) => issue.code === "reference.missing" && issue.details.ref === missingRef,
    ),
  );
  assert.ok(
    result.referenceErrors.some(
      (issue) => issue.code === "reference.type_mismatch" && issue.details.ref === wrongTypeRef,
    ),
  );
  assert.ok(
    result.referenceErrors.some(
      (issue) => issue.code === "reference.run_mismatch" && issue.details.ref === crossRunRef,
    ),
  );
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
  assert.equal(staleCodes.includes("commercial_research.search_evidence_reconciliation"), false);

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
  const stalePriceIssue = validateCommercialResearchContract(
    [
      {
        path: "artifacts/research-audits/commercial-synthetic.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: stalePrice,
      },
    ],
    policy,
  ).find((issue) => issue.code === "commercial_research.freshness_status_mismatch");
  assert.ok(stalePriceIssue);
  assert.equal(isBlockingIssue(stalePriceIssue), true);

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

test("coverage follows assigned metric families and substitute types without fabricating values", async () => {
  const policy = await commercialPolicy();
  const completeGap = commercialAudit();
  assert.deepEqual(commercialCodes(completeGap, policy), []);
  assert.deepEqual(completeGap.quantitative_observations, []);
  assert.deepEqual(completeGap.competitive_objects, []);

  const assignedFamily = structuredClone(completeGap);
  assignedFamily.quantitative_coverage = (
    assignedFamily.quantitative_coverage as Record<string, unknown>[]
  ).filter((entry) => entry.metric_family === "demand_scale");
  assignedFamily.competitive_coverage = (
    assignedFamily.competitive_coverage as Record<string, unknown>[]
  ).filter((entry) => entry.competitor_type === "status_quo");
  const assignedDocuments = [
    {
      path: "tasks/discovery/unit_commercial_synthetic.attempt-1.json",
      schemaVersion: "startup_opportunity.research_task.discovery_candidate.current",
      document: {
        commercial_research_requirements: {
          research_stage: "solution_neutral_scan",
          quantitative_competitive_scope: {
            scan_mode: "broad_scan",
            required_metric_families: ["demand_scale"],
            required_competitor_types: ["status_quo"],
            api_is_optional: true,
            provider_allowlist_enforced: false,
            acquisition_execution_owner: "research_agent_or_caller",
            harness_hidden_network_calls: false,
            prohibited_access_methods: [
              "bypass_access_control",
              "circumvent_captcha",
              "circumvent_login",
              "circumvent_paywall",
              "store_credentials",
            ],
          },
        },
      },
    },
    {
      path: "artifacts/research-audits/commercial-synthetic.json",
      schemaVersion: "startup_opportunity.commercial_research_audit.current",
      document: assignedFamily,
    },
  ];
  assert.deepEqual(validateCommercialResearchContract(assignedDocuments, policy), []);

  const qualitativeDocuments = structuredClone(assignedDocuments);
  const qualitativeTask = qualitativeDocuments[0];
  const qualitativeAudit = qualitativeDocuments[1];
  assert.ok(qualitativeTask);
  assert.ok(qualitativeAudit);
  const qualitativeScope = (
    qualitativeTask.document.commercial_research_requirements as Record<string, unknown>
  ).quantitative_competitive_scope as Record<string, unknown>;
  qualitativeScope.required_metric_families = [];
  qualitativeScope.required_competitor_types = [];
  qualitativeAudit.document.quantitative_coverage = [];
  qualitativeAudit.document.competitive_coverage = [];
  assert.deepEqual(validateCommercialResearchContract(qualitativeDocuments, policy), []);

  const missingFamily = structuredClone(assignedDocuments);
  const missingFamilyAudit = missingFamily[1];
  assert.ok(missingFamilyAudit);
  missingFamilyAudit.document.quantitative_coverage = [];
  const missingFamilyIssue = validateCommercialResearchContract(missingFamily, policy).find(
    (issue) => issue.code === "commercial_research.quantitative_coverage_incomplete",
  );
  assert.ok(missingFamilyIssue);
  assert.equal(isBlockingIssue(missingFamilyIssue), true);

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

test("unverified regulatory Evidence blocks only when adopted for a current judgment", async () => {
  const policy = await commercialPolicy();
  const evidenceRef = "evidence/records/regulatory-background-synthetic.json";
  const rejected = commercialAudit();
  rejected.evidence_register = [
    {
      evidence_ref: evidenceRef,
      source_kind: "regulatory",
      source_profile: {
        type: "regulatory",
        effective_status: "unknown",
        verified_at: null,
      },
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "market_structure_regulatory",
      content_summary: "Synthetic unverified regulatory background.",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: null,
      data_period_end: null,
      derived_valid_as_of: "2026-08-01",
      freshness_status: "undated",
      coverage_keys: [],
      disposition: "rejected",
      exclusion_reason: "The effective status was not verified.",
    },
  ];
  const rejectedRegulatory = validateCommercialResearchContract(
    [
      {
        path: "artifacts/research-audits/commercial-synthetic.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: rejected,
      },
    ],
    policy,
  ).filter((issue) => issue.code === "commercial_research.regulatory_status_unverified");
  assert.ok(rejectedRegulatory.length > 0);
  assert.ok(rejectedRegulatory.every((issue) => issue.severity === "warning"));

  const adopted = structuredClone(rejected);
  const adoptedSource = (adopted.evidence_register as Record<string, unknown>[])[0];
  assert.ok(adoptedSource);
  adoptedSource.disposition = "adopted";
  adoptedSource.exclusion_reason = null;
  adoptedSource.coverage_keys = ["mechanism"];
  adopted.adopted_source_distribution = {
    total_adopted_sources: 1,
    customer_commercial_count: 0,
    market_structure_count: 1,
    academic_count: 0,
    customer_commercial_percent: 0,
    market_structure_percent: 100,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  adopted.recommendation_ceiling = {
    maximum_decision_tier: "watch",
    reason_codes: [
      "missing_independent_competitor_adoption_data",
      "missing_purchase_or_payment_signal",
      "missing_retention_evidence",
      "regulatory_status_unconfirmed",
    ],
  };
  const adoptedRegulatory = validateCommercialResearchContract(
    [
      {
        path: "artifacts/research-audits/commercial-synthetic.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: adopted,
      },
    ],
    policy,
  ).filter((issue) => issue.code === "commercial_research.regulatory_status_unverified");
  assert.ok(adoptedRegulatory.some((issue) => issue.severity === "error"));
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

test("commercial ceilings bind selected subjects instead of unrelated weak candidates", async () => {
  const policy = await commercialPolicy();
  const audit = commercialAudit();
  const rejectedRef = "evidence/records/rejected-candidate-source.json";
  audit.covered_direction_ids = ["opportunity_selected", "opportunity_rejected"];
  audit.evidence_register = [
    {
      evidence_ref: rejectedRef,
      source_kind: "independent",
      source_profile: { type: "other", description: "Retained weak candidate source." },
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "current_pricing",
      content_summary: "The rejected candidate source was not suitable for positive support.",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: null,
      data_period_end: null,
      derived_valid_as_of: "2026-08-01",
      freshness_status: "current",
      coverage_keys: [],
      disposition: "rejected",
      exclusion_reason: "The source did not support the claimed conclusion.",
    },
  ];
  audit.judgments = [
    {
      judgment_id: "judgment_rejected_candidate",
      subject_id: "opportunity_rejected",
      statement: "The rejected candidate should be prioritized.",
      evidence_refs: [rejectedRef],
    },
  ];
  audit.subject_recommendation_ceilings = [
    {
      subject_id: "opportunity_rejected",
      maximum_decision_tier: "watch",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
        "positive_support_not_adopted",
      ],
    },
    {
      subject_id: "opportunity_selected",
      maximum_decision_tier: "investigate_further",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
      ],
    },
  ];
  audit.recommendation_ceiling = {
    maximum_decision_tier: "watch",
    reason_codes: [
      "missing_independent_competitor_adoption_data",
      "missing_purchase_or_payment_signal",
      "missing_retention_evidence",
      "positive_support_not_adopted",
    ],
  };
  const audits = [{ path: "artifacts/research-audits/multi-subject.json", document: audit }];
  const projection = projectCommercialAuditTables(audits);
  const report = {
    ...projection,
    curated_judgment_context: {
      decision_tier: "investigate_further",
      recommended_first_bet: "opportunity_selected",
    },
    top_opportunity_refs: ["opportunity_selected"],
  };
  const documents = [
    ...audits.map((audit) => ({
      path: audit.path,
      schemaVersion: "startup_opportunity.commercial_research_audit.current",
      document: audit.document,
    })),
    {
      path: "artifacts/reporting/report-json.r1.json",
      schemaVersion: "startup_opportunity.report.v1",
      document: report,
    },
  ];
  const selectedCodes = validateCommercialResearchContract(documents, policy).map(
    (issue) => issue.code,
  );
  assert.equal(selectedCodes.includes("terminal_reporting.recommendation_ceiling_exceeded"), false);
  assert.equal(
    selectedCodes.includes("commercial_research.subject_recommendation_ceiling_mismatch"),
    false,
  );
  assert.equal(
    derivePortfolioRecommendationCeiling(
      [
        {
          subject_id: "opportunity_selected",
          maximum_decision_tier: "prioritize",
          reason_codes: [],
        },
        {
          subject_id: "opportunity_rejected",
          maximum_decision_tier: "prioritize",
          reason_codes: [],
        },
      ],
      [{ statement: "Unbound rejected support.", evidence_refs: [rejectedRef] }],
      audit.evidence_register as Record<string, unknown>[],
    ).maximum_decision_tier,
    "watch",
  );

  Object.assign(report.curated_judgment_context as Record<string, unknown>, {
    decision_tier: "prioritize",
    recommended_first_bet: "opportunity_rejected",
  });
  report.top_opportunity_refs = ["opportunity_rejected"];
  const exceededCodes = validateCommercialResearchContract(documents, policy).map(
    (issue) => issue.code,
  );
  assert.ok(exceededCodes.includes("terminal_reporting.recommendation_ceiling_exceeded"));
});

test("concept prioritize is checked against its bound commercial ceiling", async () => {
  const policy = await commercialPolicy();
  const audit = commercialAudit();
  audit.covered_direction_ids = ["concept-hypothesis.json"];
  audit.subject_recommendation_ceilings = [
    {
      subject_id: "concept-hypothesis.json",
      maximum_decision_tier: "investigate_further",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
      ],
    },
  ];
  const auditRef = "artifacts/research-audits/concept.json";
  const projection = projectCommercialAuditTables([{ path: auditRef, document: audit }]);
  const codes = validateCommercialResearchContract(
    [
      {
        path: auditRef,
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: audit,
      },
      {
        path: "artifacts/reporting/concept-report.r1.json",
        schemaVersion: "startup_opportunity.concept_evidence_report.v1",
        document: {
          ...projection,
          concept_hypothesis_ref: "concept-hypothesis.json",
          curated_judgment_context: { assessment_result: "prioritize" },
        },
      },
    ],
    policy,
  ).map((issue) => issue.code);
  assert.ok(codes.includes("terminal_reporting.recommendation_ceiling_exceeded"));
});

test("untraced news is retained but cannot establish observed purchase coverage", async () => {
  const policy = await commercialPolicy();
  const audit = commercialAudit();
  const evidenceRef = "evidence/records/news-purchase-synthetic.json";
  audit.evidence_register = [
    {
      evidence_ref: evidenceRef,
      source_kind: "independent",
      source_profile: {
        type: "news",
        publisher: "Independent Daily",
        published_at: "2026-08-01T00:00:00Z",
        quotation: "A secondary article reports purchase activity.",
        primary_data_traceability_status: "untraced",
        primary_data_ref: null,
      },
      evidence_character: "independent_report",
      independence: "independent",
      claim_type: "current_purchase_behavior",
      content_summary: "A secondary article reports purchase activity without primary data.",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: null,
      data_period_end: null,
      derived_valid_as_of: "2026-08-01",
      freshness_status: "current",
      coverage_keys: ["purchase_signal"],
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
  (audit.coverage as Record<string, unknown>).purchase_signal = {
    state: "observed",
    content_covered: true,
    evidence_refs: [evidenceRef],
    data_points: [
      { evidence_ref: evidenceRef, aspect: "purchase", fact_or_excerpt: "Reported purchases." },
    ],
    inference: null,
  };
  const codes = commercialCodes(audit, policy);
  assert.ok(codes.includes("commercial_research.coverage_state_mismatch"));
  assert.equal((audit.evidence_register as unknown[]).length, 1);

  const source = (audit.evidence_register as Record<string, unknown>[])[0];
  assert.ok(source);
  const profile = source.source_profile as Record<string, unknown>;
  profile.primary_data_traceability_status = "traced";
  profile.primary_data_ref = null;
  assert.equal(isTraceableDirectSource(source, new Map([[evidenceRef, source]])), false);
  const missingPrimaryIssues = validateCommercialResearchContract(
    [
      {
        path: "artifacts/research-audits/commercial-synthetic.json",
        schemaVersion: String(audit.schema_version),
        document: audit,
      },
    ],
    policy,
  ).filter((issue) => issue.code === "commercial_research.news_primary_traceability_mismatch");
  assert.ok(missingPrimaryIssues.some(isBlockingIssue));

  const primaryRef = "evidence/records/company-price-primary.json";
  const incompatiblePrimary = {
    evidence_ref: primaryRef,
    source_kind: "vendor",
    source_profile: { type: "company_material", supported_public_claims: ["public_pricing"] },
    evidence_character: "vendor_claim",
    independence: "interested_party",
    claim_type: "vendor_public_pricing",
    content_summary: "The company publishes a current price.",
    retrieved_at: "2026-08-04T12:01:00Z",
    published_at: null,
    observed_at: "2026-08-04T12:00:00Z",
    data_period_end: null,
    derived_valid_as_of: "2026-08-04",
    freshness_status: "current",
    coverage_keys: ["pricing"],
    disposition: "adopted",
    exclusion_reason: null,
  };
  profile.primary_data_ref = primaryRef;
  (audit.evidence_register as Record<string, unknown>[]).push(incompatiblePrimary);
  audit.adopted_source_distribution = deriveSourceDistribution(
    audit.evidence_register as Record<string, unknown>[],
    policy,
  );
  const byRef = new Map(
    (audit.evidence_register as Record<string, unknown>[]).map((item) => [
      String(item.evidence_ref),
      item,
    ]),
  );
  assert.equal(isTraceableDirectSource(source, byRef), false);
  assert.ok(
    commercialCodes(audit, policy).includes(
      "commercial_research.news_primary_traceability_mismatch",
    ),
  );
});

test("source concentration follows provider and shared provenance groups", async () => {
  const policy = await commercialPolicy();
  const audit = commercialAudit();
  const refs = ["evidence/records/provider-a.json", "evidence/records/provider-b.json"];
  audit.evidence_register = refs.map((evidenceRef, index) => ({
    evidence_ref: evidenceRef,
    source_kind: "independent",
    source_profile: {
      type: "news",
      publisher: `Provider ${index + 1}`,
      published_at: "2026-08-01T00:00:00Z",
      quotation: "Synthetic provider statement.",
      primary_data_traceability_status: "not_claimed",
      primary_data_ref: null,
    },
    evidence_character: "counterevidence",
    independence: "independent",
    claim_type: "counterevidence",
    content_summary: "Synthetic counterevidence.",
    retrieved_at: "2026-08-04T12:01:00Z",
    published_at: "2026-08-01T00:00:00Z",
    observed_at: null,
    data_period_end: null,
    derived_valid_as_of: "2026-08-01",
    freshness_status: "current",
    coverage_keys: [],
    disposition: "adopted",
    exclusion_reason: null,
  }));
  audit.adopted_source_distribution = {
    total_adopted_sources: 2,
    customer_commercial_count: 2,
    market_structure_count: 0,
    academic_count: 0,
    customer_commercial_percent: 100,
    market_structure_percent: 0,
    academic_percent: 0,
    guidance_deviation_observed: true,
  };
  assert.equal(
    commercialCodes(audit, policy).includes("commercial_research.source_concentration"),
    false,
  );

  const documents = refs.map((ref) => ({
    path: ref,
    schemaVersion: "startup_opportunity.evidence.assessment.current",
    document: {
      source_assessment: {
        canonical_source_group: ref.endsWith("a.json") ? "provider_a" : "provider_b",
        shared_dataset_group: "shared_dataset_one",
        syndication_group: null,
      },
    },
  }));
  const issues = validateCommercialResearchContract(
    [
      ...documents,
      {
        path: "artifacts/research-audits/concentrated.json",
        schemaVersion: "startup_opportunity.commercial_research_audit.current",
        document: audit,
      },
    ],
    policy,
  );
  assert.ok(issues.some((issue) => issue.code === "commercial_research.source_concentration"));
});

test("claim confidence uses only related gaps while overall ceiling remains conservative", async () => {
  const policy = await commercialPolicy();
  const evidenceRef = "evidence/records/current-price.json";
  const delivery = {
    schema_version: "startup_opportunity.commercial_research_delivery.current",
    run_id: "current-only-commercial-synthetic",
    unit_id: "unit_price",
    audited_at: "2026-08-04T12:10:00Z",
    research_objectives: ["Record a current public price."],
    primary_routes: ["Public price page."],
    search_results: [],
    evidence_sources: [
      {
        evidence_ref: evidenceRef,
        source_kind: "independent",
        source_profile: { type: "other", description: "Independent current price record." },
        evidence_character: "observed_behavior",
        independence: "independent",
        claim_type: "current_pricing",
        content_summary: "The current public price is $20.",
        retrieved_at: "2026-08-04T12:01:00Z",
        published_at: null,
        observed_at: "2026-08-04T12:00:00Z",
        data_period_end: null,
        coverage_keys: [],
        disposition: "adopted",
        exclusion_reason: null,
      },
    ],
    findings: [],
    claims: [
      {
        statement: "The current public price is $20.",
        evidence_refs: [evidenceRef],
        confidence: "high",
      },
    ],
    judgments: [],
    quantitative_observations: [],
    competitive_observations: [],
    unresolved_gaps: [
      {
        coverage_kind: "quantitative",
        subject_id: "concept-price",
        dimension: "retention_outcomes",
        state: "unavailable",
        query_attempts: [],
        reason: "Retention is unavailable.",
        alternative_metric: null,
        decision_impact: "Overall recommendation remains conservative.",
      },
    ],
    limitations: ["Retention is not known."],
    stop_reason: "The assigned route was complete.",
    telemetry_basis: "unavailable",
    query_log_complete: false,
  };
  const taskPath = "tasks/discovery/unit_price.attempt-1.json";
  const task = {
    artifact_type: "startup_opportunity.research_task.discovery_candidate.current",
    artifact_path: taskPath,
    document: {
      schema_version: "startup_opportunity.research_task.discovery_candidate.current",
      target_subject_ref: "concept-price",
      commercial_research_requirements: {
        research_stage: "solution_neutral_scan",
        quantitative_competitive_scope: {
          required_metric_families: ["retention_outcomes"],
          required_competitor_types: [],
        },
      },
    },
  };
  const compiled = compileCommercialResearchDelivery(delivery, taskPath, [task], policy).document;
  const claim = (compiled.claims as Record<string, unknown>[])[0];
  assert.equal(claim?.confidence, "high");
  assert.equal(
    (compiled.recommendation_ceiling as Record<string, unknown>).maximum_decision_tier,
    "investigate_further",
  );
});

test("rejected counterevidence is allowed while rejected positive support is downgraded", async () => {
  const policy = await commercialPolicy();
  const counter = commercialAudit();
  const ref = "evidence/records/rejected-counter.json";
  counter.evidence_register = [
    {
      evidence_ref: ref,
      source_kind: "independent",
      source_profile: { type: "other", description: "Rejected counterevidence fixture." },
      evidence_character: "counterevidence",
      independence: "independent",
      claim_type: "counterevidence",
      content_summary: "The excluded source is retained as a challenge.",
      retrieved_at: "2026-08-04T12:01:00Z",
      published_at: "2026-08-01T00:00:00Z",
      observed_at: null,
      data_period_end: null,
      derived_valid_as_of: "2026-08-01",
      freshness_status: "current",
      coverage_keys: ["independent_counterevidence"],
      disposition: "rejected",
      exclusion_reason: "The sample was not representative.",
    },
  ];
  counter.findings = [
    { finding_id: "finding_counter", statement: "The source was excluded.", evidence_refs: [ref] },
  ];
  assert.equal(
    commercialCodes(counter, policy).includes("commercial_research.positive_support_not_adopted"),
    false,
  );

  const positive = structuredClone(counter);
  const source = (positive.evidence_register as Record<string, unknown>[])[0];
  assert.ok(source);
  source.claim_type = "current_pricing";
  source.evidence_character = "independent_report";
  positive.claims = [
    {
      claim_id: "claim_rejected_positive",
      subject_id: "direction_synthetic",
      statement: "The rejected source establishes the current public price.",
      evidence_refs: [ref],
      requested_confidence: "high",
      confidence: "low",
      confidence_ceiling_reasons: [
        "claim_relevant_coverage_incomplete",
        "positive_support_not_adopted",
      ],
    },
  ];
  positive.recommendation_ceiling = {
    maximum_decision_tier: "watch",
    reason_codes: [
      "missing_independent_competitor_adoption_data",
      "missing_purchase_or_payment_signal",
      "missing_retention_evidence",
      "positive_support_not_adopted",
    ],
  };
  positive.subject_recommendation_ceilings = [
    {
      subject_id: "direction_synthetic",
      maximum_decision_tier: "watch",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
        "positive_support_not_adopted",
      ],
    },
  ];
  const positiveIssues = validateCommercialResearchContract(
    [
      {
        path: "artifacts/research-audits/commercial-synthetic.json",
        schemaVersion: String(positive.schema_version),
        document: positive,
      },
    ],
    policy,
  );
  assert.ok(
    positiveIssues.some(
      (issue) => issue.code === "commercial_research.positive_support_not_adopted",
    ),
  );
  assert.equal(positiveIssues.some(isBlockingIssue), false);
});

test("formal Claim confidence drift is blocking while rejected support stays publishable", async () => {
  const policy = await commercialPolicy();
  const taskPath = "tasks/discovery/unit_claim_drift.attempt-1.json";
  const task = commercialCompilerTask(taskPath, "direction_claim_drift");
  const evidenceRef = "evidence/records/rejected-claim-drift.json";
  const delivery = commercialDelivery({
    unit_id: "unit_claim_drift",
    evidence_sources: [
      {
        evidence_ref: evidenceRef,
        source_kind: "independent",
        source_profile: { type: "other", description: "Rejected Claim support fixture." },
        evidence_character: "independent_report",
        independence: "independent",
        claim_type: "current_pricing",
        content_summary: "The rejected source reports a price.",
        retrieved_at: "2026-08-04T12:01:00Z",
        published_at: null,
        observed_at: "2026-08-04T12:00:00Z",
        data_period_end: null,
        coverage_keys: ["pricing"],
        disposition: "rejected",
        exclusion_reason: "The source could not be audited.",
      },
    ],
    claims: [
      {
        subject_id: "direction_claim_drift",
        statement: "The rejected source establishes the current price.",
        evidence_refs: [evidenceRef],
        confidence: "high",
      },
    ],
  });
  const compiled = compileCommercialResearchDelivery(delivery, taskPath, [task], policy).document;
  const claim = (compiled.claims as Record<string, unknown>[])[0];
  assert.ok(claim);
  assert.equal(claim.confidence, "low");
  assert.deepEqual(claim.confidence_ceiling_reasons, ["positive_support_not_adopted"]);
  const documents = [
    {
      path: taskPath,
      schemaVersion: String(task.document.schema_version),
      document: task.document,
    },
    {
      path: "artifacts/research-audits/claim-drift.json",
      schemaVersion: String(compiled.schema_version),
      document: compiled,
    },
  ];
  const baseline = validateCommercialResearchContract(documents, policy);
  assert.equal(
    baseline.some((issue) => issue.code === "commercial_research.claim_confidence_mismatch"),
    false,
  );
  assert.ok(
    baseline.some((issue) => issue.code === "commercial_research.positive_support_not_adopted"),
  );

  claim.confidence = "high";
  const driftIssues = validateCommercialResearchContract(documents, policy).filter(
    (issue) => issue.code === "commercial_research.claim_confidence_mismatch",
  );
  assert.ok(driftIssues.some(isBlockingIssue));
});

test("compiler derives regulatory verification from the profile including explicit null", async () => {
  const policy = await commercialPolicy();
  const taskPath = "tasks/discovery/unit_regulatory_profile.attempt-1.json";
  const task = commercialCompilerTask(taskPath, "direction_regulatory_profile");
  const delivery = commercialDelivery({
    unit_id: "unit_regulatory_profile",
    evidence_sources: [
      {
        evidence_ref: "evidence/records/regulatory-profile-null.json",
        source_kind: "regulatory",
        source_profile: { type: "regulatory", effective_status: "unknown", verified_at: null },
        evidence_character: "independent_report",
        independence: "independent",
        claim_type: "market_structure_regulatory",
        content_summary: "A regulation was published, but its current effective state is unknown.",
        regulatory_effective_status: "effective",
        regulatory_status_verified_at: "2026-08-04T12:00:00Z",
        retrieved_at: "2026-08-04T12:01:00Z",
        published_at: "2026-07-01T00:00:00Z",
        observed_at: null,
        data_period_end: null,
        coverage_keys: [],
        disposition: "adopted",
        exclusion_reason: null,
      },
    ],
  });
  const compiled = compileCommercialResearchDelivery(delivery, taskPath, [task], policy).document;
  const source = (compiled.evidence_register as Record<string, unknown>[])[0];
  assert.ok(source);
  assert.equal(source.regulatory_effective_status, "unknown");
  assert.equal(source.regulatory_status_verified_at, null);
  assert.equal(source.freshness_status, "undated");
  assert.equal(
    (compiled.recommendation_ceiling as Record<string, unknown>).maximum_decision_tier,
    "watch",
  );
});

test("compiler retains undeclared Search objectives and emits a non-blocking warning", async () => {
  const policy = await commercialPolicy();
  const taskPath = "tasks/discovery/unit_search_objective.attempt-1.json";
  const task = commercialCompilerTask(taskPath, "direction_search_objective");
  const delivery = commercialDelivery({
    unit_id: "unit_search_objective",
    research_objectives: ["Declared objective"],
    primary_routes: ["Declared route"],
    search_results: [
      {
        objective: "Additional observed objective",
        route: "Recorded exploratory route",
        url: "https://example.invalid/additional-objective",
        title: "Retained rejected result",
        retrieved_at: "2026-08-04T12:01:00Z",
        published_at: "2026-08-01T00:00:00Z",
        observed_at: null,
        data_period_end: null,
        claim_type: "current_market_change",
        commercial_dimensions: ["market_structure"],
        adopted_evidence_ref: null,
        rejection_reason: "The result was useful only as a recorded lead.",
      },
    ],
  });
  const result = compileCommercialResearchDelivery(delivery, taskPath, [task], policy);
  const warning = result.issues.find(
    (issue) => issue.code === "commercial_research.search_objective_unplanned",
  );
  assert.ok(warning);
  assert.equal(isBlockingIssue(warning), false);
  const retained = (result.document.search_log as Record<string, unknown>[]).find((query) =>
    String(query.query).includes("Additional observed objective"),
  );
  assert.ok(retained);
  assert.equal((retained.candidate_results as unknown[]).length, 1);
  assert.ok(
    (result.document.compiler_warnings as Record<string, unknown>[]).some(
      (entry) => entry.code === "commercial_research.search_objective_unplanned",
    ),
  );
});

test("mixed traceable and untraced observations retain both rows without lowering family coverage", async () => {
  const policy = await commercialPolicy();
  const fixture = quantitativeCommercialFixture();
  const strongEvidence = (fixture.audit.evidence_register as Record<string, unknown>[])[0];
  const formalObservation = (
    fixture.audit.quantitative_observations as Record<string, unknown>[]
  )[0];
  const formalAcquisition = (fixture.audit.data_acquisitions as Record<string, unknown>[])[0];
  assert.ok(strongEvidence);
  assert.ok(formalObservation);
  assert.ok(formalAcquisition);
  const {
    observation_id: _observationId,
    acquisition_id: _acquisitionId,
    ...observationInput
  } = formalObservation;
  const acquisition = {
    acquisition_method: formalAcquisition.acquisition_method,
    provider: formalAcquisition.provider,
    endpoint_or_query_redacted: formalAcquisition.endpoint_or_query_redacted,
    access_basis: formalAcquisition.access_basis,
    limitations: formalAcquisition.limitations,
  };
  const weakRef = "evidence/records/untraced-mixed-metric.json";
  const weakEvidence = {
    ...structuredClone(strongEvidence),
    evidence_ref: weakRef,
    source_profile: {
      type: "news",
      publisher: "Secondary Metrics Daily",
      published_at: "2026-08-01T00:00:00Z",
      quotation: "A secondary report repeats the metric.",
      primary_data_traceability_status: "untraced",
      primary_data_ref: null,
    },
    content_summary: "An untraced secondary report repeats the category rank.",
    published_at: "2026-08-01T00:00:00Z",
    observed_at: null,
    data_period_end: null,
  };
  const taskPath = "tasks/discovery/unit_mixed_metric.attempt-1.json";
  const task = commercialCompilerTask(taskPath, "direction_synthetic", ["demand_scale"]);
  const delivery = commercialDelivery({
    unit_id: "unit_mixed_metric",
    evidence_sources: [strongEvidence, weakEvidence],
    quantitative_observations: [
      { ...observationInput, acquisition },
      {
        ...observationInput,
        metric_name: "secondary category rank",
        evidence_refs: [weakRef],
        acquisition: { ...acquisition, provider: "Secondary Metrics Daily" },
        limitations: ["The secondary report does not expose its primary dataset."],
      },
    ],
  });
  const strongEvidenceArtifact = fixture.documents.find(
    (entry) => entry.path === strongEvidence.evidence_ref,
  );
  assert.ok(strongEvidenceArtifact);
  const availableArtifacts = [
    task,
    {
      artifact_type: strongEvidenceArtifact.schemaVersion,
      artifact_path: strongEvidenceArtifact.path,
      document: strongEvidenceArtifact.document,
    },
    {
      artifact_type: strongEvidenceArtifact.schemaVersion,
      artifact_path: weakRef,
      document: structuredClone(strongEvidenceArtifact.document),
    },
  ];
  const result = compileCommercialResearchDelivery(delivery, taskPath, availableArtifacts, policy);
  const coverage = (result.document.quantitative_coverage as Record<string, unknown>[])[0];
  assert.ok(coverage);
  assert.equal(coverage.state, "observed");
  assert.equal((coverage.observation_ids as unknown[]).length, 2);
  assert.equal((result.document.quantitative_observations as unknown[]).length, 2);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "commercial_research.secondary_source_traceability_limited",
    ),
  );
  assert.ok(
    (result.document.compiler_warnings as Record<string, unknown>[]).some(
      (entry) => entry.code === "commercial_research.secondary_source_traceability_limited",
    ),
  );
});

test("company material supports matching public facts while portfolio strength stays conservative", async () => {
  const policy = await commercialPolicy();
  const taskPath = "tasks/discovery/unit_company_material.attempt-1.json";
  const task = commercialCompilerTask(taskPath, "direction_company_material");
  const evidenceRef = "evidence/records/company-public-price.json";
  const source = {
    evidence_ref: evidenceRef,
    source_kind: "vendor",
    source_profile: { type: "company_material", supported_public_claims: ["public_pricing"] },
    evidence_character: "vendor_claim",
    independence: "interested_party",
    claim_type: "vendor_public_pricing",
    content_summary: "The company publicly lists a $20 price.",
    retrieved_at: "2026-08-04T12:01:00Z",
    published_at: null,
    observed_at: "2026-08-04T12:00:00Z",
    data_period_end: null,
    coverage_keys: ["pricing"],
    disposition: "adopted",
    exclusion_reason: null,
  };
  const delivery = commercialDelivery({
    unit_id: "unit_company_material",
    evidence_sources: [source],
    claims: [
      {
        subject_id: "direction_company_material",
        statement: "The company publicly lists a $20 price.",
        evidence_refs: [evidenceRef],
        confidence: "high",
      },
    ],
  });
  const exact = compileCommercialResearchDelivery(delivery, taskPath, [task], policy).document;
  const exactClaim = (exact.claims as Record<string, unknown>[])[0];
  assert.ok(exactClaim);
  assert.equal(exactClaim.confidence, "high");
  assert.ok(Array.isArray((exact.recommendation_ceiling as Record<string, unknown>).reason_codes));
  assert.ok(
    ((exact.recommendation_ceiling as Record<string, unknown>).reason_codes as string[]).includes(
      "independent_cross_validation_missing",
    ),
  );
  assert.notEqual(
    (exact.recommendation_ceiling as Record<string, unknown>).maximum_decision_tier,
    "prioritize",
  );

  const mismatchedDelivery = structuredClone(delivery);
  const mismatchedSource = (mismatchedDelivery.evidence_sources as Record<string, unknown>[])[0];
  assert.ok(mismatchedSource);
  (mismatchedSource.source_profile as Record<string, unknown>).supported_public_claims = [
    "product_capability",
  ];
  const mismatched = compileCommercialResearchDelivery(
    mismatchedDelivery,
    taskPath,
    [task],
    policy,
  ).document;
  const mismatchedClaim = (mismatched.claims as Record<string, unknown>[])[0];
  assert.ok(mismatchedClaim);
  assert.equal(mismatchedClaim.confidence, "low");
  const scopeIssues = validateCommercialResearchContract(
    [
      {
        path: taskPath,
        schemaVersion: String(task.document.schema_version),
        document: task.document,
      },
      {
        path: "artifacts/research-audits/company-material.json",
        schemaVersion: String(mismatched.schema_version),
        document: mismatched,
      },
    ],
    policy,
  ).filter((issue) => issue.code === "commercial_research.vendor_claim_scope_invalid");
  assert.ok(scopeIssues.length > 0);
  assert.ok(scopeIssues.every((issue) => !isBlockingIssue(issue)));
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

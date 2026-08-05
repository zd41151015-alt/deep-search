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
import type { CommercialResearchPolicy } from "../harness/src/validators/commercial-research-validator.js";

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

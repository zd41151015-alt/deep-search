import assert from "node:assert/strict";
import test from "node:test";
import {
  renderMarketPriorityAndCommercialReadiness,
  renderQuantitativeSignalTable,
} from "../harness/src/reporting/commercial-report-tables.js";
import type {
  AssessmentInformationGainAuthority,
  AssessmentInformationGainSnapshot,
  AssessmentRouteHistoryEntry,
} from "../harness/src/runtime/assessment-information-gain.js";
import { evaluateAssessmentFollowupInformationGain } from "../harness/src/runtime/assessment-information-gain.js";
import { deriveAssessmentInformationGainAuthority } from "../harness/src/validators/assessment-execution-validator.js";
import {
  deriveMarketPriorityAndCommercialReadiness,
  deriveQuantitativeDecisionUse,
} from "../harness/src/validators/quantitative-research-semantics.js";

function evidence(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    evidence_ref: "evidence/records/synthetic-api-metric.json",
    subject_ids: ["candidate_current"],
    disposition: "adopted",
    freshness_status: "current",
    claim_type: "current_purchase_behavior",
    source_profile: {
      type: "api_dataset",
      metric_definition: "Synthetic completed purchases for the target population.",
      metric_unit: "purchases",
      period: "2026-Q2",
      geography: "United States",
      sample_or_population: "Synthetic target population",
      measurement_type: "direct_measurement",
      methodology: "Synthetic deterministic fixture",
      raw_provenance: "SYNTHETIC; no network call",
    },
    ...overrides,
  };
}

function observation(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    subject_id: "candidate_current",
    metric_family: "commercial_behavior",
    metric_semantics: "purchase_count",
    measurement_type: "direct_measurement",
    metric_definition: "Synthetic completed purchases for the target population.",
    geography: "United States",
    period: {
      period_start: "2026-04-01",
      period_end: "2026-06-30",
      as_of: null,
      label: "2026-Q2",
    },
    value: { shape: "point", value: 42, unit: "purchases", currency: null },
    sample_or_population: "Synthetic target population",
    comparability: {
      comparison_group: null,
      direct_comparison_allowed: false,
    },
    evidence_refs: ["evidence/records/synthetic-api-metric.json"],
    ...overrides,
  };
}

const traceable = (): boolean => true;

function authority(
  current: Partial<AssessmentInformationGainSnapshot> = {},
  routeHistory: readonly AssessmentRouteHistoryEntry[] = [],
): AssessmentInformationGainAuthority {
  return {
    current: {
      source_group_novelty: "duplicate",
      metric_family_coverage_change: "unchanged",
      subject_coverage_change: "unchanged",
      decision_or_uncertainty_change: "unchanged",
      new_evidence_character: "none",
      evidence_refs: [],
      evidence_bindings: [],
      source_groups: [],
      ...current,
    },
    route_history: routeHistory,
  };
}

const noGainHistory: readonly AssessmentRouteHistoryEntry[] = [
  {
    round: 0,
    route: "public_web",
    subject_ref: "artifacts/candidates/candidate-current.json",
    gate_ref: "artifacts/assessment/gates/followup-1.json",
    evidence_refs: [],
    evidence_bindings: [],
    source_groups: [],
    outcome: "no_material_gain",
  },
];

test("quantitative decision use retains numeric proxies without promoting them", () => {
  const source = evidence();
  const byRef = new Map([[String(source.evidence_ref), source]]);
  const proxy = observation({
    metric_family: "demand_scale",
    metric_semantics: "rating_count",
    measurement_type: "proxy",
  });
  const result = deriveQuantitativeDecisionUse(proxy, byRef, traceable);
  assert.equal(result.grade, "directional_proxy");
  assert.equal(result.direct_metric_semantics, false);

  const renamedReviewCount = deriveQuantitativeDecisionUse(
    observation(),
    new Map([
      [
        "evidence/records/synthetic-api-metric.json",
        evidence({
          claim_type: "recent_user_language",
          source_profile: {
            type: "review",
            platform: "Synthetic Forum",
            sample_description: "Self-selected synthetic comments.",
            selection_bias: "Self-selected participation.",
            time_range: "2026-Q2",
          },
        }),
      ],
    ]),
    traceable,
  );
  assert.equal(renamedReviewCount.grade, "directional_proxy");

  const direct = deriveQuantitativeDecisionUse(observation(), byRef, traceable);
  assert.equal(direct.grade, "decision_grade");
  const wrongSubject = deriveQuantitativeDecisionUse(
    observation({ subject_id: "candidate_other" }),
    byRef,
    traceable,
  );
  assert.equal(wrongSubject.grade, "context_only");
  const rejected = evidence({ disposition: "rejected" });
  assert.equal(
    deriveQuantitativeDecisionUse(
      observation(),
      new Map([[String(rejected.evidence_ref), rejected]]),
      traceable,
    ).grade,
    "context_only",
  );
});

test("provider identity is irrelevant while freshness and comparable scope are required", () => {
  const arbitraryProvider = evidence();
  const byRef = new Map([[String(arbitraryProvider.evidence_ref), arbitraryProvider]]);
  assert.equal(
    deriveQuantitativeDecisionUse(observation(), byRef, traceable).grade,
    "decision_grade",
  );

  arbitraryProvider.freshness_status = "historical";
  assert.equal(
    deriveQuantitativeDecisionUse(observation(), byRef, traceable).grade,
    "directional_proxy",
  );
  arbitraryProvider.freshness_status = "current";
  const incomparable = observation({
    comparability: {
      comparison_group: "comparison_two_subjects",
      direct_comparison_allowed: false,
    },
  });
  assert.equal(
    deriveQuantitativeDecisionUse(incomparable, byRef, traceable).grade,
    "directional_proxy",
  );
});

test("decision-grade requires typed quantitative capability rather than a renamed narrative", () => {
  const narrativeProfiles = [
    {
      type: "review",
      platform: "Synthetic Review Surface",
      sample_description: "Self-selected synthetic reviews.",
      selection_bias: "Self-selection.",
      time_range: "2026-Q2",
    },
    { type: "other", description: "Synthetic narrative with a number in its text." },
    { type: "company_material", supported_public_claims: ["company_statement"] },
  ];
  for (const sourceProfile of narrativeProfiles) {
    const source = evidence({ source_profile: sourceProfile });
    const result = deriveQuantitativeDecisionUse(
      observation(),
      new Map([[String(source.evidence_ref), source]]),
      traceable,
    );
    assert.equal(result.grade, "directional_proxy");
    assert.ok(result.basis_codes.includes("source_quantitative_capability_missing_or_mismatched"));
  }

  const pricingObservation = observation({
    metric_semantics: "price",
    measurement_type: "disclosed",
    metric_definition: "Published candidate monthly subscription price.",
    period: { period_start: null, period_end: null, as_of: "2026-08-01", label: "2026-08-01" },
    value: { shape: "point", value: 25, unit: "USD/month", currency: "USD" },
    sample_or_population: "Published standard candidate subscription plan",
  });
  const pricingSource = evidence({
    claim_type: "vendor_public_pricing",
    source_profile: {
      type: "company_material",
      supported_public_claims: ["public_pricing"],
      quantitative_capability: {
        metric_definition: "Published candidate monthly subscription price.",
        metric_unit: "USD/month",
        period: "2026-08-01",
        geography: "United States",
        sample_or_population: "Published standard candidate subscription plan",
        measurement_type: "disclosed",
        methodology: "Direct transcription of the public price schedule.",
      },
    },
  });
  assert.equal(
    deriveQuantitativeDecisionUse(
      pricingObservation,
      new Map([[String(pricingSource.evidence_ref), pricingSource]]),
      traceable,
    ).grade,
    "decision_grade",
  );

  const regulatorySource = evidence({
    source_profile: {
      type: "regulatory",
      effective_status: "effective",
      verified_at: "2026-08-01T00:00:00Z",
      quantitative_capability: {
        metric_definition: "Synthetic completed purchases for the target population.",
        metric_unit: "purchases",
        period: "2026-Q2",
        geography: "United States",
        sample_or_population: "Synthetic target population",
        measurement_type: "direct_measurement",
        methodology: "Aggregate regulatory filing counts; synthetic fixture only.",
      },
    },
  });
  assert.equal(
    deriveQuantitativeDecisionUse(
      observation(),
      new Map([[String(regulatorySource.evidence_ref), regulatorySource]]),
      traceable,
    ).grade,
    "decision_grade",
  );
});

function followup(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    concept_hypothesis_ref: "artifacts/candidates/candidate-current.json",
    action: "add_bounded_followup",
    gap_resolution_class: "public_web_resolvable",
    acquisition_route: "public_web",
    availability: "available_now",
    expected_decision_change: "key_confidence",
    target_decision: "key_confidence",
    wave_1_evidence_overlap: {
      overlap_level: "partial",
      overlapping_evidence_refs: ["evidence/records/wave-one.json"],
    },
    information_gain_assessment: {
      rationale: "Synthetic authored explanation only; the Harness derives gain authority.",
    },
    ...overrides,
  };
}

test("formal Assessment closure derives gain and ignores old-Plan or cross-subject Evidence", () => {
  const subjectRef = "concept-hypothesis.json";
  const dimension = "demand_and_behavior";
  const plan1 = "plans/research-plan.r1.json";
  const execution1 = "plans/research-execution.r1.json";
  const execution2 = "plans/research-execution.r2.json";
  const beforeLane = "artifacts/assessment/lanes/before.json";
  const afterLane = "artifacts/assessment/lanes/after.json";
  const beforeGate = "artifacts/assessment/gates/before.json";
  const afterGate = "artifacts/assessment/gates/after.json";
  const exactRef = "evidence/records/exact-current.json";
  const oldPlanRef = "evidence/records/old-plan.json";
  const otherSubjectRef = "evidence/records/other-subject.json";
  const entry = (path: string, schemaVersion: string, document: Record<string, unknown>) => ({
    path,
    schemaVersion,
    document,
    envelope: null,
  });
  const execution = (
    path: string,
    revision: number,
    researchPlanRef: string,
    parent: string | null,
    stages: readonly Record<string, unknown>[],
  ) =>
    entry(path, "startup_opportunity.research_execution_plan.assessment.current", {
      run_id: "run_gain_synthetic",
      revision,
      research_plan_ref: researchPlanRef,
      concept_hypothesis_ref: subjectRef,
      parent_execution_plan_ref: parent,
      stages,
    });
  const lane = (path: string, executionPlanRef: string, refs: readonly string[]) =>
    entry(path, "startup_opportunity.assessment_lane_result.v1", {
      run_id: "run_gain_synthetic",
      unit_id: path.includes("after") ? "unit_after" : "unit_before",
      concept_hypothesis_ref: subjectRef,
      execution_plan_ref: executionPlanRef,
      stage_id: path.includes("after") ? "stage_after" : "stage_before",
      dimension_results: [
        {
          dimension_id: dimension,
          evidence_refs: refs,
          supporting_claim_refs: [],
          opposing_claim_refs: [],
          judgment_assessment_refs: [],
          coverage_disposition: "partial",
          dimension_decision: "insufficient_evidence",
          decision_sufficiency: "insufficient",
        },
      ],
    });
  const gate = (path: string, executionPlanRef: string, laneRef: string) =>
    entry(path, "startup_opportunity.assessment_stage_gate.v1", {
      run_id: "run_gain_synthetic",
      execution_plan_ref: executionPlanRef,
      concept_hypothesis_ref: subjectRef,
      evaluated_lane_refs: [laneRef],
      dimension_decisions: [
        {
          dimension_id: dimension,
          lane_result_ref: laneRef,
          decision: "insufficient_evidence",
          decision_sufficiency: "insufficient",
        },
      ],
    });
  const assessmentEvidence = (
    path: string,
    executionPlanRef: string,
    researchPlanRef: string,
    conceptRef: string,
    sourceGroup: string,
    validAsOf: string,
    role: "support" | "oppose" = "support",
  ) =>
    entry(path, "startup_opportunity.assessment_evidence.v1", {
      run_id: "run_gain_synthetic",
      concept_hypothesis_ref: conceptRef,
      execution_plan_ref: executionPlanRef,
      research_plan_ref: researchPlanRef,
      source_group_id: sourceGroup,
      source_assessment: {
        independence: "independent_secondary",
        canonical_source_group: sourceGroup,
      },
      evidence_tier: "public_behavior_proxy",
      evidence_role: role,
      valid_as_of: validAsOf,
      mechanical_binding: { substrate_record_ref: `evidence/manifest.jsonl#${path}` },
    });
  const prior = entry(
    "adaptations/decisions/followup-one.json",
    "startup_opportunity.assessment_followup_decision.v1",
    {
      run_id: "run_gain_synthetic",
      action: "add_bounded_followup",
      concept_hypothesis_ref: subjectRef,
      dimension_id: dimension,
      current_followup_round: 0,
      acquisition_route: "public_web",
      stage_gate_ref: beforeGate,
      candidate_execution_plan_ref: execution2,
    },
  );
  const current = entry(
    "adaptations/decisions/followup-two.json",
    "startup_opportunity.assessment_followup_decision.v1",
    {
      run_id: "run_gain_synthetic",
      action: "add_bounded_followup",
      concept_hypothesis_ref: subjectRef,
      dimension_id: dimension,
      current_followup_round: 1,
      based_on_execution_plan_ref: execution2,
    },
  );
  const documents = [
    execution(execution1, 1, plan1, null, [
      {
        stage_id: "stage_before",
        gate_after: beforeGate,
        lanes: [{ reporting_dimensions: [dimension] }],
      },
    ]),
    execution(execution2, 2, plan1, execution1, [
      {
        stage_id: "stage_after",
        gate_before: beforeGate,
        gate_after: afterGate,
        lanes: [{ reporting_dimensions: [dimension] }],
      },
    ]),
    lane(beforeLane, execution1, []),
    lane(afterLane, execution2, [exactRef, oldPlanRef, otherSubjectRef]),
    gate(beforeGate, execution1, beforeLane),
    gate(afterGate, execution2, afterLane),
    assessmentEvidence(
      exactRef,
      execution2,
      plan1,
      subjectRef,
      "new_independent_group",
      "2026-08-02",
    ),
    assessmentEvidence(
      oldPlanRef,
      execution2,
      "plans/research-plan.r0.json",
      subjectRef,
      "old_group",
      "2026-08-02",
    ),
    assessmentEvidence(
      otherSubjectRef,
      execution2,
      plan1,
      "concept-other.json",
      "other_group",
      "2026-08-02",
    ),
    prior,
    current,
  ];
  const authority = deriveAssessmentInformationGainAuthority(
    current,
    new Map(documents.map((document) => [document.path, document])),
  );
  assert.deepEqual(authority.current.evidence_refs, [exactRef]);
  assert.equal(authority.current.evidence_bindings[0]?.evidence_ref, exactRef);
  assert.match(
    String(authority.current.evidence_bindings[0]?.content_hash),
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.deepEqual(authority.current.source_groups, ["new_independent_group"]);
  assert.equal(authority.current.source_group_novelty, "new_independent_group");
  assert.equal(authority.current.new_evidence_character, "independent");
  assert.equal(authority.route_history[0]?.outcome, "directional_added");
  assert.deepEqual(
    deriveAssessmentInformationGainAuthority(
      current,
      new Map(documents.map((document) => [document.path, document])),
    ),
    authority,
  );
  const reopenedDocuments = JSON.parse(JSON.stringify(documents)) as typeof documents;
  const reopenedCurrent = reopenedDocuments.find((document) => document.path === current.path);
  assert.ok(reopenedCurrent);
  assert.deepEqual(
    deriveAssessmentInformationGainAuthority(
      reopenedCurrent,
      new Map(reopenedDocuments.map((document) => [document.path, document])),
    ),
    authority,
  );

  const updated = assessmentEvidence(
    exactRef,
    execution2,
    plan1,
    subjectRef,
    "existing_group",
    "2026-08-03",
    "oppose",
  );
  const beforeExisting = assessmentEvidence(
    "evidence/records/existing.json",
    execution1,
    plan1,
    subjectRef,
    "existing_group",
    "2026-08-01",
  );
  const updatedBeforeLane = lane(beforeLane, execution1, [beforeExisting.path]);
  const updatedDocuments = documents.map((document) =>
    document.path === beforeLane
      ? updatedBeforeLane
      : document.path === exactRef
        ? updated
        : document,
  );
  updatedDocuments.push(beforeExisting);
  const updatedAuthority = deriveAssessmentInformationGainAuthority(
    current,
    new Map(updatedDocuments.map((document) => [document.path, document])),
  );
  assert.equal(updatedAuthority.current.source_group_novelty, "updated_same_group");
  assert.equal(updatedAuthority.current.new_evidence_character, "opposing");
});

test("repeated no-gain routes switch or stop while counterevidence remains eligible", () => {
  assert.ok(
    evaluateAssessmentFollowupInformationGain(followup(), authority({}, noGainHistory)).some(
      (issue) => issue.code === "assessment_information_gain.route_switch_required",
    ),
  );
  const switched = followup({
    gap_resolution_class: "api_or_professional_data_resolvable",
    acquisition_route: "public_api",
  });
  assert.equal(
    evaluateAssessmentFollowupInformationGain(switched, authority({}, noGainHistory)).some(
      (issue) => issue.code === "assessment_information_gain.route_switch_required",
    ),
    false,
  );
  const counterevidence = authority(
    {
      source_group_novelty: "same_group",
      metric_family_coverage_change: "unchanged",
      subject_coverage_change: "unchanged",
      decision_or_uncertainty_change: "conflict_added",
      new_evidence_character: "opposing",
      evidence_refs: ["evidence/records/opposing.json"],
      evidence_bindings: [],
      source_groups: ["same_synthetic_group"],
    },
    noGainHistory,
  );
  assert.equal(evaluateAssessmentFollowupInformationGain(followup(), counterevidence).length, 0);
});

test("same-group directional proxies and not-applicable coverage cannot self-declare gain", () => {
  for (const metricFamilyCoverageChange of ["directional_added", "not_applicable"] as const) {
    const repeated = authority(
      {
        source_group_novelty: "same_group",
        metric_family_coverage_change: metricFamilyCoverageChange,
        subject_coverage_change: "unchanged",
        decision_or_uncertainty_change: "unchanged",
        new_evidence_character: "corroborating",
      },
      noGainHistory,
    );
    assert.ok(
      evaluateAssessmentFollowupInformationGain(followup(), repeated).some(
        (issue) => issue.code === "assessment_information_gain.route_switch_required",
      ),
    );
  }

  const independentDirectional = authority(
    {
      source_group_novelty: "new_independent_group",
      metric_family_coverage_change: "directional_added",
      subject_coverage_change: "unchanged",
      decision_or_uncertainty_change: "unchanged",
      new_evidence_character: "independent",
      evidence_refs: ["evidence/records/independent.json"],
      evidence_bindings: [],
      source_groups: ["independent_group"],
    },
    noGainHistory,
  );
  assert.equal(
    evaluateAssessmentFollowupInformationGain(followup(), independentDirectional).length,
    0,
  );

  const unsupportedUncertaintyClaim = authority(
    {
      source_group_novelty: "same_group",
      metric_family_coverage_change: "directional_added",
      subject_coverage_change: "unchanged",
      decision_or_uncertainty_change: "uncertainty_reduced",
      new_evidence_character: "corroborating",
    },
    noGainHistory,
  );
  assert.ok(
    evaluateAssessmentFollowupInformationGain(followup(), unsupportedUncertaintyClaim).some(
      (issue) => issue.code === "assessment_information_gain.route_switch_required",
    ),
  );
});

test("route history is subject-local and only consecutive no-gain outcomes force stopping", () => {
  const unrelatedHistory = authority({}, [
    {
      round: 0,
      route: "public_web",
      subject_ref: "artifacts/candidates/candidate-other.json",
      gate_ref: "artifacts/assessment/gates/other.json",
      evidence_refs: [],
      evidence_bindings: [],
      source_groups: ["unrelated_group"],
      outcome: "no_material_gain",
    },
  ]);
  assert.equal(evaluateAssessmentFollowupInformationGain(followup(), unrelatedHistory).length, 0);

  const interruptedNoGain = authority({}, [
    {
      round: 0,
      route: "public_web",
      subject_ref: "artifacts/candidates/candidate-current.json",
      gate_ref: "artifacts/assessment/gates/first.json",
      evidence_refs: [],
      evidence_bindings: [],
      source_groups: ["first_group"],
      outcome: "no_material_gain",
    },
    {
      round: 1,
      route: "public_api",
      subject_ref: "artifacts/candidates/candidate-current.json",
      gate_ref: "artifacts/assessment/gates/second.json",
      evidence_refs: ["evidence/records/independent.json"],
      evidence_bindings: [],
      source_groups: ["independent_group"],
      outcome: "decision_grade_added",
    },
    {
      round: 2,
      route: "public_web",
      subject_ref: "artifacts/candidates/candidate-current.json",
      gate_ref: "artifacts/assessment/gates/third.json",
      evidence_refs: [],
      evidence_bindings: [],
      source_groups: ["last_group"],
      outcome: "no_material_gain",
    },
  ]);
  assert.equal(
    evaluateAssessmentFollowupInformationGain(followup(), interruptedNoGain).some(
      (issue) => issue.code === "assessment_information_gain.stop_required",
    ),
    false,
  );
});

test("market priority remains independent from commercial validation readiness", () => {
  const result = deriveMarketPriorityAndCommercialReadiness({
    coverage: {
      recent_user_language: { state: "observed" },
      purchase_signal: { state: "unknown" },
      alternatives_pricing_usage: { state: "unknown" },
      distribution_channel: { state: "unknown" },
    },
    quantitativeCoverage: [],
    quantitativeObservations: [
      {
        metric_family: "demand_scale",
        decision_use: { grade: "directional_proxy" },
      },
    ],
    competitiveCoverage: [{ state: "observed" }, { state: "not_applicable" }],
  });
  assert.equal((result.market_research_priority as Record<string, unknown>).level, "high");
  assert.equal(
    (result.commercial_validation_readiness as Record<string, unknown>).level,
    "not_ready",
  );
  const table = renderMarketPriorityAndCommercialReadiness({
    commercial_subject_aggregates: [
      {
        subject_id: "candidate_current",
        ...result,
      },
    ],
  });
  assert.match(table, /Market Research Priority/);
  assert.match(table, /high/);
  assert.match(table, /Commercial Validation Readiness/);
  assert.match(table, /not_ready/);

  const zhTable = renderMarketPriorityAndCommercialReadiness(
    {
      commercial_subject_aggregates: [
        {
          subject_id: "candidate_current",
          ...result,
        },
      ],
    },
    true,
  );
  for (const leaked of [
    "high",
    "not_ready",
    "directional_demand_signal",
    "competitive_scope_disposed",
    "candidate_purchase_or_commitment",
    "acquisition_or_distribution",
    "retention_or_usage",
    "unit_economics",
  ]) {
    assert.doesNotMatch(zhTable, new RegExp(`\\b${leaked}\\b`));
  }
  assert.match(zhTable, /高/);
  assert.match(zhTable, /未就绪/);

  const zhQuantitative = renderQuantitativeSignalTable(
    {
      quantitative_signal_rows: [
        {
          observation: {
            ...observation(),
            decision_use: { grade: "decision_grade" },
          },
        },
        {
          observation: {
            ...observation({ metric_semantics: "rating_count", measurement_type: "proxy" }),
            decision_use: { grade: "directional_proxy" },
          },
        },
        {
          observation: {
            ...observation({ metric_semantics: "other", measurement_type: "modeled" }),
            decision_use: { grade: "context_only" },
          },
        },
      ],
    },
    true,
  );
  assert.doesNotMatch(zhQuantitative, /decision_grade|directional_proxy|context_only/);
  assert.match(zhQuantitative, /决策级/);
  assert.match(zhQuantitative, /方向性代理指标/);
  assert.match(zhQuantitative, /仅作背景/);
});

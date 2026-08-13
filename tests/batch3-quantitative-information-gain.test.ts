import assert from "node:assert/strict";
import test from "node:test";
import { renderMarketPriorityAndCommercialReadiness } from "../harness/src/reporting/commercial-report-tables.js";
import { evaluateAssessmentFollowupInformationGain } from "../harness/src/runtime/assessment-information-gain.js";
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
      metric_definition: "Synthetic fixture metric",
      period: "2026-Q2",
      geography: "United States",
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
    period: { period_start: "2026-04-01", period_end: "2026-06-30", as_of: null },
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
      source_group_novelty: "same_group",
      metric_family_coverage_change: "unchanged",
      subject_coverage_change: "unchanged",
      decision_or_uncertainty_change: "unchanged",
      new_evidence_character: "corroborating",
    },
    route_history: [
      {
        round: 0,
        route: "public_web",
        source_group: "same_synthetic_group",
        metric_family: "demand_scale",
        subject_ref: "artifacts/candidates/candidate-current.json",
        outcome: "no_material_gain",
      },
    ],
    ...overrides,
  };
}

test("repeated no-gain routes switch or stop while counterevidence remains eligible", () => {
  assert.ok(
    evaluateAssessmentFollowupInformationGain(followup()).some(
      (issue) => issue.code === "assessment_information_gain.route_switch_required",
    ),
  );
  const switched = followup({
    gap_resolution_class: "api_or_professional_data_resolvable",
    acquisition_route: "public_api",
  });
  assert.equal(
    evaluateAssessmentFollowupInformationGain(switched).some(
      (issue) => issue.code === "assessment_information_gain.route_switch_required",
    ),
    false,
  );
  const counterevidence = followup({
    information_gain_assessment: {
      source_group_novelty: "same_group",
      metric_family_coverage_change: "unchanged",
      subject_coverage_change: "unchanged",
      decision_or_uncertainty_change: "conflict_added",
      new_evidence_character: "opposing",
    },
  });
  assert.equal(evaluateAssessmentFollowupInformationGain(counterevidence).length, 0);
});

test("same-group directional proxies and not-applicable coverage cannot self-declare gain", () => {
  for (const metricFamilyCoverageChange of ["directional_added", "not_applicable"]) {
    const repeated = followup({
      information_gain_assessment: {
        source_group_novelty: "same_group",
        metric_family_coverage_change: metricFamilyCoverageChange,
        subject_coverage_change: "unchanged",
        decision_or_uncertainty_change: "unchanged",
        new_evidence_character: "corroborating",
      },
    });
    assert.ok(
      evaluateAssessmentFollowupInformationGain(repeated).some(
        (issue) => issue.code === "assessment_information_gain.route_switch_required",
      ),
    );
  }

  const independentDirectional = followup({
    information_gain_assessment: {
      source_group_novelty: "new_independent_group",
      metric_family_coverage_change: "directional_added",
      subject_coverage_change: "unchanged",
      decision_or_uncertainty_change: "unchanged",
      new_evidence_character: "independent",
    },
  });
  assert.equal(evaluateAssessmentFollowupInformationGain(independentDirectional).length, 0);

  const unsupportedUncertaintyClaim = followup({
    information_gain_assessment: {
      source_group_novelty: "same_group",
      metric_family_coverage_change: "directional_added",
      subject_coverage_change: "unchanged",
      decision_or_uncertainty_change: "uncertainty_reduced",
      new_evidence_character: "corroborating",
    },
  });
  assert.ok(
    evaluateAssessmentFollowupInformationGain(unsupportedUncertaintyClaim).some(
      (issue) => issue.code === "assessment_information_gain.route_switch_required",
    ),
  );
});

test("route history is subject-local and only consecutive no-gain outcomes force stopping", () => {
  const unrelatedHistory = followup({
    route_history: [
      {
        round: 0,
        route: "public_web",
        source_group: "unrelated_group",
        metric_family: "demand_scale",
        subject_ref: "artifacts/candidates/candidate-other.json",
        outcome: "no_material_gain",
      },
    ],
  });
  assert.equal(evaluateAssessmentFollowupInformationGain(unrelatedHistory).length, 0);

  const interruptedNoGain = followup({
    route_history: [
      {
        round: 0,
        route: "public_web",
        source_group: "first_group",
        metric_family: "demand_scale",
        subject_ref: "artifacts/candidates/candidate-current.json",
        outcome: "no_material_gain",
      },
      {
        round: 1,
        route: "public_api",
        source_group: "independent_group",
        metric_family: "demand_scale",
        subject_ref: "artifacts/candidates/candidate-current.json",
        outcome: "decision_grade_added",
      },
      {
        round: 2,
        route: "public_web",
        source_group: "last_group",
        metric_family: "demand_scale",
        subject_ref: "artifacts/candidates/candidate-current.json",
        outcome: "no_material_gain",
      },
    ],
  });
  assert.equal(
    evaluateAssessmentFollowupInformationGain(interruptedNoGain).some(
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
});

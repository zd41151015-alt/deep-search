import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  createArtifactValidator,
  type DocumentBundle,
  deriveReportEnvelopes,
  EvidenceStore,
  type EvidenceStoreRecord,
  type FormalArtifactEnvelope,
  ReportRuntime,
  RunStore,
  StoreError,
} from "../harness/src/index.js";
import {
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import { G22_DEMAND_R2, G22_FAN_IN } from "./fixtures/g2.2/discovery-candidate-fixture.js";
import {
  G23_OPPORTUNITY_A,
  G23_OPPORTUNITY_B,
} from "./fixtures/g2.3/discovery-synthesis-fixture.js";
import {
  G24_COMPARISON_A,
  G24_PORTFOLIO,
  G24_RECOMMENDATION,
  G24_REPORT,
} from "./fixtures/g2.4/discovery-evaluation-fixture.js";
import {
  createG33AiBundleFixture,
  createG33CompleteAiBundleFixture,
  createG33NonAiBindingFixture,
  G31_BENCHMARK,
  G31_CAPABILITY,
  G31_DATA,
  G31_RELIABILITY,
  G32_COMMODITIZATION,
  G32_ECONOMICS,
  G32_TRUST,
  G33_MANDATORY_BUNDLE,
  g3Envelope,
  refreshG3Envelope,
  refreshG33FixtureHashes,
} from "./fixtures/g3/ai-bundle-fixture.js";
import { createConfirmedRun } from "./helpers/current-run.js";
import { discoveryWaveEnvelopes } from "./helpers/discovery-wave.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function record(runId: string, unitId: string, fill: string): EvidenceStoreRecord {
  return {
    schema_version: "startup_opportunity.evidence_store_record.v2",
    evidence_id: `ev_${fill.repeat(64)}`,
    run_id: runId,
    unit_id: unitId,
    source: {
      kind: "user_provided",
      canonical_uri: `urn:startup-opportunity:user-provided:g3-3-synthetic-${fill}`,
    },
    source_hash: `sha256:${fill.repeat(64)}`,
    content_hash: `sha256:${fill.repeat(64)}`,
    research_goal: "SYNTHETIC unverified fixture substrate; not real Evidence.",
    raw_content_ref: `evidence/raw/sha256-${fill.repeat(64)}.bin`,
    operation_key: `sha256:${fill.repeat(64)}`,
    recorded_at: "2026-07-29T00:00:00Z",
  };
}

async function fixture(suffix: string): Promise<DocumentBundle> {
  const runId = `g3-3-${suffix}-synthetic`;
  return createG33AiBundleFixture(runId, {
    generation: record(runId, "unit_seed_independent_demand", "a"),
    evaluation: record(runId, "unit_counterfactual", "b"),
    support: record(runId, "unit_enrichment_support", "c"),
    challenge: record(runId, "unit_enrichment_challenge", "d"),
  });
}

async function completeFixture(suffix: string): Promise<DocumentBundle> {
  const runId = `g3-3-complete-${suffix}-synthetic`;
  return createG33CompleteAiBundleFixture(runId, {
    generation: record(runId, "unit_seed_independent_demand", "a"),
    evaluation: record(runId, "unit_counterfactual", "b"),
    support: record(runId, "unit_enrichment_support", "c"),
    challenge: record(runId, "unit_enrichment_challenge", "d"),
  });
}

function allErrors(
  result: ReturnType<Awaited<ReturnType<typeof createArtifactValidator>>["validateDocumentBundle"]>,
) {
  return [
    ...result.bundleErrors,
    ...result.documents.flatMap((document) => document.errors),
    ...result.referenceErrors,
  ];
}

function codes(
  result: ReturnType<Awaited<ReturnType<typeof createArtifactValidator>>["validateDocumentBundle"]>,
): readonly string[] {
  return allErrors(result).map((error) => error.code);
}

function currentAiConsumers(bundle: DocumentBundle): FormalArtifactEnvelope[] {
  return bundle.documents
    .map((entry) => entry.document as unknown as FormalArtifactEnvelope)
    .filter(
      (entry) =>
        entry.schema_version === "startup_opportunity.artifact_envelope.current" &&
        typeof entry.ai_bundle_binding === "object" &&
        entry.ai_bundle_binding !== null,
    );
}

function boundAiConsumers(bundle: DocumentBundle): FormalArtifactEnvelope[] {
  return currentAiConsumers(bundle).filter((consumer) => binding(consumer).status === "bound");
}

function binding(envelope: FormalArtifactEnvelope): Record<string, unknown> {
  assert.ok(typeof envelope.ai_bundle_binding === "object" && envelope.ai_bundle_binding !== null);
  return envelope.ai_bundle_binding as Record<string, unknown>;
}

function updateBoundBundleHash(bundle: DocumentBundle): void {
  const hash = canonicalContentHash(g3Envelope(bundle, G33_MANDATORY_BUNDLE).document);
  for (const consumer of boundAiConsumers(bundle)) {
    binding(consumer).bundle_content_hash = hash;
  }
}

function setBoundConclusionCeiling(bundle: DocumentBundle, ceiling: string): void {
  g3Envelope(bundle, G33_MANDATORY_BUNDLE).document.conclusion_ceiling = ceiling;
  for (const consumer of boundAiConsumers(bundle)) {
    binding(consumer).conclusion_ceiling = ceiling;
  }
  refreshG33FixtureHashes(bundle);
}

test("G3.3 validates fixed six-dimension mandatory coverage and explicit consumer binding", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const bundle = await fixture("valid");
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, true, JSON.stringify(allErrors(result), null, 2));

  const mandatory = g3Envelope(bundle, G33_MANDATORY_BUNDLE).document;
  assert.deepEqual(
    (mandatory.dimension_results as Record<string, unknown>[]).map((entry) => entry.dimension),
    [
      "capability_frontier",
      "cost_and_deployment",
      "workflow_and_human_boundary",
      "ecosystem_and_platform",
      "data_and_evaluation",
      "adoption_and_trust",
    ],
  );
  assert.equal(mandatory.bundle_status, "desk_research_only");
  assert.equal(mandatory.conclusion_ceiling, "insufficient_evidence");
});

test("current Envelope directly rejects AI producer ownership drift", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const bundle = await fixture("direct-producer-ownership");
  const benchmark = g3Envelope(bundle, G31_BENCHMARK);
  const result = validator.validateDocument(
    { ...benchmark, producer_role: "adversarial_reviewer" },
    benchmark.artifact_path,
  );

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.instancePath === "/producer_role"));
});

test("complete G3 bundle rejects every migrated grouped producer ownership drift", async (t) => {
  const validator = await createArtifactValidator(repositoryRoot);
  const valid = await fixture("grouped-producer-ownership");
  const ownershipGroups = {
    lane_researcher: [
      "startup_opportunity.ai_adoption_trust.v1",
      "startup_opportunity.ai_capability_benchmark.v1",
      "startup_opportunity.ai_data_dependency.v1",
      "startup_opportunity.ai_evaluation_reliability.v1",
      "startup_opportunity.ai_inference_unit_economics.v1",
      "startup_opportunity.capability_commoditization_risk.v1",
      "startup_opportunity.capability_evidence.v1",
      "startup_opportunity.evidence.discovery_evaluation.current",
      "startup_opportunity.claim.discovery_evaluation.current",
      "startup_opportunity.finding.discovery_evaluation.current",
      "startup_opportunity.insight.discovery_evaluation.current",
      "startup_opportunity.judgment_assessment.discovery_evaluation.current",
      "startup_opportunity.source_manifest.discovery_evaluation.current",
      "startup_opportunity.enrichment_branch_result.v1",
    ],
    main_agent: [
      "startup_opportunity.enrichment_fan_in.v1",
      "startup_opportunity.business_engine_thesis.discovery_evaluation.current",
      "startup_opportunity.buyer_purchase_language.v1",
      "startup_opportunity.portfolio_view.v1",
      "startup_opportunity.sensitivity.v1",
      "startup_opportunity.user_state_context_model.v1",
      "startup_opportunity.value_layer_analysis.v1",
    ],
  } as const;

  for (const [expectedRole, artifactTypes] of Object.entries(ownershipGroups)) {
    for (const artifactType of artifactTypes) {
      await t.test(artifactType, () => {
        const bundle = structuredClone(valid) as DocumentBundle;
        const envelope = bundle.documents
          .map((entry) => entry.document as unknown as FormalArtifactEnvelope)
          .find((candidate) => candidate.artifact_type === artifactType);
        assert.ok(envelope, `${artifactType} fixture is missing`);
        assert.equal(envelope.producer_role, expectedRole);
        (envelope as { producer_role: string }).producer_role =
          expectedRole === "main_agent" ? "lane_researcher" : "adversarial_reviewer";

        const result = validator.validateDocumentBundle(bundle);
        assert.equal(result.valid, false);
        assert.ok(
          allErrors(result).some((error) => error.instancePath === "/producer_role"),
          JSON.stringify(allErrors(result), null, 2),
        );
      });
    }
  }
});

test("opportunity comparison requires an exact AI bundle binding", async (t) => {
  const validator = await createArtifactValidator(repositoryRoot);

  await t.test("missing binding", async () => {
    const bundle = await fixture("comparison-binding-missing");
    const comparison = g3Envelope(bundle, G24_COMPARISON_A);
    delete (comparison as { ai_bundle_binding?: unknown }).ai_bundle_binding;

    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(
      codes(result).includes("schema.required"),
      JSON.stringify(allErrors(result), null, 2),
    );
  });

  await t.test("wrong bundle ref closure", async () => {
    const bundle = await fixture("comparison-binding-wrong-ref");
    const comparison = g3Envelope(bundle, G24_COMPARISON_A);
    binding(comparison).bundle_ref = G31_BENCHMARK;

    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(
      codes(result).includes("g3.bound_bundle_identity_mismatch"),
      JSON.stringify(allErrors(result), null, 2),
    );
  });
});

test("G3.3 complete bundle permits the v3 first-bet path when every other ceiling is ready", async () => {
  const bundle = await completeFixture("valid");
  const validator = await createArtifactValidator(repositoryRoot);
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, true, JSON.stringify(allErrors(result), null, 2));

  const mandatory = g3Envelope(bundle, G33_MANDATORY_BUNDLE).document;
  assert.equal(mandatory.bundle_status, "complete");
  assert.equal(mandatory.conclusion_ceiling, "prioritize_allowed");
  const comparison = g3Envelope(bundle, G24_COMPARISON_A);
  assert.equal(binding(comparison).coverage_state, "complete");
  assert.equal(comparison.document.recommendation_band, "strong_candidate");
  assert.equal(g3Envelope(bundle, G24_RECOMMENDATION).document.decision_tier, "prioritize");
});

test("G3.3 mandatory ceiling aggregates each specialized input and uses the strictest value", async (t) => {
  const mutations: readonly {
    readonly name: string;
    readonly artifactPath: string;
    readonly expected: string;
    readonly mutate: (document: Record<string, unknown>) => void;
  }[] = [
    {
      name: "capability",
      artifactPath: G31_CAPABILITY,
      expected: "insufficient_evidence",
      mutate(document) {
        const result = (document.dimension_results as Record<string, unknown>[])[0];
        assert.ok(result);
        result.coverage_status = "insufficient_evidence";
      },
    },
    {
      name: "benchmark",
      artifactPath: G31_BENCHMARK,
      expected: "investigate_further_only",
      mutate(document) {
        (document.product_candidate_result as Record<string, unknown>).incremental_value_status =
          "partial";
      },
    },
    {
      name: "reliability",
      artifactPath: G31_RELIABILITY,
      expected: "investigate_further_only",
      mutate(document) {
        (document.technical_reliability as Record<string, unknown>).status = "partial";
      },
    },
    {
      name: "data",
      artifactPath: G31_DATA,
      expected: "investigate_further_only",
      mutate(document) {
        (document.ground_truth as Record<string, unknown>).status = "partial";
      },
    },
    {
      name: "economics",
      artifactPath: G32_ECONOMICS,
      expected: "investigate_further_only",
      mutate(document) {
        document.conclusion_ceiling = "investigate_further_only";
      },
    },
    {
      name: "commoditization",
      artifactPath: G32_COMMODITIZATION,
      expected: "investigate_further_only",
      mutate(document) {
        document.conclusion_ceiling = "investigate_further_only";
      },
    },
    {
      name: "adoption-trust",
      artifactPath: G32_TRUST,
      expected: "investigate_further_only",
      mutate(document) {
        document.conclusion_ceiling = "investigate_further_only";
      },
    },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, async () => {
      const validator = await createArtifactValidator(repositoryRoot);
      const bundle = await completeFixture(`single-${mutation.name}`);
      mutation.mutate(g3Envelope(bundle, mutation.artifactPath).document);
      refreshG33FixtureHashes(bundle);
      const result = validator.validateDocumentBundle(bundle);
      const mismatch = allErrors(result).find(
        (error) => error.code === "g3.mandatory_conclusion_ceiling_mismatch",
      );
      assert.equal(result.valid, false);
      assert.ok(mismatch);
      assert.equal(mismatch.details.expected, mutation.expected);
    });
  }

  await t.test("multiple-inputs-use-strictest", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await completeFixture("multiple");
    g3Envelope(bundle, G32_ECONOMICS).document.conclusion_ceiling = "investigate_further_only";
    g3Envelope(bundle, G32_COMMODITIZATION).document.conclusion_ceiling = "reject";
    refreshG33FixtureHashes(bundle);
    const result = validator.validateDocumentBundle(bundle);
    const mismatch = allErrors(result).find(
      (error) => error.code === "g3.mandatory_conclusion_ceiling_mismatch",
    );
    assert.equal(result.valid, false);
    assert.ok(mismatch);
    assert.equal(mismatch.details.expected, "reject");
  });
});

test("G3.3 complete coverage cannot override a specialized-input ceiling", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const bundle = await completeFixture("specialized-ceiling");
  g3Envelope(bundle, G32_ECONOMICS).document.conclusion_ceiling = "investigate_further_only";
  setBoundConclusionCeiling(bundle, "investigate_further_only");
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes("g3.consumer_conclusion_ceiling_violation"));
  assert.ok(codes(result).includes("g2_4.ai_mandatory_bundle_gate_violation"));
  assert.ok(codes(result).includes("g2_4.decision_tier_ceiling_violation"));
});

test("G3.3 complete AI readiness remains capped by other first-bet requirements", async (t) => {
  const mutations: readonly {
    readonly name: string;
    readonly mutate: (bundle: DocumentBundle) => void;
  }[] = [
    {
      name: "hard-gate",
      mutate(bundle) {
        const gates = g3Envelope(bundle, G24_COMPARISON_A).document.hard_gate_results as Record<
          string,
          unknown
        >[];
        const gate = gates.find((entry) => entry.gate_id === "business_engine");
        assert.ok(gate);
        gate.status = "insufficient_evidence";
      },
    },
    {
      name: "comparison-panel",
      mutate(bundle) {
        const panel = (
          g3Envelope(bundle, G24_COMPARISON_A).document.comparison_panels as Record<
            string,
            unknown
          >[]
        )[0];
        assert.ok(panel);
        panel.band = "weak";
        panel.decision_sufficiency = "insufficient";
      },
    },
    {
      name: "portfolio-first-bet",
      mutate(bundle) {
        const portfolio = g3Envelope(bundle, G24_PORTFOLIO).document;
        portfolio.recommended_first_bet = null;
        portfolio.alternative_bets = [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B];
      },
    },
    {
      name: "recommendation-first-bet",
      mutate(bundle) {
        const recommendation = g3Envelope(bundle, G24_RECOMMENDATION).document;
        recommendation.recommended_first_bet = null;
        recommendation.alternative_bets = [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B];
      },
    },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, async () => {
      const validator = await createArtifactValidator(repositoryRoot);
      const bundle = await completeFixture(`other-${mutation.name}`);
      mutation.mutate(bundle);
      refreshG33FixtureHashes(bundle);
      const result = validator.validateDocumentBundle(bundle);
      assert.equal(result.valid, false);
      assert.ok(codes(result).includes("g2_4.decision_tier_ceiling_violation"));
    });
  }
});

test("G3.3 coverage aggregation distinguishes insufficient evidence from not applicable", async (t) => {
  await t.test("summary-must-equal-six-results", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("summary");
    const mandatory = g3Envelope(bundle, G33_MANDATORY_BUNDLE).document;
    (mandatory.coverage_summary as Record<string, unknown>).covered = 5;
    refreshG3Envelope(bundle, G33_MANDATORY_BUNDLE);
    updateBoundBundleHash(bundle);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.mandatory_coverage_summary_mismatch"));
  });

  await t.test("source-unavailable-cannot-be-not-applicable", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("unavailable");
    const mandatory = g3Envelope(bundle, G33_MANDATORY_BUNDLE).document;
    const dimension = (mandatory.dimension_results as Record<string, unknown>[])[0];
    assert.ok(dimension);
    dimension.coverage_status = "not_applicable";
    dimension.source_unavailable = true;
    dimension.not_applicable_reason = "SYNTHETIC domain reason.";
    (mandatory.coverage_summary as Record<string, unknown>).covered = 5;
    (mandatory.coverage_summary as Record<string, unknown>).not_applicable = 1;
    refreshG3Envelope(bundle, G33_MANDATORY_BUNDLE);
    updateBoundBundleHash(bundle);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.coverage_status_invalid"));
  });
});

test("G3.3 missing bundle remains valid only with an explicit degraded binding", async (t) => {
  function removeBundleAndCap(bundle: DocumentBundle): void {
    const documents = bundle.documents as { path: string; document: Record<string, unknown> }[];
    const index = documents.findIndex((entry) => entry.path === G33_MANDATORY_BUNDLE);
    assert.notEqual(index, -1);
    documents.splice(index, 1);
    for (const consumer of currentAiConsumers(bundle)) {
      const current = binding(consumer);
      current.status = "missing";
      current.bundle_ref = null;
      current.bundle_content_hash = null;
      current.coverage_state = "missing";
      current.conclusion_ceiling = "investigate_further_only";
      current.not_required_reason = null;
      (consumer as { input_refs: readonly string[] }).input_refs = consumer.input_refs.filter(
        (ref) => ref !== G33_MANDATORY_BUNDLE,
      );
    }
  }

  await t.test("degraded-consumers-validate", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("missing-capped");
    removeBundleAndCap(bundle);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, true, JSON.stringify(allErrors(result), null, 2));
  });

  await t.test("missing-bundle-cannot-prioritize", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("missing-prioritize");
    removeBundleAndCap(bundle);
    const recommendation = g3Envelope(bundle, G24_RECOMMENDATION);
    recommendation.document.decision_tier = "prioritize";
    refreshG3Envelope(bundle, G24_RECOMMENDATION);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.consumer_conclusion_ceiling_violation"));
  });
});

test("G3.3 selected uses_ai=false Solution requires explicit not_required bindings", async () => {
  const runId = "g3-3-non-ai-synthetic";
  const bundle = await createG33NonAiBindingFixture(runId, {
    generation: record(runId, "unit_seed_independent_demand", "a"),
    evaluation: record(runId, "unit_counterfactual", "b"),
    support: record(runId, "unit_enrichment_support", "c"),
    challenge: record(runId, "unit_enrichment_challenge", "d"),
  });
  const validator = await createArtifactValidator(repositoryRoot);
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, true, JSON.stringify(allErrors(result), null, 2));
  assert.ok(
    currentAiConsumers(bundle).every(
      (consumer) =>
        binding(consumer).status === "not_required" &&
        binding(consumer).bundle_ref === null &&
        binding(consumer).conclusion_ceiling === "not_required",
    ),
  );
});

test("G3.3 stale aggregation requires continuation and propagates to consumers", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const bundle = await fixture("stale");
  const economics = g3Envelope(bundle, G32_ECONOMICS).document;
  (economics.freshness as Record<string, unknown>).status = "stale";
  refreshG3Envelope(bundle, G32_ECONOMICS);

  const mandatory = g3Envelope(bundle, G33_MANDATORY_BUNDLE).document;
  const economicsHash = (mandatory.input_artifact_hashes as Record<string, unknown>[]).find(
    (entry) => entry.ref === G32_ECONOMICS,
  );
  assert.ok(economicsHash);
  economicsHash.content_hash = canonicalContentHash(economics);
  (mandatory.freshness as Record<string, unknown>).status = "stale";
  mandatory.bundle_status = "stale";
  (mandatory.continuation as Record<string, unknown>).reason = "stale";
  refreshG3Envelope(bundle, G33_MANDATORY_BUNDLE);
  updateBoundBundleHash(bundle);
  for (const consumer of boundAiConsumers(bundle)) {
    binding(consumer).coverage_state = "stale";
  }
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, true, JSON.stringify(allErrors(result), null, 2));
});

test("G3.3 incomplete, desk-only, and stale bundle states retain the AI ceiling", async (t) => {
  await t.test("incomplete", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await completeFixture("incomplete");
    const mandatory = g3Envelope(bundle, G33_MANDATORY_BUNDLE).document;
    const dimension = (mandatory.dimension_results as Record<string, unknown>[])[0];
    assert.ok(dimension);
    dimension.coverage_status = "insufficient_evidence";
    (mandatory.coverage_summary as Record<string, unknown>).covered = 5;
    (mandatory.coverage_summary as Record<string, unknown>).insufficient_evidence = 1;
    mandatory.bundle_status = "incomplete";
    mandatory.continuation = { required: true, reason: "incomplete", action: "SYNTHETIC" };
    for (const consumer of boundAiConsumers(bundle)) {
      binding(consumer).coverage_state = "incomplete";
    }
    setBoundConclusionCeiling(bundle, "insufficient_evidence");
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.consumer_conclusion_ceiling_violation"));
  });

  await t.test("desk-research-only", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("desk-ceiling");
    g3Envelope(bundle, G24_RECOMMENDATION).document.decision_tier = "prioritize";
    refreshG33FixtureHashes(bundle);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.consumer_conclusion_ceiling_violation"));
  });

  await t.test("stale", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await completeFixture("stale-ceiling");
    (g3Envelope(bundle, G32_ECONOMICS).document.freshness as Record<string, unknown>).status =
      "stale";
    const mandatory = g3Envelope(bundle, G33_MANDATORY_BUNDLE).document;
    (mandatory.freshness as Record<string, unknown>).status = "stale";
    mandatory.bundle_status = "stale";
    mandatory.continuation = { required: true, reason: "stale", action: "SYNTHETIC" };
    for (const consumer of boundAiConsumers(bundle)) {
      binding(consumer).coverage_state = "stale";
    }
    setBoundConclusionCeiling(bundle, "insufficient_evidence");
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.consumer_conclusion_ceiling_violation"));
  });
});

test("G3.3 report derivation keeps the exact binding on all current sidecars", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const bundle = await fixture("report");
  const derived = deriveReportEnvelopes(g3Envelope(bundle, G24_REPORT));
  assert.equal(derived.length, 3);
  assert.ok(
    derived.every(
      (entry) =>
        entry.schema_version === "startup_opportunity.artifact_envelope.current" &&
        canonicalContentHash(binding(entry)) ===
          canonicalContentHash(binding(g3Envelope(bundle, G24_REPORT))),
    ),
  );
  (bundle.documents as { path: string; document: Record<string, unknown> }[]).push(
    ...derived.map((entry) => ({
      path: entry.artifact_path,
      document: entry as unknown as Record<string, unknown>,
    })),
  );
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, true, JSON.stringify(allErrors(result), null, 2));
});

test("G3.3 uses the current evaluation and publication contracts", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  assert.equal(
    validator.discoveryEvaluationPolicy.schema_version,
    "startup_opportunity.discovery_evaluation_policy.current",
  );
  assert.deepEqual(validator.publicationPolicy.document.publication, {
    envelope_schema_version: "startup_opportunity.artifact_envelope.current",
    document_bundle_schema_version: "startup_opportunity.document_bundle.current",
    receipt_schema_version: "startup_opportunity.artifact_store_operation.current",
  });
});

async function lifecycleFixture(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g3-3-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "g3-3-lifecycle-synthetic";
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-29T00:00:00Z",
  });
  const evidence = new EvidenceStore(runsRoot);
  const recordEvidence = async (unitId: string, label: string) =>
    (
      await evidence.record({
        runId,
        unitId,
        source: {
          kind: "user_provided",
          canonical_uri: `urn:startup-opportunity:user-provided:g3-3-lifecycle-${label}`,
        },
        researchGoal: `SYNTHETIC ${label} substrate; not Evidence.`,
        rawContent: `SYNTHETIC ${label} bytes; not Evidence.`,
        recordedAt: "2026-07-29T00:10:00Z",
      })
    ).record;
  const bundle = await createG33AiBundleFixture(runId, {
    generation: await recordEvidence("unit_seed_independent_demand", "generation"),
    evaluation: await recordEvidence("unit_counterfactual", "evaluation"),
    support: await recordEvidence("unit_enrichment_support", "support"),
    challenge: await recordEvidence("unit_enrichment_challenge", "challenge"),
  });
  return { root, runsRoot, runId, validator, store, bundle };
}

function envelopes(
  bundle: DocumentBundle,
  version: FormalArtifactEnvelope["schema_version"],
): FormalArtifactEnvelope[] {
  return bundle.documents
    .map((entry) => entry.document as unknown as FormalArtifactEnvelope)
    .filter((entry) => entry.schema_version === version);
}

function byTypes(
  candidates: readonly FormalArtifactEnvelope[],
  ...types: readonly string[]
): FormalArtifactEnvelope[] {
  return candidates.filter((candidate) => types.includes(candidate.artifact_type));
}

const SYNTHESIS_ARTIFACT_TYPES = [
  "startup_opportunity.discovery_candidate_conversion.v2",
  "startup_opportunity.demand_thesis.v1",
  "startup_opportunity.baseline_option.v1",
  "startup_opportunity.solution_hypothesis.v1",
  "startup_opportunity.solution_evaluation.v1",
  "startup_opportunity.opportunity_thesis.v1",
  "startup_opportunity.thesis_evaluation_snapshot.v1",
  "startup_opportunity.merge.v1",
] as const;

const EVALUATION_AGGREGATE_ARTIFACT_TYPES = [
  "startup_opportunity.enrichment_fan_in.v1",
  "startup_opportunity.value_layer_analysis.v1",
  "startup_opportunity.user_state_context_model.v1",
  "startup_opportunity.buyer_purchase_language.v1",
  "startup_opportunity.business_engine_thesis.discovery_evaluation.current",
  "startup_opportunity.opportunity_comparison.v1",
  "startup_opportunity.sensitivity.v1",
  "startup_opportunity.portfolio_view.v1",
  "startup_opportunity.decision_recommendation.v1",
  "startup_opportunity.traceability.discovery.current",
  "startup_opportunity.report_consistency_evaluation.discovery.current",
] as const;

async function publishG33Prerequisites(
  state: Awaited<ReturnType<typeof lifecycleFixture>>,
): Promise<readonly FormalArtifactEnvelope[]> {
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: G21_CORE_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
  });

  const discovery = envelopes(state.bundle, "startup_opportunity.artifact_envelope.current");
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(discovery, "startup_opportunity.discovery_candidate.v1").filter(
      (candidate) => candidate.document.revision === 1,
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: discoveryWaveEnvelopes(
      state.bundle,
      state.runId,
      "startup_opportunity.research_task.discovery_candidate.current",
      1,
      "candidate_runtime",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(
      discovery,
      "startup_opportunity.evidence.discovery_candidate.current",
      "startup_opportunity.claim.discovery_candidate.current",
      "startup_opportunity.finding.discovery_candidate.current",
      "startup_opportunity.insight.discovery_candidate.current",
      "startup_opportunity.judgment_assessment.discovery_candidate.current",
      "startup_opportunity.source_manifest.discovery_candidate.current",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(discovery, "startup_opportunity.discovery_lane_result.v1"),
  });
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: discovery.find(
      (candidate) => candidate.artifact_path === G22_DEMAND_R2,
    ) as FormalArtifactEnvelope,
  });
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: discovery.find(
      (candidate) => candidate.artifact_path === G22_FAN_IN,
    ) as FormalArtifactEnvelope,
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(discovery, ...SYNTHESIS_ARTIFACT_TYPES),
  });

  const evaluation = envelopes(state.bundle, "startup_opportunity.artifact_envelope.current");
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: discoveryWaveEnvelopes(
      state.bundle,
      state.runId,
      "startup_opportunity.research_task.discovery_evaluation.current",
      2,
      "enrichment_runtime",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(
      evaluation,
      "startup_opportunity.evidence.discovery_evaluation.current",
      "startup_opportunity.claim.discovery_evaluation.current",
      "startup_opportunity.finding.discovery_evaluation.current",
      "startup_opportunity.insight.discovery_evaluation.current",
      "startup_opportunity.judgment_assessment.discovery_evaluation.current",
      "startup_opportunity.source_manifest.discovery_evaluation.current",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(evaluation, "startup_opportunity.enrichment_branch_result.v1"),
  });

  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(
      evaluation,
      "startup_opportunity.capability_evidence.v1",
      "startup_opportunity.ai_capability_benchmark.v1",
      "startup_opportunity.ai_evaluation_reliability.v1",
      "startup_opportunity.ai_data_dependency.v1",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(
      evaluation,
      "startup_opportunity.ai_inference_unit_economics.v1",
      "startup_opportunity.capability_commoditization_risk.v1",
      "startup_opportunity.ai_adoption_trust.v1",
    ),
  });
  const [mandatoryBundle] = byTypes(evaluation, "startup_opportunity.ai_mandatory_bundle.v1");
  assert.ok(mandatoryBundle);
  await state.store.publishArtifact({ runId: state.runId, envelope: mandatoryBundle });
  return evaluation;
}

async function publishG33Inputs(
  state: Awaited<ReturnType<typeof lifecycleFixture>>,
): Promise<void> {
  const evaluation = await publishG33Prerequisites(state);
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(evaluation, "startup_opportunity.commercial_research_audit.current"),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(evaluation, ...EVALUATION_AGGREGATE_ARTIFACT_TYPES),
  });
}

test("Artifact Store rejects grouped ownership and comparison binding drift", async (context) => {
  const state = await lifecycleFixture(context);
  const evaluation = await publishG33Prerequisites(state);
  const businessEngine = evaluation.find(
    (candidate) =>
      candidate.artifact_type ===
      "startup_opportunity.business_engine_thesis.discovery_evaluation.current",
  );
  const comparison = evaluation.find(
    (candidate) => candidate.artifact_type === "startup_opportunity.opportunity_comparison.v1",
  );
  assert.ok(businessEngine);
  assert.ok(comparison);

  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: { ...businessEngine, producer_role: "lane_researcher" },
    }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.schema_invalid",
  );

  const missingBinding = structuredClone(comparison) as FormalArtifactEnvelope;
  delete (missingBinding as { ai_bundle_binding?: unknown }).ai_bundle_binding;
  await assert.rejects(
    state.store.publishArtifact({ runId: state.runId, envelope: missingBinding }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.schema_invalid",
  );

  const preComparisonTypes = [
    "startup_opportunity.enrichment_fan_in.v1",
    "startup_opportunity.value_layer_analysis.v1",
    "startup_opportunity.user_state_context_model.v1",
    "startup_opportunity.buyer_purchase_language.v1",
    "startup_opportunity.business_engine_thesis.discovery_evaluation.current",
  ] as const;
  const preComparisonTypeSet = new Set<string>(preComparisonTypes);
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(evaluation, ...preComparisonTypes),
  });

  const wrongBinding = structuredClone(comparison) as FormalArtifactEnvelope;
  binding(wrongBinding).bundle_ref = G31_BENCHMARK;
  await assert.rejects(
    state.store.publishArtifact({ runId: state.runId, envelope: wrongBinding }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.reference_invalid",
  );

  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(evaluation, ...EVALUATION_AGGREGATE_ARTIFACT_TYPES).filter(
      (candidate) => !preComparisonTypeSet.has(candidate.artifact_type),
    ),
  });
});

test("G3.3 publication, report, checkpoint, and clean reopen preserve current coverage", async (context) => {
  const state = await lifecycleFixture(context);
  await publishG33Inputs(state);
  const runtime = new ReportRuntime(state.runsRoot, state.validator);
  const report = await runtime.build({
    reportEnvelope: g3Envelope(state.bundle, G24_REPORT),
  });
  assert.equal(report.status, "published");
  assert.match(
    await readFile(path.join(state.runsRoot, state.runId, "report.md"), "utf8"),
    /Portfolio/,
  );

  const checkpoint = await state.store.checkpoint({
    runId: state.runId,
    checkpointId: "checkpoint_g3_3_bundle",
    createdAt: "2026-07-29T02:00:00Z",
    nextStep: "SYNTHETIC preserve G3.3 mechanics for future whole-boundary review.",
    beliefSummary: {
      current_belief: "SYNTHETIC deterministic contract mechanics only.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["SYNTHETIC no market validation is claimed."],
      remaining_disagreement: ["SYNTHETIC all market truth remains unknown."],
      next_decision_relevant_question: "SYNTHETIC should the user commission more Evidence?",
    },
    inputRefs: [G33_MANDATORY_BUNDLE, G24_RECOMMENDATION, G24_REPORT],
  });
  assert.match(checkpoint.checkpointRef, /checkpoint-g3-3-bundle/);
  const reopened = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.equal(reopened.recovered, false);
  assert.ok(reopened.manifest.artifact_refs.includes(G33_MANDATORY_BUNDLE));
  assert.ok(reopened.manifest.artifact_refs.includes(report.consistencyEvaluationRef));
});

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
  type EvidenceStoreRecordV2,
  type FormalArtifactEnvelope,
  ReportRuntime,
  RunStore,
} from "../harness/src/index.js";
import {
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import { G22_DEMAND_R2, G22_FAN_IN } from "./fixtures/g2.2/discovery-candidate-fixture.js";
import { G24_RECOMMENDATION, G24_REPORT } from "./fixtures/g2.4/discovery-evaluation-fixture.js";
import {
  createG33AiBundleFixture,
  createG33NonAiBindingFixture,
  G32_ECONOMICS,
  G33_MANDATORY_BUNDLE,
  g3Envelope,
  refreshG3Envelope,
} from "./fixtures/g3/ai-bundle-fixture.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function record(runId: string, unitId: string, fill: string): EvidenceStoreRecordV2 {
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

function v16Consumers(bundle: DocumentBundle): FormalArtifactEnvelope[] {
  return bundle.documents
    .map((entry) => entry.document as unknown as FormalArtifactEnvelope)
    .filter(
      (entry) =>
        entry.schema_version === "startup_opportunity.artifact_envelope.v16" &&
        entry.artifact_type !== "startup_opportunity.ai_mandatory_bundle.v1",
    );
}

function binding(envelope: FormalArtifactEnvelope): Record<string, unknown> {
  assert.ok(typeof envelope.ai_bundle_binding === "object" && envelope.ai_bundle_binding !== null);
  return envelope.ai_bundle_binding as Record<string, unknown>;
}

function updateBoundBundleHash(bundle: DocumentBundle): void {
  const hash = canonicalContentHash(g3Envelope(bundle, G33_MANDATORY_BUNDLE).document);
  for (const consumer of v16Consumers(bundle)) {
    binding(consumer).bundle_content_hash = hash;
  }
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
    for (const consumer of v16Consumers(bundle)) {
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
    v16Consumers(bundle).every(
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
  for (const consumer of v16Consumers(bundle)) {
    binding(consumer).coverage_state = "stale";
  }
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, true, JSON.stringify(allErrors(result), null, 2));
});

test("G3.3 report derivation keeps the exact binding on all v16 sidecars", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const bundle = await fixture("report");
  const derived = deriveReportEnvelopes(g3Envelope(bundle, G24_REPORT));
  assert.equal(derived.length, 3);
  assert.ok(
    derived.every(
      (entry) =>
        entry.schema_version === "startup_opportunity.artifact_envelope.v16" &&
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

test("G3.3 version dispatch freezes v12-v15 and installs v16 receipt v14", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  assert.deepEqual(
    validator.publicationAdapter("startup_opportunity.artifact_envelope.v15")
      .blocked_artifact_types,
    ["startup_opportunity.ai_mandatory_bundle.v1"],
  );
  assert.equal(
    validator.publicationAdapter("startup_opportunity.artifact_envelope.v16").receipt_version,
    "startup_opportunity.artifact_store_operation.v14",
  );
  assert.deepEqual(
    validator.publicationAdapter("startup_opportunity.artifact_envelope.v16")
      .blocked_artifact_types,
    [],
  );
  assert.equal(
    validator.discoveryEvaluationPolicy.schema_version,
    "startup_opportunity.discovery_evaluation_policy.v3",
  );
});

async function lifecycleFixture(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g3-3-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "g3-3-lifecycle-synthetic";
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await store.create({
    runId,
    mode: "opportunity_discovery",
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

async function publishG33Inputs(
  state: Awaited<ReturnType<typeof lifecycleFixture>>,
): Promise<void> {
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: G21_CORE_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
  });

  const discovery = envelopes(state.bundle, "startup_opportunity.artifact_envelope.v10");
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(discovery, "startup_opportunity.discovery_candidate.v1").filter(
      (candidate) => candidate.document.revision === 1,
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(discovery, "startup_opportunity.research_task.v2"),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(
      discovery,
      "startup_opportunity.evidence.v2",
      "startup_opportunity.claim.v2",
      "startup_opportunity.finding.v2",
      "startup_opportunity.insight.v2",
      "startup_opportunity.judgment_assessment.v2",
      "startup_opportunity.source_manifest.v2",
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
    envelopes: envelopes(state.bundle, "startup_opportunity.artifact_envelope.v11"),
  });

  const evaluation = [
    ...envelopes(state.bundle, "startup_opportunity.artifact_envelope.v12"),
    ...envelopes(state.bundle, "startup_opportunity.artifact_envelope.v13"),
  ];
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(evaluation, "startup_opportunity.research_task.v3"),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(
      evaluation,
      "startup_opportunity.evidence.v3",
      "startup_opportunity.claim.v3",
      "startup_opportunity.finding.v3",
      "startup_opportunity.insight.v3",
      "startup_opportunity.judgment_assessment.v3",
      "startup_opportunity.source_manifest.v3",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(evaluation, "startup_opportunity.enrichment_branch_result.v1"),
  });

  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: envelopes(state.bundle, "startup_opportunity.artifact_envelope.v14"),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: envelopes(state.bundle, "startup_opportunity.artifact_envelope.v15"),
  });
  const finalEvaluation = [
    ...evaluation,
    ...envelopes(state.bundle, "startup_opportunity.artifact_envelope.v16"),
  ].filter(
    (candidate) =>
      ![
        "startup_opportunity.research_task.v3",
        "startup_opportunity.evidence.v3",
        "startup_opportunity.claim.v3",
        "startup_opportunity.finding.v3",
        "startup_opportunity.insight.v3",
        "startup_opportunity.judgment_assessment.v3",
        "startup_opportunity.source_manifest.v3",
        "startup_opportunity.enrichment_branch_result.v1",
        "startup_opportunity.report.v1",
      ].includes(candidate.artifact_type),
  );
  await state.store.publishArtifactBundle({ runId: state.runId, envelopes: finalEvaluation });
}

test("G3.3 publication, report, checkpoint, and clean reopen preserve v16 coverage", async (context) => {
  const state = await lifecycleFixture(context);
  await publishG33Inputs(state);
  const runtime = new ReportRuntime(state.runsRoot, state.validator);
  const report = await runtime.build({
    reportEnvelope: g3Envelope(state.bundle, G24_REPORT),
  });
  assert.equal(report.status, "published");
  assert.equal((await state.store.load(state.runId)).manifest.schema_bundle_version, "15.0.0");
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
  assert.equal(reopened.manifest.schema_bundle_version, "15.0.0");
  assert.ok(reopened.manifest.artifact_refs.includes(G33_MANDATORY_BUNDLE));
  assert.ok(reopened.manifest.artifact_refs.includes(report.consistencyEvaluationRef));
});

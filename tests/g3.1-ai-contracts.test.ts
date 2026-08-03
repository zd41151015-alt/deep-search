import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createArtifactValidator,
  type DocumentBundle,
  type EvidenceStoreRecord,
} from "../harness/src/index.js";
import {
  createG3AiBundleFixture,
  G31_BENCHMARK,
  G31_CAPABILITY,
  g3Envelope,
  refreshG3Envelope,
} from "./fixtures/g3/ai-bundle-fixture.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function record(runId: string, unitId: string, fill: string): EvidenceStoreRecord {
  return {
    schema_version: "startup_opportunity.evidence_store_record.v2",
    evidence_id: `ev_${fill.repeat(64)}`,
    run_id: runId,
    unit_id: unitId,
    source: {
      kind: "user_provided",
      canonical_uri: `urn:startup-opportunity:user-provided:g3-synthetic-${fill}`,
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
  const runId = `g3-1-${suffix}-synthetic`;
  return createG3AiBundleFixture(runId, {
    generation: record(runId, "unit_seed_independent_demand", "a"),
    evaluation: record(runId, "unit_counterfactual", "b"),
    support: record(runId, "unit_enrichment_support", "c"),
    challenge: record(runId, "unit_enrichment_challenge", "d"),
  });
}

function codes(
  result: ReturnType<Awaited<ReturnType<typeof createArtifactValidator>>["validateDocumentBundle"]>,
): readonly string[] {
  return [
    ...result.bundleErrors,
    ...result.documents.flatMap((document) => document.errors),
    ...result.referenceErrors,
  ].map((error) => error.code);
}

test("G3.1 validates caller-supplied baseline, reliability, and data contracts", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const bundle = await fixture("valid");
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));

  const benchmark = g3Envelope(bundle, G31_BENCHMARK).document;
  assert.deepEqual(
    (benchmark.baseline_results as Record<string, unknown>[]).map((entry) => entry.baseline_type),
    ["generic_model", "platform_native", "open_source"],
  );
  assert.equal(benchmark.research_mode, "representative_evaluation");
  assert.match(String((benchmark.limitations as string[])[0]), /SYNTHETIC and unverified/);
});

test("G3.1 fails closed on dimension, lineage, baseline, and freshness drift", async (t) => {
  await t.test("dimension-result-mismatch", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("dimension");
    const capability = g3Envelope(bundle, G31_CAPABILITY).document;
    (capability.dimension_results as unknown[]).pop();
    refreshG3Envelope(bundle, G31_CAPABILITY);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.dimension_result_mismatch"));
  });

  await t.test("subject-lineage-mismatch", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("lineage");
    const capability = g3Envelope(bundle, G31_CAPABILITY).document;
    (capability.lineage as Record<string, unknown>).subject_ref =
      "artifacts/discovery/opportunities/opportunity_household_variant.r1.json";
    refreshG3Envelope(bundle, G31_CAPABILITY);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.subject_lineage_mismatch"));
  });

  await t.test("baseline-set-is-closed", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("baseline");
    const benchmark = g3Envelope(bundle, G31_BENCHMARK).document;
    const firstBaseline = (benchmark.baseline_results as Record<string, unknown>[])[0];
    assert.ok(firstBaseline);
    firstBaseline.baseline_type = "custom";
    refreshG3Envelope(bundle, G31_BENCHMARK);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("schema.const"));
  });

  await t.test("freshness-window-is-monotonic", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("freshness");
    const benchmark = g3Envelope(bundle, G31_BENCHMARK).document;
    (benchmark.freshness as Record<string, unknown>).expires_at = "2026-07-28T00:00:00Z";
    refreshG3Envelope(bundle, G31_BENCHMARK);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.freshness_window_invalid"));
  });
});

test("G3.1 current contract permits explicit desk-research-only status", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const bundle = await fixture("dispatch");
  const deskBundle = structuredClone(bundle);
  const benchmark = g3Envelope(deskBundle, G31_BENCHMARK).document;
  benchmark.research_mode = "desk_research_only";
  refreshG3Envelope(deskBundle, G31_BENCHMARK);
  const result = validator.validateDocumentBundle(deskBundle);
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createArtifactValidator,
  type DocumentBundle,
  type EvidenceStoreRecordV2,
} from "../harness/src/index.js";
import {
  createG32AiBundleFixture,
  G31_CAPABILITY,
  G32_COMMODITIZATION,
  G32_ECONOMICS,
  G32_TRUST,
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
      canonical_uri: `urn:startup-opportunity:user-provided:g3-2-synthetic-${fill}`,
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
  const runId = `g3-2-${suffix}-synthetic`;
  return createG32AiBundleFixture(runId, {
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

test("G3.2 validates product inference economics, substitution, and trust contracts", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const bundle = await fixture("valid");
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));

  const economics = g3Envelope(bundle, G32_ECONOMICS).document;
  assert.deepEqual(economics.scope_boundary, {
    cost_scope: "product_inference_only",
    harness_execution_cost_included: false,
    agent_execution_cost_included: false,
  });
  const risk = g3Envelope(bundle, G32_COMMODITIZATION).document;
  assert.equal((risk.open_source_substitution as Record<string, unknown>).status, "unknown");
  const trust = g3Envelope(bundle, G32_TRUST).document;
  assert.equal((trust.regulated_ai_boundary as Record<string, unknown>).applicability, "unclear");
  assert.equal(trust.conclusion_ceiling, "insufficient_evidence");
});

test("G3.2 keeps product costs separate and enforces exact G3.1 lineage", async (t) => {
  await t.test("harness-cost-scope-is-closed", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("scope");
    const economics = g3Envelope(bundle, G32_ECONOMICS).document;
    (economics.scope_boundary as Record<string, unknown>).harness_execution_cost_included = true;
    refreshG3Envelope(bundle, G32_ECONOMICS);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("schema.const"));
  });

  await t.test("capability-ref-is-exact", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("capability");
    const economics = g3Envelope(bundle, G32_ECONOMICS).document;
    economics.capability_evidence_ref = G32_COMMODITIZATION;
    refreshG3Envelope(bundle, G32_ECONOMICS);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.economics_input_mismatch"));
  });

  await t.test("shared-lineage-cannot-drift", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("lineage");
    const risk = g3Envelope(bundle, G32_COMMODITIZATION).document;
    (risk.lineage as Record<string, unknown>).selected_solution_ref = G31_CAPABILITY;
    refreshG3Envelope(bundle, G32_COMMODITIZATION);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.lineage_mismatch"));
  });
});

test("G3.2 conclusion ceilings fail closed for unknown or blocked states", async (t) => {
  await t.test("desk-research-only-cannot-allow-prioritize", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("desk-ceiling");
    const economics = g3Envelope(bundle, G32_ECONOMICS).document;
    economics.conclusion_ceiling = "prioritize_allowed";
    refreshG3Envelope(bundle, G32_ECONOMICS);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.conclusion_ceiling_too_high"));
  });

  await t.test("triggered-product-kill-requires-reject", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("kill");
    const economics = g3Envelope(bundle, G32_ECONOMICS).document;
    (economics.kill_boundary as Record<string, unknown>).status = "triggered";
    refreshG3Envelope(bundle, G32_ECONOMICS);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.conclusion_ceiling_mismatch"));
  });

  await t.test("blocked-workflow-requires-reject", async () => {
    const validator = await createArtifactValidator(repositoryRoot);
    const bundle = await fixture("trust");
    const trust = g3Envelope(bundle, G32_TRUST).document;
    trust.workflow_entry_status = "blocked";
    refreshG3Envelope(bundle, G32_TRUST);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("g3.conclusion_ceiling_mismatch"));
  });
});

test("G3.2 version dispatch keeps v14 blocked and installs v15 receipt v13", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  assert.ok(
    validator
      .publicationAdapter("startup_opportunity.artifact_envelope.v14")
      .blocked_artifact_types.includes("startup_opportunity.ai_inference_unit_economics.v1"),
  );
  assert.equal(
    validator.publicationAdapter("startup_opportunity.artifact_envelope.v15").receipt_version,
    "startup_opportunity.artifact_store_operation.v13",
  );
  assert.deepEqual(
    validator.publicationAdapter("startup_opportunity.artifact_envelope.v15")
      .blocked_artifact_types,
    ["startup_opportunity.ai_mandatory_bundle.v1"],
  );
});

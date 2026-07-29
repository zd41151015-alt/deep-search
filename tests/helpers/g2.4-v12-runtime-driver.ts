import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalJson,
  createArtifactValidator,
  type DocumentBundle,
  EvidenceStore,
  type FormalArtifactEnvelope,
  RunStore,
  sha256Bytes,
} from "../../harness/src/index.js";
import {
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
} from "../fixtures/g2.1/discovery-maps-fixture.js";
import { createDiscoveryEvaluationFixture } from "../fixtures/g2.4/discovery-evaluation-fixture.js";

const G24_REPORT = "artifacts/reporting/report-json.r1.json";
const G24_RECOMMENDATION = "artifacts/comparison/decision-recommendation.r1.json";
const G24_TRACEABILITY = "artifacts/traceability/discovery-traceability.r1.json";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function effective(bundle: DocumentBundle, artifactPath: string): Record<string, unknown> {
  const entry = bundle.documents.find((candidate) => candidate.path === artifactPath);
  assert.ok(entry, artifactPath);
  return String(entry.document.schema_version).startsWith("startup_opportunity.artifact_envelope.")
    ? (entry.document.document as Record<string, unknown>)
    : entry.document;
}

function envelopes(
  bundle: DocumentBundle,
  version: FormalArtifactEnvelope["schema_version"],
): FormalArtifactEnvelope[] {
  return bundle.documents
    .map((candidate) => candidate.document as unknown as FormalArtifactEnvelope)
    .filter((candidate) => candidate.schema_version === version);
}

function byTypes(
  candidates: readonly FormalArtifactEnvelope[],
  ...types: readonly string[]
): FormalArtifactEnvelope[] {
  return candidates.filter((candidate) => types.includes(candidate.artifact_type));
}

async function publishThroughEvaluation(input: {
  readonly bundle: DocumentBundle;
  readonly runId: string;
  readonly store: RunStore;
}): Promise<void> {
  await input.store.publishArtifactBundle({
    runId: input.runId,
    envelopes: G21_CORE_REFS.map((ref) => fixtureEnvelope(input.bundle, ref)),
  });
  await input.store.publishArtifactBundle({
    runId: input.runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(input.bundle, ref)),
  });
  const candidates = envelopes(input.bundle, "startup_opportunity.artifact_envelope.v10");
  await input.store.publishArtifactBundle({
    runId: input.runId,
    envelopes: byTypes(candidates, "startup_opportunity.discovery_candidate.v1").filter(
      (candidate) => candidate.document.revision === 1,
    ),
  });
  await input.store.publishArtifactBundle({
    runId: input.runId,
    envelopes: byTypes(candidates, "startup_opportunity.research_task.v2"),
  });
  await input.store.publishArtifactBundle({
    runId: input.runId,
    envelopes: byTypes(
      candidates,
      "startup_opportunity.evidence.v2",
      "startup_opportunity.claim.v2",
      "startup_opportunity.finding.v2",
      "startup_opportunity.insight.v2",
      "startup_opportunity.judgment_assessment.v2",
      "startup_opportunity.source_manifest.v2",
    ),
  });
  await input.store.publishArtifactBundle({
    runId: input.runId,
    envelopes: byTypes(candidates, "startup_opportunity.discovery_lane_result.v1"),
  });
  for (const artifactPath of [
    "artifacts/discovery/candidates/candidate_demand.r2.json",
    "artifacts/discovery/fan-in.r1.json",
  ]) {
    const envelope = candidates.find((candidate) => candidate.artifact_path === artifactPath);
    assert.ok(envelope, artifactPath);
    await input.store.publishArtifact({ runId: input.runId, envelope });
  }
  await input.store.publishArtifactBundle({
    runId: input.runId,
    envelopes: envelopes(input.bundle, "startup_opportunity.artifact_envelope.v11"),
  });
  const evaluation = envelopes(input.bundle, "startup_opportunity.artifact_envelope.v12");
  await input.store.publishArtifactBundle({
    runId: input.runId,
    envelopes: byTypes(evaluation, "startup_opportunity.research_task.v3"),
  });
  await input.store.publishArtifactBundle({
    runId: input.runId,
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
  await input.store.publishArtifactBundle({
    runId: input.runId,
    envelopes: byTypes(evaluation, "startup_opportunity.enrichment_branch_result.v1"),
  });
  await input.store.publishArtifactBundle({
    runId: input.runId,
    envelopes: evaluation.filter(
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
    ),
  });
}

async function fileInventory(
  root: string,
  relative = "",
): Promise<readonly { readonly path: string; readonly size: number; readonly hash: string }[]> {
  const current = path.join(root, relative);
  const entries = await readdir(current, { withFileTypes: true });
  const inventory: { path: string; size: number; hash: string }[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      inventory.push(...(await fileInventory(root, child)));
    } else if (entry.isFile()) {
      const bytes = await readFile(path.join(root, child));
      inventory.push({ path: child, size: bytes.length, hash: sha256Bytes(bytes) });
    }
  }
  return inventory;
}

async function main(): Promise<void> {
  const repositoryRoot = argument("--repository-root");
  const fixturePath = argument("--fixture");
  const fixtureBytes = await readFile(fixturePath);
  const bundle = JSON.parse(fixtureBytes.toString("utf8")) as DocumentBundle;
  const runId = String(effective(bundle, "manifest.json").run_id);
  const root = await mkdtemp(path.join(tmpdir(), "g2-v12-runtime-oracle-"));
  const runsRoot = path.join(root, "runs");
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await store.create({
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-27T17:00:00Z",
  });
  const evidence = new EvidenceStore(runsRoot);
  const record = async (unitId: string, label: string) =>
    (
      await evidence.record({
        runId,
        unitId,
        source: {
          kind: "user_provided",
          canonical_uri: `urn:startup-opportunity:user-provided:cross-version-v12-${label}`,
        },
        researchGoal: `SYNTHETIC ${label} substrate; not Evidence.`,
        rawContent: `SYNTHETIC ${label} bytes; not Evidence.`,
        recordedAt: "2026-07-27T20:50:00Z",
      })
    ).record;
  const built = await createDiscoveryEvaluationFixture(
    runId,
    {
      generation: await record("unit_seed_independent_demand", "generation"),
      evaluation: await record("unit_counterfactual", "evaluation"),
      support: await record("unit_enrichment_support", "support"),
      challenge: await record("unit_enrichment_challenge", "challenge"),
    },
    "ai_first",
  );
  (built as { schema_version: string }).schema_version = "startup_opportunity.document_bundle.v12";
  for (const candidate of built.documents) {
    if (candidate.document.schema_version === "startup_opportunity.artifact_envelope.v13") {
      candidate.document.schema_version = "startup_opportunity.artifact_envelope.v12";
    }
  }
  effective(built, "manifest.json").schema_bundle_version = "11.0.0";
  assert.equal(`${canonicalJson(built)}\n`, fixtureBytes.toString("utf8"));

  const validation = validator.validateDocumentBundle(bundle);
  assert.equal(validation.valid, true, JSON.stringify(validation, null, 2));
  await publishThroughEvaluation({ bundle, runId, store });
  const report = envelopes(bundle, "startup_opportunity.artifact_envelope.v12").find(
    (candidate) => candidate.artifact_path === G24_REPORT,
  );
  assert.ok(report, G24_REPORT);
  await assert.rejects(
    store.publishArtifact({ runId, envelope: report, faultAt: "after_temp_write" }),
  );
  const recovered = await store.load(runId);
  assert.ok(recovered.recoveredArtifactPaths.includes(G24_REPORT));
  const checkpoint = await store.checkpoint({
    runId,
    checkpointId: "checkpoint_parent_v12_oracle",
    createdAt: "2026-07-27T22:01:00Z",
    nextStep: "SYNTHETIC preserve the frozen v12 evaluation adapter.",
    beliefSummary: {
      current_belief: "SYNTHETIC historical contract behavior only.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["SYNTHETIC no validation success is claimed."],
      remaining_disagreement: ["SYNTHETIC market truth remains unknown."],
      next_decision_relevant_question: "SYNTHETIC should a v13 revision be supplied?",
    },
    inputRefs: [G24_RECOMMENDATION, G24_TRACEABILITY],
  });
  const reopened = await new RunStore(runsRoot, validator).load(runId);
  const runRoot = path.join(runsRoot, runId);
  const operationFiles = (await readdir(path.join(runRoot, ".store/operations"))).sort();
  const operationReceipts = await Promise.all(
    operationFiles
      .filter((filename) => filename.startsWith("artifact-"))
      .map(async (filename) =>
        JSON.parse(await readFile(path.join(runRoot, ".store/operations", filename), "utf8")),
      ),
  );
  const v12Paths = new Set(
    envelopes(bundle, "startup_opportunity.artifact_envelope.v12").map(
      (candidate) => candidate.artifact_path,
    ),
  );
  const v12ReceiptVersions = operationReceipts
    .filter((receipt) => v12Paths.has(String((receipt as Record<string, unknown>).artifact_path)))
    .map((receipt) => String((receipt as Record<string, unknown>).schema_version));
  assert.ok(
    v12ReceiptVersions.length > 0 &&
      v12ReceiptVersions.every(
        (schemaVersion) => schemaVersion === "startup_opportunity.artifact_store_operation.v10",
      ),
  );
  const inventory = await fileInventory(runRoot);
  const result = canonicalJson({
    fixture_hash: sha256Bytes(fixtureBytes),
    fixture_size: fixtureBytes.length,
    validation_codes: validation.referenceErrors.map((error) => error.code),
    recovered_report: recovered.recoveredArtifactPaths.includes(G24_REPORT),
    manifest_schema_bundle_version: reopened.manifest.schema_bundle_version,
    report_current: reopened.manifest.artifact_refs.includes(G24_REPORT),
    v12_receipt_count: v12ReceiptVersions.length,
    v12_receipt_versions: [...new Set(v12ReceiptVersions)].sort(),
    checkpoint_ref: checkpoint.checkpointRef,
    reopened_recovered: reopened.recovered,
    tree_digest: sha256Bytes(canonicalJson(inventory)),
    tree_file_count: inventory.length,
  });
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${result}\n`);
}

await main();

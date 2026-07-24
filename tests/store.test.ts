import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  createArtifactValidator,
  EvidenceStore,
  type FormalArtifactEnvelope,
  RunStore,
  StoreError,
} from "../harness/src/index.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = path.join(repositoryRoot, "tests/fixtures/store");

async function setup(context: TestContext, runId = "store-test") {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  const created = await store.create({
    runId,
    mode: "concept_evidence_assessment",
    createdAt: "2026-07-23T12:00:00Z",
  });
  return { root, runsRoot, runRoot: path.join(runsRoot, runId), store, created };
}

async function eventEnvelope(
  runId: string,
  artifactPath = "events/fixture-event-001.json",
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<FormalArtifactEnvelope> {
  const fixture = JSON.parse(
    await readFile(path.join(fixtureRoot, "formal-event-document.json"), "utf8"),
  ) as Record<string, unknown>;
  const document: Record<string, unknown> = { ...fixture, run_id: runId, ...overrides };
  return {
    schema_version: "startup_opportunity.artifact_envelope.v1",
    artifact_type: "startup_opportunity.event.v1",
    artifact_path: artifactPath,
    run_id: runId,
    created_at: String(document.timestamp),
    producer_role: "harness",
    input_refs: [],
    content_hash: canonicalContentHash(document),
    document,
  };
}

test("create and reopen persist a complete initial Run boundary idempotently", async (context) => {
  const { runsRoot, runRoot, store, created } = await setup(context);
  assert.equal(created.status, "created");
  assert.equal(created.manifest.checkpoint_ref, "checkpoints/checkpoint-initial.json");

  const required = [
    "manifest.json",
    "events.jsonl",
    "decisions.jsonl",
    "evidence/manifest.jsonl",
    "checkpoints/checkpoint-initial.json",
  ];
  for (const relativePath of required) {
    assert.equal((await readFile(path.join(runRoot, relativePath))).length >= 0, true);
  }
  const reopened = await store.load("store-test");
  assert.equal(reopened.recovered, false);
  assert.equal(reopened.lastValidCheckpointRef, "checkpoints/checkpoint-initial.json");
  assert.deepEqual(reopened.manifest, created.manifest);

  const replay = await store.create({
    runId: "store-test",
    mode: "concept_evidence_assessment",
    createdAt: "2026-07-23T13:00:00Z",
  });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.manifest.created_at, "2026-07-23T12:00:00Z");
  assert.equal(runsRoot, path.dirname(runRoot));
});

test("formal publication validates canonical hash, updates manifest, and replays idempotently", async (context) => {
  const { runRoot, store } = await setup(context);
  const envelope = await eventEnvelope("store-test");
  const first = await store.publishArtifact({ runId: "store-test", envelope });
  assert.equal(first.status, "published");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(runRoot, envelope.artifact_path), "utf8")),
    envelope,
  );
  const manifest = JSON.parse(await readFile(path.join(runRoot, "manifest.json"), "utf8")) as {
    artifact_refs: string[];
  };
  assert.deepEqual(manifest.artifact_refs, [envelope.artifact_path]);

  const replay = await store.publishArtifact({ runId: "store-test", envelope });
  assert.equal(replay.status, "idempotent_replay");
});

test("G0.4 Store publishes v2 envelopes through the versioned receipt migration", async (context) => {
  const { runRoot, store } = await setup(context);
  const v1 = await eventEnvelope("store-test");
  const v2 = {
    ...v1,
    schema_version: "startup_opportunity.artifact_envelope.v2",
  } as unknown as FormalArtifactEnvelope;

  const published = await store.publishArtifact({ runId: "store-test", envelope: v2 });
  assert.equal(published.status, "published");
  const manifest = JSON.parse(await readFile(path.join(runRoot, "manifest.json"), "utf8")) as {
    schema_bundle_version: string;
  };
  assert.equal(manifest.schema_bundle_version, "2.2.0");
  const receipt = JSON.parse(
    await readFile(
      path.join(runRoot, `.store/operations/artifact-${published.operationKey.slice(7)}.json`),
      "utf8",
    ),
  ) as { schema_version: string };
  assert.equal(receipt.schema_version, "startup_opportunity.artifact_store_operation.v2");
});

test("Event and Decision JSONL appends validate refs, identity, and idempotent replay", async (context) => {
  const { runRoot, store } = await setup(context);
  const envelope = await eventEnvelope("store-test");
  await store.publishArtifact({ runId: "store-test", envelope });
  const decision = {
    schema_version: "startup_opportunity.decision.v1",
    decision_id: "decision_fixture_001",
    run_id: "store-test",
    decision_type: "initial_belief_recorded",
    timestamp: "2026-07-23T12:06:00Z",
    actor: "main_agent",
    reason: "The fixture records that no initial belief was supplied.",
    artifact_refs: [envelope.artifact_path],
  };
  assert.equal(await store.appendDecision("store-test", decision), "appended");
  assert.equal(await store.appendDecision("store-test", decision), "idempotent_replay");
  assert.equal(
    (await readFile(path.join(runRoot, "decisions.jsonl"), "utf8")).trim().split("\n").length,
    1,
  );
  await assert.rejects(
    store.appendDecision("store-test", { ...decision, reason: "Conflicting decision content." }),
    (error: unknown) => error instanceof StoreError && error.code === "write.conflict",
  );
  await assert.rejects(
    store.appendEvent("store-test", {
      schema_version: "startup_opportunity.event.v1",
      event_id: "missing_ref_event",
      run_id: "store-test",
      event_type: "artifact_validation_failed",
      timestamp: "2026-07-23T12:07:00Z",
      actor: "harness",
      reason: "The referenced fixture does not exist.",
      artifact_refs: ["artifacts/missing.json"],
    }),
    (error: unknown) => error instanceof StoreError && error.code === "reference.missing",
  );
});

test("formal publication rejects hash, reference, operation-key, and occupied-path conflicts", async (context) => {
  const { store } = await setup(context);
  const valid = await eventEnvelope("store-test");
  await assert.rejects(
    store.publishArtifact({
      runId: "store-test",
      envelope: { ...valid, content_hash: `sha256:${"0".repeat(64)}` },
    }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.hash_mismatch",
  );

  const missingRefDocument = { ...valid.document, artifact_refs: ["artifacts/missing.json"] };
  await assert.rejects(
    store.publishArtifact({
      runId: "store-test",
      envelope: {
        ...valid,
        document: missingRefDocument,
        content_hash: canonicalContentHash(missingRefDocument),
      },
    }),
    (error: unknown) => error instanceof StoreError && error.code === "reference.missing",
  );

  const published = await store.publishArtifact({ runId: "store-test", envelope: valid });
  const changed = await eventEnvelope("store-test", valid.artifact_path, {
    event_id: "fixture_event_002",
    reason: "Different content must not replace the formal path.",
  });
  await assert.rejects(
    store.publishArtifact({
      runId: "store-test",
      envelope: changed,
      operationKey: published.operationKey,
    }),
    (error: unknown) => error instanceof StoreError && error.code === "operation.key_mismatch",
  );
  await assert.rejects(
    store.publishArtifact({ runId: "store-test", envelope: changed }),
    (error: unknown) => error instanceof StoreError && error.code === "write.conflict",
  );
});

test("path policy rejects traversal, absolute, mixed-separator, illegal Run ids, and cross-Run data", async (context) => {
  const { runsRoot, store } = await setup(context);
  for (const runId of ["../escape", "/absolute", "other\\run", ""] as const) {
    await assert.rejects(
      store.create({ runId, mode: "opportunity_discovery" }),
      (error: unknown) => error instanceof StoreError && error.code === "path.invalid_run_id",
    );
  }
  const valid = await eventEnvelope("store-test");
  for (const artifactPath of [
    "../outside.json",
    "/tmp/outside.json",
    "artifacts\\outside.json",
  ] as const) {
    await assert.rejects(
      store.publishArtifact({
        runId: "store-test",
        envelope: { ...valid, artifact_path: artifactPath },
      }),
      (error: unknown) => error instanceof StoreError,
    );
  }
  const crossRun = await eventEnvelope("other-run");
  await assert.rejects(
    store.publishArtifact({ runId: "store-test", envelope: crossRun }),
    (error: unknown) => error instanceof StoreError && error.code === "reference.run_mismatch",
  );

  await symlink(path.join(runsRoot, "store-test"), path.join(runsRoot, "linked-run"));
  await assert.rejects(
    store.load("linked-run"),
    (error: unknown) => error instanceof StoreError && error.code === "path.symlink_escape",
  );
});

test("symlink parents cannot redirect formal publication outside the Run", async (context) => {
  const { root, runRoot, store } = await setup(context);
  const outside = path.join(root, "outside");
  await writeFile(outside, "not a directory");
  await symlink(root, path.join(runRoot, "artifacts/escape"));
  const envelope = await eventEnvelope("store-test", "artifacts/escape/event.json");
  await assert.rejects(
    store.publishArtifact({ runId: "store-test", envelope }),
    (error: unknown) => error instanceof StoreError && error.code === "path.symlink_escape",
  );
  await assert.rejects(readFile(path.join(root, "event.json")));
});

test("Evidence Store canonicalizes source identity, stores real bytes, deduplicates, and conflicts", async (context) => {
  const { runsRoot, runRoot } = await setup(context);
  const evidence = new EvidenceStore(runsRoot);
  const raw = await readFile(path.join(fixtureRoot, "evidence-source.txt"));
  const first = await evidence.record({
    runId: "store-test",
    unitId: "buyer_unit_001",
    url: "HTTPS://Example.COM:443/research?q=buyer#section",
    researchGoal: "Check buyer evidence.",
    rawContent: raw,
    recordedAt: "2026-07-23T12:20:00Z",
  });
  assert.equal(first.status, "recorded");
  assert.equal(first.record.canonical_url, "https://example.com/research?q=buyer");
  assert.deepEqual(await readFile(path.join(runRoot, first.record.raw_content_ref)), raw);

  const replay = await evidence.record({
    runId: "store-test",
    unitId: "buyer_unit_001",
    url: "https://example.com/research?q=buyer#different",
    researchGoal: "Check buyer evidence.",
    rawContent: raw,
  });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.record.evidence_id, first.record.evidence_id);
  assert.equal(
    (await readFile(path.join(runRoot, "evidence/manifest.jsonl"), "utf8")).trim().split("\n")
      .length,
    1,
  );

  await assert.rejects(
    evidence.record({
      runId: "store-test",
      unitId: "buyer_unit_001",
      url: "https://example.com/research?q=buyer",
      researchGoal: "Changed goal.",
      rawContent: "different bytes",
      operationKey: first.record.operation_key,
      recordedAt: "2026-07-23T12:20:00Z",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "operation.key_mismatch",
  );
});

test("reopen rejects overlapping manifest unit status sets", async (context) => {
  const { runRoot, store } = await setup(context);
  const manifestPath = path.join(runRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.active_units = ["unit_001"];
  manifest.completed_units = ["unit_001"];
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(
    store.load("store-test"),
    (error: unknown) => error instanceof StoreError && error.code === "manifest.mutually_exclusive",
  );
});

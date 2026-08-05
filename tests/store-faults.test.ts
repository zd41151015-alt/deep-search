import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ArtifactStore,
  canonicalContentHash,
  createArtifactValidator,
  EvidenceStore,
  type FormalArtifactEnvelope,
  RunStore,
  StoreError,
} from "../harness/src/index.js";
import { createConfirmedRun } from "./helpers/current-run.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function setup(context: TestContext, runId: string) {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-fault-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const validator = await createArtifactValidator(repositoryRoot);
  const runStore = new RunStore(runsRoot, validator);
  await createConfirmedRun(runStore, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-23T12:00:00Z",
  });
  return {
    root,
    runsRoot,
    runRoot: path.join(runsRoot, runId),
    runStore,
    artifactStore: new ArtifactStore(runsRoot, validator),
    evidenceStore: new EvidenceStore(runsRoot),
  };
}

function eventEnvelope(runId: string, id: string, timestamp: string): FormalArtifactEnvelope {
  const document = {
    schema_version: "startup_opportunity.event.v1",
    event_id: id,
    run_id: runId,
    event_type: "decision_context_written",
    timestamp,
    actor: "harness",
    reason: "Fault injection fixture artifact.",
    artifact_refs: [],
  };
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: "startup_opportunity.event.v1",
    artifact_path: `events/${id.replaceAll("_", "-")}.json`,
    run_id: runId,
    created_at: timestamp,
    producer_role: "harness",
    input_refs: [],
    content_hash: canonicalContentHash(document),
    document,
  };
}

test("reopen completes a validated artifact left at the temporary-file crash boundary", async (context) => {
  const { artifactStore, runRoot, runStore } = await setup(context, "temp-recovery");
  const envelope = eventEnvelope("temp-recovery", "temp_event_001", "2026-07-23T12:05:00Z");
  await assert.rejects(
    artifactStore.publish({ runId: "temp-recovery", envelope, faultAt: "after_temp_write" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  await assert.rejects(readFile(path.join(runRoot, envelope.artifact_path)));

  const reopened = await runStore.load("temp-recovery");
  assert.deepEqual(reopened.recoveredArtifactPaths, [envelope.artifact_path]);
  assert.ok(reopened.manifest.artifact_refs.includes(envelope.artifact_path));
  assert.equal(
    (JSON.parse(await readFile(path.join(runRoot, envelope.artifact_path), "utf8")) as object) !==
      null,
    true,
  );
});

test("reopen indexes an atomically published artifact after pre-manifest process failure", async (context) => {
  const { runRoot, runStore } = await setup(context, "publish-recovery");
  const envelope = eventEnvelope("publish-recovery", "published_event_001", "2026-07-23T12:06:00Z");
  await assert.rejects(
    runStore.publishArtifact({
      runId: "publish-recovery",
      envelope,
      faultAt: "after_publish",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const before = JSON.parse(await readFile(path.join(runRoot, "manifest.json"), "utf8")) as {
    artifact_refs: string[];
  };
  assert.deepEqual(before.artifact_refs, []);

  const reopened = await runStore.load("publish-recovery");
  assert.ok(reopened.recovered);
  assert.deepEqual(reopened.manifest.artifact_refs, [envelope.artifact_path]);
});

test("reopen truncates a damaged JSONL tail without discarding complete records", async (context) => {
  const { runRoot, runStore } = await setup(context, "jsonl-tail");
  const eventsPath = path.join(runRoot, "events.jsonl");
  const before = await readFile(eventsPath, "utf8");
  await appendFile(eventsPath, '{"schema_version":"startup_opportunity.event.v1"');

  const reopened = await runStore.load("jsonl-tail");
  assert.ok(reopened.recovered);
  assert.ok((reopened.logRepairs[0]?.truncatedBytes ?? 0) > 0);
  assert.equal(await readFile(eventsPath, "utf8"), before);
});

test("complete corrupt JSONL in the middle fails closed", async (context) => {
  const { runRoot, runStore } = await setup(context, "jsonl-middle");
  const eventsPath = path.join(runRoot, "events.jsonl");
  const before = await readFile(eventsPath, "utf8");
  await appendFile(eventsPath, "{not-json}\n");
  await appendFile(eventsPath, before);
  await assert.rejects(
    runStore.load("jsonl-middle"),
    (error: unknown) => error instanceof StoreError && error.code === "log.corrupt_middle",
  );
});

test("reopen rejects a duplicate complete Event id even when bytes are identical", async (context) => {
  const { runRoot, runStore } = await setup(context, "duplicate-event-id");
  const eventsPath = path.join(runRoot, "events.jsonl");
  const firstLine = (await readFile(eventsPath, "utf8")).split("\n").find(Boolean);
  assert.ok(firstLine);
  await appendFile(eventsPath, `${firstLine}\n`);

  await assert.rejects(
    runStore.load("duplicate-event-id"),
    (error: unknown) => error instanceof StoreError && error.code === "log.duplicate_id",
  );
});

test("reopen rejects a duplicate complete Decision id even when bytes are identical", async (context) => {
  const { runRoot, runStore } = await setup(context, "duplicate-decision-id");
  const decision = {
    schema_version: "startup_opportunity.decision.v1",
    decision_id: "decision_duplicate_001",
    run_id: "duplicate-decision-id",
    decision_type: "initial_belief_recorded",
    timestamp: "2026-07-23T12:05:00Z",
    actor: "main_agent",
    reason: "Create a Decision before duplicating its complete JSONL record.",
    artifact_refs: [],
  };
  await runStore.appendDecision("duplicate-decision-id", decision);
  const decisionsPath = path.join(runRoot, "decisions.jsonl");
  const firstLine = (await readFile(decisionsPath, "utf8")).split("\n").find(Boolean);
  assert.ok(firstLine);
  await appendFile(decisionsPath, `${firstLine}\n`);

  await assert.rejects(
    runStore.load("duplicate-decision-id"),
    (error: unknown) => error instanceof StoreError && error.code === "log.duplicate_id",
  );
});

test("Evidence recovery publishes raw temp and replays its manifest receipt", async (context) => {
  const { evidenceStore, runRoot, runStore } = await setup(context, "evidence-recovery");
  await assert.rejects(
    evidenceStore.record({
      runId: "evidence-recovery",
      unitId: "source_unit_001",
      source: { kind: "public_url", canonical_url: "https://example.com/source#fragment" },
      researchGoal: "Preserve source bytes across a crash.",
      rawContent: "recoverable evidence bytes",
      recordedAt: "2026-07-23T12:07:00Z",
      faultAt: "after_intent",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  assert.equal((await readFile(path.join(runRoot, "evidence/manifest.jsonl"), "utf8")).length, 0);

  const reopened = await runStore.load("evidence-recovery");
  assert.equal(reopened.evidenceRecovery.replayedEvidenceIds.length, 1);
  assert.equal(reopened.evidenceRecovery.recoveredRawContentRefs.length, 1);
  const record = JSON.parse(
    (await readFile(path.join(runRoot, "evidence/manifest.jsonl"), "utf8")).trim(),
  ) as { raw_content_ref: string };
  assert.equal(
    await readFile(path.join(runRoot, record.raw_content_ref), "utf8"),
    "recoverable evidence bytes",
  );
});

test("Evidence JSONL tail corruption is truncated and replayed from immutable receipt", async (context) => {
  const { evidenceStore, runRoot, runStore } = await setup(context, "evidence-tail");
  const recorded = await evidenceStore.record({
    runId: "evidence-tail",
    unitId: "source_unit_001",
    source: { kind: "public_url", canonical_url: "https://example.com/source" },
    researchGoal: "Test Evidence JSONL recovery.",
    rawContent: "evidence bytes",
    recordedAt: "2026-07-23T12:08:00Z",
  });
  const manifestPath = path.join(runRoot, "evidence/manifest.jsonl");
  await appendFile(manifestPath, "{partial");

  const reopened = await runStore.load("evidence-tail");
  assert.ok(reopened.evidenceRecovery.truncatedBytes > 0);
  assert.equal((await readFile(manifestPath, "utf8")).trim().split("\n").length, 1);
  assert.equal(
    (JSON.parse((await readFile(manifestPath, "utf8")).trim()) as { evidence_id: string })
      .evidence_id,
    recorded.record.evidence_id,
  );
});

test("Evidence recovery rejects a corrupted operation identity without appending a replacement", async (context) => {
  const { evidenceStore, runRoot, runStore } = await setup(context, "evidence-identity");
  await evidenceStore.record({
    runId: "evidence-identity",
    unitId: "source_unit_001",
    source: { kind: "public_url", canonical_url: "https://example.com/identity" },
    researchGoal: "Validate the Evidence mechanical identity contract.",
    rawContent: "identity bytes",
    recordedAt: "2026-07-23T12:09:00Z",
  });
  const manifestPath = path.join(runRoot, "evidence/manifest.jsonl");
  const record = JSON.parse((await readFile(manifestPath, "utf8")).trim()) as Record<
    string,
    unknown
  >;
  record.operation_key = "not-a-sha256-operation-key";
  await writeFile(manifestPath, `${JSON.stringify(record)}\n`);

  await assert.rejects(
    runStore.load("evidence-identity"),
    (error: unknown) => error instanceof StoreError && error.code === "evidence.invalid_record",
  );
  assert.equal((await readFile(manifestPath, "utf8")).trim().split("\n").length, 1);
});

test("Evidence recovery rejects duplicate complete stable identities", async (context) => {
  const { evidenceStore, runRoot, runStore } = await setup(context, "evidence-duplicate");
  await evidenceStore.record({
    runId: "evidence-duplicate",
    unitId: "source_unit_001",
    source: { kind: "public_url", canonical_url: "https://example.com/duplicate" },
    researchGoal: "Validate Evidence identity uniqueness.",
    rawContent: "duplicate identity bytes",
    recordedAt: "2026-07-23T12:10:00Z",
  });
  const manifestPath = path.join(runRoot, "evidence/manifest.jsonl");
  const firstLine = (await readFile(manifestPath, "utf8")).trim();
  await appendFile(manifestPath, `${firstLine}\n`);

  await assert.rejects(
    runStore.load("evidence-duplicate"),
    (error: unknown) => error instanceof StoreError && error.code === "evidence.duplicate_identity",
  );
});

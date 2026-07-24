import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  canonicalJson,
  createArtifactValidator,
  type FormalArtifactEnvelope,
  RunStore,
  StoreError,
} from "../harness/src/index.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = path.join(repositoryRoot, "tests/fixtures/store");

async function setup(context: TestContext, runId: string) {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await store.create({
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-23T12:00:00Z",
  });
  return { runsRoot, runRoot: path.join(runsRoot, runId), store };
}

async function checkpointInput(runId: string, checkpointId: string, createdAt: string) {
  const fixture = JSON.parse(
    await readFile(path.join(fixtureRoot, "checkpoint-input.json"), "utf8"),
  ) as Record<string, unknown>;
  return {
    runId,
    checkpointId,
    createdAt,
    nextStep: String(fixture.next_step),
    beliefSummary: fixture.belief_summary as {
      current_belief: string;
      evidence_that_changed_belief: string[];
      unchanged_assumptions: string[];
      remaining_disagreement: string[];
      next_decision_relevant_question: string;
    },
    unresolvedGapRefs: [],
    inputRefs: [],
  };
}

test("checkpoint publish without manifest update recovers to the newest valid snapshot", async (context) => {
  const { runRoot, store } = await setup(context, "checkpoint-publish-crash");
  const input = await checkpointInput(
    "checkpoint-publish-crash",
    "checkpoint_second",
    "2026-07-23T12:10:00Z",
  );
  await assert.rejects(
    store.checkpoint({ ...input, faultAt: "after_checkpoint_publish" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const before = JSON.parse(await readFile(path.join(runRoot, "manifest.json"), "utf8")) as {
    checkpoint_ref: string;
  };
  assert.equal(before.checkpoint_ref, "checkpoints/checkpoint-initial.json");

  const reopened = await store.load("checkpoint-publish-crash");
  assert.equal(reopened.lastValidCheckpointRef, "checkpoints/checkpoint-second.json");
  assert.equal(reopened.manifest.checkpoint_ref, "checkpoints/checkpoint-second.json");
  assert.ok(reopened.recovered);
});

test("a successful checkpoint remains current on immediate reopen", async (context) => {
  const { store } = await setup(context, "checkpoint-success-reopen");
  const input = await checkpointInput(
    "checkpoint-success-reopen",
    "checkpoint_second",
    "2026-07-23T12:10:00Z",
  );
  const checkpoint = await store.checkpoint(input);
  assert.equal(checkpoint.status, "published");

  const reopened = await store.load("checkpoint-success-reopen");
  assert.equal(reopened.recovered, false);
  assert.equal(reopened.lastValidCheckpointRef, "checkpoints/checkpoint-second.json");
  assert.equal(reopened.manifest.checkpoint_ref, "checkpoints/checkpoint-second.json");
});

test("checkpoint publication rejects stale and equal durable timestamps", async (context) => {
  const { runRoot, store } = await setup(context, "checkpoint-time-order");
  for (const [checkpointId, createdAt] of [
    ["checkpoint_stale", "2026-07-23T11:00:00Z"],
    ["checkpoint_equal", "2026-07-23T12:00:00Z"],
  ] as const) {
    await assert.rejects(
      store.checkpoint(await checkpointInput("checkpoint-time-order", checkpointId, createdAt)),
      (error: unknown) =>
        error instanceof StoreError && error.code === "checkpoint.non_monotonic_time",
    );
    await assert.rejects(
      readFile(path.join(runRoot, `checkpoints/${checkpointId.replaceAll("_", "-")}.json`)),
    );
  }
  const manifest = JSON.parse(await readFile(path.join(runRoot, "manifest.json"), "utf8")) as {
    checkpoint_ref: string;
  };
  assert.equal(manifest.checkpoint_ref, "checkpoints/checkpoint-initial.json");
});

test("an equal checkpoint retry after publish crash is rejected against recovered durable order", async (context) => {
  const { runRoot, store } = await setup(context, "checkpoint-crash-equal-retry");
  const published = await checkpointInput(
    "checkpoint-crash-equal-retry",
    "checkpoint_second",
    "2026-07-23T12:10:00Z",
  );
  await assert.rejects(
    store.checkpoint({ ...published, faultAt: "after_checkpoint_publish" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );

  await assert.rejects(
    store.checkpoint(
      await checkpointInput(
        "checkpoint-crash-equal-retry",
        "checkpoint_equal_retry",
        published.createdAt,
      ),
    ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "checkpoint.non_monotonic_time",
  );
  const manifest = JSON.parse(await readFile(path.join(runRoot, "manifest.json"), "utf8")) as {
    checkpoint_ref: string;
  };
  assert.equal(manifest.checkpoint_ref, "checkpoints/checkpoint-initial.json");
  await assert.rejects(readFile(path.join(runRoot, "checkpoints/checkpoint-equal-retry.json")));
  const reopened = await store.load("checkpoint-crash-equal-retry");
  assert.equal(reopened.manifest.checkpoint_ref, "checkpoints/checkpoint-second.json");
});

test("manifest update without checkpoint event is reconciled idempotently", async (context) => {
  const { runRoot, store } = await setup(context, "checkpoint-event-crash");
  const input = await checkpointInput(
    "checkpoint-event-crash",
    "checkpoint_second",
    "2026-07-23T12:11:00Z",
  );
  await assert.rejects(
    store.checkpoint({ ...input, faultAt: "after_manifest_update" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await store.load("checkpoint-event-crash");
  assert.ok(reopened.recovered);
  const events = (await readFile(path.join(runRoot, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event_type: string; artifact_refs: string[] });
  assert.equal(
    events.filter(
      (event) =>
        event.event_type === "checkpoint_written" &&
        event.artifact_refs.includes("checkpoints/checkpoint-second.json"),
    ).length,
    1,
  );
  assert.equal((await store.load("checkpoint-event-crash")).recovered, false);
});

test("a hash-invalid newest checkpoint is ignored in favor of the last valid checkpoint", async (context) => {
  const { runRoot, store } = await setup(context, "checkpoint-invalid");
  const input = await checkpointInput(
    "checkpoint-invalid",
    "checkpoint_second",
    "2026-07-23T12:12:00Z",
  );
  await store.checkpoint(input);
  const checkpointPath = path.join(runRoot, "checkpoints/checkpoint-second.json");
  const envelope = JSON.parse(await readFile(checkpointPath, "utf8")) as FormalArtifactEnvelope;
  envelope.document.next_step = "Tampered after publication.";
  await writeFile(checkpointPath, `${canonicalJson(envelope)}\n`);

  const reopened = await store.load("checkpoint-invalid");
  assert.equal(reopened.lastValidCheckpointRef, "checkpoints/checkpoint-initial.json");
  assert.deepEqual(reopened.ignoredInvalidCheckpointPaths, ["checkpoints/checkpoint-second.json"]);
  assert.equal(reopened.manifest.checkpoint_ref, "checkpoints/checkpoint-initial.json");
});

test("current plan reference and revision are verified through checkpoint and reopen", async (context) => {
  const { runRoot, store } = await setup(context, "plan-lineage");
  const plan = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "tests/fixtures/schemas/positive/research-plan.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  plan.run_id = "plan-lineage";
  plan.plan_id = "plan_plan-lineage";
  plan.created_at = "2026-07-23T12:03:00Z";
  for (const wave of plan.waves as { units: { input_refs: string[] }[] }[]) {
    for (const unit of wave.units) {
      unit.input_refs = [];
    }
  }
  const envelope: FormalArtifactEnvelope = {
    schema_version: "startup_opportunity.artifact_envelope.v1",
    artifact_type: "startup_opportunity.research_plan.v1",
    artifact_path: "plans/research-plan.r1.json",
    run_id: "plan-lineage",
    created_at: "2026-07-23T12:03:00Z",
    producer_role: "main_agent",
    input_refs: [],
    content_hash: canonicalContentHash(plan),
    document: plan,
  };
  await store.publishArtifact({ runId: "plan-lineage", envelope });

  const manifestPath = path.join(runRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.status = "planned";
  manifest.current_phase = "planning";
  manifest.current_plan_ref = "plans/research-plan.r1.json";
  manifest.plan_revision = 1;
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
  await store.checkpoint(
    await checkpointInput("plan-lineage", "checkpoint_planned", "2026-07-23T12:13:00Z"),
  );
  const reopened = await store.load("plan-lineage");
  assert.equal(reopened.manifest.current_plan_ref, "plans/research-plan.r1.json");
  assert.equal(reopened.manifest.plan_revision, 1);
});

test("publication rejects a plan revision with broken parent lineage", async (context) => {
  const { store } = await setup(context, "plan-bad-lineage");
  const base = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "tests/fixtures/schemas/positive/research-plan.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  base.run_id = "plan-bad-lineage";
  base.plan_id = "plan_good";
  for (const wave of base.waves as { units: { input_refs: string[] }[] }[]) {
    for (const unit of wave.units) {
      unit.input_refs = [];
    }
  }
  const first: FormalArtifactEnvelope = {
    schema_version: "startup_opportunity.artifact_envelope.v1",
    artifact_type: "startup_opportunity.research_plan.v1",
    artifact_path: "plans/research-plan.r1.json",
    run_id: "plan-bad-lineage",
    created_at: String(base.created_at),
    producer_role: "main_agent",
    input_refs: [],
    content_hash: canonicalContentHash(base),
    document: base,
  };
  await store.publishArtifact({ runId: "plan-bad-lineage", envelope: first });

  const secondDocument = {
    ...base,
    plan_id: "plan_different",
    revision: 2,
    parent_plan_ref: "plans/research-plan.r1.json",
    triggered_by_adaptation_refs: ["adaptations/decisions/adapt-001.json"],
  };
  const second: FormalArtifactEnvelope = {
    ...first,
    artifact_path: "plans/research-plan.r2.json",
    content_hash: canonicalContentHash(secondDocument),
    document: secondDocument,
  };
  await assert.rejects(
    store.publishArtifact({ runId: "plan-bad-lineage", envelope: second }),
    (error: unknown) =>
      error instanceof StoreError &&
      (error.code === "reference.missing" || error.code === "artifact.reference_invalid"),
  );
});

test("Artifact recovery rejects receipt filename and envelope metadata drift", async (context) => {
  const { runRoot, store } = await setup(context, "artifact-receipt-drift");
  const document = {
    schema_version: "startup_opportunity.event.v1",
    event_id: "artifact_receipt_event",
    run_id: "artifact-receipt-drift",
    event_type: "decision_context_written",
    timestamp: "2026-07-23T12:05:00Z",
    actor: "harness",
    reason: "Publish a formal artifact before corrupting its receipt.",
    artifact_refs: [],
  };
  const envelope: FormalArtifactEnvelope = {
    schema_version: "startup_opportunity.artifact_envelope.v1",
    artifact_type: "startup_opportunity.event.v1",
    artifact_path: "events/artifact-receipt-event.json",
    run_id: "artifact-receipt-drift",
    created_at: "2026-07-23T12:05:00Z",
    producer_role: "harness",
    input_refs: [],
    content_hash: canonicalContentHash(document),
    document,
  };
  await store.publishArtifact({ runId: "artifact-receipt-drift", envelope });
  const operations = path.join(runRoot, ".store/operations");
  const receiptName = (await readdir(operations)).find((entry) => entry.startsWith("artifact-"));
  assert.ok(receiptName);
  const receiptPath = path.join(operations, receiptName);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  receipt.artifact_path = "events/drifted.json";
  await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);

  await assert.rejects(
    store.load("artifact-receipt-drift"),
    (error: unknown) => error instanceof StoreError && error.code === "recovery.invalid_operation",
  );
});

test("Evidence recovery rejects a receipt stored under the wrong operation-key filename", async (context) => {
  const { runRoot, runsRoot, store } = await setup(context, "evidence-receipt-drift");
  const { EvidenceStore } = await import("../harness/src/index.js");
  await new EvidenceStore(runsRoot).record({
    runId: "evidence-receipt-drift",
    unitId: "unit_001",
    url: "https://example.com/receipt",
    researchGoal: "Exercise receipt filename integrity.",
    rawContent: "receipt bytes",
    recordedAt: "2026-07-23T12:05:00Z",
  });
  const operations = path.join(runRoot, ".store/operations");
  const receiptName = (await readdir(operations)).find((entry) => entry.startsWith("evidence-"));
  assert.ok(receiptName);
  await rename(
    path.join(operations, receiptName),
    path.join(operations, `evidence-${"0".repeat(64)}.json`),
  );

  await assert.rejects(
    store.load("evidence-receipt-drift"),
    (error: unknown) => error instanceof StoreError && error.code === "recovery.invalid_operation",
  );
});

test("JSONL recovery rejects receipt record-id drift", async (context) => {
  const { runRoot, store } = await setup(context, "log-receipt-drift");
  const operations = path.join(runRoot, ".store/operations");
  const logReceipts = (await readdir(operations)).filter((entry) => entry.startsWith("log-"));
  let mutated = false;
  for (const receiptName of logReceipts) {
    const receiptPath = path.join(operations, receiptName);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
      record_id: string;
      record: { event_type?: string };
    };
    if (receipt.record.event_type === "run_created") {
      receipt.record_id = "drifted_record_id";
      await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
      mutated = true;
      break;
    }
  }
  assert.equal(mutated, true);

  await assert.rejects(
    store.load("log-receipt-drift"),
    (error: unknown) => error instanceof StoreError && error.code === "recovery.invalid_operation",
  );
});

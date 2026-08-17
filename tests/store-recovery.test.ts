import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import {
  createDiscoveryMapsFixture,
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_PLAN_REF,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import { createConfirmedRun, publishInitialPlanBundle } from "./helpers/current-run.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = path.join(repositoryRoot, "tests/fixtures/store");

async function setup(context: TestContext, runId: string) {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "synthetic-primary-market",
      customerModel: "b2c",
      targetUsers: ["SYNTHETIC primary user; not Evidence or external validation."],
      decisionGoal:
        "SYNTHETIC identify directions that merit further validation; not Evidence or external validation.",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-23T12:00:00Z",
  });
  return { runsRoot, runRoot: path.join(runsRoot, runId), store };
}

async function publishRecoveryPlan(
  store: RunStore,
  runId: string,
): Promise<FormalArtifactEnvelope> {
  const bundle = await createDiscoveryMapsFixture("general", runId);
  const envelopes = G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref));
  await publishInitialPlanBundle(store, runId, envelopes);
  return fixtureEnvelope(bundle, G21_PLAN_REF);
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

function recoveryEventEnvelope(
  runId: string,
  suffix: string,
  createdAt: string,
): FormalArtifactEnvelope {
  const document = {
    schema_version: "startup_opportunity.event.v1",
    event_id: `publication_${suffix}`,
    run_id: runId,
    event_type: "decision_context_written",
    timestamp: createdAt,
    actor: "harness",
    reason: `SYNTHETIC publication order fixture ${suffix}.`,
    artifact_refs: [],
  };
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: "startup_opportunity.event.v1",
    artifact_path: `events/publication-${suffix}.json`,
    run_id: runId,
    created_at: createdAt,
    producer_role: "harness",
    input_refs: [],
    content_hash: canonicalContentHash(document),
    document,
  };
}

interface StoredPublicationCommit extends Record<string, unknown> {
  schema_version: string;
  run_id: string;
  publication_ordinal: number;
  previous_commit_hash: string | null;
  operation_key: string;
  artifact_path: string;
  artifact_type: string;
  content_hash: string;
  publication_commit_hash: string;
}

function refreshPublicationCommit(commit: StoredPublicationCommit): void {
  const { publication_commit_hash: _discarded, ...identity } = commit;
  commit.publication_commit_hash = canonicalContentHash(identity);
}

function publicationCommitFilename(commit: StoredPublicationCommit): string {
  return `publication-${String(commit.publication_ordinal).padStart(12, "0")}-${commit.publication_commit_hash.slice("sha256:".length)}.json`;
}

async function readPublicationCommits(runRoot: string): Promise<StoredPublicationCommit[]> {
  const directory = path.join(runRoot, ".store/publications");
  return Promise.all(
    (await readdir(directory))
      .sort()
      .map(async (entry) => JSON.parse(await readFile(path.join(directory, entry), "utf8"))),
  );
}

async function replacePublicationCommits(
  runRoot: string,
  commits: readonly StoredPublicationCommit[],
): Promise<void> {
  const directory = path.join(runRoot, ".store/publications");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  for (const commit of commits) {
    await writeFile(
      path.join(directory, publicationCommitFilename(commit)),
      `${canonicalJson(commit)}\n`,
    );
  }
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

test("an exact checkpoint replays after later durable state without rollback or drift", async (context) => {
  const { runRoot, store } = await setup(context, "checkpoint-late-exact-replay");
  const second = await checkpointInput(
    "checkpoint-late-exact-replay",
    "checkpoint_second",
    "2026-07-23T12:10:00Z",
  );
  await store.checkpoint(second);
  await store.checkpoint(
    await checkpointInput(
      "checkpoint-late-exact-replay",
      "checkpoint_third",
      "2026-07-23T12:20:00Z",
    ),
  );
  const before = await readFile(path.join(runRoot, "manifest.json"), "utf8");

  const replay = await store.checkpoint(second);
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(await readFile(path.join(runRoot, "manifest.json"), "utf8"), before);
  await assert.rejects(
    store.checkpoint({ ...second, nextStep: "Conflicting replay content." }),
    (error: unknown) => error instanceof StoreError && error.code === "write.conflict",
  );
  assert.equal(await readFile(path.join(runRoot, "manifest.json"), "utf8"), before);
});

test("an exact checkpoint retry recovers a publish-before-manifest fault", async (context) => {
  const { store } = await setup(context, "checkpoint-exact-fault-retry");
  const input = await checkpointInput(
    "checkpoint-exact-fault-retry",
    "checkpoint_second",
    "2026-07-23T12:10:00Z",
  );
  await assert.rejects(
    store.checkpoint({ ...input, faultAt: "after_checkpoint_publish" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );

  const replay = await store.checkpoint(input);
  assert.equal(replay.status, "idempotent_replay");
  const reopened = await store.load("checkpoint-exact-fault-retry");
  assert.equal(reopened.recovered, false);
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
  await publishRecoveryPlan(store, "plan-lineage");

  const manifestPath = path.join(runRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.status = "planned";
  manifest.current_phase = "planning";
  manifest.current_plan_ref = "plans/research-plan.r1.json";
  manifest.plan_revision = 1;
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
  await store.checkpoint(
    await checkpointInput("plan-lineage", "checkpoint_planned", "2026-07-26T17:13:00Z"),
  );
  const reopened = await store.load("plan-lineage");
  assert.equal(reopened.manifest.current_plan_ref, "plans/research-plan.r1.json");
  assert.equal(reopened.manifest.plan_revision, 1);
});

test("generic publication rejects new planning authority before broken parent lineage", async (context) => {
  const { store } = await setup(context, "plan-bad-lineage");
  const first = await publishRecoveryPlan(store, "plan-bad-lineage");

  const secondDocument = {
    ...first.document,
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
      error instanceof StoreError && error.code === "artifact.planning_authority_entry_required",
  );
});

test("publication commit chain rejects ordinal and operation identity tampering", async (t) => {
  const scenarios = [
    {
      name: "swapped-ordinals",
      mutate: (first: StoredPublicationCommit, second: StoredPublicationCommit) => {
        [first.publication_ordinal, second.publication_ordinal] = [
          second.publication_ordinal,
          first.publication_ordinal,
        ];
        refreshPublicationCommit(first);
        refreshPublicationCommit(second);
      },
    },
    {
      name: "single-ordinal",
      mutate: (_first: StoredPublicationCommit, second: StoredPublicationCommit) => {
        second.publication_ordinal += 7;
        refreshPublicationCommit(second);
      },
    },
    {
      name: "broken-previous-hash",
      mutate: (_first: StoredPublicationCommit, second: StoredPublicationCommit) => {
        second.previous_commit_hash = `sha256:${"0".repeat(64)}`;
        refreshPublicationCommit(second);
      },
    },
    {
      name: "duplicate-ordinal",
      mutate: (first: StoredPublicationCommit, second: StoredPublicationCommit) => {
        second.publication_ordinal = first.publication_ordinal;
        refreshPublicationCommit(second);
      },
    },
    {
      name: "skipped-ordinal",
      mutate: (_first: StoredPublicationCommit, second: StoredPublicationCommit) => {
        second.publication_ordinal += 1;
        refreshPublicationCommit(second);
      },
    },
    {
      name: "receipt-commit-identity-drift",
      mutate: (_first: StoredPublicationCommit, second: StoredPublicationCommit) => {
        second.artifact_path = "events/publication-drifted.json";
        refreshPublicationCommit(second);
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (context) => {
      const runId = `publication-chain-${scenario.name}`;
      const { runRoot, store } = await setup(context, runId);
      const firstEnvelope = recoveryEventEnvelope(runId, "first", "2026-07-23T12:05:00Z");
      const secondEnvelope = recoveryEventEnvelope(runId, "second", "2026-07-23T12:06:00Z");
      await store.publishArtifact({ runId, envelope: firstEnvelope });
      await store.publishArtifact({ runId, envelope: secondEnvelope });
      const commits = await readPublicationCommits(runRoot);
      const first = commits.find((commit) => commit.artifact_path === firstEnvelope.artifact_path);
      const second = commits.find(
        (commit) => commit.artifact_path === secondEnvelope.artifact_path,
      );
      assert.ok(first);
      assert.ok(second);
      scenario.mutate(first, second);
      await replacePublicationCommits(runRoot, commits);

      await assert.rejects(
        store.load(runId),
        (error: unknown) =>
          error instanceof StoreError &&
          ["recovery.invalid_publication_commit", "recovery.publication_chain_invalid"].includes(
            error.code,
          ),
      );
    });
  }
});

test("formal publication order is committed only after the Artifact target exists", async (t) => {
  await t.test("after_intent first then second then first retry", async (context) => {
    const runId = "publication-order-after-intent";
    const { runRoot, store } = await setup(context, runId);
    const first = recoveryEventEnvelope(runId, "first", "2026-07-23T12:05:00Z");
    const second = recoveryEventEnvelope(runId, "second", "2026-07-23T12:06:00Z");
    await assert.rejects(
      store.publishArtifact({ runId, envelope: first, faultAt: "after_intent" }),
      (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
    );
    await store.publishArtifact({ runId, envelope: second });
    await store.publishArtifact({ runId, envelope: first });
    const commits = await readPublicationCommits(runRoot);
    const firstOrdinal = commits.find(
      (commit) => commit.artifact_path === first.artifact_path,
    )?.publication_ordinal;
    const secondOrdinal = commits.find(
      (commit) => commit.artifact_path === second.artifact_path,
    )?.publication_ordinal;
    assert.ok(firstOrdinal);
    assert.ok(secondOrdinal);
    assert.ok(secondOrdinal < firstOrdinal);
    await store.checkpoint(
      await checkpointInput(runId, "checkpoint_publication_order", "2026-07-23T12:30:00Z"),
    );
    assert.equal((await store.load(runId)).recovered, false);
  });

  await t.test("after_temp_write is published and committed during recovery", async (context) => {
    const runId = "publication-order-after-temp";
    const { runRoot, store } = await setup(context, runId);
    const first = recoveryEventEnvelope(runId, "first", "2026-07-23T12:05:00Z");
    const second = recoveryEventEnvelope(runId, "second", "2026-07-23T12:06:00Z");
    await assert.rejects(
      store.publishArtifact({ runId, envelope: first, faultAt: "after_temp_write" }),
      (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
    );
    const recovered = await store.load(runId);
    assert.deepEqual(recovered.recoveredArtifactPaths, [first.artifact_path]);
    await store.publishArtifact({ runId, envelope: second });
    const commits = await readPublicationCommits(runRoot);
    const firstOrdinal = commits.find(
      (commit) => commit.artifact_path === first.artifact_path,
    )?.publication_ordinal;
    const secondOrdinal = commits.find(
      (commit) => commit.artifact_path === second.artifact_path,
    )?.publication_ordinal;
    assert.ok(firstOrdinal);
    assert.ok(secondOrdinal);
    assert.ok(firstOrdinal < secondOrdinal);
    await store.checkpoint(
      await checkpointInput(runId, "checkpoint_publication_order", "2026-07-23T12:30:00Z"),
    );
    assert.equal((await store.load(runId)).recovered, false);
  });

  await t.test(
    "recovery commits an existing target before publishing an older temp intent",
    async (context) => {
      const runId = "publication-order-mixed-faults";
      const { runRoot, store } = await setup(context, runId);
      const tempOnly = recoveryEventEnvelope(runId, "temp-only", "2026-07-23T12:05:00Z");
      const published = recoveryEventEnvelope(runId, "published", "2026-07-23T12:06:00Z");
      await assert.rejects(
        store.publishArtifact({ runId, envelope: tempOnly, faultAt: "after_temp_write" }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      await assert.rejects(
        store.publishArtifact({ runId, envelope: published, faultAt: "after_publish" }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );

      const recovered = await store.load(runId);
      assert.ok(recovered.manifest.artifact_refs.includes(tempOnly.artifact_path));
      assert.ok(recovered.manifest.artifact_refs.includes(published.artifact_path));
      const commits = await readPublicationCommits(runRoot);
      const tempOrdinal = commits.find(
        (commit) => commit.artifact_path === tempOnly.artifact_path,
      )?.publication_ordinal;
      const publishedOrdinal = commits.find(
        (commit) => commit.artifact_path === published.artifact_path,
      )?.publication_ordinal;
      assert.ok(tempOrdinal);
      assert.ok(publishedOrdinal);
      assert.ok(publishedOrdinal < tempOrdinal);
      await store.checkpoint(
        await checkpointInput(runId, "checkpoint_publication_order", "2026-07-23T12:30:00Z"),
      );
      assert.equal((await store.load(runId)).recovered, false);
    },
  );

  await t.test(
    "after_publish blocks later order until reopen commits the target",
    async (context) => {
      const runId = "publication-order-after-publish";
      const { runRoot, store } = await setup(context, runId);
      const first = recoveryEventEnvelope(runId, "first", "2026-07-23T12:05:00Z");
      const second = recoveryEventEnvelope(runId, "second", "2026-07-23T12:06:00Z");
      await assert.rejects(
        store.publishArtifact({ runId, envelope: first, faultAt: "after_publish" }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      await assert.rejects(
        store.publishArtifact({ runId, envelope: second }),
        (error: unknown) =>
          error instanceof StoreError && error.code === "recovery.publication_commit_required",
      );
      await store.load(runId);
      await store.publishArtifact({ runId, envelope: second });
      const commits = await readPublicationCommits(runRoot);
      const firstOrdinal = commits.find(
        (commit) => commit.artifact_path === first.artifact_path,
      )?.publication_ordinal;
      const secondOrdinal = commits.find(
        (commit) => commit.artifact_path === second.artifact_path,
      )?.publication_ordinal;
      assert.ok(firstOrdinal);
      assert.ok(secondOrdinal);
      assert.ok(firstOrdinal < secondOrdinal);
      await store.checkpoint(
        await checkpointInput(runId, "checkpoint_publication_order", "2026-07-23T12:30:00Z"),
      );
      assert.equal((await store.load(runId)).recovered, false);
    },
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
    schema_version: "startup_opportunity.artifact_envelope.current",
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

test("whole-bundle recovery rejects a drifted immutable intent", async (context) => {
  const runId = "artifact-bundle-receipt-drift";
  const { runRoot, store } = await setup(context, runId);
  const envelopes = ["first", "second"].map((suffix): FormalArtifactEnvelope => {
    const document = {
      schema_version: "startup_opportunity.event.v1",
      event_id: `artifact_bundle_${suffix}`,
      run_id: runId,
      event_type: "decision_context_written",
      timestamp: "2026-07-23T12:05:00Z",
      actor: "harness",
      reason: `Publish the ${suffix} bundle member before corrupting the bundle intent.`,
      artifact_refs: [],
    };
    return {
      schema_version: "startup_opportunity.artifact_envelope.current",
      artifact_type: "startup_opportunity.event.v1",
      artifact_path: `events/artifact-bundle-${suffix}.json`,
      run_id: runId,
      created_at: "2026-07-23T12:05:00Z",
      producer_role: "harness",
      input_refs: [],
      content_hash: canonicalContentHash(document),
      document,
    };
  });
  await store.publishArtifactBundle({ runId, envelopes });
  const operations = path.join(runRoot, ".store/operations");
  const receiptName = (await readdir(operations)).find((entry) => entry.startsWith("bundle-"));
  assert.ok(receiptName);
  const receiptPath = path.join(operations, receiptName);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  receipt.run_id = "artifact-bundle-receipt-drifted";
  await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);

  await assert.rejects(
    store.load(runId),
    (error: unknown) =>
      error instanceof StoreError && error.code === "recovery.invalid_bundle_operation",
  );
});

test("Evidence recovery rejects a receipt stored under the wrong operation-key filename", async (context) => {
  const { runRoot, runsRoot, store } = await setup(context, "evidence-receipt-drift");
  const { EvidenceStore } = await import("../harness/src/index.js");
  await new EvidenceStore(runsRoot).record({
    runId: "evidence-receipt-drift",
    unitId: "unit_001",
    source: { kind: "public_url", canonical_url: "https://example.com/receipt" },
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

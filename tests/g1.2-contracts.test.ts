import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  createArtifactValidator,
  EvidenceStore,
  type EvidenceStoreRecordV2,
  type FormalArtifactEnvelope,
  inspectSchemaBundle,
  RunStore,
  StoreError,
} from "../harness/src/index.js";
import {
  branchResearchEnvelopes,
  G12_BASE_TIME,
  G12_BRANCHES,
  G12_RUN_ID,
  initialFixtureEnvelopes,
  taskEnvelope,
} from "./fixtures/g1.2/research-branch-fixture.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const baseFixturePath = path.join(
  repositoryRoot,
  "tests/fixtures/g1.1/valid-assess-contract-bundle.json",
);

async function baseFixture() {
  return JSON.parse(await readFile(baseFixturePath, "utf8")) as {
    readonly documents: readonly {
      readonly path: string;
      readonly document: Record<string, unknown>;
    }[];
  };
}

async function setup(context: TestContext, runId = G12_RUN_ID) {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g1-2-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await store.create({
    runId,
    mode: "concept_evidence_assessment",
    createdAt: G12_BASE_TIME,
  });
  return { runsRoot, runRoot: path.join(runsRoot, runId), validator, store };
}

async function publishVerticalFixture(context: TestContext) {
  const state = await setup(context);
  const base = await baseFixture();
  const initial = initialFixtureEnvelopes(base);
  const initialResult = await state.store.publishArtifactBundle({
    runId: G12_RUN_ID,
    envelopes: initial,
  });
  assert.equal(initialResult.status, "published");

  const tasks = G12_BRANCHES.map((branch, index) => taskEnvelope(base, branch, index + 2));
  await state.store.publishArtifactBundle({ runId: G12_RUN_ID, envelopes: tasks });

  const evidenceStore = new EvidenceStore(state.runsRoot);
  const records = new Map<string, readonly [EvidenceStoreRecordV2, EvidenceStoreRecordV2]>();
  for (const [index, branch] of G12_BRANCHES.entries()) {
    const researchGoal = String(tasks[index]?.document.research_goal ?? "");
    const publicRecord = await evidenceStore.record({
      runId: G12_RUN_ID,
      unitId: branch.unitId,
      researchGoal,
      source: {
        kind: "public_url",
        canonical_url: `https://synthetic.invalid/${branch.unitId}?fixture=1#ignored`,
      },
      rawContent: `SYNTHETIC CONTRACT FIXTURE ${branch.unitId} support; not market Evidence.`,
      recordedAt: `2026-07-24T20:${String(20 + index).padStart(2, "0")}:00Z`,
    });
    const userRecord = await evidenceStore.record({
      runId: G12_RUN_ID,
      unitId: branch.unitId,
      researchGoal,
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:${branch.unitId}:oppose`,
      },
      rawContent: `SYNTHETIC CONTRACT FIXTURE ${branch.unitId} oppose; not market Evidence.`,
      recordedAt: `2026-07-24T20:${String(24 + index).padStart(2, "0")}:00Z`,
    });
    records.set(branch.unitId, [publicRecord.record, userRecord.record]);
  }

  const branchBundles: FormalArtifactEnvelope[][] = [];
  for (const [index, branch] of G12_BRANCHES.entries()) {
    const pair = records.get(branch.unitId);
    assert.ok(pair);
    const envelopes = [...branchResearchEnvelopes(branch, pair, index)];
    branchBundles.push(envelopes);
    await state.store.publishArtifactBundle({ runId: G12_RUN_ID, envelopes });
  }

  await state.store.checkpoint({
    runId: G12_RUN_ID,
    checkpointId: "checkpoint_g1_2_vertical",
    createdAt: "2026-07-24T21:00:00Z",
    nextStep: "Independent G1.2 regression; G1.3 remains NOT_READY.",
    beliefSummary: {
      current_belief: "Only the G1.2 mechanical contract has been exercised.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["No market Evidence was collected."],
      remaining_disagreement: ["The concept thesis remains unassessed by real Evidence."],
      next_decision_relevant_question: "Does independent regression accept G1.2 mechanics?",
    },
    inputRefs: G12_BRANCHES.map((branch) => branch.outputPath),
  });
  return { ...state, initial, tasks, records, branchBundles };
}

test("G1.2 bundle publishes versioned Evidence Store and research branch schemas", async () => {
  const result = await inspectSchemaBundle(repositoryRoot);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.schemaBundleVersion, "4.0.0");
  assert.equal(result.schemaCount, 47);
  assert.equal(result.documentSchemaCount, 44);
});

test("four synthetic branches publish Evidence -> Claim -> Finding -> Insight and reopen", async (context) => {
  const state = await publishVerticalFixture(context);
  const manifestBefore = JSON.parse(
    await readFile(path.join(state.runRoot, "manifest.json"), "utf8"),
  ) as {
    schema_bundle_version: string;
    active_units: string[];
    completed_units: string[];
    checkpoint_ref: string;
  };
  assert.equal(manifestBefore.schema_bundle_version, "4.0.0");
  assert.deepEqual(manifestBefore.active_units, []);
  assert.deepEqual(
    manifestBefore.completed_units,
    G12_BRANCHES.map((branch) => branch.unitId).sort(),
  );
  assert.equal(manifestBefore.checkpoint_ref, "checkpoints/checkpoint-g1-2-vertical.json");

  for (const pair of state.records.values()) {
    for (const record of pair) {
      assert.equal(record.schema_version, "startup_opportunity.evidence_store_record.v2");
      assert.equal(
        await readFile(path.join(state.runRoot, record.raw_content_ref), "utf8").then((contents) =>
          contents.startsWith("SYNTHETIC CONTRACT FIXTURE"),
        ),
        true,
      );
      const exact = await new EvidenceStore(state.runsRoot).readExactRecord(
        G12_RUN_ID,
        `evidence/manifest.jsonl#${record.evidence_id}`,
      );
      assert.deepEqual(exact, record);
    }
  }

  const reopened = await state.store.load(G12_RUN_ID);
  assert.equal(reopened.lastValidCheckpointRef, "checkpoints/checkpoint-g1-2-vertical.json");
  assert.equal(reopened.manifest.schema_bundle_version, "4.0.0");
  assert.deepEqual(reopened.manifest.active_units, []);
  assert.deepEqual(reopened.manifest.completed_units, manifestBefore.completed_units);
  assert.equal(reopened.orphanActiveUnits.length, 0);
});

test("research task publication is pending-to-active only and exact replay preserves completion", async (context) => {
  const state = await publishVerticalFixture(context);
  const task = state.tasks[0];
  assert.ok(task);
  const replay = await state.store.publishArtifact({ runId: G12_RUN_ID, envelope: task });
  assert.equal(replay.status, "idempotent_replay");
  const afterReplay = await state.store.load(G12_RUN_ID);
  assert.deepEqual(afterReplay.manifest.active_units, []);
  assert.ok(afterReplay.manifest.completed_units.includes(String(task.document.unit_id)));

  const lateAttempt = structuredClone(task);
  (lateAttempt as unknown as Record<string, unknown>).artifact_path =
    `tasks/${String(task.document.unit_id)}.attempt-2.json`;
  lateAttempt.document.task_id = `${String(task.document.task_id)}_attempt_2`;
  lateAttempt.document.attempt = 2;
  lateAttempt.document.supersedes_task_ref = task.artifact_path;
  (lateAttempt as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
    lateAttempt.document,
  );
  await assert.rejects(
    state.store.publishArtifact({ runId: G12_RUN_ID, envelope: lateAttempt }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.task_transition_invalid",
  );
  const afterRejectedAttempt = await state.store.load(G12_RUN_ID);
  assert.deepEqual(afterRejectedAttempt.manifest.active_units, []);
  assert.deepEqual(
    afterRejectedAttempt.manifest.completed_units,
    afterReplay.manifest.completed_units,
  );

  const recoveryState = await setup(context);
  const base = await baseFixture();
  await recoveryState.store.publishArtifactBundle({
    runId: G12_RUN_ID,
    envelopes: initialFixtureEnvelopes(base),
  });
  const recoveryBranch = G12_BRANCHES[0];
  assert.ok(recoveryBranch);
  const recoveryTask = taskEnvelope(base, recoveryBranch, 2);
  await assert.rejects(
    recoveryState.store.publishArtifact({
      runId: G12_RUN_ID,
      envelope: recoveryTask,
      faultAt: "after_publish",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const beforeRecovery = JSON.parse(
    await readFile(path.join(recoveryState.runRoot, "manifest.json"), "utf8"),
  ) as { active_units: string[] };
  assert.deepEqual(beforeRecovery.active_units, []);
  const recovered = await recoveryState.store.load(G12_RUN_ID);
  assert.ok(recovered.manifest.active_units.includes(String(recoveryTask.document.unit_id)));
  assert.ok(recovered.manifest.artifact_refs.includes(recoveryTask.artifact_path));
});

test("v2 Evidence Store canonicalizes public URL, supports user origin, dedups raw bytes, and replays", async (context) => {
  const { runsRoot } = await setup(context, "run_g1_2_evidence_001");
  const store = new EvidenceStore(runsRoot);
  const common = {
    runId: "run_g1_2_evidence_001",
    unitId: "unit_synthetic",
    researchGoal: "Exercise the synthetic v2 identity contract.",
    rawContent: "SYNTHETIC SHARED BYTES",
    recordedAt: "2026-07-24T20:10:00Z",
  } as const;
  const first = await store.record({
    ...common,
    source: { kind: "public_url", canonical_url: "https://synthetic.invalid/a#fragment" },
  });
  const replay = await store.record({
    ...common,
    source: { kind: "public_url", canonical_url: "https://synthetic.invalid/a" },
  });
  const user = await store.record({
    ...common,
    source: {
      kind: "user_provided",
      canonical_uri: "urn:startup-opportunity:user-provided:shared-bytes",
    },
  });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(first.record.source.kind, "public_url");
  assert.notEqual(first.record.evidence_id, user.record.evidence_id);
  assert.equal(first.record.raw_content_ref, user.record.raw_content_ref);
  await assert.rejects(
    store.record({
      ...common,
      source: { kind: "user_provided", canonical_uri: "urn:unreserved:fixture" },
    }),
    (error: unknown) => error instanceof StoreError && error.code === "evidence.invalid_source",
  );
});

test("research chain rejects substrate drift, cross-task lineage, and v4 branch publication", async (context) => {
  const state = await publishVerticalFixture(context);
  const firstBranch = state.branchBundles[0];
  assert.ok(firstBranch);
  const evidence = structuredClone(
    firstBranch.find((entry) => entry.artifact_type === "startup_opportunity.evidence.v1"),
  );
  assert.ok(evidence);
  const binding = evidence.document.mechanical_binding as Record<string, unknown>;
  binding.source_hash = `sha256:${"0".repeat(64)}`;
  (evidence as unknown as Record<string, unknown>).content_hash = (
    await import("../harness/src/index.js")
  ).canonicalContentHash(evidence.document);
  const invalidBundle = {
    schema_version: "startup_opportunity.document_bundle.v5",
    documents: [
      ...state.initial.map((entry) => ({ path: entry.artifact_path, document: entry })),
      ...state.tasks.map((entry) => ({ path: entry.artifact_path, document: entry })),
      ...state.branchBundles.flat().map((entry) => ({
        path: entry.artifact_path,
        document: entry.artifact_path === evidence.artifact_path ? evidence : entry,
      })),
    ],
    exact_records: [...state.records.values()].flatMap((pair) =>
      pair.map((record) => ({
        ref: `evidence/manifest.jsonl#${record.evidence_id}`,
        document: record,
      })),
    ),
  };
  const invalid = state.validator.validateDocumentBundle(invalidBundle);
  assert.equal(invalid.valid, false);
  assert.ok(
    invalid.referenceErrors.some((issue) => issue.code === "research_contract.substrate_mismatch"),
  );
  const crossTaskClaim = structuredClone(
    firstBranch.find((entry) => entry.artifact_type === "startup_opportunity.claim.v1"),
  );
  assert.ok(crossTaskClaim);
  (crossTaskClaim.document.lineage as Record<string, unknown>).task_ref =
    "tasks/unit_alternatives.attempt-1.json";
  (crossTaskClaim as unknown as Record<string, unknown>).content_hash = (
    await import("../harness/src/index.js")
  ).canonicalContentHash(crossTaskClaim.document);
  const crossLineageBundle = structuredClone(invalidBundle);
  const claimEntry = crossLineageBundle.documents.find(
    (entry) => entry.path === crossTaskClaim.artifact_path,
  );
  assert.ok(claimEntry);
  claimEntry.document = crossTaskClaim;
  const crossLineage = state.validator.validateDocumentBundle(crossLineageBundle);
  assert.equal(crossLineage.valid, false);
  assert.ok(
    crossLineage.referenceErrors.some(
      (issue) => issue.code === "research_contract.lineage_mismatch",
    ),
  );

  const crossUnitRetry = structuredClone(state.tasks[0]);
  assert.ok(crossUnitRetry);
  (crossUnitRetry as unknown as Record<string, unknown>).artifact_path =
    `tasks/${String(crossUnitRetry.document.unit_id)}.attempt-2.json`;
  crossUnitRetry.document.task_id = `${String(crossUnitRetry.document.task_id)}_attempt_2`;
  crossUnitRetry.document.attempt = 2;
  crossUnitRetry.document.supersedes_task_ref = state.tasks[1]?.artifact_path;
  (crossUnitRetry as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
    crossUnitRetry.document,
  );
  const crossUnitRetryBundle = structuredClone(invalidBundle);
  crossUnitRetryBundle.documents.push({
    path: crossUnitRetry.artifact_path,
    document: crossUnitRetry,
  });
  const invalidRetry = state.validator.validateDocumentBundle(crossUnitRetryBundle);
  assert.equal(invalidRetry.valid, false);
  assert.ok(
    invalidRetry.referenceErrors.some(
      (issue) => issue.code === "research_contract.task_supersede_mismatch",
    ),
  );

  const branchEnvelope = firstBranch.find(
    (entry) =>
      entry.artifact_type === "startup_opportunity.concept_evidence_assessment_branch_result.v1",
  );
  assert.ok(branchEnvelope);
  await assert.rejects(
    state.store.publishArtifact({
      runId: G12_RUN_ID,
      envelope: {
        ...branchEnvelope,
        schema_version: "startup_opportunity.artifact_envelope.v4",
        artifact_path: "artifacts/lanes/v4-branch-blocked.json",
      },
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.adapter_blocked_type",
  );
});

test("v2 Evidence receipt recovers raw publication after an injected crash", async (context) => {
  const { runsRoot, store } = await setup(context, "run_g1_2_fault_001");
  const evidence = new EvidenceStore(runsRoot);
  await assert.rejects(
    evidence.record({
      runId: "run_g1_2_fault_001",
      unitId: "unit_fault",
      researchGoal: "Synthetic fault recovery only.",
      source: {
        kind: "public_url",
        canonical_url: "https://synthetic.invalid/fault",
      },
      rawContent: "SYNTHETIC FAULT BYTES",
      recordedAt: "2026-07-24T20:10:00Z",
      faultAt: "after_intent",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await store.load("run_g1_2_fault_001");
  assert.equal(reopened.evidenceRecovery.replayedEvidenceIds.length, 1);
  assert.equal(reopened.evidenceRecovery.recoveredRawContentRefs.length, 1);
  const manifest = await readFile(
    path.join(runsRoot, "run_g1_2_fault_001/evidence/manifest.jsonl"),
    "utf8",
  );
  assert.match(manifest, /startup_opportunity\.evidence_store_record\.v2/);
});

test("v5 Artifact receipt recovers immutable publication after temp-write crash", async (context) => {
  const { runRoot, store } = await setup(context, "run_g1_2_artifact_fault_001");
  const document = {
    schema_version: "startup_opportunity.event.v1",
    event_id: "g1_2_artifact_fault_001",
    run_id: "run_g1_2_artifact_fault_001",
    event_type: "decision_context_written",
    timestamp: "2026-07-24T20:10:00Z",
    actor: "harness",
    reason: "Synthetic v5 Artifact fault fixture.",
    artifact_refs: [],
  };
  const faultEnvelope = {
    schema_version: "startup_opportunity.artifact_envelope.v5",
    artifact_type: document.schema_version,
    artifact_path: "artifacts/g1-2-fault-event.json",
    run_id: document.run_id,
    created_at: document.timestamp,
    producer_role: "harness",
    input_refs: [],
    content_hash: canonicalContentHash(document),
    document,
  } as const;
  await assert.rejects(
    store.publishArtifact({
      runId: document.run_id,
      envelope: faultEnvelope,
      faultAt: "after_temp_write",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await store.load(document.run_id);
  assert.deepEqual(reopened.recoveredArtifactPaths, [faultEnvelope.artifact_path]);
  assert.ok(reopened.manifest.artifact_refs.includes(faultEnvelope.artifact_path));
  const operationReceipts = await readdir(path.join(runRoot, ".store/operations"));
  const receiptVersions = await Promise.all(
    operationReceipts
      .filter((entry) => entry.startsWith("artifact-"))
      .map(async (entry) =>
        JSON.parse(await readFile(path.join(runRoot, ".store/operations", entry), "utf8")),
      ),
  );
  assert.ok(
    receiptVersions.some(
      (receipt) => receipt.schema_version === "startup_opportunity.artifact_store_operation.v4",
    ),
  );
});

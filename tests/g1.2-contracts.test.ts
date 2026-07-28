import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  canonicalJson,
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

async function snapshotTree(root: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        snapshot[relative] = (await readFile(absolute)).toString("base64");
      }
    }
  };
  await visit(root);
  return Object.fromEntries(
    Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function prepareSingleBranch(context: TestContext, runId = G12_RUN_ID) {
  const state = await setup(context, runId);
  const base = await baseFixture();
  const initial = initialFixtureEnvelopes(base);
  await state.store.publishArtifactBundle({ runId, envelopes: initial });
  const branch = G12_BRANCHES[0];
  assert.ok(branch);
  const task = taskEnvelope(base, branch, 2);
  await state.store.publishArtifact({ runId, envelope: task });
  const evidenceStore = new EvidenceStore(state.runsRoot);
  const researchGoal = String(task.document.research_goal);
  const publicRecord = await evidenceStore.record({
    runId,
    unitId: branch.unitId,
    researchGoal,
    source: { kind: "public_url", canonical_url: "https://synthetic.invalid/state-support" },
    rawContent: "SYNTHETIC STATE SUPPORT BYTES; NOT MARKET EVIDENCE.",
    recordedAt: "2026-07-24T20:20:00Z",
  });
  const userRecord = await evidenceStore.record({
    runId,
    unitId: branch.unitId,
    researchGoal,
    source: {
      kind: "user_provided",
      canonical_uri: "urn:startup-opportunity:user-provided:state-oppose",
    },
    rawContent: "SYNTHETIC STATE OPPOSING BYTES; NOT MARKET EVIDENCE.",
    recordedAt: "2026-07-24T20:21:00Z",
  });
  const envelopes = branchResearchEnvelopes(
    branch,
    [publicRecord.record, userRecord.record],
    0,
  ).map((envelope) => ({
    ...envelope,
    run_id: runId,
    document: { ...envelope.document, run_id: runId },
  }));
  for (const envelope of envelopes) {
    (envelope as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
      envelope.document,
    );
  }
  return { ...state, base, initial, branch, task, envelopes };
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
  assert.equal(result.schemaBundleVersion, "12.0.0");
  assert.equal(result.schemaCount, 141);
  assert.equal(result.documentSchemaCount, 133);
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

test("research chain closes formal input refs and Source Manifest Evidence coverage", async (context) => {
  const state = await publishVerticalFixture(context);
  const documents = [...state.initial, ...state.tasks, ...state.branchBundles.flat()].map(
    (entry) => ({ path: entry.artifact_path, document: structuredClone(entry) }),
  );
  const exactRecords = [...state.records.values()].flatMap((pair) =>
    pair.map((record) => ({
      ref: `evidence/manifest.jsonl#${record.evidence_id}`,
      document: record,
    })),
  );
  const validBundle = {
    schema_version: "startup_opportunity.document_bundle.v5",
    documents,
    exact_records: exactRecords,
  };
  assert.equal(state.validator.validateDocumentBundle(validBundle).valid, true);

  const missingEnvelopeInput = structuredClone(validBundle);
  const claimEnvelope = missingEnvelopeInput.documents.find(
    (entry) =>
      entry.document.artifact_type === "startup_opportunity.claim.v1" &&
      entry.document.document.stance === "support",
  );
  assert.ok(claimEnvelope);
  const mutableClaimEnvelope = claimEnvelope.document as unknown as {
    input_refs: string[];
    document: { lineage: { task_ref: string } };
  };
  mutableClaimEnvelope.input_refs = [mutableClaimEnvelope.document.lineage.task_ref];
  const inputDrift = state.validator.validateDocumentBundle(missingEnvelopeInput);
  assert.equal(inputDrift.valid, false);
  assert.ok(
    inputDrift.referenceErrors.some(
      (entry) => entry.code === "research_contract.input_ref_missing",
    ),
  );

  const incompleteSourceManifest = structuredClone(validBundle);
  const sourceManifestEnvelope = incompleteSourceManifest.documents.find(
    (entry) =>
      entry.path === "evidence/source-manifests/unit_demand.json" &&
      entry.document.artifact_type === "startup_opportunity.source_manifest.v1",
  );
  assert.ok(sourceManifestEnvelope);
  const accepted = sourceManifestEnvelope.document.document.accepted_evidence_refs as string[];
  sourceManifestEnvelope.document.document.accepted_evidence_refs = accepted.slice(1);
  (sourceManifestEnvelope.document as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(sourceManifestEnvelope.document.document);
  const sourceDrift = state.validator.validateDocumentBundle(incompleteSourceManifest);
  assert.equal(sourceDrift.valid, false);
  assert.ok(
    sourceDrift.referenceErrors.some(
      (entry) => entry.code === "research_contract.source_manifest_incomplete",
    ),
  );

  const brokenChain = structuredClone(validBundle);
  const demandFinding = brokenChain.documents.find(
    (entry) => entry.path === "findings/unit_demand.json",
  );
  const demandBranch = brokenChain.documents.find(
    (entry) => entry.path === "artifacts/lanes/demand.json",
  );
  assert.ok(demandFinding);
  assert.ok(demandBranch);
  const orphanFinding = structuredClone(demandFinding);
  orphanFinding.path = "findings/unit_demand-orphan.json";
  (orphanFinding.document as unknown as Record<string, unknown>).artifact_path = orphanFinding.path;
  orphanFinding.document.document.finding_id = "finding_unit_demand_orphan";
  (orphanFinding.document as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(orphanFinding.document.document);
  brokenChain.documents.push(orphanFinding);
  demandBranch.document.document.finding_refs = [orphanFinding.path];
  (demandBranch.document as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
    demandBranch.document.document,
  );
  const chainDrift = state.validator.validateDocumentBundle(brokenChain);
  assert.equal(chainDrift.valid, false);
  assert.ok(
    chainDrift.referenceErrors.some(
      (entry) => entry.code === "research_contract.branch_chain_incomplete",
    ),
  );

  const crossRun = structuredClone(validBundle);
  const crossRunClaim = crossRun.documents.find(
    (entry) => entry.path === "claims/unit_demand-support.json",
  );
  assert.ok(crossRunClaim);
  crossRunClaim.document.document.run_id = "run_g1_2_foreign_001";
  (crossRunClaim.document as unknown as Record<string, unknown>).run_id = "run_g1_2_foreign_001";
  (crossRunClaim.document as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(crossRunClaim.document.document);
  const crossRunResult = state.validator.validateDocumentBundle(crossRun);
  assert.equal(crossRunResult.valid, false);
  assert.ok(
    crossRunResult.referenceErrors.some((entry) => entry.code === "reference.run_mismatch"),
  );

  const crossAttempt = structuredClone(validBundle);
  const crossAttemptClaim = crossAttempt.documents.find(
    (entry) => entry.path === "claims/unit_demand-support.json",
  );
  assert.ok(crossAttemptClaim);
  (crossAttemptClaim.document.document.lineage as Record<string, unknown>).attempt = 2;
  (crossAttemptClaim.document as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(crossAttemptClaim.document.document);
  const crossAttemptResult = state.validator.validateDocumentBundle(crossAttempt);
  assert.equal(crossAttemptResult.valid, false);
  assert.ok(
    crossAttemptResult.referenceErrors.some(
      (entry) => entry.code === "research_contract.lineage_mismatch",
    ),
  );

  const duplicateIdentity = structuredClone(validBundle);
  const duplicatedEvidence = structuredClone(
    duplicateIdentity.documents.find(
      (entry) => entry.document.artifact_type === "startup_opportunity.evidence.v1",
    ),
  );
  assert.ok(duplicatedEvidence);
  duplicatedEvidence.path = `evidence/records/ev_${"f".repeat(64)}.json`;
  (duplicatedEvidence.document as unknown as Record<string, unknown>).artifact_path =
    duplicatedEvidence.path;
  duplicateIdentity.documents.push(duplicatedEvidence);
  const duplicateIdentityResult = state.validator.validateDocumentBundle(duplicateIdentity);
  assert.equal(duplicateIdentityResult.valid, false);
  assert.ok(
    duplicateIdentityResult.referenceErrors.some(
      (entry) => entry.code === "research_contract.duplicate_identity",
    ),
  );

  const duplicatePath = structuredClone(validBundle);
  const duplicatedClaim = structuredClone(
    duplicatePath.documents.find((entry) => entry.path === "claims/unit_demand-support.json"),
  );
  assert.ok(duplicatedClaim);
  duplicatedClaim.document.document.claim_id = "claim_unit_demand_support_duplicate";
  (duplicatedClaim.document as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(duplicatedClaim.document.document);
  duplicatePath.documents.push(duplicatedClaim);
  const duplicatePathResult = state.validator.validateDocumentBundle(duplicatePath);
  assert.equal(duplicatePathResult.valid, false);
  assert.ok(
    duplicatePathResult.referenceErrors.some((entry) => entry.code === "reference.duplicate_path"),
  );
});

test("partial and failed branches produce stable terminal Manifest classifications", async (context) => {
  for (const [status, expectedField] of [
    ["partial", "completed_units"],
    ["failed", "failed_units"],
  ] as const) {
    await context.test(status, async (child) => {
      const state = await prepareSingleBranch(child);
      const envelopes = structuredClone(state.envelopes);
      const branchEnvelope = envelopes.find(
        (entry) =>
          entry.artifact_type ===
          "startup_opportunity.concept_evidence_assessment_branch_result.v1",
      );
      assert.ok(branchEnvelope);
      (branchEnvelope.document as Record<string, unknown>).branch_status = status;
      (branchEnvelope as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
        branchEnvelope.document,
      );
      await state.store.publishArtifactBundle({ runId: G12_RUN_ID, envelopes });
      const reopened = await state.store.load(G12_RUN_ID);
      assert.ok(reopened.manifest[expectedField].includes(state.branch.unitId));
      assert.ok(!reopened.manifest.active_units.includes(state.branch.unitId));
    });
  }
});

test("active branch cannot self-authorize superseded or ignored-late state", async (context) => {
  for (const status of ["superseded_by_adaptation", "ignored_late"] as const) {
    await context.test(status, async (child) => {
      const state = await prepareSingleBranch(child);
      const envelopes = structuredClone(state.envelopes);
      const branchEnvelope = envelopes.find(
        (entry) =>
          entry.artifact_type ===
          "startup_opportunity.concept_evidence_assessment_branch_result.v1",
      );
      assert.ok(branchEnvelope);
      (branchEnvelope.document as Record<string, unknown>).branch_status = status;
      (branchEnvelope as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
        branchEnvelope.document,
      );
      const before = await snapshotTree(state.runRoot);
      await assert.rejects(
        state.store.publishArtifactBundle({ runId: G12_RUN_ID, envelopes }),
        (error: unknown) =>
          error instanceof StoreError && error.code === "artifact.branch_transition_invalid",
      );
      assert.deepEqual(await snapshotTree(state.runRoot), before);
    });
  }
});

test("existing superseded and invalidated units keep late Branch results out of current refs", async (context) => {
  for (const [branchStatus, stateField] of [
    ["superseded_by_adaptation", "superseded_units"],
    ["ignored_late", "invalidated_units"],
  ] as const) {
    await context.test(branchStatus, async (child) => {
      const state = await prepareSingleBranch(child);
      const manifestPath = path.join(state.runRoot, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      const statusFields = [
        "completed_units",
        "active_units",
        "failed_units",
        "invalidated_units",
        "skipped_units",
        "cancelled_units",
        "superseded_units",
      ];
      for (const field of statusFields) {
        manifest[field] = field === stateField ? [state.branch.unitId] : [];
      }
      manifest.updated_at = "2026-07-24T20:30:00Z";
      await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
      await state.store.checkpoint({
        runId: G12_RUN_ID,
        checkpointId: `checkpoint_${branchStatus}`,
        createdAt: "2026-07-24T20:31:00Z",
        nextStep: "Keep the synthetic late Branch Result outside the current artifact set.",
        beliefSummary: {
          current_belief: "Only the late-result classification contract is under test.",
          evidence_that_changed_belief: [],
          unchanged_assumptions: ["No market Evidence was collected."],
          remaining_disagreement: [],
          next_decision_relevant_question: "Does reopen preserve late-result classification?",
        },
      });
      const envelopes = structuredClone(state.envelopes);
      const branchEnvelope = envelopes.find(
        (entry) =>
          entry.artifact_type ===
          "startup_opportunity.concept_evidence_assessment_branch_result.v1",
      );
      assert.ok(branchEnvelope);
      (branchEnvelope.document as Record<string, unknown>).branch_status = branchStatus;
      (branchEnvelope as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
        branchEnvelope.document,
      );
      await state.store.publishArtifactBundle({ runId: G12_RUN_ID, envelopes });
      const afterPublish = await state.store.load(G12_RUN_ID);
      assert.ok(afterPublish.manifest[stateField].includes(state.branch.unitId));
      assert.ok(!afterPublish.manifest.artifact_refs.includes(state.branch.outputPath));
      assert.ok(afterPublish.manifest.ignored_late_artifact_refs.includes(state.branch.outputPath));
      const beforeReplay = await snapshotTree(state.runRoot);
      const replay = await state.store.publishArtifactBundle({ runId: G12_RUN_ID, envelopes });
      assert.equal(replay.status, "idempotent_replay");
      assert.deepEqual(await snapshotTree(state.runRoot), beforeReplay);
      const reopened = await state.store.load(G12_RUN_ID);
      assert.ok(!reopened.manifest.artifact_refs.includes(state.branch.outputPath));
      assert.ok(reopened.manifest.ignored_late_artifact_refs.includes(state.branch.outputPath));
    });
  }
});

test("legacy v1 and materialized v2 Evidence records coexist and share only raw bytes", async (context) => {
  const { runsRoot, store } = await setup(context, "run_g1_2_coexist_001");
  const evidence = new EvidenceStore(runsRoot);
  const common = {
    runId: "run_g1_2_coexist_001",
    unitId: "unit_coexist",
    researchGoal: "Synthetic v1/v2 coexistence contract only.",
    rawContent: "SYNTHETIC COEXISTENCE BYTES",
    recordedAt: "2026-07-24T20:10:00Z",
  } as const;
  const legacy = await evidence.record({
    ...common,
    url: "https://synthetic.invalid/coexist#legacy",
  });
  const materialized = await evidence.record({
    ...common,
    source: { kind: "public_url", canonical_url: "https://synthetic.invalid/coexist" },
  });
  assert.notEqual(legacy.record.evidence_id, materialized.record.evidence_id);
  assert.equal(legacy.record.raw_content_ref, materialized.record.raw_content_ref);
  const reopened = await store.load(common.runId);
  assert.equal(reopened.evidenceRecovery.replayedEvidenceIds.length, 0);
  const records = (
    await readFile(path.join(runsRoot, common.runId, "evidence/manifest.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { schema_version: string });
  assert.deepEqual(records.map((record) => record.schema_version).sort(), [
    "startup_opportunity.evidence_store_record.v1",
    "startup_opportunity.evidence_store_record.v2",
  ]);
});

test("Evidence receipt cross-task drift fails reopen before any recovery write", async (context) => {
  const { runsRoot, runRoot, store } = await setup(context, "run_g1_2_receipt_drift_001");
  const evidence = new EvidenceStore(runsRoot);
  const recorded = await evidence.record({
    runId: "run_g1_2_receipt_drift_001",
    unitId: "unit_receipt_original",
    researchGoal: "Synthetic receipt drift contract only.",
    source: { kind: "public_url", canonical_url: "https://synthetic.invalid/receipt-drift" },
    rawContent: "SYNTHETIC RECEIPT DRIFT BYTES",
    recordedAt: "2026-07-24T20:10:00Z",
  });
  const operationEntry = (await readdir(path.join(runRoot, ".store/operations"))).find((entry) =>
    entry.startsWith("evidence-"),
  );
  assert.ok(operationEntry);
  const receiptPath = path.join(runRoot, ".store/operations", operationEntry);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    record: { unit_id: string; evidence_id: string };
  };
  assert.equal(receipt.record.evidence_id, recorded.record.evidence_id);
  receipt.record.unit_id = "unit_receipt_foreign";
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  const before = await snapshotTree(runRoot);
  await assert.rejects(
    store.load("run_g1_2_receipt_drift_001"),
    (error: unknown) => error instanceof StoreError && error.code === "recovery.missing_operation",
  );
  assert.deepEqual(await snapshotTree(runRoot), before);
});

test("unsupported envelope version fails before changing Run bytes", async (context) => {
  const { runRoot, store } = await setup(context, "run_g1_2_unsupported_001");
  const document = {
    schema_version: "startup_opportunity.event.v1",
    event_id: "g1_2_unsupported_001",
    run_id: "run_g1_2_unsupported_001",
    event_type: "decision_context_written",
    timestamp: "2026-07-24T20:10:00Z",
    actor: "harness",
    reason: "Synthetic unsupported envelope fixture.",
    artifact_refs: [],
  };
  const before = await snapshotTree(runRoot);
  await assert.rejects(
    store.publishArtifact({
      runId: document.run_id,
      envelope: {
        schema_version: "startup_opportunity.artifact_envelope.v9",
        artifact_type: document.schema_version,
        artifact_path: "artifacts/unsupported.json",
        run_id: document.run_id,
        created_at: document.timestamp,
        producer_role: "harness",
        input_refs: [],
        content_hash: canonicalContentHash(document),
        document,
      } as unknown as FormalArtifactEnvelope,
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.envelope_unsupported",
  );
  assert.deepEqual(await snapshotTree(runRoot), before);
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

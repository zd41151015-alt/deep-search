import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = path.join(repositoryRoot, "tests/fixtures/store");
const SCOPE_CONFIRMATION = {
  geography: "Synthetic",
  customerModel: "b2c" as const,
  targetUsers: ["synthetic user"],
  decisionGoal: "test current contract",
  researchLanguage: "en-US",
};

async function setup(context: TestContext, runId = "store-test", confirm = true) {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  const created = await store.create({
    runId,
    mode: "concept_evidence_assessment",
    scopeProposal: SCOPE_CONFIRMATION,
    createdAt: "2026-07-23T12:00:00Z",
  });
  if (confirm) {
    await store.confirmScope({
      runId,
      expectedScopeProposalRevision: created.manifest.scope_revision,
      expectedScopeProposalRef: created.scopeProposalRef,
      expectedScopeProposalHash: created.scopeProposalHash,
      confirmedAt: "2026-07-23T12:00:01Z",
      userConfirmationAttestation:
        "The fixture caller attests that the user reviewed and confirmed this exact Scope proposal.",
    });
  }
  return {
    root,
    runsRoot,
    runRoot: path.join(runsRoot, runId),
    store,
    validator,
    created: { ...created, manifest: (await store.status(runId)).manifest },
  };
}

async function snapshotTree(root: string): Promise<readonly [string, string][]> {
  const files: [string, string][] = [];
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        files.push([relative, (await readFile(absolute)).toString("base64")]);
      }
    }
  };
  await visit(root);
  return files;
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
    schema_version: "startup_opportunity.artifact_envelope.current",
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
  assert.equal("skill_version" in created.manifest, false);
  assert.equal("policy_version" in created.manifest, false);
  assert.equal("git_commit" in created.manifest, false);

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
  const initialCheckpoint = JSON.parse(
    await readFile(path.join(runRoot, "checkpoints/checkpoint-initial.json"), "utf8"),
  ) as { schema_version: string };
  assert.equal(initialCheckpoint.schema_version, "startup_opportunity.artifact_envelope.current");

  const replay = await store.create({
    runId: "store-test",
    mode: "concept_evidence_assessment",
    scopeProposal: SCOPE_CONFIRMATION,
    createdAt: "2026-07-23T13:00:00Z",
  });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.manifest.created_at, "2026-07-23T12:00:00Z");
  assert.equal(runsRoot, path.dirname(runRoot));
});

test("Scope confirmation is an immutable Run Store binding across correction and reopen", async (context) => {
  const { runRoot, store, created } = await setup(context, "scope-binding-test", false);
  assert.equal(created.manifest.scope_revision, 1);
  assert.equal(created.manifest.status, "awaiting_scope_confirmation");
  assert.equal(created.manifest.scope_confirmation_ref, null);
  const initialProposal = JSON.parse(
    (await readFile(path.join(runRoot, "decisions.jsonl"), "utf8")).trim(),
  ) as Record<string, unknown>;
  assert.equal(initialProposal.decision_type, "scope_proposed");
  assert.equal(initialProposal.actor, "main_agent");
  assert.equal(`decisions.jsonl#${String(initialProposal.decision_id)}`, created.scopeProposalRef);
  assert.equal(canonicalContentHash(initialProposal), created.scopeProposalHash);
  await assert.rejects(
    store.assertResearchExecutionAllowed("scope-binding-test"),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.scope_confirmation_required",
  );
  await assert.rejects(
    store.confirmScope({
      runId: "scope-binding-test",
      expectedScopeProposalRevision: 1,
      expectedScopeProposalRef: created.scopeProposalRef,
      expectedScopeProposalHash: "0".repeat(64),
      confirmedAt: "2026-07-23T12:05:00Z",
      userConfirmationAttestation: "The fixture caller attests exact user confirmation.",
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.scope_proposal_binding_mismatch",
  );

  const initialConfirmation = await store.confirmScope({
    runId: "scope-binding-test",
    expectedScopeProposalRevision: 1,
    expectedScopeProposalRef: created.scopeProposalRef,
    expectedScopeProposalHash: created.scopeProposalHash,
    confirmedAt: "2026-07-23T12:06:00Z",
    userConfirmationAttestation:
      "The fixture caller attests that the user reviewed and confirmed proposal revision one.",
  });
  assert.equal(initialConfirmation.harnessIdentityVerification, "not_available");
  assert.equal((await store.status("scope-binding-test")).manifest.status, "created");

  const correctedProposal = await store.proposeScope({
    runId: "scope-binding-test",
    expectedScopeRevision: 1,
    proposedAt: "2026-07-23T12:10:00Z",
    reason: "Propose the corrected geography for explicit user review.",
    scopeProposal: {
      ...SCOPE_CONFIRMATION,
      geography: "Synthetic corrected geography",
    },
  });
  assert.equal(correctedProposal.scopeRevision, 2);
  assert.equal(
    (await store.status("scope-binding-test")).manifest.status,
    "awaiting_scope_confirmation",
  );
  await assert.rejects(store.assertResearchExecutionAllowed("scope-binding-test"));
  const corrected = await store.confirmScope({
    runId: "scope-binding-test",
    expectedScopeProposalRevision: 2,
    expectedScopeProposalRef: correctedProposal.scopeProposalRef,
    expectedScopeProposalHash: correctedProposal.scopeProposalHash,
    confirmedAt: "2026-07-23T12:11:00Z",
    userConfirmationAttestation:
      "The fixture caller attests that the user reviewed and confirmed proposal revision two.",
  });
  const decisions = (await readFile(path.join(runRoot, "decisions.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(decisions.length, 4);
  assert.equal(decisions[0]?.decision_id, initialProposal.decision_id);
  assert.deepEqual(
    decisions.map((decision) => decision.decision_type),
    ["scope_proposed", "scope_assumption_confirmed", "scope_proposed", "scope_changed_by_user"],
  );

  const reopened = await store.load("scope-binding-test");
  assert.equal(reopened.manifest.scope_revision, 2);
  assert.equal(reopened.manifest.scope_confirmation_ref, corrected.scopeConfirmationRef);
  assert.equal(reopened.manifest.scope_confirmation_hash, corrected.scopeConfirmationHash);
  assert.equal(reopened.manifest.status, "needs_clarification");
  await assert.rejects(
    store.assertResearchExecutionAllowed("scope-binding-test"),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.scope_revision_unresolved",
  );
});

test("unconfirmed Scope blocks public and locked Evidence and Artifact writes before persistence", async (context) => {
  const { runsRoot, runRoot, store, validator } = await setup(
    context,
    "scope-storage-boundary-test",
    false,
  );
  await assert.rejects(
    store.assertResearchExecutionAllowed("scope-storage-boundary-test"),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.scope_confirmation_required",
  );
  const evidence = new EvidenceStore(runsRoot);
  const evidenceInput = {
    runId: "scope-storage-boundary-test",
    unitId: "unit_scope_bypass",
    researchGoal: "SYNTHETIC unauthorized Evidence write.",
    source: {
      kind: "user_provided" as const,
      canonical_uri: "urn:startup-opportunity:user-provided:scope-bypass-synthetic",
    },
    rawContent: "SYNTHETIC unauthorized bytes.",
  };
  const artifacts = new ArtifactStore(runsRoot, validator);
  const envelope = await eventEnvelope(
    "scope-storage-boundary-test",
    "events/scope-bypass-event.json",
  );
  const secondEnvelope = await eventEnvelope(
    "scope-storage-boundary-test",
    "events/scope-bypass-event-2.json",
    { event_id: "event_scope_bypass_002" },
  );
  const before = await snapshotTree(runRoot);
  const attempts = [
    () => evidence.record(evidenceInput),
    () => evidence.recordLocked(runRoot, evidenceInput),
    () => artifacts.publish({ runId: "scope-storage-boundary-test", envelope }),
    () =>
      artifacts.publishLocked(runRoot, {
        runId: "scope-storage-boundary-test",
        envelope,
      }),
    () =>
      artifacts.publishBundle({
        runId: "scope-storage-boundary-test",
        envelopes: [envelope, secondEnvelope],
      }),
    () =>
      artifacts.publishBundleLocked(runRoot, {
        runId: "scope-storage-boundary-test",
        envelopes: [envelope, secondEnvelope],
      }),
  ];
  for (const attempt of attempts) {
    await assert.rejects(
      attempt(),
      (error: unknown) =>
        error instanceof StoreError && error.code === "run.scope_confirmation_required",
    );
    assert.deepEqual(await snapshotTree(runRoot), before);
  }
  const reopened = await store.load("scope-storage-boundary-test");
  assert.equal(reopened.manifest.status, "awaiting_scope_confirmation");
  assert.deepEqual(await snapshotTree(runRoot), before);
});

test("Scope decisions cannot bypass the dedicated Run Store confirmation paths", async (context) => {
  const { store } = await setup(context, "scope-append-bypass-test");
  const scope = {
    revision: 2,
    geography: "Synthetic bypass",
    customer_model: "b2c",
    target_users: ["synthetic user"],
    decision_goal: "test current contract",
    research_language: "en-US",
  };
  await assert.rejects(
    store.appendDecision("scope-append-bypass-test", {
      schema_version: "startup_opportunity.decision.v1",
      decision_id: "scope_confirmation_bypass_r2",
      run_id: "scope-append-bypass-test",
      decision_type: "scope_changed_by_user",
      timestamp: "2026-07-23T12:10:00Z",
      actor: "user",
      reason: "This record must not bypass the Manifest-bound confirmation operation.",
      artifact_refs: [],
      scope_revision: 2,
      scope_hash: canonicalContentHash(scope),
      scope,
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "run.scope_confirmation_dedicated_path_required",
  );
  await assert.rejects(
    store.appendDecision("scope-append-bypass-test", {
      schema_version: "startup_opportunity.decision.v1",
      decision_id: "scope_proposal_bypass_r2",
      run_id: "scope-append-bypass-test",
      decision_type: "scope_proposed",
      timestamp: "2026-07-23T12:11:00Z",
      actor: "main_agent",
      reason: "This record must not bypass the dedicated proposal operation.",
      artifact_refs: [],
      scope_revision: 2,
      scope_hash: canonicalContentHash(scope),
      scope,
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "run.scope_confirmation_dedicated_path_required",
  );
  assert.equal((await store.status("scope-append-bypass-test")).manifest.scope_revision, 1);
});

test("create validates before visibility and atomically discards failed staging Runs", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-create-atomic-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  const runId = "atomic-create-test";

  await assert.rejects(
    store.create({
      runId,
      mode: "opportunity_discovery",
      scopeProposal: SCOPE_CONFIRMATION,
      createdAt: "not-a-timestamp",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "manifest.schema_invalid",
  );
  assert.deepEqual(await readdir(root), []);

  await assert.rejects(
    store.create({
      runId,
      mode: "opportunity_discovery",
      scopeProposal: SCOPE_CONFIRMATION,
      createdAt: "2026-07-30T12:00:00Z",
      faultAt: "before_publish",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const failedEntries = await readdir(runsRoot);
  assert.ok(!failedEntries.includes(runId));
  assert.ok(!failedEntries.some((entry) => entry.startsWith(`.create-${runId}-`)));

  const created = await store.create({
    runId,
    mode: "opportunity_discovery",
    scopeProposal: SCOPE_CONFIRMATION,
    createdAt: "2026-07-30T12:00:00Z",
  });
  assert.equal(created.status, "created");
  assert.equal((await store.load(runId)).manifest.run_id, runId);

  const incompleteRunId = "preexisting-incomplete-run";
  await mkdir(path.join(runsRoot, incompleteRunId));
  await assert.rejects(
    store.create({
      runId: incompleteRunId,
      mode: "opportunity_discovery",
      scopeProposal: SCOPE_CONFIRMATION,
      createdAt: "2026-07-30T12:01:00Z",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "run.incomplete",
  );
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
    3,
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
      store.create({ runId, mode: "opportunity_discovery", scopeProposal: SCOPE_CONFIRMATION }),
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
    source: {
      kind: "public_url",
      canonical_url: "HTTPS://Example.COM:443/research?q=buyer#section",
    },
    researchGoal: "Check buyer evidence.",
    rawContent: raw,
    recordedAt: "2026-07-23T12:20:00Z",
  });
  assert.equal(first.status, "recorded");
  assert.deepEqual(first.record.source, {
    kind: "public_url",
    canonical_url: "https://example.com/research?q=buyer",
  });
  assert.deepEqual(await readFile(path.join(runRoot, first.record.raw_content_ref)), raw);

  const replay = await evidence.record({
    runId: "store-test",
    unitId: "buyer_unit_001",
    source: {
      kind: "public_url",
      canonical_url: "https://example.com/research?q=buyer#different",
    },
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
      source: {
        kind: "public_url",
        canonical_url: "https://example.com/research?q=buyer",
      },
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

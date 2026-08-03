import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  canonicalJson,
  createArtifactValidator,
  type DiscoveryCandidateDocument,
  type DiscoveryCandidatePolicy,
  type DocumentBundle,
  EvidenceStore,
  type FormalArtifactEnvelope,
  RunStore,
  StoreError,
  validateDiscoveryCandidateContract,
} from "../harness/src/index.js";
import {
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  createDiscoveryCandidateFixture,
  G22_DEMAND_R2,
  G22_FAN_IN,
  G22_GENERATION_LANE,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";
import {
  createDiscoveryRuntimeFixture,
  runtimeEnvelope,
} from "./fixtures/g2.2/discovery-runtime-fixture.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

interface RuntimeState {
  readonly root: string;
  readonly runsRoot: string;
  readonly runRoot: string;
  readonly runId: string;
  readonly store: RunStore;
  readonly bundle: DocumentBundle;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function candidateContractDocuments(bundle: DocumentBundle): DiscoveryCandidateDocument[] {
  return bundle.documents.map((entry) => {
    const stored = entry.document;
    const isEnvelope = String(stored.schema_version).startsWith(
      "startup_opportunity.artifact_envelope.",
    );
    return {
      path: entry.path,
      schemaVersion: isEnvelope ? String(stored.artifact_type) : String(stored.schema_version),
      document: isEnvelope
        ? (stored.document as Record<string, unknown>)
        : (stored as Record<string, unknown>),
      envelope: isEnvelope ? (stored as Record<string, unknown>) : null,
    };
  });
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

function runtimeEnvelopes(bundle: DocumentBundle): FormalArtifactEnvelope[] {
  return bundle.documents
    .map((entry) => entry.document as unknown as FormalArtifactEnvelope)
    .filter((entry) => entry.schema_version === "startup_opportunity.artifact_envelope.current");
}

function envelopesByType(bundle: DocumentBundle, ...artifactTypes: readonly string[]) {
  return runtimeEnvelopes(bundle).filter((entry) => artifactTypes.includes(entry.artifact_type));
}

async function setup(context: TestContext, suffix: string): Promise<RuntimeState> {
  const root = await mkdtemp(path.join(tmpdir(), `startup-opportunity-g2-2-${suffix}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = `g2-2-${suffix}-synthetic`;
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await store.create({
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-27T17:00:00Z",
  });
  const evidence = new EvidenceStore(runsRoot);
  const generation = (
    await evidence.record({
      runId,
      unitId: "unit_seed_independent_demand",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:${suffix}-generation`,
      },
      researchGoal: "SYNTHETIC runtime generation substrate; not Evidence or validation.",
      rawContent: "SYNTHETIC generation bytes; not Evidence.",
      recordedAt: "2026-07-27T17:40:00Z",
    })
  ).record;
  const evaluation = (
    await evidence.record({
      runId,
      unitId: "unit_counterfactual",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:${suffix}-evaluation`,
      },
      researchGoal: "SYNTHETIC runtime evaluation substrate; not Evidence or validation.",
      rawContent: "SYNTHETIC evaluation bytes; not Evidence.",
      recordedAt: "2026-07-27T17:41:00Z",
    })
  ).record;
  const bundle = await createDiscoveryRuntimeFixture(runId, { generation, evaluation });
  await store.publishArtifactBundle({
    runId,
    envelopes: G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  await store.publishArtifactBundle({
    runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  return { root, runsRoot, runRoot: path.join(runsRoot, runId), runId, store, bundle };
}

async function publishCandidates(state: RuntimeState): Promise<void> {
  const initial = envelopesByType(
    state.bundle,
    "startup_opportunity.discovery_candidate.v1",
  ).filter((entry) => entry.document.revision === 1);
  assert.equal(initial.length, 3);
  await state.store.publishArtifactBundle({ runId: state.runId, envelopes: initial });
}

async function publishTasks(state: RuntimeState): Promise<void> {
  const tasks = envelopesByType(state.bundle, "startup_opportunity.research_task.v2");
  assert.equal(tasks.length, 2);
  await state.store.publishArtifactBundle({ runId: state.runId, envelopes: tasks });
}

async function publishMaterials(state: RuntimeState): Promise<void> {
  const materials = envelopesByType(
    state.bundle,
    "startup_opportunity.evidence.v2",
    "startup_opportunity.claim.v2",
    "startup_opportunity.finding.v2",
    "startup_opportunity.insight.v2",
    "startup_opportunity.judgment_assessment.v2",
    "startup_opportunity.source_manifest.v2",
  );
  assert.equal(materials.length, 14);
  await state.store.publishArtifactBundle({ runId: state.runId, envelopes: materials });
}

async function publishThroughMaterials(state: RuntimeState): Promise<void> {
  await publishCandidates(state);
  await publishTasks(state);
  await publishMaterials(state);
}

async function publishThroughLanes(state: RuntimeState): Promise<void> {
  await publishThroughMaterials(state);
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: envelopesByType(state.bundle, "startup_opportunity.discovery_lane_result.v1"),
  });
}

async function rewriteUnitState(
  state: RuntimeState,
  unitId: string,
  target: "failed_units" | "invalidated_units" | "superseded_units",
): Promise<void> {
  const manifestPath = path.join(state.runRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  for (const field of [
    "completed_units",
    "active_units",
    "failed_units",
    "invalidated_units",
    "skipped_units",
    "cancelled_units",
    "superseded_units",
  ]) {
    const values = manifest[field] as string[];
    manifest[field] =
      field === target
        ? [...new Set([...values, unitId])].sort()
        : values.filter((id) => id !== unitId);
  }
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
}

function terminalLane(
  state: RuntimeState,
  artifactPath: string,
  status: "partial" | "failed" | "ignored_late" | "superseded",
): FormalArtifactEnvelope {
  const envelope = clone(runtimeEnvelope(state.bundle, artifactPath));
  envelope.document.status = status;
  if (["failed", "ignored_late", "superseded"].includes(status)) {
    envelope.document.scored_candidates = [];
    envelope.document.pre_kill_decisions = [];
    envelope.document.retained_candidate_refs = [];
    envelope.document.watchlist_candidate_refs = [];
    envelope.document.rejected_candidate_refs = [];
    const diversity = envelope.document.candidate_diversity_summary as Record<string, unknown>;
    diversity.diversity_retention_refs = [];
    diversity.counterfactual_candidate_refs = [];
  }
  return {
    ...envelope,
    content_hash: canonicalContentHash(envelope.document),
  };
}

test("G2.2 selects the Manifest current Plan while retaining Plan history", async (t) => {
  const policy = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "harness/policies/discovery-candidates.v1.json"),
      "utf8",
    ),
  ) as DiscoveryCandidatePolicy;

  await t.test("accepts an additional immutable historical Plan", async () => {
    const documents = candidateContractDocuments(await createDiscoveryCandidateFixture());
    const currentPlan = documents.find((entry) => entry.path === "plans/research-plan.r1.json");
    assert.ok(currentPlan);
    documents.push({ ...clone(currentPlan), path: "plans/research-plan.r2.json" });
    assert.deepEqual(validateDiscoveryCandidateContract(documents, policy), []);
  });

  await t.test("rejects a missing Manifest-selected Plan", async () => {
    const documents = candidateContractDocuments(await createDiscoveryCandidateFixture());
    const manifest = documents.find((entry) => entry.path === "manifest.json")?.document;
    assert.ok(manifest);
    manifest.current_plan_ref = "plans/research-plan.r3.json";
    const codes = validateDiscoveryCandidateContract(documents, policy).map((issue) => issue.code);
    assert.ok(codes.includes("discovery_candidate.bundle_cardinality"), JSON.stringify(codes));
  });

  await t.test("rejects duplicate documents at the current Plan path", async () => {
    const documents = candidateContractDocuments(await createDiscoveryCandidateFixture());
    const currentPlan = documents.find((entry) => entry.path === "plans/research-plan.r1.json");
    assert.ok(currentPlan);
    documents.push(clone(currentPlan));
    const codes = validateDiscoveryCandidateContract(documents, policy).map((issue) => issue.code);
    assert.ok(codes.includes("discovery_candidate.bundle_cardinality"), JSON.stringify(codes));
  });
});

test("G2.2 publishes explicit candidates, tasks, typed lane material, pre-kill results, and fan-in", async (context) => {
  const state = await setup(context, "publication");
  await publishThroughLanes(state);

  const afterLanes = await state.store.load(state.runId);
  assert.deepEqual(afterLanes.manifest.completed_units, [
    "unit_counterfactual",
    "unit_seed_independent_demand",
  ]);
  assert.deepEqual(afterLanes.manifest.active_units, []);

  await state.store.publishArtifact({
    runId: state.runId,
    envelope: runtimeEnvelope(state.bundle, G22_DEMAND_R2),
  });
  const fanIn = runtimeEnvelope(state.bundle, G22_FAN_IN);
  const first = await state.store.publishArtifact({ runId: state.runId, envelope: fanIn });
  assert.equal(first.status, "published");
  const beforeReplay = await snapshotTree(state.runRoot);
  const replay = await state.store.publishArtifact({ runId: state.runId, envelope: fanIn });
  assert.equal(replay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(state.runRoot), beforeReplay);

  const loaded = await state.store.load(state.runId);
  assert.ok(loaded.manifest.artifact_refs.includes(G22_FAN_IN));
  assert.equal((await state.store.load(state.runId)).recovered, false);

  const receipts = await Promise.all(
    (await readdir(path.join(state.runRoot, ".store/operations")))
      .filter((filename) => filename.startsWith("artifact-"))
      .map(async (filename) =>
        JSON.parse(await readFile(path.join(state.runRoot, ".store/operations", filename), "utf8")),
      ),
  );
  const runtimeReceipts = receipts.filter((receipt) =>
    runtimeEnvelopes(state.bundle).some(
      (envelope) => envelope.artifact_path === receipt.artifact_path,
    ),
  );
  assert.ok(runtimeReceipts.length > 0);
  assert.ok(
    runtimeReceipts.every(
      (receipt) =>
        receipt.schema_version === "startup_opportunity.artifact_store_operation.current",
    ),
  );
});

test("G2.2 lane terminal states project mechanically and keep late/superseded refs non-current", async (t) => {
  for (const scenario of [
    { suffix: "partial", status: "partial", target: "completed_units", prestate: null },
    { suffix: "failed", status: "failed", target: "failed_units", prestate: null },
    {
      suffix: "ignored",
      status: "ignored_late",
      target: "ignored_late_artifact_refs",
      prestate: "invalidated_units",
    },
    {
      suffix: "superseded",
      status: "superseded",
      target: "ignored_late_artifact_refs",
      prestate: "superseded_units",
    },
  ] as const) {
    await t.test(scenario.suffix, async (context) => {
      const state = await setup(context, `status-${scenario.suffix}`);
      await publishThroughMaterials(state);
      if (scenario.prestate !== null) {
        await rewriteUnitState(state, "unit_seed_independent_demand", scenario.prestate);
        await state.store.checkpoint({
          runId: state.runId,
          checkpointId: `checkpoint_${scenario.suffix}_state`,
          createdAt: "2026-07-27T19:00:00Z",
          nextStep: "SYNTHETIC publish only an explicit terminal lane result.",
          beliefSummary: {
            current_belief: "SYNTHETIC unit state is mechanical only.",
            evidence_that_changed_belief: [],
            unchanged_assumptions: ["SYNTHETIC no validation success is claimed."],
            remaining_disagreement: ["SYNTHETIC demand remains unknown."],
            next_decision_relevant_question: "SYNTHETIC should the late result remain non-current?",
          },
          inputRefs: [],
        });
      }
      const lane = terminalLane(state, G22_GENERATION_LANE, scenario.status);
      await state.store.publishArtifact({ runId: state.runId, envelope: lane });
      const manifest = (await state.store.load(state.runId)).manifest;
      assert.ok(
        (manifest[scenario.target] as readonly string[]).includes(
          scenario.target === "ignored_late_artifact_refs"
            ? G22_GENERATION_LANE
            : "unit_seed_independent_demand",
        ),
      );
      if (scenario.target === "ignored_late_artifact_refs") {
        assert.ok(!manifest.artifact_refs.includes(G22_GENERATION_LANE));
      }
    });
  }
});

test("G2.2 rejects an illegal lane transition before writing receipt, artifact, or Manifest", async (context) => {
  const state = await setup(context, "invalid-transition");
  await publishThroughMaterials(state);
  await rewriteUnitState(state, "unit_seed_independent_demand", "failed_units");
  const before = await snapshotTree(state.runRoot);
  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: runtimeEnvelope(state.bundle, G22_GENERATION_LANE),
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.discovery_lane_transition_invalid",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), before);
});

test("G2.2 current recovery completes candidate temp writes and indexes published fan-in", async (context) => {
  const state = await setup(context, "recovery");
  await publishThroughLanes(state);
  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: runtimeEnvelope(state.bundle, G22_DEMAND_R2),
      faultAt: "after_temp_write",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const recoveredCandidate = await state.store.load(state.runId);
  assert.ok(recoveredCandidate.recoveredArtifactPaths.includes(G22_DEMAND_R2));
  assert.ok(recoveredCandidate.manifest.artifact_refs.includes(G22_DEMAND_R2));

  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: runtimeEnvelope(state.bundle, G22_FAN_IN),
      faultAt: "after_publish",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const recoveredFanIn = await state.store.load(state.runId);
  assert.ok(recoveredFanIn.manifest.artifact_refs.includes(G22_FAN_IN));
  assert.equal((await state.store.load(state.runId)).recovered, false);
});

test("generic Harness CLI and Skill script publish only caller-supplied G2.2 envelopes", async (context) => {
  const state = await setup(context, "cli-skill");
  const candidateFile = path.join(state.root, "candidate-bundle.json");
  const taskFile = path.join(state.root, "task-bundle.json");
  await writeFile(
    candidateFile,
    `${canonicalJson({
      documents: envelopesByType(state.bundle, "startup_opportunity.discovery_candidate.v1")
        .filter((entry) => entry.document.revision === 1)
        .map((document) => ({ document })),
    })}\n`,
  );
  const harness = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "publish-artifact",
      "--runs-root",
      state.runsRoot,
      "--file",
      candidateFile,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(harness.status, 0, harness.stderr || harness.stdout);
  assert.equal((JSON.parse(harness.stdout) as { status: string }).status, "published");

  await writeFile(
    taskFile,
    `${canonicalJson({
      documents: envelopesByType(state.bundle, "startup_opportunity.research_task.v2").map(
        (document) => ({ document }),
      ),
    })}\n`,
  );
  const skill = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      ".agents/skills/startup-opportunity/scripts/publish-artifact.ts",
      "--runs-root",
      state.runsRoot,
      "--file",
      taskFile,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(skill.status, 0, skill.stderr || skill.stdout);
  assert.equal((JSON.parse(skill.stdout) as { status: string }).status, "published");
  const manifest = (await state.store.load(state.runId)).manifest;
  assert.deepEqual(manifest.active_units, ["unit_counterfactual", "unit_seed_independent_demand"]);

  const discover = spawnSync(
    process.execPath,
    ["--import", "tsx", "harness/src/cli.ts", "discover"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(discover.status, 64);
  assert.match(discover.stderr, /Unknown command: discover/);
});

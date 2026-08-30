import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  artifactRefsForDocument,
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
  G21_OPPORTUNITY_REF,
  G21_PLAN_REF,
  G21_SCOPE_REF,
  G21_SOLUTION_REF,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  createDiscoveryCandidateFixture,
  G22_BASELINE_R1,
  G22_DEMAND_R1,
  G22_DEMAND_R2,
  G22_EVALUATION_LANE,
  G22_FAN_IN,
  G22_GENERATION_CLAIM,
  G22_GENERATION_LANE,
  G22_GENERATION_TASK,
  G22_PRE_CANDIDATE_RELATION,
  G22_REJECTED_PRE_CANDIDATE,
  G22_RETAINED_PRE_CANDIDATE,
  G22_RUN_ID,
  G22_SOLUTION_R1,
  G22_WATCHLIST_PRE_CANDIDATE,
  refreshDiscoveryCandidateFormation,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";
import {
  createDiscoveryRuntimeFixture,
  runtimeEnvelope,
} from "./fixtures/g2.2/discovery-runtime-fixture.js";
import { createConfirmedRun, publishInitialPlanBundle } from "./helpers/current-run.js";
import { discoveryWaveEnvelopes } from "./helpers/discovery-wave.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const planR2Ref = "plans/research-plan.r2.json";

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

function bundleWithPaths(bundle: DocumentBundle, paths: readonly string[]): DocumentBundle {
  const keep = new Set(paths);
  const cloned = structuredClone(bundle) as DocumentBundle & {
    documents: { path: string; document: Record<string, unknown> }[];
  };
  cloned.documents = cloned.documents.filter((entry) => keep.has(entry.path));
  return cloned;
}

async function discoveryCandidatePolicy(): Promise<DiscoveryCandidatePolicy> {
  return JSON.parse(
    await readFile(
      path.join(repositoryRoot, "harness/policies/discovery-candidates.current.json"),
      "utf8",
    ),
  ) as DiscoveryCandidatePolicy;
}

function cloneCandidateDocument(
  entry: DiscoveryCandidateDocument,
  pathValue: string,
  candidateIdValue: string,
): DiscoveryCandidateDocument {
  const cloned = structuredClone(entry);
  const document = {
    ...cloned.document,
    candidate_id: candidateIdValue,
  };
  const envelope =
    cloned.envelope === null
      ? null
      : {
          ...cloned.envelope,
          artifact_path: pathValue,
          content_hash: canonicalContentHash(document),
          document,
        };
  return {
    ...cloned,
    path: pathValue,
    document,
    envelope,
  };
}

function bundleWithTaskTargetCandidateRefs(
  bundle: DocumentBundle,
  taskPath: string,
  targetCandidateRefs: readonly string[],
): DocumentBundle {
  const cloned = structuredClone(bundle) as DocumentBundle & {
    documents: { path: string; document: Record<string, unknown> }[];
  };
  const taskEntry = cloned.documents.find((entry) => entry.path === taskPath);
  assert.ok(taskEntry, taskPath);
  const taskEnvelope = taskEntry.document as FormalArtifactEnvelope & {
    content_hash: string;
    document: Record<string, unknown>;
  };
  taskEnvelope.document = {
    ...taskEnvelope.document,
    target_candidate_refs: [...targetCandidateRefs],
  };
  taskEnvelope.content_hash = canonicalContentHash(taskEnvelope.document);
  return cloned;
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
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
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
      acquisitionGoal: "SYNTHETIC runtime generation substrate; not Evidence or validation.",
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
      acquisitionGoal: "SYNTHETIC runtime evaluation substrate; not Evidence or validation.",
      rawContent: "SYNTHETIC evaluation bytes; not Evidence.",
      recordedAt: "2026-07-27T17:41:00Z",
    })
  ).record;
  const bundle = await createDiscoveryRuntimeFixture(
    runId,
    { generation, evaluation },
    [],
    "general",
    true,
  );
  await publishInitialPlanBundle(
    store,
    runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  );
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
  const wave = discoveryWaveEnvelopes(
    state.bundle,
    state.runId,
    "startup_opportunity.research_task.discovery_candidate.current",
    1,
    "candidate_runtime",
  );
  assert.equal(wave.length, 4);
  await state.store.publishArtifactBundle({ runId: state.runId, envelopes: wave });
}

async function publishMaterials(state: RuntimeState): Promise<void> {
  const materials = envelopesByType(
    state.bundle,
    "startup_opportunity.evidence.discovery_candidate.current",
    "startup_opportunity.claim.discovery_candidate.current",
    "startup_opportunity.finding.discovery_candidate.current",
    "startup_opportunity.insight.discovery_candidate.current",
    "startup_opportunity.judgment_assessment.discovery_candidate.current",
    "startup_opportunity.source_manifest.discovery_candidate.current",
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

async function publishConcretePreCandidates(state: RuntimeState): Promise<void> {
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [
      runtimeEnvelope(state.bundle, G22_DEMAND_R2),
      runtimeEnvelope(state.bundle, G22_RETAINED_PRE_CANDIDATE),
      runtimeEnvelope(state.bundle, G22_WATCHLIST_PRE_CANDIDATE),
      runtimeEnvelope(state.bundle, G22_REJECTED_PRE_CANDIDATE),
      runtimeEnvelope(state.bundle, G22_PRE_CANDIDATE_RELATION),
    ],
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
      path.join(repositoryRoot, "harness/policies/discovery-candidates.current.json"),
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

function historicalPlanRevisionBundle(bundle: DocumentBundle) {
  const documentBundle = structuredClone(bundle) as DocumentBundle & {
    documents: { path: string; document: Record<string, unknown> }[];
  };
  const manifest = documentBundle.documents.find((entry) => entry.path === "manifest.json")
    ?.document as Record<string, unknown> | undefined;
  const planR1Entry = documentBundle.documents.find((entry) => entry.path === G21_PLAN_REF);
  assert.ok(manifest);
  assert.ok(planR1Entry);
  const planR2Entry = {
    ...structuredClone(planR1Entry),
    path: planR2Ref,
  } as {
    path: string;
    document: FormalArtifactEnvelope & {
      artifact_path: string;
      content_hash: string;
      document: Record<string, unknown>;
    };
  };
  const planR2Envelope = planR2Entry.document;
  planR2Envelope.artifact_path = planR2Entry.path;
  planR2Envelope.document = {
    ...(planR2Envelope.document as Record<string, unknown>),
    revision: 2,
    parent_plan_ref: G21_PLAN_REF,
    triggered_by_adaptation_refs: ["adaptations/decisions/adapt-empty-generation-retry.json"],
  };
  planR2Envelope.content_hash = canonicalContentHash(planR2Envelope.document);
  documentBundle.documents.push(planR2Entry);
  manifest.current_plan_ref = planR2Entry.path;
  manifest.plan_revision = 2;
  return {
    documentBundle,
    planR1Hash: (planR1Entry.document as FormalArtifactEnvelope).content_hash,
  };
}
test("historical candidate bindings require exact candidate membership", async () => {
  const bundle = await createDiscoveryCandidateFixture();
  const { documentBundle: historicalBundle, planR1Hash } = historicalPlanRevisionBundle(bundle);
  const documentBundle = bundleWithPaths(historicalBundle, [
    "manifest.json",
    G21_SCOPE_REF,
    G21_PLAN_REF,
    planR2Ref,
    G21_OPPORTUNITY_REF,
    G21_SOLUTION_REF,
    G22_DEMAND_R1,
    G22_BASELINE_R1,
    G22_SOLUTION_R1,
  ]);
  const exactBinding = {
    planRef: G21_PLAN_REF,
    planHash: planR1Hash,
    planRevision: 1,
    candidateRefs: [G22_DEMAND_R1, G22_BASELINE_R1, G22_SOLUTION_R1],
  };
  const policy = await discoveryCandidatePolicy();
  const exactIssues = validateDiscoveryCandidateContract(
    candidateContractDocuments(documentBundle),
    policy,
    [exactBinding],
  );
  assert.deepEqual(exactIssues, []);

  const outsiderSource = candidateContractDocuments(bundle).find(
    (entry) => entry.path === G22_DEMAND_R1,
  );
  assert.ok(outsiderSource);
  const outsider = cloneCandidateDocument(
    outsiderSource,
    "artifacts/discovery/candidates/candidate_neutralized.r1.json",
    "candidate_neutralized",
  );
  const outsiderBundle = structuredClone(documentBundle) as typeof documentBundle & {
    documents: { path: string; document: Record<string, unknown> }[];
  };
  outsiderBundle.documents.push({
    path: outsider.path,
    document: outsider.envelope ?? outsider.document,
  });
  const rejected = validateDiscoveryCandidateContract(
    candidateContractDocuments(outsiderBundle),
    policy,
    [exactBinding],
  );
  assert.ok(
    rejected.some(
      (issue) =>
        issue.code === "discovery_candidate.scope_identity_mismatch" &&
        issue.instancePath === outsider.path,
    ),
    JSON.stringify(rejected, null, 2),
  );
});

test("candidate-neutral generation retries authorize the exact generation task only", async () => {
  const bundle = await createDiscoveryCandidateFixture();
  const { documentBundle, planR1Hash } = historicalPlanRevisionBundle(bundle);
  const generationTaskEntry = documentBundle.documents.find(
    (entry) => entry.path === G22_GENERATION_TASK,
  );
  assert.ok(generationTaskEntry);
  const generationTaskEnvelope = generationTaskEntry.document as FormalArtifactEnvelope & {
    document: Record<string, unknown>;
  };
  generationTaskEnvelope.document = {
    ...(generationTaskEnvelope.document as Record<string, unknown>),
    required_artifact_schema: "startup_opportunity.discovery_generation_result.v1",
    allowed_output_path: "artifacts/discovery/generation/unit_seed_independent_demand.r1.json",
    target_candidate_refs: [],
    input_refs: [G21_SCOPE_REF],
  };
  (generationTaskEntry.document as { content_hash: string }).content_hash = canonicalContentHash(
    generationTaskEnvelope.document,
  );
  const generationBundle = bundleWithPaths(documentBundle, [
    "manifest.json",
    G21_SCOPE_REF,
    G21_PLAN_REF,
    planR2Ref,
    G21_OPPORTUNITY_REF,
    G22_GENERATION_TASK,
  ]);
  const generationBinding = {
    planRef: G21_PLAN_REF,
    planHash: planR1Hash,
    planRevision: 1,
    candidateRefs: [],
    generationTaskRefs: [G22_GENERATION_TASK],
  };
  const policy = await discoveryCandidatePolicy();
  const exactIssues = validateDiscoveryCandidateContract(
    candidateContractDocuments(generationBundle),
    policy,
    [generationBinding],
  );
  assert.deepEqual(exactIssues, []);

  const wrongPlanBinding = {
    ...generationBinding,
    planRef: "plans/research-plan.r0.json",
  };
  const wrongPlanIssues = validateDiscoveryCandidateContract(
    candidateContractDocuments(generationBundle),
    policy,
    [wrongPlanBinding],
  );
  assert.ok(
    wrongPlanIssues.some(
      (issue) =>
        issue.code === "discovery_candidate.task_binding_mismatch" &&
        issue.instancePath === G22_GENERATION_TASK,
    ),
    JSON.stringify(wrongPlanIssues, null, 2),
  );

  const outsiderSource = candidateContractDocuments(bundle).find(
    (entry) => entry.path === G22_DEMAND_R1,
  );
  assert.ok(outsiderSource);
  const outsider = cloneCandidateDocument(
    outsiderSource,
    "artifacts/discovery/candidates/candidate_neutralized.r1.json",
    "candidate_neutralized",
  );
  const candidateBundle = structuredClone(generationBundle) as typeof generationBundle & {
    documents: { path: string; document: Record<string, unknown> }[];
  };
  candidateBundle.documents.push({
    path: outsider.path,
    document: outsider.envelope ?? outsider.document,
  });
  const rejected = validateDiscoveryCandidateContract(
    candidateContractDocuments(candidateBundle),
    policy,
    [generationBinding],
  );
  assert.ok(
    rejected.some(
      (issue) =>
        issue.code === "discovery_candidate.scope_identity_mismatch" &&
        issue.instancePath === outsider.path,
    ),
    JSON.stringify(rejected, null, 2),
  );
});

test("historical task bindings authorize candidate subsets and reject non-members", async () => {
  const bundle = await createDiscoveryCandidateFixture();
  const { documentBundle: historicalBundle, planR1Hash } = historicalPlanRevisionBundle(bundle);
  const exactBinding = {
    planRef: G21_PLAN_REF,
    planHash: planR1Hash,
    planRevision: 1,
    candidateRefs: [G22_DEMAND_R1, G22_BASELINE_R1, G22_SOLUTION_R1],
  };
  const taskBundle = bundleWithPaths(historicalBundle, [
    "manifest.json",
    G21_SCOPE_REF,
    G21_PLAN_REF,
    planR2Ref,
    G21_OPPORTUNITY_REF,
    G21_SOLUTION_REF,
    G22_DEMAND_R1,
    G22_BASELINE_R1,
    G22_SOLUTION_R1,
    G22_GENERATION_TASK,
  ]);
  const policy = await discoveryCandidatePolicy();
  const exactIssues = validateDiscoveryCandidateContract(
    candidateContractDocuments(taskBundle),
    policy,
    [exactBinding],
  );
  assert.deepEqual(exactIssues, []);

  const singleCandidateTaskBundle = bundleWithTaskTargetCandidateRefs(
    taskBundle,
    G22_GENERATION_TASK,
    [G22_DEMAND_R1],
  );
  const singleCandidateIssues = validateDiscoveryCandidateContract(
    candidateContractDocuments(singleCandidateTaskBundle),
    policy,
    [exactBinding],
  );
  assert.deepEqual(singleCandidateIssues, []);

  const subsetTaskBundle = bundleWithTaskTargetCandidateRefs(taskBundle, G22_GENERATION_TASK, [
    G22_DEMAND_R1,
    G22_BASELINE_R1,
  ]);
  const subsetIssues = validateDiscoveryCandidateContract(
    candidateContractDocuments(subsetTaskBundle),
    policy,
    [exactBinding],
  );
  assert.deepEqual(subsetIssues, []);

  const outsiderSource = candidateContractDocuments(bundle).find(
    (entry) => entry.path === G22_DEMAND_R1,
  );
  assert.ok(outsiderSource);
  const outsider = cloneCandidateDocument(
    outsiderSource,
    "artifacts/discovery/candidates/candidate_task_unbound.r1.json",
    "candidate_task_unbound",
  );
  const nonMemberTaskBundle = bundleWithTaskTargetCandidateRefs(taskBundle, G22_GENERATION_TASK, [
    G22_DEMAND_R1,
    outsider.path,
  ]) as typeof taskBundle & {
    documents: { path: string; document: Record<string, unknown> }[];
  };
  nonMemberTaskBundle.documents.push({
    path: outsider.path,
    document: outsider.envelope ?? outsider.document,
  });
  const nonMemberRejected = validateDiscoveryCandidateContract(
    candidateContractDocuments(nonMemberTaskBundle),
    policy,
    [exactBinding],
  );
  assert.ok(
    nonMemberRejected.some(
      (issue) =>
        issue.code === "discovery_candidate.task_binding_mismatch" &&
        issue.instancePath === G22_GENERATION_TASK,
    ),
    JSON.stringify(nonMemberRejected, null, 2),
  );

  const crossPlanCandidate = cloneCandidateDocument(
    outsiderSource,
    "artifacts/discovery/candidates/candidate_task_cross_plan.r1.json",
    "candidate_task_cross_plan",
  );
  crossPlanCandidate.document.research_plan_ref = planR2Ref;
  if (crossPlanCandidate.envelope !== null) {
    crossPlanCandidate.envelope.document = crossPlanCandidate.document;
    crossPlanCandidate.envelope.content_hash = canonicalContentHash(crossPlanCandidate.document);
  }
  const crossPlanTaskBundle = bundleWithTaskTargetCandidateRefs(taskBundle, G22_GENERATION_TASK, [
    G22_DEMAND_R1,
    crossPlanCandidate.path,
  ]) as typeof taskBundle & {
    documents: { path: string; document: Record<string, unknown> }[];
  };
  crossPlanTaskBundle.documents.push({
    path: crossPlanCandidate.path,
    document: crossPlanCandidate.envelope ?? crossPlanCandidate.document,
  });
  const crossPlanRejected = validateDiscoveryCandidateContract(
    candidateContractDocuments(crossPlanTaskBundle),
    policy,
    [
      {
        ...exactBinding,
        candidateRefs: [...exactBinding.candidateRefs, crossPlanCandidate.path],
      },
    ],
  );
  assert.ok(
    crossPlanRejected.some(
      (issue) =>
        issue.code === "discovery_candidate.task_binding_mismatch" &&
        issue.instancePath === G22_GENERATION_TASK,
    ),
    JSON.stringify(crossPlanRejected, null, 2),
  );
});

test("G2.2 Candidate formation closes current Scope, Plan, synthesis inputs, and prior admission", async () => {
  const policy = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "harness/policies/discovery-candidates.current.json"),
      "utf8",
    ),
  ) as DiscoveryCandidatePolicy;
  const bundle = await createDiscoveryCandidateFixture();
  const documents = candidateContractDocuments(bundle);
  const candidate = documents.find((entry) => entry.path === G22_DEMAND_R1);
  assert.ok(candidate?.envelope);
  const formation = candidate.document.formation as Record<string, unknown>;

  formation.scope_frame_hash = `sha256:${"8".repeat(64)}`;
  candidate.envelope.content_hash = canonicalContentHash(candidate.document);
  assert.ok(
    validateDiscoveryCandidateContract(documents, policy).some(
      (issue) => issue.code === "discovery_candidate.formation_scope_plan_mismatch",
    ),
  );

  const refreshed = await createDiscoveryCandidateFixture();
  const priorDocuments = candidateContractDocuments(refreshed);
  const priorCandidate = priorDocuments.find((entry) => entry.path === G22_DEMAND_R1);
  assert.ok(priorCandidate?.envelope);
  const priorFormation = priorCandidate.document.formation as Record<string, unknown>;
  const decisionRef = "decisions.jsonl#prior_input_admitted_g2_2_fixture";
  priorFormation.synthesis_origin = "prior_informed_synthesis";
  priorFormation.prior_input_decision_refs = [decisionRef];
  priorCandidate.envelope.content_hash = canonicalContentHash(priorCandidate.document);
  assert.ok(
    artifactRefsForDocument({
      path: priorCandidate.path,
      document: priorCandidate.envelope,
    }).includes(decisionRef),
  );

  assert.ok(
    validateDiscoveryCandidateContract(priorDocuments, policy).some(
      (issue) => issue.code === "discovery_candidate.prior_input_admission_invalid",
    ),
  );
  const admission = {
    schema_version: "startup_opportunity.decision.v1",
    decision_id: "prior_input_admitted_g2_2_fixture",
    run_id: G22_RUN_ID,
    decision_type: "prior_input_admitted",
    timestamp: "2026-07-27T17:00:00Z",
    actor: "main_agent",
    reason: "SYNTHETIC prior Candidate admitted only as a hypothesis input.",
    artifact_refs: [],
    prior_input_id: "prior_candidate_hypothesis_g2_2_fixture",
    prior_source_run_id: "g2-2-prior-synthetic",
    prior_source_artifact_path: "artifacts/discovery/candidates/prior.r1.json",
    prior_source_content_hash: `sha256:${"7".repeat(64)}`,
    prior_input_consumer: "discovery_candidates",
    prior_target_artifact_path: G22_DEMAND_R1,
    prior_use_boundary: "hypothesis_input_only",
  };
  const unlabelledCopy = await createDiscoveryCandidateFixture();
  assert.ok(
    validateDiscoveryCandidateContract(
      candidateContractDocuments(unlabelledCopy),
      policy,
      [],
      new Map([[decisionRef, admission]]),
    ).some((issue) => issue.code === "discovery_candidate.prior_input_target_not_propagated"),
  );
  assert.equal(
    validateDiscoveryCandidateContract(
      priorDocuments,
      policy,
      [],
      new Map([[decisionRef, admission]]),
    ).some((issue) =>
      [
        "discovery_candidate.prior_input_admission_invalid",
        "discovery_candidate.prior_input_target_not_propagated",
      ].includes(issue.code),
    ),
    false,
  );

  const foreignInput = structuredClone(priorDocuments);
  const foreignMap = foreignInput.find((entry) => entry.path === G21_OPPORTUNITY_REF);
  const foreignCandidate = foreignInput.find((entry) => entry.path === G22_DEMAND_R1);
  assert.ok(foreignMap?.envelope && foreignCandidate?.envelope);
  foreignMap.document.run_id = "g2-2-foreign-synthetic";
  foreignMap.envelope.content_hash = canonicalContentHash(foreignMap.document);
  const foreignFormation = foreignCandidate.document.formation as Record<string, unknown>;
  const bindings = foreignFormation.synthesis_input_hashes as Record<string, unknown>[];
  const mapBinding = bindings.find((binding) => binding.ref === foreignMap.path);
  assert.ok(mapBinding);
  mapBinding.content_hash = foreignMap.envelope.content_hash;
  foreignCandidate.envelope.content_hash = canonicalContentHash(foreignCandidate.document);
  assert.ok(
    validateDiscoveryCandidateContract(foreignInput, policy).some(
      (issue) => issue.code === "discovery_candidate.formation_input_binding_mismatch",
    ),
  );

  const inheritedBundle = await createDiscoveryCandidateFixture();
  const inheritedMapEnvelope = fixtureEnvelope(inheritedBundle, G21_OPPORTUNITY_REF);
  const inheritedMap = inheritedMapEnvelope.document;
  const inheritedProvenance = inheritedMap.content_provenance as Record<string, unknown>;
  inheritedProvenance.synthesis_origin = "prior_informed_synthesis";
  inheritedProvenance.prior_input_decision_refs = [decisionRef];
  (inheritedMapEnvelope as unknown as { content_hash: string }).content_hash =
    canonicalContentHash(inheritedMap);
  const inheritedSolutionEnvelope = fixtureEnvelope(inheritedBundle, G21_SOLUTION_REF);
  const inheritedSolutionProvenance = inheritedSolutionEnvelope.document
    .content_provenance as Record<string, unknown>;
  inheritedSolutionProvenance.synthesis_origin = "prior_informed_synthesis";
  inheritedSolutionProvenance.prior_input_decision_refs = [decisionRef];
  (inheritedSolutionEnvelope as unknown as { content_hash: string }).content_hash =
    canonicalContentHash(inheritedSolutionEnvelope.document);
  for (const entry of candidateContractDocuments(inheritedBundle).filter(
    (entry) => entry.schemaVersion === "startup_opportunity.discovery_candidate.v1",
  )) {
    const candidateFormation = entry.document.formation as Record<string, unknown>;
    if (entry.path !== G22_BASELINE_R1) {
      candidateFormation.synthesis_origin = "prior_informed_synthesis";
      candidateFormation.prior_input_decision_refs = [decisionRef];
    }
  }
  refreshDiscoveryCandidateFormation(inheritedBundle);
  const inheritedDocuments = candidateContractDocuments(inheritedBundle);
  assert.ok(
    validateDiscoveryCandidateContract(
      inheritedDocuments,
      policy,
      [],
      new Map([[decisionRef, admission]]),
    ).some((issue) => issue.code === "discovery_candidate.prior_input_provenance_not_propagated"),
  );

  const inheritedBaseline = inheritedDocuments.find((entry) => entry.path === G22_BASELINE_R1);
  assert.ok(inheritedBaseline?.envelope);
  const inheritedBaselineFormation = inheritedBaseline.document.formation as Record<
    string,
    unknown
  >;
  inheritedBaselineFormation.synthesis_origin = "prior_informed_synthesis";
  inheritedBaselineFormation.prior_input_decision_refs = [decisionRef];
  inheritedBaseline.envelope.content_hash = canonicalContentHash(inheritedBaseline.document);
  assert.equal(
    validateDiscoveryCandidateContract(
      inheritedDocuments,
      policy,
      [],
      new Map([[decisionRef, admission]]),
    ).some((issue) => issue.code === "discovery_candidate.prior_input_provenance_not_propagated"),
    false,
  );
});

test("G2.2 fan-in fails closed when a current concrete pre-candidate is omitted", async () => {
  const policy = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "harness/policies/discovery-candidates.current.json"),
      "utf8",
    ),
  ) as DiscoveryCandidatePolicy;
  const bundle = await createDiscoveryCandidateFixture();
  const relationEnvelope = fixtureEnvelope(bundle, G22_PRE_CANDIDATE_RELATION);
  const relation = relationEnvelope.document;
  relation.result_candidate_bindings = (
    relation.result_candidate_bindings as Record<string, unknown>[]
  ).filter((binding) => binding.ref !== G22_WATCHLIST_PRE_CANDIDATE);
  (relationEnvelope as unknown as { input_refs: string[] }).input_refs =
    relationEnvelope.input_refs.filter((ref) => ref !== G22_WATCHLIST_PRE_CANDIDATE);
  (relationEnvelope as unknown as { content_hash: string }).content_hash =
    canonicalContentHash(relation);

  const fanInEnvelope = fixtureEnvelope(bundle, G22_FAN_IN);
  const fanIn = fanInEnvelope.document;
  fanIn.materialized_pre_candidate_refs = (
    fanIn.materialized_pre_candidate_refs as string[]
  ).filter((ref) => ref !== G22_WATCHLIST_PRE_CANDIDATE);
  fanIn.pre_candidate_dispositions = (
    fanIn.pre_candidate_dispositions as Record<string, unknown>[]
  ).filter((entry) => entry.pre_candidate_ref !== G22_WATCHLIST_PRE_CANDIDATE);
  fanIn.watchlist_pre_candidate_refs = [];
  const diversity = fanIn.candidate_diversity_summary as Record<string, unknown>;
  diversity.pre_candidate_diversity_retention_refs = [G22_RETAINED_PRE_CANDIDATE];
  diversity.counterfactual_pre_candidate_refs = [G22_RETAINED_PRE_CANDIDATE];
  (fanInEnvelope as unknown as { input_refs: string[] }).input_refs =
    fanInEnvelope.input_refs.filter((ref) => ref !== G22_WATCHLIST_PRE_CANDIDATE);
  (fanInEnvelope as unknown as { content_hash: string }).content_hash = canonicalContentHash(fanIn);

  const codes = validateDiscoveryCandidateContract(candidateContractDocuments(bundle), policy).map(
    (issue) => issue.code,
  );
  assert.ok(
    codes.includes("discovery_candidate.fan_in_materialized_pre_candidate_closure_mismatch"),
    JSON.stringify(codes),
  );
});

test("Store rejects an admitted prior Candidate relabelled as unmarked current discovery", async (context) => {
  const state = await setup(context, "prior-candidate-copy");
  const sourceRunId = "g2-2-prior-candidate-copy-source";
  const sourceArtifactPath = "prior-candidate.json";
  await state.store.create({
    runId: sourceRunId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic prior market",
      customerModel: "b2c",
      targetUsers: ["synthetic prior user"],
      decisionGoal: "SYNTHETIC prior Candidate source only",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-27T16:00:00Z",
  });
  await writeFile(
    path.join(state.runsRoot, sourceRunId, sourceArtifactPath),
    '{"run_id":"prior-run","candidate_id":"copied","body":"OLD CANDIDATE SEMANTICS"}\n',
  );
  const admission = await state.store.admitPriorInput({
    runId: state.runId,
    priorInputId: "prior_candidate_copy_hypothesis",
    sourceRunId,
    sourceArtifactPath,
    targetArtifactPath: G22_DEMAND_R1,
    consumer: "discovery_candidates",
    reason: "SYNTHETIC prior Candidate may be used only as a labelled hypothesis input.",
    admittedAt: "2026-07-27T17:42:00Z",
  });
  assert.equal(admission.useBoundary, "hypothesis_input_only");

  await assert.rejects(
    publishCandidates(state),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "artifact.reference_invalid" &&
      JSON.stringify(error.details).includes(
        "discovery_candidate.prior_input_target_not_propagated",
      ),
  );
  assert.equal(
    (await state.store.status(state.runId)).manifest.artifact_refs.includes(G22_DEMAND_R1),
    false,
  );

  await state.store.readPriorInput({
    runId: state.runId,
    admissionRef: admission.decisionRef,
    consumedAt: "2026-07-27T17:43:00Z",
  });
  const admittedTarget = runtimeEnvelope(state.bundle, G22_DEMAND_R1);
  const admittedFormation = admittedTarget.document.formation as Record<string, unknown>;
  admittedFormation.synthesis_origin = "prior_informed_synthesis";
  admittedFormation.prior_input_decision_refs = [admission.decisionRef];
  (admittedTarget as unknown as { input_refs: string[] }).input_refs = [
    ...new Set([...admittedTarget.input_refs, admission.decisionRef]),
  ].sort();
  (admittedTarget as { content_hash: string }).content_hash = canonicalContentHash(
    admittedTarget.document,
  );
  await assert.rejects(
    publishCandidates(state),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "artifact.reference_invalid" &&
      JSON.stringify(error.details).includes(
        "discovery_candidate.prior_input_provenance_not_propagated",
      ),
  );
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

  await publishConcretePreCandidates(state);
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

test("Store re-forms a terminal Candidate only from post-terminal causal inputs and reopens exactly", async (context) => {
  const state = await setup(context, "subject-reformation");
  (runtimeEnvelope(state.bundle, G22_GENERATION_CLAIM) as { created_at: string }).created_at =
    "2026-07-27T18:06:30Z";
  await publishThroughMaterials(state);
  const scope = runtimeEnvelope(state.bundle, G21_SCOPE_REF);
  const plan = runtimeEnvelope(state.bundle, G21_PLAN_REF);
  const demandR1 = runtimeEnvelope(state.bundle, G22_DEMAND_R1);
  const snapshotR1Ref = "artifacts/reporting/decision-subject-snapshot.r1.json";
  const snapshotR1Document = {
    schema_version: "startup_opportunity.decision_subject_snapshot.current",
    snapshot_id: "decision_subjects_subject_reformation",
    revision: 1,
    parent_snapshot_ref: null,
    parent_snapshot_hash: null,
    run_id: state.runId,
    mode: "opportunity_discovery",
    scope_frame_ref: scope.artifact_path,
    scope_frame_hash: scope.content_hash,
    research_plan_ref: plan.artifact_path,
    research_plan_hash: plan.content_hash,
    synthesis_input_hashes: [{ ref: demandR1.artifact_path, content_hash: demandR1.content_hash }],
    created_at: "2026-07-27T18:05:00Z",
    subjects: [
      {
        subject_id: demandR1.document.candidate_id,
        subject_ref: demandR1.artifact_path,
        subject_content_hash: demandR1.content_hash,
        subject_kind: "discovery_candidate",
        lifecycle_status: "dropped",
        reporting_role: "audit_only",
        superseded_by_subject_id: null,
        formation_reason: "SYNTHETIC initial current-Run formation.",
        lifecycle_reason: "SYNTHETIC terminal lifecycle state before new inputs.",
      },
    ],
    limitations: ["SYNTHETIC lifecycle fixture; not market Evidence."],
  };
  const snapshotR1: FormalArtifactEnvelope = {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: "startup_opportunity.decision_subject_snapshot.current",
    artifact_path: snapshotR1Ref,
    run_id: state.runId,
    created_at: "2026-07-27T18:05:00Z",
    producer_role: "main_agent",
    input_refs: [scope.artifact_path, plan.artifact_path, demandR1.artifact_path].sort(),
    content_hash: canonicalContentHash(snapshotR1Document),
    document: snapshotR1Document,
  };
  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: snapshotR1,
      faultAt: "after_publish",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );

  const laneInputs = [G22_GENERATION_LANE, G22_EVALUATION_LANE].map((ref) => {
    const envelope = clone(runtimeEnvelope(state.bundle, ref));
    (envelope as { created_at: string }).created_at = "2026-07-27T18:06:00Z";
    return envelope;
  });
  const [firstLaneInput, secondLaneInput] = laneInputs;
  assert.ok(firstLaneInput);
  assert.ok(secondLaneInput);
  await assert.rejects(
    state.store.publishArtifact({ runId: state.runId, envelope: firstLaneInput }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "recovery.publication_commit_required",
  );
  const recoveredTerminal = await state.store.load(state.runId);
  assert.ok(recoveredTerminal.manifest.artifact_refs.includes(snapshotR1Ref));

  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: firstLaneInput,
      faultAt: "after_temp_write",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  await state.store.publishArtifact({ runId: state.runId, envelope: secondLaneInput });
  await state.store.publishArtifact({ runId: state.runId, envelope: firstLaneInput });
  const reformedCandidate = clone(runtimeEnvelope(state.bundle, G22_DEMAND_R2));
  (reformedCandidate as { created_at: string }).created_at = "2026-07-27T18:07:00Z";
  const reformedSubject = reformedCandidate.document.subject as Record<string, unknown>;
  reformedSubject.job_to_be_done =
    "SYNTHETIC newly bounded household handoff job from post-terminal lane inputs.";
  const enrichment = reformedCandidate.document.enrichment as Record<string, unknown>;
  enrichment.changed_fields = [...(enrichment.changed_fields as string[]), "subject"].sort();
  (reformedCandidate as { content_hash: string }).content_hash = canonicalContentHash(
    reformedCandidate.document,
  );
  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: reformedCandidate,
      faultAt: "after_publish",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );

  const reformInput = {
    runId: state.runId,
    terminalSnapshotRef: snapshotR1Ref,
    terminalSubjectId: String(demandR1.document.candidate_id),
    reformedSubjectRef: reformedCandidate.artifact_path,
    reason: "SYNTHETIC post-terminal lane results caused a materially new subject revision.",
    reformedAt: "2026-07-27T18:08:00Z",
  } as const;
  await assert.rejects(
    state.store.reformDecisionSubject({
      ...reformInput,
      reformationInputRefs: [G22_GENERATION_LANE, G22_EVALUATION_LANE],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "subject_reformation.artifact_unpublished",
  );
  const recoveredSubject = await state.store.load(state.runId);
  assert.ok(recoveredSubject.manifest.artifact_refs.includes(reformedCandidate.artifact_path));
  await assert.rejects(
    state.store.reformDecisionSubject({
      ...reformInput,
      reformedSubjectRef: demandR1.artifact_path,
      reformationInputRefs: [G22_GENERATION_LANE],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "subject_reformation.revision_lineage_invalid",
  );
  await assert.rejects(
    state.store.reformDecisionSubject({
      ...reformInput,
      reformationInputRefs: [reformedCandidate.artifact_path],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "subject_reformation.input_unrelated",
  );
  await assert.rejects(
    state.store.reformDecisionSubject({
      ...reformInput,
      reformationInputRefs: [G21_SOLUTION_REF],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "subject_reformation.input_unrelated",
  );
  await assert.rejects(
    state.store.reformDecisionSubject({
      ...reformInput,
      reformationInputRefs: [G22_GENERATION_CLAIM],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "subject_reformation.input_not_post_terminal",
  );
  const reformation = await state.store.reformDecisionSubject({
    ...reformInput,
    reformationInputRefs: [G22_GENERATION_LANE, G22_EVALUATION_LANE],
  });
  assert.equal(reformation.status, "appended");

  const snapshotR2Ref = "artifacts/reporting/decision-subject-snapshot.r2.json";
  const snapshotR2Document = {
    ...structuredClone(snapshotR1Document),
    revision: 2,
    parent_snapshot_ref: snapshotR1Ref,
    parent_snapshot_hash: snapshotR1.content_hash,
    synthesis_input_hashes: [
      { ref: reformedCandidate.artifact_path, content_hash: reformedCandidate.content_hash },
    ],
    created_at: "2026-07-27T18:09:00Z",
    subjects: [
      {
        ...(structuredClone(snapshotR1Document.subjects) as Record<string, unknown>[])[0],
        subject_ref: reformedCandidate.artifact_path,
        subject_content_hash: reformedCandidate.content_hash,
        lifecycle_status: "current",
        reporting_role: "final",
        reformation_decision_ref: reformation.decisionRef,
        lifecycle_reason: "SYNTHETIC causally re-formed after new lane inputs.",
      },
    ],
  };
  const snapshotR2: FormalArtifactEnvelope = {
    ...snapshotR1,
    artifact_path: snapshotR2Ref,
    created_at: "2026-07-27T18:09:00Z",
    input_refs: [
      snapshotR1Ref,
      scope.artifact_path,
      plan.artifact_path,
      reformedCandidate.artifact_path,
      reformation.decisionRef,
    ].sort(),
    content_hash: canonicalContentHash(snapshotR2Document),
    document: snapshotR2Document,
  };
  await state.store.publishArtifact({ runId: state.runId, envelope: snapshotR2 });
  await state.store.checkpoint({
    runId: state.runId,
    checkpointId: "checkpoint_subject_reformation",
    createdAt: "2026-07-27T18:10:00Z",
    nextStep: "SYNTHETIC continue from the exact re-formed subject authority.",
    beliefSummary: {
      current_belief: "SYNTHETIC subject was re-formed from post-terminal inputs.",
      evidence_that_changed_belief: [G22_GENERATION_LANE, G22_EVALUATION_LANE],
      unchanged_assumptions: ["No market validation is claimed."],
      remaining_disagreement: ["Actual demand remains unknown."],
      next_decision_relevant_question: "What current Evidence would test the new subject?",
    },
    inputRefs: [snapshotR2Ref, reformation.decisionRef],
  });
  const reopened = await new RunStore(
    state.runsRoot,
    await createArtifactValidator(repositoryRoot),
  ).load(state.runId);
  assert.equal(reopened.manifest.current_decision_subject_snapshot_ref, snapshotR2Ref);
  assert.equal(reopened.manifest.current_decision_subject_snapshot_hash, snapshotR2.content_hash);
  assert.equal(reopened.recovered, false);
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
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [
      runtimeEnvelope(state.bundle, G22_RETAINED_PRE_CANDIDATE),
      runtimeEnvelope(state.bundle, G22_WATCHLIST_PRE_CANDIDATE),
      runtimeEnvelope(state.bundle, G22_REJECTED_PRE_CANDIDATE),
      runtimeEnvelope(state.bundle, G22_PRE_CANDIDATE_RELATION),
    ],
  });

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
      documents: discoveryWaveEnvelopes(
        state.bundle,
        state.runId,
        "startup_opportunity.research_task.discovery_candidate.current",
        1,
        "candidate_runtime",
      ).map((document) => ({ document })),
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

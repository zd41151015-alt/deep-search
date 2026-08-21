import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  artifactRefsForDocument,
  buildArtifactScaffold,
  canonicalContentHash,
  canonicalJson,
  createArtifactValidator,
  DeclarativeRuntimeCompiler,
  type DiscoveryMapDocument,
  type DiscoveryProfile,
  type DocumentBundle,
  discoveryMapEnvelopeInputRefs,
  type FormalArtifactEnvelope,
  type LoadedDiscoveryMapsPolicy,
  RunStore,
  StoreError,
  validateDiscoveryMapsContract,
} from "../harness/src/index.js";
import { formalArtifactFragmentExists } from "../harness/src/validators/artifact-ref-resolver.js";
import {
  createDiscoveryMapsFixture,
  fixtureDocument,
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
  G21_OPPORTUNITY_REF,
  G21_PLAN_REF,
  G21_SCOPE_REF,
  G21_SEED_REF,
  G21_SOLUTION_REF,
  refreshDiscoveryMapsBundle,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import { createConfirmedRun, publishInitialPlanBundle } from "./helpers/current-run.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const caseCatalogPath = path.join(repositoryRoot, "tests/fixtures/g2.1/discovery-map-cases.json");
const interMapCrashWorkerPath = path.join(
  repositoryRoot,
  "tests/fixtures/g2.1/inter-map-crash-worker.ts",
);

interface SyntheticCase {
  readonly case_id: string;
  readonly expected_code: string;
}

interface SyntheticCaseCatalog {
  readonly schema_version: string;
  readonly fixture_classification: string;
  readonly public_identifiers: readonly string[];
  readonly user_material_refs: readonly string[];
  readonly cases: readonly SyntheticCase[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function envelopeRecord(bundle: DocumentBundle, artifactPath: string): Record<string, unknown> {
  return fixtureEnvelope(bundle, artifactPath) as Record<string, unknown>;
}

function rehashEnvelope(bundle: DocumentBundle, artifactPath: string): void {
  const value = envelopeRecord(bundle, artifactPath);
  value.input_refs = discoveryMapEnvelopeInputRefs(value.document as Record<string, unknown>);
  value.content_hash = canonicalContentHash(value.document);
}

function allCodes(bundle: DocumentBundle): Promise<readonly string[]> {
  return createArtifactValidator(repositoryRoot).then((validator) => {
    const result = validator.validateDocumentBundle(bundle);
    return [
      ...result.bundleErrors,
      ...result.documents.flatMap((document) => document.errors),
      ...result.referenceErrors,
    ].map((issue) => issue.code);
  });
}

function planUnits(bundle: DocumentBundle): Record<string, unknown>[] {
  const plan = fixtureDocument(bundle, G21_PLAN_REF);
  return (plan.waves as Record<string, unknown>[]).flatMap(
    (wave) => wave.units as Record<string, unknown>[],
  );
}

test("G2.1 exposes semantic map fragments to the shared reference resolver", async () => {
  const bundle = await createDiscoveryMapsFixture("general");
  const opportunity = fixtureDocument(bundle, G21_OPPORTUNITY_REF);
  const solution = fixtureDocument(bundle, G21_SOLUTION_REF);
  const demand = (opportunity.initial_demand_hypotheses as Record<string, unknown>[])[0];
  const solutionCandidate = (solution.solution_candidates as Record<string, unknown>[])[0];

  assert.equal(
    formalArtifactFragmentExists(
      {
        schemaVersion: "startup_opportunity.opportunity_space_map.v1",
        document: opportunity,
      },
      String(demand?.hypothesis_id),
    ),
    true,
  );
  assert.equal(
    formalArtifactFragmentExists(
      {
        schemaVersion: "startup_opportunity.solution_space_map.v1",
        document: solution,
      },
      String(solutionCandidate?.candidate_id),
      "candidate_id",
    ),
    true,
  );
  assert.equal(
    formalArtifactFragmentExists(
      {
        schemaVersion: "startup_opportunity.opportunity_space_map.v1",
        document: opportunity,
      },
      String(demand?.hypothesis_id),
      "candidate_id",
    ),
    false,
  );
});

function discoveryMapDocuments(bundle: DocumentBundle): DiscoveryMapDocument[] {
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

async function discoveryMapsPolicy(): Promise<LoadedDiscoveryMapsPolicy> {
  const document = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "harness/policies/discovery-maps.current.json"),
      "utf8",
    ),
  ) as LoadedDiscoveryMapsPolicy["document"];
  return { document, contentHash: canonicalContentHash(document) };
}

const mutations: Readonly<Record<string, (bundle: DocumentBundle) => void>> = {
  profile_seed_missing(bundle) {
    const families = fixtureDocument(bundle, G21_SEED_REF).seed_families as Record<
      string,
      unknown[]
    >;
    families.direction = [];
    refreshDiscoveryMapsBundle(bundle);
  },
  seed_evidence_use(bundle) {
    const families = fixtureDocument(bundle, G21_SEED_REF).seed_families as Record<
      string,
      Record<string, unknown>[]
    >;
    const seed = families.problem?.[0];
    assert.ok(seed);
    seed.evidence_use = "allowed";
    refreshDiscoveryMapsBundle(bundle);
  },
  seed_scoring_use(bundle) {
    const policy = fixtureDocument(bundle, G21_SEED_REF).seed_policy as Record<string, unknown>;
    policy.may_affect_scoring = true;
    refreshDiscoveryMapsBundle(bundle);
  },
  seed_independent_reads_seed(bundle) {
    const unit = planUnits(bundle).find(
      (candidate) => candidate.unit_id === "unit_seed_independent_demand",
    );
    assert.ok(unit);
    unit.input_refs = [G21_SCOPE_REF, G21_SEED_REF];
    const contracts = fixtureDocument(bundle, G21_SEED_REF).unit_contracts as Record<
      string,
      Record<string, unknown>
    >;
    const independent = contracts.seed_independent_demand_task;
    assert.ok(independent);
    independent.input_refs = [G21_SCOPE_REF, G21_SEED_REF];
    refreshDiscoveryMapsBundle(bundle);
  },
  counterfactual_wrong_type(bundle) {
    const unit = planUnits(bundle).find((candidate) => candidate.unit_id === "unit_counterfactual");
    assert.ok(unit);
    unit.unit_type = "top_products_gap";
    refreshDiscoveryMapsBundle(bundle);
  },
  solution_neutrality(bundle) {
    fixtureDocument(bundle, G21_OPPORTUNITY_REF).solution_neutral = false;
    refreshDiscoveryMapsBundle(bundle);
  },
  formal_thesis_drift(bundle) {
    fixtureDocument(bundle, G21_OPPORTUNITY_REF).formal_opportunity_thesis_created = true;
    refreshDiscoveryMapsBundle(bundle);
  },
  cross_run(bundle) {
    fixtureDocument(bundle, "decision-context.json").run_id = "other-synthetic-run";
    refreshDiscoveryMapsBundle(bundle);
  },
  market_mismatch(bundle) {
    fixtureDocument(bundle, G21_OPPORTUNITY_REF).market = "other-synthetic-market";
    refreshDiscoveryMapsBundle(bundle);
  },
  language_mismatch(bundle) {
    fixtureDocument(bundle, G21_SOLUTION_REF).language = "other-SYNTHETIC";
    refreshDiscoveryMapsBundle(bundle);
  },
  profile_mismatch(bundle) {
    fixtureDocument(bundle, G21_SOLUTION_REF).discovery_profile = "general";
    refreshDiscoveryMapsBundle(bundle);
  },
  ref_mismatch(bundle) {
    fixtureDocument(bundle, G21_SOLUTION_REF).opportunity_space_map_ref = G21_SEED_REF;
    refreshDiscoveryMapsBundle(bundle);
  },
  path_mismatch(bundle) {
    const entry = bundle.documents.find((candidate) => candidate.path === G21_OPPORTUNITY_REF);
    assert.ok(entry);
    (entry as { path: string }).path = "artifacts/discovery/opportunity-map-other.r1.json";
    (entry.document as Record<string, unknown>).artifact_path =
      "artifacts/discovery/opportunity-map-other.r1.json";
  },
  hash_mismatch(bundle) {
    const solution = fixtureDocument(bundle, G21_SOLUTION_REF);
    const hashes = solution.input_artifact_hashes as Record<string, unknown>[];
    const binding = hashes[0];
    assert.ok(binding);
    binding.content_hash = `sha256:${"0".repeat(64)}`;
    rehashEnvelope(bundle, G21_SOLUTION_REF);
  },
  plan_revision_mismatch(bundle) {
    const manifest = bundle.documents.find((entry) => entry.path === "manifest.json")?.document;
    assert.ok(manifest);
    manifest.plan_revision = 2;
  },
  producer_mismatch(bundle) {
    envelopeRecord(bundle, G21_SOLUTION_REF).producer_role = "harness";
  },
  missing_baseline(bundle) {
    delete fixtureDocument(bundle, G21_OPPORTUNITY_REF).baseline_options;
    refreshDiscoveryMapsBundle(bundle);
  },
  missing_status_quo(bundle) {
    const solution = fixtureDocument(bundle, G21_SOLUTION_REF);
    solution.solution_candidates = (
      solution.solution_candidates as Record<string, unknown>[]
    ).filter((candidate) => candidate.solution_class !== "status_quo");
    refreshDiscoveryMapsBundle(bundle);
  },
  delivery_form_mismatch(bundle) {
    const candidates = fixtureDocument(bundle, G21_SOLUTION_REF).solution_candidates as Record<
      string,
      unknown
    >[];
    const platform = candidates.find((candidate) => candidate.solution_class === "platform_native");
    assert.ok(platform);
    platform.delivery_forms = ["mobile_web"];
    refreshDiscoveryMapsBundle(bundle);
  },
  ai_capability_only(bundle) {
    const boundary = fixtureDocument(bundle, G21_SOLUTION_REF).ai_boundary as Record<
      string,
      unknown
    >;
    boundary.capability_seed_only_cannot_form_opportunity = false;
    refreshDiscoveryMapsBundle(bundle);
  },
  ai_boundary_missing(bundle) {
    const boundary = fixtureDocument(bundle, G21_SOLUTION_REF).ai_boundary as Record<
      string,
      unknown
    >;
    boundary.failure_modes = [];
    refreshDiscoveryMapsBundle(bundle);
  },
  source_boundary_missing(bundle) {
    const boundary = fixtureDocument(bundle, G21_SEED_REF).source_boundary as Record<
      string,
      unknown
    >;
    delete boundary.external_validation_claimed;
    refreshDiscoveryMapsBundle(bundle);
  },
  audit_ref_forbidden(bundle) {
    fixtureDocument(bundle, G21_SEED_REF).audit_refs = ["SYNTHETIC_FORBIDDEN_AUDIT_REF"];
    refreshDiscoveryMapsBundle(bundle);
  },
  limitation_missing(bundle) {
    fixtureDocument(bundle, G21_SOLUTION_REF).limitations = [];
    refreshDiscoveryMapsBundle(bundle);
  },
};

async function snapshotTree(root: string): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        result[relative] = (await readFile(absolute)).toString("base64");
      }
    }
  };
  await visit(root);
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function prepareRun(context: TestContext, profile: DiscoveryProfile, suffix: string) {
  const root = await mkdtemp(path.join(tmpdir(), `startup-opportunity-g2-1-${suffix}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runId = `g2-1-${suffix}-synthetic`;
  const runsRoot = path.join(root, "runs");
  const runRoot = path.join(runsRoot, runId);
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  const bundle = await createDiscoveryMapsFixture(profile, runId);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-26T16:59:00Z",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
  });
  await publishInitialPlanBundle(
    store,
    runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  );
  return { bundle, root, runId, runRoot, runsRoot, store, validator };
}

test("all four G2.1 discovery profiles validate as closed synthetic map bundles", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  for (const profile of ["general", "industry_first", "ai_first", "hybrid"] as const) {
    const bundle = await createDiscoveryMapsFixture(profile);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, true, `${profile}: ${JSON.stringify(result)}`);
    assert.equal(fixtureDocument(bundle, G21_SEED_REF).discovery_profile, profile);
  }
});

test("G2.1 prior-informed Map semantics require an explicit same-Run admission decision", async () => {
  const bundle = await createDiscoveryMapsFixture("general");
  const opportunity = fixtureDocument(bundle, G21_OPPORTUNITY_REF);
  const runId = String(opportunity.run_id);
  const provenance = opportunity.content_provenance as Record<string, unknown>;
  const decisionRef = "decisions.jsonl#prior_input_admitted_g2_1_fixture";
  provenance.synthesis_origin = "prior_informed_synthesis";
  provenance.prior_input_decision_refs = [decisionRef];
  rehashEnvelope(bundle, G21_OPPORTUNITY_REF);

  const policy = await discoveryMapsPolicy();
  const withoutAdmission = validateDiscoveryMapsContract(discoveryMapDocuments(bundle), policy).map(
    (issue) => issue.code,
  );
  assert.ok(withoutAdmission.includes("discovery_maps.prior_input_admission_invalid"));
  assert.ok(withoutAdmission.includes("discovery_maps.prior_input_provenance_not_propagated"));

  const solutionProvenance = fixtureDocument(bundle, G21_SOLUTION_REF).content_provenance as Record<
    string,
    unknown
  >;
  solutionProvenance.synthesis_origin = "prior_informed_synthesis";
  solutionProvenance.prior_input_decision_refs = [decisionRef];
  rehashEnvelope(bundle, G21_SOLUTION_REF);
  assert.ok(fixtureEnvelope(bundle, G21_OPPORTUNITY_REF).input_refs.includes(decisionRef));
  assert.ok(fixtureEnvelope(bundle, G21_SOLUTION_REF).input_refs.includes(decisionRef));
  assert.ok(
    artifactRefsForDocument({
      path: G21_OPPORTUNITY_REF,
      document: fixtureEnvelope(bundle, G21_OPPORTUNITY_REF),
    }).includes(decisionRef),
  );

  const admission = {
    schema_version: "startup_opportunity.decision.v1",
    decision_id: "prior_input_admitted_g2_1_fixture",
    run_id: runId,
    decision_type: "prior_input_admitted",
    timestamp: "2026-07-26T17:00:00Z",
    actor: "main_agent",
    reason: "SYNTHETIC historical hypothesis admitted only as an input to current synthesis.",
    artifact_refs: [],
    prior_input_id: "prior_map_hypothesis_g2_1_fixture",
    prior_source_run_id: "g2-1-prior-synthetic",
    prior_source_artifact_path: "artifacts/discovery/opportunity-space-map.json",
    prior_source_content_hash: `sha256:${"9".repeat(64)}`,
    prior_input_consumer: "discovery_maps",
    prior_target_artifact_path: G21_OPPORTUNITY_REF,
    prior_use_boundary: "hypothesis_input_only",
  };
  const unlabelledCopy = await createDiscoveryMapsFixture("general");
  assert.ok(
    validateDiscoveryMapsContract(
      discoveryMapDocuments(unlabelledCopy),
      policy,
      new Map([[decisionRef, admission]]),
    ).some((issue) => issue.code === "discovery_maps.prior_input_target_not_propagated"),
  );
  assert.equal(
    validateDiscoveryMapsContract(
      discoveryMapDocuments(bundle),
      policy,
      new Map([[decisionRef, admission]]),
    ).some((issue) =>
      [
        "discovery_maps.prior_input_admission_invalid",
        "discovery_maps.prior_input_provenance_not_propagated",
        "discovery_maps.prior_input_target_not_propagated",
      ].includes(issue.code),
    ),
    false,
  );

  admission.prior_source_run_id = runId;
  assert.ok(
    validateDiscoveryMapsContract(
      discoveryMapDocuments(bundle),
      policy,
      new Map([[decisionRef, admission]]),
    ).some((issue) => issue.code === "discovery_maps.prior_input_admission_invalid"),
  );
});

test("Store rejects an admitted prior Map relabelled as unmarked current discovery", async (context) => {
  const state = await prepareRun(context, "general", "prior-map-copy");
  const sourceRunId = "g2-1-prior-map-copy-source";
  const sourceArtifactPath = "prior-opportunity-map.json";
  await state.store.create({
    runId: sourceRunId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic prior market",
      customerModel: "b2c",
      targetUsers: ["synthetic prior user"],
      decisionGoal: "SYNTHETIC prior map source only",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-26T16:00:00Z",
  });
  await writeFile(
    path.join(state.runsRoot, sourceRunId, sourceArtifactPath),
    '{"run_id":"prior-run","conclusion":"OLD MAP SEMANTICS"}\n',
  );
  const admission = await state.store.admitPriorInput({
    runId: state.runId,
    priorInputId: "prior_map_copy_hypothesis",
    sourceRunId,
    sourceArtifactPath,
    targetArtifactPath: G21_OPPORTUNITY_REF,
    consumer: "discovery_maps",
    reason: "SYNTHETIC prior Map may be used only as a labelled hypothesis input.",
    admittedAt: "2026-07-26T17:00:30Z",
  });
  assert.equal(admission.useBoundary, "hypothesis_input_only");

  await assert.rejects(
    state.store.publishArtifactBundle({
      runId: state.runId,
      envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "artifact.reference_invalid" &&
      JSON.stringify(error.details).includes("discovery_maps.prior_input_target_not_propagated"),
  );
  assert.equal(
    (await state.store.status(state.runId)).manifest.artifact_refs.includes(G21_OPPORTUNITY_REF),
    false,
  );
});

test("a controlled prior read taints every later Map target, not only its declared target", async (context) => {
  const state = await prepareRun(context, "general", "prior-map-global-taint");
  const sourceRunId = "g2-1-prior-map-global-taint-source";
  const sourceArtifactPath = "prior-opportunity-map.json";
  await state.store.create({
    runId: sourceRunId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic prior market",
      customerModel: "b2c",
      targetUsers: ["synthetic prior user"],
      decisionGoal: "SYNTHETIC global taint source",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-26T16:00:00Z",
  });
  await writeFile(
    path.join(state.runsRoot, sourceRunId, sourceArtifactPath),
    '{"run_id":"prior-run","body":"OLD MAP SEMANTICS"}\n',
  );
  const admission = await state.store.admitPriorInput({
    runId: state.runId,
    priorInputId: "prior_map_global_taint",
    sourceRunId,
    sourceArtifactPath,
    targetArtifactPath: G21_OPPORTUNITY_REF,
    consumer: "discovery_maps",
    reason: "SYNTHETIC hypothesis-only prior input.",
    admittedAt: "2026-07-26T17:00:30Z",
  });
  await state.store.readPriorInput({
    runId: state.runId,
    admissionRef: admission.decisionRef,
    consumedAt: "2026-07-26T17:00:45Z",
  });
  for (const ref of [G21_OPPORTUNITY_REF, G21_SOLUTION_REF]) {
    const provenance = fixtureDocument(state.bundle, ref).content_provenance as Record<
      string,
      unknown
    >;
    provenance.synthesis_origin = "prior_informed_synthesis";
    provenance.prior_input_decision_refs = [admission.decisionRef];
    rehashEnvelope(state.bundle, ref);
  }

  await assert.rejects(
    state.store.publishArtifactBundle({
      runId: state.runId,
      envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "artifact.reference_invalid" &&
      JSON.stringify(error.details).includes("discovery_maps.prior_input_taint_not_propagated"),
  );
  assert.equal(
    (await state.store.status(state.runId)).manifest.artifact_refs.includes(G21_SEED_REF),
    false,
  );
});

test("prior consumption replays exactly after tainted Maps, checkpoint, and reopen", async (context) => {
  const state = await prepareRun(context, "general", "prior-map-replay");
  const sourceRunId = "g2-1-prior-map-replay-source";
  const sourceArtifactPath = "prior-opportunity-map.json";
  const sourceText = '{"run_id":"prior-run","body":"OLD MAP HYPOTHESIS"}\n';
  await state.store.create({
    runId: sourceRunId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic prior market",
      customerModel: "b2c",
      targetUsers: ["synthetic prior user"],
      decisionGoal: "SYNTHETIC replay source",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-26T16:00:00Z",
  });
  await writeFile(path.join(state.runsRoot, sourceRunId, sourceArtifactPath), sourceText);
  const admission = await state.store.admitPriorInput({
    runId: state.runId,
    priorInputId: "prior_map_replay_hypothesis",
    sourceRunId,
    sourceArtifactPath,
    targetArtifactPath: G21_OPPORTUNITY_REF,
    consumer: "discovery_maps",
    reason: "SYNTHETIC hypothesis-only prior input for exact replay.",
    admittedAt: "2026-07-26T17:00:30Z",
  });
  const firstRead = await state.store.readPriorInput({
    runId: state.runId,
    admissionRef: admission.decisionRef,
    consumedAt: "2026-07-26T17:00:45Z",
  });
  assert.equal(firstRead.status, "appended");
  assert.equal(firstRead.sourceText, sourceText);

  for (const ref of G21_MAP_REFS) {
    const provenance = fixtureDocument(state.bundle, ref).content_provenance as Record<
      string,
      unknown
    >;
    provenance.synthesis_origin = "prior_informed_synthesis";
    provenance.prior_input_decision_refs = [admission.decisionRef];
  }
  refreshDiscoveryMapsBundle(state.bundle);
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
  });
  await state.store.checkpoint({
    runId: state.runId,
    checkpointId: "checkpoint_prior_map_replay",
    createdAt: "2026-07-26T18:30:00Z",
    nextStep: "SYNTHETIC retain prior provenance on every later discovery artifact.",
    beliefSummary: {
      current_belief: "SYNTHETIC prior semantics remain hypothesis-only.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["No market validation is claimed."],
      remaining_disagreement: ["The hypothesis remains unverified."],
      next_decision_relevant_question: "What current-Run Evidence tests the hypothesis?",
    },
    inputRefs: [...G21_MAP_REFS, firstRead.consumptionDecisionRef],
  });

  const reopenedStore = new RunStore(state.runsRoot, await createArtifactValidator(repositoryRoot));
  const reopened = await reopenedStore.load(state.runId);
  assert.equal(reopened.recovered, false);
  const replay = await reopenedStore.readPriorInput({
    runId: state.runId,
    admissionRef: admission.decisionRef,
    consumedAt: "2026-07-26T17:00:45Z",
  });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.sourceText, sourceText);
  assert.equal(replay.sourceContentHash, firstRead.sourceContentHash);
  assert.equal(replay.consumptionDecisionHash, firstRead.consumptionDecisionHash);

  const decisions = (await readFile(path.join(state.runRoot, "decisions.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const consumption = decisions.find(
    (decision) => decision.decision_type === "prior_input_consumed",
  );
  assert.ok(consumption);
  assert.deepEqual(consumption.prior_taint_exempt_artifact_refs, []);
});

test("empty decision subject scaffold compiles and publishes through exact Store closure", async (context) => {
  const state = await prepareRun(context, "general", "snapshot-scaffold");
  const scaffold = await buildArtifactScaffold(
    {
      schema_version: "startup_opportunity.scaffold_request.current",
      scaffold_id: "decision_subject_snapshot_store_synthetic",
      kind: "decision_subject_snapshot",
      run_id: state.runId,
      mode: "opportunity_discovery",
      created_at: "2026-07-26T17:01:00Z",
      scope_confirmation: {
        geography: "Synthetic",
        customer_model: "b2c",
        target_users: ["synthetic user"],
        decision_goal: "test current snapshot scaffold publication",
        research_language: "en-US",
        user_confirmed: true,
      },
    },
    state.validator,
  );
  const request = structuredClone(scaffold.compilation_request as Record<string, unknown>);
  const artifact = (request.artifacts as Record<string, unknown>[])[0];
  assert.ok(artifact);
  const document = artifact.document as Record<string, unknown>;
  assert.deepEqual(document.synthesis_input_hashes, []);
  document.scope_frame_ref = G21_SCOPE_REF;
  document.scope_frame_hash = fixtureEnvelope(state.bundle, G21_SCOPE_REF).content_hash;
  document.research_plan_ref = G21_PLAN_REF;
  document.research_plan_hash = fixtureEnvelope(state.bundle, G21_PLAN_REF).content_hash;
  document.limitations = [
    "SYNTHETIC empty authority: no final decision subject has formed in this Run.",
  ];
  artifact.input_refs = [G21_PLAN_REF, G21_SCOPE_REF];

  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  const validated = await compiler.compile(request as never);
  assert.equal(validated.status, "validated");
  assert.ok(
    validated.publication_plan.resolved_references.some(
      (reference) => reference.ref === G21_SCOPE_REF,
    ),
  );
  const published = await compiler.compile({
    ...request,
    operation: "publish",
    artifacts: [],
    publication_plan: validated.publication_plan,
  } as never);
  assert.equal(published.status, "published");
  const status = await state.store.status(state.runId);
  assert.equal(
    status.manifest.current_decision_subject_snapshot_ref,
    "artifacts/reporting/decision-subject-snapshot.r1.json",
  );
});

test("declarative compiler validates and publishes all G2.1 Maps with one input-ref authority", async (context) => {
  const state = await prepareRun(context, "general", "compiler-map-authority");
  const artifacts = G21_MAP_REFS.map((ref) => {
    const document = fixtureDocument(state.bundle, ref);
    return {
      artifact_type: String(document.schema_version),
      artifact_path: ref,
      producer_role: "main_agent" as const,
      document,
    };
  });
  const request = {
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: "compile_g2_1_maps_authority",
    run_id: state.runId,
    operation: "validate_only",
    created_at: "2026-07-26T17:02:00Z",
    artifacts,
  } as const;
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  const validated = await compiler.compile(request);
  assert.equal(validated.status, "validated");
  const inputRefs = new Map(
    validated.compiled_envelopes.map((envelope) => [envelope.artifact_path, envelope.input_refs]),
  );
  assert.deepEqual(inputRefs.get(G21_SEED_REF), [G21_PLAN_REF, G21_SCOPE_REF]);
  assert.deepEqual(inputRefs.get(G21_OPPORTUNITY_REF), [G21_SEED_REF, G21_PLAN_REF, G21_SCOPE_REF]);
  assert.deepEqual(inputRefs.get(G21_SOLUTION_REF), [
    G21_OPPORTUNITY_REF,
    G21_SEED_REF,
    G21_PLAN_REF,
    G21_SCOPE_REF,
  ]);
  assert.ok(
    validated.compiled_envelopes.every((envelope) =>
      envelope.input_refs.every((ref) => !ref.includes("#unit_")),
    ),
  );
  const published = await compiler.compile({
    ...request,
    operation: "publish",
    artifacts: [],
    publication_plan: validated.publication_plan,
  });
  assert.equal(published.status, "published");
  assert.equal(published.publication_plan.plan_id, validated.publication_plan.plan_id);
  assert.deepEqual(
    (await state.store.status(state.runId)).manifest.artifact_refs.filter((ref) =>
      G21_MAP_REFS.includes(ref as (typeof G21_MAP_REFS)[number]),
    ),
    [...G21_MAP_REFS].sort(),
  );
  const parentRef = "artifacts/discovery/opportunity-space-map.parent.r1.json";
  assert.ok(
    discoveryMapEnvelopeInputRefs({
      ...fixtureDocument(state.bundle, G21_OPPORTUNITY_REF),
      parent_map_ref: parentRef,
    })?.includes(parentRef),
  );
});

test("G2.1 maps accept current main-agent and harness Plan envelopes", async (t) => {
  const validator = await createArtifactValidator(repositoryRoot);

  for (const producerRole of ["main_agent", "harness"] as const) {
    await t.test(`accepts ${producerRole} Plan envelope`, async () => {
      const bundle = await createDiscoveryMapsFixture("hybrid");
      envelopeRecord(bundle, G21_PLAN_REF).producer_role = producerRole;
      const result = validator.validateDocumentBundle(bundle);
      assert.equal(result.valid, true, JSON.stringify(result));
    });
  }

  for (const mismatch of [
    {
      name: "rejects non-current Plan envelope",
      schemaVersion: "startup_opportunity.artifact_envelope.retired",
      producerRole: "harness",
    },
    {
      name: "rejects non-owner Plan producer",
      schemaVersion: "startup_opportunity.artifact_envelope.current",
      producerRole: "lane_researcher",
    },
  ] as const) {
    await t.test(mismatch.name, async () => {
      const bundle = await createDiscoveryMapsFixture("hybrid");
      const planEnvelope = envelopeRecord(bundle, G21_PLAN_REF);
      planEnvelope.schema_version = mismatch.schemaVersion;
      planEnvelope.producer_role = mismatch.producerRole;

      const codes = await allCodes(bundle);
      assert.ok(
        codes.includes(
          mismatch.schemaVersion === "startup_opportunity.artifact_envelope.current"
            ? "discovery_maps.envelope_binding_mismatch"
            : "schema.unknown_version",
        ),
        JSON.stringify(codes),
      );
    });
  }
});

test("G2.1 maps select the Manifest current Plan while retaining immutable Plan history", async (t) => {
  const policy = await discoveryMapsPolicy();

  await t.test(
    "accepts an additional immutable Plan while selecting the Manifest current path",
    async () => {
      const bundle = await createDiscoveryMapsFixture("industry_first");
      const documents = discoveryMapDocuments(bundle);
      const currentPlan = documents.find((entry) => entry.path === G21_PLAN_REF);
      assert.ok(currentPlan);
      documents.push({ ...clone(currentPlan), path: "plans/research-plan.r2.json" });
      const errors = validateDiscoveryMapsContract(documents, policy);
      assert.deepEqual(errors, []);
    },
  );

  await t.test("rejects a missing Manifest-selected current Plan", async () => {
    const bundle = await createDiscoveryMapsFixture("industry_first");
    const documents = discoveryMapDocuments(bundle);
    const manifest = documents.find((entry) => entry.path === "manifest.json")?.document;
    assert.ok(manifest);
    manifest.current_plan_ref = "plans/research-plan.r3.json";
    manifest.plan_revision = 3;
    const codes = validateDiscoveryMapsContract(documents, policy).map((issue) => issue.code);
    assert.ok(codes.includes("discovery_maps.document_cardinality"), JSON.stringify(codes));
  });

  await t.test("rejects duplicate documents at the Manifest-selected Plan path", async () => {
    const bundle = await createDiscoveryMapsFixture("industry_first");
    const documents = discoveryMapDocuments(bundle);
    const currentPlan = documents.find((entry) => entry.path === G21_PLAN_REF);
    assert.ok(currentPlan);
    documents.push(clone(currentPlan));
    const codes = validateDiscoveryMapsContract(documents, policy).map((issue) => issue.code);
    assert.ok(codes.includes("discovery_maps.document_cardinality"), JSON.stringify(codes));
  });
});

test("G2.1 negative catalog fails closed at each declared schema or policy boundary", async (t) => {
  const catalog = JSON.parse(await readFile(caseCatalogPath, "utf8")) as SyntheticCaseCatalog;
  assert.equal(catalog.schema_version, "startup_opportunity.g2_1_synthetic_case_catalog.v1");
  assert.equal(catalog.fixture_classification, "SYNTHETIC_ONLY_NOT_EVIDENCE");
  assert.deepEqual(catalog.public_identifiers, []);
  assert.deepEqual(catalog.user_material_refs, []);
  assert.deepEqual(
    Object.keys(mutations).sort(),
    catalog.cases.map((entry) => entry.case_id).sort(),
  );
  for (const scenario of catalog.cases) {
    await t.test(scenario.case_id, async () => {
      const bundle = await createDiscoveryMapsFixture("hybrid");
      mutations[scenario.case_id]?.(bundle);
      const codes = await allCodes(bundle);
      assert.ok(
        codes.includes(scenario.expected_code),
        `${scenario.case_id}: expected ${scenario.expected_code}, got ${JSON.stringify(codes)}`,
      );
    });
  }
});

test("first map publication is an explicit three-map bundle and exact replay is idempotent", async (t) => {
  const { bundle, runId, runRoot, store } = await prepareRun(t, "general", "publication");
  const beforeSingle = await snapshotTree(runRoot);
  await assert.rejects(
    store.publishArtifact({ runId, envelope: fixtureEnvelope(bundle, G21_SEED_REF) }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.reference_invalid",
  );
  assert.deepEqual(await snapshotTree(runRoot), beforeSingle);

  const input = {
    runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  };
  const first = await store.publishArtifactBundle(input);
  assert.equal(first.status, "published");
  const afterFirst = await snapshotTree(runRoot);
  const replay = await store.publishArtifactBundle(input);
  assert.equal(replay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(runRoot), afterFirst);

  const loaded = await store.load(runId);
  assert.equal(loaded.manifest.current_phase, "discovery");
  assert.ok(G21_MAP_REFS.every((ref) => loaded.manifest.artifact_refs.includes(ref)));

  const operationFiles = await readdir(path.join(runRoot, ".store/operations"));
  const receipts = await Promise.all(
    operationFiles
      .filter((filename) => filename.startsWith("artifact-"))
      .map(async (filename) =>
        JSON.parse(await readFile(path.join(runRoot, ".store/operations", filename), "utf8")),
      ),
  );
  const mapReceipts = receipts.filter((receipt) => G21_MAP_REFS.includes(receipt.artifact_path));
  assert.equal(mapReceipts.length, 3);
  assert.ok(
    mapReceipts.every(
      (receipt) =>
        receipt.schema_version === "startup_opportunity.artifact_store_operation.current",
    ),
  );
});

test("same complete bundle deterministically finishes after a real inter-map process exit", async (t) => {
  const { bundle, runId, runRoot, runsRoot, store } = await prepareRun(
    t,
    "hybrid",
    "inter-map-exit",
  );
  const orderedMapRefs = [...G21_MAP_REFS].sort((left, right) => left.localeCompare(right));
  const firstMapRef = orderedMapRefs[0];
  assert.ok(firstMapRef);

  const crashed = spawnSync(
    process.execPath,
    ["--import", "tsx", interMapCrashWorkerPath, runsRoot, runId, "hybrid"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(crashed.signal, null, crashed.stderr);
  assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);

  const afterCrash = await snapshotTree(runRoot);
  assert.ok(afterCrash[firstMapRef], `first map was not durably published: ${firstMapRef}`);
  for (const missingRef of orderedMapRefs.slice(1)) {
    assert.equal(afterCrash[missingRef], undefined, `later map unexpectedly exists: ${missingRef}`);
  }
  const firstReceiptPath = Object.keys(afterCrash).find((candidate) => {
    if (!candidate.startsWith(".store/operations/artifact-")) {
      return false;
    }
    const bytes = afterCrash[candidate];
    if (bytes === undefined) {
      return false;
    }
    const receipt = JSON.parse(Buffer.from(bytes, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    return receipt.artifact_path === firstMapRef;
  });
  assert.ok(firstReceiptPath, "first map receipt is missing");
  const bundleReceiptPath = Object.keys(afterCrash).find((candidate) =>
    candidate.startsWith(".store/operations/bundle-"),
  );
  assert.ok(bundleReceiptPath, "whole-wave bundle receipt is missing");
  const firstMapBytes = afterCrash[firstMapRef];
  const firstReceiptBytes = afterCrash[firstReceiptPath];
  const bundleReceiptBytes = afterCrash[bundleReceiptPath];

  const recovered = await store.load(runId);
  assert.equal(recovered.recovered, true);
  assert.deepEqual([...recovered.recoveredArtifactPaths].sort(), orderedMapRefs.slice(1));
  assert.ok(G21_MAP_REFS.every((ref) => recovered.manifest.artifact_refs.includes(ref)));
  const afterRecovery = await snapshotTree(runRoot);
  assert.equal(afterRecovery[firstMapRef], firstMapBytes);
  assert.equal(afterRecovery[firstReceiptPath], firstReceiptBytes);
  assert.equal(afterRecovery[bundleReceiptPath], bundleReceiptBytes);
  assert.ok(G21_MAP_REFS.every((ref) => afterRecovery[ref] !== undefined));

  const replay = await store.publishArtifactBundle({
    runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  assert.equal(replay.status, "idempotent_replay");
  assert.ok(replay.artifacts.every((artifact) => artifact.status === "idempotent_replay"));
  const afterReplay = await snapshotTree(runRoot);
  assert.deepEqual(afterReplay, afterRecovery);

  await store.checkpoint({
    runId,
    checkpointId: "checkpoint_inter_map_replay",
    createdAt: "2026-07-26T17:11:00Z",
    nextStep: "SYNTHETIC await controller acceptance; do not start G2.2.",
    beliefSummary: {
      current_belief: "SYNTHETIC map replay proves only deterministic persistence.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["SYNTHETIC no Evidence exists."],
      remaining_disagreement: ["SYNTHETIC demand remains unknown."],
      next_decision_relevant_question: "SYNTHETIC should the controller accept G2.1?",
    },
    inputRefs: [...G21_MAP_REFS],
  });
  const reopened = await store.load(runId);
  assert.ok(G21_MAP_REFS.every((ref) => reopened.manifest.artifact_refs.includes(ref)));
  assert.equal((await store.load(runId)).recovered, false);
});

test("conflicting map replay preserves immutable bytes", async (t) => {
  const { bundle, runId, runRoot, store } = await prepareRun(t, "industry_first", "conflict");
  await store.publishArtifactBundle({
    runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  const before = await snapshotTree(runRoot);
  const conflicting = clone(fixtureEnvelope(bundle, G21_SOLUTION_REF));
  conflicting.document.limitations = [
    "SYNTHETIC conflicting immutable replay; not Evidence or external validation.",
  ];
  const envelope: FormalArtifactEnvelope = {
    ...conflicting,
    content_hash: canonicalContentHash(conflicting.document),
  };
  await assert.rejects(
    store.publishArtifact({ runId, envelope }),
    (error: unknown) => error instanceof StoreError && error.code === "write.conflict",
  );
  assert.deepEqual(await snapshotTree(runRoot), before);
});

test("current checkpoint and receipt recover an interrupted map temp publication", async (t) => {
  const { bundle, runId, runRoot, store } = await prepareRun(t, "ai_first", "recovery");
  await store.publishArtifactBundle({
    runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  await store.checkpoint({
    runId,
    checkpointId: "checkpoint_g2_1_maps",
    createdAt: "2026-07-26T17:10:00Z",
    nextStep: "SYNTHETIC wait for independent regression; do not start G2.2.",
    beliefSummary: {
      current_belief: "SYNTHETIC maps are unvalidated hypotheses only.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["SYNTHETIC no Evidence exists."],
      remaining_disagreement: ["SYNTHETIC demand remains unknown."],
      next_decision_relevant_question: "SYNTHETIC should this implementation pass regression?",
    },
    inputRefs: [...G21_MAP_REFS],
  });
  const checkpoint = JSON.parse(
    await readFile(path.join(runRoot, "checkpoints/checkpoint-g2-1-maps.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(checkpoint.schema_version, "startup_opportunity.artifact_envelope.current");

  const operationRoot = path.join(runRoot, ".store/operations");
  const solutionReceiptFilename = (
    await Promise.all(
      (
        await readdir(operationRoot)
      )
        .filter((filename) => filename.startsWith("artifact-"))
        .map(async (filename) => ({
          filename,
          receipt: JSON.parse(await readFile(path.join(operationRoot, filename), "utf8")) as Record<
            string,
            unknown
          >,
        })),
    )
  ).find(({ receipt }) => receipt.artifact_path === G21_SOLUTION_REF)?.filename;
  assert.ok(solutionReceiptFilename);
  const operationHash = solutionReceiptFilename.slice("artifact-".length, -".json".length);
  await writeFile(
    path.join(runRoot, ".store/temp", `artifact-${operationHash}.publish.tmp`),
    `${canonicalJson(fixtureEnvelope(bundle, G21_SOLUTION_REF))}\n`,
  );
  await unlink(path.join(runRoot, G21_SOLUTION_REF));

  const reopened = await store.load(runId).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }));
    }
    throw error;
  });
  assert.deepEqual(reopened.recoveredArtifactPaths, [G21_SOLUTION_REF]);
  assert.equal(reopened.manifest.current_phase, "discovery");
  assert.equal((await store.load(runId)).recovered, false);
});

test("current publication crash after temp write is recovered only from its receipt", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g2-1-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "g2-1-crash-synthetic";
  const runsRoot = path.join(root, "runs");
  const runRoot = path.join(runsRoot, runId);
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  const bundle = await createDiscoveryMapsFixture("hybrid", runId);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-26T16:59:00Z",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
  });
  await assert.rejects(
    store.publishArtifact({
      runId,
      envelope: fixtureEnvelope(bundle, "decision-context.json"),
      faultAt: "after_temp_write",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const receiptFiles = (await readdir(path.join(runRoot, ".store/operations"))).filter((filename) =>
    filename.startsWith("artifact-"),
  );
  const receipts = await Promise.all(
    receiptFiles.map(async (filename) =>
      JSON.parse(await readFile(path.join(runRoot, ".store/operations", filename), "utf8")),
    ),
  );
  const receipt = receipts.find((candidate) => candidate.artifact_path === "decision-context.json");
  assert.ok(receipt);
  assert.equal(receipt.schema_version, "startup_opportunity.artifact_store_operation.current");
  const reopened = await store.load(runId);
  assert.ok(reopened.recoveredArtifactPaths.includes("decision-context.json"));
});

test("malformed current receipt fails reopen closed", async (t) => {
  const { bundle, runId, runRoot, store } = await prepareRun(t, "hybrid", "receipt-drift");
  await store.publishArtifactBundle({
    runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  const operationRoot = path.join(runRoot, ".store/operations");
  const files = await readdir(operationRoot);
  let drifted = false;
  for (const filename of files.filter((candidate) => candidate.startsWith("artifact-"))) {
    const receiptPath = path.join(operationRoot, filename);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    if (receipt.artifact_path === G21_SOLUTION_REF) {
      receipt.schema_version = "startup_opportunity.artifact_store_operation.invalid";
      await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
      drifted = true;
      break;
    }
  }
  assert.equal(drifted, true);
  await assert.rejects(
    store.load(runId),
    (error: unknown) => error instanceof StoreError && error.code === "recovery.invalid_operation",
  );
});

test("generic CLI validates explicit G2.1 bundles while discover orchestration remains unavailable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g2-1-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = path.join(root, "g2-1-synthetic-bundle.json");
  await writeFile(bundlePath, `${canonicalJson(await createDiscoveryMapsFixture("general"))}\n`);
  const validated = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "validate-artifact",
      "--bundle",
      bundlePath,
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(validated.status, 0, validated.stderr || validated.stdout);
  const result = JSON.parse(validated.stdout) as Record<string, unknown>;
  assert.equal(result.valid, true);

  const discover = spawnSync(
    process.execPath,
    ["--import", "tsx", "harness/src/cli.ts", "discover"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(discover.status, 64);
  assert.match(discover.stderr, /Unknown command: discover/);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  canonicalJson,
  createArtifactValidator,
  type DiscoveryProfile,
  type DocumentBundle,
  type FormalArtifactEnvelope,
  RunStore,
  StoreError,
} from "../harness/src/index.js";
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
  await store.create({ runId, mode: "opportunity_discovery", createdAt: "2026-07-26T16:59:00Z" });
  await store.publishArtifactBundle({
    runId,
    envelopes: G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  return { bundle, root, runId, runRoot, runsRoot, store, validator };
}

test("all four G2.1 discovery profiles validate as closed synthetic map bundles", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  for (const profile of ["general", "industry_first", "ai_first", "hybrid"] as const) {
    const bundle = await createDiscoveryMapsFixture(profile);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, true, `${profile}: ${JSON.stringify(result)}`);
    assert.equal(result.schemaBundleVersion, "10.0.0");
    assert.equal(fixtureDocument(bundle, G21_SEED_REF).discovery_profile, profile);
  }
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
  assert.equal(loaded.manifest.schema_bundle_version, "7.0.0");
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
      (receipt) => receipt.schema_version === "startup_opportunity.artifact_store_operation.v7",
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
  const firstMapBytes = afterCrash[firstMapRef];
  const firstReceiptBytes = afterCrash[firstReceiptPath];

  await assert.rejects(
    store.load(runId),
    (error: unknown) => error instanceof StoreError && error.code === "reference.missing",
  );
  const afterFailedReopen = await snapshotTree(runRoot);
  assert.equal(afterFailedReopen[firstMapRef], firstMapBytes);
  assert.equal(afterFailedReopen[firstReceiptPath], firstReceiptBytes);
  for (const missingRef of orderedMapRefs.slice(1)) {
    assert.equal(
      afterFailedReopen[missingRef],
      undefined,
      `reopen synthesized a missing map: ${missingRef}`,
    );
  }

  const replay = await store.publishArtifactBundle({
    runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  assert.equal(replay.status, "published");
  assert.equal(
    replay.artifacts.find((artifact) => artifact.artifactPath === firstMapRef)?.status,
    "idempotent_replay",
  );
  const afterReplay = await snapshotTree(runRoot);
  assert.equal(afterReplay[firstMapRef], firstMapBytes);
  assert.equal(afterReplay[firstReceiptPath], firstReceiptBytes);
  assert.ok(G21_MAP_REFS.every((ref) => afterReplay[ref] !== undefined));

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

test("v8 checkpoint and v7 receipt recover an interrupted map temp publication", async (t) => {
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
  assert.equal(checkpoint.schema_version, "startup_opportunity.artifact_envelope.v8");

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

test("v8 publication crash after temp write is recovered only from its v7 receipt", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g2-1-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "g2-1-crash-synthetic";
  const runsRoot = path.join(root, "runs");
  const runRoot = path.join(runsRoot, runId);
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  const bundle = await createDiscoveryMapsFixture("hybrid", runId);
  await store.create({ runId, mode: "opportunity_discovery", createdAt: "2026-07-26T16:59:00Z" });
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
  assert.equal(receipt.schema_version, "startup_opportunity.artifact_store_operation.v7");
  const reopened = await store.load(runId);
  assert.ok(reopened.recoveredArtifactPaths.includes("decision-context.json"));
  assert.equal(reopened.manifest.schema_bundle_version, "7.0.0");
});

test("receipt version drift fails reopen closed", async (t) => {
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
      receipt.schema_version = "startup_opportunity.artifact_store_operation.v6";
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

test("v8 adapter blocks G2.2+ artifacts before schema publication", async (t) => {
  const { runId, runRoot, store } = await prepareRun(t, "general", "downstream-block");
  const document = {
    schema_version: "startup_opportunity.discovery_lane_result.v1",
    run_id: runId,
    classification: "SYNTHETIC forbidden G2.2 payload",
  };
  const envelope: FormalArtifactEnvelope = {
    schema_version: "startup_opportunity.artifact_envelope.v8",
    artifact_type: "startup_opportunity.discovery_lane_result.v1",
    artifact_path: "artifacts/lanes/forbidden-g2-2.synthetic.json",
    run_id: runId,
    created_at: "2026-07-26T17:00:00Z",
    producer_role: "main_agent",
    input_refs: [],
    content_hash: canonicalContentHash(document),
    document,
  };
  const before = await snapshotTree(runRoot);
  await assert.rejects(
    store.publishArtifact({ runId, envelope }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.adapter_blocked_type",
  );
  assert.deepEqual(await snapshotTree(runRoot), before);
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
  assert.equal(result.schemaBundleVersion, "10.0.0");

  const discover = spawnSync(
    process.execPath,
    ["--import", "tsx", "harness/src/cli.ts", "discover"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(discover.status, 64);
  assert.match(discover.stderr, /Unknown command: discover/);
});

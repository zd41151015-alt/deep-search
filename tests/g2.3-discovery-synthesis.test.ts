import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  createArtifactValidator,
  type DocumentBundle,
  EvidenceStore,
  type FormalArtifactEnvelope,
  RunStore,
  StoreError,
} from "../harness/src/index.js";
import {
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  G22_BASELINE_EVALUATION_JUDGMENT,
  G22_BASELINE_GENERATION_JUDGMENT,
  G22_DEMAND_R2,
  G22_FAN_IN,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";
import { runtimeEnvelope } from "./fixtures/g2.2/discovery-runtime-fixture.js";
import {
  createDiscoverySynthesisFixture,
  G23_BASELINE,
  G23_BASELINE_CONVERSION,
  G23_DEMAND,
  G23_DEMAND_CONVERSION,
  G23_EVALUATION,
  G23_MERGE,
  G23_OPPORTUNITY_A,
  G23_OPPORTUNITY_B,
  G23_SNAPSHOT,
  G23_SOLUTION,
  G23_SOLUTION_CONVERSION,
  synthesisEnvelope,
} from "./fixtures/g2.3/discovery-synthesis-fixture.js";
import { createConfirmedRun } from "./helpers/current-run.js";
import { discoveryWaveEnvelopes } from "./helpers/discovery-wave.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

interface State {
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

function entry(bundle: DocumentBundle, artifactPath: string): Record<string, unknown> {
  const found = bundle.documents.find((candidate) => candidate.path === artifactPath);
  assert.ok(found, artifactPath);
  return found.document;
}

function effective(bundle: DocumentBundle, artifactPath: string): Record<string, unknown> {
  const value = entry(bundle, artifactPath);
  return String(value.schema_version).startsWith("startup_opportunity.artifact_envelope.")
    ? (value.document as Record<string, unknown>)
    : value;
}

function refresh(bundle: DocumentBundle, artifactPath: string): void {
  const value = entry(bundle, artifactPath);
  if (String(value.schema_version).startsWith("startup_opportunity.artifact_envelope.")) {
    value.content_hash = canonicalContentHash(value.document as Record<string, unknown>);
  }
}

function currentEnvelopes(bundle: DocumentBundle): FormalArtifactEnvelope[] {
  return bundle.documents
    .map((candidate) => candidate.document as unknown as FormalArtifactEnvelope)
    .filter(
      (candidate) => candidate.schema_version === "startup_opportunity.artifact_envelope.current",
    );
}

const SYNTHESIS_PATHS = new Set([
  G23_DEMAND_CONVERSION,
  G23_DEMAND,
  G23_BASELINE_CONVERSION,
  G23_BASELINE,
  G23_SOLUTION_CONVERSION,
  G23_SOLUTION,
  G23_EVALUATION,
  G23_OPPORTUNITY_B,
  G23_OPPORTUNITY_A,
  G23_SNAPSHOT,
  G23_MERGE,
]);

function synthesisEnvelopes(bundle: DocumentBundle): FormalArtifactEnvelope[] {
  return currentEnvelopes(bundle).filter((candidate) =>
    SYNTHESIS_PATHS.has(candidate.artifact_path),
  );
}

function byTypes(bundle: DocumentBundle, ...types: readonly string[]): FormalArtifactEnvelope[] {
  return currentEnvelopes(bundle).filter((candidate) => types.includes(candidate.artifact_type));
}

async function setup(context: TestContext, suffix: string): Promise<State> {
  const root = await mkdtemp(path.join(tmpdir(), `startup-opportunity-g2-3-${suffix}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = `g2-3-${suffix}-synthetic`;
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-27T17:00:00Z",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
  });
  const evidenceStore = new EvidenceStore(runsRoot);
  const generation = (
    await evidenceStore.record({
      runId,
      unitId: "unit_seed_independent_demand",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:${suffix}-generation`,
      },
      researchGoal: "SYNTHETIC G2.3 generation substrate; not Evidence.",
      rawContent: "SYNTHETIC G2.3 generation bytes; not Evidence.",
      recordedAt: "2026-07-27T17:40:00Z",
    })
  ).record;
  const evaluation = (
    await evidenceStore.record({
      runId,
      unitId: "unit_counterfactual",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:${suffix}-evaluation`,
      },
      researchGoal: "SYNTHETIC G2.3 evaluation substrate; not Evidence.",
      rawContent: "SYNTHETIC G2.3 evaluation bytes; not Evidence.",
      recordedAt: "2026-07-27T17:41:00Z",
    })
  ).record;
  const bundle = await createDiscoverySynthesisFixture(runId, { generation, evaluation });
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

async function publishThroughFanIn(state: State): Promise<void> {
  const initialCandidates = byTypes(
    state.bundle,
    "startup_opportunity.discovery_candidate.v1",
  ).filter((candidate) => candidate.document.revision === 1);
  await state.store.publishArtifactBundle({ runId: state.runId, envelopes: initialCandidates });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: discoveryWaveEnvelopes(
      state.bundle,
      state.runId,
      "startup_opportunity.research_task.discovery_candidate.current",
      1,
      "candidate_runtime",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(
      state.bundle,
      "startup_opportunity.evidence.discovery_candidate.current",
      "startup_opportunity.claim.discovery_candidate.current",
      "startup_opportunity.finding.discovery_candidate.current",
      "startup_opportunity.insight.discovery_candidate.current",
      "startup_opportunity.judgment_assessment.discovery_candidate.current",
      "startup_opportunity.source_manifest.discovery_candidate.current",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(state.bundle, "startup_opportunity.discovery_lane_result.v1"),
  });
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: runtimeEnvelope(state.bundle, G22_DEMAND_R2),
  });
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: runtimeEnvelope(state.bundle, G22_FAN_IN),
  });
}

test("G2.3 validates a closed conversion, formal thesis, freeze, and semantic merge bundle", async (context) => {
  const state = await setup(context, "contract");
  const validator = await createArtifactValidator(repositoryRoot);
  const result = validator.validateDocumentBundle(state.bundle);
  assert.equal(result.valid, true, JSON.stringify(result.referenceErrors, null, 2));
  assert.equal(synthesisEnvelopes(state.bundle).length, SYNTHESIS_PATHS.size);
});

test("G2.3 rejects closed lineage, source-separation, freeze, and merge mutations with stable codes", async (context) => {
  const state = await setup(context, "negative");
  const validator = await createArtifactValidator(repositoryRoot);
  const mutations: readonly {
    readonly code: string;
    readonly mutate: (bundle: DocumentBundle) => void;
  }[] = [
    {
      code: "synthesis.conversion_lineage_mismatch",
      mutate(bundle) {
        const fanIn = effective(bundle, G22_FAN_IN);
        const decisions = fanIn.candidate_dispositions as Record<string, unknown>[];
        const decision = decisions.find(
          (candidate) =>
            candidate.candidate_ref === "artifacts/discovery/candidates/candidate_solution.r1.json",
        );
        assert.ok(decision);
        decision.disposition = "watchlist";
        fanIn.retained_candidate_refs = [
          G22_DEMAND_R2,
          "artifacts/discovery/candidates/candidate_baseline.r1.json",
        ];
        fanIn.watchlist_candidate_refs = [
          "artifacts/discovery/candidates/candidate_solution.r1.json",
        ];
        (fanIn.candidate_diversity_summary as Record<string, unknown>).diversity_retention_refs = [
          G22_DEMAND_R2,
          "artifacts/discovery/candidates/candidate_baseline.r1.json",
        ];
        refresh(bundle, G22_FAN_IN);
      },
    },
    {
      code: "synthesis.target_binding_mismatch",
      mutate(bundle) {
        effective(bundle, G23_SOLUTION_CONVERSION).target_content_hash = "0".repeat(64);
        refresh(bundle, G23_SOLUTION_CONVERSION);
      },
    },
    {
      code: "synthesis.subject_lineage_mismatch",
      mutate(bundle) {
        effective(bundle, G23_BASELINE).demand_thesis_ref = G23_SOLUTION;
        refresh(bundle, G23_BASELINE);
      },
    },
    {
      code: "synthesis.source_separation_mismatch",
      mutate(bundle) {
        const groups = effective(bundle, G23_DEMAND).source_groups as Record<string, unknown>;
        groups.evaluation_source_manifest_refs = groups.generation_source_manifest_refs;
        refresh(bundle, G23_DEMAND);
      },
    },
    {
      code: "synthesis.material_candidate_binding_mismatch",
      mutate(bundle) {
        effective(bundle, G23_DEMAND).judgment_assessment_refs = [
          G22_BASELINE_GENERATION_JUDGMENT,
          G22_BASELINE_EVALUATION_JUDGMENT,
        ];
        const envelope = entry(bundle, G23_DEMAND);
        envelope.input_refs = (envelope.input_refs as string[]).map((ref) =>
          ref === "judgments/discovery/judgment-demand.json"
            ? G22_BASELINE_GENERATION_JUDGMENT
            : ref === "judgments/discovery/judgment-demand-evaluation.json"
              ? G22_BASELINE_EVALUATION_JUDGMENT
              : ref,
        );
        refresh(bundle, G23_DEMAND);
      },
    },
    {
      code: "synthesis.solution_evaluation_mismatch",
      mutate(bundle) {
        effective(bundle, G23_EVALUATION).alternative_solution_refs = [G23_SOLUTION];
        refresh(bundle, G23_EVALUATION);
      },
    },
    {
      code: "synthesis.snapshot_freeze_mismatch",
      mutate(bundle) {
        effective(bundle, G23_SNAPSHOT).subject_refs = [G23_OPPORTUNITY_A];
        const env = entry(bundle, G23_SNAPSHOT);
        env.input_refs = (env.input_refs as string[]).filter((ref) => ref !== G23_OPPORTUNITY_B);
        refresh(bundle, G23_SNAPSHOT);
      },
    },
    {
      code: "synthesis.merge_closure_mismatch",
      mutate(bundle) {
        const merge = effective(bundle, G23_MERGE);
        const decision = (merge.merge_or_split_decisions as Record<string, unknown>[])[0];
        assert.ok(decision);
        decision.title_similarity_only = true;
        refresh(bundle, G23_MERGE);
      },
    },
    {
      code: "synthesis.envelope_input_closure_mismatch",
      mutate(bundle) {
        (entry(bundle, G23_OPPORTUNITY_A).input_refs as string[]).push(G23_OPPORTUNITY_B);
      },
    },
    {
      code: "synthesis.publication_order_mismatch",
      mutate(bundle) {
        entry(bundle, G23_DEMAND).created_at = "2026-07-27T20:04:00Z";
      },
    },
  ];
  for (const mutation of mutations) {
    const bundle = clone(state.bundle);
    mutation.mutate(bundle);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false, mutation.code);
    assert.ok(
      result.referenceErrors.some((error) => error.code === mutation.code),
      `${mutation.code}: ${JSON.stringify(result.referenceErrors, null, 2)}`,
    );
  }
});

test("G2.3 publishes caller-supplied synthesis artifacts with current receipts and exact replay", async (context) => {
  const state = await setup(context, "publication");
  await publishThroughFanIn(state);
  const synthesis = synthesisEnvelopes(state.bundle);
  const first = await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: synthesis,
  });
  assert.ok(first.artifacts.every((artifact) => artifact.status === "published"));
  assert.deepEqual(
    first.artifacts.map((artifact) => artifact.artifactPath),
    [
      G23_DEMAND_CONVERSION,
      G23_DEMAND,
      G23_BASELINE_CONVERSION,
      G23_BASELINE,
      G23_SOLUTION_CONVERSION,
      G23_SOLUTION,
      G23_EVALUATION,
      G23_OPPORTUNITY_B,
      G23_OPPORTUNITY_A,
      G23_SNAPSHOT,
      G23_MERGE,
    ],
  );
  const replay = await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: synthesis,
  });
  assert.ok(replay.artifacts.every((artifact) => artifact.status === "idempotent_replay"));
  const loaded = await state.store.load(state.runId);
  assert.ok(loaded.manifest.artifact_refs.includes(G23_MERGE));
  const receipts = await Promise.all(
    (await readdir(path.join(state.runRoot, ".store/operations")))
      .filter((filename) => filename.startsWith("artifact-"))
      .map(
        async (filename) =>
          JSON.parse(
            await readFile(path.join(state.runRoot, ".store/operations", filename), "utf8"),
          ) as Record<string, unknown>,
      ),
  );
  const synthesisRefs = new Set(synthesis.map((candidate) => candidate.artifact_path));
  assert.ok(
    receipts
      .filter((receipt) => synthesisRefs.has(String(receipt.artifact_path)))
      .every(
        (receipt) =>
          receipt.schema_version === "startup_opportunity.artifact_store_operation.current",
      ),
  );
});

test("G2.3 current checkpoint and reopen preserve the frozen synthesis index", async (context) => {
  const state = await setup(context, "reopen");
  await publishThroughFanIn(state);
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: synthesisEnvelopes(state.bundle),
  });
  const checkpoint = await state.store.checkpoint({
    runId: state.runId,
    checkpointId: "checkpoint_g2_3_synthesis",
    createdAt: "2026-07-27T20:20:00Z",
    nextStep: "SYNTHETIC continue only after the immutable thesis snapshot.",
    beliefSummary: {
      current_belief: "SYNTHETIC publication state only.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["SYNTHETIC no validation success."],
      remaining_disagreement: ["SYNTHETIC all market truth remains unknown."],
      next_decision_relevant_question:
        "SYNTHETIC should explicit enrichment artifacts be supplied?",
    },
    inputRefs: [G23_SNAPSHOT, G23_MERGE],
  });
  assert.match(checkpoint.checkpointRef, /checkpoint-g2-3-synthesis/);
  const reopened = await new RunStore(
    state.runsRoot,
    await createArtifactValidator(repositoryRoot),
  ).load(state.runId);
  assert.equal(reopened.recovered, false);
  assert.ok(reopened.manifest.artifact_refs.includes(G23_SNAPSHOT));
  assert.ok(reopened.manifest.artifact_refs.includes(G23_MERGE));
});

test("G2.3 recovers a current post-publish fault from the immutable receipt", async (context) => {
  const state = await setup(context, "fault");
  await publishThroughFanIn(state);
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: synthesisEnvelopes(state.bundle).filter(
      (candidate) => candidate.artifact_path !== G23_MERGE,
    ),
  });
  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: synthesisEnvelope(state.bundle, G23_MERGE),
      faultAt: "after_publish",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const recovered = await state.store.load(state.runId);
  assert.ok(recovered.manifest.artifact_refs.includes(G23_MERGE));
  assert.equal((await state.store.load(state.runId)).recovered, false);
});

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
  deriveSolutionExplorationObservations,
  EvidenceStore,
  type FormalArtifactEnvelope,
  RunStore,
  StoreError,
} from "../harness/src/index.js";
import {
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
  G21_PLAN_REF,
  G21_SCOPE_REF,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  G22_BASELINE_EVALUATION_JUDGMENT,
  G22_BASELINE_GENERATION_JUDGMENT,
  G22_DEMAND_R2,
  G22_EVALUATION_CLAIM,
  G22_FAN_IN,
  G22_FINDING,
  G22_GENERATION_CLAIM,
  G22_INSIGHT,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";
import { runtimeEnvelope } from "./fixtures/g2.2/discovery-runtime-fixture.js";
import {
  createDiscoverySynthesisFixture,
  discoverySynthesisReadinessEnvelopes,
  G23_BASELINE,
  G23_BASELINE_CONVERSION,
  G23_DEMAND,
  G23_DEMAND_CONVERSION,
  G23_EVALUATION,
  G23_MERGE,
  G23_OPPORTUNITY_A,
  G23_OPPORTUNITY_B,
  G23_READINESS,
  G23_READINESS_GAP,
  G23_SNAPSHOT,
  G23_SOLUTION,
  G23_SOLUTION_CONVERSION,
  synthesisEnvelope,
} from "./fixtures/g2.3/discovery-synthesis-fixture.js";
import { createConfirmedRun, publishInitialPlanBundle } from "./helpers/current-run.js";
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

function emptyGenericPlanGap(bundle: DocumentBundle): FormalArtifactEnvelope {
  const readinessGap = clone(synthesisEnvelope(bundle, G23_READINESS_GAP));
  const {
    readiness_ref: _readinessRef,
    fan_in_ref: _fanInRef,
    ...genericDocument
  } = readinessGap.document as Record<string, unknown> & {
    readiness_ref?: unknown;
    fan_in_ref?: unknown;
  };
  genericDocument.schema_version = "startup_opportunity.gap_snapshot.discovery.plan.current";
  genericDocument.snapshot_id = "discovery_plan_empty";
  genericDocument.snapshot_cycle_key = canonicalContentHash({
    run_id: genericDocument.run_id,
    plan_ref: genericDocument.based_on_plan_ref,
    fan_in_ref: G22_FAN_IN,
    cycle: "empty_generic_gap",
  });
  genericDocument.created_at = "2026-07-27T19:59:00Z";
  genericDocument.observed_artifact_refs = [G22_FAN_IN];
  genericDocument.solution_exploration_observations = [];
  genericDocument.gaps = [];
  genericDocument.unresolved_decision_relevant_questions = ["question_demand"];
  const artifactPath = "adaptations/gap-snapshots/discovery_plan_empty.r1.json";
  return {
    ...readinessGap,
    artifact_type: "startup_opportunity.gap_snapshot.discovery.plan.current",
    artifact_path: artifactPath,
    created_at: "2026-07-27T19:59:00Z",
    producer_role: "main_agent",
    input_refs: [G21_PLAN_REF, G22_FAN_IN],
    content_hash: canonicalContentHash(genericDocument),
    document: genericDocument,
  } as FormalArtifactEnvelope;
}

function setSolutionExplorationState(
  bundle: DocumentBundle,
  status:
    | "not_yet_explored"
    | "explored_no_other_formal_solution"
    | "insufficient_evidence"
    | "not_applicable",
  consideredApproaches: readonly Record<string, unknown>[] = [],
): void {
  const evaluation = effective(bundle, G23_EVALUATION);
  evaluation.solution_exploration = {
    status,
    status_rationale: `SYNTHETIC explicit ${status} state for focused regression.`,
    considered_approaches: structuredClone(consideredApproaches),
  };
  if (status === "insufficient_evidence") evaluation.decision_sufficiency = "insufficient_evidence";
  refresh(bundle, G23_EVALUATION);
  const solution = effective(bundle, G23_SOLUTION);
  const summary = {
    solution_evaluation_ref: G23_EVALUATION,
    solution_evaluation_content_hash: canonicalContentHash(evaluation),
    exploration_status: status,
    selection_posture: "provisional_implementation",
    status_rationale: (evaluation.solution_exploration as Record<string, unknown>).status_rationale,
    formal_solution_refs: [G23_SOLUTION],
    formal_solutions: [
      {
        solution_ref: G23_SOLUTION,
        solution_content_hash: canonicalContentHash(solution),
        disposition: "selected",
        solution_id: solution.solution_id,
        solution_type: solution.solution_type,
        solution_behavior: solution.solution_behavior,
        delivery_form: solution.delivery_form,
        uses_ai: solution.uses_ai,
      },
    ],
    selected_solution_ref: G23_SOLUTION,
    alternative_solution_refs: [],
    rejected_solutions: [],
    considered_approaches: structuredClone(consideredApproaches),
    critical_unknowns: structuredClone(evaluation.critical_unknowns),
    limitations: structuredClone(evaluation.limitations),
  };
  for (const opportunityRef of [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B]) {
    const opportunity = effective(bundle, opportunityRef);
    opportunity.solution_evaluation_summary = structuredClone(summary);
    const opportunityEnvelope = entry(bundle, opportunityRef);
    if (consideredApproaches.length > 0) {
      opportunityEnvelope.input_refs = [
        ...new Set([...(opportunityEnvelope.input_refs as string[]), G22_EVALUATION_CLAIM]),
      ].sort();
    }
    refresh(bundle, opportunityRef);
  }
  const evaluationEnvelope = entry(bundle, G23_EVALUATION);
  if (consideredApproaches.length > 0) {
    evaluationEnvelope.input_refs = [
      ...new Set([...(evaluationEnvelope.input_refs as string[]), G22_EVALUATION_CLAIM]),
    ].sort();
    refresh(bundle, G23_EVALUATION);
  }
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
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: discoverySynthesisReadinessEnvelopes(state.bundle),
  });
}

test("G2.3 validates a closed conversion, formal thesis, freeze, and semantic merge bundle", async (context) => {
  const state = await setup(context, "contract");
  const validator = await createArtifactValidator(repositoryRoot);
  const result = validator.validateDocumentBundle(state.bundle);
  assert.equal(result.valid, true, JSON.stringify(result.referenceErrors, null, 2));
  assert.equal(synthesisEnvelopes(state.bundle).length, SYNTHESIS_PATHS.size);
});

test("G2.3 preserves explicit single-Solution exploration states and provisional posture", async (context) => {
  const validator = await createArtifactValidator(repositoryRoot);
  const cases: readonly {
    readonly status:
      | "not_yet_explored"
      | "explored_no_other_formal_solution"
      | "insufficient_evidence"
      | "not_applicable";
    readonly approaches?: readonly Record<string, unknown>[];
  }[] = [
    { status: "not_yet_explored" },
    {
      status: "explored_no_other_formal_solution",
      approaches: [
        {
          approach_id: "approach_manual_review",
          implementation_direction: "SYNTHETIC manual review workflow",
          disposition: "not_formalized",
          disposition_reasons: ["SYNTHETIC no separate formal thesis was retained."],
          material_bindings: [
            { ref: G22_EVALUATION_CLAIM, content_hash: canonicalContentHash("placeholder") },
          ],
          unknowns: ["SYNTHETIC unknown"],
          limitations: ["SYNTHETIC limitation"],
        },
      ],
    },
    { status: "insufficient_evidence" },
    { status: "not_applicable" },
  ];
  for (const [index, testCase] of cases.entries()) {
    const state = await setup(context, `exploration-${index}`);
    const bundle = clone(state.bundle);
    const approaches = testCase.approaches?.map((approach) => ({
      ...approach,
      material_bindings: [
        {
          ref: G22_EVALUATION_CLAIM,
          content_hash: canonicalContentHash(effective(bundle, G22_EVALUATION_CLAIM)),
        },
      ],
    }));
    setSolutionExplorationState(bundle, testCase.status, approaches);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(
      result.valid,
      true,
      `${testCase.status}: ${JSON.stringify(result.referenceErrors)}`,
    );
    const opportunity = effective(bundle, G23_OPPORTUNITY_A);
    const summary = opportunity.solution_evaluation_summary as Record<string, unknown>;
    assert.equal(summary.exploration_status, testCase.status);
    assert.equal(summary.selection_posture, "provisional_implementation");
  }
});

test("G2.3 rejects compared status without complete closure and bad considered material hash", async (context) => {
  const state = await setup(context, "exploration-negative");
  const validator = await createArtifactValidator(repositoryRoot);
  const compared = clone(state.bundle);
  const comparedEvaluation = effective(compared, G23_EVALUATION);
  comparedEvaluation.solution_exploration = {
    status: "compared_multiple_formal_solutions",
    status_rationale: "SYNTHETIC invalid comparison claim.",
    considered_approaches: [],
  };
  refresh(compared, G23_EVALUATION);
  const comparedResult = validator.validateDocumentBundle(compared);
  assert.equal(comparedResult.valid, false);
  assert.ok(
    comparedResult.documents
      .flatMap((document) => document.errors)
      .some((error) => error.code === "schema.minItems"),
  );

  const badMaterial = clone(state.bundle);
  const approach = {
    approach_id: "approach_bad_hash",
    implementation_direction: "SYNTHETIC other approach",
    disposition: "not_formalized",
    disposition_reasons: ["SYNTHETIC not retained."],
    material_bindings: [{ ref: G22_EVALUATION_CLAIM, content_hash: "0".repeat(64) }],
    unknowns: [],
    limitations: [],
  };
  setSolutionExplorationState(badMaterial, "explored_no_other_formal_solution", [approach]);
  const badMaterialResult = validator.validateDocumentBundle(badMaterial);
  assert.equal(badMaterialResult.valid, false);
  assert.ok(
    badMaterialResult.referenceErrors.some(
      (error) =>
        error.code === "reference.hash_mismatch" ||
        error.code === "synthesis.considered_approach_material_binding_mismatch",
    ),
  );
});

test("Gap projection exposes Solution exploration without creating a Gap or Unit", async (context) => {
  const state = await setup(context, "gap-observation");
  const documents = new Map(
    currentEnvelopes(state.bundle).map((envelope) => [
      envelope.artifact_path,
      {
        path: envelope.artifact_path,
        schemaVersion: envelope.artifact_type,
        document: envelope.document,
        envelope,
      },
    ]),
  );
  assert.deepEqual(
    deriveSolutionExplorationObservations(documents, [G23_EVALUATION, G23_OPPORTUNITY_A]),
    [
      {
        solution_evaluation_ref: G23_EVALUATION,
        solution_evaluation_content_hash: synthesisEnvelope(state.bundle, G23_EVALUATION)
          .content_hash,
        opportunity_refs: [G23_OPPORTUNITY_A],
        exploration_status: "not_yet_explored",
        selection_posture: "provisional_implementation",
        planning_effect: "main_agent_decides_whether_to_adapt",
      },
    ],
  );
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
  const insufficientJudgments = currentEnvelopes(state.bundle).filter(
    (candidate) =>
      candidate.artifact_type ===
      "startup_opportunity.judgment_assessment.discovery_candidate.current",
  );
  assert.ok(insufficientJudgments.length > 0);
  assert.ok(
    insufficientJudgments.every(
      (judgment) => judgment.document.decision_sufficiency === "insufficient",
    ),
  );
});

test("G2.3 rejects a generic empty Plan Gap as a substitute for post-fan-in readiness", async (context) => {
  const state = await setup(context, "generic-gap-boundary");
  await publishThroughFanIn(state);
  const genericGap = emptyGenericPlanGap(state.bundle);
  await state.store.publishArtifact({ runId: state.runId, envelope: genericGap });
  await assert.rejects(
    state.store.publishArtifactBundle({
      runId: state.runId,
      envelopes: synthesisEnvelopes(state.bundle),
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "run.discovery_synthesis_readiness_gap_required",
  );
});

test("G2.3 rejects Readiness claiming ready while a Plan question remains unresolved", async (context) => {
  const state = await setup(context, "dishonest-readiness");
  const invalid = clone(state.bundle);
  const readiness = effective(invalid, G23_READINESS);
  const coverage = readiness.question_coverage as Record<string, unknown>[];
  assert.ok(coverage[0]);
  coverage[0].status = "unresolved";
  const readinessGap = effective(invalid, G23_READINESS_GAP);
  readinessGap.unresolved_decision_relevant_questions = [String(coverage[0].question_ref)];
  refresh(invalid, G23_READINESS);
  refresh(invalid, G23_READINESS_GAP);
  const validator = await createArtifactValidator(repositoryRoot);
  const result = validator.validateDocumentBundle(invalid);
  assert.equal(result.valid, false);
  assert.ok(
    result.documents
      .flatMap((document) => document.errors)
      .concat(result.referenceErrors)
      .some((error) => error.code === "runtime.discovery_synthesis_not_ready"),
  );
});

test("Store re-forms an Opportunity Thesis only from a post-terminal causal closure", async (context) => {
  const state = await setup(context, "opportunity-reformation");
  await publishThroughFanIn(state);
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: synthesisEnvelopes(state.bundle),
  });

  const scope = fixtureEnvelope(state.bundle, G21_SCOPE_REF);
  const plan = fixtureEnvelope(state.bundle, G21_PLAN_REF);
  const opportunityR1 = synthesisEnvelope(state.bundle, G23_OPPORTUNITY_A);
  const snapshotR1Ref = "artifacts/reporting/decision-subject-snapshot.r1.json";
  const snapshotR1Document = {
    schema_version: "startup_opportunity.decision_subject_snapshot.current",
    snapshot_id: "decision_subjects_opportunity_reformation",
    revision: 1,
    parent_snapshot_ref: null,
    parent_snapshot_hash: null,
    run_id: state.runId,
    mode: "opportunity_discovery",
    scope_frame_ref: scope.artifact_path,
    scope_frame_hash: scope.content_hash,
    research_plan_ref: plan.artifact_path,
    research_plan_hash: plan.content_hash,
    synthesis_input_hashes: [
      { ref: opportunityR1.artifact_path, content_hash: opportunityR1.content_hash },
    ],
    created_at: "2026-07-27T20:12:00Z",
    subjects: [
      {
        subject_id: opportunityR1.document.opportunity_id,
        subject_ref: opportunityR1.artifact_path,
        subject_content_hash: opportunityR1.content_hash,
        subject_kind: "opportunity_thesis",
        lifecycle_status: "dropped",
        reporting_role: "audit_only",
        superseded_by_subject_id: null,
        formation_reason: "SYNTHETIC current-Run Opportunity Thesis.",
        lifecycle_reason: "SYNTHETIC terminal state before a new causal input.",
      },
    ],
    limitations: ["SYNTHETIC lifecycle fixture; not market Evidence."],
  };
  const snapshotR1: FormalArtifactEnvelope = {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: "startup_opportunity.decision_subject_snapshot.current",
    artifact_path: snapshotR1Ref,
    run_id: state.runId,
    created_at: "2026-07-27T20:12:00Z",
    producer_role: "main_agent",
    input_refs: [scope.artifact_path, plan.artifact_path, opportunityR1.artifact_path].sort(),
    content_hash: canonicalContentHash(snapshotR1Document),
    document: snapshotR1Document,
  };
  await state.store.publishArtifact({ runId: state.runId, envelope: snapshotR1 });

  const newFindingRef = "findings/discovery/finding-opportunity-reformation.json";
  const newFinding = clone(runtimeEnvelope(state.bundle, G22_FINDING));
  (newFinding as { artifact_path: string }).artifact_path = newFindingRef;
  (newFinding as { created_at: string }).created_at = "2026-07-27T20:13:00Z";
  newFinding.document.finding_id = "finding_opportunity_reformation";
  newFinding.document.summary =
    "SYNTHETIC post-terminal finding that materially changes the Opportunity Thesis.";
  (newFinding as { content_hash: string }).content_hash = canonicalContentHash(newFinding.document);
  await state.store.publishArtifact({ runId: state.runId, envelope: newFinding });

  const newInsightRef = "insights/discovery/insight-opportunity-reformation.json";
  const newInsight = clone(runtimeEnvelope(state.bundle, G22_INSIGHT));
  (newInsight as { artifact_path: string }).artifact_path = newInsightRef;
  (newInsight as { created_at: string }).created_at = "2026-07-27T20:14:00Z";
  (newInsight as unknown as { input_refs: string[] }).input_refs = newInsight.input_refs
    .map((ref) => (ref === G22_FINDING ? newFindingRef : ref))
    .sort();
  newInsight.document.insight_id = "insight_opportunity_reformation";
  newInsight.document.summary =
    "SYNTHETIC post-terminal insight used by the revised Opportunity Thesis.";
  newInsight.document.finding_refs = [newFindingRef];
  (newInsight as { content_hash: string }).content_hash = canonicalContentHash(newInsight.document);
  await state.store.publishArtifact({ runId: state.runId, envelope: newInsight });

  const opportunityR2Ref = "artifacts/discovery/opportunities/opportunity_household.r2.json";
  const opportunityR2 = clone(opportunityR1);
  (opportunityR2 as { artifact_path: string }).artifact_path = opportunityR2Ref;
  (opportunityR2 as { created_at: string }).created_at = "2026-07-27T20:15:00Z";
  opportunityR2.document.revision = 2;
  opportunityR2.document.parent_opportunity_ref = opportunityR1.artifact_path;
  opportunityR2.document.parent_content_hash = opportunityR1.content_hash;
  opportunityR2.document.title =
    "SYNTHETIC revised household coordination Opportunity from post-terminal input";
  opportunityR2.document.supporting_insight_refs = [
    ...(opportunityR2.document.supporting_insight_refs as string[]),
    newInsightRef,
  ].sort();
  opportunityR2.document.opposing_claim_refs = [
    ...(opportunityR2.document.opposing_claim_refs as string[]),
    G22_GENERATION_CLAIM,
  ].sort();
  (opportunityR2 as unknown as { input_refs: string[] }).input_refs = [
    ...new Set([
      ...opportunityR2.input_refs,
      opportunityR1.artifact_path,
      newInsightRef,
      G22_GENERATION_CLAIM,
    ]),
  ].sort();
  (opportunityR2 as { content_hash: string }).content_hash = canonicalContentHash(
    opportunityR2.document,
  );
  await state.store
    .publishArtifact({ runId: state.runId, envelope: opportunityR2 })
    .catch((error: unknown) => {
      if (error instanceof StoreError) assert.fail(JSON.stringify(error.details, null, 2));
      throw error;
    });

  const reformInput = {
    runId: state.runId,
    terminalSnapshotRef: snapshotR1Ref,
    terminalSubjectId: String(opportunityR1.document.opportunity_id),
    reformedSubjectRef: opportunityR2Ref,
    reason: "SYNTHETIC post-terminal insight caused a materially revised Opportunity Thesis.",
    reformedAt: "2026-07-27T20:16:00Z",
  } as const;
  await assert.rejects(
    state.store.reformDecisionSubject({
      ...reformInput,
      reformedSubjectRef: opportunityR1.artifact_path,
      reformationInputRefs: [newInsightRef],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "subject_reformation.revision_lineage_invalid",
  );
  await assert.rejects(
    state.store.reformDecisionSubject({
      ...reformInput,
      reformationInputRefs: [opportunityR2Ref],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "subject_reformation.input_unrelated",
  );
  await assert.rejects(
    state.store.reformDecisionSubject({
      ...reformInput,
      reformationInputRefs: [G23_MERGE],
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
    reformationInputRefs: [newInsightRef],
  });
  assert.equal(reformation.status, "appended");

  const snapshotR2Ref = "artifacts/reporting/decision-subject-snapshot.r2.json";
  const snapshotR2Document = {
    ...structuredClone(snapshotR1Document),
    revision: 2,
    parent_snapshot_ref: snapshotR1Ref,
    parent_snapshot_hash: snapshotR1.content_hash,
    synthesis_input_hashes: [{ ref: opportunityR2Ref, content_hash: opportunityR2.content_hash }],
    created_at: "2026-07-27T20:17:00Z",
    subjects: [
      {
        ...(structuredClone(snapshotR1Document.subjects) as Record<string, unknown>[])[0],
        subject_ref: opportunityR2Ref,
        subject_content_hash: opportunityR2.content_hash,
        lifecycle_status: "current",
        reporting_role: "final",
        reformation_decision_ref: reformation.decisionRef,
        lifecycle_reason: "SYNTHETIC causally re-formed from a post-terminal insight.",
      },
    ],
  };
  const snapshotR2: FormalArtifactEnvelope = {
    ...snapshotR1,
    artifact_path: snapshotR2Ref,
    created_at: "2026-07-27T20:17:00Z",
    input_refs: [
      snapshotR1Ref,
      scope.artifact_path,
      plan.artifact_path,
      opportunityR2Ref,
      reformation.decisionRef,
    ].sort(),
    content_hash: canonicalContentHash(snapshotR2Document),
    document: snapshotR2Document,
  };
  await state.store.publishArtifact({ runId: state.runId, envelope: snapshotR2 });
  await state.store.checkpoint({
    runId: state.runId,
    checkpointId: "checkpoint_opportunity_reformation",
    createdAt: "2026-07-27T20:30:00Z",
    nextStep: "SYNTHETIC continue from the exact re-formed Opportunity authority.",
    beliefSummary: {
      current_belief: "SYNTHETIC Opportunity was re-formed from post-terminal analysis.",
      evidence_that_changed_belief: [newFindingRef, newInsightRef],
      unchanged_assumptions: ["No market validation is claimed."],
      remaining_disagreement: ["Actual demand remains unknown."],
      next_decision_relevant_question: "What current Evidence would test the revision?",
    },
    inputRefs: [snapshotR2Ref, reformation.decisionRef],
  });
  const reopened = await new RunStore(
    state.runsRoot,
    await createArtifactValidator(repositoryRoot),
  ).load(state.runId);
  assert.equal(reopened.recovered, false);
  assert.equal(reopened.manifest.current_decision_subject_snapshot_ref, snapshotR2Ref);
  assert.equal(reopened.manifest.current_decision_subject_snapshot_hash, snapshotR2.content_hash);
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

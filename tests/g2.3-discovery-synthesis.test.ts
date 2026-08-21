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
  G22_GENERATION_MANIFEST,
  G22_INSIGHT,
  G22_JUDGMENT,
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

function familyDeclaration(
  familyId: string,
  familyRelation: "independent_opportunity" | "shared_opportunity_family" | "unknown",
  members: readonly {
    readonly opportunity_ref: string;
    readonly relation_to_family:
      | "independent_opportunity"
      | "segment_variant"
      | "delivery_or_implementation_variant"
      | "unknown";
  }[],
): Record<string, unknown> {
  return {
    family_id: familyId,
    title: `SYNTHETIC ${familyId}`,
    family_relation: familyRelation,
    members: members.map((member) => ({ ...member })),
    shared_value_or_solution_mechanism: {
      state: familyRelation === "unknown" ? "unknown" : "declared",
      description: `SYNTHETIC mechanism for ${familyId}; no real conclusion.`,
    },
    shared_assumptions: ["SYNTHETIC assumption."],
    shared_failure_risks: ["SYNTHETIC shared risk."],
    member_specific_differences: members.map((member) => ({
      opportunity_ref: member.opportunity_ref,
      dimensions: [
        {
          dimension: "user",
          state: familyRelation === "unknown" ? "unknown" : "partial",
          description: "SYNTHETIC member difference; no real conclusion.",
        },
      ],
    })),
    evidence_basis: {
      supporting_refs: [],
      opposing_refs: [],
      background_refs: [],
      unknown_refs: [],
      limitations: ["SYNTHETIC limitation."],
      unresolved_questions: ["SYNTHETIC unresolved question."],
    },
  };
}

function setFamilies(bundle: DocumentBundle, families: readonly Record<string, unknown>[]): void {
  effective(bundle, G23_MERGE).opportunity_families = structuredClone(families);
  refresh(bundle, G23_MERGE);
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

test("G2.3 represents independent, segment, delivery, mixed, and unknown family relations without changing Opportunities", async (context) => {
  const state = await setup(context, "family-relations");
  const validator = await createArtifactValidator(repositoryRoot);
  const relationCases: readonly {
    readonly name: string;
    readonly families: readonly Record<string, unknown>[];
  }[] = [
    {
      name: "multiple-independent-families",
      families: [
        familyDeclaration("family_independent_a", "independent_opportunity", [
          { opportunity_ref: G23_OPPORTUNITY_A, relation_to_family: "independent_opportunity" },
        ]),
        familyDeclaration("family_independent_b", "independent_opportunity", [
          { opportunity_ref: G23_OPPORTUNITY_B, relation_to_family: "independent_opportunity" },
        ]),
      ],
    },
    {
      name: "shared-segments",
      families: [
        familyDeclaration("family_segments", "shared_opportunity_family", [
          { opportunity_ref: G23_OPPORTUNITY_A, relation_to_family: "segment_variant" },
          { opportunity_ref: G23_OPPORTUNITY_B, relation_to_family: "segment_variant" },
        ]),
      ],
    },
    {
      name: "delivery-variant",
      families: [
        familyDeclaration("family_delivery", "shared_opportunity_family", [
          { opportunity_ref: G23_OPPORTUNITY_A, relation_to_family: "segment_variant" },
          {
            opportunity_ref: G23_OPPORTUNITY_B,
            relation_to_family: "delivery_or_implementation_variant",
          },
        ]),
      ],
    },
    {
      name: "mixed-independent-and-single-member-family",
      families: [
        familyDeclaration("family_single_member", "shared_opportunity_family", [
          { opportunity_ref: G23_OPPORTUNITY_A, relation_to_family: "segment_variant" },
        ]),
        familyDeclaration("family_mixed_independent", "independent_opportunity", [
          { opportunity_ref: G23_OPPORTUNITY_B, relation_to_family: "independent_opportunity" },
        ]),
      ],
    },
    {
      name: "unknown-relation",
      families: [
        familyDeclaration("family_unknown", "unknown", [
          { opportunity_ref: G23_OPPORTUNITY_A, relation_to_family: "unknown" },
          { opportunity_ref: G23_OPPORTUNITY_B, relation_to_family: "unknown" },
        ]),
      ],
    },
  ];
  for (const relationCase of relationCases) {
    const bundle = clone(state.bundle);
    const before = [
      canonicalContentHash(effective(bundle, G23_OPPORTUNITY_A)),
      canonicalContentHash(effective(bundle, G23_OPPORTUNITY_B)),
    ];
    setFamilies(bundle, relationCase.families);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(
      result.valid,
      true,
      `${relationCase.name}: ${JSON.stringify(result.referenceErrors, null, 2)}`,
    );
    assert.deepEqual(
      [
        canonicalContentHash(effective(bundle, G23_OPPORTUNITY_A)),
        canonicalContentHash(effective(bundle, G23_OPPORTUNITY_B)),
      ],
      before,
      relationCase.name,
    );
  }
});

test("G2.3 preserves distinct knowledge states and supporting, opposing, background, and unknown family material", async (context) => {
  const state = await setup(context, "family-evidence-states");
  const family = familyDeclaration("family_semantic_states", "shared_opportunity_family", [
    { opportunity_ref: G23_OPPORTUNITY_A, relation_to_family: "segment_variant" },
    { opportunity_ref: G23_OPPORTUNITY_B, relation_to_family: "segment_variant" },
  ]);
  family.shared_value_or_solution_mechanism = {
    state: "unavailable",
    description: "SYNTHETIC unavailable mechanism detail; no absence claim.",
  };
  family.member_specific_differences = [
    {
      opportunity_ref: G23_OPPORTUNITY_A,
      dimensions: [
        { dimension: "user", state: "partial", description: "SYNTHETIC partial." },
        {
          dimension: "job_to_be_done",
          state: "unavailable",
          description: "SYNTHETIC unavailable.",
        },
        { dimension: "entry_scene", state: "unknown", description: "SYNTHETIC unknown." },
      ],
    },
    {
      opportunity_ref: G23_OPPORTUNITY_B,
      dimensions: [
        { dimension: "buyer", state: "inferred", description: "SYNTHETIC inferred." },
        {
          dimension: "acquisition",
          state: "not_applicable",
          description: "SYNTHETIC not applicable.",
        },
        {
          dimension: "compliance",
          state: "no_evidence_found",
          description: "SYNTHETIC no evidence found after the declared search boundary.",
        },
      ],
    },
  ];
  family.evidence_basis = {
    supporting_refs: [G22_GENERATION_CLAIM],
    opposing_refs: [G22_EVALUATION_CLAIM],
    background_refs: [G22_GENERATION_MANIFEST],
    unknown_refs: [G22_JUDGMENT],
    limitations: ["SYNTHETIC limitation."],
    unresolved_questions: ["SYNTHETIC unresolved question."],
  };
  setFamilies(state.bundle, [family]);
  const mergeEnvelope = entry(state.bundle, G23_MERGE);
  mergeEnvelope.input_refs = [
    ...new Set([
      ...(mergeEnvelope.input_refs as string[]),
      G22_GENERATION_CLAIM,
      G22_EVALUATION_CLAIM,
      G22_GENERATION_MANIFEST,
      G22_JUDGMENT,
    ]),
  ].sort();
  const validator = await createArtifactValidator(repositoryRoot);
  const result = validator.validateDocumentBundle(state.bundle);
  assert.equal(result.valid, true, JSON.stringify(result.referenceErrors, null, 2));
});

test("G2.3 accepts one single-member family and reports one direction rather than fabricating more families", async (context) => {
  const state = await setup(context, "single-family");
  (state.bundle.documents as { path: string; document: Record<string, unknown> }[]) =
    state.bundle.documents.filter((entry) => entry.path !== G23_OPPORTUNITY_B);
  const snapshot = effective(state.bundle, G23_SNAPSHOT);
  snapshot.subject_refs = [G23_OPPORTUNITY_A];
  const snapshotEnvelope = entry(state.bundle, G23_SNAPSHOT);
  snapshotEnvelope.input_refs = (snapshotEnvelope.input_refs as string[]).filter(
    (ref) => ref !== G23_OPPORTUNITY_B,
  );
  refresh(state.bundle, G23_SNAPSHOT);
  const merge = effective(state.bundle, G23_MERGE);
  merge.source_thesis_refs = [G23_OPPORTUNITY_A];
  merge.merged_opportunities = [
    {
      cluster_id: "cluster_single",
      canonical_opportunity_ref: G23_OPPORTUNITY_A,
      member_thesis_refs: [G23_OPPORTUNITY_A],
    },
  ];
  const decision = structuredClone(
    (merge.merge_or_split_decisions as Record<string, unknown>[])[0],
  );
  assert.ok(decision);
  decision.decision_id = "decision_single";
  decision.cluster_id = "cluster_single";
  decision.decision = "preserve";
  decision.member_thesis_refs = [G23_OPPORTUNITY_A];
  merge.merge_or_split_decisions = [decision];
  merge.preserved_variants = [G23_OPPORTUNITY_A];
  setFamilies(state.bundle, [
    familyDeclaration("family_only", "shared_opportunity_family", [
      { opportunity_ref: G23_OPPORTUNITY_A, relation_to_family: "segment_variant" },
    ]),
  ]);
  const mergeEnvelope = entry(state.bundle, G23_MERGE);
  mergeEnvelope.input_refs = (mergeEnvelope.input_refs as string[]).filter(
    (ref) => ref !== G23_OPPORTUNITY_B,
  );
  const validator = await createArtifactValidator(repositoryRoot);
  const result = validator.validateDocumentBundle(state.bundle);
  assert.equal(result.valid, true, JSON.stringify(result.referenceErrors, null, 2));
});

test("G2.3 rejects duplicate or omitted family members before atomic publication writes anything", async (context) => {
  for (const mutation of ["duplicate", "omitted"] as const) {
    const state = await setup(context, `family-${mutation}`);
    await publishThroughFanIn(state);
    const invalid = clone(synthesisEnvelopes(state.bundle));
    const mergeEnvelope = invalid.find((entry) => entry.artifact_path === G23_MERGE);
    assert.ok(mergeEnvelope);
    const families = mergeEnvelope.document.opportunity_families as Record<string, unknown>[];
    const members = families[0]?.members as Record<string, unknown>[];
    assert.ok(members?.[0]);
    if (mutation === "duplicate") members.push(structuredClone(members[0]));
    else members.pop();
    (mergeEnvelope as { content_hash: string }).content_hash = canonicalContentHash(
      mergeEnvelope.document,
    );
    await assert.rejects(
      state.store.publishArtifactBundle({ runId: state.runId, envelopes: invalid }),
      (error: unknown) => error instanceof StoreError,
    );
    const loaded = await state.store.load(state.runId);
    assert.ok(
      synthesisEnvelopes(state.bundle).every(
        (entry) => !loaded.manifest.artifact_refs.includes(entry.artifact_path),
      ),
      mutation,
    );
  }
});

test("G2.3 rejects cross-Run members and stale selected Solution typed facts", async (context) => {
  const state = await setup(context, "family-authority-bindings");
  const validator = await createArtifactValidator(repositoryRoot);

  const crossRun = clone(state.bundle);
  effective(crossRun, G23_OPPORTUNITY_A).run_id = "foreign-run-not-this-one";
  refresh(crossRun, G23_OPPORTUNITY_A);
  const crossRunResult = validator.validateDocumentBundle(crossRun);
  assert.equal(crossRunResult.valid, false);
  assert.ok(
    crossRunResult.referenceErrors.some(
      (error) => error.code === "opportunity_family.member_authority_invalid",
    ),
    JSON.stringify(crossRunResult.referenceErrors, null, 2),
  );

  const staleSolution = clone(state.bundle);
  effective(staleSolution, G23_SOLUTION).delivery_form = "human_coaching";
  refresh(staleSolution, G23_SOLUTION);
  const staleSolutionResult = validator.validateDocumentBundle(staleSolution);
  assert.equal(staleSolutionResult.valid, false);
  assert.ok(
    staleSolutionResult.referenceErrors.some(
      (error) => error.code === "opportunity_family.selected_solution_authority_invalid",
    ),
    JSON.stringify(staleSolutionResult.referenceErrors, null, 2),
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

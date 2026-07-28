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
  type DocumentBundle,
  deriveReportEnvelopes,
  EvidenceStore,
  type FormalArtifactEnvelope,
  ReportRuntime,
  RunStore,
  StoreError,
} from "../harness/src/index.js";
import {
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import { G22_DEMAND_R2, G22_FAN_IN } from "./fixtures/g2.2/discovery-candidate-fixture.js";
import {
  createDiscoveryEvaluationFixture,
  evaluationEnvelope,
  G24_BRANCH_SUPPORT,
  G24_COMPARISON_A,
  G24_ENGINE_A,
  G24_EVIDENCE_SUPPORT,
  G24_FAN_IN,
  G24_PORTFOLIO,
  G24_RECOMMENDATION,
  G24_REPORT,
  G24_SENSITIVITY,
  G24_TASK_SUPPORT,
  G24_TRACEABILITY,
} from "./fixtures/g2.4/discovery-evaluation-fixture.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

interface State {
  readonly root: string;
  readonly runsRoot: string;
  readonly runRoot: string;
  readonly runId: string;
  readonly store: RunStore;
  readonly validator: Awaited<ReturnType<typeof createArtifactValidator>>;
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
  const outer = entry(bundle, artifactPath);
  return String(outer.schema_version).startsWith("startup_opportunity.artifact_envelope.")
    ? (outer.document as Record<string, unknown>)
    : outer;
}

function refresh(bundle: DocumentBundle, artifactPath: string): void {
  const outer = entry(bundle, artifactPath);
  if (String(outer.schema_version).startsWith("startup_opportunity.artifact_envelope.")) {
    outer.content_hash = canonicalContentHash(outer.document as Record<string, unknown>);
  }
}

async function setup(context: TestContext, suffix: string): Promise<State> {
  const root = await mkdtemp(path.join(tmpdir(), `startup-opportunity-g2-4-${suffix}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = `g2-4-${suffix}-synthetic`;
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await store.create({
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-27T17:00:00Z",
  });
  const evidence = new EvidenceStore(runsRoot);
  const record = async (unitId: string, label: string) =>
    (
      await evidence.record({
        runId,
        unitId,
        source: {
          kind: "user_provided",
          canonical_uri: `urn:startup-opportunity:user-provided:${suffix}-${label}`,
        },
        researchGoal: `SYNTHETIC ${label} substrate; not Evidence.`,
        rawContent: `SYNTHETIC ${label} bytes; not Evidence.`,
        recordedAt: "2026-07-27T20:50:00Z",
      })
    ).record;
  const bundle = await createDiscoveryEvaluationFixture(runId, {
    generation: await record("unit_seed_independent_demand", "generation"),
    evaluation: await record("unit_counterfactual", "evaluation"),
    support: await record("unit_enrichment_support", "support"),
    challenge: await record("unit_enrichment_challenge", "challenge"),
  });
  return {
    root,
    runsRoot,
    runRoot: path.join(runsRoot, runId),
    runId,
    store,
    validator,
    bundle,
  };
}

function envelopes(
  bundle: DocumentBundle,
  version: FormalArtifactEnvelope["schema_version"],
): FormalArtifactEnvelope[] {
  return bundle.documents
    .map((candidate) => candidate.document as unknown as FormalArtifactEnvelope)
    .filter((candidate) => candidate.schema_version === version);
}

function byTypes(
  candidates: readonly FormalArtifactEnvelope[],
  ...types: readonly string[]
): FormalArtifactEnvelope[] {
  return candidates.filter((candidate) => types.includes(candidate.artifact_type));
}

async function publishThroughSynthesis(state: State): Promise<void> {
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: G21_CORE_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
  });
  const runtime = envelopes(state.bundle, "startup_opportunity.artifact_envelope.v10");
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(runtime, "startup_opportunity.discovery_candidate.v1").filter(
      (candidate) => candidate.document.revision === 1,
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(runtime, "startup_opportunity.research_task.v2"),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(
      runtime,
      "startup_opportunity.evidence.v2",
      "startup_opportunity.claim.v2",
      "startup_opportunity.finding.v2",
      "startup_opportunity.insight.v2",
      "startup_opportunity.judgment_assessment.v2",
      "startup_opportunity.source_manifest.v2",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(runtime, "startup_opportunity.discovery_lane_result.v1"),
  });
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: runtime.find(
      (candidate) => candidate.artifact_path === G22_DEMAND_R2,
    ) as FormalArtifactEnvelope,
  });
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: runtime.find(
      (candidate) => candidate.artifact_path === G22_FAN_IN,
    ) as FormalArtifactEnvelope,
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: envelopes(state.bundle, "startup_opportunity.artifact_envelope.v11"),
  });
}

async function publishThroughEnrichmentBranches(state: State): Promise<void> {
  await publishThroughSynthesis(state);
  const evaluation = envelopes(state.bundle, "startup_opportunity.artifact_envelope.v12");
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(evaluation, "startup_opportunity.research_task.v3"),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(
      evaluation,
      "startup_opportunity.evidence.v3",
      "startup_opportunity.claim.v3",
      "startup_opportunity.finding.v3",
      "startup_opportunity.insight.v3",
      "startup_opportunity.judgment_assessment.v3",
      "startup_opportunity.source_manifest.v3",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(evaluation, "startup_opportunity.enrichment_branch_result.v1"),
  });
}

async function publishThroughEvaluation(state: State): Promise<void> {
  await publishThroughEnrichmentBranches(state);
  const evaluation = envelopes(state.bundle, "startup_opportunity.artifact_envelope.v12");
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: evaluation.filter(
      (candidate) =>
        ![
          "startup_opportunity.research_task.v3",
          "startup_opportunity.evidence.v3",
          "startup_opportunity.claim.v3",
          "startup_opportunity.finding.v3",
          "startup_opportunity.insight.v3",
          "startup_opportunity.judgment_assessment.v3",
          "startup_opportunity.source_manifest.v3",
          "startup_opportunity.enrichment_branch_result.v1",
          "startup_opportunity.report.v1",
        ].includes(candidate.artifact_type),
    ),
  });
}

async function rewriteUnitState(
  state: State,
  unitId: string,
  target: "invalidated_units" | "superseded_units",
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
        : values.filter((candidate) => candidate !== unitId);
  }
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
}

function terminalBranch(
  state: State,
  artifactPath: string,
  status: "partial" | "failed" | "ignored_late" | "superseded",
): FormalArtifactEnvelope {
  const candidate = clone(evaluationEnvelope(state.bundle, artifactPath));
  candidate.document.status = status;
  return { ...candidate, content_hash: canonicalContentHash(candidate.document) };
}

test("G2.4 validates closed enrichment, hard gates, comparison, portfolio, and report lineage", async (context) => {
  const state = await setup(context, "contract");
  const validator = await createArtifactValidator(repositoryRoot);
  const result = validator.validateDocumentBundle(state.bundle);
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  assert.equal(
    state.bundle.documents.filter(
      (candidate) =>
        candidate.document.schema_version === "startup_opportunity.artifact_envelope.v12",
    ).length,
    34,
  );
});

test("G2.4 rejects closed contract mutations with deterministic error codes", async (context) => {
  const state = await setup(context, "negative");
  const validator = await createArtifactValidator(repositoryRoot);
  const mutations: readonly {
    readonly code: string;
    readonly mutate: (bundle: DocumentBundle) => void;
  }[] = [
    {
      code: "g2_4.task_plan_unit_mismatch",
      mutate(bundle) {
        effective(bundle, G24_TASK_SUPPORT).unit_id = "unit_unplanned_enrichment";
        refresh(bundle, G24_TASK_SUPPORT);
      },
    },
    {
      code: "g2_4.material_task_binding_mismatch",
      mutate(bundle) {
        (effective(bundle, G24_EVIDENCE_SUPPORT).lineage as Record<string, unknown>).task_ref =
          "tasks/discovery/enrichment/unit_enrichment_challenge.attempt-1.json";
        refresh(bundle, G24_EVIDENCE_SUPPORT);
      },
    },
    {
      code: "g2_4.task_snapshot_merge_binding_mismatch",
      mutate(bundle) {
        effective(bundle, G24_TASK_SUPPORT).source_merge_ref =
          "artifacts/discovery/merges/merge-missing.r1.json";
        refresh(bundle, G24_TASK_SUPPORT);
      },
    },
    {
      code: "g2_4.evidence_substrate_binding_mismatch",
      mutate(bundle) {
        (
          effective(bundle, G24_EVIDENCE_SUPPORT).mechanical_binding as Record<string, unknown>
        ).content_hash = "0".repeat(64);
        refresh(bundle, G24_EVIDENCE_SUPPORT);
      },
    },
    {
      code: "g2_4.fan_in_classification_mismatch",
      mutate(bundle) {
        const classification = effective(bundle, G24_FAN_IN).branch_result_classification as Record<
          string,
          unknown
        >;
        classification.completed_refs = [G24_BRANCH_SUPPORT];
        classification.insufficient_evidence_refs = [
          "artifacts/discovery/enrichment/branches/unit_enrichment_challenge.attempt-1.json",
        ];
        refresh(bundle, G24_FAN_IN);
      },
    },
    {
      code: "g2_4.fan_in_material_closure_mismatch",
      mutate(bundle) {
        effective(bundle, G24_FAN_IN).claim_refs = [
          "claims/discovery/enrichment/claim-support.json",
        ];
        refresh(bundle, G24_FAN_IN);
      },
    },
    {
      code: "g2_4.hard_gate_closure_mismatch",
      mutate(bundle) {
        const gates = effective(bundle, G24_FAN_IN).hard_gate_inputs as Record<string, unknown>[];
        gates.pop();
        refresh(bundle, G24_FAN_IN);
      },
    },
    {
      code: "g2_4.panel_closure_mismatch",
      mutate(bundle) {
        const panels = effective(bundle, G24_COMPARISON_A).comparison_panels as Record<
          string,
          unknown
        >[];
        (panels[3] as Record<string, unknown>).panel_id = "evidence_strength";
        refresh(bundle, G24_COMPARISON_A);
      },
    },
    {
      code: "g2_4.comparison_gate_lineage_mismatch",
      mutate(bundle) {
        const gates = effective(bundle, G24_COMPARISON_A).hard_gate_results as Record<
          string,
          unknown
        >[];
        (gates[0] as Record<string, unknown>).status = "passed";
        refresh(bundle, G24_COMPARISON_A);
      },
    },
    {
      code: "g2_4.comparison_subject_binding_mismatch",
      mutate(bundle) {
        effective(bundle, G24_ENGINE_A).source_snapshot_ref =
          "artifacts/discovery/thesis-snapshots/snapshot-missing.r1.json";
        refresh(bundle, G24_ENGINE_A);
      },
    },
    {
      code: "g2_4.evidence_ceiling_violation",
      mutate(bundle) {
        effective(bundle, G24_COMPARISON_A).recommendation_band = "strong_candidate";
        refresh(bundle, G24_COMPARISON_A);
      },
    },
    {
      code: "g2_4.sensitivity_relation_mismatch",
      mutate(bundle) {
        effective(bundle, G24_SENSITIVITY).pairwise_relations = [];
        refresh(bundle, G24_SENSITIVITY);
      },
    },
    {
      code: "g2_4.portfolio_closure_mismatch",
      mutate(bundle) {
        effective(bundle, G24_PORTFOLIO).watchlist_refs = [
          "artifacts/discovery/opportunities/opportunity_household.r1.json",
        ];
        refresh(bundle, G24_PORTFOLIO);
      },
    },
    {
      code: "g2_4.traceability_freshness_mismatch",
      mutate(bundle) {
        const freshness = effective(bundle, G24_TRACEABILITY).freshness_summary as Record<
          string,
          unknown
        >;
        freshness.current_refs = [G24_EVIDENCE_SUPPORT];
        refresh(bundle, G24_TRACEABILITY);
      },
    },
    {
      code: "g2_4.report_closure_mismatch",
      mutate(bundle) {
        effective(bundle, G24_REPORT).watchlist_refs = [
          "artifacts/discovery/opportunities/opportunity_household.r1.json",
        ];
        refresh(bundle, G24_REPORT);
      },
    },
    {
      code: "g2_4.bundle_version_mismatch",
      mutate(bundle) {
        (bundle as { schema_version: string }).schema_version =
          "startup_opportunity.document_bundle.v11";
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

test("G2.4 Store rejects an enrichment task that is absent from the current Plan", async (context) => {
  const state = await setup(context, "unplanned-task");
  await publishThroughSynthesis(state);
  const source = clone(evaluationEnvelope(state.bundle, G24_TASK_SUPPORT));
  const document = { ...source.document, unit_id: "unit_unplanned_enrichment" };
  const task = { ...source, document, content_hash: canonicalContentHash(document) };

  await assert.rejects(
    state.store.publishArtifact({ runId: state.runId, envelope: task }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.task_plan_unit_mismatch",
  );
});

test("G2.4 rejects a discovery brief that drifts from its structured report", async (context) => {
  const state = await setup(context, "derived-negative");
  const bundle = clone(state.bundle);
  const derived = deriveReportEnvelopes(evaluationEnvelope(bundle, G24_REPORT));
  (bundle.documents as { path: string; document: Record<string, unknown> }[]).push(
    ...derived.map((candidate) => ({
      path: candidate.artifact_path,
      document: candidate as unknown as Record<string, unknown>,
    })),
  );
  const briefPath = "artifacts/reporting/decision-brief.r1.json";
  effective(bundle, briefPath).decision_tier = "prioritize";
  refresh(bundle, briefPath);
  const result = state.validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, false);
  assert.ok(
    result.referenceErrors.some((error) => error.code === "g2_4.report_consistency_mismatch"),
    JSON.stringify(result.referenceErrors, null, 2),
  );
});

test("G2.4 publishes evaluation artifacts, materializes the discovery report, and replays exactly", async (context) => {
  const state = await setup(context, "publication");
  await publishThroughEvaluation(state);
  const runtime = new ReportRuntime(state.runsRoot, state.validator);
  const report = evaluationEnvelope(state.bundle, G24_REPORT);
  const first = await runtime.build({ reportEnvelope: report });
  assert.equal(first.status, "published");
  assert.deepEqual(first.formalArtifactPaths, [
    G24_REPORT,
    "artifacts/reporting/decision-brief.r1.json",
    "artifacts/reporting/report-markdown.r1.json",
    "artifacts/reporting/consistency-evaluation.r1.json",
  ]);
  assert.deepEqual(first.materializedPaths, ["report.json", "decision-brief.md", "report.md"]);
  const replay = await runtime.build({ reportEnvelope: report });
  assert.equal(replay.status, "idempotent_replay");
  const loaded = await state.store.load(state.runId);
  assert.equal(loaded.manifest.schema_bundle_version, "11.0.0");
  assert.ok(loaded.manifest.artifact_refs.includes(G24_REPORT));
  assert.ok(loaded.manifest.artifact_refs.includes(first.consistencyEvaluationRef));
  assert.match(
    await readFile(path.join(state.runRoot, "decision-brief.md"), "utf8"),
    /Partial Order/,
  );
  assert.match(await readFile(path.join(state.runRoot, "report.md"), "utf8"), /Portfolio/);
  const receipts = await Promise.all(
    (await readdir(path.join(state.runRoot, ".store/operations")))
      .filter((filename) => filename.startsWith("artifact-"))
      .map(async (filename) =>
        JSON.parse(await readFile(path.join(state.runRoot, ".store/operations", filename), "utf8")),
      ),
  );
  const v12Paths = new Set(
    envelopes(state.bundle, "startup_opportunity.artifact_envelope.v12").map(
      (candidate) => candidate.artifact_path,
    ),
  );
  assert.ok(
    receipts
      .filter((receipt) => v12Paths.has(String((receipt as Record<string, unknown>).artifact_path)))
      .every(
        (receipt) =>
          (receipt as Record<string, unknown>).schema_version ===
          "startup_opportunity.artifact_store_operation.v10",
      ),
  );
});

test("G2.4 checkpoint, reopen, and report fault recovery preserve the validated current index", async (context) => {
  const state = await setup(context, "recovery");
  await publishThroughEvaluation(state);
  const runtime = new ReportRuntime(state.runsRoot, state.validator);
  await assert.rejects(
    runtime.build({
      reportEnvelope: evaluationEnvelope(state.bundle, G24_REPORT),
      faultAt: "after_view_materialization",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const recovered = await state.store.load(state.runId);
  assert.ok(
    recovered.reportRecovery.recoveredFormalArtifactPaths.includes(
      "artifacts/reporting/consistency-evaluation.r1.json",
    ),
  );
  assert.ok(recovered.manifest.artifact_refs.includes(G24_REPORT));
  assert.ok(
    recovered.manifest.artifact_refs.includes("artifacts/reporting/consistency-evaluation.r1.json"),
  );
  const checkpoint = await state.store.checkpoint({
    runId: state.runId,
    checkpointId: "checkpoint_g2_4_evaluation",
    createdAt: "2026-07-27T22:00:00Z",
    nextStep: "SYNTHETIC preserve G2 exit candidate state for independent regression.",
    beliefSummary: {
      current_belief: "SYNTHETIC contract mechanics only.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["SYNTHETIC no market validation is claimed."],
      remaining_disagreement: ["SYNTHETIC all market truth remains unknown."],
      next_decision_relevant_question: "SYNTHETIC should the user commission more Evidence?",
    },
    inputRefs: [G24_RECOMMENDATION, G24_TRACEABILITY, G24_REPORT],
  });
  assert.match(checkpoint.checkpointRef, /checkpoint-g2-4-evaluation/);
  const reopened = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.equal(reopened.recovered, false);
  assert.ok(reopened.manifest.artifact_refs.includes(G24_COMPARISON_A));
  assert.ok(reopened.manifest.artifact_refs.includes(G24_PORTFOLIO));
});

test("G2.4 v12 receipt recovery completes an interrupted fan-in publication", async (context) => {
  const state = await setup(context, "artifact-fault");
  await publishThroughEnrichmentBranches(state);
  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: evaluationEnvelope(state.bundle, G24_FAN_IN),
      faultAt: "after_temp_write",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const recovered = await state.store.load(state.runId);
  assert.ok(recovered.recoveredArtifactPaths.includes(G24_FAN_IN));
  assert.ok(recovered.manifest.artifact_refs.includes(G24_FAN_IN));
  assert.equal((await state.store.load(state.runId)).recovered, false);
});

test("G2.4 branch terminal states project mechanically and keep late or superseded results non-current", async (t) => {
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
      await publishThroughSynthesis(state);
      const evaluation = envelopes(state.bundle, "startup_opportunity.artifact_envelope.v12");
      await state.store.publishArtifactBundle({
        runId: state.runId,
        envelopes: byTypes(evaluation, "startup_opportunity.research_task.v3"),
      });
      await state.store.publishArtifactBundle({
        runId: state.runId,
        envelopes: byTypes(
          evaluation,
          "startup_opportunity.evidence.v3",
          "startup_opportunity.claim.v3",
          "startup_opportunity.finding.v3",
          "startup_opportunity.insight.v3",
          "startup_opportunity.judgment_assessment.v3",
          "startup_opportunity.source_manifest.v3",
        ),
      });
      if (scenario.prestate !== null) {
        await rewriteUnitState(state, "unit_enrichment_support", scenario.prestate);
        await state.store.checkpoint({
          runId: state.runId,
          checkpointId: `checkpoint_${scenario.suffix}_state`,
          createdAt: "2026-07-27T21:29:00Z",
          nextStep: "SYNTHETIC publish only an explicit terminal enrichment result.",
          beliefSummary: {
            current_belief: "SYNTHETIC unit state is mechanical only.",
            evidence_that_changed_belief: [],
            unchanged_assumptions: ["SYNTHETIC no validation success is claimed."],
            remaining_disagreement: ["SYNTHETIC market truth remains unknown."],
            next_decision_relevant_question: "SYNTHETIC should the late result remain non-current?",
          },
          inputRefs: [],
        });
      }
      const branch = terminalBranch(state, G24_BRANCH_SUPPORT, scenario.status);
      await state.store.publishArtifact({ runId: state.runId, envelope: branch });
      const manifest = (await state.store.load(state.runId)).manifest;
      const expected =
        scenario.target === "ignored_late_artifact_refs"
          ? G24_BRANCH_SUPPORT
          : "unit_enrichment_support";
      assert.ok((manifest[scenario.target] as readonly string[]).includes(expected));
      if (scenario.target === "ignored_late_artifact_refs") {
        assert.ok(!manifest.artifact_refs.includes(G24_BRANCH_SUPPORT));
      }
    });
  }
});

test("G2.4 v11 adapter rejects evaluation artifacts before any write", async (context) => {
  const state = await setup(context, "v11-boundary");
  await publishThroughSynthesis(state);
  const candidate = clone(evaluationEnvelope(state.bundle, G24_FAN_IN));
  (candidate as unknown as { schema_version: string }).schema_version =
    "startup_opportunity.artifact_envelope.v11";
  const before = await readdir(path.join(state.runRoot, ".store/operations"));
  await assert.rejects(
    state.store.publishArtifact({ runId: state.runId, envelope: candidate }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.adapter_blocked_type",
  );
  assert.deepEqual(await readdir(path.join(state.runRoot, ".store/operations")), before);
  await assert.rejects(
    readFile(path.join(state.runRoot, G24_FAN_IN), "utf8"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
});

test("G2.4 audit-traceability and build-report CLI consume explicit v12 artifacts", async (context) => {
  const state = await setup(context, "cli");
  const auditBundle = clone(state.bundle);
  const derived = deriveReportEnvelopes(evaluationEnvelope(auditBundle, G24_REPORT));
  (auditBundle.documents as { path: string; document: Record<string, unknown> }[]).push(
    ...derived.map((candidate) => ({
      path: candidate.artifact_path,
      document: candidate as unknown as Record<string, unknown>,
    })),
  );
  const auditPath = path.join(state.root, "discovery-report-bundle.json");
  await writeFile(auditPath, `${canonicalJson(auditBundle)}\n`);
  const audited = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "audit-traceability",
      "--bundle",
      auditPath,
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(audited.status, 0, audited.stderr || audited.stdout);
  const auditResult = JSON.parse(audited.stdout) as Record<string, unknown>;
  assert.equal(auditResult.valid, true);
  assert.equal(auditResult.reportSetEvaluated, true);

  const compared = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "calculate-comparison",
      "--bundle",
      auditPath,
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(compared.status, 0, compared.stderr || compared.stdout);
  const comparisonResult = JSON.parse(compared.stdout) as {
    status?: string;
    comparisons?: readonly unknown[];
  };
  assert.equal(comparisonResult.status, "validated");
  assert.equal(comparisonResult.comparisons?.length, 2);

  const sensitivity = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      ".agents/skills/startup-opportunity/scripts/calculate-sensitivity.ts",
      "--bundle",
      auditPath,
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(sensitivity.status, 0, sensitivity.stderr || sensitivity.stdout);
  const sensitivityResult = JSON.parse(sensitivity.stdout) as Record<string, unknown>;
  assert.equal(sensitivityResult.status, "validated");
  assert.equal(sensitivityResult.artifactPath, G24_SENSITIVITY);

  await publishThroughEvaluation(state);
  const reportPath = path.join(state.root, "discovery-report-envelope.json");
  await writeFile(reportPath, `${canonicalJson(evaluationEnvelope(state.bundle, G24_REPORT))}\n`);
  const built = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "build-report",
      "--file",
      reportPath,
      "--runs-root",
      state.runsRoot,
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const buildResult = JSON.parse(built.stdout) as Record<string, unknown>;
  assert.equal(buildResult.status, "published");
  assert.deepEqual(buildResult.materializedPaths, [
    "report.json",
    "decision-brief.md",
    "report.md",
  ]);
});

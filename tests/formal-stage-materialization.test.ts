import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  createArtifactValidator,
  EvidenceStore,
  type FormalArtifactEnvelope,
  FormalStageMaterializer,
  planningRunStateHash,
  RunStore,
  StoreError,
} from "../harness/src/index.js";
import {
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
  G21_OPPORTUNITY_REF,
  G21_PLAN_REF,
  G21_SEED_REF,
  G21_SOLUTION_REF,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  createDiscoveryCandidateFixture,
  fixtureEffective,
  G22_BASELINE_R1,
  G22_DEMAND_R1,
  G22_EVALUATION_TASK,
  G22_GENERATION_TASK,
  G22_RUN_ID,
  G22_SOLUTION_R1,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";
import { createDiscoveryRuntimeFixture } from "./fixtures/g2.2/discovery-runtime-fixture.js";
import {
  createDiscoverySynthesisFixture,
  G23_DEMAND,
  G23_DEMAND_CONVERSION,
} from "./fixtures/g2.3/discovery-synthesis-fixture.js";
import { createConfirmedRun, publishInitialPlanBundle } from "./helpers/current-run.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const createdAt = "2026-08-19T09:00:00Z";

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "harness/src/cli.ts", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function parseCli<T>(result: ReturnType<typeof runCli>): T {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as T;
}

async function writeJson(root: string, name: string, value: unknown): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function replaceExactStrings(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => replaceExactStrings(entry, replacements));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, replaceExactStrings(entry, replacements)]),
  );
}

function compileRequest(
  runId: string,
  requestId: string,
  artifacts: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: requestId,
    run_id: runId,
    operation: "validate_only",
    created_at: createdAt,
    artifacts,
  };
}

async function snapshotTree(root: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) snapshot[relative] = (await readFile(absolute)).toString("base64");
    }
  };
  await visit(root);
  return Object.fromEntries(
    Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function prepareRun(context: TestContext, suffix: string) {
  const root = await mkdtemp(path.join(tmpdir(), `formal-stage-${suffix}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = `formal-stage-${suffix}`;
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test formal materialization",
      researchLanguage: "en-US",
    },
    createdAt,
  });
  const evidence = new EvidenceStore(runsRoot);
  const generation = (
    await evidence.record({
      runId,
      unitId: "unit_seed_independent_demand",
      researchGoal: "SYNTHETIC materialization substrate; not Evidence.",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:${suffix}-generation`,
      },
      rawContent: "SYNTHETIC generation bytes; not Evidence.",
      recordedAt: createdAt,
    })
  ).record;
  const evaluation = (
    await evidence.record({
      runId,
      unitId: "unit_counterfactual",
      researchGoal: "SYNTHETIC materialization substrate; not Evidence.",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:${suffix}-evaluation`,
      },
      rawContent: "SYNTHETIC evaluation bytes; not Evidence.",
      recordedAt: createdAt,
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
  await store.publishArtifactBundle({
    runId,
    envelopes: bundle.documents
      .map((entry) => entry.document as unknown as FormalArtifactEnvelope)
      .filter(
        (envelope) =>
          envelope.schema_version === "startup_opportunity.artifact_envelope.current" &&
          envelope.artifact_type === "startup_opportunity.discovery_candidate.v1" &&
          envelope.document.revision === 1,
      ),
  });
  return { root, runsRoot, runId, validator, bundle, store };
}

function waveRequest(
  runId: string,
  task: Record<string, unknown>,
  operation: "validate_only" | "publish" = "validate_only",
): Record<string, unknown> {
  const commercial = task.commercial_research_requirements as Record<string, unknown>;
  return {
    schema_version: "startup_opportunity.formal_stage_materialization_request.current",
    request_id: "formal_wave_request",
    run_id: runId,
    operation,
    created_at: createdAt,
    stage_kind: "discovery_wave",
    wave: {
      wave_id: "wave_discovery_synthetic",
      stage_id: "stage_candidate_evaluation",
      stage_kind: "candidate_evaluation",
      unit_ids: ["unit_counterfactual"],
      lanes: [
        {
          unit_id: "unit_counterfactual",
          lane_role: "evaluation",
          candidate_scope: {
            kind: "explicit",
            candidate_refs: [G22_DEMAND_R1, G22_BASELINE_R1, G22_SOLUTION_R1],
          },
          incumbent_response_assignment: {
            analysis_depth: "lightweight_scan",
            assignment_role: "owner",
            subject_refs: [G22_DEMAND_R1, G22_BASELINE_R1, G22_SOLUTION_R1],
            rationale: "SYNTHETIC bounded incumbent scan; no research was performed.",
          },
          reporting_dimensions: ["demand", "buyer", "counterevidence"],
          time_budget_minutes: 10,
          max_sources: 5,
          straggler_policy: {
            on_timeout: "publish_partial",
            grace_minutes: 2,
            blocks_stage: true,
          },
          commercial_research_semantics: {
            research_stage: commercial.research_stage,
            planned_queries: commercial.planned_queries,
            quantitative_competitive_scope: commercial.quantitative_competitive_scope,
            required_commercial_dimensions: commercial.required_commercial_dimensions,
            commercial_audit_output_path: commercial.commercial_audit_output_path,
          },
          task_semantics: {
            target_candidate_refs: [G22_DEMAND_R1, G22_BASELINE_R1, G22_SOLUTION_R1],
            source_phase: "candidate_evaluation",
            required_source_group_ids: ["source_group_agent_declared"],
            required_stances: ["support", "oppose"],
            stop_conditions: ["SYNTHETIC Agent-authored stop condition."],
            execution_contract: task.execution_contract,
          },
        },
      ],
      research_depth: "quick",
      total_time_budget_minutes: 10,
      resource_allocation: commercial.resource_allocation,
      gate_before: null,
      gate_after: "required",
      limitations: ["SYNTHETIC materialization test; no research was performed."],
    },
  };
}

test("wave materialization projects one Plan Unit into exact Execution, Dispatch, and Task bindings without writes", async (t) => {
  const state = await prepareRun(t, "wave");
  const task = fixtureEffective(state.bundle, G22_EVALUATION_TASK);
  const runRoot = path.join(state.runsRoot, state.runId);
  const before = await snapshotTree(runRoot);
  const result = await new FormalStageMaterializer(
    state.runsRoot,
    state.validator,
    repositoryRoot,
  ).materialize(waveRequest(state.runId, task));
  assert.equal(result.status, "validated");
  assert.deepEqual(await snapshotTree(runRoot), before);
  assert.deepEqual(result.artifacts.map((entry) => entry.artifact_type).sort(), [
    "startup_opportunity.dispatch_batch.discovery.current",
    "startup_opportunity.research_execution_plan.discovery.current",
    "startup_opportunity.research_task.discovery_candidate.current",
  ]);
  const envelopes = result.compilation.compiled_envelopes;
  const execution = envelopes.find((entry) =>
    entry.artifact_type.startsWith("startup_opportunity.research_execution_plan."),
  );
  const dispatch = envelopes.find((entry) =>
    entry.artifact_type.startsWith("startup_opportunity.dispatch_batch."),
  );
  const canonicalTask = envelopes.find((entry) =>
    entry.artifact_type.startsWith("startup_opportunity.research_task."),
  );
  assert.ok(execution && dispatch && canonicalTask);
  const executionStage = (execution.document.stages as Record<string, unknown>[])[0];
  assert.ok(executionStage);
  const lane = (executionStage.lanes as Record<string, unknown>[])[0];
  const dispatchTask = (dispatch.document.tasks as Record<string, unknown>[])[0];
  assert.equal(lane?.unit_id, "unit_counterfactual");
  assert.equal(dispatchTask?.unit_id, lane?.unit_id);
  assert.equal(canonicalTask.document.unit_id, lane?.unit_id);
  assert.equal(canonicalTask.document.research_goal, dispatchTask?.research_goal);
  assert.equal(canonicalTask.document.allowed_output_path, lane?.submission_path);
  assert.equal(canonicalTask.document.required_artifact_schema, lane?.submission_schema);
});

test("wave materialization rejects duplicate Lane claims and never defaults missing Agent semantics", async (t) => {
  const state = await prepareRun(t, "wave-negative");
  const task = fixtureEffective(state.bundle, G22_EVALUATION_TASK);
  const duplicate = waveRequest(state.runId, task);
  const wave = duplicate.wave as Record<string, unknown>;
  wave.lanes = [...(wave.lanes as Record<string, unknown>[]), (wave.lanes as unknown[])[0]];
  await assert.rejects(
    new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot).materialize(
      duplicate,
    ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "formal_materialization.wave_lane_set_mismatch",
  );

  const incomplete = waveRequest(state.runId, task);
  const lane = ((incomplete.wave as Record<string, unknown>).lanes as Record<string, unknown>[])[0];
  assert.ok(lane);
  delete (lane.task_semantics as Record<string, unknown>).stop_conditions;
  await assert.rejects(
    new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot).materialize(
      incomplete,
    ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "formal_materialization.request_invalid",
  );
});

test("formal stage publish consumes the exact validation plan and replay rejects changed semantics", async (t) => {
  const state = await prepareRun(t, "wave-publication-plan");
  const task = fixtureEffective(state.bundle, G22_EVALUATION_TASK);
  const materializer = new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const request = waveRequest(state.runId, task);
  const validated = await materializer.materialize(request);
  const published = await materializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: validated.compilation.publication_plan,
  });
  assert.equal(published.status, "published");
  const replay = await materializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: validated.compilation.publication_plan,
  });
  assert.equal(replay.status, "idempotent_replay");

  const changed = structuredClone(request);
  const lane = ((changed.wave as Record<string, unknown>).lanes as Record<string, unknown>[])[0];
  assert.ok(lane);
  lane.max_sources = Number(lane.max_sources) + 1;
  const before = await snapshotTree(path.join(state.runsRoot, state.runId));
  await assert.rejects(
    materializer.materialize({
      ...changed,
      operation: "publish",
      publication_plan: validated.compilation.publication_plan,
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "formal_materialization.publication_plan_semantics_mismatch",
  );
  assert.deepEqual(await snapshotTree(path.join(state.runsRoot, state.runId)), before);
});

test("public CLI authors a clean setup through adaptation without internal publication calls", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "formal-author-cli-acceptance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "formal-author-cli-acceptance";
  const runRoot = path.join(runsRoot, runId);
  const cli = (...args: string[]) => runCli([...args, "--runs-root", runsRoot]);
  const materialize = async (
    request: Record<string, unknown>,
    filename: string,
  ): Promise<Record<string, unknown>> => {
    const validationFile = await writeJson(root, `${filename}-validate.json`, request);
    const before = await snapshotTree(runRoot);
    const validated = parseCli<Record<string, unknown>>(
      cli("materialize-formal-stage", "--file", validationFile),
    );
    assert.equal(validated.status, "validated");
    assert.deepEqual(
      await snapshotTree(runRoot),
      before,
      `${filename} validate_only wrote Run state`,
    );
    const compilation = validated.compilation as Record<string, unknown>;
    const publishFile = await writeJson(root, `${filename}-publish.json`, {
      ...request,
      operation: "publish",
      publication_plan: compilation.publication_plan,
    });
    const published = parseCli<Record<string, unknown>>(
      cli("materialize-formal-stage", "--file", publishFile),
    );
    assert.equal(published.status, "published");
    return { ...published, publishFile };
  };

  const created = parseCli<{
    manifest: { scope_revision: number };
    scopeProposalRef: string;
    scopeProposalHash: string;
  }>(
    cli(
      "create-run",
      "--run-id",
      runId,
      "--mode",
      "opportunity_discovery",
      "--geography",
      "synthetic-primary-market",
      "--customer-model",
      "b2c",
      "--target-user",
      "SYNTHETIC primary user; not Evidence or external validation.",
      "--decision-goal",
      "SYNTHETIC identify directions that merit further validation; not Evidence or external validation.",
      "--research-language",
      "en-US",
      "--created-at",
      createdAt,
    ),
  );
  parseCli(
    cli(
      "confirm-scope",
      "--run-id",
      runId,
      "--expected-scope-proposal-revision",
      String(created.manifest.scope_revision),
      "--expected-scope-proposal-ref",
      created.scopeProposalRef,
      "--expected-scope-proposal-hash",
      created.scopeProposalHash,
      "--user-confirmation-attestation",
      "The synthetic acceptance caller attests exact user confirmation.",
      "--confirmed-at",
      "2026-08-19T09:00:01Z",
    ),
  );

  const sourceFixture = await createDiscoveryCandidateFixture();
  const replacements = new Map([[G22_RUN_ID, runId]]);
  const documentAt = (artifactPath: string): Record<string, unknown> =>
    replaceExactStrings(fixtureEffective(sourceFixture, artifactPath), replacements) as Record<
      string,
      unknown
    >;
  const plan = documentAt(G21_PLAN_REF);
  const context = {
    schema_version: "startup_opportunity.planning_context.ai_source_bound.current",
    context_id: "planning_context_formal_author_cli_acceptance",
    revision: 1,
    parent_context_ref: null,
    run_id: runId,
    mode: "opportunity_discovery",
    phase: "discovery",
    validation_stage: "initial_plan",
    manifest_binding: {
      manifest_ref: "manifest.json",
      manifest_schema_version: "startup_opportunity.run_manifest.v1",
      run_id: runId,
      mode: "opportunity_discovery",
      current_plan_ref: null,
      current_plan_revision: 0,
      run_state_hash: planningRunStateHash({
        manifest_ref: "manifest.json",
        manifest_schema_version: "startup_opportunity.run_manifest.v1",
        run_id: runId,
        mode: "opportunity_discovery",
        current_plan_ref: null,
        current_plan_revision: 0,
      }),
    },
    target_plan_binding: {
      plan_ref: G21_PLAN_REF,
      plan_schema_version: "startup_opportunity.research_plan.v1",
      plan_id: plan.plan_id,
      plan_revision: plan.revision,
      plan_content_hash: canonicalContentHash(plan),
    },
    ai_mandatory_coverage: {
      status: "not_required",
      trigger_version: "startup_opportunity.ai_mandatory_coverage_trigger.v1",
      basis: {
        signal: "none",
        declared_value: "not_applicable",
        subject_ref: null,
        source_ref: null,
        source_schema_version: null,
        source_content_hash: null,
      },
      required_dimensions: [],
    },
    producer_role: "main_agent",
    created_at: createdAt,
  };
  const initialArtifacts = [
    ...G21_CORE_REFS.slice(0, 3).map((artifactPath) => ({
      artifact_type: String(documentAt(artifactPath).schema_version),
      artifact_path: artifactPath,
      producer_role: "main_agent",
      document: documentAt(artifactPath),
    })),
    {
      artifact_type: "startup_opportunity.research_plan.v1",
      artifact_path: G21_PLAN_REF,
      producer_role: "main_agent",
      document: plan,
    },
    {
      artifact_type: String(context.schema_version),
      artifact_path: "plans/planning-context.r1.json",
      producer_role: "main_agent",
      document: context,
    },
  ];
  const planValidationRequest = compileRequest(
    runId,
    "request_formal_author_initial_plan",
    initialArtifacts,
  );
  const planValidationFile = await writeJson(
    root,
    "initial-plan-validate.json",
    planValidationRequest,
  );
  const beforePlanValidation = await snapshotTree(runRoot);
  const planValidated = parseCli<Record<string, unknown>>(
    cli("compile-artifacts", "--file", planValidationFile),
  );
  assert.equal(planValidated.status, "validated");
  assert.deepEqual(await snapshotTree(runRoot), beforePlanValidation);
  const planPublishFile = await writeJson(root, "initial-plan-publish.json", {
    ...planValidationRequest,
    operation: "publish",
    artifacts: [],
    publication_plan: planValidated.publication_plan,
  });
  assert.equal(
    parseCli<{ status: string }>(cli("compile-artifacts", "--file", planPublishFile)).status,
    "published",
  );
  assert.equal(
    parseCli<{ status: string }>(cli("compile-artifacts", "--file", planPublishFile)).status,
    "idempotent_replay",
  );

  const seed = documentAt(G21_SEED_REF);
  const opportunityMap = documentAt(G21_OPPORTUNITY_REF);
  const solutionMap = documentAt(G21_SOLUTION_REF);
  const candidate = documentAt(G22_DEMAND_R1);
  const setupRequest = {
    schema_version: "startup_opportunity.formal_stage_materialization_request.current",
    request_id: "formal_author_setup",
    run_id: runId,
    operation: "validate_only",
    created_at: "2026-08-19T09:01:00Z",
    stage_kind: "discovery_setup",
    artifacts: [
      {
        local_key: "seed",
        object_id: seed.seed_probe_id,
        document: seed,
      },
      {
        local_key: "opportunity-map",
        object_id: opportunityMap.map_id,
        document: opportunityMap,
        local_refs: { seed_probe_ref: "seed" },
      },
      {
        local_key: "solution-map",
        object_id: solutionMap.map_id,
        document: solutionMap,
        local_refs: {
          seed_probe_ref: "seed",
          opportunity_space_map_ref: "opportunity-map",
        },
      },
      {
        local_key: "candidate-demand",
        object_id: candidate.candidate_id,
        document: candidate,
        local_refs: { "/map_lineage/source_map_ref": "opportunity-map" },
      },
    ],
  };
  const setupPublished = await materialize(setupRequest, "setup");
  const setupArtifacts = setupPublished.artifacts as Record<string, unknown>[];
  const setupEnvelopes = (setupPublished.compilation as Record<string, unknown>)
    .compiled_envelopes as FormalArtifactEnvelope[];
  const setupCandidateEnvelope = setupEnvelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.discovery_candidate.v1",
  );
  assert.ok(setupCandidateEnvelope);
  const candidateRef = String(
    setupArtifacts.find(
      (entry) => entry.artifact_type === "startup_opportunity.discovery_candidate.v1",
    )?.artifact_path,
  );
  assert.equal(candidateRef, G22_DEMAND_R1);

  const planWave = (plan.waves as Record<string, unknown>[])[0] as Record<string, unknown>;
  const generationTaskTemplate = documentAt(G22_GENERATION_TASK);
  const evaluationTaskTemplate = documentAt(G22_EVALUATION_TASK);
  const generationCommercial = generationTaskTemplate.commercial_research_requirements as Record<
    string,
    unknown
  >;
  const commercial = evaluationTaskTemplate.commercial_research_requirements as Record<
    string,
    unknown
  >;
  const waveRequestValue = {
    schema_version: "startup_opportunity.formal_stage_materialization_request.current",
    request_id: "formal_author_wave",
    run_id: runId,
    operation: "validate_only",
    created_at: "2026-08-19T09:02:00Z",
    stage_kind: "discovery_wave",
    top_level_formal_refs: G21_MAP_REFS,
    wave: {
      wave_id: planWave.wave_id,
      stage_id: "stage_formal_author_cli",
      stage_kind: "candidate_evaluation",
      unit_ids: ["unit_seed_independent_demand", "unit_counterfactual"],
      lanes: [
        {
          unit_id: "unit_seed_independent_demand",
          lane_role: "evaluation",
          candidate_scope: { kind: "explicit", candidate_refs: [candidateRef] },
          incumbent_response_assignment: {
            analysis_depth: "not_assigned",
            assignment_role: "none",
            subject_refs: [],
            rationale: "This Lane does not own the incumbent response scan.",
          },
          reporting_dimensions: ["generation_context"],
          time_budget_minutes: 10,
          max_sources: 5,
          straggler_policy: {
            on_timeout: "publish_partial",
            grace_minutes: 2,
            blocks_stage: false,
          },
          commercial_research_semantics: {
            research_stage: generationCommercial.research_stage,
            planned_queries: generationCommercial.planned_queries,
            quantitative_competitive_scope: generationCommercial.quantitative_competitive_scope,
            required_commercial_dimensions: generationCommercial.required_commercial_dimensions,
            commercial_audit_output_path: generationCommercial.commercial_audit_output_path,
          },
          task_semantics: {
            target_candidate_refs: [candidateRef],
            source_phase: "candidate_generation",
            required_source_group_ids: ["source_group_cli_generation"],
            required_stances: ["support", "oppose"],
            stop_conditions: ["Stop at the explicit source and time budget."],
            execution_contract: generationTaskTemplate.execution_contract,
          },
        },
        {
          unit_id: "unit_counterfactual",
          lane_role: "evaluation",
          candidate_scope: { kind: "explicit", candidate_refs: [candidateRef] },
          incumbent_response_assignment: {
            analysis_depth: "lightweight_scan",
            assignment_role: "owner",
            subject_refs: [candidateRef],
            rationale: "This bounded evaluation Lane owns the explicit incumbent response scan.",
          },
          reporting_dimensions: ["conflicting_context"],
          time_budget_minutes: 10,
          max_sources: 5,
          straggler_policy: {
            on_timeout: "publish_partial",
            grace_minutes: 2,
            blocks_stage: false,
          },
          commercial_research_semantics: {
            research_stage: commercial.research_stage,
            planned_queries: commercial.planned_queries,
            quantitative_competitive_scope: commercial.quantitative_competitive_scope,
            required_commercial_dimensions: commercial.required_commercial_dimensions,
            commercial_audit_output_path: commercial.commercial_audit_output_path,
          },
          task_semantics: {
            target_candidate_refs: [candidateRef],
            source_phase: "candidate_evaluation",
            required_source_group_ids: ["source_group_cli_author"],
            required_stances: ["support", "oppose"],
            stop_conditions: ["Stop at the explicit source and time budget."],
            execution_contract: evaluationTaskTemplate.execution_contract,
          },
        },
      ],
      research_depth: "quick",
      total_time_budget_minutes: 20,
      resource_allocation: commercial.resource_allocation,
      gate_before: null,
      gate_after: "required",
      limitations: ["SYNTHETIC public CLI acceptance; no external research was performed."],
    },
  };
  const wavePublished = await materialize(waveRequestValue, "wave");
  const waveCompilation = wavePublished.compilation as Record<string, unknown>;
  const waveEnvelopes = waveCompilation.compiled_envelopes as FormalArtifactEnvelope[];
  const generationTaskEnvelope = waveEnvelopes.find(
    (entry) => entry.document.unit_id === "unit_seed_independent_demand",
  );
  const taskEnvelope = waveEnvelopes.find(
    (entry) => entry.document.unit_id === "unit_counterfactual",
  );
  const dispatchEnvelope = waveEnvelopes.find((entry) =>
    entry.artifact_type.startsWith("startup_opportunity.dispatch_batch."),
  );
  const executionEnvelope = waveEnvelopes.find((entry) =>
    entry.artifact_type.startsWith("startup_opportunity.research_execution_plan."),
  );
  assert.ok(generationTaskEnvelope && taskEnvelope && dispatchEnvelope && executionEnvelope);
  const checklist = parseCli<{
    formal_artifact: boolean;
    additional_material_allowed: boolean;
    checklist: readonly unknown[];
  }>(cli("scaffold-lane-submission", "--run-id", runId, "--task-ref", taskEnvelope.artifact_path));
  assert.equal(checklist.formal_artifact, false);
  assert.equal(checklist.additional_material_allowed, true);
  assert.ok(checklist.checklist.length > 1);

  const rawEvidenceFile = path.join(root, "lane-background.txt");
  await writeFile(
    rawEvidenceFile,
    "SYNTHETIC weak background and opposing material; no external validation.\n",
  );
  const recorded = parseCli<{
    record: {
      evidence_id: string;
      source_hash: string;
      content_hash: string;
      raw_content_ref: string;
      operation_key: string;
      recorded_at: string;
    };
  }>(
    cli(
      "record-evidence",
      "--run-id",
      runId,
      "--unit-id",
      "unit_counterfactual",
      "--source-uri",
      "urn:startup-opportunity:user-provided:formal-author-cli-background",
      "--research-goal",
      "Preserve weak, opposing, background, and conflicting material without upgrading it.",
      "--content-file",
      rawEvidenceFile,
      "--recorded-at",
      "2026-08-19T09:03:00Z",
    ),
  );
  const generationRawEvidenceFile = path.join(root, "lane-generation-context.txt");
  await writeFile(
    generationRawEvidenceFile,
    "SYNTHETIC weak generation context; no external validation.\n",
  );
  const generationRecorded = parseCli<{
    record: {
      evidence_id: string;
      source_hash: string;
      content_hash: string;
      raw_content_ref: string;
      operation_key: string;
      recorded_at: string;
    };
  }>(
    cli(
      "record-evidence",
      "--run-id",
      runId,
      "--unit-id",
      "unit_seed_independent_demand",
      "--source-uri",
      "urn:startup-opportunity:user-provided:formal-author-cli-generation-context",
      "--research-goal",
      "Preserve weak generation context without upgrading it.",
      "--content-file",
      generationRawEvidenceFile,
      "--recorded-at",
      "2026-08-19T09:03:01Z",
    ),
  );
  const evidenceReceiptRef = `evidence/manifest.jsonl#${recorded.record.evidence_id}`;
  const evidenceRef = `evidence/records/${recorded.record.evidence_id}.json`;
  const generationEvidenceReceiptRef = `evidence/manifest.jsonl#${generationRecorded.record.evidence_id}`;
  const generationEvidenceRef = `evidence/records/${generationRecorded.record.evidence_id}.json`;
  const claimRef = "claims/discovery/claim_cli_opposing.json";
  const generationClaimRef = "claims/discovery/claim_cli_generation_support.json";
  const findingRef = "findings/discovery/finding_cli_conflict.json";
  const generationFindingRef = "findings/discovery/finding_cli_generation_context.json";
  const judgmentRef = "judgments/discovery/judgment_cli_insufficient.json";
  const generationJudgmentRef = "judgments/discovery/judgment_cli_generation_context.json";
  const sourceManifestRef =
    "evidence/source-manifests/discovery/source_manifest_cli_background.json";
  const generationSourceManifestRef =
    "evidence/source-manifests/discovery/source_manifest_cli_generation.json";
  const auditRef = String(
    (taskEnvelope.document.commercial_research_requirements as Record<string, unknown>)
      .commercial_audit_output_path,
  );
  const generationAuditRef = String(
    (generationTaskEnvelope.document.commercial_research_requirements as Record<string, unknown>)
      .commercial_audit_output_path,
  );
  const typedEvidence = {
    source_type: "synthetic_contract_fixture",
    source_name: "SYNTHETIC caller-supplied background material",
    research_goal: "Retain weak opposing context without promoting it.",
    research_phase_role: "candidate_evaluation",
    geo: "Synthetic",
    language: "en-US",
    source_group_id: "source_group_cli_author",
    provenance: {
      acquisition_method: "synthetic_fixture_only",
      source_owner: "Synthetic fixture caller",
      original_creator: "Synthetic fixture caller",
      method_notes: "No retrieval or external research occurred.",
    },
    source_assessment: {
      independence: "unknown",
      canonical_source_group: "source_group_cli_author",
      shared_dataset_group: null,
      syndication_group: null,
      biases: ["sampling_method_unknown"],
      bias_notes: "The material is weak and non-representative.",
    },
    evidence_tier: "model_inference_only",
    evidence_lifecycle_status: "unverified",
    evidence_role: "context",
    representativeness: "Unknown and not representative.",
    valid_as_of: "2026-08-19",
    freshness_policy: "synthetic_fixture_only",
    limitations: ["Weak background material cannot establish demand."],
  };
  const generationTypedEvidence = {
    ...structuredClone(typedEvidence),
    source_name: "SYNTHETIC caller-supplied generation context",
    research_goal: "Retain weak generation context without promoting it.",
    research_phase_role: "candidate_generation",
    source_group_id: "source_group_cli_generation",
    source_assessment: {
      ...structuredClone(typedEvidence.source_assessment),
      canonical_source_group: "source_group_cli_generation",
    },
    evidence_role: "support",
    limitations: ["Weak generation context cannot establish demand."],
  };
  const claim = {
    claim_id: "claim_cli_opposing",
    claim_type: "counter_evidence",
    statement: "The weak material opposes a stronger demand interpretation.",
    stance: "oppose",
    evidence_refs: [evidenceRef],
    confidence_band: "low",
    sample_bias: "Sampling and independence are unknown.",
    limitations: ["This Claim is weak and conflicting."],
  };
  const finding = {
    finding_id: "finding_cli_conflict",
    summary: "Supporting hypotheses and the opposing weak Claim remain in conflict.",
    claim_refs: [claimRef],
    opposing_claim_refs: [claimRef],
    confidence_band: "unknown",
    limitations: ["No conflict is mechanically resolved."],
  };
  const judgment = {
    judgment_id: "judgment_cli_insufficient",
    subject_ref: candidateRef,
    dimension: "counter_evidence",
    judgment_signal: "opposed",
    evidence_tier_summary: ["model_inference_only"],
    supporting_refs: [],
    opposing_refs: [claimRef],
    representativeness: "Unknown.",
    independence: "Unknown.",
    decision_sufficiency: "insufficient",
    insufficiency_reasons: ["Only weak, conflicting material is available."],
    what_would_change_the_decision: ["Independent current Evidence."],
    valid_as_of: "2026-08-19",
    limitations: ["The Judgment remains insufficient."],
    validation_success_claimed: false,
  };
  const sourceManifest = {
    manifest_id: "source_manifest_cli_background",
    research_phase_role: "candidate_evaluation",
    accepted_evidence_refs: [evidenceRef],
    canonical_source_groups: [
      { group_id: "source_group_cli_author", evidence_refs: [evidenceRef] },
    ],
    shared_dataset_groups: [],
    duplicate_or_syndication_groups: [],
    source_type_coverage: ["synthetic_contract_fixture"],
    geo_language_coverage: ["Synthetic en-US context only."],
    time_coverage: ["2026-08-19 synthetic fixture date."],
    stance_coverage: ["context"],
    known_source_blind_spots: ["No independent source was available."],
    freshness_summary: { active: 0, stale: 0, unverified: 1, superseded: 0 },
    limitations: ["Background material remains weak and unverified."],
  };
  const generationSourceManifest = {
    manifest_id: "source_manifest_cli_generation",
    research_phase_role: "candidate_generation",
    accepted_evidence_refs: [generationEvidenceRef],
    canonical_source_groups: [
      {
        group_id: "source_group_cli_generation",
        evidence_refs: [generationEvidenceRef],
      },
    ],
    shared_dataset_groups: [],
    duplicate_or_syndication_groups: [],
    source_type_coverage: ["synthetic_contract_fixture"],
    geo_language_coverage: ["Synthetic en-US context only."],
    time_coverage: ["2026-08-19 synthetic fixture date."],
    stance_coverage: ["support"],
    known_source_blind_spots: ["No independent generation source was available."],
    freshness_summary: { active: 0, stale: 0, unverified: 1, superseded: 0 },
    limitations: ["Generation context remains weak and unverified."],
  };
  const generationClaim = {
    claim_id: "claim_cli_generation_support",
    claim_type: "behavior_signal",
    statement: "Weak generation context provides a bounded supporting signal only.",
    stance: "support",
    evidence_refs: [generationEvidenceRef],
    confidence_band: "low",
    sample_bias: "Sampling and independence are unknown.",
    limitations: ["This Claim is weak and not sufficient for a Demand Thesis."],
  };
  const generationFinding = {
    finding_id: "finding_cli_generation_context",
    summary: "Generation context is weak and remains bounded alongside opposing material.",
    claim_refs: [generationClaimRef],
    opposing_claim_refs: [],
    confidence_band: "unknown",
    limitations: ["No generation conclusion is mechanically upgraded."],
  };
  const generationJudgment = {
    ...structuredClone(judgment),
    judgment_id: "judgment_cli_generation_context",
    dimension: "demand_signal",
    judgment_signal: "supported",
    supporting_refs: [generationClaimRef],
    opposing_refs: [],
    limitations: ["The generation Judgment remains insufficient."],
  };
  const laneResult = {
    status: "partial",
    research_goals: [String(taskEnvelope.document.research_goal)],
    queries: ["SYNTHETIC bounded query; no network research was performed."],
    evidence_lineage: {
      evidence_refs: [evidenceRef],
      claim_refs: [claimRef],
      finding_refs: [findingRef],
      insight_refs: [],
      judgment_assessment_refs: [judgmentRef],
      source_manifest_refs: [sourceManifestRef],
      audit_refs: [auditRef],
    },
    scope_outcomes: [
      {
        scope_key: "conflicting_context",
        disposition: "partial",
        evidence_refs: [evidenceRef],
        claim_refs: [claimRef],
        finding_refs: [findingRef],
        judgment_assessment_refs: [judgmentRef],
        notes: "Extra background and opposing material remains visible and unresolved.",
      },
      {
        scope_key: "buyer_unknown_extra",
        disposition: "unknown",
        evidence_refs: [],
        claim_refs: [],
        finding_refs: [],
        judgment_assessment_refs: [],
        notes: "An extra legitimate observation remains unknown.",
      },
      {
        scope_key: "route_unavailable_extra",
        disposition: "unavailable",
        evidence_refs: [],
        claim_refs: [],
        finding_refs: [],
        judgment_assessment_refs: [],
        notes: "One acquisition route was unavailable.",
      },
      {
        scope_key: "proxy_inferred_extra",
        disposition: "inferred",
        evidence_refs: [evidenceRef],
        claim_refs: [],
        finding_refs: [],
        judgment_assessment_refs: [],
        notes: "This is explicitly inferred, not observed.",
      },
      {
        scope_key: "not_applicable_extra",
        disposition: "not_applicable",
        evidence_refs: [],
        claim_refs: [],
        finding_refs: [],
        judgment_assessment_refs: [],
        notes: "This extra dimension is not applicable.",
      },
      {
        scope_key: "no_evidence_extra",
        disposition: "no_evidence_found",
        evidence_refs: [],
        claim_refs: [],
        finding_refs: [],
        judgment_assessment_refs: [],
        notes: "No Evidence was found for this distinct extra dimension.",
      },
    ],
    scored_candidates: [
      {
        candidate_ref: candidateRef,
        score: 2,
        supporting_refs: [],
        opposing_refs: [claimRef],
        rationale: "Weak opposing context prevents a stronger triage signal.",
        limitations: ["Not comparable beyond this Lane."],
      },
    ],
    pre_kill_decisions: [
      {
        disposition_id: "disposition_cli_candidate",
        candidate_ref: candidateRef,
        disposition: "retained",
        retention_basis: "counterfactual",
        reasons: ["Retain the Candidate to preserve the unresolved counterfactual."],
        triggered_kill_conditions: [],
        missing_required_evidence: ["Independent current Evidence."],
        judgment_assessment_refs: [judgmentRef],
        highest_allowed_stage: "cross_lane_synthesis",
        what_would_reverse_decision: ["Strong independent opposing Evidence."],
      },
    ],
    retained_candidate_refs: [candidateRef],
    watchlist_candidate_refs: [],
    rejected_candidate_refs: [],
    candidate_diversity_summary: {
      covered_users: [],
      covered_jobs: [],
      covered_entry_scenes: [],
      covered_buyer_models: [],
      covered_candidate_kinds: ["demand_seed"],
      diversity_retention_refs: [candidateRef],
      counterfactual_candidate_refs: [candidateRef],
      known_blind_spots: ["Weak, opposing, and background material remains unresolved."],
    },
    decision_sufficiency_summary: {
      status: "insufficient",
      insufficiency_reasons: ["The partial Lane has only weak conflicting material."],
      what_would_change_the_decision: ["Independent current Evidence."],
    },
    open_questions: ["Does independent Evidence change the retained counterfactual?"],
    reference_only: true,
    source_boundary: taskEnvelope.document.execution_contract,
    limitations: ["Partial and insufficient-evidence status is preserved."],
  };
  const generationLaneResult = {
    ...structuredClone(laneResult),
    research_goals: [String(generationTaskEnvelope.document.research_goal)],
    evidence_lineage: {
      evidence_refs: [generationEvidenceRef],
      claim_refs: [generationClaimRef],
      finding_refs: [generationFindingRef],
      insight_refs: [],
      judgment_assessment_refs: [generationJudgmentRef],
      source_manifest_refs: [generationSourceManifestRef],
      audit_refs: [generationAuditRef],
    },
    scope_outcomes: [
      {
        scope_key: "generation_context",
        disposition: "partial",
        evidence_refs: [generationEvidenceRef],
        claim_refs: [generationClaimRef],
        finding_refs: [generationFindingRef],
        judgment_assessment_refs: [generationJudgmentRef],
        notes: "Weak generation context remains partial and does not establish demand.",
      },
    ],
    scored_candidates: [
      {
        candidate_ref: candidateRef,
        score: 2,
        supporting_refs: [generationClaimRef],
        opposing_refs: [],
        rationale: "Weak generation context is retained without a stronger triage signal.",
        limitations: ["Not comparable beyond this Lane."],
      },
    ],
    pre_kill_decisions: [
      {
        disposition_id: "disposition_cli_generation_candidate",
        candidate_ref: candidateRef,
        disposition: "retained",
        retention_basis: "diversity",
        reasons: ["Retain the weak generation context alongside opposing material."],
        triggered_kill_conditions: [],
        missing_required_evidence: ["Independent current Evidence."],
        judgment_assessment_refs: [generationJudgmentRef],
        highest_allowed_stage: "cross_lane_synthesis",
        what_would_reverse_decision: ["Strong independent opposing Evidence."],
      },
    ],
    source_boundary: generationTaskEnvelope.document.execution_contract,
    limitations: ["Generation context remains partial and insufficient."],
  };
  const commercialDelivery = {
    audited_at: "2026-08-19T09:04:00Z",
    research_objectives: ["Disclose that current commercial Evidence is unavailable."],
    primary_routes: ["Caller-provided synthetic material only."],
    search_results: [],
    evidence_sources: [],
    findings: [],
    claims: [],
    judgments: [],
    quantitative_observations: [],
    competitive_observations: [],
    incumbent_response_assessments: [],
    unresolved_gaps: [],
    limitations: ["No commercial conclusion is upgraded."],
    stop_reason: "The bounded synthetic fixture has no current commercial Evidence.",
    telemetry_basis: "unavailable",
    query_log_complete: false,
  };
  const generationLaneStaging = {
    schema_version: "startup_opportunity.lane_staging_document.current",
    staging_id: "staging_formal_author_cli_generation",
    run_id: runId,
    task_ref: generationTaskEnvelope.artifact_path,
    created_at: "2026-08-19T09:04:00Z",
    producer_role: "lane_researcher",
    operation: "validate_only",
    evidence_receipt_refs: [generationEvidenceReceiptRef],
    delivery_contract: {
      search_closure: {
        status: "completed",
        acquisition_routes_attempted: ["user_provided"],
        unresolved_gaps: ["Independent generation Evidence remains unavailable."],
        stop_reason: "The explicit time and source budget was reached.",
      },
    },
    agent_documents: [
      {
        artifact_family: "evidence",
        evidence_receipt_ref: generationEvidenceReceiptRef,
        document: generationTypedEvidence,
      },
      { artifact_family: "claim", document: generationClaim },
      { artifact_family: "finding", document: generationFinding },
      { artifact_family: "judgment", document: generationJudgment },
      { artifact_family: "source_manifest", document: generationSourceManifest },
      { artifact_family: "lane_result", document: generationLaneResult },
      { artifact_family: "commercial_audit", document: commercialDelivery },
    ],
  };
  const generationLaneValidationFile = await writeJson(
    root,
    "generation-lane-validate.json",
    generationLaneStaging,
  );
  const beforeGenerationLaneValidation = await snapshotTree(runRoot);
  const generationLaneValidated = parseCli<Record<string, unknown>>(
    cli("materialize-lane-result", "--file", generationLaneValidationFile),
  );
  assert.equal(generationLaneValidated.status, "accepted");
  assert.deepEqual(await snapshotTree(runRoot), beforeGenerationLaneValidation);
  const generationLaneCompilation = generationLaneValidated.compilation as Record<string, unknown>;
  const generationLanePublishFile = await writeJson(root, "generation-lane-publish.json", {
    ...generationLaneStaging,
    operation: "publish",
    publication_plan: generationLaneCompilation.publication_plan,
  });
  const generationLanePublished = parseCli<Record<string, unknown>>(
    cli("materialize-lane-result", "--file", generationLanePublishFile),
  );
  assert.equal(generationLanePublished.status, "accepted");
  assert.equal(
    (
      parseCli<Record<string, unknown>>(
        cli("materialize-lane-result", "--file", generationLanePublishFile),
      ).compilation as Record<string, unknown>
    ).status,
    "idempotent_replay",
  );
  const generationReceiptEnvelope =
    generationLanePublished.delivery_receipt as FormalArtifactEnvelope;
  const laneStaging = {
    schema_version: "startup_opportunity.lane_staging_document.current",
    staging_id: "staging_formal_author_cli",
    run_id: runId,
    task_ref: taskEnvelope.artifact_path,
    created_at: "2026-08-19T09:04:00Z",
    producer_role: "lane_researcher",
    operation: "validate_only",
    evidence_receipt_refs: [evidenceReceiptRef],
    delivery_contract: {
      search_closure: {
        status: "completed",
        acquisition_routes_attempted: ["user_provided"],
        unresolved_gaps: ["Independent Evidence remains unavailable."],
        stop_reason: "The explicit time and source budget was reached.",
      },
    },
    agent_documents: [
      {
        artifact_family: "evidence",
        evidence_receipt_ref: evidenceReceiptRef,
        document: typedEvidence,
      },
      { artifact_family: "claim", document: claim },
      { artifact_family: "finding", document: finding },
      { artifact_family: "judgment", document: judgment },
      { artifact_family: "source_manifest", document: sourceManifest },
      { artifact_family: "lane_result", document: laneResult },
      { artifact_family: "commercial_audit", document: commercialDelivery },
    ],
  };
  const laneValidationFile = await writeJson(root, "lane-validate.json", laneStaging);
  const beforeLaneValidation = await snapshotTree(runRoot);
  const laneValidated = parseCli<Record<string, unknown>>(
    cli("materialize-lane-result", "--file", laneValidationFile),
  );
  assert.equal(laneValidated.status, "accepted");
  assert.deepEqual(await snapshotTree(runRoot), beforeLaneValidation);
  const laneCompilation = laneValidated.compilation as Record<string, unknown>;
  const lanePublishFile = await writeJson(root, "lane-publish.json", {
    ...laneStaging,
    operation: "publish",
    publication_plan: laneCompilation.publication_plan,
  });
  const lanePublished = parseCli<Record<string, unknown>>(
    cli("materialize-lane-result", "--file", lanePublishFile),
  );
  assert.equal(lanePublished.status, "accepted");
  const laneReplay = parseCli<Record<string, unknown>>(
    cli("materialize-lane-result", "--file", lanePublishFile),
  );
  assert.equal((laneReplay.compilation as Record<string, unknown>).status, "idempotent_replay");
  const receiptEnvelope = lanePublished.delivery_receipt as FormalArtifactEnvelope;
  const delivered = receiptEnvelope.document.delivered_artifacts as Record<string, unknown>[];
  for (const deliveredRef of [
    evidenceRef,
    claimRef,
    findingRef,
    judgmentRef,
    sourceManifestRef,
    auditRef,
    taskEnvelope.document.allowed_output_path,
  ]) {
    assert.ok(
      delivered.some((entry) => entry.artifact_ref === deliveredRef),
      String(deliveredRef),
    );
  }

  const generationLaneResultRef = String(generationTaskEnvelope.document.allowed_output_path);
  const laneResultRef = String(taskEnvelope.document.allowed_output_path);
  const candidateRevision = structuredClone(setupCandidateEnvelope.document);
  candidateRevision.evidence_lineage = {
    evidence_refs: [generationEvidenceRef, evidenceRef],
    claim_refs: [generationClaimRef, claimRef],
    finding_refs: [generationFindingRef, findingRef],
    insight_refs: [],
    judgment_assessment_refs: [generationJudgmentRef, judgmentRef],
    source_manifest_refs: [generationSourceManifestRef, sourceManifestRef],
    audit_refs: [],
  };
  candidateRevision.source_partition = {
    generation_source_manifest_refs: [generationSourceManifestRef],
    evaluation_source_manifest_refs: [sourceManifestRef],
    overlap_source_group_ids: [],
    overlap_assessment: "none",
  };
  candidateRevision.enrichment = {
    revision_kind: "evidence_enrichment",
    changed_fields: [
      "evidence_lineage.evidence_refs",
      "evidence_lineage.claim_refs",
      "evidence_lineage.finding_refs",
      "evidence_lineage.judgment_assessment_refs",
      "evidence_lineage.source_manifest_refs",
      "source_partition",
      "limitations",
    ],
    basis_refs: [generationLaneResultRef, laneResultRef],
  };
  candidateRevision.limitations = [
    "Weak supporting and opposing context remains partial, conflicting, and insufficient.",
  ];
  const fanInRequest = {
    schema_version: "startup_opportunity.formal_stage_materialization_request.current",
    request_id: "formal_author_fan_in",
    run_id: runId,
    operation: "validate_only",
    created_at: "2026-08-19T09:05:00Z",
    stage_kind: "candidate_fan_in",
    fan_in: {
      dispatch_ref: dispatchEnvelope.artifact_path,
      lanes: [
        {
          unit_id: "unit_seed_independent_demand",
          status: "partial",
          lane_result_ref: generationLaneResultRef,
          delivery_receipt_ref: generationReceiptEnvelope.artifact_path,
          adopted_artifact_refs: [
            generationEvidenceRef,
            generationClaimRef,
            generationFindingRef,
            generationJudgmentRef,
            generationSourceManifestRef,
            generationAuditRef,
          ],
        },
        {
          unit_id: "unit_counterfactual",
          status: "partial",
          lane_result_ref: laneResultRef,
          delivery_receipt_ref: receiptEnvelope.artifact_path,
          adopted_artifact_refs: [
            evidenceRef,
            claimRef,
            findingRef,
            judgmentRef,
            sourceManifestRef,
            auditRef,
          ],
        },
      ],
    },
    artifacts: [
      {
        local_key: "candidate-demand-revision",
        object_id: candidateRevision.candidate_id,
        action: "revise",
        document: candidateRevision,
        local_refs: { parent: candidateRef },
      },
      {
        local_key: "fan-in",
        object_id: "fan_in_formal_author_cli",
        action: "create",
        document: {
          schema_version: "startup_opportunity.discovery_fan_in.v2",
          fan_in_id: "fan_in_formal_author_cli",
          candidate_dispositions: [
            {
              disposition_id: "fan_in_disposition_cli_candidate",
              candidate_ref: candidateRef,
              source_candidate_refs: [candidateRef],
              disposition: "retained",
              supporting_lane_result_refs: [generationLaneResultRef, laneResultRef],
              judgment_assessment_refs: [generationJudgmentRef, judgmentRef],
              rationale:
                "Retain the partial Candidate while weak opposing and background material remains visible.",
              limitations: ["Evidence remains weak, conflicting, and insufficient."],
            },
          ],
          candidate_diversity_summary: {
            preserved_dimensions: ["counterfactual", "conflicting_context"],
            diversity_retention_refs: [candidateRef],
            counterfactual_candidate_refs: [candidateRef],
            known_blind_spots: ["Independent buyer Evidence remains unavailable."],
          },
          evidence_sufficiency_summary: {
            status: "insufficient",
            insufficiency_reasons: ["Only partial weak and conflicting material is available."],
            what_would_change_the_decision: ["Independent current Evidence."],
          },
          opposing_evidence_summary: ["The explicit opposing Claim is retained."],
          pre_kill_summary: ["The Main Agent retained the unresolved counterfactual."],
          limitations: ["Fan-in is partial and does not establish validation."],
        },
        local_refs: {
          "/candidate_dispositions/0/candidate_ref": "candidate-demand-revision",
          "/candidate_diversity_summary/diversity_retention_refs": ["candidate-demand-revision"],
          "/candidate_diversity_summary/counterfactual_candidate_refs": [
            "candidate-demand-revision",
          ],
        },
      },
    ],
  };
  const fanInPublished = await materialize(fanInRequest, "fan-in");
  const fanInArtifacts = fanInPublished.artifacts as Record<string, unknown>[];
  const retainedCandidateRef = String(
    fanInArtifacts.find(
      (entry) => entry.artifact_type === "startup_opportunity.discovery_candidate.v1",
    )?.artifact_path,
  );
  assert.equal(retainedCandidateRef, "artifacts/discovery/candidates/candidate_demand.r2.json");
  const fanInRef = String(
    fanInArtifacts.find(
      (entry) => entry.artifact_type === "startup_opportunity.discovery_fan_in.v2",
    )?.artifact_path,
  );
  const fanInCompilation = fanInPublished.compilation as Record<string, unknown>;
  const fanInPlan = fanInCompilation.publication_plan as Record<string, unknown>;
  const staleFanInRequest = structuredClone(fanInRequest);
  const staleFanInArtifact = (staleFanInRequest.artifacts as Record<string, unknown>[]).find(
    (entry) =>
      (entry.document as Record<string, unknown>).schema_version ===
      "startup_opportunity.discovery_fan_in.v2",
  );
  assert.ok(staleFanInArtifact);
  const staleDisposition = (
    (staleFanInArtifact.document as Record<string, unknown>).candidate_dispositions as Record<
      string,
      unknown
    >[]
  )[0];
  assert.ok(staleDisposition);
  staleDisposition.rationale = "Changed after validation and therefore stale.";
  const staleFanInFile = await writeJson(root, "fan-in-stale.json", {
    ...staleFanInRequest,
    operation: "publish",
    publication_plan: fanInPlan,
  });
  const beforeStaleFanIn = await snapshotTree(runRoot);
  const staleFanIn = cli("materialize-formal-stage", "--file", staleFanInFile);
  assert.equal(staleFanIn.status, 1);
  assert.match(
    staleFanIn.stderr,
    /formal_materialization\.publication_plan_(?:semantics|authority)_mismatch/,
  );
  assert.deepEqual(await snapshotTree(runRoot), beforeStaleFanIn);

  const substrate = recorded.record as unknown as Parameters<
    typeof createDiscoverySynthesisFixture
  >[1]["generation"];
  const synthesisFixture = await createDiscoverySynthesisFixture(runId, {
    generation: substrate,
    evaluation: substrate,
  });
  const conversion = structuredClone(fixtureEffective(synthesisFixture, G23_DEMAND_CONVERSION));
  const demand = structuredClone(fixtureEffective(synthesisFixture, G23_DEMAND));
  demand.source_groups = {
    generation_source_manifest_refs: [generationSourceManifestRef],
    evaluation_source_manifest_refs: [sourceManifestRef],
    overlap_disclosures: [],
  };
  demand.supporting_claim_refs = [];
  demand.opposing_claim_refs = [claimRef];
  demand.judgment_assessment_refs = [judgmentRef];
  demand.audit_refs = [auditRef];
  demand.limitations = [
    "The Demand Thesis remains partial and insufficient; opposing background material is retained.",
  ];
  const synthesisRequest = {
    schema_version: "startup_opportunity.formal_stage_materialization_request.current",
    request_id: "formal_author_g2_3",
    run_id: runId,
    operation: "validate_only",
    created_at: "2026-08-19T09:06:00Z",
    stage_kind: "g2_3_synthesis",
    top_level_formal_refs: [
      fanInRef,
      retainedCandidateRef,
      claimRef,
      judgmentRef,
      generationSourceManifestRef,
      sourceManifestRef,
      auditRef,
    ],
    artifacts: [
      {
        local_key: "conversion",
        object_id: conversion.conversion_id,
        action: "create",
        document: conversion,
        local_refs: {
          source_candidate_ref: retainedCandidateRef,
          discovery_fan_in_ref: fanInRef,
          target_artifact_ref: "demand",
        },
      },
      {
        local_key: "demand",
        object_id: demand.demand_id,
        action: "create",
        document: demand,
        local_refs: {
          source_conversion_ref: "conversion",
          source_candidate_ref: retainedCandidateRef,
          discovery_fan_in_ref: fanInRef,
        },
      },
    ],
  };
  const synthesisPublished = await materialize(synthesisRequest, "g2-3");
  const synthesisCompilation = synthesisPublished.compilation as Record<string, unknown>;
  const synthesisEnvelopes = synthesisCompilation.compiled_envelopes as FormalArtifactEnvelope[];
  const demandEnvelope = synthesisEnvelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.demand_thesis.v1",
  );
  assert.ok(demandEnvelope);
  assert.deepEqual(demandEnvelope.document.opposing_claim_refs, [claimRef]);
  assert.match(String((demandEnvelope.document.limitations as string[])[0]), /partial/);

  const adaptationRequest = {
    schema_version: "startup_opportunity.adaptation_author_request.current",
    request_id: "formal_author_adaptation",
    run_id: runId,
    operation: "validate_only",
    top_level_formal_refs: [fanInRef, demandEnvelope.artifact_path],
    gap: {
      snapshot_id: "gap_formal_author_partial",
      created_at: "2026-08-19T09:07:00Z",
      trigger_kind: "wave_completed",
      trigger_event_ref: null,
      phase: "discovery",
      wave_id: String(planWave.wave_id),
      observed_artifact_refs: [fanInRef, demandEnvelope.artifact_path],
      material_new_evidence_observed: false,
      repeated_source_refs: [evidenceRef],
      machine_checks: [],
      semantic_gaps: [],
    },
    decisions: [
      {
        adaptation_id: "adapt_formal_author_stop_partial",
        cover_all_generated_gaps: true,
        action: "stop_followup",
        reason:
          "The bounded cycle remains partial and insufficient; no research conclusion is upgraded.",
        expected_decision_impact: ["next_action"],
        stop_condition: "No additional material exists inside the explicit bounded cycle.",
        requested_by: "main_agent",
        created_at: "2026-08-19T09:07:01Z",
      },
    ],
    apply_created_at: "2026-08-19T09:07:02Z",
    checkpoint_created_at: "2026-08-19T09:07:03Z",
    next_phase: "discovery",
    next_step: "Continue only under an explicit future Plan decision.",
    belief_summary: {
      current_belief: "The current material remains partial and insufficient.",
      evidence_that_changed_belief: [evidenceRef],
      unchanged_assumptions: ["No external validation has occurred."],
      remaining_disagreement: ["Weak opposing and background material remains unresolved."],
      next_decision_relevant_question:
        "Should an explicitly scoped later cycle gather independent Evidence?",
    },
  };
  const adaptationValidationFile = await writeJson(
    root,
    "adaptation-validate.json",
    adaptationRequest,
  );
  const beforeAdaptationValidation = await snapshotTree(runRoot);
  const adaptationValidated = parseCli<Record<string, unknown>>(
    cli("author-plan-adaptation", "--file", adaptationValidationFile),
  );
  assert.equal(adaptationValidated.status, "validated");
  assert.deepEqual(await snapshotTree(runRoot), beforeAdaptationValidation);
  const adaptationPublishFile = await writeJson(root, "adaptation-publish.json", {
    ...adaptationRequest,
    operation: "publish",
    publication_plan: adaptationValidated.publication_plan,
  });
  const adaptationPublished = parseCli<Record<string, unknown>>(
    cli("author-plan-adaptation", "--file", adaptationPublishFile),
  );
  assert.equal(adaptationPublished.status, "published");

  const staleApplyPlan = structuredClone(
    adaptationPublished.publication_plan as Record<string, unknown>,
  );
  staleApplyPlan.manifest_content_hash = `sha256:${"0".repeat(64)}`;
  const staleApplyFile = await writeJson(root, "adaptation-stale-apply.json", {
    ...adaptationRequest,
    operation: "apply",
    publication_plan: staleApplyPlan,
  });
  const beforeStaleApply = await snapshotTree(runRoot);
  const staleApply = cli("author-plan-adaptation", "--file", staleApplyFile);
  assert.equal(staleApply.status, 1);
  assert.match(staleApply.stderr, /adaptation\.author_publication_plan_stale/);
  assert.deepEqual(await snapshotTree(runRoot), beforeStaleApply);

  const applyFile = await writeJson(root, "adaptation-apply.json", {
    ...adaptationRequest,
    operation: "apply",
    publication_plan: adaptationPublished.publication_plan,
  });
  assert.equal(
    parseCli<{ status: string }>(cli("author-plan-adaptation", "--file", applyFile)).status,
    "applied",
  );
  assert.equal(
    parseCli<{ status: string }>(cli("author-plan-adaptation", "--file", applyFile)).status,
    "idempotent_replay",
  );
});

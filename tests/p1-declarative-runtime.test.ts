import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ArtifactStore,
  canonicalContentHash,
  canonicalJson,
  createArtifactValidator,
  DeclarativeRuntimeCompiler,
  type DocumentBundle,
  EvidenceStore,
  type FormalArtifactEnvelope,
  RunStore,
  StoreError,
  validateDeclarativeRuntimeContract,
} from "../harness/src/index.js";
import {
  createDiscoveryMapsFixture,
  fixtureDocument,
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
  G21_PLAN_REF,
  G21_SCOPE_REF,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  G22_BASELINE_R1,
  G22_DEMAND_R1,
  G22_GENERATION_TASK,
  G22_SOLUTION_R1,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";
import {
  createDiscoveryRuntimeFixture,
  runtimeEnvelope,
} from "./fixtures/g2.2/discovery-runtime-fixture.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const createdAt = "2026-07-31T16:00:00Z";

type RuntimeArtifact = {
  readonly artifact_type: string;
  readonly artifact_path: string;
  readonly producer_role: "main_agent" | "lane-researcher" | "harness";
  readonly document: Record<string, unknown>;
};

function runtimeArtifact(
  artifactPath: string,
  document: Record<string, unknown>,
  producerRole: RuntimeArtifact["producer_role"],
): RuntimeArtifact {
  return {
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    producer_role: producerRole,
    document,
  };
}

function compilationRequest(
  runId: string,
  operation: "validate_only" | "publish",
  artifacts: readonly RuntimeArtifact[],
  requestId = "request_runtime_synthetic",
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: requestId,
    run_id: runId,
    operation,
    created_at: createdAt,
    artifacts,
  };
}

function planUnits(plan: Record<string, unknown>): readonly Record<string, unknown>[] {
  return (plan.waves as Record<string, unknown>[]).flatMap(
    (wave) => wave.units as Record<string, unknown>[],
  );
}

function executionPlan(
  runId: string,
  plan: Record<string, unknown>,
  kind: "generation" | "evaluation" = "generation",
): Record<string, unknown> {
  const lanes = planUnits(plan).map((unit) => ({
    unit_id: unit.unit_id,
    lane_role: kind === "generation" ? "opportunity" : "evaluation",
    candidate_scope: { kind: "none", candidate_refs: [] },
    reporting_dimensions: ["demand", "buyer"],
    submission_path:
      kind === "generation"
        ? `artifacts/discovery/generation/${String(unit.unit_id)}.r1.json`
        : unit.output_path,
    submission_schema:
      kind === "generation"
        ? "startup_opportunity.discovery_generation_result.v1"
        : unit.required_artifact_schema,
    time_budget_minutes: 10,
    max_sources: 5,
    straggler_policy: { on_timeout: "publish_partial", grace_minutes: 2, blocks_stage: true },
    dispatch_group: `group_${kind}`,
  }));
  return {
    schema_version: "startup_opportunity.research_execution_plan.v1",
    execution_plan_id: `execution_${kind}_synthetic`,
    run_id: runId,
    mode: "opportunity_discovery",
    revision: 1,
    parent_execution_plan_ref: null,
    research_plan_ref: G21_PLAN_REF,
    research_plan_hash: canonicalContentHash(plan),
    created_at: createdAt,
    research_depth: "quick",
    total_time_budget_minutes: 10,
    stages: [
      {
        stage_id: `stage_${kind}`,
        stage_kind: kind === "generation" ? "discovery_generation" : "candidate_evaluation",
        depends_on: [],
        gate_before: null,
        gate_after: "required",
        lanes,
      },
    ],
    limitations: ["SYNTHETIC contract execution overlay; no research was performed."],
  };
}

function terminalReadiness(runId: string, plan: Record<string, unknown>): Record<string, unknown> {
  const candidateRoles = [
    {
      candidate_ref: G22_DEMAND_R1,
      candidate_kind: "demand_seed",
      reporting_role: "opportunity_direction",
      disposition: "watchlist",
    },
    {
      candidate_ref: G22_BASELINE_R1,
      candidate_kind: "baseline_seed",
      reporting_role: "comparison_baseline",
      disposition: "watchlist",
    },
    {
      candidate_ref: G22_SOLUTION_R1,
      candidate_kind: "solution_seed",
      reporting_role: "solution_hypothesis",
      disposition: "watchlist",
    },
  ];
  return {
    schema_version: "startup_opportunity.discovery_stage_readiness.v1",
    readiness_id: "readiness_terminal_closure_synthetic",
    revision: 1,
    run_id: runId,
    research_plan_ref: G21_PLAN_REF,
    execution_plan_ref: "plans/research-execution.r1.json",
    stage_id: "stage_generation",
    next_stage_id: null,
    source_fan_in_ref: null,
    generation_result_refs: [],
    candidate_roles: candidateRoles,
    required_candidate_kinds: ["demand_seed", "baseline_seed", "solution_seed"],
    missing_candidate_kinds: [],
    question_coverage: (plan.research_questions as Record<string, unknown>[]).map((question) => ({
      question_ref: `${G21_PLAN_REF}#${String(question.question_id)}`,
      status: "method_boundary",
      judgment_refs: [],
      evidence_refs: [],
      basis_refs: candidateRoles.map((role) => role.candidate_ref),
    })),
    next_stage_readiness: "terminal",
    blockers: [
      {
        blocker_id: "blocker_public_information_ceiling_synthetic",
        blocker_kind: "no_information_gain",
        candidate_kind: null,
        basis_refs: candidateRoles.map((role) => role.candidate_ref),
        allowed_actions: ["terminate_insufficient_evidence"],
        detail: "SYNTHETIC terminal closure exercises current formal artifacts only.",
      },
    ],
    allowed_next_actions: ["terminate_insufficient_evidence"],
    stop_basis: "no_information_gain",
    limitations: ["SYNTHETIC contract fixture; no research or external validation was performed."],
  };
}

function dispatchBatch(
  runId: string,
  plan: Record<string, unknown>,
  execution: Record<string, unknown>,
): Record<string, unknown> {
  const stage = (execution.stages as Record<string, unknown>[])[0];
  assert.ok(stage);
  const lanes = stage.lanes as Record<string, unknown>[];
  const units = new Map(planUnits(plan).map((unit) => [String(unit.unit_id), unit]));
  return {
    schema_version: "startup_opportunity.dispatch_batch.v1",
    batch_id: "batch_runtime_synthetic",
    revision: 1,
    run_id: runId,
    mode: "opportunity_discovery",
    execution_plan_ref: "plans/research-execution.r1.json",
    research_plan_ref: G21_PLAN_REF,
    stage_id: stage.stage_id,
    dispatch_group: lanes[0]?.dispatch_group,
    task_ready_at: "2026-07-31T16:01:00Z",
    dispatch_requested_at: "2026-07-31T16:01:01Z",
    tasks: lanes.map((lane) => {
      const unit = units.get(String(lane.unit_id));
      assert.ok(unit);
      return {
        task_id: `task_${String(lane.unit_id)}`,
        unit_id: lane.unit_id,
        lane_role: lane.lane_role,
        research_goal: unit.research_goal,
        input_refs: unit.input_refs,
        allowed_output_path: lane.submission_path,
        required_artifact_schema: lane.submission_schema,
        time_budget_minutes: lane.time_budget_minutes,
        max_sources: lane.max_sources,
        straggler_policy: lane.straggler_policy,
      };
    }),
    agent_dispatch_performed: false,
    limitations: ["SYNTHETIC dispatch contract; the Harness does not start agents."],
  };
}

function lifecycle(
  runId: string,
  unitId: string,
  revision: number,
  state: "dispatch_requested" | "agent_started",
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.lane_lifecycle.v1",
    lifecycle_id: `lifecycle_${unitId}`,
    revision,
    parent_lifecycle_ref:
      revision === 1 ? null : `artifacts/runtime/lane-lifecycle/${unitId}.r${revision - 1}.json`,
    run_id: runId,
    unit_id: unitId,
    attempt: 1,
    dispatch_batch_ref: `tasks/dispatch/runtime.r1.json#task_${unitId}`,
    state,
    timestamps: {
      task_ready_at: "2026-07-31T16:01:00Z",
      dispatch_requested_at: "2026-07-31T16:01:01Z",
      agent_started_at: state === "agent_started" ? "2026-07-31T16:01:02Z" : null,
      evidence_recorded_at: null,
      handoff_ready_at: null,
      formalization_validated_at: null,
      published_at: null,
    },
    failure: null,
    limitations: ["SYNTHETIC lifecycle observation."],
  };
}

function compilerCodes(error: unknown): readonly string[] {
  if (!(error instanceof StoreError)) {
    return [];
  }
  return ["bundleErrors", "documentErrors", "referenceErrors"].flatMap((field) => {
    const values = error.details[field];
    return Array.isArray(values)
      ? values.flatMap((value) =>
          typeof value === "object" && value !== null && "code" in value
            ? [String(value.code)]
            : [],
        )
      : [];
  });
}

async function prepareRun(context: TestContext, suffix: string) {
  const root = await mkdtemp(path.join(tmpdir(), `startup-opportunity-p1-${suffix}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = `p1-${suffix}-synthetic`;
  const validator = await createArtifactValidator(repositoryRoot);
  const runStore = new RunStore(runsRoot, validator);
  const bundle = await createDiscoveryMapsFixture("general", runId);
  await runStore.create({
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-31T15:59:00Z",
  });
  await runStore.publishArtifactBundle({
    runId,
    envelopes: G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  return {
    root,
    runsRoot,
    runId,
    validator,
    runStore,
    bundle,
    plan: fixtureDocument(bundle, G21_PLAN_REF),
  };
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

async function prepareDiscoveryTaskBridgeRun(context: TestContext, suffix: string) {
  const root = await mkdtemp(path.join(tmpdir(), `startup-opportunity-p1-task-bridge-${suffix}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = `p1-task-bridge-${suffix}-synthetic`;
  const validator = await createArtifactValidator(repositoryRoot);
  const runStore = new RunStore(runsRoot, validator);
  await runStore.create({
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-31T15:59:00Z",
  });
  const evidence = new EvidenceStore(runsRoot);
  const generation = (
    await evidence.record({
      runId,
      unitId: "unit_seed_independent_demand",
      researchGoal: "SYNTHETIC task bridge generation substrate; not Evidence.",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:${suffix}-task-bridge-generation`,
      },
      rawContent: "SYNTHETIC task bridge generation bytes; not Evidence.",
      recordedAt: "2026-07-31T16:00:00Z",
    })
  ).record;
  const evaluation = (
    await evidence.record({
      runId,
      unitId: "unit_counterfactual",
      researchGoal: "SYNTHETIC task bridge evaluation substrate; not Evidence.",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:${suffix}-task-bridge-evaluation`,
      },
      rawContent: "SYNTHETIC task bridge evaluation bytes; not Evidence.",
      recordedAt: "2026-07-31T16:00:01Z",
    })
  ).record;
  const bundle = await createDiscoveryRuntimeFixture(
    runId,
    { generation, evaluation },
    [],
    "general",
    true,
  );
  await runStore.publishArtifactBundle({
    runId,
    envelopes: G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  await runStore.publishArtifactBundle({
    runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  await runStore.publishArtifactBundle({
    runId,
    envelopes: bundle.documents
      .map((entry) => entry.document as unknown as FormalArtifactEnvelope)
      .filter(
        (envelope) =>
          envelope.schema_version === "startup_opportunity.artifact_envelope.v10" &&
          envelope.artifact_type === "startup_opportunity.discovery_candidate.v1" &&
          envelope.document.revision === 1,
      ),
  });
  return {
    root,
    runsRoot,
    runRoot: path.join(runsRoot, runId),
    runId,
    validator,
    runStore,
    bundle,
    plan: fixtureDocument(bundle, G21_PLAN_REF),
  };
}

function canonicalDiscoveryTask(
  bundle: DocumentBundle,
  plan: Record<string, unknown>,
): FormalArtifactEnvelope {
  const envelope = structuredClone(runtimeEnvelope(bundle, G22_GENERATION_TASK));
  const wave = (plan.waves as Record<string, unknown>[]).find((entry) =>
    (entry.units as Record<string, unknown>[]).some(
      (unit) => unit.unit_id === envelope.document.unit_id,
    ),
  );
  assert.ok(wave);
  const unit = (wave.units as Record<string, unknown>[]).find(
    (entry) => entry.unit_id === envelope.document.unit_id,
  );
  assert.ok(unit);
  envelope.document.wave_id = wave.wave_id;
  envelope.document.unit_type = unit.unit_type;
  envelope.document.research_goal = unit.research_goal;
  envelope.document.attempt = unit.attempt;
  envelope.document.agent_role = unit.agent_role;
  envelope.document.allowed_output_path = unit.output_path;
  envelope.document.required_artifact_schema = unit.required_artifact_schema;
  (envelope as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    envelope.document,
  );
  return envelope;
}

function alternateTask(
  task: FormalArtifactEnvelope,
  suffix: string,
  changes: Readonly<Record<string, unknown>> = {},
): FormalArtifactEnvelope {
  const envelope = structuredClone(task);
  (envelope as unknown as { artifact_path: string }).artifact_path =
    `tasks/discovery/${String(task.document.unit_id)}.attempt-${suffix}.json`;
  envelope.document.task_id = `${String(task.document.task_id)}_${suffix}`;
  Object.assign(envelope.document, changes);
  (envelope as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    envelope.document,
  );
  return envelope;
}

async function moveManifestUnit(
  runRoot: string,
  unitId: string,
  target: "completed_units" | "failed_units" | "skipped_units",
): Promise<void> {
  const manifestPath = path.join(runRoot, "manifest.json");
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
    const current = manifest[field] as string[];
    manifest[field] =
      field === target
        ? [...new Set([...current, unitId])].sort()
        : current.filter((entry) => entry !== unitId);
  }
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
}

test("public compiler validates, publishes, replays, and recovers a temp-write fault", async (t) => {
  const first = await prepareRun(t, "compiler");
  const execution = executionPlan(first.runId, first.plan);
  const artifact = runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent");
  const compiler = new DeclarativeRuntimeCompiler(first.runsRoot, first.validator);
  const validated = await compiler.compile(
    compilationRequest(first.runId, "validate_only", [artifact], "request_validate_synthetic"),
  );
  assert.equal(validated.status, "validated");
  assert.equal(
    validated.compiled_envelopes[0]?.schema_version,
    "startup_opportunity.artifact_envelope.v18",
  );
  assert.ok(validated.validation_closure.document_count > 1);

  const request = compilationRequest(
    first.runId,
    "publish",
    [artifact],
    "request_publish_synthetic",
  );
  const published = await compiler.compile(request);
  assert.equal(published.status, "published");
  const replay = await compiler.compile(request);
  assert.equal(replay.status, "idempotent_replay");

  const fault = await prepareRun(t, "compiler-fault");
  const faultArtifact = runtimeArtifact(
    "plans/research-execution.r1.json",
    executionPlan(fault.runId, fault.plan),
    "main_agent",
  );
  const faultRequest = compilationRequest(
    fault.runId,
    "publish",
    [faultArtifact],
    "request_fault_synthetic",
  );
  const faultCompiler = new DeclarativeRuntimeCompiler(fault.runsRoot, fault.validator);
  await assert.rejects(
    faultCompiler.compile(faultRequest, { faultAt: "after_temp_write" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await new RunStore(fault.runsRoot, fault.validator).load(fault.runId);
  assert.deepEqual(reopened.recoveredArtifactPaths, ["plans/research-execution.r1.json"]);
  const recovered = await faultCompiler.compile(faultRequest);
  assert.equal(recovered.status, "idempotent_replay");
  assert.equal((await faultCompiler.compile(faultRequest)).status, "idempotent_replay");
});

test("terminal compilation preserves current G2.1/G2.2 envelopes and aggregate roots", async (t) => {
  const state = await prepareDiscoveryTaskBridgeRun(t, "terminal-closure");
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  const execution = executionPlan(state.runId, state.plan);
  await compiler.compile(
    compilationRequest(
      state.runId,
      "publish",
      [runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent")],
      "request_terminal_closure_execution_synthetic",
    ),
  );
  const readinessPath = "artifacts/discovery/readiness/terminal-closure.r1.json";
  const readinessRequest = compilationRequest(
    state.runId,
    "validate_only",
    [runtimeArtifact(readinessPath, terminalReadiness(state.runId, state.plan), "main_agent")],
    "request_terminal_closure_synthetic",
  );
  const before = await snapshotTree(state.runRoot);
  const validated = await compiler.compile(readinessRequest);
  assert.equal(validated.status, "validated");
  assert.deepEqual(await snapshotTree(state.runRoot), before);

  const context = await state.runStore.buildValidationContext(state.runId, {
    schema_version: "startup_opportunity.document_bundle.v18",
    documents: [
      {
        path: readinessPath,
        document: validated.compiled_envelopes[0] as FormalArtifactEnvelope,
      },
    ],
    exact_records: [],
  });
  const byPath = new Map(context.bundle.documents.map((entry) => [entry.path, entry.document]));
  assert.ok(byPath.has("intake.json"));
  assert.equal(
    byPath.get(G21_MAP_REFS[0])?.schema_version,
    "startup_opportunity.artifact_envelope.v8",
  );
  assert.equal(
    byPath.get(G22_DEMAND_R1)?.schema_version,
    "startup_opportunity.artifact_envelope.v10",
  );
  assert.equal(byPath.get(G22_DEMAND_R1)?.producer_role, "main_agent");

  const candidatePath = path.join(state.runRoot, G22_DEMAND_R1);
  const tampered = JSON.parse(await readFile(candidatePath, "utf8")) as Record<string, unknown>;
  tampered.producer_role = "lane_researcher";
  await writeFile(candidatePath, `${canonicalJson(tampered)}\n`);
  const afterTamper = await snapshotTree(state.runRoot);
  await assert.rejects(
    compiler.compile({
      ...readinessRequest,
      request_id: "request_terminal_closure_tampered_synthetic",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.schema_invalid",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), afterTamper);
});

test("terminal compilation recovers and replays after a temp-write fault", async (t) => {
  const state = await prepareDiscoveryTaskBridgeRun(t, "terminal-closure-fault");
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  await compiler.compile(
    compilationRequest(
      state.runId,
      "publish",
      [
        runtimeArtifact(
          "plans/research-execution.r1.json",
          executionPlan(state.runId, state.plan),
          "main_agent",
        ),
      ],
      "request_terminal_closure_fault_execution_synthetic",
    ),
  );
  const readinessPath = "artifacts/discovery/readiness/terminal-closure.r1.json";
  const request = compilationRequest(
    state.runId,
    "publish",
    [runtimeArtifact(readinessPath, terminalReadiness(state.runId, state.plan), "main_agent")],
    "request_terminal_closure_fault_synthetic",
  );
  await assert.rejects(
    compiler.compile(request, { faultAt: "after_temp_write" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.deepEqual(reopened.recoveredArtifactPaths, [readinessPath]);
  assert.equal((await compiler.compile(request)).status, "idempotent_replay");
});

test("complete same-wave dispatch activates both units and lifecycle revisions cannot regress", async (t) => {
  const state = await prepareRun(t, "dispatch");
  const execution = executionPlan(state.runId, state.plan, "evaluation");
  const batch = dispatchBatch(state.runId, state.plan, execution);
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  const executionArtifact = runtimeArtifact(
    "plans/research-execution.r1.json",
    execution,
    "main_agent",
  );
  const incomplete = structuredClone(batch);
  (incomplete.tasks as unknown[]).pop();
  await assert.rejects(
    compiler.compile(
      compilationRequest(state.runId, "validate_only", [
        executionArtifact,
        runtimeArtifact("tasks/dispatch/runtime.r1.json", incomplete, "harness"),
      ]),
    ),
    (error: unknown) => compilerCodes(error).includes("runtime.dispatch_group_incomplete"),
  );

  const published = await compiler.compile(
    compilationRequest(state.runId, "publish", [
      executionArtifact,
      runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
    ]),
  );
  assert.equal(published.status, "published");
  const unitIds = planUnits(state.plan)
    .map((unit) => String(unit.unit_id))
    .sort();
  assert.deepEqual((await state.runStore.status(state.runId)).manifest.active_units, unitIds);

  const firstUnitId = unitIds[0];
  assert.ok(firstUnitId);
  const started = lifecycle(state.runId, firstUnitId, 1, "agent_started");
  await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact(
        `artifacts/runtime/lane-lifecycle/${firstUnitId}.r1.json`,
        started,
        "main_agent",
      ),
    ]),
  );
  const regressed = lifecycle(state.runId, firstUnitId, 2, "dispatch_requested");
  await assert.rejects(
    compiler.compile(
      compilationRequest(state.runId, "validate_only", [
        runtimeArtifact(
          `artifacts/runtime/lane-lifecycle/${firstUnitId}.r2.json`,
          regressed,
          "main_agent",
        ),
      ]),
    ),
    (error: unknown) => compilerCodes(error).includes("runtime.lifecycle_state_regression"),
  );
});

test("current dispatch bridges exact canonical Discovery tasks, replay, and recovery", async (t) => {
  const state = await prepareDiscoveryTaskBridgeRun(t, "canonical");
  const execution = executionPlan(state.runId, state.plan, "evaluation");
  const batch = dispatchBatch(state.runId, state.plan, execution);
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
      runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
    ]),
  );
  const task = canonicalDiscoveryTask(state.bundle, state.plan);
  const unitId = String(task.document.unit_id);
  const published = await state.runStore.publishArtifact({ runId: state.runId, envelope: task });
  assert.equal(published.status, "published");
  const afterPublish = await state.runStore.status(state.runId);
  assert.ok(afterPublish.manifest.active_units.includes(unitId));
  assert.ok(afterPublish.manifest.artifact_refs.includes(task.artifact_path));

  const beforeReplay = await snapshotTree(state.runRoot);
  const replay = await state.runStore.publishArtifact({ runId: state.runId, envelope: task });
  assert.equal(replay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(state.runRoot), beforeReplay);

  const fault = await prepareDiscoveryTaskBridgeRun(t, "canonical-fault");
  const faultExecution = executionPlan(fault.runId, fault.plan, "evaluation");
  const faultBatch = dispatchBatch(fault.runId, fault.plan, faultExecution);
  const faultCompiler = new DeclarativeRuntimeCompiler(fault.runsRoot, fault.validator);
  await faultCompiler.compile(
    compilationRequest(fault.runId, "publish", [
      runtimeArtifact("plans/research-execution.r1.json", faultExecution, "main_agent"),
      runtimeArtifact("tasks/dispatch/runtime.r1.json", faultBatch, "harness"),
    ]),
  );
  const faultTask = canonicalDiscoveryTask(fault.bundle, fault.plan);
  await assert.rejects(
    fault.runStore.publishArtifact({
      runId: fault.runId,
      envelope: faultTask,
      faultAt: "after_publish",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const beforeRecovery = JSON.parse(
    await readFile(path.join(fault.runRoot, "manifest.json"), "utf8"),
  ) as { artifact_refs: string[] };
  assert.ok(!beforeRecovery.artifact_refs.includes(faultTask.artifact_path));
  const recovered = await new RunStore(fault.runsRoot, fault.validator).load(fault.runId);
  assert.ok(recovered.manifest.active_units.includes(String(faultTask.document.unit_id)));
  assert.ok(recovered.manifest.artifact_refs.includes(faultTask.artifact_path));
  assert.equal(
    (
      await fault.runStore.publishArtifact({
        runId: fault.runId,
        envelope: faultTask,
      })
    ).status,
    "idempotent_replay",
  );
});

test("canonical Discovery task bridge rejects missing dispatch, Plan drift, and terminal units", async (t) => {
  const undispatched = await prepareDiscoveryTaskBridgeRun(t, "undispatched");
  const firstTask = canonicalDiscoveryTask(undispatched.bundle, undispatched.plan);
  await undispatched.runStore.publishArtifact({ runId: undispatched.runId, envelope: firstTask });
  const beforeUndispatched = await snapshotTree(undispatched.runRoot);
  await assert.rejects(
    undispatched.runStore.publishArtifact({
      runId: undispatched.runId,
      envelope: alternateTask(firstTask, "2"),
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.task_transition_invalid",
  );
  assert.deepEqual(await snapshotTree(undispatched.runRoot), beforeUndispatched);

  const drift = await prepareDiscoveryTaskBridgeRun(t, "drift");
  const execution = executionPlan(drift.runId, drift.plan, "evaluation");
  const batch = dispatchBatch(drift.runId, drift.plan, execution);
  const compiler = new DeclarativeRuntimeCompiler(drift.runsRoot, drift.validator);
  await compiler.compile(
    compilationRequest(drift.runId, "publish", [
      runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
      runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
    ]),
  );
  const exactTask = canonicalDiscoveryTask(drift.bundle, drift.plan);
  const mismatches = [
    alternateTask(exactTask, "2", { wave_id: "wave_unplanned" }),
    alternateTask(exactTask, "3", { research_goal: "SYNTHETIC drifted research goal." }),
    alternateTask(exactTask, "4", {
      allowed_output_path: "artifacts/discovery/lanes/unit_counterfactual.attempt-1.json",
    }),
    alternateTask(exactTask, "5", {
      required_artifact_schema: "startup_opportunity.discovery_generation_result.v1",
    }),
  ];
  const beforeDrift = await snapshotTree(drift.runRoot);
  for (const mismatch of mismatches) {
    await assert.rejects(
      drift.runStore.publishArtifact({ runId: drift.runId, envelope: mismatch }),
      (error: unknown) =>
        error instanceof StoreError && error.code === "artifact.task_transition_invalid",
    );
  }
  assert.deepEqual(await snapshotTree(drift.runRoot), beforeDrift);

  const terminal = await prepareDiscoveryTaskBridgeRun(t, "terminal");
  const terminalTask = canonicalDiscoveryTask(terminal.bundle, terminal.plan);
  const terminalUnitId = String(terminalTask.document.unit_id);
  for (const target of ["completed_units", "failed_units", "skipped_units"] as const) {
    await moveManifestUnit(terminal.runRoot, terminalUnitId, target);
    const before = await snapshotTree(terminal.runRoot);
    await assert.rejects(
      terminal.runStore.publishArtifact({ runId: terminal.runId, envelope: terminalTask }),
      (error: unknown) =>
        error instanceof StoreError && error.code === "artifact.task_transition_invalid",
    );
    assert.deepEqual(await snapshotTree(terminal.runRoot), before);
  }
});

test("candidate-neutral Evidence binds real substrate and generation completion wins recovery ordering", async (t) => {
  const state = await prepareRun(t, "generation");
  const execution = executionPlan(state.runId, state.plan);
  const batch = dispatchBatch(state.runId, state.plan, execution);
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
      runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
    ]),
  );
  const firstTask = (batch.tasks as Record<string, unknown>[])[0];
  assert.ok(firstTask);
  const unitId = String(firstTask.unit_id);
  const substrate = await new EvidenceStore(state.runsRoot).record({
    runId: state.runId,
    unitId,
    researchGoal: String(firstTask.research_goal),
    source: {
      kind: "user_provided",
      canonical_uri: `urn:startup-opportunity:user-provided:${state.runId}`,
    },
    rawContent: "SYNTHETIC contract bytes; not market Evidence.",
    recordedAt: "2026-07-31T16:02:00Z",
  });
  const evidencePath = `evidence/discovery/generation/${substrate.record.evidence_id}.json`;
  const evidence = {
    schema_version: "startup_opportunity.candidate_neutral_evidence.v1",
    evidence_id: substrate.record.evidence_id,
    run_id: state.runId,
    unit_id: unitId,
    dispatch_batch_ref: `tasks/dispatch/runtime.r1.json#${String(firstTask.task_id)}`,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    source_type: "synthetic_contract_fixture",
    source_name: "SYNTHETIC fixture source; not Evidence.",
    research_goal: firstTask.research_goal,
    source_group_id: "source_group_synthetic",
    mechanical_binding: {
      substrate_record_ref: `evidence/manifest.jsonl#${substrate.record.evidence_id}`,
      source_hash: substrate.record.source_hash,
      content_hash: substrate.record.content_hash,
      raw_content_ref: substrate.record.raw_content_ref,
      operation_key: substrate.record.operation_key,
      recorded_at: substrate.record.recorded_at,
    },
    evidence_tier: "model_inference_only",
    evidence_lifecycle_status: "unverified",
    evidence_role: "context",
    representativeness: "SYNTHETIC contract fixture only.",
    valid_as_of: "2026-07-31",
    target_candidate_refs: [],
    solution_refs: [],
    limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
  };
  const sourceManifestPath = `evidence/source-manifests/discovery/${unitId}.json`;
  const sourceManifest = {
    schema_version: "startup_opportunity.source_manifest.v4",
    manifest_id: "source_manifest_synthetic",
    run_id: state.runId,
    unit_id: unitId,
    research_plan_ref: G21_PLAN_REF,
    execution_plan_ref: "plans/research-execution.r1.json",
    dispatch_batch_ref: `tasks/dispatch/runtime.r1.json#${String(firstTask.task_id)}`,
    research_phase_role: "candidate_generation",
    accepted_evidence_refs: [evidencePath],
    canonical_source_groups: [
      { group_id: "source_group_synthetic", evidence_refs: [evidencePath] },
    ],
    shared_dataset_groups: [],
    duplicate_or_syndication_groups: [],
    source_type_coverage: ["synthetic_contract_fixture"],
    geo_language_coverage: ["synthetic"],
    time_coverage: {
      earliest_valid_as_of: "2026-07-31",
      latest_valid_as_of: "2026-07-31",
      accepted_evidence_count: 1,
    },
    stance_coverage: ["context"],
    known_source_blind_spots: ["No real source was used."],
    freshness_summary: { active: 0, stale: 0, unverified: 1, superseded: 0 },
    limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
  };
  const generationPath = String(firstTask.allowed_output_path);
  const generation = {
    schema_version: "startup_opportunity.discovery_generation_result.v1",
    generation_result_id: "generation_result_synthetic",
    run_id: state.runId,
    unit_id: unitId,
    attempt: 1,
    dispatch_batch_ref: `tasks/dispatch/runtime.r1.json#${String(firstTask.task_id)}`,
    status: "completed",
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    source_manifest_ref: sourceManifestPath,
    evidence_refs: [evidencePath],
    judgment_assessment_refs: [],
    candidate_proposals: [],
    target_candidate_refs: [],
    solution_refs: [],
    open_questions: ["SYNTHETIC fixture leaves every research question open."],
    limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
  };

  const tampered = structuredClone(evidence);
  tampered.mechanical_binding.content_hash = `sha256:${"0".repeat(64)}`;
  await assert.rejects(
    compiler.compile(
      compilationRequest(state.runId, "validate_only", [
        runtimeArtifact("evidence/discovery/generation/tampered.json", tampered, "lane-researcher"),
      ]),
    ),
    (error: unknown) =>
      compilerCodes(error).includes("runtime.candidate_neutral_substrate_mismatch"),
  );
  const staleSummary = structuredClone(sourceManifest);
  staleSummary.freshness_summary = { active: 1, stale: 0, unverified: 0, superseded: 0 };
  await assert.rejects(
    compiler.compile(
      compilationRequest(state.runId, "validate_only", [
        runtimeArtifact(evidencePath, evidence, "lane-researcher"),
        runtimeArtifact(sourceManifestPath, staleSummary, "lane-researcher"),
      ]),
    ),
    (error: unknown) => compilerCodes(error).includes("runtime.source_manifest_summary_mismatch"),
  );

  await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact(evidencePath, evidence, "lane-researcher"),
      runtimeArtifact(sourceManifestPath, sourceManifest, "lane-researcher"),
      runtimeArtifact(generationPath, generation, "lane-researcher"),
    ]),
  );
  const manifest = (await state.runStore.status(state.runId)).manifest;
  assert.ok(manifest.completed_units.includes(unitId));
  assert.ok(!manifest.active_units.includes(unitId));
});

test("readiness and Gap semantics require bounded solution generation and basis closure", async () => {
  const runId = "p1-readiness-synthetic";
  const bundle = await createDiscoveryMapsFixture("general", runId);
  const plan = fixtureDocument(bundle, G21_PLAN_REF);
  const execution = executionPlan(runId, plan);
  const executionEntry = {
    path: "plans/research-execution.r1.json",
    schemaVersion: String(execution.schema_version),
    document: execution,
    envelope: null,
  };
  const planEntry = {
    path: G21_PLAN_REF,
    schemaVersion: String(plan.schema_version),
    document: plan,
    envelope: null,
  };
  const questions = (plan.research_questions as Record<string, unknown>[]).map((question) => ({
    question_ref: `${G21_PLAN_REF}#${String(question.question_id)}`,
    status: "unresolved",
    judgment_refs: [],
    evidence_refs: [],
    basis_refs: [],
  }));
  const readinessPath = "artifacts/discovery/readiness/generation.r1.json";
  const missingKinds = ["demand_seed", "baseline_seed", "solution_seed"];
  const readiness = {
    schema_version: "startup_opportunity.discovery_stage_readiness.v1",
    readiness_id: "readiness_synthetic",
    revision: 1,
    run_id: runId,
    research_plan_ref: G21_PLAN_REF,
    execution_plan_ref: "plans/research-execution.r1.json",
    stage_id: "stage_generation",
    next_stage_id: "stage_evaluation",
    source_fan_in_ref: null,
    generation_result_refs: [],
    candidate_roles: [],
    required_candidate_kinds: missingKinds,
    missing_candidate_kinds: missingKinds,
    question_coverage: questions,
    next_stage_readiness: "blocked",
    blockers: missingKinds.map((kind) => ({
      blocker_id: `blocker_${kind}`,
      blocker_kind: "candidate_kind_missing",
      candidate_kind: kind,
      basis_refs: [],
      allowed_actions: [kind === "solution_seed" ? "run_solution_generation" : "add_unit"],
      detail: `SYNTHETIC missing ${kind}.`,
    })),
    allowed_next_actions: ["add_unit", "run_solution_generation"],
    stop_basis: null,
    limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
  };
  const stagedExecution = structuredClone(execution);
  stagedExecution.total_time_budget_minutes = 20;
  stagedExecution.stages = [
    ...(execution.stages as Record<string, unknown>[]),
    {
      stage_id: "stage_evaluation",
      stage_kind: "candidate_evaluation",
      depends_on: ["stage_generation"],
      gate_before: readinessPath,
      gate_after: "required",
      lanes: [],
    },
  ];
  executionEntry.document = stagedExecution;
  const readinessEntry = {
    path: readinessPath,
    schemaVersion: String(readiness.schema_version),
    document: readiness,
    envelope: null,
  };
  const baseDocuments = [planEntry, executionEntry, readinessEntry];
  const positiveCodes = validateDeclarativeRuntimeContract(baseDocuments).map(
    (issue) => issue.code,
  );
  assert.ok(!positiveCodes.includes("runtime.readiness_missing_candidate_action_missing"));

  const missingSolutionAction = structuredClone(readiness);
  const solutionBlocker = (missingSolutionAction.blockers as Record<string, unknown>[]).find(
    (blocker) => blocker.candidate_kind === "solution_seed",
  );
  assert.ok(solutionBlocker);
  solutionBlocker.allowed_actions = ["add_unit"];
  const solutionCodes = validateDeclarativeRuntimeContract([
    planEntry,
    executionEntry,
    { ...readinessEntry, document: missingSolutionAction },
  ]).map((issue) => issue.code);
  assert.ok(solutionCodes.includes("runtime.readiness_missing_candidate_action_missing"));

  const terminalWithFollowup = structuredClone(readiness);
  terminalWithFollowup.next_stage_readiness = "terminal";
  (terminalWithFollowup as Record<string, unknown>).stop_basis = "method_boundary";
  const terminalCodes = validateDeclarativeRuntimeContract([
    planEntry,
    executionEntry,
    { ...readinessEntry, document: terminalWithFollowup },
  ]).map((issue) => issue.code);
  assert.ok(terminalCodes.includes("runtime.readiness_disposition_invalid"));

  const terminalAfterFinalStage = structuredClone(readiness);
  terminalAfterFinalStage.stage_id = "stage_evaluation";
  (terminalAfterFinalStage as Record<string, unknown>).next_stage_id = null;
  terminalAfterFinalStage.next_stage_readiness = "terminal";
  terminalAfterFinalStage.allowed_next_actions = ["terminate_insufficient_evidence"];
  (terminalAfterFinalStage as Record<string, unknown>).stop_basis = "no_information_gain";
  for (const blocker of terminalAfterFinalStage.blockers as Record<string, unknown>[]) {
    blocker.allowed_actions = ["terminate_insufficient_evidence"];
  }
  const validator = await createArtifactValidator(repositoryRoot);
  assert.equal(validator.validateDocument(terminalAfterFinalStage, readinessPath).valid, true);
  const finalTerminalCodes = validateDeclarativeRuntimeContract([
    planEntry,
    executionEntry,
    { ...readinessEntry, document: terminalAfterFinalStage },
  ]).map((issue) => issue.code);
  assert.ok(!finalTerminalCodes.includes("runtime.readiness_stage_binding_mismatch"));

  const readyWithoutNextStage = structuredClone(terminalAfterFinalStage);
  readyWithoutNextStage.next_stage_readiness = "ready";
  readyWithoutNextStage.blockers = [];
  readyWithoutNextStage.allowed_next_actions = ["continue_stage"];
  (readyWithoutNextStage as Record<string, unknown>).stop_basis = null;
  const readyWithoutNextCodes = validateDeclarativeRuntimeContract([
    planEntry,
    executionEntry,
    { ...readinessEntry, document: readyWithoutNextStage },
  ]).map((issue) => issue.code);
  assert.ok(readyWithoutNextCodes.includes("runtime.readiness_stage_binding_mismatch"));

  const runtimeBlockedReadiness = structuredClone(readiness);
  runtimeBlockedReadiness.next_stage_readiness = "terminal";
  (runtimeBlockedReadiness as Record<string, unknown>).blockers = [
    {
      blocker_id: "blocker_runtime_synthetic",
      blocker_kind: "runtime_blocked",
      candidate_kind: null,
      basis_refs: [],
      allowed_actions: ["record_runtime_failure"],
      detail: "SYNTHETIC runtime failure must remain an execution failure.",
    },
  ];
  runtimeBlockedReadiness.allowed_next_actions = ["record_runtime_failure"];
  (runtimeBlockedReadiness as Record<string, unknown>).stop_basis = "method_boundary";
  const runtimeBlockedCodes = validateDeclarativeRuntimeContract([
    planEntry,
    executionEntry,
    { ...readinessEntry, document: runtimeBlockedReadiness },
  ]).map((issue) => issue.code);
  assert.ok(runtimeBlockedCodes.includes("runtime.readiness_disposition_invalid"));

  const gapPath = "adaptations/gap-snapshots/gap_synthetic.r1.json";
  const gap = {
    schema_version: "startup_opportunity.gap_snapshot.v3",
    snapshot_id: "gap_synthetic",
    snapshot_cycle_key: canonicalContentHash({ run_id: runId, cycle: 1 }),
    run_id: runId,
    based_on_plan_ref: G21_PLAN_REF,
    revision: 1,
    parent_snapshot_ref: null,
    created_at: createdAt,
    trigger_kind: "wave_completed",
    trigger_event_ref: null,
    phase: "discovery",
    wave_id: "wave_discovery_synthetic",
    readiness_ref: readinessPath,
    fan_in_ref: null,
    observed_artifact_refs: [readinessPath],
    gaps: [
      {
        gap_id: "gap_candidate_kind_synthetic",
        subject_ref: G21_SCOPE_REF,
        gap_type: "candidate_kind_missing",
        detection_mode: "deterministic",
        decision_impact: ["next_action"],
        severity: "blocking",
        basis_refs: [readinessPath],
        evidence_refs: [],
        recommended_unit_types: ["user_language_mining"],
        allowed_actions: ["add_unit", "run_solution_generation"],
        detail: "SYNTHETIC candidate roles are incomplete.",
      },
    ],
    material_new_evidence_observed: false,
    unresolved_decision_relevant_questions: questions.map((item) => item.question_ref),
    stop_signals: [],
  };
  const gapEntry = {
    path: gapPath,
    schemaVersion: String(gap.schema_version),
    document: gap,
    envelope: null,
  };
  const gapCodes = validateDeclarativeRuntimeContract([...baseDocuments, gapEntry]).map(
    (issue) => issue.code,
  );
  assert.ok(!gapCodes.includes("runtime.gap_blocker_missing"));
  assert.ok(!gapCodes.includes("runtime.gap_observation_closure_incomplete"));
  const unclosedGap = structuredClone(gap);
  unclosedGap.observed_artifact_refs = [];
  unclosedGap.gaps = [];
  const unclosedCodes = validateDeclarativeRuntimeContract([
    ...baseDocuments,
    { ...gapEntry, document: unclosedGap },
  ]).map((issue) => issue.code);
  assert.ok(unclosedCodes.includes("runtime.gap_blocker_missing"));
  assert.ok(unclosedCodes.includes("runtime.gap_observation_closure_incomplete"));
});

test("all direct Store writes fail closed after continuation while the child remains writable", async (t) => {
  const state = await prepareRun(t, "continuation-parent");
  const childRunId = "p1-continuation-child-synthetic";
  await state.runStore.create({
    runId: childRunId,
    mode: "opportunity_discovery",
    parentRunId: state.runId,
    createdAt: "2026-07-31T16:10:00Z",
  });
  const artifacts = new ArtifactStore(state.runsRoot, state.validator);
  await assert.rejects(
    artifacts.publish({
      runId: state.runId,
      envelope: fixtureEnvelope(state.bundle, G21_MAP_REFS[0]),
    }),
    (error: unknown) => error instanceof StoreError && error.code === "run.not_current_leaf",
  );
  await assert.rejects(
    artifacts.publishBundle({
      runId: state.runId,
      envelopes: G21_MAP_REFS.slice(0, 2).map((ref) => fixtureEnvelope(state.bundle, ref)),
    }),
    (error: unknown) => error instanceof StoreError && error.code === "run.not_current_leaf",
  );
  const evidence = new EvidenceStore(state.runsRoot);
  await assert.rejects(
    evidence.record({
      runId: state.runId,
      unitId: "unit_parent_synthetic",
      researchGoal: "SYNTHETIC parent write must be rejected.",
      source: {
        kind: "user_provided",
        canonical_uri: "urn:startup-opportunity:user-provided:p1-parent-synthetic",
      },
      rawContent: "SYNTHETIC parent bytes.",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "run.not_current_leaf",
  );
  const childEvidence = await evidence.record({
    runId: childRunId,
    unitId: "unit_child_synthetic",
    researchGoal: "SYNTHETIC child write remains permitted.",
    source: {
      kind: "user_provided",
      canonical_uri: "urn:startup-opportunity:user-provided:p1-child-synthetic",
    },
    rawContent: "SYNTHETIC child bytes.",
  });
  assert.equal(childEvidence.status, "recorded");
});

test("pending, corrupt, and multiple continuation authorities are indeterminate", async (t) => {
  const pending = await prepareRun(t, "continuation-pending");
  const pendingDirectory = path.join(pending.runsRoot, ".continuations", pending.runId);
  await mkdir(pendingDirectory, { recursive: true });
  await writeFile(
    path.join(pendingDirectory, "p1-pending-child-synthetic.json"),
    `${canonicalJson({
      schema_version: "startup_opportunity.continuation_lineage_entry.v1",
      parent_run_id: pending.runId,
      child_run_id: "p1-pending-child-synthetic",
      child_identity_hash: `sha256:${"0".repeat(64)}`,
      state: "pending",
      created_at: "2026-07-31T16:20:00Z",
    })}\n`,
  );
  assert.equal(
    (await pending.runStore.resolveExecution(pending.runId)).disposition,
    "indeterminate",
  );
  await assert.rejects(
    new EvidenceStore(pending.runsRoot).record({
      runId: pending.runId,
      unitId: "unit_pending_synthetic",
      researchGoal: "SYNTHETIC pending guard.",
      source: {
        kind: "user_provided",
        canonical_uri: "urn:startup-opportunity:user-provided:p1-pending-synthetic",
      },
      rawContent: "SYNTHETIC pending bytes.",
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.continuation_indeterminate",
  );

  const corrupt = await prepareRun(t, "continuation-corrupt");
  const corruptChildId = "p1-corrupt-child-synthetic";
  await corrupt.runStore.create({
    runId: corruptChildId,
    mode: "opportunity_discovery",
    parentRunId: corrupt.runId,
    createdAt: "2026-07-31T16:21:00Z",
  });
  await writeFile(path.join(corrupt.runsRoot, corruptChildId, "manifest.json"), "{}\n");
  assert.equal(
    (await corrupt.runStore.resolveExecution(corrupt.runId)).disposition,
    "indeterminate",
  );

  const multiple = await prepareRun(t, "continuation-multiple");
  const firstChildId = "p1-multiple-child-one-synthetic";
  const secondChildId = "p1-multiple-child-two-synthetic";
  await multiple.runStore.create({
    runId: firstChildId,
    mode: "opportunity_discovery",
    parentRunId: multiple.runId,
    createdAt: "2026-07-31T16:22:00Z",
  });
  await multiple.runStore.create({
    runId: secondChildId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-31T16:23:00Z",
  });
  const secondManifestPath = path.join(multiple.runsRoot, secondChildId, "manifest.json");
  const secondManifest = JSON.parse(await readFile(secondManifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  secondManifest.parent_run_id = multiple.runId;
  await writeFile(secondManifestPath, `${canonicalJson(secondManifest)}\n`);
  const identity = {
    run_id: secondChildId,
    mode: "opportunity_discovery",
    parent_run_id: multiple.runId,
    created_at: secondManifest.created_at,
  };
  await writeFile(
    path.join(multiple.runsRoot, ".continuations", multiple.runId, `${secondChildId}.json`),
    `${canonicalJson({
      schema_version: "startup_opportunity.continuation_lineage_entry.v1",
      parent_run_id: multiple.runId,
      child_run_id: secondChildId,
      child_identity_hash: canonicalContentHash(identity),
      state: "committed",
      created_at: secondManifest.created_at,
    })}\n`,
  );
  const resolution = await multiple.runStore.resolveExecution(multiple.runId);
  assert.equal(resolution.disposition, "indeterminate");
  assert.ok(resolution.issues.some((issue) => issue.startsWith("continuation.multiple_children")));
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ArtifactStore,
  canonicalContentHash,
  canonicalJson,
  canonicalLaneLifecycleId,
  canonicalLaneLifecyclePath,
  createArtifactValidator,
  DeclarativeRuntimeCompiler,
  type DocumentBundle,
  dispatchLaunchRegistrationPath,
  EvidenceStore,
  type EvidenceStoreRecord,
  type FormalArtifactEnvelope,
  LaneResultMaterializer,
  operationKey,
  planningRunStateHash,
  RunStore,
  StoreError,
  sha256Bytes,
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
  G22_EVALUATION_TASK,
  G22_GENERATION_TASK,
  G22_SOLUTION_R1,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";
import {
  createDiscoveryRuntimeFixture,
  runtimeEnvelope,
} from "./fixtures/g2.2/discovery-runtime-fixture.js";
import { createConfirmedRun, publishInitialPlanBundle } from "./helpers/current-run.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const createdAt = "2026-07-31T16:00:00Z";

function runHarness(args: readonly string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "harness/src/cli.ts", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

async function removePublicationCommitTail(
  runRoot: string,
  artifactPaths: readonly string[],
): Promise<void> {
  const publicationRoot = path.join(runRoot, ".store/publications");
  const commits = await Promise.all(
    (await readdir(publicationRoot)).map(async (filename) => ({
      filename,
      document: JSON.parse(await readFile(path.join(publicationRoot, filename), "utf8")) as Record<
        string,
        unknown
      >,
    })),
  );
  commits.sort(
    (left, right) =>
      Number(left.document.publication_ordinal) - Number(right.document.publication_ordinal),
  );
  const targets = new Set(artifactPaths);
  const firstTarget = commits.findIndex((commit) =>
    targets.has(String(commit.document.artifact_path)),
  );
  assert.ok(firstTarget >= 0);
  const tail = commits.slice(firstTarget);
  assert.deepEqual(
    tail.map((commit) => String(commit.document.artifact_path)).sort(),
    [...targets].sort(),
  );
  for (const commit of tail) {
    await rm(path.join(publicationRoot, commit.filename));
  }
}

type RuntimeArtifact = {
  readonly artifact_type: string;
  readonly artifact_path: string;
  readonly producer_role: "main_agent" | "lane_researcher" | "harness";
  readonly input_refs?: readonly string[];
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
  const lanes = planUnits(plan).map((unit) => {
    const ownsResponse = kind === "evaluation" && unit.unit_id === "unit_counterfactual";
    return {
      unit_id: unit.unit_id,
      lane_role: kind === "generation" ? "opportunity" : "evaluation",
      candidate_scope: { kind: "none", candidate_refs: [] },
      incumbent_response_assignment: {
        analysis_depth: ownsResponse ? "lightweight_scan" : "not_assigned",
        assignment_role: ownsResponse ? "owner" : "none",
        subject_refs: ownsResponse ? [G22_DEMAND_R1, G22_BASELINE_R1, G22_SOLUTION_R1] : [],
        rationale: ownsResponse
          ? "Formed candidates receive a bounded lightweight response scan."
          : "This lane is not the assigned incumbent response owner.",
      },
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
    };
  });
  return {
    schema_version: "startup_opportunity.research_execution_plan.discovery.current",
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
    resource_allocation: {
      customer_commercial_percent: 65,
      market_structure_percent: 17,
      academic_percent: 18,
    },
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
    pre_candidate_roles: [],
    required_candidate_kinds: ["demand_seed", "baseline_seed", "solution_seed"],
    missing_candidate_kinds: [],
    question_coverage: (plan.research_questions as Record<string, unknown>[]).map((question) => ({
      question_ref: `${G21_PLAN_REF}#${String(question.question_id)}`,
      status: "unresolved",
      judgment_refs: [],
      evidence_refs: [],
      basis_refs: candidateRoles.map((role) => role.candidate_ref),
    })),
    commercial_signal_gate: {
      demand_signal: false,
      buyer_signal: false,
      purchase_signal: false,
      decision: "early_stop_insufficient_evidence",
    },
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

function terminalGap(runId: string, plan: Record<string, unknown>): Record<string, unknown> {
  const readinessPath = "artifacts/discovery/readiness/terminal-closure.r1.json";
  const candidateRefs = [G22_DEMAND_R1, G22_BASELINE_R1, G22_SOLUTION_R1];
  return {
    schema_version: "startup_opportunity.gap_snapshot.discovery.readiness.current",
    snapshot_id: "gap_terminal_closure_synthetic",
    snapshot_cycle_key: canonicalContentHash({ run_id: runId, cycle: "terminal_closure" }),
    run_id: runId,
    based_on_plan_ref: G21_PLAN_REF,
    revision: 1,
    parent_snapshot_ref: null,
    created_at: createdAt,
    trigger_kind: "wave_completed",
    trigger_event_ref: null,
    phase: "discovery",
    wave_id: "wave_terminal_closure_synthetic",
    readiness_ref: readinessPath,
    fan_in_ref: null,
    observed_artifact_refs: [readinessPath],
    gaps: [
      {
        gap_id: "gap_terminal_closure_synthetic",
        subject_ref: G22_SOLUTION_R1,
        gap_type: "no_information_gain",
        detection_mode: "agent_semantic",
        decision_impact: ["recommendation_band", "selected_solution", "next_action"],
        severity: "blocking",
        basis_refs: [readinessPath, ...candidateRefs],
        evidence_refs: [],
        recommended_unit_types: [],
        allowed_actions: ["terminate_insufficient_evidence"],
        detail: "SYNTHETIC terminal Gap closes the readiness blocker without research claims.",
      },
    ],
    material_new_evidence_observed: false,
    unresolved_decision_relevant_questions: (
      plan.research_questions as Record<string, unknown>[]
    ).map((question) => `${G21_PLAN_REF}#${String(question.question_id)}`),
    stop_signals: ["no_material_new_evidence", "source_repetition"],
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
    schema_version: "startup_opportunity.dispatch_batch.discovery.current",
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
    dispatch_mode: "parallel_immediate",
    tasks: lanes.map((lane) => {
      const unit = units.get(String(lane.unit_id));
      assert.ok(unit);
      return {
        task_id: `task_${String(lane.unit_id)}`,
        unit_id: lane.unit_id,
        lane_role: lane.lane_role,
        incumbent_response_assignment: structuredClone(lane.incumbent_response_assignment),
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
    launch_registration_required: true,
    limitations: ["SYNTHETIC dispatch contract; the Harness does not start agents."],
  };
}

function lifecycle(
  runId: string,
  unitId: string,
  batch: Record<string, unknown>,
  revision: number,
  state: "dispatch_requested" | "agent_started",
): Record<string, unknown> {
  const document: Record<string, unknown> = {
    schema_version: "startup_opportunity.lane_lifecycle.v1",
    revision,
    run_id: runId,
    unit_id: unitId,
    attempt: 1,
    execution_attempt_id: `execution_${unitId}_attempt_1`,
    dispatch_batch_ref: `tasks/dispatch/runtime.r1.json#task_${unitId}`,
    dispatch_batch_hash: canonicalContentHash(batch),
    task_ref: `tasks/dispatch/runtime.r1.json#task_${unitId}`,
    task_id: `task_${unitId}`,
    launch_registration_ref: null,
    launch_registration_id: null,
    launch_registration_hash: null,
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
  document.lifecycle_id = canonicalLaneLifecycleId(document);
  document.parent_lifecycle_ref =
    revision === 1 ? null : canonicalLaneLifecyclePath(document, revision - 1);
  return document;
}

function compilerCodes(error: unknown): readonly string[] {
  if (!(error instanceof StoreError)) {
    return [];
  }
  return ["issues", "bundleErrors", "documentErrors", "referenceErrors"].flatMap((field) => {
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
  await createConfirmedRun(runStore, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-31T15:59:00Z",
  });
  await publishInitialPlanBundle(
    runStore,
    runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  );
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
  await createConfirmedRun(runStore, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-31T15:59:00Z",
  });
  const evidence = new EvidenceStore(runsRoot);
  const generation = (
    await evidence.record({
      runId,
      unitId: "unit_seed_independent_demand",
      acquisitionGoal: "SYNTHETIC task bridge generation substrate; not Evidence.",
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
      acquisitionGoal: "SYNTHETIC task bridge evaluation substrate; not Evidence.",
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
  await publishInitialPlanBundle(
    runStore,
    runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  );
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
          envelope.schema_version === "startup_opportunity.artifact_envelope.current" &&
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
  taskRef = G22_GENERATION_TASK,
): FormalArtifactEnvelope {
  const envelope = structuredClone(runtimeEnvelope(bundle, taskRef));
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
  envelope.document.input_refs = unit.input_refs;
  envelope.document.allowed_output_path = unit.output_path;
  envelope.document.required_artifact_schema = unit.required_artifact_schema;
  (envelope as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    envelope.document,
  );
  return envelope;
}

function canonicalDiscoveryTasks(
  bundle: DocumentBundle,
  plan: Record<string, unknown>,
  batch: Record<string, unknown>,
): FormalArtifactEnvelope[] {
  const dispatchedUnitIds = new Set(
    (batch.tasks as Record<string, unknown>[])
      .filter(
        (task) =>
          task.required_artifact_schema === "startup_opportunity.discovery_lane_result.v1" ||
          task.required_artifact_schema === "startup_opportunity.discovery_generation_result.v1" ||
          task.required_artifact_schema === "startup_opportunity.enrichment_branch_result.v1",
      )
      .map((task) => String(task.unit_id)),
  );
  return [G22_GENERATION_TASK, G22_EVALUATION_TASK]
    .map((taskRef) => canonicalDiscoveryTask(bundle, plan, taskRef))
    .filter((task) => dispatchedUnitIds.has(String(task.document.unit_id)))
    .map((task) => {
      const dispatched = (batch.tasks as Record<string, unknown>[]).find(
        (candidate) => candidate.unit_id === task.document.unit_id,
      );
      assert.ok(dispatched);
      const requirements = task.document.commercial_research_requirements as Record<
        string,
        unknown
      >;
      task.document.allowed_output_path = dispatched.allowed_output_path;
      task.document.required_artifact_schema = dispatched.required_artifact_schema;
      if (
        dispatched.required_artifact_schema === "startup_opportunity.discovery_generation_result.v1"
      ) {
        task.document.target_candidate_refs = [];
      }
      requirements.incumbent_response_assignment = structuredClone(
        dispatched.incumbent_response_assignment,
      );
      (task as unknown as { content_hash: string }).content_hash = canonicalContentHash(
        task.document,
      );
      return task;
    });
}

function canonicalTaskArtifacts(
  bundle: DocumentBundle,
  plan: Record<string, unknown>,
  batch: Record<string, unknown>,
): RuntimeArtifact[] {
  return canonicalDiscoveryTasks(bundle, plan, batch).map((task) => ({
    artifact_type: task.artifact_type,
    artifact_path: task.artifact_path,
    producer_role: "main_agent",
    input_refs: task.input_refs,
    document: task.document,
  }));
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

function unrankedCommercialDelivery(runId: string, unitId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.commercial_research_delivery.current",
    run_id: runId,
    unit_id: unitId,
    audited_at: "2026-07-31T16:03:00Z",
    research_objectives: ["Disclose that no current commercial Evidence was available."],
    primary_routes: ["Synthetic fixture route; no external research was performed."],
    search_results: [],
    evidence_sources: [],
    findings: [],
    claims: [],
    judgments: [],
    quantitative_observations: [],
    competitive_observations: [],
    incumbent_response_assessments: [],
    unresolved_gaps: [],
    limitations: ["SYNTHETIC contract delivery; no market research was performed."],
    stop_reason: "The fixture has no current commercial Evidence to adopt.",
    telemetry_basis: "unavailable",
    query_log_complete: false,
  };
}

function incompleteDiscoveryLaneResult(
  runId: string,
  task: FormalArtifactEnvelope,
  auditRef: string,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.discovery_lane_result.v1",
    lane_result_id: `lane_${String(task.document.unit_id)}_delivery`,
    run_id: runId,
    unit_id: task.document.unit_id,
    attempt: task.document.attempt,
    task_ref: task.artifact_path,
    lane_type: task.document.unit_type,
    status: "insufficient_evidence",
    owner_role: "lane-researcher",
    research_goals: [String(task.document.research_goal)],
    queries: ["SYNTHETIC bounded contract query; no external research was performed."],
    evidence_lineage: {
      evidence_refs: [],
      claim_refs: [],
      finding_refs: [],
      insight_refs: [],
      judgment_assessment_refs: [],
      source_manifest_refs: [],
      audit_refs: [auditRef],
    },
    scope_outcomes: ["buyer", "demand"].map((scopeKey) => ({
      scope_key: scopeKey,
      disposition: "no_evidence_found",
      evidence_refs: [],
      claim_refs: [],
      finding_refs: [],
      judgment_assessment_refs: [],
      notes: "The synthetic fixture did not find current Evidence for this assigned scope.",
    })),
    scored_candidates: [],
    pre_kill_decisions: [],
    retained_candidate_refs: [],
    watchlist_candidate_refs: [],
    rejected_candidate_refs: [],
    candidate_diversity_summary: {
      covered_users: [],
      covered_jobs: [],
      covered_entry_scenes: [],
      covered_buyer_models: [],
      covered_candidate_kinds: [],
      diversity_retention_refs: [],
      counterfactual_candidate_refs: [],
      known_blind_spots: ["SYNTHETIC fixture has no current research evidence."],
    },
    decision_sufficiency_summary: {
      status: "insufficient",
      insufficiency_reasons: ["SYNTHETIC fixture has no current research evidence."],
      what_would_change_the_decision: ["Current independent evidence."],
    },
    open_questions: ["Does current independent evidence exist?"],
    reference_only: true,
    source_boundary: task.document.execution_contract,
    limitations: ["SYNTHETIC contract result; no external research was performed."],
  };
}

function commercialDeliveryWithSemanticEvidence(
  runId: string,
  unitId: string,
  evidenceRef: string,
): Record<string, unknown> {
  return {
    ...unrankedCommercialDelivery(runId, unitId),
    research_objectives: ["Preserve a typed counterevidence record across semantic statements."],
    primary_routes: ["Repository-existing typed Evidence."],
    evidence_sources: [
      {
        evidence_ref: evidenceRef,
        source_kind: "independent",
        source_profile: {
          type: "other",
          description: "Synthetic typed Evidence used only to exercise formal reference closure.",
        },
        evidence_character: "counterevidence",
        independence: "unknown",
        claim_type: "counterevidence",
        content_summary:
          "The fixture preserves a typed Evidence dependency without a market claim.",
        retrieved_at: "2026-07-31T16:02:00Z",
        published_at: null,
        observed_at: "2026-07-31T16:02:00Z",
        data_period_end: null,
        coverage_keys: ["independent_counterevidence"],
        disposition: "adopted",
        exclusion_reason: null,
      },
    ],
    findings: [
      {
        statement: "The typed fixture Evidence is retained as counterevidence.",
        evidence_refs: [evidenceRef],
      },
    ],
    claims: [
      {
        statement: "The formal Audit retains the typed fixture Evidence dependency.",
        evidence_refs: [evidenceRef],
        confidence: "low",
      },
    ],
    judgments: [
      {
        statement: "No commercial conclusion is drawn from the synthetic counterevidence.",
        evidence_refs: [evidenceRef],
      },
    ],
    limitations: ["SYNTHETIC contract fixture; no market research was performed."],
    stop_reason: "The typed reference-closure fixture was complete.",
  };
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
  const planQuestion = (first.plan.research_questions as Record<string, unknown>[])[0];
  assert.ok(planQuestion);
  const policyRef = "harness/policies/adaptation.current.json";
  const fragmentRef = `${G21_PLAN_REF}#${String(planQuestion.question_id)}`;
  const artifact = {
    ...runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
    input_refs: [policyRef, fragmentRef],
  };
  const compiler = new DeclarativeRuntimeCompiler(first.runsRoot, first.validator);
  const requestId = "request_validate_synthetic";
  const firstRunRoot = path.join(first.runsRoot, first.runId);
  const beforeDryRun = await snapshotTree(firstRunRoot);
  const validated = await compiler.compile(
    compilationRequest(first.runId, "validate_only", [artifact], requestId),
  );
  assert.equal(validated.status, "validated");
  assert.deepEqual(validated.publication_preflight, {
    status: "ready",
    operation: "validate_only",
    issue_count: 0,
    root_causes: [],
    resolved_reference_count: validated.publication_plan.resolved_references.length,
    publication_count: 1,
  });
  assert.deepEqual(await snapshotTree(firstRunRoot), beforeDryRun);
  assert.equal(
    validated.compiled_envelopes[0]?.schema_version,
    "startup_opportunity.artifact_envelope.current",
  );
  assert.ok(validated.validation_closure.document_count > 1);
  const resolvedByRef = new Map(
    validated.publication_plan.resolved_references.map((reference) => [reference.ref, reference]),
  );
  assert.equal(resolvedByRef.get(policyRef)?.kind, "repository_policy");
  assert.match(String(resolvedByRef.get(policyRef)?.content_hash), /^sha256:[a-f0-9]{64}$/u);
  assert.equal(resolvedByRef.get(fragmentRef)?.kind, "run_artifact_fragment");

  const request = {
    ...compilationRequest(first.runId, "publish", [], requestId),
    publication_plan: validated.publication_plan,
  };
  const published = await compiler.compile(request);
  assert.equal(published.status, "published");
  assert.equal(published.publication_plan.plan_id, validated.publication_plan.plan_id);
  const replay = await compiler.compile(request);
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.publication_plan.plan_id, validated.publication_plan.plan_id);

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
  const faultStatus = await fault.runStore.status(fault.runId);
  const operationTiming = faultStatus.observability.operationTimings.find(
    (entry) => entry.operationId === "request_fault_synthetic",
  );
  assert.ok(operationTiming);
  assert.equal(operationTiming.attemptCount, 2);
  assert.equal(operationTiming.retryCount, 1);
  assert.equal(operationTiming.latestOutcome, "published");
  assert.ok(operationTiming.durationMs >= 0);
  assert.equal(faultStatus.observability.publishRetryCount, 1);
});

test("compiler preflight aggregates construction and reference root causes before any write", async (t) => {
  const state = await prepareRun(t, "preflight-diagnostics");
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  const runRoot = path.join(state.runsRoot, state.runId);
  const before = await snapshotTree(runRoot);
  const invalidArtifacts = [
    runtimeArtifact(
      "plans/research-execution.r1.json",
      {
        schema_version: "startup_opportunity.research_execution_plan.discovery.current",
        run_id: "wrong-run-synthetic",
      },
      "main_agent",
    ),
    runtimeArtifact(
      "tasks/dispatch/runtime.r1.json",
      {
        schema_version: "startup_opportunity.dispatch_batch.discovery.current",
        run_id: "wrong-run-synthetic",
      },
      "harness",
    ),
  ];
  await assert.rejects(
    compiler.compile(
      compilationRequest(
        state.runId,
        "validate_only",
        invalidArtifacts,
        "request_aggregate_construction_synthetic",
      ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.code, "runtime.compilation_preflight_failed");
      const issues = error.details.issues as Record<string, unknown>[];
      assert.equal(issues.length, 2);
      assert.deepEqual(issues.map((issue) => issue.artifact).sort(), [
        "plans/research-execution.r1.json",
        "tasks/dispatch/runtime.r1.json",
      ]);
      assert.ok(
        issues.every(
          (issue) =>
            typeof issue.code === "string" &&
            typeof issue.path === "string" &&
            "reference" in issue &&
            typeof issue.likely_cause === "string",
        ),
      );
      assert.equal((error.details.root_causes as unknown[]).length, 1);
      return true;
    },
  );
  assert.deepEqual(await snapshotTree(runRoot), before);

  const execution = executionPlan(state.runId, state.plan);
  const validWithMissingRefs = {
    ...runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
    input_refs: ["artifacts/missing/first.json", "artifacts/missing/second.json"],
  };
  await assert.rejects(
    compiler.compile(
      compilationRequest(
        state.runId,
        "validate_only",
        [validWithMissingRefs],
        "request_aggregate_references_synthetic",
      ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.code, "reference.closure_failed");
      const issues = error.details.issues as Record<string, unknown>[];
      assert.deepEqual(
        issues.map((issue) => issue.reference),
        ["artifacts/missing/first.json", "artifacts/missing/second.json"],
      );
      assert.ok(issues.every((issue) => typeof issue.likely_cause === "string"));
      assert.equal((error.details.root_causes as unknown[]).length, 1);
      return true;
    },
  );
  assert.deepEqual(await snapshotTree(runRoot), before);
});

test("compiler rejects an illegal initial Plan tuple before publication planning and publishes the same legal closure", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-p1-initial-plan-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "p1-initial-plan-preflight-synthetic";
  const validator = await createArtifactValidator(repositoryRoot);
  const runStore = new RunStore(runsRoot, validator);
  await createConfirmedRun(runStore, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test prospective Plan semantic publication",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-31T15:59:00Z",
  });
  const fixture = await createDiscoveryMapsFixture("general", runId);
  const legalPlan = structuredClone(fixtureDocument(fixture, G21_PLAN_REF));
  const legalWave = (legalPlan.waves as Record<string, unknown>[])[0];
  assert.ok(legalWave);
  const legalUnits = legalWave.units as Record<string, unknown>[];
  assert.ok(legalUnits[0] && legalUnits[1]);
  legalUnits[0].output_path =
    "artifacts/discovery/lanes/unit_seed_independent_demand.attempt-1.json";
  legalUnits[1].output_path = "artifacts/discovery/lanes/unit_counterfactual.attempt-1.json";
  legalUnits.push({
    ...structuredClone(legalUnits[1]),
    unit_id: "unit_bounded_buyer_commercial",
    unit_type: "bounded_domain_research",
    lane_kind: "buyer_commercial_research",
    research_goal: "SYNTHETIC bounded buyer and commercial research; no research was performed.",
    output_path: "artifacts/discovery/lanes/unit_bounded_buyer_commercial.attempt-1.json",
  });
  const planningContext = (plan: Record<string, unknown>) => ({
    schema_version: "startup_opportunity.planning_context.ai_source_bound.current",
    context_id: "planning_context_initial_plan_preflight_synthetic",
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
      plan_id: legalPlan.plan_id,
      plan_revision: 1,
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
  });
  const compilationArtifacts = (plan: Record<string, unknown>): readonly RuntimeArtifact[] => [
    ...[G21_CORE_REFS[0], G21_CORE_REFS[1], G21_CORE_REFS[2]].map((artifactPath) =>
      runtimeArtifact(artifactPath, fixtureDocument(fixture, artifactPath), "main_agent"),
    ),
    runtimeArtifact(G21_PLAN_REF, plan, "main_agent"),
    runtimeArtifact("plans/planning-context.r1.json", planningContext(plan), "main_agent"),
  ];
  const compiler = new DeclarativeRuntimeCompiler(runsRoot, validator);
  const invalidPlan = structuredClone(legalPlan);
  const invalidUnits = planUnits(invalidPlan);
  assert.ok(invalidUnits[2]);
  invalidUnits[2].unit_type = "buyer_language";
  delete invalidUnits[2].lane_kind;
  const manifestBefore = (await runStore.status(runId)).manifest;
  await assert.rejects(
    compiler.compile(
      compilationRequest(
        runId,
        "publish",
        compilationArtifacts(invalidPlan),
        "request_illegal_initial_plan_tuple_synthetic",
      ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.code, "runtime.compilation_plan_preflight_failed");
      assert.ok(
        (error.details.issues as Record<string, unknown>[]).some(
          (issue) => issue.code === "contract.unit_tuple_not_allowed",
        ),
        canonicalJson(error.details),
      );
      return true;
    },
  );
  const manifestAfterRejectedPublish = (await runStore.status(runId)).manifest;
  assert.equal(manifestAfterRejectedPublish.current_plan_ref, null);
  assert.equal(manifestAfterRejectedPublish.plan_revision, 0);
  assert.deepEqual(manifestAfterRejectedPublish.artifact_refs, manifestBefore.artifact_refs);
  await assert.rejects(readFile(path.join(runsRoot, runId, G21_PLAN_REF), "utf8"));

  const validated = await compiler.compile(
    compilationRequest(
      runId,
      "validate_only",
      compilationArtifacts(legalPlan),
      "request_legal_initial_plan_tuple_synthetic",
    ),
  );
  assert.equal(validated.status, "validated");
  assert.deepEqual(
    planUnits(legalPlan).map((unit) => unit.unit_type),
    ["user_language_mining", "counter_evidence", "bounded_domain_research"],
  );
  const published = await compiler.compile({
    ...compilationRequest(runId, "publish", [], "request_legal_initial_plan_tuple_synthetic"),
    publication_plan: validated.publication_plan,
  });
  assert.equal(published.status, "published");
  assert.equal(published.publication_plan.plan_id, validated.publication_plan.plan_id);
  assert.equal((await runStore.status(runId)).manifest.current_plan_ref, G21_PLAN_REF);
  const replayed = await compiler.compile({
    ...compilationRequest(runId, "publish", [], "request_legal_initial_plan_tuple_synthetic"),
    publication_plan: validated.publication_plan,
  });
  assert.equal(replayed.status, "idempotent_replay");
  assert.equal(replayed.publication_plan.plan_id, validated.publication_plan.plan_id);
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
    schema_version: "startup_opportunity.document_bundle.current",
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
    "startup_opportunity.artifact_envelope.current",
  );
  assert.equal(
    byPath.get(G22_DEMAND_R1)?.schema_version,
    "startup_opportunity.artifact_envelope.current",
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

  const gapPath = "adaptations/gap-snapshots/gap_terminal_closure_synthetic.r1.json";
  const gapRequest = compilationRequest(
    state.runId,
    "publish",
    [runtimeArtifact(gapPath, terminalGap(state.runId, state.plan), "harness")],
    "request_terminal_gap_replay_synthetic",
  );
  assert.equal((await compiler.compile(gapRequest)).status, "published");
  assert.equal((await compiler.compile(gapRequest)).status, "idempotent_replay");
  const afterGap = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.equal(afterGap.manifest.latest_gap_snapshot_ref, gapPath);

  const blockedCandidate = structuredClone(fixtureDocument(state.bundle, G22_DEMAND_R1));
  await assert.rejects(
    compiler.compile(
      compilationRequest(
        state.runId,
        "publish",
        [
          runtimeArtifact(
            "artifacts/discovery/candidates/blocked-after-gap.r1.json",
            blockedCandidate,
            "main_agent",
          ),
        ],
        "request_blocked_after_gap_synthetic",
      ),
    ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.transition_blocking_gap_unresolved",
  );
});

test("complete same-wave dispatch activates both units and lifecycle revisions cannot regress", async (t) => {
  const state = await prepareDiscoveryTaskBridgeRun(t, "dispatch");
  const execution = executionPlan(state.runId, state.plan, "evaluation");
  const batch = dispatchBatch(state.runId, state.plan, execution);
  const responseAssignments = (execution.stages as Record<string, unknown>[]).flatMap((stage) =>
    (stage.lanes as Record<string, unknown>[]).map(
      (lane) => lane.incumbent_response_assignment as Record<string, unknown>,
    ),
  );
  assert.equal(
    responseAssignments.filter((assignment) => assignment.assignment_role === "owner").length,
    1,
  );
  assert.ok(
    responseAssignments
      .filter((assignment) => assignment.assignment_role !== "owner")
      .every(
        (assignment) =>
          assignment.assignment_role === "none" && assignment.analysis_depth === "not_assigned",
      ),
  );
  const duplicateOwner = structuredClone(execution);
  const duplicateLanes = (duplicateOwner.stages as Record<string, unknown>[])[0]?.lanes as Record<
    string,
    unknown
  >[];
  const ownerAssignment = responseAssignments.find(
    (assignment) => assignment.assignment_role === "owner",
  );
  assert.ok(ownerAssignment);
  const unassignedLane = duplicateLanes.find((lane) => {
    const assignment = lane.incumbent_response_assignment as Record<string, unknown>;
    return assignment.assignment_role === "none";
  });
  assert.ok(unassignedLane);
  unassignedLane.incumbent_response_assignment = structuredClone(ownerAssignment);
  const duplicateOwnerCodes = validateDeclarativeRuntimeContract([
    {
      path: G21_PLAN_REF,
      schemaVersion: String(state.plan.schema_version),
      document: state.plan,
      envelope: null,
    },
    {
      path: "plans/research-execution.r1.json",
      schemaVersion: String(duplicateOwner.schema_version),
      document: duplicateOwner,
      envelope: null,
    },
  ]).map((issue) => issue.code);
  assert.ok(duplicateOwnerCodes.includes("runtime.incumbent_response_owner_invalid"));
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
      ...canonicalTaskArtifacts(state.bundle, state.plan, batch),
    ]),
  );
  assert.equal(published.status, "published");
  const unitIds = planUnits(state.plan)
    .map((unit) => String(unit.unit_id))
    .sort();
  assert.deepEqual((await state.runStore.status(state.runId)).manifest.active_units, unitIds);

  const firstUnitId = unitIds[0];
  assert.ok(firstUnitId);
  const started = lifecycle(state.runId, firstUnitId, batch, 1, "agent_started");
  await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact(canonicalLaneLifecyclePath(started), started, "main_agent"),
    ]),
  );
  const regressed = lifecycle(state.runId, firstUnitId, batch, 2, "dispatch_requested");
  await assert.rejects(
    compiler.compile(
      compilationRequest(state.runId, "validate_only", [
        runtimeArtifact(canonicalLaneLifecyclePath(regressed), regressed, "main_agent"),
      ]),
    ),
    (error: unknown) => compilerCodes(error).includes("runtime.lifecycle_state_regression"),
  );
});

test("public CLI closes exact Dispatch launch sets incrementally and rejects identity drift atomically", async (t) => {
  const state = await prepareDiscoveryTaskBridgeRun(t, "launch-registry-cli");
  const execution = executionPlan(state.runId, state.plan, "evaluation");
  const batch = dispatchBatch(state.runId, state.plan, execution);
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  const published = await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
      runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
      ...canonicalTaskArtifacts(state.bundle, state.plan, batch),
    ]),
  );
  assert.equal(published.dispatch_launch_checklists.length, 1);
  const initialChecklist = published.dispatch_launch_checklists[0];
  assert.ok(initialChecklist);
  assert.equal(initialChecklist.status, "open");
  assert.deepEqual(initialChecklist.started_unit_ids, []);

  const dispatchRef = "tasks/dispatch/runtime.r1.json";
  const dispatchHash = canonicalContentHash(batch);
  const formalTasks = canonicalDiscoveryTasks(state.bundle, state.plan, batch);
  const registrations = (batch.tasks as Record<string, unknown>[])
    .map((task) => {
      const formalTask = formalTasks.find(
        (candidate) => candidate.document.unit_id === task.unit_id,
      );
      assert.ok(formalTask);
      return {
        unit_id: String(task.unit_id),
        task_ref: `${dispatchRef}#${String(task.task_id)}`,
        task_id: String(task.task_id),
        attempt: Number(formalTask.document.attempt),
        execution_attempt_id: `external_${String(task.unit_id)}_attempt_1`,
      };
    })
    .reverse();
  assert.equal(registrations.length, 2);
  const requestPath = (suffix: string) => path.join(state.root, `launch-${suffix}.json`);
  const writeRequest = async (
    suffix: string,
    selected: readonly (typeof registrations)[number][],
    changes: Readonly<Record<string, unknown>> = {},
  ): Promise<string> => {
    const target = requestPath(suffix);
    await writeFile(
      target,
      `${JSON.stringify({
        schema_version: "startup_opportunity.dispatch_launch_registration_request.v1",
        request_id: `launch_${suffix}`,
        run_id: state.runId,
        dispatch_ref: dispatchRef,
        dispatch_hash: dispatchHash,
        registered_at: "2026-07-31T16:01:02Z",
        registrations: selected,
        ...changes,
      })}\n`,
    );
    return target;
  };
  const register = (file: string) =>
    runHarness(["register-dispatch-launches", "--file", file, "--runs-root", state.runsRoot]);
  const check = () =>
    runHarness([
      "check-dispatch-launches",
      "--run-id",
      state.runId,
      "--dispatch-ref",
      dispatchRef,
      "--dispatch-hash",
      dispatchHash,
      "--runs-root",
      state.runsRoot,
    ]);

  const firstRequest = await writeRequest("first", [
    registrations[0] as (typeof registrations)[number],
  ]);
  const first = register(firstRequest);
  assert.equal(first.status, 0, first.stderr);
  const firstResult = JSON.parse(first.stdout) as Record<string, unknown>;
  assert.equal(firstResult.status, "open");
  assert.deepEqual(firstResult.started_unit_ids, [registrations[0]?.unit_id].sort());
  assert.deepEqual(firstResult.not_started_unit_ids, [registrations[1]?.unit_id].sort());
  const firstRegistration = registrations[0] as (typeof registrations)[number];
  const firstIdentity = {
    run_id: state.runId,
    dispatch_batch_ref: `${dispatchRef}#${firstRegistration.task_id}`,
    dispatch_batch_hash: dispatchHash,
    task_ref: firstRegistration.task_ref,
    task_id: firstRegistration.task_id,
    unit_id: firstRegistration.unit_id,
    attempt: firstRegistration.attempt,
    execution_attempt_id: firstRegistration.execution_attempt_id,
  };
  const firstLifecycleRef = canonicalLaneLifecyclePath(firstIdentity, 1);
  const firstRegistrationRef = dispatchLaunchRegistrationPath("launch_first");
  const operationReceipts = await Promise.all(
    (await readdir(path.join(state.runRoot, ".store", "operations")))
      .filter((entry) => entry.startsWith("bundle-") && entry.endsWith(".json"))
      .map(async (entry) =>
        JSON.parse(await readFile(path.join(state.runRoot, ".store", "operations", entry), "utf8")),
      ),
  );
  const firstBundleReceipt = operationReceipts.find(
    (receipt) =>
      Array.isArray(receipt.envelopes) &&
      receipt.envelopes.some(
        (envelope: Record<string, unknown>) => envelope.artifact_path === firstRegistrationRef,
      ),
  ) as Record<string, unknown> | undefined;
  assert.ok(firstBundleReceipt);
  assert.deepEqual(
    (firstBundleReceipt.envelopes as Record<string, unknown>[])
      .map((envelope) => envelope.artifact_path)
      .sort(),
    [firstLifecycleRef, firstRegistrationRef].sort(),
  );
  const laneTimingBeforeRecovery = (await state.runStore.status(state.runId)).observability
    .laneTimings;
  const extraEnvelope = JSON.parse(
    await readFile(path.join(state.runRoot, dispatchRef), "utf8"),
  ) as FormalArtifactEnvelope;
  const malformedReceipt = structuredClone(firstBundleReceipt) as Record<string, unknown>;
  const malformedEnvelopes = [
    ...(malformedReceipt.envelopes as FormalArtifactEnvelope[]),
    extraEnvelope,
  ].sort((left, right) => left.artifact_path.localeCompare(right.artifact_path));
  const malformedOperationKey = operationKey("publish_artifact_bundle", {
    run_id: state.runId,
    envelopes: malformedEnvelopes,
  });
  malformedReceipt.operation_key = malformedOperationKey;
  malformedReceipt.envelopes = malformedEnvelopes;
  const operationDirectory = path.join(state.runRoot, ".store", "operations");
  const exactReceiptEntry = (await readdir(operationDirectory)).find(
    (entry) =>
      entry.startsWith("bundle-") &&
      entry.endsWith(".json") &&
      entry === `bundle-${String(firstBundleReceipt.operation_key).slice("sha256:".length)}.json`,
  );
  assert.ok(exactReceiptEntry);
  await removePublicationCommitTail(state.runRoot, [firstRegistrationRef, firstLifecycleRef]);
  await Promise.all(
    [firstRegistrationRef, firstLifecycleRef].map((artifactPath) =>
      rm(path.join(state.runRoot, artifactPath)),
    ),
  );
  await rm(path.join(operationDirectory, exactReceiptEntry));
  const malformedReceiptPath = path.join(
    operationDirectory,
    `bundle-${malformedOperationKey.slice("sha256:".length)}.json`,
  );
  await writeFile(malformedReceiptPath, `${canonicalJson(malformedReceipt)}\n`);
  const beforeMalformedRecovery = await snapshotTree(state.runRoot);
  await assert.rejects(
    new RunStore(state.runsRoot, state.validator).load(state.runId),
    (error: unknown) =>
      error instanceof StoreError && error.code === "recovery.invalid_dispatch_launch_bundle",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), beforeMalformedRecovery);
  await rm(malformedReceiptPath);
  await writeFile(
    path.join(operationDirectory, exactReceiptEntry),
    `${canonicalJson(firstBundleReceipt)}\n`,
  );
  const recoveredLaunch = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.deepEqual(
    recoveredLaunch.recoveredArtifactPaths,
    [firstLifecycleRef, firstRegistrationRef].sort(),
  );
  assert.deepEqual(
    (await state.runStore.status(state.runId)).observability.laneTimings,
    laneTimingBeforeRecovery,
  );
  const afterLaunchRecovery = check();
  assert.equal(afterLaunchRecovery.status, 0, afterLaunchRecovery.stderr);
  assert.equal((JSON.parse(afterLaunchRecovery.stdout) as Record<string, unknown>).status, "open");
  assert.deepEqual(
    (await new RunStore(state.runsRoot, state.validator).load(state.runId)).recoveredArtifactPaths,
    [],
  );
  const downstreamDocument = {
    schema_version: "startup_opportunity.discovery_stage_readiness.v1",
    run_id: state.runId,
  };
  const downstreamEnvelope = {
    schema_version: "startup_opportunity.artifact_envelope.current" as const,
    artifact_type: String(downstreamDocument.schema_version),
    artifact_path: "artifacts/discovery/readiness/launch-open.r1.json",
    run_id: state.runId,
    created_at: "2026-07-31T16:01:03Z",
    producer_role: "main_agent" as const,
    input_refs: [],
    content_hash: canonicalContentHash(downstreamDocument),
    document: downstreamDocument,
  };
  await assert.rejects(
    state.runStore.assertTransitionReady(state.runId, [downstreamEnvelope]),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.transition_dispatch_launch_open",
  );
  const beforeReplay = await snapshotTree(state.runRoot);
  const replay = register(firstRequest);
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(await snapshotTree(state.runRoot), beforeReplay);

  const firstLifecycleEnvelope = JSON.parse(
    await readFile(path.join(state.runRoot, firstLifecycleRef), "utf8"),
  ) as FormalArtifactEnvelope;
  const firstLifecycleRevision2 = structuredClone(firstLifecycleEnvelope.document);
  firstLifecycleRevision2.revision = 2;
  firstLifecycleRevision2.parent_lifecycle_ref = firstLifecycleRef;
  firstLifecycleRevision2.state = "researching";
  const firstLifecycleRevision2Ref = canonicalLaneLifecyclePath(firstLifecycleRevision2, 2);
  for (const [name, artifactPath, mutate, expectedCode] of [
    [
      "noncanonical-path",
      "artifacts/runtime/lane-lifecycle/lifecycle_00000000000000000000000000000000.r2.json",
      () => {},
      "artifact.lifecycle_identity_invalid",
    ],
    [
      "wrong-parent",
      firstLifecycleRevision2Ref,
      (document: Record<string, unknown>) => {
        document.parent_lifecycle_ref =
          "artifacts/runtime/lane-lifecycle/lifecycle_00000000000000000000000000000000.r1.json";
      },
      "artifact.lifecycle_parent_invalid",
    ],
    [
      "cleared-launch-provenance",
      firstLifecycleRevision2Ref,
      (document: Record<string, unknown>) => {
        document.launch_registration_ref = null;
        document.launch_registration_id = null;
        document.launch_registration_hash = null;
      },
      "artifact.lifecycle_parent_invalid",
    ],
    [
      "changed-launch-provenance",
      firstLifecycleRevision2Ref,
      (document: Record<string, unknown>) => {
        document.launch_registration_id = "launch_changed";
      },
      "artifact.lifecycle_parent_invalid",
    ],
  ] as const) {
    const invalidRevision = structuredClone(firstLifecycleRevision2);
    mutate(invalidRevision);
    await assert.rejects(
      compiler.compile(
        compilationRequest(state.runId, "validate_only", [
          runtimeArtifact(artifactPath, invalidRevision, "main_agent"),
        ]),
      ),
      (error: unknown) => error instanceof StoreError && error.code === expectedCode,
      name,
    );
  }
  const duplicateRootCodes = validateDeclarativeRuntimeContract([
    {
      path: firstLifecycleRef,
      schemaVersion: "startup_opportunity.lane_lifecycle.v1",
      document: firstLifecycleEnvelope.document,
      envelope: null,
    },
    {
      path: "artifacts/runtime/lane-lifecycle/lifecycle_00000000000000000000000000000000.r1.json",
      schemaVersion: "startup_opportunity.lane_lifecycle.v1",
      document: structuredClone(firstLifecycleEnvelope.document),
      envelope: null,
    },
  ]).map((issue) => issue.code);
  assert.ok(duplicateRootCodes.includes("runtime.lifecycle_revision_conflict"));
  assert.ok(duplicateRootCodes.includes("runtime.lifecycle_identity_invalid"));
  await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact(firstLifecycleRevision2Ref, firstLifecycleRevision2, "main_agent"),
    ]),
  );

  const invalidRegistration = {
    ...(registrations[1] as (typeof registrations)[number]),
    task_id: "task_not_in_dispatch",
  };
  const invalidBatch = await writeRequest("invalid-batch", [
    registrations[1] as (typeof registrations)[number],
    invalidRegistration,
  ]);
  const beforeInvalid = await snapshotTree(state.runRoot);
  const rejectedBatch = register(invalidBatch);
  assert.equal(rejectedBatch.status, 1);
  assert.match(
    rejectedBatch.stderr,
    /runtime\.launch_registration_(?:duplicate|dispatch_mismatch)/u,
  );
  assert.deepEqual(await snapshotTree(state.runRoot), beforeInvalid);

  const reusedExecution = await writeRequest("reused-execution", [
    {
      ...(registrations[1] as (typeof registrations)[number]),
      execution_attempt_id: String(registrations[0]?.execution_attempt_id),
    },
  ]);
  const beforeReusedExecution = await snapshotTree(state.runRoot);
  const rejectedExecution = register(reusedExecution);
  assert.equal(rejectedExecution.status, 1);
  assert.match(rejectedExecution.stderr, /runtime\.launch_registration_conflict/u);
  assert.deepEqual(await snapshotTree(state.runRoot), beforeReusedExecution);

  const secondRegistration = registrations[1] as (typeof registrations)[number];
  const forgedLifecycle = {
    ...structuredClone(firstLifecycleEnvelope.document),
    lifecycle_id: "",
    revision: 1,
    parent_lifecycle_ref: null,
    unit_id: secondRegistration.unit_id,
    attempt: secondRegistration.attempt,
    execution_attempt_id: secondRegistration.execution_attempt_id,
    dispatch_batch_ref: `${dispatchRef}#${secondRegistration.task_id}`,
    task_ref: secondRegistration.task_ref,
    task_id: secondRegistration.task_id,
    launch_registration_ref: "artifacts/runtime/dispatch-launch-registrations/launch_forged.json",
    launch_registration_id: "launch_forged",
    launch_registration_hash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  forgedLifecycle.lifecycle_id = canonicalLaneLifecycleId(forgedLifecycle);
  const forgedLifecycleRef = canonicalLaneLifecyclePath(forgedLifecycle, 1);
  await assert.rejects(
    compiler.compile(
      compilationRequest(state.runId, "publish", [
        runtimeArtifact(forgedLifecycleRef, forgedLifecycle, "main_agent"),
      ]),
    ),
    (error: unknown) =>
      compilerCodes(error).some((code) =>
        ["runtime.lifecycle_launch_registration_invalid", "runtime.reference_missing"].includes(
          code,
        ),
      ),
  );
  const afterForged = check();
  assert.equal(afterForged.status, 0, afterForged.stderr);
  assert.equal((JSON.parse(afterForged.stdout) as Record<string, unknown>).status, "open");
  await assert.rejects(
    state.runStore.assertTransitionReady(state.runId, [downstreamEnvelope]),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.transition_dispatch_launch_open",
  );

  for (const [suffix, registration, changes, code] of [
    [
      "outside-unit",
      { ...(registrations[1] as object), unit_id: "unit_outside_dispatch" },
      {},
      "runtime.launch_registration_dispatch_mismatch",
    ],
    [
      "wrong-task-ref",
      { ...(registrations[1] as object), task_ref: registrations[0]?.task_ref },
      {},
      "runtime.launch_registration_dispatch_mismatch",
    ],
    [
      "wrong-attempt",
      { ...(registrations[1] as object), attempt: 2 },
      {},
      "runtime.launch_registration_dispatch_mismatch",
    ],
    [
      "stale-dispatch",
      registrations[1] as object,
      { dispatch_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      "runtime.launch_dispatch_stale",
    ],
    [
      "early-registration-time",
      registrations[1] as object,
      { registered_at: "2026-07-31T16:00:59Z" },
      "runtime.launch_registration_time_invalid",
    ],
    ["cross-run", registrations[1] as object, { run_id: "another-current-run" }, "run.not_found"],
  ] as const) {
    const file = await writeRequest(
      suffix,
      [registration as (typeof registrations)[number]],
      changes,
    );
    const before = await snapshotTree(state.runRoot);
    const rejected = register(file);
    assert.equal(rejected.status, 1, `${suffix}: ${rejected.stderr}`);
    assert.match(rejected.stderr, new RegExp(code.replaceAll(".", "\\."), "u"));
    assert.deepEqual(await snapshotTree(state.runRoot), before, suffix);
  }

  const manifestPath = path.join(state.runRoot, "manifest.json");
  const activeManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  const terminalProbeRequest = {
    schema_version: "startup_opportunity.dispatch_launch_registration_request.v1",
    request_id: "launch_terminal_probe",
    run_id: state.runId,
    dispatch_ref: dispatchRef,
    dispatch_hash: dispatchHash,
    registered_at: "2026-07-31T16:01:02Z",
    registrations: [secondRegistration],
  };
  const terminalProbeHash = canonicalContentHash(terminalProbeRequest);
  const terminalProbeRegistrationRef = dispatchLaunchRegistrationPath("launch_terminal_probe");
  const terminalProbeLifecycle = {
    ...structuredClone(firstLifecycleEnvelope.document),
    lifecycle_id: "",
    revision: 1,
    parent_lifecycle_ref: null,
    unit_id: secondRegistration.unit_id,
    attempt: secondRegistration.attempt,
    execution_attempt_id: secondRegistration.execution_attempt_id,
    dispatch_batch_ref: `${dispatchRef}#${secondRegistration.task_id}`,
    task_ref: secondRegistration.task_ref,
    task_id: secondRegistration.task_id,
    launch_registration_ref: terminalProbeRegistrationRef,
    launch_registration_id: terminalProbeRequest.request_id,
    launch_registration_hash: terminalProbeHash,
  };
  terminalProbeLifecycle.lifecycle_id = canonicalLaneLifecycleId(terminalProbeLifecycle);
  const terminalProbeLifecycleRef = canonicalLaneLifecyclePath(terminalProbeLifecycle, 1);
  const terminalProbeRegistration = {
    schema_version: "startup_opportunity.dispatch_launch_registration.v1",
    registration_id: terminalProbeRequest.request_id,
    run_id: state.runId,
    dispatch_ref: dispatchRef,
    dispatch_hash: dispatchHash,
    request_hash: terminalProbeHash,
    registered_at: terminalProbeRequest.registered_at,
    registrations: [
      {
        ...secondRegistration,
        lifecycle_ref: terminalProbeLifecycleRef,
        lifecycle_hash: canonicalContentHash(terminalProbeLifecycle),
      },
    ],
    limitations: [
      "Caller-declared launch registration; the Harness does not verify that an external Codex task exists.",
    ],
  };
  const terminalProbeCompilation = await compiler.compile(
    compilationRequest(state.runId, "validate_only", [
      runtimeArtifact(terminalProbeRegistrationRef, terminalProbeRegistration, "harness"),
      runtimeArtifact(terminalProbeLifecycleRef, terminalProbeLifecycle, "main_agent"),
    ]),
  );
  for (const status of [
    "reporting",
    "completed",
    "failed",
    "cancelled",
    "insufficient_evidence",
  ] as const) {
    await writeFile(manifestPath, `${canonicalJson({ ...activeManifest, status })}\n`);
    const beforeTerminal = await snapshotTree(state.runRoot);
    await assert.rejects(
      state.runStore.publishDispatchLaunchRegistration({
        runId: state.runId,
        envelopes: terminalProbeCompilation.compiled_envelopes,
      }),
      (error: unknown) =>
        error instanceof StoreError && error.code === "run.dispatch_launch_registration_terminal",
      status,
    );
    assert.deepEqual(await snapshotTree(state.runRoot), beforeTerminal, status);
  }
  await writeFile(manifestPath, `${canonicalJson(activeManifest)}\n`);
  await moveManifestUnit(state.runRoot, secondRegistration.unit_id, "completed_units");
  const beforeDisposed = await snapshotTree(state.runRoot);
  await assert.rejects(
    state.runStore.publishDispatchLaunchRegistration({
      runId: state.runId,
      envelopes: terminalProbeCompilation.compiled_envelopes,
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      [
        "run.dispatch_launch_registration_unit_disposed",
        "run.dispatch_launch_registration_task_not_current",
      ].includes(error.code),
  );
  assert.deepEqual(await snapshotTree(state.runRoot), beforeDisposed);
  await writeFile(manifestPath, `${canonicalJson(activeManifest)}\n`);

  const secondRequest = await writeRequest("second", [
    registrations[1] as (typeof registrations)[number],
  ]);
  const second = register(secondRequest);
  assert.equal(second.status, 0, second.stderr);
  const secondResult = JSON.parse(second.stdout) as Record<string, unknown>;
  assert.equal(secondResult.status, "closed");
  assert.deepEqual(
    secondResult.started_unit_ids,
    registrations.map((entry) => entry.unit_id).sort(),
  );
  assert.deepEqual(secondResult.not_started_unit_ids, []);
  assert.equal(
    (secondResult as { checklist: Record<string, unknown>[] }).checklist[0]?.launch_state,
    "started",
  );
  await state.runStore.assertTransitionReady(state.runId, [downstreamEnvelope]);

  const conflictRequest = await writeRequest("conflict", [
    {
      ...(registrations[1] as (typeof registrations)[number]),
      execution_attempt_id: "external_conflicting_attempt",
    },
  ]);
  const beforeConflict = await snapshotTree(state.runRoot);
  const conflict = register(conflictRequest);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /runtime\.launch_registration_(?:conflict|path_conflict)/u);
  assert.deepEqual(await snapshotTree(state.runRoot), beforeConflict);

  const checked = check();
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal((JSON.parse(checked.stdout) as Record<string, unknown>).status, "closed");
  const statusBeforeReopen = await state.runStore.status(state.runId);
  await new RunStore(state.runsRoot, state.validator).load(state.runId);
  const afterReopen = check();
  assert.equal(afterReopen.status, 0, afterReopen.stderr);
  assert.deepEqual(JSON.parse(afterReopen.stdout), JSON.parse(checked.stdout));
  const statusAfterReopen = await state.runStore.status(state.runId);
  assert.deepEqual(
    statusAfterReopen.observability.laneTimings,
    statusBeforeReopen.observability.laneTimings,
  );
  for (const registration of registrations) {
    const lifecycleIdentity = {
      run_id: state.runId,
      dispatch_batch_ref: `${dispatchRef}#${registration.task_id}`,
      dispatch_batch_hash: dispatchHash,
      task_ref: registration.task_ref,
      task_id: registration.task_id,
      unit_id: registration.unit_id,
      attempt: registration.attempt,
      execution_attempt_id: registration.execution_attempt_id,
    };
    const lifecyclePath = path.join(
      state.runRoot,
      canonicalLaneLifecyclePath(lifecycleIdentity, 1),
    );
    const persisted = JSON.parse(await readFile(lifecyclePath, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.artifact_type, "startup_opportunity.lane_lifecycle.v1");
    assert.equal(
      (persisted.document as Record<string, unknown> | undefined)?.schema_version,
      "startup_opportunity.lane_lifecycle.v1",
    );
  }
});

test("dispatch launch publisher rejects stale same-request-id conflicts before bundle intent", async (t) => {
  const state = await prepareDiscoveryTaskBridgeRun(t, "launch-stale-preflight");
  const execution = executionPlan(state.runId, state.plan, "evaluation");
  const batch = dispatchBatch(state.runId, state.plan, execution);
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
      runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
      ...canonicalTaskArtifacts(state.bundle, state.plan, batch),
    ]),
  );

  const dispatchRef = "tasks/dispatch/runtime.r1.json";
  const dispatchHash = canonicalContentHash(batch);
  const formalTasks = canonicalDiscoveryTasks(state.bundle, state.plan, batch);
  const registrations = (batch.tasks as Record<string, unknown>[]).map((task) => {
    const formalTask = formalTasks.find((candidate) => candidate.document.unit_id === task.unit_id);
    assert.ok(formalTask);
    return {
      unit_id: String(task.unit_id),
      task_ref: `${dispatchRef}#${String(task.task_id)}`,
      task_id: String(task.task_id),
      attempt: Number(formalTask.document.attempt),
      execution_attempt_id: `external_${String(task.unit_id)}_attempt_1`,
    };
  });
  assert.equal(registrations.length, 2);
  const requestId = "launch_stale_collision";
  const registrationRef = dispatchLaunchRegistrationPath(requestId);
  const compileLaunch = async (selected: readonly (typeof registrations)[number][]) => {
    const request = {
      schema_version: "startup_opportunity.dispatch_launch_registration_request.v1",
      request_id: requestId,
      run_id: state.runId,
      dispatch_ref: dispatchRef,
      dispatch_hash: dispatchHash,
      registered_at: "2026-07-31T16:01:02Z",
      registrations: selected,
    };
    const requestHash = canonicalContentHash(request);
    const lifecycleDocuments = selected.map((registration) => {
      const document = {
        schema_version: "startup_opportunity.lane_lifecycle.v1",
        lifecycle_id: "",
        revision: 1,
        parent_lifecycle_ref: null,
        run_id: state.runId,
        unit_id: registration.unit_id,
        attempt: registration.attempt,
        execution_attempt_id: registration.execution_attempt_id,
        dispatch_batch_ref: `${dispatchRef}#${registration.task_id}`,
        dispatch_batch_hash: dispatchHash,
        task_ref: registration.task_ref,
        task_id: registration.task_id,
        launch_registration_ref: registrationRef,
        launch_registration_id: requestId,
        launch_registration_hash: requestHash,
        state: "agent_started",
        timestamps: {
          task_ready_at: "2026-07-31T16:01:00Z",
          dispatch_requested_at: "2026-07-31T16:01:01Z",
          agent_started_at: "2026-07-31T16:01:02Z",
          evidence_recorded_at: null,
          handoff_ready_at: null,
          formalization_validated_at: null,
          published_at: null,
        },
        failure: null,
        limitations: [
          "Caller-declared launch registration; the Harness does not verify that an external Codex task exists.",
        ],
      };
      document.lifecycle_id = canonicalLaneLifecycleId(document);
      return { lifecycleRef: canonicalLaneLifecyclePath(document, 1), document };
    });
    const registrationDocument = {
      schema_version: "startup_opportunity.dispatch_launch_registration.v1",
      registration_id: requestId,
      run_id: state.runId,
      dispatch_ref: dispatchRef,
      dispatch_hash: dispatchHash,
      request_hash: requestHash,
      registered_at: request.registered_at,
      registrations: lifecycleDocuments.map(({ lifecycleRef, document }) => ({
        unit_id: document.unit_id,
        task_ref: document.task_ref,
        task_id: document.task_id,
        attempt: document.attempt,
        execution_attempt_id: document.execution_attempt_id,
        lifecycle_ref: lifecycleRef,
        lifecycle_hash: canonicalContentHash(document),
      })),
      limitations: [
        "Caller-declared launch registration; the Harness does not verify that an external Codex task exists.",
      ],
    };
    return (
      await compiler.compile(
        compilationRequest(
          state.runId,
          "validate_only",
          [
            runtimeArtifact(registrationRef, registrationDocument, "harness"),
            ...lifecycleDocuments.map(({ lifecycleRef, document }) =>
              runtimeArtifact(lifecycleRef, document, "main_agent"),
            ),
          ],
          `validate_${String(selected[0]?.unit_id ?? "empty")}`,
        ),
      )
    ).compiled_envelopes;
  };

  const beforeValidation = await snapshotTree(state.runRoot);
  const winnerEnvelopes = await compileLaunch([registrations[0] as (typeof registrations)[number]]);
  const loserEnvelopes = await compileLaunch([registrations[1] as (typeof registrations)[number]]);
  assert.deepEqual(await snapshotTree(state.runRoot), beforeValidation);

  const winner = await state.runStore.publishDispatchLaunchRegistration({
    runId: state.runId,
    envelopes: winnerEnvelopes,
  });
  assert.equal(winner.status, "published");
  const afterWinnerTree = await snapshotTree(state.runRoot);
  const afterWinnerReceipts = await snapshotTree(path.join(state.runRoot, ".store", "operations"));
  await assert.rejects(
    state.runStore.publishDispatchLaunchRegistration({
      runId: state.runId,
      envelopes: loserEnvelopes,
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      ["write.bundle_operation_conflict", "write.operation_conflict"].includes(error.code),
  );
  assert.deepEqual(await snapshotTree(state.runRoot), afterWinnerTree);
  assert.deepEqual(
    await snapshotTree(path.join(state.runRoot, ".store", "operations")),
    afterWinnerReceipts,
  );
  assert.deepEqual(
    (await new RunStore(state.runsRoot, state.validator).load(state.runId)).recoveredArtifactPaths,
    [],
  );

  const checked = runHarness([
    "check-dispatch-launches",
    "--run-id",
    state.runId,
    "--dispatch-ref",
    dispatchRef,
    "--dispatch-hash",
    dispatchHash,
    "--runs-root",
    state.runsRoot,
  ]);
  assert.equal(checked.status, 0, checked.stderr);
  const checkResult = JSON.parse(checked.stdout) as Record<string, unknown>;
  assert.equal(checkResult.schema_version, "startup_opportunity.dispatch_launch_check_result.v1");
  assert.equal(checkResult.run_id, state.runId);
  assert.equal(checkResult.dispatch_ref, dispatchRef);
  assert.equal(checkResult.dispatch_hash, dispatchHash);
  assert.equal(checkResult.status, "open");
  assert.deepEqual(checkResult.started_unit_ids, [registrations[0]?.unit_id]);
  assert.deepEqual(checkResult.not_started_unit_ids, [registrations[1]?.unit_id]);
  assert.deepEqual(checkResult.unexpected_registrations, []);
  const checklistByUnit = new Map(
    (checkResult.checklist as Record<string, unknown>[]).map((entry) => [entry.unit_id, entry]),
  );
  assert.deepEqual(
    {
      unit_id: checklistByUnit.get(registrations[0]?.unit_id)?.unit_id,
      task_ref: checklistByUnit.get(registrations[0]?.unit_id)?.task_ref,
      task_id: checklistByUnit.get(registrations[0]?.unit_id)?.task_id,
      attempt: checklistByUnit.get(registrations[0]?.unit_id)?.attempt,
      launch_state: checklistByUnit.get(registrations[0]?.unit_id)?.launch_state,
      execution_attempt_ids: checklistByUnit.get(registrations[0]?.unit_id)?.execution_attempt_ids,
    },
    {
      unit_id: registrations[0]?.unit_id,
      task_ref: registrations[0]?.task_ref,
      task_id: registrations[0]?.task_id,
      attempt: registrations[0]?.attempt,
      launch_state: "started",
      execution_attempt_ids: [registrations[0]?.execution_attempt_id],
    },
  );
  assert.deepEqual(
    {
      unit_id: checklistByUnit.get(registrations[1]?.unit_id)?.unit_id,
      task_ref: checklistByUnit.get(registrations[1]?.unit_id)?.task_ref,
      task_id: checklistByUnit.get(registrations[1]?.unit_id)?.task_id,
      attempt: checklistByUnit.get(registrations[1]?.unit_id)?.attempt,
      launch_state: checklistByUnit.get(registrations[1]?.unit_id)?.launch_state,
      execution_attempt_ids: checklistByUnit.get(registrations[1]?.unit_id)?.execution_attempt_ids,
    },
    {
      unit_id: registrations[1]?.unit_id,
      task_ref: registrations[1]?.task_ref,
      task_id: registrations[1]?.task_id,
      attempt: registrations[1]?.attempt,
      launch_state: "not_started",
      execution_attempt_ids: [],
    },
  );

  const beforeReplay = await snapshotTree(state.runRoot);
  const replay = await state.runStore.publishDispatchLaunchRegistration({
    runId: state.runId,
    envelopes: winnerEnvelopes,
  });
  assert.equal(replay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(state.runRoot), beforeReplay);
});

test("dispatch launch publisher rejects overlapping intent-only bundle conflicts", async (t) => {
  const state = await prepareDiscoveryTaskBridgeRun(t, "launch-intent-only-overlap");
  const execution = executionPlan(state.runId, state.plan, "evaluation");
  const batch = dispatchBatch(state.runId, state.plan, execution);
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
      runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
      ...canonicalTaskArtifacts(state.bundle, state.plan, batch),
    ]),
  );

  const dispatchRef = "tasks/dispatch/runtime.r1.json";
  const dispatchHash = canonicalContentHash(batch);
  const formalTasks = canonicalDiscoveryTasks(state.bundle, state.plan, batch);
  const registrations = (batch.tasks as Record<string, unknown>[]).map((task) => {
    const formalTask = formalTasks.find((candidate) => candidate.document.unit_id === task.unit_id);
    assert.ok(formalTask);
    return {
      unit_id: String(task.unit_id),
      task_ref: `${dispatchRef}#${String(task.task_id)}`,
      task_id: String(task.task_id),
      attempt: Number(formalTask.document.attempt),
      execution_attempt_id: `external_${String(task.unit_id)}_attempt_1`,
    };
  });
  assert.equal(registrations.length, 2);
  const requestId = "launch_intent_only_collision";
  const registrationRef = dispatchLaunchRegistrationPath(requestId);
  const compileLaunch = async (selected: readonly (typeof registrations)[number][]) => {
    const request = {
      schema_version: "startup_opportunity.dispatch_launch_registration_request.v1",
      request_id: requestId,
      run_id: state.runId,
      dispatch_ref: dispatchRef,
      dispatch_hash: dispatchHash,
      registered_at: "2026-07-31T16:01:02Z",
      registrations: selected,
    };
    const requestHash = canonicalContentHash(request);
    const lifecycleDocuments = selected.map((registration) => {
      const document = {
        schema_version: "startup_opportunity.lane_lifecycle.v1",
        lifecycle_id: "",
        revision: 1,
        parent_lifecycle_ref: null,
        run_id: state.runId,
        unit_id: registration.unit_id,
        attempt: registration.attempt,
        execution_attempt_id: registration.execution_attempt_id,
        dispatch_batch_ref: `${dispatchRef}#${registration.task_id}`,
        dispatch_batch_hash: dispatchHash,
        task_ref: registration.task_ref,
        task_id: registration.task_id,
        launch_registration_ref: registrationRef,
        launch_registration_id: requestId,
        launch_registration_hash: requestHash,
        state: "agent_started",
        timestamps: {
          task_ready_at: "2026-07-31T16:01:00Z",
          dispatch_requested_at: "2026-07-31T16:01:01Z",
          agent_started_at: "2026-07-31T16:01:02Z",
          evidence_recorded_at: null,
          handoff_ready_at: null,
          formalization_validated_at: null,
          published_at: null,
        },
        failure: null,
        limitations: [
          "Caller-declared launch registration; the Harness does not verify that an external Codex task exists.",
        ],
      };
      document.lifecycle_id = canonicalLaneLifecycleId(document);
      return { lifecycleRef: canonicalLaneLifecyclePath(document, 1), document };
    });
    const registrationDocument = {
      schema_version: "startup_opportunity.dispatch_launch_registration.v1",
      registration_id: requestId,
      run_id: state.runId,
      dispatch_ref: dispatchRef,
      dispatch_hash: dispatchHash,
      request_hash: requestHash,
      registered_at: request.registered_at,
      registrations: lifecycleDocuments.map(({ lifecycleRef, document }) => ({
        unit_id: document.unit_id,
        task_ref: document.task_ref,
        task_id: document.task_id,
        attempt: document.attempt,
        execution_attempt_id: document.execution_attempt_id,
        lifecycle_ref: lifecycleRef,
        lifecycle_hash: canonicalContentHash(document),
      })),
      limitations: [
        "Caller-declared launch registration; the Harness does not verify that an external Codex task exists.",
      ],
    };
    return (
      await compiler.compile(
        compilationRequest(
          state.runId,
          "validate_only",
          [
            runtimeArtifact(registrationRef, registrationDocument, "harness"),
            ...lifecycleDocuments.map(({ lifecycleRef, document }) =>
              runtimeArtifact(lifecycleRef, document, "main_agent"),
            ),
          ],
          `validate_intent_${String(selected[0]?.unit_id ?? "empty")}`,
        ),
      )
    ).compiled_envelopes;
  };
  const bundleReceipt = (envelopes: readonly FormalArtifactEnvelope[]) => {
    const sorted = [...envelopes].sort((left, right) =>
      left.artifact_path.localeCompare(right.artifact_path),
    );
    const operation = operationKey("publish_artifact_bundle", {
      run_id: state.runId,
      envelopes: sorted,
    });
    return {
      schema_version: "startup_opportunity.artifact_bundle_operation.current",
      operation_key: operation,
      run_id: state.runId,
      envelopes: sorted,
    };
  };

  const winnerEnvelopes = await compileLaunch([registrations[0] as (typeof registrations)[number]]);
  const loserEnvelopes = await compileLaunch([registrations[1] as (typeof registrations)[number]]);
  const winnerReceipt = bundleReceipt(winnerEnvelopes);
  const operationDirectory = path.join(state.runRoot, ".store", "operations");
  await mkdir(operationDirectory, { recursive: true });
  await writeFile(
    path.join(
      operationDirectory,
      `bundle-${String(winnerReceipt.operation_key).slice("sha256:".length)}.json`,
    ),
    `${canonicalJson(winnerReceipt)}\n`,
  );
  const afterIntentOnly = await snapshotTree(state.runRoot);
  await assert.rejects(
    state.runStore.publishDispatchLaunchRegistration({
      runId: state.runId,
      envelopes: loserEnvelopes,
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "write.bundle_operation_conflict",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), afterIntentOnly);

  const recovered = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.deepEqual(
    recovered.recoveredArtifactPaths,
    winnerEnvelopes.map((envelope) => envelope.artifact_path).sort(),
  );
  const checked = runHarness([
    "check-dispatch-launches",
    "--run-id",
    state.runId,
    "--dispatch-ref",
    dispatchRef,
    "--dispatch-hash",
    dispatchHash,
    "--runs-root",
    state.runsRoot,
  ]);
  assert.equal(checked.status, 0, checked.stderr);
  const checkResult = JSON.parse(checked.stdout) as Record<string, unknown>;
  assert.equal(checkResult.status, "open");
  assert.deepEqual(checkResult.started_unit_ids, [registrations[0]?.unit_id]);
  assert.deepEqual(checkResult.not_started_unit_ids, [registrations[1]?.unit_id]);
  assert.deepEqual(checkResult.unexpected_registrations, []);

  const beforeReplay = await snapshotTree(state.runRoot);
  const replay = await state.runStore.publishDispatchLaunchRegistration({
    runId: state.runId,
    envelopes: winnerEnvelopes,
  });
  assert.equal(replay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(state.runRoot), beforeReplay);
});

test("status derives retries from distinct execution attempts across the complete lifecycle", async (t) => {
  const state = await prepareDiscoveryTaskBridgeRun(t, "status-retries");
  const execution = executionPlan(state.runId, state.plan, "evaluation");
  const batch = dispatchBatch(state.runId, state.plan, execution);
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
      runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
      ...canonicalTaskArtifacts(state.bundle, state.plan, batch),
    ]),
  );
  const unitId = String(planUnits(state.plan)[0]?.unit_id);
  const attempt = (
    ordinal: number,
    stateName: "failed" | "published",
    failureKind?: "validation_failed" | "publication_failed",
  ): Record<string, unknown> => {
    const document = lifecycle(state.runId, unitId, batch, 1, "agent_started");
    document.attempt = ordinal;
    document.execution_attempt_id = `execution_${unitId}_attempt_${ordinal}`;
    document.lifecycle_id = canonicalLaneLifecycleId(document);
    document.state = stateName;
    const timestamps = document.timestamps as Record<string, unknown>;
    if (stateName === "published") {
      timestamps.evidence_recorded_at = "2026-07-31T16:01:03Z";
      timestamps.handoff_ready_at = "2026-07-31T16:01:04Z";
      timestamps.formalization_validated_at = "2026-07-31T16:01:05Z";
      timestamps.published_at = "2026-07-31T16:01:06Z";
      document.failure = null;
    } else {
      document.failure = {
        kind: failureKind,
        detail: `SYNTHETIC ${String(failureKind)} attempt failure.`,
        retryable: true,
      };
    }
    return document;
  };
  const successfulAttempt = attempt(3, "published");
  const successfulRefresh = structuredClone(successfulAttempt);
  successfulRefresh.revision = 2;
  successfulRefresh.parent_lifecycle_ref = canonicalLaneLifecyclePath(successfulRefresh, 1);
  const lifecycleArtifacts = [
    runtimeArtifact(
      canonicalLaneLifecyclePath(attempt(1, "failed", "validation_failed")),
      attempt(1, "failed", "validation_failed"),
      "main_agent",
    ),
    runtimeArtifact(
      canonicalLaneLifecyclePath(attempt(2, "failed", "publication_failed")),
      attempt(2, "failed", "publication_failed"),
      "main_agent",
    ),
    runtimeArtifact(canonicalLaneLifecyclePath(successfulAttempt), successfulAttempt, "main_agent"),
    runtimeArtifact(canonicalLaneLifecyclePath(successfulRefresh), successfulRefresh, "main_agent"),
  ];
  await compiler.compile(compilationRequest(state.runId, "publish", lifecycleArtifacts));

  const status = await state.runStore.status(state.runId);
  const timing = status.observability.laneTimings.find((entry) => entry.unitId === unitId);
  assert.ok(timing);
  assert.equal(timing.state, "published");
  assert.equal(timing.attemptCount, 3);
  assert.equal(timing.retryCount, 2);
  assert.equal(timing.executionAttemptId, `execution_${unitId}_attempt_3`);
  assert.equal(status.observability.validationRetryCount, 1);
  assert.equal(status.observability.publishRetryCount, 1);
  assert.deepEqual(status.observability.failureClassifications, {
    publication_failed: 1,
    validation_failed: 1,
  });
});

test("current dispatch atomically publishes exact canonical Discovery tasks and replay", async (t) => {
  const state = await prepareDiscoveryTaskBridgeRun(t, "canonical");
  const execution = executionPlan(state.runId, state.plan, "evaluation");
  const batch = dispatchBatch(state.runId, state.plan, execution);
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  const beforeIncomplete = await state.runStore.status(state.runId);
  await assert.rejects(
    compiler.compile(
      compilationRequest(
        state.runId,
        "publish",
        [
          runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
          runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
        ],
        "request_incomplete_atomic_wave_synthetic",
      ),
    ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.wave_bundle_incomplete",
  );
  const afterIncomplete = await state.runStore.status(state.runId);
  assert.deepEqual(afterIncomplete.manifest, beforeIncomplete.manifest);
  assert.ok(!afterIncomplete.manifest.artifact_refs.includes("tasks/dispatch/runtime.r1.json"));

  await compiler.compile(
    compilationRequest(
      state.runId,
      "publish",
      [runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent")],
      "request_execution_only_synthetic",
    ),
  );
  await assert.rejects(
    compiler.compile(
      compilationRequest(
        state.runId,
        "publish",
        [
          runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
          ...canonicalTaskArtifacts(state.bundle, state.plan, batch),
        ],
        "request_missing_execution_overlay_synthetic",
      ),
    ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.wave_bundle_incomplete",
  );

  const wavePublication = await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
      runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
      ...canonicalTaskArtifacts(state.bundle, state.plan, batch),
    ]),
  );
  const task = wavePublication.compiled_envelopes.find(
    (envelope) =>
      envelope.artifact_type === "startup_opportunity.research_task.discovery_candidate.current" &&
      envelope.document.unit_id === "unit_seed_independent_demand",
  );
  assert.ok(task);
  const unitId = String(task.document.unit_id);
  const afterPublish = await state.runStore.status(state.runId);
  assert.ok(afterPublish.manifest.active_units.includes(unitId));
  assert.ok(afterPublish.manifest.artifact_refs.includes(task.artifact_path));

  const auditPath = `artifacts/research-audits/${unitId}.json`;
  const lanePath = String(task.document.allowed_output_path);
  const materializer = new LaneResultMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const laneSemantics = incompleteDiscoveryLaneResult(state.runId, task, auditPath);
  for (const field of [
    "schema_version",
    "lane_result_id",
    "run_id",
    "unit_id",
    "attempt",
    "task_ref",
    "lane_type",
    "owner_role",
  ])
    delete laneSemantics[field];
  const auditSemantics = unrankedCommercialDelivery(state.runId, unitId);
  for (const field of ["schema_version", "run_id", "unit_id"]) delete auditSemantics[field];
  const staging = {
    schema_version: "startup_opportunity.lane_staging_document.current",
    staging_id: "staging_commercial_audit_synthetic",
    run_id: state.runId,
    task_ref: task.artifact_path,
    created_at: "2026-07-31T16:03:00Z",
    producer_role: "lane_researcher",
    operation: "validate_only",
    evidence_receipt_refs: [],
    delivery_contract: {
      search_closure: {
        status: "completed",
        acquisition_routes_attempted: ["user_provided"],
        unresolved_gaps: ["No market research was performed by this synthetic fixture."],
        stop_reason: "The deterministic contract fixture has exercised its assigned scope.",
      },
    },
    agent_documents: [
      {
        artifact_family: "lane_result",
        document: laneSemantics,
      },
      {
        artifact_family: "commercial_audit",
        document: auditSemantics,
      },
    ],
  };

  const invalid = structuredClone(staging);
  invalid.agent_documents.shift();
  invalid.agent_documents.push({
    artifact_family: "finding",
    document: { finding_id: "finding_incomplete_delivery" },
  });
  invalid.delivery_contract.search_closure.acquisition_routes_attempted = ["none"];
  const beforeRejectedPreflight = await snapshotTree(state.runRoot);
  await assert.rejects(materializer.materialize(invalid), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, "runtime.lane_preflight_failed");
    const issues = error.details.issues as Record<string, unknown>[];
    assert.ok(issues.length >= 3);
    assert.ok(
      issues.every(
        (issue) =>
          typeof issue.code === "string" &&
          typeof issue.artifact === "string" &&
          typeof issue.path === "string" &&
          "reference" in issue &&
          typeof issue.likely_cause === "string" &&
          typeof issue.mechanically_derivable === "boolean" &&
          Array.isArray(issue.affected_objects),
      ),
    );
    assert.ok(issues.some((issue) => issue.code === "lane_delivery.required_artifact_missing"));
    assert.ok(issues.some((issue) => issue.code === "runtime.compilation_document_invalid"));
    assert.ok(issues.some((issue) => issue.code === "lane_delivery.search_closure_route_missing"));
    assert.ok(Array.isArray(error.details.root_causes));
    return true;
  });
  assert.deepEqual(await snapshotTree(state.runRoot), beforeRejectedPreflight);

  const missingAudit = structuredClone(staging);
  missingAudit.staging_id = "staging_commercial_missing_audit_synthetic";
  missingAudit.agent_documents.pop();
  await assert.rejects(materializer.materialize(missingAudit), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, "runtime.lane_preflight_failed");
    const requiredIssue = (error.details.issues as Record<string, unknown>[]).find(
      (current) =>
        current.code === "lane_delivery.required_artifact_missing" &&
        current.reference === auditPath,
    );
    assert.ok(requiredIssue);
    assert.equal(requiredIssue.mechanically_derivable, true);
    return true;
  });
  assert.deepEqual(await snapshotTree(state.runRoot), beforeRejectedPreflight);

  const forgedAuthority = structuredClone(staging) as typeof staging & {
    delivery_contract: typeof staging.delivery_contract & {
      required_artifacts: readonly unknown[];
      assigned_scope: readonly string[];
    };
  };
  forgedAuthority.staging_id = "staging_commercial_forged_authority_synthetic";
  forgedAuthority.delivery_contract.required_artifacts = [];
  forgedAuthority.delivery_contract.assigned_scope = ["unanswered_scope"];
  await assert.rejects(materializer.materialize(forgedAuthority), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, "runtime.lane_staging_invalid");
    const issues = error.details.issues as Record<string, unknown>[];
    assert.ok(
      issues.filter(
        (current) =>
          current.code === "lane_delivery.schema.additionalProperties" &&
          current.mechanically_derivable === true,
      ).length >= 2,
    );
    return true;
  });
  assert.deepEqual(await snapshotTree(state.runRoot), beforeRejectedPreflight);

  const incompleteCoverage = structuredClone(staging);
  incompleteCoverage.staging_id = "staging_commercial_incomplete_coverage_synthetic";
  incompleteCoverage.operation = "validate_only";
  incompleteCoverage.evidence_receipt_refs = [];
  incompleteCoverage.delivery_contract.search_closure = {
    status: "completed",
    acquisition_routes_attempted: ["public_web"],
    unresolved_gaps: ["Current commercial Evidence remains unavailable."],
    stop_reason: "The bounded query set was exhausted without usable evidence.",
  };
  const incompleteDryRun = await materializer
    .materialize(incompleteCoverage)
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
      }
      throw error;
    });
  assert.equal(incompleteDryRun.status, "accepted");
  assert.equal(incompleteDryRun.compilation.status, "validated");
  assert.equal(
    (incompleteDryRun.delivery_receipt.document.audit as Record<string, unknown>)
      .no_evidence_scope_count,
    2,
  );
  assert.equal(
    (incompleteDryRun.delivery_receipt.document.audit as Record<string, unknown>)
      .partial_scope_count,
    (incompleteDryRun.delivery_receipt.document.assigned_scope as unknown[]).length - 2,
  );
  assert.deepEqual(await snapshotTree(state.runRoot), beforeRejectedPreflight);

  const beforeDeliveryManifest = (await state.runStore.status(state.runId)).manifest;
  const validated = await materializer.materialize(staging).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
    }
    throw error;
  });
  const publication = structuredClone(staging);
  publication.operation = "publish";
  (publication as typeof publication & { publication_plan: unknown }).publication_plan =
    validated.compilation.publication_plan;
  const materialized = await materializer.materialize(publication).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
    }
    throw error;
  });
  assert.equal(materialized.status, "accepted");
  assert.equal(materialized.compilation.status, "published");
  assert.deepEqual(
    materialized.compilation.compiled_envelopes,
    validated.compilation.compiled_envelopes,
  );
  const laneEnvelope = materialized.compilation.compiled_envelopes.find(
    (envelope) => envelope.artifact_path === lanePath,
  );
  assert.ok(laneEnvelope);
  for (const [field, semanticValue] of Object.entries(laneSemantics)) {
    assert.deepEqual(laneEnvelope.document[field], semanticValue, field);
  }
  assert.equal(laneEnvelope.document.lane_result_id, `lane_${unitId}_attempt_1`);
  assert.equal(laneEnvelope.document.task_ref, task.artifact_path);
  const gateDiagnostics = materialized.delivery_receipt.document.gate_diagnostics as Record<
    string,
    unknown
  >;
  const gateIssues = gateDiagnostics.issues as Record<string, unknown>[];
  assert.ok(
    gateIssues.some(
      (issue) =>
        issue.code === "commercial_research.assigned_scope_undisclosed" &&
        issue.severity === "warning" &&
        issue.category === "coverage",
    ),
  );
  const gateStatistics = gateDiagnostics.statistics as Record<string, unknown>[];
  assert.ok(
    gateStatistics.some(
      (statistic) =>
        statistic.validator_code === "commercial_research.assigned_scope_undisclosed" &&
        Number(statistic.trigger_count) > 1 &&
        statistic.repair_rounds === null &&
        statistic.repair_time_ms === null &&
        statistic.changed_evidence_claim_or_disposition === null,
    ),
  );
  const downgradeCandidates = gateDiagnostics.downgrade_candidates as Record<string, unknown>[];
  assert.ok(
    downgradeCandidates.some(
      (candidate) =>
        candidate.validator_code === "commercial_research.assigned_scope_undisclosed" &&
        candidate.candidate_action === "automate" &&
        candidate.integrity_gate_automatically_relaxed === false,
    ),
  );
  const auditEnvelope = materialized.compilation.compiled_envelopes.find(
    (envelope) => envelope.artifact_path === auditPath,
  );
  assert.ok(auditEnvelope);
  assert.deepEqual(auditEnvelope.input_refs, [
    "plans/research-execution.r1.json",
    task.artifact_path,
    `tasks/dispatch/runtime.r1.json#task_${unitId}`,
  ]);
  assert.equal(auditEnvelope.producer_role, "harness");
  assert.equal(
    auditEnvelope.document.schema_version,
    "startup_opportunity.commercial_research_audit.current",
  );
  assert.ok(Array.isArray(auditEnvelope.document.compiler_warnings));
  assert.equal(materialized.delivery_receipt.producer_role, "harness");
  assert.equal(
    materialized.delivery_receipt.document.schema_version,
    "startup_opportunity.lane_delivery_receipt.current",
  );
  assert.equal(
    (materialized.delivery_receipt.document.audit as Record<string, unknown>).status,
    "accepted",
  );
  const deliveryPaths = [auditPath, lanePath, materialized.delivery_receipt.artifact_path].sort();
  const publishedManifest = (await state.runStore.status(state.runId)).manifest;
  assert.ok(
    deliveryPaths.every((artifactPath) => publishedManifest.artifact_refs.includes(artifactPath)),
  );

  const operationsRoot = path.join(state.runRoot, ".store/operations");
  await removePublicationCommitTail(state.runRoot, deliveryPaths);
  const receiptByPath = new Map<string, string>();
  for (const operationEntry of await readdir(operationsRoot)) {
    if (!operationEntry.startsWith("artifact-") || !operationEntry.endsWith(".json")) continue;
    const receipt = JSON.parse(
      await readFile(path.join(operationsRoot, operationEntry), "utf8"),
    ) as Record<string, unknown>;
    if (typeof receipt.artifact_path === "string") {
      receiptByPath.set(receipt.artifact_path, operationEntry);
    }
  }
  for (const artifactPath of deliveryPaths) {
    const receiptName = receiptByPath.get(artifactPath);
    assert.ok(receiptName);
    await rm(path.join(state.runRoot, artifactPath));
    await rm(path.join(operationsRoot, receiptName));
  }
  await writeFile(
    path.join(state.runRoot, "manifest.json"),
    `${canonicalJson(beforeDeliveryManifest)}\n`,
  );

  const reopenedDelivery = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.deepEqual(reopenedDelivery.recoveredArtifactPaths, deliveryPaths);
  assert.ok(
    deliveryPaths.every((artifactPath) =>
      reopenedDelivery.manifest.artifact_refs.includes(artifactPath),
    ),
  );
  const deliveryReplay = await materializer.materialize(publication);
  assert.equal(deliveryReplay.status, "accepted");
  assert.equal(deliveryReplay.compilation.status, "idempotent_replay");
  assert.deepEqual(
    deliveryReplay.delivery_receipt.document.gate_diagnostics,
    materialized.delivery_receipt.document.gate_diagnostics,
  );

  const beforeReplay = await snapshotTree(state.runRoot);
  const replay = await state.runStore.publishArtifact({ runId: state.runId, envelope: task });
  assert.equal(replay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(state.runRoot), beforeReplay);
});

test("commercial Audit semantic input closure is compiler-owned across validation, publication, and recovery", async (t) => {
  const state = await prepareDiscoveryTaskBridgeRun(t, "commercial-input-closure");
  const execution = executionPlan(state.runId, state.plan, "evaluation");
  const batch = dispatchBatch(state.runId, state.plan, execution);
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  const wave = await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
      runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
      ...canonicalTaskArtifacts(state.bundle, state.plan, batch),
    ]),
  );
  const task = wave.compiled_envelopes.find(
    (envelope) =>
      envelope.artifact_type === "startup_opportunity.research_task.discovery_candidate.current" &&
      envelope.document.unit_id === "unit_seed_independent_demand",
  );
  assert.ok(task);
  const unitId = String(task.document.unit_id);
  const semanticEvidenceEnvelope = state.bundle.documents
    .map((entry) => entry.document as unknown as FormalArtifactEnvelope)
    .find(
      (envelope) =>
        envelope.schema_version === "startup_opportunity.artifact_envelope.current" &&
        envelope.artifact_type === "startup_opportunity.evidence.discovery_candidate.current" &&
        envelope.document.unit_id === unitId,
    );
  assert.ok(semanticEvidenceEnvelope);

  const sourceRunId = `${state.runId}-handoff-source`;
  await createConfirmedRun(state.runStore, {
    runId: sourceRunId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic source user"],
      decisionGoal: "provide exact reusable Evidence for a current-contract handoff test",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-31T16:00:30Z",
  });
  const evidence = new EvidenceStore(state.runsRoot);
  const sourceRecord = await evidence.record({
    runId: sourceRunId,
    unitId: "unit_source_material",
    source: {
      kind: "public_url",
      canonical_url: "https://synthetic.invalid/lane-materializer-handoff",
    },
    acquisitionGoal: "Preserve exact synthetic bytes for imported Evidence lineage testing.",
    rawContent: "SYNTHETIC imported Evidence bytes; not a market claim.",
    recordedAt: "2026-07-31T16:00:31Z",
  });
  const sourceEvidenceRef = `evidence/manifest.jsonl#${sourceRecord.record.evidence_id}`;
  const sourceCapture = await evidence.readExactCapture(sourceRunId, sourceEvidenceRef);
  const handoff = await state.runStore.createResearchHandoff({
    runId: state.runId,
    handoffId: "lane_materializer_imported_evidence",
    sourceRunId,
    userAuthorizationAttestation:
      "The fixture caller attests that the user authorized this exact reusable Evidence item.",
    targetPurpose:
      "Reweight exact imported bytes in the target Lane without inheriting prior conclusions.",
    capturedAt: "2026-07-31T16:00:32Z",
    items: [
      {
        itemId: "reusable_lane_evidence",
        sourceArtifactPath: sourceEvidenceRef,
        role: "reusable_evidence",
        expectedSourceByteHash: sha256Bytes(sourceCapture.recordBytes),
        expectedSourceContentHash: canonicalContentHash(sourceCapture.record),
        freshnessDisposition: "current",
        applicabilityDisposition: "applicable",
        revalidationStatus: "not_required",
        targetUnitId: unitId,
      },
    ],
  });
  const substrateRef = handoff.importedEvidenceRefs[0];
  assert.ok(substrateRef);
  await state.runStore.readResearchHandoff({
    runId: state.runId,
    handoffRef: handoff.handoffRef,
    itemIds: ["reusable_lane_evidence"],
    consumedAt: "2026-07-31T16:00:33Z",
  });
  const importedRecord = await evidence.readExactRecord(state.runId, substrateRef);

  const evidenceRef = `evidence/records/${importedRecord.evidence_id}.json`;
  const auditPath = `artifacts/research-audits/${unitId}.json`;
  const semanticEvidence = structuredClone(semanticEvidenceEnvelope.document);
  for (const field of [
    "schema_version",
    "run_id",
    "evidence_id",
    "unit_id",
    "research_goal",
    "task_lineage_goal",
    "mechanical_binding",
  ])
    delete semanticEvidence[field];
  const semanticLaneResult = incompleteDiscoveryLaneResult(state.runId, task, auditPath);
  for (const field of [
    "schema_version",
    "lane_result_id",
    "run_id",
    "unit_id",
    "attempt",
    "task_ref",
    "lane_type",
    "owner_role",
  ])
    delete semanticLaneResult[field];
  const semanticAudit = commercialDeliveryWithSemanticEvidence(state.runId, unitId, evidenceRef);
  for (const field of ["schema_version", "run_id", "unit_id"]) delete semanticAudit[field];
  const staging = {
    schema_version: "startup_opportunity.lane_staging_document.current",
    staging_id: "staging_commercial_semantic_closure_synthetic",
    run_id: state.runId,
    task_ref: task.artifact_path,
    created_at: "2026-07-31T16:03:00Z",
    producer_role: "lane_researcher",
    operation: "validate_only",
    evidence_receipt_refs: [substrateRef],
    delivery_contract: {
      search_closure: {
        status: "completed",
        acquisition_routes_attempted: ["repository_source"],
        unresolved_gaps: ["No market research was performed by this synthetic fixture."],
        stop_reason: "The deterministic typed-reference fixture was complete.",
      },
    },
    agent_documents: [
      {
        artifact_family: "evidence",
        evidence_receipt_ref: substrateRef,
        document: semanticEvidence,
      },
      {
        artifact_family: "lane_result",
        document: semanticLaneResult,
      },
      {
        artifact_family: "commercial_audit",
        document: semanticAudit,
      },
    ],
  };
  const materializer = new LaneResultMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const incomplete = structuredClone(staging);
  incomplete.agent_documents.splice(1, 1);
  const beforeIncomplete = await snapshotTree(state.runRoot);
  await assert.rejects(materializer.materialize(incomplete), (error: unknown) => {
    if (error instanceof StoreError && error.code === "runtime.lane_staging_invalid")
      assert.fail(JSON.stringify(error.details, null, 2));
    return (
      error instanceof StoreError &&
      error.code === "runtime.lane_preflight_failed" &&
      (error.details.issues as Record<string, unknown>[]).some(
        (current) => current.code === "lane_delivery.required_artifact_missing",
      )
    );
  });
  assert.deepEqual(await snapshotTree(state.runRoot), beforeIncomplete);
  assert.ok(
    !(await state.runStore.status(state.runId)).manifest.artifact_refs.includes(evidenceRef),
  );

  const missingTypedEvidence = structuredClone(staging);
  missingTypedEvidence.staging_id = "staging_commercial_missing_typed_evidence_synthetic";
  missingTypedEvidence.agent_documents.shift();
  const beforeMissingTypedEvidence = await snapshotTree(state.runRoot);
  await assert.rejects(materializer.materialize(missingTypedEvidence), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, "runtime.lane_preflight_failed");
    const typedIssue = (error.details.issues as Record<string, unknown>[]).find(
      (current) => current.code === "lane_delivery.typed_evidence_missing",
    );
    assert.ok(typedIssue);
    assert.equal(typedIssue.reference, substrateRef);
    assert.equal(typedIssue.mechanically_derivable, false);
    return true;
  });
  assert.deepEqual(await snapshotTree(state.runRoot), beforeMissingTypedEvidence);
  assert.ok(
    !(await state.runStore.status(state.runId)).manifest.artifact_refs.includes(evidenceRef),
  );

  const validated = await materializer.materialize(staging).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
    }
    throw error;
  });
  const previewEvidenceEnvelope = validated.compilation.compiled_envelopes.find(
    (envelope) => envelope.artifact_path === evidenceRef,
  );
  assert.ok(previewEvidenceEnvelope);
  assert.ok(previewEvidenceEnvelope.input_refs.includes(handoff.handoffRef));

  const omittedHandoffRef = {
    ...runtimeArtifact(evidenceRef, previewEvidenceEnvelope.document, "lane_researcher"),
    input_refs: previewEvidenceEnvelope.input_refs.filter((ref) => ref !== handoff.handoffRef),
  };
  await assert.rejects(
    new DeclarativeRuntimeCompiler(state.runsRoot, state.validator, repositoryRoot).compile(
      compilationRequest(
        state.runId,
        "validate_only",
        [omittedHandoffRef],
        "request_imported_evidence_without_handoff_lineage",
      ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.code, "runtime.compilation_validation_failed");
      const issues = error.details.issues as Record<string, unknown>[];
      assert.ok(issues.some((issue) => issue.code === "research_handoff.evidence_orphaned"));
      return true;
    },
  );
  const publish = structuredClone(staging);
  publish.operation = "publish";
  (publish as typeof publish & { publication_plan: unknown }).publication_plan =
    validated.compilation.publication_plan;
  const materialized = await materializer.materialize(publish);
  assert.equal(materialized.compilation.status, "published");
  const auditEnvelope = materialized.compilation.compiled_envelopes.find(
    (envelope) => envelope.artifact_path === auditPath,
  );
  assert.ok(auditEnvelope);
  const typedEvidenceEnvelope = materialized.compilation.compiled_envelopes.find(
    (envelope) => envelope.artifact_path === evidenceRef,
  );
  assert.ok(typedEvidenceEnvelope);
  assert.ok(typedEvidenceEnvelope.input_refs.includes(handoff.handoffRef));
  assert.equal(typedEvidenceEnvelope.document.evidence_lifecycle_status, "unverified");
  assert.equal(typedEvidenceEnvelope.document.research_goal, importedRecord.acquisition_goal);
  assert.equal(typedEvidenceEnvelope.document.task_lineage_goal, task.document.research_goal);
  assert.equal(
    (typedEvidenceEnvelope.document.mechanical_binding as Record<string, unknown>)
      .substrate_record_ref,
    substrateRef,
  );
  for (const [field, value] of Object.entries(semanticEvidence)) {
    assert.deepEqual(typedEvidenceEnvelope.document[field], value);
  }
  const expectedInputRefs = [
    evidenceRef,
    "plans/research-execution.r1.json",
    task.artifact_path,
    `tasks/dispatch/runtime.r1.json#task_${unitId}`,
  ].sort();
  assert.deepEqual(auditEnvelope.input_refs, expectedInputRefs);
  for (const field of ["findings", "claims", "judgments"] as const) {
    const statement: Record<string, unknown> | undefined = (
      auditEnvelope.document[field] as Record<string, unknown>[]
    )[0];
    assert.ok(statement);
    assert.deepEqual(statement.evidence_refs, [evidenceRef]);
  }

  const currentContext = await state.runStore.buildValidationContext(
    state.runId,
    {
      schema_version: "startup_opportunity.document_bundle.current",
      documents: [{ path: auditPath, document: auditEnvelope }],
      exact_records: [],
    },
    { includeAllFormalArtifacts: true },
  );
  const currentValidation = state.validator.validateDocumentBundle(
    currentContext.bundle,
    currentContext.referenceContext,
  );
  assert.equal(currentValidation.valid, true);

  const validateWithInputRefs = (inputRefs: readonly string[]) => {
    const bundle = structuredClone(currentContext.bundle);
    const auditEntry = bundle.documents.find((entry) => entry.path === auditPath);
    assert.ok(auditEntry);
    const envelope = auditEntry.document as unknown as FormalArtifactEnvelope;
    (envelope as unknown as { input_refs: readonly string[] }).input_refs = inputRefs;
    return state.validator.validateDocumentBundle(bundle, currentContext.referenceContext);
  };
  for (const inputRefs of [
    expectedInputRefs.filter((ref) => ref !== evidenceRef),
    [...expectedInputRefs, G21_SCOPE_REF].sort(),
  ]) {
    const validation = validateWithInputRefs(inputRefs);
    assert.equal(validation.valid, false);
    const closureIssue = validation.referenceErrors.find(
      (issue) => issue.code === "reference.commercial_audit_input_closure_mismatch",
    );
    assert.ok(closureIssue);
    assert.deepEqual(closureIssue.details.expectedInputRefs, expectedInputRefs);
    assert.deepEqual(closureIssue.details.actualInputRefs, inputRefs);
  }

  const missingEvidenceRefEnvelope = structuredClone(auditEnvelope);
  (
    missingEvidenceRefEnvelope as unknown as {
      artifact_path: string;
      input_refs: readonly string[];
    }
  ).artifact_path = `artifacts/research-audits/${unitId}-publication-drift.json`;
  (
    missingEvidenceRefEnvelope as unknown as {
      artifact_path: string;
      input_refs: readonly string[];
    }
  ).input_refs = expectedInputRefs.filter((ref) => ref !== evidenceRef);
  await assert.rejects(
    new ArtifactStore(state.runsRoot, state.validator).publish({
      runId: state.runId,
      envelope: missingEvidenceRefEnvelope,
    }),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.code, "artifact.reference_invalid");
      const issues = error.details.referenceErrors as Record<string, unknown>[];
      assert.ok(
        issues.some((issue) => issue.code === "reference.commercial_audit_input_closure_mismatch"),
      );
      return true;
    },
  );

  const storedEnvelope = JSON.parse(
    await readFile(path.join(state.runRoot, auditPath), "utf8"),
  ) as FormalArtifactEnvelope;
  (storedEnvelope as unknown as { input_refs: readonly string[] }).input_refs =
    expectedInputRefs.filter((ref) => ref !== evidenceRef);
  await writeFile(path.join(state.runRoot, auditPath), `${canonicalJson(storedEnvelope)}\n`);
  const operationsRoot = path.join(state.runRoot, ".store/operations");
  for (const entry of await readdir(operationsRoot)) {
    if (!entry.endsWith(".json")) continue;
    const operationPath = path.join(operationsRoot, entry);
    const operation = JSON.parse(await readFile(operationPath, "utf8")) as Record<string, unknown>;
    const publishesAudit =
      operation.artifact_path === auditPath ||
      (Array.isArray(operation.envelopes) &&
        operation.envelopes.some(
          (envelope) =>
            typeof envelope === "object" &&
            envelope !== null &&
            "artifact_path" in envelope &&
            envelope.artifact_path === auditPath,
        ));
    if (!publishesAudit) continue;
    if (operation.artifact_path === auditPath) {
      operation.envelope = storedEnvelope;
      await writeFile(operationPath, `${canonicalJson(operation)}\n`);
      continue;
    }
    await rm(operationPath);
  }
  await assert.rejects(
    new RunStore(state.runsRoot, state.validator).load(state.runId),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.code, "recovery.reference_invalid");
      const codes = error.details.referenceErrorCodes as string[];
      assert.ok(codes.includes("reference.commercial_audit_input_closure_mismatch"));
      return true;
    },
  );
});

test("whole-wave intent restores every Dispatch and canonical task before Manifest recovery", async (t) => {
  const state = await prepareDiscoveryTaskBridgeRun(t, "whole-wave-recovery");
  const execution = executionPlan(state.runId, state.plan, "evaluation");
  const batch = dispatchBatch(state.runId, state.plan, execution);
  const beforeWave = await state.runStore.status(state.runId);
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  const published = await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
      runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
      ...canonicalTaskArtifacts(state.bundle, state.plan, batch),
    ]),
  );
  const wavePaths = published.compiled_envelopes.map((envelope) => envelope.artifact_path).sort();
  const operationsRoot = path.join(state.runRoot, ".store/operations");
  await removePublicationCommitTail(state.runRoot, wavePaths);
  const operationEntries = await readdir(operationsRoot);
  const receiptByPath = new Map<string, string>();
  for (const entry of operationEntries) {
    if (!entry.startsWith("artifact-") || !entry.endsWith(".json")) continue;
    const receipt = JSON.parse(await readFile(path.join(operationsRoot, entry), "utf8")) as Record<
      string,
      unknown
    >;
    if (typeof receipt.artifact_path === "string") {
      receiptByPath.set(receipt.artifact_path, entry);
    }
  }
  for (const artifactPath of wavePaths) {
    const receiptName = receiptByPath.get(artifactPath);
    assert.ok(receiptName);
    await rm(path.join(state.runRoot, artifactPath));
    await rm(path.join(operationsRoot, receiptName));
  }
  await writeFile(
    path.join(state.runRoot, "manifest.json"),
    `${canonicalJson(beforeWave.manifest)}\n`,
  );

  const reopened = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.deepEqual(reopened.recoveredArtifactPaths, wavePaths);
  for (const artifactPath of wavePaths) {
    assert.ok(reopened.manifest.artifact_refs.includes(artifactPath));
  }
  assert.deepEqual(
    reopened.manifest.active_units,
    planUnits(state.plan)
      .map((unit) => String(unit.unit_id))
      .sort(),
  );
});

test("canonical Discovery task publication rejects missing waves, drift, and terminal units", async (t) => {
  const undispatched = await prepareDiscoveryTaskBridgeRun(t, "undispatched");
  const firstTask = canonicalDiscoveryTask(undispatched.bundle, undispatched.plan);
  const beforeUndispatched = await snapshotTree(undispatched.runRoot);
  await assert.rejects(
    undispatched.runStore.publishArtifact({
      runId: undispatched.runId,
      envelope: firstTask,
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.wave_bundle_required",
  );
  await assert.rejects(
    undispatched.runStore.publishArtifactBundle({
      runId: undispatched.runId,
      envelopes: [
        firstTask,
        canonicalDiscoveryTask(undispatched.bundle, undispatched.plan, G22_EVALUATION_TASK),
      ],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.wave_bundle_incomplete",
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
      ...canonicalTaskArtifacts(drift.bundle, drift.plan, batch),
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
        error instanceof StoreError && error.code === "artifact.wave_bundle_required",
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
        error instanceof StoreError && error.code === "artifact.wave_bundle_required",
    );
    assert.deepEqual(await snapshotTree(terminal.runRoot), before);
  }
});

test("candidate-neutral Evidence binds real substrate and generation completion wins recovery ordering", async (t) => {
  const state = await prepareDiscoveryTaskBridgeRun(t, "generation");
  const execution = executionPlan(state.runId, state.plan);
  const batch = dispatchBatch(state.runId, state.plan, execution);
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
      runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
      ...canonicalTaskArtifacts(state.bundle, state.plan, batch),
    ]),
  );
  const firstTask = (batch.tasks as Record<string, unknown>[])[0];
  assert.ok(firstTask);
  const unitId = String(firstTask.unit_id);
  const taskResearchGoal = String(firstTask.research_goal);
  const evidenceStore = new EvidenceStore(state.runsRoot);
  const substrateInputs = Array.from({ length: 17 }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    return {
      runId: state.runId,
      unitId,
      unitAttempt: 1,
      acquisitionGoal: `SYNTHETIC source-level acquisition goal ${ordinal}; not the broad Task goal.`,
      source: {
        kind: "user_provided" as const,
        canonical_uri: `urn:startup-opportunity:user-provided:${state.runId}-source-${ordinal}`,
      },
      rawContent: `SYNTHETIC distinct raw bytes ${ordinal}; not market Evidence.`,
      recordedAt: `2026-07-31T16:02:${ordinal}Z`,
    };
  });
  const substrates = [];
  for (const input of substrateInputs) {
    substrates.push(await evidenceStore.record(input));
  }
  assert.deepEqual(
    substrates.map((substrate) => substrate.status),
    Array.from({ length: 17 }, () => "recorded"),
  );
  for (const input of substrateInputs) {
    assert.equal((await evidenceStore.record(input)).status, "idempotent_replay");
  }
  assert.ok(
    substrates.every((substrate) => substrate.record.acquisition_goal !== taskResearchGoal),
  );
  const reproducedRecords = (await evidenceStore.listRecords(state.runId)).filter(
    (record) =>
      record.unit_id === unitId &&
      record.acquisition_goal.startsWith("SYNTHETIC source-level acquisition goal "),
  );
  assert.deepEqual(
    {
      record_count: reproducedRecords.length,
      unique_source_count: new Set(reproducedRecords.map((record) => record.source_hash)).size,
      unique_raw_count: new Set(reproducedRecords.map((record) => record.content_hash)).size,
      unique_source_raw_count: new Set(
        reproducedRecords.map((record) => `${record.source_hash}\u0000${record.content_hash}`),
      ).size,
    },
    {
      record_count: 17,
      unique_source_count: 17,
      unique_raw_count: 17,
      unique_source_raw_count: 17,
    },
  );
  assert.equal((await evidenceStore.statistics(state.runId)).record_count, 19);
  const formalEvidenceFor = (
    record: EvidenceStoreRecord,
    index: number,
  ): Record<string, unknown> => ({
    schema_version: "startup_opportunity.candidate_neutral_evidence.v1",
    evidence_id: record.evidence_id,
    run_id: state.runId,
    unit_id: unitId,
    dispatch_batch_ref: `tasks/dispatch/runtime.r1.json#${String(firstTask.task_id)}`,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    source_type: "synthetic_contract_fixture",
    source_name: "SYNTHETIC fixture source; not Evidence.",
    research_goal: record.acquisition_goal,
    task_lineage_goal: taskResearchGoal,
    source_group_id: `source_group_synthetic_${String(index + 1).padStart(2, "0")}`,
    mechanical_binding: {
      substrate_record_ref: `evidence/manifest.jsonl#${record.evidence_id}`,
      source_hash: record.source_hash,
      content_hash: record.content_hash,
      raw_content_ref: record.raw_content_ref,
      operation_key: record.operation_key,
      recorded_at: record.recorded_at,
    },
    evidence_tier: "model_inference_only",
    evidence_lifecycle_status: "unverified",
    evidence_role: "context",
    representativeness: "SYNTHETIC contract fixture only.",
    valid_as_of: "2026-07-31",
    target_candidate_refs: [],
    solution_refs: [],
    limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
  });
  const evidenceArtifacts = substrates.map((substrate, index) => ({
    path: `evidence/discovery/generation/${substrate.record.evidence_id}.json`,
    document: formalEvidenceFor(substrate.record, index),
  }));
  const firstEvidenceArtifact = evidenceArtifacts[0];
  assert.ok(firstEvidenceArtifact);
  const evidence = firstEvidenceArtifact.document;
  const evidencePaths = evidenceArtifacts.map((artifact) => artifact.path);
  const sourceManifestPath = `evidence/source-manifests/discovery/${unitId}.json`;
  const sourceManifest = {
    schema_version: "startup_opportunity.source_manifest.discovery_runtime.current",
    manifest_id: "source_manifest_synthetic",
    run_id: state.runId,
    unit_id: unitId,
    research_plan_ref: G21_PLAN_REF,
    execution_plan_ref: "plans/research-execution.r1.json",
    dispatch_batch_ref: `tasks/dispatch/runtime.r1.json#${String(firstTask.task_id)}`,
    research_phase_role: "candidate_generation",
    accepted_evidence_refs: evidencePaths,
    canonical_source_groups: evidenceArtifacts.map((artifact) => ({
      group_id: String(artifact.document.source_group_id),
      evidence_refs: [artifact.path],
    })),
    shared_dataset_groups: [],
    duplicate_or_syndication_groups: [],
    source_type_coverage: ["synthetic_contract_fixture"],
    geo_language_coverage: ["synthetic"],
    time_coverage: {
      earliest_valid_as_of: "2026-07-31",
      latest_valid_as_of: "2026-07-31",
      accepted_evidence_count: evidencePaths.length,
    },
    stance_coverage: ["context"],
    known_source_blind_spots: ["No real source was used."],
    freshness_summary: { active: 0, stale: 0, unverified: evidencePaths.length, superseded: 0 },
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
    evidence_refs: evidencePaths,
    judgment_assessment_refs: [],
    candidate_proposals: [],
    target_candidate_refs: [],
    solution_refs: [],
    open_questions: ["SYNTHETIC fixture leaves every research question open."],
    limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
  };

  const tampered = structuredClone(evidence);
  (tampered.mechanical_binding as Record<string, unknown>).content_hash = `sha256:${"0".repeat(
    64,
  )}`;
  await assert.rejects(
    compiler.compile(
      compilationRequest(state.runId, "validate_only", [
        runtimeArtifact("evidence/discovery/generation/tampered.json", tampered, "lane_researcher"),
      ]),
    ),
    (error: unknown) =>
      compilerCodes(error).includes("runtime.candidate_neutral_substrate_mismatch"),
  );
  const missingSubstrate = structuredClone(evidence);
  (missingSubstrate.mechanical_binding as Record<string, unknown>).substrate_record_ref =
    `evidence/manifest.jsonl#ev_${"0".repeat(64)}`;
  await assert.rejects(
    compiler.compile(
      compilationRequest(state.runId, "validate_only", [
        runtimeArtifact(
          "evidence/discovery/generation/missing-substrate.json",
          missingSubstrate,
          "lane_researcher",
        ),
      ]),
    ),
    (error: unknown) => error instanceof StoreError && error.code === "reference.missing",
  );
  const forgedLineage = structuredClone(evidence);
  forgedLineage.task_lineage_goal = "SYNTHETIC forged Task lineage goal.";
  await assert.rejects(
    compiler.compile(
      compilationRequest(state.runId, "validate_only", [
        runtimeArtifact(
          "evidence/discovery/generation/forged-lineage.json",
          forgedLineage,
          "lane_researcher",
        ),
      ]),
    ),
    (error: unknown) =>
      compilerCodes(error).includes("runtime.candidate_neutral_evidence_binding_mismatch"),
  );
  const wrongRun = structuredClone(evidence);
  wrongRun.run_id = "other-run";
  await assert.rejects(
    compiler.compile(
      compilationRequest(state.runId, "validate_only", [
        runtimeArtifact(firstEvidenceArtifact.path, wrongRun, "lane_researcher"),
      ]),
    ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "runtime.compilation_preflight_failed",
  );
  const staleSummary = structuredClone(sourceManifest);
  staleSummary.freshness_summary = { active: 1, stale: 0, unverified: 0, superseded: 0 };
  await assert.rejects(
    compiler.compile(
      compilationRequest(state.runId, "validate_only", [
        ...evidenceArtifacts.map((artifact) =>
          runtimeArtifact(artifact.path, artifact.document, "lane_researcher"),
        ),
        runtimeArtifact(sourceManifestPath, staleSummary, "lane_researcher"),
      ]),
    ),
    (error: unknown) => compilerCodes(error).includes("runtime.source_manifest_summary_mismatch"),
  );

  const publishedGeneration = await compiler
    .compile(
      compilationRequest(state.runId, "publish", [
        ...evidenceArtifacts.map((artifact) =>
          runtimeArtifact(artifact.path, artifact.document, "lane_researcher"),
        ),
        runtimeArtifact(sourceManifestPath, sourceManifest, "lane_researcher"),
        runtimeArtifact(generationPath, generation, "lane_researcher"),
      ]),
    )
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
      }
      throw error;
    });
  assert.equal(
    publishedGeneration.compiled_envelopes.filter(
      (envelope) => envelope.artifact_type === "startup_opportunity.candidate_neutral_evidence.v1",
    ).length,
    17,
  );
  const recordsAfterFormalization = await evidenceStore.listRecords(state.runId);
  const reproducedRecordsAfterFormalization = recordsAfterFormalization.filter(
    (record) =>
      record.unit_id === unitId &&
      record.acquisition_goal.startsWith("SYNTHETIC source-level acquisition goal "),
  );
  assert.deepEqual(
    {
      record_count: reproducedRecordsAfterFormalization.length,
      unique_source_count: new Set(
        reproducedRecordsAfterFormalization.map((record) => record.source_hash),
      ).size,
      unique_raw_count: new Set(
        reproducedRecordsAfterFormalization.map((record) => record.content_hash),
      ).size,
      unique_source_raw_count: new Set(
        reproducedRecordsAfterFormalization.map(
          (record) => `${record.source_hash}\u0000${record.content_hash}`,
        ),
      ).size,
    },
    {
      record_count: 17,
      unique_source_count: 17,
      unique_raw_count: 17,
      unique_source_raw_count: 17,
    },
  );
  assert.equal(
    recordsAfterFormalization.filter((record) => record.acquisition_goal === taskResearchGoal)
      .length,
    0,
  );
  assert.equal((await evidenceStore.statistics(state.runId)).record_count, 19);
  const manifest = (await state.runStore.status(state.runId)).manifest;
  assert.ok(manifest.completed_units.includes(unitId));
  assert.ok(!manifest.active_units.includes(unitId));
});

test("candidate-neutral Evidence rejects wrong-unit and cross-attempt substrate reuse", async (t) => {
  const state = await prepareDiscoveryTaskBridgeRun(t, "generation-lineage-negative");
  const execution = executionPlan(state.runId, state.plan);
  const batch = dispatchBatch(state.runId, state.plan, execution);
  const compiler = new DeclarativeRuntimeCompiler(state.runsRoot, state.validator);
  await compiler.compile(
    compilationRequest(state.runId, "publish", [
      runtimeArtifact("plans/research-execution.r1.json", execution, "main_agent"),
      runtimeArtifact("tasks/dispatch/runtime.r1.json", batch, "harness"),
      ...canonicalTaskArtifacts(state.bundle, state.plan, batch),
    ]),
  );
  const firstTask = (batch.tasks as Record<string, unknown>[])[0];
  assert.ok(firstTask);
  const unitId = String(firstTask.unit_id);
  const taskResearchGoal = String(firstTask.research_goal);
  const evidenceStore = new EvidenceStore(state.runsRoot);
  const formalEvidenceFor = (record: EvidenceStoreRecord): Record<string, unknown> => ({
    schema_version: "startup_opportunity.candidate_neutral_evidence.v1",
    evidence_id: record.evidence_id,
    run_id: state.runId,
    unit_id: unitId,
    dispatch_batch_ref: `tasks/dispatch/runtime.r1.json#${String(firstTask.task_id)}`,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    source_type: "synthetic_contract_fixture",
    source_name: "SYNTHETIC lineage boundary fixture; not Evidence.",
    research_goal: record.acquisition_goal,
    task_lineage_goal: taskResearchGoal,
    source_group_id: `source_group_${record.evidence_id.slice(0, 12)}`,
    mechanical_binding: {
      substrate_record_ref: `evidence/manifest.jsonl#${record.evidence_id}`,
      source_hash: record.source_hash,
      content_hash: record.content_hash,
      raw_content_ref: record.raw_content_ref,
      operation_key: record.operation_key,
      recorded_at: record.recorded_at,
    },
    evidence_tier: "model_inference_only",
    evidence_lifecycle_status: "unverified",
    evidence_role: "context",
    representativeness: "SYNTHETIC contract fixture only.",
    valid_as_of: "2026-07-31",
    target_candidate_refs: [],
    solution_refs: [],
    limitations: ["SYNTHETIC_ONLY_NOT_EVIDENCE"],
  });
  const wrongUnit = await evidenceStore.record({
    runId: state.runId,
    unitId: "unit_wrong_lineage_synthetic",
    unitAttempt: 1,
    acquisitionGoal: "SYNTHETIC wrong-unit acquisition goal; not Evidence.",
    source: {
      kind: "user_provided",
      canonical_uri: `urn:startup-opportunity:user-provided:${state.runId}-wrong-unit`,
    },
    rawContent: "SYNTHETIC wrong-unit bytes; not Evidence.",
    recordedAt: "2026-07-31T16:02:20Z",
  });
  const crossAttempt = await evidenceStore.record({
    runId: state.runId,
    unitId,
    unitAttempt: 2,
    acquisitionGoal: "SYNTHETIC cross-attempt acquisition goal; not Evidence.",
    source: {
      kind: "user_provided",
      canonical_uri: `urn:startup-opportunity:user-provided:${state.runId}-cross-attempt`,
    },
    rawContent: "SYNTHETIC cross-attempt bytes; not Evidence.",
    recordedAt: "2026-07-31T16:02:21Z",
  });
  for (const record of [wrongUnit.record, crossAttempt.record]) {
    await assert.rejects(
      compiler.compile(
        compilationRequest(state.runId, "validate_only", [
          runtimeArtifact(
            `evidence/discovery/generation/${record.evidence_id}.json`,
            formalEvidenceFor(record),
            "lane_researcher",
          ),
        ]),
      ),
      (error: unknown) =>
        compilerCodes(error).includes("runtime.candidate_neutral_substrate_mismatch"),
    );
  }
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
    pre_candidate_roles: [],
    required_candidate_kinds: missingKinds,
    missing_candidate_kinds: missingKinds,
    question_coverage: questions,
    commercial_signal_gate: {
      demand_signal: true,
      buyer_signal: false,
      purchase_signal: false,
      decision: "continue_research",
    },
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

  const answeredWithoutJudgment = structuredClone(readiness);
  const answeredCoverage = answeredWithoutJudgment.question_coverage as Record<string, unknown>[];
  assert.ok(answeredCoverage[0]);
  answeredCoverage[0].status = "answered";
  answeredCoverage[0].judgment_refs = [];
  const answeredCodes = validateDeclarativeRuntimeContract([
    planEntry,
    executionEntry,
    { ...readinessEntry, document: answeredWithoutJudgment },
  ]).map((issue) => issue.code);
  assert.ok(answeredCodes.includes("runtime.readiness_question_judgment_missing"));

  const runtimeQuestionWithoutRuntimeBlocker = structuredClone(readiness);
  const runtimeQuestionCoverage = runtimeQuestionWithoutRuntimeBlocker.question_coverage as Record<
    string,
    unknown
  >[];
  assert.ok(runtimeQuestionCoverage[0]);
  runtimeQuestionCoverage[0].status = "runtime_blocked";
  const runtimeQuestionCodes = validateDeclarativeRuntimeContract([
    planEntry,
    executionEntry,
    { ...readinessEntry, document: runtimeQuestionWithoutRuntimeBlocker },
  ]).map((issue) => issue.code);
  assert.ok(runtimeQuestionCodes.includes("runtime.readiness_question_blocker_mismatch"));

  const methodQuestionWithoutMethodBlocker = structuredClone(readiness);
  const methodQuestionCoverage = methodQuestionWithoutMethodBlocker.question_coverage as Record<
    string,
    unknown
  >[];
  assert.ok(methodQuestionCoverage[0]);
  methodQuestionCoverage[0].status = "method_boundary";
  const methodQuestionCodes = validateDeclarativeRuntimeContract([
    planEntry,
    executionEntry,
    { ...readinessEntry, document: methodQuestionWithoutMethodBlocker },
  ]).map((issue) => issue.code);
  assert.ok(methodQuestionCodes.includes("runtime.readiness_question_blocker_mismatch"));

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
    schema_version: "startup_opportunity.gap_snapshot.discovery.readiness.current",
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

  const blockedRuntimeReadiness = structuredClone(readiness);
  for (const coverage of blockedRuntimeReadiness.question_coverage as Record<string, unknown>[]) {
    coverage.status = "runtime_blocked";
  }
  (blockedRuntimeReadiness.blockers as Record<string, unknown>[]).push({
    blocker_id: "blocker_runtime_blocked_synthetic",
    blocker_kind: "runtime_blocked",
    candidate_kind: null,
    basis_refs: [],
    allowed_actions: ["record_runtime_failure"],
    detail: "SYNTHETIC runtime failure remains distinct from research insufficiency.",
  });
  blockedRuntimeReadiness.allowed_next_actions = [
    "add_unit",
    "run_solution_generation",
    "record_runtime_failure",
  ];
  const blockedRuntimeGap = structuredClone(gap);
  blockedRuntimeGap.gaps.push({
    gap_id: "gap_runtime_blocked_synthetic",
    subject_ref: G21_SCOPE_REF,
    gap_type: "runtime_blocked",
    detection_mode: "deterministic",
    decision_impact: ["execution_validity", "next_action"],
    severity: "blocking",
    basis_refs: [readinessPath],
    evidence_refs: [],
    recommended_unit_types: [],
    allowed_actions: ["record_runtime_failure"],
    detail: "SYNTHETIC runtime failure remains explicit in the readiness Gap.",
  });
  (blockedRuntimeGap as Record<string, unknown>).stop_signals = ["runtime_blocked"];
  const blockedRuntimeDocuments = [
    planEntry,
    executionEntry,
    { ...readinessEntry, document: blockedRuntimeReadiness },
    { ...gapEntry, document: blockedRuntimeGap },
  ];
  const blockedRuntimeCodes = validateDeclarativeRuntimeContract(blockedRuntimeDocuments).map(
    (issue) => issue.code,
  );
  assert.ok(!blockedRuntimeCodes.includes("runtime.readiness_question_blocker_mismatch"));
  assert.ok(!blockedRuntimeCodes.includes("runtime.gap_blocker_missing"));
  assert.ok(!blockedRuntimeCodes.includes("runtime.gap_runtime_blocker_unprojected"));

  const runtimeGapWithoutStopSignal = structuredClone(blockedRuntimeGap) as Record<string, unknown>;
  runtimeGapWithoutStopSignal.stop_signals = [];
  const runtimeGapWithoutStopCodes = validateDeclarativeRuntimeContract([
    planEntry,
    executionEntry,
    { ...readinessEntry, document: blockedRuntimeReadiness },
    { ...gapEntry, document: runtimeGapWithoutStopSignal },
  ]).map((issue) => issue.code);
  assert.ok(runtimeGapWithoutStopCodes.includes("runtime.gap_runtime_blocker_unprojected"));
});

test("all direct Store writes fail closed after continuation while the child remains writable", async (t) => {
  const state = await prepareRun(t, "continuation-parent");
  const childRunId = "p1-continuation-child-synthetic";
  await createConfirmedRun(state.runStore, {
    runId: childRunId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
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
      acquisitionGoal: "SYNTHETIC parent write must be rejected.",
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
    acquisitionGoal: "SYNTHETIC child write remains permitted.",
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
      acquisitionGoal: "SYNTHETIC pending guard.",
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
  await createConfirmedRun(corrupt.runStore, {
    runId: corruptChildId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
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
  await createConfirmedRun(multiple.runStore, {
    runId: firstChildId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
    parentRunId: multiple.runId,
    createdAt: "2026-07-31T16:22:00Z",
  });
  await createConfirmedRun(multiple.runStore, {
    runId: secondChildId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
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

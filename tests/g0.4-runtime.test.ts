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
  coverageKey,
  createAdaptationPolicyValidator,
  createArtifactValidator,
  createGapAnalyzer,
  createPlanRevisionRuntime,
  createPlanSemanticValidator,
  type DocumentBundle,
  type FormalArtifactEnvelope,
  planningRunStateHash,
  RunStore,
  StoreError,
  transformPlan,
} from "../harness/src/index.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const PLAN_REF = "plans/research-plan.r1.json";
const CONTEXT_REF = "plans/planning-context.r1.json";
const GAP_REF = "adaptations/gap-snapshots/gap-runtime.r1.json";
const DECISION_REF = "adaptations/decisions/adapt-retry-runtime.json";
const SUBJECT_REF = "subject_001";

function runScript(script: string, args: readonly string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function unit(
  unitId: string,
  unitType: string,
  outputPath: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    unit_id: unitId,
    unit_type: unitType,
    plan_disposition: "enabled",
    priority_band: "normal",
    attempt: 1,
    supersedes_unit_ref: null,
    research_goal: `Research ${unitId} for the explicit subject.`,
    input_refs: [SUBJECT_REF],
    depends_on: [],
    agent_role: "lane-researcher",
    output_path: outputPath,
    required_artifact_schema: "startup_opportunity.enrichment_branch_result.v1",
    source_preferences: [],
    required_outputs: ["closed_result"],
    stop_conditions: [],
    ...overrides,
  };
}

function basePlan(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.research_plan.v1",
    plan_id: `plan_${runId.replaceAll("-", "_")}`,
    run_id: runId,
    mode: "opportunity_discovery",
    revision: 1,
    parent_plan_ref: null,
    triggered_by_adaptation_refs: [],
    created_at: "2026-07-24T12:01:00Z",
    research_questions: [
      {
        question_id: "rq_runtime_001",
        question: "Which mechanical gap still affects the next decision?",
        decision_impact: "May change execution validity.",
        uncertainty: "high",
        expected_information_gain: "high",
        stop_condition: "The explicit machine check is resolved.",
      },
    ],
    candidate_retention_policy: {
      minimum_evidence_requirement: "One referenced formal result.",
      candidate_retention_threshold: "Retain until explicit pre-kill.",
      candidate_diversity_policy: ["Retain one counterfactual subject."],
      counterfactual_candidate_requirement: true,
    },
    exploration_policy: {
      require_seed_independent_demand_unit: true,
      require_counterfactual_unit: true,
      initial_hypotheses_are_questions_not_truth: true,
      separate_generation_and_evaluation_sources: true,
      freeze_thesis_before_enrichment: true,
      require_independent_challenger_queries: true,
    },
    waves: [
      {
        wave_id: "wave_runtime_1",
        depends_on: [],
        units: [
          unit("counter_completed", "counter_evidence", "artifacts/lanes/counter-completed.json"),
          unit("acquisition_failed", "acquisition", "artifacts/lanes/acquisition-failed.json"),
        ],
      },
      {
        wave_id: "wave_runtime_2",
        depends_on: ["wave_runtime_1"],
        units: [
          unit("buyer_active", "buyer_language", "artifacts/lanes/buyer-active.json", {
            depends_on: ["counter_completed"],
          }),
          unit("value_pending", "value_layer", "artifacts/lanes/value-pending.json", {
            depends_on: ["counter_completed"],
          }),
        ],
      },
    ],
    adaptation_policy_ref: "harness/policies/adaptation.v1.json",
    followup_policy: {
      max_followup_rounds: 2,
      require_decision_relevance: true,
      stop_when_no_material_new_evidence: true,
    },
  };
}

function manifest(runId: string, plan: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.run_manifest.v1",
    run_id: runId,
    mode: "opportunity_discovery",
    status: "researching",
    status_before_clarification: null,
    parent_run_id: null,
    created_at: "2026-07-24T12:00:00Z",
    updated_at: "2026-07-24T12:06:00Z",
    skill_version: "1.0.0",
    policy_version: "1.0.0",
    schema_bundle_version: "2.2.0",
    git_commit: null,
    current_phase: "enrichment",
    current_plan_ref: PLAN_REF,
    plan_revision: plan.revision,
    followup_round: 0,
    latest_gap_snapshot_ref: GAP_REF,
    pending_adaptation_refs: [DECISION_REF],
    validated_adaptation_refs: [],
    rejected_adaptation_refs: [],
    applied_adaptation_refs: [],
    completed_units: ["counter_completed"],
    active_units: ["buyer_active"],
    failed_units: ["acquisition_failed"],
    invalidated_units: [],
    skipped_units: [],
    cancelled_units: [],
    superseded_units: [],
    ignored_late_artifact_refs: [],
    artifact_refs: [],
    checkpoint_ref: null,
    limitations: [],
  };
}

function context(
  runManifest: Record<string, unknown>,
  plan: Record<string, unknown>,
  options: {
    readonly path: string;
    readonly revision: number;
    readonly parentRef: string | null;
    readonly stage: "current_plan" | "candidate_revision";
    readonly createdAt: string;
  },
): { readonly path: string; readonly document: Record<string, unknown> } {
  return {
    path: options.path,
    document: {
      schema_version: "startup_opportunity.planning_context.v2",
      context_id: `planning_context_${String(runManifest.run_id).replaceAll("-", "_")}`,
      revision: options.revision,
      parent_context_ref: options.parentRef,
      run_id: runManifest.run_id,
      mode: runManifest.mode,
      phase: "enrichment",
      validation_stage: options.stage,
      manifest_binding: {
        manifest_ref: "manifest.json",
        manifest_schema_version: "startup_opportunity.run_manifest.v1",
        run_id: runManifest.run_id,
        mode: runManifest.mode,
        current_plan_ref: runManifest.current_plan_ref,
        current_plan_revision: runManifest.plan_revision,
        run_state_hash: planningRunStateHash({
          manifest_ref: "manifest.json",
          manifest_schema_version: "startup_opportunity.run_manifest.v1",
          run_id: String(runManifest.run_id),
          mode: String(runManifest.mode),
          current_plan_ref: runManifest.current_plan_ref as string,
          current_plan_revision: Number(runManifest.plan_revision),
        }),
      },
      target_plan_binding: {
        plan_ref: options.stage === "candidate_revision" ? "plans/research-plan.r2.json" : PLAN_REF,
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
      created_at: options.createdAt,
    },
  };
}

function gapSnapshot(
  runId: string,
  gapType = "unit_failed",
  subjectRef = `${PLAN_REF}#acquisition_failed`,
): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.gap_snapshot.v1",
    snapshot_id: "gap_runtime_snapshot_001",
    snapshot_cycle_key: "enrichment:wave_runtime_1:fixture",
    run_id: runId,
    based_on_plan_ref: PLAN_REF,
    revision: 1,
    parent_snapshot_ref: null,
    created_at: "2026-07-24T12:04:00Z",
    trigger_kind: "wave_completed",
    trigger_event_ref: null,
    phase: "enrichment",
    wave_id: "wave_runtime_1",
    observed_artifact_refs: [],
    gaps: [
      {
        gap_id: "gap_runtime_001",
        subject_ref: subjectRef,
        gap_type: gapType,
        detection_mode: "deterministic",
        triggered_by: {
          check_id: "fixture_machine_check",
          observed_artifact_refs: [],
          detail: "The explicit fixture state triggers this closed machine gap.",
        },
        decision_impact: ["execution_validity"],
        severity: "blocking",
        basis_refs: ["manifest.json", PLAN_REF],
        evidence_refs: [],
        recommended_unit_types: gapType === "unit_failed" ? ["acquisition"] : [],
      },
    ],
    material_new_evidence_observed: gapType !== "no_material_new_evidence",
    unresolved_decision_relevant_questions: ["rq_runtime_001"],
    stop_signals: gapType === "no_material_new_evidence" ? ["no_material_new_evidence"] : [],
  };
}

function retryDecision(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.adaptation_decision.v2",
    adaptation_id: "adapt_retry_runtime_001",
    run_id: runId,
    based_on_plan_ref: PLAN_REF,
    trigger_gap_refs: [`${GAP_REF}#gap_runtime_001`],
    action: "retry_unit",
    target_unit_ref: `${PLAN_REF}#acquisition_failed`,
    target_unit: unit(
      "acquisition_retry_2",
      "acquisition",
      "artifacts/lanes/acquisition-failed.retry-2.json",
      {
        attempt: 2,
        supersedes_unit_ref: `${PLAN_REF}#acquisition_failed`,
      },
    ),
    retry_basis: {
      kind: "manifest_failed_unit",
      manifest_ref: "manifest.json",
      unit_id: "acquisition_failed",
      manifest_state: "failed",
    },
    reason: "The exact Manifest failed_units state permits one retry.",
    expected_decision_impact: ["execution_validity"],
    success_condition: "A new immutable output revision is produced.",
    requested_by: "main_agent",
    created_at: "2026-07-24T12:05:00Z",
  };
}

function supersedeDecision(runId: string): Record<string, unknown> {
  return {
    schema_version: "startup_opportunity.adaptation_decision.v2",
    adaptation_id: "adapt_supersede_runtime_001",
    run_id: runId,
    based_on_plan_ref: PLAN_REF,
    trigger_gap_refs: [`${GAP_REF}#gap_runtime_001`],
    action: "supersede_unit",
    target_unit_ref: `${PLAN_REF}#buyer_active`,
    target_unit: unit(
      "buyer_superseding",
      "buyer_language",
      "artifacts/lanes/buyer-superseding.json",
      { supersedes_unit_ref: `${PLAN_REF}#buyer_active` },
    ),
    reason: "The active unit must be replaced by an immutable successor.",
    expected_decision_impact: ["execution_validity"],
    success_condition: "The replacement unit owns a new output path.",
    requested_by: "main_agent",
    created_at: "2026-07-24T12:05:00Z",
  };
}

function bundle(
  runManifest: Record<string, unknown>,
  plan: Record<string, unknown>,
  planningContext: { readonly path: string; readonly document: Record<string, unknown> },
  gap: Record<string, unknown>,
  decision: Record<string, unknown>,
  extras: readonly { readonly path: string; readonly document: Record<string, unknown> }[] = [],
): DocumentBundle {
  return {
    schema_version: "startup_opportunity.document_bundle.v2",
    documents: [
      { path: "manifest.json", document: runManifest },
      { path: PLAN_REF, document: plan },
      planningContext,
      { path: GAP_REF, document: gap },
      { path: DECISION_REF, document: decision },
      ...extras,
    ],
  };
}

function formalEnvelope(
  runId: string,
  artifactPath: string,
  document: Record<string, unknown>,
  inputRefs: readonly string[] = [],
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.v3",
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    run_id: runId,
    created_at: String(document.created_at ?? "2026-07-24T12:01:00Z"),
    producer_role: document.producer_role === "main_agent" ? "main_agent" : "harness",
    input_refs: inputRefs,
    content_hash: canonicalContentHash(document),
    document,
  };
}

async function setupPersistedRun(
  contextTest: TestContext,
  runId: string,
  action: "retry" | "supersede" = "retry",
) {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g04-"));
  contextTest.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await store.create({
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-24T12:00:00Z",
  });
  const plan = basePlan(runId);
  await store.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, PLAN_REF, plan),
  });
  const runRoot = path.join(runsRoot, runId);
  const persistedManifest = manifest(runId, plan);
  persistedManifest.artifact_refs = [PLAN_REF];
  persistedManifest.latest_gap_snapshot_ref = null;
  persistedManifest.pending_adaptation_refs = [];
  await writeFile(path.join(runRoot, "manifest.json"), `${canonicalJson(persistedManifest)}\n`);
  const planningContext = context(persistedManifest, plan, {
    path: CONTEXT_REF,
    revision: 1,
    parentRef: null,
    stage: "current_plan",
    createdAt: "2026-07-24T12:03:00Z",
  });
  const gap = gapSnapshot(runId);
  const decision = action === "retry" ? retryDecision(runId) : supersedeDecision(runId);
  await store.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, CONTEXT_REF, planningContext.document, [
      "manifest.json",
      PLAN_REF,
    ]),
  });
  await store.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, GAP_REF, gap, [PLAN_REF]),
  });
  await store.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, DECISION_REF, decision, [PLAN_REF, GAP_REF]),
  });
  const beforeCheckpoint = JSON.parse(
    await readFile(path.join(runRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  beforeCheckpoint.latest_gap_snapshot_ref = GAP_REF;
  beforeCheckpoint.pending_adaptation_refs = [DECISION_REF];
  beforeCheckpoint.completed_units = ["counter_completed"];
  beforeCheckpoint.active_units = ["buyer_active"];
  beforeCheckpoint.failed_units = ["acquisition_failed"];
  beforeCheckpoint.updated_at = "2026-07-24T12:06:00Z";
  await writeFile(path.join(runRoot, "manifest.json"), `${canonicalJson(beforeCheckpoint)}\n`);
  await store.checkpoint({
    runId,
    checkpointId: "checkpoint_planned_runtime",
    createdAt: "2026-07-24T12:07:00Z",
    nextStep: "Apply the validated retry decision.",
    beliefSummary: {
      current_belief: "The failed unit requires a mechanical retry decision.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does the retry produce a valid result?",
    },
    unresolvedGapRefs: [`${GAP_REF}#gap_runtime_001`],
    inputRefs: [CONTEXT_REF, GAP_REF, DECISION_REF],
  });
  const loaded = await store.load(runId);
  const currentManifest = loaded.manifest as unknown as Record<string, unknown>;
  const checkpointEnvelope = JSON.parse(
    await readFile(path.join(runRoot, loaded.lastValidCheckpointRef), "utf8"),
  ) as FormalArtifactEnvelope;
  const checkpointEntry = {
    path: loaded.lastValidCheckpointRef,
    document: checkpointEnvelope.document,
  };
  const adaptationBundle = bundle(currentManifest, plan, planningContext, gap, decision, [
    checkpointEntry,
  ]);
  return {
    root,
    runsRoot,
    runRoot,
    store,
    plan,
    gap,
    decision,
    planningContext,
    currentManifest,
    adaptationBundle,
    checkpointEntry,
  };
}

function candidateFor(
  setup: Awaited<ReturnType<typeof setupPersistedRun>>,
  createdAt = "2026-07-24T12:08:00Z",
) {
  const transformed = transformPlan(
    PLAN_REF,
    setup.plan,
    setup.currentManifest as never,
    [{ path: DECISION_REF, document: setup.decision }],
    createdAt,
  );
  assert.ok(transformed.plan);
  const candidateContext = context(setup.currentManifest, transformed.plan, {
    path: "plans/planning-context.r2.json",
    revision: 2,
    parentRef: CONTEXT_REF,
    stage: "candidate_revision",
    createdAt: "2026-07-24T12:08:30Z",
  });
  const candidateBundle: DocumentBundle = {
    schema_version: "startup_opportunity.document_bundle.v2",
    documents: [
      { path: "manifest.json", document: setup.currentManifest },
      { path: PLAN_REF, document: setup.plan },
      { path: transformed.planPath, document: transformed.plan },
      setup.planningContext,
      candidateContext,
      { path: GAP_REF, document: setup.gap },
      { path: DECISION_REF, document: setup.decision },
      setup.checkpointEntry,
    ],
  };
  return { transformed, candidateBundle };
}

test("Plan semantic validation enforces DAG, output uniqueness, policy tuple, and current bindings", async () => {
  const runId = "plan-semantic-fixture";
  const plan = basePlan(runId);
  const runManifest = manifest(runId, plan);
  const planningContext = context(runManifest, plan, {
    path: CONTEXT_REF,
    revision: 1,
    parentRef: null,
    stage: "current_plan",
    createdAt: "2026-07-24T12:03:00Z",
  });
  const validBundle = bundle(
    runManifest,
    plan,
    planningContext,
    gapSnapshot(runId),
    retryDecision(runId),
  );
  const validator = await createPlanSemanticValidator(repositoryRoot);
  assert.equal(validator.validateDocumentBundle(validBundle).valid, true);

  const cycle = clone(validBundle);
  const cyclePlan = cycle.documents.find((entry) => entry.path === PLAN_REF)?.document as Record<
    string,
    unknown
  >;
  ((cyclePlan.waves as Record<string, unknown>[])[0] as Record<string, unknown>).depends_on = [
    "wave_runtime_2",
  ];
  assert.ok(
    validator
      .validateDocumentBundle(cycle)
      .planErrors.some((error) => error.code === "plan.wave_cycle"),
  );

  const duplicate = clone(validBundle);
  const duplicatePlan = duplicate.documents.find((entry) => entry.path === PLAN_REF)
    ?.document as Record<string, unknown>;
  const duplicateUnits = (duplicatePlan.waves as { units: Record<string, unknown>[] }[])[1]?.units;
  assert.ok(duplicateUnits);
  const firstDuplicateUnit = duplicateUnits[0];
  const secondDuplicateUnit = duplicateUnits[1];
  assert.ok(firstDuplicateUnit && secondDuplicateUnit);
  secondDuplicateUnit.output_path = firstDuplicateUnit.output_path;
  assert.ok(
    validator
      .validateDocumentBundle(duplicate)
      .planErrors.some((error) => error.code === "plan.output_path_conflict"),
  );

  const tuple = clone(validBundle);
  const tuplePlan = tuple.documents.find((entry) => entry.path === PLAN_REF)?.document as Record<
    string,
    unknown
  >;
  (
    (tuplePlan.waves as { units: Record<string, unknown>[] }[])[0]?.units[0] as Record<
      string,
      unknown
    >
  ).agent_role = "evidence-auditor";
  assert.ok(
    validator
      .validateDocumentBundle(tuple)
      .planningContract.contractErrors.some(
        (error) => error.code === "contract.unit_tuple_not_allowed",
      ),
  );
});

test("Gap analyzer emits only deterministic machine-observable gaps and stop signals", async () => {
  const runId = "gap-analysis-fixture";
  const plan = basePlan(runId);
  const runManifest = manifest(runId, plan);
  runManifest.followup_round = 2;
  const planningContext = context(runManifest, plan, {
    path: CONTEXT_REF,
    revision: 1,
    parentRef: null,
    stage: "current_plan",
    createdAt: "2026-07-24T12:03:00Z",
  });
  const currentBundle = bundle(
    runManifest,
    plan,
    planningContext,
    gapSnapshot(runId),
    retryDecision(runId),
  );
  const analyzer = await createGapAnalyzer(repositoryRoot);
  const input = {
    documentBundle: currentBundle,
    snapshotId: "gap_machine_draft_001",
    createdAt: "2026-07-24T12:09:00Z",
    triggerKind: "wave_completed" as const,
    phase: "enrichment",
    waveId: "wave_runtime_1",
    triggerEventRef: null,
    observedArtifactRefs: [],
    materialNewEvidenceObserved: false,
  };
  const first = analyzer.analyze(input);
  const second = analyzer.analyze(input);
  assert.equal(first.valid, true, JSON.stringify(first.errors));
  assert.equal(canonicalJson(first), canonicalJson(second));
  const gaps = first.snapshot?.gaps as Record<string, unknown>[];
  assert.deepEqual(gaps.map((gap) => gap.gap_type).sort(), [
    "no_material_new_evidence",
    "unit_failed",
  ]);
  assert.deepEqual(first.snapshot?.stop_signals, [
    "max_followup_rounds_reached",
    "no_material_new_evidence",
  ]);

  const invalid = analyzer.analyze({
    ...input,
    observedArtifactRefs: ["artifacts/lanes/missing.json"],
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.code === "gap.reference_missing"));
});

test("Adaptation validator accepts all closed actions and rejects retry outside failed_units", async () => {
  const scenario = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "tests/fixtures/g0.4/plan-adaptation-cases.json"),
      "utf8",
    ),
  ) as { valid_actions: string[] };
  const validator = await createAdaptationPolicyValidator(repositoryRoot);
  for (const action of scenario.valid_actions) {
    const runId = `adapt-${action.replaceAll("_", "-")}`;
    const plan = basePlan(runId);
    const runManifest = manifest(runId, plan);
    let gap = gapSnapshot(runId);
    const decision = retryDecision(runId);
    decision.adaptation_id = `adapt_${action}`;
    decision.action = action;
    decision.created_at = "2026-07-24T12:05:00Z";
    delete decision.target_unit;
    delete decision.target_unit_ref;
    delete decision.retry_basis;
    delete decision.priority_band;
    delete decision.coverage_attestation_ref;
    delete decision.clarification_question;
    delete decision.stop_condition;
    delete decision.success_condition;
    const extras: { path: string; document: Record<string, unknown> }[] = [];
    if (action === "add_unit") {
      decision.target_unit = unit("added_unit", "acquisition", "artifacts/lanes/added-unit.json");
      decision.success_condition = "The new unit resolves the explicit gap.";
    } else if (action === "cancel_unit") {
      decision.target_unit_ref = `${PLAN_REF}#buyer_active`;
      decision.success_condition = "The active unit stops or its result is ignored.";
    } else if (action === "skip_unit") {
      decision.target_unit_ref = `${PLAN_REF}#value_pending`;
      decision.success_condition = "The pending unit remains unstarted.";
    } else if (action === "reprioritize_unit") {
      decision.target_unit_ref = `${PLAN_REF}#value_pending`;
      decision.priority_band = "high";
      decision.success_condition = "The pending unit uses the new priority.";
    } else if (action === "retry_unit") {
      Object.assign(decision, retryDecision(runId));
    } else if (action === "supersede_unit") {
      decision.target_unit_ref = `${PLAN_REF}#buyer_active`;
      decision.target_unit = unit(
        "buyer_superseding",
        "buyer_language",
        "artifacts/lanes/buyer-superseding.json",
        { supersedes_unit_ref: `${PLAN_REF}#buyer_active` },
      );
      decision.success_condition = "The replacement unit produces a new output.";
    } else if (action === "continue_existing_plan") {
      gap = gapSnapshot(runId, "evidence_insufficient", SUBJECT_REF);
      const gapRef = `${GAP_REF}#gap_runtime_001`;
      const targetRef = `${PLAN_REF}#value_pending`;
      const identity = {
        schema_version: "startup_opportunity.coverage_attestation.v1" as const,
        relation: "same_subject_and_semantically_equivalent_research_goal" as const,
        run_id: runId,
        based_on_plan_ref: PLAN_REF,
        based_on_plan_revision: 1,
        based_on_plan_hash: canonicalContentHash(plan),
        gap_ref: gapRef,
        subject_ref: SUBJECT_REF,
        target_unit_ref: targetRef,
        gap_research_goal: "Resolve the explicit evidence gap.",
        target_research_goal: "Research value_pending for the explicit subject.",
      };
      const coverage = {
        ...identity,
        coverage_key: coverageKey(identity),
        semantic_equivalence_declared: true,
        declared_by: "main_agent",
        created_at: "2026-07-24T12:04:30Z",
      };
      const coverageRef = "adaptations/coverage/coverage-runtime.json";
      extras.push({ path: coverageRef, document: coverage });
      decision.target_unit_ref = targetRef;
      decision.coverage_attestation_ref = coverageRef;
      decision.success_condition = "The existing unit resolves the same declared goal.";
    } else if (action === "request_clarification") {
      decision.clarification_question = "Which explicit scope should the Run use?";
      decision.success_condition = "The user supplies the missing scope value.";
    } else if (action === "stop_followup") {
      gap = gapSnapshot(runId, "no_material_new_evidence", PLAN_REF);
      decision.stop_condition = "The explicit no-new-evidence stop signal is present.";
    } else if (action === "terminate_insufficient_evidence") {
      decision.stop_condition = "The blocking gap cannot be resolved under current scope.";
    }
    const planningContext = context(runManifest, plan, {
      path: CONTEXT_REF,
      revision: 1,
      parentRef: null,
      stage: "current_plan",
      createdAt: "2026-07-24T12:03:00Z",
    });
    const result = validator.validateDocumentBundle(
      bundle(runManifest, plan, planningContext, gap, decision, extras),
    );
    assert.equal(result.valid, true, `${action}: ${JSON.stringify(result.adaptationErrors)}`);
  }

  const runId = "adapt-retry-not-failed";
  const plan = basePlan(runId);
  const runManifest = manifest(runId, plan);
  runManifest.failed_units = [];
  runManifest.completed_units = ["counter_completed", "acquisition_failed"];
  const planningContext = context(runManifest, plan, {
    path: CONTEXT_REF,
    revision: 1,
    parentRef: null,
    stage: "current_plan",
    createdAt: "2026-07-24T12:03:00Z",
  });
  const result = validator.validateDocumentBundle(
    bundle(runManifest, plan, planningContext, gapSnapshot(runId), retryDecision(runId)),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.planValidation.planningContract.contractErrors.some(
      (error) => error.code === "contract.retry_target_not_failed",
    ),
  );
});

test("Plan Revision apply is CAS-safe, immutable, and idempotent on a real Run", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-apply-success");
  const { transformed, candidateBundle } = candidateFor(setup);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const preflight = (await createAdaptationPolicyValidator(repositoryRoot)).validateDocumentBundle(
    setup.adaptationBundle,
  );
  assert.equal(preflight.valid, true, JSON.stringify(preflight));
  const candidatePreflight = (
    await createPlanSemanticValidator(repositoryRoot)
  ).validateDocumentBundle(candidateBundle);
  assert.equal(candidatePreflight.valid, true, JSON.stringify(candidatePreflight));
  const input = {
    runId: "runtime-apply-success",
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Run the approved retry unit.",
    beliefSummary: {
      current_belief: "The failed unit has one approved retry.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does the retry produce a valid result?",
    },
  };
  const applied = await runtime.apply(input);
  assert.equal(applied.status, "applied");
  assert.equal(applied.currentPlanRef, "plans/research-plan.r2.json");
  assert.equal(
    canonicalJson(
      (
        JSON.parse(
          await readFile(path.join(setup.runRoot, "plans/research-plan.r2.json"), "utf8"),
        ) as FormalArtifactEnvelope
      ).document,
    ),
    canonicalJson(transformed.plan),
  );
  const reopened = await setup.store.load("runtime-apply-success");
  assert.equal(reopened.manifest.plan_revision, 2);
  assert.ok(reopened.manifest.superseded_units.includes("acquisition_failed"));
  assert.ok(reopened.manifest.applied_adaptation_refs.includes(DECISION_REF));
  const replay = await runtime.apply(input);
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.operationKey, applied.operationKey);

  const conflictingReplay = clone(input);
  conflictingReplay.nextStep = "Use different checkpoint metadata.";
  await assert.rejects(
    runtime.apply(conflictingReplay),
    (error: unknown) => error instanceof StoreError && error.code === "write.operation_conflict",
  );

  const stale = clone(input);
  const staleDecisionRef = "adaptations/decisions/adapt-retry-stale.json";
  const staleDecisionEntry = stale.adaptationBundle.documents.find(
    (entry) => entry.path === DECISION_REF,
  ) as { path: string; document: Record<string, unknown> } | undefined;
  assert.ok(staleDecisionEntry);
  staleDecisionEntry.path = staleDecisionRef;
  staleDecisionEntry.document.adaptation_id = "adapt_retry_stale_001";
  stale.adaptationRefs = [staleDecisionRef];
  stale.createdAt = "2026-07-24T12:10:00Z";
  stale.checkpointCreatedAt = "2026-07-24T12:11:00Z";
  await assert.rejects(
    runtime.apply(stale),
    (error: unknown) => error instanceof StoreError && error.code === "apply.stale_input_bundle",
  );
});

test("pre-CAS crash keeps base current; replay completes the immutable revision", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-crash-before-cas");
  const { candidateBundle } = candidateFor(setup);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  const input = {
    runId: "runtime-crash-before-cas",
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Run the approved retry unit.",
    beliefSummary: {
      current_belief: "The retry is approved but not current before CAS.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Can the operation replay safely?",
    },
    faultAt: "after_control_artifacts" as const,
  };
  await assert.rejects(
    runtime.apply(input),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await setup.store.load("runtime-crash-before-cas");
  assert.equal(reopened.manifest.current_plan_ref, PLAN_REF);
  assert.equal(reopened.planOperationRecovery.pendingOperationKeys.length, 1);
  const { faultAt: _faultAt, ...replayInput } = input;
  const replay = await runtime.apply(replayInput);
  assert.equal(replay.status, "idempotent_replay");
  assert.equal((await setup.store.load("runtime-crash-before-cas")).manifest.plan_revision, 2);
});

test("post-manifest crash is completed during reopen from validated receipt state", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-crash-after-cas");
  const { candidateBundle } = candidateFor(setup);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  await assert.rejects(
    runtime.apply({
      runId: "runtime-crash-after-cas",
      adaptationBundle: setup.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      candidateBundle,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Run the approved retry unit.",
      beliefSummary: {
        current_belief: "Manifest CAS succeeded and recovery must finish the checkpoint.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Did reopen complete the durable boundary?",
      },
      faultAt: "after_manifest_update",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await setup.store.load("runtime-crash-after-cas");
  assert.equal(reopened.manifest.plan_revision, 2);
  assert.equal(reopened.planOperationRecovery.completedOperationKeys.length, 1);
  assert.equal(reopened.manifest.checkpoint_ref?.includes("checkpoint-plan-apply"), true);
  assert.equal((await setup.store.load("runtime-crash-after-cas")).recovered, false);
});

test("candidate content must equal the deterministic Plan transformation", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-candidate-conflict");
  const { candidateBundle } = candidateFor(setup);
  const changed = clone(candidateBundle);
  const candidatePlan = changed.documents.find(
    (entry) => entry.path === "plans/research-plan.r2.json",
  )?.document;
  const candidateContext = changed.documents.find(
    (entry) => entry.path === "plans/planning-context.r2.json",
  )?.document;
  assert.ok(candidatePlan && candidateContext);
  const questions = candidatePlan.research_questions as Record<string, unknown>[];
  assert.ok(questions[0]);
  questions[0].question = "A schema-valid but non-deterministic candidate mutation.";
  const targetBinding = candidateContext.target_plan_binding as Record<string, unknown>;
  targetBinding.plan_content_hash = canonicalContentHash(candidatePlan);

  await assert.rejects(
    (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
      runId: "runtime-candidate-conflict",
      adaptationBundle: setup.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      candidateBundle: changed,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Reject the non-deterministic candidate.",
      beliefSummary: {
        current_belief: "Only the deterministic transform may become current.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Does the candidate match the closed transform?",
      },
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "apply.candidate_transform_mismatch",
  );
});

test("supersede apply replaces active work without mutating the parent Plan", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-supersede-success", "supersede");
  const parentBefore = canonicalJson(setup.plan);
  const { candidateBundle } = candidateFor(setup);
  const applied = await (await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot)).apply({
    runId: "runtime-supersede-success",
    adaptationBundle: setup.adaptationBundle,
    adaptationRefs: [DECISION_REF],
    candidateBundle,
    createdAt: "2026-07-24T12:08:00Z",
    checkpointCreatedAt: "2026-07-24T12:09:00Z",
    nextStep: "Run the validated superseding unit.",
    beliefSummary: {
      current_belief: "The active unit has an immutable successor.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does the successor produce a valid result?",
    },
  });
  assert.equal(applied.status, "applied");
  const loaded = await setup.store.load("runtime-supersede-success");
  assert.equal(loaded.manifest.superseded_units.includes("buyer_active"), true);
  assert.equal(loaded.manifest.active_units.includes("buyer_active"), false);
  assert.equal(canonicalJson(setup.plan), parentBefore);
  const candidatePlan = JSON.parse(
    await readFile(path.join(setup.runRoot, "plans/research-plan.r2.json"), "utf8"),
  ) as FormalArtifactEnvelope;
  const units = (candidatePlan.document.waves as { units: Record<string, unknown>[] }[]).flatMap(
    (wave) => wave.units,
  );
  assert.equal(
    units.find((entry) => entry.unit_id === "buyer_active")?.plan_disposition,
    "superseded",
  );
  assert.equal(
    units.find((entry) => entry.unit_id === "buyer_superseding")?.supersedes_unit_ref,
    `${PLAN_REF}#buyer_active`,
  );
});

test("intent and checkpoint crash boundaries reopen without partial current state", async (contextTest) => {
  for (const scenario of [
    {
      runId: "runtime-crash-after-intent",
      faultAt: "after_intent" as const,
      revisionAfterFault: 1,
    },
    {
      runId: "runtime-crash-after-checkpoint",
      faultAt: "after_checkpoint_publish" as const,
      revisionAfterFault: 2,
    },
  ]) {
    const setup = await setupPersistedRun(contextTest, scenario.runId);
    const { candidateBundle } = candidateFor(setup);
    const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
    const input = {
      runId: scenario.runId,
      adaptationBundle: setup.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      candidateBundle,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Recover the injected operation boundary.",
      beliefSummary: {
        current_belief: "The operation receipt is the durable recovery intent.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Can the Run reopen from validated disk state?",
      },
      faultAt: scenario.faultAt,
    };
    await assert.rejects(
      runtime.apply(input),
      (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
    );
    const manifestAfterFault = JSON.parse(
      await readFile(path.join(setup.runRoot, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(manifestAfterFault.plan_revision, scenario.revisionAfterFault);

    const loaded = await setup.store.load(scenario.runId);
    if (scenario.faultAt === "after_intent") {
      assert.equal(loaded.planOperationRecovery.pendingOperationKeys.length, 1);
      const { faultAt: _faultAt, ...replayInput } = input;
      assert.equal((await runtime.apply(replayInput)).status, "idempotent_replay");
    } else {
      assert.equal(loaded.planOperationRecovery.completedOperationKeys.length, 1);
    }
    assert.equal((await setup.store.load(scenario.runId)).manifest.plan_revision, 2);
  }
});

test("reopen rejects Plan operation receipt document drift", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-receipt-drift");
  const { candidateBundle } = candidateFor(setup);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, setup.runsRoot);
  await assert.rejects(
    runtime.apply({
      runId: "runtime-receipt-drift",
      adaptationBundle: setup.adaptationBundle,
      adaptationRefs: [DECISION_REF],
      candidateBundle,
      createdAt: "2026-07-24T12:08:00Z",
      checkpointCreatedAt: "2026-07-24T12:09:00Z",
      nextStep: "Leave a receipt before its CAS boundary.",
      beliefSummary: {
        current_belief: "Recovery must reject receipt document drift.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Does receipt validation fail closed?",
      },
      faultAt: "after_intent",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const operationDirectory = path.join(setup.runRoot, ".store/operations");
  const receiptName = (await readdir(operationDirectory)).find((name) =>
    name.startsWith("plan-revision-"),
  );
  assert.ok(receiptName);
  const receiptPath = path.join(operationDirectory, receiptName);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  const receiptManifest = receipt.manifest as Record<string, unknown>;
  receiptManifest.status = "insufficient_evidence";
  await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);

  await assert.rejects(
    setup.store.load("runtime-receipt-drift"),
    (error: unknown) =>
      error instanceof StoreError && error.code === "recovery.invalid_plan_operation",
  );
});

test("late Artifact is persisted only as ignored and remains ignored after reopen", async (contextTest) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g04-late-"));
  contextTest.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "runtime-late-artifact";
  const store = new RunStore(runsRoot, await createArtifactValidator(repositoryRoot));
  await store.create({ runId, mode: "opportunity_discovery", createdAt: "2026-07-24T12:00:00Z" });
  const plan = basePlan(runId);
  const cancelledUnit = (plan.waves as { units: Record<string, unknown>[] }[])[0]?.units[1];
  assert.ok(cancelledUnit);
  const latePath = "artifacts/lanes/acquisition-late-event.json";
  cancelledUnit.output_path = latePath;
  cancelledUnit.required_artifact_schema = "startup_opportunity.event.v1";
  await store.publishArtifact({ runId, envelope: formalEnvelope(runId, PLAN_REF, plan) });

  const runRoot = path.join(runsRoot, runId);
  const current = JSON.parse(await readFile(path.join(runRoot, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
  Object.assign(current, {
    current_phase: "enrichment",
    current_plan_ref: PLAN_REF,
    plan_revision: 1,
    failed_units: [],
    cancelled_units: ["acquisition_failed"],
    artifact_refs: [PLAN_REF],
    updated_at: "2026-07-24T12:06:00Z",
  });
  await writeFile(path.join(runRoot, "manifest.json"), `${canonicalJson(current)}\n`);
  await store.checkpoint({
    runId,
    checkpointId: "checkpoint_late_boundary",
    createdAt: "2026-07-24T12:07:00Z",
    nextStep: "Ignore any result arriving for the cancelled unit.",
    beliefSummary: {
      current_belief: "The cancelled unit cannot affect the current plan.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: [],
      remaining_disagreement: [],
      next_decision_relevant_question: "Does a late result remain excluded?",
    },
  });

  const lateDocument = {
    schema_version: "startup_opportunity.event.v1",
    event_id: "late_unit_result_fixture",
    run_id: runId,
    event_type: "research_unit_completed",
    timestamp: "2026-07-24T12:08:00Z",
    actor: "lane_researcher",
    reason: "A result arrived after its owning unit was cancelled.",
    artifact_refs: [],
  };
  await store.publishArtifact({
    runId,
    envelope: formalEnvelope(runId, latePath, lateDocument),
  });
  const afterLatePublish = JSON.parse(
    await readFile(path.join(runRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(afterLatePublish.updated_at, "2026-07-24T12:07:00Z");
  let loaded = await store.load(runId);
  assert.equal(loaded.manifest.artifact_refs.includes(latePath), false);
  assert.equal(loaded.manifest.ignored_late_artifact_refs.includes(latePath), true);
  loaded = await store.load(runId);
  assert.equal(loaded.manifest.artifact_refs.includes(latePath), false);
  assert.equal(loaded.manifest.ignored_late_artifact_refs.includes(latePath), true);

  await assert.rejects(
    store.publishArtifact({
      runId,
      envelope: formalEnvelope(runId, latePath, gapSnapshot(runId)),
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.unit_schema_mismatch",
  );

  const futurePath = "artifacts/lanes/buyer-active.json";
  const futureDocument = {
    schema_version: "startup_opportunity.enrichment_branch_result.v1",
    run_id: runId,
  };
  await assert.rejects(
    store.publishArtifact({
      runId,
      envelope: formalEnvelope(runId, futurePath, futureDocument),
    }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.schema_invalid",
  );
});

test("Harness CLI and repo-local Skill scripts run all four G0.4 entries", async (contextTest) => {
  const setup = await setupPersistedRun(contextTest, "runtime-cli-entries");
  const { candidateBundle } = candidateFor(setup);
  const bundleFile = path.join(setup.root, "planning-bundle.json");
  const gapInputFile = path.join(setup.root, "gap-input.json");
  const applyInputFile = path.join(setup.root, "apply-input.json");
  await writeFile(bundleFile, `${canonicalJson(setup.adaptationBundle)}\n`);
  await writeFile(
    gapInputFile,
    `${canonicalJson({
      schema_version: "startup_opportunity.gap_analysis_input.v1",
      document_bundle: setup.adaptationBundle,
      snapshot_id: "gap_cli_draft_001",
      created_at: "2026-07-24T12:08:00Z",
      trigger_kind: "wave_completed",
      phase: "enrichment",
      wave_id: "wave_runtime_1",
      trigger_event_ref: null,
      observed_artifact_refs: [],
      material_new_evidence_observed: false,
      repeated_source_refs: [],
      machine_checks: [],
    })}\n`,
  );
  await writeFile(
    applyInputFile,
    `${canonicalJson({
      schema_version: "startup_opportunity.plan_revision_apply_input.v1",
      run_id: "runtime-cli-entries",
      adaptation_bundle: setup.adaptationBundle,
      adaptation_refs: [DECISION_REF],
      candidate_bundle: candidateBundle,
      created_at: "2026-07-24T12:08:00Z",
      checkpoint_created_at: "2026-07-24T12:09:00Z",
      next_step: "Run the approved retry unit.",
      belief_summary: {
        current_belief: "The failed unit has one validated retry.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "Does the retry produce a valid result?",
      },
    })}\n`,
  );

  for (const [command, skillScript, flag, filename] of [
    ["validate-plan", "validate-plan.ts", "--bundle", bundleFile],
    ["analyze-gaps", "analyze-gaps.ts", "--file", gapInputFile],
    ["validate-adaptation", "validate-adaptation.ts", "--bundle", bundleFile],
  ] as const) {
    for (const [script, args] of [
      ["harness/src/cli.ts", [command, flag, filename]],
      [`.agents/skills/startup-opportunity/scripts/${skillScript}`, [flag, filename]],
    ] as const) {
      const result = runScript(script, args);
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
      assert.equal((JSON.parse(result.stdout) as { valid: boolean }).valid, true);
    }
  }

  const harnessApply = runScript("harness/src/cli.ts", [
    "apply-plan-revision",
    "--file",
    applyInputFile,
    "--runs-root",
    setup.runsRoot,
  ]);
  assert.equal(harnessApply.status, 0, harnessApply.stderr);
  assert.equal((JSON.parse(harnessApply.stdout) as { status: string }).status, "applied");
  const skillApply = runScript(
    ".agents/skills/startup-opportunity/scripts/apply-plan-revision.ts",
    ["--file", applyInputFile, "--runs-root", setup.runsRoot],
  );
  assert.equal(skillApply.status, 0, skillApply.stderr);
  assert.equal((JSON.parse(skillApply.stdout) as { status: string }).status, "idempotent_replay");

  for (const script of [
    "validate-plan.ts",
    "analyze-gaps.ts",
    "validate-adaptation.ts",
    "apply-plan-revision.ts",
  ]) {
    const failure = runScript(`.agents/skills/startup-opportunity/scripts/${script}`, []);
    assert.equal(failure.status, 64, `${script}: ${failure.stderr}`);
    assert.equal(
      (JSON.parse(failure.stderr) as { error: { code: string } }).error.code,
      "command.invalid_arguments",
    );
  }
});

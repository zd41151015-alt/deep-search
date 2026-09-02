import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  canonicalJson,
  createAdaptationAuthorRuntime,
  createArtifactValidator,
  DeclarativeRuntimeCompiler,
  DispatchLaunchRegistry,
  EvidenceStore,
  type FormalArtifactEnvelope,
  FormalStageMaterializer,
  LaneResultMaterializer,
  operationKey,
  planningRunStateHash,
  RunStore,
  StoreError,
} from "../harness/src/index.js";
import { deriveTerminalReportDocuments } from "../harness/src/reporting/terminal-reporting.js";
import { createFormalStageRuntimeCompiler } from "../harness/src/runtime/declarative-runtime.js";
import {
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
  G21_OPPORTUNITY_REF,
  G21_PLAN_REF,
  G21_SCOPE_REF,
  G21_SEED_REF,
  G21_SOLUTION_REF,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  createDiscoveryCandidateFixture,
  fixtureEffective,
  G22_BASELINE_R1,
  G22_DEMAND_R1,
  G22_DEMAND_R2,
  G22_EVALUATION_TASK,
  G22_FAN_IN,
  G22_FINDING,
  G22_GENERATION_TASK,
  G22_RETAINED_PRE_CANDIDATE,
  G22_RUN_ID,
  G22_SOLUTION_R1,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";
import {
  createDiscoveryRuntimeFixture,
  runtimeEnvelope,
} from "./fixtures/g2.2/discovery-runtime-fixture.js";
import {
  createDiscoverySynthesisFixture,
  discoverySynthesisReadinessEnvelopes,
  G23_BASELINE,
  G23_BASELINE_CONVERSION,
  G23_DEMAND,
  G23_DEMAND_CONVERSION,
  G23_EVALUATION,
  G23_OPPORTUNITY_A,
  G23_OPPORTUNITY_B,
  G23_SOLUTION,
  G23_SOLUTION_CONVERSION,
  synthesisEnvelope,
} from "./fixtures/g2.3/discovery-synthesis-fixture.js";
import {
  createConfirmedRun,
  initialPlanBundleEnvelopes,
  publishInitialPlanBundle,
} from "./helpers/current-run.js";
import { discoveryWaveEnvelopes } from "./helpers/discovery-wave.js";

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

function materializeHelpScaffold(helpText: string): Record<string, unknown> {
  const marker = "Minimal discovery_wave scaffold:\n";
  const start = helpText.indexOf(marker);
  assert.notEqual(start, -1);
  const jsonStart = helpText.indexOf("{", start);
  const jsonEndMarker =
    "\n\nHarness derives refs, hashes, Task/Dispatch/Execution paths, and launch-readiness diagnostics";
  const jsonEnd = helpText.indexOf(jsonEndMarker, jsonStart);
  assert.notEqual(jsonStart, -1);
  assert.notEqual(jsonEnd, -1);
  return JSON.parse(helpText.slice(jsonStart, jsonEnd)) as Record<string, unknown>;
}

test("CLI subcommand help exposes request entries and keeps malformed help invocations invalid", () => {
  const formalHelp = runCli(["materialize-formal-stage", "--help"]);
  assert.equal(formalHelp.status, 0, formalHelp.stderr);
  assert.match(
    formalHelp.stdout,
    /Usage:\n {2}npm run harness -- materialize-formal-stage --file FILE/,
  );
  assert.match(
    formalHelp.stdout,
    /schema_version=startup_opportunity\.formal_stage_materialization_request\.current/,
  );
  assert.match(formalHelp.stdout, /Minimal discovery_wave scaffold/);

  const doctorHelp = runCli(["doctor", "-h"]);
  assert.equal(doctorHelp.status, 0, doctorHelp.stderr);
  assert.match(doctorHelp.stdout, /npm run harness -- doctor \[--json\]/);

  const mixedHelp = runCli(["materialize-formal-stage", "--help", "--file", "request.json"]);
  assert.equal(mixedHelp.status, 64);
  assert.match(mixedHelp.stderr, /command\.invalid_arguments/);

  const unknownHelp = runCli(["not-a-command", "--help"]);
  assert.equal(unknownHelp.status, 64);
  assert.match(unknownHelp.stderr, /Unknown command: not-a-command/);
});

test("CLI materialize-formal-stage help scaffold is executable after binding one current generation Unit", async (t) => {
  const help = runCli(["materialize-formal-stage", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  const scaffold = materializeHelpScaffold(help.stdout);
  const state = await prepareGenerationPlanRun(t, "cli-help-scaffold-executable");
  const request = replaceExactStrings(
    scaffold,
    new Map([
      ["request_id", "cli_help_generation_scaffold"],
      ["run_id", state.runId],
      ["current_plan_wave_id", "wave_discovery_synthetic"],
      ["stage_id", "stage_cli_help_generation"],
      ["unit_id", "unit_seed_independent_demand"],
      ["audit_id", "cli_help_generation_audit"],
    ]),
  ) as Record<string, unknown>;
  const result = await new FormalStageMaterializer(
    state.runsRoot,
    state.validator,
    repositoryRoot,
  ).materialize(request);
  assert.equal(result.status, "validated");
  const task = result.compilation.compiled_envelopes.find(
    (entry) =>
      entry.artifact_type === "startup_opportunity.research_task.discovery_candidate.current",
  );
  assert.ok(task);
  assert.equal(state.validator.validateDocument(task.document, task.artifact_path).valid, true);
});

async function writeJson(root: string, name: string, value: unknown): Promise<string> {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

async function writeLaneStagingFile(
  runRoot: string,
  task: FormalArtifactEnvelope,
  staging: Record<string, unknown>,
): Promise<string> {
  const contract = task.document.lane_submission_contract as Record<string, unknown>;
  return writeJson(runRoot, String(contract.staging_output_path), staging);
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

function refreshRuntimePublicationPlanId(plan: Record<string, unknown>): void {
  const identity = { ...plan };
  delete identity.plan_id;
  plan.plan_id = operationKey("runtime_publication_plan", identity);
}

function retargetRuntimePublicationPlanManifest(
  plan: Record<string, unknown>,
  mutateManifest: (manifest: Record<string, unknown>) => void,
): void {
  const manifest = structuredClone(plan.manifest_snapshot) as Record<string, unknown>;
  mutateManifest(manifest);
  const manifestHash = canonicalContentHash(manifest);
  plan.manifest_snapshot = manifest;
  plan.manifest_content_hash = manifestHash;
  const validationClosure = plan.validation_closure as Record<string, unknown>;
  const documents = validationClosure.documents as Record<string, unknown>[];
  const manifestClosure = documents.find((entry) => entry.path === "manifest.json");
  assert.ok(manifestClosure);
  manifestClosure.content_hash = manifestHash;
  const resolvedReferences = plan.resolved_references as Record<string, unknown>[];
  for (const reference of resolvedReferences) {
    if (reference.target_path === "manifest.json") {
      reference.content_hash = manifestHash;
    }
  }
  refreshRuntimePublicationPlanId(plan);
}

function terminalReportEnvelopeWithHiddenDiagnostics(runId: string): FormalArtifactEnvelope {
  const artifactPath = "artifacts/reporting/terminal-report-source.r1.json";
  const document = {
    schema_version: "startup_opportunity.terminal_report_source.v1",
    report_id: "terminal_report_hidden_diagnostics",
    run_id: runId,
    mode: "opportunity_discovery",
    research_language: "zh-CN",
    producer_role: "main_agent",
    owned_output_path: artifactPath,
    materialized_path: "report.json",
    generated_at: "2026-08-19T09:07:02Z",
    decision_subject_snapshot_ref: "artifacts/reporting/decision-subject-snapshot.r1.json",
    decision_subject_snapshot_hash: `sha256:${"0".repeat(64)}`,
    decision_subject_synthesis_hashes: [],
    current_decision_subject_ids: [],
    terminal_outcome: "insufficient_evidence",
    decision_question: "当前部分发现周期是否应以证据不足如实收口？",
    execution: {
      completeness: "partial",
      completed_stages: [],
      incomplete_stages: [
        {
          stage: "Audit Lane Search Closure",
          cause: "evidence_ceiling",
          detail: "lane_delivery.search_closure_route_missing",
          conclusion_impact: "计划中的搜索完成记录缺失，因此结论保持证据不足。",
          related_refs: [],
        },
      ],
      required_followups: [
        {
          followup_id: "repair_terminal_source",
          status: "not_executed",
          detail: "后续只应补充当前计划内缺失的搜索完成记录。",
          related_refs: [],
        },
      ],
      pending_operation_refs: [],
    },
    research_conclusion: {
      outcome: "insufficient_evidence",
      current_recommendation: "当前材料不足以支持方向性结论。",
      meaning: "本次研究应保留为证据不足的终态，不提升建议强度。",
      evidence_strength: "insufficient",
      allowed_claim: "只能说明当前材料不足，不能声称需求或市场已被验证。",
    },
    runtime_health: {
      status: "healthy",
      issues: [
        {
          code: "synthetic_leak",
          stage: "Audit",
          detail: "lane_delivery.search_closure_route_missing",
          conclusion_impact: "结构化诊断只约束执行披露，不提高结论强度。",
          related_refs: [],
        },
      ],
    },
    directions: [],
    sources: [],
    research_provenance: {
      available_handoff_count: 0,
      captured_item_count: 0,
      causal_handoff_refs: [],
      consumed_item_refs: [],
      used_handoff_items: [],
      imported_substrate_refs: [],
      formal_inherited_evidence_refs: [],
      adopted_inherited_evidence_refs: [],
      cited_inherited_evidence_refs: [],
      formal_current_evidence_refs: [],
      adopted_current_evidence_refs: [],
      cited_current_evidence_refs: [],
      revalidation_gaps: [],
    },
    report_citations: [],
    report_evidence_dispositions: [],
    report_source_dispositions: [],
    excluded_evidence: [],
    commercial_research_audit_refs: [],
    commercial_uncertainties: [],
    quantitative_signal_rows: [],
    competitive_substitute_rows: [],
    incumbent_response_risk_rows: [],
    research_coverage_gaps: [],
    commercial_subject_aggregates: [],
    commercial_background_material: [],
    commercial_research_status: {
      state: "not_planned",
      planned_task_refs: [],
      missing_task_refs: [],
      submitted_audit_refs: [],
    },
    gate_warnings: [],
    ordered_validation_plan: [],
    freshness: {
      earliest_valid_as_of: null,
      latest_valid_as_of: null,
      summary: "没有足够当前材料支持方向性结论。",
    },
    limitations: ["结构化审计真值保留 exact diagnostic detail；中文 Markdown 只展示结论影响。"],
    external_action_boundary: {
      execution_owner: "user",
      execution_supported: false,
      result_tracking_supported: false,
      external_validation_claimed: false,
    },
    audit_refs: [],
  };
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: "startup_opportunity.terminal_report_source.v1",
    artifact_path: artifactPath,
    run_id: runId,
    created_at: "2026-08-19T09:07:02Z",
    producer_role: "main_agent",
    input_refs: [],
    content_hash: `sha256:${"0".repeat(64)}`,
    document,
  };
}

async function publishRuntimeEnvelopesAsFormalStage(
  input: {
    readonly runsRoot: string;
    readonly runId: string;
    readonly validator: Awaited<ReturnType<typeof createArtifactValidator>>;
  },
  envelopes: readonly FormalArtifactEnvelope[],
  requestId: string,
) {
  const compiler = createFormalStageRuntimeCompiler(
    input.runsRoot,
    input.validator,
    repositoryRoot,
  );
  return compiler.compile({
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: requestId,
    run_id: input.runId,
    operation: "publish",
    created_at: String(envelopes[0]?.created_at ?? createdAt),
    artifacts: envelopes.map((envelope) => ({
      artifact_type: envelope.artifact_type,
      artifact_path: envelope.artifact_path,
      producer_role: envelope.producer_role,
      input_refs: envelope.input_refs,
      document: envelope.document,
    })),
  });
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

function currentEnvelopes(
  bundle: Awaited<ReturnType<typeof createDiscoverySynthesisFixture>>,
): FormalArtifactEnvelope[] {
  return bundle.documents
    .map((entry) => entry.document as unknown as FormalArtifactEnvelope)
    .filter(
      (candidate) => candidate.schema_version === "startup_opportunity.artifact_envelope.current",
    );
}

function envelopesByType(
  bundle: Awaited<ReturnType<typeof createDiscoverySynthesisFixture>>,
  ...types: readonly string[]
): FormalArtifactEnvelope[] {
  return currentEnvelopes(bundle).filter((candidate) => types.includes(candidate.artifact_type));
}

function effectiveArtifact(
  bundle: Awaited<ReturnType<typeof createDiscoverySynthesisFixture>>,
  artifactPath: string,
): Record<string, unknown> {
  const entry = bundle.documents.find((candidate) => candidate.path === artifactPath);
  assert.ok(entry, artifactPath);
  return String(entry.document.schema_version).startsWith("startup_opportunity.artifact_envelope.")
    ? (entry.document.document as Record<string, unknown>)
    : entry.document;
}

async function registerAllDispatchLaunches(
  runsRoot: string,
  validator: Awaited<ReturnType<typeof createArtifactValidator>>,
  runId: string,
  dispatchEnvelope: FormalArtifactEnvelope,
  requestId: string,
): Promise<void> {
  const registry = new DispatchLaunchRegistry(runsRoot, validator, repositoryRoot);
  const checklist = await registry.check(
    runId,
    dispatchEnvelope.artifact_path,
    dispatchEnvelope.content_hash,
  );
  assert.equal(checklist.status, "open");
  const closed = await registry.register({
    schema_version: "startup_opportunity.dispatch_launch_registration_request.v1",
    request_id: requestId,
    run_id: runId,
    dispatch_ref: dispatchEnvelope.artifact_path,
    dispatch_hash: dispatchEnvelope.content_hash,
    registered_at: "2026-08-19T09:10:00Z",
    registrations: checklist.checklist.map((entry) => ({
      unit_id: entry.unit_id,
      task_ref: entry.task_ref,
      task_id: entry.task_id,
      attempt: entry.attempt,
      execution_attempt_id: `exec_${requestId}_${entry.unit_id}`,
    })),
  });
  assert.equal(closed.status, "closed");
}

test("validation context binds a research task only to its owning Dispatch authority", async (t) => {
  const state = await prepareRun(t, "validation-context-dispatch-scope");
  const wave = discoveryWaveEnvelopes(
    state.bundle,
    state.runId,
    "startup_opportunity.research_task.discovery_candidate.current",
    1,
    "candidate_runtime",
  );
  await publishRuntimeEnvelopesAsFormalStage(
    state,
    wave,
    "request_validation_context_dispatch_scope_wave",
  );
  const task = wave.find(
    (entry) =>
      entry.artifact_type === "startup_opportunity.research_task.discovery_candidate.current",
  );
  const dispatch = wave.find(
    (entry) => entry.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(task);
  assert.ok(dispatch);
  const unrelatedDispatch = structuredClone(dispatch) as FormalArtifactEnvelope & {
    artifact_path: string;
    content_hash: string;
  };
  unrelatedDispatch.artifact_path = "tasks/dispatch/unrelated_historical_candidate_runtime.r1.json";
  unrelatedDispatch.document.batch_id = "batch_unrelated_historical_candidate_runtime";
  const unrelatedTaskProjection = (
    unrelatedDispatch.document.tasks as Record<string, unknown>[]
  ).find(
    (entry) => entry.task_id === task.document.task_id && entry.unit_id === task.document.unit_id,
  );
  assert.ok(unrelatedTaskProjection);
  unrelatedTaskProjection.allowed_output_path =
    "artifacts/discovery/lanes/unrelated-historical.attempt-1.json";
  unrelatedDispatch.content_hash = canonicalContentHash(unrelatedDispatch.document);
  await writeFile(
    path.join(state.runsRoot, state.runId, unrelatedDispatch.artifact_path),
    `${JSON.stringify(unrelatedDispatch, null, 2)}\n`,
  );

  const context = await state.store.buildValidationContext(state.runId, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [{ path: task.artifact_path, document: task as unknown as Record<string, unknown> }],
  });
  const selectedPaths = context.bundle.documents.map((entry) => entry.path).sort();
  assert.ok(selectedPaths.includes(dispatch.artifact_path));
  assert.ok(!selectedPaths.includes(unrelatedDispatch.artifact_path));
});

test("validation context ignores an orphan same-fields Dispatch authority outside the manifest", async (t) => {
  const state = await prepareRun(t, "validation-context-orphan-dispatch");
  const wave = discoveryWaveEnvelopes(
    state.bundle,
    state.runId,
    "startup_opportunity.research_task.discovery_candidate.current",
    1,
    "candidate_runtime",
  );
  await publishRuntimeEnvelopesAsFormalStage(
    state,
    wave,
    "request_validation_context_orphan_dispatch_wave",
  );
  const task = wave.find(
    (entry) =>
      entry.artifact_type === "startup_opportunity.research_task.discovery_candidate.current",
  );
  const dispatch = wave.find(
    (entry) => entry.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(task);
  assert.ok(dispatch);

  const orphanDispatch = structuredClone(dispatch) as FormalArtifactEnvelope & {
    artifact_path: string;
  };
  orphanDispatch.artifact_path = "tasks/dispatch/orphan_same_fields_candidate_runtime.r1.json";
  await writeFile(
    path.join(state.runsRoot, state.runId, orphanDispatch.artifact_path),
    `${JSON.stringify(orphanDispatch, null, 2)}\n`,
  );
  assert.ok(!state.bundle.documents.some((entry) => entry.path === orphanDispatch.artifact_path));

  const context = await state.store.buildValidationContext(state.runId, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [{ path: task.artifact_path, document: task as unknown as Record<string, unknown> }],
  });
  const selectedPaths = context.bundle.documents.map((entry) => entry.path).sort();
  assert.ok(selectedPaths.includes(dispatch.artifact_path));
  assert.ok(!selectedPaths.includes(orphanDispatch.artifact_path));
});

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
      acquisitionGoal: "SYNTHETIC materialization substrate; not Evidence.",
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
      acquisitionGoal: "SYNTHETIC materialization substrate; not Evidence.",
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
  return prepareRunFromBundle(context, {
    root,
    runsRoot,
    runId,
    validator,
    bundle,
    store,
    publishSetupArtifacts: true,
  });
}

async function prepareRunFromBundle(
  _context: TestContext,
  input: {
    readonly root: string;
    readonly runsRoot: string;
    readonly runId: string;
    readonly validator: Awaited<ReturnType<typeof createArtifactValidator>>;
    readonly bundle: Awaited<ReturnType<typeof createDiscoveryRuntimeFixture>>;
    readonly store: RunStore;
    readonly publishSetupArtifacts: boolean;
  },
) {
  const { root, runsRoot, runId, validator, bundle, store } = input;
  await publishInitialPlanBundle(
    store,
    runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  );
  if (input.publishSetupArtifacts) {
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
  }
  return { root, runsRoot, runId, validator, bundle, store };
}

async function prepareCleanPlanRun(context: TestContext, suffix: string) {
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
      acquisitionGoal: "SYNTHETIC materialization substrate; not Evidence.",
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
      acquisitionGoal: "SYNTHETIC materialization substrate; not Evidence.",
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
  return prepareRunFromBundle(context, {
    root,
    runsRoot,
    runId,
    validator,
    bundle,
    store,
    publishSetupArtifacts: false,
  });
}

async function prepareGenerationPlanBundle(
  context: TestContext,
  suffix: string,
  generationOutputPath = "artifacts/discovery/generation/unit_seed_independent_demand.r1.json",
) {
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
      decisionGoal: "test generation Plan materialization",
      researchLanguage: "en-US",
    },
    createdAt,
  });
  const evidence = new EvidenceStore(runsRoot);
  const generation = (
    await evidence.record({
      runId,
      unitId: "unit_seed_independent_demand",
      acquisitionGoal: "SYNTHETIC generation substrate; not Evidence.",
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
      acquisitionGoal: "SYNTHETIC evaluation substrate; not Evidence.",
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
  const plan = fixtureEffective(bundle, G21_PLAN_REF);
  const planWave = (plan.waves as Record<string, unknown>[])[0];
  assert.ok(planWave);
  const generationUnit = (planWave.units as Record<string, unknown>[]).find(
    (unit) => unit.unit_id === "unit_seed_independent_demand",
  );
  assert.ok(generationUnit);
  generationUnit.output_path = generationOutputPath;
  generationUnit.required_artifact_schema = "startup_opportunity.discovery_generation_result.v1";
  const planEnvelope = fixtureEnvelope(bundle, G21_PLAN_REF);
  (planEnvelope as { content_hash: string }).content_hash = canonicalContentHash(plan);
  return { root, runsRoot, runId, validator, bundle, store };
}

async function prepareGenerationPlanRun(context: TestContext, suffix: string) {
  const state = await prepareGenerationPlanBundle(context, suffix);
  return prepareRunFromBundle(context, {
    ...state,
    publishSetupArtifacts: false,
  });
}

function convertGenerationUnitToAdversarialReview(
  bundle: Awaited<ReturnType<typeof createDiscoveryRuntimeFixture>>,
  outputPath = "artifacts/reviews/adversarial-review.json",
): void {
  const plan = fixtureEffective(bundle, G21_PLAN_REF);
  const planWave = (plan.waves as Record<string, unknown>[])[0];
  assert.ok(planWave);
  const unit = (planWave.units as Record<string, unknown>[]).find(
    (candidate) => candidate.unit_id === "unit_seed_independent_demand",
  );
  assert.ok(unit);
  Object.assign(unit, {
    unit_type: "adversarial_review",
    agent_role: "adversarial-reviewer",
    output_path: outputPath,
    required_artifact_schema: "startup_opportunity.discovery_adversarial_review.current",
    required_outputs: ["startup_opportunity.discovery_adversarial_review.current"],
  });
  const planEnvelope = fixtureEnvelope(bundle, G21_PLAN_REF);
  (planEnvelope as { content_hash: string }).content_hash = canonicalContentHash(plan);
}

async function prepareAdversarialReviewPlanRun(context: TestContext, suffix: string) {
  const state = await prepareGenerationPlanBundle(context, suffix);
  convertGenerationUnitToAdversarialReview(state.bundle);
  return prepareRunFromBundle(context, {
    ...state,
    publishSetupArtifacts: false,
  });
}

const retainedDeepReviewUnitId = "unit_retained_deep_review";
const retainedDeepReviewWaveId = "wave_retained_scope_synthetic";

function retainedDeepReviewPlanWave(): Record<string, unknown> {
  return {
    wave_id: retainedDeepReviewWaveId,
    depends_on: ["wave_discovery_synthetic"],
    units: [
      {
        unit_id: retainedDeepReviewUnitId,
        unit_type: "bounded_domain_research",
        lane_kind: "retained_candidate_deep_review",
        plan_disposition: "enabled",
        priority_band: "high",
        attempt: 1,
        supersedes_unit_ref: null,
        research_goal:
          "SYNTHETIC retained-candidate deep review Unit; no external research is performed.",
        input_refs: [G21_SCOPE_REF],
        agent_role: "lane-researcher",
        output_path: `artifacts/discovery/lanes/${retainedDeepReviewUnitId}.attempt-1.json`,
        required_artifact_schema: "startup_opportunity.discovery_lane_result.v1",
        source_preferences: ["SYNTHETIC retained-candidate source preference."],
        required_outputs: ["startup_opportunity.discovery_lane_result.v1"],
        stop_conditions: ["SYNTHETIC retained-candidate stop condition."],
      },
    ],
  };
}

async function prepareRunThroughDiscoveryFanIn(context: TestContext, suffix: string) {
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
      decisionGoal: "test retained-scope formal materialization",
      researchLanguage: "en-US",
    },
    createdAt,
  });
  const evidence = new EvidenceStore(runsRoot);
  const generation = (
    await evidence.record({
      runId,
      unitId: "unit_seed_independent_demand",
      acquisitionGoal: "SYNTHETIC retained-scope substrate; not Evidence.",
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
      acquisitionGoal: "SYNTHETIC retained-scope substrate; not Evidence.",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:${suffix}-evaluation`,
      },
      rawContent: "SYNTHETIC evaluation bytes; not Evidence.",
      recordedAt: createdAt,
    })
  ).record;
  const bundle = await createDiscoverySynthesisFixture(runId, { generation, evaluation }, [
    retainedDeepReviewPlanWave(),
  ]);
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
    envelopes: envelopesByType(bundle, "startup_opportunity.discovery_candidate.v1").filter(
      (candidate) => candidate.document.revision === 1,
    ),
  });
  const candidateRuntime = discoveryWaveEnvelopes(
    bundle,
    runId,
    "startup_opportunity.research_task.discovery_candidate.current",
    1,
    "candidate_runtime",
  );
  await publishRuntimeEnvelopesAsFormalStage(
    { runsRoot, runId, validator },
    candidateRuntime,
    "request_g2_3_summary_candidate_wave",
  );
  const candidateDispatch = candidateRuntime.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(candidateDispatch);
  await registerAllDispatchLaunches(
    runsRoot,
    validator,
    runId,
    candidateDispatch,
    "launch_retained_scope_candidate",
  );
  await store.publishArtifactBundle({
    runId,
    envelopes: envelopesByType(
      bundle,
      "startup_opportunity.evidence.discovery_candidate.current",
      "startup_opportunity.claim.discovery_candidate.current",
      "startup_opportunity.finding.discovery_candidate.current",
      "startup_opportunity.insight.discovery_candidate.current",
      "startup_opportunity.judgment_assessment.discovery_candidate.current",
      "startup_opportunity.source_manifest.discovery_candidate.current",
    ),
  });
  await store.publishArtifactBundle({
    runId,
    envelopes: [
      runtimeEnvelope(bundle, G22_DEMAND_R2),
      ...envelopesByType(
        bundle,
        "startup_opportunity.discovery_lane_result.v1",
        "startup_opportunity.concrete_pre_candidate.v1",
        "startup_opportunity.pre_candidate_relation.v1",
      ),
    ],
  });
  await store.publishArtifact({
    runId,
    envelope: runtimeEnvelope(bundle, G22_FAN_IN),
  });
  await store.confirmPreCandidates({
    runId,
    expectedFanInRef: G22_FAN_IN,
    expectedFanInHash: runtimeEnvelope(bundle, G22_FAN_IN).content_hash,
    selectedPreCandidateRefs: [G22_RETAINED_PRE_CANDIDATE],
    nextAction: "proceed_with_selected",
    userConfirmationAttestation:
      "SYNTHETIC caller attests that the user selected the retained pre-candidate for continuation.",
    confirmedAt: "2026-07-27T19:59:00Z",
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

function generationWaveRequest(
  runId: string,
  task: Record<string, unknown>,
  operation: "validate_only" | "publish" = "validate_only",
): Record<string, unknown> {
  const commercial = task.commercial_research_requirements as Record<string, unknown>;
  return {
    schema_version: "startup_opportunity.formal_stage_materialization_request.current",
    request_id: "formal_generation_wave_request",
    run_id: runId,
    operation,
    created_at: createdAt,
    stage_kind: "discovery_wave",
    wave: {
      wave_id: "wave_discovery_synthetic",
      stage_id: "stage_generation",
      stage_kind: "discovery_generation",
      unit_ids: ["unit_seed_independent_demand"],
      lanes: [
        {
          unit_id: "unit_seed_independent_demand",
          lane_role: "opportunity",
          candidate_scope: { kind: "none", candidate_refs: [] },
          incumbent_response_assignment: {
            analysis_depth: "not_assigned",
            assignment_role: "none",
            subject_refs: [],
            rationale: "Candidate generation does not own incumbent response analysis.",
          },
          reporting_dimensions: ["user_language"],
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
            target_candidate_refs: [],
            source_phase: "candidate_generation",
            required_source_group_ids: ["source_group_generation"],
            required_stances: ["support", "oppose"],
            stop_conditions: ["SYNTHETIC bounded generation stop condition."],
            execution_contract: task.execution_contract,
          },
        },
      ],
      research_depth: "quick",
      total_time_budget_minutes: 10,
      resource_allocation: commercial.resource_allocation,
      gate_before: null,
      gate_after: "required",
      limitations: ["SYNTHETIC generation materialization test; no research was performed."],
    },
  };
}

function reviewExecutionContract(): Record<string, unknown> {
  return {
    formal_artifacts_explicit: true,
    harness_generated_research: false,
    harness_generated_judgment: false,
    agent_dispatch: false,
    hidden_llm_calls: false,
    network_research: false,
    external_validation: false,
    publication_implies_validation: false,
  };
}

function adversarialReviewWaveRequest(
  runId: string,
  task: Record<string, unknown>,
  operation: "validate_only" | "publish" = "validate_only",
): Record<string, unknown> {
  const commercial = task.commercial_research_requirements as Record<string, unknown>;
  const assignedPlanQuestionRefs = [
    `${G21_PLAN_REF}#question_demand`,
    `${G21_PLAN_REF}#question_counterfactual`,
  ];
  return {
    schema_version: "startup_opportunity.formal_stage_materialization_request.current",
    request_id: "formal_adversarial_review_wave_request",
    run_id: runId,
    operation,
    created_at: createdAt,
    stage_kind: "discovery_wave",
    wave: {
      wave_id: "wave_discovery_synthetic",
      stage_id: "stage_review",
      stage_kind: "review",
      unit_ids: ["unit_seed_independent_demand"],
      lanes: [
        {
          unit_id: "unit_seed_independent_demand",
          lane_role: "review",
          candidate_scope: { kind: "none", candidate_refs: [] },
          incumbent_response_assignment: {
            analysis_depth: "not_assigned",
            assignment_role: "none",
            subject_refs: [],
            rationale: "Plan-level adversarial review does not own incumbent response analysis.",
          },
          reporting_dimensions: ["adversarial_review"],
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
            source_phase: "adversarial_challenger",
            required_source_group_ids: ["source_group_adversarial_review"],
            assigned_plan_question_refs: assignedPlanQuestionRefs,
            required_stances: ["support", "oppose"],
            stop_conditions: ["SYNTHETIC bounded adversarial review stop condition."],
            execution_contract: reviewExecutionContract(),
          },
        },
      ],
      research_depth: "quick",
      total_time_budget_minutes: 10,
      resource_allocation: commercial.resource_allocation,
      gate_before: null,
      gate_after: "required",
      limitations: ["SYNTHETIC adversarial review materialization; no research was performed."],
    },
  };
}

function adversarialReviewResultStaging(
  runId: string,
  taskRef: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const reviewedPlanQuestionRefs = [
    `${G21_PLAN_REF}#question_demand`,
    `${G21_PLAN_REF}#question_counterfactual`,
  ];
  const reviewResult = {
    status: "partial",
    review_subject: {
      subject_kind: "plan_level_discovery",
      target_candidate_refs: [],
      target_opportunity_refs: [],
      reviewed_plan_question_refs: reviewedPlanQuestionRefs,
    },
    review_findings: [
      {
        finding_id: "finding_review_support_partial",
        stance: "support",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "partial",
        summary:
          "SYNTHETIC support remains partial; the review preserves weak material without upgrading confidence.",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: ["Synthetic fixture has no external source authority."],
      },
      {
        finding_id: "finding_review_oppose_unknown",
        stance: "oppose",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "unknown",
        summary:
          "SYNTHETIC opposing material remains unknown and is visible as review context only.",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: ["No claim of absent evidence is made."],
      },
      {
        finding_id: "finding_review_background_no_evidence",
        stance: "background",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "no_evidence_found",
        summary: "SYNTHETIC background search found no usable material within the bounded fixture.",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: ["No background source is promoted to Evidence."],
      },
    ],
    material_visibility: {
      supporting_refs: [],
      opposing_refs: [],
      background_refs: [],
      contradictory_refs: [],
      unknown_refs: [],
    },
    decision_relevant_gaps: [
      {
        gap_id: "gap_review_insufficient_counterevidence",
        state: "insufficient_evidence",
        summary:
          "SYNTHETIC counterevidence remains insufficient and should not become a ranking or gate authority.",
        basis_refs: [],
        requires_plan_adaptation: false,
        recommended_follow_up: "manual_review",
        limitations: ["A main-agent adaptation decision would be required to change the Plan."],
      },
      {
        gap_id: "gap_review_inferred_background",
        state: "inferred",
        summary: "SYNTHETIC background inference is preserved separately from unknown.",
        basis_refs: [],
        requires_plan_adaptation: false,
        recommended_follow_up: "no_action",
        limitations: ["Inference is context only."],
      },
    ],
    search_closure: {
      status: "partial",
      acquisition_routes_attempted: ["user_provided"],
      adopted_source_refs: [],
      unresolved_gaps: ["Opposing and background material remain incomplete."],
      stop_reason: "The bounded synthetic review fixture reached its stop condition.",
    },
    authority_boundary: {
      reference_only: true,
      not_gate: true,
      not_ranking: true,
      not_elimination: true,
      not_confidence_ceiling: true,
      mutates_current_plan: false,
      rewrites_report: false,
    },
    valid_as_of: "2026-08-19",
    limitations: ["Discovery adversarial review is reference-only and non-gating."],
    ...overrides,
  };
  return {
    schema_version: "startup_opportunity.lane_staging_document.current",
    staging_id: "staging_adversarial_review_result",
    run_id: runId,
    task_ref: taskRef,
    created_at: "2026-08-19T09:04:00Z",
    producer_role: "adversarial_reviewer",
    operation: "validate_only",
    evidence_receipt_refs: [],
    delivery_contract: {
      search_closure: {
        status: "partial",
        acquisition_routes_attempted: ["user_provided"],
        adopted_source_refs: [],
        unresolved_gaps: ["Opposing and background material remain incomplete."],
        stop_reason: "The bounded synthetic review fixture reached its stop condition.",
      },
    },
    agent_documents: [{ artifact_family: "lane_result", document: reviewResult }],
  };
}

function setupRequest(
  runId: string,
  bundle: Awaited<ReturnType<typeof createDiscoveryRuntimeFixture>>,
  operation: "validate_only" | "publish" = "validate_only",
): Record<string, unknown> {
  const seed = fixtureEffective(bundle, G21_SEED_REF);
  const opportunityMap = fixtureEffective(bundle, G21_OPPORTUNITY_REF);
  const solutionMap = fixtureEffective(bundle, G21_SOLUTION_REF);
  const candidate = fixtureEffective(bundle, G22_DEMAND_R1);
  return {
    schema_version: "startup_opportunity.formal_stage_materialization_request.current",
    request_id: "formal_setup_request",
    run_id: runId,
    operation,
    created_at: createdAt,
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

test("public Plan publication accepts generation Artifact revision identity and materializes the wave", async (t) => {
  const state = await prepareGenerationPlanRun(t, "generation-plan-publication");
  const task = fixtureEffective(state.bundle, G22_GENERATION_TASK);
  const request = generationWaveRequest(state.runId, task);
  const materializer = new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const runRoot = path.join(state.runsRoot, state.runId);
  const before = await snapshotTree(runRoot);
  const validated = await materializer.materialize(request);
  assert.equal(validated.status, "validated");
  assert.deepEqual(await snapshotTree(runRoot), before);
  const published = await materializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: validated.compilation.publication_plan,
  });
  assert.equal(published.status, "published");
  const envelopes = published.compilation.compiled_envelopes;
  const taskEnvelope = envelopes.find(
    (entry) =>
      entry.artifact_type === "startup_opportunity.research_task.discovery_candidate.current",
  );
  const dispatchEnvelope = envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(taskEnvelope);
  assert.ok(dispatchEnvelope);
  assert.equal(taskEnvelope.document.attempt, 1);
  assert.equal(
    taskEnvelope.document.allowed_output_path,
    "artifacts/discovery/generation/unit_seed_independent_demand.r1.json",
  );
  assert.deepEqual(taskEnvelope.document.target_candidate_refs, []);
  assert.equal(
    taskEnvelope.document.required_artifact_schema,
    "startup_opportunity.discovery_generation_result.v1",
  );
  assert.equal(
    (dispatchEnvelope.document.tasks as Record<string, unknown>[])[0]?.allowed_output_path,
    taskEnvelope.document.allowed_output_path,
  );
});

test("startup launch observability remains diagnostic and separate from Evidence authority", async (t) => {
  const state = await prepareGenerationPlanRun(t, "startup-observability");
  const task = fixtureEffective(state.bundle, G22_GENERATION_TASK);
  const materializer = new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const request = generationWaveRequest(state.runId, task);
  const validated = await materializer.materialize(request);
  const published = await materializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: validated.compilation.publication_plan,
  });
  const dispatchEnvelope = published.compilation.compiled_envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(dispatchEnvelope);

  const beforeLaunch = await state.store.status(state.runId);
  const beforeMilestones = beforeLaunch.observability.startupMilestones;
  assert.equal(beforeMilestones.scopeConfirmed.state, "observed");
  assert.equal(beforeMilestones.firstPlanPublished.state, "observed");
  assert.equal(beforeMilestones.firstDispatchPublished.state, "observed");
  assert.equal(beforeMilestones.firstEvidenceRecorded.state, "observed");
  assert.equal(beforeMilestones.firstLaunchRegistered.state, "not_observed");
  assert.equal(beforeMilestones.preflightFailure.state, "not_observed");

  await registerAllDispatchLaunches(
    state.runsRoot,
    state.validator,
    state.runId,
    dispatchEnvelope,
    "launch_startup_observability",
  );
  const afterLaunch = await state.store.status(state.runId);
  const afterMilestones = afterLaunch.observability.startupMilestones;
  assert.equal(afterMilestones.firstLaunchRegistered.state, "observed");
  for (const milestone of Object.values(afterMilestones)) {
    assert.equal(milestone.evidenceAuthority, false);
    assert.equal(milestone.researchConclusionAuthority, false);
  }

  const evidenceRecords = await new EvidenceStore(state.runsRoot).listRecords(state.runId);
  const evidenceJson = JSON.stringify(evidenceRecords);
  assert.equal(evidenceJson.includes("startupMilestones"), false);
  assert.equal(evidenceJson.includes("firstPlanPublished"), false);
  assert.equal(evidenceJson.includes("researchConclusionAuthority"), false);

  const failureState = await prepareGenerationPlanBundle(
    t,
    "startup-observability-preflight",
    "artifacts/discovery/generation/unit_seed_independent_demand.attempt-1.json",
  );
  const failureEnvelopes = await initialPlanBundleEnvelopes(
    failureState.store,
    failureState.runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(failureState.bundle, ref)),
  );
  const failureRunRoot = path.join(failureState.runsRoot, failureState.runId);
  const beforeFailure = await snapshotTree(failureRunRoot);
  await assert.rejects(
    new DeclarativeRuntimeCompiler(
      failureState.runsRoot,
      failureState.validator,
      repositoryRoot,
    ).compile({
      schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
      request_id: "startup_observability_preflight_failure",
      run_id: failureState.runId,
      operation: "publish",
      created_at: createdAt,
      artifacts: failureEnvelopes.map((envelope) => ({
        artifact_type: envelope.artifact_type,
        artifact_path: envelope.artifact_path,
        producer_role: envelope.producer_role,
        input_refs: envelope.input_refs,
        document: envelope.document,
      })),
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "runtime.compilation_plan_preflight_failed",
  );
  const afterFailure = await snapshotTree(failureRunRoot);
  const withoutObservationLogs = (snapshot: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(snapshot).filter(
        ([name]) => !name.startsWith("events.jsonl") && !name.startsWith(".store/operations/log-"),
      ),
    );
  assert.deepEqual(withoutObservationLogs(afterFailure), withoutObservationLogs(beforeFailure));
  const failureStatus = await failureState.store.status(failureState.runId);
  assert.equal(failureStatus.observability.startupMilestones.preflightFailure.state, "observed");
  assert.equal(
    failureStatus.observability.startupMilestones.preflightFailure.errorCode,
    "runtime.compilation_plan_preflight_failed",
  );
  assert.equal(
    failureStatus.observability.startupMilestones.preflightFailure.evidenceAuthority,
    false,
  );
  assert.equal(
    failureStatus.observability.startupMilestones.preflightFailure.researchConclusionAuthority,
    false,
  );
});

test("startup milestones require matching publication commits and true Plan preflight failures", async (t) => {
  const orphanPlanState = await prepareGenerationPlanBundle(t, "startup-orphan-plan");
  const orphanPlanEnvelope = fixtureEnvelope(orphanPlanState.bundle, G21_PLAN_REF);
  await mkdir(path.join(orphanPlanState.runsRoot, orphanPlanState.runId, "plans"), {
    recursive: true,
  });
  await writeFile(
    path.join(orphanPlanState.runsRoot, orphanPlanState.runId, orphanPlanEnvelope.artifact_path),
    `${JSON.stringify(orphanPlanEnvelope, null, 2)}\n`,
  );
  const orphanPlanStatus = await orphanPlanState.store.status(orphanPlanState.runId);
  assert.equal(
    orphanPlanStatus.observability.startupMilestones.firstPlanPublished.state,
    "not_observed",
  );

  const state = await prepareGenerationPlanRun(t, "startup-orphan-dispatch-launch");
  const task = fixtureEffective(state.bundle, G22_GENERATION_TASK);
  const materializer = new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const request = generationWaveRequest(state.runId, task);
  const validated = await materializer.materialize(request);
  const dispatchEnvelope = validated.compilation.compiled_envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(dispatchEnvelope);
  await mkdir(
    path.dirname(path.join(state.runsRoot, state.runId, dispatchEnvelope.artifact_path)),
    {
      recursive: true,
    },
  );
  await writeFile(
    path.join(state.runsRoot, state.runId, dispatchEnvelope.artifact_path),
    `${JSON.stringify(dispatchEnvelope, null, 2)}\n`,
  );
  const launchDocument = {
    schema_version: "startup_opportunity.dispatch_launch_registration.v1",
    registration_id: "orphan_launch_registration",
    run_id: state.runId,
    dispatch_ref: dispatchEnvelope.artifact_path,
    dispatch_hash: dispatchEnvelope.content_hash,
    request_hash: `sha256:${"1".repeat(64)}`,
    registered_at: "2026-08-19T09:30:00Z",
    registrations: [
      {
        unit_id: "unit_seed_independent_demand",
        task_ref: `${dispatchEnvelope.artifact_path}#task_unit_seed_independent_demand_attempt_1`,
        task_id: "task_unit_seed_independent_demand_attempt_1",
        attempt: 1,
        execution_attempt_id: "exec_orphan_launch",
        lifecycle_ref: `artifacts/runtime/lane-lifecycle/lifecycle_${"1".repeat(32)}.r1.json`,
        lifecycle_hash: `sha256:${"2".repeat(64)}`,
      },
    ],
    limitations: [
      "SYNTHETIC orphan launch registration is deliberately uncommitted and not authoritative.",
    ],
  };
  const launchEnvelope = {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: "startup_opportunity.dispatch_launch_registration.v1",
    artifact_path: "artifacts/runtime/dispatch-launch-registrations/orphan-launch.json",
    run_id: state.runId,
    created_at: "2026-08-19T09:30:00Z",
    producer_role: "harness",
    input_refs: [dispatchEnvelope.artifact_path],
    content_hash: canonicalContentHash(launchDocument),
    document: launchDocument,
  };
  await mkdir(path.dirname(path.join(state.runsRoot, state.runId, launchEnvelope.artifact_path)), {
    recursive: true,
  });
  await writeFile(
    path.join(state.runsRoot, state.runId, launchEnvelope.artifact_path),
    `${JSON.stringify(launchEnvelope, null, 2)}\n`,
  );
  const orphanRuntimeStatus = await state.store.status(state.runId);
  assert.equal(
    orphanRuntimeStatus.observability.startupMilestones.firstDispatchPublished.state,
    "not_observed",
  );
  assert.equal(
    orphanRuntimeStatus.observability.startupMilestones.firstLaunchRegistered.state,
    "not_observed",
  );

  await state.store.recordRuntimeOperationObservation({
    runId: state.runId,
    operationId: "generic_validation_failure",
    startedAt: "2026-08-19T09:31:00Z",
    completedAt: "2026-08-19T09:31:01Z",
    durationMs: 1,
    outcome: "failed",
    failureClassification: "validation_failed",
    errorCode: "runtime.publication_plan_stale",
    artifactRefs: [],
  });
  const genericFailureStatus = await state.store.status(state.runId);
  assert.equal(
    genericFailureStatus.observability.startupMilestones.preflightFailure.state,
    "not_observed",
  );

  await state.store.recordRuntimeOperationObservation({
    runId: state.runId,
    operationId: "true_plan_preflight_failure",
    startedAt: "2026-08-19T09:32:00Z",
    completedAt: "2026-08-19T09:32:01Z",
    durationMs: 1,
    outcome: "failed",
    failureClassification: "validation_failed",
    errorCode: "runtime.compilation_plan_preflight_failed",
    artifactRefs: [],
  });
  const truePreflightStatus = await state.store.status(state.runId);
  assert.equal(
    truePreflightStatus.observability.startupMilestones.preflightFailure.state,
    "observed",
  );
  assert.equal(
    truePreflightStatus.observability.startupMilestones.preflightFailure.errorCode,
    "runtime.compilation_plan_preflight_failed",
  );
});

test("public initial Plan publication rejects obsolete generation attempt paths before writes", async (t) => {
  const state = await prepareGenerationPlanBundle(
    t,
    "generation-plan-obsolete-path",
    "artifacts/discovery/generation/unit_seed_independent_demand.attempt-1.json",
  );
  const runRoot = path.join(state.runsRoot, state.runId);
  const envelopes = await initialPlanBundleEnvelopes(
    state.store,
    state.runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
  );
  const before = await snapshotTree(runRoot);
  await assert.rejects(
    state.store.publishArtifactBundle({ runId: state.runId, envelopes }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "artifact.planning_preflight_failed" &&
      JSON.stringify(error.details).includes("plan.output_path_contract_mismatch"),
  );
  assert.deepEqual(await snapshotTree(runRoot), before);
});

test("public initial Plan publication rejects unsupported launch output schemas before writes", async (t) => {
  const state = await prepareGenerationPlanBundle(t, "generation-plan-unsupported-schema");
  const plan = fixtureEffective(state.bundle, G21_PLAN_REF);
  const generationWave = (plan.waves as Record<string, unknown>[])[0];
  assert.ok(generationWave);
  const generationUnit = (generationWave.units as Record<string, unknown>[]).find(
    (unit) => unit.unit_id === "unit_seed_independent_demand",
  );
  assert.ok(generationUnit);
  generationUnit.required_artifact_schema = "startup_opportunity.unsupported_runtime_result.v1";
  generationUnit.output_path =
    "artifacts/discovery/generation/unit_seed_independent_demand.r1.json";
  const planEnvelope = fixtureEnvelope(state.bundle, G21_PLAN_REF);
  (planEnvelope as { content_hash: string }).content_hash = canonicalContentHash(plan);
  const runRoot = path.join(state.runsRoot, state.runId);
  const envelopes = await initialPlanBundleEnvelopes(
    state.store,
    state.runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
  );
  const before = await snapshotTree(runRoot);
  await assert.rejects(
    state.store.publishArtifactBundle({ runId: state.runId, envelopes }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "artifact.planning_preflight_failed" &&
      JSON.stringify(error.details).includes("plan.launch_unit_output_unsupported"),
  );
  assert.deepEqual(await snapshotTree(runRoot), before);
});

test("public initial Plan publication accepts policy-supported adversarial review topology and rejects drift", async (t) => {
  const valid = await prepareGenerationPlanBundle(t, "adversarial-review-plan");
  const validPlan = fixtureEffective(valid.bundle, G21_PLAN_REF);
  const validWave = (validPlan.waves as Record<string, unknown>[])[0];
  assert.ok(validWave);
  const adversarialUnit = (validWave.units as Record<string, unknown>[]).find(
    (unit) => unit.unit_id === "unit_seed_independent_demand",
  );
  assert.ok(adversarialUnit);
  Object.assign(adversarialUnit, {
    unit_type: "adversarial_review",
    agent_role: "adversarial-reviewer",
    output_path: "artifacts/reviews/adversarial-review.json",
    required_artifact_schema: "startup_opportunity.discovery_adversarial_review.current",
    required_outputs: ["startup_opportunity.discovery_adversarial_review.current"],
  });
  const validPlanEnvelope = fixtureEnvelope(valid.bundle, G21_PLAN_REF);
  (validPlanEnvelope as { content_hash: string }).content_hash = canonicalContentHash(validPlan);
  const published = await publishInitialPlanBundle(
    valid.store,
    valid.runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(valid.bundle, ref)),
  );
  assert.equal(published.status, "published");

  const invalid = await prepareGenerationPlanBundle(t, "adversarial-review-plan-drift");
  const invalidPlan = fixtureEffective(invalid.bundle, G21_PLAN_REF);
  const invalidWave = (invalidPlan.waves as Record<string, unknown>[])[0];
  assert.ok(invalidWave);
  const invalidUnit = (invalidWave.units as Record<string, unknown>[]).find(
    (unit) => unit.unit_id === "unit_seed_independent_demand",
  );
  assert.ok(invalidUnit);
  Object.assign(invalidUnit, {
    unit_type: "adversarial_review",
    agent_role: "lane-researcher",
    output_path: "artifacts/reviews/adversarial-review.json",
    required_artifact_schema: "startup_opportunity.discovery_adversarial_review.current",
    required_outputs: ["startup_opportunity.discovery_adversarial_review.current"],
  });
  const invalidPlanEnvelope = fixtureEnvelope(invalid.bundle, G21_PLAN_REF);
  (invalidPlanEnvelope as { content_hash: string }).content_hash =
    canonicalContentHash(invalidPlan);
  const before = await snapshotTree(path.join(invalid.runsRoot, invalid.runId));
  await assert.rejects(
    publishInitialPlanBundle(
      invalid.store,
      invalid.runId,
      G21_CORE_REFS.map((ref) => fixtureEnvelope(invalid.bundle, ref)),
    ),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "artifact.planning_preflight_failed" &&
      (JSON.stringify(error.details).includes("plan.launch_agent_role_unsupported") ||
        JSON.stringify(error.details).includes("contract.unit_tuple_not_allowed")),
  );
  assert.deepEqual(await snapshotTree(path.join(invalid.runsRoot, invalid.runId)), before);
});

test("public adversarial review Plan rejects review output path drift before writes", async (t) => {
  const state = await prepareGenerationPlanBundle(t, "adversarial-review-plan-path-drift");
  convertGenerationUnitToAdversarialReview(
    state.bundle,
    "artifacts/discovery/lanes/adversarial-review.attempt-1.json",
  );
  const before = await snapshotTree(path.join(state.runsRoot, state.runId));
  await assert.rejects(
    publishInitialPlanBundle(
      state.store,
      state.runId,
      G21_CORE_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
    ),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "artifact.planning_preflight_failed" &&
      JSON.stringify(error.details).includes("plan.launch_output_path_contract_mismatch"),
  );
  assert.deepEqual(await snapshotTree(path.join(state.runsRoot, state.runId)), before);
});

test("policy-supported adversarial review Unit materializes a launchable review wave", async (t) => {
  const state = await prepareAdversarialReviewPlanRun(t, "adversarial-review-materialized");
  const taskTemplate = fixtureEffective(state.bundle, G22_EVALUATION_TASK);
  const request = adversarialReviewWaveRequest(state.runId, taskTemplate);
  const materializer = new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const runRoot = path.join(state.runsRoot, state.runId);
  const before = await snapshotTree(runRoot);
  const validated = await materializer.materialize(request);
  assert.equal(validated.status, "validated");
  assert.deepEqual(await snapshotTree(runRoot), before);
  assert.deepEqual(validated.artifacts.map((entry) => entry.artifact_type).sort(), [
    "startup_opportunity.dispatch_batch.discovery.current",
    "startup_opportunity.research_execution_plan.discovery.current",
    "startup_opportunity.research_task.discovery_review.current",
  ]);
  assert.equal(validated.compilation.dispatch_launch_checklists.length, 1);
  const prePublishChecklist = validated.compilation.dispatch_launch_checklists[0];
  assert.ok(prePublishChecklist);
  assert.equal(prePublishChecklist.status, "open");
  assert.deepEqual(
    prePublishChecklist.checklist.map((entry) => ({
      unit_id: entry.unit_id,
      allowed_output_path: entry.allowed_output_path,
      required_artifact_schema: entry.required_artifact_schema,
    })),
    [
      {
        unit_id: "unit_seed_independent_demand",
        allowed_output_path: "artifacts/reviews/adversarial-review.json",
        required_artifact_schema: "startup_opportunity.discovery_adversarial_review.current",
      },
    ],
  );

  const published = await materializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: validated.compilation.publication_plan,
  });
  assert.equal(published.status, "published");
  const envelopes = published.compilation.compiled_envelopes;
  const reviewTask = envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.research_task.discovery_review.current",
  );
  const execution = envelopes.find(
    (entry) =>
      entry.artifact_type === "startup_opportunity.research_execution_plan.discovery.current",
  );
  const dispatch = envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(reviewTask && execution && dispatch);
  assert.equal(reviewTask.producer_role, "main_agent");
  assert.equal(
    reviewTask.artifact_path,
    "tasks/discovery/reviews/unit_seed_independent_demand.attempt-1.json",
  );
  assert.equal(reviewTask.document.phase, "review");
  assert.equal(reviewTask.document.agent_role, "adversarial-reviewer");
  assert.equal(reviewTask.document.unit_type, "adversarial_review");
  assert.equal(
    reviewTask.document.allowed_output_path,
    "artifacts/reviews/adversarial-review.json",
  );
  assert.equal(
    reviewTask.document.required_artifact_schema,
    "startup_opportunity.discovery_adversarial_review.current",
  );
  assert.equal(
    state.validator.validateDocument(reviewTask.document, reviewTask.artifact_path).valid,
    true,
  );
  const executionContract = reviewTask.document.execution_contract as Record<string, unknown>;
  assert.equal(executionContract.hidden_llm_calls, false);
  assert.equal(executionContract.network_research, false);
  assert.equal(executionContract.harness_generated_research, false);
  assert.equal(executionContract.agent_dispatch, false);

  const stage = (execution.document.stages as Record<string, unknown>[])[0];
  const lane = (stage?.lanes as Record<string, unknown>[] | undefined)?.[0];
  const dispatchTask = (dispatch.document.tasks as Record<string, unknown>[])[0];
  assert.equal(stage?.stage_kind, "review");
  assert.equal(lane?.lane_role, "review");
  assert.deepEqual(lane?.candidate_scope, { kind: "none", candidate_refs: [] });
  assert.equal(lane?.submission_schema, "startup_opportunity.discovery_adversarial_review.current");
  assert.equal(dispatchTask?.lane_role, "review");
  assert.equal(
    dispatchTask?.required_artifact_schema,
    reviewTask.document.required_artifact_schema,
  );
  assert.equal(dispatchTask?.allowed_output_path, reviewTask.document.allowed_output_path);
  assert.equal(dispatch.document.agent_dispatch_performed, false);

  const registry = new DispatchLaunchRegistry(state.runsRoot, state.validator, repositoryRoot);
  const launchCheck = await registry.check(
    state.runId,
    dispatch.artifact_path,
    dispatch.content_hash,
  );
  assert.equal(launchCheck.status, "open");
  assert.equal(
    launchCheck.checklist[0]?.task_ref,
    `${dispatch.artifact_path}#${dispatchTask?.task_id}`,
  );
  assert.equal(
    launchCheck.checklist[0]?.required_artifact_schema,
    "startup_opportunity.discovery_adversarial_review.current",
  );
});

test("public adversarial review result validates, publishes, replays, and closes the Unit", async (t) => {
  const state = await prepareAdversarialReviewPlanRun(t, "adversarial-review-delivery");
  const taskTemplate = fixtureEffective(state.bundle, G22_EVALUATION_TASK);
  const request = adversarialReviewWaveRequest(state.runId, taskTemplate);
  const stageMaterializer = new FormalStageMaterializer(
    state.runsRoot,
    state.validator,
    repositoryRoot,
  );
  const waveValidated = await stageMaterializer.materialize(request);
  const wavePublished = await stageMaterializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: waveValidated.compilation.publication_plan,
  });
  const reviewTask = wavePublished.compilation.compiled_envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.research_task.discovery_review.current",
  );
  assert.ok(reviewTask);

  const laneMaterializer = new LaneResultMaterializer(
    state.runsRoot,
    state.validator,
    repositoryRoot,
  );
  const staging = adversarialReviewResultStaging(state.runId, reviewTask.artifact_path);
  const runRoot = path.join(state.runsRoot, state.runId);
  const stagingPath = await writeLaneStagingFile(runRoot, reviewTask, staging);
  const beforeValidate = await snapshotTree(runRoot);
  const validated = await laneMaterializer.materializeFile(stagingPath);
  assert.equal(validated.status, "accepted");
  assert.equal(validated.compilation.status, "validated");
  assert.deepEqual(await snapshotTree(runRoot), beforeValidate);

  const reviewEnvelope = validated.compilation.compiled_envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.discovery_adversarial_review.current",
  );
  assert.ok(reviewEnvelope);
  assert.equal(reviewEnvelope.producer_role, "adversarial_reviewer");
  assert.equal(reviewEnvelope.artifact_path, "artifacts/reviews/adversarial-review.json");
  assert.equal(reviewEnvelope.document.owner_role, "adversarial-reviewer");
  assert.equal(reviewEnvelope.document.owned_output_path, reviewEnvelope.artifact_path);
  assert.equal(reviewEnvelope.document.task_ref, reviewTask.artifact_path);
  assert.equal(reviewEnvelope.document.task_hash, canonicalContentHash(reviewTask.document));
  assert.deepEqual(reviewEnvelope.document.required_stances, reviewTask.document.required_stances);
  const reviewSubject = reviewEnvelope.document.review_subject as Record<string, unknown>;
  assert.deepEqual(
    [...(reviewSubject.reviewed_plan_question_refs as string[])].sort(),
    [...(reviewTask.document.assigned_plan_question_refs as string[])].sort(),
  );
  assert.deepEqual(
    (reviewEnvelope.document.review_findings as Record<string, unknown>[]).map((finding) =>
      [...(finding.reviewed_plan_question_refs as string[])].sort(),
    ),
    [
      [...(reviewTask.document.assigned_plan_question_refs as string[])].sort(),
      [...(reviewTask.document.assigned_plan_question_refs as string[])].sort(),
      [...(reviewTask.document.assigned_plan_question_refs as string[])].sort(),
    ],
  );
  assert.equal(
    state.validator.validateDocument(reviewEnvelope.document, reviewEnvelope.artifact_path).valid,
    true,
  );
  assert.deepEqual(
    (reviewEnvelope.document.review_findings as Record<string, unknown>[]).map(
      (finding) => finding.evidence_state,
    ),
    ["partial", "unknown", "no_evidence_found"],
  );
  assert.deepEqual(
    (reviewEnvelope.document.decision_relevant_gaps as Record<string, unknown>[]).map(
      (gap) => gap.state,
    ),
    ["insufficient_evidence", "inferred"],
  );
  assert.deepEqual(reviewEnvelope.document.authority_boundary, {
    reference_only: true,
    not_gate: true,
    not_ranking: true,
    not_elimination: true,
    not_confidence_ceiling: true,
    mutates_current_plan: false,
    rewrites_report: false,
  });

  const publishStagingPath = await writeLaneStagingFile(runRoot, reviewTask, {
    ...staging,
    operation: "publish",
    publication_plan: validated.compilation.publication_plan,
  });
  const published = await laneMaterializer.materializeFile(publishStagingPath);
  assert.equal(published.status, "accepted");
  assert.equal(published.compilation.status, "published");
  const manifestAfterPublish = (await state.store.status(state.runId)).manifest;
  assert.ok(manifestAfterPublish.completed_units.includes("unit_seed_independent_demand"));
  assert.ok(!manifestAfterPublish.active_units.includes("unit_seed_independent_demand"));
  assert.ok(manifestAfterPublish.artifact_refs.includes(reviewEnvelope.artifact_path));
  const receipt = published.delivery_receipt.document;
  assert.deepEqual(receipt.assigned_scope, ["adversarial_review"]);
  assert.deepEqual(receipt.scope_coverage, [
    {
      scope_key: "adversarial_review",
      status: "partial",
      evidence_refs: [],
      notes: "Harness-derived from the exact formal Lane Result or Audit semantic closure.",
    },
  ]);
  const deliveryContract = staging.delivery_contract as Record<string, unknown>;
  assert.deepEqual(receipt.search_closure, deliveryContract.search_closure);
  assert.ok(
    (receipt.scope_formal_closure as Record<string, unknown>[]).some((entry) =>
      (entry.semantic_bindings as Record<string, unknown>[]).some(
        (binding) => binding.semantic_path === "/material_visibility",
      ),
    ),
  );

  const replayStagingPath = await writeLaneStagingFile(runRoot, reviewTask, {
    ...staging,
    operation: "publish",
    publication_plan: validated.compilation.publication_plan,
  });
  const replay = await laneMaterializer.materializeFile(replayStagingPath);
  assert.equal(replay.status, "accepted");
  assert.equal(replay.compilation.status, "idempotent_replay");
});

test("public adversarial review result rejects role, path, task, run, ref, hash, and shape drift before writes", async (t) => {
  const state = await prepareAdversarialReviewPlanRun(t, "adversarial-review-delivery-drift");
  const taskTemplate = fixtureEffective(state.bundle, G22_EVALUATION_TASK);
  const request = adversarialReviewWaveRequest(state.runId, taskTemplate);
  const stageMaterializer = new FormalStageMaterializer(
    state.runsRoot,
    state.validator,
    repositoryRoot,
  );
  const waveValidated = await stageMaterializer.materialize(request);
  const wavePublished = await stageMaterializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: waveValidated.compilation.publication_plan,
  });
  const reviewTask = wavePublished.compilation.compiled_envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.research_task.discovery_review.current",
  );
  assert.ok(reviewTask);
  const materializer = new LaneResultMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const runRoot = path.join(state.runsRoot, state.runId);
  const cases: readonly [string, (staging: Record<string, unknown>) => void, string][] = [
    [
      "empty-question-refs",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const subject = document.review_subject as Record<string, unknown>;
        subject.reviewed_plan_question_refs = [];
      },
      "lane_delivery.schema.minItems",
    ],
    [
      "empty-findings",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        document.review_findings = [];
      },
      "lane_delivery.schema.minItems",
    ],
    [
      "missing-stance",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        document.review_findings = (document.review_findings as Record<string, unknown>[]).filter(
          (finding) => finding.stance !== "oppose",
        );
      },
      "runtime.discovery_review_binding_mismatch",
    ],
    [
      "cross-question-stance-gap",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const [q1, q2] = [
          `${G21_PLAN_REF}#question_demand`,
          `${G21_PLAN_REF}#question_counterfactual`,
        ];
        document.review_findings = [
          {
            finding_id: "finding_support_q1_only",
            stance: "support",
            reviewed_plan_question_refs: [q1],
            evidence_state: "unknown",
            summary: "SYNTHETIC support covers only the first assigned question.",
            supporting_refs: [],
            opposing_refs: [],
            background_refs: [],
            contradictory_refs: [],
            unknown_refs: [],
            limitations: [],
          },
          {
            finding_id: "finding_oppose_q2_only",
            stance: "oppose",
            reviewed_plan_question_refs: [q2],
            evidence_state: "no_evidence_found",
            summary: "SYNTHETIC opposition covers only the second assigned question.",
            supporting_refs: [],
            opposing_refs: [],
            background_refs: [],
            contradictory_refs: [],
            unknown_refs: [],
            limitations: [],
          },
        ];
      },
      "runtime.discovery_review_binding_mismatch",
    ],
    [
      "subset-drift",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const subject = document.review_subject as Record<string, unknown>;
        subject.reviewed_plan_question_refs = [`${G21_PLAN_REF}#question_demand`];
      },
      "runtime.discovery_review_binding_mismatch",
    ],
    [
      "search-closure-status-drift",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const closure = document.search_closure as Record<string, unknown>;
        closure.status = "completed";
      },
      "lane_delivery.review_search_closure_mismatch",
    ],
    [
      "search-closure-route-drift",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const closure = document.search_closure as Record<string, unknown>;
        closure.acquisition_routes_attempted = ["public_web"];
      },
      "lane_delivery.review_search_closure_mismatch",
    ],
    [
      "search-closure-gap-drift",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const closure = document.search_closure as Record<string, unknown>;
        closure.unresolved_gaps = ["SYNTHETIC conflicting closure gap."];
      },
      "lane_delivery.review_search_closure_mismatch",
    ],
    [
      "search-closure-stop-reason-drift",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const closure = document.search_closure as Record<string, unknown>;
        closure.stop_reason = "SYNTHETIC conflicting stop reason.";
      },
      "lane_delivery.review_search_closure_mismatch",
    ],
    [
      "finding-material-visibility-omission",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const findings = document.review_findings as Record<string, unknown>[];
        assert.ok(findings[0]);
        findings[0].opposing_refs = [G22_FINDING];
      },
      "lane_delivery.review_material_visibility_mismatch",
    ],
    [
      "finding-material-visibility-wrong-role",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const findings = document.review_findings as Record<string, unknown>[];
        assert.ok(findings[0]);
        findings[0].opposing_refs = [G22_FINDING];
        const visibility = document.material_visibility as Record<string, unknown>;
        visibility.supporting_refs = [G22_FINDING];
        const closure = document.search_closure as Record<string, unknown>;
        closure.adopted_source_refs = [G22_FINDING];
        const delivery = staging.delivery_contract as Record<string, unknown>;
        const deliveryClosure = delivery.search_closure as Record<string, unknown>;
        deliveryClosure.adopted_source_refs = [G22_FINDING];
      },
      "lane_delivery.review_material_visibility_mismatch",
    ],
    [
      "self-reference-supporting-ref",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const findings = document.review_findings as Record<string, unknown>[];
        assert.ok(findings[0]);
        findings[0].supporting_refs = ["artifacts/reviews/adversarial-review.json"];
        const visibility = document.material_visibility as Record<string, unknown>;
        visibility.supporting_refs = ["artifacts/reviews/adversarial-review.json"];
        const closure = document.search_closure as Record<string, unknown>;
        closure.adopted_source_refs = ["artifacts/reviews/adversarial-review.json"];
        const delivery = staging.delivery_contract as Record<string, unknown>;
        const deliveryClosure = delivery.search_closure as Record<string, unknown>;
        deliveryClosure.adopted_source_refs = ["artifacts/reviews/adversarial-review.json"];
      },
      "lane_delivery.review_self_reference_forbidden",
    ],
    [
      "gap-basis-visibility-omission",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const gaps = document.decision_relevant_gaps as Record<string, unknown>[];
        assert.ok(gaps[0]);
        gaps[0].basis_refs = [G22_FINDING];
      },
      "lane_delivery.review_gap_basis_visibility_mismatch",
    ],
    [
      "gap-basis-self-reference",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const gaps = document.decision_relevant_gaps as Record<string, unknown>[];
        assert.ok(gaps[0]);
        gaps[0].basis_refs = ["artifacts/reviews/adversarial-review.json"];
        const visibility = document.material_visibility as Record<string, unknown>;
        visibility.background_refs = ["artifacts/reviews/adversarial-review.json"];
        const closure = document.search_closure as Record<string, unknown>;
        closure.adopted_source_refs = ["artifacts/reviews/adversarial-review.json"];
        const delivery = staging.delivery_contract as Record<string, unknown>;
        const deliveryClosure = delivery.search_closure as Record<string, unknown>;
        deliveryClosure.adopted_source_refs = ["artifacts/reviews/adversarial-review.json"];
      },
      "lane_delivery.review_self_reference_forbidden",
    ],
    [
      "gap-basis-missing-ref",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const missing = "artifacts/reviews/missing-adversarial-review.json";
        const gaps = document.decision_relevant_gaps as Record<string, unknown>[];
        assert.ok(gaps[0]);
        gaps[0].basis_refs = [missing];
        const visibility = document.material_visibility as Record<string, unknown>;
        visibility.background_refs = [missing];
        const closure = document.search_closure as Record<string, unknown>;
        closure.adopted_source_refs = [missing];
        const delivery = staging.delivery_contract as Record<string, unknown>;
        const deliveryClosure = delivery.search_closure as Record<string, unknown>;
        deliveryClosure.adopted_source_refs = [missing];
      },
      "reference.missing",
    ],
    [
      "adopted-source-refs-omission",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const visibility = document.material_visibility as Record<string, unknown>;
        visibility.supporting_refs = [G22_FINDING];
      },
      "lane_delivery.review_adopted_source_refs_mismatch",
    ],
    [
      "adopted-source-refs-addition",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const closure = document.search_closure as Record<string, unknown>;
        closure.adopted_source_refs = [G22_FINDING];
        const delivery = staging.delivery_contract as Record<string, unknown>;
        const deliveryClosure = delivery.search_closure as Record<string, unknown>;
        deliveryClosure.adopted_source_refs = [G22_FINDING];
      },
      "lane_delivery.review_adopted_source_refs_mismatch",
    ],
    [
      "adopted-source-refs-wrong-ref",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const missing = "artifacts/reviews/missing-adversarial-review.json";
        const visibility = document.material_visibility as Record<string, unknown>;
        visibility.supporting_refs = [missing];
        const closure = document.search_closure as Record<string, unknown>;
        closure.adopted_source_refs = [missing];
        const delivery = staging.delivery_contract as Record<string, unknown>;
        const deliveryClosure = delivery.search_closure as Record<string, unknown>;
        deliveryClosure.adopted_source_refs = [missing];
      },
      "reference.missing",
    ],
    [
      "completed-result-partial-closure",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        document.status = "completed";
      },
      "lane_delivery.review_status_search_closure_invalid",
    ],
    [
      "completed-result-with-unresolved-gaps",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const resultClosure = document.search_closure as Record<string, unknown>;
        resultClosure.status = "completed";
        const delivery = staging.delivery_contract as Record<string, unknown>;
        const deliveryClosure = delivery.search_closure as Record<string, unknown>;
        deliveryClosure.status = "completed";
      },
      "lane_delivery.review_status_search_closure_invalid",
    ],
    [
      "search-not-required-with-applicable-findings",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        document.status = "completed";
        const closure = document.search_closure as Record<string, unknown>;
        Object.assign(closure, {
          status: "search_not_required",
          acquisition_routes_attempted: ["none"],
          unresolved_gaps: [],
          stop_reason: "SYNTHETIC no-search status conflicts with applicable findings.",
        });
        const delivery = staging.delivery_contract as Record<string, unknown>;
        Object.assign(delivery.search_closure as Record<string, unknown>, closure);
      },
      "lane_delivery.review_status_search_closure_invalid",
    ],
    [
      "partial-result-with-no-search-route",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const closure = document.search_closure as Record<string, unknown>;
        Object.assign(closure, {
          acquisition_routes_attempted: ["none"],
          stop_reason: "SYNTHETIC partial outcome cannot claim no search was required.",
        });
        const delivery = staging.delivery_contract as Record<string, unknown>;
        Object.assign(delivery.search_closure as Record<string, unknown>, closure);
      },
      "lane_delivery.review_status_search_closure_invalid",
    ],
    [
      "role",
      (staging) => {
        staging.producer_role = "lane_researcher";
      },
      "lane_delivery.producer_role_mismatch",
    ],
    [
      "path",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        document.owned_output_path = "artifacts/reviews/forged.json";
      },
      "lane_delivery.mechanical_field_forged",
    ],
    [
      "task",
      (staging) => {
        staging.task_ref = "tasks/discovery/reviews/missing.attempt-1.json";
      },
      "runtime.lane_authority_unresolved",
    ],
    [
      "run",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        document.run_id = "other-run";
      },
      "lane_delivery.mechanical_field_forged",
    ],
    [
      "ref",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        const subject = document.review_subject as Record<string, unknown>;
        subject.reviewed_plan_question_refs = [`${G21_SCOPE_REF}#question_demand`];
      },
      "reference.type_mismatch",
    ],
    [
      "hash",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        document.task_hash = `sha256:${"0".repeat(64)}`;
      },
      "lane_delivery.mechanical_field_forged",
    ],
    [
      "shape",
      (staging) => {
        const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
          {}) as Record<string, unknown>;
        document.schema_version = "startup_opportunity.adversarial_review.v1";
      },
      "lane_delivery.mechanical_field_forged",
    ],
  ];
  for (const [label, mutate, expectedCode] of cases) {
    const invalid = structuredClone(
      adversarialReviewResultStaging(state.runId, reviewTask.artifact_path),
    );
    mutate(invalid);
    const invalidPath = await writeLaneStagingFile(runRoot, reviewTask, invalid);
    const before = await snapshotTree(runRoot);
    await assert.rejects(
      materializer.materializeFile(invalidPath),
      (error: unknown) => {
        assert.ok(error instanceof StoreError, label);
        const details = JSON.stringify(error.details);
        assert.ok(
          error.code === expectedCode || details.includes(expectedCode),
          `${label}: ${error.code} ${details}`,
        );
        return true;
      },
      label,
    );
    assert.deepEqual(await snapshotTree(runRoot), before, label);
  }
});

test("public adversarial review result accepts honest unknown and no-evidence stances", async (t) => {
  const state = await prepareAdversarialReviewPlanRun(t, "adversarial-review-honest-weak");
  const taskTemplate = fixtureEffective(state.bundle, G22_EVALUATION_TASK);
  const request = adversarialReviewWaveRequest(state.runId, taskTemplate);
  const stageMaterializer = new FormalStageMaterializer(
    state.runsRoot,
    state.validator,
    repositoryRoot,
  );
  const waveValidated = await stageMaterializer.materialize(request);
  const wavePublished = await stageMaterializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: waveValidated.compilation.publication_plan,
  });
  const reviewTask = wavePublished.compilation.compiled_envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.research_task.discovery_review.current",
  );
  assert.ok(reviewTask);
  const reviewedPlanQuestionRefs = [
    `${G21_PLAN_REF}#question_demand`,
    `${G21_PLAN_REF}#question_counterfactual`,
  ];
  const weakDeliveryClosure = {
    status: "insufficient_evidence",
    acquisition_routes_attempted: ["user_provided"],
    adopted_source_refs: [],
    unresolved_gaps: ["SYNTHETIC weak review leaves both stance conclusions unresolved."],
    stop_reason: "The bounded synthetic weak review reached its stop condition.",
  };
  const staging = adversarialReviewResultStaging(state.runId, reviewTask.artifact_path, {
    status: "insufficient_evidence",
    review_findings: [
      {
        finding_id: "finding_review_support_unknown",
        stance: "support",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "unknown",
        summary: "SYNTHETIC support remains unknown; no positive Evidence is claimed or required.",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: ["Unknown support is preserved as a structured state."],
      },
      {
        finding_id: "finding_review_oppose_no_evidence",
        stance: "oppose",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "no_evidence_found",
        summary: "SYNTHETIC opposing search found no usable material within the bounded fixture.",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: ["No-evidence state is not collapsed into unknown."],
      },
    ],
    decision_relevant_gaps: [
      {
        gap_id: "gap_review_unavailable_route",
        state: "unavailable",
        summary: "SYNTHETIC route was unavailable but remains visible as a gap.",
        basis_refs: [],
        requires_plan_adaptation: false,
        recommended_follow_up: "manual_review",
        limitations: ["Unavailable is distinct from no_evidence_found."],
      },
      {
        gap_id: "gap_review_not_applicable_dimension",
        state: "not_applicable",
        summary: "SYNTHETIC non-applicable context remains separately represented.",
        basis_refs: [],
        requires_plan_adaptation: false,
        recommended_follow_up: "no_action",
        limitations: ["Not-applicable does not become a search gap."],
      },
    ],
    search_closure: {
      ...weakDeliveryClosure,
    },
  });
  const delivery = staging.delivery_contract as Record<string, unknown>;
  delivery.search_closure = weakDeliveryClosure;
  const document = ((staging.agent_documents as Record<string, unknown>[])[0]?.document ??
    {}) as Record<string, unknown>;
  document.search_closure = {
    ...weakDeliveryClosure,
  };
  const materializer = new LaneResultMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const stagingPath = await writeLaneStagingFile(
    path.join(state.runsRoot, state.runId),
    reviewTask,
    staging,
  );
  const validated = await materializer.materializeFile(stagingPath);
  assert.equal(validated.status, "accepted");
  const reviewEnvelope = validated.compilation.compiled_envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.discovery_adversarial_review.current",
  );
  assert.ok(reviewEnvelope);
  assert.deepEqual(
    (reviewEnvelope.document.review_findings as Record<string, unknown>[]).map(
      (finding) => finding.evidence_state,
    ),
    ["unknown", "no_evidence_found"],
  );
  assert.deepEqual(
    (reviewEnvelope.document.decision_relevant_gaps as Record<string, unknown>[]).map(
      (gap) => gap.state,
    ),
    ["unavailable", "not_applicable"],
  );
  assert.deepEqual(validated.delivery_receipt.document.search_closure, weakDeliveryClosure);
});

test("public adversarial review result accepts no-search completion only when all assigned scope is not applicable", async (t) => {
  const state = await prepareAdversarialReviewPlanRun(t, "adversarial-review-not-required");
  const taskTemplate = fixtureEffective(state.bundle, G22_EVALUATION_TASK);
  const request = adversarialReviewWaveRequest(state.runId, taskTemplate);
  const stageMaterializer = new FormalStageMaterializer(
    state.runsRoot,
    state.validator,
    repositoryRoot,
  );
  const waveValidated = await stageMaterializer.materialize(request);
  const wavePublished = await stageMaterializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: waveValidated.compilation.publication_plan,
  });
  const reviewTask = wavePublished.compilation.compiled_envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.research_task.discovery_review.current",
  );
  assert.ok(reviewTask);
  const reviewedPlanQuestionRefs = [
    `${G21_PLAN_REF}#question_demand`,
    `${G21_PLAN_REF}#question_counterfactual`,
  ];
  const notRequiredClosure = {
    status: "search_not_required",
    acquisition_routes_attempted: ["none"],
    adopted_source_refs: [],
    unresolved_gaps: [],
    stop_reason: "All assigned synthetic review questions were structurally not applicable.",
  };
  const staging = adversarialReviewResultStaging(state.runId, reviewTask.artifact_path, {
    status: "completed",
    review_findings: [
      {
        finding_id: "finding_review_support_not_applicable",
        stance: "support",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "not_applicable",
        summary: "SYNTHETIC support stance was not applicable to the assigned questions.",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: ["No positive Evidence was required or fabricated."],
      },
      {
        finding_id: "finding_review_oppose_not_applicable",
        stance: "oppose",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "not_applicable",
        summary: "SYNTHETIC oppose stance was not applicable to the assigned questions.",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: ["No opposing Evidence was required or fabricated."],
      },
    ],
    decision_relevant_gaps: [
      {
        gap_id: "gap_review_not_applicable",
        state: "not_applicable",
        summary: "SYNTHETIC no-search review leaves no applicable decision gap.",
        basis_refs: [],
        requires_plan_adaptation: false,
        recommended_follow_up: "no_action",
        limitations: ["No follow-up is mechanically inferred."],
      },
    ],
    search_closure: notRequiredClosure,
  });
  const delivery = staging.delivery_contract as Record<string, unknown>;
  delivery.search_closure = notRequiredClosure;
  const materializer = new LaneResultMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const stagingPath = await writeLaneStagingFile(
    path.join(state.runsRoot, state.runId),
    reviewTask,
    staging,
  );
  const validated = await materializer.materializeFile(stagingPath);
  assert.equal(validated.status, "accepted");
  assert.deepEqual(validated.delivery_receipt.document.search_closure, notRequiredClosure);
  assert.deepEqual(validated.delivery_receipt.document.scope_coverage, [
    {
      scope_key: "adversarial_review",
      status: "not_applicable",
      evidence_refs: [],
      notes: "Harness-derived from the exact formal Lane Result or Audit semantic closure.",
    },
  ]);
  const publishStagingPath = await writeLaneStagingFile(
    path.join(state.runsRoot, state.runId),
    reviewTask,
    {
      ...staging,
      operation: "publish",
      publication_plan: validated.compilation.publication_plan,
    },
  );
  const published = await materializer.materializeFile(publishStagingPath);
  assert.equal(published.compilation.status, "published");
});

test("adversarial review wave materialization rejects stage, role, target, and source-phase drift before writes", async (t) => {
  const cases: readonly [string, (request: Record<string, unknown>) => void, string][] = [
    [
      "stage",
      (request) => {
        const wave = request.wave as Record<string, unknown>;
        wave.stage_kind = "candidate_evaluation";
      },
      "formal_materialization.review_stage_kind_mismatch",
    ],
    [
      "role",
      (request) => {
        const wave = request.wave as Record<string, unknown>;
        const lane = (wave.lanes as Record<string, unknown>[])[0];
        assert.ok(lane);
        lane.lane_role = "risk";
      },
      "formal_materialization.review_lane_role_mismatch",
    ],
    [
      "target",
      (request) => {
        const wave = request.wave as Record<string, unknown>;
        const lane = (wave.lanes as Record<string, unknown>[])[0];
        assert.ok(lane);
        lane.candidate_scope = { kind: "explicit", candidate_refs: [G22_DEMAND_R1] };
        (lane.task_semantics as Record<string, unknown>).target_candidate_refs = [G22_DEMAND_R1];
      },
      "formal_materialization.review_target_refs_mismatch",
    ],
    [
      "source-phase",
      (request) => {
        const wave = request.wave as Record<string, unknown>;
        const lane = (wave.lanes as Record<string, unknown>[])[0];
        assert.ok(lane);
        (lane.task_semantics as Record<string, unknown>).source_phase = "candidate_evaluation";
      },
      "formal_materialization.review_source_phase_mismatch",
    ],
  ];

  for (const [suffix, mutate, expectedDetailCode] of cases) {
    await t.test(suffix, async () => {
      const state = await prepareAdversarialReviewPlanRun(t, `adversarial-review-${suffix}-drift`);
      const taskTemplate = fixtureEffective(state.bundle, G22_EVALUATION_TASK);
      const request = adversarialReviewWaveRequest(state.runId, taskTemplate);
      mutate(request);
      const before = await snapshotTree(path.join(state.runsRoot, state.runId));
      await assert.rejects(
        new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot).materialize(
          request,
        ),
        (error: unknown) =>
          error instanceof StoreError &&
          error.code === "formal_materialization.wave_lane_semantics_invalid" &&
          JSON.stringify(error.details).includes(expectedDetailCode),
      );
      assert.deepEqual(await snapshotTree(path.join(state.runsRoot, state.runId)), before);
    });
  }
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

test("wave materialization closes candidate scope and Task target candidates before writes", async (t) => {
  const state = await prepareRun(t, "wave-scope-target-closure");
  const task = fixtureEffective(state.bundle, G22_EVALUATION_TASK);
  const materializer = new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const runRoot = path.join(state.runsRoot, state.runId);

  function laneOf(request: Record<string, unknown>): Record<string, unknown> {
    const lane = ((request.wave as Record<string, unknown>).lanes as Record<string, unknown>[])[0];
    assert.ok(lane);
    return lane;
  }

  function setExplicitCandidateTargets(
    request: Record<string, unknown>,
    candidateRefs: readonly string[],
  ): void {
    const lane = laneOf(request);
    lane.candidate_scope = { kind: "explicit", candidate_refs: [...candidateRefs] };
    lane.incumbent_response_assignment = {
      analysis_depth: "lightweight_scan",
      assignment_role: "owner",
      subject_refs: [...candidateRefs],
      rationale: "SYNTHETIC explicit candidate evaluation owner.",
    };
    (lane.task_semantics as Record<string, unknown>).target_candidate_refs = [...candidateRefs];
  }

  for (const candidateRefs of [[G22_DEMAND_R1], [G22_DEMAND_R1, G22_BASELINE_R1]] as const) {
    const valid = waveRequest(state.runId, task);
    valid.top_level_formal_refs = G21_MAP_REFS;
    setExplicitCandidateTargets(valid, candidateRefs);
    const before = await snapshotTree(runRoot);
    const result = await materializer.materialize(valid);
    assert.equal(result.status, "validated");
    assert.deepEqual(await snapshotTree(runRoot), before);
  }

  const mismatch = waveRequest(state.runId, task);
  mismatch.top_level_formal_refs = G21_MAP_REFS;
  const mismatchLane = laneOf(mismatch);
  mismatchLane.candidate_scope = { kind: "explicit", candidate_refs: [G22_DEMAND_R1] };
  mismatchLane.incumbent_response_assignment = {
    analysis_depth: "not_assigned",
    assignment_role: "none",
    subject_refs: [],
    rationale: "SYNTHETIC mismatch is rejected before incumbent assignment authority is needed.",
  };
  (mismatchLane.task_semantics as Record<string, unknown>).target_candidate_refs = [
    G22_BASELINE_R1,
  ];
  const beforeMismatch = await snapshotTree(runRoot);
  await assert.rejects(
    materializer.materialize(mismatch),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "formal_materialization.wave_lane_semantics_invalid" &&
      JSON.stringify(error.details).includes(
        "formal_materialization.discovery_lane_candidate_scope_target_mismatch",
      ),
  );
  assert.deepEqual(await snapshotTree(runRoot), beforeMismatch);

  const retainedState = await prepareRunThroughDiscoveryFanIn(t, "wave-retained-scope-target");
  const retainedTask = fixtureEffective(retainedState.bundle, G22_EVALUATION_TASK);
  const retainedMaterializer = new FormalStageMaterializer(
    retainedState.runsRoot,
    retainedState.validator,
    repositoryRoot,
  );
  const retainedRunRoot = path.join(retainedState.runsRoot, retainedState.runId);
  const retained = waveRequest(retainedState.runId, retainedTask);
  retained.top_level_formal_refs = [...G21_MAP_REFS, G22_FAN_IN];
  const retainedWave = retained.wave as Record<string, unknown>;
  retainedWave.wave_id = retainedDeepReviewWaveId;
  retainedWave.stage_id = "stage_retained_scope";
  retainedWave.stage_kind = "retained_candidate_deep_review";
  retainedWave.unit_ids = [retainedDeepReviewUnitId];
  const retainedLane = laneOf(retained);
  retainedLane.unit_id = retainedDeepReviewUnitId;
  retainedLane.candidate_scope = { kind: "retained", candidate_refs: [] };
  retainedLane.incumbent_response_assignment = {
    analysis_depth: "targeted_deep_dive",
    assignment_role: "owner",
    subject_refs: [G22_DEMAND_R2],
    rationale: "SYNTHETIC retained candidate deep-review owner.",
  };
  (retainedLane.task_semantics as Record<string, unknown>).target_candidate_refs = [G22_DEMAND_R2];
  const beforeRetained = await snapshotTree(retainedRunRoot);
  const retainedResult = await retainedMaterializer.materialize(retained);
  assert.equal(retainedResult.status, "validated");
  assert.deepEqual(await snapshotTree(retainedRunRoot), beforeRetained);

  const retainedWrongTarget = structuredClone(retained);
  const retainedWrongLane = laneOf(retainedWrongTarget);
  (retainedWrongLane.task_semantics as Record<string, unknown>).target_candidate_refs = [
    G22_DEMAND_R1,
  ];
  (retainedWrongLane.incumbent_response_assignment as Record<string, unknown>).subject_refs = [
    G22_DEMAND_R1,
  ];
  const beforeRetainedWrongTarget = await snapshotTree(retainedRunRoot);
  await assert.rejects(
    retainedMaterializer.materialize(retainedWrongTarget),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "formal_materialization.wave_lane_semantics_invalid" &&
      JSON.stringify(error.details).includes(
        "formal_materialization.discovery_lane_retained_scope_target_mismatch",
      ),
  );
  assert.deepEqual(await snapshotTree(retainedRunRoot), beforeRetainedWrongTarget);
});

test("wave materialization rejects generation tuple drift before publication writes", async (t) => {
  const state = await prepareGenerationPlanRun(t, "generation-wave-tuple-drift");
  const task = fixtureEffective(state.bundle, G22_GENERATION_TASK);
  const request = generationWaveRequest(state.runId, task);
  const materializer = new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const runRoot = path.join(state.runsRoot, state.runId);
  const cases = [
    {
      label: "stage_kind",
      mutate(value: Record<string, unknown>) {
        (value.wave as Record<string, unknown>).stage_kind = "candidate_evaluation";
      },
      code: "generation_stage_kind_mismatch",
    },
    {
      label: "lane_role",
      mutate(value: Record<string, unknown>) {
        const lane = (
          (value.wave as Record<string, unknown>).lanes as Record<string, unknown>[]
        )[0];
        assert.ok(lane);
        lane.lane_role = "evaluation";
      },
      code: "generation_lane_role_mismatch",
    },
    {
      label: "candidate_scope",
      mutate(value: Record<string, unknown>) {
        const lane = (
          (value.wave as Record<string, unknown>).lanes as Record<string, unknown>[]
        )[0];
        assert.ok(lane);
        lane.candidate_scope = {
          kind: "explicit",
          candidate_refs: ["artifacts/discovery/candidates/candidate_demand.r1.json"],
        };
      },
      code: "generation_candidate_scope_mismatch",
    },
    {
      label: "source_phase",
      mutate(value: Record<string, unknown>) {
        const lane = (
          (value.wave as Record<string, unknown>).lanes as Record<string, unknown>[]
        )[0];
        assert.ok(lane);
        (lane.task_semantics as Record<string, unknown>).source_phase = "candidate_evaluation";
      },
      code: "generation_source_phase_mismatch",
    },
    {
      label: "research_stage",
      mutate(value: Record<string, unknown>) {
        const lane = (
          (value.wave as Record<string, unknown>).lanes as Record<string, unknown>[]
        )[0];
        assert.ok(lane);
        (lane.commercial_research_semantics as Record<string, unknown>).research_stage =
          "solution_specific_evaluation";
      },
      code: "generation_research_stage_mismatch",
    },
    {
      label: "target_refs",
      mutate(value: Record<string, unknown>) {
        const lane = (
          (value.wave as Record<string, unknown>).lanes as Record<string, unknown>[]
        )[0];
        assert.ok(lane);
        (lane.task_semantics as Record<string, unknown>).target_candidate_refs = [
          "artifacts/discovery/candidates/candidate_demand.r1.json",
        ];
      },
      code: "generation_target_refs_mismatch",
    },
  ] as const;

  for (const scenario of cases) {
    const invalid = structuredClone(request);
    scenario.mutate(invalid);
    const before = await snapshotTree(runRoot);
    await assert.rejects(
      materializer.materialize(invalid),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code === "formal_materialization.wave_lane_semantics_invalid" &&
        JSON.stringify(error.details).includes(scenario.code),
      scenario.label,
    );
    assert.deepEqual(await snapshotTree(runRoot), before, scenario.label);
  }
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

test("formal stage validate_only plan remains stable across unrelated formal Artifact and Evidence growth", async (t) => {
  const state = await prepareGenerationPlanRun(t, "scoped-publication-plan-growth");
  const task = fixtureEffective(state.bundle, G22_GENERATION_TASK);
  const materializer = new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const request = generationWaveRequest(state.runId, task);
  const validated = await materializer.materialize(request);

  await new EvidenceStore(state.runsRoot).record({
    runId: state.runId,
    unitId: "unit_unrelated_growth",
    acquisitionGoal: "SYNTHETIC unrelated bytes appended after validate_only; not Evidence.",
    source: {
      kind: "user_provided",
      canonical_uri: "urn:startup-opportunity:user-provided:unrelated-growth",
    },
    rawContent: "SYNTHETIC unrelated growth bytes; not Evidence.",
    recordedAt: "2026-08-19T09:20:00Z",
  });
  const setupValidated = await materializer.materialize(setupRequest(state.runId, state.bundle));
  await materializer.materialize({
    ...setupRequest(state.runId, state.bundle),
    operation: "publish",
    publication_plan: setupValidated.compilation.publication_plan,
  });

  const published = await materializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: validated.compilation.publication_plan,
  });
  assert.equal(published.status, "published");
  const publishedClosurePaths = published.compilation.publication_plan.validation_closure.documents
    .map((entry) => entry.path)
    .sort();
  for (const ref of G21_MAP_REFS) {
    assert.ok(!publishedClosurePaths.includes(ref), ref);
  }
  assert.equal(
    published.compilation.publication_plan.validation_closure.exact_records.some((entry) =>
      entry.ref.startsWith("evidence/manifest.jsonl#"),
    ),
    false,
  );

  await new EvidenceStore(state.runsRoot).record({
    runId: state.runId,
    unitId: "unit_unrelated_growth_replay",
    acquisitionGoal: "SYNTHETIC unrelated bytes appended before exact replay; not Evidence.",
    source: {
      kind: "user_provided",
      canonical_uri: "urn:startup-opportunity:user-provided:unrelated-growth-replay",
    },
    rawContent: "SYNTHETIC unrelated replay growth bytes; not Evidence.",
    recordedAt: "2026-08-19T09:25:00Z",
  });
  const replay = await materializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: validated.compilation.publication_plan,
  });
  assert.equal(replay.status, "idempotent_replay");
});

test("formal publication plans reject identity, Manifest closure, and resolved-reference tampering before formal writes", async (t) => {
  const state = await prepareGenerationPlanRun(t, "publication-plan-tamper");
  const task = fixtureEffective(state.bundle, G22_GENERATION_TASK);
  const materializer = new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const request = generationWaveRequest(state.runId, task);
  const validated = await materializer.materialize(request);
  const zeroHash = `sha256:${"0".repeat(64)}`;
  const cases: readonly [string, (plan: Record<string, unknown>) => void][] = [
    [
      "plan_id",
      (plan) => {
        plan.plan_id = zeroHash;
      },
    ],
    [
      "manifest_content_hash",
      (plan) => {
        plan.manifest_content_hash = zeroHash;
      },
    ],
    [
      "Manifest validation_closure document",
      (plan) => {
        const closure = plan.validation_closure as Record<string, unknown>;
        const documents = closure.documents as Record<string, unknown>[];
        const manifest = documents.find((entry) => entry.path === "manifest.json");
        assert.ok(manifest);
        manifest.content_hash = zeroHash;
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const tampered = structuredClone(validated.compilation.publication_plan) as Record<
      string,
      unknown
    >;
    mutate(tampered);
    const before = await snapshotTree(path.join(state.runsRoot, state.runId));
    await assert.rejects(
      materializer.materialize({
        ...request,
        operation: "publish",
        publication_plan: tampered,
      }),
      (error: unknown) =>
        error instanceof StoreError &&
        [
          "formal_materialization.publication_plan_stale",
          "runtime.publication_plan_stale",
        ].includes(error.code),
      label,
    );
    assert.deepEqual(await snapshotTree(path.join(state.runsRoot, state.runId)), before, label);
  }

  const executionEnvelope = validated.compilation.compiled_envelopes.find(
    (entry) =>
      entry.artifact_type === "startup_opportunity.research_execution_plan.discovery.current",
  );
  assert.ok(executionEnvelope);
  const compiler = createFormalStageRuntimeCompiler(
    state.runsRoot,
    state.validator,
    repositoryRoot,
  );
  const manifestRefArtifacts = validated.compilation.compiled_envelopes.map((envelope) => ({
    artifact_type: envelope.artifact_type,
    artifact_path: envelope.artifact_path,
    producer_role: envelope.producer_role,
    input_refs:
      envelope.artifact_path === executionEnvelope.artifact_path
        ? ["manifest.json"]
        : envelope.input_refs,
    document: envelope.document,
  }));
  const manifestRefRequest = compileRequest(
    state.runId,
    "request_manifest_ref_tamper",
    manifestRefArtifacts,
  );
  const manifestRefValidated = await compiler.compile(manifestRefRequest);
  const tamperedResolvedReference = structuredClone(
    manifestRefValidated.publication_plan,
  ) as Record<string, unknown>;
  const resolvedReferences = tamperedResolvedReference.resolved_references as Record<
    string,
    unknown
  >[];
  const manifestReference = resolvedReferences.find(
    (entry) => entry.ref === "manifest.json" && entry.target_path === "manifest.json",
  );
  assert.ok(manifestReference);
  manifestReference.content_hash = zeroHash;
  await assert.rejects(
    compiler.compile({
      ...manifestRefRequest,
      operation: "publish",
      artifacts: [],
      publication_plan: tamperedResolvedReference,
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "runtime.publication_plan_stale",
  );
  await assert.rejects(
    readFile(path.join(state.runsRoot, state.runId, executionEnvelope.artifact_path), "utf8"),
  );
});

test("formal publication plans reject self-consistent Manifest tampering before formal writes", async (t) => {
  const state = await prepareGenerationPlanRun(t, "publication-plan-self-consistent-tamper");
  const task = fixtureEffective(state.bundle, G22_GENERATION_TASK);
  const materializer = new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const request = generationWaveRequest(state.runId, task);
  const validated = await materializer.materialize(request);
  const executionEnvelope = validated.compilation.compiled_envelopes.find(
    (entry) =>
      entry.artifact_type === "startup_opportunity.research_execution_plan.discovery.current",
  );
  assert.ok(executionEnvelope);
  const compiler = createFormalStageRuntimeCompiler(
    state.runsRoot,
    state.validator,
    repositoryRoot,
  );
  const manifestRefArtifacts = validated.compilation.compiled_envelopes.map((envelope) => ({
    artifact_type: envelope.artifact_type,
    artifact_path: envelope.artifact_path,
    producer_role: envelope.producer_role,
    input_refs:
      envelope.artifact_path === executionEnvelope.artifact_path
        ? ["manifest.json"]
        : envelope.input_refs,
    document: envelope.document,
  }));
  const manifestRefRequest = compileRequest(
    state.runId,
    "request_manifest_self_tamper",
    manifestRefArtifacts,
  );
  const manifestRefValidated = await compiler.compile(manifestRefRequest);
  const tampered = structuredClone(manifestRefValidated.publication_plan) as Record<
    string,
    unknown
  >;
  const original = manifestRefValidated.publication_plan as unknown as Record<string, unknown>;
  retargetRuntimePublicationPlanManifest(tampered, (manifest) => {
    manifest.limitations = [
      ...(((manifest.limitations as string[] | undefined) ?? []) as string[]),
      "SYNTHETIC caller tampered the validate-only Manifest snapshot.",
    ];
  });
  assert.notEqual(tampered.plan_id, original.plan_id);
  assert.notEqual(tampered.manifest_content_hash, original.manifest_content_hash);
  assert.notEqual(
    canonicalJson(tampered.manifest_snapshot),
    canonicalJson(original.manifest_snapshot),
  );
  const tamperedClosure = tampered.validation_closure as Record<string, unknown>;
  const originalClosure = original.validation_closure as Record<string, unknown>;
  assert.notEqual(
    (tamperedClosure.documents as Record<string, unknown>[]).find(
      (entry) => entry.path === "manifest.json",
    )?.content_hash,
    (originalClosure.documents as Record<string, unknown>[]).find(
      (entry) => entry.path === "manifest.json",
    )?.content_hash,
  );
  assert.notEqual(
    (tampered.resolved_references as Record<string, unknown>[]).find(
      (entry) => entry.target_path === "manifest.json",
    )?.content_hash,
    (original.resolved_references as Record<string, unknown>[]).find(
      (entry) => entry.target_path === "manifest.json",
    )?.content_hash,
  );
  const manifestBefore = await readFile(
    path.join(state.runsRoot, state.runId, "manifest.json"),
    "utf8",
  );
  await assert.rejects(
    compiler.compile({
      ...manifestRefRequest,
      operation: "publish",
      artifacts: [],
      publication_plan: tampered,
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "runtime.publication_plan_stale",
  );
  assert.equal(
    await readFile(path.join(state.runsRoot, state.runId, "manifest.json"), "utf8"),
    manifestBefore,
  );
  await assert.rejects(
    readFile(path.join(state.runsRoot, state.runId, executionEnvelope.artifact_path), "utf8"),
  );
});

test("formal stage validate_only and publish reject a superseded source without writing", async (t) => {
  const state = await prepareRun(t, "wave-superseded");
  const task = fixtureEffective(state.bundle, G22_EVALUATION_TASK);
  const materializer = new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const request = waveRequest(state.runId, task);
  const validated = await materializer.materialize(request);
  const before = await snapshotTree(path.join(state.runsRoot, state.runId));
  const runs = (materializer as unknown as { runs: RunStore }).runs as RunStore & {
    resolveExecution: RunStore["resolveExecution"];
  };
  const originalResolveExecution = runs.resolveExecution.bind(runs);
  const currentResolution = await state.store.resolveExecution(state.runId);
  runs.resolveExecution = async (runId: string) => ({
    ...currentResolution,
    requestedRunId: runId,
    disposition: "superseded_by_new_attempt",
    currentLeafRunId: runId,
    directTechnicalRestartRunIds: ["formal-stage-superseded-replacement"],
    issues: [],
  });
  try {
    await assert.rejects(
      materializer.materialize(request),
      (error: unknown) =>
        error instanceof StoreError && error.code === "run.superseded_by_new_attempt",
    );
    assert.deepEqual(await snapshotTree(path.join(state.runsRoot, state.runId)), before);

    await assert.rejects(
      materializer.materialize({
        ...request,
        operation: "publish",
        publication_plan: validated.compilation.publication_plan,
      }),
      (error: unknown) =>
        error instanceof StoreError && error.code === "run.superseded_by_new_attempt",
    );
    assert.deepEqual(await snapshotTree(path.join(state.runsRoot, state.runId)), before);
  } finally {
    runs.resolveExecution = originalResolveExecution;
  }
});

test("formal stage validate_only does not recover a pending Plan operation", async (t) => {
  const state = await prepareRun(t, "validate-only-pending-plan");
  const task = fixtureEffective(state.bundle, G22_EVALUATION_TASK);
  const adaptationRequest = {
    schema_version: "startup_opportunity.adaptation_author_request.current",
    request_id: "formal_stage_pending_plan_adaptation",
    run_id: state.runId,
    operation: "validate_only",
    top_level_formal_refs: G21_MAP_REFS,
    gap: {
      snapshot_id: "gap_pending_plan_noop",
      created_at: "2026-08-19T09:10:00Z",
      trigger_kind: "wave_completed",
      trigger_event_ref: null,
      phase: "discovery",
      wave_id: "wave_discovery_synthetic",
      observed_artifact_refs: [G22_DEMAND_R1],
      material_new_evidence_observed: false,
      repeated_source_refs: [],
      agent_declared_gaps: [],
    },
    decisions: [
      {
        adaptation_id: "adapt_pending_plan_noop",
        cover_all_generated_gaps: true,
        action: "request_clarification",
        reason: "SYNTHETIC clarification request used only to create a pending Plan receipt.",
        expected_decision_impact: ["next_action"],
        clarification_question: "SYNTHETIC should the no-op pending receipt be resumed?",
        success_condition: "Receive the synthetic clarification response.",
        requested_by: "main_agent",
        created_at: "2026-08-19T09:10:01Z",
      },
    ],
    apply_created_at: "2026-08-19T09:10:02Z",
    checkpoint_created_at: "2026-08-19T09:10:03Z",
    next_phase: "discovery",
    next_step: "Wait for the synthetic clarification.",
    belief_summary: {
      current_belief: "No new research meaning was introduced.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["This fixture creates only a pending Plan operation."],
      remaining_disagreement: ["None in this synthetic no-op case."],
      next_decision_relevant_question: "Does validate_only recover pending operations?",
    },
  };
  const author = await createAdaptationAuthorRuntime(repositoryRoot, state.runsRoot);
  const validated = await author.execute(adaptationRequest);
  const published = await author.execute({
    ...adaptationRequest,
    operation: "publish",
    publication_plan: validated.publication_plan,
  });
  await assert.rejects(
    author.execute(
      {
        ...adaptationRequest,
        operation: "apply",
        publication_plan: published.publication_plan,
      },
      { faultAt: "after_intent" },
    ),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "fault.injected" &&
      error.details.boundary === "after_intent",
  );

  const runRoot = path.join(state.runsRoot, state.runId);
  const before = await snapshotTree(runRoot);
  const materialized = await new FormalStageMaterializer(
    state.runsRoot,
    state.validator,
    repositoryRoot,
  ).materialize(waveRequest(state.runId, task));
  assert.equal(materialized.status, "validated");
  assert.deepEqual(await snapshotTree(runRoot), before);
});

test("formal setup exact replay rejects removed semantics, identity drift, and relation rewrites", async (t) => {
  const state = await prepareCleanPlanRun(t, "setup-exact-replay");
  const materializer = new FormalStageMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const request = setupRequest(state.runId, state.bundle);
  const validated = await materializer.materialize(request);
  const published = await materializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: validated.compilation.publication_plan,
  });
  assert.equal(published.status, "published");
  assert.equal(
    (
      await materializer.materialize({
        ...request,
        operation: "publish",
        publication_plan: validated.compilation.publication_plan,
      })
    ).status,
    "idempotent_replay",
  );

  async function assertReplayRejected(mutated: Record<string, unknown>): Promise<void> {
    const before = await snapshotTree(path.join(state.runsRoot, state.runId));
    await assert.rejects(
      materializer.materialize({
        ...mutated,
        operation: "publish",
        publication_plan: validated.compilation.publication_plan,
      }),
      (error: unknown) =>
        error instanceof StoreError &&
        [
          "formal_materialization.publication_plan_semantics_mismatch",
          "formal_materialization.request_invalid",
        ].includes(error.code),
    );
    assert.deepEqual(await snapshotTree(path.join(state.runsRoot, state.runId)), before);
  }

  const removedSemantics = structuredClone(request);
  const seed = ((removedSemantics.artifacts as Record<string, unknown>[])[0]?.document ??
    {}) as Record<string, unknown>;
  (seed.initial_questions as unknown[]).pop();
  await assertReplayRejected(removedSemantics);

  const missingIdentity = structuredClone(request);
  delete ((missingIdentity.artifacts as Record<string, unknown>[])[1] as Record<string, unknown>)
    .object_id;
  await assertReplayRejected(missingIdentity);

  const duplicateIdentity = structuredClone(request);
  (
    (duplicateIdentity.artifacts as Record<string, unknown>[])[2] as Record<string, unknown>
  ).local_key = "opportunity-map";
  await assertReplayRejected(duplicateIdentity);

  const relationRewrite = structuredClone(request);
  (
    ((relationRewrite.artifacts as Record<string, unknown>[])[3] as Record<string, unknown>)
      .local_refs as Record<string, unknown>
  )["/map_lineage/source_map_ref"] = "solution-map";
  await assertReplayRejected(relationRewrite);
});

test("G2.3 public materializer derives exact Opportunity solution summaries and rejects caller drift", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "formal-stage-g2-3-solution-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "formal-stage-g2-3-solution-summary";
  const runRoot = path.join(runsRoot, runId);
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test G2.3 solution summary materialization",
      researchLanguage: "en-US",
    },
    createdAt,
  });
  const evidence = new EvidenceStore(runsRoot);
  const generation = (
    await evidence.record({
      runId,
      unitId: "unit_seed_independent_demand",
      acquisitionGoal: "SYNTHETIC G2.3 materializer substrate; not Evidence.",
      source: {
        kind: "user_provided",
        canonical_uri: "urn:startup-opportunity:user-provided:g2-3-summary-generation",
      },
      rawContent: "SYNTHETIC G2.3 summary generation bytes; not Evidence.",
      recordedAt: createdAt,
    })
  ).record;
  const evaluation = (
    await evidence.record({
      runId,
      unitId: "unit_counterfactual",
      acquisitionGoal: "SYNTHETIC G2.3 materializer substrate; not Evidence.",
      source: {
        kind: "user_provided",
        canonical_uri: "urn:startup-opportunity:user-provided:g2-3-summary-evaluation",
      },
      rawContent: "SYNTHETIC G2.3 summary evaluation bytes; not Evidence.",
      recordedAt: createdAt,
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
  await store.publishArtifactBundle({
    runId,
    envelopes: envelopesByType(bundle, "startup_opportunity.discovery_candidate.v1").filter(
      (candidate) => candidate.document.revision === 1,
    ),
  });
  const candidateRuntime = discoveryWaveEnvelopes(
    bundle,
    runId,
    "startup_opportunity.research_task.discovery_candidate.current",
    1,
    "candidate_runtime",
  );
  await publishRuntimeEnvelopesAsFormalStage(
    { runsRoot, runId, validator },
    candidateRuntime,
    "request_g2_3_summary_candidate_wave",
  );
  const candidateDispatch = candidateRuntime.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(candidateDispatch);
  await registerAllDispatchLaunches(
    runsRoot,
    validator,
    runId,
    candidateDispatch,
    "launch_g2_3_summary_candidate",
  );
  await store.publishArtifactBundle({
    runId,
    envelopes: envelopesByType(
      bundle,
      "startup_opportunity.evidence.discovery_candidate.current",
      "startup_opportunity.claim.discovery_candidate.current",
      "startup_opportunity.finding.discovery_candidate.current",
      "startup_opportunity.insight.discovery_candidate.current",
      "startup_opportunity.judgment_assessment.discovery_candidate.current",
      "startup_opportunity.source_manifest.discovery_candidate.current",
    ),
  });
  await store.publishArtifactBundle({
    runId,
    envelopes: [
      runtimeEnvelope(bundle, G22_DEMAND_R2),
      ...envelopesByType(
        bundle,
        "startup_opportunity.discovery_lane_result.v1",
        "startup_opportunity.concrete_pre_candidate.v1",
        "startup_opportunity.pre_candidate_relation.v1",
      ),
    ],
  });
  await store.publishArtifact({
    runId,
    envelope: runtimeEnvelope(bundle, "artifacts/discovery/fan-in.r1.json"),
  });
  await store.confirmPreCandidates({
    runId,
    expectedFanInRef: G22_FAN_IN,
    expectedFanInHash: runtimeEnvelope(bundle, G22_FAN_IN).content_hash,
    selectedPreCandidateRefs: [G22_RETAINED_PRE_CANDIDATE],
    nextAction: "proceed_with_selected",
    userConfirmationAttestation:
      "SYNTHETIC caller attests that the user selected the retained pre-candidate for continuation.",
    confirmedAt: "2026-07-27T19:59:00Z",
  });
  await store.publishArtifactBundle({
    runId,
    envelopes: discoverySynthesisReadinessEnvelopes(bundle),
  });
  await store.publishArtifactBundle({
    runId,
    envelopes: [
      G23_DEMAND_CONVERSION,
      G23_DEMAND,
      G23_BASELINE_CONVERSION,
      G23_BASELINE,
      G23_SOLUTION_CONVERSION,
      G23_SOLUTION,
      G23_EVALUATION,
    ].map((ref) => synthesisEnvelope(bundle, ref)),
  });

  const opportunityDeclaration = (artifactPath: string): Record<string, unknown> => {
    const document = structuredClone(effectiveArtifact(bundle, artifactPath));
    delete document.solution_evaluation_summary;
    const localRefs: Record<string, string | readonly string[]> = {
      source_pre_candidate_ref: String(document.source_pre_candidate_ref),
      discovery_fan_in_ref: String(document.discovery_fan_in_ref),
      demand_thesis_ref: String(document.demand_thesis_ref),
      baseline_option_ref: String(document.baseline_option_ref),
      selected_solution_ref: String(document.selected_solution_ref),
      solution_evaluation_ref: String(document.solution_evaluation_ref),
    };
    if (
      Array.isArray(document.alternative_solution_refs) &&
      document.alternative_solution_refs.length > 0
    ) {
      localRefs.alternative_solution_refs = document.alternative_solution_refs as readonly string[];
    }
    return {
      local_key: String(document.opportunity_id),
      object_id: String(document.opportunity_id),
      action: "create",
      document,
      local_refs: localRefs,
    };
  };
  const request = {
    schema_version: "startup_opportunity.formal_stage_materialization_request.current",
    request_id: "formal_g2_3_solution_summary_projection",
    run_id: runId,
    operation: "validate_only",
    created_at: "2026-08-19T09:20:00Z",
    stage_kind: "g2_3_synthesis",
    top_level_formal_refs: [
      "artifacts/discovery/fan-in.r1.json",
      G23_DEMAND,
      G23_BASELINE,
      G23_SOLUTION,
      G23_EVALUATION,
    ],
    artifacts: [
      opportunityDeclaration(G23_OPPORTUNITY_A),
      opportunityDeclaration(G23_OPPORTUNITY_B),
    ],
  };
  const materializer = new FormalStageMaterializer(runsRoot, validator, repositoryRoot);
  const beforeValidate = await snapshotTree(runRoot);
  const validated = await materializer.materialize(request);
  assert.equal(validated.status, "validated");
  assert.deepEqual(await snapshotTree(runRoot), beforeValidate);
  const compiledOpportunityA = validated.compilation.compiled_envelopes.find(
    (entry) => entry.artifact_path === G23_OPPORTUNITY_A,
  );
  assert.ok(compiledOpportunityA);
  const expectedSummary = effectiveArtifact(bundle, G23_OPPORTUNITY_A)
    .solution_evaluation_summary as Record<string, unknown>;
  assert.deepEqual(compiledOpportunityA.document.solution_evaluation_summary, expectedSummary);
  assert.equal(
    (compiledOpportunityA.document.solution_evaluation_summary as Record<string, unknown>)
      .selection_posture,
    "provisional_implementation",
  );

  const published = await materializer.materialize({
    ...request,
    operation: "publish",
    publication_plan: validated.compilation.publication_plan,
  });
  assert.equal(published.status, "published");
  assert.equal(
    (
      await materializer.materialize({
        ...request,
        operation: "publish",
        publication_plan: validated.compilation.publication_plan,
      })
    ).status,
    "idempotent_replay",
  );

  const forged = structuredClone(request);
  const forgedOpportunity = (forged.artifacts as Record<string, unknown>[])[0];
  assert.ok(forgedOpportunity);
  const forgedDocument = forgedOpportunity.document as Record<string, unknown>;
  forgedDocument.solution_evaluation_summary = structuredClone(expectedSummary);
  (forgedDocument.solution_evaluation_summary as Record<string, unknown>).selection_posture =
    "compared_selection";
  const beforeForged = await snapshotTree(runRoot);
  await assert.rejects(
    materializer.materialize(forged),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "formal_materialization.solution_evaluation_summary_drift",
  );
  assert.deepEqual(await snapshotTree(runRoot), beforeForged);

  const stalePublish = structuredClone(request);
  const staleOpportunity = (stalePublish.artifacts as Record<string, unknown>[])[0];
  assert.ok(staleOpportunity);
  const staleDocument = staleOpportunity.document as Record<string, unknown>;
  staleDocument.solution_evaluation_summary = structuredClone(expectedSummary);
  (staleDocument.solution_evaluation_summary as Record<string, unknown>).formal_solution_refs = [];
  const beforeStalePublish = await snapshotTree(runRoot);
  await assert.rejects(
    materializer.materialize({
      ...stalePublish,
      operation: "publish",
      publication_plan: validated.compilation.publication_plan,
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "formal_materialization.publication_plan_semantics_mismatch" &&
      (error.details as Record<string, unknown>).cause_code ===
        "formal_materialization.solution_evaluation_summary_drift",
  );
  assert.deepEqual(await snapshotTree(runRoot), beforeStalePublish);
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
  const executionLaneFor = (unitId: string): Record<string, unknown> | undefined =>
    (executionEnvelope.document.stages as Record<string, unknown>[])
      .flatMap((stage) => stage.lanes as Record<string, unknown>[])
      .find((lane) => lane.unit_id === unitId);
  const dispatchTaskFor = (unitId: string): Record<string, unknown> | undefined =>
    (dispatchEnvelope.document.tasks as Record<string, unknown>[]).find(
      (task) => task.unit_id === unitId,
    );
  const checklist = parseCli<{
    formal_artifact: boolean;
    additional_material_allowed: boolean;
    checklist: readonly unknown[];
    lane_submission_contract: Record<string, unknown>;
  }>(cli("scaffold-lane-submission", "--run-id", runId, "--task-ref", taskEnvelope.artifact_path));
  assert.equal(checklist.formal_artifact, false);
  assert.equal(checklist.additional_material_allowed, true);
  assert.ok(checklist.checklist.length > 1);
  assert.equal(
    canonicalJson(taskEnvelope.document.lane_submission_contract),
    canonicalJson(executionLaneFor("unit_counterfactual")?.lane_submission_contract),
  );
  assert.equal(
    canonicalJson(taskEnvelope.document.lane_submission_contract),
    canonicalJson(dispatchTaskFor("unit_counterfactual")?.lane_submission_contract),
  );
  assert.equal(
    canonicalJson(taskEnvelope.document.lane_submission_contract),
    canonicalJson(checklist.lane_submission_contract),
  );

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
      "--acquisition-goal",
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
      "--acquisition-goal",
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
  const generationLaneStagingPath = String(
    (generationTaskEnvelope.document.lane_submission_contract as Record<string, unknown>)
      .staging_output_path,
  );
  const generationLaneValidationFile = await writeJson(
    runRoot,
    generationLaneStagingPath,
    generationLaneStaging,
  );
  const beforeGenerationLaneValidation = await snapshotTree(runRoot);
  const generationLaneValidated = parseCli<Record<string, unknown>>(
    cli("materialize-lane-result", "--file", generationLaneValidationFile),
  );
  assert.equal(generationLaneValidated.status, "accepted");
  assert.deepEqual(await snapshotTree(runRoot), beforeGenerationLaneValidation);
  const generationLaneCompilation = generationLaneValidated.compilation as Record<string, unknown>;
  const invalidGenerationLaneFile = await writeJson(
    runRoot,
    String(generationTaskEnvelope.document.allowed_output_path),
    generationLaneStaging,
  );
  const invalidGenerationLaneResult = cli(
    "materialize-lane-result",
    "--file",
    invalidGenerationLaneFile,
  );
  assert.notEqual(invalidGenerationLaneResult.status, 0);
  assert.match(invalidGenerationLaneResult.stderr, /runtime\.lane_staging_path_invalid/);
  await rm(invalidGenerationLaneFile, { force: true });
  const generationLanePublishFile = await writeJson(runRoot, generationLaneStagingPath, {
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
  assert.equal(
    canonicalJson(generationTaskEnvelope.document.lane_submission_contract),
    canonicalJson(executionLaneFor("unit_seed_independent_demand")?.lane_submission_contract),
  );
  assert.equal(
    canonicalJson(generationTaskEnvelope.document.lane_submission_contract),
    canonicalJson(dispatchTaskFor("unit_seed_independent_demand")?.lane_submission_contract),
  );
  assert.equal(
    canonicalJson(generationTaskEnvelope.document.lane_submission_contract),
    canonicalJson(generationReceiptEnvelope.document.lane_submission_contract),
  );
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
  const laneStagingPath = String(
    (taskEnvelope.document.lane_submission_contract as Record<string, unknown>).staging_output_path,
  );
  const laneValidationFile = await writeJson(runRoot, laneStagingPath, laneStaging);
  const beforeLaneValidation = await snapshotTree(runRoot);
  const laneValidated = parseCli<Record<string, unknown>>(
    cli("materialize-lane-result", "--file", laneValidationFile),
  );
  assert.equal(laneValidated.status, "accepted");
  assert.deepEqual(await snapshotTree(runRoot), beforeLaneValidation);
  const laneCompilation = laneValidated.compilation as Record<string, unknown>;
  const traversalLaneFile = await writeJson(runRoot, "../lane-traversal.json", laneStaging);
  const traversalLaneResult = cli("materialize-lane-result", "--file", traversalLaneFile);
  assert.notEqual(traversalLaneResult.status, 0);
  assert.match(traversalLaneResult.stderr, /runtime\.lane_staging_path_invalid/);
  const wrongAbsoluteFile = await writeJson(root, "lane-wrong-absolute.json", laneStaging);
  const beforeWrongAbsolute = await snapshotTree(runRoot);
  const wrongAbsoluteResult = cli("materialize-lane-result", "--file", wrongAbsoluteFile);
  assert.notEqual(wrongAbsoluteResult.status, 0);
  assert.match(wrongAbsoluteResult.stderr, /runtime\.lane_staging_path_invalid/);
  assert.deepEqual(await snapshotTree(runRoot), beforeWrongAbsolute);
  await rm(laneValidationFile, { force: true });
  const escapedTarget = path.join(root, "lane-target-symlink-source.json");
  await writeFile(escapedTarget, "{not json\n");
  await symlink(escapedTarget, laneValidationFile);
  const beforeTargetSymlink = await snapshotTree(runRoot);
  const targetSymlinkResult = cli("materialize-lane-result", "--file", laneValidationFile);
  assert.notEqual(targetSymlinkResult.status, 0);
  assert.match(targetSymlinkResult.stderr, /path\.symlink_escape/);
  assert.deepEqual(await snapshotTree(runRoot), beforeTargetSymlink);
  await rm(laneValidationFile, { force: true });
  const wrongAbsolutePublishFile = await writeJson(root, "lane-wrong-absolute-publish.json", {
    ...laneStaging,
    operation: "publish",
    publication_plan: laneCompilation.publication_plan,
  });
  const beforeWrongAbsolutePublish = await snapshotTree(runRoot);
  const wrongAbsolutePublishResult = cli(
    "materialize-lane-result",
    "--file",
    wrongAbsolutePublishFile,
  );
  assert.notEqual(wrongAbsolutePublishResult.status, 0);
  assert.match(wrongAbsolutePublishResult.stderr, /runtime\.lane_staging_path_invalid/);
  assert.deepEqual(await snapshotTree(runRoot), beforeWrongAbsolutePublish);
  const laneSubmissionParent = path.dirname(laneValidationFile);
  await rm(laneSubmissionParent, { recursive: true, force: true });
  const escapedParent = path.join(root, "lane-submissions-parent-symlink-source");
  await mkdir(escapedParent, { recursive: true });
  await writeFile(path.join(escapedParent, path.basename(laneValidationFile)), "{not json\n");
  await symlink(escapedParent, laneSubmissionParent);
  const beforeParentSymlink = await snapshotTree(runRoot);
  const parentSymlinkResult = cli("materialize-lane-result", "--file", laneValidationFile);
  assert.notEqual(parentSymlinkResult.status, 0);
  assert.match(parentSymlinkResult.stderr, /path\.symlink_escape/);
  assert.deepEqual(await snapshotTree(runRoot), beforeParentSymlink);
  await rm(laneSubmissionParent, { force: true });
  const lanePublishFile = await writeJson(runRoot, laneStagingPath, {
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
  assert.equal(
    canonicalJson(taskEnvelope.document.lane_submission_contract),
    canonicalJson(receiptEnvelope.document.lane_submission_contract),
  );
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
  const retainedPreCandidateRef =
    "artifacts/discovery/concrete-pre-candidates/pre_candidate_formal_author_demand.r1.json";
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
  const preCandidateMaterialRefs = [
    generationEvidenceRef,
    generationClaimRef,
    generationFindingRef,
    generationJudgmentRef,
    evidenceRef,
    claimRef,
    findingRef,
    judgmentRef,
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
        local_key: "pre-candidate-demand",
        object_id: "pre_candidate_formal_author_demand",
        action: "create",
        document: {
          schema_version: "startup_opportunity.concrete_pre_candidate.v1",
          pre_candidate_id: "pre_candidate_formal_author_demand",
          revision: 1,
          parent_pre_candidate_ref: null,
          parent_content_hash: null,
          run_id: runId,
          mode: "opportunity_discovery",
          phase: "discovery",
          owner_role: "main_agent",
          scope_frame_ref: "",
          research_plan_ref: G21_PLAN_REF,
          formation: { relationship_kind: "direct", relationship_group_id: null },
          seed_bindings: [
            {
              ref: "artifacts/discovery/candidates/candidate_demand.r2.json",
              schema_version: "startup_opportunity.discovery_candidate.v1",
              candidate_kind: "demand_seed",
              content_hash: "0".repeat(64),
            },
          ],
          lane_result_bindings: [
            {
              ref: generationLaneResultRef,
              schema_version: "startup_opportunity.discovery_lane_result.v1",
              status: "partial",
              content_hash: "0".repeat(64),
            },
            {
              ref: laneResultRef,
              schema_version: "startup_opportunity.discovery_lane_result.v1",
              status: "partial",
              content_hash: "0".repeat(64),
            },
          ],
          triage_profile: {
            users: {
              state: "partial",
              statements: ["Synthetic user segment remains partial."],
              basis_material_refs: [generationJudgmentRef],
              limitations: ["No independent user Evidence is introduced."],
            },
            job_to_be_done: {
              state: "conflicting",
              statements: [
                "The job remains unresolved because supporting and opposing context conflict.",
              ],
              basis_material_refs: [generationClaimRef, claimRef],
              limitations: ["The direction remains pre-formal and insufficient."],
            },
            entry_scene: {
              state: "unknown",
              statements: ["Entry scene is unknown in this synthetic fixture."],
              basis_material_refs: [],
              limitations: ["Unknown state is preserved."],
            },
            buyer_or_payment_logic: {
              state: "unknown",
              statements: ["Buyer or payment logic is unknown."],
              basis_material_refs: [],
              limitations: ["No payment claim is inferred."],
            },
            current_alternatives: {
              state: "unavailable",
              statements: ["Alternative evidence is unavailable."],
              basis_material_refs: [],
              limitations: ["Unavailable state is preserved."],
            },
            solution_boundary: {
              state: "partial",
              statements: ["Solution boundary is only a partial pre-candidate note."],
              basis_material_refs: [judgmentRef],
              limitations: ["No formal Solution is created here."],
            },
          },
          material_dispositions: preCandidateMaterialRefs.map((materialRef) => ({
            material_ref: materialRef,
            material_schema_version:
              "startup_opportunity.judgment_assessment.discovery_candidate.current",
            material_content_hash: "0".repeat(64),
            disposition:
              materialRef === claimRef || materialRef === judgmentRef ? "opposing" : "supporting",
            rationale: "The Main Agent explicitly dispositions every typed Lane material.",
          })),
          materialization_rationale:
            "Materialize one direct retained concrete pre-candidate so G2.3 cannot infer lineage.",
          pre_formal_boundary: {
            formal_opportunity_created: false,
            validated_market_claim: false,
            harness_inferred_candidate: false,
            harness_ranked_candidate: false,
            external_validation_performed: false,
          },
          limitations: ["This remains a partial, pre-formal synthetic candidate."],
        },
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
          pre_candidate_relation_refs: [],
          pre_candidate_dispositions: [
            {
              disposition_id: "fan_in_pre_disposition_cli_candidate",
              pre_candidate_ref: retainedPreCandidateRef,
              pre_candidate_content_hash: "0".repeat(64),
              disposition: "retained",
              supporting_lane_result_refs: [generationLaneResultRef, laneResultRef],
              judgment_assessment_refs: [generationJudgmentRef, judgmentRef],
              rationale:
                "Retain the direct concrete pre-candidate without promoting it to a formal Opportunity.",
              limitations: ["Concrete triage remains partial and insufficient."],
            },
          ],
          candidate_diversity_summary: {
            preserved_dimensions: ["counterfactual", "conflicting_context"],
            diversity_retention_refs: [candidateRef],
            counterfactual_candidate_refs: [candidateRef],
            pre_candidate_diversity_retention_refs: [retainedPreCandidateRef],
            counterfactual_pre_candidate_refs: [retainedPreCandidateRef],
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
      retainedPreCandidateRef,
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
          source_pre_candidate_ref: retainedPreCandidateRef,
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
          source_pre_candidate_ref: retainedPreCandidateRef,
          discovery_fan_in_ref: fanInRef,
        },
      },
    ],
  };
  // This deliberately under-specified setup has only a demand candidate. The
  // public materializer must keep the G2.3 readiness gate closed rather than
  // infer the missing baseline and solution candidate branches.
  const synthesisValidationFile = await writeJson(
    root,
    "g2-3-invalid-validate.json",
    synthesisRequest,
  );
  const beforeSynthesisValidation = await snapshotTree(runRoot);
  const synthesisRejected = cli("materialize-formal-stage", "--file", synthesisValidationFile);
  assert.equal(synthesisRejected.status, 1);
  assert.match(synthesisRejected.stderr, /run\.discovery_synthesis_readiness_required/);
  assert.deepEqual(await snapshotTree(runRoot), beforeSynthesisValidation);

  const adaptationRequest = {
    schema_version: "startup_opportunity.adaptation_author_request.current",
    request_id: "formal_author_adaptation",
    run_id: runId,
    operation: "validate_only",
    top_level_formal_refs: [fanInRef],
    gap: {
      snapshot_id: "gap_formal_author_partial",
      created_at: "2026-08-19T09:07:00Z",
      trigger_kind: "wave_completed",
      trigger_event_ref: null,
      phase: "discovery",
      wave_id: String(planWave.wave_id),
      observed_artifact_refs: [fanInRef],
      material_new_evidence_observed: false,
      repeated_source_refs: [evidenceRef],
      agent_declared_gaps: [],
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

  const hiddenDiagnosticTerminalEnvelope = terminalReportEnvelopeWithHiddenDiagnostics(runId);
  const hiddenDiagnosticValidationFile = await writeJson(root, "adaptation-terminal-hidden.json", {
    ...adaptationRequest,
    request_id: "formal_author_terminal_hidden_diagnostics",
    terminal_report_envelope: hiddenDiagnosticTerminalEnvelope,
  });
  const beforeHiddenDiagnosticValidation = await snapshotTree(runRoot);
  const hiddenDiagnosticRejected = cli(
    "author-plan-adaptation",
    "--file",
    hiddenDiagnosticValidationFile,
  );
  assert.equal(hiddenDiagnosticRejected.status, 1);
  assert.match(hiddenDiagnosticRejected.stderr, /apply\.unexpected_terminal_report_source/u);
  assert.deepEqual(await snapshotTree(runRoot), beforeHiddenDiagnosticValidation);
  const hiddenMarkdown = deriveTerminalReportDocuments(hiddenDiagnosticTerminalEnvelope)
    .flatMap((document) => [
      ...(typeof document.document.markdown === "string" ? [document.document.markdown] : []),
      ...(typeof document.document.audit_appendix_markdown === "string"
        ? [document.document.audit_appendix_markdown]
        : []),
    ])
    .join("\n");
  assert.doesNotMatch(hiddenMarkdown, /Audit Lane Search Closure/u);
  assert.doesNotMatch(hiddenMarkdown, /lane_delivery\.search_closure_route_missing/u);
  assert.match(hiddenMarkdown, /计划中的搜索完成记录缺失/);
  assert.equal(
    (
      (hiddenDiagnosticTerminalEnvelope.document.execution as Record<string, unknown>)
        .incomplete_stages as Record<string, unknown>[]
    )[0]?.detail,
    "lane_delivery.search_closure_route_missing",
  );
  assert.equal(
    (
      (hiddenDiagnosticTerminalEnvelope.document.runtime_health as Record<string, unknown>)
        .issues as Record<string, unknown>[]
    )[0]?.detail,
    "lane_delivery.search_closure_route_missing",
  );

  const invalidTerminalEnvelope = structuredClone(hiddenDiagnosticTerminalEnvelope);
  invalidTerminalEnvelope.document.execution = {
    ...(invalidTerminalEnvelope.document.execution as Record<string, unknown>),
    completeness: "synthetic_unmapped_status",
  };
  (invalidTerminalEnvelope as { content_hash: string }).content_hash = canonicalContentHash(
    invalidTerminalEnvelope.document,
  );
  const invalidTerminalValidationFile = await writeJson(root, "adaptation-terminal-invalid.json", {
    ...adaptationRequest,
    request_id: "formal_author_terminal_invalid_status",
    terminal_report_envelope: invalidTerminalEnvelope,
  });
  const beforeInvalidTerminalValidation = await snapshotTree(runRoot);
  const invalidTerminalRejected = cli(
    "author-plan-adaptation",
    "--file",
    invalidTerminalValidationFile,
  );
  assert.equal(invalidTerminalRejected.status, 1);
  assert.match(invalidTerminalRejected.stderr, /adaptation\.author_request_invalid/u);
  assert.match(invalidTerminalRejected.stderr, /schema\.enum/u);
  assert.match(
    invalidTerminalRejected.stderr,
    /\/terminal_report_envelope\/document\/execution\/completeness/u,
  );
  assert.deepEqual(await snapshotTree(runRoot), beforeInvalidTerminalValidation);

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

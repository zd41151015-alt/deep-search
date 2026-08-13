import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  INCUMBENT_RESPONSE_STRATEGIC_CONTEXT,
  INCUMBENT_RESPONSE_STRATEGIC_CONTEXT_ZH,
} from "../harness/src/incumbent-response-contract.js";
import {
  createArtifactValidator,
  DeclarativeRuntimeCompiler,
  LaneResultMaterializer,
  type OperationObservation,
  operationTrace,
  RunStore,
  StoreError,
} from "../harness/src/index.js";
import {
  createCommercialAuditProjector,
  renderIncumbentResponseNarratives,
  renderIncumbentResponseRiskTable,
} from "../harness/src/reporting/commercial-report-tables.js";
import { renderTerminalFullReport } from "../harness/src/reporting/terminal-reporting.js";
import { createConfirmedRun } from "./helpers/current-run.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const createdAt = "2026-08-13T12:00:00Z";

function graded(level: string, rationale: string): Record<string, unknown> {
  return { level, rationale };
}

function assessedSemantic(subjectId: string, responder: string): Record<string, unknown> {
  const rationale =
    "The responder can copy one feature, but ability does not establish willingness or full-thesis coverage.";
  return {
    subject_id: subjectId,
    analysis_state: "assessed",
    responder_identity: responder,
    responder_category: "suite incumbent",
    control_point: "adjacent workflow and bundled distribution",
    response_modes: ["copy", "bundle", "native_integration"],
    capability_adjacency: graded("high", rationale),
    response_cost: {
      implementation: graded("low", "Feature implementation is adjacent."),
      operational: graded("medium", "Workflow operation requires support."),
      compliance: graded("medium", "Compliance review remains necessary."),
      data: graded("high", "Trusted vertical data is not already controlled."),
      distribution: graded("low", "Existing distribution can expose a copied feature."),
    },
    incentive: {
      level: "low",
      drivers: ["Protect suite engagement."],
      disincentives: ["The narrow segment may not justify operating complexity."],
      cannibalization: "Bundling may cannibalize an adjacent premium product.",
      rationale: "Capability is high while willingness remains low and uncertain.",
    },
    plausible_response_horizon: {
      band: "medium_term",
      rationale: "A copied feature is plausible before a complete workflow response.",
    },
    distribution_leverage: {
      level: "high",
      control_points: ["suite default placement"],
      rationale: "The responder controls an existing distribution surface.",
    },
    thesis_coverage: {
      scope: "single_feature",
      covered_elements: ["basic reminder generation"],
      uncovered_elements: ["vertical workflow", "service delivery", "trusted context"],
      rationale: "Copying the feature does not reproduce the complete value proposition.",
    },
    residual_differentiation: {
      overall_strength: "high",
      dimensions: [
        {
          kind: "vertical workflow",
          strength: "high",
          rationale: "Specialized delivery and trusted context remain differentiated.",
        },
      ],
      rationale: "The full workflow retains material differentiation.",
    },
    supporting_evidence_refs: ["evidence/records/responder-support.json"],
    opposing_evidence_refs: ["evidence/records/responder-opposition.json"],
    background_evidence_refs: ["evidence/records/responder-background.json"],
    inference_boundary: "Public material cannot establish an internal roadmap or commitment.",
    confidence: "medium",
    uncertainty: "No internal prioritization or launch commitment is known.",
    unknowns: ["Actual launch priority and timing."],
    data_gaps: ["No roadmap or full-workflow operating-cost disclosure."],
  };
}

function responseRow(semantic: Record<string, unknown>): Record<string, unknown> {
  return {
    audit_ref: `artifacts/research-audits/${String(semantic.subject_id)}.json`,
    assessment: {
      assessment_id: `response_${String(semantic.subject_id)}`,
      analysis_depth: "targeted_deep_dive",
      semantic,
    },
  };
}

function reportCitations(): readonly Record<string, unknown>[] {
  return [
    ["responder-support", "Independent capability report", "https://example.invalid/support"],
    ["responder-opposition", "Workflow counterevidence", "https://example.invalid/opposition"],
    ["responder-background", "Public product description", "https://example.invalid/background"],
  ].map(([id, label, url]) => ({
    evidence_ref: `evidence/records/${id}.json`,
    source_access: "public",
    label,
    url,
  }));
}

test("final-subject responder narrative closes every semantic axis without importing sibling history", () => {
  const source = {
    current_decision_subject_ids: ["subject_final"],
    report_subject_labels: [
      { subject_id: "subject_final", label: "Final Direction" },
      { subject_id: "subject_history", label: "Historical Direction" },
    ],
    report_citations: reportCitations(),
    incumbent_response_risk_rows: [
      responseRow(assessedSemantic("subject_final", "Final Suite Leader")),
      responseRow(assessedSemantic("subject_history", "Historical Suite Leader")),
    ],
  };

  const narrative = renderIncumbentResponseNarratives(source);
  assert.ok(narrative.includes(INCUMBENT_RESPONSE_STRATEGIC_CONTEXT));
  assert.match(narrative, /Capability adjacency is not willingness/u);
  assert.match(narrative, /Final Direction/u);
  assert.match(narrative, /Ability \(not willingness\): high/u);
  assert.match(narrative, /implementation low/u);
  assert.match(narrative, /operations medium/u);
  assert.match(narrative, /compliance medium/u);
  assert.match(narrative, /data high/u);
  assert.match(narrative, /distribution low/u);
  assert.match(narrative, /Willingness: low/u);
  assert.match(narrative, /Cannibalization/u);
  assert.match(narrative, /medium_term/u);
  assert.match(narrative, /single_feature/u);
  assert.match(narrative, /Uncovered: vertical workflow/u);
  assert.match(narrative, /Residual differentiation: high/u);
  assert.match(narrative, /Independent capability report/u);
  assert.match(narrative, /Workflow counterevidence/u);
  assert.match(narrative, /Public product description/u);
  assert.match(narrative, /Inference boundary and gaps/u);
  assert.doesNotMatch(narrative, /Historical Direction|Historical Suite Leader/u);

  const appendixTable = renderIncumbentResponseRiskTable(source);
  assert.match(appendixTable, /Final Suite Leader/u);
  assert.match(appendixTable, /Historical Suite Leader/u);
});

test("responder narrative preserves unknown and not-applicable states and localizes fixed enums", () => {
  const source = {
    current_decision_subject_ids: ["subject_assessed", "subject_unknown", "subject_na"],
    report_subject_labels: [
      { subject_id: "subject_assessed", label: "已评估方向" },
      { subject_id: "subject_unknown", label: "未知方向" },
      { subject_id: "subject_na", label: "不适用方向" },
    ],
    report_citations: reportCitations(),
    incumbent_response_risk_rows: [
      responseRow({
        ...assessedSemantic("subject_assessed", "头部套件公司"),
        responder_category: "套件型头部公司",
      }),
      responseRow({
        subject_id: "subject_unknown",
        analysis_state: "unknown",
        supporting_evidence_refs: ["evidence/records/responder-support.json"],
        opposing_evidence_refs: ["evidence/records/responder-opposition.json"],
        background_evidence_refs: ["evidence/records/responder-background.json"],
        uncertainty: "响应者身份、意愿和时点尚未解决。",
        unknowns: ["实际响应者与响应时点。"],
        data_gaps: ["缺少内部路线图。"],
      }),
      responseRow({
        subject_id: "subject_na",
        analysis_state: "not_applicable",
        inference_boundary: "在当前边界内没有相关响应控制点。",
        background_evidence_refs: ["evidence/records/responder-background.json"],
      }),
    ],
  };

  const narrative = renderIncumbentResponseNarratives(source, true);
  assert.ok(narrative.includes(INCUMBENT_RESPONSE_STRATEGIC_CONTEXT_ZH));
  assert.match(narrative, /能力（不代表意愿）.*高/su);
  assert.match(narrative, /功能复制.*捆绑提供.*原生集成/su);
  assert.match(narrative, /中期/u);
  assert.match(narrative, /单项功能/u);
  assert.match(narrative, /状态: 未知/u);
  assert.match(narrative, /均保持未知/u);
  assert.match(narrative, /不适用/u);
  assert.match(narrative, /均保持不适用/u);
  assert.doesNotMatch(
    narrative,
    /\b(?:native_integration|medium_term|single_feature|targeted_deep_dive)\b/u,
  );
  assert.doesNotMatch(narrative, /evidence\/records\//u);
});

test("terminal core report uses the same final-subject responder authority", () => {
  const source = {
    research_language: "en-US",
    decision_question: "Which synthetic direction should remain current?",
    research_conclusion: {
      current_recommendation: "Retain the final synthetic direction for bounded research.",
      meaning: "No market validation is claimed.",
      allowed_claim: "A research direction remains visible.",
    },
    freshness: { summary: "SYNTHETIC freshness fixture." },
    execution: {
      completeness: "partial",
      completed_stages: [],
      incomplete_stages: [],
      required_followups: [],
    },
    runtime_health: { status: "healthy", issues: [] },
    directions: [],
    sources: [],
    research_provenance: {
      causal_handoff_refs: [],
      consumed_handoff_refs: [],
      available_handoff_refs: [],
      used_handoff_items: [],
      revalidation_gaps: [],
    },
    ordered_validation_plan: [],
    limitations: ["SYNTHETIC report fixture; no external research was performed."],
    current_decision_subject_ids: ["subject_final"],
    report_subject_labels: [{ subject_id: "subject_final", label: "Final Direction" }],
    report_citations: reportCitations(),
    incumbent_response_risk_rows: [
      responseRow(assessedSemantic("subject_final", "Final Suite Leader")),
      responseRow(assessedSemantic("subject_history", "Historical Suite Leader")),
    ],
  };
  const report = renderTerminalFullReport(source);
  assert.match(report, /Final Direction/u);
  assert.match(report, /Ability \(not willingness\)/u);
  assert.match(report, /feature copying is not full coverage/iu);
  assert.doesNotMatch(report, /Historical Suite Leader/u);
});

function minimalAudit(
  subjectIds: readonly string[],
  includeResponse: boolean,
): Record<string, unknown> {
  return {
    covered_direction_ids: [...subjectIds],
    subject_assessments: subjectIds.map((subjectId) => ({
      subject_id: subjectId,
      coverage: {},
      wave1_signals: { demand: false, buyer: false, purchase: false },
      recommendation_ceiling: {
        maximum_decision_tier: "investigate_further",
        reason_codes: ["missing_purchase_or_payment_signal"],
      },
    })),
    evidence_register: [],
    quantitative_observations: [],
    quantitative_coverage: [],
    competitive_objects: [],
    competitive_coverage: [],
    search_closure: { remaining_gaps: [] },
    incumbent_response_assessments: includeResponse
      ? subjectIds.map((subjectId) => ({
          assessment_id: `response_${subjectId}`,
          analysis_depth: "targeted_deep_dive",
          semantic: assessedSemantic(subjectId, `Responder ${subjectId}`),
        }))
      : [],
    incumbent_response_coverage: includeResponse
      ? subjectIds.map((subjectId) => ({ subject_id: subjectId, state: "assessed" }))
      : [],
    limitations: [],
  };
}

test("commercial projection cache reuses exact closures and responder context cannot raise decisions", () => {
  const withoutResponse = createCommercialAuditProjector([
    { path: "artifacts/research-audits/base.json", document: minimalAudit(["a", "b"], false) },
  ]);
  const withResponse = createCommercialAuditProjector([
    {
      path: "artifacts/research-audits/response.json",
      document: minimalAudit(["a", "b"], true),
    },
  ]);

  const first = withResponse.project(["a"]);
  const replay = withResponse.project(["a", "a"]);
  assert.strictEqual(replay, first);
  assert.deepEqual(withResponse.diagnostics(), { projectionComputations: 1, cacheHits: 1 });
  const sibling = withResponse.project(["b"]);
  assert.deepEqual(withResponse.diagnostics(), { projectionComputations: 2, cacheHits: 1 });
  assert.deepEqual(
    first.commercial_subject_aggregates.map((entry) => entry.subject_id),
    ["a"],
  );
  assert.deepEqual(
    sibling.commercial_subject_aggregates.map((entry) => entry.subject_id),
    ["b"],
  );

  const baseAggregate = withoutResponse.project(["a"]).commercial_subject_aggregates[0];
  const responseAggregate = first.commercial_subject_aggregates[0];
  assert.ok(baseAggregate);
  assert.ok(responseAggregate);
  for (const field of [
    "ranking_eligibility",
    "recommendation_ceiling",
    "market_research_priority",
    "commercial_validation_readiness",
  ]) {
    assert.deepEqual(responseAggregate[field], baseAggregate[field], field);
  }
});

test("artifact validator reuses only a successfully loaded same-root graph and evicts failures", async (t) => {
  const concurrent = await Promise.all([
    createArtifactValidator(repositoryRoot),
    createArtifactValidator(path.join(repositoryRoot, ".")),
    createArtifactValidator(repositoryRoot),
  ]);
  assert.strictEqual(concurrent[0], concurrent[1]);
  assert.strictEqual(concurrent[1], concurrent[2]);
  const valid = concurrent[0]?.validateDocument({
    schema_version: "startup_opportunity.event.v1",
    event_id: "batch5_validator_cache",
    run_id: "batch5-validator-cache",
    event_type: "decision_context_written",
    timestamp: createdAt,
    actor: "harness",
    reason: "SYNTHETIC validator cache parity fixture.",
    artifact_refs: [],
  });
  assert.equal(valid?.valid, true);

  const copyRoot = await mkdtemp(path.join(tmpdir(), "startup-opportunity-validator-cache-"));
  t.after(() => rm(copyRoot, { recursive: true, force: true }));
  await mkdir(path.join(copyRoot, "harness"), { recursive: true });
  await cp(path.join(repositoryRoot, "harness/schemas"), path.join(copyRoot, "harness/schemas"), {
    recursive: true,
  });
  await cp(path.join(repositoryRoot, "harness/policies"), path.join(copyRoot, "harness/policies"), {
    recursive: true,
  });
  const policyPath = path.join(copyRoot, "harness/policies/research-publication.current.json");
  await rm(policyPath);
  await assert.rejects(createArtifactValidator(copyRoot));
  await cp(
    path.join(repositoryRoot, "harness/policies/research-publication.current.json"),
    policyPath,
  );
  const repaired = await createArtifactValidator(copyRoot);
  assert.equal(repaired.validateDocument({ schema_version: "not.a.contract" }).valid, false);
  assert.strictEqual(await createArtifactValidator(copyRoot), repaired);
});

function compilationRequest(runId: string): Record<string, unknown> {
  const document = {
    schema_version: "startup_opportunity.event.v1",
    event_id: "batch5_observability_event",
    run_id: runId,
    event_type: "decision_context_written",
    timestamp: "2026-08-13T12:00:01Z",
    actor: "harness",
    reason: "SYNTHETIC observability fixture; no research was performed.",
    artifact_refs: [],
  };
  return {
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: "batch5_observability_request",
    run_id: runId,
    operation: "validate_only",
    created_at: document.timestamp,
    artifacts: [
      {
        artifact_type: document.schema_version,
        artifact_path: "artifacts/runtime/batch5-observability-event.json",
        producer_role: "harness",
        document,
      },
    ],
  };
}

async function observabilityRun(t: TestContext): Promise<{
  readonly runsRoot: string;
  readonly runId: string;
  readonly store: RunStore;
  readonly compiler: DeclarativeRuntimeCompiler;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-batch5-observe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "batch5-observability-run";
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(
    store,
    {
      runId,
      mode: "opportunity_discovery",
      scopeProposal: {
        geography: "Synthetic",
        customerModel: "b2c",
        targetUsers: ["synthetic user"],
        decisionGoal: "Exercise deterministic observability.",
        researchLanguage: "en-US",
      },
      createdAt,
    },
    "2026-08-13T12:00:00Z",
  );
  return {
    runsRoot,
    runId,
    store,
    compiler: new DeclarativeRuntimeCompiler(runsRoot, validator, repositoryRoot),
  };
}

function withoutTiming<T extends { readonly timing_ms: unknown }>(value: T): Omit<T, "timing_ms"> {
  const clone = structuredClone(value) as T & { timing_ms?: unknown };
  delete clone.timing_ms;
  return clone;
}

test("structured operation traces are ordered, bounded to mechanics, and observer-safe", () => {
  const observations: OperationObservation[] = [];
  const trace = operationTrace("operation_batch5", "runtime_compile", (event) => {
    observations.push(event);
  });
  trace.start("validation", { z_count: 2, invalid_count: -1, a_count: 1 });
  trace.complete("validation", { result_count: 1 });
  trace.fail("operation", "runtime.synthetic_failure");
  assert.deepEqual(
    observations.map((entry) => [entry.sequence, entry.phase, entry.state]),
    [
      [1, "validation", "started"],
      [2, "validation", "completed"],
      [3, "operation", "failed"],
    ],
  );
  assert.deepEqual(observations[0]?.counts, { a_count: 1, z_count: 2 });
  assert.equal(observations[1]?.phaseDurationMs === null, false);
  assert.equal(observations[2]?.errorCode, "runtime.synthetic_failure");
  assert.doesNotThrow(() =>
    operationTrace("throwing_observer", "run_recovery", () => {
      throw new Error("observer failure");
    }).start("operation", { item_count: 1 }),
  );
});

test("lane materialization failure emits only bounded mechanics and preserves the primary error", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const observations: OperationObservation[] = [];
  const materializer = new LaneResultMaterializer(
    path.join(tmpdir(), "batch5-unused-runs"),
    validator,
    repositoryRoot,
  );
  await assert.rejects(
    materializer.materialize(
      {
        staging_id: "batch5_invalid_staging",
        secret_raw_bytes: "DO_NOT_EMIT_LANE_BYTES",
      },
      { observe: (event) => observations.push(event) },
    ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "runtime.lane_staging_invalid",
  );
  assert.deepEqual(
    observations.map((entry) => `${entry.phase}:${entry.state}`),
    ["lane_delivery:started", "lane_delivery:failed"],
  );
  assert.equal(observations.at(-1)?.errorCode, "runtime.lane_staging_invalid");
  assert.doesNotMatch(JSON.stringify(observations), /DO_NOT_EMIT_LANE_BYTES/u);
});

test("compiler and reopen results retain parity with disabled or failing observers", async (t) => {
  const state = await observabilityRun(t);
  const request = compilationRequest(state.runId);
  const baseline = await state.compiler.compile(request);
  const observations: OperationObservation[] = [];
  const observed = await state.compiler.compile(request, {
    observe: (event) => observations.push(event),
  });
  assert.deepEqual(withoutTiming(observed), withoutTiming(baseline));
  assert.deepEqual(
    observations.map((entry) => `${entry.phase}:${entry.state}`),
    [
      "operation:started",
      "request_validation:started",
      "request_validation:completed",
      "current_run_resolution:started",
      "current_run_resolution:completed",
      "artifact_compilation:started",
      "artifact_compilation:completed",
      "closure_validation:started",
      "closure_validation:completed",
      "publication:started",
      "publication:completed",
      "operation:completed",
    ],
  );
  assert.deepEqual(observations.at(-1)?.counts, {
    closure_documents: observed.validation_closure.document_count,
    compiled_artifacts: observed.compiled_envelopes.length,
    exact_records: observed.validation_closure.exact_record_count,
    resolved_references: observed.publication_plan.resolved_references.length,
  });
  const throwing = await state.compiler.compile(request, {
    observe: () => {
      throw new Error("SYNTHETIC observer failure");
    },
  });
  assert.deepEqual(withoutTiming(throwing), withoutTiming(baseline));

  const failedObservations: OperationObservation[] = [];
  await assert.rejects(
    state.compiler.compile(
      { secret_raw_bytes: "DO_NOT_EMIT_THIS_VALUE" },
      { observe: (event) => failedObservations.push(event) },
    ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "runtime.compilation_request_invalid",
  );
  assert.equal(failedObservations.at(-1)?.state, "failed");
  assert.equal(failedObservations.at(-1)?.errorCode, "runtime.compilation_request_invalid");
  assert.doesNotMatch(JSON.stringify(failedObservations), /DO_NOT_EMIT_THIS_VALUE/u);

  const loaded = await state.store.load(state.runId);
  const recoveryObservations: OperationObservation[] = [];
  const observedLoad = await state.store.load(state.runId, {
    observe: (event) => recoveryObservations.push(event),
  });
  assert.deepEqual(observedLoad, loaded);
  assert.deepEqual(
    recoveryObservations.map((entry) => `${entry.phase}:${entry.state}`),
    [
      "operation:started",
      "execution_resolution:started",
      "execution_resolution:completed",
      "recovery_validation:started",
      "recovery_validation:completed",
      "operation:completed",
    ],
  );
});

test("load-run --observe keeps the result on stdout and emits machine-readable stderr JSONL", async (t) => {
  const state = await observabilityRun(t);
  const command = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "load-run",
      "--runs-root",
      state.runsRoot,
      "--run-id",
      state.runId,
      "--observe",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(command.status, 0, command.stderr);
  const result = JSON.parse(command.stdout) as Record<string, unknown>;
  assert.equal(result.schemaVersion, "startup_opportunity.load_run_result.v1");
  const observations = command.stderr
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OperationObservation);
  assert.ok(observations.length >= 6);
  assert.equal(observations[0]?.operation, "run_recovery");
  assert.equal(observations.at(-1)?.state, "completed");
  assert.doesNotMatch(command.stderr, /userConfirmationAttestation|decisionGoal|targetUsers/u);
});

test("compile-artifacts --observe preserves stdout result and emits phase/count JSONL", async (t) => {
  const state = await observabilityRun(t);
  const requestPath = path.join(path.dirname(state.runsRoot), "compile-request.json");
  await writeFile(requestPath, `${JSON.stringify(compilationRequest(state.runId))}\n`);
  const command = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "compile-artifacts",
      "--runs-root",
      state.runsRoot,
      "--file",
      requestPath,
      "--observe",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(command.status, 0, command.stderr);
  const result = JSON.parse(command.stdout) as Record<string, unknown>;
  assert.equal(result.status, "validated");
  const observations = command.stderr
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OperationObservation);
  assert.equal(observations[0]?.operation, "runtime_compile");
  assert.equal(observations.at(-1)?.phase, "operation");
  assert.equal(observations.at(-1)?.state, "completed");
  assert.doesNotMatch(command.stderr, /SYNTHETIC observability fixture/u);
});

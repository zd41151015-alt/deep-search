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
  validateDecisionSubjectContract,
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
  G23_SOLUTION_ALT,
  G23_SOLUTION_ALT_CONVERSION,
  G23_SOLUTION_CONVERSION,
  G23_SOLUTION_REJECTED,
  G23_SOLUTION_REJECTED_CONVERSION,
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

interface DecisionSubjectProjectionDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
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

function collectTypedRefs(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(collectTypedRefs);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    if ((key.endsWith("_refs") || key === "input_refs") && Array.isArray(child)) {
      return child.filter(
        (ref): ref is string => typeof ref === "string" && (ref.includes("/") || ref.includes("#")),
      );
    }
    if (
      (key.endsWith("_ref") || key.endsWith("_refs") || key === "ref") &&
      typeof child === "string" &&
      (child.includes("/") || child.includes("#"))
    ) {
      return [child];
    }
    return collectTypedRefs(child);
  });
}

async function treeSnapshot(root: string, relative = ""): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const candidate of (await readdir(path.join(root, relative), { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const child = path.posix.join(relative, candidate.name);
    if (candidate.isDirectory()) {
      Object.assign(snapshot, await treeSnapshot(root, child));
    } else if (candidate.isFile()) {
      snapshot[child] = (await readFile(path.join(root, child))).toString("base64");
    }
  }
  return snapshot;
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

const COMPARED_SYNTHESIS_PATHS = new Set([
  ...SYNTHESIS_PATHS,
  G23_SOLUTION_ALT_CONVERSION,
  G23_SOLUTION_ALT,
  G23_SOLUTION_REJECTED_CONVERSION,
  G23_SOLUTION_REJECTED,
]);

function synthesisEnvelopes(bundle: DocumentBundle): FormalArtifactEnvelope[] {
  return currentEnvelopes(bundle).filter((candidate) =>
    SYNTHESIS_PATHS.has(candidate.artifact_path),
  );
}

function comparedSynthesisEnvelopes(bundle: DocumentBundle): FormalArtifactEnvelope[] {
  return currentEnvelopes(bundle).filter((candidate) =>
    COMPARED_SYNTHESIS_PATHS.has(candidate.artifact_path),
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
  const consideredRefs = [...new Set(consideredApproaches.flatMap(collectTypedRefs))].sort();
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
    if (consideredRefs.length > 0) {
      opportunityEnvelope.input_refs = [
        ...new Set([...(opportunityEnvelope.input_refs as string[]), ...consideredRefs]),
      ].sort();
    }
    refresh(bundle, opportunityRef);
  }
  const evaluationEnvelope = entry(bundle, G23_EVALUATION);
  if (consideredRefs.length > 0) {
    evaluationEnvelope.input_refs = [
      ...new Set([...(evaluationEnvelope.input_refs as string[]), ...consideredRefs]),
    ].sort();
    refresh(bundle, G23_EVALUATION);
  }
}

function buildOpportunityTerminalProjection(state: State): {
  readonly documents: DecisionSubjectProjectionDocument[];
  readonly opportunityPath: string;
  readonly snapshotPath: string;
  readonly synthesisPath: string;
  readonly terminalPath: string;
  readonly opportunitySummary: Record<string, unknown>;
} {
  const text = (value: unknown, fallback: string): string =>
    typeof value === "string" && value.length > 0 ? value : fallback;
  const firstText = (value: unknown, fallback: string): string =>
    Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0
      ? value[0]
      : fallback;
  const strings = (value: unknown, fallback: readonly string[]): string[] => {
    const values = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
    return values.length > 0 ? values : [...fallback];
  };

  const opportunityPath = G23_OPPORTUNITY_A;
  const snapshotPath = "artifacts/reporting/decision-subject-snapshot.r1.json";
  const synthesisPath =
    "artifacts/reporting/decision-subject-synthesis/opportunity-terminal-posture.r1.json";
  const terminalPath = "artifacts/reporting/terminal-report-source.r1.json";

  const manifest = clone(effective(state.bundle, "manifest.json"));
  const scope = clone(effective(state.bundle, G21_SCOPE_REF));
  const plan = clone(effective(state.bundle, G21_PLAN_REF));
  const opportunity = clone(effective(state.bundle, opportunityPath));
  assert.ok(
    typeof opportunity.solution_evaluation_summary === "object" &&
      opportunity.solution_evaluation_summary !== null,
  );
  const opportunitySummary = structuredClone(
    opportunity.solution_evaluation_summary as Record<string, unknown>,
  );
  const opportunityHash = canonicalContentHash(opportunity);
  const opportunityId = text(opportunity.opportunity_id, "opportunity_terminal_posture");

  const snapshotDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.decision_subject_snapshot.current",
    snapshot_id: "decision_subjects_opportunity_terminal_posture",
    revision: 1,
    parent_snapshot_ref: null,
    parent_snapshot_hash: null,
    run_id: state.runId,
    mode: "opportunity_discovery",
    scope_frame_ref: G21_SCOPE_REF,
    scope_frame_hash: canonicalContentHash(scope),
    research_plan_ref: G21_PLAN_REF,
    research_plan_hash: canonicalContentHash(plan),
    synthesis_input_hashes: [{ ref: opportunityPath, content_hash: opportunityHash }],
    created_at: "2026-08-10T12:00:00Z",
    subjects: [
      {
        subject_id: opportunityId,
        subject_ref: opportunityPath,
        subject_content_hash: opportunityHash,
        subject_kind: "opportunity_thesis",
        lifecycle_status: "current",
        reporting_role: "final",
        superseded_by_subject_id: null,
        formation_reason:
          "SYNTHETIC current Opportunity Thesis subject for terminal posture projection.",
        lifecycle_reason:
          "SYNTHETIC current final subject for the opportunity terminal posture regression.",
      },
    ],
    limitations: ["SYNTHETIC decision subject snapshot; not market Evidence."],
  };
  const snapshotHash = canonicalContentHash(snapshotDocument);
  manifest.current_plan_ref = G21_PLAN_REF;
  manifest.current_decision_subject_snapshot_ref = snapshotPath;
  manifest.current_decision_subject_snapshot_hash = snapshotHash;

  const direction = {
    priority: 1,
    ranking_status: "ranked",
    label: text(opportunity.title, "SYNTHETIC opportunity terminal posture"),
    maturity: "supported_opportunity_thesis",
    action: "validate",
    target_user: firstText(opportunity.buyer, "SYNTHETIC buyer"),
    narrow_scenario: text(opportunity.entry_scene, "SYNTHETIC narrow scenario"),
    problem: text(opportunity.opportunity_thesis, "SYNTHETIC problem"),
    current_alternative: text(opportunity.mental_positioning, "SYNTHETIC current alternative"),
    payer: firstText(opportunity.payer, "SYNTHETIC payer"),
    product_form: text(opportunity.selected_delivery_form, "SYNTHETIC product form"),
    core_value: text(opportunity.incremental_value_over_baseline, "SYNTHETIC core value"),
    why_now: text(opportunity.why_now, "SYNTHETIC why now"),
    key_risks: strings(opportunity.risks, ["SYNTHETIC opportunity risk"]),
    first_testable_assumption:
      "SYNTHETIC current Opportunity keeps its implementation posture as provisional.",
    comparison_reason:
      "SYNTHETIC report projection preserves the structured implementation posture.",
    decisive_support_source_ids: [],
    decisive_opposition_source_ids: [],
    open_questions: ["SYNTHETIC remaining solution exploration question."],
    solution_evaluation_summary: structuredClone(opportunitySummary),
  };
  const validationStep = {
    order: 1,
    hypothesis: "SYNTHETIC terminal projection preserves the Opportunity solution posture.",
    why_now: "SYNTHETIC current contract requires exact same-Run posture projection.",
    method: "desk_research",
    pass_signal: "The terminal source retains the exact Opportunity solution summary.",
    fail_signal: "A solution posture value drifts in synthesis or terminal projection.",
    decision_effect: "Reject the terminal projection when the posture drifts.",
    execution_owner: "main_agent",
    execution_supported: true,
    result_tracking_supported: true,
  };
  const synthesisDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.decision_subject_synthesis.current",
    synthesis_id: "decision_subject_synthesis_opportunity_terminal_posture_r1",
    run_id: state.runId,
    subject_id: opportunityId,
    subject_ref: opportunityPath,
    subject_content_hash: opportunityHash,
    synthesis_basis_hashes: [{ ref: opportunityPath, content_hash: opportunityHash }],
    direction,
    validation_steps: [validationStep],
    created_at: "2026-08-10T12:00:30Z",
    limitations: ["SYNTHETIC decision subject synthesis; not market Evidence."],
  };
  const synthesisHash = canonicalContentHash(synthesisDocument);
  const terminalDocument: Record<string, unknown> = {
    schema_version: "startup_opportunity.terminal_report_source.v1",
    report_id: "terminal_opportunity_posture",
    run_id: state.runId,
    mode: "opportunity_discovery",
    research_language: "en-US",
    producer_role: "main_agent",
    owned_output_path: terminalPath,
    materialized_path: "report.json",
    generated_at: "2026-08-10T12:01:00Z",
    decision_subject_snapshot_ref: snapshotPath,
    decision_subject_snapshot_hash: snapshotHash,
    decision_subject_synthesis_hashes: [{ ref: synthesisPath, content_hash: synthesisHash }],
    current_decision_subject_ids: [opportunityId],
    terminal_outcome: "completed",
    decision_question: "SYNTHETIC opportunity terminal posture projection.",
    execution: {
      completeness: "complete",
      completed_stages: ["opportunity_discovery", "decision_subject_synthesis"],
      incomplete_stages: [],
      required_followups: [],
      pending_operation_refs: [],
    },
    research_conclusion: {
      outcome: "investigate_further",
      current_recommendation:
        "SYNTHETIC retain the Opportunity while its implementation remains provisional.",
      meaning: "SYNTHETIC opportunity priority and implementation posture are separate structures.",
      evidence_strength: "insufficient",
      allowed_claim: "SYNTHETIC the implementation posture is mechanically projected.",
    },
    runtime_health: { status: "healthy", issues: [] },
    directions: [
      {
        direction_id: opportunityId,
        subject_ref: opportunityPath,
        subject_content_hash: opportunityHash,
        synthesis_ref: synthesisPath,
        synthesis_content_hash: synthesisHash,
        ...structuredClone(direction),
      },
    ],
    sources: [],
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
    ordered_validation_plan: [
      {
        direction_id: opportunityId,
        subject_ref: opportunityPath,
        subject_content_hash: opportunityHash,
        synthesis_ref: synthesisPath,
        synthesis_content_hash: synthesisHash,
        ...structuredClone(validationStep),
      },
    ],
    freshness: {
      earliest_valid_as_of: null,
      latest_valid_as_of: null,
      summary: "SYNTHETIC terminal posture projection; no market Evidence is asserted.",
    },
    limitations: ["SYNTHETIC terminal source fixture; not market Evidence."],
    external_action_boundary: {
      execution_owner: "user",
      execution_supported: false,
      result_tracking_supported: false,
      external_validation_claimed: false,
    },
    audit_refs: [],
  };

  const document = (
    artifactPath: string,
    artifactDocument: Record<string, unknown>,
    envelope: Record<string, unknown> | null = null,
  ): DecisionSubjectProjectionDocument => ({
    path: artifactPath,
    schemaVersion: String(artifactDocument.schema_version),
    document: artifactDocument,
    envelope,
  });

  return {
    documents: [
      document("manifest.json", manifest),
      document(G21_SCOPE_REF, scope),
      document(G21_PLAN_REF, plan),
      document(opportunityPath, opportunity),
      document(snapshotPath, snapshotDocument),
      document(synthesisPath, synthesisDocument, {
        artifact_type: "startup_opportunity.decision_subject_synthesis.current",
        artifact_path: synthesisPath,
        run_id: state.runId,
        producer_role: "main_agent",
        content_hash: synthesisHash,
      }),
      document(terminalPath, terminalDocument),
    ],
    opportunityPath,
    snapshotPath,
    synthesisPath,
    terminalPath,
    opportunitySummary,
  };
}

async function setup(
  context: TestContext,
  suffix: string,
  solutionExplorationVariant: "single" | "compared" = "single",
): Promise<State> {
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
  const bundle = await createDiscoverySynthesisFixture(
    runId,
    { generation, evaluation },
    [],
    "general",
    "en-US",
    solutionExplorationVariant,
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

test("G2.3 compared exploration preserves all formal solutions and compared selection posture", async (context) => {
  const state = await setup(context, "compared-closure", "compared");
  const validator = await createArtifactValidator(repositoryRoot);
  await publishThroughFanIn(state);
  const result = validator.validateDocumentBundle(state.bundle);
  assert.equal(result.valid, true, JSON.stringify(result.referenceErrors, null, 2));
  const evaluation = effective(state.bundle, G23_EVALUATION);
  assert.equal((evaluation.solution_hypothesis_refs as string[]).length, 3);
  const summary = effective(state.bundle, G23_OPPORTUNITY_A).solution_evaluation_summary as Record<
    string,
    unknown
  >;
  assert.equal(summary.exploration_status, "compared_multiple_formal_solutions");
  assert.equal(summary.selection_posture, "compared_selection");
  assert.deepEqual(
    (summary.formal_solution_refs as string[]).sort(),
    [G23_SOLUTION, G23_SOLUTION_ALT, G23_SOLUTION_REJECTED].sort(),
  );
  assert.deepEqual(
    (summary.formal_solutions as Record<string, unknown>[]).map((entry) =>
      String(entry.disposition),
    ),
    ["selected", "alternative", "rejected"],
  );
  const first = await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: comparedSynthesisEnvelopes(state.bundle),
  });
  assert.ok(first.artifacts.every((artifact) => artifact.status === "published"));
  const replay = await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: comparedSynthesisEnvelopes(state.bundle),
  });
  assert.ok(replay.artifacts.every((artifact) => artifact.status === "idempotent_replay"));
  const loaded = await state.store.load(state.runId);
  assert.ok(loaded.manifest.artifact_refs.includes(G23_SOLUTION_ALT));
  assert.ok(loaded.manifest.artifact_refs.includes(G23_SOLUTION_REJECTED));
});

test("G2.3 rejects solution evaluation summaries without formal_solutions and writes nothing", async (context) => {
  const state = await setup(context, "formal-solutions-required", "compared");
  const validator = await createArtifactValidator(repositoryRoot);
  await publishThroughFanIn(state);
  const bundle = clone(state.bundle);
  delete (
    effective(bundle, G23_OPPORTUNITY_A).solution_evaluation_summary as Record<string, unknown>
  ).formal_solutions;
  refresh(bundle, G23_OPPORTUNITY_A);
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, false);
  assert.ok(
    result.documents
      .flatMap((document) => document.errors)
      .some((error) => error.code === "schema.required"),
    JSON.stringify(result.documents, null, 2),
  );
  const before = await treeSnapshot(state.runRoot);
  await assert.rejects(
    state.store.publishArtifactBundle({
      runId: state.runId,
      envelopes: comparedSynthesisEnvelopes(bundle),
    }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.schema_invalid",
  );
  assert.deepEqual(await treeSnapshot(state.runRoot), before);
});

test("G2.3 projects provisional Opportunity solution posture through synthesis and terminal source exactly", async (context) => {
  const state = await setup(context, "terminal-posture");
  const validator = await createArtifactValidator(repositoryRoot);
  const projection = buildOpportunityTerminalProjection(state);
  assert.equal(projection.opportunitySummary.selection_posture, "provisional_implementation");
  assert.equal(projection.opportunitySummary.exploration_status, "not_yet_explored");

  for (const document of projection.documents) {
    const result = validator.validateDocument(document.document, document.path);
    assert.equal(result.valid, true, `${document.path}: ${JSON.stringify(result.errors, null, 2)}`);
  }
  assert.deepEqual(validateDecisionSubjectContract(projection.documents), []);

  const findDocument = (
    documents: readonly DecisionSubjectProjectionDocument[],
    artifactPath: string,
  ): DecisionSubjectProjectionDocument => {
    const document = documents.find((candidate) => candidate.path === artifactPath);
    assert.ok(document, artifactPath);
    return document;
  };

  const synthesisDrift = clone(
    projection.documents.filter((document) => document.path !== projection.terminalPath),
  );
  const driftedSynthesis = findDocument(synthesisDrift, projection.synthesisPath);
  const driftedSynthesisDirection = driftedSynthesis.document.direction as Record<string, unknown>;
  const driftedSynthesisSummary = driftedSynthesisDirection.solution_evaluation_summary as Record<
    string,
    unknown
  >;
  driftedSynthesisSummary.selection_posture = "compared_selection";
  assert.equal(
    validator.validateDocument(driftedSynthesis.document, projection.synthesisPath).valid,
    true,
  );
  assert.ok(driftedSynthesis.envelope);
  driftedSynthesis.envelope.content_hash = canonicalContentHash(driftedSynthesis.document);
  assert.deepEqual(
    validateDecisionSubjectContract(synthesisDrift).map((issue) => issue.code),
    ["decision_subject.solution_exploration_projection_mismatch"],
  );

  const terminalDrift = clone(projection.documents);
  const driftedTerminal = findDocument(terminalDrift, projection.terminalPath);
  const driftedDirection = (driftedTerminal.document.directions as Record<string, unknown>[])[0];
  assert.ok(driftedDirection);
  const driftedTerminalSummary = driftedDirection.solution_evaluation_summary as Record<
    string,
    unknown
  >;
  driftedTerminalSummary.selection_posture = "compared_selection";
  assert.equal(
    validator.validateDocument(driftedTerminal.document, projection.terminalPath).valid,
    true,
  );
  assert.deepEqual(
    validateDecisionSubjectContract(terminalDrift).map((issue) => issue.code),
    ["decision_subject.direction_body_mismatch"],
  );
});

test("G2.3 rejects not_yet_explored when multiple formal solutions remain and writes nothing", async (context) => {
  const state = await setup(context, "not-yet-explored-multi", "compared");
  const validator = await createArtifactValidator(repositoryRoot);
  await publishThroughFanIn(state);
  const bundle = clone(state.bundle);
  setSolutionExplorationState(bundle, "not_yet_explored");
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, false);
  assert.ok(
    result.referenceErrors.some(
      (error) =>
        error.code === "synthesis.solution_evaluation_mismatch" ||
        error.code === "schema.maxItems" ||
        error.code === "schema.minItems",
    ),
    JSON.stringify(result.referenceErrors, null, 2),
  );
  const before = await treeSnapshot(state.runRoot);
  await assert.rejects(
    state.store.publishArtifactBundle({
      runId: state.runId,
      envelopes: comparedSynthesisEnvelopes(bundle),
    }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.schema_invalid",
  );
  assert.deepEqual(await treeSnapshot(state.runRoot), before);
});

test("G2.3 rejects considered approaches whose material is not reachable from the current solution lineage", async (context) => {
  const state = await setup(context, "lineage-unrelated");
  const validator = await createArtifactValidator(repositoryRoot);
  await publishThroughFanIn(state);
  const bundle = clone(state.bundle);
  const unrelatedMaterial = effective(bundle, G22_GENERATION_CLAIM);
  const lineage = unrelatedMaterial.lineage as Record<string, unknown>;
  lineage.candidate_refs = [G22_DEMAND_R2];
  refresh(bundle, G22_GENERATION_CLAIM);
  const approach = {
    approach_id: "approach_unrelated_material",
    implementation_direction: "SYNTHETIC unrelated implementation direction",
    disposition: "not_formalized",
    disposition_reasons: ["SYNTHETIC no formalization retained."],
    material_bindings: [
      {
        ref: G22_GENERATION_CLAIM,
        content_hash: canonicalContentHash(unrelatedMaterial),
      },
    ],
    unknowns: ["SYNTHETIC unknown"],
    limitations: ["SYNTHETIC limitation"],
  };
  setSolutionExplorationState(bundle, "explored_no_other_formal_solution", [approach]);
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, false);
  assert.ok(
    result.referenceErrors.some(
      (error) => error.code === "synthesis.considered_approach_material_binding_mismatch",
    ),
    JSON.stringify(result.referenceErrors, null, 2),
  );
  const before = await treeSnapshot(state.runRoot);
  await assert.rejects(
    state.store.publishArtifactBundle({
      runId: state.runId,
      envelopes: synthesisEnvelopes(bundle),
    }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.reference_invalid",
  );
  assert.deepEqual(await treeSnapshot(state.runRoot), before);
});

test("G2.3 rejects considered approaches with wrong task or subject binding and writes nothing", async (context) => {
  const state = await setup(context, "lineage-bad-binding");
  const validator = await createArtifactValidator(repositoryRoot);
  await publishThroughFanIn(state);

  const wrongTaskBundle = clone(state.bundle);
  const wrongTaskMaterial = effective(wrongTaskBundle, G22_EVALUATION_CLAIM);
  (wrongTaskMaterial.lineage as Record<string, unknown>).task_ref =
    "tasks/discovery/unrelated.attempt-1.json";
  refresh(wrongTaskBundle, G22_EVALUATION_CLAIM);
  setSolutionExplorationState(wrongTaskBundle, "explored_no_other_formal_solution", [
    {
      approach_id: "approach_wrong_task",
      implementation_direction: "SYNTHETIC wrong-task implementation direction",
      disposition: "not_formalized",
      disposition_reasons: ["SYNTHETIC no formalization retained."],
      material_bindings: [
        {
          ref: G22_EVALUATION_CLAIM,
          content_hash: canonicalContentHash(wrongTaskMaterial),
        },
      ],
      unknowns: ["SYNTHETIC unknown"],
      limitations: ["SYNTHETIC limitation"],
    },
  ]);
  const wrongTaskResult = validator.validateDocumentBundle(wrongTaskBundle);
  assert.equal(wrongTaskResult.valid, false);
  assert.ok(
    wrongTaskResult.referenceErrors.some(
      (error) => error.code === "synthesis.considered_approach_material_binding_mismatch",
    ),
    JSON.stringify(wrongTaskResult.referenceErrors, null, 2),
  );
  const wrongTaskBefore = await treeSnapshot(state.runRoot);
  await assert.rejects(
    state.store.publishArtifactBundle({
      runId: state.runId,
      envelopes: synthesisEnvelopes(wrongTaskBundle),
    }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.reference_invalid",
  );
  assert.deepEqual(await treeSnapshot(state.runRoot), wrongTaskBefore);

  const wrongSubjectBundle = clone(state.bundle);
  const wrongSubjectMaterial = effective(wrongSubjectBundle, G22_BASELINE_EVALUATION_JUDGMENT);
  wrongSubjectMaterial.subject_ref = "artifacts/discovery/candidates/candidate_ghost.r1.json";
  refresh(wrongSubjectBundle, G22_BASELINE_EVALUATION_JUDGMENT);
  setSolutionExplorationState(wrongSubjectBundle, "explored_no_other_formal_solution", [
    {
      approach_id: "approach_wrong_subject",
      implementation_direction: "SYNTHETIC wrong-subject implementation direction",
      disposition: "not_formalized",
      disposition_reasons: ["SYNTHETIC no formalization retained."],
      material_bindings: [
        {
          ref: G22_BASELINE_EVALUATION_JUDGMENT,
          content_hash: canonicalContentHash(wrongSubjectMaterial),
        },
      ],
      unknowns: ["SYNTHETIC unknown"],
      limitations: ["SYNTHETIC limitation"],
    },
  ]);
  const wrongSubjectResult = validator.validateDocumentBundle(wrongSubjectBundle);
  assert.equal(wrongSubjectResult.valid, false);
  assert.ok(
    wrongSubjectResult.referenceErrors.some(
      (error) => error.code === "synthesis.considered_approach_material_binding_mismatch",
    ),
    JSON.stringify(wrongSubjectResult.referenceErrors, null, 2),
  );
  const wrongSubjectBefore = await treeSnapshot(state.runRoot);
  await assert.rejects(
    state.store.publishArtifactBundle({
      runId: state.runId,
      envelopes: synthesisEnvelopes(wrongSubjectBundle),
    }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.reference_invalid",
  );
  assert.deepEqual(await treeSnapshot(state.runRoot), wrongSubjectBefore);
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

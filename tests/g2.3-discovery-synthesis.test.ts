import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ArtifactStore,
  canonicalContentHash,
  createArtifactValidator,
  DispatchLaunchRegistry,
  type DocumentBundle,
  deriveLaneSubmissionContract,
  deriveSolutionExplorationObservations,
  EvidenceStore,
  type FormalArtifactEnvelope,
  ReportRuntime,
  RunStore,
  StoreError,
  validateDecisionSubjectContract,
} from "../harness/src/index.js";
import { completePreparedTerminalReportLocked } from "../harness/src/reporting/report-runtime.js";
import { renderTerminalAuditAppendix } from "../harness/src/reporting/terminal-reporting.js";
import { createFormalStageRuntimeCompiler } from "../harness/src/runtime/declarative-runtime.js";
import {
  type CandidateFanInAuthority,
  type DiscoveryObjectDeclaration,
  type DiscoveryStageProjectionContext,
  projectCandidateFanIn,
  projectDiscoverySetup,
  projectDiscoverySynthesis,
  projectedLocalRefsMatch,
  projectFanInLaneClassification,
} from "../harness/src/runtime/discovery-stage-projections.js";
import {
  createDiscoveryMapsFixture,
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
  G21_PLAN_REF,
  G21_SCOPE_REF,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  G22_BASELINE_EVALUATION_JUDGMENT,
  G22_BASELINE_GENERATION_JUDGMENT,
  G22_BASELINE_R1,
  G22_DEMAND_EVALUATION_JUDGMENT,
  G22_DEMAND_R2,
  G22_EVALUATION_CLAIM,
  G22_EVALUATION_MANIFEST,
  G22_FAN_IN,
  G22_FINDING,
  G22_GENERATION_CLAIM,
  G22_GENERATION_MANIFEST,
  G22_INSIGHT,
  G22_JUDGMENT,
  G22_PRE_CANDIDATE_RELATION,
  G22_REJECTED_PRE_CANDIDATE,
  G22_RETAINED_PRE_CANDIDATE,
  G22_WATCHLIST_PRE_CANDIDATE,
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
  readonly validator: Awaited<ReturnType<typeof createArtifactValidator>>;
  readonly bundle: DocumentBundle;
}

interface DecisionSubjectProjectionDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

async function publishRuntimeEnvelopesAsFormalStage(
  state: State,
  envelopes: readonly FormalArtifactEnvelope[],
  requestId: string,
): Promise<void> {
  const compiler = createFormalStageRuntimeCompiler(
    state.runsRoot,
    state.validator,
    repositoryRoot,
  );
  await compiler.compile({
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: requestId,
    run_id: state.runId,
    operation: "publish",
    created_at: String(envelopes[0]?.created_at ?? "2026-07-27T18:00:00Z"),
    artifacts: envelopes.map((envelope) => ({
      artifact_type: envelope.artifact_type,
      artifact_path: envelope.artifact_path,
      producer_role: envelope.producer_role,
      input_refs: envelope.input_refs,
      document: envelope.document,
    })),
  });
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

function refreshRetainedPreCandidateBindings(bundle: DocumentBundle): void {
  const preCandidate = effective(bundle, G22_RETAINED_PRE_CANDIDATE);
  const preCandidateHash = canonicalContentHash(preCandidate);
  entry(bundle, G22_RETAINED_PRE_CANDIDATE).content_hash = preCandidateHash;

  const relation = effective(bundle, G22_PRE_CANDIDATE_RELATION);
  const resultBinding = (relation.result_candidate_bindings as Record<string, unknown>[]).find(
    (binding) => binding.ref === G22_RETAINED_PRE_CANDIDATE,
  );
  assert.ok(resultBinding);
  resultBinding.content_hash = preCandidateHash;
  refresh(bundle, G22_PRE_CANDIDATE_RELATION);

  const fanIn = effective(bundle, G22_FAN_IN);
  const disposition = (fanIn.pre_candidate_dispositions as Record<string, unknown>[]).find(
    (candidate) => candidate.pre_candidate_ref === G22_RETAINED_PRE_CANDIDATE,
  );
  assert.ok(disposition);
  disposition.pre_candidate_content_hash = preCandidateHash;
  refresh(bundle, G22_FAN_IN);

  for (const conversionRef of [
    G23_DEMAND_CONVERSION,
    G23_BASELINE_CONVERSION,
    G23_SOLUTION_CONVERSION,
  ]) {
    effective(bundle, conversionRef).source_pre_candidate_content_hash = preCandidateHash;
    refresh(bundle, conversionRef);
  }
}

function currentEnvelopes(bundle: DocumentBundle): FormalArtifactEnvelope[] {
  return bundle.documents
    .map((candidate) => candidate.document as unknown as FormalArtifactEnvelope)
    .filter(
      (candidate) => candidate.schema_version === "startup_opportunity.artifact_envelope.current",
    );
}

function validationIssueCodes(result: {
  readonly referenceErrors: readonly { readonly code: string }[];
  readonly documents: readonly { readonly errors: readonly { readonly code: string }[] }[];
}): readonly string[] {
  return [
    ...result.referenceErrors.map((error) => error.code),
    ...result.documents.flatMap((document) => document.errors.map((error) => error.code)),
  ];
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

function mergeDecision(
  bundle: DocumentBundle,
  decisionId: string,
  clusterId: string,
  decisionKind: "merge" | "preserve" | "split",
  memberRefs: readonly string[],
): Record<string, unknown> {
  const baseDecision = (
    effective(bundle, G23_MERGE).merge_or_split_decisions as Record<string, unknown>[]
  )[0];
  assert.ok(baseDecision);
  return {
    ...structuredClone(baseDecision),
    decision_id: decisionId,
    cluster_id: clusterId,
    decision: decisionKind,
    member_thesis_refs: [...memberRefs],
  };
}

function setSingletonPreserveMerge(bundle: DocumentBundle): void {
  const merge = effective(bundle, G23_MERGE);
  merge.merged_opportunities = [
    {
      cluster_id: "cluster_preserve_a",
      canonical_opportunity_ref: G23_OPPORTUNITY_A,
      member_thesis_refs: [G23_OPPORTUNITY_A],
    },
    {
      cluster_id: "cluster_preserve_b",
      canonical_opportunity_ref: G23_OPPORTUNITY_B,
      member_thesis_refs: [G23_OPPORTUNITY_B],
    },
  ];
  merge.merge_or_split_decisions = [
    mergeDecision(bundle, "decision_preserve_a", "cluster_preserve_a", "preserve", [
      G23_OPPORTUNITY_A,
    ]),
    mergeDecision(bundle, "decision_preserve_b", "cluster_preserve_b", "preserve", [
      G23_OPPORTUNITY_B,
    ]),
  ];
  merge.preserved_variants = [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B];
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

const COMPARED_SYNTHESIS_PATHS = new Set([
  ...SYNTHESIS_PATHS,
  G23_SOLUTION_ALT_CONVERSION,
  G23_SOLUTION_ALT,
  G23_SOLUTION_REJECTED_CONVERSION,
  G23_SOLUTION_REJECTED,
]);

const G23_DEMAND_CONVERSION_R2 = "artifacts/discovery/conversions/candidate_demand.r2.json";
const G23_DEMAND_R2 = "artifacts/discovery/demands/demand_household.r2.json";

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

function appendEnvelope(bundle: DocumentBundle, envelope: FormalArtifactEnvelope): void {
  (
    bundle as unknown as { documents: { path: string; document: Record<string, unknown> }[] }
  ).documents.push({
    path: envelope.artifact_path,
    document: envelope as unknown as Record<string, unknown>,
  });
  const manifest = effective(bundle, "manifest.json");
  manifest.artifact_refs = [
    ...new Set([
      ...(((manifest.artifact_refs as string[] | undefined) ?? []) as string[]),
      envelope.artifact_path,
    ]),
  ].sort();
}

function revisionEnvelope(
  runId: string,
  artifactPath: string,
  document: Record<string, unknown>,
  inputRefs: readonly string[],
  createdAt: string,
  producerRole = "main_agent",
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    run_id: runId,
    created_at: createdAt,
    producer_role: producerRole,
    input_refs: [...new Set(inputRefs)].sort(),
    content_hash: canonicalContentHash(document),
    document,
  } as FormalArtifactEnvelope;
}

function appendDemandRevisionChain(
  bundle: DocumentBundle,
): Readonly<{ conversionRef: string; demandRef: string }> {
  const demandR1 = effective(bundle, G23_DEMAND);
  const conversionR1 = effective(bundle, G23_DEMAND_CONVERSION);
  const demandR2: Record<string, unknown> = {
    ...clone(demandR1),
    revision: 2,
    parent_demand_ref: G23_DEMAND,
    parent_content_hash: canonicalContentHash(demandR1),
    source_conversion_ref: G23_DEMAND_CONVERSION_R2,
    limitations: [
      ...((demandR1.limitations as string[] | undefined) ?? []),
      "SYNTHETIC r2 revision preserves the same retained pre-candidate lineage.",
    ],
  };
  const conversionR2: Record<string, unknown> = {
    ...clone(conversionR1),
    revision: 2,
    parent_conversion_ref: G23_DEMAND_CONVERSION,
    parent_content_hash: canonicalContentHash(conversionR1),
    target_artifact_ref: G23_DEMAND_R2,
    target_content_hash: canonicalContentHash(demandR2),
  };
  appendEnvelope(
    bundle,
    revisionEnvelope(
      String(demandR2.run_id),
      G23_DEMAND_CONVERSION_R2,
      conversionR2,
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        G22_FAN_IN,
        G23_DEMAND_CONVERSION,
        G22_DEMAND_R2,
        G22_RETAINED_PRE_CANDIDATE,
        G23_DEMAND_R2,
      ],
      "2026-07-27T20:01:30Z",
    ),
  );
  appendEnvelope(
    bundle,
    revisionEnvelope(
      String(demandR2.run_id),
      G23_DEMAND_R2,
      demandR2,
      [
        G21_SCOPE_REF,
        G21_PLAN_REF,
        G22_FAN_IN,
        G23_DEMAND,
        G23_DEMAND_CONVERSION_R2,
        G22_DEMAND_R2,
        G22_RETAINED_PRE_CANDIDATE,
        G22_GENERATION_MANIFEST,
        G22_EVALUATION_MANIFEST,
        G22_GENERATION_CLAIM,
        G22_EVALUATION_CLAIM,
        G22_JUDGMENT,
        G22_DEMAND_EVALUATION_JUDGMENT,
      ],
      "2026-07-27T20:02:00Z",
    ),
  );
  return { conversionRef: G23_DEMAND_CONVERSION_R2, demandRef: G23_DEMAND_R2 };
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
      acquisitionGoal: "SYNTHETIC G2.3 generation substrate; not Evidence.",
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
      acquisitionGoal: "SYNTHETIC G2.3 evaluation substrate; not Evidence.",
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
  return { root, runsRoot, runRoot: path.join(runsRoot, runId), runId, store, validator, bundle };
}

async function publishThroughFanIn(state: State): Promise<void> {
  const initialCandidates = byTypes(
    state.bundle,
    "startup_opportunity.discovery_candidate.v1",
  ).filter((candidate) => candidate.document.revision === 1);
  await state.store.publishArtifactBundle({ runId: state.runId, envelopes: initialCandidates });
  const candidateRuntimeEnvelopes = discoveryWaveEnvelopes(
    state.bundle,
    state.runId,
    "startup_opportunity.research_task.discovery_candidate.current",
    1,
    "candidate_runtime",
  );
  await publishRuntimeEnvelopesAsFormalStage(
    state,
    candidateRuntimeEnvelopes,
    "request_g2_3_candidate_runtime_wave",
  );
  const dispatchEnvelope = candidateRuntimeEnvelopes.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(dispatchEnvelope);
  const registry = new DispatchLaunchRegistry(state.runsRoot, state.validator, repositoryRoot);
  const checklist = await registry.check(
    state.runId,
    dispatchEnvelope.artifact_path,
    dispatchEnvelope.content_hash,
  );
  await registry.register({
    schema_version: "startup_opportunity.dispatch_launch_registration_request.v1",
    request_id: "launch_g2_3_candidate_runtime",
    run_id: state.runId,
    dispatch_ref: dispatchEnvelope.artifact_path,
    dispatch_hash: dispatchEnvelope.content_hash,
    registered_at: "2026-07-27T18:02:00Z",
    registrations: checklist.checklist.map((entry) => ({
      unit_id: entry.unit_id,
      task_ref: entry.task_ref,
      task_id: entry.task_id,
      attempt: entry.attempt,
      execution_attempt_id: `exec_g2_3_${entry.unit_id}`,
    })),
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
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [
      G22_RETAINED_PRE_CANDIDATE,
      G22_WATCHLIST_PRE_CANDIDATE,
      G22_REJECTED_PRE_CANDIDATE,
    ].map((artifactPath) => runtimeEnvelope(state.bundle, artifactPath)),
  });
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: runtimeEnvelope(state.bundle, G22_PRE_CANDIDATE_RELATION),
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

function noIncumbentResponseAssignment(): Record<string, unknown> {
  return {
    analysis_depth: "not_assigned",
    assignment_role: "none",
    subject_refs: [],
    rationale: "SYNTHETIC review-only lane does not own incumbent response analysis.",
  };
}

function reviewCommercialRequirements(unitId: string): Record<string, unknown> {
  return {
    research_stage: "solution_neutral_scan",
    resource_allocation: {
      customer_commercial_percent: 65,
      market_structure_percent: 17,
      academic_percent: 18,
    },
    planned_queries: [
      {
        query: "SYNTHETIC structured adversarial review desk scan.",
        commercial_dimensions: ["counterevidence"],
      },
    ],
    quantitative_competitive_scope: {
      scan_mode: "broad_scan",
      required_metric_families: ["competitive_intensity"],
      required_competitor_types: ["status_quo"],
      api_is_optional: true,
      provider_allowlist_enforced: false,
      acquisition_execution_owner: "research_agent_or_caller",
      harness_hidden_network_calls: false,
      prohibited_access_methods: [
        "bypass_access_control",
        "circumvent_login",
        "circumvent_paywall",
        "circumvent_captcha",
        "store_credentials",
      ],
    },
    incumbent_response_assignment: noIncumbentResponseAssignment(),
    required_commercial_dimensions: ["independent_counterevidence"],
    commercial_audit_output_path: `artifacts/research-audits/${unitId}.json`,
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

function reviewStragglerPolicy(): Record<string, unknown> {
  return {
    on_timeout: "publish_partial",
    grace_minutes: 2,
    blocks_stage: true,
  };
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
  const synthesisDriftBefore = await treeSnapshot(state.runRoot);
  assert.deepEqual(
    validateDecisionSubjectContract(synthesisDrift).map((issue) => issue.code),
    ["decision_subject.solution_exploration_projection_mismatch"],
  );
  assert.deepEqual(await treeSnapshot(state.runRoot), synthesisDriftBefore);

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
  const terminalDriftBefore = await treeSnapshot(state.runRoot);
  assert.deepEqual(
    validateDecisionSubjectContract(terminalDrift).map((issue) => issue.code),
    ["decision_subject.direction_body_mismatch"],
  );
  assert.deepEqual(await treeSnapshot(state.runRoot), terminalDriftBefore);
});

test("G2.3 terminal closeout renders Discovery adversarial review as reference-only audit material", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g2-3-review-terminal-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "g2-3-review-terminal-synthetic";
  const runRoot = path.join(runsRoot, runId);
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    createdAt: "2026-08-10T12:00:00Z",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic discovery review user"],
      decisionGoal: "test terminal review visibility",
      researchLanguage: "en-US",
    },
  });
  const bundle = await createDiscoveryMapsFixture("general", runId);
  const unitId = "unit_terminal_discovery_review";
  const taskId = "task_terminal_discovery_review";
  const stageId = "stage_terminal_discovery_review";
  const dispatchGroup = "dispatch_terminal_discovery_review";
  const executionPath = "plans/research-execution.r1.json";
  const dispatchPath = "tasks/dispatch/terminal-discovery-review.r1.json";
  const taskPath = `tasks/discovery/reviews/${unitId}.attempt-1.json`;
  const reviewPath = "artifacts/reviews/terminal-discovery-adversarial-review.json";
  const snapshotPath = "artifacts/reporting/decision-subject-snapshot.r1.json";
  const terminalPath = "artifacts/reporting/terminal-report-source.r1.json";
  const questionRefs = [`${G21_PLAN_REF}#question_demand`, `${G21_PLAN_REF}#question_workflow`];
  const researchGoal =
    "SYNTHETIC review every assigned Plan question from support and opposition stances.";
  const plan = effective(bundle, G21_PLAN_REF);
  plan.waves = [
    {
      wave_id: "wave_terminal_discovery_review",
      depends_on: [],
      units: [
        {
          unit_id: unitId,
          unit_type: "adversarial_review",
          plan_disposition: "enabled",
          priority_band: "normal",
          attempt: 1,
          supersedes_unit_ref: null,
          research_goal: researchGoal,
          input_refs: [G21_SCOPE_REF],
          agent_role: "adversarial-reviewer",
          output_path: reviewPath,
          required_artifact_schema: "startup_opportunity.discovery_adversarial_review.current",
          source_preferences: ["SYNTHETIC use structured review material refs only."],
          required_outputs: ["SYNTHETIC support and oppose coverage per assigned question."],
          stop_conditions: ["SYNTHETIC stop after assigned question and stance closure."],
        },
      ],
    },
  ];
  refresh(bundle, G21_PLAN_REF);
  await publishInitialPlanBundle(
    store,
    runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  );

  const planHash = canonicalContentHash(plan);
  const lane = {
    unit_id: unitId,
    lane_role: "review",
    candidate_scope: { kind: "none", candidate_refs: [] },
    incumbent_response_assignment: noIncumbentResponseAssignment(),
    reporting_dimensions: ["adversarial_review"],
    assigned_plan_question_refs: questionRefs,
    submission_path: reviewPath,
    submission_schema: "startup_opportunity.discovery_adversarial_review.current",
    commercial_audit_output_path: null,
    lane_submission_contract: deriveLaneSubmissionContract({
      runId,
      unitId,
      taskId,
      attempt: 1,
      formalOutputPath: reviewPath,
      formalArtifactSchema: "startup_opportunity.discovery_adversarial_review.current",
      commercialAuditOutputPath: null,
    }),
    time_budget_minutes: 10,
    max_sources: 5,
    straggler_policy: reviewStragglerPolicy(),
    dispatch_group: dispatchGroup,
  };
  const executionDocument = {
    schema_version: "startup_opportunity.research_execution_plan.discovery.current",
    execution_plan_id: "execution_terminal_discovery_review",
    run_id: runId,
    mode: "opportunity_discovery",
    revision: 1,
    parent_execution_plan_ref: null,
    research_plan_ref: G21_PLAN_REF,
    research_plan_hash: planHash,
    created_at: "2026-08-10T12:01:00Z",
    research_depth: "quick",
    total_time_budget_minutes: 10,
    resource_allocation: {
      customer_commercial_percent: 65,
      market_structure_percent: 17,
      academic_percent: 18,
    },
    stages: [
      {
        stage_id: stageId,
        stage_kind: "review",
        depends_on: [],
        gate_before: null,
        gate_after: "required",
        lanes: [lane],
      },
    ],
    limitations: ["SYNTHETIC execution overlay; no hidden research was performed."],
  };
  const dispatchTask = {
    task_id: taskId,
    unit_id: unitId,
    lane_role: "review",
    incumbent_response_assignment: noIncumbentResponseAssignment(),
    research_goal: researchGoal,
    input_refs: [G21_SCOPE_REF],
    assigned_plan_question_refs: questionRefs,
    allowed_output_path: reviewPath,
    required_artifact_schema: "startup_opportunity.discovery_adversarial_review.current",
    commercial_audit_output_path: null,
    lane_submission_contract: lane.lane_submission_contract,
    time_budget_minutes: 10,
    max_sources: 5,
    straggler_policy: reviewStragglerPolicy(),
  };
  const dispatchDocument = {
    schema_version: "startup_opportunity.dispatch_batch.discovery.current",
    batch_id: "dispatch_terminal_discovery_review",
    revision: 1,
    run_id: runId,
    mode: "opportunity_discovery",
    execution_plan_ref: executionPath,
    research_plan_ref: G21_PLAN_REF,
    stage_id: stageId,
    dispatch_group: dispatchGroup,
    task_ready_at: "2026-08-10T12:01:30Z",
    dispatch_requested_at: "2026-08-10T12:02:00Z",
    dispatch_mode: "parallel_immediate",
    tasks: [dispatchTask],
    agent_dispatch_performed: false,
    launch_registration_required: true,
    limitations: ["SYNTHETIC dispatch contract; no external agent was launched."],
  };
  const taskDocument = {
    schema_version: "startup_opportunity.research_task.discovery_review.current",
    task_id: taskId,
    run_id: runId,
    unit_id: unitId,
    mode: "opportunity_discovery",
    phase: "review",
    wave_id: "wave_terminal_discovery_review",
    unit_type: "adversarial_review",
    research_goal: researchGoal,
    commercial_research_requirements: reviewCommercialRequirements(unitId),
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    input_refs: [G21_SCOPE_REF],
    attempt: 1,
    supersedes_task_ref: null,
    agent_role: "adversarial-reviewer",
    source_phase: "adversarial_challenger",
    required_source_group_ids: ["source_group_terminal_discovery_review"],
    assigned_plan_question_refs: questionRefs,
    allowed_output_path: reviewPath,
    required_artifact_schema: "startup_opportunity.discovery_adversarial_review.current",
    lane_submission_contract: lane.lane_submission_contract,
    required_stances: ["support", "oppose"],
    stop_conditions: ["SYNTHETIC stop after structured support and oppose closure."],
    completion_message_contract: {
      formal_artifact_authority: false,
      include_artifact_path: true,
      include_limitations: true,
    },
    execution_contract: reviewExecutionContract(),
    dispatched_at: "2026-08-10T12:02:00Z",
  };
  const executionEnvelope = revisionEnvelope(
    runId,
    executionPath,
    executionDocument,
    [G21_PLAN_REF],
    "2026-08-10T12:01:00Z",
  );
  const dispatchEnvelope = revisionEnvelope(
    runId,
    dispatchPath,
    dispatchDocument,
    [G21_PLAN_REF, executionPath],
    "2026-08-10T12:02:00Z",
    "harness",
  );
  const taskEnvelope = revisionEnvelope(
    runId,
    taskPath,
    taskDocument,
    [G21_SCOPE_REF, G21_PLAN_REF, executionPath, `${dispatchPath}#${taskId}`],
    "2026-08-10T12:02:30Z",
  );
  const literalReviewProse = "Schema.org Evidence Based Design Vendor Baseline Pro Manifest";
  const literalGapProse =
    "Schema.org gap summary keeps Evidence Based Design and Vendor Baseline Pro wording.";
  const literalUnresolvedGapProse =
    "Manifest unresolved gap should preserve Schema.org and Evidence Based Design wording.";
  const literalStopReason =
    "Stop after checking Vendor Baseline Pro and Schema.org material without keyword rewrites.";
  const reviewDocument = {
    schema_version: "startup_opportunity.discovery_adversarial_review.current",
    review_result_id: "review_terminal_discovery_visibility",
    run_id: runId,
    unit_id: unitId,
    attempt: 1,
    owner_role: "adversarial-reviewer",
    owned_output_path: reviewPath,
    task_ref: taskPath,
    task_hash: taskEnvelope.content_hash,
    dispatch_batch_ref: `${dispatchPath}#${taskId}`,
    dispatch_batch_hash: dispatchEnvelope.content_hash,
    execution_plan_ref: executionPath,
    execution_plan_hash: executionEnvelope.content_hash,
    scope_frame_ref: G21_SCOPE_REF,
    research_plan_ref: G21_PLAN_REF,
    research_plan_hash: planHash,
    status: "partial",
    review_subject: {
      subject_kind: "plan_level_discovery",
      target_candidate_refs: [],
      target_opportunity_refs: [],
      reviewed_plan_question_refs: questionRefs,
    },
    required_stances: ["support", "oppose"],
    review_findings: questionRefs.flatMap((questionRef, index) => [
      {
        finding_id: `finding_support_${index + 1}`,
        stance: "support",
        reviewed_plan_question_refs: [questionRef],
        evidence_state: "unknown",
        summary:
          index === 0
            ? literalReviewProse
            : "SYNTHETIC support-side review found only unknown material.",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: ["SYNTHETIC no real source was claimed."],
      },
      {
        finding_id: `finding_oppose_${index + 1}`,
        stance: "oppose",
        reviewed_plan_question_refs: [questionRef],
        evidence_state: "no_evidence_found",
        summary: "SYNTHETIC oppose-side review did not find decisive material.",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: ["SYNTHETIC no positive Evidence is required for review completion."],
      },
    ]),
    material_visibility: {
      supporting_refs: [],
      opposing_refs: [],
      background_refs: [],
      contradictory_refs: [],
      unknown_refs: [],
    },
    decision_relevant_gaps: [
      {
        gap_id: "gap_terminal_discovery_review_unknown",
        state: "unknown",
        summary: literalGapProse,
        basis_refs: [],
        requires_plan_adaptation: false,
        recommended_follow_up: "manual_review",
        limitations: ["SYNTHETIC honest weak result remains visible."],
      },
    ],
    search_closure: {
      status: "partial",
      acquisition_routes_attempted: ["desk_review"],
      adopted_source_refs: [],
      unresolved_gaps: [literalUnresolvedGapProse],
      stop_reason: literalStopReason,
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
    valid_as_of: "2026-08-10",
    limitations: ["SYNTHETIC Discovery review result; not a decision authority."],
  };
  const reviewEnvelope = revisionEnvelope(
    runId,
    reviewPath,
    reviewDocument,
    [taskPath, `${dispatchPath}#${taskId}`, executionPath, G21_SCOPE_REF, G21_PLAN_REF],
    "2026-08-10T12:03:00Z",
    "adversarial_reviewer",
  );
  for (const envelope of [executionEnvelope, dispatchEnvelope, taskEnvelope, reviewEnvelope]) {
    const validation = validator.validateDocument(envelope, envelope.artifact_path);
    assert.equal(
      validation.valid,
      true,
      `${envelope.artifact_path}: ${JSON.stringify(validation.errors, null, 2)}`,
    );
  }
  await publishRuntimeEnvelopesAsFormalStage(
    { root, runsRoot, runRoot, runId, store, validator, bundle },
    [executionEnvelope, dispatchEnvelope, taskEnvelope],
    "request_g2_3_review_runtime",
  );
  await store.publishArtifact({
    runId,
    envelope: reviewEnvelope,
  });

  const scope = effective(bundle, G21_SCOPE_REF);
  const snapshotDocument = {
    schema_version: "startup_opportunity.decision_subject_snapshot.current",
    snapshot_id: "decision_subjects_terminal_discovery_review",
    revision: 1,
    parent_snapshot_ref: null,
    parent_snapshot_hash: null,
    run_id: runId,
    mode: "opportunity_discovery",
    scope_frame_ref: G21_SCOPE_REF,
    scope_frame_hash: canonicalContentHash(scope),
    research_plan_ref: G21_PLAN_REF,
    research_plan_hash: planHash,
    synthesis_input_hashes: [],
    created_at: "2026-08-10T12:04:00Z",
    subjects: [],
    limitations: ["SYNTHETIC no final Opportunity subject was formed."],
  };
  const snapshotEnvelope = revisionEnvelope(
    runId,
    snapshotPath,
    snapshotDocument,
    [G21_SCOPE_REF, G21_PLAN_REF],
    "2026-08-10T12:04:00Z",
  );
  await store.publishArtifact({ runId, envelope: snapshotEnvelope });

  const terminalDocument = {
    schema_version: "startup_opportunity.terminal_report_source.v1",
    report_id: "terminal_discovery_review_visibility",
    run_id: runId,
    mode: "opportunity_discovery",
    research_language: "en-US",
    producer_role: "main_agent",
    owned_output_path: terminalPath,
    materialized_path: "report.json",
    generated_at: "2026-08-10T12:05:00Z",
    decision_subject_snapshot_ref: snapshotPath,
    decision_subject_snapshot_hash: snapshotEnvelope.content_hash,
    decision_subject_synthesis_hashes: [],
    current_decision_subject_ids: [],
    terminal_outcome: "completed",
    decision_question: "SYNTHETIC terminal Discovery review visibility.",
    execution: {
      completeness: "complete",
      completed_stages: ["review"],
      incomplete_stages: [],
      required_followups: [],
      pending_operation_refs: [],
    },
    research_conclusion: {
      outcome: "no_recommendation",
      current_recommendation: "SYNTHETIC no recommendation is made from a reference-only review.",
      meaning: "SYNTHETIC Discovery review material is visible but not a decision authority.",
      evidence_strength: "insufficient",
      allowed_claim: "SYNTHETIC terminal report includes the review in audit provenance only.",
    },
    runtime_health: { status: "healthy", issues: [] },
    directions: [],
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
    ordered_validation_plan: [],
    freshness: {
      earliest_valid_as_of: null,
      latest_valid_as_of: null,
      summary: "SYNTHETIC terminal review visibility fixture has no market freshness claim.",
    },
    limitations: ["SYNTHETIC terminal source; not market Evidence."],
    external_action_boundary: {
      execution_owner: "user",
      execution_supported: false,
      result_tracking_supported: false,
      external_validation_claimed: false,
    },
    audit_refs: [],
  };
  const terminalEnvelope = revisionEnvelope(
    runId,
    terminalPath,
    terminalDocument,
    [G21_SCOPE_REF, G21_PLAN_REF, snapshotPath, reviewPath],
    "2026-08-10T12:05:00Z",
  );
  const prospectiveManifest = {
    ...(await store.status(runId)).manifest,
    status: "completed",
    status_before_clarification: null,
    current_decision_subject_snapshot_ref: snapshotPath,
    current_decision_subject_snapshot_hash: snapshotEnvelope.content_hash,
    updated_at: "2026-08-10T12:05:30Z",
  };
  const runtime = new ReportRuntime(runsRoot, validator);
  const operation = await runtime.prepareTerminalLocked(runRoot, {
    reportEnvelope: terminalEnvelope,
    prospectiveManifest,
    supportingEnvelopes: [],
  });
  const summaries = operation.source_envelope.document.discovery_review_summaries as Record<
    string,
    unknown
  >[];
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.review_ref, reviewPath);
  assert.equal(summaries[0]?.review_content_hash, reviewEnvelope.content_hash);
  assert.equal(summaries[0]?.owner_role, "adversarial-reviewer");
  assert.equal(summaries[0]?.status, "partial");
  assert.deepEqual(summaries[0]?.required_stances, ["oppose", "support"]);
  assert.deepEqual(summaries[0]?.reviewed_plan_question_refs, [...questionRefs].sort());
  assert.ok((operation.source_envelope.document.audit_refs as string[]).includes(reviewPath));
  assert.ok((operation.source_envelope.input_refs as string[]).includes(reviewPath));

  const output = (target: string): string => {
    const found = operation.materialized_outputs.find((entry) => entry.target_path === target);
    assert.ok(found, target);
    return found.bytes;
  };
  const reportJson = JSON.parse(output("report.json")) as Record<string, unknown>;
  assert.equal(
    (reportJson.discovery_review_summaries as Record<string, unknown>[])[0]?.review_ref,
    reviewPath,
  );
  const decisionBrief = output("decision-brief.md");
  const fullReport = output("report.md");
  const appendix = output("audit-appendix.md");
  assert.match(decisionBrief, /Discovery Adversarial Review Boundary/);
  assert.match(fullReport, /Discovery Adversarial Review Boundary/);
  assert.match(appendix, /Discovery Adversarial Reviews \(Reference Only\)/);
  assert.match(appendix, /review_terminal_discovery_visibility/);
  assert.match(
    appendix,
    /reference-only; not a Gate, ranking, elimination, or confidence-ceiling authority/,
  );
  assert.match(appendix, /material state=unknown/);
  assert.match(appendix, /material state=no evidence found/);
  assert.match(appendix, new RegExp(literalReviewProse.replaceAll(".", "\\.")));
  assert.match(appendix, new RegExp(literalGapProse.replaceAll(".", "\\.")));
  assert.match(appendix, new RegExp(literalUnresolvedGapProse.replaceAll(".", "\\.")));
  assert.match(appendix, new RegExp(literalStopReason.replaceAll(".", "\\.")));
  assert.doesNotMatch(appendix, new RegExp(reviewPath));
  assert.doesNotMatch(appendix, new RegExp(taskPath));
  assert.doesNotMatch(appendix, new RegExp(G21_PLAN_REF));
  assert.doesNotMatch(decisionBrief, /ranked by Discovery adversarial review/iu);
  assert.doesNotMatch(fullReport, /eliminated by Discovery adversarial review/iu);

  const zhSource = structuredClone(operation.source_envelope.document);
  zhSource.research_language = "zh-CN";
  const zhAppendix = renderTerminalAuditAppendix(zhSource);
  assert.match(zhAppendix, /发现对抗性复核（仅供引用）/);
  assert.match(zhAppendix, new RegExp(literalReviewProse.replaceAll(".", "\\.")));
  assert.match(zhAppendix, new RegExp(literalGapProse.replaceAll(".", "\\.")));
  assert.match(zhAppendix, new RegExp(literalUnresolvedGapProse.replaceAll(".", "\\.")));
  assert.match(zhAppendix, new RegExp(literalStopReason.replaceAll(".", "\\.")));
  assert.doesNotMatch(zhAppendix, /结构合同\.org/u);
  assert.doesNotMatch(zhAppendix, /证据 Based Design/u);
  assert.doesNotMatch(zhAppendix, /Vendor 基线 Pro/u);
  assert.doesNotMatch(zhAppendix, /研究状态索引/u);
  assert.doesNotMatch(zhAppendix, new RegExp(reviewPath));
  assert.doesNotMatch(zhAppendix, new RegExp(taskPath));
  assert.doesNotMatch(zhAppendix, new RegExp(G21_PLAN_REF));

  const artifacts = new ArtifactStore(runsRoot, validator);
  const published = await completePreparedTerminalReportLocked(
    runRoot,
    operation,
    artifacts,
    validator,
  );
  assert.equal(published.status, "published");
  const storedReport = JSON.parse(
    await readFile(path.join(runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(
    (storedReport.discovery_review_summaries as Record<string, unknown>[])[0]?.review_ref,
    reviewPath,
  );
  assert.match(
    await readFile(path.join(runRoot, "audit-appendix.md"), "utf8"),
    /Discovery Adversarial Reviews \(Reference Only\)/,
  );
  const replay = await completePreparedTerminalReportLocked(
    runRoot,
    operation,
    artifacts,
    validator,
  );
  assert.equal(replay.status, "idempotent_replay");

  const tampered = structuredClone(terminalEnvelope);
  tampered.document.discovery_review_summaries = [{ ...summaries[0], status: "completed" }];
  (tampered as { content_hash: string }).content_hash = canonicalContentHash(tampered.document);
  await assert.rejects(
    runtime.prepareTerminalLocked(runRoot, {
      reportEnvelope: tampered,
      prospectiveManifest,
      supportingEnvelopes: [],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.mechanical_projection_drift",
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

test("G2.3 conversion bijection uses only current stable-object revisions", async (context) => {
  const state = await setup(context, "conversion-revision");
  const validator = await createArtifactValidator(repositoryRoot);
  const bundle = clone(state.bundle);
  appendDemandRevisionChain(bundle);

  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, true, JSON.stringify(validationIssueCodes(result), null, 2));
});

test("G2.3 current conversion revision rejects duplicate target and wrong parent", async (context) => {
  const state = await setup(context, "conversion-revision-negative");
  const validator = await createArtifactValidator(repositoryRoot);

  const duplicateTargetBundle = clone(state.bundle);
  const duplicateRefs = appendDemandRevisionChain(duplicateTargetBundle);
  const baselineConversion = effective(duplicateTargetBundle, G23_BASELINE_CONVERSION);
  baselineConversion.target_schema_version = "startup_opportunity.demand_thesis.v1";
  baselineConversion.target_artifact_ref = duplicateRefs.demandRef;
  baselineConversion.target_content_hash = canonicalContentHash(
    effective(duplicateTargetBundle, duplicateRefs.demandRef),
  );
  entry(duplicateTargetBundle, G23_BASELINE_CONVERSION).input_refs = (
    entry(duplicateTargetBundle, G23_BASELINE_CONVERSION).input_refs as string[]
  ).map((ref) => (ref === G23_BASELINE ? duplicateRefs.demandRef : ref));
  refresh(duplicateTargetBundle, G23_BASELINE_CONVERSION);
  const duplicateResult = validator.validateDocumentBundle(duplicateTargetBundle);
  assert.equal(duplicateResult.valid, false);
  assert.ok(
    validationIssueCodes(duplicateResult).includes("synthesis.conversion_bijection_mismatch"),
    JSON.stringify(validationIssueCodes(duplicateResult), null, 2),
  );

  const wrongParentBundle = clone(state.bundle);
  const wrongParentRefs = appendDemandRevisionChain(wrongParentBundle);
  const conversionR2 = effective(wrongParentBundle, wrongParentRefs.conversionRef);
  conversionR2.parent_conversion_ref = G23_BASELINE_CONVERSION;
  conversionR2.parent_content_hash = canonicalContentHash(
    effective(wrongParentBundle, G23_BASELINE_CONVERSION),
  );
  entry(wrongParentBundle, wrongParentRefs.conversionRef).input_refs = (
    entry(wrongParentBundle, wrongParentRefs.conversionRef).input_refs as string[]
  ).map((ref) => (ref === G23_DEMAND_CONVERSION ? G23_BASELINE_CONVERSION : ref));
  refresh(wrongParentBundle, wrongParentRefs.conversionRef);
  const wrongParentResult = validator.validateDocumentBundle(wrongParentBundle);
  assert.equal(wrongParentResult.valid, false);
  assert.ok(
    validationIssueCodes(wrongParentResult).includes("synthesis.parent_revision_mismatch"),
    JSON.stringify(validationIssueCodes(wrongParentResult), null, 2),
  );
});

test("G2.3 represents independent, segment, delivery, mixed, and unknown family relations without changing Opportunities", async (context) => {
  const state = await setup(context, "family-relations");
  const validator = await createArtifactValidator(repositoryRoot);
  const relationCases: readonly {
    readonly name: string;
    readonly families: readonly Record<string, unknown>[];
    readonly configureMerge?: (bundle: DocumentBundle) => void;
  }[] = [
    {
      name: "multiple-independent-families",
      configureMerge: setSingletonPreserveMerge,
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
      name: "shared-family-preserved-members",
      configureMerge: setSingletonPreserveMerge,
      families: [
        familyDeclaration("family_preserved_shared", "shared_opportunity_family", [
          { opportunity_ref: G23_OPPORTUNITY_A, relation_to_family: "segment_variant" },
          {
            opportunity_ref: G23_OPPORTUNITY_B,
            relation_to_family: "delivery_or_implementation_variant",
          },
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
      configureMerge: setSingletonPreserveMerge,
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
      configureMerge: setSingletonPreserveMerge,
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
    relationCase.configureMerge?.(bundle);
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

test("G2.3 rejects merge decisions that contradict opportunity-family declarations before atomic publication writes anything", async (context) => {
  const state = await setup(context, "family-merge-conflict");
  const validator = await createArtifactValidator(repositoryRoot);
  const conflictCases = [
    [
      familyDeclaration("family_independent_a", "independent_opportunity", [
        { opportunity_ref: G23_OPPORTUNITY_A, relation_to_family: "independent_opportunity" },
      ]),
      familyDeclaration("family_independent_b", "independent_opportunity", [
        { opportunity_ref: G23_OPPORTUNITY_B, relation_to_family: "independent_opportunity" },
      ]),
    ],
    [
      familyDeclaration("family_unknown", "unknown", [
        { opportunity_ref: G23_OPPORTUNITY_A, relation_to_family: "unknown" },
        { opportunity_ref: G23_OPPORTUNITY_B, relation_to_family: "unknown" },
      ]),
    ],
  ] as const;
  for (const conflictingFamilies of conflictCases) {
    const conflictingBundle = clone(state.bundle);
    setFamilies(conflictingBundle, conflictingFamilies);
    const validation = validator.validateDocumentBundle(conflictingBundle);
    assert.equal(validation.valid, false);
    assert.ok(
      validation.referenceErrors.some(
        (error) => error.code === "opportunity_family.merge_decision_conflict",
      ),
      JSON.stringify(validation.referenceErrors, null, 2),
    );
  }

  await publishThroughFanIn(state);
  const invalid = clone(synthesisEnvelopes(state.bundle));
  const mergeEnvelope = invalid.find((entry) => entry.artifact_path === G23_MERGE);
  assert.ok(mergeEnvelope);
  mergeEnvelope.document.opportunity_families = conflictCases[0];
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
  );
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
        const decisions = fanIn.pre_candidate_dispositions as Record<string, unknown>[];
        const decision = decisions.find(
          (candidate) => candidate.pre_candidate_ref === G22_RETAINED_PRE_CANDIDATE,
        );
        assert.ok(decision);
        decision.disposition = "watchlist";
        fanIn.retained_pre_candidate_refs = [];
        fanIn.watchlist_pre_candidate_refs = [
          G22_RETAINED_PRE_CANDIDATE,
          G22_WATCHLIST_PRE_CANDIDATE,
        ];
        (fanIn.candidate_diversity_summary as Record<string, unknown>).diversity_retention_refs = [
          G22_DEMAND_R2,
          "artifacts/discovery/candidates/candidate_baseline.r1.json",
          "artifacts/discovery/candidates/candidate_solution.r1.json",
        ];
        (
          fanIn.candidate_diversity_summary as Record<string, unknown>
        ).pre_candidate_diversity_retention_refs = [];
        (
          fanIn.candidate_diversity_summary as Record<string, unknown>
        ).counterfactual_pre_candidate_refs = [];
        const readiness = effective(bundle, G23_READINESS);
        const roles = readiness.pre_candidate_roles as Record<string, unknown>[];
        const role = roles.find(
          (candidate) => candidate.pre_candidate_ref === G22_RETAINED_PRE_CANDIDATE,
        );
        assert.ok(role);
        role.disposition = "watchlist";
        refresh(bundle, G22_FAN_IN);
        refresh(bundle, G23_READINESS);
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

test("G2.3 rejects concrete pre-candidate conversion boundary mutations", async (context) => {
  const state = await setup(context, "pre-candidate-boundary");
  const validator = await createArtifactValidator(repositoryRoot);
  const mutations: readonly {
    readonly name: string;
    readonly code: string;
    readonly mutate: (bundle: DocumentBundle) => void;
  }[] = [
    {
      name: "conversion reuse for one concrete pre-candidate target kind",
      code: "synthesis.conversion_lineage_mismatch",
      mutate(bundle) {
        effective(bundle, G23_BASELINE_CONVERSION).target_schema_version =
          "startup_opportunity.demand_thesis.v1";
        refresh(bundle, G23_BASELINE_CONVERSION);
      },
    },
    {
      name: "one conversion points at a target already owned by another conversion",
      code: "synthesis.conversion_bijection_mismatch",
      mutate(bundle) {
        effective(bundle, G23_SOLUTION_CONVERSION).target_artifact_ref = G23_BASELINE;
        const envelope = entry(bundle, G23_SOLUTION_CONVERSION);
        envelope.input_refs = (envelope.input_refs as string[]).map((ref) =>
          ref === G23_SOLUTION ? G23_BASELINE : ref,
        );
        refresh(bundle, G23_SOLUTION_CONVERSION);
      },
    },
    {
      name: "conversion uses the wrong typed mother seed",
      code: "synthesis.conversion_lineage_mismatch",
      mutate(bundle) {
        effective(bundle, G23_DEMAND_CONVERSION).source_candidate_ref = G22_BASELINE_R1;
        const envelope = entry(bundle, G23_DEMAND_CONVERSION);
        envelope.input_refs = (envelope.input_refs as string[]).map((ref) =>
          ref === G22_DEMAND_R2 ? G22_BASELINE_R1 : ref,
        );
        refresh(bundle, G23_DEMAND_CONVERSION);
      },
    },
    {
      name: "concrete pre-candidate crosses Run ownership",
      code: "discovery_candidate.pre_candidate_identity_mismatch",
      mutate(bundle) {
        effective(bundle, G22_RETAINED_PRE_CANDIDATE).run_id = "foreign-run-not-this-one";
        refreshRetainedPreCandidateBindings(bundle);
      },
    },
    {
      name: "conversion carries a stale concrete pre-candidate hash",
      code: "synthesis.conversion_lineage_mismatch",
      mutate(bundle) {
        effective(bundle, G23_DEMAND_CONVERSION).source_pre_candidate_content_hash = "0".repeat(64);
        refresh(bundle, G23_DEMAND_CONVERSION);
      },
    },
    {
      name: "concrete pre-candidate omits disposition for a typed material ref",
      code: "discovery_candidate.pre_candidate_material_disposition_mismatch",
      mutate(bundle) {
        const preCandidate = effective(bundle, G22_RETAINED_PRE_CANDIDATE);
        preCandidate.material_dispositions = (
          preCandidate.material_dispositions as Record<string, unknown>[]
        ).filter((disposition) => disposition.material_ref !== G22_GENERATION_CLAIM);
        const alternatives = (
          preCandidate.triage_profile as Record<string, Record<string, unknown>>
        ).current_alternatives;
        assert.ok(alternatives);
        alternatives.basis_material_refs = (alternatives.basis_material_refs as string[]).filter(
          (ref) => ref !== G22_GENERATION_CLAIM,
        );
        entry(bundle, G22_RETAINED_PRE_CANDIDATE).input_refs = (
          entry(bundle, G22_RETAINED_PRE_CANDIDATE).input_refs as string[]
        ).filter((ref) => ref !== G22_GENERATION_CLAIM);
        refreshRetainedPreCandidateBindings(bundle);
      },
    },
  ];

  for (const mutation of mutations) {
    const bundle = clone(state.bundle);
    mutation.mutate(bundle);
    const result = validator.validateDocumentBundle(bundle);
    const codes = validationIssueCodes(result);
    assert.equal(result.valid, false, mutation.name);
    assert.ok(codes.includes(mutation.code), `${mutation.name}: ${JSON.stringify(codes)}`);
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

function projectionContext(
  additional: Readonly<Record<string, Record<string, unknown>>> = {},
): DiscoveryStageProjectionContext {
  const runId = "projection-current-run";
  const currentScopeRef = "scope-frame.json";
  const currentPlanRef = "plans/research-plan.r1.json";
  const currentScope = {
    schema_version: "startup_opportunity.scope_frame.discovery.current",
    run_id: runId,
    mode: "opportunity_discovery",
  };
  const currentPlan = {
    schema_version: "startup_opportunity.research_plan.v1",
    run_id: runId,
    mode: "opportunity_discovery",
    revision: 1,
  };
  return {
    runId,
    currentScopeRef,
    currentScope,
    currentPlanRef,
    currentPlan,
    documentsByPath: new Map([
      [currentScopeRef, currentScope],
      [currentPlanRef, currentPlan],
      ...Object.entries(additional),
    ]),
  };
}

function setupDeclarations(): DiscoveryObjectDeclaration[] {
  return [
    {
      local_key: "solution-map-authored",
      object_id: "solution-map-authored",
      document: {
        schema_version: "startup_opportunity.solution_space_map.v1",
        map_id: "solution-map-authored",
        ai_boundary: { applicability: "not_applicable" },
        limitations: ["AI applicability remains explicitly not applicable."],
      },
      local_refs: {
        seed_probe_ref: "seed-authored",
        opportunity_space_map_ref: "opportunity-map-authored",
      },
    },
    {
      local_key: "candidate-authored",
      object_id: "candidate-authored",
      document: {
        schema_version: "startup_opportunity.discovery_candidate.v1",
        candidate_id: "candidate-authored",
        candidate_kind: "demand_seed",
        honest_state: "unknown",
        limitations: ["Candidate remains unknown and unranked."],
      },
    },
    {
      local_key: "opportunity-map-authored",
      object_id: "opportunity-map-authored",
      document: {
        schema_version: "startup_opportunity.opportunity_space_map.v1",
        map_id: "opportunity-map-authored",
        unknowns: ["Demand recurrence is unknown."],
        limitations: ["No Evidence has been promoted."],
      },
      local_refs: { seed_probe_ref: "seed-authored" },
    },
    {
      local_key: "seed-authored",
      object_id: "seed-authored",
      document: {
        schema_version: "startup_opportunity.seed_probe.v1",
        seed_probe_id: "seed-authored",
        initial_questions: [{ uncertainty: "unknown" }],
        limitations: ["Seed is a search entry only."],
      },
    },
  ];
}

test("formal setup projection derives bindings without rewriting authored unknowns", () => {
  const context = projectionContext();
  const policy = {
    policyRef: "harness/policies/discovery-maps.current.json",
    document: {
      schema_version: "startup_opportunity.discovery_maps_policy.current",
      policy_version: "1.0.0",
      artifact_paths: {
        seed_probe: "artifacts/discovery/seed-probe.r1.json",
        opportunity_space_map: "artifacts/discovery/opportunity-space-map.r1.json",
        solution_space_map: "artifacts/discovery/solution-space-map.r1.json",
      },
    },
  };
  const projected = projectDiscoverySetup(setupDeclarations(), context, policy);
  const byType = new Map(projected.map((entry) => [entry.artifact_type, entry]));
  const seed = byType.get("startup_opportunity.seed_probe.v1");
  const opportunity = byType.get("startup_opportunity.opportunity_space_map.v1");
  const solution = byType.get("startup_opportunity.solution_space_map.v1");
  const candidate = byType.get("startup_opportunity.discovery_candidate.v1");
  assert.equal(seed?.artifact_path, "artifacts/discovery/seed-probe.r1.json");
  assert.equal(opportunity?.artifact_path, "artifacts/discovery/opportunity-space-map.r1.json");
  assert.equal(solution?.artifact_path, "artifacts/discovery/solution-space-map.r1.json");
  assert.equal(
    candidate?.artifact_path,
    "artifacts/discovery/candidates/candidate-authored.r1.json",
  );
  assert.deepEqual(seed?.document.initial_questions, [{ uncertainty: "unknown" }]);
  assert.deepEqual(opportunity?.document.unknowns, ["Demand recurrence is unknown."]);
  assert.deepEqual(solution?.document.ai_boundary, { applicability: "not_applicable" });
  assert.equal(candidate?.document.honest_state, "unknown");
  assert.equal(opportunity?.document.seed_probe_ref, seed?.artifact_path);
  assert.equal(solution?.document.opportunity_space_map_ref, opportunity?.artifact_path);
  assert.ok(solution);
  assert.deepEqual(
    (solution.document.input_artifact_hashes as Record<string, unknown>[]).find(
      (entry) => entry.ref === opportunity?.artifact_path,
    ),
    {
      ref: opportunity?.artifact_path,
      content_hash: canonicalContentHash(opportunity?.document ?? {}),
    },
  );
});

test("formal setup projection rejects dangling explicit relationships", () => {
  const declarations = setupDeclarations();
  const opportunity = declarations.find(
    (entry) => entry.document.schema_version === "startup_opportunity.opportunity_space_map.v1",
  );
  assert.ok(opportunity);
  (opportunity.local_refs as Record<string, string>).seed_probe_ref = "missing-seed";
  assert.throws(
    () =>
      projectDiscoverySetup(declarations, projectionContext(), {
        policyRef: "harness/policies/discovery-maps.current.json",
        document: {
          schema_version: "startup_opportunity.discovery_maps_policy.current",
          policy_version: "1.0.0",
          artifact_paths: {
            seed_probe: "artifacts/discovery/seed-probe.r1.json",
            opportunity_space_map: "artifacts/discovery/opportunity-space-map.r1.json",
            solution_space_map: "artifacts/discovery/solution-space-map.r1.json",
          },
        },
      }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "formal_materialization.local_ref_dangling",
  );
});

function fanInProjectionFixture(): {
  readonly context: DiscoveryStageProjectionContext;
  readonly authority: CandidateFanInAuthority;
  readonly declaration: DiscoveryObjectDeclaration;
} {
  const runId = "projection-current-run";
  const dispatchRef = "tasks/dispatch/fan-in-authority.r1.json";
  const taskRef = "tasks/discovery/unit-demand.attempt-1.json";
  const laneResultRef = "artifacts/discovery/lanes/unit-demand.attempt-1.json";
  const receiptRef = "receipts/lane-unit-demand.json";
  const candidateRef = "artifacts/discovery/candidates/demand.r1.json";
  const judgmentRef = "artifacts/discovery/judgments/demand.json";
  const weakRef = "artifacts/discovery/evidence/weak.json";
  const opposingRef = "artifacts/discovery/claims/opposing.json";
  const backgroundRef = "artifacts/discovery/findings/background.json";
  const taskOutputSchema = "startup_opportunity.discovery_lane_result.v1";
  const task = {
    schema_version: "startup_opportunity.research_task.discovery_candidate.current",
    task_id: "task_unit_demand_attempt_1",
    run_id: runId,
    unit_id: "unit-demand",
    attempt: 1,
    research_plan_ref: "plans/research-plan.r1.json",
    allowed_output_path: laneResultRef,
    required_artifact_schema: taskOutputSchema,
    lane_submission_contract: deriveLaneSubmissionContract({
      runId,
      unitId: "unit-demand",
      taskId: "task_unit_demand_attempt_1",
      attempt: 1,
      formalOutputPath: laneResultRef,
      formalArtifactSchema: taskOutputSchema,
      commercialAuditOutputPath: "artifacts/research-audits/unit-demand.json",
    }),
  };
  const laneResult = {
    schema_version: "startup_opportunity.discovery_lane_result.v1",
    run_id: runId,
    unit_id: "unit-demand",
    attempt: 1,
    task_ref: taskRef,
    status: "partial",
    pre_kill_decisions: [
      {
        candidate_ref: candidateRef,
        judgment_assessment_refs: [judgmentRef],
      },
    ],
    scope_outcomes: [
      { scope_key: "demand", disposition: "partial" },
      { scope_key: "availability", disposition: "unavailable" },
      { scope_key: "proxy", disposition: "inferred" },
    ],
  };
  const candidate = {
    schema_version: "startup_opportunity.discovery_candidate.v1",
    candidate_id: "candidate-demand",
    revision: 1,
    run_id: runId,
  };
  const judgment = {
    schema_version: "startup_opportunity.judgment_assessment.discovery_candidate.current",
    run_id: runId,
  };
  const weak = {
    schema_version: "startup_opportunity.evidence.discovery_candidate.current",
    run_id: runId,
    evidence_strength: "weak",
  };
  const opposing = {
    schema_version: "startup_opportunity.claim.discovery_candidate.current",
    run_id: runId,
    stance: "oppose",
  };
  const background = {
    schema_version: "startup_opportunity.finding.discovery_candidate.current",
    run_id: runId,
    evidence_role: "background",
  };
  const delivered = [
    [laneResultRef, laneResult],
    [candidateRef, candidate],
    [judgmentRef, judgment],
    [weakRef, weak],
    [opposingRef, opposing],
    [backgroundRef, background],
  ].map(([artifactRef, document]) => ({
    artifact_ref: artifactRef,
    artifact_type: (document as Record<string, unknown>).schema_version,
    content_hash: canonicalContentHash(document as Record<string, unknown>),
  }));
  const dispatch = {
    schema_version: "startup_opportunity.dispatch_batch.discovery.current",
    run_id: runId,
    mode: "opportunity_discovery",
    research_plan_ref: "plans/research-plan.r1.json",
    execution_plan_ref: "plans/research-execution.r1.json",
    tasks: [
      {
        task_id: task.task_id,
        unit_id: task.unit_id,
        allowed_output_path: task.allowed_output_path,
        required_artifact_schema: task.required_artifact_schema,
        commercial_audit_output_path: "artifacts/research-audits/unit-demand.json",
        lane_submission_contract: task.lane_submission_contract,
        straggler_policy: { on_timeout: "publish_partial", grace_minutes: 5, blocks_stage: false },
      },
    ],
  };
  const receipt = {
    schema_version: "startup_opportunity.lane_delivery_receipt.current",
    run_id: runId,
    task_ref: taskRef,
    research_plan_ref: "plans/research-plan.r1.json",
    execution_plan_ref: "plans/research-execution.r1.json",
    dispatch_task_ref: `${dispatchRef}#${task.task_id}`,
    delivered_artifacts: delivered.filter((entry) => entry.artifact_ref !== candidateRef),
  };
  const context = projectionContext({
    [dispatchRef]: dispatch,
    [taskRef]: task,
    [laneResultRef]: laneResult,
    [receiptRef]: receipt,
    [candidateRef]: candidate,
    [judgmentRef]: judgment,
    [weakRef]: weak,
    [opposingRef]: opposing,
    [backgroundRef]: background,
  });
  return {
    context,
    authority: {
      dispatch_ref: dispatchRef,
      lanes: [
        {
          unit_id: "unit-demand",
          status: "partial",
          lane_result_ref: laneResultRef,
          delivery_receipt_ref: receiptRef,
          adopted_artifact_refs: [judgmentRef, weakRef, opposingRef, backgroundRef],
        },
      ],
    },
    declaration: {
      local_key: "fan-in-request",
      object_id: "fan-in-authored",
      action: "create",
      document: {
        schema_version: "startup_opportunity.discovery_fan_in.v2",
        fan_in_id: "fan-in-authored",
        candidate_dispositions: [
          {
            disposition_id: "retain-demand",
            candidate_ref: candidateRef,
            source_candidate_refs: [candidateRef],
            disposition: "retained",
            supporting_lane_result_refs: [laneResultRef],
            judgment_assessment_refs: [judgmentRef],
            rationale: "Partial and opposing material remain visible.",
            limitations: ["Evidence remains weak and conflicting."],
          },
        ],
        candidate_diversity_summary: { known_blind_spots: ["Availability remains unavailable."] },
        evidence_sufficiency_summary: "insufficient_evidence",
        opposing_evidence_summary: ["Opposing Claim retained."],
        pre_kill_summary: ["No semantic default applied."],
        limitations: ["Fan-in is partial."],
      },
    },
  };
}

test("candidate fan-in uses exact Dispatch delivery authority and preserves extra material", () => {
  const fixture = fanInProjectionFixture();
  const [projected] = projectCandidateFanIn(
    [fixture.declaration],
    fixture.authority,
    fixture.context,
  );
  assert.equal(projected?.artifact_path, "artifacts/discovery/fan-in.r1.json");
  assert.deepEqual(projected?.document.lane_result_classification, {
    completed_refs: [],
    partial_refs: [fixture.authority.lanes[0]?.lane_result_ref],
    insufficient_evidence_refs: [],
    failed_refs: [],
    ignored_late_refs: [],
    superseded_refs: [],
    cancelled_units: [],
    skipped_units: [],
    missing_units: [],
  });
  assert.equal(projected?.document.evidence_sufficiency_summary, "insufficient_evidence");
  assert.deepEqual(projected?.document.opposing_evidence_summary, ["Opposing Claim retained."]);
  const dispositions = projected?.document.candidate_dispositions as Record<string, unknown>[];
  assert.equal(dispositions[0]?.rationale, "Partial and opposing material remain visible.");
  assert.equal(dispositions.length, 1);
});

test("fan-in replay classification binds non-delivery status and decision impact", () => {
  const base: CandidateFanInAuthority["lanes"] = [
    {
      unit_id: "cancelled-unit",
      status: "cancelled",
      adopted_artifact_refs: [],
      decision_impact: "The Main Agent explicitly stopped this Unit.",
    },
    {
      unit_id: "missing-unit",
      status: "missing",
      adopted_artifact_refs: [],
      decision_impact: "The missing Lane leaves one decision input unknown.",
    },
  ];
  const planned = projectFanInLaneClassification(base);
  assert.deepEqual(planned.cancelled_units, [
    {
      unit_id: "cancelled-unit",
      decision_impact: "The Main Agent explicitly stopped this Unit.",
    },
  ]);
  assert.notDeepEqual(
    projectFanInLaneClassification([
      { ...base[0], decision_impact: "Changed impact." },
      { ...base[1], status: "skipped" },
    ] as CandidateFanInAuthority["lanes"]),
    planned,
  );
});

test("formal replay relation check resolves request-local keys to exact planned paths", () => {
  const declarations: DiscoveryObjectDeclaration[] = [
    {
      local_key: "demand-local",
      object_id: "demand-authored",
      action: "create",
      document: {
        schema_version: "startup_opportunity.demand_thesis.v1",
        demand_id: "demand-authored",
      },
    },
    {
      local_key: "baseline-local",
      object_id: "baseline-authored",
      action: "create",
      document: {
        schema_version: "startup_opportunity.baseline_option.v1",
        baseline_id: "baseline-authored",
      },
      local_refs: { demand_thesis_ref: "demand-local" },
    },
  ];
  const planned = [
    {
      artifact_type: "startup_opportunity.demand_thesis.v1",
      artifact_path: "artifacts/discovery/demands/demand-authored.r1.json",
      document: {
        schema_version: "startup_opportunity.demand_thesis.v1",
        demand_id: "demand-authored",
      },
    },
    {
      artifact_type: "startup_opportunity.baseline_option.v1",
      artifact_path: "artifacts/discovery/baselines/baseline-authored.r1.json",
      document: {
        schema_version: "startup_opportunity.baseline_option.v1",
        baseline_id: "baseline-authored",
        demand_thesis_ref: "artifacts/discovery/demands/demand-authored.r1.json",
      },
    },
  ];
  assert.equal(projectedLocalRefsMatch(declarations, planned), true);
  const changed = structuredClone(declarations);
  const baseline = changed[1];
  assert.ok(baseline);
  (baseline as unknown as Record<string, unknown>).local_refs = {
    demand_thesis_ref: "stored-demand.r1.json",
  };
  assert.equal(projectedLocalRefsMatch(changed, planned), false);
});

test("candidate fan-in rejects an adopted Artifact absent from the Lane receipt", () => {
  const fixture = fanInProjectionFixture();
  const firstLane = fixture.authority.lanes[0] as CandidateFanInAuthority["lanes"][number];
  const authority: CandidateFanInAuthority = {
    dispatch_ref: fixture.authority.dispatch_ref,
    lanes: [
      {
        ...firstLane,
        adopted_artifact_refs: [
          ...firstLane.adopted_artifact_refs,
          "artifacts/discovery/evidence/not-delivered.json",
        ],
      },
    ],
  };
  assert.throws(
    () => projectCandidateFanIn([fixture.declaration], authority, fixture.context),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "formal_materialization.fan_in_delivery_mismatch",
  );
});

test("candidate fan-in rejects missing or non-Dispatch Lane declarations", () => {
  const fixture = fanInProjectionFixture();
  assert.throws(
    () =>
      projectCandidateFanIn(
        [fixture.declaration],
        { dispatch_ref: fixture.authority.dispatch_ref, lanes: [] },
        fixture.context,
      ),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "formal_materialization.fan_in_lane_set_mismatch",
  );
});

test("G2.3 projection resolves multiple explicit local refs without semantic rewriting", () => {
  const context = projectionContext();
  const declarations: DiscoveryObjectDeclaration[] = [
    {
      local_key: "demand",
      object_id: "demand-authored",
      action: "create",
      document: {
        schema_version: "startup_opportunity.demand_thesis.v1",
        demand_id: "demand-authored",
        research_state: "unknown",
        conflicts: ["Supporting and opposing Evidence conflict."],
        limitations: ["Demand is partial."],
      },
    },
    {
      local_key: "solution-a-key",
      object_id: "solution-a",
      action: "create",
      document: {
        schema_version: "startup_opportunity.solution_hypothesis.v1",
        solution_id: "solution-a",
        research_state: "inferred",
        limitations: ["Solution is inferred."],
      },
      local_refs: { demand_thesis_ref: "demand" },
    },
    {
      local_key: "solution-b-key",
      object_id: "solution-b",
      action: "create",
      document: {
        schema_version: "startup_opportunity.solution_hypothesis.v1",
        solution_id: "solution-b",
        research_state: "unavailable",
        limitations: ["Evaluation material is unavailable."],
      },
      local_refs: { demand_thesis_ref: "demand" },
    },
    {
      local_key: "evaluation",
      object_id: "evaluation-authored",
      action: "create",
      document: {
        schema_version: "startup_opportunity.solution_evaluation.v1",
        evaluation_id: "evaluation-authored",
        decision_sufficiency: "insufficient_evidence",
        solution_hypothesis_refs: [],
        alternative_solution_refs: [],
        limitations: ["Terminal insufficiency remains honest."],
      },
      local_refs: {
        demand_thesis_ref: "demand",
        solution_hypothesis_refs: ["solution-a-key", "solution-b-key"],
        selected_solution_ref: "solution-a-key",
        alternative_solution_refs: ["solution-b-key"],
      },
    },
  ];
  const projected = projectDiscoverySynthesis(declarations, context);
  const byId = new Map(
    projected.map((entry) => [
      entry.document.demand_id ?? entry.document.solution_id ?? entry.document.evaluation_id,
      entry,
    ]),
  );
  const demand = byId.get("demand-authored");
  const solutionA = byId.get("solution-a");
  const solutionB = byId.get("solution-b");
  const evaluation = byId.get("evaluation-authored");
  assert.equal(demand?.document.research_state, "unknown");
  assert.equal(solutionA?.document.research_state, "inferred");
  assert.equal(solutionB?.document.research_state, "unavailable");
  assert.equal(evaluation?.document.decision_sufficiency, "insufficient_evidence");
  assert.deepEqual(evaluation?.document.solution_hypothesis_refs, [
    solutionA?.artifact_path,
    solutionB?.artifact_path,
  ]);
  assert.equal(evaluation?.document.selected_solution_ref, solutionA?.artifact_path);
  assert.deepEqual(evaluation?.document.alternative_solution_refs, [solutionB?.artifact_path]);
  assert.deepEqual(demand?.document.conflicts, ["Supporting and opposing Evidence conflict."]);
});

test("G2.3 revision binds the exact same-Run parent and rejects invalid relations", () => {
  const parentRef = "artifacts/discovery/demands/demand-authored.r1.json";
  const parent = {
    schema_version: "startup_opportunity.demand_thesis.v1",
    demand_id: "demand-authored",
    revision: 1,
    run_id: "projection-current-run",
    research_state: "partial",
  };
  const context = projectionContext({ [parentRef]: parent });
  const [revision] = projectDiscoverySynthesis(
    [
      {
        local_key: "demand-revision",
        object_id: "demand-authored",
        action: "revise",
        document: {
          schema_version: "startup_opportunity.demand_thesis.v1",
          demand_id: "demand-authored",
          research_state: "no_evidence_found",
          limitations: ["No Evidence found is not unavailable."],
        },
        local_refs: { parent: parentRef },
      },
    ],
    context,
  );
  assert.equal(revision?.artifact_path, "artifacts/discovery/demands/demand-authored.r2.json");
  assert.equal(revision?.document.parent_demand_ref, parentRef);
  assert.equal(revision?.document.parent_content_hash, canonicalContentHash(parent));
  assert.equal(revision?.document.research_state, "no_evidence_found");

  const foreignParent = { ...parent, run_id: "another-run" };
  assert.throws(
    () =>
      projectDiscoverySynthesis(
        [
          {
            local_key: "foreign-demand-revision",
            object_id: "demand-authored",
            action: "revise",
            document: {
              schema_version: "startup_opportunity.demand_thesis.v1",
              demand_id: "demand-authored",
              limitations: ["Cross-Run parent must fail closed."],
            },
            local_refs: { parent: parentRef },
          },
        ],
        projectionContext({ [parentRef]: foreignParent }),
      ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "formal_materialization.parent_invalid",
  );

  const currentParentRef = "artifacts/discovery/demands/demand-authored.r2.json";
  const currentParent = { ...parent, revision: 2 };
  assert.throws(
    () =>
      projectDiscoverySynthesis(
        [
          {
            local_key: "stale-demand-revision",
            object_id: "demand-authored",
            action: "revise",
            document: {
              schema_version: "startup_opportunity.demand_thesis.v1",
              demand_id: "demand-authored",
              limitations: ["Stale selected parent must fail closed."],
            },
            local_refs: { parent: parentRef },
          },
        ],
        projectionContext({ [parentRef]: parent, [currentParentRef]: currentParent }),
      ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "formal_materialization.parent_not_current",
  );

  assert.throws(
    () =>
      projectDiscoverySynthesis(
        [
          {
            local_key: "solution",
            object_id: "solution-authored",
            action: "create",
            document: {
              schema_version: "startup_opportunity.solution_hypothesis.v1",
              solution_id: "solution-authored",
              limitations: ["Explicit wrong relation."],
            },
            local_refs: { demand_thesis_ref: "solution" },
          },
        ],
        context,
      ),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "formal_materialization.local_ref_type_mismatch",
  );
});

test("G2.3 explicit relations fail closed for unknown fields and non-Run targets", () => {
  const declaration: DiscoveryObjectDeclaration = {
    local_key: "demand",
    object_id: "demand-authored",
    action: "create",
    document: {
      schema_version: "startup_opportunity.demand_thesis.v1",
      demand_id: "demand-authored",
      limitations: ["No semantics are inferred."],
    },
    local_refs: { invented_relation_ref: "scope.json" },
  };
  assert.throws(
    () =>
      projectDiscoverySynthesis(
        [declaration],
        projectionContext({
          "scope.json": {
            schema_version: "startup_opportunity.scope_frame.discovery.current",
          },
        }),
      ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "formal_materialization.cross_run_ref",
  );
  const sameRun = projectionContext({
    "scope.json": {
      schema_version: "startup_opportunity.scope_frame.discovery.current",
      run_id: "projection-current-run",
    },
  });
  assert.throws(
    () => projectDiscoverySynthesis([declaration], sameRun),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "formal_materialization.local_ref_relation_unknown",
  );
});

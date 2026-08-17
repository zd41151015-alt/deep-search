import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import {
  canonicalContentHash,
  type DocumentBundle,
  EvidenceStore,
  type EvidenceStoreRecord,
  type FormalArtifactEnvelope,
  planningRunStateHash,
  RunStore,
  transformAssessmentPlan,
  transformPlan,
} from "../../../harness/src/index.js";
import { createConfirmedRun, publishInitialPlanBundle } from "../../helpers/current-run.js";
import {
  branchResearchEnvelopes,
  dispatchEnvelope,
  executionPlanEnvelope,
  type FixtureBranch,
  taskEnvelope,
} from "../g1.2/research-branch-fixture.js";

export const G13_BASE_TIME = "2026-07-25T16:00:00Z";
export const G13_PLAN_REF = "plans/research-plan.r1.json";
export const G13_ASSESSMENT_PLAN_REF = "plans/concept-evidence-assessment-plan.r1.json";
export const G13_CONTEXT_REF = "plans/planning-context.r1.json";
export const G13_BUYER_BRANCH: FixtureBranch = {
  unitId: "unit_buyer",
  dimensionId: "buyer_language_and_willingness_to_pay",
  outputPath: "artifacts/lanes/buyer.json",
  judgmentRef: "judgments/judgment-buyer.json",
  supportClaimType: "buyer_signal",
  opposeClaimType: "counter_evidence",
};
export const G13_ACQUISITION_BRANCH: FixtureBranch = {
  unitId: "unit_acquisition",
  dimensionId: "acquisition_and_distribution",
  outputPath: "artifacts/lanes/acquisition.json",
  judgmentRef: "judgments/judgment-acquisition.json",
  supportClaimType: "acquisition_signal",
  opposeClaimType: "counter_evidence",
};

export interface G13FixtureState {
  readonly repositoryRoot: string;
  readonly runsRoot: string;
  readonly runRoot: string;
  readonly runId: string;
  readonly branch: FixtureBranch;
  readonly store: RunStore;
  readonly baseBundle: {
    readonly documents: readonly {
      readonly path: string;
      readonly document: Record<string, unknown>;
    }[];
  };
  readonly records: EvidenceStoreRecord[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function formalEnvelope(
  runId: string,
  artifactPath: string,
  document: Record<string, unknown>,
  version: FormalArtifactEnvelope["schema_version"],
  producerRole: string,
  inputRefs: readonly string[],
  createdAt: string,
): FormalArtifactEnvelope {
  return {
    schema_version: version,
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    run_id: runId,
    created_at: createdAt,
    producer_role: producerRole,
    input_refs: [...new Set(inputRefs)].sort(),
    content_hash: canonicalContentHash(document),
    document,
  };
}

function withRun(envelope: FormalArtifactEnvelope, runId: string): FormalArtifactEnvelope {
  const document = { ...envelope.document, run_id: runId };
  return {
    ...envelope,
    run_id: runId,
    content_hash: canonicalContentHash(document),
    document,
  };
}

function planningContext(
  manifest: Record<string, unknown>,
  plan: Record<string, unknown>,
  options: {
    readonly path: string;
    readonly revision: number;
    readonly parentRef: string | null;
    readonly stage: "current_plan" | "candidate_revision";
    readonly createdAt: string;
  },
): { readonly path: string; readonly document: Record<string, unknown> } {
  const targetPlanRef =
    options.stage === "candidate_revision"
      ? `plans/research-plan.r${String(plan.revision)}.json`
      : G13_PLAN_REF;
  return {
    path: options.path,
    document: {
      schema_version: "startup_opportunity.planning_context.ai_source_bound.current",
      context_id: `planning_context_${String(manifest.run_id).replaceAll("-", "_")}`,
      revision: options.revision,
      parent_context_ref: options.parentRef,
      run_id: manifest.run_id,
      mode: "concept_evidence_assessment",
      phase: "assessment",
      validation_stage: options.stage,
      manifest_binding: {
        manifest_ref: "manifest.json",
        manifest_schema_version: "startup_opportunity.run_manifest.v1",
        run_id: manifest.run_id,
        mode: manifest.mode,
        current_plan_ref: manifest.current_plan_ref,
        current_plan_revision: manifest.plan_revision,
        run_state_hash: planningRunStateHash({
          manifest_ref: "manifest.json",
          manifest_schema_version: "startup_opportunity.run_manifest.v1",
          run_id: String(manifest.run_id),
          mode: String(manifest.mode),
          current_plan_ref: String(manifest.current_plan_ref),
          current_plan_revision: Number(manifest.plan_revision),
        }),
      },
      target_plan_binding: {
        plan_ref: targetPlanRef,
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

export async function bundleFromRun(state: G13FixtureState): Promise<DocumentBundle> {
  const loaded = await state.store.load(state.runId);
  const documents: { path: string; document: Record<string, unknown> }[] = [
    { path: "manifest.json", document: loaded.manifest as unknown as Record<string, unknown> },
  ];
  const formalRefs = [
    ...loaded.manifest.artifact_refs,
    ...(loaded.manifest.checkpoint_ref === null ? [] : [loaded.manifest.checkpoint_ref]),
  ];
  for (const artifactRef of [...new Set(formalRefs)].sort()) {
    documents.push({
      path: artifactRef,
      document: JSON.parse(await readFile(path.join(state.runRoot, artifactRef), "utf8")) as Record<
        string,
        unknown
      >,
    });
  }
  const decisionRecords = (await readFile(path.join(state.runRoot, "decisions.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    schema_version: "startup_opportunity.document_bundle.current",
    documents,
    exact_records: [
      ...decisionRecords.map((record) => ({
        ref: `decisions.jsonl#${String(record.decision_id)}`,
        document: record,
      })),
      ...state.records.map((record) => ({
        ref: `evidence/manifest.jsonl#${record.evidence_id}`,
        document: record,
      })),
    ],
  };
}

export async function prepareG13Run(
  context: TestContext,
  repositoryRoot: string,
  runId: string,
  branch: FixtureBranch = G13_BUYER_BRANCH,
): Promise<G13FixtureState> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g1-3-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runRoot = path.join(runsRoot, runId);
  const store = new RunStore(
    runsRoot,
    await import("../../../harness/src/index.js").then((module) =>
      module.createArtifactValidator(repositoryRoot),
    ),
  );
  await createConfirmedRun(store, {
    runId,
    mode: "concept_evidence_assessment",
    createdAt: G13_BASE_TIME,
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
  });

  const baseBundle = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "tests/fixtures/g1.1/valid-assess-contract-bundle.json"),
      "utf8",
    ),
  ) as G13FixtureState["baseBundle"];
  const selectedPaths = new Set([
    "intake.json",
    "decision-context.json",
    "scope-frame.json",
    "concept-hypothesis.json",
    G13_PLAN_REF,
    G13_ASSESSMENT_PLAN_REF,
    G13_BUYER_BRANCH.judgmentRef,
    G13_ACQUISITION_BRANCH.judgmentRef,
  ]);
  const initial = baseBundle.documents
    .filter((entry) => selectedPaths.has(entry.path))
    .map((entry) => {
      const document = { ...clone(entry.document), run_id: runId };
      return formalEnvelope(
        runId,
        entry.path,
        document,
        "startup_opportunity.artifact_envelope.current",
        "main_agent",
        [],
        "2026-07-25T16:01:00Z",
      );
    });
  await publishInitialPlanBundle(store, runId, initial, "assessment");

  const task = withRun(taskEnvelope(baseBundle, branch, 2), runId);
  const currentPlan = initial.find((entry) => entry.artifact_path === G13_PLAN_REF)?.document;
  if (currentPlan === undefined) throw new Error("missing synthetic current Research Plan");
  const execution = withRun(executionPlanEnvelope(baseBundle, [branch]), runId);
  execution.document.research_plan_hash = canonicalContentHash(currentPlan);
  (execution as { content_hash: string }).content_hash = canonicalContentHash(execution.document);
  const dispatch = withRun(dispatchEnvelope(baseBundle, [branch]), runId);
  await store.publishArtifactBundle({ runId, envelopes: [execution, dispatch, task] });
  const evidenceStore = new EvidenceStore(runsRoot);
  const researchGoal = String(task.document.research_goal);
  const first = await evidenceStore.record({
    runId,
    unitId: branch.unitId,
    researchGoal,
    source: {
      kind: "public_url",
      canonical_url: "https://buyer-gap.synthetic.invalid/current-language",
    },
    rawContent: "SYNTHETIC BUYER GAP SUPPORT BYTES; NOT MARKET EVIDENCE.",
    recordedAt: "2026-07-25T16:03:00Z",
  });
  const second = await evidenceStore.record({
    runId,
    unitId: branch.unitId,
    researchGoal,
    source: {
      kind: "user_provided",
      canonical_uri: "urn:startup-opportunity:user-provided:g1-3-buyer-gap:oppose",
    },
    rawContent: "SYNTHETIC BUYER GAP OPPOSING BYTES; NOT MARKET EVIDENCE.",
    recordedAt: "2026-07-25T16:04:00Z",
  });
  const records = [first.record, second.record] as const;
  const branchEnvelopes = branchResearchEnvelopes(branch, records, 5).map((entry) =>
    withRun(entry, runId),
  );
  await store.publishArtifactBundle({ runId, envelopes: branchEnvelopes });

  return {
    repositoryRoot,
    runsRoot,
    runRoot,
    runId,
    branch,
    store,
    baseBundle,
    records: [...records],
  };
}

export async function publishAdditionalG13Branch(
  state: G13FixtureState,
  branch: FixtureBranch,
): Promise<void> {
  const task = withRun(taskEnvelope(state.baseBundle, branch, 7), state.runId);
  const storedPlan = JSON.parse(
    await readFile(path.join(state.runRoot, G13_PLAN_REF), "utf8"),
  ) as FormalArtifactEnvelope;
  const baseExecution = withRun(executionPlanEnvelope(state.baseBundle, [branch]), state.runId);
  const executionDocument = structuredClone(baseExecution.document);
  executionDocument.execution_plan_id = "execution_plan_g1_3_followup_synthetic";
  executionDocument.revision = 2;
  executionDocument.parent_execution_plan_ref = "plans/research-execution.r1.json";
  executionDocument.research_plan_hash = canonicalContentHash(storedPlan.document);
  const executionStage = (executionDocument.stages as Record<string, unknown>[])[0];
  if (executionStage === undefined) throw new Error("missing synthetic follow-up execution stage");
  executionStage.stage_id = "commercial_research_followup";
  for (const lane of executionStage.lanes as Record<string, unknown>[]) {
    lane.dispatch_group = "commercial_research_followup";
  }
  const execution: FormalArtifactEnvelope = {
    ...baseExecution,
    artifact_path: "plans/research-execution.r2.json",
    input_refs: [G13_PLAN_REF, "plans/research-execution.r1.json"],
    content_hash: canonicalContentHash(executionDocument),
    document: executionDocument,
  };

  const baseDispatch = withRun(dispatchEnvelope(state.baseBundle, [branch]), state.runId);
  const dispatchDocument = structuredClone(baseDispatch.document);
  dispatchDocument.batch_id = "dispatch_commercial_research_followup";
  dispatchDocument.execution_plan_ref = execution.artifact_path;
  dispatchDocument.stage_id = executionStage.stage_id;
  dispatchDocument.dispatch_group = "commercial_research_followup";
  const dispatch: FormalArtifactEnvelope = {
    ...baseDispatch,
    artifact_path: "tasks/dispatch/commercial-research-followup.r1.json",
    input_refs: [execution.artifact_path, G13_PLAN_REF],
    content_hash: canonicalContentHash(dispatchDocument),
    document: dispatchDocument,
  };
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [execution, dispatch, task],
  });
  const evidenceStore = new EvidenceStore(state.runsRoot);
  const researchGoal = String(task.document.research_goal);
  const first = await evidenceStore.record({
    runId: state.runId,
    unitId: branch.unitId,
    researchGoal,
    source: {
      kind: "public_url",
      canonical_url: `https://${branch.unitId}.synthetic.invalid/current-signal`,
    },
    rawContent: `SYNTHETIC ${branch.unitId} SUPPORT BYTES; NOT MARKET EVIDENCE.`,
    recordedAt: "2026-07-25T16:12:00Z",
  });
  const second = await evidenceStore.record({
    runId: state.runId,
    unitId: branch.unitId,
    researchGoal,
    source: {
      kind: "user_provided",
      canonical_uri: `urn:startup-opportunity:user-provided:g1-3-${branch.unitId}:oppose`,
    },
    rawContent: `SYNTHETIC ${branch.unitId} OPPOSING BYTES; NOT MARKET EVIDENCE.`,
    recordedAt: "2026-07-25T16:13:00Z",
  });
  const records = [first.record, second.record] as const;
  state.records.push(...records);
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: branchResearchEnvelopes(branch, records, 7).map((entry) =>
      withRun(entry, state.runId),
    ),
  });
}

export function addUnitDecision(
  runId: string,
  gapPath: string,
  snapshot: Record<string, unknown>,
): { readonly path: string; readonly document: Record<string, unknown> } {
  const gap = (snapshot.gaps as Record<string, unknown>[])[0];
  if (gap === undefined) {
    throw new Error("synthetic snapshot has no gap");
  }
  const unitType = String(gap.recommended_unit_type);
  const target = unitType === "acquisition" ? "acquisition" : "buyer";
  const sourceUnitId = String(
    (snapshot.observed_artifacts as Record<string, unknown>[])[0]?.unit_id,
  );
  const path = `adaptations/decisions/add-${target}-followup-r2.json`;
  return {
    path,
    document: {
      schema_version: "startup_opportunity.adaptation_decision.assessment.current",
      adaptation_id: `adapt_add_${target}_followup_r2`,
      run_id: runId,
      based_on_plan_ref: snapshot.based_on_plan_ref,
      based_on_plan_revision: snapshot.based_on_plan_revision,
      based_on_plan_hash: snapshot.based_on_plan_hash,
      assessment_plan_ref: snapshot.assessment_plan_ref,
      assessment_plan_revision: snapshot.assessment_plan_revision,
      assessment_plan_hash: snapshot.assessment_plan_hash,
      subject_ref: snapshot.subject_ref,
      scope_frame_ref: snapshot.scope_frame_ref,
      scope_frame_hash: snapshot.scope_frame_hash,
      trigger_gap_refs: [`${gapPath}#${String(gap.gap_id)}`],
      coverage_key: snapshot.coverage_key,
      action: "add_unit",
      target_unit: {
        unit_id: `unit_${target}_followup_r2`,
        unit_type: unitType,
        plan_disposition: "enabled",
        priority_band: "high",
        attempt: 1,
        supersedes_unit_ref: null,
        research_goal: `Collect bounded follow-up Evidence for the exact current ${target} gap.`,
        input_refs: [
          "concept-hypothesis.json",
          "scope-frame.json",
          `${gapPath}#${String(gap.gap_id)}`,
        ],
        depends_on: [sourceUnitId],
        agent_role: "lane-researcher",
        output_path: `artifacts/lanes/${target}-followup-r2.json`,
        required_artifact_schema:
          "startup_opportunity.concept_evidence_assessment_branch_result.v1",
        source_preferences: ["public_sources", "user_provided_existing_material"],
        required_outputs: ["Evidence", "Claim", "Finding", "Insight", "Source Manifest"],
        stop_conditions: ["Stop after one bounded follow-up attempt."],
      },
      candidate_assessment_plan_ref: "plans/concept-evidence-assessment-plan.r2.json",
      reason: `The current ${target} branch is insufficient and declares an executable follow-up.`,
      expected_decision_impact: gap.decision_impact,
      success_condition: `A new immutable ${target} branch Artifact resolves or closes the gap.`,
      requested_by: "main_agent",
      created_at: "2026-07-25T16:22:00Z",
    },
  };
}

export function stopDecision(
  runId: string,
  gapPath: string,
  snapshot: Record<string, unknown>,
): { readonly path: string; readonly document: Record<string, unknown> } {
  const gap = (snapshot.gaps as Record<string, unknown>[])[0];
  if (gap === undefined) {
    throw new Error("synthetic snapshot has no gap");
  }
  return {
    path: "adaptations/decisions/stop-buyer-followup.json",
    document: {
      schema_version: "startup_opportunity.adaptation_decision.assessment.current",
      adaptation_id: "adapt_stop_buyer_followup",
      run_id: runId,
      based_on_plan_ref: snapshot.based_on_plan_ref,
      based_on_plan_revision: snapshot.based_on_plan_revision,
      based_on_plan_hash: snapshot.based_on_plan_hash,
      assessment_plan_ref: snapshot.assessment_plan_ref,
      assessment_plan_revision: snapshot.assessment_plan_revision,
      assessment_plan_hash: snapshot.assessment_plan_hash,
      subject_ref: snapshot.subject_ref,
      scope_frame_ref: snapshot.scope_frame_ref,
      scope_frame_hash: snapshot.scope_frame_hash,
      trigger_gap_refs: [`${gapPath}#${String(gap.gap_id)}`],
      coverage_key: snapshot.coverage_key,
      action: "stop_followup",
      reason: "The closed Gap Snapshot requires no further buyer follow-up.",
      expected_decision_impact: gap.decision_impact,
      stop_condition: "Retain the published limitation and do not create a retry wave.",
      requested_by: "main_agent",
      created_at: "2026-07-25T16:22:00Z",
    },
  };
}

export function candidateBundle(
  adaptationBundle: DocumentBundle,
  decision: { readonly path: string; readonly document: Record<string, unknown> },
): DocumentBundle {
  const manifest = adaptationBundle.documents.find((entry) => entry.path === "manifest.json")
    ?.document as Record<string, unknown>;
  const basePlan = adaptationBundle.documents.find((entry) => entry.path === G13_PLAN_REF)
    ?.document as Record<string, unknown>;
  const effectiveBasePlan =
    basePlan.schema_version === "startup_opportunity.artifact_envelope.current"
      ? (basePlan.document as Record<string, unknown>)
      : basePlan;
  const baseAssessmentEntry = adaptationBundle.documents.find(
    (entry) => entry.path === G13_ASSESSMENT_PLAN_REF,
  )?.document as Record<string, unknown>;
  const effectiveBaseAssessment =
    baseAssessmentEntry.schema_version === "startup_opportunity.artifact_envelope.current"
      ? (baseAssessmentEntry.document as Record<string, unknown>)
      : baseAssessmentEntry;
  const effectiveManifest = manifest.schema_version
    ?.toString()
    .startsWith("startup_opportunity.artifact_envelope.")
    ? (manifest.document as Record<string, unknown>)
    : manifest;
  const transformed = transformPlan(
    G13_PLAN_REF,
    effectiveBasePlan,
    effectiveManifest as never,
    [decision],
    "2026-07-25T16:23:00Z",
  );
  if (transformed.plan === null) {
    throw new Error("synthetic add_unit did not create a Research Plan revision");
  }
  const assessment = transformAssessmentPlan(
    G13_ASSESSMENT_PLAN_REF,
    effectiveBaseAssessment,
    transformed.planPath,
    [decision],
    "2026-07-25T16:23:00Z",
  );
  if (assessment.plan === null) {
    throw new Error("synthetic add_unit did not create an assessment plan revision");
  }
  const candidateContext = planningContext(effectiveManifest, transformed.plan, {
    path: "plans/planning-context.r2.json",
    revision: 2,
    parentRef: G13_CONTEXT_REF,
    stage: "candidate_revision",
    createdAt: "2026-07-25T16:23:30Z",
  });
  return {
    ...adaptationBundle,
    documents: [
      ...adaptationBundle.documents,
      { path: transformed.planPath, document: transformed.plan },
      { path: assessment.planPath, document: assessment.plan },
      candidateContext,
    ],
  };
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  canonicalJson,
  createAdaptationPolicyValidator,
  createArtifactValidator,
  createAssessmentGapAnalyzer,
  createAssessmentPlanSemanticValidator,
  createPlanRevisionRuntime,
  type DocumentBundle,
  type PlanApplyFaultBoundary,
  StoreError,
  validateAssessmentAdaptationContract,
} from "../harness/src/index.js";
import {
  addUnitDecision,
  bundleFromRun,
  candidateBundle,
  formalEnvelope,
  G13_ACQUISITION_BRANCH,
  G13_BUYER_BRANCH,
  type G13FixtureState,
  prepareG13Run,
  publishAdditionalG13Branch,
  stopDecision,
} from "./fixtures/g1.3/assessment-adaptation-fixture.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function clone<T>(value: T): T {
  return structuredClone(value);
}

function effectiveDocument(bundle: DocumentBundle, targetPath: string): Record<string, unknown> {
  const entry = bundle.documents.find((candidate) => candidate.path === targetPath);
  assert.ok(entry, `missing ${targetPath}`);
  const version = String(entry.document.schema_version);
  return version.startsWith("startup_opportunity.artifact_envelope.")
    ? (entry.document.document as Record<string, unknown>)
    : entry.document;
}

function refreshEnvelope(bundle: DocumentBundle, targetPath: string): void {
  const entry = bundle.documents.find((candidate) => candidate.path === targetPath);
  assert.ok(entry);
  if (String(entry.document.schema_version).startsWith("startup_opportunity.artifact_envelope.")) {
    entry.document.content_hash = canonicalContentHash(entry.document.document);
  }
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

const adaptationLifecycleFields = [
  "pending_adaptation_refs",
  "validated_adaptation_refs",
  "rejected_adaptation_refs",
  "applied_adaptation_refs",
] as const;

async function moveDecisionLifecycle(
  state: G13FixtureState,
  decisionRef: string,
  target: (typeof adaptationLifecycleFields)[number],
): Promise<void> {
  const manifestPath = path.join(state.runRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  for (const field of adaptationLifecycleFields) {
    const refs = manifest[field] as string[];
    manifest[field] = refs.filter((ref) => ref !== decisionRef);
  }
  manifest[target] = [...new Set([...(manifest[target] as string[]), decisionRef])].sort();
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
}

async function createGap(
  state: G13FixtureState,
  options: {
    readonly snapshotId?: string;
    readonly materialNewEvidenceObserved?: boolean;
    readonly bundle?: DocumentBundle;
    readonly branch?: typeof G13_BUYER_BRANCH;
    readonly createdAt?: string;
  } = {},
) {
  const currentBundle = options.bundle ?? (await bundleFromRun(state));
  const branch = options.branch ?? state.branch;
  const result = (await createAssessmentGapAnalyzer(repositoryRoot)).analyze({
    documentBundle: currentBundle,
    snapshotId: options.snapshotId ?? "buyer-gap-current",
    createdAt: options.createdAt ?? "2026-07-25T16:21:00Z",
    triggerKind: "wave_completed",
    waveId: "assessment_wave_1",
    triggerEventRef: null,
    dimensionId: branch.dimensionId as
      | "buyer_language_and_willingness_to_pay"
      | "acquisition_and_distribution",
    observedArtifactRefs: [branch.outputPath],
    materialNewEvidenceObserved: options.materialNewEvidenceObserved ?? true,
    limitations: ["Synthetic fixture only; no external validation was performed."],
  });
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.ok(result.snapshotPath);
  assert.ok(result.snapshot);
  return { currentBundle, result };
}

async function publishGapAndDecision(
  state: G13FixtureState,
  kind: "add" | "stop" = "add",
  materialNewEvidenceObserved = true,
) {
  const { result } = await createGap(state, { materialNewEvidenceObserved });
  const gapPath = result.snapshotPath as string;
  const snapshot = result.snapshot as Record<string, unknown>;
  const gapEnvelope = formalEnvelope(
    state.runId,
    gapPath,
    snapshot,
    "startup_opportunity.artifact_envelope.current",
    "harness",
    (snapshot.gaps as Record<string, unknown>[])[0]?.basis_refs as readonly string[],
    "2026-07-25T16:21:00Z",
  );
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: gapEnvelope,
  });
  const decision =
    kind === "add"
      ? addUnitDecision(state.runId, gapPath, snapshot)
      : stopDecision(state.runId, gapPath, snapshot);
  const decisionEnvelope = formalEnvelope(
    state.runId,
    decision.path,
    decision.document,
    "startup_opportunity.artifact_envelope.current",
    "main_agent",
    [
      `${gapPath}#${String((snapshot.gaps as Record<string, unknown>[])[0]?.gap_id)}`,
      String(snapshot.based_on_plan_ref),
      String(snapshot.assessment_plan_ref),
      String(snapshot.subject_ref),
      String(snapshot.scope_frame_ref),
    ],
    "2026-07-25T16:22:00Z",
  );
  await state.store.publishArtifact({ runId: state.runId, envelope: decisionEnvelope });
  return {
    gapPath,
    snapshot,
    decision,
    gapEnvelope,
    decisionEnvelope,
    adaptationBundle: await bundleFromRun(state),
  };
}

function applyInput(
  state: G13FixtureState,
  prepared: Awaited<ReturnType<typeof publishGapAndDecision>>,
  candidate?: DocumentBundle,
  faultAt?: PlanApplyFaultBoundary,
) {
  return {
    runId: state.runId,
    adaptationBundle: prepared.adaptationBundle,
    adaptationRefs: [prepared.decision.path],
    ...(candidate === undefined ? {} : { candidateBundle: candidate }),
    createdAt: "2026-07-25T16:23:00Z",
    checkpointCreatedAt: "2026-07-25T16:24:00Z",
    nextStep: "Execute only the bounded buyer follow-up unit, or retain the closed limitation.",
    beliefSummary: {
      current_belief: "Only synthetic G1.3 mechanics have been exercised.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["No real market Evidence was collected."],
      remaining_disagreement: ["The buyer thesis remains unverified."],
      next_decision_relevant_question: "Does bounded real Evidence change the buyer assessment?",
    },
    ...(faultAt === undefined ? {} : { faultAt }),
  } as const;
}

test("G1.3 buyer Gap creates exact Research Plan r2 and assessment plan r2 atomically", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_buyer_add_001");
  const prepared = await publishGapAndDecision(state);
  const adaptationValidation = (
    await createAdaptationPolicyValidator(repositoryRoot)
  ).validateDocumentBundle(prepared.adaptationBundle);
  assert.equal(adaptationValidation.valid, true, JSON.stringify(adaptationValidation));
  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const candidateValidation = (
    await createAssessmentPlanSemanticValidator(repositoryRoot)
  ).validateDocumentBundle(candidate);
  assert.equal(candidateValidation.valid, true, JSON.stringify(candidateValidation));

  const basePlanBytes = await readFile(path.join(state.runRoot, "plans/research-plan.r1.json"));
  const baseAssessmentBytes = await readFile(
    path.join(state.runRoot, "plans/concept-evidence-assessment-plan.r1.json"),
  );
  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  const input = applyInput(state, prepared, candidate);
  const first = await runtime.apply(input).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }));
    }
    throw error;
  });
  assert.equal(first.status, "applied");
  assert.equal(first.revisionCreated, true);
  assert.equal(first.currentPlanRef, "plans/research-plan.r2.json");
  assert.equal(first.currentAssessmentPlanRef, "plans/concept-evidence-assessment-plan.r2.json");
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");

  assert.deepEqual(
    await readFile(path.join(state.runRoot, "plans/research-plan.r1.json")),
    basePlanBytes,
  );
  assert.deepEqual(
    await readFile(path.join(state.runRoot, "plans/concept-evidence-assessment-plan.r1.json")),
    baseAssessmentBytes,
  );
  const researchR2 = JSON.parse(
    await readFile(path.join(state.runRoot, "plans/research-plan.r2.json"), "utf8"),
  ) as Record<string, unknown>;
  const assessmentR2 = JSON.parse(
    await readFile(
      path.join(state.runRoot, "plans/concept-evidence-assessment-plan.r2.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(researchR2.schema_version, "startup_opportunity.artifact_envelope.current");
  assert.equal(assessmentR2.schema_version, "startup_opportunity.artifact_envelope.current");
  const reopened = await state.store.load(state.runId);
  assert.equal(reopened.manifest.current_plan_ref, "plans/research-plan.r2.json");
  assert.equal(reopened.manifest.plan_revision, 2);
});

test("assessment Scope reconciliation creates semantic-copy Plans and recovers after Manifest CAS", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_scope_reconcile_001");
  const beforeScope = await state.store.load(state.runId);
  const proposal = await state.store.proposeScope({
    runId: state.runId,
    expectedScopeRevision: 1,
    proposedAt: "2026-07-25T16:20:10Z",
    reason: "The user revised the assessment geography after the current unit completed.",
    scopeProposal: {
      geography: "Synthetic revised geography",
      customerModel: "b2c",
      targetUsers: ["synthetic revised assessment user"],
      decisionGoal: "reconcile the revised Scope without inventing assessment work",
      researchLanguage: "en-US",
    },
  });
  const confirmation = await state.store.confirmScope({
    runId: state.runId,
    expectedScopeProposalRevision: proposal.scopeRevision,
    expectedScopeProposalRef: proposal.scopeProposalRef,
    expectedScopeProposalHash: proposal.scopeProposalHash,
    confirmedAt: "2026-07-25T16:20:20Z",
    userConfirmationAttestation:
      "The fixture caller attests exact confirmation of the revised assessment Scope.",
  });
  const trigger = {
    schema_version: "startup_opportunity.event.v1",
    event_id: "assessment_scope_reconciliation_trigger",
    run_id: state.runId,
    event_type: "artifact_validation_failed",
    timestamp: "2026-07-25T16:20:30Z",
    actor: "harness",
    reason: "The current assessment Plan predates the confirmed Scope revision.",
    artifact_refs: [confirmation.scopeConfirmationRef],
  };
  await state.store.appendEvent(state.runId, trigger);
  const triggerRef = `events.jsonl#${trigger.event_id}`;
  const baseBundle = await bundleFromRun(state);
  const exactRecords = new Map(
    (baseBundle.exact_records ?? []).map((entry) => [entry.ref, entry.document]),
  );
  exactRecords.set(triggerRef, trigger);
  const analysis = (await createAssessmentGapAnalyzer(repositoryRoot)).analyze({
    documentBundle: { ...baseBundle, exact_records: [] },
    referenceContext: { exactJsonlRecords: exactRecords },
    snapshotId: "assessment-scope-reconciliation",
    createdAt: "2026-07-25T16:20:40Z",
    triggerKind: "resume_reconciliation",
    waveId: "assessment_wave_1",
    triggerEventRef: triggerRef,
    observedArtifactRefs: [],
    materialNewEvidenceObserved: false,
    limitations: ["Scope reconciliation adds no research Evidence."],
  });
  assert.equal(analysis.valid, true, JSON.stringify(analysis, null, 2));
  assert.ok(analysis.snapshot && analysis.snapshotPath);
  const snapshot = analysis.snapshot;
  const gap = (snapshot.gaps as Record<string, unknown>[])[0];
  assert.ok(gap);
  assert.match(String(gap.gap_id), /^gap_scope_alignment_[0-9a-f]{16}$/u);
  assert.equal(gap.dimension_id, "scope_alignment");
  assert.equal(gap.gap_type, "scope_invalidated");
  assert.deepEqual(snapshot.observed_artifacts, []);
  assert.ok((gap.basis_refs as string[]).includes(confirmation.scopeConfirmationRef));
  const gapEnvelope = formalEnvelope(
    state.runId,
    analysis.snapshotPath,
    snapshot,
    "startup_opportunity.artifact_envelope.current",
    "harness",
    [...(gap.basis_refs as string[]), triggerRef],
    "2026-07-25T16:20:40Z",
  );
  await state.store.publishArtifact({ runId: state.runId, envelope: gapEnvelope });

  const decision = {
    path: "adaptations/decisions/assessment-scope-reconciliation.json",
    document: {
      schema_version: "startup_opportunity.adaptation_decision.assessment.current",
      adaptation_id: "assessment_scope_reconciliation",
      run_id: state.runId,
      based_on_plan_ref: snapshot.based_on_plan_ref,
      based_on_plan_revision: snapshot.based_on_plan_revision,
      based_on_plan_hash: snapshot.based_on_plan_hash,
      assessment_plan_ref: snapshot.assessment_plan_ref,
      assessment_plan_revision: snapshot.assessment_plan_revision,
      assessment_plan_hash: snapshot.assessment_plan_hash,
      subject_ref: snapshot.subject_ref,
      scope_frame_ref: snapshot.scope_frame_ref,
      scope_frame_hash: snapshot.scope_frame_hash,
      trigger_gap_refs: [`${analysis.snapshotPath}#${String(gap.gap_id)}`],
      coverage_key: snapshot.coverage_key,
      action: "reconcile_scope",
      reason: "Rebind immutable Plan authority to the exact revised Scope.",
      expected_decision_impact: ["execution_validity"],
      requested_by: "main_agent",
      created_at: "2026-07-25T16:20:50Z",
    },
  };
  const decisionEnvelope = formalEnvelope(
    state.runId,
    decision.path,
    decision.document,
    "startup_opportunity.artifact_envelope.current",
    "main_agent",
    [analysis.snapshotPath, String(snapshot.based_on_plan_ref)],
    "2026-07-25T16:20:50Z",
  );
  await state.store.publishArtifact({ runId: state.runId, envelope: decisionEnvelope });
  const currentContext = JSON.parse(
    await readFile(path.join(state.runRoot, "plans/planning-context.r1.json"), "utf8"),
  ) as Record<string, unknown>;
  const assembled = await state.store.buildValidationContext(state.runId, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: analysis.snapshotPath, document: gapEnvelope },
      { path: decision.path, document: decisionEnvelope },
      { path: "plans/planning-context.r1.json", document: currentContext },
    ],
    exact_records: [],
  });
  const adaptationValidation = (
    await createAdaptationPolicyValidator(repositoryRoot)
  ).validateDocumentBundle(assembled.bundle, assembled.referenceContext);
  assert.equal(adaptationValidation.valid, true, JSON.stringify(adaptationValidation, null, 2));
  const semanticDrift = clone(assembled.bundle);
  const driftedSnapshot = effectiveDocument(semanticDrift, analysis.snapshotPath);
  driftedSnapshot.material_new_evidence_observed = true;
  const driftedGap = (driftedSnapshot.gaps as Record<string, unknown>[])[0];
  assert.ok(driftedGap);
  driftedGap.evidence_refs = [String(snapshot.subject_ref)];
  refreshEnvelope(semanticDrift, analysis.snapshotPath);
  const driftValidation = (await createArtifactValidator(repositoryRoot)).validateDocumentBundle(
    semanticDrift,
    assembled.referenceContext,
  );
  assert.ok(
    [
      ...driftValidation.bundleErrors,
      ...driftValidation.documents.flatMap((entry) => entry.errors),
      ...driftValidation.referenceErrors,
    ].some(
      (issue) => issue.code === "assessment_adaptation.scope_reconciliation_semantics_invalid",
    ),
  );
  const candidate = candidateBundle(assembled.bundle, decision);
  const candidateValidation = (
    await createAssessmentPlanSemanticValidator(repositoryRoot)
  ).validateDocumentBundle(candidate, assembled.referenceContext);
  assert.equal(candidateValidation.valid, true, JSON.stringify(candidateValidation, null, 2));

  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  const input = {
    runId: state.runId,
    adaptationBundle: assembled.bundle,
    adaptationRefs: [decision.path],
    candidateBundle: candidate,
    createdAt: "2026-07-25T16:23:00Z",
    checkpointCreatedAt: "2026-07-25T16:24:00Z",
    nextStep: "Resume only under the Scope-reconciled Plan authority.",
    beliefSummary: {
      current_belief: "Scope authority changed; research observations did not.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["No new Evidence was claimed by reconciliation."],
      remaining_disagreement: ["The assessment conclusion remains unchanged."],
      next_decision_relevant_question: "What future Evidence would change the assessment?",
    },
  } as const;
  await assert.rejects(
    runtime.apply({ ...input, faultAt: "after_manifest_update" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await state.store.load(state.runId);
  assert.equal(reopened.manifest.current_plan_ref, "plans/research-plan.r2.json");
  assert.equal(reopened.manifest.status, beforeScope.manifest.status);
  assert.equal(reopened.manifest.status_before_clarification, null);
  assert.equal(reopened.manifest.followup_round, beforeScope.manifest.followup_round);
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");
  const researchR1 = effectiveDocument(await bundleFromRun(state), "plans/research-plan.r1.json");
  const researchR2 = effectiveDocument(await bundleFromRun(state), "plans/research-plan.r2.json");
  assert.deepEqual(researchR2.waves, researchR1.waves);
  const assessmentR1 = effectiveDocument(
    await bundleFromRun(state),
    "plans/concept-evidence-assessment-plan.r1.json",
  );
  const assessmentR2 = effectiveDocument(
    await bundleFromRun(state),
    "plans/concept-evidence-assessment-plan.r2.json",
  );
  assert.deepEqual(assessmentR2.dimensions, assessmentR1.dimensions);
});

test("G1.3 exact Decision replay preserves every existing lifecycle state byte-for-byte", async (context) => {
  for (const [index, lifecycle] of [
    "pending_adaptation_refs",
    "validated_adaptation_refs",
    "rejected_adaptation_refs",
  ].entries()) {
    await context.test(lifecycle, async (subcontext) => {
      const state = await prepareG13Run(
        subcontext,
        repositoryRoot,
        `run_g1_3_decision_replay_${String(index + 1)}`,
      );
      const prepared = await publishGapAndDecision(state);
      await moveDecisionLifecycle(
        state,
        prepared.decision.path,
        lifecycle as (typeof adaptationLifecycleFields)[number],
      );
      const before = await snapshotTree(state.runRoot);

      const replay = await state.store.publishArtifact({
        runId: state.runId,
        envelope: prepared.decisionEnvelope,
      });

      assert.equal(replay.status, "idempotent_replay");
      assert.deepEqual(await snapshotTree(state.runRoot), before);
      const manifest = JSON.parse(
        await readFile(path.join(state.runRoot, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      for (const field of adaptationLifecycleFields) {
        assert.equal(
          (manifest[field] as string[]).includes(prepared.decision.path),
          field === lifecycle,
        );
      }
    });
  }
});

test("G1.3 current receipts recover interrupted Gap and Decision Manifest projection", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_receipt_replay_001");
  const { result } = await createGap(state);
  const gapPath = result.snapshotPath as string;
  const snapshot = result.snapshot as Record<string, unknown>;
  const gapEnvelope = formalEnvelope(
    state.runId,
    gapPath,
    snapshot,
    "startup_opportunity.artifact_envelope.current",
    "harness",
    (snapshot.gaps as Record<string, unknown>[])[0]?.basis_refs as readonly string[],
    "2026-07-25T16:21:00Z",
  );
  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: gapEnvelope,
      faultAt: "after_publish",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const beforeGapReplay = JSON.parse(
    await readFile(path.join(state.runRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.ok(!(beforeGapReplay.artifact_refs as string[]).includes(gapPath));
  assert.equal(beforeGapReplay.latest_gap_snapshot_ref, null);
  assert.equal(
    (await state.store.publishArtifact({ runId: state.runId, envelope: gapEnvelope })).status,
    "idempotent_replay",
  );

  const decision = addUnitDecision(state.runId, gapPath, snapshot);
  const decisionEnvelope = formalEnvelope(
    state.runId,
    decision.path,
    decision.document,
    "startup_opportunity.artifact_envelope.current",
    "main_agent",
    [
      `${gapPath}#${String((snapshot.gaps as Record<string, unknown>[])[0]?.gap_id)}`,
      String(snapshot.based_on_plan_ref),
      String(snapshot.assessment_plan_ref),
      String(snapshot.subject_ref),
      String(snapshot.scope_frame_ref),
    ],
    "2026-07-25T16:22:00Z",
  );
  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: decisionEnvelope,
      faultAt: "after_publish",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const beforeReopen = JSON.parse(
    await readFile(path.join(state.runRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.ok(!(beforeReopen.artifact_refs as string[]).includes(decision.path));
  assert.ok(!(beforeReopen.pending_adaptation_refs as string[]).includes(decision.path));

  const reopened = await state.store.load(state.runId);
  assert.equal(reopened.manifest.latest_gap_snapshot_ref, gapPath);
  assert.ok(reopened.manifest.pending_adaptation_refs.includes(decision.path));
  const operationDirectory = path.join(state.runRoot, ".store/operations");
  const receipts = await Promise.all(
    (await readdir(operationDirectory))
      .filter((entry) => entry.startsWith("artifact-") && entry.endsWith(".json"))
      .map(async (entry) =>
        JSON.parse(await readFile(path.join(operationDirectory, entry), "utf8")),
      ),
  );
  const controlReceipts = receipts.filter((receipt) =>
    [gapPath, decision.path].includes(String(receipt.artifact_path)),
  );
  assert.deepEqual(controlReceipts.map((receipt) => receipt.schema_version).sort(), [
    "startup_opportunity.artifact_store_operation.current",
    "startup_opportunity.artifact_store_operation.current",
  ]);
  const beforeExactReplay = await snapshotTree(state.runRoot);
  assert.equal(
    (await state.store.publishArtifact({ runId: state.runId, envelope: decisionEnvelope })).status,
    "idempotent_replay",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), beforeExactReplay);
});

test("G1.3 applied Decision replay is byte-stable through single, bundle, reopen, and conflict", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_applied_replay_001");
  const prepared = await publishGapAndDecision(state);
  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  assert.equal((await runtime.apply(applyInput(state, prepared, candidate))).status, "applied");
  const appliedManifest = (await state.store.load(state.runId)).manifest;
  assert.ok(appliedManifest.applied_adaptation_refs.includes(prepared.decision.path));
  assert.ok(!appliedManifest.pending_adaptation_refs.includes(prepared.decision.path));

  const initialBundleReplay = await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [prepared.gapEnvelope, prepared.decisionEnvelope],
  });
  assert.equal(initialBundleReplay.status, "idempotent_replay");
  const before = await snapshotTree(state.runRoot);

  const singleReplay = await state.store.publishArtifact({
    runId: state.runId,
    envelope: prepared.decisionEnvelope,
  });
  assert.equal(singleReplay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(state.runRoot), before);

  const bundleReplay = await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [prepared.gapEnvelope, prepared.decisionEnvelope],
  });
  assert.equal(bundleReplay.status, "idempotent_replay");
  assert.ok(bundleReplay.artifacts.every((artifact) => artifact.status === "idempotent_replay"));
  assert.deepEqual(await snapshotTree(state.runRoot), before);

  const reopened = await state.store.load(state.runId);
  assert.ok(reopened.manifest.applied_adaptation_refs.includes(prepared.decision.path));
  assert.ok(!reopened.manifest.pending_adaptation_refs.includes(prepared.decision.path));
  assert.deepEqual(await snapshotTree(state.runRoot), before);

  const conflictingDocument = {
    ...prepared.decisionEnvelope.document,
    reason: "Conflicting synthetic replay content must fail closed.",
  };
  const conflictingEnvelope = {
    ...prepared.decisionEnvelope,
    content_hash: canonicalContentHash(conflictingDocument),
    document: conflictingDocument,
  };
  await assert.rejects(
    state.store.publishArtifact({ runId: state.runId, envelope: conflictingEnvelope }),
    (error: unknown) => error instanceof StoreError && error.code === "write.conflict",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), before);
});

test("G1.3 historical Gap replay cannot replace a later latest Gap", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_gap_replay_001");
  await publishAdditionalG13Branch(state, G13_ACQUISITION_BRANCH);
  const historical = await publishGapAndDecision(state);
  const createdAt = "2026-07-25T16:25:00Z";
  const current = await createGap(state, {
    branch: G13_ACQUISITION_BRANCH,
    snapshotId: "acquisition-gap-latest",
    createdAt,
  });
  const currentPath = current.result.snapshotPath as string;
  const currentSnapshot = current.result.snapshot as Record<string, unknown>;
  const currentEnvelope = formalEnvelope(
    state.runId,
    currentPath,
    currentSnapshot,
    "startup_opportunity.artifact_envelope.current",
    "harness",
    (currentSnapshot.gaps as Record<string, unknown>[])[0]?.basis_refs as readonly string[],
    createdAt,
  );
  await state.store.publishArtifact({ runId: state.runId, envelope: currentEnvelope });
  assert.equal((await state.store.load(state.runId)).manifest.latest_gap_snapshot_ref, currentPath);

  const initialBundleReplay = await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [historical.gapEnvelope, historical.decisionEnvelope],
  });
  assert.equal(initialBundleReplay.status, "idempotent_replay");
  const before = await snapshotTree(state.runRoot);

  const singleReplay = await state.store.publishArtifact({
    runId: state.runId,
    envelope: historical.gapEnvelope,
  });
  assert.equal(singleReplay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(state.runRoot), before);

  const bundleReplay = await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [historical.gapEnvelope, historical.decisionEnvelope],
  });
  assert.equal(bundleReplay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(state.runRoot), before);

  const reopened = await state.store.load(state.runId);
  assert.equal(reopened.manifest.latest_gap_snapshot_ref, currentPath);
  assert.deepEqual(await snapshotTree(state.runRoot), before);
});

test("G1.3 acquisition Gap maps only to a bounded acquisition add_unit", async (context) => {
  const state = await prepareG13Run(
    context,
    repositoryRoot,
    "run_g1_3_acquisition_add_001",
    G13_ACQUISITION_BRANCH,
  );
  const prepared = await publishGapAndDecision(state);
  const gap = (prepared.snapshot.gaps as Record<string, unknown>[])[0];
  assert.equal(gap?.gap_type, "acquisition_evidence_insufficient");
  assert.equal(gap?.recommended_unit_type, "acquisition");
  assert.equal(
    (prepared.decision.document.target_unit as Record<string, unknown>).unit_type,
    "acquisition",
  );
  const validation = (await createAdaptationPolicyValidator(repositoryRoot)).validateDocumentBundle(
    prepared.adaptationBundle,
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));
  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const candidateValidation = (
    await createAssessmentPlanSemanticValidator(repositoryRoot)
  ).validateDocumentBundle(candidate);
  assert.equal(candidateValidation.valid, true, JSON.stringify(candidateValidation));
});

test("G1.3 historical Gap and Decision remain valid only through complete Plan ancestry", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_deep_ancestry_001");
  const prepared = await publishGapAndDecision(state);
  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  assert.equal((await runtime.apply(applyInput(state, prepared, candidate))).status, "applied");

  const persisted = await bundleFromRun(state);
  const documents = persisted.documents.map((entry) => {
    const envelopeVersion = String(entry.document.schema_version);
    return envelopeVersion.startsWith("startup_opportunity.artifact_envelope.")
      ? {
          path: entry.path,
          schemaVersion: String(entry.document.artifact_type),
          document: entry.document.document as Record<string, unknown>,
        }
      : {
          path: entry.path,
          schemaVersion: envelopeVersion,
          document: entry.document,
        };
  });
  const manifest = documents.find((entry) => entry.path === "manifest.json");
  const researchR2 = documents.find((entry) => entry.path === "plans/research-plan.r2.json");
  assert.ok(manifest);
  assert.ok(researchR2);
  const researchR3 = clone(researchR2.document);
  researchR3.revision = 3;
  researchR3.parent_plan_ref = researchR2.path;
  researchR3.triggered_by_adaptation_refs = ["adaptations/decisions/synthetic-r3.json"];
  manifest.document.current_plan_ref = "plans/research-plan.r3.json";
  manifest.document.plan_revision = 3;
  const deepAncestry = [
    ...documents,
    {
      path: "plans/research-plan.r3.json",
      schemaVersion: "startup_opportunity.research_plan.v1",
      document: researchR3,
    },
  ];
  assert.deepEqual(validateAssessmentAdaptationContract(deepAncestry), []);

  const branched = clone(deepAncestry);
  const branchedR3 = branched.find((entry) => entry.path === "plans/research-plan.r3.json");
  assert.ok(branchedR3);
  branchedR3.document.parent_plan_ref = "plans/research-plan.r1.json";
  const errors = validateAssessmentAdaptationContract(branched);
  assert.ok(errors.some((error) => error.code === "assessment_adaptation.plan_stale"));
  assert.ok(
    errors.some((error) => error.code === "assessment_adaptation.decision_binding_mismatch"),
  );
});

test("G1.3 assessment_gap_analysis_input.v1 is wired through Harness and Skill CLI", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_cli_gap_001");
  const inputFile = path.join(path.dirname(state.runsRoot), "assessment-gap-input.json");
  await writeFile(
    inputFile,
    `${canonicalJson({
      schema_version: "startup_opportunity.assessment_gap_analysis_input.v1",
      document_bundle: await bundleFromRun(state),
      snapshot_id: "buyer-gap-cli",
      created_at: "2026-07-25T16:21:00Z",
      trigger_kind: "wave_completed",
      wave_id: "assessment_wave_1",
      trigger_event_ref: null,
      dimension_id: "buyer_language_and_willingness_to_pay",
      observed_artifact_refs: [G13_BUYER_BRANCH.outputPath],
      material_new_evidence_observed: true,
      limitations: ["Synthetic CLI fixture only; no external validation was performed."],
    })}\n`,
  );
  for (const script of [
    "harness/src/cli.ts",
    ".agents/skills/startup-opportunity/scripts/analyze-gaps.ts",
  ]) {
    const args = ["--import", "tsx", script];
    if (script === "harness/src/cli.ts") {
      args.push("analyze-gaps");
    }
    args.push("--file", inputFile);
    const result = spawnSync(process.execPath, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    const output = JSON.parse(result.stdout) as {
      valid?: boolean;
      snapshot?: { schema_version?: string };
    };
    assert.equal(output.valid, true);
    assert.equal(
      output.snapshot?.schema_version,
      "startup_opportunity.gap_snapshot.assessment.current",
    );
  }
});

test("G1.3 no-new-Evidence stop_followup closes without an unbounded revision", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_stop_001");
  const prepared = await publishGapAndDecision(state, "stop", false);
  const gap = (prepared.snapshot.gaps as Record<string, unknown>[])[0];
  assert.equal(gap?.gap_type, "no_material_new_evidence");
  assert.equal(gap?.followup_status, "stop");
  const validation = (await createAdaptationPolicyValidator(repositoryRoot)).validateDocumentBundle(
    prepared.adaptationBundle,
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));

  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  const input = applyInput(state, prepared);
  const result = await runtime.apply(input);
  assert.equal(result.revisionCreated, false);
  assert.equal(result.currentPlanRef, "plans/research-plan.r1.json");
  assert.equal(result.currentAssessmentPlanRef, "plans/concept-evidence-assessment-plan.r1.json");
  assert.equal((await runtime.apply(input)).status, "idempotent_replay");
  await assert.rejects(readFile(path.join(state.runRoot, "plans/research-plan.r2.json")));
  await assert.rejects(
    readFile(path.join(state.runRoot, "plans/concept-evidence-assessment-plan.r2.json")),
  );
});

test("G1.3 sufficient and non-executable buyer coverage deterministically stop", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_stop_matrix_001");
  const base = await bundleFromRun(state);

  const sufficientBundle = clone(base);
  const sufficientBranch = effectiveDocument(sufficientBundle, G13_BUYER_BRANCH.outputPath);
  sufficientBranch.branch_status = "completed";
  sufficientBranch.dimension_decision = "mixed";
  sufficientBranch.decision_sufficiency = "sufficient";
  sufficientBranch.insufficiency_reasons = [];
  refreshEnvelope(sufficientBundle, G13_BUYER_BRANCH.outputPath);
  const sufficientJudgment = effectiveDocument(sufficientBundle, G13_BUYER_BRANCH.judgmentRef);
  sufficientJudgment.judgment_signal = "mixed";
  sufficientJudgment.supporting_claim_refs = ["claim_unit_buyer_support"];
  sufficientJudgment.opposing_claim_refs = ["claim_unit_buyer_oppose"];
  sufficientJudgment.decision_sufficiency = "sufficient";
  sufficientJudgment.insufficiency_reasons = [];
  refreshEnvelope(sufficientBundle, G13_BUYER_BRANCH.judgmentRef);
  const sufficient = await createGap(state, {
    snapshotId: "buyer-coverage-sufficient",
    bundle: sufficientBundle,
  });
  const sufficientGaps = sufficient.result.snapshot?.gaps as Record<string, unknown>[] | undefined;
  assert.equal(sufficientGaps?.[0]?.gap_type, "coverage_sufficient");
  assert.deepEqual(sufficient.result.snapshot?.stop_signals, ["coverage_sufficient"]);

  const exhaustedBundle = clone(base);
  effectiveDocument(exhaustedBundle, "manifest.json").followup_round = 2;
  const exhausted = await createGap(state, {
    snapshotId: "buyer-followup-exhausted",
    bundle: exhaustedBundle,
  });
  const exhaustedGaps = exhausted.result.snapshot?.gaps as Record<string, unknown>[] | undefined;
  assert.equal(exhaustedGaps?.[0]?.gap_type, "no_executable_followup");
  assert.deepEqual(exhausted.result.snapshot?.stop_signals, [
    "max_followup_rounds_reached",
    "no_executable_followup",
  ]);

  const duplicateBundle: DocumentBundle = {
    ...clone(sufficientBundle),
    documents: [
      ...sufficientBundle.documents,
      {
        path: sufficient.result.snapshotPath as string,
        document: sufficient.result.snapshot as Record<string, unknown>,
      },
    ],
  };
  const duplicate = (await createAssessmentGapAnalyzer(repositoryRoot)).analyze({
    documentBundle: duplicateBundle,
    snapshotId: "buyer-coverage-duplicate",
    createdAt: "2026-07-25T16:21:00Z",
    triggerKind: "wave_completed",
    waveId: "assessment_wave_1",
    triggerEventRef: null,
    dimensionId: "buyer_language_and_willingness_to_pay",
    observedArtifactRefs: [G13_BUYER_BRANCH.outputPath],
    materialNewEvidenceObserved: true,
  });
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.errors.some((error) => error.code === "assessment_gap.coverage_duplicate"));
});

test("G1.3 rejects fabricated closed stop bases before filesystem publication", async (context) => {
  const cases = [
    {
      id: "coverage_sufficient",
      coverageStatus: "sufficient",
      stopSignals: ["coverage_sufficient"],
    },
    {
      id: "no_material_new_evidence",
      coverageStatus: "insufficient",
      stopSignals: ["no_material_new_evidence"],
    },
    {
      id: "no_executable_followup",
      coverageStatus: "no_executable_followup",
      stopSignals: ["no_executable_followup"],
    },
  ] as const;

  for (const [index, fixture] of cases.entries()) {
    await context.test(fixture.id, async (subcontext) => {
      const state = await prepareG13Run(
        subcontext,
        repositoryRoot,
        `run_g1_3_forged_stop_${String(index + 1)}`,
      );
      const { result } = await createGap(state, {
        snapshotId: `forged-${fixture.id}`,
        materialNewEvidenceObserved: true,
      });
      const snapshot = clone(result.snapshot as Record<string, unknown>);
      const gap = (snapshot.gaps as Record<string, unknown>[])[0];
      assert.ok(gap);
      gap.gap_type = fixture.id;
      gap.coverage_status = fixture.coverageStatus;
      gap.recommended_unit_type = null;
      gap.followup_status = "stop";
      gap.severity = "material";
      snapshot.stop_signals = fixture.stopSignals;
      const gapPath = result.snapshotPath as string;
      const envelope = formalEnvelope(
        state.runId,
        gapPath,
        snapshot,
        "startup_opportunity.artifact_envelope.current",
        "harness",
        gap.basis_refs as readonly string[],
        "2026-07-25T16:21:00Z",
      );
      const before = await snapshotTree(state.runRoot);

      await assert.rejects(
        state.store.publishArtifact({ runId: state.runId, envelope }),
        (error: unknown) =>
          error instanceof StoreError &&
          error.code === "artifact.reference_invalid" &&
          JSON.stringify(error.details).includes("assessment_adaptation.gap_semantics_mismatch"),
      );
      assert.deepEqual(await snapshotTree(state.runRoot), before);
    });
  }
});

test("G1.3 contract rejects closed-action, identity, ancestry, and observed Artifact drift", async (context) => {
  const catalog = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "tests/fixtures/g1.3/assessment-adaptation-cases.json"),
      "utf8",
    ),
  ) as { positive_cases: string[]; negative_cases: string[] };
  assert.equal(catalog.positive_cases.length, 15);
  assert.equal(catalog.negative_cases.length, 16);

  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_negative_001");
  const prepared = await publishGapAndDecision(state);
  const validator = await createAdaptationPolicyValidator(repositoryRoot);
  assert.equal(validator.validateDocumentBundle(prepared.adaptationBundle).valid, true);

  const modeMismatch = clone(prepared.adaptationBundle);
  effectiveDocument(modeMismatch, "manifest.json").mode = "opportunity_discovery";
  assert.ok(
    validator
      .validateDocumentBundle(modeMismatch)
      .adaptationErrors.some((error) => error.code === "adaptation.run_mode_mismatch"),
  );

  const cases: readonly {
    readonly id: string;
    readonly mutate: (bundle: DocumentBundle) => void;
    readonly expectedCode: string;
  }[] = [
    {
      id: "stale_base",
      mutate: (bundle) => {
        effectiveDocument(bundle, prepared.decision.path).based_on_plan_revision = 2;
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "assessment_adaptation.decision_binding_mismatch",
    },
    {
      id: "illegal_action",
      mutate: (bundle) => {
        effectiveDocument(bundle, prepared.decision.path).action = "retry_unit";
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "schema.enum",
    },
    {
      id: "illegal_target",
      mutate: (bundle) => {
        const decision = effectiveDocument(bundle, prepared.decision.path);
        (decision.target_unit as Record<string, unknown>).unit_type = "acquisition";
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "assessment_adaptation.add_unit_invalid",
    },
    {
      id: "wrong_run",
      mutate: (bundle) => {
        effectiveDocument(bundle, prepared.decision.path).run_id = "run_foreign_g1_3";
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "reference.envelope_run_mismatch",
    },
    {
      id: "wrong_subject",
      mutate: (bundle) => {
        effectiveDocument(bundle, prepared.decision.path).subject_ref = "scope-frame.json";
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "reference.type_mismatch",
    },
    {
      id: "wrong_scope",
      mutate: (bundle) => {
        effectiveDocument(bundle, prepared.decision.path).scope_frame_hash =
          `sha256:${"0".repeat(64)}`;
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "assessment_adaptation.decision_binding_mismatch",
    },
    {
      id: "wrong_coverage_key",
      mutate: (bundle) => {
        effectiveDocument(bundle, prepared.decision.path).coverage_key = `sha256:${"1".repeat(64)}`;
        refreshEnvelope(bundle, prepared.decision.path);
      },
      expectedCode: "assessment_adaptation.decision_binding_mismatch",
    },
    {
      id: "forged_observed_artifact_hash",
      mutate: (bundle) => {
        const snapshot = effectiveDocument(bundle, prepared.gapPath);
        const observation = (snapshot.observed_artifacts as Record<string, unknown>[])[0];
        assert.ok(observation);
        observation.content_hash = `sha256:${"2".repeat(64)}`;
        refreshEnvelope(bundle, prepared.gapPath);
      },
      expectedCode: "assessment_adaptation.observed_artifact_mismatch",
    },
  ];
  for (const fixture of cases) {
    const changed = clone(prepared.adaptationBundle);
    fixture.mutate(changed);
    const result = validator.validateDocumentBundle(changed);
    assert.equal(result.valid, false, `${fixture.id} unexpectedly passed`);
    const codes = [
      ...result.planValidation.planningContract.documentBundle.documents.flatMap((entry) =>
        entry.errors.map((error) => error.code),
      ),
      ...result.planValidation.planningContract.documentBundle.referenceErrors.map(
        (error) => error.code,
      ),
      ...result.adaptationErrors.map((error) => error.code),
    ];
    assert.ok(codes.includes(fixture.expectedCode), `${fixture.id}: ${JSON.stringify(codes)}`);
  }

  const originalDecisionEntry = prepared.adaptationBundle.documents.find(
    (entry) => entry.path === prepared.decision.path,
  );
  assert.ok(originalDecisionEntry);
  const originalDecisionEnvelope = clone(originalDecisionEntry);
  const duplicateDecisionPath = "adaptations/decisions/add-buyer-followup-duplicate.json";
  originalDecisionEnvelope.document.artifact_path = duplicateDecisionPath;
  (originalDecisionEnvelope.document.document as Record<string, unknown>).adaptation_id =
    "adapt_add_buyer_followup_duplicate";
  originalDecisionEnvelope.document.content_hash = canonicalContentHash(
    originalDecisionEnvelope.document.document,
  );
  const decisionEnvelope = {
    path: duplicateDecisionPath,
    document: originalDecisionEnvelope.document,
  };
  const duplicateDecision: DocumentBundle = {
    ...clone(prepared.adaptationBundle),
    documents: [...prepared.adaptationBundle.documents, decisionEnvelope],
  };
  const duplicateDecisionResult = validator.validateDocumentBundle(duplicateDecision);
  assert.equal(duplicateDecisionResult.valid, false);
  assert.ok(
    duplicateDecisionResult.adaptationErrors.some(
      (error) => error.code === "adaptation.coverage_duplicate",
    ),
  );

  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const branched = clone(candidate);
  const assessmentR2 = effectiveDocument(
    branched,
    "plans/concept-evidence-assessment-plan.r2.json",
  );
  assessmentR2.parent_plan_ref = null;
  const branchedResult = (
    await createAssessmentPlanSemanticValidator(repositoryRoot)
  ).validateDocumentBundle(branched);
  assert.equal(branchedResult.valid, false);
  assert.ok(
    branchedResult.planningContract.documentBundle.documents.some((entry) =>
      entry.errors.some((error) => error.code === "schema.type"),
    ),
  );
});

test("G1.3 runtime rejects stored drift and supplied operation-key conflict before Plan writes", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_drift_001");
  const prepared = await publishGapAndDecision(state);
  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  await assert.rejects(
    runtime.apply({
      ...applyInput(state, prepared, candidate),
      operationKey: `sha256:${"0".repeat(64)}`,
    }),
    (error: unknown) => error instanceof StoreError && error.code === "operation.key_mismatch",
  );
  await assert.rejects(readFile(path.join(state.runRoot, "plans/research-plan.r2.json")));

  const storedGap = JSON.parse(
    await readFile(path.join(state.runRoot, prepared.gapPath), "utf8"),
  ) as Record<string, unknown>;
  const storedGapDocument = storedGap.document as Record<string, unknown>;
  storedGapDocument.limitations = [
    ...(storedGapDocument.limitations as string[]),
    "Injected drift for deterministic rejection.",
  ];
  storedGap.content_hash = canonicalContentHash(storedGapDocument);
  await writeFile(path.join(state.runRoot, prepared.gapPath), `${canonicalJson(storedGap)}\n`);
  await assert.rejects(
    runtime.apply(applyInput(state, prepared, candidate)),
    (error: unknown) =>
      error instanceof StoreError && error.code === "adaptation.stored_content_mismatch",
  );
  await assert.rejects(readFile(path.join(state.runRoot, "plans/research-plan.r2.json")));
});

test("G1.3 concurrent same-operation apply is CAS-safe and idempotent", async (context) => {
  const state = await prepareG13Run(context, repositoryRoot, "run_g1_3_concurrent_001");
  const prepared = await publishGapAndDecision(state);
  const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
  const firstRuntime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  const secondRuntime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
  const results = await Promise.allSettled([
    firstRuntime.apply(applyInput(state, prepared, candidate)),
    secondRuntime.apply(applyInput(state, prepared, candidate)),
  ]);
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof firstRuntime.apply>>> =>
      result.status === "fulfilled",
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.ok(fulfilled.some((result) => result.value.status === "applied"));
  assert.ok(
    fulfilled.some((result) => result.value.status === "idempotent_replay") ||
      rejected.some(
        (result) =>
          result.reason instanceof StoreError && result.reason.code === "run.write_locked",
      ),
  );
  assert.equal(
    (await secondRuntime.apply(applyInput(state, prepared, candidate))).status,
    "idempotent_replay",
  );
  assert.equal((await state.store.load(state.runId)).manifest.plan_revision, 2);
});

test("G1.3 receipt recovery closes every published crash boundary", async (context) => {
  for (const [index, boundary] of [
    "after_intent",
    "after_control_artifacts",
    "after_manifest_update",
    "after_checkpoint_publish",
  ].entries()) {
    await context.test(boundary, async (subcontext) => {
      const state = await prepareG13Run(
        subcontext,
        repositoryRoot,
        `run_g1_3_fault_${String(index + 1)}`,
      );
      const prepared = await publishGapAndDecision(state);
      const candidate = candidateBundle(prepared.adaptationBundle, prepared.decision);
      const runtime = await createPlanRevisionRuntime(repositoryRoot, state.runsRoot);
      await assert.rejects(
        runtime.apply(applyInput(state, prepared, candidate, boundary as PlanApplyFaultBoundary)),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      const reopened = await state.store.load(state.runId);
      if (boundary === "after_intent" || boundary === "after_control_artifacts") {
        assert.equal(reopened.manifest.plan_revision, 1);
      } else {
        assert.equal(reopened.manifest.plan_revision, 2);
      }
      const replay = await runtime.apply(applyInput(state, prepared, candidate));
      assert.equal(replay.status, "idempotent_replay");
      assert.equal((await state.store.load(state.runId)).manifest.plan_revision, 2);
    });
  }
});

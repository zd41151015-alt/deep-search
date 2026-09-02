import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ArtifactStore,
  type CreateResearchHandoffInput,
  canonicalContentHash,
  canonicalJson,
  createArtifactValidator,
  type DocumentBundle,
  EvidenceStore,
  type FormalArtifactEnvelope,
  operationKey,
  RunStore,
  StoreError,
  sha256Bytes,
} from "../harness/src/index.js";
import { createFormalStageRuntimeCompiler } from "../harness/src/runtime/declarative-runtime.js";
import {
  deriveResearchProvenance,
  type ResearchHandoffDocument,
  researchHandoffSourceRoleAllowed,
  validateResearchHandoffContract,
} from "../harness/src/validators/research-handoff-validator.js";
import { createG14ContractBundle } from "./fixtures/g1.4/assessment-report-fixture.js";
import {
  createDiscoveryMapsFixture,
  fixtureDocument,
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
  G21_OPPORTUNITY_REF,
  G21_SEED_REF,
  refreshDiscoveryMapsBundle,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  G22_BASELINE_R1,
  G22_DEMAND_R1,
  G22_DEMAND_R2,
  G22_FAN_IN,
  G22_GENERATION_CLAIM,
  G22_GENERATION_EVIDENCE,
  G22_PRE_CANDIDATE_RELATION,
  G22_REJECTED_PRE_CANDIDATE,
  G22_RETAINED_PRE_CANDIDATE,
  G22_WATCHLIST_PRE_CANDIDATE,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";
import {
  createDiscoveryRuntimeFixture,
  runtimeEnvelope,
} from "./fixtures/g2.2/discovery-runtime-fixture.js";
import {
  createDiscoverySynthesisFixture,
  discoverySynthesisReadinessEnvelopes,
  G23_OPPORTUNITY_A,
  G23_OPPORTUNITY_B,
} from "./fixtures/g2.3/discovery-synthesis-fixture.js";
import { createConfirmedRun, publishInitialPlanBundle } from "./helpers/current-run.js";
import { discoveryWaveEnvelopes } from "./helpers/discovery-wave.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const CAPTURED_AT = "2026-08-12T17:10:00Z";
const TARGET_SCOPE_R1 = {
  geography: "Synthetic",
  customerModel: "b2c" as const,
  targetUsers: ["synthetic handoff fixture user"],
  decisionGoal: "test explicit current-contract research handoff",
  researchLanguage: "en-US",
  teamContext: {
    hardConstraints: [],
    knownStrengthsAndGaps: [],
    otherTeamConditions: {
      status: "unknown" as const,
      sourceKind: "unknown" as const,
      confirmationStatus: "unknown" as const,
      reportingDisclosure:
        "Team conditions not explicitly captured as hard constraints or known strengths and gaps remain unknown.",
    },
  },
};

interface HandoffState {
  readonly root: string;
  readonly runsRoot: string;
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly store: RunStore;
  readonly validator: Awaited<ReturnType<typeof createArtifactValidator>>;
  readonly evidence: EvidenceStore;
  readonly targetBundle: Awaited<ReturnType<typeof createDiscoveryMapsFixture>>;
  readonly input: CreateResearchHandoffInput;
  readonly sourceEvidenceRaw: string;
}

interface HandoffBindingState {
  readonly handoffRef: string;
  readonly handoffContentHash: string;
  readonly priorBinding: Readonly<{ ref: string; content_hash: string }>;
  readonly reusableBinding: Readonly<{ ref: string; content_hash: string }>;
}

function exactReferenceCodes(error: StoreError): readonly string[] {
  return Array.isArray(error.details.referenceErrors)
    ? error.details.referenceErrors.flatMap((entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).code === "string"
          ? [String((entry as Record<string, unknown>).code)]
          : [],
      )
    : [];
}

function sha256HexFromHash(hash: string): string {
  const match = hash.match(/^sha256:([a-f0-9]{64})$/);
  assert.ok(match?.[1]);
  return match[1];
}

function retargetEvidenceImportRecord(
  record: Record<string, unknown>,
  overrides: { readonly unitId?: string; readonly unitAttempt?: number },
): Record<string, unknown> {
  const next = structuredClone(record);
  if (overrides.unitId !== undefined) next.unit_id = overrides.unitId;
  if (overrides.unitAttempt !== undefined) next.unit_attempt = overrides.unitAttempt;
  const stableOperationKey = operationKey("record_evidence", {
    run_id: next.run_id,
    unit_id: next.unit_id,
    unit_attempt: next.unit_attempt,
    source: next.source,
    content_hash: next.content_hash,
    acquisition_goal: next.acquisition_goal,
    handoff_binding: next.handoff_binding,
  });
  next.operation_key = stableOperationKey;
  next.evidence_id = `ev_${sha256HexFromHash(stableOperationKey)}`;
  return next;
}

function formalEnvelopesByType(
  bundle: DocumentBundle,
  ...artifactTypes: readonly string[]
): readonly FormalArtifactEnvelope[] {
  return bundle.documents
    .map((entry) => entry.document as unknown as FormalArtifactEnvelope)
    .filter(
      (entry) =>
        entry.schema_version === "startup_opportunity.artifact_envelope.current" &&
        artifactTypes.includes(entry.artifact_type),
    );
}

function validationDocuments(bundle: DocumentBundle): readonly ResearchHandoffDocument[] {
  return bundle.documents.map((entry) => {
    const value = entry.document as Record<string, unknown>;
    const envelope =
      value.schema_version === "startup_opportunity.artifact_envelope.current"
        ? (value as unknown as FormalArtifactEnvelope)
        : null;
    return {
      path: entry.path,
      schemaVersion: String(envelope?.artifact_type ?? value.schema_version),
      document: (envelope?.document ?? value) as Record<string, unknown>,
      envelope,
    };
  });
}

function bindHandoff(
  envelope: FormalArtifactEnvelope,
  binding: Readonly<{ ref: string; content_hash: string }>,
): void {
  const target =
    envelope.artifact_type === "startup_opportunity.discovery_candidate.v1"
      ? (envelope.document.formation as Record<string, unknown>)
      : envelope.document;
  target.research_handoff_input_hashes = [binding];
  if (envelope.artifact_type === "startup_opportunity.discovery_candidate.v1") {
    target.synthesis_origin = "research_handoff_informed_synthesis";
  }
  (envelope as unknown as { input_refs: string[] }).input_refs = [
    ...new Set([...envelope.input_refs, binding.ref]),
  ].sort();
  (envelope as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    envelope.document,
  );
}

function clonedEnvelope(envelope: FormalArtifactEnvelope): FormalArtifactEnvelope {
  return structuredClone(envelope);
}

function refreshCandidateFormationBindings(envelopes: readonly FormalArtifactEnvelope[]): void {
  const byPath = new Map(envelopes.map((envelope) => [envelope.artifact_path, envelope]));
  const visiting = new Set<string>();
  const refreshed = new Set<string>();
  const refresh = (envelope: FormalArtifactEnvelope): void => {
    if (refreshed.has(envelope.artifact_path)) return;
    assert.ok(!visiting.has(envelope.artifact_path), "Candidate formation must be acyclic");
    visiting.add(envelope.artifact_path);
    const formation = envelope.document.formation as Record<string, unknown>;
    formation.synthesis_input_hashes = (
      formation.synthesis_input_hashes as Record<string, unknown>[]
    ).map((binding) => {
      const target = byPath.get(String(binding.ref));
      if (target === undefined) return binding;
      refresh(target);
      return { ref: binding.ref, content_hash: target.content_hash };
    });
    (envelope as unknown as { content_hash: string }).content_hash = canonicalContentHash(
      envelope.document,
    );
    visiting.delete(envelope.artifact_path);
    refreshed.add(envelope.artifact_path);
  };
  for (const envelope of envelopes) refresh(envelope);
}

function bindTypedCandidateDescendants(
  envelopes: readonly FormalArtifactEnvelope[],
  binding: Readonly<{ ref: string; content_hash: string }>,
): void {
  const bound = new Set(
    envelopes
      .filter((envelope) => {
        const formation = envelope.document.formation as Record<string, unknown>;
        return (
          Array.isArray(formation.research_handoff_input_hashes) &&
          formation.research_handoff_input_hashes.length > 0
        );
      })
      .map((envelope) => envelope.artifact_path),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const envelope of envelopes) {
      if (bound.has(envelope.artifact_path)) continue;
      const formation = envelope.document.formation as Record<string, unknown>;
      const inputRefs = (formation.synthesis_input_hashes as Record<string, unknown>[]).map(
        (entry) => String(entry.ref),
      );
      if (!inputRefs.some((ref) => bound.has(ref))) continue;
      bindHandoff(envelope, binding);
      bound.add(envelope.artifact_path);
      changed = true;
    }
  }
}

async function recordDiscoverySubstrate(state: HandoffState, suffix: string) {
  const generation = (
    await state.evidence.record({
      runId: state.targetRunId,
      unitId: "unit_seed_independent_demand",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:handoff:${suffix}:generation`,
      },
      acquisitionGoal: "SYNTHETIC current-Run generation substrate; not Evidence.",
      rawContent: "SYNTHETIC current-Run generation bytes; not Evidence.",
      recordedAt: "2026-08-12T17:20:00Z",
    })
  ).record;
  const evaluation = (
    await state.evidence.record({
      runId: state.targetRunId,
      unitId: "unit_counterfactual",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:handoff:${suffix}:evaluation`,
      },
      acquisitionGoal: "SYNTHETIC current-Run evaluation substrate; not Evidence.",
      rawContent: "SYNTHETIC current-Run evaluation bytes; not Evidence.",
      recordedAt: "2026-08-12T17:21:00Z",
    })
  ).record;
  return { generation, evaluation };
}

async function createReadHandoff(
  state: HandoffState,
  targetArtifactRef = G21_OPPORTUNITY_REF,
  options: { readonly includeReusableEvidence?: boolean } = {},
): Promise<HandoffBindingState> {
  const input = structuredClone(state.input);
  const prior = input.items.find((item) => item.itemId === "prior_opportunity_map");
  assert.ok(prior);
  (prior as { targetArtifactRef?: string }).targetArtifactRef = targetArtifactRef;
  const items =
    options.includeReusableEvidence === false
      ? input.items.filter((item) => item.role !== "reusable_evidence")
      : input.items;
  const created = await state.store.createResearchHandoff({ ...input, items });
  await state.store.readResearchHandoff({
    runId: state.targetRunId,
    handoffRef: created.handoffRef,
    itemIds: ["prior_opportunity_map"],
    consumedAt: "2026-08-12T17:22:00Z",
  });
  return {
    handoffRef: created.handoffRef,
    handoffContentHash: created.handoffContentHash,
    priorBinding: {
      ref: `${created.handoffRef}#prior_opportunity_map`,
      content_hash: created.handoffContentHash,
    },
    reusableBinding: {
      ref: `${created.handoffRef}#reusable_source_material`,
      content_hash: created.handoffContentHash,
    },
  };
}

async function reviseScope(state: HandoffState, suffix: string): Promise<void> {
  const proposal = await state.store.proposeScope({
    runId: state.targetRunId,
    expectedScopeRevision: 1,
    proposedAt: "2026-08-12T17:24:00Z",
    reason: `SYNTHETIC ${suffix} Scope revision for handoff recovery testing.`,
    scopeProposal: {
      geography: `Synthetic revised ${suffix}`,
      customerModel: "b2c",
      targetUsers: ["synthetic revised handoff user"],
      decisionGoal: "reconcile a confirmed Scope revision without replaying prior research",
      researchLanguage: "en-US",
      teamContext: TARGET_SCOPE_R1.teamContext,
    },
  });
  await state.store.confirmScope({
    runId: state.targetRunId,
    expectedScopeProposalRevision: proposal.scopeRevision,
    expectedScopeProposalRef: proposal.scopeProposalRef,
    expectedScopeProposalHash: proposal.scopeProposalHash,
    confirmedAt: "2026-08-12T17:25:00Z",
    userConfirmationAttestation:
      "The fixture caller attests that the user confirmed this exact revised Scope.",
  });
}

async function assertPublicationRejected(
  store: RunStore,
  runId: string,
  envelopes: readonly FormalArtifactEnvelope[],
  code: string,
): Promise<void> {
  await assert.rejects(
    envelopes.length === 1
      ? store.publishArtifact({
          runId,
          envelope: envelopes[0] as FormalArtifactEnvelope,
        })
      : store.publishArtifactBundle({ runId, envelopes }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "artifact.reference_invalid" &&
      exactReferenceCodes(error).includes(code),
  );
}

function initialCandidateEnvelopes(bundle: DocumentBundle): readonly FormalArtifactEnvelope[] {
  return formalEnvelopesByType(bundle, "startup_opportunity.discovery_candidate.v1").filter(
    (entry) => entry.document.revision === 1,
  );
}

async function publishTargetRuntimeEnvelopesAsFormalStage(
  state: HandoffState,
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
    run_id: state.targetRunId,
    operation: "publish",
    created_at: String(envelopes[0]?.created_at ?? "2026-08-12T17:20:00Z"),
    artifacts: envelopes.map((envelope) => ({
      artifact_type: envelope.artifact_type,
      artifact_path: envelope.artifact_path,
      producer_role: envelope.producer_role,
      input_refs: envelope.input_refs,
      document: envelope.document,
    })),
  });
}

async function publishDiscoveryThroughFanIn(
  state: HandoffState,
  bundle: DocumentBundle,
): Promise<void> {
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: initialCandidateEnvelopes(bundle),
  });
  await publishTargetRuntimeEnvelopesAsFormalStage(
    state,
    discoveryWaveEnvelopes(
      bundle,
      state.targetRunId,
      "startup_opportunity.research_task.discovery_candidate.current",
      1,
      "candidate_runtime",
    ),
    "request_handoff_candidate_runtime_wave",
  );
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: formalEnvelopesByType(
      bundle,
      "startup_opportunity.evidence.discovery_candidate.current",
      "startup_opportunity.claim.discovery_candidate.current",
      "startup_opportunity.finding.discovery_candidate.current",
      "startup_opportunity.insight.discovery_candidate.current",
      "startup_opportunity.judgment_assessment.discovery_candidate.current",
      "startup_opportunity.source_manifest.discovery_candidate.current",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: formalEnvelopesByType(bundle, "startup_opportunity.discovery_lane_result.v1"),
  });
  await state.store.publishArtifact({
    runId: state.targetRunId,
    envelope: runtimeEnvelope(bundle, G22_DEMAND_R2),
  });
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: [
      G22_RETAINED_PRE_CANDIDATE,
      G22_WATCHLIST_PRE_CANDIDATE,
      G22_REJECTED_PRE_CANDIDATE,
    ].map((artifactPath) => runtimeEnvelope(bundle, artifactPath)),
  });
  await state.store.publishArtifact({
    runId: state.targetRunId,
    envelope: runtimeEnvelope(bundle, G22_PRE_CANDIDATE_RELATION),
  });
  await state.store.publishArtifact({
    runId: state.targetRunId,
    envelope: runtimeEnvelope(bundle, G22_FAN_IN),
  });
  await state.store.confirmPreCandidates({
    runId: state.targetRunId,
    expectedFanInRef: G22_FAN_IN,
    expectedFanInHash: runtimeEnvelope(bundle, G22_FAN_IN).content_hash,
    selectedPreCandidateRefs: [G22_RETAINED_PRE_CANDIDATE],
    nextAction: "proceed_with_selected",
    userConfirmationAttestation:
      "SYNTHETIC caller attests that the user selected the retained pre-candidate for continuation.",
    confirmedAt: "2026-07-27T19:59:00Z",
  });
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: discoverySynthesisReadinessEnvelopes(bundle),
  });
}

function synthesisEnvelopes(bundle: DocumentBundle): readonly FormalArtifactEnvelope[] {
  return formalEnvelopesByType(
    bundle,
    "startup_opportunity.discovery_candidate_conversion.v2",
    "startup_opportunity.demand_thesis.v1",
    "startup_opportunity.baseline_option.v1",
    "startup_opportunity.solution_hypothesis.v1",
    "startup_opportunity.solution_evaluation.v1",
    "startup_opportunity.opportunity_thesis.v1",
    "startup_opportunity.thesis_evaluation_snapshot.v1",
    "startup_opportunity.merge.v1",
  );
}

function bundleDocument(bundle: DocumentBundle, artifactPath: string): Record<string, unknown> {
  const value = bundle.documents.find((entry) => entry.path === artifactPath)?.document;
  assert.ok(value, artifactPath);
  return String(value.schema_version).startsWith("startup_opportunity.artifact_envelope.")
    ? (value.document as Record<string, unknown>)
    : value;
}

function envelopeForRun(
  runId: string,
  artifactPath: string,
  document: Record<string, unknown>,
  inputRefs: readonly string[],
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    run_id: runId,
    created_at: "2026-08-12T17:10:00Z",
    producer_role: "main_agent",
    input_refs: [...new Set(inputRefs)].sort(),
    content_hash: canonicalContentHash(document),
    document,
  };
}

function assessmentFormationEnvelopes(
  bundle: DocumentBundle,
  runId: string,
  revision: 1 | 2,
  scope: typeof TARGET_SCOPE_R1,
): readonly FormalArtifactEnvelope[] {
  const suffix = revision === 1 ? "" : ".r2";
  const decisionPath = `decision-context${suffix}.json`;
  const intakePath = `intake${suffix}.json`;
  const scopePath = `scope-frame${suffix}.json`;
  const decision = structuredClone(bundleDocument(bundle, "decision-context.json"));
  decision.run_id = runId;
  const intake = structuredClone(bundleDocument(bundle, "intake.json"));
  intake.run_id = runId;
  intake.market = scope.geography;
  intake.language = scope.researchLanguage;
  intake.decision_context_ref = decisionPath;
  intake.scope_confirmation = {
    geography: scope.geography,
    customer_model: scope.customerModel,
    target_users: scope.targetUsers,
    decision_goal: scope.decisionGoal,
    research_language: scope.researchLanguage,
    team_context: {
      hard_constraints: scope.teamContext.hardConstraints,
      known_strengths_and_gaps: scope.teamContext.knownStrengthsAndGaps,
      other_team_conditions: {
        status: scope.teamContext.otherTeamConditions.status,
        source_kind: scope.teamContext.otherTeamConditions.sourceKind,
        confirmation_status: scope.teamContext.otherTeamConditions.confirmationStatus,
        reporting_disclosure: scope.teamContext.otherTeamConditions.reportingDisclosure,
      },
    },
    user_confirmed: true,
  };
  const constraints = intake.explicit_constraints as Record<string, unknown>;
  constraints.target_market = scope.geography;
  constraints.target_language = scope.researchLanguage;
  constraints.target_users = scope.targetUsers;
  const scopeFrame = structuredClone(bundleDocument(bundle, "scope-frame.json"));
  scopeFrame.run_id = runId;
  scopeFrame.decision_context_ref = decisionPath;
  scopeFrame.market = scope.geography;
  scopeFrame.language = scope.researchLanguage;
  scopeFrame.target_user = scope.targetUsers;
  scopeFrame.team_context = {
    hard_constraints: scope.teamContext.hardConstraints,
    known_strengths_and_gaps: scope.teamContext.knownStrengthsAndGaps,
    other_team_conditions: {
      status: scope.teamContext.otherTeamConditions.status,
      source_kind: scope.teamContext.otherTeamConditions.sourceKind,
      confirmation_status: scope.teamContext.otherTeamConditions.confirmationStatus,
      reporting_disclosure: scope.teamContext.otherTeamConditions.reportingDisclosure,
    },
  };
  return [
    envelopeForRun(runId, decisionPath, decision, []),
    envelopeForRun(runId, intakePath, intake, [decisionPath]),
    envelopeForRun(runId, scopePath, scopeFrame, [decisionPath]),
  ];
}

function assessmentConceptEnvelope(
  bundle: DocumentBundle,
  runId: string,
  scopeRef: string,
  intakeRef: string,
  targetUsers: readonly string[],
  binding: HandoffBindingState["priorBinding"],
): FormalArtifactEnvelope {
  const concept = structuredClone(bundleDocument(bundle, "concept-hypothesis.json"));
  concept.run_id = runId;
  concept.schema_version = "startup_opportunity.concept_hypothesis.assessment_intake.current";
  concept.scope_frame_ref = scopeRef;
  concept.target_user = targetUsers;
  concept.field_provenance = [
    "product_thesis",
    "target_user",
    "buyer",
    "entry_scene",
    "claimed_value",
    "current_alternative",
    "delivery_form",
    "business_model",
    "acquisition_hypothesis",
  ].map((field) => ({
    field_name: field,
    source_kind: "user_provided",
    confirmation_status: "user_confirmed",
    basis_refs: [intakeRef],
    reporting_disclosure: null,
  }));
  concept.research_readiness = "ready";
  concept.research_handoff_input_hashes = [binding];
  return envelopeForRun(runId, "concept-hypothesis.json", concept, [
    scopeRef,
    intakeRef,
    binding.ref,
  ]);
}

async function snapshotTree(root: string): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) result[relative] = (await readFile(absolute)).toString("base64");
    }
  };
  await visit(root);
  return result;
}

async function prepareState(
  context: TestContext,
  suffix: string,
  options: {
    readonly publishTargetCore?: boolean;
    readonly targetMode?: "opportunity_discovery" | "concept_evidence_assessment";
  } = {},
): Promise<HandoffState> {
  const root = await mkdtemp(path.join(tmpdir(), `startup-opportunity-handoff-${suffix}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const sourceRunId = `handoff-source-${suffix}`;
  const targetRunId = `handoff-target-${suffix}`;
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  const evidence = new EvidenceStore(runsRoot);
  const sourceBundle = await createDiscoveryMapsFixture("general", sourceRunId);
  const targetBundle = await createDiscoveryMapsFixture("general", targetRunId);
  for (const [runId, bundle] of [
    [sourceRunId, sourceBundle],
    [targetRunId, targetBundle],
  ] as const) {
    await createConfirmedRun(store, {
      runId,
      mode:
        runId === targetRunId
          ? (options.targetMode ?? "opportunity_discovery")
          : "opportunity_discovery",
      createdAt: "2026-08-12T17:00:00Z",
      scopeProposal: {
        ...TARGET_SCOPE_R1,
      },
    });
    if (runId === sourceRunId || options.publishTargetCore !== false) {
      await publishInitialPlanBundle(
        store,
        runId,
        G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
      );
    }
  }
  await store.publishArtifactBundle({
    runId: sourceRunId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(sourceBundle, ref)),
  });
  const sourceEvidenceRaw =
    "SYNTHETIC forum, regulator, vendor, API dataset, proxy and estimate bytes; not market Evidence.";
  const sourceEvidence = await evidence.record({
    runId: sourceRunId,
    unitId: "unit_source_material",
    source: {
      kind: "public_url",
      canonical_url: "https://synthetic.invalid/forum/vendor-api-proxy?case=handoff#ignored",
    },
    acquisitionGoal: "Preserve provider-agnostic synthetic source bytes for handoff testing.",
    rawContent: sourceEvidenceRaw,
    recordedAt: "2026-08-12T17:05:00Z",
  });
  const mapPath = path.join(runsRoot, sourceRunId, G21_OPPORTUNITY_REF);
  const mapBytes = await readFile(mapPath);
  const evidenceRef = `evidence/manifest.jsonl#${sourceEvidence.record.evidence_id}`;
  const evidenceCapture = await evidence.readExactCapture(sourceRunId, evidenceRef);
  const input: CreateResearchHandoffInput = {
    runId: targetRunId,
    handoffId: `handoff_${suffix}`,
    sourceRunId,
    userAuthorizationAttestation:
      "The fixture caller attests that the user explicitly authorized these exact current-contract source items.",
    targetPurpose:
      "Use prior synthesis only as a hypothesis and reweight copied Evidence in this Run.",
    capturedAt: CAPTURED_AT,
    items: [
      {
        itemId: "prior_opportunity_map",
        sourceArtifactPath: G21_OPPORTUNITY_REF,
        role: "prior_synthesis",
        expectedSourceByteHash: sha256Bytes(mapBytes),
        expectedSourceContentHash: fixtureEnvelope(sourceBundle, G21_OPPORTUNITY_REF).content_hash,
        freshnessDisposition: "historical",
        applicabilityDisposition: "partially_applicable",
        revalidationStatus: "required",
        targetArtifactRef: G21_OPPORTUNITY_REF,
      },
      {
        itemId: "reusable_source_material",
        sourceArtifactPath: evidenceRef,
        role: "reusable_evidence",
        expectedSourceByteHash: sha256Bytes(evidenceCapture.recordBytes),
        expectedSourceContentHash: canonicalContentHash(evidenceCapture.record),
        freshnessDisposition: "current",
        applicabilityDisposition: "applicable",
        revalidationStatus: "not_required",
        targetUnitId: "unit_seed_independent_demand",
      },
    ],
  };
  return {
    root,
    runsRoot,
    sourceRunId,
    targetRunId,
    store,
    validator,
    evidence,
    targetBundle,
    input,
    sourceEvidenceRaw,
  };
}

function runScript(script: string, args: readonly string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

test("formal handoff copies exact reusable Evidence and controlled reads freeze provenance", async (context) => {
  const state = await prepareState(context, "success");
  const created = await state.store.createResearchHandoff(state.input);
  assert.equal(created.status, "published");
  assert.equal(created.importedEvidenceRefs.length, 1);
  const importedRef = created.importedEvidenceRefs[0];
  assert.ok(importedRef);
  const imported = await state.evidence.readExactCapture(state.targetRunId, importedRef);
  assert.equal(imported.rawBytes.toString(), state.sourceEvidenceRaw);
  assert.equal(imported.record.source.kind, "public_url");
  assert.equal(imported.record.handoff_binding?.source_run_id, state.sourceRunId);
  assert.equal(
    imported.record.handoff_binding?.source_evidence_path,
    state.input.items[1]?.sourceArtifactPath,
  );
  const reusableInput = state.input.items.find(
    (item) => item.itemId === "reusable_source_material",
  );
  assert.ok(reusableInput);
  assert.equal(imported.record.unit_id, reusableInput.targetUnitId);
  assert.equal(imported.record.unit_attempt, 1);
  assert.equal(
    imported.record.acquisition_goal,
    "Preserve provider-agnostic synthetic source bytes for handoff testing.",
  );
  const handoffEnvelope = JSON.parse(
    await readFile(path.join(state.runsRoot, state.targetRunId, created.handoffRef), "utf8"),
  ) as FormalArtifactEnvelope;
  const reusableItem = (handoffEnvelope.document.items as Record<string, unknown>[]).find(
    (item) => item.item_id === "reusable_source_material",
  );
  assert.ok(reusableItem);
  assert.equal(reusableItem.target_unit_id, imported.record.unit_id);
  assert.equal(reusableItem.target_unit_attempt, imported.record.unit_attempt);

  const evidenceOnlyRead = await state.store.readResearchHandoff({
    runId: state.targetRunId,
    handoffRef: created.handoffRef,
    itemIds: ["reusable_source_material"],
    consumedAt: "2026-08-12T17:11:00Z",
  });
  assert.equal(evidenceOnlyRead.status, "appended");
  const priorRead = await state.store.readResearchHandoff({
    runId: state.targetRunId,
    handoffRef: created.handoffRef,
    itemIds: ["prior_opportunity_map"],
    consumedAt: "2026-08-12T17:12:00Z",
  });
  assert.equal(priorRead.status, "appended");
  assert.match(priorRead.items[0]?.sourcePayload ?? "", /opportunity_space_map/);
  const decisionText = await readFile(
    path.join(state.runsRoot, state.targetRunId, "decisions.jsonl"),
    "utf8",
  );
  assert.ok(decisionText.includes(String(priorRead.consumptionDecisionRef.split("#")[1])));
  const replay = await state.store.readResearchHandoff({
    runId: state.targetRunId,
    handoffRef: created.handoffRef,
    itemIds: ["prior_opportunity_map"],
    consumedAt: "2026-08-12T17:12:00Z",
  });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.consumptionDecisionHash, priorRead.consumptionDecisionHash);
});

test("published handoff validation rejects imported Evidence outside the exact target unit and attempt", async (context) => {
  for (const variant of ["wrong-target-unit", "wrong-target-attempt"] as const) {
    await context.test(variant, async (subcontext) => {
      const state = await prepareState(subcontext, `published-${variant}`);
      const created = await state.store.createResearchHandoff(state.input);
      const publishedHandoffEnvelope = JSON.parse(
        await readFile(path.join(state.runsRoot, state.targetRunId, created.handoffRef), "utf8"),
      ) as FormalArtifactEnvelope;
      const validation = await state.store.buildValidationContext(
        state.targetRunId,
        {
          schema_version: "startup_opportunity.document_bundle.current",
          documents: [
            {
              path: created.handoffRef,
              document: publishedHandoffEnvelope,
            },
          ],
          exact_records: [],
        },
        { includeAllFormalArtifacts: true },
      );
      const documents = structuredClone(validationDocuments(validation.bundle));
      const handoff = documents.find((entry) => entry.path === created.handoffRef);
      assert.ok(handoff);
      const reusableItem = (handoff.document.items as Record<string, unknown>[]).find(
        (item) => item.item_id === "reusable_source_material",
      );
      assert.ok(reusableItem);
      const originalTargetRef = String(reusableItem.target_evidence_ref);
      const exactJsonlRecords = validation.referenceContext.exactJsonlRecords;
      assert.ok(exactJsonlRecords);
      const originalRecord = exactJsonlRecords.get(originalTargetRef);
      assert.ok(originalRecord);
      const tamperedRecord = retargetEvidenceImportRecord(originalRecord, {
        ...(variant === "wrong-target-unit" ? { unitId: "unit_counterfactual" } : {}),
        ...(variant === "wrong-target-attempt" ? { unitAttempt: 2 } : {}),
      });
      const tamperedTargetRef = `evidence/manifest.jsonl#${String(tamperedRecord.evidence_id)}`;
      reusableItem.target_evidence_ref = tamperedTargetRef;
      reusableItem.target_evidence_record_hash = canonicalContentHash(tamperedRecord);
      if (handoff.envelope !== null) {
        handoff.envelope.content_hash = canonicalContentHash(handoff.document);
      }
      const exactRecords = new Map(exactJsonlRecords);
      exactRecords.delete(originalTargetRef);
      exactRecords.set(tamperedTargetRef, tamperedRecord);
      const issues = validateResearchHandoffContract(documents, exactRecords);
      assert.ok(
        issues.some(
          (issue) =>
            issue.code === "research_handoff.evidence_copy_binding_mismatch" &&
            issue.instancePath === `${created.handoffRef}#/items/1`,
        ),
        JSON.stringify(issues, null, 2),
      );
    });
  }
});

test("reading prior synthesis binds only its target and explicit same-Run descendants", async (context) => {
  const state = await prepareState(context, "taint");
  const created = await state.store.createResearchHandoff(state.input);
  await state.store.readResearchHandoff({
    runId: state.targetRunId,
    handoffRef: created.handoffRef,
    itemIds: ["prior_opportunity_map"],
    consumedAt: "2026-08-12T17:12:00Z",
  });
  const binding = {
    ref: `${created.handoffRef}#prior_opportunity_map`,
    content_hash: created.handoffContentHash,
  };
  for (const ref of [G21_OPPORTUNITY_REF, "artifacts/discovery/solution-space-map.r1.json"]) {
    const document = fixtureDocument(state.targetBundle, ref);
    document.research_handoff_input_hashes = [binding];
    const provenance = document.content_provenance as Record<string, unknown>;
    provenance.synthesis_origin = "research_handoff_informed_synthesis";
    const envelope = fixtureEnvelope(state.targetBundle, ref) as unknown as Record<string, unknown>;
    envelope.input_refs = [...new Set([...(envelope.input_refs as string[]), binding.ref])].sort();
  }
  refreshDiscoveryMapsBundle(state.targetBundle);
  assert.equal(
    fixtureDocument(state.targetBundle, G21_SEED_REF).research_handoff_input_hashes,
    undefined,
  );
  const published = await state.store
    .publishArtifactBundle({
      runId: state.targetRunId,
      envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(state.targetBundle, ref)),
    })
    .catch((error: unknown) => {
      if (error instanceof StoreError) assert.fail(JSON.stringify(error.details, null, 2));
      throw error;
    });
  assert.equal(published.status, "published");
});

test("consumer binding requires an exact controlled read for that item and target", async (context) => {
  const state = await prepareState(context, "controlled-read-authority");
  const created = await state.store.createResearchHandoff(state.input);
  const boundBundle = structuredClone(state.targetBundle);
  const opportunity = fixtureEnvelope(boundBundle, G21_OPPORTUNITY_REF);
  const priorBinding = {
    ref: `${created.handoffRef}#prior_opportunity_map`,
    content_hash: created.handoffContentHash,
  };
  bindHandoff(opportunity, priorBinding);
  refreshDiscoveryMapsBundle(boundBundle);
  const maps = G21_MAP_REFS.map((ref) => fixtureEnvelope(boundBundle, ref));
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    maps,
    "research_handoff.consumer_binding_mismatch",
  );

  await state.store.readResearchHandoff({
    runId: state.targetRunId,
    handoffRef: created.handoffRef,
    itemIds: ["reusable_source_material"],
    consumedAt: "2026-08-12T17:22:00Z",
  });
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    maps,
    "research_handoff.consumer_binding_mismatch",
  );
});

test("an unrelated envelope input cannot impersonate typed handoff ancestry", async (context) => {
  const state = await prepareState(context, "typed-ancestry", {
    publishTargetCore: false,
  });
  const substrate = await recordDiscoverySubstrate(state, "typed-ancestry");
  const bundle = await createDiscoveryRuntimeFixture(
    state.targetRunId,
    substrate,
    [],
    "general",
    true,
  );
  await publishInitialPlanBundle(
    state.store,
    state.targetRunId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  );
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  const binding = await createReadHandoff(state, G22_BASELINE_R1);
  const initial = initialCandidateEnvelopes(bundle).map(clonedEnvelope);
  const target = initial.find((entry) => entry.artifact_path === G22_BASELINE_R1);
  const sibling = initial.find((entry) => entry.artifact_path === G22_DEMAND_R1);
  assert.ok(target);
  assert.ok(sibling);
  bindHandoff(target, binding.priorBinding);
  bindHandoff(sibling, binding.priorBinding);
  (sibling as unknown as { input_refs: string[] }).input_refs = [
    ...new Set([...sibling.input_refs, target.artifact_path]),
  ].sort();
  refreshCandidateFormationBindings(initial);

  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    initial,
    "research_handoff.consumer_binding_mismatch",
  );
});

test("formal Evidence adoption requires the exact controlled read, item, and target Plan", async (context) => {
  for (const variant of ["unread", "other-item", "wrong-plan"] as const) {
    await context.test(variant, async (subcontext) => {
      const state = await prepareState(subcontext, `evidence-authority-${variant}`, {
        publishTargetCore: false,
      });
      const current = (
        await state.evidence.record({
          runId: state.targetRunId,
          unitId: "unit_counterfactual",
          source: {
            kind: "user_provided",
            canonical_uri: `urn:startup-opportunity:user-provided:handoff:evidence-authority:${variant}`,
          },
          acquisitionGoal: "SYNTHETIC comparison substrate; not Evidence.",
          rawContent: "SYNTHETIC comparison bytes; not Evidence.",
          recordedAt: "2026-08-12T17:21:00Z",
        })
      ).record;
      const bootstrapBundle = await createDiscoveryRuntimeFixture(
        state.targetRunId,
        { generation: current, evaluation: current },
        [],
        "general",
        true,
      );
      await publishInitialPlanBundle(
        state.store,
        state.targetRunId,
        G21_CORE_REFS.map((ref) => fixtureEnvelope(bootstrapBundle, ref)),
      );
      const input = structuredClone(state.input);
      const prior = input.items.find((item) => item.itemId === "prior_opportunity_map");
      assert.ok(prior);
      (prior as { targetArtifactRef?: string }).targetArtifactRef = G23_OPPORTUNITY_A;
      const created = await state.store.createResearchHandoff(input);
      if (variant === "other-item") {
        await state.store.readResearchHandoff({
          runId: state.targetRunId,
          handoffRef: created.handoffRef,
          itemIds: ["prior_opportunity_map"],
          consumedAt: "2026-08-12T17:22:00Z",
        });
      } else if (variant === "wrong-plan") {
        await state.store.readResearchHandoff({
          runId: state.targetRunId,
          handoffRef: created.handoffRef,
          itemIds: ["reusable_source_material"],
          consumedAt: "2026-08-12T17:22:00Z",
        });
      }
      const importedRef = created.importedEvidenceRefs[0];
      assert.ok(importedRef);
      const imported = await state.evidence.readExactRecord(state.targetRunId, importedRef);
      const bundle = await createDiscoveryRuntimeFixture(
        state.targetRunId,
        { generation: imported, evaluation: current },
        [],
        "general",
        true,
      );
      await state.store.publishArtifactBundle({
        runId: state.targetRunId,
        envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
      });
      await state.store.publishArtifactBundle({
        runId: state.targetRunId,
        envelopes: initialCandidateEnvelopes(bundle),
      });
      await publishTargetRuntimeEnvelopesAsFormalStage(
        state,
        discoveryWaveEnvelopes(
          bundle,
          state.targetRunId,
          "startup_opportunity.research_task.discovery_candidate.current",
          1,
          `evidence_authority_${variant}`,
        ),
        `request_handoff_evidence_authority_${variant.replaceAll("-", "_")}_wave`,
      );
      const inheritedEvidencePath = G22_GENERATION_EVIDENCE.replace(
        /ev_[a-f0-9]{64}/,
        imported.evidence_id,
      );
      const formalEvidence = clonedEnvelope(runtimeEnvelope(bundle, inheritedEvidencePath));
      if (variant === "wrong-plan") {
        const lineage = formalEvidence.document.lineage as Record<string, unknown>;
        lineage.research_plan_ref = "plans/research-plan.r2.json";
        (formalEvidence as unknown as { content_hash: string }).content_hash = canonicalContentHash(
          formalEvidence.document,
        );
      }
      await assertPublicationRejected(
        state.store,
        state.targetRunId,
        [formalEvidence],
        "research_handoff.evidence_adoption_unauthorized",
      );
      const reopened = await state.store.load(state.targetRunId);
      assert.equal(reopened.recovered, false);
    });
  }
});

test("restricted inherited substrate remains context and cannot support a formal Claim", async (context) => {
  const state = await prepareState(context, "restricted-evidence-adoption", {
    publishTargetCore: false,
  });
  const current = (
    await state.evidence.record({
      runId: state.targetRunId,
      unitId: "unit_counterfactual",
      source: {
        kind: "user_provided",
        canonical_uri: "urn:startup-opportunity:user-provided:handoff:restricted-evidence:current",
      },
      acquisitionGoal: "SYNTHETIC current-Run comparison substrate; not Evidence.",
      rawContent: "SYNTHETIC current-Run comparison bytes; not Evidence.",
      recordedAt: "2026-08-12T17:21:00Z",
    })
  ).record;
  const bootstrapBundle = await createDiscoveryRuntimeFixture(
    state.targetRunId,
    { generation: current, evaluation: current },
    [],
    "general",
    true,
  );
  await publishInitialPlanBundle(
    state.store,
    state.targetRunId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(bootstrapBundle, ref)),
  );
  const input = structuredClone(state.input);
  const reusable = input.items.find((item) => item.itemId === "reusable_source_material");
  assert.ok(reusable);
  const created = await state.store.createResearchHandoff({
    ...input,
    items: [
      {
        ...reusable,
        freshnessDisposition: "historical",
        applicabilityDisposition: "partially_applicable",
        revalidationStatus: "required",
        targetUnitId: "unit_seed_independent_demand",
      },
    ],
  });
  await state.store.readResearchHandoff({
    runId: state.targetRunId,
    handoffRef: created.handoffRef,
    itemIds: ["reusable_source_material"],
    consumedAt: "2026-08-12T17:22:00Z",
  });
  const importedRef = created.importedEvidenceRefs[0];
  assert.ok(importedRef);
  const imported = await state.evidence.readExactRecord(state.targetRunId, importedRef);
  const bundle = await createDiscoveryRuntimeFixture(
    state.targetRunId,
    { generation: imported, evaluation: current },
    [],
    "general",
    true,
  );
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: initialCandidateEnvelopes(bundle),
  });
  await publishTargetRuntimeEnvelopesAsFormalStage(
    state,
    discoveryWaveEnvelopes(
      bundle,
      state.targetRunId,
      "startup_opportunity.research_task.discovery_candidate.current",
      1,
      "restricted_evidence_runtime",
    ),
    "request_handoff_restricted_evidence_runtime_wave",
  );

  const inheritedEvidencePath = G22_GENERATION_EVIDENCE.replace(
    /ev_[a-f0-9]{64}/,
    imported.evidence_id,
  );
  const overstated = clonedEnvelope(runtimeEnvelope(bundle, inheritedEvidencePath));
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    [overstated],
    "research_handoff.evidence_disposition_overstated",
  );

  const contextual = clonedEnvelope(overstated);
  contextual.document.evidence_role = "context";
  contextual.document.evidence_lifecycle_status = "unverified";
  (contextual as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    contextual.document,
  );
  assert.equal(
    (
      await state.store.publishArtifact({
        runId: state.targetRunId,
        envelope: contextual,
      })
    ).status,
    "published",
  );

  const claim = clonedEnvelope(runtimeEnvelope(bundle, G22_GENERATION_CLAIM));
  (claim.document.evidence_refs as string[]).splice(0, 1, inheritedEvidencePath);
  (claim as unknown as { input_refs: string[] }).input_refs = [
    ...new Set([...claim.input_refs, inheritedEvidencePath]),
  ].sort();
  (claim as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    claim.document,
  );
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    [claim],
    "research_handoff.evidence_revalidation_required",
  );

  const assembled = await state.store.buildValidationContext(
    state.targetRunId,
    {
      schema_version: "startup_opportunity.document_bundle.current",
      documents: [
        {
          path: contextual.artifact_path,
          document: contextual as unknown as Record<string, unknown>,
        },
      ],
      exact_records: [],
    },
    { includeAllFormalArtifacts: true },
  );
  const handoffDocuments = assembled.bundle.documents.map((entry) => {
    const value = entry.document as Record<string, unknown>;
    const envelope =
      value.schema_version === "startup_opportunity.artifact_envelope.current" ? value : null;
    return {
      path: entry.path,
      schemaVersion: String(envelope?.artifact_type ?? value.schema_version),
      document: (envelope?.document ?? value) as Record<string, unknown>,
      envelope,
    };
  });
  const exactRecords = new Map(assembled.referenceContext.exactJsonlRecords);
  const decisiveById = {
    path: "synthetic/decisive-by-id.json",
    schemaVersion: "synthetic.decisive_reference.v1",
    document: {
      decisive_evidence_refs: [imported.evidence_id],
    },
    envelope: null,
  };
  const decisiveIssues = validateResearchHandoffContract(
    [...handoffDocuments, decisiveById],
    exactRecords,
  );
  assert.ok(
    decisiveIssues.some(
      (entry) =>
        entry.code === "research_handoff.evidence_revalidation_required" &&
        entry.instancePath.endsWith("/decisive_evidence_refs"),
    ),
    JSON.stringify(
      {
        evidence: handoffDocuments
          .filter((entry) => entry.path === contextual.artifact_path)
          .map((entry) => entry.document),
        exactRecordRefs: [...exactRecords.keys()],
        issues: decisiveIssues,
      },
      null,
      2,
    ),
  );
});

test("Candidate formation closes over the exact prior handoff item and rejects Evidence substitution", async (context) => {
  const state = await prepareState(context, "candidate-consumer", {
    publishTargetCore: false,
  });
  const substrate = await recordDiscoverySubstrate(state, "candidate-consumer");
  const bundle = await createDiscoveryRuntimeFixture(
    state.targetRunId,
    substrate,
    [],
    "general",
    true,
  );
  await publishInitialPlanBundle(
    state.store,
    state.targetRunId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  );
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  const binding = await createReadHandoff(state, G22_DEMAND_R1);
  const initial = initialCandidateEnvelopes(bundle).map(clonedEnvelope);
  const targetedCandidate = initial.find((envelope) => envelope.artifact_path === G22_DEMAND_R1);
  assert.ok(targetedCandidate);
  bindHandoff(targetedCandidate, binding.priorBinding);
  bindTypedCandidateDescendants(initial, binding.priorBinding);
  refreshCandidateFormationBindings(initial);

  const wrongHash = initial.map(clonedEnvelope);
  const wrongHashCandidate = wrongHash.find((envelope) => envelope.artifact_path === G22_DEMAND_R1);
  assert.ok(wrongHashCandidate);
  const wrongHashFormation = wrongHashCandidate.document.formation as Record<string, unknown>;
  wrongHashFormation.research_handoff_input_hashes = [
    { ...binding.priorBinding, content_hash: `sha256:${"0".repeat(64)}` },
  ];
  (wrongHashCandidate as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    wrongHashCandidate.document,
  );
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    wrongHash,
    "research_handoff.consumer_binding_mismatch",
  );

  const missingInputRef = initial.map(clonedEnvelope);
  const missingInputCandidate = missingInputRef.find(
    (envelope) => envelope.artifact_path === G22_DEMAND_R1,
  );
  assert.ok(missingInputCandidate);
  (missingInputCandidate as unknown as { input_refs: string[] }).input_refs =
    missingInputCandidate.input_refs.filter((ref) => ref !== binding.priorBinding.ref);
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    missingInputRef,
    "research_handoff.consumer_binding_mismatch",
  );

  const evidenceSubstitution = initial.map(clonedEnvelope);
  const substitutedCandidate = evidenceSubstitution.find(
    (envelope) => envelope.artifact_path === G22_DEMAND_R1,
  );
  assert.ok(substitutedCandidate);
  bindHandoff(substitutedCandidate, binding.reusableBinding);
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    evidenceSubstitution,
    "research_handoff.consumer_binding_mismatch",
  );

  const published = await state.store
    .publishArtifactBundle({
      runId: state.targetRunId,
      envelopes: initial,
    })
    .catch((error: unknown) => {
      if (error instanceof StoreError) assert.fail(JSON.stringify(error.details, null, 2));
      throw error;
    });
  assert.equal(published.status, "published");
  for (const descendantRef of [
    G22_BASELINE_R1,
    "artifacts/discovery/candidates/candidate_solution.r1.json",
  ]) {
    const descendant = initial.find((envelope) => envelope.artifact_path === descendantRef);
    assert.ok(descendant);
    const formation = descendant.document.formation as Record<string, unknown>;
    assert.ok(
      (formation.synthesis_input_hashes as Record<string, unknown>[]).some(
        (entry) => entry.ref === G22_DEMAND_R1 || entry.ref === G22_BASELINE_R1,
      ),
    );
    assert.deepEqual(formation.research_handoff_input_hashes, [binding.priorBinding]);
  }
});

test("Opportunity Thesis publication preserves exact handoff formation closure", async (context) => {
  const state = await prepareState(context, "opportunity-consumer", {
    publishTargetCore: false,
  });
  const substrate = await recordDiscoverySubstrate(state, "opportunity-consumer");
  const bundle = await createDiscoverySynthesisFixture(state.targetRunId, substrate);
  await publishInitialPlanBundle(
    state.store,
    state.targetRunId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  );
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  await publishDiscoveryThroughFanIn(state, bundle);
  const binding = await createReadHandoff(state, G23_OPPORTUNITY_A);
  const synthesis = synthesisEnvelopes(bundle).map(clonedEnvelope);
  const targetedOpportunity = synthesis.find(
    (envelope) => envelope.artifact_path === G23_OPPORTUNITY_A,
  );
  assert.ok(targetedOpportunity);
  bindHandoff(targetedOpportunity, binding.priorBinding);

  const wrongHash = synthesis.map(clonedEnvelope);
  const wrongOpportunity = wrongHash.find(
    (envelope) => envelope.artifact_path === G23_OPPORTUNITY_A,
  );
  assert.ok(wrongOpportunity);
  wrongOpportunity.document.research_handoff_input_hashes = [
    { ...binding.priorBinding, content_hash: `sha256:${"0".repeat(64)}` },
  ];
  (wrongOpportunity as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    wrongOpportunity.document,
  );
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    wrongHash,
    "research_handoff.consumer_binding_mismatch",
  );

  const missingInputRef = synthesis.map(clonedEnvelope);
  const missingOpportunity = missingInputRef.find(
    (envelope) => envelope.artifact_path === G23_OPPORTUNITY_A,
  );
  assert.ok(missingOpportunity);
  (missingOpportunity as unknown as { input_refs: string[] }).input_refs =
    missingOpportunity.input_refs.filter((ref) => ref !== binding.priorBinding.ref);
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    missingInputRef,
    "synthesis.envelope_input_closure_mismatch",
  );

  const evidenceSubstitution = synthesis.map(clonedEnvelope);
  const substitutedOpportunity = evidenceSubstitution.find(
    (envelope) => envelope.artifact_path === G23_OPPORTUNITY_A,
  );
  assert.ok(substitutedOpportunity);
  bindHandoff(substitutedOpportunity, binding.reusableBinding);
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    evidenceSubstitution,
    "research_handoff.consumer_binding_mismatch",
  );

  const published = await state.store
    .publishArtifactBundle({
      runId: state.targetRunId,
      envelopes: synthesis,
    })
    .catch((error: unknown) => {
      if (error instanceof StoreError) assert.fail(JSON.stringify(error.details, null, 2));
      throw error;
    });
  assert.equal(published.status, "published");
  assert.equal(
    synthesis.find((envelope) => envelope.artifact_path === G23_OPPORTUNITY_B)?.document
      .research_handoff_input_hashes,
    undefined,
  );
});

test("typed subject revisions retain historical handoff provenance across Plan revisions without tainting siblings", () => {
  const runId = "handoff-cross-plan-subject-revision";
  const planR1 = "plans/research-plan.r1.json";
  const planR2 = "plans/research-plan.r2.json";
  const planDocuments = [planR1, planR2].map((pathValue, index) => ({
    path: pathValue,
    schemaVersion: "startup_opportunity.research_plan.v1",
    document: { run_id: runId, revision: index + 1 },
    envelope: null,
  }));
  const planHash = (pathValue: string): string => {
    const plan = planDocuments.find((entry) => entry.path === pathValue);
    assert.ok(plan);
    return canonicalContentHash(plan.document);
  };
  interface RevisionVariant {
    readonly name: string;
    readonly schemaVersion: string;
    readonly r1SchemaVersion?: string;
    readonly r1Path: string;
    readonly r2Path: string;
    readonly siblingPath: string;
    readonly stage: string;
    readonly document: (
      pathValue: string,
      parentRef: string | null,
      binding?: unknown,
    ) => Record<string, unknown>;
  }
  const variants: readonly RevisionVariant[] = [
    {
      name: "Candidate",
      schemaVersion: "startup_opportunity.discovery_candidate.v1",
      r1Path: "artifacts/discovery/candidates/candidate_cross_plan.r1.json",
      r2Path: "artifacts/discovery/candidates/candidate_cross_plan.r2.json",
      siblingPath: "artifacts/discovery/candidates/candidate_sibling.r1.json",
      stage: "plan_bound",
      document: (pathValue: string, parentRef: string | null, binding?: unknown) => ({
        run_id: runId,
        research_plan_ref: pathValue.endsWith("r1.json") ? planR1 : planR2,
        parent_candidate_ref: parentRef,
        formation: {
          synthesis_input_hashes: parentRef === null ? [] : [{ ref: parentRef }],
          ...(binding === undefined ? {} : { research_handoff_input_hashes: [binding] }),
        },
        map_lineage: {},
      }),
    },
    {
      name: "Opportunity Thesis",
      schemaVersion: "startup_opportunity.opportunity_thesis.v1",
      r1Path: "artifacts/discovery/opportunities/opportunity_cross_plan.r1.json",
      r2Path: "artifacts/discovery/opportunities/opportunity_cross_plan.r2.json",
      siblingPath: "artifacts/discovery/opportunities/opportunity_sibling.r1.json",
      stage: "plan_bound",
      document: (pathValue: string, parentRef: string | null, binding?: unknown) => ({
        run_id: runId,
        research_plan_ref: pathValue.endsWith("r1.json") ? planR1 : planR2,
        parent_opportunity_ref: parentRef,
        ...(binding === undefined ? {} : { research_handoff_input_hashes: [binding] }),
      }),
    },
    {
      name: "Concept",
      schemaVersion: "startup_opportunity.concept_hypothesis.assessment.current",
      r1Path: "artifacts/assessment/concepts/concept_cross_plan.r2.json",
      r2Path: "artifacts/assessment/concepts/concept_cross_plan.r3.json",
      siblingPath: "artifacts/assessment/concepts/concept_sibling.r3.json",
      stage: "plan_bound",
      document: (pathValue: string, parentRef: string | null, binding?: unknown) => ({
        run_id: runId,
        parent_concept_ref: parentRef,
        formation_input_hashes: [
          ...(parentRef === null
            ? []
            : [{ ref: parentRef, content_hash: canonicalContentHash({}) }]),
          {
            ref: pathValue.endsWith("concept_cross_plan.r2.json") ? planR1 : planR2,
            content_hash: planHash(
              pathValue.endsWith("concept_cross_plan.r2.json") ? planR1 : planR2,
            ),
          },
        ],
        ...(binding === undefined ? {} : { research_handoff_input_hashes: [binding] }),
      }),
    },
  ];

  for (const variant of variants) {
    const handoffPath = `artifacts/research-handoffs/handoff_${variant.name
      .toLowerCase()
      .replaceAll(" ", "_")}.json`;
    const itemId = `prior_${variant.name.toLowerCase().replaceAll(" ", "_")}`;
    const handoffDocument = {
      run_id: runId,
      target_formation_stage: variant.stage,
      target_plan_ref: variant.stage === "plan_bound" ? planR1 : null,
      items: [
        {
          item_id: itemId,
          role: "prior_synthesis",
          target_artifact_ref: variant.r1Path,
        },
      ],
    };
    const handoffHash = canonicalContentHash(handoffDocument);
    const binding = { ref: `${handoffPath}#${itemId}`, content_hash: handoffHash };
    const r1 = {
      path: variant.r1Path,
      schemaVersion: variant.r1SchemaVersion ?? variant.schemaVersion,
      document: variant.document(variant.r1Path, null, binding),
      envelope: { input_refs: [binding.ref] },
    };
    const r2 = {
      path: variant.r2Path,
      schemaVersion: variant.schemaVersion,
      document: variant.document(variant.r2Path, variant.r1Path, binding),
      envelope: { input_refs: [variant.r1Path, binding.ref] },
    };
    const sibling = {
      path: variant.siblingPath,
      schemaVersion: variant.schemaVersion,
      document: variant.document(variant.siblingPath, null),
      envelope: { input_refs: [] },
    };
    const handoff = {
      path: handoffPath,
      schemaVersion: "startup_opportunity.research_handoff.current",
      document: handoffDocument,
      envelope: { content_hash: handoffHash, input_refs: [] },
    };
    const exactRecords = new Map([
      [
        `decisions.jsonl#consume_${itemId}`,
        {
          schema_version: "startup_opportunity.decision.v1",
          decision_type: "research_handoff_consumed",
          run_id: runId,
          research_handoff_ref: handoffPath,
          research_handoff_hash: handoffHash,
          research_handoff_item_refs: [binding.ref],
          research_handoff_target_artifact_refs: [variant.r1Path],
        },
      ],
    ]);
    const issues = validateResearchHandoffContract(
      [...planDocuments, handoff, r1, r2, sibling],
      exactRecords,
    );
    assert.equal(
      issues.some(
        (issue) =>
          issue.instancePath.startsWith(variant.r2Path) &&
          [
            "research_handoff.consumer_binding_mismatch",
            "research_handoff.target_provenance_not_bound",
          ].includes(issue.code),
      ),
      false,
      `${variant.name}: ${JSON.stringify(issues)}`,
    );
    assert.equal(
      issues.some((issue) => issue.instancePath.startsWith(variant.siblingPath)),
      false,
      `${variant.name} sibling: ${JSON.stringify(issues)}`,
    );

    const wrongDirectPlan = structuredClone(r1);
    if (variant.name === "Concept") {
      const planBinding = (
        wrongDirectPlan.document.formation_input_hashes as Record<string, unknown>[]
      ).find((entry) => entry.ref === planR1);
      assert.ok(planBinding);
      planBinding.ref = planR2;
      planBinding.content_hash = planHash(planR2);
    } else {
      wrongDirectPlan.document.research_plan_ref = planR2;
    }
    const wrongDirectIssues = validateResearchHandoffContract(
      [...planDocuments, handoff, wrongDirectPlan, r2, sibling],
      exactRecords,
    );
    assert.ok(
      wrongDirectIssues.some(
        (issue) =>
          issue.code === "research_handoff.consumer_binding_mismatch" &&
          issue.instancePath.startsWith(variant.r1Path),
      ),
      `${variant.name} direct Plan: ${JSON.stringify(wrongDirectIssues)}`,
    );

    const missing = structuredClone(r2);
    if (variant.schemaVersion === "startup_opportunity.discovery_candidate.v1") {
      delete (missing.document.formation as Record<string, unknown>).research_handoff_input_hashes;
    } else {
      delete missing.document.research_handoff_input_hashes;
    }
    missing.envelope.input_refs = [variant.r1Path];
    const missingIssues = validateResearchHandoffContract(
      [...planDocuments, handoff, r1, missing, sibling],
      exactRecords,
    );
    assert.ok(
      missingIssues.some(
        (issue) =>
          issue.code === "research_handoff.target_provenance_not_bound" &&
          issue.instancePath.startsWith(variant.r2Path),
      ),
      `${variant.name}: ${JSON.stringify(missingIssues)}`,
    );
  }
});

test("report provenance excludes formal Evidence outside the report causal closure", () => {
  const runId = "handoff-report-causal-closure";
  const handoffRef = "artifacts/research-handoffs/handoff_inventory_only.json";
  const inheritedEvidenceRef = "evidence/formal/inherited-outside-report.json";
  const currentEvidenceRef = "evidence/formal/current-in-report.json";
  const inheritedSubstrateRef = `evidence/manifest.jsonl#ev_${"a".repeat(64)}`;
  const currentSubstrateRef = `evidence/manifest.jsonl#ev_${"b".repeat(64)}`;
  const evidence = (pathValue: string, evidenceId: string, substrateRef: string) => ({
    path: pathValue,
    schemaVersion: "startup_opportunity.evidence.assessment.current",
    document: {
      run_id: runId,
      evidence_id: evidenceId,
      mechanical_binding: { substrate_record_ref: substrateRef },
    },
    envelope: { input_refs: [substrateRef] },
  });
  const sourceManifest = (pathValue: string, acceptedEvidenceRef: string) => ({
    path: pathValue,
    schemaVersion: "startup_opportunity.source_manifest.assessment.current",
    document: { accepted_evidence_refs: [acceptedEvidenceRef] },
    envelope: { input_refs: [acceptedEvidenceRef] },
  });
  const currentSourceManifestRef = "sources/current-in-report.json";
  const inheritedSourceManifestRef = "sources/inherited-outside-report.json";
  const terminalRoot = "artifacts/reporting/terminal-report-source.r1.json";
  const projection = deriveResearchProvenance(
    runId,
    [
      {
        path: handoffRef,
        schemaVersion: "startup_opportunity.research_handoff.current",
        document: { run_id: runId, items: [] },
        envelope: { input_refs: [] },
      },
      evidence(inheritedEvidenceRef, `ev_${"a".repeat(64)}`, inheritedSubstrateRef),
      evidence(currentEvidenceRef, `ev_${"b".repeat(64)}`, currentSubstrateRef),
      sourceManifest(inheritedSourceManifestRef, inheritedEvidenceRef),
      sourceManifest(currentSourceManifestRef, currentEvidenceRef),
      {
        path: terminalRoot,
        schemaVersion: "startup_opportunity.terminal_report_source.v1",
        document: {
          audit_refs: [currentEvidenceRef, currentSourceManifestRef],
        },
        envelope: {
          input_refs: [currentEvidenceRef, currentSourceManifestRef],
        },
      },
    ],
    new Map([
      [
        inheritedSubstrateRef,
        {
          handoff_binding: {
            handoff_ref: handoffRef,
            handoff_item_id: "inventory_only",
          },
        },
      ],
      [currentSubstrateRef, {}],
    ]),
    terminalRoot,
  );
  assert.equal(projection.available_handoff_count, 1);
  assert.deepEqual(projection.formal_inherited_evidence_refs, []);
  assert.deepEqual(projection.adopted_inherited_evidence_refs, []);
  assert.deepEqual(projection.cited_inherited_evidence_refs, []);
  assert.deepEqual(projection.formal_current_evidence_refs, [currentEvidenceRef]);
  assert.deepEqual(projection.adopted_current_evidence_refs, [currentEvidenceRef]);
  assert.deepEqual(projection.cited_current_evidence_refs, [currentEvidenceRef]);
});

test("terminal provenance follows only its explicit report root", () => {
  const runId = "handoff-single-report-root";
  const handoffPath = "artifacts/research-handoffs/handoff_old_report.json";
  const itemRef = `${handoffPath}#old_concept_input`;
  const conceptPath = "artifacts/assessment/concepts/concept_old_report.r2.json";
  const oldReportPath = "artifacts/reporting/concept-evidence-report.old.json";
  const terminalPath = "artifacts/reporting/terminal-report-source.current.json";
  const handoffDocument = {
    run_id: runId,
    items: [
      {
        item_id: "old_concept_input",
        role: "prior_synthesis",
        freshness_disposition: "historical",
        applicability_disposition: "partially_applicable",
        revalidation_status: "required",
      },
    ],
  };
  const handoffHash = canonicalContentHash(handoffDocument);
  const common = [
    {
      path: handoffPath,
      schemaVersion: "startup_opportunity.research_handoff.current",
      document: handoffDocument,
      envelope: { content_hash: handoffHash, input_refs: [] },
    },
    {
      path: conceptPath,
      schemaVersion: "startup_opportunity.concept_hypothesis.assessment.current",
      document: {
        run_id: runId,
        research_handoff_input_hashes: [{ ref: itemRef, content_hash: handoffHash }],
      },
      envelope: { input_refs: [itemRef] },
    },
    {
      path: oldReportPath,
      schemaVersion: "startup_opportunity.concept_evidence_report.v1",
      document: { concept_hypothesis_ref: conceptPath },
      envelope: { input_refs: [conceptPath] },
    },
  ];
  const disconnectedTerminal: ResearchHandoffDocument = {
    path: terminalPath,
    schemaVersion: "startup_opportunity.terminal_report_source.v1",
    document: { run_id: runId, audit_refs: [] },
    envelope: { input_refs: [] },
  };
  const disconnected = deriveResearchProvenance(
    runId,
    [...common, disconnectedTerminal],
    new Map(),
    terminalPath,
  );
  assert.deepEqual(disconnected.causal_handoff_refs, []);
  assert.deepEqual(disconnected.used_handoff_items, []);

  const connectedTerminal = structuredClone(disconnectedTerminal) as {
    path: string;
    schemaVersion: string;
    document: Record<string, unknown>;
    envelope: Record<string, unknown>;
  };
  connectedTerminal.document.audit_refs = [oldReportPath];
  connectedTerminal.envelope.input_refs = [oldReportPath];
  const connected = deriveResearchProvenance(
    runId,
    [...common, connectedTerminal],
    new Map(),
    terminalPath,
  );
  assert.deepEqual(connected.causal_handoff_refs, [handoffPath]);
  assert.deepEqual(
    connected.used_handoff_items.map(
      (item) => `${String(item.handoff_ref)}#${String(item.handoff_item_id)}`,
    ),
    [itemRef],
  );
});

test("Concept intake formation binds the exact handoff item without pre-Plan Evidence reuse", async (context) => {
  const state = await prepareState(context, "concept-consumer", {
    publishTargetCore: false,
    targetMode: "concept_evidence_assessment",
  });
  const assessmentFixture = await createG14ContractBundle("insufficient_evidence");
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: assessmentFormationEnvelopes(
      assessmentFixture,
      state.targetRunId,
      1,
      TARGET_SCOPE_R1,
    ),
  });
  await assert.rejects(
    state.store.createResearchHandoff({
      ...structuredClone(state.input),
      handoffId: "handoff_concept_consumer_evidence_rejected",
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.item_contract_invalid",
  );
  const binding = await createReadHandoff(state, "concept-hypothesis.json", {
    includeReusableEvidence: false,
  });
  const concept = structuredClone(bundleDocument(assessmentFixture, "concept-hypothesis.json"));
  concept.run_id = state.targetRunId;
  concept.schema_version = "startup_opportunity.concept_hypothesis.assessment_intake.current";
  concept.field_provenance = [
    "product_thesis",
    "target_user",
    "buyer",
    "entry_scene",
    "claimed_value",
    "current_alternative",
    "delivery_form",
    "business_model",
    "acquisition_hypothesis",
  ].map((field) => ({
    field_name: field,
    source_kind: "user_provided",
    confirmation_status: "user_confirmed",
    basis_refs: ["intake.json"],
    reporting_disclosure: null,
  }));
  concept.research_readiness = "ready";
  concept.research_handoff_input_hashes = [binding.priorBinding];
  const envelope = envelopeForRun(state.targetRunId, "concept-hypothesis.json", concept, [
    "scope-frame.json",
    "intake.json",
    binding.priorBinding.ref,
  ]);

  const wrongHash = clonedEnvelope(envelope);
  wrongHash.document.research_handoff_input_hashes = [
    { ...binding.priorBinding, content_hash: `sha256:${"0".repeat(64)}` },
  ];
  (wrongHash as unknown as { content_hash: string }).content_hash = canonicalContentHash(
    wrongHash.document,
  );
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    [wrongHash],
    "research_handoff.consumer_binding_mismatch",
  );

  const missingInputRef = clonedEnvelope(envelope);
  (missingInputRef as unknown as { input_refs: string[] }).input_refs =
    missingInputRef.input_refs.filter((ref) => ref !== binding.priorBinding.ref);
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    [missingInputRef],
    "research_handoff.consumer_binding_mismatch",
  );

  const published = await state.store
    .publishArtifact({
      runId: state.targetRunId,
      envelope,
    })
    .catch((error: unknown) => {
      if (error instanceof StoreError) assert.fail(JSON.stringify(error.details, null, 2));
      throw error;
    });
  assert.equal(published.status, "published");
  const reopened = await state.store.load(state.targetRunId);
  assert.equal(reopened.recovered, false);
  assert.ok(reopened.manifest.artifact_refs.includes("concept-hypothesis.json"));
  assert.equal(reopened.manifest.current_plan_ref, null);
  const replay = await state.store.readResearchHandoff({
    runId: state.targetRunId,
    handoffRef: binding.handoffRef,
    itemIds: ["prior_opportunity_map"],
    consumedAt: "2026-08-12T17:22:00Z",
  });
  assert.equal(replay.status, "idempotent_replay");

  const currentConcept = clonedEnvelope(envelope) as unknown as Record<string, unknown>;
  currentConcept.artifact_path = "artifacts/assessment/concepts/concept_assess_001.r2.json";
  const currentDocument = currentConcept.document as Record<string, unknown>;
  currentDocument.schema_version = "startup_opportunity.concept_hypothesis.assessment.current";
  currentDocument.revision = 2;
  currentDocument.parent_concept_ref = "concept-hypothesis.json";
  currentDocument.parent_content_hash = envelope.content_hash;
  delete currentDocument.research_handoff_input_hashes;
  const currentInputRefs = (currentConcept.input_refs as string[])
    .filter((ref) => ref !== binding.priorBinding.ref)
    .concat("concept-hypothesis.json")
    .sort();
  currentConcept.input_refs = currentInputRefs;
  currentConcept.content_hash = canonicalContentHash(currentDocument);
  const validation = await state.store.buildValidationContext(state.targetRunId, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      {
        path: String(currentConcept.artifact_path),
        document: currentConcept as unknown as FormalArtifactEnvelope,
      },
    ],
    exact_records: [],
  });
  const validator = await createArtifactValidator(repositoryRoot);
  assert.equal(
    validator
      .validateDocumentBundle(validation.bundle, validation.referenceContext)
      .referenceErrors.some(
        (error) => error.code === "research_handoff.consumer_provenance_not_propagated",
      ),
    false,
  );
});

test("pre-Plan research handoff remains forbidden for Discovery", async (context) => {
  const state = await prepareState(context, "discovery-pre-plan-rejected", {
    publishTargetCore: false,
  });
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: G21_CORE_REFS.filter((ref) => ref !== "plans/research-plan.r1.json").map((ref) =>
      fixtureEnvelope(state.targetBundle, ref),
    ),
  });
  await assert.rejects(
    state.store.createResearchHandoff(state.input),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.target_scope_plan_required",
  );
});

test("pre-Plan Assessment admits only the initial intake formation and rejects invalid items before mutation", async (context) => {
  const state = await prepareState(context, "assessment-pre-plan-boundary", {
    publishTargetCore: false,
    targetMode: "concept_evidence_assessment",
  });
  const assessmentFixture = await createG14ContractBundle("insufficient_evidence");
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: assessmentFormationEnvelopes(
      assessmentFixture,
      state.targetRunId,
      1,
      TARGET_SCOPE_R1,
    ),
  });
  const targetRoot = path.join(state.runsRoot, state.targetRunId);
  const beforeInvalid = await snapshotTree(targetRoot);
  const invalid = structuredClone(state.input);
  (invalid.items[0] as { role: string }).role = "reusable_evidence";
  await assert.rejects(
    state.store.createResearchHandoff(invalid),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.item_contract_invalid",
  );
  assert.deepEqual(await snapshotTree(targetRoot), beforeInvalid);
  await assert.rejects(
    state.store.createResearchHandoff({
      ...state.input,
      capturedAt: "not-a-timestamp",
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.request_invalid",
  );
  assert.deepEqual(await snapshotTree(targetRoot), beforeInvalid);

  const binding = await createReadHandoff(state, "concept-hypothesis.json", {
    includeReusableEvidence: false,
  });
  await state.store.publishArtifact({
    runId: state.targetRunId,
    envelope: assessmentConceptEnvelope(
      assessmentFixture,
      state.targetRunId,
      "scope-frame.json",
      "intake.json",
      TARGET_SCOPE_R1.targetUsers,
      binding.priorBinding,
    ),
  });
  await assert.rejects(
    state.store.readResearchHandoff({
      runId: state.targetRunId,
      handoffRef: binding.handoffRef,
      itemIds: ["reusable_source_material"],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.item_missing",
  );
  const second = {
    ...structuredClone(state.input),
    handoffId: "handoff_after_intake_forbidden",
  };
  await assert.rejects(
    state.store.createResearchHandoff(second),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.target_scope_plan_required",
  );
});

test("Scope r2 Assessment handoff binds exact re-formation through Concept and first Plan", async (context) => {
  const state = await prepareState(context, "assessment-scope-r2-handoff", {
    publishTargetCore: false,
    targetMode: "concept_evidence_assessment",
  });
  const assessmentFixture = await createG14ContractBundle("insufficient_evidence");
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: assessmentFormationEnvelopes(
      assessmentFixture,
      state.targetRunId,
      1,
      TARGET_SCOPE_R1,
    ),
  });
  await reviseScope(state, "assessment-r2-handoff");
  const scopeR2 = {
    geography: "Synthetic revised assessment-r2-handoff",
    customerModel: "b2c" as const,
    targetUsers: ["synthetic revised handoff user"],
    decisionGoal: "reconcile a confirmed Scope revision without replaying prior research",
    researchLanguage: "en-US",
    teamContext: TARGET_SCOPE_R1.teamContext,
  };
  const targetRoot = path.join(state.runsRoot, state.targetRunId);
  const beforeWrongTarget = await snapshotTree(targetRoot);
  await assert.rejects(
    state.store.createResearchHandoff(state.input),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.scope_formation_binding_invalid",
  );
  assert.deepEqual(await snapshotTree(targetRoot), beforeWrongTarget);

  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: assessmentFormationEnvelopes(assessmentFixture, state.targetRunId, 2, scopeR2),
  });
  const wrongTarget = structuredClone(state.input);
  await assert.rejects(
    state.store.createResearchHandoff(wrongTarget),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.item_contract_invalid",
  );
  const input = structuredClone(state.input);
  const prior = input.items.find((item) => item.itemId === "prior_opportunity_map");
  assert.ok(prior);
  (prior as { targetArtifactRef?: string }).targetArtifactRef = "concept-hypothesis.json";
  const inputWithoutReusableEvidence = {
    ...input,
    items: input.items.filter((item) => item.role !== "reusable_evidence"),
  };
  await assert.rejects(
    state.store.createResearchHandoff({ ...inputWithoutReusableEvidence, faultAt: "after_intent" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopenedStore = new RunStore(state.runsRoot, await createArtifactValidator(repositoryRoot));
  const recovered = await reopenedStore.load(state.targetRunId);
  const handoffRef = `artifacts/research-handoffs/${input.handoffId}.json`;
  assert.ok(recovered.recovered);
  assert.ok(recovered.manifest.artifact_refs.includes(handoffRef));
  assert.equal(
    (await reopenedStore.createResearchHandoff(inputWithoutReusableEvidence)).status,
    "idempotent_replay",
  );
  const firstRead = await reopenedStore.readResearchHandoff({
    runId: state.targetRunId,
    handoffRef,
    itemIds: ["prior_opportunity_map"],
    consumedAt: "2026-08-12T17:27:00Z",
  });
  assert.equal(firstRead.status, "appended");
  assert.equal(
    (
      await reopenedStore.readResearchHandoff({
        runId: state.targetRunId,
        handoffRef,
        itemIds: ["prior_opportunity_map"],
        consumedAt: "2026-08-12T17:27:00Z",
      })
    ).status,
    "idempotent_replay",
  );
  const binding = {
    ref: `${handoffRef}#prior_opportunity_map`,
    content_hash: firstRead.handoffContentHash,
  };
  await reopenedStore.publishArtifact({
    runId: state.targetRunId,
    envelope: assessmentConceptEnvelope(
      assessmentFixture,
      state.targetRunId,
      "scope-frame.r2.json",
      "intake.r2.json",
      scopeR2.targetUsers,
      binding,
    ),
  });
  const assessmentPlan = structuredClone(
    bundleDocument(assessmentFixture, "plans/concept-evidence-assessment-plan.r1.json"),
  );
  assessmentPlan.run_id = state.targetRunId;
  const researchPlan = structuredClone(
    bundleDocument(assessmentFixture, "plans/research-plan.r1.json"),
  );
  researchPlan.run_id = state.targetRunId;
  await publishInitialPlanBundle(
    reopenedStore,
    state.targetRunId,
    [
      envelopeForRun(state.targetRunId, "plans/research-plan.r1.json", researchPlan, [
        "concept-hypothesis.json",
        "plans/concept-evidence-assessment-plan.r1.json",
      ]),
      envelopeForRun(
        state.targetRunId,
        "plans/concept-evidence-assessment-plan.r1.json",
        assessmentPlan,
        ["concept-hypothesis.json", "plans/research-plan.r1.json"],
      ),
    ],
    "assessment",
  );
  const planned = await new RunStore(
    state.runsRoot,
    await createArtifactValidator(repositoryRoot),
  ).load(state.targetRunId);
  assert.equal(planned.manifest.status, "planned");
  assert.equal(planned.manifest.scope_revision, 2);
  assert.equal(planned.manifest.current_plan_ref, "plans/research-plan.r1.json");
});

test("a pre-Plan Assessment handoff becomes historical and inapplicable after Scope changes", async (context) => {
  const state = await prepareState(context, "assessment-stale-r1-handoff", {
    publishTargetCore: false,
    targetMode: "concept_evidence_assessment",
  });
  const assessmentFixture = await createG14ContractBundle("insufficient_evidence");
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: assessmentFormationEnvelopes(
      assessmentFixture,
      state.targetRunId,
      1,
      TARGET_SCOPE_R1,
    ),
  });
  const input = structuredClone(state.input);
  const prior = input.items.find((item) => item.itemId === "prior_opportunity_map");
  assert.ok(prior);
  (prior as { targetArtifactRef?: string }).targetArtifactRef = "concept-hypothesis.json";
  const created = await state.store.createResearchHandoff({
    ...input,
    items: input.items.filter((item) => item.role !== "reusable_evidence"),
  });
  const targetRoot = path.join(state.runsRoot, state.targetRunId);
  const oldBytes = await readFile(path.join(targetRoot, created.handoffRef));
  await reviseScope(state, "assessment-stale-r1-handoff");
  const reopenedStore = new RunStore(state.runsRoot, await createArtifactValidator(repositoryRoot));
  const reopened = await reopenedStore.load(state.targetRunId);
  assert.equal(reopened.manifest.artifact_refs.includes(created.handoffRef), false);
  assert.deepEqual(await readFile(path.join(targetRoot, created.handoffRef)), oldBytes);
  await assert.rejects(
    reopenedStore.readResearchHandoff({
      runId: state.targetRunId,
      handoffRef: created.handoffRef,
      itemIds: ["prior_opportunity_map"],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.applicability_expired",
  );
});

test("wrong source hashes and control-state imports fail before target mutation", async (context) => {
  const state = await prepareState(context, "negative");
  const targetRoot = path.join(state.runsRoot, state.targetRunId);
  const before = await snapshotTree(targetRoot);
  const wrongHash = structuredClone(state.input);
  (wrongHash.items[0] as { expectedSourceByteHash: string }).expectedSourceByteHash =
    `sha256:${"0".repeat(64)}`;
  await assert.rejects(
    state.store.createResearchHandoff(wrongHash),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.source_binding_mismatch",
  );
  assert.deepEqual(await snapshotTree(targetRoot), before);

  const sourcePlanPath = "plans/research-plan.r1.json";
  const sourcePlanBytes = await readFile(
    path.join(state.runsRoot, state.sourceRunId, sourcePlanPath),
  );
  const sourcePlanEnvelope = JSON.parse(sourcePlanBytes.toString("utf8")) as {
    content_hash: string;
  };
  const priorItem = state.input.items[0];
  assert.ok(priorItem);
  const controlInput: CreateResearchHandoffInput = {
    ...state.input,
    handoffId: "handoff_control_rejected",
    items: [
      {
        ...priorItem,
        itemId: "source_plan",
        sourceArtifactPath: sourcePlanPath,
        expectedSourceByteHash: sha256Bytes(sourcePlanBytes),
        expectedSourceContentHash: sourcePlanEnvelope.content_hash,
      },
    ],
  };
  await assert.rejects(
    state.store.createResearchHandoff(controlInput),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.source_binding_mismatch",
  );
  assert.deepEqual(await snapshotTree(targetRoot), before);
  for (const schema of [
    "startup_opportunity.run_manifest.v1",
    "startup_opportunity.checkpoint.v1",
    "startup_opportunity.research_plan.v1",
    "startup_opportunity.research_task.assessment.current",
    "startup_opportunity.assessment_stage_gate.v1",
    "startup_opportunity.decision_subject_snapshot.current",
  ]) {
    assert.equal(researchHandoffSourceRoleAllowed(schema, "prior_synthesis"), false, schema);
  }
  for (const schema of [
    "startup_opportunity.claim.assessment.current",
    "startup_opportunity.finding.assessment.current",
    "startup_opportunity.judgment_assessment.assessment.current",
    "startup_opportunity.terminal_report_source.v1",
  ]) {
    assert.equal(researchHandoffSourceRoleAllowed(schema, "user_authorized_input"), false, schema);
    assert.equal(researchHandoffSourceRoleAllowed(schema, "prior_synthesis"), true, schema);
    assert.equal(researchHandoffSourceRoleAllowed(schema, "revalidation_required"), true, schema);
  }
});

test("generic Artifact publication cannot forge a Harness-owned research handoff", async (context) => {
  const state = await prepareState(context, "dedicated-publish");
  const created = await state.store.createResearchHandoff(state.input);
  const genuine = JSON.parse(
    await readFile(path.join(state.runsRoot, state.targetRunId, created.handoffRef), "utf8"),
  ) as FormalArtifactEnvelope;
  const forgedDocument = structuredClone(genuine.document);
  forgedDocument.handoff_id = "forged";
  const forged: FormalArtifactEnvelope = {
    ...structuredClone(genuine),
    artifact_path: "artifacts/research-handoffs/forged.json",
    content_hash: canonicalContentHash(forgedDocument),
    document: forgedDocument,
  };
  const ordinary = clonedEnvelope(fixtureEnvelope(state.targetBundle, G21_SEED_REF));
  const targetRoot = path.join(state.runsRoot, state.targetRunId);
  const before = await snapshotTree(targetRoot);
  const artifactStore = new ArtifactStore(
    state.runsRoot,
    await createArtifactValidator(repositoryRoot),
  );
  for (const publish of [
    () =>
      state.store.publishArtifact({
        runId: state.targetRunId,
        envelope: forged,
      }),
    () =>
      state.store.publishArtifactBundle({
        runId: state.targetRunId,
        envelopes: [forged, ordinary],
      }),
    () => artifactStore.publish({ runId: state.targetRunId, envelope: forged }),
    () =>
      artifactStore.publishLocked(targetRoot, {
        runId: state.targetRunId,
        envelope: forged,
      }),
    () =>
      artifactStore.publishBundle({
        runId: state.targetRunId,
        envelopes: [forged, ordinary],
      }),
  ]) {
    await assert.rejects(
      publish(),
      (error: unknown) =>
        error instanceof StoreError && error.code === "research_handoff.dedicated_entry_required",
    );
    assert.deepEqual(await snapshotTree(targetRoot), before);
  }
});

test("generic Evidence publication cannot forge a Harness-owned handoff binding", async (context) => {
  const state = await prepareState(context, "dedicated-evidence-publish");
  const created = await state.store.createResearchHandoff(state.input);
  const handoff = JSON.parse(
    await readFile(path.join(state.runsRoot, state.targetRunId, created.handoffRef), "utf8"),
  ) as FormalArtifactEnvelope;
  const reusable = (handoff.document.items as Record<string, unknown>[]).find(
    (item) => item.item_id === "reusable_source_material",
  );
  assert.ok(reusable);
  const targetEvidenceRef = String(reusable.target_evidence_ref);
  const imported = await state.evidence.readExactRecord(state.targetRunId, targetEvidenceRef);
  assert.ok(imported.handoff_binding);
  const input = {
    runId: state.targetRunId,
    unitId: imported.unit_id,
    source: imported.source,
    acquisitionGoal: imported.acquisition_goal,
    rawContent: state.sourceEvidenceRaw,
    recordedAt: imported.recorded_at,
    operationKey: imported.operation_key,
    handoffBinding: imported.handoff_binding,
  } as const;
  const targetRoot = path.join(state.runsRoot, state.targetRunId);
  const before = await snapshotTree(targetRoot);
  for (const publish of [
    () => state.evidence.record(input),
    () => state.evidence.recordLocked(targetRoot, input),
  ]) {
    await assert.rejects(
      publish(),
      (error: unknown) =>
        error instanceof StoreError && error.code === "research_handoff.dedicated_entry_required",
    );
    assert.deepEqual(await snapshotTree(targetRoot), before);
  }
});

test("handoff crash recovery and replay are target-owned after source removal", async (context) => {
  for (const boundary of [
    "after_intent",
    "after_evidence_imports",
    "after_handoff_publish",
  ] as const) {
    await context.test(boundary, async (subcontext) => {
      const state = await prepareState(subcontext, boundary.replaceAll("_", "-"));
      await assert.rejects(
        state.store.createResearchHandoff({
          ...state.input,
          faultAt: boundary,
        }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      await rm(path.join(state.runsRoot, state.sourceRunId), {
        recursive: true,
        force: true,
      });
      const reopenedStore = new RunStore(
        state.runsRoot,
        await createArtifactValidator(repositoryRoot),
      );
      const recovered = await reopenedStore.load(state.targetRunId);
      assert.equal(recovered.recovered, true);
      assert.ok(
        recovered.manifest.artifact_refs.includes(
          `artifacts/research-handoffs/${state.input.handoffId}.json`,
        ),
      );
      const replay = await reopenedStore.createResearchHandoff(state.input);
      assert.equal(replay.status, "idempotent_replay");
      await reopenedStore.checkpoint({
        runId: state.targetRunId,
        checkpointId: `checkpoint_${boundary}`,
        createdAt: "2026-08-12T17:30:00Z",
        nextStep: "Continue current-Run research without reopening the source Run.",
        beliefSummary: {
          current_belief: "Prior material remains explicitly disclosed context.",
          evidence_that_changed_belief: [],
          unchanged_assumptions: ["No inherited conclusion is treated as current validation."],
          remaining_disagreement: ["Current applicability still requires target-Run research."],
          next_decision_relevant_question: "Which target-Run Evidence changes the hypothesis?",
        },
        inputRefs: [replay.handoffRef],
      });
      assert.equal((await reopenedStore.load(state.targetRunId)).recovered, false);
    });
  }
});

test("Scope revision recovery preserves durable handoffs and abandons only stale intent-only capture", async (context) => {
  for (const boundary of [
    "complete",
    "after_intent",
    "after_evidence_imports",
    "after_handoff_publish",
  ] as const) {
    await context.test(boundary, async (subcontext) => {
      const state = await prepareState(
        subcontext,
        `scope-revision-${boundary.replaceAll("_", "-")}`,
      );
      if (boundary === "complete") {
        await state.store.createResearchHandoff(state.input);
      } else {
        await assert.rejects(
          state.store.createResearchHandoff({
            ...state.input,
            faultAt: boundary,
          }),
          (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
        );
      }
      const targetRoot = path.join(state.runsRoot, state.targetRunId);
      const beforeRevision = await snapshotTree(targetRoot);
      await reviseScope(state, boundary);
      const reopenedStore = new RunStore(
        state.runsRoot,
        await createArtifactValidator(repositoryRoot),
      );
      const reopened = await reopenedStore.load(state.targetRunId);
      assert.equal(reopened.manifest.status, "needs_clarification");
      assert.equal(reopened.manifest.scope_revision, 2);
      const handoffRef = `artifacts/research-handoffs/${state.input.handoffId}.json`;
      assert.equal(
        reopened.manifest.artifact_refs.includes(handoffRef),
        boundary !== "after_intent",
      );
      if (boundary === "complete") {
        const after = await snapshotTree(targetRoot);
        for (const [relative, bytes] of Object.entries(beforeRevision)) {
          if (
            relative === "manifest.json" ||
            relative === "decisions.jsonl" ||
            relative.startsWith("checkpoints/") ||
            relative.startsWith(".store/operations/jsonl-")
          ) {
            continue;
          }
          assert.equal(after[relative], bytes, relative);
        }
      }
      await reopenedStore.checkpoint({
        runId: state.targetRunId,
        checkpointId: `checkpoint_scope_revision_${boundary}`,
        createdAt: "2026-08-12T17:26:00Z",
        nextStep:
          "Reconcile the confirmed Scope through Gap, Adaptation Decision, and Plan Revision.",
        beliefSummary: {
          current_belief: "The prior handoff remains historical input under its original binding.",
          evidence_that_changed_belief: [],
          unchanged_assumptions: ["No handoff bytes become current-Plan research implicitly."],
          remaining_disagreement: ["The revised Scope still requires Plan reconciliation."],
          next_decision_relevant_question: "What Plan change follows from the revised Scope?",
        },
        inputRefs: boundary === "after_intent" ? [] : [handoffRef],
      });
      assert.equal((await reopenedStore.load(state.targetRunId)).manifest.scope_revision, 2);
      if (boundary === "after_intent") {
        await assert.rejects(
          reopenedStore.createResearchHandoff(state.input),
          (error: unknown) =>
            error instanceof StoreError &&
            error.code === "research_handoff.intent_applicability_expired",
        );
      } else {
        assert.equal(
          (await reopenedStore.createResearchHandoff(state.input)).status,
          "idempotent_replay",
        );
      }
    });
  }
});

test("tampered target-owned handoff intent fails closed on reopen", async (context) => {
  const state = await prepareState(context, "tamper");
  await assert.rejects(
    state.store.createResearchHandoff({
      ...state.input,
      faultAt: "after_intent",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const operationDirectory = path.join(state.runsRoot, state.targetRunId, ".store/operations");
  const filename = (await readdir(operationDirectory)).find((entry) =>
    entry.startsWith("research-handoff-"),
  );
  assert.ok(filename);
  const operationPath = path.join(operationDirectory, filename);
  const intent = JSON.parse(await readFile(operationPath, "utf8")) as Record<string, unknown>;
  const envelope = intent.envelope as Record<string, unknown>;
  const document = envelope.document as Record<string, unknown>;
  const items = document.items as Record<string, unknown>[];
  assert.ok(items[0]);
  items[0].source_payload_base64 = Buffer.from("rewritten prior bytes").toString("base64");
  envelope.content_hash = canonicalContentHash(document);
  await writeFile(operationPath, `${canonicalJson(intent)}\n`);
  const before = await snapshotTree(path.join(state.runsRoot, state.targetRunId));
  await assert.rejects(
    state.store.load(state.targetRunId),
    (error: unknown) =>
      error instanceof StoreError && error.code === "recovery.invalid_research_handoff_operation",
  );
  assert.deepEqual(await snapshotTree(path.join(state.runsRoot, state.targetRunId)), before);
});

test("handoff recovery rejects imported Evidence outside the exact target unit and attempt before writes", async (context) => {
  for (const variant of ["wrong-target-unit", "wrong-target-attempt"] as const) {
    await context.test(variant, async (subcontext) => {
      const state = await prepareState(subcontext, `tamper-${variant}`);
      await assert.rejects(
        state.store.createResearchHandoff({
          ...state.input,
          faultAt: "after_intent",
        }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      const targetRoot = path.join(state.runsRoot, state.targetRunId);
      const operationDirectory = path.join(targetRoot, ".store/operations");
      const filename = (await readdir(operationDirectory)).find((entry) =>
        entry.startsWith("research-handoff-"),
      );
      assert.ok(filename);
      const operationPath = path.join(operationDirectory, filename);
      const intent = JSON.parse(await readFile(operationPath, "utf8")) as Record<string, unknown>;
      const imports = intent.evidence_imports as {
        record: Record<string, unknown>;
        raw_content_base64: string;
      }[];
      assert.equal(imports.length, 1);
      const evidenceImport = imports[0];
      assert.ok(evidenceImport);
      const tamperedRecord = retargetEvidenceImportRecord(evidenceImport.record, {
        ...(variant === "wrong-target-unit" ? { unitId: "unit_counterfactual" } : {}),
        ...(variant === "wrong-target-attempt" ? { unitAttempt: 2 } : {}),
      });
      evidenceImport.record = tamperedRecord;
      const envelope = intent.envelope as Record<string, unknown>;
      const document = envelope.document as Record<string, unknown>;
      const items = document.items as Record<string, unknown>[];
      const reusableItem = items.find((item) => item.item_id === "reusable_source_material");
      assert.ok(reusableItem);
      reusableItem.target_evidence_ref = `evidence/manifest.jsonl#${String(
        tamperedRecord.evidence_id,
      )}`;
      reusableItem.target_evidence_record_hash = canonicalContentHash(tamperedRecord);
      envelope.content_hash = canonicalContentHash(document);
      await writeFile(operationPath, `${canonicalJson(intent)}\n`);

      const before = await snapshotTree(targetRoot);
      await assert.rejects(
        state.store.load(state.targetRunId),
        (error: unknown) =>
          error instanceof StoreError &&
          error.code === "recovery.invalid_research_handoff_operation",
      );
      assert.deepEqual(await snapshotTree(targetRoot), before);
    });
  }
});

test("handoff recovery validates target Plan canonical bytes before imported Evidence writes", async (context) => {
  const state = await prepareState(context, "tamper-target-plan-canonical");
  await assert.rejects(
    state.store.createResearchHandoff({
      ...state.input,
      faultAt: "after_intent",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const targetRoot = path.join(state.runsRoot, state.targetRunId);
  const operationDirectory = path.join(targetRoot, ".store/operations");
  for (const filename of await readdir(operationDirectory)) {
    if (
      (!filename.startsWith("artifact-") && !filename.startsWith("bundle-")) ||
      !filename.endsWith(".json")
    ) {
      continue;
    }
    await rm(path.join(operationDirectory, filename));
  }
  const publicationDirectory = path.join(targetRoot, ".store/publications");
  for (const filename of await readdir(publicationDirectory)) {
    if (!filename.endsWith(".json")) continue;
    await rm(path.join(publicationDirectory, filename));
  }
  const targetPlanRef = "plans/research-plan.r1.json";
  for (const filename of await readdir(operationDirectory)) {
    if (!filename.startsWith("research-handoff-") || !filename.endsWith(".json")) continue;
    const operationPath = path.join(operationDirectory, filename);
    const operation = JSON.parse(await readFile(operationPath, "utf8")) as Record<string, unknown>;
    const envelope = operation.envelope as Record<string, unknown>;
    const document = envelope.document as Record<string, unknown>;
    assert.equal(document.target_plan_ref, targetPlanRef);
  }
  const planPath = path.join(targetRoot, "plans/research-plan.r1.json");
  const planEnvelope = JSON.parse(await readFile(planPath, "utf8")) as FormalArtifactEnvelope;
  const originalPlanHash = planEnvelope.content_hash;
  planEnvelope.document.plan_id = "tampered_plan_document_with_old_content_hash";
  assert.equal(planEnvelope.content_hash, originalPlanHash);
  await writeFile(planPath, `${canonicalJson(planEnvelope)}\n`);

  const before = await snapshotTree(targetRoot);
  const handoffRef = `artifacts/research-handoffs/${state.input.handoffId}.json`;
  assert.equal(before[handoffRef], undefined);
  assert.equal(before["evidence/manifest.jsonl"] ?? "", "");
  await assert.rejects(
    state.store.load(state.targetRunId),
    (error: unknown) =>
      error instanceof StoreError && error.code === "recovery.invalid_research_handoff_operation",
  );
  assert.deepEqual(await snapshotTree(targetRoot), before);
});

test("handoff recovery preflights target Plan before partial imported Evidence recovery", async (context) => {
  for (const partial of ["receipt-raw-temp", "receipt-raw-target"] as const) {
    await context.test(partial, async (subcontext) => {
      const state = await prepareState(subcontext, `tamper-target-plan-${partial}`);
      await assert.rejects(
        state.store.createResearchHandoff({
          ...state.input,
          faultAt: "after_intent",
        }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );

      const targetRoot = path.join(state.runsRoot, state.targetRunId);
      const operationDirectory = path.join(targetRoot, ".store/operations");
      const filename = (await readdir(operationDirectory)).find((entry) =>
        entry.startsWith("research-handoff-"),
      );
      assert.ok(filename);
      const intent = JSON.parse(
        await readFile(path.join(operationDirectory, filename), "utf8"),
      ) as Record<string, unknown>;
      const imports = intent.evidence_imports as {
        readonly record: Record<string, unknown>;
        readonly raw_content_base64: string;
      }[];
      assert.equal(imports.length, 1);
      const evidenceImport = imports[0];
      assert.ok(evidenceImport);
      const record = evidenceImport.record;
      const operationHex = sha256HexFromHash(String(record.operation_key));
      const receiptRelative = `.store/operations/evidence-${operationHex}.json`;
      await writeFile(
        path.join(targetRoot, receiptRelative),
        `${canonicalJson({
          schema_version: "startup_opportunity.evidence_store_operation.current",
          operation_key: record.operation_key,
          record,
        })}\n`,
      );
      const rawBytes = Buffer.from(evidenceImport.raw_content_base64, "base64");
      if (partial === "receipt-raw-temp") {
        await writeFile(
          path.join(targetRoot, ".store/temp", `evidence-${operationHex}.raw.tmp`),
          rawBytes,
        );
      } else {
        const rawTarget = path.join(targetRoot, String(record.raw_content_ref));
        await mkdir(path.dirname(rawTarget), { recursive: true });
        await writeFile(rawTarget, rawBytes);
      }

      const planPath = path.join(targetRoot, "plans/research-plan.r1.json");
      const planEnvelope = JSON.parse(await readFile(planPath, "utf8")) as FormalArtifactEnvelope;
      const originalPlanHash = planEnvelope.content_hash;
      planEnvelope.document.plan_id = `tampered_plan_document_with_old_content_hash_${partial}`;
      assert.equal(planEnvelope.content_hash, originalPlanHash);
      await writeFile(planPath, `${canonicalJson(planEnvelope)}\n`);

      const before = await snapshotTree(targetRoot);
      assert.equal(before["evidence/manifest.jsonl"] ?? "", "");
      assert.ok(before[receiptRelative]);
      await assert.rejects(
        state.store.load(state.targetRunId),
        (error: unknown) =>
          error instanceof StoreError &&
          error.code === "recovery.invalid_research_handoff_operation",
      );
      assert.deepEqual(await snapshotTree(targetRoot), before);
    });
  }
});

test("tampered handoff envelope closure fails before imported Evidence mutation", async (context) => {
  const state = await prepareState(context, "tamper-envelope-closure");
  await assert.rejects(
    state.store.createResearchHandoff({
      ...state.input,
      faultAt: "after_intent",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const targetRoot = path.join(state.runsRoot, state.targetRunId);
  const operationDirectory = path.join(targetRoot, ".store/operations");
  const filename = (await readdir(operationDirectory)).find((entry) =>
    entry.startsWith("research-handoff-"),
  );
  assert.ok(filename);
  const operationPath = path.join(operationDirectory, filename);
  const intent = JSON.parse(await readFile(operationPath, "utf8")) as Record<string, unknown>;
  const envelope = intent.envelope as Record<string, unknown>;
  envelope.input_refs = ["scope-frame.json"];
  await writeFile(operationPath, `${canonicalJson(intent)}\n`);
  const before = await snapshotTree(targetRoot);
  await assert.rejects(
    state.store.load(state.targetRunId),
    (error: unknown) =>
      error instanceof StoreError && error.code === "recovery.invalid_research_handoff_operation",
  );
  assert.deepEqual(await snapshotTree(targetRoot), before);
});

test("CLI creates and reads an exact target-owned handoff with structured failures", async (context) => {
  const state = await prepareState(context, "cli");
  const requestFile = path.join(state.root, "handoff-request.json");
  await writeFile(
    requestFile,
    `${JSON.stringify({
      run_id: state.input.runId,
      handoff_id: state.input.handoffId,
      source_run_id: state.input.sourceRunId,
      user_authorization_attestation: state.input.userAuthorizationAttestation,
      target_purpose: state.input.targetPurpose,
      captured_at: state.input.capturedAt,
      items: state.input.items.map((item) => ({
        item_id: item.itemId,
        source_artifact_path: item.sourceArtifactPath,
        role: item.role,
        expected_source_byte_hash: item.expectedSourceByteHash,
        expected_source_content_hash: item.expectedSourceContentHash,
        freshness_disposition: item.freshnessDisposition,
        applicability_disposition: item.applicabilityDisposition,
        revalidation_status: item.revalidationStatus,
        ...(item.targetUnitId === undefined ? {} : { target_unit_id: item.targetUnitId }),
        ...(item.targetResearchGoal === undefined
          ? {}
          : { target_research_goal: item.targetResearchGoal }),
        ...(item.targetArtifactRef === undefined
          ? {}
          : { target_artifact_ref: item.targetArtifactRef }),
      })),
    })}\n`,
  );
  const created = runScript(
    ".agents/skills/startup-opportunity/scripts/create-research-handoff.ts",
    ["--runs-root", state.runsRoot, "--file", requestFile],
  );
  assert.equal(created.status, 0, created.stderr);
  const result = JSON.parse(created.stdout) as { handoffRef: string };
  const read = runScript(".agents/skills/startup-opportunity/scripts/read-research-handoff.ts", [
    "--runs-root",
    state.runsRoot,
    "--run-id",
    state.targetRunId,
    "--handoff-ref",
    result.handoffRef,
    "--item-id",
    "prior_opportunity_map",
    "--consumed-at",
    "2026-08-12T17:20:00Z",
  ]);
  assert.equal(read.status, 0, read.stderr);
  assert.equal((JSON.parse(read.stdout) as { items: unknown[] }).items.length, 1);
  for (const script of [
    ".agents/skills/startup-opportunity/scripts/create-research-handoff.ts",
    ".agents/skills/startup-opportunity/scripts/read-research-handoff.ts",
  ]) {
    const failure = runScript(script, []);
    assert.equal(failure.status, 64, failure.stderr);
    assert.equal(
      (JSON.parse(failure.stderr) as { error: { code: string } }).error.code,
      "command.invalid_arguments",
    );
  }
});

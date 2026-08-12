import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  RunStore,
  StoreError,
  sha256Bytes,
} from "../harness/src/index.js";
import { researchHandoffSourceRoleAllowed } from "../harness/src/validators/research-handoff-validator.js";
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
import { G22_DEMAND_R2, G22_FAN_IN } from "./fixtures/g2.2/discovery-candidate-fixture.js";
import {
  createDiscoveryRuntimeFixture,
  runtimeEnvelope,
} from "./fixtures/g2.2/discovery-runtime-fixture.js";
import {
  createDiscoverySynthesisFixture,
  G23_OPPORTUNITY_A,
  G23_OPPORTUNITY_B,
  synthesisEnvelope,
} from "./fixtures/g2.3/discovery-synthesis-fixture.js";
import { createConfirmedRun } from "./helpers/current-run.js";
import { discoveryWaveEnvelopes } from "./helpers/discovery-wave.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const CAPTURED_AT = "2026-08-12T17:10:00Z";

interface HandoffState {
  readonly root: string;
  readonly runsRoot: string;
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly store: RunStore;
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

async function recordDiscoverySubstrate(state: HandoffState, suffix: string) {
  const generation = (
    await state.evidence.record({
      runId: state.targetRunId,
      unitId: "unit_seed_independent_demand",
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:handoff:${suffix}:generation`,
      },
      researchGoal: "SYNTHETIC current-Run generation substrate; not Evidence.",
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
      researchGoal: "SYNTHETIC current-Run evaluation substrate; not Evidence.",
      rawContent: "SYNTHETIC current-Run evaluation bytes; not Evidence.",
      recordedAt: "2026-08-12T17:21:00Z",
    })
  ).record;
  return { generation, evaluation };
}

async function createReadHandoff(state: HandoffState): Promise<HandoffBindingState> {
  const created = await state.store.createResearchHandoff(state.input);
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

async function assertPublicationRejected(
  store: RunStore,
  runId: string,
  envelopes: readonly FormalArtifactEnvelope[],
  code: string,
): Promise<void> {
  await assert.rejects(
    envelopes.length === 1
      ? store.publishArtifact({ runId, envelope: envelopes[0] as FormalArtifactEnvelope })
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

async function publishDiscoveryThroughFanIn(
  state: HandoffState,
  bundle: DocumentBundle,
): Promise<void> {
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: initialCandidateEnvelopes(bundle),
  });
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: discoveryWaveEnvelopes(
      bundle,
      state.targetRunId,
      "startup_opportunity.research_task.discovery_candidate.current",
      1,
      "candidate_runtime",
    ),
  });
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
  await state.store.publishArtifact({
    runId: state.targetRunId,
    envelope: runtimeEnvelope(bundle, G22_FAN_IN),
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
        geography: "Synthetic",
        customerModel: "b2c",
        targetUsers: ["synthetic handoff fixture user"],
        decisionGoal: "test explicit current-contract research handoff",
        researchLanguage: "en-US",
      },
    });
    if (runId === sourceRunId || options.publishTargetCore !== false) {
      await store.publishArtifactBundle({
        runId,
        envelopes: G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
      });
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
    researchGoal: "Preserve provider-agnostic synthetic source bytes for handoff testing.",
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
        targetUnitId: "unit_target_reweighting",
        targetResearchGoal: "Reassess these exact bytes under the target Scope and current Plan.",
      },
    ],
  };
  return {
    root,
    runsRoot,
    sourceRunId,
    targetRunId,
    store,
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

  const evidenceOnlyRead = await state.store.readResearchHandoff({
    runId: state.targetRunId,
    handoffRef: created.handoffRef,
    itemIds: ["reusable_source_material"],
    consumedAt: "2026-08-12T17:11:00Z",
  });
  assert.equal(evidenceOnlyRead.status, "appended");
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(state.targetBundle, ref)),
  });

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

test("reading prior synthesis forces exact handoff provenance on later formation", async (context) => {
  const state = await prepareState(context, "taint");
  const created = await state.store.createResearchHandoff(state.input);
  await state.store.readResearchHandoff({
    runId: state.targetRunId,
    handoffRef: created.handoffRef,
    itemIds: ["prior_opportunity_map"],
    consumedAt: "2026-08-12T17:12:00Z",
  });
  await assert.rejects(
    state.store.publishArtifactBundle({
      runId: state.targetRunId,
      envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(state.targetBundle, ref)),
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      Array.isArray(error.details.referenceErrors) &&
      error.details.referenceErrors.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as Record<string, unknown>).code ===
            "research_handoff.consumer_provenance_not_propagated",
      ),
  );
  const binding = {
    ref: `${created.handoffRef}#prior_opportunity_map`,
    content_hash: created.handoffContentHash,
  };
  for (const ref of G21_MAP_REFS) {
    const document = fixtureDocument(state.targetBundle, ref);
    document.research_handoff_input_hashes = [binding];
    const provenance = document.content_provenance as Record<string, unknown>;
    provenance.synthesis_origin = "research_handoff_informed_synthesis";
    const envelope = fixtureEnvelope(state.targetBundle, ref) as unknown as Record<string, unknown>;
    envelope.input_refs = [...new Set([...(envelope.input_refs as string[]), binding.ref])].sort();
  }
  refreshDiscoveryMapsBundle(state.targetBundle);
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

test("Candidate formation closes over the exact prior handoff item and rejects Evidence substitution", async (context) => {
  const state = await prepareState(context, "candidate-consumer", { publishTargetCore: false });
  const substrate = await recordDiscoverySubstrate(state, "candidate-consumer");
  const bundle = await createDiscoveryRuntimeFixture(
    state.targetRunId,
    substrate,
    [],
    "general",
    true,
  );
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  const binding = await createReadHandoff(state);
  const initial = initialCandidateEnvelopes(bundle).map(clonedEnvelope);
  for (const envelope of initial) bindHandoff(envelope, binding.priorBinding);
  refreshCandidateFormationBindings(initial);

  const wrongHash = initial.map(clonedEnvelope);
  const wrongHashFormation = wrongHash[0]?.document.formation as Record<string, unknown>;
  wrongHashFormation.research_handoff_input_hashes = [
    { ...binding.priorBinding, content_hash: `sha256:${"0".repeat(64)}` },
  ];
  if (wrongHash[0] !== undefined) {
    (wrongHash[0] as unknown as { content_hash: string }).content_hash = canonicalContentHash(
      wrongHash[0].document,
    );
  }
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    wrongHash,
    "research_handoff.consumer_binding_mismatch",
  );

  const missingInputRef = initial.map(clonedEnvelope);
  if (missingInputRef[0] !== undefined) {
    (missingInputRef[0] as unknown as { input_refs: string[] }).input_refs =
      missingInputRef[0].input_refs.filter((ref) => ref !== binding.priorBinding.ref);
  }
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    missingInputRef,
    "research_handoff.consumer_binding_mismatch",
  );

  const evidenceSubstitution = initial.map(clonedEnvelope);
  if (evidenceSubstitution[0] !== undefined) {
    bindHandoff(evidenceSubstitution[0], binding.reusableBinding);
  }
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
});

test("Opportunity Thesis publication preserves exact handoff formation closure", async (context) => {
  const state = await prepareState(context, "opportunity-consumer", { publishTargetCore: false });
  const substrate = await recordDiscoverySubstrate(state, "opportunity-consumer");
  const bundle = await createDiscoverySynthesisFixture(state.targetRunId, substrate);
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  await publishDiscoveryThroughFanIn(state, bundle);
  const binding = await createReadHandoff(state);
  const synthesis = synthesisEnvelopes(bundle).map(clonedEnvelope);
  for (const envelope of synthesis) {
    if (envelope.artifact_type === "startup_opportunity.opportunity_thesis.v1") {
      bindHandoff(envelope, binding.priorBinding);
    }
  }

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
  assert.ok(
    synthesisEnvelope(bundle, G23_OPPORTUNITY_B).document.research_handoff_input_hashes ===
      undefined,
  );
});

test("Concept intake formation binds the exact handoff item without treating copied Evidence as prior synthesis", async (context) => {
  const state = await prepareState(context, "concept-consumer", {
    publishTargetCore: false,
    targetMode: "concept_evidence_assessment",
  });
  const assessmentFixture = await createG14ContractBundle("insufficient_evidence");
  await state.store.publishArtifactBundle({
    runId: state.targetRunId,
    envelopes: ["intake.json", "decision-context.json", "scope-frame.json"].map((artifactPath) => {
      const document = structuredClone(bundleDocument(assessmentFixture, artifactPath));
      document.run_id = state.targetRunId;
      return envelopeForRun(state.targetRunId, artifactPath, document, []);
    }),
  });
  const binding = await createReadHandoff(state);
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

  const evidenceSubstitution = clonedEnvelope(envelope);
  bindHandoff(evidenceSubstitution, binding.reusableBinding);
  await assertPublicationRejected(
    state.store,
    state.targetRunId,
    [evidenceSubstitution],
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
    envelopes: ["intake.json", "decision-context.json", "scope-frame.json"].map((artifactPath) => {
      const document = structuredClone(bundleDocument(assessmentFixture, artifactPath));
      document.run_id = state.targetRunId;
      return envelopeForRun(state.targetRunId, artifactPath, document, []);
    }),
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
    state.store.createResearchHandoff({ ...state.input, capturedAt: "not-a-timestamp" }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.request_invalid",
  );
  assert.deepEqual(await snapshotTree(targetRoot), beforeInvalid);

  const binding = await createReadHandoff(state);
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
  await state.store.publishArtifact({
    runId: state.targetRunId,
    envelope: envelopeForRun(state.targetRunId, "concept-hypothesis.json", concept, [
      "scope-frame.json",
      "intake.json",
      binding.priorBinding.ref,
    ]),
  });
  await assert.rejects(
    state.store.readResearchHandoff({
      runId: state.targetRunId,
      handoffRef: binding.handoffRef,
      itemIds: ["reusable_source_material"],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.intake_formation_closed",
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
    () => state.store.publishArtifact({ runId: state.targetRunId, envelope: forged }),
    () =>
      state.store.publishArtifactBundle({
        runId: state.targetRunId,
        envelopes: [forged, ordinary],
      }),
    () => artifactStore.publish({ runId: state.targetRunId, envelope: forged }),
    () => artifactStore.publishLocked(targetRoot, { runId: state.targetRunId, envelope: forged }),
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
    researchGoal: imported.research_goal,
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
        state.store.createResearchHandoff({ ...state.input, faultAt: boundary }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      await rm(path.join(state.runsRoot, state.sourceRunId), { recursive: true, force: true });
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

test("tampered target-owned handoff intent fails closed on reopen", async (context) => {
  const state = await prepareState(context, "tamper");
  await assert.rejects(
    state.store.createResearchHandoff({ ...state.input, faultAt: "after_intent" }),
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

test("tampered handoff envelope closure fails before imported Evidence mutation", async (context) => {
  const state = await prepareState(context, "tamper-envelope-closure");
  await assert.rejects(
    state.store.createResearchHandoff({ ...state.input, faultAt: "after_intent" }),
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

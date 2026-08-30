import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  canonicalJson,
  createArtifactValidator,
  EvidenceStore,
  type EvidenceStoreRecord,
  type FormalArtifactEnvelope,
  inspectSchemaBundle,
  LaneResultMaterializer,
  type OperationObservation,
  RunStore,
  StoreError,
} from "../harness/src/index.js";
import {
  branchResearchEnvelopes,
  dispatchEnvelope,
  executionPlanEnvelope,
  G12_BASE_TIME,
  G12_BRANCHES,
  G12_RUN_ID,
  initialFixtureEnvelopes,
  taskEnvelope,
} from "./fixtures/g1.2/research-branch-fixture.js";
import { createConfirmedRun, publishInitialPlanBundle } from "./helpers/current-run.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const baseFixturePath = path.join(
  repositoryRoot,
  "tests/fixtures/g1.1/valid-assess-contract-bundle.json",
);

async function baseFixture() {
  return JSON.parse(await readFile(baseFixturePath, "utf8")) as {
    readonly documents: readonly {
      readonly path: string;
      readonly document: Record<string, unknown>;
    }[];
  };
}

async function setup(context: TestContext, runId = G12_RUN_ID) {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g1-2-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "concept_evidence_assessment",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
    createdAt: G12_BASE_TIME,
  });
  return { runsRoot, runRoot: path.join(runsRoot, runId), validator, store };
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

async function prepareSingleBranch(context: TestContext, runId = G12_RUN_ID) {
  const state = await setup(context, runId);
  const base = await baseFixture();
  const branch = G12_BRANCHES[0];
  assert.ok(branch);
  const initial = initialFixtureEnvelopes(base, [branch]);
  await publishInitialPlanBundle(state.store, runId, initial, "assessment");
  const task = taskEnvelope(base, branch, 2);
  await state.store.publishArtifactBundle({
    runId,
    envelopes: [executionPlanEnvelope(base, [branch]), dispatchEnvelope(base, [branch]), task],
  });
  const evidenceStore = new EvidenceStore(state.runsRoot);
  const researchGoal = String(task.document.research_goal);
  const publicRecord = await evidenceStore.record({
    runId,
    unitId: branch.unitId,
    acquisitionGoal: researchGoal,
    source: { kind: "public_url", canonical_url: "https://synthetic.invalid/state-support" },
    rawContent: "SYNTHETIC STATE SUPPORT BYTES; NOT MARKET EVIDENCE.",
    recordedAt: "2026-07-24T20:20:00Z",
  });
  const userRecord = await evidenceStore.record({
    runId,
    unitId: branch.unitId,
    acquisitionGoal: researchGoal,
    source: {
      kind: "user_provided",
      canonical_uri: "urn:startup-opportunity:user-provided:state-oppose",
    },
    rawContent: "SYNTHETIC STATE OPPOSING BYTES; NOT MARKET EVIDENCE.",
    recordedAt: "2026-07-24T20:21:00Z",
  });
  const envelopes = branchResearchEnvelopes(
    branch,
    [publicRecord.record, userRecord.record],
    0,
    String(task.document.research_goal),
  ).map((envelope) => ({
    ...envelope,
    run_id: runId,
    document: { ...envelope.document, run_id: runId },
  }));
  for (const envelope of envelopes) {
    (envelope as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
      envelope.document,
    );
  }
  return { ...state, base, initial, branch, task, envelopes };
}

function semanticLaneDocument(envelope: FormalArtifactEnvelope): Record<string, unknown> {
  const document = structuredClone(envelope.document);
  for (const field of ["schema_version", "run_id", "unit_id", "lineage", "mechanical_binding"])
    delete document[field];
  if (
    envelope.artifact_type === "startup_opportunity.concept_evidence_assessment_branch_result.v1"
  ) {
    for (const field of [
      "branch_id",
      "concept_hypothesis_ref",
      "assessment_plan_ref",
      "dimension_id",
    ])
      delete document[field];
  }
  if (envelope.artifact_type === "startup_opportunity.evidence.assessment.current")
    delete document.evidence_id;
  return document;
}

function remapArtifactRefs(value: unknown, pathByLegacyRef: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return pathByLegacyRef.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapArtifactRefs(item, pathByLegacyRef));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, remapArtifactRefs(item, pathByLegacyRef)]),
  );
}

function emptyCommercialDelivery(): Record<string, unknown> {
  return {
    audited_at: "2026-07-24T20:22:00Z",
    research_objectives: ["Disclose the bounded synthetic research closure."],
    primary_routes: ["Repository-existing synthetic fixture inputs."],
    search_results: [],
    evidence_sources: [],
    findings: [],
    claims: [],
    judgments: [],
    quantitative_observations: [],
    competitive_observations: [],
    incumbent_response_assessments: [],
    unresolved_gaps: [],
    limitations: ["SYNTHETIC contract fixture; no market research was performed."],
    stop_reason: "The bounded fixture contract was complete.",
    telemetry_basis: "unavailable",
    query_log_complete: false,
  };
}

async function publishVerticalFixture(context: TestContext) {
  const state = await setup(context);
  const base = await baseFixture();
  const initial = initialFixtureEnvelopes(base);
  const initialResult = await publishInitialPlanBundle(
    state.store,
    G12_RUN_ID,
    initial,
    "assessment",
  );
  assert.equal(initialResult.status, "published");

  const tasks = G12_BRANCHES.map((branch, index) => taskEnvelope(base, branch, index + 2));
  const dispatch = dispatchEnvelope(base);
  await state.store.publishArtifactBundle({
    runId: G12_RUN_ID,
    envelopes: [executionPlanEnvelope(base), dispatch, ...tasks],
  });

  const evidenceStore = new EvidenceStore(state.runsRoot);
  const records = new Map<string, readonly [EvidenceStoreRecord, EvidenceStoreRecord]>();
  for (const [index, branch] of G12_BRANCHES.entries()) {
    const researchGoal = String(tasks[index]?.document.research_goal ?? "");
    const publicRecord = await evidenceStore.record({
      runId: G12_RUN_ID,
      unitId: branch.unitId,
      acquisitionGoal: researchGoal,
      source: {
        kind: "public_url",
        canonical_url: `https://synthetic.invalid/${branch.unitId}?fixture=1#ignored`,
      },
      rawContent: `SYNTHETIC CONTRACT FIXTURE ${branch.unitId} support; not market Evidence.`,
      recordedAt: `2026-07-24T20:${String(20 + index).padStart(2, "0")}:00Z`,
    });
    const userRecord = await evidenceStore.record({
      runId: G12_RUN_ID,
      unitId: branch.unitId,
      acquisitionGoal: researchGoal,
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:${branch.unitId}:oppose`,
      },
      rawContent: `SYNTHETIC CONTRACT FIXTURE ${branch.unitId} oppose; not market Evidence.`,
      recordedAt: `2026-07-24T20:${String(24 + index).padStart(2, "0")}:00Z`,
    });
    records.set(branch.unitId, [publicRecord.record, userRecord.record]);
  }

  const branchBundles: FormalArtifactEnvelope[][] = [];
  for (const [index, branch] of G12_BRANCHES.entries()) {
    const pair = records.get(branch.unitId);
    assert.ok(pair);
    const envelopes = [
      ...branchResearchEnvelopes(
        branch,
        pair,
        index,
        String(tasks[index]?.document.research_goal ?? ""),
      ),
    ];
    branchBundles.push(envelopes);
    await state.store.publishArtifactBundle({ runId: G12_RUN_ID, envelopes });
  }

  await state.store.checkpoint({
    runId: G12_RUN_ID,
    checkpointId: "checkpoint_g1_2_vertical",
    createdAt: "2026-07-24T21:00:00Z",
    nextStep: "Independent G1.2 regression; G1.3 remains NOT_READY.",
    beliefSummary: {
      current_belief: "Only the G1.2 mechanical contract has been exercised.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["No market Evidence was collected."],
      remaining_disagreement: ["The concept thesis remains unassessed by real Evidence."],
      next_decision_relevant_question: "Does independent regression accept G1.2 mechanics?",
    },
    inputRefs: G12_BRANCHES.map((branch) => branch.outputPath),
  });
  return { ...state, initial, dispatch, tasks, records, branchBundles };
}

test("current bundle publishes Evidence Store and research branch schemas", async () => {
  const result = await inspectSchemaBundle(repositoryRoot);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.ok(result.schemaCount > 0);
  assert.ok(result.documentSchemaCount > 0);
});

test("direct Assessment Task uses the typed one-shot Lane delivery path", async (context) => {
  const state = await prepareSingleBranch(context);
  const taskRef = state.task.artifact_path;
  const receipts = state.envelopes
    .filter(
      (envelope) => envelope.artifact_type === "startup_opportunity.evidence.assessment.current",
    )
    .map((envelope) => ({
      envelope,
      ref: String(
        (
          (envelope.document as Record<string, unknown>).mechanical_binding as Record<
            string,
            unknown
          >
        ).substrate_record_ref,
      ),
    }));
  assert.equal(receipts.length, 2);
  const familyByType = new Map<string, string>([
    ["startup_opportunity.evidence.assessment.current", "evidence"],
    ["startup_opportunity.claim.assessment.current", "claim"],
    ["startup_opportunity.finding.assessment.current", "finding"],
    ["startup_opportunity.insight.assessment.current", "insight"],
    ["startup_opportunity.source_manifest.assessment.current", "source_manifest"],
    ["startup_opportunity.concept_evidence_assessment_branch_result.v1", "lane_result"],
  ]);
  const pathByLegacyRef = new Map(
    state.envelopes.map((envelope) => {
      const idField =
        envelope.artifact_type === "startup_opportunity.claim.assessment.current"
          ? "claim_id"
          : envelope.artifact_type === "startup_opportunity.finding.assessment.current"
            ? "finding_id"
            : envelope.artifact_type === "startup_opportunity.insight.assessment.current"
              ? "insight_id"
              : envelope.artifact_type === "startup_opportunity.source_manifest.assessment.current"
                ? "manifest_id"
                : null;
      const directory =
        envelope.artifact_type === "startup_opportunity.claim.assessment.current"
          ? "claims"
          : envelope.artifact_type === "startup_opportunity.finding.assessment.current"
            ? "findings"
            : envelope.artifact_type === "startup_opportunity.insight.assessment.current"
              ? "insights"
              : "evidence/source-manifests";
      return [
        envelope.artifact_path,
        idField === null
          ? envelope.artifact_path
          : `${directory}/${String((envelope.document as Record<string, unknown>)[idField])}.json`,
      ];
    }),
  );
  const agentDocuments = state.envelopes.map((envelope) => {
    const artifactFamily = familyByType.get(envelope.artifact_type);
    assert.ok(artifactFamily);
    const receipt = receipts.find(
      (candidate) => candidate.envelope.artifact_path === envelope.artifact_path,
    );
    return {
      artifact_family: artifactFamily,
      ...(receipt === undefined ? {} : { evidence_receipt_ref: receipt.ref }),
      document: remapArtifactRefs(semanticLaneDocument(envelope), pathByLegacyRef) as Record<
        string,
        unknown
      >,
    };
  });
  agentDocuments.push({ artifact_family: "commercial_audit", document: emptyCommercialDelivery() });
  const staging = {
    schema_version: "startup_opportunity.lane_staging_document.current",
    staging_id: "DO_NOT_EMIT_VALID_LANE_STAGING_ID",
    run_id: state.task.run_id,
    task_ref: taskRef,
    created_at: "2026-07-24T20:22:00Z",
    producer_role: "lane_researcher",
    operation: "validate_only",
    evidence_receipt_refs: receipts.map((receipt) => receipt.ref),
    delivery_contract: {
      search_closure: {
        status: "completed",
        acquisition_routes_attempted: ["repository_source"],
        unresolved_gaps: ["No market research was performed."],
        stop_reason: "The deterministic current-contract fixture was complete.",
      },
    },
    agent_documents: agentDocuments,
  };
  const materializer = new LaneResultMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const before = await snapshotTree(state.runRoot);
  const duplicateAuthority = structuredClone(staging) as typeof staging & {
    delivery_contract: typeof staging.delivery_contract & { scope_coverage: unknown };
  };
  duplicateAuthority.staging_id = "staging_direct_assessment_duplicate_scope_authority";
  duplicateAuthority.delivery_contract.scope_coverage = [];
  await assert.rejects(materializer.materialize(duplicateAuthority), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, "runtime.lane_staging_invalid");
    const issues = error.details.issues as Record<string, unknown>[];
    assert.ok(
      issues.some(
        (entry) =>
          entry.code === "lane_delivery.schema.additionalProperties" &&
          entry.mechanically_derivable === true,
      ),
    );
    return true;
  });
  assert.deepEqual(await snapshotTree(state.runRoot), before);
  const observations: OperationObservation[] = [];
  const validated = await materializer
    .materialize(staging, { observe: (event) => observations.push(event) })
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
      }
      throw error;
    });
  assert.doesNotMatch(JSON.stringify(observations), /DO_NOT_EMIT_VALID_LANE_STAGING_ID/u);
  assert.equal(validated.compilation.status, "validated");
  assert.deepEqual(await snapshotTree(state.runRoot), before);
  assert.deepEqual(validated.delivery_receipt.document.assigned_subject_refs, [
    "concept-hypothesis.json",
  ]);
  assert.ok(
    (validated.delivery_receipt.document.required_artifacts as Record<string, unknown>[]).some(
      (artifact) => artifact.artifact_path === state.branch.outputPath,
    ),
  );
  const scopeClosure = validated.delivery_receipt.document.scope_formal_closure as Record<
    string,
    unknown
  >[];
  const dimensionClosure = scopeClosure.find(
    (entry) => entry.scope_key === state.branch.dimensionId,
  );
  assert.ok(dimensionClosure);
  assert.equal(dimensionClosure.disposition, "covered");
  assert.deepEqual(
    (dimensionClosure.evidence_bindings as Record<string, unknown>[]).map((entry) => ({
      evidence_ref: entry.evidence_ref,
      content_hash: entry.content_hash,
      substrate_record_ref: entry.substrate_record_ref,
    })),
    receipts
      .map((receipt) => ({
        evidence_ref: receipt.envelope.artifact_path,
        content_hash: receipt.envelope.content_hash,
        substrate_record_ref: receipt.ref,
      }))
      .sort((left, right) => left.evidence_ref.localeCompare(right.evidence_ref)),
  );
  assert.ok(
    (dimensionClosure.semantic_bindings as Record<string, unknown>[]).some(
      (entry) =>
        entry.artifact_ref === state.branch.outputPath &&
        entry.content_hash ===
          validated.compilation.compiled_envelopes.find(
            (envelope) => envelope.artifact_path === state.branch.outputPath,
          )?.content_hash &&
        entry.semantic_identity === `dimension:${state.branch.dimensionId}`,
    ),
  );

  const publish = structuredClone(staging);
  publish.operation = "publish";
  (publish as typeof publish & { publication_plan: unknown }).publication_plan =
    validated.compilation.publication_plan;
  const published = await materializer.materialize(publish);
  assert.equal(published.compilation.status, "published");
  assert.deepEqual(
    published.compilation.compiled_envelopes,
    validated.compilation.compiled_envelopes,
  );
  const currentContext = await state.store.buildValidationContext(
    String(state.task.run_id),
    {
      schema_version: "startup_opportunity.document_bundle.current",
      documents: [
        {
          path: "manifest.json",
          document: (await state.store.status(String(state.task.run_id))).manifest,
        },
      ],
      exact_records: [],
    },
    { includeAllFormalArtifacts: true },
  );
  const tamperedBundle = structuredClone(currentContext.bundle);
  const tamperedReceiptEntry = tamperedBundle.documents.find(
    (entry) => entry.path === published.delivery_receipt.artifact_path,
  );
  assert.ok(tamperedReceiptEntry);
  const tamperedReceipt = tamperedReceiptEntry.document as unknown as FormalArtifactEnvelope;
  const tamperedClosure = tamperedReceipt.document.scope_formal_closure as Record<
    string,
    unknown
  >[];
  assert.ok(tamperedClosure[0]);
  tamperedClosure[0].semantic_bindings = [];
  (tamperedReceipt as { content_hash: string }).content_hash = canonicalContentHash(
    tamperedReceipt.document,
  );
  const tamperedValidation = state.validator.validateDocumentBundle(
    tamperedBundle,
    currentContext.referenceContext,
  );
  assert.equal(tamperedValidation.valid, false);
  assert.ok(
    tamperedValidation.referenceErrors.some(
      (entry) => entry.code === "runtime.lane_delivery_scope_closure_mismatch",
    ),
  );
  const tamperedCoverageBundle = structuredClone(currentContext.bundle);
  const tamperedCoverageReceiptEntry = tamperedCoverageBundle.documents.find(
    (entry) => entry.path === published.delivery_receipt.artifact_path,
  );
  assert.ok(tamperedCoverageReceiptEntry);
  const tamperedCoverageReceipt =
    tamperedCoverageReceiptEntry.document as unknown as FormalArtifactEnvelope;
  const tamperedCoverage = tamperedCoverageReceipt.document.scope_coverage as Record<
    string,
    unknown
  >[];
  assert.ok(tamperedCoverage[0]);
  tamperedCoverage[0].status =
    tamperedCoverage[0].status === "not_applicable" ? "partial" : "not_applicable";
  (tamperedCoverageReceipt as { content_hash: string }).content_hash = canonicalContentHash(
    tamperedCoverageReceipt.document,
  );
  const tamperedCoverageValidation = state.validator.validateDocumentBundle(
    tamperedCoverageBundle,
    currentContext.referenceContext,
  );
  assert.equal(tamperedCoverageValidation.valid, false);
  assert.ok(
    tamperedCoverageValidation.referenceErrors.some(
      (entry) => entry.code === "runtime.lane_delivery_scope_coverage_mismatch",
    ),
  );
  const branch = published.compilation.compiled_envelopes.find(
    (envelope) => envelope.artifact_path === state.branch.outputPath,
  );
  assert.ok(branch);
  assert.equal(branch.document.branch_id, `branch_${state.branch.unitId}`);
  assert.ok(
    branch.input_refs.includes(
      pathByLegacyRef.get(`evidence/source-manifests/${state.branch.unitId}.json`) ?? "",
    ),
  );
  assert.ok(
    branch.input_refs.includes(pathByLegacyRef.get(`insights/${state.branch.unitId}.json`) ?? ""),
  );
  const replay = await materializer.materialize(publish);
  assert.equal(replay.compilation.status, "idempotent_replay");
  const reopened = await new RunStore(state.runsRoot, state.validator).load(
    String(state.task.run_id),
  );
  assert.ok(reopened.manifest.artifact_refs.includes(state.branch.outputPath));
  assert.ok(reopened.manifest.artifact_refs.includes(published.delivery_receipt.artifact_path));
  const reopenedReceipt = JSON.parse(
    await readFile(path.join(state.runRoot, published.delivery_receipt.artifact_path), "utf8"),
  ) as FormalArtifactEnvelope;
  assert.deepEqual(
    reopenedReceipt.document.scope_coverage,
    published.delivery_receipt.document.scope_coverage,
  );
  assert.equal(
    (reopenedReceipt.document.scope_coverage as Record<string, unknown>[]).find(
      (entry) => entry.scope_key === state.branch.dimensionId,
    )?.status,
    "covered",
  );
});

test("four synthetic branches publish Evidence -> Claim -> Finding -> Insight and reopen", async (context) => {
  const state = await publishVerticalFixture(context);
  const manifestBefore = JSON.parse(
    await readFile(path.join(state.runRoot, "manifest.json"), "utf8"),
  ) as {
    active_units: string[];
    completed_units: string[];
    checkpoint_ref: string;
  };
  assert.deepEqual(manifestBefore.active_units, []);
  assert.deepEqual(
    manifestBefore.completed_units,
    G12_BRANCHES.map((branch) => branch.unitId).sort(),
  );
  assert.equal(manifestBefore.checkpoint_ref, "checkpoints/checkpoint-g1-2-vertical.json");

  for (const pair of state.records.values()) {
    for (const record of pair) {
      assert.equal(record.schema_version, "startup_opportunity.evidence_store_record.v2");
      assert.equal(
        await readFile(path.join(state.runRoot, record.raw_content_ref), "utf8").then((contents) =>
          contents.startsWith("SYNTHETIC CONTRACT FIXTURE"),
        ),
        true,
      );
      const exact = await new EvidenceStore(state.runsRoot).readExactRecord(
        G12_RUN_ID,
        `evidence/manifest.jsonl#${record.evidence_id}`,
      );
      assert.deepEqual(exact, record);
    }
  }

  const reopened = await state.store.load(G12_RUN_ID);
  assert.equal(reopened.lastValidCheckpointRef, "checkpoints/checkpoint-g1-2-vertical.json");
  assert.deepEqual(reopened.manifest.active_units, []);
  assert.deepEqual(reopened.manifest.completed_units, manifestBefore.completed_units);
  assert.equal(reopened.orphanActiveUnits.length, 0);
});

test("research task publication is pending-to-active only and exact replay preserves completion", async (context) => {
  const state = await publishVerticalFixture(context);
  const task = state.tasks[0];
  assert.ok(task);
  const replay = await state.store.publishArtifact({ runId: G12_RUN_ID, envelope: task });
  assert.equal(replay.status, "idempotent_replay");
  const afterReplay = await state.store.load(G12_RUN_ID);
  assert.deepEqual(afterReplay.manifest.active_units, []);
  assert.ok(afterReplay.manifest.completed_units.includes(String(task.document.unit_id)));

  const lateAttempt = structuredClone(task);
  (lateAttempt as unknown as Record<string, unknown>).artifact_path =
    `tasks/${String(task.document.unit_id)}.attempt-2.json`;
  lateAttempt.document.task_id = `${String(task.document.task_id)}_attempt_2`;
  lateAttempt.document.attempt = 2;
  lateAttempt.document.supersedes_task_ref = task.artifact_path;
  (lateAttempt as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
    lateAttempt.document,
  );
  await assert.rejects(
    state.store.publishArtifact({ runId: G12_RUN_ID, envelope: lateAttempt }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.task_transition_invalid",
  );
  const afterRejectedAttempt = await state.store.load(G12_RUN_ID);
  assert.deepEqual(afterRejectedAttempt.manifest.active_units, []);
  assert.deepEqual(
    afterRejectedAttempt.manifest.completed_units,
    afterReplay.manifest.completed_units,
  );

  const recoveryState = await setup(context);
  const base = await baseFixture();
  const recoveryBranch = G12_BRANCHES[0];
  assert.ok(recoveryBranch);
  await publishInitialPlanBundle(
    recoveryState.store,
    G12_RUN_ID,
    initialFixtureEnvelopes(base, [recoveryBranch]),
    "assessment",
  );
  const recoveryTask = taskEnvelope(base, recoveryBranch, 2);
  const recoveryWave = [
    executionPlanEnvelope(base, [recoveryBranch]),
    dispatchEnvelope(base, [recoveryBranch]),
    recoveryTask,
  ];
  const publishedWave = await recoveryState.store.publishArtifactBundle({
    runId: G12_RUN_ID,
    envelopes: recoveryWave,
  });
  assert.equal(publishedWave.status, "published");
  const replayedWave = await recoveryState.store.publishArtifactBundle({
    runId: G12_RUN_ID,
    envelopes: recoveryWave,
  });
  assert.equal(replayedWave.status, "idempotent_replay");
  const recovered = await recoveryState.store.load(G12_RUN_ID);
  assert.ok(recovered.manifest.active_units.includes(String(recoveryTask.document.unit_id)));
  assert.ok(recovered.manifest.artifact_refs.includes(recoveryTask.artifact_path));
});

test("v2 Evidence Store canonicalizes public URL, supports user origin, dedups raw bytes, and replays", async (context) => {
  const { runsRoot } = await setup(context, "run_g1_2_evidence_001");
  const store = new EvidenceStore(runsRoot);
  const common = {
    runId: "run_g1_2_evidence_001",
    unitId: "unit_synthetic",
    acquisitionGoal: "Exercise the synthetic v2 identity contract.",
    rawContent: "SYNTHETIC SHARED BYTES",
    recordedAt: "2026-07-24T20:10:00Z",
  } as const;
  const first = await store.record({
    ...common,
    source: { kind: "public_url", canonical_url: "https://synthetic.invalid/a#fragment" },
  });
  const replay = await store.record({
    ...common,
    source: { kind: "public_url", canonical_url: "https://synthetic.invalid/a" },
  });
  const user = await store.record({
    ...common,
    source: {
      kind: "user_provided",
      canonical_uri: "urn:startup-opportunity:user-provided:shared-bytes",
    },
  });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(first.record.source.kind, "public_url");
  assert.notEqual(first.record.evidence_id, user.record.evidence_id);
  assert.equal(first.record.raw_content_ref, user.record.raw_content_ref);
  await assert.rejects(
    store.record({
      ...common,
      source: { kind: "user_provided", canonical_uri: "urn:unreserved:fixture" },
    }),
    (error: unknown) => error instanceof StoreError && error.code === "evidence.invalid_source",
  );
});

test("research chain rejects substrate drift, cross-task lineage, and cross-unit retry", async (context) => {
  const state = await publishVerticalFixture(context);
  const firstBranch = state.branchBundles[0];
  assert.ok(firstBranch);
  const evidence = structuredClone(
    firstBranch.find(
      (entry) => entry.artifact_type === "startup_opportunity.evidence.assessment.current",
    ),
  );
  assert.ok(evidence);
  const binding = evidence.document.mechanical_binding as Record<string, unknown>;
  binding.source_hash = `sha256:${"0".repeat(64)}`;
  (evidence as unknown as Record<string, unknown>).content_hash = (
    await import("../harness/src/index.js")
  ).canonicalContentHash(evidence.document);
  const invalidBundle = {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      ...state.initial.map((entry) => ({ path: entry.artifact_path, document: entry })),
      ...state.tasks.map((entry) => ({ path: entry.artifact_path, document: entry })),
      ...state.branchBundles.flat().map((entry) => ({
        path: entry.artifact_path,
        document: entry.artifact_path === evidence.artifact_path ? evidence : entry,
      })),
    ],
    exact_records: [...state.records.values()].flatMap((pair) =>
      pair.map((record) => ({
        ref: `evidence/manifest.jsonl#${record.evidence_id}`,
        document: record,
      })),
    ),
  };
  const invalid = state.validator.validateDocumentBundle(invalidBundle);
  assert.equal(invalid.valid, false);
  assert.ok(
    invalid.referenceErrors.some((issue) => issue.code === "research_contract.substrate_mismatch"),
  );
  const crossTaskClaim = structuredClone(
    firstBranch.find(
      (entry) => entry.artifact_type === "startup_opportunity.claim.assessment.current",
    ),
  );
  assert.ok(crossTaskClaim);
  (crossTaskClaim.document.lineage as Record<string, unknown>).task_ref =
    "tasks/unit_alternatives.attempt-1.json";
  (crossTaskClaim as unknown as Record<string, unknown>).content_hash = (
    await import("../harness/src/index.js")
  ).canonicalContentHash(crossTaskClaim.document);
  const crossLineageBundle = structuredClone(invalidBundle);
  const claimEntry = crossLineageBundle.documents.find(
    (entry) => entry.path === crossTaskClaim.artifact_path,
  );
  assert.ok(claimEntry);
  claimEntry.document = crossTaskClaim;
  const crossLineage = state.validator.validateDocumentBundle(crossLineageBundle);
  assert.equal(crossLineage.valid, false);
  assert.ok(
    crossLineage.referenceErrors.some(
      (issue) => issue.code === "research_contract.lineage_mismatch",
    ),
  );

  const crossUnitRetry = structuredClone(state.tasks[0]);
  assert.ok(crossUnitRetry);
  (crossUnitRetry as unknown as Record<string, unknown>).artifact_path =
    `tasks/${String(crossUnitRetry.document.unit_id)}.attempt-2.json`;
  crossUnitRetry.document.task_id = `${String(crossUnitRetry.document.task_id)}_attempt_2`;
  crossUnitRetry.document.attempt = 2;
  crossUnitRetry.document.supersedes_task_ref = state.tasks[1]?.artifact_path;
  (crossUnitRetry as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
    crossUnitRetry.document,
  );
  const crossUnitRetryBundle = structuredClone(invalidBundle);
  crossUnitRetryBundle.documents.push({
    path: crossUnitRetry.artifact_path,
    document: crossUnitRetry,
  });
  const invalidRetry = state.validator.validateDocumentBundle(crossUnitRetryBundle);
  assert.equal(invalidRetry.valid, false);
  assert.ok(
    invalidRetry.referenceErrors.some(
      (issue) => issue.code === "research_contract.task_supersede_mismatch",
    ),
  );
});

test("research chain closes formal input refs and Source Manifest Evidence coverage", async (context) => {
  const state = await publishVerticalFixture(context);
  const documents = [
    ...state.initial,
    state.dispatch,
    ...state.tasks,
    ...state.branchBundles.flat(),
  ].map((entry) => ({ path: entry.artifact_path, document: structuredClone(entry) }));
  const exactRecords = [...state.records.values()].flatMap((pair) =>
    pair.map((record) => ({
      ref: `evidence/manifest.jsonl#${record.evidence_id}`,
      document: record,
    })),
  );
  const validBundle = {
    schema_version: "startup_opportunity.document_bundle.current",
    documents,
    exact_records: exactRecords,
  };
  assert.equal(state.validator.validateDocumentBundle(validBundle).valid, true);

  const missingEnvelopeInput = structuredClone(validBundle);
  const claimEnvelope = missingEnvelopeInput.documents.find(
    (entry) =>
      entry.document.artifact_type === "startup_opportunity.claim.assessment.current" &&
      entry.document.document.stance === "support",
  );
  assert.ok(claimEnvelope);
  const mutableClaimEnvelope = claimEnvelope.document as unknown as {
    input_refs: string[];
    document: { lineage: { task_ref: string } };
  };
  mutableClaimEnvelope.input_refs = [mutableClaimEnvelope.document.lineage.task_ref];
  const inputDrift = state.validator.validateDocumentBundle(missingEnvelopeInput);
  assert.equal(inputDrift.valid, false);
  assert.ok(
    inputDrift.referenceErrors.some(
      (entry) => entry.code === "research_contract.input_ref_missing",
    ),
  );

  const incompleteSourceManifest = structuredClone(validBundle);
  const sourceManifestEnvelope = incompleteSourceManifest.documents.find(
    (entry) =>
      entry.path === "evidence/source-manifests/unit_demand.json" &&
      entry.document.artifact_type === "startup_opportunity.source_manifest.assessment.current",
  );
  assert.ok(sourceManifestEnvelope);
  const accepted = sourceManifestEnvelope.document.document.accepted_evidence_refs as string[];
  sourceManifestEnvelope.document.document.accepted_evidence_refs = accepted.slice(1);
  (sourceManifestEnvelope.document as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(sourceManifestEnvelope.document.document);
  const sourceDrift = state.validator.validateDocumentBundle(incompleteSourceManifest);
  assert.equal(sourceDrift.valid, false);
  assert.ok(
    sourceDrift.referenceErrors.some(
      (entry) => entry.code === "research_contract.source_manifest_incomplete",
    ),
  );

  const brokenChain = structuredClone(validBundle);
  const demandFinding = brokenChain.documents.find(
    (entry) => entry.path === "findings/unit_demand.json",
  );
  const demandBranch = brokenChain.documents.find(
    (entry) => entry.path === "artifacts/lanes/demand.json",
  );
  assert.ok(demandFinding);
  assert.ok(demandBranch);
  const orphanFinding = structuredClone(demandFinding);
  orphanFinding.path = "findings/unit_demand-orphan.json";
  (orphanFinding.document as unknown as Record<string, unknown>).artifact_path = orphanFinding.path;
  orphanFinding.document.document.finding_id = "finding_unit_demand_orphan";
  (orphanFinding.document as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(orphanFinding.document.document);
  brokenChain.documents.push(orphanFinding);
  demandBranch.document.document.finding_refs = [orphanFinding.path];
  (demandBranch.document as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
    demandBranch.document.document,
  );
  const chainDrift = state.validator.validateDocumentBundle(brokenChain);
  assert.equal(chainDrift.valid, false);
  assert.ok(
    chainDrift.referenceErrors.some(
      (entry) => entry.code === "research_contract.branch_chain_incomplete",
    ),
  );

  const falseNoEvidence = structuredClone(validBundle);
  const falseNoEvidenceBranch = falseNoEvidence.documents.find(
    (entry) => entry.path === "artifacts/lanes/demand.json",
  );
  assert.ok(falseNoEvidenceBranch);
  falseNoEvidenceBranch.document.document.coverage_disposition = "no_evidence_found";
  falseNoEvidenceBranch.document.document.evidence_refs = [];
  (falseNoEvidenceBranch.document as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(falseNoEvidenceBranch.document.document);
  const falseNoEvidenceResult = state.validator.validateDocumentBundle(falseNoEvidence);
  assert.equal(falseNoEvidenceResult.valid, false);
  assert.ok(
    falseNoEvidenceResult.referenceErrors.some(
      (entry) => entry.code === "research_contract.branch_coverage_evidence_invalid",
    ),
  );

  for (const [coverageDisposition, expectedInvalid] of [
    ["covered", true],
    ["no_evidence_found", true],
    ["partial", false],
  ] as const) {
    const blockedBundle = structuredClone(validBundle);
    const blockedBranch = blockedBundle.documents.find(
      (entry) => entry.path === "artifacts/lanes/demand.json",
    );
    assert.ok(blockedBranch);
    blockedBranch.document.document.coverage_disposition = coverageDisposition;
    blockedBranch.document.document.dimension_decision = "insufficient_evidence";
    blockedBranch.document.document.decision_sufficiency = "blocked";
    blockedBranch.document.document.insufficiency_reasons = ["source_unavailable"];
    (blockedBranch.document as unknown as Record<string, unknown>).content_hash =
      canonicalContentHash(blockedBranch.document.document);
    const blockedResult = state.validator.validateDocumentBundle(blockedBundle);
    assert.equal(
      blockedResult.referenceErrors.some(
        (entry) => entry.code === "research_contract.branch_coverage_disposition_invalid",
      ),
      expectedInvalid,
    );
  }

  const partialSufficient = structuredClone(validBundle);
  const partialSufficientBranch = partialSufficient.documents.find(
    (entry) => entry.path === "artifacts/lanes/demand.json",
  );
  const partialSufficientJudgment = partialSufficient.documents.find(
    (entry) => entry.path === "judgments/judgment-demand.json",
  );
  assert.ok(partialSufficientBranch);
  assert.ok(partialSufficientJudgment);
  partialSufficientBranch.document.document.branch_status = "partial";
  partialSufficientBranch.document.document.coverage_disposition = "partial";
  partialSufficientBranch.document.document.dimension_decision = "opposes";
  partialSufficientBranch.document.document.decision_sufficiency = "sufficient";
  partialSufficientBranch.document.document.insufficiency_reasons = [];
  partialSufficientJudgment.document.document.judgment_signal = "opposed";
  partialSufficientJudgment.document.document.supporting_claim_refs = [];
  partialSufficientJudgment.document.document.opposing_claim_refs = ["claim_unit_demand_oppose"];
  partialSufficientJudgment.document.document.decision_sufficiency = "sufficient";
  partialSufficientJudgment.document.document.insufficiency_reasons = [];
  (partialSufficientBranch.document as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(partialSufficientBranch.document.document);
  (partialSufficientJudgment.document as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(partialSufficientJudgment.document.document);
  const partialSufficientResult = state.validator.validateDocumentBundle(partialSufficient);
  assert.equal(partialSufficientResult.valid, true, JSON.stringify(partialSufficientResult));

  const crossRun = structuredClone(validBundle);
  const crossRunClaim = crossRun.documents.find(
    (entry) => entry.path === "claims/unit_demand-support.json",
  );
  assert.ok(crossRunClaim);
  crossRunClaim.document.document.run_id = "run_g1_2_foreign_001";
  (crossRunClaim.document as unknown as Record<string, unknown>).run_id = "run_g1_2_foreign_001";
  (crossRunClaim.document as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(crossRunClaim.document.document);
  const crossRunResult = state.validator.validateDocumentBundle(crossRun);
  assert.equal(crossRunResult.valid, false);
  assert.ok(
    crossRunResult.referenceErrors.some((entry) => entry.code === "reference.run_mismatch"),
  );

  const crossAttempt = structuredClone(validBundle);
  const crossAttemptClaim = crossAttempt.documents.find(
    (entry) => entry.path === "claims/unit_demand-support.json",
  );
  assert.ok(crossAttemptClaim);
  (crossAttemptClaim.document.document.lineage as Record<string, unknown>).attempt = 2;
  (crossAttemptClaim.document as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(crossAttemptClaim.document.document);
  const crossAttemptResult = state.validator.validateDocumentBundle(crossAttempt);
  assert.equal(crossAttemptResult.valid, false);
  assert.ok(
    crossAttemptResult.referenceErrors.some(
      (entry) => entry.code === "research_contract.lineage_mismatch",
    ),
  );

  const duplicateIdentity = structuredClone(validBundle);
  const duplicatedEvidence = structuredClone(
    duplicateIdentity.documents.find(
      (entry) => entry.document.artifact_type === "startup_opportunity.evidence.assessment.current",
    ),
  );
  assert.ok(duplicatedEvidence);
  duplicatedEvidence.path = `evidence/records/ev_${"f".repeat(64)}.json`;
  (duplicatedEvidence.document as unknown as Record<string, unknown>).artifact_path =
    duplicatedEvidence.path;
  duplicateIdentity.documents.push(duplicatedEvidence);
  const duplicateIdentityResult = state.validator.validateDocumentBundle(duplicateIdentity);
  assert.equal(duplicateIdentityResult.valid, false);
  assert.ok(
    duplicateIdentityResult.referenceErrors.some(
      (entry) => entry.code === "research_contract.duplicate_identity",
    ),
  );

  const duplicatePath = structuredClone(validBundle);
  const duplicatedClaim = structuredClone(
    duplicatePath.documents.find((entry) => entry.path === "claims/unit_demand-support.json"),
  );
  assert.ok(duplicatedClaim);
  duplicatedClaim.document.document.claim_id = "claim_unit_demand_support_duplicate";
  (duplicatedClaim.document as unknown as Record<string, unknown>).content_hash =
    canonicalContentHash(duplicatedClaim.document.document);
  duplicatePath.documents.push(duplicatedClaim);
  const duplicatePathResult = state.validator.validateDocumentBundle(duplicatePath);
  assert.equal(duplicatePathResult.valid, false);
  assert.ok(
    duplicatePathResult.referenceErrors.some((entry) => entry.code === "reference.duplicate_path"),
  );
});

test("partial and failed branches produce stable terminal Manifest classifications", async (context) => {
  for (const [status, expectedField] of [
    ["partial", "completed_units"],
    ["failed", "failed_units"],
  ] as const) {
    await context.test(status, async (child) => {
      const state = await prepareSingleBranch(child);
      const envelopes = structuredClone(state.envelopes);
      const branchEnvelope = envelopes.find(
        (entry) =>
          entry.artifact_type ===
          "startup_opportunity.concept_evidence_assessment_branch_result.v1",
      );
      assert.ok(branchEnvelope);
      (branchEnvelope.document as Record<string, unknown>).branch_status = status;
      (branchEnvelope as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
        branchEnvelope.document,
      );
      await state.store.publishArtifactBundle({ runId: G12_RUN_ID, envelopes });
      const reopened = await state.store.load(G12_RUN_ID);
      assert.ok(reopened.manifest[expectedField].includes(state.branch.unitId));
      assert.ok(!reopened.manifest.active_units.includes(state.branch.unitId));
    });
  }
});

test("active branch cannot self-authorize superseded or ignored-late state", async (context) => {
  for (const status of ["superseded_by_adaptation", "ignored_late"] as const) {
    await context.test(status, async (child) => {
      const state = await prepareSingleBranch(child);
      const envelopes = structuredClone(state.envelopes);
      const branchEnvelope = envelopes.find(
        (entry) =>
          entry.artifact_type ===
          "startup_opportunity.concept_evidence_assessment_branch_result.v1",
      );
      assert.ok(branchEnvelope);
      (branchEnvelope.document as Record<string, unknown>).branch_status = status;
      (branchEnvelope as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
        branchEnvelope.document,
      );
      const before = await snapshotTree(state.runRoot);
      await assert.rejects(
        state.store.publishArtifactBundle({ runId: G12_RUN_ID, envelopes }),
        (error: unknown) =>
          error instanceof StoreError && error.code === "artifact.branch_transition_invalid",
      );
      assert.deepEqual(await snapshotTree(state.runRoot), before);
    });
  }
});

test("existing superseded and invalidated units keep late Branch results out of current refs", async (context) => {
  for (const [branchStatus, stateField] of [
    ["superseded_by_adaptation", "superseded_units"],
    ["ignored_late", "invalidated_units"],
  ] as const) {
    await context.test(branchStatus, async (child) => {
      const state = await prepareSingleBranch(child);
      const manifestPath = path.join(state.runRoot, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      const statusFields = [
        "completed_units",
        "active_units",
        "failed_units",
        "invalidated_units",
        "skipped_units",
        "cancelled_units",
        "superseded_units",
      ];
      for (const field of statusFields) {
        manifest[field] = field === stateField ? [state.branch.unitId] : [];
      }
      manifest.updated_at = "2026-07-24T20:30:00Z";
      await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
      await state.store.checkpoint({
        runId: G12_RUN_ID,
        checkpointId: `checkpoint_${branchStatus}`,
        createdAt: "2026-07-24T20:31:00Z",
        nextStep: "Keep the synthetic late Branch Result outside the current artifact set.",
        beliefSummary: {
          current_belief: "Only the late-result classification contract is under test.",
          evidence_that_changed_belief: [],
          unchanged_assumptions: ["No market Evidence was collected."],
          remaining_disagreement: [],
          next_decision_relevant_question: "Does reopen preserve late-result classification?",
        },
      });
      const envelopes = structuredClone(state.envelopes);
      const branchEnvelope = envelopes.find(
        (entry) =>
          entry.artifact_type ===
          "startup_opportunity.concept_evidence_assessment_branch_result.v1",
      );
      assert.ok(branchEnvelope);
      (branchEnvelope.document as Record<string, unknown>).branch_status = branchStatus;
      (branchEnvelope as unknown as Record<string, unknown>).content_hash = canonicalContentHash(
        branchEnvelope.document,
      );
      await state.store.publishArtifactBundle({ runId: G12_RUN_ID, envelopes });
      const afterPublish = await state.store.load(G12_RUN_ID);
      assert.ok(afterPublish.manifest[stateField].includes(state.branch.unitId));
      assert.ok(!afterPublish.manifest.artifact_refs.includes(state.branch.outputPath));
      assert.ok(afterPublish.manifest.ignored_late_artifact_refs.includes(state.branch.outputPath));
      const beforeReplay = await snapshotTree(state.runRoot);
      const replay = await state.store.publishArtifactBundle({ runId: G12_RUN_ID, envelopes });
      assert.equal(replay.status, "idempotent_replay");
      assert.deepEqual(await snapshotTree(state.runRoot), beforeReplay);
      const reopened = await state.store.load(G12_RUN_ID);
      assert.ok(!reopened.manifest.artifact_refs.includes(state.branch.outputPath));
      assert.ok(reopened.manifest.ignored_late_artifact_refs.includes(state.branch.outputPath));
    });
  }
});

test("Evidence receipt cross-task drift fails reopen before any recovery write", async (context) => {
  const { runsRoot, runRoot, store } = await setup(context, "run_g1_2_receipt_drift_001");
  const evidence = new EvidenceStore(runsRoot);
  const recorded = await evidence.record({
    runId: "run_g1_2_receipt_drift_001",
    unitId: "unit_receipt_original",
    acquisitionGoal: "Synthetic receipt drift contract only.",
    source: { kind: "public_url", canonical_url: "https://synthetic.invalid/receipt-drift" },
    rawContent: "SYNTHETIC RECEIPT DRIFT BYTES",
    recordedAt: "2026-07-24T20:10:00Z",
  });
  const operationEntry = (await readdir(path.join(runRoot, ".store/operations"))).find((entry) =>
    entry.startsWith("evidence-"),
  );
  assert.ok(operationEntry);
  const receiptPath = path.join(runRoot, ".store/operations", operationEntry);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    record: { unit_id: string; evidence_id: string };
  };
  assert.equal(receipt.record.evidence_id, recorded.record.evidence_id);
  receipt.record.unit_id = "unit_receipt_foreign";
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  const before = await snapshotTree(runRoot);
  await assert.rejects(
    store.load("run_g1_2_receipt_drift_001"),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "recovery.invalid_operation" &&
      error.details.cause === "evidence.invalid_record",
  );
  assert.deepEqual(await snapshotTree(runRoot), before);
});

test("v2 Evidence receipt recovers raw publication after an injected crash", async (context) => {
  const { runsRoot, store } = await setup(context, "run_g1_2_fault_001");
  const evidence = new EvidenceStore(runsRoot);
  await assert.rejects(
    evidence.record({
      runId: "run_g1_2_fault_001",
      unitId: "unit_fault",
      acquisitionGoal: "Synthetic fault recovery only.",
      source: {
        kind: "public_url",
        canonical_url: "https://synthetic.invalid/fault",
      },
      rawContent: "SYNTHETIC FAULT BYTES",
      recordedAt: "2026-07-24T20:10:00Z",
      faultAt: "after_intent",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await store.load("run_g1_2_fault_001");
  assert.equal(reopened.evidenceRecovery.replayedEvidenceIds.length, 1);
  assert.equal(reopened.evidenceRecovery.recoveredRawContentRefs.length, 1);
  const manifest = await readFile(
    path.join(runsRoot, "run_g1_2_fault_001/evidence/manifest.jsonl"),
    "utf8",
  );
  assert.match(manifest, /startup_opportunity\.evidence_store_record\.v2/);
});

test("current Artifact receipt recovers immutable publication after temp-write crash", async (context) => {
  const { runRoot, store } = await setup(context, "run_g1_2_artifact_fault_001");
  const document = {
    schema_version: "startup_opportunity.event.v1",
    event_id: "g1_2_artifact_fault_001",
    run_id: "run_g1_2_artifact_fault_001",
    event_type: "decision_context_written",
    timestamp: "2026-07-24T20:10:00Z",
    actor: "harness",
    reason: "Synthetic current Artifact fault fixture.",
    artifact_refs: [],
  };
  const faultEnvelope = {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: document.schema_version,
    artifact_path: "artifacts/g1-2-fault-event.json",
    run_id: document.run_id,
    created_at: document.timestamp,
    producer_role: "harness",
    input_refs: [],
    content_hash: canonicalContentHash(document),
    document,
  } as const;
  await assert.rejects(
    store.publishArtifact({
      runId: document.run_id,
      envelope: faultEnvelope,
      faultAt: "after_temp_write",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const reopened = await store.load(document.run_id);
  assert.deepEqual(reopened.recoveredArtifactPaths, [faultEnvelope.artifact_path]);
  assert.ok(reopened.manifest.artifact_refs.includes(faultEnvelope.artifact_path));
  const operationReceipts = await readdir(path.join(runRoot, ".store/operations"));
  const receiptVersions = await Promise.all(
    operationReceipts
      .filter((entry) => entry.startsWith("artifact-"))
      .map(async (entry) =>
        JSON.parse(await readFile(path.join(runRoot, ".store/operations", entry), "utf8")),
      ),
  );
  assert.ok(
    receiptVersions.some(
      (receipt) =>
        receipt.schema_version === "startup_opportunity.artifact_store_operation.current",
    ),
  );
});

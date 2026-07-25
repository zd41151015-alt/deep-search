import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  canonicalContentHash,
  canonicalJson,
  createArtifactValidator,
  EvidenceStore,
  type FormalArtifactEnvelope,
  type ReportFaultBoundary,
  ReportRuntime,
  RunStore,
  StoreError,
} from "../harness/src/index.js";
import { branchResearchEnvelopes } from "./fixtures/g1.2/research-branch-fixture.js";
import {
  createG14ContractBundle,
  G14_ASSESSMENT_REF,
  G14_AUDIT_REF,
  G14_REPORT_REF,
  G14_REVIEW_REF,
  G14_RUN_ID,
  G14_TRACEABILITY_REF,
  g14Branches,
  replaceG14EvidenceRecords,
} from "./fixtures/g1.4/assessment-report-fixture.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function effective(entry: Record<string, unknown>): Record<string, unknown> {
  return String(entry.schema_version).startsWith("startup_opportunity.artifact_envelope.") &&
    isRecord(entry.document)
    ? entry.document
    : entry;
}

function documentAt(
  bundle: Awaited<ReturnType<typeof createG14ContractBundle>>,
  artifactPath: string,
): Record<string, unknown> {
  const value = bundle.documents.find((entry) => entry.path === artifactPath)?.document;
  assert.ok(value, `missing fixture path ${artifactPath}`);
  return effective(value);
}

function v5Envelope(
  artifactPath: string,
  document: Record<string, unknown>,
  producerRole = "main_agent",
  inputRefs: readonly string[] = [],
  createdAt = "2026-07-25T18:10:00Z",
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.v5",
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    run_id: G14_RUN_ID,
    created_at: createdAt,
    producer_role: producerRole,
    input_refs: [...new Set(inputRefs)].sort(),
    content_hash: canonicalContentHash(document),
    document,
  };
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

interface PreparedRun {
  readonly runsRoot: string;
  readonly runRoot: string;
  readonly store: RunStore;
  readonly runtime: ReportRuntime;
  readonly reportEnvelope: FormalArtifactEnvelope;
}

async function prepareRun(context: TestContext): Promise<PreparedRun> {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g1-4-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runRoot = path.join(runsRoot, G14_RUN_ID);
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await store.create({
    runId: G14_RUN_ID,
    mode: "concept_evidence_assessment",
    createdAt: "2026-07-25T18:00:00Z",
  });

  let bundle = await createG14ContractBundle("insufficient_evidence");
  const corePaths = [
    "intake.json",
    "decision-context.json",
    "scope-frame.json",
    "concept-hypothesis.json",
    "plans/research-plan.r1.json",
    "plans/concept-evidence-assessment-plan.r1.json",
    ...g14Branches().map((branch) => branch.judgmentRef),
  ];
  await store
    .publishArtifactBundle({
      runId: G14_RUN_ID,
      envelopes: corePaths.map((artifactPath) =>
        v5Envelope(artifactPath, documentAt(bundle, artifactPath)),
      ),
    })
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }));
      }
      throw error;
    });

  const branches = g14Branches();
  const demand = branches.find((branch) => branch.unitId === "unit_demand");
  assert.ok(demand);
  await store.publishArtifactBundle({
    runId: G14_RUN_ID,
    envelopes: branches.map((branch) => {
      const taskPath = `tasks/${branch.unitId}.attempt-1.json`;
      return v5Envelope(
        taskPath,
        documentAt(bundle, taskPath),
        "main_agent",
        [
          "concept-hypothesis.json",
          "scope-frame.json",
          "plans/research-plan.r1.json",
          "plans/concept-evidence-assessment-plan.r1.json",
        ],
        "2026-07-25T18:11:00Z",
      );
    }),
  });

  const evidence = new EvidenceStore(runsRoot);
  let demandRecords:
    | readonly [
        Awaited<ReturnType<EvidenceStore["record"]>>["record"],
        Awaited<ReturnType<EvidenceStore["record"]>>["record"],
      ]
    | null = null;
  for (const [index, branch] of branches.entries()) {
    const taskPath = `tasks/${branch.unitId}.attempt-1.json`;
    const researchGoal = String(documentAt(bundle, taskPath).research_goal);
    const support = await evidence.record({
      runId: G14_RUN_ID,
      unitId: branch.unitId,
      researchGoal,
      source: {
        kind: "public_url",
        canonical_url: `https://${branch.unitId}.synthetic.invalid/support`,
      },
      rawContent: `SYNTHETIC G1.4 ${branch.unitId} SUPPORT BYTES; NOT MARKET EVIDENCE.`,
      recordedAt: `2026-07-25T18:${String(index * 2 + 1).padStart(2, "0")}:00Z`,
    });
    const oppose = await evidence.record({
      runId: G14_RUN_ID,
      unitId: branch.unitId,
      researchGoal,
      source: {
        kind: "user_provided",
        canonical_uri: `urn:startup-opportunity:user-provided:g1-4:${branch.unitId}:oppose`,
      },
      rawContent: `SYNTHETIC G1.4 ${branch.unitId} OPPOSING BYTES; NOT MARKET EVIDENCE.`,
      recordedAt: `2026-07-25T18:${String(index * 2 + 2).padStart(2, "0")}:00Z`,
    });
    const records = [support.record, oppose.record] as const;
    await store.publishArtifactBundle({
      runId: G14_RUN_ID,
      envelopes: branchResearchEnvelopes(branch, records, index).map((envelope) => ({
        ...envelope,
        created_at: `2026-07-25T18:${String(20 + index).padStart(2, "0")}:00Z`,
      })),
    });
    if (branch.unitId === demand.unitId) {
      demandRecords = records;
    }
  }
  assert.ok(demandRecords);
  bundle = replaceG14EvidenceRecords(
    bundle,
    demandRecords as Parameters<typeof replaceG14EvidenceRecords>[1],
  );

  await store.publishArtifactBundle({
    runId: G14_RUN_ID,
    envelopes: [
      "artifacts/synthesis/assessment-fan-in.json",
      "artifacts/synthesis/hypothesis-evidence-matrix.json",
      "artifacts/synthesis/business-engine.json",
    ].map((artifactPath) =>
      v5Envelope(
        artifactPath,
        documentAt(bundle, artifactPath),
        "main_agent",
        [
          "concept-hypothesis.json",
          "plans/research-plan.r1.json",
          "plans/concept-evidence-assessment-plan.r1.json",
          ...branches.map((branch) => branch.outputPath),
        ],
        "2026-07-25T18:40:00Z",
      ),
    ),
  });

  for (const artifactPath of [
    G14_AUDIT_REF,
    G14_REVIEW_REF,
    G14_ASSESSMENT_REF,
    G14_TRACEABILITY_REF,
  ]) {
    const source = bundle.documents.find((entry) => entry.path === artifactPath)?.document;
    assert.ok(source);
    await store.publishArtifact({
      runId: G14_RUN_ID,
      envelope: source as FormalArtifactEnvelope,
    });
  }
  const reportEnvelope = bundle.documents.find((entry) => entry.path === G14_REPORT_REF)?.document;
  assert.ok(reportEnvelope);
  return {
    runsRoot,
    runRoot,
    store,
    runtime: new ReportRuntime(runsRoot, validator),
    reportEnvelope: reportEnvelope as FormalArtifactEnvelope,
  };
}

test("build-report publishes formal sidecars, materializes three outputs, and exactly replays", async (context) => {
  const state = await prepareRun(context);
  const first = await state.runtime.build({ reportEnvelope: state.reportEnvelope });
  assert.equal(first.status, "published");
  assert.deepEqual(first.materializedPaths, ["report.json", "decision-brief.md", "report.md"]);
  const reportJson = JSON.parse(
    await readFile(path.join(state.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(reportJson.schema_version, "startup_opportunity.concept_evidence_report.v1");
  assert.equal(reportJson.materialized_path, "report.json");
  assert.match(
    await readFile(path.join(state.runRoot, "decision-brief.md"), "utf8"),
    /# Decision Brief/,
  );
  assert.match(
    await readFile(path.join(state.runRoot, "report.md"), "utf8"),
    /# Concept Evidence Assessment Report/,
  );
  const before = await snapshotTree(state.runRoot);
  const replay = await state.runtime.build({ reportEnvelope: state.reportEnvelope });
  assert.equal(replay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(state.runRoot), before);
  const checkpoint = await state.store.checkpoint({
    runId: G14_RUN_ID,
    checkpointId: "checkpoint_g1_4_report",
    createdAt: "2026-07-25T19:05:00Z",
    nextStep: "Independent whole-gate regression is required before G1 completion.",
    beliefSummary: {
      current_belief: "SYNTHETIC mechanical report contract is complete.",
      evidence_that_changed_belief: [G14_ASSESSMENT_REF, G14_TRACEABILITY_REF],
      unchanged_assumptions: ["No market or external validation is claimed."],
      remaining_disagreement: ["Real thesis viability remains outside this fixture."],
      next_decision_relevant_question: "Does independent G1 regression accept the candidate?",
    },
    inputRefs: first.formalArtifactPaths,
  });
  assert.equal(checkpoint.status, "published");
  const reopened = await state.store.load(G14_RUN_ID);
  assert.equal(reopened.manifest.schema_bundle_version, "6.0.0");
  assert.equal(reopened.lastValidCheckpointRef, "checkpoints/checkpoint-g1-4-report.json");
  assert.equal(reopened.reportRecovery.recoveredFormalArtifactPaths.length, 0);
  assert.equal(reopened.reportRecovery.recoveredMaterializedPaths.length, 0);
});

test("reopen completes every crash-interrupted report publication boundary", async (context) => {
  const boundaries: readonly ReportFaultBoundary[] = [
    "after_report_sidecar",
    "after_report_materialization",
    "after_brief_sidecar",
    "after_brief_materialization",
    "after_view_sidecar",
    "after_view_materialization",
    "after_consistency_sidecar",
  ];
  for (const faultAt of boundaries) {
    await context.test(faultAt, async (subcontext) => {
      const state = await prepareRun(subcontext);
      await assert.rejects(
        state.runtime.build({ reportEnvelope: state.reportEnvelope, faultAt }),
        (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
      );
      await state.store.load(G14_RUN_ID);
      for (const outputPath of ["report.json", "decision-brief.md", "report.md"]) {
        assert.ok((await readFile(path.join(state.runRoot, outputPath))).length > 0);
      }
      assert.equal(
        (await state.runtime.build({ reportEnvelope: state.reportEnvelope })).status,
        "idempotent_replay",
      );
    });
  }
});

test("wrong Run and final subject, scope, Plan, or assessment-plan lineage fail without writes", async (context) => {
  const state = await prepareRun(context);
  const cases: readonly {
    readonly name: string;
    readonly mutate: (envelope: FormalArtifactEnvelope) => void;
  }[] = [
    {
      name: "run",
      mutate: (envelope) => {
        envelope.document.run_id = "run_g1_4_other";
      },
    },
    {
      name: "subject",
      mutate: (envelope) => {
        envelope.document.concept_hypothesis_ref = "scope-frame.json";
      },
    },
    {
      name: "scope",
      mutate: (envelope) => {
        envelope.document.concept_frame_ref = "concept-hypothesis.json";
      },
    },
    {
      name: "research plan",
      mutate: (envelope) => {
        envelope.document.research_plan_ref = "plans/concept-evidence-assessment-plan.r1.json";
      },
    },
    {
      name: "assessment plan",
      mutate: (envelope) => {
        envelope.document.evidence_assessment_plan_ref = "plans/research-plan.r1.json";
      },
    },
  ];
  for (const candidateCase of cases) {
    await context.test(candidateCase.name, async () => {
      const candidate = structuredClone(state.reportEnvelope);
      candidateCase.mutate(candidate);
      const rehashed = {
        ...candidate,
        content_hash: canonicalContentHash(candidate.document),
      };
      const before = await snapshotTree(state.runRoot);
      await assert.rejects(
        state.runtime.build({ reportEnvelope: rehashed }),
        (error: unknown) => error instanceof StoreError,
      );
      assert.deepEqual(await snapshotTree(state.runRoot), before);
    });
  }
});

test("a different report envelope cannot replay into the same immutable path", async (context) => {
  const state = await prepareRun(context);
  await state.store.publishArtifact({
    runId: G14_RUN_ID,
    envelope: state.reportEnvelope,
  });
  const conflicting = structuredClone(state.reportEnvelope);
  const sections = conflicting.document.report_sections as Record<string, unknown>;
  sections.concept_hypothesis = [
    "SYNTHETIC conflicting report wording; this is not external validation.",
  ];
  const rehashed = {
    ...conflicting,
    content_hash: canonicalContentHash(conflicting.document),
  };
  const before = await snapshotTree(state.runRoot);
  await assert.rejects(
    state.runtime.build({ reportEnvelope: rehashed }),
    (error: unknown) => error instanceof StoreError && error.code === "write.conflict",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), before);
});

test("materialized, receipt, and stored sidecar drift fail closed without byte changes", async (context) => {
  await context.test("materialized output", async (subcontext) => {
    const state = await prepareRun(subcontext);
    await state.runtime.build({ reportEnvelope: state.reportEnvelope });
    await writeFile(path.join(state.runRoot, "report.md"), "DRIFTED REPORT BYTES\n");
    const before = await snapshotTree(state.runRoot);
    await assert.rejects(
      state.store.load(G14_RUN_ID),
      (error: unknown) =>
        error instanceof StoreError && error.code === "report.materialized_conflict",
    );
    assert.deepEqual(await snapshotTree(state.runRoot), before);
  });

  await context.test("materialization receipt", async (subcontext) => {
    const state = await prepareRun(subcontext);
    await state.runtime.build({ reportEnvelope: state.reportEnvelope });
    const operationDirectory = path.join(state.runRoot, ".store/operations");
    const receiptName = (await readdir(operationDirectory)).find((entry) =>
      entry.startsWith("report-"),
    );
    assert.ok(receiptName);
    const receiptPath = path.join(operationDirectory, receiptName);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    receipt.materialized_content_hash = `sha256:${"0".repeat(64)}`;
    await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
    const before = await snapshotTree(state.runRoot);
    await assert.rejects(
      state.store.load(G14_RUN_ID),
      (error: unknown) => error instanceof StoreError && error.code === "report.operation_conflict",
    );
    assert.deepEqual(await snapshotTree(state.runRoot), before);
  });

  await context.test("formal sidecar", async (subcontext) => {
    const state = await prepareRun(subcontext);
    await state.runtime.build({ reportEnvelope: state.reportEnvelope });
    const consistencyPath = path.join(
      state.runRoot,
      "artifacts/reporting/consistency-evaluation.r1.json",
    );
    const consistency = JSON.parse(await readFile(consistencyPath, "utf8")) as Record<
      string,
      unknown
    >;
    (consistency.document as Record<string, unknown>).valid_as_of = "2026-07-24";
    await writeFile(consistencyPath, `${canonicalJson(consistency)}\n`);
    const before = await snapshotTree(state.runRoot);
    await assert.rejects(
      state.store.load(G14_RUN_ID),
      (error: unknown) => error instanceof StoreError && error.code === "write.conflict",
    );
    assert.deepEqual(await snapshotTree(state.runRoot), before);
  });
});

test("build-report CLI consumes one explicit envelope and returns a structured result", async (context) => {
  const state = await prepareRun(context);
  const inputPath = path.join(path.dirname(state.runsRoot), "report-envelope.json");
  await writeFile(inputPath, `${canonicalJson(state.reportEnvelope)}\n`);
  const executed = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "build-report",
      "--file",
      inputPath,
      "--runs-root",
      state.runsRoot,
      "--json",
    ],
    { cwd: repositoryRoot },
  );
  const result = JSON.parse(executed.stdout) as Record<string, unknown>;
  assert.equal(result.schemaVersion, "startup_opportunity.build_report_result.v1");
  assert.equal(result.status, "published");
  assert.deepEqual(result.materializedPaths, ["report.json", "decision-brief.md", "report.md"]);
});

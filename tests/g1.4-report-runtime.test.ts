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
  deriveReportEnvelopes,
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
  readonly evidenceRef: string;
}

function nextReportRevision(source: FormalArtifactEnvelope): FormalArtifactEnvelope {
  const artifactPath = "artifacts/reporting/report-json.r2.json";
  const createdAt = "2026-07-25T19:10:00Z";
  const document = structuredClone(source.document);
  document.report_id = "concept_evidence_report_g1_4_synthetic_r2";
  document.owned_output_path = artifactPath;
  const metadata = document.report_metadata as Record<string, unknown>;
  metadata.generated_at = createdAt;
  const sections = document.report_sections as Record<string, unknown>;
  sections.concept_hypothesis = [
    "SYNTHETIC r2 report wording; this is not Evidence or external validation.",
  ];
  return {
    ...source,
    artifact_path: artifactPath,
    created_at: createdAt,
    content_hash: canonicalContentHash(document),
    document,
  };
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
    const evidencePaths = records.map((record) => `evidence/records/${record.evidence_id}.json`);
    await store.publishArtifactBundle({
      runId: G14_RUN_ID,
      envelopes: branchResearchEnvelopes(branch, records, index).map((envelope) => {
        const document = structuredClone(envelope.document);
        if (
          branch.unitId === demand.unitId &&
          envelope.artifact_type === "startup_opportunity.claim.v1"
        ) {
          document.evidence_refs = evidencePaths;
        }
        return {
          ...envelope,
          created_at: `2026-07-25T18:${String(20 + index).padStart(2, "0")}:00Z`,
          input_refs:
            branch.unitId === demand.unitId &&
            envelope.artifact_type === "startup_opportunity.claim.v1"
              ? [`tasks/${branch.unitId}.attempt-1.json`, ...evidencePaths].sort()
              : envelope.input_refs,
          content_hash: canonicalContentHash(document),
          document,
        };
      }),
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
    evidenceRef: `evidence/records/${demandRecords[0].evidence_id}.json`,
  };
}

async function markRunTerminal(state: PreparedRun): Promise<void> {
  const manifestPath = path.join(state.runRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.status = "insufficient_evidence";
  manifest.status_before_clarification = null;
  manifest.updated_at = "2026-07-25T19:15:00Z";
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
  await state.store.checkpoint({
    runId: G14_RUN_ID,
    checkpointId: "checkpoint_terminal_source_fixture",
    createdAt: "2026-07-25T19:15:30Z",
    nextStep: "SYNTHETIC finalize the required terminal report.",
    beliefSummary: {
      current_belief: "SYNTHETIC execution is partial and Evidence is insufficient.",
      evidence_that_changed_belief: [G14_ASSESSMENT_REF],
      unchanged_assumptions: ["No market or external validation is claimed."],
      remaining_disagreement: ["Real thesis viability remains unknown."],
      next_decision_relevant_question: "Should the user run the bounded buyer test?",
    },
    inputRefs: [G14_ASSESSMENT_REF],
  });
}

function terminalReportEnvelope(state: PreparedRun): FormalArtifactEnvelope {
  const artifactPath = "artifacts/reporting/terminal-report-source.r1.json";
  const auditRefs = [G14_ASSESSMENT_REF, state.evidenceRef].sort();
  const document: Record<string, unknown> = {
    schema_version: "startup_opportunity.terminal_report_source.v1",
    report_id: "terminal_report_synthetic_1",
    run_id: G14_RUN_ID,
    mode: "concept_evidence_assessment",
    research_language: "zh-CN",
    producer_role: "main_agent",
    owned_output_path: artifactPath,
    materialized_path: "report.json",
    generated_at: "2026-07-25T19:16:00Z",
    terminal_outcome: "insufficient_evidence",
    decision_question: "SYNTHETIC: should this narrow thesis receive more research?",
    execution: {
      completeness: "partial",
      completed_stages: ["initial assessment evidence wave"],
      incomplete_stages: [
        {
          stage: "buyer follow-up",
          cause: "runtime_blocked",
          detail: "SYNTHETIC plan revision publication did not complete.",
          conclusion_impact: "The current result cannot be described as a completed assessment.",
          related_refs: [G14_ASSESSMENT_REF],
        },
      ],
      required_followups: [
        {
          followup_id: "buyer_followup",
          status: "not_executed",
          detail: "SYNTHETIC buyer evidence remains uncollected.",
          related_refs: [G14_ASSESSMENT_REF],
        },
      ],
      pending_operation_refs: [],
    },
    research_conclusion: {
      outcome: "insufficient_evidence",
      current_recommendation: "先验证窄场景中的买方触发，再决定是否继续。",
      meaning: "现有材料只支持保留一个待验证假设，不能支持投入结论。",
      evidence_strength: "insufficient",
      allowed_claim: "初轮公开资料形成了一个待验证方向，但评估流程尚未完整执行。",
    },
    runtime_health: {
      status: "blocked",
      issues: [
        {
          code: "plan_revision_failed",
          stage: "buyer follow-up",
          detail: "SYNTHETIC deterministic publication fault prevented the required follow-up.",
          conclusion_impact: "Conclusion strength is capped at insufficient evidence.",
          related_refs: [G14_ASSESSMENT_REF],
        },
      ],
    },
    directions: [
      {
        direction_id: "narrow_outcome_service",
        priority: 1,
        label: "窄场景结果服务",
        maturity: "testable_product_hypothesis",
        action: "validate",
        target_user: "正在完成一次明确职业转换的成年人",
        narrow_scenario: "目标岗位已确定但无法把能力差距变成可展示工作样本",
        problem: "课程完成不能直接证明岗位能力。",
        current_alternative: "课程证书、通用简历修改和零散作品集模板",
        product_form: "目标岗位到实践任务、反馈和雇主可读工作样本的服务闭环",
        core_value: "把学习投入转换成可被招聘方检查的结果证据",
        key_risks: ["买方与付费触发尚未得到足够证据"],
        first_testable_assumption: "目标用户会为雇主可读工作样本而不是更多课程付费",
        comparison_reason: "该假设比通用课程更直接对应当前替代方案的失效点。",
        decisive_support_source_ids: ["synthetic_support"],
        decisive_opposition_source_ids: [],
        open_questions: ["谁实际付款，以及购买发生在求职流程的哪个时点？"],
      },
    ],
    sources: [
      {
        source_id: "synthetic_support",
        title: "Synthetic contract source",
        url: "https://unit_demand.synthetic.invalid/support",
        valid_as_of: "2026-07-25",
        stance: "supports",
        strength: "weak",
        claim: "SYNTHETIC input only; it tests source readability and is not market evidence.",
        evidence_ref: state.evidenceRef,
      },
    ],
    ordered_validation_plan: [
      {
        order: 1,
        hypothesis: "用户愿意为雇主可读工作样本而不是新增课程付费",
        why_now: "该问题决定是否存在买方和可持续价值。",
        method: "user_owned_external_validation",
        pass_signal: "用户在不被提示产品功能时明确选择并承诺为结果服务付费。",
        fail_signal: "用户只愿继续使用免费课程、简历模板或自助工具。",
        decision_effect: "通过后继续研究获客和交付；失败则淘汰该方向。",
        execution_owner: "user",
        execution_supported: false,
        result_tracking_supported: false,
      },
    ],
    freshness: {
      earliest_valid_as_of: "2026-07-25",
      latest_valid_as_of: "2026-07-25",
      summary: "仅引用一条 2026-07-25 的 synthetic contract source；不代表真实市场新鲜度。",
    },
    limitations: ["SYNTHETIC fixture; no real research or external validation was performed."],
    external_action_boundary: {
      execution_owner: "user",
      execution_supported: false,
      result_tracking_supported: false,
      external_validation_claimed: false,
    },
    audit_refs: auditRefs,
  };
  return {
    schema_version: "startup_opportunity.artifact_envelope.v17",
    artifact_type: "startup_opportunity.terminal_report_source.v1",
    artifact_path: artifactPath,
    run_id: G14_RUN_ID,
    created_at: "2026-07-25T19:16:00Z",
    producer_role: "main_agent",
    input_refs: auditRefs,
    content_hash: canonicalContentHash(document),
    document,
  };
}

test("terminal finalizer produces a localized decision-first brief with readable sources and hypotheses", async (context) => {
  const state = await prepareRun(context);
  await markRunTerminal(state);
  const reportEnvelope = terminalReportEnvelope(state);
  const result = await state.runtime.build({ reportEnvelope });
  assert.equal(result.status, "published");
  assert.deepEqual(result.materializedPaths, ["report.json", "decision-brief.md", "report.md"]);
  const brief = await readFile(path.join(state.runRoot, "decision-brief.md"), "utf8");
  assert.match(brief, /^# 决策简报/m);
  assert.match(brief, /## 现在应该做什么/);
  assert.match(brief, /执行完整度: 部分执行/);
  assert.match(brief, /状态: 运行受阻/);
  assert.match(brief, /可测试产品假设/);
  assert.match(
    brief,
    /\[Synthetic contract source\]\(https:\/\/unit_demand\.synthetic\.invalid\/support\)/,
  );
  assert.match(brief, /通过信号/);
  assert.doesNotMatch(brief.split("## 审计附录", 1)[0] ?? "", /artifacts\//);
  assert.doesNotMatch(brief, /insufficient_evidence|execution_supported: false/);
  const reportJson = JSON.parse(
    await readFile(path.join(state.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(reportJson.schema_version, "startup_opportunity.terminal_report_source.v1");
  const loaded = await state.store.load(G14_RUN_ID).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
    }
    throw error;
  });
  assert.equal(loaded.manifest.schema_bundle_version, "18.0.0");
});

test("terminal report rejects false completion, derived drift, and caller-declared freshness", async (context) => {
  const state = await prepareRun(context);
  await markRunTerminal(state);
  const validator = await createArtifactValidator(repositoryRoot);
  const base = terminalReportEnvelope(state);
  const invalidSources = [
    (() => {
      const envelope = structuredClone(base);
      envelope.document.execution = {
        ...(envelope.document.execution as Record<string, unknown>),
        completeness: "complete",
      };
      (envelope as { content_hash: string }).content_hash = canonicalContentHash(envelope.document);
      return { envelope, code: "terminal_reporting.execution_completeness_mismatch" };
    })(),
    (() => {
      const envelope = structuredClone(base);
      envelope.document.freshness = {
        ...(envelope.document.freshness as Record<string, unknown>),
        latest_valid_as_of: "2026-07-26",
      };
      (envelope as { content_hash: string }).content_hash = canonicalContentHash(envelope.document);
      return { envelope, code: "terminal_reporting.freshness_mismatch" };
    })(),
  ];
  for (const candidate of invalidSources) {
    const assembled = await state.store.buildValidationContext(G14_RUN_ID, {
      schema_version: "startup_opportunity.document_bundle.v17",
      documents: [{ path: candidate.envelope.artifact_path, document: candidate.envelope }],
      exact_records: [],
    });
    const result = validator.validateDocumentBundle(assembled.bundle, assembled.referenceContext);
    assert.equal(result.valid, false, candidate.code);
    assert.ok(
      result.referenceErrors.some((entry) => entry.code === candidate.code),
      JSON.stringify(result, null, 2),
    );
  }

  const derived = deriveReportEnvelopes(base);
  const driftedBrief = structuredClone(derived[0]);
  assert.ok(driftedBrief);
  driftedBrief.document.research_conclusion = {
    ...(driftedBrief.document.research_conclusion as Record<string, unknown>),
    outcome: "prioritize",
  };
  (driftedBrief as { content_hash: string }).content_hash = canonicalContentHash(
    driftedBrief.document,
  );
  const assembled = await state.store.buildValidationContext(G14_RUN_ID, {
    schema_version: "startup_opportunity.document_bundle.v17",
    documents: [
      { path: base.artifact_path, document: base },
      { path: driftedBrief.artifact_path, document: driftedBrief },
    ],
    exact_records: [],
  });
  const driftResult = validator.validateDocumentBundle(
    assembled.bundle,
    assembled.referenceContext,
  );
  assert.equal(driftResult.valid, false);
  assert.ok(
    driftResult.referenceErrors.some((entry) => entry.code === "terminal_reporting.derived_drift"),
  );
});

test("terminal report fault recovery completes immutable sidecars and materialized views", async (context) => {
  const state = await prepareRun(context);
  await markRunTerminal(state);
  await assert.rejects(
    state.runtime.build({
      reportEnvelope: terminalReportEnvelope(state),
      faultAt: "after_view_materialization",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const loaded = await state.store.load(G14_RUN_ID).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
    }
    throw error;
  });
  assert.ok(
    loaded.reportRecovery.recoveredFormalArtifactPaths.includes(
      "artifacts/reporting/consistency-evaluation.r1.json",
    ),
  );
  assert.match(await readFile(path.join(state.runRoot, "decision-brief.md"), "utf8"), /# 决策简报/);
  assert.match(
    await readFile(path.join(state.runRoot, "report.md"), "utf8"),
    /# 创业机会研究终态报告/,
  );
});

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
  assert.equal(reopened.manifest.schema_bundle_version, "18.0.0");
  assert.equal(reopened.lastValidCheckpointRef, "checkpoints/checkpoint-g1-4-report.json");
  assert.equal(reopened.reportRecovery.recoveredFormalArtifactPaths.length, 0);
  assert.equal(reopened.reportRecovery.recoveredMaterializedPaths.length, 0);
});

test("G1.R initializes the RunStore-report runtime cycle in both import orders and reopens", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g1-r-cycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const script = `
    const order = process.env.G1R_IMPORT_ORDER;
    const runsRoot = process.env.G1R_RUNS_ROOT;
    if (!order || !runsRoot) throw new Error("missing G1.R child-process input");
    const runStorePath = "./harness/src/run-store/run-store.ts";
    const reportRuntimePath = "./harness/src/reporting/report-runtime.ts";
    const modules = order === "run-first"
      ? [await import(runStorePath), await import(reportRuntimePath)]
      : [await import(reportRuntimePath), await import(runStorePath)];
    const runStoreModule = order === "run-first" ? modules[0] : modules[1];
    const reportRuntimeModule = order === "run-first" ? modules[1] : modules[0];
    const { createArtifactValidator } = await import("./harness/src/validators/artifact-validator.ts");
    const validator = await createArtifactValidator(process.cwd());
    const store = new runStoreModule.RunStore(runsRoot, validator);
    const runId = order === "run-first" ? "run_g1_r_cycle_run_first" : "run_g1_r_cycle_report_first";
    await store.create({
      runId,
      mode: "concept_evidence_assessment",
      createdAt: "2026-07-25T18:00:00Z",
    });
    new reportRuntimeModule.ReportRuntime(runsRoot, validator);
    const reopened = await store.load(runId);
    process.stdout.write(JSON.stringify({ order, runId: reopened.runId, recovered: reopened.recovered }));
  `;
  for (const order of ["run-first", "report-first"] as const) {
    const runsRoot = path.join(root, order, "runs");
    const executed = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, G1R_IMPORT_ORDER: order, G1R_RUNS_ROOT: runsRoot },
      },
    );
    assert.deepEqual(JSON.parse(executed.stdout), {
      order,
      runId: order === "run-first" ? "run_g1_r_cycle_run_first" : "run_g1_r_cycle_report_first",
      recovered: false,
    });
  }
});

test("G1.R rejects a second report revision before writes and preserves reopen", async (context) => {
  const state = await prepareRun(context);
  await state.runtime.build({ reportEnvelope: state.reportEnvelope });
  const before = await snapshotTree(state.runRoot);
  const revision = nextReportRevision(state.reportEnvelope);
  await assert.rejects(
    state.runtime.build({ reportEnvelope: revision }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.final_revision_conflict",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), before);
  const reopened = await state.store.load(G14_RUN_ID);
  assert.equal(reopened.reportRecovery.recoveredFormalArtifactPaths.length, 0);
  assert.equal(reopened.reportRecovery.recoveredMaterializedPaths.length, 0);
  assert.deepEqual(await snapshotTree(state.runRoot), before);
});

test("G1.R rejects r2 after an r1 sidecar-only crash and recovers r1", async (context) => {
  const state = await prepareRun(context);
  await assert.rejects(
    state.runtime.build({
      reportEnvelope: state.reportEnvelope,
      faultAt: "after_report_sidecar",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const beforeRevision = await snapshotTree(state.runRoot);
  const revision = nextReportRevision(state.reportEnvelope);
  await assert.rejects(
    state.runtime.build({ reportEnvelope: revision }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.final_revision_conflict",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), beforeRevision);
  await assert.rejects(readFile(path.join(state.runRoot, revision.artifact_path)));

  const reopened = await state.store.load(G14_RUN_ID);
  assert.ok(reopened.reportRecovery.recoveredFormalArtifactPaths.length > 0);
  assert.ok(reopened.reportRecovery.recoveredMaterializedPaths.length > 0);
  const materialized = JSON.parse(
    await readFile(path.join(state.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(materialized.report_id, state.reportEnvelope.document.report_id);
  assert.equal(
    (await state.runtime.build({ reportEnvelope: state.reportEnvelope })).status,
    "idempotent_replay",
  );
});

test("G1.R reclaims legacy incomplete Run and report locks before build and reopen", async (context) => {
  const state = await prepareRun(context);
  await writeFile(path.join(state.runRoot, ".store/write.lock"), "");
  await writeFile(path.join(state.runRoot, ".store/report.write.lock"), "");

  assert.equal(
    (await state.runtime.build({ reportEnvelope: state.reportEnvelope })).status,
    "published",
  );
  await assert.rejects(readFile(path.join(state.runRoot, ".store/write.lock")));
  await assert.rejects(readFile(path.join(state.runRoot, ".store/report.write.lock")));
  const reopened = await state.store.load(G14_RUN_ID);
  assert.equal(reopened.reportRecovery.recoveredFormalArtifactPaths.length, 0);
  assert.equal(reopened.reportRecovery.recoveredMaterializedPaths.length, 0);
});

test("G1.R serializes concurrent report revisions without a losing sidecar", async (context) => {
  const state = await prepareRun(context);
  const revision = nextReportRevision(state.reportEnvelope);
  const candidates = [state.reportEnvelope, revision] as const;
  const outcomes = await Promise.allSettled(
    candidates.map((reportEnvelope) => state.runtime.build({ reportEnvelope })),
  );
  const winnerIndexes = outcomes
    .map((outcome, index) => (outcome.status === "fulfilled" ? index : -1))
    .filter((index) => index >= 0);
  const loserIndexes = outcomes
    .map((outcome, index) => (outcome.status === "rejected" ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(winnerIndexes.length, 1);
  assert.equal(loserIndexes.length, 1);
  const loser = outcomes[loserIndexes[0] as number];
  assert.ok(loser?.status === "rejected");
  assert.ok(loser.reason instanceof StoreError);
  assert.equal(loser.reason.code, "report.write_locked");

  const winner = candidates[winnerIndexes[0] as number];
  const losingCandidate = candidates[loserIndexes[0] as number];
  assert.ok(winner);
  assert.ok(losingCandidate);
  await assert.rejects(readFile(path.join(state.runRoot, losingCandidate.artifact_path)));
  const materialized = JSON.parse(
    await readFile(path.join(state.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(materialized.report_id, winner.document.report_id);
  const reopened = await state.store.load(G14_RUN_ID);
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
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.final_revision_conflict",
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

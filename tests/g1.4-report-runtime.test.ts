import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ArtifactStore,
  canonicalContentHash,
  canonicalJson,
  createArtifactValidator,
  deriveReportEnvelopes,
  EvidenceStore,
  type FormalArtifactEnvelope,
  type OperationObservation,
  type ReportFaultBoundary,
  ReportRuntime,
  RunStore,
  StoreError,
  sha256Bytes,
  validateDecisionSubjectContract,
} from "../harness/src/index.js";
import {
  createCommercialAuditProjector,
  renderGateWarnings,
} from "../harness/src/reporting/commercial-report-tables.js";
import {
  localizedTerminalUserViewIssues,
  renderTerminalAuditAppendix,
  renderTerminalDecisionBrief,
  renderTerminalFullReport,
} from "../harness/src/reporting/terminal-reporting.js";
import { deriveResearchProvenance } from "../harness/src/validators/research-handoff-validator.js";
import {
  type TerminalReportingDocument,
  validateTerminalReportingContract,
} from "../harness/src/validators/terminal-reporting-validator.js";
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
  refreshG14Bundle,
  replaceG14EvidenceRecords,
} from "./fixtures/g1.4/assessment-report-fixture.js";
import {
  createDiscoveryMapsFixture,
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
  G21_OPPORTUNITY_REF,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  commercialReportProjection,
  completeCurrentQuantitativeFields,
  unavailableQuantitativeCompetitiveCoverage,
  unavailableSubjectAssessments,
} from "./fixtures/quantitative-competitive-fixture.js";
import { createConfirmedRun, publishInitialPlanBundle } from "./helpers/current-run.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);
const TERMINAL_LOCALIZATION_VOCABULARY =
  "Google Cloud Audit Logs helps users inspect changes. Schema.org vocabulary. Evidence Based Design. mobile_web.delivery_form. open_data.product_protocol.";
const TERMINAL_LOCALIZATION_SOURCE_URL =
  "https://unit_demand.synthetic.invalid/Google-Cloud-Audit-Logs/mobile_web.delivery_form/Schema.org";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storeReferenceCodes(error: StoreError): readonly string[] {
  const referenceErrors = error.details.referenceErrors;
  return Array.isArray(referenceErrors)
    ? referenceErrors.flatMap((entry) =>
        isRecord(entry) && typeof entry.code === "string" ? [entry.code] : [],
      )
    : [];
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

function reportingDocuments(
  documents: readonly { readonly path: string; readonly document: Record<string, unknown> }[],
): TerminalReportingDocument[] {
  return documents.map((entry) => {
    const envelope = entry.document;
    const currentEnvelope =
      envelope.schema_version === "startup_opportunity.artifact_envelope.current" &&
      isRecord(envelope.document);
    return {
      path: entry.path,
      schemaVersion: String(currentEnvelope ? envelope.artifact_type : envelope.schema_version),
      document: currentEnvelope ? (envelope.document as Record<string, unknown>) : envelope,
      envelope: currentEnvelope ? envelope : null,
    };
  });
}

function v5Envelope(
  artifactPath: string,
  document: Record<string, unknown>,
  producerRole = "main_agent",
  inputRefs: readonly string[] = [],
  createdAt = "2026-07-25T18:10:00Z",
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
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

function commercialAuditEnvelope(
  branch: ReturnType<typeof g14Branches>[number],
  evidenceRef: string,
  recordedAt: string,
): FormalArtifactEnvelope {
  const taskRef = `tasks/${branch.unitId}.attempt-1.json`;
  const artifactPath = `artifacts/research-audits/${branch.unitId}.json`;
  const coveredSubjectIds =
    branch.unitId === "unit_demand"
      ? ["concept_assess_001", "narrow_outcome_service"]
      : ["narrow_outcome_service"];
  const uncovered = [
    "recent_user_language",
    "purchase_signal",
    "alternatives_pricing_usage",
    "distribution_channel",
    "independent_counterevidence",
  ];
  const coverage: Record<string, Record<string, unknown>> = Object.fromEntries(
    uncovered.map((key) => [
      key,
      {
        state: "unknown",
        content_covered: false,
        evidence_refs: [],
        data_points: [],
        inference: null,
      },
    ]),
  );
  if (branch.unitId === "unit_demand") {
    coverage.purchase_signal = {
      state: "inferred",
      content_covered: true,
      evidence_refs: [evidenceRef],
      data_points: [],
      inference: {
        basis_refs: [evidenceRef],
        starting_point: "合成材料描述了与购买相邻的行为。",
        reasoning: "该行为可能意味着购买意向，但没有观察到交易。",
        uncertainty: "意向可能不会转化为付款。",
        validation_needed: "需要观察近期购买或付款承诺。",
      },
    };
  }
  const quantitativeCompetitive = unavailableQuantitativeCompetitiveCoverage(
    coveredSubjectIds,
    "2026-07-25T18:39:00Z",
  );
  const limitations = ["SYNTHETIC audit fixture; no market research was performed."];
  const document = {
    schema_version: "startup_opportunity.commercial_research_audit.current",
    audit_id: `commercial_audit_${branch.unitId}`,
    run_id: G14_RUN_ID,
    unit_id: branch.unitId,
    execution_plan_ref: "plans/research-execution.r1.json",
    dispatch_task_ref: `tasks/dispatch/commercial-research.r1.json#task_${branch.unitId}`,
    task_ref: taskRef,
    covered_direction_ids: coveredSubjectIds,
    research_stage: "solution_specific_evaluation",
    audited_at: "2026-07-25T18:39:00Z",
    planned_resource_allocation: {
      customer_commercial_percent: 65,
      market_structure_percent: 17,
      academic_percent: 18,
    },
    adopted_source_distribution: {
      total_adopted_sources: 1,
      customer_commercial_count: 1,
      market_structure_count: 0,
      academic_count: 0,
      customer_commercial_percent: 100,
      market_structure_percent: 0,
      academic_percent: 0,
      guidance_deviation_observed: true,
    },
    research_objectives: [`Evaluate bounded commercial support for ${branch.unitId}.`],
    primary_routes: ["Synthetic Evidence Store fixture; no external research was performed."],
    findings: [],
    claims: [],
    judgments: [],
    search_log: [
      {
        query_id: `query_${branch.unitId}`,
        query: `synthetic ${branch.unitId} commercial source`,
        searched_at: recordedAt,
        commercial_dimensions: ["buyer", "purchase", "pricing", "alternatives"],
        candidate_results: [
          {
            url: `https://${branch.unitId}.synthetic.invalid/support`,
            title: `Synthetic ${branch.unitId} support`,
            retrieved_at: recordedAt,
            published_at: null,
            observed_at: recordedAt,
            data_period_end: null,
            derived_valid_as_of: recordedAt.slice(0, 10),
            claim_type: "current_purchase_behavior",
            adopted_evidence_ref: evidenceRef,
            rejection_reason: null,
          },
        ],
      },
    ],
    search_closure: {
      closure_id: `search_closure_${branch.unitId}`,
      lane_kind: "external_research",
      outcome: "evidence_insufficient",
      query_log_complete: false,
      telemetry_basis: "unavailable",
      remaining_gaps: uncovered.flatMap((dimension) =>
        coveredSubjectIds.map((subjectId) => ({
          subject_ids: [subjectId],
          subject_binding_basis:
            coveredSubjectIds.length === 1 ? "single_subject_auto" : "explicit",
          coverage_kind: "business",
          dimension,
          state: "unavailable",
          reason: `No direct ${dimension} material was available in the synthetic fixture.`,
          alternative_metric: null,
          decision_impact:
            "The subject remains unranked until this business dimension is observed.",
          query_attempts: [],
          task_ref: taskRef,
          audit_ref: `artifacts/research-audits/${branch.unitId}.json`,
        })),
      ),
      termination_reason: "Synthetic fixture records no observable browser-tool telemetry.",
    },
    evidence_register: [
      {
        evidence_ref: evidenceRef,
        subject_ids: [...coveredSubjectIds],
        subject_binding_basis: coveredSubjectIds.length === 1 ? "single_subject_auto" : "explicit",
        source_kind: "independent",
        source_profile: { type: "other", description: "Synthetic contract Evidence." },
        evidence_character: "inference",
        independence: "independent",
        claim_type: "current_purchase_behavior",
        content_summary: "Synthetic material describes purchase-adjacent behavior only.",
        retrieved_at: recordedAt,
        published_at: null,
        observed_at: recordedAt,
        data_period_end: null,
        derived_valid_as_of: recordedAt.slice(0, 10),
        freshness_status: "current",
        coverage_keys: [],
        disposition: "adopted",
        exclusion_reason: null,
      },
    ],
    coverage,
    uncovered_business_dimensions: uncovered,
    wave1_signals: { demand: false, buyer: false, purchase: false },
    stage_decision: "early_stop_insufficient_evidence",
    ranking_eligibility: "unranked_hypothesis",
    ...quantitativeCompetitive,
    incumbent_response_assignment: {
      analysis_depth: "not_assigned",
      assignment_role: "none",
      subject_refs: [],
      rationale:
        "This synthetic branch does not own the separately planned incumbent response deep dive.",
    },
    incumbent_response_assessments: [],
    incumbent_response_coverage: [],
    recommendation_ceiling: {
      maximum_decision_tier: "investigate_further",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
      ],
    },
    subject_recommendation_ceilings: coveredSubjectIds.map((subjectId) => ({
      subject_id: subjectId,
      maximum_decision_tier: "investigate_further",
      reason_codes: [
        "missing_independent_competitor_adoption_data",
        "missing_purchase_or_payment_signal",
        "missing_retention_evidence",
      ],
    })),
    subject_assessments: unavailableSubjectAssessments(
      coveredSubjectIds,
      quantitativeCompetitive,
      limitations,
      [evidenceRef],
    ),
    compiler_warnings:
      branch.unitId === "unit_demand"
        ? [
            {
              code: "commercial_research.independent_cross_validation_missing",
              severity: "warning",
              category: "decision_validity",
              message: "Synthetic support has no independent cross-validation.",
              decision_impact: "The recommendation remains bounded by the commercial ceiling.",
              artifact_refs: [artifactPath],
            },
          ]
        : [],
    limitations,
  };
  completeCurrentQuantitativeFields(document);
  return v5Envelope(
    artifactPath,
    document,
    "harness",
    [
      "plans/research-execution.r1.json",
      `tasks/dispatch/commercial-research.r1.json#task_${branch.unitId}`,
      taskRef,
      evidenceRef,
    ],
    "2026-07-25T18:39:00Z",
  );
}

function executionPlanEnvelope(
  bundle: Awaited<ReturnType<typeof createG14ContractBundle>>,
): FormalArtifactEnvelope {
  const researchPlan = documentAt(bundle, "plans/research-plan.r1.json");
  const lanes = g14Branches().map((branch) => ({
    unit_id: branch.unitId,
    lane_role: branch.unitId === "unit_counter" ? "risk" : "evaluation",
    candidate_scope: { kind: "none", candidate_refs: [] },
    incumbent_response_assignment: {
      analysis_depth: "not_assigned",
      assignment_role: "none",
      subject_refs: [],
      rationale:
        "This synthetic branch does not own the separately planned incumbent response deep dive.",
    },
    reporting_dimensions: [branch.dimensionId],
    submission_path: branch.outputPath,
    submission_schema: "startup_opportunity.concept_evidence_assessment_branch_result.v1",
    time_budget_minutes: 10,
    max_sources: 5,
    straggler_policy: { on_timeout: "publish_partial", grace_minutes: 0, blocks_stage: false },
    dispatch_group: "commercial_research",
  }));
  return v5Envelope(
    "plans/research-execution.r1.json",
    {
      schema_version: "startup_opportunity.research_execution_plan.discovery.current",
      execution_plan_id: "execution_plan_g1_4_synthetic",
      run_id: G14_RUN_ID,
      mode: "concept_evidence_assessment",
      revision: 1,
      parent_execution_plan_ref: null,
      research_plan_ref: "plans/research-plan.r1.json",
      research_plan_hash: canonicalContentHash(researchPlan),
      created_at: "2026-07-25T18:05:00Z",
      research_depth: "standard",
      total_time_budget_minutes: 120,
      resource_allocation: {
        customer_commercial_percent: 65,
        market_structure_percent: 17,
        academic_percent: 18,
      },
      stages: [
        {
          stage_id: "commercial_research",
          stage_kind: "assessment_commercial",
          depends_on: [],
          gate_before: null,
          gate_after: "terminal_allowed",
          lanes,
        },
      ],
      limitations: ["SYNTHETIC execution plan; no research was performed."],
    },
    "main_agent",
    ["plans/research-plan.r1.json"],
    "2026-07-25T18:05:00Z",
  );
}

function dispatchEnvelope(
  bundle: Awaited<ReturnType<typeof createG14ContractBundle>>,
): FormalArtifactEnvelope {
  const tasks = g14Branches().map((branch) => {
    const taskPath = `tasks/${branch.unitId}.attempt-1.json`;
    const task = documentAt(bundle, taskPath);
    return {
      task_id: `task_${branch.unitId}`,
      unit_id: branch.unitId,
      lane_role: branch.unitId === "unit_counter" ? "risk" : "evaluation",
      incumbent_response_assignment: {
        analysis_depth: "not_assigned",
        assignment_role: "none",
        subject_refs: [],
        rationale:
          "This synthetic branch does not own the separately planned incumbent response deep dive.",
      },
      research_goal: task.research_goal,
      input_refs: task.input_refs,
      allowed_output_path: branch.outputPath,
      required_artifact_schema: "startup_opportunity.concept_evidence_assessment_branch_result.v1",
      time_budget_minutes: 10,
      max_sources: 5,
      straggler_policy: { on_timeout: "publish_partial", grace_minutes: 0, blocks_stage: false },
    };
  });
  return v5Envelope(
    "tasks/dispatch/commercial-research.r1.json",
    {
      schema_version: "startup_opportunity.dispatch_batch.discovery.current",
      batch_id: "dispatch_commercial_research_g1_4",
      revision: 1,
      run_id: G14_RUN_ID,
      mode: "concept_evidence_assessment",
      execution_plan_ref: "plans/research-execution.r1.json",
      research_plan_ref: "plans/research-plan.r1.json",
      stage_id: "commercial_research",
      dispatch_group: "commercial_research",
      task_ready_at: "2026-07-25T18:10:00Z",
      dispatch_requested_at: "2026-07-25T18:10:00Z",
      dispatch_mode: "parallel_immediate",
      tasks,
      agent_dispatch_performed: false,
      launch_registration_required: true,
      limitations: ["SYNTHETIC dispatch descriptor; no agent dispatch was performed."],
    },
    "harness",
    ["plans/research-execution.r1.json", "plans/research-plan.r1.json"],
    "2026-07-25T18:10:00Z",
  );
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
  readonly validator: Awaited<ReturnType<typeof createArtifactValidator>>;
  readonly runtime: ReportRuntime;
  readonly reportEnvelope: FormalArtifactEnvelope;
  readonly evidenceRef: string;
  readonly evidenceRefs: readonly string[];
  readonly decisionSubjectSnapshotRef: string;
  readonly decisionSubjectSnapshotHash: string;
  readonly decisionSubjectSnapshotEnvelope: FormalArtifactEnvelope;
  readonly decisionSubjectSynthesisRef: string;
  readonly decisionSubjectSynthesisHash: string;
  readonly decisionSubjectSynthesisEnvelope: FormalArtifactEnvelope;
  readonly commercialAudits: readonly {
    readonly auditRef: string;
    readonly audit: Readonly<Record<string, unknown>>;
  }[];
  readonly omittedCommercialAudit?: {
    readonly auditRef: string;
    readonly audit: Readonly<Record<string, unknown>>;
  };
}

const DECISION_SUBJECT_SNAPSHOT_REF = "artifacts/reporting/decision-subject-snapshot.r1.json";
const DECISION_SUBJECT_SYNTHESIS_REF =
  "artifacts/reporting/decision-subject-synthesis/concept-assess-001.r1.json";

function decisionSubjectDirection(): Record<string, unknown> {
  return {
    priority: null,
    ranking_status: "unranked_hypothesis",
    label: "家庭协同遗漏的共享工作流",
    maturity: "testable_product_hypothesis",
    action: "validate",
    target_user: "需要家庭协同的消费者",
    narrow_scenario: "家庭成员需要确认共同任务是否完成时",
    problem: "共同任务散落在即时通讯和个人备忘录中，成员难以确认完成状态",
    current_alternative: "即时通讯 | 备忘录 | 维持现状",
    payer: "家庭付款者",
    product_form: "mini_program",
    core_value: "降低重复沟通与遗漏",
    why_now: "家庭协同遗漏是否足以触发付费仍值得验证，但当前尚无购买证据。",
    key_risks: ["家庭付款者与付费触发尚未得到足够证据"],
    first_testable_assumption: "家庭付款者会为减少协同遗漏的共享工作流付费",
    comparison_reason: "该假设直接对应即时通讯和备忘录之间的协同断点。",
    decisive_support_source_ids: ["synthetic_support"],
    decisive_opposition_source_ids: [],
    open_questions: ["哪位家庭成员实际付款，以及何种协同遗漏触发购买？"],
  };
}

function decisionSubjectValidationSteps(): readonly Record<string, unknown>[] {
  return [
    {
      order: 1,
      hypothesis: "家庭付款者愿意为减少共同任务遗漏的共享工作流付费",
      why_now: "该问题决定家庭协同痛点是否存在明确买方和可持续价值。",
      method: "user_owned_external_validation",
      pass_signal: "家庭付款者在不被提示产品功能时明确选择并承诺为减少协同遗漏付费。",
      fail_signal: "家庭付款者只愿继续使用即时通讯、备忘录或现有免费工具。",
      decision_effect: "通过后继续研究获客和交付；失败则淘汰该家庭协同方向。",
      execution_owner: "user",
      execution_supported: false,
      result_tracking_supported: false,
    },
  ];
}

function terminalProvisionalSolutionEvaluationSummary(): Record<string, unknown> {
  const solutionRef = "artifacts/discovery/solutions/terminal_provisional.r1.json";
  return {
    solution_evaluation_ref:
      "artifacts/discovery/solution-evaluations/terminal_provisional.r1.json",
    solution_evaluation_content_hash: `sha256:${"1".repeat(64)}`,
    exploration_status: "not_yet_explored",
    selection_posture: "provisional_implementation",
    status_rationale: "SYNTHETIC provisional solution exploration for terminal report regression.",
    formal_solution_refs: [solutionRef],
    formal_solutions: [
      {
        solution_ref: solutionRef,
        solution_content_hash: `sha256:${"2".repeat(64)}`,
        disposition: "selected",
        solution_id: "solution_terminal_provisional",
        solution_type: "SYNTHETIC solution type",
        solution_behavior: "SYNTHETIC provisional solution behavior.",
        delivery_form: "mobile_web",
        uses_ai: false,
      },
    ],
    selected_solution_ref: solutionRef,
    alternative_solution_refs: [],
    rejected_solutions: [],
    considered_approaches: [],
    critical_unknowns: [],
    limitations: [],
  };
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

async function prepareRun(
  context: TestContext,
  options: {
    readonly omitCommercialAuditUnitId?: string;
    readonly injectHistoricalCompilerWarning?: boolean;
    readonly injectHarnessDiagnosticLeak?: boolean;
    readonly injectTerminalLocalizationVocabulary?: boolean;
    readonly researchLanguage?: string;
  } = {},
): Promise<PreparedRun> {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g1-4-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runRoot = path.join(runsRoot, G14_RUN_ID);
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId: G14_RUN_ID,
    mode: "concept_evidence_assessment",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: options.researchLanguage ?? "en-US",
    },
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
  await publishInitialPlanBundle(
    store,
    G14_RUN_ID,
    corePaths
      .map((artifactPath) => v5Envelope(artifactPath, documentAt(bundle, artifactPath)))
      .concat(executionPlanEnvelope(bundle)),
    "assessment",
  ).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }));
    }
    throw error;
  });

  const branches = g14Branches();
  const demand = branches.find((branch) => branch.unitId === "unit_demand");
  assert.ok(demand);
  await store
    .publishArtifactBundle({
      runId: G14_RUN_ID,
      envelopes: [
        executionPlanEnvelope(bundle),
        dispatchEnvelope(bundle),
        ...branches.map((branch) => {
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
      ],
    })
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }));
      }
      throw error;
    });

  const evidence = new EvidenceStore(runsRoot);
  let demandRecords:
    | readonly [
        Awaited<ReturnType<EvidenceStore["record"]>>["record"],
        Awaited<ReturnType<EvidenceStore["record"]>>["record"],
      ]
    | null = null;
  const commercialAudits: {
    auditRef: string;
    audit: Readonly<Record<string, unknown>>;
  }[] = [];
  let omittedCommercialAudit: PreparedRun["omittedCommercialAudit"];
  for (const [index, branch] of branches.entries()) {
    const taskPath = `tasks/${branch.unitId}.attempt-1.json`;
    const researchGoal = String(documentAt(bundle, taskPath).research_goal);
    const support = await evidence.record({
      runId: G14_RUN_ID,
      unitId: branch.unitId,
      researchGoal,
      source: {
        kind: "public_url",
        canonical_url:
          options.injectTerminalLocalizationVocabulary === true && branch.unitId === "unit_demand"
            ? TERMINAL_LOCALIZATION_SOURCE_URL
            : `https://${branch.unitId}.synthetic.invalid/support`,
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
    const commercialAudit = commercialAuditEnvelope(
      branch,
      evidencePaths[0] as string,
      support.record.recorded_at,
    );
    if (options.injectTerminalLocalizationVocabulary === true && branch.unitId === "unit_demand") {
      const coverage = commercialAudit.document.coverage as Record<string, unknown>;
      const purchaseSignal = coverage.purchase_signal as Record<string, unknown>;
      const inference = purchaseSignal.inference as Record<string, unknown>;
      inference.reasoning = TERMINAL_LOCALIZATION_VOCABULARY;
      (commercialAudit as { content_hash: string }).content_hash = canonicalContentHash(
        commercialAudit.document,
      );
    }
    if (options.injectHistoricalCompilerWarning === true && branch.unitId === "unit_target_user") {
      const compilerWarnings = commercialAudit.document.compiler_warnings as Record<
        string,
        unknown
      >[];
      compilerWarnings.push({
        code: "commercial_research.independent_cross_validation_missing",
        severity: "warning",
        category: "decision_validity",
        message: "SYNTHETIC historical-only warning must remain outside the terminal Brief.",
        decision_impact: "SYNTHETIC audit-only context; no current decision impact.",
        artifact_refs: [commercialAudit.artifact_path],
      });
      (commercialAudit as unknown as { content_hash: string }).content_hash = canonicalContentHash(
        commercialAudit.document,
      );
    }
    if (options.injectHarnessDiagnosticLeak === true && branch.unitId === "unit_demand") {
      const compilerWarnings = commercialAudit.document.compiler_warnings as Record<
        string,
        unknown
      >[];
      compilerWarnings.push({
        code: "commercial_research.synthetic_unknown_diagnostic",
        severity: "warning",
        category: "coverage",
        message:
          "Search Closure validator reported terminal_reporting.search_closure_incomplete for the planned Audit Lane.",
        decision_impact:
          "Audit and Search Closure details remain visible only in structured diagnostics.",
        artifact_refs: [commercialAudit.artifact_path],
      });
      (commercialAudit as unknown as { content_hash: string }).content_hash = canonicalContentHash(
        commercialAudit.document,
      );
    }
    const commercialAuditEntry = {
      auditRef: commercialAudit.artifact_path,
      audit: commercialAudit.document,
    };
    const commercialAuditOmitted = options.omitCommercialAuditUnitId === branch.unitId;
    if (commercialAuditOmitted) {
      omittedCommercialAudit = commercialAuditEntry;
    } else {
      commercialAudits.push(commercialAuditEntry);
    }
    await store.publishArtifactBundle({
      runId: G14_RUN_ID,
      envelopes: [
        ...branchResearchEnvelopes(branch, records, index).map((envelope) => {
          const document = structuredClone(envelope.document);
          if (
            branch.unitId === demand.unitId &&
            envelope.artifact_type === "startup_opportunity.claim.assessment.current"
          ) {
            document.evidence_refs = evidencePaths;
          }
          return {
            ...envelope,
            created_at: `2026-07-25T18:${String(20 + index).padStart(2, "0")}:00Z`,
            input_refs:
              branch.unitId === demand.unitId &&
              envelope.artifact_type === "startup_opportunity.claim.assessment.current"
                ? [`tasks/${branch.unitId}.attempt-1.json`, ...evidencePaths].sort()
                : envelope.input_refs,
            content_hash: canonicalContentHash(document),
            document,
          };
        }),
        ...(commercialAuditOmitted ? [] : [commercialAudit]),
      ],
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
  const commercialAuditByRef = new Map(
    commercialAudits.map(({ auditRef, audit }) => [auditRef, audit]),
  );
  bundle = refreshG14Bundle({
    ...bundle,
    documents: bundle.documents.map((entry) => {
      const commercialAudit = commercialAuditByRef.get(entry.path);
      return commercialAudit === undefined
        ? entry
        : { path: entry.path, document: structuredClone(commercialAudit) };
    }),
  });
  Object.assign(documentAt(bundle, G14_REPORT_REF), commercialReportProjection(commercialAudits));
  bundle = refreshG14Bundle(bundle);

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
  delete (reportEnvelope as FormalArtifactEnvelope).document.research_language;
  const evidenceRefs = (await store.status(G14_RUN_ID)).manifest.artifact_refs.filter((ref) =>
    ref.startsWith("evidence/records/"),
  );
  const snapshotDocument = {
    schema_version: "startup_opportunity.decision_subject_snapshot.current",
    snapshot_id: "decision_subjects_g1_4_synthetic",
    revision: 1,
    parent_snapshot_ref: null,
    parent_snapshot_hash: null,
    run_id: G14_RUN_ID,
    mode: "concept_evidence_assessment",
    scope_frame_ref: "scope-frame.json",
    scope_frame_hash: canonicalContentHash(documentAt(bundle, "scope-frame.json")),
    research_plan_ref: "plans/research-plan.r1.json",
    research_plan_hash: canonicalContentHash(documentAt(bundle, "plans/research-plan.r1.json")),
    synthesis_input_hashes: [
      {
        ref: G14_ASSESSMENT_REF,
        content_hash: canonicalContentHash(documentAt(bundle, G14_ASSESSMENT_REF)),
      },
    ],
    created_at: "2026-07-25T19:00:30Z",
    subjects: [
      {
        subject_id: "concept_assess_001",
        subject_ref: "concept-hypothesis.json",
        subject_content_hash: canonicalContentHash(documentAt(bundle, "concept-hypothesis.json")),
        subject_kind: "concept_hypothesis",
        lifecycle_status: "current",
        reporting_role: "final",
        superseded_by_subject_id: null,
        formation_reason: "SYNTHETIC current final direction for terminal projection tests.",
        lifecycle_reason: "SYNTHETIC retained as the only current decision subject.",
      },
    ],
    limitations: ["SYNTHETIC decision subject snapshot; not market Evidence."],
  };
  const snapshotEnvelope = v5Envelope(
    DECISION_SUBJECT_SNAPSHOT_REF,
    snapshotDocument,
    "main_agent",
    [
      "scope-frame.json",
      "plans/research-plan.r1.json",
      G14_ASSESSMENT_REF,
      "concept-hypothesis.json",
    ],
    "2026-07-25T19:00:30Z",
  );
  await store.publishArtifact({ runId: G14_RUN_ID, envelope: snapshotEnvelope });
  const conceptHash = canonicalContentHash(documentAt(bundle, "concept-hypothesis.json"));
  const assessmentHash = canonicalContentHash(documentAt(bundle, G14_ASSESSMENT_REF));
  const synthesisDocument = {
    schema_version: "startup_opportunity.decision_subject_synthesis.current",
    synthesis_id: "decision_subject_synthesis_concept_assess_001_r1",
    run_id: G14_RUN_ID,
    subject_id: "concept_assess_001",
    subject_ref: "concept-hypothesis.json",
    subject_content_hash: conceptHash,
    synthesis_basis_hashes: [
      { ref: "concept-hypothesis.json", content_hash: conceptHash },
      { ref: G14_ASSESSMENT_REF, content_hash: assessmentHash },
    ],
    direction: decisionSubjectDirection(),
    validation_steps: decisionSubjectValidationSteps(),
    created_at: "2026-07-25T19:00:45Z",
    limitations: ["SYNTHETIC report synthesis; not market Evidence."],
  };
  const synthesisEnvelope = v5Envelope(
    DECISION_SUBJECT_SYNTHESIS_REF,
    synthesisDocument,
    "main_agent",
    ["concept-hypothesis.json", G14_ASSESSMENT_REF],
    "2026-07-25T19:00:45Z",
  );
  await store.publishArtifact({ runId: G14_RUN_ID, envelope: synthesisEnvelope });
  return {
    runsRoot,
    runRoot,
    store,
    validator,
    runtime: new ReportRuntime(runsRoot, validator),
    reportEnvelope: reportEnvelope as FormalArtifactEnvelope,
    evidenceRef: `evidence/records/${demandRecords[0].evidence_id}.json`,
    evidenceRefs,
    decisionSubjectSnapshotRef: DECISION_SUBJECT_SNAPSHOT_REF,
    decisionSubjectSnapshotHash: snapshotEnvelope.content_hash,
    decisionSubjectSnapshotEnvelope: snapshotEnvelope,
    decisionSubjectSynthesisRef: DECISION_SUBJECT_SYNTHESIS_REF,
    decisionSubjectSynthesisHash: synthesisEnvelope.content_hash,
    decisionSubjectSynthesisEnvelope: synthesisEnvelope,
    commercialAudits,
    ...(omittedCommercialAudit === undefined ? {} : { omittedCommercialAudit }),
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
  const commercialAuditRefs = g14Branches()
    .map((branch) => `artifacts/research-audits/${branch.unitId}.json`)
    .sort();
  const taskRefs = g14Branches()
    .map((branch) => `tasks/${branch.unitId}.attempt-1.json`)
    .sort();
  const auditRefs = [
    G14_ASSESSMENT_REF,
    ...commercialAuditRefs,
    ...taskRefs,
    ...state.evidenceRefs,
  ].sort();
  const subjectRef = String(state.decisionSubjectSynthesisEnvelope.document.subject_ref);
  const subjectHash = String(state.decisionSubjectSynthesisEnvelope.document.subject_content_hash);
  const projectedDirection = {
    direction_id: "concept_assess_001",
    subject_ref: subjectRef,
    subject_content_hash: subjectHash,
    synthesis_ref: state.decisionSubjectSynthesisRef,
    synthesis_content_hash: state.decisionSubjectSynthesisHash,
    ...structuredClone(decisionSubjectDirection()),
  };
  const projectedValidationPlan = decisionSubjectValidationSteps().map((step) => ({
    order: step.order,
    direction_id: "concept_assess_001",
    subject_ref: subjectRef,
    subject_content_hash: subjectHash,
    synthesis_ref: state.decisionSubjectSynthesisRef,
    synthesis_content_hash: state.decisionSubjectSynthesisHash,
    ...structuredClone(step),
  }));
  const document = structuredClone(state.reportEnvelope.document) as Record<string, unknown>;
  for (const key of [
    "report_metadata",
    "decision_context_ref",
    "concept_frame_ref",
    "concept_hypothesis_ref",
    "evidence_assessment_plan_ref",
    "research_plan_ref",
    "plan_lineage_refs",
    "applied_adaptation_refs",
    "hypothesis_evidence_matrix_ref",
    "adversarial_review_ref",
    "evidence_audit_ref",
    "concept_evidence_assessment_ref",
    "business_engine_ref",
    "judgment_assessment_refs",
    "source_manifest_refs",
    "traceability_ref",
    "curated_judgment_context",
    "report_sections",
    "statements",
    "freshness_summary",
  ]) {
    delete document[key];
  }
  Object.assign(
    document,
    commercialReportProjection(state.commercialAudits, [], new Map(), ["concept_assess_001"]),
  );
  document.schema_version = "startup_opportunity.terminal_report_source.v1";
  document.report_id = "terminal_report_synthetic_1";
  document.run_id = G14_RUN_ID;
  document.mode = "concept_evidence_assessment";
  document.research_language = "zh-CN";
  document.producer_role = "main_agent";
  document.owned_output_path = artifactPath;
  document.materialized_path = "report.json";
  document.generated_at = "2026-07-25T19:16:00Z";
  document.decision_subject_snapshot_ref = state.decisionSubjectSnapshotRef;
  document.decision_subject_snapshot_hash = state.decisionSubjectSnapshotHash;
  document.decision_subject_synthesis_hashes = [
    {
      ref: state.decisionSubjectSynthesisRef,
      content_hash: state.decisionSubjectSynthesisHash,
    },
  ];
  document.current_decision_subject_ids = ["concept_assess_001"];
  document.terminal_outcome = "insufficient_evidence";
  document.decision_question = "这个合成的窄方向是否值得继续调研？";
  document.execution = {
    completeness: "partial",
    completed_stages: ["初轮评估"],
    incomplete_stages: [
      {
        stage: "买方追加调研",
        cause: "runtime_blocked",
        detail: "合成的计划修订发布没有完成。",
        conclusion_impact: "当前结果不能描述为完整评估。",
        related_refs: [G14_ASSESSMENT_REF],
      },
    ],
    required_followups: [
      {
        followup_id: "buyer_followup",
        status: "not_executed",
        detail: "合成的买方材料仍未收集。",
        related_refs: [G14_ASSESSMENT_REF],
      },
    ],
    pending_operation_refs: [],
  };
  document.research_conclusion = {
    outcome: "insufficient_evidence",
    current_recommendation: "先验证窄场景中的买方触发，再决定是否继续。",
    meaning: "现有材料只支持保留一个待验证假设，不能支持投入结论。",
    evidence_strength: "insufficient",
    allowed_claim: "初轮公开资料形成了一个待验证方向，但评估流程尚未完整执行。",
  };
  document.runtime_health = {
    status: "blocked",
    issues: [
      {
        code: "plan_revision_failed",
        stage: "买方追加调研",
        detail: "合成的确定性发布故障阻止了必需的追加调研。",
        conclusion_impact: "结论强度被限制为证据不足。",
        related_refs: [G14_ASSESSMENT_REF],
      },
    ],
  };
  document.directions = [structuredClone(projectedDirection)];
  document.sources = [
    {
      source_id: "synthetic_support",
      title: "Synthetic contract source",
      url: "https://unit_demand.synthetic.invalid/support",
      source_access: "public",
      retrieved_at: "2026-07-25T18:00:00Z",
      published_at: "2026-07-25T00:00:00Z",
      observed_at: null,
      data_period_end: null,
      valid_as_of: "2026-07-25",
      freshness_status: "current",
      claim_type: "current_market_change",
      claim_state: "inferred",
      inference: {
        basis_refs: [state.evidenceRef],
        starting_point: "合成输入包含一个待验证方向。",
        reasoning: "该方向只用于演示从输入到假设的推理链。",
        uncertainty: "没有真实市场资料，无法判断方向是否成立。",
        validation_needed: "需要收集近期用户、购买和渠道行为材料。",
      },
      source_kind: "independent",
      evidence_character: "inference",
      independence: "independent",
      commercial_coverage_keys: [],
      stance: "supports",
      strength: "weak",
      claim: "仅为合成输入，用于测试来源可读性，不代表真实市场证据。",
      evidence_ref: state.evidenceRef,
    },
  ];
  document.excluded_evidence = state.evidenceRefs
    .filter((ref) => ref !== state.evidenceRef)
    .map((evidence_ref) => ({
      evidence_ref,
      reason: "该材料不是本次终态结论的决定性来源，但保留在完整审计范围中。",
    }));
  document.commercial_uncertainties = [
    {
      direction_id: "concept_assess_001",
      coverage_key: "purchase_signal",
      state: "inferred",
      statement: "当前行为可能反映购买意向，但尚未观察到实际付款。",
      basis_refs: [state.evidenceRef],
      starting_point: "合成材料描述了与购买相邻的行为。",
      reasoning: "该行为可能意味着购买意向，但没有观察到交易。",
      uncertainty: "意向可能不会转化为付款。",
      validation_needed: "需要观察近期购买或付款承诺。",
    },
    ...[
      ["recent_user_language", "尚不清楚目标用户如何描述该问题。"],
      ["alternatives_pricing_usage", "尚不清楚用户如何使用或支付当前替代方案。"],
      ["distribution_channel", "尚不清楚现实可达的分发渠道。"],
      ["independent_counterevidence", "尚缺独立反对材料。"],
    ].map(([coverage_key, statement]) => ({
      direction_id: "concept_assess_001",
      coverage_key,
      state: "unknown",
      statement,
      basis_refs: [],
      starting_point: null,
      reasoning: null,
      uncertainty: "当前合成材料不能支持判断。",
      validation_needed: "需要收集对应维度的近期直接商业材料。",
    })),
  ];
  document.ordered_validation_plan = projectedValidationPlan;
  document.freshness = {
    earliest_valid_as_of: "2026-07-25",
    latest_valid_as_of: "2026-07-25",
    summary: "仅引用一条 2026-07-25 的合成来源；不代表真实市场新鲜度。",
  };
  document.limitations = ["合成测试数据；未执行真实调研或外部验证。"];
  document.external_action_boundary = {
    execution_owner: "user",
    execution_supported: false,
    result_tracking_supported: false,
    external_validation_claimed: false,
  };
  document.audit_refs = auditRefs;
  document.research_provenance = {
    available_handoff_count: 0,
    captured_item_count: 0,
    causal_handoff_refs: [],
    consumed_item_refs: [],
    used_handoff_items: [],
    imported_substrate_refs: [],
    formal_inherited_evidence_refs: [],
    adopted_inherited_evidence_refs: [],
    cited_inherited_evidence_refs: [],
    formal_current_evidence_refs: [],
    adopted_current_evidence_refs: [],
    cited_current_evidence_refs: [],
    revalidation_gaps: [],
  };
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: "startup_opportunity.terminal_report_source.v1",
    artifact_path: artifactPath,
    run_id: G14_RUN_ID,
    created_at: "2026-07-25T19:16:00Z",
    producer_role: "main_agent",
    input_refs: [
      ...auditRefs,
      state.decisionSubjectSnapshotRef,
      state.decisionSubjectSynthesisRef,
      subjectRef,
    ].sort(),
    content_hash: canonicalContentHash(document),
    document,
  };
}

async function finalizeTerminalReportEnvelope(
  state: PreparedRun,
  reportEnvelope: FormalArtifactEnvelope,
  prospectiveManifest: Record<string, unknown>,
): Promise<void> {
  const provisionalContext = await state.store.buildValidationContext(G14_RUN_ID, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: "manifest.json", document: prospectiveManifest },
      {
        path: state.decisionSubjectSnapshotEnvelope.artifact_path,
        document: state.decisionSubjectSnapshotEnvelope,
      },
      {
        path: state.decisionSubjectSynthesisEnvelope.artifact_path,
        document: state.decisionSubjectSynthesisEnvelope,
      },
      { path: reportEnvelope.artifact_path, document: reportEnvelope },
    ],
    exact_records: [],
  });
  const provisionalDocuments = provisionalContext.bundle.documents;
  const documentsByPath = new Map(
    provisionalDocuments.map((entry) => [entry.path, effective(entry.document)]),
  );
  const commercialAudits = provisionalDocuments
    .filter((entry) => entry.path.startsWith("artifacts/research-audits/"))
    .map((entry) => ({ auditRef: entry.path, audit: effective(entry.document) }));
  const commercialTasks = provisionalDocuments
    .filter(
      (entry) => entry.path.startsWith("tasks/unit_") && entry.path.endsWith(".attempt-1.json"),
    )
    .map((entry) => ({ taskRef: entry.path, task: effective(entry.document) }));
  const currentDecisionSubjectIds = Array.isArray(
    reportEnvelope.document.current_decision_subject_ids,
  )
    ? reportEnvelope.document.current_decision_subject_ids.filter(
        (subjectId): subjectId is string => typeof subjectId === "string",
      )
    : [];
  Object.assign(
    reportEnvelope.document,
    commercialReportProjection(
      commercialAudits,
      commercialTasks,
      documentsByPath,
      currentDecisionSubjectIds,
    ),
  );
  (reportEnvelope as { content_hash: string }).content_hash = canonicalContentHash(
    reportEnvelope.document,
  );
  const finalizedContext = await state.store.buildValidationContext(G14_RUN_ID, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: "manifest.json", document: prospectiveManifest },
      {
        path: state.decisionSubjectSnapshotEnvelope.artifact_path,
        document: state.decisionSubjectSnapshotEnvelope,
      },
      {
        path: state.decisionSubjectSynthesisEnvelope.artifact_path,
        document: state.decisionSubjectSynthesisEnvelope,
      },
      { path: reportEnvelope.artifact_path, document: reportEnvelope },
    ],
    exact_records: [],
  });
  const provenanceDocuments = finalizedContext.bundle.documents.map((entry) => {
    const document = effective(entry.document);
    const schemaVersion = String(document.schema_version);
    return {
      path: entry.path,
      schemaVersion,
      document,
      envelope: String(entry.document.schema_version).startsWith(
        "startup_opportunity.artifact_envelope.",
      )
        ? entry.document
        : null,
    };
  });
  const exactRecords = finalizedContext.referenceContext.exactJsonlRecords ?? new Map();
  (reportEnvelope.document as Record<string, unknown>).research_provenance =
    deriveResearchProvenance(
      G14_RUN_ID,
      provenanceDocuments,
      exactRecords,
      reportEnvelope.artifact_path,
    );
  (reportEnvelope as { content_hash: string }).content_hash = canonicalContentHash(
    reportEnvelope.document,
  );
}

test("Chinese terminal report localizes quantitative priority and readiness enums", async (context) => {
  const state = await prepareRun(context, { injectHistoricalCompilerWarning: true });
  const source = terminalReportEnvelope(state).document;
  source.research_provenance = {
    available_handoff_count: 0,
    captured_item_count: 0,
    consumed_item_refs: [],
    used_handoff_items: [],
    imported_substrate_refs: [],
    adopted_inherited_evidence_refs: [],
    cited_inherited_evidence_refs: [],
    adopted_current_evidence_refs: [],
    cited_current_evidence_refs: [],
    revalidation_gaps: [],
  };
  source.commercial_subject_aggregates = [
    {
      subject_id: "concept_assess_001",
      market_research_priority: {
        level: "high",
        basis_codes: ["directional_demand_signal", "competitive_scope_disposed"],
      },
      commercial_validation_readiness: {
        level: "not_ready",
        satisfied_dimensions: [],
        missing_dimensions: [
          "candidate_purchase_or_commitment",
          "acquisition_or_distribution",
          "retention_or_usage",
          "unit_economics",
        ],
      },
    },
  ];
  source.quantitative_signal_rows = [
    {
      observation: {
        subject_id: "concept_assess_001",
        metric_family: "demand_scale",
        metric_name: "合成需求代理指标",
        metric_semantics: "search_interest",
        value: { shape: "index", value: 10, unit: "index", index_base: "合成基准", currency: null },
        metric_definition: "仅用于中文渲染测试的合成指标。",
        geography: "中国大陆",
        period: { period_start: null, period_end: null, as_of: "2026-07-25", label: "合成快照" },
        decision_use: { grade: "directional_proxy" },
        measurement_type: "proxy",
        comparability: {
          status: "limited",
          category: "合成类别",
          direct_comparison_allowed: false,
        },
        error_uncertainty: "合成数据，不代表真实市场。",
        evidence_refs: [],
      },
    },
  ];
  source.research_provenance = {
    available_handoff_count: 0,
    captured_item_count: 0,
    consumed_item_refs: [],
    used_handoff_items: [],
    imported_substrate_refs: [],
    adopted_inherited_evidence_refs: [],
    cited_inherited_evidence_refs: [],
    adopted_current_evidence_refs: [],
    cited_current_evidence_refs: [],
    revalidation_gaps: [],
  };
  const brief = renderTerminalDecisionBrief(source);
  const full = renderTerminalFullReport(source);
  for (const markdown of [brief, full]) {
    assert.doesNotMatch(
      markdown,
      /\b(?:high|not_ready|directional_proxy|directional_demand_signal)\b/,
    );
    assert.match(markdown, /市场研究优先级: 高/);
    assert.match(markdown, /商业验证就绪度: 未就绪/);
  }
  assert.match(full, /方向性代理指标/);
});

test("Chinese terminal prose preserves caller-authored research wording without changing audit truth", async (context) => {
  const state = await prepareRun(context);
  const source = terminalReportEnvelope(state).document;
  source.research_provenance = {
    available_handoff_count: 0,
    captured_item_count: 0,
    consumed_item_refs: [],
    used_handoff_items: [],
    imported_substrate_refs: [],
    adopted_inherited_evidence_refs: [],
    cited_inherited_evidence_refs: [],
    adopted_current_evidence_refs: [],
    cited_current_evidence_refs: [],
    revalidation_gaps: [],
  };
  const uncertainty = (source.commercial_uncertainties as Record<string, unknown>[])[0];
  const readableSource = (source.sources as Record<string, unknown>[])[0];
  assert.ok(uncertainty);
  assert.ok(readableSource);
  uncertainty.statement = "Evidence supports only an inferred purchase signal.";
  uncertainty.reasoning = "Harness inference retains exact Evidence refs in the Artifact record.";
  readableSource.claim = "Evidence indicates a current-Run hypothesis, not validation.";
  const inference = readableSource.inference as Record<string, unknown>;
  inference.reasoning = "Harness-owned reasoning cites the exact Evidence Artifact.";
  const structuredTruth = canonicalJson(source);

  const brief = renderTerminalDecisionBrief(source);
  const full = renderTerminalFullReport(source);
  assert.equal(canonicalJson(source), structuredTruth);
  assert.match(full, /Evidence supports only an inferred purchase signal/);
  assert.match(
    `${brief}\n${full}`,
    /Harness inference retains exact Evidence refs in the Artifact record/,
  );
  assert.match(`${brief}\n${full}`, /Evidence indicates a current-Run hypothesis, not validation/);
  assert.match(`${brief}\n${full}`, /Harness-owned reasoning cites the exact Evidence Artifact/);
  assert.deepEqual(localizedTerminalUserViewIssues(source, brief), []);
  assert.deepEqual(localizedTerminalUserViewIssues(source, full), []);
});

test("localized terminal guard does not infer diagnostics from ordinary research prose", () => {
  const source = {
    research_language: "zh-CN",
    sources: [],
    report_citations: [],
    audit_refs: [],
    gate_warnings: [],
  };
  assert.deepEqual(
    localizedTerminalUserViewIssues(
      source,
      "Schema.org Evidence Based Design Vendor Baseline Pro Manifest",
    ),
    [],
  );
  assert.deepEqual(
    localizedTerminalUserViewIssues(
      source,
      "研究材料指出 plans/private-terminal-state.json 是某产品文档中的公开路径。",
    ),
    [],
  );
  assert.deepEqual(
    localizedTerminalUserViewIssues(
      { ...source, audit_refs: ["plans/private-terminal-state.json"] },
      "审计引用占位：plans/private-terminal-state.json",
    ),
    [],
  );
  assert.deepEqual(
    localizedTerminalUserViewIssues(source, "### 1. contract.unit_tuple_not_allowed 协议分析"),
    [],
  );
  assert.deepEqual(
    localizedTerminalUserViewIssues(
      source,
      "合法研究摘要：\n- [warning / decision_validity] contract.unit_tuple_not_allowed 是被研究产品的原文。",
    ),
    [],
  );
  assert.deepEqual(
    localizedTerminalUserViewIssues(
      {
        ...source,
        gate_warnings: [
          {
            code: "terminal_reporting.synthetic_fixture",
            severity: "warning",
            category: "decision_validity",
            message:
              "安全首行\nplans/private-terminal-state.json contract.unit_tuple_not_allowed 决策影响: synthetic",
            decision_impact: "synthetic diagnostic must stay structured",
            artifact_refs: [],
          },
        ],
      },
      "结构化警告的可见形态不再决定 guard 结果。",
    ),
    [],
  );
  assert.deepEqual(
    localizedTerminalUserViewIssues(
      {
        ...source,
        gate_warnings: [
          {
            code: "terminal_reporting.synthetic_fixture",
            severity: "warning",
            category: "decision_validity",
            message: "Inspect plans/private-terminal-state.json.",
            decision_impact: "contract.unit_tuple_not_allowed must stay structured",
            artifact_refs: [],
          },
        ],
      },
      "- [warning / decision_validity] plans/private-terminal-state.json contract.unit_tuple_not_allowed 决策影响: synthetic",
    ),
    [],
  );
});

test("Discovery review audit appendix localizes structured enums without rewriting caller prose", async (context) => {
  const state = await prepareRun(context);
  await markRunTerminal(state);
  const source = structuredClone(terminalReportEnvelope(state).document) as Record<string, unknown>;
  source.research_language = "zh-CN";
  source.research_provenance = {
    available_handoff_count: 0,
    captured_item_count: 0,
    consumed_item_refs: [],
    used_handoff_items: [],
    imported_substrate_refs: [],
    adopted_inherited_evidence_refs: [],
    cited_inherited_evidence_refs: [],
    adopted_current_evidence_refs: [],
    cited_current_evidence_refs: [],
    revalidation_gaps: [],
  };
  const reviewedPlanQuestionRefs = [
    "plans/research-plan.r1.json#question_demand",
    "plans/research-plan.r1.json#question_counterfactual",
  ];
  const callerSummary = "研究材料指出 plans/private-terminal-state.json 是某产品文档中的公开路径。";
  const callerGapSummary = "论文讨论 contract.unit_tuple_not_allowed 这一协议标识，不能改写。";
  const callerStopReason =
    "合法研究摘要：\n- [warning / decision_validity] contract.unit_tuple_not_allowed 是被研究产品的原文。\n## 非阻塞诊断\n## 研究来源沿袭\n## 材料采用、限制与排除";
  const reviewBase = {
    review_ref: "artifacts/reviews/review-enum-matrix.json",
    review_content_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    task_ref: "tasks/discovery/reviews/reviewenum1.attempt-1.json",
    dispatch_batch_ref: "tasks/dispatch/reviewenum1.r1.json#lane_reviewenum1",
    execution_plan_ref: "plans/research-execution.r99.json",
    scope_frame_ref: "scope-frame.json",
    research_plan_ref: "plans/research-plan.r1.json",
    reviewed_plan_question_refs: reviewedPlanQuestionRefs,
    required_stances: ["support", "oppose"],
    owner_role: "adversarial-reviewer",
    authority_boundary: {
      reference_only: true,
      not_gate: true,
      not_ranking: true,
      not_elimination: true,
      not_confidence_ceiling: true,
      mutates_current_plan: false,
      rewrites_report: false,
    },
    valid_as_of: "2026-07-25",
    limitations: [callerSummary, callerGapSummary],
    review_findings: [
      {
        finding_id: "finding_support_supported",
        stance: "support",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "supported",
        summary: callerSummary,
        supporting_refs: ["artifacts/reviews/review-enum-matrix.json#supporting"],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: [callerSummary],
      },
      {
        finding_id: "finding_oppose_partial",
        stance: "oppose",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "partial",
        summary: callerGapSummary,
        supporting_refs: [],
        opposing_refs: ["artifacts/reviews/review-enum-matrix.json#opposing"],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: [callerGapSummary],
      },
      {
        finding_id: "finding_mixed_unknown",
        stance: "mixed",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "unknown",
        summary: "caller prose remains literal",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: ["artifacts/reviews/review-enum-matrix.json#background"],
        contradictory_refs: [],
        unknown_refs: ["artifacts/reviews/review-enum-matrix.json#unknown"],
        limitations: ["caller prose remains literal"],
      },
      {
        finding_id: "finding_background_unavailable",
        stance: "background",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "unavailable",
        summary: "background material remains reference-only",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: ["artifacts/reviews/review-enum-matrix.json#background-2"],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: ["background material remains reference-only"],
      },
      {
        finding_id: "finding_unknown_inferred",
        stance: "unknown",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "inferred",
        summary: "inference remains explicit",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: ["artifacts/reviews/review-enum-matrix.json#contradictory"],
        unknown_refs: [],
        limitations: ["inference remains explicit"],
      },
      {
        finding_id: "finding_support_not_applicable",
        stance: "support",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "not_applicable",
        summary: "not applicable remains visible",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: ["not applicable remains visible"],
      },
      {
        finding_id: "finding_oppose_no_evidence",
        stance: "oppose",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "no_evidence_found",
        summary: "no evidence remains honest",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: ["no evidence remains honest"],
      },
      {
        finding_id: "finding_mixed_insufficient",
        stance: "mixed",
        reviewed_plan_question_refs: reviewedPlanQuestionRefs,
        evidence_state: "insufficient_evidence",
        summary: "insufficient evidence stays distinct",
        supporting_refs: [],
        opposing_refs: [],
        background_refs: [],
        contradictory_refs: [],
        unknown_refs: [],
        limitations: ["insufficient evidence stays distinct"],
      },
    ],
    material_visibility: {
      supporting_refs: ["artifacts/reviews/review-enum-matrix.json#supporting"],
      opposing_refs: ["artifacts/reviews/review-enum-matrix.json#opposing"],
      background_refs: ["artifacts/reviews/review-enum-matrix.json#background"],
      contradictory_refs: ["artifacts/reviews/review-enum-matrix.json#contradictory"],
      unknown_refs: ["artifacts/reviews/review-enum-matrix.json#unknown"],
    },
    decision_relevant_gaps: [
      {
        gap_id: "gap_partial_add",
        state: "partial",
        summary: callerGapSummary,
        basis_refs: ["artifacts/reviews/review-enum-matrix.json#gap-partial"],
        requires_plan_adaptation: true,
        recommended_follow_up: "add_unit",
        limitations: [callerGapSummary],
      },
      {
        gap_id: "gap_unknown_retry",
        state: "unknown",
        summary: callerSummary,
        basis_refs: ["artifacts/reviews/review-enum-matrix.json#gap-unknown"],
        requires_plan_adaptation: true,
        recommended_follow_up: "retry_unit",
        limitations: [callerSummary],
      },
      {
        gap_id: "gap_unavailable_wait",
        state: "unavailable",
        summary: "gap text stays literal",
        basis_refs: ["artifacts/reviews/review-enum-matrix.json#gap-unavailable"],
        requires_plan_adaptation: false,
        recommended_follow_up: "wait",
        limitations: ["gap text stays literal"],
      },
      {
        gap_id: "gap_inferred_manual",
        state: "inferred",
        summary: "manual review remains explicit",
        basis_refs: ["artifacts/reviews/review-enum-matrix.json#gap-inferred"],
        requires_plan_adaptation: false,
        recommended_follow_up: "manual_review",
        limitations: ["manual review remains explicit"],
      },
      {
        gap_id: "gap_not_applicable_noaction",
        state: "not_applicable",
        summary: "no action stays visible",
        basis_refs: ["artifacts/reviews/review-enum-matrix.json#gap-not-applicable"],
        requires_plan_adaptation: false,
        recommended_follow_up: "no_action",
        limitations: ["no action stays visible"],
      },
      {
        gap_id: "gap_noevidence_manual",
        state: "no_evidence_found",
        summary: "no evidence found stays literal",
        basis_refs: ["artifacts/reviews/review-enum-matrix.json#gap-no-evidence"],
        requires_plan_adaptation: true,
        recommended_follow_up: "manual_review",
        limitations: ["no evidence found stays literal"],
      },
      {
        gap_id: "gap_insufficient_retry",
        state: "insufficient_evidence",
        summary: "insufficient evidence remains distinguishable",
        basis_refs: ["artifacts/reviews/review-enum-matrix.json#gap-insufficient"],
        requires_plan_adaptation: true,
        recommended_follow_up: "retry_unit",
        limitations: ["insufficient evidence remains distinguishable"],
      },
    ],
    search_closure: {
      status: "completed",
      acquisition_routes_attempted: ["manual review"],
      adopted_source_refs: ["artifacts/reviews/review-enum-matrix.json#supporting"],
      unresolved_gaps: ["gap_partial_add"],
      stop_reason: callerStopReason,
    },
  };
  const reviewSummaries = [
    {
      ...structuredClone(reviewBase),
      review_result_id: "reviewcompleted",
      status: "completed",
      search_closure: { ...reviewBase.search_closure, status: "completed" },
    },
    {
      ...structuredClone(reviewBase),
      review_result_id: "reviewpartial",
      status: "partial",
      search_closure: { ...reviewBase.search_closure, status: "partial" },
    },
    {
      ...structuredClone(reviewBase),
      review_result_id: "reviewinsufficient",
      status: "insufficient_evidence",
      search_closure: { ...reviewBase.search_closure, status: "insufficient_evidence" },
    },
    {
      ...structuredClone(reviewBase),
      review_result_id: "reviewfailed",
      status: "failed",
      search_closure: { ...reviewBase.search_closure, status: "failed_before_search" },
    },
    {
      ...structuredClone(reviewBase),
      review_result_id: "reviewignored",
      status: "ignored_late",
      search_closure: { ...reviewBase.search_closure, status: "search_not_required" },
    },
    {
      ...structuredClone(reviewBase),
      review_result_id: "reviewsuperseded",
      status: "superseded",
      search_closure: { ...reviewBase.search_closure, status: "unavailable" },
    },
  ];
  source.discovery_review_summaries = reviewSummaries;

  const zhAppendix = renderTerminalAuditAppendix(source);
  const enAppendix = renderTerminalAuditAppendix({ ...source, research_language: "en-US" });

  assert.match(zhAppendix, /负责人角色: 对抗审阅者/);
  assert.match(zhAppendix, /结果状态: 已完成/);
  assert.match(zhAppendix, /结果状态: 部分完成/);
  assert.match(zhAppendix, /结果状态: 证据不足/);
  assert.match(zhAppendix, /结果状态: 失败/);
  assert.match(zhAppendix, /结果状态: 已忽略（迟到）/);
  assert.match(zhAppendix, /结果状态: 已被取代/);
  assert.match(zhAppendix, /要求立场: 支持, 反对/);
  assert.match(zhAppendix, /立场=支持; 材料状态=已支持/);
  assert.match(zhAppendix, /立场=未知; 材料状态=推断/);
  assert.match(zhAppendix, /未找到证据/);
  assert.match(
    zhAppendix,
    /部分完成 \/ 添加任务: 论文讨论 contract\.unit_tuple_not_allowed 这一协议标识，不能改写。/,
  );
  assert.match(
    zhAppendix,
    /未知 \/ 重试任务: 研究材料指出 plans\/private-terminal-state\.json 是某产品文档中的公开路径。/,
  );
  assert.match(zhAppendix, /推断 \/ 人工复核: manual review remains explicit/);
  assert.match(zhAppendix, /终态: 无需搜索/);
  assert.match(zhAppendix, /终态: 搜索前失败/);
  assert.match(zhAppendix, /终态: 证据不足/);
  assert.ok(zhAppendix.includes(callerSummary));
  assert.ok(zhAppendix.includes(callerGapSummary));
  assert.ok(zhAppendix.replaceAll("\n    ", "\n").includes(callerStopReason));
  assert.match(zhAppendix, /\n {4}## 非阻塞诊断\n {4}## 研究来源沿袭/u);
  assert.deepEqual(localizedTerminalUserViewIssues(source, zhAppendix, "audit_appendix"), []);
  assert.equal(zhAppendix.includes("adversarial-reviewer"), false);
  assert.equal(zhAppendix.includes("search_not_required"), false);
  assert.equal(zhAppendix.includes("retry_unit"), false);
  assert.equal(zhAppendix.includes("add_unit"), false);
  assert.equal(zhAppendix.includes("manual_review"), false);

  assert.match(enAppendix, /Owner role: adversarial reviewer/);
  assert.match(enAppendix, /Result status: completed/);
  assert.match(enAppendix, /Result status: partial/);
  assert.match(enAppendix, /Result status: insufficient evidence/);
  assert.match(enAppendix, /Result status: failed/);
  assert.match(enAppendix, /Result status: ignored late/);
  assert.match(enAppendix, /Result status: superseded/);
  assert.match(enAppendix, /Required stances: support, oppose/);
  assert.match(enAppendix, /Stance=support; material state=supported/);
  assert.match(enAppendix, /Stance=unknown; material state=inferred/);
  assert.match(
    enAppendix,
    /partial \/ add unit: 论文讨论 contract\.unit_tuple_not_allowed 这一协议标识，不能改写。/,
  );
  assert.match(
    enAppendix,
    /unknown \/ retry unit: 研究材料指出 plans\/private-terminal-state\.json 是某产品文档中的公开路径。/,
  );
  assert.match(enAppendix, /inferred \/ manual review: manual review remains explicit/);
  assert.match(enAppendix, /Status: search not required/);
  assert.match(enAppendix, /Status: failed before search/);
  assert.match(enAppendix, /Status: insufficient evidence/);
  assert.ok(enAppendix.includes(callerSummary));
  assert.ok(enAppendix.includes(callerGapSummary));
  assert.ok(enAppendix.replaceAll("\n    ", "\n").includes(callerStopReason));
  assert.equal(enAppendix.includes("adversarial-reviewer"), false);
  assert.equal(enAppendix.includes("search_not_required"), false);
  assert.equal(enAppendix.includes("manual_review"), false);

  const invalid = structuredClone(source) as Record<string, unknown>;
  const invalidReview = (invalid.discovery_review_summaries as Record<string, unknown>[])[0];
  assert.ok(invalidReview);
  invalidReview.status = "new_unmapped_status";
  assert.throws(
    () => renderTerminalAuditAppendix(invalid),
    /terminal report review enum mapping is missing for new_unmapped_status/,
  );
});

test("Chinese terminal report renders provisional solution exploration labels", async (context) => {
  const state = await prepareRun(context, { researchLanguage: "zh-CN" });
  await markRunTerminal(state);
  const prospectiveManifest = (await state.store.status(G14_RUN_ID)).manifest;
  const reportEnvelope = terminalReportEnvelope(state);
  await finalizeTerminalReportEnvelope(state, reportEnvelope, prospectiveManifest);
  const baselineValidation = state.validator.validateDocument(
    reportEnvelope,
    reportEnvelope.artifact_path,
  );
  assert.equal(baselineValidation.valid, true, JSON.stringify(baselineValidation, null, 2));
  const baselineContext = await state.store.buildValidationContext(G14_RUN_ID, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: "manifest.json", document: prospectiveManifest },
      {
        path: state.decisionSubjectSnapshotEnvelope.artifact_path,
        document: state.decisionSubjectSnapshotEnvelope,
      },
      {
        path: state.decisionSubjectSynthesisEnvelope.artifact_path,
        document: state.decisionSubjectSynthesisEnvelope,
      },
      { path: reportEnvelope.artifact_path, document: reportEnvelope },
    ],
    exact_records: [],
  });
  const baselineReportEntry = baselineContext.bundle.documents.find(
    (entry) => entry.path === reportEnvelope.artifact_path,
  );
  assert.ok(baselineReportEntry);
  const baselineBundleValidation = state.validator.validateDocumentBundle(
    baselineContext.bundle,
    baselineContext.referenceContext,
  );
  assert.equal(
    baselineBundleValidation.valid,
    true,
    JSON.stringify(baselineBundleValidation, null, 2),
  );
  assert.deepEqual(
    validateDecisionSubjectContract(
      reportingDocuments(baselineContext.bundle.documents),
      baselineContext.referenceContext.exactJsonlRecords,
      baselineContext.referenceContext.artifactPublicationRecords,
    ),
    [],
  );
  await state.runtime.prepareTerminalLocked(state.runRoot, {
    reportEnvelope,
    prospectiveManifest,
    supportingEnvelopes: [],
  });

  const source = structuredClone(reportEnvelope.document) as Record<string, unknown>;
  source.research_provenance = {
    available_handoff_count: 0,
    captured_item_count: 0,
    consumed_item_refs: [],
    used_handoff_items: [],
    imported_substrate_refs: [],
    adopted_inherited_evidence_refs: [],
    cited_inherited_evidence_refs: [],
    adopted_current_evidence_refs: [],
    cited_current_evidence_refs: [],
    revalidation_gaps: [],
  };
  const direction = (source.directions as Record<string, unknown>[])[0];
  assert.ok(direction);
  direction.solution_evaluation_summary = terminalProvisionalSolutionEvaluationSummary();
  const brief = renderTerminalDecisionBrief(source);
  const full = renderTerminalFullReport(source);
  assert.match(brief, /尚未探索其他实现方式/);
  assert.match(brief, /暂定实现/);
  assert.match(
    brief,
    /SYNTHETIC provisional solution behavior\. \(SYNTHETIC solution type; 移动网页; 不使用 AI\)/u,
  );
  assert.doesNotMatch(brief, /SYNTHETIC solution type; mobile_web; 不使用 AI/u);
  assert.match(full, /尚未探索其他实现方式/);
  assert.match(full, /暂定实现/);
  assert.match(
    full,
    /SYNTHETIC provisional solution behavior\. \(SYNTHETIC solution type; 移动网页; 不使用 AI\)/u,
  );
  assert.doesNotMatch(full, /SYNTHETIC solution type; mobile_web; 不使用 AI/u);

  const unknown = structuredClone(source);
  const unknownDirection = (unknown.directions as Record<string, unknown>[])[0];
  assert.ok(unknownDirection);
  const unknownSummary = unknownDirection.solution_evaluation_summary as Record<string, unknown>;
  const unknownSolutions = unknownSummary.formal_solutions as Record<string, unknown>[];
  assert.ok(unknownSolutions[0]);
  unknownSolutions[0].delivery_form = "desktop_app";
  assert.throws(
    () => renderTerminalDecisionBrief(unknown),
    /report localized delivery_form mapping is missing for desktop_app/u,
  );
  assert.throws(
    () => renderTerminalFullReport(unknown),
    /report localized delivery_form mapping is missing for desktop_app/u,
  );
});

test("ReportRuntime preserves legitimate terminal prose while preserving structured truth", async (context) => {
  const state = await prepareRun(context, {
    injectTerminalLocalizationVocabulary: true,
    researchLanguage: "zh-CN",
  });
  await markRunTerminal(state);
  const request = terminalReportEnvelope(state);
  const requestUncertainty = (
    request.document.commercial_uncertainties as Record<string, unknown>[]
  ).find((entry) => entry.coverage_key === "purchase_signal");
  assert.ok(requestUncertainty);
  requestUncertainty.reasoning = TERMINAL_LOCALIZATION_VOCABULARY;
  const requestSource = (request.document.sources as Record<string, unknown>[])[0];
  assert.ok(requestSource);
  requestSource.url = TERMINAL_LOCALIZATION_SOURCE_URL;
  requestSource.claim = TERMINAL_LOCALIZATION_VOCABULARY;
  const requestInference = requestSource.inference as Record<string, unknown>;
  requestInference.reasoning = TERMINAL_LOCALIZATION_VOCABULARY;
  const prospectiveManifest = (await state.store.status(G14_RUN_ID)).manifest;
  await finalizeTerminalReportEnvelope(state, request, prospectiveManifest);
  const requestTruth = canonicalJson(request);
  const operation = await state.runtime
    .prepareTerminalLocked(state.runRoot, {
      reportEnvelope: request,
      prospectiveManifest,
      supportingEnvelopes: [],
    })
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }));
      }
      throw error;
    });
  assert.equal(canonicalJson(request), requestTruth);
  assert.deepEqual(operation.materialized_outputs.map((output) => output.target_path).sort(), [
    "audit-appendix.md",
    "decision-brief.md",
    "report.json",
    "report.md",
  ]);

  const demandAudit = state.commercialAudits.find((entry) =>
    entry.auditRef.endsWith("unit_demand.json"),
  );
  assert.ok(demandAudit);
  const demandCoverage = demandAudit.audit.coverage as Record<string, unknown>;
  const demandInference = (demandCoverage.purchase_signal as Record<string, unknown>)
    .inference as Record<string, unknown>;
  const compiledUncertainty = (
    operation.source_envelope.document.commercial_uncertainties as Record<string, unknown>[]
  ).find((entry) => entry.coverage_key === "purchase_signal");
  assert.ok(compiledUncertainty);
  assert.equal(compiledUncertainty.reasoning, demandInference.reasoning);
  const compiledSource = (
    operation.source_envelope.document.sources as Record<string, unknown>[]
  )[0];
  assert.ok(compiledSource);
  assert.equal(
    (compiledSource.inference as Record<string, unknown>).reasoning,
    requestInference.reasoning,
  );
  const storedDemandAudit = JSON.parse(
    await readFile(path.join(state.runRoot, demandAudit.auditRef), "utf8"),
  ) as FormalArtifactEnvelope;
  assert.equal(canonicalJson(storedDemandAudit.document), canonicalJson(demandAudit.audit));

  const outputs = new Map(
    operation.materialized_outputs.map((output) => [output.target_path, output.bytes]),
  );
  const reportJson = JSON.parse(String(outputs.get("report.json"))) as Record<string, unknown>;
  const jsonUncertainty = (reportJson.commercial_uncertainties as Record<string, unknown>[]).find(
    (entry) => entry.coverage_key === "purchase_signal",
  );
  assert.ok(jsonUncertainty);
  assert.equal(jsonUncertainty.reasoning, TERMINAL_LOCALIZATION_VOCABULARY);
  const markdown = (["decision-brief.md", "report.md", "audit-appendix.md"] as const)
    .map((target) => String(outputs.get(target)))
    .join("\n");
  const userProse = markdown.replaceAll(TERMINAL_LOCALIZATION_SOURCE_URL, "");
  for (const preserved of [
    "Google Cloud Audit Logs helps users inspect changes.",
    "Schema.org vocabulary.",
    "Evidence Based Design.",
    "mobile_web.delivery_form.",
    "open_data.product_protocol.",
  ]) {
    assert.match(userProse, new RegExp(preserved.replaceAll(".", "\\.")));
  }
  for (const target of ["decision-brief.md", "report.md", "audit-appendix.md"] as const) {
    assert.deepEqual(
      localizedTerminalUserViewIssues(
        operation.source_envelope.document,
        String(outputs.get(target)),
        target === "audit-appendix.md"
          ? "audit_appendix"
          : target === "decision-brief.md"
            ? "decision_brief"
            : "report",
      ),
      [],
    );
  }
});

test("ReportRuntime preserves hidden terminal diagnostics without projecting them to Markdown", async (context) => {
  const state = await prepareRun(context, { researchLanguage: "zh-CN" });
  await markRunTerminal(state);
  const request = terminalReportEnvelope(state);
  const execution = request.document.execution as Record<string, unknown>;
  execution.incomplete_stages = [
    ...((execution.incomplete_stages as Record<string, unknown>[]) ?? []),
    {
      stage: "Audit Lane Search Closure",
      cause: "evidence_ceiling",
      detail: "lane_delivery.search_closure_route_missing",
      conclusion_impact: "计划中的搜索完成记录缺失，因此结论保持证据不足。",
      related_refs: [],
    },
  ];
  const runtimeHealth = request.document.runtime_health as Record<string, unknown>;
  runtimeHealth.issues = [
    ...((runtimeHealth.issues as Record<string, unknown>[]) ?? []),
    {
      code: "synthetic_hidden_diagnostic",
      stage: "Audit",
      detail: "lane_delivery.search_closure_route_missing",
      conclusion_impact: "结构化诊断只约束执行披露，不提高结论强度。",
      related_refs: [],
    },
  ];
  (request as { content_hash: string }).content_hash = canonicalContentHash(request.document);
  const prospectiveManifest = (await state.store.status(G14_RUN_ID)).manifest;
  await finalizeTerminalReportEnvelope(state, request, prospectiveManifest);
  const operation = await state.runtime.prepareTerminalLocked(state.runRoot, {
    reportEnvelope: request,
    prospectiveManifest,
    supportingEnvelopes: [],
  });
  const outputs = new Map(
    operation.materialized_outputs.map((output) => [output.target_path, output.bytes]),
  );
  const reportJson = JSON.parse(String(outputs.get("report.json"))) as Record<string, unknown>;
  const jsonExecution = reportJson.execution as Record<string, unknown>;
  const hiddenStage = (jsonExecution.incomplete_stages as Record<string, unknown>[]).find(
    (stage) => stage.detail === "lane_delivery.search_closure_route_missing",
  );
  assert.ok(hiddenStage);
  assert.equal(hiddenStage.stage, "Audit Lane Search Closure");
  const jsonRuntime = reportJson.runtime_health as Record<string, unknown>;
  const hiddenRuntimeIssue = (jsonRuntime.issues as Record<string, unknown>[]).find(
    (issue) => issue.detail === "lane_delivery.search_closure_route_missing",
  );
  assert.ok(hiddenRuntimeIssue);
  assert.equal(hiddenRuntimeIssue.stage, "Audit");

  const markdown = (["decision-brief.md", "report.md", "audit-appendix.md"] as const)
    .map((target) => String(outputs.get(target)))
    .join("\n");
  assert.doesNotMatch(markdown, /Audit Lane Search Closure/u);
  assert.doesNotMatch(markdown, /lane_delivery\.search_closure_route_missing/u);
  assert.match(markdown, /计划中的搜索完成记录缺失/);
  for (const target of ["decision-brief.md", "report.md", "audit-appendix.md"] as const) {
    assert.deepEqual(
      localizedTerminalUserViewIssues(
        operation.source_envelope.document,
        String(outputs.get(target)),
        target === "audit-appendix.md"
          ? "audit_appendix"
          : target === "decision-brief.md"
            ? "decision_brief"
            : "report",
      ),
      [],
    );
  }
});

test("ReportRuntime localizes Harness-owned terminal diagnostics without mutating structured warnings", async (context) => {
  const state = await prepareRun(context, {
    injectHarnessDiagnosticLeak: true,
    researchLanguage: "zh-CN",
  });
  await markRunTerminal(state);
  const request = terminalReportEnvelope(state);
  const prospectiveManifest = (await state.store.status(G14_RUN_ID)).manifest;
  await finalizeTerminalReportEnvelope(state, request, prospectiveManifest);
  const operation = await state.runtime.prepareTerminalLocked(state.runRoot, {
    reportEnvelope: request,
    prospectiveManifest,
    supportingEnvelopes: [],
  });
  const outputs = new Map(
    operation.materialized_outputs.map((output) => [output.target_path, output.bytes]),
  );
  const reportJson = JSON.parse(String(outputs.get("report.json"))) as Record<string, unknown>;
  const warnings = reportJson.gate_warnings as Record<string, unknown>[];
  const unknown = warnings.find(
    (warning) => warning.code === "commercial_research.synthetic_unknown_diagnostic",
  );
  assert.ok(unknown);
  assert.equal(
    unknown.message,
    "Search Closure validator reported terminal_reporting.search_closure_incomplete for the planned Audit Lane.",
  );
  assert.equal(
    unknown.decision_impact,
    "Audit and Search Closure details remain visible only in structured diagnostics.",
  );

  const appendix = String(outputs.get("audit-appendix.md"));
  assert.match(appendix, /研究系统记录了一条非阻塞诊断/);
  assert.doesNotMatch(
    appendix,
    /\b(?:Search Closures?|Audits?|Lanes?|terminal_reporting\.[A-Za-z0-9_.-]+|commercial_research\.[A-Za-z0-9_.-]+)\b/iu,
  );
  assert.deepEqual(
    localizedTerminalUserViewIssues(operation.source_envelope.document, appendix, "audit_appendix"),
    [],
  );

  const enWarning = {
    gate_warnings: [unknown],
  };
  const englishAppendix = renderGateWarnings(enWarning, false);
  assert.match(englishAppendix, /commercial_research\.synthetic_unknown_diagnostic/u);
  assert.match(englishAppendix, /Search Closure validator/u);
});

test("public ReportRuntime rejects terminal sources before any standalone report write", async (context) => {
  const state = await prepareRun(context, { injectHistoricalCompilerWarning: true });
  const reportEnvelope = terminalReportEnvelope(state);
  const before = await snapshotTree(state.runRoot);
  await assert.rejects(
    state.runtime.build({ reportEnvelope }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.terminal_dedicated_entry_required",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), before);
  for (const relativePath of [
    "report.json",
    "decision-brief.md",
    "report.md",
    "audit-appendix.md",
  ]) {
    await assert.rejects(readFile(path.join(state.runRoot, relativePath), "utf8"));
  }
});

test("terminal report derives consistent current and inherited research provenance", async (context) => {
  const state = await prepareRun(context);
  const sourceRunId = "g1-4-handoff-source-synthetic";
  const sourceBundle = await createDiscoveryMapsFixture("general", sourceRunId);
  await createConfirmedRun(state.store, {
    runId: sourceRunId,
    mode: "opportunity_discovery",
    createdAt: "2026-07-25T16:00:00Z",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic prior handoff user"],
      decisionGoal: "provide explicitly authorized prior research context",
      researchLanguage: "en-US",
    },
  });
  await publishInitialPlanBundle(
    state.store,
    sourceRunId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(sourceBundle, ref)),
  );
  await state.store.publishArtifactBundle({
    runId: sourceRunId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(sourceBundle, ref)),
  });
  const sourceEvidenceStore = new EvidenceStore(state.runsRoot);
  const sourceEvidence = await sourceEvidenceStore.record({
    runId: sourceRunId,
    unitId: "unit_prior_handoff_material",
    source: {
      kind: "public_url",
      canonical_url: "https://synthetic.invalid/regulator/vendor-api-proxy",
    },
    researchGoal: "Synthetic provider-agnostic handoff disclosure fixture.",
    rawContent: "SYNTHETIC news, forum, regulator, vendor, API and estimate bytes; not Evidence.",
    recordedAt: "2026-07-25T17:00:00Z",
  });
  const sourceEvidenceRef = `evidence/manifest.jsonl#${sourceEvidence.record.evidence_id}`;
  const sourceEvidenceCapture = await sourceEvidenceStore.readExactCapture(
    sourceRunId,
    sourceEvidenceRef,
  );
  const sourceMapBytes = await readFile(
    path.join(state.runsRoot, sourceRunId, G21_OPPORTUNITY_REF),
  );
  const handoff = await state.store.createResearchHandoff({
    runId: G14_RUN_ID,
    handoffId: "terminal_provenance_synthetic",
    sourceRunId,
    userAuthorizationAttestation:
      "The fixture caller attests explicit user authorization for these exact source items.",
    targetPurpose:
      "Disclose prior synthesis separately and reassess copied Evidence in the target Run.",
    capturedAt: "2026-07-25T19:00:20Z",
    items: [
      {
        itemId: "prior_opportunity_context",
        sourceArtifactPath: G21_OPPORTUNITY_REF,
        role: "revalidation_required",
        expectedSourceByteHash: sha256Bytes(sourceMapBytes),
        expectedSourceContentHash: fixtureEnvelope(sourceBundle, G21_OPPORTUNITY_REF).content_hash,
        freshnessDisposition: "historical",
        applicabilityDisposition: "partially_applicable",
        revalidationStatus: "required",
        targetArtifactRef: "concept-hypothesis.json",
      },
      {
        itemId: "inherited_source_material",
        sourceArtifactPath: sourceEvidenceRef,
        role: "reusable_evidence",
        expectedSourceByteHash: sha256Bytes(sourceEvidenceCapture.recordBytes),
        expectedSourceContentHash: canonicalContentHash(sourceEvidenceCapture.record),
        freshnessDisposition: "current",
        applicabilityDisposition: "applicable",
        revalidationStatus: "not_required",
        targetUnitId: "unit_target_handoff_reassessment",
        targetResearchGoal: "Reassess exact inherited bytes against the target Concept and Scope.",
      },
    ],
  });
  const consumed = await state.store.readResearchHandoff({
    runId: G14_RUN_ID,
    handoffRef: handoff.handoffRef,
    itemIds: ["inherited_source_material"],
    consumedAt: "2026-07-25T19:00:25Z",
  });
  assert.equal(consumed.status, "appended");
  await markRunTerminal(state);

  const replay = await state.store.readResearchHandoff({
    runId: G14_RUN_ID,
    handoffRef: handoff.handoffRef,
    itemIds: ["inherited_source_material"],
    consumedAt: "2026-07-25T19:00:25Z",
  });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.consumptionDecisionHash, consumed.consumptionDecisionHash);
  await assert.rejects(
    state.store.readResearchHandoff({
      runId: G14_RUN_ID,
      handoffRef: handoff.handoffRef,
      itemIds: ["prior_opportunity_context"],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "research_handoff.consumption_closed",
  );

  const drifted = terminalReportEnvelope(state);
  drifted.document.research_provenance = {
    handoff_refs: [],
    inherited_evidence: [],
    current_run_evidence_refs: [],
    prior_synthesis_items: [],
    revalidation_required_items: [],
  };
  (drifted as { content_hash: string }).content_hash = canonicalContentHash(drifted.document);
  await assert.rejects(
    state.store.publishArtifact({ runId: G14_RUN_ID, envelope: drifted }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.terminal_dedicated_entry_required",
  );
  await assert.rejects(
    new ArtifactStore(state.runsRoot, state.validator).publish({
      runId: G14_RUN_ID,
      envelope: drifted,
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.terminal_dedicated_entry_required",
  );
  await assert.rejects(
    state.runtime.build({ reportEnvelope: drifted }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.terminal_dedicated_entry_required",
  );
  await assert.rejects(
    state.runtime.build({ reportEnvelope: terminalReportEnvelope(state) }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.terminal_dedicated_entry_required",
  );
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
    (() => {
      const envelope = structuredClone(base);
      envelope.document.excluded_evidence = [];
      const omittedEvidenceRefs = new Set(
        state.evidenceRefs.filter((ref) => ref !== state.evidenceRef),
      );
      envelope.document.audit_refs = (envelope.document.audit_refs as string[]).filter(
        (ref) => !omittedEvidenceRefs.has(ref),
      );
      Object.assign(envelope, {
        input_refs: envelope.input_refs.filter((ref) => !omittedEvidenceRefs.has(ref)),
      });
      (envelope as { content_hash: string }).content_hash = canonicalContentHash(envelope.document);
      return { envelope, code: "terminal_reporting.evidence_disposition_incomplete" };
    })(),
    (() => {
      const envelope = structuredClone(base);
      envelope.document.commercial_uncertainties = (
        envelope.document.commercial_uncertainties as Record<string, unknown>[]
      ).filter((entry) => entry.coverage_key !== "purchase_signal");
      (envelope as { content_hash: string }).content_hash = canonicalContentHash(envelope.document);
      return { envelope, code: "terminal_reporting.commercial_uncertainty_missing" };
    })(),
  ];
  for (const candidate of invalidSources) {
    const assembled = await state.store.buildValidationContext(G14_RUN_ID, {
      schema_version: "startup_opportunity.document_bundle.current",
      documents: [{ path: candidate.envelope.artifact_path, document: candidate.envelope }],
      exact_records: [],
    });
    const result = validator.validateDocumentBundle(assembled.bundle, assembled.referenceContext);
    assert.equal(result.valid, false, candidate.code);
    assert.ok(
      result.referenceErrors.some((entry) => entry.code === candidate.code),
      JSON.stringify({
        expected: candidate.code,
        codes: result.referenceErrors.map((entry) => entry.code),
      }),
    );
  }

  base.document.research_provenance = {
    handoff_refs: [],
    inherited_evidence: [],
    current_run_evidence_refs: [],
    prior_synthesis_items: [],
    revalidation_required_items: [],
  };
  (base as { content_hash: string }).content_hash = canonicalContentHash(base.document);
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
    schema_version: "startup_opportunity.document_bundle.current",
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

  const localizedBase = structuredClone(base);
  localizedBase.document.research_language = "zh-CN";
  localizedBase.document.gate_warnings = [
    {
      code: "terminal_reporting.search_closure_incomplete",
      severity: "warning",
      category: "integrity",
      message:
        "A planned Search Closure is missing; the report discloses incomplete execution and the related decision limit.",
      decision_impact:
        "A planned Search Closure is missing; the report discloses incomplete execution and the related decision limit.",
      artifact_refs: [],
    },
  ];
  (localizedBase as { content_hash: string }).content_hash = canonicalContentHash(
    localizedBase.document,
  );
  const localizedDerived = deriveReportEnvelopes(localizedBase);
  const rawAppendixView = structuredClone(
    localizedDerived.find(
      (entry) => entry.artifact_type === "startup_opportunity.terminal_report_view.v1",
    ),
  );
  assert.ok(rawAppendixView);
  rawAppendixView.document.audit_appendix_markdown = String(
    rawAppendixView.document.audit_appendix_markdown,
  ).replace(
    renderGateWarnings(localizedBase.document, true).trim(),
    renderGateWarnings(localizedBase.document, false).trim(),
  );
  rawAppendixView.document.audit_appendix_content_hash = sha256Bytes(
    String(rawAppendixView.document.audit_appendix_markdown),
  );
  (rawAppendixView as { content_hash: string }).content_hash = canonicalContentHash(
    rawAppendixView.document,
  );
  const rawAppendixAssembled = await state.store.buildValidationContext(G14_RUN_ID, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [
      { path: localizedBase.artifact_path, document: localizedBase },
      { path: rawAppendixView.artifact_path, document: rawAppendixView },
    ],
    exact_records: [],
  });
  const rawAppendixResult = validator.validateDocumentBundle(
    rawAppendixAssembled.bundle,
    rawAppendixAssembled.referenceContext,
  );
  assert.equal(rawAppendixResult.valid, false);
  assert.ok(
    rawAppendixResult.referenceErrors.some(
      (entry) => entry.code === "terminal_reporting.localized_internal_term",
    ),
  );
  assert.ok(
    rawAppendixResult.referenceErrors.some(
      (entry) => entry.code === "terminal_reporting.derived_drift",
    ),
  );
});

test("terminal Search Closure reconciles every planned lane before or after Task creation", async (context) => {
  const state = await prepareRun(context);
  await markRunTerminal(state);
  const source = terminalReportEnvelope(state);
  const assembled = await state.store.buildValidationContext(G14_RUN_ID, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [{ path: source.artifact_path, document: source }],
    exact_records: [],
  });
  const base = reportingDocuments(assembled.bundle.documents);
  const taskPath = "tasks/unit_counter.attempt-1.json";
  const auditPath = "artifacts/research-audits/unit_counter.json";

  const missingBeforeTask = base.filter(
    (entry) => entry.path !== taskPath && entry.path !== auditPath,
  );
  assert.ok(
    validateTerminalReportingContract(missingBeforeTask)
      .map((issue) => issue.code)
      .includes("terminal_reporting.search_closure_incomplete"),
  );

  const failedBeforeSearch = structuredClone(base).filter((entry) => entry.path !== taskPath);
  const failedAudit = failedBeforeSearch.find((entry) => entry.path === auditPath);
  assert.ok(failedAudit);
  failedAudit.document.task_ref = null;
  const failedClosure = failedAudit.document.search_closure as Record<string, unknown>;
  failedClosure.outcome = "failed_before_search";
  const failedCodes = validateTerminalReportingContract(failedBeforeSearch).map(
    (issue) => issue.code,
  );
  assert.equal(failedCodes.includes("terminal_reporting.search_closure_incomplete"), false);
  assert.equal(failedCodes.includes("terminal_reporting.search_closure_binding_mismatch"), false);

  const assessmentDeliveryBeforeTask = structuredClone(base).filter(
    (entry) => entry.path !== taskPath,
  );
  const assessmentPlan = assessmentDeliveryBeforeTask.find(
    (entry) => entry.path === "plans/research-execution.r1.json",
  );
  assert.ok(assessmentPlan);
  const assessmentStage = (assessmentPlan.document.stages as Record<string, unknown>[])[0];
  assert.ok(assessmentStage);
  assessmentStage.stage_kind = "assessment_delivery";
  const assessmentAudit = assessmentDeliveryBeforeTask.find((entry) => entry.path === auditPath);
  assert.ok(assessmentAudit);
  assessmentAudit.document.task_ref = null;
  const assessmentClosure = assessmentAudit.document.search_closure as Record<string, unknown>;
  assessmentClosure.lane_kind = "synthesis_or_validation";
  assessmentClosure.outcome = "search_not_required";
  assert.ok(
    validateTerminalReportingContract(assessmentDeliveryBeforeTask)
      .map((issue) => issue.code)
      .includes("terminal_reporting.search_closure_binding_mismatch"),
  );

  const synthesisBeforeTask = structuredClone(base).filter((entry) => entry.path !== taskPath);
  const plan = synthesisBeforeTask.find(
    (entry) => entry.path === "plans/research-execution.r1.json",
  );
  assert.ok(plan);
  const stage = (plan.document.stages as Record<string, unknown>[])[0];
  assert.ok(stage);
  stage.stage_kind = "discovery_synthesis";
  for (const audit of synthesisBeforeTask.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.commercial_research_audit.current",
  )) {
    const closure = audit.document.search_closure as Record<string, unknown>;
    closure.lane_kind = "synthesis_or_validation";
    if (audit.path === auditPath) {
      audit.document.task_ref = null;
      closure.outcome = "search_not_required";
    }
  }
  const synthesisCodes = validateTerminalReportingContract(synthesisBeforeTask).map(
    (issue) => issue.code,
  );
  assert.equal(synthesisCodes.includes("terminal_reporting.search_closure_incomplete"), false);
  assert.equal(
    synthesisCodes.includes("terminal_reporting.search_closure_binding_mismatch"),
    false,
  );
});

test("terminal reporting keeps Discovery review visible without requiring a commercial Audit", async (context) => {
  const state = await prepareRun(context);
  await markRunTerminal(state);
  const source = terminalReportEnvelope(state);
  const assembled = await state.store.buildValidationContext(G14_RUN_ID, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [{ path: source.artifact_path, document: source }],
    exact_records: [],
  });
  const base = reportingDocuments(assembled.bundle.documents);
  const reviewedQuestionRefs = [
    "plans/research-plan.r1.json#question_demand",
    "plans/research-plan.r1.json#question_counterfactual",
  ];
  const reviewTaskPath = "tasks/discovery/reviews/unit_terminal_review.attempt-1.json";
  const reviewResultPath = "artifacts/reviews/terminal-adversarial-review.json";
  const reviewExecutionPath = "plans/research-execution.r99.json";
  const reviewTask = {
    schema_version: "startup_opportunity.research_task.discovery_review.current",
    task_id: "task_terminal_review",
    run_id: G14_RUN_ID,
    unit_id: "unit_terminal_review",
    mode: "opportunity_discovery",
    phase: "review",
    wave_id: "wave_terminal_review",
    unit_type: "adversarial_review",
    research_goal: "SYNTHETIC terminal review visibility fixture.",
    commercial_research_requirements: {
      commercial_audit_output_path: "artifacts/research-audits/unit_terminal_review.json",
    },
    scope_frame_ref: "scope-frame.json",
    research_plan_ref: "plans/research-plan.r1.json",
    input_refs: ["plans/research-plan.r1.json"],
    attempt: 1,
    supersedes_task_ref: null,
    agent_role: "adversarial-reviewer",
    source_phase: "adversarial_challenger",
    required_source_group_ids: ["source_group_terminal_review"],
    assigned_plan_question_refs: reviewedQuestionRefs,
    allowed_output_path: reviewResultPath,
    required_artifact_schema: "startup_opportunity.discovery_adversarial_review.current",
    required_stances: ["support", "oppose"],
    stop_conditions: ["SYNTHETIC terminal review stop condition."],
    completion_message_contract: {
      formal_artifact_authority: false,
      include_artifact_path: true,
      include_limitations: true,
    },
    execution_contract: {
      formal_artifacts_explicit: true,
      harness_generated_research: false,
      harness_generated_judgment: false,
      agent_dispatch: false,
      hidden_llm_calls: false,
      network_research: false,
      external_validation: false,
      publication_implies_validation: false,
    },
    dispatched_at: "2026-07-25T19:02:00Z",
  };
  const reviewExecution = {
    schema_version: "startup_opportunity.research_execution_plan.discovery.current",
    run_id: G14_RUN_ID,
    mode: "opportunity_discovery",
    revision: 99,
    research_plan_ref: "plans/research-plan.r1.json",
    stages: [
      {
        stage_id: "stage_terminal_review",
        stage_kind: "review",
        lanes: [
          {
            lane_id: "lane_terminal_review",
            unit_id: "unit_terminal_review",
            lane_role: "review",
            candidate_scope: { kind: "none", candidate_refs: [] },
            incumbent_response_assignment: {
              analysis_depth: "not_assigned",
              assignment_role: "none",
              subject_refs: [],
              rationale: "Discovery review is reference-only and not commercial research.",
            },
            reporting_dimensions: ["adversarial_review"],
            assigned_plan_question_refs: reviewedQuestionRefs,
            submission_path: reviewResultPath,
            submission_schema: "startup_opportunity.discovery_adversarial_review.current",
          },
        ],
      },
    ],
  };
  const reviewResult = {
    schema_version: "startup_opportunity.discovery_adversarial_review.current",
    review_result_id: "review_terminal_visibility",
    run_id: G14_RUN_ID,
    unit_id: "unit_terminal_review",
    status: "partial",
    material_visibility: {
      supporting_refs: [],
      opposing_refs: [],
      background_refs: [],
      contradictory_refs: [],
      unknown_refs: [],
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
  };
  const reviewDocuments: TerminalReportingDocument[] = [
    {
      path: reviewExecutionPath,
      schemaVersion: "startup_opportunity.research_execution_plan.discovery.current",
      document: reviewExecution,
      envelope: null,
    },
    {
      path: reviewTaskPath,
      schemaVersion: "startup_opportunity.research_task.discovery_review.current",
      document: reviewTask,
      envelope: null,
    },
    {
      path: reviewResultPath,
      schemaVersion: "startup_opportunity.discovery_adversarial_review.current",
      document: reviewResult,
      envelope: null,
    },
  ];

  const hiddenReview = [...structuredClone(base), ...reviewDocuments];
  const hiddenCodes = validateTerminalReportingContract(hiddenReview).map((issue) => issue.code);
  assert.ok(hiddenCodes.includes("terminal_reporting.audit_closure_missing"));
  assert.equal(hiddenCodes.includes("terminal_reporting.search_closure_incomplete"), false);

  const visibleReview = [...structuredClone(base), ...reviewDocuments];
  const sourceEntry = visibleReview.find(
    (entry) => entry.schemaVersion === "startup_opportunity.terminal_report_source.v1",
  );
  assert.ok(sourceEntry);
  sourceEntry.document.audit_refs = [
    ...new Set([...(sourceEntry.document.audit_refs as string[]), reviewResultPath]),
  ].sort();
  if (sourceEntry.envelope !== null) {
    sourceEntry.envelope.document = sourceEntry.document;
    sourceEntry.envelope.content_hash = canonicalContentHash(sourceEntry.document);
  }
  const visibleCodes = validateTerminalReportingContract(visibleReview).map((issue) => issue.code);
  assert.equal(visibleCodes.includes("terminal_reporting.audit_closure_missing"), false);
  assert.equal(visibleCodes.includes("terminal_reporting.search_closure_incomplete"), false);

  const missingCommercialAudit = visibleReview.filter(
    (entry) => entry.path !== "artifacts/research-audits/unit_demand.json",
  );
  assert.ok(
    validateTerminalReportingContract(missingCommercialAudit)
      .map((issue) => issue.code)
      .includes("terminal_reporting.search_closure_incomplete"),
  );

  const reviewProjection = createCommercialAuditProjector(
    [],
    [{ path: reviewTaskPath, document: reviewTask }],
  ).project();
  assert.equal(reviewProjection.commercial_research_status.state, "not_planned");
  assert.deepEqual(reviewProjection.commercial_research_status.missing_task_refs, []);
  const commercialTask = base.find((entry) => entry.path === "tasks/unit_demand.attempt-1.json");
  assert.ok(commercialTask);
  const commercialProjection = createCommercialAuditProjector(
    [],
    [{ path: commercialTask.path, document: commercialTask.document }],
    new Map(base.map((entry) => [entry.path, entry.document])),
  ).project(["concept_assess_001"]);
  assert.ok(
    (commercialProjection.commercial_research_status.missing_task_refs as string[]).includes(
      commercialTask.path,
    ),
  );
});

test("public terminal build rejects fault options without creating a partial report", async (context) => {
  const state = await prepareRun(context);
  const before = await snapshotTree(state.runRoot);
  await assert.rejects(
    state.runtime.build({
      reportEnvelope: terminalReportEnvelope(state),
      faultAt: "after_view_materialization",
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.terminal_dedicated_entry_required",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), before);
});

test("decision subject snapshots advance atomically and historical exact replay cannot roll back authority", async (context) => {
  const state = await prepareRun(context);
  const r1Replay = await state.store.publishArtifact({
    runId: G14_RUN_ID,
    envelope: state.decisionSubjectSnapshotEnvelope,
  });
  assert.equal(r1Replay.status, "idempotent_replay");

  const r2Document = structuredClone(state.decisionSubjectSnapshotEnvelope.document);
  r2Document.revision = 2;
  r2Document.parent_snapshot_ref = state.decisionSubjectSnapshotRef;
  r2Document.parent_snapshot_hash = state.decisionSubjectSnapshotHash;
  r2Document.created_at = "2026-07-25T19:01:00Z";
  const r2Envelope = v5Envelope(
    "artifacts/reporting/decision-subject-snapshot.r2.json",
    r2Document,
    "main_agent",
    [
      state.decisionSubjectSnapshotRef,
      "scope-frame.json",
      "plans/research-plan.r1.json",
      G14_ASSESSMENT_REF,
      "concept-hypothesis.json",
    ],
    "2026-07-25T19:01:00Z",
  );
  const r2Publication = await state.store.publishArtifact({
    runId: G14_RUN_ID,
    envelope: r2Envelope,
  });
  assert.equal(r2Publication.status, "published");
  const afterR2 = await state.store.status(G14_RUN_ID);
  assert.equal(afterR2.manifest.current_decision_subject_snapshot_ref, r2Envelope.artifact_path);
  assert.equal(afterR2.manifest.current_decision_subject_snapshot_hash, r2Envelope.content_hash);

  const beforeHistoricalReplay = await snapshotTree(state.runRoot);
  const historicalReplay = await state.store.publishArtifact({
    runId: G14_RUN_ID,
    envelope: state.decisionSubjectSnapshotEnvelope,
  });
  assert.equal(historicalReplay.status, "idempotent_replay");
  assert.deepEqual(await snapshotTree(state.runRoot), beforeHistoricalReplay);
  const afterHistoricalReplay = await state.store.status(G14_RUN_ID);
  assert.equal(
    afterHistoricalReplay.manifest.current_decision_subject_snapshot_ref,
    r2Envelope.artifact_path,
  );
  assert.equal(
    afterHistoricalReplay.manifest.current_decision_subject_snapshot_hash,
    r2Envelope.content_hash,
  );
});

test("Store rejects a Concept assessment revision when the intake r1 lineage is absent", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-concept-lineage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runRoot = path.join(runsRoot, G14_RUN_ID);
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId: G14_RUN_ID,
    mode: "concept_evidence_assessment",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test missing Concept intake lineage",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-25T18:00:00Z",
  });
  const bundle = await createG14ContractBundle("insufficient_evidence");
  await store.publishArtifactBundle({
    runId: G14_RUN_ID,
    envelopes: ["intake.json", "decision-context.json", "scope-frame.json"].map((artifactPath) =>
      v5Envelope(artifactPath, documentAt(bundle, artifactPath)),
    ),
  });
  const scope = JSON.parse(
    await readFile(path.join(runRoot, "scope-frame.json"), "utf8"),
  ) as FormalArtifactEnvelope;
  const conceptR2Document = structuredClone(documentAt(bundle, "concept-hypothesis.json"));
  conceptR2Document.schema_version = "startup_opportunity.concept_hypothesis.assessment.current";
  conceptR2Document.revision = 2;
  conceptR2Document.parent_concept_ref = scope.artifact_path;
  conceptR2Document.parent_content_hash = scope.content_hash;
  conceptR2Document.formation_input_hashes = [
    { ref: scope.artifact_path, content_hash: scope.content_hash },
  ];
  delete conceptR2Document.field_provenance;
  delete conceptR2Document.research_readiness;
  const conceptR2 = v5Envelope(
    "artifacts/assessment/concepts/concept_assess_001.r2.json",
    conceptR2Document,
    "main_agent",
    [scope.artifact_path],
    "2026-07-25T18:01:00Z",
  );
  await assert.rejects(
    store.publishArtifact({ runId: G14_RUN_ID, envelope: conceptR2 }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "artifact.reference_invalid" &&
      storeReferenceCodes(error).includes("assess_contract.concept_revision_lineage_invalid"),
  );
  assert.equal(
    (await store.status(G14_RUN_ID)).manifest.artifact_refs.includes(conceptR2.artifact_path),
    false,
  );
});

test("Store re-forms a Concept only through an explicit post-terminal revision and reopens", async (context) => {
  const state = await prepareRun(context, { omitCommercialAuditUnitId: "unit_demand" });
  const missingAudit = state.omittedCommercialAudit;
  assert.ok(missingAudit);
  const conceptR1 = JSON.parse(
    await readFile(path.join(state.runRoot, "concept-hypothesis.json"), "utf8"),
  ) as FormalArtifactEnvelope;
  const storedScope = JSON.parse(
    await readFile(path.join(state.runRoot, "scope-frame.json"), "utf8"),
  ) as FormalArtifactEnvelope;

  const snapshotR2Ref = "artifacts/reporting/decision-subject-snapshot.r2.json";
  const snapshotR2Document = structuredClone(state.decisionSubjectSnapshotEnvelope.document);
  snapshotR2Document.revision = 2;
  snapshotR2Document.parent_snapshot_ref = state.decisionSubjectSnapshotRef;
  snapshotR2Document.parent_snapshot_hash = state.decisionSubjectSnapshotHash;
  snapshotR2Document.created_at = "2026-07-25T19:01:00Z";
  const terminalSubject = (snapshotR2Document.subjects as Record<string, unknown>[])[0];
  assert.ok(terminalSubject);
  terminalSubject.lifecycle_status = "dropped";
  terminalSubject.reporting_role = "audit_only";
  terminalSubject.lifecycle_reason = "SYNTHETIC terminal state before new commercial analysis.";
  const snapshotR2 = v5Envelope(
    snapshotR2Ref,
    snapshotR2Document,
    "main_agent",
    [
      state.decisionSubjectSnapshotRef,
      "scope-frame.json",
      "plans/research-plan.r1.json",
      G14_ASSESSMENT_REF,
      conceptR1.artifact_path,
    ],
    "2026-07-25T19:01:00Z",
  );
  await state.store.publishArtifact({ runId: G14_RUN_ID, envelope: snapshotR2 });

  const auditDocument = structuredClone(missingAudit.audit) as Record<string, unknown>;
  const auditEvidenceRef = String(
    (auditDocument.evidence_register as Record<string, unknown>[])[0]?.evidence_ref,
  );
  const auditUnitId = String(auditDocument.unit_id);
  const auditEnvelope = v5Envelope(
    missingAudit.auditRef,
    auditDocument,
    "harness",
    [
      "plans/research-execution.r1.json",
      `tasks/dispatch/commercial-research.r1.json#task_${auditUnitId}`,
      String(auditDocument.task_ref),
      auditEvidenceRef,
    ],
    "2026-07-25T19:02:00Z",
  );
  await state.store.publishArtifact({ runId: G14_RUN_ID, envelope: auditEnvelope });

  const conceptR2Ref = "artifacts/assessment/concepts/concept_assess_001.r2.json";
  const storedAssessment = JSON.parse(
    await readFile(path.join(state.runRoot, G14_ASSESSMENT_REF), "utf8"),
  ) as FormalArtifactEnvelope;
  const conceptR2Document = structuredClone(conceptR1.document);
  conceptR2Document.schema_version = "startup_opportunity.concept_hypothesis.assessment.current";
  conceptR2Document.revision = 2;
  conceptR2Document.parent_concept_ref = conceptR1.artifact_path;
  conceptR2Document.parent_content_hash = conceptR1.content_hash;
  conceptR2Document.formation_input_hashes = [
    { ref: G14_ASSESSMENT_REF, content_hash: storedAssessment.content_hash },
    { ref: missingAudit.auditRef, content_hash: auditEnvelope.content_hash },
  ];
  conceptR2Document.assumptions = [
    ...(conceptR2Document.assumptions as string[]),
    "SYNTHETIC post-terminal commercial analysis changes the bounded buyer assumption.",
  ];
  delete conceptR2Document.field_provenance;
  delete conceptR2Document.research_readiness;
  const wrongFormationHash = `sha256:${"0".repeat(64)}`;
  const invalidFormationDocument = structuredClone(conceptR2Document);
  const invalidFormationBindings = invalidFormationDocument.formation_input_hashes as Record<
    string,
    unknown
  >[];
  const stableFormationBinding = invalidFormationBindings.find(
    (binding) => binding.ref === G14_ASSESSMENT_REF,
  );
  assert.ok(stableFormationBinding);
  stableFormationBinding.content_hash = wrongFormationHash;
  const invalidFormationEnvelope = v5Envelope(
    conceptR2Ref,
    invalidFormationDocument,
    "main_agent",
    [conceptR1.artifact_path, "scope-frame.json", G14_ASSESSMENT_REF, missingAudit.auditRef],
    "2026-07-25T19:03:00Z",
  );
  const invalidFormationContext = await state.store.buildValidationContext(G14_RUN_ID, {
    schema_version: "startup_opportunity.document_bundle.current",
    documents: [{ path: conceptR2Ref, document: invalidFormationEnvelope }],
    exact_records: [],
  });
  const invalidFormationBundle = state.validator.validateDocumentBundle(
    invalidFormationContext.bundle,
    invalidFormationContext.referenceContext,
  );
  assert.equal(invalidFormationBundle.valid, false);
  assert.ok(
    invalidFormationBundle.referenceErrors.some(
      (entry) => entry.code === "assess_contract.concept_formation_input_binding_mismatch",
    ),
  );
  await assert.rejects(
    state.store.publishArtifact({
      runId: G14_RUN_ID,
      envelope: invalidFormationEnvelope,
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "artifact.reference_invalid" &&
      storeReferenceCodes(error).includes(
        "assess_contract.concept_formation_input_binding_mismatch",
      ),
  );
  const reopenedAfterInvalidPublication = await new RunStore(state.runsRoot, state.validator).load(
    G14_RUN_ID,
  );
  assert.equal(reopenedAfterInvalidPublication.recovered, false);
  assert.equal(
    reopenedAfterInvalidPublication.manifest.current_decision_subject_snapshot_ref,
    snapshotR2Ref,
  );
  assert.equal(
    reopenedAfterInvalidPublication.manifest.artifact_refs.includes(conceptR2Ref),
    false,
  );
  const expectLineageRejection = async (
    artifactPath: string,
    mutate: (document: Record<string, unknown>) => void,
  ): Promise<void> => {
    const invalidDocument = structuredClone(conceptR2Document);
    mutate(invalidDocument);
    const invalidEnvelope = v5Envelope(
      artifactPath,
      invalidDocument,
      "main_agent",
      [conceptR1.artifact_path, "scope-frame.json", G14_ASSESSMENT_REF, missingAudit.auditRef],
      "2026-07-25T19:03:00Z",
    );
    await assert.rejects(
      state.store.publishArtifact({ runId: G14_RUN_ID, envelope: invalidEnvelope }),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code === "artifact.reference_invalid" &&
        storeReferenceCodes(error).includes("assess_contract.concept_revision_lineage_invalid"),
      artifactPath,
    );
  };
  await expectLineageRejection(conceptR2Ref, (document) => {
    document.parent_content_hash = `sha256:${"0".repeat(64)}`;
  });
  await expectLineageRejection(conceptR2Ref, (document) => {
    document.concept_hypothesis_id = "concept_assess_alias";
  });
  await expectLineageRejection(conceptR2Ref, (document) => {
    document.parent_concept_ref = "scope-frame.json";
    document.parent_content_hash = storedScope.content_hash;
  });
  await expectLineageRejection(
    "artifacts/assessment/concepts/concept_assess_001.r3.json",
    (document) => {
      document.revision = 3;
    },
  );
  const conceptR2 = v5Envelope(
    conceptR2Ref,
    conceptR2Document,
    "main_agent",
    [conceptR1.artifact_path, "scope-frame.json", G14_ASSESSMENT_REF, missingAudit.auditRef],
    "2026-07-25T19:03:00Z",
  );
  await state.store
    .publishArtifact({ runId: G14_RUN_ID, envelope: conceptR2 })
    .catch((error: unknown) => {
      if (error instanceof StoreError) assert.fail(JSON.stringify(error.details, null, 2));
      throw error;
    });

  const reformInput = {
    runId: G14_RUN_ID,
    terminalSnapshotRef: snapshotR2Ref,
    terminalSubjectId: "concept_assess_001",
    reformedSubjectRef: conceptR2Ref,
    reason: "SYNTHETIC post-terminal commercial Audit changed the Concept semantics.",
    reformedAt: "2026-07-25T19:04:00Z",
  } as const;
  const tamperedConceptR2 = structuredClone(conceptR2);
  const tamperedFormationBindings = tamperedConceptR2.document.formation_input_hashes as Record<
    string,
    unknown
  >[];
  const tamperedStableBinding = tamperedFormationBindings.find(
    (binding) => binding.ref === G14_ASSESSMENT_REF,
  );
  assert.ok(tamperedStableBinding);
  tamperedStableBinding.content_hash = wrongFormationHash;
  (tamperedConceptR2 as { content_hash: string }).content_hash = canonicalContentHash(
    tamperedConceptR2.document,
  );
  await writeFile(path.join(state.runRoot, conceptR2Ref), `${canonicalJson(tamperedConceptR2)}\n`);
  await assert.rejects(
    state.store.reformDecisionSubject({
      ...reformInput,
      reformationInputRefs: [missingAudit.auditRef],
    }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "subject_reformation.formation_input_hash_mismatch" &&
      error.details.ref === G14_ASSESSMENT_REF,
  );
  await writeFile(path.join(state.runRoot, conceptR2Ref), `${canonicalJson(conceptR2)}\n`);
  const reopenedAfterInvalidReformation = await new RunStore(state.runsRoot, state.validator).load(
    G14_RUN_ID,
  );
  assert.equal(reopenedAfterInvalidReformation.recovered, false);
  assert.equal(
    reopenedAfterInvalidReformation.manifest.current_decision_subject_snapshot_ref,
    snapshotR2Ref,
  );
  await assert.rejects(
    state.store.reformDecisionSubject({
      ...reformInput,
      reformedSubjectRef: conceptR1.artifact_path,
      reformationInputRefs: [missingAudit.auditRef],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "subject_reformation.revision_lineage_invalid",
  );
  await assert.rejects(
    state.store.reformDecisionSubject({
      ...reformInput,
      reformationInputRefs: [conceptR2Ref],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "subject_reformation.input_unrelated",
  );
  await assert.rejects(
    state.store.reformDecisionSubject({
      ...reformInput,
      reformationInputRefs: [state.decisionSubjectSynthesisRef],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "subject_reformation.input_unrelated",
  );
  await assert.rejects(
    state.store.reformDecisionSubject({
      ...reformInput,
      reformationInputRefs: [G14_ASSESSMENT_REF],
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "subject_reformation.input_not_post_terminal",
  );
  const reformation = await state.store.reformDecisionSubject({
    ...reformInput,
    reformationInputRefs: [missingAudit.auditRef],
  });
  assert.equal(reformation.status, "appended");

  const snapshotR3Ref = "artifacts/reporting/decision-subject-snapshot.r3.json";
  const snapshotR3Document = structuredClone(snapshotR2Document);
  snapshotR3Document.revision = 3;
  snapshotR3Document.parent_snapshot_ref = snapshotR2Ref;
  snapshotR3Document.parent_snapshot_hash = snapshotR2.content_hash;
  snapshotR3Document.created_at = "2026-07-25T19:05:00Z";
  const reformedSubject = (snapshotR3Document.subjects as Record<string, unknown>[])[0];
  assert.ok(reformedSubject);
  reformedSubject.subject_ref = conceptR2Ref;
  reformedSubject.subject_content_hash = conceptR2.content_hash;
  reformedSubject.lifecycle_status = "current";
  reformedSubject.reporting_role = "final";
  reformedSubject.lifecycle_reason = "SYNTHETIC causally re-formed from a post-terminal Audit.";
  reformedSubject.reformation_decision_ref = reformation.decisionRef;
  const snapshotR3 = v5Envelope(
    snapshotR3Ref,
    snapshotR3Document,
    "main_agent",
    [
      snapshotR2Ref,
      "scope-frame.json",
      "plans/research-plan.r1.json",
      G14_ASSESSMENT_REF,
      conceptR2Ref,
      reformation.decisionRef,
    ],
    "2026-07-25T19:05:00Z",
  );
  await state.store.publishArtifact({ runId: G14_RUN_ID, envelope: snapshotR3 });
  const synthesisR2Ref =
    "artifacts/reporting/decision-subject-synthesis/concept-assess-001.r2.json";
  const synthesisR2Document = structuredClone(state.decisionSubjectSynthesisEnvelope.document);
  synthesisR2Document.synthesis_id = "decision_subject_synthesis_concept_assess_001_r2";
  synthesisR2Document.subject_ref = conceptR2Ref;
  synthesisR2Document.subject_content_hash = conceptR2.content_hash;
  synthesisR2Document.synthesis_basis_hashes = [
    { ref: conceptR2Ref, content_hash: conceptR2.content_hash },
    { ref: G14_ASSESSMENT_REF, content_hash: storedAssessment.content_hash },
    { ref: missingAudit.auditRef, content_hash: auditEnvelope.content_hash },
  ];
  synthesisR2Document.created_at = "2026-07-25T19:06:00Z";
  const synthesisR2 = v5Envelope(
    synthesisR2Ref,
    synthesisR2Document,
    "main_agent",
    [conceptR2Ref, G14_ASSESSMENT_REF, missingAudit.auditRef],
    "2026-07-25T19:06:00Z",
  );
  await state.store.publishArtifact({ runId: G14_RUN_ID, envelope: synthesisR2 });
  await state.store.checkpoint({
    runId: G14_RUN_ID,
    checkpointId: "checkpoint_concept_reformation",
    createdAt: "2026-07-25T19:10:00Z",
    nextStep: "SYNTHETIC continue from the exact re-formed Concept authority.",
    beliefSummary: {
      current_belief: "SYNTHETIC Concept was re-formed from post-terminal analysis.",
      evidence_that_changed_belief: [missingAudit.auditRef],
      unchanged_assumptions: ["No market validation is claimed."],
      remaining_disagreement: ["Actual willingness to pay remains unknown."],
      next_decision_relevant_question: "What current Evidence would test the revision?",
    },
    inputRefs: [snapshotR3Ref, reformation.decisionRef],
  });
  const reopened = await new RunStore(state.runsRoot, state.validator).load(G14_RUN_ID);
  assert.equal(reopened.recovered, false);
  assert.equal(reopened.manifest.current_decision_subject_snapshot_ref, snapshotR3Ref);
  assert.equal(reopened.manifest.current_decision_subject_snapshot_hash, snapshotR3.content_hash);

  const reportState: PreparedRun = {
    ...state,
    decisionSubjectSnapshotRef: snapshotR3Ref,
    decisionSubjectSnapshotHash: snapshotR3.content_hash,
    decisionSubjectSnapshotEnvelope: snapshotR3,
    decisionSubjectSynthesisRef: synthesisR2Ref,
    decisionSubjectSynthesisHash: synthesisR2.content_hash,
    decisionSubjectSynthesisEnvelope: synthesisR2,
    commercialAudits: [
      ...state.commercialAudits,
      { auditRef: missingAudit.auditRef, audit: auditDocument },
    ],
  };
  await assert.rejects(
    reportState.runtime.build({ reportEnvelope: terminalReportEnvelope(reportState) }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.terminal_dedicated_entry_required",
  );
});

test("build-report publishes formal sidecars, materializes four outputs, and exactly replays", async (context) => {
  const state = await prepareRun(context, { researchLanguage: "zh-CN" });
  const observations: OperationObservation[] = [];
  const first = await state.runtime.build({
    reportEnvelope: state.reportEnvelope,
    observe: (event) => observations.push(event),
  });
  assert.equal(first.status, "published");
  assert.deepEqual(
    observations.map((entry) => `${entry.phase}:${entry.state}`),
    [
      "operation:started",
      "authority_and_projection:started",
      "authority_and_projection:completed",
      "publication_and_materialization:started",
      "publication_and_materialization:completed",
      "operation:completed",
    ],
  );
  assert.deepEqual(observations.at(-1)?.counts, {
    formal_artifacts: 4,
    materialized_outputs: 4,
  });
  assert.doesNotMatch(JSON.stringify(observations), new RegExp(state.reportEnvelope.artifact_path));
  assert.deepEqual(first.materializedPaths, [
    "report.json",
    "decision-brief.md",
    "report.md",
    "audit-appendix.md",
  ]);
  const reportJson = JSON.parse(
    await readFile(path.join(state.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(reportJson.schema_version, "startup_opportunity.concept_evidence_report.v1");
  assert.equal(reportJson.materialized_path, "report.json");
  const exactConcept = JSON.parse(
    await readFile(path.join(state.runRoot, "concept-hypothesis.json"), "utf8"),
  ) as FormalArtifactEnvelope;
  assert.deepEqual(reportJson.report_subject_labels, [
    {
      subject_id: String(exactConcept.document.concept_hypothesis_id),
      subject_ref: "concept-hypothesis.json",
      subject_content_hash: exactConcept.content_hash,
      label: String(exactConcept.document.product_thesis),
    },
  ]);
  const decisionBrief = await readFile(path.join(state.runRoot, "decision-brief.md"), "utf8");
  const coreReport = await readFile(path.join(state.runRoot, "report.md"), "utf8");
  const appendix = await readFile(path.join(state.runRoot, "audit-appendix.md"), "utf8");
  assert.match(decisionBrief, /# 决策摘要/);
  assert.match(coreReport, /# 产品假设证据评估报告/);
  assert.match(appendix, /# 产品假设证据评估审计附录/);
  assert.match(appendix, /完整头部公司吸收与响应评估/);
  assert.match(appendix, /对象 \/ 深度/);
  for (const surface of [decisionBrief, coreReport, appendix]) {
    assert.doesNotMatch(surface, /artifacts\//u);
  }
  assert.match(
    coreReport,
    /SYNTHETIC assessment_result_and_evidence_strength contract content only/u,
  );
  const storedAudit = JSON.parse(
    await readFile(path.join(state.runRoot, G14_AUDIT_REF), "utf8"),
  ) as FormalArtifactEnvelope;
  const reviewedEvidenceRefs = (storedAudit.document.evidence_reviews as Record<string, unknown>[])
    .map((entry) => String(entry.evidence_ref))
    .sort();
  const dispositions = reportJson.report_evidence_dispositions as Record<string, unknown>[];
  assert.deepEqual(
    dispositions.map((entry) => String(entry.evidence_ref)).sort(),
    reviewedEvidenceRefs,
  );
  assert.ok(
    dispositions.every((entry) => String(entry.evidence_content_hash).startsWith("sha256:")),
  );
  assert.match(appendix, /材料采用、限制与排除/);
  assert.match(appendix, /用户提供\/非公开/);
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
  assert.equal(reopened.lastValidCheckpointRef, "checkpoints/checkpoint-g1-4-report.json");
  assert.equal(reopened.reportRecovery.recoveredFormalArtifactPaths.length, 0);
  assert.equal(reopened.reportRecovery.recoveredMaterializedPaths.length, 0);
});

test("build-report rejects caller-authored Evidence disposition mechanics before writes", async (context) => {
  const state = await prepareRun(context);
  const before = await snapshotTree(state.runRoot);
  for (const tampered of [
    (() => {
      const envelope = structuredClone(state.reportEnvelope);
      envelope.document.report_evidence_dispositions = [
        {
          evidence_ref: state.evidenceRef,
          evidence_content_hash: `sha256:${"0".repeat(64)}`,
          disposition: "included",
          reasons: ["Caller-authored disposition must not replace the Evidence Audit authority."],
          authority_bindings: [],
        },
      ];
      return envelope;
    })(),
    (() => {
      const envelope = structuredClone(state.reportEnvelope);
      envelope.document.report_subject_labels = [
        {
          subject_id: String(state.decisionSubjectSynthesisEnvelope.document.subject_id),
          subject_ref: "artifacts/assessment/concepts/historical.r1.json",
          subject_content_hash: `sha256:${"1".repeat(64)}`,
          label: "Historical label must not replace the exact final revision.",
        },
      ];
      return envelope;
    })(),
    (() => {
      const envelope = structuredClone(state.reportEnvelope);
      envelope.document.report_citations = [
        {
          evidence_ref: state.evidenceRef,
          label: "Forged caller source",
          source_access: "public",
          url: "https://forged.synthetic.invalid/source",
        },
      ];
      return envelope;
    })(),
  ]) {
    (tampered as { content_hash: string }).content_hash = canonicalContentHash(tampered.document);
    await assert.rejects(
      state.runtime.build({ reportEnvelope: tampered }),
      (error: unknown) =>
        error instanceof StoreError && error.code === "report.mechanical_projection_drift",
    );
    assert.deepEqual(await snapshotTree(state.runRoot), before);
  }

  const published = await state.runtime.build({ reportEnvelope: state.reportEnvelope });
  assert.equal(published.status, "published");
  const exact = await snapshotTree(state.runRoot);
  assert.equal(
    (await state.runtime.build({ reportEnvelope: state.reportEnvelope })).status,
    "idempotent_replay",
  );
  assert.deepEqual(await snapshotTree(state.runRoot), exact);
  assert.equal((await state.store.load(G14_RUN_ID)).recovered, false);
});

test("ReportRuntime compiles omitted concept commercial projections from the full Run closure", async (context) => {
  const state = await prepareRun(context);
  const source = structuredClone(state.reportEnvelope);
  const auditRefs = new Set(state.commercialAudits.map((entry) => entry.auditRef));
  source.document.commercial_research_audit_refs = [];
  source.document.quantitative_signal_rows = [];
  source.document.competitive_substitute_rows = [];
  source.document.research_coverage_gaps = [];
  source.document.gate_warnings = [];
  (source as unknown as { input_refs: string[] }).input_refs = source.input_refs.filter(
    (ref) => !auditRefs.has(ref),
  );
  const sourceMetadata = source.document.report_metadata as Record<string, unknown>;
  sourceMetadata.input_artifact_hashes = (
    sourceMetadata.input_artifact_hashes as Record<string, unknown>[]
  ).filter((binding) => !auditRefs.has(String(binding.ref)));
  (source as { content_hash: string }).content_hash = canonicalContentHash(source.document);

  const result = await state.runtime.build({ reportEnvelope: source }).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
    }
    throw error;
  });
  assert.equal(result.status, "published");
  const report = JSON.parse(
    await readFile(path.join(state.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(
    report.commercial_research_audit_refs,
    state.commercialAudits.map((entry) => entry.auditRef).sort(),
  );
  assert.ok((report.research_coverage_gaps as unknown[]).length > 0);
  const projectedMetadata = report.report_metadata as Record<string, unknown>;
  const projectedHashes = projectedMetadata.input_artifact_hashes as Record<string, unknown>[];
  assert.deepEqual(
    projectedHashes
      .filter((binding) => auditRefs.has(String(binding.ref)))
      .map((binding) => ({ ref: binding.ref, content_hash: binding.content_hash })),
    state.commercialAudits
      .map((entry) => ({ ref: entry.auditRef, content_hash: canonicalContentHash(entry.audit) }))
      .sort((left, right) => left.ref.localeCompare(right.ref)),
  );
  assert.equal((await state.runtime.build({ reportEnvelope: source })).status, "idempotent_replay");
});

test("ReportRuntime excludes a formally stored ignored-late commercial Audit", async (context) => {
  const state = await prepareRun(context);
  const currentAuditRef = state.commercialAudits[0]?.auditRef;
  assert.ok(currentAuditRef);
  const storedAudit = JSON.parse(
    await readFile(path.join(state.runRoot, currentAuditRef), "utf8"),
  ) as FormalArtifactEnvelope;
  const ignoredAuditRef = "artifacts/research-audits/ignored-late-extra.json";
  const ignoredDocument = structuredClone(storedAudit.document);
  ignoredDocument.audit_id = "commercial_audit_ignored_late_extra";
  const ignoredClosure = ignoredDocument.search_closure as Record<string, unknown>;
  ignoredClosure.remaining_gaps = (ignoredClosure.remaining_gaps as Record<string, unknown>[]).map(
    (gap) => ({ ...gap, audit_ref: ignoredAuditRef }),
  );
  const ignoredEnvelope: FormalArtifactEnvelope = {
    ...storedAudit,
    artifact_path: ignoredAuditRef,
    created_at: "2026-07-25T18:59:00Z",
    content_hash: canonicalContentHash(ignoredDocument),
    document: ignoredDocument,
  };
  await state.store.publishArtifact({ runId: G14_RUN_ID, envelope: ignoredEnvelope });

  const manifestPath = path.join(state.runRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.artifact_refs = (manifest.artifact_refs as string[]).filter(
    (ref) => ref !== ignoredAuditRef,
  );
  manifest.ignored_late_artifact_refs = [
    ...new Set([...(manifest.ignored_late_artifact_refs as string[]), ignoredAuditRef]),
  ].sort();
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);

  const source = structuredClone(state.reportEnvelope);
  const result = await state.runtime.build({ reportEnvelope: source });
  assert.equal(result.status, "published");
  const report = JSON.parse(
    await readFile(path.join(state.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(
    report.commercial_research_audit_refs,
    state.commercialAudits.map((entry) => entry.auditRef).sort(),
  );
  assert.ok(!(report.commercial_research_audit_refs as string[]).includes(ignoredAuditRef));
});

test("ReportRuntime publishes an explicit warning when a planned commercial Audit is missing", async (context) => {
  const state = await prepareRun(context, { omitCommercialAuditUnitId: "unit_demand" });
  const missingAudit = state.omittedCommercialAudit;
  assert.ok(missingAudit);
  const missingAuditRef = missingAudit.auditRef;
  const missingTaskRef = String(missingAudit.audit.task_ref);

  const source = structuredClone(state.reportEnvelope);
  source.document.commercial_research_audit_refs = [];
  source.document.quantitative_signal_rows = [];
  source.document.competitive_substitute_rows = [];
  source.document.research_coverage_gaps = [];
  source.document.gate_warnings = [];
  (source as unknown as { input_refs: string[] }).input_refs = source.input_refs.filter(
    (ref) => !ref.startsWith("artifacts/research-audits/"),
  );
  const metadata = source.document.report_metadata as Record<string, unknown>;
  metadata.input_artifact_hashes = (
    metadata.input_artifact_hashes as Record<string, unknown>[]
  ).filter((binding) => !String(binding.ref).startsWith("artifacts/research-audits/"));
  (source as { content_hash: string }).content_hash = canonicalContentHash(source.document);

  await assert.rejects(
    state.runtime.build({ reportEnvelope: source, faultAt: "after_view_materialization" }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const recovered = await state.store.load(G14_RUN_ID);
  assert.ok(recovered.manifest.artifact_refs.includes(G14_REPORT_REF));
  assert.ok(recovered.reportRecovery.recoveredFormalArtifactPaths.length > 0);
  const result = await state.runtime.build({ reportEnvelope: source });
  assert.equal(result.status, "idempotent_replay");
  const report = JSON.parse(
    await readFile(path.join(state.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.ok(!(report.commercial_research_audit_refs as string[]).includes(missingAuditRef));
  assert.equal(
    (report.commercial_research_status as Record<string, unknown>).state,
    "planned_but_missing",
  );
  assert.ok(
    (report.research_coverage_gaps as Record<string, unknown>[]).some(
      (row) => row.coverage_kind === "execution" && row.task_ref === missingTaskRef,
    ),
  );
  const markdown = await readFile(path.join(state.runRoot, "report.md"), "utf8");
  assert.doesNotMatch(markdown, /all planned dimensions.*observed/is);
  const appendix = await readFile(path.join(state.runRoot, "audit-appendix.md"), "utf8");
  assert.match(appendix, /execution \/ research/);
  assert.doesNotMatch(appendix, /all planned dimensions.*observed/is);
  const warnings = report.gate_warnings as Record<string, unknown>[];
  for (const code of ["commercial_research.report_audit_closure_incomplete"]) {
    const warning = warnings.find((entry) => entry.code === code);
    assert.ok(warning, code);
    assert.equal(warning.severity, "warning");
    assert.equal(warning.category, "coverage");
    assert.equal(typeof warning.decision_impact, "string");
  }
  const checkpoint = await state.store.checkpoint({
    runId: G14_RUN_ID,
    checkpointId: "checkpoint_g1_4_missing_commercial_audit",
    createdAt: "2026-07-25T19:06:00Z",
    nextStep: "SYNTHETIC retain the disclosed execution gap.",
    beliefSummary: {
      current_belief: "SYNTHETIC report remains honest with one missing Audit.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["No missing result or numeric observation was fabricated."],
      remaining_disagreement: ["The missing research task remains unresolved."],
      next_decision_relevant_question: "Should the user commission more research?",
    },
    inputRefs: result.formalArtifactPaths,
  });
  assert.equal(checkpoint.status, "published");
  const reopened = await new RunStore(state.runsRoot, state.validator).load(G14_RUN_ID);
  assert.equal(
    reopened.lastValidCheckpointRef,
    "checkpoints/checkpoint-g1-4-missing-commercial-audit.json",
  );
  assert.equal(reopened.reportRecovery.recoveredFormalArtifactPaths.length, 0);
});

test("ReportRuntime rejects a concept prioritize conclusion above the compiled ceiling", async (context) => {
  const state = await prepareRun(context);
  const source = structuredClone(state.reportEnvelope);
  const judgment = source.document.curated_judgment_context as Record<string, unknown>;
  judgment.assessment_result = "prioritize";
  (source as { content_hash: string }).content_hash = canonicalContentHash(source.document);
  const before = await snapshotTree(state.runRoot);

  await assert.rejects(state.runtime.build({ reportEnvelope: source }), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, "report.source_invalid");
    const errors = error.details.errors as Record<string, unknown>[];
    assert.ok(
      errors.some((issue) => issue.code === "terminal_reporting.recommendation_ceiling_exceeded"),
    );
    return true;
  });
  assert.deepEqual(await snapshotTree(state.runRoot), before);
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
    const created = await store.create({
      runId,
      mode: "concept_evidence_assessment",
      scopeProposal: {
        geography: "Synthetic",
        customerModel: "b2c",
        targetUsers: ["synthetic user"],
        decisionGoal: "verify report runtime import order",
        researchLanguage: "en-US",
      },
      createdAt: "2026-07-25T18:00:00Z",
    });
    await store.confirmScope({
      runId,
      expectedScopeProposalRevision: created.manifest.scope_revision,
      expectedScopeProposalRef: created.scopeProposalRef,
      expectedScopeProposalHash: created.scopeProposalHash,
      confirmedAt: "2026-07-25T18:00:01Z",
      userConfirmationAttestation: "Fixture caller attests exact user confirmation.",
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

test("G1.R reclaims incomplete current Run and report locks before build and reopen", async (context) => {
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
    "after_appendix_materialization",
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
      for (const outputPath of [
        "report.json",
        "decision-brief.md",
        "report.md",
        "audit-appendix.md",
      ]) {
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
  await assert.rejects(
    state.runtime.build({
      reportEnvelope: state.reportEnvelope,
      faultAt: "after_report_sidecar",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const published = JSON.parse(
    await readFile(path.join(state.runRoot, state.reportEnvelope.artifact_path), "utf8"),
  ) as FormalArtifactEnvelope;
  const conflicting = structuredClone(published);
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
  assert.deepEqual(result.materializedPaths, [
    "report.json",
    "decision-brief.md",
    "report.md",
    "audit-appendix.md",
  ]);

  const terminalPath = path.join(path.dirname(state.runsRoot), "terminal-report-envelope.json");
  await writeFile(terminalPath, `${canonicalJson(terminalReportEnvelope(state))}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "harness/src/cli.ts",
        "build-report",
        "--file",
        terminalPath,
        "--runs-root",
        state.runsRoot,
        "--json",
      ],
      { cwd: repositoryRoot },
    ),
    (error: unknown) => {
      assert.ok(isRecord(error));
      const stderr = String(error.stderr ?? "");
      const failure = JSON.parse(stderr) as { error: { code: string } };
      assert.equal(failure.error.code, "report.terminal_dedicated_entry_required");
      return true;
    },
  );
});

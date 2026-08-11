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
  commercialReportProjection,
  unavailableQuantitativeCompetitiveCoverage,
  unavailableSubjectAssessments,
} from "./fixtures/quantitative-competitive-fixture.js";
import { createConfirmedRun } from "./helpers/current-run.js";

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
      researchLanguage: "en-US",
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
  await store
    .publishArtifactBundle({
      runId: G14_RUN_ID,
      envelopes: corePaths
        .map((artifactPath) => v5Envelope(artifactPath, documentAt(bundle, artifactPath)))
        .concat(executionPlanEnvelope(bundle)),
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
    const commercialAudit = commercialAuditEnvelope(
      branch,
      evidencePaths[0] as string,
      support.record.recorded_at,
    );
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
        reformation_basis_hashes: [],
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
  const auditRefs = [G14_ASSESSMENT_REF, ...commercialAuditRefs, ...state.evidenceRefs].sort();
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
    decision_subject_snapshot_ref: state.decisionSubjectSnapshotRef,
    decision_subject_snapshot_hash: state.decisionSubjectSnapshotHash,
    current_decision_subject_ids: ["concept_assess_001"],
    terminal_outcome: "insufficient_evidence",
    decision_question: "这个合成的窄方向是否值得继续调研？",
    execution: {
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
          stage: "买方追加调研",
          detail: "合成的确定性发布故障阻止了必需的追加调研。",
          conclusion_impact: "结论强度被限制为证据不足。",
          related_refs: [G14_ASSESSMENT_REF],
        },
      ],
    },
    directions: [
      {
        direction_id: "concept_assess_001",
        subject_ref: "concept-hypothesis.json",
        subject_content_hash: String(
          (state.decisionSubjectSnapshotEnvelope.document.subjects as Record<string, unknown>[])[0]
            ?.subject_content_hash,
        ),
        synthesis_basis_hashes: [
          {
            ref: "concept-hypothesis.json",
            content_hash: String(
              (
                state.decisionSubjectSnapshotEnvelope.document.subjects as Record<string, unknown>[]
              )[0]?.subject_content_hash,
            ),
          },
        ],
        priority: null,
        ranking_status: "unranked_hypothesis",
        label: "消费者家庭可以通过共享工作流降低协同遗漏",
        maturity: "testable_product_hypothesis",
        action: "validate",
        target_user: "需要家庭协同的消费者",
        narrow_scenario: "家庭成员需要确认共同任务是否完成时",
        problem: "消费者家庭可以通过共享工作流降低协同遗漏",
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
      },
    ],
    sources: [
      {
        source_id: "synthetic_support",
        title: "Synthetic contract source",
        url: "https://unit_demand.synthetic.invalid/support",
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
    ],
    excluded_evidence: state.evidenceRefs
      .filter((ref) => ref !== state.evidenceRef)
      .map((evidence_ref) => ({
        evidence_ref,
        reason: "该材料不是本次终态结论的决定性来源，但保留在完整审计范围中。",
      })),
    commercial_research_audit_refs: commercialAuditRefs,
    commercial_uncertainties: [
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
    ],
    ...commercialReportProjection(state.commercialAudits),
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
      summary: "仅引用一条 2026-07-25 的合成来源；不代表真实市场新鲜度。",
    },
    limitations: ["合成测试数据；未执行真实调研或外部验证。"],
    external_action_boundary: {
      execution_owner: "user",
      execution_supported: false,
      result_tracking_supported: false,
      external_validation_claimed: false,
    },
    audit_refs: auditRefs,
  };
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: "startup_opportunity.terminal_report_source.v1",
    artifact_path: artifactPath,
    run_id: G14_RUN_ID,
    created_at: "2026-07-25T19:16:00Z",
    producer_role: "main_agent",
    input_refs: [...auditRefs, state.decisionSubjectSnapshotRef, "concept-hypothesis.json"].sort(),
    content_hash: canonicalContentHash(document),
    document,
  };
}

test("terminal finalizer produces a localized decision-first brief with readable sources and hypotheses", async (context) => {
  const state = await prepareRun(context, { injectHistoricalCompilerWarning: true });
  await markRunTerminal(state);
  const reportEnvelope = terminalReportEnvelope(state);
  reportEnvelope.document.commercial_research_audit_refs = [];
  reportEnvelope.document.quantitative_signal_rows = [];
  reportEnvelope.document.competitive_substitute_rows = [];
  reportEnvelope.document.research_coverage_gaps = [];
  reportEnvelope.document.gate_warnings = [];
  (reportEnvelope as unknown as { input_refs: string[] }).input_refs =
    reportEnvelope.input_refs.filter((ref) => !ref.startsWith("artifacts/research-audits/"));
  (reportEnvelope as { content_hash: string }).content_hash = canonicalContentHash(
    reportEnvelope.document,
  );
  const result = await state.runtime.build({ reportEnvelope }).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
    }
    throw error;
  });
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
  assert.match(brief, /商业判断中的推测与未知/);
  assert.match(brief, /推测：当前行为可能反映购买意向/);
  assert.match(brief, /未知：尚不清楚目标用户如何描述该问题/);
  assert.match(brief, /推理起点/);
  assert.match(brief, /不确定性/);
  assert.doesNotMatch(brief.split("## 审计附录", 1)[0] ?? "", /artifacts\//);
  assert.doesNotMatch(brief, /insufficient_evidence|execution_supported: false/);
  assert.doesNotMatch(brief, /plan_revision_failed|确定性发布故障|买方追加调研/);
  assert.doesNotMatch(brief, /historical-only warning/);
  assert.doesNotMatch(
    brief,
    /\b(?:same-Run|pre-thesis|baseline|counterfactual|Evidence|Harness|Artifact|opportunity_discovery|concept_evidence_assessment|runtime_blocked|not_executed)\b/u,
  );
  const reportJson = JSON.parse(
    await readFile(path.join(state.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(reportJson.schema_version, "startup_opportunity.terminal_report_source.v1");
  assert.deepEqual(reportJson.current_decision_subject_ids, ["concept_assess_001"]);
  const direction = (reportJson.directions as Record<string, unknown>[])[0];
  assert.ok(direction);
  assert.deepEqual(
    Object.fromEntries(
      [
        "direction_id",
        "subject_ref",
        "label",
        "target_user",
        "narrow_scenario",
        "problem",
        "current_alternative",
        "payer",
        "product_form",
        "core_value",
      ].map((field) => [field, direction[field]]),
    ),
    {
      direction_id: "concept_assess_001",
      subject_ref: "concept-hypothesis.json",
      label: "消费者家庭可以通过共享工作流降低协同遗漏",
      target_user: "需要家庭协同的消费者",
      narrow_scenario: "家庭成员需要确认共同任务是否完成时",
      problem: "消费者家庭可以通过共享工作流降低协同遗漏",
      current_alternative: "即时通讯 | 备忘录 | 维持现状",
      payer: "家庭付款者",
      product_form: "mini_program",
      core_value: "降低重复沟通与遗漏",
    },
  );
  assert.deepEqual(
    reportJson.commercial_research_audit_refs,
    state.commercialAudits.map((entry) => entry.auditRef).sort(),
  );
  assert.equal(
    (reportJson.gate_warnings as Record<string, unknown>[]).some((warning) =>
      String(warning.message).includes("historical-only warning"),
    ),
    false,
  );
  for (const branch of g14Branches()) {
    assert.ok(
      (reportJson.audit_refs as string[]).includes(`tasks/${branch.unitId}.attempt-1.json`),
    );
  }
  const coverageGaps = reportJson.research_coverage_gaps as Record<string, unknown>[];
  assert.ok(coverageGaps.length > 0);
  assert.ok(
    coverageGaps.some(
      (gap) =>
        gap.coverage_kind === "business" &&
        gap.dimension === "recent_user_language" &&
        (gap.subject_ids as string[]).length === 1,
    ),
  );
  const reportMarkdown = await readFile(path.join(state.runRoot, "report.md"), "utf8");
  assert.match(reportMarkdown, /No direct recent_user_language material was available/);
  for (const rendered of [brief, reportMarkdown]) {
    assert.match(rendered, /消费者家庭可以通过共享工作流降低协同遗漏/);
    assert.match(rendered, /需要家庭协同的消费者/);
    assert.match(rendered, /家庭成员需要确认共同任务是否完成时/);
    assert.match(rendered, /即时通讯 \| 备忘录 \| 维持现状/);
    assert.match(rendered, /家庭付款者/);
    assert.match(rendered, /mini_program/);
    assert.match(rendered, /降低重复沟通与遗漏/);
    assert.doesNotMatch(rendered, /正在完成一次明确职业转换|目标岗位到实践任务/);
  }
  assert.ok(
    (reportJson.gate_warnings as Record<string, unknown>[]).some(
      (warning) =>
        warning.code === "commercial_research.independent_cross_validation_missing" &&
        warning.severity === "warning",
    ),
  );
  await state.store.load(G14_RUN_ID).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
    }
    throw error;
  });
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
  const recoveredReport = JSON.parse(
    await readFile(path.join(state.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.ok((recoveredReport.audit_refs as string[]).includes("tasks/unit_demand.attempt-1.json"));
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
  assert.equal(reopened.lastValidCheckpointRef, "checkpoints/checkpoint-g1-4-report.json");
  assert.equal(reopened.reportRecovery.recoveredFormalArtifactPaths.length, 0);
  assert.equal(reopened.reportRecovery.recoveredMaterializedPaths.length, 0);
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
    "planned_with_gaps",
  );
  assert.ok(
    (report.research_coverage_gaps as Record<string, unknown>[]).some(
      (row) => row.coverage_kind === "execution" && row.task_ref === missingTaskRef,
    ),
  );
  const markdown = await readFile(path.join(state.runRoot, "report.md"), "utf8");
  assert.match(markdown, /execution \/ research/);
  assert.doesNotMatch(markdown, /all planned dimensions.*observed/is);
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
  assert.deepEqual(result.materializedPaths, ["report.json", "decision-brief.md", "report.md"]);
});

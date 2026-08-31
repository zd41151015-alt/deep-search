import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  createArtifactValidator,
  EvidenceStore,
  type FormalArtifactEnvelope,
  FormalStageMaterializer,
  LaneResultMaterializer,
  RunStore,
  StoreError,
} from "../harness/src/index.js";
import { createFormalStageRuntimeCompiler } from "../harness/src/runtime/declarative-runtime.js";
import {
  deriveLaneScopeFormalClosure,
  laneScopeCoverageFromClosure,
} from "../harness/src/runtime/lane-delivery-closure.js";
import {
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
  G21_PLAN_REF,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  createDiscoveryCandidateFixture,
  fixtureEffective,
  fixtureEntry,
  G22_GENERATION_EVIDENCE,
  G22_GENERATION_LANE,
  G22_GENERATION_TASK,
  G22_PRE_CANDIDATE_RELATION,
  G22_REJECTED_PRE_CANDIDATE,
  G22_RETAINED_PRE_CANDIDATE,
  G22_WATCHLIST_PRE_CANDIDATE,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";
import { createDiscoveryRuntimeFixture } from "./fixtures/g2.2/discovery-runtime-fixture.js";
import { discoverySynthesisReadinessEnvelopes } from "./fixtures/g2.3/discovery-synthesis-fixture.js";
import {
  createDiscoveryEvaluationFixture,
  G24_BRANCH_SUPPORT,
  G24_CLAIM_SUPPORT,
  G24_EVIDENCE_SUPPORT,
  G24_FINDING_SUPPORT,
  G24_INSIGHT_SUPPORT,
  G24_JUDGMENT_A_SUPPORT,
  G24_JUDGMENT_B_SUPPORT,
  G24_MANIFEST_SUPPORT,
  G24_TASK_SUPPORT,
} from "./fixtures/g2.4/discovery-evaluation-fixture.js";
import { createConfirmedRun, publishInitialPlanBundle } from "./helpers/current-run.js";
import { discoveryWaveEnvelopes } from "./helpers/discovery-wave.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const createdAt = "2026-08-19T09:00:00Z";

async function snapshotTree(root: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else snapshot[path.relative(root, absolute)] = await readFile(absolute, "utf8");
    }
  }
  await visit(root);
  return snapshot;
}

async function writeLaneStagingFile(
  runRoot: string,
  task: FormalArtifactEnvelope,
  staging: Record<string, unknown>,
): Promise<string> {
  const contract = task.document.lane_submission_contract as Record<string, unknown>;
  const sourcePath = path.join(runRoot, String(contract.staging_output_path));
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, `${JSON.stringify(staging, null, 2)}\n`);
  return sourcePath;
}

async function publishRuntimeEnvelopesAsFormalStage(
  input: {
    readonly runsRoot: string;
    readonly runId: string;
    readonly validator: Awaited<ReturnType<typeof createArtifactValidator>>;
  },
  envelopes: readonly FormalArtifactEnvelope[],
  requestId: string,
) {
  const compiler = createFormalStageRuntimeCompiler(
    input.runsRoot,
    input.validator,
    repositoryRoot,
  );
  return compiler.compile({
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: requestId,
    run_id: input.runId,
    operation: "publish",
    created_at: String(envelopes[0]?.created_at ?? createdAt),
    artifacts: envelopes.map((envelope) => ({
      artifact_type: envelope.artifact_type,
      artifact_path: envelope.artifact_path,
      producer_role: envelope.producer_role,
      input_refs: envelope.input_refs,
      document: envelope.document,
    })),
  });
}

async function prepareGenerationResultRun(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-generation-lane-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "generation-lane-materialization";
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test generation Lane formal materialization",
      researchLanguage: "en-US",
    },
    createdAt,
  });
  const evidence = new EvidenceStore(runsRoot);
  const generation = (
    await evidence.record({
      runId,
      unitId: "unit_seed_independent_demand",
      acquisitionGoal: "SYNTHETIC generation substrate; not Evidence.",
      source: {
        kind: "user_provided",
        canonical_uri: "urn:startup-opportunity:user-provided:generation-lane-materialization",
      },
      rawContent: "SYNTHETIC generation bytes; not Evidence.",
      recordedAt: createdAt,
    })
  ).record;
  const evaluation = (
    await evidence.record({
      runId,
      unitId: "unit_counterfactual",
      acquisitionGoal: "SYNTHETIC evaluation substrate; not Evidence.",
      source: {
        kind: "user_provided",
        canonical_uri:
          "urn:startup-opportunity:user-provided:generation-lane-materialization-evaluation",
      },
      rawContent: "SYNTHETIC evaluation bytes; not Evidence.",
      recordedAt: createdAt,
    })
  ).record;
  const bundle = await createDiscoveryRuntimeFixture(
    runId,
    { generation, evaluation },
    [],
    "general",
    true,
  );
  const planEnvelope = fixtureEnvelope(bundle, G21_PLAN_REF);
  const plan = planEnvelope.document as Record<string, unknown>;
  for (const wave of plan.waves as Record<string, unknown>[]) {
    for (const unit of wave.units as Record<string, unknown>[]) {
      if (unit.unit_id !== "unit_seed_independent_demand") continue;
      unit.output_path = "artifacts/discovery/generation/unit_seed_independent_demand.r1.json";
      unit.required_artifact_schema = "startup_opportunity.discovery_generation_result.v1";
    }
  }
  (planEnvelope as { content_hash: string }).content_hash = canonicalContentHash(plan);
  await publishInitialPlanBundle(
    store,
    runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  );
  const taskTemplate = fixtureEffective(bundle, G22_GENERATION_TASK);
  const commercial = taskTemplate.commercial_research_requirements as Record<string, unknown>;
  const quantitativeCompetitiveScope = commercial.quantitative_competitive_scope as Record<
    string,
    unknown
  >;
  const waveRequest = {
    schema_version: "startup_opportunity.formal_stage_materialization_request.current",
    request_id: "generation_lane_wave",
    run_id: runId,
    operation: "validate_only",
    created_at: "2026-08-19T09:01:00Z",
    stage_kind: "discovery_wave",
    wave: {
      wave_id: "wave_discovery_synthetic",
      stage_id: "stage_generation_lane",
      stage_kind: "discovery_generation",
      unit_ids: ["unit_seed_independent_demand"],
      lanes: [
        {
          unit_id: "unit_seed_independent_demand",
          lane_role: "opportunity",
          candidate_scope: { kind: "none", candidate_refs: [] },
          incumbent_response_assignment: {
            analysis_depth: "not_assigned",
            assignment_role: "none",
            subject_refs: [],
            rationale: "Candidate-neutral generation does not own incumbent response research.",
          },
          reporting_dimensions: ["recent_user_language"],
          time_budget_minutes: 10,
          max_sources: 5,
          straggler_policy: {
            on_timeout: "publish_partial",
            grace_minutes: 2,
            blocks_stage: false,
          },
          commercial_research_semantics: {
            research_stage: commercial.research_stage,
            planned_queries: commercial.planned_queries,
            quantitative_competitive_scope: {
              ...quantitativeCompetitiveScope,
              required_metric_families: [],
              required_competitor_types: [],
            },
            required_commercial_dimensions: ["recent_user_language"],
            commercial_audit_output_path: commercial.commercial_audit_output_path,
          },
          task_semantics: {
            target_candidate_refs: [],
            source_phase: "candidate_generation",
            required_source_group_ids: ["source_group_generation_materializer"],
            required_stances: ["support", "oppose"],
            stop_conditions: ["Stop at the explicit source and time budget."],
            execution_contract: taskTemplate.execution_contract,
          },
        },
      ],
      research_depth: "quick",
      total_time_budget_minutes: 10,
      resource_allocation: commercial.resource_allocation,
      gate_before: null,
      gate_after: "none",
      limitations: ["SYNTHETIC generation lane fixture; no external research was performed."],
    },
  };
  const stage = new FormalStageMaterializer(runsRoot, validator, repositoryRoot);
  const validated = await stage.materialize(waveRequest);
  const published = await stage.materialize({
    ...waveRequest,
    operation: "publish",
    publication_plan: validated.compilation.publication_plan,
  });
  const taskEnvelope = published.compilation.compiled_envelopes.find(
    (entry) => entry.document.unit_id === "unit_seed_independent_demand",
  ) as FormalArtifactEnvelope | undefined;
  assert.ok(taskEnvelope);
  return { root, runsRoot, runId, runRoot: path.join(runsRoot, runId), validator, taskEnvelope };
}

function generationLaneStaging(
  runId: string,
  taskRef: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const sourceManifestRef =
    "evidence/source-manifests/discovery/source_manifest_generation_materializer.json";
  const laneResult = {
    status: "insufficient_evidence",
    source_manifest_ref: sourceManifestRef,
    evidence_refs: [],
    judgment_assessment_refs: [],
    candidate_proposals: [
      {
        proposal_id: "proposal_generation_unknown",
        candidate_kind: "demand_seed",
        subject: "SYNTHETIC weak candidate-neutral generation subject.",
        basis_refs: [],
        evidence_refs: [],
        limitations: ["No Evidence was found; the proposal remains insufficient."],
      },
    ],
    target_candidate_refs: [],
    solution_refs: [],
    open_questions: ["What direct Evidence would support or oppose this demand seed?"],
    limitations: [
      "The generation result is explicit insufficient_evidence and does not claim validation.",
    ],
    ...overrides,
  };
  return {
    schema_version: "startup_opportunity.lane_staging_document.current",
    staging_id: "staging_generation_result_projection",
    run_id: runId,
    task_ref: taskRef,
    created_at: "2026-08-19T09:02:00Z",
    producer_role: "lane_researcher",
    operation: "validate_only",
    evidence_receipt_refs: [],
    delivery_contract: {
      search_closure: {
        status: "completed",
        acquisition_routes_attempted: ["user_provided"],
        unresolved_gaps: ["No direct Evidence was available in the bounded fixture."],
        stop_reason: "The explicit synthetic budget was reached.",
      },
    },
    agent_documents: [
      {
        artifact_family: "source_manifest",
        document: {
          manifest_id: "source_manifest_generation_materializer",
          research_phase_role: "candidate_generation",
          accepted_evidence_refs: [],
          canonical_source_groups: [],
          shared_dataset_groups: [],
          duplicate_or_syndication_groups: [],
          source_type_coverage: [],
          geo_language_coverage: ["Synthetic en-US fixture only."],
          time_coverage: {
            earliest_valid_as_of: null,
            latest_valid_as_of: null,
            accepted_evidence_count: 0,
          },
          stance_coverage: [],
          known_source_blind_spots: ["No independent source was available."],
          freshness_summary: { active: 0, stale: 0, unverified: 0, superseded: 0 },
          limitations: ["The source manifest is intentionally empty and insufficient."],
        },
      },
      { artifact_family: "lane_result", document: laneResult },
      {
        artifact_family: "commercial_audit",
        document: {
          audited_at: "2026-08-19T09:02:00Z",
          research_objectives: ["Disclose unavailable commercial Evidence."],
          primary_routes: ["Caller-provided synthetic material only."],
          search_results: [],
          evidence_sources: [],
          findings: [],
          claims: [],
          judgments: [],
          quantitative_observations: [],
          competitive_observations: [],
          incumbent_response_assessments: [],
          unresolved_gaps: [],
          limitations: ["No commercial conclusion is upgraded."],
          stop_reason: "No current commercial Evidence was available.",
          telemetry_basis: "unavailable",
          query_log_complete: false,
        },
      },
    ],
  };
}

function effectiveDocumentFromBundle(
  bundle: Readonly<{
    readonly documents: readonly {
      readonly path: string;
      readonly document: Record<string, unknown>;
    }[];
  }>,
  artifactPath: string,
): Record<string, unknown> {
  const entry = bundle.documents.find((candidate) => candidate.path === artifactPath);
  assert.ok(entry, artifactPath);
  return String(entry.document.schema_version).startsWith("startup_opportunity.artifact_envelope.")
    ? (entry.document.document as Record<string, unknown>)
    : entry.document;
}

function envelopesByType(
  bundle: Readonly<{
    readonly documents: readonly { readonly document: Record<string, unknown> }[];
  }>,
  ...artifactTypes: readonly string[]
): FormalArtifactEnvelope[] {
  return bundle.documents
    .map((entry) => entry.document as unknown as FormalArtifactEnvelope)
    .filter((entry) => artifactTypes.includes(entry.artifact_type));
}

async function prepareEnrichmentBranchRun(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-enrichment-lane-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "enrichment-lane-materialization";
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic enrichment user"],
      decisionGoal: "test enrichment Branch formal materialization",
      researchLanguage: "en-US",
    },
    createdAt,
  });
  const evidence = new EvidenceStore(runsRoot);
  const record = async (unitId: string, label: string) =>
    (
      await evidence.record({
        runId,
        unitId,
        source: {
          kind: "user_provided",
          canonical_uri: `urn:startup-opportunity:user-provided:enrichment-${label}`,
        },
        acquisitionGoal: `SYNTHETIC ${label} substrate; not Evidence.`,
        rawContent: `SYNTHETIC ${label} bytes; not Evidence.`,
        recordedAt: "2026-07-27T20:50:00Z",
      })
    ).record;
  const bundle = await createDiscoveryEvaluationFixture(runId, {
    generation: await record("unit_seed_independent_demand", "generation"),
    evaluation: await record("unit_counterfactual", "evaluation"),
    support: await record("unit_enrichment_support", "support"),
    challenge: await record("unit_enrichment_challenge", "challenge"),
  });
  await publishInitialPlanBundle(
    store,
    runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  );
  await store.publishArtifactBundle({
    runId,
    envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
  });
  await store.publishArtifactBundle({
    runId,
    envelopes: envelopesByType(bundle, "startup_opportunity.discovery_candidate.v1").filter(
      (entry) => entry.document.revision === 1,
    ),
  });
  await publishRuntimeEnvelopesAsFormalStage(
    { runsRoot, runId, validator },
    discoveryWaveEnvelopes(
      bundle,
      runId,
      "startup_opportunity.research_task.discovery_candidate.current",
      1,
      "candidate_runtime",
    ),
    "request_lane_nondegradation_candidate_wave",
  );
  await store.publishArtifactBundle({
    runId,
    envelopes: envelopesByType(
      bundle,
      "startup_opportunity.evidence.discovery_candidate.current",
      "startup_opportunity.claim.discovery_candidate.current",
      "startup_opportunity.finding.discovery_candidate.current",
      "startup_opportunity.insight.discovery_candidate.current",
      "startup_opportunity.judgment_assessment.discovery_candidate.current",
      "startup_opportunity.source_manifest.discovery_candidate.current",
      "startup_opportunity.discovery_lane_result.v1",
    ),
  });
  await store.publishArtifact({
    runId,
    envelope: envelopesByType(bundle, "startup_opportunity.discovery_candidate.v1").find(
      (entry) => entry.document.revision === 2,
    ) as FormalArtifactEnvelope,
  });
  await store.publishArtifactBundle({
    runId,
    envelopes: [
      G22_RETAINED_PRE_CANDIDATE,
      G22_WATCHLIST_PRE_CANDIDATE,
      G22_REJECTED_PRE_CANDIDATE,
    ].map((artifactPath) => fixtureEnvelope(bundle, artifactPath)),
  });
  await store.publishArtifact({
    runId,
    envelope: fixtureEnvelope(bundle, G22_PRE_CANDIDATE_RELATION),
  });
  await store.publishArtifact({
    runId,
    envelope: envelopesByType(
      bundle,
      "startup_opportunity.discovery_fan_in.v2",
    )[0] as FormalArtifactEnvelope,
  });
  await store.publishArtifactBundle({
    runId,
    envelopes: discoverySynthesisReadinessEnvelopes(bundle),
  });
  await store.publishArtifactBundle({
    runId,
    envelopes: envelopesByType(
      bundle,
      "startup_opportunity.discovery_candidate_conversion.v2",
      "startup_opportunity.demand_thesis.v1",
      "startup_opportunity.baseline_option.v1",
      "startup_opportunity.solution_hypothesis.v1",
      "startup_opportunity.solution_evaluation.v1",
      "startup_opportunity.opportunity_thesis.v1",
      "startup_opportunity.thesis_evaluation_snapshot.v1",
      "startup_opportunity.merge.v1",
    ),
  });
  const wave = discoveryWaveEnvelopes(
    bundle,
    runId,
    "startup_opportunity.research_task.discovery_evaluation.current",
    3,
    "enrichment_runtime",
  );
  await publishRuntimeEnvelopesAsFormalStage(
    { runsRoot, runId, validator },
    wave,
    "request_lane_nondegradation_enrichment_wave",
  );
  const taskEnvelope = wave.find((entry) => entry.artifact_path === G24_TASK_SUPPORT) as
    | FormalArtifactEnvelope
    | undefined;
  assert.ok(taskEnvelope);
  return {
    root,
    runsRoot,
    runId,
    runRoot: path.join(runsRoot, runId),
    validator,
    bundle,
    taskEnvelope,
  };
}

function omitFields(
  document: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const next = structuredClone(document);
  for (const field of fields) delete next[field];
  return next;
}

function replaceStrings(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => replaceStrings(entry, replacements));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, replaceStrings(entry, replacements)]),
  );
}

function enrichmentBranchStaging(
  runId: string,
  taskRef: string,
  bundle: Awaited<ReturnType<typeof createDiscoveryEvaluationFixture>>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const evidenceDocument = effectiveDocumentFromBundle(bundle, G24_EVIDENCE_SUPPORT);
  const evidenceReceiptRef = `evidence/manifest.jsonl#${String(evidenceDocument.evidence_id)}`;
  const claimDocument = effectiveDocumentFromBundle(bundle, G24_CLAIM_SUPPORT);
  const findingDocument = effectiveDocumentFromBundle(bundle, G24_FINDING_SUPPORT);
  const insightDocument = effectiveDocumentFromBundle(bundle, G24_INSIGHT_SUPPORT);
  const judgmentADocument = effectiveDocumentFromBundle(bundle, G24_JUDGMENT_A_SUPPORT);
  const judgmentBDocument = effectiveDocumentFromBundle(bundle, G24_JUDGMENT_B_SUPPORT);
  const manifestDocument = effectiveDocumentFromBundle(bundle, G24_MANIFEST_SUPPORT);
  const derivedRefs = new Map<string, string>([
    [
      G24_EVIDENCE_SUPPORT,
      `evidence/discovery/enrichment/${String(evidenceDocument.evidence_id)}.json`,
    ],
    [G24_CLAIM_SUPPORT, `claims/discovery/enrichment/${String(claimDocument.claim_id)}.json`],
    [
      G24_FINDING_SUPPORT,
      `findings/discovery/enrichment/${String(findingDocument.finding_id)}.json`,
    ],
    [
      G24_INSIGHT_SUPPORT,
      `insights/discovery/enrichment/${String(insightDocument.insight_id)}.json`,
    ],
    [
      G24_JUDGMENT_A_SUPPORT,
      `judgments/discovery/enrichment/${String(judgmentADocument.judgment_id)}.json`,
    ],
    [
      G24_JUDGMENT_B_SUPPORT,
      `judgments/discovery/enrichment/${String(judgmentBDocument.judgment_id)}.json`,
    ],
    [
      G24_MANIFEST_SUPPORT,
      `evidence/discovery/enrichment/source-manifests/${String(manifestDocument.manifest_id)}.json`,
    ],
  ]);
  const branchDocument = omitFields(
    replaceStrings(effectiveDocumentFromBundle(bundle, G24_BRANCH_SUPPORT), derivedRefs) as Record<
      string,
      unknown
    >,
    [
      "branch_result_id",
      "run_id",
      "unit_id",
      "attempt",
      "task_ref",
      "source_snapshot_ref",
      "source_merge_ref",
      "opportunity_refs",
      "owner_role",
    ],
  );
  return {
    schema_version: "startup_opportunity.lane_staging_document.current",
    staging_id: "staging_enrichment_branch_projection",
    run_id: runId,
    task_ref: taskRef,
    created_at: "2026-08-19T09:03:00Z",
    producer_role: "lane_researcher",
    operation: "validate_only",
    evidence_receipt_refs: [evidenceReceiptRef],
    delivery_contract: {
      search_closure: {
        status: "completed",
        acquisition_routes_attempted: ["user_provided"],
        unresolved_gaps: ["Synthetic fixture retains insufficient enrichment evidence."],
        stop_reason: "The explicit synthetic budget was reached.",
      },
    },
    agent_documents: [
      {
        artifact_family: "evidence",
        evidence_receipt_ref: evidenceReceiptRef,
        document: replaceStrings(evidenceDocument, derivedRefs) as Record<string, unknown>,
      },
      {
        artifact_family: "claim",
        document: replaceStrings(claimDocument, derivedRefs) as Record<string, unknown>,
      },
      {
        artifact_family: "finding",
        document: replaceStrings(findingDocument, derivedRefs) as Record<string, unknown>,
      },
      {
        artifact_family: "insight",
        document: replaceStrings(insightDocument, derivedRefs) as Record<string, unknown>,
      },
      {
        artifact_family: "judgment",
        document: replaceStrings(judgmentADocument, derivedRefs) as Record<string, unknown>,
      },
      {
        artifact_family: "judgment",
        document: replaceStrings(judgmentBDocument, derivedRefs) as Record<string, unknown>,
      },
      {
        artifact_family: "source_manifest",
        document: replaceStrings(manifestDocument, derivedRefs) as Record<string, unknown>,
      },
      { artifact_family: "lane_result", document: { ...branchDocument, ...overrides } },
      {
        artifact_family: "commercial_audit",
        document: {
          audited_at: "2026-08-19T09:03:00Z",
          research_objectives: ["Disclose unavailable commercial Evidence."],
          primary_routes: ["Caller-provided synthetic material only."],
          search_results: [],
          evidence_sources: [],
          findings: [],
          claims: [],
          judgments: [],
          quantitative_observations: [],
          competitive_observations: [],
          incumbent_response_assessments: [],
          unresolved_gaps: [],
          limitations: ["No commercial conclusion is upgraded."],
          stop_reason: "No current commercial Evidence was available.",
          telemetry_basis: "unavailable",
          query_log_complete: false,
        },
      },
    ],
  };
}

test("Discovery Lane scope states and additional observations remain distinct", async () => {
  const bundle = await createDiscoveryCandidateFixture();
  const validator = await createArtifactValidator(repositoryRoot);
  const laneDocument = structuredClone(fixtureEffective(bundle, G22_GENERATION_LANE));
  const evidenceEnvelope = fixtureEntry(bundle, G22_GENERATION_EVIDENCE);
  const evidenceArtifact = {
    artifact_ref: G22_GENERATION_EVIDENCE,
    artifact_type: String(evidenceEnvelope.artifact_type),
    content_hash: String(evidenceEnvelope.content_hash),
    document: evidenceEnvelope.document as Record<string, unknown>,
  };
  laneDocument.scope_outcomes = [
    {
      scope_key: "buyer_unknown",
      disposition: "unknown",
      evidence_refs: [],
      claim_refs: [],
      finding_refs: [],
      judgment_assessment_refs: [],
      notes: "The Lane could not determine the buyer state from current material.",
    },
    {
      scope_key: "route_unavailable",
      disposition: "unavailable",
      evidence_refs: [],
      claim_refs: [],
      finding_refs: [],
      judgment_assessment_refs: [],
      notes: "The declared acquisition route was unavailable during this attempt.",
    },
    {
      scope_key: "demand_inferred",
      disposition: "inferred",
      evidence_refs: [G22_GENERATION_EVIDENCE],
      claim_refs: [],
      finding_refs: [],
      judgment_assessment_refs: [],
      notes: "The result is an inference and is not promoted to observed coverage.",
    },
    {
      scope_key: "contradictory_context",
      disposition: "partial",
      evidence_refs: [G22_GENERATION_EVIDENCE],
      claim_refs: [],
      finding_refs: [],
      judgment_assessment_refs: [],
      notes: "Additional contradictory context remains visible outside the minimum checklist.",
    },
  ];

  const validation = validator.validateDocument(laneDocument);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors, null, 2));
  const laneArtifact = {
    artifact_ref: G22_GENERATION_LANE,
    artifact_type: "startup_opportunity.discovery_lane_result.v1",
    content_hash: canonicalContentHash(laneDocument),
    document: laneDocument,
  };
  const assignedScope = ["buyer_unknown", "route_unavailable", "demand_inferred"];
  const closure = deriveLaneScopeFormalClosure(
    assignedScope,
    [laneArtifact, evidenceArtifact],
    [laneArtifact.artifact_ref],
  );

  assert.deepEqual(closure.issues, []);
  assert.deepEqual(
    closure.closure.map((entry) => [entry.scope_key, entry.disposition]),
    [
      ["buyer_unknown", "unknown"],
      ["demand_inferred", "inferred"],
      ["route_unavailable", "unavailable"],
    ],
  );
  assert.deepEqual(
    laneScopeCoverageFromClosure(closure.closure).map((entry) => [entry.scope_key, entry.status]),
    [
      ["buyer_unknown", "unknown"],
      ["demand_inferred", "inferred"],
      ["route_unavailable", "unavailable"],
    ],
  );
  assert.equal(
    closure.closure.find((entry) => entry.scope_key === "demand_inferred")?.evidence_bindings
      .length,
    1,
  );
  assert.ok(
    (laneDocument.scope_outcomes as Record<string, unknown>[]).some(
      (entry) => entry.scope_key === "contradictory_context" && entry.disposition === "partial",
    ),
  );
});

test("Lane staging aggregates JSON Pointer diagnostics without writing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-lane-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const validator = await createArtifactValidator(repositoryRoot);
  const materializer = new LaneResultMaterializer(runsRoot, validator, repositoryRoot);
  const failedBeforeSearch = {
    schema_version: "startup_opportunity.lane_staging_document.current",
    staging_id: "staging_failed_before_search",
    run_id: "lane-diagnostics-synthetic",
    task_ref: "tasks/discovery/unit_diagnostics.attempt-1.json",
    created_at: "2026-08-19T00:00:00Z",
    producer_role: "lane_researcher",
    operation: "validate_only",
    evidence_receipt_refs: [],
    delivery_contract: {
      search_closure: {
        status: "failed_before_search",
        acquisition_routes_attempted: ["none"],
        unresolved_gaps: ["Search could not start."],
        stop_reason: "The attempt failed before any acquisition route ran.",
      },
    },
    agent_documents: [{ artifact_family: "lane_result", document: {} }],
  };
  assert.equal(validator.validateDocument(failedBeforeSearch).valid, true);

  const malformed = structuredClone(failedBeforeSearch) as Record<string, unknown>;
  malformed.created_at = "not-a-timestamp";
  malformed.producer_role = "harness";
  const deliveryContract = malformed.delivery_contract as Record<string, unknown>;
  const searchClosure = deliveryContract.search_closure as Record<string, unknown>;
  searchClosure.status = "collapsed_unknown_state";
  searchClosure.acquisition_routes_attempted = [];

  const beforeMissingValidateSource = await snapshotTree(root);
  await assert.rejects(materializer.materialize(failedBeforeSearch), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, "runtime.lane_staging_source_missing");
    return true;
  });
  assert.deepEqual(await snapshotTree(root), beforeMissingValidateSource);

  const missingSourcePublish = { ...failedBeforeSearch, operation: "publish" };
  const beforeMissingPublishSource = await snapshotTree(root);
  await assert.rejects(materializer.materialize(missingSourcePublish), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, "runtime.lane_staging_source_missing");
    return true;
  });
  assert.deepEqual(await snapshotTree(root), beforeMissingPublishSource);

  const runRoot = path.join(runsRoot, String(malformed.run_id));
  const malformedFile = path.join(
    runRoot,
    "staging/lane-submissions/00000000000000000000000000000000.json",
  );
  await mkdir(path.dirname(malformedFile), { recursive: true });
  await writeFile(malformedFile, `${JSON.stringify(malformed, null, 2)}\n`);
  const before = await snapshotTree(root);
  await assert.rejects(materializer.materializeFile(malformedFile), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, "runtime.lane_staging_invalid");
    const paths = (error.details.issues as Record<string, unknown>[]).map((entry) => entry.path);
    assert.ok(paths.length >= 4, JSON.stringify(error.details, null, 2));
    assert.ok(paths.includes("/created_at"));
    assert.ok(paths.includes("/producer_role"));
    assert.ok(paths.includes("/delivery_contract/search_closure/status"));
    assert.ok(paths.includes("/delivery_contract/search_closure/acquisition_routes_attempted"));
    return true;
  });
  assert.deepEqual(await snapshotTree(root), before);
});

test("Generation Lane Result derives Task-owned fields and rejects forged mechanical bindings", async (t) => {
  const state = await prepareGenerationResultRun(t);
  const materializer = new LaneResultMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const staging = generationLaneStaging(state.runId, String(state.taskEnvelope.artifact_path));
  const stagingFile = await writeLaneStagingFile(state.runRoot, state.taskEnvelope, staging);
  const before = await snapshotTree(state.runRoot);
  const validated = await materializer.materializeFile(stagingFile);
  assert.equal(validated.status, "accepted");
  assert.deepEqual(await snapshotTree(state.runRoot), before);
  const generationEnvelope = validated.compilation.compiled_envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.discovery_generation_result.v1",
  );
  assert.ok(generationEnvelope);
  assert.equal(
    generationEnvelope.document.generation_result_id,
    "generation_unit_seed_independent_demand_attempt_1",
  );
  assert.equal(generationEnvelope.document.run_id, state.runId);
  assert.equal(generationEnvelope.document.unit_id, "unit_seed_independent_demand");
  assert.equal(generationEnvelope.document.attempt, 1);
  assert.match(String(generationEnvelope.document.dispatch_batch_ref), /^tasks\/dispatch\//);
  assert.equal(generationEnvelope.document.scope_frame_ref, "scope-frame.json");
  assert.equal(generationEnvelope.document.research_plan_ref, G21_PLAN_REF);
  assert.equal(generationEnvelope.document.status, "insufficient_evidence");
  assert.deepEqual(generationEnvelope.document.evidence_refs, []);
  assert.match(String((generationEnvelope.document.limitations as string[])[0]), /insufficient/);

  const forged = generationLaneStaging(state.runId, String(state.taskEnvelope.artifact_path), {
    dispatch_batch_ref: "tasks/dispatch/forged.r1.json#task_forged",
  });
  const forgedFile = await writeLaneStagingFile(state.runRoot, state.taskEnvelope, forged);
  const beforeForged = await snapshotTree(state.runRoot);
  await assert.rejects(materializer.materializeFile(forgedFile), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, "runtime.lane_preflight_failed");
    const issues = error.details.issues as Record<string, unknown>[];
    assert.ok(
      issues.some(
        (issue) =>
          issue.code === "lane_delivery.mechanical_field_forged" &&
          issue.path === "/agent_documents/1/document/dispatch_batch_ref",
      ),
      JSON.stringify(error.details, null, 2),
    );
    return true;
  });
  assert.deepEqual(await snapshotTree(state.runRoot), beforeForged);
});

test("Enrichment Branch Result derives Task-owned fields and rejects forged mechanical bindings", async (t) => {
  const state = await prepareEnrichmentBranchRun(t);
  const materializer = new LaneResultMaterializer(state.runsRoot, state.validator, repositoryRoot);
  const staging = enrichmentBranchStaging(
    state.runId,
    String(state.taskEnvelope.artifact_path),
    state.bundle,
  );
  const stagingFile = await writeLaneStagingFile(state.runRoot, state.taskEnvelope, staging);
  const before = await snapshotTree(state.runRoot);
  const validated = await materializer.materializeFile(stagingFile);
  assert.equal(validated.status, "accepted");
  assert.deepEqual(await snapshotTree(state.runRoot), before);
  const branchEnvelope = validated.compilation.compiled_envelopes.find(
    (entry) => entry.artifact_type === "startup_opportunity.enrichment_branch_result.v1",
  );
  assert.ok(branchEnvelope);
  assert.equal(
    branchEnvelope.document.branch_result_id,
    "branch_unit_enrichment_support_attempt_1",
  );
  assert.equal(branchEnvelope.document.run_id, state.runId);
  assert.equal(branchEnvelope.document.unit_id, "unit_enrichment_support");
  assert.equal(branchEnvelope.document.attempt, 1);
  assert.equal(branchEnvelope.document.task_ref, G24_TASK_SUPPORT);
  assert.match(
    String(branchEnvelope.document.source_snapshot_ref),
    /^artifacts\/discovery\/thesis-snapshots\//,
  );
  assert.match(String(branchEnvelope.document.source_merge_ref), /^artifacts\/discovery\/merges\//);
  assert.deepEqual(
    branchEnvelope.document.opportunity_refs,
    state.taskEnvelope.document.target_opportunity_refs,
  );
  assert.equal(branchEnvelope.document.owner_role, "lane-researcher");
  assert.equal(branchEnvelope.document.status, "insufficient_evidence");
  assert.ok(
    (branchEnvelope.document.hard_gate_inputs as Record<string, unknown>[]).some(
      (entry) => entry.status === "insufficient_evidence",
    ),
  );

  const forged = enrichmentBranchStaging(
    state.runId,
    String(state.taskEnvelope.artifact_path),
    state.bundle,
    { source_snapshot_ref: "artifacts/discovery/thesis-snapshots/forged.r1.json" },
  );
  const forgedFile = await writeLaneStagingFile(state.runRoot, state.taskEnvelope, forged);
  const beforeForged = await snapshotTree(state.runRoot);
  await assert.rejects(materializer.materializeFile(forgedFile), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, "runtime.lane_preflight_failed");
    const issues = error.details.issues as Record<string, unknown>[];
    assert.ok(
      issues.some(
        (issue) =>
          issue.code === "lane_delivery.mechanical_field_forged" &&
          issue.path === "/agent_documents/7/document/source_snapshot_ref",
      ),
      JSON.stringify(error.details, null, 2),
    );
    return true;
  });
  assert.deepEqual(await snapshotTree(state.runRoot), beforeForged);
});

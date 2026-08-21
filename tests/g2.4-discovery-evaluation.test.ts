import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  INCUMBENT_RESPONSE_STRATEGIC_CONTEXT,
  INCUMBENT_RESPONSE_STRATEGIC_CONTEXT_ZH,
} from "../harness/src/incumbent-response-contract.js";
import {
  buildArtifactScaffold,
  canonicalContentHash,
  canonicalJson,
  createArtifactValidator,
  type DiscoveryProfile,
  type DocumentBundle,
  deriveOpportunityFamilyProjection,
  deriveReportEnvelopes,
  EvidenceStore,
  type FormalArtifactEnvelope,
  ReportRuntime,
  RunStore,
  StoreError,
  sha256Bytes,
} from "../harness/src/index.js";
import { scanReportSurface } from "../harness/src/reporting/report-consistency.js";
import { renderDiscoveryTeamDecisionSummary } from "../harness/src/reporting/report-runtime.js";
import {
  fixtureEnvelope,
  G21_CORE_REFS,
  G21_MAP_REFS,
  G21_SCOPE_REF,
  G21_SOLUTION_REF,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
import {
  G22_DEMAND_R1,
  G22_DEMAND_R2,
  G22_FAN_IN,
  G22_GENERATION_LANE,
  G22_PRE_CANDIDATE_RELATION,
  G22_REJECTED_PRE_CANDIDATE,
  G22_RETAINED_PRE_CANDIDATE,
  G22_SOLUTION_R1,
  G22_WATCHLIST_PRE_CANDIDATE,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";
import {
  discoverySynthesisReadinessEnvelopes,
  G23_MERGE,
  G23_OPPORTUNITY_A,
  G23_OPPORTUNITY_B,
  G23_SOLUTION,
  G23_SOLUTION_CONVERSION,
} from "./fixtures/g2.3/discovery-synthesis-fixture.js";
import {
  createDiscoveryEnrichmentPlanningFixture,
  createDiscoveryEvaluationFixture,
  type DiscoveryEvaluationSubstrate,
  evaluationEnvelope,
  G24_BRANCH_CHALLENGE,
  G24_BRANCH_SUPPORT,
  G24_COMPARISON_A,
  G24_COMPARISON_B,
  G24_ENGINE_A,
  G24_EVIDENCE_CHALLENGE,
  G24_EVIDENCE_SUPPORT,
  G24_FAN_IN,
  G24_PORTFOLIO,
  G24_RECOMMENDATION,
  G24_REPORT,
  G24_SENSITIVITY,
  G24_TASK_SUPPORT,
  G24_TRACEABILITY,
} from "./fixtures/g2.4/discovery-evaluation-fixture.js";
import { commercialReportProjection } from "./fixtures/quantitative-competitive-fixture.js";
import { projectCommercialAuditsForRuntime } from "./helpers/commercial-runtime.js";
import { createConfirmedRun, publishInitialPlanBundle } from "./helpers/current-run.js";
import { discoveryWaveEnvelopes } from "./helpers/discovery-wave.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

interface State {
  readonly root: string;
  readonly runsRoot: string;
  readonly runRoot: string;
  readonly runId: string;
  readonly store: RunStore;
  readonly validator: Awaited<ReturnType<typeof createArtifactValidator>>;
  readonly bundle: DocumentBundle;
  readonly substrate: DiscoveryEvaluationSubstrate;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function treeSnapshot(root: string, relative = ""): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const candidate of (await readdir(path.join(root, relative), { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const child = path.posix.join(relative, candidate.name);
    if (candidate.isDirectory()) {
      Object.assign(snapshot, await treeSnapshot(root, child));
    } else if (candidate.isFile()) {
      snapshot[child] = (await readFile(path.join(root, child))).toString("base64");
    }
  }
  return snapshot;
}

function entry(bundle: DocumentBundle, artifactPath: string): Record<string, unknown> {
  const found = bundle.documents.find((candidate) => candidate.path === artifactPath);
  assert.ok(found, artifactPath);
  return found.document;
}

function effective(bundle: DocumentBundle, artifactPath: string): Record<string, unknown> {
  const outer = entry(bundle, artifactPath);
  return String(outer.schema_version).startsWith("startup_opportunity.artifact_envelope.")
    ? (outer.document as Record<string, unknown>)
    : outer;
}

function collectTypedRefs(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(collectTypedRefs);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    if ((key.endsWith("_refs") || key === "input_refs") && Array.isArray(child)) {
      return child.filter(
        (ref): ref is string =>
          typeof ref === "string" &&
          (ref.includes("/") ||
            ref.includes("#") ||
            ref.endsWith(".json") ||
            ref.endsWith(".jsonl")),
      );
    }
    if (
      (key.endsWith("_ref") || key.endsWith("_refs") || key === "ref") &&
      typeof child === "string" &&
      (child.includes("/") ||
        child.includes("#") ||
        child.endsWith(".json") ||
        child.endsWith(".jsonl"))
    ) {
      return [child];
    }
    return collectTypedRefs(child);
  });
}

function reportMaterializationRootRefs(document: Record<string, unknown>): readonly string[] {
  if (document.schema_version !== "startup_opportunity.report.v1") {
    return [];
  }
  return [document.decision_context_ref, document.scope_frame_ref].filter(
    (ref): ref is string => typeof ref === "string",
  );
}

function refresh(bundle: DocumentBundle, artifactPath: string): void {
  const outer = entry(bundle, artifactPath);
  if (String(outer.schema_version).startsWith("startup_opportunity.artifact_envelope.")) {
    outer.content_hash = canonicalContentHash(outer.document as Record<string, unknown>);
  }
}

function refreshEnvelopeClosure(bundle: DocumentBundle, artifactPath: string): void {
  refresh(bundle, artifactPath);
  const outer = entry(bundle, artifactPath);
  if (!String(outer.schema_version).startsWith("startup_opportunity.artifact_envelope.")) {
    return;
  }
  outer.input_refs = [
    ...new Set([
      ...collectTypedRefs(outer.document),
      ...collectTypedRefs(outer.ai_bundle_binding),
      ...reportMaterializationRootRefs(outer.document as Record<string, unknown>),
    ]),
  ]
    .filter((ref) => ref.split("#", 1)[0] !== artifactPath)
    .sort();
}

function refreshAllInputHashes(bundle: DocumentBundle): void {
  for (let pass = 0; pass < bundle.documents.length; pass += 1) {
    let changed = false;
    for (const candidate of bundle.documents) {
      const document = effective(bundle, candidate.path);
      const hashLists = [
        document.input_artifact_hashes,
        (document.report_metadata as Record<string, unknown> | undefined)?.input_artifact_hashes,
      ];
      for (const hashes of hashLists) {
        if (!Array.isArray(hashes)) {
          continue;
        }
        for (const binding of hashes) {
          if (!binding || typeof binding !== "object" || !("ref" in binding)) {
            continue;
          }
          const ref = String(binding.ref);
          if (!bundle.documents.some((entry) => entry.path === ref)) {
            continue;
          }
          const expected = canonicalContentHash(effective(bundle, ref));
          if (binding.content_hash !== expected) {
            binding.content_hash = expected;
            changed = true;
          }
        }
      }
      refresh(bundle, candidate.path);
    }
    if (!changed) {
      return;
    }
  }
}

function refreshOpportunityFamilyProjection(bundle: DocumentBundle): void {
  refresh(bundle, G23_MERGE);
  const projection = deriveOpportunityFamilyProjection(
    G23_MERGE,
    new Map(
      bundle.documents.map((candidate) => {
        const outer = entry(bundle, candidate.path);
        const document = effective(bundle, candidate.path);
        const contentHash = String(outer.schema_version).startsWith(
          "startup_opportunity.artifact_envelope.",
        )
          ? String(outer.content_hash)
          : canonicalContentHash(document);
        return [
          candidate.path,
          {
            path: candidate.path,
            schemaVersion: String(document.schema_version),
            document,
            contentHash,
          },
        ];
      }),
    ),
  );
  for (const artifactPath of [G24_PORTFOLIO, G24_RECOMMENDATION, G24_TRACEABILITY, G24_REPORT]) {
    effective(bundle, artifactPath).opportunity_family_projection = structuredClone(projection);
  }
  refreshAllInputHashes(bundle);
}

function installStateRichOpportunityFamily(bundle: DocumentBundle): void {
  const merge = effective(bundle, G23_MERGE);
  const family = ((merge.opportunity_families as Record<string, unknown>[])[0] ?? {}) as Record<
    string,
    unknown
  >;
  family.shared_value_or_solution_mechanism = {
    state: "unknown",
    description: "SYNTHETIC shared mechanism remains unresolved; no assertion is made.",
  };
  family.member_specific_differences = [
    {
      opportunity_ref: G23_OPPORTUNITY_A,
      dimensions: [
        {
          dimension: "user",
          state: "unavailable",
          description: "SYNTHETIC user difference unavailable.",
        },
        {
          dimension: "buyer",
          state: "inferred",
          description: "SYNTHETIC buyer difference inferred from bounded material.",
        },
      ],
    },
    {
      opportunity_ref: G23_OPPORTUNITY_B,
      dimensions: [
        {
          dimension: "acquisition",
          state: "not_applicable",
          description: "SYNTHETIC acquisition difference not applicable.",
        },
        {
          dimension: "compliance",
          state: "no_evidence_found",
          description: "SYNTHETIC no evidence found within the declared boundary.",
        },
      ],
    },
  ];
  refreshOpportunityFamilyProjection(bundle);
}

function mutableExactRecords(
  bundle: DocumentBundle,
): { ref: string; document: Record<string, unknown> }[] {
  const mutable = bundle as unknown as {
    exact_records?: { ref: string; document: Record<string, unknown> }[];
  };
  mutable.exact_records ??= [];
  return mutable.exact_records;
}

function exactRecordDocument(bundle: DocumentBundle, ref: string): Record<string, unknown> {
  const found = mutableExactRecords(bundle).find((record) => record.ref === ref);
  assert.ok(found, ref);
  return found.document;
}

function ensureHashBinding(hashes: unknown, ref: string, contentHash: string): void {
  assert.ok(Array.isArray(hashes));
  const binding = hashes.find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === "object" &&
      candidate !== null &&
      "ref" in candidate &&
      candidate.ref === ref,
  );
  if (binding === undefined) {
    hashes.push({ ref, content_hash: contentHash });
  } else {
    binding.content_hash = contentHash;
  }
}

function updateHashBindingIfPresent(hashes: unknown, ref: string, contentHash: string): void {
  if (!Array.isArray(hashes)) {
    return;
  }
  for (const binding of hashes) {
    if (
      typeof binding === "object" &&
      binding !== null &&
      "ref" in binding &&
      binding.ref === ref
    ) {
      (binding as Record<string, unknown>).content_hash = contentHash;
    }
  }
}

function teamFitPanel(bundle: DocumentBundle, comparisonRef: string): Record<string, unknown> {
  const comparison = effective(bundle, comparisonRef);
  const panel = (comparison.comparison_panels as Record<string, unknown>[]).find(
    (candidate) => candidate.panel_id === "team_fit_and_learning",
  );
  assert.ok(panel);
  return panel;
}

function syncReportTeamAnalysis(bundle: DocumentBundle, comparisonRef: string): void {
  const comparison = effective(bundle, comparisonRef);
  const panel = teamFitPanel(bundle, comparisonRef);
  const summary = effective(bundle, G24_REPORT).team_decision_summary as Record<string, unknown>;
  const analysis = (summary.opportunity_analyses as Record<string, unknown>[]).find(
    (candidate) => candidate.comparison_ref === comparisonRef,
  );
  assert.ok(analysis);
  analysis.opportunity_ref = comparison.opportunity_ref;
  analysis.team_startup_burden = clone(panel.team_startup_burden);
  analysis.team_match_analysis = clone(panel.team_match_analysis);
}

function addTeamBurdenExactEvidenceRecord(bundle: DocumentBundle): string {
  const exactRecords = mutableExactRecords(bundle);
  const seed = exactRecords.find((record) => record.ref.startsWith("evidence/manifest.jsonl#"));
  assert.ok(seed);
  const seedKey = `team-burden-exact-${exactRecords.length}`;
  const evidenceId = `ev_${sha256Bytes(seedKey).slice("sha256:".length)}`;
  const ref = `evidence/manifest.jsonl#${evidenceId}`;
  exactRecords.push({
    ref,
    document: {
      ...clone(seed.document),
      evidence_id: evidenceId,
      operation_key: sha256Bytes(seedKey),
    },
  });
  return ref;
}

function bindTeamBurdenToExactEvidence(bundle: DocumentBundle, comparisonRef: string): string {
  const exactRef = addTeamBurdenExactEvidenceRecord(bundle);
  const exactDocument = exactRecordDocument(bundle, exactRef);
  const exactHash = canonicalContentHash(exactDocument);
  const comparison = effective(bundle, comparisonRef);
  const panel = teamFitPanel(bundle, comparisonRef);
  const burden = panel.team_startup_burden as Record<string, unknown>;
  const firstDimension = (burden.dimensions as Record<string, unknown>[])[0];
  assert.ok(firstDimension);
  firstDimension.supporting_refs = [exactRef];
  firstDimension.opposing_refs = [exactRef];
  ensureHashBinding(comparison.input_artifact_hashes, exactRef, exactHash);
  refreshEnvelopeClosure(bundle, comparisonRef);

  syncReportTeamAnalysis(bundle, comparisonRef);
  const reportMetadata = effective(bundle, G24_REPORT).report_metadata as Record<string, unknown>;
  ensureHashBinding(reportMetadata.input_artifact_hashes, exactRef, exactHash);
  refreshAllInputHashes(bundle);
  refreshEnvelopeClosure(bundle, comparisonRef);
  refreshEnvelopeClosure(bundle, G24_REPORT);
  return exactRef;
}

function refreshExactHashBindings(bundle: DocumentBundle, ref: string): void {
  const exactHash = canonicalContentHash(exactRecordDocument(bundle, ref));
  for (const candidate of bundle.documents) {
    const document = effective(bundle, candidate.path);
    updateHashBindingIfPresent(document.input_artifact_hashes, ref, exactHash);
    const metadata = document.report_metadata as Record<string, unknown> | undefined;
    if (metadata !== undefined) {
      updateHashBindingIfPresent(metadata.input_artifact_hashes, ref, exactHash);
    }
  }
  refreshAllInputHashes(bundle);
  refreshEnvelopeClosure(bundle, G24_COMPARISON_A);
  refreshEnvelopeClosure(bundle, G24_REPORT);
}

async function setup(
  context: TestContext,
  suffix: string,
  profile: DiscoveryProfile = "general",
  researchLanguage = "en-US",
): Promise<State> {
  const root = await mkdtemp(path.join(tmpdir(), `startup-opportunity-g2-4-${suffix}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = `g2-4-${suffix}-synthetic`;
  const validator = await createArtifactValidator(repositoryRoot);
  const store = new RunStore(runsRoot, validator);
  await createConfirmedRun(store, {
    runId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "synthetic-primary-market",
      customerModel: "b2c",
      targetUsers: ["SYNTHETIC primary user; not Evidence or external validation."],
      decisionGoal:
        "SYNTHETIC identify directions that merit further validation; not Evidence or external validation.",
      researchLanguage,
    },
    createdAt: "2026-07-27T17:00:00Z",
  });
  const evidence = new EvidenceStore(runsRoot);
  const record = async (unitId: string, label: string) =>
    (
      await evidence.record({
        runId,
        unitId,
        source: {
          kind: "user_provided",
          canonical_uri: `urn:startup-opportunity:user-provided:${suffix}-${label}`,
        },
        researchGoal: `SYNTHETIC ${label} substrate; not Evidence.`,
        rawContent: `SYNTHETIC ${label} bytes; not Evidence.`,
        recordedAt: "2026-07-27T20:50:00Z",
      })
    ).record;
  const substrate = {
    generation: await record("unit_seed_independent_demand", "generation"),
    evaluation: await record("unit_counterfactual", "evaluation"),
    support: await record("unit_enrichment_support", "support"),
    challenge: await record("unit_enrichment_challenge", "challenge"),
  };
  const bundle = await createDiscoveryEvaluationFixture(
    runId,
    substrate,
    profile,
    researchLanguage,
  );
  return {
    root,
    runsRoot,
    runRoot: path.join(runsRoot, runId),
    runId,
    store,
    validator,
    bundle,
    substrate,
  };
}

function envelopes(
  bundle: DocumentBundle,
  version: FormalArtifactEnvelope["schema_version"],
): FormalArtifactEnvelope[] {
  return bundle.documents
    .map((candidate) => candidate.document as unknown as FormalArtifactEnvelope)
    .filter((candidate) => candidate.schema_version === version);
}

function byTypes(
  candidates: readonly FormalArtifactEnvelope[],
  ...types: readonly string[]
): FormalArtifactEnvelope[] {
  return candidates.filter((candidate) => types.includes(candidate.artifact_type));
}

const SYNTHESIS_ARTIFACT_TYPES = [
  "startup_opportunity.discovery_candidate_conversion.v2",
  "startup_opportunity.demand_thesis.v1",
  "startup_opportunity.baseline_option.v1",
  "startup_opportunity.solution_hypothesis.v1",
  "startup_opportunity.solution_evaluation.v1",
  "startup_opportunity.opportunity_thesis.v1",
  "startup_opportunity.thesis_evaluation_snapshot.v1",
  "startup_opportunity.merge.v1",
] as const;

const EVALUATION_AGGREGATE_ARTIFACT_TYPES = [
  "startup_opportunity.enrichment_fan_in.v1",
  "startup_opportunity.value_layer_analysis.v1",
  "startup_opportunity.user_state_context_model.v1",
  "startup_opportunity.buyer_purchase_language.v1",
  "startup_opportunity.business_engine_thesis.discovery_evaluation.current",
  "startup_opportunity.opportunity_comparison.v1",
  "startup_opportunity.sensitivity.v1",
  "startup_opportunity.portfolio_view.v1",
  "startup_opportunity.decision_recommendation.v1",
  "startup_opportunity.traceability.discovery.current",
  "startup_opportunity.report_consistency_evaluation.discovery.current",
] as const;

async function publishThroughSynthesis(state: State): Promise<void> {
  await publishInitialPlanBundle(
    state.store,
    state.runId,
    G21_CORE_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
  ).catch((error: unknown) => {
    if (error instanceof StoreError) {
      assert.fail(JSON.stringify({ code: error.code, details: error.details }));
    }
    throw error;
  });
  await state.store
    .publishArtifactBundle({
      runId: state.runId,
      envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(state.bundle, ref)),
    })
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }));
      }
      throw error;
    });
  const runtime = envelopes(state.bundle, "startup_opportunity.artifact_envelope.current");
  await state.store
    .publishArtifactBundle({
      runId: state.runId,
      envelopes: byTypes(runtime, "startup_opportunity.discovery_candidate.v1").filter(
        (candidate) => candidate.document.revision === 1,
      ),
    })
    .catch((error: unknown) => {
      if (error instanceof StoreError) {
        assert.fail(JSON.stringify({ code: error.code, details: error.details }));
      }
      throw error;
    });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: discoveryWaveEnvelopes(
      state.bundle,
      state.runId,
      "startup_opportunity.research_task.discovery_candidate.current",
      1,
      "candidate_runtime",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(
      runtime,
      "startup_opportunity.evidence.discovery_candidate.current",
      "startup_opportunity.claim.discovery_candidate.current",
      "startup_opportunity.finding.discovery_candidate.current",
      "startup_opportunity.insight.discovery_candidate.current",
      "startup_opportunity.judgment_assessment.discovery_candidate.current",
      "startup_opportunity.source_manifest.discovery_candidate.current",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(runtime, "startup_opportunity.discovery_lane_result.v1"),
  });
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: runtime.find(
      (candidate) => candidate.artifact_path === G22_DEMAND_R2,
    ) as FormalArtifactEnvelope,
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: [
      G22_RETAINED_PRE_CANDIDATE,
      G22_WATCHLIST_PRE_CANDIDATE,
      G22_REJECTED_PRE_CANDIDATE,
    ].map(
      (artifactPath) =>
        runtime.find(
          (candidate) => candidate.artifact_path === artifactPath,
        ) as FormalArtifactEnvelope,
    ),
  });
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: runtime.find(
      (candidate) => candidate.artifact_path === G22_PRE_CANDIDATE_RELATION,
    ) as FormalArtifactEnvelope,
  });
  await state.store.publishArtifact({
    runId: state.runId,
    envelope: runtime.find(
      (candidate) => candidate.artifact_path === G22_FAN_IN,
    ) as FormalArtifactEnvelope,
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: discoverySynthesisReadinessEnvelopes(state.bundle),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(runtime, ...SYNTHESIS_ARTIFACT_TYPES),
  });
}

async function publishThroughEnrichmentBranches(state: State): Promise<void> {
  await publishThroughSynthesis(state);
  const evaluation = envelopes(state.bundle, "startup_opportunity.artifact_envelope.current");
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: discoveryWaveEnvelopes(
      state.bundle,
      state.runId,
      "startup_opportunity.research_task.discovery_evaluation.current",
      3,
      "enrichment_runtime",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(
      evaluation,
      "startup_opportunity.evidence.discovery_evaluation.current",
      "startup_opportunity.claim.discovery_evaluation.current",
      "startup_opportunity.finding.discovery_evaluation.current",
      "startup_opportunity.insight.discovery_evaluation.current",
      "startup_opportunity.judgment_assessment.discovery_evaluation.current",
      "startup_opportunity.source_manifest.discovery_evaluation.current",
    ),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(evaluation, "startup_opportunity.enrichment_branch_result.v1"),
  });
}

async function publishThroughEvaluation(state: State): Promise<void> {
  await publishThroughEnrichmentBranches(state);
  const runtimeWaves = [
    discoveryWaveEnvelopes(
      state.bundle,
      state.runId,
      "startup_opportunity.research_task.discovery_candidate.current",
      1,
      "candidate_runtime",
    ),
    discoveryWaveEnvelopes(
      state.bundle,
      state.runId,
      "startup_opportunity.research_task.discovery_evaluation.current",
      3,
      "enrichment_runtime",
    ),
  ];
  const runtimeAudits = projectCommercialAuditsForRuntime(state.bundle, state.runId, runtimeWaves);
  Object.assign(effective(state.bundle, G24_REPORT), commercialReportProjection(runtimeAudits));
  refreshAllInputHashes(state.bundle);
  const evaluation = envelopes(state.bundle, "startup_opportunity.artifact_envelope.current");
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(evaluation, "startup_opportunity.commercial_research_audit.current"),
  });
  await state.store.publishArtifactBundle({
    runId: state.runId,
    envelopes: byTypes(evaluation, ...EVALUATION_AGGREGATE_ARTIFACT_TYPES),
  });
}

async function rewriteUnitState(
  state: State,
  unitId: string,
  target: "invalidated_units" | "superseded_units",
): Promise<void> {
  const manifestPath = path.join(state.runRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  for (const field of [
    "completed_units",
    "active_units",
    "failed_units",
    "invalidated_units",
    "skipped_units",
    "cancelled_units",
    "superseded_units",
  ]) {
    const values = manifest[field] as string[];
    manifest[field] =
      field === target
        ? [...new Set([...values, unitId])].sort()
        : values.filter((candidate) => candidate !== unitId);
  }
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
}

function terminalBranch(
  state: State,
  artifactPath: string,
  status: "partial" | "failed" | "ignored_late" | "superseded",
): FormalArtifactEnvelope {
  const candidate = clone(evaluationEnvelope(state.bundle, artifactPath));
  candidate.document.status = status;
  return { ...candidate, content_hash: canonicalContentHash(candidate.document) };
}

function setFirstBet(bundle: DocumentBundle, firstBet: string): void {
  const alternative = firstBet === G23_OPPORTUNITY_A ? G23_OPPORTUNITY_B : G23_OPPORTUNITY_A;
  const portfolio = effective(bundle, G24_PORTFOLIO);
  portfolio.recommended_first_bet = firstBet;
  portfolio.alternative_bets = [alternative];
  const ranking = portfolio.opportunity_ranking as Record<string, unknown>[];
  for (const entry of ranking) {
    entry.rank = entry.opportunity_ref === firstBet ? 1 : null;
  }
  refreshEnvelopeClosure(bundle, G24_PORTFOLIO);
  const recommendation = effective(bundle, G24_RECOMMENDATION);
  recommendation.recommended_first_bet = firstBet;
  recommendation.alternative_bets = [alternative];
  recommendation.decision_tier = "prioritize";
  refreshEnvelopeClosure(bundle, G24_RECOMMENDATION);
  const report = effective(bundle, G24_REPORT);
  report.top_opportunity_refs = [firstBet];
  const context = report.curated_judgment_context as Record<string, unknown>;
  context.recommended_first_bet = firstBet;
  context.alternative_bets = [alternative];
  context.decision_tier = "prioritize";
  const metadata = report.report_metadata as Record<string, unknown>;
  for (const hash of metadata.input_artifact_hashes as Record<string, unknown>[]) {
    if (hash.ref === G24_PORTFOLIO || hash.ref === G24_RECOMMENDATION) {
      hash.content_hash = canonicalContentHash(effective(bundle, String(hash.ref)));
    }
  }
  refreshEnvelopeClosure(bundle, G24_REPORT);
}

type DecisionTier =
  | "reject"
  | "insufficient_evidence"
  | "watch"
  | "investigate_further"
  | "prioritize";

function setDecisionTier(bundle: DocumentBundle, tier: DecisionTier): void {
  effective(bundle, G24_RECOMMENDATION).decision_tier = tier;
  const report = effective(bundle, G24_REPORT);
  (report.curated_judgment_context as Record<string, unknown>).decision_tier = tier;
  refreshAllInputHashes(bundle);
}

function opportunityFanInCeiling(bundle: DocumentBundle): Record<string, unknown> {
  const ceiling = (
    effective(bundle, G24_FAN_IN).opportunity_conclusion_ceilings as Record<string, unknown>[]
  ).find((candidate) => candidate.opportunity_ref === G23_OPPORTUNITY_A);
  assert.ok(ceiling);
  return ceiling;
}

function setOpportunityGateStatus(
  bundle: DocumentBundle,
  gateId: string,
  status: "passed" | "not_applicable" | "failed" | "insufficient_evidence",
): void {
  const fanGate = (
    effective(bundle, G24_FAN_IN).hard_gate_inputs as Record<string, unknown>[]
  ).find(
    (candidate) => candidate.opportunity_ref === G23_OPPORTUNITY_A && candidate.gate_id === gateId,
  );
  const comparisonGate = (
    effective(bundle, G24_COMPARISON_A).hard_gate_results as Record<string, unknown>[]
  ).find((candidate) => candidate.gate_id === gateId);
  assert.ok(fanGate && comparisonGate);
  fanGate.status = status;
  comparisonGate.status = status;
}

function makeFirstBetReady(bundle: DocumentBundle): void {
  const fanIn = effective(bundle, G24_FAN_IN);
  for (const gate of fanIn.hard_gate_inputs as Record<string, unknown>[]) {
    if (gate.opportunity_ref === G23_OPPORTUNITY_A) {
      gate.status = String(gate.gate_id).startsWith("ai_") ? "not_applicable" : "passed";
    }
  }
  opportunityFanInCeiling(bundle).conclusion_ceiling = "strong_candidate";
  refresh(bundle, G24_FAN_IN);

  const comparison = effective(bundle, G24_COMPARISON_A);
  for (const gate of comparison.hard_gate_results as Record<string, unknown>[]) {
    gate.status = String(gate.gate_id).startsWith("ai_") ? "not_applicable" : "passed";
  }
  comparison.hard_gate_outcome = "eligible";
  comparison.recommendation_band = "investigate_further";
  for (const panel of comparison.comparison_panels as Record<string, unknown>[]) {
    panel.band = "medium";
    panel.decision_sufficiency = "sufficient";
  }
  refresh(bundle, G24_COMPARISON_A);
  setFirstBet(bundle, G23_OPPORTUNITY_A);
  refreshAllInputHashes(bundle);
}

function setCandidateReadiness(
  bundle: DocumentBundle,
  opportunityRef: string,
  comparisonPath: string,
  tier: "investigate_further" | "watch",
): void {
  const fanIn = effective(bundle, G24_FAN_IN);
  for (const gate of fanIn.hard_gate_inputs as Record<string, unknown>[]) {
    if (gate.opportunity_ref === opportunityRef) {
      gate.status = String(gate.gate_id).startsWith("ai_") ? "not_applicable" : "passed";
    }
  }
  const fanInCeiling = (fanIn.opportunity_conclusion_ceilings as Record<string, unknown>[]).find(
    (entry) => entry.opportunity_ref === opportunityRef,
  );
  assert.ok(fanInCeiling);
  fanInCeiling.conclusion_ceiling = tier === "watch" ? "watchlist" : "strong_candidate";
  refresh(bundle, G24_FAN_IN);

  const comparison = effective(bundle, comparisonPath);
  for (const gate of comparison.hard_gate_results as Record<string, unknown>[]) {
    gate.status = String(gate.gate_id).startsWith("ai_") ? "not_applicable" : "passed";
  }
  comparison.hard_gate_outcome = tier === "watch" ? "watchlist" : "eligible";
  comparison.recommendation_band = tier === "watch" ? "watchlist" : "investigate_further";
  for (const panel of comparison.comparison_panels as Record<string, unknown>[]) {
    panel.band = "medium";
    panel.decision_sufficiency = "sufficient";
  }
  refreshAllInputHashes(bundle);
}

function setAiMandatoryGateStatus(
  bundle: DocumentBundle,
  status: "passed" | "not_applicable",
): void {
  for (const artifactPath of [G24_BRANCH_SUPPORT, G24_BRANCH_CHALLENGE, G24_FAN_IN]) {
    const document = effective(bundle, artifactPath);
    for (const gate of document.hard_gate_inputs as Record<string, unknown>[]) {
      if (gate.gate_id === "ai_mandatory_bundle") {
        gate.status = status;
      }
    }
    refresh(bundle, artifactPath);
  }
  for (const artifactPath of [G24_COMPARISON_A, G24_COMPARISON_B]) {
    const document = effective(bundle, artifactPath);
    for (const gate of document.hard_gate_results as Record<string, unknown>[]) {
      if (gate.gate_id === "ai_mandatory_bundle") {
        gate.status = status;
      }
    }
    refresh(bundle, artifactPath);
  }
}

test("G2.4 validates closed enrichment, hard gates, comparison, portfolio, and report lineage", async (context) => {
  const state = await setup(context, "contract");
  const validator = await createArtifactValidator(repositoryRoot);
  const result = validator.validateDocumentBundle(state.bundle);
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  const familyProjection = effective(state.bundle, G24_PORTFOLIO)
    .opportunity_family_projection as Record<string, unknown>;
  assert.equal(familyProjection.independent_opportunity_family_count, 1);
  assert.equal(familyProjection.concrete_direction_count, 2);
  assert.equal(familyProjection.unknown_family_relation_count, 0);
  const projectedMembers = (familyProjection.families as Record<string, unknown>[]).flatMap(
    (family) => family.members as Record<string, unknown>[],
  );
  assert.deepEqual(projectedMembers.map((member) => member.relation_to_family).sort(), [
    "delivery_or_implementation_variant",
    "segment_variant",
  ]);
  assert.ok(
    projectedMembers.every(
      (member) =>
        member.uses_ai === effective(state.bundle, G23_SOLUTION).uses_ai &&
        member.solution_type === effective(state.bundle, G23_SOLUTION).solution_type &&
        member.delivery_form === effective(state.bundle, G23_SOLUTION).delivery_form,
    ),
  );
  assert.equal(
    state.bundle.documents
      .filter((candidate) => candidate.path.startsWith("artifacts/"))
      .every(
        (candidate) =>
          candidate.document.schema_version === "startup_opportunity.artifact_envelope.current",
      ),
    true,
  );
});

test("G2.4 public planning capabilities project current Policy, Schema, and closed validators", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const runId = "g2-4-planning-capabilities-synthetic";
  const result = await buildArtifactScaffold(
    {
      schema_version: "startup_opportunity.scaffold_request.current",
      scaffold_id: "g2_4_planning_capabilities_synthetic",
      kind: "planning_capabilities",
      run_id: runId,
      mode: "opportunity_discovery",
      created_at: "2026-07-27T20:55:00Z",
      scope_confirmation: {
        geography: "synthetic-primary-market",
        customer_model: "b2c",
        target_users: ["SYNTHETIC user; not Evidence."],
        decision_goal: "SYNTHETIC inspect mechanical planning capabilities.",
        research_language: "en-US",
        team_context: {
          hard_constraints: [],
          known_strengths_and_gaps: [],
          other_team_conditions: {
            status: "unknown",
            source_kind: "unknown",
            confirmation_status: "unknown",
            reporting_disclosure: "Synthetic team conditions were not provided.",
          },
        },
        user_confirmed: true,
      },
    },
    validator,
    repositoryRoot,
  );
  const compilation = result.compilation_request as Record<string, unknown>;
  const artifact = (compilation.artifacts as Record<string, unknown>[])[0] as Record<
    string,
    unknown
  >;
  const capability = artifact.document as Record<string, unknown>;
  assert.equal(artifact.producer_role, "harness");
  assert.equal(
    capability.schema_version,
    "startup_opportunity.planning_capabilities.discovery_evaluation.current",
  );
  assert.deepEqual(result.planning_capabilities, capability);
  const missingCapability = structuredClone(result);
  delete missingCapability.planning_capabilities;
  assert.equal(validator.validateDocument(missingCapability).valid, false);
  const units = capability.enrichment_units as Record<string, unknown>;
  assert.deepEqual(units.task_target_opportunity_cardinality, { minimum: 1, maximum: null });
  assert.equal(units.unit_count_fixed, false);
  assert.deepEqual(units.supported_topology_forms, [
    "shared_across_opportunities",
    "per_opportunity",
    "per_research_dimension",
    "mixed",
  ]);
  assert.ok((units.allowed_unit_types as string[]).includes("counter_evidence"));
  assert.deepEqual(capability.current_plan_counter_evidence, {
    scope: "current_plan",
    minimum_enabled_matching_units: 1,
    enabled_unit_type_any_of: ["counter_evidence", "adversarial_review"],
  });
  const fanIn = capability.fan_in_hard_gate_closure as Record<string, unknown>;
  assert.equal(fanIn.scope, "per_opportunity");
  assert.equal(fanIn.cardinality, "exactly_once_per_opportunity");
  assert.deepEqual(capability.execution_boundary, {
    capability_only: true,
    recommends_unit_count: false,
    selects_topology: false,
    decomposes_research_tasks: false,
    analyzes_research_gaps: false,
    generates_research_semantics: false,
    hidden_llm_calls: false,
  });
});

test("G2.4 accepts shared, per-opportunity, per-dimension, and mixed planning topologies", async (t) => {
  const cases = [
    {
      name: "shared-across-opportunities",
      units: [
        {
          unitId: "unit_shared_market",
          unitType: "market_space",
          sourcePhase: "enrichment_evaluation" as const,
          targetOpportunityRefs: [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B],
        },
        {
          unitId: "unit_shared_counter",
          unitType: "counter_evidence",
          sourcePhase: "adversarial_challenger" as const,
          targetOpportunityRefs: [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B],
        },
      ],
    },
    {
      name: "per-opportunity",
      units: [
        {
          unitId: "unit_opportunity_a",
          unitType: "market_space",
          sourcePhase: "enrichment_evaluation" as const,
          targetOpportunityRefs: [G23_OPPORTUNITY_A],
        },
        {
          unitId: "unit_opportunity_b_counter",
          unitType: "counter_evidence",
          sourcePhase: "adversarial_challenger" as const,
          targetOpportunityRefs: [G23_OPPORTUNITY_B],
        },
      ],
    },
    {
      name: "per-research-dimension",
      units: [
        {
          unitId: "unit_dimension_monetization",
          unitType: "monetization",
          sourcePhase: "enrichment_evaluation" as const,
          targetOpportunityRefs: [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B],
        },
        {
          unitId: "unit_dimension_buyer",
          unitType: "buyer_language",
          sourcePhase: "enrichment_evaluation" as const,
          targetOpportunityRefs: [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B],
        },
        {
          unitId: "unit_dimension_counter",
          unitType: "counter_evidence",
          sourcePhase: "adversarial_challenger" as const,
          targetOpportunityRefs: [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B],
        },
      ],
    },
    {
      name: "mixed-four-branch",
      units: [
        {
          unitId: "unit_mixed_shared",
          unitType: "market_space",
          sourcePhase: "enrichment_evaluation" as const,
          targetOpportunityRefs: [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B],
        },
        {
          unitId: "unit_mixed_a",
          unitType: "acquisition",
          sourcePhase: "enrichment_evaluation" as const,
          targetOpportunityRefs: [G23_OPPORTUNITY_A],
        },
        {
          unitId: "unit_mixed_b_counter",
          unitType: "counter_evidence",
          sourcePhase: "adversarial_challenger" as const,
          targetOpportunityRefs: [G23_OPPORTUNITY_B],
        },
        {
          unitId: "unit_mixed_compliance",
          unitType: "compliance_risk",
          sourcePhase: "enrichment_evaluation" as const,
          targetOpportunityRefs: [G23_OPPORTUNITY_A, G23_OPPORTUNITY_B],
        },
      ],
    },
  ] as const;
  for (const topology of cases) {
    await t.test(topology.name, async (context) => {
      const state = await setup(context, `planning-${topology.name}`);
      const planningBundle = await createDiscoveryEnrichmentPlanningFixture(
        state.runId,
        state.substrate,
        topology.units,
      );
      const validation = state.validator.validateDocumentBundle(planningBundle);
      assert.equal(validation.valid, true, JSON.stringify(validation, null, 2));
      const plan = effective(planningBundle, "plans/research-plan.r1.json");
      const enrichmentWave = (plan.waves as Record<string, unknown>[]).find(
        (wave) => wave.wave_id === "wave_enrichment",
      );
      assert.ok(enrichmentWave);
      assert.equal((enrichmentWave.units as unknown[]).length, topology.units.length);
      assert.deepEqual(
        (enrichmentWave.units as Record<string, unknown>[]).map((unit) => unit.unit_type).sort(),
        topology.units.map((unit) => unit.unitType).sort(),
      );
      const execution = effective(planningBundle, "plans/research-execution.r3.json");
      const executionStage = (execution.stages as Record<string, unknown>[]).find(
        (stage) => stage.stage_id === "stage_enrichment_runtime",
      );
      assert.ok(executionStage);
      const lanes = executionStage.lanes as Record<string, unknown>[];
      const dispatch = effective(planningBundle, "tasks/dispatch/enrichment_runtime.r1.json");
      const dispatchTasks = dispatch.tasks as Record<string, unknown>[];
      assert.equal(lanes.length, topology.units.length);
      assert.equal(dispatchTasks.length, topology.units.length);
      for (const expected of topology.units) {
        const taskPath = `tasks/discovery/enrichment/${expected.unitId}.attempt-1.json`;
        const taskDocument = effective(planningBundle, taskPath);
        assert.deepEqual(taskDocument.target_opportunity_refs, expected.targetOpportunityRefs);
        assert.equal(taskDocument.unit_type, expected.unitType);
        const planUnit: Record<string, unknown> | undefined = (
          enrichmentWave.units as Record<string, unknown>[]
        ).find((unit) => unit.unit_id === expected.unitId);
        const lane = lanes.find((candidate) => candidate.unit_id === expected.unitId);
        const dispatched = dispatchTasks.find((candidate) => candidate.unit_id === expected.unitId);
        assert.ok(planUnit);
        assert.ok(lane);
        assert.ok(dispatched);
        assert.equal(lane.submission_path, planUnit.output_path);
        assert.equal(dispatched.allowed_output_path, planUnit.output_path);
        assert.equal(dispatched.task_id, taskDocument.task_id);
      }
    });
  }
});

test("G2.4 opportunity-family report rendering preserves knowledge states in English", async (context) => {
  const state = await setup(context, "family-report-states-en", "general", "en-US");
  installStateRichOpportunityFamily(state.bundle);
  const validation = state.validator.validateDocumentBundle(state.bundle);
  assert.equal(validation.valid, true, JSON.stringify(validation.referenceErrors, null, 2));
  const report = evaluationEnvelope(state.bundle, G24_REPORT);
  const projection = report.document.opportunity_family_projection as Record<string, unknown>;
  const family = (projection.families as Record<string, unknown>[])[0] as Record<string, unknown>;
  assert.equal(
    (family.shared_value_or_solution_mechanism as Record<string, unknown>).state,
    "unknown",
  );
  const derived = deriveReportEnvelopes(report);
  const brief = String(
    derived.find(
      (entry) => entry.artifact_type === "startup_opportunity.decision_brief.discovery.current",
    )?.document.markdown,
  );
  const full = String(
    derived.find((entry) => entry.artifact_type === "startup_opportunity.discovery_report_view.v1")
      ?.document.markdown,
  );
  for (const surface of [brief, full]) {
    assert.match(
      surface,
      /shared mechanism state: unknown; description: SYNTHETIC shared mechanism remains unresolved/,
    );
    assert.match(surface, /user \(state: unavailable; description: SYNTHETIC user difference/);
    assert.match(surface, /buyer \(state: inferred; description: SYNTHETIC buyer difference/);
    assert.match(
      surface,
      /acquisition \(state: not applicable; description: SYNTHETIC acquisition difference/,
    );
    assert.match(
      surface,
      /compliance \(state: no evidence found; description: SYNTHETIC no evidence found/,
    );
  }
});

test("G2.4 preserves opportunity burden, explicit team matching, ranking, and report layers", async (context) => {
  const state = await setup(context, "team-positive", "general", "en-US");
  const comparisonA = effective(state.bundle, G24_COMPARISON_A);
  const comparisonB = effective(state.bundle, G24_COMPARISON_B);
  const teamPanelA = (comparisonA.comparison_panels as Record<string, unknown>[]).find(
    (panel) => panel.panel_id === "team_fit_and_learning",
  );
  const teamPanelB = (comparisonB.comparison_panels as Record<string, unknown>[]).find(
    (panel) => panel.panel_id === "team_fit_and_learning",
  );
  assert.ok(teamPanelA && teamPanelB);
  const burdenA = teamPanelA.team_startup_burden as Record<string, unknown>;
  const burdenB = teamPanelB.team_startup_burden as Record<string, unknown>;
  assert.notDeepEqual(burdenA.dimensions, burdenB.dimensions);
  assert.equal(
    (teamPanelA.team_match_analysis as Record<string, unknown>).conclusion,
    "conditional",
  );
  assert.equal((teamPanelB.team_match_analysis as Record<string, unknown>).conclusion, "unknown");
  assert.equal(
    comparisonA.hard_gate_outcome as string,
    "insufficient_evidence",
    "team matching does not become a hard rejection or replace evidence gates",
  );
  const portfolio = effective(state.bundle, G24_PORTFOLIO);
  assert.deepEqual(
    (portfolio.opportunity_ranking as Record<string, unknown>[]).map((entry) => entry.rank),
    [null, null],
  );
  const report = effective(state.bundle, G24_REPORT);
  const summary = report.team_decision_summary as Record<string, unknown>;
  assert.equal(
    (summary.team_context as Record<string, unknown>).other_team_conditions !== undefined,
    true,
  );
  assert.equal((summary.opportunity_analyses as unknown[]).length, 2);
  assert.deepEqual(summary.opportunity_ranking, portfolio.opportunity_ranking);
});

test("G2.4 accepts exact JSONL Evidence refs and hashes in team startup burden", async (context) => {
  const state = await setup(context, "team-exact-jsonl");

  const valid = clone(state.bundle);
  const exactRef = bindTeamBurdenToExactEvidence(valid, G24_COMPARISON_A);
  const validResult = state.validator.validateDocumentBundle(valid);
  assert.equal(validResult.valid, true, JSON.stringify(validResult, null, 2));

  const missing = clone(valid);
  (
    missing as unknown as {
      exact_records?: { ref: string; document: Record<string, unknown> }[];
    }
  ).exact_records = mutableExactRecords(missing).filter((record) => record.ref !== exactRef);
  const missingResult = state.validator.validateDocumentBundle(missing);
  assert.equal(missingResult.valid, false);
  assert.ok(
    missingResult.referenceErrors.some((error) => error.code === "g2_4.input_hash_mismatch"),
    JSON.stringify(missingResult.referenceErrors, null, 2),
  );

  const crossRun = clone(valid);
  exactRecordDocument(crossRun, exactRef).run_id = "other-run";
  refreshExactHashBindings(crossRun, exactRef);
  const crossRunResult = state.validator.validateDocumentBundle(crossRun);
  assert.equal(crossRunResult.valid, false);
  assert.ok(
    crossRunResult.referenceErrors.some(
      (error) =>
        error.code === "reference.run_mismatch" ||
        error.code === "g2_4.team_analysis_binding_mismatch",
    ),
    JSON.stringify(crossRunResult.referenceErrors, null, 2),
  );

  const malformed = clone(valid);
  exactRecordDocument(malformed, exactRef).schema_version =
    "startup_opportunity.evidence_store_record.v1";
  refreshExactHashBindings(malformed, exactRef);
  const malformedResult = state.validator.validateDocumentBundle(malformed);
  assert.equal(malformedResult.valid, false);
  assert.ok(
    malformedResult.bundleErrors.some((error) => error.code.startsWith("schema.")) ||
      malformedResult.referenceErrors.some(
        (error) =>
          error.code === "reference.target_invalid" ||
          error.code === "reference.type_mismatch" ||
          error.code === "g2_4.team_analysis_binding_mismatch",
      ),
    JSON.stringify(
      {
        bundleErrors: malformedResult.bundleErrors,
        referenceErrors: malformedResult.referenceErrors,
      },
      null,
      2,
    ),
  );

  const badHash = clone(valid);
  const badHashComparison = effective(badHash, G24_COMPARISON_A);
  const badHashEntry = (badHashComparison.input_artifact_hashes as Record<string, unknown>[]).find(
    (binding) => binding.ref === exactRef,
  );
  assert.ok(badHashEntry);
  badHashEntry.content_hash = `sha256:${"0".repeat(64)}`;
  refreshEnvelopeClosure(badHash, G24_COMPARISON_A);
  const badHashResult = state.validator.validateDocumentBundle(badHash);
  assert.equal(badHashResult.valid, false);
  assert.ok(
    badHashResult.referenceErrors.some((error) => error.code === "g2_4.input_hash_mismatch"),
    JSON.stringify(badHashResult.referenceErrors, null, 2),
  );
});

test("G2.4 rejects computed or unbound team matching without blocking unknown research", async (context) => {
  const state = await setup(context, "team-negative");

  const computedMatch = clone(state.bundle);
  const computedComparison = effective(computedMatch, G24_COMPARISON_A);
  const computedPanel = (computedComparison.comparison_panels as Record<string, unknown>[]).find(
    (panel) => panel.panel_id === "team_fit_and_learning",
  );
  assert.ok(computedPanel);
  const computedAnalysis = computedPanel.team_match_analysis as Record<string, unknown>;
  computedAnalysis.conclusion = "match";
  computedAnalysis.assessment = "Harness-derived match; no Agent judgment was supplied.";
  computedAnalysis.unknown_assumptions = [];
  refresh(computedMatch, G24_COMPARISON_A);
  const computedResult = state.validator.validateDocumentBundle(computedMatch);
  assert.equal(computedResult.valid, false);
  assert.ok(
    computedResult.referenceErrors.some(
      (error) => error.code === "g2_4.unconditional_team_match_invalid",
    ),
    JSON.stringify(computedResult.referenceErrors, null, 2),
  );

  const unbound = clone(state.bundle);
  const unboundComparison = effective(unbound, G24_COMPARISON_B);
  const unboundPanel = (unboundComparison.comparison_panels as Record<string, unknown>[]).find(
    (panel) => panel.panel_id === "team_fit_and_learning",
  );
  assert.ok(unboundPanel);
  const unboundAnalysis = unboundPanel.team_match_analysis as Record<string, unknown>;
  unboundAnalysis.scope_frame_ref = "scope-frame-missing.json";
  const inputHashes = unboundComparison.input_artifact_hashes as Record<string, unknown>[];
  unboundComparison.input_artifact_hashes = inputHashes.filter(
    (binding) => binding.ref !== G21_SCOPE_REF,
  );
  refresh(unbound, G24_COMPARISON_B);
  const unboundResult = state.validator.validateDocumentBundle(unbound);
  assert.equal(unboundResult.valid, false);
  assert.ok(
    unboundResult.referenceErrors.some(
      (error) => error.code === "g2_4.team_analysis_binding_mismatch",
    ),
    JSON.stringify(unboundResult.referenceErrors, null, 2),
  );

  const reportDrift = clone(state.bundle);
  const teamSummary = effective(reportDrift, G24_REPORT).team_decision_summary as Record<
    string,
    unknown
  >;
  teamSummary.opportunity_ranking = [];
  refresh(reportDrift, G24_REPORT);
  const reportResult = state.validator.validateDocumentBundle(reportDrift);
  assert.equal(reportResult.valid, false);
  assert.ok(
    reportResult.referenceErrors.some(
      (error) => error.code === "g2_4.team_report_projection_mismatch",
    ),
    JSON.stringify(reportResult.referenceErrors, null, 2),
  );

  assert.equal(state.validator.validateDocumentBundle(state.bundle).valid, true);
  const preservedBurden = (
    effective(state.bundle, G24_COMPARISON_B).comparison_panels as Record<string, unknown>[]
  ).find((panel) => panel.panel_id === "team_fit_and_learning")?.team_startup_burden as Record<
    string,
    unknown
  >;
  assert.equal(
    (preservedBurden.dimensions as Record<string, unknown>[]).some(
      (dimension) => dimension.status === "insufficient_evidence",
    ),
    true,
    "high or uncertain burden remains visible instead of being filtered",
  );
});

test("G2.4 report team projection preserves provenance labels and opportunity titles", () => {
  const dimensions = [
    "startup_capital_and_build_complexity",
    "ongoing_human_delivery",
    "acquisition_and_channel_dependency",
    "compliance_data_and_professional_liability",
    "time_to_first_meaningful_validation_or_revenue",
  ].map((dimension_id) => ({
    dimension_id,
    status: "unknown",
    assessment: "The fixture does not establish this burden dimension.",
    supporting_refs: [],
    opposing_refs: [],
    limitations: ["Synthetic fixture limitation."],
  }));
  const burden = {
    opportunity_ref: "opportunity-a",
    dimensions,
    overall_limitations: ["Synthetic burden limitation."],
  };
  const match = {
    opportunity_ref: "opportunity-a",
    scope_frame_ref: "scope-frame.json",
    conclusion: "conditional",
    assessment: "The conclusion depends on unconfirmed team assumptions.",
    basis_condition_ids: [],
    burden_dimension_ids: dimensions.map((dimension) => dimension.dimension_id),
    unknown_assumptions: ["Channel access remains unknown."],
    conditions_that_would_change_conclusion: ["Confirmed channel access."],
    limitations: ["Synthetic match limitation."],
  };
  const summary = {
    team_context: {
      hard_constraints: [
        {
          condition_id: "budget",
          statement: "Budget is fixed by the user.",
          source_kind: "user_provided",
          confirmation_status: "user_confirmed",
          reporting_disclosure: null,
        },
      ],
      known_strengths_and_gaps: [
        {
          condition_id: "authorized_assumption",
          statement: "The team may have a channel partnership.",
          source_kind: "agent_assumed",
          confirmation_status: "user_authorized_assumption",
          reporting_disclosure: "The user authorized this provisional assumption.",
        },
        {
          condition_id: "unconfirmed_assumption",
          statement: "The team may have specialist compliance coverage.",
          source_kind: "agent_assumed",
          confirmation_status: "unconfirmed_assumption",
          reporting_disclosure: "This assumption has not been confirmed by the user.",
        },
      ],
      other_team_conditions: {
        status: "unknown",
        source_kind: "unknown",
        confirmation_status: "unknown",
        reporting_disclosure: "Other team conditions were not captured.",
      },
    },
    opportunity_labels: [
      { opportunity_ref: "opportunity-a", label: "家庭照护协同" },
      { opportunity_ref: "opportunity-b", label: "本地亲子服务" },
    ],
    opportunity_analyses: [
      {
        opportunity_ref: "opportunity-a",
        comparison_ref: "comparison-a",
        team_startup_burden: burden,
        team_match_analysis: match,
      },
      {
        opportunity_ref: "opportunity-b",
        comparison_ref: "comparison-b",
        team_startup_burden: { ...burden, opportunity_ref: "opportunity-b" },
        team_match_analysis: { ...match, opportunity_ref: "opportunity-b" },
      },
    ],
    opportunity_ranking: [
      {
        rank: null,
        opportunity_ref: "opportunity-a",
        comparison_ref: "comparison-a",
        team_fit_contribution: "unknown",
        rationale: "Evidence is insufficient to order this direction.",
        other_decision_factors: ["Demand remains unknown."],
        hard_constraint_effect: {
          status: "not_applied",
          condition_ids: [],
          rationale: "No hard constraint applied.",
        },
        limitations: [],
      },
      {
        rank: null,
        opportunity_ref: "opportunity-b",
        comparison_ref: "comparison-b",
        team_fit_contribution: "unknown",
        rationale: "Evidence is insufficient to order this direction.",
        other_decision_factors: ["Demand remains unknown."],
        hard_constraint_effect: {
          status: "not_applied",
          condition_ids: [],
          rationale: "No hard constraint applied.",
        },
        limitations: [],
      },
    ],
  };
  const report = {
    report_subject_labels: [
      { subject_id: "opportunity-a", subject_ref: "opportunity-a", label: "家庭照护协同" },
    ],
    team_decision_summary: summary,
  };
  const english = renderDiscoveryTeamDecisionSummary(report, false);
  const chinese = renderDiscoveryTeamDecisionSummary(report, true);
  for (const rendered of [english, chinese]) {
    assert.match(rendered, /家庭照护协同/u);
    assert.match(rendered, /本地亲子服务/u);
    assert.match(rendered, /User-confirmed|用户已确认/u);
    assert.match(rendered, /User-authorized assumption|用户授权假设/u);
    assert.match(rendered, /Unconfirmed assumption|未确认假设/u);
    assert.match(rendered, /The user authorized this provisional assumption|用户授权/u);
    assert.match(rendered, /This assumption has not been confirmed by the user|尚未由用户确认/u);
  }
  assert.match(english, /Opportunity: 家庭照护协同 - Opportunity startup burden/u);
  assert.match(english, /Opportunity: 本地亲子服务 - Opportunity startup burden/u);
  assert.match(english, /Unranked: 家庭照护协同/u);
  assert.match(english, /Unranked: 本地亲子服务/u);
  assert.match(chinese, /机会: 家庭照护协同 - 机会自身启动负担/u);
  assert.match(chinese, /机会: 本地亲子服务 - 机会自身启动负担/u);
  assert.match(chinese, /未排序: 家庭照护协同/u);
  assert.match(chinese, /未排序: 本地亲子服务/u);
});

test("G2.4 accepts tied, partial, and explicitly unranked opportunities", async (context) => {
  const state = await setup(context, "ranking-nondegradation");
  for (const mode of ["tied", "partial"] as const) {
    const bundle = clone(state.bundle);
    const portfolio = effective(bundle, G24_PORTFOLIO);
    const ranking = portfolio.opportunity_ranking as Record<string, unknown>[];
    if (mode === "tied") {
      ranking.forEach((entry) => {
        entry.rank = 1;
      });
    } else {
      const firstRankingEntry = ranking[0] as Record<string, unknown>;
      firstRankingEntry.rank = null;
      portfolio.opportunity_ranking = [firstRankingEntry];
    }
    delete effective(bundle, G24_REPORT).team_decision_summary;
    refreshAllInputHashes(bundle);
    refreshEnvelopeClosure(bundle, G24_PORTFOLIO);
    refreshEnvelopeClosure(bundle, G24_REPORT);
    const result = state.validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, true, `${mode}: ${JSON.stringify(result, null, 2)}`);
  }
});

test("G2.4 rejects ambiguous team condition IDs, weak burden matches, and first-bet ranking drift", async (context) => {
  const state = await setup(context, "team-closure-negative");

  for (const duplicateLocation of ["same-array", "cross-array"] as const) {
    const bundle = clone(state.bundle);
    const scope = effective(bundle, G21_SCOPE_REF);
    const duplicate = {
      condition_id: "duplicate_team_condition",
      statement: "Synthetic duplicate team condition.",
      source_kind: "user_provided",
      confirmation_status: "user_confirmed",
      reporting_disclosure: null,
    };
    const teamContext = scope.team_context as Record<string, unknown>;
    if (duplicateLocation === "same-array") {
      teamContext.hard_constraints = [duplicate, { ...duplicate }];
    } else {
      teamContext.hard_constraints = [duplicate];
      teamContext.known_strengths_and_gaps = [{ ...duplicate }];
    }
    refreshAllInputHashes(bundle);
    const result = state.validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(
      result.referenceErrors.some((error) => error.code === "g2_4.team_condition_id_duplicate"),
      `${duplicateLocation}: ${JSON.stringify(result.referenceErrors, null, 2)}`,
    );
  }

  const weakMatch = clone(state.bundle);
  const weakComparison = effective(weakMatch, G24_COMPARISON_A);
  const weakPanel = (weakComparison.comparison_panels as Record<string, unknown>[]).find(
    (panel) => panel.panel_id === "team_fit_and_learning",
  );
  assert.ok(weakPanel);
  const weakAnalysis = weakPanel.team_match_analysis as Record<string, unknown>;
  weakAnalysis.conclusion = "match";
  weakAnalysis.unknown_assumptions = [];
  refreshAllInputHashes(weakMatch);
  const weakResult = state.validator.validateDocumentBundle(weakMatch);
  assert.equal(weakResult.valid, false);
  assert.ok(
    weakResult.referenceErrors.some(
      (error) => error.code === "g2_4.unconditional_team_match_invalid",
    ),
    JSON.stringify(weakResult.referenceErrors, null, 2),
  );

  const noTeamBasis = clone(state.bundle);
  const noBasisComparison = effective(noTeamBasis, G24_COMPARISON_A);
  const noBasisPanel = (noBasisComparison.comparison_panels as Record<string, unknown>[]).find(
    (panel) => panel.panel_id === "team_fit_and_learning",
  );
  assert.ok(noBasisPanel);
  const noBasisBurden = noBasisPanel.team_startup_burden as Record<string, unknown>;
  for (const dimension of noBasisBurden.dimensions as Record<string, unknown>[]) {
    dimension.status = "supported";
  }
  const noBasisAnalysis = noBasisPanel.team_match_analysis as Record<string, unknown>;
  noBasisAnalysis.conclusion = "match";
  noBasisAnalysis.unknown_assumptions = [];
  noBasisAnalysis.basis_condition_ids = [];
  refreshAllInputHashes(noTeamBasis);
  const noBasisResult = state.validator.validateDocumentBundle(noTeamBasis);
  assert.equal(noBasisResult.valid, false);
  assert.ok(
    noBasisResult.referenceErrors.some(
      (error) => error.code === "g2_4.unconditional_team_match_invalid",
    ),
    JSON.stringify(noBasisResult.referenceErrors, null, 2),
  );

  const firstBetDrift = clone(state.bundle);
  setFirstBet(firstBetDrift, G23_OPPORTUNITY_B);
  const driftPortfolio = effective(firstBetDrift, G24_PORTFOLIO);
  const driftRanking = driftPortfolio.opportunity_ranking as Record<string, unknown>[];
  for (const entry of driftRanking) {
    entry.rank = entry.opportunity_ref === G23_OPPORTUNITY_A ? 1 : 2;
  }
  delete effective(firstBetDrift, G24_REPORT).team_decision_summary;
  refreshAllInputHashes(firstBetDrift);
  const driftResult = state.validator.validateDocumentBundle(firstBetDrift);
  assert.equal(driftResult.valid, false);
  assert.ok(
    driftResult.referenceErrors.some((error) => error.code === "g2_4.first_bet_ranking_mismatch"),
    JSON.stringify(driftResult.referenceErrors, null, 2),
  );
});

test("G2.4 whole-chain fixtures preserve profile, counterfactual, merge, and AI ceilings", async (t) => {
  const profileSemantics = new Map<
    DiscoveryProfile,
    {
      readonly solutionClass: string;
      readonly deliveryForms: readonly string[];
      readonly usesAi: boolean;
    }
  >();
  for (const profile of ["general", "industry_first", "ai_first", "hybrid"] as const) {
    await t.test(profile, async (context) => {
      const state = await setup(context, `profile-${profile}`, profile);
      const result = state.validator.validateDocumentBundle(state.bundle);
      assert.equal(result.valid, true, JSON.stringify(result, null, 2));
      const laneDiversity = effective(state.bundle, G22_GENERATION_LANE)
        .candidate_diversity_summary as Record<string, unknown>;
      assert.deepEqual(laneDiversity.counterfactual_candidate_refs, [G22_DEMAND_R1]);
      const fanInDiversity = effective(state.bundle, G22_FAN_IN)
        .candidate_diversity_summary as Record<string, unknown>;
      assert.deepEqual(fanInDiversity.counterfactual_candidate_refs, [G22_DEMAND_R2]);
      const merge = effective(state.bundle, G23_MERGE);
      assert.deepEqual(merge.preserved_variants, [G23_OPPORTUNITY_B]);
      assert.ok(
        Object.values(merge.candidate_diversity_after_merge as Record<string, unknown>).every(
          (value) => Array.isArray(value) && value.length > 0,
        ),
      );
      const usesAi = profile === "ai_first" || profile === "hybrid";
      const solutionMap = effective(state.bundle, G21_SOLUTION_REF);
      const candidate = effective(state.bundle, G22_SOLUTION_R1);
      const candidateLineage = candidate.map_lineage as Record<string, unknown>;
      const candidateSubject = candidate.subject as Record<string, unknown>;
      const sourcePointer = String(candidateLineage.fragment_pointer);
      const sourceIndex = Number(sourcePointer.split("/").at(-1));
      const sourceFragment = (solutionMap.solution_candidates as Record<string, unknown>[])[
        sourceIndex
      ] as Record<string, unknown>;
      assert.equal(candidateLineage.source_map_ref, G21_SOLUTION_REF);
      assert.equal(candidateLineage.fragment_content_hash, canonicalContentHash(sourceFragment));
      assert.equal(candidateSubject.solution_class, sourceFragment.solution_class);
      assert.equal(candidateSubject.uses_ai, sourceFragment.uses_ai);
      assert.equal(candidate.discovery_profile, profile);
      const conversion = effective(state.bundle, G23_SOLUTION_CONVERSION);
      const formalSolution = effective(state.bundle, G23_SOLUTION);
      assert.equal(conversion.source_candidate_ref, G22_SOLUTION_R1);
      assert.equal(conversion.source_candidate_revision, candidate.revision);
      assert.equal(conversion.source_candidate_content_hash, canonicalContentHash(candidate));
      assert.equal(conversion.target_artifact_ref, G23_SOLUTION);
      assert.equal(conversion.target_content_hash, canonicalContentHash(formalSolution));
      assert.equal(formalSolution.source_conversion_ref, G23_SOLUTION_CONVERSION);
      assert.equal(formalSolution.source_candidate_ref, G22_SOLUTION_R1);
      assert.equal(formalSolution.uses_ai, usesAi);
      assert.equal(formalSolution.uses_ai, candidateSubject.uses_ai);
      assert.equal(effective(state.bundle, G23_OPPORTUNITY_A).selected_solution_ref, G23_SOLUTION);
      assert.deepEqual(effective(state.bundle, G24_REPORT).comparison_refs, [
        G24_COMPARISON_A,
        G24_COMPARISON_B,
      ]);
      profileSemantics.set(profile, {
        solutionClass: String(candidateSubject.solution_class),
        deliveryForms: [...(candidateSubject.delivery_forms as string[])],
        usesAi,
      });
      for (const comparisonRef of [G24_COMPARISON_A, G24_COMPARISON_B]) {
        const aiGate = (
          effective(state.bundle, comparisonRef).hard_gate_results as Record<string, unknown>[]
        ).find((gate) => gate.gate_id === "ai_mandatory_bundle");
        assert.equal(aiGate?.status, usesAi ? "insufficient_evidence" : "not_applicable");
      }
    });
  }
  assert.notDeepEqual(profileSemantics.get("general"), profileSemantics.get("industry_first"));
  assert.equal(profileSemantics.get("general")?.usesAi, false);
  assert.equal(profileSemantics.get("industry_first")?.usesAi, false);
  assert.equal(profileSemantics.get("ai_first")?.usesAi, true);
  assert.equal(profileSemantics.get("hybrid")?.usesAi, true);
});

test("G2.4 rejects AI-selected solutions whose mandatory G3 gate fails open", async (t) => {
  for (const scenario of [
    { profile: "ai_first", status: "not_applicable" },
    { profile: "hybrid", status: "passed" },
  ] as const) {
    await t.test(`${scenario.profile}-${scenario.status}`, async (context) => {
      const state = await setup(context, `ai-gate-${scenario.profile}`, scenario.profile);
      const bundle = clone(state.bundle);
      setAiMandatoryGateStatus(bundle, scenario.status);
      const result = state.validator.validateDocumentBundle(bundle);
      assert.equal(result.valid, false);
      assert.ok(
        result.referenceErrors.some(
          (error) => error.code === "g2_4.ai_mandatory_bundle_gate_violation",
        ),
        JSON.stringify(result.referenceErrors, null, 2),
      );
    });
  }

  await t.test("selected-solution-toggle", async (context) => {
    const state = await setup(context, "ai-gate-toggle", "general");
    const bundle = clone(state.bundle);
    effective(bundle, G23_SOLUTION).uses_ai = true;
    refresh(bundle, G23_SOLUTION);
    const result = state.validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false);
    assert.ok(
      result.referenceErrors.some(
        (error) => error.code === "g2_4.ai_mandatory_bundle_gate_violation",
      ),
      JSON.stringify(result.referenceErrors, null, 2),
    );
  });
});

test("G2.4 decision tier obeys null, insufficient, and mixed readiness ceilings", async (context) => {
  const state = await setup(context, "decision-ceilings");
  const cases: readonly {
    readonly name: string;
    readonly mutate: (bundle: DocumentBundle) => void;
  }[] = [
    {
      name: "null-first-bet",
      mutate(bundle) {
        effective(bundle, G24_RECOMMENDATION).decision_tier = "prioritize";
        refresh(bundle, G24_RECOMMENDATION);
      },
    },
    {
      name: "insufficient-first-bet",
      mutate(bundle) {
        setFirstBet(bundle, G23_OPPORTUNITY_A);
      },
    },
    {
      name: "mixed-readiness",
      mutate(bundle) {
        const fanIn = effective(bundle, G24_FAN_IN);
        for (const gate of fanIn.hard_gate_inputs as Record<string, unknown>[]) {
          if (gate.opportunity_ref === G23_OPPORTUNITY_A) {
            gate.status = String(gate.gate_id).startsWith("ai_") ? "not_applicable" : "passed";
          }
        }
        const ceiling = (fanIn.opportunity_conclusion_ceilings as Record<string, unknown>[]).find(
          (entry) => entry.opportunity_ref === G23_OPPORTUNITY_A,
        );
        assert.ok(ceiling);
        ceiling.conclusion_ceiling = "strong_candidate";
        refresh(bundle, G24_FAN_IN);
        const comparison = effective(bundle, G24_COMPARISON_A);
        for (const gate of comparison.hard_gate_results as Record<string, unknown>[]) {
          gate.status = String(gate.gate_id).startsWith("ai_") ? "not_applicable" : "passed";
        }
        comparison.hard_gate_outcome = "eligible";
        const hash = (comparison.input_artifact_hashes as Record<string, unknown>[]).find(
          (entry) => entry.ref === G24_FAN_IN,
        );
        assert.ok(hash);
        hash.content_hash = canonicalContentHash(fanIn);
        refresh(bundle, G24_COMPARISON_A);
        setFirstBet(bundle, G23_OPPORTUNITY_A);
      },
    },
    {
      name: "fan-in-reject",
      mutate(bundle) {
        const fanIn = effective(bundle, G24_FAN_IN);
        const fanCeiling = (
          fanIn.opportunity_conclusion_ceilings as Record<string, unknown>[]
        ).find((entry) => entry.opportunity_ref === G23_OPPORTUNITY_A);
        assert.ok(fanCeiling);
        fanCeiling.conclusion_ceiling = "reject";
        refresh(bundle, G24_FAN_IN);
        refreshAllInputHashes(bundle);
        setFirstBet(bundle, G23_OPPORTUNITY_A);
        effective(bundle, G24_RECOMMENDATION).decision_tier = "investigate_further";
        const report = effective(bundle, G24_REPORT);
        (report.curated_judgment_context as Record<string, unknown>).decision_tier =
          "investigate_further";
        refreshAllInputHashes(bundle);
      },
    },
  ];
  for (const candidate of cases) {
    const bundle = clone(state.bundle);
    candidate.mutate(bundle);
    const result = state.validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false, candidate.name);
    assert.ok(
      result.referenceErrors.some((error) => error.code === "g2_4.decision_tier_ceiling_violation"),
      `${candidate.name}: ${JSON.stringify(result.referenceErrors, null, 2)}`,
    );
  }
});

test("G2.4 decision tier uses the strictest commercial, fan-in, comparison, gate, panel, and portfolio ceiling", async (context) => {
  const state = await setup(context, "decision-ceiling-matrix");
  const ready = clone(state.bundle);
  makeFirstBetReady(ready);
  const overCommercialCeiling = state.validator.validateDocumentBundle(ready);
  assert.equal(overCommercialCeiling.valid, false);
  assert.ok(
    overCommercialCeiling.referenceErrors.some(
      (error) => error.code === "terminal_reporting.recommendation_ceiling_exceeded",
    ),
    JSON.stringify(overCommercialCeiling.referenceErrors, null, 2),
  );
  setDecisionTier(ready, "investigate_further");
  assert.equal(
    state.validator.validateDocumentBundle(ready).valid,
    true,
    JSON.stringify(state.validator.validateDocumentBundle(ready), null, 2),
  );

  const nextTier: Readonly<Partial<Record<DecisionTier, DecisionTier>>> = {
    reject: "insufficient_evidence",
    insufficient_evidence: "watch",
    watch: "investigate_further",
    investigate_further: "prioritize",
  };
  const assertAtAndAbove = (name: string, source: DocumentBundle, ceiling: DecisionTier): void => {
    const legal = clone(source);
    setDecisionTier(legal, ceiling);
    const legalResult = state.validator.validateDocumentBundle(legal);
    assert.equal(legalResult.valid, true, `${name} legal: ${JSON.stringify(legalResult, null, 2)}`);
    const over = nextTier[ceiling];
    if (over === undefined) {
      return;
    }
    const invalid = clone(source);
    setDecisionTier(invalid, over);
    const invalidResult = state.validator.validateDocumentBundle(invalid);
    assert.equal(invalidResult.valid, false, `${name} over-ceiling`);
    assert.ok(
      invalidResult.referenceErrors.some(
        (error) =>
          error.code === "g2_4.decision_tier_ceiling_violation" ||
          error.code === "terminal_reporting.recommendation_ceiling_exceeded",
      ),
      `${name}: ${JSON.stringify(invalidResult.referenceErrors, null, 2)}`,
    );
  };

  for (const candidate of [
    { fan: "reject", band: "reject", tier: "reject" },
    {
      fan: "insufficient_evidence",
      band: "investigate_further",
      tier: "insufficient_evidence",
    },
    { fan: "watchlist", band: "watchlist", tier: "watch" },
    {
      fan: "investigate_further",
      band: "investigate_further",
      tier: "investigate_further",
    },
    {
      fan: "strong_candidate",
      band: "investigate_further",
      tier: "investigate_further",
    },
  ] as const) {
    const bundle = clone(ready);
    opportunityFanInCeiling(bundle).conclusion_ceiling = candidate.fan;
    effective(bundle, G24_COMPARISON_A).recommendation_band = candidate.band;
    refreshAllInputHashes(bundle);
    assertAtAndAbove(`fan-in-${candidate.fan}`, bundle, candidate.tier);
  }

  for (const candidate of [
    {
      name: "comparison-reject",
      gate: "failed",
      outcome: "reject",
      band: "reject",
      tier: "reject",
    },
    {
      name: "comparison-insufficient",
      gate: "insufficient_evidence",
      outcome: "insufficient_evidence",
      band: "investigate_further",
      tier: "insufficient_evidence",
    },
    {
      name: "comparison-watch",
      gate: "passed",
      outcome: "watchlist",
      band: "watchlist",
      tier: "watch",
    },
    {
      name: "comparison-investigate",
      gate: "passed",
      outcome: "eligible",
      band: "investigate_further",
      tier: "investigate_further",
    },
    {
      name: "comparison-investigate-commercial-ceiling",
      gate: "passed",
      outcome: "eligible",
      band: "investigate_further",
      tier: "investigate_further",
    },
  ] as const) {
    const bundle = clone(ready);
    setOpportunityGateStatus(bundle, "user_jtbd_entry_scene", candidate.gate);
    const comparison = effective(bundle, G24_COMPARISON_A);
    comparison.hard_gate_outcome = candidate.outcome;
    comparison.recommendation_band = candidate.band;
    refreshAllInputHashes(bundle);
    assertAtAndAbove(candidate.name, bundle, candidate.tier);
  }

  for (const candidate of [
    {
      name: "panel-insufficient",
      sufficiency: "insufficient",
      band: "unknown",
      tier: "insufficient_evidence",
    },
    { name: "panel-partial", sufficiency: "partial", band: "medium", tier: "investigate_further" },
    {
      name: "panel-sufficient",
      sufficiency: "sufficient",
      band: "medium",
      tier: "investigate_further",
    },
  ] as const) {
    const bundle = clone(ready);
    const comparison = effective(bundle, G24_COMPARISON_A);
    const panel = (comparison.comparison_panels as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
    panel.decision_sufficiency = candidate.sufficiency;
    panel.band = candidate.band;
    if (candidate.tier === "insufficient_evidence") {
      comparison.recommendation_band = "investigate_further";
    }
    refreshAllInputHashes(bundle);
    assertAtAndAbove(candidate.name, bundle, candidate.tier);
  }

  const nullFirstBet = clone(state.bundle);
  assertAtAndAbove("portfolio-null-first-bet", nullFirstBet, "insufficient_evidence");

  const portfolioMismatch = clone(ready);
  effective(portfolioMismatch, G24_PORTFOLIO).recommended_first_bet = G23_OPPORTUNITY_B;
  refreshAllInputHashes(portfolioMismatch);
  setDecisionTier(portfolioMismatch, "prioritize");
  const mismatchResult = state.validator.validateDocumentBundle(portfolioMismatch);
  assert.equal(mismatchResult.valid, false);
  assert.ok(
    mismatchResult.referenceErrors.some(
      (error) => error.code === "g2_4.decision_tier_ceiling_violation",
    ),
    JSON.stringify(mismatchResult.referenceErrors, null, 2),
  );

  const mixed = clone(ready);
  opportunityFanInCeiling(mixed).conclusion_ceiling = "watchlist";
  effective(mixed, G24_COMPARISON_A).recommendation_band = "watchlist";
  const mixedPanel = (
    effective(mixed, G24_COMPARISON_A).comparison_panels as Record<string, unknown>[]
  )[0] as Record<string, unknown>;
  mixedPanel.decision_sufficiency = "insufficient";
  mixedPanel.band = "unknown";
  refreshAllInputHashes(mixed);
  assertAtAndAbove("mixed-watch-and-insufficient", mixed, "insufficient_evidence");

  setDecisionTier(mixed, "investigate_further");
  const recoveryValidation = state.validator.validateDocumentBundle(mixed);
  assert.equal(recoveryValidation.valid, false);
  assert.ok(
    recoveryValidation.referenceErrors.some(
      (error) => error.code === "g2_4.decision_tier_ceiling_violation",
    ),
    JSON.stringify(recoveryValidation.referenceErrors, null, 2),
  );
});

test("G2.4 binds first-bet and candidate ceilings per subject and derives null portfolio readiness", async (context) => {
  const state = await setup(context, "per-subject-decision-ceilings");
  const selectedA = clone(state.bundle);
  setCandidateReadiness(selectedA, G23_OPPORTUNITY_A, G24_COMPARISON_A, "investigate_further");
  setCandidateReadiness(selectedA, G23_OPPORTUNITY_B, G24_COMPARISON_B, "watch");
  setFirstBet(selectedA, G23_OPPORTUNITY_A);
  setDecisionTier(selectedA, "investigate_further");
  const selectedAResult = state.validator.validateDocumentBundle(selectedA);
  assert.equal(selectedAResult.valid, true, JSON.stringify(selectedAResult, null, 2));
  assert.deepEqual(effective(selectedA, G24_PORTFOLIO).alternative_bets, [G23_OPPORTUNITY_B]);

  const switchedToB = clone(selectedA);
  setFirstBet(switchedToB, G23_OPPORTUNITY_B);
  setDecisionTier(switchedToB, "investigate_further");
  const switchedOverstatement = state.validator.validateDocumentBundle(switchedToB);
  assert.equal(switchedOverstatement.valid, false);
  assert.ok(
    switchedOverstatement.referenceErrors.some(
      (error) => error.code === "g2_4.decision_tier_ceiling_violation",
    ),
    JSON.stringify(switchedOverstatement.referenceErrors, null, 2),
  );
  setDecisionTier(switchedToB, "watch");
  const switchedLegal = state.validator.validateDocumentBundle(switchedToB);
  assert.equal(switchedLegal.valid, true, JSON.stringify(switchedLegal, null, 2));

  const overstatedAlternative = clone(selectedA);
  setCandidateReadiness(
    overstatedAlternative,
    G23_OPPORTUNITY_B,
    G24_COMPARISON_B,
    "investigate_further",
  );
  effective(overstatedAlternative, G24_COMPARISON_B).recommendation_band = "strong_candidate";
  refreshAllInputHashes(overstatedAlternative);
  const overstatedAlternativeResult = state.validator.validateDocumentBundle(overstatedAlternative);
  assert.equal(overstatedAlternativeResult.valid, false);
  assert.ok(
    overstatedAlternativeResult.referenceErrors.some(
      (error) => error.code === "g2_4.candidate_commercial_ceiling_violation",
    ),
    JSON.stringify(overstatedAlternativeResult.referenceErrors, null, 2),
  );

  const nullInvestigate = clone(state.bundle);
  setCandidateReadiness(
    nullInvestigate,
    G23_OPPORTUNITY_A,
    G24_COMPARISON_A,
    "investigate_further",
  );
  setCandidateReadiness(nullInvestigate, G23_OPPORTUNITY_B, G24_COMPARISON_B, "watch");
  setDecisionTier(nullInvestigate, "investigate_further");
  const nullInvestigateResult = state.validator.validateDocumentBundle(nullInvestigate);
  assert.equal(nullInvestigateResult.valid, true, JSON.stringify(nullInvestigateResult, null, 2));
  setDecisionTier(nullInvestigate, "prioritize");
  const nullPrioritizeResult = state.validator.validateDocumentBundle(nullInvestigate);
  assert.equal(nullPrioritizeResult.valid, false);
  assert.ok(
    nullPrioritizeResult.referenceErrors.some(
      (error) => error.code === "g2_4.decision_tier_ceiling_violation",
    ),
  );

  const nullWatch = clone(state.bundle);
  setCandidateReadiness(nullWatch, G23_OPPORTUNITY_A, G24_COMPARISON_A, "watch");
  setCandidateReadiness(nullWatch, G23_OPPORTUNITY_B, G24_COMPARISON_B, "watch");
  setDecisionTier(nullWatch, "watch");
  const nullWatchResult = state.validator.validateDocumentBundle(nullWatch);
  assert.equal(nullWatchResult.valid, true, JSON.stringify(nullWatchResult, null, 2));

  const nullInsufficient = clone(state.bundle);
  const nullInsufficientResult = state.validator.validateDocumentBundle(nullInsufficient);
  assert.equal(nullInsufficientResult.valid, true, JSON.stringify(nullInsufficientResult, null, 2));
  assert.equal(
    effective(nullInsufficient, G24_RECOMMENDATION).decision_tier,
    "insufficient_evidence",
  );
});

test("G2.4 current contract rejects selected Solution semantic drift", async (context) => {
  const repairedState = await setup(context, "v13-semantic-drift", "ai_first");
  const repaired = clone(repairedState.bundle);
  effective(repaired, G23_SOLUTION).uses_ai = false;
  refreshAllInputHashes(repaired);
  const repairedResult = repairedState.validator.validateDocumentBundle(repaired);
  assert.equal(repairedResult.valid, false);
  assert.ok(
    repairedResult.referenceErrors.some(
      (error) => error.code === "synthesis.solution_candidate_semantic_drift",
    ),
    JSON.stringify(repairedResult.referenceErrors, null, 2),
  );
});

test("G2.4 forbidden-expression rules cover every formal surface and separator variant", async (context) => {
  const propertyClasses = [
    {
      rule: "market_validation_success",
      tokenOrders: [
        ["market", "validation", "succeeded"],
        ["succeeded", "market", "validation"],
        ["validation", "success"],
        ["success", "validation"],
      ],
    },
    {
      rule: "probability_claim",
      tokenOrders: [
        ["success", "probability"],
        ["probability", "success"],
        ["probability", "of", "success"],
        ["success", "of", "probability"],
        ["probability", "95", "percent"],
        ["95", "percent", "probability"],
        ["chance", "95", "percent"],
        ["95", "percent", "chance"],
      ],
    },
    {
      rule: "global_score",
      tokenOrders: [
        ["global", "score"],
        ["score", "global"],
        ["overall", "score"],
        ["score", "overall"],
      ],
    },
  ] as const;
  for (const surface of ["structured_report", "decision_brief", "report_view"] as const) {
    for (const property of propertyClasses) {
      for (const tokens of property.tokenOrders) {
        const normalizedMatches = new Set<string>();
        for (const separator of [" ", "-", "_"] as const) {
          const matches = scanReportSurface(surface, tokens.join(separator));
          const match = matches.find((candidate) =>
            candidate.startsWith(`${property.rule}@${surface}:`),
          );
          assert.ok(match, `${property.rule}:${surface}:${tokens.join(separator)}`);
          normalizedMatches.add(match);
        }
        assert.equal(normalizedMatches.size, 1, `${property.rule}:${surface}:${tokens.join("|")}`);
      }
    }
  }
  assert.deepEqual(scanReportSurface("report_view", "local score remains unknown"), []);
  assert.deepEqual(scanReportSurface("structured_report", "market validation remains pending"), []);

  const state = await setup(context, "surface-boundary");
  const report = evaluationEnvelope(state.bundle, G24_REPORT);
  const derived = deriveReportEnvelopes(report);
  for (const artifactType of [
    "startup_opportunity.decision_brief.discovery.current",
    "startup_opportunity.discovery_report_view.v1",
  ]) {
    const envelope = clone(
      derived.find(
        (candidate) => candidate.artifact_type === artifactType,
      ) as FormalArtifactEnvelope,
    );
    envelope.document.markdown =
      "validation_success achieved with global_score and success_probability.";
    envelope.document.markdown_content_hash = sha256Bytes(String(envelope.document.markdown));
    (envelope as { content_hash: string }).content_hash = canonicalContentHash(envelope.document);
    const validation = state.validator.validateDocument(envelope, envelope.artifact_path);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "g2_4.forbidden_report_expression"));
    await assert.rejects(
      state.store.publishArtifact({ runId: state.runId, envelope }),
      (error: unknown) => error instanceof StoreError && error.code === "artifact.schema_invalid",
    );
    await assert.rejects(
      readFile(path.join(state.runRoot, envelope.artifact_path), "utf8"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    );
  }

  const appendix = clone(
    derived.find(
      (candidate) => candidate.artifact_type === "startup_opportunity.discovery_report_view.v1",
    ) as FormalArtifactEnvelope,
  );
  appendix.document.audit_appendix_markdown =
    "validation_success achieved with global_score and success_probability.";
  appendix.document.audit_appendix_content_hash = sha256Bytes(
    String(appendix.document.audit_appendix_markdown),
  );
  (appendix as { content_hash: string }).content_hash = canonicalContentHash(appendix.document);
  const appendixValidation = state.validator.validateDocument(appendix, appendix.artifact_path);
  assert.equal(appendixValidation.valid, false);
  assert.ok(
    appendixValidation.errors.some((error) => error.code === "g2_4.forbidden_report_expression"),
  );
});

test("G2.4 forbidden sidecar fails before receipt and remains absent through checkpoint recovery", async (context) => {
  const state = await setup(context, "forbidden-sidecar-recovery");
  await publishThroughEvaluation(state);
  await state.store.checkpoint({
    runId: state.runId,
    checkpointId: "checkpoint_before_forbidden_sidecar",
    createdAt: "2026-07-27T22:00:00Z",
    nextStep: "SYNTHETIC reject any forbidden report sidecar before publication.",
    beliefSummary: {
      current_belief: "SYNTHETIC report sidecars remain caller-supplied and unvalidated as truth.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["SYNTHETIC no validation success is claimed."],
      remaining_disagreement: ["SYNTHETIC market truth remains unknown."],
      next_decision_relevant_question: "SYNTHETIC should a clean report be supplied?",
    },
    inputRefs: [G24_RECOMMENDATION, G24_TRACEABILITY],
  });
  const report = evaluationEnvelope(state.bundle, G24_REPORT);
  const sidecar = clone(
    deriveReportEnvelopes(report).find(
      (candidate) =>
        candidate.artifact_type === "startup_opportunity.decision_brief.discovery.current",
    ) as FormalArtifactEnvelope,
  );
  sidecar.document.markdown =
    "Market-validation succeeded with success_probability and global-score.";
  sidecar.document.markdown_content_hash = sha256Bytes(String(sidecar.document.markdown));
  (sidecar as { content_hash: string }).content_hash = canonicalContentHash(sidecar.document);
  const operationsBefore = (await readdir(path.join(state.runRoot, ".store/operations"))).sort();
  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: sidecar,
      faultAt: "after_intent",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.schema_invalid",
  );
  assert.deepEqual(
    (await readdir(path.join(state.runRoot, ".store/operations"))).sort(),
    operationsBefore,
  );
  await assert.rejects(
    readFile(path.join(state.runRoot, sidecar.artifact_path), "utf8"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
  const reopened = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.ok(!reopened.manifest.artifact_refs.includes(sidecar.artifact_path));
  assert.equal(reopened.recovered, false);
});

test("G2.4 reverse-order report mutations fail before every formal lifecycle write", async (context) => {
  const state = await setup(context, "reverse-order-zero-write");
  await publishThroughEvaluation(state);
  await state.store.checkpoint({
    runId: state.runId,
    checkpointId: "checkpoint_before_reverse_order_mutations",
    createdAt: "2026-07-27T22:00:00Z",
    nextStep: "SYNTHETIC reject forbidden report language before any formal write.",
    beliefSummary: {
      current_belief: "SYNTHETIC report contract mechanics only.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["SYNTHETIC no validation success is claimed."],
      remaining_disagreement: ["SYNTHETIC market truth remains unknown."],
      next_decision_relevant_question: "SYNTHETIC should a clean report be supplied?",
    },
    inputRefs: [G24_RECOMMENDATION, G24_TRACEABILITY],
  });
  const baselineTree = await treeSnapshot(state.runRoot);
  const reverseCases = [
    { rule: "market_validation_success", phrase: "success_validation" },
    { rule: "probability_claim", phrase: "chance-95-percent" },
    { rule: "global_score", phrase: "score_global" },
  ] as const;
  const reportFaults = [
    "after_report_sidecar",
    "after_report_materialization",
    "after_brief_sidecar",
    "after_brief_materialization",
    "after_view_sidecar",
    "after_view_materialization",
    "after_appendix_materialization",
    "after_consistency_sidecar",
  ] as const;

  for (const candidate of reverseCases) {
    const report = clone(evaluationEnvelope(state.bundle, G24_REPORT));
    const judgmentContext = report.document.curated_judgment_context as Record<string, unknown>;
    judgmentContext.current_recommendation = candidate.phrase;
    (report as { content_hash: string }).content_hash = canonicalContentHash(report.document);
    const validation = state.validator.validateDocument(report, report.artifact_path);
    assert.equal(validation.valid, false, candidate.rule);
    assert.ok(
      validation.errors.some(
        (error) =>
          error.code === "g2_4.forbidden_report_expression" &&
          JSON.stringify(error.details).includes(`${candidate.rule}@structured_report:`),
      ),
      JSON.stringify(validation.errors, null, 2),
    );
    await assert.rejects(
      state.store.publishArtifact({
        runId: state.runId,
        envelope: report,
        faultAt: "after_intent",
      }),
      (error: unknown) => error instanceof StoreError && error.code === "artifact.schema_invalid",
    );
    for (const faultAt of reportFaults) {
      await assert.rejects(
        new ReportRuntime(state.runsRoot, state.validator).build({
          reportEnvelope: report,
          faultAt,
        }),
        (error: unknown) =>
          error instanceof StoreError && error.code === "report.forbidden_expression_detected",
      );
      assert.deepEqual(
        await treeSnapshot(state.runRoot),
        baselineTree,
        `${candidate.rule}:${faultAt}`,
      );
    }

    const derived = deriveReportEnvelopes(evaluationEnvelope(state.bundle, G24_REPORT));
    for (const artifactType of [
      "startup_opportunity.decision_brief.discovery.current",
      "startup_opportunity.discovery_report_view.v1",
    ]) {
      const sidecar = clone(
        derived.find((entry) => entry.artifact_type === artifactType) as FormalArtifactEnvelope,
      );
      const surface =
        artifactType === "startup_opportunity.decision_brief.discovery.current"
          ? "decision_brief"
          : "report_view";
      sidecar.document.markdown = candidate.phrase;
      sidecar.document.markdown_content_hash = sha256Bytes(candidate.phrase);
      (sidecar as { content_hash: string }).content_hash = canonicalContentHash(sidecar.document);
      const sidecarValidation = state.validator.validateDocument(sidecar, sidecar.artifact_path);
      assert.equal(sidecarValidation.valid, false, `${candidate.rule}:${surface}`);
      assert.ok(
        sidecarValidation.errors.some(
          (error) =>
            error.code === "g2_4.forbidden_report_expression" &&
            JSON.stringify(error.details).includes(`${candidate.rule}@${surface}:`),
        ),
        JSON.stringify(sidecarValidation.errors, null, 2),
      );
      await assert.rejects(
        state.store.publishArtifact({
          runId: state.runId,
          envelope: sidecar,
          faultAt: "after_intent",
        }),
        (error: unknown) => error instanceof StoreError && error.code === "artifact.schema_invalid",
      );
      assert.deepEqual(
        await treeSnapshot(state.runRoot),
        baselineTree,
        `${candidate.rule}:${surface}`,
      );
    }
  }

  const reopened = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.equal(reopened.recovered, false);
  assert.ok(!reopened.manifest.artifact_refs.includes(G24_REPORT));
  for (const artifactPath of [
    G24_REPORT,
    "artifacts/reporting/decision-brief.r1.json",
    "artifacts/reporting/report-markdown.r1.json",
    "artifacts/reporting/consistency-evaluation.r1.json",
    "report.json",
    "decision-brief.md",
    "report.md",
    "audit-appendix.md",
  ]) {
    assert.ok(!(artifactPath in (await treeSnapshot(state.runRoot))), artifactPath);
  }
  assert.deepEqual(await treeSnapshot(state.runRoot), baselineTree);
});

test("G2.4 current report scan rejects global-score language", async (context) => {
  const repairedState = await setup(context, "v13-report-scan-dispatch", "ai_first");
  const repairedReport = clone(evaluationEnvelope(repairedState.bundle, G24_REPORT));
  const repairedContext = repairedReport.document.curated_judgment_context as Record<
    string,
    unknown
  >;
  repairedContext.current_recommendation = "score_global";
  (repairedReport as { content_hash: string }).content_hash = canonicalContentHash(
    repairedReport.document,
  );
  const repairedValidation = repairedState.validator.validateDocument(
    repairedReport,
    repairedReport.artifact_path,
  );
  assert.equal(repairedValidation.valid, false);
  assert.ok(
    repairedValidation.errors.some((error) => error.code === "g2_4.forbidden_report_expression"),
  );
  const repairedConsistency = deriveReportEnvelopes(repairedReport).find(
    (candidate) =>
      candidate.artifact_type ===
      "startup_opportunity.report_consistency_evaluation.discovery.current",
  );
  assert.ok(repairedConsistency);
  assert.equal(repairedConsistency.document.evaluator_result, "failed");
  assert.ok(
    (repairedConsistency.document.forbidden_expression_matches as string[]).some((match) =>
      match.startsWith("global_score@structured_report:"),
    ),
  );
});

test("G2.4 rejects closed contract mutations with deterministic error codes", async (context) => {
  const state = await setup(context, "negative");
  const validator = await createArtifactValidator(repositoryRoot);
  const mutations: readonly {
    readonly code: string;
    readonly mutate: (bundle: DocumentBundle) => void;
  }[] = [
    {
      code: "g2_4.task_plan_unit_mismatch",
      mutate(bundle) {
        effective(bundle, G24_TASK_SUPPORT).unit_id = "unit_unplanned_enrichment";
        refresh(bundle, G24_TASK_SUPPORT);
      },
    },
    {
      code: "g2_4.material_task_binding_mismatch",
      mutate(bundle) {
        (effective(bundle, G24_EVIDENCE_SUPPORT).lineage as Record<string, unknown>).task_ref =
          "tasks/discovery/enrichment/unit_enrichment_challenge.attempt-1.json";
        refresh(bundle, G24_EVIDENCE_SUPPORT);
      },
    },
    {
      code: "g2_4.task_snapshot_merge_binding_mismatch",
      mutate(bundle) {
        effective(bundle, G24_TASK_SUPPORT).source_merge_ref =
          "artifacts/discovery/merges/merge-missing.r1.json";
        refresh(bundle, G24_TASK_SUPPORT);
      },
    },
    {
      code: "g2_4.opportunity_family_projection_mismatch",
      mutate(bundle) {
        const projection = effective(bundle, G24_PORTFOLIO).opportunity_family_projection as Record<
          string,
          unknown
        >;
        const member = (
          (projection.families as Record<string, unknown>[])[0]?.members as
            | Record<string, unknown>[]
            | undefined
        )?.[0];
        assert.ok(member);
        member.uses_ai = !member.uses_ai;
        refreshEnvelopeClosure(bundle, G24_PORTFOLIO);
      },
    },
    {
      code: "g2_4.opportunity_family_projection_mismatch",
      mutate(bundle) {
        effective(bundle, G23_SOLUTION).uses_ai = !effective(bundle, G23_SOLUTION).uses_ai;
        refresh(bundle, G23_SOLUTION);
        refreshAllInputHashes(bundle);
      },
    },
    {
      code: "g2_4.opportunity_family_projection_mismatch",
      mutate(bundle) {
        effective(bundle, G23_OPPORTUNITY_A).title = "SYNTHETIC changed opportunity title";
        refresh(bundle, G23_OPPORTUNITY_A);
        refreshAllInputHashes(bundle);
      },
    },
    {
      code: "g2_4.evidence_substrate_binding_mismatch",
      mutate(bundle) {
        (
          effective(bundle, G24_EVIDENCE_SUPPORT).mechanical_binding as Record<string, unknown>
        ).content_hash = "0".repeat(64);
        refresh(bundle, G24_EVIDENCE_SUPPORT);
      },
    },
    {
      code: "g2_4.fan_in_classification_mismatch",
      mutate(bundle) {
        const classification = effective(bundle, G24_FAN_IN).branch_result_classification as Record<
          string,
          unknown
        >;
        classification.completed_refs = [G24_BRANCH_SUPPORT];
        classification.insufficient_evidence_refs = [
          "artifacts/discovery/enrichment/branches/unit_enrichment_challenge.attempt-1.json",
        ];
        refresh(bundle, G24_FAN_IN);
      },
    },
    {
      code: "g2_4.fan_in_material_closure_mismatch",
      mutate(bundle) {
        effective(bundle, G24_FAN_IN).claim_refs = [
          "claims/discovery/enrichment/claim-support.json",
        ];
        refresh(bundle, G24_FAN_IN);
      },
    },
    {
      code: "g2_4.hard_gate_closure_mismatch",
      mutate(bundle) {
        const gates = effective(bundle, G24_FAN_IN).hard_gate_inputs as Record<string, unknown>[];
        gates.pop();
        refresh(bundle, G24_FAN_IN);
      },
    },
    {
      code: "g2_4.panel_closure_mismatch",
      mutate(bundle) {
        const panels = effective(bundle, G24_COMPARISON_A).comparison_panels as Record<
          string,
          unknown
        >[];
        (panels[3] as Record<string, unknown>).panel_id = "evidence_strength";
        refresh(bundle, G24_COMPARISON_A);
      },
    },
    {
      code: "g2_4.comparison_gate_lineage_mismatch",
      mutate(bundle) {
        const gates = effective(bundle, G24_COMPARISON_A).hard_gate_results as Record<
          string,
          unknown
        >[];
        (gates[0] as Record<string, unknown>).status = "passed";
        refresh(bundle, G24_COMPARISON_A);
      },
    },
    {
      code: "g2_4.comparison_subject_binding_mismatch",
      mutate(bundle) {
        effective(bundle, G24_ENGINE_A).source_snapshot_ref =
          "artifacts/discovery/thesis-snapshots/snapshot-missing.r1.json";
        refresh(bundle, G24_ENGINE_A);
      },
    },
    {
      code: "g2_4.evidence_ceiling_violation",
      mutate(bundle) {
        effective(bundle, G24_COMPARISON_A).recommendation_band = "strong_candidate";
        refresh(bundle, G24_COMPARISON_A);
      },
    },
    {
      code: "g2_4.sensitivity_relation_mismatch",
      mutate(bundle) {
        effective(bundle, G24_SENSITIVITY).pairwise_relations = [];
        refresh(bundle, G24_SENSITIVITY);
      },
    },
    {
      code: "g2_4.portfolio_closure_mismatch",
      mutate(bundle) {
        effective(bundle, G24_PORTFOLIO).watchlist_refs = [
          "artifacts/discovery/opportunities/opportunity_household.r1.json",
        ];
        refresh(bundle, G24_PORTFOLIO);
      },
    },
    {
      code: "g2_4.traceability_freshness_mismatch",
      mutate(bundle) {
        const freshness = effective(bundle, G24_TRACEABILITY).freshness_summary as Record<
          string,
          unknown
        >;
        freshness.current_refs = [G24_EVIDENCE_SUPPORT];
        refresh(bundle, G24_TRACEABILITY);
      },
    },
    {
      code: "g2_4.report_closure_mismatch",
      mutate(bundle) {
        effective(bundle, G24_REPORT).watchlist_refs = [
          "artifacts/discovery/opportunities/opportunity_household.r1.json",
        ];
        refresh(bundle, G24_REPORT);
      },
    },
  ];

  for (const mutation of mutations) {
    const bundle = clone(state.bundle);
    mutation.mutate(bundle);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false, mutation.code);
    assert.ok(
      result.referenceErrors.some((error) => error.code === mutation.code),
      `${mutation.code}: ${JSON.stringify(result.referenceErrors, null, 2)}`,
    );
  }
});

test("G2.4 Store rejects an enrichment task that is absent from the current Plan", async (context) => {
  const state = await setup(context, "unplanned-task");
  await publishThroughSynthesis(state);
  const wave = discoveryWaveEnvelopes(
    state.bundle,
    state.runId,
    "startup_opportunity.research_task.discovery_evaluation.current",
    3,
    "enrichment_runtime",
  );
  const task = wave.find((envelope) => envelope.artifact_path === G24_TASK_SUPPORT);
  const dispatch = wave.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current",
  );
  assert.ok(task);
  assert.ok(dispatch);
  task.document.unit_id = "unit_unplanned_enrichment";
  (task as { content_hash: string }).content_hash = canonicalContentHash(task.document);
  const dispatchTask = (dispatch.document.tasks as Record<string, unknown>[]).find(
    (candidate) => candidate.task_id === task.document.task_id,
  );
  assert.ok(dispatchTask);
  dispatchTask.unit_id = "unit_unplanned_enrichment";
  (dispatch as { content_hash: string }).content_hash = canonicalContentHash(dispatch.document);

  await assert.rejects(
    state.store.publishArtifactBundle({ runId: state.runId, envelopes: wave }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.task_plan_unit_mismatch",
  );
});

test("G2.4 rejects a discovery brief that drifts from its structured report", async (context) => {
  const state = await setup(context, "derived-negative");
  const bundle = clone(state.bundle);
  const derived = deriveReportEnvelopes(evaluationEnvelope(bundle, G24_REPORT));
  (bundle.documents as { path: string; document: Record<string, unknown> }[]).push(
    ...derived.map((candidate) => ({
      path: candidate.artifact_path,
      document: candidate as unknown as Record<string, unknown>,
    })),
  );
  const briefPath = "artifacts/reporting/decision-brief.r1.json";
  effective(bundle, briefPath).decision_tier = "prioritize";
  refresh(bundle, briefPath);
  const result = state.validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, false);
  assert.ok(
    result.referenceErrors.some((error) => error.code === "g2_4.report_consistency_mismatch"),
    JSON.stringify(result.referenceErrors, null, 2),
  );
});

test("G2.4 forbidden report claims fail closed before publication and remain absent after reopen", async (context) => {
  const state = await setup(context, "forbidden-report");
  await publishThroughEvaluation(state);
  const report = clone(evaluationEnvelope(state.bundle, G24_REPORT));
  const phrase = "Market validation succeeded with a 95% success probability and global score.";
  const judgmentContext = report.document.curated_judgment_context as Record<string, unknown>;
  judgmentContext.current_recommendation = phrase;
  const sections = report.document.report_sections as Record<string, unknown>;
  sections.conclusion_summary = [phrase];
  (report as { content_hash: string }).content_hash = canonicalContentHash(report.document);

  const derived = deriveReportEnvelopes(report);
  const consistency = derived.find(
    (candidate) =>
      candidate.artifact_type ===
      "startup_opportunity.report_consistency_evaluation.discovery.current",
  );
  assert.ok(consistency);
  assert.equal(consistency.document.evaluator_result, "failed");
  const matches = consistency.document.forbidden_expression_matches as string[];
  for (const surface of ["structured_report", "decision_brief", "report_view"]) {
    assert.ok(
      matches.some((match) => match.includes(`@${surface}:`)),
      surface,
    );
  }

  await assert.rejects(
    new ReportRuntime(state.runsRoot, state.validator).build({ reportEnvelope: report }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "report.forbidden_expression_detected",
  );
  await assert.rejects(
    state.store.publishArtifact({ runId: state.runId, envelope: report }),
    (error: unknown) => error instanceof StoreError && error.code === "artifact.schema_invalid",
  );
  const checkpoint = await state.store.checkpoint({
    runId: state.runId,
    checkpointId: "checkpoint_forbidden_report_rejected",
    createdAt: "2026-07-27T22:01:00Z",
    nextStep: "SYNTHETIC publish only a report revision without forbidden claims.",
    beliefSummary: {
      current_belief: "SYNTHETIC forbidden report claims remain unpublished.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["SYNTHETIC no market validation is claimed."],
      remaining_disagreement: ["SYNTHETIC market truth remains unknown."],
      next_decision_relevant_question: "SYNTHETIC should a clean report revision be supplied?",
    },
    inputRefs: [G24_RECOMMENDATION, G24_TRACEABILITY],
  });
  assert.match(checkpoint.checkpointRef, /checkpoint-forbidden-report-rejected/);
  const reopened = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.ok(!reopened.manifest.artifact_refs.includes(G24_REPORT));
  await assert.rejects(
    readFile(path.join(state.runRoot, G24_REPORT), "utf8"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
});

test("G2.4 publishes evaluation artifacts, materializes the discovery report, and replays exactly", async (context) => {
  const state = await setup(context, "publication", "general", "zh-CN");
  const firstBet = G23_OPPORTUNITY_A;
  const watchlist = G23_OPPORTUNITY_B;
  const portfolio = effective(state.bundle, G24_PORTFOLIO);
  portfolio.recommended_first_bet = firstBet;
  portfolio.alternative_bets = [];
  portfolio.watchlist_refs = [watchlist];
  portfolio.rejected_refs = [];
  const ranking = portfolio.opportunity_ranking as Record<string, unknown>[];
  for (const entry of ranking) {
    entry.rank = entry.opportunity_ref === firstBet ? 1 : null;
  }
  const recommendation = effective(state.bundle, G24_RECOMMENDATION);
  recommendation.recommended_first_bet = firstBet;
  recommendation.alternative_bets = [];
  recommendation.rejected_or_watchlist_refs = [watchlist];
  const reportSource = effective(state.bundle, G24_REPORT);
  delete reportSource.team_decision_summary;
  delete reportSource.research_language;
  reportSource.top_opportunity_refs = [firstBet];
  reportSource.watchlist_refs = [watchlist];
  reportSource.rejected_opportunity_refs = [];
  const judgmentContext = reportSource.curated_judgment_context as Record<string, unknown>;
  judgmentContext.recommended_first_bet = firstBet;
  judgmentContext.alternative_bets = [];
  installStateRichOpportunityFamily(state.bundle);
  refreshAllInputHashes(state.bundle);
  refreshEnvelopeClosure(state.bundle, G24_REPORT);
  refreshEnvelopeClosure(state.bundle, G24_PORTFOLIO);
  refreshEnvelopeClosure(state.bundle, G24_RECOMMENDATION);
  await publishThroughEvaluation(state);
  const runtime = new ReportRuntime(state.runsRoot, state.validator);
  const report = evaluationEnvelope(state.bundle, G24_REPORT);
  const omittedAuditRefs = new Set(report.document.commercial_research_audit_refs as string[]);
  report.document.commercial_research_audit_refs = [];
  report.document.quantitative_signal_rows = [];
  report.document.competitive_substitute_rows = [];
  report.document.incumbent_response_risk_rows = [];
  report.document.research_coverage_gaps = [];
  report.document.gate_warnings = [];
  (report as unknown as { input_refs: string[] }).input_refs = report.input_refs.filter(
    (ref) => !omittedAuditRefs.has(ref),
  );
  const reportMetadata = report.document.report_metadata as Record<string, unknown>;
  reportMetadata.input_artifact_hashes = (
    reportMetadata.input_artifact_hashes as Record<string, unknown>[]
  ).filter((binding) => !omittedAuditRefs.has(String(binding.ref)));
  (report as { content_hash: string }).content_hash = canonicalContentHash(report.document);
  const first = await runtime.build({ reportEnvelope: report });
  assert.equal(first.status, "published");
  assert.deepEqual(first.formalArtifactPaths, [
    G24_REPORT,
    "artifacts/reporting/decision-brief.r1.json",
    "artifacts/reporting/report-markdown.r1.json",
    "artifacts/reporting/consistency-evaluation.r1.json",
  ]);
  assert.deepEqual(first.materializedPaths, [
    "report.json",
    "decision-brief.md",
    "report.md",
    "audit-appendix.md",
  ]);
  const projectedReport = JSON.parse(
    await readFile(path.join(state.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  const projectedFamilies = projectedReport.opportunity_family_projection as Record<
    string,
    unknown
  >;
  assert.equal(projectedFamilies.independent_opportunity_family_count, 1);
  assert.equal(projectedFamilies.concrete_direction_count, 2);
  const projectedFamily = (projectedFamilies.families as Record<string, unknown>[])[0] as Record<
    string,
    unknown
  >;
  assert.equal(
    (projectedFamily.shared_value_or_solution_mechanism as Record<string, unknown>).state,
    "unknown",
  );
  assert.deepEqual(
    (projectedFamily.member_specific_differences as Record<string, unknown>[])
      .flatMap((difference) =>
        (difference.dimensions as Record<string, unknown>[]).map((dimension) => dimension.state),
      )
      .sort(),
    ["inferred", "no_evidence_found", "not_applicable", "unavailable"].sort(),
  );
  const watchProjectionDocument = structuredClone(projectedReport);
  delete watchProjectionDocument.materialized_path;
  (watchProjectionDocument.curated_judgment_context as Record<string, unknown>).decision_tier =
    "watch";
  const watchProjection = deriveReportEnvelopes({
    ...report,
    document: watchProjectionDocument,
    content_hash: canonicalContentHash(watchProjectionDocument),
  });
  const watchBrief = String(
    watchProjection.find(
      (entry) => entry.artifact_type === "startup_opportunity.decision_brief.discovery.current",
    )?.document.markdown,
  );
  const watchCore = String(
    watchProjection.find(
      (entry) => entry.artifact_type === "startup_opportunity.discovery_report_view.v1",
    )?.document.markdown,
  );
  for (const surface of [watchBrief, watchCore]) {
    assert.match(surface, /决策层级: 持续观察/);
    assert.doesNotMatch(surface, /\bwatch\b/u);
  }
  const firstBetId = String(effective(state.bundle, firstBet).opportunity_id);
  const watchlistId = String(effective(state.bundle, watchlist).opportunity_id);
  const firstBetTitle = String(effective(state.bundle, firstBet).title);
  const watchlistTitle = String(effective(state.bundle, watchlist).title);
  assert.equal(projectedReport.research_language, "zh-CN");
  assert.deepEqual(
    (
      (projectedReport.team_decision_summary as Record<string, unknown>)
        .opportunity_labels as Record<string, unknown>[]
    ).map((entry) => ({ opportunity_ref: entry.opportunity_ref, label: entry.label })),
    [
      { opportunity_ref: firstBet, label: firstBetTitle },
      { opportunity_ref: watchlist, label: watchlistTitle },
    ],
  );
  assert.deepEqual(
    (projectedReport.report_subject_labels as Record<string, unknown>[]).map(
      (entry) => entry.subject_id,
    ),
    [firstBetId],
  );
  assert.deepEqual(
    (projectedReport.report_subject_labels as Record<string, unknown>[]).map((entry) => ({
      subject_ref: entry.subject_ref,
      subject_content_hash: entry.subject_content_hash,
    })),
    [
      {
        subject_ref: firstBet,
        subject_content_hash: canonicalContentHash(effective(state.bundle, firstBet)),
      },
    ],
  );
  assert.ok(
    !(projectedReport.report_subject_labels as Record<string, unknown>[]).some(
      (entry) => entry.subject_id === watchlistId || entry.subject_ref === watchlist,
    ),
  );
  assert.deepEqual(
    (projectedReport.commercial_subject_aggregates as Record<string, unknown>[]).map(
      (entry) => entry.subject_id,
    ),
    [firstBetId],
  );
  const fullSubjectIds = (
    (projectedReport.full_commercial_projection as Record<string, unknown>)
      .commercial_subject_aggregates as Record<string, unknown>[]
  )
    .map((entry) => String(entry.subject_id))
    .sort();
  assert.ok(fullSubjectIds.includes(firstBetId));
  assert.ok(fullSubjectIds.includes(watchlistId));
  assert.ok(fullSubjectIds.length > 2);
  const evidenceDispositions = projectedReport.report_evidence_dispositions as Record<
    string,
    unknown
  >[];
  assert.deepEqual(
    evidenceDispositions.map((entry) => entry.evidence_ref).sort(),
    [G24_EVIDENCE_CHALLENGE, G24_EVIDENCE_SUPPORT].sort(),
  );
  assert.ok(
    evidenceDispositions.every(
      (entry) =>
        String(entry.evidence_content_hash).startsWith("sha256:") &&
        (entry.authority_bindings as Record<string, unknown>[]).every((binding) =>
          String(binding.content_hash).startsWith("sha256:"),
        ),
    ),
  );
  const sourceDispositions = projectedReport.report_source_dispositions as Record<
    string,
    unknown
  >[];
  assert.equal(sourceDispositions.length, 2);
  assert.ok(
    sourceDispositions.every((entry) =>
      (entry.authority_bindings as Record<string, unknown>[]).every((binding) =>
        String(binding.content_hash).startsWith("sha256:"),
      ),
    ),
  );
  assert.ok((projectedReport.commercial_research_audit_refs as unknown[]).length > 0);
  const projectedResponseRows = projectedReport.incumbent_response_risk_rows as Record<
    string,
    unknown
  >[];
  assert.ok(projectedResponseRows.length > 0);
  assert.ok(
    projectedResponseRows.every((row) => {
      const assessment = row.assessment as Record<string, unknown>;
      const semantic = assessment.semantic as Record<string, unknown>;
      return (
        typeof assessment.assessment_id === "string" &&
        ["lightweight_scan", "targeted_deep_dive"].includes(String(assessment.analysis_depth)) &&
        semantic.strategic_implication === INCUMBENT_RESPONSE_STRATEGIC_CONTEXT
      );
    }),
  );
  assert.ok((projectedReport.research_coverage_gaps as unknown[]).length > 0);
  const projectedMetadata = projectedReport.report_metadata as Record<string, unknown>;
  assert.deepEqual(
    (projectedMetadata.input_artifact_hashes as Record<string, unknown>[])
      .map((binding) => String(binding.ref))
      .filter((ref) => omittedAuditRefs.has(ref))
      .sort(),
    [...omittedAuditRefs].sort(),
  );
  const replay = await runtime.build({ reportEnvelope: report });
  assert.equal(replay.status, "idempotent_replay");
  const replayedReport = JSON.parse(
    await readFile(path.join(state.runRoot, "report.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(replayedReport.incumbent_response_risk_rows, projectedResponseRows);
  const loaded = await state.store.load(state.runId);
  assert.ok(loaded.manifest.artifact_refs.includes(G24_REPORT));
  assert.ok(loaded.manifest.artifact_refs.includes(first.consistencyEvaluationRef));
  const briefSidecar = JSON.parse(
    await readFile(path.join(state.runRoot, "artifacts/reporting/decision-brief.r1.json"), "utf8"),
  ) as FormalArtifactEnvelope;
  const reportSidecar = JSON.parse(
    await readFile(path.join(state.runRoot, "artifacts/reporting/report-markdown.r1.json"), "utf8"),
  ) as FormalArtifactEnvelope;
  assert.deepEqual(
    briefSidecar.document.opportunity_family_projection,
    projectedReport.opportunity_family_projection,
  );
  assert.deepEqual(
    reportSidecar.document.opportunity_family_projection,
    projectedReport.opportunity_family_projection,
  );
  const decisionBrief = await readFile(path.join(state.runRoot, "decision-brief.md"), "utf8");
  assert.match(decisionBrief, /局部排序/);
  assert.match(decisionBrief, /1 个可区分的机会家族、2 个具体方向/);
  assert.match(
    decisionBrief,
    /共享机制状态：未知；说明：SYNTHETIC shared mechanism remains unresolved/,
  );
  assert.match(
    decisionBrief,
    /用户（状态：来源不可用；说明：SYNTHETIC user difference unavailable/,
  );
  assert.match(decisionBrief, /买方（状态：推断；说明：SYNTHETIC buyer difference inferred/);
  assert.match(
    decisionBrief,
    /获客（状态：不适用；说明：SYNTHETIC acquisition difference not applicable/,
  );
  assert.match(decisionBrief, /合规（状态：未发现证据；说明：SYNTHETIC no 证据 found/);
  assert.match(decisionBrief, /当前团队条件/);
  assert.match(decisionBrief, /机会自身启动负担与当前团队匹配/);
  assert.match(decisionBrief, /当前团队匹配结论/);
  assert.match(decisionBrief, /主 Agent 明确提交的机会排序/);
  assert.match(decisionBrief, new RegExp(`第1位: ${firstBetTitle}`, "u"));
  assert.match(decisionBrief, new RegExp(`未排序: ${watchlistTitle}`, "u"));
  assert.match(decisionBrief, new RegExp(`机会: ${firstBetTitle} - 机会自身启动负担`, "u"));
  assert.match(decisionBrief, new RegExp(`机会: ${watchlistTitle} - 机会自身启动负担`, "u"));
  assert.match(decisionBrief, /头部公司吸收与响应风险/);
  assert.ok(decisionBrief.includes(INCUMBENT_RESPONSE_STRATEGIC_CONTEXT_ZH));
  const reportMarkdown = await readFile(path.join(state.runRoot, "report.md"), "utf8");
  assert.match(reportMarkdown, /方向组合/);
  assert.match(reportMarkdown, /1 个可区分的机会家族、2 个具体方向/);
  assert.match(
    reportMarkdown,
    /共享机制状态：未知；说明：SYNTHETIC shared mechanism remains unresolved/,
  );
  assert.match(reportMarkdown, /交付或实施变体/);
  assert.match(
    reportMarkdown,
    /用户（状态：来源不可用；说明：SYNTHETIC user difference unavailable/,
  );
  assert.match(reportMarkdown, /买方（状态：推断；说明：SYNTHETIC buyer difference inferred/);
  assert.match(
    reportMarkdown,
    /获客（状态：不适用；说明：SYNTHETIC acquisition difference not applicable/,
  );
  assert.match(reportMarkdown, /合规（状态：未发现证据；说明：SYNTHETIC no 证据 found/);
  assert.match(reportMarkdown, /当前团队条件/);
  assert.match(reportMarkdown, /机会自身启动负担与当前团队匹配/);
  assert.match(reportMarkdown, new RegExp(`第1位: ${firstBetTitle}`, "u"));
  assert.match(reportMarkdown, new RegExp(`未排序: ${watchlistTitle}`, "u"));
  assert.match(reportMarkdown, /头部公司吸收与响应风险/);
  assert.ok(reportMarkdown.includes(INCUMBENT_RESPONSE_STRATEGIC_CONTEXT_ZH));
  const auditAppendix = await readFile(path.join(state.runRoot, "audit-appendix.md"), "utf8");
  assert.match(auditAppendix, /全部量化信号/);
  assert.match(auditAppendix, /完整竞品与广义替代矩阵/);
  assert.match(auditAppendix, /完整研究覆盖缺口/);
  assert.match(auditAppendix, /材料采用、限制与排除/);
  assert.match(auditAppendix, /用户提供\/非公开/);
  assert.match(auditAppendix, /Synthetic unavailable support source/);
  assert.match(auditAppendix, /Synthetic unavailable challenge source/);
  assert.equal(
    auditAppendix.match(/The bounded research route could not access this source\./gu)?.length,
    1,
  );
  assert.equal(
    auditAppendix.match(
      /Synthetic unavailable (?:support|challenge) source（用户提供\/非公开） - SYNTHETIC G2\.4 contract fixture only; no real 证据 or validation\./gu,
    )?.length,
    2,
  );
  for (const surface of [decisionBrief, reportMarkdown, auditAppendix]) {
    assert.doesNotMatch(surface, /decision_tier|insufficient_evidence|artifacts\//u);
  }
  const receipts = await Promise.all(
    (await readdir(path.join(state.runRoot, ".store/operations")))
      .filter((filename) => filename.startsWith("artifact-"))
      .map(async (filename) =>
        JSON.parse(await readFile(path.join(state.runRoot, ".store/operations", filename), "utf8")),
      ),
  );
  const v13Paths = new Set(
    envelopes(state.bundle, "startup_opportunity.artifact_envelope.current").map(
      (candidate) => candidate.artifact_path,
    ),
  );
  assert.ok(
    receipts
      .filter((receipt) => v13Paths.has(String((receipt as Record<string, unknown>).artifact_path)))
      .every(
        (receipt) =>
          (receipt as Record<string, unknown>).schema_version ===
          "startup_opportunity.artifact_store_operation.current",
      ),
  );
});

test("G2.4 checkpoint, reopen, and report fault recovery preserve the validated current index", async (context) => {
  const state = await setup(context, "recovery");
  await publishThroughEvaluation(state);
  const runtime = new ReportRuntime(state.runsRoot, state.validator);
  await assert.rejects(
    runtime.build({
      reportEnvelope: evaluationEnvelope(state.bundle, G24_REPORT),
      faultAt: "after_view_materialization",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const recovered = await state.store.load(state.runId);
  assert.ok(
    recovered.reportRecovery.recoveredFormalArtifactPaths.includes(
      "artifacts/reporting/consistency-evaluation.r1.json",
    ),
  );
  assert.ok(recovered.manifest.artifact_refs.includes(G24_REPORT));
  assert.ok(
    recovered.manifest.artifact_refs.includes("artifacts/reporting/consistency-evaluation.r1.json"),
  );
  const checkpoint = await state.store.checkpoint({
    runId: state.runId,
    checkpointId: "checkpoint_g2_4_evaluation",
    createdAt: "2026-07-27T22:00:00Z",
    nextStep: "SYNTHETIC preserve G2 exit candidate state for independent regression.",
    beliefSummary: {
      current_belief: "SYNTHETIC contract mechanics only.",
      evidence_that_changed_belief: [],
      unchanged_assumptions: ["SYNTHETIC no market validation is claimed."],
      remaining_disagreement: ["SYNTHETIC all market truth remains unknown."],
      next_decision_relevant_question: "SYNTHETIC should the user commission more Evidence?",
    },
    inputRefs: [G24_RECOMMENDATION, G24_TRACEABILITY, G24_REPORT],
  });
  assert.match(checkpoint.checkpointRef, /checkpoint-g2-4-evaluation/);
  const reopened = await new RunStore(state.runsRoot, state.validator).load(state.runId);
  assert.equal(reopened.recovered, false);
  assert.ok(reopened.manifest.artifact_refs.includes(G24_COMPARISON_A));
  assert.ok(reopened.manifest.artifact_refs.includes(G24_PORTFOLIO));
});

test("G2.4 current receipt recovery completes an interrupted fan-in publication", async (context) => {
  const state = await setup(context, "artifact-fault");
  await publishThroughEnrichmentBranches(state);
  await assert.rejects(
    state.store.publishArtifact({
      runId: state.runId,
      envelope: evaluationEnvelope(state.bundle, G24_FAN_IN),
      faultAt: "after_temp_write",
    }),
    (error: unknown) => error instanceof StoreError && error.code === "fault.injected",
  );
  const recovered = await state.store.load(state.runId);
  assert.ok(recovered.recoveredArtifactPaths.includes(G24_FAN_IN));
  assert.ok(recovered.manifest.artifact_refs.includes(G24_FAN_IN));
  assert.equal((await state.store.load(state.runId)).recovered, false);
});

test("G2.4 branch terminal states project mechanically and keep late or superseded results non-current", async (t) => {
  for (const scenario of [
    { suffix: "partial", status: "partial", target: "completed_units", prestate: null },
    { suffix: "failed", status: "failed", target: "failed_units", prestate: null },
    {
      suffix: "ignored",
      status: "ignored_late",
      target: "ignored_late_artifact_refs",
      prestate: "invalidated_units",
    },
    {
      suffix: "superseded",
      status: "superseded",
      target: "ignored_late_artifact_refs",
      prestate: "superseded_units",
    },
  ] as const) {
    await t.test(scenario.suffix, async (context) => {
      const state = await setup(context, `status-${scenario.suffix}`);
      await publishThroughSynthesis(state);
      const evaluation = envelopes(state.bundle, "startup_opportunity.artifact_envelope.current");
      await state.store.publishArtifactBundle({
        runId: state.runId,
        envelopes: discoveryWaveEnvelopes(
          state.bundle,
          state.runId,
          "startup_opportunity.research_task.discovery_evaluation.current",
          3,
          "enrichment_runtime",
        ),
      });
      await state.store.publishArtifactBundle({
        runId: state.runId,
        envelopes: byTypes(
          evaluation,
          "startup_opportunity.evidence.discovery_evaluation.current",
          "startup_opportunity.claim.discovery_evaluation.current",
          "startup_opportunity.finding.discovery_evaluation.current",
          "startup_opportunity.insight.discovery_evaluation.current",
          "startup_opportunity.judgment_assessment.discovery_evaluation.current",
          "startup_opportunity.source_manifest.discovery_evaluation.current",
        ),
      });
      if (scenario.prestate !== null) {
        await rewriteUnitState(state, "unit_enrichment_support", scenario.prestate);
        await state.store.checkpoint({
          runId: state.runId,
          checkpointId: `checkpoint_${scenario.suffix}_state`,
          createdAt: "2026-07-27T21:29:00Z",
          nextStep: "SYNTHETIC publish only an explicit terminal enrichment result.",
          beliefSummary: {
            current_belief: "SYNTHETIC unit state is mechanical only.",
            evidence_that_changed_belief: [],
            unchanged_assumptions: ["SYNTHETIC no validation success is claimed."],
            remaining_disagreement: ["SYNTHETIC market truth remains unknown."],
            next_decision_relevant_question: "SYNTHETIC should the late result remain non-current?",
          },
          inputRefs: [],
        });
      }
      const branch = terminalBranch(state, G24_BRANCH_SUPPORT, scenario.status);
      await state.store.publishArtifact({ runId: state.runId, envelope: branch });
      const manifest = (await state.store.load(state.runId)).manifest;
      const expected =
        scenario.target === "ignored_late_artifact_refs"
          ? G24_BRANCH_SUPPORT
          : "unit_enrichment_support";
      assert.ok((manifest[scenario.target] as readonly string[]).includes(expected));
      if (scenario.target === "ignored_late_artifact_refs") {
        assert.ok(!manifest.artifact_refs.includes(G24_BRANCH_SUPPORT));
      }
    });
  }
});

test("G2.4 audit-traceability and build-report CLI consume explicit current artifacts", async (context) => {
  const state = await setup(context, "cli");
  const auditBundle = clone(state.bundle);
  const derived = deriveReportEnvelopes(evaluationEnvelope(auditBundle, G24_REPORT));
  (auditBundle.documents as { path: string; document: Record<string, unknown> }[]).push(
    ...derived.map((candidate) => ({
      path: candidate.artifact_path,
      document: candidate as unknown as Record<string, unknown>,
    })),
  );
  const auditPath = path.join(state.root, "discovery-report-bundle.json");
  await writeFile(auditPath, `${canonicalJson(auditBundle)}\n`);
  const audited = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "audit-traceability",
      "--bundle",
      auditPath,
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(audited.status, 0, audited.stderr || audited.stdout);
  const auditResult = JSON.parse(audited.stdout) as Record<string, unknown>;
  assert.equal(auditResult.valid, true);
  assert.equal(auditResult.reportSetEvaluated, true);

  const compared = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "calculate-comparison",
      "--bundle",
      auditPath,
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(compared.status, 0, compared.stderr || compared.stdout);
  const comparisonResult = JSON.parse(compared.stdout) as {
    status?: string;
    comparisons?: readonly unknown[];
  };
  assert.equal(comparisonResult.status, "validated");
  assert.equal(comparisonResult.comparisons?.length, 2);

  const sensitivity = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      ".agents/skills/startup-opportunity/scripts/calculate-sensitivity.ts",
      "--bundle",
      auditPath,
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(sensitivity.status, 0, sensitivity.stderr || sensitivity.stdout);
  const sensitivityResult = JSON.parse(sensitivity.stdout) as Record<string, unknown>;
  assert.equal(sensitivityResult.status, "validated");
  assert.equal(sensitivityResult.artifactPath, G24_SENSITIVITY);

  await publishThroughEvaluation(state);
  const reportPath = path.join(state.root, "discovery-report-envelope.json");
  await writeFile(reportPath, `${canonicalJson(evaluationEnvelope(state.bundle, G24_REPORT))}\n`);
  const built = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "build-report",
      "--file",
      reportPath,
      "--runs-root",
      state.runsRoot,
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const buildResult = JSON.parse(built.stdout) as Record<string, unknown>;
  assert.equal(buildResult.status, "published");
  assert.deepEqual(buildResult.materializedPaths, [
    "report.json",
    "decision-brief.md",
    "report.md",
    "audit-appendix.md",
  ]);
});

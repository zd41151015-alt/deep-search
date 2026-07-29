import {
  canonicalContentHash,
  type DocumentBundle,
  type EvidenceStoreRecordV2,
  type FormalArtifactEnvelope,
} from "../../../harness/src/index.js";
import { G23_OPPORTUNITY_A, G23_SOLUTION } from "../g2.3/discovery-synthesis-fixture.js";
import {
  createDiscoveryEvaluationFixture,
  G24_EVIDENCE_SUPPORT,
  G24_JUDGMENT_A_SUPPORT,
} from "../g2.4/discovery-evaluation-fixture.js";

export const G31_BENCHMARK = "artifacts/ai/benchmark-household.r1.json";
export const G31_RELIABILITY = "artifacts/ai/reliability-household.r1.json";
export const G31_DATA = "artifacts/ai/data-dependency-household.r1.json";
export const G31_CAPABILITY = "artifacts/ai/capability-household.r1.json";

export interface G3FixtureSubstrate {
  readonly generation: EvidenceStoreRecordV2;
  readonly evaluation: EvidenceStoreRecordV2;
  readonly support: EvidenceStoreRecordV2;
  readonly challenge: EvidenceStoreRecordV2;
}

const SYNTHETIC =
  "SYNTHETIC and unverified G3 fixture; deterministic mechanics only, not real Evidence, external validation, product viability, or market success.";

function collectRefs(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectRefs);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    if ((key.endsWith("_refs") || key === "artifact_refs") && Array.isArray(child)) {
      return child.filter(
        (ref): ref is string => typeof ref === "string" && (ref.includes("/") || ref.includes("#")),
      );
    }
    if (
      (key.endsWith("_ref") || key === "ref") &&
      typeof child === "string" &&
      (child.includes("/") || child.includes("#"))
    ) {
      return [child];
    }
    return collectRefs(child);
  });
}

function envelope(
  runId: string,
  artifactPath: string,
  document: Record<string, unknown>,
  createdAt: string,
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.v14",
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    run_id: runId,
    created_at: createdAt,
    producer_role: "lane_researcher",
    input_refs: [...new Set(collectRefs(document))].filter((ref) => ref !== artifactPath).sort(),
    content_hash: canonicalContentHash(document),
    document,
  } as FormalArtifactEnvelope;
}

function lineage(): Record<string, unknown> {
  return {
    subject_ref: G23_OPPORTUNITY_A,
    opportunity_ref: G23_OPPORTUNITY_A,
    selected_solution_ref: G23_SOLUTION,
    trigger_version: "startup_opportunity.ai_mandatory_coverage_trigger.v1",
  };
}

function freshness(): Record<string, unknown> {
  return {
    valid_as_of: "2026-07-29T00:00:00Z",
    expires_at: "2026-08-29T00:00:00Z",
    status: "current",
  };
}

function sourceBoundary(): Record<string, unknown> {
  return {
    caller_supplied_artifact: true,
    harness_generated_research: false,
    harness_generated_judgment: false,
    hidden_llm_calls: false,
    agent_dispatch: false,
    network_access: false,
    external_validation_claimed: false,
  };
}

function benchmarkResult(baselineType: string): Record<string, unknown> {
  return {
    baseline_type: baselineType,
    approach_summary: SYNTHETIC,
    quality_boundary: SYNTHETIC,
    latency_boundary: SYNTHETIC,
    cost_boundary: SYNTHETIC,
    failure_modes: [SYNTHETIC],
    evidence_refs: [G24_EVIDENCE_SUPPORT],
    judgment_assessment_refs: [G24_JUDGMENT_A_SUPPORT],
  };
}

export async function createG3AiBundleFixture(
  runId: string,
  substrate: G3FixtureSubstrate,
): Promise<DocumentBundle> {
  const bundle = await createDiscoveryEvaluationFixture(runId, substrate, "ai_first");
  (bundle as { schema_version: string }).schema_version = "startup_opportunity.document_bundle.v14";
  const manifest = bundle.documents.find((entry) => entry.path === "manifest.json");
  if (manifest !== undefined) {
    manifest.document.schema_bundle_version = "13.0.0";
  }

  const benchmark = {
    schema_version: "startup_opportunity.ai_capability_benchmark.v1",
    benchmark_id: "benchmark_household",
    run_id: runId,
    lineage: lineage(),
    research_mode: "representative_evaluation",
    evaluation_design: {
      target_tasks: [SYNTHETIC],
      quality_measures: [SYNTHETIC],
      latency_measure: SYNTHETIC,
      cost_measure: SYNTHETIC,
    },
    baseline_results: [
      benchmarkResult("generic_model"),
      benchmarkResult("platform_native"),
      benchmarkResult("open_source"),
    ],
    product_candidate_result: {
      result_type: "product_candidate",
      incremental_value_status: "unknown",
      approach_summary: SYNTHETIC,
      quality_boundary: SYNTHETIC,
      latency_boundary: SYNTHETIC,
      cost_boundary: SYNTHETIC,
      failure_modes: [SYNTHETIC],
      evidence_refs: [G24_EVIDENCE_SUPPORT],
      judgment_assessment_refs: [G24_JUDGMENT_A_SUPPORT],
    },
    representativeness: {
      status: "not_established",
      covered_user_states: [SYNTHETIC],
      known_gaps: [SYNTHETIC],
    },
    freshness: freshness(),
    source_boundary: sourceBoundary(),
    limitations: [SYNTHETIC],
  };
  const reliability = {
    schema_version: "startup_opportunity.ai_evaluation_reliability.v1",
    reliability_id: "reliability_household",
    run_id: runId,
    lineage: lineage(),
    benchmark_ref: G31_BENCHMARK,
    research_mode: "representative_evaluation",
    technical_reliability: {
      status: "unknown",
      quality_boundary: SYNTHETIC,
      latency_boundary: SYNTHETIC,
      error_cost: "high",
      evaluation_feasibility: "unknown",
      judgment_assessment_refs: [G24_JUDGMENT_A_SUPPORT],
    },
    failure_modes: [
      {
        failure_id: "failure_synthetic",
        category: "incorrect_output",
        severity: "high",
        detectability: "unknown",
        recovery: "human_review",
        evidence_refs: [G24_EVIDENCE_SUPPORT],
      },
    ],
    human_boundary: {
      mode: "human_in_the_loop",
      mandatory_review_steps: [SYNTHETIC],
      escalation_conditions: [SYNTHETIC],
      fallback_workflow: SYNTHETIC,
      accountability_owner: SYNTHETIC,
    },
    monitoring_boundary: {
      online_signals: [SYNTHETIC],
      rollback_signal: SYNTHETIC,
      unmonitored_failures: [SYNTHETIC],
    },
    freshness: freshness(),
    source_boundary: sourceBoundary(),
    limitations: [SYNTHETIC],
  };
  const dataDependency = {
    schema_version: "startup_opportunity.ai_data_dependency.v1",
    data_dependency_id: "data_household",
    run_id: runId,
    lineage: lineage(),
    research_mode: "representative_evaluation",
    data_requirements: [
      {
        data_kind: SYNTHETIC,
        purpose: SYNTHETIC,
        rights_basis: "unknown",
        availability: "unknown",
        retention_boundary: SYNTHETIC,
        evidence_refs: [G24_EVIDENCE_SUPPORT],
      },
    ],
    ground_truth: {
      status: "unknown",
      source: SYNTHETIC,
      collection_boundary: SYNTHETIC,
      judgment_assessment_refs: [G24_JUDGMENT_A_SUPPORT],
    },
    feedback_loop: {
      status: "unknown",
      signal: SYNTHETIC,
      frequency: SYNTHETIC,
      moat_status: "unknown",
    },
    provider_portability: {
      status: "unknown",
      export_format: SYNTHETIC,
      switching_boundary: SYNTHETIC,
    },
    privacy_boundary: {
      risk_level: "unknown",
      permission_model: SYNTHETIC,
      deletion_status: "unknown",
      export_status: "unknown",
      regulated_data: false,
      accountability_owner: SYNTHETIC,
    },
    freshness: freshness(),
    source_boundary: sourceBoundary(),
    limitations: [SYNTHETIC],
  };
  const dimensions = [
    ["capability_frontier", G31_BENCHMARK],
    ["cost_and_deployment", G31_BENCHMARK],
    ["workflow_and_human_boundary", G31_RELIABILITY],
    ["ecosystem_and_platform", G31_BENCHMARK],
    ["data_and_evaluation", G31_DATA],
    ["adoption_and_trust", G31_DATA],
  ] as const;
  const capability = {
    schema_version: "startup_opportunity.capability_evidence.v1",
    capability_evidence_id: "capability_household",
    run_id: runId,
    unit_id: "unit_ai_capability_household",
    lineage: lineage(),
    research_mode: "representative_evaluation",
    required_dimensions: dimensions.map(([dimension]) => dimension),
    dimension_results: dimensions.map(([dimension, ref]) => ({
      dimension,
      coverage_status: "covered",
      artifact_refs: [ref],
      judgment_assessment_refs: [G24_JUDGMENT_A_SUPPORT],
      limitations: [SYNTHETIC],
      not_applicable_reason: null,
      source_unavailable: false,
    })),
    benchmark_ref: G31_BENCHMARK,
    reliability_ref: G31_RELIABILITY,
    data_dependency_ref: G31_DATA,
    newly_feasible_tasks: [SYNTHETIC],
    failure_modes: [SYNTHETIC],
    human_in_the_loop_boundary: SYNTHETIC,
    freshness: freshness(),
    source_boundary: sourceBoundary(),
    limitations: [SYNTHETIC],
  };

  const documents = [
    [G31_BENCHMARK, benchmark],
    [G31_RELIABILITY, reliability],
    [G31_DATA, dataDependency],
    [G31_CAPABILITY, capability],
  ] as const;
  (bundle.documents as { path: string; document: Record<string, unknown> }[]).push(
    ...documents.map(([path, document], index) => ({
      path,
      document: envelope(
        runId,
        path,
        document,
        new Date(Date.parse("2026-07-29T01:00:00Z") + index * 1000).toISOString(),
      ) as unknown as Record<string, unknown>,
    })),
  );
  return bundle;
}

export function g3Envelope(bundle: DocumentBundle, path: string): FormalArtifactEnvelope {
  const entry = bundle.documents.find((candidate) => candidate.path === path);
  if (entry === undefined) {
    throw new Error(`missing G3 fixture artifact: ${path}`);
  }
  return entry.document as unknown as FormalArtifactEnvelope;
}

export function refreshG3Envelope(bundle: DocumentBundle, path: string): void {
  const current = g3Envelope(bundle, path);
  (current as { content_hash: string }).content_hash = canonicalContentHash(current.document);
}

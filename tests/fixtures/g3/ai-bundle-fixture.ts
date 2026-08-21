import {
  canonicalContentHash,
  type DocumentBundle,
  type EvidenceStoreRecord,
  type FormalArtifactEnvelope,
} from "../../../harness/src/index.js";
import {
  G23_OPPORTUNITY_A,
  G23_OPPORTUNITY_B,
  G23_SOLUTION,
} from "../g2.3/discovery-synthesis-fixture.js";
import {
  createDiscoveryEvaluationFixture,
  G24_COMPARISON_A,
  G24_EVIDENCE_SUPPORT,
  G24_FAN_IN,
  G24_JUDGMENT_A_SUPPORT,
  G24_PORTFOLIO,
  G24_RECOMMENDATION,
  G24_REPORT,
  G24_TRACEABILITY,
} from "../g2.4/discovery-evaluation-fixture.js";

export const G31_BENCHMARK = "artifacts/ai/benchmark-household.r1.json";
export const G31_RELIABILITY = "artifacts/ai/reliability-household.r1.json";
export const G31_DATA = "artifacts/ai/data-dependency-household.r1.json";
export const G31_CAPABILITY = "artifacts/ai/capability-household.r1.json";
export const G32_ECONOMICS = "artifacts/ai/economics-household.r1.json";
export const G32_COMMODITIZATION = "artifacts/ai/commoditization-household.r1.json";
export const G32_TRUST = "artifacts/ai/adoption-trust-household.r1.json";
export const G33_MANDATORY_BUNDLE = "artifacts/ai/mandatory-bundle-household.r1.json";

export interface G3FixtureSubstrate {
  readonly generation: EvidenceStoreRecord;
  readonly evaluation: EvidenceStoreRecord;
  readonly support: EvidenceStoreRecord;
  readonly challenge: EvidenceStoreRecord;
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
  schemaVersion:
    | "startup_opportunity.artifact_envelope.current"
    | "startup_opportunity.artifact_envelope.current"
    | "startup_opportunity.artifact_envelope.current" = "startup_opportunity.artifact_envelope.current",
): FormalArtifactEnvelope {
  return {
    schema_version: schemaVersion,
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
  (bundle as { schema_version: string }).schema_version =
    "startup_opportunity.document_bundle.current";
  const manifest = bundle.documents.find((entry) => entry.path === "manifest.json");
  if (manifest !== undefined) {
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

export async function createG32AiBundleFixture(
  runId: string,
  substrate: G3FixtureSubstrate,
): Promise<DocumentBundle> {
  const bundle = await createG3AiBundleFixture(runId, substrate);
  (bundle as { schema_version: string }).schema_version =
    "startup_opportunity.document_bundle.current";
  const manifest = bundle.documents.find((entry) => entry.path === "manifest.json");
  if (manifest !== undefined) {
  }

  const economics = {
    schema_version: "startup_opportunity.ai_inference_unit_economics.v1",
    economics_id: "economics_household",
    run_id: runId,
    lineage: lineage(),
    research_mode: "desk_research_only",
    capability_evidence_ref: G31_CAPABILITY,
    benchmark_ref: G31_BENCHMARK,
    scope_boundary: {
      cost_scope: "product_inference_only",
      harness_execution_cost_included: false,
      agent_execution_cost_included: false,
    },
    volume_scenarios: [
      {
        scenario_id: "synthetic_low_volume",
        monthly_product_units: 0,
        peak_concurrency: 0,
        assumption: SYNTHETIC,
      },
    ],
    unit_cost_model: {
      currency: "USD",
      estimate_status: "unknown",
      provider_cost_per_unit: 0,
      infrastructure_cost_per_unit: 0,
      human_review_cost_per_unit: 0,
      total_cost_per_unit: 0,
      measurement_basis: SYNTHETIC,
    },
    latency_and_deployment: {
      p95_latency_ms: 0,
      latency_status: "unknown",
      deployment_modes: ["provider_cloud"],
      deployment_constraints: [SYNTHETIC],
    },
    product_economics: {
      revenue_basis: SYNTHETIC,
      gross_margin_status: "unknown",
      sensitivity_drivers: [SYNTHETIC],
      service_burden: "unknown",
    },
    kill_boundary: {
      status: "unknown",
      conditions: [SYNTHETIC],
    },
    conclusion_ceiling: "insufficient_evidence",
    ceiling_reasons: [SYNTHETIC],
    evidence_refs: [G24_EVIDENCE_SUPPORT],
    judgment_assessment_refs: [G24_JUDGMENT_A_SUPPORT],
    freshness: freshness(),
    source_boundary: sourceBoundary(),
    limitations: [SYNTHETIC],
  };
  const substitution = {
    status: "unknown",
    time_horizon: "unknown",
    impact: "unknown",
    boundary: SYNTHETIC,
  };
  const commoditization = {
    schema_version: "startup_opportunity.capability_commoditization_risk.v1",
    risk_id: "commoditization_household",
    run_id: runId,
    lineage: lineage(),
    research_mode: "desk_research_only",
    capability_evidence_ref: G31_CAPABILITY,
    data_dependency_ref: G31_DATA,
    provider_substitution: substitution,
    platform_native_substitution: structuredClone(substitution),
    open_source_substitution: structuredClone(substitution),
    provider_portability: {
      status: "unknown",
      switching_cost: "unknown",
      dependency_boundary: SYNTHETIC,
    },
    platform_bundle_risk: {
      risk_level: "unknown",
      bundle_path: SYNTHETIC,
      migration_response: SYNTHETIC,
    },
    capability_half_life: {
      estimate_band: "unknown",
      revalidate_by: "2026-08-29T00:00:00Z",
      rationale: SYNTHETIC,
    },
    defensibility_beyond_model_access: {
      status: "unknown",
      sources: ["unknown"],
      boundary: SYNTHETIC,
    },
    overall_risk: "unknown",
    conclusion_ceiling: "insufficient_evidence",
    ceiling_reasons: [SYNTHETIC],
    evidence_refs: [G24_EVIDENCE_SUPPORT],
    judgment_assessment_refs: [G24_JUDGMENT_A_SUPPORT],
    freshness: freshness(),
    source_boundary: sourceBoundary(),
    limitations: [SYNTHETIC],
  };
  const trust = {
    schema_version: "startup_opportunity.ai_adoption_trust.v1",
    trust_id: "trust_household",
    run_id: runId,
    lineage: lineage(),
    research_mode: "desk_research_only",
    capability_evidence_ref: G31_CAPABILITY,
    reliability_ref: G31_RELIABILITY,
    data_dependency_ref: G31_DATA,
    adoption_friction: {
      level: "unknown",
      drivers: [SYNTHETIC],
      mitigations: [SYNTHETIC],
    },
    consumer_trust: { status: "unknown", boundary: SYNTHETIC },
    explainability: { status: "unknown", boundary: SYNTHETIC },
    accountability: {
      status: "unknown",
      owner: SYNTHETIC,
      escalation_boundary: SYNTHETIC,
    },
    safety_and_privacy: {
      risk_level: "unknown",
      controls_status: "unknown",
      residual_risks: [SYNTHETIC],
    },
    regulated_ai_boundary: {
      applicability: "unclear",
      jurisdictions: [SYNTHETIC],
      obligations: [SYNTHETIC],
      human_oversight_required: true,
      boundary: SYNTHETIC,
    },
    workflow_entry_status: "unknown",
    conclusion_ceiling: "insufficient_evidence",
    ceiling_reasons: [SYNTHETIC],
    evidence_refs: [G24_EVIDENCE_SUPPORT],
    judgment_assessment_refs: [G24_JUDGMENT_A_SUPPORT],
    freshness: freshness(),
    source_boundary: sourceBoundary(),
    limitations: [SYNTHETIC],
  };

  const documents = [
    [G32_ECONOMICS, economics],
    [G32_COMMODITIZATION, commoditization],
    [G32_TRUST, trust],
  ] as const;
  (bundle.documents as { path: string; document: Record<string, unknown> }[]).push(
    ...documents.map(([path, document], index) => ({
      path,
      document: envelope(
        runId,
        path,
        document,
        new Date(Date.parse("2026-07-29T01:10:00Z") + index * 1000).toISOString(),
        "startup_opportunity.artifact_envelope.current",
      ) as unknown as Record<string, unknown>,
    })),
  );
  return bundle;
}

export async function createG33AiBundleFixture(
  runId: string,
  substrate: G3FixtureSubstrate,
): Promise<DocumentBundle> {
  const bundle = await createG32AiBundleFixture(runId, substrate);
  (bundle as { schema_version: string }).schema_version =
    "startup_opportunity.document_bundle.current";
  const manifest = bundle.documents.find((entry) => entry.path === "manifest.json");
  if (manifest !== undefined) {
  }

  const artifactRefs = {
    capability_evidence_ref: G31_CAPABILITY,
    benchmark_ref: G31_BENCHMARK,
    reliability_ref: G31_RELIABILITY,
    data_dependency_ref: G31_DATA,
    economics_ref: G32_ECONOMICS,
    commoditization_ref: G32_COMMODITIZATION,
    adoption_trust_ref: G32_TRUST,
  };
  const inputRefs = Object.values(artifactRefs);
  const mandatoryBundle = {
    schema_version: "startup_opportunity.ai_mandatory_bundle.v1",
    bundle_id: "mandatory_bundle_household",
    run_id: runId,
    lineage: lineage(),
    research_mode: "desk_research_only",
    artifact_refs: artifactRefs,
    input_artifact_hashes: inputRefs.map((ref) => ({
      ref,
      content_hash: canonicalContentHash(g3Envelope(bundle, ref).document),
    })),
    dimension_results: [
      ["capability_frontier", [G31_CAPABILITY, G31_BENCHMARK]],
      ["cost_and_deployment", [G32_ECONOMICS]],
      ["workflow_and_human_boundary", [G31_RELIABILITY]],
      ["ecosystem_and_platform", [G32_COMMODITIZATION]],
      ["data_and_evaluation", [G31_DATA, G31_CAPABILITY]],
      ["adoption_and_trust", [G32_TRUST]],
    ].map(([dimension, refs]) => ({
      dimension,
      coverage_status: "covered",
      artifact_refs: refs,
      rationale: SYNTHETIC,
      limitations: [SYNTHETIC],
      source_unavailable: false,
      not_applicable_reason: null,
    })),
    coverage_summary: {
      covered: 6,
      insufficient_evidence: 0,
      not_applicable: 0,
      total: 6,
    },
    bundle_status: "desk_research_only",
    freshness: freshness(),
    continuation: {
      required: true,
      reason: "desk_research_only",
      action: SYNTHETIC,
    },
    conclusion_ceiling: "insufficient_evidence",
    source_boundary: sourceBoundary(),
    limitations: [SYNTHETIC],
  };
  (bundle.documents as { path: string; document: Record<string, unknown> }[]).push({
    path: G33_MANDATORY_BUNDLE,
    document: envelope(
      runId,
      G33_MANDATORY_BUNDLE,
      mandatoryBundle,
      "2026-07-29T01:20:00Z",
      "startup_opportunity.artifact_envelope.current",
    ) as unknown as Record<string, unknown>,
  });

  const binding = {
    status: "bound",
    trigger_version: "startup_opportunity.ai_mandatory_coverage_trigger.v1",
    subject_ref: G23_OPPORTUNITY_A,
    selected_solution_ref: G23_SOLUTION,
    bundle_ref: G33_MANDATORY_BUNDLE,
    bundle_content_hash: canonicalContentHash(mandatoryBundle),
    coverage_state: "desk_research_only",
    conclusion_ceiling: "insufficient_evidence",
    not_required_reason: null,
  };
  for (const artifactPath of [G24_COMPARISON_A, G24_RECOMMENDATION, G24_TRACEABILITY, G24_REPORT]) {
    const consumer = g3Envelope(bundle, artifactPath);
    (consumer as { schema_version: string }).schema_version =
      "startup_opportunity.artifact_envelope.current";
    consumer.ai_bundle_binding = structuredClone(binding);
    (consumer as { input_refs: readonly string[] }).input_refs = [
      ...new Set([...consumer.input_refs, G23_OPPORTUNITY_A, G23_SOLUTION, G33_MANDATORY_BUNDLE]),
    ].sort();
  }
  return bundle;
}

function effectiveFixtureDocument(bundle: DocumentBundle, artifactPath: string) {
  const outer = g3Envelope(bundle, artifactPath) as unknown as Record<string, unknown>;
  return String(outer.schema_version).startsWith("startup_opportunity.artifact_envelope.")
    ? (outer.document as Record<string, unknown>)
    : outer;
}

function collectFixtureRefs(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(collectFixtureRefs);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    if ((key.endsWith("_refs") || key === "input_refs") && Array.isArray(child)) {
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
    return collectFixtureRefs(child);
  });
}

function refreshFixtureEnvelope(bundle: DocumentBundle, artifactPath: string): void {
  const outer = g3Envelope(bundle, artifactPath) as unknown as Record<string, unknown>;
  if (String(outer.schema_version).startsWith("startup_opportunity.artifact_envelope.")) {
    outer.content_hash = canonicalContentHash(outer.document as Record<string, unknown>);
    if (artifactPath === G24_REPORT) {
      outer.input_refs = [
        ...new Set([
          ...collectFixtureRefs(outer.document),
          ...collectFixtureRefs(outer.ai_bundle_binding),
        ]),
      ]
        .filter((ref) => ref !== artifactPath)
        .sort();
    }
  }
}

function refreshAllFixtureHashes(bundle: DocumentBundle): void {
  for (let pass = 0; pass < bundle.documents.length; pass += 1) {
    let changed = false;
    for (const candidate of bundle.documents) {
      const document = effectiveFixtureDocument(bundle, candidate.path);
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
          const expected = canonicalContentHash(effectiveFixtureDocument(bundle, ref));
          if (binding.content_hash !== expected) {
            binding.content_hash = expected;
            changed = true;
          }
        }
      }
      refreshFixtureEnvelope(bundle, candidate.path);
    }
    if (!changed) {
      return;
    }
  }
}

export function refreshG33FixtureHashes(bundle: DocumentBundle): void {
  refreshAllFixtureHashes(bundle);
  const mandatory = g3Envelope(bundle, G33_MANDATORY_BUNDLE).document;
  const mandatoryHash = canonicalContentHash(mandatory);
  for (const artifactPath of [G24_COMPARISON_A, G24_RECOMMENDATION, G24_TRACEABILITY, G24_REPORT]) {
    const consumer = g3Envelope(bundle, artifactPath);
    const binding = consumer.ai_bundle_binding as Record<string, unknown>;
    binding.bundle_content_hash = mandatoryHash;
  }
}

export async function createG33CompleteAiBundleFixture(
  runId: string,
  substrate: G3FixtureSubstrate,
): Promise<DocumentBundle> {
  const bundle = await createG33AiBundleFixture(runId, substrate);
  const benchmark = g3Envelope(bundle, G31_BENCHMARK).document;
  (benchmark.product_candidate_result as Record<string, unknown>).incremental_value_status =
    "demonstrated";
  const representativeness = benchmark.representativeness as Record<string, unknown>;
  representativeness.status = "representative";
  representativeness.known_gaps = [];

  const reliability = g3Envelope(bundle, G31_RELIABILITY).document;
  const technicalReliability = reliability.technical_reliability as Record<string, unknown>;
  technicalReliability.status = "sufficient";
  technicalReliability.error_cost = "medium";
  technicalReliability.evaluation_feasibility = "feasible";
  for (const failure of reliability.failure_modes as Record<string, unknown>[]) {
    failure.detectability = "reliable";
  }
  (reliability.monitoring_boundary as Record<string, unknown>).unmonitored_failures = [];

  const data = g3Envelope(bundle, G31_DATA).document;
  for (const requirement of data.data_requirements as Record<string, unknown>[]) {
    requirement.rights_basis = "explicit_permission";
    requirement.availability = "available";
  }
  (data.ground_truth as Record<string, unknown>).status = "available";
  const feedback = data.feedback_loop as Record<string, unknown>;
  feedback.status = "available";
  feedback.moat_status = "credible";
  (data.provider_portability as Record<string, unknown>).status = "provider_independent";
  const privacy = data.privacy_boundary as Record<string, unknown>;
  privacy.risk_level = "low";
  privacy.deletion_status = "supported";
  privacy.export_status = "supported";

  const economics = g3Envelope(bundle, G32_ECONOMICS).document;
  economics.research_mode = "limited_evaluation";
  (economics.unit_cost_model as Record<string, unknown>).estimate_status = "bounded_estimate";
  const latency = economics.latency_and_deployment as Record<string, unknown>;
  latency.latency_status = "within_boundary";
  const productEconomics = economics.product_economics as Record<string, unknown>;
  productEconomics.gross_margin_status = "viable";
  productEconomics.service_burden = "low";
  (economics.kill_boundary as Record<string, unknown>).status = "not_triggered";
  economics.conclusion_ceiling = "prioritize_allowed";

  const commoditization = g3Envelope(bundle, G32_COMMODITIZATION).document;
  commoditization.research_mode = "limited_evaluation";
  for (const field of [
    "provider_substitution",
    "platform_native_substitution",
    "open_source_substitution",
  ]) {
    const substitution = commoditization[field] as Record<string, unknown>;
    substitution.status = "not_available";
    substitution.time_horizon = "over_12_months";
    substitution.impact = "low";
  }
  const commoditizationPortability = commoditization.provider_portability as Record<
    string,
    unknown
  >;
  commoditizationPortability.status = "provider_independent";
  commoditizationPortability.switching_cost = "low";
  (commoditization.platform_bundle_risk as Record<string, unknown>).risk_level = "low";
  (commoditization.capability_half_life as Record<string, unknown>).estimate_band =
    "over_24_months";
  const defensibility = commoditization.defensibility_beyond_model_access as Record<
    string,
    unknown
  >;
  defensibility.status = "credible";
  defensibility.sources = ["workflow_state"];
  commoditization.overall_risk = "low";
  commoditization.conclusion_ceiling = "prioritize_allowed";

  const trust = g3Envelope(bundle, G32_TRUST).document;
  trust.research_mode = "limited_evaluation";
  (trust.adoption_friction as Record<string, unknown>).level = "low";
  (trust.consumer_trust as Record<string, unknown>).status = "acceptable";
  (trust.explainability as Record<string, unknown>).status = "acceptable";
  (trust.accountability as Record<string, unknown>).status = "assigned";
  const safety = trust.safety_and_privacy as Record<string, unknown>;
  safety.risk_level = "low";
  safety.controls_status = "adequate";
  (trust.regulated_ai_boundary as Record<string, unknown>).applicability = "not_regulated";
  trust.workflow_entry_status = "allowed";
  trust.conclusion_ceiling = "prioritize_allowed";

  const mandatory = g3Envelope(bundle, G33_MANDATORY_BUNDLE).document;
  mandatory.research_mode = "limited_evaluation";
  mandatory.bundle_status = "complete";
  mandatory.continuation = { required: false, reason: "none", action: SYNTHETIC };
  mandatory.conclusion_ceiling = "prioritize_allowed";

  const fanIn = g3Envelope(bundle, G24_FAN_IN).document;
  for (const gate of fanIn.hard_gate_inputs as Record<string, unknown>[]) {
    if (gate.opportunity_ref === G23_OPPORTUNITY_A) {
      gate.status = "passed";
    }
  }
  const fanInCeiling = (fanIn.opportunity_conclusion_ceilings as Record<string, unknown>[]).find(
    (entry) => entry.opportunity_ref === G23_OPPORTUNITY_A,
  );
  if (fanInCeiling === undefined) {
    throw new Error("missing G3 complete fixture fan-in ceiling");
  }
  fanInCeiling.conclusion_ceiling = "strong_candidate";

  const comparison = g3Envelope(bundle, G24_COMPARISON_A).document;
  for (const gate of comparison.hard_gate_results as Record<string, unknown>[]) {
    gate.status = "passed";
  }
  comparison.hard_gate_outcome = "eligible";
  comparison.recommendation_band = "strong_candidate";
  for (const panel of comparison.comparison_panels as Record<string, unknown>[]) {
    panel.band = "medium";
    panel.decision_sufficiency = "sufficient";
  }

  const portfolio = g3Envelope(bundle, G24_PORTFOLIO).document;
  portfolio.recommended_first_bet = G23_OPPORTUNITY_A;
  portfolio.alternative_bets = [G23_OPPORTUNITY_B];
  for (const entry of portfolio.opportunity_ranking as Record<string, unknown>[]) {
    entry.rank = entry.opportunity_ref === G23_OPPORTUNITY_A ? 1 : null;
  }
  const recommendation = g3Envelope(bundle, G24_RECOMMENDATION).document;
  recommendation.recommended_first_bet = G23_OPPORTUNITY_A;
  recommendation.alternative_bets = [G23_OPPORTUNITY_B];
  recommendation.decision_tier = "prioritize";
  const reportEnvelope = g3Envelope(bundle, G24_REPORT);
  const report = reportEnvelope.document;
  delete report.team_decision_summary;
  report.top_opportunity_refs = [G23_OPPORTUNITY_A];
  const context = report.curated_judgment_context as Record<string, unknown>;
  context.recommended_first_bet = G23_OPPORTUNITY_A;
  context.alternative_bets = [G23_OPPORTUNITY_B];
  context.decision_tier = "prioritize";
  (reportEnvelope as { input_refs: readonly string[] }).input_refs = [
    ...new Set(reportEnvelope.input_refs.filter((ref) => ref !== G23_OPPORTUNITY_B)),
  ].sort();

  for (const artifactPath of [G24_COMPARISON_A, G24_RECOMMENDATION, G24_TRACEABILITY, G24_REPORT]) {
    const consumer = g3Envelope(bundle, artifactPath);
    const binding = consumer.ai_bundle_binding as Record<string, unknown>;
    binding.coverage_state = "complete";
    binding.conclusion_ceiling = "prioritize_allowed";
  }
  refreshG33FixtureHashes(bundle);
  return bundle;
}

export async function createG33NonAiBindingFixture(
  runId: string,
  substrate: G3FixtureSubstrate,
): Promise<DocumentBundle> {
  const bundle = await createDiscoveryEvaluationFixture(runId, substrate, "general");
  (bundle as { schema_version: string }).schema_version =
    "startup_opportunity.document_bundle.current";
  const manifest = bundle.documents.find((entry) => entry.path === "manifest.json");
  if (manifest !== undefined) {
  }
  const binding = {
    status: "not_required",
    trigger_version: "startup_opportunity.ai_mandatory_coverage_trigger.v1",
    subject_ref: G23_OPPORTUNITY_A,
    selected_solution_ref: G23_SOLUTION,
    bundle_ref: null,
    bundle_content_hash: null,
    coverage_state: "not_required",
    conclusion_ceiling: "not_required",
    not_required_reason: "SYNTHETIC selected Solution has uses_ai=false.",
  };
  for (const artifactPath of [G24_COMPARISON_A, G24_RECOMMENDATION, G24_TRACEABILITY, G24_REPORT]) {
    const consumer = g3Envelope(bundle, artifactPath);
    (consumer as { schema_version: string }).schema_version =
      "startup_opportunity.artifact_envelope.current";
    consumer.ai_bundle_binding = structuredClone(binding);
    (consumer as { input_refs: readonly string[] }).input_refs = [
      ...new Set([...consumer.input_refs, G23_OPPORTUNITY_A, G23_SOLUTION]),
    ].sort();
  }
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

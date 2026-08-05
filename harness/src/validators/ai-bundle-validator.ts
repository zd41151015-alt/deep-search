import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import type { ValidationIssue } from "./schema-bundle.js";

const G3_1_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.capability_evidence.v1",
  "startup_opportunity.ai_capability_benchmark.v1",
  "startup_opportunity.ai_evaluation_reliability.v1",
  "startup_opportunity.ai_data_dependency.v1",
]);

const G3_2_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.ai_inference_unit_economics.v1",
  "startup_opportunity.capability_commoditization_risk.v1",
  "startup_opportunity.ai_adoption_trust.v1",
]);

const REQUIRED_DIMENSIONS = [
  "capability_frontier",
  "cost_and_deployment",
  "workflow_and_human_boundary",
  "ecosystem_and_platform",
  "data_and_evaluation",
  "adoption_and_trust",
] as const;

const MANDATORY_INPUTS = [
  ["capability_evidence_ref", "startup_opportunity.capability_evidence.v1"],
  ["benchmark_ref", "startup_opportunity.ai_capability_benchmark.v1"],
  ["reliability_ref", "startup_opportunity.ai_evaluation_reliability.v1"],
  ["data_dependency_ref", "startup_opportunity.ai_data_dependency.v1"],
  ["economics_ref", "startup_opportunity.ai_inference_unit_economics.v1"],
  ["commoditization_ref", "startup_opportunity.capability_commoditization_risk.v1"],
  ["adoption_trust_ref", "startup_opportunity.ai_adoption_trust.v1"],
] as const;

const AI_CONCLUSION_CEILING_ORDER = [
  "reject",
  "insufficient_evidence",
  "investigate_further_only",
  "prioritize_allowed",
] as const;

type AiConclusionCeiling = (typeof AI_CONCLUSION_CEILING_ORDER)[number];

const CONSUMER_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.opportunity_comparison.v1",
  "startup_opportunity.decision_recommendation.v1",
  "startup_opportunity.traceability.discovery.current",
  "startup_opportunity.report.v1",
  "startup_opportunity.decision_brief.discovery.current",
  "startup_opportunity.discovery_report_view.v1",
  "startup_opportunity.report_consistency_evaluation.discovery.current",
]);

const REQUIRED_CONSUMER_BINDING_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.opportunity_comparison.v1",
  "startup_opportunity.decision_recommendation.v1",
  "startup_opportunity.traceability.discovery.current",
  "startup_opportunity.report.v1",
  "startup_opportunity.decision_brief.discovery.current",
  "startup_opportunity.discovery_report_view.v1",
  "startup_opportunity.report_consistency_evaluation.discovery.current",
]);

export interface AiBundleDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope?: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  code: string,
  path: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "ai_contract",
    instancePath: path,
    schemaPath: "",
    message,
    details,
  };
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function strictestAiConclusionCeiling(values: readonly AiConclusionCeiling[]): AiConclusionCeiling {
  return values.reduce<AiConclusionCeiling>(
    (strictest, candidate) =>
      AI_CONCLUSION_CEILING_ORDER.indexOf(candidate) <
      AI_CONCLUSION_CEILING_ORDER.indexOf(strictest)
        ? candidate
        : strictest,
    "prioritize_allowed",
  );
}

function mappedCeiling(
  value: unknown,
  prioritizeValues: readonly string[],
  investigateValues: readonly string[],
): AiConclusionCeiling {
  if (prioritizeValues.includes(String(value))) {
    return "prioritize_allowed";
  }
  if (investigateValues.includes(String(value))) {
    return "investigate_further_only";
  }
  return "insufficient_evidence";
}

function specializedInputCeiling(entry: AiBundleDocument): AiConclusionCeiling {
  const ceilings: AiConclusionCeiling[] = [];
  const freshness = isRecord(entry.document.freshness) ? entry.document.freshness : {};
  if (entry.document.research_mode === "desk_research_only" || freshness.status !== "current") {
    ceilings.push("insufficient_evidence");
  }

  const explicitCeiling = entry.document.conclusion_ceiling;
  if (
    typeof explicitCeiling === "string" &&
    AI_CONCLUSION_CEILING_ORDER.includes(explicitCeiling as AiConclusionCeiling)
  ) {
    ceilings.push(explicitCeiling as AiConclusionCeiling);
  }

  if (entry.schemaVersion === "startup_opportunity.capability_evidence.v1") {
    const results = Array.isArray(entry.document.dimension_results)
      ? entry.document.dimension_results.filter(isRecord)
      : [];
    ceilings.push(
      results.some((result) => result.coverage_status === "insufficient_evidence")
        ? "insufficient_evidence"
        : "prioritize_allowed",
    );
  }

  if (entry.schemaVersion === "startup_opportunity.ai_capability_benchmark.v1") {
    const candidate = isRecord(entry.document.product_candidate_result)
      ? entry.document.product_candidate_result
      : {};
    const representativeness = isRecord(entry.document.representativeness)
      ? entry.document.representativeness
      : {};
    ceilings.push(
      mappedCeiling(candidate.incremental_value_status, ["demonstrated"], ["partial"]),
      mappedCeiling(representativeness.status, ["representative"], ["limited"]),
    );
  }

  if (entry.schemaVersion === "startup_opportunity.ai_evaluation_reliability.v1") {
    const reliability = isRecord(entry.document.technical_reliability)
      ? entry.document.technical_reliability
      : {};
    const humanBoundary = isRecord(entry.document.human_boundary)
      ? entry.document.human_boundary
      : {};
    ceilings.push(
      mappedCeiling(reliability.status, ["sufficient"], ["partial"]),
      mappedCeiling(reliability.evaluation_feasibility, ["feasible"], ["partial"]),
      mappedCeiling(
        humanBoundary.mode,
        ["human_in_the_loop", "human_on_the_loop", "automation_allowed"],
        [],
      ),
    );
  }

  if (entry.schemaVersion === "startup_opportunity.ai_data_dependency.v1") {
    const requirements = Array.isArray(entry.document.data_requirements)
      ? entry.document.data_requirements.filter(isRecord)
      : [];
    const groundTruth = isRecord(entry.document.ground_truth) ? entry.document.ground_truth : {};
    const feedback = isRecord(entry.document.feedback_loop) ? entry.document.feedback_loop : {};
    const portability = isRecord(entry.document.provider_portability)
      ? entry.document.provider_portability
      : {};
    ceilings.push(
      ...requirements.map((requirement) =>
        mappedCeiling(requirement.availability, ["available"], ["partial"]),
      ),
      mappedCeiling(groundTruth.status, ["available"], ["partial"]),
      mappedCeiling(feedback.status, ["available"], ["limited"]),
      mappedCeiling(
        portability.status,
        ["provider_independent", "portable_with_cost"],
        ["provider_locked"],
      ),
    );
  }

  return strictestAiConclusionCeiling(ceilings.length === 0 ? ["prioritize_allowed"] : ceilings);
}

function lineage(document: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(document.lineage) ? document.lineage : null;
}

function sameLineage(
  source: AiBundleDocument,
  target: AiBundleDocument,
): readonly ValidationIssue[] {
  const left = lineage(source.document);
  const right = lineage(target.document);
  if (
    left === null ||
    right === null ||
    left.subject_ref !== right.subject_ref ||
    left.opportunity_ref !== right.opportunity_ref ||
    left.selected_solution_ref !== right.selected_solution_ref ||
    left.trigger_version !== right.trigger_version ||
    source.document.run_id !== target.document.run_id
  ) {
    return [
      issue(
        "g3.lineage_mismatch",
        `${source.path}#/lineage`,
        "AI artifacts in one capability set must bind the same Run, subject, Opportunity, selected Solution, and trigger",
        { target: target.path },
      ),
    ];
  }
  return [];
}

export function isAiBundleSchemaVersion(schemaVersion: string): boolean {
  return (
    G3_1_SCHEMA_VERSIONS.has(schemaVersion) ||
    G3_2_SCHEMA_VERSIONS.has(schemaVersion) ||
    schemaVersion === "startup_opportunity.ai_mandatory_bundle.v1"
  );
}

export function validateAiBundleContract(
  documents: readonly AiBundleDocument[],
  validateMandatoryCoverage = false,
): readonly ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const byPath = new Map(documents.map((entry) => [entry.path, entry]));
  const aiDocuments = documents.filter(
    (entry) =>
      G3_1_SCHEMA_VERSIONS.has(entry.schemaVersion) ||
      G3_2_SCHEMA_VERSIONS.has(entry.schemaVersion),
  );

  for (const entry of aiDocuments) {
    const boundLineage = lineage(entry.document);
    if (boundLineage === null) {
      continue;
    }
    const opportunity = byPath.get(String(boundLineage.opportunity_ref));
    const solution = byPath.get(String(boundLineage.selected_solution_ref));
    if (
      boundLineage.subject_ref !== boundLineage.opportunity_ref ||
      opportunity?.schemaVersion !== "startup_opportunity.opportunity_thesis.v1" ||
      opportunity.document.selected_solution_ref !== boundLineage.selected_solution_ref
    ) {
      errors.push(
        issue(
          "g3.subject_lineage_mismatch",
          `${entry.path}#/lineage`,
          "AI artifact subject must be the Opportunity whose exact selected Solution is bound",
        ),
      );
    }
    if (
      solution?.schemaVersion !== "startup_opportunity.solution_hypothesis.v1" ||
      solution.document.uses_ai !== true
    ) {
      errors.push(
        issue(
          "g3.selected_solution_not_ai",
          `${entry.path}#/lineage/selected_solution_ref`,
          "AI artifact selected_solution_ref must resolve to the Opportunity's uses_ai=true Solution",
        ),
      );
    }
    const freshness = entry.document.freshness;
    if (isRecord(freshness)) {
      const validAsOf = Date.parse(String(freshness.valid_as_of));
      const expiresAt = Date.parse(String(freshness.expires_at));
      if (Number.isFinite(validAsOf) && Number.isFinite(expiresAt) && expiresAt <= validAsOf) {
        errors.push(
          issue(
            "g3.freshness_window_invalid",
            `${entry.path}#/freshness/expires_at`,
            "AI artifact expiry must be later than valid_as_of",
          ),
        );
      }
    }
  }

  for (const capability of aiDocuments.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.capability_evidence.v1",
  )) {
    const required = [...strings(capability.document.required_dimensions)].sort();
    const results = Array.isArray(capability.document.dimension_results)
      ? capability.document.dimension_results.filter(isRecord)
      : [];
    const actual = results.map((result) => String(result.dimension)).sort();
    if (
      new Set(actual).size !== actual.length ||
      required.length !== actual.length ||
      required.some((dimension, index) => dimension !== actual[index])
    ) {
      errors.push(
        issue(
          "g3.dimension_result_mismatch",
          `${capability.path}#/dimension_results`,
          "dimension_results must cover each declared required dimension exactly once",
          { required, actual },
        ),
      );
    }

    for (const result of results) {
      if (
        result.coverage_status === "insufficient_evidence" &&
        result.source_unavailable !== true &&
        strings(result.limitations).length === 0
      ) {
        errors.push(
          issue(
            "g3.insufficient_evidence_undisclosed",
            `${capability.path}#/dimension_results`,
            "insufficient_evidence requires a limitation or source_unavailable disclosure",
            { dimension: result.dimension },
          ),
        );
      }
    }

    const targets = [
      ["benchmark_ref", "startup_opportunity.ai_capability_benchmark.v1"],
      ["reliability_ref", "startup_opportunity.ai_evaluation_reliability.v1"],
      ["data_dependency_ref", "startup_opportunity.ai_data_dependency.v1"],
    ] as const;
    for (const [field, expectedVersion] of targets) {
      const target = byPath.get(String(capability.document[field]));
      if (target?.schemaVersion !== expectedVersion) {
        errors.push(
          issue(
            "g3.capability_input_mismatch",
            `${capability.path}#/${field}`,
            "capability evidence input has the wrong artifact type",
            { expectedVersion, actualVersion: target?.schemaVersion ?? null },
          ),
        );
      } else {
        errors.push(...sameLineage(capability, target));
      }
    }
    const reliability = byPath.get(String(capability.document.reliability_ref));
    if (
      reliability !== undefined &&
      reliability.document.benchmark_ref !== capability.document.benchmark_ref
    ) {
      errors.push(
        issue(
          "g3.reliability_benchmark_mismatch",
          `${reliability.path}#/benchmark_ref`,
          "reliability assessment must bind the capability set's exact benchmark",
        ),
      );
    }
  }

  for (const entry of aiDocuments.filter((candidate) =>
    G3_2_SCHEMA_VERSIONS.has(candidate.schemaVersion),
  )) {
    const capability = byPath.get(String(entry.document.capability_evidence_ref));
    if (capability?.schemaVersion !== "startup_opportunity.capability_evidence.v1") {
      errors.push(
        issue(
          "g3.economics_input_mismatch",
          `${entry.path}#/capability_evidence_ref`,
          "G3.2 artifacts must bind an exact capability evidence artifact",
        ),
      );
      continue;
    }
    errors.push(...sameLineage(entry, capability));

    const targets: readonly [string, string][] =
      entry.schemaVersion === "startup_opportunity.ai_inference_unit_economics.v1"
        ? [["benchmark_ref", "startup_opportunity.ai_capability_benchmark.v1"]]
        : entry.schemaVersion === "startup_opportunity.capability_commoditization_risk.v1"
          ? [["data_dependency_ref", "startup_opportunity.ai_data_dependency.v1"]]
          : [
              ["reliability_ref", "startup_opportunity.ai_evaluation_reliability.v1"],
              ["data_dependency_ref", "startup_opportunity.ai_data_dependency.v1"],
            ];
    for (const [field, expectedVersion] of targets) {
      const target = byPath.get(String(entry.document[field]));
      if (target?.schemaVersion !== expectedVersion) {
        errors.push(
          issue(
            "g3.economics_input_mismatch",
            `${entry.path}#/${field}`,
            "G3.2 input has the wrong artifact type",
            { expectedVersion, actualVersion: target?.schemaVersion ?? null },
          ),
        );
      } else {
        errors.push(...sameLineage(entry, target));
      }
    }

    if (
      entry.schemaVersion === "startup_opportunity.ai_inference_unit_economics.v1" &&
      entry.document.benchmark_ref !== capability.document.benchmark_ref
    ) {
      errors.push(
        issue(
          "g3.economics_input_mismatch",
          `${entry.path}#/benchmark_ref`,
          "inference economics must bind the capability set's exact benchmark",
        ),
      );
    }
    if (
      entry.schemaVersion === "startup_opportunity.capability_commoditization_risk.v1" &&
      entry.document.data_dependency_ref !== capability.document.data_dependency_ref
    ) {
      errors.push(
        issue(
          "g3.economics_input_mismatch",
          `${entry.path}#/data_dependency_ref`,
          "commoditization risk must bind the capability set's exact data dependency",
        ),
      );
    }
    if (
      entry.schemaVersion === "startup_opportunity.ai_adoption_trust.v1" &&
      (entry.document.reliability_ref !== capability.document.reliability_ref ||
        entry.document.data_dependency_ref !== capability.document.data_dependency_ref)
    ) {
      errors.push(
        issue(
          "g3.economics_input_mismatch",
          `${entry.path}#/reliability_ref`,
          "adoption and trust must bind the capability set's exact reliability and data artifacts",
        ),
      );
    }

    const ceiling = entry.document.conclusion_ceiling;
    const freshness = isRecord(entry.document.freshness) ? entry.document.freshness : {};
    if (
      ceiling === "prioritize_allowed" &&
      (entry.document.research_mode === "desk_research_only" || freshness.status !== "current")
    ) {
      errors.push(
        issue(
          "g3.conclusion_ceiling_too_high",
          `${entry.path}#/conclusion_ceiling`,
          "desk-research-only or non-current AI economics/trust artifacts cannot allow prioritize",
        ),
      );
    }
    if (entry.schemaVersion === "startup_opportunity.ai_inference_unit_economics.v1") {
      const cost = isRecord(entry.document.unit_cost_model) ? entry.document.unit_cost_model : {};
      const product = isRecord(entry.document.product_economics)
        ? entry.document.product_economics
        : {};
      const kill = isRecord(entry.document.kill_boundary) ? entry.document.kill_boundary : {};
      if (kill.status === "triggered" && ceiling !== "reject") {
        errors.push(
          issue(
            "g3.conclusion_ceiling_mismatch",
            `${entry.path}#/conclusion_ceiling`,
            "a triggered inference-economics kill boundary requires a reject ceiling",
          ),
        );
      }
      if (
        ceiling === "prioritize_allowed" &&
        (cost.estimate_status === "unknown" || product.gross_margin_status === "unknown")
      ) {
        errors.push(
          issue(
            "g3.conclusion_ceiling_too_high",
            `${entry.path}#/conclusion_ceiling`,
            "unknown unit-cost or gross-margin status cannot allow prioritize",
          ),
        );
      }
    }
    if (
      entry.schemaVersion === "startup_opportunity.capability_commoditization_risk.v1" &&
      ceiling === "prioritize_allowed" &&
      entry.document.overall_risk === "unknown"
    ) {
      errors.push(
        issue(
          "g3.conclusion_ceiling_too_high",
          `${entry.path}#/conclusion_ceiling`,
          "unknown commoditization risk cannot allow prioritize",
        ),
      );
    }
    if (entry.schemaVersion === "startup_opportunity.ai_adoption_trust.v1") {
      const regulated = isRecord(entry.document.regulated_ai_boundary)
        ? entry.document.regulated_ai_boundary
        : {};
      if (entry.document.workflow_entry_status === "blocked" && ceiling !== "reject") {
        errors.push(
          issue(
            "g3.conclusion_ceiling_mismatch",
            `${entry.path}#/conclusion_ceiling`,
            "a blocked trust workflow boundary requires a reject ceiling",
          ),
        );
      }
      if (
        ceiling === "prioritize_allowed" &&
        (entry.document.workflow_entry_status !== "allowed" ||
          regulated.applicability === "unclear")
      ) {
        errors.push(
          issue(
            "g3.conclusion_ceiling_too_high",
            `${entry.path}#/conclusion_ceiling`,
            "conditional/unknown workflow entry or unclear regulated-AI applicability cannot allow prioritize",
          ),
        );
      }
    }
  }

  if (!validateMandatoryCoverage) {
    return errors;
  }

  const mandatoryBundles = documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.ai_mandatory_bundle.v1",
  );
  if (mandatoryBundles.length > 1) {
    errors.push(
      issue(
        "g3.mandatory_bundle_cardinality",
        "/documents",
        "a v16 document bundle may contain at most one AI mandatory bundle for the selected subject",
        { count: mandatoryBundles.length },
      ),
    );
  }

  const mandatory = mandatoryBundles[0];
  if (mandatory !== undefined) {
    const mandatoryLineage = lineage(mandatory.document);
    const opportunity = byPath.get(String(mandatoryLineage?.opportunity_ref ?? ""));
    const solution = byPath.get(String(mandatoryLineage?.selected_solution_ref ?? ""));
    if (
      mandatoryLineage === null ||
      mandatoryLineage.subject_ref !== mandatoryLineage.opportunity_ref ||
      opportunity?.schemaVersion !== "startup_opportunity.opportunity_thesis.v1" ||
      opportunity.document.selected_solution_ref !== mandatoryLineage.selected_solution_ref ||
      solution?.schemaVersion !== "startup_opportunity.solution_hypothesis.v1" ||
      solution.document.uses_ai !== true
    ) {
      errors.push(
        issue(
          "g3.mandatory_subject_lineage_mismatch",
          `${mandatory.path}#/lineage`,
          "AI mandatory bundle must bind the exact Opportunity and its selected uses_ai=true Solution",
        ),
      );
    }
    const refs = isRecord(mandatory.document.artifact_refs) ? mandatory.document.artifact_refs : {};
    const resolvedInputs: AiBundleDocument[] = [];
    for (const [field, expectedVersion] of MANDATORY_INPUTS) {
      const ref = String(refs[field] ?? "");
      const target = byPath.get(ref);
      if (target?.schemaVersion !== expectedVersion) {
        errors.push(
          issue(
            "g3.mandatory_input_mismatch",
            `${mandatory.path}#/artifact_refs/${field}`,
            "AI mandatory bundle input has the wrong artifact type or is missing",
            { expectedVersion, actualVersion: target?.schemaVersion ?? null, ref },
          ),
        );
      } else {
        resolvedInputs.push(target);
        errors.push(...sameLineage(mandatory, target));
      }
    }

    const hashEntries = Array.isArray(mandatory.document.input_artifact_hashes)
      ? mandatory.document.input_artifact_hashes.filter(isRecord)
      : [];
    const expectedRefs = MANDATORY_INPUTS.map(([field]) => String(refs[field] ?? "")).sort();
    const actualRefs = hashEntries.map((entry) => String(entry.ref)).sort();
    if (
      new Set(actualRefs).size !== actualRefs.length ||
      canonicalJson(actualRefs) !== canonicalJson(expectedRefs)
    ) {
      errors.push(
        issue(
          "g3.mandatory_input_hash_set_mismatch",
          `${mandatory.path}#/input_artifact_hashes`,
          "AI mandatory bundle must hash each exact specialized input once",
          { expectedRefs, actualRefs },
        ),
      );
    }
    for (const hashEntry of hashEntries) {
      const target = byPath.get(String(hashEntry.ref));
      if (
        target !== undefined &&
        hashEntry.content_hash !== canonicalContentHash(target.document)
      ) {
        errors.push(
          issue(
            "g3.mandatory_input_hash_mismatch",
            `${mandatory.path}#/input_artifact_hashes`,
            "AI mandatory bundle input hash differs from the canonical immutable Artifact",
            { ref: hashEntry.ref },
          ),
        );
      }
    }

    const dimensionResults = Array.isArray(mandatory.document.dimension_results)
      ? mandatory.document.dimension_results.filter(isRecord)
      : [];
    const dimensions = dimensionResults.map((result) => String(result.dimension));
    if (canonicalJson(dimensions) !== canonicalJson(REQUIRED_DIMENSIONS)) {
      errors.push(
        issue(
          "g3.mandatory_dimension_mismatch",
          `${mandatory.path}#/dimension_results`,
          "AI mandatory bundle must preserve the trigger's fixed six-dimension order",
          { required: REQUIRED_DIMENSIONS, actual: dimensions },
        ),
      );
    }
    const counts = {
      covered: dimensionResults.filter((result) => result.coverage_status === "covered").length,
      insufficient_evidence: dimensionResults.filter(
        (result) => result.coverage_status === "insufficient_evidence",
      ).length,
      not_applicable: dimensionResults.filter(
        (result) => result.coverage_status === "not_applicable",
      ).length,
      total: dimensionResults.length,
    };
    if (canonicalJson(mandatory.document.coverage_summary) !== canonicalJson(counts)) {
      errors.push(
        issue(
          "g3.mandatory_coverage_summary_mismatch",
          `${mandatory.path}#/coverage_summary`,
          "AI mandatory bundle coverage summary must equal the six dimension results",
          { expected: counts },
        ),
      );
    }
    for (const result of dimensionResults) {
      const refsForDimension = strings(result.artifact_refs);
      if (result.coverage_status === "covered" && refsForDimension.length === 0) {
        errors.push(
          issue(
            "g3.covered_dimension_without_artifact",
            `${mandatory.path}#/dimension_results`,
            "covered dimensions require at least one specialized Artifact ref",
            { dimension: result.dimension },
          ),
        );
      }
      if (
        (result.source_unavailable === true &&
          result.coverage_status !== "insufficient_evidence") ||
        (result.coverage_status === "not_applicable" &&
          (result.source_unavailable === true || result.not_applicable_reason === null))
      ) {
        errors.push(
          issue(
            "g3.coverage_status_invalid",
            `${mandatory.path}#/dimension_results`,
            "source unavailability means insufficient_evidence; not_applicable requires a domain reason",
            { dimension: result.dimension },
          ),
        );
      }
      if (
        result.coverage_status === "insufficient_evidence" &&
        result.source_unavailable !== true &&
        strings(result.limitations).length === 0
      ) {
        errors.push(
          issue(
            "g3.insufficient_evidence_undisclosed",
            `${mandatory.path}#/dimension_results`,
            "insufficient_evidence requires a limitation or source-unavailable disclosure",
            { dimension: result.dimension },
          ),
        );
      }
      for (const ref of refsForDimension) {
        if (!expectedRefs.includes(ref)) {
          errors.push(
            issue(
              "g3.dimension_artifact_outside_bundle",
              `${mandatory.path}#/dimension_results`,
              "dimension coverage may cite only the mandatory bundle's exact specialized inputs",
              { dimension: result.dimension, ref },
            ),
          );
        }
      }
    }

    const anyInputDeskOnly = resolvedInputs.some(
      (entry) => entry.document.research_mode === "desk_research_only",
    );
    const inputFreshness = resolvedInputs.map((entry) =>
      isRecord(entry.document.freshness) ? entry.document.freshness.status : "unknown",
    );
    const aggregateFreshness = inputFreshness.includes("stale")
      ? "stale"
      : inputFreshness.includes("unknown")
        ? "unknown"
        : "current";
    const mandatoryFreshness = isRecord(mandatory.document.freshness)
      ? mandatory.document.freshness
      : {};
    const validAsOfValues = resolvedInputs
      .map((entry) =>
        isRecord(entry.document.freshness) ? String(entry.document.freshness.valid_as_of) : "",
      )
      .filter((value) => Number.isFinite(Date.parse(value)))
      .sort();
    const expiresAtValues = resolvedInputs
      .map((entry) =>
        isRecord(entry.document.freshness) ? String(entry.document.freshness.expires_at) : "",
      )
      .filter((value) => Number.isFinite(Date.parse(value)))
      .sort();
    const aggregateValidAsOf = validAsOfValues.at(-1);
    const aggregateExpiresAt = expiresAtValues[0];
    if (
      mandatoryFreshness.status !== aggregateFreshness ||
      mandatoryFreshness.valid_as_of !== aggregateValidAsOf ||
      mandatoryFreshness.expires_at !== aggregateExpiresAt
    ) {
      errors.push(
        issue(
          "g3.mandatory_freshness_mismatch",
          `${mandatory.path}#/freshness/status`,
          "AI mandatory bundle freshness must be the strictest specialized input freshness",
          {
            expected: {
              status: aggregateFreshness,
              valid_as_of: aggregateValidAsOf,
              expires_at: aggregateExpiresAt,
            },
            actual: mandatoryFreshness,
          },
        ),
      );
    }
    const expectedStatus =
      aggregateFreshness !== "current"
        ? "stale"
        : anyInputDeskOnly || mandatory.document.research_mode === "desk_research_only"
          ? "desk_research_only"
          : counts.insufficient_evidence > 0
            ? "incomplete"
            : "complete";
    if (mandatory.document.bundle_status !== expectedStatus) {
      errors.push(
        issue(
          "g3.mandatory_status_mismatch",
          `${mandatory.path}#/bundle_status`,
          "AI mandatory bundle status must follow coverage, research mode, and freshness",
          { expected: expectedStatus, actual: mandatory.document.bundle_status },
        ),
      );
    }
    const continuation = isRecord(mandatory.document.continuation)
      ? mandatory.document.continuation
      : {};
    const expectedReason =
      expectedStatus === "complete"
        ? "none"
        : expectedStatus === "stale" && aggregateFreshness === "unknown"
          ? "unknown_freshness"
          : expectedStatus;
    if (
      continuation.required !== (expectedStatus !== "complete") ||
      continuation.reason !== expectedReason
    ) {
      errors.push(
        issue(
          "g3.mandatory_continuation_mismatch",
          `${mandatory.path}#/continuation`,
          "stale, incomplete, desk-only, or unknown-freshness bundles require explicit continuation",
          { expectedReason },
        ),
      );
    }
    const inputCeilings = resolvedInputs.map((entry) => ({
      ref: entry.path,
      ceiling: specializedInputCeiling(entry),
    }));
    const expectedCeiling = strictestAiConclusionCeiling([
      ...inputCeilings.map((entry) => entry.ceiling),
      counts.insufficient_evidence > 0 ||
      aggregateFreshness !== "current" ||
      mandatory.document.research_mode === "desk_research_only"
        ? "insufficient_evidence"
        : "prioritize_allowed",
    ]);
    if (mandatory.document.conclusion_ceiling !== expectedCeiling) {
      errors.push(
        issue(
          "g3.mandatory_conclusion_ceiling_mismatch",
          `${mandatory.path}#/conclusion_ceiling`,
          "AI mandatory bundle conclusion ceiling must equal the strictest specialized input and bundle-state ceiling",
          {
            expected: expectedCeiling,
            actual: mandatory.document.conclusion_ceiling,
            inputCeilings,
          },
        ),
      );
    }
  }

  const consumers = documents.filter(
    (entry) =>
      entry.envelope?.schema_version === "startup_opportunity.artifact_envelope.current" &&
      CONSUMER_SCHEMA_VERSIONS.has(entry.schemaVersion) &&
      (REQUIRED_CONSUMER_BINDING_SCHEMA_VERSIONS.has(entry.schemaVersion) ||
        isRecord(entry.envelope.ai_bundle_binding)),
  );
  const firstBindingBySubject = new Map<string, Record<string, unknown>>();
  for (const consumer of consumers) {
    const binding = isRecord(consumer.envelope?.ai_bundle_binding)
      ? consumer.envelope.ai_bundle_binding
      : null;
    if (binding === null) {
      errors.push(
        issue(
          "g3.consumer_binding_missing",
          `${consumer.path}#/ai_bundle_binding`,
          "current evaluation and report consumers require an explicit AI bundle binding",
        ),
      );
      continue;
    }
    const bindingSubject = String(binding.subject_ref);
    const firstBinding = firstBindingBySubject.get(bindingSubject);
    if (firstBinding === undefined) {
      firstBindingBySubject.set(bindingSubject, binding);
    } else if (canonicalJson(firstBinding) !== canonicalJson(binding)) {
      errors.push(
        issue(
          "g3.consumer_binding_mismatch",
          `${consumer.path}#/ai_bundle_binding`,
          "current comparison, recommendation, traceability, report, and derived consumers for one subject must share one exact binding",
        ),
      );
    }
    const opportunity = byPath.get(String(binding.subject_ref));
    const solution = byPath.get(String(binding.selected_solution_ref));
    if (
      opportunity?.schemaVersion !== "startup_opportunity.opportunity_thesis.v1" ||
      opportunity.document.selected_solution_ref !== binding.selected_solution_ref ||
      solution?.schemaVersion !== "startup_opportunity.solution_hypothesis.v1"
    ) {
      errors.push(
        issue(
          "g3.consumer_lineage_mismatch",
          `${consumer.path}#/ai_bundle_binding`,
          "consumer binding must resolve the exact Opportunity and selected Solution",
        ),
      );
      continue;
    }
    const usesAi = solution.document.uses_ai === true;
    const mandatoryLineage = mandatory === undefined ? null : lineage(mandatory.document);
    const matchingMandatoryPresent =
      mandatory !== undefined &&
      mandatoryLineage !== null &&
      mandatory.document.run_id === consumer.document.run_id &&
      mandatoryLineage.subject_ref === binding.subject_ref &&
      mandatoryLineage.opportunity_ref === binding.subject_ref &&
      mandatoryLineage.selected_solution_ref === binding.selected_solution_ref &&
      mandatoryLineage.trigger_version === binding.trigger_version;
    if (
      consumer.schemaVersion === "startup_opportunity.opportunity_comparison.v1" &&
      consumer.document.opportunity_ref !== binding.subject_ref
    ) {
      errors.push(
        issue(
          "g3.consumer_lineage_mismatch",
          `${consumer.path}#/ai_bundle_binding/subject_ref`,
          "comparison binding subject must equal the compared Opportunity",
        ),
      );
    }
    if (!usesAi) {
      if (
        binding.status !== "not_required" ||
        binding.coverage_state !== "not_required" ||
        binding.conclusion_ceiling !== "not_required" ||
        binding.bundle_ref !== null ||
        binding.bundle_content_hash !== null ||
        typeof binding.not_required_reason !== "string"
      ) {
        errors.push(
          issue(
            "g3.non_ai_binding_invalid",
            `${consumer.path}#/ai_bundle_binding`,
            "a selected uses_ai=false Solution requires an explicit not_required binding",
          ),
        );
      }
      continue;
    }

    if (binding.status === "missing") {
      if (
        matchingMandatoryPresent ||
        binding.coverage_state !== "missing" ||
        binding.bundle_ref !== null ||
        binding.bundle_content_hash !== null ||
        binding.conclusion_ceiling === "prioritize_allowed" ||
        binding.conclusion_ceiling === "not_required" ||
        binding.not_required_reason !== null
      ) {
        errors.push(
          issue(
            "g3.missing_bundle_binding_invalid",
            `${consumer.path}#/ai_bundle_binding`,
            "a missing AI bundle requires exact bundle absence, null identity, and a degraded conclusion ceiling",
          ),
        );
      }
    } else if (binding.status === "bound") {
      const target = byPath.get(String(binding.bundle_ref));
      if (
        target?.schemaVersion !== "startup_opportunity.ai_mandatory_bundle.v1" ||
        binding.bundle_content_hash !==
          (target === undefined ? null : canonicalContentHash(target.document)) ||
        binding.coverage_state !== target?.document.bundle_status ||
        binding.conclusion_ceiling !== target?.document.conclusion_ceiling ||
        binding.not_required_reason !== null ||
        !strings(consumer.envelope?.input_refs).includes(String(binding.bundle_ref))
      ) {
        errors.push(
          issue(
            "g3.bound_bundle_identity_mismatch",
            `${consumer.path}#/ai_bundle_binding`,
            "bound consumer must bind the exact mandatory bundle ref, hash, status, ceiling, and input ref",
          ),
        );
      } else {
        const targetLineage = lineage(target.document);
        if (
          targetLineage === null ||
          target.document.run_id !== consumer.document.run_id ||
          targetLineage.subject_ref !== binding.subject_ref ||
          targetLineage.opportunity_ref !== binding.subject_ref ||
          targetLineage.selected_solution_ref !== binding.selected_solution_ref ||
          targetLineage.trigger_version !== binding.trigger_version
        ) {
          errors.push(
            issue(
              "g3.consumer_lineage_mismatch",
              `${consumer.path}#/ai_bundle_binding`,
              "consumer binding and mandatory bundle must share exact Run and trigger lineage",
            ),
          );
        }
      }
    } else {
      errors.push(
        issue(
          "g3.ai_binding_status_invalid",
          `${consumer.path}#/ai_bundle_binding/status`,
          "a selected uses_ai=true Solution requires bound or missing status",
        ),
      );
    }

    const degraded =
      binding.status === "missing" ||
      ["incomplete", "desk_research_only", "stale"].includes(String(binding.coverage_state)) ||
      (binding.status === "bound" && binding.conclusion_ceiling !== "prioritize_allowed");
    const actualDecision =
      consumer.schemaVersion === "startup_opportunity.opportunity_comparison.v1"
        ? consumer.document.recommendation_band
        : consumer.schemaVersion === "startup_opportunity.decision_recommendation.v1" ||
            consumer.schemaVersion === "startup_opportunity.decision_brief.discovery.current" ||
            consumer.schemaVersion === "startup_opportunity.discovery_report_view.v1"
          ? consumer.document.decision_tier
          : consumer.schemaVersion === "startup_opportunity.report.v1" &&
              isRecord(consumer.document.curated_judgment_context)
            ? consumer.document.curated_judgment_context.decision_tier
            : null;
    if (degraded && ["strong_candidate", "prioritize"].includes(String(actualDecision))) {
      errors.push(
        issue(
          "g3.consumer_conclusion_ceiling_violation",
          `${consumer.path}#/ai_bundle_binding/conclusion_ceiling`,
          "missing, incomplete, desk-only, stale, or specialized-input-limited AI coverage cannot support prioritize",
          { actualDecision },
        ),
      );
    }
  }
  return errors;
}

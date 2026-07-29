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

export interface AiBundleDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
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
  return errors;
}

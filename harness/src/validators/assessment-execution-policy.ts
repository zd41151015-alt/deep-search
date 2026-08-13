import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import { ASSESSMENT_EXECUTION_POLICY_PATH } from "../current-policy-paths.js";
import type { LoadedSchemaBundle } from "./schema-bundle.js";

export { ASSESSMENT_EXECUTION_POLICY_PATH };

export interface AssessmentExecutionPolicy extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.assessment_execution_policy.current";
  readonly policy_version: "1.0.0";
  readonly mandatory_reporting_dimensions: readonly string[];
  readonly default_lanes: readonly {
    readonly lane_key: string;
    readonly stage_kind: string;
    readonly unit_type: string;
    readonly reporting_dimensions: readonly string[];
  }[];
  readonly stage_order: readonly string[];
  readonly initial_lane_count: { readonly minimum: 4; readonly maximum: 5 };
  readonly followup: {
    readonly max_rounds: 2;
    readonly max_additions_per_dimension: 2;
    readonly gap_type: "decision_relevant_evidence_gap";
    readonly requires_plan_revision: true;
    readonly information_gain_gate: {
      readonly eligible_gap_resolution_classes: readonly string[];
      readonly eligible_availability: readonly string[];
      readonly eligible_decision_changes: readonly string[];
      readonly eligible_overlap_levels: readonly string[];
      readonly route_class_bindings: readonly {
        readonly acquisition_route: string;
        readonly gap_resolution_class: string;
      }[];
    };
    readonly dimension_unit_types: readonly {
      readonly dimension_id: string;
      readonly unit_type: string;
    }[];
  };
}

export async function loadAssessmentExecutionPolicy(
  root: string,
  bundle: LoadedSchemaBundle,
): Promise<AssessmentExecutionPolicy> {
  const value = JSON.parse(
    await readFile(path.join(root, ASSESSMENT_EXECUTION_POLICY_PATH), "utf8"),
  ) as unknown;
  const validator = bundle.validators.get(
    "startup_opportunity.assessment_execution_policy.current",
  );
  if (!validator?.(value)) {
    throw new StoreError(
      "policy.assessment_execution_invalid",
      "assessment execution policy is invalid",
      {
        errors: validator?.errors ?? [],
        schemaInstalled: validator !== undefined,
      },
    );
  }
  const policy = value as AssessmentExecutionPolicy;
  const dimensions = policy.mandatory_reporting_dimensions;
  const laneDimensions = policy.default_lanes.flatMap((lane) => lane.reporting_dimensions);
  const followupDimensions = policy.followup.dimension_unit_types.map((rule) => rule.dimension_id);
  if (
    new Set(dimensions).size !== 10 ||
    canonicalJson([...laneDimensions].sort()) !== canonicalJson([...dimensions].sort()) ||
    canonicalJson([...followupDimensions].sort()) !== canonicalJson([...dimensions].sort())
  ) {
    throw new StoreError(
      "policy.assessment_execution_invalid",
      "assessment execution policy dimension coverage is not closed",
    );
  }
  return policy;
}

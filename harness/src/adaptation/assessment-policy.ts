import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import { createArtifactValidator } from "../validators/artifact-validator.js";
import { isRecord } from "./contracts.js";

export const ASSESSMENT_ADAPTATION_POLICY_PATH =
  "harness/policies/assessment-adaptation.v1.json" as const;

export interface AssessmentAdaptationPolicy extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.assessment_adaptation_policy.v1";
  readonly policy_version: "1.0.0";
  readonly compatible_schema_bundle_versions: readonly ["18.0.0"];
  readonly allowed_actions: readonly ["add_unit", "stop_followup"];
  readonly add_unit_rules: readonly {
    readonly gap_type: string;
    readonly dimension_id: string;
    readonly unit_type: string;
  }[];
  readonly stop_followup_rules: {
    readonly gap_types: readonly string[];
    readonly stop_signals: readonly string[];
    readonly creates_plan_revision: false;
  };
}

const EXPECTED_ADD_UNIT_RULES = [
  {
    gap_type: "buyer_evidence_insufficient",
    dimension_id: "buyer_language_and_willingness_to_pay",
    unit_type: "buyer_language",
  },
  {
    gap_type: "acquisition_evidence_insufficient",
    dimension_id: "acquisition_and_distribution",
    unit_type: "acquisition",
  },
] as const;

export async function loadAssessmentAdaptationPolicy(
  root = process.cwd(),
): Promise<AssessmentAdaptationPolicy> {
  const validator = await createArtifactValidator(root);
  const value = JSON.parse(
    await readFile(path.join(root, ASSESSMENT_ADAPTATION_POLICY_PATH), "utf8"),
  ) as unknown;
  const validation = validator.validateDocument(value, ASSESSMENT_ADAPTATION_POLICY_PATH);
  if (!validation.valid || !isRecord(value)) {
    throw new StoreError("policy.assessment_adaptation_invalid", "assessment policy is invalid", {
      errors: validation.errors,
    });
  }
  const policy = value as unknown as AssessmentAdaptationPolicy;
  if (
    canonicalJson(policy.add_unit_rules) !== canonicalJson(EXPECTED_ADD_UNIT_RULES) ||
    canonicalJson(policy.allowed_actions) !== canonicalJson(["add_unit", "stop_followup"])
  ) {
    throw new StoreError(
      "policy.assessment_adaptation_invalid",
      "assessment policy tuples differ from the published closed contract",
    );
  }
  return policy;
}

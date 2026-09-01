import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import { ASSESSMENT_ADAPTATION_POLICY_PATH } from "../current-policy-paths.js";
import { createArtifactValidator } from "../validators/artifact-validator.js";
import { isRecord } from "./contracts.js";

export { ASSESSMENT_ADAPTATION_POLICY_PATH };

export interface AssessmentAdaptationPolicy extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.assessment_adaptation_policy.current";
  readonly policy_version: "1.0.0";
  readonly allowed_actions: readonly [
    "add_unit",
    "reconcile_scope",
    "stop_followup",
    "record_runtime_failure",
    "complete_research",
    "cancel_research",
  ];
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
    canonicalJson(policy.allowed_actions) !==
      canonicalJson([
        "add_unit",
        "reconcile_scope",
        "stop_followup",
        "record_runtime_failure",
        "complete_research",
        "cancel_research",
      ])
  ) {
    throw new StoreError(
      "policy.assessment_adaptation_invalid",
      "assessment policy tuples differ from the published closed contract",
    );
  }
  return policy;
}

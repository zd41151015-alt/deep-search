import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedSchemaBundle } from "./schema-bundle.js";

export const ASSESSMENT_REPORTING_POLICY_PATH =
  "harness/policies/assessment-reporting.v1.json" as const;

export const REQUIRED_HARD_GATES = [
  "target_user_and_jtbd",
  "baseline_delta",
  "buyer",
  "acquisition",
  "business_engine",
  "delivery_feasibility",
  "compliance_boundary",
  "counter_evidence",
  "evidence_quality",
  "source_independence",
  "freshness",
  "ai_mandatory_bundle",
] as const;

export const REQUIRED_CHALLENGE_DIMENSIONS = [
  "strong_alternatives",
  "non_consumption",
  "buyer",
  "acquisition",
  "compliance",
  "migration",
  "service_burden",
  "ai_generic_platform_open_source_baseline",
  "thesis_killing_opposition",
  "conclusion_flipping_gap",
  "assessment_challenge",
] as const;

export const REQUIRED_REPORT_CHECKS = [
  "result",
  "refs",
  "hashes",
  "freshness",
  "limitations",
  "counter_evidence",
  "decision_meaning",
  "external_action_boundary",
  "new_conclusions",
  "market_validation_language",
  "probability_language",
] as const;

export interface AssessmentReportingPolicy extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.assessment_reporting_policy.v1";
  readonly policy_id: "startup_opportunity.g1_4_assessment_reporting";
  readonly policy_version: "1.0.0";
  readonly decisive_hard_gates: readonly string[];
  readonly forbidden_report_expressions: readonly string[];
  readonly generation_order: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadAssessmentReportingPolicy(
  root: string,
  bundle: LoadedSchemaBundle,
): Promise<AssessmentReportingPolicy> {
  const value = JSON.parse(
    await readFile(path.join(root, ASSESSMENT_REPORTING_POLICY_PATH), "utf8"),
  ) as unknown;
  const validator = bundle.validators.get("startup_opportunity.assessment_reporting_policy.v1");
  if ((validator !== undefined && !validator(value)) || !isRecord(value)) {
    throw new Error(
      `assessment reporting policy is invalid: ${JSON.stringify(validator?.errors ?? [])}`,
    );
  }
  return value as AssessmentReportingPolicy;
}

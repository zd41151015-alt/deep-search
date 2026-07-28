import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import type { LoadedSchemaBundle } from "./schema-bundle.js";

export const DISCOVERY_EVALUATION_POLICY_PATH =
  "harness/policies/discovery-evaluation.v1.json" as const;

export interface DiscoveryEvaluationPolicy extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.discovery_evaluation_policy.v1";
  readonly policy_id: "startup_opportunity.g2_4_evaluation";
  readonly policy_version: "1.0.0";
  readonly schema_bundle_version: "11.0.0";
  readonly eligible_branch_statuses: readonly string[];
  readonly excluded_branch_statuses: readonly string[];
  readonly required_hard_gates: readonly string[];
  readonly required_comparison_panels: readonly string[];
  readonly recommendation_ceiling: Readonly<Record<string, string>>;
  readonly publication_order: readonly string[];
  readonly reporting_contract: Readonly<Record<string, unknown>>;
  readonly execution_boundary: Readonly<Record<string, unknown>>;
}

export const REQUIRED_HARD_GATES = [
  "user_jtbd_entry_scene",
  "baseline_delta",
  "buyer_purchase",
  "business_engine",
  "source_independence",
  "generation_evaluation_separation",
  "opposing_evidence",
  "compliance_boundary",
  "ai_mandatory_bundle",
  "ai_baseline_gap",
  "ai_reliability",
  "data_rights",
  "unit_economics",
] as const;

export const REQUIRED_COMPARISON_PANELS = [
  "demand_and_market",
  "solution_and_business",
  "evidence_strength",
  "team_fit_and_learning",
] as const;

export const REQUIRED_REPORT_CONSISTENCY_DIMENSIONS = [
  "decision",
  "refs",
  "hashes",
  "freshness",
  "limitations",
  "counter_evidence",
  "partial_order",
  "panel_independence",
  "evidence_ceiling",
  "external_action_boundary",
  "new_conclusions",
  "market_validation_language",
  "probability_language",
] as const;

const PUBLICATION_ORDER = [
  "enrichment_task",
  "typed_material",
  "enrichment_branch",
  "enrichment_fan_in",
  "domain_enrichment",
  "opportunity_comparison",
  "sensitivity",
  "portfolio",
  "decision_recommendation",
  "traceability",
  "report",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadDiscoveryEvaluationPolicy(
  root: string,
  bundle: LoadedSchemaBundle,
  relativePath = DISCOVERY_EVALUATION_POLICY_PATH,
): Promise<DiscoveryEvaluationPolicy> {
  const value = JSON.parse(await readFile(path.join(root, relativePath), "utf8")) as unknown;
  const validator = bundle.validators.get("startup_opportunity.discovery_evaluation_policy.v1");
  if ((validator !== undefined && !validator(value)) || !isRecord(value)) {
    throw new StoreError(
      "discovery_evaluation_policy.invalid",
      "discovery evaluation policy is not valid for the selected schema bundle",
      { errors: validator?.errors ?? [] },
    );
  }
  const policy = value as DiscoveryEvaluationPolicy;
  if (
    canonicalJson(policy.eligible_branch_statuses) !==
      canonicalJson(["completed", "partial", "insufficient_evidence"]) ||
    canonicalJson(policy.excluded_branch_statuses) !==
      canonicalJson(["failed", "ignored_late", "superseded"]) ||
    canonicalJson(policy.required_hard_gates) !== canonicalJson(REQUIRED_HARD_GATES) ||
    canonicalJson(policy.required_comparison_panels) !==
      canonicalJson(REQUIRED_COMPARISON_PANELS) ||
    canonicalJson(policy.publication_order) !== canonicalJson(PUBLICATION_ORDER) ||
    policy.execution_boundary.harness_generated_research !== false ||
    policy.execution_boundary.harness_generated_judgment !== false ||
    policy.execution_boundary.publication_implies_validation !== false ||
    policy.reporting_contract.global_score_forbidden !== true ||
    canonicalJson(policy.reporting_contract.consistency_dimensions) !==
      canonicalJson(REQUIRED_REPORT_CONSISTENCY_DIMENSIONS) ||
    policy.reporting_contract.market_validation_claim_forbidden !== true
  ) {
    throw new StoreError(
      "discovery_evaluation_policy.invalid",
      "discovery evaluation policy differs from the closed G2.4 contract",
    );
  }
  return policy;
}

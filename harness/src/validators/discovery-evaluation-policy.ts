import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import {
  REPORT_FORBIDDEN_RULE_IDS,
  REPORT_SCAN_CONTRACT_VERSION,
  REPORT_SCAN_SURFACES,
} from "../reporting/report-consistency.js";
import type { LoadedSchemaBundle } from "./schema-bundle.js";

export const DISCOVERY_EVALUATION_POLICY_PATH =
  "harness/policies/discovery-evaluation.v2.json" as const;
export const LEGACY_DISCOVERY_EVALUATION_POLICY_PATH =
  "harness/policies/discovery-evaluation.v1.json" as const;

interface DiscoveryEvaluationPolicyBase extends Record<string, unknown> {
  readonly policy_id: "startup_opportunity.g2_4_evaluation";
  readonly eligible_branch_statuses: readonly string[];
  readonly excluded_branch_statuses: readonly string[];
  readonly required_hard_gates: readonly string[];
  readonly required_comparison_panels: readonly string[];
  readonly recommendation_ceiling: Readonly<Record<string, string>>;
  readonly publication_order: readonly string[];
  readonly reporting_contract: Readonly<Record<string, unknown>>;
  readonly execution_boundary: Readonly<Record<string, unknown>>;
}

export interface DiscoveryEvaluationPolicyV1 extends DiscoveryEvaluationPolicyBase {
  readonly schema_version: "startup_opportunity.discovery_evaluation_policy.v1";
  readonly policy_version: "1.0.0";
  readonly schema_bundle_version: "11.0.0";
}

export interface DiscoveryEvaluationPolicyV2 extends DiscoveryEvaluationPolicyBase {
  readonly schema_version: "startup_opportunity.discovery_evaluation_policy.v2";
  readonly policy_version: "2.0.0";
  readonly schema_bundle_version: "12.0.0";
  readonly ai_solution_gate_contract: Readonly<Record<string, unknown>>;
  readonly decision_tier_ceiling: Readonly<Record<string, unknown>>;
}

export type DiscoveryEvaluationPolicy = DiscoveryEvaluationPolicyV1 | DiscoveryEvaluationPolicyV2;

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
  "global_score_language",
] as const;

export const LEGACY_REPORT_CONSISTENCY_DIMENSIONS = REQUIRED_REPORT_CONSISTENCY_DIMENSIONS.slice(
  0,
  -1,
);

export const DECISION_TIER_ORDER = [
  "reject",
  "insufficient_evidence",
  "watch",
  "investigate_further",
  "prioritize",
] as const;

export const FIRST_BET_READY_REQUIREMENTS = [
  "portfolio_first_bet_exact",
  "comparison_strong_candidate",
  "hard_gates_eligible",
  "fan_in_strong_candidate",
  "panels_sufficient",
  "ai_bundle_complete_or_not_required",
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
  relativePath: string = DISCOVERY_EVALUATION_POLICY_PATH,
): Promise<DiscoveryEvaluationPolicy> {
  const value = JSON.parse(await readFile(path.join(root, relativePath), "utf8")) as unknown;
  const expectedSchemaVersion =
    relativePath === LEGACY_DISCOVERY_EVALUATION_POLICY_PATH
      ? "startup_opportunity.discovery_evaluation_policy.v1"
      : "startup_opportunity.discovery_evaluation_policy.v2";
  const validator = bundle.validators.get(expectedSchemaVersion);
  if ((validator !== undefined && !validator(value)) || !isRecord(value)) {
    throw new StoreError(
      "discovery_evaluation_policy.invalid",
      "discovery evaluation policy is not valid for the selected schema bundle",
      { errors: validator?.errors ?? [] },
    );
  }
  const policy = value as DiscoveryEvaluationPolicy;
  const commonInvalid =
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
    policy.reporting_contract.market_validation_claim_forbidden !== true;
  const repairedInvalid =
    policy.schema_version === "startup_opportunity.discovery_evaluation_policy.v2" &&
    (policy.ai_solution_gate_contract.selected_solution_field !== "selected_solution_ref" ||
      policy.ai_solution_gate_contract.ai_usage_field !== "uses_ai" ||
      policy.ai_solution_gate_contract.mandatory_gate_id !== "ai_mandatory_bundle" ||
      policy.ai_solution_gate_contract.missing_bundle_status !== "insufficient_evidence" ||
      policy.ai_solution_gate_contract.missing_bundle_decision_tier_ceiling !==
        "investigate_further" ||
      policy.ai_solution_gate_contract.g3_bundle_generated_by_g2 !== false ||
      canonicalJson(policy.decision_tier_ceiling.tier_order) !==
        canonicalJson(DECISION_TIER_ORDER) ||
      policy.decision_tier_ceiling.no_first_bet_ceiling !== "investigate_further" ||
      canonicalJson(policy.decision_tier_ceiling.first_bet_ready_requirements) !==
        canonicalJson(FIRST_BET_READY_REQUIREMENTS) ||
      policy.decision_tier_ceiling.mixed_inputs_use_strictest_ceiling !== true ||
      policy.execution_boundary.harness_generated_research !== false ||
      policy.execution_boundary.harness_generated_judgment !== false ||
      policy.execution_boundary.publication_implies_validation !== false ||
      policy.reporting_contract.global_score_forbidden !== true ||
      canonicalJson(policy.reporting_contract.consistency_dimensions) !==
        canonicalJson(REQUIRED_REPORT_CONSISTENCY_DIMENSIONS) ||
      policy.reporting_contract.market_validation_claim_forbidden !== true ||
      policy.reporting_contract.scan_contract_version !== REPORT_SCAN_CONTRACT_VERSION ||
      canonicalJson(policy.reporting_contract.scan_surfaces) !==
        canonicalJson(REPORT_SCAN_SURFACES) ||
      canonicalJson(policy.reporting_contract.forbidden_rule_ids) !==
        canonicalJson(REPORT_FORBIDDEN_RULE_IDS));
  const legacyInvalid =
    policy.schema_version === "startup_opportunity.discovery_evaluation_policy.v1" &&
    canonicalJson(policy.reporting_contract.consistency_dimensions) !==
      canonicalJson(LEGACY_REPORT_CONSISTENCY_DIMENSIONS);
  if (commonInvalid || repairedInvalid || legacyInvalid) {
    throw new StoreError(
      "discovery_evaluation_policy.invalid",
      "discovery evaluation policy differs from the closed G2.4 contract",
    );
  }
  return policy;
}

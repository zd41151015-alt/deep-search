import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import { DISCOVERY_SYNTHESIS_POLICY_PATH } from "../current-policy-paths.js";
import type { LoadedSchemaBundle } from "./schema-bundle.js";

export { DISCOVERY_SYNTHESIS_POLICY_PATH };

export interface DiscoverySynthesisPolicy extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.discovery_synthesis_policy.current";
  readonly policy_id: "startup_opportunity.g2_3_synthesis";
  readonly policy_version: "1.0.0";
  readonly artifact_paths: Readonly<Record<string, string>>;
  readonly kind_target_map: Readonly<Record<string, string>>;
  readonly publication_order: readonly string[];
  readonly source_separation: Readonly<Record<string, boolean>>;
  readonly solution_exploration_contract: Readonly<Record<string, unknown>>;
  readonly freeze_contract: Readonly<Record<string, unknown>>;
  readonly merge_contract: Readonly<Record<string, unknown>>;
  readonly execution_boundary: Readonly<Record<string, unknown>>;
}

const EXPECTED_KIND_TARGET_MAP = {
  demand_seed: "startup_opportunity.demand_thesis.v1",
  baseline_seed: "startup_opportunity.baseline_option.v1",
  solution_seed: "startup_opportunity.solution_hypothesis.v1",
} as const;

const EXPECTED_ORDER = [
  "conversion_and_formal_target",
  "demand_thesis",
  "baseline_option",
  "solution_hypothesis",
  "solution_evaluation",
  "opportunity_thesis",
  "thesis_evaluation_snapshot",
  "merge_result",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadDiscoverySynthesisPolicy(
  root: string,
  bundle: LoadedSchemaBundle,
): Promise<DiscoverySynthesisPolicy> {
  const value = JSON.parse(
    await readFile(path.join(root, DISCOVERY_SYNTHESIS_POLICY_PATH), "utf8"),
  ) as unknown;
  const validator = bundle.validators.get("startup_opportunity.discovery_synthesis_policy.current");
  if ((validator !== undefined && !validator(value)) || !isRecord(value)) {
    throw new StoreError(
      "discovery_synthesis_policy.invalid",
      "discovery synthesis policy is not valid for the selected schema bundle",
      { errors: validator?.errors ?? [] },
    );
  }
  const policy = value as DiscoverySynthesisPolicy;
  if (
    canonicalJson(policy.kind_target_map) !== canonicalJson(EXPECTED_KIND_TARGET_MAP) ||
    canonicalJson(policy.publication_order) !== canonicalJson(EXPECTED_ORDER) ||
    policy.source_separation.generation_and_evaluation_distinct !== true ||
    policy.source_separation.overlap_requires_disclosure !== true ||
    canonicalJson(policy.solution_exploration_contract.statuses) !==
      canonicalJson([
        "compared_multiple_formal_solutions",
        "explored_no_other_formal_solution",
        "not_yet_explored",
        "insufficient_evidence",
        "not_applicable",
      ]) ||
    policy.solution_exploration_contract.status_is_agent_declared !== true ||
    policy.solution_exploration_contract.harness_infers_status_from_solution_count !== false ||
    policy.solution_exploration_contract.compared_requires_multiple_and_closed_baselines !== true ||
    policy.solution_exploration_contract.non_compared_selection_posture !==
      "provisional_implementation" ||
    policy.solution_exploration_contract.automatic_gap_or_unit_creation !== false ||
    policy.freeze_contract.revision_policy !== "new_immutable_snapshot_revision_required" ||
    policy.merge_contract.all_frozen_theses_classified_once !== true ||
    policy.merge_contract.title_similarity_only_forbidden !== true ||
    policy.execution_boundary.explicit_artifacts_only !== true ||
    policy.execution_boundary.harness_synthesizes_semantics !== false ||
    policy.execution_boundary.publication_implies_validation !== false
  ) {
    throw new StoreError(
      "discovery_synthesis_policy.invalid",
      "discovery synthesis policy differs from the closed G2.3 contract",
    );
  }
  return policy;
}

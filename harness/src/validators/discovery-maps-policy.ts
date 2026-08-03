import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import type { LoadedSchemaBundle } from "./schema-bundle.js";

export const DISCOVERY_MAPS_POLICY_PATH = "harness/policies/discovery-maps.v1.json" as const;

export type DiscoveryProfile = "general" | "industry_first" | "ai_first" | "hybrid";

export interface DiscoveryProfileRule {
  readonly required_seed_families: readonly string[];
  readonly ai_boundary_requirement: "optional" | "required_as_solution_option";
}

export interface DiscoveryMapsPolicy extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.discovery_maps_policy.v1";
  readonly policy_id: "startup_opportunity.g2_1_discovery_maps";
  readonly policy_version: "1.0.0";
  readonly artifact_contracts: Readonly<Record<string, string>>;
  readonly artifact_paths: {
    readonly seed_probe: string;
    readonly opportunity_space_map: string;
    readonly solution_space_map: string;
  };
  readonly profiles: Readonly<Record<DiscoveryProfile, DiscoveryProfileRule>>;
  readonly plan_contract: {
    readonly mode: "opportunity_discovery";
    readonly phase: "discovery";
    readonly seed_independent_unit_types: readonly string[];
    readonly counterfactual_unit_type: "counter_evidence";
    readonly required_exploration_flags: readonly string[];
    readonly scope_only_input: true;
  };
  readonly required_solution_classes: readonly string[];
  readonly ai_boundary_fields: readonly string[];
  readonly source_boundary: Readonly<Record<string, boolean>>;
  readonly forbidden_formal_artifact_types: readonly string[];
}

export interface LoadedDiscoveryMapsPolicy {
  readonly document: DiscoveryMapsPolicy;
  readonly contentHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EXPECTED_PROFILE_RULES = {
  general: {
    required_seed_families: ["scenario", "problem"],
    ai_boundary_requirement: "optional",
  },
  industry_first: {
    required_seed_families: ["direction", "audience", "problem"],
    ai_boundary_requirement: "optional",
  },
  ai_first: {
    required_seed_families: ["problem", "capability", "model_ecosystem"],
    ai_boundary_requirement: "required_as_solution_option",
  },
  hybrid: {
    required_seed_families: ["direction", "problem", "capability", "model_ecosystem"],
    ai_boundary_requirement: "required_as_solution_option",
  },
} as const;

const EXPECTED_SOLUTION_CLASSES = [
  "ordinary_software",
  "platform_native",
  "human_or_service_assisted",
  "native_app",
  "mini_program",
  "mobile_web_or_pwa",
  "hybrid_app",
  "ai_assisted",
  "status_quo",
] as const;

const EXPECTED_AI_BOUNDARY_FIELDS = [
  "capability_frontier",
  "failure_modes",
  "human_review_boundaries",
  "data_and_evaluation_requirements",
  "provider_landscape",
  "open_source_landscape",
  "capability_half_life",
] as const;

export async function loadDiscoveryMapsPolicy(
  root: string,
  bundle: LoadedSchemaBundle,
): Promise<LoadedDiscoveryMapsPolicy> {
  const value = JSON.parse(
    await readFile(path.join(root, DISCOVERY_MAPS_POLICY_PATH), "utf8"),
  ) as unknown;
  const validator = bundle.validators.get("startup_opportunity.discovery_maps_policy.v1");
  if ((validator !== undefined && !validator(value)) || !isRecord(value)) {
    throw new StoreError(
      "discovery_policy.invalid",
      "discovery maps policy is not valid for the selected schema bundle",
      { errors: validator?.errors ?? [] },
    );
  }
  const policy = value as DiscoveryMapsPolicy;
  if (
    canonicalJson(policy.profiles) !== canonicalJson(EXPECTED_PROFILE_RULES) ||
    canonicalJson(policy.required_solution_classes) !== canonicalJson(EXPECTED_SOLUTION_CLASSES) ||
    canonicalJson(policy.ai_boundary_fields) !== canonicalJson(EXPECTED_AI_BOUNDARY_FIELDS)
  ) {
    throw new StoreError(
      "discovery_policy.invalid",
      "discovery maps policy differs from the published closed profile or breadth contract",
    );
  }
  return { document: policy, contentHash: canonicalContentHash(policy) };
}

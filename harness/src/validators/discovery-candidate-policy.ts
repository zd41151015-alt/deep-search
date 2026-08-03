import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import type { LoadedSchemaBundle } from "./schema-bundle.js";

export const DISCOVERY_CANDIDATE_POLICY_PATH =
  "harness/policies/discovery-candidates.v1.json" as const;

export type CandidateKind = "demand_seed" | "baseline_seed" | "solution_seed";

export interface CandidateKindRule {
  readonly map_schema_version:
    | "startup_opportunity.opportunity_space_map.v1"
    | "startup_opportunity.solution_space_map.v1";
  readonly allowed_fragment_collections: readonly string[];
  readonly fragment_id_field: "hypothesis_id" | "candidate_id";
  readonly formal_target_schema:
    | "startup_opportunity.demand_thesis.v1"
    | "startup_opportunity.baseline_option.v1"
    | "startup_opportunity.solution_hypothesis.v1";
}

export interface DiscoveryCandidatePolicy extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.discovery_candidate_policy.v1";
  readonly policy_id: "startup_opportunity.g2_2_pre_thesis_candidate_contract";
  readonly policy_version: "1.0.0";
  readonly artifact_contracts: Readonly<Record<string, string>>;
  readonly candidate_kinds: Readonly<Record<CandidateKind, CandidateKindRule>>;
  readonly ownership: Readonly<Record<string, string>>;
  readonly revision_contract: {
    readonly append_only_ref_fields: readonly string[];
    readonly mutable_enrichment_fields: readonly string[];
    readonly new_material_requires_exact_source_candidate_task_binding: true;
    readonly new_judgment_subject_must_equal_source_candidate: true;
  };
  readonly source_separation_contract: Readonly<Record<string, boolean>>;
  readonly disposition_contract: Readonly<Record<string, unknown>>;
  readonly fan_in_contract: {
    readonly eligible_lane_statuses: readonly string[];
    readonly excluded_lane_statuses: readonly string[];
    readonly judgment_subject_matches_source_candidate_revision: true;
    readonly judgment_subject_must_ancestor_final_candidate: true;
    readonly judgments_must_come_from_supporting_lane_disposition: true;
    readonly top_level_judgment_refs_exact_disposition_closure: true;
  };
  readonly publication_contract: Readonly<Record<string, unknown>>;
  readonly manifest_projection_contract: Readonly<Record<string, unknown>>;
}

const EXPECTED_KIND_RULES: Readonly<Record<CandidateKind, CandidateKindRule>> = {
  demand_seed: {
    map_schema_version: "startup_opportunity.opportunity_space_map.v1",
    allowed_fragment_collections: [
      "/initial_demand_hypotheses",
      "/jobs_to_be_done",
      "/workflow_friction_points",
      "/non_consumption",
    ],
    fragment_id_field: "hypothesis_id",
    formal_target_schema: "startup_opportunity.demand_thesis.v1",
  },
  baseline_seed: {
    map_schema_version: "startup_opportunity.opportunity_space_map.v1",
    allowed_fragment_collections: ["/baseline_options", "/current_alternatives"],
    fragment_id_field: "hypothesis_id",
    formal_target_schema: "startup_opportunity.baseline_option.v1",
  },
  solution_seed: {
    map_schema_version: "startup_opportunity.solution_space_map.v1",
    allowed_fragment_collections: ["/solution_candidates"],
    fragment_id_field: "candidate_id",
    formal_target_schema: "startup_opportunity.solution_hypothesis.v1",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadDiscoveryCandidatePolicy(
  root: string,
  bundle: LoadedSchemaBundle,
): Promise<DiscoveryCandidatePolicy> {
  const value = JSON.parse(
    await readFile(path.join(root, DISCOVERY_CANDIDATE_POLICY_PATH), "utf8"),
  ) as unknown;
  const validator = bundle.validators.get("startup_opportunity.discovery_candidate_policy.v1");
  if ((validator !== undefined && !validator(value)) || !isRecord(value)) {
    throw new StoreError(
      "discovery_candidate_policy.invalid",
      "discovery candidate policy is not valid for the selected schema bundle",
      { errors: validator?.errors ?? [] },
    );
  }
  const policy = value as DiscoveryCandidatePolicy;
  if (
    canonicalJson(policy.candidate_kinds) !== canonicalJson(EXPECTED_KIND_RULES) ||
    canonicalJson(policy.fan_in_contract.eligible_lane_statuses) !==
      canonicalJson(["completed", "partial", "insufficient_evidence"]) ||
    canonicalJson(policy.fan_in_contract.excluded_lane_statuses) !==
      canonicalJson(["failed", "ignored_late", "superseded"]) ||
    policy.revision_contract.new_material_requires_exact_source_candidate_task_binding !== true ||
    policy.revision_contract.new_judgment_subject_must_equal_source_candidate !== true ||
    policy.disposition_contract.judgment_subject_equals_candidate_ref !== true ||
    policy.disposition_contract.judgment_task_matches_lane_task !== true ||
    policy.fan_in_contract.judgment_subject_matches_source_candidate_revision !== true ||
    policy.fan_in_contract.judgment_subject_must_ancestor_final_candidate !== true ||
    policy.fan_in_contract.judgments_must_come_from_supporting_lane_disposition !== true ||
    policy.fan_in_contract.top_level_judgment_refs_exact_disposition_closure !== true ||
    policy.publication_contract.envelope_schema_version !==
      "startup_opportunity.artifact_envelope.current" ||
    policy.publication_contract.document_bundle_schema_version !==
      "startup_opportunity.document_bundle.current" ||
    policy.manifest_projection_contract.publication_updates_manifest !== true ||
    policy.manifest_projection_contract.late_or_superseded_can_enter_current_refs !== false
  ) {
    throw new StoreError(
      "discovery_candidate_policy.invalid",
      "discovery candidate policy differs from the closed Scheme A contract",
    );
  }
  return policy;
}

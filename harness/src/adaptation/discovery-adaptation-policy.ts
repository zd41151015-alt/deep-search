import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import { createArtifactValidator } from "../validators/artifact-validator.js";
import { isRecord } from "./contracts.js";

export const DISCOVERY_ADAPTATION_BINDING_POLICY_PATH =
  "harness/policies/discovery-adaptation-binding.v1.json" as const;

export interface DiscoveryAdaptationBindingPolicy extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.discovery_adaptation_binding_policy.v1";
  readonly policy_id: "startup_opportunity.g2_candidate_pre_kill_adaptation";
  readonly policy_version: "1.0.0";
  readonly trigger_gap_type: "candidate_pre_killed";
  readonly allowed_action: "skip_unit";
  readonly candidate_ref_pattern: string;
  readonly target_binding: "exact_gap_subject_in_unit_input_refs";
  readonly shared_unit_rule: "retain_or_supersede_never_skip";
  readonly execution_boundary: Readonly<Record<string, unknown>>;
}

const EXPECTED_CANDIDATE_PATTERN =
  "^artifacts/discovery/candidates/[A-Za-z0-9][A-Za-z0-9._-]*\\.r[1-9][0-9]*\\.json$";

export async function loadDiscoveryAdaptationBindingPolicy(
  root = process.cwd(),
): Promise<DiscoveryAdaptationBindingPolicy> {
  const value = JSON.parse(
    await readFile(path.join(root, DISCOVERY_ADAPTATION_BINDING_POLICY_PATH), "utf8"),
  ) as unknown;
  const validation = (await createArtifactValidator(root)).validateDocument(
    value,
    DISCOVERY_ADAPTATION_BINDING_POLICY_PATH,
  );
  if (!validation.valid || !isRecord(value)) {
    throw new StoreError(
      "policy.discovery_adaptation_binding_invalid",
      "discovery adaptation binding policy is invalid",
      { errors: validation.errors },
    );
  }
  const policy = value as DiscoveryAdaptationBindingPolicy;
  if (
    policy.candidate_ref_pattern !== EXPECTED_CANDIDATE_PATTERN ||
    policy.target_binding !== "exact_gap_subject_in_unit_input_refs" ||
    policy.shared_unit_rule !== "retain_or_supersede_never_skip" ||
    canonicalJson(policy.execution_boundary) !==
      canonicalJson({
        harness_dispatches_agent: false,
        harness_executes_research: false,
        apply_revalidates: true,
      })
  ) {
    throw new StoreError(
      "policy.discovery_adaptation_binding_invalid",
      "discovery adaptation binding policy differs from the closed contract",
    );
  }
  return policy;
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalContentHash } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import {
  ADAPTATION_POLICY_PATH,
  AI_TRIGGER_SOURCE_POLICY_PATH,
  PLAN_REVISION_APPLY_POLICY_PATH,
} from "../current-policy-paths.js";
import { createArtifactValidator } from "../validators/artifact-validator.js";
import { isRecord } from "./contracts.js";

export { PLAN_REVISION_APPLY_POLICY_PATH };

export interface PlanRevisionApplyPolicy extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.plan_revision_apply_policy.current";
  readonly policy_version: "1.0.0";
  readonly operation_identity: "canonical_parent_plan_hash_and_sorted_adaptation_refs.v1";
  readonly new_unit_placement: {
    readonly add_unit: "single_new_followup_wave_after_all_current_leaf_waves";
    readonly retry_unit: "same_wave_as_target";
    readonly supersede_unit: "same_wave_as_target";
  };
  readonly non_revision_actions: readonly [
    "continue_existing_plan",
    "request_clarification",
    "stop_followup",
    "record_runtime_failure",
    "terminate_insufficient_evidence",
  ];
  readonly late_artifact_rule: "persist_and_index_only_as_ignored_late";
  readonly partial_retry: "fail_closed";
}

export async function loadPlanRevisionApplyPolicy(
  root = process.cwd(),
): Promise<PlanRevisionApplyPolicy> {
  const validator = await createArtifactValidator(root);
  const policy = JSON.parse(
    await readFile(path.join(root, PLAN_REVISION_APPLY_POLICY_PATH), "utf8"),
  ) as unknown;
  const validation = validator.validateDocument(policy, PLAN_REVISION_APPLY_POLICY_PATH);
  if (!validation.valid || !isRecord(policy)) {
    throw new StoreError("policy.apply_invalid", "Plan Revision apply policy is invalid", {
      errors: validation.errors,
    });
  }
  const adaptationPolicy = JSON.parse(
    await readFile(path.join(root, ADAPTATION_POLICY_PATH), "utf8"),
  ) as unknown;
  const sourcePolicy = JSON.parse(
    await readFile(path.join(root, AI_TRIGGER_SOURCE_POLICY_PATH), "utf8"),
  ) as unknown;
  if (!isRecord(adaptationPolicy) || !isRecord(sourcePolicy)) {
    throw new StoreError("policy.base_invalid", "base planning policies are not objects");
  }
  const bindings = Array.isArray(policy.base_policy_bindings)
    ? policy.base_policy_bindings.filter(isRecord)
    : [];
  for (const [policyRef, document] of [
    [ADAPTATION_POLICY_PATH, adaptationPolicy],
    [AI_TRIGGER_SOURCE_POLICY_PATH, sourcePolicy],
  ] as const) {
    const binding = bindings.find((entry) => entry.policy_ref === policyRef);
    if (
      binding === undefined ||
      binding.schema_version !== document.schema_version ||
      binding.policy_version !== document.policy_version ||
      binding.content_hash !== canonicalContentHash(document)
    ) {
      throw new StoreError(
        "policy.base_binding_mismatch",
        "Plan Revision apply policy does not bind the installed base policy",
        { policyRef },
      );
    }
  }
  return policy as PlanRevisionApplyPolicy;
}

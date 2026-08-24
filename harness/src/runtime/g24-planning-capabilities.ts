import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import {
  ADAPTATION_POLICY_PATH,
  DISCOVERY_EVALUATION_POLICY_PATH,
} from "../current-policy-paths.js";
import { REQUIRED_HARD_GATES } from "../validators/discovery-evaluation-policy.js";
import {
  DISCOVERY_COUNTER_EVIDENCE_MINIMUM,
  DISCOVERY_COUNTER_EVIDENCE_UNIT_TYPES,
  G24_FAN_IN_HARD_GATE_CARDINALITY,
} from "../validators/g24-planning-rules.js";

const ENRICHMENT_TASK_SCHEMA_PATH =
  "harness/schemas/current/discovery/evaluation/research-task.schema.json" as const;

const TOPOLOGY_FORMS = [
  "shared_across_opportunities",
  "per_opportunity",
  "per_research_dimension",
  "mixed",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new StoreError(
      "planning_capabilities.authority_invalid",
      `${label} is not a current contract object`,
    );
  }
  return value;
}

async function readJson(root: string, relativePath: string): Promise<Record<string, unknown>> {
  return requireRecord(
    JSON.parse(await readFile(path.join(root, relativePath), "utf8")) as unknown,
    relativePath,
  );
}

export async function buildG24PlanningCapabilities(
  runId: string,
  root = process.cwd(),
): Promise<Record<string, unknown>> {
  const [adaptationPolicy, evaluationPolicy, taskSchema] = await Promise.all([
    readJson(root, ADAPTATION_POLICY_PATH),
    readJson(root, DISCOVERY_EVALUATION_POLICY_PATH),
    readJson(root, ENRICHMENT_TASK_SCHEMA_PATH),
  ]);
  const unitRules = Array.isArray(adaptationPolicy.unit_rules)
    ? adaptationPolicy.unit_rules.filter(isRecord)
    : [];
  const allowedUnitTypes = [
    ...new Set(
      unitRules
        .filter(
          (rule) =>
            rule.mode === "opportunity_discovery" &&
            rule.phase === "enrichment" &&
            rule.agent_role === "lane-researcher" &&
            rule.required_artifact_schema === "startup_opportunity.enrichment_branch_result.v1" &&
            typeof rule.unit_type === "string",
        )
        .map((rule) => String(rule.unit_type)),
    ),
  ].sort();
  const properties = requireRecord(taskSchema.properties, "enrichment task schema properties");
  const targetRefs = requireRecord(
    properties.target_opportunity_refs,
    "enrichment task target_opportunity_refs",
  );
  const requiredHardGates = Array.isArray(evaluationPolicy.required_hard_gates)
    ? evaluationPolicy.required_hard_gates.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (
    adaptationPolicy.schema_version !== "startup_opportunity.adaptation_policy.current" ||
    adaptationPolicy.policy_version !== "1.0.0" ||
    evaluationPolicy.schema_version !== "startup_opportunity.discovery_evaluation_policy.current" ||
    evaluationPolicy.policy_version !== "3.0.0" ||
    taskSchema.$id !==
      "https://startup-opportunity.local/schemas/current/discovery/evaluation/research-task.schema.json" ||
    targetRefs.minItems !== 1 ||
    targetRefs.maxItems !== undefined ||
    allowedUnitTypes.length === 0 ||
    !allowedUnitTypes.includes("counter_evidence") ||
    canonicalJson(requiredHardGates) !== canonicalJson(REQUIRED_HARD_GATES)
  ) {
    throw new StoreError(
      "planning_capabilities.authority_invalid",
      "current G2.4 Policy, Schema, and validator rules do not form the expected closed projection",
    );
  }

  return {
    schema_version: "startup_opportunity.planning_capabilities.discovery_evaluation.current",
    capability_id: "g2_4_enrichment_planning",
    run_id: runId,
    mode: "opportunity_discovery",
    phase: "enrichment",
    authority_bindings: {
      adaptation_policy: {
        ref: ADAPTATION_POLICY_PATH,
        schema_version: adaptationPolicy.schema_version,
        policy_version: adaptationPolicy.policy_version,
        content_hash: canonicalContentHash(adaptationPolicy),
      },
      discovery_evaluation_policy: {
        ref: DISCOVERY_EVALUATION_POLICY_PATH,
        schema_version: evaluationPolicy.schema_version,
        policy_version: evaluationPolicy.policy_version,
        content_hash: canonicalContentHash(evaluationPolicy),
      },
      enrichment_task_schema: {
        ref: ENRICHMENT_TASK_SCHEMA_PATH,
        schema_id: taskSchema.$id,
        content_hash: canonicalContentHash(taskSchema),
      },
      plan_validator_rule: "plan.counter_evidence_missing",
      fan_in_validator_rule: "g2_4.hard_gate_closure_mismatch",
    },
    enrichment_units: {
      allowed_unit_types: allowedUnitTypes,
      task_target_opportunity_cardinality: {
        minimum: targetRefs.minItems,
        maximum: null,
      },
      unit_count_fixed: false,
      supported_topology_forms: TOPOLOGY_FORMS,
      topology_selected_by: "agent_from_current_gap",
    },
    current_plan_counter_evidence: {
      scope: "current_plan",
      minimum_enabled_matching_units: DISCOVERY_COUNTER_EVIDENCE_MINIMUM,
      enabled_unit_type_any_of: DISCOVERY_COUNTER_EVIDENCE_UNIT_TYPES,
    },
    fan_in_hard_gate_closure: {
      scope: "per_opportunity",
      cardinality: G24_FAN_IN_HARD_GATE_CARDINALITY,
      required_gate_ids: requiredHardGates,
    },
    execution_boundary: {
      capability_only: true,
      recommends_unit_count: false,
      selects_topology: false,
      decomposes_research_tasks: false,
      analyzes_research_gaps: false,
      generates_research_semantics: false,
      hidden_llm_calls: false,
    },
  };
}

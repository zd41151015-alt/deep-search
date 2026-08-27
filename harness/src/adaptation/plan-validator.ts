import { canonicalJson } from "../artifact-store/canonical.js";
import { validateDiscoveryUnitOutputPath } from "../runtime/discovery-wave-contracts.js";
import type { DocumentBundleReferenceContext } from "../validators/artifact-validator.js";
import {
  DISCOVERY_COUNTER_EVIDENCE_MINIMUM,
  DISCOVERY_COUNTER_EVIDENCE_UNIT_TYPES,
} from "../validators/g24-planning-rules.js";
import type { PlanningContractValidationResult } from "../validators/planning-contract-validator.js";
import {
  createAssessmentPlanningContractEvaluator,
  createPlanningContractEvaluator,
  type PlanningContractEvaluator,
} from "../validators/planning-contract-validator.js";
import { sortIssues, type ValidationIssue } from "../validators/schema-bundle.js";
import {
  documentMap,
  isRecord,
  leafPlanningContexts,
  statusOfUnit,
  targetByRef,
  unitEntries,
} from "./contracts.js";

export const PLAN_VALIDATION_RESULT_VERSION =
  "startup_opportunity.plan_validation_result.v1" as const;

export interface PlanValidationResult {
  readonly schemaVersion: typeof PLAN_VALIDATION_RESULT_VERSION;
  readonly valid: boolean;
  readonly planningContract: PlanningContractValidationResult;
  readonly planErrors: readonly ValidationIssue[];
}

function issue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "plan",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function findCycle(edges: ReadonlyMap<string, readonly string[]>): readonly string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (node: string): readonly string[] | null => {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      return [...stack.slice(start), node];
    }
    if (visited.has(node)) {
      return null;
    }
    visiting.add(node);
    stack.push(node);
    for (const dependency of edges.get(node) ?? []) {
      const cycle = visit(dependency);
      if (cycle !== null) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  };
  for (const node of [...edges.keys()].sort()) {
    const cycle = visit(node);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
}

function waveAncestors(
  waveId: string,
  edges: ReadonlyMap<string, readonly string[]>,
  result = new Set<string>(),
): ReadonlySet<string> {
  for (const parent of edges.get(waveId) ?? []) {
    if (!result.has(parent)) {
      result.add(parent);
      waveAncestors(parent, edges, result);
    }
  }
  return result;
}

export class PlanSemanticValidator {
  constructor(private readonly contracts: PlanningContractEvaluator) {}

  validateDocumentBundle(
    value: unknown,
    referenceContext: DocumentBundleReferenceContext = {},
  ): PlanValidationResult {
    const planningContract = this.contracts.validateDocumentBundle(value, referenceContext);
    const byPath = documentMap(value);
    const context = leafPlanningContexts(value)[0];
    const targetBinding = context?.document.target_plan_binding;
    const plan = isRecord(targetBinding) ? targetByRef(byPath, targetBinding.plan_ref) : null;
    const manifestBinding = context?.document.manifest_binding;
    const manifest = isRecord(manifestBinding)
      ? targetByRef(byPath, manifestBinding.manifest_ref)
      : null;
    const errors: ValidationIssue[] = [];

    if (plan?.schemaVersion === "startup_opportunity.research_plan.v1") {
      const parent =
        typeof plan.document.parent_plan_ref === "string"
          ? targetByRef(byPath, plan.document.parent_plan_ref)
          : null;
      this.validatePlan(
        plan.path,
        plan.document,
        context?.document.validation_stage === "candidate_revision"
          ? null
          : (manifest?.document ?? null),
        parent?.schemaVersion === "startup_opportunity.research_plan.v1" ? parent : null,
        manifest?.document ?? null,
        errors,
      );
    }

    const planErrors = sortIssues(errors);
    return {
      schemaVersion: PLAN_VALIDATION_RESULT_VERSION,
      valid: planningContract.valid && planErrors.length === 0,
      planningContract,
      planErrors,
    };
  }

  private validatePlan(
    planPath: string,
    plan: Record<string, unknown>,
    manifest: Record<string, unknown> | null,
    parentPlan: { readonly path: string; readonly document: Record<string, unknown> } | null,
    currentManifest: Record<string, unknown> | null,
    errors: ValidationIssue[],
  ): void {
    const entries = unitEntries(plan);
    const unitIds = new Map<string, number>();
    const outputPaths = new Map<string, string>();
    const waveIds = new Set<string>();
    const waveEdges = new Map<string, readonly string[]>();

    if (Array.isArray(plan.waves)) {
      for (const [index, wave] of plan.waves.entries()) {
        if (!isRecord(wave) || typeof wave.wave_id !== "string") {
          continue;
        }
        if (waveIds.has(wave.wave_id)) {
          errors.push(
            issue(
              "plan.duplicate_wave_id",
              `${planPath}#/waves/${index}/wave_id`,
              "wave ids must be unique",
              {
                waveId: wave.wave_id,
              },
            ),
          );
        }
        waveIds.add(wave.wave_id);
        waveEdges.set(
          wave.wave_id,
          Array.isArray(wave.depends_on)
            ? wave.depends_on.filter((item): item is string => typeof item === "string")
            : [],
        );
      }
    }

    for (const [waveId, dependencies] of waveEdges) {
      for (const dependency of dependencies) {
        if (!waveIds.has(dependency)) {
          errors.push(
            issue(
              "plan.wave_dependency_missing",
              `${planPath}#${waveId}`,
              "wave dependency is not declared",
              {
                dependency,
              },
            ),
          );
        }
      }
    }
    const waveCycle = findCycle(waveEdges);
    if (waveCycle !== null) {
      errors.push(
        issue("plan.wave_cycle", planPath, "wave dependency graph is cyclic", { cycle: waveCycle }),
      );
    }

    for (const [index, entry] of entries.entries()) {
      const unitId = String(entry.unit.unit_id ?? "");
      const outputPath = String(entry.unit.output_path ?? "");
      const outputValidation = validateDiscoveryUnitOutputPath(entry.unit);
      if (outputValidation !== null && !outputValidation.valid) {
        errors.push(
          issue(
            "plan.output_path_contract_mismatch",
            `${planPath}#${unitId}`,
            "unit output path does not match its installed artifact contract",
            outputValidation.details,
          ),
        );
      }
      if (unitIds.has(unitId)) {
        errors.push(
          issue("plan.duplicate_unit_id", `${planPath}#${unitId}`, "unit ids must be unique", {
            firstIndex: unitIds.get(unitId),
            duplicateIndex: index,
          }),
        );
      }
      unitIds.set(unitId, index);
      const owner = outputPaths.get(outputPath);
      if (owner !== undefined) {
        errors.push(
          issue(
            "plan.output_path_conflict",
            `${planPath}#${unitId}`,
            "unit output paths must be unique",
            {
              outputPath,
              owners: [owner, unitId],
            },
          ),
        );
      }
      outputPaths.set(outputPath, unitId);
    }

    const unitEdges = new Map<string, readonly string[]>();
    const byId = new Map(entries.map((entry) => [String(entry.unit.unit_id), entry]));
    for (const entry of entries) {
      const unitId = String(entry.unit.unit_id);
      const dependencies = Array.isArray(entry.unit.depends_on)
        ? entry.unit.depends_on.filter((item): item is string => typeof item === "string")
        : [];
      unitEdges.set(unitId, dependencies);
      const ancestors = waveAncestors(entry.waveId, waveEdges);
      for (const dependency of dependencies) {
        const target = byId.get(dependency);
        if (target === undefined) {
          errors.push(
            issue(
              "plan.unit_dependency_missing",
              `${planPath}#${unitId}`,
              "unit dependency is not declared",
              {
                dependency,
              },
            ),
          );
        } else if (!ancestors.has(target.waveId)) {
          errors.push(
            issue(
              "plan.unit_dependency_wave_invalid",
              `${planPath}#${unitId}`,
              "unit dependency must be in an ancestor wave",
              { dependency, dependencyWave: target.waveId, unitWave: entry.waveId },
            ),
          );
        } else if (target.unit.plan_disposition !== "enabled") {
          errors.push(
            issue(
              "plan.unit_dependency_disposition_invalid",
              `${planPath}#${unitId}`,
              "enabled work cannot depend on skipped, cancelled, or superseded work",
              { dependency, disposition: target.unit.plan_disposition },
            ),
          );
        }
      }

      const supersedes = entry.unit.supersedes_unit_ref;
      const attempt = entry.unit.attempt;
      if (supersedes === null && attempt !== 1) {
        errors.push(
          issue(
            "plan.attempt_lineage_missing",
            `${planPath}#${unitId}`,
            "attempts after one require lineage",
          ),
        );
      }
      if (typeof supersedes === "string") {
        const [supersededPlanRef, supersededUnitId] = supersedes.split("#", 2);
        const target =
          supersededPlanRef === planPath || supersededPlanRef === parentPlan?.path
            ? byId.get(supersededUnitId ?? "")
            : undefined;
        if (target === undefined || supersededUnitId === unitId) {
          errors.push(
            issue(
              "plan.supersedes_target_invalid",
              `${planPath}#${unitId}`,
              "supersedes ref must target another declared unit",
              {
                supersedes,
              },
            ),
          );
        } else if (target.unit.output_path === entry.unit.output_path) {
          errors.push(
            issue(
              "plan.supersedes_output_conflict",
              `${planPath}#${unitId}`,
              "superseding work requires a new output path",
              {
                supersedes,
              },
            ),
          );
        }
      }
    }
    const unitCycle = findCycle(unitEdges);
    if (unitCycle !== null) {
      errors.push(
        issue("plan.unit_cycle", planPath, "unit dependency graph is cyclic", { cycle: unitCycle }),
      );
    }

    const retention = plan.candidate_retention_policy;
    const exploration = plan.exploration_policy;
    if (
      plan.mode === "opportunity_discovery" &&
      (!isRecord(retention) || retention.counterfactual_candidate_requirement !== true)
    ) {
      errors.push(
        issue(
          "plan.counterfactual_policy_missing",
          planPath,
          "counterfactual retention is mandatory",
        ),
      );
    }
    for (const field of [
      "require_seed_independent_demand_unit",
      "require_counterfactual_unit",
      "initial_hypotheses_are_questions_not_truth",
      "separate_generation_and_evaluation_sources",
      "freeze_thesis_before_enrichment",
      "require_independent_challenger_queries",
    ]) {
      if (!isRecord(exploration) || exploration[field] !== true) {
        errors.push(
          issue(
            "plan.exploration_precondition_disabled",
            `${planPath}#/exploration_policy/${field}`,
            "published exploration precondition must remain enabled",
          ),
        );
      }
    }
    const enabledCounterEvidenceUnits = entries.filter(
      (entry) =>
        entry.unit.plan_disposition === "enabled" &&
        DISCOVERY_COUNTER_EVIDENCE_UNIT_TYPES.includes(
          String(entry.unit.unit_type) as (typeof DISCOVERY_COUNTER_EVIDENCE_UNIT_TYPES)[number],
        ),
    );
    if (enabledCounterEvidenceUnits.length < DISCOVERY_COUNTER_EVIDENCE_MINIMUM) {
      errors.push(
        issue(
          "plan.counter_evidence_missing",
          planPath,
          "an enabled counter-evidence or adversarial-review unit is mandatory",
        ),
      );
    }

    if (manifest !== null) {
      for (const entry of entries) {
        const unitId = String(entry.unit.unit_id);
        const state = statusOfUnit(manifest, unitId);
        const disposition = entry.unit.plan_disposition;
        const compatible =
          state === "pending" ||
          ((state === "active" || state === "completed" || state === "failed") &&
            disposition === "enabled") ||
          (state === "invalidated" &&
            (disposition === "cancelled" || disposition === "superseded")) ||
          (state === "skipped" && disposition === "skipped") ||
          (state === "cancelled" && disposition === "cancelled") ||
          (state === "superseded" && disposition === "superseded");
        if (!compatible) {
          errors.push(
            issue(
              "plan.manifest_state_mismatch",
              `${planPath}#${unitId}`,
              "plan disposition conflicts with manifest state",
              {
                disposition,
                state,
              },
            ),
          );
        }
      }
    }

    if (parentPlan !== null) {
      const parentEntries = unitEntries(parentPlan.document);
      const candidateById = new Map(entries.map((entry) => [String(entry.unit.unit_id), entry]));
      for (const parentEntry of parentEntries) {
        const unitId = String(parentEntry.unit.unit_id);
        const candidate = candidateById.get(unitId);
        if (candidate === undefined) {
          errors.push(
            issue(
              "plan.parent_unit_removed",
              `${planPath}#${unitId}`,
              "candidate revisions must retain every parent unit",
            ),
          );
          continue;
        }
        if (candidate.waveId !== parentEntry.waveId) {
          errors.push(
            issue(
              "plan.parent_unit_moved",
              `${planPath}#${unitId}`,
              "candidate revisions cannot move existing units between waves",
            ),
          );
        }
        if (
          currentManifest !== null &&
          statusOfUnit(currentManifest, unitId) === "completed" &&
          canonicalJson(candidate.unit) !== canonicalJson(parentEntry.unit)
        ) {
          errors.push(
            issue(
              "plan.completed_unit_modified",
              `${planPath}#${unitId}`,
              "completed units are immutable in candidate revisions",
            ),
          );
        }
      }
    }
  }
}

export async function createPlanSemanticValidator(
  root = process.cwd(),
): Promise<PlanSemanticValidator> {
  return new PlanSemanticValidator(await createPlanningContractEvaluator(root));
}

export async function createAssessmentPlanSemanticValidator(
  root = process.cwd(),
): Promise<PlanSemanticValidator> {
  return new PlanSemanticValidator(await createAssessmentPlanningContractEvaluator(root));
}

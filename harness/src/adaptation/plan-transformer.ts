import { canonicalContentHash, canonicalJson, operationKey } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import type { RunManifest } from "../run-store/run-store.js";
import { fragmentOf, isRecord } from "./contracts.js";

export interface AdaptationInputDocument {
  readonly path: string;
  readonly document: Record<string, unknown>;
}

export interface PlanTransformationResult {
  readonly operationKey: string;
  readonly revisionCreated: boolean;
  readonly planPath: string;
  readonly plan: Record<string, unknown> | null;
  readonly manifest: RunManifest;
  readonly adaptationRefs: readonly string[];
  readonly actionNames: readonly string[];
}

export interface AssessmentPlanTransformationResult {
  readonly revisionCreated: boolean;
  readonly planPath: string;
  readonly plan: Record<string, unknown> | null;
}

const REVISION_ACTIONS = new Set([
  "add_unit",
  "cancel_unit",
  "skip_unit",
  "reprioritize_unit",
  "retry_unit",
  "supersede_unit",
]);

const NON_REVISION_ACTIONS = new Set([
  "continue_existing_plan",
  "request_clarification",
  "stop_followup",
  "record_runtime_failure",
  "terminate_insufficient_evidence",
]);

const UNIT_STATE_FIELDS = [
  "completed_units",
  "active_units",
  "failed_units",
  "invalidated_units",
  "skipped_units",
  "cancelled_units",
  "superseded_units",
] as const;

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function moveUnitState(
  manifest: RunManifest,
  unitId: string,
  destination: (typeof UNIT_STATE_FIELDS)[number],
): RunManifest {
  const updated = { ...manifest } as Record<string, unknown>;
  for (const field of UNIT_STATE_FIELDS) {
    const values = manifest[field].filter((candidate) => candidate !== unitId);
    updated[field] = field === destination ? uniqueSorted([...values, unitId]) : values;
  }
  return updated as RunManifest;
}

function findUnit(
  plan: Record<string, unknown>,
  unitId: string,
): { readonly wave: Record<string, unknown>; readonly unit: Record<string, unknown> } {
  if (!Array.isArray(plan.waves)) {
    throw new StoreError("plan.waves_missing", "Research Plan has no waves");
  }
  for (const wave of plan.waves) {
    if (!isRecord(wave) || !Array.isArray(wave.units)) {
      continue;
    }
    const unit = wave.units.find(
      (candidate) => isRecord(candidate) && candidate.unit_id === unitId,
    );
    if (isRecord(unit)) {
      return { wave, unit };
    }
  }
  throw new StoreError("adaptation.target_missing", "target unit is absent from the base plan", {
    unitId,
  });
}

function leafWaveIds(plan: Record<string, unknown>): readonly string[] {
  const waves = Array.isArray(plan.waves) ? plan.waves.filter(isRecord) : [];
  const dependedOn = new Set<string>();
  for (const wave of waves) {
    for (const dependency of Array.isArray(wave.depends_on) ? wave.depends_on : []) {
      if (typeof dependency === "string") {
        dependedOn.add(dependency);
      }
    }
  }
  return waves
    .map((wave) => String(wave.wave_id))
    .filter((waveId) => !dependedOn.has(waveId))
    .sort();
}

function hasCompletedWave(plan: Record<string, unknown>, manifest: RunManifest): boolean {
  const terminal = new Set(
    UNIT_STATE_FIELDS.filter((field) => field !== "active_units").flatMap(
      (field) => manifest[field],
    ),
  );
  return (Array.isArray(plan.waves) ? plan.waves : []).some((wave) => {
    if (!isRecord(wave) || !Array.isArray(wave.units) || wave.units.length === 0) {
      return false;
    }
    return wave.units.every(
      (unit) => isRecord(unit) && typeof unit.unit_id === "string" && terminal.has(unit.unit_id),
    );
  });
}

function appendApplied(manifest: RunManifest, refs: readonly string[]): RunManifest {
  return {
    ...manifest,
    pending_adaptation_refs: manifest.pending_adaptation_refs.filter((ref) => !refs.includes(ref)),
    validated_adaptation_refs: manifest.validated_adaptation_refs.filter(
      (ref) => !refs.includes(ref),
    ),
    rejected_adaptation_refs: manifest.rejected_adaptation_refs.filter(
      (ref) => !refs.includes(ref),
    ),
    applied_adaptation_refs: uniqueSorted([...manifest.applied_adaptation_refs, ...refs]),
  };
}

export function transformPlan(
  basePlanPath: string,
  basePlan: Record<string, unknown>,
  manifest: RunManifest,
  decisions: readonly AdaptationInputDocument[],
  createdAt: string,
  resumeClarificationAuthorized = false,
): PlanTransformationResult {
  const sortedDecisions = [...decisions].sort((left, right) => left.path.localeCompare(right.path));
  const adaptationRefs = sortedDecisions.map((decision) => decision.path);
  const expectedDecisionType =
    manifest.mode === "opportunity_discovery"
      ? "startup_opportunity.adaptation_decision.discovery.current"
      : "startup_opportunity.adaptation_decision.assessment.current";
  if (
    sortedDecisions.some((decision) => decision.document.schema_version !== expectedDecisionType)
  ) {
    throw new StoreError(
      "adaptation.run_mode_mismatch",
      "Adaptation Decision identity does not match the current Run mode",
    );
  }
  const actions = sortedDecisions.map((decision) => String(decision.document.action));
  const hasRevisionAction = actions.some((action) => REVISION_ACTIONS.has(action));
  const hasNonRevisionAction = actions.some((action) => NON_REVISION_ACTIONS.has(action));
  if (
    decisions.length === 0 ||
    actions.some((action) => !REVISION_ACTIONS.has(action) && !NON_REVISION_ACTIONS.has(action))
  ) {
    throw new StoreError("adaptation.action_invalid", "apply requires one or more closed actions");
  }
  if (hasRevisionAction && hasNonRevisionAction) {
    throw new StoreError(
      "adaptation.mixed_apply_batch",
      "revision and non-revision actions require separate atomic apply operations",
    );
  }

  const stableOperationKey = operationKey("apply_plan_revision", {
    parent_plan_hash: canonicalContentHash(basePlan),
    adaptation_refs: uniqueSorted(adaptationRefs),
  });
  let nextManifest: RunManifest = {
    ...appendApplied(manifest, adaptationRefs),
  };

  if (!hasRevisionAction) {
    const lifecycle = sortedDecisions.filter(
      (decision) => decision.document.action !== "continue_existing_plan",
    );
    if (lifecycle.length > 1) {
      throw new StoreError(
        "adaptation.non_revision_conflict",
        "one apply operation cannot contain multiple lifecycle dispositions",
      );
    }
    const decision = lifecycle[0]?.document;
    if (decision?.action === "request_clarification") {
      nextManifest = {
        ...nextManifest,
        status_before_clarification: manifest.status,
        status: "needs_clarification",
      };
    } else if (decision?.action === "stop_followup") {
      nextManifest = {
        ...nextManifest,
        limitations: uniqueSorted([...manifest.limitations, String(decision.reason)]),
      };
    } else if (decision?.action === "record_runtime_failure") {
      nextManifest = {
        ...nextManifest,
        status_before_clarification: null,
        status: "failed",
        limitations: uniqueSorted([...manifest.limitations, String(decision.reason)]),
      };
    } else if (decision?.action === "terminate_insufficient_evidence") {
      nextManifest = {
        ...nextManifest,
        status_before_clarification: null,
        status: "insufficient_evidence",
        limitations: uniqueSorted([...manifest.limitations, String(decision.reason)]),
      };
    }
    return {
      operationKey: stableOperationKey,
      revisionCreated: false,
      planPath: basePlanPath,
      plan: null,
      manifest: nextManifest,
      adaptationRefs,
      actionNames: actions,
    };
  }

  const plan = structuredClone(basePlan);
  if (!Array.isArray(plan.waves)) {
    throw new StoreError("plan.waves_missing", "Research Plan has no waves");
  }
  const addUnits: Record<string, unknown>[] = [];
  for (const decision of sortedDecisions) {
    const action = String(decision.document.action);
    const targetRef = decision.document.target_unit_ref;
    const targetId = typeof targetRef === "string" ? fragmentOf(targetRef) : null;
    const newUnit = isRecord(decision.document.target_unit)
      ? structuredClone(decision.document.target_unit)
      : null;
    if (action === "add_unit" && newUnit !== null) {
      if (
        decision.document.schema_version ===
          "startup_opportunity.adaptation_decision.assessment.current" &&
        typeof decision.document.candidate_assessment_plan_ref === "string"
      ) {
        newUnit.input_refs = uniqueSorted([
          ...(Array.isArray(newUnit.input_refs)
            ? newUnit.input_refs.filter((ref): ref is string => typeof ref === "string")
            : []),
          decision.document.candidate_assessment_plan_ref,
        ]);
      }
      addUnits.push(newUnit);
      continue;
    }
    if (targetId === null) {
      throw new StoreError("adaptation.target_missing", "unit action has no target unit ref", {
        adaptationRef: decision.path,
      });
    }
    const target = findUnit(plan, targetId);
    if (action === "cancel_unit") {
      target.unit.plan_disposition = "cancelled";
      nextManifest = moveUnitState(nextManifest, targetId, "cancelled_units");
    } else if (action === "skip_unit") {
      target.unit.plan_disposition = "skipped";
      nextManifest = moveUnitState(nextManifest, targetId, "skipped_units");
    } else if (action === "reprioritize_unit") {
      target.unit.priority_band = decision.document.priority_band;
    } else if ((action === "retry_unit" || action === "supersede_unit") && newUnit !== null) {
      target.unit.plan_disposition = "superseded";
      nextManifest = moveUnitState(nextManifest, targetId, "superseded_units");
      (target.wave.units as Record<string, unknown>[]).push(newUnit);
    }
  }
  if (addUnits.length > 0) {
    const identity = canonicalContentHash({
      parent_plan_hash: canonicalContentHash(basePlan),
      adaptation_refs: uniqueSorted(adaptationRefs),
    });
    plan.waves.push({
      wave_id: `followup_r${Number(basePlan.revision) + 1}_${identity.slice(-12)}`,
      depends_on: leafWaveIds(basePlan),
      units: addUnits.sort((left, right) =>
        String(left.unit_id).localeCompare(String(right.unit_id)),
      ),
    });
  }
  const revision = Number(basePlan.revision) + 1;
  const planPath = `plans/research-plan.r${revision}.json`;
  plan.revision = revision;
  plan.parent_plan_ref = basePlanPath;
  plan.triggered_by_adaptation_refs = uniqueSorted(adaptationRefs);
  plan.created_at = createdAt;

  const addsFollowupWork = actions.some((action) =>
    ["add_unit", "retry_unit", "supersede_unit"].includes(action),
  );
  if (
    manifest.status === "needs_clarification" &&
    resumeClarificationAuthorized &&
    manifest.status_before_clarification === null
  ) {
    throw new StoreError(
      "adaptation.clarification_resume_state_missing",
      "Scope reconciliation cannot resume a Run without its exact pre-clarification status",
    );
  }
  nextManifest = {
    ...nextManifest,
    status:
      manifest.status === "needs_clarification" && resumeClarificationAuthorized
        ? (manifest.status_before_clarification as RunManifest["status"])
        : manifest.status,
    status_before_clarification:
      manifest.status === "needs_clarification" && resumeClarificationAuthorized
        ? null
        : manifest.status_before_clarification,
    current_plan_ref: planPath,
    plan_revision: revision,
    followup_round:
      addsFollowupWork && hasCompletedWave(basePlan, manifest)
        ? manifest.followup_round + 1
        : manifest.followup_round,
  };
  return {
    operationKey: stableOperationKey,
    revisionCreated: true,
    planPath,
    plan: JSON.parse(canonicalJson(plan)) as Record<string, unknown>,
    manifest: nextManifest,
    adaptationRefs,
    actionNames: actions,
  };
}

export function transformAssessmentPlan(
  baseAssessmentPlanPath: string,
  baseAssessmentPlan: Record<string, unknown>,
  transformedResearchPlanPath: string,
  decisions: readonly AdaptationInputDocument[],
  createdAt: string,
): AssessmentPlanTransformationResult {
  const sortedDecisions = [...decisions].sort((left, right) => left.path.localeCompare(right.path));
  const adaptationRefs = sortedDecisions.map((decision) => decision.path);
  if (
    sortedDecisions.length === 0 ||
    sortedDecisions.some(
      (decision) =>
        decision.document.schema_version !==
          "startup_opportunity.adaptation_decision.assessment.current" ||
        !["add_unit", "stop_followup"].includes(String(decision.document.action)),
    )
  ) {
    throw new StoreError(
      "adaptation.assessment_action_invalid",
      "assessment plan transformation requires only Assessment Adaptation Decisions",
    );
  }
  const revisionCreated = sortedDecisions.some(
    (decision) => decision.document.action === "add_unit",
  );
  if (!revisionCreated) {
    return { revisionCreated: false, planPath: baseAssessmentPlanPath, plan: null };
  }
  const revision = Number(baseAssessmentPlan.revision) + 1;
  const planPath = `plans/concept-evidence-assessment-plan.r${revision}.json`;
  if (
    sortedDecisions.some((decision) => decision.document.candidate_assessment_plan_ref !== planPath)
  ) {
    throw new StoreError(
      "adaptation.assessment_candidate_ref_mismatch",
      "Assessment Adaptation Decision candidate plan ref differs from the deterministic revision path",
    );
  }
  const plan = structuredClone(baseAssessmentPlan);
  plan.revision = revision;
  plan.parent_plan_ref = baseAssessmentPlanPath;
  plan.research_plan_ref = transformedResearchPlanPath;
  plan.triggered_by_adaptation_refs = uniqueSorted(adaptationRefs);
  plan.created_at = createdAt;
  return {
    revisionCreated: true,
    planPath,
    plan: JSON.parse(canonicalJson(plan)) as Record<string, unknown>,
  };
}

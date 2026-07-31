import { canonicalJson } from "../artifact-store/canonical.js";
import {
  type ArtifactValidator,
  createArtifactValidator,
  type DocumentBundleReferenceContext,
} from "../validators/artifact-validator.js";
import { sortIssues, type ValidationIssue } from "../validators/schema-bundle.js";
import {
  type AssessmentAdaptationPolicy,
  loadAssessmentAdaptationPolicy,
} from "./assessment-policy.js";
import {
  documentMap,
  effectiveDocuments,
  fragmentOf,
  isRecord,
  leafPlanningContexts,
  statusOfUnit,
  targetByRef,
  unitById,
  unitEntries,
} from "./contracts.js";
import {
  type DiscoveryAdaptationBindingPolicy,
  loadDiscoveryAdaptationBindingPolicy,
} from "./discovery-adaptation-policy.js";
import {
  createAssessmentPlanSemanticValidator,
  createPlanSemanticValidator,
  type PlanSemanticValidator,
  type PlanValidationResult,
} from "./plan-validator.js";

export const ADAPTATION_VALIDATION_RESULT_VERSION =
  "startup_opportunity.adaptation_validation_result.v1" as const;

export interface AdaptationValidationResult {
  readonly schemaVersion: typeof ADAPTATION_VALIDATION_RESULT_VERSION;
  readonly valid: boolean;
  readonly planValidation: PlanValidationResult;
  readonly adaptationRefs: readonly string[];
  readonly adaptationErrors: readonly ValidationIssue[];
}

function issue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "adaptation",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function gapByRef(
  documents: ReturnType<typeof documentMap>,
  ref: string,
): { readonly snapshot: Record<string, unknown>; readonly gap: Record<string, unknown> } | null {
  const snapshot = targetByRef(documents, ref);
  const gapId = fragmentOf(ref);
  if (
    (snapshot?.schemaVersion !== "startup_opportunity.gap_snapshot.v1" &&
      snapshot?.schemaVersion !== "startup_opportunity.gap_snapshot.v3") ||
    gapId === null ||
    !Array.isArray(snapshot.document.gaps)
  ) {
    return null;
  }
  const gap = snapshot.document.gaps.find(
    (candidate) => isRecord(candidate) && candidate.gap_id === gapId,
  );
  return isRecord(gap) ? { snapshot: snapshot.document, gap } : null;
}

function targetUnitId(decision: Record<string, unknown>): string | null {
  const ref = decision.target_unit_ref;
  return typeof ref === "string" ? fragmentOf(ref) : null;
}

const FOLLOWUP_ACTIONS = new Set(["add_unit", "retry_unit", "supersede_unit"]);

export class AdaptationPolicyValidator {
  constructor(
    private readonly plans: PlanSemanticValidator,
    private readonly assessmentPlans: PlanSemanticValidator,
    private readonly assessmentPolicy: AssessmentAdaptationPolicy,
    private readonly discoveryBindingPolicy: DiscoveryAdaptationBindingPolicy,
    private readonly artifacts: ArtifactValidator,
  ) {}

  validateDocumentBundle(
    value: unknown,
    referenceContext: DocumentBundleReferenceContext = {},
  ): AdaptationValidationResult {
    if (
      effectiveDocuments(value).some(
        (document) =>
          document.schemaVersion === "startup_opportunity.adaptation_decision.v3" ||
          document.schemaVersion === "startup_opportunity.gap_snapshot.v2",
      )
    ) {
      return this.validateAssessmentDocumentBundle(value, referenceContext);
    }
    const documents = effectiveDocuments(value);
    const effectiveByPath = new Map(documents.map((document) => [document.path, document]));
    const planningValue =
      isRecord(value) && Array.isArray(value.documents)
        ? {
            ...value,
            documents: value.documents
              .filter(
                (entry) =>
                  !isRecord(entry) ||
                  !isRecord(entry.document) ||
                  entry.document.artifact_type !== "startup_opportunity.discovery_candidate.v1",
              )
              .map((entry) => {
                if (!isRecord(entry) || typeof entry.path !== "string") {
                  return entry;
                }
                const effective = effectiveByPath.get(entry.path);
                return effective?.envelope === null || effective === undefined
                  ? entry
                  : { ...entry, document: effective.document };
              }),
          }
        : value;
    const planValidation = this.plans.validateDocumentBundle(planningValue, referenceContext);
    const byPath = documentMap(value);
    const context = leafPlanningContexts(value)[0];
    const targetBinding = context?.document.target_plan_binding;
    const plan = isRecord(targetBinding) ? targetByRef(byPath, targetBinding.plan_ref) : null;
    const manifestBinding = context?.document.manifest_binding;
    const manifest = isRecord(manifestBinding)
      ? targetByRef(byPath, manifestBinding.manifest_ref)
      : null;
    const decisionDocuments = documents
      .filter((document) => document.schemaVersion === "startup_opportunity.adaptation_decision.v2")
      .sort((left, right) => left.path.localeCompare(right.path));
    const terminalDecisionRefs =
      manifest?.schemaVersion === "startup_opportunity.run_manifest.v1"
        ? new Set<string>([
            ...(Array.isArray(manifest.document.applied_adaptation_refs)
              ? manifest.document.applied_adaptation_refs.filter(
                  (ref): ref is string => typeof ref === "string",
                )
              : []),
            ...(Array.isArray(manifest.document.rejected_adaptation_refs)
              ? manifest.document.rejected_adaptation_refs.filter(
                  (ref): ref is string => typeof ref === "string",
                )
              : []),
          ])
        : null;
    const decisions =
      terminalDecisionRefs === null
        ? decisionDocuments
        : decisionDocuments.filter((decision) => !terminalDecisionRefs.has(decision.path));
    const errors: ValidationIssue[] = [];
    const occupiedTargets = new Map<string, string>();
    const newUnitIds = new Map<string, string>();
    const newOutputPaths = new Map<string, string>();
    const coveredGapRefs = new Set<string>();
    if (
      manifest?.schemaVersion === "startup_opportunity.run_manifest.v1" &&
      Array.isArray(manifest.document.applied_adaptation_refs)
    ) {
      const appliedRefs = new Set(
        manifest.document.applied_adaptation_refs.filter(
          (ref): ref is string => typeof ref === "string",
        ),
      );
      for (const decision of decisionDocuments.filter((entry) => appliedRefs.has(entry.path))) {
        for (const gapRef of Array.isArray(decision.document.trigger_gap_refs)
          ? decision.document.trigger_gap_refs
          : []) {
          if (typeof gapRef === "string") {
            coveredGapRefs.add(gapRef);
          }
        }
      }
    }

    if (decisions.length === 0) {
      errors.push(
        issue("adaptation.decision_missing", "", "at least one v2 Adaptation Decision is required"),
      );
    }
    const identities = new Map<string, string>();
    for (const decision of decisions) {
      const identity = `${String(decision.document.adaptation_id)}\0${String(decision.document.based_on_plan_ref)}`;
      const previous = identities.get(identity);
      const content = canonicalJson(decision.document);
      if (previous !== undefined && previous !== content) {
        errors.push(
          issue(
            "adaptation.identity_conflict",
            decision.path,
            "adaptation identity is reused with different content",
            {
              adaptationId: decision.document.adaptation_id,
            },
          ),
        );
      }
      identities.set(identity, content);
      for (const gapRef of Array.isArray(decision.document.trigger_gap_refs)
        ? decision.document.trigger_gap_refs
        : []) {
        if (typeof gapRef === "string") {
          coveredGapRefs.add(gapRef);
        }
      }
      if (typeof decision.document.target_unit_ref === "string") {
        const prior = occupiedTargets.get(decision.document.target_unit_ref);
        if (prior !== undefined) {
          errors.push(
            issue(
              "adaptation.target_conflict",
              decision.path,
              "multiple decisions in one validation batch target the same unit",
              { targetUnitRef: decision.document.target_unit_ref, priorDecisionRef: prior },
            ),
          );
        }
        occupiedTargets.set(decision.document.target_unit_ref, decision.path);
      }
      if (isRecord(decision.document.target_unit)) {
        for (const [field, value, index] of [
          ["unit_id", decision.document.target_unit.unit_id, newUnitIds],
          ["output_path", decision.document.target_unit.output_path, newOutputPaths],
        ] as const) {
          if (typeof value !== "string") {
            continue;
          }
          const prior = index.get(value);
          if (prior !== undefined) {
            errors.push(
              issue(
                `adaptation.target_${field}_batch_conflict`,
                decision.path,
                `multiple decisions declare the same target ${field}`,
                { value, priorDecisionRef: prior },
              ),
            );
          }
          index.set(value, decision.path);
        }
      }
      if (
        plan?.schemaVersion === "startup_opportunity.research_plan.v1" &&
        manifest?.schemaVersion === "startup_opportunity.run_manifest.v1"
      ) {
        this.validateDecision(
          decision.path,
          decision.document,
          decision.envelope,
          plan.path,
          plan.document,
          manifest.document,
          byPath,
          errors,
        );
      }
    }

    if (plan?.schemaVersion === "startup_opportunity.research_plan.v1") {
      for (const snapshot of documents.filter(
        (document) =>
          (document.schemaVersion === "startup_opportunity.gap_snapshot.v1" ||
            document.schemaVersion === "startup_opportunity.gap_snapshot.v3") &&
          document.document.based_on_plan_ref === plan.path,
      )) {
        for (const gap of Array.isArray(snapshot.document.gaps) ? snapshot.document.gaps : []) {
          if (!isRecord(gap) || typeof gap.gap_id !== "string") {
            continue;
          }
          const decisionRelevant =
            gap.severity === "blocking" ||
            (Array.isArray(gap.decision_impact) && gap.decision_impact.length > 0);
          const ref = `${snapshot.path}#${gap.gap_id}`;
          if (decisionRelevant && !coveredGapRefs.has(ref)) {
            errors.push(
              issue(
                "adaptation.gap_uncovered",
                ref,
                "every current decision-relevant gap requires an explicit disposition",
              ),
            );
          }
        }
      }
    }

    const adaptationErrors = sortIssues(errors);
    return {
      schemaVersion: ADAPTATION_VALIDATION_RESULT_VERSION,
      valid: planValidation.valid && adaptationErrors.length === 0,
      planValidation,
      adaptationRefs: decisions.map((decision) => decision.path),
      adaptationErrors,
    };
  }

  private validateAssessmentDocumentBundle(
    value: unknown,
    referenceContext: DocumentBundleReferenceContext,
  ): AdaptationValidationResult {
    const planValidation = this.assessmentPlans.validateDocumentBundle(value, referenceContext);
    const documents = effectiveDocuments(value);
    const byPath = documentMap(value);
    const context = leafPlanningContexts(value)[0];
    const targetBinding = context?.document.target_plan_binding;
    const plan = isRecord(targetBinding) ? targetByRef(byPath, targetBinding.plan_ref) : null;
    const manifestBinding = context?.document.manifest_binding;
    const manifest = isRecord(manifestBinding)
      ? targetByRef(byPath, manifestBinding.manifest_ref)
      : null;
    const decisions = documents
      .filter((document) => document.schemaVersion === "startup_opportunity.adaptation_decision.v3")
      .sort((left, right) => left.path.localeCompare(right.path));
    const snapshots = documents.filter(
      (document) => document.schemaVersion === "startup_opportunity.gap_snapshot.v2",
    );
    const errors: ValidationIssue[] = [];
    if (decisions.length === 0) {
      errors.push(
        issue("adaptation.decision_missing", "", "at least one v3 Adaptation Decision is required"),
      );
    }

    const identityContent = new Map<string, string>();
    const coveredGaps = new Map<string, string>();
    const unitIds = new Map<string, string>();
    const outputPaths = new Map<string, string>();
    for (const decision of decisions) {
      const identity = `${String(decision.document.adaptation_id)}\0${String(decision.document.based_on_plan_ref)}`;
      const content = canonicalJson(decision.document);
      const previousContent = identityContent.get(identity);
      if (previousContent !== undefined && previousContent !== content) {
        errors.push(
          issue(
            "adaptation.identity_conflict",
            decision.path,
            "adaptation identity is reused with different content",
          ),
        );
      }
      identityContent.set(identity, content);

      const gapRef = Array.isArray(decision.document.trigger_gap_refs)
        ? decision.document.trigger_gap_refs[0]
        : undefined;
      if (typeof gapRef === "string") {
        const priorDecision = coveredGaps.get(gapRef);
        if (priorDecision !== undefined) {
          errors.push(
            issue(
              "adaptation.coverage_duplicate",
              decision.path,
              "one assessment coverage gap cannot receive multiple dispositions",
              { gapRef, priorDecisionRef: priorDecision },
            ),
          );
        }
        coveredGaps.set(gapRef, decision.path);
      }

      const [snapshotPath = "", gapId] = typeof gapRef === "string" ? gapRef.split("#", 2) : [];
      const snapshot = byPath.get(snapshotPath);
      const gap =
        snapshot?.schemaVersion === "startup_opportunity.gap_snapshot.v2" &&
        Array.isArray(snapshot.document.gaps)
          ? snapshot.document.gaps.find(
              (candidate) => isRecord(candidate) && candidate.gap_id === gapId,
            )
          : undefined;
      if (isRecord(gap)) {
        const impacts = new Set(
          Array.isArray(decision.document.expected_decision_impact)
            ? decision.document.expected_decision_impact
            : [],
        );
        if (
          !Array.isArray(gap.decision_impact) ||
          !gap.decision_impact.some((impact) => impacts.has(impact))
        ) {
          errors.push(
            issue(
              "adaptation.decision_impact_mismatch",
              `${decision.path}#/expected_decision_impact`,
              "decision impact does not cover its assessment gap",
            ),
          );
        }
        const action = String(decision.document.action);
        const rule = this.assessmentPolicy.add_unit_rules.find(
          (candidate) =>
            candidate.gap_type === gap.gap_type && candidate.dimension_id === gap.dimension_id,
        );
        if (action === "add_unit" && rule === undefined) {
          errors.push(
            issue(
              "adaptation.action_gap_not_allowed",
              decision.path,
              "add_unit is not allowed for this closed assessment gap",
            ),
          );
        }
        if (
          action === "stop_followup" &&
          !this.assessmentPolicy.stop_followup_rules.gap_types.includes(String(gap.gap_type)) &&
          !(
            Array.isArray(snapshot?.document.stop_signals) &&
            snapshot.document.stop_signals.some((signal) =>
              this.assessmentPolicy.stop_followup_rules.stop_signals.includes(String(signal)),
            )
          )
        ) {
          errors.push(
            issue(
              "adaptation.stop_basis_missing",
              decision.path,
              "stop_followup has no policy-authorized assessment stop basis",
            ),
          );
        }
      }

      const target = isRecord(decision.document.target_unit) ? decision.document.target_unit : null;
      if (target !== null) {
        for (const [field, value, index] of [
          ["unit_id", target.unit_id, unitIds],
          ["output_path", target.output_path, outputPaths],
        ] as const) {
          if (typeof value !== "string") {
            continue;
          }
          const prior = index.get(value);
          if (prior !== undefined) {
            errors.push(
              issue(
                `adaptation.target_${field}_batch_conflict`,
                decision.path,
                `multiple decisions declare the same target ${field}`,
                { value, priorDecisionRef: prior },
              ),
            );
          }
          index.set(value, decision.path);
        }
        if (
          plan?.schemaVersion === "startup_opportunity.research_plan.v1" &&
          (unitById(plan.document, String(target.unit_id)) !== undefined ||
            unitEntries(plan.document).some(
              (entry) => entry.unit.output_path === target.output_path,
            ))
        ) {
          errors.push(
            issue(
              "adaptation.target_conflict",
              `${decision.path}#/target_unit`,
              "assessment follow-up unit id or output path already exists in the current plan",
            ),
          );
        }
      }
    }

    if (
      plan?.schemaVersion === "startup_opportunity.research_plan.v1" &&
      manifest?.schemaVersion === "startup_opportunity.run_manifest.v1"
    ) {
      const followup = plan.document.followup_policy;
      if (
        decisions.some((decision) => decision.document.action === "add_unit") &&
        isRecord(followup) &&
        typeof followup.max_followup_rounds === "number" &&
        typeof manifest.document.followup_round === "number" &&
        manifest.document.followup_round >= followup.max_followup_rounds
      ) {
        errors.push(
          issue(
            "adaptation.followup_limit_reached",
            "",
            "assessment add_unit exceeds the published maximum follow-up rounds",
          ),
        );
      }
    }

    for (const snapshot of snapshots) {
      if (snapshot.document.based_on_plan_ref !== plan?.path) {
        continue;
      }
      for (const gap of Array.isArray(snapshot.document.gaps) ? snapshot.document.gaps : []) {
        if (!isRecord(gap) || typeof gap.gap_id !== "string") {
          continue;
        }
        const ref = `${snapshot.path}#${gap.gap_id}`;
        if (!coveredGaps.has(ref)) {
          errors.push(
            issue(
              "adaptation.gap_uncovered",
              ref,
              "every current assessment Gap requires one explicit closed disposition",
            ),
          );
        }
      }
    }

    const adaptationErrors = sortIssues(errors);
    return {
      schemaVersion: ADAPTATION_VALIDATION_RESULT_VERSION,
      valid: planValidation.valid && adaptationErrors.length === 0,
      planValidation,
      adaptationRefs: decisions.map((decision) => decision.path),
      adaptationErrors,
    };
  }

  private validateDecision(
    decisionPath: string,
    decision: Record<string, unknown>,
    decisionEnvelope: Record<string, unknown> | null,
    planPath: string,
    plan: Record<string, unknown>,
    manifest: Record<string, unknown>,
    documents: ReturnType<typeof documentMap>,
    errors: ValidationIssue[],
  ): void {
    const action = String(decision.action ?? "");
    const unitId = targetUnitId(decision);
    const target = unitId === null ? undefined : unitById(plan, unitId);
    const state = unitId === null ? "none" : statusOfUnit(manifest, unitId);
    const triggerRefs = Array.isArray(decision.trigger_gap_refs)
      ? decision.trigger_gap_refs.filter((ref): ref is string => typeof ref === "string")
      : [];
    const impacts = new Set(
      Array.isArray(decision.expected_decision_impact)
        ? decision.expected_decision_impact.filter(
            (impact): impact is string => typeof impact === "string",
          )
        : [],
    );
    const gaps = triggerRefs.map((ref) => gapByRef(documents, ref));

    for (const [index, resolved] of gaps.entries()) {
      if (resolved === null) {
        errors.push(
          issue(
            "adaptation.gap_missing",
            `${decisionPath}#/trigger_gap_refs/${index}`,
            "trigger gap does not resolve",
          ),
        );
        continue;
      }
      if (
        resolved.snapshot.run_id !== manifest.run_id ||
        resolved.snapshot.based_on_plan_ref !== planPath
      ) {
        errors.push(
          issue(
            "adaptation.gap_stale",
            `${decisionPath}#/trigger_gap_refs/${index}`,
            "trigger gap is not based on the current Run plan",
          ),
        );
      }
      const gapImpacts = Array.isArray(resolved.gap.decision_impact)
        ? resolved.gap.decision_impact.filter(
            (impact): impact is string => typeof impact === "string",
          )
        : [];
      if (!gapImpacts.some((impact) => impacts.has(impact))) {
        errors.push(
          issue(
            "adaptation.decision_impact_mismatch",
            `${decisionPath}#/expected_decision_impact`,
            "decision impact does not cover its trigger gap",
            {
              gapRef: triggerRefs[index],
            },
          ),
        );
      }
    }

    if (
      typeof decision.target_unit_ref === "string" &&
      !decision.target_unit_ref.startsWith(`${planPath}#`)
    ) {
      errors.push(
        issue(
          "adaptation.target_not_current_plan",
          `${decisionPath}#/target_unit_ref`,
          "target unit must belong to the current plan",
        ),
      );
    }
    const newUnit = isRecord(decision.target_unit) ? decision.target_unit : null;
    if (newUnit !== null) {
      const newId = String(newUnit.unit_id ?? "");
      const existingOutput = unitEntries(plan).find(
        (entry) => entry.unit.output_path === newUnit.output_path,
      );
      if (unitById(plan, newId) !== undefined) {
        errors.push(
          issue(
            "adaptation.target_unit_id_conflict",
            `${decisionPath}#/target_unit/unit_id`,
            "new unit id already exists in the current plan",
            { unitId: newId },
          ),
        );
      }
      if (existingOutput !== undefined) {
        errors.push(
          issue(
            "adaptation.target_output_conflict",
            `${decisionPath}#/target_unit/output_path`,
            "new unit output path already belongs to current plan work",
            { owner: existingOutput.unit.unit_id },
          ),
        );
      }
      for (const dependency of Array.isArray(newUnit.depends_on) ? newUnit.depends_on : []) {
        if (typeof dependency === "string" && unitById(plan, dependency) === undefined) {
          errors.push(
            issue(
              "adaptation.target_dependency_missing",
              `${decisionPath}#/target_unit/depends_on`,
              "new unit dependency is missing from the current plan",
              { dependency },
            ),
          );
        }
      }
    }

    const followup = plan.followup_policy;
    if (
      FOLLOWUP_ACTIONS.has(action) &&
      isRecord(followup) &&
      typeof followup.max_followup_rounds === "number" &&
      typeof manifest.followup_round === "number" &&
      manifest.followup_round >= followup.max_followup_rounds
    ) {
      errors.push(
        issue(
          "adaptation.followup_limit_reached",
          decisionPath,
          "plan-changing follow-up exceeds the published maximum",
          {
            followupRound: manifest.followup_round,
            maxFollowupRounds: followup.max_followup_rounds,
          },
        ),
      );
    }

    const requireState = (allowed: readonly string[]): void => {
      if (target === undefined || !allowed.includes(state)) {
        errors.push(
          issue(
            "adaptation.target_state_not_allowed",
            `${decisionPath}#/target_unit_ref`,
            "target unit state does not allow this action",
            { action, state, allowed },
          ),
        );
      }
    };

    switch (action) {
      case "add_unit":
        if (newUnit?.attempt !== 1 || newUnit.supersedes_unit_ref !== null) {
          errors.push(
            issue(
              "adaptation.add_unit_lineage_invalid",
              `${decisionPath}#/target_unit`,
              "add_unit must create attempt one without supersede lineage",
            ),
          );
        }
        break;
      case "cancel_unit":
        requireState(["active"]);
        break;
      case "skip_unit":
      case "reprioritize_unit":
        requireState(["pending"]);
        if (target?.unit.plan_disposition !== "enabled") {
          errors.push(
            issue(
              "adaptation.target_disposition_not_enabled",
              `${decisionPath}#/target_unit_ref`,
              "pending target must still be enabled",
            ),
          );
        }
        if (action === "skip_unit") {
          const preKillGaps = gaps.filter(
            (resolved) =>
              resolved !== null &&
              resolved.gap.gap_type === this.discoveryBindingPolicy.trigger_gap_type,
          );
          if (preKillGaps.length > 0) {
            const subjects = [
              ...new Set(preKillGaps.map((resolved) => String(resolved?.gap.subject_ref ?? ""))),
            ];
            const inputRefs = Array.isArray(target?.unit.input_refs)
              ? target.unit.input_refs.filter((ref): ref is string => typeof ref === "string")
              : [];
            const candidatePattern = new RegExp(
              this.discoveryBindingPolicy.candidate_ref_pattern,
              "u",
            );
            const candidateRefs = inputRefs.filter((ref) => candidatePattern.test(ref));
            const subject = subjects[0];
            const candidate = subject === undefined ? undefined : documents.get(subject);
            const candidateValidation =
              candidate?.envelope === null || candidate?.envelope === undefined
                ? null
                : this.artifacts.validateDocument(candidate.envelope, candidate.path);
            if (
              subjects.length !== 1 ||
              subject === undefined ||
              !candidatePattern.test(subject) ||
              !inputRefs.includes(subject)
            ) {
              errors.push(
                issue(
                  "adaptation.pre_kill_candidate_target_mismatch",
                  `${decisionPath}#/target_unit_ref`,
                  "candidate_pre_killed skip must target a pending unit that explicitly consumes the exact candidate revision",
                  { subjects, inputRefs },
                ),
              );
            }
            if (
              subject === undefined ||
              candidate?.schemaVersion !== "startup_opportunity.discovery_candidate.v1" ||
              candidate.envelope === null ||
              candidate.envelope.artifact_path !== subject ||
              candidate.envelope.artifact_type !== "startup_opportunity.discovery_candidate.v1" ||
              candidateValidation?.valid !== true ||
              candidate.envelope.run_id !== plan.run_id ||
              candidate.document.run_id !== plan.run_id ||
              candidate.document.research_plan_ref !== planPath
            ) {
              errors.push(
                issue(
                  "adaptation.pre_kill_candidate_binding_invalid",
                  `${decisionPath}#/trigger_gap_refs`,
                  "candidate_pre_killed must resolve the exact same-Run typed candidate envelope bound to the current Plan revision",
                  {
                    subject: subject ?? null,
                    candidateSchemaVersion: candidate?.schemaVersion ?? null,
                    candidateRunId: candidate?.document.run_id ?? null,
                    candidatePlanRef: candidate?.document.research_plan_ref ?? null,
                    expectedRunId: plan.run_id,
                    expectedPlanRef: planPath,
                  },
                ),
              );
            }
            if (
              candidateRefs.length !== 1 ||
              subject === undefined ||
              candidateRefs[0] !== subject
            ) {
              errors.push(
                issue(
                  "adaptation.pre_kill_shared_candidate_skip_forbidden",
                  `${decisionPath}#/target_unit_ref`,
                  "a unit serving retained or other candidates must remain enabled or be superseded",
                  { subject: subject ?? null, candidateRefs },
                ),
              );
            }
          }
        }
        break;
      case "retry_unit":
        requireState(["failed"]);
        if (
          target === undefined ||
          newUnit === null ||
          newUnit.supersedes_unit_ref !== decision.target_unit_ref ||
          newUnit.unit_type !== target.unit.unit_type ||
          newUnit.attempt !== Number(target.unit.attempt) + 1 ||
          newUnit.output_path === target.unit.output_path
        ) {
          errors.push(
            issue(
              "adaptation.retry_lineage_invalid",
              `${decisionPath}#/target_unit`,
              "retry must preserve type, advance attempt, reference the failed unit, and use a new output path",
            ),
          );
        }
        break;
      case "supersede_unit":
        requireState(["pending", "active"]);
        if (newUnit === null || newUnit.supersedes_unit_ref !== decision.target_unit_ref) {
          errors.push(
            issue(
              "adaptation.supersede_lineage_invalid",
              `${decisionPath}#/target_unit`,
              "superseding unit must reference the replaced unit",
            ),
          );
        }
        break;
      case "continue_existing_plan":
        requireState(["pending", "active"]);
        break;
      case "request_clarification":
        if (
          !["planned", "researching", "synthesizing", "reviewing"].includes(String(manifest.status))
        ) {
          errors.push(
            issue(
              "adaptation.clarification_state_not_allowed",
              decisionPath,
              "current Run state cannot enter clarification",
              { status: manifest.status },
            ),
          );
        }
        break;
      case "stop_followup": {
        const hasStopBasis = gaps.some(
          (resolved) =>
            resolved !== null &&
            ((Array.isArray(resolved.snapshot.stop_signals) &&
              resolved.snapshot.stop_signals.length > 0) ||
              resolved.gap.gap_type === "no_material_new_evidence" ||
              resolved.gap.gap_type === "source_repetition" ||
              resolved.gap.gap_type === "method_boundary" ||
              resolved.gap.gap_type === "no_information_gain"),
        );
        if (!hasStopBasis) {
          errors.push(
            issue(
              "adaptation.stop_basis_missing",
              decisionPath,
              "stop_followup requires a closed stop signal or stop gap",
            ),
          );
        }
        break;
      }
      case "terminate_insufficient_evidence": {
        const blockingGaps = gaps.filter(
          (resolved) => resolved !== null && resolved.gap.severity === "blocking",
        );
        if (blockingGaps.length === 0) {
          errors.push(
            issue(
              "adaptation.termination_basis_missing",
              decisionPath,
              "termination requires a blocking evidence gap",
            ),
          );
        }
        if (
          blockingGaps.some(
            (resolved) => resolved !== null && resolved.gap.gap_type === "runtime_blocked",
          )
        ) {
          errors.push(
            issue(
              "adaptation.termination_runtime_blocked",
              decisionPath,
              "runtime failure must be reported as runtime-blocked and cannot become a research conclusion",
            ),
          );
        }
        const followupAvailable = blockingGaps.some((resolved) => {
          if (resolved === null) {
            return false;
          }
          const recommended = Array.isArray(resolved.gap.recommended_unit_types)
            ? resolved.gap.recommended_unit_types
            : typeof resolved.gap.recommended_unit_type === "string"
              ? [resolved.gap.recommended_unit_type]
              : [];
          const stopSignals = Array.isArray(resolved.snapshot.stop_signals)
            ? resolved.snapshot.stop_signals
            : [];
          const allowedActions = Array.isArray(resolved.gap.allowed_actions)
            ? resolved.gap.allowed_actions
            : [];
          const boundedActionAvailable = allowedActions.some((candidate) =>
            ["add_unit", "run_solution_generation", "run_candidate_evaluation"].includes(
              String(candidate),
            ),
          );
          const closedMethodBoundary =
            ["method_boundary", "no_information_gain"].includes(String(resolved.gap.gap_type)) &&
            stopSignals.some((signal) =>
              [
                "method_boundary_reached",
                "no_material_new_evidence",
                "source_repetition",
                "max_followup_rounds_reached",
              ].includes(String(signal)),
            );
          return (
            !closedMethodBoundary &&
            (recommended.length > 0 || boundedActionAvailable) &&
            isRecord(followup) &&
            typeof followup.max_followup_rounds === "number" &&
            typeof manifest.followup_round === "number" &&
            manifest.followup_round < followup.max_followup_rounds
          );
        });
        if (followupAvailable) {
          errors.push(
            issue(
              "adaptation.termination_followup_available",
              decisionPath,
              "termination cannot bypass an executable bounded follow-up",
            ),
          );
        }
        if (decisionEnvelope !== null && Array.isArray(decisionEnvelope.input_refs)) {
          const allowedRefs = new Set<string>([planPath]);
          for (const [index, resolved] of gaps.entries()) {
            if (resolved === null) {
              continue;
            }
            const triggerRef = triggerRefs[index];
            if (triggerRef !== undefined) {
              allowedRefs.add(triggerRef);
              allowedRefs.add(triggerRef.split("#", 1)[0] ?? triggerRef);
            }
            for (const ref of [
              ...(Array.isArray(resolved.gap.basis_refs) ? resolved.gap.basis_refs : []),
              ...(Array.isArray(resolved.gap.evidence_refs) ? resolved.gap.evidence_refs : []),
              ...(Array.isArray(resolved.snapshot.observed_artifact_refs)
                ? resolved.snapshot.observed_artifact_refs
                : []),
              ...(isRecord(resolved.gap.triggered_by) &&
              Array.isArray(resolved.gap.triggered_by.observed_artifact_refs)
                ? resolved.gap.triggered_by.observed_artifact_refs
                : []),
            ]) {
              if (typeof ref === "string") {
                allowedRefs.add(ref);
              }
            }
            if (typeof resolved.snapshot.trigger_event_ref === "string") {
              allowedRefs.add(resolved.snapshot.trigger_event_ref);
            }
          }
          if (typeof decision.user_decision_ref === "string") {
            allowedRefs.add(decision.user_decision_ref);
          }
          const unboundRefs = decisionEnvelope.input_refs.filter(
            (ref): ref is string => typeof ref === "string" && !allowedRefs.has(ref),
          );
          if (unboundRefs.length > 0) {
            errors.push(
              issue(
                "adaptation.termination_basis_unclosed",
                `${decisionPath}#/input_refs`,
                "termination inputs must be closed by the trigger Gap basis",
                { unboundRefs: [...new Set(unboundRefs)].sort() },
              ),
            );
          }
        }
        break;
      }
    }
  }
}

export async function createAdaptationPolicyValidator(
  root = process.cwd(),
): Promise<AdaptationPolicyValidator> {
  return new AdaptationPolicyValidator(
    await createPlanSemanticValidator(root),
    await createAssessmentPlanSemanticValidator(root),
    await loadAssessmentAdaptationPolicy(root),
    await loadDiscoveryAdaptationBindingPolicy(root),
    await createArtifactValidator(root),
  );
}

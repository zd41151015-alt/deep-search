import { canonicalContentHash, canonicalJson, sha256Hex } from "../artifact-store/canonical.js";
import type {
  ArtifactValidator,
  DocumentBundle,
  DocumentBundleValidationResult,
} from "../validators/artifact-validator.js";
import { createArtifactValidator } from "../validators/artifact-validator.js";
import {
  type AssessmentObservedArtifactIdentity,
  assessmentCoverageKey,
  assessmentSnapshotCycleKey,
} from "../validators/assessment-adaptation-identities.js";
import {
  documentMap,
  isRecord,
  leafPlanningContexts,
  statusOfUnit,
  targetByRef,
} from "./contracts.js";
import {
  createAssessmentPlanSemanticValidator,
  type PlanSemanticValidator,
  type PlanValidationResult,
} from "./plan-validator.js";

export const ASSESSMENT_GAP_ANALYSIS_RESULT_VERSION =
  "startup_opportunity.assessment_gap_analysis_result.v1" as const;

export type AssessmentCoverageDimension =
  | "buyer_language_and_willingness_to_pay"
  | "acquisition_and_distribution";

export interface AnalyzeAssessmentGapInput {
  readonly documentBundle: DocumentBundle;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly triggerKind: "wave_completed" | "resume_reconciliation";
  readonly waveId: string;
  readonly triggerEventRef: string | null;
  readonly dimensionId: AssessmentCoverageDimension;
  readonly observedArtifactRefs: readonly string[];
  readonly materialNewEvidenceObserved: boolean;
  readonly limitations?: readonly string[];
}

export interface AssessmentGapAnalysisResult {
  readonly schemaVersion: typeof ASSESSMENT_GAP_ANALYSIS_RESULT_VERSION;
  readonly valid: boolean;
  readonly planValidation: PlanValidationResult;
  readonly artifactValidation: DocumentBundleValidationResult | null;
  readonly snapshotPath: string | null;
  readonly snapshot: Record<string, unknown> | null;
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
  }[];
}

function analysisError(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
) {
  return { code, message, details } as const;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function snapshotPath(snapshotId: string): string {
  return `adaptations/gap-snapshots/${snapshotId}.r1.json`;
}

function taskForBranch(
  documents: ReturnType<typeof documentMap>,
  branchPath: string,
  unitId: unknown,
): { readonly path: string; readonly document: Record<string, unknown> } | null {
  const matches = [...documents.values()].filter(
    (entry) =>
      entry.schemaVersion === "startup_opportunity.research_task.v1" &&
      entry.document.allowed_output_path === branchPath &&
      entry.document.unit_id === unitId,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export class AssessmentGapAnalyzer {
  constructor(
    private readonly plans: PlanSemanticValidator,
    private readonly artifacts: ArtifactValidator,
  ) {}

  analyze(input: AnalyzeAssessmentGapInput): AssessmentGapAnalysisResult {
    const planValidation = this.plans.validateDocumentBundle(input.documentBundle);
    const errors: ReturnType<typeof analysisError>[] = [];
    if (!planValidation.valid) {
      errors.push(
        analysisError(
          "assessment_gap.bundle_invalid",
          "assessment Gap analysis requires a valid current Run contract bundle",
        ),
      );
    }
    const documents = documentMap(input.documentBundle);
    const context = leafPlanningContexts(input.documentBundle)[0];
    const manifestBinding = context?.document.manifest_binding;
    const planBinding = context?.document.target_plan_binding;
    const manifest = isRecord(manifestBinding)
      ? targetByRef(documents, manifestBinding.manifest_ref)
      : null;
    const plan = isRecord(planBinding) ? targetByRef(documents, planBinding.plan_ref) : null;
    if (
      context?.document.mode !== "concept_evidence_assessment" ||
      context.document.phase !== "assessment" ||
      context.document.validation_stage !== "current_plan" ||
      manifest?.schemaVersion !== "startup_opportunity.run_manifest.v1" ||
      plan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
      manifest.document.current_plan_ref !== plan.path ||
      manifest.document.plan_revision !== plan.document.revision
    ) {
      errors.push(
        analysisError(
          "assessment_gap.current_state_missing",
          "analysis requires the exact current assessment Manifest, Planning Context, and Research Plan",
        ),
      );
    }

    const assessmentPlans = [...documents.values()].filter(
      (entry) =>
        entry.schemaVersion === "startup_opportunity.concept_evidence_assessment_plan.v1" &&
        entry.document.research_plan_ref === plan?.path,
    );
    const referencedAssessmentParents = new Set(
      assessmentPlans.flatMap((entry) =>
        typeof entry.document.parent_plan_ref === "string" ? [entry.document.parent_plan_ref] : [],
      ),
    );
    const currentAssessmentPlans = assessmentPlans.filter(
      (entry) => !referencedAssessmentParents.has(entry.path),
    );
    const assessmentPlan =
      currentAssessmentPlans.length === 1 ? (currentAssessmentPlans[0] ?? null) : null;
    const subject = targetByRef(documents, assessmentPlan?.document.concept_hypothesis_ref);
    const scope = targetByRef(documents, subject?.document.scope_frame_ref);
    const dimension = records(assessmentPlan?.document.dimensions).find(
      (entry) => entry.dimension_id === input.dimensionId,
    );
    if (
      assessmentPlan === null ||
      subject?.schemaVersion !== "startup_opportunity.concept_hypothesis.v1" ||
      scope?.schemaVersion !== "startup_opportunity.scope_frame.v1" ||
      dimension === undefined
    ) {
      errors.push(
        analysisError(
          "assessment_gap.assessment_binding_missing",
          "analysis requires one current assessment plan, subject, Scope Frame, and declared dimension",
        ),
      );
    }

    if (
      input.triggerKind === "wave_completed"
        ? input.triggerEventRef !== null
        : typeof input.triggerEventRef !== "string"
    ) {
      errors.push(
        analysisError(
          "assessment_gap.trigger_shape_invalid",
          "wave_completed forbids an Event ref and resume_reconciliation requires one",
        ),
      );
    }
    const triggerEvent = targetByRef(documents, input.triggerEventRef);
    if (
      input.triggerEventRef !== null &&
      (triggerEvent?.schemaVersion !== "startup_opportunity.event.v1" ||
        triggerEvent.document.run_id !== manifest?.document.run_id)
    ) {
      errors.push(
        analysisError(
          "assessment_gap.trigger_event_invalid",
          "resume trigger must resolve to an exact same-Run Event",
        ),
      );
    }
    const wave = records(plan?.document.waves).find((entry) => entry.wave_id === input.waveId);
    if (wave === undefined) {
      errors.push(
        analysisError(
          "assessment_gap.wave_missing",
          "analysis wave is not declared by the current Research Plan",
          { waveId: input.waveId },
        ),
      );
    }

    const observedRefs = uniqueSorted(input.observedArtifactRefs);
    if (observedRefs.length === 0 || observedRefs.length !== input.observedArtifactRefs.length) {
      errors.push(
        analysisError(
          "assessment_gap.observed_set_invalid",
          "observed branch Artifact refs must be non-empty and unique",
        ),
      );
    }
    const observed: AssessmentObservedArtifactIdentity[] = [];
    const branches: Record<string, unknown>[] = [];
    for (const ref of observedRefs) {
      const branch = documents.get(ref);
      const task = taskForBranch(documents, ref, branch?.document.unit_id);
      if (
        manifest === null ||
        plan === null ||
        assessmentPlan === null ||
        subject === null ||
        scope === null ||
        branch?.schemaVersion !==
          "startup_opportunity.concept_evidence_assessment_branch_result.v1" ||
        task === null ||
        branch.document.run_id !== manifest?.document.run_id ||
        branch.document.concept_hypothesis_ref !== subject?.path ||
        branch.document.assessment_plan_ref !== assessmentPlan?.path ||
        branch.document.dimension_id !== input.dimensionId ||
        task.document.run_id !== manifest?.document.run_id ||
        task.document.research_plan_ref !== plan?.path ||
        task.document.assessment_plan_ref !== assessmentPlan?.path ||
        task.document.target_subject_ref !== subject?.path ||
        task.document.scope_frame_ref !== scope?.path ||
        !strings(manifest?.document.artifact_refs).includes(ref) ||
        !strings(manifest?.document.artifact_refs).includes(task.path)
      ) {
        errors.push(
          analysisError(
            "assessment_gap.observed_artifact_invalid",
            "observed branch does not exactly match its same-Run task, plan, subject, scope, or Manifest state",
            { artifactRef: ref },
          ),
        );
        continue;
      }
      const unitState = statusOfUnit(manifest.document, String(branch.document.unit_id));
      if (unitState === "pending" || unitState === "active") {
        errors.push(
          analysisError(
            "assessment_gap.unit_not_terminal",
            "observed branch unit must be terminal before coverage analysis",
            { artifactRef: ref, unitState },
          ),
        );
      }
      branches.push(branch.document);
      observed.push({
        artifact_ref: ref,
        artifact_type: branch.schemaVersion,
        content_hash: canonicalContentHash(branch.document),
        task_ref: task.path,
        task_hash: canonicalContentHash(task.document),
        unit_id: String(branch.document.unit_id),
        attempt: Number(task.document.attempt),
        unit_state: unitState,
        branch_status: String(branch.document.branch_status),
      });
    }

    if (
      errors.length > 0 ||
      manifest === null ||
      plan === null ||
      assessmentPlan === null ||
      subject === null ||
      scope === null ||
      dimension === undefined
    ) {
      return {
        schemaVersion: ASSESSMENT_GAP_ANALYSIS_RESULT_VERSION,
        valid: false,
        planValidation,
        artifactValidation: null,
        snapshotPath: null,
        snapshot: null,
        errors,
      };
    }

    const identity = {
      schema_version: "startup_opportunity.assessment_coverage_identity.v1" as const,
      run_id: String(manifest.document.run_id),
      subject_ref: subject.path,
      scope_frame_ref: scope.path,
      scope_frame_hash: canonicalContentHash(scope.document),
      research_plan_ref: plan.path,
      research_plan_revision: Number(plan.document.revision),
      research_plan_hash: canonicalContentHash(plan.document),
      assessment_plan_ref: assessmentPlan.path,
      assessment_plan_revision: Number(assessmentPlan.document.revision),
      assessment_plan_hash: canonicalContentHash(assessmentPlan.document),
      dimension_id: input.dimensionId,
      observed_artifacts: observed,
    };
    const coverageKey = assessmentCoverageKey(identity);
    if (
      [...documents.values()].some(
        (entry) =>
          entry.schemaVersion === "startup_opportunity.gap_snapshot.assessment.current" &&
          entry.document.coverage_key === coverageKey,
      )
    ) {
      return {
        schemaVersion: ASSESSMENT_GAP_ANALYSIS_RESULT_VERSION,
        valid: false,
        planValidation,
        artifactValidation: null,
        snapshotPath: null,
        snapshot: null,
        errors: [
          analysisError(
            "assessment_gap.coverage_duplicate",
            "the same exact assessment coverage identity already has an immutable Gap Snapshot",
            { coverageKey },
          ),
        ],
      };
    }

    const sufficient =
      branches.length > 0 &&
      branches.every((branch) => branch.decision_sufficiency === "sufficient");
    const followup = isRecord(assessmentPlan.document.followup_policy)
      ? assessmentPlan.document.followup_policy
      : {};
    const followupLimitReached =
      typeof followup.max_followup_rounds === "number" &&
      Number(manifest.document.followup_round) >= followup.max_followup_rounds;
    const executableChange = branches.some(
      (branch) => strings(branch.what_would_change_decision).length > 0,
    );
    const noExecutableFollowup =
      !sufficient &&
      input.materialNewEvidenceObserved &&
      (followupLimitReached || !executableChange);
    const gapType = sufficient
      ? "coverage_sufficient"
      : !input.materialNewEvidenceObserved
        ? "no_material_new_evidence"
        : noExecutableFollowup
          ? "no_executable_followup"
          : input.dimensionId === "buyer_language_and_willingness_to_pay"
            ? "buyer_evidence_insufficient"
            : "acquisition_evidence_insufficient";
    const followupStatus = gapType.endsWith("_insufficient") ? "executable" : "stop";
    const recommendedUnitType =
      followupStatus === "executable"
        ? input.dimensionId === "buyer_language_and_willingness_to_pay"
          ? "buyer_language"
          : "acquisition"
        : null;
    const stopSignals =
      gapType === "coverage_sufficient"
        ? ["coverage_sufficient"]
        : gapType === "no_material_new_evidence"
          ? ["no_material_new_evidence"]
          : gapType === "no_executable_followup"
            ? [
                "no_executable_followup",
                ...(followupLimitReached ? ["max_followup_rounds_reached"] : []),
              ]
            : [];
    const branchLimitations = branches.flatMap((branch) => strings(branch.limitations));
    const limitations = uniqueSorted([
      "Synthetic or unverified inputs remain subject to their published Evidence limitations.",
      ...branchLimitations,
      ...(input.limitations ?? []),
    ]);
    const basisRefs = uniqueSorted([
      plan.path,
      assessmentPlan.path,
      subject.path,
      scope.path,
      ...observed.flatMap((item) => [item.artifact_ref, item.task_ref]),
    ]);
    const evidenceRefs = uniqueSorted(branches.flatMap((branch) => strings(branch.evidence_refs)));
    const cycleKey = assessmentSnapshotCycleKey({
      coverage_key: coverageKey,
      trigger_kind: input.triggerKind,
      wave_id: input.waveId,
      trigger_event_ref: input.triggerEventRef,
    });
    const gapId = `gap_${input.dimensionId}_${sha256Hex(coverageKey).slice(0, 16)}`;
    const snapshot: Record<string, unknown> = JSON.parse(
      canonicalJson({
        schema_version: "startup_opportunity.gap_snapshot.assessment.current",
        snapshot_id: input.snapshotId,
        snapshot_cycle_key: cycleKey,
        coverage_key: coverageKey,
        run_id: manifest.document.run_id,
        based_on_plan_ref: plan.path,
        based_on_plan_revision: plan.document.revision,
        based_on_plan_hash: identity.research_plan_hash,
        assessment_plan_ref: assessmentPlan.path,
        assessment_plan_revision: assessmentPlan.document.revision,
        assessment_plan_hash: identity.assessment_plan_hash,
        subject_ref: subject.path,
        scope_frame_ref: scope.path,
        scope_frame_hash: identity.scope_frame_hash,
        revision: 1,
        parent_snapshot_ref: null,
        created_at: input.createdAt,
        trigger_kind: input.triggerKind,
        trigger_event_ref: input.triggerEventRef,
        phase: "assessment",
        wave_id: input.waveId,
        observed_artifacts: observed,
        gaps: [
          {
            gap_id: gapId,
            coverage_key: coverageKey,
            subject_ref: subject.path,
            dimension_id: input.dimensionId,
            gap_type: gapType,
            detection_mode: "deterministic",
            coverage_status: sufficient
              ? "sufficient"
              : noExecutableFollowup
                ? "no_executable_followup"
                : "insufficient",
            decision_impact: uniqueSorted(strings(dimension.decision_impact)),
            severity: followupStatus === "executable" ? "blocking" : "material",
            research_goal: `Resolve current ${input.dimensionId} decision coverage for the frozen concept.`,
            basis_refs: basisRefs,
            evidence_refs: evidenceRefs,
            recommended_unit_type: recommendedUnitType,
            followup_status: followupStatus,
            limitations,
          },
        ],
        material_new_evidence_observed: input.materialNewEvidenceObserved,
        stop_signals: uniqueSorted(stopSignals),
        limitations,
      }),
    ) as Record<string, unknown>;
    const outputPath = snapshotPath(input.snapshotId);
    const candidateBundle: DocumentBundle = {
      ...input.documentBundle,
      documents: [...input.documentBundle.documents, { path: outputPath, document: snapshot }],
    };
    const artifactValidation = this.artifacts.validateDocumentBundle(candidateBundle);
    if (!artifactValidation.valid) {
      return {
        schemaVersion: ASSESSMENT_GAP_ANALYSIS_RESULT_VERSION,
        valid: false,
        planValidation,
        artifactValidation,
        snapshotPath: null,
        snapshot: null,
        errors: [
          analysisError(
            "assessment_gap.output_invalid",
            "deterministic Gap Snapshot failed the published Artifact contract",
          ),
        ],
      };
    }
    return {
      schemaVersion: ASSESSMENT_GAP_ANALYSIS_RESULT_VERSION,
      valid: true,
      planValidation,
      artifactValidation,
      snapshotPath: outputPath,
      snapshot,
      errors: [],
    };
  }
}

export async function createAssessmentGapAnalyzer(
  root = process.cwd(),
): Promise<AssessmentGapAnalyzer> {
  return new AssessmentGapAnalyzer(
    await createAssessmentPlanSemanticValidator(root),
    await createArtifactValidator(root),
  );
}

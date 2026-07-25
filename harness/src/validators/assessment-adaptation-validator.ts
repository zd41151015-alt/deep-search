import { statusOfUnit } from "../adaptation/contracts.js";
import { canonicalContentHash } from "../artifact-store/canonical.js";
import {
  type AssessmentObservedArtifactIdentity,
  assessmentCoverageKey,
  assessmentSnapshotCycleKey,
} from "./assessment-adaptation-identities.js";
import type { ValidationIssue } from "./schema-bundle.js";

export interface AssessmentAdaptationDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return { code, keyword: "assessment_adaptation", instancePath, schemaPath: "", message, details };
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function targetByRef(
  documents: ReadonlyMap<string, AssessmentAdaptationDocument>,
  ref: unknown,
): AssessmentAdaptationDocument | null {
  return typeof ref === "string" ? (documents.get(ref.split("#", 1)[0] ?? "") ?? null) : null;
}

function gapByRef(
  documents: ReadonlyMap<string, AssessmentAdaptationDocument>,
  ref: unknown,
): {
  readonly snapshot: AssessmentAdaptationDocument;
  readonly gap: Record<string, unknown>;
} | null {
  if (typeof ref !== "string") {
    return null;
  }
  const [snapshotPath = "", gapId] = ref.split("#", 2);
  const snapshot = documents.get(snapshotPath);
  if (
    gapId === undefined ||
    snapshot?.schemaVersion !== "startup_opportunity.gap_snapshot.v2" ||
    !Array.isArray(snapshot.document.gaps)
  ) {
    return null;
  }
  const gap = snapshot.document.gaps.find(
    (candidate) => isRecord(candidate) && candidate.gap_id === gapId,
  );
  return isRecord(gap) ? { snapshot, gap } : null;
}

function observedIdentity(value: Record<string, unknown>): AssessmentObservedArtifactIdentity {
  return {
    artifact_ref: String(value.artifact_ref),
    artifact_type: String(value.artifact_type),
    content_hash: String(value.content_hash),
    task_ref: String(value.task_ref),
    task_hash: String(value.task_hash),
    unit_id: String(value.unit_id),
    attempt: Number(value.attempt),
    unit_state: String(value.unit_state),
    branch_status: String(value.branch_status),
  };
}

function expectedUnitType(gapType: unknown): string | null {
  return gapType === "buyer_evidence_insufficient"
    ? "buyer_language"
    : gapType === "acquisition_evidence_insufficient"
      ? "acquisition"
      : null;
}

function expectedDimension(unitType: unknown): string | null {
  return unitType === "buyer_language"
    ? "buyer_language_and_willingness_to_pay"
    : unitType === "acquisition"
      ? "acquisition_and_distribution"
      : null;
}

function researchPlanAncestryContainsAdaptation(
  candidate: AssessmentAdaptationDocument | null,
  ancestorPath: unknown,
  adaptationRef: string,
  documents: ReadonlyMap<string, AssessmentAdaptationDocument>,
): boolean {
  if (
    candidate?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
    typeof ancestorPath !== "string"
  ) {
    return false;
  }
  const seen = new Set<string>();
  let cursor: AssessmentAdaptationDocument | null = candidate;
  let adaptationFound = false;
  while (cursor?.schemaVersion === "startup_opportunity.research_plan.v1") {
    if (cursor.path === ancestorPath) {
      return adaptationFound;
    }
    if (seen.has(cursor.path)) {
      return false;
    }
    seen.add(cursor.path);
    adaptationFound ||= stringArray(cursor.document.triggered_by_adaptation_refs).includes(
      adaptationRef,
    );
    cursor = targetByRef(documents, cursor.document.parent_plan_ref);
  }
  return false;
}

export function validateAssessmentAdaptationContract(
  input: readonly AssessmentAdaptationDocument[],
): readonly ValidationIssue[] {
  const snapshots = input.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.gap_snapshot.v2",
  );
  const decisions = input.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.adaptation_decision.v3",
  );
  if (snapshots.length === 0 && decisions.length === 0) {
    return [];
  }

  const errors: ValidationIssue[] = [];
  const documents = new Map(input.map((entry) => [entry.path, entry]));
  const manifest = documents.get("manifest.json");
  if (manifest?.schemaVersion !== "startup_opportunity.run_manifest.v1") {
    return [
      issue(
        "assessment_adaptation.manifest_missing",
        "manifest.json",
        "G1.3 contracts require the current Run Manifest",
      ),
    ];
  }
  const currentPlan = targetByRef(documents, manifest.document.current_plan_ref);
  const appliedDecisionRefs = new Set(stringArray(manifest.document.applied_adaptation_refs));

  const seenCoverage = new Map<string, string>();
  for (const snapshot of snapshots) {
    const plan = targetByRef(documents, snapshot.document.based_on_plan_ref);
    const assessmentPlan = targetByRef(documents, snapshot.document.assessment_plan_ref);
    const subject = targetByRef(documents, snapshot.document.subject_ref);
    const scope = targetByRef(documents, snapshot.document.scope_frame_ref);
    const gap =
      Array.isArray(snapshot.document.gaps) && isRecord(snapshot.document.gaps[0])
        ? snapshot.document.gaps[0]
        : null;
    const observed = Array.isArray(snapshot.document.observed_artifacts)
      ? snapshot.document.observed_artifacts.filter(isRecord).map(observedIdentity)
      : [];
    const snapshotDecisionRefs = decisions
      .filter((decision) =>
        stringArray(decision.document.trigger_gap_refs).some((ref) =>
          ref.startsWith(`${snapshot.path}#`),
        ),
      )
      .map((decision) => decision.path);
    const historicalApplied =
      snapshotDecisionRefs.length > 0 &&
      snapshotDecisionRefs.every((ref) => appliedDecisionRefs.has(ref)) &&
      snapshotDecisionRefs.every((ref) =>
        researchPlanAncestryContainsAdaptation(
          currentPlan,
          snapshot.document.based_on_plan_ref,
          ref,
          documents,
        ),
      );
    const currentBinding =
      manifest.document.current_plan_ref === snapshot.document.based_on_plan_ref &&
      manifest.document.plan_revision === snapshot.document.based_on_plan_revision;

    if (
      plan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
      (!currentBinding && !historicalApplied) ||
      plan.document.revision !== snapshot.document.based_on_plan_revision ||
      canonicalContentHash(plan.document) !== snapshot.document.based_on_plan_hash ||
      plan.document.run_id !== manifest.document.run_id ||
      snapshot.document.run_id !== manifest.document.run_id
    ) {
      errors.push(
        issue(
          "assessment_adaptation.plan_stale",
          snapshot.path,
          "Gap Snapshot is not bound to the current immutable Research Plan",
        ),
      );
    }
    if (
      assessmentPlan?.schemaVersion !== "startup_opportunity.concept_evidence_assessment_plan.v1" ||
      assessmentPlan.document.research_plan_ref !== snapshot.document.based_on_plan_ref ||
      assessmentPlan.document.revision !== snapshot.document.assessment_plan_revision ||
      canonicalContentHash(assessmentPlan.document) !== snapshot.document.assessment_plan_hash ||
      assessmentPlan.document.run_id !== manifest.document.run_id ||
      assessmentPlan.document.concept_hypothesis_ref !== snapshot.document.subject_ref
    ) {
      errors.push(
        issue(
          "assessment_adaptation.assessment_plan_stale",
          `${snapshot.path}#/assessment_plan_ref`,
          "Gap Snapshot assessment plan binding is stale or branched",
        ),
      );
    }
    if (
      subject?.schemaVersion !== "startup_opportunity.concept_hypothesis.v1" ||
      subject.document.scope_frame_ref !== snapshot.document.scope_frame_ref ||
      scope?.schemaVersion !== "startup_opportunity.scope_frame.v1" ||
      canonicalContentHash(scope.document) !== snapshot.document.scope_frame_hash ||
      subject.document.run_id !== manifest.document.run_id ||
      scope.document.run_id !== manifest.document.run_id
    ) {
      errors.push(
        issue(
          "assessment_adaptation.subject_scope_mismatch",
          snapshot.path,
          "Gap Snapshot subject or scope binding differs from the current assess contract",
        ),
      );
    }

    for (const [index, observation] of observed.entries()) {
      const branch = documents.get(observation.artifact_ref);
      const task = documents.get(observation.task_ref);
      if (
        branch?.schemaVersion !==
          "startup_opportunity.concept_evidence_assessment_branch_result.v1" ||
        task?.schemaVersion !== "startup_opportunity.research_task.v1" ||
        canonicalContentHash(branch.document) !== observation.content_hash ||
        canonicalContentHash(task.document) !== observation.task_hash ||
        branch.document.run_id !== manifest.document.run_id ||
        task.document.run_id !== manifest.document.run_id ||
        branch.document.unit_id !== observation.unit_id ||
        task.document.unit_id !== observation.unit_id ||
        task.document.attempt !== observation.attempt ||
        branch.document.branch_status !== observation.branch_status ||
        task.document.research_plan_ref !== snapshot.document.based_on_plan_ref ||
        task.document.assessment_plan_ref !== snapshot.document.assessment_plan_ref ||
        task.document.target_subject_ref !== snapshot.document.subject_ref ||
        task.document.scope_frame_ref !== snapshot.document.scope_frame_ref ||
        task.document.allowed_output_path !== observation.artifact_ref ||
        statusOfUnit(manifest.document, observation.unit_id) !== observation.unit_state ||
        !stringArray(manifest.document.artifact_refs).includes(observation.artifact_ref)
      ) {
        errors.push(
          issue(
            "assessment_adaptation.observed_artifact_mismatch",
            `${snapshot.path}#/observed_artifacts/${index}`,
            "observed Artifact/hash or task/unit/attempt state binding is stale or forged",
            { artifactRef: observation.artifact_ref, unitId: observation.unit_id },
          ),
        );
      }
    }

    if (gap !== null) {
      const identity = {
        schema_version: "startup_opportunity.assessment_coverage_identity.v1" as const,
        run_id: String(snapshot.document.run_id),
        subject_ref: String(snapshot.document.subject_ref),
        scope_frame_ref: String(snapshot.document.scope_frame_ref),
        scope_frame_hash: String(snapshot.document.scope_frame_hash),
        research_plan_ref: String(snapshot.document.based_on_plan_ref),
        research_plan_revision: Number(snapshot.document.based_on_plan_revision),
        research_plan_hash: String(snapshot.document.based_on_plan_hash),
        assessment_plan_ref: String(snapshot.document.assessment_plan_ref),
        assessment_plan_revision: Number(snapshot.document.assessment_plan_revision),
        assessment_plan_hash: String(snapshot.document.assessment_plan_hash),
        dimension_id: String(gap.dimension_id),
        observed_artifacts: observed,
      };
      const expectedCoverage = assessmentCoverageKey(identity);
      const expectedCycle = assessmentSnapshotCycleKey({
        coverage_key: expectedCoverage,
        trigger_kind: String(snapshot.document.trigger_kind),
        wave_id: String(snapshot.document.wave_id),
        trigger_event_ref:
          typeof snapshot.document.trigger_event_ref === "string"
            ? snapshot.document.trigger_event_ref
            : null,
      });
      if (
        snapshot.document.coverage_key !== expectedCoverage ||
        gap.coverage_key !== expectedCoverage ||
        gap.subject_ref !== snapshot.document.subject_ref ||
        snapshot.document.snapshot_cycle_key !== expectedCycle
      ) {
        errors.push(
          issue(
            "assessment_adaptation.coverage_key_mismatch",
            `${snapshot.path}#/coverage_key`,
            "coverage_key or snapshot cycle key differs from the canonical assessment identity",
          ),
        );
      }
      const previous = seenCoverage.get(expectedCoverage);
      if (previous !== undefined && previous !== snapshot.path) {
        errors.push(
          issue(
            "assessment_adaptation.coverage_duplicate",
            snapshot.path,
            "the same assessment coverage identity is published at multiple paths",
            { previous },
          ),
        );
      }
      seenCoverage.set(expectedCoverage, snapshot.path);
      const requiredBasis = [
        String(snapshot.document.based_on_plan_ref),
        String(snapshot.document.assessment_plan_ref),
        String(snapshot.document.subject_ref),
        String(snapshot.document.scope_frame_ref),
        ...observed.flatMap((item) => [item.artifact_ref, item.task_ref]),
      ];
      if (!requiredBasis.every((ref) => stringArray(gap.basis_refs).includes(ref))) {
        errors.push(
          issue(
            "assessment_adaptation.basis_incomplete",
            `${snapshot.path}#/gaps/0/basis_refs`,
            "buyer/acquisition gap basis must include exact plan, assessment, subject, scope, task, and observed Artifact refs",
          ),
        );
      }
      const recommended = expectedUnitType(gap.gap_type);
      if (
        (recommended !== null &&
          (gap.recommended_unit_type !== recommended || gap.followup_status !== "executable")) ||
        (recommended === null &&
          (gap.recommended_unit_type !== null || gap.followup_status !== "stop"))
      ) {
        errors.push(
          issue(
            "assessment_adaptation.gap_disposition_invalid",
            `${snapshot.path}#/gaps/0`,
            "gap type does not match its closed follow-up disposition",
          ),
        );
      }

      const observedBranches = observed.flatMap((item) => {
        const branch = documents.get(item.artifact_ref);
        return branch?.schemaVersion ===
          "startup_opportunity.concept_evidence_assessment_branch_result.v1"
          ? [branch.document]
          : [];
      });
      const sufficient =
        observedBranches.length > 0 &&
        observedBranches.every((branch) => branch.decision_sufficiency === "sufficient");
      const followupPolicy = isRecord(assessmentPlan?.document.followup_policy)
        ? assessmentPlan.document.followup_policy
        : {};
      const followupLimitReached =
        typeof followupPolicy.max_followup_rounds === "number" &&
        Number(manifest.document.followup_round) >= followupPolicy.max_followup_rounds;
      const executableChange = observedBranches.some(
        (branch) => stringArray(branch.what_would_change_decision).length > 0,
      );
      const materialNewEvidence = snapshot.document.material_new_evidence_observed === true;
      const noExecutableFollowup =
        !sufficient && materialNewEvidence && (followupLimitReached || !executableChange);
      const expectedGapType = sufficient
        ? "coverage_sufficient"
        : !materialNewEvidence
          ? "no_material_new_evidence"
          : noExecutableFollowup
            ? "no_executable_followup"
            : gap.dimension_id === "buyer_language_and_willingness_to_pay"
              ? "buyer_evidence_insufficient"
              : "acquisition_evidence_insufficient";
      const expectedCoverageStatus = sufficient
        ? "sufficient"
        : noExecutableFollowup
          ? "no_executable_followup"
          : "insufficient";
      const expectedFollowupStatus = expectedGapType.endsWith("_insufficient")
        ? "executable"
        : "stop";
      const expectedRecommendedUnit =
        expectedFollowupStatus === "executable" ? expectedUnitType(expectedGapType) : null;
      const expectedStopSignals = sufficient
        ? ["coverage_sufficient"]
        : !materialNewEvidence
          ? ["no_material_new_evidence"]
          : noExecutableFollowup
            ? [
                ...(followupLimitReached ? ["max_followup_rounds_reached"] : []),
                "no_executable_followup",
              ].sort()
            : [];
      const actualStopSignals = stringArray(snapshot.document.stop_signals);
      if (
        gap.gap_type !== expectedGapType ||
        gap.coverage_status !== expectedCoverageStatus ||
        gap.followup_status !== expectedFollowupStatus ||
        gap.recommended_unit_type !== expectedRecommendedUnit ||
        !expectedStopSignals.every((signal) => actualStopSignals.includes(signal))
      ) {
        errors.push(
          issue(
            "assessment_adaptation.gap_semantics_mismatch",
            `${snapshot.path}#/gaps/0`,
            "Gap disposition does not match its observed Branch sufficiency, Evidence, and follow-up state",
            {
              expectedCoverageStatus,
              expectedFollowupStatus,
              expectedGapType,
              expectedRecommendedUnit,
              expectedStopSignals,
            },
          ),
        );
      }
    }
  }

  for (const decision of decisions) {
    const resolved = gapByRef(documents, stringArray(decision.document.trigger_gap_refs)[0]);
    const snapshot = resolved?.snapshot.document;
    const gap = resolved?.gap;
    const decisionApplied = appliedDecisionRefs.has(decision.path);
    const currentDecisionBase =
      decision.document.based_on_plan_ref === manifest.document.current_plan_ref &&
      decision.document.based_on_plan_revision === manifest.document.plan_revision;
    const historicalDecisionBase =
      decisionApplied &&
      researchPlanAncestryContainsAdaptation(
        currentPlan,
        decision.document.based_on_plan_ref,
        decision.path,
        documents,
      );
    if (
      snapshot === undefined ||
      gap === undefined ||
      decision.document.run_id !== manifest.document.run_id ||
      (!currentDecisionBase && !historicalDecisionBase) ||
      decision.document.based_on_plan_ref !== snapshot.based_on_plan_ref ||
      decision.document.based_on_plan_hash !== snapshot.based_on_plan_hash ||
      decision.document.assessment_plan_ref !== snapshot.assessment_plan_ref ||
      decision.document.assessment_plan_revision !== snapshot.assessment_plan_revision ||
      decision.document.assessment_plan_hash !== snapshot.assessment_plan_hash ||
      decision.document.subject_ref !== snapshot.subject_ref ||
      decision.document.scope_frame_ref !== snapshot.scope_frame_ref ||
      decision.document.scope_frame_hash !== snapshot.scope_frame_hash ||
      decision.document.coverage_key !== snapshot.coverage_key ||
      decision.document.coverage_key !== gap.coverage_key
    ) {
      errors.push(
        issue(
          "assessment_adaptation.decision_binding_mismatch",
          decision.path,
          "Adaptation Decision does not exactly bind its current Gap Snapshot coverage",
        ),
      );
      continue;
    }
    if (decision.document.action === "add_unit") {
      const target = isRecord(decision.document.target_unit) ? decision.document.target_unit : null;
      const unitType = expectedUnitType(gap.gap_type);
      const nextAssessmentRef = `plans/concept-evidence-assessment-plan.r${Number(snapshot.assessment_plan_revision) + 1}.json`;
      if (
        unitType === null ||
        target?.unit_type !== unitType ||
        gap.dimension_id !== expectedDimension(unitType) ||
        target.agent_role !== "lane-researcher" ||
        target.required_artifact_schema !==
          "startup_opportunity.concept_evidence_assessment_branch_result.v1" ||
        target.attempt !== 1 ||
        target.supersedes_unit_ref !== null ||
        decision.document.candidate_assessment_plan_ref !== nextAssessmentRef ||
        !stringArray(target.input_refs).includes(String(snapshot.subject_ref)) ||
        !stringArray(target.input_refs).includes(String(snapshot.scope_frame_ref)) ||
        !stringArray(target.depends_on).every((unitId) =>
          (snapshot.observed_artifacts as readonly Record<string, unknown>[]).some(
            (item) => item.unit_id === unitId,
          ),
        ) ||
        stringArray(target.depends_on).length === 0
      ) {
        errors.push(
          issue(
            "assessment_adaptation.add_unit_invalid",
            `${decision.path}#/target_unit`,
            "add_unit target does not match the closed buyer/acquisition follow-up contract",
          ),
        );
      }
    } else if (
      decision.document.action === "stop_followup" &&
      gap.followup_status !== "stop" &&
      stringArray(snapshot.stop_signals).length === 0
    ) {
      errors.push(
        issue(
          "assessment_adaptation.stop_basis_missing",
          decision.path,
          "stop_followup requires sufficient coverage or a closed no-follow-up stop signal",
        ),
      );
    }
  }
  return errors;
}

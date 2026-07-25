import { canonicalContentHash } from "../artifact-store/canonical.js";

export interface AssessmentObservedArtifactIdentity {
  readonly artifact_ref: string;
  readonly artifact_type: string;
  readonly content_hash: string;
  readonly task_ref: string;
  readonly task_hash: string;
  readonly unit_id: string;
  readonly attempt: number;
  readonly unit_state: string;
  readonly branch_status: string;
}

export interface AssessmentCoverageIdentity {
  readonly schema_version: "startup_opportunity.assessment_coverage_identity.v1";
  readonly run_id: string;
  readonly subject_ref: string;
  readonly scope_frame_ref: string;
  readonly scope_frame_hash: string;
  readonly research_plan_ref: string;
  readonly research_plan_revision: number;
  readonly research_plan_hash: string;
  readonly assessment_plan_ref: string;
  readonly assessment_plan_revision: number;
  readonly assessment_plan_hash: string;
  readonly dimension_id: string;
  readonly observed_artifacts: readonly AssessmentObservedArtifactIdentity[];
}

export function assessmentCoverageKey(identity: AssessmentCoverageIdentity): string {
  return canonicalContentHash({
    ...identity,
    observed_artifacts: [...identity.observed_artifacts].sort((left, right) =>
      left.artifact_ref.localeCompare(right.artifact_ref),
    ),
  });
}

export function assessmentSnapshotCycleKey(identity: {
  readonly coverage_key: string;
  readonly trigger_kind: string;
  readonly wave_id: string;
  readonly trigger_event_ref: string | null;
}): string {
  return canonicalContentHash({
    schema_version: "startup_opportunity.assessment_snapshot_cycle_identity.v1",
    ...identity,
  });
}

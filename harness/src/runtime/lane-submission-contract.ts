import { canonicalJson, operationKey } from "../artifact-store/canonical.js";

export type LaneArtifactFamily =
  | "lane_result"
  | "commercial_audit"
  | "evidence"
  | "finding"
  | "claim"
  | "judgment"
  | "insight"
  | "source_manifest";

export interface LaneSubmissionContract extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.lane_submission_contract.current";
  readonly run_id: string;
  readonly unit_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly path_basis: "run_root_relative";
  readonly staging_output_path: string;
  readonly staging_schema: "startup_opportunity.lane_staging_document.current";
  readonly formal_output_path: string;
  readonly formal_artifact_schema: string;
  readonly allowed_artifact_families: readonly LaneArtifactFamily[];
  readonly required_sequence: readonly [
    "lane_writes_staging_file",
    "main_agent_reads_staging_file",
    "materialize_lane_result_validate_only",
    "materialize_lane_result_publish_exact_plan",
  ];
  readonly authority_boundary: {
    readonly lane_writes_formal_artifact_path: false;
    readonly staging_file_is_formal_artifact: false;
    readonly staging_file_is_manifest_authority: false;
    readonly harness_publishes_formal_artifacts: true;
    readonly completion_message_is_formal_artifact: false;
    readonly completion_message_can_substitute_delivery: false;
  };
}

const BASE_ALLOWED_FAMILIES: readonly LaneArtifactFamily[] = [
  "lane_result",
  "evidence",
  "finding",
  "claim",
  "judgment",
  "insight",
  "source_manifest",
];

export function laneSubmissionStagingPath(input: {
  readonly runId: string;
  readonly unitId: string;
  readonly taskId: string;
  readonly attempt: number;
}): string {
  const digest = operationKey("lane_submission_staging_path", {
    run_id: input.runId,
    unit_id: input.unitId,
    task_id: input.taskId,
    attempt: input.attempt,
  }).replace(/^sha256:/u, "");
  return `staging/lane-submissions/${digest.slice(0, 32)}.json`;
}

export function deriveLaneSubmissionContract(input: {
  readonly runId: string;
  readonly unitId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly formalOutputPath: string;
  readonly formalArtifactSchema: string;
  readonly commercialAuditOutputPath?: string | null;
}): LaneSubmissionContract {
  return {
    schema_version: "startup_opportunity.lane_submission_contract.current",
    run_id: input.runId,
    unit_id: input.unitId,
    task_id: input.taskId,
    attempt: input.attempt,
    path_basis: "run_root_relative",
    staging_output_path: laneSubmissionStagingPath(input),
    staging_schema: "startup_opportunity.lane_staging_document.current",
    formal_output_path: input.formalOutputPath,
    formal_artifact_schema: input.formalArtifactSchema,
    allowed_artifact_families:
      input.commercialAuditOutputPath === null || input.commercialAuditOutputPath === undefined
        ? BASE_ALLOWED_FAMILIES
        : [...BASE_ALLOWED_FAMILIES, "commercial_audit"],
    required_sequence: [
      "lane_writes_staging_file",
      "main_agent_reads_staging_file",
      "materialize_lane_result_validate_only",
      "materialize_lane_result_publish_exact_plan",
    ],
    authority_boundary: {
      lane_writes_formal_artifact_path: false,
      staging_file_is_formal_artifact: false,
      staging_file_is_manifest_authority: false,
      harness_publishes_formal_artifacts: true,
      completion_message_is_formal_artifact: false,
      completion_message_can_substitute_delivery: false,
    },
  };
}

export function sameLaneSubmissionContract(left: unknown, right: LaneSubmissionContract): boolean {
  return canonicalJson(left ?? null) === canonicalJson(right);
}

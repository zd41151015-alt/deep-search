import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import {
  type AssessmentExecutionDocument,
  deriveAssessmentInformationGainAuthority,
} from "../validators/assessment-execution-validator.js";
import { evaluateAssessmentFollowupInformationGain } from "./assessment-information-gain.js";
import { deriveLaneSubmissionContract } from "./lane-submission-contract.js";

export interface AssessmentFollowupRevisionResult {
  readonly researchPlanPath: string;
  readonly researchPlan: Record<string, unknown>;
  readonly executionPlanPath: string;
  readonly executionPlan: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function laneRoleForDimension(dimension: string): string {
  if (dimension === "counter_evidence") return "counter_evidence";
  if (dimension === "compliance_and_platform_risk") return "risk";
  if (["business_engine_viability", "delivery_feasibility"].includes(dimension)) {
    return "feasibility";
  }
  if (
    [
      "competitor_saturation_and_differentiation",
      "buyer_language_and_willingness_to_pay",
      "acquisition_and_distribution",
    ].includes(dimension)
  ) {
    return "commercial";
  }
  return "evidence";
}

export function deriveAssessmentFollowupRevision(
  baseResearchPlanPath: string,
  baseResearchPlan: Record<string, unknown>,
  baseExecutionPlanPath: string,
  baseExecutionPlan: Record<string, unknown>,
  decisionPath: string,
  decision: Record<string, unknown>,
  createdAt: string,
  assessmentDocuments: readonly AssessmentExecutionDocument[],
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
): AssessmentFollowupRevisionResult {
  if (
    decision.schema_version !== "startup_opportunity.assessment_followup_decision.v1" ||
    decision.action !== "add_bounded_followup" ||
    !isRecord(decision.target_unit) ||
    decision.based_on_research_plan_ref !== baseResearchPlanPath ||
    decision.based_on_execution_plan_ref !== baseExecutionPlanPath ||
    decision.based_on_research_plan_hash !== canonicalContentHash(baseResearchPlan) ||
    decision.based_on_execution_plan_hash !== canonicalContentHash(baseExecutionPlan)
  ) {
    throw new StoreError(
      "assessment.followup_binding_invalid",
      "assessment follow-up revision requires one exact add decision and current Plans",
    );
  }
  const informationGainIssues = evaluateAssessmentFollowupInformationGain(
    decision,
    deriveAssessmentInformationGainAuthority(
      {
        path: decisionPath,
        schemaVersion: String(decision.schema_version),
        document: decision,
        envelope: null,
      },
      new Map(assessmentDocuments.map((entry) => [entry.path, entry])),
      exactRecords,
    ),
  );
  if (informationGainIssues.length > 0) {
    throw new StoreError(
      "assessment.followup_information_gain_ineligible",
      "assessment follow-up does not pass the current information-gain gate",
      {
        artifact: decisionPath,
        issues: informationGainIssues,
        likelyCause:
          "The proposed Wave 2 task is unavailable, non-decision-relevant, or duplicative.",
      },
    );
  }
  const researchRevision = Number(baseResearchPlan.revision) + 1;
  const executionRevision = Number(baseExecutionPlan.revision) + 1;
  const researchPlanPath = `plans/research-plan.r${researchRevision}.json`;
  const executionPlanPath = `plans/research-execution.r${executionRevision}.json`;
  if (
    decision.candidate_research_plan_ref !== researchPlanPath ||
    decision.candidate_execution_plan_ref !== executionPlanPath ||
    Number(decision.current_followup_round) !== Number(baseExecutionPlan.followup_round)
  ) {
    throw new StoreError(
      "assessment.followup_candidate_ref_invalid",
      "assessment follow-up candidate refs or round differ from deterministic successors",
    );
  }
  const targetUnit = structuredClone(decision.target_unit);
  const sourceStage = (
    Array.isArray(baseExecutionPlan.stages) ? baseExecutionPlan.stages : []
  ).find((stage) => isRecord(stage) && stage.gate_after === decision.stage_gate_ref);
  if (!isRecord(sourceStage)) {
    throw new StoreError(
      "assessment.followup_gate_invalid",
      "assessment follow-up decision does not bind a completed execution stage gate",
    );
  }
  const sourceUnitIds = new Set(
    (Array.isArray(sourceStage.lanes) ? sourceStage.lanes : [])
      .filter(isRecord)
      .map((lane) => String(lane.unit_id)),
  );
  const sourceWaves = (Array.isArray(baseResearchPlan.waves) ? baseResearchPlan.waves : []).filter(
    (wave) =>
      isRecord(wave) &&
      Array.isArray(wave.units) &&
      wave.units.some((unit) => isRecord(unit) && sourceUnitIds.has(String(unit.unit_id))),
  );
  if (sourceWaves.length !== 1 || typeof sourceWaves[0]?.wave_id !== "string") {
    throw new StoreError(
      "assessment.followup_wave_invalid",
      "assessment follow-up source stage must map to one immutable Research Plan wave",
    );
  }
  const sourceWaveId = sourceWaves[0].wave_id;
  const researchPlan = structuredClone(baseResearchPlan);
  researchPlan.revision = researchRevision;
  researchPlan.parent_plan_ref = baseResearchPlanPath;
  researchPlan.triggered_by_adaptation_refs = [
    ...new Set([...strings(baseResearchPlan.triggered_by_adaptation_refs), decisionPath]),
  ].sort();
  researchPlan.created_at = createdAt;
  researchPlan.waves = [
    ...(Array.isArray(baseResearchPlan.waves) ? baseResearchPlan.waves : []),
    {
      wave_id: `assessment_followup_${String(Number(decision.current_followup_round) + 1)}`,
      depends_on: [sourceWaveId],
      units: [targetUnit],
    },
  ];

  const executionPlan = structuredClone(baseExecutionPlan);
  executionPlan.revision = executionRevision;
  executionPlan.parent_execution_plan_ref = baseExecutionPlanPath;
  executionPlan.research_plan_ref = researchPlanPath;
  executionPlan.research_plan_hash = canonicalContentHash(researchPlan);
  executionPlan.created_at = createdAt;
  executionPlan.followup_round = Number(baseExecutionPlan.followup_round) + 1;
  const dimension = String(decision.dimension_id);
  const unitId = String(targetUnit.unit_id);
  const taskId = `task_${unitId}`;
  const submissionPath = String(targetUnit.output_path);
  executionPlan.stages = [
    ...(Array.isArray(baseExecutionPlan.stages) ? baseExecutionPlan.stages : []),
    {
      stage_id: `assessment_followup_${String(executionPlan.followup_round)}_${dimension}`,
      stage_kind: "assessment_followup",
      depends_on: [String(sourceStage.stage_id)],
      gate_before: decision.stage_gate_ref,
      gate_after: `artifacts/assessment/gates/followup-${String(executionPlan.followup_round)}-${dimension}.r1.json`,
      lanes: [
        {
          unit_id: unitId,
          lane_role: laneRoleForDimension(dimension),
          incumbent_response_assignment: {
            analysis_depth: "not_assigned",
            assignment_role: "none",
            subject_refs: [],
            rationale:
              "Buyer and acquisition follow-up units do not expand incumbent response scope.",
          },
          reporting_dimensions: [dimension],
          submission_path: submissionPath,
          submission_schema: "startup_opportunity.assessment_lane_result.v1",
          lane_submission_contract: deriveLaneSubmissionContract({
            runId: String(baseExecutionPlan.run_id),
            unitId,
            taskId,
            attempt: Number(targetUnit.attempt ?? 1),
            formalOutputPath: submissionPath,
            formalArtifactSchema: "startup_opportunity.assessment_lane_result.v1",
            commercialAuditOutputPath: null,
          }),
          time_budget_minutes: 15,
          max_sources: 10,
          straggler_policy: {
            on_timeout: "publish_partial",
            grace_minutes: 0,
            blocks_stage: false,
          },
          dispatch_group: `assessment_followup_${String(executionPlan.followup_round)}`,
        },
      ],
    },
  ];
  return {
    researchPlanPath,
    researchPlan: JSON.parse(canonicalJson(researchPlan)) as Record<string, unknown>,
    executionPlanPath,
    executionPlan: JSON.parse(canonicalJson(executionPlan)) as Record<string, unknown>,
  };
}

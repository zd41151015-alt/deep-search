import type { ValidationIssue } from "../validators/schema-bundle.js";

export const DISCOVERY_GENERATION_RESULT_SCHEMA =
  "startup_opportunity.discovery_generation_result.v1" as const;
export const DISCOVERY_LANE_RESULT_SCHEMA = "startup_opportunity.discovery_lane_result.v1" as const;
export const ENRICHMENT_BRANCH_RESULT_SCHEMA =
  "startup_opportunity.enrichment_branch_result.v1" as const;
export const ADVERSARIAL_REVIEW_SCHEMA =
  "startup_opportunity.discovery_adversarial_review.current" as const;

export const DISCOVERY_CANDIDATE_TASK_SCHEMA =
  "startup_opportunity.research_task.discovery_candidate.current" as const;
export const DISCOVERY_EVALUATION_TASK_SCHEMA =
  "startup_opportunity.research_task.discovery_evaluation.current" as const;
export const DISCOVERY_REVIEW_TASK_SCHEMA =
  "startup_opportunity.research_task.discovery_review.current" as const;

export const DISCOVERY_GENERATION_OUTPUT_PATH_PATTERN =
  /^artifacts\/discovery\/generation\/[A-Za-z0-9][A-Za-z0-9._-]*\.r[1-9][0-9]*\.json$/u;
export const DISCOVERY_GENERATION_OUTPUT_PATH_PATTERN_SOURCE =
  "^artifacts/discovery/generation/[A-Za-z0-9][A-Za-z0-9._-]*\\.r[1-9][0-9]*\\.json$";
export const ADVERSARIAL_REVIEW_OUTPUT_PATH_PATTERN =
  /^artifacts\/reviews\/[A-Za-z0-9._-]+\.json$/u;
export const ADVERSARIAL_REVIEW_OUTPUT_PATH_PATTERN_SOURCE =
  "^artifacts/reviews/[A-Za-z0-9._-]+\\.json$";

export type DiscoveryProjectedTaskSchema =
  | typeof DISCOVERY_CANDIDATE_TASK_SCHEMA
  | typeof DISCOVERY_EVALUATION_TASK_SCHEMA
  | typeof DISCOVERY_REVIEW_TASK_SCHEMA;

export interface DiscoveryTaskProjection {
  readonly taskType: DiscoveryProjectedTaskSchema;
  readonly taskDirectory:
    | "tasks/discovery"
    | "tasks/discovery/enrichment"
    | "tasks/discovery/reviews";
  readonly taskPhase: "discovery" | "enrichment" | "review";
  readonly expectedAgentRole: "lane-researcher" | "adversarial-reviewer";
  readonly expectedUnitType?: "adversarial_review";
}

export interface DiscoveryUnitOutputPathContract {
  readonly kind: "exact" | "pattern";
  readonly expectedOutputPath?: string;
  readonly expectedOutputPathPattern?: string;
  readonly expectedOutputPathRegex?: RegExp;
  readonly description: string;
  readonly taskProjection: DiscoveryTaskProjection;
}

export interface DiscoveryUnitOutputPathValidation {
  readonly valid: boolean;
  readonly outputPath: string;
  readonly contract: DiscoveryUnitOutputPathContract;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface DiscoveryWaveLaneProjectionContext {
  readonly retainedCandidateRefs?: readonly string[];
  readonly retainedAuthorityRefs?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringSetEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
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

function positiveAttempt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

export function discoveryTaskProjectionForRequiredArtifactSchema(
  requiredArtifactSchema: string,
): DiscoveryTaskProjection | null {
  switch (requiredArtifactSchema) {
    case ENRICHMENT_BRANCH_RESULT_SCHEMA:
      return {
        taskType: DISCOVERY_EVALUATION_TASK_SCHEMA,
        taskDirectory: "tasks/discovery/enrichment",
        taskPhase: "enrichment",
        expectedAgentRole: "lane-researcher",
      };
    case DISCOVERY_LANE_RESULT_SCHEMA:
    case DISCOVERY_GENERATION_RESULT_SCHEMA:
      return {
        taskType: DISCOVERY_CANDIDATE_TASK_SCHEMA,
        taskDirectory: "tasks/discovery",
        taskPhase: "discovery",
        expectedAgentRole: "lane-researcher",
      };
    case ADVERSARIAL_REVIEW_SCHEMA:
      return {
        taskType: DISCOVERY_REVIEW_TASK_SCHEMA,
        taskDirectory: "tasks/discovery/reviews",
        taskPhase: "review",
        expectedAgentRole: "adversarial-reviewer",
        expectedUnitType: "adversarial_review",
      };
    default:
      return null;
  }
}

export function discoveryUnitOutputPathContract(
  unit: Record<string, unknown>,
): DiscoveryUnitOutputPathContract | null {
  const requiredArtifactSchema =
    typeof unit.required_artifact_schema === "string" ? unit.required_artifact_schema : "";
  const taskProjection = discoveryTaskProjectionForRequiredArtifactSchema(requiredArtifactSchema);
  if (taskProjection === null) return null;
  const unitId = typeof unit.unit_id === "string" ? unit.unit_id : null;
  const attempt = positiveAttempt(unit.attempt);
  if (requiredArtifactSchema === DISCOVERY_GENERATION_RESULT_SCHEMA) {
    return {
      kind: "pattern",
      expectedOutputPathPattern: DISCOVERY_GENERATION_OUTPUT_PATH_PATTERN_SOURCE,
      expectedOutputPathRegex: DISCOVERY_GENERATION_OUTPUT_PATH_PATTERN,
      description:
        "Discovery generation Artifact revision is encoded by the output path .rN suffix and is not derived from Unit execution attempt.",
      taskProjection,
    };
  }
  if (requiredArtifactSchema === ADVERSARIAL_REVIEW_SCHEMA) {
    return {
      kind: "pattern",
      expectedOutputPathPattern: ADVERSARIAL_REVIEW_OUTPUT_PATH_PATTERN_SOURCE,
      expectedOutputPathRegex: ADVERSARIAL_REVIEW_OUTPUT_PATH_PATTERN,
      description:
        "Discovery adversarial review outputs are formal review artifacts owned by the adversarial reviewer.",
      taskProjection,
    };
  }
  if (unitId === null || attempt === null) return null;
  if (requiredArtifactSchema === DISCOVERY_LANE_RESULT_SCHEMA) {
    return {
      kind: "exact",
      expectedOutputPath: `artifacts/discovery/lanes/${unitId}.attempt-${attempt}.json`,
      description:
        "Discovery lane results are execution-attempt outputs and use the Unit attempt in their canonical path.",
      taskProjection,
    };
  }
  return {
    kind: "exact",
    expectedOutputPath: `artifacts/discovery/enrichment/branches/${unitId}.attempt-${attempt}.json`,
    description:
      "Discovery enrichment branch results are execution-attempt outputs and use the Unit attempt in their canonical path.",
    taskProjection,
  };
}

export function validateDiscoveryUnitOutputPath(
  unit: Record<string, unknown>,
): DiscoveryUnitOutputPathValidation | null {
  const contract = discoveryUnitOutputPathContract(unit);
  if (contract === null) return null;
  const outputPath = typeof unit.output_path === "string" ? unit.output_path : "";
  const valid =
    contract.kind === "exact"
      ? outputPath === contract.expectedOutputPath
      : (contract.expectedOutputPathRegex ?? DISCOVERY_GENERATION_OUTPUT_PATH_PATTERN).test(
          outputPath,
        );
  return {
    valid,
    outputPath,
    contract,
    details: {
      outputPath,
      requiredArtifactSchema: unit.required_artifact_schema,
      outputPathContract: contract.description,
      ...(contract.expectedOutputPath === undefined
        ? {}
        : { expectedOutputPath: contract.expectedOutputPath }),
      ...(contract.expectedOutputPathPattern === undefined
        ? {}
        : { expectedOutputPathPattern: contract.expectedOutputPathPattern }),
    },
  };
}

export function discoveryPlanLaunchReadinessIssues(
  planPath: string,
  plan: Record<string, unknown>,
): readonly ValidationIssue[] {
  if (plan.mode !== "opportunity_discovery") return [];
  const issues: ValidationIssue[] = [];
  for (const [waveIndex, wave] of records(plan.waves).entries()) {
    const waveId = typeof wave.wave_id === "string" ? wave.wave_id : `waves/${waveIndex}`;
    for (const unit of records(wave.units)) {
      if (unit.plan_disposition !== "enabled") continue;
      const unitId = typeof unit.unit_id === "string" ? unit.unit_id : "";
      const instancePath = `${planPath}#${unitId}`;
      const requiredArtifactSchema =
        typeof unit.required_artifact_schema === "string" ? unit.required_artifact_schema : "";
      const taskProjection =
        discoveryTaskProjectionForRequiredArtifactSchema(requiredArtifactSchema);
      if (taskProjection === null) {
        issues.push(
          issue(
            "plan.launch_unit_output_unsupported",
            instancePath,
            "enabled Discovery Plan Unit has no canonical formal-stage Task projection",
            { waveId, unitId, requiredArtifactSchema },
          ),
        );
        continue;
      }
      const outputValidation = validateDiscoveryUnitOutputPath(unit);
      if (outputValidation !== null && !outputValidation.valid) {
        issues.push(
          issue(
            "plan.launch_output_path_contract_mismatch",
            instancePath,
            "enabled Discovery Plan Unit output path cannot be projected into its formal-stage Task",
            { waveId, unitId, ...outputValidation.details },
          ),
        );
      }
      if (
        taskProjection.expectedUnitType !== undefined &&
        unit.unit_type !== taskProjection.expectedUnitType
      ) {
        issues.push(
          issue(
            "plan.launch_adversarial_review_topology_mismatch",
            instancePath,
            "enabled Discovery review Unit must use the policy-owned review unit type",
            {
              waveId,
              unitId,
              unitType: unit.unit_type,
              expectedUnitType: taskProjection.expectedUnitType,
              requiredArtifactSchema,
            },
          ),
        );
      }
      if (unit.agent_role !== taskProjection.expectedAgentRole) {
        issues.push(
          issue(
            "plan.launch_agent_role_unsupported",
            instancePath,
            "enabled Discovery Plan Unit cannot be materialized into the current canonical Task agent role",
            {
              waveId,
              unitId,
              agentRole: unit.agent_role,
              expectedAgentRole: taskProjection.expectedAgentRole,
              taskType: taskProjection.taskType,
            },
          ),
        );
      }
    }
  }
  return issues;
}

export function discoveryPlanLaunchReadinessIssuesFromBundle(
  value: unknown,
): readonly ValidationIssue[] {
  if (!isRecord(value) || !Array.isArray(value.documents)) return [];
  return value.documents.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || !isRecord(entry.document)) {
      return [];
    }
    const document =
      entry.document.schema_version === "startup_opportunity.artifact_envelope.current" &&
      isRecord(entry.document.document)
        ? entry.document.document
        : entry.document;
    return document.schema_version === "startup_opportunity.research_plan.v1"
      ? discoveryPlanLaunchReadinessIssues(entry.path, document)
      : [];
  });
}

export function discoveryWaveLaneProjectionIssues(
  waveStageKind: unknown,
  unit: Record<string, unknown>,
  lane: Record<string, unknown>,
  context: DiscoveryWaveLaneProjectionContext = {},
): readonly ValidationIssue[] {
  const unitId = typeof unit.unit_id === "string" ? unit.unit_id : String(lane.unit_id ?? "");
  const instancePath = `wave#${unitId}`;
  const issues: ValidationIssue[] = [];
  const requiredArtifactSchema =
    typeof unit.required_artifact_schema === "string" ? unit.required_artifact_schema : "";
  const taskProjection = discoveryTaskProjectionForRequiredArtifactSchema(requiredArtifactSchema);
  if (taskProjection === null) {
    issues.push(
      issue(
        "formal_materialization.unit_output_unsupported",
        instancePath,
        "selected Plan Unit has no canonical Discovery Task projection",
        { unitId, requiredArtifactSchema },
      ),
    );
    return issues;
  }
  const outputValidation = validateDiscoveryUnitOutputPath(unit);
  if (outputValidation !== null && !outputValidation.valid) {
    issues.push(
      issue(
        "formal_materialization.unit_output_contract_mismatch",
        instancePath,
        "selected Plan Unit output path cannot be used by the canonical Discovery Task projection",
        { unitId, ...outputValidation.details },
      ),
    );
  }
  if (
    taskProjection.expectedUnitType !== undefined &&
    unit.unit_type !== taskProjection.expectedUnitType
  ) {
    issues.push(
      issue(
        "formal_materialization.review_unit_type_mismatch",
        instancePath,
        "selected review Unit must use the policy-owned adversarial review unit type",
        {
          unitId,
          unitType: unit.unit_type,
          expectedUnitType: taskProjection.expectedUnitType,
          taskType: taskProjection.taskType,
        },
      ),
    );
  }
  if (unit.agent_role !== taskProjection.expectedAgentRole) {
    issues.push(
      issue(
        "formal_materialization.unit_agent_role_unsupported",
        instancePath,
        "selected Plan Unit cannot be materialized into the current canonical Task agent role",
        {
          unitId,
          agentRole: unit.agent_role,
          expectedAgentRole: taskProjection.expectedAgentRole,
          taskType: taskProjection.taskType,
        },
      ),
    );
  }
  const candidateScope = isRecord(lane.candidate_scope) ? lane.candidate_scope : {};
  const commercial = isRecord(lane.commercial_research_semantics)
    ? lane.commercial_research_semantics
    : {};
  const task = isRecord(lane.task_semantics) ? lane.task_semantics : {};
  if (requiredArtifactSchema === ADVERSARIAL_REVIEW_SCHEMA) {
    const candidateScopeRefs = strings(candidateScope.candidate_refs);
    const targetCandidateRefs = strings(task.target_candidate_refs);
    const targetOpportunityRefs = strings(task.target_opportunity_refs);
    if (waveStageKind !== "review") {
      issues.push(
        issue(
          "formal_materialization.review_stage_kind_mismatch",
          instancePath,
          "Discovery adversarial review Units must be launched from a review wave",
          { unitId, stageKind: waveStageKind, expectedStageKind: "review" },
        ),
      );
    }
    if (lane.lane_role !== "review") {
      issues.push(
        issue(
          "formal_materialization.review_lane_role_mismatch",
          instancePath,
          "Discovery adversarial review Units must use the review lane role",
          { unitId, laneRole: lane.lane_role, expectedLaneRole: "review" },
        ),
      );
    }
    if (candidateScope.kind !== "none" || candidateScopeRefs.length > 0) {
      issues.push(
        issue(
          "formal_materialization.review_candidate_scope_mismatch",
          instancePath,
          "Discovery adversarial review Units must be plan-level and must not target formed candidates",
          { unitId, candidateScopeKind: candidateScope.kind, candidateRefs: candidateScopeRefs },
        ),
      );
    }
    if (targetCandidateRefs.length > 0 || targetOpportunityRefs.length > 0) {
      issues.push(
        issue(
          "formal_materialization.review_target_refs_mismatch",
          instancePath,
          "Discovery adversarial review Tasks must not masquerade as candidate or opportunity lane work",
          { unitId, targetCandidateRefs, targetOpportunityRefs },
        ),
      );
    }
    if (task.source_phase !== "adversarial_challenger") {
      issues.push(
        issue(
          "formal_materialization.review_source_phase_mismatch",
          instancePath,
          "Discovery adversarial review Units must use adversarial_challenger source_phase",
          {
            unitId,
            sourcePhase: task.source_phase,
            expectedSourcePhase: "adversarial_challenger",
          },
        ),
      );
    }
  } else if (requiredArtifactSchema === DISCOVERY_GENERATION_RESULT_SCHEMA) {
    const candidateScopeRefs = strings(candidateScope.candidate_refs);
    const targetCandidateRefs = strings(task.target_candidate_refs);
    if (waveStageKind !== "discovery_generation") {
      issues.push(
        issue(
          "formal_materialization.generation_stage_kind_mismatch",
          instancePath,
          "Discovery generation result Units must be launched from a discovery_generation wave",
          { unitId, stageKind: waveStageKind, expectedStageKind: "discovery_generation" },
        ),
      );
    }
    if (lane.lane_role !== "opportunity") {
      issues.push(
        issue(
          "formal_materialization.generation_lane_role_mismatch",
          instancePath,
          "Discovery generation result Units must use the opportunity lane role",
          { unitId, laneRole: lane.lane_role, expectedLaneRole: "opportunity" },
        ),
      );
    }
    if (candidateScope.kind !== "none" || candidateScopeRefs.length > 0) {
      issues.push(
        issue(
          "formal_materialization.generation_candidate_scope_mismatch",
          instancePath,
          "Discovery generation result Units must not target formed candidates",
          {
            unitId,
            candidateScopeKind: candidateScope.kind,
            candidateRefs: candidateScopeRefs,
          },
        ),
      );
    }
    if (task.source_phase !== "candidate_generation") {
      issues.push(
        issue(
          "formal_materialization.generation_source_phase_mismatch",
          instancePath,
          "Discovery generation result Units must use candidate_generation source_phase",
          { unitId, sourcePhase: task.source_phase, expectedSourcePhase: "candidate_generation" },
        ),
      );
    }
    if (targetCandidateRefs.length > 0) {
      issues.push(
        issue(
          "formal_materialization.generation_target_refs_mismatch",
          instancePath,
          "Discovery generation result Units must have an empty target_candidate_refs set",
          { unitId, targetCandidateRefs },
        ),
      );
    }
    if (commercial.research_stage !== "solution_neutral_scan") {
      issues.push(
        issue(
          "formal_materialization.generation_research_stage_mismatch",
          instancePath,
          "Discovery generation result Units must use solution_neutral_scan commercial semantics",
          {
            unitId,
            researchStage: commercial.research_stage,
            expectedResearchStage: "solution_neutral_scan",
          },
        ),
      );
    }
  } else if (requiredArtifactSchema === ENRICHMENT_BRANCH_RESULT_SCHEMA) {
    const targetOpportunityRefs = strings(task.target_opportunity_refs);
    if (!["enrichment_evaluation", "adversarial_challenger"].includes(String(task.source_phase))) {
      issues.push(
        issue(
          "formal_materialization.enrichment_source_phase_mismatch",
          instancePath,
          "Discovery enrichment Units must use an enrichment source_phase",
          {
            unitId,
            sourcePhase: task.source_phase,
            expectedSourcePhases: ["enrichment_evaluation", "adversarial_challenger"],
          },
        ),
      );
    }
    if (targetOpportunityRefs.length === 0) {
      issues.push(
        issue(
          "formal_materialization.enrichment_target_refs_missing",
          instancePath,
          "Discovery enrichment Units must target at least one Opportunity ref",
          { unitId },
        ),
      );
    }
    if (commercial.research_stage !== "solution_specific_evaluation") {
      issues.push(
        issue(
          "formal_materialization.enrichment_research_stage_mismatch",
          instancePath,
          "Discovery enrichment Units must use solution_specific_evaluation commercial semantics",
          {
            unitId,
            researchStage: commercial.research_stage,
            expectedResearchStage: "solution_specific_evaluation",
          },
        ),
      );
    }
  } else if (requiredArtifactSchema === DISCOVERY_LANE_RESULT_SCHEMA) {
    const targetCandidateRefs = strings(task.target_candidate_refs);
    const candidateScopeRefs = strings(candidateScope.candidate_refs);
    if (targetCandidateRefs.length === 0) {
      issues.push(
        issue(
          "formal_materialization.discovery_lane_target_refs_missing",
          instancePath,
          "Discovery lane result Units must target at least one formed candidate ref",
          { unitId },
        ),
      );
    }
    if (
      candidateScope.kind === "explicit" &&
      !stringSetEqual(candidateScopeRefs, targetCandidateRefs)
    ) {
      issues.push(
        issue(
          "formal_materialization.discovery_lane_candidate_scope_target_mismatch",
          instancePath,
          "Discovery lane explicit candidate_scope must exactly match the Task target_candidate_refs it authorizes",
          {
            unitId,
            candidateScopeKind: candidateScope.kind,
            candidateScopeRefs,
            targetCandidateRefs,
          },
        ),
      );
    }
    if (candidateScope.kind === "retained") {
      const retainedCandidateRefs = context.retainedCandidateRefs ?? [];
      const retainedAuthorityRefs = context.retainedAuthorityRefs ?? [];
      const retainedSet = new Set(retainedCandidateRefs);
      const unauthorizedTargetCandidateRefs = targetCandidateRefs.filter(
        (ref) => !retainedSet.has(ref),
      );
      if (retainedAuthorityRefs.length === 0 || unauthorizedTargetCandidateRefs.length > 0) {
        issues.push(
          issue(
            "formal_materialization.discovery_lane_retained_scope_target_mismatch",
            instancePath,
            "Discovery lane retained candidate_scope must target candidates retained by the current Discovery fan-in authority",
            {
              unitId,
              retainedAuthorityRefs,
              retainedCandidateRefs,
              targetCandidateRefs,
              unauthorizedTargetCandidateRefs,
            },
          ),
        );
      }
    }
  }
  return issues;
}

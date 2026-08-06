import { canonicalContentHash } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import type { ArtifactValidator } from "../validators/artifact-validator.js";
import type { RuntimeArtifactCompilationRequest } from "./declarative-runtime.js";

export type ScaffoldKind =
  | "intake"
  | "planning"
  | "task"
  | "dispatch"
  | "readiness"
  | "gap"
  | "decision"
  | "terminal_report_source";

interface ScaffoldRequest extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.scaffold_request.current";
  readonly scaffold_id: string;
  readonly kind: ScaffoldKind;
  readonly run_id: string;
  readonly mode: "opportunity_discovery" | "concept_evidence_assessment";
  readonly created_at: string;
  readonly scope_confirmation: {
    readonly geography: string;
    readonly customer_model: "b2c" | "b2b" | "b2b2c" | "mixed";
    readonly target_users: readonly string[];
    readonly decision_goal: string;
    readonly research_language: string;
    readonly user_confirmed: true;
  };
}

interface ScaffoldArtifact {
  readonly artifact_type: string;
  readonly artifact_path: string;
  readonly producer_role: "main_agent" | "harness";
  readonly document: Record<string, unknown>;
}

const PLACEHOLDER = "CALLER_REQUIRED: replace this structural placeholder before publication.";
const PLAN_REF = "plans/research-plan.r1.json";
const EXECUTION_REF = "plans/research-execution.r1.json";
const SCOPE_REF = "scope-frame.json";
const CANDIDATE_REF = "artifacts/discovery/candidates/candidate_scaffold.r1.json";
const READINESS_REF = "artifacts/discovery/readiness/stage_scaffold.r1.json";
const GAP_REF = "adaptations/gap-snapshots/scaffold.r1.json";
const ASSESSMENT_PLAN_REF = "plans/concept-evidence-assessment-plan.r1.json";
const CONCEPT_REF = "concept-hypothesis.json";
const ASSESSMENT_TASK_REF = "tasks/unit_assessment_scaffold.attempt-1.json";
const ASSESSMENT_LANE_REF = "artifacts/assessment/lanes/unit-assessment-scaffold.attempt-1.json";
const ASSESSMENT_GATE_REF = "artifacts/assessment/gates/assessment-scaffold.r1.json";
const ASSESSMENT_BRANCH_REF = "artifacts/assessment/branches/unit-assessment-scaffold.json";

function boundary() {
  return {
    chat_is_artifact: false,
    task_completion_is_artifact: false,
    hidden_llm_calls: false,
    harness_dispatches_agent: false,
    external_validation_supported: false,
    publication_implies_validation: false,
  };
}

function allocation() {
  return {
    customer_commercial_percent: 65,
    market_structure_percent: 17,
    academic_percent: 18,
  };
}

function commercialRequirements(
  researchStage: "solution_neutral_scan" | "solution_specific_evaluation" = "solution_neutral_scan",
) {
  return {
    research_stage: researchStage,
    resource_allocation: allocation(),
    planned_queries: [
      {
        query: PLACEHOLDER,
        commercial_dimensions: [
          "user_language",
          "buyer",
          "purchase",
          "pricing",
          "alternatives",
          "usage",
          "distribution",
          "counterevidence",
        ],
      },
    ],
    quantitative_competitive_scope: {
      scan_mode: researchStage === "solution_neutral_scan" ? "broad_scan" : "targeted_deep_dive",
      required_metric_families: [
        "demand_scale",
        "usage_behavior",
        "commercial_behavior",
        "growth_change",
        "competitive_intensity",
        "distribution",
        "retention_outcomes",
        "unit_economics",
      ],
      required_competitor_types: [
        "direct_product",
        "adjacent_product",
        "service",
        "platform",
        "manual_workaround",
        "status_quo",
        "non_consumption",
      ],
      api_is_optional: true,
      provider_allowlist_enforced: false,
      acquisition_execution_owner: "research_agent_or_caller",
      harness_hidden_network_calls: false,
      prohibited_access_methods: [
        "bypass_access_control",
        "circumvent_login",
        "circumvent_paywall",
        "circumvent_captcha",
        "store_credentials",
      ],
    },
    required_commercial_dimensions: [
      "recent_user_language",
      "purchase_signal",
      "alternatives_pricing_usage",
      "distribution_channel",
      "independent_counterevidence",
    ],
    commercial_audit_output_path: "artifacts/research-audits/unit_scaffold.json",
  };
}

function intake(request: ScaffoldRequest): ScaffoldArtifact {
  return {
    artifact_type: "startup_opportunity.intake.v1",
    artifact_path: "intake.json",
    producer_role: "main_agent",
    document: {
      schema_version: "startup_opportunity.intake.v1",
      run_id: request.run_id,
      action: request.mode === "opportunity_discovery" ? "discover" : "assess",
      mode: request.mode,
      raw_query: request.scope_confirmation.decision_goal,
      market: request.scope_confirmation.geography,
      language: request.scope_confirmation.research_language,
      principal: "current_user",
      scope_confirmation: request.scope_confirmation,
      decision_context_ref: "decision-context.json",
      attachments: [],
      explicit_constraints: {
        target_market: request.scope_confirmation.geography,
        target_language: request.scope_confirmation.research_language,
        venture_goal: "unspecified",
        target_users: request.scope_confirmation.target_users,
      },
      created_at: request.created_at,
    },
  };
}

function assessmentPlanning(request: ScaffoldRequest): ScaffoldArtifact {
  const stages = [
    {
      stage_id: "assessment_stage_early",
      stage_kind: "assessment_early_kill",
      depends_on: [],
      gate_before: null,
      gate_after: "artifacts/assessment/gates/early.r1.json",
      lane_role: "counter_evidence",
      dimensions: ["target_user_and_jtbd", "demand_and_behavior", "counter_evidence"],
    },
    {
      stage_id: "assessment_stage_commercial",
      stage_kind: "assessment_commercial",
      depends_on: ["assessment_stage_early"],
      gate_before: "artifacts/assessment/gates/early.r1.json",
      gate_after: "artifacts/assessment/gates/commercial.r1.json",
      lane_role: "commercial",
      dimensions: ["buyer_language_and_willingness_to_pay", "acquisition_and_distribution"],
    },
    {
      stage_id: "assessment_stage_delivery",
      stage_kind: "assessment_delivery",
      depends_on: ["assessment_stage_commercial"],
      gate_before: "artifacts/assessment/gates/commercial.r1.json",
      gate_after: "artifacts/assessment/gates/delivery.r1.json",
      lane_role: "feasibility",
      dimensions: ["business_engine_viability", "delivery_feasibility"],
    },
  ] as const;
  return {
    artifact_type: "startup_opportunity.research_execution_plan.assessment.current",
    artifact_path: EXECUTION_REF,
    producer_role: "main_agent",
    document: {
      schema_version: "startup_opportunity.research_execution_plan.assessment.current",
      execution_plan_id: "execution_assessment_scaffold",
      run_id: request.run_id,
      mode: request.mode,
      revision: 1,
      parent_execution_plan_ref: null,
      research_plan_ref: PLAN_REF,
      research_plan_hash: `sha256:${"0".repeat(64)}`,
      concept_hypothesis_ref: CONCEPT_REF,
      created_at: request.created_at,
      research_depth: "standard",
      total_time_budget_minutes: 60,
      resource_allocation: allocation(),
      followup_round: 0,
      stages: stages.map((stage, index) => ({
        stage_id: stage.stage_id,
        stage_kind: stage.stage_kind,
        depends_on: stage.depends_on,
        gate_before: stage.gate_before,
        gate_after: stage.gate_after,
        lanes: [
          {
            unit_id: `unit_assessment_${index + 1}`,
            lane_role: stage.lane_role,
            reporting_dimensions: stage.dimensions,
            submission_path: `artifacts/assessment/lanes/unit-assessment-${index + 1}.attempt-1.json`,
            submission_schema: "startup_opportunity.assessment_lane_result.v1",
            time_budget_minutes: 20,
            max_sources: 10,
            straggler_policy: {
              on_timeout: "publish_partial",
              grace_minutes: 0,
              blocks_stage: true,
            },
            dispatch_group: stage.stage_id,
          },
        ],
      })),
      limitations: [PLACEHOLDER],
    },
  };
}

function planning(request: ScaffoldRequest): ScaffoldArtifact {
  if (request.mode === "concept_evidence_assessment") return assessmentPlanning(request);
  return {
    artifact_type: "startup_opportunity.research_execution_plan.discovery.current",
    artifact_path: EXECUTION_REF,
    producer_role: "main_agent",
    document: {
      schema_version: "startup_opportunity.research_execution_plan.discovery.current",
      execution_plan_id: "execution_scaffold",
      run_id: request.run_id,
      mode: request.mode,
      revision: 1,
      parent_execution_plan_ref: null,
      research_plan_ref: PLAN_REF,
      research_plan_hash: `sha256:${"0".repeat(64)}`,
      created_at: request.created_at,
      research_depth: "standard",
      total_time_budget_minutes: 60,
      resource_allocation: allocation(),
      stages: [
        {
          stage_id: "stage_commercial_scan",
          stage_kind: "discovery_generation",
          depends_on: [],
          gate_before: null,
          gate_after: "required",
          lanes: [
            {
              unit_id: "unit_scaffold",
              lane_role: "opportunity",
              candidate_scope: { kind: "none", candidate_refs: [] },
              reporting_dimensions: ["commercial_behavior"],
              submission_path: "artifacts/discovery/generation/unit_scaffold.r1.json",
              submission_schema: "startup_opportunity.discovery_generation_result.v1",
              time_budget_minutes: 30,
              max_sources: 20,
              straggler_policy: {
                on_timeout: "publish_partial",
                grace_minutes: 0,
                blocks_stage: true,
              },
              dispatch_group: "commercial_scan",
            },
          ],
        },
      ],
      limitations: [PLACEHOLDER],
    },
  };
}

function assessmentTask(request: ScaffoldRequest): ScaffoldArtifact {
  return {
    artifact_type: "startup_opportunity.research_task.assessment.current",
    artifact_path: ASSESSMENT_TASK_REF,
    producer_role: "main_agent",
    document: {
      schema_version: "startup_opportunity.research_task.assessment.current",
      task_id: "task_unit_assessment_scaffold",
      run_id: request.run_id,
      unit_id: "unit_assessment_scaffold",
      mode: request.mode,
      phase: "assessment",
      wave_id: "wave_assessment_scaffold",
      unit_type: "buyer_language",
      research_goal: PLACEHOLDER,
      commercial_research_requirements: commercialRequirements("solution_specific_evaluation"),
      target_subject_ref: CONCEPT_REF,
      scope_frame_ref: SCOPE_REF,
      research_plan_ref: PLAN_REF,
      assessment_plan_ref: ASSESSMENT_PLAN_REF,
      input_refs: [CONCEPT_REF, SCOPE_REF, PLAN_REF, ASSESSMENT_PLAN_REF],
      attempt: 1,
      supersedes_task_ref: null,
      agent_role: "lane-researcher",
      allowed_output_path: ASSESSMENT_BRANCH_REF,
      required_artifact_schema: "startup_opportunity.concept_evidence_assessment_branch_result.v1",
      required_stances: ["support", "oppose"],
      tool_guidance: [PLACEHOLDER],
      stop_conditions: [PLACEHOLDER],
      completion_message_contract: {
        include_artifact_path: true,
        include_validation_status: true,
        include_limitations: true,
        include_unresolved_questions: true,
        formal_artifact_authority: false,
      },
      execution_contract: {
        harness_dispatches_agent: false,
        hidden_llm_calls: false,
        hidden_network_research: false,
      },
      dispatched_at: request.created_at,
    },
  };
}

function task(request: ScaffoldRequest): ScaffoldArtifact {
  if (request.mode === "concept_evidence_assessment") return assessmentTask(request);
  return {
    artifact_type: "startup_opportunity.research_task.discovery_candidate.current",
    artifact_path: "tasks/discovery/unit_scaffold.attempt-1.json",
    producer_role: "main_agent",
    document: {
      schema_version: "startup_opportunity.research_task.discovery_candidate.current",
      task_id: "task_unit_scaffold",
      run_id: request.run_id,
      unit_id: "unit_scaffold",
      mode: request.mode,
      phase: "discovery",
      wave_id: "wave_commercial_scan",
      unit_type: "market_space",
      research_goal: PLACEHOLDER,
      commercial_research_requirements: commercialRequirements(),
      target_candidate_refs: [CANDIDATE_REF],
      scope_frame_ref: SCOPE_REF,
      research_plan_ref: PLAN_REF,
      input_refs: [CANDIDATE_REF, SCOPE_REF],
      attempt: 1,
      supersedes_task_ref: null,
      agent_role: "lane-researcher",
      source_phase: "candidate_generation",
      required_source_group_ids: ["source_group_scaffold"],
      allowed_output_path: "artifacts/discovery/lanes/unit_scaffold.attempt-1.json",
      required_artifact_schema: "startup_opportunity.discovery_lane_result.v1",
      required_stances: ["support", "oppose"],
      stop_conditions: [PLACEHOLDER],
      completion_message_contract: {
        formal_artifact_authority: false,
        include_artifact_path: true,
        include_limitations: true,
      },
      execution_contract: boundary(),
      dispatched_at: request.created_at,
    },
  };
}

function assessmentDispatch(request: ScaffoldRequest): ScaffoldArtifact {
  return {
    artifact_type: "startup_opportunity.dispatch_batch.assessment.current",
    artifact_path: "tasks/dispatch/assessment-scaffold.r1.json",
    producer_role: "harness",
    document: {
      schema_version: "startup_opportunity.dispatch_batch.assessment.current",
      dispatch_batch_id: "dispatch_assessment_scaffold",
      run_id: request.run_id,
      execution_plan_ref: EXECUTION_REF,
      research_plan_ref: PLAN_REF,
      stage_id: "assessment_stage_commercial",
      wave_id: "wave_assessment_scaffold",
      gate_ref: null,
      requested_at: request.created_at,
      dispatch_mode: "parallel_immediate",
      agent_dispatch_performed: false,
      tasks: [
        {
          task_id: "task_unit_assessment_scaffold",
          unit_id: "unit_assessment_scaffold",
          lane_role: "commercial",
          reporting_dimensions: [
            "buyer_language_and_willingness_to_pay",
            "acquisition_and_distribution",
          ],
          submission_path: ASSESSMENT_LANE_REF,
          time_budget_minutes: 20,
          max_sources: 10,
        },
      ],
    },
  };
}

function dispatch(request: ScaffoldRequest): ScaffoldArtifact {
  if (request.mode === "concept_evidence_assessment") return assessmentDispatch(request);
  return {
    artifact_type: "startup_opportunity.dispatch_batch.discovery.current",
    artifact_path: "tasks/dispatch/stage_scaffold.r1.json",
    producer_role: "harness",
    document: {
      schema_version: "startup_opportunity.dispatch_batch.discovery.current",
      batch_id: "dispatch_stage_scaffold",
      revision: 1,
      run_id: request.run_id,
      mode: request.mode,
      execution_plan_ref: EXECUTION_REF,
      research_plan_ref: PLAN_REF,
      stage_id: "stage_commercial_scan",
      dispatch_group: "commercial_scan",
      task_ready_at: request.created_at,
      dispatch_requested_at: request.created_at,
      dispatch_mode: "parallel_immediate",
      tasks: [
        {
          task_id: "task_unit_scaffold",
          unit_id: "unit_scaffold",
          lane_role: "opportunity",
          research_goal: PLACEHOLDER,
          input_refs: [CANDIDATE_REF, SCOPE_REF],
          allowed_output_path: "artifacts/discovery/generation/unit_scaffold.r1.json",
          required_artifact_schema: "startup_opportunity.discovery_generation_result.v1",
          time_budget_minutes: 30,
          max_sources: 20,
          straggler_policy: {
            on_timeout: "publish_partial",
            grace_minutes: 0,
            blocks_stage: true,
          },
        },
      ],
      agent_dispatch_performed: false,
      limitations: [PLACEHOLDER],
    },
  };
}

function assessmentReadiness(request: ScaffoldRequest): ScaffoldArtifact {
  return {
    artifact_type: "startup_opportunity.assessment_stage_gate.v1",
    artifact_path: ASSESSMENT_GATE_REF,
    producer_role: "harness",
    document: {
      schema_version: "startup_opportunity.assessment_stage_gate.v1",
      gate_id: "gate_assessment_scaffold",
      run_id: request.run_id,
      execution_plan_ref: EXECUTION_REF,
      concept_hypothesis_ref: CONCEPT_REF,
      stage_id: "assessment_stage_commercial",
      gate_kind: "commercial",
      evaluated_lane_refs: [ASSESSMENT_LANE_REF],
      dimension_decisions: [
        {
          dimension_id: "buyer_language_and_willingness_to_pay",
          lane_result_ref: ASSESSMENT_LANE_REF,
          decision: "insufficient_evidence",
          decision_sufficiency: "insufficient",
          decisive_refs: [],
        },
      ],
      outcome: "insufficient_evidence",
      thesis_killing_opposition: false,
      completed_stage_ids: ["assessment_stage_commercial"],
      not_started_unit_ids: [],
      allowed_next_actions: ["terminate_insufficient_evidence"],
      basis_refs: [ASSESSMENT_LANE_REF],
      rationale: PLACEHOLDER,
      created_at: request.created_at,
      limitations: [PLACEHOLDER],
    },
  };
}

function readiness(request: ScaffoldRequest): ScaffoldArtifact {
  if (request.mode === "concept_evidence_assessment") return assessmentReadiness(request);
  return {
    artifact_type: "startup_opportunity.discovery_stage_readiness.v1",
    artifact_path: READINESS_REF,
    producer_role: "main_agent",
    document: {
      schema_version: "startup_opportunity.discovery_stage_readiness.v1",
      readiness_id: "readiness_stage_scaffold",
      revision: 1,
      run_id: request.run_id,
      research_plan_ref: PLAN_REF,
      execution_plan_ref: EXECUTION_REF,
      stage_id: "stage_commercial_scan",
      next_stage_id: null,
      source_fan_in_ref: null,
      generation_result_refs: [],
      candidate_roles: [],
      required_candidate_kinds: ["demand_seed", "baseline_seed", "solution_seed"],
      missing_candidate_kinds: ["demand_seed", "baseline_seed", "solution_seed"],
      question_coverage: [
        {
          question_ref: `${PLAN_REF}#question_scaffold`,
          status: "unresolved",
          judgment_refs: [],
          evidence_refs: [],
          basis_refs: [],
        },
      ],
      commercial_signal_gate: {
        demand_signal: false,
        buyer_signal: false,
        purchase_signal: false,
        decision: "early_stop_insufficient_evidence",
      },
      next_stage_readiness: "terminal",
      blockers: [
        {
          blocker_id: "blocker_commercial_signal_missing",
          blocker_kind: "evidence_missing",
          candidate_kind: null,
          basis_refs: [],
          allowed_actions: ["terminate_insufficient_evidence"],
          detail: PLACEHOLDER,
        },
      ],
      allowed_next_actions: ["terminate_insufficient_evidence"],
      stop_basis: "no_information_gain",
      limitations: [PLACEHOLDER],
    },
  };
}

function assessmentGap(request: ScaffoldRequest): ScaffoldArtifact {
  const hash = `sha256:${"0".repeat(64)}`;
  const coverageKey = canonicalContentHash({
    run_id: request.run_id,
    dimension_id: "buyer_language_and_willingness_to_pay",
  });
  const basisRefs = [
    ASSESSMENT_BRANCH_REF,
    ASSESSMENT_TASK_REF,
    PLAN_REF,
    ASSESSMENT_PLAN_REF,
    SCOPE_REF,
  ];
  return {
    artifact_type: "startup_opportunity.gap_snapshot.assessment.current",
    artifact_path: GAP_REF,
    producer_role: "harness",
    document: {
      schema_version: "startup_opportunity.gap_snapshot.assessment.current",
      snapshot_id: "gap_snapshot_assessment_scaffold",
      snapshot_cycle_key: canonicalContentHash({ run_id: request.run_id, basis_refs: basisRefs }),
      coverage_key: coverageKey,
      run_id: request.run_id,
      based_on_plan_ref: PLAN_REF,
      based_on_plan_revision: 1,
      based_on_plan_hash: hash,
      assessment_plan_ref: ASSESSMENT_PLAN_REF,
      assessment_plan_revision: 1,
      assessment_plan_hash: hash,
      subject_ref: CONCEPT_REF,
      scope_frame_ref: SCOPE_REF,
      scope_frame_hash: hash,
      revision: 1,
      parent_snapshot_ref: null,
      created_at: request.created_at,
      trigger_kind: "wave_completed",
      trigger_event_ref: null,
      phase: "assessment",
      wave_id: "wave_assessment_scaffold",
      observed_artifacts: [
        {
          artifact_ref: ASSESSMENT_BRANCH_REF,
          artifact_type: "startup_opportunity.concept_evidence_assessment_branch_result.v1",
          content_hash: hash,
          task_ref: ASSESSMENT_TASK_REF,
          task_hash: hash,
          unit_id: "unit_assessment_scaffold",
          attempt: 1,
          unit_state: "completed",
          branch_status: "insufficient_evidence",
        },
      ],
      gaps: [
        {
          gap_id: "gap_assessment_scaffold",
          coverage_key: coverageKey,
          subject_ref: CONCEPT_REF,
          dimension_id: "buyer_language_and_willingness_to_pay",
          gap_type: "no_material_new_evidence",
          detection_mode: "deterministic",
          coverage_status: "insufficient",
          decision_impact: ["recommendation_band", "next_action"],
          severity: "blocking",
          research_goal: PLACEHOLDER,
          basis_refs: basisRefs,
          evidence_refs: [],
          recommended_unit_type: null,
          followup_status: "stop",
          limitations: [PLACEHOLDER],
        },
      ],
      material_new_evidence_observed: false,
      stop_signals: ["no_material_new_evidence"],
      limitations: [PLACEHOLDER],
    },
  };
}

function gap(request: ScaffoldRequest): ScaffoldArtifact {
  if (request.mode === "concept_evidence_assessment") return assessmentGap(request);
  const identity = {
    run_id: request.run_id,
    plan_ref: PLAN_REF,
    readiness_ref: READINESS_REF,
    kind: "commercial_signal_missing",
  };
  return {
    artifact_type: "startup_opportunity.gap_snapshot.discovery.readiness.current",
    artifact_path: GAP_REF,
    producer_role: "harness",
    document: {
      schema_version: "startup_opportunity.gap_snapshot.discovery.readiness.current",
      snapshot_id: "gap_snapshot_scaffold",
      snapshot_cycle_key: canonicalContentHash(identity),
      run_id: request.run_id,
      based_on_plan_ref: PLAN_REF,
      revision: 1,
      parent_snapshot_ref: null,
      created_at: request.created_at,
      trigger_kind: "wave_completed",
      trigger_event_ref: null,
      phase: "discovery",
      wave_id: "wave_commercial_scan",
      readiness_ref: READINESS_REF,
      fan_in_ref: null,
      observed_artifact_refs: [READINESS_REF],
      gaps: [
        {
          gap_id: "gap_commercial_signal_missing",
          subject_ref: CANDIDATE_REF,
          gap_type: "evidence_missing",
          detection_mode: "deterministic",
          decision_impact: ["recommendation_band", "next_action"],
          severity: "blocking",
          basis_refs: [READINESS_REF],
          evidence_refs: [],
          recommended_unit_types: [],
          allowed_actions: ["terminate_insufficient_evidence"],
          detail: PLACEHOLDER,
        },
      ],
      material_new_evidence_observed: false,
      unresolved_decision_relevant_questions: [`${PLAN_REF}#question_scaffold`],
      stop_signals: ["no_material_new_evidence"],
    },
  };
}

function assessmentDecision(request: ScaffoldRequest): ScaffoldArtifact {
  const hash = `sha256:${"0".repeat(64)}`;
  return {
    artifact_type: "startup_opportunity.adaptation_decision.assessment.current",
    artifact_path: "adaptations/decisions/assessment-scaffold.json",
    producer_role: "main_agent",
    document: {
      schema_version: "startup_opportunity.adaptation_decision.assessment.current",
      adaptation_id: "adaptation_assessment_scaffold",
      run_id: request.run_id,
      based_on_plan_ref: PLAN_REF,
      based_on_plan_revision: 1,
      based_on_plan_hash: hash,
      assessment_plan_ref: ASSESSMENT_PLAN_REF,
      assessment_plan_revision: 1,
      assessment_plan_hash: hash,
      subject_ref: CONCEPT_REF,
      scope_frame_ref: SCOPE_REF,
      scope_frame_hash: hash,
      trigger_gap_refs: [`${GAP_REF}#gap_assessment_scaffold`],
      coverage_key: canonicalContentHash({
        run_id: request.run_id,
        dimension_id: "buyer_language_and_willingness_to_pay",
      }),
      action: "stop_followup",
      reason: PLACEHOLDER,
      expected_decision_impact: ["recommendation_band", "next_action"],
      stop_condition: PLACEHOLDER,
      requested_by: "main_agent",
      created_at: request.created_at,
    },
  };
}

function decision(request: ScaffoldRequest): ScaffoldArtifact {
  if (request.mode === "concept_evidence_assessment") return assessmentDecision(request);
  return {
    artifact_type: "startup_opportunity.adaptation_decision.discovery.current",
    artifact_path: "adaptations/decisions/scaffold.json",
    producer_role: "main_agent",
    document: {
      schema_version: "startup_opportunity.adaptation_decision.discovery.current",
      adaptation_id: "adaptation_scaffold",
      run_id: request.run_id,
      based_on_plan_ref: PLAN_REF,
      trigger_gap_refs: [`${GAP_REF}#gap_commercial_signal_missing`],
      action: "terminate_insufficient_evidence",
      reason: PLACEHOLDER,
      expected_decision_impact: ["recommendation_band", "next_action"],
      stop_condition: PLACEHOLDER,
      requested_by: "main_agent",
      created_at: request.created_at,
    },
  };
}

function terminalReportSource(request: ScaffoldRequest): ScaffoldArtifact {
  const artifactPath = "artifacts/reporting/terminal-report-source.r1.json";
  return {
    artifact_type: "startup_opportunity.terminal_report_source.v1",
    artifact_path: artifactPath,
    producer_role: "main_agent",
    document: {
      schema_version: "startup_opportunity.terminal_report_source.v1",
      report_id: "terminal_report_scaffold",
      run_id: request.run_id,
      mode: request.mode,
      research_language: request.scope_confirmation.research_language,
      producer_role: "main_agent",
      owned_output_path: artifactPath,
      materialized_path: "report.json",
      generated_at: request.created_at,
      terminal_outcome: "insufficient_evidence",
      decision_question: request.scope_confirmation.decision_goal,
      execution: {
        completeness: "partial",
        completed_stages: [],
        incomplete_stages: [
          {
            stage: "commercial research",
            cause: "evidence_ceiling",
            detail: PLACEHOLDER,
            conclusion_impact: PLACEHOLDER,
            related_refs: [],
          },
        ],
        required_followups: [],
        pending_operation_refs: [],
      },
      research_conclusion: {
        outcome: "insufficient_evidence",
        current_recommendation: PLACEHOLDER,
        meaning: PLACEHOLDER,
        evidence_strength: "insufficient",
        allowed_claim: PLACEHOLDER,
      },
      runtime_health: { status: "healthy", issues: [] },
      directions: [],
      sources: [],
      excluded_evidence: [],
      commercial_research_audit_refs: [],
      commercial_uncertainties: [],
      quantitative_signal_rows: [],
      competitive_substitute_rows: [],
      research_coverage_gaps: [],
      ordered_validation_plan: [],
      freshness: {
        earliest_valid_as_of: null,
        latest_valid_as_of: null,
        summary: PLACEHOLDER,
      },
      limitations: [PLACEHOLDER],
      external_action_boundary: {
        execution_owner: "user",
        execution_supported: false,
        result_tracking_supported: false,
        external_validation_claimed: false,
      },
      audit_refs: [],
    },
  };
}

const BUILDERS: Readonly<Record<ScaffoldKind, (request: ScaffoldRequest) => ScaffoldArtifact>> = {
  intake,
  planning,
  task,
  dispatch,
  readiness,
  gap,
  decision,
  terminal_report_source: terminalReportSource,
};

export function buildArtifactScaffold(
  value: unknown,
  validator: ArtifactValidator,
): Record<string, unknown> {
  const requestValidation = validator.validateDocument(value);
  if (
    !requestValidation.valid ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new StoreError("scaffold.request_invalid", "scaffold request is not schema-valid", {
      errors: requestValidation.errors,
    });
  }
  const request = value as ScaffoldRequest;
  const artifact = BUILDERS[request.kind](request);
  const documentValidation = validator.validateDocument(artifact.document, artifact.artifact_path);
  if (!documentValidation.valid) {
    throw new StoreError("scaffold.output_invalid", "deterministic scaffold is not schema-valid", {
      kind: request.kind,
      errors: documentValidation.errors,
    });
  }
  const compilationRequest: RuntimeArtifactCompilationRequest = {
    schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
    request_id: `compile_${request.scaffold_id}`,
    run_id: request.run_id,
    operation: "validate_only",
    created_at: request.created_at,
    artifacts: [artifact],
  };
  const result = {
    schema_version: "startup_opportunity.scaffold_result.current",
    scaffold_id: request.scaffold_id,
    kind: request.kind,
    run_id: request.run_id,
    schema_valid: true,
    semantic_judgment_generated: false,
    working_directory: `dist/research-working/${request.run_id}`,
    compilation_request: compilationRequest,
  };
  const resultValidation = validator.validateDocument(result);
  if (!resultValidation.valid) {
    throw new StoreError("scaffold.result_invalid", "scaffold result is not schema-valid", {
      errors: resultValidation.errors,
    });
  }
  return result;
}

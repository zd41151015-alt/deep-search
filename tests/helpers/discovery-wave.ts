import {
  artifactRefsForDocument,
  canonicalContentHash,
  type DocumentBundle,
  type FormalArtifactEnvelope,
} from "../../harness/src/index.js";

type DiscoveryTaskType =
  | "startup_opportunity.research_task.discovery_candidate.current"
  | "startup_opportunity.research_task.discovery_evaluation.current";

function effectiveDocument(bundle: DocumentBundle, artifactPath: string): Record<string, unknown> {
  const entry = bundle.documents.find((candidate) => candidate.path === artifactPath);
  if (entry === undefined) {
    throw new Error(`missing fixture document: ${artifactPath}`);
  }
  return String(entry.document.schema_version).startsWith("startup_opportunity.artifact_envelope.")
    ? (entry.document.document as Record<string, unknown>)
    : entry.document;
}

function envelope(
  runId: string,
  artifactPath: string,
  document: Record<string, unknown>,
  createdAt: string,
  producerRole: "main_agent" | "harness",
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: String(document.schema_version),
    artifact_path: artifactPath,
    run_id: runId,
    created_at: createdAt,
    producer_role: producerRole,
    input_refs: artifactRefsForDocument({ path: artifactPath, document }).filter(
      (ref) => ref.split("#", 1)[0] !== artifactPath,
    ),
    content_hash: canonicalContentHash(document),
    document,
  } as FormalArtifactEnvelope;
}

export function refreshDiscoveryRuntimeLineage(bundle: DocumentBundle): DocumentBundle {
  for (const entry of bundle.documents) {
    const stored = entry.document;
    if (
      !String(stored.schema_version).startsWith("startup_opportunity.artifact_envelope.") ||
      stored.artifact_type !== "startup_opportunity.research_execution_plan.discovery.current"
    ) {
      continue;
    }
    const execution = stored.document as Record<string, unknown>;
    const planRef = String(execution.research_plan_ref);
    execution.research_plan_hash = canonicalContentHash(effectiveDocument(bundle, planRef));
    stored.content_hash = canonicalContentHash(execution);
  }
  return bundle;
}

export function discoveryWaveEnvelopes(
  bundle: DocumentBundle,
  runId: string,
  taskType: DiscoveryTaskType,
  revision: number,
  suffix: string,
): FormalArtifactEnvelope[] {
  const fixtureTasks = bundle.documents
    .map((entry) => entry.document)
    .filter(
      (document): document is FormalArtifactEnvelope =>
        String(document.schema_version).startsWith("startup_opportunity.artifact_envelope.") &&
        document.artifact_type === taskType,
    );
  if (fixtureTasks.length === 0) {
    throw new Error(`missing fixture tasks: ${taskType}`);
  }
  const planRefs = [
    ...new Set(fixtureTasks.map((task) => String(task.document.research_plan_ref))),
  ];
  if (planRefs.length !== 1) {
    throw new Error(`fixture tasks do not share one Research Plan: ${planRefs.join(",")}`);
  }
  const planRef = planRefs[0] as string;
  const plan = effectiveDocument(bundle, planRef);
  const unitBindings = new Map<string, { waveId: unknown; unit: Record<string, unknown> }>();
  for (const wave of plan.waves as Record<string, unknown>[]) {
    for (const unit of wave.units as Record<string, unknown>[]) {
      unitBindings.set(String(unit.unit_id), { waveId: wave.wave_id, unit });
    }
  }
  const tasks = fixtureTasks.map((fixtureTask) => {
    const task = structuredClone(fixtureTask);
    const binding = unitBindings.get(String(task.document.unit_id));
    if (binding === undefined) {
      throw new Error(`fixture task unit is absent from Plan: ${String(task.document.unit_id)}`);
    }
    task.document.wave_id = binding.waveId;
    task.document.unit_type = binding.unit.unit_type;
    task.document.research_goal = binding.unit.research_goal;
    task.document.input_refs = binding.unit.input_refs;
    task.document.attempt = binding.unit.attempt;
    task.document.agent_role = binding.unit.agent_role;
    task.document.allowed_output_path = binding.unit.output_path;
    task.document.required_artifact_schema = binding.unit.required_artifact_schema;
    (task as { content_hash: string }).content_hash = canonicalContentHash(task.document);
    return task;
  });
  const executionPath = `plans/research-execution.r${revision}.json`;
  const dispatchPath = `tasks/dispatch/${suffix}.r1.json`;
  const stageId = `stage_${suffix}`;
  const dispatchGroup = `group_${suffix}`;
  const lanePolicy = {
    time_budget_minutes: 10,
    max_sources: 5,
    straggler_policy: {
      on_timeout: "publish_partial",
      grace_minutes: 2,
      blocks_stage: true,
    },
  };
  const candidateRefs = [
    ...new Set(
      tasks.flatMap((task) => {
        const targetRefs = [
          ...(Array.isArray(task.document.target_candidate_refs)
            ? task.document.target_candidate_refs
            : []),
          ...(Array.isArray(task.document.target_opportunity_refs)
            ? task.document.target_opportunity_refs
            : []),
        ];
        return targetRefs.filter((ref): ref is string => typeof ref === "string");
      }),
    ),
  ];
  const targetedResponse =
    taskType === "startup_opportunity.research_task.discovery_evaluation.current";
  const incumbentResponseAssignment = {
    analysis_depth: targetedResponse ? "targeted_deep_dive" : "lightweight_scan",
    assignment_role: "owner",
    subject_refs: candidateRefs,
    rationale: targetedResponse
      ? "Shortlisted opportunities receive a bounded targeted response deep dive."
      : "Formed candidates receive a bounded lightweight response scan.",
  };
  const unassignedIncumbentResponse = {
    analysis_depth: "not_assigned",
    assignment_role: "none",
    subject_refs: [],
    rationale: "This lane is not the assigned incumbent response owner.",
  };
  const ownerIndex = Math.max(
    0,
    tasks.findIndex((task) => task.document.source_phase !== "candidate_generation"),
  );
  tasks.forEach((task, index) => {
    const requirements = task.document.commercial_research_requirements as Record<string, unknown>;
    requirements.incumbent_response_assignment = structuredClone(
      index === ownerIndex ? incumbentResponseAssignment : unassignedIncumbentResponse,
    );
    (task as { content_hash: string }).content_hash = canonicalContentHash(task.document);
  });
  const lanes = tasks.map((task, index) => ({
    unit_id: task.document.unit_id,
    lane_role: "evaluation",
    candidate_scope: { kind: targetedResponse ? "retained" : "none", candidate_refs: [] },
    incumbent_response_assignment: structuredClone(
      index === ownerIndex ? incumbentResponseAssignment : unassignedIncumbentResponse,
    ),
    reporting_dimensions: ["demand"],
    submission_path: task.document.allowed_output_path,
    submission_schema: task.document.required_artifact_schema,
    ...lanePolicy,
    dispatch_group: dispatchGroup,
  }));
  const execution = {
    schema_version: "startup_opportunity.research_execution_plan.discovery.current",
    execution_plan_id: `execution_${suffix}`,
    run_id: runId,
    mode: plan.mode,
    revision,
    parent_execution_plan_ref:
      revision === 1 ? null : `plans/research-execution.r${revision - 1}.json`,
    research_plan_ref: planRef,
    research_plan_hash: canonicalContentHash(plan),
    created_at: "2026-07-27T18:00:00Z",
    research_depth: "quick",
    total_time_budget_minutes: 10,
    resource_allocation: {
      customer_commercial_percent: 65,
      market_structure_percent: 17,
      academic_percent: 18,
    },
    stages: [
      {
        stage_id: stageId,
        stage_kind: targetedResponse ? "retained_candidate_deep_review" : "candidate_evaluation",
        depends_on: [],
        gate_before: null,
        gate_after: "required",
        lanes,
      },
    ],
    limitations: ["SYNTHETIC fixture execution overlay; no research was performed."],
  };
  const dispatch = {
    schema_version: "startup_opportunity.dispatch_batch.discovery.current",
    batch_id: `batch_${suffix}`,
    revision: 1,
    run_id: runId,
    mode: plan.mode,
    execution_plan_ref: executionPath,
    research_plan_ref: planRef,
    stage_id: stageId,
    dispatch_group: dispatchGroup,
    task_ready_at: "2026-07-27T18:01:00Z",
    dispatch_requested_at: "2026-07-27T18:01:01Z",
    dispatch_mode: "parallel_immediate",
    tasks: tasks.map((task, index) => {
      const unit = unitBindings.get(String(task.document.unit_id))?.unit as Record<string, unknown>;
      return {
        task_id: task.document.task_id,
        unit_id: task.document.unit_id,
        lane_role: "evaluation",
        incumbent_response_assignment: structuredClone(
          index === ownerIndex ? incumbentResponseAssignment : unassignedIncumbentResponse,
        ),
        research_goal: unit.research_goal,
        input_refs: unit.input_refs,
        allowed_output_path: task.document.allowed_output_path,
        required_artifact_schema: task.document.required_artifact_schema,
        ...lanePolicy,
      };
    }),
    agent_dispatch_performed: false,
    launch_registration_required: true,
    limitations: ["SYNTHETIC fixture Dispatch; no agent was started."],
  };
  return [
    envelope(runId, executionPath, execution, "2026-07-27T18:00:00Z", "main_agent"),
    envelope(runId, dispatchPath, dispatch, "2026-07-27T18:00:00Z", "harness"),
    ...tasks,
  ];
}

import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import { RunStore } from "../run-store/run-store.js";
import type { ArtifactValidator, DocumentBundle } from "../validators/artifact-validator.js";
import {
  DeclarativeRuntimeCompiler,
  type DispatchLaunchCheckResult,
} from "./declarative-runtime.js";

export interface DispatchLaunchRegistrationRequest extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.dispatch_launch_registration_request.v1";
  readonly request_id: string;
  readonly run_id: string;
  readonly dispatch_ref: string;
  readonly dispatch_hash: string;
  readonly registered_at: string;
  readonly registrations: readonly {
    readonly unit_id: string;
    readonly task_ref: string;
    readonly task_id: string;
    readonly attempt: number;
    readonly execution_attempt_id: string;
  }[];
}

interface EffectiveArtifact {
  readonly path: string;
  readonly artifactType: string;
  readonly contentHash: string | null;
  readonly document: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function effectiveArtifacts(bundle: DocumentBundle): readonly EffectiveArtifact[] {
  return bundle.documents.flatMap<EffectiveArtifact>((entry) => {
    if (
      entry.document.schema_version === "startup_opportunity.artifact_envelope.current" &&
      typeof entry.document.artifact_type === "string" &&
      typeof entry.document.content_hash === "string" &&
      isRecord(entry.document.document)
    ) {
      return [
        {
          path: entry.path,
          artifactType: entry.document.artifact_type,
          contentHash: entry.document.content_hash,
          document: entry.document.document,
        },
      ];
    }
    if (typeof entry.document.schema_version !== "string") return [];
    return [
      {
        path: entry.path,
        artifactType: entry.document.schema_version,
        contentHash: null,
        document: entry.document,
      },
    ];
  });
}

function dispatchRequestedAt(dispatch: Record<string, unknown>): string {
  return String(dispatch.dispatch_requested_at ?? dispatch.requested_at);
}

function dispatchTaskReadyAt(dispatch: Record<string, unknown>): string {
  return String(dispatch.task_ready_at ?? dispatch.requested_at);
}

function taskOutputPath(task: Record<string, unknown>): string {
  return String(task.allowed_output_path ?? task.submission_path);
}

function formalTaskForDispatchTask(
  task: Record<string, unknown>,
  artifacts: readonly EffectiveArtifact[],
): EffectiveArtifact | undefined {
  return artifacts.find(
    (entry) =>
      entry.artifactType.startsWith("startup_opportunity.research_task.") &&
      entry.document.task_id === task.task_id &&
      entry.document.unit_id === task.unit_id,
  );
}

function taskRef(dispatchRef: string, task: Record<string, unknown>): string {
  return `${dispatchRef}#${String(task.task_id)}`;
}

function taskAttempt(
  task: Record<string, unknown>,
  artifacts: readonly EffectiveArtifact[],
): number {
  const submissionAttempt = /\.attempt-([1-9][0-9]*)\.json$/u.exec(
    String(task.submission_path ?? ""),
  )?.[1];
  return Number(
    formalTaskForDispatchTask(task, artifacts)?.document.attempt ??
      task.attempt ??
      submissionAttempt ??
      1,
  );
}

function taskSchema(
  task: Record<string, unknown>,
  artifacts: readonly EffectiveArtifact[],
): string {
  return String(
    formalTaskForDispatchTask(task, artifacts)?.document.required_artifact_schema ??
      task.required_artifact_schema ??
      task.submission_schema ??
      "startup_opportunity.assessment_lane_result.v1",
  );
}

function launchLifecyclePath(unitId: string, attempt: number): string {
  return `artifacts/runtime/lane-lifecycle/${unitId}.attempt-${attempt}.launch.r1.json`;
}

export class DispatchLaunchRegistry {
  private readonly runs: RunStore;
  private readonly compiler: DeclarativeRuntimeCompiler;

  constructor(
    runsRoot: string,
    private readonly validator: ArtifactValidator,
    repositoryRoot = process.cwd(),
  ) {
    this.runs = new RunStore(runsRoot, validator);
    this.compiler = new DeclarativeRuntimeCompiler(runsRoot, validator, repositoryRoot);
  }

  private async artifacts(runId: string): Promise<readonly EffectiveArtifact[]> {
    const context = await this.runs.buildValidationContext(
      runId,
      {
        schema_version: "startup_opportunity.document_bundle.current",
        documents: [{ path: "manifest.json", document: (await this.runs.status(runId)).manifest }],
        exact_records: [],
      },
      { includeAllFormalArtifacts: true },
    );
    return effectiveArtifacts(context.bundle);
  }

  private dispatch(
    artifacts: readonly EffectiveArtifact[],
    runId: string,
    dispatchRef: string,
    dispatchHash: string,
  ): EffectiveArtifact {
    const dispatch = artifacts.find((entry) => entry.path === dispatchRef);
    if (
      dispatch === undefined ||
      ![
        "startup_opportunity.dispatch_batch.discovery.current",
        "startup_opportunity.dispatch_batch.assessment.current",
      ].includes(dispatch.artifactType) ||
      dispatch.document.run_id !== runId
    ) {
      throw new StoreError(
        "runtime.launch_dispatch_invalid",
        "launch registration requires one exact same-Run Dispatch batch",
        { dispatchRef },
      );
    }
    if (
      dispatch.contentHash !== dispatchHash ||
      canonicalContentHash(dispatch.document) !== dispatchHash
    ) {
      throw new StoreError(
        "runtime.launch_dispatch_stale",
        "launch registration Dispatch hash does not match the immutable stored batch",
        { dispatchRef, suppliedHash: dispatchHash, currentHash: dispatch.contentHash },
      );
    }
    return dispatch;
  }

  async check(
    runId: string,
    dispatchRef: string,
    dispatchHash: string,
  ): Promise<DispatchLaunchCheckResult> {
    const artifacts = await this.artifacts(runId);
    const dispatch = this.dispatch(artifacts, runId, dispatchRef, dispatchHash);
    const tasks = Array.isArray(dispatch.document.tasks)
      ? dispatch.document.tasks.filter(isRecord)
      : [];
    const taskIds = new Set(tasks.map((task) => String(task.task_id)));
    const lifecycles = artifacts.filter(
      (entry) => entry.artifactType === "startup_opportunity.lane_lifecycle.v1",
    );
    const matching = lifecycles.filter(
      (entry) =>
        String(entry.document.dispatch_batch_ref).split("#", 1)[0] === dispatchRef &&
        entry.document.dispatch_batch_hash === dispatchHash,
    );
    const unexpectedRegistrations = lifecycles
      .filter((entry) => String(entry.document.dispatch_batch_ref).split("#", 1)[0] === dispatchRef)
      .filter((entry) => {
        const taskId = String(entry.document.dispatch_batch_ref).split("#", 2)[1] ?? "";
        return entry.document.dispatch_batch_hash !== dispatchHash || !taskIds.has(taskId);
      })
      .map((entry) => entry.path)
      .sort();
    const checklist = tasks
      .map((task) => {
        const unitId = String(task.unit_id);
        const taskId = String(task.task_id);
        const attempt = taskAttempt(task, artifacts);
        const registrations = matching.filter(
          (entry) =>
            entry.document.unit_id === unitId &&
            entry.document.task_id === taskId &&
            entry.document.attempt === attempt &&
            entry.document.task_ref === taskRef(dispatchRef, task) &&
            typeof entry.document.launch_registration_id === "string",
        );
        const executionAttemptIds = [
          ...new Set(registrations.map((entry) => String(entry.document.execution_attempt_id))),
        ].sort();
        return {
          unit_id: unitId,
          task_ref: taskRef(dispatchRef, task),
          task_id: taskId,
          attempt,
          allowed_output_path: taskOutputPath(task),
          required_artifact_schema: taskSchema(task, artifacts),
          execution_attempt_ids: executionAttemptIds,
          launch_state:
            executionAttemptIds.length === 0
              ? ("not_started" as const)
              : executionAttemptIds.length === 1
                ? ("started" as const)
                : ("conflict" as const),
        };
      })
      .sort((left, right) => left.unit_id.localeCompare(right.unit_id));
    const started = checklist
      .filter((entry) => entry.launch_state === "started")
      .map((entry) => entry.unit_id);
    const notStarted = checklist
      .filter((entry) => entry.launch_state === "not_started")
      .map((entry) => entry.unit_id);
    const conflict =
      unexpectedRegistrations.length > 0 ||
      checklist.some((entry) => entry.launch_state === "conflict");
    const result: DispatchLaunchCheckResult = {
      schema_version: "startup_opportunity.dispatch_launch_check_result.v1",
      run_id: runId,
      dispatch_ref: dispatchRef,
      dispatch_hash: dispatchHash,
      checklist,
      started_unit_ids: started,
      not_started_unit_ids: notStarted,
      unexpected_registrations: unexpectedRegistrations,
      status: conflict ? "conflict" : notStarted.length === 0 ? "closed" : "open",
    };
    const validation = this.validator.validateDocument(result);
    if (!validation.valid) {
      throw new StoreError(
        "runtime.launch_check_result_invalid",
        "Harness produced an invalid Dispatch launch check result",
        { errors: validation.errors },
      );
    }
    return result;
  }

  async register(requestValue: unknown): Promise<DispatchLaunchCheckResult> {
    const validation = this.validator.validateDocument(requestValue);
    if (!validation.valid || !isRecord(requestValue)) {
      throw new StoreError(
        "runtime.launch_registration_request_invalid",
        "Dispatch launch registration request is not schema-valid",
        { errors: validation.errors },
      );
    }
    const request = requestValue as DispatchLaunchRegistrationRequest;
    await this.runs.load(request.run_id);
    await this.runs.assertResearchExecutionAllowed(request.run_id);
    const artifacts = await this.artifacts(request.run_id);
    const dispatch = this.dispatch(
      artifacts,
      request.run_id,
      request.dispatch_ref,
      request.dispatch_hash,
    );
    const tasks = Array.isArray(dispatch.document.tasks)
      ? dispatch.document.tasks.filter(isRecord)
      : [];
    const lifecycles = artifacts.filter(
      (entry) => entry.artifactType === "startup_opportunity.lane_lifecycle.v1",
    );
    const requestHash = canonicalContentHash(request);
    if (Date.parse(request.registered_at) < Date.parse(dispatchRequestedAt(dispatch.document))) {
      throw new StoreError(
        "runtime.launch_registration_time_invalid",
        "launch registration time cannot precede the exact Dispatch request",
        {
          registeredAt: request.registered_at,
          dispatchRequestedAt: dispatchRequestedAt(dispatch.document),
        },
      );
    }
    const duplicateUnits = request.registrations.map((entry) => entry.unit_id);
    const duplicateAttempts = request.registrations.map((entry) => entry.execution_attempt_id);
    if (
      new Set(duplicateUnits).size !== duplicateUnits.length ||
      new Set(duplicateAttempts).size !== duplicateAttempts.length
    ) {
      throw new StoreError(
        "runtime.launch_registration_duplicate",
        "one launch registration request cannot repeat a Unit or execution attempt",
      );
    }
    const priorRequest = lifecycles.filter(
      (entry) =>
        entry.document.launch_registration_id === request.request_id &&
        entry.document.revision === 1,
    );
    if (priorRequest.some((entry) => entry.document.launch_registration_hash !== requestHash)) {
      throw new StoreError(
        "runtime.launch_registration_replay_conflict",
        "launch registration request id was already used with different content",
        { requestId: request.request_id },
      );
    }
    if (priorRequest.length > 0) {
      const replayedUnits = priorRequest.map((entry) => String(entry.document.unit_id)).sort();
      if (canonicalJson(replayedUnits) !== canonicalJson([...duplicateUnits].sort())) {
        throw new StoreError(
          "runtime.launch_registration_replay_conflict",
          "launch registration replay does not match the original atomic batch",
          { requestId: request.request_id },
        );
      }
      return this.check(request.run_id, request.dispatch_ref, request.dispatch_hash);
    }

    const artifactsToPublish = request.registrations.map((registration) => {
      const lifecyclePath = launchLifecyclePath(registration.unit_id, registration.attempt);
      if (artifacts.some((entry) => entry.path === lifecyclePath)) {
        throw new StoreError(
          "runtime.launch_registration_path_conflict",
          "launch lifecycle path is already occupied by another formal record",
          { lifecyclePath },
        );
      }
      const task = tasks.find((candidate) => candidate.task_id === registration.task_id);
      if (
        task === undefined ||
        task.unit_id !== registration.unit_id ||
        taskRef(request.dispatch_ref, task) !== registration.task_ref ||
        taskAttempt(task, artifacts) !== registration.attempt
      ) {
        throw new StoreError(
          "runtime.launch_registration_dispatch_mismatch",
          "launch declaration must identify one exact task in the Dispatch checklist",
          { registration },
        );
      }
      const formalTask = formalTaskForDispatchTask(task, artifacts);
      if (
        formalTask !== undefined &&
        (!formalTask.artifactType.startsWith("startup_opportunity.research_task.") ||
          formalTask.document.run_id !== request.run_id ||
          formalTask.document.unit_id !== registration.unit_id ||
          formalTask.document.task_id !== registration.task_id ||
          formalTask.document.attempt !== registration.attempt ||
          formalTask.document.allowed_output_path !== taskOutputPath(task) ||
          formalTask.document.required_artifact_schema !== taskSchema(task, artifacts))
      ) {
        throw new StoreError(
          "runtime.launch_registration_task_mismatch",
          "launch declaration must bind the exact same-Run formal Task and output contract",
          { taskRef: registration.task_ref },
        );
      }
      const dispatchTaskRef = `${request.dispatch_ref}#${registration.task_id}`;
      const conflicting = lifecycles.find(
        (entry) =>
          (entry.document.execution_attempt_id === registration.execution_attempt_id &&
            (entry.document.unit_id !== registration.unit_id ||
              entry.document.task_ref !== registration.task_ref ||
              entry.document.attempt !== registration.attempt)) ||
          (entry.document.dispatch_batch_ref === dispatchTaskRef &&
            entry.document.unit_id === registration.unit_id &&
            entry.document.attempt === registration.attempt &&
            typeof entry.document.launch_registration_id === "string"),
      );
      if (conflicting !== undefined) {
        throw new StoreError(
          "runtime.launch_registration_conflict",
          "a dispatched task or execution attempt is already registered with another identity",
          { existingLifecycleRef: conflicting.path, registration },
        );
      }
      const document = {
        schema_version: "startup_opportunity.lane_lifecycle.v1",
        lifecycle_id: `lifecycle_${registration.unit_id}_attempt_${registration.attempt}`,
        revision: 1,
        parent_lifecycle_ref: null,
        run_id: request.run_id,
        unit_id: registration.unit_id,
        attempt: registration.attempt,
        execution_attempt_id: registration.execution_attempt_id,
        dispatch_batch_ref: dispatchTaskRef,
        dispatch_batch_hash: request.dispatch_hash,
        task_ref: registration.task_ref,
        task_id: registration.task_id,
        launch_registration_id: request.request_id,
        launch_registration_hash: requestHash,
        state: "agent_started",
        timestamps: {
          task_ready_at: dispatchTaskReadyAt(dispatch.document),
          dispatch_requested_at: dispatchRequestedAt(dispatch.document),
          agent_started_at: request.registered_at,
          evidence_recorded_at: null,
          handoff_ready_at: null,
          formalization_validated_at: null,
          published_at: null,
        },
        failure: null,
        limitations: [
          "Caller-declared launch registration; the Harness does not verify that an external Codex task exists.",
        ],
      };
      return {
        artifact_type: document.schema_version,
        artifact_path: lifecyclePath,
        producer_role: "main_agent" as const,
        document,
      };
    });

    await this.compiler.compile({
      schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
      request_id: request.request_id,
      run_id: request.run_id,
      operation: "publish",
      created_at: request.registered_at,
      artifacts: artifactsToPublish,
    });
    return this.check(request.run_id, request.dispatch_ref, request.dispatch_hash);
  }
}

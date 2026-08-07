import {
  artifactRefsForDocument,
  canonicalContentHash,
  type DocumentBundle,
  type FormalArtifactEnvelope,
} from "../../harness/src/index.js";
import { unavailableCommercialResearchAudit } from "../fixtures/quantitative-competitive-fixture.js";

interface RuntimeTaskBinding {
  readonly task: FormalArtifactEnvelope;
  readonly execution: FormalArtifactEnvelope;
  readonly dispatch: FormalArtifactEnvelope;
}

export function projectCommercialAuditsForRuntime(
  bundle: DocumentBundle,
  runId: string,
  runtimeWaves: readonly (readonly FormalArtifactEnvelope[])[],
): readonly { readonly auditRef: string; readonly audit: Record<string, unknown> }[] {
  const bindings = new Map<string, RuntimeTaskBinding>();
  for (const wave of runtimeWaves) {
    const execution = wave.find((artifact) =>
      artifact.artifact_type.includes("research_execution_plan"),
    );
    const dispatch = wave.find((artifact) => artifact.artifact_type.includes("dispatch_batch"));
    if (execution === undefined || dispatch === undefined) {
      throw new Error("Runtime commercial projection requires one Execution Plan and Dispatch.");
    }
    for (const task of wave.filter((artifact) =>
      artifact.artifact_type.includes("research_task"),
    )) {
      bindings.set(task.artifact_path, { task, execution, dispatch });
    }
  }

  return bundle.documents
    .map((entry) => entry.document as unknown as FormalArtifactEnvelope)
    .filter(
      (candidate) =>
        candidate.schema_version === "startup_opportunity.artifact_envelope.current" &&
        candidate.artifact_type === "startup_opportunity.commercial_research_audit.current",
    )
    .map((candidate) => {
      const taskRef = String(candidate.document.task_ref);
      const binding = bindings.get(taskRef);
      if (binding === undefined) {
        throw new Error(`missing Runtime commercial lineage for ${taskRef}`);
      }
      const document = unavailableCommercialResearchAudit({
        runId,
        taskRef,
        task: binding.task.document,
        coveredSubjectIds: candidate.document.covered_direction_ids as string[],
        auditedAt: String(candidate.document.audited_at),
        executionPlanRef: binding.execution.artifact_path,
        dispatchTaskRef: `${binding.dispatch.artifact_path}#${String(binding.task.document.task_id)}`,
      });
      Object.assign(candidate, {
        document,
        input_refs: artifactRefsForDocument({
          path: candidate.artifact_path,
          document,
        }).filter((ref) => ref.split("#", 1)[0] !== candidate.artifact_path),
        content_hash: canonicalContentHash(document),
      });
      return { auditRef: candidate.artifact_path, audit: document };
    });
}

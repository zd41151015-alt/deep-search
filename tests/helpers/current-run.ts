import {
  type CreateRunInput,
  type CreateRunResult,
  canonicalContentHash,
  type FormalArtifactEnvelope,
  type PublishArtifactBundleResult,
  planningRunStateHash,
  type RunStore,
} from "../../harness/src/index.js";

export async function createConfirmedRun(
  store: RunStore,
  input: CreateRunInput,
  confirmedAt = input.createdAt ?? new Date().toISOString(),
): Promise<CreateRunResult> {
  const created = await store.create(input);
  await store.confirmScope({
    runId: input.runId,
    expectedScopeProposalRevision: created.manifest.scope_revision,
    expectedScopeProposalRef: created.scopeProposalRef,
    expectedScopeProposalHash: created.scopeProposalHash,
    confirmedAt,
    userConfirmationAttestation:
      "The current-contract fixture caller attests that the user reviewed and confirmed this exact Scope proposal.",
  });
  return {
    ...created,
    manifest: (await store.status(input.runId)).manifest,
  };
}

export async function publishInitialPlanBundle(
  store: RunStore,
  runId: string,
  envelopes: readonly FormalArtifactEnvelope[],
  phase = "discovery",
): Promise<PublishArtifactBundleResult> {
  return store.publishArtifactBundle({
    runId,
    envelopes: await initialPlanBundleEnvelopes(store, runId, envelopes, phase),
  });
}

export async function initialPlanBundleEnvelopes(
  store: RunStore,
  runId: string,
  envelopes: readonly FormalArtifactEnvelope[],
  phase = "discovery",
): Promise<readonly FormalArtifactEnvelope[]> {
  const plan = envelopes.find(
    (envelope) => envelope.artifact_type === "startup_opportunity.research_plan.v1",
  );
  if (plan === undefined) {
    throw new Error("initial planning bundle requires one Research Plan envelope");
  }
  const manifest = (await store.status(runId)).manifest;
  const contextPath = "plans/planning-context.r1.json";
  const createdAt = String(plan.document.created_at);
  const context = {
    schema_version: "startup_opportunity.planning_context.ai_source_bound.current",
    context_id: `planning_context_${String(runId).replaceAll("-", "_")}`,
    revision: 1,
    parent_context_ref: null,
    run_id: runId,
    mode: manifest.mode,
    phase,
    validation_stage: "initial_plan",
    manifest_binding: {
      manifest_ref: "manifest.json",
      manifest_schema_version: "startup_opportunity.run_manifest.v1",
      run_id: runId,
      mode: manifest.mode,
      current_plan_ref: manifest.current_plan_ref,
      current_plan_revision: manifest.plan_revision,
      run_state_hash: planningRunStateHash({
        manifest_ref: "manifest.json",
        manifest_schema_version: "startup_opportunity.run_manifest.v1",
        run_id: runId,
        mode: manifest.mode,
        current_plan_ref: manifest.current_plan_ref,
        current_plan_revision: manifest.plan_revision,
      }),
    },
    target_plan_binding: {
      plan_ref: plan.artifact_path,
      plan_schema_version: "startup_opportunity.research_plan.v1",
      plan_id: plan.document.plan_id,
      plan_revision: plan.document.revision,
      plan_content_hash: plan.content_hash,
    },
    ai_mandatory_coverage: {
      status: "not_required",
      trigger_version: "startup_opportunity.ai_mandatory_coverage_trigger.v1",
      basis: {
        signal: "none",
        declared_value: "not_applicable",
        subject_ref: null,
        source_ref: null,
        source_schema_version: null,
        source_content_hash: null,
      },
      required_dimensions: [],
    },
    producer_role: "main_agent",
    created_at: createdAt,
  };
  const contextEnvelope: FormalArtifactEnvelope = {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: "startup_opportunity.planning_context.ai_source_bound.current",
    artifact_path: contextPath,
    run_id: runId,
    created_at: createdAt,
    producer_role: "main_agent",
    input_refs: ["manifest.json", plan.artifact_path],
    content_hash: canonicalContentHash(context),
    document: context,
  };
  return [...envelopes, contextEnvelope];
}

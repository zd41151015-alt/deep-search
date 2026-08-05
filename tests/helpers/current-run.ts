import type { CreateRunInput, CreateRunResult, RunStore } from "../../harness/src/index.js";

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

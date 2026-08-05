import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import { resolveRunPath } from "../artifact-store/path-policy.js";
import { StoreError } from "../artifact-store/store-error.js";

type StorageMutation =
  | { readonly kind: "evidence" }
  | { readonly kind: "artifact"; readonly artifactTypes: readonly string[] };

const SCOPE_RECONCILIATION_ARTIFACT_TYPES = new Set([
  "startup_opportunity.gap_snapshot.discovery.plan.current",
  "startup_opportunity.gap_snapshot.discovery.readiness.current",
  "startup_opportunity.gap_snapshot.assessment.current",
  "startup_opportunity.adaptation_decision.discovery.current",
  "startup_opportunity.adaptation_decision.assessment.current",
  "startup_opportunity.research_plan.v1",
  "startup_opportunity.concept_evidence_assessment_plan.v1",
  "startup_opportunity.planning_context.v1",
  "startup_opportunity.planning_context.v2",
  "startup_opportunity.ai_trigger_source_attestation.v1",
  "startup_opportunity.checkpoint.v1",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidScopeBinding(message: string, details: Record<string, unknown> = {}): never {
  throw new StoreError("run.scope_confirmation_invalid", message, details);
}

function parseDecisionRecords(contents: Buffer): readonly Record<string, unknown>[] {
  if (contents.length > 0 && contents.at(-1) !== 0x0a) {
    throw new StoreError(
      "log.corrupt_tail",
      "repair decisions.jsonl before authorizing a Store mutation",
      { path: "decisions.jsonl" },
    );
  }
  const records: Record<string, unknown>[] = [];
  const identities = new Set<string>();
  for (const line of contents.toString("utf8").split("\n")) {
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return invalidScopeBinding("decisions.jsonl contains invalid JSON");
    }
    if (!isRecord(value) || typeof value.decision_id !== "string") {
      return invalidScopeBinding("decisions.jsonl contains an invalid Decision record");
    }
    if (identities.has(value.decision_id)) {
      return invalidScopeBinding("decisions.jsonl contains a duplicate Decision identity", {
        decisionId: value.decision_id,
      });
    }
    identities.add(value.decision_id);
    records.push(value);
  }
  return records;
}

function decisionAtRef(
  records: readonly Record<string, unknown>[],
  ref: unknown,
): Record<string, unknown> {
  if (typeof ref !== "string") {
    return invalidScopeBinding("Scope binding ref is missing");
  }
  const match = /^decisions\.jsonl#(.+)$/.exec(ref);
  if (match?.[1] === undefined) {
    return invalidScopeBinding("Scope binding ref must target decisions.jsonl", { ref });
  }
  const matches = records.filter((record) => record.decision_id === match[1]);
  if (matches.length !== 1 || matches[0] === undefined) {
    return invalidScopeBinding("Scope binding ref must resolve to exactly one Decision", {
      ref,
      count: matches.length,
    });
  }
  return matches[0];
}

function assertExactCurrentConfirmation(
  manifest: Record<string, unknown>,
  records: readonly Record<string, unknown>[],
  runId: string,
): void {
  const proposal = decisionAtRef(records, manifest.scope_proposal_ref);
  const confirmation = decisionAtRef(records, manifest.scope_confirmation_ref);
  const revision = manifest.scope_revision;
  if (
    manifest.run_id !== runId ||
    typeof revision !== "number" ||
    proposal.schema_version !== "startup_opportunity.decision.v1" ||
    proposal.run_id !== runId ||
    proposal.decision_type !== "scope_proposed" ||
    proposal.actor !== "main_agent" ||
    proposal.scope_revision !== revision ||
    !isRecord(proposal.scope) ||
    proposal.scope_hash !== canonicalContentHash(proposal.scope) ||
    manifest.scope_proposal_hash !== canonicalContentHash(proposal) ||
    confirmation.schema_version !== "startup_opportunity.decision.v1" ||
    confirmation.run_id !== runId ||
    confirmation.decision_type !==
      (revision === 1 ? "scope_assumption_confirmed" : "scope_changed_by_user") ||
    confirmation.actor !== "main_agent" ||
    confirmation.scope_revision !== revision ||
    confirmation.scope_hash !== proposal.scope_hash ||
    canonicalJson(confirmation.scope) !== canonicalJson(proposal.scope) ||
    confirmation.scope_proposal_ref !== manifest.scope_proposal_ref ||
    confirmation.scope_proposal_hash !== manifest.scope_proposal_hash ||
    confirmation.confirmation_basis !== "caller_attested_user_confirmation" ||
    confirmation.harness_identity_verification !== "not_available" ||
    manifest.scope_confirmation_hash !== canonicalContentHash(confirmation)
  ) {
    invalidScopeBinding("Store mutation requires the exact current Scope confirmation binding", {
      runId,
      scopeRevision: revision,
    });
  }
  const latestProposalRevision = Math.max(
    ...records
      .filter((record) => record.decision_type === "scope_proposed")
      .map((record) => Number(record.scope_revision)),
  );
  if (latestProposalRevision !== revision) {
    invalidScopeBinding("Manifest Scope revision is not the latest durable proposal", {
      runId,
      manifestRevision: revision,
      latestProposalRevision,
    });
  }
}

async function isInitialCreationCheckpoint(
  runsRoot: string,
  runRoot: string,
  runId: string,
  mutation: StorageMutation,
): Promise<boolean> {
  return (
    mutation.kind === "artifact" &&
    mutation.artifactTypes.length === 1 &&
    mutation.artifactTypes[0] === "startup_opportunity.checkpoint.v1" &&
    path.dirname(path.resolve(runRoot)) === (await realpath(runsRoot)) &&
    path.basename(runRoot).startsWith(`.create-${runId}-`)
  );
}

export async function assertScopeAllowsStorageMutationLocked(
  runsRoot: string,
  runRoot: string,
  runId: string,
  mutation: StorageMutation,
): Promise<void> {
  const manifestValue = JSON.parse(
    await readFile(await resolveRunPath(runRoot, "manifest.json"), "utf8"),
  ) as unknown;
  if (!isRecord(manifestValue) || manifestValue.run_id !== runId) {
    throw new StoreError("manifest.schema_invalid", "Run Manifest cannot authorize a Store write", {
      runId,
    });
  }
  if (await isInitialCreationCheckpoint(runsRoot, runRoot, runId, mutation)) return;
  if (
    manifestValue.status === "awaiting_scope_confirmation" ||
    manifestValue.scope_confirmation_ref === null ||
    manifestValue.scope_confirmation_hash === null
  ) {
    throw new StoreError(
      "run.scope_confirmation_required",
      "Store mutation is blocked until the exact current Scope proposal is confirmed",
      {
        scopeProposalRef: manifestValue.scope_proposal_ref,
        scopeProposalHash: manifestValue.scope_proposal_hash,
      },
    );
  }
  const records = parseDecisionRecords(
    await readFile(await resolveRunPath(runRoot, "decisions.jsonl")),
  );
  assertExactCurrentConfirmation(manifestValue, records, runId);
  if (
    manifestValue.status === "needs_clarification" &&
    (mutation.kind === "evidence" ||
      mutation.artifactTypes.some(
        (artifactType) => !SCOPE_RECONCILIATION_ARTIFACT_TYPES.has(artifactType),
      ))
  ) {
    throw new StoreError(
      "run.scope_revision_unresolved",
      "only Scope reconciliation control Artifacts may be written before Plan reconciliation",
      { runId, scopeRevision: manifestValue.scope_revision },
    );
  }
}

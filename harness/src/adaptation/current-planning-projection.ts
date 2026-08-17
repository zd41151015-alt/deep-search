import { planningRunStateHash } from "../validators/planning-contract-identities.js";
import { effectiveDocuments, isRecord, leafPlanningContexts } from "./contracts.js";

export function currentPlanningProjection(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.documents)) {
    return value;
  }
  const documents = effectiveDocuments(value);
  const hasDiscoveryContractClosure =
    documents.some(
      (document) => document.schemaVersion === "startup_opportunity.scope_frame.discovery.current",
    ) &&
    documents.some((document) =>
      [
        "startup_opportunity.seed_probe.v1",
        "startup_opportunity.opportunity_space_map.v1",
        "startup_opportunity.solution_space_map.v1",
      ].includes(document.schemaVersion),
    );
  const planningValue = hasDiscoveryContractClosure
    ? value
    : {
        ...value,
        documents: value.documents
          .filter(
            (entry) =>
              !isRecord(entry) ||
              !isRecord(entry.document) ||
              entry.document.artifact_type !== "startup_opportunity.discovery_candidate.v1",
          )
          .map((entry) => {
            if (!isRecord(entry) || typeof entry.path !== "string") {
              return entry;
            }
            const effective = documents.find((document) => document.path === entry.path);
            return effective?.envelope === null || effective === undefined
              ? entry
              : { ...entry, document: effective.document };
          }),
      };
  const projectedDocuments = effectiveDocuments(planningValue);
  const manifest = projectedDocuments.find((document) => document.path === "manifest.json");
  const context = leafPlanningContexts(planningValue)[0];
  const targetBinding = context?.document.target_plan_binding;
  const manifestBinding = context?.document.manifest_binding;
  if (
    manifest?.schemaVersion !== "startup_opportunity.run_manifest.v1" ||
    context?.schemaVersion !== "startup_opportunity.planning_context.ai_source_bound.current" ||
    !["initial_plan", "candidate_revision"].includes(String(context.document.validation_stage)) ||
    !isRecord(targetBinding) ||
    !isRecord(manifestBinding) ||
    targetBinding.plan_ref !== manifest.document.current_plan_ref ||
    targetBinding.plan_revision !== manifest.document.plan_revision
  ) {
    return planningValue;
  }
  const projectedManifestBinding = {
    ...manifestBinding,
    current_plan_ref: manifest.document.current_plan_ref,
    current_plan_revision: manifest.document.plan_revision,
    run_state_hash: planningRunStateHash({
      manifest_ref: String(manifestBinding.manifest_ref),
      manifest_schema_version: String(manifestBinding.manifest_schema_version),
      run_id: String(manifestBinding.run_id),
      mode: String(manifestBinding.mode),
      current_plan_ref: manifest.document.current_plan_ref as string,
      current_plan_revision: Number(manifest.document.plan_revision),
    }),
  };
  const planningDocuments = planningValue.documents as unknown[];
  return {
    ...planningValue,
    documents: planningDocuments.map((entry) =>
      isRecord(entry) && entry.path === context.path
        ? {
            ...entry,
            document: {
              ...context.document,
              validation_stage: "current_plan",
              manifest_binding: projectedManifestBinding,
            },
          }
        : entry,
    ),
  };
}

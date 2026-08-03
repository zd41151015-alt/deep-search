import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedSchemaBundle } from "../validators/schema-bundle.js";
import { StoreError } from "./store-error.js";

export const RESEARCH_PUBLICATION_POLICY_PATH =
  "harness/policies/research-publication.current.json" as const;
export const ARTIFACT_ENVELOPE_SCHEMA_VERSION =
  "startup_opportunity.artifact_envelope.current" as const;
export const DOCUMENT_BUNDLE_SCHEMA_VERSION =
  "startup_opportunity.document_bundle.current" as const;
export const ARTIFACT_RECEIPT_SCHEMA_VERSION =
  "startup_opportunity.artifact_store_operation.current" as const;

interface PublicationContract {
  readonly envelope_schema_version: typeof ARTIFACT_ENVELOPE_SCHEMA_VERSION;
  readonly document_bundle_schema_version: typeof DOCUMENT_BUNDLE_SCHEMA_VERSION;
  readonly receipt_schema_version: typeof ARTIFACT_RECEIPT_SCHEMA_VERSION;
}

export interface ResearchPublicationPolicy {
  readonly schema_version: "startup_opportunity.research_publication_policy.current";
  readonly policy_id: "startup_opportunity.current_research_publication";
  readonly publication: PublicationContract;
  readonly evidence_contract: Readonly<Record<string, unknown>>;
  readonly traceability_contract: Readonly<Record<string, unknown>>;
  readonly task_lifecycle_contract: Readonly<Record<string, unknown>>;
  readonly branch_status_projection: Readonly<Record<string, string>>;
  readonly discovery_lane_status_projection: Readonly<Record<string, string>>;
  readonly enrichment_branch_status_projection: Readonly<Record<string, string>>;
  readonly report_publication_contract: Readonly<Record<string, unknown>>;
  readonly discovery_map_contract: Readonly<Record<string, unknown>>;
  readonly discovery_runtime_contract: Readonly<Record<string, unknown>>;
  readonly discovery_synthesis_contract: Readonly<Record<string, unknown>>;
  readonly discovery_evaluation_contract: Readonly<Record<string, unknown>>;
  readonly discovery_adaptation_binding_contract: Readonly<Record<string, unknown>>;
  readonly ai_baseline_contract: Readonly<Record<string, unknown>>;
  readonly ai_economics_contract: Readonly<Record<string, unknown>>;
  readonly ai_mandatory_bundle_contract: Readonly<Record<string, unknown>>;
  readonly terminal_reporting_contract: Readonly<Record<string, unknown>>;
  readonly declarative_runtime_contract: Readonly<Record<string, unknown>>;
  readonly assessment_execution_contract: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PublicationPolicy {
  constructor(readonly document: ResearchPublicationPolicy) {}

  assertCurrentEnvelope(schemaVersion: unknown): void {
    if (schemaVersion !== this.document.publication.envelope_schema_version) {
      throw new StoreError(
        "artifact.envelope_contract_mismatch",
        "Artifact Store accepts only the current envelope contract",
        {
          actualSchemaVersion: schemaVersion,
          expectedSchemaVersion: this.document.publication.envelope_schema_version,
        },
      );
    }
  }
}

export async function loadResearchPublicationPolicy(
  root: string,
  schemas: LoadedSchemaBundle,
): Promise<PublicationPolicy> {
  const value = JSON.parse(
    await readFile(path.join(root, RESEARCH_PUBLICATION_POLICY_PATH), "utf8"),
  ) as unknown;
  if (!isRecord(value) || typeof value.schema_version !== "string") {
    throw new StoreError(
      "publication_policy.invalid",
      "current research publication policy must be an object with schema_version",
    );
  }
  const validator = schemas.validators.get(value.schema_version);
  if (validator === undefined || !validator(value)) {
    throw new StoreError(
      "publication_policy.invalid",
      "current research publication policy is not schema-valid",
      { errors: validator?.errors ?? [] },
    );
  }
  const policy = value as unknown as ResearchPublicationPolicy;
  if (
    policy.publication.envelope_schema_version !== ARTIFACT_ENVELOPE_SCHEMA_VERSION ||
    policy.publication.document_bundle_schema_version !== DOCUMENT_BUNDLE_SCHEMA_VERSION ||
    policy.publication.receipt_schema_version !== ARTIFACT_RECEIPT_SCHEMA_VERSION
  ) {
    throw new StoreError(
      "publication_policy.invalid",
      "current research publication policy does not select the current Store contracts",
    );
  }
  return new PublicationPolicy(policy);
}

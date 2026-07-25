import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedSchemaBundle } from "../validators/schema-bundle.js";
import { canonicalJson } from "./canonical.js";
import { StoreError } from "./store-error.js";

export const RESEARCH_PUBLICATION_POLICY_PATH =
  "harness/policies/research-publication.v3.json" as const;

export type StoreEnvelopeVersion =
  | "startup_opportunity.artifact_envelope.v1"
  | "startup_opportunity.artifact_envelope.v2"
  | "startup_opportunity.artifact_envelope.v3"
  | "startup_opportunity.artifact_envelope.v4"
  | "startup_opportunity.artifact_envelope.v5"
  | "startup_opportunity.artifact_envelope.v6"
  | "startup_opportunity.artifact_envelope.v7";

export type StoreDocumentBundleVersion =
  | "startup_opportunity.document_bundle.v1"
  | "startup_opportunity.document_bundle.v2"
  | "startup_opportunity.document_bundle.v3"
  | "startup_opportunity.document_bundle.v4"
  | "startup_opportunity.document_bundle.v5"
  | "startup_opportunity.document_bundle.v6"
  | "startup_opportunity.document_bundle.v7";

export type ArtifactReceiptVersion =
  | "startup_opportunity.artifact_store_operation.v1"
  | "startup_opportunity.artifact_store_operation.v2"
  | "startup_opportunity.artifact_store_operation.v3"
  | "startup_opportunity.artifact_store_operation.v4"
  | "startup_opportunity.artifact_store_operation.v5"
  | "startup_opportunity.artifact_store_operation.v6";

export interface StorePublicationAdapter {
  readonly envelope_version: StoreEnvelopeVersion;
  readonly document_bundle_version: StoreDocumentBundleVersion;
  readonly receipt_version: ArtifactReceiptVersion;
  readonly manifest_schema_bundle_version: string | null;
  readonly checkpoint_preferred: boolean;
  readonly blocked_artifact_types: readonly string[];
}

export interface ResearchPublicationPolicy {
  readonly schema_version: "startup_opportunity.research_publication_policy.v3";
  readonly policy_id: "startup_opportunity.g1_4_research_publication";
  readonly policy_version: "3.0.0";
  readonly current_schema_bundle_version: "6.0.0";
  readonly adapters: readonly StorePublicationAdapter[];
  readonly evidence_contract: Readonly<Record<string, unknown>>;
  readonly traceability_contract: Readonly<Record<string, unknown>>;
  readonly task_lifecycle_contract: Readonly<Record<string, unknown>>;
  readonly branch_status_adapter: Readonly<Record<string, string>>;
  readonly report_publication_contract: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EXPECTED_ADAPTERS: readonly StorePublicationAdapter[] = [
  {
    envelope_version: "startup_opportunity.artifact_envelope.v1",
    document_bundle_version: "startup_opportunity.document_bundle.v1",
    receipt_version: "startup_opportunity.artifact_store_operation.v1",
    manifest_schema_bundle_version: null,
    checkpoint_preferred: true,
    blocked_artifact_types: [],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v2",
    document_bundle_version: "startup_opportunity.document_bundle.v2",
    receipt_version: "startup_opportunity.artifact_store_operation.v2",
    manifest_schema_bundle_version: "2.2.0",
    checkpoint_preferred: false,
    blocked_artifact_types: [],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v3",
    document_bundle_version: "startup_opportunity.document_bundle.v3",
    receipt_version: "startup_opportunity.artifact_store_operation.v2",
    manifest_schema_bundle_version: "2.2.0",
    checkpoint_preferred: true,
    blocked_artifact_types: [],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v4",
    document_bundle_version: "startup_opportunity.document_bundle.v4",
    receipt_version: "startup_opportunity.artifact_store_operation.v3",
    manifest_schema_bundle_version: "3.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: ["startup_opportunity.concept_evidence_assessment_branch_result.v1"],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v5",
    document_bundle_version: "startup_opportunity.document_bundle.v5",
    receipt_version: "startup_opportunity.artifact_store_operation.v4",
    manifest_schema_bundle_version: "4.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: [],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v6",
    document_bundle_version: "startup_opportunity.document_bundle.v6",
    receipt_version: "startup_opportunity.artifact_store_operation.v5",
    manifest_schema_bundle_version: "5.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: [],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v7",
    document_bundle_version: "startup_opportunity.document_bundle.v7",
    receipt_version: "startup_opportunity.artifact_store_operation.v6",
    manifest_schema_bundle_version: "6.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: [],
  },
];

export class PublicationPolicy {
  private readonly adaptersByEnvelope: ReadonlyMap<StoreEnvelopeVersion, StorePublicationAdapter>;

  constructor(readonly document: ResearchPublicationPolicy) {
    this.adaptersByEnvelope = new Map(
      document.adapters.map((adapter) => [adapter.envelope_version, adapter]),
    );
  }

  adapterForEnvelope(schemaVersion: unknown): StorePublicationAdapter {
    const adapter =
      typeof schemaVersion === "string"
        ? this.adaptersByEnvelope.get(schemaVersion as StoreEnvelopeVersion)
        : undefined;
    if (adapter === undefined) {
      throw new StoreError(
        "artifact.envelope_unsupported",
        "Artifact Store has no published adapter for this envelope version",
        { schemaVersion },
      );
    }
    return adapter;
  }

  checkpointEnvelopeForBundle(schemaBundleVersion: string): StoreEnvelopeVersion {
    const matches = this.document.adapters.filter(
      (adapter) =>
        adapter.checkpoint_preferred &&
        (adapter.manifest_schema_bundle_version === schemaBundleVersion ||
          (adapter.manifest_schema_bundle_version === null && schemaBundleVersion === "1.0.0")),
    );
    const selected = matches.at(-1);
    if (selected === undefined) {
      throw new StoreError(
        "artifact.envelope_unsupported",
        "No checkpoint envelope adapter is published for the Run schema bundle",
        { schemaBundleVersion },
      );
    }
    return selected.envelope_version;
  }

  highestBundleForEnvelopes(envelopeVersions: readonly unknown[]): StoreDocumentBundleVersion {
    const adapters = envelopeVersions.map((version) => this.adapterForEnvelope(version));
    return adapters.reduce((selected, candidate) => {
      const left = Number(selected.document_bundle_version.match(/v([1-9][0-9]*)$/)?.[1] ?? 0);
      const right = Number(candidate.document_bundle_version.match(/v([1-9][0-9]*)$/)?.[1] ?? 0);
      return right > left ? candidate : selected;
    }).document_bundle_version;
  }
}

export async function loadResearchPublicationPolicy(
  root: string,
  bundle: LoadedSchemaBundle,
  relativePath = RESEARCH_PUBLICATION_POLICY_PATH,
): Promise<PublicationPolicy> {
  const value = JSON.parse(await readFile(path.join(root, relativePath), "utf8")) as unknown;
  const validator = bundle.validators.get("startup_opportunity.research_publication_policy.v3");
  if ((validator !== undefined && !validator(value)) || !isRecord(value)) {
    throw new StoreError(
      "publication_policy.invalid",
      "research publication policy is not valid for the selected schema bundle",
      { errors: validator?.errors ?? [] },
    );
  }
  const policy = value as unknown as ResearchPublicationPolicy;
  const versions = policy.adapters.map((adapter) => adapter.envelope_version);
  if (
    new Set(versions).size !== versions.length ||
    versions.length !== 7 ||
    canonicalJson(policy.adapters) !== canonicalJson(EXPECTED_ADAPTERS)
  ) {
    throw new StoreError(
      "publication_policy.invalid",
      "research publication policy adapter tuples differ from the published contract",
    );
  }
  return new PublicationPolicy(policy);
}

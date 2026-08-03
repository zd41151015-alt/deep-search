import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedSchemaBundle } from "../validators/schema-bundle.js";
import { canonicalContentHash, canonicalJson } from "./canonical.js";
import { StoreError } from "./store-error.js";

export const RESEARCH_PUBLICATION_POLICY_PATH =
  "harness/policies/research-publication.v14.json" as const;

export type StoreEnvelopeVersion =
  | "startup_opportunity.artifact_envelope.v1"
  | "startup_opportunity.artifact_envelope.v2"
  | "startup_opportunity.artifact_envelope.v3"
  | "startup_opportunity.artifact_envelope.v4"
  | "startup_opportunity.artifact_envelope.v5"
  | "startup_opportunity.artifact_envelope.v6"
  | "startup_opportunity.artifact_envelope.v7"
  | "startup_opportunity.artifact_envelope.v8"
  | "startup_opportunity.artifact_envelope.v10"
  | "startup_opportunity.artifact_envelope.v11"
  | "startup_opportunity.artifact_envelope.v12"
  | "startup_opportunity.artifact_envelope.v13"
  | "startup_opportunity.artifact_envelope.v14"
  | "startup_opportunity.artifact_envelope.v15"
  | "startup_opportunity.artifact_envelope.v16"
  | "startup_opportunity.artifact_envelope.v17"
  | "startup_opportunity.artifact_envelope.v18"
  | "startup_opportunity.artifact_envelope.v19";

export type StoreDocumentBundleVersion =
  | "startup_opportunity.document_bundle.v1"
  | "startup_opportunity.document_bundle.v2"
  | "startup_opportunity.document_bundle.v3"
  | "startup_opportunity.document_bundle.v4"
  | "startup_opportunity.document_bundle.v5"
  | "startup_opportunity.document_bundle.v6"
  | "startup_opportunity.document_bundle.v7"
  | "startup_opportunity.document_bundle.v8"
  | "startup_opportunity.document_bundle.v10"
  | "startup_opportunity.document_bundle.v11"
  | "startup_opportunity.document_bundle.v12"
  | "startup_opportunity.document_bundle.v13"
  | "startup_opportunity.document_bundle.v14"
  | "startup_opportunity.document_bundle.v15"
  | "startup_opportunity.document_bundle.v16"
  | "startup_opportunity.document_bundle.v17"
  | "startup_opportunity.document_bundle.v18"
  | "startup_opportunity.document_bundle.v19";

export type ArtifactReceiptVersion =
  | "startup_opportunity.artifact_store_operation.v1"
  | "startup_opportunity.artifact_store_operation.v2"
  | "startup_opportunity.artifact_store_operation.v3"
  | "startup_opportunity.artifact_store_operation.v4"
  | "startup_opportunity.artifact_store_operation.v5"
  | "startup_opportunity.artifact_store_operation.v6"
  | "startup_opportunity.artifact_store_operation.v7"
  | "startup_opportunity.artifact_store_operation.v8"
  | "startup_opportunity.artifact_store_operation.v9"
  | "startup_opportunity.artifact_store_operation.v10"
  | "startup_opportunity.artifact_store_operation.v11"
  | "startup_opportunity.artifact_store_operation.v12"
  | "startup_opportunity.artifact_store_operation.v13"
  | "startup_opportunity.artifact_store_operation.v14"
  | "startup_opportunity.artifact_store_operation.v15"
  | "startup_opportunity.artifact_store_operation.v16"
  | "startup_opportunity.artifact_store_operation.v17";

export interface StorePublicationAdapter {
  readonly envelope_version: StoreEnvelopeVersion;
  readonly document_bundle_version: StoreDocumentBundleVersion;
  readonly receipt_version: ArtifactReceiptVersion;
  readonly manifest_schema_bundle_version: string | null;
  readonly checkpoint_preferred: boolean;
  readonly blocked_artifact_types: readonly string[];
}

export interface ResearchPublicationPolicy {
  readonly schema_version:
    | "startup_opportunity.research_publication_policy.v8"
    | "startup_opportunity.research_publication_policy.v9"
    | "startup_opportunity.research_publication_policy.v10"
    | "startup_opportunity.research_publication_policy.v11"
    | "startup_opportunity.research_publication_policy.v12"
    | "startup_opportunity.research_publication_policy.v13"
    | "startup_opportunity.research_publication_policy.v14";
  readonly policy_id: string;
  readonly policy_version: string;
  readonly current_schema_bundle_version: string;
  readonly adapters: readonly StorePublicationAdapter[];
  readonly evidence_contract: Readonly<Record<string, unknown>>;
  readonly traceability_contract: Readonly<Record<string, unknown>>;
  readonly task_lifecycle_contract: Readonly<Record<string, unknown>>;
  readonly branch_status_adapter: Readonly<Record<string, string>>;
  readonly discovery_lane_status_adapter: Readonly<Record<string, string>>;
  readonly enrichment_branch_status_adapter: Readonly<Record<string, string>>;
  readonly report_publication_contract: Readonly<Record<string, unknown>>;
  readonly discovery_map_contract: Readonly<Record<string, unknown>>;
  readonly discovery_runtime_contract: Readonly<Record<string, unknown>>;
  readonly discovery_synthesis_contract: Readonly<Record<string, unknown>>;
  readonly discovery_evaluation_contract: Readonly<Record<string, unknown>>;
  readonly discovery_adaptation_binding_contract: Readonly<Record<string, unknown>>;
  readonly ai_baseline_contract?: Readonly<Record<string, unknown>>;
  readonly ai_economics_contract?: Readonly<Record<string, unknown>>;
  readonly ai_mandatory_bundle_contract?: Readonly<Record<string, unknown>>;
  readonly terminal_reporting_contract?: Readonly<Record<string, unknown>>;
  readonly declarative_runtime_contract?: Readonly<Record<string, unknown>>;
  readonly assessment_execution_contract?: Readonly<Record<string, unknown>>;
}

interface ResearchPublicationPolicyOverlayV9 {
  readonly schema_version: "startup_opportunity.research_publication_policy.v9";
  readonly policy_id: "startup_opportunity.g3_1_research_publication";
  readonly policy_version: "9.0.0";
  readonly current_schema_bundle_version: "13.0.0";
  readonly base_policy_binding: {
    readonly policy_ref: "harness/policies/research-publication.v8.json";
    readonly schema_version: "startup_opportunity.research_publication_policy.v8";
    readonly policy_version: "8.0.0";
    readonly content_hash: string;
  };
  readonly adapter: StorePublicationAdapter;
  readonly ai_baseline_contract: Readonly<Record<string, unknown>>;
}

interface ResearchPublicationPolicyOverlayV10 {
  readonly schema_version: "startup_opportunity.research_publication_policy.v10";
  readonly policy_id: "startup_opportunity.g3_2_research_publication";
  readonly policy_version: "10.0.0";
  readonly current_schema_bundle_version: "14.0.0";
  readonly base_policy_binding: {
    readonly policy_ref: "harness/policies/research-publication.v9.json";
    readonly schema_version: "startup_opportunity.research_publication_policy.v9";
    readonly policy_version: "9.0.0";
    readonly content_hash: string;
  };
  readonly adapter: StorePublicationAdapter;
  readonly ai_economics_contract: Readonly<Record<string, unknown>>;
}

interface ResearchPublicationPolicyOverlayV11 {
  readonly schema_version: "startup_opportunity.research_publication_policy.v11";
  readonly policy_id: "startup_opportunity.g3_3_research_publication";
  readonly policy_version: "11.0.0";
  readonly current_schema_bundle_version: "15.0.0";
  readonly base_policy_binding: {
    readonly policy_ref: "harness/policies/research-publication.v10.json";
    readonly schema_version: "startup_opportunity.research_publication_policy.v10";
    readonly policy_version: "10.0.0";
    readonly content_hash: string;
  };
  readonly adapter: StorePublicationAdapter;
  readonly ai_mandatory_bundle_contract: Readonly<Record<string, unknown>>;
}

interface ResearchPublicationPolicyOverlayV12 {
  readonly schema_version: "startup_opportunity.research_publication_policy.v12";
  readonly policy_id: "startup_opportunity.terminal_reporting_publication";
  readonly policy_version: "12.0.0";
  readonly current_schema_bundle_version: "16.0.0";
  readonly base_policy_binding: {
    readonly policy_ref: "harness/policies/research-publication.v11.json";
    readonly schema_version: "startup_opportunity.research_publication_policy.v11";
    readonly policy_version: "11.0.0";
    readonly content_hash: string;
  };
  readonly adapter: StorePublicationAdapter;
  readonly terminal_reporting_contract: Readonly<Record<string, unknown>>;
}

interface ResearchPublicationPolicyOverlayV13 {
  readonly schema_version: "startup_opportunity.research_publication_policy.v13";
  readonly policy_id: "startup_opportunity.declarative_runtime_publication";
  readonly policy_version: "13.0.0";
  readonly current_schema_bundle_version: "17.0.0";
  readonly base_policy_binding: {
    readonly policy_ref: "harness/policies/research-publication.v12.json";
    readonly schema_version: "startup_opportunity.research_publication_policy.v12";
    readonly policy_version: "12.0.0";
    readonly content_hash: string;
  };
  readonly adapter: StorePublicationAdapter;
  readonly declarative_runtime_contract: Readonly<Record<string, unknown>>;
}

interface ResearchPublicationPolicyOverlayV14 {
  readonly schema_version: "startup_opportunity.research_publication_policy.v14";
  readonly policy_id: "startup_opportunity.assessment_execution_publication";
  readonly policy_version: "14.0.0";
  readonly current_schema_bundle_version: "18.0.0";
  readonly base_policy_binding: {
    readonly policy_ref: "harness/policies/research-publication.v13.json";
    readonly schema_version: "startup_opportunity.research_publication_policy.v13";
    readonly policy_version: "13.0.0";
    readonly content_hash: string;
  };
  readonly adapter: StorePublicationAdapter;
  readonly assessment_execution_contract: Readonly<Record<string, unknown>>;
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
  {
    envelope_version: "startup_opportunity.artifact_envelope.v8",
    document_bundle_version: "startup_opportunity.document_bundle.v8",
    receipt_version: "startup_opportunity.artifact_store_operation.v7",
    manifest_schema_bundle_version: "7.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: [
      "startup_opportunity.discovery_lane_result.v1",
      "startup_opportunity.discovery_fan_in.v1",
      "startup_opportunity.demand_thesis.v1",
      "startup_opportunity.opportunity_thesis.v1",
      "startup_opportunity.solution_evaluation.v1",
      "startup_opportunity.opportunity_comparison.v1",
      "startup_opportunity.sensitivity.v1",
      "startup_opportunity.portfolio_view.v1",
    ],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v10",
    document_bundle_version: "startup_opportunity.document_bundle.v10",
    receipt_version: "startup_opportunity.artifact_store_operation.v8",
    manifest_schema_bundle_version: "9.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: [
      "startup_opportunity.discovery_candidate_conversion.v1",
      "startup_opportunity.discovery_candidate_conversion.v2",
      "startup_opportunity.demand_thesis.v1",
      "startup_opportunity.baseline_option.v1",
      "startup_opportunity.solution_hypothesis.v1",
      "startup_opportunity.solution_evaluation.v1",
      "startup_opportunity.opportunity_thesis.v1",
      "startup_opportunity.thesis_evaluation_snapshot.v1",
      "startup_opportunity.merge.v1",
      "startup_opportunity.enrichment_branch_result.v1",
      "startup_opportunity.enrichment_fan_in.v1",
      "startup_opportunity.business_engine_thesis.v1",
      "startup_opportunity.opportunity_comparison.v1",
      "startup_opportunity.sensitivity.v1",
      "startup_opportunity.decision_recommendation.v1",
      "startup_opportunity.portfolio_view.v1",
      "startup_opportunity.report.v1",
    ],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v11",
    document_bundle_version: "startup_opportunity.document_bundle.v11",
    receipt_version: "startup_opportunity.artifact_store_operation.v9",
    manifest_schema_bundle_version: "10.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: [
      "startup_opportunity.enrichment_branch_result.v1",
      "startup_opportunity.enrichment_fan_in.v1",
      "startup_opportunity.capability_evidence.v1",
      "startup_opportunity.ai_capability_benchmark.v1",
      "startup_opportunity.ai_evaluation_reliability.v1",
      "startup_opportunity.ai_inference_unit_economics.v1",
      "startup_opportunity.ai_data_dependency.v1",
      "startup_opportunity.capability_commoditization_risk.v1",
      "startup_opportunity.value_layer_analysis.v1",
      "startup_opportunity.user_state_context_model.v1",
      "startup_opportunity.buyer_purchase_language.v1",
      "startup_opportunity.business_engine_thesis.v1",
      "startup_opportunity.opportunity_comparison.v1",
      "startup_opportunity.sensitivity.v1",
      "startup_opportunity.decision_recommendation.v1",
      "startup_opportunity.portfolio_view.v1",
      "startup_opportunity.report.v1",
    ],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v12",
    document_bundle_version: "startup_opportunity.document_bundle.v12",
    receipt_version: "startup_opportunity.artifact_store_operation.v10",
    manifest_schema_bundle_version: "11.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: [
      "startup_opportunity.capability_evidence.v1",
      "startup_opportunity.ai_capability_benchmark.v1",
      "startup_opportunity.ai_evaluation_reliability.v1",
      "startup_opportunity.ai_inference_unit_economics.v1",
      "startup_opportunity.ai_data_dependency.v1",
      "startup_opportunity.capability_commoditization_risk.v1",
    ],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v13",
    document_bundle_version: "startup_opportunity.document_bundle.v13",
    receipt_version: "startup_opportunity.artifact_store_operation.v11",
    manifest_schema_bundle_version: "12.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: [
      "startup_opportunity.capability_evidence.v1",
      "startup_opportunity.ai_capability_benchmark.v1",
      "startup_opportunity.ai_evaluation_reliability.v1",
      "startup_opportunity.ai_inference_unit_economics.v1",
      "startup_opportunity.ai_data_dependency.v1",
      "startup_opportunity.capability_commoditization_risk.v1",
    ],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v14",
    document_bundle_version: "startup_opportunity.document_bundle.v14",
    receipt_version: "startup_opportunity.artifact_store_operation.v12",
    manifest_schema_bundle_version: "13.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: [
      "startup_opportunity.ai_inference_unit_economics.v1",
      "startup_opportunity.capability_commoditization_risk.v1",
      "startup_opportunity.ai_adoption_trust.v1",
      "startup_opportunity.ai_mandatory_bundle.v1",
    ],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v15",
    document_bundle_version: "startup_opportunity.document_bundle.v15",
    receipt_version: "startup_opportunity.artifact_store_operation.v13",
    manifest_schema_bundle_version: "14.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: ["startup_opportunity.ai_mandatory_bundle.v1"],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v16",
    document_bundle_version: "startup_opportunity.document_bundle.v16",
    receipt_version: "startup_opportunity.artifact_store_operation.v14",
    manifest_schema_bundle_version: "15.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: [],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v17",
    document_bundle_version: "startup_opportunity.document_bundle.v17",
    receipt_version: "startup_opportunity.artifact_store_operation.v15",
    manifest_schema_bundle_version: "16.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: [],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v18",
    document_bundle_version: "startup_opportunity.document_bundle.v18",
    receipt_version: "startup_opportunity.artifact_store_operation.v16",
    manifest_schema_bundle_version: "17.0.0",
    checkpoint_preferred: true,
    blocked_artifact_types: [],
  },
  {
    envelope_version: "startup_opportunity.artifact_envelope.v19",
    document_bundle_version: "startup_opportunity.document_bundle.v19",
    receipt_version: "startup_opportunity.artifact_store_operation.v17",
    manifest_schema_bundle_version: "18.0.0",
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
  async function expandPolicy(
    policyPath: string,
    ancestors: readonly string[] = [],
  ): Promise<ResearchPublicationPolicy> {
    if (ancestors.includes(policyPath)) {
      throw new StoreError(
        "publication_policy.invalid",
        "research publication policy base chain contains a cycle",
        { chain: [...ancestors, policyPath] },
      );
    }
    const value = JSON.parse(await readFile(path.join(root, policyPath), "utf8")) as unknown;
    const schemaVersion = isRecord(value) ? value.schema_version : null;
    const validator =
      typeof schemaVersion === "string" ? bundle.validators.get(schemaVersion) : undefined;
    if ((validator !== undefined && !validator(value)) || !isRecord(value)) {
      throw new StoreError(
        "publication_policy.invalid",
        "research publication policy is not valid for the selected schema bundle",
        { errors: validator?.errors ?? [] },
      );
    }
    if (schemaVersion === "startup_opportunity.research_publication_policy.v8") {
      return value as unknown as ResearchPublicationPolicy;
    }
    if (
      schemaVersion !== "startup_opportunity.research_publication_policy.v9" &&
      schemaVersion !== "startup_opportunity.research_publication_policy.v10" &&
      schemaVersion !== "startup_opportunity.research_publication_policy.v11" &&
      schemaVersion !== "startup_opportunity.research_publication_policy.v12" &&
      schemaVersion !== "startup_opportunity.research_publication_policy.v13" &&
      schemaVersion !== "startup_opportunity.research_publication_policy.v14"
    ) {
      throw new StoreError(
        "publication_policy.invalid",
        "research publication policy overlay version is unsupported",
        { schemaVersion },
      );
    }
    const overlay = value as unknown as
      | ResearchPublicationPolicyOverlayV9
      | ResearchPublicationPolicyOverlayV10
      | ResearchPublicationPolicyOverlayV11
      | ResearchPublicationPolicyOverlayV12
      | ResearchPublicationPolicyOverlayV13
      | ResearchPublicationPolicyOverlayV14;
    const binding = overlay.base_policy_binding;
    const expectedBinding =
      schemaVersion === "startup_opportunity.research_publication_policy.v9"
        ? {
            policy_ref: "harness/policies/research-publication.v8.json",
            schema_version: "startup_opportunity.research_publication_policy.v8",
            policy_version: "8.0.0",
          }
        : schemaVersion === "startup_opportunity.research_publication_policy.v10"
          ? {
              policy_ref: "harness/policies/research-publication.v9.json",
              schema_version: "startup_opportunity.research_publication_policy.v9",
              policy_version: "9.0.0",
            }
          : schemaVersion === "startup_opportunity.research_publication_policy.v11"
            ? {
                policy_ref: "harness/policies/research-publication.v10.json",
                schema_version: "startup_opportunity.research_publication_policy.v10",
                policy_version: "10.0.0",
              }
            : schemaVersion === "startup_opportunity.research_publication_policy.v12"
              ? {
                  policy_ref: "harness/policies/research-publication.v11.json",
                  schema_version: "startup_opportunity.research_publication_policy.v11",
                  policy_version: "11.0.0",
                }
              : schemaVersion === "startup_opportunity.research_publication_policy.v13"
                ? {
                    policy_ref: "harness/policies/research-publication.v12.json",
                    schema_version: "startup_opportunity.research_publication_policy.v12",
                    policy_version: "12.0.0",
                  }
                : {
                    policy_ref: "harness/policies/research-publication.v13.json",
                    schema_version: "startup_opportunity.research_publication_policy.v13",
                    policy_version: "13.0.0",
                  };
    if (
      binding.policy_ref !== expectedBinding.policy_ref ||
      binding.schema_version !== expectedBinding.schema_version ||
      binding.policy_version !== expectedBinding.policy_version
    ) {
      throw new StoreError(
        "publication_policy.invalid",
        "research publication base policy binding is not the published predecessor",
      );
    }
    const baseValue = JSON.parse(
      await readFile(path.join(root, binding.policy_ref), "utf8"),
    ) as unknown;
    const baseValidator = bundle.validators.get(binding.schema_version);
    if (
      (baseValidator !== undefined && !baseValidator(baseValue)) ||
      !isRecord(baseValue) ||
      baseValue.schema_version !== binding.schema_version ||
      baseValue.policy_version !== binding.policy_version ||
      canonicalContentHash(baseValue) !== binding.content_hash
    ) {
      throw new StoreError(
        "publication_policy.invalid",
        "research publication base policy binding is invalid or stale",
        { errors: baseValidator?.errors ?? [] },
      );
    }
    const base = await expandPolicy(binding.policy_ref, [...ancestors, policyPath]);
    const common = {
      ...base,
      schema_version: overlay.schema_version,
      policy_id: overlay.policy_id,
      policy_version: overlay.policy_version,
      current_schema_bundle_version: overlay.current_schema_bundle_version,
      adapters: [...base.adapters, overlay.adapter],
    };
    return schemaVersion === "startup_opportunity.research_publication_policy.v9"
      ? {
          ...common,
          ai_baseline_contract: (overlay as ResearchPublicationPolicyOverlayV9)
            .ai_baseline_contract,
        }
      : schemaVersion === "startup_opportunity.research_publication_policy.v10"
        ? {
            ...common,
            ai_economics_contract: (overlay as ResearchPublicationPolicyOverlayV10)
              .ai_economics_contract,
          }
        : schemaVersion === "startup_opportunity.research_publication_policy.v11"
          ? {
              ...common,
              ai_mandatory_bundle_contract: (overlay as ResearchPublicationPolicyOverlayV11)
                .ai_mandatory_bundle_contract,
            }
          : schemaVersion === "startup_opportunity.research_publication_policy.v12"
            ? {
                ...common,
                terminal_reporting_contract: (overlay as ResearchPublicationPolicyOverlayV12)
                  .terminal_reporting_contract,
              }
            : schemaVersion === "startup_opportunity.research_publication_policy.v13"
              ? {
                  ...common,
                  declarative_runtime_contract: (overlay as ResearchPublicationPolicyOverlayV13)
                    .declarative_runtime_contract,
                }
              : {
                  ...common,
                  assessment_execution_contract: (overlay as ResearchPublicationPolicyOverlayV14)
                    .assessment_execution_contract,
                };
  }

  const policy = await expandPolicy(relativePath);
  const versions = policy.adapters.map((adapter) => adapter.envelope_version);
  if (
    new Set(versions).size !== versions.length ||
    versions.length !== 18 ||
    canonicalJson(policy.adapters) !== canonicalJson(EXPECTED_ADAPTERS)
  ) {
    throw new StoreError(
      "publication_policy.invalid",
      "research publication policy adapter tuples differ from the published contract",
    );
  }
  return new PublicationPolicy(policy);
}

import {
  canonicalContentHash,
  type DocumentBundle,
  type EvidenceStoreRecordV2,
  type FormalArtifactEnvelope,
} from "../../../harness/src/index.js";
import {
  fixtureEnvelope,
  G21_OPPORTUNITY_REF,
  G21_SOLUTION_REF,
  refreshDiscoveryMapsBundle,
} from "../g2.1/discovery-maps-fixture.js";
import {
  createDiscoveryCandidateFixture,
  fixtureEffective,
  fixtureEntry,
  G22_CONVERSION,
  G22_DEMAND_R1,
  G22_DEMAND_R2,
  G22_EVALUATION_EVIDENCE,
  G22_FAN_IN,
  G22_GENERATION_EVIDENCE,
  G22_RUN_ID,
} from "./discovery-candidate-fixture.js";

export interface DiscoveryRuntimeSubstrate {
  readonly generation: EvidenceStoreRecordV2;
  readonly evaluation: EvidenceStoreRecordV2;
}

export function runtimeEvidencePath(record: EvidenceStoreRecordV2): string {
  return `evidence/records/${record.evidence_id}.json`;
}

function replaceExactStrings(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    return replacements.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceExactStrings(entry, replacements));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, replaceExactStrings(entry, replacements)]),
  );
}

function applyMechanicalBinding(
  bundle: DocumentBundle,
  artifactPath: string,
  record: EvidenceStoreRecordV2,
): void {
  const evidence = fixtureEffective(bundle, artifactPath);
  evidence.evidence_id = record.evidence_id;
  evidence.mechanical_binding = {
    substrate_record_ref: `evidence/manifest.jsonl#${record.evidence_id}`,
    source_hash: record.source_hash,
    content_hash: record.content_hash,
    raw_content_ref: record.raw_content_ref,
    operation_key: record.operation_key,
    recorded_at: record.recorded_at,
  };
}

export async function createDiscoveryRuntimeFixture(
  runId: string,
  substrate: DiscoveryRuntimeSubstrate,
): Promise<DocumentBundle> {
  const generationPath = runtimeEvidencePath(substrate.generation);
  const evaluationPath = runtimeEvidencePath(substrate.evaluation);
  const replacements = new Map<string, string>([
    [G22_RUN_ID, runId],
    [G22_GENERATION_EVIDENCE, generationPath],
    [G22_EVALUATION_EVIDENCE, evaluationPath],
    [`ev_${"a".repeat(64)}`, substrate.generation.evidence_id],
    [`ev_${"b".repeat(64)}`, substrate.evaluation.evidence_id],
    [
      `evidence/manifest.jsonl#ev_${"a".repeat(64)}`,
      `evidence/manifest.jsonl#${substrate.generation.evidence_id}`,
    ],
    [
      `evidence/manifest.jsonl#ev_${"b".repeat(64)}`,
      `evidence/manifest.jsonl#${substrate.evaluation.evidence_id}`,
    ],
  ]);
  const bundle = replaceExactStrings(
    await createDiscoveryCandidateFixture(),
    replacements,
  ) as DocumentBundle;
  (bundle as { schema_version: string }).schema_version = "startup_opportunity.document_bundle.v10";

  const mutable = bundle as unknown as {
    documents: { path: string; document: Record<string, unknown> }[];
    exact_records: { ref: string; document: Record<string, unknown> }[];
  };
  mutable.documents = mutable.documents.filter((entry) => entry.path !== G22_CONVERSION);
  mutable.exact_records = [
    {
      ref: `evidence/manifest.jsonl#${substrate.generation.evidence_id}`,
      document: substrate.generation,
    },
    {
      ref: `evidence/manifest.jsonl#${substrate.evaluation.evidence_id}`,
      document: substrate.evaluation,
    },
  ];

  refreshDiscoveryMapsBundle(bundle);
  applyMechanicalBinding(bundle, generationPath, substrate.generation);
  applyMechanicalBinding(bundle, evaluationPath, substrate.evaluation);

  for (const candidateRef of [
    G22_DEMAND_R1,
    G22_DEMAND_R2,
    "artifacts/discovery/candidates/candidate_baseline.r1.json",
  ]) {
    fixtureEffective(bundle, candidateRef).map_lineage = {
      ...(fixtureEffective(bundle, candidateRef).map_lineage as Record<string, unknown>),
      source_map_content_hash: fixtureEnvelope(bundle, G21_OPPORTUNITY_REF).content_hash,
    };
  }
  fixtureEffective(
    bundle,
    "artifacts/discovery/candidates/candidate_solution.r1.json",
  ).map_lineage = {
    ...(fixtureEffective(bundle, "artifacts/discovery/candidates/candidate_solution.r1.json")
      .map_lineage as Record<string, unknown>),
    source_map_content_hash: fixtureEnvelope(bundle, G21_SOLUTION_REF).content_hash,
  };
  fixtureEffective(bundle, G22_DEMAND_R2).parent_content_hash = canonicalContentHash(
    fixtureEffective(bundle, G22_DEMAND_R1),
  );

  const fanIn = fixtureEffective(bundle, G22_FAN_IN);
  fanIn.schema_version = "startup_opportunity.discovery_fan_in.v2";
  fanIn.manifest_adapter_boundary = {
    runtime_adapter_installed: true,
    manifest_state_transition_performed: true,
    late_or_superseded_can_enter_current_refs: false,
  };

  for (const entry of mutable.documents) {
    if (entry.document.schema_version === "startup_opportunity.artifact_envelope.v9") {
      entry.document.schema_version = "startup_opportunity.artifact_envelope.v10";
    }
    if (
      String(entry.document.schema_version).startsWith("startup_opportunity.artifact_envelope.")
    ) {
      const document = entry.document.document as Record<string, unknown>;
      entry.document.artifact_type = document.schema_version;
      entry.document.content_hash = canonicalContentHash(document);
    }
  }

  const manifest = fixtureEntry(bundle, "manifest.json");
  manifest.schema_bundle_version = "9.0.0";
  manifest.status = "researching";
  manifest.completed_units = ["unit_counterfactual", "unit_seed_independent_demand"];
  manifest.active_units = [];
  manifest.artifact_refs = mutable.documents
    .filter((entry) => entry.path !== "manifest.json")
    .map((entry) => entry.path)
    .sort();
  return bundle;
}

export function runtimeEnvelope(
  bundle: DocumentBundle,
  artifactPath: string,
): FormalArtifactEnvelope {
  return fixtureEntry(bundle, artifactPath) as unknown as FormalArtifactEnvelope;
}

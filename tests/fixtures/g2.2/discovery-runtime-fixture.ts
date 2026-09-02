import {
  canonicalContentHash,
  type DiscoveryProfile,
  type DocumentBundle,
  deriveLaneSubmissionContract,
  type EvidenceStoreRecord,
  type FormalArtifactEnvelope,
} from "../../../harness/src/index.js";
import { refreshDiscoveryRuntimeLineage } from "../../helpers/discovery-wave.js";
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
  G22_DEMAND_R1,
  G22_DEMAND_R2,
  G22_EVALUATION_EVIDENCE,
  G22_FAN_IN,
  G22_GENERATION_EVIDENCE,
  G22_RUN_ID,
  refreshDiscoveryCandidateFormation,
} from "./discovery-candidate-fixture.js";

export interface DiscoveryRuntimeSubstrate {
  readonly generation: EvidenceStoreRecord;
  readonly evaluation: EvidenceStoreRecord;
}

export function runtimeEvidencePath(record: EvidenceStoreRecord): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function refreshLaneSubmissionContracts(
  documents: readonly { readonly path: string; readonly document: Record<string, unknown> }[],
): void {
  const taskContracts = new Map<
    string,
    {
      readonly allowedOutputPath: string;
      readonly requiredArtifactSchema: string;
      readonly commercialAuditOutputPath: string | null;
      readonly laneSubmissionContract: Record<string, unknown>;
    }
  >();
  for (const entry of documents) {
    const envelope = entry.document;
    if (
      !String(envelope.schema_version).startsWith("startup_opportunity.artifact_envelope.") ||
      !String(envelope.artifact_type).startsWith("startup_opportunity.research_task.")
    ) {
      continue;
    }
    const task = isRecord(envelope.document) ? envelope.document : null;
    if (task === null) continue;
    const requirements = isRecord(task.commercial_research_requirements)
      ? task.commercial_research_requirements
      : null;
    const commercialAuditOutputPath =
      requirements !== null && typeof requirements.commercial_audit_output_path === "string"
        ? requirements.commercial_audit_output_path
        : null;
    const allowedOutputPath = String(task.allowed_output_path);
    const requiredArtifactSchema = String(task.required_artifact_schema);
    const laneSubmissionContract = deriveLaneSubmissionContract({
      runId: String(task.run_id),
      unitId: String(task.unit_id),
      taskId: String(task.task_id),
      attempt: Number(task.attempt ?? 1),
      formalOutputPath: allowedOutputPath,
      formalArtifactSchema: requiredArtifactSchema,
      commercialAuditOutputPath,
    });
    task.lane_submission_contract = laneSubmissionContract;
    taskContracts.set(String(task.unit_id), {
      allowedOutputPath,
      requiredArtifactSchema,
      commercialAuditOutputPath,
      laneSubmissionContract,
    });
  }
  for (const entry of documents) {
    const envelope = entry.document;
    if (
      !String(envelope.schema_version).startsWith("startup_opportunity.artifact_envelope.") ||
      !isRecord(envelope.document)
    ) {
      continue;
    }
    const document = envelope.document;
    if (
      envelope.artifact_type === "startup_opportunity.research_execution_plan.discovery.current"
    ) {
      for (const stage of records(document.stages)) {
        for (const lane of records(stage.lanes)) {
          const contract = taskContracts.get(String(lane.unit_id));
          if (contract === undefined) continue;
          lane.submission_path = contract.allowedOutputPath;
          lane.submission_schema = contract.requiredArtifactSchema;
          lane.commercial_audit_output_path = contract.commercialAuditOutputPath;
          lane.lane_submission_contract = contract.laneSubmissionContract;
        }
      }
    }
    if (envelope.artifact_type === "startup_opportunity.dispatch_batch.discovery.current") {
      for (const task of records(document.tasks)) {
        const contract = taskContracts.get(String(task.unit_id));
        if (contract === undefined) continue;
        task.allowed_output_path = contract.allowedOutputPath;
        task.required_artifact_schema = contract.requiredArtifactSchema;
        task.commercial_audit_output_path = contract.commercialAuditOutputPath;
        task.lane_submission_contract = contract.laneSubmissionContract;
      }
    }
  }
}

function applyMechanicalBinding(
  bundle: DocumentBundle,
  artifactPath: string,
  record: EvidenceStoreRecord,
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
  additionalPlanWaves: readonly Record<string, unknown>[] = [],
  profile: DiscoveryProfile = "general",
  canonicalPlanOutputPaths = false,
  researchLanguage = "en-US",
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
    await createDiscoveryCandidateFixture(additionalPlanWaves, profile, researchLanguage),
    replacements,
  ) as DocumentBundle;
  if (canonicalPlanOutputPaths) {
    const plan = fixtureEffective(bundle, "plans/research-plan.r1.json");
    for (const wave of plan.waves as { units: Record<string, unknown>[] }[]) {
      for (const unit of wave.units) {
        if (unit.required_artifact_schema === "startup_opportunity.discovery_lane_result.v1") {
          unit.output_path = `artifacts/discovery/lanes/${String(unit.unit_id)}.attempt-${String(unit.attempt)}.json`;
        } else if (
          unit.required_artifact_schema === "startup_opportunity.enrichment_branch_result.v1"
        ) {
          unit.output_path = `artifacts/discovery/enrichment/branches/${String(unit.unit_id)}.attempt-${String(unit.attempt)}.json`;
        }
      }
    }
  }
  (bundle as { schema_version: string }).schema_version =
    "startup_opportunity.document_bundle.current";

  const mutable = bundle as unknown as {
    documents: { path: string; document: Record<string, unknown> }[];
    exact_records: { ref: string; document: Record<string, unknown> }[];
  };
  refreshLaneSubmissionContracts(mutable.documents);
  mutable.exact_records = [
    ...mutable.exact_records.filter((record) => !record.ref.startsWith("evidence/manifest.jsonl#")),
    {
      ref: `evidence/manifest.jsonl#${substrate.generation.evidence_id}`,
      document: substrate.generation,
    },
    {
      ref: `evidence/manifest.jsonl#${substrate.evaluation.evidence_id}`,
      document: substrate.evaluation,
    },
  ];

  const manifestDocument = fixtureEffective(bundle, "manifest.json");
  const proposal = mutable.exact_records.find(
    (record) => record.ref === manifestDocument.scope_proposal_ref,
  )?.document;
  const confirmation = mutable.exact_records.find(
    (record) => record.ref === manifestDocument.scope_confirmation_ref,
  )?.document;
  if (proposal !== undefined) {
    manifestDocument.scope_proposal_hash = canonicalContentHash(proposal);
  }
  if (confirmation !== undefined) {
    manifestDocument.scope_confirmation_hash = canonicalContentHash(confirmation);
  }

  refreshDiscoveryMapsBundle(bundle);
  refreshDiscoveryRuntimeLineage(bundle);
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
  refreshDiscoveryCandidateFormation(bundle);
  fixtureEffective(bundle, G22_DEMAND_R2).parent_content_hash = canonicalContentHash(
    fixtureEffective(bundle, G22_DEMAND_R1),
  );

  const fanIn = fixtureEffective(bundle, G22_FAN_IN);
  fanIn.manifest_projection = {
    status_projection_required: true,
    late_or_superseded_can_enter_current_refs: false,
  };

  for (const entry of mutable.documents) {
    if (
      String(entry.document.schema_version).startsWith("startup_opportunity.artifact_envelope.")
    ) {
      const document = entry.document.document as Record<string, unknown>;
      entry.document.artifact_type = document.schema_version;
      entry.document.content_hash = canonicalContentHash(document);
    }
  }

  const manifest = fixtureEntry(bundle, "manifest.json");
  manifest.status = "researching";
  manifest.completed_units = ["unit_counterfactual", "unit_seed_independent_demand"];
  manifest.active_units = [];
  manifest.current_discovery_fan_in_ref = G22_FAN_IN;
  manifest.current_discovery_fan_in_hash = fixtureEnvelope(bundle, G22_FAN_IN).content_hash;
  manifest.current_pre_candidate_confirmation_ref = null;
  manifest.current_pre_candidate_confirmation_hash = null;
  manifest.current_pre_candidate_confirmation_action = null;
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

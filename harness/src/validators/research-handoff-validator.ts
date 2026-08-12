import { canonicalContentHash, canonicalJson, sha256Bytes } from "../artifact-store/canonical.js";
import type { ValidationIssue } from "./schema-bundle.js";

export interface ResearchHandoffDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

export interface ResearchProvenanceProjection extends Record<string, unknown> {
  readonly handoff_refs: readonly string[];
  readonly inherited_evidence: readonly Record<string, unknown>[];
  readonly current_run_evidence_refs: readonly string[];
  readonly prior_synthesis_items: readonly Record<string, unknown>[];
  readonly revalidation_required_items: readonly Record<string, unknown>[];
}

const CONTROL_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.run_manifest.v1",
  "startup_opportunity.checkpoint.v1",
  "startup_opportunity.research_plan.v1",
  "startup_opportunity.gap_snapshot.discovery.plan.current",
  "startup_opportunity.gap_snapshot.discovery.readiness.current",
  "startup_opportunity.gap_snapshot.assessment.current",
  "startup_opportunity.adaptation_decision.discovery.current",
  "startup_opportunity.adaptation_decision.assessment.current",
  "startup_opportunity.research_execution_plan.discovery.current",
  "startup_opportunity.research_execution_plan.assessment.current",
  "startup_opportunity.dispatch_batch.discovery.current",
  "startup_opportunity.dispatch_batch.assessment.current",
  "startup_opportunity.research_task.assessment.current",
  "startup_opportunity.research_task.discovery_candidate.current",
  "startup_opportunity.research_task.discovery_evaluation.current",
  "startup_opportunity.assessment_stage_gate.v1",
  "startup_opportunity.discovery_stage_readiness.v1",
  "startup_opportunity.gate_diagnostics.current",
  "startup_opportunity.lane_lifecycle.v1",
  "startup_opportunity.lane_delivery_receipt.current",
  "startup_opportunity.lane_delivery_result.current",
  "startup_opportunity.opportunity_comparison.v1",
  "startup_opportunity.sensitivity.v1",
  "startup_opportunity.decision_recommendation.v1",
  "startup_opportunity.decision_subject_snapshot.current",
  "startup_opportunity.event.v1",
  "startup_opportunity.decision.v1",
]);

const PRIOR_SYNTHESIS_ONLY_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.claim.assessment.current",
  "startup_opportunity.claim.discovery_candidate.current",
  "startup_opportunity.claim.discovery_evaluation.current",
  "startup_opportunity.finding.assessment.current",
  "startup_opportunity.finding.discovery_candidate.current",
  "startup_opportunity.finding.discovery_evaluation.current",
  "startup_opportunity.judgment_assessment.assessment.current",
  "startup_opportunity.judgment_assessment.discovery_candidate.current",
  "startup_opportunity.judgment_assessment.discovery_evaluation.current",
  "startup_opportunity.report.v1",
  "startup_opportunity.concept_evidence_report.v1",
  "startup_opportunity.terminal_report_source.v1",
  "startup_opportunity.decision_brief.assessment.current",
  "startup_opportunity.decision_brief.discovery.current",
  "startup_opportunity.decision_brief.terminal.current",
  "startup_opportunity.discovery_report_view.v1",
  "startup_opportunity.concept_evidence_report_view.v1",
  "startup_opportunity.terminal_report_view.v1",
]);

const HANDOFF_CONSUMER_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.seed_probe.v1",
  "startup_opportunity.opportunity_space_map.v1",
  "startup_opportunity.solution_space_map.v1",
  "startup_opportunity.discovery_candidate.v1",
  "startup_opportunity.opportunity_thesis.v1",
  "startup_opportunity.concept_hypothesis.assessment.current",
  "startup_opportunity.concept_hypothesis.assessment_intake.current",
]);

export function researchHandoffSourceRoleAllowed(
  sourceSchemaVersion: string,
  role: string,
): boolean {
  return (
    [
      "user_authorized_input",
      "reusable_evidence",
      "prior_synthesis",
      "revalidation_required",
    ].includes(role) &&
    !CONTROL_SCHEMA_VERSIONS.has(sourceSchemaVersion) &&
    (!PRIOR_SYNTHESIS_ONLY_SCHEMA_VERSIONS.has(sourceSchemaVersion) ||
      ["prior_synthesis", "revalidation_required"].includes(role)) &&
    (role !== "reusable_evidence" ||
      sourceSchemaVersion === "startup_opportunity.evidence_store_record.v2")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function issue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "research_handoff",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function targetHash(target: ResearchHandoffDocument): string {
  return typeof target.envelope?.content_hash === "string"
    ? target.envelope.content_hash
    : canonicalContentHash(target.document);
}

function handoffBindings(document: ResearchHandoffDocument): readonly Record<string, unknown>[] {
  if (document.schemaVersion === "startup_opportunity.discovery_candidate.v1") {
    const formation = isRecord(document.document.formation) ? document.document.formation : {};
    return records(formation.research_handoff_input_hashes);
  }
  return records(document.document.research_handoff_input_hashes);
}

function exactItem(
  handoff: ResearchHandoffDocument,
  itemId: string,
): Record<string, unknown> | undefined {
  return records(handoff.document.items).find((item) => item.item_id === itemId);
}

export function deriveResearchProvenance(
  runId: string,
  documents: readonly ResearchHandoffDocument[],
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
): ResearchProvenanceProjection {
  const handoffs = documents
    .filter(
      (entry) =>
        entry.schemaVersion === "startup_opportunity.research_handoff.current" &&
        entry.document.run_id === runId,
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  const items = handoffs
    .flatMap((handoff) =>
      records(handoff.document.items).map((item) => ({
        handoff_ref: handoff.path,
        handoff_item_id: item.item_id,
        source_run_id: handoff.document.source_run_id,
        source_artifact_path: item.source_artifact_path,
        source_content_hash: item.source_content_hash,
        role: item.role,
        freshness_disposition: item.freshness_disposition,
        applicability_disposition: item.applicability_disposition,
        revalidation_status: item.revalidation_status,
        target_evidence_ref:
          typeof item.target_evidence_ref === "string" ? item.target_evidence_ref : null,
      })),
    )
    .sort(
      (left, right) =>
        String(left.handoff_ref).localeCompare(String(right.handoff_ref)) ||
        String(left.handoff_item_id).localeCompare(String(right.handoff_item_id)),
    );
  return {
    handoff_refs: handoffs.map((handoff) => handoff.path),
    inherited_evidence: items.filter((item) => item.role === "reusable_evidence"),
    current_run_evidence_refs: [...exactRecords.entries()]
      .filter(
        ([, record]) =>
          record.schema_version === "startup_opportunity.evidence_store_record.v2" &&
          record.run_id === runId &&
          record.handoff_binding === undefined,
      )
      .map(([ref]) => ref)
      .sort(),
    prior_synthesis_items: items.filter((item) =>
      ["user_authorized_input", "prior_synthesis"].includes(String(item.role)),
    ),
    revalidation_required_items: items.filter((item) => item.revalidation_status === "required"),
  };
}

export function researchHandoffCapturedPayloadValid(
  item: Record<string, unknown>,
  sourceRunId: unknown,
): boolean {
  let payload: Buffer;
  let parsed: unknown;
  try {
    payload = Buffer.from(String(item.source_payload_base64), "base64");
    parsed = JSON.parse(payload.toString("utf8")) as unknown;
  } catch {
    return false;
  }
  if (sha256Bytes(payload) !== item.source_byte_hash || !isRecord(parsed)) return false;
  if (item.source_kind === "formal_artifact") {
    return (
      parsed.schema_version === "startup_opportunity.artifact_envelope.current" &&
      parsed.run_id === sourceRunId &&
      parsed.artifact_path === item.source_artifact_path &&
      parsed.artifact_type === item.source_schema_version &&
      isRecord(parsed.document) &&
      parsed.content_hash === canonicalContentHash(parsed.document) &&
      parsed.content_hash === item.source_content_hash &&
      canonicalContentHash(parsed) === item.source_record_hash &&
      item.source_raw_content_hash === null
    );
  }
  return (
    item.source_kind === "evidence_substrate" &&
    parsed.schema_version === "startup_opportunity.evidence_store_record.v2" &&
    parsed.run_id === sourceRunId &&
    `evidence/manifest.jsonl#${String(parsed.evidence_id)}` === item.source_artifact_path &&
    parsed.schema_version === item.source_schema_version &&
    canonicalContentHash(parsed) === item.source_record_hash &&
    parsed.content_hash === item.source_content_hash &&
    parsed.content_hash === item.source_raw_content_hash
  );
}

function validateHandoffArtifact(
  handoff: ResearchHandoffDocument,
  byPath: ReadonlyMap<string, ResearchHandoffDocument>,
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
  errors: ValidationIssue[],
): void {
  const document = handoff.document;
  const expectedPath = `artifacts/research-handoffs/${String(document.handoff_id)}.json`;
  const scope =
    typeof document.target_scope_ref === "string"
      ? byPath.get(document.target_scope_ref)
      : undefined;
  const plan =
    typeof document.target_plan_ref === "string" ? byPath.get(document.target_plan_ref) : undefined;
  const planBound =
    document.target_formation_stage === "plan_bound" &&
    plan?.schemaVersion === "startup_opportunity.research_plan.v1" &&
    plan.document.run_id === document.run_id &&
    document.target_plan_hash === targetHash(plan);
  const prePlanAssessmentFormation =
    document.target_formation_stage === "pre_plan_assessment_formation" &&
    scope?.schemaVersion === "startup_opportunity.scope_frame.assessment.current" &&
    document.target_plan_ref === null &&
    document.target_plan_hash === null;
  const expectedInputs = [
    String(document.target_scope_ref),
    ...(planBound ? [String(document.target_plan_ref)] : []),
  ].sort();
  if (
    handoff.path !== expectedPath ||
    handoff.envelope?.producer_role !== "harness" ||
    handoff.envelope.artifact_type !== handoff.schemaVersion ||
    handoff.envelope.run_id !== document.run_id ||
    handoff.envelope.content_hash !== canonicalContentHash(document) ||
    canonicalJson([...strings(handoff.envelope.input_refs)].sort()) !==
      canonicalJson(expectedInputs)
  ) {
    errors.push(
      issue(
        "research_handoff.envelope_identity_mismatch",
        handoff.path,
        "Research handoff must use its deterministic Harness-owned path and exact target formation input closure",
      ),
    );
  }
  if (
    document.source_run_id === document.run_id ||
    scope === undefined ||
    scope.document.run_id !== document.run_id ||
    ![
      "startup_opportunity.scope_frame.discovery.current",
      "startup_opportunity.scope_frame.assessment.current",
    ].includes(scope.schemaVersion) ||
    document.target_scope_hash !== targetHash(scope) ||
    (!planBound && !prePlanAssessmentFormation)
  ) {
    errors.push(
      issue(
        "research_handoff.target_binding_mismatch",
        handoff.path,
        "Research handoff must bind a distinct source Run and either the exact current Scope/Plan or the initial pre-Plan Assessment formation boundary",
      ),
    );
  }
  const items = records(document.items);
  const itemIds = items.map((item) => String(item.item_id));
  const sourcePaths = items.map((item) => String(item.source_artifact_path));
  if (
    new Set(itemIds).size !== itemIds.length ||
    new Set(sourcePaths).size !== sourcePaths.length
  ) {
    errors.push(
      issue(
        "research_handoff.item_identity_duplicate",
        `${handoff.path}#/items`,
        "Research handoff item ids and exact source paths must be unique",
      ),
    );
  }
  for (const [index, item] of items.entries()) {
    const sourceSchema = String(item.source_schema_version);
    const role = String(item.role);
    if (
      !researchHandoffCapturedPayloadValid(item, document.source_run_id) ||
      !researchHandoffSourceRoleAllowed(sourceSchema, role)
    ) {
      errors.push(
        issue(
          "research_handoff.item_boundary_invalid",
          `${handoff.path}#/items/${index}`,
          "Handoff item bytes, source type, role, or decision boundary is invalid",
          { sourceSchema, role },
        ),
      );
    }
    if (role !== "reusable_evidence") continue;
    const targetRecords = [...exactRecords.entries()].filter(([, record]) => {
      const binding = isRecord(record.handoff_binding) ? record.handoff_binding : {};
      return binding.handoff_ref === handoff.path && binding.handoff_item_id === item.item_id;
    });
    if (targetRecords.length !== 1) {
      errors.push(
        issue(
          "research_handoff.evidence_copy_missing",
          `${handoff.path}#/items/${index}`,
          "Reusable Evidence handoff requires exactly one target Evidence substrate copy",
          { count: targetRecords.length },
        ),
      );
      continue;
    }
    const [targetRef, targetRecord] = targetRecords[0] ?? [];
    const binding = isRecord(targetRecord?.handoff_binding) ? targetRecord.handoff_binding : {};
    if (
      targetRecord?.run_id !== document.run_id ||
      targetRef !== item.target_evidence_ref ||
      canonicalContentHash(targetRecord) !== item.target_evidence_record_hash ||
      targetRecord?.content_hash !== item.source_raw_content_hash ||
      binding.source_run_id !== document.source_run_id ||
      binding.source_evidence_path !== item.source_artifact_path ||
      binding.source_record_hash !== item.source_record_hash ||
      binding.source_raw_content_hash !== item.source_raw_content_hash ||
      binding.freshness_disposition !== item.freshness_disposition ||
      binding.applicability_disposition !== item.applicability_disposition ||
      binding.revalidation_status !== item.revalidation_status
    ) {
      errors.push(
        issue(
          "research_handoff.evidence_copy_binding_mismatch",
          `${handoff.path}#/items/${index}`,
          "Imported Evidence must retain exact handoff, source record, raw byte, freshness, and applicability provenance",
        ),
      );
    }
  }
}

function validateConsumerBindings(
  consumer: ResearchHandoffDocument,
  byPath: ReadonlyMap<string, ResearchHandoffDocument>,
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
  errors: ValidationIssue[],
): void {
  const bindings = handoffBindings(consumer);
  const refs = bindings.map((binding) => String(binding.ref));
  if (new Set(refs).size !== refs.length) {
    errors.push(
      issue(
        "research_handoff.consumer_binding_duplicate",
        `${consumer.path}#/research_handoff_input_hashes`,
        "A subject formation may bind each handoff item only once",
      ),
    );
  }
  for (const [index, binding] of bindings.entries()) {
    const [handoffPath = "", itemId] = String(binding.ref).split("#", 2);
    const handoff = byPath.get(handoffPath);
    const item =
      itemId === undefined || handoff === undefined ? undefined : exactItem(handoff, itemId);
    if (
      handoff?.schemaVersion !== "startup_opportunity.research_handoff.current" ||
      handoff.document.run_id !== consumer.document.run_id ||
      binding.content_hash !== targetHash(handoff) ||
      item === undefined ||
      item.role === "reusable_evidence" ||
      (handoff.document.target_formation_stage === "pre_plan_assessment_formation" &&
        (consumer.schemaVersion !==
          "startup_opportunity.concept_hypothesis.assessment_intake.current" ||
          consumer.path !== "concept-hypothesis.json")) ||
      !strings(consumer.envelope?.input_refs).includes(String(binding.ref))
    ) {
      errors.push(
        issue(
          "research_handoff.consumer_binding_mismatch",
          `${consumer.path}#/research_handoff_input_hashes/${index}`,
          "Prior formation input must bind an exact same-Run handoff item and handoff Artifact hash; reusable Evidence uses target Evidence refs instead",
          { ref: binding.ref },
        ),
      );
    }
  }
  const taintRequiredRefs = [...exactRecords.values()]
    .filter(
      (decision) =>
        decision.schema_version === "startup_opportunity.decision.v1" &&
        decision.decision_type === "research_handoff_consumed" &&
        decision.run_id === consumer.document.run_id &&
        !strings(decision.research_handoff_taint_exempt_artifact_refs).includes(consumer.path),
    )
    .flatMap((decision) => strings(decision.research_handoff_item_refs))
    .filter((ref) => {
      const [handoffPath = "", itemId] = ref.split("#", 2);
      const handoff = byPath.get(handoffPath);
      const item =
        itemId === undefined || handoff === undefined ? undefined : exactItem(handoff, itemId);
      return (
        item !== undefined &&
        item.role !== "reusable_evidence" &&
        (handoff?.document.target_formation_stage !== "pre_plan_assessment_formation" ||
          (consumer.schemaVersion ===
            "startup_opportunity.concept_hypothesis.assessment_intake.current" &&
            consumer.path === "concept-hypothesis.json"))
      );
    })
    .filter((ref, index, values) => values.indexOf(ref) === index)
    .sort();
  const missingTaintRefs = taintRequiredRefs.filter((ref) => !refs.includes(ref));
  if (missingTaintRefs.length > 0) {
    errors.push(
      issue(
        "research_handoff.consumer_provenance_not_propagated",
        `${consumer.path}#/research_handoff_input_hashes`,
        "subject formation after a controlled handoff read must retain every non-Evidence handoff item as hypothesis-only provenance",
        { missingTaintRefs },
      ),
    );
  }
}

export function validateResearchHandoffContract(
  documents: readonly ResearchHandoffDocument[],
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
): readonly ValidationIssue[] {
  const relevant = documents.filter(
    (entry) =>
      entry.schemaVersion === "startup_opportunity.research_handoff.current" ||
      HANDOFF_CONSUMER_SCHEMA_VERSIONS.has(entry.schemaVersion),
  );
  const errors: ValidationIssue[] = [];
  const byPath = new Map(documents.map((entry) => [entry.path, entry]));
  for (const [ref, record] of exactRecords) {
    const binding = isRecord(record.handoff_binding) ? record.handoff_binding : null;
    if (binding === null) continue;
    const handoff =
      typeof binding.handoff_ref === "string" ? byPath.get(binding.handoff_ref) : undefined;
    if (handoff?.schemaVersion !== "startup_opportunity.research_handoff.current") {
      errors.push(
        issue(
          "research_handoff.evidence_orphaned",
          ref,
          "Imported Evidence binding must resolve to its same-Run formal research handoff",
          { handoffRef: binding.handoff_ref },
        ),
      );
    }
  }
  if (
    !relevant.some(
      (entry) => entry.schemaVersion === "startup_opportunity.research_handoff.current",
    )
  ) {
    return errors;
  }
  for (const handoff of relevant.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.research_handoff.current",
  )) {
    validateHandoffArtifact(handoff, byPath, exactRecords, errors);
  }
  for (const consumer of relevant.filter((entry) =>
    HANDOFF_CONSUMER_SCHEMA_VERSIONS.has(entry.schemaVersion),
  )) {
    validateConsumerBindings(consumer, byPath, exactRecords, errors);
  }
  return errors;
}

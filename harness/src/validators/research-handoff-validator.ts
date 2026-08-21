import { canonicalContentHash, canonicalJson, sha256Bytes } from "../artifact-store/canonical.js";
import type { ValidationIssue } from "./schema-bundle.js";

export interface ResearchHandoffDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

export interface ResearchProvenanceProjection extends Record<string, unknown> {
  readonly available_handoff_count: number;
  readonly captured_item_count: number;
  readonly causal_handoff_refs: readonly string[];
  readonly consumed_item_refs: readonly string[];
  readonly used_handoff_items: readonly Record<string, unknown>[];
  readonly imported_substrate_refs: readonly string[];
  readonly formal_inherited_evidence_refs: readonly string[];
  readonly adopted_inherited_evidence_refs: readonly string[];
  readonly cited_inherited_evidence_refs: readonly string[];
  readonly formal_current_evidence_refs: readonly string[];
  readonly adopted_current_evidence_refs: readonly string[];
  readonly cited_current_evidence_refs: readonly string[];
  readonly revalidation_gaps: readonly Record<string, unknown>[];
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

function typedFormationRefs(document: ResearchHandoffDocument): readonly string[] {
  const value = document.document;
  if (document.schemaVersion === "startup_opportunity.seed_probe.v1") {
    return [
      ...strings([value.parent_seed_probe_ref]),
      ...records(value.input_artifact_hashes).flatMap((binding) =>
        typeof binding.ref === "string" ? [binding.ref] : [],
      ),
    ];
  }
  if (document.schemaVersion === "startup_opportunity.opportunity_space_map.v1") {
    return [
      ...strings([value.parent_map_ref, value.seed_probe_ref]),
      ...records(value.input_artifact_hashes).flatMap((binding) =>
        typeof binding.ref === "string" ? [binding.ref] : [],
      ),
    ];
  }
  if (document.schemaVersion === "startup_opportunity.solution_space_map.v1") {
    return [
      ...strings([value.parent_map_ref, value.seed_probe_ref, value.opportunity_space_map_ref]),
      ...records(value.input_artifact_hashes).flatMap((binding) =>
        typeof binding.ref === "string" ? [binding.ref] : [],
      ),
    ];
  }
  if (document.schemaVersion === "startup_opportunity.discovery_candidate.v1") {
    const formation = isRecord(value.formation) ? value.formation : {};
    const mapLineage = isRecord(value.map_lineage) ? value.map_lineage : {};
    return [
      ...strings([value.parent_candidate_ref, mapLineage.source_map_ref]),
      ...records(formation.synthesis_input_hashes).flatMap((binding) =>
        typeof binding.ref === "string" ? [binding.ref] : [],
      ),
    ];
  }
  if (document.schemaVersion === "startup_opportunity.discovery_candidate_conversion.v2") {
    return strings([value.parent_conversion_ref, value.source_candidate_ref]);
  }
  if (document.schemaVersion === "startup_opportunity.demand_thesis.v1") {
    return strings([
      value.parent_demand_ref,
      value.source_conversion_ref,
      value.source_candidate_ref,
    ]);
  }
  if (document.schemaVersion === "startup_opportunity.baseline_option.v1") {
    return strings([
      value.parent_baseline_ref,
      value.source_conversion_ref,
      value.source_candidate_ref,
      value.demand_thesis_ref,
    ]);
  }
  if (document.schemaVersion === "startup_opportunity.solution_hypothesis.v1") {
    return strings([
      value.parent_solution_ref,
      value.source_conversion_ref,
      value.source_candidate_ref,
      value.demand_thesis_ref,
      value.baseline_option_ref,
    ]);
  }
  if (document.schemaVersion === "startup_opportunity.solution_evaluation.v1") {
    const exploration = isRecord(value.solution_exploration) ? value.solution_exploration : {};
    return [
      ...strings([
        value.parent_evaluation_ref,
        value.demand_thesis_ref,
        value.baseline_option_ref,
        value.selected_solution_ref,
      ]),
      ...strings(value.solution_hypothesis_refs),
      ...strings(value.alternative_solution_refs),
      ...records(value.rejected_solutions).flatMap((rejected) =>
        typeof rejected.solution_ref === "string" ? [rejected.solution_ref] : [],
      ),
      ...records(exploration.considered_approaches).flatMap((approach) =>
        records(approach.material_bindings).flatMap((binding) =>
          typeof binding.ref === "string" ? [binding.ref] : [],
        ),
      ),
    ];
  }
  if (document.schemaVersion === "startup_opportunity.opportunity_thesis.v1") {
    const summary = isRecord(value.solution_evaluation_summary)
      ? value.solution_evaluation_summary
      : {};
    return [
      ...strings([
        value.parent_opportunity_ref,
        value.demand_thesis_ref,
        value.selected_solution_ref,
        value.baseline_option_ref,
        value.solution_evaluation_ref,
      ]),
      ...strings(value.alternative_solution_refs),
      ...strings(summary.formal_solution_refs),
      ...records(summary.rejected_solutions).flatMap((rejected) => [
        ...strings([rejected.solution_ref]),
        ...strings(rejected.judgment_assessment_refs),
      ]),
      ...records(summary.considered_approaches).flatMap((approach) =>
        records(approach.material_bindings).flatMap((binding) =>
          typeof binding.ref === "string" ? [binding.ref] : [],
        ),
      ),
    ];
  }
  if (
    [
      "startup_opportunity.concept_hypothesis.assessment.current",
      "startup_opportunity.concept_hypothesis.assessment_intake.current",
    ].includes(document.schemaVersion)
  ) {
    return [
      ...strings([value.parent_concept_ref]),
      ...records(value.formation_input_hashes).flatMap((binding) =>
        typeof binding.ref === "string" ? [binding.ref] : [],
      ),
    ];
  }
  return [];
}

function inheritedHandoffRefs(
  document: ResearchHandoffDocument,
  byPath: ReadonlyMap<string, ResearchHandoffDocument>,
  visiting = new Set<string>(),
): readonly string[] {
  if (visiting.has(document.path)) return [];
  visiting.add(document.path);
  const refs = typedFormationRefs(document).flatMap((ref) => {
    const parent = byPath.get(ref.split("#", 1)[0] ?? "");
    if (parent === undefined) return [];
    return [
      ...handoffBindings(parent).flatMap((binding) =>
        typeof binding.ref === "string" ? [binding.ref] : [],
      ),
      ...inheritedHandoffRefs(parent, byPath, visiting),
    ];
  });
  visiting.delete(document.path);
  return refs.filter((ref, index, values) => values.indexOf(ref) === index).sort();
}

function consumerPlanApplicable(
  consumer: ResearchHandoffDocument,
  handoff: ResearchHandoffDocument | undefined,
  byPath: ReadonlyMap<string, ResearchHandoffDocument>,
): boolean {
  if (handoff?.document.target_formation_stage !== "plan_bound") return true;
  const targetPlanRef = handoff.document.target_plan_ref;
  if (consumer.document.research_plan_ref === targetPlanRef) return true;
  if (
    ![
      "startup_opportunity.concept_hypothesis.assessment.current",
      "startup_opportunity.concept_hypothesis.assessment_intake.current",
    ].includes(consumer.schemaVersion) ||
    typeof targetPlanRef !== "string"
  ) {
    return false;
  }
  const targetPlan = byPath.get(targetPlanRef);
  return (
    targetPlan?.schemaVersion === "startup_opportunity.research_plan.v1" &&
    targetPlan.document.run_id === consumer.document.run_id &&
    records(consumer.document.formation_input_hashes).some(
      (binding) => binding.ref === targetPlanRef && binding.content_hash === targetHash(targetPlan),
    )
  );
}

function refsInValue(value: unknown, refs: Set<string>): void {
  if (typeof value === "string") {
    refs.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) refsInValue(item, refs);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) refsInValue(item, refs);
  }
}

function reportCausalPaths(
  documents: readonly ResearchHandoffDocument[],
  reportRootPath: string,
): ReadonlySet<string> {
  const byPath = new Map(documents.map((entry) => [entry.path, entry]));
  const reachable = new Set<string>();
  const pending = byPath.has(reportRootPath) ? [reportRootPath] : [];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || reachable.has(path)) continue;
    const entry = byPath.get(path);
    if (entry === undefined) continue;
    reachable.add(path);
    const refs = new Set<string>(strings(entry.envelope?.input_refs));
    refsInValue(
      Object.fromEntries(
        Object.entries(entry.document).filter(([key]) => key !== "research_provenance"),
      ),
      refs,
    );
    for (const ref of refs) {
      const targetPath = ref.split("#", 1)[0] ?? ref;
      if (byPath.has(targetPath) && !reachable.has(targetPath)) pending.push(targetPath);
    }
  }
  return reachable;
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
  reportRootPath: string,
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
        target_artifact_ref:
          typeof item.target_artifact_ref === "string" ? item.target_artifact_ref : null,
        source_recorded_at:
          typeof item.target_evidence_ref === "string"
            ? ((
                exactRecords.get(item.target_evidence_ref)?.handoff_binding as
                  | Record<string, unknown>
                  | undefined
              )?.source_recorded_at ?? null)
            : null,
      })),
    )
    .sort(
      (left, right) =>
        String(left.handoff_ref).localeCompare(String(right.handoff_ref)) ||
        String(left.handoff_item_id).localeCompare(String(right.handoff_item_id)),
    );
  const consumedItemRefs = [...exactRecords.values()]
    .filter(
      (record) =>
        record.schema_version === "startup_opportunity.decision.v1" &&
        record.decision_type === "research_handoff_consumed" &&
        record.run_id === runId,
    )
    .flatMap((record) => strings(record.research_handoff_item_refs))
    .filter((ref, index, values) => values.indexOf(ref) === index)
    .sort();
  const causalPaths = reportCausalPaths(documents, reportRootPath);
  const directUsedItemRefs = documents
    .filter(
      (entry) =>
        causalPaths.has(entry.path) && HANDOFF_CONSUMER_SCHEMA_VERSIONS.has(entry.schemaVersion),
    )
    .flatMap((entry) => handoffBindings(entry).map((binding) => String(binding.ref)))
    .filter((ref, index, values) => values.indexOf(ref) === index)
    .sort();
  const evidenceDocuments = documents.filter(
    (entry) =>
      causalPaths.has(entry.path) &&
      [
        "startup_opportunity.evidence.assessment.current",
        "startup_opportunity.evidence.discovery_candidate.current",
        "startup_opportunity.evidence.discovery_evaluation.current",
      ].includes(entry.schemaVersion),
  );
  const acceptedEvidenceRefs = new Set(
    documents
      .filter(
        (entry) =>
          causalPaths.has(entry.path) &&
          [
            "startup_opportunity.source_manifest.assessment.current",
            "startup_opportunity.source_manifest.discovery_candidate.current",
            "startup_opportunity.source_manifest.discovery_evaluation.current",
          ].includes(entry.schemaVersion),
      )
      .flatMap((entry) => strings(entry.document.accepted_evidence_refs)),
  );
  const formalEvidence = evidenceDocuments.map((entry) => {
    const binding = isRecord(entry.document.mechanical_binding)
      ? entry.document.mechanical_binding
      : {};
    const substrateRef = String(binding.substrate_record_ref ?? "");
    const substrate = exactRecords.get(substrateRef);
    return {
      path: entry.path,
      substrateRef,
      inherited: isRecord(substrate?.handoff_binding),
      handoffItemRef: isRecord(substrate?.handoff_binding)
        ? `${String(substrate.handoff_binding.handoff_ref)}#${String(substrate.handoff_binding.handoff_item_id)}`
        : null,
      adopted: acceptedEvidenceRefs.has(entry.path),
    };
  });
  const citedRefs = new Set<string>();
  for (const entry of documents.filter((candidate) => causalPaths.has(candidate.path))) {
    refsInValue(
      Object.fromEntries(
        Object.entries(entry.document).filter(([key]) => key !== "research_provenance"),
      ),
      citedRefs,
    );
  }
  const adoptedInheritedItemRefs = formalEvidence.flatMap((entry) =>
    entry.inherited && entry.adopted && entry.handoffItemRef !== null ? [entry.handoffItemRef] : [],
  );
  const causalItemRefs = [...new Set([...directUsedItemRefs, ...adoptedInheritedItemRefs])].sort();
  const usedItems = items.filter((item) =>
    causalItemRefs.includes(`${String(item.handoff_ref)}#${String(item.handoff_item_id)}`),
  );
  const causalHandoffRefs = [...new Set(usedItems.map((item) => String(item.handoff_ref)))].sort();
  const importedSubstrateRefs = items
    .flatMap((item) =>
      item.role === "reusable_evidence" && typeof item.target_evidence_ref === "string"
        ? [String(item.target_evidence_ref)]
        : [],
    )
    .sort();
  return {
    available_handoff_count: handoffs.length,
    captured_item_count: items.length,
    causal_handoff_refs: causalHandoffRefs,
    consumed_item_refs: consumedItemRefs,
    used_handoff_items: usedItems,
    imported_substrate_refs: importedSubstrateRefs,
    formal_inherited_evidence_refs: formalEvidence
      .filter((entry) => entry.inherited)
      .map((entry) => entry.path)
      .sort(),
    adopted_inherited_evidence_refs: formalEvidence
      .filter((entry) => entry.inherited && entry.adopted)
      .map((entry) => entry.path)
      .sort(),
    cited_inherited_evidence_refs: formalEvidence
      .filter((entry) => entry.inherited && entry.adopted && citedRefs.has(entry.path))
      .map((entry) => entry.path)
      .sort(),
    formal_current_evidence_refs: formalEvidence
      .filter((entry) => !entry.inherited)
      .map((entry) => entry.path)
      .sort(),
    adopted_current_evidence_refs: formalEvidence
      .filter((entry) => !entry.inherited && entry.adopted)
      .map((entry) => entry.path)
      .sort(),
    cited_current_evidence_refs: formalEvidence
      .filter((entry) => !entry.inherited && entry.adopted && citedRefs.has(entry.path))
      .map((entry) => entry.path)
      .sort(),
    revalidation_gaps: usedItems.filter(
      (item) =>
        item.revalidation_status === "required" ||
        item.freshness_disposition !== "current" ||
        item.applicability_disposition !== "applicable",
    ),
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
  const confirmation =
    typeof document.target_scope_confirmation_ref === "string"
      ? exactRecords.get(document.target_scope_confirmation_ref)
      : undefined;
  const confirmationBound =
    confirmation?.schema_version === "startup_opportunity.decision.v1" &&
    confirmation.run_id === document.run_id &&
    ["scope_assumption_confirmed", "scope_changed_by_user"].includes(
      String(confirmation.decision_type),
    ) &&
    confirmation.scope_revision === document.target_scope_revision &&
    canonicalContentHash(confirmation) === document.target_scope_confirmation_hash;
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
    !confirmationBound ||
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
    let sourceRecordedAt: unknown;
    try {
      const sourceRecord = JSON.parse(
        Buffer.from(String(item.source_payload_base64), "base64").toString("utf8"),
      ) as Record<string, unknown>;
      sourceRecordedAt = sourceRecord.recorded_at;
    } catch {
      sourceRecordedAt = undefined;
    }
    if (
      targetRecord?.run_id !== document.run_id ||
      targetRef !== item.target_evidence_ref ||
      canonicalContentHash(targetRecord) !== item.target_evidence_record_hash ||
      targetRecord?.content_hash !== item.source_raw_content_hash ||
      binding.source_run_id !== document.source_run_id ||
      binding.source_evidence_path !== item.source_artifact_path ||
      binding.source_record_hash !== item.source_record_hash ||
      binding.source_raw_content_hash !== item.source_raw_content_hash ||
      binding.source_recorded_at !== sourceRecordedAt ||
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
    const consumption = [...exactRecords.values()].find(
      (decision) =>
        decision.schema_version === "startup_opportunity.decision.v1" &&
        decision.decision_type === "research_handoff_consumed" &&
        decision.run_id === consumer.document.run_id &&
        decision.research_handoff_ref === handoffPath &&
        decision.research_handoff_hash === binding.content_hash &&
        strings(decision.research_handoff_item_refs).includes(String(binding.ref)) &&
        strings(decision.research_handoff_target_artifact_refs).includes(
          String(item?.target_artifact_ref),
        ),
    );
    const direct = item?.target_artifact_ref === consumer.path;
    const inherited = inheritedHandoffRefs(consumer, byPath).includes(String(binding.ref));
    const planApplicable = consumerPlanApplicable(consumer, handoff, byPath);
    if (
      handoff?.schemaVersion !== "startup_opportunity.research_handoff.current" ||
      handoff.document.run_id !== consumer.document.run_id ||
      binding.content_hash !== targetHash(handoff) ||
      item === undefined ||
      item.role === "reusable_evidence" ||
      consumption === undefined ||
      (!direct && !inherited) ||
      (direct && !planApplicable) ||
      (direct &&
        handoff.document.target_formation_stage === "pre_plan_assessment_formation" &&
        (consumer.schemaVersion !==
          "startup_opportunity.concept_hypothesis.assessment_intake.current" ||
          consumer.path !== "concept-hypothesis.json")) ||
      !strings(consumer.envelope?.input_refs).includes(String(binding.ref))
    ) {
      errors.push(
        issue(
          "research_handoff.consumer_binding_mismatch",
          `${consumer.path}#/research_handoff_input_hashes/${index}`,
          "Prior formation input must bind an exact consumed handoff item scoped to this direct target under the applicable Plan, or retain immutable provenance inherited from a typed same-Run parent",
          { ref: binding.ref, direct, inherited, planApplicable },
        ),
      );
    }
  }
  const targetedRefs = [...exactRecords.values()]
    .filter(
      (decision) =>
        decision.schema_version === "startup_opportunity.decision.v1" &&
        decision.decision_type === "research_handoff_consumed" &&
        decision.run_id === consumer.document.run_id &&
        strings(decision.research_handoff_target_artifact_refs).includes(consumer.path),
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
        item.target_artifact_ref === consumer.path
      );
    })
    .filter((ref, index, values) => values.indexOf(ref) === index)
    .sort();
  const inheritedRefs = inheritedHandoffRefs(consumer, byPath);
  const missingTargetedRefs = [...new Set([...targetedRefs, ...inheritedRefs])].filter(
    (ref) => !refs.includes(ref),
  );
  if (missingTargetedRefs.length > 0) {
    errors.push(
      issue(
        "research_handoff.target_provenance_not_bound",
        `${consumer.path}#/research_handoff_input_hashes`,
        "the exact Artifact targeted by a controlled handoff read must retain that item as hypothesis-only provenance",
        { missingTargetedRefs },
      ),
    );
  }
}

function restrictedEvidenceUseIssues(
  documents: readonly ResearchHandoffDocument[],
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
): readonly ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const restrictedEvidence = new Set<string>();
  for (const evidence of documents.filter((entry) =>
    [
      "startup_opportunity.evidence.assessment.current",
      "startup_opportunity.evidence.discovery_candidate.current",
      "startup_opportunity.evidence.discovery_evaluation.current",
    ].includes(entry.schemaVersion),
  )) {
    const mechanical = isRecord(evidence.document.mechanical_binding)
      ? evidence.document.mechanical_binding
      : {};
    const substrate = exactRecords.get(String(mechanical.substrate_record_ref));
    const binding = isRecord(substrate?.handoff_binding) ? substrate.handoff_binding : null;
    if (binding === null) continue;
    const handoffRef = String(binding.handoff_ref ?? "");
    const handoff = documents.find(
      (entry) =>
        entry.path === handoffRef &&
        entry.schemaVersion === "startup_opportunity.research_handoff.current",
    );
    const handoffItemRef = `${handoffRef}#${String(binding.handoff_item_id ?? "")}`;
    const handoffHash = handoff === undefined ? null : targetHash(handoff);
    const consumption = [...exactRecords.values()].find(
      (decision) =>
        decision.schema_version === "startup_opportunity.decision.v1" &&
        decision.decision_type === "research_handoff_consumed" &&
        decision.run_id === evidence.document.run_id &&
        decision.research_handoff_ref === handoffRef &&
        decision.research_handoff_hash === handoffHash &&
        strings(decision.research_handoff_item_refs).includes(handoffItemRef),
    );
    const lineage = isRecord(evidence.document.lineage) ? evidence.document.lineage : {};
    const planApplicable =
      handoff?.document.target_formation_stage !== "plan_bound" ||
      lineage.research_plan_ref === handoff.document.target_plan_ref;
    const exactMechanicalBinding =
      substrate !== undefined &&
      substrate.run_id === evidence.document.run_id &&
      substrate.evidence_id === evidence.document.evidence_id &&
      substrate.unit_id === evidence.document.unit_id &&
      substrate.source_hash === mechanical.source_hash &&
      substrate.content_hash === mechanical.content_hash &&
      substrate.raw_content_ref === mechanical.raw_content_ref &&
      substrate.operation_key === mechanical.operation_key &&
      substrate.recorded_at === mechanical.recorded_at;
    if (
      handoff === undefined ||
      consumption === undefined ||
      !planApplicable ||
      !exactMechanicalBinding
    ) {
      errors.push(
        issue(
          "research_handoff.evidence_adoption_unauthorized",
          evidence.path,
          "Formal Evidence derived from imported substrate requires an exact controlled read and the handoff's target Plan lineage",
          {
            handoffItemRef,
            controlledRead: consumption !== undefined,
            planApplicable,
            exactMechanicalBinding,
          },
        ),
      );
      continue;
    }
    const restricted =
      binding.revalidation_status === "required" ||
      binding.freshness_disposition !== "current" ||
      binding.applicability_disposition !== "applicable";
    if (!restricted) continue;
    restrictedEvidence.add(evidence.path);
    if (typeof evidence.document.evidence_id === "string") {
      restrictedEvidence.add(evidence.document.evidence_id);
    }
    if (
      evidence.document.evidence_role !== "context" ||
      evidence.document.evidence_lifecycle_status === "active"
    ) {
      errors.push(
        issue(
          "research_handoff.evidence_disposition_overstated",
          evidence.path,
          "historical, unknown, partially applicable, or revalidation-required imported substrate may remain context but cannot become active supporting or opposing Evidence",
          { substrateRef: mechanical.substrate_record_ref },
        ),
      );
    }
  }
  const decisiveKeys = new Set([
    "decisive_evidence_refs",
    "decisive_opposing_refs",
    "decisive_supporting_refs",
  ]);
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) visit(item, `${path}/${index}`);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (decisiveKeys.has(key) && strings(child).some((ref) => restrictedEvidence.has(ref))) {
        errors.push(
          issue(
            "research_handoff.evidence_revalidation_required",
            `${path}/${key}`,
            "restricted inherited substrate cannot enter decisive support or opposition until new current-Run Evidence revalidates it",
          ),
        );
      }
      visit(child, `${path}/${key}`);
    }
  };
  for (const document of documents) {
    visit(document.document, document.path);
    if (
      [
        "startup_opportunity.claim.assessment.current",
        "startup_opportunity.claim.discovery_candidate.current",
        "startup_opportunity.claim.discovery_evaluation.current",
      ].includes(document.schemaVersion) &&
      strings(document.document.evidence_refs).some((ref) => restrictedEvidence.has(ref))
    ) {
      errors.push(
        issue(
          "research_handoff.evidence_revalidation_required",
          `${document.path}#/evidence_refs`,
          "restricted inherited substrate cannot support or oppose a formal Claim until new current-Run Evidence revalidates it",
        ),
      );
    }
  }
  return errors;
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
  errors.push(...restrictedEvidenceUseIssues(documents, exactRecords));
  return errors;
}

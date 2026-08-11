export type DecisionSubjectKind =
  | "discovery_candidate"
  | "opportunity_thesis"
  | "concept_hypothesis";

export interface SubjectRevisionDescriptor {
  readonly subjectId: unknown;
  readonly revision: number;
  readonly parentRef: unknown;
  readonly parentContentHash: unknown;
  readonly semantics: Readonly<Record<string, unknown>>;
  readonly closureRefs: ReadonlySet<string>;
  readonly expectedPath: string | null;
}

const CONCEPT_SEMANTIC_FIELDS = [
  "product_thesis",
  "target_user",
  "buyer",
  "entry_scene",
  "claimed_value",
  "current_alternative",
  "delivery_form",
  "business_model",
  "acquisition_hypothesis",
  "uses_ai",
  "assumptions",
  "unknowns",
  "kill_criteria",
] as const;

const OPPORTUNITY_SEMANTIC_FIELDS = [
  "title",
  "description",
  "opportunity_thesis",
  "discovery_profile",
  "research_axes",
  "selected_delivery_form",
  "incremental_value_over_baseline",
  "mental_positioning",
  "mental_position_occupation",
  "trigger_phrase",
  "entry_scene",
  "job_to_be_done",
  "buyer",
  "payer",
  "decision_maker",
  "buyer_purchase_language",
  "marketing_bridge",
  "beachhead_segment",
  "entry_wedge",
  "why_now",
  "initial_distribution_channels",
  "value_layer",
  "user_state_context_model",
  "risks",
  "kill_criteria",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function bindingRefs(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) =>
        isRecord(entry) && typeof entry.ref === "string" ? [entry.ref] : [],
      )
    : [];
}

function selectedFields(
  document: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, document[field]]));
}

export function subjectSchemaAllowed(kind: DecisionSubjectKind, schemaVersion: string): boolean {
  if (kind === "discovery_candidate") {
    return schemaVersion === "startup_opportunity.discovery_candidate.v1";
  }
  if (kind === "opportunity_thesis") {
    return schemaVersion === "startup_opportunity.opportunity_thesis.v1";
  }
  return [
    "startup_opportunity.concept_hypothesis.assessment.current",
    "startup_opportunity.concept_hypothesis.assessment_intake.current",
  ].includes(schemaVersion);
}

export function subjectRevisionDescriptor(
  kind: DecisionSubjectKind,
  document: Record<string, unknown>,
): SubjectRevisionDescriptor {
  if (kind === "discovery_candidate") {
    const formation = isRecord(document.formation) ? document.formation : {};
    const evidenceLineage = isRecord(document.evidence_lineage) ? document.evidence_lineage : {};
    const enrichment = isRecord(document.enrichment) ? document.enrichment : {};
    return {
      subjectId: document.candidate_id,
      revision: Number(document.revision),
      parentRef: document.parent_candidate_ref,
      parentContentHash: document.parent_content_hash,
      semantics: isRecord(document.subject) ? document.subject : {},
      closureRefs: new Set([
        ...bindingRefs(formation.synthesis_input_hashes),
        ...Object.values(evidenceLineage).flatMap(strings),
        ...strings(enrichment.basis_refs),
      ]),
      expectedPath:
        typeof document.candidate_id === "string" && Number.isInteger(Number(document.revision))
          ? `artifacts/discovery/candidates/${document.candidate_id}.r${String(document.revision)}.json`
          : null,
    };
  }
  if (kind === "opportunity_thesis") {
    const mentalPosition = isRecord(document.mental_position_occupation)
      ? document.mental_position_occupation
      : {};
    return {
      subjectId: document.opportunity_id,
      revision: Number(document.revision),
      parentRef: document.parent_opportunity_ref,
      parentContentHash: document.parent_content_hash,
      semantics: selectedFields(document, OPPORTUNITY_SEMANTIC_FIELDS),
      closureRefs: new Set([
        ...strings([
          document.scope_frame_ref,
          document.research_plan_ref,
          document.discovery_fan_in_ref,
          document.demand_thesis_ref,
          document.selected_solution_ref,
          document.baseline_option_ref,
          document.solution_evaluation_ref,
        ]),
        ...strings(document.alternative_solution_refs),
        ...strings(document.source_lanes),
        ...strings(document.supporting_insight_refs),
        ...strings(document.opposing_claim_refs),
        ...strings(document.judgment_assessment_refs),
        ...strings(document.audit_refs),
        ...strings(mentalPosition.evidence_refs),
      ]),
      expectedPath:
        typeof document.opportunity_id === "string" && Number.isInteger(Number(document.revision))
          ? `artifacts/discovery/opportunities/${document.opportunity_id}.r${String(document.revision)}.json`
          : null,
    };
  }
  const fieldProvenance = Array.isArray(document.field_provenance)
    ? document.field_provenance.filter(isRecord)
    : [];
  const revision = document.revision === undefined ? 1 : Number(document.revision);
  return {
    subjectId: document.concept_hypothesis_id,
    revision,
    parentRef: document.parent_concept_ref ?? null,
    parentContentHash: document.parent_content_hash ?? null,
    semantics: selectedFields(document, CONCEPT_SEMANTIC_FIELDS),
    closureRefs: new Set([
      ...bindingRefs(document.formation_input_hashes),
      ...fieldProvenance.flatMap((entry) => strings(entry.basis_refs)),
    ]),
    expectedPath:
      revision > 1 && typeof document.concept_hypothesis_id === "string"
        ? `artifacts/assessment/concepts/${document.concept_hypothesis_id}.r${revision}.json`
        : null,
  };
}

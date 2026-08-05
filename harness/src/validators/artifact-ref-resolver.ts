export interface FragmentTarget {
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DIRECT_FRAGMENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "startup_opportunity.adaptation_decision.discovery.current": ["adaptation_id"],
  "startup_opportunity.adaptation_decision.assessment.current": ["adaptation_id"],
  "startup_opportunity.ai_trigger_source_attestation.v1": ["attestation_id"],
  "startup_opportunity.checkpoint.v1": ["checkpoint_id"],
  "startup_opportunity.coverage_attestation.v1": ["coverage_key"],
  "startup_opportunity.decision.v1": ["decision_id"],
  "startup_opportunity.event.v1": ["event_id"],
  "startup_opportunity.gap_snapshot.discovery.plan.current": ["snapshot_id"],
  "startup_opportunity.gap_snapshot.assessment.current": ["snapshot_id"],
  "startup_opportunity.gap_snapshot.discovery.readiness.current": ["snapshot_id"],
  "startup_opportunity.planning_context.general.current": ["context_id"],
  "startup_opportunity.planning_context.ai_source_bound.current": ["context_id"],
  "startup_opportunity.research_plan.v1": ["plan_id"],
};

function nestedIdExists(
  document: Record<string, unknown>,
  collection: string,
  field: string,
  fragment: string,
): boolean {
  const values = document[collection];
  return Array.isArray(values)
    ? values.some((value) => isRecord(value) && value[field] === fragment)
    : false;
}

function planFragmentExists(
  document: Record<string, unknown>,
  fragment: string,
  expectedIdField?: string,
): boolean {
  if (
    (expectedIdField === undefined || expectedIdField === "question_id") &&
    nestedIdExists(document, "research_questions", "question_id", fragment)
  ) {
    return true;
  }
  const waves = document.waves;
  if (!Array.isArray(waves)) {
    return false;
  }
  return waves.some((wave) => {
    if (!isRecord(wave)) {
      return false;
    }
    if (
      (expectedIdField === undefined || expectedIdField === "wave_id") &&
      wave.wave_id === fragment
    ) {
      return true;
    }
    return (
      (expectedIdField === undefined || expectedIdField === "unit_id") &&
      Array.isArray(wave.units) &&
      wave.units.some((unit) => isRecord(unit) && unit.unit_id === fragment)
    );
  });
}

export function formalArtifactFragmentExists(
  target: FragmentTarget,
  fragment: string,
  expectedIdField?: string,
): boolean {
  if (expectedIdField !== undefined && target.document[expectedIdField] === fragment) {
    return true;
  }
  if (
    expectedIdField === undefined &&
    (DIRECT_FRAGMENT_FIELDS[target.schemaVersion] ?? []).some(
      (field) => target.document[field] === fragment,
    )
  ) {
    return true;
  }
  if (
    target.schemaVersion === "startup_opportunity.gap_snapshot.discovery.plan.current" ||
    target.schemaVersion === "startup_opportunity.gap_snapshot.assessment.current" ||
    target.schemaVersion === "startup_opportunity.gap_snapshot.discovery.readiness.current"
  ) {
    return (
      (expectedIdField === undefined || expectedIdField === "gap_id") &&
      nestedIdExists(target.document, "gaps", "gap_id", fragment)
    );
  }
  if (
    target.schemaVersion === "startup_opportunity.dispatch_batch.discovery.current" ||
    target.schemaVersion === "startup_opportunity.dispatch_batch.assessment.current"
  ) {
    return (
      (expectedIdField === undefined || expectedIdField === "task_id") &&
      nestedIdExists(target.document, "tasks", "task_id", fragment)
    );
  }
  if (target.schemaVersion === "startup_opportunity.research_plan.v1") {
    return planFragmentExists(target.document, fragment, expectedIdField);
  }
  return false;
}

export function storedArtifactFragmentExists(value: unknown, fragment: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const document = isRecord(value.document) ? value.document : value;
  const schemaVersion = isRecord(value.document)
    ? String(value.artifact_type ?? "")
    : String(value.schema_version ?? "");
  return formalArtifactFragmentExists({ schemaVersion, document }, fragment);
}

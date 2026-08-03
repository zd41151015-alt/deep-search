import type { DocumentBundleEntry } from "../validators/artifact-validator.js";

export interface EffectiveDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

export interface UnitEntry {
  readonly waveId: string;
  readonly waveDependsOn: readonly string[];
  readonly unit: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function effectiveDocuments(value: unknown): readonly EffectiveDocument[] {
  if (!isRecord(value) || !Array.isArray(value.documents)) {
    return [];
  }
  return value.documents.flatMap<EffectiveDocument>((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || !isRecord(entry.document)) {
      return [];
    }
    const schemaVersion = entry.document.schema_version;
    if (
      schemaVersion === "startup_opportunity.artifact_envelope.current" &&
      typeof entry.document.artifact_type === "string" &&
      isRecord(entry.document.document)
    ) {
      return [
        {
          path: entry.path,
          schemaVersion: entry.document.artifact_type,
          document: entry.document.document,
          envelope: entry.document,
        },
      ];
    }
    return [
      {
        path: entry.path,
        schemaVersion: typeof schemaVersion === "string" ? schemaVersion : "",
        document: entry.document,
        envelope: null,
      },
    ];
  });
}

export function documentMap(value: unknown): ReadonlyMap<string, EffectiveDocument> {
  return new Map(effectiveDocuments(value).map((document) => [document.path, document]));
}

export function leafPlanningContexts(value: unknown): readonly EffectiveDocument[] {
  const contexts = effectiveDocuments(value).filter(
    (document) => document.schemaVersion === "startup_opportunity.planning_context.v2",
  );
  const referencedParents = new Set(
    contexts.flatMap((context) =>
      typeof context.document.parent_context_ref === "string"
        ? [context.document.parent_context_ref]
        : [],
    ),
  );
  return contexts
    .filter((context) => !referencedParents.has(context.path))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function unitEntries(plan: Record<string, unknown>): readonly UnitEntry[] {
  if (!Array.isArray(plan.waves)) {
    return [];
  }
  return plan.waves.flatMap((wave) => {
    if (!isRecord(wave) || typeof wave.wave_id !== "string" || !Array.isArray(wave.units)) {
      return [];
    }
    const waveDependsOn = Array.isArray(wave.depends_on)
      ? wave.depends_on.filter((dependency): dependency is string => typeof dependency === "string")
      : [];
    return wave.units
      .filter((unit): unit is Record<string, unknown> => isRecord(unit))
      .map((unit) => ({ waveId: wave.wave_id as string, waveDependsOn, unit }));
  });
}

export function unitById(plan: Record<string, unknown>, unitId: string): UnitEntry | undefined {
  return unitEntries(plan).find((entry) => entry.unit.unit_id === unitId);
}

export function targetByRef(
  documents: ReadonlyMap<string, EffectiveDocument>,
  ref: unknown,
): EffectiveDocument | null {
  if (typeof ref !== "string") {
    return null;
  }
  return documents.get(ref.split("#", 1)[0] ?? "") ?? null;
}

export function fragmentOf(ref: unknown): string | null {
  if (typeof ref !== "string") {
    return null;
  }
  return ref.split("#", 2)[1] ?? null;
}

export function statusOfUnit(manifest: Record<string, unknown>, unitId: string): string {
  for (const [field, state] of [
    ["completed_units", "completed"],
    ["active_units", "active"],
    ["failed_units", "failed"],
    ["invalidated_units", "invalidated"],
    ["skipped_units", "skipped"],
    ["cancelled_units", "cancelled"],
    ["superseded_units", "superseded"],
  ] as const) {
    if (Array.isArray(manifest[field]) && manifest[field].includes(unitId)) {
      return state;
    }
  }
  return "pending";
}

export function rawBundleEntries(value: unknown): readonly DocumentBundleEntry[] {
  if (!isRecord(value) || !Array.isArray(value.documents)) {
    return [];
  }
  return value.documents.filter(
    (entry): entry is DocumentBundleEntry =>
      isRecord(entry) && typeof entry.path === "string" && isRecord(entry.document),
  );
}

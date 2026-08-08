function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedSourceIdentity(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim().toLowerCase();
  try {
    const url = new URL(trimmed);
    return url.hostname.replace(/^www\./u, "");
  } catch {
    return trimmed.replace(/\s+/gu, " ");
  }
}

function sourceGroupIdentities(
  source: Readonly<Record<string, unknown>>,
  evidenceDocument: Readonly<Record<string, unknown>> = {},
): readonly string[] {
  const assessment = isRecord(evidenceDocument.source_assessment)
    ? evidenceDocument.source_assessment
    : {};
  const sharedDataset = normalizedSourceIdentity(assessment.shared_dataset_group);
  const syndication = normalizedSourceIdentity(assessment.syndication_group);
  const canonical = normalizedSourceIdentity(assessment.canonical_source_group);
  const profile = isRecord(source.source_profile) ? source.source_profile : {};
  const profiled =
    profile.type === "news"
      ? normalizedSourceIdentity(profile.publisher)
      : profile.type === "review"
        ? normalizedSourceIdentity(profile.platform)
        : profile.type === "api_dataset"
          ? normalizedSourceIdentity(profile.raw_provenance)
          : null;
  const sourceName = normalizedSourceIdentity(evidenceDocument.source_name);
  const provider = canonical ?? profiled ?? sourceName;
  const groups = [
    ...(sharedDataset === null ? [] : [`dataset:${sharedDataset}`]),
    ...(syndication === null ? [] : [`syndication:${syndication}`]),
    ...(provider === null ? [] : [`provider:${provider}`]),
  ];
  return groups.length > 0 ? groups : [`evidence:${String(source.evidence_ref ?? "unknown")}`];
}

export function canonicalSourceGroup(
  source: Readonly<Record<string, unknown>>,
  evidenceDocument: Readonly<Record<string, unknown>> = {},
): string {
  return sourceGroupIdentities(source, evidenceDocument)[0] as string;
}

export function deriveSourceConcentration(
  adopted: readonly Record<string, unknown>[],
  evidenceDocuments: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): {
  readonly concentrated: boolean;
  readonly dominantGroupCount: number;
  readonly dominantGroup: string | null;
} {
  const sourceGroups = adopted.map((source) =>
    sourceGroupIdentities(source, evidenceDocuments.get(String(source.evidence_ref)) ?? {}),
  );
  const groups = [...new Set(sourceGroups.flat())];
  const counts = groups.map((group) => ({
    group,
    count: sourceGroups.filter((candidate) => candidate.includes(group)).length,
  }));
  const dominant = counts.toSorted(
    (left, right) => right.count - left.count || left.group.localeCompare(right.group),
  )[0];
  return {
    concentrated: adopted.length >= 2 && (dominant?.count ?? 0) / adopted.length >= 0.75,
    dominantGroupCount: dominant?.count ?? 0,
    dominantGroup: dominant?.group ?? null,
  };
}

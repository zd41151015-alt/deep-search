import { isFormalEvidenceSchemaVersion } from "./report-projection-authority.js";

export type ReportCitation =
  | {
      readonly evidence_ref: string;
      readonly label: string;
      readonly source_access: "public";
      readonly url: string;
    }
  | {
      readonly evidence_ref: string;
      readonly label: string;
      readonly source_access: "user_provided_non_public";
      readonly canonical_uri: string;
    };

const MECHANICAL_REPORT_FIELDS = new Set([
  "report_citations",
  "report_statistics",
  "report_subject_labels",
  "report_metadata",
  "full_commercial_projection",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function reportEvidenceRefs(
  value: unknown,
  formalEvidencePaths: ReadonlySet<string>,
): readonly string[] {
  const refs = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      if (formalEvidencePaths.has(current)) refs.add(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, child] of Object.entries(current)) {
      if (!MECHANICAL_REPORT_FIELDS.has(key)) visit(child);
    }
  };
  visit(value);
  return [...refs].sort();
}

export function deriveReportCitations(
  formalDocuments: readonly {
    readonly path: string;
    readonly document: Readonly<Record<string, unknown>>;
  }[],
  exactRecords: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  finalReportModel: unknown,
): readonly ReportCitation[] {
  const evidenceDocuments = formalDocuments.filter((entry) =>
    isFormalEvidenceSchemaVersion(entry.document.schema_version),
  );
  const referenced = new Set(
    reportEvidenceRefs(finalReportModel, new Set(evidenceDocuments.map((entry) => entry.path))),
  );
  const citations: ReportCitation[] = [];
  for (const entry of evidenceDocuments) {
    if (!referenced.has(entry.path)) continue;
    const binding = isRecord(entry.document.mechanical_binding)
      ? entry.document.mechanical_binding
      : {};
    const record =
      typeof binding.substrate_record_ref === "string"
        ? exactRecords.get(binding.substrate_record_ref)
        : undefined;
    const source = isRecord(record?.source) ? record.source : {};
    const label =
      typeof entry.document.source_name === "string"
        ? entry.document.source_name
        : source.kind === "public_url"
          ? String(source.canonical_url)
          : "User-provided source";
    if (source.kind === "public_url" && typeof source.canonical_url === "string") {
      citations.push({
        evidence_ref: entry.path,
        label,
        source_access: "public",
        url: source.canonical_url,
      });
      continue;
    }
    if (source.kind === "user_provided" && typeof source.canonical_uri === "string") {
      citations.push({
        evidence_ref: entry.path,
        label,
        source_access: "user_provided_non_public",
        canonical_uri: source.canonical_uri,
      });
    }
  }
  return citations.sort((left, right) => left.evidence_ref.localeCompare(right.evidence_ref));
}

export function canonicalizeReadableSources(
  sources: readonly Readonly<Record<string, unknown>>[],
  citations: readonly ReportCitation[],
): {
  readonly sources: readonly Record<string, unknown>[];
  readonly missingEvidenceRefs: readonly string[];
} {
  const citationsByRef = new Map(citations.map((citation) => [citation.evidence_ref, citation]));
  const missingEvidenceRefs: string[] = [];
  const canonicalSources = sources.map((source) => {
    const evidenceRef = String(source.evidence_ref);
    const citation = citationsByRef.get(evidenceRef);
    if (citation === undefined) {
      missingEvidenceRefs.push(evidenceRef);
      return { ...source };
    }
    const canonical = { ...source };
    delete canonical.url;
    delete canonical.canonical_uri;
    delete canonical.source_access;
    return citation.source_access === "public"
      ? {
          ...canonical,
          title: citation.label,
          source_access: citation.source_access,
          url: citation.url,
        }
      : {
          ...canonical,
          title: citation.label,
          source_access: citation.source_access,
          canonical_uri: citation.canonical_uri,
        };
  });
  return {
    sources: canonicalSources,
    missingEvidenceRefs: [...new Set(missingEvidenceRefs)].sort(),
  };
}

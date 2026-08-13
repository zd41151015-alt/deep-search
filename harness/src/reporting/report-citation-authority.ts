export interface ReportCitation {
  readonly evidence_ref: string;
  readonly label: string;
  readonly url: string;
}

const FORMAL_EVIDENCE_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.evidence.assessment.current",
  "startup_opportunity.evidence.discovery_candidate.current",
  "startup_opportunity.evidence.discovery_evaluation.current",
  "startup_opportunity.assessment_evidence.v1",
  "startup_opportunity.candidate_neutral_evidence.v1",
]);

const MECHANICAL_REPORT_FIELDS = new Set([
  "report_citations",
  "report_statistics",
  "report_subject_labels",
  "report_metadata",
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
    FORMAL_EVIDENCE_SCHEMA_VERSIONS.has(String(entry.document.schema_version)),
  );
  const referenced = new Set(
    reportEvidenceRefs(finalReportModel, new Set(evidenceDocuments.map((entry) => entry.path))),
  );
  return evidenceDocuments
    .flatMap((entry) => {
      if (!referenced.has(entry.path)) return [];
      const binding = isRecord(entry.document.mechanical_binding)
        ? entry.document.mechanical_binding
        : {};
      const record =
        typeof binding.substrate_record_ref === "string"
          ? exactRecords.get(binding.substrate_record_ref)
          : undefined;
      const source = isRecord(record?.source) ? record.source : {};
      const canonicalSource =
        source.kind === "public_url" && typeof source.canonical_url === "string"
          ? source.canonical_url
          : null;
      if (canonicalSource === null) return [];
      return [
        {
          evidence_ref: entry.path,
          label:
            typeof entry.document.source_name === "string"
              ? entry.document.source_name
              : canonicalSource,
          url: canonicalSource,
        },
      ];
    })
    .sort((left, right) => left.evidence_ref.localeCompare(right.evidence_ref));
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
    return {
      ...source,
      title: citation.label,
      url: citation.url,
    };
  });
  return {
    sources: canonicalSources,
    missingEvidenceRefs: [...new Set(missingEvidenceRefs)].sort(),
  };
}

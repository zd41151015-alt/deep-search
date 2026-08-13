import type { FormalArtifactEnvelope } from "../artifact-store/artifact-store.js";
import { canonicalContentHash } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";

const FORMAL_EVIDENCE_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.evidence.assessment.current",
  "startup_opportunity.evidence.discovery_candidate.current",
  "startup_opportunity.evidence.discovery_evaluation.current",
  "startup_opportunity.assessment_evidence.v1",
  "startup_opportunity.candidate_neutral_evidence.v1",
]);

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

function authorityBinding(
  ref: string,
  envelopesByPath: ReadonlyMap<string, FormalArtifactEnvelope>,
): Record<string, unknown> {
  const envelope = envelopesByPath.get(ref);
  if (envelope === undefined) {
    throw new StoreError(
      "report.evidence_disposition_authority_missing",
      "report Evidence disposition authority must resolve to an exact current-Run Artifact",
      { ref },
    );
  }
  return { ref, content_hash: envelope.content_hash };
}

function evidenceBinding(
  ref: string,
  envelopesByPath: ReadonlyMap<string, FormalArtifactEnvelope>,
): Record<string, unknown> {
  const envelope = envelopesByPath.get(ref);
  if (
    envelope === undefined ||
    !FORMAL_EVIDENCE_SCHEMA_VERSIONS.has(String(envelope.document.schema_version))
  ) {
    throw new StoreError(
      "report.evidence_disposition_authority_missing",
      "report Evidence disposition must target exact typed Evidence",
      { ref },
    );
  }
  return { evidence_ref: ref, evidence_content_hash: envelope.content_hash };
}

export function deriveConfirmedResearchLanguage(
  manifest: Readonly<Record<string, unknown>>,
  exactRecords: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): string {
  const ref = manifest.scope_confirmation_ref;
  const expectedHash = manifest.scope_confirmation_hash;
  const confirmation = typeof ref === "string" ? exactRecords.get(ref) : undefined;
  const scope = isRecord(confirmation?.scope) ? confirmation.scope : {};
  if (
    confirmation === undefined ||
    typeof expectedHash !== "string" ||
    canonicalContentHash(confirmation) !== expectedHash ||
    confirmation.run_id !== manifest.run_id ||
    typeof scope.research_language !== "string"
  ) {
    throw new StoreError(
      "report.research_language_authority_invalid",
      "report language must resolve from the exact Manifest-bound confirmed Scope",
      { scopeConfirmationRef: ref },
    );
  }
  return scope.research_language;
}

function subjectIdFromDocument(ref: string, document: Readonly<Record<string, unknown>>): string {
  for (const field of [
    "subject_id",
    "opportunity_id",
    "direction_id",
    "candidate_id",
    "concept_hypothesis_id",
    "hypothesis_id",
  ]) {
    if (typeof document[field] === "string") return document[field];
  }
  throw new StoreError(
    "report.subject_authority_invalid",
    "a final report subject ref must resolve to a typed subject identity",
    { ref },
  );
}

export interface ReportSubjectAuthority {
  readonly subjectId: string;
  readonly subjectRef: string;
  readonly subjectContentHash: string;
}

function subjectAuthority(
  ref: string,
  envelopesByPath: ReadonlyMap<string, FormalArtifactEnvelope>,
): ReportSubjectAuthority {
  const envelope = envelopesByPath.get(ref);
  if (envelope === undefined) {
    throw new StoreError(
      "report.subject_authority_invalid",
      "a final report subject ref must resolve to an exact current-Run Artifact",
      { ref },
    );
  }
  return {
    subjectId: subjectIdFromDocument(ref, envelope.document),
    subjectRef: ref,
    subjectContentHash: envelope.content_hash,
  };
}

function uniqueSubjectAuthorities(
  authorities: readonly ReportSubjectAuthority[],
): readonly ReportSubjectAuthority[] {
  const byId = new Map<string, ReportSubjectAuthority>();
  for (const authority of authorities) {
    const existing = byId.get(authority.subjectId);
    if (
      existing !== undefined &&
      (existing.subjectRef !== authority.subjectRef ||
        existing.subjectContentHash !== authority.subjectContentHash)
    ) {
      throw new StoreError(
        "report.subject_authority_conflict",
        "one final subject identity cannot resolve to multiple immutable subject revisions",
        {
          subjectId: authority.subjectId,
          refs: [existing.subjectRef, authority.subjectRef].sort(),
        },
      );
    }
    byId.set(authority.subjectId, authority);
  }
  return [...byId.values()].sort((left, right) => left.subjectId.localeCompare(right.subjectId));
}

function reportSubjectLabel(document: Record<string, unknown>, fallback: string): string {
  if (typeof document.title === "string") return document.title;
  if (typeof document.product_thesis === "string") return document.product_thesis;
  const subject = isRecord(document.subject) ? document.subject : {};
  if (typeof subject.summary === "string") return subject.summary;
  if (typeof document.description === "string") return document.description;
  return fallback;
}

export function deriveReportSubjectLabels(
  authorities: readonly ReportSubjectAuthority[],
  envelopesByPath: ReadonlyMap<string, FormalArtifactEnvelope>,
  researchLanguage = "en-US",
): readonly Record<string, unknown>[] {
  const fallback = (index: number): string =>
    researchLanguage.toLowerCase().startsWith("zh")
      ? `当前研究对象 ${index + 1}`
      : `Current research subject ${index + 1}`;
  return uniqueSubjectAuthorities(authorities).map((authority, index) => {
    const envelope = envelopesByPath.get(authority.subjectRef);
    if (
      envelope === undefined ||
      envelope.content_hash !== authority.subjectContentHash ||
      subjectIdFromDocument(authority.subjectRef, envelope.document) !== authority.subjectId
    ) {
      throw new StoreError(
        "report.subject_authority_invalid",
        "a final report subject label must resolve from its exact immutable subject revision",
        { authority },
      );
    }
    return {
      subject_id: authority.subjectId,
      subject_ref: authority.subjectRef,
      subject_content_hash: authority.subjectContentHash,
      label: reportSubjectLabel(envelope.document, fallback(index)),
    };
  });
}

export function deriveNonTerminalReportSubjectAuthorities(
  artifactType: string,
  source: Readonly<Record<string, unknown>>,
  envelopesByPath: ReadonlyMap<string, FormalArtifactEnvelope>,
): readonly ReportSubjectAuthority[] {
  const documentsByPath = new Map(
    [...envelopesByPath].map(([path, envelope]) => [path, envelope.document]),
  );
  return uniqueSubjectAuthorities(
    nonTerminalSubjectRefs(artifactType, source, documentsByPath).map((ref) =>
      subjectAuthority(ref, envelopesByPath),
    ),
  );
}

function nonTerminalSubjectRefs(
  artifactType: string,
  source: Readonly<Record<string, unknown>>,
  documentsByPath: ReadonlyMap<string, Record<string, unknown>>,
): readonly string[] {
  if (artifactType === "startup_opportunity.concept_evidence_report.v1") {
    return typeof source.concept_hypothesis_ref === "string" ? [source.concept_hypothesis_ref] : [];
  }
  const recommendation =
    typeof source.decision_recommendation_ref === "string"
      ? documentsByPath.get(source.decision_recommendation_ref)
      : undefined;
  const portfolio =
    typeof source.portfolio_view_ref === "string"
      ? documentsByPath.get(source.portfolio_view_ref)
      : undefined;
  if (
    recommendation?.schema_version !== "startup_opportunity.decision_recommendation.v1" ||
    portfolio?.schema_version !== "startup_opportunity.portfolio_view.v1"
  ) {
    throw new StoreError(
      "report.subject_authority_invalid",
      "Discovery final report subjects require exact Decision Recommendation and Portfolio authorities",
      {
        decisionRecommendationRef: source.decision_recommendation_ref,
        portfolioViewRef: source.portfolio_view_ref,
      },
    );
  }
  const refs = [
    ...strings(source.top_opportunity_refs),
    ...(typeof recommendation.recommended_first_bet === "string"
      ? [recommendation.recommended_first_bet]
      : []),
    ...strings(recommendation.alternative_bets),
    ...(typeof portfolio.recommended_first_bet === "string"
      ? [portfolio.recommended_first_bet]
      : []),
    ...strings(portfolio.alternative_bets),
  ];
  return refs;
}

export function deriveNonTerminalReportSubjectIds(
  artifactType: string,
  source: Readonly<Record<string, unknown>>,
  documentsByPath: ReadonlyMap<string, Record<string, unknown>>,
): readonly string[] {
  return [
    ...new Set(
      nonTerminalSubjectRefs(artifactType, source, documentsByPath).map((ref) => {
        const document = documentsByPath.get(ref);
        if (document === undefined) {
          throw new StoreError("report.subject_authority_invalid", "final subject ref is missing", {
            ref,
          });
        }
        return subjectIdFromDocument(ref, document);
      }),
    ),
  ].sort();
}

export function deriveTerminalReportSubjectAuthorities(
  source: Readonly<Record<string, unknown>>,
  envelopesByPath: ReadonlyMap<string, FormalArtifactEnvelope>,
): readonly ReportSubjectAuthority[] {
  const authorities = records(source.decision_subject_synthesis_hashes).map((binding) => {
    const synthesisRef = String(binding.ref);
    const synthesis = envelopesByPath.get(synthesisRef);
    if (
      synthesis?.artifact_type !== "startup_opportunity.decision_subject_synthesis.current" ||
      synthesis.content_hash !== binding.content_hash ||
      typeof synthesis.document.subject_ref !== "string" ||
      typeof synthesis.document.subject_content_hash !== "string"
    ) {
      throw new StoreError(
        "report.subject_authority_invalid",
        "terminal report subject authority requires an exact Decision Subject Synthesis",
        { binding },
      );
    }
    const authority = subjectAuthority(synthesis.document.subject_ref, envelopesByPath);
    if (
      authority.subjectId !== synthesis.document.subject_id ||
      authority.subjectContentHash !== synthesis.document.subject_content_hash
    ) {
      throw new StoreError(
        "report.subject_authority_invalid",
        "terminal subject synthesis must bind the exact final subject revision",
        { synthesisRef, authority },
      );
    }
    return authority;
  });
  return uniqueSubjectAuthorities(authorities);
}

function exactReasons(
  values: readonly string[],
  fallback: string,
  requireAuthoredReason: boolean,
  details: Readonly<Record<string, unknown>>,
): readonly string[] {
  const reasons = [...new Set(values.filter((value) => value.trim().length > 0))].sort();
  if (requireAuthoredReason && reasons.length === 0) {
    throw new StoreError(
      "report.evidence_disposition_reason_missing",
      "a limited or excluded source requires a specific reason from its formal audit authority",
      details,
    );
  }
  return reasons.length > 0 ? reasons : [fallback];
}

export interface ReportDispositionProjection {
  readonly reportEvidenceDispositions: readonly Record<string, unknown>[];
  readonly reportSourceDispositions: readonly Record<string, unknown>[];
}

export function deriveReportDispositions(
  artifactType: string,
  source: Readonly<Record<string, unknown>>,
  envelopesByPath: ReadonlyMap<string, FormalArtifactEnvelope>,
): ReportDispositionProjection {
  if (artifactType === "startup_opportunity.terminal_report_source.v1") {
    const included = new Set(records(source.sources).map((entry) => String(entry.evidence_ref)));
    const excluded = new Map(
      records(source.excluded_evidence).map((entry) => [
        String(entry.evidence_ref),
        String(entry.reason),
      ]),
    );
    const formalEvidence = [...envelopesByPath.values()]
      .filter((entry) => FORMAL_EVIDENCE_SCHEMA_VERSIONS.has(String(entry.document.schema_version)))
      .sort((left, right) => left.artifact_path.localeCompare(right.artifact_path));
    const dispositions = formalEvidence.map((entry) => {
      const isIncluded = included.has(entry.artifact_path);
      const reason = excluded.get(entry.artifact_path);
      if (isIncluded === (reason !== undefined)) {
        throw new StoreError(
          "report.evidence_disposition_incomplete",
          "every terminal Evidence item must be included or excluded exactly once",
          { evidenceRef: entry.artifact_path },
        );
      }
      return {
        ...evidenceBinding(entry.artifact_path, envelopesByPath),
        disposition: isIncluded ? "included" : "excluded",
        reasons: isIncluded
          ? ["Included in the terminal report source projection."]
          : exactReasons([reason ?? ""], "", true, { evidenceRef: entry.artifact_path }),
        authority_bindings: [],
      };
    });
    return { reportEvidenceDispositions: dispositions, reportSourceDispositions: [] };
  }

  if (artifactType === "startup_opportunity.concept_evidence_report.v1") {
    const auditRef = String(source.evidence_audit_ref);
    const traceabilityRef = String(source.traceability_ref);
    const audit = envelopesByPath.get(auditRef)?.document;
    const traceability = envelopesByPath.get(traceabilityRef)?.document;
    if (audit?.schema_version !== "startup_opportunity.evidence_audit.v1") {
      throw new StoreError(
        "report.evidence_disposition_authority_missing",
        "Assessment report Evidence dispositions require its exact Evidence Audit",
        { auditRef },
      );
    }
    const tracedEvidence = new Set(
      records(traceability?.chains).map((entry) => String(entry.evidence_ref)),
    );
    const dispositions: Record<string, unknown>[] = records(audit.evidence_reviews)
      .map((review): Record<string, unknown> => {
        const evidenceRef = String(review.evidence_ref);
        const auditStatus = String(review.audit_status);
        const disposition =
          auditStatus === "rejected" || auditStatus === "unavailable"
            ? "excluded"
            : auditStatus === "limited" || !tracedEvidence.has(evidenceRef)
              ? "limited"
              : "included";
        const fallback = tracedEvidence.has(evidenceRef)
          ? "Accepted by the Evidence Audit and used by the report traceability closure."
          : "Accepted research material was retained outside the report traceability closure.";
        return {
          ...evidenceBinding(evidenceRef, envelopesByPath),
          disposition,
          reasons: exactReasons(
            strings(review.limitations),
            fallback,
            disposition !== "included" && auditStatus !== "accepted",
            { evidenceRef, auditRef },
          ),
          authority_bindings: [
            authorityBinding(auditRef, envelopesByPath),
            authorityBinding(traceabilityRef, envelopesByPath),
          ],
        };
      })
      .sort((left, right) => String(left.evidence_ref).localeCompare(String(right.evidence_ref)));
    const sourceDispositions = strings(source.source_manifest_refs).flatMap((manifestRef) => {
      const manifest = envelopesByPath.get(manifestRef)?.document;
      if (manifest?.schema_version !== "startup_opportunity.source_manifest.assessment.current") {
        return [];
      }
      const binding = authorityBinding(manifestRef, envelopesByPath);
      return [
        ...records(manifest.rejected_source_records).map((entry) => ({
          source: entry.source,
          disposition: "excluded",
          reasons: [String(entry.rejection_reason), String(entry.notes)],
          authority_bindings: [binding],
        })),
        ...records(manifest.unavailable_source_records).map((entry) => ({
          source: entry.source,
          disposition: "unavailable",
          reasons: [String(entry.unavailable_reason), String(entry.notes)],
          authority_bindings: [binding],
        })),
      ];
    });
    return {
      reportEvidenceDispositions: dispositions,
      reportSourceDispositions: sourceDispositions,
    };
  }

  const traceabilityRef = String(source.traceability_ref);
  const traceability = envelopesByPath.get(traceabilityRef)?.document;
  const traced = new Map<string, Record<string, unknown>[]>();
  for (const statement of records(traceability?.statements)) {
    for (const evidenceRef of strings(statement.evidence_refs)) {
      const values = traced.get(evidenceRef) ?? [];
      values.push(statement);
      traced.set(evidenceRef, values);
    }
  }
  const acceptedAuthority = new Map<string, string[]>();
  const sourceDispositions: Record<string, unknown>[] = [];
  for (const manifestRef of strings(source.source_manifest_refs)) {
    const manifest = envelopesByPath.get(manifestRef)?.document;
    if (
      manifest?.schema_version !==
      "startup_opportunity.source_manifest.discovery_evaluation.current"
    ) {
      continue;
    }
    for (const evidenceRef of strings(manifest.accepted_evidence_refs)) {
      const refs = acceptedAuthority.get(evidenceRef) ?? [];
      refs.push(manifestRef);
      acceptedAuthority.set(evidenceRef, refs);
    }
    for (const [field, disposition, reasonField] of [
      ["rejected_source_records", "excluded", "rejection_reason"],
      ["unavailable_source_records", "unavailable", "unavailable_reason"],
    ] as const) {
      for (const entry of records(manifest[field])) {
        sourceDispositions.push({
          source: entry.source,
          source_label: entry.source_label,
          disposition,
          reasons: exactReasons([String(entry[reasonField] ?? "")], "", true, {
            manifestRef,
            field,
          }),
          ...(typeof entry.notes === "string" ? { notes: entry.notes } : {}),
          authority_bindings: [authorityBinding(manifestRef, envelopesByPath)],
        });
      }
    }
  }
  const dispositions = [...acceptedAuthority]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([evidenceRef, manifestRefs]) => {
      const statements = traced.get(evidenceRef) ?? [];
      const limitations = statements.flatMap((statement) => strings(statement.limitations));
      const staleOrUnknown = statements.some(
        (statement) => statement.freshness_status !== "current",
      );
      const disposition = statements.length === 0 || staleOrUnknown ? "limited" : "included";
      return {
        ...evidenceBinding(evidenceRef, envelopesByPath),
        disposition,
        reasons: exactReasons(
          limitations,
          statements.length === 0
            ? "Accepted Discovery material was retained outside decisive report traceability."
            : staleOrUnknown
              ? "The report traceability records non-current freshness for this material."
              : "Accepted by a Discovery Source Manifest and used by report traceability.",
          false,
          { evidenceRef },
        ),
        authority_bindings: [
          ...manifestRefs.map((ref) => authorityBinding(ref, envelopesByPath)),
          authorityBinding(traceabilityRef, envelopesByPath),
        ],
      };
    });
  return {
    reportEvidenceDispositions: dispositions,
    reportSourceDispositions: sourceDispositions.sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
  };
}

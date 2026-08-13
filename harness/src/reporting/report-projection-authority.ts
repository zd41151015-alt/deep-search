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

function subjectIdFromRef(
  ref: string,
  documentsByPath: ReadonlyMap<string, Record<string, unknown>>,
): string {
  const document = documentsByPath.get(ref) ?? {};
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

function reportSubjectLabel(document: Record<string, unknown>, fallback: string): string {
  if (typeof document.title === "string") return document.title;
  if (typeof document.product_thesis === "string") return document.product_thesis;
  const subject = isRecord(document.subject) ? document.subject : {};
  if (typeof subject.summary === "string") return subject.summary;
  if (typeof document.description === "string") return document.description;
  return fallback;
}

export function deriveReportSubjectLabels(
  subjectIds: readonly string[],
  documentsByPath: ReadonlyMap<string, Record<string, unknown>>,
  synthesizedDirections: readonly Record<string, unknown>[] = [],
  researchLanguage = "en-US",
): readonly Record<string, unknown>[] {
  const fallback = (index: number): string =>
    researchLanguage.toLowerCase().startsWith("zh")
      ? `当前研究对象 ${index + 1}`
      : `Current research subject ${index + 1}`;
  return [...new Set(subjectIds)].sort().map((subjectId, index) => {
    const direction = synthesizedDirections.find((entry) => entry.direction_id === subjectId);
    if (typeof direction?.label === "string") {
      return { subject_id: subjectId, label: direction.label };
    }
    const document = [...documentsByPath.values()].find(
      (entry) =>
        entry.candidate_id === subjectId ||
        entry.opportunity_id === subjectId ||
        entry.concept_hypothesis_id === subjectId,
    );
    return {
      subject_id: subjectId,
      label:
        document === undefined ? fallback(index) : reportSubjectLabel(document, fallback(index)),
    };
  });
}

export function deriveNonTerminalReportSubjectIds(
  artifactType: string,
  source: Readonly<Record<string, unknown>>,
  documentsByPath: ReadonlyMap<string, Record<string, unknown>>,
): readonly string[] {
  if (artifactType === "startup_opportunity.concept_evidence_report.v1") {
    if (typeof source.concept_hypothesis_ref !== "string") return [];
    return [subjectIdFromRef(source.concept_hypothesis_ref, documentsByPath)];
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
  return [...new Set(refs.map((ref) => subjectIdFromRef(ref, documentsByPath)))].sort();
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
    for (const [field, disposition] of [
      ["rejected_sources", "excluded"],
      ["unavailable_sources", "unavailable"],
    ] as const) {
      for (const label of strings(manifest[field])) {
        sourceDispositions.push({
          source_label: label,
          disposition,
          reasons: [label],
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

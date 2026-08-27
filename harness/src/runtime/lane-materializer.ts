import { canonicalContentHash, canonicalJson, operationKey } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import { EvidenceStore, type EvidenceStoreRecord } from "../evidence-store/evidence-store.js";
import { RunStore } from "../run-store/run-store.js";
import {
  type ArtifactValidator,
  artifactRefsForDocument,
  type DocumentBundleEntry,
} from "../validators/artifact-validator.js";
import { summarizeGateDiagnostics } from "../validators/gate-diagnostics.js";
import { gateRegistration } from "../validators/gate-registry.js";
import type { ValidationIssue } from "../validators/schema-bundle.js";
import {
  DeclarativeRuntimeCompiler,
  type RuntimeArtifactCompilationResult,
  type RuntimePublicationPlan,
  runtimePublicationPlansEquivalentForScopedClosure,
} from "./declarative-runtime.js";
import {
  deriveLaneScopeFormalClosure,
  type LaneScopeFormalClosure,
  laneScopeCoverageFromClosure,
} from "./lane-delivery-closure.js";
import { type OperationObserver, operationTrace } from "./operation-observability.js";

interface RequiredArtifact {
  readonly artifact_type: string;
  readonly artifact_path: string;
}

type AgentArtifactFamily =
  | "lane_result"
  | "commercial_audit"
  | "evidence"
  | "finding"
  | "claim"
  | "judgment"
  | "insight"
  | "source_manifest";

interface LaneStagingDocument extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.lane_staging_document.current";
  readonly staging_id: string;
  readonly run_id: string;
  readonly task_ref: string;
  readonly created_at: string;
  readonly producer_role: "lane_researcher" | "adversarial_reviewer";
  readonly operation: "validate_only" | "publish";
  readonly publication_plan?: RuntimePublicationPlan;
  readonly evidence_receipt_refs: readonly string[];
  readonly delivery_contract: {
    readonly search_closure: {
      readonly status:
        | "completed"
        | "partial"
        | "insufficient_evidence"
        | "unavailable"
        | "not_required"
        | "search_not_required"
        | "failed_before_search";
      readonly acquisition_routes_attempted: readonly string[];
      readonly adopted_source_refs?: readonly string[];
      readonly unresolved_gaps: readonly string[];
      readonly stop_reason: string;
    };
  };
  readonly agent_documents: readonly {
    readonly artifact_family: AgentArtifactFamily;
    readonly evidence_receipt_ref?: string;
    readonly document: Record<string, unknown>;
  }[];
}

interface LaneDeliveryIssue {
  readonly code: string;
  readonly artifact: string;
  readonly path: string;
  readonly reference: string | null;
  readonly message: string;
  readonly likely_cause: string;
  readonly affected_objects: readonly string[];
  readonly mechanically_derivable: boolean;
  readonly severity: "error" | "warning" | "info";
  readonly category: "integrity" | "decision_validity" | "coverage" | "format" | "telemetry";
  readonly stages: readonly string[];
}

interface EffectiveAuthority {
  readonly path: string;
  readonly document: Record<string, unknown>;
}

interface LaneDeliveryAuthority {
  readonly runId: string;
  readonly taskRef: string;
  readonly task: Record<string, unknown>;
  readonly taskHash: string;
  readonly taskSchema: string;
  readonly unitId: string;
  readonly planRef: string;
  readonly plan: Record<string, unknown>;
  readonly planHash: string;
  readonly executionRef: string;
  readonly execution: Record<string, unknown>;
  readonly executionHash: string;
  readonly dispatchTaskRef: string;
  readonly dispatch: Record<string, unknown>;
  readonly dispatchHash: string;
  readonly stageId: string;
  readonly executionLane: Record<string, unknown>;
  readonly assignedScope: readonly string[];
  readonly assignedSubjectRefs: readonly string[];
  readonly requiredArtifacts: readonly RequiredArtifact[];
  readonly commercialAuditPath: string | null;
}

interface PreparedAgentArtifact {
  readonly staging_index: number;
  readonly family: AgentArtifactFamily;
  readonly artifact_type: string;
  readonly artifact_path: string;
  readonly producer_role: "lane_researcher" | "adversarial_reviewer";
  readonly input_refs: readonly string[];
  readonly document: Record<string, unknown>;
}

export interface LaneDeliveryResult {
  readonly schema_version: "startup_opportunity.lane_delivery_result.current";
  readonly staging_id: string;
  readonly run_id: string;
  readonly status: "accepted";
  readonly preflight: {
    readonly status: "accepted";
    readonly issues: readonly ValidationIssue[];
    readonly root_causes: readonly [];
    readonly required_artifact_count: number;
    readonly delivered_artifact_count: number;
    readonly scope_count: number;
    readonly evidence_ref_count: number;
    readonly search_closure_status:
      | "completed"
      | "partial"
      | "insufficient_evidence"
      | "unavailable"
      | "not_required"
      | "search_not_required"
      | "failed_before_search";
  };
  readonly delivery_receipt: RuntimeArtifactCompilationResult["compiled_envelopes"][number];
  readonly compilation: RuntimeArtifactCompilationResult;
}

export interface LaneSubmissionChecklistResult {
  readonly schema_version: "startup_opportunity.lane_submission_checklist_result.current";
  readonly run_id: string;
  readonly task_ref: string;
  readonly checklist: readonly {
    readonly scope_key: string;
    readonly status: null;
    readonly reason: null;
    readonly evidence_refs: readonly [];
    readonly limitations: readonly [];
  }[];
  readonly additional_material_allowed: true;
  readonly formal_artifact: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function duplicateStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function pointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function issue(
  stagingId: string,
  code: string,
  path: string,
  message: string,
  likelyCause: string,
  reference: string | null = null,
  mechanicallyDerivable = false,
  affectedObjects: readonly string[] = [],
): LaneDeliveryIssue {
  const registration = gateRegistration(code);
  return {
    code,
    artifact: stagingId,
    path,
    reference,
    message,
    likely_cause: likelyCause,
    affected_objects: uniqueSorted(affectedObjects),
    mechanically_derivable: mechanicallyDerivable,
    severity: registration.defaultSeverity,
    category: registration.category,
    stages: registration.stages,
  };
}

function rootCauses(issues: readonly LaneDeliveryIssue[]): readonly Record<string, unknown>[] {
  const grouped = new Map<string, LaneDeliveryIssue[]>();
  for (const current of issues) {
    grouped.set(current.likely_cause, [...(grouped.get(current.likely_cause) ?? []), current]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([likelyCause, groupedIssues]) => ({
      likely_cause: likelyCause,
      issue_count: groupedIssues.length,
      codes: uniqueSorted(groupedIssues.map((current) => current.code)),
      affected_objects: uniqueSorted(groupedIssues.flatMap((current) => current.affected_objects)),
      mechanically_derivable: groupedIssues.every((current) => current.mechanically_derivable),
    }));
}

function stagingDocumentPointer(artifact: PreparedAgentArtifact, reportedPath: string): string {
  const formalPointer = reportedPath.startsWith(`${artifact.artifact_path}#`)
    ? reportedPath.slice(artifact.artifact_path.length + 1)
    : reportedPath.startsWith("/")
      ? reportedPath
      : "";
  return `/agent_documents/${String(artifact.staging_index)}/document${formalPointer === "/" ? "" : formalPointer}`;
}

function compilerPreflightIssues(
  staging: LaneStagingDocument,
  error: unknown,
  prepared: readonly PreparedAgentArtifact[],
): readonly LaneDeliveryIssue[] {
  if (!(error instanceof StoreError)) throw error;
  const reported = Array.isArray(error.details.issues) ? error.details.issues.filter(isRecord) : [];
  if (reported.length === 0) {
    return [
      issue(
        staging.staging_id,
        error.code,
        "/agent_documents",
        error.message,
        "The authored Lane bundle failed shared compiler preflight.",
        null,
        false,
        [staging.staging_id],
      ),
    ];
  }
  return reported.flatMap((reportedIssue) => {
    const code = String(reportedIssue.code ?? error.code);
    const registration = gateRegistration(code);
    const artifact = String(reportedIssue.artifact ?? staging.staging_id);
    const reference = typeof reportedIssue.reference === "string" ? reportedIssue.reference : null;
    const reportedPath = String(reportedIssue.path ?? "");
    const preparedArtifact = prepared.find(
      (candidate) =>
        candidate.artifact_path === artifact ||
        reportedPath === candidate.artifact_path ||
        reportedPath.startsWith(`${candidate.artifact_path}#`),
    );
    const path =
      preparedArtifact === undefined
        ? reportedPath.startsWith("/")
          ? reportedPath
          : "/agent_documents"
        : stagingDocumentPointer(preparedArtifact, reportedPath);
    const summary: LaneDeliveryIssue = {
      code,
      artifact,
      path,
      reference,
      message: String(reportedIssue.message ?? error.message),
      likely_cause: String(
        reportedIssue.likely_cause ??
          "An authored Lane document failed shared schema or reference validation.",
      ),
      affected_objects: uniqueSorted([artifact, ...(reference === null ? [] : [reference])]),
      mechanically_derivable:
        typeof reportedIssue.mechanically_derivable === "boolean"
          ? reportedIssue.mechanically_derivable
          : registration.mechanicallyDerivable,
      severity: registration.defaultSeverity,
      category: registration.category,
      stages: registration.stages,
    };
    const details = isRecord(reportedIssue.details) ? reportedIssue.details : {};
    const nestedErrors = Array.isArray(details.errors) ? details.errors.filter(isRecord) : [];
    if (preparedArtifact === undefined || nestedErrors.length === 0) return [summary];
    return [
      summary,
      ...nestedErrors.map((nestedError) =>
        issue(
          staging.staging_id,
          `lane_delivery.${String(nestedError.code ?? "schema.invalid")}`,
          stagingDocumentPointer(
            preparedArtifact,
            String(nestedError.instancePath ?? nestedError.path ?? ""),
          ),
          String(nestedError.message ?? "the authored Lane document is invalid"),
          "An Agent-authored Lane semantic field violates its current formal Artifact contract.",
          artifact,
          nestedError.keyword === "additionalProperties",
          [artifact],
        ),
      ),
    ];
  });
}

function effective(entry: DocumentBundleEntry): EffectiveAuthority {
  const envelope = entry.document;
  return {
    path: entry.path,
    document:
      envelope.schema_version === "startup_opportunity.artifact_envelope.current" &&
      isRecord(envelope.document)
        ? envelope.document
        : envelope,
  };
}

function artifactId(document: Record<string, unknown>, family: AgentArtifactFamily): string | null {
  const field =
    family === "evidence"
      ? "evidence_id"
      : family === "finding"
        ? "finding_id"
        : family === "claim"
          ? "claim_id"
          : family === "judgment"
            ? "judgment_id"
            : family === "insight"
              ? "insight_id"
              : family === "source_manifest"
                ? "manifest_id"
                : null;
  return field !== null && typeof document[field] === "string" ? document[field] : null;
}

function isAssessmentAuthority(authority: LaneDeliveryAuthority): boolean {
  return [
    "startup_opportunity.assessment_dispatch_task.current",
    "startup_opportunity.research_task.assessment.current",
  ].includes(authority.taskSchema);
}

function isDiscoveryGenerationAuthority(authority: LaneDeliveryAuthority): boolean {
  return (
    authority.taskSchema === "startup_opportunity.research_task.discovery_candidate.current" &&
    authority.task.required_artifact_schema === "startup_opportunity.discovery_generation_result.v1"
  );
}

function isDiscoveryReviewAuthority(authority: LaneDeliveryAuthority): boolean {
  return (
    authority.taskSchema === "startup_opportunity.research_task.discovery_review.current" &&
    authority.task.required_artifact_schema ===
      "startup_opportunity.discovery_adversarial_review.current"
  );
}

function expectedProducerRole(
  authority: LaneDeliveryAuthority,
): "lane_researcher" | "adversarial_reviewer" {
  return isDiscoveryReviewAuthority(authority) ? "adversarial_reviewer" : "lane_researcher";
}

function discoveryLineage(authority: LaneDeliveryAuthority): Record<string, unknown> {
  return {
    task_ref: authority.taskRef,
    attempt: Number(authority.task.attempt),
    ...(authority.taskSchema === "startup_opportunity.research_task.discovery_evaluation.current"
      ? {
          unit_id: authority.unitId,
          opportunity_refs: strings(authority.task.target_opportunity_refs),
          source_snapshot_ref: authority.task.source_snapshot_ref,
          source_merge_ref: authority.task.source_merge_ref,
        }
      : { candidate_refs: strings(authority.task.target_candidate_refs) }),
    scope_frame_ref: authority.task.scope_frame_ref,
    research_plan_ref: authority.planRef,
  };
}

function projectReviewSearchClosure(searchClosure: unknown): Record<string, unknown> | null {
  if (!isRecord(searchClosure)) return null;
  if (typeof searchClosure.status !== "string" || typeof searchClosure.stop_reason !== "string") {
    return null;
  }
  if (!Array.isArray(searchClosure.adopted_source_refs)) {
    return null;
  }
  return {
    status: searchClosure.status,
    acquisition_routes_attempted: strings(searchClosure.acquisition_routes_attempted),
    adopted_source_refs: uniqueSorted(strings(searchClosure.adopted_source_refs)),
    unresolved_gaps: strings(searchClosure.unresolved_gaps),
    stop_reason: searchClosure.stop_reason,
  };
}

function reviewStatusMatchesSearchClosure(
  reviewStatus: unknown,
  searchClosure: LaneStagingDocument["delivery_contract"]["search_closure"],
  scopeFormalClosure: readonly LaneScopeFormalClosure[] = [],
): boolean {
  const routes = strings(searchClosure.acquisition_routes_attempted);
  const noSearchRoute = routes.length === 1 && routes[0] === "none";
  const hasActualRoute = routes.length > 0 && !routes.includes("none");
  const allNotApplicable =
    scopeFormalClosure.length > 0 &&
    scopeFormalClosure.every((entry) => entry.disposition === "not_applicable");
  if (
    reviewStatus === "completed" ||
    reviewStatus === "partial" ||
    reviewStatus === "insufficient_evidence"
  ) {
    if (
      reviewStatus === "completed" &&
      searchClosure.status === "search_not_required" &&
      noSearchRoute &&
      searchClosure.unresolved_gaps.length === 0 &&
      allNotApplicable
    ) {
      return true;
    }
    return (
      searchClosure.status === reviewStatus &&
      hasActualRoute &&
      (reviewStatus !== "completed" || searchClosure.unresolved_gaps.length === 0)
    );
  }
  if (reviewStatus === "failed") {
    return (
      (searchClosure.status === "failed_before_search" && noSearchRoute) ||
      (searchClosure.status === "unavailable" && hasActualRoute)
    );
  }
  if (reviewStatus === "ignored_late" || reviewStatus === "superseded") {
    if (searchClosure.status === "search_not_required") {
      return noSearchRoute && searchClosure.unresolved_gaps.length === 0 && allNotApplicable;
    }
    if (
      searchClosure.status === "completed" ||
      searchClosure.status === "partial" ||
      searchClosure.status === "insufficient_evidence" ||
      searchClosure.status === "unavailable"
    ) {
      return (
        hasActualRoute &&
        (searchClosure.status !== "completed" || searchClosure.unresolved_gaps.length === 0)
      );
    }
    return searchClosure.status === "failed_before_search" && noSearchRoute;
  }
  return false;
}

const REVIEW_MATERIAL_REF_FIELDS = [
  "supporting_refs",
  "opposing_refs",
  "background_refs",
  "contradictory_refs",
  "unknown_refs",
] as const;

function refDocumentPath(ref: string): string {
  return ref.split("#", 1)[0] ?? "";
}

function isSelfReference(ref: string, artifactPath: string): boolean {
  return refDocumentPath(ref) === artifactPath;
}

function reviewMaterialVisibilityIssues(
  staging: LaneStagingDocument,
  reviewArtifact: PreparedAgentArtifact,
): readonly LaneDeliveryIssue[] {
  const document = reviewArtifact.document;
  const visibility = isRecord(document.material_visibility) ? document.material_visibility : {};
  const issues: LaneDeliveryIssue[] = [];
  const selfReferenceFields: readonly {
    readonly path: string;
    readonly refs: readonly string[];
  }[] = [
    ...REVIEW_MATERIAL_REF_FIELDS.map((field) => ({
      path: `/agent_documents/${String(reviewArtifact.staging_index)}/document/material_visibility/${field}`,
      refs: strings(visibility[field]),
    })),
    ...records(document.review_findings).flatMap((finding, findingIndex) =>
      REVIEW_MATERIAL_REF_FIELDS.map((field) => ({
        path: `/agent_documents/${String(reviewArtifact.staging_index)}/document/review_findings/${String(findingIndex)}/${field}`,
        refs: strings(finding[field]),
      })),
    ),
    ...records(document.decision_relevant_gaps).map((gap, gapIndex) => ({
      path: `/agent_documents/${String(reviewArtifact.staging_index)}/document/decision_relevant_gaps/${String(gapIndex)}/basis_refs`,
      refs: strings(gap.basis_refs),
    })),
    {
      path: `/agent_documents/${String(reviewArtifact.staging_index)}/document/search_closure/adopted_source_refs`,
      refs: strings(
        isRecord(document.search_closure) ? document.search_closure.adopted_source_refs : [],
      ),
    },
  ];
  for (const field of selfReferenceFields) {
    for (const reference of field.refs.filter((ref) =>
      isSelfReference(ref, reviewArtifact.artifact_path),
    )) {
      issues.push(
        issue(
          staging.staging_id,
          "lane_delivery.review_self_reference_forbidden",
          field.path,
          "Discovery review material references must not point at the review result itself",
          "A review result cannot use its own output as material, gap basis, or adopted source authority.",
          reference,
          true,
          [reference, reviewArtifact.artifact_path],
        ),
      );
    }
  }
  for (const [findingIndex, finding] of records(document.review_findings).entries()) {
    for (const field of REVIEW_MATERIAL_REF_FIELDS) {
      const visible = new Set(strings(visibility[field]));
      for (const reference of strings(finding[field]).filter((ref) => !visible.has(ref))) {
        issues.push(
          issue(
            staging.staging_id,
            "lane_delivery.review_material_visibility_mismatch",
            `/agent_documents/${String(reviewArtifact.staging_index)}/document/review_findings/${String(findingIndex)}/${field}`,
            "Discovery review finding material refs must appear in material_visibility with the same structured role",
            "The reviewer cited role-specific material in a finding without making that same role visible in the review inventory.",
            reference,
            false,
            [reference, reviewArtifact.artifact_path],
          ),
        );
      }
    }
  }
  const visibleRefs = uniqueSorted(
    REVIEW_MATERIAL_REF_FIELDS.flatMap((field) => strings(visibility[field])),
  );
  const visibleRefSet = new Set(visibleRefs);
  for (const [gapIndex, gap] of records(document.decision_relevant_gaps).entries()) {
    for (const reference of strings(gap.basis_refs).filter((ref) => !visibleRefSet.has(ref))) {
      issues.push(
        issue(
          staging.staging_id,
          "lane_delivery.review_gap_basis_visibility_mismatch",
          `/agent_documents/${String(reviewArtifact.staging_index)}/document/decision_relevant_gaps/${String(gapIndex)}/basis_refs`,
          "Discovery review gap basis refs must appear in material_visibility",
          "A decision-relevant gap cited material outside the single structured visible-material and Search Closure authority.",
          reference,
          false,
          [reference, reviewArtifact.artifact_path],
        ),
      );
    }
  }
  const searchClosure = isRecord(document.search_closure) ? document.search_closure : {};
  const adoptedRefs = uniqueSorted(strings(searchClosure.adopted_source_refs));
  if (canonicalJson(visibleRefs) !== canonicalJson(adoptedRefs)) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.review_adopted_source_refs_mismatch",
        `/agent_documents/${String(reviewArtifact.staging_index)}/document/search_closure/adopted_source_refs`,
        "Discovery review adopted_source_refs must equal the material_visibility inventory",
        "The review declared a Search Closure adopted-source truth that diverges from the role-specific visible material inventory.",
        null,
        false,
        [reviewArtifact.artifact_path, ...visibleRefs, ...adoptedRefs],
      ),
    );
  }
  return issues;
}

function semanticArtifactContract(
  family: AgentArtifactFamily,
  authority: LaneDeliveryAuthority,
  document: Record<string, unknown>,
  evidenceReceiptRef?: string,
): RequiredArtifact | null {
  if (family === "lane_result") return authority.requiredArtifacts[0] ?? null;
  if (family === "commercial_audit") {
    return authority.commercialAuditPath === null
      ? null
      : {
          artifact_type: "startup_opportunity.commercial_research_audit.current",
          artifact_path: authority.commercialAuditPath,
        };
  }
  const id =
    family === "evidence"
      ? (evidenceReceiptRef?.split("#", 2)[1] ?? null)
      : artifactId(document, family);
  if (id === null) return null;
  const assessment = isAssessmentAuthority(authority);
  const evaluation =
    authority.taskSchema === "startup_opportunity.research_task.discovery_evaluation.current";
  const generation = isDiscoveryGenerationAuthority(authority);
  if (generation && family === "evidence") {
    return {
      artifact_type: "startup_opportunity.candidate_neutral_evidence.v1",
      artifact_path: `evidence/discovery/generation/${id}.json`,
    };
  }
  if (generation && family === "source_manifest") {
    return {
      artifact_type: "startup_opportunity.source_manifest.discovery_runtime.current",
      artifact_path: `evidence/source-manifests/discovery/${id}.json`,
    };
  }
  const suffix = assessment
    ? authority.taskSchema === "startup_opportunity.assessment_dispatch_task.current" &&
      family === "evidence"
      ? "assessment.v1"
      : "assessment.current"
    : evaluation
      ? "discovery_evaluation.current"
      : "discovery_candidate.current";
  const directory =
    family === "source_manifest"
      ? assessment
        ? "evidence/source-manifests"
        : evaluation
          ? "evidence/discovery/enrichment/source-manifests"
          : "evidence/source-manifests/discovery"
      : assessment
        ? family === "evidence"
          ? "evidence/records"
          : `${family === "judgment" ? "judgments" : `${family}s`}`
        : evaluation
          ? family === "evidence"
            ? "evidence/discovery/enrichment"
            : `${family === "judgment" ? "judgments" : `${family}s`}/discovery/enrichment`
          : family === "evidence"
            ? "evidence/records"
            : `${family === "judgment" ? "judgments" : `${family}s`}/discovery`;
  return {
    artifact_type:
      family === "source_manifest"
        ? `startup_opportunity.source_manifest.${suffix}`
        : family === "evidence" &&
            authority.taskSchema === "startup_opportunity.assessment_dispatch_task.current"
          ? "startup_opportunity.assessment_evidence.v1"
          : `startup_opportunity.${family === "judgment" ? "judgment_assessment" : family}.${suffix}`,
    artifact_path: `${directory}/${id}.json`,
  };
}

function mechanicalDocumentFields(
  family: AgentArtifactFamily,
  contract: RequiredArtifact,
  authority: LaneDeliveryAuthority,
  evidenceRecord?: EvidenceStoreRecord,
): Record<string, unknown> {
  if (family === "commercial_audit") {
    return {
      schema_version: "startup_opportunity.commercial_research_delivery.current",
      run_id: authority.runId,
      unit_id: authority.unitId,
    };
  }
  const common = { schema_version: contract.artifact_type, run_id: authority.runId };
  if (family === "evidence") {
    if (evidenceRecord === undefined) return common;
    if (isDiscoveryGenerationAuthority(authority)) {
      return {
        ...common,
        evidence_id: evidenceRecord.evidence_id,
        unit_id: authority.unitId,
        dispatch_batch_ref: authority.dispatchTaskRef,
        scope_frame_ref: authority.task.scope_frame_ref,
        research_plan_ref: authority.planRef,
        research_goal: authority.task.research_goal,
        target_candidate_refs: [],
        solution_refs: [],
        mechanical_binding: {
          substrate_record_ref: `evidence/manifest.jsonl#${evidenceRecord.evidence_id}`,
          source_hash: evidenceRecord.source_hash,
          content_hash: evidenceRecord.content_hash,
          raw_content_ref: evidenceRecord.raw_content_ref,
          operation_key: evidenceRecord.operation_key,
          recorded_at: evidenceRecord.recorded_at,
        },
      };
    }
    if (authority.taskSchema === "startup_opportunity.assessment_dispatch_task.current") {
      return {
        ...common,
        evidence_id: evidenceRecord.evidence_id,
        unit_id: authority.unitId,
        dispatch_batch_ref: authority.dispatchTaskRef,
        concept_hypothesis_ref: authority.assignedSubjectRefs[0],
        research_plan_ref: authority.planRef,
        execution_plan_ref: authority.executionRef,
        mechanical_binding: {
          substrate_record_ref: `evidence/manifest.jsonl#${evidenceRecord.evidence_id}`,
          source_hash: evidenceRecord.source_hash,
          content_hash: evidenceRecord.content_hash,
          raw_content_ref: evidenceRecord.raw_content_ref,
          operation_key: evidenceRecord.operation_key,
          recorded_at: evidenceRecord.recorded_at,
        },
      };
    }
    return {
      ...common,
      evidence_id: evidenceRecord.evidence_id,
      unit_id: authority.unitId,
      lineage: discoveryLineage(authority),
      ...(authority.taskSchema === "startup_opportunity.research_task.assessment.current"
        ? {
            lineage: {
              task_ref: authority.taskRef,
              attempt: Number(authority.task.attempt),
              concept_hypothesis_ref: authority.task.target_subject_ref,
              scope_frame_ref: authority.task.scope_frame_ref,
              research_plan_ref: authority.planRef,
              assessment_plan_ref: authority.task.assessment_plan_ref,
            },
          }
        : {}),
      mechanical_binding: {
        substrate_record_ref: `evidence/manifest.jsonl#${evidenceRecord.evidence_id}`,
        ...(isAssessmentAuthority(authority) ? { source: evidenceRecord.source } : {}),
        source_hash: evidenceRecord.source_hash,
        content_hash: evidenceRecord.content_hash,
        raw_content_ref: evidenceRecord.raw_content_ref,
        operation_key: evidenceRecord.operation_key,
        recorded_at: evidenceRecord.recorded_at,
      },
    };
  }
  if (family === "lane_result") {
    if (contract.artifact_type === "startup_opportunity.discovery_lane_result.v1") {
      return {
        ...common,
        lane_result_id: `lane_${authority.unitId}_attempt_${String(authority.task.attempt)}`,
        unit_id: authority.unitId,
        attempt: Number(authority.task.attempt),
        task_ref: authority.taskRef,
        lane_type: authority.task.unit_type,
        owner_role: "lane-researcher",
      };
    }
    if (contract.artifact_type === "startup_opportunity.discovery_generation_result.v1") {
      return {
        ...common,
        generation_result_id: `generation_${authority.unitId}_attempt_${String(
          authority.task.attempt,
        )}`,
        unit_id: authority.unitId,
        attempt: Number(authority.task.attempt),
        dispatch_batch_ref: authority.dispatchTaskRef,
        scope_frame_ref: authority.task.scope_frame_ref,
        research_plan_ref: authority.planRef,
      };
    }
    if (contract.artifact_type === "startup_opportunity.discovery_adversarial_review.current") {
      return {
        ...common,
        review_result_id: `review_${authority.unitId}_attempt_${String(authority.task.attempt)}`,
        unit_id: authority.unitId,
        attempt: Number(authority.task.attempt),
        owner_role: "adversarial-reviewer",
        owned_output_path: contract.artifact_path,
        task_ref: authority.taskRef,
        task_hash: authority.taskHash,
        dispatch_batch_ref: authority.dispatchTaskRef,
        dispatch_batch_hash: authority.dispatchHash,
        execution_plan_ref: authority.executionRef,
        execution_plan_hash: authority.executionHash,
        scope_frame_ref: authority.task.scope_frame_ref,
        research_plan_ref: authority.planRef,
        research_plan_hash: authority.planHash,
        required_stances: strings(authority.task.required_stances),
      };
    }
    if (contract.artifact_type === "startup_opportunity.assessment_lane_result.v1") {
      return {
        ...common,
        lane_result_id: `result_${authority.unitId}`,
        unit_id: authority.unitId,
        concept_hypothesis_ref: authority.assignedSubjectRefs[0],
        execution_plan_ref: authority.executionRef,
        stage_id: authority.stageId,
      };
    }
    if (contract.artifact_type === "startup_opportunity.enrichment_branch_result.v1") {
      return {
        ...common,
        branch_result_id: `branch_${authority.unitId}_attempt_${String(authority.task.attempt)}`,
        unit_id: authority.unitId,
        attempt: Number(authority.task.attempt),
        task_ref: authority.taskRef,
        source_snapshot_ref: authority.task.source_snapshot_ref,
        source_merge_ref: authority.task.source_merge_ref,
        opportunity_refs: strings(authority.task.target_opportunity_refs),
        owner_role: "lane-researcher",
      };
    }
    if (
      contract.artifact_type === "startup_opportunity.concept_evidence_assessment_branch_result.v1"
    ) {
      return {
        ...common,
        branch_id: `branch_${authority.unitId}`,
        unit_id: authority.unitId,
        concept_hypothesis_ref: authority.task.target_subject_ref,
        assessment_plan_ref: authority.task.assessment_plan_ref,
        dimension_id: strings(authority.executionLane.reporting_dimensions)[0],
      };
    }
    return { ...common, unit_id: authority.unitId };
  }
  if (isAssessmentAuthority(authority)) {
    if (authority.taskSchema === "startup_opportunity.research_task.assessment.current") {
      const lineage = {
        task_ref: authority.taskRef,
        attempt: Number(authority.task.attempt),
        concept_hypothesis_ref: authority.task.target_subject_ref,
        scope_frame_ref: authority.task.scope_frame_ref,
        research_plan_ref: authority.planRef,
        assessment_plan_ref: authority.task.assessment_plan_ref,
      };
      return family === "judgment" ? common : { ...common, unit_id: authority.unitId, lineage };
    }
    return family === "judgment" ? common : { ...common, unit_id: authority.unitId };
  }
  if (
    family === "source_manifest" &&
    contract.artifact_type === "startup_opportunity.source_manifest.discovery_runtime.current"
  ) {
    return {
      ...common,
      unit_id: authority.unitId,
      research_plan_ref: authority.planRef,
      execution_plan_ref: authority.executionRef,
      dispatch_batch_ref: authority.dispatchTaskRef,
    };
  }
  return { ...common, unit_id: authority.unitId, lineage: discoveryLineage(authority) };
}

function mechanicalMismatchIssues(
  staging: LaneStagingDocument,
  index: number,
  document: Record<string, unknown>,
  derived: Record<string, unknown>,
): readonly LaneDeliveryIssue[] {
  return Object.entries(derived).flatMap(([field, expected]) =>
    field in document && canonicalJson(document[field]) !== canonicalJson(expected)
      ? [
          issue(
            staging.staging_id,
            "lane_delivery.mechanical_field_forged",
            `/agent_documents/${String(index)}/document/${field}`,
            "an Agent-supplied mechanical field differs from the current Task authority",
            "The Lane repeated a Harness-owned identity or lineage field with stale or forged content.",
            staging.task_ref,
            true,
            [staging.task_ref],
          ),
        ]
      : [],
  );
}

function preflight(
  staging: LaneStagingDocument,
  authority: LaneDeliveryAuthority,
  prepared: readonly PreparedAgentArtifact[],
  constructionIssues: readonly LaneDeliveryIssue[],
  scopeFormalClosure: readonly LaneScopeFormalClosure[],
): readonly LaneDeliveryIssue[] {
  const issues = [...constructionIssues];
  const delivered = prepared.map((item) => ({
    artifact_type: item.artifact_type,
    artifact_path: item.artifact_path,
    staging_index: item.staging_index,
  }));
  const deliveredIds = delivered.map((item) => `${item.artifact_type}\u0000${item.artifact_path}`);
  for (const duplicate of duplicateStrings(deliveredIds)) {
    const duplicateIndex = delivered.findLast(
      (item) => `${item.artifact_type}\u0000${item.artifact_path}` === duplicate,
    )?.staging_index;
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.delivered_artifact_duplicate",
        duplicateIndex === undefined
          ? "/agent_documents"
          : `/agent_documents/${String(duplicateIndex)}`,
        "the Lane submitted the same derived artifact more than once",
        "Two semantic documents resolve to the same Harness-owned publication identity.",
        duplicate.split("\u0000")[1] ?? null,
        true,
        [duplicate.split("\u0000")[1] ?? ""],
      ),
    );
  }
  const deliveredSet = new Set(deliveredIds);
  for (const required of authority.requiredArtifacts) {
    if (!deliveredSet.has(`${required.artifact_type}\u0000${required.artifact_path}`)) {
      issues.push(
        issue(
          staging.staging_id,
          "lane_delivery.required_artifact_missing",
          "/agent_documents",
          "a Task-required Lane artifact is missing from the one-shot delivery",
          "The Lane stopped before assembling the complete Task-local bundle.",
          required.artifact_path,
          true,
          [required.artifact_path, authority.taskRef],
        ),
      );
    }
  }
  const declaredEvidence = new Set(staging.evidence_receipt_refs);
  for (const entry of scopeFormalClosure) {
    for (const reference of entry.evidence_bindings.map(
      (binding) => binding.substrate_record_ref,
    )) {
      if (!declaredEvidence.has(reference)) {
        issues.push(
          issue(
            staging.staging_id,
            "lane_delivery.evidence_ref_undeclared",
            "/agent_documents",
            "formal scope semantics cite Evidence outside this delivery closure",
            "The exact Evidence receipt was omitted from the Lane bundle.",
            reference,
            false,
            [entry.scope_key, reference],
          ),
        );
      }
    }
  }
  const boundEvidence = prepared
    .filter((artifact) => artifact.family === "evidence")
    .map((artifact) => {
      const binding = isRecord(artifact.document.mechanical_binding)
        ? artifact.document.mechanical_binding
        : {};
      return String(binding.substrate_record_ref ?? "");
    });
  for (const duplicate of duplicateStrings(boundEvidence)) {
    const duplicateArtifact = prepared.findLast((artifact) => {
      if (artifact.family !== "evidence") return false;
      const binding = isRecord(artifact.document.mechanical_binding)
        ? artifact.document.mechanical_binding
        : {};
      return binding.substrate_record_ref === duplicate;
    });
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.evidence_binding_duplicate",
        duplicateArtifact === undefined
          ? "/agent_documents"
          : `/agent_documents/${String(duplicateArtifact.staging_index)}/evidence_receipt_ref`,
        "an Evidence receipt is bound by more than one typed Evidence document",
        "The Lane submitted duplicate formal adoption semantics for one substrate receipt.",
        duplicate,
        false,
        [duplicate],
      ),
    );
  }
  for (const reference of [...declaredEvidence].filter((ref) => !boundEvidence.includes(ref))) {
    const receiptIndex = staging.evidence_receipt_refs.indexOf(reference);
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.typed_evidence_missing",
        `/evidence_receipt_refs/${String(receiptIndex)}`,
        "an adopted Evidence receipt has no typed Evidence semantic document in the Lane bundle",
        "Recorded substrate cannot satisfy Lane coverage until the researcher supplies its formal Evidence disposition.",
        reference,
        false,
        [reference, authority.taskRef],
      ),
    );
  }

  const closure = staging.delivery_contract.search_closure;
  const reviewArtifact = prepared.find(
    (artifact) =>
      artifact.family === "lane_result" &&
      artifact.artifact_type === "startup_opportunity.discovery_adversarial_review.current",
  );
  if (reviewArtifact !== undefined) {
    issues.push(...reviewMaterialVisibilityIssues(staging, reviewArtifact));
    const projectedReviewClosure = projectReviewSearchClosure(
      reviewArtifact.document.search_closure,
    );
    if (
      projectedReviewClosure === null ||
      canonicalJson(projectedReviewClosure) !== canonicalJson(closure)
    ) {
      issues.push(
        issue(
          staging.staging_id,
          "lane_delivery.review_search_closure_mismatch",
          "/delivery_contract/search_closure",
          "Discovery review result search closure must project exactly into the staged delivery contract",
          "The review result and staged delivery contract diverge on the same search-closure authority.",
        ),
      );
    }
    if (
      !reviewStatusMatchesSearchClosure(reviewArtifact.document.status, closure, scopeFormalClosure)
    ) {
      issues.push(
        issue(
          staging.staging_id,
          "lane_delivery.review_status_search_closure_invalid",
          "/delivery_contract/search_closure/status",
          "Discovery review result status must match its structured Search Closure status",
          "The review result and search closure report incompatible terminal states.",
        ),
      );
    }
  }
  if (
    closure.status === "completed" &&
    (closure.acquisition_routes_attempted.length === 0 ||
      closure.acquisition_routes_attempted.includes("none"))
  ) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.search_closure_route_missing",
        "/delivery_contract/search_closure/acquisition_routes_attempted",
        "completed search closure requires an actual acquisition route",
        "The Lane declared completion without disclosing how it searched.",
      ),
    );
  }
  if (
    ["partial", "insufficient_evidence", "unavailable"].includes(closure.status) &&
    (closure.acquisition_routes_attempted.length === 0 ||
      closure.acquisition_routes_attempted.includes("none"))
  ) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.search_closure_route_missing",
        "/delivery_contract/search_closure/acquisition_routes_attempted",
        "partial, insufficient-evidence, or unavailable search closure requires an actual acquisition route",
        "The Lane declared an applicable search outcome without disclosing how it searched.",
      ),
    );
  }
  if (
    closure.status === "failed_before_search" &&
    (closure.acquisition_routes_attempted.length !== 1 ||
      closure.acquisition_routes_attempted[0] !== "none")
  ) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.failed_before_search_invalid",
        "/delivery_contract/search_closure/acquisition_routes_attempted",
        "failed-before-search closure must disclose that no acquisition route was attempted",
        "The Lane declared a pre-search failure while also declaring an acquisition route.",
      ),
    );
  }
  if (
    (closure.status === "not_required" || closure.status === "search_not_required") &&
    (closure.acquisition_routes_attempted.length !== 1 ||
      closure.acquisition_routes_attempted[0] !== "none" ||
      scopeFormalClosure.some((entry) => entry.disposition !== "not_applicable"))
  ) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.search_not_required_invalid",
        "/delivery_contract/search_closure",
        "search is not required only when every assigned scope item is not applicable",
        "The Lane skipped search despite an applicable assignment.",
      ),
    );
  }
  return issues.sort((left, right) =>
    `${left.code}\u0000${left.path}\u0000${left.reference ?? ""}`.localeCompare(
      `${right.code}\u0000${right.path}\u0000${right.reference ?? ""}`,
    ),
  );
}

function scopeClosureIssues(
  staging: LaneStagingDocument,
  derived: ReturnType<typeof deriveLaneScopeFormalClosure>,
  prepared: readonly PreparedAgentArtifact[],
): readonly LaneDeliveryIssue[] {
  return derived.issues.map((current) => {
    const closure = derived.closure.find((entry) => entry.scope_key === current.scopeKey);
    const binding = closure?.semantic_bindings.find((entry) =>
      prepared.some((artifact) => artifact.artifact_path === entry.artifact_ref),
    );
    const boundArtifact =
      binding === undefined
        ? undefined
        : prepared.find((artifact) => artifact.artifact_path === binding.artifact_ref);
    const laneArtifact = prepared.find((artifact) => artifact.family === "lane_result");
    const auditArtifact = prepared.find((artifact) => artifact.family === "commercial_audit");
    const fallbackArtifact = laneArtifact ?? auditArtifact;
    const missingCollection =
      fallbackArtifact?.artifact_type === "startup_opportunity.discovery_lane_result.v1"
        ? "/scope_outcomes"
        : fallbackArtifact?.artifact_type === "startup_opportunity.assessment_lane_result.v1"
          ? "/dimension_results"
          : fallbackArtifact?.artifact_type ===
              "startup_opportunity.concept_evidence_assessment_branch_result.v1"
            ? "/dimension_id"
            : auditArtifact === undefined
              ? ""
              : current.scopeKey.startsWith("quantitative:")
                ? "/quantitative_coverage"
                : current.scopeKey.startsWith("competitive:")
                  ? "/competitive_coverage"
                  : current.scopeKey === "incumbent_response"
                    ? "/incumbent_response_coverage"
                    : `/coverage/${pointerToken(current.scopeKey)}`;
    const path =
      boundArtifact !== undefined && binding !== undefined
        ? `/agent_documents/${String(boundArtifact.staging_index)}/document${binding.semantic_path === "/" ? "" : binding.semantic_path}`
        : fallbackArtifact === undefined
          ? "/agent_documents"
          : `/agent_documents/${String(fallbackArtifact.staging_index)}/document${missingCollection}`;
    return issue(
      staging.staging_id,
      current.code,
      path,
      current.message,
      "The compiled formal Lane Result or Audit does not prove the Task-assigned scope outcome.",
      current.scopeKey,
      false,
      [current.scopeKey, canonicalJson({ expected: current.expected, actual: current.actual })],
    );
  });
}

function discoveryScopeOutcomeIssues(
  staging: LaneStagingDocument,
  authority: LaneDeliveryAuthority,
  prepared: readonly PreparedAgentArtifact[],
): readonly LaneDeliveryIssue[] {
  const lane = prepared.find(
    (artifact) =>
      artifact.family === "lane_result" &&
      artifact.artifact_type === "startup_opportunity.discovery_lane_result.v1",
  );
  if (lane === undefined) return [];
  const outcomes = records(lane.document.scope_outcomes);
  const outcomeKeys = outcomes.map((outcome) => String(outcome.scope_key));
  const expectedScope = uniqueSorted(strings(authority.executionLane.reporting_dimensions));
  const issues: LaneDeliveryIssue[] = [];
  const seen = new Set<string>();
  for (const [index, scopeKey] of outcomeKeys.entries()) {
    if (!seen.has(scopeKey)) {
      seen.add(scopeKey);
      continue;
    }
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.discovery_scope_outcomes_mismatch",
        `/agent_documents/${String(lane.staging_index)}/document/scope_outcomes/${String(index)}/scope_key`,
        "Discovery Lane Result scope outcomes require unique scope keys",
        "The researcher repeated one authored scope outcome.",
        scopeKey,
        false,
        [scopeKey, lane.artifact_path],
      ),
    );
  }
  for (const missingScope of expectedScope.filter((scopeKey) => !seen.has(scopeKey))) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.discovery_scope_outcomes_mismatch",
        `/agent_documents/${String(lane.staging_index)}/document/scope_outcomes`,
        "Discovery Lane Result is missing a Task-assigned minimum scope outcome",
        "The researcher omitted one required scope outcome; additional unique outcomes remain allowed.",
        missingScope,
        false,
        [missingScope, lane.artifact_path],
      ),
    );
  }
  return issues;
}

export class LaneResultMaterializer {
  private readonly compiler: DeclarativeRuntimeCompiler;
  private readonly runs: RunStore;
  private readonly evidence: EvidenceStore;

  constructor(
    runsRoot: string,
    private readonly validator: ArtifactValidator,
    repositoryRoot = process.cwd(),
  ) {
    this.compiler = new DeclarativeRuntimeCompiler(runsRoot, validator, repositoryRoot);
    this.runs = new RunStore(runsRoot, validator);
    this.evidence = new EvidenceStore(runsRoot);
  }

  async checklist(runId: string, taskRef: string): Promise<LaneSubmissionChecklistResult> {
    const authority = await this.authority({
      schema_version: "startup_opportunity.lane_staging_document.current",
      staging_id: "lane_checklist",
      run_id: runId,
      task_ref: taskRef,
      created_at: "1970-01-01T00:00:00Z",
      producer_role: "lane_researcher",
      operation: "validate_only",
      evidence_receipt_refs: [],
      delivery_contract: {
        search_closure: {
          status: "failed_before_search",
          acquisition_routes_attempted: ["none"],
          unresolved_gaps: [],
          stop_reason: "Mechanical checklist authority lookup only.",
        },
      },
      agent_documents: [],
    });
    const result: LaneSubmissionChecklistResult = {
      schema_version: "startup_opportunity.lane_submission_checklist_result.current",
      run_id: runId,
      task_ref: taskRef,
      checklist: authority.assignedScope.map((scopeKey) => ({
        scope_key: scopeKey,
        status: null,
        reason: null,
        evidence_refs: [],
        limitations: [],
      })),
      additional_material_allowed: true,
      formal_artifact: false,
    };
    const validation = this.validator.validateDocument(result);
    if (!validation.valid) {
      throw new StoreError(
        "runtime.lane_checklist_invalid",
        "derived Lane checklist failed its current contract",
        { errors: validation.errors },
      );
    }
    return result;
  }

  private async authority(staging: LaneStagingDocument): Promise<LaneDeliveryAuthority> {
    const status = await this.runs.status(staging.run_id);
    const context = await this.runs.buildValidationContext(
      staging.run_id,
      {
        schema_version: "startup_opportunity.document_bundle.current",
        documents: [{ path: "manifest.json", document: status.manifest }],
        exact_records: [],
      },
      {
        includeAllFormalArtifacts: true,
        recoverPlanOperations: staging.operation === "publish",
      },
    );
    const byPath = new Map(
      context.bundle.documents.map(effective).map((entry) => [entry.path, entry.document]),
    );
    const [taskPath = "", taskFragment] = staging.task_ref.split("#", 2);
    const directTask = byPath.get(taskPath);
    let task: Record<string, unknown> | undefined;
    let taskSchema = "";
    let dispatch: Record<string, unknown> | undefined;
    let dispatchPath = "";
    if (
      directTask !== undefined &&
      String(directTask.schema_version).startsWith("startup_opportunity.research_task.")
    ) {
      task = directTask;
      taskSchema = String(task.schema_version);
      const matches = [...byPath.entries()].filter(
        ([, document]) =>
          String(document.schema_version).startsWith("startup_opportunity.dispatch_batch.") &&
          records(document.tasks).some(
            (candidate) =>
              candidate.task_id === task?.task_id && candidate.unit_id === task?.unit_id,
          ),
      );
      if (matches.length === 1)
        [dispatchPath, dispatch] = matches[0] as [string, Record<string, unknown>];
    } else if (
      directTask?.schema_version === "startup_opportunity.dispatch_batch.assessment.current" &&
      taskFragment !== undefined
    ) {
      dispatch = directTask;
      dispatchPath = taskPath;
      task = records(dispatch.tasks).find((candidate) => candidate.task_id === taskFragment);
      taskSchema = "startup_opportunity.assessment_dispatch_task.current";
    }
    if (task === undefined || dispatch === undefined) {
      throw new StoreError(
        "runtime.lane_authority_unresolved",
        "Lane delivery must resolve one exact current Task and Dispatch assignment",
        { taskRef: staging.task_ref },
      );
    }
    const unitId = String(task.unit_id);
    const planRef = String(dispatch.research_plan_ref);
    const executionRef = String(dispatch.execution_plan_ref);
    const plan = byPath.get(planRef);
    const execution = byPath.get(executionRef);
    const stage = records(execution?.stages).find(
      (candidate) => candidate.stage_id === dispatch?.stage_id,
    );
    const executionLane = records(stage?.lanes).find((candidate) => candidate.unit_id === unitId);
    const planUnit = records(plan?.waves)
      .flatMap((wave) => records(wave.units))
      .find((candidate) => candidate.unit_id === unitId);
    const dispatchTask = records(dispatch.tasks).find(
      (candidate) => candidate.unit_id === unitId && candidate.task_id === task?.task_id,
    );
    if (
      status.manifest.current_plan_ref !== planRef ||
      plan === undefined ||
      execution === undefined ||
      executionLane === undefined ||
      planUnit === undefined ||
      dispatchTask === undefined
    ) {
      throw new StoreError(
        "runtime.lane_authority_drift",
        "Plan, Execution, Dispatch, and Task no longer form one current immutable assignment",
        {
          taskRef: staging.task_ref,
          currentPlanRef: status.manifest.current_plan_ref,
          planRef,
          executionRef,
          unitId,
        },
      );
    }
    const outputPath = String(task.allowed_output_path ?? task.submission_path);
    const outputType = String(
      task.required_artifact_schema ??
        executionLane.submission_schema ??
        planUnit.required_artifact_schema,
    );
    if (
      outputPath !== String(dispatchTask.allowed_output_path ?? dispatchTask.submission_path) ||
      outputPath !== String(executionLane.submission_path) ||
      outputPath !== String(planUnit.output_path) ||
      outputType !== String(executionLane.submission_schema) ||
      outputType !== String(planUnit.required_artifact_schema)
    ) {
      throw new StoreError(
        "runtime.lane_authority_drift",
        "Task output identity differs across Plan, Execution, and Dispatch",
        { taskRef: staging.task_ref, outputPath, outputType },
      );
    }
    const requirements = isRecord(task.commercial_research_requirements)
      ? task.commercial_research_requirements
      : null;
    const reviewAuthority =
      taskSchema === "startup_opportunity.research_task.discovery_review.current" &&
      outputType === "startup_opportunity.discovery_adversarial_review.current";
    const commercialAuditPath =
      !reviewAuthority &&
      requirements !== null &&
      typeof requirements.commercial_audit_output_path === "string"
        ? requirements.commercial_audit_output_path
        : null;
    const assignedScope = reviewAuthority
      ? uniqueSorted(strings(executionLane.reporting_dimensions))
      : uniqueSorted([
          ...strings(executionLane.reporting_dimensions),
          ...strings(requirements?.required_commercial_dimensions),
          ...(isRecord(requirements?.quantitative_competitive_scope)
            ? [
                ...strings(
                  requirements.quantitative_competitive_scope.required_metric_families,
                ).map((value) => `quantitative:${value}`),
                ...strings(
                  requirements.quantitative_competitive_scope.required_competitor_types,
                ).map((value) => `competitive:${value}`),
              ]
            : []),
          ...(isRecord(executionLane.incumbent_response_assignment) &&
          executionLane.incumbent_response_assignment.analysis_depth !== "not_assigned"
            ? ["incumbent_response"]
            : []),
        ]);
    const assignedSubjectRefs = uniqueSorted([
      ...strings(task.target_candidate_refs),
      ...strings(task.target_opportunity_refs),
      ...(typeof task.target_subject_ref === "string" ? [task.target_subject_ref] : []),
      ...(typeof execution.concept_hypothesis_ref === "string"
        ? [execution.concept_hypothesis_ref]
        : []),
      ...(isRecord(executionLane.candidate_scope)
        ? strings(executionLane.candidate_scope.candidate_refs)
        : []),
    ]);
    return {
      runId: staging.run_id,
      taskRef: staging.task_ref,
      task,
      taskHash: canonicalContentHash(task),
      taskSchema,
      unitId,
      planRef,
      plan,
      planHash: canonicalContentHash(plan),
      executionRef,
      execution,
      executionHash: canonicalContentHash(execution),
      dispatchTaskRef: `${dispatchPath}#${String(task.task_id)}`,
      dispatch,
      dispatchHash: canonicalContentHash(dispatch),
      stageId: String(dispatch.stage_id),
      executionLane,
      assignedScope,
      assignedSubjectRefs,
      requiredArtifacts: [
        { artifact_type: outputType, artifact_path: outputPath },
        ...(commercialAuditPath === null
          ? []
          : [
              {
                artifact_type: "startup_opportunity.commercial_research_audit.current",
                artifact_path: commercialAuditPath,
              },
            ]),
      ],
      commercialAuditPath,
    };
  }

  async materialize(
    value: unknown,
    options: { readonly observe?: OperationObserver | undefined } = {},
  ): Promise<LaneDeliveryResult> {
    const trace = operationTrace("lane_materialization", options.observe);
    trace.start("lane_delivery", {
      agent_documents:
        isRecord(value) && Array.isArray(value.agent_documents) ? value.agent_documents.length : 0,
      evidence_receipts:
        isRecord(value) && Array.isArray(value.evidence_receipt_refs)
          ? value.evidence_receipt_refs.length
          : 0,
    });
    try {
      const result = await this.materializeAttempt(value, options.observe);
      trace.complete("lane_delivery", {
        delivered_artifacts: result.preflight.delivered_artifact_count,
        assigned_scopes: result.preflight.scope_count,
        evidence_receipts: result.preflight.evidence_ref_count,
      });
      return result;
    } catch (error) {
      trace.fail(
        "lane_delivery",
        error instanceof StoreError ? error.code : "runtime.lane_materialization_unexpected",
      );
      throw error;
    }
  }

  private async materializeAttempt(
    value: unknown,
    observe?: OperationObserver,
  ): Promise<LaneDeliveryResult> {
    const validation = this.validator.validateDocument(value);
    if (!validation.valid || !isRecord(value)) {
      const stagingId =
        isRecord(value) && typeof value.staging_id === "string"
          ? value.staging_id
          : "unknown_staging";
      const issues = validation.errors.map((error) =>
        issue(
          stagingId,
          `lane_delivery.${error.code}`,
          error.instancePath,
          error.message,
          "The Lane staging document contains an unknown or invalid authored field.",
          null,
          error.keyword === "additionalProperties",
          [stagingId],
        ),
      );
      throw new StoreError(
        "runtime.lane_staging_invalid",
        "lane staging document is not schema-valid",
        { artifact: stagingId, issues, root_causes: rootCauses(issues) },
      );
    }
    const staging = value as LaneStagingDocument;
    const authority = await this.authority(staging);
    const constructionIssues: LaneDeliveryIssue[] = [];
    const producerRole = expectedProducerRole(authority);
    if (staging.producer_role !== producerRole) {
      constructionIssues.push(
        issue(
          staging.staging_id,
          "lane_delivery.producer_role_mismatch",
          "/producer_role",
          "Lane staging producer_role must match the exact Task owner",
          "The delivery was submitted by a role that does not own the current Task output contract.",
          authority.taskRef,
          true,
          [authority.taskRef, staging.producer_role],
        ),
      );
    }
    const prepared: PreparedAgentArtifact[] = [];
    for (const [index, artifact] of staging.agent_documents.entries()) {
      const contract = semanticArtifactContract(
        artifact.artifact_family,
        authority,
        artifact.document,
        artifact.evidence_receipt_ref,
      );
      if (contract === null) {
        constructionIssues.push(
          issue(
            staging.staging_id,
            "lane_delivery.artifact_identity_missing",
            `/agent_documents/${String(index)}`,
            "the semantic document cannot be assigned a Harness-owned formal identity",
            "A Finding, Claim, or Judgment omitted its semantic statement identifier, or an unassigned Audit was submitted.",
            null,
            artifact.artifact_family === "commercial_audit",
            [authority.taskRef],
          ),
        );
        continue;
      }
      let evidenceRecord: EvidenceStoreRecord | undefined;
      if (artifact.evidence_receipt_ref !== undefined) {
        try {
          evidenceRecord = await this.evidence.readExactRecord(
            staging.run_id,
            artifact.evidence_receipt_ref,
          );
          if (
            !staging.evidence_receipt_refs.includes(artifact.evidence_receipt_ref) ||
            evidenceRecord.unit_id !== authority.unitId
          ) {
            throw new Error("receipt is outside the Lane delivery or unit");
          }
        } catch {
          constructionIssues.push(
            issue(
              staging.staging_id,
              "lane_delivery.evidence_binding_invalid",
              `/agent_documents/${String(index)}/evidence_receipt_ref`,
              "typed Evidence must bind one exact same-Run, same-unit Evidence Store receipt",
              "The Evidence semantic document names a missing, undeclared, or wrong-unit substrate receipt.",
              artifact.evidence_receipt_ref,
              true,
              [artifact.evidence_receipt_ref, authority.taskRef],
            ),
          );
          continue;
        }
      }
      const mechanical = mechanicalDocumentFields(
        artifact.artifact_family,
        contract,
        authority,
        evidenceRecord,
      );
      constructionIssues.push(
        ...mechanicalMismatchIssues(staging, index, artifact.document, mechanical),
      );
      const document = { ...artifact.document, ...mechanical };
      const directRefs = uniqueSorted([
        authority.taskRef,
        authority.planRef,
        authority.executionRef,
        authority.dispatchTaskRef,
        ...(artifact.artifact_family === "evidence" && evidenceRecord?.handoff_binding !== undefined
          ? [evidenceRecord.handoff_binding.handoff_ref]
          : []),
        ...artifactRefsForDocument({ path: contract.artifact_path, document }),
      ]);
      prepared.push({
        staging_index: index,
        family: artifact.artifact_family,
        ...contract,
        producer_role: producerRole,
        input_refs: directRefs,
        document,
      });
    }
    const authoredArtifacts = prepared.map(
      ({ family, staging_index: _stagingIndex, ...artifact }) => ({
        ...artifact,
        input_refs: uniqueSorted([
          ...artifact.input_refs,
          ...(family === "lane_result" &&
          authority.taskSchema === "startup_opportunity.research_task.assessment.current"
            ? prepared
                .filter(
                  (candidate) =>
                    candidate.family === "source_manifest" || candidate.family === "insight",
                )
                .map((candidate) => candidate.artifact_path)
            : []),
        ]),
      }),
    );
    let preview: RuntimeArtifactCompilationResult | null = null;
    let sharedIssues: readonly LaneDeliveryIssue[] = [];
    if (authoredArtifacts.length > 0) {
      try {
        preview = await this.compiler.compile(
          {
            schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
            request_id: `${staging.staging_id}_gate_preview`,
            run_id: staging.run_id,
            operation: "validate_only",
            created_at: staging.created_at,
            artifacts: authoredArtifacts,
          },
          { observe, includeAllFormalArtifacts: true },
        );
      } catch (error) {
        sharedIssues = compilerPreflightIssues(staging, error, prepared);
      }
    }
    const compiledClosureArtifacts =
      preview?.compiled_envelopes.map((envelope) => ({
        artifact_ref: envelope.artifact_path,
        artifact_type: envelope.artifact_type,
        content_hash: envelope.content_hash,
        document: envelope.document,
      })) ?? [];
    const currentClosureArtifacts =
      preview === null
        ? []
        : (
            await this.runs.buildValidationContext(
              staging.run_id,
              {
                schema_version: "startup_opportunity.document_bundle.current",
                documents: [
                  {
                    path: "manifest.json",
                    document: (await this.runs.status(staging.run_id)).manifest,
                  },
                ],
                exact_records: [],
              },
              {
                includeAllFormalArtifacts: true,
                recoverPlanOperations: staging.operation === "publish",
              },
            )
          ).bundle.documents.flatMap((entry) => {
            const envelope = entry.document;
            return envelope.schema_version === "startup_opportunity.artifact_envelope.current" &&
              typeof envelope.artifact_type === "string" &&
              typeof envelope.content_hash === "string" &&
              isRecord(envelope.document)
              ? [
                  {
                    artifact_ref: entry.path,
                    artifact_type: envelope.artifact_type,
                    content_hash: envelope.content_hash,
                    document: envelope.document,
                  },
                ]
              : [];
          });
    const closureArtifacts = [
      ...new Map(
        [...currentClosureArtifacts, ...compiledClosureArtifacts].map((artifact) => [
          artifact.artifact_ref,
          artifact,
        ]),
      ).values(),
    ];
    const scopeFormalClosure =
      preview === null
        ? { closure: [] as readonly LaneScopeFormalClosure[], issues: [] }
        : deriveLaneScopeFormalClosure(
            authority.assignedScope,
            closureArtifacts,
            authority.requiredArtifacts.map((artifact) => artifact.artifact_path),
          );
    const issues = preflight(
      staging,
      authority,
      prepared,
      [
        ...constructionIssues,
        ...sharedIssues,
        ...discoveryScopeOutcomeIssues(staging, authority, prepared),
        ...scopeClosureIssues(staging, scopeFormalClosure, prepared),
      ],
      scopeFormalClosure.closure,
    );
    if (issues.length > 0) {
      throw new StoreError(
        "runtime.lane_preflight_failed",
        "Lane delivery preflight rejected the incomplete or unauthorized bundle",
        { artifact: staging.staging_id, issues, root_causes: rootCauses(issues) },
      );
    }

    if (preview === null) {
      throw new StoreError(
        "runtime.lane_preflight_failed",
        "Lane delivery has no schema-valid authored artifacts",
        { artifact: staging.staging_id, issues: [], root_causes: [] },
      );
    }
    const gateDiagnostics =
      preview.publication_preflight.gate_diagnostics ??
      summarizeGateDiagnostics([], "lane_preflight");
    const deliveredArtifacts = preview.compiled_envelopes.map((envelope) => ({
      artifact_ref: envelope.artifact_path,
      artifact_type: envelope.artifact_type,
      content_hash: envelope.content_hash,
    }));
    const reviewArtifact = prepared.find(
      (artifact) =>
        artifact.family === "lane_result" &&
        artifact.artifact_type === "startup_opportunity.discovery_adversarial_review.current",
    );
    const scopeCoverage = laneScopeCoverageFromClosure(scopeFormalClosure.closure);
    const reviewSearchClosure =
      reviewArtifact === undefined
        ? staging.delivery_contract.search_closure
        : (projectReviewSearchClosure(reviewArtifact.document.search_closure) ??
          staging.delivery_contract.search_closure);
    const receiptIdentity = {
      run_id: staging.run_id,
      staging_id: staging.staging_id,
      task_ref: authority.taskRef,
      research_plan_ref: authority.planRef,
      execution_plan_ref: authority.executionRef,
      dispatch_task_ref: authority.dispatchTaskRef,
      required_artifacts: authority.requiredArtifacts,
      delivered_artifacts: deliveredArtifacts,
      assigned_subject_refs: authority.assignedSubjectRefs,
      assigned_scope: authority.assignedScope,
      scope_coverage: scopeCoverage,
      scope_formal_closure: scopeFormalClosure.closure,
      search_closure: reviewSearchClosure,
    };
    const receiptPath = `artifacts/runtime/lane-deliveries/${staging.staging_id}.json`;
    const receiptDocument: Record<string, unknown> = {
      schema_version: "startup_opportunity.lane_delivery_receipt.current",
      receipt_id: operationKey("lane_delivery_receipt", receiptIdentity),
      ...receiptIdentity,
      audit: {
        status: "accepted",
        checks: [
          "required_artifacts_complete",
          "scope_coverage_complete",
          "scope_formal_closure_verified",
          "evidence_refs_declared",
          "search_closure_complete",
        ],
        required_artifact_count: authority.requiredArtifacts.length,
        delivered_artifact_count: deliveredArtifacts.length,
        covered_scope_count: scopeCoverage.filter((entry) => entry.status === "covered").length,
        no_evidence_scope_count: scopeCoverage.filter(
          (entry) => entry.status === "no_evidence_found",
        ).length,
        partial_scope_count: scopeCoverage.filter((entry) => entry.status === "partial").length,
        not_applicable_scope_count: scopeCoverage.filter(
          (entry) => entry.status === "not_applicable",
        ).length,
        unknown_scope_count: scopeCoverage.filter((entry) => entry.status === "unknown").length,
        unavailable_scope_count: scopeCoverage.filter((entry) => entry.status === "unavailable")
          .length,
        inferred_scope_count: scopeCoverage.filter((entry) => entry.status === "inferred").length,
        evidence_ref_count: staging.evidence_receipt_refs.length,
      },
      gate_diagnostics: gateDiagnostics,
      created_at: staging.created_at,
    };
    const artifacts = [
      ...authoredArtifacts,
      {
        artifact_type: "startup_opportunity.lane_delivery_receipt.current",
        artifact_path: receiptPath,
        producer_role: "harness" as const,
        input_refs: uniqueSorted([
          authority.taskRef,
          authority.planRef,
          authority.executionRef,
          authority.dispatchTaskRef,
          ...staging.evidence_receipt_refs,
          ...prepared.map((artifact) => artifact.artifact_path),
        ]),
        document: receiptDocument,
      },
    ];
    const validated = await this.compiler.compile(
      {
        schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
        request_id: staging.staging_id,
        run_id: staging.run_id,
        operation: "validate_only",
        created_at: staging.created_at,
        artifacts,
      },
      { observe, includeAllFormalArtifacts: true },
    );
    let compilation = validated;
    if (staging.operation === "publish") {
      if (
        staging.publication_plan === undefined ||
        staging.publication_plan.request_id !== staging.staging_id ||
        staging.publication_plan.run_id !== staging.run_id ||
        staging.publication_plan.created_at !== staging.created_at ||
        !runtimePublicationPlansEquivalentForScopedClosure(
          validated.publication_plan,
          staging.publication_plan,
        )
      ) {
        throw new StoreError(
          "runtime.publication_plan_stale",
          "Lane publish must consume the exact validate-only publication plan",
          {
            suppliedPlanId: staging.publication_plan?.plan_id ?? null,
            currentPlanId: validated.publication_plan.plan_id,
          },
        );
      }
      compilation = await this.compiler.compile(
        {
          schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
          request_id: staging.staging_id,
          run_id: staging.run_id,
          operation: "publish",
          created_at: staging.created_at,
          artifacts: [],
          publication_plan: staging.publication_plan,
        },
        { observe, includeAllFormalArtifacts: true },
      );
    }
    const deliveryReceipt = compilation.compiled_envelopes.find(
      (envelope) => envelope.artifact_path === receiptPath,
    );
    if (deliveryReceipt === undefined)
      throw new StoreError(
        "runtime.lane_delivery_receipt_missing",
        "compiler omitted the Harness-derived Lane delivery receipt",
        { artifact: staging.staging_id, path: receiptPath },
      );
    const result: LaneDeliveryResult = {
      schema_version: "startup_opportunity.lane_delivery_result.current",
      staging_id: staging.staging_id,
      run_id: staging.run_id,
      status: "accepted",
      preflight: {
        status: "accepted",
        issues: gateDiagnostics.issues,
        root_causes: [],
        required_artifact_count: authority.requiredArtifacts.length,
        delivered_artifact_count: prepared.length,
        scope_count: authority.assignedScope.length,
        evidence_ref_count: staging.evidence_receipt_refs.length,
        search_closure_status: staging.delivery_contract.search_closure.status,
      },
      delivery_receipt: deliveryReceipt,
      compilation,
    };
    const resultValidation = this.validator.validateDocument(result);
    if (!resultValidation.valid)
      throw new StoreError(
        "runtime.lane_delivery_result_invalid",
        "Lane materializer produced an invalid accepted result",
        { artifact: staging.staging_id, errors: resultValidation.errors },
      );
    return result;
  }
}

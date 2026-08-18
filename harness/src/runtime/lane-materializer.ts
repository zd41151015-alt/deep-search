import { canonicalJson, operationKey } from "../artifact-store/canonical.js";
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
  readonly producer_role: "lane_researcher";
  readonly operation: "validate_only" | "publish";
  readonly publication_plan?: RuntimePublicationPlan;
  readonly evidence_receipt_refs: readonly string[];
  readonly delivery_contract: {
    readonly search_closure: {
      readonly status: "completed" | "not_required";
      readonly acquisition_routes_attempted: readonly string[];
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
  readonly taskSchema: string;
  readonly unitId: string;
  readonly planRef: string;
  readonly executionRef: string;
  readonly dispatchTaskRef: string;
  readonly stageId: string;
  readonly executionLane: Record<string, unknown>;
  readonly assignedScope: readonly string[];
  readonly assignedSubjectRefs: readonly string[];
  readonly requiredArtifacts: readonly RequiredArtifact[];
  readonly commercialAuditPath: string | null;
}

interface PreparedAgentArtifact {
  readonly family: AgentArtifactFamily;
  readonly artifact_type: string;
  readonly artifact_path: string;
  readonly producer_role: "lane_researcher";
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
    readonly search_closure_status: "completed" | "not_required";
  };
  readonly delivery_receipt: RuntimeArtifactCompilationResult["compiled_envelopes"][number];
  readonly compilation: RuntimeArtifactCompilationResult;
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

function compilerPreflightIssues(
  staging: LaneStagingDocument,
  error: unknown,
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
  return reported.map((reportedIssue) => {
    const code = String(reportedIssue.code ?? error.code);
    const registration = gateRegistration(code);
    const artifact = String(reportedIssue.artifact ?? staging.staging_id);
    const reference = typeof reportedIssue.reference === "string" ? reportedIssue.reference : null;
    return {
      code,
      artifact,
      path: String(reportedIssue.path ?? "/agent_documents"),
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
          ? "evidence/source-manifests/discovery/enrichment"
          : "evidence/source-manifests/discovery"
      : assessment
        ? family === "evidence"
          ? "evidence/records"
          : `${family === "judgment" ? "judgments" : `${family}s`}`
        : evaluation
          ? family === "evidence"
            ? "evidence/records"
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
  const lineage = {
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
  return { ...common, unit_id: authority.unitId, lineage };
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
  }));
  const deliveredIds = delivered.map((item) => `${item.artifact_type}\u0000${item.artifact_path}`);
  for (const duplicate of duplicateStrings(deliveredIds)) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.delivered_artifact_duplicate",
        "/agent_documents",
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
  const requiredSet = new Set(
    authority.requiredArtifacts.map((item) => `${item.artifact_type}\u0000${item.artifact_path}`),
  );
  for (const item of prepared.filter(
    (candidate) => candidate.family === "lane_result" || candidate.family === "commercial_audit",
  )) {
    if (!requiredSet.has(`${item.artifact_type}\u0000${item.artifact_path}`)) {
      issues.push(
        issue(
          staging.staging_id,
          "lane_delivery.undeclared_artifact",
          "/agent_documents",
          "the Lane submitted a task-level Artifact that was not assigned",
          "The semantic delivery exceeds its immutable Dispatch assignment.",
          item.artifact_path,
          true,
          [item.artifact_path, authority.dispatchTaskRef],
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
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.evidence_binding_duplicate",
        "/agent_documents",
        "an Evidence receipt is bound by more than one typed Evidence document",
        "The Lane submitted duplicate formal adoption semantics for one substrate receipt.",
        duplicate,
        false,
        [duplicate],
      ),
    );
  }
  for (const reference of [...declaredEvidence].filter((ref) => !boundEvidence.includes(ref))) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.typed_evidence_missing",
        "/agent_documents",
        "an adopted Evidence receipt has no typed Evidence semantic document in the Lane bundle",
        "Recorded substrate cannot satisfy Lane coverage until the researcher supplies its formal Evidence disposition.",
        reference,
        false,
        [reference, authority.taskRef],
      ),
    );
  }

  const closure = staging.delivery_contract.search_closure;
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
    closure.status === "not_required" &&
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
): readonly LaneDeliveryIssue[] {
  return derived.issues.map((current) =>
    issue(
      staging.staging_id,
      current.code,
      "/agent_documents",
      current.message,
      "The compiled formal Lane Result or Audit does not prove the Task-assigned scope outcome.",
      current.scopeKey,
      true,
      [current.scopeKey, canonicalJson({ expected: current.expected, actual: current.actual })],
    ),
  );
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
  if (canonicalJson(uniqueSorted(outcomeKeys)) === canonicalJson(expectedScope)) return [];
  return [
    issue(
      staging.staging_id,
      "lane_delivery.discovery_scope_outcomes_mismatch",
      "/agent_documents",
      "Discovery Lane Result scope outcomes must exactly cover the Task-assigned scope",
      "The researcher omitted, duplicated, or added a scope outcome outside the derived Delivery Manifest.",
      lane.artifact_path,
      false,
      [...expectedScope, ...outcomeKeys],
    ),
  ];
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

  private async authority(staging: LaneStagingDocument): Promise<LaneDeliveryAuthority> {
    const status = await this.runs.status(staging.run_id);
    const context = await this.runs.buildValidationContext(
      staging.run_id,
      {
        schema_version: "startup_opportunity.document_bundle.current",
        documents: [{ path: "manifest.json", document: status.manifest }],
        exact_records: [],
      },
      { includeAllFormalArtifacts: true },
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
    const commercialAuditPath =
      requirements !== null && typeof requirements.commercial_audit_output_path === "string"
        ? requirements.commercial_audit_output_path
        : null;
    const assignedScope = uniqueSorted([
      ...strings(executionLane.reporting_dimensions),
      ...strings(requirements?.required_commercial_dimensions),
      ...(isRecord(requirements?.quantitative_competitive_scope)
        ? [
            ...strings(requirements.quantitative_competitive_scope.required_metric_families).map(
              (value) => `quantitative:${value}`,
            ),
            ...strings(requirements.quantitative_competitive_scope.required_competitor_types).map(
              (value) => `competitive:${value}`,
            ),
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
      taskSchema,
      unitId,
      planRef,
      executionRef,
      dispatchTaskRef: `${dispatchPath}#${String(task.task_id)}`,
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
        family: artifact.artifact_family,
        ...contract,
        producer_role: "lane_researcher",
        input_refs: directRefs,
        document,
      });
    }
    const authoredArtifacts = prepared.map(({ family, ...artifact }) => ({
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
    }));
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
          { observe },
        );
      } catch (error) {
        sharedIssues = compilerPreflightIssues(staging, error);
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
              { includeAllFormalArtifacts: true },
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
        ...scopeClosureIssues(staging, scopeFormalClosure),
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
    const scopeCoverage = laneScopeCoverageFromClosure(scopeFormalClosure.closure);
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
      search_closure: staging.delivery_contract.search_closure,
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
      { observe },
    );
    let compilation = validated;
    if (staging.operation === "publish") {
      if (
        staging.publication_plan === undefined ||
        staging.publication_plan.request_id !== staging.staging_id ||
        staging.publication_plan.run_id !== staging.run_id ||
        staging.publication_plan.created_at !== staging.created_at ||
        canonicalJson(staging.publication_plan.compiled_envelopes) !==
          canonicalJson(validated.compiled_envelopes)
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
        { observe },
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

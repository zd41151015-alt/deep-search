import { canonicalContentHash, operationKey } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import type { ArtifactValidator } from "../validators/artifact-validator.js";
import {
  DeclarativeRuntimeCompiler,
  type RuntimeArtifactCompilationResult,
} from "./declarative-runtime.js";

interface RequiredArtifact {
  readonly artifact_type: string;
  readonly artifact_path: string;
}

interface CoverageEntry {
  readonly scope_key: string;
  readonly status: "covered" | "no_evidence_found" | "not_applicable";
  readonly evidence_refs: readonly string[];
  readonly notes: string;
}

interface LaneStagingDocument extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.lane_staging_document.current";
  readonly staging_id: string;
  readonly run_id: string;
  readonly task_ref: string;
  readonly created_at: string;
  readonly producer_role: "lane_researcher";
  readonly operation: "validate_only" | "publish";
  readonly evidence_receipt_refs: readonly string[];
  readonly delivery_contract: {
    readonly required_artifacts: readonly RequiredArtifact[];
    readonly assigned_scope: readonly string[];
    readonly scope_coverage: readonly CoverageEntry[];
    readonly search_closure: {
      readonly status: "completed" | "not_required";
      readonly acquisition_routes_attempted: readonly string[];
      readonly unresolved_gaps: readonly string[];
      readonly stop_reason: string;
    };
  };
  readonly agent_documents: readonly {
    readonly artifact_type: string;
    readonly artifact_path: string;
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
}

export interface LaneDeliveryResult {
  readonly schema_version: "startup_opportunity.lane_delivery_result.current";
  readonly staging_id: string;
  readonly run_id: string;
  readonly status: "accepted";
  readonly preflight: {
    readonly status: "accepted";
    readonly issues: readonly [];
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

function identity(value: RequiredArtifact): string {
  return `${value.artifact_type}\u0000${value.artifact_path}`;
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
): LaneDeliveryIssue {
  return {
    code,
    artifact: stagingId,
    path,
    reference,
    message,
    likely_cause: likelyCause,
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
      codes: [...new Set(groupedIssues.map((current) => current.code))].sort(),
    }));
}

function preflight(staging: LaneStagingDocument): readonly LaneDeliveryIssue[] {
  const issues: LaneDeliveryIssue[] = [];
  const required = staging.delivery_contract.required_artifacts;
  const delivered = staging.agent_documents.map((document) => ({
    artifact_type: document.artifact_type,
    artifact_path: document.artifact_path,
  }));
  const requiredIds = required.map(identity);
  const deliveredIds = delivered.map(identity);
  for (const duplicate of duplicateStrings(requiredIds)) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.required_artifact_duplicate",
        "/delivery_contract/required_artifacts",
        "the delivery contract declares the same required artifact more than once",
        "The Lane delivery list was assembled from overlapping requirements.",
        duplicate.split("\u0000")[1] ?? null,
      ),
    );
  }
  for (const duplicate of duplicateStrings(deliveredIds)) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.delivered_artifact_duplicate",
        "/agent_documents",
        "the Lane submitted the same artifact more than once",
        "The Lane retried inside one delivery instead of replacing its in-memory document.",
        duplicate.split("\u0000")[1] ?? null,
      ),
    );
  }
  const requiredSet = new Set(requiredIds);
  const deliveredSet = new Set(deliveredIds);
  for (const requiredArtifact of required) {
    if (!deliveredSet.has(identity(requiredArtifact))) {
      issues.push(
        issue(
          staging.staging_id,
          "lane_delivery.required_artifact_missing",
          "/agent_documents",
          "a required Lane artifact is missing from the one-shot delivery",
          "The Lane exited before assembling every required artifact.",
          requiredArtifact.artifact_path,
        ),
      );
    }
  }
  for (const deliveredArtifact of delivered) {
    if (!requiredSet.has(identity(deliveredArtifact))) {
      issues.push(
        issue(
          staging.staging_id,
          "lane_delivery.undeclared_artifact",
          "/agent_documents",
          "the Lane submitted an artifact that is not declared by its delivery contract",
          "The delivery contract and assembled artifact bundle drifted.",
          deliveredArtifact.artifact_path,
        ),
      );
    }
  }

  const assignedScope = staging.delivery_contract.assigned_scope;
  const coverage = staging.delivery_contract.scope_coverage;
  const coverageKeys = coverage.map((entry) => entry.scope_key);
  for (const duplicate of duplicateStrings(coverageKeys)) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.scope_coverage_duplicate",
        "/delivery_contract/scope_coverage",
        "an assigned scope key has more than one coverage disposition",
        "The Lane reported multiple terminal states for the same scope item.",
        duplicate,
      ),
    );
  }
  const missingScope = assignedScope.filter((scope) => !coverageKeys.includes(scope));
  const extraScope = coverageKeys.filter((scope) => !assignedScope.includes(scope));
  for (const scope of missingScope) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.scope_coverage_missing",
        "/delivery_contract/scope_coverage",
        "an assigned scope item has no explicit terminal coverage state",
        "The Lane omitted an assigned question when no evidence was found.",
        scope,
      ),
    );
  }
  for (const scope of extraScope) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.scope_coverage_unassigned",
        "/delivery_contract/scope_coverage",
        "the delivery reports coverage outside the assigned Lane scope",
        "The Lane expanded its scope without a Plan revision.",
        scope,
      ),
    );
  }

  const declaredEvidence = new Set(staging.evidence_receipt_refs);
  const usedEvidence = new Set<string>();
  for (const [index, entry] of coverage.entries()) {
    for (const reference of entry.evidence_refs) {
      usedEvidence.add(reference);
      if (!declaredEvidence.has(reference)) {
        issues.push(
          issue(
            staging.staging_id,
            "lane_delivery.evidence_ref_undeclared",
            `/delivery_contract/scope_coverage/${String(index)}/evidence_refs`,
            "scope coverage cites evidence outside the declared Evidence Store receipts",
            "The evidence receipt was not included in the Lane delivery closure.",
            reference,
          ),
        );
      }
    }
    if (entry.status === "covered" && entry.evidence_refs.length === 0) {
      issues.push(
        issue(
          staging.staging_id,
          "lane_delivery.covered_scope_without_evidence",
          `/delivery_contract/scope_coverage/${String(index)}`,
          "covered scope requires at least one Evidence Store reference",
          "A semantic conclusion was marked covered without formal evidence.",
          entry.scope_key,
        ),
      );
    }
    if (entry.status !== "covered" && entry.evidence_refs.length > 0) {
      issues.push(
        issue(
          staging.staging_id,
          "lane_delivery.noncovered_scope_has_evidence",
          `/delivery_contract/scope_coverage/${String(index)}`,
          "no-evidence and not-applicable coverage states cannot cite supporting evidence",
          "The coverage status was not updated after usable evidence was attached.",
          entry.scope_key,
        ),
      );
    }
  }
  for (const reference of declaredEvidence) {
    if (!usedEvidence.has(reference)) {
      issues.push(
        issue(
          staging.staging_id,
          "lane_delivery.evidence_ref_unassigned",
          "/evidence_receipt_refs",
          "a declared Evidence Store receipt is not assigned to any scope coverage item",
          "The Lane recorded evidence but omitted its semantic coverage binding.",
          reference,
        ),
      );
    }
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
        "completed search closure requires at least one actual acquisition route",
        "The Lane declared completion without recording how it searched.",
      ),
    );
  }
  if (
    closure.status === "not_required" &&
    (closure.acquisition_routes_attempted.length !== 1 ||
      closure.acquisition_routes_attempted[0] !== "none" ||
      coverage.some((entry) => entry.status !== "not_applicable"))
  ) {
    issues.push(
      issue(
        staging.staging_id,
        "lane_delivery.search_not_required_invalid",
        "/delivery_contract/search_closure",
        "search may be not required only when every assigned scope item is not applicable",
        "The Lane skipped search despite having an applicable assigned scope item.",
      ),
    );
  }
  return issues.sort((left, right) =>
    `${left.code}\u0000${left.path}\u0000${left.reference ?? ""}`.localeCompare(
      `${right.code}\u0000${right.path}\u0000${right.reference ?? ""}`,
    ),
  );
}

export class LaneResultMaterializer {
  private readonly compiler: DeclarativeRuntimeCompiler;

  constructor(
    runsRoot: string,
    private readonly validator: ArtifactValidator,
    repositoryRoot = process.cwd(),
  ) {
    this.compiler = new DeclarativeRuntimeCompiler(runsRoot, validator, repositoryRoot);
  }

  async materialize(value: unknown): Promise<LaneDeliveryResult> {
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
          "The Lane staging document does not satisfy the current delivery schema.",
        ),
      );
      throw new StoreError(
        "runtime.lane_staging_invalid",
        "lane staging document is not schema-valid",
        { artifact: stagingId, issues, root_causes: rootCauses(issues) },
      );
    }
    const staging = value as LaneStagingDocument;
    const issues = preflight(staging);
    if (issues.length > 0) {
      throw new StoreError(
        "runtime.lane_preflight_failed",
        "Lane delivery preflight rejected the incomplete delivery",
        {
          artifact: staging.staging_id,
          issues,
          root_causes: rootCauses(issues),
        },
      );
    }

    const deliveredArtifacts = staging.agent_documents.map((artifact) => ({
      artifact_ref: artifact.artifact_path,
      artifact_type: artifact.artifact_type,
      content_hash: canonicalContentHash(artifact.document),
    }));
    const receiptIdentity = {
      run_id: staging.run_id,
      staging_id: staging.staging_id,
      task_ref: staging.task_ref,
      required_artifacts: staging.delivery_contract.required_artifacts,
      delivered_artifacts: deliveredArtifacts,
      assigned_scope: staging.delivery_contract.assigned_scope,
      scope_coverage: staging.delivery_contract.scope_coverage,
      search_closure: staging.delivery_contract.search_closure,
    };
    const receiptPath = `artifacts/runtime/lane-deliveries/${staging.staging_id}.json`;
    const receiptDocument: Record<string, unknown> = {
      schema_version: "startup_opportunity.lane_delivery_receipt.current",
      receipt_id: operationKey("lane_delivery_receipt", receiptIdentity),
      run_id: staging.run_id,
      staging_id: staging.staging_id,
      task_ref: staging.task_ref,
      required_artifacts: staging.delivery_contract.required_artifacts,
      delivered_artifacts: deliveredArtifacts,
      assigned_scope: staging.delivery_contract.assigned_scope,
      scope_coverage: staging.delivery_contract.scope_coverage,
      search_closure: staging.delivery_contract.search_closure,
      audit: {
        status: "accepted",
        checks: [
          "required_artifacts_complete",
          "scope_coverage_complete",
          "evidence_refs_declared",
          "search_closure_complete",
        ],
        required_artifact_count: staging.delivery_contract.required_artifacts.length,
        delivered_artifact_count: deliveredArtifacts.length,
        covered_scope_count: staging.delivery_contract.scope_coverage.filter(
          (entry) => entry.status === "covered",
        ).length,
        no_evidence_scope_count: staging.delivery_contract.scope_coverage.filter(
          (entry) => entry.status === "no_evidence_found",
        ).length,
        not_applicable_scope_count: staging.delivery_contract.scope_coverage.filter(
          (entry) => entry.status === "not_applicable",
        ).length,
        evidence_ref_count: staging.evidence_receipt_refs.length,
      },
      created_at: staging.created_at,
    };
    const compilation = await this.compiler.compile({
      schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
      request_id: staging.staging_id,
      run_id: staging.run_id,
      operation: staging.operation,
      created_at: staging.created_at,
      artifacts: [
        ...staging.agent_documents.map((artifact) => ({
          artifact_type: artifact.artifact_type,
          artifact_path: artifact.artifact_path,
          producer_role: staging.producer_role,
          input_refs: [...new Set([staging.task_ref, ...staging.evidence_receipt_refs])].sort(),
          document: { ...artifact.document },
        })),
        {
          artifact_type: "startup_opportunity.lane_delivery_receipt.current",
          artifact_path: receiptPath,
          producer_role: "harness",
          input_refs: [
            ...new Set([
              staging.task_ref,
              ...staging.evidence_receipt_refs,
              ...staging.agent_documents.map((artifact) => artifact.artifact_path),
            ]),
          ].sort(),
          document: receiptDocument,
        },
      ],
    });
    const deliveryReceipt = compilation.compiled_envelopes.find(
      (envelope) => envelope.artifact_path === receiptPath,
    );
    if (deliveryReceipt === undefined) {
      throw new StoreError(
        "runtime.lane_delivery_receipt_missing",
        "compiler omitted the Harness-derived Lane delivery receipt",
        { artifact: staging.staging_id, path: receiptPath },
      );
    }
    const result: LaneDeliveryResult = {
      schema_version: "startup_opportunity.lane_delivery_result.current",
      staging_id: staging.staging_id,
      run_id: staging.run_id,
      status: "accepted",
      preflight: {
        status: "accepted",
        issues: [],
        root_causes: [],
        required_artifact_count: staging.delivery_contract.required_artifacts.length,
        delivered_artifact_count: staging.agent_documents.length,
        scope_count: staging.delivery_contract.assigned_scope.length,
        evidence_ref_count: staging.evidence_receipt_refs.length,
        search_closure_status: staging.delivery_contract.search_closure.status,
      },
      delivery_receipt: deliveryReceipt,
      compilation,
    };
    const resultValidation = this.validator.validateDocument(result);
    if (!resultValidation.valid) {
      throw new StoreError(
        "runtime.lane_delivery_result_invalid",
        "Lane materializer produced an invalid accepted result",
        { artifact: staging.staging_id, errors: resultValidation.errors },
      );
    }
    return result;
  }
}

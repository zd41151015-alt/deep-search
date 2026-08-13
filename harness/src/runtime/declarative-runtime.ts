import { performance } from "node:perf_hooks";
import type {
  ArtifactFaultBoundary,
  FormalArtifactEnvelope,
} from "../artifact-store/artifact-store.js";
import { canonicalContentHash, canonicalJson, operationKey } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import { compileCommercialResearchDelivery } from "../compiler/commercial-research-compiler.js";
import { RunStore } from "../run-store/run-store.js";
import {
  type ArtifactValidator,
  artifactRefsForDocument,
  type DocumentBundle,
} from "../validators/artifact-validator.js";
import type { CommercialResearchPolicy } from "../validators/commercial-research-validator.js";
import {
  type GateDiagnosticSummary,
  summarizeGateDiagnostics,
} from "../validators/gate-diagnostics.js";
import { gateRegistration } from "../validators/gate-registry.js";
import {
  classifyReference,
  type ResolvedReference,
  resolveReferences,
} from "../validators/reference-classifier.js";
import type { ValidationIssue } from "../validators/schema-bundle.js";
import {
  type OperationObserver,
  type OperationTrace,
  operationTrace,
} from "./operation-observability.js";

export interface RuntimeArtifactCompilationRequest extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1";
  readonly request_id: string;
  readonly run_id: string;
  readonly operation: "validate_only" | "publish";
  readonly created_at: string;
  readonly artifacts: readonly {
    readonly artifact_type: string;
    readonly artifact_path: string;
    readonly producer_role: "main_agent" | "lane_researcher" | "harness";
    readonly input_refs?: readonly string[];
    readonly document: Record<string, unknown>;
  }[];
  readonly publication_plan?: RuntimePublicationPlan;
}

export interface RuntimePublicationPlan extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.runtime_publication_plan.current";
  readonly plan_id: string;
  readonly request_id: string;
  readonly run_id: string;
  readonly created_at: string;
  readonly manifest_content_hash: string;
  readonly compiled_envelopes: readonly FormalArtifactEnvelope[];
  readonly validation_closure: {
    readonly documents: readonly { readonly path: string; readonly content_hash: string }[];
    readonly exact_records: readonly { readonly ref: string; readonly content_hash: string }[];
  };
  readonly resolved_references: readonly {
    readonly ref: string;
    readonly kind: ResolvedReference["kind"];
    readonly target_path: string;
    readonly fragment: string | null;
    readonly content_hash: string | null;
  }[];
  readonly publication: readonly {
    readonly artifact_path: string;
    readonly content_hash: string;
  }[];
}

export interface RuntimeArtifactCompilationResult {
  readonly schema_version:
    | "startup_opportunity.runtime_artifact_compilation_result.discovery.current"
    | "startup_opportunity.runtime_artifact_compilation_result.assessment.current";
  readonly request_id: string;
  readonly run_id: string;
  readonly status: "validated" | "published" | "idempotent_replay";
  readonly current_leaf_run_id: string;
  readonly compiled_envelopes: readonly FormalArtifactEnvelope[];
  readonly publication_plan: RuntimePublicationPlan;
  readonly publication_preflight: {
    readonly status: "ready";
    readonly operation: "validate_only" | "publish";
    readonly issue_count: 0;
    readonly root_causes: readonly [];
    readonly resolved_reference_count: number;
    readonly publication_count: number;
    readonly gate_diagnostics?: GateDiagnosticSummary;
  };
  readonly working_directory: string;
  readonly validation_closure: {
    readonly document_bundle_schema_version: "startup_opportunity.document_bundle.current";
    readonly document_count: number;
    readonly exact_record_count: number;
  };
  readonly timing_ms: {
    readonly compilation: number;
    readonly closure_validation: number;
    readonly publication: number;
    readonly total: number;
  };
  readonly publication: readonly {
    readonly artifact_path: string;
    readonly content_hash: string;
    readonly status: "validated" | "published" | "idempotent_replay";
  }[];
}

export interface CompileRuntimeArtifactsOptions {
  readonly faultAt?: ArtifactFaultBoundary;
  readonly observe?: OperationObserver | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksResolvableReference(value: string): boolean {
  if (/^https?:\/\//u.test(value)) return true;
  const target = value.split("#", 1)[0] ?? "";
  return target.endsWith(".json") || target.endsWith(".jsonl");
}

function declaredArtifactRefs(document: Record<string, unknown>): readonly string[] {
  const refs = new Set<string>();
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "string") {
      if (
        (looksResolvableReference(value) && (key.endsWith("_ref") || key === "ref")) ||
        (key.endsWith("_url") && /^https?:\/\//u.test(value))
      ) {
        refs.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      if (key.endsWith("_refs") || key === "input_refs" || key === "artifact_refs") {
        for (const item of value) {
          if (typeof item === "string" && looksResolvableReference(item)) {
            refs.add(item);
          }
        }
      } else {
        for (const item of value) {
          visit(item);
        }
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, childKey);
    }
  };
  visit(document);
  return [...refs].sort();
}

function elapsed(started: number): number {
  return Math.max(0, performance.now() - started);
}

interface RuntimeDiagnostic {
  readonly code: string;
  readonly artifact: string;
  readonly path: string;
  readonly reference: string | null;
  readonly message: string;
  readonly likely_cause: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly severity: "error" | "warning" | "info";
  readonly category: "integrity" | "decision_validity" | "coverage" | "format" | "telemetry";
  readonly stages: readonly string[];
  readonly mechanically_derivable: boolean;
}

function diagnostic(
  code: string,
  artifact: string,
  path: string,
  message: string,
  likelyCause: string,
  details: Readonly<Record<string, unknown>> = {},
  reference: string | null = null,
): RuntimeDiagnostic {
  const registration = gateRegistration(code);
  return {
    code,
    artifact,
    path,
    reference,
    message,
    likely_cause: likelyCause,
    details,
    severity: registration.defaultSeverity,
    category: registration.category,
    stages: registration.stages,
    mechanically_derivable: registration.mechanicallyDerivable,
  };
}

function aggregateRootCauses(
  issues: readonly RuntimeDiagnostic[],
): readonly Record<string, unknown>[] {
  const causes = new Map<string, RuntimeDiagnostic[]>();
  for (const current of issues) {
    causes.set(current.likely_cause, [...(causes.get(current.likely_cause) ?? []), current]);
  }
  return [...causes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([likelyCause, grouped]) => ({
      likely_cause: likelyCause,
      issue_count: grouped.length,
      codes: [...new Set(grouped.map((current) => current.code))].sort(),
      artifacts: [...new Set(grouped.map((current) => current.artifact))].sort(),
    }));
}

function classifyRuntimeFailure(
  error: unknown,
): "validation_failed" | "publication_failed" | "runtime_blocked" {
  const code = error instanceof StoreError ? error.code : "runtime.unexpected";
  if (
    /(?:validation|invalid|mismatch|reference|schema|hash|stale|transition|bundle|preflight)/u.test(
      code,
    )
  ) {
    return "validation_failed";
  }
  if (/(?:fault|publish|write|receipt|operation|lock|recovery)/u.test(code)) {
    return "publication_failed";
  }
  return "runtime_blocked";
}

const ASSESSMENT_EXECUTION_ARTIFACT_TYPES = new Set([
  "startup_opportunity.concept_hypothesis.assessment_intake.current",
  "startup_opportunity.research_execution_plan.assessment.current",
  "startup_opportunity.dispatch_batch.assessment.current",
  "startup_opportunity.research_task.assessment.current",
  "startup_opportunity.assessment_evidence.v1",
  "startup_opportunity.assessment_lane_result.v1",
  "startup_opportunity.concept_evidence_assessment_branch_result.v1",
  "startup_opportunity.evidence.assessment.current",
  "startup_opportunity.finding.assessment.current",
  "startup_opportunity.claim.assessment.current",
  "startup_opportunity.insight.assessment.current",
  "startup_opportunity.judgment_assessment.assessment.current",
  "startup_opportunity.source_manifest.assessment.current",
  "startup_opportunity.assessment_stage_gate.v1",
  "startup_opportunity.assessment_followup_decision.v1",
]);

const RUNTIME_NEUTRAL_ARTIFACT_TYPES = new Set([
  "startup_opportunity.lane_delivery_receipt.current",
  "startup_opportunity.commercial_research_audit.current",
]);

export class DeclarativeRuntimeCompiler {
  private readonly runs: RunStore;

  constructor(
    runsRoot: string,
    private readonly validator: ArtifactValidator,
    private readonly repositoryRoot = process.cwd(),
  ) {
    this.runs = new RunStore(runsRoot, validator);
  }

  async compile(
    requestValue: unknown,
    options: CompileRuntimeArtifactsOptions = {},
  ): Promise<RuntimeArtifactCompilationResult> {
    const observationStarted = performance.now();
    const startedAt = new Date().toISOString();
    const requestValidation = this.validator.validateDocument(requestValue);
    const observableRequest =
      requestValidation.valid &&
      isRecord(requestValue) &&
      requestValue.operation === "publish" &&
      typeof requestValue.run_id === "string" &&
      typeof requestValue.request_id === "string"
        ? (requestValue as RuntimeArtifactCompilationRequest)
        : null;
    const trace = operationTrace("runtime_compile", options.observe);
    trace.start("operation");
    try {
      const result = await this.compileAttempt(requestValue, options, trace);
      const completesFailedAttempt =
        observableRequest !== null &&
        result.status === "idempotent_replay" &&
        (await this.runs.runtimeOperationNeedsCompletionObservation(
          observableRequest.run_id,
          observableRequest.request_id,
        ));
      if (observableRequest !== null && (result.status === "published" || completesFailedAttempt)) {
        await this.runs.recordRuntimeOperationObservation({
          runId: observableRequest.run_id,
          operationId: observableRequest.request_id,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: elapsed(observationStarted),
          outcome: "published",
          failureClassification: null,
          errorCode: null,
          artifactRefs: result.publication.map((entry) => entry.artifact_path),
        });
      }
      trace.complete("operation", {
        compiled_artifacts: result.compiled_envelopes.length,
        closure_documents: result.validation_closure.document_count,
        exact_records: result.validation_closure.exact_record_count,
        resolved_references: result.publication_plan.resolved_references.length,
      });
      return result;
    } catch (error) {
      trace.fail("operation", error instanceof StoreError ? error.code : "runtime.unexpected");
      if (observableRequest !== null) {
        try {
          await this.runs.recordRuntimeOperationObservation({
            runId: observableRequest.run_id,
            operationId: observableRequest.request_id,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: elapsed(observationStarted),
            outcome: "failed",
            failureClassification: classifyRuntimeFailure(error),
            errorCode: error instanceof StoreError ? error.code : "runtime.unexpected",
            artifactRefs: [],
          });
        } catch {
          // Preserve the primary Runtime failure if the Run is too damaged to append telemetry.
        }
      }
      throw error;
    }
  }

  private async compileAttempt(
    requestValue: unknown,
    options: CompileRuntimeArtifactsOptions,
    trace: OperationTrace,
  ): Promise<RuntimeArtifactCompilationResult> {
    const totalStarted = performance.now();
    trace.start("request_validation");
    const requestValidation = this.validator.validateDocument(requestValue);
    if (!requestValidation.valid || !isRecord(requestValue)) {
      throw new StoreError(
        "runtime.compilation_request_invalid",
        "runtime artifact compilation request is not schema-valid",
        { errors: requestValidation.errors },
      );
    }
    const request = requestValue as RuntimeArtifactCompilationRequest;
    trace.complete("request_validation", { request_errors: requestValidation.errors.length });
    trace.start("current_run_resolution");
    const resolution = await this.runs.resolveExecution(request.run_id);
    if (
      resolution.disposition === "indeterminate" ||
      resolution.currentLeafRunId !== request.run_id
    ) {
      throw new StoreError(
        "runtime.run_not_current_leaf",
        "declarative compilation requires the authoritative current Run leaf",
        {
          currentLeafRunId: resolution.currentLeafRunId,
          disposition: resolution.disposition,
          issues: resolution.issues,
        },
      );
    }
    trace.complete("current_run_resolution", {
      continuation_depth: resolution.continuationChain.length,
    });

    const compilationStarted = performance.now();
    trace.start("artifact_compilation", { authored_artifacts: request.artifacts.length });
    const rawSourceArtifacts =
      request.publication_plan?.compiled_envelopes.map((envelope) => ({
        artifact_type: envelope.artifact_type,
        artifact_path: envelope.artifact_path,
        producer_role: envelope.producer_role as "main_agent" | "lane_researcher" | "harness",
        input_refs: envelope.input_refs,
        document: envelope.document,
      })) ?? request.artifacts;
    const transformationIssues: ValidationIssue[] = [];
    const commercialDeliveryPresent = rawSourceArtifacts.some(
      (artifact) =>
        artifact.artifact_type === "startup_opportunity.commercial_research_audit.current" &&
        artifact.document.schema_version ===
          "startup_opportunity.commercial_research_delivery.current",
    );
    const availableArtifacts = commercialDeliveryPresent
      ? (
          await this.runs.buildValidationContext(
            request.run_id,
            {
              schema_version: "startup_opportunity.document_bundle.current",
              documents: [
                {
                  path: `artifacts/runtime/compilation-context/${request.request_id}.json`,
                  document: request as unknown as Record<string, unknown>,
                },
              ],
              exact_records: [],
            },
            { includeAllFormalArtifacts: true },
          )
        ).bundle.documents.map((entry) => ({
          artifact_type:
            isRecord(entry.document) && typeof entry.document.artifact_type === "string"
              ? entry.document.artifact_type
              : String(entry.document.schema_version ?? ""),
          artifact_path: entry.path,
          document: entry.document,
        }))
      : [];
    const sourceArtifacts = rawSourceArtifacts.map((artifact) => {
      if (
        artifact.artifact_type !== "startup_opportunity.commercial_research_audit.current" ||
        artifact.document.schema_version !==
          "startup_opportunity.commercial_research_delivery.current"
      ) {
        return artifact;
      }
      const deliveryValidation = this.validator.validateDocument(
        artifact.document,
        artifact.artifact_path,
      );
      if (!deliveryValidation.valid) return artifact;
      const compiled = compileCommercialResearchDelivery(
        artifact.document,
        String(
          artifact.input_refs?.find((ref) => {
            const targetPath = ref.split("#", 1)[0] ?? "";
            const target = availableArtifacts.find(
              (candidate) => candidate.artifact_path === targetPath,
            );
            const targetDocument = isRecord(target?.document.document)
              ? target.document.document
              : target?.document;
            return String(targetDocument?.schema_version).startsWith(
              "startup_opportunity.research_task.",
            );
          }) ??
            artifact.input_refs?.find((ref) => ref.startsWith("tasks/")) ??
            "",
        ),
        [...availableArtifacts, ...rawSourceArtifacts],
        this.validator.publicationPolicy.document
          .commercial_research_contract as unknown as CommercialResearchPolicy,
      );
      transformationIssues.push(...deliveryValidation.errors, ...compiled.issues);
      return {
        ...artifact,
        producer_role: "harness" as const,
        input_refs: [],
        document: compiled.document,
      };
    });
    const paths = sourceArtifacts.map((artifact) => artifact.artifact_path);
    if (new Set(paths).size !== paths.length) {
      throw new StoreError(
        "runtime.compilation_path_conflict",
        "one compilation request cannot declare the same artifact path twice",
      );
    }
    const artifactFamilies = new Set(
      sourceArtifacts
        .filter((artifact) => !RUNTIME_NEUTRAL_ARTIFACT_TYPES.has(artifact.artifact_type))
        .map((artifact) =>
          ASSESSMENT_EXECUTION_ARTIFACT_TYPES.has(artifact.artifact_type)
            ? "assessment"
            : "runtime",
        ),
    );
    if (artifactFamilies.size === 0) artifactFamilies.add("runtime");
    if (artifactFamilies.size !== 1) {
      throw new StoreError(
        "runtime.compilation_artifact_family_mixed",
        "one compilation request cannot mix Discovery and Assessment execution artifacts",
      );
    }
    const constructionIssues: RuntimeDiagnostic[] = [];
    const gateIssues: ValidationIssue[] = [...transformationIssues];
    const envelopes: FormalArtifactEnvelope[] = [];
    for (const artifact of sourceArtifacts) {
      const documentValidation = this.validator.validateDocument(
        artifact.document,
        artifact.artifact_path,
      );
      gateIssues.push(...documentValidation.errors);
      if (
        !documentValidation.valid ||
        artifact.document.schema_version !== artifact.artifact_type ||
        artifact.document.run_id !== request.run_id
      ) {
        constructionIssues.push(
          diagnostic(
            "runtime.compilation_document_invalid",
            artifact.artifact_path,
            artifact.artifact_path,
            "compiled document must be schema-valid and match its declared type and Run",
            "The agent-authored document is incomplete or was bound to the wrong type or Run.",
            {
              artifactType: artifact.artifact_type,
              documentSchemaVersion: artifact.document.schema_version,
              documentRunId: artifact.document.run_id,
              errors: documentValidation.errors,
            },
          ),
        );
        continue;
      }
      const discoveredRefs = [
        ...new Set([
          ...artifactRefsForDocument({
            path: artifact.artifact_path,
            document: artifact.document,
          }),
          ...(artifact.input_refs ?? []),
          ...declaredArtifactRefs(artifact.document),
        ]),
      ].filter((ref) => ref.split("#", 1)[0] !== artifact.artifact_path);
      const directRefs = discoveredRefs
        .filter((ref) =>
          [
            "run_artifact",
            "run_artifact_fragment",
            "evidence_exact_record",
            "run_exact_record",
          ].includes(classifyReference(ref).kind),
        )
        .sort();
      const envelope: FormalArtifactEnvelope = {
        schema_version: "startup_opportunity.artifact_envelope.current",
        artifact_type: artifact.artifact_type,
        artifact_path: artifact.artifact_path,
        run_id: request.run_id,
        created_at: request.created_at,
        producer_role: artifact.producer_role,
        input_refs: directRefs,
        content_hash: canonicalContentHash(artifact.document),
        document: artifact.document,
      };
      const envelopeValidation = this.validator.validateDocument(envelope, artifact.artifact_path);
      gateIssues.push(...envelopeValidation.errors);
      if (!envelopeValidation.valid) {
        constructionIssues.push(
          diagnostic(
            "runtime.compilation_envelope_invalid",
            artifact.artifact_path,
            artifact.artifact_path,
            "compiled envelope violates the current runtime contract",
            "The declared producer, artifact type, or derived formal envelope is not allowed.",
            { errors: envelopeValidation.errors },
          ),
        );
        continue;
      }
      envelopes.push(envelope);
    }
    if (constructionIssues.length > 0) {
      throw new StoreError(
        "runtime.compilation_preflight_failed",
        "runtime artifact construction preflight found one or more invalid artifacts",
        {
          issues: constructionIssues,
          root_causes: aggregateRootCauses(constructionIssues),
        },
      );
    }
    await this.runs.assertTransitionReady(request.run_id, envelopes);
    const compilation = elapsed(compilationStarted);
    trace.complete("artifact_compilation", {
      compiled_artifacts: envelopes.length,
      construction_issues: constructionIssues.length,
    });

    const closureStarted = performance.now();
    trace.start("closure_validation");
    const initialBundle: DocumentBundle = {
      schema_version: "startup_opportunity.document_bundle.current",
      documents: envelopes.map((envelope) => ({
        path: envelope.artifact_path,
        document: envelope,
      })),
      exact_records: [],
    };
    const context = await this.runs.buildValidationContext(request.run_id, initialBundle);
    const validation = this.validator.validateDocumentBundle(
      context.bundle,
      context.referenceContext,
    );
    gateIssues.push(
      ...validation.bundleErrors,
      ...validation.documents.flatMap((document) => document.errors),
      ...validation.referenceErrors,
    );
    if (!validation.valid) {
      const validationIssues: RuntimeDiagnostic[] = [
        ...validation.bundleErrors.map((error) =>
          diagnostic(
            error.code,
            "document_bundle",
            error.instancePath,
            error.message,
            "The requested bundle is structurally incomplete.",
            error.details,
          ),
        ),
        ...validation.documents.flatMap((document) =>
          document.errors.map((error) =>
            diagnostic(
              error.code,
              document.documentPath ?? "unknown_artifact",
              error.instancePath,
              error.message,
              "A document in the proposed publication does not satisfy its current contract.",
              error.details,
            ),
          ),
        ),
        ...validation.referenceErrors.map((error) =>
          diagnostic(
            error.code,
            error.instancePath.split("#", 1)[0] || "document_bundle",
            error.instancePath,
            error.message,
            "A formal reference is missing, stale, or bound to the wrong artifact type.",
            error.details,
            typeof error.details.ref === "string" ? error.details.ref : null,
          ),
        ),
      ];
      throw new StoreError(
        "runtime.compilation_validation_failed",
        "compiled artifacts fail their minimal validated Run closure",
        {
          issues: validationIssues,
          root_causes: aggregateRootCauses(validationIssues),
          bundleErrors: validation.bundleErrors,
          documentErrors: validation.documents.flatMap((document) => document.errors),
          referenceErrors: validation.referenceErrors,
        },
      );
    }
    const allDeclaredRefs =
      request.publication_plan?.resolved_references.map((reference) => reference.ref) ??
      sourceArtifacts.flatMap((artifact) => [
        ...(artifact.input_refs ?? []),
        ...artifactRefsForDocument({
          path: artifact.artifact_path,
          document: artifact.document,
        }),
        ...declaredArtifactRefs(artifact.document),
      ]);
    const resolvedReferences = await resolveReferences({
      refs: allDeclaredRefs,
      repositoryRoot: this.repositoryRoot,
      bundle: context.bundle,
      referenceContext: context.referenceContext,
    });
    const manifest = context.bundle.documents.find((entry) => entry.path === "manifest.json");
    if (manifest === undefined) {
      throw new StoreError(
        "runtime.compilation_manifest_missing",
        "runtime publication requires the validated current Manifest",
      );
    }
    const planIdentity = {
      schema_version: "startup_opportunity.runtime_publication_plan.current" as const,
      request_id: request.request_id,
      run_id: request.run_id,
      created_at: request.created_at,
      manifest_content_hash: canonicalContentHash(manifest.document),
      compiled_envelopes: envelopes,
      validation_closure: {
        documents: context.bundle.documents.map((entry) => ({
          path: entry.path,
          content_hash: canonicalContentHash(entry.document),
        })),
        exact_records: [...(context.referenceContext.exactJsonlRecords?.entries() ?? [])].map(
          ([ref, document]) => ({ ref, content_hash: canonicalContentHash(document) }),
        ),
      },
      resolved_references: resolvedReferences.map((ref) => ({
        ref: ref.ref,
        kind: ref.kind,
        target_path: ref.targetPath,
        fragment: ref.fragment,
        content_hash: ref.contentHash,
      })),
      publication: envelopes.map((envelope) => ({
        artifact_path: envelope.artifact_path,
        content_hash: envelope.content_hash,
      })),
    };
    const compiledPublicationPlan: RuntimePublicationPlan = {
      ...planIdentity,
      plan_id: operationKey("runtime_publication_plan", planIdentity),
    };
    let publicationPlan = compiledPublicationPlan;
    if (
      request.publication_plan !== undefined &&
      canonicalJson(request.publication_plan) !== canonicalJson(compiledPublicationPlan) &&
      isRecord(manifest.document)
    ) {
      const trackedPaths = new Set([
        ...(Array.isArray(manifest.document.artifact_refs)
          ? manifest.document.artifact_refs.filter((ref): ref is string => typeof ref === "string")
          : []),
        ...(Array.isArray(manifest.document.ignored_late_artifact_refs)
          ? manifest.document.ignored_late_artifact_refs.filter(
              (ref): ref is string => typeof ref === "string",
            )
          : []),
      ]);
      if (
        request.publication_plan.publication.every((entry) => trackedPaths.has(entry.artifact_path))
      ) {
        const suppliedManifestClosure = request.publication_plan.validation_closure.documents.find(
          (entry) => entry.path === "manifest.json",
        );
        if (suppliedManifestClosure !== undefined) {
          const replayIdentity = {
            ...planIdentity,
            manifest_content_hash: request.publication_plan.manifest_content_hash,
            validation_closure: {
              ...planIdentity.validation_closure,
              documents: planIdentity.validation_closure.documents.map((entry) =>
                entry.path === "manifest.json" ? suppliedManifestClosure : entry,
              ),
            },
          };
          const replayPlan: RuntimePublicationPlan = {
            ...replayIdentity,
            plan_id: operationKey("runtime_publication_plan", replayIdentity),
          };
          if (canonicalJson(replayPlan) === canonicalJson(request.publication_plan)) {
            publicationPlan = request.publication_plan;
          }
        }
      }
    }
    const planValidation = this.validator.validateDocument(publicationPlan);
    if (!planValidation.valid) {
      throw new StoreError(
        "runtime.publication_plan_invalid",
        "compiler produced an invalid publication plan",
        {
          errors: planValidation.errors,
        },
      );
    }
    if (
      request.publication_plan !== undefined &&
      canonicalJson(request.publication_plan) !== canonicalJson(publicationPlan)
    ) {
      throw new StoreError(
        "runtime.publication_plan_stale",
        "publication plan differs from the current validated Run closure",
        {
          suppliedPlanId: request.publication_plan.plan_id,
          currentPlanId: publicationPlan.plan_id,
        },
      );
    }
    const closureValidation = elapsed(closureStarted);
    trace.complete("closure_validation", {
      closure_documents: context.bundle.documents.length,
      exact_records: context.referenceContext.exactJsonlRecords?.size ?? 0,
      resolved_references: resolvedReferences.length,
    });

    const publicationStarted = performance.now();
    trace.start("publication", { publication_artifacts: envelopes.length });
    let publicationStatus: "validated" | "published" | "idempotent_replay" = "validated";
    let statuses = new Map<string, "validated" | "published" | "idempotent_replay">(
      envelopes.map((envelope) => [envelope.artifact_path, "validated"]),
    );
    if (request.operation === "publish") {
      if (options.faultAt !== undefined && envelopes.length !== 1) {
        throw new StoreError(
          "runtime.fault_boundary_invalid",
          "fault injection is only available for one-artifact compiler recovery tests",
        );
      }
      if (envelopes.length === 1) {
        const envelope = envelopes[0] as FormalArtifactEnvelope;
        const result = await this.runs.publishArtifact({
          runId: request.run_id,
          envelope,
          ...(options.faultAt === undefined ? {} : { faultAt: options.faultAt }),
        });
        publicationStatus = result.status;
        statuses = new Map([[result.artifactPath, result.status]]);
      } else {
        const result = await this.runs.publishArtifactBundle({
          runId: request.run_id,
          envelopes,
        });
        publicationStatus = result.status;
        statuses = new Map(
          result.artifacts.map((artifact) => [artifact.artifactPath, artifact.status]),
        );
      }
    }
    const publication = elapsed(publicationStarted);
    trace.complete("publication", { publication_artifacts: envelopes.length });
    const result: RuntimeArtifactCompilationResult = {
      schema_version: artifactFamilies.has("assessment")
        ? "startup_opportunity.runtime_artifact_compilation_result.assessment.current"
        : "startup_opportunity.runtime_artifact_compilation_result.discovery.current",
      request_id: request.request_id,
      run_id: request.run_id,
      status: publicationStatus,
      current_leaf_run_id: request.run_id,
      compiled_envelopes: envelopes,
      publication_plan: publicationPlan,
      publication_preflight: {
        status: "ready",
        operation: request.operation,
        issue_count: 0,
        root_causes: [],
        resolved_reference_count: resolvedReferences.length,
        publication_count: envelopes.length,
        ...(gateIssues.length === 0
          ? {}
          : { gate_diagnostics: summarizeGateDiagnostics(gateIssues, "artifact_compilation") }),
      },
      working_directory: `dist/research-working/${request.run_id}`,
      validation_closure: {
        document_bundle_schema_version: context.bundle.schema_version,
        document_count: context.bundle.documents.length,
        exact_record_count: context.referenceContext.exactJsonlRecords?.size ?? 0,
      },
      timing_ms: {
        compilation,
        closure_validation: closureValidation,
        publication,
        total: elapsed(totalStarted),
      },
      publication: envelopes.map((envelope) => ({
        artifact_path: envelope.artifact_path,
        content_hash: envelope.content_hash,
        status: statuses.get(envelope.artifact_path) ?? "validated",
      })),
    };
    const resultValidation = this.validator.validateDocument(result);
    if (!resultValidation.valid) {
      throw new StoreError(
        "runtime.compilation_result_invalid",
        "compiler produced an invalid result contract",
        { errors: resultValidation.errors },
      );
    }
    return result;
  }
}

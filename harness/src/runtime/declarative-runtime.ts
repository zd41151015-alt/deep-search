import { performance } from "node:perf_hooks";
import type {
  ArtifactFaultBoundary,
  FormalArtifactEnvelope,
} from "../artifact-store/artifact-store.js";
import { canonicalContentHash } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import { RunStore } from "../run-store/run-store.js";
import {
  type ArtifactValidator,
  artifactRefsForDocument,
  type DocumentBundle,
} from "../validators/artifact-validator.js";

export interface RuntimeArtifactCompilationRequest extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1";
  readonly request_id: string;
  readonly run_id: string;
  readonly operation: "validate_only" | "publish";
  readonly created_at: string;
  readonly artifacts: readonly {
    readonly artifact_type: string;
    readonly artifact_path: string;
    readonly producer_role: "main_agent" | "lane-researcher" | "harness";
    readonly document: Record<string, unknown>;
  }[];
}

export interface RuntimeArtifactCompilationResult {
  readonly schema_version:
    | "startup_opportunity.runtime_artifact_compilation_result.v1"
    | "startup_opportunity.runtime_artifact_compilation_result.v2";
  readonly request_id: string;
  readonly run_id: string;
  readonly status: "validated" | "published" | "idempotent_replay";
  readonly current_leaf_run_id: string;
  readonly compiled_envelopes: readonly FormalArtifactEnvelope[];
  readonly validation_closure: {
    readonly document_bundle_version: string;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathLikeRef(value: string): boolean {
  const path = value.split("#", 1)[0] ?? "";
  return path.includes("/") || path.endsWith(".json") || path.endsWith(".jsonl");
}

function declaredArtifactRefs(document: Record<string, unknown>): readonly string[] {
  const refs = new Set<string>();
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "string") {
      if ((key.endsWith("_ref") || key === "ref") && pathLikeRef(value)) {
        refs.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      if (key.endsWith("_refs") || key === "input_refs" || key === "artifact_refs") {
        for (const item of value) {
          if (typeof item === "string" && pathLikeRef(item)) {
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

const ASSESSMENT_EXECUTION_ARTIFACT_TYPES = new Set([
  "startup_opportunity.concept_hypothesis.v2",
  "startup_opportunity.research_execution_plan.v2",
  "startup_opportunity.dispatch_batch.v2",
  "startup_opportunity.assessment_evidence.v1",
  "startup_opportunity.assessment_lane_result.v1",
  "startup_opportunity.assessment_stage_gate.v1",
  "startup_opportunity.assessment_followup_decision.v1",
]);

export class DeclarativeRuntimeCompiler {
  private readonly runs: RunStore;

  constructor(
    runsRoot: string,
    private readonly validator: ArtifactValidator,
  ) {
    this.runs = new RunStore(runsRoot, validator);
  }

  async compile(
    requestValue: unknown,
    options: CompileRuntimeArtifactsOptions = {},
  ): Promise<RuntimeArtifactCompilationResult> {
    const totalStarted = performance.now();
    const requestValidation = this.validator.validateDocument(requestValue);
    if (!requestValidation.valid || !isRecord(requestValue)) {
      throw new StoreError(
        "runtime.compilation_request_invalid",
        "runtime artifact compilation request is not schema-valid",
        { errors: requestValidation.errors },
      );
    }
    const request = requestValue as RuntimeArtifactCompilationRequest;
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

    const compilationStarted = performance.now();
    const paths = request.artifacts.map((artifact) => artifact.artifact_path);
    if (new Set(paths).size !== paths.length) {
      throw new StoreError(
        "runtime.compilation_path_conflict",
        "one compilation request cannot declare the same artifact path twice",
      );
    }
    const artifactFamilies = new Set(
      request.artifacts.map((artifact) =>
        ASSESSMENT_EXECUTION_ARTIFACT_TYPES.has(artifact.artifact_type) ? "assessment" : "runtime",
      ),
    );
    if (artifactFamilies.size !== 1) {
      throw new StoreError(
        "runtime.compilation_version_mixed",
        "one compilation request cannot mix v18 runtime and v19 Assessment execution artifacts",
      );
    }
    const envelopeVersion = artifactFamilies.has("assessment")
      ? "startup_opportunity.artifact_envelope.v19"
      : "startup_opportunity.artifact_envelope.v18";
    const bundleVersion = artifactFamilies.has("assessment")
      ? "startup_opportunity.document_bundle.v19"
      : "startup_opportunity.document_bundle.v18";
    const envelopes = request.artifacts.map((artifact): FormalArtifactEnvelope => {
      const documentValidation = this.validator.validateDocument(
        artifact.document,
        artifact.artifact_path,
      );
      if (
        !documentValidation.valid ||
        artifact.document.schema_version !== artifact.artifact_type ||
        artifact.document.run_id !== request.run_id
      ) {
        throw new StoreError(
          "runtime.compilation_document_invalid",
          "compiled document must be schema-valid and match its declared type and Run",
          {
            artifactPath: artifact.artifact_path,
            artifactType: artifact.artifact_type,
            documentSchemaVersion: artifact.document.schema_version,
            documentRunId: artifact.document.run_id,
            errors: documentValidation.errors,
          },
        );
      }
      const directRefs = [
        ...new Set([
          ...artifactRefsForDocument({
            path: artifact.artifact_path,
            document: artifact.document,
          }),
          ...declaredArtifactRefs(artifact.document),
        ]),
      ]
        .filter((ref) => ref.split("#", 1)[0] !== artifact.artifact_path)
        .sort();
      const envelope: FormalArtifactEnvelope = {
        schema_version: envelopeVersion,
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
      if (!envelopeValidation.valid) {
        throw new StoreError(
          "runtime.compilation_envelope_invalid",
          "compiled envelope violates its public versioned runtime contract",
          { artifactPath: artifact.artifact_path, errors: envelopeValidation.errors },
        );
      }
      return envelope;
    });
    const compilation = elapsed(compilationStarted);

    const closureStarted = performance.now();
    const initialBundle: DocumentBundle = {
      schema_version: bundleVersion,
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
    if (!validation.valid) {
      throw new StoreError(
        "runtime.compilation_validation_failed",
        "compiled artifacts fail their minimal validated Run closure",
        {
          bundleErrors: validation.bundleErrors,
          documentErrors: validation.documents.flatMap((document) => document.errors),
          referenceErrors: validation.referenceErrors,
        },
      );
    }
    const closureValidation = elapsed(closureStarted);

    const publicationStarted = performance.now();
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
    const result: RuntimeArtifactCompilationResult = {
      schema_version: artifactFamilies.has("assessment")
        ? "startup_opportunity.runtime_artifact_compilation_result.v2"
        : "startup_opportunity.runtime_artifact_compilation_result.v1",
      request_id: request.request_id,
      run_id: request.run_id,
      status: publicationStatus,
      current_leaf_run_id: request.run_id,
      compiled_envelopes: envelopes,
      validation_closure: {
        document_bundle_version: context.bundle.schema_version,
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

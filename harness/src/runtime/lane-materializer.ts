import { StoreError } from "../artifact-store/store-error.js";
import type { ArtifactValidator } from "../validators/artifact-validator.js";
import {
  DeclarativeRuntimeCompiler,
  type RuntimeArtifactCompilationResult,
} from "./declarative-runtime.js";

interface LaneStagingDocument extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.lane_staging_document.current";
  readonly staging_id: string;
  readonly run_id: string;
  readonly task_ref: string;
  readonly created_at: string;
  readonly producer_role: "lane_researcher";
  readonly operation: "validate_only" | "publish";
  readonly evidence_receipt_refs: readonly string[];
  readonly agent_document: {
    readonly artifact_type: string;
    readonly artifact_path: string;
    readonly document: Record<string, unknown>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  async materialize(value: unknown): Promise<RuntimeArtifactCompilationResult> {
    const validation = this.validator.validateDocument(value);
    if (!validation.valid || !isRecord(value)) {
      throw new StoreError(
        "runtime.lane_staging_invalid",
        "lane staging document is not schema-valid",
        {
          errors: validation.errors,
        },
      );
    }
    const staging = value as LaneStagingDocument;
    const document: Record<string, unknown> = { ...staging.agent_document.document };
    return this.compiler.compile({
      schema_version: "startup_opportunity.runtime_artifact_compilation_request.v1",
      request_id: staging.staging_id,
      run_id: staging.run_id,
      operation: staging.operation,
      created_at: staging.created_at,
      artifacts: [
        {
          artifact_type: staging.agent_document.artifact_type,
          artifact_path: staging.agent_document.artifact_path,
          producer_role: staging.producer_role,
          input_refs: [...new Set([staging.task_ref, ...staging.evidence_receipt_refs])].sort(),
          document,
        },
      ],
    });
  }
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalContentHash } from "../artifact-store/canonical.js";
import { StoreError, storeErrorResult } from "../artifact-store/store-error.js";
import { createArtifactValidator } from "../validators/artifact-validator.js";

interface ParsedArguments {
  readonly values: ReadonlyMap<string, string>;
}

interface TypedDocument {
  readonly path: string;
  readonly document: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--json") {
      continue;
    }
    const value = args[index + 1];
    if (
      !name?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new StoreError(
        "command.invalid_arguments",
        "arguments must be unique --name value pairs",
        { argument: name ?? null },
      );
    }
    values.set(name, value);
    index += 1;
  }
  const unknown = [...values.keys()].filter((name) => name !== "--bundle");
  if (unknown.length > 0 || !values.has("--bundle")) {
    throw new StoreError(
      "command.invalid_arguments",
      "comparison commands require exactly one --bundle argument",
      { arguments: unknown.sort() },
    );
  }
  return { values };
}

function effectiveDocument(entry: unknown): TypedDocument | null {
  if (!isRecord(entry) || typeof entry.path !== "string" || !isRecord(entry.document)) {
    return null;
  }
  const outer = entry.document;
  if (
    typeof outer.schema_version === "string" &&
    outer.schema_version.startsWith("startup_opportunity.artifact_envelope.") &&
    isRecord(outer.document)
  ) {
    return { path: entry.path, document: outer.document };
  }
  return { path: entry.path, document: outer };
}

async function loadValidatedBundle(
  args: readonly string[],
  repositoryRoot: string,
): Promise<{
  readonly schemaBundleVersion: string;
  readonly documents: readonly TypedDocument[];
}> {
  const parsed = parseArguments(args);
  const inputPath = path.resolve(repositoryRoot, parsed.values.get("--bundle") as string);
  const bundle = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
  const validator = await createArtifactValidator(repositoryRoot);
  const validation = validator.validateDocumentBundle(bundle);
  if (!validation.valid) {
    throw new StoreError(
      "comparison.bundle_invalid",
      "comparison input must be a closed validated document bundle",
      {
        bundleErrors: validation.bundleErrors,
        documentErrors: validation.documents.flatMap((entry) => entry.errors),
        referenceErrors: validation.referenceErrors,
      },
    );
  }
  const documents =
    isRecord(bundle) && Array.isArray(bundle.documents)
      ? bundle.documents.flatMap((entry) => {
          const effective = effectiveDocument(entry);
          return effective === null ? [] : [effective];
        })
      : [];
  return { schemaBundleVersion: validation.schemaBundleVersion, documents };
}

async function runCommand(action: () => Promise<unknown>): Promise<number> {
  try {
    process.stdout.write(`${JSON.stringify(await action(), null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: "startup_opportunity.comparison_command_error.v1",
        status: "failed",
        error: storeErrorResult(error),
      })}\n`,
    );
    return error instanceof StoreError && error.code === "command.invalid_arguments" ? 64 : 1;
  }
}

export async function runCalculateComparison(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const loaded = await loadValidatedBundle(args, repositoryRoot);
    const comparisons = loaded.documents
      .filter(
        (entry) =>
          entry.document.schema_version === "startup_opportunity.opportunity_comparison.v1",
      )
      .sort((left, right) => left.path.localeCompare(right.path));
    if (comparisons.length === 0) {
      throw new StoreError(
        "comparison.artifact_missing",
        "validated bundle has no opportunity comparison Artifact",
      );
    }
    return {
      schemaVersion: "startup_opportunity.comparison_calculation_result.v1",
      schemaBundleVersion: loaded.schemaBundleVersion,
      status: "validated",
      comparisons: comparisons.map((entry) => ({
        artifactPath: entry.path,
        contentHash: canonicalContentHash(entry.document),
        opportunityRef: entry.document.opportunity_ref,
        hardGateOutcome: entry.document.hard_gate_outcome,
        recommendationBand: entry.document.recommendation_band,
        orderingMode: entry.document.ordering_mode,
        rankRelation: entry.document.rank_relation,
      })),
      executionBoundary: {
        callerSuppliedArtifacts: true,
        semanticJudgmentGenerated: false,
        artifactPublished: false,
        evidenceOrValidationSuccessClaimed: false,
      },
    };
  });
}

export async function runCalculateSensitivity(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const loaded = await loadValidatedBundle(args, repositoryRoot);
    const sensitivities = loaded.documents.filter(
      (entry) => entry.document.schema_version === "startup_opportunity.sensitivity.v1",
    );
    if (sensitivities.length !== 1) {
      throw new StoreError(
        "sensitivity.artifact_count_invalid",
        "validated bundle must contain exactly one sensitivity Artifact",
        { count: sensitivities.length },
      );
    }
    const sensitivity = sensitivities[0] as TypedDocument;
    return {
      schemaVersion: "startup_opportunity.sensitivity_calculation_result.v1",
      schemaBundleVersion: loaded.schemaBundleVersion,
      status: "validated",
      artifactPath: sensitivity.path,
      contentHash: canonicalContentHash(sensitivity.document),
      comparisonRefs: sensitivity.document.comparison_refs,
      robustLeaderRefs: sensitivity.document.robust_leader_refs,
      closeToIndistinguishableGroups: sensitivity.document.close_to_indistinguishable_groups,
      evidenceInsufficientForOrderingRefs:
        sensitivity.document.evidence_insufficient_for_ordering_refs,
      stabilityBand: sensitivity.document.stability_band,
      executionBoundary: {
        callerSuppliedArtifacts: true,
        semanticJudgmentGenerated: false,
        artifactPublished: false,
        evidenceOrValidationSuccessClaimed: false,
      },
    };
  });
}

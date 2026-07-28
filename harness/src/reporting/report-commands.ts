import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FormalArtifactEnvelope } from "../artifact-store/artifact-store.js";
import { StoreError, storeErrorResult } from "../artifact-store/store-error.js";
import { createArtifactValidator } from "../validators/artifact-validator.js";
import { ReportRuntime } from "./report-runtime.js";

interface ParsedArguments {
  readonly values: ReadonlyMap<string, string>;
  readonly json: boolean;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--json") {
      json = true;
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
        {
          argument: name ?? null,
        },
      );
    }
    values.set(name, value);
    index += 1;
  }
  return { values, json };
}

function required(parsed: ParsedArguments, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined) {
    throw new StoreError("command.invalid_arguments", `missing required argument ${name}`, {
      name,
    });
  }
  return value;
}

function rejectUnknown(parsed: ParsedArguments, allowed: readonly string[]): void {
  const unknown = [...parsed.values.keys()].filter((name) => !allowed.includes(name));
  if (unknown.length > 0) {
    throw new StoreError("command.invalid_arguments", "unsupported command arguments", {
      arguments: unknown.sort(),
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function effectiveType(entry: unknown): string | null {
  if (!isRecord(entry) || !isRecord(entry.document)) {
    return null;
  }
  const document = entry.document;
  if (
    typeof document.schema_version === "string" &&
    document.schema_version.startsWith("startup_opportunity.artifact_envelope.") &&
    typeof document.artifact_type === "string"
  ) {
    return document.artifact_type;
  }
  return typeof document.schema_version === "string" ? document.schema_version : null;
}

async function runCommand(
  action: () => Promise<unknown>,
  exitCode: (value: unknown) => number = () => 0,
): Promise<number> {
  try {
    const value = await action();
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return exitCode(value);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: "startup_opportunity.reporting_command_error.v1",
        status: "failed",
        error: storeErrorResult(error),
      })}\n`,
    );
    return error instanceof StoreError && error.code === "command.invalid_arguments" ? 64 : 1;
  }
}

export async function runAuditTraceability(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(
    async () => {
      const parsed = parseArguments(args);
      rejectUnknown(parsed, ["--bundle"]);
      const inputPath = path.resolve(repositoryRoot, required(parsed, "--bundle"));
      const bundle = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
      const validator = await createArtifactValidator(repositoryRoot);
      const validation = validator.validateDocumentBundle(bundle);
      const documents = isRecord(bundle) && Array.isArray(bundle.documents) ? bundle.documents : [];
      const counts = new Map<string, number>();
      for (const entry of documents) {
        const type = effectiveType(entry);
        if (type !== null) {
          counts.set(type, (counts.get(type) ?? 0) + 1);
        }
      }
      const conceptRequiredTypes = [
        "startup_opportunity.evidence_audit.v1",
        "startup_opportunity.adversarial_review.v1",
        "startup_opportunity.concept_evidence_assessment.v2",
        "startup_opportunity.traceability.v1",
      ];
      const conceptReportTypes = [
        "startup_opportunity.concept_evidence_report.v1",
        "startup_opportunity.decision_brief.v1",
        "startup_opportunity.concept_evidence_report_view.v1",
        "startup_opportunity.report_consistency_evaluation.v1",
      ];
      const discoveryRequiredTypes = [
        "startup_opportunity.enrichment_fan_in.v1",
        "startup_opportunity.decision_recommendation.v1",
        "startup_opportunity.traceability.v2",
      ];
      const discoveryReportTypes = [
        "startup_opportunity.report.v1",
        "startup_opportunity.decision_brief.v2",
        "startup_opportunity.discovery_report_view.v1",
      ];
      const discoveryConsistencyTypes = [
        "startup_opportunity.report_consistency_evaluation.v2",
        "startup_opportunity.report_consistency_evaluation.v3",
      ];
      const discoveryMode =
        discoveryRequiredTypes.some((type) => (counts.get(type) ?? 0) > 0) ||
        [...discoveryReportTypes, ...discoveryConsistencyTypes].some(
          (type) => (counts.get(type) ?? 0) > 0,
        );
      const requiredTypes = discoveryMode ? discoveryRequiredTypes : conceptRequiredTypes;
      const reportTypes = discoveryMode ? discoveryReportTypes : conceptReportTypes;
      const reportSetPresent = [
        ...reportTypes,
        ...(discoveryMode ? discoveryConsistencyTypes : []),
      ].some((type) => (counts.get(type) ?? 0) > 0);
      const evaluatedTypes = [...requiredTypes, ...(reportSetPresent ? reportTypes : [])];
      const missingTypes = evaluatedTypes.filter((type) => counts.get(type) !== 1);
      if (
        discoveryMode &&
        reportSetPresent &&
        discoveryConsistencyTypes.reduce((total, type) => total + (counts.get(type) ?? 0), 0) !== 1
      ) {
        missingTypes.push(discoveryConsistencyTypes.join(" | "));
      }
      const valid = validation.valid && missingTypes.length === 0;
      return {
        schemaVersion: "startup_opportunity.traceability_audit_result.v1",
        schemaBundleVersion: validation.schemaBundleVersion,
        valid,
        inputPath,
        requiredArtifactCounts: Object.fromEntries(
          evaluatedTypes.map((type) => [type, counts.get(type) ?? 0]),
        ),
        reportSetEvaluated: reportSetPresent,
        missingOrDuplicateArtifactTypes: missingTypes,
        bundleErrors: validation.bundleErrors,
        documentErrors: validation.documents.flatMap((entry) => entry.errors),
        referenceErrors: validation.referenceErrors,
      };
    },
    (value) => (isRecord(value) && value.valid === true ? 0 : 1),
  );
}

export async function runBuildReport(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, ["--file", "--runs-root"]);
    const inputPath = path.resolve(repositoryRoot, required(parsed, "--file"));
    const runsRoot = path.resolve(repositoryRoot, parsed.values.get("--runs-root") ?? "runs");
    const value = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
    if (!isRecord(value)) {
      throw new StoreError("report.source_invalid", "build-report input must be an envelope");
    }
    const validator = await createArtifactValidator(repositoryRoot);
    return new ReportRuntime(runsRoot, validator).build({
      reportEnvelope: value as FormalArtifactEnvelope,
    });
  });
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { StoreError, storeErrorResult } from "../artifact-store/store-error.js";
import type { BeliefSummary } from "../run-store/run-store.js";
import type { DocumentBundle } from "../validators/artifact-validator.js";
import { createAdaptationPolicyValidator } from "./adaptation-validator.js";
import {
  type AnalyzeAssessmentGapInput,
  createAssessmentGapAnalyzer,
} from "./assessment-gap-analyzer.js";
import { isRecord } from "./contracts.js";
import { type AnalyzeGapsInput, createGapAnalyzer, type MachineGapCheck } from "./gap-analyzer.js";
import { createPlanRevisionRuntime, type PlanApplyFaultBoundary } from "./plan-runtime.js";
import { createPlanSemanticValidator } from "./plan-validator.js";

interface ParsedArguments {
  readonly values: ReadonlyMap<string, string>;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const values = new Map<string, string>();
  const meaningful = args.filter((arg) => arg !== "--json");
  for (let index = 0; index < meaningful.length; index += 2) {
    const name = meaningful[index];
    const value = meaningful[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new StoreError("command.invalid_arguments", "arguments must be --name value pairs", {
        argument: name ?? null,
      });
    }
    if (values.has(name)) {
      throw new StoreError("command.invalid_arguments", "argument must not be repeated", {
        name,
      });
    }
    values.set(name, value);
  }
  return { values };
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

async function readObject(filename: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(filename, "utf8")) as unknown;
  if (!isRecord(value)) {
    throw new StoreError("command.invalid_arguments", "input file must contain a JSON object", {
      filename,
    });
  }
  return value;
}

function documentBundle(value: unknown, field = "document_bundle"): DocumentBundle {
  if (!isRecord(value) || !Array.isArray(value.documents)) {
    throw new StoreError("command.invalid_arguments", `${field} must be a Document Bundle`);
  }
  return value as unknown as DocumentBundle;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new StoreError("command.invalid_arguments", `${field} must be a string array`);
  }
  return value as readonly string[];
}

async function runCommand(action: () => Promise<{ readonly valid?: boolean } | unknown>) {
  try {
    const result = await action();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return isRecord(result) && result.valid === false ? 1 : 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: "startup_opportunity.command_error.v1",
        status: "failed",
        error: storeErrorResult(error),
      })}\n`,
    );
    return error instanceof StoreError && error.code === "command.invalid_arguments" ? 64 : 1;
  }
}

export async function runValidatePlan(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, ["--bundle"]);
    const bundle = documentBundle(await readObject(required(parsed, "--bundle")));
    return (await createPlanSemanticValidator(repositoryRoot)).validateDocumentBundle(bundle);
  });
}

export async function runValidateAdaptation(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, ["--bundle"]);
    const bundle = documentBundle(await readObject(required(parsed, "--bundle")));
    return (await createAdaptationPolicyValidator(repositoryRoot)).validateDocumentBundle(bundle);
  });
}

export async function runAnalyzeGaps(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, ["--file"]);
    const value = await readObject(required(parsed, "--file"));
    if (
      value.schema_version !== "startup_opportunity.gap_analysis_input.v1" &&
      value.schema_version !== "startup_opportunity.assessment_gap_analysis_input.v1"
    ) {
      throw new StoreError("command.invalid_arguments", "gap input schema_version is unsupported");
    }
    if (value.schema_version === "startup_opportunity.assessment_gap_analysis_input.v1") {
      const assessmentInput: AnalyzeAssessmentGapInput = {
        documentBundle: documentBundle(value.document_bundle),
        snapshotId: String(value.snapshot_id ?? ""),
        createdAt: String(value.created_at ?? ""),
        triggerKind: String(value.trigger_kind ?? "") as AnalyzeAssessmentGapInput["triggerKind"],
        waveId: String(value.wave_id ?? ""),
        triggerEventRef:
          value.trigger_event_ref === null ? null : String(value.trigger_event_ref ?? ""),
        dimensionId: String(value.dimension_id ?? "") as AnalyzeAssessmentGapInput["dimensionId"],
        observedArtifactRefs: stringArray(value.observed_artifact_refs, "observed_artifact_refs"),
        materialNewEvidenceObserved: value.material_new_evidence_observed === true,
        limitations: stringArray(value.limitations ?? [], "limitations"),
      };
      return (await createAssessmentGapAnalyzer(repositoryRoot)).analyze(assessmentInput);
    }
    const checks = Array.isArray(value.machine_checks)
      ? value.machine_checks.map((item) => {
          if (!isRecord(item)) {
            throw new StoreError(
              "command.invalid_arguments",
              "machine_checks entries must be objects",
            );
          }
          return {
            checkId: String(item.check_id ?? ""),
            gapType: String(item.gap_type ?? ""),
            subjectRef: String(item.subject_ref ?? ""),
            basisRefs: stringArray(item.basis_refs, "machine_checks.basis_refs"),
            evidenceRefs: stringArray(item.evidence_refs ?? [], "machine_checks.evidence_refs"),
            decisionImpact: stringArray(item.decision_impact, "machine_checks.decision_impact"),
            severity: String(item.severity ?? ""),
            recommendedUnitTypes: stringArray(
              item.recommended_unit_types ?? [],
              "machine_checks.recommended_unit_types",
            ),
            detail: String(item.detail ?? ""),
          } as MachineGapCheck;
        })
      : [];
    const input: AnalyzeGapsInput = {
      documentBundle: documentBundle(value.document_bundle),
      snapshotId: String(value.snapshot_id ?? ""),
      createdAt: String(value.created_at ?? ""),
      triggerKind: String(value.trigger_kind ?? "") as AnalyzeGapsInput["triggerKind"],
      phase: String(value.phase ?? ""),
      waveId: value.wave_id === null ? null : String(value.wave_id ?? ""),
      triggerEventRef:
        value.trigger_event_ref === null ? null : String(value.trigger_event_ref ?? ""),
      observedArtifactRefs: stringArray(value.observed_artifact_refs, "observed_artifact_refs"),
      materialNewEvidenceObserved: value.material_new_evidence_observed === true,
      repeatedSourceRefs: stringArray(value.repeated_source_refs ?? [], "repeated_source_refs"),
      machineChecks: checks,
    };
    return (await createGapAnalyzer(repositoryRoot)).analyze(input);
  });
}

export async function runApplyPlanRevision(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, ["--file", "--runs-root"]);
    const value = await readObject(required(parsed, "--file"));
    if (value.schema_version !== "startup_opportunity.plan_revision_apply_input.v1") {
      throw new StoreError(
        "command.invalid_arguments",
        "apply input schema_version is unsupported",
      );
    }
    if (!isRecord(value.belief_summary)) {
      throw new StoreError("command.invalid_arguments", "belief_summary is required");
    }
    const runtime = await createPlanRevisionRuntime(
      repositoryRoot,
      parsed.values.get("--runs-root") ?? path.join(repositoryRoot, "runs"),
    );
    return runtime.apply({
      runId: String(value.run_id ?? ""),
      adaptationBundle: documentBundle(value.adaptation_bundle, "adaptation_bundle"),
      adaptationRefs: stringArray(value.adaptation_refs, "adaptation_refs"),
      ...(value.candidate_bundle === undefined
        ? {}
        : { candidateBundle: documentBundle(value.candidate_bundle, "candidate_bundle") }),
      createdAt: String(value.created_at ?? ""),
      checkpointCreatedAt: String(value.checkpoint_created_at ?? ""),
      nextStep: String(value.next_step ?? ""),
      beliefSummary: value.belief_summary as unknown as BeliefSummary,
      ...(typeof value.operation_key === "string" ? { operationKey: value.operation_key } : {}),
      ...(typeof value.fault_at === "string"
        ? { faultAt: value.fault_at as PlanApplyFaultBoundary }
        : {}),
    });
  });
}

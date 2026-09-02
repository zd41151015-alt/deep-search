import { readFile } from "node:fs/promises";
import path from "node:path";
import { StoreError, storeErrorResult } from "../artifact-store/store-error.js";
import { EvidenceStore } from "../evidence-store/evidence-store.js";
import { stderrOperationObserver } from "../runtime/operation-observability.js";
import { createArtifactValidator } from "../validators/artifact-validator.js";
import {
  type BeliefSummary,
  type CheckpointRunInput,
  type ConfirmPreCandidatesInput,
  type CreateResearchHandoffInput,
  type CreateRunInput,
  type ReadPriorInputInput,
  type ReadResearchHandoffInput,
  type ReformDecisionSubjectInput,
  type ResearchScope,
  type RunMode,
  RunStore,
  type TeamCondition,
  type TeamContext,
} from "./run-store.js";

interface ParsedArguments {
  readonly values: ReadonlyMap<string, string>;
  readonly repeated: ReadonlyMap<string, readonly string[]>;
  readonly observe: boolean;
}

function parseArguments(
  args: readonly string[],
  repeatedNames: readonly string[] = [],
  allowObserve = false,
): ParsedArguments {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  let observe = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--observe") {
      if (!allowObserve) {
        throw new StoreError("command.invalid_arguments", "--observe is not supported here");
      }
      observe = true;
      continue;
    }
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new StoreError("command.invalid_arguments", "arguments must be --name value pairs", {
        argument: name ?? null,
      });
    }
    if (repeatedNames.includes(name)) {
      repeated.set(name, [...(repeated.get(name) ?? []), value]);
    } else if (values.has(name)) {
      throw new StoreError("command.invalid_arguments", "argument must not be repeated", { name });
    } else {
      values.set(name, value);
    }
    index += 1;
  }
  return { values, repeated, observe };
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

function optionalPositiveInteger(parsed: ParsedArguments, name: string): number | undefined {
  const value = parsed.values.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new StoreError("command.invalid_arguments", `${name} must be a positive integer`, {
      name,
      value,
    });
  }
  return Number.parseInt(value, 10);
}

function rejectUnknown(parsed: ParsedArguments, allowed: readonly string[]): void {
  const unknown = [...parsed.values.keys(), ...parsed.repeated.keys()].filter(
    (name) => !allowed.includes(name),
  );
  if (unknown.length > 0) {
    throw new StoreError("command.invalid_arguments", "unsupported command arguments", {
      arguments: unknown.sort(),
    });
  }
}

function roots(parsed: ParsedArguments, repositoryRoot: string): string {
  return parsed.values.get("--runs-root") ?? path.join(repositoryRoot, "runs");
}

function writeResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function inputRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreError("command.invalid_arguments", message);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StoreError("command.invalid_arguments", `${field} must be a non-empty string`, {
      field,
    });
  }
  return value;
}

function researchScope(parsed: ParsedArguments): ResearchScope {
  const customerModel = required(parsed, "--customer-model");
  if (!["b2c", "b2b", "b2b2c", "mixed"].includes(customerModel)) {
    throw new StoreError(
      "command.intake_scope_unconfirmed",
      "--customer-model must be one of b2c, b2b, b2b2c, or mixed",
    );
  }
  const targetUsers = parsed.repeated.get("--target-user") ?? [];
  if (targetUsers.length === 0) {
    throw new StoreError(
      "command.intake_scope_unconfirmed",
      "Scope proposal requires at least one --target-user",
    );
  }
  return {
    geography: required(parsed, "--geography"),
    customerModel: customerModel as ResearchScope["customerModel"],
    targetUsers,
    decisionGoal: required(parsed, "--decision-goal"),
    researchLanguage: required(parsed, "--research-language"),
    teamContext: teamContext(parsed),
  };
}

function teamContext(parsed: ParsedArguments): TeamContext {
  const entries = (
    option: string,
    prefix: string,
    sourceKind: TeamCondition["sourceKind"],
    confirmationStatus: TeamCondition["confirmationStatus"],
    reportingDisclosure: string | null,
  ): TeamCondition[] =>
    (parsed.repeated.get(option) ?? []).map((statement, index) => ({
      conditionId: `${prefix}_${index + 1}`,
      statement,
      sourceKind,
      confirmationStatus,
      reportingDisclosure,
    }));
  return {
    hardConstraints: entries(
      "--team-hard-constraint",
      "team_hard_constraint",
      "user_provided",
      "user_confirmed",
      null,
    ),
    knownStrengthsAndGaps: [
      ...entries(
        "--team-known-condition",
        "team_known_condition",
        "user_provided",
        "user_confirmed",
        null,
      ),
      ...entries(
        "--team-confirmed-assumption",
        "team_confirmed_assumption",
        "agent_assumed",
        "user_authorized_assumption",
        "This is a provisional team assumption explicitly authorized by the user.",
      ),
      ...entries(
        "--team-unconfirmed-assumption",
        "team_unconfirmed_assumption",
        "agent_assumed",
        "unconfirmed_assumption",
        "This is an unconfirmed team assumption and must not be presented as a user fact.",
      ),
    ],
    otherTeamConditions: {
      status: "unknown",
      sourceKind: "unknown",
      confirmationStatus: "unknown",
      reportingDisclosure:
        "Team conditions not explicitly captured as hard constraints or known strengths and gaps remain unknown.",
    },
  };
}

async function runCommand(action: () => Promise<unknown>): Promise<number> {
  try {
    writeResult(await action());
    return 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: "startup_opportunity.store_error.v1",
        status: "failed",
        error: storeErrorResult(error),
      })}\n`,
    );
    return error instanceof StoreError && error.code === "command.invalid_arguments" ? 64 : 1;
  }
}

export async function runCreateRun(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args, [
      "--target-user",
      "--team-hard-constraint",
      "--team-known-condition",
      "--team-confirmed-assumption",
      "--team-unconfirmed-assumption",
    ]);
    rejectUnknown(parsed, [
      "--run-id",
      "--mode",
      "--created-at",
      "--parent-run-id",
      "--technical-restart-source-run-id",
      "--technical-restart-source-manifest-hash",
      "--technical-restart-source-terminal-report-source-ref",
      "--technical-restart-source-terminal-report-source-hash",
      "--technical-restart-user-attestation",
      "--runs-root",
      "--geography",
      "--customer-model",
      "--target-user",
      "--decision-goal",
      "--research-language",
      "--team-hard-constraint",
      "--team-known-condition",
      "--team-confirmed-assumption",
      "--team-unconfirmed-assumption",
    ]);
    const mode = required(parsed, "--mode");
    if (mode !== "opportunity_discovery" && mode !== "concept_evidence_assessment") {
      throw new StoreError("command.invalid_arguments", "--mode is not a published Run mode", {
        mode,
      });
    }
    const createdAt = parsed.values.get("--created-at");
    const parentRunId = parsed.values.get("--parent-run-id");
    const technicalRestartSourceRunId = parsed.values.get("--technical-restart-source-run-id");
    const technicalRestartArgs = [
      "--technical-restart-source-run-id",
      "--technical-restart-source-manifest-hash",
      "--technical-restart-source-terminal-report-source-ref",
      "--technical-restart-source-terminal-report-source-hash",
      "--technical-restart-user-attestation",
    ] as const;
    const suppliedTechnicalRestartArgs = technicalRestartArgs.filter((name) =>
      parsed.values.has(name),
    );
    if (
      suppliedTechnicalRestartArgs.length > 0 &&
      suppliedTechnicalRestartArgs.length !== technicalRestartArgs.length
    ) {
      throw new StoreError(
        "command.invalid_arguments",
        "technical restart create-run arguments must be supplied as a complete exact provenance set",
        { supplied: suppliedTechnicalRestartArgs },
      );
    }
    const input: CreateRunInput = {
      runId: required(parsed, "--run-id"),
      mode: mode as RunMode,
      scopeProposal: researchScope(parsed),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(parentRunId === undefined ? {} : { parentRunId }),
      ...(technicalRestartSourceRunId === undefined
        ? {}
        : {
            technicalRestart: {
              sourceRunId: technicalRestartSourceRunId,
              sourceManifestHash: required(parsed, "--technical-restart-source-manifest-hash"),
              sourceTerminalReportSourceRef: required(
                parsed,
                "--technical-restart-source-terminal-report-source-ref",
              ),
              sourceTerminalReportSourceHash: required(
                parsed,
                "--technical-restart-source-terminal-report-source-hash",
              ),
              userAuthorizationAttestation: required(
                parsed,
                "--technical-restart-user-attestation",
              ),
            },
          }),
    };
    const validator = await createArtifactValidator(repositoryRoot);
    return new RunStore(roots(parsed, repositoryRoot), validator).create(input);
  });
}

export async function runConfirmScope(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, [
      "--run-id",
      "--expected-scope-proposal-revision",
      "--expected-scope-proposal-ref",
      "--expected-scope-proposal-hash",
      "--user-confirmation-attestation",
      "--confirmed-at",
      "--runs-root",
    ]);
    const expectedScopeProposalRevision = Number(
      required(parsed, "--expected-scope-proposal-revision"),
    );
    if (!Number.isInteger(expectedScopeProposalRevision) || expectedScopeProposalRevision < 1) {
      throw new StoreError(
        "command.invalid_arguments",
        "--expected-scope-proposal-revision must be a positive integer",
      );
    }
    const validator = await createArtifactValidator(repositoryRoot);
    const confirmedAt = parsed.values.get("--confirmed-at");
    return new RunStore(roots(parsed, repositoryRoot), validator).confirmScope({
      runId: required(parsed, "--run-id"),
      expectedScopeProposalRevision,
      expectedScopeProposalRef: required(parsed, "--expected-scope-proposal-ref"),
      expectedScopeProposalHash: required(parsed, "--expected-scope-proposal-hash"),
      userConfirmationAttestation: required(parsed, "--user-confirmation-attestation"),
      ...(confirmedAt === undefined ? {} : { confirmedAt }),
    });
  });
}

export async function runConfirmPreCandidates(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args, [
      "--selected-pre-candidate-ref",
      "--follow-up-interest-pre-candidate-ref",
    ]);
    rejectUnknown(parsed, [
      "--run-id",
      "--expected-fan-in-ref",
      "--expected-fan-in-hash",
      "--selected-pre-candidate-ref",
      "--follow-up-interest-pre-candidate-ref",
      "--next-action",
      "--user-confirmation-attestation",
      "--confirmed-at",
      "--runs-root",
    ]);
    const confirmedAt = parsed.values.get("--confirmed-at");
    const input: ConfirmPreCandidatesInput = {
      runId: required(parsed, "--run-id"),
      expectedFanInRef: required(parsed, "--expected-fan-in-ref"),
      expectedFanInHash: required(parsed, "--expected-fan-in-hash"),
      selectedPreCandidateRefs: parsed.repeated.get("--selected-pre-candidate-ref") ?? [],
      followUpInterestPreCandidateRefs:
        parsed.repeated.get("--follow-up-interest-pre-candidate-ref") ?? [],
      nextAction: required(parsed, "--next-action") as ConfirmPreCandidatesInput["nextAction"],
      userConfirmationAttestation: required(parsed, "--user-confirmation-attestation"),
      ...(confirmedAt === undefined ? {} : { confirmedAt }),
    };
    const validator = await createArtifactValidator(repositoryRoot);
    return new RunStore(roots(parsed, repositoryRoot), validator).confirmPreCandidates(input);
  });
}

export async function runProposeScope(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args, [
      "--target-user",
      "--team-hard-constraint",
      "--team-known-condition",
      "--team-confirmed-assumption",
      "--team-unconfirmed-assumption",
    ]);
    rejectUnknown(parsed, [
      "--run-id",
      "--expected-scope-revision",
      "--geography",
      "--customer-model",
      "--target-user",
      "--decision-goal",
      "--research-language",
      "--team-hard-constraint",
      "--team-known-condition",
      "--team-confirmed-assumption",
      "--team-unconfirmed-assumption",
      "--reason",
      "--proposed-at",
      "--runs-root",
    ]);
    const expectedScopeRevision = Number(required(parsed, "--expected-scope-revision"));
    if (!Number.isInteger(expectedScopeRevision) || expectedScopeRevision < 1) {
      throw new StoreError(
        "command.invalid_arguments",
        "--expected-scope-revision must be a positive integer",
      );
    }
    const validator = await createArtifactValidator(repositoryRoot);
    const proposedAt = parsed.values.get("--proposed-at");
    return new RunStore(roots(parsed, repositoryRoot), validator).proposeScope({
      runId: required(parsed, "--run-id"),
      expectedScopeRevision,
      scopeProposal: researchScope(parsed),
      reason: required(parsed, "--reason"),
      ...(proposedAt === undefined ? {} : { proposedAt }),
    });
  });
}

export async function runLoadRun(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args, [], true);
    rejectUnknown(parsed, ["--run-id", "--runs-root"]);
    const validator = await createArtifactValidator(repositoryRoot);
    return new RunStore(roots(parsed, repositoryRoot), validator).load(
      required(parsed, "--run-id"),
      {
        observe: stderrOperationObserver(parsed.observe),
      },
    );
  });
}

export async function runStatusRun(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, ["--run-id", "--runs-root"]);
    const validator = await createArtifactValidator(repositoryRoot);
    return new RunStore(roots(parsed, repositoryRoot), validator).status(
      required(parsed, "--run-id"),
    );
  });
}

export async function runAdmitPriorInput(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, [
      "--run-id",
      "--prior-input-id",
      "--source-run-id",
      "--source-artifact-path",
      "--target-artifact-path",
      "--consumer",
      "--reason",
      "--admitted-at",
      "--runs-root",
    ]);
    const admittedAt = parsed.values.get("--admitted-at");
    const validator = await createArtifactValidator(repositoryRoot);
    return new RunStore(roots(parsed, repositoryRoot), validator).admitPriorInput({
      runId: required(parsed, "--run-id"),
      priorInputId: required(parsed, "--prior-input-id"),
      sourceRunId: required(parsed, "--source-run-id"),
      sourceArtifactPath: required(parsed, "--source-artifact-path"),
      targetArtifactPath: required(parsed, "--target-artifact-path"),
      consumer: required(parsed, "--consumer") as "discovery_maps" | "discovery_candidates",
      reason: required(parsed, "--reason"),
      ...(admittedAt === undefined ? {} : { admittedAt }),
    });
  });
}

export async function runReadPriorInput(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, ["--run-id", "--admission-ref", "--consumed-at", "--runs-root"]);
    const consumedAt = parsed.values.get("--consumed-at");
    const input: ReadPriorInputInput = {
      runId: required(parsed, "--run-id"),
      admissionRef: required(parsed, "--admission-ref"),
      ...(consumedAt === undefined ? {} : { consumedAt }),
    };
    const validator = await createArtifactValidator(repositoryRoot);
    return new RunStore(roots(parsed, repositoryRoot), validator).readPriorInput(input);
  });
}

export async function runCreateResearchHandoff(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, ["--file", "--runs-root"]);
    const request = inputRecord(
      JSON.parse(await readFile(required(parsed, "--file"), "utf8")) as unknown,
      "research handoff input must be a JSON object",
    );
    if (!Array.isArray(request.items) || request.items.length === 0) {
      throw new StoreError(
        "command.invalid_arguments",
        "research handoff input requires a non-empty items array",
      );
    }
    const items = request.items.map((value, index) => {
      const item = inputRecord(value, `research handoff item ${index} must be an object`);
      const targetUnitId = item.target_unit_id;
      const targetResearchGoal = item.target_research_goal;
      const targetArtifactRef = item.target_artifact_ref;
      return {
        itemId: requiredString(item, "item_id"),
        sourceArtifactPath: requiredString(item, "source_artifact_path"),
        role: requiredString(item, "role") as CreateResearchHandoffInput["items"][number]["role"],
        expectedSourceByteHash: requiredString(item, "expected_source_byte_hash"),
        expectedSourceContentHash: requiredString(item, "expected_source_content_hash"),
        freshnessDisposition: requiredString(
          item,
          "freshness_disposition",
        ) as CreateResearchHandoffInput["items"][number]["freshnessDisposition"],
        applicabilityDisposition: requiredString(
          item,
          "applicability_disposition",
        ) as CreateResearchHandoffInput["items"][number]["applicabilityDisposition"],
        revalidationStatus: requiredString(
          item,
          "revalidation_status",
        ) as CreateResearchHandoffInput["items"][number]["revalidationStatus"],
        ...(targetUnitId === undefined
          ? {}
          : { targetUnitId: requiredString(item, "target_unit_id") }),
        ...(targetResearchGoal === undefined
          ? {}
          : { targetResearchGoal: requiredString(item, "target_research_goal") }),
        ...(targetArtifactRef === undefined
          ? {}
          : { targetArtifactRef: requiredString(item, "target_artifact_ref") }),
      };
    });
    const capturedAt = request.captured_at;
    const input: CreateResearchHandoffInput = {
      runId: requiredString(request, "run_id"),
      handoffId: requiredString(request, "handoff_id"),
      sourceRunId: requiredString(request, "source_run_id"),
      userAuthorizationAttestation: requiredString(request, "user_authorization_attestation"),
      targetPurpose: requiredString(request, "target_purpose"),
      items,
      ...(capturedAt === undefined ? {} : { capturedAt: requiredString(request, "captured_at") }),
    };
    const validator = await createArtifactValidator(repositoryRoot);
    return new RunStore(roots(parsed, repositoryRoot), validator).createResearchHandoff(input);
  });
}

export async function runReadResearchHandoff(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args, ["--item-id"]);
    rejectUnknown(parsed, [
      "--run-id",
      "--handoff-ref",
      "--item-id",
      "--consumed-at",
      "--runs-root",
    ]);
    const consumedAt = parsed.values.get("--consumed-at");
    const input: ReadResearchHandoffInput = {
      runId: required(parsed, "--run-id"),
      handoffRef: required(parsed, "--handoff-ref"),
      itemIds: parsed.repeated.get("--item-id") ?? [],
      ...(consumedAt === undefined ? {} : { consumedAt }),
    };
    const validator = await createArtifactValidator(repositoryRoot);
    return new RunStore(roots(parsed, repositoryRoot), validator).readResearchHandoff(input);
  });
}

export async function runReformDecisionSubject(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args, ["--reformation-input-ref"]);
    rejectUnknown(parsed, [
      "--run-id",
      "--terminal-snapshot-ref",
      "--terminal-subject-id",
      "--reformed-subject-ref",
      "--reformation-input-ref",
      "--reason",
      "--reformed-at",
      "--runs-root",
    ]);
    const reformedAt = parsed.values.get("--reformed-at");
    const input: ReformDecisionSubjectInput = {
      runId: required(parsed, "--run-id"),
      terminalSnapshotRef: required(parsed, "--terminal-snapshot-ref"),
      terminalSubjectId: required(parsed, "--terminal-subject-id"),
      reformedSubjectRef: required(parsed, "--reformed-subject-ref"),
      reformationInputRefs: parsed.repeated.get("--reformation-input-ref") ?? [],
      reason: required(parsed, "--reason"),
      ...(reformedAt === undefined ? {} : { reformedAt }),
    };
    const validator = await createArtifactValidator(repositoryRoot);
    return new RunStore(roots(parsed, repositoryRoot), validator).reformDecisionSubject(input);
  });
}

export async function runRecordEvidence(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, [
      "--run-id",
      "--unit-id",
      "--unit-attempt",
      "--source-url",
      "--source-uri",
      "--acquisition-goal",
      "--content-file",
      "--recorded-at",
      "--operation-key",
      "--runs-root",
    ]);
    const runsRoot = roots(parsed, repositoryRoot);
    const runId = required(parsed, "--run-id");
    const validator = await createArtifactValidator(repositoryRoot);
    await new RunStore(runsRoot, validator).assertResearchExecutionAllowed(runId);
    const store = new EvidenceStore(runsRoot);
    const recordedAt = parsed.values.get("--recorded-at");
    const suppliedOperationKey = parsed.values.get("--operation-key");
    const sourceUrl = parsed.values.get("--source-url");
    const sourceUri = parsed.values.get("--source-uri");
    const unitAttempt = optionalPositiveInteger(parsed, "--unit-attempt");
    const sourceCount = [sourceUrl, sourceUri].filter((value) => value !== undefined).length;
    if (sourceCount !== 1) {
      throw new StoreError(
        "command.invalid_arguments",
        "record-evidence requires exactly one of --source-url or --source-uri",
      );
    }
    const common = {
      runId,
      unitId: required(parsed, "--unit-id"),
      ...(unitAttempt === undefined ? {} : { unitAttempt }),
      acquisitionGoal: required(parsed, "--acquisition-goal"),
      rawContent: await readFile(required(parsed, "--content-file")),
      ...(recordedAt === undefined ? {} : { recordedAt }),
      ...(suppliedOperationKey === undefined ? {} : { operationKey: suppliedOperationKey }),
    };
    return store.record({
      ...common,
      source:
        sourceUrl !== undefined
          ? { kind: "public_url", canonical_url: sourceUrl }
          : { kind: "user_provided", canonical_uri: sourceUri ?? "" },
    });
  });
}

export async function runPublishArtifact(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, ["--file", "--runs-root"]);
    const value = JSON.parse(await readFile(required(parsed, "--file"), "utf8")) as unknown;
    const validator = await createArtifactValidator(repositoryRoot);
    const store = new RunStore(roots(parsed, repositoryRoot), validator);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new StoreError("command.invalid_arguments", "artifact input must be a JSON object");
    }
    const document = value as Record<string, unknown>;
    if (Array.isArray(document.documents)) {
      const envelopes = document.documents.map((entry) => {
        if (
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          !("document" in entry) ||
          !entry.document ||
          typeof entry.document !== "object" ||
          Array.isArray(entry.document)
        ) {
          throw new StoreError(
            "command.invalid_arguments",
            "publication bundle entries must contain formal envelopes",
          );
        }
        return entry.document as import("../artifact-store/artifact-store.js").FormalArtifactEnvelope;
      });
      const runIds = [...new Set(envelopes.map((envelope) => envelope.run_id))];
      if (runIds.length !== 1 || runIds[0] === undefined) {
        throw new StoreError(
          "command.invalid_arguments",
          "publication bundle envelopes must belong to one Run",
        );
      }
      if (envelopes.length === 1) {
        const envelope = envelopes[0];
        if (envelope === undefined) {
          throw new StoreError(
            "command.invalid_arguments",
            "publication bundle must contain a formal envelope",
          );
        }
        return store.publishArtifact({ runId: runIds[0], envelope });
      }
      return store.publishArtifactBundle({ runId: runIds[0], envelopes });
    }
    const envelope =
      document as import("../artifact-store/artifact-store.js").FormalArtifactEnvelope;
    return store.publishArtifact({ runId: envelope.run_id, envelope });
  });
}

export async function runCheckpointRun(
  args: readonly string[],
  repositoryRoot = process.cwd(),
): Promise<number> {
  return runCommand(async () => {
    const parsed = parseArguments(args);
    rejectUnknown(parsed, ["--file", "--runs-root"]);
    const value = JSON.parse(await readFile(required(parsed, "--file"), "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new StoreError("command.invalid_arguments", "checkpoint input must be a JSON object");
    }
    const record = value as Record<string, unknown>;
    const belief = record.belief_summary;
    if (typeof belief !== "object" || belief === null || Array.isArray(belief)) {
      throw new StoreError("command.invalid_arguments", "checkpoint belief_summary is required");
    }
    const input: CheckpointRunInput = {
      runId: String(record.run_id ?? ""),
      checkpointId: String(record.checkpoint_id ?? ""),
      createdAt: String(record.created_at ?? ""),
      nextStep: String(record.next_step ?? ""),
      beliefSummary: belief as unknown as BeliefSummary,
      unresolvedGapRefs: Array.isArray(record.unresolved_gap_refs)
        ? (record.unresolved_gap_refs as string[])
        : [],
      inputRefs: Array.isArray(record.input_refs) ? (record.input_refs as string[]) : [],
    };
    const validator = await createArtifactValidator(repositoryRoot);
    return new RunStore(roots(parsed, repositoryRoot), validator).checkpoint(input);
  });
}

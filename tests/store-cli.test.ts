import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalContentHash } from "../harness/src/index.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function runScript(script: string, args: readonly string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

test("Harness and Skill G0.3 entries create, record, checkpoint, and reopen a real Run", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-store-cli-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "cli-store-run";
  const create = runScript("harness/src/cli.ts", [
    "create-run",
    "--runs-root",
    runsRoot,
    "--run-id",
    runId,
    "--mode",
    "concept_evidence_assessment",
    "--geography",
    "United States",
    "--customer-model",
    "b2c",
    "--target-user",
    "synthetic household user",
    "--decision-goal",
    "decide whether to investigate the synthetic concept",
    "--research-language",
    "en-US",
    "--created-at",
    "2026-07-23T12:00:00Z",
  ]);
  assert.equal(create.status, 0, create.stderr);
  const created = JSON.parse(create.stdout) as {
    status: string;
    workingDirectory: string;
    scopeProposalRef: string;
    scopeProposalHash: string;
    manifest: { status: string; scope_revision: number };
  };
  assert.equal(created.status, "created");
  assert.equal(created.manifest.status, "awaiting_scope_confirmation");
  assert.equal(created.workingDirectory, `dist/research-working/${runId}`);
  await access(path.join(root, created.workingDirectory));
  await assert.rejects(access(path.join(runsRoot, runId, "dist")));

  const initialStatus = runScript("harness/src/cli.ts", [
    "status-run",
    "--runs-root",
    runsRoot,
    "--run-id",
    runId,
  ]);
  assert.equal(initialStatus.status, 0, initialStatus.stderr);
  assert.equal(
    (JSON.parse(initialStatus.stdout) as { workingDirectory: string }).workingDirectory,
    `dist/research-working/${runId}`,
  );

  const confirm = runScript(".agents/skills/startup-opportunity/scripts/confirm-scope.ts", [
    "--runs-root",
    runsRoot,
    "--run-id",
    runId,
    "--expected-scope-proposal-revision",
    String(created.manifest.scope_revision),
    "--expected-scope-proposal-ref",
    created.scopeProposalRef,
    "--expected-scope-proposal-hash",
    created.scopeProposalHash,
    "--user-confirmation-attestation",
    "The CLI fixture caller attests that the user confirmed the exact displayed Scope proposal.",
    "--confirmed-at",
    "2026-07-23T12:00:30Z",
  ]);
  assert.equal(confirm.status, 0, confirm.stderr);
  assert.equal((JSON.parse(confirm.stdout) as { status: string }).status, "confirmed");

  const evidence = runScript(".agents/skills/startup-opportunity/scripts/record-evidence.ts", [
    "--runs-root",
    runsRoot,
    "--run-id",
    runId,
    "--unit-id",
    "cli_unit_001",
    "--source-url",
    "https://example.com/cli#fragment",
    "--acquisition-goal",
    "Exercise the operational Evidence substrate entry.",
    "--content-file",
    "tests/fixtures/store/evidence-source.txt",
    "--recorded-at",
    "2026-07-23T12:01:00Z",
  ]);
  assert.equal(evidence.status, 0, evidence.stderr);
  assert.equal((JSON.parse(evidence.stdout) as { status: string }).status, "recorded");

  const materializedEvidence = runScript("harness/src/cli.ts", [
    "record-evidence",
    "--runs-root",
    runsRoot,
    "--run-id",
    runId,
    "--unit-id",
    "cli_unit_002",
    "--unit-attempt",
    "2",
    "--source-uri",
    "urn:startup-opportunity:user-provided:cli-fixture-002",
    "--acquisition-goal",
    "Exercise the G1.2 user-provided substrate contract.",
    "--content-file",
    "tests/fixtures/store/evidence-source.txt",
    "--recorded-at",
    "2026-07-23T12:01:30Z",
  ]);
  assert.equal(materializedEvidence.status, 0, materializedEvidence.stderr);
  const materializedRecord = (
    JSON.parse(materializedEvidence.stdout) as {
      record: { schema_version: string; unit_attempt: number };
    }
  ).record;
  assert.equal(materializedRecord.schema_version, "startup_opportunity.evidence_store_record.v2");
  assert.equal(materializedRecord.unit_attempt, 2);

  const artifactDocument = {
    schema_version: "startup_opportunity.event.v1",
    event_id: "cli_g1_2_artifact_001",
    run_id: runId,
    event_type: "decision_context_written",
    timestamp: "2026-07-23T12:01:45Z",
    actor: "harness",
    reason: "Synthetic CLI publication fixture.",
    artifact_refs: [],
  };
  const artifactFile = path.join(root, "artifact-envelope.json");
  await writeFile(
    artifactFile,
    `${JSON.stringify({
      schema_version: "startup_opportunity.artifact_envelope.current",
      artifact_type: artifactDocument.schema_version,
      artifact_path: "artifacts/cli-g1-2-event.json",
      run_id: runId,
      created_at: artifactDocument.timestamp,
      producer_role: "harness",
      input_refs: [],
      content_hash: canonicalContentHash(artifactDocument),
      document: artifactDocument,
    })}\n`,
  );
  const publication = runScript(".agents/skills/startup-opportunity/scripts/publish-artifact.ts", [
    "--runs-root",
    runsRoot,
    "--file",
    artifactFile,
  ]);
  assert.equal(publication.status, 0, publication.stderr);
  assert.equal((JSON.parse(publication.stdout) as { status: string }).status, "published");

  const bundledArtifactDocument = {
    ...artifactDocument,
    event_id: "cli_g1_2_artifact_singleton_bundle_001",
    timestamp: "2026-07-23T12:01:46Z",
    reason: "Synthetic singleton document bundle publication fixture.",
  };
  const bundledEnvelope = {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: bundledArtifactDocument.schema_version,
    artifact_path: "artifacts/cli-g1-2-singleton-bundle-event.json",
    run_id: runId,
    created_at: bundledArtifactDocument.timestamp,
    producer_role: "harness",
    input_refs: [],
    content_hash: canonicalContentHash(bundledArtifactDocument),
    document: bundledArtifactDocument,
  };
  const singletonBundleFile = path.join(root, "artifact-singleton-bundle.json");
  await writeFile(
    singletonBundleFile,
    `${JSON.stringify({
      schema_version: "startup_opportunity.document_bundle.current",
      documents: [{ path: bundledEnvelope.artifact_path, document: bundledEnvelope }],
    })}\n`,
  );
  const singletonPublication = runScript("harness/src/cli.ts", [
    "publish-artifact",
    "--runs-root",
    runsRoot,
    "--file",
    singletonBundleFile,
  ]);
  assert.equal(singletonPublication.status, 0, singletonPublication.stderr);
  assert.equal((JSON.parse(singletonPublication.stdout) as { status: string }).status, "published");
  const singletonReplay = runScript(
    ".agents/skills/startup-opportunity/scripts/publish-artifact.ts",
    ["--runs-root", runsRoot, "--file", singletonBundleFile],
  );
  assert.equal(singletonReplay.status, 0, singletonReplay.stderr);
  assert.equal(
    (JSON.parse(singletonReplay.stdout) as { status: string }).status,
    "idempotent_replay",
  );

  const checkpointFile = path.join(root, "checkpoint-input.json");
  await writeFile(
    checkpointFile,
    `${JSON.stringify({
      run_id: runId,
      checkpoint_id: "checkpoint_cli_002",
      created_at: "2026-07-23T12:02:00Z",
      next_step: "Continue from the next safe boundary.",
      belief_summary: {
        current_belief: "No research conclusion has been formed.",
        evidence_that_changed_belief: [],
        unchanged_assumptions: [],
        remaining_disagreement: [],
        next_decision_relevant_question: "What artifact is needed next?",
      },
      unresolved_gap_refs: [],
      input_refs: [],
    })}\n`,
  );
  const checkpoint = runScript(".agents/skills/startup-opportunity/scripts/checkpoint-run.ts", [
    "--runs-root",
    runsRoot,
    "--file",
    checkpointFile,
  ]);
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  assert.equal(
    (JSON.parse(checkpoint.stdout) as { checkpointRef: string }).checkpointRef,
    "checkpoints/checkpoint-cli-002.json",
  );

  const load = runScript(".agents/skills/startup-opportunity/scripts/load-run.ts", [
    "--runs-root",
    runsRoot,
    "--run-id",
    runId,
  ]);
  assert.equal(load.status, 0, load.stderr);
  const loaded = JSON.parse(load.stdout) as {
    recovered: boolean;
    lastValidCheckpointRef: string;
  };
  assert.equal(loaded.recovered, false);
  assert.equal(loaded.lastValidCheckpointRef, "checkpoints/checkpoint-cli-002.json");
  assert.ok((await readFile(path.join(runsRoot, runId, "manifest.json"), "utf8")).length > 0);
});

test("confirm-pre-candidates help describes append-ordered authority and orthogonal follow-up interest", async () => {
  const help = runScript("harness/src/cli.ts", ["confirm-pre-candidates", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /follow-up-interest-pre-candidate-ref/u);
  assert.match(help.stdout, /current Manifest authority/u);
  assert.match(help.stdout, /metadata only/u);
});

test("G0.3 command entries reject incomplete arguments with structured failure", () => {
  for (const script of [
    ".agents/skills/startup-opportunity/scripts/create-run.ts",
    ".agents/skills/startup-opportunity/scripts/load-run.ts",
    ".agents/skills/startup-opportunity/scripts/record-evidence.ts",
    ".agents/skills/startup-opportunity/scripts/publish-artifact.ts",
    ".agents/skills/startup-opportunity/scripts/checkpoint-run.ts",
  ]) {
    const result = runScript(script, []);
    assert.equal(result.status, 64, `${script}: ${result.stderr}`);
    const failure = JSON.parse(result.stderr) as { status: string; error: { code: string } };
    assert.equal(failure.status, "failed");
    assert.equal(failure.error.code, "command.invalid_arguments");
  }
});

test("create-run persists only the three scoped team-context categories with provenance", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-team-scope-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const result = runScript("harness/src/cli.ts", [
    "create-run",
    "--runs-root",
    runsRoot,
    "--run-id",
    "team-context-synthetic",
    "--mode",
    "opportunity_discovery",
    "--geography",
    "United States",
    "--customer-model",
    "b2c",
    "--target-user",
    "synthetic user",
    "--decision-goal",
    "compare synthetic opportunities",
    "--research-language",
    "en-US",
    "--team-hard-constraint",
    "must launch within six months",
    "--team-known-condition",
    "strong customer discovery capability",
    "--team-confirmed-assumption",
    "temporary assumption: founder can access a channel partner",
    "--team-unconfirmed-assumption",
    "unconfirmed assumption: specialized compliance expertise is available",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const decisions = (
    await readFile(path.join(runsRoot, "team-context-synthetic", "decisions.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const scope = decisions[0]?.scope as Record<string, unknown>;
  assert.deepEqual(Object.keys(scope).sort(), [
    "customer_model",
    "decision_goal",
    "geography",
    "research_language",
    "revision",
    "target_users",
    "team_context",
  ]);
  const team = scope.team_context as Record<string, unknown>;
  assert.equal(
    (team.hard_constraints as Record<string, unknown>[])[0]?.source_kind,
    "user_provided",
  );
  assert.equal((team.known_strengths_and_gaps as Record<string, unknown>[]).length, 3);
  assert.equal(
    (team.known_strengths_and_gaps as Record<string, unknown>[])[1]?.confirmation_status,
    "user_authorized_assumption",
  );
  assert.equal(
    (team.known_strengths_and_gaps as Record<string, unknown>[])[2]?.confirmation_status,
    "unconfirmed_assumption",
  );
  assert.equal((team.other_team_conditions as Record<string, unknown>).status, "unknown");
});

test("create-run rejects retired product and build identity options", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-store-cli-identity-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  for (const [option, value] of [
    ["--skill-version", "1.0.0"],
    ["--policy-version", "1.0.0"],
    ["--git-commit", "0123456789012345678901234567890123456789"],
  ] as const) {
    const result = runScript("harness/src/cli.ts", [
      "create-run",
      "--runs-root",
      path.join(root, "runs"),
      "--run-id",
      `identity-option-${option.slice(2)}`,
      "--mode",
      "opportunity_discovery",
      "--geography",
      "United States",
      "--customer-model",
      "b2c",
      "--target-user",
      "synthetic user",
      "--decision-goal",
      "test retired option rejection",
      "--research-language",
      "en-US",
      option,
      value,
    ]);
    assert.equal(result.status, 64, `${option}: ${result.stderr}`);
    const failure = JSON.parse(result.stderr) as { status: string; error: { code: string } };
    assert.equal(failure.status, "failed");
    assert.equal(failure.error.code, "command.invalid_arguments");
  }
});

test("create-run rejects unconfirmed broad-market scope instead of inferring it", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-store-cli-scope-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = runScript("harness/src/cli.ts", [
    "create-run",
    "--runs-root",
    path.join(root, "runs"),
    "--run-id",
    "broad-education-scope-synthetic",
    "--mode",
    "opportunity_discovery",
    "--customer-model",
    "b2c",
    "--target-user",
    "synthetic education user",
    "--decision-goal",
    "research education industry opportunities",
    "--research-language",
    "zh-CN",
  ]);
  assert.equal(result.status, 64, result.stderr);
  const failure = JSON.parse(result.stderr) as { error: { code: string } };
  assert.equal(failure.error.code, "command.invalid_arguments");
});

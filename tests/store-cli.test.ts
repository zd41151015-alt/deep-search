import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    "--created-at",
    "2026-07-23T12:00:00Z",
  ]);
  assert.equal(create.status, 0, create.stderr);
  assert.equal((JSON.parse(create.stdout) as { status: string }).status, "created");

  const evidence = runScript(".agents/skills/startup-opportunity/scripts/record-evidence.ts", [
    "--runs-root",
    runsRoot,
    "--run-id",
    runId,
    "--unit-id",
    "cli_unit_001",
    "--source-url",
    "https://example.com/cli#fragment",
    "--research-goal",
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
    "--source-uri",
    "urn:startup-opportunity:user-provided:cli-fixture-002",
    "--research-goal",
    "Exercise the G1.2 user-provided substrate contract.",
    "--content-file",
    "tests/fixtures/store/evidence-source.txt",
    "--recorded-at",
    "2026-07-23T12:01:30Z",
  ]);
  assert.equal(materializedEvidence.status, 0, materializedEvidence.stderr);
  assert.equal(
    (JSON.parse(materializedEvidence.stdout) as { record: { schema_version: string } }).record
      .schema_version,
    "startup_opportunity.evidence_store_record.v2",
  );

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
      option,
      value,
    ]);
    assert.equal(result.status, 64, `${option}: ${result.stderr}`);
    const failure = JSON.parse(result.stderr) as { status: string; error: { code: string } };
    assert.equal(failure.status, "failed");
    assert.equal(failure.error.code, "command.invalid_arguments");
  }
});

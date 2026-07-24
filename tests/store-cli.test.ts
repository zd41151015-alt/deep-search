import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
    "--url",
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
    ".agents/skills/startup-opportunity/scripts/checkpoint-run.ts",
  ]) {
    const result = runScript(script, []);
    assert.equal(result.status, 64, `${script}: ${result.stderr}`);
    const failure = JSON.parse(result.stderr) as { status: string; error: { code: string } };
    assert.equal(failure.status, "failed");
    assert.equal(failure.error.code, "command.invalid_arguments");
  }
});

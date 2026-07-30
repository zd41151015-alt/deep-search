import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function runScript(script: string, args: readonly string[], input?: string) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
  });
}

test("operations, sample, Plugin, and current-state documents share one repo-local entry", async () => {
  const [readme, operations, samples, pluginDecision, fixture, progress] = await Promise.all([
    readFile(path.join(repositoryRoot, "README.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs/operations.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs/sample-runs.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs/plugin-decision.md"), "utf8"),
    readFile(path.join(repositoryRoot, "tests/fixtures/g4/synthetic-evidence.txt"), "utf8"),
    readFile(path.join(repositoryRoot, "startup-opportunity-implementation-progress.md"), "utf8"),
  ]);

  for (const action of ["discover", "assess", "resume", "status"]) {
    assert.ok(readme.includes(`action: ${action}`));
  }
  for (const surface of ["Codex Desktop", "CLI", "IDE"]) {
    assert.ok(operations.includes(surface));
  }
  assert.match(operations, /\$startup-opportunity/);
  assert.match(operations, /hooks-disabled|Hooks Optionality/);
  assert.match(operations, /npm ci/);
  assert.match(samples, /SYNTHETIC \/ UNVERIFIED/);
  assert.match(samples, /example\.invalid/);
  assert.match(fixture, /SYNTHETIC \/ UNVERIFIED/);
  assert.match(pluginDecision, /does not package a Codex Plugin/);
  assert.match(pluginDecision, /REPO_LOCAL_NOT_PACKAGED/);
  assert.match(pluginDecision, /No cross-team distribution/);
  assert.match(readme, /060029fbcfc6e4b543873642b7e3657c67c913af/);
  assert.match(readme, /fresh independent delta-aware G4 acceptance/);
  assert.match(readme, /G0-G4 closes the RFC's complete first-version implementation objective/);
  assert.doesNotMatch(readme, /G4 remains a Construction Stage candidate/);
  for (const retainedRecord of [
    "019fb1f3-9e4a-7d00-8239-28dcba107a08",
    "019fb221-9101-7d63-8f33-6bbc2740bd37",
    "cafe973d-042e-459d-a509-4be7e48156e4:3",
    "P1-G4-001",
    "P1-G4-002",
    "P1-G4-003",
    "SECURITY_VALIDATION_NOT_RUN",
    "REPO_LOCAL_NOT_PACKAGED",
    "startup-opportunity-controller-project-v2",
    "1594a37e8840f2eee1b2c006588b723a81f06076c0887430208c2f66b5c92da1",
  ]) {
    assert.ok(progress.includes(retainedRecord), retainedRecord);
  }
  assert.match(progress, /fresh independent delta-aware G4 acceptance/);
  assert.match(progress, /G0-G4.*首版implementation objective/);
  assert.match(progress, /automation.*`PAUSED`.*保留/);
  for (const document of [readme, pluginDecision, progress]) {
    assert.doesNotMatch(document, /PROJECT_WIDE_COMPLETION_SCOPE_AUDIT_NOT_RUN/);
    assert.doesNotMatch(document, /separate independent completion-scope audit/);
  }
  await assert.rejects(access(path.join(repositoryRoot, ".codex-plugin/plugin.json")));
});

test("explicit create, status, Evidence, and recovery remain usable with hooks disabled", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g4-operational-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const runId = "g4-hooks-disabled-synthetic";

  const projectConfig = await readFile(path.join(repositoryRoot, ".codex/config.toml"), "utf8");
  const disabled = parseToml(projectConfig.replace("hooks = true", "hooks = false")) as {
    features?: { hooks?: boolean };
  };
  assert.equal(disabled.features?.hooks, false);

  const hook = runScript(
    ".codex/hooks/research-guard.ts",
    ["pre-tool-use"],
    JSON.stringify({
      cwd: repositoryRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm run harness -- doctor --json" },
    }),
  );
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, "");

  const create = runScript("harness/src/cli.ts", [
    "create-run",
    "--run-id",
    runId,
    "--mode",
    "concept_evidence_assessment",
    "--created-at",
    "2026-07-30T01:00:00Z",
    "--runs-root",
    runsRoot,
  ]);
  assert.equal(create.status, 0, create.stderr);

  const status = runScript(".agents/skills/startup-opportunity/scripts/status-run.ts", [
    "--run-id",
    runId,
    "--runs-root",
    runsRoot,
  ]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(
    (JSON.parse(status.stdout) as { schemaVersion?: unknown }).schemaVersion,
    "startup_opportunity.status_run_result.v1",
  );

  const evidence = runScript("harness/src/cli.ts", [
    "record-evidence",
    "--run-id",
    runId,
    "--unit-id",
    "unit_g4_synthetic",
    "--source-url",
    "https://example.invalid/g4-operational-unverified",
    "--research-goal",
    "Exercise the explicit hooks-disabled Evidence path only.",
    "--content-file",
    "tests/fixtures/g4/synthetic-evidence.txt",
    "--recorded-at",
    "2026-07-30T01:01:00Z",
    "--runs-root",
    runsRoot,
  ]);
  assert.equal(evidence.status, 0, evidence.stderr);
  assert.equal((JSON.parse(evidence.stdout) as { status?: unknown }).status, "recorded");

  const load = runScript(".agents/skills/startup-opportunity/scripts/load-run.ts", [
    "--run-id",
    runId,
    "--runs-root",
    runsRoot,
  ]);
  assert.equal(load.status, 0, load.stderr);
  const loaded = JSON.parse(load.stdout) as { recovered?: unknown; manifest?: { mode?: unknown } };
  assert.equal(loaded.recovered, false);
  assert.equal(loaded.manifest?.mode, "concept_evidence_assessment");
});

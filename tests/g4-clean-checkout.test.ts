import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseToml } from "smol-toml";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function environment(): Record<string, string> {
  const values = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return {
    ...Object.fromEntries(values),
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  options: { readonly input?: string; readonly timeout?: number } = {},
) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment(),
    input: options.input,
    timeout: options.timeout ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function candidateSnapshot(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g4-checkout-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, "repository");
  await mkdir(runtimeRoot);
  const listed = run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    repositoryRoot,
  );
  assert.equal(listed.status, 0, listed.stderr);
  for (const relativePath of listed.stdout.split("\0").filter(Boolean)) {
    const target = path.join(runtimeRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(repositoryRoot, relativePath), target);
  }
  return runtimeRoot;
}

test("candidate snapshot installs and runs explicit entries plus stdio MCP", async (context) => {
  const runtimeRoot = await candidateSnapshot(context);
  await assert.rejects(stat(path.join(runtimeRoot, ".git")));
  await assert.rejects(stat(path.join(runtimeRoot, "node_modules")));

  const npm = path.join(path.dirname(process.execPath), "npm");
  const install = run(npm, ["ci"], runtimeRoot, { timeout: 180_000 });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  assert.match(install.stdout, /added \d+ packages/);

  const nodeVersion = run(process.execPath, ["--version"], runtimeRoot);
  assert.equal(nodeVersion.stdout.trim(), "v24.18.0");
  const npmVersion = run(npm, ["--version"], runtimeRoot);
  assert.equal(npmVersion.stdout.trim(), "11.16.0");

  const doctor = run(
    process.execPath,
    ["--import", "tsx", "harness/src/cli.ts", "doctor", "--json"],
    runtimeRoot,
  );
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal((JSON.parse(doctor.stdout) as { ok?: unknown }).ok, true);

  const hook = run(
    process.execPath,
    ["--import", "tsx", ".codex/hooks/research-guard.ts", "pre-tool-use"],
    runtimeRoot,
    {
      input: JSON.stringify({
        cwd: path.join(runtimeRoot, "harness"),
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm run harness -- doctor --json" },
      }),
    },
  );
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, "");

  const configPath = path.join(runtimeRoot, ".codex/config.toml");
  const configText = await readFile(configPath, "utf8");
  const config = parseToml(configText) as {
    features?: { hooks?: boolean };
    mcp_servers?: Record<string, { command?: string; args?: string[]; enabled_tools?: string[] }>;
  };
  assert.equal(config.features?.hooks, true);
  const evidenceConfig = config.mcp_servers?.startup_opportunity_evidence;
  assert.deepEqual(evidenceConfig?.enabled_tools, [
    "create_run",
    "propose_scope",
    "confirm_scope",
    "record_evidence",
    "get_evidence_manifest",
  ]);
  await writeFile(configPath, configText.replace("hooks = true", "hooks = false"));
  assert.equal(
    (parseToml(await readFile(configPath, "utf8")) as { features?: { hooks?: boolean } }).features
      ?.hooks,
    false,
  );

  const runId = "g4-clean-checkout-synthetic";
  const create = run(
    process.execPath,
    [
      "--import",
      "tsx",
      ".agents/skills/startup-opportunity/scripts/create-run.ts",
      "--run-id",
      runId,
      "--mode",
      "opportunity_discovery",
      "--geography",
      "Synthetic",
      "--customer-model",
      "b2c",
      "--target-user",
      "synthetic clean-checkout user",
      "--decision-goal",
      "exercise the clean-checkout current contract",
      "--research-language",
      "en-US",
      "--created-at",
      "2026-07-30T02:00:00Z",
    ],
    runtimeRoot,
  );
  assert.equal(create.status, 0, create.stderr);
  const created = JSON.parse(create.stdout) as {
    manifest: { scope_revision: number; status: string };
    scopeProposalRef: string;
    scopeProposalHash: string;
  };
  assert.equal(created.manifest.status, "awaiting_scope_confirmation");

  const confirm = run(
    process.execPath,
    [
      "--import",
      "tsx",
      ".agents/skills/startup-opportunity/scripts/confirm-scope.ts",
      "--run-id",
      runId,
      "--expected-scope-proposal-revision",
      String(created.manifest.scope_revision),
      "--expected-scope-proposal-ref",
      created.scopeProposalRef,
      "--expected-scope-proposal-hash",
      created.scopeProposalHash,
      "--user-confirmation-attestation",
      "The clean-checkout fixture caller attests exact user confirmation.",
      "--confirmed-at",
      "2026-07-30T02:00:30Z",
    ],
    runtimeRoot,
  );
  assert.equal(confirm.status, 0, confirm.stderr);

  const status = run(
    process.execPath,
    [
      "--import",
      "tsx",
      ".agents/skills/startup-opportunity/scripts/status-run.ts",
      "--run-id",
      runId,
    ],
    runtimeRoot,
  );
  assert.equal(status.status, 0, status.stderr);
  assert.equal(
    (JSON.parse(status.stdout) as { manifest?: { mode?: unknown } }).manifest?.mode,
    "opportunity_discovery",
  );

  const recorded = run(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "record-evidence",
      "--run-id",
      runId,
      "--unit-id",
      "unit_clean_checkout",
      "--source-url",
      "https://example.invalid/g4-clean-checkout-unverified",
      "--research-goal",
      "Exercise clean-checkout deterministic Evidence handoff only.",
      "--content-file",
      "tests/fixtures/g4/synthetic-evidence.txt",
      "--recorded-at",
      "2026-07-30T02:01:00Z",
    ],
    runtimeRoot,
  );
  assert.equal(recorded.status, 0, recorded.stderr);

  const load = run(
    process.execPath,
    [
      "--import",
      "tsx",
      ".agents/skills/startup-opportunity/scripts/load-run.ts",
      "--run-id",
      runId,
    ],
    runtimeRoot,
  );
  assert.equal(load.status, 0, load.stderr);
  assert.equal((JSON.parse(load.stdout) as { recovered?: unknown }).recovered, false);

  assert.equal(evidenceConfig?.command, "node");
  assert.ok(evidenceConfig?.args);
  const transport = new StdioClientTransport({
    command: evidenceConfig.command,
    args: evidenceConfig.args,
    cwd: runtimeRoot,
    env: environment(),
    stderr: "pipe",
  });
  const client = new Client({ name: "g4-clean-checkout", version: "1.0.0" });
  context.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "confirm_scope",
    "create_run",
    "get_evidence_manifest",
    "propose_scope",
    "record_evidence",
  ]);
  const manifest = await client.callTool({
    name: "get_evidence_manifest",
    arguments: { run_id: runId },
  });
  assert.equal((manifest.structuredContent as { records?: unknown[] }).records?.length, 1);
  const mcpRecord = await client.callTool({
    name: "record_evidence",
    arguments: {
      run_id: runId,
      unit_id: "unit_clean_checkout_mcp",
      research_goal: "Exercise clean-checkout stdio handoff only.",
      source: {
        kind: "user_provided",
        canonical_uri: "urn:startup-opportunity:user-provided:g4-clean-checkout-synthetic",
      },
      raw_content: "SYNTHETIC / UNVERIFIED MCP fixture bytes; not Evidence truth.",
      recorded_at: "2026-07-30T02:02:00Z",
    },
  });
  assert.equal((mcpRecord.structuredContent as { status?: unknown }).status, "recorded");
});

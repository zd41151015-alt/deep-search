import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parse as parseToml } from "smol-toml";
import {
  evaluatePostToolUse,
  evaluatePreToolUse,
  evaluateStop,
} from "../.codex/hooks/research-guard.js";
import { createArtifactValidator, RunStore, StoreError } from "../harness/src/index.js";
import { createEvidenceMcpServer } from "../harness/src/mcp/evidence-server.js";
import { createConfirmedRun } from "./helpers/current-run.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function createSyntheticRun(): Promise<{
  readonly root: string;
  readonly runsRoot: string;
  readonly runId: string;
  readonly store: RunStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g4-"));
  const runsRoot = path.join(root, "runs");
  const runId = "g4-synthetic-unverified";
  const store = new RunStore(runsRoot, await createArtifactValidator(repositoryRoot));
  await createConfirmedRun(store, {
    runId,
    mode: "concept_evidence_assessment",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-30T00:00:00Z",
  });
  return { root, runsRoot, runId, store };
}

test("project config and hook registry expose the narrow repo-local integration", async () => {
  const skill = await readFile(
    path.join(repositoryRoot, ".agents/skills/startup-opportunity/SKILL.md"),
    "utf8",
  );
  for (const action of ["discover", "assess", "resume", "status"]) {
    assert.ok(skill.includes(`\`${action}\``));
  }
  assert.match(skill, /scripts\/status-run\.ts/);

  const config = parseToml(
    await readFile(path.join(repositoryRoot, ".codex/config.toml"), "utf8"),
  ) as {
    features?: { hooks?: boolean };
    agents?: { max_concurrent_threads_per_session?: number };
    mcp_servers?: Record<string, Record<string, unknown>>;
  };
  assert.equal(config.features?.hooks, true);
  assert.equal(config.agents?.max_concurrent_threads_per_session, 6);
  const evidence = config.mcp_servers?.startup_opportunity_evidence;
  assert.equal(evidence?.command, "node");
  assert.deepEqual(evidence?.args, ["--import", "tsx", "harness/src/mcp/evidence-server.ts"]);
  assert.deepEqual(evidence?.enabled_tools, [
    "create_run",
    "propose_scope",
    "confirm_scope",
    "record_evidence",
    "get_evidence_manifest",
  ]);
  assert.equal(evidence?.default_tools_approval_mode, "writes");

  const hooks = JSON.parse(
    await readFile(path.join(repositoryRoot, ".codex/hooks.json"), "utf8"),
  ) as { hooks?: Record<string, unknown[]> };
  assert.deepEqual(Object.keys(hooks.hooks ?? {}).sort(), ["PostToolUse", "PreToolUse", "Stop"]);

  for (const name of ["lane-researcher", "evidence-auditor", "adversarial-reviewer"]) {
    const agent = parseToml(
      await readFile(path.join(repositoryRoot, `.codex/agents/${name}.toml`), "utf8"),
    ) as { mcp_servers?: Record<string, { enabled_tools?: string[] }> };
    const tools = agent.mcp_servers?.startup_opportunity_evidence?.enabled_tools ?? [];
    assert.ok(tools.includes("get_evidence_manifest"));
    assert.equal(tools.includes("record_evidence"), name === "lane-researcher");
  }
});

test("ordinary hook inputs continue without manufacturing telemetry or formal Artifacts", async () => {
  assert.equal(
    evaluatePreToolUse({
      tool_name: "Bash",
      tool_input: { command: "npm run harness -- doctor --json" },
    }),
    undefined,
  );
  assert.equal(
    evaluatePostToolUse({
      tool_name: "mcp__startup_opportunity_evidence__get_evidence_manifest",
      tool_response: { isError: false },
    }),
    undefined,
  );
  assert.equal(await evaluateStop({}, undefined), undefined);
});

test("status reads a validated manifest without mutating the Run", async (context) => {
  const fixture = await createSyntheticRun();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runRoot = path.join(fixture.runsRoot, fixture.runId);
  const beforeManifest = await readFile(path.join(runRoot, "manifest.json"), "utf8");
  const beforeEntries = (await readdir(runRoot, { recursive: true })).sort();

  const result = await fixture.store.status(fixture.runId);

  assert.equal(result.schemaVersion, "startup_opportunity.status_run_result.v1");
  assert.equal(result.manifest.mode, "concept_evidence_assessment");
  assert.deepEqual(result.continuationRunIds, []);
  assert.equal(result.derivedExecutionDisposition, "current");
  assert.equal(await readFile(path.join(runRoot, "manifest.json"), "utf8"), beforeManifest);
  assert.deepEqual((await readdir(runRoot, { recursive: true })).sort(), beforeEntries);

  const script = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      ".agents/skills/startup-opportunity/scripts/status-run.ts",
      "--run-id",
      fixture.runId,
      "--runs-root",
      fixture.runsRoot,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(script.status, 0, script.stderr);
  assert.equal(JSON.parse(script.stdout).schemaVersion, "startup_opportunity.status_run_result.v1");
  assert.equal(await readFile(path.join(runRoot, "manifest.json"), "utf8"), beforeManifest);
});

test("status derives a continued parent from validated child manifests without mutation", async (context) => {
  const fixture = await createSyntheticRun();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const childRunId = `${fixture.runId}-continuation`;
  await fixture.store.create({
    runId: childRunId,
    mode: "concept_evidence_assessment",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic user"],
      decisionGoal: "test current contract",
      researchLanguage: "en-US",
    },
    parentRunId: fixture.runId,
    createdAt: "2026-07-30T01:05:00Z",
  });
  const before = await Promise.all(
    [fixture.runId, childRunId].map((runId) =>
      readFile(path.join(fixture.runsRoot, runId, "manifest.json"), "utf8"),
    ),
  );

  const parentStatus = await fixture.store.status(fixture.runId);
  const childStatus = await fixture.store.status(childRunId);

  assert.equal(parentStatus.manifest.status, "created");
  assert.deepEqual(parentStatus.continuationRunIds, [childRunId]);
  assert.equal(parentStatus.derivedExecutionDisposition, "continued");
  assert.deepEqual(childStatus.continuationRunIds, []);
  assert.equal(childStatus.derivedExecutionDisposition, "current");
  assert.deepEqual(
    await Promise.all(
      [fixture.runId, childRunId].map((runId) =>
        readFile(path.join(fixture.runsRoot, runId, "manifest.json"), "utf8"),
      ),
    ),
    before,
  );
});

test("status reports a missing Run without creating the absent runs root", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g4-missing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const beforeEntries = await readdir(root);
  const store = new RunStore(runsRoot, await createArtifactValidator(repositoryRoot));

  await assert.rejects(
    store.status("g4-missing-run"),
    (error: unknown) => error instanceof StoreError && error.code === "run.not_found",
  );

  await assert.rejects(stat(runsRoot), (error: unknown) => {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  });
  assert.deepEqual(await readdir(root), beforeEntries);
});

test("Evidence MCP records and lists synthetic unverified caller-supplied bytes", async (context) => {
  const fixture = await createSyntheticRun();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createEvidenceMcpServer(fixture.runsRoot);
  const client = new Client({ name: "g4-functional-fixture", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    await server.close();
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "confirm_scope",
    "create_run",
    "get_evidence_manifest",
    "propose_scope",
    "record_evidence",
  ]);

  const mcpRunId = "g4-mcp-two-phase-scope";
  const createdCall = await client.callTool({
    name: "create_run",
    arguments: {
      run_id: mcpRunId,
      mode: "opportunity_discovery",
      scope_proposal: {
        geography: "Synthetic",
        customer_model: "b2c",
        target_users: ["synthetic MCP user"],
        decision_goal: "exercise the two-phase MCP Scope contract",
        research_language: "en-US",
      },
      created_at: "2026-07-30T00:00:10Z",
    },
  });
  const createdResult = (
    createdCall.structuredContent as {
      result?: {
        manifest?: { status?: unknown; scope_revision?: unknown };
        scopeProposalRef?: unknown;
        scopeProposalHash?: unknown;
      };
    }
  ).result;
  assert.equal(createdResult?.manifest?.status, "awaiting_scope_confirmation");
  const confirmedCall = await client.callTool({
    name: "confirm_scope",
    arguments: {
      run_id: mcpRunId,
      expected_scope_proposal_revision: createdResult?.manifest?.scope_revision,
      expected_scope_proposal_ref: createdResult?.scopeProposalRef,
      expected_scope_proposal_hash: createdResult?.scopeProposalHash,
      user_confirmation_attestation:
        "The MCP fixture caller attests that the user confirmed the exact displayed proposal.",
      confirmed_at: "2026-07-30T00:00:20Z",
    },
  });
  assert.equal(
    (confirmedCall.structuredContent as { result?: { status?: unknown } }).result?.status,
    "confirmed",
  );

  const recorded = await client.callTool({
    name: "record_evidence",
    arguments: {
      run_id: fixture.runId,
      unit_id: "unit_synthetic_fixture",
      research_goal: "Exercise the local Evidence handoff without making a truth claim.",
      source: {
        kind: "public_url",
        canonical_url: "https://example.invalid/synthetic-unverified",
      },
      raw_content: "SYNTHETIC / UNVERIFIED fixture bytes; not Evidence truth or validation.",
      recorded_at: "2026-07-30T00:01:00Z",
    },
  });
  assert.equal(recorded.isError, undefined);
  const recordResult = recorded.structuredContent as {
    status?: unknown;
    record?: { evidence_id?: unknown };
  };
  assert.equal(recordResult.status, "recorded");
  assert.match(String(recordResult.record?.evidence_id), /^ev_[a-f0-9]{64}$/);

  const manifest = await client.callTool({
    name: "get_evidence_manifest",
    arguments: { run_id: fixture.runId },
  });
  const manifestResult = manifest.structuredContent as { records?: unknown[] };
  assert.equal(manifestResult.records?.length, 1);

  const correctionCall = await client.callTool({
    name: "propose_scope",
    arguments: {
      run_id: fixture.runId,
      expected_scope_revision: 1,
      scope_proposal: {
        geography: "Synthetic corrected market",
        customer_model: "b2c",
        target_users: ["synthetic corrected user"],
        decision_goal: "test corrected current contract scope",
        research_language: "en-US",
      },
      reason: "The fixture user corrected the visible Scope.",
    },
  });
  const correction = (
    correctionCall.structuredContent as {
      result?: {
        scopeRevision?: unknown;
        scopeProposalRef?: unknown;
        scopeProposalHash?: unknown;
      };
    }
  ).result;
  const correctionConfirmation = await client.callTool({
    name: "confirm_scope",
    arguments: {
      run_id: fixture.runId,
      expected_scope_proposal_revision: correction?.scopeRevision,
      expected_scope_proposal_ref: correction?.scopeProposalRef,
      expected_scope_proposal_hash: correction?.scopeProposalHash,
      confirmed_at: "2026-07-30T00:02:00Z",
      user_confirmation_attestation:
        "The fixture caller attests that the user confirmed the exact corrected Scope proposal.",
    },
  });
  assert.equal(
    (correctionConfirmation.structuredContent as { result?: { status?: unknown } }).result?.status,
    "confirmed",
  );
  const blocked = await client.callTool({
    name: "record_evidence",
    arguments: {
      run_id: fixture.runId,
      unit_id: "unit_scope_unreconciled_synthetic",
      research_goal: "This write must remain blocked until Plan reconciliation.",
      source: {
        kind: "public_url",
        canonical_url: "https://example.invalid/scope-unreconciled-synthetic",
      },
      raw_content: "SYNTHETIC / UNVERIFIED blocked fixture bytes.",
      recorded_at: "2026-07-30T00:03:00Z",
    },
  });
  assert.equal(blocked.isError, true);
  assert.match(JSON.stringify(blocked.content), /latest user Scope revision|Scope revision/i);
  assert.equal((await fixture.store.status(fixture.runId)).observability.evidenceCount, 1);
});

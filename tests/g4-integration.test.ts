import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import {
  createArtifactValidator,
  RunStore,
  StoreError,
  sha256Bytes,
} from "../harness/src/index.js";
import { createEvidenceMcpServer } from "../harness/src/mcp/evidence-server.js";
import {
  createDiscoveryMapsFixture,
  fixtureEnvelope,
  G21_CORE_REFS,
} from "./fixtures/g2.1/discovery-maps-fixture.js";
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
    await evaluatePreToolUse({
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

test("research guard blocks production hot-fixes until the active Run is terminal", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-hotfix-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "active-hotfix-guard-synthetic";
  await mkdir(path.join(root, ".agents/skills/startup-opportunity"), { recursive: true });
  await mkdir(path.join(root, "runs", runId), { recursive: true });
  await writeFile(path.join(root, ".agents/skills/startup-opportunity/SKILL.md"), "fixture\n");
  const manifestPath = path.join(root, "runs", runId, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ status: "researching" }));
  const patchInput = {
    cwd: root,
    tool_name: "apply_patch",
    tool_input: { patch: "*** Update File: harness/src/run-store/run-store.ts" },
  };

  assert.deepEqual(await evaluatePreToolUse(patchInput, runId), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Production changes are blocked while Run ${runId} is nonterminal. Record runtime failure on that Run, make the fix, and start a new run_id.`,
    },
  });

  await writeFile(manifestPath, JSON.stringify({ status: "failed" }));
  assert.equal(await evaluatePreToolUse(patchInput, runId), undefined);
});

test("prior Run semantics require exact admission before Agent reads and cannot use generic Decision append", async (context) => {
  const fixture = await createSyntheticRun();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const activeRunId = "g4-prior-admission-current";
  await createConfirmedRun(fixture.store, {
    runId: activeRunId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic",
      customerModel: "b2c",
      targetUsers: ["synthetic current user"],
      decisionGoal: "test exact prior-input admission",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-30T00:00:00Z",
  });
  const currentBundle = await createDiscoveryMapsFixture("general", activeRunId);
  await fixture.store.publishArtifactBundle({
    runId: activeRunId,
    envelopes: G21_CORE_REFS.map((ref) => fixtureEnvelope(currentBundle, ref)),
  });
  const priorRunId = "g4-prior-semantics-synthetic";
  await fixture.store.create({
    runId: priorRunId,
    mode: "opportunity_discovery",
    scopeProposal: {
      geography: "Synthetic prior market",
      customerModel: "b2c",
      targetUsers: ["synthetic prior user"],
      decisionGoal: "SYNTHETIC prior discovery only",
      researchLanguage: "en-US",
    },
    createdAt: "2026-07-29T00:00:00Z",
  });
  await mkdir(path.join(fixture.root, ".agents/skills/startup-opportunity"), {
    recursive: true,
  });
  await writeFile(
    path.join(fixture.root, ".agents/skills/startup-opportunity/SKILL.md"),
    "SYNTHETIC hook root marker\n",
  );
  const priorRoot = path.join(fixture.runsRoot, priorRunId);
  const mapPath = "artifacts/discovery/opportunity-space-map.json";
  const candidatePath = "artifacts/discovery/candidates/copied.r1.json";
  const mapBytes = Buffer.from(
    '{"run_id":"old-run","conclusion":"COPYING THIS MAP IS NOT CURRENT DISCOVERY"}\n',
  );
  const candidateBytes = Buffer.from(
    '{"run_id":"old-run","candidate_id":"copied_candidate","formation":"OLD SEMANTICS"}\n',
  );
  await mkdir(path.join(priorRoot, "artifacts/discovery/candidates"), { recursive: true });
  await writeFile(path.join(priorRoot, mapPath), mapBytes);
  await writeFile(path.join(priorRoot, candidatePath), candidateBytes);

  const priorVariable = "$PRIOR_ARTIFACT_PATH";
  const singleBacktickCommand = (slashCount: number): string =>
    "printf '<OUT:%s>' \"`printf '<IN:%s>' \\\"" +
    "\\".repeat(slashCount) +
    priorVariable +
    '\\"`"';
  const nestedBacktickCommand = (slashCount: number): string =>
    "printf '<OUT:%s>' \"`printf '<MID:%s>' \\`printf '<IN:%s>' \\\"" +
    "\\".repeat(slashCount) +
    priorVariable +
    '\\"\\``"';
  const nestedBacktickHeredoc = (slashCount: number): string =>
    ["cat <<EOF", nestedBacktickCommand(slashCount), "EOF"].join("\n");
  const nestedBacktickAnsiAdjacent = (slashCount: number): string =>
    "printf '<OUT:%s>' \"`printf '<MID:%s>' \\`printf '<IN:%s>' $'a\\\\''\\\"" +
    "\\".repeat(slashCount) +
    priorVariable +
    '\\"\\``"';
  const nestedBacktickAnsiHeredoc = (slashCount: number): string =>
    ["cat <<EOF", nestedBacktickAnsiAdjacent(slashCount), "EOF"].join("\n");
  const escapedBacktick = (slashCount: number): string => `${"\\".repeat(slashCount)}\``;
  const tripleBacktickCommand = (slashCount: number): string =>
    "printf '<O:%s>' \"`printf '<A:%s>' " +
    escapedBacktick(1) +
    "printf '<B:%s>' " +
    escapedBacktick(3) +
    "printf '<C:%s>' \"" +
    "\\".repeat(slashCount) +
    priorVariable +
    '\\"' +
    escapedBacktick(3) +
    escapedBacktick(1) +
    '`"';
  const tripleBacktickHeredoc = (slashCount: number): string =>
    ["cat <<EOF", tripleBacktickCommand(slashCount), "EOF"].join("\n");
  const tripleBacktickAnsiAdjacent = (slashCount: number): string =>
    "printf '<O:%s>' \"`printf '<A:%s>' " +
    escapedBacktick(1) +
    "printf '<B:%s>' " +
    escapedBacktick(3) +
    "printf '<C:%s>' $'a\\\\''\"" +
    "\\".repeat(slashCount) +
    priorVariable +
    '\\"' +
    escapedBacktick(3) +
    escapedBacktick(1) +
    '`"';
  const tripleBacktickAnsiHeredoc = (slashCount: number): string =>
    ["cat <<EOF", tripleBacktickAnsiAdjacent(slashCount), "EOF"].join("\n");
  const singleBacktickExpands = [true, true, false, false, true, true, false, false, true];
  const nestedBacktickExpands = [true, true, true, true, false, false, false, false, true];
  const tripleBacktickExpands = [
    ...Array<boolean>(8).fill(true),
    ...Array<boolean>(8).fill(false),
    ...Array<boolean>(8).fill(true),
    ...Array<boolean>(8).fill(false),
    true,
  ];
  const backtickMatrixCommands = (expands: boolean): readonly string[] => [
    ...singleBacktickExpands.flatMap((doesExpand, slashCount) =>
      doesExpand === expands ? [singleBacktickCommand(slashCount)] : [],
    ),
    ...nestedBacktickExpands.flatMap((doesExpand, slashCount) =>
      doesExpand === expands
        ? [
            nestedBacktickCommand(slashCount),
            nestedBacktickHeredoc(slashCount),
            nestedBacktickAnsiAdjacent(slashCount),
            nestedBacktickAnsiHeredoc(slashCount),
          ]
        : [],
    ),
    ...tripleBacktickExpands.flatMap((doesExpand, slashCount) =>
      doesExpand === expands
        ? [
            tripleBacktickCommand(slashCount),
            tripleBacktickHeredoc(slashCount),
            tripleBacktickAnsiAdjacent(slashCount),
            tripleBacktickAnsiHeredoc(slashCount),
          ]
        : [],
    ),
  ];

  const accidentInput = {
    cwd: fixture.root,
    tool_name: "Bash",
    tool_input: {
      command: `cp runs/${priorRunId}/${mapPath} /tmp/current-map.json && cp runs/${priorRunId}/${candidatePath} /tmp/current-candidate.json && sed -i 's/old-run/${activeRunId}/g' /tmp/current-*.json`,
    },
  };
  const blocked = await evaluatePreToolUse(accidentInput, activeRunId);
  assert.equal(
    (blocked?.hookSpecificOutput as Record<string, unknown>)?.permissionDecision,
    "deny",
  );
  assert.match(
    String((blocked?.hookSpecificOutput as Record<string, unknown>)?.permissionDecisionReason),
    /read-prior-input/,
  );
  const splitPriorPath = await evaluatePreToolUse(
    {
      cwd: fixture.root,
      tool_name: "Bash",
      tool_input: {
        command: ["cat ru\\", `ns/${priorRunId}/manifest.json`].join("\n"),
      },
    },
    activeRunId,
  );
  assert.equal(
    (splitPriorPath?.hookSpecificOutput as Record<string, unknown>)?.permissionDecision,
    "deny",
  );
  assert.match(
    String(
      (splitPriorPath?.hookSpecificOutput as Record<string, unknown>)?.permissionDecisionReason,
    ),
    /read-prior-input/,
  );
  for (const command of [
    ...backtickMatrixCommands(true),
    'for p in runs/*/artifacts/discovery/opportunity-space-map.r1.json; do cat "$p"; done',
    "find runs -name opportunity-space-map.r1.json -exec cat {} \\;",
    'cat "$PRIOR_ARTIFACT_PATH"',
    'cat "$PRIOR_RUN_ROOT/artifacts/discovery/opportunity-space-map.r1.json"',
    'cat "$PREVIOUS_ARTIFACT_REF"',
    'find "$SOURCE_RUN_ROOT" -name "*.json"',
    `cat "\${PRIOR_ARTIFACT_PATH:-fallback}"`,
    `cat "\${PRIOR_RUN_ROOT:?required}/x.json"`,
    'cp "$PRIOR_RUN_ROOT/artifacts/x.json" /tmp/x.json',
    'install "$PRIOR_ARTIFACT_PATH" /tmp/x.json',
    'tar -cf /tmp/prior.tar "$PRIOR_RUN_ROOT"',
    'wc -c "$PRIOR_ARTIFACT_PATH"',
    'shasum "$PRIOR_ARTIFACT_PATH"',
    `printf "%s\\n" "\${PREVIOUS_ARTIFACT_REF}"`,
    `printf "%s\\n" "\${PREVIOUS_RUN_ROOT-fallback}"`,
    `printf "%s\\n" "\${SOURCE_RUN_ROOT?required}"`,
    `printf "%s\\n" "\${OLD_RUN_PATH:+alternate}"`,
    `printf "%s\\n" "\${RUNS_ROOT+alternate}"`,
    `cat "\${TMP_FILE:-$PRIOR_ARTIFACT_PATH}"`,
    `cat <<EOF\n$PRIOR_ARTIFACT_PATH\nEOF`,
    `cat <<EOF\n'$PRIOR_ARTIFACT_PATH'\nEOF`,
    `cat <<$'EOF'\nliteral\nEOF\ncat "$PRIOR_ARTIFACT_PATH"`,
    `cat <<$"EOF"\nliteral\nEOF\ncat "$PRIOR_ARTIFACT_PATH"`,
    `cat <<$'\\x45OF'\nliteral\nEOF\ncat "$PRIOR_ARTIFACT_PATH"`,
    `cat <<$'\\105OF'\nliteral\nEOF\ncat "$PRIOR_ARTIFACT_PATH"`,
    `cat <<$'E\\x4fF'\nliteral\nEOF\ncat "$PRIOR_ARTIFACT_PATH"`,
    `cat <<$'\\u0045OF'\nliteral\nEOF\ncat "$PRIOR_ARTIFACT_PATH"`,
    `cat <<$'\\U00000045OF'\nliteral\nEOF\ncat "$PRIOR_ARTIFACT_PATH"`,
    `cat <<$'\\xZZ'\nliteral\nEOF\ncat "$PRIOR_ARTIFACT_PATH"`,
    `cat <<EOF\n$(printf '%s' "$PRIOR_ARTIFACT_PATH")\nEOF`,
    ["printf '%s' \"$PRIOR_\\", 'ARTIFACT_PATH"'].join("\n"),
    ["printf '%s' \"${PRIOR_\\", 'ARTIFACT_PATH:-fallback}"'].join("\n"),
    ["printf '%s' \"$(printf '%s' \"$PRIOR_\\", 'ARTIFACT_PATH")"'].join("\n"),
    ["cat <<E\\", "OF", "literal", "EOF", 'cat "$PRIOR_ARTIFACT_PATH"'].join("\n"),
    ["cat <<EOF", "$PRIOR_\\", "ARTIFACT_PATH", "EOF"].join("\n"),
    ["printf '%s' \"`printf '%s' \"$PRIOR_\\", 'ARTIFACT_PATH"`"'].join("\n"),
    "printf '%s\\n' \"`printf '%s' \\\"$PRIOR_ARTIFACT_PATH\\\"`\"",
    "printf '%s\\n' \"`printf '%s' \\`printf '%s' \\\"$PRIOR_ARTIFACT_PATH\\\"\\``\"",
    ["cat <<EOF", "`printf '%s' \\\"$PRIOR_ARTIFACT_PATH\\\"`", "EOF"].join("\n"),
    "printf '%s' \"`printf '%s' \\$PRIOR_ARTIFACT_PATH`\"",
    "printf '%s' \"`printf '%s' \\\"\\$PRIOR_ARTIFACT_PATH\\\"`\"",
    ["cat <<EOF", "`printf '%s' \\$PRIOR_ARTIFACT_PATH`", "EOF"].join("\n"),
    `printf "%s\\n" "$(printf %s "$PRIOR_ARTIFACT_PATH")"`,
    "printf '%s' $'literal\\''\"$PRIOR_ARTIFACT_PATH\"",
    "printf '%s' $'literal\\''$PRIOR_ARTIFACT_PATH",
    "printf '%s' \"$(printf '%s' $'literal\\''\"$PRIOR_ARTIFACT_PATH\")\"",
    "printf '%s' \"`printf '%s' $'literal\\''\\\"$PRIOR_ARTIFACT_PATH\\\"`\"",
    "printf '%s' \"`printf '%s' $'a\\''\\\"\\$PRIOR_ARTIFACT_PATH\\\"`\"",
    ["cat <<EOF", "$(printf '%s' $'literal\\''\"$PRIOR_ARTIFACT_PATH\")", "EOF"].join("\n"),
    ["cat <<EOF", "`printf '%s' $'literal\\''\\\"$PRIOR_ARTIFACT_PATH\\\"`", "EOF"].join("\n"),
    `value=$((1 << 2))\ncat "$PRIOR_ARTIFACT_PATH"`,
    `(( value = 1 << 2 ))\ncat "$PRIOR_ARTIFACT_PATH"`,
  ]) {
    const indirect = await evaluatePreToolUse(
      { cwd: fixture.root, tool_name: "Bash", tool_input: { command } },
      activeRunId,
    );
    assert.equal(
      (indirect?.hookSpecificOutput as Record<string, unknown>)?.permissionDecision,
      "deny",
      command,
    );
    assert.match(
      String((indirect?.hookSpecificOutput as Record<string, unknown>)?.permissionDecisionReason),
      /Dynamic, globbed, variable, or broad Run reads/,
    );
  }
  for (const command of [
    ...backtickMatrixCommands(false),
    'find harness -name "*.ts"',
    'cat "$TMP_FILE"',
    'cat "$PREVIOUS_API_RESPONSE"',
    'jq . "$PRIOR_QUERY_RESULT"',
    'cat "$PREVIOUS_API_RESPONSE_FILE"',
    'jq . "$PRIOR_QUERY_RESULT_PATH"',
    'find "$PREVIOUS_QUERY_STAGING_DIR" -name "*.json"',
    'cat "$PRIOR_RESPONSE_REF"',
    `printf "%s\\n" "\${PRIOR_RESPONSE_REF}"`,
    `cp "\${PREVIOUS_API_RESPONSE_FILE:-fallback}" /tmp/response.json`,
    `install "\${PRIOR_QUERY_RESULT_PATH:?required}" /tmp/query.json`,
    `tar -cf /tmp/query.tar "\${PREVIOUS_QUERY_STAGING_DIR-alternate}"`,
    `wc -c "\${PRIOR_RESPONSE_REF?required}"`,
    `shasum "\${PREVIOUS_API_RESPONSE_FILE:+/tmp/alternate}"`,
    `printf "%s\\n" "\${PRIOR_QUERY_RESULT_PATH+/tmp/alternate}"`,
    `cat "\${TMP_FILE:-PRIOR_ARTIFACT_PATH}"`,
    `printf "%s\\n" '$PRIOR_ARTIFACT_PATH'`,
    `printf "%s\\n" "\\$PRIOR_ARTIFACT_PATH"`,
    `rg '\\$PRIOR_ARTIFACT_PATH' .codex`,
    `cat <<'EOF'\n$PRIOR_ARTIFACT_PATH\nEOF`,
    `cat <<"EOF"\n$PRIOR_ARTIFACT_PATH\nEOF`,
    `cat <<\\EOF\n$PRIOR_ARTIFACT_PATH\nEOF`,
    `cat <<E'OF'\n$PRIOR_ARTIFACT_PATH\nEOF`,
    `cat <<$'EOF'\n$PRIOR_ARTIFACT_PATH\nEOF`,
    `cat <<$"EOF"\n$PRIOR_ARTIFACT_PATH\nEOF`,
    `cat <<$'\\x45OF'\n$PRIOR_ARTIFACT_PATH\nEOF`,
    `cat <<$'\\105OF'\n$PRIOR_ARTIFACT_PATH\nEOF`,
    `cat <<$'E\\x4fF'\n$PRIOR_ARTIFACT_PATH\nEOF`,
    `cat <<EOF\n$(printf '%s' '$PRIOR_ARTIFACT_PATH')\nEOF`,
    ["printf '%s' '$PRIOR_\\", "ARTIFACT_PATH'"].join("\n"),
    ["cat <<'E'\\", "'OF'", "$PRIOR_ARTIFACT_PATH", "EOF"].join("\n"),
    [`cat ru\\`, `ns/${activeRunId}/manifest.json`].join("\n"),
    "printf '%s\\n' \"`printf '%s' '$PRIOR_ARTIFACT_PATH'`\"",
    "printf '%s\\n' \"`printf '%s' \\`printf '%s' '$PRIOR_ARTIFACT_PATH'\\``\"",
    ["cat <<EOF", "`printf '%s' '$PRIOR_ARTIFACT_PATH'`", "EOF"].join("\n"),
    `printf "%s\\n" "\${TMP_FILE:-\\$PRIOR_ARTIFACT_PATH}"`,
    `printf "%s\\n" literal # $PRIOR_ARTIFACT_PATH`,
    `value=$((1 << 2))\nprintf "%s\\n" '$PRIOR_ARTIFACT_PATH'`,
    `(( value = 1 << 2 ))\nprintf "%s\\n" '$PRIOR_ARTIFACT_PATH'`,
    `printf "%s\\n" "$(printf %s '$PRIOR_ARTIFACT_PATH')"`,
    "printf '%s' $'$PRIOR_ARTIFACT_PATH'",
    "printf '%s' $'literal\\''\"\\$PRIOR_ARTIFACT_PATH\"",
    "printf '%s' \"$(printf '%s' $'$PRIOR_ARTIFACT_PATH')\"",
    "printf '%s' \"$(printf '%s' $'literal\\''\"\\$PRIOR_ARTIFACT_PATH\")\"",
    "printf '%s' \"`printf '%s' $'$PRIOR_ARTIFACT_PATH'`\"",
    "printf '%s' \"`printf '%s' \\\\$PRIOR_ARTIFACT_PATH`\"",
    "printf '%s' \"`printf '%s' \\\"\\\\$PRIOR_ARTIFACT_PATH\\\"`\"",
    "printf '%s' \"`printf '%s' $'a\\''\\\"\\\\$PRIOR_ARTIFACT_PATH\\\"`\"",
    ["cat <<EOF", "$(printf '%s' $'$PRIOR_ARTIFACT_PATH')", "EOF"].join("\n"),
    ["cat <<EOF", "$(printf '%s' $'literal\\''\"\\$PRIOR_ARTIFACT_PATH\")", "EOF"].join("\n"),
    ["cat <<EOF", "`printf '%s' $'$PRIOR_ARTIFACT_PATH'`", "EOF"].join("\n"),
    ["cat <<EOF", "`printf '%s' \\\\$PRIOR_ARTIFACT_PATH`", "EOF"].join("\n"),
  ]) {
    assert.equal(
      await evaluatePreToolUse(
        { cwd: fixture.root, tool_name: "Bash", tool_input: { command } },
        activeRunId,
      ),
      undefined,
      command,
    );
  }
  const shellAliasBlocked = await evaluatePreToolUse(
    {
      cwd: fixture.root,
      tool_name: "Shell",
      tool_input: { command: 'cp "$PRIOR_ARTIFACT_PATH" /tmp/x.json' },
    },
    activeRunId,
  );
  assert.equal(
    (shellAliasBlocked?.hookSpecificOutput as Record<string, unknown>)?.permissionDecision,
    "deny",
  );
  const priorCwdRead = await evaluatePreToolUse(
    { cwd: priorRoot, tool_name: "Bash", tool_input: { command: "cat manifest.json" } },
    activeRunId,
  );
  assert.equal(
    (priorCwdRead?.hookSpecificOutput as Record<string, unknown>)?.permissionDecision,
    "deny",
  );
  await assert.rejects(
    fixture.store.appendDecision(activeRunId, {
      schema_version: "startup_opportunity.decision.v1",
      decision_id: "prior_input_admitted_forged",
      run_id: activeRunId,
      decision_type: "prior_input_admitted",
      timestamp: "2026-07-30T00:10:00Z",
      actor: "main_agent",
      reason: "SYNTHETIC attempted bypass.",
      artifact_refs: [],
      prior_input_id: "forged_prior",
      prior_source_run_id: priorRunId,
      prior_source_artifact_path: mapPath,
      prior_source_content_hash: sha256Bytes(mapBytes),
      prior_input_consumer: "discovery_maps",
      prior_target_artifact_path: mapPath,
      prior_use_boundary: "hypothesis_input_only",
    }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "run.prior_input_dedicated_path_required",
  );

  let candidateAdmissionRef = "";
  for (const [priorInputId, sourceArtifactPath, targetArtifactPath, sourceBytes, consumer] of [
    [
      "prior_map_hypothesis",
      mapPath,
      "artifacts/discovery/opportunity-space-map.r1.json",
      mapBytes,
      "discovery_maps",
    ],
    [
      "prior_candidate_hypothesis",
      candidatePath,
      candidatePath,
      candidateBytes,
      "discovery_candidates",
    ],
  ] as const) {
    const admission = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        ".agents/skills/startup-opportunity/scripts/admit-prior-input.ts",
        "--run-id",
        activeRunId,
        "--prior-input-id",
        priorInputId,
        "--source-run-id",
        priorRunId,
        "--source-artifact-path",
        sourceArtifactPath,
        "--target-artifact-path",
        targetArtifactPath,
        "--consumer",
        consumer,
        "--reason",
        "SYNTHETIC prior hypothesis input only.",
        "--admitted-at",
        "2026-07-30T00:10:00Z",
        "--runs-root",
        fixture.runsRoot,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(admission.status, 0, admission.stderr);
    const receipt = JSON.parse(admission.stdout) as Record<string, unknown>;
    if (consumer === "discovery_candidates") {
      candidateAdmissionRef = String(receipt.decisionRef);
    }
    assert.equal(receipt.useBoundary, "hypothesis_input_only");
    assert.equal(receipt.sourceContentHash, sha256Bytes(sourceBytes));
    assert.equal("document" in receipt, false);
    assert.doesNotMatch(admission.stdout, /COPYING THIS MAP|OLD SEMANTICS/);
    const controlledRead = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        ".agents/skills/startup-opportunity/scripts/read-prior-input.ts",
        "--run-id",
        activeRunId,
        "--admission-ref",
        String(receipt.decisionRef),
        "--consumed-at",
        "2026-07-30T00:11:00Z",
        "--runs-root",
        fixture.runsRoot,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(controlledRead.status, 0, controlledRead.stderr);
    const readResult = JSON.parse(controlledRead.stdout) as Record<string, unknown>;
    assert.equal(readResult.sourceText, sourceBytes.toString("utf8"));
    assert.match(String(readResult.consumptionDecisionRef), /^decisions\.jsonl#/);
    const replayedRead = await fixture.store.readPriorInput({
      runId: activeRunId,
      admissionRef: String(receipt.decisionRef),
    });
    assert.equal(replayedRead.status, "idempotent_replay");
    assert.equal(replayedRead.consumptionDecisionRef, readResult.consumptionDecisionRef);
    assert.equal(replayedRead.sourceText, sourceBytes.toString("utf8"));
  }

  assert.equal(
    (
      (await evaluatePreToolUse(accidentInput, activeRunId))?.hookSpecificOutput as Record<
        string,
        unknown
      >
    )?.permissionDecision,
    "deny",
  );
  await writeFile(path.join(priorRoot, candidatePath), `${candidateBytes.toString()}tampered\n`);
  const candidateAdmission = (await fixture.store
    .readPriorInput({
      runId: activeRunId,
      admissionRef: candidateAdmissionRef,
      consumedAt: "2026-07-30T00:12:30Z",
    })
    .catch((error: unknown) => error)) as unknown;
  assert.ok(candidateAdmission instanceof StoreError);
  assert.equal(candidateAdmission.code, "prior_input.source_drift");
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

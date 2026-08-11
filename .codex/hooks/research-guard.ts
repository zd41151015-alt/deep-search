#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

type HookMode = "pre-tool-use" | "post-tool-use" | "stop";

interface HookInput {
  readonly cwd?: unknown;
  readonly hook_event_name?: unknown;
  readonly last_assistant_message?: unknown;
  readonly tool_input?: unknown;
  readonly tool_name?: unknown;
  readonly tool_response?: unknown;
}

const evidenceToolPrefix = "mcp__startup_opportunity_evidence__";
const allowedEvidenceTools = new Set([
  `${evidenceToolPrefix}record_evidence`,
  `${evidenceToolPrefix}get_evidence_manifest`,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deny(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function commandText(input: HookInput): string {
  if (!isRecord(input.tool_input) || typeof input.tool_input.command !== "string") {
    return "";
  }
  return input.tool_input.command;
}

function toolInputText(input: HookInput): string {
  if (!isRecord(input.tool_input)) return "";
  return Object.values(input.tool_input)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

interface ReferencedRunTarget {
  readonly runId: string;
  readonly artifactPath: string | null;
}

function referencedRunTargets(contents: string): readonly ReferencedRunTarget[] {
  const targets = new Map<string, ReferencedRunTarget>();
  const pattern =
    /(?:^|[/\s"'=])runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/([A-Za-z0-9._/-]+))?/g;
  for (const match of contents.matchAll(pattern)) {
    const runId = match[1];
    if (runId === undefined) continue;
    const artifactPath = match[2] ?? null;
    targets.set(`${runId}:${artifactPath ?? ""}`, { runId, artifactPath });
  }
  return [...targets.values()];
}

function runAccessText(input: HookInput): string {
  const contents = `${toolInputText(input)}\n${typeof input.cwd === "string" ? input.cwd : ""}`;
  return contents.replace(
    /--runs-root(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/g,
    "--runs-root <controlled-store-root>",
  );
}

function hasUnresolvedRunReference(contents: string, activeRunId: string): boolean {
  const escapedRunId = activeRunId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutCurrentRunPaths = contents.replace(
    new RegExp(`(?:^|[/\\s"'=])runs/${escapedRunId}(?:/[A-Za-z0-9._/*?\\[\\]-]+)?`, "g"),
    " <current-run-path>",
  );
  return /(?:^|[/\s"'=])runs(?:\/|\b)/.test(withoutCurrentRunPaths);
}

function hasPriorRunDynamicRead(contents: string): boolean {
  const readsFiles =
    /(?:^|[;&|]\s*|\b)(?:cat|head|tail|sed|awk|grep|rg|find|less|more|jq|dd|strings)\b/.test(
      contents,
    );
  if (!readsFiles) return false;
  const variables = contents.match(/\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g);
  return (variables ?? []).some((token) => {
    const name = token
      .replace(/^\$\{?/, "")
      .replace(/\}$/, "")
      .toUpperCase();
    return (
      /(?:^|_)(?:PRIOR|PREVIOUS)(?:_|$)/.test(name) ||
      /(?:^|_)OLD_RUN(?:_|$)/.test(name) ||
      /(?:^|_)RUNS_ROOT(?:_|$)/.test(name) ||
      /(?:^|_)SOURCE_RUN(?:_|$)/.test(name)
    );
  });
}

function mutatesProductionSurface(input: HookInput): boolean {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const contents = toolInputText(input);
  const productionPath =
    /(?:^|[\s"'])(?:[^\s"']+\/)?(?:harness\/|scripts\/|\.agents\/skills\/startup-opportunity\/|\.codex\/|package(?:-lock)?\.json|\.node-version|\.npmrc|tsconfig\.json)/m;
  if (!productionPath.test(contents)) return false;
  if (toolName === "apply_patch") return true;
  return /(?:\*\*\*\s+(?:Add|Update|Delete) File:|\b(?:rm|mv|cp|truncate|tee|apply_patch)\b|\bsed\s+-i\b|\bperl\s+-pi\b|\bgit\s+apply\b|(?:^|\s)(?:>|>>))/m.test(
    contents,
  );
}

export async function evaluatePreToolUse(
  input: HookInput,
  activeRunId = process.env.STARTUP_OPPORTUNITY_ACTIVE_RUN_ID,
): Promise<Record<string, unknown> | undefined> {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (toolName.startsWith(evidenceToolPrefix) && !allowedEvidenceTools.has(toolName)) {
    return deny("Only the repository-filtered Evidence record and manifest tools are allowed.");
  }

  const command = commandText(input);
  if (/\b(?:git\s+(?:reset|checkout)\s+--|rm\s+-[^\n]*r[^\n]*f)\b/.test(command)) {
    return deny("Destructive repository commands are outside the research hook boundary.");
  }
  const directRunMutation =
    /runs\/[A-Za-z0-9._:-]+\/(?:manifest\.json|decisions\.jsonl|evidence\/(?:manifest\.jsonl|raw\/)|plans\/|adaptations\/|report\.json|decision-brief\.md|report\.md)/;
  const mutationOperator =
    /(?:\*\*\*\s+(?:Add|Update|Delete) File:|\b(?:rm|mv|cp|truncate|tee)\b|(?:^|\s)(?:>|>>))/m;
  if (directRunMutation.test(command) && mutationOperator.test(command)) {
    return deny(
      "Direct mutation of controlled Run state is blocked; use the explicit Harness publication or recovery command.",
    );
  }
  if (activeRunId === undefined) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(activeRunId)) {
    return deny("The active Startup Opportunity Run id is invalid.");
  }
  const root = await findRepositoryRoot(typeof input.cwd === "string" ? input.cwd : process.cwd());
  const accessText = runAccessText(input);
  for (const target of referencedRunTargets(accessText)) {
    if (target.runId === activeRunId) continue;
    return deny(
      `Direct reading of Run ${target.runId}/${target.artifactPath ?? ""} is blocked; use read-prior-input with an exact admission ref.`,
    );
  }
  if (hasUnresolvedRunReference(accessText, activeRunId) || hasPriorRunDynamicRead(accessText)) {
    return deny(
      "Dynamic, globbed, variable, or broad Run reads are blocked; prior semantics are readable only through read-prior-input.",
    );
  }
  if (!mutatesProductionSurface(input)) {
    return undefined;
  }
  let status: unknown;
  try {
    const manifest = JSON.parse(
      await readFile(path.join(root, "runs", activeRunId, "manifest.json"), "utf8"),
    ) as { status?: unknown };
    status = manifest.status;
  } catch {
    return deny(
      `Run ${activeRunId} cannot be read. Recover or terminate it before changing production code.`,
    );
  }
  if (!["completed", "failed", "insufficient_evidence", "cancelled"].includes(String(status))) {
    return deny(
      `Production changes are blocked while Run ${activeRunId} is nonterminal. Record runtime failure on that Run, make the fix, and start a new run_id.`,
    );
  }
  return undefined;
}

export function evaluatePostToolUse(input: HookInput): Record<string, unknown> | undefined {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!toolName.startsWith(evidenceToolPrefix)) {
    return undefined;
  }
  const response = isRecord(input.tool_response) ? input.tool_response : undefined;
  if (response?.isError !== true) {
    return undefined;
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        "The Evidence adapter call failed. Do not treat its output as Evidence or continue from a chat summary; resolve the explicit Store error.",
    },
  };
}

async function isFile(filename: string): Promise<boolean> {
  try {
    return (await stat(filename)).isFile();
  } catch {
    return false;
  }
}

async function findRepositoryRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    if (await isFile(path.join(current, ".agents/skills/startup-opportunity/SKILL.md"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(start);
    }
    current = parent;
  }
}

export async function evaluateStop(
  input: HookInput,
  activeRunId = process.env.STARTUP_OPPORTUNITY_ACTIVE_RUN_ID,
): Promise<Record<string, unknown> | undefined> {
  if (activeRunId === undefined) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(activeRunId)) {
    return { decision: "block", reason: "The active Startup Opportunity Run id is invalid." };
  }
  const root = await findRepositoryRoot(typeof input.cwd === "string" ? input.cwd : process.cwd());
  const runRoot = path.join(root, "runs", activeRunId);
  let status: unknown;
  try {
    const manifest = JSON.parse(await readFile(path.join(runRoot, "manifest.json"), "utf8")) as {
      status?: unknown;
    };
    status = manifest.status;
  } catch {
    return {
      decision: "block",
      reason: `Run ${activeRunId} cannot be read. Execute the explicit load-run recovery step before stopping.`,
    };
  }
  if (status !== "completed") {
    return undefined;
  }
  const required = ["report.json", "decision-brief.md", "report.md"];
  const present = await Promise.all(
    required.map((filename) => isFile(path.join(runRoot, filename))),
  );
  const missing = required.filter((_, index) => !present[index]);
  if (missing.length > 0) {
    return {
      decision: "block",
      reason: `Completed Run ${activeRunId} is missing report output(s): ${missing.join(", ")}. Run explicit report validation before stopping.`,
    };
  }
  return undefined;
}

async function readInput(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const contents = Buffer.concat(chunks).toString("utf8");
  if (contents.trim().length === 0) {
    return {};
  }
  const parsed = JSON.parse(contents) as unknown;
  return isRecord(parsed) ? parsed : {};
}

export async function runHook(mode: HookMode, suppliedInput?: HookInput): Promise<void> {
  const input = suppliedInput ?? (await readInput());
  const output =
    mode === "pre-tool-use"
      ? await evaluatePreToolUse(input)
      : mode === "post-tool-use"
        ? evaluatePostToolUse(input)
        : await evaluateStop(input);
  if (output !== undefined) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

const mode = process.argv[2];
if (mode === "pre-tool-use" || mode === "post-tool-use" || mode === "stop") {
  runHook(mode).catch((error: unknown) => {
    process.stderr.write(`startup-opportunity hook failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
} else if (process.argv[1]?.endsWith("research-guard.ts")) {
  process.stderr.write("research-guard requires pre-tool-use, post-tool-use, or stop\n");
  process.exitCode = 64;
}

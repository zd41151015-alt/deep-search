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

function toolInputText(input: HookInput, commandOverride?: string): string {
  if (!isRecord(input.tool_input)) return "";
  return Object.entries(input.tool_input)
    .map(([key, value]) =>
      key === "command" && commandOverride !== undefined ? commandOverride : value,
    )
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

function runAccessText(input: HookInput, commandOverride?: string): string {
  const contents = `${toolInputText(input, commandOverride)}\n${typeof input.cwd === "string" ? input.cwd : ""}`;
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

interface ShellHeredoc {
  readonly delimiter: string;
  readonly declarationEnd: number;
  readonly expansionFrames: ShellLexFrame[];
  readonly expandsVariables: boolean;
  readonly stripLeadingTabs: boolean;
}

interface DecodedAnsiCEscape {
  readonly nextOffset: number;
  readonly value: string;
}

function decodeAnsiCEscape(contents: string, slashOffset: number): DecodedAnsiCEscape | null {
  const escaped = contents[slashOffset + 1];
  if (escaped === undefined) return null;
  const simpleEscapes: Readonly<Record<string, string>> = {
    a: "\u0007",
    b: "\b",
    e: "\u001b",
    E: "\u001b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
  };
  const simple = simpleEscapes[escaped];
  if (simple !== undefined) return { nextOffset: slashOffset + 2, value: simple };
  if (/[0-7]/.test(escaped)) {
    let end = slashOffset + 1;
    while (end < contents.length && end < slashOffset + 4 && /[0-7]/.test(contents[end] ?? "")) {
      end += 1;
    }
    const byte = Number.parseInt(contents.slice(slashOffset + 1, end), 8) & 0xff;
    if (byte > 0x7f) return null;
    return { nextOffset: end, value: String.fromCodePoint(byte) };
  }
  // Bash 3.2 and zsh disagree on Unicode ANSI-C escapes; ambiguous delimiter bytes fail closed.
  if (escaped === "x") {
    const digitStart = slashOffset + 2;
    let digitEnd = digitStart;
    while (
      digitEnd < contents.length &&
      digitEnd < digitStart + 2 &&
      /[A-Fa-f0-9]/.test(contents[digitEnd] ?? "")
    ) {
      digitEnd += 1;
    }
    if (digitEnd === digitStart) return null;
    const codePoint = Number.parseInt(contents.slice(digitStart, digitEnd), 16);
    if (codePoint > 0x7f) return null;
    return { nextOffset: digitEnd, value: String.fromCodePoint(codePoint) };
  }
  if (escaped === "c") {
    const controlled = contents[slashOffset + 2];
    if (controlled === undefined) return null;
    const codePoint = controlled === "?" ? 0x7f : controlled.toUpperCase().codePointAt(0);
    if (codePoint === undefined || codePoint > 0x7f) return null;
    return {
      nextOffset: slashOffset + 3,
      value: String.fromCodePoint(codePoint === 0x7f ? codePoint : codePoint & 0x1f),
    };
  }
  return null;
}

function heredocAt(line: string, offset: number): ShellHeredoc | null {
  if (line[offset] !== "<" || line[offset + 1] !== "<" || line[offset + 2] === "<") {
    return null;
  }
  let cursor = offset + 2;
  const stripLeadingTabs = line[cursor] === "-";
  if (stripLeadingTabs) cursor += 1;
  while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
  let quoted = false;
  let quote: "ansi_c" | "single" | "double" | null = null;
  let delimiter = "";
  const wordStart = cursor;
  for (; cursor < line.length; cursor += 1) {
    const character = line[cursor];
    if (quote === null && /[\s;&|<>]/.test(character ?? "")) break;
    if (quote === "ansi_c") {
      if (character === "'") {
        quote = null;
        continue;
      }
      if (character === "\\") {
        const decoded = decodeAnsiCEscape(line, cursor);
        if (decoded === null) return null;
        delimiter += decoded.value;
        cursor = decoded.nextOffset - 1;
        continue;
      }
      delimiter += character;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      quoted = true;
      const escaped = line[cursor + 1];
      if (escaped === undefined) return null;
      if (quote !== "double" || /[$`"\\]/.test(escaped)) {
        cursor += 1;
        delimiter += escaped;
      } else {
        delimiter += character;
      }
      continue;
    }
    if (
      character === "$" &&
      quote === null &&
      (line[cursor + 1] === "'" || line[cursor + 1] === '"')
    ) {
      quoted = true;
      cursor += 1;
      quote = line[cursor] === "'" ? "ansi_c" : "double";
      continue;
    }
    if (character === "'" && quote !== "double") {
      quoted = true;
      quote = quote === "single" ? null : "single";
      continue;
    }
    if (character === '"' && quote !== "single") {
      quoted = true;
      quote = quote === "double" ? null : "double";
      continue;
    }
    delimiter += character;
  }
  if (cursor === wordStart || quote !== null || /[\0\r\n]/.test(delimiter)) return null;
  return {
    declarationEnd: cursor,
    delimiter,
    expansionFrames: [{ kind: "heredoc", parenDepth: null, quote: null }],
    expandsVariables: !quoted,
    stripLeadingTabs,
  };
}

function shellVariableNameAt(contents: string, dollarOffset: number): string | null {
  const nameStart = contents[dollarOffset + 1] === "{" ? dollarOffset + 2 : dollarOffset + 1;
  const first = contents[nameStart];
  if (first === undefined || !/[A-Za-z_]/.test(first)) return null;
  let nameEnd = nameStart + 1;
  while (/[A-Za-z0-9_]/.test(contents[nameEnd] ?? "")) nameEnd += 1;
  return contents.slice(nameStart, nameEnd);
}

function isPriorRunVariableName(variableName: string): boolean {
  const name = variableName.toUpperCase();
  return (
    /(?:^|_)(?:PRIOR|PREVIOUS)_(?:RUN|RUNS|ARTIFACT)(?:_|$)/.test(name) ||
    /(?:^|_)OLD_RUN(?:_|$)/.test(name) ||
    /(?:^|_)SOURCE_RUN(?:_|$)/.test(name) ||
    /(?:^|_)RUNS_ROOT(?:_|$)/.test(name)
  );
}

function hasRawPriorRunVariable(contents: string): boolean {
  const names: string[] = [];
  collectRawShellVariableNames(contents.replace(/\\\r?\n/g, ""), 0, names);
  return names.some(isPriorRunVariableName);
}

interface ShellLexFrame {
  readonly backtickFoldingDepth?: number;
  readonly backtickTerminator?: "escaped" | "plain";
  readonly kind: "arithmetic" | "backtick" | "command" | "heredoc";
  parenDepth: number | null;
  quote: "ansi_c" | "single" | "double" | null;
}

interface BacktickDollarFold {
  readonly dollarOffset: number;
  readonly expands: boolean;
}

interface AnsiCQuoteFold {
  readonly closesQuote: boolean;
  readonly quoteOffset: number;
}

interface BacktickDelimiterFold {
  readonly action: "ambiguous" | "close" | "open";
  readonly backtickOffset: number;
}

interface FailClosedShellState {
  active: boolean;
  readonly heredocs: ShellHeredoc[];
  quote: "ansi_c" | "double" | "single" | null;
}

function escapedBacktickSlashCount(depth: number, limit: number): number | null {
  let slashCount = 0;
  for (let level = 1; level < depth; level += 1) {
    if (slashCount > (limit - 1) / 2) return null;
    slashCount = slashCount * 2 + 1;
  }
  return slashCount;
}

function foldBacktickDelimiter(
  line: string,
  slashOffset: number,
  foldingDepth: number,
): BacktickDelimiterFold | null {
  let backtickOffset = slashOffset;
  while (line[backtickOffset] === "\\") backtickOffset += 1;
  if (line[backtickOffset] !== "`") return null;
  const rawSlashCount = backtickOffset - slashOffset;
  const currentSlashCount = escapedBacktickSlashCount(foldingDepth, rawSlashCount);
  const nextSlashCount = escapedBacktickSlashCount(foldingDepth + 1, rawSlashCount);
  const action =
    currentSlashCount === rawSlashCount
      ? "close"
      : nextSlashCount === rawSlashCount
        ? "open"
        : "ambiguous";
  return { action, backtickOffset };
}

function collectRawShellVariableNames(line: string, offset: number, names: string[]): void {
  for (let index = offset; index < line.length; index += 1) {
    if (line[index] !== "$") continue;
    const name = shellVariableNameAt(line, index);
    if (name !== null) names.push(name);
  }
}

function scanFailClosedShellLine(
  line: string,
  offset: number,
  state: FailClosedShellState,
  names: string[],
): void {
  const heredoc = state.heredocs[0];
  if (heredoc !== undefined) {
    const candidate = heredoc.stripLeadingTabs ? line.replace(/^\t+/, "") : line;
    if (candidate === heredoc.delimiter) state.heredocs.shift();
    else if (heredoc.expandsVariables) collectRawShellVariableNames(line, 0, names);
    return;
  }
  for (let index = offset; index < line.length; index += 1) {
    const character = line[index];
    if (state.quote === "single") {
      if (character === "'") state.quote = null;
      continue;
    }
    if (state.quote === "ansi_c") {
      if (character === "\\") index += 1;
      else if (character === "'") state.quote = null;
      continue;
    }
    if (state.quote === "double") {
      if (character === "\\" && /[\\"`$]/.test(line[index + 1] ?? "")) index += 1;
      else if (character === '"') state.quote = null;
      else if (character === "$") {
        const name = shellVariableNameAt(line, index);
        if (name !== null) names.push(name);
      }
      continue;
    }
    if (character === "\\" && line[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (character === "$" && line[index + 1] === "'") {
      state.quote = "ansi_c";
      index += 1;
      continue;
    }
    if (character === "'") {
      state.quote = "single";
      continue;
    }
    if (character === '"') {
      state.quote = "double";
      continue;
    }
    if (character === "#" && (index === 0 || /[\s;&|()]/.test(line[index - 1] ?? ""))) {
      break;
    }
    if (character === "<") {
      const declaration = heredocAt(line, index);
      if (declaration !== null) {
        state.heredocs.push(declaration);
        index = declaration.declarationEnd - 1;
        continue;
      }
    }
    if (character !== "$") continue;
    const name = shellVariableNameAt(line, index);
    if (name !== null) names.push(name);
  }
}

function foldBacktickBackslashesBeforeAnsiCQuote(
  line: string,
  slashOffset: number,
  foldingDepth: number,
): AnsiCQuoteFold | null {
  let quoteOffset = slashOffset;
  while (line[quoteOffset] === "\\") quoteOffset += 1;
  if (line[quoteOffset] !== "'") return null;
  let innerSlashCount = quoteOffset - slashOffset;
  for (let depth = 0; depth < foldingDepth; depth += 1) {
    innerSlashCount = Math.ceil(innerSlashCount / 2);
  }
  return {
    closesQuote: innerSlashCount % 2 === 0,
    quoteOffset,
  };
}

function foldBacktickBackslashesBeforeDollar(
  line: string,
  slashOffset: number,
  foldingDepth: number,
): BacktickDollarFold | null {
  let dollarOffset = slashOffset;
  while (line[dollarOffset] === "\\") dollarOffset += 1;
  if (line[dollarOffset] !== "$") return null;
  // Backticks fold the outer slash run before the inner shell decides whether $ is escaped.
  const rawSlashCount = dollarOffset - slashOffset;
  let innerSlashCount = rawSlashCount;
  for (let depth = 0; depth < foldingDepth; depth += 1) {
    innerSlashCount = Math.floor(innerSlashCount / 2);
  }
  return {
    dollarOffset,
    expands: innerSlashCount % 2 === 0,
  };
}

function scanShellLine(
  line: string,
  frames: ShellLexFrame[],
  names: string[],
  heredocs: ShellHeredoc[] | null,
  failClosedState?: FailClosedShellState,
  inheritedFailClosedHeredocs: readonly ShellHeredoc[] = [],
): void {
  if (failClosedState?.active === true) {
    scanFailClosedShellLine(line, 0, failClosedState, names);
    return;
  }
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const frame = frames.at(-1);
    if (frame === undefined) break;
    if (frame.kind === "heredoc") {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === "$" && line.slice(index, index + 3) === "$((") {
        frames.push({ kind: "arithmetic", parenDepth: 2, quote: null });
        index += 2;
        continue;
      }
      if (character === "$" && line.slice(index, index + 2) === "$(") {
        frames.push({ kind: "command", parenDepth: 1, quote: null });
        index += 1;
        continue;
      }
      if (character === "`") {
        frames.push({
          backtickFoldingDepth: 1,
          backtickTerminator: "plain",
          kind: "backtick",
          parenDepth: null,
          quote: null,
        });
        continue;
      }
      if (character === "$") {
        const name = shellVariableNameAt(line, index);
        if (name !== null) names.push(name);
      }
      continue;
    }
    if (frame.kind === "arithmetic") {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === "$" && line.slice(index, index + 3) === "$((") {
        frames.push({ kind: "arithmetic", parenDepth: 2, quote: null });
        index += 2;
        continue;
      }
      if (character === "$" && line.slice(index, index + 2) === "$(") {
        frames.push({ kind: "command", parenDepth: 1, quote: null });
        index += 1;
        continue;
      }
      if (character === "`") {
        frames.push({
          backtickFoldingDepth: 1,
          backtickTerminator: "plain",
          kind: "backtick",
          parenDepth: null,
          quote: null,
        });
        continue;
      }
      if (character === "$") {
        const name = shellVariableNameAt(line, index);
        if (name !== null) names.push(name);
        continue;
      }
      if (character === "(") {
        frame.parenDepth = (frame.parenDepth ?? 0) + 1;
        continue;
      }
      if (character === ")") {
        frame.parenDepth = (frame.parenDepth ?? 1) - 1;
        if (frame.parenDepth === 0) frames.pop();
      }
      continue;
    }
    if (frame.quote === "single") {
      if (character === "'") frame.quote = null;
      continue;
    }
    if (frame.quote === "ansi_c") {
      if (character === "\\") {
        const foldedQuote = foldBacktickBackslashesBeforeAnsiCQuote(
          line,
          index,
          frame.kind === "backtick" ? (frame.backtickFoldingDepth ?? 1) : 0,
        );
        if (foldedQuote !== null) {
          index = foldedQuote.quoteOffset;
          if (foldedQuote.closesQuote) frame.quote = null;
          continue;
        }
        index += 1;
        continue;
      }
      if (character === "'") frame.quote = null;
      continue;
    }
    if (frame.kind === "backtick" && character === "\\") {
      const delimiter = foldBacktickDelimiter(line, index, frame.backtickFoldingDepth ?? 1);
      if (delimiter !== null) {
        index = delimiter.backtickOffset;
        if (delimiter.action === "close") frames.pop();
        else if (delimiter.action === "open") {
          frames.push({
            backtickFoldingDepth: (frame.backtickFoldingDepth ?? 1) + 1,
            backtickTerminator: "escaped",
            kind: "backtick",
            parenDepth: null,
            quote: null,
          });
        } else if (failClosedState !== undefined) {
          failClosedState.active = true;
          failClosedState.heredocs.push(...inheritedFailClosedHeredocs);
          scanFailClosedShellLine(line, index + 1, failClosedState, names);
          // The ambiguous delimiter leaves the remainder's inherited quote context unknowable.
          // Start the persistent fallback at the next complete physical line instead.
          failClosedState.quote = null;
          return;
        } else collectRawShellVariableNames(line, index + 1, names);
        continue;
      }
      const foldedDollar = foldBacktickBackslashesBeforeDollar(
        line,
        index,
        frame.backtickFoldingDepth ?? 1,
      );
      if (foldedDollar !== null) {
        index = foldedDollar.dollarOffset;
        if (foldedDollar.expands) {
          const name = shellVariableNameAt(line, index);
          if (name !== null) names.push(name);
        }
        continue;
      }
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (frame.kind === "backtick" && frame.backtickTerminator === "plain" && character === "`") {
      frames.pop();
      continue;
    }
    if (frame.quote === "double") {
      if (character === '"') {
        frame.quote = null;
        continue;
      }
      if (character === "$" && line.slice(index, index + 3) === "$((") {
        frames.push({ kind: "arithmetic", parenDepth: 2, quote: null });
        index += 2;
        continue;
      }
      if (character === "$" && line.slice(index, index + 2) === "$(") {
        frames.push({ kind: "command", parenDepth: 1, quote: null });
        index += 1;
        continue;
      }
      if (character === "`") {
        frames.push({
          backtickFoldingDepth: 1,
          backtickTerminator: "plain",
          kind: "backtick",
          parenDepth: null,
          quote: null,
        });
        continue;
      }
      if (character === "$") {
        const name = shellVariableNameAt(line, index);
        if (name !== null) names.push(name);
      }
      continue;
    }
    if (character === "$" && line[index + 1] === "'") {
      frame.quote = "ansi_c";
      index += 1;
      continue;
    }
    if (character === "'") {
      frame.quote = "single";
      continue;
    }
    if (character === '"') {
      frame.quote = "double";
      continue;
    }
    if (character === "#" && (index === 0 || /[\s;&|()]/.test(line[index - 1] ?? ""))) {
      break;
    }
    if (character === "$" && line.slice(index, index + 3) === "$((") {
      frames.push({ kind: "arithmetic", parenDepth: 2, quote: null });
      index += 2;
      continue;
    }
    if (character === "$" && line.slice(index, index + 2) === "$(") {
      frames.push({ kind: "command", parenDepth: 1, quote: null });
      index += 1;
      continue;
    }
    if (character === "`") {
      frames.push({
        backtickFoldingDepth: 1,
        backtickTerminator: "plain",
        kind: "backtick",
        parenDepth: null,
        quote: null,
      });
      continue;
    }
    if (character === "(" && line[index + 1] === "(") {
      frames.push({ kind: "arithmetic", parenDepth: 2, quote: null });
      index += 1;
      continue;
    }
    if (character === "(" && frame.parenDepth !== null) {
      frame.parenDepth += 1;
      continue;
    }
    if (character === ")" && frame.parenDepth !== null) {
      frame.parenDepth -= 1;
      if (frame.parenDepth === 0) frames.pop();
      continue;
    }
    if (character === "<" && heredocs !== null) {
      const declaration = heredocAt(line, index);
      if (declaration !== null) {
        heredocs.push(declaration);
        index = declaration.declarationEnd - 1;
        continue;
      }
    }
    if (character !== "$") continue;
    const name = shellVariableNameAt(line, index);
    if (name !== null) names.push(name);
  }
}

function cloneShellFrames(frames: readonly ShellLexFrame[]): ShellLexFrame[] {
  return frames.map((frame) => ({ ...frame }));
}

function removesTrailingLineContinuation(line: string, frames: readonly ShellLexFrame[]): boolean {
  let slashCount = 0;
  for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index -= 1) {
    slashCount += 1;
  }
  if (slashCount % 2 === 0) return false;
  const probeFrames = cloneShellFrames(frames);
  scanShellLine(line.slice(0, -1), probeFrames, [], null);
  const quote = probeFrames.at(-1)?.quote;
  return quote !== "single" && quote !== "ansi_c";
}

function normalizeShellLineContinuations(contents: string): string {
  const commandFrames: ShellLexFrame[] = [{ kind: "command", parenDepth: null, quote: null }];
  const heredocs: ShellHeredoc[] = [];
  const normalizedLines: string[] = [];
  let pending = "";
  for (const physicalLine of contents.split(/\r?\n/)) {
    const heredoc = heredocs[0];
    if (heredoc !== undefined) {
      if (!heredoc.expandsVariables) {
        normalizedLines.push(physicalLine);
        const candidate = heredoc.stripLeadingTabs
          ? physicalLine.replace(/^\t+/, "")
          : physicalLine;
        if (candidate === heredoc.delimiter) heredocs.shift();
        continue;
      }
      pending += physicalLine;
      if (removesTrailingLineContinuation(pending, heredoc.expansionFrames)) {
        pending = pending.slice(0, -1);
        continue;
      }
      normalizedLines.push(pending);
      const candidate = heredoc.stripLeadingTabs ? pending.replace(/^\t+/, "") : pending;
      if (candidate === heredoc.delimiter) heredocs.shift();
      else scanShellLine(pending, heredoc.expansionFrames, [], null);
      pending = "";
      continue;
    }
    pending += physicalLine;
    if (removesTrailingLineContinuation(pending, commandFrames)) {
      pending = pending.slice(0, -1);
      continue;
    }
    normalizedLines.push(pending);
    scanShellLine(pending, commandFrames, [], heredocs);
    pending = "";
  }
  if (pending !== "") normalizedLines.push(pending);
  return normalizedLines.join("\n");
}

function shellVariableNames(contents: string): readonly string[] {
  const names: string[] = [];
  const heredocs: ShellHeredoc[] = [];
  const frames: ShellLexFrame[] = [{ kind: "command", parenDepth: null, quote: null }];
  const failClosedState: FailClosedShellState = {
    active: false,
    heredocs: [],
    quote: null,
  };
  for (const line of contents.split(/\r?\n/)) {
    if (failClosedState.active) {
      scanFailClosedShellLine(line, 0, failClosedState, names);
      continue;
    }
    const heredoc = heredocs[0];
    if (heredoc !== undefined) {
      const candidate = heredoc.stripLeadingTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === heredoc.delimiter) heredocs.shift();
      else if (heredoc.expandsVariables) {
        scanShellLine(line, heredoc.expansionFrames, names, null, failClosedState, heredocs);
      }
      continue;
    }
    scanShellLine(line, frames, names, heredocs, failClosedState);
  }
  return names;
}

interface ShellCommandWord {
  readonly raw: string;
  readonly value: string;
}

interface ShellCommandSegment {
  readonly heredocs: ShellHeredoc[];
  readonly stdinHeredocs: readonly ShellHeredoc[];
  readonly stdinPayloads: readonly string[];
  readonly words: ShellCommandWord[];
}

interface ShellCommandParse {
  readonly hasUnclosedQuote: boolean;
  readonly segments: readonly ShellCommandSegment[];
}

interface ReinterpretedHeredoc extends ShellHeredoc {
  bodyBuffer: string;
  readonly inspectBody: boolean;
}

function arithmeticEnd(contents: string, offset: number): number | null {
  const prefixLength = contents.startsWith("$((", offset)
    ? 3
    : contents.startsWith("((", offset)
      ? 2
      : 0;
  if (prefixLength === 0) return null;
  let depth = 2;
  let quote: "double" | "single" | null = null;
  for (let index = offset + prefixLength; index < contents.length; index += 1) {
    const character = contents[index];
    if (character === "\\" && quote !== "single") {
      index += 1;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
      continue;
    }
    if (quote !== null) continue;
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function backtickEnd(contents: string, offset: number): number | null {
  for (let index = offset + 1; index < contents.length; index += 1) {
    if (contents[index] === "\\") index += 1;
    else if (contents[index] === "`") return index;
  }
  return null;
}

interface CommandSubstitution {
  readonly body: string;
  readonly end: number;
}

function commandSubstitutionAt(contents: string, offset: number): CommandSubstitution | null {
  if (!contents.startsWith("$(", offset) || contents.startsWith("$((", offset)) return null;
  let depth = 1;
  let quote: "ansi_c" | "double" | "single" | null = null;
  for (let index = offset + 2; index < contents.length; index += 1) {
    const character = contents[index];
    if (quote === "single") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === "ansi_c") {
      if (character === "\\") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = null;
      else if (character === "$" && contents[index + 1] === "(") depth += 1;
      else if (character === ")" && depth > 1) depth -= 1;
      continue;
    }
    if (character === "$" && contents[index + 1] === "'") {
      quote = "ansi_c";
      index += 1;
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if (character === "`") {
      const end = backtickEnd(contents, index);
      if (end === null) return null;
      index = end;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return { body: contents.slice(offset + 2, index), end: index };
    }
  }
  return null;
}

function nestedShellBodies(contents: string): readonly string[] {
  const bodies: string[] = [];
  let quote: "ansi_c" | "double" | "single" | null = null;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    if (quote === "single") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === "ansi_c") {
      if (character === "\\") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "$" && contents[index + 1] === "(") {
      const substitution = commandSubstitutionAt(contents, index);
      if (substitution !== null) {
        bodies.push(substitution.body);
        index = substitution.end;
        continue;
      }
    }
    if (character === "`") {
      const end = backtickEnd(contents, index);
      if (end !== null) {
        bodies.push(contents.slice(index + 1, end));
        index = end;
        continue;
      }
    }
    if (quote === "double") {
      if (character === '"') quote = null;
      continue;
    }
    if (character === "$" && contents[index + 1] === "'") {
      quote = "ansi_c";
      index += 1;
    } else if (character === "'") quote = "single";
    else if (character === '"') quote = "double";
  }
  return bodies;
}

function parseShellCommandSegments(line: string): ShellCommandParse {
  const segments: ShellCommandSegment[] = [];
  let hasUnclosedQuote = false;
  let heredocs: ShellHeredoc[] = [];
  let stdinHeredocs: ShellHeredoc[] = [];
  let stdinPayloads: string[] = [];
  let words: ShellCommandWord[] = [];
  let redirectionTarget: "ignore" | "stdin_payload" | null = null;
  const finishSegment = (): void => {
    if (words.length > 0 || heredocs.length > 0) {
      segments.push({ heredocs, stdinHeredocs, stdinPayloads, words });
    }
    heredocs = [];
    stdinHeredocs = [];
    stdinPayloads = [];
    words = [];
  };
  for (let index = 0; index < line.length; ) {
    const character = line[index];
    if (/\s/.test(character ?? "")) {
      index += 1;
      continue;
    }
    if (character === "#") break;
    if (character === "<") {
      const declaration = heredocAt(line, index);
      if (declaration !== null) {
        heredocs.push(declaration);
        index = declaration.declarationEnd;
        continue;
      }
    }
    if (character === "<" || character === ">") {
      const isHereString = line.startsWith("<<<", index);
      index += isHereString ? 3 : line[index + 1] === character ? 2 : 1;
      redirectionTarget = isHereString ? "stdin_payload" : "ignore";
      continue;
    }
    const topLevelArithmeticEnd = arithmeticEnd(line, index);
    if (topLevelArithmeticEnd !== null) {
      index = topLevelArithmeticEnd;
      continue;
    }
    if (/[;&|()]/.test(character ?? "")) {
      const isPipe = character === "|" && line[index + 1] !== "|";
      finishSegment();
      if (isPipe) {
        const source = segments.at(-1);
        stdinPayloads = [
          ...(source?.stdinPayloads ?? []),
          ...(source?.words.flatMap((word) => [word.raw, word.value]) ?? []),
        ];
        stdinHeredocs = [...(source?.stdinHeredocs ?? []), ...(source?.heredocs ?? [])];
      }
      index +=
        (character === "|" && line[index + 1] === "&") || line[index + 1] === character ? 2 : 1;
      continue;
    }
    const wordStart = index;
    let quote: "ansi_c" | "double" | "single" | null = null;
    let value = "";
    for (; index < line.length; index += 1) {
      const current = line[index];
      const embeddedArithmeticEnd = quote === null ? arithmeticEnd(line, index) : null;
      if (embeddedArithmeticEnd !== null) {
        value += line.slice(index, embeddedArithmeticEnd);
        index = embeddedArithmeticEnd - 1;
        continue;
      }
      if (quote === null && (/\s/.test(current ?? "") || /[;&|()<>]/.test(current ?? ""))) {
        break;
      }
      if (quote === "single") {
        if (current === "'") quote = null;
        else value += current;
        continue;
      }
      if (quote === "ansi_c") {
        if (current === "'") {
          quote = null;
          continue;
        }
        if (current === "\\") {
          const decoded = decodeAnsiCEscape(line, index);
          if (decoded === null) {
            value += current;
            continue;
          }
          value += decoded.value;
          index = decoded.nextOffset - 1;
          continue;
        }
        value += current;
        continue;
      }
      if (quote === "double") {
        if (current === '"') {
          quote = null;
          continue;
        }
        if (current === "\\" && /[\\"`$]/.test(line[index + 1] ?? "")) {
          index += 1;
          value += line[index];
          continue;
        }
        value += current;
        continue;
      }
      if (current === "\\") {
        const escaped = line[index + 1];
        if (escaped !== undefined) {
          value += escaped;
          index += 1;
        }
        continue;
      }
      if (current === "$" && line[index + 1] === "'") {
        quote = "ansi_c";
        index += 1;
        continue;
      }
      if (current === "'") {
        quote = "single";
        continue;
      }
      if (current === '"') {
        quote = "double";
        continue;
      }
      value += current;
    }
    if (quote !== null) hasUnclosedQuote = true;
    const raw = line.slice(wordStart, index);
    if (redirectionTarget === "stdin_payload") {
      stdinPayloads.push(raw, value);
      redirectionTarget = null;
    } else if (redirectionTarget === "ignore") redirectionTarget = null;
    else if (!(line[index] === "<" || line[index] === ">") || !/^\d+$/.test(value)) {
      words.push({ raw, value });
    }
  }
  finishSegment();
  return { hasUnclosedQuote, segments };
}

function commandName(word: ShellCommandWord | undefined): string | null {
  if (word === undefined) return null;
  const basename = word.value.slice(word.value.lastIndexOf("/") + 1);
  return basename === "bash" || basename === "sh" || basename === "zsh" ? basename : null;
}

function isShellAssignment(word: ShellCommandWord | undefined): boolean {
  return word !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value);
}

function reinterpreterStart(words: readonly ShellCommandWord[]): number | null {
  let index = 0;
  const controlPrefixes = new Set([
    "!",
    "{",
    "do",
    "elif",
    "else",
    "if",
    "then",
    "time",
    "until",
    "while",
  ]);
  while (true) {
    while (isShellAssignment(words[index])) index += 1;
    const controlPrefix = words[index]?.value;
    if (controlPrefix === undefined || !controlPrefixes.has(controlPrefix)) break;
    index += 1;
    if (controlPrefix === "time" && words[index]?.value === "-p") index += 1;
  }
  if (
    words[index]?.value === "builtin" ||
    words[index]?.value === "command" ||
    words[index]?.value === "exec"
  ) {
    index += 1;
    while (/^-[A-Za-z]+$/.test(words[index]?.value ?? "") || words[index]?.value === "--") {
      index += 1;
    }
  }
  if (words[index] !== undefined && commandName(words[index]) === null) {
    const basename = words[index]?.value.slice((words[index]?.value.lastIndexOf("/") ?? -1) + 1);
    if (basename !== "env") return words[index]?.value === "eval" ? index : null;
    index += 1;
    while (words[index] !== undefined) {
      const option = words[index]?.value ?? "";
      if (isShellAssignment(words[index])) index += 1;
      else if (/^(?:-u|-C|-S|--unset|--chdir|--split-string|--argv0)$/.test(option)) index += 2;
      else if (/^--(?:unset|chdir|split-string|argv0)=/.test(option) || /^-/.test(option))
        index += 1;
      else break;
    }
  }
  return commandName(words[index]) !== null || words[index]?.value === "eval" ? index : null;
}

function hasPriorRunShellReinterpretation(contents: string, recursionDepth = 0): boolean {
  const pendingHeredocs: ReinterpretedHeredoc[] = [];
  let commandBuffer = "";
  for (const line of contents.split(/\r?\n/)) {
    const pending = pendingHeredocs[0];
    if (pending !== undefined) {
      const candidate = pending.stripLeadingTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === pending.delimiter) pendingHeredocs.shift();
      else {
        pending.bodyBuffer = pending.bodyBuffer === "" ? line : `${pending.bodyBuffer}\n${line}`;
        if (pending.inspectBody && hasRawPriorRunVariable(pending.bodyBuffer)) return true;
        if (
          pending.expandsVariables &&
          recursionDepth < 8 &&
          nestedShellBodies(pending.bodyBuffer).some((body) =>
            hasPriorRunShellReinterpretation(body, recursionDepth + 1),
          )
        ) {
          return true;
        }
      }
      continue;
    }
    commandBuffer = commandBuffer === "" ? line : `${commandBuffer}\n${line}`;
    const parsed = parseShellCommandSegments(commandBuffer);
    if (parsed.hasUnclosedQuote) continue;
    if (
      recursionDepth < 8 &&
      nestedShellBodies(commandBuffer).some((body) =>
        hasPriorRunShellReinterpretation(body, recursionDepth + 1),
      )
    ) {
      return true;
    }
    commandBuffer = "";
    const shellStdinHeredocs = new Set(
      parsed.segments.flatMap((segment) => {
        const start = reinterpreterStart(segment.words);
        return start !== null && commandName(segment.words[start]) !== null
          ? segment.stdinHeredocs
          : [];
      }),
    );
    for (const segment of parsed.segments) {
      const start = reinterpreterStart(segment.words);
      if (start === null) {
        pendingHeredocs.push(
          ...segment.heredocs.map((heredoc) => ({
            ...heredoc,
            bodyBuffer: "",
            inspectBody: shellStdinHeredocs.has(heredoc),
          })),
        );
        continue;
      }
      const name = segment.words[start]?.value;
      const shellName = commandName(segment.words[start]);
      if (name === "eval") {
        if (
          segment.words
            .slice(start + 1)
            .some((word) => hasRawPriorRunVariable(word.raw) || hasRawPriorRunVariable(word.value))
        ) {
          return true;
        }
      } else if (shellName !== null) {
        if (segment.stdinPayloads.some(hasRawPriorRunVariable)) return true;
        let commandStringOffset: number | null = null;
        for (let index = start + 1; index < segment.words.length; index += 1) {
          const option = segment.words[index]?.value ?? "";
          if (/^-[^-]*c/.test(option)) {
            commandStringOffset = index + 1;
            break;
          }
          if (/^(?:-O|\+O|-o|\+o|--rcfile|--init-file)$/.test(option)) {
            index += 1;
            continue;
          }
          if (option === "--") break;
          if (!option.startsWith("-")) break;
        }
        if (
          commandStringOffset !== null &&
          (hasRawPriorRunVariable(segment.words[commandStringOffset]?.raw ?? "") ||
            hasRawPriorRunVariable(segment.words[commandStringOffset]?.value ?? ""))
        ) {
          return true;
        }
      }
      pendingHeredocs.push(
        ...segment.heredocs.map((heredoc) => ({
          ...heredoc,
          bodyBuffer: "",
          inspectBody: shellName !== null || shellStdinHeredocs.has(heredoc),
        })),
      );
    }
  }
  return false;
}

function hasPriorRunDynamicReference(contents: string): boolean {
  return (
    shellVariableNames(contents).some(isPriorRunVariableName) ||
    hasPriorRunShellReinterpretation(contents)
  );
}

function mutatesProductionSurface(input: HookInput, commandOverride?: string): boolean {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const contents = toolInputText(input, commandOverride);
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
  const isShellTool = toolName === "Bash" || toolName === "Shell";
  const normalizedCommand = isShellTool ? normalizeShellLineContinuations(command) : command;
  if (/\b(?:git\s+(?:reset|checkout)\s+--|rm\s+-[^\n]*r[^\n]*f)\b/.test(normalizedCommand)) {
    return deny("Destructive repository commands are outside the research hook boundary.");
  }
  const directRunMutation =
    /runs\/[A-Za-z0-9._:-]+\/(?:manifest\.json|decisions\.jsonl|evidence\/(?:manifest\.jsonl|raw\/)|plans\/|adaptations\/|report\.json|decision-brief\.md|report\.md)/;
  const mutationOperator =
    /(?:\*\*\*\s+(?:Add|Update|Delete) File:|\b(?:rm|mv|cp|truncate|tee)\b|(?:^|\s)(?:>|>>))/m;
  if (directRunMutation.test(normalizedCommand) && mutationOperator.test(normalizedCommand)) {
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
  const accessText = runAccessText(input, normalizedCommand);
  for (const target of referencedRunTargets(accessText)) {
    if (target.runId === activeRunId) continue;
    return deny(
      `Direct reading of Run ${target.runId}/${target.artifactPath ?? ""} is blocked; use read-prior-input with an exact admission ref.`,
    );
  }
  if (
    hasUnresolvedRunReference(accessText, activeRunId) ||
    (isShellTool && hasPriorRunDynamicReference(normalizedCommand))
  ) {
    return deny(
      "Dynamic, globbed, variable, or broad Run reads are blocked; prior semantics are readable only through read-prior-input.",
    );
  }
  if (!mutatesProductionSurface(input, normalizedCommand)) {
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

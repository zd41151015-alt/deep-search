function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sourceLabel(entry: Record<string, unknown>, zh: boolean): string {
  const source = isRecord(entry.source) ? entry.source : {};
  const label =
    typeof entry.source_label === "string" ? entry.source_label : zh ? "来源记录" : "Source record";
  if (source.kind === "public_url" && typeof source.canonical_url === "string") {
    return `[${label}](${source.canonical_url})`;
  }
  if (source.kind === "user_provided" && typeof source.canonical_uri === "string") {
    return zh ? `${label}（用户提供/非公开）` : `${label} (user-provided/non-public)`;
  }
  return label;
}

function evidenceLabel(
  evidenceRef: string,
  citationByRef: ReadonlyMap<string, Record<string, unknown>>,
  zh: boolean,
): string {
  const citation = citationByRef.get(evidenceRef);
  if (citation?.source_access === "public" && typeof citation.url === "string") {
    return `[${String(citation.label)}](${citation.url})`;
  }
  if (citation?.source_access === "user_provided_non_public") {
    return zh
      ? `${String(citation.label)}（用户提供/非公开）`
      : `${String(citation.label)} (user-provided/non-public)`;
  }
  return zh ? "可追溯来源（详见结构化审计）" : evidenceRef;
}

export function renderEvidenceDispositions(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const citations = new Map(
    records(source.report_citations).map((entry) => [String(entry.evidence_ref), entry]),
  );
  const groups = new Map<string, { label: string; items: string[] }>();
  const add = (disposition: string, reasons: readonly string[], item: string): void => {
    const reason = reasons.map((entry) => localizedAuditReason(entry, zh)).join(zh ? "；" : "; ");
    const identity = `${disposition}\u0000${reason}`;
    const group = groups.get(identity) ?? {
      label: `${localizedEnum(disposition, zh)}: ${reason}`,
      items: [],
    };
    group.items.push(item);
    groups.set(identity, group);
  };
  for (const entry of records(source.report_evidence_dispositions)) {
    add(
      String(entry.disposition),
      strings(entry.reasons),
      evidenceLabel(String(entry.evidence_ref), citations, zh),
    );
  }
  for (const entry of records(source.report_source_dispositions)) {
    const notes =
      typeof entry.notes === "string" ? ` - ${localizedAuditReason(entry.notes, zh)}` : "";
    add(String(entry.disposition), strings(entry.reasons), `${sourceLabel(entry, zh)}${notes}`);
  }
  if (groups.size === 0) {
    return zh ? "- 没有需单独披露的材料处置。\n" : "- No separate material disposition recorded.\n";
  }
  return `${[...groups.values()]
    .sort((left, right) => left.label.localeCompare(right.label))
    .map(
      (group) =>
        `- **${group.label}**\n${group.items
          .sort()
          .map((item, index) => `  - ${index + 1}. ${item}`)
          .join("\n")}`,
    )
    .join("\n")}\n`;
}

import { localizedAuditReason, localizedEnum } from "./report-localization.js";

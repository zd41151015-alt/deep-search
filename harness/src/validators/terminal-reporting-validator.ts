import type { FormalArtifactEnvelope } from "../artifact-store/artifact-store.js";
import { canonicalContentHash } from "../artifact-store/canonical.js";
import {
  deriveTerminalReportDocuments,
  terminalReportDocumentsEqual,
} from "../reporting/terminal-reporting.js";
import type { ValidationIssue } from "./schema-bundle.js";

export interface TerminalReportingDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

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

function issue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "terminal_reporting",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function sourceAuditRefs(source: Record<string, unknown>): ReadonlySet<string> {
  return new Set(strings(source.audit_refs));
}

function referencedAuditRefs(source: Record<string, unknown>): readonly string[] {
  const execution = isRecord(source.execution) ? source.execution : {};
  const runtime = isRecord(source.runtime_health) ? source.runtime_health : {};
  return [
    ...records(source.sources).flatMap((entry) =>
      typeof entry.evidence_ref === "string" ? [entry.evidence_ref] : [],
    ),
    ...records(execution.incomplete_stages).flatMap((entry) => strings(entry.related_refs)),
    ...records(execution.required_followups).flatMap((entry) => strings(entry.related_refs)),
    ...strings(execution.pending_operation_refs),
    ...records(runtime.issues).flatMap((entry) => strings(entry.related_refs)),
  ];
}

function validateSource(
  entry: TerminalReportingDocument,
  manifest: TerminalReportingDocument | undefined,
): readonly ValidationIssue[] {
  const source = entry.document;
  const errors: ValidationIssue[] = [];
  if (source.owned_output_path !== entry.path) {
    errors.push(
      issue(
        "terminal_reporting.path_mismatch",
        `${entry.path}#/owned_output_path`,
        "terminal report source must own its exact immutable path",
      ),
    );
  }
  if (manifest !== undefined) {
    const status = manifest.document.status;
    const outcome = source.terminal_outcome;
    const allowedByStatus: Readonly<Record<string, readonly string[]>> = {
      completed: ["completed", "deprioritized"],
      insufficient_evidence: ["insufficient_evidence"],
      failed: ["blocked", "failed"],
      cancelled: ["cancelled"],
    };
    if (
      source.run_id !== manifest.document.run_id ||
      source.mode !== manifest.document.mode ||
      !Array.isArray(allowedByStatus[String(status)]) ||
      !allowedByStatus[String(status)]?.includes(String(outcome))
    ) {
      errors.push(
        issue(
          "terminal_reporting.manifest_mismatch",
          `${entry.path}#/terminal_outcome`,
          "terminal report identity or outcome does not match the terminal Run manifest",
          { manifestStatus: status, terminalOutcome: outcome },
        ),
      );
    }
  }

  const execution = isRecord(source.execution) ? source.execution : {};
  const incomplete = records(execution.incomplete_stages);
  const followups = records(execution.required_followups);
  const pending = strings(execution.pending_operation_refs);
  const completeness = execution.completeness;
  if (
    (completeness === "complete" &&
      (incomplete.length > 0 ||
        pending.length > 0 ||
        followups.some((followup) => followup.status === "not_executed"))) ||
    ((completeness === "partial" || completeness === "not_started") && incomplete.length === 0)
  ) {
    errors.push(
      issue(
        "terminal_reporting.execution_completeness_mismatch",
        `${entry.path}#/execution`,
        "execution completeness must agree with incomplete stages, required follow-ups, and pending operations",
      ),
    );
  }

  const runtime = isRecord(source.runtime_health) ? source.runtime_health : {};
  const runtimeIssues = records(runtime.issues);
  if (
    (runtime.status === "healthy" && runtimeIssues.length > 0) ||
    ((runtime.status === "degraded" || runtime.status === "blocked") && runtimeIssues.length === 0)
  ) {
    errors.push(
      issue(
        "terminal_reporting.runtime_health_mismatch",
        `${entry.path}#/runtime_health`,
        "runtime health must agree with its explicit issue list",
      ),
    );
  }
  if (
    (source.terminal_outcome === "completed" || source.terminal_outcome === "deprioritized") &&
    (completeness !== "complete" || runtime.status === "blocked" || pending.length > 0)
  ) {
    errors.push(
      issue(
        "terminal_reporting.false_completion",
        `${entry.path}#/terminal_outcome`,
        "a completed research outcome requires complete execution, no blocked runtime, and no pending operation",
      ),
    );
  }

  const conclusion = isRecord(source.research_conclusion) ? source.research_conclusion : {};
  const directions = records(source.directions);
  if (
    conclusion.outcome === "prioritize" &&
    (completeness !== "complete" ||
      runtime.status !== "healthy" ||
      !["strong", "moderate"].includes(String(conclusion.evidence_strength)) ||
      !directions.some(
        (direction) =>
          direction.maturity === "supported_opportunity_thesis" && direction.action === "invest",
      ))
  ) {
    errors.push(
      issue(
        "terminal_reporting.conclusion_ceiling",
        `${entry.path}#/research_conclusion/outcome`,
        "prioritize requires complete execution, healthy runtime, sufficient evidence strength, and an investable supported thesis",
      ),
    );
  }

  const priorities = directions.map((direction) => Number(direction.priority));
  if (
    new Set(priorities).size !== priorities.length ||
    priorities.some((priority, index) => priority !== index + 1)
  ) {
    errors.push(
      issue(
        "terminal_reporting.direction_order_invalid",
        `${entry.path}#/directions`,
        "direction priorities must be unique and contiguous from one",
      ),
    );
  }
  const sources = records(source.sources);
  const sourceIds = sources.map((candidate) => String(candidate.source_id));
  const knownSourceIds = new Set(sourceIds);
  if (new Set(sourceIds).size !== sourceIds.length) {
    errors.push(
      issue(
        "terminal_reporting.source_identity_duplicate",
        `${entry.path}#/sources`,
        "source ids must be unique",
      ),
    );
  }
  for (const [index, direction] of directions.entries()) {
    for (const sourceId of [
      ...strings(direction.decisive_support_source_ids),
      ...strings(direction.decisive_opposition_source_ids),
    ]) {
      if (!knownSourceIds.has(sourceId)) {
        errors.push(
          issue(
            "terminal_reporting.source_reference_missing",
            `${entry.path}#/directions/${index}`,
            "direction cites an unknown human-readable source id",
            { sourceId },
          ),
        );
      }
    }
  }

  const dates = sources.map((candidate) => String(candidate.valid_as_of)).sort();
  const freshness = isRecord(source.freshness) ? source.freshness : {};
  const expectedEarliest = dates.at(0) ?? null;
  const expectedLatest = dates.at(-1) ?? null;
  if (
    freshness.earliest_valid_as_of !== expectedEarliest ||
    freshness.latest_valid_as_of !== expectedLatest
  ) {
    errors.push(
      issue(
        "terminal_reporting.freshness_mismatch",
        `${entry.path}#/freshness`,
        "terminal report freshness bounds must be derived from cited readable sources",
        { expectedEarliest, expectedLatest },
      ),
    );
  }

  const orders = records(source.ordered_validation_plan).map((step) => Number(step.order));
  if (
    new Set(orders).size !== orders.length ||
    orders.some((order, index) => order !== index + 1)
  ) {
    errors.push(
      issue(
        "terminal_reporting.validation_order_invalid",
        `${entry.path}#/ordered_validation_plan`,
        "validation recommendations must be uniquely ordered from one",
      ),
    );
  }
  for (const [index, step] of records(source.ordered_validation_plan).entries()) {
    if (
      step.method === "user_owned_external_validation" &&
      (step.execution_owner !== "user" ||
        step.execution_supported !== false ||
        step.result_tracking_supported !== false)
    ) {
      errors.push(
        issue(
          "terminal_reporting.external_action_boundary_mismatch",
          `${entry.path}#/ordered_validation_plan/${index}`,
          "external validation suggestions must remain user-owned and unsupported by the Harness",
        ),
      );
    }
  }

  const auditRefs = sourceAuditRefs(source);
  for (const ref of referencedAuditRefs(source)) {
    if (!auditRefs.has(ref)) {
      errors.push(
        issue(
          "terminal_reporting.audit_closure_missing",
          `${entry.path}#/audit_refs`,
          "every source, runtime issue, incomplete stage, follow-up, and pending operation ref must remain in the audit appendix",
          { ref },
        ),
      );
    }
  }
  return errors;
}

export function validateTerminalReportingContract(
  documents: readonly TerminalReportingDocument[],
): readonly ValidationIssue[] {
  const relevant = documents.filter((entry) =>
    [
      "startup_opportunity.terminal_report_source.v1",
      "startup_opportunity.decision_brief.v3",
      "startup_opportunity.terminal_report_view.v1",
      "startup_opportunity.report_consistency_evaluation.v4",
    ].includes(entry.schemaVersion),
  );
  if (relevant.length === 0) {
    return [];
  }
  const errors: ValidationIssue[] = [];
  for (const entry of relevant) {
    if (entry.envelope?.schema_version !== "startup_opportunity.artifact_envelope.current") {
      errors.push(
        issue(
          "terminal_reporting.envelope_version_mismatch",
          entry.path,
          "terminal reporting artifacts require the current Artifact Envelope",
        ),
      );
    }
  }
  const sources = relevant.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.terminal_report_source.v1",
  );
  if (sources.length !== 1) {
    errors.push(
      issue(
        "terminal_reporting.source_cardinality",
        "/documents",
        "terminal reporting bundles require exactly one source when any terminal report artifact is present",
        { count: sources.length },
      ),
    );
    return errors;
  }
  const source = sources[0];
  if (source === undefined || source.envelope === null) {
    return errors;
  }
  const manifest = documents.find(
    (entry) => entry.schemaVersion === "startup_opportunity.run_manifest.v1",
  );
  errors.push(...validateSource(source, manifest));

  let expected: readonly ReturnType<typeof deriveTerminalReportDocuments>[number][];
  try {
    expected = deriveTerminalReportDocuments(source.envelope as unknown as FormalArtifactEnvelope);
  } catch (error) {
    errors.push(
      issue(
        "terminal_reporting.source_invalid",
        source.path,
        error instanceof Error ? error.message : "terminal report derivation failed",
      ),
    );
    return errors;
  }
  for (const derived of expected) {
    const actual = relevant.find((entry) => entry.path === derived.artifactPath);
    if (actual === undefined) {
      continue;
    }
    if (
      actual.schemaVersion !== derived.artifactType ||
      !terminalReportDocumentsEqual(actual.document, derived.document) ||
      actual.envelope?.content_hash !== canonicalContentHash(derived.document)
    ) {
      errors.push(
        issue(
          "terminal_reporting.derived_drift",
          actual.path,
          "derived terminal report sidecar differs from the deterministic source projection",
        ),
      );
    }
  }
  return errors;
}

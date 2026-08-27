import type { FormalArtifactEnvelope } from "../artifact-store/artifact-store.js";
import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import {
  commercialProjectionRefs,
  deriveReportStatistics,
  isCommercialAuditRelevantTask,
} from "../reporting/commercial-report-tables.js";
import {
  canonicalizeReadableSources,
  deriveReportCitations,
} from "../reporting/report-citation-authority.js";
import {
  deriveConfirmedResearchLanguage,
  deriveReportDispositions,
  deriveReportSubjectLabels,
  deriveTerminalReportSubjectAuthorities,
} from "../reporting/report-projection-authority.js";
import {
  deriveDiscoveryReviewSummaries,
  deriveTerminalReportDocuments,
  localizedTerminalDerivedDocumentIssueDetails,
  terminalReportDocumentsEqual,
} from "../reporting/terminal-reporting.js";
import { type CommercialResearchPolicy, deriveValidAsOf } from "./commercial-research-validator.js";
import { deriveResearchProvenance } from "./research-handoff-validator.js";
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
    ...records(source.excluded_evidence).flatMap((entry) =>
      typeof entry.evidence_ref === "string" ? [entry.evidence_ref] : [],
    ),
    ...commercialProjectionRefs(source),
    ...records(source.commercial_uncertainties).flatMap((entry) => strings(entry.basis_refs)),
    ...records(execution.incomplete_stages).flatMap((entry) => strings(entry.related_refs)),
    ...records(execution.required_followups).flatMap((entry) => strings(entry.related_refs)),
    ...strings(execution.pending_operation_refs),
    ...records(runtime.issues).flatMap((entry) => strings(entry.related_refs)),
    ...records(source.discovery_review_summaries).flatMap(discoveryReviewSummaryRefs),
  ];
}

const DISCOVERY_REVIEW_SUMMARY_MATERIAL_REF_FIELDS = [
  "supporting_refs",
  "opposing_refs",
  "background_refs",
  "contradictory_refs",
  "unknown_refs",
] as const;

function discoveryReviewSummaryRefs(summary: Record<string, unknown>): readonly string[] {
  const materialVisibility = isRecord(summary.material_visibility)
    ? summary.material_visibility
    : {};
  const searchClosure = isRecord(summary.search_closure) ? summary.search_closure : {};
  return [
    ...[
      summary.review_ref,
      summary.owned_output_path,
      summary.task_ref,
      summary.dispatch_batch_ref,
      summary.execution_plan_ref,
      summary.scope_frame_ref,
      summary.research_plan_ref,
    ].flatMap((ref) => (typeof ref === "string" ? [ref] : [])),
    ...strings(summary.reviewed_plan_question_refs),
    ...records(summary.review_findings).flatMap((finding) => [
      ...strings(finding.reviewed_plan_question_refs),
      ...DISCOVERY_REVIEW_SUMMARY_MATERIAL_REF_FIELDS.flatMap((field) => strings(finding[field])),
    ]),
    ...DISCOVERY_REVIEW_SUMMARY_MATERIAL_REF_FIELDS.flatMap((field) =>
      strings(materialVisibility[field]),
    ),
    ...records(summary.decision_relevant_gaps).flatMap((gap) => strings(gap.basis_refs)),
    ...strings(searchClosure.adopted_source_refs),
  ];
}

function discoveryReviewSummaries(
  documents: readonly TerminalReportingDocument[],
): readonly Record<string, unknown>[] {
  return deriveDiscoveryReviewSummaries(
    documents.flatMap((entry) => {
      if (entry.schemaVersion !== "startup_opportunity.discovery_adversarial_review.current") {
        return [];
      }
      return [
        {
          path: entry.path,
          contentHash:
            typeof entry.envelope?.content_hash === "string"
              ? entry.envelope.content_hash
              : canonicalContentHash(entry.document),
          document: entry.document,
        },
      ];
    }),
  );
}

function validateSource(
  entry: TerminalReportingDocument,
  manifest: TerminalReportingDocument | undefined,
  documents: readonly TerminalReportingDocument[],
  commercialPolicy?: CommercialResearchPolicy,
  exactRecords: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): readonly ValidationIssue[] {
  const source = entry.document;
  const errors: ValidationIssue[] = [];
  const expectedCitations = deriveReportCitations(documents, exactRecords, source);
  const envelopesByPath = new Map<string, FormalArtifactEnvelope>(
    documents.map((document) => [
      document.path,
      (document.envelope !== null &&
      typeof document.envelope.content_hash === "string" &&
      isRecord(document.envelope.document)
        ? document.envelope
        : {
            artifact_path: document.path,
            artifact_type: document.schemaVersion,
            content_hash: canonicalContentHash(document.document),
            document: document.document,
          }) as unknown as FormalArtifactEnvelope,
    ]),
  );
  try {
    if (manifest === undefined) throw new Error("current Manifest is missing");
    const expectedLanguage = deriveConfirmedResearchLanguage(manifest.document, exactRecords);
    const expectedSubjectLabels = deriveReportSubjectLabels(
      deriveTerminalReportSubjectAuthorities(source, envelopesByPath),
      envelopesByPath,
      expectedLanguage,
    );
    const expectedDispositions = deriveReportDispositions(
      entry.schemaVersion,
      source,
      envelopesByPath,
    );
    const expectedDiscoveryReviewSummaries = discoveryReviewSummaries(documents);
    for (const [field, actual, expected] of [
      ["research_language", source.research_language, expectedLanguage],
      ["report_subject_labels", source.report_subject_labels, expectedSubjectLabels],
      [
        "report_evidence_dispositions",
        source.report_evidence_dispositions,
        expectedDispositions.reportEvidenceDispositions,
      ],
      [
        "report_source_dispositions",
        source.report_source_dispositions,
        expectedDispositions.reportSourceDispositions,
      ],
    ] as const) {
      if (actual !== undefined && canonicalJson(actual) !== canonicalJson(expected)) {
        errors.push(
          issue(
            "terminal_reporting.mechanical_projection_mismatch",
            `${entry.path}#/${field}`,
            "terminal report language and Evidence dispositions must be mechanically derived from exact current-Run authorities",
            { field, expected },
          ),
        );
      }
    }
    if (
      (source.discovery_review_summaries !== undefined ||
        expectedDiscoveryReviewSummaries.length > 0) &&
      canonicalJson(records(source.discovery_review_summaries)) !==
        canonicalJson(expectedDiscoveryReviewSummaries)
    ) {
      errors.push(
        issue(
          "terminal_reporting.mechanical_projection_mismatch",
          `${entry.path}#/discovery_review_summaries`,
          "terminal Discovery review summaries must be mechanically derived from exact current-Run review authorities",
          { field: "discovery_review_summaries", expected: expectedDiscoveryReviewSummaries },
        ),
      );
    }
  } catch (error) {
    errors.push(
      issue(
        "terminal_reporting.mechanical_projection_invalid",
        entry.path,
        error instanceof Error ? error.message : "terminal report authority derivation failed",
      ),
    );
  }
  if (
    source.report_citations !== undefined &&
    canonicalJson(source.report_citations) !== canonicalJson(expectedCitations)
  ) {
    errors.push(
      issue(
        "terminal_reporting.citation_authority_mismatch",
        `${entry.path}#/report_citations`,
        "readable report citations must be mechanically derived from exact typed Evidence substrate sources",
        { expected: expectedCitations },
      ),
    );
  }
  const canonicalSources = canonicalizeReadableSources(records(source.sources), expectedCitations);
  if (
    source.report_citations !== undefined &&
    (canonicalSources.missingEvidenceRefs.length > 0 ||
      canonicalJson(source.sources) !== canonicalJson(canonicalSources.sources))
  ) {
    errors.push(
      issue(
        "terminal_reporting.source_authority_mismatch",
        `${entry.path}#/sources`,
        "readable source labels and URLs must close to exact typed Evidence substrate authority",
        { missingEvidenceRefs: canonicalSources.missingEvidenceRefs },
      ),
    );
  }
  const expectedStatistics = deriveReportStatistics(source);
  if (
    source.report_statistics !== undefined &&
    canonicalJson(source.report_statistics) !== canonicalJson(expectedStatistics)
  ) {
    errors.push(
      issue(
        "terminal_reporting.statistics_mismatch",
        `${entry.path}#/report_statistics`,
        "report counts must be mechanically derived from the final structured report model",
        { expected: expectedStatistics },
      ),
    );
  }
  if (!isRecord(source.research_provenance)) {
    errors.push(
      issue(
        "terminal_reporting.research_provenance_missing",
        `${entry.path}#/research_provenance`,
        "formal terminal reports require Harness-derived current and inherited research provenance",
      ),
    );
  } else {
    const expected = deriveResearchProvenance(
      String(source.run_id),
      documents,
      exactRecords,
      entry.path,
    );
    if (canonicalJson(source.research_provenance) !== canonicalJson(expected)) {
      errors.push(
        issue(
          "terminal_reporting.research_provenance_mismatch",
          `${entry.path}#/research_provenance`,
          "terminal research provenance must exactly project same-Run handoffs and Evidence records",
          { expected },
        ),
      );
    }
  }
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
  const currentDecisionSubjectIds = new Set(strings(source.current_decision_subject_ids));
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

  const rankedDirections = directions.filter((direction) => direction.ranking_status === "ranked");
  const priorities = rankedDirections.map((direction) => Number(direction.priority));
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
  for (const [index, direction] of directions.entries()) {
    if (
      (direction.ranking_status === "ranked" && !Number.isInteger(direction.priority)) ||
      (direction.ranking_status === "unranked_hypothesis" &&
        (direction.priority !== null ||
          !["validate", "defer", "reject"].includes(String(direction.action))))
    ) {
      errors.push(
        issue(
          "terminal_reporting.direction_ranking_mismatch",
          `${entry.path}#/directions/${index}`,
          "commercially unsupported directions must remain unranked hypotheses and cannot be investment recommendations",
        ),
      );
    }
  }
  const projectedSubjectIds = [
    ...records(source.quantitative_signal_rows).map((row) => {
      const observation = isRecord(row.observation) ? row.observation : {};
      return String(observation.subject_id);
    }),
    ...records(source.competitive_substitute_rows).map((row) => {
      const competitiveObject = isRecord(row.competitive_object) ? row.competitive_object : {};
      return String(competitiveObject.subject_id);
    }),
    ...records(source.incumbent_response_risk_rows).map((row) => {
      const assessment = isRecord(row.assessment) ? row.assessment : {};
      const semantic = isRecord(assessment.semantic) ? assessment.semantic : {};
      return String(semantic.subject_id);
    }),
    ...records(source.research_coverage_gaps).flatMap((row) => {
      const coverage = isRecord(row.coverage) ? row.coverage : {};
      return typeof coverage.subject_id === "string"
        ? [coverage.subject_id]
        : strings(row.subject_ids);
    }),
    ...records(source.commercial_subject_aggregates).map((aggregate) =>
      String(aggregate.subject_id),
    ),
    ...records(source.commercial_uncertainties).map((entry) => String(entry.direction_id)),
  ].filter((subjectId) => subjectId !== "undefined");
  const unrelatedProjectionIds = projectedSubjectIds.filter(
    (subjectId) => !currentDecisionSubjectIds.has(subjectId),
  );
  const aggregateIds = records(source.commercial_subject_aggregates)
    .map((aggregate) => String(aggregate.subject_id))
    .sort();
  if (
    unrelatedProjectionIds.length > 0 ||
    canonicalContentHash(aggregateIds) !==
      canonicalContentHash([...currentDecisionSubjectIds].sort())
  ) {
    errors.push(
      issue(
        "terminal_reporting.decision_subject_projection_mismatch",
        entry.path,
        "directions and all primary commercial report projections must contain only the authoritative current final subjects; aggregates must cover that set exactly",
        { unrelatedProjectionIds: [...new Set(unrelatedProjectionIds)].sort(), aggregateIds },
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
    if (direction.ranking_status === "ranked") {
      const support = sources.filter(
        (candidate) =>
          strings(direction.decisive_support_source_ids).includes(String(candidate.source_id)) &&
          candidate.claim_state === "observed" &&
          candidate.freshness_status === "current" &&
          candidate.source_kind !== "academic" &&
          candidate.source_kind !== "vendor" &&
          candidate.evidence_character !== "vendor_claim",
      );
      const requiredCommercialKeys = new Set([
        "purchase_signal",
        "alternatives_pricing_usage",
        "distribution_channel",
      ]);
      const supportedKeys = new Set(
        support.flatMap((candidate) => strings(candidate.commercial_coverage_keys)),
      );
      if ([...requiredCommercialKeys].some((key) => !supportedKeys.has(key))) {
        errors.push(
          issue(
            "terminal_reporting.direction_commercial_support_missing",
            `${entry.path}#/directions/${index}`,
            "ranked directions require direct purchase, alternatives/pricing/usage, and distribution support",
          ),
        );
      }
    }
  }

  const audits = documents.filter(
    (candidate) =>
      candidate.schemaVersion === "startup_opportunity.commercial_research_audit.current" &&
      strings(source.commercial_research_audit_refs).includes(candidate.path),
  );
  const allAudits = documents.filter(
    (candidate) =>
      candidate.schemaVersion === "startup_opportunity.commercial_research_audit.current",
  );
  const reportAuditRefs = new Set(strings(source.commercial_research_audit_refs));
  const auditAppendixRefs = sourceAuditRefs(source);
  const omittedAudits = allAudits
    .map((audit) => audit.path)
    .filter((ref) => !reportAuditRefs.has(ref));
  const omittedDiscoveryReviews = documents
    .filter(
      (candidate) =>
        candidate.schemaVersion === "startup_opportunity.discovery_adversarial_review.current",
    )
    .map((review) => review.path)
    .filter((ref) => !auditAppendixRefs.has(ref));
  const taskAuditPaths = documents
    .filter((candidate) =>
      [
        "startup_opportunity.research_task.assessment.current",
        "startup_opportunity.research_task.discovery_candidate.current",
        "startup_opportunity.research_task.discovery_evaluation.current",
        "startup_opportunity.research_task.discovery_review.current",
      ].includes(candidate.schemaVersion),
    )
    .filter((candidate) =>
      isCommercialAuditRelevantTask({
        path: candidate.path,
        document: candidate.document,
      }),
    )
    .flatMap((task) => {
      const requirements = isRecord(task.document.commercial_research_requirements)
        ? task.document.commercial_research_requirements
        : {};
      return typeof requirements.commercial_audit_output_path === "string"
        ? [requirements.commercial_audit_output_path]
        : [];
    });
  const executionPlans = documents
    .filter(
      (candidate) =>
        [
          "startup_opportunity.research_execution_plan.discovery.current",
          "startup_opportunity.research_execution_plan.assessment.current",
        ].includes(candidate.schemaVersion) && candidate.document.run_id === source.run_id,
    )
    .sort(
      (left, right) =>
        Number(right.document.revision) - Number(left.document.revision) ||
        left.path.localeCompare(right.path),
    );
  const currentExecutionPlan = executionPlans[0];
  const plannedLaneAuditPaths: string[] = [];
  if (currentExecutionPlan !== undefined) {
    const executionPlansByPath = new Map(
      executionPlans.map((execution) => [execution.path, execution]),
    );
    const dispatches = documents.filter((candidate) =>
      [
        "startup_opportunity.dispatch_batch.discovery.current",
        "startup_opportunity.dispatch_batch.assessment.current",
      ].includes(candidate.schemaVersion),
    );
    const tasksByUnit = new Map(
      documents
        .filter((candidate) =>
          [
            "startup_opportunity.research_task.assessment.current",
            "startup_opportunity.research_task.discovery_candidate.current",
            "startup_opportunity.research_task.discovery_evaluation.current",
            "startup_opportunity.research_task.discovery_review.current",
          ].includes(candidate.schemaVersion),
        )
        .map((task) => [String(task.document.unit_id), task]),
    );
    for (const stage of records(currentExecutionPlan.document.stages)) {
      const expectedLaneKind =
        stage.stage_kind === "discovery_synthesis"
          ? "synthesis_or_validation"
          : "external_research";
      for (const lane of records(stage.lanes)) {
        const unitId = String(lane.unit_id ?? "");
        const auditPath = `artifacts/research-audits/${unitId}.json`;
        const audit = allAudits.find((candidate) => candidate.path === auditPath);
        const task = tasksByUnit.get(unitId);
        const requiresCommercialAudit =
          String(lane.submission_schema ?? "") !==
          "startup_opportunity.discovery_adversarial_review.current";
        if (requiresCommercialAudit) {
          plannedLaneAuditPaths.push(auditPath);
        }
        const auditExecution =
          audit === undefined || typeof audit.document.execution_plan_ref !== "string"
            ? undefined
            : executionPlansByPath.get(audit.document.execution_plan_ref);
        const auditLane = records(auditExecution?.document.stages)
          .flatMap((candidateStage) => records(candidateStage.lanes))
          .find((candidateLane) => candidateLane.unit_id === unitId);
        const matchingDispatches = dispatches.flatMap((dispatch) =>
          dispatch.document.execution_plan_ref === auditExecution?.path
            ? records(dispatch.document.tasks)
                .filter((candidateTask) => candidateTask.unit_id === unitId)
                .map((candidateTask) => ({
                  path: dispatch.path,
                  taskId: String(candidateTask.task_id ?? ""),
                }))
            : [],
        );
        if (matchingDispatches.length > 1) {
          errors.push(
            issue(
              "terminal_reporting.dispatch_lane_duplicate",
              auditExecution?.path ?? currentExecutionPlan.path,
              "one executed lane may have only one dispatch task in its bound Execution Plan",
              { unitId },
            ),
          );
        }
        const dispatch = matchingDispatches[0];
        const expectedDispatchRef =
          dispatch === undefined ? null : `${dispatch.path}#${dispatch.taskId}`;
        if (audit === undefined) continue;
        const closure = isRecord(audit.document.search_closure)
          ? audit.document.search_closure
          : {};
        const bindingMismatch =
          audit.document.unit_id !== unitId ||
          auditExecution === undefined ||
          auditLane === undefined ||
          canonicalContentHash(auditLane) !== canonicalContentHash(lane) ||
          audit.document.dispatch_task_ref !== expectedDispatchRef ||
          audit.document.task_ref !== (task?.path ?? null) ||
          closure.closure_id !== `search_closure_${unitId}` ||
          closure.lane_kind !== expectedLaneKind ||
          (task === undefined &&
            closure.outcome !==
              (expectedLaneKind === "external_research"
                ? "failed_before_search"
                : "search_not_required"));
        if (bindingMismatch) {
          errors.push(
            issue(
              "terminal_reporting.search_closure_binding_mismatch",
              audit.path,
              "Search Closure must bind the current Execution Plan lane, Dispatch task, optional Research Task, and pre-Task terminal outcome",
              {
                unitId,
                executionPlanRef: currentExecutionPlan.path,
                dispatchTaskRef: expectedDispatchRef,
                taskRef: task?.path ?? null,
                laneKind: expectedLaneKind,
              },
            ),
          );
        }
      }
    }
  }
  const missingClosures = [...new Set([...plannedLaneAuditPaths, ...taskAuditPaths])]
    .filter((auditPath) => {
      const audit = allAudits.find((candidate) => candidate.path === auditPath);
      return audit === undefined || !isRecord(audit.document.search_closure);
    })
    .sort();
  if (omittedAudits.length > 0 || missingClosures.length > 0) {
    errors.push(
      issue(
        "terminal_reporting.search_closure_incomplete",
        `${entry.path}#/commercial_research_audit_refs`,
        "final reporting requires a Search Closure for every planned lane and must include every validated commercial audit",
        { omittedAudits: omittedAudits.sort(), missingClosures },
      ),
    );
  }
  if (omittedDiscoveryReviews.length > 0) {
    errors.push(
      issue(
        "terminal_reporting.audit_closure_missing",
        `${entry.path}#/audit_refs`,
        "terminal reporting must retain Discovery adversarial review results in the audit appendix as reference-only material",
        { omittedDiscoveryReviews: omittedDiscoveryReviews.sort() },
      ),
    );
  }
  for (const [index, direction] of rankedDirections.entries()) {
    if (
      !audits.some(
        (audit) =>
          audit.document.ranking_eligibility === "ranked" &&
          strings(audit.document.covered_direction_ids).includes(String(direction.direction_id)),
      )
    ) {
      errors.push(
        issue(
          "terminal_reporting.commercial_audit_missing",
          `${entry.path}#/directions/${index}`,
          "each ranked direction requires a closed commercial research audit",
        ),
      );
    }
  }
  const reportDirectionIds = new Set(directions.map((direction) => String(direction.direction_id)));
  const uncertaintyEntries = records(source.commercial_uncertainties);
  const uncertaintyByIdentity = new Map(
    uncertaintyEntries.map((projection) => [
      `${String(projection.direction_id)}:${String(projection.coverage_key)}`,
      projection,
    ]),
  );
  if (uncertaintyByIdentity.size !== uncertaintyEntries.length) {
    errors.push(
      issue(
        "terminal_reporting.commercial_uncertainty_duplicate",
        `${entry.path}#/commercial_uncertainties`,
        "each direction and commercial dimension may have only one report uncertainty projection",
      ),
    );
  }
  const requiredUncertaintyIdentities = new Set<string>();
  for (const audit of audits) {
    const coverage = isRecord(audit.document.coverage) ? audit.document.coverage : {};
    for (const directionId of strings(audit.document.covered_direction_ids).filter((directionId) =>
      reportDirectionIds.has(directionId),
    )) {
      for (const coverageKey of [
        "recent_user_language",
        "purchase_signal",
        "alternatives_pricing_usage",
        "distribution_channel",
        "independent_counterevidence",
      ]) {
        const coverageEntry = isRecord(coverage[coverageKey]) ? coverage[coverageKey] : {};
        if (!["inferred", "unknown"].includes(String(coverageEntry.state))) continue;
        const identity = `${directionId}:${coverageKey}`;
        requiredUncertaintyIdentities.add(identity);
        const projection = uncertaintyByIdentity.get(identity);
        const inference = isRecord(coverageEntry.inference) ? coverageEntry.inference : null;
        const validProjection =
          projection !== undefined &&
          projection.state === coverageEntry.state &&
          (coverageEntry.state === "inferred"
            ? inference !== null &&
              canonicalContentHash(projection.basis_refs) ===
                canonicalContentHash(inference.basis_refs) &&
              projection.starting_point === inference.starting_point &&
              projection.reasoning === inference.reasoning &&
              projection.uncertainty === inference.uncertainty &&
              projection.validation_needed === inference.validation_needed
            : Array.isArray(projection.basis_refs) &&
              projection.basis_refs.length === 0 &&
              projection.starting_point === null &&
              projection.reasoning === null);
        if (!validProjection) {
          errors.push(
            issue(
              "terminal_reporting.commercial_uncertainty_missing",
              `${entry.path}#/commercial_uncertainties`,
              "every inferred or unknown commercial dimension relevant to a reported direction must remain explicit in the user report with its reasoning or validation gap",
              { directionId, coverageKey, state: coverageEntry.state, auditRef: audit.path },
            ),
          );
        }
      }
    }
  }
  const unrelatedUncertainties = [...uncertaintyByIdentity.keys()].filter(
    (identity) => !requiredUncertaintyIdentities.has(identity),
  );
  if (unrelatedUncertainties.length > 0) {
    errors.push(
      issue(
        "terminal_reporting.commercial_uncertainty_unrelated",
        `${entry.path}#/commercial_uncertainties`,
        "commercial uncertainty projections must correspond to an Audit dimension for a reported direction",
        { identities: unrelatedUncertainties.sort() },
      ),
    );
  }

  const dates = sources
    .flatMap((candidate) =>
      typeof candidate.valid_as_of === "string" ? [candidate.valid_as_of] : [],
    )
    .sort();
  for (const [index, sourceEntry] of sources.entries()) {
    const expectedValidAsOf = deriveValidAsOf(sourceEntry);
    if (sourceEntry.valid_as_of !== expectedValidAsOf) {
      errors.push(
        issue(
          "terminal_reporting.source_date_semantics",
          `${entry.path}#/sources/${index}`,
          "valid-as-of must be derived from observation date, data-period end, or publication date; retrieval time is audit-only",
          { expectedValidAsOf },
        ),
      );
    }
    const inference = isRecord(sourceEntry.inference) ? sourceEntry.inference : null;
    if (
      (sourceEntry.claim_state === "inferred" &&
        (inference === null ||
          strings(inference.basis_refs).length === 0 ||
          !strings(inference.basis_refs).includes(String(sourceEntry.evidence_ref)))) ||
      (sourceEntry.claim_state === "observed" && inference !== null) ||
      (sourceEntry.evidence_character === "inference" && sourceEntry.claim_state !== "inferred")
    ) {
      errors.push(
        issue(
          "terminal_reporting.claim_state_mismatch",
          `${entry.path}#/sources/${index}`,
          "inferred report claims require an explicit basis, reasoning, uncertainty, and validation need and cannot be presented as observed fact",
        ),
      );
    }
    if (commercialPolicy !== undefined) {
      const validAsOf = expectedValidAsOf;
      const claimType = String(sourceEntry.claim_type ?? "");
      const historical = commercialPolicy.historical_claim_types.includes(claimType);
      const window = commercialPolicy.claim_freshness_windows_days[claimType];
      const reportDate = String(source.generated_at).slice(0, 10);
      const ageDays =
        validAsOf === null
          ? null
          : Math.floor((Date.parse(reportDate) - Date.parse(validAsOf)) / 86_400_000);
      const expectedFreshness =
        validAsOf === null ||
        (claimType === "market_structure_regulatory" &&
          typeof sourceEntry.regulatory_status_verified_at !== "string")
          ? "undated"
          : historical ||
              window === undefined ||
              ageDays === null ||
              ageDays < 0 ||
              ageDays > window
            ? "historical"
            : "current";
      if (sourceEntry.freshness_status !== expectedFreshness) {
        errors.push(
          issue(
            "terminal_reporting.source_freshness_mismatch",
            `${entry.path}#/sources/${index}/freshness_status`,
            "report source freshness must follow the claim-specific current window",
            { expectedFreshness, claimType },
          ),
        );
      }
      if (
        claimType === "market_structure_regulatory" &&
        (typeof sourceEntry.regulatory_status_verified_at !== "string" ||
          ![
            "effective",
            "partially_effective",
            "not_yet_effective",
            "repealed",
            "unknown",
          ].includes(String(sourceEntry.regulatory_effective_status)))
      ) {
        errors.push(
          issue(
            "terminal_reporting.regulatory_status_unverified",
            `${entry.path}#/sources/${index}`,
            "a regulatory report claim requires an explicit recently verified effective state; enactment or publication year alone is insufficient",
          ),
        );
      }
    }
    if (
      sourceEntry.source_kind === "academic" &&
      strings(sourceEntry.commercial_coverage_keys).some((key) =>
        [
          "buyer",
          "purchase_signal",
          "pricing",
          "alternatives_pricing_usage",
          "distribution_channel",
          "retention",
          "unit_economics",
        ].includes(key),
      )
    ) {
      errors.push(
        issue(
          "terminal_reporting.academic_commercial_coverage",
          `${entry.path}#/sources/${index}`,
          "academic sources cannot satisfy buyer, pricing, distribution, retention, or unit-economics coverage",
        ),
      );
    }
  }
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
  const evidenceSchemaVersions = new Set([
    "startup_opportunity.evidence.assessment.current",
    "startup_opportunity.evidence.discovery_candidate.current",
    "startup_opportunity.evidence.discovery_evaluation.current",
    "startup_opportunity.assessment_evidence.v1",
    "startup_opportunity.candidate_neutral_evidence.v1",
  ]);
  const validatedEvidenceRefs = documents
    .filter((candidate) => evidenceSchemaVersions.has(candidate.schemaVersion))
    .map((candidate) => candidate.path)
    .sort();
  if (validatedEvidenceRefs.length > 0) {
    const included = new Set(sources.map((candidate) => String(candidate.evidence_ref)));
    const excluded = records(source.excluded_evidence);
    const excludedRefs = new Set(excluded.map((candidate) => String(candidate.evidence_ref)));
    const missing = validatedEvidenceRefs.filter(
      (ref) => !included.has(ref) && !excludedRefs.has(ref),
    );
    const overlap = validatedEvidenceRefs.filter(
      (ref) => included.has(ref) && excludedRefs.has(ref),
    );
    if (missing.length > 0 || overlap.length > 0) {
      errors.push(
        issue(
          "terminal_reporting.evidence_disposition_incomplete",
          `${entry.path}#/excluded_evidence`,
          "every validated Evidence item in the original Run must be included or excluded with a reason",
          { missing, overlap },
        ),
      );
    }
  }
  return errors;
}

export function validateTerminalReportingContract(
  documents: readonly TerminalReportingDocument[],
  commercialPolicy?: CommercialResearchPolicy,
  exactRecords: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): readonly ValidationIssue[] {
  const relevant = documents.filter((entry) =>
    [
      "startup_opportunity.terminal_report_source.v1",
      "startup_opportunity.decision_brief.terminal.current",
      "startup_opportunity.terminal_report_view.v1",
      "startup_opportunity.report_consistency_evaluation.terminal.current",
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
  errors.push(...validateSource(source, manifest, documents, commercialPolicy, exactRecords));

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
  const localizedIssues = expected.flatMap((derived) =>
    localizedTerminalDerivedDocumentIssueDetails(source.document, derived.document).map(
      (entry) => `${entry.code}:${entry.field}`,
    ),
  );
  if (localizedIssues.length > 0) {
    errors.push(
      issue(
        "terminal_reporting.localized_internal_term",
        source.path,
        "localized user report surfaces must not expose internal contract terminology",
        { localizedIssues: [...new Set(localizedIssues)].sort() },
      ),
    );
  }
  for (const derived of expected) {
    const actual = relevant.find((entry) => entry.path === derived.artifactPath);
    if (actual === undefined) {
      continue;
    }
    const actualLocalizedIssues = localizedTerminalDerivedDocumentIssueDetails(
      source.document,
      actual.document,
    ).map((entry) => `${entry.code}:${entry.field}`);
    if (actualLocalizedIssues.length > 0) {
      errors.push(
        issue(
          "terminal_reporting.localized_internal_term",
          actual.path,
          "localized user report surfaces must not expose internal contract terminology",
          { localizedIssues: [...new Set(actualLocalizedIssues)].sort() },
        ),
      );
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

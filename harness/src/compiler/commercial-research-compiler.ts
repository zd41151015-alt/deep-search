import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import {
  INCUMBENT_RESPONSE_CONTEXT_ONLY,
  INCUMBENT_RESPONSE_STRATEGIC_CONTEXT,
  INCUMBENT_RESPONSE_UNKNOWN_RATIONALE,
} from "../incumbent-response-contract.js";
import type { CommercialResearchPolicy } from "../validators/commercial-research-validator.js";
import {
  deriveBusinessCoverage,
  deriveClaimConfidence,
  deriveFreshnessStatus,
  derivePortfolioRecommendationCeiling,
  deriveSourceConcentration,
  deriveSourceDistribution,
  deriveSubjectAssessments,
  deriveSubjectRecommendationCeilings,
  deriveValidAsOf,
  isTraceableDirectSource,
  REQUIRED_RANKING_KEYS,
} from "../validators/commercial-research-validator.js";
import { projectGateWarnings } from "../validators/gate-diagnostics.js";
import {
  deriveQuantitativeDecisionUse,
  hasDecisionGradeQuantitativeSignal,
  isFormalScopeDisposed,
  isQuantitativeCoverageFormallyComplete,
} from "../validators/quantitative-research-semantics.js";
import type { ValidationIssue } from "../validators/schema-bundle.js";

interface SourceArtifact {
  readonly artifact_type: string;
  readonly artifact_path: string;
  readonly document: Record<string, unknown>;
}

export interface CommercialCompilation {
  readonly document: Record<string, unknown>;
  readonly issues: readonly ValidationIssue[];
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

function effectiveDocument(artifact: SourceArtifact): Record<string, unknown> {
  return artifact.document.schema_version === "startup_opportunity.artifact_envelope.current" &&
    isRecord(artifact.document.document)
    ? artifact.document.document
    : artifact.document;
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${canonicalContentHash(value).slice("sha256:".length, "sha256:".length + 24)}`;
}

function issue(code: string, path: string, message: string, details = {}): ValidationIssue {
  return {
    code,
    keyword: "commercial_compiler",
    instancePath: path,
    schemaPath: "",
    message,
    details,
  };
}

function gapKey(kind: string, subject: string, dimension: string): string {
  return `${kind}:${subject}:${dimension}`;
}

function acquisitionMethod(value: unknown): string {
  return typeof value === "string" ? value : "other";
}

function acquisitionRouteClass(value: unknown): string {
  return (
    (
      {
        public_api: "public_api",
        official_dataset: "public_dataset",
        downloadable_dataset: "public_dataset",
        repository_dataset: "public_dataset",
        user_provided_dataset: "authorized_data",
        authorized_commercial_api: "authorized_data",
        webpage: "public_web",
      } as Readonly<Record<string, string>>
    )[String(value)] ?? "other"
  );
}

const INCUMBENT_RESPONSE_AUTOMATIC_EFFECTS = {
  ranking_eligibility: false,
  claim_confidence: false,
  recommendation_ceiling: false,
  artifact_publication: false,
} as const;

function unknownIncumbentResponse(
  subjectId: string,
  input: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const unknown = (rationale: string) => ({ level: "unknown", rationale });
  const rationale = INCUMBENT_RESPONSE_UNKNOWN_RATIONALE;
  return {
    subject_id: subjectId,
    analysis_state: "unknown",
    responder_identity: null,
    responder_category: null,
    control_point: null,
    response_modes: [],
    capability_adjacency: unknown(rationale),
    response_cost: {
      implementation: unknown(rationale),
      operational: unknown(rationale),
      compliance: unknown(rationale),
      data: unknown(rationale),
      distribution: unknown(rationale),
    },
    incentive: {
      level: "unknown",
      drivers: [],
      disincentives: [],
      cannibalization: rationale,
      rationale,
    },
    plausible_response_horizon: { band: "unknown", rationale },
    distribution_leverage: { level: "unknown", control_points: [], rationale },
    thesis_coverage: {
      scope: "unknown",
      covered_elements: [],
      uncovered_elements: [],
      rationale,
    },
    residual_differentiation: {
      overall_strength: "unknown",
      dimensions: [],
      rationale,
    },
    supporting_evidence_refs: strings(input.supporting_evidence_refs),
    opposing_evidence_refs: strings(input.opposing_evidence_refs),
    background_evidence_refs: strings(input.background_evidence_refs),
    inference_boundary: rationale,
    confidence: "unknown",
    uncertainty: typeof input.uncertainty === "string" ? input.uncertainty : rationale,
    unknowns:
      strings(input.unknowns).length > 0
        ? strings(input.unknowns)
        : ["Potential responder identity, ability, incentive, and response horizon are unknown."],
    data_gaps:
      strings(input.data_gaps).length > 0
        ? strings(input.data_gaps)
        : [
            "No Evidence-role binding and assessment semantics sufficient to complete the incumbent response assessment were submitted.",
          ],
    strategic_implication: INCUMBENT_RESPONSE_STRATEGIC_CONTEXT,
  };
}

function notApplicableIncumbentResponse(
  subjectId: string,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const rationale =
    typeof input.rationale === "string"
      ? input.rationale
      : "No relevant potential responder or controlled response point applies within the assigned scope.";
  const graded = { level: "not_applicable", rationale };
  return {
    subject_id: subjectId,
    analysis_state: "not_applicable",
    responder_identity: null,
    responder_category: null,
    control_point: null,
    response_modes: [],
    capability_adjacency: graded,
    response_cost: {
      implementation: graded,
      operational: graded,
      compliance: graded,
      data: graded,
      distribution: graded,
    },
    incentive: {
      level: "not_applicable",
      drivers: [],
      disincentives: [],
      cannibalization: rationale,
      rationale,
    },
    plausible_response_horizon: { band: "not_applicable", rationale },
    distribution_leverage: { level: "not_applicable", control_points: [], rationale },
    thesis_coverage: {
      scope: "not_applicable",
      covered_elements: [],
      uncovered_elements: [],
      rationale,
    },
    residual_differentiation: {
      overall_strength: "not_applicable",
      dimensions: [],
      rationale,
    },
    supporting_evidence_refs: [],
    opposing_evidence_refs: [],
    background_evidence_refs: strings(input.background_evidence_refs),
    inference_boundary: rationale,
    confidence: "not_applicable",
    uncertainty: rationale,
    unknowns: [],
    data_gaps: [],
    strategic_implication: INCUMBENT_RESPONSE_STRATEGIC_CONTEXT,
  };
}

function normalizeIncumbentResponse(
  subjectId: string,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (input.analysis_state === "unknown") return unknownIncumbentResponse(subjectId, input);
  if (input.analysis_state === "not_applicable") {
    return notApplicableIncumbentResponse(subjectId, input);
  }
  return {
    subject_id: subjectId,
    analysis_state: "assessed",
    responder_identity: structuredClone(input.responder_identity),
    responder_category: structuredClone(input.responder_category),
    control_point: structuredClone(input.control_point),
    response_modes: structuredClone(input.response_modes),
    capability_adjacency: structuredClone(input.capability_adjacency),
    response_cost: structuredClone(input.response_cost),
    incentive: structuredClone(input.incentive),
    plausible_response_horizon: structuredClone(input.plausible_response_horizon),
    distribution_leverage: structuredClone(input.distribution_leverage),
    thesis_coverage: structuredClone(input.thesis_coverage),
    residual_differentiation: structuredClone(input.residual_differentiation),
    supporting_evidence_refs: structuredClone(input.supporting_evidence_refs),
    opposing_evidence_refs: structuredClone(input.opposing_evidence_refs),
    background_evidence_refs: structuredClone(input.background_evidence_refs),
    inference_boundary: structuredClone(input.inference_boundary),
    confidence: structuredClone(input.confidence),
    uncertainty: structuredClone(input.uncertainty),
    unknowns: structuredClone(input.unknowns),
    data_gaps: structuredClone(input.data_gaps),
    strategic_implication: INCUMBENT_RESPONSE_STRATEGIC_CONTEXT,
  };
}

export function compileCommercialResearchDelivery(
  delivery: Record<string, unknown>,
  taskPath: string,
  availableArtifacts: readonly SourceArtifact[],
  policy: CommercialResearchPolicy,
): CommercialCompilation {
  const issues: ValidationIssue[] = [];
  const byPath = new Map(
    availableArtifacts.map((artifact) => [artifact.artifact_path, effectiveDocument(artifact)]),
  );
  const task = byPath.get(taskPath) ?? {};
  const requirements = isRecord(task.commercial_research_requirements)
    ? task.commercial_research_requirements
    : {};
  const scope = isRecord(requirements.quantitative_competitive_scope)
    ? requirements.quantitative_competitive_scope
    : {};
  const taskAssignment = isRecord(requirements.incumbent_response_assignment)
    ? requirements.incumbent_response_assignment
    : {
        analysis_depth: "not_assigned",
        assignment_role: "none",
        subject_refs: [],
        rationale: "Not assigned.",
      };
  const auditPath = String(requirements.commercial_audit_output_path);
  const subjectIdFromRef = (ref: string): string => {
    const [targetPath = ref, fragment] = ref.split("#", 2);
    if (fragment !== undefined && fragment !== "") return fragment;
    const target = byPath.get(targetPath) ?? {};
    for (const field of [
      "opportunity_id",
      "direction_id",
      "candidate_id",
      "concept_hypothesis_id",
      "hypothesis_id",
    ]) {
      if (typeof target[field] === "string") return target[field];
    }
    return (
      targetPath
        .split("/")
        .at(-1)
        ?.replace(/\.json$/u, "")
        .replace(/[^A-Za-z0-9._:-]+/gu, "_") ?? targetPath
    );
  };
  const unitId = String(delivery.unit_id);
  const taskId = typeof task.task_id === "string" ? task.task_id : null;
  const dispatchArtifacts = availableArtifacts.filter((artifact) =>
    records(effectiveDocument(artifact).tasks).some(
      (item) => item.unit_id === unitId && (taskId === null || item.task_id === taskId),
    ),
  );
  const dispatchArtifact = dispatchArtifacts.length === 1 ? dispatchArtifacts[0] : undefined;
  const dispatch = dispatchArtifact === undefined ? {} : effectiveDocument(dispatchArtifact);
  const dispatchTask = records(dispatch.tasks).find(
    (item) => item.unit_id === unitId && (taskId === null || item.task_id === taskId),
  );
  const dispatchTaskRef =
    dispatchArtifact !== undefined && typeof dispatchTask?.task_id === "string"
      ? `${dispatchArtifact.artifact_path}#${dispatchTask.task_id}`
      : null;
  const executionPlanRef =
    typeof dispatch.execution_plan_ref === "string" ? dispatch.execution_plan_ref : null;
  const executionPlan = executionPlanRef === null ? {} : (byPath.get(executionPlanRef) ?? {});
  const executionStage = records(executionPlan.stages).find(
    (stage) => stage.stage_id === dispatch.stage_id,
  );
  const executionLane = records(executionStage?.lanes).find((lane) => lane.unit_id === unitId);
  const planAssignment = isRecord(executionLane?.incumbent_response_assignment)
    ? executionLane.incumbent_response_assignment
    : undefined;
  const dispatchAssignment = isRecord(dispatchTask?.incumbent_response_assignment)
    ? dispatchTask.incumbent_response_assignment
    : undefined;
  if (dispatchArtifacts.length !== 1) {
    issues.push(
      issue(
        "commercial_research.incumbent_response_dispatch_resolution_invalid",
        "/unit_id",
        "every incumbent response assignment requires exactly one Dispatch task bound by task_id and unit_id",
        { taskId, unitId, dispatchCount: dispatchArtifacts.length },
      ),
    );
  }
  if (executionPlanRef === null || executionLane === undefined) {
    issues.push(
      issue(
        "commercial_research.incumbent_response_plan_resolution_invalid",
        "/unit_id",
        "every incumbent response assignment requires the exact Execution Plan stage and lane",
        { executionPlanRef, stageId: dispatch.stage_id, unitId },
      ),
    );
  }
  if (
    planAssignment !== undefined &&
    dispatchAssignment !== undefined &&
    canonicalJson(planAssignment) !== canonicalJson(dispatchAssignment)
  ) {
    issues.push(
      issue(
        "commercial_research.incumbent_response_plan_dispatch_mismatch",
        "/incumbent_response_assignment",
        "Dispatch must be the deterministic projection of the Execution Plan incumbent response assignment",
      ),
    );
  }
  if (
    planAssignment !== undefined &&
    canonicalJson(planAssignment) !== canonicalJson(taskAssignment)
  ) {
    issues.push(
      issue(
        "commercial_research.incumbent_response_plan_task_mismatch",
        "/commercial_research_requirements/incumbent_response_assignment",
        "Research Task must be the deterministic projection of the Execution Plan incumbent response assignment",
      ),
    );
  }
  const incumbentAssignment = planAssignment ?? {
    analysis_depth: "not_assigned",
    assignment_role: "none",
    subject_refs: [],
    rationale: "No valid Execution Plan assignment was resolved.",
  };

  const evidence: Record<string, unknown>[] = records(delivery.evidence_sources).map((source) => {
    const copy = structuredClone(source);
    const profile = isRecord(copy.source_profile) ? copy.source_profile : {};
    if (profile.type === "regulatory") {
      copy.regulatory_effective_status = profile.effective_status;
      copy.regulatory_status_verified_at = profile.verified_at;
    }
    if (profile.type === "news") {
      copy.published_at = profile.published_at;
    }
    return {
      ...copy,
      derived_valid_as_of: deriveValidAsOf(copy),
      freshness_status: deriveFreshnessStatus(copy, delivery.audited_at, policy),
    } as Record<string, unknown>;
  });
  const evidenceByRef = new Map(evidence.map((item) => [String(item.evidence_ref), item]));
  const searchResults = records(delivery.search_results);
  const declaredObjectives = strings(delivery.research_objectives);
  const searchGroups = new Map<string, { objective: string; route: string | null }>();
  for (const objective of declaredObjectives) {
    searchGroups.set(`${objective}\u0000`, { objective, route: null });
  }
  for (const result of searchResults) {
    const objective = String(result.objective);
    const route = String(result.route);
    searchGroups.delete(`${objective}\u0000`);
    searchGroups.set(`${objective}\u0000${route}`, { objective, route });
    if (!declaredObjectives.includes(objective)) {
      issues.push(
        issue(
          "commercial_research.search_objective_unplanned",
          "/search_results",
          "a formally recorded result used an undeclared objective; the compiler retained it in Search Log",
          { objective, route },
        ),
      );
    }
  }
  const searchLog = [...searchGroups.values()]
    .sort((left, right) =>
      `${left.objective}\u0000${left.route ?? ""}`.localeCompare(
        `${right.objective}\u0000${right.route ?? ""}`,
      ),
    )
    .map(({ objective, route }) => {
      const matching = searchResults.filter(
        (result) => result.objective === objective && (route === null || result.route === route),
      );
      const dimensions = [
        ...new Set(matching.flatMap((result) => strings(result.commercial_dimensions))),
      ].sort();
      return {
        query_id: stableId("query", [unitId, objective, route]),
        query: `${objective} via ${route ?? strings(delivery.primary_routes).join(", ")}`,
        searched_at: delivery.audited_at,
        commercial_dimensions: dimensions.length > 0 ? dimensions : ["market_structure"],
        candidate_results: matching.map((result) => {
          const {
            objective: _objective,
            route: _route,
            commercial_dimensions: _dimensions,
            ...formal
          } = result;
          return { ...formal, derived_valid_as_of: deriveValidAsOf(result) };
        }),
      };
    });

  const assignedSubjectIds = [
    ...new Set([
      ...strings(task.target_opportunity_refs).map(subjectIdFromRef),
      ...strings(task.target_candidate_refs).map(subjectIdFromRef),
      ...(typeof task.target_subject_ref === "string"
        ? [subjectIdFromRef(task.target_subject_ref)]
        : []),
    ]),
  ].filter(Boolean);
  const authoredSubjectIds = [
    ...new Set([
      ...records(delivery.evidence_sources).flatMap((item) => strings(item.subject_ids)),
      ...records(delivery.findings).flatMap((item) =>
        typeof item.subject_id === "string" ? [item.subject_id] : [],
      ),
      ...records(delivery.claims).flatMap((item) =>
        typeof item.subject_id === "string" ? [item.subject_id] : [],
      ),
      ...records(delivery.judgments).flatMap((item) =>
        typeof item.subject_id === "string" ? [item.subject_id] : [],
      ),
      ...records(delivery.quantitative_observations).map((item) => String(item.subject_id)),
      ...records(delivery.competitive_observations).map((item) => String(item.subject_id)),
      ...records(delivery.incumbent_response_assessments).map((item) => String(item.subject_id)),
      ...records(delivery.unresolved_gaps).flatMap((item) => [
        ...strings(item.subject_ids),
        ...(typeof item.subject_id === "string" ? [item.subject_id] : []),
      ]),
    ]),
  ].filter(Boolean);
  if (
    incumbentAssignment.analysis_depth === "not_assigned" &&
    records(delivery.incumbent_response_assessments).length > 0
  ) {
    issues.push(
      issue(
        "commercial_research.incumbent_response_before_candidate",
        "/incumbent_response_assessments",
        "incumbent response research cannot be authored before a post-candidate assignment exists",
      ),
    );
  }
  const subjectIds = assignedSubjectIds.length > 0 ? assignedSubjectIds : authoredSubjectIds;
  if (subjectIds.length === 0) subjectIds.push(`direction_${unitId}`);
  const outOfScopeSubjects = authoredSubjectIds.filter((subject) => !subjectIds.includes(subject));
  if (outOfScopeSubjects.length > 0) {
    issues.push(
      issue(
        "commercial_research.delivery_subject_out_of_scope",
        "/",
        "delivery subjects must remain within the Dispatch task target closure",
        { assignedSubjectIds: subjectIds, outOfScopeSubjects },
      ),
    );
  }

  const evidenceDocuments = new Map(
    availableArtifacts.map((artifact) => [artifact.artifact_path, effectiveDocument(artifact)]),
  );
  const acquisitionsByKey = new Map<string, Record<string, unknown>>();
  const quantitativeObservations: Record<string, unknown>[] = records(
    delivery.quantitative_observations,
  ).map((input) => {
    const acquisitionInput = isRecord(input.acquisition) ? input.acquisition : {};
    const primaryEvidenceRef = strings(input.evidence_refs)[0] ?? "";
    const evidenceDocument = evidenceDocuments.get(primaryEvidenceRef) ?? {};
    const binding = isRecord(evidenceDocument.mechanical_binding)
      ? evidenceDocument.mechanical_binding
      : {};
    const acquisitionIdentity = [primaryEvidenceRef, acquisitionInput];
    const acquisitionId = stableId("acquisition", acquisitionIdentity);
    if (!acquisitionsByKey.has(acquisitionId)) {
      acquisitionsByKey.set(acquisitionId, {
        acquisition_id: acquisitionId,
        acquisition_method: acquisitionMethod(acquisitionInput.acquisition_method),
        provider: acquisitionInput.provider,
        endpoint_or_query_redacted: acquisitionInput.endpoint_or_query_redacted,
        retrieved_at: binding.recorded_at ?? delivery.audited_at,
        evidence_ref: primaryEvidenceRef,
        evidence_substrate_ref: binding.substrate_record_ref,
        raw_response_ref: binding.raw_content_ref,
        raw_response_hash: binding.content_hash,
        access_basis: acquisitionInput.access_basis,
        credentials_stored: false,
        sensitive_headers_stored: false,
        access_control_bypassed: false,
        limitations: acquisitionInput.limitations,
      });
    }
    const { acquisition: _acquisition, ...semantic } = input;
    return {
      observation_id: stableId("observation", semantic),
      ...semantic,
      acquisition_id: acquisitionId,
    } as Record<string, unknown>;
  });
  const observationsByMetricName = new Map(
    quantitativeObservations.map((item) => [String(item.metric_name), String(item.observation_id)]),
  );
  const competitiveObjects: Record<string, unknown>[] = records(
    delivery.competitive_observations,
  ).map((input) => {
    const {
      pricing_metric_names: pricingNames,
      traction_metric_names: tractionNames,
      ...semantic
    } = input;
    return {
      competitive_object_id: stableId("competitor", semantic),
      ...semantic,
      pricing_observation_refs: strings(pricingNames)
        .map((name) => observationsByMetricName.get(name))
        .filter((value): value is string => value !== undefined),
      traction_observation_refs: strings(tractionNames)
        .map((name) => observationsByMetricName.get(name))
        .filter((value): value is string => value !== undefined),
    } as Record<string, unknown>;
  });
  const incumbentResponseAssessments =
    incumbentAssignment.analysis_depth === "not_assigned"
      ? []
      : subjectIds.flatMap((subjectId) => {
          const authored = records(delivery.incumbent_response_assessments).filter(
            (item) => item.subject_id === subjectId,
          );
          const inputs = authored.length > 0 ? authored : [unknownIncumbentResponse(subjectId)];
          return inputs.map((input) => {
            if (
              authored.length > 0 &&
              ["unknown", "not_applicable"].includes(String(input.analysis_state)) &&
              [
                "responder_identity",
                "response_modes",
                "capability_adjacency",
                "response_cost",
                "incentive",
                "strategic_implication",
              ].some((field) => field in input)
            ) {
              issues.push(
                issue(
                  "commercial_research.incumbent_response_legacy_state_semantics_ignored",
                  "/incumbent_response_assessments",
                  "legacy strong fields on unknown/not_applicable input were ignored during deterministic normalization",
                  { subjectId, analysisState: input.analysis_state },
                ),
              );
            }
            const semantic = normalizeIncumbentResponse(subjectId, input);
            return {
              assessment_id: stableId("incumbent_response", [unitId, semantic]),
              analysis_depth: incumbentAssignment.analysis_depth,
              semantic,
            };
          });
        });
  const derivedBindings = new Map<string, Set<string>>();
  const bindRefs = (subjectId: unknown, refs: readonly string[]): void => {
    if (typeof subjectId !== "string" || !subjectIds.includes(subjectId)) return;
    for (const ref of refs) {
      const subjects = derivedBindings.get(ref) ?? new Set<string>();
      subjects.add(subjectId);
      derivedBindings.set(ref, subjects);
    }
  };
  for (const statement of [
    ...records(delivery.findings),
    ...records(delivery.claims),
    ...records(delivery.judgments),
  ]) {
    bindRefs(statement.subject_id, strings(statement.evidence_refs));
  }
  for (const observation of quantitativeObservations) {
    bindRefs(observation.subject_id, strings(observation.evidence_refs));
  }
  for (const competitiveObject of competitiveObjects) {
    bindRefs(competitiveObject.subject_id, strings(competitiveObject.source_refs));
  }
  for (const assessment of incumbentResponseAssessments) {
    const semantic = isRecord(assessment.semantic) ? assessment.semantic : {};
    bindRefs(semantic.subject_id, [
      ...strings(semantic.supporting_evidence_refs),
      ...strings(semantic.opposing_evidence_refs),
      ...strings(semantic.background_evidence_refs),
    ]);
  }
  for (const source of evidence) {
    const explicit = strings(source.subject_ids).filter((subjectId) =>
      subjectIds.includes(subjectId),
    );
    const derived = [...(derivedBindings.get(String(source.evidence_ref)) ?? new Set())].sort();
    const subjectBindings =
      explicit.length > 0 ? explicit : subjectIds.length === 1 ? subjectIds : derived;
    source.subject_ids = [...new Set(subjectBindings)].sort();
    source.subject_binding_basis =
      explicit.length > 0
        ? "explicit"
        : subjectIds.length === 1
          ? "single_subject_auto"
          : derived.length > 0
            ? "derived_from_material"
            : "unbound";
    if (source.subject_binding_basis === "unbound" && source.disposition === "adopted") {
      issues.push(
        issue(
          "commercial_research.evidence_subject_unbound",
          "/evidence_sources",
          "multi-subject Evidence was retained as portfolio/background material because no direct subject binding could be derived",
          { evidenceRef: source.evidence_ref, coveredSubjectIds: subjectIds },
        ),
      );
    }
  }
  for (const observation of quantitativeObservations) {
    observation.decision_use = deriveQuantitativeDecisionUse(
      observation,
      evidenceByRef,
      isTraceableDirectSource,
    );
  }
  const metricAcquisitionPlans = new Map<string, Record<string, unknown>>();
  for (const gap of records(delivery.unresolved_gaps)) {
    if (
      gap.coverage_kind !== "quantitative" ||
      gap.decision_relevance !== "blocking" ||
      !isRecord(gap.acquisition_plan)
    ) {
      continue;
    }
    const declaredSubjects = [
      ...new Set([
        ...strings(gap.subject_ids),
        ...(typeof gap.subject_id === "string" ? [gap.subject_id] : []),
      ]),
    ];
    const explicitSubjects = declaredSubjects.filter((subjectId) => subjectIds.includes(subjectId));
    const boundSubjects =
      explicitSubjects.length > 0
        ? explicitSubjects
        : declaredSubjects.length === 0 && subjectIds.length === 1
          ? subjectIds
          : [];
    for (const subjectId of boundSubjects) {
      metricAcquisitionPlans.set(
        gapKey("quantitative", subjectId, String(gap.dimension)),
        gap.acquisition_plan,
      );
    }
  }
  const structuredGaps = records(delivery.unresolved_gaps)
    .map((gap) => {
      const explicitSubjects = [
        ...new Set([
          ...strings(gap.subject_ids),
          ...(typeof gap.subject_id === "string" ? [gap.subject_id] : []),
        ]),
      ]
        .filter((subjectId) => subjectIds.includes(subjectId))
        .sort();
      const boundSubjects =
        explicitSubjects.length > 0
          ? explicitSubjects
          : subjectIds.length === 1
            ? [...subjectIds]
            : [];
      const subjectBindingBasis =
        explicitSubjects.length > 0
          ? "explicit"
          : subjectIds.length === 1
            ? "single_subject_auto"
            : "unbound";
      if (subjectBindingBasis === "unbound") {
        issues.push(
          issue(
            "commercial_research.gap_subject_unbound",
            "/unresolved_gaps",
            "a multi-subject unresolved Gap was retained as portfolio research context because no subject binding could be derived",
            { coverageKind: gap.coverage_kind, dimension: gap.dimension },
          ),
        );
      }
      const {
        subject_id: _subjectId,
        subject_ids: _subjectIds,
        acquisition_plan: _acquisitionPlan,
        ...researchSemantics
      } = gap;
      return {
        ...researchSemantics,
        subject_ids: boundSubjects,
        subject_binding_basis: subjectBindingBasis,
        task_ref: taskPath,
        audit_ref: auditPath,
      } as Record<string, unknown>;
    })
    .sort((left, right) =>
      `${strings(left.subject_ids).join(",")}\u0000${String(left.coverage_kind)}\u0000${String(left.dimension)}\u0000${String(left.reason)}`.localeCompare(
        `${strings(right.subject_ids).join(",")}\u0000${String(right.coverage_kind)}\u0000${String(right.dimension)}\u0000${String(right.reason)}`,
      ),
    );
  const gaps = new Map<string, Record<string, unknown>>();
  for (const gap of structuredGaps) {
    for (const subjectId of strings(gap.subject_ids)) {
      gaps.set(gapKey(String(gap.coverage_kind), subjectId, String(gap.dimension)), gap);
    }
  }
  const incumbentResponseCoverage = subjectIds
    .flatMap((subjectId) => {
      const assessments = incumbentResponseAssessments.filter(
        (assessment) =>
          isRecord(assessment.semantic) && assessment.semantic.subject_id === subjectId,
      );
      if (assessments.length === 0) return [];
      const states = assessments.map((assessment) =>
        String((assessment.semantic as Record<string, unknown>).analysis_state),
      );
      const state = states.includes("unknown")
        ? "unknown"
        : states.includes("assessed")
          ? "assessed"
          : "not_applicable";
      const unknownSemantics = assessments
        .map((assessment) => assessment.semantic as Record<string, unknown>)
        .filter((semantic) => semantic.analysis_state === "unknown");
      return [
        {
          subject_id: subjectId,
          analysis_depth: incumbentAssignment.analysis_depth,
          assignment_role: incumbentAssignment.assignment_role,
          state,
          assessment_ids: assessments.map((assessment) => assessment.assessment_id),
          reason:
            state === "unknown"
              ? "Assigned incumbent absorption and response risk remains unknown."
              : state === "not_applicable"
                ? "No relevant incumbent response assessment applies within the bounded scope."
                : null,
          data_gaps: [
            ...new Set(unknownSemantics.flatMap((semantic) => strings(semantic.data_gaps))),
          ].sort(),
          decision_impact: INCUMBENT_RESPONSE_CONTEXT_ONLY,
          automatic_effects: INCUMBENT_RESPONSE_AUTOMATIC_EFFECTS,
        },
      ];
    })
    .sort((left, right) => String(left.subject_id).localeCompare(String(right.subject_id)));
  const incumbentResponseGaps = incumbentResponseCoverage
    .filter((coverage) => coverage.state === "unknown")
    .map((coverage) => ({
      subject_ids: [String(coverage.subject_id)],
      subject_binding_basis: subjectIds.length === 1 ? "single_subject_auto" : "explicit",
      coverage_kind: "incumbent_response",
      dimension: "absorption_and_response_risk",
      state: "unavailable",
      reason: String(coverage.reason),
      alternative_metric: null,
      decision_impact: INCUMBENT_RESPONSE_CONTEXT_ONLY,
      query_attempts: [],
      task_ref: taskPath,
      audit_ref: auditPath,
    }));
  const quantitativeCoverage = subjectIds.flatMap((subjectId) =>
    strings(scope.required_metric_families).map((family) => {
      const observations = quantitativeObservations.filter(
        (item) => item.subject_id === subjectId && item.metric_family === family,
      );
      const directlyTraceable = observations.some((observation) =>
        strings(observation.evidence_refs).some((ref) => {
          const source = evidenceByRef.get(ref);
          return (
            source !== undefined &&
            source.disposition === "adopted" &&
            isTraceableDirectSource(source, evidenceByRef)
          );
        }),
      );
      const containsLimitedObservation = observations.some(
        (observation) =>
          !strings(observation.evidence_refs).some((ref) => {
            const source = evidenceByRef.get(ref);
            return (
              source !== undefined &&
              source.disposition === "adopted" &&
              isTraceableDirectSource(source, evidenceByRef)
            );
          }),
      );
      const gap = gaps.get(gapKey("quantitative", subjectId, family));
      const queryAttempts = records(gap?.query_attempts);
      const authoredAcquisitionPlan =
        metricAcquisitionPlans.get(gapKey("quantitative", subjectId, family)) ?? null;
      const blockingGap =
        (gap?.state === "partial" || gap?.state === "unavailable") &&
        gap?.decision_relevance === "blocking";
      const decisionGradeObservationIds = observations
        .filter(
          (observation) =>
            isRecord(observation.decision_use) &&
            observation.decision_use.grade === "decision_grade",
        )
        .map((observation) => String(observation.observation_id));
      if (observations.length === 0 && gap === undefined) {
        issues.push(
          issue(
            "commercial_research.assigned_scope_undisclosed",
            `/unresolved_gaps`,
            "an assigned metric family had neither an observation nor an authored Gap; the compiler disclosed it as unavailable",
            { subjectId, dimension: family },
          ),
        );
      }
      if (observations.length > 0 && containsLimitedObservation) {
        issues.push(
          issue(
            "commercial_research.secondary_source_traceability_limited",
            "/quantitative_observations",
            "numeric material from an untraced secondary report was retained, but it cannot by itself close the metric as directly observed",
            { subjectId, dimension: family },
          ),
        );
      }
      return {
        subject_id: subjectId,
        metric_family: family,
        state:
          observations.length > 0
            ? gap?.state === "partial" || !directlyTraceable
              ? "partial"
              : "observed"
            : (gap?.state ?? "unavailable"),
        observation_ids: observations.map((item) => item.observation_id),
        decision_grade_observation_ids: decisionGradeObservationIds,
        query_attempts: queryAttempts,
        acquisition_plan:
          blockingGap && authoredAcquisitionPlan !== null
            ? {
                ...authoredAcquisitionPlan,
                attempted_route_classes: [
                  ...new Set(
                    queryAttempts.map((attempt) =>
                      acquisitionRouteClass(attempt.acquisition_method),
                    ),
                  ),
                ].sort(),
                attempted_source_groups: [
                  ...new Set(
                    queryAttempts.map((attempt) => String(attempt.provider ?? "")).filter(Boolean),
                  ),
                ].sort(),
                subject_id: subjectId,
                metric_family: family,
                plan_ref: task.research_plan_ref,
                task_ref: taskPath,
                gap_ref: `${auditPath}#gap:${subjectId}:${family}`,
              }
            : null,
        reason:
          gap?.reason ??
          (observations.length > 0
            ? directlyTraceable
              ? null
              : "The numeric statement is retained from secondary material whose primary data was not traced."
            : "No observation or explicit Gap was present in the agent delivery."),
        alternative_metric: gap?.alternative_metric ?? null,
        decision_impact:
          gap?.decision_impact ??
          (observations.length > 0
            ? "The assigned metric was observed."
            : "Confidence and recommendation strength are limited until this metric is observed."),
      };
    }),
  );
  const competitiveCoverage = subjectIds.flatMap((subjectId) =>
    strings(scope.required_competitor_types).map((competitorType) => {
      const objects = competitiveObjects.filter(
        (item) => item.subject_id === subjectId && item.competitor_type === competitorType,
      );
      const directlySupported = objects.some((item) =>
        strings(item.source_refs).some((ref) => evidenceByRef.get(ref)?.disposition === "adopted"),
      );
      const gap = gaps.get(gapKey("competitive", subjectId, competitorType));
      if (objects.length === 0 && gap === undefined) {
        issues.push(
          issue(
            "commercial_research.assigned_scope_undisclosed",
            `/unresolved_gaps`,
            "an assigned competitor type had neither an observation nor an authored Gap; the compiler disclosed it as unavailable",
            { subjectId, dimension: competitorType },
          ),
        );
      }
      return {
        subject_id: subjectId,
        competitor_type: competitorType,
        state:
          objects.length > 0
            ? gap?.state === "partial" || !directlySupported
              ? "partial"
              : "observed"
            : (gap?.state ?? "unavailable"),
        competitive_object_ids: objects.map((item) => item.competitive_object_id),
        query_attempts: records(gap?.query_attempts),
        reason:
          gap?.reason ??
          (objects.length > 0
            ? null
            : "No observation or explicit Gap was present in the agent delivery."),
        alternative_metric: gap?.alternative_metric ?? null,
        decision_impact:
          gap?.decision_impact ??
          (objects.length > 0
            ? "The assigned substitute type was observed."
            : "Competitive confidence and recommendation strength remain limited."),
      };
    }),
  );
  const { coverage, directlyCovered } = deriveBusinessCoverage(evidence, evidenceByRef);
  const uncovered = REQUIRED_RANKING_KEYS.filter((key) => !directlyCovered.has(key));
  const adopted = evidence.filter((item) => item.disposition === "adopted");
  const concentrated = deriveSourceConcentration(adopted, evidenceDocuments).concentrated;
  const hasIndependent = adopted.some((item) => item.independence === "independent");
  const hasGaps =
    quantitativeCoverage.some(
      (item) => !isQuantitativeCoverageFormallyComplete(item, quantitativeObservations),
    ) ||
    competitiveCoverage.some((item) => !isFormalScopeDisposed(item.state)) ||
    uncovered.length > 0 ||
    structuredGaps.some((gap) => gap.state !== "not_applicable") ||
    incumbentResponseCoverage.some((item) => item.state === "unknown");
  const claims = records(delivery.claims).map((claim) => {
    const refs = strings(claim.evidence_refs);
    const subjectId =
      typeof claim.subject_id === "string"
        ? claim.subject_id
        : subjectIds.length === 1
          ? subjectIds[0]
          : undefined;
    const ceiling = deriveClaimConfidence(
      claim.confidence,
      refs,
      evidenceByRef,
      quantitativeCoverage,
      quantitativeObservations,
      competitiveCoverage,
      evidence,
      subjectId,
    );
    return {
      claim_id: stableId("claim", claim),
      statement: claim.statement,
      evidence_refs: refs,
      ...(subjectId === undefined ? {} : { subject_id: subjectId }),
      requested_confidence: claim.confidence,
      confidence: ceiling.confidence,
      confidence_ceiling_reasons: ceiling.reasons,
    };
  });
  const findings = records(delivery.findings).map((finding) => ({
    finding_id: stableId("finding", finding),
    ...finding,
    ...(finding.subject_id === undefined && subjectIds.length === 1
      ? { subject_id: subjectIds[0] }
      : {}),
  }));
  const judgments = records(delivery.judgments).map((judgment) => ({
    judgment_id: stableId("judgment", judgment),
    ...judgment,
    ...(judgment.subject_id === undefined && subjectIds.length === 1
      ? { subject_id: subjectIds[0] }
      : {}),
  }));
  const subjectRecommendationCeilings = deriveSubjectRecommendationCeilings(
    subjectIds,
    coverage,
    quantitativeCoverage,
    quantitativeObservations,
    competitiveObjects,
    evidence,
    [...claims, ...judgments],
    evidenceDocuments,
  );
  const subjectAssessments = deriveSubjectAssessments(
    subjectIds,
    quantitativeCoverage,
    quantitativeObservations,
    competitiveCoverage,
    competitiveObjects,
    evidence,
    [...claims, ...judgments],
    evidenceDocuments,
    strings(delivery.limitations),
  );
  const portfolioRecommendationCeiling = derivePortfolioRecommendationCeiling(
    subjectRecommendationCeilings,
    [...claims, ...judgments],
    evidence,
  );
  const purchaseObserved = directlyCovered.has("purchase_signal");
  const demandObserved =
    directlyCovered.has("recent_user_language") ||
    hasDecisionGradeQuantitativeSignal(
      quantitativeCoverage,
      ["demand_scale", "growth_change"],
      quantitativeObservations,
    );
  const buyerObserved = evidence.some(
    (item) =>
      item.disposition === "adopted" &&
      strings(item.coverage_keys).includes("buyer") &&
      item.freshness_status === "current" &&
      item.source_kind !== "academic" &&
      !["inference", "mechanism", "effect_boundary"].includes(String(item.evidence_character)) &&
      isTraceableDirectSource(item, evidenceByRef),
  );
  const hasEarlySignal = demandObserved || buyerObserved || purchaseObserved;
  const researchStage = ["solution_neutral_scan", "solution_specific_evaluation"].includes(
    String(requirements.research_stage),
  )
    ? requirements.research_stage
    : task.schema_version === "startup_opportunity.research_task.discovery_candidate.current"
      ? "solution_neutral_scan"
      : "solution_specific_evaluation";
  const document: Record<string, unknown> = {
    schema_version: "startup_opportunity.commercial_research_audit.current",
    audit_id: stableId("commercial_audit", [delivery.run_id, unitId, taskPath]),
    run_id: delivery.run_id,
    unit_id: unitId,
    execution_plan_ref: executionPlanRef,
    dispatch_task_ref: dispatchTaskRef,
    task_ref: taskPath,
    covered_direction_ids: subjectIds.sort(),
    research_stage: researchStage,
    audited_at: delivery.audited_at,
    planned_resource_allocation:
      requirements.resource_allocation ?? policy.default_resource_allocation,
    adopted_source_distribution: deriveSourceDistribution(adopted, policy),
    research_objectives: delivery.research_objectives,
    primary_routes: delivery.primary_routes,
    findings,
    claims,
    judgments,
    search_log: searchLog,
    search_closure: {
      closure_id: `search_closure_${unitId}`,
      lane_kind: "external_research",
      outcome: hasGaps ? "evidence_insufficient" : "completed",
      query_log_complete: delivery.query_log_complete,
      telemetry_basis: delivery.telemetry_basis,
      remaining_gaps: [...structuredGaps, ...incumbentResponseGaps],
      termination_reason: delivery.stop_reason,
    },
    evidence_register: evidence,
    data_acquisitions: [...acquisitionsByKey.values()],
    quantitative_observations: quantitativeObservations,
    quantitative_coverage: quantitativeCoverage,
    competitive_objects: competitiveObjects,
    competitive_coverage: competitiveCoverage,
    incumbent_response_assignment: incumbentAssignment,
    incumbent_response_assessments: incumbentResponseAssessments,
    incumbent_response_coverage: incumbentResponseCoverage,
    coverage,
    uncovered_business_dimensions: uncovered,
    wave1_signals: { demand: demandObserved, buyer: buyerObserved, purchase: purchaseObserved },
    stage_decision: hasEarlySignal ? "continue_research" : "early_stop_insufficient_evidence",
    ranking_eligibility:
      uncovered.length === 0 &&
      quantitativeCoverage.every((item) =>
        isQuantitativeCoverageFormallyComplete(item, quantitativeObservations),
      ) &&
      competitiveCoverage.every((item) => isFormalScopeDisposed(item.state)) &&
      !concentrated &&
      hasIndependent
        ? "ranked"
        : "unranked_hypothesis",
    recommendation_ceiling: portfolioRecommendationCeiling,
    subject_recommendation_ceilings: subjectRecommendationCeilings,
    subject_assessments: subjectAssessments,
    compiler_warnings: projectGateWarnings(issues),
    limitations: delivery.limitations,
  };
  return { document, issues };
}

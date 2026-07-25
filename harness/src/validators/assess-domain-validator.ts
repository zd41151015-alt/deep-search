import { sortIssues, type ValidationIssue } from "./schema-bundle.js";

export interface AssessDomainDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
}

export const ASSESSMENT_DIMENSIONS = [
  "target_user_and_jtbd",
  "demand_and_behavior",
  "current_alternatives_and_solution_failure",
  "competitor_saturation_and_differentiation",
  "buyer_language_and_willingness_to_pay",
  "acquisition_and_distribution",
  "business_engine_viability",
  "delivery_feasibility",
  "compliance_and_platform_risk",
  "counter_evidence",
] as const;

const ASSESS_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.intake.v1",
  "startup_opportunity.decision_context.v1",
  "startup_opportunity.scope_frame.v1",
  "startup_opportunity.concept_hypothesis.v1",
  "startup_opportunity.judgment_assessment.v1",
  "startup_opportunity.concept_evidence_assessment_plan.v1",
  "startup_opportunity.concept_evidence_assessment_branch_result.v1",
  "startup_opportunity.concept_evidence_assessment_fan_in.v1",
  "startup_opportunity.hypothesis_evidence_matrix.v1",
  "startup_opportunity.business_engine_thesis.v1",
  "startup_opportunity.concept_evidence_assessment.v1",
]);

export function isAssessDomainSchemaVersion(schemaVersion: string): boolean {
  return ASSESS_SCHEMA_VERSIONS.has(schemaVersion);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
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
    keyword: "assess_contract",
    instancePath,
    schemaPath: "",
    message,
    details: Object.fromEntries(
      Object.entries(details).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function bySchema(
  documents: readonly AssessDomainDocument[],
  schemaVersion: string,
): readonly AssessDomainDocument[] {
  return documents.filter((entry) => entry.schemaVersion === schemaVersion);
}

function targetByRef(
  documentsByPath: ReadonlyMap<string, AssessDomainDocument>,
  ref: unknown,
): AssessDomainDocument | null {
  if (typeof ref !== "string") {
    return null;
  }
  return documentsByPath.get(ref.split("#", 1)[0] ?? "") ?? null;
}

function exactStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort();
}

function researchUnits(plan: AssessDomainDocument | null): readonly Record<string, unknown>[] {
  if (plan?.schemaVersion !== "startup_opportunity.research_plan.v1") {
    return [];
  }
  return records(plan.document.waves).flatMap((wave) => records(wave.units));
}

function mappedJudgmentSignal(decision: unknown): string | null {
  if (decision === "supports") return "supported";
  if (decision === "opposes") return "opposed";
  if (decision === "mixed") return "mixed";
  if (decision === "not_applicable") return "not_applicable";
  return null;
}

function validateDimensionSet(
  path: string,
  value: unknown,
  errors: ValidationIssue[],
): readonly Record<string, unknown>[] {
  const dimensions = records(value);
  const ids = dimensions.map((dimension) => String(dimension.dimension_id ?? ""));
  const duplicates = duplicateValues(ids);
  if (duplicates.length > 0) {
    errors.push(
      issue("assess_contract.duplicate_dimension", `${path}#/dimensions`, "dimension ids repeat", {
        duplicates,
      }),
    );
  }
  if (!exactStringSet(ids, ASSESSMENT_DIMENSIONS)) {
    errors.push(
      issue(
        "assess_contract.mandatory_dimensions_mismatch",
        `${path}#/dimensions`,
        "assessment dimensions must contain the ten mandatory common dimensions exactly once",
        { actual: [...ids].sort(), expected: [...ASSESSMENT_DIMENSIONS].sort() },
      ),
    );
  }
  return dimensions;
}

function validateRootIdentity(
  documents: readonly AssessDomainDocument[],
  errors: ValidationIssue[],
): void {
  const assessDocuments = documents.filter((entry) =>
    ASSESS_SCHEMA_VERSIONS.has(entry.schemaVersion),
  );
  const runIds = [
    ...new Set(
      assessDocuments
        .map((entry) => entry.document.run_id)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  if (runIds.length > 1) {
    errors.push(
      issue("assess_contract.run_mismatch", "", "assess contract documents cross Run boundaries", {
        runIds: runIds.sort(),
      }),
    );
  }

  for (const [schemaVersion, entries] of new Map(
    [...ASSESS_SCHEMA_VERSIONS].map((version) => [version, bySchema(documents, version)]),
  )) {
    if (schemaVersion === "startup_opportunity.judgment_assessment.v1") {
      continue;
    }
    if (schemaVersion === "startup_opportunity.concept_evidence_assessment_branch_result.v1") {
      continue;
    }
    if (schemaVersion === "startup_opportunity.concept_evidence_assessment_plan.v1") {
      continue;
    }
    if (entries.length > 1) {
      errors.push(
        issue(
          "assess_contract.duplicate_singleton",
          "",
          "assess contract contains more than one singleton document type",
          { schemaVersion, paths: entries.map((entry) => entry.path).sort() },
        ),
      );
    }
  }
}

function validateFraming(
  documents: readonly AssessDomainDocument[],
  documentsByPath: ReadonlyMap<string, AssessDomainDocument>,
  errors: ValidationIssue[],
): void {
  const intake = bySchema(documents, "startup_opportunity.intake.v1")[0];
  const scope = bySchema(documents, "startup_opportunity.scope_frame.v1")[0];
  const concept = bySchema(documents, "startup_opportunity.concept_hypothesis.v1")[0];
  if (intake && scope) {
    if (
      intake.document.action !== "assess" ||
      intake.document.mode !== "concept_evidence_assessment"
    ) {
      errors.push(
        issue(
          "assess_contract.intake_mode_mismatch",
          intake.path,
          "an assess contract bundle requires assess intake mode",
        ),
      );
    }
    for (const field of ["market", "language"] as const) {
      if (intake.document[field] !== scope.document[field]) {
        errors.push(
          issue(
            "assess_contract.scope_identity_mismatch",
            `${scope.path}#/${field}`,
            `ScopeFrame ${field} differs from intake`,
            { intake: intake.document[field], scope: scope.document[field] },
          ),
        );
      }
    }
  }

  if (scope) {
    const decision = targetByRef(documentsByPath, scope.document.decision_context_ref);
    if (
      decision?.schemaVersion === "startup_opportunity.decision_context.v1" &&
      decision.document.run_id !== scope.document.run_id
    ) {
      errors.push(
        issue(
          "assess_contract.run_mismatch",
          `${scope.path}#/decision_context_ref`,
          "ScopeFrame references another Run",
        ),
      );
    }
  }

  if (scope && concept) {
    const identityFields = [
      "product_thesis",
      "target_user",
      "buyer",
      "entry_scene",
      "claimed_value",
      "current_alternative",
      "delivery_form",
      "business_model",
      "acquisition_hypothesis",
    ] as const;
    for (const field of identityFields) {
      if (JSON.stringify(scope.document[field]) !== JSON.stringify(concept.document[field])) {
        errors.push(
          issue(
            "assess_contract.concept_scope_drift",
            `${concept.path}#/${field}`,
            "ConceptHypothesis redefines its frozen ScopeFrame identity",
            { field },
          ),
        );
      }
    }
  }
}

function validateAssessmentPlan(
  plan: AssessDomainDocument,
  documentsByPath: ReadonlyMap<string, AssessDomainDocument>,
  errors: ValidationIssue[],
): void {
  const dimensions = validateDimensionSet(plan.path, plan.document.dimensions, errors);
  const concept = targetByRef(documentsByPath, plan.document.concept_hypothesis_ref);
  const researchPlan = targetByRef(documentsByPath, plan.document.research_plan_ref);
  const scope = concept ? targetByRef(documentsByPath, concept.document.scope_frame_ref) : null;

  if (
    scope?.schemaVersion === "startup_opportunity.scope_frame.v1" &&
    scope.document.assessment_profile !== plan.document.assessment_profile
  ) {
    errors.push(
      issue(
        "assess_contract.profile_mismatch",
        `${plan.path}#/assessment_profile`,
        "assessment profile differs from ScopeFrame",
      ),
    );
  }

  if (researchPlan?.schemaVersion === "startup_opportunity.research_plan.v1") {
    if (
      researchPlan.document.run_id !== plan.document.run_id ||
      researchPlan.document.mode !== "concept_evidence_assessment"
    ) {
      errors.push(
        issue(
          "assess_contract.research_plan_identity_mismatch",
          `${plan.path}#/research_plan_ref`,
          "assessment plan must bind an assess Research Plan from the same Run",
        ),
      );
    }
    if (
      JSON.stringify(researchPlan.document.followup_policy) !==
      JSON.stringify(plan.document.followup_policy)
    ) {
      errors.push(
        issue(
          "assess_contract.followup_policy_mismatch",
          `${plan.path}#/followup_policy`,
          "assessment and Research Plan follow-up policies differ",
        ),
      );
    }
  }

  const units = researchUnits(researchPlan);
  for (const dimension of dimensions) {
    const dimensionId = dimension.dimension_id;
    const matchingUnits = units.filter(
      (unit) =>
        unit.plan_disposition === "enabled" &&
        unit.unit_type === dimension.branch_unit_type &&
        unit.required_artifact_schema ===
          "startup_opportunity.concept_evidence_assessment_branch_result.v1" &&
        strings(unit.input_refs).includes(plan.path) &&
        strings(unit.input_refs).includes(String(plan.document.concept_hypothesis_ref)),
    );
    if (matchingUnits.length === 0) {
      errors.push(
        issue(
          "assess_contract.dimension_unit_missing",
          `${plan.path}#/dimensions/${String(dimensionId)}`,
          "assessment dimension has no enabled Research Plan unit bound to this plan and concept",
          { dimensionId, branchUnitType: dimension.branch_unit_type },
        ),
      );
    }
  }

  const revision = plan.document.revision;
  const pathRevision = plan.path.match(/\.r([1-9][0-9]*)\.json$/)?.[1];
  if (typeof revision === "number" && Number(pathRevision) !== revision) {
    errors.push(
      issue(
        "assess_contract.path_revision_mismatch",
        plan.path,
        "assessment plan path does not match its revision",
        { pathRevision: pathRevision ?? null, revision },
      ),
    );
  }
  if (typeof revision === "number" && revision > 1) {
    const parent = targetByRef(documentsByPath, plan.document.parent_plan_ref);
    if (
      parent?.schemaVersion === "startup_opportunity.concept_evidence_assessment_plan.v1" &&
      (parent.document.revision !== revision - 1 ||
        parent.document.assessment_plan_id !== plan.document.assessment_plan_id ||
        parent.document.concept_hypothesis_ref !== plan.document.concept_hypothesis_ref)
    ) {
      errors.push(
        issue(
          "assess_contract.plan_lineage_mismatch",
          `${plan.path}#/parent_plan_ref`,
          "parent assessment plan must be the preceding revision of the same identity",
        ),
      );
    }
  }
}

function validateBranch(
  branch: AssessDomainDocument,
  documentsByPath: ReadonlyMap<string, AssessDomainDocument>,
  errors: ValidationIssue[],
): void {
  const plan = targetByRef(documentsByPath, branch.document.assessment_plan_ref);
  const concept = targetByRef(documentsByPath, branch.document.concept_hypothesis_ref);
  if (plan?.schemaVersion !== "startup_opportunity.concept_evidence_assessment_plan.v1") {
    return;
  }
  if (plan.document.concept_hypothesis_ref !== branch.document.concept_hypothesis_ref) {
    errors.push(
      issue(
        "assess_contract.branch_concept_mismatch",
        `${branch.path}#/concept_hypothesis_ref`,
        "branch and assessment plan reference different concepts",
      ),
    );
  }
  const dimension = records(plan.document.dimensions).find(
    (candidate) => candidate.dimension_id === branch.document.dimension_id,
  );
  const researchPlan = targetByRef(documentsByPath, plan.document.research_plan_ref);
  const unit = researchUnits(researchPlan).find(
    (candidate) => candidate.unit_id === branch.document.unit_id,
  );
  if (
    !dimension ||
    !unit ||
    unit.unit_type !== dimension.branch_unit_type ||
    unit.output_path !== branch.path ||
    unit.required_artifact_schema !== branch.schemaVersion
  ) {
    errors.push(
      issue(
        "assess_contract.branch_unit_mismatch",
        branch.path,
        "branch identity does not match its declared assessment dimension and Research Plan unit",
        { dimensionId: branch.document.dimension_id, unitId: branch.document.unit_id },
      ),
    );
  }

  const judgments = strings(branch.document.judgment_assessment_refs)
    .map((ref) => targetByRef(documentsByPath, ref))
    .filter((entry): entry is AssessDomainDocument => entry !== null);
  if (
    ["completed", "partial", "insufficient_evidence"].includes(
      String(branch.document.branch_status),
    ) &&
    judgments.length === 0
  ) {
    errors.push(
      issue(
        "assess_contract.branch_judgment_missing",
        `${branch.path}#/judgment_assessment_refs`,
        "a usable branch result requires at least one JudgmentAssessment",
      ),
    );
  }
  for (const judgment of judgments) {
    if (
      judgment.schemaVersion !== "startup_opportunity.judgment_assessment.v1" ||
      judgment.document.subject_ref !== branch.document.concept_hypothesis_ref ||
      judgment.document.dimension !== branch.document.dimension_id
    ) {
      errors.push(
        issue(
          "assess_contract.branch_judgment_mismatch",
          `${branch.path}#/judgment_assessment_refs`,
          "branch JudgmentAssessment has another subject or dimension",
          { judgmentPath: judgment.path },
        ),
      );
    }
  }
  const expectedSignal = mappedJudgmentSignal(branch.document.dimension_decision);
  if (
    expectedSignal !== null &&
    !judgments.some((entry) => entry.document.judgment_signal === expectedSignal)
  ) {
    errors.push(
      issue(
        "assess_contract.dimension_decision_mismatch",
        `${branch.path}#/dimension_decision`,
        "branch dimension decision is not derived from a matching JudgmentAssessment signal",
      ),
    );
  }
  if (
    branch.document.dimension_decision === "insufficient_evidence" &&
    !judgments.some((entry) =>
      ["insufficient", "blocked"].includes(String(entry.document.decision_sufficiency)),
    )
  ) {
    errors.push(
      issue(
        "assess_contract.dimension_decision_mismatch",
        `${branch.path}#/dimension_decision`,
        "insufficient branch decision requires an insufficient or blocked JudgmentAssessment",
      ),
    );
  }
  if (
    judgments.length > 0 &&
    !judgments.some(
      (entry) => entry.document.decision_sufficiency === branch.document.decision_sufficiency,
    )
  ) {
    errors.push(
      issue(
        "assess_contract.sufficiency_mismatch",
        `${branch.path}#/decision_sufficiency`,
        "branch sufficiency is not present in its JudgmentAssessment set",
      ),
    );
  }
  if (concept && concept.document.run_id !== branch.document.run_id) {
    errors.push(
      issue("assess_contract.run_mismatch", branch.path, "branch concept belongs to another Run"),
    );
  }
}

function validateFanIn(
  fanIn: AssessDomainDocument,
  documents: readonly AssessDomainDocument[],
  documentsByPath: ReadonlyMap<string, AssessDomainDocument>,
  errors: ValidationIssue[],
): void {
  const categoryFields = [
    "completed_branch_refs",
    "partial_branch_refs",
    "ignored_late_branch_refs",
    "superseded_branch_refs",
  ] as const;
  const owners = new Map<string, string>();
  const usableBranchRefs = new Set<string>();
  for (const field of categoryFields) {
    for (const ref of strings(fanIn.document[field])) {
      const previous = owners.get(ref);
      if (previous) {
        errors.push(
          issue(
            "assess_contract.fan_in_category_overlap",
            `${fanIn.path}#/${field}`,
            "branch appears in multiple fan-in categories",
            { ref, categories: [previous, field].sort() },
          ),
        );
      }
      owners.set(ref, field);
      if (field === "completed_branch_refs" || field === "partial_branch_refs") {
        usableBranchRefs.add(ref);
      }
      const branch = targetByRef(documentsByPath, ref);
      if (
        branch?.schemaVersion ===
          "startup_opportunity.concept_evidence_assessment_branch_result.v1" &&
        (branch.document.concept_hypothesis_ref !== fanIn.document.concept_hypothesis_ref ||
          branch.document.assessment_plan_ref !== fanIn.document.assessment_plan_ref)
      ) {
        errors.push(
          issue(
            "assess_contract.fan_in_branch_identity_mismatch",
            `${fanIn.path}#/${field}`,
            "fan-in branch belongs to another concept or assessment plan",
            { ref },
          ),
        );
      }
      const allowedStatus =
        field === "completed_branch_refs"
          ? ["completed", "insufficient_evidence"]
          : field === "partial_branch_refs"
            ? ["partial"]
            : field === "ignored_late_branch_refs"
              ? ["ignored_late"]
              : ["superseded_by_scope_change", "superseded_by_adaptation"];
      if (branch && !allowedStatus.includes(String(branch.document.branch_status))) {
        errors.push(
          issue(
            "assess_contract.fan_in_status_mismatch",
            `${fanIn.path}#/${field}`,
            "fan-in category differs from branch status",
            { ref, branchStatus: branch.document.branch_status, allowedStatus },
          ),
        );
      }
    }
  }

  const allBranches = bySchema(
    documents,
    "startup_opportunity.concept_evidence_assessment_branch_result.v1",
  ).filter(
    (branch) =>
      branch.document.concept_hypothesis_ref === fanIn.document.concept_hypothesis_ref &&
      branch.document.assessment_plan_ref === fanIn.document.assessment_plan_ref,
  );
  const uncategorized = allBranches
    .map((branch) => branch.path)
    .filter((path) => !owners.has(path));
  if (uncategorized.length > 0) {
    errors.push(
      issue(
        "assess_contract.fan_in_uncategorized_branch",
        fanIn.path,
        "validated branch artifacts are missing from fan-in categories",
        { refs: uncategorized.sort() },
      ),
    );
  }

  const summaries = validateDimensionSet(fanIn.path, fanIn.document.dimension_summaries, errors);
  for (const summary of summaries) {
    const branch = targetByRef(documentsByPath, summary.branch_ref);
    if (branch && !usableBranchRefs.has(String(summary.branch_ref))) {
      errors.push(
        issue(
          "assess_contract.fan_in_summary_unusable_branch",
          `${fanIn.path}#/dimension_summaries/${String(summary.dimension_id)}/branch_ref`,
          "ignored or superseded branch cannot contribute to a fan-in dimension summary",
        ),
      );
    }
    if (
      branch?.schemaVersion ===
        "startup_opportunity.concept_evidence_assessment_branch_result.v1" &&
      (branch.document.dimension_id !== summary.dimension_id ||
        branch.document.decision_sufficiency !== summary.decision_sufficiency ||
        !exactStringSet(
          strings(branch.document.judgment_assessment_refs),
          strings(summary.judgment_assessment_refs),
        ))
    ) {
      errors.push(
        issue(
          "assess_contract.fan_in_summary_mismatch",
          `${fanIn.path}#/dimension_summaries/${String(summary.dimension_id)}`,
          "fan-in dimension summary differs from its branch result",
        ),
      );
    }
  }

  const coveredDimensions = new Set(
    [...usableBranchRefs]
      .map((ref) => targetByRef(documentsByPath, ref)?.document.dimension_id)
      .filter((value): value is string => typeof value === "string"),
  );
  const expectedMissing = ASSESSMENT_DIMENSIONS.filter(
    (dimension) => !coveredDimensions.has(dimension),
  );
  if (!exactStringSet(strings(fanIn.document.missing_mandatory_dimensions), expectedMissing)) {
    errors.push(
      issue(
        "assess_contract.missing_dimension_summary_mismatch",
        `${fanIn.path}#/missing_mandatory_dimensions`,
        "fan-in missing dimensions do not match categorized branch coverage",
        { expectedMissing },
      ),
    );
  }
}

function validateMatrix(
  matrix: AssessDomainDocument,
  documentsByPath: ReadonlyMap<string, AssessDomainDocument>,
  errors: ValidationIssue[],
): void {
  const plan = targetByRef(documentsByPath, matrix.document.assessment_plan_ref);
  const fanIn = targetByRef(documentsByPath, matrix.document.fan_in_ref);
  const dimensions = validateDimensionSet(matrix.path, matrix.document.dimensions, errors);
  const planDimensions = new Map(
    records(plan?.document.dimensions).map((dimension) => [dimension.dimension_id, dimension]),
  );
  const fanSummaries = new Map(
    records(fanIn?.document.dimension_summaries).map((summary) => [summary.dimension_id, summary]),
  );
  for (const dimension of dimensions) {
    const planDimension = planDimensions.get(dimension.dimension_id);
    const fanSummary = fanSummaries.get(dimension.dimension_id);
    const judgments = strings(dimension.judgment_assessment_refs)
      .map((ref) => targetByRef(documentsByPath, ref))
      .filter((entry): entry is AssessDomainDocument => entry !== null);
    if (planDimension && planDimension.hypothesis !== dimension.hypothesis) {
      errors.push(
        issue(
          "assess_contract.matrix_hypothesis_mismatch",
          `${matrix.path}#/dimensions/${String(dimension.dimension_id)}/hypothesis`,
          "Evidence Matrix rewrites the assessment plan hypothesis",
        ),
      );
    }
    if (
      fanSummary &&
      (fanSummary.decision_sufficiency !== dimension.decision_sufficiency ||
        !exactStringSet(
          strings(fanSummary.judgment_assessment_refs),
          strings(dimension.judgment_assessment_refs),
        ))
    ) {
      errors.push(
        issue(
          "assess_contract.matrix_fan_in_mismatch",
          `${matrix.path}#/dimensions/${String(dimension.dimension_id)}`,
          "Evidence Matrix differs from fan-in judgments or sufficiency",
        ),
      );
    }
    if (
      judgments.some(
        (judgment) =>
          judgment.schemaVersion !== "startup_opportunity.judgment_assessment.v1" ||
          judgment.document.subject_ref !== matrix.document.concept_hypothesis_ref ||
          judgment.document.dimension !== dimension.dimension_id,
      )
    ) {
      errors.push(
        issue(
          "assess_contract.matrix_judgment_mismatch",
          `${matrix.path}#/dimensions/${String(dimension.dimension_id)}/judgment_assessment_refs`,
          "Evidence Matrix judgment has another subject or dimension",
        ),
      );
    }
    const expectedSignal = mappedJudgmentSignal(dimension.decision);
    const derived =
      expectedSignal !== null
        ? judgments.some((entry) => entry.document.judgment_signal === expectedSignal)
        : dimension.decision === "insufficient_evidence" &&
          judgments.some((entry) =>
            ["insufficient", "blocked"].includes(String(entry.document.decision_sufficiency)),
          );
    if (!derived) {
      errors.push(
        issue(
          "assess_contract.matrix_decision_mismatch",
          `${matrix.path}#/dimensions/${String(dimension.dimension_id)}/decision`,
          "Evidence Matrix decision is not derived from its JudgmentAssessment set",
        ),
      );
    }
    if (
      judgments.length > 0 &&
      !judgments.some(
        (entry) => entry.document.decision_sufficiency === dimension.decision_sufficiency,
      )
    ) {
      errors.push(
        issue(
          "assess_contract.matrix_sufficiency_mismatch",
          `${matrix.path}#/dimensions/${String(dimension.dimension_id)}/decision_sufficiency`,
          "Evidence Matrix sufficiency is not present in its JudgmentAssessment set",
        ),
      );
    }
  }
  if (
    fanIn?.schemaVersion === "startup_opportunity.concept_evidence_assessment_fan_in.v1" &&
    (fanIn.document.concept_hypothesis_ref !== matrix.document.concept_hypothesis_ref ||
      fanIn.document.assessment_plan_ref !== matrix.document.assessment_plan_ref)
  ) {
    errors.push(
      issue(
        "assess_contract.matrix_identity_mismatch",
        matrix.path,
        "Evidence Matrix and fan-in bind different concept or plan identities",
      ),
    );
  }
}

function validateAssessment(
  assessment: AssessDomainDocument,
  documentsByPath: ReadonlyMap<string, AssessDomainDocument>,
  errors: ValidationIssue[],
): void {
  const matrix = targetByRef(documentsByPath, assessment.document.hypothesis_evidence_matrix_ref);
  const businessEngine = targetByRef(documentsByPath, assessment.document.business_engine_ref);
  const decisions = validateDimensionSet(
    assessment.path,
    assessment.document.dimension_decisions,
    errors,
  );
  const matrixDimensions = new Map(
    records(matrix?.document.dimensions).map((dimension) => [dimension.dimension_id, dimension]),
  );
  for (const decision of decisions) {
    const matrixDimension = matrixDimensions.get(decision.dimension_id);
    if (
      matrixDimension &&
      (matrixDimension.decision !== decision.decision ||
        matrixDimension.decision_sufficiency !== decision.decision_sufficiency ||
        !exactStringSet(
          strings(matrixDimension.judgment_assessment_refs),
          strings(decision.judgment_assessment_refs),
        ))
    ) {
      errors.push(
        issue(
          "assess_contract.assessment_matrix_mismatch",
          `${assessment.path}#/dimension_decisions/${String(decision.dimension_id)}`,
          "Assessment dimension decision differs from the Evidence Matrix",
        ),
      );
    }
  }
  if (
    matrix?.schemaVersion === "startup_opportunity.hypothesis_evidence_matrix.v1" &&
    (matrix.document.concept_hypothesis_ref !== assessment.document.concept_hypothesis_ref ||
      matrix.document.assessment_plan_ref !== assessment.document.assessment_plan_ref)
  ) {
    errors.push(
      issue(
        "assess_contract.assessment_identity_mismatch",
        assessment.path,
        "Assessment and Evidence Matrix bind different concept or plan identities",
      ),
    );
  }
  if (
    businessEngine?.schemaVersion === "startup_opportunity.business_engine_thesis.v1" &&
    businessEngine.document.subject_ref !== assessment.document.concept_hypothesis_ref
  ) {
    errors.push(
      issue(
        "assess_contract.business_engine_subject_mismatch",
        `${assessment.path}#/business_engine_ref`,
        "BusinessEngineThesis belongs to another concept",
      ),
    );
  }
}

export function validateAssessDomainContract(
  documents: readonly AssessDomainDocument[],
): readonly ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const documentsByPath = new Map(documents.map((entry) => [entry.path, entry]));
  validateRootIdentity(documents, errors);
  validateFraming(documents, documentsByPath, errors);

  for (const plan of bySchema(
    documents,
    "startup_opportunity.concept_evidence_assessment_plan.v1",
  )) {
    validateAssessmentPlan(plan, documentsByPath, errors);
  }
  for (const branch of bySchema(
    documents,
    "startup_opportunity.concept_evidence_assessment_branch_result.v1",
  )) {
    validateBranch(branch, documentsByPath, errors);
  }
  for (const fanIn of bySchema(
    documents,
    "startup_opportunity.concept_evidence_assessment_fan_in.v1",
  )) {
    validateFanIn(fanIn, documents, documentsByPath, errors);
  }
  for (const matrix of bySchema(documents, "startup_opportunity.hypothesis_evidence_matrix.v1")) {
    validateMatrix(matrix, documentsByPath, errors);
  }
  for (const businessEngine of bySchema(
    documents,
    "startup_opportunity.business_engine_thesis.v1",
  )) {
    const subject = targetByRef(documentsByPath, businessEngine.document.subject_ref);
    if (subject?.schemaVersion !== "startup_opportunity.concept_hypothesis.v1") {
      continue;
    }
    for (const ref of strings(businessEngine.document.judgment_assessment_refs)) {
      const judgment = targetByRef(documentsByPath, ref);
      if (
        judgment?.schemaVersion === "startup_opportunity.judgment_assessment.v1" &&
        (judgment.document.subject_ref !== businessEngine.document.subject_ref ||
          judgment.document.dimension !== "business_engine_viability")
      ) {
        errors.push(
          issue(
            "assess_contract.business_engine_judgment_mismatch",
            `${businessEngine.path}#/judgment_assessment_refs`,
            "BusinessEngineThesis judgment has another subject or dimension",
            { ref },
          ),
        );
      }
    }
  }
  for (const assessment of bySchema(
    documents,
    "startup_opportunity.concept_evidence_assessment.v1",
  )) {
    validateAssessment(assessment, documentsByPath, errors);
  }
  return sortIssues(errors);
}

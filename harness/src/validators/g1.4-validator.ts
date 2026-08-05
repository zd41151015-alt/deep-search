import { canonicalContentHash, canonicalJson, sha256Bytes } from "../artifact-store/canonical.js";
import {
  type AssessmentReportingPolicy,
  REQUIRED_CHALLENGE_DIMENSIONS,
  REQUIRED_HARD_GATES,
  REQUIRED_REPORT_CHECKS,
} from "./assessment-reporting-policy.js";
import { sortIssues, type ValidationIssue } from "./schema-bundle.js";

export interface G14Document {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

const G14_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.evidence_audit.v1",
  "startup_opportunity.adversarial_review.v1",
  "startup_opportunity.concept_evidence_assessment.reporting.current",
  "startup_opportunity.traceability.assessment.current",
  "startup_opportunity.concept_evidence_report.v1",
  "startup_opportunity.decision_brief.assessment.current",
  "startup_opportunity.concept_evidence_report_view.v1",
  "startup_opportunity.report_consistency_evaluation.assessment.current",
]);

const LOW_TIERS = new Set([
  "model_inference_only",
  "media_or_trend_signal",
  "vendor_claim",
  "expert_or_operator_report",
  "self_reported_need",
]);

const INSUFFICIENT_GATE_IDS = new Set([
  "evidence_quality",
  "source_independence",
  "freshness",
  "ai_mandatory_bundle",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): readonly string[] {
  return array(value).filter((entry): entry is string => typeof entry === "string");
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return array(value).filter(isRecord);
}

function sameStrings(left: unknown, right: unknown): boolean {
  return canonicalJson([...strings(left)].sort()) === canonicalJson([...strings(right)].sort());
}

function issue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "g1.4",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function targetPath(ref: unknown): string | null {
  return typeof ref === "string" ? (ref.split("#", 1)[0] ?? null) : null;
}

function target(byPath: ReadonlyMap<string, G14Document>, ref: unknown): G14Document | null {
  const path = targetPath(ref);
  return path === null ? null : (byPath.get(path) ?? null);
}

function bySchema(
  documents: readonly G14Document[],
  schemaVersion: string,
): readonly G14Document[] {
  return documents.filter((entry) => entry.schemaVersion === schemaVersion);
}

function uniqueValues(
  values: readonly Record<string, unknown>[],
  field: string,
): readonly string[] {
  return [
    ...new Set(
      values
        .map((value) => value[field])
        .filter((value): value is string => typeof value === "string"),
    ),
  ].sort();
}

function addIfDifferent(
  errors: ValidationIssue[],
  actual: unknown,
  expected: unknown,
  code: string,
  path: string,
  message: string,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    errors.push(issue(code, path, message, { actual, expected }));
  }
}

function planLineage(
  byPath: ReadonlyMap<string, G14Document>,
  finalRef: unknown,
): readonly string[] {
  if (typeof finalRef !== "string") {
    return [];
  }
  const refs: string[] = [];
  const seen = new Set<string>();
  let currentRef: string | null = finalRef;
  while (currentRef !== null && !seen.has(currentRef)) {
    seen.add(currentRef);
    const plan = byPath.get(currentRef);
    if (plan?.schemaVersion !== "startup_opportunity.research_plan.v1") {
      return [];
    }
    refs.push(currentRef);
    currentRef =
      typeof plan.document.parent_plan_ref === "string" ? plan.document.parent_plan_ref : null;
  }
  return refs.reverse();
}

function validateInputHashes(
  source: G14Document,
  byPath: ReadonlyMap<string, G14Document>,
): readonly ValidationIssue[] {
  const metadata = isRecord(source.document.report_metadata)
    ? source.document.report_metadata
    : null;
  const hashes = [
    ...records(source.document.input_artifact_hashes).map((binding, index) => ({
      binding,
      instancePath: `${source.path}#/input_artifact_hashes/${index}`,
    })),
    ...records(metadata?.input_artifact_hashes).map((binding, index) => ({
      binding,
      instancePath: `${source.path}#/report_metadata/input_artifact_hashes/${index}`,
    })),
  ];
  const errors: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const { binding, instancePath } of hashes) {
    const ref = binding.ref;
    const path = targetPath(ref);
    if (path === null || seen.has(path)) {
      errors.push(
        issue(
          "g1_4.input_hash_duplicate_or_invalid",
          `${instancePath}/ref`,
          "input hash refs must be unique whole-artifact refs",
          { ref },
        ),
      );
      continue;
    }
    seen.add(path);
    const input = byPath.get(path);
    if (input === undefined) {
      errors.push(
        issue(
          "g1_4.input_hash_missing_target",
          `${instancePath}/ref`,
          "input hash target is missing",
          { ref },
        ),
      );
      continue;
    }
    const expected = canonicalContentHash(input.document);
    if (binding.content_hash !== expected) {
      errors.push(
        issue(
          "g1_4.input_hash_mismatch",
          `${instancePath}/content_hash`,
          "input hash differs from the canonical target document",
          { ref, actual: binding.content_hash, expected },
        ),
      );
    }
  }
  return errors;
}

function validateLineage(
  source: G14Document,
  byPath: ReadonlyMap<string, G14Document>,
): readonly ValidationIssue[] {
  if (!isRecord(source.document.lineage)) {
    return [];
  }
  const errors: ValidationIssue[] = [];
  const lineage = source.document.lineage;
  const manifest = bySchema([...byPath.values()], "startup_opportunity.run_manifest.v1").at(0);
  const concept = target(byPath, lineage.concept_hypothesis_ref);
  const scope = target(byPath, lineage.scope_frame_ref);
  const researchPlan = target(byPath, lineage.research_plan_ref);
  const assessmentPlan = target(byPath, lineage.assessment_plan_ref);
  if (
    manifest === undefined ||
    concept?.schemaVersion !== "startup_opportunity.concept_hypothesis.assessment.current" ||
    scope?.schemaVersion !== "startup_opportunity.scope_frame.assessment.current" ||
    researchPlan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
    assessmentPlan?.schemaVersion !== "startup_opportunity.concept_evidence_assessment_plan.v1"
  ) {
    errors.push(
      issue(
        "g1_4.lineage_target_invalid",
        `${source.path}#/lineage`,
        "final lineage targets are missing or mistyped",
      ),
    );
    return errors;
  }
  if (
    concept.document.scope_frame_ref !== lineage.scope_frame_ref ||
    assessmentPlan.document.concept_hypothesis_ref !== lineage.concept_hypothesis_ref ||
    assessmentPlan.document.research_plan_ref !== lineage.research_plan_ref
  ) {
    errors.push(
      issue(
        "g1_4.lineage_identity_mismatch",
        `${source.path}#/lineage`,
        "concept, scope, Research Plan, and assessment plan bindings differ",
      ),
    );
  }
  if (
    manifest.document.run_id !== source.document.run_id ||
    manifest.document.current_plan_ref !== lineage.research_plan_ref ||
    manifest.document.mode !== "concept_evidence_assessment"
  ) {
    errors.push(
      issue(
        "g1_4.lineage_not_current",
        `${source.path}#/lineage/research_plan_ref`,
        "G1.4 artifacts must bind the same Run current Research Plan",
      ),
    );
  }
  addIfDifferent(
    errors,
    lineage.plan_lineage_refs,
    planLineage(byPath, lineage.research_plan_ref),
    "g1_4.plan_lineage_mismatch",
    `${source.path}#/lineage/plan_lineage_refs`,
    "plan_lineage_refs must be the exact immutable ancestry",
  );
  addIfDifferent(
    errors,
    [...strings(lineage.applied_adaptation_refs)].sort(),
    [...strings(manifest.document.applied_adaptation_refs)].sort(),
    "g1_4.adaptation_lineage_mismatch",
    `${source.path}#/lineage/applied_adaptation_refs`,
    "applied adaptation refs must exactly match the current Run index",
  );
  return errors;
}

function expectedAuditState(audit: G14Document): {
  readonly ceiling: string;
  readonly evaluator: string;
} {
  const evidenceReviews = records(audit.document.evidence_reviews);
  const claimReviews = records(audit.document.claim_reviews);
  const balance = records(audit.document.stance_balance);
  const unsupported = claimReviews.some(
    (review) =>
      review.support_fidelity === "unsupported" ||
      review.quote_fidelity === "unsupported" ||
      review.quote_fidelity === "model_generated_forbidden",
  );
  const decisiveCritical = evidenceReviews.some(
    (review) =>
      review.decisive === true &&
      (review.audit_status === "unavailable" ||
        review.freshness_status !== "current" ||
        LOW_TIERS.has(String(review.evidence_tier)) ||
        review.independence === "dependent_secondary" ||
        review.independence === "shared_underlying_dataset" ||
        review.independence === "unknown" ||
        review.provenance_status !== "verified" ||
        review.quote_provenance_status === "unsupported" ||
        review.quote_provenance_status === "model_generated_forbidden"),
  );
  const decisiveSingleSource = claimReviews.some((review) => {
    if (review.decisive !== true) {
      return false;
    }
    const groups = new Set(
      strings(review.evidence_refs).map((ref) =>
        String(
          evidenceReviews.find((candidate) => candidate.evidence_ref === ref)
            ?.canonical_source_group ?? "",
        ),
      ),
    );
    groups.delete("");
    return groups.size < 2;
  });
  const materialLimit =
    evidenceReviews.some(
      (review) =>
        review.representativeness_status !== "adequate" ||
        review.bias_status !== "disclosed" ||
        review.audit_status === "limited",
    ) || balance.some((entry) => entry.status === "imbalanced");
  if (unsupported) {
    return { ceiling: "insufficient_evidence_required", evaluator: "needs_revision" };
  }
  if (decisiveCritical || decisiveSingleSource) {
    return { ceiling: "insufficient_evidence_required", evaluator: "insufficient_evidence" };
  }
  if (materialLimit) {
    return { ceiling: "investigate_further_max", evaluator: "passed" };
  }
  return { ceiling: "prioritize_allowed", evaluator: "passed" };
}

function validateAudit(
  audit: G14Document,
  byPath: ReadonlyMap<string, G14Document>,
): readonly ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const evidenceReviews = records(audit.document.evidence_reviews);
  const claimReviews = records(audit.document.claim_reviews);
  const sourceManifests = strings(audit.document.source_manifest_refs).map((ref) =>
    target(byPath, ref),
  );
  for (const [index, review] of evidenceReviews.entries()) {
    const evidence = target(byPath, review.evidence_ref);
    const sourceManifest = target(byPath, review.source_manifest_ref);
    const sourceAssessment = evidence?.document.source_assessment;
    const assessment = isRecord(sourceAssessment) ? sourceAssessment : null;
    if (
      evidence?.schemaVersion !== "startup_opportunity.evidence.assessment.current" ||
      sourceManifest?.schemaVersion !== "startup_opportunity.source_manifest.assessment.current" ||
      !strings(sourceManifest.document.accepted_evidence_refs).includes(String(review.evidence_ref))
    ) {
      errors.push(
        issue(
          "audit.evidence_or_manifest_invalid",
          `${audit.path}#/evidence_reviews/${index}`,
          "audited Evidence must exist and be accepted by its Source Manifest",
        ),
      );
      continue;
    }
    const expectedFreshness =
      evidence.document.evidence_lifecycle_status === "stale"
        ? "stale"
        : evidence.document.evidence_lifecycle_status === "active"
          ? "current"
          : "unknown";
    if (
      assessment === null ||
      assessment.canonical_source_group !== review.canonical_source_group ||
      assessment.shared_dataset_group !== review.shared_dataset_group ||
      assessment.syndication_group !== review.syndication_group ||
      assessment.independence !== review.independence ||
      evidence.document.evidence_tier !== review.evidence_tier ||
      evidence.document.geo !== review.geo ||
      evidence.document.language !== review.language ||
      review.freshness_status !== expectedFreshness
    ) {
      errors.push(
        issue(
          "audit.source_facts_mismatch",
          `${audit.path}#/evidence_reviews/${index}`,
          "audit source facts differ from the immutable Evidence record",
        ),
      );
    }
  }
  for (const [index, review] of claimReviews.entries()) {
    const claim = target(byPath, review.claim_ref);
    if (
      claim?.schemaVersion !== "startup_opportunity.claim.assessment.current" ||
      !sameStrings(claim.document.evidence_refs, review.evidence_refs)
    ) {
      errors.push(
        issue(
          "audit.claim_binding_mismatch",
          `${audit.path}#/claim_reviews/${index}`,
          "Claim audit Evidence refs differ from the formal Claim",
        ),
      );
    }
  }
  const rejectedCount = sourceManifests.reduce(
    (sum, entry) => sum + records(entry?.document.rejected_source_records).length,
    0,
  );
  const unavailableCount = sourceManifests.reduce(
    (sum, entry) => sum + records(entry?.document.unavailable_source_records).length,
    0,
  );
  if (
    audit.document.rejected_source_record_count !== rejectedCount ||
    audit.document.unavailable_source_record_count !== unavailableCount
  ) {
    errors.push(
      issue(
        "audit.source_record_count_mismatch",
        `${audit.path}#/rejected_source_record_count`,
        "audit rejected/unavailable counts differ from Source Manifests",
        { rejectedCount, unavailableCount },
      ),
    );
  }
  const dimensions = uniqueValues(records(audit.document.stance_balance), "dimension");
  if (dimensions.length !== 10) {
    errors.push(
      issue(
        "audit.dimension_coverage_incomplete",
        `${audit.path}#/stance_balance`,
        "audit stance balance must cover each assessment dimension exactly once",
      ),
    );
  }
  const expected = expectedAuditState(audit);
  if (
    audit.document.conclusion_ceiling !== expected.ceiling ||
    audit.document.evaluator_result !== expected.evaluator
  ) {
    errors.push(
      issue(
        "audit.ceiling_mismatch",
        `${audit.path}#/conclusion_ceiling`,
        "audit ceiling/evaluator does not match stale, tier, independence, fidelity, and source-count inputs",
        { expected },
      ),
    );
  }
  if (
    audit.document.evaluator_result === "needs_revision" &&
    (records(audit.document.revision_requests).length === 0 ||
      records(audit.document.evaluation_issues).length === 0)
  ) {
    errors.push(
      issue(
        "audit.revision_request_missing",
        `${audit.path}#/revision_requests`,
        "needs_revision requires a field-specific revision request and evaluation issue",
      ),
    );
  }
  return errors;
}

function validateReview(
  review: G14Document,
  byPath: ReadonlyMap<string, G14Document>,
): readonly ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const challenges = records(review.document.challenges);
  const dimensions = uniqueValues(challenges, "dimension");
  if (canonicalJson(dimensions) !== canonicalJson([...REQUIRED_CHALLENGE_DIMENSIONS].sort())) {
    errors.push(
      issue(
        "review.challenge_coverage_incomplete",
        `${review.path}#/challenges`,
        "adversarial review must cover every required challenge dimension exactly once",
      ),
    );
  }
  const sourceGroups = isRecord(review.document.source_group_independence)
    ? review.document.source_group_independence
    : {};
  const generation = new Set(strings(sourceGroups.generation_groups));
  const evaluation = new Set(strings(sourceGroups.evaluation_groups));
  const challenger = new Set(strings(sourceGroups.challenger_groups));
  const overlap = [...challenger].filter((group) => generation.has(group) || evaluation.has(group));
  if (
    (sourceGroups.status === "independent" && overlap.length > 0) ||
    (sourceGroups.status === "insufficient_independence" && overlap.length === 0)
  ) {
    errors.push(
      issue(
        "review.source_independence_mismatch",
        `${review.path}#/source_group_independence`,
        "declared challenger independence differs from the explicit source groups",
        { overlap },
      ),
    );
  }
  const requestIds = new Set(
    records(review.document.revision_requests)
      .map((entry) => entry.request_id)
      .filter((entry): entry is string => typeof entry === "string"),
  );
  for (const [index, gap] of records(review.document.decision_relevant_gaps).entries()) {
    if (
      gap.requires_new_research === true &&
      (typeof gap.revision_request_ref !== "string" || !requestIds.has(gap.revision_request_ref))
    ) {
      errors.push(
        issue(
          "review.gap_revision_request_missing",
          `${review.path}#/decision_relevant_gaps/${index}/revision_request_ref`,
          "decision-relevant new research must remain a formal revision request",
        ),
      );
    }
  }
  const expectedEvaluator =
    sourceGroups.status === "insufficient_independence" ||
    challenges.some((entry) => entry.status === "insufficient_evidence")
      ? "insufficient_evidence"
      : "passed";
  if (review.document.evaluator_result !== expectedEvaluator) {
    errors.push(
      issue(
        "review.evaluator_mismatch",
        `${review.path}#/evaluator_result`,
        "review evaluator result differs from source independence and challenge coverage",
        { expectedEvaluator },
      ),
    );
  }
  const audit = target(byPath, review.document.evidence_audit_ref);
  if (audit?.schemaVersion !== "startup_opportunity.evidence_audit.v1") {
    errors.push(
      issue(
        "review.audit_ref_invalid",
        `${review.path}#/evidence_audit_ref`,
        "review must bind the same-Run Evidence audit",
      ),
    );
  }
  return errors;
}

function expectedAssessmentResult(
  assessment: G14Document,
  audit: G14Document | null,
  review: G14Document | null,
): string {
  const gates = records(assessment.document.hard_gate_results);
  const failedDirectionalGate = gates.some(
    (gate) =>
      gate.decisive === true &&
      gate.status === "failed" &&
      !INSUFFICIENT_GATE_IDS.has(String(gate.gate_id)),
  );
  const unresolvedKiller = records(review?.document.challenges).some(
    (challenge) =>
      challenge.thesis_killing === true &&
      challenge.status === "supported" &&
      challenge.resolved === false,
  );
  if (failedDirectionalGate || unresolvedKiller) {
    return "deprioritize";
  }
  const insufficient =
    gates.some(
      (gate) =>
        gate.decisive === true &&
        (gate.status === "insufficient_evidence" ||
          (gate.status === "failed" && INSUFFICIENT_GATE_IDS.has(String(gate.gate_id)))),
    ) ||
    audit?.document.conclusion_ceiling === "insufficient_evidence_required" ||
    assessment.document.ai_mandatory_bundle_status === "incomplete";
  if (insufficient) {
    return "insufficient_evidence";
  }
  const investigate =
    audit?.document.conclusion_ceiling === "investigate_further_max" ||
    (isRecord(review?.document.source_group_independence) &&
      review.document.source_group_independence.status === "limited_overlap") ||
    strings(assessment.document.critical_gaps).length > 0 ||
    records(assessment.document.dimension_decisions).some((entry) => entry.decision === "mixed");
  return investigate ? "investigate_further" : "prioritize";
}

function validateAssessment(
  assessment: G14Document,
  byPath: ReadonlyMap<string, G14Document>,
): readonly ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const audit = target(byPath, assessment.document.evidence_audit_ref);
  const review = target(byPath, assessment.document.adversarial_review_ref);
  const matrix = target(byPath, assessment.document.hypothesis_evidence_matrix_ref);
  const engine = target(byPath, assessment.document.business_engine_ref);
  const gateIds = uniqueValues(records(assessment.document.hard_gate_results), "gate_id");
  if (canonicalJson(gateIds) !== canonicalJson([...REQUIRED_HARD_GATES].sort())) {
    errors.push(
      issue(
        "assessment.hard_gate_coverage_incomplete",
        `${assessment.path}#/hard_gate_results`,
        "Assessment must cover every decisive desk-evidence Hard Gate exactly once",
      ),
    );
  }
  const dimensionIds = uniqueValues(
    records(assessment.document.dimension_decisions),
    "dimension_id",
  );
  if (dimensionIds.length !== 10) {
    errors.push(
      issue(
        "assessment.dimension_coverage_incomplete",
        `${assessment.path}#/dimension_decisions`,
        "Assessment dimension decisions must cover all ten dimensions exactly once",
      ),
    );
  }
  if (
    audit?.schemaVersion !== "startup_opportunity.evidence_audit.v1" ||
    review?.schemaVersion !== "startup_opportunity.adversarial_review.v1" ||
    matrix?.schemaVersion !== "startup_opportunity.hypothesis_evidence_matrix.v1" ||
    engine?.schemaVersion !== "startup_opportunity.business_engine_thesis.assessment.current"
  ) {
    errors.push(
      issue(
        "assessment.required_input_invalid",
        assessment.path,
        "Assessment requires same-Run Matrix, Business Engine, audit, and adversarial review",
      ),
    );
    return errors;
  }
  const decisiveSupportingRefs = strings(assessment.document.decisive_evidence_refs);
  const decisiveOpposingRefs = strings(assessment.document.decisive_opposing_refs);
  const evidenceIds = (refs: readonly string[]): readonly string[] =>
    refs
      .map((ref) => target(byPath, ref)?.document.evidence_id)
      .filter((id): id is string => typeof id === "string")
      .sort();
  addIfDifferent(
    errors,
    evidenceIds(decisiveSupportingRefs),
    [...strings(matrix.document.decisive_evidence_refs)].sort(),
    "assessment.decisive_matrix_mismatch",
    `${assessment.path}#/decisive_evidence_refs`,
    "Assessment decisive supporting Evidence must exactly match the final Matrix",
  );
  addIfDifferent(
    errors,
    evidenceIds(decisiveOpposingRefs),
    [...strings(matrix.document.decisive_opposing_refs)].sort(),
    "assessment.decisive_matrix_mismatch",
    `${assessment.path}#/decisive_opposing_refs`,
    "Assessment decisive opposing Evidence must exactly match the final Matrix",
  );
  const auditEvidenceReviews = records(audit.document.evidence_reviews);
  const auditClaimReviews = records(audit.document.claim_reviews);
  for (const evidenceRef of [
    ...new Set([...decisiveSupportingRefs, ...decisiveOpposingRefs]),
  ].sort()) {
    const matchingEvidenceReviews = auditEvidenceReviews.filter(
      (entry) => entry.evidence_ref === evidenceRef,
    );
    const matchingClaimReviews = auditClaimReviews.filter((entry) =>
      strings(entry.evidence_refs).includes(evidenceRef),
    );
    if (
      matchingEvidenceReviews.length !== 1 ||
      matchingEvidenceReviews[0]?.decisive !== true ||
      matchingClaimReviews.length === 0 ||
      matchingClaimReviews.some((entry) => entry.decisive !== true)
    ) {
      errors.push(
        issue(
          "assessment.decisive_audit_mismatch",
          `${assessment.path}#/decisive_evidence_refs`,
          "every final decisive Evidence and its Claims must be audited exactly once as decisive",
          { evidenceRef },
        ),
      );
    }
  }
  for (const [index, decision] of records(assessment.document.dimension_decisions).entries()) {
    const matrixDimension = records(matrix.document.dimensions).find(
      (entry) => entry.dimension_id === decision.dimension_id,
    );
    if (
      matrixDimension === undefined ||
      decision.matrix_dimension_ref !==
        `${assessment.document.hypothesis_evidence_matrix_ref}#${decision.dimension_id}` ||
      matrixDimension.decision !== decision.decision ||
      matrixDimension.decision_sufficiency !== decision.decision_sufficiency ||
      !sameStrings(matrixDimension.judgment_assessment_refs, decision.judgment_assessment_refs)
    ) {
      errors.push(
        issue(
          "assessment.matrix_decision_mismatch",
          `${assessment.path}#/dimension_decisions/${index}`,
          "Assessment dimension decision differs from the exact Matrix dimension",
        ),
      );
    }
  }
  if (
    assessment.document.assessment_profile === "general" &&
    assessment.document.ai_mandatory_bundle_status !== "not_applicable"
  ) {
    errors.push(
      issue(
        "assessment.ai_bundle_status_mismatch",
        `${assessment.path}#/ai_mandatory_bundle_status`,
        "general profile must mark the AI mandatory bundle not_applicable",
      ),
    );
  }
  if (
    assessment.document.assessment_profile !== "general" &&
    assessment.document.ai_mandatory_bundle_status === "not_applicable"
  ) {
    errors.push(
      issue(
        "assessment.ai_bundle_status_mismatch",
        `${assessment.path}#/ai_mandatory_bundle_status`,
        "AI and regulated-AI profiles cannot omit the mandatory bundle",
      ),
    );
  }
  const expectedResult = expectedAssessmentResult(assessment, audit, review);
  if (assessment.document.assessment_result !== expectedResult) {
    errors.push(
      issue(
        "assessment.result_mismatch",
        `${assessment.path}#/assessment_result`,
        "Assessment result differs from the deterministic ceiling and Hard Gate result",
        { actual: assessment.document.assessment_result, expected: expectedResult },
      ),
    );
  }
  const expectedEvaluator =
    expectedResult === "insufficient_evidence" ? "insufficient_evidence" : "passed";
  if (assessment.document.evaluator_result !== expectedEvaluator) {
    errors.push(
      issue(
        "assessment.evaluator_mismatch",
        `${assessment.path}#/evaluator_result`,
        "Assessment evaluator result differs from the closed result contract",
        { expectedEvaluator },
      ),
    );
  }
  if (strings(assessment.document.what_would_change_the_decision).length === 0) {
    errors.push(
      issue(
        "assessment.what_would_change_missing",
        `${assessment.path}#/what_would_change_the_decision`,
        "Assessment must state what would change the decision",
      ),
    );
  }
  if (expectedResult === "prioritize") {
    const unresolvedOpposition = records(review.document.challenges).some(
      (entry) => entry.thesis_killing === true && entry.resolved === false,
    );
    const engineUnknown = [
      engine.document.pricing_unit,
      engine.document.retention_or_repeat_trigger,
      engine.document.reachable_beachhead_market,
      engine.document.service_and_support_burden,
    ].some((value) => value === "unknown");
    if (
      unresolvedOpposition ||
      engineUnknown ||
      records(assessment.document.hard_gate_results).some(
        (gate) => gate.status !== "passed" && gate.status !== "not_applicable",
      ) ||
      strings(assessment.document.decisive_evidence_refs).length === 0
    ) {
      errors.push(
        issue(
          "assessment.prioritize_gate_failed",
          assessment.path,
          "prioritize requires all decisive gates, auditable Business Engine, decisive Evidence, and no unresolved thesis-killing opposition",
        ),
      );
    }
  }
  return errors;
}

function validateTraceability(
  traceability: G14Document,
  byPath: ReadonlyMap<string, G14Document>,
): readonly ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const assessment = target(byPath, traceability.document.assessment_ref);
  const matrix = target(byPath, traceability.document.hypothesis_evidence_matrix_ref);
  if (
    assessment?.schemaVersion ===
      "startup_opportunity.concept_evidence_assessment.reporting.current" &&
    (traceability.document.hypothesis_evidence_matrix_ref !==
      assessment.document.hypothesis_evidence_matrix_ref ||
      traceability.document.business_engine_ref !== assessment.document.business_engine_ref ||
      traceability.document.evidence_audit_ref !== assessment.document.evidence_audit_ref ||
      traceability.document.adversarial_review_ref !== assessment.document.adversarial_review_ref)
  ) {
    errors.push(
      issue(
        "traceability.input_binding_mismatch",
        traceability.path,
        "Traceability inputs must exactly match the final Assessment inputs",
      ),
    );
  }
  for (const [index, chain] of records(traceability.document.chains).entries()) {
    const judgment = target(byPath, chain.judgment_assessment_ref);
    const concept = target(byPath, chain.concept_subject_ref);
    const insight = target(byPath, chain.insight_ref);
    const finding = target(byPath, chain.finding_ref);
    const claim = target(byPath, chain.claim_ref);
    const evidence = target(byPath, chain.evidence_ref);
    const matrixDimension = records(matrix?.document.dimensions).find(
      (entry) =>
        `${traceability.document.hypothesis_evidence_matrix_ref}#${entry.dimension_id}` ===
        chain.matrix_dimension_ref,
    );
    const claimId = claim?.document.claim_id;
    const judgmentClaims =
      chain.stance === "support"
        ? strings(judgment?.document.supporting_claim_refs)
        : strings(judgment?.document.opposing_claim_refs);
    if (
      assessment?.schemaVersion !==
        "startup_opportunity.concept_evidence_assessment.reporting.current" ||
      matrix?.schemaVersion !== "startup_opportunity.hypothesis_evidence_matrix.v1" ||
      judgment?.schemaVersion !== "startup_opportunity.judgment_assessment.assessment.current" ||
      concept?.schemaVersion !== "startup_opportunity.concept_hypothesis.assessment.current" ||
      insight?.schemaVersion !== "startup_opportunity.insight.assessment.current" ||
      finding?.schemaVersion !== "startup_opportunity.finding.assessment.current" ||
      claim?.schemaVersion !== "startup_opportunity.claim.assessment.current" ||
      evidence?.schemaVersion !== "startup_opportunity.evidence.assessment.current" ||
      chain.assessment_ref !== traceability.document.assessment_ref ||
      matrixDimension === undefined ||
      !strings(matrixDimension.judgment_assessment_refs).includes(
        String(chain.judgment_assessment_ref),
      ) ||
      judgment.document.subject_ref !== chain.concept_subject_ref ||
      !judgmentClaims.includes(String(claimId)) ||
      !strings(insight.document.finding_refs).includes(String(chain.finding_ref)) ||
      (!strings(finding.document.claim_refs).includes(String(chain.claim_ref)) &&
        !strings(finding.document.opposing_claim_refs).includes(String(chain.claim_ref))) ||
      !strings(claim.document.evidence_refs).includes(String(chain.evidence_ref))
    ) {
      errors.push(
        issue(
          "traceability.chain_broken",
          `${traceability.path}#/chains/${index}`,
          "decisive chain does not close report -> brief -> Assessment -> Matrix -> Judgment -> subject -> Insight -> Finding -> Claim -> Evidence",
        ),
      );
    }
  }
  if (
    assessment?.schemaVersion ===
    "startup_opportunity.concept_evidence_assessment.reporting.current"
  ) {
    const supportingRefs = new Set(strings(assessment.document.decisive_evidence_refs));
    const opposingRefs = new Set(strings(assessment.document.decisive_opposing_refs));
    const chains = records(traceability.document.chains);
    const tracedRefs = new Set(chains.map((entry) => entry.evidence_ref));
    const missingRefs = [...supportingRefs, ...opposingRefs].filter((ref) => !tracedRefs.has(ref));
    const stanceMismatch = chains.some(
      (entry) =>
        (supportingRefs.has(String(entry.evidence_ref)) && entry.stance !== "support") ||
        (opposingRefs.has(String(entry.evidence_ref)) && entry.stance !== "oppose"),
    );
    if (missingRefs.length > 0 || stanceMismatch) {
      errors.push(
        issue(
          "traceability.decisive_evidence_coverage_mismatch",
          `${traceability.path}#/chains`,
          "Traceability must cover every final decisive Evidence ref with the declared stance",
          { missingRefs: missingRefs.sort(), stanceMismatch },
        ),
      );
    }
  }
  const coverage = isRecord(traceability.document.coverage) ? traceability.document.coverage : {};
  const chainIds = new Set(records(traceability.document.chains).map((entry) => entry.chain_id));
  if (
    coverage.result !== "complete" ||
    coverage.decisive_statement_count !== coverage.traced_decisive_statement_count ||
    strings(coverage.untraced_statement_ids).length > 0 ||
    chainIds.size !== records(traceability.document.chains).length ||
    traceability.document.evaluator_result !== "passed"
  ) {
    errors.push(
      issue(
        "traceability.coverage_incomplete",
        `${traceability.path}#/coverage`,
        "Traceability must completely and uniquely cover all decisive statements",
      ),
    );
  }
  return errors;
}

function flattenSummaryRefs(value: unknown): readonly string[] {
  return records(value)
    .flatMap((entry) => strings(entry.refs))
    .sort();
}

function allText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(allText).join("\n");
  }
  if (isRecord(value)) {
    return Object.values(value).map(allText).join("\n");
  }
  return "";
}

function validateReportSet(
  documents: readonly G14Document[],
  byPath: ReadonlyMap<string, G14Document>,
  policy: AssessmentReportingPolicy,
): readonly ValidationIssue[] {
  const reports = bySchema(documents, "startup_opportunity.concept_evidence_report.v1");
  if (reports.length === 0) {
    return [];
  }
  const errors: ValidationIssue[] = [];
  for (const report of reports) {
    const context = isRecord(report.document.curated_judgment_context)
      ? report.document.curated_judgment_context
      : {};
    const assessment = target(byPath, report.document.concept_evidence_assessment_ref);
    const traceability = target(byPath, report.document.traceability_ref);
    const brief = bySchema(documents, "startup_opportunity.decision_brief.assessment.current").find(
      (entry) => entry.document.report_ref === report.path,
    );
    const view = bySchema(documents, "startup_opportunity.concept_evidence_report_view.v1").find(
      (entry) => entry.document.report_ref === report.path,
    );
    const consistency = bySchema(
      documents,
      "startup_opportunity.report_consistency_evaluation.assessment.current",
    ).find((entry) => entry.document.report_ref === report.path);
    if (
      assessment?.schemaVersion !==
        "startup_opportunity.concept_evidence_assessment.reporting.current" ||
      traceability?.schemaVersion !== "startup_opportunity.traceability.assessment.current"
    ) {
      errors.push(
        issue(
          "report.required_input_invalid",
          report.path,
          "report must bind the final Assessment and complete Traceability artifact",
        ),
      );
      continue;
    }
    const lineage = isRecord(assessment.document.lineage) ? assessment.document.lineage : {};
    const audit = target(byPath, report.document.evidence_audit_ref);
    const expectedJudgmentRefs = records(assessment.document.dimension_decisions)
      .flatMap((entry) => strings(entry.judgment_assessment_refs))
      .filter((ref, index, refs) => refs.indexOf(ref) === index)
      .sort();
    if (
      report.document.run_id !== assessment.document.run_id ||
      report.document.concept_frame_ref !== lineage.scope_frame_ref ||
      report.document.concept_hypothesis_ref !== lineage.concept_hypothesis_ref ||
      report.document.research_plan_ref !== lineage.research_plan_ref ||
      report.document.evidence_assessment_plan_ref !== lineage.assessment_plan_ref ||
      canonicalJson(report.document.plan_lineage_refs) !==
        canonicalJson(lineage.plan_lineage_refs) ||
      canonicalJson(report.document.applied_adaptation_refs) !==
        canonicalJson(lineage.applied_adaptation_refs) ||
      report.document.hypothesis_evidence_matrix_ref !==
        assessment.document.hypothesis_evidence_matrix_ref ||
      report.document.business_engine_ref !== assessment.document.business_engine_ref ||
      report.document.evidence_audit_ref !== assessment.document.evidence_audit_ref ||
      report.document.adversarial_review_ref !== assessment.document.adversarial_review_ref ||
      traceability.document.assessment_ref !== assessment.path ||
      canonicalJson([...strings(report.document.judgment_assessment_refs)].sort()) !==
        canonicalJson(expectedJudgmentRefs) ||
      audit?.schemaVersion !== "startup_opportunity.evidence_audit.v1" ||
      !sameStrings(report.document.source_manifest_refs, audit.document.source_manifest_refs)
    ) {
      errors.push(
        issue(
          "report.final_input_lineage_mismatch",
          report.path,
          "report top-level refs must exactly bind the final current Assessment lineage and inputs",
        ),
      );
    }
    const reportMetadata = isRecord(report.document.report_metadata)
      ? report.document.report_metadata
      : {};
    const reportInputHashRefs = new Set(
      records(reportMetadata.input_artifact_hashes)
        .map((binding) => targetPath(binding.ref))
        .filter((ref): ref is string => ref !== null),
    );
    const requiredReportInputHashRefs = [
      report.document.decision_context_ref,
      report.document.concept_frame_ref,
      report.document.concept_hypothesis_ref,
      report.document.evidence_assessment_plan_ref,
      report.document.research_plan_ref,
      report.document.hypothesis_evidence_matrix_ref,
      report.document.adversarial_review_ref,
      report.document.evidence_audit_ref,
      report.document.concept_evidence_assessment_ref,
      report.document.business_engine_ref,
      report.document.traceability_ref,
    ].filter((ref): ref is string => typeof ref === "string");
    const missingReportInputHashRefs = requiredReportInputHashRefs.filter(
      (ref) => !reportInputHashRefs.has(ref),
    );
    if (missingReportInputHashRefs.length > 0) {
      errors.push(
        issue(
          "report.input_hash_coverage_incomplete",
          `${report.path}#/report_metadata/input_artifact_hashes`,
          "report metadata must hash every final direct input",
          { missingRefs: missingReportInputHashRefs.sort() },
        ),
      );
    }
    const freshness = isRecord(report.document.freshness_summary)
      ? report.document.freshness_summary
      : {};
    const decisiveReviews = records(audit?.document.evidence_reviews).filter(
      (entry) => entry.decisive === true,
    );
    const freshnessCounts = {
      current: decisiveReviews.filter((entry) => entry.freshness_status === "current").length,
      stale: decisiveReviews.filter((entry) => entry.freshness_status === "stale").length,
      unknown: decisiveReviews.filter(
        (entry) => entry.freshness_status !== "current" && entry.freshness_status !== "stale",
      ).length,
    };
    if (
      reportMetadata.valid_as_of !== assessment.document.valid_as_of ||
      context.valid_as_of !== assessment.document.valid_as_of ||
      freshness.valid_as_of !== assessment.document.valid_as_of ||
      freshness.current_decisive_evidence_count !== freshnessCounts.current ||
      freshness.stale_decisive_evidence_count !== freshnessCounts.stale ||
      freshness.unknown_freshness_count !== freshnessCounts.unknown ||
      !sameStrings(report.document.limitations, context.limitations)
    ) {
      errors.push(
        issue(
          "report.freshness_or_limitation_drift",
          report.path,
          "report freshness counts, validity date, or limitations drift from audited final inputs",
          { freshnessCounts },
        ),
      );
    }
    if (
      context.assessment_result !== assessment.document.assessment_result ||
      context.recommendation_meaning !== assessment.document.recommendation_meaning ||
      context.valid_as_of !== assessment.document.valid_as_of ||
      !sameStrings(context.limitations, assessment.document.limitations) ||
      !sameStrings(
        flattenSummaryRefs(context.decisive_support),
        assessment.document.decisive_evidence_refs,
      ) ||
      !sameStrings(
        flattenSummaryRefs(context.decisive_opposition),
        assessment.document.decisive_opposing_refs,
      ) ||
      !sameStrings(
        context.what_would_change_the_decision,
        assessment.document.what_would_change_the_decision,
      ) ||
      canonicalJson(context.external_action_boundary) !==
        canonicalJson(assessment.document.external_action_boundary)
    ) {
      errors.push(
        issue(
          "report.judgment_context_drift",
          `${report.path}#/curated_judgment_context`,
          "report judgment context drifts from the final Assessment",
        ),
      );
    }
    const decisiveStatements = records(report.document.statements).filter(
      (entry) => entry.decisive === true,
    );
    const traceChains = records(traceability.document.chains);
    const decisiveStatementIds = new Set(
      decisiveStatements.map((statement) => statement.statement_id),
    );
    for (const statement of decisiveStatements) {
      const expectedIds = traceChains
        .filter((chain) => chain.report_statement_id === statement.statement_id)
        .map((chain) => chain.chain_id)
        .sort();
      if (
        expectedIds.length === 0 ||
        canonicalJson([...strings(statement.traceability_chain_refs)].sort()) !==
          canonicalJson(expectedIds)
      ) {
        errors.push(
          issue(
            "report.statement_traceability_drift",
            `${report.path}#/statements`,
            "decisive report statement does not match Traceability chain ids",
            { statementId: statement.statement_id },
          ),
        );
      }
    }
    const coverage = isRecord(traceability.document.coverage) ? traceability.document.coverage : {};
    if (
      coverage.decisive_statement_count !== decisiveStatements.length ||
      coverage.traced_decisive_statement_count !== decisiveStatements.length ||
      traceChains.some((chain) => !decisiveStatementIds.has(chain.report_statement_id))
    ) {
      errors.push(
        issue(
          "report.statement_traceability_coverage_mismatch",
          `${report.path}#/statements`,
          "Traceability coverage must equal the report's actual decisive statement set",
        ),
      );
    }
    const forbiddenMatches = policy.forbidden_report_expressions.filter((expression) =>
      allText(report.document).toLocaleLowerCase().includes(expression.toLocaleLowerCase()),
    );
    if (forbiddenMatches.length > 0) {
      errors.push(
        issue(
          "report.forbidden_claim",
          report.path,
          "report contains market-validation, success-probability, or external-success language",
          { forbiddenMatches },
        ),
      );
    }
    if (brief !== undefined) {
      if (
        brief.document.report_content_hash !== canonicalContentHash(report.document) ||
        brief.document.assessment_ref !== report.document.concept_evidence_assessment_ref ||
        brief.document.assessment_result !== context.assessment_result ||
        brief.document.current_recommendation !== context.current_recommendation ||
        brief.document.recommendation_meaning !== context.recommendation_meaning ||
        !sameStrings(
          brief.document.decisive_supporting_refs,
          flattenSummaryRefs(context.decisive_support),
        ) ||
        !sameStrings(
          brief.document.decisive_opposing_refs,
          flattenSummaryRefs(context.decisive_opposition),
        ) ||
        !sameStrings(brief.document.limitations, context.limitations) ||
        brief.document.markdown_content_hash !== sha256Bytes(String(brief.document.markdown))
      ) {
        errors.push(
          issue(
            "report.decision_brief_drift",
            brief.path,
            "decision brief result, refs, freshness, limitations, or hash drifts from report.json",
          ),
        );
      }
    }
    if (view !== undefined) {
      if (
        view.document.report_content_hash !== canonicalContentHash(report.document) ||
        view.document.assessment_result !== context.assessment_result ||
        view.document.recommendation_meaning !== context.recommendation_meaning ||
        !sameStrings(
          view.document.decisive_supporting_refs,
          flattenSummaryRefs(context.decisive_support),
        ) ||
        !sameStrings(
          view.document.decisive_opposing_refs,
          flattenSummaryRefs(context.decisive_opposition),
        ) ||
        !sameStrings(view.document.limitations, context.limitations) ||
        view.document.markdown_content_hash !== sha256Bytes(String(view.document.markdown))
      ) {
        errors.push(
          issue(
            "report.full_view_drift",
            view.path,
            "full report result, refs, freshness, limitations, or hash drifts from report.json",
          ),
        );
      }
    }
    if (consistency !== undefined) {
      if (
        consistency.document.evaluator_result !== "passed" ||
        records(consistency.document.evaluation_issues).length > 0 ||
        strings(consistency.document.forbidden_expression_matches).length > 0 ||
        canonicalJson([...strings(consistency.document.checked_dimensions)].sort()) !==
          canonicalJson([...REQUIRED_REPORT_CHECKS].sort()) ||
        brief === undefined ||
        view === undefined ||
        consistency.document.decision_brief_ref !== brief.path ||
        consistency.document.report_view_ref !== view.path
      ) {
        errors.push(
          issue(
            "report.consistency_evaluation_invalid",
            consistency.path,
            "three-output consistency evaluation is incomplete or not passed",
          ),
        );
      }
    }
  }
  return errors;
}

export function isG14SchemaVersion(schemaVersion: string): boolean {
  return G14_SCHEMA_VERSIONS.has(schemaVersion);
}

export function validateG14Contract(
  documents: readonly G14Document[],
  policy: AssessmentReportingPolicy,
): readonly ValidationIssue[] {
  if (!documents.some((entry) => isG14SchemaVersion(entry.schemaVersion))) {
    return [];
  }
  const errors: ValidationIssue[] = [];
  const byPath = new Map(documents.map((entry) => [entry.path, entry]));
  for (const source of documents.filter((entry) => isG14SchemaVersion(entry.schemaVersion))) {
    errors.push(...validateInputHashes(source, byPath));
    errors.push(...validateLineage(source, byPath));
    if (
      source.document.owned_output_path !== undefined &&
      source.document.owned_output_path !== source.path
    ) {
      errors.push(
        issue(
          "g1_4.output_ownership_mismatch",
          `${source.path}#/owned_output_path`,
          "formal artifact path differs from its owned output path",
        ),
      );
    }
    if (
      source.envelope !== null &&
      source.document.producer_role !== undefined &&
      source.envelope.producer_role !== source.document.producer_role
    ) {
      errors.push(
        issue(
          "g1_4.producer_mismatch",
          `${source.path}#/producer_role`,
          "formal envelope producer differs from the artifact owner",
        ),
      );
    }
  }
  for (const audit of bySchema(documents, "startup_opportunity.evidence_audit.v1")) {
    errors.push(...validateAudit(audit, byPath));
  }
  for (const review of bySchema(documents, "startup_opportunity.adversarial_review.v1")) {
    errors.push(...validateReview(review, byPath));
  }
  for (const assessment of bySchema(
    documents,
    "startup_opportunity.concept_evidence_assessment.reporting.current",
  )) {
    errors.push(...validateAssessment(assessment, byPath));
  }
  for (const traceability of bySchema(
    documents,
    "startup_opportunity.traceability.assessment.current",
  )) {
    errors.push(...validateTraceability(traceability, byPath));
  }
  errors.push(...validateReportSet(documents, byPath, policy));
  return sortIssues(errors);
}

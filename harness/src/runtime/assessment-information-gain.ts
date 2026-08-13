export interface AssessmentInformationGainPolicy {
  readonly eligible_gap_resolution_classes: readonly string[];
  readonly eligible_availability: readonly string[];
  readonly eligible_decision_changes: readonly string[];
  readonly eligible_overlap_levels: readonly string[];
  readonly route_class_bindings: readonly {
    readonly acquisition_route: string;
    readonly gap_resolution_class: string;
  }[];
}

export interface InformationGainIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly likelyCause: string;
}

export interface AssessmentInformationGainSnapshot {
  readonly source_group_novelty:
    | "new_independent_group"
    | "updated_same_group"
    | "same_group"
    | "duplicate";
  readonly metric_family_coverage_change:
    | "decision_grade_added"
    | "directional_added"
    | "unchanged"
    | "not_applicable";
  readonly subject_coverage_change: "expanded" | "unchanged" | "not_applicable";
  readonly decision_or_uncertainty_change:
    | "decision_boundary_changed"
    | "uncertainty_reduced"
    | "conflict_added"
    | "unchanged";
  readonly new_evidence_character:
    | "updated"
    | "independent"
    | "opposing"
    | "conflicting"
    | "corroborating"
    | "none";
  readonly evidence_refs: readonly string[];
  readonly evidence_bindings: readonly {
    readonly evidence_ref: string;
    readonly content_hash: string;
  }[];
  readonly source_groups: readonly string[];
}

export interface AssessmentRouteHistoryEntry {
  readonly round: number;
  readonly route: string;
  readonly subject_ref: string;
  readonly gate_ref: string;
  readonly evidence_refs: readonly string[];
  readonly evidence_bindings: readonly {
    readonly evidence_ref: string;
    readonly content_hash: string;
  }[];
  readonly source_groups: readonly string[];
  readonly outcome:
    | "decision_grade_added"
    | "directional_added"
    | "conflict_added"
    | "no_material_gain"
    | "unavailable";
}

export interface AssessmentInformationGainAuthority {
  readonly current: AssessmentInformationGainSnapshot;
  readonly route_history: readonly AssessmentRouteHistoryEntry[];
}

export const EMPTY_ASSESSMENT_INFORMATION_GAIN_AUTHORITY: AssessmentInformationGainAuthority = {
  current: {
    source_group_novelty: "duplicate",
    metric_family_coverage_change: "not_applicable",
    subject_coverage_change: "unchanged",
    decision_or_uncertainty_change: "unchanged",
    new_evidence_character: "none",
    evidence_refs: [],
    evidence_bindings: [],
    source_groups: [],
  },
  route_history: [],
};

const CURRENT_INFORMATION_GAIN_POLICY: AssessmentInformationGainPolicy = {
  eligible_gap_resolution_classes: ["public_web_resolvable", "api_or_professional_data_resolvable"],
  eligible_availability: ["available_now", "available_with_authorized_access"],
  eligible_decision_changes: ["disposition", "ranking", "key_confidence"],
  eligible_overlap_levels: ["none", "partial"],
  route_class_bindings: [
    { acquisition_route: "public_web", gap_resolution_class: "public_web_resolvable" },
    {
      acquisition_route: "public_api",
      gap_resolution_class: "api_or_professional_data_resolvable",
    },
    {
      acquisition_route: "professional_data",
      gap_resolution_class: "api_or_professional_data_resolvable",
    },
    { acquisition_route: "external_validation", gap_resolution_class: "external_validation_only" },
    { acquisition_route: "none", gap_resolution_class: "non_decision_relevant" },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  code: string,
  path: string,
  message: string,
  likelyCause: string,
): InformationGainIssue {
  return { code, path, message, likelyCause };
}

export function assessmentSnapshotHasMaterialGain(
  gain: AssessmentInformationGainSnapshot,
): boolean {
  const evidenceSurfaceChanged =
    ["new_independent_group", "updated_same_group"].includes(gain.source_group_novelty) ||
    ["updated", "independent", "opposing", "conflicting"].includes(gain.new_evidence_character);
  const decisionGradeAdded = gain.metric_family_coverage_change === "decision_grade_added";
  const subjectCoverageExpanded = gain.subject_coverage_change === "expanded";
  const decisionSurfaceChanged = [
    "decision_boundary_changed",
    "uncertainty_reduced",
    "conflict_added",
  ].includes(gain.decision_or_uncertainty_change);
  return (
    decisionGradeAdded ||
    (gain.metric_family_coverage_change === "directional_added" && evidenceSurfaceChanged) ||
    subjectCoverageExpanded ||
    (decisionSurfaceChanged &&
      (decisionGradeAdded || subjectCoverageExpanded || evidenceSurfaceChanged)) ||
    evidenceSurfaceChanged
  );
}

export function evaluateAssessmentFollowupInformationGain(
  decision: Readonly<Record<string, unknown>>,
  authority: AssessmentInformationGainAuthority,
  policy: AssessmentInformationGainPolicy = CURRENT_INFORMATION_GAIN_POLICY,
): readonly InformationGainIssue[] {
  if (decision.action !== "add_bounded_followup") return [];
  const issues: InformationGainIssue[] = [];
  const gapClass = String(decision.gap_resolution_class ?? "");
  const route = String(decision.acquisition_route ?? "");
  const availability = String(decision.availability ?? "");
  const expectedChange = String(decision.expected_decision_change ?? "");
  const targetDecision = String(decision.target_decision ?? "");
  const overlap = isRecord(decision.wave_1_evidence_overlap)
    ? decision.wave_1_evidence_overlap
    : {};
  const overlapLevel = String(overlap.overlap_level ?? "");
  const overlappingRefs = Array.isArray(overlap.overlapping_evidence_refs)
    ? overlap.overlapping_evidence_refs.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const routeBinding = policy.route_class_bindings.find(
    (binding) => binding.acquisition_route === route,
  );
  const gain = authority.current;
  const targetSubjectRef = String(decision.concept_hypothesis_ref ?? "");
  const routeHistory = authority.route_history.filter(
    (entry) => targetSubjectRef === "" || entry.subject_ref === targetSubjectRef,
  );
  const materialGain = assessmentSnapshotHasMaterialGain(gain);
  const trailingNoGainRounds = [...routeHistory]
    .reverse()
    .findIndex((entry) => !["no_material_gain", "unavailable"].includes(String(entry.outcome)));
  const consecutiveNoGainCount =
    trailingNoGainRounds === -1 ? routeHistory.length : trailingNoGainRounds;
  const lastRouteOutcome = routeHistory.at(-1);
  const repeatedCurrentRoute =
    consecutiveNoGainCount > 0 &&
    lastRouteOutcome?.route === route &&
    gain.source_group_novelty !== "new_independent_group" &&
    gain.source_group_novelty !== "updated_same_group";

  if (routeBinding?.gap_resolution_class !== gapClass) {
    issues.push(
      issue(
        "assessment_information_gain.route_class_mismatch",
        "/acquisition_route",
        "the acquisition route does not match the classified gap resolution route",
        "The follow-up route and gap classification were assessed independently.",
      ),
    );
  }
  if (!policy.eligible_gap_resolution_classes.includes(gapClass)) {
    issues.push(
      issue(
        "assessment_information_gain.gap_not_researchable",
        "/gap_resolution_class",
        "the blocking gap is not obtainable through an allowed desk-research route",
        "The gap requires external validation or cannot change the decision.",
      ),
    );
  }
  if (!policy.eligible_availability.includes(availability)) {
    issues.push(
      issue(
        "assessment_information_gain.evidence_unavailable",
        "/availability",
        "the expected evidence is not currently obtainable by the assigned research lane",
        "The route requires external action or the evidence is unavailable.",
      ),
    );
  }
  if (!policy.eligible_decision_changes.includes(expectedChange)) {
    issues.push(
      issue(
        "assessment_information_gain.decision_change_missing",
        "/expected_decision_change",
        "the expected evidence would not change disposition, ranking, or a key confidence",
        "The remaining gap is informative but not decision-relevant.",
      ),
    );
  } else if (expectedChange !== targetDecision) {
    issues.push(
      issue(
        "assessment_information_gain.target_change_mismatch",
        "/target_decision",
        "the target decision and expected decision change must identify the same decision surface",
        "The follow-up has no single mechanically testable decision target.",
      ),
    );
  }
  if (!policy.eligible_overlap_levels.includes(overlapLevel)) {
    issues.push(
      issue(
        "assessment_information_gain.wave_1_overlap_excessive",
        "/wave_1_evidence_overlap/overlap_level",
        "the follow-up is materially duplicative of Wave 1 evidence",
        "The proposed task repeats an existing source, claim, or decision signal.",
      ),
    );
  }
  if (
    (overlapLevel === "none" && overlappingRefs.length > 0) ||
    (overlapLevel === "partial" && overlappingRefs.length === 0)
  ) {
    issues.push(
      issue(
        "assessment_information_gain.overlap_refs_inconsistent",
        "/wave_1_evidence_overlap/overlapping_evidence_refs",
        "the overlap level is inconsistent with the declared Wave 1 evidence references",
        "The novelty assessment omitted its overlap basis or labeled cited overlap as none.",
      ),
    );
  }
  if (!materialGain && repeatedCurrentRoute) {
    issues.push(
      issue(
        "assessment_information_gain.route_switch_required",
        "/acquisition_route",
        "a repeated route with no metric, subject, decision, uncertainty, update, independent-source, or counterevidence gain must switch route or stop",
        "The proposed follow-up repeats the same source group or proxy after a no-gain outcome.",
      ),
    );
  }
  if (consecutiveNoGainCount >= 2 && decision.action === "add_bounded_followup" && !materialGain) {
    issues.push(
      issue(
        "assessment_information_gain.stop_required",
        "/action",
        "bounded follow-up must stop after consecutive no-material-gain outcomes unless updated, independent, opposing, or conflicting Evidence changes the research surface",
        "The follow-up cap was reached without a documented change in coverage or decision uncertainty.",
      ),
    );
  }
  return issues;
}

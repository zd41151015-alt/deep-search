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

export function evaluateAssessmentFollowupInformationGain(
  decision: Readonly<Record<string, unknown>>,
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
  return issues;
}

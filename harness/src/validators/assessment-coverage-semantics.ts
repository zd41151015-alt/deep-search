export interface AssessmentCoverageSemantics {
  readonly coverageDisposition: string;
  readonly dimensionDecision: string;
  readonly decisionSufficiency: string;
}

export function assessmentCoverageSemanticsError(
  input: AssessmentCoverageSemantics,
): string | null {
  const { coverageDisposition, dimensionDecision, decisionSufficiency } = input;
  const hasNotApplicable =
    coverageDisposition === "not_applicable" ||
    dimensionDecision === "not_applicable" ||
    decisionSufficiency === "not_applicable";
  if (hasNotApplicable) {
    return coverageDisposition === "not_applicable" &&
      dimensionDecision === "not_applicable" &&
      decisionSufficiency === "not_applicable"
      ? null
      : "coverage, dimension decision, and decision sufficiency must agree on not-applicable semantics";
  }
  if (decisionSufficiency === "blocked" && coverageDisposition !== "partial") {
    return "blocked research must retain a partial coverage disposition";
  }
  if (
    coverageDisposition === "no_evidence_found" &&
    (dimensionDecision !== "insufficient_evidence" || decisionSufficiency !== "insufficient")
  ) {
    return "an explicit no-Evidence outcome requires an insufficient-evidence decision";
  }
  return null;
}

export type ValidationSeverity = "error" | "warning" | "info";
export type GateCategory = "integrity" | "decision_validity" | "coverage" | "format" | "telemetry";
export type GateStage =
  | "schema"
  | "lane_preflight"
  | "artifact_compilation"
  | "bundle_validation"
  | "aggregation"
  | "terminal_reporting"
  | "recovery";

export interface GateRegistration {
  readonly category: GateCategory;
  readonly defaultSeverity: ValidationSeverity;
  readonly stages: readonly GateStage[];
  readonly mechanicallyDerivable: boolean;
}

const ERROR: ValidationSeverity = "error";
const WARNING: ValidationSeverity = "warning";

const REGISTRY: Readonly<Record<string, GateRegistration>> = {
  "commercial_research.assigned_scope_undisclosed": {
    category: "coverage",
    defaultSeverity: WARNING,
    stages: ["artifact_compilation", "bundle_validation"],
    mechanicallyDerivable: true,
  },
  "commercial_research.quantitative_coverage_incomplete": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "aggregation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.competitive_coverage_incomplete": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "aggregation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.vendor_claim_not_cross_validated": {
    category: "decision_validity",
    defaultSeverity: WARNING,
    stages: ["bundle_validation", "aggregation", "terminal_reporting"],
    mechanicallyDerivable: false,
  },
  "commercial_research.source_concentration": {
    category: "decision_validity",
    defaultSeverity: WARNING,
    stages: ["bundle_validation", "aggregation", "terminal_reporting"],
    mechanicallyDerivable: true,
  },
  "commercial_research.independent_cross_validation_missing": {
    category: "decision_validity",
    defaultSeverity: WARNING,
    stages: ["bundle_validation", "aggregation", "terminal_reporting"],
    mechanicallyDerivable: true,
  },
  "commercial_research.regulatory_status_unverified": {
    category: "decision_validity",
    defaultSeverity: WARNING,
    stages: ["bundle_validation", "aggregation", "terminal_reporting"],
    mechanicallyDerivable: false,
  },
  "commercial_research.search_closure_log_missing": {
    category: "telemetry",
    defaultSeverity: WARNING,
    stages: ["bundle_validation"],
    mechanicallyDerivable: false,
  },
  "commercial_research.search_telemetry_overclaimed": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation"],
    mechanicallyDerivable: false,
  },
  "commercial_research.search_telemetry_unobservable": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation"],
    mechanicallyDerivable: false,
  },
  "commercial_research.valid_as_of_not_derived": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.freshness_status_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.adopted_distribution_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.uncovered_dimensions_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.coverage_content_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.secondary_source_traceability_limited": {
    category: "decision_validity",
    defaultSeverity: WARNING,
    stages: ["artifact_compilation", "bundle_validation", "aggregation"],
    mechanicallyDerivable: true,
  },
  "commercial_research.search_objective_unplanned": {
    category: "telemetry",
    defaultSeverity: WARNING,
    stages: ["artifact_compilation", "bundle_validation"],
    mechanicallyDerivable: true,
  },
  "commercial_research.acquisition_evidence_not_adopted": {
    category: "decision_validity",
    defaultSeverity: WARNING,
    stages: ["artifact_compilation", "bundle_validation", "aggregation"],
    mechanicallyDerivable: true,
  },
  "commercial_research.quantitative_positive_support_not_adopted": {
    category: "decision_validity",
    defaultSeverity: WARNING,
    stages: ["artifact_compilation", "bundle_validation", "aggregation"],
    mechanicallyDerivable: true,
  },
  "commercial_research.competitive_positive_support_not_adopted": {
    category: "decision_validity",
    defaultSeverity: WARNING,
    stages: ["artifact_compilation", "bundle_validation", "aggregation"],
    mechanicallyDerivable: true,
  },
  "commercial_research.positive_support_not_adopted": {
    category: "decision_validity",
    defaultSeverity: WARNING,
    stages: ["artifact_compilation", "bundle_validation", "aggregation"],
    mechanicallyDerivable: true,
  },
  "commercial_research.semantic_evidence_not_registered": {
    category: "decision_validity",
    defaultSeverity: WARNING,
    stages: ["bundle_validation", "aggregation"],
    mechanicallyDerivable: true,
  },
  "commercial_research.evidence_subject_unbound": {
    category: "coverage",
    defaultSeverity: WARNING,
    stages: ["artifact_compilation", "bundle_validation", "aggregation", "terminal_reporting"],
    mechanicallyDerivable: true,
  },
  "commercial_research.evidence_subject_binding_invalid": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["artifact_compilation", "bundle_validation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.cross_subject_evidence_reuse": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "aggregation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.claim_confidence_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.subject_recommendation_ceiling_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "aggregation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.subject_assessment_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "aggregation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.news_primary_traceability_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.regulatory_profile_derivation_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.vendor_claim_scope_invalid": {
    category: "decision_validity",
    defaultSeverity: WARNING,
    stages: ["artifact_compilation", "bundle_validation", "aggregation"],
    mechanicallyDerivable: true,
  },
  "commercial_research.ranking_eligibility_mismatch": {
    category: "decision_validity",
    defaultSeverity: ERROR,
    stages: ["bundle_validation", "aggregation", "terminal_reporting"],
    mechanicallyDerivable: true,
  },
  "commercial_research.report_quantitative_projection_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["aggregation", "terminal_reporting"],
    mechanicallyDerivable: true,
  },
  "commercial_research.report_competitive_projection_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["aggregation", "terminal_reporting"],
    mechanicallyDerivable: true,
  },
  "commercial_research.report_gap_projection_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["aggregation", "terminal_reporting"],
    mechanicallyDerivable: true,
  },
  "commercial_research.report_subject_aggregate_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["aggregation", "terminal_reporting", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.report_background_projection_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["aggregation", "terminal_reporting", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.report_status_projection_mismatch": {
    category: "integrity",
    defaultSeverity: ERROR,
    stages: ["aggregation", "terminal_reporting", "recovery"],
    mechanicallyDerivable: true,
  },
  "commercial_research.report_audit_closure_incomplete": {
    category: "coverage",
    defaultSeverity: WARNING,
    stages: ["aggregation", "terminal_reporting"],
    mechanicallyDerivable: true,
  },
  "terminal_reporting.search_closure_incomplete": {
    category: "coverage",
    defaultSeverity: WARNING,
    stages: ["terminal_reporting"],
    mechanicallyDerivable: true,
  },
  "terminal_reporting.gate_warning_missing": {
    category: "format",
    defaultSeverity: ERROR,
    stages: ["terminal_reporting"],
    mechanicallyDerivable: true,
  },
  "terminal_reporting.recommendation_ceiling_exceeded": {
    category: "decision_validity",
    defaultSeverity: ERROR,
    stages: ["terminal_reporting"],
    mechanicallyDerivable: true,
  },
  "g2_4.candidate_commercial_ceiling_violation": {
    category: "decision_validity",
    defaultSeverity: ERROR,
    stages: ["aggregation", "terminal_reporting", "recovery"],
    mechanicallyDerivable: true,
  },
};

const PREFIX_REGISTRY: readonly [string, GateRegistration][] = [
  [
    "schema.",
    {
      category: "integrity",
      defaultSeverity: ERROR,
      stages: ["schema"],
      mechanicallyDerivable: false,
    },
  ],
  [
    "bundle.",
    {
      category: "integrity",
      defaultSeverity: ERROR,
      stages: ["schema"],
      mechanicallyDerivable: false,
    },
  ],
  [
    "reference.",
    {
      category: "integrity",
      defaultSeverity: ERROR,
      stages: ["bundle_validation", "recovery"],
      mechanicallyDerivable: false,
    },
  ],
  [
    "artifact.",
    {
      category: "integrity",
      defaultSeverity: ERROR,
      stages: ["artifact_compilation", "bundle_validation", "recovery"],
      mechanicallyDerivable: false,
    },
  ],
  [
    "lane_delivery.",
    {
      category: "integrity",
      defaultSeverity: ERROR,
      stages: ["lane_preflight"],
      mechanicallyDerivable: false,
    },
  ],
  [
    "commercial_research.",
    {
      category: "decision_validity",
      defaultSeverity: ERROR,
      stages: ["bundle_validation", "aggregation"],
      mechanicallyDerivable: false,
    },
  ],
  [
    "terminal_reporting.",
    {
      category: "decision_validity",
      defaultSeverity: ERROR,
      stages: ["terminal_reporting"],
      mechanicallyDerivable: false,
    },
  ],
];

const FALLBACK: GateRegistration = {
  category: "integrity",
  defaultSeverity: ERROR,
  stages: ["bundle_validation"],
  mechanicallyDerivable: false,
};

export function gateRegistration(code: string): GateRegistration {
  const exact = REGISTRY[code];
  if (exact !== undefined) return exact;
  return PREFIX_REGISTRY.find(([prefix]) => code.startsWith(prefix))?.[1] ?? FALLBACK;
}

export function registeredGateCodes(): readonly string[] {
  return Object.keys(REGISTRY).sort();
}

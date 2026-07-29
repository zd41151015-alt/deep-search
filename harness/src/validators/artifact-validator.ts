import type { ErrorObject } from "ajv";
import { canonicalContentHash } from "../artifact-store/canonical.js";
import {
  loadResearchPublicationPolicy,
  type PublicationPolicy,
  type StorePublicationAdapter,
} from "../artifact-store/publication-policy.js";
import { scanReportSurface } from "../reporting/report-consistency.js";
import {
  type AssessDomainDocument,
  isAssessDomainSchemaVersion,
  validateAssessDomainContract,
} from "./assess-domain-validator.js";
import {
  type AssessmentAdaptationDocument,
  validateAssessmentAdaptationContract,
} from "./assessment-adaptation-validator.js";
import {
  type AssessmentReportingPolicy,
  loadAssessmentReportingPolicy,
} from "./assessment-reporting-policy.js";
import {
  type DiscoveryCandidatePolicy,
  loadDiscoveryCandidatePolicy,
} from "./discovery-candidate-policy.js";
import {
  type DiscoveryCandidateDocument,
  isDiscoveryCandidateSchemaVersion,
  validateDiscoveryCandidateContract,
} from "./discovery-candidate-validator.js";
import {
  type DiscoveryEvaluationPolicy,
  LEGACY_DISCOVERY_EVALUATION_POLICY_PATH,
  loadDiscoveryEvaluationPolicy,
} from "./discovery-evaluation-policy.js";
import {
  type DiscoveryEvaluationDocument,
  isDiscoveryEvaluationSchemaVersion,
  validateDiscoveryEvaluationContract,
} from "./discovery-evaluation-validator.js";
import {
  type LoadedDiscoveryMapsPolicy,
  loadDiscoveryMapsPolicy,
} from "./discovery-maps-policy.js";
import {
  type DiscoveryMapDocument,
  isDiscoveryMapSchemaVersion,
  validateDiscoveryMapsContract,
} from "./discovery-maps-validator.js";
import {
  type DiscoverySynthesisPolicy,
  loadDiscoverySynthesisPolicy,
} from "./discovery-synthesis-policy.js";
import {
  type DiscoverySynthesisDocument,
  isDiscoverySynthesisSchemaVersion,
  validateDiscoverySynthesisContract,
} from "./discovery-synthesis-validator.js";
import { type G14Document, isG14SchemaVersion, validateG14Contract } from "./g1.4-validator.js";
import { coverageKey, planningRunStateHash } from "./planning-contract-identities.js";
import {
  type ResearchBranchDocument,
  validateResearchBranchContract,
} from "./research-branch-validator.js";
import {
  type LoadedSchemaBundle,
  loadSchemaBundle,
  sortIssues,
  type ValidationIssue,
} from "./schema-bundle.js";

export const ARTIFACT_VALIDATION_RESULT_VERSION =
  "startup_opportunity.artifact_validation_result.v1" as const;
export const DOCUMENT_BUNDLE_VALIDATION_RESULT_VERSION =
  "startup_opportunity.document_bundle_validation_result.v1" as const;

export interface ArtifactValidationResult {
  readonly schemaVersion: typeof ARTIFACT_VALIDATION_RESULT_VERSION;
  readonly schemaBundleVersion: string;
  readonly valid: boolean;
  readonly documentPath: string | null;
  readonly artifactSchemaVersion: string | null;
  readonly errors: readonly ValidationIssue[];
}

export interface DocumentBundleEntry {
  readonly path: string;
  readonly document: Record<string, unknown>;
}

export interface DocumentBundle {
  readonly schema_version:
    | "startup_opportunity.document_bundle.v1"
    | "startup_opportunity.document_bundle.v2"
    | "startup_opportunity.document_bundle.v3"
    | "startup_opportunity.document_bundle.v4"
    | "startup_opportunity.document_bundle.v5"
    | "startup_opportunity.document_bundle.v6"
    | "startup_opportunity.document_bundle.v7"
    | "startup_opportunity.document_bundle.v8"
    | "startup_opportunity.document_bundle.v9"
    | "startup_opportunity.document_bundle.v10"
    | "startup_opportunity.document_bundle.v11"
    | "startup_opportunity.document_bundle.v12"
    | "startup_opportunity.document_bundle.v13";
  readonly documents: readonly DocumentBundleEntry[];
  readonly exact_records?: readonly {
    readonly ref: string;
    readonly document: Record<string, unknown>;
  }[];
}

export interface DocumentBundleReferenceContext {
  readonly exactJsonlRecords?: ReadonlyMap<string, Record<string, unknown>>;
  readonly validateHistoricalDiscoveryContracts?: boolean;
}

export interface DocumentBundleValidationResult {
  readonly schemaVersion: typeof DOCUMENT_BUNDLE_VALIDATION_RESULT_VERSION;
  readonly schemaBundleVersion: string;
  readonly valid: boolean;
  readonly bundleErrors: readonly ValidationIssue[];
  readonly documents: readonly ArtifactValidationResult[];
  readonly referenceErrors: readonly ValidationIssue[];
}

interface EffectiveDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

interface ReferenceRequirement {
  readonly instancePath: string;
  readonly ref: string;
  readonly expectedSchemaVersions: readonly string[];
  readonly expectedIdField?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaVersionOf(document: unknown): string | null {
  return isRecord(document) && typeof document.schema_version === "string"
    ? document.schema_version
    : null;
}

function normalizeDetails(params: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(params).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeAjvErrors(
  errors: readonly ErrorObject[] | null | undefined,
): readonly ValidationIssue[] {
  return sortIssues(
    (errors ?? []).map((error) => ({
      code: `schema.${error.keyword}`,
      keyword: error.keyword,
      instancePath: error.instancePath,
      schemaPath: error.schemaPath,
      message: error.message ?? "schema validation failed",
      details: normalizeDetails(error.params),
    })),
  );
}

function referenceIssue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
): ValidationIssue {
  return {
    code,
    keyword: "reference",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function refsFromArray(
  document: Record<string, unknown>,
  field: string,
  expectedSchemaVersion: string | readonly string[],
  expectedIdField?: string,
): readonly ReferenceRequirement[] {
  const value = document[field];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((ref, index) =>
    typeof ref === "string"
      ? [
          {
            instancePath: `/${field}/${index}`,
            ref,
            expectedSchemaVersions:
              typeof expectedSchemaVersion === "string"
                ? [expectedSchemaVersion]
                : expectedSchemaVersion,
            ...(expectedIdField === undefined ? {} : { expectedIdField }),
          },
        ]
      : [],
  );
}

function optionalRef(
  document: Record<string, unknown>,
  field: string,
  expectedSchemaVersion: string | readonly string[],
  expectedIdField?: string,
): readonly ReferenceRequirement[] {
  const ref = document[field];
  if (typeof ref !== "string") {
    return [];
  }
  return [
    {
      instancePath: `/${field}`,
      ref,
      expectedSchemaVersions:
        typeof expectedSchemaVersion === "string" ? [expectedSchemaVersion] : expectedSchemaVersion,
      ...(expectedIdField === undefined ? {} : { expectedIdField }),
    },
  ];
}

function nestedRef(
  document: Record<string, unknown>,
  objectField: string,
  refField: string,
  expectedSchemaVersion: string | readonly string[],
  expectedIdField?: string,
): readonly ReferenceRequirement[] {
  const object = document[objectField];
  if (!isRecord(object) || typeof object[refField] !== "string") {
    return [];
  }
  return [
    {
      instancePath: `/${objectField}/${refField}`,
      ref: object[refField],
      expectedSchemaVersions:
        typeof expectedSchemaVersion === "string" ? [expectedSchemaVersion] : expectedSchemaVersion,
      ...(expectedIdField === undefined ? {} : { expectedIdField }),
    },
  ];
}

function refsFromNestedArray(
  document: Record<string, unknown>,
  arrayField: string,
  refField: string,
  expectedSchemaVersion: string | readonly string[],
): readonly ReferenceRequirement[] {
  const values = document[arrayField];
  if (!Array.isArray(values)) {
    return [];
  }
  return values.flatMap((value, index) => {
    if (!isRecord(value)) {
      return [];
    }
    const nested = value[refField];
    const refs = typeof nested === "string" ? [nested] : Array.isArray(nested) ? nested : [];
    return refs.flatMap((ref, refIndex) =>
      typeof ref === "string"
        ? [
            {
              instancePath: `/${arrayField}/${index}/${refField}${Array.isArray(nested) ? `/${refIndex}` : ""}`,
              ref,
              expectedSchemaVersions:
                typeof expectedSchemaVersion === "string"
                  ? [expectedSchemaVersion]
                  : expectedSchemaVersion,
            },
          ]
        : [],
    );
  });
}

function refsFromObjectArray(
  document: Record<string, unknown>,
  objectField: string,
  arrayField: string,
  expectedSchemaVersion: string | readonly string[],
): readonly ReferenceRequirement[] {
  const object = document[objectField];
  if (!isRecord(object)) {
    return [];
  }
  const values = object[arrayField];
  if (!Array.isArray(values)) {
    return [];
  }
  return values.flatMap((ref, index) =>
    typeof ref === "string"
      ? [
          {
            instancePath: `/${objectField}/${arrayField}/${index}`,
            ref,
            expectedSchemaVersions:
              typeof expectedSchemaVersion === "string"
                ? [expectedSchemaVersion]
                : expectedSchemaVersion,
          },
        ]
      : [],
  );
}

function g14CommonRefs(document: Record<string, unknown>): readonly ReferenceRequirement[] {
  return [
    ...nestedRef(
      document,
      "lineage",
      "concept_hypothesis_ref",
      "startup_opportunity.concept_hypothesis.v1",
    ),
    ...nestedRef(document, "lineage", "scope_frame_ref", "startup_opportunity.scope_frame.v1"),
    ...nestedRef(document, "lineage", "research_plan_ref", "startup_opportunity.research_plan.v1"),
    ...nestedRef(
      document,
      "lineage",
      "assessment_plan_ref",
      "startup_opportunity.concept_evidence_assessment_plan.v1",
    ),
    ...refsFromNestedArray(document, "input_artifact_hashes", "ref", [
      "startup_opportunity.run_manifest.v1",
      "startup_opportunity.research_plan.v1",
      "startup_opportunity.scope_frame.v1",
      "startup_opportunity.concept_hypothesis.v1",
      "startup_opportunity.concept_evidence_assessment_plan.v1",
      "startup_opportunity.concept_evidence_assessment_fan_in.v1",
      "startup_opportunity.hypothesis_evidence_matrix.v1",
      "startup_opportunity.business_engine_thesis.v1",
      "startup_opportunity.judgment_assessment.v1",
      "startup_opportunity.research_task.v1",
      "startup_opportunity.evidence.v1",
      "startup_opportunity.claim.v1",
      "startup_opportunity.finding.v1",
      "startup_opportunity.insight.v1",
      "startup_opportunity.source_manifest.v1",
      "startup_opportunity.evidence_audit.v1",
      "startup_opportunity.adversarial_review.v1",
      "startup_opportunity.concept_evidence_assessment.v2",
      "startup_opportunity.traceability.v1",
      "startup_opportunity.concept_evidence_report.v1",
      "startup_opportunity.decision_brief.v1",
      "startup_opportunity.concept_evidence_report_view.v1",
    ]),
  ];
}

function referenceRequirements(effective: EffectiveDocument): readonly ReferenceRequirement[] {
  const { document, schemaVersion } = effective;
  switch (schemaVersion) {
    case "startup_opportunity.run_manifest.v1":
      return [
        ...optionalRef(document, "current_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "latest_gap_snapshot_ref", [
          "startup_opportunity.gap_snapshot.v1",
          "startup_opportunity.gap_snapshot.v2",
        ]),
        ...refsFromArray(document, "pending_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
          "startup_opportunity.adaptation_decision.v3",
        ]),
        ...refsFromArray(document, "validated_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
          "startup_opportunity.adaptation_decision.v3",
        ]),
        ...refsFromArray(document, "rejected_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
          "startup_opportunity.adaptation_decision.v3",
        ]),
        ...refsFromArray(document, "applied_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
          "startup_opportunity.adaptation_decision.v3",
        ]),
        ...optionalRef(document, "checkpoint_ref", "startup_opportunity.checkpoint.v1"),
      ];
    case "startup_opportunity.research_plan.v1":
      return [
        ...optionalRef(document, "parent_plan_ref", "startup_opportunity.research_plan.v1"),
        ...refsFromArray(document, "triggered_by_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
          "startup_opportunity.adaptation_decision.v3",
        ]),
      ];
    case "startup_opportunity.gap_snapshot.v1":
      return [
        ...optionalRef(document, "based_on_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "parent_snapshot_ref", "startup_opportunity.gap_snapshot.v1"),
        ...optionalRef(document, "trigger_event_ref", "startup_opportunity.event.v1", "event_id"),
      ];
    case "startup_opportunity.gap_snapshot.v2":
      return [
        ...optionalRef(document, "based_on_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "parent_snapshot_ref", "startup_opportunity.gap_snapshot.v2"),
        ...optionalRef(document, "trigger_event_ref", "startup_opportunity.event.v1", "event_id"),
        ...optionalRef(
          document,
          "assessment_plan_ref",
          "startup_opportunity.concept_evidence_assessment_plan.v1",
        ),
        ...optionalRef(document, "subject_ref", "startup_opportunity.concept_hypothesis.v1"),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v1"),
        ...refsFromNestedArray(
          document,
          "observed_artifacts",
          "artifact_ref",
          "startup_opportunity.concept_evidence_assessment_branch_result.v1",
        ),
        ...refsFromNestedArray(
          document,
          "observed_artifacts",
          "task_ref",
          "startup_opportunity.research_task.v1",
        ),
      ];
    case "startup_opportunity.adaptation_decision.v1":
      return [
        ...optionalRef(document, "based_on_plan_ref", "startup_opportunity.research_plan.v1"),
        ...refsFromArray(
          document,
          "trigger_gap_refs",
          "startup_opportunity.gap_snapshot.v1",
          "gap_id",
        ),
        ...optionalRef(
          document,
          "user_decision_ref",
          "startup_opportunity.decision.v1",
          "decision_id",
        ),
      ];
    case "startup_opportunity.adaptation_decision.v2":
      return [
        ...optionalRef(document, "based_on_plan_ref", "startup_opportunity.research_plan.v1"),
        ...refsFromArray(
          document,
          "trigger_gap_refs",
          "startup_opportunity.gap_snapshot.v1",
          "gap_id",
        ),
        ...optionalRef(
          document,
          "coverage_attestation_ref",
          "startup_opportunity.coverage_attestation.v1",
        ),
        ...optionalRef(
          document,
          "user_decision_ref",
          "startup_opportunity.decision.v1",
          "decision_id",
        ),
      ];
    case "startup_opportunity.adaptation_decision.v3":
      return [
        ...optionalRef(document, "based_on_plan_ref", "startup_opportunity.research_plan.v1"),
        ...refsFromArray(
          document,
          "trigger_gap_refs",
          "startup_opportunity.gap_snapshot.v2",
          "gap_id",
        ),
        ...optionalRef(
          document,
          "assessment_plan_ref",
          "startup_opportunity.concept_evidence_assessment_plan.v1",
        ),
        ...optionalRef(document, "subject_ref", "startup_opportunity.concept_hypothesis.v1"),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v1"),
      ];
    case "startup_opportunity.planning_context.v1":
      return [
        ...optionalRef(document, "parent_context_ref", "startup_opportunity.planning_context.v1"),
        ...nestedRef(
          document,
          "manifest_binding",
          "manifest_ref",
          "startup_opportunity.run_manifest.v1",
        ),
        ...nestedRef(
          document,
          "target_plan_binding",
          "plan_ref",
          "startup_opportunity.research_plan.v1",
        ),
      ];
    case "startup_opportunity.planning_context.v2": {
      const aiCoverage = document.ai_mandatory_coverage;
      const basis = isRecord(aiCoverage) ? aiCoverage.basis : null;
      return [
        ...optionalRef(document, "parent_context_ref", "startup_opportunity.planning_context.v2"),
        ...nestedRef(
          document,
          "manifest_binding",
          "manifest_ref",
          "startup_opportunity.run_manifest.v1",
        ),
        ...nestedRef(
          document,
          "target_plan_binding",
          "plan_ref",
          "startup_opportunity.research_plan.v1",
        ),
        ...(isRecord(aiCoverage) &&
        aiCoverage.status === "required" &&
        isRecord(basis) &&
        typeof basis.source_ref === "string"
          ? [
              {
                instancePath: "/ai_mandatory_coverage/basis/source_ref",
                ref: basis.source_ref,
                expectedSchemaVersions: ["startup_opportunity.ai_trigger_source_attestation.v1"],
              },
            ]
          : []),
      ];
    }
    case "startup_opportunity.coverage_attestation.v1":
      return [
        ...optionalRef(document, "based_on_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "gap_ref", "startup_opportunity.gap_snapshot.v1", "gap_id"),
        ...optionalRef(
          document,
          "target_unit_ref",
          "startup_opportunity.research_plan.v1",
          "unit_id",
        ),
      ];
    case "startup_opportunity.checkpoint.v1":
      return [
        ...optionalRef(document, "current_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "latest_gap_snapshot_ref", [
          "startup_opportunity.gap_snapshot.v1",
          "startup_opportunity.gap_snapshot.v2",
        ]),
        ...refsFromArray(document, "applied_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
          "startup_opportunity.adaptation_decision.v3",
        ]),
        ...refsFromArray(document, "pending_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
          "startup_opportunity.adaptation_decision.v3",
        ]),
        ...refsFromArray(
          document,
          "unresolved_gap_refs",
          ["startup_opportunity.gap_snapshot.v1", "startup_opportunity.gap_snapshot.v2"],
          "gap_id",
        ),
      ];
    case "startup_opportunity.intake.v1":
      return [
        ...optionalRef(document, "decision_context_ref", "startup_opportunity.decision_context.v1"),
      ];
    case "startup_opportunity.scope_frame.v1":
      return [
        ...optionalRef(document, "decision_context_ref", "startup_opportunity.decision_context.v1"),
      ];
    case "startup_opportunity.scope_frame.v2":
      return [
        ...optionalRef(document, "decision_context_ref", "startup_opportunity.decision_context.v1"),
      ];
    case "startup_opportunity.seed_probe.v1":
      return [
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
      ];
    case "startup_opportunity.opportunity_space_map.v1":
      return [
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "seed_probe_ref", "startup_opportunity.seed_probe.v1"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
      ];
    case "startup_opportunity.solution_space_map.v1":
      return [
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "seed_probe_ref", "startup_opportunity.seed_probe.v1"),
        ...optionalRef(
          document,
          "opportunity_space_map_ref",
          "startup_opportunity.opportunity_space_map.v1",
        ),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
      ];
    case "startup_opportunity.concept_hypothesis.v1":
      return [...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v1")];
    case "startup_opportunity.judgment_assessment.v1":
      return [...optionalRef(document, "subject_ref", "startup_opportunity.concept_hypothesis.v1")];
    case "startup_opportunity.concept_evidence_assessment_plan.v1":
      return [
        ...optionalRef(
          document,
          "parent_plan_ref",
          "startup_opportunity.concept_evidence_assessment_plan.v1",
        ),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(
          document,
          "concept_hypothesis_ref",
          "startup_opportunity.concept_hypothesis.v1",
        ),
        ...refsFromArray(document, "triggered_by_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
          "startup_opportunity.adaptation_decision.v3",
        ]),
      ];
    case "startup_opportunity.concept_evidence_assessment_branch_result.v1":
      return [
        ...optionalRef(
          document,
          "concept_hypothesis_ref",
          "startup_opportunity.concept_hypothesis.v1",
        ),
        ...optionalRef(
          document,
          "assessment_plan_ref",
          "startup_opportunity.concept_evidence_assessment_plan.v1",
        ),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v1",
        ),
        ...refsFromArray(document, "finding_refs", "startup_opportunity.finding.v1"),
      ];
    case "startup_opportunity.concept_evidence_assessment_fan_in.v1":
      return [
        ...optionalRef(
          document,
          "concept_hypothesis_ref",
          "startup_opportunity.concept_hypothesis.v1",
        ),
        ...optionalRef(
          document,
          "assessment_plan_ref",
          "startup_opportunity.concept_evidence_assessment_plan.v1",
        ),
        ...refsFromArray(
          document,
          "completed_branch_refs",
          "startup_opportunity.concept_evidence_assessment_branch_result.v1",
        ),
        ...refsFromArray(
          document,
          "partial_branch_refs",
          "startup_opportunity.concept_evidence_assessment_branch_result.v1",
        ),
        ...refsFromArray(
          document,
          "ignored_late_branch_refs",
          "startup_opportunity.concept_evidence_assessment_branch_result.v1",
        ),
        ...refsFromArray(
          document,
          "superseded_branch_refs",
          "startup_opportunity.concept_evidence_assessment_branch_result.v1",
        ),
        ...refsFromNestedArray(
          document,
          "dimension_summaries",
          "branch_ref",
          "startup_opportunity.concept_evidence_assessment_branch_result.v1",
        ),
        ...refsFromNestedArray(
          document,
          "dimension_summaries",
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v1",
        ),
      ];
    case "startup_opportunity.hypothesis_evidence_matrix.v1":
      return [
        ...optionalRef(
          document,
          "concept_hypothesis_ref",
          "startup_opportunity.concept_hypothesis.v1",
        ),
        ...optionalRef(
          document,
          "assessment_plan_ref",
          "startup_opportunity.concept_evidence_assessment_plan.v1",
        ),
        ...optionalRef(
          document,
          "fan_in_ref",
          "startup_opportunity.concept_evidence_assessment_fan_in.v1",
        ),
        ...refsFromNestedArray(
          document,
          "dimensions",
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v1",
        ),
      ];
    case "startup_opportunity.business_engine_thesis.v1":
      if (
        effective.envelope?.schema_version === "startup_opportunity.artifact_envelope.v12" ||
        effective.envelope?.schema_version === "startup_opportunity.artifact_envelope.v13"
      ) {
        return [
          ...optionalRef(document, "subject_ref", "startup_opportunity.opportunity_thesis.v1"),
          ...refsFromArray(document, "supporting_claim_refs", [
            "startup_opportunity.evidence.v3",
            "startup_opportunity.claim.v3",
          ]),
          ...refsFromArray(document, "opposing_claim_refs", [
            "startup_opportunity.evidence.v3",
            "startup_opportunity.claim.v3",
          ]),
          ...refsFromArray(
            document,
            "judgment_assessment_refs",
            "startup_opportunity.judgment_assessment.v3",
          ),
        ];
      }
      return [
        ...optionalRef(document, "subject_ref", "startup_opportunity.concept_hypothesis.v1"),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v1",
        ),
      ];
    case "startup_opportunity.concept_evidence_assessment.v1":
      return [
        ...optionalRef(
          document,
          "concept_hypothesis_ref",
          "startup_opportunity.concept_hypothesis.v1",
        ),
        ...optionalRef(
          document,
          "assessment_plan_ref",
          "startup_opportunity.concept_evidence_assessment_plan.v1",
        ),
        ...optionalRef(
          document,
          "hypothesis_evidence_matrix_ref",
          "startup_opportunity.hypothesis_evidence_matrix.v1",
        ),
        ...optionalRef(
          document,
          "business_engine_ref",
          "startup_opportunity.business_engine_thesis.v1",
        ),
        ...refsFromNestedArray(
          document,
          "dimension_decisions",
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v1",
        ),
        ...refsFromArray(
          document,
          "validation_suggestion_refs",
          "startup_opportunity.concept_assessment_suggestions.v1",
        ),
      ];
    case "startup_opportunity.research_task.v1":
      return [
        ...optionalRef(document, "target_subject_ref", "startup_opportunity.concept_hypothesis.v1"),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v1"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(
          document,
          "assessment_plan_ref",
          "startup_opportunity.concept_evidence_assessment_plan.v1",
        ),
        ...optionalRef(document, "supersedes_task_ref", "startup_opportunity.research_task.v1"),
      ];
    case "startup_opportunity.evidence.v1":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v1"),
        ...nestedRef(
          document,
          "lineage",
          "concept_hypothesis_ref",
          "startup_opportunity.concept_hypothesis.v1",
        ),
        ...nestedRef(document, "lineage", "scope_frame_ref", "startup_opportunity.scope_frame.v1"),
        ...nestedRef(
          document,
          "lineage",
          "research_plan_ref",
          "startup_opportunity.research_plan.v1",
        ),
        ...nestedRef(
          document,
          "lineage",
          "assessment_plan_ref",
          "startup_opportunity.concept_evidence_assessment_plan.v1",
        ),
        ...nestedRef(
          document,
          "mechanical_binding",
          "substrate_record_ref",
          "startup_opportunity.evidence_store_record.v2",
          "evidence_id",
        ),
      ];
    case "startup_opportunity.claim.v1":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v1"),
        ...refsFromArray(document, "evidence_refs", "startup_opportunity.evidence.v1"),
      ];
    case "startup_opportunity.finding.v1":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v1"),
        ...refsFromArray(document, "claim_refs", "startup_opportunity.claim.v1"),
        ...refsFromArray(document, "opposing_claim_refs", "startup_opportunity.claim.v1"),
      ];
    case "startup_opportunity.insight.v1":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v1"),
        ...refsFromArray(document, "finding_refs", "startup_opportunity.finding.v1"),
      ];
    case "startup_opportunity.source_manifest.v1":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v1"),
        ...refsFromArray(document, "accepted_evidence_refs", "startup_opportunity.evidence.v1"),
        ...refsFromNestedArray(
          document,
          "canonical_source_groups",
          "evidence_refs",
          "startup_opportunity.evidence.v1",
        ),
        ...refsFromNestedArray(
          document,
          "shared_dataset_groups",
          "evidence_refs",
          "startup_opportunity.evidence.v1",
        ),
        ...refsFromNestedArray(
          document,
          "duplicate_or_syndication_groups",
          "evidence_refs",
          "startup_opportunity.evidence.v1",
        ),
      ];
    case "startup_opportunity.evidence_audit.v1":
      return [
        ...g14CommonRefs(document),
        ...refsFromArray(
          document,
          "source_manifest_refs",
          "startup_opportunity.source_manifest.v1",
        ),
        ...refsFromNestedArray(
          document,
          "evidence_reviews",
          "evidence_ref",
          "startup_opportunity.evidence.v1",
        ),
        ...refsFromNestedArray(
          document,
          "evidence_reviews",
          "source_manifest_ref",
          "startup_opportunity.source_manifest.v1",
        ),
        ...refsFromNestedArray(
          document,
          "claim_reviews",
          "claim_ref",
          "startup_opportunity.claim.v1",
        ),
        ...refsFromNestedArray(
          document,
          "claim_reviews",
          "evidence_refs",
          "startup_opportunity.evidence.v1",
        ),
      ];
    case "startup_opportunity.adversarial_review.v1":
      return [
        ...g14CommonRefs(document),
        ...optionalRef(
          document,
          "hypothesis_evidence_matrix_ref",
          "startup_opportunity.hypothesis_evidence_matrix.v1",
        ),
        ...optionalRef(
          document,
          "business_engine_ref",
          "startup_opportunity.business_engine_thesis.v1",
        ),
        ...optionalRef(document, "evidence_audit_ref", "startup_opportunity.evidence_audit.v1"),
        ...refsFromArray(
          document,
          "challenger_source_manifest_refs",
          "startup_opportunity.source_manifest.v1",
        ),
        ...refsFromNestedArray(
          document,
          "challenges",
          "evidence_refs",
          "startup_opportunity.evidence.v1",
        ),
        ...refsFromNestedArray(
          document,
          "challenges",
          "claim_refs",
          "startup_opportunity.claim.v1",
        ),
      ];
    case "startup_opportunity.concept_evidence_assessment.v2":
      return [
        ...g14CommonRefs(document),
        ...optionalRef(
          document,
          "fan_in_ref",
          "startup_opportunity.concept_evidence_assessment_fan_in.v1",
        ),
        ...optionalRef(
          document,
          "hypothesis_evidence_matrix_ref",
          "startup_opportunity.hypothesis_evidence_matrix.v1",
        ),
        ...optionalRef(
          document,
          "business_engine_ref",
          "startup_opportunity.business_engine_thesis.v1",
        ),
        ...optionalRef(document, "evidence_audit_ref", "startup_opportunity.evidence_audit.v1"),
        ...optionalRef(
          document,
          "adversarial_review_ref",
          "startup_opportunity.adversarial_review.v1",
        ),
        ...refsFromNestedArray(
          document,
          "dimension_decisions",
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v1",
        ),
        ...refsFromArray(document, "decisive_evidence_refs", [
          "startup_opportunity.evidence.v1",
          "startup_opportunity.claim.v1",
        ]),
        ...refsFromArray(document, "decisive_opposing_refs", [
          "startup_opportunity.evidence.v1",
          "startup_opportunity.claim.v1",
        ]),
      ];
    case "startup_opportunity.traceability.v1":
      return [
        ...g14CommonRefs(document),
        ...optionalRef(
          document,
          "assessment_ref",
          "startup_opportunity.concept_evidence_assessment.v2",
        ),
        ...optionalRef(
          document,
          "hypothesis_evidence_matrix_ref",
          "startup_opportunity.hypothesis_evidence_matrix.v1",
        ),
        ...optionalRef(
          document,
          "business_engine_ref",
          "startup_opportunity.business_engine_thesis.v1",
        ),
        ...optionalRef(document, "evidence_audit_ref", "startup_opportunity.evidence_audit.v1"),
        ...optionalRef(
          document,
          "adversarial_review_ref",
          "startup_opportunity.adversarial_review.v1",
        ),
        ...refsFromNestedArray(
          document,
          "chains",
          "assessment_ref",
          "startup_opportunity.concept_evidence_assessment.v2",
        ),
        ...refsFromNestedArray(
          document,
          "chains",
          "judgment_assessment_ref",
          "startup_opportunity.judgment_assessment.v1",
        ),
        ...refsFromNestedArray(
          document,
          "chains",
          "concept_subject_ref",
          "startup_opportunity.concept_hypothesis.v1",
        ),
        ...refsFromNestedArray(document, "chains", "insight_ref", "startup_opportunity.insight.v1"),
        ...refsFromNestedArray(document, "chains", "finding_ref", "startup_opportunity.finding.v1"),
        ...refsFromNestedArray(document, "chains", "claim_ref", "startup_opportunity.claim.v1"),
        ...refsFromNestedArray(
          document,
          "chains",
          "evidence_ref",
          "startup_opportunity.evidence.v1",
        ),
      ];
    case "startup_opportunity.concept_evidence_report.v1":
      return [
        ...optionalRef(document, "decision_context_ref", "startup_opportunity.decision_context.v1"),
        ...optionalRef(document, "concept_frame_ref", "startup_opportunity.scope_frame.v1"),
        ...optionalRef(
          document,
          "concept_hypothesis_ref",
          "startup_opportunity.concept_hypothesis.v1",
        ),
        ...optionalRef(
          document,
          "evidence_assessment_plan_ref",
          "startup_opportunity.concept_evidence_assessment_plan.v1",
        ),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...refsFromArray(document, "plan_lineage_refs", "startup_opportunity.research_plan.v1"),
        ...refsFromArray(document, "applied_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v2",
          "startup_opportunity.adaptation_decision.v3",
        ]),
        ...optionalRef(
          document,
          "hypothesis_evidence_matrix_ref",
          "startup_opportunity.hypothesis_evidence_matrix.v1",
        ),
        ...optionalRef(
          document,
          "adversarial_review_ref",
          "startup_opportunity.adversarial_review.v1",
        ),
        ...optionalRef(document, "evidence_audit_ref", "startup_opportunity.evidence_audit.v1"),
        ...optionalRef(
          document,
          "concept_evidence_assessment_ref",
          "startup_opportunity.concept_evidence_assessment.v2",
        ),
        ...optionalRef(
          document,
          "business_engine_ref",
          "startup_opportunity.business_engine_thesis.v1",
        ),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v1",
        ),
        ...refsFromArray(
          document,
          "source_manifest_refs",
          "startup_opportunity.source_manifest.v1",
        ),
        ...optionalRef(document, "traceability_ref", "startup_opportunity.traceability.v1"),
      ];
    case "startup_opportunity.decision_brief.v1":
      return [
        ...optionalRef(document, "report_ref", "startup_opportunity.concept_evidence_report.v1"),
        ...optionalRef(
          document,
          "assessment_ref",
          "startup_opportunity.concept_evidence_assessment.v2",
        ),
        ...refsFromArray(document, "decisive_supporting_refs", [
          "startup_opportunity.evidence.v1",
          "startup_opportunity.claim.v1",
        ]),
        ...refsFromArray(document, "decisive_opposing_refs", [
          "startup_opportunity.evidence.v1",
          "startup_opportunity.claim.v1",
        ]),
      ];
    case "startup_opportunity.concept_evidence_report_view.v1":
      return [
        ...optionalRef(document, "report_ref", "startup_opportunity.concept_evidence_report.v1"),
        ...optionalRef(
          document,
          "assessment_ref",
          "startup_opportunity.concept_evidence_assessment.v2",
        ),
        ...refsFromArray(document, "decisive_supporting_refs", [
          "startup_opportunity.evidence.v1",
          "startup_opportunity.claim.v1",
        ]),
        ...refsFromArray(document, "decisive_opposing_refs", [
          "startup_opportunity.evidence.v1",
          "startup_opportunity.claim.v1",
        ]),
      ];
    case "startup_opportunity.report_consistency_evaluation.v1":
      return [
        ...optionalRef(document, "report_ref", "startup_opportunity.concept_evidence_report.v1"),
        ...optionalRef(document, "decision_brief_ref", "startup_opportunity.decision_brief.v1"),
        ...optionalRef(
          document,
          "report_view_ref",
          "startup_opportunity.concept_evidence_report_view.v1",
        ),
        ...optionalRef(
          document,
          "assessment_ref",
          "startup_opportunity.concept_evidence_assessment.v2",
        ),
        ...refsFromNestedArray(document, "input_artifact_hashes", "ref", [
          "startup_opportunity.concept_evidence_report.v1",
          "startup_opportunity.decision_brief.v1",
          "startup_opportunity.concept_evidence_report_view.v1",
          "startup_opportunity.concept_evidence_assessment.v2",
        ]),
      ];
    case "startup_opportunity.discovery_candidate.v1": {
      const subject = isRecord(document.subject) ? document.subject : {};
      const candidateKind = document.candidate_kind;
      return [
        ...optionalRef(
          document,
          "parent_candidate_ref",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...nestedRef(
          document,
          "map_lineage",
          "source_map_ref",
          candidateKind === "solution_seed"
            ? "startup_opportunity.solution_space_map.v1"
            : "startup_opportunity.opportunity_space_map.v1",
        ),
        ...(candidateKind === "baseline_seed" || candidateKind === "solution_seed"
          ? optionalRef(
              subject,
              "demand_candidate_ref",
              "startup_opportunity.discovery_candidate.v1",
            )
          : []),
        ...(candidateKind === "solution_seed"
          ? optionalRef(
              subject,
              "baseline_candidate_ref",
              "startup_opportunity.discovery_candidate.v1",
            )
          : []),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "evidence_refs",
          "startup_opportunity.evidence.v2",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "claim_refs",
          "startup_opportunity.claim.v2",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "finding_refs",
          "startup_opportunity.finding.v2",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "insight_refs",
          "startup_opportunity.insight.v2",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v2",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "source_manifest_refs",
          "startup_opportunity.source_manifest.v2",
        ),
        ...refsFromObjectArray(document, "evidence_lineage", "audit_refs", [
          "startup_opportunity.evidence_audit.v1",
          "startup_opportunity.adversarial_review.v1",
        ]),
        ...refsFromObjectArray(
          document,
          "source_partition",
          "generation_source_manifest_refs",
          "startup_opportunity.source_manifest.v2",
        ),
        ...refsFromObjectArray(
          document,
          "source_partition",
          "evaluation_source_manifest_refs",
          "startup_opportunity.source_manifest.v2",
        ),
        ...refsFromObjectArray(document, "enrichment", "basis_refs", [
          "startup_opportunity.opportunity_space_map.v1",
          "startup_opportunity.solution_space_map.v1",
          "startup_opportunity.evidence.v2",
          "startup_opportunity.claim.v2",
          "startup_opportunity.finding.v2",
          "startup_opportunity.insight.v2",
          "startup_opportunity.judgment_assessment.v2",
          "startup_opportunity.source_manifest.v2",
          "startup_opportunity.discovery_lane_result.v1",
          "startup_opportunity.decision.v1",
        ]),
      ];
    }
    case "startup_opportunity.research_task.v2":
      return [
        ...refsFromArray(
          document,
          "target_candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "supersedes_task_ref", "startup_opportunity.research_task.v2"),
      ];
    case "startup_opportunity.evidence.v2":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v2"),
        ...refsFromObjectArray(
          document,
          "lineage",
          "candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...nestedRef(document, "lineage", "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...nestedRef(
          document,
          "lineage",
          "research_plan_ref",
          "startup_opportunity.research_plan.v1",
        ),
        ...nestedRef(
          document,
          "mechanical_binding",
          "substrate_record_ref",
          "startup_opportunity.evidence_store_record.v2",
          "evidence_id",
        ),
      ];
    case "startup_opportunity.claim.v2":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v2"),
        ...refsFromObjectArray(
          document,
          "lineage",
          "candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...nestedRef(document, "lineage", "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...nestedRef(
          document,
          "lineage",
          "research_plan_ref",
          "startup_opportunity.research_plan.v1",
        ),
        ...refsFromArray(document, "evidence_refs", "startup_opportunity.evidence.v2"),
      ];
    case "startup_opportunity.finding.v2":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v2"),
        ...refsFromObjectArray(
          document,
          "lineage",
          "candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...nestedRef(document, "lineage", "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...nestedRef(
          document,
          "lineage",
          "research_plan_ref",
          "startup_opportunity.research_plan.v1",
        ),
        ...refsFromArray(document, "claim_refs", "startup_opportunity.claim.v2"),
        ...refsFromArray(document, "opposing_claim_refs", "startup_opportunity.claim.v2"),
      ];
    case "startup_opportunity.insight.v2":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v2"),
        ...refsFromObjectArray(
          document,
          "lineage",
          "candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...nestedRef(document, "lineage", "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...nestedRef(
          document,
          "lineage",
          "research_plan_ref",
          "startup_opportunity.research_plan.v1",
        ),
        ...refsFromArray(document, "finding_refs", "startup_opportunity.finding.v2"),
      ];
    case "startup_opportunity.source_manifest.v2":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v2"),
        ...refsFromObjectArray(
          document,
          "lineage",
          "candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...nestedRef(document, "lineage", "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...nestedRef(
          document,
          "lineage",
          "research_plan_ref",
          "startup_opportunity.research_plan.v1",
        ),
        ...refsFromArray(document, "accepted_evidence_refs", "startup_opportunity.evidence.v2"),
        ...refsFromNestedArray(
          document,
          "canonical_source_groups",
          "evidence_refs",
          "startup_opportunity.evidence.v2",
        ),
        ...refsFromNestedArray(
          document,
          "shared_dataset_groups",
          "evidence_refs",
          "startup_opportunity.evidence.v2",
        ),
        ...refsFromNestedArray(
          document,
          "duplicate_or_syndication_groups",
          "evidence_refs",
          "startup_opportunity.evidence.v2",
        ),
      ];
    case "startup_opportunity.judgment_assessment.v2":
      return [
        ...optionalRef(document, "subject_ref", "startup_opportunity.discovery_candidate.v1"),
        ...refsFromArray(document, "supporting_refs", [
          "startup_opportunity.evidence.v2",
          "startup_opportunity.claim.v2",
        ]),
        ...refsFromArray(document, "opposing_refs", [
          "startup_opportunity.evidence.v2",
          "startup_opportunity.claim.v2",
        ]),
      ];
    case "startup_opportunity.discovery_lane_result.v1":
      return [
        ...optionalRef(document, "task_ref", "startup_opportunity.research_task.v2"),
        ...refsFromNestedArray(
          document,
          "scored_candidates",
          "candidate_ref",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromNestedArray(
          document,
          "pre_kill_decisions",
          "candidate_ref",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromNestedArray(
          document,
          "pre_kill_decisions",
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v2",
        ),
        ...refsFromArray(
          document,
          "retained_candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromArray(
          document,
          "watchlist_candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromArray(
          document,
          "rejected_candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromObjectArray(
          document,
          "candidate_diversity_summary",
          "diversity_retention_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromObjectArray(
          document,
          "candidate_diversity_summary",
          "counterfactual_candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "evidence_refs",
          "startup_opportunity.evidence.v2",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "claim_refs",
          "startup_opportunity.claim.v2",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "finding_refs",
          "startup_opportunity.finding.v2",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "insight_refs",
          "startup_opportunity.insight.v2",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v2",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "source_manifest_refs",
          "startup_opportunity.source_manifest.v2",
        ),
      ];
    case "startup_opportunity.discovery_fan_in.v1":
    case "startup_opportunity.discovery_fan_in.v2":
      return [
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...refsFromObjectArray(
          document,
          "lane_result_classification",
          "completed_refs",
          "startup_opportunity.discovery_lane_result.v1",
        ),
        ...refsFromObjectArray(
          document,
          "lane_result_classification",
          "partial_refs",
          "startup_opportunity.discovery_lane_result.v1",
        ),
        ...refsFromObjectArray(
          document,
          "lane_result_classification",
          "insufficient_evidence_refs",
          "startup_opportunity.discovery_lane_result.v1",
        ),
        ...refsFromObjectArray(
          document,
          "lane_result_classification",
          "failed_refs",
          "startup_opportunity.discovery_lane_result.v1",
        ),
        ...refsFromObjectArray(
          document,
          "lane_result_classification",
          "ignored_late_refs",
          "startup_opportunity.discovery_lane_result.v1",
        ),
        ...refsFromObjectArray(
          document,
          "lane_result_classification",
          "superseded_refs",
          "startup_opportunity.discovery_lane_result.v1",
        ),
        ...refsFromNestedArray(
          document,
          "candidate_dispositions",
          "candidate_ref",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromNestedArray(
          document,
          "candidate_dispositions",
          "source_candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromNestedArray(
          document,
          "candidate_dispositions",
          "supporting_lane_result_refs",
          "startup_opportunity.discovery_lane_result.v1",
        ),
        ...refsFromNestedArray(
          document,
          "candidate_dispositions",
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v2",
        ),
        ...refsFromArray(
          document,
          "retained_candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromArray(
          document,
          "watchlist_candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromArray(
          document,
          "rejected_candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v2",
        ),
        ...refsFromObjectArray(
          document,
          "candidate_diversity_summary",
          "diversity_retention_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromObjectArray(
          document,
          "candidate_diversity_summary",
          "counterfactual_candidate_refs",
          "startup_opportunity.discovery_candidate.v1",
        ),
      ];
    case "startup_opportunity.discovery_candidate_conversion.v1":
      return [
        ...optionalRef(
          document,
          "parent_conversion_ref",
          "startup_opportunity.discovery_candidate_conversion.v1",
        ),
        ...optionalRef(
          document,
          "source_candidate_ref",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...optionalRef(document, "discovery_fan_in_ref", [
          "startup_opportunity.discovery_fan_in.v1",
          "startup_opportunity.discovery_fan_in.v2",
        ]),
      ];
    case "startup_opportunity.discovery_candidate_conversion.v2":
      return [
        ...optionalRef(
          document,
          "parent_conversion_ref",
          "startup_opportunity.discovery_candidate_conversion.v2",
        ),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(
          document,
          "source_candidate_ref",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...optionalRef(document, "discovery_fan_in_ref", "startup_opportunity.discovery_fan_in.v2"),
        ...optionalRef(document, "target_artifact_ref", [
          "startup_opportunity.demand_thesis.v1",
          "startup_opportunity.baseline_option.v1",
          "startup_opportunity.solution_hypothesis.v1",
        ]),
      ];
    case "startup_opportunity.demand_thesis.v1":
      return [
        ...optionalRef(document, "parent_demand_ref", "startup_opportunity.demand_thesis.v1"),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "discovery_fan_in_ref", "startup_opportunity.discovery_fan_in.v2"),
        ...optionalRef(
          document,
          "source_conversion_ref",
          "startup_opportunity.discovery_candidate_conversion.v2",
        ),
        ...optionalRef(
          document,
          "source_candidate_ref",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...refsFromObjectArray(
          document,
          "source_groups",
          "generation_source_manifest_refs",
          "startup_opportunity.source_manifest.v2",
        ),
        ...refsFromObjectArray(
          document,
          "source_groups",
          "evaluation_source_manifest_refs",
          "startup_opportunity.source_manifest.v2",
        ),
        ...refsFromArray(document, "supporting_claim_refs", "startup_opportunity.claim.v2"),
        ...refsFromArray(document, "opposing_claim_refs", "startup_opportunity.claim.v2"),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v2",
        ),
      ];
    case "startup_opportunity.baseline_option.v1":
      return [
        ...optionalRef(document, "parent_baseline_ref", "startup_opportunity.baseline_option.v1"),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "discovery_fan_in_ref", "startup_opportunity.discovery_fan_in.v2"),
        ...optionalRef(
          document,
          "source_conversion_ref",
          "startup_opportunity.discovery_candidate_conversion.v2",
        ),
        ...optionalRef(
          document,
          "source_candidate_ref",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...optionalRef(document, "demand_thesis_ref", "startup_opportunity.demand_thesis.v1"),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v2",
        ),
      ];
    case "startup_opportunity.solution_hypothesis.v1":
      return [
        ...optionalRef(
          document,
          "parent_solution_ref",
          "startup_opportunity.solution_hypothesis.v1",
        ),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "discovery_fan_in_ref", "startup_opportunity.discovery_fan_in.v2"),
        ...optionalRef(
          document,
          "source_conversion_ref",
          "startup_opportunity.discovery_candidate_conversion.v2",
        ),
        ...optionalRef(
          document,
          "source_candidate_ref",
          "startup_opportunity.discovery_candidate.v1",
        ),
        ...optionalRef(document, "demand_thesis_ref", "startup_opportunity.demand_thesis.v1"),
        ...optionalRef(document, "baseline_option_ref", "startup_opportunity.baseline_option.v1"),
        ...refsFromArray(document, "supporting_claim_refs", "startup_opportunity.claim.v2"),
        ...refsFromArray(document, "opposing_claim_refs", "startup_opportunity.claim.v2"),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v2",
        ),
      ];
    case "startup_opportunity.solution_evaluation.v1":
      return [
        ...optionalRef(
          document,
          "parent_evaluation_ref",
          "startup_opportunity.solution_evaluation.v1",
        ),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "discovery_fan_in_ref", "startup_opportunity.discovery_fan_in.v2"),
        ...optionalRef(document, "demand_thesis_ref", "startup_opportunity.demand_thesis.v1"),
        ...optionalRef(document, "baseline_option_ref", "startup_opportunity.baseline_option.v1"),
        ...optionalRef(
          document,
          "selected_solution_ref",
          "startup_opportunity.solution_hypothesis.v1",
        ),
        ...refsFromArray(
          document,
          "solution_hypothesis_refs",
          "startup_opportunity.solution_hypothesis.v1",
        ),
        ...refsFromArray(
          document,
          "alternative_solution_refs",
          "startup_opportunity.solution_hypothesis.v1",
        ),
        ...refsFromNestedArray(
          document,
          "rejected_solutions",
          "solution_ref",
          "startup_opportunity.solution_hypothesis.v1",
        ),
        ...refsFromNestedArray(
          document,
          "rejected_solutions",
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v2",
        ),
        ...refsFromObjectArray(
          document,
          "source_groups",
          "generation_source_manifest_refs",
          "startup_opportunity.source_manifest.v2",
        ),
        ...refsFromObjectArray(
          document,
          "source_groups",
          "evaluation_source_manifest_refs",
          "startup_opportunity.source_manifest.v2",
        ),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v2",
        ),
      ];
    case "startup_opportunity.opportunity_thesis.v1":
      return [
        ...optionalRef(
          document,
          "parent_opportunity_ref",
          "startup_opportunity.opportunity_thesis.v1",
        ),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "discovery_fan_in_ref", "startup_opportunity.discovery_fan_in.v2"),
        ...optionalRef(document, "demand_thesis_ref", "startup_opportunity.demand_thesis.v1"),
        ...optionalRef(
          document,
          "selected_solution_ref",
          "startup_opportunity.solution_hypothesis.v1",
        ),
        ...refsFromArray(
          document,
          "alternative_solution_refs",
          "startup_opportunity.solution_hypothesis.v1",
        ),
        ...optionalRef(document, "baseline_option_ref", "startup_opportunity.baseline_option.v1"),
        ...optionalRef(
          document,
          "solution_evaluation_ref",
          "startup_opportunity.solution_evaluation.v1",
        ),
        ...refsFromArray(document, "source_lanes", "startup_opportunity.discovery_lane_result.v1"),
        ...refsFromArray(document, "supporting_insight_refs", "startup_opportunity.insight.v2"),
        ...refsFromArray(document, "opposing_claim_refs", "startup_opportunity.claim.v2"),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v2",
        ),
        ...refsFromObjectArray(
          document,
          "mental_position_occupation",
          "evidence_refs",
          "startup_opportunity.evidence.v2",
        ),
      ];
    case "startup_opportunity.thesis_evaluation_snapshot.v1":
      return [
        ...optionalRef(
          document,
          "parent_snapshot_ref",
          "startup_opportunity.thesis_evaluation_snapshot.v1",
        ),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...refsFromArray(document, "subject_refs", "startup_opportunity.opportunity_thesis.v1"),
        ...refsFromArray(document, "demand_thesis_refs", "startup_opportunity.demand_thesis.v1"),
        ...refsFromArray(
          document,
          "solution_hypothesis_refs",
          "startup_opportunity.solution_hypothesis.v1",
        ),
        ...refsFromArray(
          document,
          "baseline_option_refs",
          "startup_opportunity.baseline_option.v1",
        ),
        ...refsFromArray(
          document,
          "solution_evaluation_refs",
          "startup_opportunity.solution_evaluation.v1",
        ),
        ...refsFromArray(
          document,
          "generation_source_groups",
          "startup_opportunity.source_manifest.v2",
        ),
        ...refsFromArray(
          document,
          "evaluation_source_groups",
          "startup_opportunity.source_manifest.v2",
        ),
      ];
    case "startup_opportunity.merge.v1":
      return [
        ...optionalRef(document, "parent_merge_ref", "startup_opportunity.merge.v1"),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(
          document,
          "source_snapshot_ref",
          "startup_opportunity.thesis_evaluation_snapshot.v1",
        ),
        ...refsFromArray(
          document,
          "source_thesis_refs",
          "startup_opportunity.opportunity_thesis.v1",
        ),
      ];
    case "startup_opportunity.research_task.v3":
      return [
        ...refsFromArray(
          document,
          "target_opportunity_refs",
          "startup_opportunity.opportunity_thesis.v1",
        ),
        ...optionalRef(
          document,
          "source_snapshot_ref",
          "startup_opportunity.thesis_evaluation_snapshot.v1",
        ),
        ...optionalRef(document, "source_merge_ref", "startup_opportunity.merge.v1"),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...refsFromArray(document, "input_refs", [
          "startup_opportunity.opportunity_thesis.v1",
          "startup_opportunity.thesis_evaluation_snapshot.v1",
          "startup_opportunity.merge.v1",
          "startup_opportunity.scope_frame.v2",
          "startup_opportunity.research_plan.v1",
        ]),
        ...optionalRef(document, "supersedes_task_ref", "startup_opportunity.research_task.v3"),
      ];
    case "startup_opportunity.evidence.v3":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v3"),
        ...refsFromObjectArray(
          document,
          "lineage",
          "opportunity_refs",
          "startup_opportunity.opportunity_thesis.v1",
        ),
        ...nestedRef(
          document,
          "lineage",
          "source_snapshot_ref",
          "startup_opportunity.thesis_evaluation_snapshot.v1",
        ),
        ...nestedRef(document, "lineage", "source_merge_ref", "startup_opportunity.merge.v1"),
        ...nestedRef(document, "lineage", "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...nestedRef(
          document,
          "lineage",
          "research_plan_ref",
          "startup_opportunity.research_plan.v1",
        ),
        ...nestedRef(
          document,
          "mechanical_binding",
          "substrate_record_ref",
          "startup_opportunity.evidence_store_record.v2",
          "evidence_id",
        ),
      ];
    case "startup_opportunity.claim.v3":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v3"),
        ...refsFromObjectArray(
          document,
          "lineage",
          "opportunity_refs",
          "startup_opportunity.opportunity_thesis.v1",
        ),
        ...refsFromArray(document, "evidence_refs", "startup_opportunity.evidence.v3"),
      ];
    case "startup_opportunity.finding.v3":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v3"),
        ...refsFromObjectArray(
          document,
          "lineage",
          "opportunity_refs",
          "startup_opportunity.opportunity_thesis.v1",
        ),
        ...refsFromArray(document, "claim_refs", "startup_opportunity.claim.v3"),
        ...refsFromArray(document, "opposing_claim_refs", "startup_opportunity.claim.v3"),
      ];
    case "startup_opportunity.insight.v3":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v3"),
        ...refsFromObjectArray(
          document,
          "lineage",
          "opportunity_refs",
          "startup_opportunity.opportunity_thesis.v1",
        ),
        ...refsFromArray(document, "finding_refs", "startup_opportunity.finding.v3"),
      ];
    case "startup_opportunity.judgment_assessment.v3":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v3"),
        ...refsFromObjectArray(
          document,
          "lineage",
          "opportunity_refs",
          "startup_opportunity.opportunity_thesis.v1",
        ),
        ...optionalRef(document, "subject_ref", "startup_opportunity.opportunity_thesis.v1"),
        ...refsFromArray(document, "supporting_refs", [
          "startup_opportunity.evidence.v3",
          "startup_opportunity.claim.v3",
        ]),
        ...refsFromArray(document, "opposing_refs", [
          "startup_opportunity.evidence.v3",
          "startup_opportunity.claim.v3",
        ]),
      ];
    case "startup_opportunity.source_manifest.v3":
      return [
        ...nestedRef(document, "lineage", "task_ref", "startup_opportunity.research_task.v3"),
        ...refsFromObjectArray(
          document,
          "lineage",
          "opportunity_refs",
          "startup_opportunity.opportunity_thesis.v1",
        ),
        ...refsFromArray(document, "accepted_evidence_refs", "startup_opportunity.evidence.v3"),
        ...refsFromNestedArray(
          document,
          "canonical_source_groups",
          "evidence_refs",
          "startup_opportunity.evidence.v3",
        ),
      ];
    case "startup_opportunity.enrichment_branch_result.v1":
      return [
        ...optionalRef(document, "task_ref", "startup_opportunity.research_task.v3"),
        ...optionalRef(
          document,
          "source_snapshot_ref",
          "startup_opportunity.thesis_evaluation_snapshot.v1",
        ),
        ...optionalRef(document, "source_merge_ref", "startup_opportunity.merge.v1"),
        ...refsFromArray(document, "opportunity_refs", "startup_opportunity.opportunity_thesis.v1"),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "evidence_refs",
          "startup_opportunity.evidence.v3",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "claim_refs",
          "startup_opportunity.claim.v3",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "finding_refs",
          "startup_opportunity.finding.v3",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "insight_refs",
          "startup_opportunity.insight.v3",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v3",
        ),
        ...refsFromObjectArray(
          document,
          "evidence_lineage",
          "source_manifest_refs",
          "startup_opportunity.source_manifest.v3",
        ),
        ...refsFromNestedArray(
          document,
          "hard_gate_inputs",
          "opportunity_ref",
          "startup_opportunity.opportunity_thesis.v1",
        ),
        ...refsFromNestedArray(
          document,
          "hard_gate_inputs",
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v3",
        ),
      ];
    case "startup_opportunity.enrichment_fan_in.v1":
      return [
        ...optionalRef(document, "parent_fan_in_ref", "startup_opportunity.enrichment_fan_in.v1"),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(
          document,
          "source_snapshot_ref",
          "startup_opportunity.thesis_evaluation_snapshot.v1",
        ),
        ...optionalRef(document, "source_merge_ref", "startup_opportunity.merge.v1"),
        ...refsFromArray(document, "opportunity_refs", "startup_opportunity.opportunity_thesis.v1"),
        ...refsFromObjectArray(
          document,
          "branch_result_classification",
          "completed_refs",
          "startup_opportunity.enrichment_branch_result.v1",
        ),
        ...refsFromObjectArray(
          document,
          "branch_result_classification",
          "partial_refs",
          "startup_opportunity.enrichment_branch_result.v1",
        ),
        ...refsFromObjectArray(
          document,
          "branch_result_classification",
          "insufficient_evidence_refs",
          "startup_opportunity.enrichment_branch_result.v1",
        ),
        ...refsFromObjectArray(
          document,
          "branch_result_classification",
          "failed_refs",
          "startup_opportunity.enrichment_branch_result.v1",
        ),
        ...refsFromObjectArray(
          document,
          "branch_result_classification",
          "ignored_late_refs",
          "startup_opportunity.enrichment_branch_result.v1",
        ),
        ...refsFromObjectArray(
          document,
          "branch_result_classification",
          "superseded_refs",
          "startup_opportunity.enrichment_branch_result.v1",
        ),
        ...refsFromArray(
          document,
          "eligible_branch_refs",
          "startup_opportunity.enrichment_branch_result.v1",
        ),
        ...refsFromArray(document, "evidence_refs", "startup_opportunity.evidence.v3"),
        ...refsFromArray(document, "claim_refs", "startup_opportunity.claim.v3"),
        ...refsFromArray(document, "finding_refs", "startup_opportunity.finding.v3"),
        ...refsFromArray(document, "insight_refs", "startup_opportunity.insight.v3"),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v3",
        ),
        ...refsFromArray(
          document,
          "source_manifest_refs",
          "startup_opportunity.source_manifest.v3",
        ),
        ...refsFromNestedArray(
          document,
          "hard_gate_inputs",
          "opportunity_ref",
          "startup_opportunity.opportunity_thesis.v1",
        ),
        ...refsFromNestedArray(
          document,
          "hard_gate_inputs",
          "source_branch_refs",
          "startup_opportunity.enrichment_branch_result.v1",
        ),
        ...refsFromNestedArray(
          document,
          "hard_gate_inputs",
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v3",
        ),
      ];
    case "startup_opportunity.value_layer_analysis.v1":
    case "startup_opportunity.user_state_context_model.v1":
    case "startup_opportunity.buyer_purchase_language.v1":
      return [
        ...optionalRef(document, "opportunity_ref", "startup_opportunity.opportunity_thesis.v1"),
        ...optionalRef(
          document,
          "source_snapshot_ref",
          "startup_opportunity.thesis_evaluation_snapshot.v1",
        ),
        ...optionalRef(
          document,
          "enrichment_fan_in_ref",
          "startup_opportunity.enrichment_fan_in.v1",
        ),
        ...refsFromArray(document, "supporting_claim_refs", "startup_opportunity.claim.v3"),
        ...refsFromArray(document, "opposing_claim_refs", "startup_opportunity.claim.v3"),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v3",
        ),
      ];
    case "startup_opportunity.business_engine_thesis.v2":
      return [
        ...optionalRef(document, "subject_ref", "startup_opportunity.opportunity_thesis.v1"),
        ...optionalRef(
          document,
          "source_snapshot_ref",
          "startup_opportunity.thesis_evaluation_snapshot.v1",
        ),
        ...optionalRef(
          document,
          "enrichment_fan_in_ref",
          "startup_opportunity.enrichment_fan_in.v1",
        ),
        ...refsFromArray(document, "supporting_claim_refs", "startup_opportunity.claim.v3"),
        ...refsFromArray(document, "opposing_claim_refs", "startup_opportunity.claim.v3"),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v3",
        ),
      ];
    case "startup_opportunity.opportunity_comparison.v1":
      return [
        ...optionalRef(
          document,
          "parent_comparison_ref",
          "startup_opportunity.opportunity_comparison.v1",
        ),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(
          document,
          "source_snapshot_ref",
          "startup_opportunity.thesis_evaluation_snapshot.v1",
        ),
        ...optionalRef(document, "source_merge_ref", "startup_opportunity.merge.v1"),
        ...optionalRef(
          document,
          "enrichment_fan_in_ref",
          "startup_opportunity.enrichment_fan_in.v1",
        ),
        ...optionalRef(document, "opportunity_ref", "startup_opportunity.opportunity_thesis.v1"),
        ...optionalRef(
          document,
          "value_layer_analysis_ref",
          "startup_opportunity.value_layer_analysis.v1",
        ),
        ...optionalRef(
          document,
          "user_state_context_model_ref",
          "startup_opportunity.user_state_context_model.v1",
        ),
        ...optionalRef(
          document,
          "buyer_purchase_language_ref",
          "startup_opportunity.buyer_purchase_language.v1",
        ),
        ...optionalRef(
          document,
          "business_engine_ref",
          "startup_opportunity.business_engine_thesis.v2",
        ),
        ...refsFromNestedArray(
          document,
          "hard_gate_results",
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v3",
        ),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v3",
        ),
      ];
    case "startup_opportunity.sensitivity.v1":
      return [
        ...optionalRef(
          document,
          "source_snapshot_ref",
          "startup_opportunity.thesis_evaluation_snapshot.v1",
        ),
        ...refsFromArray(
          document,
          "comparison_refs",
          "startup_opportunity.opportunity_comparison.v1",
        ),
      ];
    case "startup_opportunity.portfolio_view.v1":
      return [
        ...optionalRef(document, "sensitivity_ref", "startup_opportunity.sensitivity.v1"),
        ...refsFromArray(
          document,
          "comparison_refs",
          "startup_opportunity.opportunity_comparison.v1",
        ),
      ];
    case "startup_opportunity.decision_recommendation.v1":
      return [
        ...optionalRef(document, "decision_context_ref", "startup_opportunity.decision_context.v1"),
        ...optionalRef(
          document,
          "source_snapshot_ref",
          "startup_opportunity.thesis_evaluation_snapshot.v1",
        ),
        ...refsFromArray(
          document,
          "comparison_refs",
          "startup_opportunity.opportunity_comparison.v1",
        ),
        ...optionalRef(document, "sensitivity_ref", "startup_opportunity.sensitivity.v1"),
        ...refsFromArray(
          document,
          "decisive_judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v3",
        ),
        ...refsFromArray(
          document,
          "business_engine_refs",
          "startup_opportunity.business_engine_thesis.v2",
        ),
        ...optionalRef(document, "portfolio_view_ref", "startup_opportunity.portfolio_view.v1"),
      ];
    case "startup_opportunity.traceability.v2":
      return [
        ...optionalRef(
          document,
          "source_snapshot_ref",
          "startup_opportunity.thesis_evaluation_snapshot.v1",
        ),
        ...optionalRef(
          document,
          "decision_recommendation_ref",
          "startup_opportunity.decision_recommendation.v1",
        ),
        ...refsFromArray(
          document,
          "comparison_refs",
          "startup_opportunity.opportunity_comparison.v1",
        ),
        ...optionalRef(
          document,
          "enrichment_fan_in_ref",
          "startup_opportunity.enrichment_fan_in.v1",
        ),
        ...refsFromArray(
          document,
          "decisive_judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v3",
        ),
        ...refsFromNestedArray(
          document,
          "statements",
          "judgment_assessment_ref",
          "startup_opportunity.judgment_assessment.v3",
        ),
        ...refsFromNestedArray(
          document,
          "statements",
          "claim_refs",
          "startup_opportunity.claim.v3",
        ),
        ...refsFromNestedArray(
          document,
          "statements",
          "evidence_refs",
          "startup_opportunity.evidence.v3",
        ),
        ...refsFromNestedArray(
          document,
          "statements",
          "source_manifest_refs",
          "startup_opportunity.source_manifest.v3",
        ),
      ];
    case "startup_opportunity.report.v1":
      return [
        ...optionalRef(document, "decision_context_ref", "startup_opportunity.decision_context.v1"),
        ...optionalRef(document, "scope_frame_ref", "startup_opportunity.scope_frame.v2"),
        ...optionalRef(document, "research_plan_ref", "startup_opportunity.research_plan.v1"),
        ...refsFromArray(document, "plan_lineage_refs", "startup_opportunity.research_plan.v1"),
        ...refsFromArray(document, "applied_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
          "startup_opportunity.adaptation_decision.v3",
        ]),
        ...optionalRef(
          document,
          "decision_recommendation_ref",
          "startup_opportunity.decision_recommendation.v1",
        ),
        ...optionalRef(document, "portfolio_view_ref", "startup_opportunity.portfolio_view.v1"),
        ...refsFromArray(
          document,
          "comparison_refs",
          "startup_opportunity.opportunity_comparison.v1",
        ),
        ...refsFromArray(
          document,
          "business_engine_refs",
          "startup_opportunity.business_engine_thesis.v2",
        ),
        ...refsFromArray(
          document,
          "top_opportunity_refs",
          "startup_opportunity.opportunity_thesis.v1",
        ),
        ...refsFromArray(document, "watchlist_refs", "startup_opportunity.opportunity_thesis.v1"),
        ...refsFromArray(
          document,
          "rejected_opportunity_refs",
          "startup_opportunity.opportunity_thesis.v1",
        ),
        ...optionalRef(document, "sensitivity_ref", "startup_opportunity.sensitivity.v1"),
        ...refsFromArray(
          document,
          "judgment_assessment_refs",
          "startup_opportunity.judgment_assessment.v3",
        ),
        ...refsFromArray(
          document,
          "source_manifest_refs",
          "startup_opportunity.source_manifest.v3",
        ),
        ...optionalRef(document, "traceability_ref", "startup_opportunity.traceability.v2"),
      ];
    case "startup_opportunity.decision_brief.v2":
    case "startup_opportunity.discovery_report_view.v1":
      return [
        ...optionalRef(document, "report_ref", "startup_opportunity.report.v1"),
        ...optionalRef(
          document,
          "decision_recommendation_ref",
          "startup_opportunity.decision_recommendation.v1",
        ),
        ...refsFromArray(document, "alternative_bets", "startup_opportunity.opportunity_thesis.v1"),
        ...optionalRef(
          document,
          "recommended_first_bet",
          "startup_opportunity.opportunity_thesis.v1",
        ),
        ...refsFromArray(document, "decisive_supporting_refs", [
          "startup_opportunity.evidence.v3",
          "startup_opportunity.claim.v3",
          "startup_opportunity.finding.v3",
          "startup_opportunity.insight.v3",
          "startup_opportunity.judgment_assessment.v3",
        ]),
        ...refsFromArray(document, "decisive_opposing_refs", [
          "startup_opportunity.evidence.v3",
          "startup_opportunity.claim.v3",
          "startup_opportunity.finding.v3",
          "startup_opportunity.insight.v3",
          "startup_opportunity.judgment_assessment.v3",
        ]),
      ];
    case "startup_opportunity.report_consistency_evaluation.v2":
    case "startup_opportunity.report_consistency_evaluation.v3":
      return [
        ...optionalRef(document, "report_ref", "startup_opportunity.report.v1"),
        ...optionalRef(document, "decision_brief_ref", "startup_opportunity.decision_brief.v2"),
        ...optionalRef(document, "report_view_ref", "startup_opportunity.discovery_report_view.v1"),
        ...optionalRef(
          document,
          "decision_recommendation_ref",
          "startup_opportunity.decision_recommendation.v1",
        ),
        ...optionalRef(document, "traceability_ref", "startup_opportunity.traceability.v2"),
      ];
    default:
      return [];
  }
}

function unwrapDocument(entry: DocumentBundleEntry): EffectiveDocument {
  const version = schemaVersionOf(entry.document) ?? "";
  if (
    version !== "startup_opportunity.artifact_envelope.v1" &&
    version !== "startup_opportunity.artifact_envelope.v2" &&
    version !== "startup_opportunity.artifact_envelope.v3" &&
    version !== "startup_opportunity.artifact_envelope.v4" &&
    version !== "startup_opportunity.artifact_envelope.v5" &&
    version !== "startup_opportunity.artifact_envelope.v6" &&
    version !== "startup_opportunity.artifact_envelope.v7" &&
    version !== "startup_opportunity.artifact_envelope.v8" &&
    version !== "startup_opportunity.artifact_envelope.v9" &&
    version !== "startup_opportunity.artifact_envelope.v10" &&
    version !== "startup_opportunity.artifact_envelope.v11" &&
    version !== "startup_opportunity.artifact_envelope.v12" &&
    version !== "startup_opportunity.artifact_envelope.v13"
  ) {
    return { path: entry.path, schemaVersion: version, document: entry.document, envelope: null };
  }
  const artifactType = entry.document.artifact_type;
  const nestedDocument = entry.document.document;
  return {
    path: entry.path,
    schemaVersion: typeof artifactType === "string" ? artifactType : "",
    document: isRecord(nestedDocument) ? nestedDocument : {},
    envelope: entry.document,
  };
}

function fragmentIdExists(
  target: EffectiveDocument,
  fragment: string,
  expectedIdField: string,
): boolean {
  if (target.document[expectedIdField] === fragment) {
    return true;
  }
  if (expectedIdField === "gap_id") {
    const gaps = target.document.gaps;
    return (
      Array.isArray(gaps) && gaps.some((gap) => isRecord(gap) && gap[expectedIdField] === fragment)
    );
  }
  if (expectedIdField === "unit_id") {
    const waves = target.document.waves;
    return (
      Array.isArray(waves) &&
      waves.some(
        (wave) =>
          isRecord(wave) &&
          Array.isArray(wave.units) &&
          wave.units.some((unit) => isRecord(unit) && unit[expectedIdField] === fragment),
      )
    );
  }
  return false;
}

function planRevisionFromPath(value: string): number | null {
  const match = value.match(/^plans\/research-plan\.r([1-9][0-9]*)\.json$/);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

function snapshotRevisionFromPath(value: string): number | null {
  const match = value.match(
    /^adaptations\/gap-snapshots\/[A-Za-z0-9][A-Za-z0-9._-]*\.r([1-9][0-9]*)\.json$/,
  );
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

function planningContextRevisionFromPath(value: string): number | null {
  const match = value.match(/^plans\/planning-context\.r([1-9][0-9]*)\.json$/);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

function targetByRef(
  documentsByPath: ReadonlyMap<string, EffectiveDocument>,
  ref: unknown,
): EffectiveDocument | null {
  if (typeof ref !== "string") {
    return null;
  }
  return documentsByPath.get(ref.split("#", 1)[0] ?? "") ?? null;
}

function exactJsonlTarget(
  requirement: ReferenceRequirement,
  targetPath: string,
  fragment: string | undefined,
  context: DocumentBundleReferenceContext,
): EffectiveDocument | null {
  if (fragment === undefined) {
    return null;
  }
  const document = context.exactJsonlRecords?.get(requirement.ref);
  if (document === undefined) {
    return null;
  }
  return {
    path: targetPath,
    schemaVersion: schemaVersionOf(document) ?? "",
    document,
    envelope: null,
  };
}

function recordById(
  document: Record<string, unknown>,
  collection: "gaps" | "units",
  idField: "gap_id" | "unit_id",
  id: string,
): Record<string, unknown> | null {
  if (collection === "gaps") {
    const gaps = document.gaps;
    if (!Array.isArray(gaps)) {
      return null;
    }
    return (
      (gaps.find((gap) => isRecord(gap) && gap[idField] === id) as
        | Record<string, unknown>
        | undefined) ?? null
    );
  }

  const waves = document.waves;
  if (!Array.isArray(waves)) {
    return null;
  }
  for (const wave of waves) {
    if (!isRecord(wave) || !Array.isArray(wave.units)) {
      continue;
    }
    const unit = wave.units.find((candidate) => isRecord(candidate) && candidate[idField] === id);
    if (isRecord(unit)) {
      return unit;
    }
  }
  return null;
}

function validateResearchEnvelopeContract(document: unknown): readonly ValidationIssue[] {
  if (
    !isRecord(document) ||
    (document.schema_version !== "startup_opportunity.artifact_envelope.v4" &&
      document.schema_version !== "startup_opportunity.artifact_envelope.v5" &&
      document.schema_version !== "startup_opportunity.artifact_envelope.v6" &&
      document.schema_version !== "startup_opportunity.artifact_envelope.v7" &&
      document.schema_version !== "startup_opportunity.artifact_envelope.v8" &&
      document.schema_version !== "startup_opportunity.artifact_envelope.v9" &&
      document.schema_version !== "startup_opportunity.artifact_envelope.v10" &&
      document.schema_version !== "startup_opportunity.artifact_envelope.v11" &&
      document.schema_version !== "startup_opportunity.artifact_envelope.v12" &&
      document.schema_version !== "startup_opportunity.artifact_envelope.v13") ||
    !isRecord(document.document)
  ) {
    return [];
  }
  const errors: ValidationIssue[] = [];
  if (document.run_id !== document.document.run_id) {
    errors.push({
      code: "reference.envelope_run_mismatch",
      keyword: "run_id",
      instancePath: "/run_id",
      schemaPath: "",
      message: "research envelope and document run_id differ",
      details: {
        documentRunId: document.document.run_id,
        envelopeRunId: document.run_id,
      },
    });
  }
  const expectedHash = canonicalContentHash(document.document);
  if (document.content_hash !== expectedHash) {
    errors.push({
      code: "artifact.content_hash_mismatch",
      keyword: "content_hash",
      instancePath: "/content_hash",
      schemaPath: "",
      message: "research envelope content_hash differs from its canonical document hash",
      details: { actual: document.content_hash, expected: expectedHash },
    });
  }
  const surface =
    document.artifact_type === "startup_opportunity.report.v1" &&
    document.document.schema_version === "startup_opportunity.report.v1"
      ? "structured_report"
      : document.schema_version === "startup_opportunity.artifact_envelope.v13" &&
          document.artifact_type === "startup_opportunity.decision_brief.v2"
        ? "decision_brief"
        : document.schema_version === "startup_opportunity.artifact_envelope.v13" &&
            document.artifact_type === "startup_opportunity.discovery_report_view.v1"
          ? "report_view"
          : null;
  if (surface !== null) {
    const scanValue =
      surface === "structured_report" ? document.document : document.document.markdown;
    const forbiddenMatches = scanReportSurface(surface, scanValue);
    if (forbiddenMatches.length > 0) {
      errors.push({
        code: "g2_4.forbidden_report_expression",
        keyword: "report_consistency",
        instancePath: surface === "structured_report" ? "/document" : "/document/markdown",
        schemaPath: "",
        message:
          "formal discovery report surface contains forbidden validation, probability, or score language",
        details: { forbiddenMatches },
      });
    }
  }
  return sortIssues(errors);
}

export class ArtifactValidator {
  constructor(
    private readonly bundle: LoadedSchemaBundle,
    readonly publicationPolicy: PublicationPolicy,
    readonly assessmentReportingPolicy: AssessmentReportingPolicy,
    readonly discoveryMapsPolicy: LoadedDiscoveryMapsPolicy,
    readonly discoveryCandidatePolicy: DiscoveryCandidatePolicy,
    readonly discoverySynthesisPolicy: DiscoverySynthesisPolicy,
    readonly discoveryEvaluationPolicy: DiscoveryEvaluationPolicy,
    readonly legacyDiscoveryEvaluationPolicy: DiscoveryEvaluationPolicy,
  ) {}

  publicationAdapter(schemaVersion: unknown): StorePublicationAdapter {
    return this.publicationPolicy.adapterForEnvelope(schemaVersion);
  }

  validateDocument(
    document: unknown,
    documentPath: string | null = null,
  ): ArtifactValidationResult {
    const artifactSchemaVersion = schemaVersionOf(document);
    if (artifactSchemaVersion === null) {
      return {
        schemaVersion: ARTIFACT_VALIDATION_RESULT_VERSION,
        schemaBundleVersion: this.bundle.version,
        valid: false,
        documentPath,
        artifactSchemaVersion: null,
        errors: [
          {
            code: "schema.missing_version",
            keyword: "required",
            instancePath: "",
            schemaPath: "",
            message: "schema_version is required",
            details: { missingProperty: "schema_version" },
          },
        ],
      };
    }

    const validator = this.bundle.validators.get(artifactSchemaVersion);
    if (!validator) {
      return {
        schemaVersion: ARTIFACT_VALIDATION_RESULT_VERSION,
        schemaBundleVersion: this.bundle.version,
        valid: false,
        documentPath,
        artifactSchemaVersion,
        errors: [
          {
            code: "schema.unknown_version",
            keyword: "schema_version",
            instancePath: "/schema_version",
            schemaPath: "",
            message: "schema_version is not published in this bundle",
            details: { schemaVersion: artifactSchemaVersion },
          },
        ],
      };
    }

    const valid = validator(document);
    const errors = valid
      ? validateResearchEnvelopeContract(document)
      : normalizeAjvErrors(validator.errors);
    return {
      schemaVersion: ARTIFACT_VALIDATION_RESULT_VERSION,
      schemaBundleVersion: this.bundle.version,
      valid: errors.length === 0,
      documentPath,
      artifactSchemaVersion,
      errors,
    };
  }

  validateDocumentBundle(
    value: unknown,
    referenceContext: DocumentBundleReferenceContext = {},
  ): DocumentBundleValidationResult {
    const bundleResult = this.validateDocument(value);
    if (!bundleResult.valid || !isRecord(value) || !Array.isArray(value.documents)) {
      return {
        schemaVersion: DOCUMENT_BUNDLE_VALIDATION_RESULT_VERSION,
        schemaBundleVersion: this.bundle.version,
        valid: false,
        bundleErrors: bundleResult.errors,
        documents: [],
        referenceErrors: [],
      };
    }

    const input = value as unknown as DocumentBundle;
    const exactJsonlRecords = new Map(referenceContext.exactJsonlRecords ?? []);
    const exactRecordErrors: ValidationIssue[] = [];
    for (const [index, record] of (input.exact_records ?? []).entries()) {
      if (exactJsonlRecords.has(record.ref)) {
        exactRecordErrors.push(
          referenceIssue(
            "reference.duplicate_exact_record",
            `/exact_records/${index}/ref`,
            "exact record ref is duplicated",
            { ref: record.ref },
          ),
        );
      } else {
        exactJsonlRecords.set(record.ref, record.document);
      }
      const fragment = record.ref.split("#", 2)[1];
      const id =
        record.document.event_id ?? record.document.decision_id ?? record.document.evidence_id;
      if (fragment === undefined || fragment !== id) {
        exactRecordErrors.push(
          referenceIssue(
            "reference.exact_record_identity_mismatch",
            `/exact_records/${index}/ref`,
            "exact record fragment differs from the record identity",
            { ref: record.ref, id },
          ),
        );
      }
    }
    const documents = input.documents.map((entry) =>
      this.validateDocument(entry.document, entry.path),
    );
    const effectiveDocuments = input.documents.map(unwrapDocument);
    const referenceErrors: ValidationIssue[] = [];
    const documentsByPath = new Map<string, EffectiveDocument>();

    for (const effective of effectiveDocuments) {
      if (documentsByPath.has(effective.path)) {
        referenceErrors.push(
          referenceIssue(
            "reference.duplicate_path",
            effective.path,
            "document path is duplicated",
            {
              path: effective.path,
            },
          ),
        );
      } else {
        documentsByPath.set(effective.path, effective);
      }
      if (effective.envelope !== null && effective.envelope.artifact_path !== effective.path) {
        referenceErrors.push(
          referenceIssue(
            "reference.envelope_path_mismatch",
            `${effective.path}#/artifact_path`,
            "envelope artifact_path differs from bundle path",
            { bundlePath: effective.path, artifactPath: effective.envelope.artifact_path },
          ),
        );
      }
      const documentRunId = effective.document.run_id;
      if (
        effective.envelope !== null &&
        typeof documentRunId === "string" &&
        effective.envelope.run_id !== documentRunId
      ) {
        referenceErrors.push(
          referenceIssue(
            "reference.envelope_run_mismatch",
            `${effective.path}#/run_id`,
            "envelope and document run_id differ",
            { envelopeRunId: effective.envelope.run_id, documentRunId },
          ),
        );
      }
    }

    for (const source of effectiveDocuments) {
      for (const requirement of referenceRequirements(source)) {
        const [targetPath = "", fragment] = requirement.ref.split("#", 2);
        const exactTarget = exactJsonlTarget(requirement, targetPath, fragment, {
          exactJsonlRecords,
        });
        const target = exactTarget ?? documentsByPath.get(targetPath);
        const qualifiedPath = `${source.path}#${requirement.instancePath}`;
        if (!target) {
          referenceErrors.push(
            referenceIssue(
              "reference.missing",
              qualifiedPath,
              "typed reference target is missing",
              {
                ref: requirement.ref,
                expectedSchemaVersions: requirement.expectedSchemaVersions,
              },
            ),
          );
          continue;
        }
        if (exactTarget !== null) {
          const targetValidation = this.validateDocument(exactTarget.document, requirement.ref);
          if (!targetValidation.valid) {
            referenceErrors.push(
              referenceIssue(
                "reference.target_invalid",
                qualifiedPath,
                "typed JSONL reference target is not schema-valid",
                { ref: requirement.ref, errors: targetValidation.errors },
              ),
            );
            continue;
          }
        }
        if (!requirement.expectedSchemaVersions.includes(target.schemaVersion)) {
          referenceErrors.push(
            referenceIssue(
              "reference.type_mismatch",
              qualifiedPath,
              "typed reference target has the wrong schema version",
              {
                ref: requirement.ref,
                expectedSchemaVersions: requirement.expectedSchemaVersions,
                actualSchemaVersion: target.schemaVersion,
              },
            ),
          );
          continue;
        }
        const sourceRunId = source.document.run_id;
        const targetRunId = target.document.run_id;
        if (
          typeof sourceRunId === "string" &&
          typeof targetRunId === "string" &&
          sourceRunId !== targetRunId
        ) {
          referenceErrors.push(
            referenceIssue(
              "reference.run_mismatch",
              qualifiedPath,
              "typed reference crosses Run boundaries",
              { ref: requirement.ref, sourceRunId, targetRunId },
            ),
          );
        }
        if (
          requirement.expectedIdField !== undefined &&
          (fragment === undefined ||
            !fragmentIdExists(target, fragment, requirement.expectedIdField))
        ) {
          referenceErrors.push(
            referenceIssue(
              "reference.fragment_missing",
              qualifiedPath,
              "typed reference fragment does not identify a target record",
              { ref: requirement.ref, expectedIdField: requirement.expectedIdField },
            ),
          );
        }
      }
      referenceErrors.push(
        ...this.checkLineage(
          source,
          documentsByPath,
          input.schema_version === "startup_opportunity.document_bundle.v1" ||
            input.schema_version === "startup_opportunity.document_bundle.v2",
        ),
      );
    }

    const assessDocuments: readonly AssessDomainDocument[] = effectiveDocuments.map((entry) => ({
      path: entry.path,
      schemaVersion: entry.schemaVersion,
      document: entry.document,
    }));
    if (
      assessDocuments.some((entry) => isAssessDomainSchemaVersion(entry.schemaVersion)) &&
      input.schema_version !== "startup_opportunity.document_bundle.v4" &&
      input.schema_version !== "startup_opportunity.document_bundle.v5" &&
      input.schema_version !== "startup_opportunity.document_bundle.v6" &&
      input.schema_version !== "startup_opportunity.document_bundle.v7" &&
      input.schema_version !== "startup_opportunity.document_bundle.v8" &&
      input.schema_version !== "startup_opportunity.document_bundle.v9" &&
      input.schema_version !== "startup_opportunity.document_bundle.v10" &&
      input.schema_version !== "startup_opportunity.document_bundle.v11" &&
      input.schema_version !== "startup_opportunity.document_bundle.v12" &&
      input.schema_version !== "startup_opportunity.document_bundle.v13"
    ) {
      referenceErrors.push(
        referenceIssue(
          "assess_contract.bundle_version_mismatch",
          "/schema_version",
          "G1.1 assess contracts require document_bundle.v4",
          { actualSchemaVersion: input.schema_version },
        ),
      );
    } else {
      referenceErrors.push(...validateAssessDomainContract(assessDocuments));
    }
    const researchDocuments: readonly ResearchBranchDocument[] = effectiveDocuments.map(
      (entry) => ({
        path: entry.path,
        schemaVersion: entry.schemaVersion,
        document: entry.document,
        envelope: entry.envelope,
      }),
    );
    if (
      researchDocuments.some(
        (entry) =>
          entry.schemaVersion.startsWith("startup_opportunity.research_task.") ||
          entry.schemaVersion === "startup_opportunity.evidence.v1" ||
          entry.schemaVersion === "startup_opportunity.claim.v1" ||
          entry.schemaVersion === "startup_opportunity.finding.v1" ||
          entry.schemaVersion === "startup_opportunity.insight.v1" ||
          entry.schemaVersion === "startup_opportunity.source_manifest.v1" ||
          (entry.schemaVersion ===
            "startup_opportunity.concept_evidence_assessment_branch_result.v1" &&
            entry.envelope?.schema_version === "startup_opportunity.artifact_envelope.v5"),
      ) &&
      input.schema_version !== "startup_opportunity.document_bundle.v5" &&
      input.schema_version !== "startup_opportunity.document_bundle.v6" &&
      input.schema_version !== "startup_opportunity.document_bundle.v7" &&
      input.schema_version !== "startup_opportunity.document_bundle.v8" &&
      input.schema_version !== "startup_opportunity.document_bundle.v9" &&
      input.schema_version !== "startup_opportunity.document_bundle.v10" &&
      input.schema_version !== "startup_opportunity.document_bundle.v11" &&
      input.schema_version !== "startup_opportunity.document_bundle.v12" &&
      input.schema_version !== "startup_opportunity.document_bundle.v13"
    ) {
      referenceErrors.push(
        referenceIssue(
          "research_contract.bundle_version_mismatch",
          "/schema_version",
          "G1.2 research contracts require document_bundle.v5",
          { actualSchemaVersion: input.schema_version },
        ),
      );
    } else {
      referenceErrors.push(...validateResearchBranchContract(researchDocuments, exactJsonlRecords));
    }
    const assessmentAdaptationDocuments: readonly AssessmentAdaptationDocument[] =
      effectiveDocuments.map((entry) => ({
        path: entry.path,
        schemaVersion: entry.schemaVersion,
        document: entry.document,
      }));
    referenceErrors.push(...validateAssessmentAdaptationContract(assessmentAdaptationDocuments));
    const g14Documents: readonly G14Document[] = effectiveDocuments.map((entry) => ({
      path: entry.path,
      schemaVersion: entry.schemaVersion,
      document: entry.document,
      envelope: entry.envelope,
    }));
    if (
      g14Documents.some((entry) => isG14SchemaVersion(entry.schemaVersion)) &&
      input.schema_version !== "startup_opportunity.document_bundle.v7" &&
      input.schema_version !== "startup_opportunity.document_bundle.v9" &&
      input.schema_version !== "startup_opportunity.document_bundle.v10" &&
      input.schema_version !== "startup_opportunity.document_bundle.v11" &&
      input.schema_version !== "startup_opportunity.document_bundle.v12" &&
      input.schema_version !== "startup_opportunity.document_bundle.v13"
    ) {
      referenceErrors.push(
        referenceIssue(
          "g1_4.bundle_version_mismatch",
          "/schema_version",
          "G1.4 audit, review, Assessment, Traceability, and report contracts require document_bundle.v7",
          { actualSchemaVersion: input.schema_version },
        ),
      );
    } else {
      referenceErrors.push(...validateG14Contract(g14Documents, this.assessmentReportingPolicy));
    }
    const discoveryDocuments: readonly DiscoveryMapDocument[] = effectiveDocuments.map((entry) => ({
      path: entry.path,
      schemaVersion: entry.schemaVersion,
      document: entry.document,
      envelope: entry.envelope,
    }));
    if (
      discoveryDocuments.some((entry) => isDiscoveryMapSchemaVersion(entry.schemaVersion)) &&
      discoveryDocuments.some((entry) =>
        [
          "startup_opportunity.seed_probe.v1",
          "startup_opportunity.opportunity_space_map.v1",
          "startup_opportunity.solution_space_map.v1",
        ].includes(entry.schemaVersion),
      ) &&
      input.schema_version !== "startup_opportunity.document_bundle.v8" &&
      input.schema_version !== "startup_opportunity.document_bundle.v9" &&
      input.schema_version !== "startup_opportunity.document_bundle.v10" &&
      input.schema_version !== "startup_opportunity.document_bundle.v11" &&
      input.schema_version !== "startup_opportunity.document_bundle.v12" &&
      input.schema_version !== "startup_opportunity.document_bundle.v13"
    ) {
      referenceErrors.push(
        referenceIssue(
          "g2_1.bundle_version_mismatch",
          "/schema_version",
          "G2.1 Seed and space maps require document_bundle.v8",
          { actualSchemaVersion: input.schema_version },
        ),
      );
    } else if (referenceContext.validateHistoricalDiscoveryContracts !== false) {
      referenceErrors.push(
        ...validateDiscoveryMapsContract(
          input.schema_version === "startup_opportunity.document_bundle.v9" ||
            input.schema_version === "startup_opportunity.document_bundle.v10" ||
            input.schema_version === "startup_opportunity.document_bundle.v11" ||
            input.schema_version === "startup_opportunity.document_bundle.v12" ||
            input.schema_version === "startup_opportunity.document_bundle.v13"
            ? discoveryDocuments.filter(
                (entry) =>
                  !isDiscoveryCandidateSchemaVersion(entry.schemaVersion) &&
                  !isDiscoverySynthesisSchemaVersion(entry.schemaVersion) &&
                  !isDiscoveryEvaluationSchemaVersion(entry.schemaVersion),
              )
            : discoveryDocuments,
          this.discoveryMapsPolicy,
          input.schema_version === "startup_opportunity.document_bundle.v10" ||
            input.schema_version === "startup_opportunity.document_bundle.v11" ||
            input.schema_version === "startup_opportunity.document_bundle.v12" ||
            input.schema_version === "startup_opportunity.document_bundle.v13"
            ? ["7.0.0", "9.0.0", "10.0.0", "11.0.0", "12.0.0"]
            : undefined,
        ),
      );
    }
    const discoveryCandidateDocuments: readonly DiscoveryCandidateDocument[] =
      effectiveDocuments.map((entry) => ({
        path: entry.path,
        schemaVersion: entry.schemaVersion,
        document: entry.document,
        envelope: entry.envelope,
      }));
    if (
      discoveryCandidateDocuments.some((entry) =>
        isDiscoveryCandidateSchemaVersion(entry.schemaVersion),
      ) &&
      input.schema_version !== "startup_opportunity.document_bundle.v9" &&
      input.schema_version !== "startup_opportunity.document_bundle.v10" &&
      input.schema_version !== "startup_opportunity.document_bundle.v11" &&
      input.schema_version !== "startup_opportunity.document_bundle.v12" &&
      input.schema_version !== "startup_opportunity.document_bundle.v13"
    ) {
      referenceErrors.push(
        referenceIssue(
          "g2_2_contract.bundle_version_mismatch",
          "/schema_version",
          "Scheme A pre-thesis candidate contracts require document_bundle.v9",
          { actualSchemaVersion: input.schema_version },
        ),
      );
    } else if (referenceContext.validateHistoricalDiscoveryContracts !== false) {
      referenceErrors.push(
        ...validateDiscoveryCandidateContract(
          discoveryCandidateDocuments,
          this.discoveryCandidatePolicy,
        ),
      );
    }
    const discoverySynthesisDocuments: readonly DiscoverySynthesisDocument[] =
      effectiveDocuments.map((entry) => ({
        path: entry.path,
        schemaVersion: entry.schemaVersion,
        document: entry.document,
        envelope: entry.envelope,
      }));
    if (
      discoverySynthesisDocuments.some((entry) =>
        isDiscoverySynthesisSchemaVersion(entry.schemaVersion),
      ) &&
      input.schema_version !== "startup_opportunity.document_bundle.v11" &&
      input.schema_version !== "startup_opportunity.document_bundle.v12" &&
      input.schema_version !== "startup_opportunity.document_bundle.v13"
    ) {
      referenceErrors.push(
        referenceIssue(
          "g2_3_contract.bundle_version_mismatch",
          "/schema_version",
          "G2.3 synthesis contracts require document_bundle.v11",
          { actualSchemaVersion: input.schema_version },
        ),
      );
    } else {
      referenceErrors.push(
        ...validateDiscoverySynthesisContract(
          discoverySynthesisDocuments,
          this.discoverySynthesisPolicy,
        ),
      );
    }
    const discoveryEvaluationDocuments: readonly DiscoveryEvaluationDocument[] =
      effectiveDocuments.map((entry) => ({
        path: entry.path,
        schemaVersion: entry.schemaVersion,
        document: entry.document,
        envelope: entry.envelope,
      }));
    if (
      discoveryEvaluationDocuments.some((entry) =>
        isDiscoveryEvaluationSchemaVersion(entry.schemaVersion),
      ) &&
      input.schema_version !== "startup_opportunity.document_bundle.v12" &&
      input.schema_version !== "startup_opportunity.document_bundle.v13"
    ) {
      referenceErrors.push(
        referenceIssue(
          "g2_4.bundle_version_mismatch",
          "/schema_version",
          "G2.4 evaluation contracts require document_bundle.v12 or repaired v13",
          { actualSchemaVersion: input.schema_version },
        ),
      );
    } else {
      referenceErrors.push(
        ...validateDiscoveryEvaluationContract(
          discoveryEvaluationDocuments,
          input.schema_version === "startup_opportunity.document_bundle.v12"
            ? this.legacyDiscoveryEvaluationPolicy
            : this.discoveryEvaluationPolicy,
          exactJsonlRecords,
        ),
      );
    }
    referenceErrors.push(...exactRecordErrors);
    const sortedReferenceErrors = sortIssues(referenceErrors);
    const sortedDocuments = [...documents].sort((left, right) =>
      (left.documentPath ?? "").localeCompare(right.documentPath ?? ""),
    );
    const valid =
      bundleResult.valid &&
      sortedDocuments.every((document) => document.valid) &&
      sortedReferenceErrors.length === 0;
    return {
      schemaVersion: DOCUMENT_BUNDLE_VALIDATION_RESULT_VERSION,
      schemaBundleVersion: this.bundle.version,
      valid,
      bundleErrors: [],
      documents: sortedDocuments,
      referenceErrors: sortedReferenceErrors,
    };
  }

  private checkLineage(
    source: EffectiveDocument,
    documentsByPath: ReadonlyMap<string, EffectiveDocument>,
    enforceLivePlanningBinding: boolean,
  ): readonly ValidationIssue[] {
    const errors: ValidationIssue[] = [];
    const revision = source.document.revision;

    if (
      source.schemaVersion === "startup_opportunity.planning_context.v1" ||
      source.schemaVersion === "startup_opportunity.planning_context.v2"
    ) {
      const contextRevision = source.document.revision;
      const pathRevision = planningContextRevisionFromPath(source.path);
      if (typeof contextRevision === "number" && pathRevision !== contextRevision) {
        errors.push(
          referenceIssue(
            "reference.path_revision_mismatch",
            source.path,
            "Planning Context path does not match document revision",
            { pathRevision, documentRevision: contextRevision },
          ),
        );
      }
      const parentContextRef = source.document.parent_context_ref;
      if (
        typeof contextRevision === "number" &&
        contextRevision > 1 &&
        typeof parentContextRef === "string"
      ) {
        const parent = documentsByPath.get(parentContextRef);
        if (
          parent?.schemaVersion === source.schemaVersion &&
          (parent.document.revision !== contextRevision - 1 ||
            parent.document.context_id !== source.document.context_id)
        ) {
          errors.push(
            referenceIssue(
              "reference.planning_context_lineage_mismatch",
              `${source.path}#/parent_context_ref`,
              "parent Planning Context must be the preceding revision of the same context",
              { parentContextRef, contextRevision },
            ),
          );
        }
      }
      const manifestBinding = source.document.manifest_binding;
      const planBinding = source.document.target_plan_binding;
      if (isRecord(manifestBinding) && isRecord(planBinding)) {
        const manifest = targetByRef(documentsByPath, manifestBinding.manifest_ref);
        const plan = targetByRef(documentsByPath, planBinding.plan_ref);
        if (manifest?.schemaVersion === "startup_opportunity.run_manifest.v1") {
          const boundRunState = {
            manifest_ref: manifestBinding.manifest_ref as string,
            manifest_schema_version: manifest.schemaVersion,
            run_id: manifestBinding.run_id as string,
            mode: manifestBinding.mode as string,
            current_plan_ref: manifestBinding.current_plan_ref as string | null,
            current_plan_revision: manifestBinding.current_plan_revision as number,
          };
          const liveRunState = {
            manifest_ref: manifestBinding.manifest_ref as string,
            manifest_schema_version: manifest.schemaVersion,
            run_id: manifest.document.run_id as string,
            mode: manifest.document.mode as string,
            current_plan_ref: manifest.document.current_plan_ref as string | null,
            current_plan_revision: manifest.document.plan_revision as number,
          };
          if (
            source.document.run_id !== manifest.document.run_id ||
            manifestBinding.run_id !== manifest.document.run_id
          ) {
            errors.push(
              referenceIssue(
                "reference.planning_context_run_mismatch",
                `${source.path}#/manifest_binding/run_id`,
                "Planning Context and Run Manifest identities differ",
                {},
              ),
            );
          }
          if (
            source.document.mode !== manifest.document.mode ||
            manifestBinding.mode !== manifest.document.mode
          ) {
            errors.push(
              referenceIssue(
                "reference.planning_context_mode_mismatch",
                `${source.path}#/manifest_binding/mode`,
                "Planning Context and Run Manifest modes differ",
                {},
              ),
            );
          }
          if (
            (enforceLivePlanningBinding &&
              (manifestBinding.current_plan_ref !== manifest.document.current_plan_ref ||
                manifestBinding.current_plan_revision !== manifest.document.plan_revision)) ||
            manifestBinding.run_state_hash !==
              planningRunStateHash(enforceLivePlanningBinding ? liveRunState : boundRunState)
          ) {
            errors.push(
              referenceIssue(
                "reference.planning_context_stale_run",
                `${source.path}#/manifest_binding/run_state_hash`,
                "Planning Context Run binding is stale",
                {
                  currentPlanRef: manifest.document.current_plan_ref,
                  currentPlanRevision: manifest.document.plan_revision,
                },
              ),
            );
          }
        }
        if (plan?.schemaVersion === "startup_opportunity.research_plan.v1") {
          if (
            planBinding.plan_id !== plan.document.plan_id ||
            planBinding.plan_revision !== plan.document.revision ||
            source.document.run_id !== plan.document.run_id ||
            source.document.mode !== plan.document.mode
          ) {
            errors.push(
              referenceIssue(
                "reference.planning_context_stale_plan_identity",
                `${source.path}#/target_plan_binding`,
                "Planning Context target plan identity or revision is stale",
                {},
              ),
            );
          }
          if (planBinding.plan_content_hash !== canonicalContentHash(plan.document)) {
            errors.push(
              referenceIssue(
                "reference.planning_context_stale_plan_hash",
                `${source.path}#/target_plan_binding/plan_content_hash`,
                "Planning Context target plan hash is stale",
                {},
              ),
            );
          }
          const stage = source.document.validation_stage;
          const currentPlanRef =
            enforceLivePlanningBinding &&
            manifest?.schemaVersion === "startup_opportunity.run_manifest.v1"
              ? manifest.document.current_plan_ref
              : manifestBinding.current_plan_ref;
          const currentRevision =
            enforceLivePlanningBinding &&
            manifest?.schemaVersion === "startup_opportunity.run_manifest.v1"
              ? manifest.document.plan_revision
              : manifestBinding.current_plan_revision;
          const targetPlanRef = planBinding.plan_ref;
          const validStage =
            (stage === "initial_plan" &&
              currentPlanRef === null &&
              currentRevision === 0 &&
              plan.document.revision === 1 &&
              plan.document.parent_plan_ref === null) ||
            (stage === "current_plan" &&
              currentPlanRef === targetPlanRef &&
              currentRevision === plan.document.revision) ||
            (stage === "candidate_revision" &&
              typeof currentPlanRef === "string" &&
              plan.document.parent_plan_ref === currentPlanRef &&
              typeof currentRevision === "number" &&
              plan.document.revision === currentRevision + 1);
          if (!validStage) {
            errors.push(
              referenceIssue(
                "reference.planning_context_stage_mismatch",
                `${source.path}#/validation_stage`,
                "Planning Context validation stage does not match its bound Run state and plan lineage",
                { stage },
              ),
            );
          }
        }
      }
    }

    if (source.schemaVersion === "startup_opportunity.coverage_attestation.v1") {
      const planRef = source.document.based_on_plan_ref;
      const gapRef = source.document.gap_ref;
      const targetUnitRef = source.document.target_unit_ref;
      const plan = targetByRef(documentsByPath, planRef);
      const gapSnapshot = targetByRef(documentsByPath, gapRef);
      const gapId = typeof gapRef === "string" ? gapRef.split("#", 2)[1] : undefined;
      const unitId = typeof targetUnitRef === "string" ? targetUnitRef.split("#", 2)[1] : undefined;
      const gap =
        gapSnapshot?.schemaVersion === "startup_opportunity.gap_snapshot.v1" && gapId !== undefined
          ? recordById(gapSnapshot.document, "gaps", "gap_id", gapId)
          : null;
      const unit =
        plan?.schemaVersion === "startup_opportunity.research_plan.v1" && unitId !== undefined
          ? recordById(plan.document, "units", "unit_id", unitId)
          : null;

      if (plan?.schemaVersion === "startup_opportunity.research_plan.v1") {
        if (
          source.document.based_on_plan_revision !== plan.document.revision ||
          source.document.based_on_plan_hash !== canonicalContentHash(plan.document) ||
          source.document.run_id !== plan.document.run_id
        ) {
          errors.push(
            referenceIssue(
              "reference.coverage_stale_plan",
              `${source.path}#/based_on_plan_hash`,
              "Coverage Attestation plan binding is stale",
              {},
            ),
          );
        }
      }
      if (
        gap !== null &&
        (source.document.subject_ref !== gap.subject_ref ||
          source.document.run_id !== gapSnapshot?.document.run_id ||
          gapSnapshot?.document.based_on_plan_ref !== planRef)
      ) {
        errors.push(
          referenceIssue(
            "reference.coverage_subject_mismatch",
            `${source.path}#/subject_ref`,
            "Coverage Attestation subject or gap plan differs from the referenced gap",
            {},
          ),
        );
      }
      if (
        unit !== null &&
        (source.document.target_research_goal !== unit.research_goal ||
          !Array.isArray(unit.input_refs) ||
          !unit.input_refs.includes(source.document.subject_ref))
      ) {
        errors.push(
          referenceIssue(
            "reference.coverage_unit_mismatch",
            `${source.path}#/target_unit_ref`,
            "Coverage Attestation target goal or subject ref differs from the plan unit",
            {},
          ),
        );
      }
      const identityFields = [
        "schema_version",
        "relation",
        "run_id",
        "based_on_plan_ref",
        "based_on_plan_revision",
        "based_on_plan_hash",
        "gap_ref",
        "subject_ref",
        "target_unit_ref",
        "gap_research_goal",
        "target_research_goal",
      ] as const;
      if (identityFields.every((field) => source.document[field] !== undefined)) {
        const identity = Object.fromEntries(
          identityFields.map((field) => [field, source.document[field]]),
        ) as unknown as Parameters<typeof coverageKey>[0];
        if (source.document.coverage_key !== coverageKey(identity)) {
          errors.push(
            referenceIssue(
              "reference.coverage_key_mismatch",
              `${source.path}#/coverage_key`,
              "coverage_key does not match the canonical attestation identity",
              {},
            ),
          );
        }
      }
    }
    if (source.schemaVersion === "startup_opportunity.research_plan.v1") {
      const pathRevision = planRevisionFromPath(source.path);
      if (typeof revision === "number" && pathRevision !== revision) {
        errors.push(
          referenceIssue(
            "reference.path_revision_mismatch",
            source.path,
            "research plan path does not match document revision",
            { pathRevision, documentRevision: revision },
          ),
        );
      }
      const parentRef = source.document.parent_plan_ref;
      if (typeof revision === "number" && revision > 1 && typeof parentRef === "string") {
        const parent = documentsByPath.get(parentRef);
        if (
          parent?.schemaVersion === "startup_opportunity.research_plan.v1" &&
          (parent.document.revision !== revision - 1 ||
            parent.document.plan_id !== source.document.plan_id)
        ) {
          errors.push(
            referenceIssue(
              "reference.plan_lineage_mismatch",
              `${source.path}#/parent_plan_ref`,
              "parent plan must be the preceding revision of the same plan",
              { parentRef, revision },
            ),
          );
        }
      }
    }

    if (
      source.schemaVersion === "startup_opportunity.gap_snapshot.v1" ||
      source.schemaVersion === "startup_opportunity.gap_snapshot.v2"
    ) {
      const pathRevision = snapshotRevisionFromPath(source.path);
      if (typeof revision === "number" && pathRevision !== revision) {
        errors.push(
          referenceIssue(
            "reference.path_revision_mismatch",
            source.path,
            "Gap Snapshot path does not match document revision",
            { pathRevision, documentRevision: revision },
          ),
        );
      }
      const parentRef = source.document.parent_snapshot_ref;
      if (typeof revision === "number" && revision > 1 && typeof parentRef === "string") {
        const parent = documentsByPath.get(parentRef);
        if (
          parent?.schemaVersion === source.schemaVersion &&
          (parent.document.revision !== revision - 1 ||
            parent.document.snapshot_cycle_key !== source.document.snapshot_cycle_key)
        ) {
          errors.push(
            referenceIssue(
              "reference.snapshot_lineage_mismatch",
              `${source.path}#/parent_snapshot_ref`,
              "parent snapshot must be the preceding revision of the same cycle",
              { parentRef, revision },
            ),
          );
        }
      }
    }

    if (
      source.schemaVersion === "startup_opportunity.run_manifest.v1" ||
      source.schemaVersion === "startup_opportunity.checkpoint.v1"
    ) {
      const currentPlanRef = source.document.current_plan_ref;
      const planRevision = source.document.plan_revision;
      if (typeof currentPlanRef === "string" && typeof planRevision === "number") {
        const currentPlan = documentsByPath.get(currentPlanRef);
        if (
          currentPlan?.schemaVersion === "startup_opportunity.research_plan.v1" &&
          currentPlan.document.revision !== planRevision
        ) {
          errors.push(
            referenceIssue(
              "reference.current_plan_revision_mismatch",
              `${source.path}#/current_plan_ref`,
              "current plan revision differs from the indexed revision",
              { currentPlanRef, planRevision, documentRevision: currentPlan.document.revision },
            ),
          );
        }
      }
    }

    if (source.schemaVersion === "startup_opportunity.checkpoint.v1") {
      const snapshot = source.document.manifest_snapshot;
      if (
        isRecord(snapshot) &&
        (snapshot.run_id !== source.document.run_id ||
          snapshot.current_plan_ref !== source.document.current_plan_ref ||
          snapshot.plan_revision !== source.document.plan_revision)
      ) {
        errors.push(
          referenceIssue(
            "reference.checkpoint_snapshot_mismatch",
            `${source.path}#/manifest_snapshot`,
            "checkpoint index fields differ from its manifest snapshot",
            {},
          ),
        );
      }
    }
    return errors;
  }
}

export async function createArtifactValidator(
  root = process.cwd(),
  manifestRelativePath?: string,
  expectedVersion?: string,
): Promise<ArtifactValidator> {
  const bundle = await loadSchemaBundle(root, manifestRelativePath, expectedVersion);
  return new ArtifactValidator(
    bundle,
    await loadResearchPublicationPolicy(root, bundle),
    await loadAssessmentReportingPolicy(root, bundle),
    await loadDiscoveryMapsPolicy(root, bundle),
    await loadDiscoveryCandidatePolicy(root, bundle),
    await loadDiscoverySynthesisPolicy(root, bundle),
    await loadDiscoveryEvaluationPolicy(root, bundle),
    await loadDiscoveryEvaluationPolicy(root, bundle, LEGACY_DISCOVERY_EVALUATION_POLICY_PATH),
  );
}

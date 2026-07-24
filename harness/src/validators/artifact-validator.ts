import type { ErrorObject } from "ajv";
import { canonicalContentHash } from "../artifact-store/canonical.js";
import { coverageKey, planningRunStateHash } from "./planning-contract-identities.js";
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
    | "startup_opportunity.document_bundle.v3";
  readonly documents: readonly DocumentBundleEntry[];
}

export interface DocumentBundleReferenceContext {
  readonly exactJsonlRecords?: ReadonlyMap<string, Record<string, unknown>>;
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

function referenceRequirements(effective: EffectiveDocument): readonly ReferenceRequirement[] {
  const { document, schemaVersion } = effective;
  switch (schemaVersion) {
    case "startup_opportunity.run_manifest.v1":
      return [
        ...optionalRef(document, "current_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "latest_gap_snapshot_ref", "startup_opportunity.gap_snapshot.v1"),
        ...refsFromArray(document, "pending_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
        ]),
        ...refsFromArray(document, "validated_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
        ]),
        ...refsFromArray(document, "rejected_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
        ]),
        ...refsFromArray(document, "applied_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
        ]),
        ...optionalRef(document, "checkpoint_ref", "startup_opportunity.checkpoint.v1"),
      ];
    case "startup_opportunity.research_plan.v1":
      return [
        ...optionalRef(document, "parent_plan_ref", "startup_opportunity.research_plan.v1"),
        ...refsFromArray(document, "triggered_by_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
        ]),
      ];
    case "startup_opportunity.gap_snapshot.v1":
      return [
        ...optionalRef(document, "based_on_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "parent_snapshot_ref", "startup_opportunity.gap_snapshot.v1"),
        ...optionalRef(document, "trigger_event_ref", "startup_opportunity.event.v1", "event_id"),
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
        ...optionalRef(document, "latest_gap_snapshot_ref", "startup_opportunity.gap_snapshot.v1"),
        ...refsFromArray(document, "applied_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
        ]),
        ...refsFromArray(document, "pending_adaptation_refs", [
          "startup_opportunity.adaptation_decision.v1",
          "startup_opportunity.adaptation_decision.v2",
        ]),
        ...refsFromArray(
          document,
          "unresolved_gap_refs",
          "startup_opportunity.gap_snapshot.v1",
          "gap_id",
        ),
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
    version !== "startup_opportunity.artifact_envelope.v3"
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
  if (
    fragment === undefined ||
    (targetPath !== "events.jsonl" && targetPath !== "decisions.jsonl")
  ) {
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

export class ArtifactValidator {
  constructor(private readonly bundle: LoadedSchemaBundle) {}

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
    const errors = valid ? [] : normalizeAjvErrors(validator.errors);
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
        const exactTarget = exactJsonlTarget(requirement, targetPath, fragment, referenceContext);
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
          input.schema_version !== "startup_opportunity.document_bundle.v3",
        ),
      );
    }

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

    if (source.schemaVersion === "startup_opportunity.gap_snapshot.v1") {
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
          parent?.schemaVersion === "startup_opportunity.gap_snapshot.v1" &&
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
  return new ArtifactValidator(await loadSchemaBundle(root, manifestRelativePath, expectedVersion));
}

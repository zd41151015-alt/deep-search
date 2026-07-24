import type { ErrorObject } from "ajv";
import {
  type LoadedSchemaBundle,
  loadSchemaBundle,
  type SCHEMA_BUNDLE_VERSION,
  sortIssues,
  type ValidationIssue,
} from "./schema-bundle.js";

export const ARTIFACT_VALIDATION_RESULT_VERSION =
  "startup_opportunity.artifact_validation_result.v1" as const;
export const DOCUMENT_BUNDLE_VALIDATION_RESULT_VERSION =
  "startup_opportunity.document_bundle_validation_result.v1" as const;

export interface ArtifactValidationResult {
  readonly schemaVersion: typeof ARTIFACT_VALIDATION_RESULT_VERSION;
  readonly schemaBundleVersion: typeof SCHEMA_BUNDLE_VERSION;
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
  readonly schema_version: "startup_opportunity.document_bundle.v1";
  readonly documents: readonly DocumentBundleEntry[];
}

export interface DocumentBundleValidationResult {
  readonly schemaVersion: typeof DOCUMENT_BUNDLE_VALIDATION_RESULT_VERSION;
  readonly schemaBundleVersion: typeof SCHEMA_BUNDLE_VERSION;
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
  readonly expectedSchemaVersion: string;
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
  expectedSchemaVersion: string,
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
            expectedSchemaVersion,
            ...(expectedIdField === undefined ? {} : { expectedIdField }),
          },
        ]
      : [],
  );
}

function optionalRef(
  document: Record<string, unknown>,
  field: string,
  expectedSchemaVersion: string,
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
      expectedSchemaVersion,
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
        ...refsFromArray(
          document,
          "pending_adaptation_refs",
          "startup_opportunity.adaptation_decision.v1",
        ),
        ...refsFromArray(
          document,
          "validated_adaptation_refs",
          "startup_opportunity.adaptation_decision.v1",
        ),
        ...refsFromArray(
          document,
          "rejected_adaptation_refs",
          "startup_opportunity.adaptation_decision.v1",
        ),
        ...refsFromArray(
          document,
          "applied_adaptation_refs",
          "startup_opportunity.adaptation_decision.v1",
        ),
        ...optionalRef(document, "checkpoint_ref", "startup_opportunity.checkpoint.v1"),
      ];
    case "startup_opportunity.research_plan.v1":
      return [
        ...optionalRef(document, "parent_plan_ref", "startup_opportunity.research_plan.v1"),
        ...refsFromArray(
          document,
          "triggered_by_adaptation_refs",
          "startup_opportunity.adaptation_decision.v1",
        ),
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
    case "startup_opportunity.checkpoint.v1":
      return [
        ...optionalRef(document, "current_plan_ref", "startup_opportunity.research_plan.v1"),
        ...optionalRef(document, "latest_gap_snapshot_ref", "startup_opportunity.gap_snapshot.v1"),
        ...refsFromArray(
          document,
          "applied_adaptation_refs",
          "startup_opportunity.adaptation_decision.v1",
        ),
        ...refsFromArray(
          document,
          "pending_adaptation_refs",
          "startup_opportunity.adaptation_decision.v1",
        ),
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
  if (version !== "startup_opportunity.artifact_envelope.v1") {
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
  if (expectedIdField !== "gap_id") {
    return false;
  }
  const gaps = target.document.gaps;
  return (
    Array.isArray(gaps) && gaps.some((gap) => isRecord(gap) && gap[expectedIdField] === fragment)
  );
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

  validateDocumentBundle(value: unknown): DocumentBundleValidationResult {
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
        const target = documentsByPath.get(targetPath);
        const qualifiedPath = `${source.path}#${requirement.instancePath}`;
        if (!target) {
          referenceErrors.push(
            referenceIssue(
              "reference.missing",
              qualifiedPath,
              "typed reference target is missing",
              {
                ref: requirement.ref,
                expectedSchemaVersion: requirement.expectedSchemaVersion,
              },
            ),
          );
          continue;
        }
        if (target.schemaVersion !== requirement.expectedSchemaVersion) {
          referenceErrors.push(
            referenceIssue(
              "reference.type_mismatch",
              qualifiedPath,
              "typed reference target has the wrong schema version",
              {
                ref: requirement.ref,
                expectedSchemaVersion: requirement.expectedSchemaVersion,
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
      referenceErrors.push(...this.checkLineage(source, documentsByPath));
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
  ): readonly ValidationIssue[] {
    const errors: ValidationIssue[] = [];
    const revision = source.document.revision;
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

export async function createArtifactValidator(root = process.cwd()): Promise<ArtifactValidator> {
  return new ArtifactValidator(await loadSchemaBundle(root));
}

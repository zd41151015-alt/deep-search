import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalContentHash } from "../artifact-store/canonical.js";
import type {
  ArtifactValidationResult,
  DocumentBundleReferenceContext,
  DocumentBundleValidationResult,
} from "./artifact-validator.js";
import { type ArtifactValidator, createArtifactValidator } from "./artifact-validator.js";
import { sortIssues, type ValidationIssue } from "./schema-bundle.js";

export const ADAPTATION_POLICY_PATH = "harness/policies/adaptation.v1.json" as const;
export const AI_TRIGGER_SOURCE_POLICY_PATH =
  "harness/policies/ai-trigger-source-binding.v1.json" as const;
export const ASSESSMENT_AI_TRIGGER_SOURCE_POLICY_PATH =
  "harness/policies/ai-trigger-source-binding.v2.json" as const;
export const PLANNING_CONTRACT_RESULT_VERSION =
  "startup_opportunity.planning_contract_validation_result.v2" as const;

interface UnitRule {
  readonly mode: string;
  readonly phase: string;
  readonly unit_type: string;
  readonly agent_role: string;
  readonly required_artifact_schema: string;
}

interface SchemaCatalogEntry {
  readonly schema_id: string;
  readonly availability: "installed" | "future_declared";
  readonly owning_slice: string;
}

interface AdaptationPolicy extends Record<string, unknown> {
  readonly schema_version: "startup_opportunity.adaptation_policy.v1";
  readonly policy_version: "1.0.0";
  readonly compatible_schema_bundle_versions: readonly string[];
  readonly phase_catalog: readonly { readonly mode: string; readonly phase: string }[];
  readonly artifact_schema_catalog: readonly SchemaCatalogEntry[];
  readonly unit_rules: readonly UnitRule[];
}

interface AiTriggerSourceBindingPolicy extends Record<string, unknown> {
  readonly schema_version:
    | "startup_opportunity.ai_trigger_source_binding_policy.v1"
    | "startup_opportunity.ai_trigger_source_binding_policy.v2";
  readonly policy_version: "1.0.0" | "2.0.0";
  readonly compatible_schema_bundle_versions: readonly string[];
  readonly base_adaptation_policy_binding: {
    readonly policy_ref: string;
    readonly schema_version: string;
    readonly policy_version: string;
    readonly content_hash: string;
  };
  readonly contract_versions: {
    readonly planning_context: string;
    readonly source_attestation: string;
    readonly trigger: string;
  };
}

interface EffectiveDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
}

export interface PlanningContractValidationResult {
  readonly schemaVersion: typeof PLANNING_CONTRACT_RESULT_VERSION;
  readonly schemaBundleVersion: string;
  readonly policyVersion: string;
  readonly triggerSourcePolicyVersion: string;
  readonly valid: boolean;
  readonly documentBundle: DocumentBundleValidationResult;
  readonly policyValidation: ArtifactValidationResult;
  readonly triggerSourcePolicyValidation: ArtifactValidationResult;
  readonly contractErrors: readonly ValidationIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contractIssue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "contract",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function effectiveDocuments(value: unknown): readonly EffectiveDocument[] {
  if (!isRecord(value) || !Array.isArray(value.documents)) {
    return [];
  }
  return value.documents.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || !isRecord(entry.document)) {
      return [];
    }
    const version = entry.document.schema_version;
    if (
      (version === "startup_opportunity.artifact_envelope.v1" ||
        version === "startup_opportunity.artifact_envelope.v2" ||
        version === "startup_opportunity.artifact_envelope.v3" ||
        version === "startup_opportunity.artifact_envelope.v4" ||
        version === "startup_opportunity.artifact_envelope.v5" ||
        version === "startup_opportunity.artifact_envelope.v6") &&
      typeof entry.document.artifact_type === "string" &&
      isRecord(entry.document.document)
    ) {
      return [
        {
          path: entry.path,
          schemaVersion: entry.document.artifact_type,
          document: entry.document.document,
        },
      ];
    }
    return [
      {
        path: entry.path,
        schemaVersion: typeof version === "string" ? version : "",
        document: entry.document,
      },
    ];
  });
}

function unitEntries(plan: Record<string, unknown>): readonly Record<string, unknown>[] {
  if (!Array.isArray(plan.waves)) {
    return [];
  }
  return plan.waves.flatMap((wave) =>
    isRecord(wave) && Array.isArray(wave.units)
      ? wave.units.filter((unit): unit is Record<string, unknown> => isRecord(unit))
      : [],
  );
}

function refTarget(
  documents: ReadonlyMap<string, EffectiveDocument>,
  ref: unknown,
): EffectiveDocument | null {
  if (typeof ref !== "string") {
    return null;
  }
  return documents.get(ref.split("#", 1)[0] ?? "") ?? null;
}

function unitTarget(
  documents: ReadonlyMap<string, EffectiveDocument>,
  ref: unknown,
): { readonly plan: EffectiveDocument; readonly unit: Record<string, unknown> } | null {
  if (typeof ref !== "string") {
    return null;
  }
  const [planPath = "", unitId] = ref.split("#", 2);
  const plan = documents.get(planPath);
  if (plan?.schemaVersion !== "startup_opportunity.research_plan.v1" || unitId === undefined) {
    return null;
  }
  const unit = unitEntries(plan.document).find((candidate) => candidate.unit_id === unitId);
  return unit === undefined ? null : { plan, unit };
}

function tupleKey(rule: UnitRule): string {
  return [
    rule.mode,
    rule.phase,
    rule.unit_type,
    rule.agent_role,
    rule.required_artifact_schema,
  ].join("\0");
}

function statusOfUnit(manifest: Record<string, unknown>, unitId: string): string {
  const stateFields = [
    ["completed_units", "completed"],
    ["active_units", "active"],
    ["failed_units", "failed"],
    ["invalidated_units", "invalidated"],
    ["skipped_units", "skipped"],
    ["cancelled_units", "cancelled"],
    ["superseded_units", "superseded"],
  ] as const;
  for (const [field, state] of stateFields) {
    if (Array.isArray(manifest[field]) && manifest[field].includes(unitId)) {
      return state;
    }
  }
  return "pending";
}

export class PlanningContractEvaluator {
  constructor(
    private readonly artifactValidator: ArtifactValidator,
    private readonly policy: AdaptationPolicy,
    private readonly policyValidation: ArtifactValidationResult,
    private readonly triggerSourcePolicy: AiTriggerSourceBindingPolicy,
    private readonly triggerSourcePolicyValidation: ArtifactValidationResult,
    private readonly adaptationDecisionVersion = "startup_opportunity.adaptation_decision.v2",
  ) {}

  validateDocumentBundle(
    value: unknown,
    referenceContext: DocumentBundleReferenceContext = {},
  ): PlanningContractValidationResult {
    const documentBundle = this.artifactValidator.validateDocumentBundle(value, referenceContext);
    const documents = effectiveDocuments(value);
    const documentsByPath = new Map(documents.map((document) => [document.path, document]));
    const errors: ValidationIssue[] = [];

    const basePolicyBinding = this.triggerSourcePolicy.base_adaptation_policy_binding;
    if (
      basePolicyBinding.policy_ref !== ADAPTATION_POLICY_PATH ||
      basePolicyBinding.schema_version !== this.policy.schema_version ||
      basePolicyBinding.policy_version !== this.policy.policy_version ||
      basePolicyBinding.content_hash !== canonicalContentHash(this.policy)
    ) {
      errors.push(
        contractIssue(
          "contract.ai_trigger_policy_base_mismatch",
          "/base_adaptation_policy_binding",
          "AI trigger source policy does not bind the loaded closed adaptation policy",
        ),
      );
    }
    if (
      !this.triggerSourcePolicy.compatible_schema_bundle_versions.includes(
        documentBundle.schemaBundleVersion,
      )
    ) {
      errors.push(
        contractIssue(
          "contract.ai_trigger_policy_bundle_unsupported",
          "/compatible_schema_bundle_versions",
          "AI trigger source policy does not support the selected schema bundle",
          { schemaBundleVersion: documentBundle.schemaBundleVersion },
        ),
      );
    }

    const policyTupleKeys = new Set<string>();
    const schemaCatalog = new Map<string, SchemaCatalogEntry>();
    for (const entry of this.policy.artifact_schema_catalog) {
      if (schemaCatalog.has(entry.schema_id)) {
        errors.push(
          contractIssue(
            "contract.policy_duplicate_schema",
            "/artifact_schema_catalog",
            "policy artifact schema ids must be unique",
            { schemaId: entry.schema_id },
          ),
        );
      }
      schemaCatalog.set(entry.schema_id, entry);
    }
    for (const rule of this.policy.unit_rules) {
      const key = tupleKey(rule);
      if (policyTupleKeys.has(key)) {
        errors.push(
          contractIssue(
            "contract.policy_duplicate_tuple",
            "/unit_rules",
            "policy unit tuples must be unique",
            { key },
          ),
        );
      }
      policyTupleKeys.add(key);
      if (!schemaCatalog.has(rule.required_artifact_schema)) {
        errors.push(
          contractIssue(
            "contract.policy_undeclared_output_schema",
            "/unit_rules",
            "policy tuple references an undeclared output schema",
            { schemaId: rule.required_artifact_schema },
          ),
        );
      }
    }

    const planningContexts = documents.filter(
      (document) =>
        document.schemaVersion === this.triggerSourcePolicy.contract_versions.planning_context,
    );
    const referencedContextParents = new Set(
      planningContexts.flatMap((context) =>
        typeof context.document.parent_context_ref === "string"
          ? [context.document.parent_context_ref]
          : [],
      ),
    );
    const leafPlanningContexts = planningContexts.filter(
      (context) => !referencedContextParents.has(context.path),
    );
    if (planningContexts.length === 0) {
      errors.push(
        contractIssue(
          "contract.planning_context_missing",
          "",
          "policy validation requires exactly one Planning Context",
        ),
      );
    } else if (leafPlanningContexts.length !== 1) {
      errors.push(
        contractIssue(
          "contract.planning_context_ambiguous",
          "",
          "policy validation requires one unambiguous leaf Planning Context",
        ),
      );
    }

    const context = leafPlanningContexts[0];
    let manifest: EffectiveDocument | null = null;
    let plan: EffectiveDocument | null = null;
    if (context !== undefined) {
      const manifestBinding = context.document.manifest_binding;
      const planBinding = context.document.target_plan_binding;
      if (isRecord(manifestBinding)) {
        manifest = refTarget(documentsByPath, manifestBinding.manifest_ref);
      }
      if (isRecord(planBinding)) {
        plan = refTarget(documentsByPath, planBinding.plan_ref);
      }
      const mode = context.document.mode;
      const phase = context.document.phase;
      const phaseAllowed = this.policy.phase_catalog.some(
        (entry) => entry.mode === mode && entry.phase === phase,
      );
      if (!phaseAllowed) {
        errors.push(
          contractIssue(
            "contract.mode_phase_not_allowed",
            `${context.path}#/phase`,
            "Planning Context mode and phase are not declared by policy",
            { mode, phase },
          ),
        );
      }

      if (plan?.schemaVersion === "startup_opportunity.research_plan.v1") {
        for (const unit of unitEntries(plan.document)) {
          const rule: UnitRule = {
            mode: String(mode),
            phase: String(phase),
            unit_type: String(unit.unit_type),
            agent_role: String(unit.agent_role),
            required_artifact_schema: String(unit.required_artifact_schema),
          };
          if (!policyTupleKeys.has(tupleKey(rule))) {
            errors.push(
              contractIssue(
                "contract.unit_tuple_not_allowed",
                `${plan.path}#${String(unit.unit_id)}`,
                "unit mode/phase/type/role/output-schema tuple is not declared by policy",
                { ...rule },
              ),
            );
          }
        }

        const aiCoverage = context.document.ai_mandatory_coverage;
        if (isRecord(aiCoverage) && aiCoverage.status === "required") {
          const basis = aiCoverage.basis;
          const subjectRef = isRecord(basis) ? basis.subject_ref : null;
          const sourceRef = isRecord(basis) ? basis.source_ref : null;
          const source = refTarget(documentsByPath, sourceRef);
          const expectedSourceSchema =
            this.triggerSourcePolicy.contract_versions.source_attestation;

          if (typeof sourceRef !== "string" || sourceRef.includes("#") || source === null) {
            errors.push(
              contractIssue(
                "contract.ai_trigger_source_missing",
                `${context.path}#/ai_mandatory_coverage/basis/source_ref`,
                "AI trigger source_ref must resolve to one explicit whole document",
                { sourceRef },
              ),
            );
          } else {
            if (
              !isRecord(basis) ||
              basis.source_schema_version !== expectedSourceSchema ||
              source.schemaVersion !== expectedSourceSchema ||
              source.schemaVersion !== basis.source_schema_version
            ) {
              errors.push(
                contractIssue(
                  "contract.ai_trigger_source_schema_mismatch",
                  `${context.path}#/ai_mandatory_coverage/basis/source_schema_version`,
                  "AI trigger source schema must exactly match the installed attestation contract",
                  {
                    actualDocumentSchema: source.schemaVersion,
                    declaredSchema: isRecord(basis) ? basis.source_schema_version : null,
                    expectedSchema: expectedSourceSchema,
                  },
                ),
              );
            }

            const actualSourceHash = canonicalContentHash(source.document);
            if (!isRecord(basis) || basis.source_content_hash !== actualSourceHash) {
              errors.push(
                contractIssue(
                  "contract.ai_trigger_source_hash_stale",
                  `${context.path}#/ai_mandatory_coverage/basis/source_content_hash`,
                  "AI trigger source content changed after the Planning Context binding",
                  {
                    actual: actualSourceHash,
                    declared: isRecord(basis) ? basis.source_content_hash : null,
                  },
                ),
              );
            }

            const contextBinding = source.document.planning_context_binding;
            if (
              source.document.run_id !== context.document.run_id ||
              source.document.mode !== context.document.mode ||
              !isRecord(contextBinding) ||
              contextBinding.context_id !== context.document.context_id ||
              contextBinding.context_revision !== context.document.revision
            ) {
              errors.push(
                contractIssue(
                  "contract.ai_trigger_source_binding_stale",
                  `${source.path}#/planning_context_binding`,
                  "AI trigger source does not bind the current Run, mode, and Planning Context revision",
                ),
              );
            }

            if (!isRecord(basis) || source.document.subject_ref !== basis.subject_ref) {
              errors.push(
                contractIssue(
                  "contract.ai_trigger_source_subject_mismatch",
                  `${source.path}#/subject_ref`,
                  "AI trigger source and Planning Context subject_ref differ",
                  {
                    contextSubjectRef: isRecord(basis) ? basis.subject_ref : null,
                    sourceSubjectRef: source.document.subject_ref,
                  },
                ),
              );
            }

            const sourceTrigger = source.document.trigger;
            if (
              !isRecord(basis) ||
              !isRecord(sourceTrigger) ||
              sourceTrigger.trigger_version !== aiCoverage.trigger_version ||
              sourceTrigger.trigger_version !==
                this.triggerSourcePolicy.contract_versions.trigger ||
              sourceTrigger.signal !== basis.signal ||
              sourceTrigger.declared_value !== basis.declared_value
            ) {
              errors.push(
                contractIssue(
                  "contract.ai_trigger_source_trigger_mismatch",
                  `${source.path}#/trigger`,
                  "AI trigger source and Planning Context trigger declaration differ",
                ),
              );
            }
          }

          const coveredDimensions = new Set<string>();
          for (const unit of unitEntries(plan.document)) {
            if (
              unit.unit_type !== "ai_capability_evidence" ||
              unit.plan_disposition !== "enabled" ||
              !Array.isArray(unit.input_refs) ||
              !unit.input_refs.includes(subjectRef) ||
              !Array.isArray(unit.required_dimensions)
            ) {
              continue;
            }
            for (const dimension of unit.required_dimensions) {
              if (typeof dimension === "string") {
                coveredDimensions.add(dimension);
              }
            }
          }
          const requiredDimensions = Array.isArray(aiCoverage.required_dimensions)
            ? aiCoverage.required_dimensions
            : [];
          const missing = requiredDimensions.filter(
            (dimension) => typeof dimension === "string" && !coveredDimensions.has(dimension),
          );
          if (missing.length > 0) {
            errors.push(
              contractIssue(
                "contract.ai_mandatory_coverage_missing",
                `${context.path}#/ai_mandatory_coverage`,
                "AI mandatory coverage is incomplete for the declared subject",
                { missing },
              ),
            );
          }
        }
      }
    }

    const candidateStage = context?.document.validation_stage === "candidate_revision";
    const decisionBasePlan =
      candidateStage && typeof plan?.document.parent_plan_ref === "string"
        ? refTarget(documentsByPath, plan.document.parent_plan_ref)
        : plan;
    for (const decision of documents.filter((document) =>
      document.schemaVersion.startsWith("startup_opportunity.adaptation_decision."),
    )) {
      if (decision.schemaVersion !== this.adaptationDecisionVersion) {
        errors.push(
          contractIssue(
            "contract.adaptation_version_unsupported",
            decision.path,
            "Adaptation Decision version is not enabled by the selected planning contract",
            { actual: decision.schemaVersion, expected: this.adaptationDecisionVersion },
          ),
        );
        continue;
      }
      if (
        decisionBasePlan !== null &&
        (decision.document.based_on_plan_ref !== decisionBasePlan.path ||
          decision.document.run_id !== decisionBasePlan.document.run_id ||
          decision.document.run_id !== manifest?.document.run_id ||
          manifest?.document.current_plan_ref !== decisionBasePlan.path ||
          manifest.document.plan_revision !== decisionBasePlan.document.revision)
      ) {
        errors.push(
          contractIssue(
            "contract.adaptation_stale_plan",
            `${decision.path}#/based_on_plan_ref`,
            "Adaptation Decision is not based on the manifest current plan",
          ),
        );
      }

      const targetUnit = decision.document.target_unit;
      if (isRecord(targetUnit) && context !== undefined) {
        const targetRule: UnitRule = {
          mode: String(context.document.mode),
          phase: String(context.document.phase),
          unit_type: String(targetUnit.unit_type),
          agent_role: String(targetUnit.agent_role),
          required_artifact_schema: String(targetUnit.required_artifact_schema),
        };
        if (!policyTupleKeys.has(tupleKey(targetRule))) {
          errors.push(
            contractIssue(
              "contract.target_unit_tuple_not_allowed",
              `${decision.path}#/target_unit`,
              "Adaptation target unit tuple is not declared by policy",
              { ...targetRule },
            ),
          );
        }
      }

      if (decision.document.action === "continue_existing_plan") {
        const coverage = refTarget(documentsByPath, decision.document.coverage_attestation_ref);
        const target = unitTarget(documentsByPath, decision.document.target_unit_ref);
        if (
          coverage?.schemaVersion !== "startup_opportunity.coverage_attestation.v1" ||
          target === null ||
          coverage.document.target_unit_ref !== decision.document.target_unit_ref ||
          coverage.document.based_on_plan_ref !== decision.document.based_on_plan_ref ||
          !Array.isArray(decision.document.trigger_gap_refs) ||
          !decision.document.trigger_gap_refs.includes(coverage.document.gap_ref)
        ) {
          errors.push(
            contractIssue(
              "contract.coverage_relation_mismatch",
              `${decision.path}#/coverage_attestation_ref`,
              "continue_existing_plan does not exactly match its coverage attestation",
            ),
          );
        } else if (manifest !== null) {
          const unitId = String(target.unit.unit_id);
          const state = statusOfUnit(manifest.document, unitId);
          const pending = state === "pending" && target.unit.plan_disposition === "enabled";
          if (!pending && state !== "active") {
            errors.push(
              contractIssue(
                "contract.coverage_target_state_not_allowed",
                `${decision.path}#/target_unit_ref`,
                "coverage target must be a pending or active unit",
                { state },
              ),
            );
          }
        }
      }

      if (decision.document.action === "retry_unit") {
        const target = unitTarget(documentsByPath, decision.document.target_unit_ref);
        const retryBasis = decision.document.retry_basis;
        const targetUnitId = target === null ? null : String(target.unit.unit_id);
        const state =
          manifest === null || targetUnitId === null
            ? "unresolved"
            : statusOfUnit(manifest.document, targetUnitId);
        if (
          target === null ||
          manifest === null ||
          !isRecord(retryBasis) ||
          retryBasis.kind !== "manifest_failed_unit" ||
          retryBasis.manifest_ref !== manifest.path ||
          retryBasis.unit_id !== targetUnitId ||
          retryBasis.manifest_state !== "failed" ||
          state !== "failed"
        ) {
          errors.push(
            contractIssue(
              "contract.retry_target_not_failed",
              `${decision.path}#/retry_basis`,
              "retry_unit requires exact membership in Run Manifest failed_units",
              { state },
            ),
          );
        }
      }
    }

    const contractErrors = sortIssues(errors);
    return {
      schemaVersion: PLANNING_CONTRACT_RESULT_VERSION,
      schemaBundleVersion: documentBundle.schemaBundleVersion,
      policyVersion: this.policy.policy_version,
      triggerSourcePolicyVersion: this.triggerSourcePolicy.policy_version,
      valid:
        documentBundle.valid &&
        this.policyValidation.valid &&
        this.triggerSourcePolicyValidation.valid &&
        contractErrors.length === 0,
      documentBundle,
      policyValidation: this.policyValidation,
      triggerSourcePolicyValidation: this.triggerSourcePolicyValidation,
      contractErrors,
    };
  }
}

export async function createPlanningContractEvaluator(
  root = process.cwd(),
): Promise<PlanningContractEvaluator> {
  const artifactValidator = await createArtifactValidator(
    root,
    "harness/schemas/bundle.v2.1.json",
    "2.1.0",
  );
  const policy = JSON.parse(
    await readFile(path.join(root, ADAPTATION_POLICY_PATH), "utf8"),
  ) as unknown;
  const policyValidation = artifactValidator.validateDocument(policy, ADAPTATION_POLICY_PATH);
  if (!policyValidation.valid || !isRecord(policy)) {
    throw new Error(`adaptation policy is invalid: ${JSON.stringify(policyValidation.errors)}`);
  }
  const triggerSourcePolicy = JSON.parse(
    await readFile(path.join(root, AI_TRIGGER_SOURCE_POLICY_PATH), "utf8"),
  ) as unknown;
  const triggerSourcePolicyValidation = artifactValidator.validateDocument(
    triggerSourcePolicy,
    AI_TRIGGER_SOURCE_POLICY_PATH,
  );
  if (!triggerSourcePolicyValidation.valid || !isRecord(triggerSourcePolicy)) {
    throw new Error(
      `AI trigger source policy is invalid: ${JSON.stringify(triggerSourcePolicyValidation.errors)}`,
    );
  }
  return new PlanningContractEvaluator(
    artifactValidator,
    policy as AdaptationPolicy,
    policyValidation,
    triggerSourcePolicy as AiTriggerSourceBindingPolicy,
    triggerSourcePolicyValidation,
  );
}

export async function createAssessmentPlanningContractEvaluator(
  root = process.cwd(),
): Promise<PlanningContractEvaluator> {
  const artifactValidator = await createArtifactValidator(root);
  const policy = JSON.parse(
    await readFile(path.join(root, ADAPTATION_POLICY_PATH), "utf8"),
  ) as unknown;
  const policyValidation = artifactValidator.validateDocument(policy, ADAPTATION_POLICY_PATH);
  if (!policyValidation.valid || !isRecord(policy)) {
    throw new Error(`adaptation policy is invalid: ${JSON.stringify(policyValidation.errors)}`);
  }
  const triggerSourcePolicy = JSON.parse(
    await readFile(path.join(root, ASSESSMENT_AI_TRIGGER_SOURCE_POLICY_PATH), "utf8"),
  ) as unknown;
  const triggerSourcePolicyValidation = artifactValidator.validateDocument(
    triggerSourcePolicy,
    ASSESSMENT_AI_TRIGGER_SOURCE_POLICY_PATH,
  );
  if (!triggerSourcePolicyValidation.valid || !isRecord(triggerSourcePolicy)) {
    throw new Error(
      `assessment AI trigger source policy is invalid: ${JSON.stringify(triggerSourcePolicyValidation.errors)}`,
    );
  }
  return new PlanningContractEvaluator(
    artifactValidator,
    policy as AdaptationPolicy,
    policyValidation,
    triggerSourcePolicy as AiTriggerSourceBindingPolicy,
    triggerSourcePolicyValidation,
    "startup_opportunity.adaptation_decision.v3",
  );
}

import { canonicalContentHash, operationKey, sha256Hex } from "../artifact-store/canonical.js";
import { formalArtifactFragmentExists } from "../validators/artifact-ref-resolver.js";
import type {
  DocumentBundle,
  DocumentBundleReferenceContext,
} from "../validators/artifact-validator.js";
import {
  type ArtifactValidator,
  createArtifactValidator,
} from "../validators/artifact-validator.js";
import {
  documentMap,
  type EffectiveDocument,
  fragmentOf,
  isRecord,
  leafPlanningContexts,
  targetByRef,
  unitEntries,
} from "./contracts.js";
import { currentPlanningProjection } from "./current-planning-projection.js";
import {
  createPlanSemanticValidator,
  type PlanSemanticValidator,
  type PlanValidationResult,
} from "./plan-validator.js";

export const GAP_ANALYSIS_RESULT_VERSION = "startup_opportunity.gap_analysis_result.v1" as const;

const AGENT_DECLARED_GAP_TYPES = new Set([
  "mandatory_dimension_missing",
  "evidence_insufficient",
  "evidence_conflict",
  "baseline_unclear",
  "buyer_evidence_insufficient",
  "acquisition_evidence_insufficient",
  "freshness_failed",
  "reviewer_challenge",
  "candidate_pre_killed",
  "unit_failed",
  "runtime_blocked",
  "scope_invalidated",
  "user_plan_change_requested",
  "source_repetition",
  "no_material_new_evidence",
]);

export interface AgentDeclaredGap {
  readonly declarationId: string;
  readonly gapType: string;
  readonly subjectRef: string;
  readonly basisRefs: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly decisionImpact: readonly string[];
  readonly severity: "blocking" | "material" | "advisory";
  readonly recommendedUnitTypes?: readonly string[];
  readonly detail: string;
}

export interface AnalyzeGapsInput {
  readonly documentBundle: DocumentBundle;
  readonly referenceContext?: DocumentBundleReferenceContext;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly triggerKind:
    | "wave_completed"
    | "user_decision"
    | "artifact_validation_failed"
    | "adversarial_review_completed"
    | "resume_reconciliation";
  readonly phase: string;
  readonly waveId: string | null;
  readonly triggerEventRef: string | null;
  readonly observedArtifactRefs: readonly string[];
  readonly materialNewEvidenceObserved: boolean;
  readonly repeatedSourceRefs?: readonly string[];
  readonly agentDeclaredGaps?: readonly AgentDeclaredGap[];
}

export interface GapAnalysisResult {
  readonly schemaVersion: typeof GAP_ANALYSIS_RESULT_VERSION;
  readonly valid: boolean;
  readonly planValidation: PlanValidationResult;
  readonly snapshot: Record<string, unknown> | null;
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
  }[];
}

function analysisError(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
) {
  return { code, message, details } as const;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function gapId(kind: string, identity: unknown): string {
  return `gap_${kind}_${sha256Hex(operationKey("machine_gap", identity)).slice(0, 16)}`;
}

function pathLikeRef(ref: string): boolean {
  const targetPath = ref.split("#", 1)[0] ?? "";
  return targetPath.includes("/") || targetPath.endsWith(".json") || targetPath.endsWith(".jsonl");
}

function fragmentExists(target: EffectiveDocument, fragment: string): boolean {
  return formalArtifactFragmentExists(target, fragment);
}

function exactRecordMap(input: AnalyzeGapsInput): ReadonlyMap<string, Record<string, unknown>> {
  const records = new Map(
    (input.documentBundle.exact_records ?? []).map((entry) => [entry.ref, entry.document]),
  );
  for (const [ref, record] of input.referenceContext?.exactJsonlRecords ?? []) {
    records.set(ref, record);
  }
  return records;
}

export function deriveSolutionExplorationObservations(
  documents: ReadonlyMap<string, EffectiveDocument>,
  observedRefs: readonly string[],
): readonly Record<string, unknown>[] {
  const observedPaths = new Set(observedRefs.map((ref) => ref.split("#", 1)[0] ?? ref));
  const observedOpportunities = [...documents.values()].filter(
    (entry) =>
      entry.schemaVersion === "startup_opportunity.opportunity_thesis.v1" &&
      observedPaths.has(entry.path),
  );
  const observedEvaluationRefs = new Set(
    observedOpportunities.flatMap((opportunity) =>
      typeof opportunity.document.solution_evaluation_ref === "string"
        ? [opportunity.document.solution_evaluation_ref]
        : [],
    ),
  );
  const evaluations = [...documents.values()].filter(
    (entry) =>
      entry.schemaVersion === "startup_opportunity.solution_evaluation.v1" &&
      (observedPaths.has(entry.path) || observedEvaluationRefs.has(entry.path)),
  );
  return evaluations
    .map((evaluation) => {
      const exploration = isRecord(evaluation.document.solution_exploration)
        ? evaluation.document.solution_exploration
        : {};
      const opportunityRefs = observedOpportunities
        .filter((opportunity) => opportunity.document.solution_evaluation_ref === evaluation.path)
        .map((opportunity) => opportunity.path)
        .sort();
      return {
        solution_evaluation_ref: evaluation.path,
        solution_evaluation_content_hash:
          evaluation.envelope?.content_hash ?? canonicalContentHash(evaluation.document),
        opportunity_refs: opportunityRefs,
        exploration_status: exploration.status,
        selection_posture:
          exploration.status === "compared_multiple_formal_solutions"
            ? "compared_selection"
            : "provisional_implementation",
        planning_effect: "main_agent_decides_whether_to_adapt",
      };
    })
    .sort((left, right) =>
      String(left.solution_evaluation_ref).localeCompare(String(right.solution_evaluation_ref)),
    );
}

export class GapAnalyzer {
  constructor(
    private readonly plans: PlanSemanticValidator,
    private readonly artifacts: ArtifactValidator,
  ) {}

  analyze(input: AnalyzeGapsInput): GapAnalysisResult {
    const planningValue = currentPlanningProjection(input.documentBundle);
    const planValidation = this.plans.validateDocumentBundle(planningValue, input.referenceContext);
    const errors: ReturnType<typeof analysisError>[] = [];
    if (!planValidation.valid) {
      errors.push(
        analysisError("gap.plan_invalid", "Gap analysis requires a valid current plan bundle"),
      );
    }

    const documents = documentMap(planningValue);
    const context = leafPlanningContexts(planningValue)[0];
    const manifestBinding = context?.document.manifest_binding;
    const targetBinding = context?.document.target_plan_binding;
    const manifest = isRecord(manifestBinding)
      ? targetByRef(documents, manifestBinding.manifest_ref)
      : null;
    const plan = isRecord(targetBinding) ? targetByRef(documents, targetBinding.plan_ref) : null;
    const exactRecords = exactRecordMap(input);
    const scopeReconciliation = input.triggerKind === "resume_reconciliation";
    if (
      context === undefined ||
      manifest?.schemaVersion !== "startup_opportunity.run_manifest.v1" ||
      plan?.schemaVersion !== "startup_opportunity.research_plan.v1"
    ) {
      errors.push(
        analysisError(
          "gap.state_missing",
          "Gap analysis requires one current Planning Context, Manifest, and Research Plan",
        ),
      );
    }

    if (input.triggerKind === "wave_completed") {
      if (input.waveId === null || input.triggerEventRef !== null) {
        errors.push(
          analysisError(
            "gap.trigger_shape_invalid",
            "wave_completed requires waveId and forbids triggerEventRef",
          ),
        );
      }
    } else if (input.triggerEventRef === null) {
      errors.push(
        analysisError(
          "gap.trigger_shape_invalid",
          "event-driven analysis requires triggerEventRef",
        ),
      );
    }

    if (context !== undefined && input.phase !== context.document.phase) {
      errors.push(
        analysisError("gap.phase_mismatch", "analysis phase differs from Planning Context", {
          contextPhase: context.document.phase,
          analysisPhase: input.phase,
        }),
      );
    }
    if (plan !== null && input.waveId !== null) {
      const waveExists =
        Array.isArray(plan.document.waves) &&
        plan.document.waves.some((wave) => isRecord(wave) && wave.wave_id === input.waveId);
      if (!waveExists) {
        errors.push(
          analysisError("gap.wave_missing", "analysis wave is not declared by the current plan", {
            waveId: input.waveId,
          }),
        );
      }
    }

    const refsToResolve = [
      ...input.observedArtifactRefs,
      ...(input.repeatedSourceRefs ?? []),
      ...(input.agentDeclaredGaps ?? []).flatMap((gap) => [
        gap.subjectRef,
        ...gap.basisRefs,
        ...(gap.evidenceRefs ?? []),
      ]),
      ...(input.triggerEventRef === null ? [] : [input.triggerEventRef]),
    ];
    for (const ref of uniqueSorted(refsToResolve)) {
      const targetPath = ref.split("#", 1)[0] ?? "";
      if (!pathLikeRef(ref)) {
        continue;
      }
      const target = documents.get(targetPath);
      const exactRecord = exactRecords.get(ref);
      if (target === undefined && exactRecord === undefined) {
        errors.push(analysisError("gap.reference_missing", "input ref is absent", { ref }));
        continue;
      }
      if (exactRecord !== undefined) {
        if (
          manifest?.schemaVersion === "startup_opportunity.run_manifest.v1" &&
          exactRecord.run_id !== manifest.document.run_id
        ) {
          errors.push(
            analysisError(
              "gap.reference_run_mismatch",
              "input ref crosses the current Run boundary",
              {
                ref,
                targetRunId: exactRecord.run_id,
                currentRunId: manifest.document.run_id,
              },
            ),
          );
        }
        continue;
      }
      if (target === undefined) continue;
      const fragment = fragmentOf(ref);
      if (fragment !== null && !fragmentExists(target, fragment)) {
        errors.push(
          analysisError(
            "gap.reference_fragment_missing",
            "input ref fragment does not identify an exact target record",
            { ref, targetSchemaVersion: target.schemaVersion },
          ),
        );
      }
      if (
        manifest?.schemaVersion === "startup_opportunity.run_manifest.v1" &&
        typeof target.document.run_id === "string" &&
        target.document.run_id !== manifest.document.run_id
      ) {
        errors.push(
          analysisError(
            "gap.reference_run_mismatch",
            "input ref crosses the current Run boundary",
            {
              ref,
              targetRunId: target.document.run_id,
              currentRunId: manifest.document.run_id,
            },
          ),
        );
      }
    }

    const triggerEvent =
      input.triggerEventRef === null
        ? undefined
        : (exactRecords.get(input.triggerEventRef) ??
          targetByRef(documents, input.triggerEventRef)?.document);
    if (input.triggerEventRef !== null) {
      if (
        input.triggerEventRef.split("#", 1)[0]?.endsWith(".jsonl") &&
        fragmentOf(input.triggerEventRef) === null
      ) {
        errors.push(
          analysisError(
            "gap.reference_fragment_missing",
            "triggerEventRef must identify one exact Event record",
            { ref: input.triggerEventRef },
          ),
        );
      }
      if (
        triggerEvent !== undefined &&
        triggerEvent?.schema_version !== "startup_opportunity.event.v1"
      ) {
        errors.push(
          analysisError(
            "gap.trigger_event_type_mismatch",
            "triggerEventRef must resolve to startup_opportunity.event.v1",
            {
              ref: input.triggerEventRef,
              actualSchemaVersion: triggerEvent.schema_version,
            },
          ),
        );
      }
    }

    for (const gap of input.agentDeclaredGaps ?? []) {
      if (
        !AGENT_DECLARED_GAP_TYPES.has(gap.gapType) ||
        gap.declarationId.length === 0 ||
        gap.basisRefs.length === 0
      ) {
        errors.push(
          analysisError(
            "gap.agent_declaration_invalid",
            "agent-declared gaps require a declaration id, current gap type, and basis refs",
            { declarationId: gap.declarationId, gapType: gap.gapType },
          ),
        );
      }
    }

    if (
      scopeReconciliation &&
      (input.observedArtifactRefs.length !== 0 ||
        input.materialNewEvidenceObserved ||
        (input.repeatedSourceRefs?.length ?? 0) !== 0 ||
        (input.agentDeclaredGaps?.length ?? 0) !== 0)
    ) {
      errors.push(
        analysisError(
          "gap.scope_reconciliation_input_invalid",
          "Scope reconciliation is Evidence-free and derives its single Gap mechanically",
        ),
      );
    }
    const confirmationRef = manifest?.document.scope_confirmation_ref;
    const confirmation =
      typeof confirmationRef === "string" ? exactRecords.get(confirmationRef) : undefined;
    if (
      scopeReconciliation &&
      (manifest?.document.status !== "needs_clarification" ||
        confirmation?.schema_version !== "startup_opportunity.decision.v1" ||
        confirmation.decision_type !== "scope_changed_by_user" ||
        confirmation.run_id !== manifest.document.run_id ||
        confirmation.scope_revision !== manifest.document.scope_revision ||
        canonicalContentHash(confirmation) !== manifest.document.scope_confirmation_hash)
    ) {
      errors.push(
        analysisError(
          "gap.scope_reconciliation_confirmation_invalid",
          "Scope reconciliation requires the exact current same-Run Scope confirmation",
        ),
      );
    }

    if (errors.length > 0 || manifest === null || plan === null) {
      return {
        schemaVersion: GAP_ANALYSIS_RESULT_VERSION,
        valid: false,
        planValidation,
        snapshot: null,
        errors,
      };
    }

    const observedRefs = uniqueSorted(input.observedArtifactRefs);
    const observedArtifacts = observedRefs.map((ref) => {
      const target = documents.get(ref.split("#", 1)[0] ?? "");
      return {
        ref,
        content_hash:
          target === undefined ? `missing:${ref}` : canonicalContentHash(target.document),
      };
    });
    const cycleKey = operationKey("gap_snapshot_cycle", {
      base_plan: {
        ref: plan.path,
        content_hash: canonicalContentHash(plan.document),
      },
      trigger:
        input.triggerKind === "wave_completed"
          ? { kind: input.triggerKind, wave_id: input.waveId }
          : {
              kind: input.triggerKind,
              event_ref: input.triggerEventRef,
              event_id: triggerEvent?.event_id ?? null,
            },
      observed_artifacts: observedArtifacts,
    });
    const prior =
      typeof manifest.document.latest_gap_snapshot_ref === "string"
        ? targetByRef(documents, manifest.document.latest_gap_snapshot_ref)
        : null;
    const priorSameCycle =
      prior?.schemaVersion === "startup_opportunity.gap_snapshot.discovery.plan.current" &&
      prior.document.snapshot_cycle_key === cycleKey;
    const revision = priorSameCycle ? Number(prior.document.revision) + 1 : 1;
    const parentSnapshotRef = priorSameCycle ? manifest.document.latest_gap_snapshot_ref : null;
    const gaps: Record<string, unknown>[] = [];

    if (scopeReconciliation && typeof confirmationRef === "string") {
      gaps.push({
        gap_id: gapId("scope_invalidated", {
          plan_ref: plan.path,
          plan_hash: canonicalContentHash(plan.document),
          scope_confirmation_ref: confirmationRef,
          scope_confirmation_hash: manifest.document.scope_confirmation_hash,
        }),
        subject_ref: plan.path,
        gap_type: "scope_invalidated",
        detection_mode: "deterministic",
        triggered_by: {
          check_id: "confirmed_scope_revision",
          observed_artifact_refs: [],
          detail: "The exact confirmed Scope revision invalidates the current Plan authority.",
        },
        decision_impact: ["execution_validity"],
        severity: "blocking",
        basis_refs: ["manifest.json", plan.path, confirmationRef].sort(),
        evidence_refs: [],
        recommended_unit_types: [],
      });
    }

    const units = unitEntries(plan.document);
    const unitsById = new Map(units.map((entry) => [String(entry.unit.unit_id), entry.unit]));
    for (const unitId of scopeReconciliation
      ? []
      : uniqueSorted(
          Array.isArray(manifest.document.failed_units)
            ? manifest.document.failed_units.filter((id): id is string => typeof id === "string")
            : [],
        )) {
      const unit = unitsById.get(unitId);
      if (unit === undefined) {
        errors.push(
          analysisError(
            "gap.failed_unit_missing",
            "Manifest failed unit is absent from current plan",
            {
              unitId,
            },
          ),
        );
        continue;
      }
      const subjectRef = `${plan.path}#${unitId}`;
      gaps.push({
        gap_id: gapId("unit_failed", { plan: plan.path, unit_id: unitId }),
        subject_ref: subjectRef,
        gap_type: "unit_failed",
        detection_mode: "deterministic",
        triggered_by: {
          check_id: `manifest_failed_${unitId}`,
          observed_artifact_refs: observedRefs,
          detail: "Run Manifest records the unit in failed_units.",
        },
        decision_impact: ["execution_validity"],
        severity: "blocking",
        basis_refs: ["manifest.json", subjectRef],
        evidence_refs: [],
        recommended_unit_types: [unit.unit_type],
      });
    }

    if (!scopeReconciliation && !input.materialNewEvidenceObserved) {
      gaps.push({
        gap_id: gapId("no_new_evidence", { cycle_key: cycleKey }),
        subject_ref: plan.path,
        gap_type: "no_material_new_evidence",
        detection_mode: "deterministic",
        triggered_by: {
          check_id: "material_new_evidence_observed",
          observed_artifact_refs: observedRefs,
          detail: "The explicit material_new_evidence_observed flag is false.",
        },
        decision_impact: ["next_action"],
        severity: "material",
        basis_refs: observedRefs.length > 0 ? observedRefs : [plan.path],
        evidence_refs: [],
        recommended_unit_types: [],
      });
    }

    const repeatedSourceRefs = uniqueSorted(input.repeatedSourceRefs ?? []);
    if (!scopeReconciliation && repeatedSourceRefs.length > 0) {
      gaps.push({
        gap_id: gapId("source_repetition", { refs: repeatedSourceRefs }),
        subject_ref: plan.path,
        gap_type: "source_repetition",
        detection_mode: "deterministic",
        triggered_by: {
          check_id: "explicit_repeated_source_refs",
          observed_artifact_refs: repeatedSourceRefs,
          detail: "The validated source inventory reports repeated source refs.",
        },
        decision_impact: ["next_action"],
        severity: "material",
        basis_refs: repeatedSourceRefs,
        evidence_refs: repeatedSourceRefs,
        recommended_unit_types: [],
      });
    }

    for (const declaration of [
      ...(scopeReconciliation ? [] : (input.agentDeclaredGaps ?? [])),
    ].sort((left, right) => left.declarationId.localeCompare(right.declarationId))) {
      gaps.push({
        gap_id: gapId(declaration.gapType, {
          declaration_id: declaration.declarationId,
          subject_ref: declaration.subjectRef,
        }),
        subject_ref: declaration.subjectRef,
        gap_type: declaration.gapType,
        detection_mode: "agent_semantic",
        triggered_by: {
          declaration_id: declaration.declarationId,
          declared_by: "main_agent",
          observed_artifact_refs: observedRefs,
          detail: declaration.detail,
        },
        decision_impact: uniqueSorted(declaration.decisionImpact),
        severity: declaration.severity,
        basis_refs: uniqueSorted(declaration.basisRefs),
        evidence_refs: uniqueSorted(declaration.evidenceRefs ?? []),
        recommended_unit_types: uniqueSorted(declaration.recommendedUnitTypes ?? []),
      });
    }

    const stopSignals: string[] = [];
    const followup = plan.document.followup_policy;
    if (
      !scopeReconciliation &&
      isRecord(followup) &&
      typeof followup.max_followup_rounds === "number" &&
      typeof manifest.document.followup_round === "number" &&
      manifest.document.followup_round >= followup.max_followup_rounds
    ) {
      stopSignals.push("max_followup_rounds_reached");
    }
    if (!scopeReconciliation && !input.materialNewEvidenceObserved) {
      stopSignals.push("no_material_new_evidence");
    }
    if (!scopeReconciliation && repeatedSourceRefs.length > 0) {
      stopSignals.push("source_repetition");
    }
    if (
      !scopeReconciliation &&
      (input.agentDeclaredGaps ?? []).some((gap) => gap.gapType === "runtime_blocked")
    ) {
      stopSignals.push("runtime_blocked");
    }

    const snapshot: Record<string, unknown> = {
      schema_version: "startup_opportunity.gap_snapshot.discovery.plan.current",
      snapshot_id: input.snapshotId,
      snapshot_cycle_key: cycleKey,
      run_id: manifest.document.run_id,
      based_on_plan_ref: plan.path,
      revision,
      parent_snapshot_ref: parentSnapshotRef,
      created_at: input.createdAt,
      trigger_kind: input.triggerKind,
      trigger_event_ref: input.triggerEventRef,
      phase: input.phase,
      wave_id: input.waveId,
      observed_artifact_refs: observedRefs,
      solution_exploration_observations: deriveSolutionExplorationObservations(
        documents,
        observedRefs,
      ),
      gaps: gaps.sort((left, right) => String(left.gap_id).localeCompare(String(right.gap_id))),
      material_new_evidence_observed: scopeReconciliation
        ? false
        : input.materialNewEvidenceObserved,
      unresolved_decision_relevant_questions: Array.isArray(plan.document.research_questions)
        ? plan.document.research_questions
            .filter(isRecord)
            .map((question) => String(question.question_id))
            .sort()
        : [],
      stop_signals: scopeReconciliation ? [] : uniqueSorted(stopSignals),
    };
    const schemaValidation = this.artifacts.validateDocument(snapshot);
    if (!schemaValidation.valid) {
      errors.push(
        analysisError(
          "gap.draft_schema_invalid",
          "generated Gap Snapshot failed schema validation",
          {
            errors: schemaValidation.errors,
          },
        ),
      );
    }
    return {
      schemaVersion: GAP_ANALYSIS_RESULT_VERSION,
      valid: errors.length === 0,
      planValidation,
      snapshot: errors.length === 0 ? snapshot : null,
      errors,
    };
  }
}

export async function createGapAnalyzer(root = process.cwd()): Promise<GapAnalyzer> {
  return new GapAnalyzer(
    await createPlanSemanticValidator(root),
    await createArtifactValidator(root),
  );
}

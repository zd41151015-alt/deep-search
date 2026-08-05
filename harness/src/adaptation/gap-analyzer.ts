import { canonicalContentHash, operationKey, sha256Hex } from "../artifact-store/canonical.js";
import { formalArtifactFragmentExists } from "../validators/artifact-ref-resolver.js";
import type { DocumentBundle } from "../validators/artifact-validator.js";
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
import {
  createPlanSemanticValidator,
  type PlanSemanticValidator,
  type PlanValidationResult,
} from "./plan-validator.js";

export const GAP_ANALYSIS_RESULT_VERSION = "startup_opportunity.gap_analysis_result.v1" as const;

const MACHINE_GAP_TYPES = new Set([
  "mandatory_dimension_missing",
  "freshness_failed",
  "runtime_blocked",
  "scope_invalidated",
  "user_plan_change_requested",
]);

export interface MachineGapCheck {
  readonly checkId: string;
  readonly gapType:
    | "mandatory_dimension_missing"
    | "freshness_failed"
    | "runtime_blocked"
    | "scope_invalidated"
    | "user_plan_change_requested";
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
  readonly machineChecks?: readonly MachineGapCheck[];
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

export class GapAnalyzer {
  constructor(
    private readonly plans: PlanSemanticValidator,
    private readonly artifacts: ArtifactValidator,
  ) {}

  analyze(input: AnalyzeGapsInput): GapAnalysisResult {
    const planValidation = this.plans.validateDocumentBundle(input.documentBundle);
    const errors: ReturnType<typeof analysisError>[] = [];
    if (!planValidation.valid) {
      errors.push(
        analysisError("gap.plan_invalid", "Gap analysis requires a valid current plan bundle"),
      );
    }

    const documents = documentMap(input.documentBundle);
    const context = leafPlanningContexts(input.documentBundle)[0];
    const manifestBinding = context?.document.manifest_binding;
    const targetBinding = context?.document.target_plan_binding;
    const manifest = isRecord(manifestBinding)
      ? targetByRef(documents, manifestBinding.manifest_ref)
      : null;
    const plan = isRecord(targetBinding) ? targetByRef(documents, targetBinding.plan_ref) : null;
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
      ...(input.machineChecks ?? []).flatMap((check) => [
        check.subjectRef,
        ...check.basisRefs,
        ...(check.evidenceRefs ?? []),
      ]),
      ...(input.triggerEventRef === null ? [] : [input.triggerEventRef]),
    ];
    for (const ref of uniqueSorted(refsToResolve)) {
      const targetPath = ref.split("#", 1)[0] ?? "";
      if (!pathLikeRef(ref)) {
        continue;
      }
      const target = documents.get(targetPath);
      if (target === undefined) {
        errors.push(analysisError("gap.reference_missing", "machine input ref is absent", { ref }));
        continue;
      }
      const fragment = fragmentOf(ref);
      if (fragment !== null && !fragmentExists(target, fragment)) {
        errors.push(
          analysisError(
            "gap.reference_fragment_missing",
            "machine input ref fragment does not identify an exact target record",
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
            "machine input ref crosses the current Run boundary",
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
      input.triggerEventRef === null ? null : targetByRef(documents, input.triggerEventRef);
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
      if (triggerEvent !== null && triggerEvent.schemaVersion !== "startup_opportunity.event.v1") {
        errors.push(
          analysisError(
            "gap.trigger_event_type_mismatch",
            "triggerEventRef must resolve to startup_opportunity.event.v1",
            {
              ref: input.triggerEventRef,
              actualSchemaVersion: triggerEvent.schemaVersion,
            },
          ),
        );
      }
    }

    for (const check of input.machineChecks ?? []) {
      if (!MACHINE_GAP_TYPES.has(check.gapType) || check.basisRefs.length === 0) {
        errors.push(
          analysisError(
            "gap.machine_check_invalid",
            "machine checks require a closed deterministic gap type and basis refs",
            { checkId: check.checkId, gapType: check.gapType },
          ),
        );
      }
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
              event_id: triggerEvent?.document.event_id ?? null,
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

    const units = unitEntries(plan.document);
    const unitsById = new Map(units.map((entry) => [String(entry.unit.unit_id), entry.unit]));
    for (const unitId of uniqueSorted(
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

    if (!input.materialNewEvidenceObserved) {
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
    if (repeatedSourceRefs.length > 0) {
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

    for (const check of [...(input.machineChecks ?? [])].sort((left, right) =>
      left.checkId.localeCompare(right.checkId),
    )) {
      gaps.push({
        gap_id: gapId(check.gapType, { check_id: check.checkId, subject_ref: check.subjectRef }),
        subject_ref: check.subjectRef,
        gap_type: check.gapType,
        detection_mode: "deterministic",
        triggered_by: {
          check_id: check.checkId,
          observed_artifact_refs: observedRefs,
          detail: check.detail,
        },
        decision_impact: uniqueSorted(check.decisionImpact),
        severity: check.severity,
        basis_refs: uniqueSorted(check.basisRefs),
        evidence_refs: uniqueSorted(check.evidenceRefs ?? []),
        recommended_unit_types: uniqueSorted(check.recommendedUnitTypes ?? []),
      });
    }

    const stopSignals: string[] = [];
    const followup = plan.document.followup_policy;
    if (
      isRecord(followup) &&
      typeof followup.max_followup_rounds === "number" &&
      typeof manifest.document.followup_round === "number" &&
      manifest.document.followup_round >= followup.max_followup_rounds
    ) {
      stopSignals.push("max_followup_rounds_reached");
    }
    if (!input.materialNewEvidenceObserved) {
      stopSignals.push("no_material_new_evidence");
    }
    if (repeatedSourceRefs.length > 0) {
      stopSignals.push("source_repetition");
    }
    if ((input.machineChecks ?? []).some((check) => check.gapType === "runtime_blocked")) {
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
      gaps: gaps.sort((left, right) => String(left.gap_id).localeCompare(String(right.gap_id))),
      material_new_evidence_observed: input.materialNewEvidenceObserved,
      unresolved_decision_relevant_questions: Array.isArray(plan.document.research_questions)
        ? plan.document.research_questions
            .filter(isRecord)
            .map((question) => String(question.question_id))
            .sort()
        : [],
      stop_signals: uniqueSorted(stopSignals),
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

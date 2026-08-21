import path from "node:path";
import type { FormalArtifactEnvelope } from "../artifact-store/artifact-store.js";
import {
  canonicalContentHash,
  canonicalJson,
  operationKey,
  sha256Hex,
} from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import { type BeliefSummary, type RunManifest, RunStore } from "../run-store/run-store.js";
import {
  type ArtifactValidator,
  artifactRefsForDocument,
  createArtifactValidator,
  type DocumentBundle,
  type DocumentBundleReferenceContext,
} from "../validators/artifact-validator.js";
import { planningRunStateHash } from "../validators/planning-contract-identities.js";
import { createAdaptationPolicyValidator } from "./adaptation-validator.js";
import {
  documentMap,
  type EffectiveDocument,
  effectiveDocuments,
  isRecord,
  leafPlanningContexts,
  unitEntries,
} from "./contracts.js";
import { type AgentDeclaredGap, createGapAnalyzer } from "./gap-analyzer.js";
import {
  createPlanRevisionRuntime,
  type PlanApplyFaultBoundary,
  type PlanApplyResult,
} from "./plan-runtime.js";
import { transformPlan } from "./plan-transformer.js";
import { createPlanSemanticValidator } from "./plan-validator.js";

export const ADAPTATION_AUTHOR_REQUEST_VERSION =
  "startup_opportunity.adaptation_author_request.current" as const;
export const ADAPTATION_AUTHOR_RESULT_VERSION =
  "startup_opportunity.adaptation_author_result.current" as const;

export interface AdaptationAuthorRequest extends Record<string, unknown> {
  readonly schema_version: typeof ADAPTATION_AUTHOR_REQUEST_VERSION;
  readonly request_id: string;
  readonly run_id: string;
  readonly operation: "validate_only" | "publish" | "apply";
  readonly publication_plan?: Record<string, unknown>;
  readonly top_level_formal_refs: readonly string[];
  readonly gap: Record<string, unknown>;
  readonly decisions: readonly Record<string, unknown>[];
  readonly apply_created_at: string;
  readonly checkpoint_created_at: string;
  readonly next_phase: "discovery" | "enrichment" | "review";
  readonly next_step: string;
  readonly belief_summary: BeliefSummary;
  readonly terminal_report_envelope?: FormalArtifactEnvelope;
}

export interface AdaptationAuthorResult extends Record<string, unknown> {
  readonly schema_version: typeof ADAPTATION_AUTHOR_RESULT_VERSION;
  readonly request_id: string;
  readonly run_id: string;
  readonly operation: AdaptationAuthorRequest["operation"];
  readonly status: "validated" | "published" | "applied" | "idempotent_replay";
  readonly base_manifest_content_hash: string;
  readonly result_manifest_content_hash: string;
  readonly base_plan_ref: string;
  readonly base_plan_content_hash: string;
  readonly planning_run_state_hash: string;
  readonly gap_envelope: FormalArtifactEnvelope;
  readonly adaptation_envelopes: readonly FormalArtifactEnvelope[];
  readonly candidate_bundle: DocumentBundle | null;
  readonly plan_diff: Record<string, unknown>;
  readonly publication_plan: Record<string, unknown>;
  readonly publication_result: Record<string, unknown> | null;
  readonly apply_result: PlanApplyResult | null;
}

export interface AdaptationAuthorExecutionOptions {
  readonly faultAt?: PlanApplyFaultBoundary;
}

interface PreparedAuthorOperation {
  readonly manifest: RunManifest;
  readonly basePlanPath: string;
  readonly basePlan: Record<string, unknown>;
  readonly adaptationBundle: DocumentBundle;
  readonly referenceContext: DocumentBundleReferenceContext;
  readonly gapEnvelope: FormalArtifactEnvelope;
  readonly adaptationEnvelopes: readonly FormalArtifactEnvelope[];
  readonly candidateBundle: DocumentBundle | null;
  readonly planDiff: Record<string, unknown>;
  readonly publicationPlan: Record<string, unknown>;
  readonly baseManifestContentHash?: string;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function requestContentHash(request: AdaptationAuthorRequest): string {
  const semantic = structuredClone(request) as Record<string, unknown>;
  delete semantic.operation;
  delete semantic.publication_plan;
  return canonicalContentHash(semantic);
}

function assertPublicationPlanIdentity(
  request: AdaptationAuthorRequest,
  publicationPlan: Record<string, unknown>,
): void {
  const { plan_id: suppliedPlanId, ...identity } = publicationPlan;
  const expectedPlanId = operationKey("adaptation_author_publication_plan", identity);
  if (
    publicationPlan.request_content_hash !== requestContentHash(request) ||
    suppliedPlanId !== expectedPlanId
  ) {
    throw new StoreError(
      "adaptation.author_publication_plan_stale",
      "publication plan does not bind the exact authored semantics",
      { suppliedPlanId, expectedPlanId },
    );
  }
}

function artifactPath(ref: string): string {
  return ref.split("#", 1)[0] ?? ref;
}

function adaptationPath(adaptationId: string): string {
  return `adaptations/decisions/${adaptationId}.json`;
}

function envelope(
  runId: string,
  artifactPathValue: string,
  document: Record<string, unknown>,
  producerRole: "harness" | "main_agent",
  inputRefs: readonly string[],
): FormalArtifactEnvelope {
  return {
    schema_version: "startup_opportunity.artifact_envelope.current",
    artifact_type: String(document.schema_version),
    artifact_path: artifactPathValue,
    run_id: runId,
    created_at: String(document.created_at),
    producer_role: producerRole,
    input_refs: uniqueSorted(inputRefs),
    content_hash: canonicalContentHash(document),
    document,
  };
}

function agentDeclaredGaps(value: unknown): readonly AgentDeclaredGap[] {
  return records(value).map((gap) => ({
    declarationId: String(gap.declaration_id),
    gapType: String(gap.gap_type),
    subjectRef: String(gap.subject_ref),
    basisRefs: strings(gap.basis_refs),
    evidenceRefs: strings(gap.evidence_refs),
    decisionImpact: strings(gap.decision_impact),
    severity: String(gap.severity) as AgentDeclaredGap["severity"],
    recommendedUnitTypes: strings(gap.recommended_unit_types),
    detail: String(gap.detail),
  }));
}

function requestAuthorityRefs(request: AdaptationAuthorRequest): readonly string[] {
  const gap = request.gap;
  const decisionRefs = request.decisions.flatMap((decision) => {
    const targetUnit = isRecord(decision.target_unit) ? decision.target_unit : null;
    return [
      ...(typeof decision.target_unit_ref === "string" ? [decision.target_unit_ref] : []),
      ...(typeof decision.coverage_attestation_ref === "string"
        ? [decision.coverage_attestation_ref]
        : []),
      ...(typeof decision.user_decision_ref === "string" ? [decision.user_decision_ref] : []),
      ...(targetUnit === null ? [] : strings(targetUnit.input_refs)),
    ];
  });
  return uniqueSorted([
    ...request.top_level_formal_refs,
    ...strings(gap.observed_artifact_refs),
    ...strings(gap.repeated_source_refs),
    ...agentDeclaredGaps(gap.agent_declared_gaps).flatMap((declared) => [
      declared.subjectRef,
      ...declared.basisRefs,
      ...(declared.evidenceRefs ?? []),
    ]),
    ...(typeof gap.trigger_event_ref === "string" ? [gap.trigger_event_ref] : []),
    ...decisionRefs,
  ]);
}

function planningContextRefs(manifest: RunManifest): readonly string[] {
  const currentRef = `plans/planning-context.r${manifest.plan_revision}.json`;
  return manifest.artifact_refs.includes(currentRef) ? [currentRef] : [];
}

function validateRequest(validator: ArtifactValidator, value: unknown): AdaptationAuthorRequest {
  const validation = validator.validateDocument(value);
  if (!validation.valid || !isRecord(value)) {
    throw new StoreError(
      "adaptation.author_request_invalid",
      "adaptation author request failed its current contract",
      { errors: validation.errors },
    );
  }
  return value as AdaptationAuthorRequest;
}

function storedEnvelope(
  documents: ReadonlyMap<string, ReturnType<typeof effectiveDocuments>[number]>,
  artifactPathValue: string,
): FormalArtifactEnvelope {
  const entry = documents.get(artifactPathValue);
  if (entry?.envelope === null || entry?.envelope === undefined) {
    throw new StoreError(
      "adaptation.author_replay_artifact_missing",
      "author replay requires the exact stored formal Artifact envelope",
      { artifactPath: artifactPathValue },
    );
  }
  return entry.envelope as unknown as FormalArtifactEnvelope;
}

function decisionDocument(
  request: AdaptationAuthorRequest,
  input: Record<string, unknown>,
  basePlanRef: string,
  gapPath: string,
  gapIds: ReadonlySet<string>,
): Record<string, unknown> {
  const triggerGapIds =
    input.cover_all_generated_gaps === true ? [...gapIds].sort() : strings(input.trigger_gap_ids);
  const missing = triggerGapIds.filter((gapId) => !gapIds.has(gapId));
  if (missing.length > 0) {
    throw new StoreError(
      "adaptation.author_gap_id_missing",
      "trigger_gap_ids must identify generated Gap Snapshot entries",
      { adaptationId: input.adaptation_id, missingGapIds: missing },
    );
  }
  const {
    trigger_gap_ids: _triggerGapIds,
    cover_all_generated_gaps: _coverAllGeneratedGaps,
    ...semantic
  } = input;
  return {
    schema_version: "startup_opportunity.adaptation_decision.discovery.current",
    ...semantic,
    run_id: request.run_id,
    based_on_plan_ref: basePlanRef,
    trigger_gap_refs: triggerGapIds.map((gapId) => `${gapPath}#${gapId}`).sort(),
  };
}

function projectPlanningPhase(
  bundle: DocumentBundle,
  contextPath: string,
  phase: AdaptationAuthorRequest["next_phase"],
): DocumentBundle {
  return {
    ...bundle,
    documents: bundle.documents.map((entry) => {
      if (entry.path !== contextPath) return entry;
      if (
        entry.document.schema_version === "startup_opportunity.artifact_envelope.current" &&
        isRecord(entry.document.document)
      ) {
        const projected = { ...entry.document.document, phase };
        return {
          path: entry.path,
          document: {
            ...entry.document,
            content_hash: canonicalContentHash(projected),
            document: projected,
          },
        };
      }
      return { path: entry.path, document: { ...entry.document, phase } };
    }),
  };
}

function candidatePlanningContext(
  currentContext: ReturnType<typeof leafPlanningContexts>[number],
  manifest: RunManifest,
  planPath: string,
  plan: Record<string, unknown>,
  request: AdaptationAuthorRequest,
): { readonly path: string; readonly document: Record<string, unknown> } {
  const revision = Number(currentContext.document.revision) + 1;
  const contextPath = `plans/planning-context.r${revision}.json`;
  const context = {
    ...currentContext.document,
    revision,
    parent_context_ref: currentContext.path,
    phase: request.next_phase,
    validation_stage: "candidate_revision",
    manifest_binding: {
      manifest_ref: "manifest.json",
      manifest_schema_version: "startup_opportunity.run_manifest.v1",
      run_id: manifest.run_id,
      mode: manifest.mode,
      current_plan_ref: manifest.current_plan_ref,
      current_plan_revision: manifest.plan_revision,
      run_state_hash: planningRunStateHash({
        manifest_ref: "manifest.json",
        manifest_schema_version: "startup_opportunity.run_manifest.v1",
        run_id: manifest.run_id,
        mode: manifest.mode,
        current_plan_ref: manifest.current_plan_ref,
        current_plan_revision: manifest.plan_revision,
      }),
    },
    target_plan_binding: {
      plan_ref: planPath,
      plan_schema_version: "startup_opportunity.research_plan.v1",
      plan_id: plan.plan_id,
      plan_revision: plan.revision,
      plan_content_hash: canonicalContentHash(plan),
    },
    producer_role: "main_agent",
    created_at: request.apply_created_at,
  };
  return { path: contextPath, document: context };
}

function planDiff(
  basePlan: Record<string, unknown>,
  resultPath: string,
  resultPlan: Record<string, unknown> | null,
  actionNames: readonly string[],
): Record<string, unknown> {
  const before = new Map(
    unitEntries(basePlan).map((entry) => [String(entry.unit.unit_id), entry.unit]),
  );
  const after = new Map(
    (resultPlan === null ? unitEntries(basePlan) : unitEntries(resultPlan)).map((entry) => [
      String(entry.unit.unit_id),
      entry.unit,
    ]),
  );
  return {
    revision_created: resultPlan !== null,
    result_plan_ref: resultPath,
    result_plan_content_hash: resultPlan === null ? null : canonicalContentHash(resultPlan),
    action_names: uniqueSorted(actionNames),
    added_unit_ids: [...after.keys()].filter((unitId) => !before.has(unitId)).sort(),
    changed_unit_ids: [...after.keys()]
      .filter(
        (unitId) =>
          before.has(unitId) &&
          canonicalJson(before.get(unitId)) !== canonicalJson(after.get(unitId)),
      )
      .sort(),
  };
}

function exactStoredGapMatchesRequest(
  gap: Record<string, unknown>,
  requestGap: Record<string, unknown>,
): boolean {
  for (const field of [
    "snapshot_id",
    "created_at",
    "trigger_kind",
    "trigger_event_ref",
    "phase",
    "wave_id",
    "material_new_evidence_observed",
  ]) {
    if (canonicalJson(gap[field]) !== canonicalJson(requestGap[field])) return false;
  }
  if (
    canonicalJson(uniqueSorted(strings(gap.observed_artifact_refs))) !==
    canonicalJson(uniqueSorted(strings(requestGap.observed_artifact_refs)))
  ) {
    return false;
  }
  const gaps = records(gap.gaps);
  const declarations = agentDeclaredGaps(requestGap.agent_declared_gaps);
  for (const declaration of declarations) {
    const generated = gaps.find(
      (entry) =>
        isRecord(entry.triggered_by) &&
        entry.triggered_by.declaration_id === declaration.declarationId,
    );
    if (
      generated === undefined ||
      generated.gap_type !== declaration.gapType ||
      generated.subject_ref !== declaration.subjectRef ||
      generated.severity !== declaration.severity ||
      canonicalJson(uniqueSorted(strings(generated.basis_refs))) !==
        canonicalJson(uniqueSorted(declaration.basisRefs)) ||
      canonicalJson(uniqueSorted(strings(generated.evidence_refs))) !==
        canonicalJson(uniqueSorted(declaration.evidenceRefs ?? [])) ||
      canonicalJson(uniqueSorted(strings(generated.decision_impact))) !==
        canonicalJson(uniqueSorted(declaration.decisionImpact)) ||
      canonicalJson(uniqueSorted(strings(generated.recommended_unit_types))) !==
        canonicalJson(uniqueSorted(declaration.recommendedUnitTypes ?? [])) ||
      (generated.triggered_by as Record<string, unknown>).declared_by !== "main_agent" ||
      (generated.triggered_by as Record<string, unknown>).detail !== declaration.detail
    ) {
      return false;
    }
  }
  const repeated = uniqueSorted(strings(requestGap.repeated_source_refs));
  const repeatedGap = gaps.find((entry) => entry.gap_type === "source_repetition");
  return repeated.length === 0
    ? repeatedGap === undefined
    : repeatedGap !== undefined &&
        canonicalJson(uniqueSorted(strings(repeatedGap.evidence_refs))) === canonicalJson(repeated);
}

export class AdaptationAuthorRuntime {
  private constructor(
    private readonly repositoryRoot: string,
    private readonly runsRoot: string,
    private readonly validator: ArtifactValidator,
    private readonly store: RunStore,
  ) {}

  static async create(
    repositoryRoot = process.cwd(),
    runsRoot = path.join(repositoryRoot, "runs"),
  ): Promise<AdaptationAuthorRuntime> {
    const validator = await createArtifactValidator(repositoryRoot);
    return new AdaptationAuthorRuntime(
      repositoryRoot,
      runsRoot,
      validator,
      new RunStore(runsRoot, validator),
    );
  }

  async execute(
    value: unknown,
    options: AdaptationAuthorExecutionOptions = {},
  ): Promise<AdaptationAuthorResult> {
    const request = validateRequest(this.validator, value);
    if (request.operation !== "validate_only") {
      assertPublicationPlanIdentity(request, request.publication_plan as Record<string, unknown>);
    }
    const planRuntime = await createPlanRevisionRuntime(this.repositoryRoot, this.runsRoot);
    const currentManifest = (await this.store.status(request.run_id)).manifest;
    const replay =
      request.operation === "apply" &&
      request.publication_plan !== undefined &&
      (await planRuntime.hasExactOperation(
        request.run_id,
        String(request.publication_plan.operation_key),
      ));
    const publicationReplay =
      request.operation === "publish" &&
      request.publication_plan !== undefined &&
      [
        String(request.publication_plan.gap_ref),
        ...strings(request.publication_plan.adaptation_refs),
      ].every((ref) => currentManifest.artifact_refs.includes(ref));
    if (request.operation !== "validate_only" && !replay && !publicationReplay) {
      if (
        canonicalContentHash(currentManifest) !== request.publication_plan?.manifest_content_hash
      ) {
        throw new StoreError(
          "adaptation.author_publication_plan_stale",
          "publication plan no longer binds the exact current Manifest",
          {
            expected: request.publication_plan?.manifest_content_hash,
            actual: canonicalContentHash(currentManifest),
          },
        );
      }
    }
    const prepared =
      replay || publicationReplay ? await this.prepareReplay(request) : await this.prepare(request);
    if (
      request.operation !== "validate_only" &&
      canonicalJson(request.publication_plan) !== canonicalJson(prepared.publicationPlan)
    ) {
      throw new StoreError(
        "adaptation.author_publication_plan_stale",
        "publish and apply require the exact Harness-generated plan for these semantics and current Manifest",
        {
          suppliedPlanId: request.publication_plan?.plan_id ?? null,
          currentPlanId: prepared.publicationPlan.plan_id,
        },
      );
    }
    let publicationResult: Record<string, unknown> | null = null;
    let applyResult: PlanApplyResult | null = null;
    let resultPublicationPlan = prepared.publicationPlan;
    if (request.operation === "publish") {
      publicationResult = (await this.store.publishArtifactBundle({
        runId: request.run_id,
        envelopes: [prepared.gapEnvelope, ...prepared.adaptationEnvelopes],
        expectedManifestContentHash: prepared.publicationPlan.manifest_content_hash as string,
      })) as unknown as Record<string, unknown>;
      const { publication_plan: _publicationPlan, ...requestWithoutPlan } = request;
      resultPublicationPlan = (await this.prepare({ ...requestWithoutPlan, operation: "apply" }))
        .publicationPlan;
    } else if (request.operation === "apply") {
      applyResult = await planRuntime.apply({
        runId: request.run_id,
        adaptationBundle: prepared.adaptationBundle,
        adaptationRefs: prepared.adaptationEnvelopes.map((entry) => entry.artifact_path),
        ...(prepared.candidateBundle === null ? {} : { candidateBundle: prepared.candidateBundle }),
        createdAt: request.apply_created_at,
        checkpointCreatedAt: request.checkpoint_created_at,
        nextStep: request.next_step,
        beliefSummary: request.belief_summary,
        expectedManifestContentHash: prepared.publicationPlan.manifest_content_hash as string,
        recoverPlanOperations: false,
        ...(options.faultAt === undefined ? {} : { faultAt: options.faultAt }),
        ...(request.terminal_report_envelope === undefined
          ? {}
          : { terminalReportEnvelope: request.terminal_report_envelope }),
      });
    }
    const resultManifest = (await this.store.status(request.run_id)).manifest;
    const status =
      request.operation === "validate_only"
        ? "validated"
        : request.operation === "publish"
          ? publicationResult?.status === "idempotent_replay"
            ? "idempotent_replay"
            : "published"
          : applyResult?.status === "idempotent_replay"
            ? "idempotent_replay"
            : "applied";
    const result: AdaptationAuthorResult = {
      schema_version: ADAPTATION_AUTHOR_RESULT_VERSION,
      request_id: request.request_id,
      run_id: request.run_id,
      operation: request.operation,
      status,
      base_manifest_content_hash:
        prepared.baseManifestContentHash ?? canonicalContentHash(prepared.manifest),
      result_manifest_content_hash: canonicalContentHash(resultManifest),
      base_plan_ref: prepared.basePlanPath,
      base_plan_content_hash: canonicalContentHash(prepared.basePlan),
      planning_run_state_hash: planningRunStateHash({
        manifest_ref: "manifest.json",
        manifest_schema_version: prepared.manifest.schema_version,
        run_id: prepared.manifest.run_id,
        mode: prepared.manifest.mode,
        current_plan_ref: prepared.basePlanPath,
        current_plan_revision: Number(prepared.basePlan.revision),
      }),
      gap_envelope: prepared.gapEnvelope,
      adaptation_envelopes: prepared.adaptationEnvelopes,
      candidate_bundle: prepared.candidateBundle,
      plan_diff: prepared.planDiff,
      publication_plan: resultPublicationPlan,
      publication_result: publicationResult,
      apply_result: applyResult,
    };
    const validation = this.validator.validateDocument(result);
    if (!validation.valid) {
      throw new StoreError(
        "adaptation.author_result_invalid",
        "adaptation author result failed its current contract",
        { errors: validation.errors },
      );
    }
    return result;
  }

  private async prepareReplay(request: AdaptationAuthorRequest): Promise<PreparedAuthorOperation> {
    const publicationPlan = request.publication_plan as Record<string, unknown>;
    assertPublicationPlanIdentity(request, publicationPlan);
    const status = await this.store.status(request.run_id);
    const manifest = status.manifest;
    if (manifest.mode !== "opportunity_discovery") {
      throw new StoreError(
        "adaptation.author_mode_unsupported",
        "the G2.4 author path requires an opportunity_discovery Run",
      );
    }
    const adaptationRefs = [...strings(publicationPlan.adaptation_refs)].sort();
    const authoredAdaptationRefs = request.decisions
      .map((decision) => adaptationPath(String(decision.adaptation_id)))
      .sort();
    if (canonicalJson(adaptationRefs) !== canonicalJson(authoredAdaptationRefs)) {
      throw new StoreError(
        "adaptation.author_publication_plan_stale",
        "publication plan Adaptation refs must exactly cover every authored Decision",
      );
    }
    const requestedRefs = requestAuthorityRefs(request);
    const exactRecordRefs = requestedRefs.filter((ref) => artifactPath(ref).endsWith(".jsonl"));
    const candidatePlanRef =
      typeof publicationPlan.candidate_plan_ref === "string"
        ? publicationPlan.candidate_plan_ref
        : null;
    const candidateContextRef =
      typeof publicationPlan.candidate_context_ref === "string"
        ? publicationPlan.candidate_context_ref
        : null;
    const replayRefs = uniqueSorted([
      String(publicationPlan.gap_ref),
      ...adaptationRefs,
      ...(candidatePlanRef !== null && manifest.artifact_refs.includes(candidatePlanRef)
        ? [candidatePlanRef]
        : []),
      ...(candidateContextRef !== null && manifest.artifact_refs.includes(candidateContextRef)
        ? [candidateContextRef]
        : []),
      ...manifest.artifact_refs.filter((ref) =>
        /^plans\/research-plan\.r[1-9][0-9]*\.json$/.test(ref),
      ),
      ...planningContextRefs(manifest),
      ...requestedRefs.filter((ref) => !artifactPath(ref).endsWith(".jsonl")),
    ]);
    const context = await this.store.buildValidationContext(
      request.run_id,
      {
        schema_version: "startup_opportunity.document_bundle.current",
        documents: [{ path: "manifest.json", document: manifest }],
        exact_records: [],
      },
      {
        topLevelFormalRefs: replayRefs,
        exactRecordRefs,
        recoverPlanOperations: false,
      },
    );
    const documents = new Map<string, EffectiveDocument>(
      effectiveDocuments(context.bundle).map((entry) => [entry.path, entry]),
    );
    const gapPath = String(publicationPlan.gap_ref);
    const gapEnvelope = storedEnvelope(documents, gapPath);
    if (
      gapEnvelope.content_hash !== publicationPlan.gap_content_hash ||
      !exactStoredGapMatchesRequest(gapEnvelope.document, request.gap)
    ) {
      throw new StoreError(
        "adaptation.author_published_gap_mismatch",
        "replay requires the exact published Gap Snapshot produced from this author request",
      );
    }
    const adaptationEnvelopes = adaptationRefs.map((ref) => storedEnvelope(documents, ref));
    if (
      canonicalJson(adaptationEnvelopes.map((entry) => entry.content_hash)) !==
      canonicalJson(publicationPlan.adaptation_content_hashes)
    ) {
      throw new StoreError(
        "adaptation.author_published_content_mismatch",
        "replay Adaptation hashes differ from the exact publication plan",
      );
    }
    const basePlanRefs = uniqueSorted(
      adaptationEnvelopes.map((entry) => String(entry.document.based_on_plan_ref)),
    );
    if (basePlanRefs.length !== 1) {
      throw new StoreError(
        "adaptation.base_conflict",
        "replay Adaptation Decisions must bind one exact base Plan",
      );
    }
    const basePlanPath = basePlanRefs[0] as string;
    const basePlan = documents.get(basePlanPath);
    if (basePlan?.schemaVersion !== "startup_opportunity.research_plan.v1") {
      throw new StoreError("apply.base_plan_missing", "replay is missing its exact base Plan");
    }
    const gapIds = new Set(records(gapEnvelope.document.gaps).map((gap) => String(gap.gap_id)));
    const authoredByPath = new Map(
      request.decisions.map((decision) => [
        adaptationPath(String(decision.adaptation_id)),
        decision,
      ]),
    );
    for (const envelopeValue of adaptationEnvelopes) {
      const authored = authoredByPath.get(envelopeValue.artifact_path);
      if (
        authored === undefined ||
        canonicalJson(envelopeValue.document) !==
          canonicalJson(decisionDocument(request, authored, basePlanPath, gapPath, gapIds))
      ) {
        throw new StoreError(
          "adaptation.author_published_content_mismatch",
          "replay author input differs from the exact published Adaptation Decision bytes",
          { artifactPath: envelopeValue.artifact_path },
        );
      }
    }
    const canonicalOperationKey = operationKey("apply_plan_revision", {
      parent_plan_hash: canonicalContentHash(basePlan.document),
      adaptation_refs: adaptationRefs,
    });
    const expectedOperationKey =
      request.terminal_report_envelope === undefined
        ? canonicalOperationKey
        : operationKey("apply_terminal_closeout", {
            plan_operation_key: canonicalOperationKey,
            report_request_hash: canonicalContentHash(request.terminal_report_envelope),
          });
    if (
      publicationPlan.operation_key !== expectedOperationKey ||
      publicationPlan.checkpoint_ref !==
        `checkpoints/checkpoint-plan-apply-${sha256Hex(expectedOperationKey).slice(0, 20)}.json`
    ) {
      throw new StoreError(
        "adaptation.author_publication_plan_stale",
        "replay publication plan differs from the canonical Plan operation identity",
      );
    }
    let candidateBundle: DocumentBundle | null = null;
    let resultPlan: Record<string, unknown> | null = null;
    if (candidatePlanRef !== null && candidateContextRef !== null) {
      let candidatePlan = documents.get(candidatePlanRef);
      let candidateContext = documents.get(candidateContextRef);
      if (candidatePlan === undefined && candidateContext === undefined) {
        const currentContext = leafPlanningContexts(context.bundle).find(
          (entry) =>
            isRecord(entry.document.target_plan_binding) &&
            entry.document.target_plan_binding.plan_ref === basePlanPath,
        );
        const transformed = transformPlan(
          basePlanPath,
          basePlan.document,
          manifest,
          adaptationEnvelopes.map((entry) => ({
            path: entry.artifact_path,
            document: entry.document,
          })),
          request.apply_created_at,
        );
        if (currentContext === undefined || transformed.plan === null) {
          throw new StoreError(
            "adaptation.author_candidate_plan_invalid",
            "replay could not reconstruct its exact candidate Plan authority",
          );
        }
        const projectedContext = candidatePlanningContext(
          currentContext,
          manifest,
          transformed.planPath,
          transformed.plan,
          request,
        );
        candidatePlan = {
          path: transformed.planPath,
          schemaVersion: String(transformed.plan.schema_version),
          document: transformed.plan,
          envelope: null,
        };
        candidateContext = {
          path: projectedContext.path,
          schemaVersion: String(projectedContext.document.schema_version),
          document: projectedContext.document,
          envelope: null,
        };
      }
      if (candidatePlan === undefined || candidateContext === undefined) {
        throw new StoreError(
          "adaptation.author_candidate_plan_invalid",
          "replay candidate Plan and Planning Context must both be present or reconstructible",
        );
      }
      if (
        candidatePlan.path !== candidatePlanRef ||
        candidatePlan.schemaVersion !== "startup_opportunity.research_plan.v1" ||
        candidateContext.path !== candidateContextRef ||
        candidateContext.schemaVersion !==
          "startup_opportunity.planning_context.ai_source_bound.current" ||
        canonicalContentHash(candidatePlan.document) !==
          publicationPlan.candidate_plan_content_hash ||
        canonicalContentHash(candidateContext.document) !==
          publicationPlan.candidate_context_content_hash
      ) {
        throw new StoreError(
          "adaptation.author_candidate_plan_invalid",
          "replay candidate Plan or Planning Context differs from the exact publication plan",
        );
      }
      resultPlan = candidatePlan.document;
      candidateBundle = {
        ...context.bundle,
        exact_records: [],
        documents: [
          ...context.bundle.documents,
          ...(documents.has(candidatePlan.path)
            ? []
            : [{ path: candidatePlan.path, document: candidatePlan.document }]),
          ...(documents.has(candidateContext.path)
            ? []
            : [{ path: candidateContext.path, document: candidateContext.document }]),
        ],
      };
    } else if (
      candidatePlanRef !== null ||
      candidateContextRef !== null ||
      publicationPlan.candidate_plan_content_hash !== null ||
      publicationPlan.candidate_context_content_hash !== null
    ) {
      throw new StoreError(
        "adaptation.author_publication_plan_stale",
        "non-revision replay cannot declare candidate Plan or Context fields",
      );
    }
    return {
      manifest,
      basePlanPath,
      basePlan: basePlan.document,
      adaptationBundle: context.bundle,
      referenceContext: context.referenceContext,
      gapEnvelope,
      adaptationEnvelopes,
      candidateBundle,
      planDiff: planDiff(
        basePlan.document,
        typeof publicationPlan.candidate_plan_ref === "string"
          ? publicationPlan.candidate_plan_ref
          : basePlanPath,
        resultPlan,
        adaptationEnvelopes.map((entry) => String(entry.document.action)),
      ),
      publicationPlan,
      baseManifestContentHash: String(publicationPlan.manifest_content_hash),
    };
  }

  private async prepare(request: AdaptationAuthorRequest): Promise<PreparedAuthorOperation> {
    const status = await this.store.status(request.run_id);
    const manifest = status.manifest;
    const manifestHash = canonicalContentHash(manifest);
    if (manifest.mode !== "opportunity_discovery") {
      throw new StoreError(
        "adaptation.author_mode_unsupported",
        "the G2.4 author path requires an opportunity_discovery Run",
      );
    }
    if (manifest.current_plan_ref === null) {
      throw new StoreError("apply.current_plan_missing", "Run has no current Research Plan");
    }
    const requestedRefs = requestAuthorityRefs(request);
    const exactRecordRefs = requestedRefs.filter((ref) => artifactPath(ref).endsWith(".jsonl"));
    const baseContext = await this.store.buildValidationContext(
      request.run_id,
      {
        schema_version: "startup_opportunity.document_bundle.current",
        documents: [{ path: "manifest.json", document: manifest }],
        exact_records: [],
      },
      {
        topLevelFormalRefs: uniqueSorted([
          manifest.current_plan_ref,
          ...(manifest.latest_gap_snapshot_ref === null ? [] : [manifest.latest_gap_snapshot_ref]),
          ...planningContextRefs(manifest),
          ...requestedRefs.filter((ref) => !artifactPath(ref).endsWith(".jsonl")),
        ]),
        exactRecordRefs,
        recoverPlanOperations: false,
      },
    );
    const allowedPendingOperationKey =
      request.operation === "apply" ? String(request.publication_plan?.operation_key) : null;
    const divergentPendingOperationKeys =
      baseContext.planOperationRecovery.pendingOperationKeys.filter(
        (key) => key !== allowedPendingOperationKey,
      );
    if (divergentPendingOperationKeys.length > 0) {
      throw new StoreError(
        "adaptation.author_recovery_pending",
        "author-plan-adaptation cannot complete a different pending Plan operation; resume that exact operation first",
        { operationKeys: divergentPendingOperationKeys },
      );
    }
    const baseDocuments = documentMap(baseContext.bundle);
    const basePlan = baseDocuments.get(manifest.current_plan_ref);
    const currentContexts = leafPlanningContexts(baseContext.bundle).filter(
      (context) =>
        isRecord(context.document.target_plan_binding) &&
        context.document.target_plan_binding.plan_ref === manifest.current_plan_ref,
    );
    const currentContext = currentContexts.length === 1 ? currentContexts[0] : undefined;
    if (
      basePlan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
      currentContext === undefined
    ) {
      throw new StoreError(
        "adaptation.author_planning_authority_missing",
        "current Plan and exact leaf Planning Context could not be loaded from Manifest authority",
      );
    }

    let gapDocument: Record<string, unknown>;
    let gapPath: string;
    if (request.operation === "apply") {
      const latestGap =
        manifest.latest_gap_snapshot_ref === null
          ? undefined
          : baseDocuments.get(manifest.latest_gap_snapshot_ref);
      if (
        latestGap?.schemaVersion !== "startup_opportunity.gap_snapshot.discovery.plan.current" ||
        !exactStoredGapMatchesRequest(latestGap.document, request.gap)
      ) {
        throw new StoreError(
          "adaptation.author_published_gap_mismatch",
          "apply requires the exact published Gap Snapshot produced from this author request",
        );
      }
      gapDocument = latestGap.document;
      gapPath = latestGap.path;
    } else {
      const analyzed = (await createGapAnalyzer(this.repositoryRoot)).analyze({
        documentBundle: baseContext.bundle,
        referenceContext: baseContext.referenceContext,
        snapshotId: String(request.gap.snapshot_id),
        createdAt: String(request.gap.created_at),
        triggerKind: String(request.gap.trigger_kind) as
          | "wave_completed"
          | "user_decision"
          | "artifact_validation_failed"
          | "adversarial_review_completed"
          | "resume_reconciliation",
        phase: String(request.gap.phase),
        waveId: request.gap.wave_id === null ? null : String(request.gap.wave_id),
        triggerEventRef:
          request.gap.trigger_event_ref === null ? null : String(request.gap.trigger_event_ref),
        observedArtifactRefs: strings(request.gap.observed_artifact_refs),
        materialNewEvidenceObserved: request.gap.material_new_evidence_observed === true,
        repeatedSourceRefs: strings(request.gap.repeated_source_refs),
        agentDeclaredGaps: agentDeclaredGaps(request.gap.agent_declared_gaps),
      });
      if (!analyzed.valid || analyzed.snapshot === null) {
        throw new StoreError(
          "adaptation.author_gap_invalid",
          "Gap Snapshot could not be derived from current authority and explicit Agent-declared gaps",
          { result: analyzed },
        );
      }
      gapDocument = analyzed.snapshot;
      gapPath = `adaptations/gap-snapshots/${String(gapDocument.snapshot_id)}.r${String(
        gapDocument.revision,
      )}.json`;
    }
    const gapIds = new Set(records(gapDocument.gaps).map((gap) => String(gap.gap_id)));
    const seenDecisionPaths = new Set<string>();
    const decisionDocuments = request.decisions.map((decision) => {
      const decisionPath = adaptationPath(String(decision.adaptation_id));
      if (seenDecisionPaths.has(decisionPath)) {
        throw new StoreError(
          "adaptation.author_duplicate_decision",
          "adaptation_id values must be unique within one request",
          { adaptationId: decision.adaptation_id },
        );
      }
      seenDecisionPaths.add(decisionPath);
      return {
        path: decisionPath,
        document: decisionDocument(
          request,
          decision,
          manifest.current_plan_ref as string,
          gapPath,
          gapIds,
        ),
      };
    });
    const gapEnvelope = envelope(
      request.run_id,
      gapPath,
      gapDocument,
      "harness",
      uniqueSorted([
        manifest.current_plan_ref,
        ...strings(gapDocument.observed_artifact_refs),
        ...records(gapDocument.gaps).flatMap((gap) => [
          ...strings(gap.basis_refs),
          ...strings(gap.evidence_refs),
        ]),
        ...(typeof gapDocument.trigger_event_ref === "string"
          ? [gapDocument.trigger_event_ref]
          : []),
      ]),
    );
    const adaptationEnvelopes = decisionDocuments.map((entry) =>
      envelope(
        request.run_id,
        entry.path,
        entry.document,
        "main_agent",
        artifactRefsForDocument(entry),
      ),
    );
    if (request.operation === "apply") {
      const storedByPath = new Map(
        effectiveDocuments(baseContext.bundle).map((entry) => [entry.path, entry]),
      );
      if (
        gapEnvelope.content_hash !== storedByPath.get(gapPath)?.envelope?.content_hash ||
        adaptationEnvelopes.some((entry) => {
          const stored = storedByPath.get(entry.artifact_path)?.envelope;
          return (
            stored === null ||
            stored === undefined ||
            canonicalJson(stored) !== canonicalJson(entry)
          );
        })
      ) {
        throw new StoreError(
          "adaptation.author_published_content_mismatch",
          "apply author input differs from the exact published Gap/Adaptation bytes",
        );
      }
    }

    const prospectivePaths = [gapPath, ...decisionDocuments.map((entry) => entry.path)];
    const adaptationInput: DocumentBundle = {
      ...baseContext.bundle,
      documents: [
        ...baseContext.bundle.documents.filter((entry) => !prospectivePaths.includes(entry.path)),
        { path: gapPath, document: gapEnvelope },
        ...adaptationEnvelopes.map((entry) => ({ path: entry.artifact_path, document: entry })),
      ],
    };
    const adaptationContext =
      request.operation === "validate_only"
        ? { bundle: adaptationInput, referenceContext: baseContext.referenceContext }
        : await this.store.buildValidationContext(request.run_id, adaptationInput, {
            topLevelFormalRefs: requestedRefs.filter(
              (ref) => !artifactPath(ref).endsWith(".jsonl"),
            ),
            exactRecordRefs,
            ...(request.operation === "apply"
              ? {}
              : { prospectiveArtifactPaths: prospectivePaths }),
            recoverPlanOperations: false,
          });
    const projected = projectPlanningPhase(
      adaptationContext.bundle,
      currentContext.path,
      request.next_phase,
    );
    const adaptationValidation = (
      await createAdaptationPolicyValidator(this.repositoryRoot)
    ).validateDocumentBundle(
      projected,
      adaptationContext.referenceContext,
      adaptationEnvelopes.map((entry) => entry.artifact_path),
    );
    if (!adaptationValidation.valid) {
      throw new StoreError(
        "adaptation.author_decision_invalid",
        "authored Adaptation Decision batch failed current policy validation",
        { result: adaptationValidation },
      );
    }
    const transformed = transformPlan(
      manifest.current_plan_ref,
      basePlan.document,
      manifest,
      decisionDocuments,
      request.apply_created_at,
    );
    let candidateBundle: DocumentBundle | null = null;
    let candidateContext: {
      readonly path: string;
      readonly document: Record<string, unknown>;
    } | null = null;
    if (transformed.revisionCreated && transformed.plan !== null) {
      candidateContext = candidatePlanningContext(
        currentContext,
        manifest,
        transformed.planPath,
        transformed.plan,
        request,
      );
      candidateBundle = {
        ...adaptationContext.bundle,
        exact_records: [],
        documents: [
          ...adaptationContext.bundle.documents,
          { path: transformed.planPath, document: transformed.plan },
          candidateContext,
        ],
      };
      const candidateValidation = (
        await createPlanSemanticValidator(this.repositoryRoot)
      ).validateDocumentBundle(candidateBundle, adaptationContext.referenceContext);
      if (!candidateValidation.valid) {
        throw new StoreError(
          "adaptation.author_candidate_plan_invalid",
          "deterministically transformed candidate Plan failed current validation",
          { result: candidateValidation },
        );
      }
    }
    const diff = planDiff(
      basePlan.document,
      transformed.planPath,
      transformed.plan,
      transformed.actionNames,
    );
    const applyOperationKey =
      request.terminal_report_envelope === undefined
        ? transformed.operationKey
        : operationKey("apply_terminal_closeout", {
            plan_operation_key: transformed.operationKey,
            report_request_hash: canonicalContentHash(request.terminal_report_envelope),
          });
    const publicationPlanIdentity = {
      schema_version: "startup_opportunity.adaptation_author_publication_plan.current",
      request_content_hash: requestContentHash(request),
      operation_key: applyOperationKey,
      checkpoint_ref: `checkpoints/checkpoint-plan-apply-${sha256Hex(applyOperationKey).slice(0, 20)}.json`,
      manifest_content_hash: manifestHash,
      gap_ref: gapPath,
      gap_content_hash: gapEnvelope.content_hash,
      adaptation_refs: adaptationEnvelopes.map((entry) => entry.artifact_path).sort(),
      adaptation_content_hashes: [...adaptationEnvelopes]
        .sort((left, right) => left.artifact_path.localeCompare(right.artifact_path))
        .map((entry) => entry.content_hash),
      candidate_plan_ref: transformed.plan === null ? null : transformed.planPath,
      candidate_plan_content_hash:
        transformed.plan === null ? null : canonicalContentHash(transformed.plan),
      candidate_context_ref: candidateContext?.path ?? null,
      candidate_context_content_hash:
        candidateContext === null ? null : canonicalContentHash(candidateContext.document),
    };
    const publicationPlan = {
      ...publicationPlanIdentity,
      plan_id: operationKey("adaptation_author_publication_plan", publicationPlanIdentity),
    };
    return {
      manifest,
      basePlanPath: manifest.current_plan_ref,
      basePlan: basePlan.document,
      adaptationBundle: adaptationContext.bundle,
      referenceContext: adaptationContext.referenceContext,
      gapEnvelope,
      adaptationEnvelopes,
      candidateBundle,
      planDiff: diff,
      publicationPlan,
    };
  }
}

export async function createAdaptationAuthorRuntime(
  repositoryRoot = process.cwd(),
  runsRoot = path.join(repositoryRoot, "runs"),
): Promise<AdaptationAuthorRuntime> {
  return AdaptationAuthorRuntime.create(repositoryRoot, runsRoot);
}

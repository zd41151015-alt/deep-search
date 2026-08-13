import { canonicalJson } from "../artifact-store/canonical.js";

export interface LaneClosureArtifact {
  readonly artifact_ref: string;
  readonly artifact_type: string;
  readonly content_hash: string;
  readonly document: Record<string, unknown>;
}

export interface LaneScopeCoverageDeclaration {
  readonly scope_key: string;
  readonly status: LaneScopeDisposition;
  readonly evidence_refs: readonly string[];
}

export type LaneScopeDisposition = "covered" | "partial" | "no_evidence_found" | "not_applicable";

export interface LaneScopeFormalClosure {
  readonly scope_key: string;
  readonly disposition: LaneScopeDisposition;
  readonly evidence_bindings: readonly {
    readonly evidence_ref: string;
    readonly artifact_type: string;
    readonly content_hash: string;
    readonly substrate_record_ref: string;
  }[];
  readonly semantic_bindings: readonly {
    readonly artifact_ref: string;
    readonly artifact_type: string;
    readonly content_hash: string;
    readonly semantic_path: string;
    readonly semantic_identity: string;
  }[];
}

export interface LaneScopeClosureIssue {
  readonly code:
    | "lane_delivery.scope_formal_support_missing"
    | "lane_delivery.scope_formal_disposition_mismatch"
    | "lane_delivery.scope_formal_evidence_mismatch";
  readonly scopeKey: string;
  readonly message: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function pointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

const ID_FIELDS = [
  "evidence_id",
  "claim_id",
  "finding_id",
  "insight_id",
  "judgment_id",
  "manifest_id",
] as const;

class ClosureResolver {
  private readonly byPath = new Map<string, LaneClosureArtifact>();
  private readonly byIdentifier = new Map<string, LaneClosureArtifact | null>();

  constructor(
    readonly artifacts: readonly LaneClosureArtifact[],
    resolvableArtifacts: readonly LaneClosureArtifact[] = artifacts,
  ) {
    for (const artifact of resolvableArtifacts) {
      this.byPath.set(artifact.artifact_ref, artifact);
      for (const field of ID_FIELDS) {
        const identifier = artifact.document[field];
        if (typeof identifier !== "string") continue;
        this.byIdentifier.set(identifier, this.byIdentifier.has(identifier) ? null : artifact);
      }
    }
  }

  resolve(reference: string): LaneClosureArtifact | null {
    const path = reference.split("#", 1)[0] ?? reference;
    return this.byPath.get(path) ?? this.byIdentifier.get(reference) ?? null;
  }
}

interface ClosureAccumulator {
  readonly evidence: Map<string, LaneScopeFormalClosure["evidence_bindings"][number]>;
  readonly semantics: Map<string, LaneScopeFormalClosure["semantic_bindings"][number]>;
  readonly visited: Set<string>;
}

function addSemantic(
  accumulator: ClosureAccumulator,
  artifact: LaneClosureArtifact,
  semanticPath: string,
  semanticIdentity: string,
): void {
  const binding = {
    artifact_ref: artifact.artifact_ref,
    artifact_type: artifact.artifact_type,
    content_hash: artifact.content_hash,
    semantic_path: semanticPath,
    semantic_identity: semanticIdentity,
  };
  accumulator.semantics.set(canonicalJson(binding), binding);
}

function evidenceSubstrate(artifact: LaneClosureArtifact): string | null {
  const binding = isRecord(artifact.document.mechanical_binding)
    ? artifact.document.mechanical_binding
    : {};
  return typeof binding.substrate_record_ref === "string" ? binding.substrate_record_ref : null;
}

function collectReference(
  resolver: ClosureResolver,
  accumulator: ClosureAccumulator,
  reference: string,
): void {
  const artifact = resolver.resolve(reference);
  if (artifact === null || accumulator.visited.has(artifact.artifact_ref)) return;
  accumulator.visited.add(artifact.artifact_ref);
  const substrate = evidenceSubstrate(artifact);
  if (substrate !== null && artifact.artifact_type.startsWith("startup_opportunity.evidence.")) {
    accumulator.evidence.set(artifact.artifact_ref, {
      evidence_ref: artifact.artifact_ref,
      artifact_type: artifact.artifact_type,
      content_hash: artifact.content_hash,
      substrate_record_ref: substrate,
    });
    return;
  }

  const document = artifact.document;
  const identifier = ID_FIELDS.map((field) => document[field]).find(
    (value): value is string => typeof value === "string",
  );
  addSemantic(
    accumulator,
    artifact,
    "/",
    identifier === undefined ? artifact.artifact_ref : `${artifact.artifact_type}:${identifier}`,
  );
  for (const field of [
    "evidence_refs",
    "supporting_claim_refs",
    "opposing_claim_refs",
    "judgment_assessment_refs",
    "finding_refs",
    "claim_refs",
  ]) {
    for (const child of strings(document[field])) collectReference(resolver, accumulator, child);
  }
}

function accumulator(): ClosureAccumulator {
  return { evidence: new Map(), semantics: new Map(), visited: new Set() };
}

function dispositionForEvidence(
  evidenceCount: number,
  notApplicable: boolean,
  complete = true,
): LaneScopeDisposition {
  if (notApplicable) return "not_applicable";
  if (!complete) return "partial";
  return evidenceCount === 0 ? "no_evidence_found" : "covered";
}

function assessmentClosure(
  scopeKey: string,
  resolver: ClosureResolver,
): { accumulator: ClosureAccumulator; disposition: LaneScopeDisposition } | null {
  const closure = accumulator();
  let matched = false;
  let notApplicable = true;
  let complete = true;
  for (const artifact of resolver.artifacts) {
    if (artifact.artifact_type === "startup_opportunity.assessment_lane_result.v1") {
      for (const [index, dimension] of records(artifact.document.dimension_results).entries()) {
        if (dimension.dimension_id !== scopeKey) continue;
        matched = true;
        notApplicable =
          notApplicable &&
          (dimension.dimension_decision === "not_applicable" ||
            dimension.decision_sufficiency === "not_applicable");
        complete = complete && dimension.decision_sufficiency === "sufficient";
        addSemantic(
          closure,
          artifact,
          `/dimension_results/${String(index)}`,
          `dimension:${scopeKey}`,
        );
        for (const field of [
          "evidence_refs",
          "supporting_claim_refs",
          "opposing_claim_refs",
          "judgment_assessment_refs",
        ]) {
          for (const reference of strings(dimension[field]))
            collectReference(resolver, closure, reference);
        }
      }
    }
    if (
      artifact.artifact_type ===
        "startup_opportunity.concept_evidence_assessment_branch_result.v1" &&
      artifact.document.dimension_id === scopeKey
    ) {
      matched = true;
      notApplicable =
        notApplicable &&
        (artifact.document.dimension_decision === "not_applicable" ||
          artifact.document.decision_sufficiency === "not_applicable");
      complete = complete && artifact.document.decision_sufficiency === "sufficient";
      addSemantic(closure, artifact, "/", `dimension:${scopeKey}`);
      for (const field of [
        "evidence_refs",
        "supporting_claim_refs",
        "opposing_claim_refs",
        "judgment_assessment_refs",
        "finding_refs",
      ]) {
        for (const reference of strings(artifact.document[field]))
          collectReference(resolver, closure, reference);
      }
    }
  }
  return matched
    ? {
        accumulator: closure,
        disposition: notApplicable
          ? "not_applicable"
          : closure.evidence.size === 0
            ? "no_evidence_found"
            : complete
              ? "covered"
              : "partial",
      }
    : null;
}

function commercialClosure(
  scopeKey: string,
  resolver: ClosureResolver,
): { accumulator: ClosureAccumulator; disposition: LaneScopeDisposition } | null {
  const audit = resolver.artifacts.find(
    (artifact) =>
      artifact.artifact_type === "startup_opportunity.commercial_research_audit.current",
  );
  if (audit === undefined) return null;
  const closure = accumulator();
  if (scopeKey.startsWith("quantitative:")) {
    const metricFamily = scopeKey.slice("quantitative:".length);
    const matching = records(audit.document.quantitative_coverage).filter(
      (entry) => entry.metric_family === metricFamily,
    );
    if (matching.length === 0) return null;
    for (const entry of matching) {
      const index = records(audit.document.quantitative_coverage).indexOf(entry);
      addSemantic(
        closure,
        audit,
        `/quantitative_coverage/${String(index)}`,
        `quantitative:${String(entry.subject_id)}:${metricFamily}:${String(entry.state)}`,
      );
      for (const observationId of strings(entry.observation_ids)) {
        const observationIndex = records(audit.document.quantitative_observations).findIndex(
          (observation) => observation.observation_id === observationId,
        );
        if (observationIndex < 0) continue;
        const observation = records(audit.document.quantitative_observations)[observationIndex];
        if (observation === undefined) continue;
        addSemantic(
          closure,
          audit,
          `/quantitative_observations/${String(observationIndex)}`,
          `observation:${observationId}`,
        );
        for (const reference of strings(observation.evidence_refs))
          collectReference(resolver, closure, reference);
      }
    }
    return {
      accumulator: closure,
      disposition: dispositionForEvidence(
        closure.evidence.size,
        matching.every((entry) => entry.state === "not_applicable"),
        matching.every((entry) => entry.state === "observed"),
      ),
    };
  }
  if (scopeKey.startsWith("competitive:")) {
    const competitorType = scopeKey.slice("competitive:".length);
    const coverage = records(audit.document.competitive_coverage);
    const matching = coverage.filter((entry) => entry.competitor_type === competitorType);
    if (matching.length === 0) return null;
    for (const entry of matching) {
      addSemantic(
        closure,
        audit,
        `/competitive_coverage/${String(coverage.indexOf(entry))}`,
        `competitive:${String(entry.subject_id)}:${competitorType}:${String(entry.state)}`,
      );
      for (const objectId of strings(entry.competitive_object_ids)) {
        const objectIndex = records(audit.document.competitive_objects).findIndex(
          (object) => object.competitive_object_id === objectId,
        );
        if (objectIndex < 0) continue;
        const object = records(audit.document.competitive_objects)[objectIndex];
        if (object === undefined) continue;
        addSemantic(
          closure,
          audit,
          `/competitive_objects/${String(objectIndex)}`,
          `competitive_object:${objectId}`,
        );
        for (const reference of strings(object.source_refs))
          collectReference(resolver, closure, reference);
      }
    }
    return {
      accumulator: closure,
      disposition: dispositionForEvidence(
        closure.evidence.size,
        matching.every((entry) => entry.state === "not_applicable"),
        matching.every((entry) => entry.state === "observed"),
      ),
    };
  }
  if (scopeKey === "incumbent_response") {
    const coverage = records(audit.document.incumbent_response_coverage);
    if (coverage.length === 0) return null;
    const assessments = records(audit.document.incumbent_response_assessments);
    for (const entry of coverage) {
      addSemantic(
        closure,
        audit,
        `/incumbent_response_coverage/${String(coverage.indexOf(entry))}`,
        `incumbent_response:${String(entry.subject_id)}:${String(entry.state)}`,
      );
      for (const assessmentId of strings(entry.assessment_ids)) {
        const assessmentIndex = assessments.findIndex(
          (assessment) => assessment.assessment_id === assessmentId,
        );
        if (assessmentIndex < 0) continue;
        const assessment = assessments[assessmentIndex];
        const semantic = isRecord(assessment?.semantic) ? assessment.semantic : {};
        addSemantic(
          closure,
          audit,
          `/incumbent_response_assessments/${String(assessmentIndex)}`,
          `incumbent_assessment:${assessmentId}`,
        );
        for (const field of [
          "supporting_evidence_refs",
          "opposing_evidence_refs",
          "background_evidence_refs",
        ]) {
          for (const reference of strings(semantic[field]))
            collectReference(resolver, closure, reference);
        }
      }
    }
    return {
      accumulator: closure,
      disposition: dispositionForEvidence(
        closure.evidence.size,
        coverage.every((entry) => entry.state === "not_applicable"),
        coverage.every((entry) => entry.state === "assessed"),
      ),
    };
  }
  const coverage = isRecord(audit.document.coverage) ? audit.document.coverage : {};
  const entry = isRecord(coverage[scopeKey]) ? coverage[scopeKey] : null;
  if (entry === null) return null;
  addSemantic(
    closure,
    audit,
    `/coverage/${pointerToken(scopeKey)}`,
    `commercial_coverage:${scopeKey}:${String(entry.state)}`,
  );
  for (const reference of strings(entry.evidence_refs))
    collectReference(resolver, closure, reference);
  const notApplicable = records(
    isRecord(audit.document.search_closure) ? audit.document.search_closure.remaining_gaps : [],
  ).some(
    (gap) =>
      gap.coverage_kind === "business" &&
      gap.dimension === scopeKey &&
      gap.state === "not_applicable",
  );
  return {
    accumulator: closure,
    disposition: dispositionForEvidence(
      closure.evidence.size,
      notApplicable,
      entry.content_covered === true && entry.state === "observed",
    ),
  };
}

function discoveryClosure(
  scopeKey: string,
  resolver: ClosureResolver,
): { accumulator: ClosureAccumulator; disposition: LaneScopeDisposition } | null {
  const lane = resolver.artifacts.find(
    (artifact) => artifact.artifact_type === "startup_opportunity.discovery_lane_result.v1",
  );
  if (lane === undefined) return null;
  const outcomes = records(lane.document.scope_outcomes);
  const outcomeIndex = outcomes.findIndex((outcome) => outcome.scope_key === scopeKey);
  if (outcomeIndex < 0) return null;
  const outcome = outcomes[outcomeIndex];
  if (outcome === undefined) return null;
  const closure = accumulator();
  addSemantic(
    closure,
    lane,
    `/scope_outcomes/${String(outcomeIndex)}`,
    `discovery_scope:${scopeKey}:${String(outcome.disposition)}`,
  );
  for (const field of ["evidence_refs", "claim_refs", "finding_refs", "judgment_assessment_refs"]) {
    for (const reference of strings(outcome[field])) collectReference(resolver, closure, reference);
  }
  const authoredDisposition = outcome.disposition as LaneScopeDisposition;
  return {
    accumulator: closure,
    disposition: authoredDisposition,
  };
}

export function deriveLaneScopeFormalClosure(
  declarations: readonly LaneScopeCoverageDeclaration[],
  artifacts: readonly LaneClosureArtifact[],
  rootArtifactRefs: readonly string[] = artifacts.map((artifact) => artifact.artifact_ref),
): {
  readonly closure: readonly LaneScopeFormalClosure[];
  readonly issues: readonly LaneScopeClosureIssue[];
} {
  const roots = new Set(rootArtifactRefs);
  const rootResolver = new ClosureResolver(
    artifacts.filter((artifact) => roots.has(artifact.artifact_ref)),
    artifacts,
  );
  const closure: LaneScopeFormalClosure[] = [];
  const issues: LaneScopeClosureIssue[] = [];
  for (const declaration of [...declarations].sort((left, right) =>
    left.scope_key.localeCompare(right.scope_key),
  )) {
    const derived =
      assessmentClosure(declaration.scope_key, rootResolver) ??
      commercialClosure(declaration.scope_key, rootResolver) ??
      discoveryClosure(declaration.scope_key, rootResolver);
    if (derived === null) {
      issues.push({
        code: "lane_delivery.scope_formal_support_missing",
        scopeKey: declaration.scope_key,
        message: "assigned scope has no corresponding formal Lane Result or Audit semantic field",
        expected: declaration.status,
        actual: null,
      });
      continue;
    }
    const evidenceBindings = [...derived.accumulator.evidence.values()].sort((left, right) =>
      left.evidence_ref.localeCompare(right.evidence_ref),
    );
    const semanticBindings = [...derived.accumulator.semantics.values()].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
    const formalClosure: LaneScopeFormalClosure = {
      scope_key: declaration.scope_key,
      disposition: derived.disposition,
      evidence_bindings: evidenceBindings,
      semantic_bindings: semanticBindings,
    };
    closure.push(formalClosure);
    if (declaration.status !== derived.disposition) {
      issues.push({
        code: "lane_delivery.scope_formal_disposition_mismatch",
        scopeKey: declaration.scope_key,
        message: "authored scope disposition conflicts with the compiled formal semantic outcome",
        expected: derived.disposition,
        actual: declaration.status,
      });
    }
    const actualReceipts = uniqueSorted(
      evidenceBindings.map((binding) => binding.substrate_record_ref),
    );
    const declaredReceipts = uniqueSorted(declaration.evidence_refs);
    if (
      (declaration.status === "covered" || declaration.status === "partial") &&
      canonicalJson(actualReceipts) !== canonicalJson(declaredReceipts)
    ) {
      issues.push({
        code: "lane_delivery.scope_formal_evidence_mismatch",
        scopeKey: declaration.scope_key,
        message:
          "authored scope Evidence receipts differ from the typed Evidence reachable from the formal semantic outcome",
        expected: actualReceipts,
        actual: declaredReceipts,
      });
    }
  }
  return { closure, issues };
}

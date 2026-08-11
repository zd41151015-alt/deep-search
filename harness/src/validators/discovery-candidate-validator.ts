import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import type { CandidateKind, DiscoveryCandidatePolicy } from "./discovery-candidate-policy.js";
import { sortIssues, type ValidationIssue } from "./schema-bundle.js";

export interface DiscoveryCandidateDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

const CONTRACT_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.discovery_candidate.v1",
  "startup_opportunity.research_task.discovery_candidate.current",
  "startup_opportunity.evidence.discovery_candidate.current",
  "startup_opportunity.claim.discovery_candidate.current",
  "startup_opportunity.finding.discovery_candidate.current",
  "startup_opportunity.insight.discovery_candidate.current",
  "startup_opportunity.judgment_assessment.discovery_candidate.current",
  "startup_opportunity.source_manifest.discovery_candidate.current",
  "startup_opportunity.discovery_lane_result.v1",
  "startup_opportunity.discovery_fan_in.v2",
]);

const PRODUCER_BY_SCHEMA: Readonly<Record<string, string>> = {
  "startup_opportunity.discovery_candidate.v1": "main_agent",
  "startup_opportunity.research_task.discovery_candidate.current": "main_agent",
  "startup_opportunity.evidence.discovery_candidate.current": "lane_researcher",
  "startup_opportunity.claim.discovery_candidate.current": "lane_researcher",
  "startup_opportunity.finding.discovery_candidate.current": "lane_researcher",
  "startup_opportunity.insight.discovery_candidate.current": "lane_researcher",
  "startup_opportunity.judgment_assessment.discovery_candidate.current": "lane_researcher",
  "startup_opportunity.source_manifest.discovery_candidate.current": "lane_researcher",
  "startup_opportunity.discovery_lane_result.v1": "lane_researcher",
  "startup_opportunity.discovery_fan_in.v2": "main_agent",
};

const EVIDENCE_LINEAGE_FIELDS = [
  "evidence_refs",
  "claim_refs",
  "finding_refs",
  "insight_refs",
  "judgment_assessment_refs",
  "source_manifest_refs",
  "audit_refs",
] as const;

const MATERIAL_SCHEMA_BY_LINEAGE_FIELD: Readonly<
  Partial<Record<(typeof EVIDENCE_LINEAGE_FIELDS)[number], string>>
> = {
  evidence_refs: "startup_opportunity.evidence.discovery_candidate.current",
  claim_refs: "startup_opportunity.claim.discovery_candidate.current",
  finding_refs: "startup_opportunity.finding.discovery_candidate.current",
  insight_refs: "startup_opportunity.insight.discovery_candidate.current",
  judgment_assessment_refs: "startup_opportunity.judgment_assessment.discovery_candidate.current",
  source_manifest_refs: "startup_opportunity.source_manifest.discovery_candidate.current",
};

const CANDIDATE_CHANGE_FIELDS = [
  "subject",
  ...EVIDENCE_LINEAGE_FIELDS.map((field) => `evidence_lineage.${field}`),
  "source_partition",
  "limitations",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function issue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "discovery_candidate",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function setEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    canonicalJson([...left].sort()) === canonicalJson([...right].sort())
  );
}

function disjoint(sets: readonly (readonly string[])[]): boolean {
  const flattened = sets.flat();
  return new Set(flattened).size === flattened.length;
}

function targetHash(target: DiscoveryCandidateDocument): string {
  const hash = target.envelope?.content_hash;
  return typeof hash === "string" ? hash : canonicalContentHash(target.document);
}

function resolveMapFragment(
  document: Record<string, unknown>,
  pointer: unknown,
): Record<string, unknown> | null {
  if (typeof pointer !== "string") {
    return null;
  }
  const match = pointer.match(/^\/([A-Za-z0-9_-]+)\/([0-9]+)$/);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  const collection = document[match[1]];
  const index = Number.parseInt(match[2], 10);
  const fragment = Array.isArray(collection) ? collection[index] : undefined;
  return isRecord(fragment) ? fragment : null;
}

function candidateIdentity(entry: DiscoveryCandidateDocument): string {
  return String(entry.document.candidate_id);
}

function expectedCandidatePath(entry: DiscoveryCandidateDocument): string {
  return `artifacts/discovery/candidates/${String(entry.document.candidate_id)}.r${String(
    entry.document.revision,
  )}.json`;
}

function candidateRefSets(document: Record<string, unknown>): readonly (readonly string[])[] {
  return [
    strings(document.retained_candidate_refs),
    strings(document.watchlist_candidate_refs),
    strings(document.rejected_candidate_refs),
  ];
}

function expectedDispositionSets(
  decisions: readonly Record<string, unknown>[],
): Readonly<Record<string, readonly string[]>> {
  return {
    retained: decisions
      .filter((entry) => entry.disposition === "retained")
      .map((entry) => String(entry.candidate_ref)),
    watchlist: decisions
      .filter((entry) => entry.disposition === "watchlist")
      .map((entry) => String(entry.candidate_ref)),
    rejected: decisions
      .filter((entry) => entry.disposition === "rejected")
      .map((entry) => String(entry.candidate_ref)),
  };
}

function evidenceLineage(document: Record<string, unknown>): Record<string, unknown> {
  return isRecord(document.evidence_lineage) ? document.evidence_lineage : {};
}

function sourcePartition(document: Record<string, unknown>): Record<string, unknown> {
  return isRecord(document.source_partition) ? document.source_partition : {};
}

function validateCandidateSubject(
  candidate: DiscoveryCandidateDocument,
  documentsByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  errors: ValidationIssue[],
): void {
  const subject = isRecord(candidate.document.subject) ? candidate.document.subject : {};
  const demand =
    typeof subject.demand_candidate_ref === "string"
      ? documentsByPath.get(subject.demand_candidate_ref)
      : undefined;
  const baseline =
    typeof subject.baseline_candidate_ref === "string"
      ? documentsByPath.get(subject.baseline_candidate_ref)
      : undefined;
  if (
    ((candidate.document.candidate_kind === "baseline_seed" ||
      candidate.document.candidate_kind === "solution_seed") &&
      (demand?.schemaVersion !== "startup_opportunity.discovery_candidate.v1" ||
        demand.document.candidate_kind !== "demand_seed")) ||
    (candidate.document.candidate_kind === "solution_seed" &&
      (baseline?.schemaVersion !== "startup_opportunity.discovery_candidate.v1" ||
        baseline.document.candidate_kind !== "baseline_seed" ||
        (isRecord(baseline.document.subject) &&
          baseline.document.subject.demand_candidate_ref !== subject.demand_candidate_ref)))
  ) {
    errors.push(
      issue(
        "discovery_candidate.subject_kind_mismatch",
        `${candidate.path}#/subject`,
        "baseline and solution subjects must bind typed demand/baseline candidates with one demand lineage",
      ),
    );
  }
}

function arraySubset(parent: unknown, child: unknown): boolean {
  const parentSet = new Set(strings(parent));
  return strings(child).every((value) => parentSet.has(value));
}

function validateCandidateRevision(
  candidate: DiscoveryCandidateDocument,
  candidatesByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  errors: ValidationIssue[],
): void {
  if (candidate.path !== expectedCandidatePath(candidate)) {
    errors.push(
      issue(
        "discovery_candidate.path_revision_mismatch",
        candidate.path,
        "candidate path must bind candidate_id and immutable revision",
        { expected: expectedCandidatePath(candidate) },
      ),
    );
  }
  const revision = candidate.document.revision;
  if (revision === 1) {
    return;
  }
  const parentRef = candidate.document.parent_candidate_ref;
  const parent = typeof parentRef === "string" ? candidatesByPath.get(parentRef) : undefined;
  if (
    parent === undefined ||
    parent.document.revision !== Number(revision) - 1 ||
    candidateIdentity(parent) !== candidateIdentity(candidate) ||
    parent.document.candidate_kind !== candidate.document.candidate_kind
  ) {
    errors.push(
      issue(
        "discovery_candidate.parent_revision_mismatch",
        `${candidate.path}#/parent_candidate_ref`,
        "candidate parent must be the exact previous revision of the same typed candidate",
        { parentRef, revision },
      ),
    );
    return;
  }
  if (candidate.document.parent_content_hash !== targetHash(parent)) {
    errors.push(
      issue(
        "discovery_candidate.parent_hash_mismatch",
        `${candidate.path}#/parent_content_hash`,
        "candidate parent hash must bind the canonical previous revision",
        { expected: targetHash(parent) },
      ),
    );
  }
  for (const field of [
    "run_id",
    "candidate_kind",
    "mode",
    "phase",
    "owner_slice",
    "discovery_profile",
    "market",
    "language",
    "scope_frame_ref",
    "research_plan_ref",
    "map_lineage",
    "formation",
    "pre_thesis_boundary",
  ]) {
    if (canonicalJson(parent.document[field]) !== canonicalJson(candidate.document[field])) {
      errors.push(
        issue(
          "discovery_candidate.immutable_identity_drift",
          `${candidate.path}#/${field}`,
          "candidate enrichment cannot change identity, scope, map lineage, or pre-thesis boundary",
          { field },
        ),
      );
    }
  }
  const parentLineage = evidenceLineage(parent.document);
  const childLineage = evidenceLineage(candidate.document);
  for (const field of EVIDENCE_LINEAGE_FIELDS) {
    if (!arraySubset(childLineage[field], parentLineage[field])) {
      errors.push(
        issue(
          "discovery_candidate.enrichment_ref_removed",
          `${candidate.path}#/evidence_lineage/${field}`,
          "candidate enrichment reference fields are append-only",
          { field },
        ),
      );
    }
  }
  const changed = CANDIDATE_CHANGE_FIELDS.filter((field) => {
    const [headValue, tail] = field.split(".", 2);
    const head = headValue ?? "";
    const before =
      tail === undefined ? parent.document[head] : evidenceLineage(parent.document)[tail];
    const after =
      tail === undefined ? candidate.document[head] : evidenceLineage(candidate.document)[tail];
    return canonicalJson(before) !== canonicalJson(after);
  });
  const enrichment = isRecord(candidate.document.enrichment) ? candidate.document.enrichment : {};
  if (!setEqual(strings(enrichment.changed_fields), changed)) {
    errors.push(
      issue(
        "discovery_candidate.changed_fields_mismatch",
        `${candidate.path}#/enrichment/changed_fields`,
        "candidate enrichment must declare the exact mechanically changed field set",
        { expected: changed },
      ),
    );
  }
  if (
    enrichment.revision_kind === "user_correction" &&
    !strings(enrichment.basis_refs).some((ref) => ref.startsWith("decisions.jsonl#"))
  ) {
    errors.push(
      issue(
        "discovery_candidate.user_correction_basis_missing",
        `${candidate.path}#/enrichment/basis_refs`,
        "user correction revisions require an exact G0.3 Decision log fragment",
      ),
    );
  }
}

function validateCandidateEnrichmentBindings(
  candidate: DiscoveryCandidateDocument,
  documentsByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  candidatesByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  errors: ValidationIssue[],
): void {
  if (candidate.document.revision === 1) {
    return;
  }
  const parentRef = candidate.document.parent_candidate_ref;
  const parent = typeof parentRef === "string" ? candidatesByPath.get(parentRef) : undefined;
  if (parent === undefined) {
    return;
  }
  const parentLineage = evidenceLineage(parent.document);
  const childLineage = evidenceLineage(candidate.document);
  for (const field of EVIDENCE_LINEAGE_FIELDS) {
    const expectedSchema = MATERIAL_SCHEMA_BY_LINEAGE_FIELD[field];
    if (expectedSchema === undefined) {
      continue;
    }
    const parentRefs = new Set(strings(parentLineage[field]));
    for (const ref of strings(childLineage[field]).filter((value) => !parentRefs.has(value))) {
      const material = documentsByPath.get(ref);
      const lineage = material === undefined ? {} : lineageOf(material.document);
      const task =
        typeof lineage.task_ref === "string" ? documentsByPath.get(lineage.task_ref) : undefined;
      const subjectMismatch =
        expectedSchema === "startup_opportunity.judgment_assessment.discovery_candidate.current" &&
        material?.document.subject_ref !== parent.path;
      if (
        material?.schemaVersion !== expectedSchema ||
        task?.schemaVersion !== "startup_opportunity.research_task.discovery_candidate.current" ||
        !strings(task.document.target_candidate_refs).includes(parent.path) ||
        !strings(lineage.candidate_refs).includes(parent.path) ||
        lineage.scope_frame_ref !== candidate.document.scope_frame_ref ||
        lineage.research_plan_ref !== candidate.document.research_plan_ref ||
        subjectMismatch
      ) {
        errors.push(
          issue(
            "discovery_candidate.enrichment_material_binding_mismatch",
            `${candidate.path}#/evidence_lineage/${field}`,
            "new enrichment material must bind the exact source candidate revision through its typed task lineage; Judgment subject must equal that source revision",
            { field, ref, expectedSchema, sourceCandidateRef: parent.path },
          ),
        );
      }
    }
  }
}

function validateCandidateFormation(
  candidate: DiscoveryCandidateDocument,
  documentsByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
  errors: ValidationIssue[],
): void {
  const formation = isRecord(candidate.document.formation) ? candidate.document.formation : {};
  const scope =
    typeof candidate.document.scope_frame_ref === "string"
      ? documentsByPath.get(candidate.document.scope_frame_ref)
      : undefined;
  const plan =
    typeof candidate.document.research_plan_ref === "string"
      ? documentsByPath.get(candidate.document.research_plan_ref)
      : undefined;
  if (
    scope?.schemaVersion !== "startup_opportunity.scope_frame.discovery.current" ||
    scope.document.run_id !== candidate.document.run_id ||
    formation.scope_frame_hash !== targetHash(scope) ||
    plan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
    plan.document.run_id !== candidate.document.run_id ||
    formation.research_plan_hash !== targetHash(plan)
  ) {
    errors.push(
      issue(
        "discovery_candidate.formation_scope_plan_mismatch",
        `${candidate.path}#/formation`,
        "Candidate formation must bind exact same-Run Scope and Plan content hashes",
      ),
    );
  }

  const bindings = Array.isArray(formation.synthesis_input_hashes)
    ? formation.synthesis_input_hashes.filter(isRecord)
    : [];
  const refs = bindings.flatMap((binding) =>
    typeof binding.ref === "string" ? [binding.ref] : [],
  );
  const subject = isRecord(candidate.document.subject) ? candidate.document.subject : {};
  const requiredRefs = [
    isRecord(candidate.document.map_lineage)
      ? String(candidate.document.map_lineage.source_map_ref)
      : "",
    ...(typeof subject.demand_candidate_ref === "string" ? [subject.demand_candidate_ref] : []),
    ...(typeof subject.baseline_candidate_ref === "string" ? [subject.baseline_candidate_ref] : []),
  ].filter((ref) => ref.length > 0);
  const envelopeInputs = strings(candidate.envelope?.input_refs);
  const formationEnvelopeMismatch =
    candidate.document.revision === 1
      ? refs.some((ref) => !envelopeInputs.includes(ref))
      : !envelopeInputs.includes(String(candidate.document.parent_candidate_ref));
  if (
    new Set(refs).size !== refs.length ||
    requiredRefs.some((ref) => !refs.includes(ref)) ||
    formationEnvelopeMismatch
  ) {
    errors.push(
      issue(
        "discovery_candidate.formation_input_set_mismatch",
        `${candidate.path}#/formation/synthesis_input_hashes`,
        "Candidate formation inputs must uniquely include its Map and typed subject lineage and remain declared by the envelope",
        { requiredRefs, refs },
      ),
    );
  }
  for (const [index, binding] of bindings.entries()) {
    const target = typeof binding.ref === "string" ? documentsByPath.get(binding.ref) : undefined;
    if (
      target === undefined ||
      target.document.run_id !== candidate.document.run_id ||
      binding.content_hash !== targetHash(target)
    ) {
      errors.push(
        issue(
          "discovery_candidate.formation_input_binding_mismatch",
          `${candidate.path}#/formation/synthesis_input_hashes/${index}`,
          "Candidate formation inputs must resolve to exact same-Run formal artifacts and content hashes",
        ),
      );
    }
  }

  const priorRefs = strings(formation.prior_input_decision_refs);
  const inheritedPriorRefs = [
    ...new Set(
      refs.flatMap((ref) => {
        const target = documentsByPath.get(ref);
        const targetProvenance = isRecord(target?.document.content_provenance)
          ? target.document.content_provenance
          : {};
        const targetFormation = isRecord(target?.document.formation)
          ? target.document.formation
          : {};
        return [
          ...strings(targetProvenance.prior_input_decision_refs),
          ...strings(targetFormation.prior_input_decision_refs),
        ];
      }),
    ),
  ].sort();
  const missingInheritedPriorRefs = inheritedPriorRefs.filter((ref) => !priorRefs.includes(ref));
  if (missingInheritedPriorRefs.length > 0) {
    errors.push(
      issue(
        "discovery_candidate.prior_input_provenance_not_propagated",
        `${candidate.path}#/formation/prior_input_decision_refs`,
        "Candidate formation must retain every prior admission inherited through its current-Run synthesis inputs",
        { missingInheritedPriorRefs },
      ),
    );
  }
  if (
    (formation.synthesis_origin === "current_run_synthesis" && priorRefs.length > 0) ||
    (formation.synthesis_origin === "prior_informed_synthesis" && priorRefs.length === 0)
  ) {
    errors.push(
      issue(
        "discovery_candidate.prior_provenance_state_mismatch",
        `${candidate.path}#/formation`,
        "Candidate synthesis origin must explicitly agree with its admitted prior inputs",
      ),
    );
  }
  for (const ref of priorRefs) {
    const decision = exactRecords.get(ref);
    if (
      decision?.schema_version !== "startup_opportunity.decision.v1" ||
      decision.decision_type !== "prior_input_admitted" ||
      decision.run_id !== candidate.document.run_id ||
      decision.prior_source_run_id === candidate.document.run_id ||
      decision.prior_use_boundary !== "hypothesis_input_only"
    ) {
      errors.push(
        issue(
          "discovery_candidate.prior_input_admission_invalid",
          `${candidate.path}#/formation/prior_input_decision_refs`,
          "historical Candidate input requires an exact same-Run admission decision with distinct source Run and hypothesis-only use",
          { ref },
        ),
      );
    }
  }
}

function validateMapLineage(
  candidate: DiscoveryCandidateDocument,
  documentsByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  policy: DiscoveryCandidatePolicy,
  errors: ValidationIssue[],
): void {
  const kind = candidate.document.candidate_kind as CandidateKind;
  const rule = policy.candidate_kinds[kind];
  const lineage = isRecord(candidate.document.map_lineage) ? candidate.document.map_lineage : {};
  const mapRef = lineage.source_map_ref;
  const map = typeof mapRef === "string" ? documentsByPath.get(mapRef) : undefined;
  const pointer = lineage.fragment_pointer;
  const fragment = map === undefined ? null : resolveMapFragment(map.document, pointer);
  const collection = typeof pointer === "string" ? pointer.replace(/\/[0-9]+$/, "") : "";
  const expectedFragmentId =
    fragment === null || rule === undefined ? null : fragment[rule.fragment_id_field];
  const expectedStatus = fragment?.status;
  if (
    rule === undefined ||
    map === undefined ||
    map.schemaVersion !== rule.map_schema_version ||
    lineage.source_map_schema_version !== rule.map_schema_version ||
    !rule.allowed_fragment_collections.includes(collection) ||
    fragment === null ||
    lineage.source_map_id !== map.document.map_id ||
    lineage.source_map_revision !== map.document.revision ||
    lineage.source_map_content_hash !== targetHash(map) ||
    lineage.fragment_id !== expectedFragmentId ||
    lineage.fragment_ref !== `${String(mapRef)}#${String(expectedFragmentId)}` ||
    lineage.fragment_content_hash !== canonicalContentHash(fragment) ||
    lineage.fragment_status !== expectedStatus
  ) {
    errors.push(
      issue(
        "discovery_candidate.map_lineage_mismatch",
        `${candidate.path}#/map_lineage`,
        "candidate must bind one exact allowed G2.1 map fragment, ref, hash, id, and revision",
        { candidateKind: kind, mapRef, pointer },
      ),
    );
  }
}

function validateEnvelope(entry: DiscoveryCandidateDocument, errors: ValidationIssue[]): void {
  if (!CONTRACT_SCHEMA_VERSIONS.has(entry.schemaVersion)) {
    return;
  }
  const expectedProducer = PRODUCER_BY_SCHEMA[entry.schemaVersion];
  if (
    entry.envelope === null ||
    ![
      "startup_opportunity.artifact_envelope.current",
      "startup_opportunity.artifact_envelope.current",
    ].includes(String(entry.envelope.schema_version)) ||
    entry.envelope.artifact_type !== entry.schemaVersion ||
    entry.envelope.artifact_path !== entry.path ||
    entry.envelope.run_id !== entry.document.run_id ||
    entry.envelope.producer_role !== expectedProducer ||
    entry.envelope.content_hash !== canonicalContentHash(entry.document)
  ) {
    errors.push(
      issue(
        "discovery_candidate.envelope_binding_mismatch",
        entry.path,
        "G2.2 contract documents require exact v9 envelope, producer, path, Run, and content hash binding",
        { expectedProducer },
      ),
    );
  }
}

function validateScopeIdentity(
  entry: DiscoveryCandidateDocument,
  scope: DiscoveryCandidateDocument,
  plan: DiscoveryCandidateDocument,
  historicalPlanRefs: ReadonlySet<string>,
  errors: ValidationIssue[],
): void {
  if (
    entry.document.run_id !== scope.document.run_id ||
    entry.document.scope_frame_ref !== scope.path ||
    (entry.document.research_plan_ref !== plan.path &&
      !historicalPlanRefs.has(String(entry.document.research_plan_ref))) ||
    entry.document.discovery_profile !== scope.document.discovery_profile ||
    entry.document.market !== scope.document.market ||
    entry.document.language !== scope.document.language
  ) {
    errors.push(
      issue(
        "discovery_candidate.scope_identity_mismatch",
        entry.path,
        "candidate must retain same-Run Scope, current Plan, profile, market, and language ownership",
      ),
    );
  }
}

function lineageOf(document: Record<string, unknown>): Record<string, unknown> {
  return isRecord(document.lineage) ? document.lineage : {};
}

function validateDiscoveryLineage(
  entry: DiscoveryCandidateDocument,
  documentsByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  scope: DiscoveryCandidateDocument,
  errors: ValidationIssue[],
): void {
  if (
    ![
      "startup_opportunity.evidence.discovery_candidate.current",
      "startup_opportunity.claim.discovery_candidate.current",
      "startup_opportunity.finding.discovery_candidate.current",
      "startup_opportunity.insight.discovery_candidate.current",
      "startup_opportunity.judgment_assessment.discovery_candidate.current",
      "startup_opportunity.source_manifest.discovery_candidate.current",
    ].includes(entry.schemaVersion)
  ) {
    return;
  }
  const lineage = lineageOf(entry.document);
  const task =
    typeof lineage.task_ref === "string" ? documentsByPath.get(lineage.task_ref) : undefined;
  if (
    task?.schemaVersion !== "startup_opportunity.research_task.discovery_candidate.current" ||
    lineage.attempt !== task.document.attempt ||
    entry.document.unit_id !== task.document.unit_id ||
    lineage.scope_frame_ref !== scope.path ||
    lineage.research_plan_ref !== task.document.research_plan_ref ||
    !setEqual(strings(lineage.candidate_refs), strings(task.document.target_candidate_refs))
  ) {
    errors.push(
      issue(
        "discovery_candidate.research_lineage_mismatch",
        `${entry.path}#/lineage`,
        "discovery research material must bind the exact task attempt, candidates, Scope, Plan, and unit",
      ),
    );
  }
  if (
    (entry.schemaVersion === "startup_opportunity.evidence.discovery_candidate.current" &&
      entry.document.research_phase_role !== task?.document.source_phase) ||
    (entry.schemaVersion === "startup_opportunity.source_manifest.discovery_candidate.current" &&
      entry.document.research_phase_role !== task?.document.source_phase)
  ) {
    errors.push(
      issue(
        "discovery_candidate.research_phase_role_mismatch",
        entry.path,
        "Evidence and Source Manifest phase roles must match the owning discovery task",
      ),
    );
  }
}

function validateSourcePartition(
  candidate: DiscoveryCandidateDocument,
  documentsByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  errors: ValidationIssue[],
): void {
  const partition = sourcePartition(candidate.document);
  const generationRefs = strings(partition.generation_source_manifest_refs);
  const evaluationRefs = strings(partition.evaluation_source_manifest_refs);
  const enrichment = isRecord(candidate.document.enrichment) ? candidate.document.enrichment : {};
  const lineageManifestRefs = strings(evidenceLineage(candidate.document).source_manifest_refs);
  const generationGroups: string[] = [];
  const evaluationGroups: string[] = [];
  for (const [refs, expectedRole, groups] of [
    [generationRefs, "candidate_generation", generationGroups],
    [evaluationRefs, "candidate_evaluation", evaluationGroups],
  ] as const) {
    for (const ref of refs) {
      const manifest = documentsByPath.get(ref);
      if (
        manifest?.schemaVersion !==
          "startup_opportunity.source_manifest.discovery_candidate.current" ||
        manifest.document.research_phase_role !== expectedRole
      ) {
        errors.push(
          issue(
            "discovery_candidate.source_partition_type_mismatch",
            `${candidate.path}#/source_partition`,
            "generation and evaluation refs must target typed Source Manifests with matching phase roles",
            { ref, expectedRole },
          ),
        );
        continue;
      }
      const groupsInManifest = Array.isArray(manifest.document.canonical_source_groups)
        ? manifest.document.canonical_source_groups
        : [];
      groups.push(
        ...groupsInManifest.flatMap((group) =>
          isRecord(group) && typeof group.group_id === "string" ? [group.group_id] : [],
        ),
      );
    }
  }
  const overlap = [
    ...new Set(generationGroups.filter((group) => evaluationGroups.includes(group))),
  ];
  if (
    (enrichment.revision_kind === "evidence_enrichment" &&
      (generationRefs.length === 0 || evaluationRefs.length === 0)) ||
    [...generationRefs, ...evaluationRefs].some((ref) => !lineageManifestRefs.includes(ref))
  ) {
    errors.push(
      issue(
        "discovery_candidate.source_partition_type_mismatch",
        `${candidate.path}#/source_partition`,
        "evidence enrichment requires generation and evaluation Source Manifests included in candidate lineage",
      ),
    );
  }
  if (
    !setEqual(strings(partition.overlap_source_group_ids), overlap) ||
    (overlap.length === 0 && partition.overlap_assessment !== "none") ||
    (overlap.length > 0 && partition.overlap_assessment === "none")
  ) {
    errors.push(
      issue(
        "discovery_candidate.source_overlap_mismatch",
        `${candidate.path}#/source_partition`,
        "source-group overlap must be exact and explicitly disclosed",
        { expectedOverlap: overlap },
      ),
    );
  }
}

function validateSourceManifestSummary(
  sourceManifest: DiscoveryCandidateDocument,
  documentsByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  errors: ValidationIssue[],
): void {
  const evidence = strings(sourceManifest.document.accepted_evidence_refs)
    .map((ref) => documentsByPath.get(ref))
    .filter(
      (entry): entry is DiscoveryCandidateDocument =>
        entry?.schemaVersion === "startup_opportunity.evidence.discovery_candidate.current",
    );
  if (evidence.length !== strings(sourceManifest.document.accepted_evidence_refs).length) {
    return;
  }
  const expectedFreshness = {
    active: 0,
    stale: 0,
    unverified: 0,
    superseded: 0,
  };
  for (const entry of evidence) {
    const status = entry.document.evidence_lifecycle_status;
    if (
      status === "active" ||
      status === "stale" ||
      status === "unverified" ||
      status === "superseded"
    ) {
      expectedFreshness[status] += 1;
    }
  }
  if (
    canonicalJson(sourceManifest.document.freshness_summary) !== canonicalJson(expectedFreshness)
  ) {
    errors.push(
      issue(
        "discovery_candidate.source_manifest_freshness_mismatch",
        `${sourceManifest.path}#/freshness_summary`,
        "Source Manifest freshness counts must be recomputed from accepted Evidence lifecycle state",
        { expectedFreshness },
      ),
    );
  }

  const expectedStances = [
    ...new Set(
      evidence
        .map((entry) => entry.document.evidence_role)
        .filter((role): role is string => typeof role === "string"),
    ),
  ].sort();
  if (!setEqual(strings(sourceManifest.document.stance_coverage), expectedStances)) {
    errors.push(
      issue(
        "discovery_candidate.source_manifest_stance_mismatch",
        `${sourceManifest.path}#/stance_coverage`,
        "Source Manifest stance coverage must equal accepted Evidence roles",
        { expectedStances },
      ),
    );
  }

  const evidenceDates = evidence
    .map((entry) => entry.document.valid_as_of)
    .filter((value): value is string => typeof value === "string")
    .sort();
  const declaredDates = strings(sourceManifest.document.time_coverage)
    .flatMap((entry) => [...entry.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)].map((match) => match[0]))
    .filter((value): value is string => value !== undefined)
    .sort();
  if (
    declaredDates.length > 0 &&
    evidenceDates.length > 0 &&
    (declaredDates[0] !== evidenceDates[0] || declaredDates.at(-1) !== evidenceDates.at(-1))
  ) {
    errors.push(
      issue(
        "discovery_candidate.source_manifest_time_coverage_mismatch",
        `${sourceManifest.path}#/time_coverage`,
        "Source Manifest declared date bounds must equal accepted Evidence valid_as_of bounds",
        {
          expectedMin: evidenceDates[0],
          expectedMax: evidenceDates.at(-1),
          declaredMin: declaredDates[0],
          declaredMax: declaredDates.at(-1),
        },
      ),
    );
  }
}

function validateTask(
  task: DiscoveryCandidateDocument,
  documentsByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  scope: DiscoveryCandidateDocument,
  plan: DiscoveryCandidateDocument,
  historicalPlanRefs: ReadonlySet<string>,
  errors: ValidationIssue[],
): void {
  const expectedPath = `tasks/discovery/${String(task.document.unit_id)}.attempt-${String(
    task.document.attempt,
  )}.json`;
  const candidateRefs = strings(task.document.target_candidate_refs);
  const taskPlanRef = String(task.document.research_plan_ref);
  const historicalPlanBindingValid =
    historicalPlanRefs.has(taskPlanRef) &&
    candidateRefs.every(
      (ref) => documentsByPath.get(ref)?.document.research_plan_ref === taskPlanRef,
    );
  if (
    task.path !== expectedPath ||
    task.document.scope_frame_ref !== scope.path ||
    (task.document.research_plan_ref !== plan.path && !historicalPlanBindingValid) ||
    candidateRefs.some(
      (ref) =>
        documentsByPath.get(ref)?.schemaVersion !== "startup_opportunity.discovery_candidate.v1",
    )
  ) {
    errors.push(
      issue(
        "discovery_candidate.task_binding_mismatch",
        task.path,
        "discovery task must bind its canonical attempt path, Scope, Plan, and typed candidates",
      ),
    );
  }
}

function validateLaneResult(
  lane: DiscoveryCandidateDocument,
  documentsByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  errors: ValidationIssue[],
): void {
  const task =
    typeof lane.document.task_ref === "string"
      ? documentsByPath.get(lane.document.task_ref)
      : undefined;
  if (
    task?.schemaVersion !== "startup_opportunity.research_task.discovery_candidate.current" ||
    lane.document.unit_id !== task.document.unit_id ||
    lane.document.attempt !== task.document.attempt ||
    lane.document.lane_type !== task.document.unit_type ||
    task.document.allowed_output_path !== lane.path
  ) {
    errors.push(
      issue(
        "discovery_candidate.lane_task_mismatch",
        lane.path,
        "lane result must bind its exact Research Task, attempt, lane type, and allowed output path",
      ),
    );
  }
  const decisions = Array.isArray(lane.document.pre_kill_decisions)
    ? lane.document.pre_kill_decisions.filter(isRecord)
    : [];
  const decisionIds = decisions.map((entry) => String(entry.disposition_id));
  const candidateIds = decisions.map((entry) => String(entry.candidate_ref));
  const expected = expectedDispositionSets(decisions);
  const sets = candidateRefSets(lane.document);
  const inactive = ["failed", "ignored_late", "superseded"].includes(String(lane.document.status));
  if (
    new Set(decisionIds).size !== decisionIds.length ||
    new Set(candidateIds).size !== candidateIds.length ||
    !disjoint(sets) ||
    !setEqual(sets[0] ?? [], expected.retained ?? []) ||
    !setEqual(sets[1] ?? [], expected.watchlist ?? []) ||
    !setEqual(sets[2] ?? [], expected.rejected ?? []) ||
    (inactive &&
      (decisions.length > 0 ||
        sets.some((set) => set.length > 0) ||
        (Array.isArray(lane.document.scored_candidates) &&
          lane.document.scored_candidates.length > 0)))
  ) {
    errors.push(
      issue(
        "discovery_candidate.lane_disposition_mismatch",
        lane.path,
        "lane dispositions require unique identities, exact exclusive sets, and no current refs from failed/late/superseded results",
      ),
    );
  }
  for (const decision of decisions) {
    const ref = String(decision.candidate_ref);
    if (
      documentsByPath.get(ref)?.schemaVersion !== "startup_opportunity.discovery_candidate.v1" ||
      !strings(task?.document.target_candidate_refs).includes(ref)
    ) {
      errors.push(
        issue(
          "discovery_candidate.disposition_target_invalid",
          `${lane.path}#/pre_kill_decisions`,
          "pre-kill disposition must target a typed candidate assigned to this task",
          { ref },
        ),
      );
    }
    for (const judgmentRef of strings(decision.judgment_assessment_refs)) {
      const judgment = documentsByPath.get(judgmentRef);
      const judgmentLineage = judgment === undefined ? {} : lineageOf(judgment.document);
      if (
        judgment?.schemaVersion !==
          "startup_opportunity.judgment_assessment.discovery_candidate.current" ||
        judgment.document.subject_ref !== ref ||
        judgmentLineage.task_ref !== lane.document.task_ref ||
        !strings(task?.document.target_candidate_refs).includes(ref) ||
        !strings(judgmentLineage.candidate_refs).includes(ref) ||
        !strings(evidenceLineage(lane.document).judgment_assessment_refs).includes(judgmentRef)
      ) {
        errors.push(
          issue(
            "discovery_candidate.lane_judgment_subject_mismatch",
            `${lane.path}#/pre_kill_decisions`,
            "each lane pre-kill Judgment must be typed, subject-bound to the affected candidate, and owned by the lane task lineage",
            { candidateRef: ref, judgmentRef, taskRef: lane.document.task_ref },
          ),
        );
      }
    }
  }
  const diversity = isRecord(lane.document.candidate_diversity_summary)
    ? lane.document.candidate_diversity_summary
    : {};
  const retained = sets[0] ?? [];
  for (const ref of [
    ...strings(diversity.diversity_retention_refs),
    ...strings(diversity.counterfactual_candidate_refs),
  ]) {
    const decision = decisions.find((entry) => entry.candidate_ref === ref);
    if (
      !retained.includes(ref) ||
      !["diversity", "counterfactual"].includes(String(decision?.retention_basis))
    ) {
      errors.push(
        issue(
          "discovery_candidate.diversity_retention_mismatch",
          `${lane.path}#/candidate_diversity_summary`,
          "diversity and counterfactual retention must be explicit retained dispositions",
          { ref },
        ),
      );
    }
  }
}

function descendants(
  candidate: DiscoveryCandidateDocument,
  source: DiscoveryCandidateDocument,
  candidatesByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
): boolean {
  if (candidateIdentity(candidate) !== candidateIdentity(source)) {
    return false;
  }
  let current: DiscoveryCandidateDocument | undefined = candidate;
  while (current !== undefined) {
    if (current.path === source.path) {
      return true;
    }
    const parentRef: unknown = current.document.parent_candidate_ref;
    current = typeof parentRef === "string" ? candidatesByPath.get(parentRef) : undefined;
  }
  return false;
}

function validateFanIn(
  fanIn: DiscoveryCandidateDocument,
  documentsByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  candidatesByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  errors: ValidationIssue[],
): void {
  const classification = isRecord(fanIn.document.lane_result_classification)
    ? fanIn.document.lane_result_classification
    : {};
  const statusFields: Readonly<Record<string, string>> = {
    completed_refs: "completed",
    partial_refs: "partial",
    insufficient_evidence_refs: "insufficient_evidence",
    failed_refs: "failed",
    ignored_late_refs: "ignored_late",
    superseded_refs: "superseded",
  };
  const classifiedSets = Object.keys(statusFields).map((field) => strings(classification[field]));
  if (!disjoint(classifiedSets)) {
    errors.push(
      issue(
        "discovery_candidate.fan_in_lane_overlap",
        `${fanIn.path}#/lane_result_classification`,
        "each lane result may appear in exactly one fan-in status class",
      ),
    );
  }
  for (const [field, expectedStatus] of Object.entries(statusFields)) {
    for (const ref of strings(classification[field])) {
      const lane = documentsByPath.get(ref);
      if (
        lane?.schemaVersion !== "startup_opportunity.discovery_lane_result.v1" ||
        lane.document.status !== expectedStatus
      ) {
        errors.push(
          issue(
            "discovery_candidate.fan_in_lane_status_mismatch",
            `${fanIn.path}#/lane_result_classification/${field}`,
            "fan-in lane ref must target the exact declared terminal status",
            { ref, expectedStatus },
          ),
        );
      }
    }
  }
  const eligible = [
    ...strings(classification.completed_refs),
    ...strings(classification.partial_refs),
    ...strings(classification.insufficient_evidence_refs),
  ];
  const excluded = [
    ...strings(classification.failed_refs),
    ...strings(classification.ignored_late_refs),
    ...strings(classification.superseded_refs),
  ];
  const decisions = Array.isArray(fanIn.document.candidate_dispositions)
    ? fanIn.document.candidate_dispositions.filter(isRecord)
    : [];
  const expected = expectedDispositionSets(decisions);
  const sets = candidateRefSets(fanIn.document);
  const dispositionIds = decisions.map((entry) => String(entry.disposition_id));
  if (
    fanIn.path !== `artifacts/discovery/fan-in.r${String(fanIn.document.revision)}.json` ||
    new Set(dispositionIds).size !== dispositionIds.length ||
    !disjoint(sets) ||
    !setEqual(sets[0] ?? [], expected.retained ?? []) ||
    !setEqual(sets[1] ?? [], expected.watchlist ?? []) ||
    !setEqual(sets[2] ?? [], expected.rejected ?? [])
  ) {
    errors.push(
      issue(
        "discovery_candidate.fan_in_disposition_mismatch",
        fanIn.path,
        "fan-in path, disposition identities, and retained/watchlist/rejected sets must be exact and mutually exclusive",
      ),
    );
  }
  const dispositionJudgmentRefs = [
    ...new Set(decisions.flatMap((entry) => strings(entry.judgment_assessment_refs))),
  ];
  if (!setEqual(strings(fanIn.document.judgment_assessment_refs), dispositionJudgmentRefs)) {
    errors.push(
      issue(
        "discovery_candidate.fan_in_judgment_closure_mismatch",
        `${fanIn.path}#/judgment_assessment_refs`,
        "fan-in top-level Judgment refs must be the exact closure of disposition Judgment refs",
        { expected: dispositionJudgmentRefs },
      ),
    );
  }
  for (const decision of decisions) {
    const finalRef = String(decision.candidate_ref);
    const finalCandidate = candidatesByPath.get(finalRef);
    const laneRefs = strings(decision.supporting_lane_result_refs);
    const sourceRefs = strings(decision.source_candidate_refs);
    const supportingLaneJudgmentRefs = new Set(
      laneRefs.flatMap((ref) => {
        const lane = documentsByPath.get(ref);
        return Array.isArray(lane?.document.pre_kill_decisions)
          ? lane.document.pre_kill_decisions.flatMap((entry) =>
              isRecord(entry) && sourceRefs.includes(String(entry.candidate_ref))
                ? strings(entry.judgment_assessment_refs)
                : [],
            )
          : [];
      }),
    );
    const laneSources = laneRefs.flatMap((ref) => {
      const lane = documentsByPath.get(ref);
      return Array.isArray(lane?.document.pre_kill_decisions)
        ? lane.document.pre_kill_decisions.flatMap((entry) =>
            isRecord(entry) && typeof entry.candidate_ref === "string" ? [entry.candidate_ref] : [],
          )
        : [];
    });
    const enrichment = isRecord(finalCandidate?.document.enrichment)
      ? finalCandidate.document.enrichment
      : {};
    const excludedBasisRefs = strings(enrichment.basis_refs).filter((ref) =>
      excluded.includes(ref),
    );
    if (
      finalCandidate?.schemaVersion !== "startup_opportunity.discovery_candidate.v1" ||
      laneRefs.some((ref) => !eligible.includes(ref)) ||
      excludedBasisRefs.length > 0 ||
      sourceRefs.some(
        (ref) =>
          !laneSources.includes(ref) ||
          finalCandidate === undefined ||
          !descendants(
            finalCandidate,
            candidatesByPath.get(ref) ?? finalCandidate,
            candidatesByPath,
          ),
      )
    ) {
      errors.push(
        issue(
          "discovery_candidate.fan_in_candidate_lineage_mismatch",
          `${fanIn.path}#/candidate_dispositions`,
          "fan-in may only upgrade an explicitly referenced lane candidate through exact revision lineage",
          { finalRef, laneRefs, sourceRefs, excludedBasisRefs },
        ),
      );
    }
    for (const judgmentRef of strings(decision.judgment_assessment_refs)) {
      const judgment = documentsByPath.get(judgmentRef);
      const subjectRef =
        typeof judgment?.document.subject_ref === "string"
          ? judgment.document.subject_ref
          : undefined;
      const subjectCandidate =
        subjectRef === undefined ? undefined : candidatesByPath.get(subjectRef);
      if (
        judgment?.schemaVersion !==
          "startup_opportunity.judgment_assessment.discovery_candidate.current" ||
        subjectRef === undefined ||
        !sourceRefs.includes(subjectRef) ||
        subjectCandidate === undefined ||
        finalCandidate === undefined ||
        !descendants(finalCandidate, subjectCandidate, candidatesByPath) ||
        !supportingLaneJudgmentRefs.has(judgmentRef)
      ) {
        errors.push(
          issue(
            "discovery_candidate.fan_in_judgment_subject_mismatch",
            `${fanIn.path}#/candidate_dispositions`,
            "fan-in disposition Judgment must come from a supporting lane, target an exact source candidate revision, and lead by parent lineage to the final candidate",
            { finalRef, sourceRefs, judgmentRef, subjectRef },
          ),
        );
      }
    }
  }
  const diversity = isRecord(fanIn.document.candidate_diversity_summary)
    ? fanIn.document.candidate_diversity_summary
    : {};
  for (const ref of [
    ...strings(diversity.diversity_retention_refs),
    ...strings(diversity.counterfactual_candidate_refs),
  ]) {
    if (!(sets[0] ?? []).includes(ref)) {
      errors.push(
        issue(
          "discovery_candidate.fan_in_diversity_mismatch",
          `${fanIn.path}#/candidate_diversity_summary`,
          "fan-in diversity references must be retained typed candidates",
          { ref },
        ),
      );
    }
  }
}

export function isDiscoveryCandidateSchemaVersion(schemaVersion: string): boolean {
  return CONTRACT_SCHEMA_VERSIONS.has(schemaVersion);
}

export function validateDiscoveryCandidateContract(
  documents: readonly DiscoveryCandidateDocument[],
  policy: DiscoveryCandidatePolicy,
  historicalPlanRefs: ReadonlySet<string> = new Set(),
  exactRecords: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): readonly ValidationIssue[] {
  if (!documents.some((entry) => CONTRACT_SCHEMA_VERSIONS.has(entry.schemaVersion))) {
    return [];
  }
  const errors: ValidationIssue[] = [];
  const documentsByPath = new Map(documents.map((entry) => [entry.path, entry]));
  const candidates = documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.discovery_candidate.v1",
  );
  const candidatesByPath = new Map(candidates.map((entry) => [entry.path, entry]));
  const scopes = documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.scope_frame.discovery.current",
  );
  const manifests = documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.run_manifest.v1",
  );
  const plans = documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.research_plan.v1",
  );
  const currentPlanRef = manifests[0]?.document.current_plan_ref;
  const currentPlans = plans.filter((entry) => entry.path === currentPlanRef);
  if (
    scopes.length !== 1 ||
    manifests.length !== 1 ||
    currentPlans.length !== 1 ||
    candidates.length === 0
  ) {
    errors.push(
      issue(
        "discovery_candidate.bundle_cardinality",
        "/documents",
        "G2.2 contract requires one Scope, one current Plan, and at least one typed candidate",
        {
          scopeCount: scopes.length,
          manifestCount: manifests.length,
          currentPlanRef,
          currentPlanCount: currentPlans.length,
          totalPlanCount: plans.length,
          candidateCount: candidates.length,
        },
      ),
    );
    return sortIssues(errors);
  }
  const scope = scopes[0] as DiscoveryCandidateDocument;
  const plan = currentPlans[0] as DiscoveryCandidateDocument;
  for (const entry of documents) {
    validateEnvelope(entry, errors);
    validateDiscoveryLineage(entry, documentsByPath, scope, errors);
  }
  for (const candidate of candidates) {
    validateScopeIdentity(candidate, scope, plan, historicalPlanRefs, errors);
    validateCandidateSubject(candidate, documentsByPath, errors);
    validateCandidateRevision(candidate, candidatesByPath, errors);
    validateCandidateEnrichmentBindings(candidate, documentsByPath, candidatesByPath, errors);
    validateCandidateFormation(candidate, documentsByPath, exactRecords, errors);
    validateMapLineage(candidate, documentsByPath, policy, errors);
    validateSourcePartition(candidate, documentsByPath, errors);
  }
  for (const task of documents.filter(
    (entry) =>
      entry.schemaVersion === "startup_opportunity.research_task.discovery_candidate.current",
  )) {
    validateTask(task, documentsByPath, scope, plan, historicalPlanRefs, errors);
  }
  for (const sourceManifest of documents.filter(
    (entry) =>
      entry.schemaVersion === "startup_opportunity.source_manifest.discovery_candidate.current",
  )) {
    validateSourceManifestSummary(sourceManifest, documentsByPath, errors);
  }
  for (const lane of documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.discovery_lane_result.v1",
  )) {
    validateLaneResult(lane, documentsByPath, errors);
  }
  for (const fanIn of documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.discovery_fan_in.v2",
  )) {
    validateFanIn(fanIn, documentsByPath, candidatesByPath, errors);
  }
  return sortIssues(errors);
}

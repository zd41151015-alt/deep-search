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
  "startup_opportunity.research_task.v2",
  "startup_opportunity.evidence.v2",
  "startup_opportunity.claim.v2",
  "startup_opportunity.finding.v2",
  "startup_opportunity.insight.v2",
  "startup_opportunity.judgment_assessment.v2",
  "startup_opportunity.source_manifest.v2",
  "startup_opportunity.discovery_lane_result.v1",
  "startup_opportunity.discovery_fan_in.v1",
  "startup_opportunity.discovery_candidate_conversion.v1",
]);

const PRODUCER_BY_SCHEMA: Readonly<Record<string, string>> = {
  "startup_opportunity.discovery_candidate.v1": "main_agent",
  "startup_opportunity.research_task.v2": "main_agent",
  "startup_opportunity.evidence.v2": "lane_researcher",
  "startup_opportunity.claim.v2": "lane_researcher",
  "startup_opportunity.finding.v2": "lane_researcher",
  "startup_opportunity.insight.v2": "lane_researcher",
  "startup_opportunity.judgment_assessment.v2": "lane_researcher",
  "startup_opportunity.source_manifest.v2": "lane_researcher",
  "startup_opportunity.discovery_lane_result.v1": "lane_researcher",
  "startup_opportunity.discovery_fan_in.v1": "main_agent",
  "startup_opportunity.discovery_candidate_conversion.v1": "main_agent",
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
  evidence_refs: "startup_opportunity.evidence.v2",
  claim_refs: "startup_opportunity.claim.v2",
  finding_refs: "startup_opportunity.finding.v2",
  insight_refs: "startup_opportunity.insight.v2",
  judgment_assessment_refs: "startup_opportunity.judgment_assessment.v2",
  source_manifest_refs: "startup_opportunity.source_manifest.v2",
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
        expectedSchema === "startup_opportunity.judgment_assessment.v2" &&
        material?.document.subject_ref !== parent.path;
      if (
        material?.schemaVersion !== expectedSchema ||
        task?.schemaVersion !== "startup_opportunity.research_task.v2" ||
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
    entry.envelope.schema_version !== "startup_opportunity.artifact_envelope.v9" ||
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
  errors: ValidationIssue[],
): void {
  if (
    entry.document.run_id !== scope.document.run_id ||
    entry.document.scope_frame_ref !== scope.path ||
    entry.document.research_plan_ref !== plan.path ||
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
  plan: DiscoveryCandidateDocument,
  errors: ValidationIssue[],
): void {
  if (
    ![
      "startup_opportunity.evidence.v2",
      "startup_opportunity.claim.v2",
      "startup_opportunity.finding.v2",
      "startup_opportunity.insight.v2",
      "startup_opportunity.judgment_assessment.v2",
      "startup_opportunity.source_manifest.v2",
    ].includes(entry.schemaVersion)
  ) {
    return;
  }
  const lineage = lineageOf(entry.document);
  const task =
    typeof lineage.task_ref === "string" ? documentsByPath.get(lineage.task_ref) : undefined;
  if (
    task?.schemaVersion !== "startup_opportunity.research_task.v2" ||
    lineage.attempt !== task.document.attempt ||
    entry.document.unit_id !== task.document.unit_id ||
    lineage.scope_frame_ref !== scope.path ||
    lineage.research_plan_ref !== plan.path ||
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
    (entry.schemaVersion === "startup_opportunity.evidence.v2" &&
      entry.document.research_phase_role !== task?.document.source_phase) ||
    (entry.schemaVersion === "startup_opportunity.source_manifest.v2" &&
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
        manifest?.schemaVersion !== "startup_opportunity.source_manifest.v2" ||
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

function validateTask(
  task: DiscoveryCandidateDocument,
  documentsByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  scope: DiscoveryCandidateDocument,
  plan: DiscoveryCandidateDocument,
  errors: ValidationIssue[],
): void {
  const expectedPath = `tasks/discovery/${String(task.document.unit_id)}.attempt-${String(
    task.document.attempt,
  )}.json`;
  const candidateRefs = strings(task.document.target_candidate_refs);
  if (
    task.path !== expectedPath ||
    task.document.scope_frame_ref !== scope.path ||
    task.document.research_plan_ref !== plan.path ||
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
    task?.schemaVersion !== "startup_opportunity.research_task.v2" ||
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
        judgment?.schemaVersion !== "startup_opportunity.judgment_assessment.v2" ||
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
        judgment?.schemaVersion !== "startup_opportunity.judgment_assessment.v2" ||
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

function validateConversion(
  conversion: DiscoveryCandidateDocument,
  documentsByPath: ReadonlyMap<string, DiscoveryCandidateDocument>,
  candidatesById: ReadonlyMap<string, readonly DiscoveryCandidateDocument[]>,
  policy: DiscoveryCandidatePolicy,
  errors: ValidationIssue[],
): void {
  const sourceRef = conversion.document.source_candidate_ref;
  const source = typeof sourceRef === "string" ? documentsByPath.get(sourceRef) : undefined;
  const fanInRef = conversion.document.discovery_fan_in_ref;
  const fanIn = typeof fanInRef === "string" ? documentsByPath.get(fanInRef) : undefined;
  const revisions =
    source === undefined ? [] : (candidatesById.get(candidateIdentity(source)) ?? []);
  const currentRevision = Math.max(0, ...revisions.map((entry) => Number(entry.document.revision)));
  const kind = source?.document.candidate_kind as CandidateKind | undefined;
  const expectedPath = `artifacts/discovery/conversions/${String(
    source?.document.candidate_id,
  )}.r${String(conversion.document.revision)}.json`;
  const parentRef = conversion.document.parent_conversion_ref;
  const parent = typeof parentRef === "string" ? documentsByPath.get(parentRef) : undefined;
  if (conversion.path !== expectedPath) {
    errors.push(
      issue(
        "discovery_candidate.conversion_path_revision_mismatch",
        conversion.path,
        "conversion path must bind the source candidate identity and immutable conversion revision",
        { expectedPath },
      ),
    );
  }
  if (
    conversion.document.revision !== 1 &&
    (parent?.schemaVersion !== "startup_opportunity.discovery_candidate_conversion.v1" ||
      parent.document.revision !== Number(conversion.document.revision) - 1 ||
      parent.document.source_candidate_ref !== conversion.document.source_candidate_ref ||
      conversion.document.parent_content_hash !== targetHash(parent))
  ) {
    errors.push(
      issue(
        "discovery_candidate.conversion_parent_mismatch",
        `${conversion.path}#/parent_conversion_ref`,
        "conversion revision must bind the exact previous conversion for the same candidate",
      ),
    );
  }
  if (
    source?.schemaVersion !== "startup_opportunity.discovery_candidate.v1" ||
    fanIn?.schemaVersion !== "startup_opportunity.discovery_fan_in.v1" ||
    source.document.revision !== currentRevision ||
    conversion.document.source_candidate_schema_version !== source.schemaVersion ||
    conversion.document.source_candidate_kind !== kind ||
    conversion.document.source_candidate_revision !== source.document.revision ||
    conversion.document.source_candidate_content_hash !== targetHash(source) ||
    conversion.document.target_schema_version !==
      (kind === undefined ? undefined : policy.conversion_contract.kind_target_map[kind]) ||
    !strings(fanIn.document.retained_candidate_refs).includes(source.path)
  ) {
    errors.push(
      issue(
        "discovery_candidate.conversion_lineage_mismatch",
        conversion.path,
        "G2.3 conversion must bind the current retained candidate, exact hash/revision/kind, fan-in, and allowed formal target",
        { sourceRef, fanInRef },
      ),
    );
  }
}

export function isDiscoveryCandidateSchemaVersion(schemaVersion: string): boolean {
  return CONTRACT_SCHEMA_VERSIONS.has(schemaVersion);
}

export function validateDiscoveryCandidateContract(
  documents: readonly DiscoveryCandidateDocument[],
  policy: DiscoveryCandidatePolicy,
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
  const candidatesById = new Map<string, DiscoveryCandidateDocument[]>();
  for (const candidate of candidates) {
    const current = candidatesById.get(candidateIdentity(candidate)) ?? [];
    current.push(candidate);
    candidatesById.set(candidateIdentity(candidate), current);
  }
  const scopes = documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.scope_frame.v2",
  );
  const plans = documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.research_plan.v1",
  );
  if (scopes.length !== 1 || plans.length !== 1 || candidates.length === 0) {
    errors.push(
      issue(
        "discovery_candidate.bundle_cardinality",
        "/documents",
        "G2.2 contract requires one Scope, one current Plan, and at least one typed candidate",
        { scopeCount: scopes.length, planCount: plans.length, candidateCount: candidates.length },
      ),
    );
    return sortIssues(errors);
  }
  const scope = scopes[0] as DiscoveryCandidateDocument;
  const plan = plans[0] as DiscoveryCandidateDocument;
  for (const entry of documents) {
    validateEnvelope(entry, errors);
    validateDiscoveryLineage(entry, documentsByPath, scope, plan, errors);
  }
  for (const candidate of candidates) {
    validateScopeIdentity(candidate, scope, plan, errors);
    validateCandidateSubject(candidate, documentsByPath, errors);
    validateCandidateRevision(candidate, candidatesByPath, errors);
    validateCandidateEnrichmentBindings(candidate, documentsByPath, candidatesByPath, errors);
    validateMapLineage(candidate, documentsByPath, policy, errors);
    validateSourcePartition(candidate, documentsByPath, errors);
  }
  for (const task of documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.research_task.v2",
  )) {
    validateTask(task, documentsByPath, scope, plan, errors);
  }
  for (const lane of documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.discovery_lane_result.v1",
  )) {
    validateLaneResult(lane, documentsByPath, errors);
  }
  for (const fanIn of documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.discovery_fan_in.v1",
  )) {
    validateFanIn(fanIn, documentsByPath, candidatesByPath, errors);
  }
  for (const conversion of documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.discovery_candidate_conversion.v1",
  )) {
    validateConversion(conversion, documentsByPath, candidatesById, policy, errors);
  }
  return sortIssues(errors);
}

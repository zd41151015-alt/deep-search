import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import {
  deriveOpportunityFamilyProjection,
  opportunityFamilyEvidenceRefs,
} from "../opportunity-family-contract.js";
import type { DiscoverySynthesisPolicy } from "./discovery-synthesis-policy.js";
import { sortIssues, type ValidationIssue } from "./schema-bundle.js";

export interface DiscoverySynthesisDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

const SYNTHESIS_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.discovery_candidate_conversion.v2",
  "startup_opportunity.demand_thesis.v1",
  "startup_opportunity.baseline_option.v1",
  "startup_opportunity.solution_hypothesis.v1",
  "startup_opportunity.solution_evaluation.v1",
  "startup_opportunity.opportunity_thesis.v1",
  "startup_opportunity.thesis_evaluation_snapshot.v1",
  "startup_opportunity.merge.v1",
]);

const PRE_CANDIDATE_MATERIAL_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.evidence.discovery_candidate.current",
  "startup_opportunity.claim.discovery_candidate.current",
  "startup_opportunity.finding.discovery_candidate.current",
  "startup_opportunity.insight.discovery_candidate.current",
  "startup_opportunity.judgment_assessment.discovery_candidate.current",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function issue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "discovery_synthesis",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function targetHash(target: DiscoverySynthesisDocument): string {
  const envelopeHash = target.envelope?.content_hash;
  return typeof envelopeHash === "string" ? envelopeHash : canonicalContentHash(target.document);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function setEqual(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson(uniqueSorted(left)) === canonicalJson(uniqueSorted(right));
}

function mergeFamilyCompatibilityIssues(
  merge: DiscoverySynthesisDocument,
): readonly ValidationIssue[] {
  const familyByOpportunity = new Map<
    string,
    {
      readonly familyId: string;
      readonly familyRelation: string;
      readonly relationToFamily: string;
    }
  >();
  for (const family of records(merge.document.opportunity_families)) {
    for (const member of records(family.members)) {
      familyByOpportunity.set(String(member.opportunity_ref), {
        familyId: String(family.family_id),
        familyRelation: String(family.family_relation),
        relationToFamily: String(member.relation_to_family),
      });
    }
  }

  return records(merge.document.merge_or_split_decisions).flatMap((decision, decisionIndex) => {
    const memberRefs = strings(decision.member_thesis_refs);
    if (decision.decision !== "merge" || memberRefs.length < 2) return [];
    const memberships = memberRefs.flatMap((ref) => {
      const membership = familyByOpportunity.get(ref);
      return membership === undefined ? [] : [membership];
    });
    const familyIds = uniqueSorted(memberships.map((membership) => membership.familyId));
    const familyRelations = uniqueSorted(
      memberships.map((membership) => membership.familyRelation),
    );
    const memberRelations = uniqueSorted(
      memberships.map((membership) => membership.relationToFamily),
    );
    const oneSharedFamily =
      memberships.length === memberRefs.length &&
      familyIds.length === 1 &&
      familyRelations.length === 1 &&
      familyRelations[0] === "shared_opportunity_family";
    const onlyVariantMembers = memberRelations.every(
      (relation) =>
        relation === "segment_variant" || relation === "delivery_or_implementation_variant",
    );
    if (oneSharedFamily && onlyVariantMembers) return [];
    return [
      issue(
        "opportunity_family.merge_decision_conflict",
        `${merge.path}#/merge_or_split_decisions/${decisionIndex}`,
        "decision=merge with multiple members must stay within one shared opportunity family and cannot use independent or unknown member relations",
        {
          decisionId: decision.decision_id,
          memberRefs,
          familyIds,
          familyRelations,
          memberRelations,
        },
      ),
    ];
  });
}

function candidateId(document: Record<string, unknown>): string {
  return String(document.candidate_id);
}

function descendants(
  candidate: DiscoverySynthesisDocument,
  ancestor: DiscoverySynthesisDocument,
  candidatesByPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
): boolean {
  let current: DiscoverySynthesisDocument | undefined = candidate;
  const visited = new Set<string>();
  while (current !== undefined && !visited.has(current.path)) {
    if (current.path === ancestor.path) {
      return true;
    }
    visited.add(current.path);
    const parentRef: unknown = current.document.parent_candidate_ref;
    current = typeof parentRef === "string" ? candidatesByPath.get(parentRef) : undefined;
  }
  return false;
}

function sourceCandidateRefs(
  entry: DiscoverySynthesisDocument,
  byPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
): readonly string[] {
  const direct = entry.document.source_candidate_ref;
  if (typeof direct === "string") {
    return [direct];
  }
  if (entry.schemaVersion === "startup_opportunity.solution_evaluation.v1") {
    return strings(entry.document.solution_hypothesis_refs).flatMap((ref) => {
      const solution = byPath.get(ref);
      return typeof solution?.document.source_candidate_ref === "string"
        ? [solution.document.source_candidate_ref]
        : [];
    });
  }
  if (entry.schemaVersion === "startup_opportunity.opportunity_thesis.v1") {
    return [
      entry.document.demand_thesis_ref,
      entry.document.baseline_option_ref,
      entry.document.selected_solution_ref,
      ...strings(entry.document.alternative_solution_refs),
    ].flatMap((ref) => {
      const formal = typeof ref === "string" ? byPath.get(ref) : undefined;
      return typeof formal?.document.source_candidate_ref === "string"
        ? [formal.document.source_candidate_ref]
        : [];
    });
  }
  return [];
}

function sourcePreCandidateRefs(
  entry: DiscoverySynthesisDocument,
  byPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
): readonly string[] {
  const direct = entry.document.source_pre_candidate_ref;
  if (typeof direct === "string") return [direct];
  if (entry.schemaVersion === "startup_opportunity.solution_evaluation.v1") {
    return strings(entry.document.solution_hypothesis_refs).flatMap((ref) => {
      const solution = byPath.get(ref);
      return typeof solution?.document.source_pre_candidate_ref === "string"
        ? [solution.document.source_pre_candidate_ref]
        : [];
    });
  }
  if (entry.schemaVersion === "startup_opportunity.opportunity_thesis.v1") {
    return [
      entry.document.demand_thesis_ref,
      entry.document.baseline_option_ref,
      entry.document.selected_solution_ref,
      ...strings(entry.document.alternative_solution_refs),
    ].flatMap((ref) => {
      const formal = typeof ref === "string" ? byPath.get(ref) : undefined;
      return typeof formal?.document.source_pre_candidate_ref === "string"
        ? [formal.document.source_pre_candidate_ref]
        : [];
    });
  }
  return [];
}

function materialRefs(entry: DiscoverySynthesisDocument): readonly string[] {
  const document = entry.document;
  switch (entry.schemaVersion) {
    case "startup_opportunity.demand_thesis.v1":
      return [
        ...refsFromSourceGroups(document),
        ...strings(document.supporting_claim_refs),
        ...strings(document.opposing_claim_refs),
        ...strings(document.judgment_assessment_refs),
      ];
    case "startup_opportunity.baseline_option.v1":
      return strings(document.judgment_assessment_refs);
    case "startup_opportunity.solution_hypothesis.v1":
      return [
        ...strings(document.supporting_claim_refs),
        ...strings(document.opposing_claim_refs),
        ...strings(document.judgment_assessment_refs),
      ];
    case "startup_opportunity.solution_evaluation.v1":
      return [
        ...refsFromSourceGroups(document),
        ...strings(document.judgment_assessment_refs),
        ...records(document.rejected_solutions).flatMap((value) =>
          strings(value.judgment_assessment_refs),
        ),
      ];
    case "startup_opportunity.opportunity_thesis.v1":
      return [
        ...strings(document.source_lanes),
        ...strings(document.supporting_insight_refs),
        ...strings(document.opposing_claim_refs),
        ...strings(document.judgment_assessment_refs),
        ...strings(
          isRecord(document.mental_position_occupation)
            ? document.mental_position_occupation.evidence_refs
            : [],
        ),
      ];
    default:
      return [];
  }
}

function materialBindsCandidate(
  material: DiscoverySynthesisDocument,
  candidates: readonly DiscoverySynthesisDocument[],
  byPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
  candidatesByPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
): boolean {
  const lineage = isRecord(material.document.lineage) ? material.document.lineage : {};
  const taskRef =
    typeof lineage.task_ref === "string"
      ? lineage.task_ref
      : typeof material.document.task_ref === "string"
        ? material.document.task_ref
        : null;
  const task = taskRef === null ? undefined : byPath.get(taskRef);
  if (task?.schemaVersion !== "startup_opportunity.research_task.discovery_candidate.current") {
    return false;
  }
  const targets = strings(task.document.target_candidate_refs)
    .map((ref) => candidatesByPath.get(ref))
    .filter((candidate): candidate is DiscoverySynthesisDocument => candidate !== undefined);
  if (
    !candidates.some((candidate) =>
      targets.some((target) => descendants(candidate, target, candidatesByPath)),
    )
  ) {
    return false;
  }
  if (
    material.schemaVersion !== "startup_opportunity.judgment_assessment.discovery_candidate.current"
  ) {
    return true;
  }
  const subject =
    typeof material.document.subject_ref === "string"
      ? candidatesByPath.get(material.document.subject_ref)
      : undefined;
  return (
    subject !== undefined &&
    candidates.some((candidate) => descendants(candidate, subject, candidatesByPath))
  );
}

function expectedPath(entry: DiscoverySynthesisDocument): string | null {
  const revision = String(entry.document.revision);
  switch (entry.schemaVersion) {
    case "startup_opportunity.discovery_candidate_conversion.v2":
      return `artifacts/discovery/conversions/${String(entry.document.conversion_id).replace(/^conversion_/, "")}.r${revision}.json`;
    case "startup_opportunity.demand_thesis.v1":
      return `artifacts/discovery/demands/${String(entry.document.demand_id)}.r${revision}.json`;
    case "startup_opportunity.baseline_option.v1":
      return `artifacts/discovery/baselines/${String(entry.document.baseline_id)}.r${revision}.json`;
    case "startup_opportunity.solution_hypothesis.v1":
      return `artifacts/discovery/solutions/${String(entry.document.solution_id)}.r${revision}.json`;
    case "startup_opportunity.solution_evaluation.v1":
      return `artifacts/discovery/solution-evaluations/${String(entry.document.evaluation_id)}.r${revision}.json`;
    case "startup_opportunity.opportunity_thesis.v1":
      return `artifacts/discovery/opportunities/${String(entry.document.opportunity_id)}.r${revision}.json`;
    case "startup_opportunity.thesis_evaluation_snapshot.v1":
      return `artifacts/discovery/thesis-snapshots/${String(entry.document.snapshot_id)}.r${revision}.json`;
    case "startup_opportunity.merge.v1":
      return `artifacts/discovery/merges/${String(entry.document.merge_id)}.r${revision}.json`;
    default:
      return null;
  }
}

function refsFromSourceGroups(document: Record<string, unknown>): readonly string[] {
  const groups = isRecord(document.source_groups) ? document.source_groups : {};
  return [
    ...strings(groups.generation_source_manifest_refs),
    ...strings(groups.evaluation_source_manifest_refs),
  ];
}

function refsFromResearchHandoffs(document: Record<string, unknown>): readonly string[] {
  return records(document.research_handoff_input_hashes).flatMap((binding) =>
    typeof binding.ref === "string" ? [binding.ref] : [],
  );
}

function expectedInputRefs(entry: DiscoverySynthesisDocument): readonly string[] {
  const document = entry.document;
  const common = [
    ...strings(document.audit_refs),
    ...(typeof document.scope_frame_ref === "string" ? [document.scope_frame_ref] : []),
    ...(typeof document.research_plan_ref === "string" ? [document.research_plan_ref] : []),
    ...(typeof document.discovery_fan_in_ref === "string" ? [document.discovery_fan_in_ref] : []),
  ];
  switch (entry.schemaVersion) {
    case "startup_opportunity.discovery_candidate_conversion.v2":
      return uniqueSorted([
        ...common,
        ...strings([
          document.parent_conversion_ref,
          document.source_candidate_ref,
          document.source_pre_candidate_ref,
          document.target_artifact_ref,
        ]),
      ]);
    case "startup_opportunity.demand_thesis.v1":
      return uniqueSorted([
        ...common,
        ...strings([
          document.parent_demand_ref,
          document.source_conversion_ref,
          document.source_candidate_ref,
          document.source_pre_candidate_ref,
        ]),
        ...refsFromSourceGroups(document),
        ...strings(document.supporting_claim_refs),
        ...strings(document.opposing_claim_refs),
        ...strings(document.judgment_assessment_refs),
      ]);
    case "startup_opportunity.baseline_option.v1":
      return uniqueSorted([
        ...common,
        ...strings([
          document.parent_baseline_ref,
          document.source_conversion_ref,
          document.source_candidate_ref,
          document.source_pre_candidate_ref,
          document.demand_thesis_ref,
        ]),
        ...strings(document.judgment_assessment_refs),
      ]);
    case "startup_opportunity.solution_hypothesis.v1":
      return uniqueSorted([
        ...common,
        ...strings([
          document.parent_solution_ref,
          document.source_conversion_ref,
          document.source_candidate_ref,
          document.source_pre_candidate_ref,
          document.demand_thesis_ref,
          document.baseline_option_ref,
        ]),
        ...strings(document.capability_evidence_refs),
        ...strings(document.supporting_claim_refs),
        ...strings(document.opposing_claim_refs),
        ...strings(document.judgment_assessment_refs),
      ]);
    case "startup_opportunity.solution_evaluation.v1":
      return uniqueSorted([
        ...common,
        ...strings([
          document.parent_evaluation_ref,
          document.demand_thesis_ref,
          document.baseline_option_ref,
          document.selected_solution_ref,
        ]),
        ...strings(document.solution_hypothesis_refs),
        ...strings(document.alternative_solution_refs),
        ...records(document.rejected_solutions).flatMap((value) => [
          String(value.solution_ref),
          ...strings(value.judgment_assessment_refs),
        ]),
        ...refsFromSourceGroups(document),
        ...strings(document.judgment_assessment_refs),
      ]);
    case "startup_opportunity.opportunity_thesis.v1":
      return uniqueSorted([
        ...common,
        ...refsFromResearchHandoffs(document),
        ...strings([
          document.parent_opportunity_ref,
          document.source_pre_candidate_ref,
          document.demand_thesis_ref,
          document.selected_solution_ref,
          document.baseline_option_ref,
          document.solution_evaluation_ref,
        ]),
        ...strings(document.alternative_solution_refs),
        ...strings(document.source_lanes),
        ...strings(document.supporting_insight_refs),
        ...strings(document.opposing_claim_refs),
        ...strings(document.judgment_assessment_refs),
        ...strings(
          isRecord(document.mental_position_occupation)
            ? document.mental_position_occupation.evidence_refs
            : [],
        ),
      ]);
    case "startup_opportunity.thesis_evaluation_snapshot.v1":
      return uniqueSorted([
        ...common,
        ...strings([document.parent_snapshot_ref]),
        ...strings(document.subject_refs),
        ...strings(document.demand_thesis_refs),
        ...strings(document.solution_hypothesis_refs),
        ...strings(document.baseline_option_refs),
        ...strings(document.solution_evaluation_refs),
        ...strings(document.generation_source_groups),
        ...strings(document.evaluation_source_groups),
      ]);
    case "startup_opportunity.merge.v1":
      return uniqueSorted([
        ...common,
        ...strings([document.parent_merge_ref, document.source_snapshot_ref]),
        ...strings(document.source_thesis_refs),
        ...opportunityFamilyEvidenceRefs(document),
      ]);
    default:
      return uniqueSorted(common);
  }
}

function validateEnvelopeAndPath(
  entry: DiscoverySynthesisDocument,
  errors: ValidationIssue[],
): void {
  const expected = expectedPath(entry);
  if (expected !== null && entry.path !== expected) {
    errors.push(
      issue(
        "synthesis.path_revision_mismatch",
        entry.path,
        "G2.3 artifact path must bind its immutable identity and revision",
        { expected },
      ),
    );
  }
  if (
    entry.envelope?.schema_version !== "startup_opportunity.artifact_envelope.current" ||
    entry.envelope.producer_role !== "main_agent"
  ) {
    errors.push(
      issue(
        "synthesis.envelope_owner_mismatch",
        entry.path,
        "G2.3 synthesis artifacts require a v11 main_agent envelope",
      ),
    );
  }
  const actualInputs = strings(entry.envelope?.input_refs);
  const expectedInputs = expectedInputRefs(entry);
  if (!setEqual(actualInputs, expectedInputs)) {
    errors.push(
      issue(
        "synthesis.envelope_input_closure_mismatch",
        `${entry.path}#/input_refs`,
        "G2.3 envelope input_refs must be the exact direct typed-reference closure",
        { actualInputs: uniqueSorted(actualInputs), expectedInputs },
      ),
    );
  }
}

function validateRevision(
  entry: DiscoverySynthesisDocument,
  byPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
  parentField: string,
  idField: string,
  errors: ValidationIssue[],
): void {
  const revision = Number(entry.document.revision);
  const parentRef = entry.document[parentField];
  if (revision === 1) {
    return;
  }
  const parent = typeof parentRef === "string" ? byPath.get(parentRef) : undefined;
  if (
    parent?.schemaVersion !== entry.schemaVersion ||
    parent.document[idField] !== entry.document[idField] ||
    Number(parent.document.revision) !== revision - 1 ||
    entry.document.parent_content_hash !== targetHash(parent)
  ) {
    errors.push(
      issue(
        "synthesis.parent_revision_mismatch",
        `${entry.path}#/${parentField}`,
        "G2.3 revision must bind the exact previous immutable revision and canonical hash",
      ),
    );
  }
}

function validateIdentity(
  entry: DiscoverySynthesisDocument,
  scope: DiscoverySynthesisDocument,
  plan: DiscoverySynthesisDocument,
  fanIn: DiscoverySynthesisDocument,
  errors: ValidationIssue[],
): void {
  if (
    entry.document.run_id !== scope.document.run_id ||
    entry.document.scope_frame_ref !== scope.path ||
    entry.document.research_plan_ref !== plan.path ||
    (typeof entry.document.discovery_fan_in_ref === "string" &&
      entry.document.discovery_fan_in_ref !== fanIn.path)
  ) {
    errors.push(
      issue(
        "synthesis.scope_lineage_mismatch",
        entry.path,
        "G2.3 artifact must bind the exact same-Run Scope, current Plan, and discovery fan-in",
      ),
    );
  }
}

function validateSourceGroups(
  entry: DiscoverySynthesisDocument,
  byPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
  candidatesByPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
  errors: ValidationIssue[],
): void {
  const sourceGroups = isRecord(entry.document.source_groups) ? entry.document.source_groups : null;
  if (sourceGroups === null) {
    return;
  }
  const generation = strings(sourceGroups.generation_source_manifest_refs);
  const evaluation = strings(sourceGroups.evaluation_source_manifest_refs);
  const generationGroupIds: string[] = [];
  const evaluationGroupIds: string[] = [];
  let typedRolesValid = true;
  for (const [refs, expectedRole, groupIds] of [
    [generation, "candidate_generation", generationGroupIds],
    [evaluation, "candidate_evaluation", evaluationGroupIds],
  ] as const) {
    for (const ref of refs) {
      const manifest = byPath.get(ref);
      if (
        manifest?.schemaVersion !==
          "startup_opportunity.source_manifest.discovery_candidate.current" ||
        manifest.document.research_phase_role !== expectedRole
      ) {
        typedRolesValid = false;
        continue;
      }
      for (const group of records(manifest.document.canonical_source_groups)) {
        if (typeof group.group_id === "string") {
          groupIds.push(group.group_id);
        }
      }
    }
  }
  const overlap = uniqueSorted(
    generationGroupIds.filter((groupId) => evaluationGroupIds.includes(groupId)),
  );
  const disclosures = strings(sourceGroups.overlap_disclosures);
  const sourceCandidate =
    typeof entry.document.source_candidate_ref === "string"
      ? candidatesByPath.get(entry.document.source_candidate_ref)
      : undefined;
  const sourcePartition = isRecord(sourceCandidate?.document.source_partition)
    ? sourceCandidate.document.source_partition
    : null;
  const sourcePartitionMatches =
    sourcePartition === null ||
    (setEqual(generation, strings(sourcePartition.generation_source_manifest_refs)) &&
      setEqual(evaluation, strings(sourcePartition.evaluation_source_manifest_refs)));
  if (
    !typedRolesValid ||
    !sourcePartitionMatches ||
    (overlap.length > 0 && disclosures.length === 0) ||
    (overlap.length === 0 && disclosures.length > 0)
  ) {
    errors.push(
      issue(
        "synthesis.source_separation_mismatch",
        `${entry.path}#/source_groups`,
        "generation/evaluation Source Manifests must keep typed phase roles, exact candidate partition, and overlap disclosure",
        { overlap, typedRolesValid, sourcePartitionMatches },
      ),
    );
  }
}

function validateMaterialCandidateBindings(
  synthesis: readonly DiscoverySynthesisDocument[],
  byPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
  candidatesByPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
  preCandidatesByPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
  errors: ValidationIssue[],
): void {
  for (const entry of synthesis) {
    const candidates = sourceCandidateRefs(entry, byPath)
      .map((ref) => candidatesByPath.get(ref))
      .filter((candidate): candidate is DiscoverySynthesisDocument => candidate !== undefined);
    const refs = materialRefs(entry);
    const preCandidateRefs = sourcePreCandidateRefs(entry, byPath);
    const allowedMaterials = new Set(
      preCandidateRefs.flatMap((ref) =>
        records(preCandidatesByPath.get(ref)?.document.material_dispositions)
          .filter((disposition) => disposition.disposition !== "not_applicable")
          .map((disposition) => String(disposition.material_ref)),
      ),
    );
    const preCandidateCreatedAt = Math.max(
      ...preCandidateRefs.map((ref) => createdAt(preCandidatesByPath.get(ref))),
    );
    const allowsPostTerminalMaterial =
      entry.schemaVersion === "startup_opportunity.opportunity_thesis.v1" &&
      Number.isFinite(preCandidateCreatedAt);
    if (
      refs.length > 0 &&
      (candidates.length === 0 ||
        preCandidateRefs.length === 0 ||
        refs.some((ref) => {
          const material = byPath.get(ref);
          if (material === undefined) return true;
          const requiresPreCandidateDisposition = PRE_CANDIDATE_MATERIAL_SCHEMA_VERSIONS.has(
            material.schemaVersion,
          );
          return (
            (requiresPreCandidateDisposition &&
              !allowedMaterials.has(ref) &&
              !(allowsPostTerminalMaterial && createdAt(material) > preCandidateCreatedAt)) ||
            !materialBindsCandidate(material, candidates, byPath, candidatesByPath)
          );
        }))
    ) {
      errors.push(
        issue(
          "synthesis.material_candidate_binding_mismatch",
          entry.path,
          "each typed synthesis material must be explicitly applicable to the exact concrete pre-candidate and bind an ancestor mother seed through its owning discovery task",
          {
            candidateRefs: candidates.map((candidate) => candidate.path),
            preCandidateRefs,
            materialRefs: refs,
          },
        ),
      );
    }
  }
}

function createdAt(entry: DiscoverySynthesisDocument | undefined): number {
  return Date.parse(String(entry?.envelope?.created_at));
}

function validatePublicationOrder(
  byPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
  errors: ValidationIssue[],
): void {
  const notAfter = (
    prerequisite: DiscoverySynthesisDocument | undefined,
    dependent: DiscoverySynthesisDocument,
  ): boolean => {
    const prerequisiteTime = createdAt(prerequisite);
    const dependentTime = createdAt(dependent);
    return (
      prerequisite !== undefined &&
      Number.isFinite(prerequisiteTime) &&
      Number.isFinite(dependentTime) &&
      prerequisiteTime <= dependentTime
    );
  };
  for (const entry of byPath.values()) {
    let prerequisiteRefs: readonly string[] = [];
    switch (entry.schemaVersion) {
      case "startup_opportunity.baseline_option.v1":
        prerequisiteRefs = strings([entry.document.demand_thesis_ref]);
        break;
      case "startup_opportunity.solution_hypothesis.v1":
        prerequisiteRefs = strings([
          entry.document.demand_thesis_ref,
          entry.document.baseline_option_ref,
        ]);
        break;
      case "startup_opportunity.solution_evaluation.v1":
        prerequisiteRefs = [
          ...strings([entry.document.demand_thesis_ref, entry.document.baseline_option_ref]),
          ...strings(entry.document.solution_hypothesis_refs),
        ];
        break;
      case "startup_opportunity.opportunity_thesis.v1":
        prerequisiteRefs = strings([
          entry.document.demand_thesis_ref,
          entry.document.baseline_option_ref,
          entry.document.solution_evaluation_ref,
        ]);
        break;
      case "startup_opportunity.thesis_evaluation_snapshot.v1":
        prerequisiteRefs = strings(entry.document.subject_refs);
        break;
      case "startup_opportunity.merge.v1":
        prerequisiteRefs = strings([entry.document.source_snapshot_ref]);
        break;
      default:
        continue;
    }
    if (prerequisiteRefs.some((ref) => !notAfter(byPath.get(ref), entry))) {
      errors.push(
        issue(
          "synthesis.publication_order_mismatch",
          entry.path,
          "G2.3 created_at ordering must follow Demand, Baseline, Solution, evaluation, Opportunity, freeze, and merge dependencies",
          { prerequisiteRefs },
        ),
      );
    }
  }
}

function validateConversions(
  documents: readonly DiscoverySynthesisDocument[],
  byPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
  candidates: readonly DiscoverySynthesisDocument[],
  preCandidates: readonly DiscoverySynthesisDocument[],
  fanIn: DiscoverySynthesisDocument,
  policy: DiscoverySynthesisPolicy,
  errors: ValidationIssue[],
): void {
  const candidatesByPath = new Map(candidates.map((entry) => [entry.path, entry]));
  const preCandidatesByPath = new Map(preCandidates.map((entry) => [entry.path, entry]));
  const latestRevisionById = new Map<string, number>();
  for (const candidate of candidates) {
    latestRevisionById.set(
      candidateId(candidate.document),
      Math.max(
        latestRevisionById.get(candidateId(candidate.document)) ?? 0,
        Number(candidate.document.revision),
      ),
    );
  }
  const conversions = documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.discovery_candidate_conversion.v2",
  );
  const sourcePreCandidateTargets = conversions.map(
    (entry) =>
      `${String(entry.document.source_pre_candidate_ref)}\u0000${String(
        entry.document.target_schema_version,
      )}`,
  );
  const targetRefs = conversions.map((entry) => String(entry.document.target_artifact_ref));
  const formalTargets = documents.filter((entry) =>
    [
      "startup_opportunity.demand_thesis.v1",
      "startup_opportunity.baseline_option.v1",
      "startup_opportunity.solution_hypothesis.v1",
    ].includes(entry.schemaVersion),
  );
  if (
    new Set(sourcePreCandidateTargets).size !== sourcePreCandidateTargets.length ||
    new Set(targetRefs).size !== targetRefs.length ||
    conversions.length !== formalTargets.length ||
    formalTargets.some((target) => !targetRefs.includes(target.path))
  ) {
    errors.push(
      issue(
        "synthesis.conversion_bijection_mismatch",
        "/documents",
        "each retained concrete pre-candidate conversion and each formal Demand/Baseline/Solution target must participate in one exact one-to-one binding",
        { sourcePreCandidateTargets, targetRefs },
      ),
    );
  }
  for (const conversion of conversions) {
    const source =
      typeof conversion.document.source_candidate_ref === "string"
        ? candidatesByPath.get(conversion.document.source_candidate_ref)
        : undefined;
    const sourcePreCandidate =
      typeof conversion.document.source_pre_candidate_ref === "string"
        ? preCandidatesByPath.get(conversion.document.source_pre_candidate_ref)
        : undefined;
    const target =
      typeof conversion.document.target_artifact_ref === "string"
        ? byPath.get(conversion.document.target_artifact_ref)
        : undefined;
    const kind = String(source?.document.candidate_kind);
    const preCandidateSeedBindings = records(sourcePreCandidate?.document.seed_bindings);
    const exactSeedBinding = preCandidateSeedBindings.find(
      (binding) => binding.ref === source?.path,
    );
    if (
      source === undefined ||
      source.document.revision !== latestRevisionById.get(candidateId(source.document)) ||
      sourcePreCandidate?.schemaVersion !== "startup_opportunity.concrete_pre_candidate.v1" ||
      sourcePreCandidate.document.run_id !== source.document.run_id ||
      !strings(fanIn.document.retained_pre_candidate_refs).includes(sourcePreCandidate.path) ||
      exactSeedBinding?.candidate_kind !== source.document.candidate_kind ||
      exactSeedBinding?.content_hash !== targetHash(source) ||
      conversion.document.source_candidate_kind !== source.document.candidate_kind ||
      conversion.document.source_candidate_revision !== source.document.revision ||
      conversion.document.source_candidate_content_hash !== targetHash(source) ||
      conversion.document.source_pre_candidate_revision !== sourcePreCandidate?.document.revision ||
      conversion.document.source_pre_candidate_content_hash !==
        (sourcePreCandidate === undefined ? undefined : targetHash(sourcePreCandidate)) ||
      conversion.document.target_schema_version !== policy.kind_target_map[kind]
    ) {
      errors.push(
        issue(
          "synthesis.conversion_lineage_mismatch",
          conversion.path,
          "conversion must bind a current typed mother seed inside one retained concrete pre-candidate, exact kind/revision/hash, and allowed target type",
        ),
      );
      continue;
    }
    if (
      target?.schemaVersion !== conversion.document.target_schema_version ||
      conversion.document.target_content_hash !==
        (target === undefined ? undefined : targetHash(target)) ||
      target?.document.source_conversion_ref !== conversion.path ||
      target?.document.source_candidate_ref !== source.path ||
      target?.document.source_pre_candidate_ref !== sourcePreCandidate?.path
    ) {
      errors.push(
        issue(
          "synthesis.target_binding_mismatch",
          `${conversion.path}#/target_artifact_ref`,
          "conversion and formal target must bind each other and the exact target canonical hash",
        ),
      );
    }
  }
}

function validateFormalLineage(
  byPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
  candidatesByPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
  enforceCandidateSemanticPreservation: boolean,
  errors: ValidationIssue[],
): void {
  const demands = [...byPath.values()].filter(
    (entry) => entry.schemaVersion === "startup_opportunity.demand_thesis.v1",
  );
  const baselines = [...byPath.values()].filter(
    (entry) => entry.schemaVersion === "startup_opportunity.baseline_option.v1",
  );
  const solutions = [...byPath.values()].filter(
    (entry) => entry.schemaVersion === "startup_opportunity.solution_hypothesis.v1",
  );
  for (const baseline of baselines) {
    const demand =
      typeof baseline.document.demand_thesis_ref === "string"
        ? byPath.get(baseline.document.demand_thesis_ref)
        : undefined;
    const source =
      typeof baseline.document.source_candidate_ref === "string"
        ? candidatesByPath.get(baseline.document.source_candidate_ref)
        : undefined;
    const demandSource =
      typeof demand?.document.source_candidate_ref === "string"
        ? candidatesByPath.get(demand.document.source_candidate_ref)
        : undefined;
    const subject = isRecord(source?.document.subject) ? source.document.subject : {};
    const boundDemand =
      typeof subject.demand_candidate_ref === "string"
        ? candidatesByPath.get(subject.demand_candidate_ref)
        : undefined;
    if (
      demand?.schemaVersion !== "startup_opportunity.demand_thesis.v1" ||
      source?.document.candidate_kind !== "baseline_seed" ||
      baseline.document.source_pre_candidate_ref !== demand.document.source_pre_candidate_ref ||
      demandSource === undefined ||
      boundDemand === undefined ||
      !descendants(demandSource, boundDemand, candidatesByPath)
    ) {
      errors.push(
        issue(
          "synthesis.subject_lineage_mismatch",
          baseline.path,
          "Baseline must bind a formal Demand descended from its typed demand candidate subject",
        ),
      );
    }
  }
  for (const solution of solutions) {
    const demand =
      typeof solution.document.demand_thesis_ref === "string"
        ? byPath.get(solution.document.demand_thesis_ref)
        : undefined;
    const baseline =
      typeof solution.document.baseline_option_ref === "string"
        ? byPath.get(solution.document.baseline_option_ref)
        : undefined;
    const source =
      typeof solution.document.source_candidate_ref === "string"
        ? candidatesByPath.get(solution.document.source_candidate_ref)
        : undefined;
    const demandSource =
      typeof demand?.document.source_candidate_ref === "string"
        ? candidatesByPath.get(demand.document.source_candidate_ref)
        : undefined;
    const baselineSource =
      typeof baseline?.document.source_candidate_ref === "string"
        ? candidatesByPath.get(baseline.document.source_candidate_ref)
        : undefined;
    const subject = isRecord(source?.document.subject) ? source.document.subject : {};
    const boundDemand =
      typeof subject.demand_candidate_ref === "string"
        ? candidatesByPath.get(subject.demand_candidate_ref)
        : undefined;
    const boundBaseline =
      typeof subject.baseline_candidate_ref === "string"
        ? candidatesByPath.get(subject.baseline_candidate_ref)
        : undefined;
    if (
      demand?.schemaVersion !== "startup_opportunity.demand_thesis.v1" ||
      baseline?.schemaVersion !== "startup_opportunity.baseline_option.v1" ||
      baseline.document.demand_thesis_ref !== demand.path ||
      source?.document.candidate_kind !== "solution_seed" ||
      solution.document.source_pre_candidate_ref !== demand.document.source_pre_candidate_ref ||
      solution.document.source_pre_candidate_ref !== baseline.document.source_pre_candidate_ref ||
      demandSource === undefined ||
      baselineSource === undefined ||
      boundDemand === undefined ||
      boundBaseline === undefined ||
      !descendants(demandSource, boundDemand, candidatesByPath) ||
      !descendants(baselineSource, boundBaseline, candidatesByPath)
    ) {
      errors.push(
        issue(
          "synthesis.subject_lineage_mismatch",
          solution.path,
          "Solution must bind formal Demand/Baseline descended from its typed candidate subjects",
        ),
      );
    }
    if (
      enforceCandidateSemanticPreservation &&
      source?.document.candidate_kind === "solution_seed" &&
      (solution.document.uses_ai !== subject.uses_ai ||
        solution.document.solution_type !== subject.solution_class ||
        !Array.isArray(subject.delivery_forms) ||
        !subject.delivery_forms.includes(solution.document.delivery_form))
    ) {
      errors.push(
        issue(
          "synthesis.solution_candidate_semantic_drift",
          solution.path,
          "formal Solution must preserve uses_ai, solution class, and delivery form from its exact typed candidate revision",
        ),
      );
    }
  }
  if (demands.some((entry) => entry.document.solution_neutral !== true)) {
    errors.push(
      issue(
        "synthesis.demand_not_solution_neutral",
        "/documents",
        "Demand Thesis must remain solution-neutral",
      ),
    );
  }
}

function validateSolutionEvaluations(
  byPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
  errors: ValidationIssue[],
): void {
  for (const evaluation of [...byPath.values()].filter(
    (entry) => entry.schemaVersion === "startup_opportunity.solution_evaluation.v1",
  )) {
    const solutionRefs = strings(evaluation.document.solution_hypothesis_refs);
    const selected = String(evaluation.document.selected_solution_ref);
    const alternatives = strings(evaluation.document.alternative_solution_refs);
    const rejected = records(evaluation.document.rejected_solutions).map((entry) =>
      String(entry.solution_ref),
    );
    const classified = [selected, ...alternatives, ...rejected];
    const solutions = solutionRefs.map((ref) => byPath.get(ref));
    const comparisons = records(evaluation.document.baseline_comparisons);
    if (
      !setEqual(solutionRefs, classified) ||
      new Set(classified).size !== classified.length ||
      solutions.some(
        (solution) =>
          solution?.schemaVersion !== "startup_opportunity.solution_hypothesis.v1" ||
          solution.document.demand_thesis_ref !== evaluation.document.demand_thesis_ref ||
          solution.document.baseline_option_ref !== evaluation.document.baseline_option_ref,
      ) ||
      !setEqual(
        comparisons.map((entry) => String(entry.solution_ref)),
        solutionRefs,
      ) ||
      comparisons.find((entry) => entry.solution_ref === selected)?.decision !== "selected"
    ) {
      errors.push(
        issue(
          "synthesis.solution_evaluation_mismatch",
          evaluation.path,
          "Solution Evaluation must classify each same-Demand/Baseline solution exactly once and compare each with baseline",
        ),
      );
    }
  }
}

function validateThesesSnapshotsAndMerge(
  byPath: ReadonlyMap<string, DiscoverySynthesisDocument>,
  errors: ValidationIssue[],
): void {
  const opportunities = [...byPath.values()].filter(
    (entry) => entry.schemaVersion === "startup_opportunity.opportunity_thesis.v1",
  );
  for (const opportunity of opportunities) {
    const evaluation =
      typeof opportunity.document.solution_evaluation_ref === "string"
        ? byPath.get(opportunity.document.solution_evaluation_ref)
        : undefined;
    const selected =
      typeof opportunity.document.selected_solution_ref === "string"
        ? byPath.get(opportunity.document.selected_solution_ref)
        : undefined;
    const demand =
      typeof opportunity.document.demand_thesis_ref === "string"
        ? byPath.get(opportunity.document.demand_thesis_ref)
        : undefined;
    const baseline =
      typeof opportunity.document.baseline_option_ref === "string"
        ? byPath.get(opportunity.document.baseline_option_ref)
        : undefined;
    const sourcePreCandidateRef = opportunity.document.source_pre_candidate_ref;
    if (
      evaluation?.schemaVersion !== "startup_opportunity.solution_evaluation.v1" ||
      selected?.schemaVersion !== "startup_opportunity.solution_hypothesis.v1" ||
      demand?.document.source_pre_candidate_ref !== sourcePreCandidateRef ||
      baseline?.document.source_pre_candidate_ref !== sourcePreCandidateRef ||
      selected.document.source_pre_candidate_ref !== sourcePreCandidateRef ||
      evaluation.document.demand_thesis_ref !== opportunity.document.demand_thesis_ref ||
      evaluation.document.baseline_option_ref !== opportunity.document.baseline_option_ref ||
      evaluation.document.selected_solution_ref !== opportunity.document.selected_solution_ref ||
      !setEqual(
        strings(evaluation.document.alternative_solution_refs),
        strings(opportunity.document.alternative_solution_refs),
      ) ||
      selected.document.delivery_form !== opportunity.document.selected_delivery_form
    ) {
      errors.push(
        issue(
          "synthesis.thesis_lineage_mismatch",
          opportunity.path,
          "Opportunity Thesis must exactly reflect its Demand/Baseline/Solution Evaluation selection",
        ),
      );
    }
  }
  for (const snapshot of [...byPath.values()].filter(
    (entry) => entry.schemaVersion === "startup_opportunity.thesis_evaluation_snapshot.v1",
  )) {
    const subjectRefs = strings(snapshot.document.subject_refs);
    const subjects = strings(snapshot.document.subject_refs).map((ref) => byPath.get(ref));
    const expectedDemands = subjects.map((entry) => String(entry?.document.demand_thesis_ref));
    const expectedBaselines = subjects.map((entry) => String(entry?.document.baseline_option_ref));
    const expectedEvaluations = subjects.map((entry) =>
      String(entry?.document.solution_evaluation_ref),
    );
    const expectedSolutions = subjects.flatMap((entry) => [
      String(entry?.document.selected_solution_ref),
      ...strings(entry?.document.alternative_solution_refs),
    ]);
    const sourceDocuments = subjects.flatMap((entry) =>
      [entry?.document.demand_thesis_ref, entry?.document.solution_evaluation_ref].flatMap((ref) =>
        typeof ref === "string" ? [byPath.get(ref)] : [],
      ),
    );
    const expectedGenerationGroups = sourceDocuments.flatMap((entry) =>
      isRecord(entry?.document.source_groups)
        ? strings(entry.document.source_groups.generation_source_manifest_refs)
        : [],
    );
    const expectedEvaluationGroups = sourceDocuments.flatMap((entry) =>
      isRecord(entry?.document.source_groups)
        ? strings(entry.document.source_groups.evaluation_source_manifest_refs)
        : [],
    );
    const frozenAt = Date.parse(String(snapshot.document.frozen_at));
    const createdTimes = subjects.map((entry) => Date.parse(String(entry?.envelope?.created_at)));
    const latestFrozenOpportunities = new Map<string, DiscoverySynthesisDocument>();
    for (const opportunity of opportunities) {
      const opportunityCreatedAt = createdAt(opportunity);
      if (!Number.isFinite(frozenAt) || !Number.isFinite(opportunityCreatedAt)) continue;
      if (opportunityCreatedAt > frozenAt) continue;
      const opportunityId = String(opportunity.document.opportunity_id);
      const current = latestFrozenOpportunities.get(opportunityId);
      if (
        current === undefined ||
        Number(opportunity.document.revision) > Number(current.document.revision)
      ) {
        latestFrozenOpportunities.set(opportunityId, opportunity);
      }
    }
    if (
      subjects.some(
        (entry) => entry?.schemaVersion !== "startup_opportunity.opportunity_thesis.v1",
      ) ||
      !setEqual(
        subjectRefs,
        [...latestFrozenOpportunities.values()].map((entry) => entry.path),
      ) ||
      !setEqual(strings(snapshot.document.demand_thesis_refs), expectedDemands) ||
      !setEqual(strings(snapshot.document.baseline_option_refs), expectedBaselines) ||
      !setEqual(strings(snapshot.document.solution_evaluation_refs), expectedEvaluations) ||
      !setEqual(strings(snapshot.document.solution_hypothesis_refs), expectedSolutions) ||
      !setEqual(strings(snapshot.document.generation_source_groups), expectedGenerationGroups) ||
      !setEqual(strings(snapshot.document.evaluation_source_groups), expectedEvaluationGroups) ||
      !Number.isFinite(frozenAt) ||
      createdTimes.some((time) => !Number.isFinite(time) || time > frozenAt)
    ) {
      errors.push(
        issue(
          "synthesis.snapshot_freeze_mismatch",
          snapshot.path,
          "snapshot must freeze the exact closed thesis dependency set after synthesis and before enrichment",
        ),
      );
    }
  }
  for (const merge of [...byPath.values()].filter(
    (entry) => entry.schemaVersion === "startup_opportunity.merge.v1",
  )) {
    const snapshot =
      typeof merge.document.source_snapshot_ref === "string"
        ? byPath.get(merge.document.source_snapshot_ref)
        : undefined;
    const sourceRefs = strings(merge.document.source_thesis_refs);
    const clusters = records(merge.document.merged_opportunities);
    const decisions = records(merge.document.merge_or_split_decisions);
    const memberRefs = clusters.flatMap((entry) => strings(entry.member_thesis_refs));
    const decisionRefs = decisions.flatMap((entry) => strings(entry.member_thesis_refs));
    const clusterIds = clusters.map((entry) => String(entry.cluster_id));
    if (
      snapshot?.schemaVersion !== "startup_opportunity.thesis_evaluation_snapshot.v1" ||
      !setEqual(sourceRefs, strings(snapshot.document.subject_refs)) ||
      !setEqual(memberRefs, sourceRefs) ||
      memberRefs.length !== new Set(memberRefs).size ||
      !setEqual(decisionRefs, sourceRefs) ||
      decisionRefs.length !== new Set(decisionRefs).size ||
      decisions.some(
        (entry) =>
          !clusterIds.includes(String(entry.cluster_id)) || entry.title_similarity_only !== false,
      ) ||
      clusters.some(
        (entry) =>
          !strings(entry.member_thesis_refs).includes(String(entry.canonical_opportunity_ref)),
      ) ||
      strings(merge.document.preserved_variants).some((ref) => !sourceRefs.includes(ref))
    ) {
      errors.push(
        issue(
          "synthesis.merge_closure_mismatch",
          merge.path,
          "merge must classify every frozen thesis exactly once using a non-title-only semantic decision",
        ),
      );
    }
    try {
      deriveOpportunityFamilyProjection(
        merge.path,
        new Map(
          [...byPath].map(([path, entry]) => [
            path,
            {
              path,
              schemaVersion: entry.schemaVersion,
              document: entry.document,
              contentHash: targetHash(entry),
            },
          ]),
        ),
      );
    } catch (error) {
      errors.push(
        issue(
          error instanceof StoreError ? error.code : "opportunity_family.projection_invalid",
          `${merge.path}#/opportunity_families`,
          error instanceof Error
            ? error.message
            : "opportunity-family projection could not be derived",
          error instanceof StoreError ? error.details : {},
        ),
      );
    }
    errors.push(...mergeFamilyCompatibilityIssues(merge));
  }
}

export function isDiscoverySynthesisSchemaVersion(schemaVersion: string): boolean {
  return SYNTHESIS_SCHEMA_VERSIONS.has(schemaVersion);
}

export function validateDiscoverySynthesisContract(
  documents: readonly DiscoverySynthesisDocument[],
  policy: DiscoverySynthesisPolicy,
  enforceCandidateSemanticPreservation = true,
): readonly ValidationIssue[] {
  if (!documents.some((entry) => SYNTHESIS_SCHEMA_VERSIONS.has(entry.schemaVersion))) {
    return [];
  }
  const errors: ValidationIssue[] = [];
  const byPath = new Map(documents.map((entry) => [entry.path, entry]));
  const scope = documents.find(
    (entry) => entry.schemaVersion === "startup_opportunity.scope_frame.discovery.current",
  );
  const plan = documents.find(
    (entry) => entry.schemaVersion === "startup_opportunity.research_plan.v1",
  );
  const fanIn = documents.find(
    (entry) => entry.schemaVersion === "startup_opportunity.discovery_fan_in.v2",
  );
  const candidates = documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.discovery_candidate.v1",
  );
  const preCandidates = documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.concrete_pre_candidate.v1",
  );
  const synthesis = documents.filter((entry) => SYNTHESIS_SCHEMA_VERSIONS.has(entry.schemaVersion));
  if (
    scope === undefined ||
    plan === undefined ||
    fanIn === undefined ||
    candidates.length === 0 ||
    preCandidates.length === 0
  ) {
    return [
      issue(
        "synthesis.bundle_cardinality",
        "/documents",
        "G2.3 requires exact Scope, current Plan, v2 fan-in, typed candidate lineage, and concrete pre-candidate lineage",
      ),
    ];
  }
  const candidatesByPath = new Map(candidates.map((entry) => [entry.path, entry]));
  const preCandidatesByPath = new Map(preCandidates.map((entry) => [entry.path, entry]));
  for (const entry of synthesis) {
    validateEnvelopeAndPath(entry, errors);
    validateIdentity(entry, scope, plan, fanIn, errors);
    validateSourceGroups(entry, byPath, candidatesByPath, errors);
  }
  const revisionFields: Readonly<Record<string, readonly [string, string]>> = {
    "startup_opportunity.discovery_candidate_conversion.v2": [
      "parent_conversion_ref",
      "conversion_id",
    ],
    "startup_opportunity.demand_thesis.v1": ["parent_demand_ref", "demand_id"],
    "startup_opportunity.baseline_option.v1": ["parent_baseline_ref", "baseline_id"],
    "startup_opportunity.solution_hypothesis.v1": ["parent_solution_ref", "solution_id"],
    "startup_opportunity.solution_evaluation.v1": ["parent_evaluation_ref", "evaluation_id"],
    "startup_opportunity.opportunity_thesis.v1": ["parent_opportunity_ref", "opportunity_id"],
    "startup_opportunity.thesis_evaluation_snapshot.v1": ["parent_snapshot_ref", "snapshot_id"],
    "startup_opportunity.merge.v1": ["parent_merge_ref", "merge_id"],
  };
  for (const entry of synthesis) {
    const fields = revisionFields[entry.schemaVersion];
    if (fields !== undefined) {
      validateRevision(entry, byPath, fields[0], fields[1], errors);
    }
  }
  validateConversions(documents, byPath, candidates, preCandidates, fanIn, policy, errors);
  validateFormalLineage(byPath, candidatesByPath, enforceCandidateSemanticPreservation, errors);
  validateMaterialCandidateBindings(
    synthesis,
    byPath,
    candidatesByPath,
    preCandidatesByPath,
    errors,
  );
  validateSolutionEvaluations(byPath, errors);
  validateThesesSnapshotsAndMerge(byPath, errors);
  validatePublicationOrder(byPath, errors);
  return sortIssues(errors);
}

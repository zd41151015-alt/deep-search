import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import { deriveLaneScopeFormalClosure } from "../runtime/lane-delivery-closure.js";
import { assessmentCoverageSemanticsError } from "./assessment-coverage-semantics.js";
import { sortIssues, type ValidationIssue } from "./schema-bundle.js";

export interface ResearchBranchDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

const RESEARCH_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.research_task.assessment.current",
  "startup_opportunity.evidence.assessment.current",
  "startup_opportunity.claim.assessment.current",
  "startup_opportunity.finding.assessment.current",
  "startup_opportunity.insight.assessment.current",
  "startup_opportunity.source_manifest.assessment.current",
]);

export function isResearchBranchSchemaVersion(schemaVersion: string): boolean {
  return RESEARCH_SCHEMA_VERSIONS.has(schemaVersion);
}

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
    keyword: "research_contract",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function targetByRef(
  documentsByPath: ReadonlyMap<string, ResearchBranchDocument>,
  ref: unknown,
): ResearchBranchDocument | null {
  if (typeof ref !== "string") {
    return null;
  }
  return documentsByPath.get(ref.split("#", 1)[0] ?? "") ?? null;
}

function idOf(entry: ResearchBranchDocument): string | null {
  const field =
    entry.schemaVersion === "startup_opportunity.evidence.assessment.current"
      ? "evidence_id"
      : entry.schemaVersion === "startup_opportunity.claim.assessment.current"
        ? "claim_id"
        : entry.schemaVersion === "startup_opportunity.finding.assessment.current"
          ? "finding_id"
          : entry.schemaVersion === "startup_opportunity.insight.assessment.current"
            ? "insight_id"
            : entry.schemaVersion === "startup_opportunity.research_task.assessment.current"
              ? "task_id"
              : entry.schemaVersion === "startup_opportunity.source_manifest.assessment.current"
                ? "manifest_id"
                : null;
  const value = field === null ? null : entry.document[field];
  return typeof value === "string" ? value : null;
}

function taskLineage(task: ResearchBranchDocument): Record<string, unknown> {
  return {
    task_ref: task.path,
    attempt: task.document.attempt,
    concept_hypothesis_ref: task.document.target_subject_ref,
    scope_frame_ref: task.document.scope_frame_ref,
    research_plan_ref: task.document.research_plan_ref,
    assessment_plan_ref: task.document.assessment_plan_ref,
  };
}

function sameLineage(
  entry: ResearchBranchDocument,
  task: ResearchBranchDocument,
  errors: ValidationIssue[],
): boolean {
  const actual = entry.document.lineage;
  const expected = taskLineage(task);
  const matches =
    entry.document.run_id === task.document.run_id &&
    entry.document.unit_id === task.document.unit_id &&
    isRecord(actual) &&
    canonicalJson(actual) === canonicalJson(expected);
  if (!matches) {
    errors.push(
      issue(
        "research_contract.lineage_mismatch",
        `${entry.path}#/lineage`,
        "research artifact lineage differs from its typed task",
        { taskRef: task.path },
      ),
    );
  }
  return matches;
}

function researchUnit(
  plan: ResearchBranchDocument | null,
  unitId: unknown,
): { readonly waveId: string; readonly unit: Record<string, unknown> } | null {
  if (
    plan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
    !Array.isArray(plan.document.waves)
  ) {
    return null;
  }
  for (const wave of plan.document.waves) {
    if (!isRecord(wave) || typeof wave.wave_id !== "string" || !Array.isArray(wave.units)) {
      continue;
    }
    const unit = wave.units.find(
      (candidate) => isRecord(candidate) && candidate.unit_id === unitId,
    );
    if (isRecord(unit)) {
      return { waveId: wave.wave_id, unit };
    }
  }
  return null;
}

function checkTask(
  task: ResearchBranchDocument,
  documentsByPath: ReadonlyMap<string, ResearchBranchDocument>,
  errors: ValidationIssue[],
): void {
  const expectedPath = `tasks/${String(task.document.unit_id)}.attempt-${String(task.document.attempt)}.json`;
  if (task.path !== expectedPath) {
    errors.push(
      issue(
        "research_contract.task_path_mismatch",
        task.path,
        "research task path must encode unit and attempt identity",
        { expectedPath },
      ),
    );
  }
  const plan = targetByRef(documentsByPath, task.document.research_plan_ref);
  const unitBinding = researchUnit(plan, task.document.unit_id);
  const assessmentPlan = targetByRef(documentsByPath, task.document.assessment_plan_ref);
  const concept = targetByRef(documentsByPath, task.document.target_subject_ref);
  const scope = targetByRef(documentsByPath, task.document.scope_frame_ref);
  if (unitBinding === null) {
    errors.push(
      issue(
        "research_contract.task_unit_missing",
        `${task.path}#/unit_id`,
        "research task does not identify a unit in its Research Plan",
      ),
    );
  } else {
    const unit = unitBinding.unit;
    const exactFields: readonly [string, string][] = [
      ["wave_id", "waveId"],
      ["unit_type", "unit_type"],
      ["research_goal", "research_goal"],
      ["attempt", "attempt"],
      ["agent_role", "agent_role"],
      ["allowed_output_path", "output_path"],
      ["required_artifact_schema", "required_artifact_schema"],
    ];
    for (const [taskField, unitField] of exactFields) {
      const unitValue = unitField === "waveId" ? unitBinding.waveId : unit[unitField];
      if (task.document[taskField] !== unitValue) {
        errors.push(
          issue(
            "research_contract.task_unit_mismatch",
            `${task.path}#/${taskField}`,
            "research task differs from its immutable Research Plan unit",
            { taskField, unitField },
          ),
        );
      }
    }
    if (
      canonicalJson([...strings(task.document.input_refs)].sort()) !==
      canonicalJson([...strings(unit.input_refs)].sort())
    ) {
      errors.push(
        issue(
          "research_contract.task_unit_mismatch",
          `${task.path}#/input_refs`,
          "research task input refs differ from its Research Plan unit",
        ),
      );
    }
    if (unit.plan_disposition !== "enabled") {
      errors.push(
        issue(
          "research_contract.task_not_dispatchable",
          `${task.path}#/unit_id`,
          "only an enabled Research Plan unit can receive a research task",
          { planDisposition: unit.plan_disposition },
        ),
      );
    }
  }
  if (
    assessmentPlan?.schemaVersion !== "startup_opportunity.concept_evidence_assessment_plan.v1" ||
    assessmentPlan.document.research_plan_ref !== task.document.research_plan_ref ||
    assessmentPlan.document.concept_hypothesis_ref !== task.document.target_subject_ref ||
    assessmentPlan.document.run_id !== task.document.run_id
  ) {
    errors.push(
      issue(
        "research_contract.task_assessment_plan_mismatch",
        `${task.path}#/assessment_plan_ref`,
        "research task does not bind the matching assessment plan",
      ),
    );
  }
  if (
    concept?.schemaVersion !== "startup_opportunity.concept_hypothesis.assessment.current" ||
    concept.document.scope_frame_ref !== task.document.scope_frame_ref ||
    concept.document.run_id !== task.document.run_id ||
    scope?.schemaVersion !== "startup_opportunity.scope_frame.assessment.current" ||
    scope.document.run_id !== task.document.run_id
  ) {
    errors.push(
      issue(
        "research_contract.task_subject_scope_mismatch",
        `${task.path}#/target_subject_ref`,
        "research task subject and scope lineage is not exact",
      ),
    );
  }
  const supersedes = targetByRef(documentsByPath, task.document.supersedes_task_ref);
  if (
    typeof task.document.attempt === "number" &&
    task.document.attempt > 1 &&
    (supersedes?.schemaVersion !== "startup_opportunity.research_task.assessment.current" ||
      supersedes.document.run_id !== task.document.run_id ||
      supersedes.document.unit_id !== task.document.unit_id ||
      supersedes.document.attempt !== task.document.attempt - 1)
  ) {
    errors.push(
      issue(
        "research_contract.task_supersede_mismatch",
        `${task.path}#/supersedes_task_ref`,
        "retry task must supersede the preceding attempt in the same Run",
      ),
    );
  }
  if (task.envelope !== null && task.envelope.producer_role !== "main_agent") {
    errors.push(
      issue(
        "research_contract.task_owner_mismatch",
        `${task.path}#/producer_role`,
        "only main_agent can publish a research task envelope",
      ),
    );
  }
}

function taskFor(
  entry: ResearchBranchDocument,
  documentsByPath: ReadonlyMap<string, ResearchBranchDocument>,
): ResearchBranchDocument | null {
  const lineage = entry.document.lineage;
  return isRecord(lineage) ? targetByRef(documentsByPath, lineage.task_ref) : null;
}

function directParentRefs(entry: ResearchBranchDocument): readonly string[] {
  const lineage = entry.document.lineage;
  const taskRef = isRecord(lineage) ? strings([lineage.task_ref]) : [];
  switch (entry.schemaVersion) {
    case "startup_opportunity.research_task.assessment.current":
      return [
        ...strings([
          entry.document.target_subject_ref,
          entry.document.scope_frame_ref,
          entry.document.research_plan_ref,
          entry.document.assessment_plan_ref,
          entry.document.supersedes_task_ref,
        ]),
        ...strings(entry.document.input_refs),
      ];
    case "startup_opportunity.evidence.assessment.current": {
      const binding = entry.document.mechanical_binding;
      return [...taskRef, ...(isRecord(binding) ? strings([binding.substrate_record_ref]) : [])];
    }
    case "startup_opportunity.claim.assessment.current":
      return [...taskRef, ...strings(entry.document.evidence_refs)];
    case "startup_opportunity.finding.assessment.current":
      return [
        ...taskRef,
        ...strings(entry.document.claim_refs),
        ...strings(entry.document.opposing_claim_refs),
      ];
    case "startup_opportunity.insight.assessment.current":
      return [...taskRef, ...strings(entry.document.finding_refs)];
    case "startup_opportunity.source_manifest.assessment.current":
      return [...taskRef, ...strings(entry.document.accepted_evidence_refs)];
    default:
      return [];
  }
}

function checkEnvelopeInputRefs(entry: ResearchBranchDocument, errors: ValidationIssue[]): void {
  if (entry.envelope?.schema_version !== "startup_opportunity.artifact_envelope.current") {
    return;
  }
  const envelopeRefs = new Set(strings(entry.envelope.input_refs));
  for (const parentRef of [...new Set(directParentRefs(entry))].sort()) {
    if (!envelopeRefs.has(parentRef)) {
      errors.push(
        issue(
          "research_contract.input_ref_missing",
          `${entry.path}#/input_refs`,
          "formal envelope omits a direct typed parent ref",
          { parentRef },
        ),
      );
    }
  }
}

function checkEvidence(
  evidence: ResearchBranchDocument,
  documentsByPath: ReadonlyMap<string, ResearchBranchDocument>,
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
  errors: ValidationIssue[],
): void {
  const task = taskFor(evidence, documentsByPath);
  if (task?.schemaVersion !== "startup_opportunity.research_task.assessment.current") {
    errors.push(
      issue(
        "research_contract.task_missing",
        `${evidence.path}#/lineage/task_ref`,
        "Evidence task ref is missing or mistyped",
      ),
    );
    return;
  }
  sameLineage(evidence, task, errors);
  const expectedPath = `evidence/records/${String(evidence.document.evidence_id)}.json`;
  if (evidence.path !== expectedPath) {
    errors.push(
      issue(
        "research_contract.evidence_path_mismatch",
        evidence.path,
        "Evidence path differs from its stable id",
        { expectedPath },
      ),
    );
  }
  const binding = evidence.document.mechanical_binding;
  const substrateRef = isRecord(binding) ? binding.substrate_record_ref : null;
  const substrate = typeof substrateRef === "string" ? exactRecords.get(substrateRef) : undefined;
  if (
    substrate === undefined ||
    substrate.schema_version !== "startup_opportunity.evidence_store_record.v2"
  ) {
    errors.push(
      issue(
        "research_contract.substrate_missing",
        `${evidence.path}#/mechanical_binding/substrate_record_ref`,
        "Evidence must bind one exact v2 substrate record",
        { substrateRef },
      ),
    );
    return;
  }
  const fieldPairs: readonly [string, string][] = [
    ["evidence_id", "evidence_id"],
    ["run_id", "run_id"],
    ["unit_id", "unit_id"],
    ["research_goal", "research_goal"],
  ];
  for (const [evidenceField, substrateField] of fieldPairs) {
    if (evidence.document[evidenceField] !== substrate[substrateField]) {
      errors.push(
        issue(
          "research_contract.substrate_mismatch",
          `${evidence.path}#/${evidenceField}`,
          "Evidence identity differs from its substrate record",
          { substrateField },
        ),
      );
    }
  }
  const mechanicalFields = [
    "source",
    "source_hash",
    "content_hash",
    "raw_content_ref",
    "operation_key",
    "recorded_at",
  ];
  for (const field of mechanicalFields) {
    if (!isRecord(binding) || canonicalJson(binding[field]) !== canonicalJson(substrate[field])) {
      errors.push(
        issue(
          "research_contract.substrate_mismatch",
          `${evidence.path}#/mechanical_binding/${field}`,
          "Evidence mechanical binding differs from its substrate record",
          { field },
        ),
      );
    }
  }
  if (evidence.document.retrieved_at !== substrate.recorded_at) {
    errors.push(
      issue(
        "research_contract.substrate_mismatch",
        `${evidence.path}#/retrieved_at`,
        "Evidence retrieved_at must equal substrate recorded_at",
      ),
    );
  }
}

function checkTypedParents(
  entry: ResearchBranchDocument,
  refs: readonly string[],
  expectedSchema: string,
  documentsByPath: ReadonlyMap<string, ResearchBranchDocument>,
  errors: ValidationIssue[],
): readonly ResearchBranchDocument[] {
  const parents: ResearchBranchDocument[] = [];
  for (const ref of refs) {
    const parent = targetByRef(documentsByPath, ref);
    if (parent?.schemaVersion !== expectedSchema) {
      errors.push(
        issue(
          "research_contract.parent_type_mismatch",
          `${entry.path}#/${ref}`,
          "traceability parent is missing or mistyped",
          { ref, expectedSchema },
        ),
      );
      continue;
    }
    const task = taskFor(entry, documentsByPath);
    if (task !== null) {
      sameLineage(parent, task, errors);
    }
    parents.push(parent);
  }
  return parents;
}

function checkClaim(
  claim: ResearchBranchDocument,
  documentsByPath: ReadonlyMap<string, ResearchBranchDocument>,
  errors: ValidationIssue[],
): void {
  const task = taskFor(claim, documentsByPath);
  if (task?.schemaVersion !== "startup_opportunity.research_task.assessment.current") {
    errors.push(
      issue(
        "research_contract.task_missing",
        `${claim.path}#/lineage/task_ref`,
        "Claim task ref is missing or mistyped",
      ),
    );
    return;
  }
  sameLineage(claim, task, errors);
  const parents = checkTypedParents(
    claim,
    strings(claim.document.evidence_refs),
    "startup_opportunity.evidence.assessment.current",
    documentsByPath,
    errors,
  );
  if (!parents.some((evidence) => evidence.document.evidence_role === claim.document.stance)) {
    errors.push(
      issue(
        "research_contract.stance_direction_mismatch",
        `${claim.path}#/stance`,
        "Claim stance has no same-direction Evidence",
      ),
    );
  }
}

function checkFinding(
  finding: ResearchBranchDocument,
  documentsByPath: ReadonlyMap<string, ResearchBranchDocument>,
  errors: ValidationIssue[],
): void {
  const task = taskFor(finding, documentsByPath);
  if (task?.schemaVersion !== "startup_opportunity.research_task.assessment.current") {
    errors.push(
      issue(
        "research_contract.task_missing",
        `${finding.path}#/lineage/task_ref`,
        "Finding task ref is missing or mistyped",
      ),
    );
    return;
  }
  sameLineage(finding, task, errors);
  const supporting = checkTypedParents(
    finding,
    strings(finding.document.claim_refs),
    "startup_opportunity.claim.assessment.current",
    documentsByPath,
    errors,
  );
  const opposing = checkTypedParents(
    finding,
    strings(finding.document.opposing_claim_refs),
    "startup_opportunity.claim.assessment.current",
    documentsByPath,
    errors,
  );
  if (
    supporting.some((claim) => claim.document.stance !== "support") ||
    opposing.some((claim) => claim.document.stance !== "oppose")
  ) {
    errors.push(
      issue(
        "research_contract.stance_direction_mismatch",
        finding.path,
        "Finding support/opposition refs point in the wrong direction",
      ),
    );
  }
}

function checkInsight(
  insight: ResearchBranchDocument,
  documentsByPath: ReadonlyMap<string, ResearchBranchDocument>,
  errors: ValidationIssue[],
): void {
  const task = taskFor(insight, documentsByPath);
  if (task?.schemaVersion !== "startup_opportunity.research_task.assessment.current") {
    errors.push(
      issue(
        "research_contract.task_missing",
        `${insight.path}#/lineage/task_ref`,
        "Insight task ref is missing or mistyped",
      ),
    );
    return;
  }
  sameLineage(insight, task, errors);
  checkTypedParents(
    insight,
    strings(insight.document.finding_refs),
    "startup_opportunity.finding.assessment.current",
    documentsByPath,
    errors,
  );
  if (!strings(insight.document.source_units).includes(String(insight.document.unit_id))) {
    errors.push(
      issue(
        "research_contract.insight_unit_missing",
        `${insight.path}#/source_units`,
        "Insight must name its owning unit",
      ),
    );
  }
}

function checkSourceManifest(
  sourceManifest: ResearchBranchDocument,
  documentsByPath: ReadonlyMap<string, ResearchBranchDocument>,
  errors: ValidationIssue[],
): void {
  const task = taskFor(sourceManifest, documentsByPath);
  if (task?.schemaVersion !== "startup_opportunity.research_task.assessment.current") {
    errors.push(
      issue(
        "research_contract.task_missing",
        `${sourceManifest.path}#/lineage/task_ref`,
        "Source Manifest task ref is missing or mistyped",
      ),
    );
    return;
  }
  sameLineage(sourceManifest, task, errors);
  checkTypedParents(
    sourceManifest,
    strings(sourceManifest.document.accepted_evidence_refs),
    "startup_opportunity.evidence.assessment.current",
    documentsByPath,
    errors,
  );
}

function checkBranch(
  branch: ResearchBranchDocument,
  documents: readonly ResearchBranchDocument[],
  documentsByPath: ReadonlyMap<string, ResearchBranchDocument>,
  errors: ValidationIssue[],
): void {
  if (branch.envelope?.schema_version !== "startup_opportunity.artifact_envelope.current") {
    return;
  }
  const inputRefs = strings(branch.envelope.input_refs);
  const inputs = inputRefs
    .map((ref) => targetByRef(documentsByPath, ref))
    .filter((entry): entry is ResearchBranchDocument => entry !== null);
  const tasks = inputs.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.research_task.assessment.current",
  );
  const sourceManifests = inputs.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.source_manifest.assessment.current",
  );
  const insights = inputs.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.insight.assessment.current",
  );
  if (tasks.length !== 1 || sourceManifests.length !== 1 || insights.length === 0) {
    errors.push(
      issue(
        "research_contract.branch_inputs_incomplete",
        `${branch.path}#/input_refs`,
        "v5 branch envelope must cite exactly one task, one Source Manifest, and at least one Insight",
        {
          taskCount: tasks.length,
          sourceManifestCount: sourceManifests.length,
          insightCount: insights.length,
        },
      ),
    );
    return;
  }
  const task = tasks[0];
  const sourceManifest = sourceManifests[0];
  if (task === undefined || sourceManifest === undefined) {
    return;
  }
  if (
    branch.document.run_id !== task.document.run_id ||
    branch.document.unit_id !== task.document.unit_id ||
    branch.document.concept_hypothesis_ref !== task.document.target_subject_ref ||
    branch.document.assessment_plan_ref !== task.document.assessment_plan_ref ||
    branch.path !== task.document.allowed_output_path
  ) {
    errors.push(
      issue(
        "research_contract.branch_task_mismatch",
        branch.path,
        "Branch Result differs from its task identity or unique output path",
      ),
    );
  }
  const coverageError = assessmentCoverageSemanticsError({
    coverageDisposition: String(branch.document.coverage_disposition),
    dimensionDecision: String(branch.document.dimension_decision),
    decisionSufficiency: String(branch.document.decision_sufficiency),
  });
  if (coverageError !== null) {
    errors.push(
      issue(
        "research_contract.branch_coverage_disposition_invalid",
        `${branch.path}#/coverage_disposition`,
        coverageError,
      ),
    );
  }
  const formalCoverage = deriveLaneScopeFormalClosure(
    [String(branch.document.dimension_id)],
    documents.map((entry) => ({
      artifact_ref: entry.path,
      artifact_type: entry.schemaVersion,
      content_hash:
        typeof entry.envelope?.content_hash === "string"
          ? entry.envelope.content_hash
          : canonicalContentHash(entry.document),
      document: entry.document,
    })),
    [branch.path],
  );
  for (const closureIssue of formalCoverage.issues.filter(
    (entry) => entry.code === "lane_delivery.scope_formal_disposition_invalid",
  )) {
    errors.push(
      issue(
        "research_contract.branch_coverage_evidence_invalid",
        `${branch.path}#/coverage_disposition`,
        closureIssue.message,
        { actual: closureIssue.actual, expected: closureIssue.expected },
      ),
    );
  }
  const linked = documents.filter((entry) => {
    const lineage = entry.document.lineage;
    return isRecord(lineage) && lineage.task_ref === task.path;
  });
  const evidenceIds = new Set(
    linked
      .filter((entry) => entry.schemaVersion === "startup_opportunity.evidence.assessment.current")
      .map(idOf)
      .filter((id): id is string => id !== null),
  );
  const evidenceById = new Map(
    linked
      .filter((entry) => entry.schemaVersion === "startup_opportunity.evidence.assessment.current")
      .map((entry) => [idOf(entry), entry]),
  );
  const claims = linked.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.claim.assessment.current",
  );
  const claimById = new Map(claims.map((entry) => [idOf(entry), entry]));
  if (strings(branch.document.evidence_refs).some((id) => !evidenceIds.has(id))) {
    errors.push(
      issue(
        "research_contract.branch_evidence_missing",
        `${branch.path}#/evidence_refs`,
        "Branch Result cites Evidence outside its task lineage",
      ),
    );
  }
  for (const [field, stance] of [
    ["supporting_claim_refs", "support"],
    ["opposing_claim_refs", "oppose"],
  ] as const) {
    for (const id of strings(branch.document[field])) {
      if (claimById.get(id)?.document.stance !== stance) {
        errors.push(
          issue(
            "research_contract.branch_claim_mismatch",
            `${branch.path}#/${field}`,
            "Branch Result claim id is missing or has the wrong stance",
            { id, stance },
          ),
        );
      }
    }
  }
  const branchFindings = checkTypedParents(
    branch,
    strings(branch.document.finding_refs),
    "startup_opportunity.finding.assessment.current",
    documentsByPath,
    errors,
  );
  const insightFindingRefs = new Set(
    insights.flatMap((insight) => strings(insight.document.finding_refs)),
  );
  const unreachableFindings = strings(branch.document.finding_refs).filter(
    (ref) => !insightFindingRefs.has(ref),
  );
  const branchClaimRefs = new Set(
    branchFindings.flatMap((finding) => [
      ...strings(finding.document.claim_refs),
      ...strings(finding.document.opposing_claim_refs),
    ]),
  );
  const unreachableClaimIds = [
    ...strings(branch.document.supporting_claim_refs),
    ...strings(branch.document.opposing_claim_refs),
  ].filter((id) => {
    const claim = claimById.get(id);
    return claim === undefined || !branchClaimRefs.has(claim.path);
  });
  const reachableEvidenceRefs = new Set(
    [...branchClaimRefs].flatMap((ref) => {
      const claim = documentsByPath.get(ref);
      return claim?.schemaVersion === "startup_opportunity.claim.assessment.current"
        ? strings(claim.document.evidence_refs)
        : [];
    }),
  );
  const unreachableEvidenceIds = strings(branch.document.evidence_refs).filter((id) => {
    const evidence = evidenceById.get(id);
    return evidence === undefined || !reachableEvidenceRefs.has(evidence.path);
  });
  if (
    unreachableFindings.length > 0 ||
    unreachableClaimIds.length > 0 ||
    unreachableEvidenceIds.length > 0
  ) {
    errors.push(
      issue(
        "research_contract.branch_chain_incomplete",
        branch.path,
        "Branch Result refs do not form a closed Insight -> Finding -> Claim -> Evidence chain",
        {
          unreachableClaimIds,
          unreachableEvidenceIds,
          unreachableFindings,
        },
      ),
    );
  }
  const acceptedEvidenceRefs = new Set(strings(sourceManifest.document.accepted_evidence_refs));
  const unacceptedEvidenceIds = strings(branch.document.evidence_refs).filter((id) => {
    const evidence = evidenceById.get(id);
    return evidence === undefined || !acceptedEvidenceRefs.has(evidence.path);
  });
  if (unacceptedEvidenceIds.length > 0) {
    errors.push(
      issue(
        "research_contract.source_manifest_incomplete",
        `${branch.path}#/evidence_refs`,
        "Branch Result Evidence is not accepted by its Source Manifest",
        { unacceptedEvidenceIds },
      ),
    );
  }
  sameLineage(sourceManifest, task, errors);
  for (const insight of insights) {
    sameLineage(insight, task, errors);
  }
  for (const judgmentRef of strings(branch.document.judgment_assessment_refs)) {
    const judgment = targetByRef(documentsByPath, judgmentRef);
    if (
      judgment?.schemaVersion !== "startup_opportunity.judgment_assessment.assessment.current" ||
      judgment.document.subject_ref !== branch.document.concept_hypothesis_ref ||
      judgment.document.dimension !== branch.document.dimension_id
    ) {
      errors.push(
        issue(
          "research_contract.branch_judgment_mismatch",
          `${branch.path}#/judgment_assessment_refs`,
          "Branch JudgmentAssessment is missing or has another subject/dimension",
          { judgmentRef },
        ),
      );
    }
  }
}

export function validateResearchBranchContract(
  documents: readonly ResearchBranchDocument[],
  exactRecords: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): readonly ValidationIssue[] {
  const hasResearchDocuments = documents.some(
    (entry) =>
      isResearchBranchSchemaVersion(entry.schemaVersion) ||
      (entry.schemaVersion === "startup_opportunity.concept_evidence_assessment_branch_result.v1" &&
        entry.envelope?.schema_version === "startup_opportunity.artifact_envelope.current"),
  );
  if (!hasResearchDocuments) {
    return [];
  }
  const errors: ValidationIssue[] = [];
  const documentsByPath = new Map(documents.map((entry) => [entry.path, entry]));
  const identities = new Map<string, string>();
  for (const entry of documents.filter((document) =>
    isResearchBranchSchemaVersion(document.schemaVersion),
  )) {
    const id = idOf(entry);
    if (id !== null) {
      const key = `${entry.schemaVersion}:${id}`;
      const previous = identities.get(key);
      if (previous !== undefined && previous !== entry.path) {
        errors.push(
          issue(
            "research_contract.duplicate_identity",
            entry.path,
            "research artifact identity is duplicated",
            { id, previous },
          ),
        );
      }
      identities.set(key, entry.path);
    }
    if (
      entry.envelope !== null &&
      entry.schemaVersion !== "startup_opportunity.research_task.assessment.current" &&
      entry.envelope.producer_role !== "lane_researcher"
    ) {
      errors.push(
        issue(
          "research_contract.owner_mismatch",
          `${entry.path}#/producer_role`,
          "research chain artifact must be published by lane_researcher",
        ),
      );
    }
    checkEnvelopeInputRefs(entry, errors);
  }
  for (const task of documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.research_task.assessment.current",
  )) {
    checkTask(task, documentsByPath, errors);
  }
  for (const evidence of documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.evidence.assessment.current",
  )) {
    checkEvidence(evidence, documentsByPath, exactRecords, errors);
  }
  for (const claim of documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.claim.assessment.current",
  )) {
    checkClaim(claim, documentsByPath, errors);
  }
  for (const finding of documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.finding.assessment.current",
  )) {
    checkFinding(finding, documentsByPath, errors);
  }
  for (const insight of documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.insight.assessment.current",
  )) {
    checkInsight(insight, documentsByPath, errors);
  }
  for (const sourceManifest of documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.source_manifest.assessment.current",
  )) {
    checkSourceManifest(sourceManifest, documentsByPath, errors);
  }
  for (const branch of documents.filter(
    (entry) =>
      entry.schemaVersion === "startup_opportunity.concept_evidence_assessment_branch_result.v1",
  )) {
    checkBranch(branch, documents, documentsByPath, errors);
  }
  return sortIssues(errors);
}

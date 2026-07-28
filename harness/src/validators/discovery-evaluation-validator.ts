import { canonicalContentHash, canonicalJson, sha256Bytes } from "../artifact-store/canonical.js";
import type { DiscoveryEvaluationPolicy } from "./discovery-evaluation-policy.js";
import { sortIssues, type ValidationIssue } from "./schema-bundle.js";

export interface DiscoveryEvaluationDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

const EVALUATION_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.research_task.v3",
  "startup_opportunity.evidence.v3",
  "startup_opportunity.claim.v3",
  "startup_opportunity.finding.v3",
  "startup_opportunity.insight.v3",
  "startup_opportunity.judgment_assessment.v3",
  "startup_opportunity.source_manifest.v3",
  "startup_opportunity.enrichment_branch_result.v1",
  "startup_opportunity.enrichment_fan_in.v1",
  "startup_opportunity.value_layer_analysis.v1",
  "startup_opportunity.user_state_context_model.v1",
  "startup_opportunity.buyer_purchase_language.v1",
  "startup_opportunity.business_engine_thesis.v2",
  "startup_opportunity.opportunity_comparison.v1",
  "startup_opportunity.sensitivity.v1",
  "startup_opportunity.portfolio_view.v1",
  "startup_opportunity.decision_recommendation.v1",
  "startup_opportunity.traceability.v2",
  "startup_opportunity.report.v1",
  "startup_opportunity.decision_brief.v2",
  "startup_opportunity.discovery_report_view.v1",
  "startup_opportunity.report_consistency_evaluation.v2",
]);

const MATERIAL_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.evidence.v3",
  "startup_opportunity.claim.v3",
  "startup_opportunity.finding.v3",
  "startup_opportunity.insight.v3",
  "startup_opportunity.judgment_assessment.v3",
  "startup_opportunity.source_manifest.v3",
]);

const MATERIAL_FIELDS: Readonly<Record<string, string>> = {
  evidence_refs: "startup_opportunity.evidence.v3",
  claim_refs: "startup_opportunity.claim.v3",
  finding_refs: "startup_opportunity.finding.v3",
  insight_refs: "startup_opportunity.insight.v3",
  judgment_assessment_refs: "startup_opportunity.judgment_assessment.v3",
  source_manifest_refs: "startup_opportunity.source_manifest.v3",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function issue(
  code: string,
  path: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return { code, keyword: "g2_4", instancePath: path, schemaPath: "", message, details };
}

function setEqual(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson([...new Set(left)].sort()) === canonicalJson([...new Set(right)].sort());
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function collectRefs(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectRefs);
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    if ((key.endsWith("_refs") || key === "input_refs") && Array.isArray(child)) {
      return strings(child).filter((ref) => ref.includes("/") || ref.includes("#"));
    }
    if (
      (key.endsWith("_ref") || key.endsWith("_refs") || key === "ref") &&
      typeof child === "string" &&
      (child.includes("/") || child.includes("#"))
    ) {
      return [child];
    }
    return collectRefs(child);
  });
}

function target(
  byPath: ReadonlyMap<string, DiscoveryEvaluationDocument>,
  ref: unknown,
): DiscoveryEvaluationDocument | undefined {
  return typeof ref === "string" ? byPath.get(ref.split("#", 1)[0] ?? "") : undefined;
}

function validateEnvelope(entry: DiscoveryEvaluationDocument, errors: ValidationIssue[]): void {
  if (!EVALUATION_SCHEMA_VERSIONS.has(entry.schemaVersion)) {
    return;
  }
  if (entry.envelope?.schema_version !== "startup_opportunity.artifact_envelope.v12") {
    errors.push(
      issue(
        "g2_4.envelope_version_mismatch",
        entry.path,
        "G2.4 artifacts require artifact_envelope.v12",
      ),
    );
    return;
  }
  const expectedRole =
    entry.schemaVersion === "startup_opportunity.research_task.v3" ||
    [
      "startup_opportunity.enrichment_fan_in.v1",
      "startup_opportunity.value_layer_analysis.v1",
      "startup_opportunity.user_state_context_model.v1",
      "startup_opportunity.buyer_purchase_language.v1",
      "startup_opportunity.business_engine_thesis.v2",
      "startup_opportunity.opportunity_comparison.v1",
      "startup_opportunity.sensitivity.v1",
      "startup_opportunity.portfolio_view.v1",
      "startup_opportunity.decision_recommendation.v1",
      "startup_opportunity.traceability.v2",
      "startup_opportunity.report.v1",
    ].includes(entry.schemaVersion)
      ? "main_agent"
      : [
            "startup_opportunity.decision_brief.v2",
            "startup_opportunity.discovery_report_view.v1",
            "startup_opportunity.report_consistency_evaluation.v2",
          ].includes(entry.schemaVersion)
        ? "harness"
        : "lane_researcher";
  if (entry.envelope.producer_role !== expectedRole) {
    errors.push(
      issue(
        "g2_4.owner_mismatch",
        `${entry.path}#/producer_role`,
        "G2.4 artifact producer differs from its owning role",
        { expectedRole },
      ),
    );
  }
  const expectedInputRefs = [...new Set(collectRefs(entry.document))]
    .filter((ref) => ref !== entry.path)
    .sort();
  if (!setEqual(strings(entry.envelope.input_refs), expectedInputRefs)) {
    errors.push(
      issue(
        "g2_4.envelope_input_closure_mismatch",
        `${entry.path}#/input_refs`,
        "envelope input_refs must exactly close over typed document refs",
        { expectedInputRefs },
      ),
    );
  }
}

function validateTaskAndMaterial(
  entries: readonly DiscoveryEvaluationDocument[],
  byPath: ReadonlyMap<string, DiscoveryEvaluationDocument>,
  exactJsonlRecords: ReadonlyMap<string, Record<string, unknown>>,
  errors: ValidationIssue[],
): void {
  for (const task of entries.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.research_task.v3",
  )) {
    const manifest = byPath.get("manifest.json");
    const plan = target(byPath, task.document.research_plan_ref);
    const planBinding = records(plan?.document.waves)
      .flatMap((wave) => records(wave.units).map((unit) => ({ waveId: wave.wave_id, unit })))
      .find(({ unit }) => unit.unit_id === task.document.unit_id);
    const exactPlanFields: readonly [string, string][] = [
      ["wave_id", "waveId"],
      ["unit_type", "unit_type"],
      ["research_goal", "research_goal"],
      ["attempt", "attempt"],
      ["agent_role", "agent_role"],
      ["allowed_output_path", "output_path"],
      ["required_artifact_schema", "required_artifact_schema"],
    ];
    const planMismatch =
      manifest?.schemaVersion !== "startup_opportunity.run_manifest.v1" ||
      manifest.document.current_plan_ref !== task.document.research_plan_ref ||
      plan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
      planBinding === undefined ||
      planBinding.unit.plan_disposition !== "enabled" ||
      exactPlanFields.some(
        ([taskField, unitField]) =>
          task.document[taskField] !==
          (unitField === "waveId" ? planBinding?.waveId : planBinding?.unit[unitField]),
      ) ||
      !same(
        [...strings(task.document.input_refs)].sort(),
        [...strings(planBinding?.unit.input_refs)].sort(),
      );
    if (planMismatch) {
      errors.push(
        issue(
          "g2_4.task_plan_unit_mismatch",
          `${task.path}#/unit_id`,
          "enrichment task must match one enabled unit in the current immutable Research Plan",
        ),
      );
    }
    const snapshot = target(byPath, task.document.source_snapshot_ref);
    const merge = target(byPath, task.document.source_merge_ref);
    const opportunityRefs = strings(task.document.target_opportunity_refs);
    if (
      snapshot?.schemaVersion !== "startup_opportunity.thesis_evaluation_snapshot.v1" ||
      snapshot.document.enrichment_started !== false ||
      snapshot.document.scope_frame_ref !== task.document.scope_frame_ref ||
      snapshot.document.research_plan_ref !== task.document.research_plan_ref ||
      !opportunityRefs.every((ref) => strings(snapshot.document.subject_refs).includes(ref)) ||
      merge?.schemaVersion !== "startup_opportunity.merge.v1" ||
      merge.document.source_snapshot_ref !== task.document.source_snapshot_ref ||
      merge.document.scope_frame_ref !== task.document.scope_frame_ref ||
      merge.document.research_plan_ref !== task.document.research_plan_ref ||
      !opportunityRefs.every((ref) => strings(merge.document.source_thesis_refs).includes(ref))
    ) {
      errors.push(
        issue(
          "g2_4.task_snapshot_merge_binding_mismatch",
          task.path,
          "enrichment task must bind exact frozen snapshot, semantic merge, and target opportunities",
        ),
      );
    }
    if (
      task.document.allowed_output_path !==
      `artifacts/discovery/enrichment/branches/${String(task.document.unit_id)}.attempt-${String(task.document.attempt)}.json`
    ) {
      errors.push(
        issue(
          "g2_4.task_output_identity_mismatch",
          `${task.path}#/allowed_output_path`,
          "task output path must encode its exact unit and attempt",
        ),
      );
    }
  }

  for (const material of entries.filter((entry) =>
    MATERIAL_SCHEMA_VERSIONS.has(entry.schemaVersion),
  )) {
    const lineage = material.document.lineage;
    const task = isRecord(lineage) ? target(byPath, lineage.task_ref) : undefined;
    if (
      !isRecord(lineage) ||
      task?.schemaVersion !== "startup_opportunity.research_task.v3" ||
      lineage.unit_id !== task.document.unit_id ||
      lineage.attempt !== task.document.attempt ||
      !same(lineage.opportunity_refs, task.document.target_opportunity_refs) ||
      lineage.source_snapshot_ref !== task.document.source_snapshot_ref ||
      lineage.source_merge_ref !== task.document.source_merge_ref ||
      lineage.scope_frame_ref !== task.document.scope_frame_ref ||
      lineage.research_plan_ref !== task.document.research_plan_ref ||
      material.document.unit_id !== task.document.unit_id
    ) {
      errors.push(
        issue(
          "g2_4.material_task_binding_mismatch",
          `${material.path}#/lineage`,
          "typed enrichment material must bind its exact owning task and frozen inputs",
        ),
      );
    }
    if (
      material.schemaVersion === "startup_opportunity.judgment_assessment.v3" &&
      (!isRecord(lineage) ||
        !strings(lineage.opportunity_refs).includes(String(material.document.subject_ref)))
    ) {
      errors.push(
        issue(
          "g2_4.judgment_subject_mismatch",
          `${material.path}#/subject_ref`,
          "Judgment subject must be one of the owning task's exact opportunities",
        ),
      );
    }
    if (material.schemaVersion === "startup_opportunity.evidence.v3") {
      const binding = material.document.mechanical_binding;
      const substrate = isRecord(binding)
        ? exactJsonlRecords.get(String(binding.substrate_record_ref))
        : undefined;
      if (
        !isRecord(binding) ||
        substrate?.schema_version !== "startup_opportunity.evidence_store_record.v2" ||
        substrate.evidence_id !== material.document.evidence_id ||
        substrate.run_id !== material.document.run_id ||
        substrate.unit_id !== material.document.unit_id ||
        substrate.source_hash !== binding.source_hash ||
        substrate.content_hash !== binding.content_hash ||
        substrate.raw_content_ref !== binding.raw_content_ref ||
        substrate.operation_key !== binding.operation_key ||
        substrate.recorded_at !== binding.recorded_at
      ) {
        errors.push(
          issue(
            "g2_4.evidence_substrate_binding_mismatch",
            `${material.path}#/mechanical_binding`,
            "Evidence must bind the exact same-Run, same-unit substrate record and immutable hashes",
          ),
        );
      }
    }
  }

  const graphRules: readonly [string, string, string][] = [
    ["startup_opportunity.claim.v3", "evidence_refs", "startup_opportunity.evidence.v3"],
    ["startup_opportunity.finding.v3", "claim_refs", "startup_opportunity.claim.v3"],
    ["startup_opportunity.finding.v3", "opposing_claim_refs", "startup_opportunity.claim.v3"],
    ["startup_opportunity.insight.v3", "finding_refs", "startup_opportunity.finding.v3"],
    ["startup_opportunity.judgment_assessment.v3", "supporting_refs", "material"],
    ["startup_opportunity.judgment_assessment.v3", "opposing_refs", "material"],
    [
      "startup_opportunity.source_manifest.v3",
      "accepted_evidence_refs",
      "startup_opportunity.evidence.v3",
    ],
  ];
  for (const [sourceType, field, expected] of graphRules) {
    for (const source of entries.filter((entry) => entry.schemaVersion === sourceType)) {
      for (const ref of strings(source.document[field])) {
        const linked = target(byPath, ref);
        const validType =
          expected === "material"
            ? linked?.schemaVersion === "startup_opportunity.evidence.v3" ||
              linked?.schemaVersion === "startup_opportunity.claim.v3"
            : linked?.schemaVersion === expected;
        if (
          !validType ||
          !isRecord(linked?.document.lineage) ||
          !isRecord(source.document.lineage) ||
          linked.document.lineage.task_ref !== source.document.lineage.task_ref
        ) {
          errors.push(
            issue(
              "g2_4.material_graph_binding_mismatch",
              `${source.path}#/${field}`,
              "typed material graph edge must target the expected type under the same task",
              { ref, expected },
            ),
          );
        }
      }
    }
  }
}

function branchLineageRefs(branch: Record<string, unknown>, field: string): readonly string[] {
  return isRecord(branch.evidence_lineage) ? strings(branch.evidence_lineage[field]) : [];
}

function validateBranchesAndFanIn(
  entries: readonly DiscoveryEvaluationDocument[],
  byPath: ReadonlyMap<string, DiscoveryEvaluationDocument>,
  policy: DiscoveryEvaluationPolicy,
  errors: ValidationIssue[],
): void {
  const branches = entries.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.enrichment_branch_result.v1",
  );
  for (const branch of branches) {
    const task = target(byPath, branch.document.task_ref);
    const lineageRefs = Object.keys(MATERIAL_FIELDS).flatMap((field) =>
      branchLineageRefs(branch.document, field),
    );
    if (
      task?.schemaVersion !== "startup_opportunity.research_task.v3" ||
      branch.path !== task.document.allowed_output_path ||
      branch.document.unit_id !== task.document.unit_id ||
      branch.document.attempt !== task.document.attempt ||
      branch.document.source_snapshot_ref !== task.document.source_snapshot_ref ||
      branch.document.source_merge_ref !== task.document.source_merge_ref ||
      !same(branch.document.opportunity_refs, task.document.target_opportunity_refs)
    ) {
      errors.push(
        issue(
          "g2_4.branch_task_binding_mismatch",
          branch.path,
          "enrichment branch must bind its exact task, output path, attempt, and frozen inputs",
        ),
      );
    }
    for (const ref of lineageRefs) {
      const material = target(byPath, ref);
      if (
        !MATERIAL_SCHEMA_VERSIONS.has(material?.schemaVersion ?? "") ||
        !isRecord(material?.document.lineage) ||
        material.document.lineage.task_ref !== branch.document.task_ref
      ) {
        errors.push(
          issue(
            "g2_4.branch_material_closure_mismatch",
            `${branch.path}#/evidence_lineage`,
            "branch material refs must resolve to material owned by the branch task",
            { ref },
          ),
        );
      }
    }
    for (const gate of records(branch.document.hard_gate_inputs)) {
      for (const ref of strings(gate.judgment_assessment_refs)) {
        const judgment = target(byPath, ref);
        if (
          !branchLineageRefs(branch.document, "judgment_assessment_refs").includes(ref) ||
          judgment?.schemaVersion !== "startup_opportunity.judgment_assessment.v3" ||
          judgment.document.subject_ref !== gate.opportunity_ref
        ) {
          errors.push(
            issue(
              "g2_4.branch_gate_judgment_mismatch",
              `${branch.path}#/hard_gate_inputs`,
              "branch hard gate Judgment must be in branch lineage and bind the affected opportunity",
              { ref },
            ),
          );
        }
      }
    }
  }

  for (const fanIn of entries.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.enrichment_fan_in.v1",
  )) {
    const classification = fanIn.document.branch_result_classification;
    if (!isRecord(classification)) {
      continue;
    }
    const fields = [
      "completed_refs",
      "partial_refs",
      "insufficient_evidence_refs",
      "failed_refs",
      "ignored_late_refs",
      "superseded_refs",
    ] as const;
    const classified = fields.flatMap((field) => strings(classification[field]));
    const relevantBranches = branches.filter(
      (branch) =>
        branch.document.source_snapshot_ref === fanIn.document.source_snapshot_ref &&
        branch.document.source_merge_ref === fanIn.document.source_merge_ref,
    );
    const expectedByField: Readonly<Record<string, string>> = {
      completed_refs: "completed",
      partial_refs: "partial",
      insufficient_evidence_refs: "insufficient_evidence",
      failed_refs: "failed",
      ignored_late_refs: "ignored_late",
      superseded_refs: "superseded",
    };
    const classificationValid =
      new Set(classified).size === classified.length &&
      setEqual(
        classified,
        relevantBranches.map((branch) => branch.path),
      ) &&
      fields.every((field) =>
        strings(classification[field]).every(
          (ref) => byPath.get(ref)?.document.status === expectedByField[field],
        ),
      );
    if (!classificationValid) {
      errors.push(
        issue(
          "g2_4.fan_in_classification_mismatch",
          `${fanIn.path}#/branch_result_classification`,
          "fan-in must classify every source branch exactly once by terminal status",
        ),
      );
    }
    const eligible = relevantBranches.filter((branch) =>
      policy.eligible_branch_statuses.includes(String(branch.document.status)),
    );
    if (
      !setEqual(
        strings(fanIn.document.eligible_branch_refs),
        eligible.map((branch) => branch.path),
      )
    ) {
      errors.push(
        issue(
          "g2_4.fan_in_eligible_closure_mismatch",
          `${fanIn.path}#/eligible_branch_refs`,
          "fan-in eligible refs must exactly equal completed, partial, and insufficient branches",
        ),
      );
    }
    for (const [field, expectedType] of Object.entries(MATERIAL_FIELDS)) {
      const expectedRefs = eligible.flatMap((branch) => branchLineageRefs(branch.document, field));
      const actualRefs = strings(fanIn.document[field]);
      if (
        !setEqual(actualRefs, expectedRefs) ||
        actualRefs.some((ref) => byPath.get(ref)?.schemaVersion !== expectedType)
      ) {
        errors.push(
          issue(
            "g2_4.fan_in_material_closure_mismatch",
            `${fanIn.path}#/${field}`,
            "fan-in material refs must exactly close over eligible branch refs",
            { field },
          ),
        );
      }
    }
    const opportunities = strings(fanIn.document.opportunity_refs);
    const gates = records(fanIn.document.hard_gate_inputs);
    for (const opportunityRef of opportunities) {
      const opportunityGates = gates.filter((gate) => gate.opportunity_ref === opportunityRef);
      if (
        !setEqual(
          opportunityGates.map((gate) => String(gate.gate_id)),
          policy.required_hard_gates,
        )
      ) {
        errors.push(
          issue(
            "g2_4.hard_gate_closure_mismatch",
            `${fanIn.path}#/hard_gate_inputs`,
            "fan-in requires all hard gates exactly once for every opportunity",
            { opportunityRef },
          ),
        );
      }
      for (const gate of opportunityGates) {
        if (
          strings(gate.source_branch_refs).some(
            (ref) => !eligible.some((branch) => branch.path === ref),
          ) ||
          strings(gate.judgment_assessment_refs).some((ref) => {
            const judgment = target(byPath, ref);
            return (
              !strings(fanIn.document.judgment_assessment_refs).includes(ref) ||
              judgment?.schemaVersion !== "startup_opportunity.judgment_assessment.v3" ||
              judgment.document.subject_ref !== opportunityRef
            );
          })
        ) {
          errors.push(
            issue(
              "g2_4.fan_in_gate_lineage_mismatch",
              `${fanIn.path}#/hard_gate_inputs`,
              "fan-in gate inputs must use eligible branches and subject-bound Judgments",
              { opportunityRef },
            ),
          );
        }
      }
    }
    const ceilings = records(fanIn.document.opportunity_conclusion_ceilings);
    if (
      !setEqual(
        ceilings.map((entry) => String(entry.opportunity_ref)),
        opportunities,
      )
    ) {
      errors.push(
        issue(
          "g2_4.conclusion_ceiling_closure_mismatch",
          `${fanIn.path}#/opportunity_conclusion_ceilings`,
          "fan-in conclusion ceilings must cover every opportunity exactly once",
        ),
      );
    }
  }
}

function validateHashEntries(
  owner: DiscoveryEvaluationDocument,
  hashes: unknown,
  byPath: ReadonlyMap<string, DiscoveryEvaluationDocument>,
  errors: ValidationIssue[],
): void {
  for (const entry of records(hashes)) {
    const linked = target(byPath, entry.ref);
    if (linked === undefined || entry.content_hash !== canonicalContentHash(linked.document)) {
      errors.push(
        issue(
          "g2_4.input_hash_mismatch",
          `${owner.path}#/input_artifact_hashes`,
          "input hash must bind the exact canonical target document",
          { ref: entry.ref },
        ),
      );
    }
  }
}

function validateEvaluationAndReporting(
  entries: readonly DiscoveryEvaluationDocument[],
  byPath: ReadonlyMap<string, DiscoveryEvaluationDocument>,
  policy: DiscoveryEvaluationPolicy,
  errors: ValidationIssue[],
): void {
  const fanIns = entries.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.enrichment_fan_in.v1",
  );
  const comparisons = entries.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.opportunity_comparison.v1",
  );
  const judgmentSubjectMatches = (refs: readonly string[], opportunityRef: unknown): boolean =>
    refs.every((ref) => {
      const judgment = target(byPath, ref);
      return (
        judgment?.schemaVersion === "startup_opportunity.judgment_assessment.v3" &&
        judgment.document.subject_ref === opportunityRef
      );
    });

  for (const entry of entries) {
    if ("input_artifact_hashes" in entry.document) {
      validateHashEntries(entry, entry.document.input_artifact_hashes, byPath, errors);
    }
    if (isRecord(entry.document.report_metadata)) {
      validateHashEntries(
        entry,
        entry.document.report_metadata.input_artifact_hashes,
        byPath,
        errors,
      );
    }
  }

  for (const comparison of comparisons) {
    const fanIn = target(byPath, comparison.document.enrichment_fan_in_ref);
    const opportunityRef = comparison.document.opportunity_ref;
    const domainRefs = [
      comparison.document.value_layer_analysis_ref,
      comparison.document.user_state_context_model_ref,
      comparison.document.buyer_purchase_language_ref,
      comparison.document.business_engine_ref,
    ];
    const domainValid = domainRefs.every((ref) => {
      const domain = target(byPath, ref);
      return (
        domain !== undefined &&
        domain.document.run_id === comparison.document.run_id &&
        (domain.document.opportunity_ref ?? domain.document.subject_ref) === opportunityRef &&
        domain.document.source_snapshot_ref === comparison.document.source_snapshot_ref &&
        domain.document.enrichment_fan_in_ref === comparison.document.enrichment_fan_in_ref &&
        judgmentSubjectMatches(strings(domain.document.judgment_assessment_refs), opportunityRef)
      );
    });
    if (!domainValid || fanIn?.schemaVersion !== "startup_opportunity.enrichment_fan_in.v1") {
      errors.push(
        issue(
          "g2_4.comparison_subject_binding_mismatch",
          comparison.path,
          "comparison domain inputs must bind the same opportunity, snapshot, and fan-in",
        ),
      );
    }
    const gates = records(comparison.document.hard_gate_results);
    const fanInGates = records(fanIn?.document.hard_gate_inputs).filter(
      (gate) => gate.opportunity_ref === opportunityRef,
    );
    if (
      !setEqual(
        gates.map((gate) => String(gate.gate_id)),
        policy.required_hard_gates,
      ) ||
      Date.parse(String(comparison.document.hard_gates_evaluated_at)) >
        Date.parse(String(comparison.document.compared_at))
    ) {
      errors.push(
        issue(
          "g2_4.hard_gate_order_mismatch",
          `${comparison.path}#/hard_gate_results`,
          "all hard gates must be evaluated exactly once before comparison",
        ),
      );
    }
    if (
      gates.some((gate) => {
        const source = fanInGates.find((candidate) => candidate.gate_id === gate.gate_id);
        return (
          source === undefined ||
          source.status !== gate.status ||
          strings(source.judgment_assessment_refs).some(
            (ref) => !strings(gate.judgment_assessment_refs).includes(ref),
          )
        );
      })
    ) {
      errors.push(
        issue(
          "g2_4.comparison_gate_lineage_mismatch",
          `${comparison.path}#/hard_gate_results`,
          "comparison hard gates must bind every same-opportunity fan-in gate before comparison",
        ),
      );
    }
    const panels = records(comparison.document.comparison_panels);
    if (
      !setEqual(
        panels.map((panel) => String(panel.panel_id)),
        policy.required_comparison_panels,
      )
    ) {
      errors.push(
        issue(
          "g2_4.panel_closure_mismatch",
          `${comparison.path}#/comparison_panels`,
          "comparison requires the four independent panels exactly once",
        ),
      );
    }
    const allJudgments = [
      ...strings(comparison.document.judgment_assessment_refs),
      ...gates.flatMap((gate) => strings(gate.judgment_assessment_refs)),
    ];
    if (!judgmentSubjectMatches(allJudgments, opportunityRef)) {
      errors.push(
        issue(
          "g2_4.comparison_judgment_subject_mismatch",
          `${comparison.path}#/judgment_assessment_refs`,
          "comparison Judgments must bind the compared opportunity",
        ),
      );
    }
    const hasFailed = gates.some((gate) => gate.status === "failed");
    const hasInsufficient = gates.some((gate) => gate.status === "insufficient_evidence");
    const weakEvidence = panels.some(
      (panel) =>
        panel.panel_id === "evidence_strength" && ["weak", "unknown"].includes(String(panel.band)),
    );
    const fanCeiling = records(fanIn?.document.opportunity_conclusion_ceilings).find(
      (ceiling) => ceiling.opportunity_ref === opportunityRef,
    )?.conclusion_ceiling;
    if (
      (hasFailed &&
        (comparison.document.hard_gate_outcome !== "reject" ||
          comparison.document.recommendation_band !== "reject")) ||
      (!hasFailed &&
        hasInsufficient &&
        comparison.document.hard_gate_outcome !== "insufficient_evidence") ||
      (!hasFailed && !hasInsufficient && comparison.document.hard_gate_outcome === "reject") ||
      ((hasInsufficient || weakEvidence || fanCeiling !== "strong_candidate") &&
        comparison.document.recommendation_band === "strong_candidate")
    ) {
      errors.push(
        issue(
          "g2_4.evidence_ceiling_violation",
          `${comparison.path}#/recommendation_band`,
          "recommendation exceeds hard-gate, evidence, or fan-in conclusion ceiling",
        ),
      );
    }
  }

  for (const sensitivity of entries.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.sensitivity.v1",
  )) {
    const comparisonRefs = comparisons.map((entry) => entry.path);
    const scenarios = records(sensitivity.document.scenario_relations);
    const opportunities = comparisons.map((entry) => String(entry.document.opportunity_ref));
    const pairwise = records(sensitivity.document.pairwise_relations);
    const expectedPairs = (opportunities.length * (opportunities.length - 1)) / 2;
    const pairKeys = pairwise.map((entry) =>
      [String(entry.left_opportunity_ref), String(entry.right_opportunity_ref)].sort().join("\0"),
    );
    if (
      !setEqual(strings(sensitivity.document.comparison_refs), comparisonRefs) ||
      !setEqual(
        scenarios.map((scenario) => String(scenario.scenario)),
        ["downside", "expected", "upside"],
      ) ||
      pairwise.length !== expectedPairs ||
      new Set(pairKeys).size !== pairKeys.length ||
      pairwise.some(
        (entry) =>
          entry.left_opportunity_ref === entry.right_opportunity_ref ||
          !opportunities.includes(String(entry.left_opportunity_ref)) ||
          !opportunities.includes(String(entry.right_opportunity_ref)),
      )
    ) {
      errors.push(
        issue(
          "g2_4.sensitivity_relation_mismatch",
          sensitivity.path,
          "sensitivity must close over comparisons, three scenarios, and each unordered pair once",
        ),
      );
    }
  }

  const sensitivity = entries.find(
    (entry) => entry.schemaVersion === "startup_opportunity.sensitivity.v1",
  );
  const portfolio = entries.find(
    (entry) => entry.schemaVersion === "startup_opportunity.portfolio_view.v1",
  );
  const recommendation = entries.find(
    (entry) => entry.schemaVersion === "startup_opportunity.decision_recommendation.v1",
  );
  if (portfolio !== undefined) {
    const opportunities = comparisons.map((entry) => String(entry.document.opportunity_ref));
    const partition = [
      ...(typeof portfolio.document.recommended_first_bet === "string"
        ? [portfolio.document.recommended_first_bet]
        : []),
      ...strings(portfolio.document.alternative_bets),
      ...strings(portfolio.document.watchlist_refs),
      ...strings(portfolio.document.rejected_refs),
    ];
    if (
      portfolio.document.sensitivity_ref !== sensitivity?.path ||
      !setEqual(
        strings(portfolio.document.comparison_refs),
        comparisons.map((entry) => entry.path),
      ) ||
      new Set(partition).size !== partition.length ||
      !setEqual(partition, opportunities)
    ) {
      errors.push(
        issue(
          "g2_4.portfolio_closure_mismatch",
          portfolio.path,
          "portfolio must partition every compared opportunity exactly once",
        ),
      );
    }
  }
  if (
    recommendation !== undefined &&
    (recommendation.document.portfolio_view_ref !== portfolio?.path ||
      recommendation.document.sensitivity_ref !== sensitivity?.path ||
      !setEqual(
        strings(recommendation.document.comparison_refs),
        comparisons.map((entry) => entry.path),
      ) ||
      recommendation.document.recommended_first_bet !== portfolio?.document.recommended_first_bet ||
      !same(recommendation.document.alternative_bets, portfolio?.document.alternative_bets))
  ) {
    errors.push(
      issue(
        "g2_4.recommendation_closure_mismatch",
        recommendation.path,
        "recommendation must preserve comparison, sensitivity, and portfolio decisions",
      ),
    );
  }

  const traceability = entries.find(
    (entry) => entry.schemaVersion === "startup_opportunity.traceability.v2",
  );
  if (traceability !== undefined) {
    const traceabilityFanIn = target(byPath, traceability.document.enrichment_fan_in_ref);
    const statements = records(traceability.document.statements);
    const decisive = strings(recommendation?.document.decisive_judgment_assessment_refs);
    const traced = statements.map((statement) => String(statement.judgment_assessment_ref));
    const statementInvalid = statements.some((statement) => {
      const judgment = target(byPath, statement.judgment_assessment_ref);
      return (
        judgment?.schemaVersion !== "startup_opportunity.judgment_assessment.v3" ||
        judgment.document.subject_ref !== statement.subject_ref ||
        strings(statement.claim_refs).some(
          (ref) => target(byPath, ref)?.schemaVersion !== "startup_opportunity.claim.v3",
        ) ||
        strings(statement.evidence_refs).some(
          (ref) => target(byPath, ref)?.schemaVersion !== "startup_opportunity.evidence.v3",
        ) ||
        strings(statement.source_manifest_refs).some(
          (ref) => target(byPath, ref)?.schemaVersion !== "startup_opportunity.source_manifest.v3",
        )
      );
    });
    const freshness = traceability.document.freshness_summary;
    const freshnessRefs = isRecord(freshness)
      ? [
          ...strings(freshness.current_refs),
          ...strings(freshness.stale_refs),
          ...strings(freshness.unknown_refs),
        ]
      : [];
    if (
      traceability.document.decision_recommendation_ref !== recommendation?.path ||
      traceabilityFanIn?.schemaVersion !== "startup_opportunity.enrichment_fan_in.v1" ||
      !setEqual(
        strings(traceability.document.comparison_refs),
        comparisons.map((entry) => entry.path),
      ) ||
      !setEqual(strings(traceability.document.decisive_judgment_assessment_refs), decisive) ||
      decisive.some((ref) => !traced.includes(ref)) ||
      statementInvalid ||
      new Set(freshnessRefs).size !== freshnessRefs.length ||
      !setEqual(freshnessRefs, strings(traceabilityFanIn?.document.evidence_refs))
    ) {
      errors.push(
        issue(
          "g2_4.traceability_freshness_mismatch",
          traceability.path,
          "traceability must bind decisive Judgment chains and disjoint freshness classifications",
        ),
      );
    }
  }

  const report = entries.find((entry) => entry.schemaVersion === "startup_opportunity.report.v1");
  const reportContext = isRecord(report?.document.curated_judgment_context)
    ? report.document.curated_judgment_context
    : null;
  const reportDecisionRefs = [
    ...records(reportContext?.decisive_support).flatMap((entry) => strings(entry.refs)),
    ...records(reportContext?.decisive_opposition).flatMap((entry) => strings(entry.refs)),
  ];
  if (
    report !== undefined &&
    (report.document.decision_recommendation_ref !== recommendation?.path ||
      report.document.portfolio_view_ref !== portfolio?.path ||
      report.document.sensitivity_ref !== sensitivity?.path ||
      report.document.traceability_ref !== traceability?.path ||
      !setEqual(
        strings(report.document.comparison_refs),
        comparisons.map((entry) => entry.path),
      ) ||
      !same(report.document.freshness_summary, traceability?.document.freshness_summary) ||
      !same(
        report.document.top_opportunity_refs,
        portfolio?.document.recommended_first_bet === null
          ? []
          : [portfolio?.document.recommended_first_bet],
      ) ||
      !same(report.document.watchlist_refs, portfolio?.document.watchlist_refs) ||
      !same(report.document.rejected_opportunity_refs, portfolio?.document.rejected_refs) ||
      reportContext?.recommended_first_bet !== recommendation?.document.recommended_first_bet ||
      !same(reportContext?.alternative_bets, recommendation?.document.alternative_bets) ||
      reportContext?.decision_tier !== recommendation?.document.decision_tier ||
      !same(
        reportContext?.what_would_change_the_decision,
        recommendation?.document.what_would_change_the_decision,
      ) ||
      !setEqual(
        strings(report.document.judgment_assessment_refs),
        strings(recommendation?.document.decisive_judgment_assessment_refs),
      ) ||
      !setEqual(
        strings(report.document.business_engine_refs),
        strings(recommendation?.document.business_engine_refs),
      ) ||
      reportDecisionRefs.some((ref) => {
        const linked = target(byPath, ref);
        return (
          linked === undefined ||
          !MATERIAL_SCHEMA_VERSIONS.has(linked.schemaVersion) ||
          linked.schemaVersion === "startup_opportunity.source_manifest.v3"
        );
      }))
  ) {
    errors.push(
      issue(
        "g2_4.report_closure_mismatch",
        report.path,
        "discovery report must exactly preserve validated recommendation, portfolio, and freshness state",
      ),
    );
  }

  const brief = entries.find(
    (entry) => entry.schemaVersion === "startup_opportunity.decision_brief.v2",
  );
  const view = entries.find(
    (entry) => entry.schemaVersion === "startup_opportunity.discovery_report_view.v1",
  );
  const consistency = entries.find(
    (entry) => entry.schemaVersion === "startup_opportunity.report_consistency_evaluation.v2",
  );
  const context = reportContext;
  const reportHash = report === undefined ? null : canonicalContentHash(report.document);
  const decisiveSupportingRefs = records(context?.decisive_support).flatMap((entry) =>
    strings(entry.refs),
  );
  const decisiveOpposingRefs = records(context?.decisive_opposition).flatMap((entry) =>
    strings(entry.refs),
  );
  const briefMismatch =
    brief !== undefined &&
    (brief.document.report_ref !== report?.path ||
      brief.document.report_content_hash !== reportHash ||
      brief.document.decision_recommendation_ref !== recommendation?.path ||
      brief.document.decision_question !== context?.decision_question ||
      brief.document.decision_tier !== context?.decision_tier ||
      brief.document.current_recommendation !== context?.current_recommendation ||
      brief.document.recommendation_meaning !== context?.recommendation_meaning ||
      brief.document.recommended_first_bet !== context?.recommended_first_bet ||
      !same(brief.document.alternative_bets, context?.alternative_bets) ||
      brief.document.partial_order_summary !== context?.partial_order_summary ||
      !setEqual(strings(brief.document.decisive_supporting_refs), decisiveSupportingRefs) ||
      !setEqual(strings(brief.document.decisive_opposing_refs), decisiveOpposingRefs) ||
      !same(brief.document.critical_unknowns, context?.critical_unknowns) ||
      !same(
        brief.document.what_would_change_the_decision,
        context?.what_would_change_the_decision,
      ) ||
      !same(brief.document.belief_update_summary, context?.belief_update_summary) ||
      brief.document.valid_as_of !== context?.valid_as_of ||
      brief.document.scope_summary !== context?.scope_summary ||
      !same(brief.document.limitations, context?.limitations) ||
      !same(brief.document.external_action_boundary, context?.external_action_boundary) ||
      brief.document.markdown_content_hash !== sha256Bytes(String(brief.document.markdown)));
  const viewMismatch =
    view !== undefined &&
    (view.document.report_ref !== report?.path ||
      view.document.report_content_hash !== reportHash ||
      view.document.decision_recommendation_ref !== recommendation?.path ||
      view.document.decision_tier !== context?.decision_tier ||
      view.document.recommendation_meaning !== context?.recommendation_meaning ||
      view.document.recommended_first_bet !== context?.recommended_first_bet ||
      !same(view.document.alternative_bets, context?.alternative_bets) ||
      view.document.partial_order_summary !== context?.partial_order_summary ||
      !setEqual(strings(view.document.decisive_supporting_refs), decisiveSupportingRefs) ||
      !setEqual(strings(view.document.decisive_opposing_refs), decisiveOpposingRefs) ||
      view.document.valid_as_of !== context?.valid_as_of ||
      !same(view.document.limitations, context?.limitations) ||
      !same(view.document.external_action_boundary, context?.external_action_boundary) ||
      view.document.markdown_content_hash !== sha256Bytes(String(view.document.markdown)));
  if (
    briefMismatch ||
    viewMismatch ||
    (consistency !== undefined &&
      (consistency.document.report_ref !== report?.path ||
        consistency.document.decision_brief_ref !== brief?.path ||
        consistency.document.report_view_ref !== view?.path ||
        consistency.document.decision_recommendation_ref !== recommendation?.path ||
        consistency.document.traceability_ref !== traceability?.path ||
        !setEqual(
          strings(consistency.document.checked_dimensions),
          strings(policy.reporting_contract.consistency_dimensions),
        ) ||
        consistency.document.evaluator_result !== "passed" ||
        strings(consistency.document.forbidden_expression_matches).length > 0))
  ) {
    errors.push(
      issue(
        "g2_4.report_consistency_mismatch",
        consistency?.path ?? brief?.path ?? view?.path ?? report?.path ?? "artifacts/reporting",
        "report consistency sidecar must close over the exact validated discovery views",
      ),
    );
  }

  if (fanIns.length > 1) {
    for (const fanIn of fanIns) {
      const revision = Number(fanIn.document.revision);
      const parent = target(byPath, fanIn.document.parent_fan_in_ref);
      if (
        (revision === 1 &&
          (fanIn.document.parent_fan_in_ref !== null ||
            fanIn.document.parent_content_hash !== null)) ||
        (revision > 1 &&
          (parent?.schemaVersion !== "startup_opportunity.enrichment_fan_in.v1" ||
            parent.document.revision !== revision - 1 ||
            fanIn.document.parent_content_hash !== canonicalContentHash(parent.document)))
      ) {
        errors.push(
          issue(
            "g2_4.fan_in_revision_mismatch",
            fanIn.path,
            "fan-in revision must preserve immutable parent path and hash lineage",
          ),
        );
      }
    }
  }
}

export function isDiscoveryEvaluationSchemaVersion(schemaVersion: string): boolean {
  return EVALUATION_SCHEMA_VERSIONS.has(schemaVersion);
}

export function validateDiscoveryEvaluationContract(
  documents: readonly DiscoveryEvaluationDocument[],
  policy: DiscoveryEvaluationPolicy,
  exactJsonlRecords: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): readonly ValidationIssue[] {
  const entries = documents.filter((entry) => EVALUATION_SCHEMA_VERSIONS.has(entry.schemaVersion));
  if (entries.length === 0) {
    return [];
  }
  const errors: ValidationIssue[] = [];
  const byPath = new Map(documents.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    validateEnvelope(entry, errors);
  }
  validateTaskAndMaterial(entries, byPath, exactJsonlRecords, errors);
  validateBranchesAndFanIn(entries, byPath, policy, errors);
  validateEvaluationAndReporting(entries, byPath, policy, errors);
  return sortIssues(errors);
}

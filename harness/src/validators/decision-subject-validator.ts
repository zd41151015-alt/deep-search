import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import { sortIssues, type ValidationIssue } from "./schema-bundle.js";

export interface DecisionSubjectDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

const SNAPSHOT_SCHEMA = "startup_opportunity.decision_subject_snapshot.current";

const SUBJECT_SCHEMA_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  discovery_candidate: ["startup_opportunity.discovery_candidate.v1"],
  opportunity_thesis: ["startup_opportunity.opportunity_thesis.v1"],
  concept_hypothesis: [
    "startup_opportunity.concept_hypothesis.assessment.current",
    "startup_opportunity.concept_hypothesis.assessment_intake.current",
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    keyword: "decision_subject",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function targetHash(target: DecisionSubjectDocument): string {
  return typeof target.envelope?.content_hash === "string"
    ? target.envelope.content_hash
    : canonicalContentHash(target.document);
}

function revisionPath(revision: unknown): string {
  return `artifacts/reporting/decision-subject-snapshot.r${String(revision)}.json`;
}

function ancestorSnapshots(
  snapshot: DecisionSubjectDocument,
  byPath: ReadonlyMap<string, DecisionSubjectDocument>,
): readonly DecisionSubjectDocument[] {
  const ancestors: DecisionSubjectDocument[] = [];
  const visited = new Set<string>();
  let parentRef = snapshot.document.parent_snapshot_ref;
  while (typeof parentRef === "string" && !visited.has(parentRef)) {
    visited.add(parentRef);
    const parent = byPath.get(parentRef);
    if (parent?.schemaVersion !== SNAPSHOT_SCHEMA) break;
    ancestors.push(parent);
    parentRef = parent.document.parent_snapshot_ref;
  }
  return ancestors;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function joined(value: unknown): string | undefined {
  const values = strings(value);
  return values.length === 0 ? undefined : values.join(" | ");
}

function directionSubjectProjection(
  target: DecisionSubjectDocument,
  byPath: ReadonlyMap<string, DecisionSubjectDocument>,
): Readonly<Record<string, string>> {
  const document = target.document;
  if (
    target.schemaVersion === "startup_opportunity.concept_hypothesis.assessment.current" ||
    target.schemaVersion === "startup_opportunity.concept_hypothesis.assessment_intake.current"
  ) {
    return Object.fromEntries(
      [
        ["label", document.product_thesis],
        ["target_user", joined(document.target_user)],
        ["narrow_scenario", document.entry_scene],
        ["problem", document.product_thesis],
        ["current_alternative", joined(document.current_alternative)],
        ["payer", joined(document.buyer)],
        ["product_form", document.delivery_form],
        ["core_value", document.claimed_value],
      ].filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  if (target.schemaVersion === "startup_opportunity.opportunity_thesis.v1") {
    return Object.fromEntries(
      [
        ["label", document.title],
        ["target_user", document.beachhead_segment],
        ["narrow_scenario", document.entry_scene],
        ["problem", document.job_to_be_done],
        ["current_alternative", document.description],
        ["payer", joined(document.payer)],
        ["product_form", document.selected_delivery_form],
        ["core_value", document.incremental_value_over_baseline],
        ["why_now", document.why_now],
      ].filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  if (target.schemaVersion !== "startup_opportunity.discovery_candidate.v1") return {};
  const subject = isRecord(document.subject) ? document.subject : {};
  const demandRef =
    typeof subject.demand_candidate_ref === "string" ? subject.demand_candidate_ref : undefined;
  const demand = demandRef === undefined ? undefined : byPath.get(demandRef);
  const demandSubject = isRecord(demand?.document.subject) ? demand.document.subject : {};
  if (document.candidate_kind === "demand_seed") {
    return Object.fromEntries(
      [
        ["label", document.candidate_id],
        ["target_user", joined(subject.user_hypotheses)],
        ["narrow_scenario", subject.entry_scene],
        ["problem", subject.job_to_be_done],
        ["current_alternative", joined(subject.current_alternatives)],
        ["payer", joined(subject.buyer_hypotheses)],
        ["product_form", "unformed"],
        ["core_value", subject.desired_outcome],
      ].filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  if (document.candidate_kind === "baseline_seed") {
    return Object.fromEntries(
      [
        ["label", subject.current_workflow],
        ["target_user", joined(demandSubject.user_hypotheses)],
        ["narrow_scenario", demandSubject.entry_scene ?? subject.current_workflow],
        ["problem", subject.current_cost_or_burden],
        ["current_alternative", subject.current_workflow],
        ["payer", joined(demandSubject.buyer_hypotheses)],
        ["product_form", "status_quo"],
        ["core_value", subject.minimum_incremental_value_required],
      ].filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  const baselineRef =
    typeof subject.baseline_candidate_ref === "string" ? subject.baseline_candidate_ref : undefined;
  const baseline = baselineRef === undefined ? undefined : byPath.get(baselineRef);
  const baselineSubject = isRecord(baseline?.document.subject) ? baseline.document.subject : {};
  return Object.fromEntries(
    [
      ["label", subject.solution_class],
      ["target_user", joined(demandSubject.user_hypotheses)],
      ["narrow_scenario", demandSubject.entry_scene],
      ["problem", demandSubject.job_to_be_done],
      ["current_alternative", baselineSubject.current_workflow],
      ["payer", joined(demandSubject.buyer_hypotheses)],
      ["product_form", joined(subject.delivery_forms)],
      ["core_value", subject.incremental_value_hypothesis],
    ].filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function validateSnapshot(
  snapshot: DecisionSubjectDocument,
  byPath: ReadonlyMap<string, DecisionSubjectDocument>,
  manifest: DecisionSubjectDocument | undefined,
  errors: ValidationIssue[],
): void {
  const document = snapshot.document;
  const revision = Number(document.revision);
  if (snapshot.path !== revisionPath(revision)) {
    errors.push(
      issue(
        "decision_subject.path_revision_mismatch",
        snapshot.path,
        "decision subject snapshot path must bind its immutable revision",
        { expected: revisionPath(revision) },
      ),
    );
  }
  if (
    snapshot.envelope !== null &&
    (snapshot.envelope.artifact_type !== SNAPSHOT_SCHEMA ||
      snapshot.envelope.artifact_path !== snapshot.path ||
      snapshot.envelope.run_id !== document.run_id ||
      snapshot.envelope.producer_role !== "main_agent" ||
      snapshot.envelope.content_hash !== canonicalContentHash(document))
  ) {
    errors.push(
      issue(
        "decision_subject.envelope_binding_mismatch",
        snapshot.path,
        "decision subject snapshot requires exact main-agent envelope, Run, path, and content hash binding",
        {
          envelopeArtifactType: snapshot.envelope.artifact_type,
          envelopeArtifactPath: snapshot.envelope.artifact_path,
          envelopeRunId: snapshot.envelope.run_id,
          documentRunId: document.run_id,
          producerRole: snapshot.envelope.producer_role,
          envelopeContentHash: snapshot.envelope.content_hash,
          expectedContentHash: canonicalContentHash(document),
        },
      ),
    );
  }
  if (revision > 1) {
    const parent =
      typeof document.parent_snapshot_ref === "string"
        ? byPath.get(document.parent_snapshot_ref)
        : undefined;
    if (
      parent?.schemaVersion !== SNAPSHOT_SCHEMA ||
      parent.document.revision !== revision - 1 ||
      parent.document.snapshot_id !== document.snapshot_id ||
      parent.document.run_id !== document.run_id ||
      document.parent_snapshot_hash !== targetHash(parent)
    ) {
      errors.push(
        issue(
          "decision_subject.parent_binding_mismatch",
          `${snapshot.path}#/parent_snapshot_ref`,
          "snapshot parent must be the exact previous immutable revision of the same current-Run snapshot",
        ),
      );
    }
  }

  const scope =
    typeof document.scope_frame_ref === "string" ? byPath.get(document.scope_frame_ref) : undefined;
  const plan =
    typeof document.research_plan_ref === "string"
      ? byPath.get(document.research_plan_ref)
      : undefined;
  const expectedScopeSchema =
    document.mode === "opportunity_discovery"
      ? "startup_opportunity.scope_frame.discovery.current"
      : "startup_opportunity.scope_frame.assessment.current";
  if (
    manifest?.schemaVersion !== "startup_opportunity.run_manifest.v1" ||
    manifest.document.run_id !== document.run_id ||
    manifest.document.mode !== document.mode ||
    scope?.schemaVersion !== expectedScopeSchema ||
    scope.document.run_id !== document.run_id ||
    document.scope_frame_hash !== targetHash(scope) ||
    plan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
    plan.document.run_id !== document.run_id ||
    document.research_plan_hash !== targetHash(plan)
  ) {
    errors.push(
      issue(
        "decision_subject.current_run_binding_mismatch",
        snapshot.path,
        "snapshot must bind exact same-Run Scope and Plan content hashes",
      ),
    );
  }

  const inputBindings = records(document.synthesis_input_hashes);
  const inputRefs = inputBindings.map((binding) => String(binding.ref));
  if (new Set(inputRefs).size !== inputRefs.length) {
    errors.push(
      issue(
        "decision_subject.synthesis_input_duplicate",
        `${snapshot.path}#/synthesis_input_hashes`,
        "snapshot synthesis inputs must have unique exact refs",
      ),
    );
  }
  for (const [index, binding] of inputBindings.entries()) {
    const target = typeof binding.ref === "string" ? byPath.get(binding.ref) : undefined;
    if (
      target === undefined ||
      target.document.run_id !== document.run_id ||
      binding.content_hash !== targetHash(target)
    ) {
      errors.push(
        issue(
          "decision_subject.synthesis_input_binding_mismatch",
          `${snapshot.path}#/synthesis_input_hashes/${index}`,
          "each synthesis input must resolve to an exact same-Run ref and content hash",
        ),
      );
    }
  }

  const subjects = records(document.subjects);
  const subjectIds = subjects.map((subject) => String(subject.subject_id));
  const subjectRefs = subjects.map((subject) => String(subject.subject_ref));
  if (
    new Set(subjectIds).size !== subjectIds.length ||
    new Set(subjectRefs).size !== subjectRefs.length
  ) {
    errors.push(
      issue(
        "decision_subject.identity_duplicate",
        `${snapshot.path}#/subjects`,
        "snapshot subject ids and refs must each be unique",
      ),
    );
  }
  const currentFinalIds = new Set(
    subjects
      .filter(
        (subject) => subject.lifecycle_status === "current" && subject.reporting_role === "final",
      )
      .map((subject) => String(subject.subject_id)),
  );
  if (currentFinalIds.size > 0 && inputBindings.length === 0) {
    errors.push(
      issue(
        "decision_subject.synthesis_input_required",
        `${snapshot.path}#/synthesis_input_hashes`,
        "a non-empty current final subject set must bind at least one exact same-Run synthesis input",
      ),
    );
  }
  for (const [index, subject] of subjects.entries()) {
    const target =
      typeof subject.subject_ref === "string" ? byPath.get(subject.subject_ref) : undefined;
    const expectedSchemas = SUBJECT_SCHEMA_BY_KIND[String(subject.subject_kind)] ?? [];
    if (
      target === undefined ||
      !expectedSchemas.includes(target.schemaVersion) ||
      target.document.run_id !== document.run_id ||
      subject.subject_content_hash !== targetHash(target)
    ) {
      errors.push(
        issue(
          "decision_subject.subject_binding_mismatch",
          `${snapshot.path}#/subjects/${index}`,
          "each decision subject must bind an exact typed same-Run formal artifact and content hash",
          { subjectId: subject.subject_id, subjectRef: subject.subject_ref },
        ),
      );
    }
    const expectedSubjectId =
      subject.subject_kind === "discovery_candidate"
        ? target?.document.candidate_id
        : subject.subject_kind === "opportunity_thesis"
          ? target?.document.opportunity_id
          : target?.document.concept_hypothesis_id;
    if (subject.subject_id !== expectedSubjectId) {
      errors.push(
        issue(
          "decision_subject.subject_identity_mismatch",
          `${snapshot.path}#/subjects/${index}/subject_id`,
          "snapshot subject identity must equal the bound Candidate, Opportunity Thesis, or Concept business identity",
          { subjectId: subject.subject_id, expectedSubjectId },
        ),
      );
    }
    const reformationBindings = records(subject.reformation_basis_hashes);
    for (const [bindingIndex, binding] of reformationBindings.entries()) {
      const basis = typeof binding.ref === "string" ? byPath.get(binding.ref) : undefined;
      if (
        basis === undefined ||
        basis.document.run_id !== document.run_id ||
        binding.content_hash !== targetHash(basis)
      ) {
        errors.push(
          issue(
            "decision_subject.reformation_basis_binding_mismatch",
            `${snapshot.path}#/subjects/${index}/reformation_basis_hashes/${bindingIndex}`,
            "subject re-formation basis must bind an exact same-Run formal input",
          ),
        );
      }
    }
    if (
      subject.lifecycle_status === "superseded" &&
      !currentFinalIds.has(String(subject.superseded_by_subject_id))
    ) {
      errors.push(
        issue(
          "decision_subject.supersession_target_invalid",
          `${snapshot.path}#/subjects/${index}/superseded_by_subject_id`,
          "a superseded subject must point to a current final subject in the same snapshot",
        ),
      );
    }
    if (subject.lifecycle_status === "current" && subject.subject_kind === "discovery_candidate") {
      const formation = isRecord(target?.document.formation) ? target.document.formation : {};
      if (
        target?.document.research_plan_ref !== document.research_plan_ref ||
        formation.research_plan_hash !== document.research_plan_hash ||
        target?.document.scope_frame_ref !== document.scope_frame_ref ||
        formation.scope_frame_hash !== document.scope_frame_hash
      ) {
        errors.push(
          issue(
            "decision_subject.current_candidate_formation_stale",
            `${snapshot.path}#/subjects/${index}`,
            "a current final Candidate must have formed against the snapshot Scope and current Plan",
          ),
        );
      }
    }
  }

  const historicalSubjects = ancestorSnapshots(snapshot, byPath).flatMap((ancestor) =>
    records(ancestor.document.subjects),
  );
  for (const [index, subject] of subjects.entries()) {
    if (subject.lifecycle_status !== "current") continue;
    const historicalTerminal = historicalSubjects.filter(
      (candidate) =>
        candidate.subject_id === subject.subject_id &&
        candidate.subject_kind === subject.subject_kind &&
        ["dropped", "superseded"].includes(String(candidate.lifecycle_status)),
    );
    if (historicalTerminal.length === 0) continue;
    if (
      historicalTerminal.some(
        (candidate) =>
          candidate.subject_ref === subject.subject_ref &&
          candidate.subject_content_hash === subject.subject_content_hash,
      )
    ) {
      errors.push(
        issue(
          "decision_subject.terminal_lifecycle_revival",
          `${snapshot.path}#/subjects/${index}`,
          "a dropped or superseded exact subject artifact cannot silently return to the current decision set",
          { subjectId: subject.subject_id },
        ),
      );
      continue;
    }
    if (
      historicalTerminal.some((candidate) => candidate.subject_ref === subject.subject_ref) ||
      records(subject.reformation_basis_hashes).length === 0
    ) {
      errors.push(
        issue(
          "decision_subject.reformation_basis_required",
          `${snapshot.path}#/subjects/${index}/reformation_basis_hashes`,
          "reconsidering a terminal subject identity requires a new immutable artifact ref and exact same-Run re-formation basis",
          { subjectId: subject.subject_id },
        ),
      );
    }
  }
}

export function validateDecisionSubjectContract(
  documents: readonly DecisionSubjectDocument[],
): readonly ValidationIssue[] {
  const snapshots = documents.filter((entry) => entry.schemaVersion === SNAPSHOT_SCHEMA);
  const terminalSources = documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.terminal_report_source.v1",
  );
  if (snapshots.length === 0 && terminalSources.length === 0) return [];

  const errors: ValidationIssue[] = [];
  const byPath = new Map(documents.map((entry) => [entry.path, entry]));
  const manifest = documents.find(
    (entry) => entry.schemaVersion === "startup_opportunity.run_manifest.v1",
  );
  for (const snapshot of snapshots) validateSnapshot(snapshot, byPath, manifest, errors);

  if (manifest !== undefined && manifest.document.current_decision_subject_snapshot_ref !== null) {
    const current = byPath.get(String(manifest.document.current_decision_subject_snapshot_ref));
    if (
      current?.schemaVersion !== SNAPSHOT_SCHEMA ||
      manifest.document.current_decision_subject_snapshot_hash !== targetHash(current)
    ) {
      errors.push(
        issue(
          "decision_subject.manifest_binding_mismatch",
          "manifest.json#/current_decision_subject_snapshot_ref",
          "Manifest current decision subject ref/hash must resolve exactly",
        ),
      );
    }
  }

  for (const source of terminalSources) {
    const snapshot =
      typeof source.document.decision_subject_snapshot_ref === "string"
        ? byPath.get(source.document.decision_subject_snapshot_ref)
        : undefined;
    const currentIds = records(snapshot?.document.subjects)
      .filter(
        (subject) => subject.lifecycle_status === "current" && subject.reporting_role === "final",
      )
      .map((subject) => String(subject.subject_id))
      .sort();
    const reportIds = Array.isArray(source.document.current_decision_subject_ids)
      ? source.document.current_decision_subject_ids
          .filter((value): value is string => typeof value === "string")
          .toSorted()
      : [];
    const directionIds = records(source.document.directions)
      .map((direction) => String(direction.direction_id))
      .sort();
    const currentPlan =
      typeof manifest?.document.current_plan_ref === "string"
        ? byPath.get(manifest.document.current_plan_ref)
        : undefined;
    const currentSubjects = records(snapshot?.document.subjects).filter(
      (subject) => subject.lifecycle_status === "current" && subject.reporting_role === "final",
    );
    for (const [index, direction] of records(source.document.directions).entries()) {
      const subject = currentSubjects.find(
        (candidate) => candidate.subject_id === direction.direction_id,
      );
      const target =
        typeof subject?.subject_ref === "string" ? byPath.get(subject.subject_ref) : undefined;
      if (
        subject === undefined ||
        target === undefined ||
        direction.subject_ref !== subject.subject_ref ||
        direction.subject_content_hash !== subject.subject_content_hash
      ) {
        errors.push(
          issue(
            "decision_subject.direction_subject_binding_mismatch",
            `${source.path}#/directions/${index}`,
            "each report Direction must bind the exact authoritative current subject ref and content hash",
          ),
        );
        continue;
      }
      for (const [basisIndex, binding] of records(direction.synthesis_basis_hashes).entries()) {
        const basis = typeof binding.ref === "string" ? byPath.get(binding.ref) : undefined;
        if (
          basis === undefined ||
          basis.document.run_id !== source.document.run_id ||
          binding.content_hash !== targetHash(basis)
        ) {
          errors.push(
            issue(
              "decision_subject.direction_basis_binding_mismatch",
              `${source.path}#/directions/${index}/synthesis_basis_hashes/${basisIndex}`,
              "Direction synthesis basis must bind exact same-Run current subject or Evidence inputs",
            ),
          );
        }
      }
      if (records(direction.synthesis_basis_hashes).length === 0) {
        errors.push(
          issue(
            "decision_subject.direction_basis_required",
            `${source.path}#/directions/${index}/synthesis_basis_hashes`,
            "Direction judgment fields require at least one exact same-Run subject or Evidence basis",
          ),
        );
      }
      const expectedProjection = directionSubjectProjection(target, byPath);
      const mismatchedFields = Object.entries(expectedProjection)
        .filter(([field, expected]) => direction[field] !== expected)
        .map(([field]) => field)
        .sort();
      if (mismatchedFields.length > 0) {
        errors.push(
          issue(
            "decision_subject.direction_body_mismatch",
            `${source.path}#/directions/${index}`,
            "Direction identity fields must be the deterministic projection of its bound authoritative subject",
            { directionId: direction.direction_id, mismatchedFields },
          ),
        );
      }
    }
    if (
      snapshot?.schemaVersion !== SNAPSHOT_SCHEMA ||
      source.document.run_id !== snapshot.document.run_id ||
      source.document.mode !== snapshot.document.mode ||
      source.document.decision_subject_snapshot_hash !== targetHash(snapshot) ||
      manifest?.document.current_decision_subject_snapshot_ref !== snapshot.path ||
      manifest.document.current_decision_subject_snapshot_hash !== targetHash(snapshot) ||
      snapshot.document.research_plan_ref !== manifest.document.current_plan_ref ||
      currentPlan?.schemaVersion !== "startup_opportunity.research_plan.v1" ||
      snapshot.document.research_plan_hash !== targetHash(currentPlan) ||
      canonicalJson(reportIds) !== canonicalJson(currentIds) ||
      canonicalJson(directionIds) !== canonicalJson(currentIds)
    ) {
      errors.push(
        issue(
          "decision_subject.terminal_projection_mismatch",
          source.path,
          "terminal report must bind the Manifest-authoritative snapshot and project exactly its current final subjects as directions",
          { currentIds, reportIds, directionIds },
        ),
      );
    }
  }
  return sortIssues(errors);
}

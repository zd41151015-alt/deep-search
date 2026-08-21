import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import {
  type DecisionSubjectKind,
  subjectRevisionDescriptor,
  subjectSchemaAllowed,
} from "../reporting/decision-subject-reformation.js";
import { sortIssues, type ValidationIssue } from "./schema-bundle.js";

export interface DecisionSubjectDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

const SNAPSHOT_SCHEMA = "startup_opportunity.decision_subject_snapshot.current";
const SYNTHESIS_SCHEMA = "startup_opportunity.decision_subject_synthesis.current";

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

interface ArtifactPublicationRecord {
  readonly publicationOrdinal: number;
  readonly contentHash: string;
}

function isDecisionSubjectKind(value: unknown): value is DecisionSubjectKind {
  return ["discovery_candidate", "opportunity_thesis", "concept_hypothesis"].includes(
    String(value),
  );
}

function validateReformation(
  snapshot: DecisionSubjectDocument,
  subject: Record<string, unknown>,
  subjectIndex: number,
  terminalSnapshots: readonly DecisionSubjectDocument[],
  byPath: ReadonlyMap<string, DecisionSubjectDocument>,
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
  artifactPublicationRecords: ReadonlyMap<string, ArtifactPublicationRecord>,
  errors: ValidationIssue[],
): void {
  const terminalOccurrences = terminalSnapshots.flatMap((terminalSnapshot) =>
    records(terminalSnapshot.document.subjects)
      .filter(
        (candidate) =>
          candidate.subject_id === subject.subject_id &&
          candidate.subject_kind === subject.subject_kind &&
          ["dropped", "superseded"].includes(String(candidate.lifecycle_status)),
      )
      .map((candidate) => ({ terminalSnapshot, candidate })),
  );
  const decisionRef = subject.reformation_decision_ref;
  if (terminalOccurrences.length === 0) {
    if (typeof decisionRef === "string") {
      errors.push(
        issue(
          "decision_subject.reformation_decision_unexpected",
          `${snapshot.path}#/subjects/${subjectIndex}/reformation_decision_ref`,
          "a reformation Decision is allowed only when reconsidering a terminal subject identity",
        ),
      );
    }
    return;
  }
  if (
    terminalOccurrences.some(
      ({ candidate }) =>
        candidate.subject_ref === subject.subject_ref &&
        candidate.subject_content_hash === subject.subject_content_hash,
    )
  ) {
    errors.push(
      issue(
        "decision_subject.terminal_lifecycle_revival",
        `${snapshot.path}#/subjects/${subjectIndex}`,
        "a dropped or superseded exact subject artifact cannot return to the current decision set",
        { subjectId: subject.subject_id },
      ),
    );
    return;
  }
  if (typeof decisionRef !== "string") {
    errors.push(
      issue(
        "decision_subject.reformation_decision_required",
        `${snapshot.path}#/subjects/${subjectIndex}/reformation_decision_ref`,
        "reconsidering a terminal subject identity requires an exact Store-authored reformation Decision",
        { subjectId: subject.subject_id },
      ),
    );
    return;
  }
  const decision = exactRecords.get(decisionRef);
  const terminalSnapshot =
    typeof decision?.terminal_snapshot_ref === "string"
      ? byPath.get(decision.terminal_snapshot_ref)
      : undefined;
  const terminal = terminalOccurrences.find(
    (occurrence) => occurrence.terminalSnapshot.path === terminalSnapshot?.path,
  );
  const reformed =
    typeof subject.subject_ref === "string" ? byPath.get(subject.subject_ref) : undefined;
  if (
    decision?.decision_type !== "subject_reformed" ||
    decision.actor !== "main_agent" ||
    decision.run_id !== snapshot.document.run_id ||
    terminalSnapshot === undefined ||
    decision.terminal_snapshot_hash !== targetHash(terminalSnapshot) ||
    decision.reformation_subject_kind !== subject.subject_kind ||
    terminal === undefined ||
    decision.terminal_subject_id !== terminal.candidate.subject_id ||
    decision.terminal_subject_ref !== terminal.candidate.subject_ref ||
    decision.terminal_subject_content_hash !== terminal.candidate.subject_content_hash ||
    decision.reformed_subject_ref !== subject.subject_ref ||
    decision.reformed_subject_content_hash !== subject.subject_content_hash
  ) {
    errors.push(
      issue(
        "decision_subject.reformation_decision_binding_mismatch",
        `${snapshot.path}#/subjects/${subjectIndex}/reformation_decision_ref`,
        "reformation Decision must exactly bind an ancestor terminal snapshot/subject and the new immutable subject revision",
      ),
    );
    return;
  }
  const subjectKind = terminal.candidate.subject_kind;
  const terminalArtifact =
    typeof terminal.candidate.subject_ref === "string"
      ? byPath.get(terminal.candidate.subject_ref)
      : undefined;
  if (
    !isDecisionSubjectKind(subjectKind) ||
    terminalArtifact === undefined ||
    reformed === undefined ||
    !subjectSchemaAllowed(subjectKind, terminalArtifact.schemaVersion) ||
    !subjectSchemaAllowed(subjectKind, reformed.schemaVersion)
  ) {
    errors.push(
      issue(
        "decision_subject.reformation_subject_kind_unsupported",
        `${snapshot.path}#/subjects/${subjectIndex}`,
        "reformation requires a supported subject kind with mechanically verifiable immutable revision and formation closure",
      ),
    );
    return;
  }
  const terminalRevision = subjectRevisionDescriptor(subjectKind, terminalArtifact.document);
  const reformedRevision = subjectRevisionDescriptor(subjectKind, reformed.document);
  if (
    reformed.path === terminalArtifact.path ||
    reformedRevision.parentRef !== terminalArtifact.path ||
    reformedRevision.parentContentHash !== targetHash(terminalArtifact) ||
    reformedRevision.subjectId !== terminalRevision.subjectId ||
    reformedRevision.subjectId !== subject.subject_id ||
    reformedRevision.revision !== terminalRevision.revision + 1 ||
    (reformedRevision.expectedPath !== null && reformed.path !== reformedRevision.expectedPath)
  ) {
    errors.push(
      issue(
        "decision_subject.reformation_revision_lineage_mismatch",
        `${snapshot.path}#/subjects/${subjectIndex}`,
        "reformed subject must be the direct next immutable revision of the exact terminal subject kind and identity",
      ),
    );
  }
  if (canonicalJson(reformedRevision.semantics) === canonicalJson(terminalRevision.semantics)) {
    errors.push(
      issue(
        "decision_subject.reformation_semantics_unchanged",
        `${snapshot.path}#/subjects/${subjectIndex}`,
        "reformation must materially change subject business semantics, not only path or revision metadata",
      ),
    );
  }
  const terminalPublication = artifactPublicationRecords.get(terminalSnapshot.path);
  const reformedPublication = artifactPublicationRecords.get(reformed.path);
  const inputs = records(decision.reformation_input_hashes);
  if (
    inputs.length === 0 ||
    terminalPublication === undefined ||
    terminalPublication.contentHash !== targetHash(terminalSnapshot) ||
    decision.terminal_snapshot_publication_ordinal !== terminalPublication.publicationOrdinal ||
    reformedPublication === undefined ||
    reformedPublication.contentHash !== targetHash(reformed) ||
    decision.reformed_subject_publication_ordinal !== reformedPublication.publicationOrdinal ||
    reformedPublication.publicationOrdinal <= terminalPublication.publicationOrdinal
  ) {
    errors.push(
      issue(
        "decision_subject.reformation_publication_order_invalid",
        `${snapshot.path}#/subjects/${subjectIndex}/reformation_decision_ref`,
        "reformation requires exact Store-owned publication records ordered terminal snapshot before causal inputs before new subject",
      ),
    );
  }
  for (const [inputIndex, binding] of inputs.entries()) {
    const ref = typeof binding.ref === "string" ? binding.ref : "";
    const input = byPath.get(ref);
    const inputPublication = artifactPublicationRecords.get(ref);
    if (
      input === undefined ||
      input.document.run_id !== snapshot.document.run_id ||
      binding.content_hash !== targetHash(input) ||
      [snapshot.path, terminalSnapshot.path, terminalArtifact?.path, reformed.path].includes(ref) ||
      !reformedRevision.closureRefs.has(ref) ||
      terminalRevision.closureRefs.has(ref)
    ) {
      errors.push(
        issue(
          "decision_subject.reformation_input_unrelated",
          `${snapshot.path}#/subjects/${subjectIndex}/reformation_decision_ref`,
          "each reformation input must be a newly added exact same-Run artifact in the new subject's kind-specific formation or synthesis closure",
          { inputIndex, ref },
        ),
      );
    }
    if (
      terminalPublication === undefined ||
      reformedPublication === undefined ||
      input === undefined ||
      inputPublication === undefined ||
      inputPublication.contentHash !== targetHash(input) ||
      binding.publication_ordinal !== inputPublication.publicationOrdinal ||
      inputPublication.publicationOrdinal <= terminalPublication.publicationOrdinal ||
      inputPublication.publicationOrdinal >= reformedPublication.publicationOrdinal
    ) {
      errors.push(
        issue(
          "decision_subject.reformation_input_not_post_terminal",
          `${snapshot.path}#/subjects/${subjectIndex}/reformation_decision_ref`,
          "Store-owned publication order must place each causal input after the terminal snapshot and before the new subject",
          { inputIndex, ref },
        ),
      );
    }
  }
}

function projectedDirection(synthesis: DecisionSubjectDocument): Record<string, unknown> {
  return {
    direction_id: synthesis.document.subject_id,
    subject_ref: synthesis.document.subject_ref,
    subject_content_hash: synthesis.document.subject_content_hash,
    synthesis_ref: synthesis.path,
    synthesis_content_hash: targetHash(synthesis),
    ...structuredClone(isRecord(synthesis.document.direction) ? synthesis.document.direction : {}),
  };
}

function projectedValidationSteps(
  synthesis: DecisionSubjectDocument,
  startOrder: number,
): readonly Record<string, unknown>[] {
  return [...records(synthesis.document.validation_steps)]
    .sort((left, right) => Number(left.order) - Number(right.order))
    .map((step, index) => ({
      direction_id: synthesis.document.subject_id,
      subject_ref: synthesis.document.subject_ref,
      subject_content_hash: synthesis.document.subject_content_hash,
      synthesis_ref: synthesis.path,
      synthesis_content_hash: targetHash(synthesis),
      ...structuredClone(step),
      order: startOrder + index,
    }));
}

function validateSynthesis(
  synthesis: DecisionSubjectDocument,
  byPath: ReadonlyMap<string, DecisionSubjectDocument>,
  errors: ValidationIssue[],
): void {
  const document = synthesis.document;
  const localOrders = records(document.validation_steps)
    .map((step) => Number(step.order))
    .sort((left, right) => left - right);
  if (
    new Set(localOrders).size !== localOrders.length ||
    localOrders.some((order, index) => order !== index + 1)
  ) {
    errors.push(
      issue(
        "decision_subject.synthesis_validation_order_invalid",
        `${synthesis.path}#/validation_steps`,
        "each subject synthesis must retain a unique local validation order from one",
      ),
    );
  }
  const subject =
    typeof document.subject_ref === "string" ? byPath.get(document.subject_ref) : undefined;
  if (
    synthesis.envelope === null ||
    synthesis.envelope.artifact_type !== SYNTHESIS_SCHEMA ||
    synthesis.envelope.artifact_path !== synthesis.path ||
    synthesis.envelope.run_id !== document.run_id ||
    synthesis.envelope.producer_role !== "main_agent" ||
    synthesis.envelope.content_hash !== canonicalContentHash(document)
  ) {
    errors.push(
      issue(
        "decision_subject.synthesis_envelope_mismatch",
        synthesis.path,
        "decision subject synthesis requires an exact immutable main-agent envelope",
      ),
    );
  }
  if (
    subject === undefined ||
    document.run_id !== subject.document.run_id ||
    document.subject_content_hash !== targetHash(subject) ||
    document.subject_id !==
      (subject.schemaVersion === "startup_opportunity.discovery_candidate.v1"
        ? subject.document.candidate_id
        : subject.schemaVersion === "startup_opportunity.opportunity_thesis.v1"
          ? subject.document.opportunity_id
          : subject.document.concept_hypothesis_id)
  ) {
    errors.push(
      issue(
        "decision_subject.synthesis_subject_binding_mismatch",
        synthesis.path,
        "decision subject synthesis must bind an exact same-Run subject ref and content hash",
      ),
    );
  }
  const basis = records(document.synthesis_basis_hashes);
  for (const [index, binding] of basis.entries()) {
    const target = typeof binding.ref === "string" ? byPath.get(binding.ref) : undefined;
    if (
      target === undefined ||
      target.document.run_id !== document.run_id ||
      binding.content_hash !== targetHash(target)
    ) {
      errors.push(
        issue(
          "decision_subject.synthesis_basis_binding_mismatch",
          `${synthesis.path}#/synthesis_basis_hashes/${index}`,
          "report synthesis basis must bind exact same-Run subject, Evidence, Comparison, or Audit inputs",
        ),
      );
    }
  }
  if (
    !basis.some(
      (binding) =>
        binding.ref === document.subject_ref &&
        binding.content_hash === document.subject_content_hash,
    )
  ) {
    errors.push(
      issue(
        "decision_subject.synthesis_subject_basis_required",
        `${synthesis.path}#/synthesis_basis_hashes`,
        "report synthesis must include its exact current subject as a basis",
      ),
    );
  }
  const subjectSummary =
    subject?.schemaVersion === "startup_opportunity.opportunity_thesis.v1" &&
    isRecord(subject.document.solution_evaluation_summary)
      ? subject.document.solution_evaluation_summary
      : null;
  const direction = isRecord(document.direction) ? document.direction : {};
  if (
    subjectSummary !== null
      ? !isRecord(direction.solution_evaluation_summary) ||
        canonicalJson(direction.solution_evaluation_summary) !== canonicalJson(subjectSummary)
      : direction.solution_evaluation_summary !== undefined
  ) {
    errors.push(
      issue(
        "decision_subject.solution_exploration_projection_mismatch",
        `${synthesis.path}#/direction/solution_evaluation_summary`,
        "an Opportunity synthesis must exactly project its Solution Evaluation summary, while other subject kinds must not carry one",
      ),
    );
  }
}

function validateSnapshot(
  snapshot: DecisionSubjectDocument,
  byPath: ReadonlyMap<string, DecisionSubjectDocument>,
  manifest: DecisionSubjectDocument | undefined,
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
  artifactPublicationRecords: ReadonlyMap<string, ArtifactPublicationRecord>,
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

  const terminalSnapshots = ancestorSnapshots(snapshot, byPath);
  for (const [index, subject] of subjects.entries()) {
    if (subject.lifecycle_status !== "current") continue;
    validateReformation(
      snapshot,
      subject,
      index,
      terminalSnapshots,
      byPath,
      exactRecords,
      artifactPublicationRecords,
      errors,
    );
  }
}

export function validateDecisionSubjectContract(
  documents: readonly DecisionSubjectDocument[],
  exactRecords: ReadonlyMap<string, Record<string, unknown>> = new Map(),
  artifactPublicationRecords: ReadonlyMap<string, ArtifactPublicationRecord> = new Map(),
): readonly ValidationIssue[] {
  const snapshots = documents.filter((entry) => entry.schemaVersion === SNAPSHOT_SCHEMA);
  const syntheses = documents.filter((entry) => entry.schemaVersion === SYNTHESIS_SCHEMA);
  const terminalSources = documents.filter(
    (entry) => entry.schemaVersion === "startup_opportunity.terminal_report_source.v1",
  );
  if (snapshots.length === 0 && syntheses.length === 0 && terminalSources.length === 0) return [];

  const errors: ValidationIssue[] = [];
  const byPath = new Map(documents.map((entry) => [entry.path, entry]));
  const manifest = documents.find(
    (entry) => entry.schemaVersion === "startup_opportunity.run_manifest.v1",
  );
  for (const snapshot of snapshots) {
    validateSnapshot(snapshot, byPath, manifest, exactRecords, artifactPublicationRecords, errors);
  }
  for (const synthesis of syntheses) validateSynthesis(synthesis, byPath, errors);

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
      .map((subject) => String(subject.subject_id));
    const reportIds = Array.isArray(source.document.current_decision_subject_ids)
      ? source.document.current_decision_subject_ids.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const directionIds = records(source.document.directions).map((direction) =>
      String(direction.direction_id),
    );
    const currentPlan =
      typeof manifest?.document.current_plan_ref === "string"
        ? byPath.get(manifest.document.current_plan_ref)
        : undefined;
    const currentSubjects = records(snapshot?.document.subjects).filter(
      (subject) => subject.lifecycle_status === "current" && subject.reporting_role === "final",
    );
    const synthesisBindings = records(source.document.decision_subject_synthesis_hashes);
    const boundSyntheses = synthesisBindings.flatMap((binding) => {
      const synthesis = typeof binding.ref === "string" ? byPath.get(binding.ref) : undefined;
      if (
        synthesis?.schemaVersion !== SYNTHESIS_SCHEMA ||
        binding.content_hash !== targetHash(synthesis)
      ) {
        errors.push(
          issue(
            "decision_subject.report_synthesis_binding_mismatch",
            `${source.path}#/decision_subject_synthesis_hashes`,
            "terminal report synthesis refs must resolve to exact immutable subject syntheses",
          ),
        );
        return [];
      }
      return [synthesis];
    });
    const synthesisBySubject = new Map(
      boundSyntheses.map((synthesis) => [String(synthesis.document.subject_id), synthesis]),
    );
    const orderedSyntheses = currentIds.flatMap((subjectId) => {
      const synthesis = synthesisBySubject.get(subjectId);
      return synthesis === undefined ? [] : [synthesis];
    });
    const expectedSynthesisIds = orderedSyntheses.map((synthesis) =>
      String(synthesis.document.subject_id),
    );
    for (const subject of currentSubjects) {
      const synthesis = boundSyntheses.find(
        (candidate) => candidate.document.subject_id === subject.subject_id,
      );
      if (
        synthesis === undefined ||
        synthesis.document.subject_ref !== subject.subject_ref ||
        synthesis.document.subject_content_hash !== subject.subject_content_hash
      ) {
        errors.push(
          issue(
            "decision_subject.current_subject_synthesis_missing",
            source.path,
            "every authoritative current final subject requires one exact report synthesis",
            { subjectId: subject.subject_id },
          ),
        );
      }
    }
    const expectedDirections = orderedSyntheses.map(projectedDirection);
    if (canonicalJson(records(source.document.directions)) !== canonicalJson(expectedDirections)) {
      errors.push(
        issue(
          "decision_subject.direction_body_mismatch",
          `${source.path}#/directions`,
          "every user-visible Direction field must exactly project its bound current-subject synthesis",
        ),
      );
    }
    let globalOrder = 1;
    const expectedValidationPlan = orderedSyntheses.flatMap((synthesis) => {
      const steps = projectedValidationSteps(synthesis, globalOrder);
      globalOrder += steps.length;
      return steps;
    });
    if (
      canonicalJson(records(source.document.ordered_validation_plan)) !==
      canonicalJson(expectedValidationPlan)
    ) {
      errors.push(
        issue(
          "decision_subject.validation_plan_subject_binding_mismatch",
          `${source.path}#/ordered_validation_plan`,
          "every user-visible validation step must exactly project a current-subject synthesis",
        ),
      );
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
      canonicalJson(directionIds) !== canonicalJson(currentIds) ||
      canonicalJson(expectedSynthesisIds) !== canonicalJson(currentIds)
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

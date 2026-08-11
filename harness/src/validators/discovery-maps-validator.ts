import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import { DISCOVERY_MAPS_POLICY_PATH } from "../current-policy-paths.js";
import type {
  DiscoveryMapsPolicy,
  DiscoveryProfile,
  LoadedDiscoveryMapsPolicy,
} from "./discovery-maps-policy.js";
import { sortIssues, type ValidationIssue } from "./schema-bundle.js";

export interface DiscoveryMapDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
}

const MAP_SCHEMA_VERSIONS = new Set([
  "startup_opportunity.seed_probe.v1",
  "startup_opportunity.opportunity_space_map.v1",
  "startup_opportunity.solution_space_map.v1",
]);

const DISCOVERY_PROFILES = new Set<DiscoveryProfile>([
  "general",
  "industry_first",
  "ai_first",
  "hybrid",
]);

const REQUIRED_QUESTION_KINDS = [
  "demand",
  "workflow",
  "alternative",
  "buyer",
  "counterfactual",
] as const;

const CANDIDATE_DELIVERY_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  platform_native: ["platform_native"],
  human_or_service_assisted: ["service_assisted"],
  native_app: ["native_app"],
  mini_program: ["mini_program"],
  mobile_web_or_pwa: ["mobile_web", "PWA"],
  hybrid_app: ["hybrid_app"],
  status_quo: ["status_quo"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "discovery_maps",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function one(
  documents: readonly DiscoveryMapDocument[],
  schemaVersion: string,
  errors: ValidationIssue[],
): DiscoveryMapDocument | null {
  const matches = documents.filter((entry) => entry.schemaVersion === schemaVersion);
  if (matches.length !== 1) {
    errors.push(
      issue(
        "discovery_maps.document_cardinality",
        "/documents",
        "G2.1 map validation requires exactly one document of each required type",
        { schemaVersion, actual: matches.length },
      ),
    );
  }
  return matches[0] ?? null;
}

function oneAtPath(
  documents: readonly DiscoveryMapDocument[],
  schemaVersion: string,
  artifactPath: string,
  errors: ValidationIssue[],
): DiscoveryMapDocument | null {
  const matches = documents.filter(
    (entry) => entry.schemaVersion === schemaVersion && entry.path === artifactPath,
  );
  if (matches.length !== 1) {
    errors.push(
      issue(
        "discovery_maps.document_cardinality",
        artifactPath,
        "G2.1 map validation requires exactly one current document at the Manifest-selected path",
        { schemaVersion, artifactPath, actual: matches.length },
      ),
    );
  }
  return matches[0] ?? null;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function planUnits(plan: Record<string, unknown>): readonly Record<string, unknown>[] {
  if (!Array.isArray(plan.waves)) {
    return [];
  }
  return plan.waves.flatMap((wave) =>
    isRecord(wave) && Array.isArray(wave.units)
      ? wave.units.filter((unit): unit is Record<string, unknown> => isRecord(unit))
      : [],
  );
}

function targetHash(target: DiscoveryMapDocument): string {
  const hash = target.envelope?.content_hash;
  return typeof hash === "string" ? hash : canonicalContentHash(target.document);
}

function validateExactRefs(
  actualValue: unknown,
  expected: readonly string[],
  instancePath: string,
  errors: ValidationIssue[],
  code = "discovery_maps.ref_set_mismatch",
): void {
  const actual = stringArray(actualValue);
  if (
    !unique(actual) ||
    canonicalJson([...actual].sort()) !== canonicalJson([...expected].sort())
  ) {
    errors.push(
      issue(code, instancePath, "reference set differs from the closed G2.1 contract", {
        actual: [...actual].sort(),
        expected: [...expected].sort(),
      }),
    );
  }
}

function validateInputHashes(
  source: DiscoveryMapDocument,
  expectedRefs: readonly string[],
  byPath: ReadonlyMap<string, DiscoveryMapDocument>,
  errors: ValidationIssue[],
): void {
  const hashes = Array.isArray(source.document.input_artifact_hashes)
    ? source.document.input_artifact_hashes
    : [];
  const refs = hashes.flatMap((entry) =>
    isRecord(entry) && typeof entry.ref === "string" ? [entry.ref] : [],
  );
  validateExactRefs(
    refs,
    expectedRefs,
    `${source.path}#/input_artifact_hashes`,
    errors,
    "discovery_maps.input_hash_set_mismatch",
  );
  for (const [index, entry] of hashes.entries()) {
    if (!isRecord(entry) || typeof entry.ref !== "string") {
      continue;
    }
    const target = byPath.get(entry.ref.split("#", 1)[0] ?? "");
    if (target === undefined || entry.content_hash !== targetHash(target)) {
      errors.push(
        issue(
          "discovery_maps.input_hash_mismatch",
          `${source.path}#/input_artifact_hashes/${index}`,
          "input hash must bind the exact referenced formal document",
          {
            ref: entry.ref,
            actual: entry.content_hash,
            expected: target === undefined ? null : targetHash(target),
          },
        ),
      );
    }
  }
}

function validateContentProvenance(
  source: DiscoveryMapDocument,
  byPath: ReadonlyMap<string, DiscoveryMapDocument>,
  exactRecords: ReadonlyMap<string, Record<string, unknown>>,
  errors: ValidationIssue[],
): void {
  const provenance = isRecord(source.document.content_provenance)
    ? source.document.content_provenance
    : {};
  const refs = stringArray(provenance.prior_input_decision_refs);
  const inheritedRefs = [
    ...new Set(
      (Array.isArray(source.document.input_artifact_hashes)
        ? source.document.input_artifact_hashes.filter(isRecord)
        : []
      ).flatMap((binding) => {
        const target = typeof binding.ref === "string" ? byPath.get(binding.ref) : undefined;
        const targetProvenance = isRecord(target?.document.content_provenance)
          ? target.document.content_provenance
          : {};
        return stringArray(targetProvenance.prior_input_decision_refs);
      }),
    ),
  ].sort();
  const missingInheritedRefs = inheritedRefs.filter((ref) => !refs.includes(ref));
  if (missingInheritedRefs.length > 0) {
    errors.push(
      issue(
        "discovery_maps.prior_input_provenance_not_propagated",
        `${source.path}#/content_provenance/prior_input_decision_refs`,
        "Map provenance must retain every prior admission inherited through its current-Run synthesis inputs",
        { missingInheritedRefs },
      ),
    );
  }
  if (
    (provenance.synthesis_origin === "current_run_synthesis" && refs.length > 0) ||
    (provenance.synthesis_origin === "prior_informed_synthesis" && refs.length === 0)
  ) {
    errors.push(
      issue(
        "discovery_maps.prior_provenance_state_mismatch",
        `${source.path}#/content_provenance`,
        "Map synthesis origin must explicitly agree with its admitted prior inputs",
      ),
    );
  }
  for (const ref of refs) {
    const decision = exactRecords.get(ref);
    if (
      decision?.schema_version !== "startup_opportunity.decision.v1" ||
      decision.decision_type !== "prior_input_admitted" ||
      decision.run_id !== source.document.run_id ||
      decision.prior_source_run_id === source.document.run_id ||
      decision.prior_use_boundary !== "hypothesis_input_only"
    ) {
      errors.push(
        issue(
          "discovery_maps.prior_input_admission_invalid",
          `${source.path}#/content_provenance/prior_input_decision_refs`,
          "historical Map input requires an exact same-Run admission decision with distinct source Run and hypothesis-only use",
          { ref },
        ),
      );
    }
  }
}

function validateEnvelopeIdentity(
  entry: DiscoveryMapDocument,
  errors: ValidationIssue[],
): Record<string, unknown> | null {
  const envelope = entry.envelope;
  const isInitialMainAgentEnvelope =
    envelope?.schema_version === "startup_opportunity.artifact_envelope.current" &&
    envelope.producer_role === "main_agent";
  const isPlanRevisionEnvelope =
    entry.schemaVersion === "startup_opportunity.research_plan.v1" &&
    envelope?.schema_version === "startup_opportunity.artifact_envelope.current" &&
    envelope.producer_role === "harness";
  if (
    envelope === null ||
    (!isInitialMainAgentEnvelope && !isPlanRevisionEnvelope) ||
    envelope.artifact_type !== entry.schemaVersion ||
    envelope.artifact_path !== entry.path ||
    envelope.run_id !== entry.document.run_id
  ) {
    errors.push(
      issue(
        "discovery_maps.envelope_binding_mismatch",
        entry.path,
        "G2.1 inputs require the current envelope; Plan revisions may be harness-produced",
      ),
    );
    return null;
  }
  return envelope;
}

function validateEnvelope(
  entry: DiscoveryMapDocument,
  expectedInputRefs: readonly string[],
  errors: ValidationIssue[],
): void {
  const envelope = validateEnvelopeIdentity(entry, errors);
  if (envelope === null) {
    return;
  }
  validateExactRefs(
    envelope.input_refs,
    expectedInputRefs,
    `${entry.path}#/input_refs`,
    errors,
    "discovery_maps.envelope_input_mismatch",
  );
}

function validatePolicyBinding(
  entry: DiscoveryMapDocument,
  loadedPolicy: LoadedDiscoveryMapsPolicy,
  errors: ValidationIssue[],
): void {
  const binding = entry.document.policy_binding;
  if (
    !isRecord(binding) ||
    binding.policy_ref !== DISCOVERY_MAPS_POLICY_PATH ||
    binding.policy_schema_version !== loadedPolicy.document.schema_version ||
    binding.policy_version !== loadedPolicy.document.policy_version ||
    binding.content_hash !== loadedPolicy.contentHash
  ) {
    errors.push(
      issue(
        "discovery_maps.policy_binding_mismatch",
        `${entry.path}#/policy_binding`,
        "map policy binding is missing, stale, or content-hash mismatched",
        { expectedContentHash: loadedPolicy.contentHash },
      ),
    );
  }
}

function validateSeedFamilies(
  seed: DiscoveryMapDocument,
  profile: DiscoveryProfile,
  policy: DiscoveryMapsPolicy,
  errors: ValidationIssue[],
): void {
  const families = seed.document.seed_families;
  if (!isRecord(families)) {
    return;
  }
  for (const [family, value] of Object.entries(families)) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const [index, entry] of value.entries()) {
      if (isRecord(entry) && entry.seed_kind !== family) {
        errors.push(
          issue(
            "discovery_maps.seed_family_mismatch",
            `${seed.path}#/seed_families/${family}/${index}/seed_kind`,
            "seed kind must match its containing family",
            { family, seedKind: entry.seed_kind },
          ),
        );
      }
    }
  }
  for (const family of policy.profiles[profile].required_seed_families) {
    if (!Array.isArray(families[family]) || families[family].length === 0) {
      errors.push(
        issue(
          "discovery_maps.profile_seed_missing",
          `${seed.path}#/seed_families/${family}`,
          "discovery profile is missing a required seed family",
          { profile, family },
        ),
      );
    }
  }
}

function validateInitialQuestions(
  seed: DiscoveryMapDocument,
  plan: DiscoveryMapDocument,
  profile: DiscoveryProfile,
  errors: ValidationIssue[],
): void {
  const questions = Array.isArray(seed.document.initial_questions)
    ? seed.document.initial_questions.filter((item): item is Record<string, unknown> =>
        isRecord(item),
      )
    : [];
  const kinds = questions.flatMap((question) =>
    typeof question.question_kind === "string" ? [question.question_kind] : [],
  );
  const requiredKinds = [
    ...REQUIRED_QUESTION_KINDS,
    ...(profile === "ai_first" || profile === "hybrid" ? ["ai_boundary"] : []),
  ];
  for (const kind of requiredKinds) {
    if (!kinds.includes(kind)) {
      errors.push(
        issue(
          "discovery_maps.initial_question_missing",
          `${seed.path}#/initial_questions`,
          "initial questions do not cover a required planning category",
          { profile, questionKind: kind },
        ),
      );
    }
  }
  const planQuestions = Array.isArray(plan.document.research_questions)
    ? plan.document.research_questions.filter((item): item is Record<string, unknown> =>
        isRecord(item),
      )
    : [];
  for (const question of questions) {
    const match = planQuestions.find((candidate) => candidate.question_id === question.question_id);
    const fields = [
      "question_id",
      "question",
      "decision_impact",
      "uncertainty",
      "expected_information_gain",
      "stop_condition",
    ];
    if (match === undefined || fields.some((field) => match[field] !== question[field])) {
      errors.push(
        issue(
          "discovery_maps.plan_question_mismatch",
          `${seed.path}#/initial_questions`,
          "each initial map question must have an exact Research Plan question binding",
          { questionId: question.question_id },
        ),
      );
    }
  }
}

function validatePlanContracts(
  seed: DiscoveryMapDocument,
  plan: DiscoveryMapDocument,
  scope: DiscoveryMapDocument,
  policy: DiscoveryMapsPolicy,
  errors: ValidationIssue[],
): void {
  const exploration = plan.document.exploration_policy;
  for (const flag of policy.plan_contract.required_exploration_flags) {
    if (!isRecord(exploration) || exploration[flag] !== true) {
      errors.push(
        issue(
          "discovery_maps.plan_flag_missing",
          `${plan.path}#/exploration_policy/${flag}`,
          "Research Plan must enable every G2.1 exploration constraint",
          { flag },
        ),
      );
    }
  }
  const retention = plan.document.candidate_retention_policy;
  if (!isRecord(retention) || retention.counterfactual_candidate_requirement !== true) {
    errors.push(
      issue(
        "discovery_maps.counterfactual_retention_missing",
        `${plan.path}#/candidate_retention_policy/counterfactual_candidate_requirement`,
        "Research Plan must retain counterfactual candidates",
      ),
    );
  }
  const contracts = seed.document.unit_contracts;
  const independent =
    isRecord(contracts) && isRecord(contracts.seed_independent_demand_task)
      ? contracts.seed_independent_demand_task
      : null;
  const counterfactual =
    isRecord(contracts) && isRecord(contracts.counterfactual) ? contracts.counterfactual : null;
  const units = planUnits(plan.document);
  const independentUnit =
    independent === null ? undefined : units.find((unit) => unit.unit_id === independent.unit_id);
  const expectedScopeInput = [scope.path];
  if (
    independent === null ||
    independent.unit_ref !== `${plan.path}#${String(independent.unit_id)}` ||
    canonicalJson(independent.input_refs) !== canonicalJson(expectedScopeInput) ||
    independentUnit === undefined ||
    independentUnit.plan_disposition !== "enabled" ||
    !policy.plan_contract.seed_independent_unit_types.includes(String(independentUnit.unit_type)) ||
    canonicalJson(independentUnit.input_refs) !== canonicalJson(expectedScopeInput)
  ) {
    errors.push(
      issue(
        "discovery_maps.seed_independent_unit_invalid",
        `${seed.path}#/unit_contracts/seed_independent_demand_task`,
        "seed-independent demand/task unit must be enabled and read only the Scope Frame",
      ),
    );
  }
  const counterfactualUnit =
    counterfactual === null
      ? undefined
      : units.find((unit) => unit.unit_id === counterfactual.unit_id);
  if (
    counterfactual === null ||
    counterfactual.unit_ref !== `${plan.path}#${String(counterfactual.unit_id)}` ||
    counterfactualUnit === undefined ||
    counterfactualUnit.plan_disposition !== "enabled" ||
    counterfactualUnit.unit_type !== policy.plan_contract.counterfactual_unit_type ||
    counterfactual.unit_id === independent?.unit_id
  ) {
    errors.push(
      issue(
        "discovery_maps.counterfactual_unit_invalid",
        `${seed.path}#/unit_contracts/counterfactual`,
        "counterfactual contract must bind a distinct enabled counter_evidence unit",
      ),
    );
  }
}

function validateOpportunityMap(
  opportunity: DiscoveryMapDocument,
  errors: ValidationIssue[],
): void {
  const demandQuestions = Array.isArray(opportunity.document.initial_demand_hypotheses)
    ? opportunity.document.initial_demand_hypotheses.filter(
        (item): item is Record<string, unknown> => isRecord(item),
      )
    : [];
  if (!demandQuestions.some((entry) => entry.seed_dependency === "seed_independent")) {
    errors.push(
      issue(
        "discovery_maps.seed_independent_demand_missing",
        `${opportunity.path}#/initial_demand_hypotheses`,
        "Opportunity Space Map requires a seed-independent demand question",
      ),
    );
  }
  const disconfirming = Array.isArray(opportunity.document.disconfirming_questions)
    ? opportunity.document.disconfirming_questions.filter((item): item is Record<string, unknown> =>
        isRecord(item),
      )
    : [];
  if (!disconfirming.some((entry) => entry.question_kind === "counterfactual")) {
    errors.push(
      issue(
        "discovery_maps.counterfactual_question_missing",
        `${opportunity.path}#/disconfirming_questions`,
        "Opportunity Space Map requires a counterfactual disconfirming question",
      ),
    );
  }
  const buyerQuestions = Array.isArray(opportunity.document.buyer_purchase_language_hypotheses)
    ? opportunity.document.buyer_purchase_language_hypotheses.filter(
        (item): item is Record<string, unknown> => isRecord(item),
      )
    : [];
  if (!buyerQuestions.every((entry) => entry.question_kind === "buyer")) {
    errors.push(
      issue(
        "discovery_maps.buyer_question_invalid",
        `${opportunity.path}#/buyer_purchase_language_hypotheses`,
        "buyer language hypotheses must remain buyer questions",
      ),
    );
  }
}

function validateSolutionMap(
  solution: DiscoveryMapDocument,
  profile: DiscoveryProfile,
  policy: DiscoveryMapsPolicy,
  errors: ValidationIssue[],
): void {
  const candidates = Array.isArray(solution.document.solution_candidates)
    ? solution.document.solution_candidates.filter((item): item is Record<string, unknown> =>
        isRecord(item),
      )
    : [];
  const classes = candidates.flatMap((entry) =>
    typeof entry.solution_class === "string" ? [entry.solution_class] : [],
  );
  if (
    !unique(classes) ||
    canonicalJson([...classes].sort()) !==
      canonicalJson([...policy.required_solution_classes].sort())
  ) {
    errors.push(
      issue(
        "discovery_maps.solution_breadth_mismatch",
        `${solution.path}#/solution_candidates`,
        "Solution Space Map must contain each required solution and status-quo class exactly once",
        { actual: [...classes].sort(), expected: [...policy.required_solution_classes].sort() },
      ),
    );
  }
  for (const candidate of candidates) {
    const solutionClass = String(candidate.solution_class);
    const expectedDelivery = CANDIDATE_DELIVERY_REQUIREMENTS[solutionClass];
    const actualDelivery = stringArray(candidate.delivery_forms);
    if (expectedDelivery?.some((delivery) => !actualDelivery.includes(delivery))) {
      errors.push(
        issue(
          "discovery_maps.delivery_form_mismatch",
          `${solution.path}#/solution_candidates`,
          "solution class is missing its required delivery form",
          { solutionClass, actualDelivery, expectedDelivery },
        ),
      );
    }
    if ((solutionClass === "ai_assisted") !== (candidate.uses_ai === true)) {
      errors.push(
        issue(
          "discovery_maps.ai_candidate_mismatch",
          `${solution.path}#/solution_candidates`,
          "only the AI-assisted option may declare uses_ai=true at G2.1",
          { solutionClass, usesAi: candidate.uses_ai },
        ),
      );
    }
  }
  const aiBoundary = solution.document.ai_boundary;
  if (!isRecord(aiBoundary)) {
    return;
  }
  const requiresAi =
    policy.profiles[profile].ai_boundary_requirement === "required_as_solution_option";
  if (requiresAi && aiBoundary.applicability !== "applicable_as_solution_option") {
    errors.push(
      issue(
        "discovery_maps.ai_profile_boundary_missing",
        `${solution.path}#/ai_boundary/applicability`,
        "AI-first and hybrid profiles require an AI solution-option boundary",
        { profile },
      ),
    );
  }
  for (const field of policy.ai_boundary_fields) {
    const values = Array.isArray(aiBoundary[field]) ? aiBoundary[field] : [];
    if (aiBoundary.applicability === "applicable_as_solution_option" && values.length === 0) {
      errors.push(
        issue(
          "discovery_maps.ai_boundary_field_missing",
          `${solution.path}#/ai_boundary/${field}`,
          "applicable AI option must record every G2.1 capability boundary field",
          { field },
        ),
      );
    }
    if (aiBoundary.applicability === "not_applicable" && values.length !== 0) {
      errors.push(
        issue(
          "discovery_maps.ai_not_applicable_has_content",
          `${solution.path}#/ai_boundary/${field}`,
          "not-applicable AI boundary must not carry unsupported capability assertions",
          { field },
        ),
      );
    }
  }
}

export function isDiscoveryMapSchemaVersion(schemaVersion: string): boolean {
  return (
    MAP_SCHEMA_VERSIONS.has(schemaVersion) ||
    schemaVersion === "startup_opportunity.scope_frame.discovery.current"
  );
}

export function validateDiscoveryMapsContract(
  documents: readonly DiscoveryMapDocument[],
  loadedPolicy: LoadedDiscoveryMapsPolicy,
  exactRecords: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): readonly ValidationIssue[] {
  if (!documents.some((entry) => MAP_SCHEMA_VERSIONS.has(entry.schemaVersion))) {
    return [];
  }
  const errors: ValidationIssue[] = [];
  const manifest = one(documents, "startup_opportunity.run_manifest.v1", errors);
  const intake = one(documents, "startup_opportunity.intake.v1", errors);
  const decision = one(documents, "startup_opportunity.decision_context.v1", errors);
  const scope = one(documents, "startup_opportunity.scope_frame.discovery.current", errors);
  const plan =
    manifest === null
      ? null
      : oneAtPath(
          documents,
          "startup_opportunity.research_plan.v1",
          String(manifest.document.current_plan_ref),
          errors,
        );
  const seed = one(documents, "startup_opportunity.seed_probe.v1", errors);
  const opportunity = one(documents, "startup_opportunity.opportunity_space_map.v1", errors);
  const solution = one(documents, "startup_opportunity.solution_space_map.v1", errors);
  if (
    manifest === null ||
    intake === null ||
    decision === null ||
    scope === null ||
    plan === null ||
    seed === null ||
    opportunity === null ||
    solution === null
  ) {
    return sortIssues(errors);
  }
  const policy = loadedPolicy.document;
  const profileValue = scope.document.discovery_profile;
  const profile = DISCOVERY_PROFILES.has(profileValue as DiscoveryProfile)
    ? (profileValue as DiscoveryProfile)
    : null;
  const runId = manifest.document.run_id;
  const market = scope.document.market;
  const language = scope.document.language;
  const identityDocuments = [intake, scope, plan, seed, opportunity, solution];
  for (const entry of identityDocuments) {
    if (entry.document.run_id !== runId || entry.document.mode !== "opportunity_discovery") {
      errors.push(
        issue(
          "discovery_maps.run_mode_mismatch",
          entry.path,
          "G2.1 documents must bind the same opportunity_discovery Run",
          { expectedRunId: runId, actualRunId: entry.document.run_id, mode: entry.document.mode },
        ),
      );
    }
  }
  if (decision.document.run_id !== runId) {
    errors.push(
      issue(
        "discovery_maps.run_mode_mismatch",
        decision.path,
        "G2.1 Decision Context must bind the same opportunity_discovery Run",
        { expectedRunId: runId, actualRunId: decision.document.run_id },
      ),
    );
  }
  if (
    manifest.document.mode !== "opportunity_discovery" ||
    intake.document.action !== "discover" ||
    decision.document.decision_to_make !== "choose_opportunity"
  ) {
    errors.push(
      issue(
        "discovery_maps.discovery_identity_invalid",
        "/documents",
        "manifest, intake, and Decision Context must describe one discovery decision",
      ),
    );
  }
  if (
    manifest.document.current_plan_ref !== plan.path ||
    manifest.document.plan_revision !== plan.document.revision ||
    manifest.document.current_phase !== "discovery"
  ) {
    errors.push(
      issue(
        "discovery_maps.current_plan_mismatch",
        "manifest.json#/current_plan_ref",
        "maps must bind the exact current discovery Plan",
        {
          currentPlanRef: manifest.document.current_plan_ref,
          planPath: plan.path,
          currentPhase: manifest.document.current_phase,
        },
      ),
    );
  }
  for (const entry of [intake, seed, opportunity, solution]) {
    if (entry.document.market !== market || entry.document.language !== language) {
      errors.push(
        issue(
          "discovery_maps.primary_locale_mismatch",
          entry.path,
          "market and language must match the single primary Scope Frame locale",
          { market: entry.document.market, language: entry.document.language },
        ),
      );
    }
  }
  if (profile === null) {
    errors.push(
      issue(
        "discovery_maps.profile_invalid",
        `${scope.path}#/discovery_profile`,
        "Scope Frame discovery profile is outside the closed G2.1 profile set",
        { actual: profileValue },
      ),
    );
  }
  for (const entry of [seed, opportunity, solution]) {
    if (profile === null || entry.document.discovery_profile !== profile) {
      errors.push(
        issue(
          "discovery_maps.profile_mismatch",
          entry.path,
          "all G2.1 maps must use the Scope Frame discovery profile",
          { expected: profile, actual: entry.document.discovery_profile },
        ),
      );
    }
    validatePolicyBinding(entry, loadedPolicy, errors);
  }
  if (
    intake.document.market !== market ||
    intake.document.language !== language ||
    (isRecord(intake.document.explicit_constraints) &&
      ((intake.document.explicit_constraints.target_market !== undefined &&
        intake.document.explicit_constraints.target_market !== market) ||
        (intake.document.explicit_constraints.target_language !== undefined &&
          intake.document.explicit_constraints.target_language !== language)))
  ) {
    errors.push(
      issue(
        "discovery_maps.intake_scope_mismatch",
        "intake.json",
        "intake primary market/language constraints must match discovery scope",
      ),
    );
  }
  const expectedPaths = policy.artifact_paths;
  if (
    seed.path !== expectedPaths.seed_probe ||
    opportunity.path !== expectedPaths.opportunity_space_map ||
    solution.path !== expectedPaths.solution_space_map
  ) {
    errors.push(
      issue(
        "discovery_maps.path_mismatch",
        "/documents",
        "G2.1 r1 map paths differ from the published immutable path contract",
      ),
    );
  }
  const expectedSeedRefs = [scope.path, plan.path];
  const expectedOpportunityRefs = [scope.path, seed.path, plan.path];
  const expectedSolutionRefs = [scope.path, seed.path, opportunity.path, plan.path];
  const byPath = new Map(documents.map((entry) => [entry.path, entry]));
  for (const entry of [intake, decision, scope, plan]) {
    validateEnvelopeIdentity(entry, errors);
  }
  validateEnvelope(seed, expectedSeedRefs, errors);
  validateEnvelope(opportunity, expectedOpportunityRefs, errors);
  validateEnvelope(solution, expectedSolutionRefs, errors);
  validateInputHashes(seed, expectedSeedRefs, byPath, errors);
  validateInputHashes(opportunity, expectedOpportunityRefs, byPath, errors);
  validateInputHashes(solution, expectedSolutionRefs, byPath, errors);
  validateContentProvenance(seed, byPath, exactRecords, errors);
  validateContentProvenance(opportunity, byPath, exactRecords, errors);
  validateContentProvenance(solution, byPath, exactRecords, errors);
  if (
    seed.document.scope_frame_ref !== scope.path ||
    opportunity.document.scope_frame_ref !== scope.path ||
    solution.document.scope_frame_ref !== scope.path ||
    seed.document.research_plan_ref !== plan.path ||
    opportunity.document.research_plan_ref !== plan.path ||
    solution.document.research_plan_ref !== plan.path ||
    opportunity.document.seed_probe_ref !== seed.path ||
    solution.document.seed_probe_ref !== seed.path ||
    solution.document.opportunity_space_map_ref !== opportunity.path ||
    opportunity.document.demand_boundary_id !== solution.document.demand_boundary_id
  ) {
    errors.push(
      issue(
        "discovery_maps.lineage_mismatch",
        "/documents",
        "scope, seed, opportunity, solution, demand-boundary, and Plan lineage must be exact",
      ),
    );
  }
  if (profile !== null) {
    validateSeedFamilies(seed, profile, policy, errors);
    validateInitialQuestions(seed, plan, profile, errors);
    validateSolutionMap(solution, profile, policy, errors);
  }
  validatePlanContracts(seed, plan, scope, policy, errors);
  validateOpportunityMap(opportunity, errors);
  for (const forbidden of policy.forbidden_formal_artifact_types) {
    if (documents.some((entry) => entry.schemaVersion === forbidden)) {
      errors.push(
        issue(
          "discovery_maps.downstream_artifact_forbidden",
          "/documents",
          "G2.1 cannot publish G2.2+ formal artifacts",
          { forbidden },
        ),
      );
    }
  }
  return sortIssues(errors);
}

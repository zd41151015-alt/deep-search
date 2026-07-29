import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createArtifactValidator,
  createPlanningContractEvaluator,
  loadSchemaBundle,
  type PlanningContractValidationResult,
} from "../harness/src/index.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = path.join(repositoryRoot, "tests/fixtures/contracts");

interface Mutation {
  readonly op: "set" | "delete" | "remove_document";
  readonly path?: readonly (string | number)[];
  readonly value?: unknown;
  readonly index?: number;
}

interface ExpectedIssue {
  readonly surface: "schema" | "reference" | "contract";
  readonly code?: string;
  readonly keyword?: string;
}

interface NegativeContractCase {
  readonly case_id: string;
  readonly category: "planning_context" | "mode_policy" | "coverage" | "retry" | "versioning";
  readonly mutations: readonly Mutation[];
  readonly expected: readonly ExpectedIssue[];
}

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, "utf8")) as T;
}

function getContainer(root: unknown, segments: readonly (string | number)[]): unknown {
  let current = root;
  for (const segment of segments) {
    assert.ok(typeof current === "object" && current !== null);
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function applyMutations(base: unknown, mutations: readonly Mutation[]): unknown {
  const result = structuredClone(base);
  for (const mutation of mutations) {
    if (mutation.op === "remove_document") {
      assert.ok(typeof result === "object" && result !== null);
      const documents = (result as { documents?: unknown }).documents;
      assert.ok(Array.isArray(documents));
      assert.notEqual(mutation.index, undefined);
      documents.splice(mutation.index ?? -1, 1);
      continue;
    }
    const mutationPath = mutation.path ?? [];
    assert.ok(mutationPath.length > 0);
    const key = mutationPath.at(-1);
    assert.notEqual(key, undefined);
    const parent = getContainer(result, mutationPath.slice(0, -1));
    assert.ok(typeof parent === "object" && parent !== null);
    if (mutation.op === "delete") {
      delete (parent as Record<string | number, unknown>)[key as string | number];
    } else {
      (parent as Record<string | number, unknown>)[key as string | number] = structuredClone(
        mutation.value,
      );
    }
  }
  return result;
}

function allIssues(result: PlanningContractValidationResult): readonly {
  readonly surface: ExpectedIssue["surface"];
  readonly code: string;
  readonly keyword: string;
}[] {
  return [
    ...result.documentBundle.bundleErrors.map((issue) => ({
      surface: "schema" as const,
      ...issue,
    })),
    ...result.documentBundle.documents.flatMap((document) =>
      document.errors.map((issue) => ({ surface: "schema" as const, ...issue })),
    ),
    ...result.documentBundle.referenceErrors.map((issue) => ({
      surface: "reference" as const,
      ...issue,
    })),
    ...result.contractErrors.map((issue) => ({ surface: "contract" as const, ...issue })),
  ];
}

function assertExpectedIssues(
  result: PlanningContractValidationResult,
  fixture: NegativeContractCase,
): void {
  assert.equal(result.valid, false, `${fixture.case_id} unexpectedly passed`);
  const issues = allIssues(result);
  for (const expected of fixture.expected) {
    assert.ok(
      issues.some(
        (issue) =>
          issue.surface === expected.surface &&
          (expected.code === undefined || issue.code === expected.code) &&
          (expected.keyword === undefined || issue.keyword === expected.keyword),
      ),
      `${fixture.case_id} missing ${JSON.stringify(expected)} in ${JSON.stringify(issues)}`,
    );
  }
}

async function loadFixtures(): Promise<{
  readonly valid: unknown;
  readonly negative: readonly NegativeContractCase[];
}> {
  return {
    valid: await readJson(path.join(fixtureRoot, "valid-planning-contract-bundle.json")),
    negative: await readJson(path.join(fixtureRoot, "negative-contract-cases.json")),
  };
}

test("Planning Context binds current Run/Plan state and drives complete AI coverage", async () => {
  const evaluator = await createPlanningContractEvaluator(repositoryRoot);
  const { valid } = await loadFixtures();
  const result = evaluator.validateDocumentBundle(valid);
  assert.equal(result.valid, true, JSON.stringify(allIssues(result)));
  assert.equal(result.schemaBundleVersion, "2.1.0");
  assert.equal(result.policyVersion, "1.0.0");
  assert.equal(result.triggerSourcePolicyVersion, "1.0.0");

  const nonAi = structuredClone(valid) as {
    documents: { path: string; document: Record<string, unknown> }[];
  };
  const context = nonAi.documents.find((entry) => entry.path === "plans/planning-context.r1.json");
  assert.ok(context);
  context.document.ai_mandatory_coverage = {
    status: "not_required",
    trigger_version: "startup_opportunity.ai_mandatory_coverage_trigger.v1",
    basis: {
      signal: "none",
      declared_value: "not_applicable",
      subject_ref: null,
      source_ref: null,
      source_schema_version: null,
      source_content_hash: null,
    },
    required_dimensions: [],
  };
  nonAi.documents = nonAi.documents.filter(
    (entry) => entry.path !== "plans/ai-trigger-source.r1.json",
  );
  assert.equal(evaluator.validateDocumentBundle(nonAi).valid, true);
});

test("Planning Context negatives reject missing/wrong triggers and stale Run/Plan bindings", async () => {
  const evaluator = await createPlanningContractEvaluator(repositoryRoot);
  const { valid, negative } = await loadFixtures();
  const cases = negative.filter((fixture) => fixture.category === "planning_context");
  assert.equal(cases.length, 17);
  for (const fixture of cases) {
    assertExpectedIssues(
      evaluator.validateDocumentBundle(applyMutations(valid, fixture.mutations)),
      fixture,
    );
  }
});

test("fake or missing AI trigger source binding fails closed", async () => {
  const evaluator = await createPlanningContractEvaluator(repositoryRoot);
  const { valid } = await loadFixtures();
  const invalid = structuredClone(valid) as {
    documents: { path: string; document: Record<string, unknown> }[];
  };
  const context = invalid.documents.find(
    (entry) => entry.path === "plans/planning-context.r1.json",
  );
  assert.ok(context);
  const coverage = context.document.ai_mandatory_coverage as Record<string, unknown>;
  const basis = coverage.basis as Record<string, unknown>;
  basis.source_ref = "missing/source.json";
  basis.source_schema_version = "startup_opportunity.fake_source.v1";
  basis.source_content_hash = `sha256:${"b".repeat(64)}`;

  const result = evaluator.validateDocumentBundle(invalid);
  assert.equal(result.valid, false);
  assert.equal(result.documentBundle.valid, false);
  assert.ok(
    result.documentBundle.referenceErrors.some((issue) => issue.code === "reference.missing"),
  );
  assert.ok(
    result.contractErrors.some((issue) => issue.code === "contract.ai_trigger_source_missing"),
  );
});

test("closed mode policy accepts exact declared tuples and preserves installed owner schemas", async () => {
  const evaluator = await createPlanningContractEvaluator(repositoryRoot);
  const { valid, negative } = await loadFixtures();
  const cases = negative.filter((fixture) => fixture.category === "mode_policy");
  assert.equal(cases.length, 4);
  for (const fixture of cases) {
    assertExpectedIssues(
      evaluator.validateDocumentBundle(applyMutations(valid, fixture.mutations)),
      fixture,
    );
  }

  const bundle = await loadSchemaBundle(repositoryRoot);
  const policy = await readJson<{
    artifact_schema_catalog: { schema_id: string; availability: string }[];
    phase_catalog: unknown[];
    unit_rules: { unit_type: string }[];
  }>(path.join(repositoryRoot, "harness/policies/adaptation.v1.json"));
  assert.equal(policy.phase_catalog.length, 5);
  assert.equal(new Set(policy.unit_rules.map((rule) => rule.unit_type)).size, 23);
  assert.ok(
    policy.artifact_schema_catalog.every((entry) => entry.availability === "future_declared"),
  );
  const installedOwnedSchemas = new Set([
    "startup_opportunity.discovery_lane_result.v1",
    "startup_opportunity.enrichment_branch_result.v1",
    "startup_opportunity.concept_evidence_assessment_branch_result.v1",
    "startup_opportunity.adversarial_review.v1",
  ]);
  for (const schemaId of installedOwnedSchemas) {
    assert.ok(policy.artifact_schema_catalog.some((entry) => entry.schema_id === schemaId));
    assert.ok(bundle.validators.has(schemaId));
  }
  assert.ok(
    policy.artifact_schema_catalog
      .filter((entry) => !installedOwnedSchemas.has(entry.schema_id))
      .every((entry) => !bundle.validators.has(entry.schema_id)),
    "only schemas outside completed owning slices may remain uninstalled",
  );
});

test("coverage attestation verifies canonical key, exact relation, subject, and unit state", async () => {
  const evaluator = await createPlanningContractEvaluator(repositoryRoot);
  const { valid, negative } = await loadFixtures();
  const cases = negative.filter((fixture) => fixture.category === "coverage");
  assert.equal(cases.length, 4);
  for (const fixture of cases) {
    assertExpectedIssues(
      evaluator.validateDocumentBundle(applyMutations(valid, fixture.mutations)),
      fixture,
    );
  }

  const active = structuredClone(valid) as {
    documents: { path: string; document: Record<string, unknown> }[];
  };
  const manifest = active.documents.find((entry) => entry.path === "manifest.json");
  assert.ok(manifest);
  manifest.document.active_units = ["buyer_existing"];
  assert.equal(evaluator.validateDocumentBundle(active).valid, true);
});

test("retry_unit accepts failed_units only and rejects completed, active, and partial", async () => {
  const evaluator = await createPlanningContractEvaluator(repositoryRoot);
  const { valid, negative } = await loadFixtures();
  const cases = negative.filter((fixture) => fixture.category === "retry");
  assert.equal(cases.length, 3);
  for (const fixture of cases) {
    assertExpectedIssues(
      evaluator.validateDocumentBundle(applyMutations(valid, fixture.mutations)),
      fixture,
    );
  }
  assert.equal(evaluator.validateDocumentBundle(valid).valid, true);
});

test("installed G3.1 output remains closed and older adapters cannot publish it", async () => {
  const evaluator = await createPlanningContractEvaluator(repositoryRoot);
  const artifactValidator = await createArtifactValidator(repositoryRoot);
  const legacyValidator = await createArtifactValidator(
    repositoryRoot,
    "harness/schemas/bundle.v12.json",
    "12.0.0",
  );
  const { valid } = await loadFixtures();
  assert.equal(evaluator.validateDocumentBundle(valid).valid, true);

  const legacyResult = legacyValidator.validateDocument({
    schema_version: "startup_opportunity.capability_evidence.v1",
  });
  assert.equal(legacyResult.valid, false);
  assert.equal(legacyResult.errors[0]?.code, "schema.unknown_version");

  const currentResult = artifactValidator.validateDocument({
    schema_version: "startup_opportunity.capability_evidence.v1",
  });
  assert.equal(currentResult.valid, false);
  assert.ok(currentResult.errors.some((issue) => issue.keyword === "required"));

  const envelope = await readJson(path.join(fixtureRoot, "future-declared-artifact-envelope.json"));
  const envelopeResult = artifactValidator.validateDocument(envelope);
  assert.equal(envelopeResult.valid, false);
  assert.ok(envelopeResult.errors.some((issue) => issue.keyword === "enum"));
});

test("v1 Adaptation Decision remains readable but cannot enter v2 policy validation", async () => {
  const evaluator = await createPlanningContractEvaluator(repositoryRoot);
  const { valid, negative } = await loadFixtures();
  const fixture = negative.find((candidate) => candidate.category === "versioning");
  assert.ok(fixture);
  const result = evaluator.validateDocumentBundle(applyMutations(valid, fixture.mutations));
  assertExpectedIssues(result, fixture);
  assert.ok(
    result.documentBundle.documents.some(
      (document) =>
        document.artifactSchemaVersion === "startup_opportunity.adaptation_decision.v1" &&
        document.valid,
    ),
  );
});

test("planning contract failures are byte-stable", async () => {
  const evaluator = await createPlanningContractEvaluator(repositoryRoot);
  const { valid, negative } = await loadFixtures();
  const fixture = negative.find((candidate) => candidate.case_id === "coverage-key-forged");
  assert.ok(fixture);
  const invalid = applyMutations(valid, fixture.mutations);
  assert.equal(
    JSON.stringify(evaluator.validateDocumentBundle(invalid)),
    JSON.stringify(evaluator.validateDocumentBundle(invalid)),
  );
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ArtifactStore,
  ASSESSMENT_DIMENSIONS,
  canonicalContentHash,
  createArtifactValidator,
  type DocumentBundleValidationResult,
  type FormalArtifactEnvelope,
  inspectSchemaBundle,
  StoreError,
  validateAssessDomainContract,
} from "../harness/src/index.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = path.join(repositoryRoot, "tests/fixtures/g1.1");

interface Mutation {
  readonly op: "set" | "delete" | "delete_array_item";
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
  readonly index?: number;
}

interface ExpectedIssue {
  readonly kind: "document" | "reference";
  readonly code?: string;
  readonly keyword?: string;
  readonly instance_path?: string;
}

interface NegativeCase {
  readonly case_id: string;
  readonly mutations: readonly Mutation[];
  readonly expected: readonly ExpectedIssue[];
}

interface NegativeFixtureSet {
  readonly schema_version: "startup_opportunity.g1_1_negative_fixture_set.v1";
  readonly base_fixture: string;
  readonly cases: readonly NegativeCase[];
}

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, "utf8")) as T;
}

function containerAt(root: unknown, segments: readonly (string | number)[]): unknown {
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
    const parent = containerAt(result, mutation.path.slice(0, -1));
    const key = mutation.path.at(-1);
    assert.ok(typeof parent === "object" && parent !== null && key !== undefined);
    if (mutation.op === "set") {
      (parent as Record<string | number, unknown>)[key] = structuredClone(mutation.value);
    } else if (mutation.op === "delete") {
      delete (parent as Record<string | number, unknown>)[key];
    } else {
      const target = (parent as Record<string | number, unknown>)[key];
      assert.ok(Array.isArray(target));
      assert.notEqual(mutation.index, undefined);
      target.splice(mutation.index ?? -1, 1);
    }
  }
  return result;
}

function hasExpectedIssue(
  result: DocumentBundleValidationResult,
  expected: ExpectedIssue,
): boolean {
  const issues =
    expected.kind === "document"
      ? result.documents.flatMap((document) => document.errors)
      : result.referenceErrors;
  return issues.some(
    (candidate) =>
      (expected.code === undefined || candidate.code === expected.code) &&
      (expected.keyword === undefined || candidate.keyword === expected.keyword) &&
      (expected.instance_path === undefined || candidate.instancePath === expected.instance_path),
  );
}

test("G1.1 bundle publishes all closed assess document schemas", async () => {
  const result = await inspectSchemaBundle(repositoryRoot);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.schemaBundleVersion, "3.0.0");
  assert.equal(result.schemaCount, 36);
  assert.equal(result.documentSchemaCount, 34);
});

test("complete no-Evidence assess fixture closes schema, refs, identity, branch, fan-in, and matrix contracts", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const bundle = await readJson<Record<string, unknown>>(
    path.join(fixtureRoot, "valid-assess-contract-bundle.json"),
  );
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.documents.length, 30);

  const expectedDomainVersions = [
    "startup_opportunity.business_engine_thesis.v1",
    "startup_opportunity.concept_evidence_assessment.v1",
    "startup_opportunity.concept_evidence_assessment_branch_result.v1",
    "startup_opportunity.concept_evidence_assessment_fan_in.v1",
    "startup_opportunity.concept_evidence_assessment_plan.v1",
    "startup_opportunity.concept_hypothesis.v1",
    "startup_opportunity.decision_context.v1",
    "startup_opportunity.hypothesis_evidence_matrix.v1",
    "startup_opportunity.intake.v1",
    "startup_opportunity.judgment_assessment.v1",
    "startup_opportunity.scope_frame.v1",
  ];
  const actualDomainVersions = [
    ...new Set(
      result.documents
        .map((document) => document.artifactSchemaVersion)
        .filter(
          (version): version is string =>
            version !== null && version !== "startup_opportunity.research_plan.v1",
        ),
    ),
  ].sort();
  assert.deepEqual(actualDomainVersions, expectedDomainVersions);
});

test("v4 envelope is schema-valid and binds the canonical Assessment document hash", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const envelope = await readJson<Record<string, unknown>>(
    path.join(fixtureRoot, "valid-assessment-envelope.json"),
  );
  const result = validator.validateDocument(envelope, "valid-assessment-envelope.json");
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(envelope.content_hash, canonicalContentHash(envelope.document));

  const wrongType = structuredClone(envelope);
  wrongType.artifact_type = "startup_opportunity.business_engine_thesis.v1";
  const wrongTypeResult = validator.validateDocument(wrongType, "wrong-type-envelope.json");
  assert.equal(wrongTypeResult.valid, false);
  assert.ok(wrongTypeResult.errors.some((entry) => entry.keyword === "oneOf"));
});

test("31 negative fixtures fail for their declared closed-schema or deterministic contract reason", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const fixtures = await readJson<NegativeFixtureSet>(
    path.join(fixtureRoot, "negative-contract-cases.json"),
  );
  const base = await readJson<unknown>(path.join(fixtureRoot, fixtures.base_fixture));
  assert.equal(fixtures.cases.length, 31);

  for (const fixture of fixtures.cases) {
    const result = validator.validateDocumentBundle(applyMutations(base, fixture.mutations));
    assert.equal(result.valid, false, `${fixture.case_id} unexpectedly passed`);
    for (const expected of fixture.expected) {
      assert.ok(
        hasExpectedIssue(result, expected),
        `${fixture.case_id} missing ${JSON.stringify(expected)} in ${JSON.stringify(result)}`,
      );
    }
  }
});

test("assessment plan lineage accepts consecutive immutable revisions and rejects identity drift", () => {
  const first = {
    path: "plans/concept-evidence-assessment-plan.r1.json",
    schemaVersion: "startup_opportunity.concept_evidence_assessment_plan.v1",
    document: {
      run_id: "run_assess_lineage_001",
      assessment_plan_id: "assessment_plan_lineage_001",
      revision: 1,
      parent_plan_ref: null,
      research_plan_ref: "plans/research-plan.r1.json",
      concept_hypothesis_ref: "concept-hypothesis.json",
      dimensions: ASSESSMENT_DIMENSIONS.map((dimension_id) => ({ dimension_id })),
    },
  };
  const second = {
    ...first,
    path: "plans/concept-evidence-assessment-plan.r2.json",
    document: {
      ...first.document,
      revision: 2,
      parent_plan_ref: first.path,
    },
  };

  const validLineageIssues = validateAssessDomainContract([first, second]);
  assert.equal(
    validLineageIssues.some(
      (issue) =>
        issue.code === "assess_contract.duplicate_singleton" ||
        issue.code === "assess_contract.plan_lineage_mismatch",
    ),
    false,
  );

  const drifted = {
    ...second,
    document: { ...second.document, assessment_plan_id: "assessment_plan_foreign_001" },
  };
  assert.ok(
    validateAssessDomainContract([first, drifted]).some(
      (issue) => issue.code === "assess_contract.plan_lineage_mismatch",
    ),
  );
});

test("G1.1 contract output is byte-stable across repeated validation", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const fixtures = await readJson<NegativeFixtureSet>(
    path.join(fixtureRoot, "negative-contract-cases.json"),
  );
  const base = await readJson<unknown>(path.join(fixtureRoot, fixtures.base_fixture));
  const fixture = fixtures.cases.find((entry) => entry.case_id === "fan-in-category-overlap");
  assert.ok(fixture);
  const invalid = applyMutations(base, fixture.mutations);
  assert.equal(
    JSON.stringify(validator.validateDocumentBundle(invalid)),
    JSON.stringify(validator.validateDocumentBundle(invalid)),
  );
});

test("existing Store fails closed for v4 until the G1.2 publication adapter is owned", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const artifactStore = new ArtifactStore(path.join(repositoryRoot, "runs"), validator);
  const envelope = await readJson<Record<string, unknown>>(
    path.join(fixtureRoot, "valid-assessment-envelope.json"),
  );
  assert.throws(
    () =>
      artifactStore.validateEnvelopeBoundary(
        "run_assess_contract_001",
        envelope as unknown as FormalArtifactEnvelope,
      ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.envelope_unsupported",
  );
});

test("Harness CLI validates the complete G1.1 bundle without starting research", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "validate-artifact",
      "--bundle",
      "tests/fixtures/g1.1/valid-assess-contract-bundle.json",
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as { valid?: boolean; schemaBundleVersion?: string };
  assert.equal(output.valid, true);
  assert.equal(output.schemaBundleVersion, "3.0.0");
});

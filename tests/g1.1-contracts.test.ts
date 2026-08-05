import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ASSESSMENT_DIMENSIONS,
  canonicalContentHash,
  createArtifactValidator,
  type DocumentBundleValidationResult,
  inspectSchemaBundle,
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
  assert.ok(result.schemaCount > 0);
  assert.ok(result.documentSchemaCount > 0);
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
    "startup_opportunity.business_engine_thesis.assessment.current",
    "startup_opportunity.concept_evidence_assessment.analysis.current",
    "startup_opportunity.concept_evidence_assessment_branch_result.v1",
    "startup_opportunity.concept_evidence_assessment_fan_in.v1",
    "startup_opportunity.concept_evidence_assessment_plan.v1",
    "startup_opportunity.concept_hypothesis.assessment.current",
    "startup_opportunity.decision_context.v1",
    "startup_opportunity.hypothesis_evidence_matrix.v1",
    "startup_opportunity.intake.v1",
    "startup_opportunity.judgment_assessment.assessment.current",
    "startup_opportunity.scope_frame.assessment.current",
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

test("current envelope validates artifact type, canonical hash, Run identity, and bundle path", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const envelope = await readJson<Record<string, unknown>>(
    path.join(fixtureRoot, "valid-assessment-envelope.json"),
  );
  const result = validator.validateDocument(envelope, "valid-assessment-envelope.json");
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(envelope.content_hash, canonicalContentHash(envelope.document));

  const wrongType = structuredClone(envelope);
  wrongType.artifact_type = "startup_opportunity.business_engine_thesis.assessment.current";
  const wrongTypeResult = validator.validateDocument(wrongType, "wrong-type-envelope.json");
  assert.equal(wrongTypeResult.valid, false);
  assert.ok(wrongTypeResult.errors.some((entry) => entry.keyword === "const"));

  const wrongHash = structuredClone(envelope);
  wrongHash.content_hash = `sha256:${"0".repeat(64)}`;
  const wrongHashResult = validator.validateDocument(wrongHash, "wrong-hash-envelope.json");
  assert.equal(wrongHashResult.valid, false);
  assert.ok(
    wrongHashResult.errors.some((entry) => entry.code === "artifact.content_hash_mismatch"),
  );

  const wrongRun = structuredClone(envelope);
  wrongRun.run_id = "run_foreign_001";
  const wrongRunResult = validator.validateDocument(wrongRun, "wrong-run-envelope.json");
  assert.equal(wrongRunResult.valid, false);
  assert.ok(
    wrongRunResult.errors.some((entry) => entry.code === "reference.envelope_run_mismatch"),
  );

  const bundle = await readJson<{
    documents: { path: string; document: Record<string, unknown> }[];
  }>(path.join(fixtureRoot, "valid-assess-contract-bundle.json"));
  const assessment = bundle.documents.find(
    (entry) => entry.path === "artifacts/synthesis/concept-evidence-assessment.json",
  );
  assert.ok(assessment);
  assessment.document = envelope;
  assert.equal(validator.validateDocumentBundle(bundle).valid, true);
  assessment.path = "artifacts/synthesis/renamed-assessment.json";
  const wrongPathResult = validator.validateDocumentBundle(bundle);
  assert.equal(wrongPathResult.valid, false);
  assert.ok(
    wrongPathResult.referenceErrors.some(
      (entry) => entry.code === "reference.envelope_path_mismatch",
    ),
  );
});

test("current negative fixtures fail for their declared closed-schema or contract reason", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const fixtures = await readJson<NegativeFixtureSet>(
    path.join(fixtureRoot, "negative-contract-cases.json"),
  );
  const base = await readJson<unknown>(path.join(fixtureRoot, fixtures.base_fixture));
  assert.ok(fixtures.cases.length > 0);
  assert.equal(
    new Set(fixtures.cases.map((fixture) => fixture.case_id)).size,
    fixtures.cases.length,
  );

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

test("assessment plan revisions reject stale or branched Research Plan ancestry", () => {
  const followupPolicy = {
    max_followup_rounds: 2,
    require_decision_relevance: true,
    stop_when_no_material_new_evidence: true,
  };
  const assessmentPlan = (
    revision: number,
    parentPlanRef: string | null,
    researchPlanRef: string,
  ) => ({
    path: `plans/concept-evidence-assessment-plan.r${revision}.json`,
    schemaVersion: "startup_opportunity.concept_evidence_assessment_plan.v1",
    document: {
      run_id: "run_assess_lineage_002",
      assessment_plan_id: "assessment_plan_lineage_002",
      revision,
      parent_plan_ref: parentPlanRef,
      research_plan_ref: researchPlanRef,
      triggered_by_adaptation_refs:
        revision === 1 ? [] : ["adaptations/decisions/adapt-lineage-001.json"],
      concept_hypothesis_ref: "concept-hypothesis.json",
      followup_policy: followupPolicy,
      dimensions: ASSESSMENT_DIMENSIONS.map((dimension_id) => ({
        dimension_id,
        branch_unit_type: "bounded_domain_research",
      })),
    },
  });
  const researchPlan = (
    revision: number,
    parentPlanRef: string | null,
    assessmentPlanRef: string,
  ) => ({
    path: `plans/research-plan.r${revision}.json`,
    schemaVersion: "startup_opportunity.research_plan.v1",
    document: {
      run_id: "run_assess_lineage_002",
      mode: "concept_evidence_assessment",
      revision,
      parent_plan_ref: parentPlanRef,
      triggered_by_adaptation_refs:
        revision === 1 ? [] : ["adaptations/decisions/adapt-lineage-001.json"],
      followup_policy: followupPolicy,
      waves: [
        {
          units: [
            {
              unit_id: `unit_lineage_${revision}`,
              unit_type: "bounded_domain_research",
              plan_disposition: "enabled",
              input_refs: ["concept-hypothesis.json", assessmentPlanRef],
              required_artifact_schema:
                "startup_opportunity.concept_evidence_assessment_branch_result.v1",
            },
          ],
        },
      ],
    },
  });

  const assessmentR1 = assessmentPlan(1, null, "plans/research-plan.r1.json");
  const assessmentR2 = assessmentPlan(2, assessmentR1.path, "plans/research-plan.r2.json");
  const researchR1 = researchPlan(1, null, assessmentR1.path);
  const researchR2 = researchPlan(2, researchR1.path, assessmentR2.path);
  const valid = validateAssessDomainContract([assessmentR1, assessmentR2, researchR1, researchR2]);
  assert.equal(
    valid.some(
      (entry) => entry.code === "assess_contract.assessment_research_plan_lineage_mismatch",
    ),
    false,
  );

  const staleAssessment = {
    ...assessmentR2,
    document: { ...assessmentR2.document, research_plan_ref: researchR1.path },
  };
  assert.ok(
    validateAssessDomainContract([assessmentR1, staleAssessment, researchR1]).some(
      (entry) => entry.code === "assess_contract.assessment_research_plan_lineage_mismatch",
    ),
  );

  const branchedResearch = {
    ...researchR2,
    document: {
      ...researchR2.document,
      parent_plan_ref: "plans/research-plan.foreign.json",
    },
  };
  assert.ok(
    validateAssessDomainContract([assessmentR1, assessmentR2, researchR1, branchedResearch]).some(
      (entry) => entry.code === "assess_contract.assessment_research_plan_lineage_mismatch",
    ),
  );
});

test("fan-in preserves a formal failed branch as an explicit non-usable category", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const bundle = await readJson<{
    documents: { path: string; document: Record<string, unknown> }[];
  }>(path.join(fixtureRoot, "valid-assess-contract-bundle.json"));
  const branch = bundle.documents.find(
    (entry) => entry.path === "artifacts/lanes/target-user.json",
  );
  const fanIn = bundle.documents.find(
    (entry) =>
      entry.document.schema_version === "startup_opportunity.concept_evidence_assessment_fan_in.v1",
  );
  assert.ok(branch);
  assert.ok(fanIn);
  branch.document.branch_status = "failed";
  const fanInDocument = fanIn.document as {
    completed_branch_refs: string[];
    failed_or_missing_branches: Record<string, unknown>[];
    dimension_summaries: Record<string, unknown>[];
    missing_mandatory_dimensions: string[];
  };
  fanInDocument.completed_branch_refs.shift();
  fanInDocument.failed_or_missing_branches = [
    {
      dimension_id: "target_user_and_jtbd",
      unit_id: "unit_target_user",
      status: "failed",
      decision_impact: ["concept_assessment"],
    },
  ];
  fanInDocument.dimension_summaries[0] = {
    ...fanInDocument.dimension_summaries[0],
    branch_ref: null,
    judgment_assessment_refs: [],
    decisive_supporting_refs: [],
    decisive_opposing_refs: [],
  };
  fanInDocument.missing_mandatory_dimensions = ["target_user_and_jtbd"];
  bundle.documents = bundle.documents.filter(
    (entry) =>
      entry.document.schema_version !== "startup_opportunity.hypothesis_evidence_matrix.v1" &&
      entry.document.schema_version !==
        "startup_opportunity.concept_evidence_assessment.analysis.current",
  );
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, true, JSON.stringify(result));
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
  const output = JSON.parse(result.stdout) as { valid?: boolean };
  assert.equal(output.valid, true);
});

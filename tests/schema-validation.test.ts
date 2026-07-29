import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  createArtifactValidator,
  type DocumentBundleValidationResult,
  inspectSchemaBundle,
  StoreError,
  type ValidationIssue,
} from "../harness/src/index.js";
import {
  createDiscoveryCandidateFixture,
  fixtureEffective,
  fixtureEntry,
  G22_DEMAND_R2,
  G22_EVALUATION_LANE,
  G22_FAN_IN,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const positiveFixtureRoot = path.join(repositoryRoot, "tests/fixtures/schemas/positive");
const negativeFixtureRoot = path.join(repositoryRoot, "tests/fixtures/schemas/negative");
const referenceFixtureRoot = path.join(repositoryRoot, "tests/fixtures/references");
const g22FixtureRoot = path.join(repositoryRoot, "tests/fixtures/g2.2");

interface Mutation {
  readonly op: "set" | "delete" | "delete_array_item" | "copy";
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
  readonly index?: number;
  readonly from_path?: readonly (string | number)[];
}

interface ExpectedSchemaIssue {
  readonly keyword: string;
  readonly instance_path?: string;
  readonly missing_property?: string;
  readonly additional_property?: string;
}

interface NegativeSchemaCase {
  readonly case_id: string;
  readonly base_fixture: string;
  readonly mutations: readonly Mutation[];
  readonly expected_issues: readonly ExpectedSchemaIssue[];
}

interface ExpectedReferenceIssue {
  readonly code: string;
  readonly instance_path_suffix: string;
}

interface NegativeReferenceCase {
  readonly case_id: string;
  readonly base_fixture: string;
  readonly mutations: readonly Mutation[];
  readonly expected_issues: readonly ExpectedReferenceIssue[];
}

interface G22NegativeCase {
  readonly case_id: string;
  readonly target_path: string;
  readonly target_scope?: "document" | "envelope";
  readonly field_path: readonly (string | number)[];
  readonly op: "set" | "delete";
  readonly value?: unknown;
  readonly expected_code: string;
}

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, "utf8")) as T;
}

function getContainer(root: unknown, segments: readonly (string | number)[]): unknown {
  let current = root;
  for (const segment of segments) {
    assert.ok(
      (typeof current === "object" && current !== null) || Array.isArray(current),
      `fixture mutation cannot traverse ${String(segment)}`,
    );
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function applyMutations(base: unknown, mutations: readonly Mutation[]): unknown {
  const result = structuredClone(base);
  for (const mutation of mutations) {
    assert.ok(mutation.path.length > 0, "fixture mutation path must not be empty");
    const parentPath = mutation.path.slice(0, -1);
    const key = mutation.path.at(-1);
    if (key === undefined) {
      throw new Error("fixture mutation key is missing");
    }
    const parent = getContainer(result, parentPath);
    assert.ok(typeof parent === "object" && parent !== null);

    if (mutation.op === "set") {
      (parent as Record<string | number, unknown>)[key] = structuredClone(mutation.value);
    } else if (mutation.op === "delete") {
      delete (parent as Record<string | number, unknown>)[key];
    } else if (mutation.op === "delete_array_item") {
      const target = (parent as Record<string | number, unknown>)[key];
      assert.ok(Array.isArray(target), "delete_array_item target must be an array");
      if (mutation.index === undefined) {
        throw new Error("delete_array_item index is missing");
      }
      target.splice(mutation.index, 1);
    } else {
      if (mutation.from_path === undefined) {
        throw new Error("copy source path is missing");
      }
      (parent as Record<string | number, unknown>)[key] = structuredClone(
        getContainer(result, mutation.from_path),
      );
    }
  }
  return result;
}

function applyG22Mutation(
  bundle: Awaited<ReturnType<typeof createDiscoveryCandidateFixture>>,
  mutation: G22NegativeCase,
): void {
  const target =
    mutation.target_path === "$bundle"
      ? (bundle as unknown as Record<string, unknown>)
      : mutation.target_scope === "envelope"
        ? fixtureEntry(bundle, mutation.target_path)
        : fixtureEffective(bundle, mutation.target_path);
  const parent = getContainer(target, mutation.field_path.slice(0, -1));
  const key = mutation.field_path.at(-1);
  assert.ok(typeof parent === "object" && parent !== null && key !== undefined);
  if (mutation.op === "delete") {
    delete (parent as Record<string | number, unknown>)[key];
  } else {
    (parent as Record<string | number, unknown>)[key] = structuredClone(mutation.value);
  }
}

function allIssueCodes(result: DocumentBundleValidationResult): readonly string[] {
  return [
    ...result.bundleErrors.map((entry) => entry.code),
    ...result.documents.flatMap((entry) => entry.errors.map((error) => error.code)),
    ...result.referenceErrors.map((entry) => entry.code),
  ];
}

function matchesSchemaIssue(issue: ValidationIssue, expected: ExpectedSchemaIssue): boolean {
  return (
    issue.keyword === expected.keyword &&
    (expected.instance_path === undefined || issue.instancePath === expected.instance_path) &&
    (expected.missing_property === undefined ||
      issue.details.missingProperty === expected.missing_property) &&
    (expected.additional_property === undefined ||
      issue.details.additionalProperty === expected.additional_property)
  );
}

test("published schema bundle is closed, versioned, and internally resolvable", async () => {
  const result = await inspectSchemaBundle(repositoryRoot);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.schemaBundleVersion, "14.0.0");
  assert.equal(result.schemaCount, 155);
  assert.equal(result.documentSchemaCount, 146);
  assert.deepEqual(result.errors, []);
});

test("schema bundle inspection rejects an unresolved internal reference", async (context) => {
  const copyRoot = await mkdtemp(path.join(tmpdir(), "startup-opportunity-schema-bundle-"));
  context.after(() => rm(copyRoot, { recursive: true, force: true }));
  const source = path.join(repositoryRoot, "harness/schemas");
  const target = path.join(copyRoot, "harness/schemas");
  await cp(source, target, { recursive: true });

  const eventSchemaPath = path.join(target, "v1/event.schema.json");
  const eventSchema = await readJson<Record<string, unknown>>(eventSchemaPath);
  const properties = eventSchema.properties as Record<string, Record<string, unknown>>;
  properties.artifact_refs = { $ref: "missing.schema.json#/$defs/artifactRefArray" };
  await writeFile(eventSchemaPath, `${JSON.stringify(eventSchema, null, 2)}\n`);

  const result = await inspectSchemaBundle(copyRoot);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((issue) => issue.code === "bundle.missing_ref"));
});

test("all eight core artifact schemas accept their representative positive fixture", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const filenames = (await readdir(positiveFixtureRoot)).filter((filename) =>
    filename.endsWith(".json"),
  );
  assert.equal(filenames.length, 8);

  const acceptedVersions = new Set<string>();
  for (const filename of filenames.sort()) {
    const result = validator.validateDocument(
      await readJson(path.join(positiveFixtureRoot, filename)),
      filename,
    );
    assert.equal(result.valid, true, `${filename}: ${JSON.stringify(result.errors)}`);
    assert.notEqual(result.artifactSchemaVersion, null);
    acceptedVersions.add(result.artifactSchemaVersion ?? "");
  }

  assert.deepEqual([...acceptedVersions].sort(), [
    "startup_opportunity.adaptation_decision.v1",
    "startup_opportunity.artifact_envelope.v1",
    "startup_opportunity.checkpoint.v1",
    "startup_opportunity.decision.v1",
    "startup_opportunity.event.v1",
    "startup_opportunity.gap_snapshot.v1",
    "startup_opportunity.research_plan.v1",
    "startup_opportunity.run_manifest.v1",
  ]);
});

test("negative fixtures are rejected for their declared deterministic reason", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const filenames = (await readdir(negativeFixtureRoot)).filter((filename) =>
    filename.endsWith(".json"),
  );
  assert.equal(filenames.length, 15);

  for (const filename of filenames.sort()) {
    const fixture = await readJson<NegativeSchemaCase>(path.join(negativeFixtureRoot, filename));
    assert.equal(fixture.case_id, filename.replace(/\.json$/, ""));
    const base = await readJson(path.join(positiveFixtureRoot, fixture.base_fixture));
    const invalidDocument = applyMutations(base, fixture.mutations);
    const result = validator.validateDocument(invalidDocument, fixture.case_id);
    assert.equal(result.valid, false, `${fixture.case_id} unexpectedly passed`);
    for (const expected of fixture.expected_issues) {
      assert.ok(
        result.errors.some((issue) => matchesSchemaIssue(issue, expected)),
        `${fixture.case_id} missing ${JSON.stringify(expected)} in ${JSON.stringify(result.errors)}`,
      );
    }
  }
});

test("typed document bundle validates known references and fragments", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const bundle = await readJson(path.join(referenceFixtureRoot, "valid-document-bundle.json"));
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.documents.length, 3);
  assert.deepEqual(result.referenceErrors, []);
});

test("reference fixtures reject missing, mistyped, fragmented, and revision-mismatched refs", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const fixtureRoot = path.join(referenceFixtureRoot, "negative");
  const filenames = (await readdir(fixtureRoot)).filter((filename) => filename.endsWith(".json"));
  assert.equal(filenames.length, 4);

  for (const filename of filenames.sort()) {
    const fixture = await readJson<NegativeReferenceCase>(path.join(fixtureRoot, filename));
    const base = await readJson(path.join(referenceFixtureRoot, fixture.base_fixture));
    const invalidBundle = applyMutations(base, fixture.mutations);
    const result = validator.validateDocumentBundle(invalidBundle);
    assert.equal(result.valid, false, `${fixture.case_id} unexpectedly passed`);
    for (const expected of fixture.expected_issues) {
      assert.ok(
        result.referenceErrors.some(
          (issue) =>
            issue.code === expected.code &&
            issue.instancePath.endsWith(expected.instance_path_suffix),
        ),
        `${fixture.case_id} missing ${JSON.stringify(expected)} in ${JSON.stringify(result)}`,
      );
    }
  }
});

test("validator output is byte-stable for repeated schema and reference failures", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const invalidEvent = await readJson(
    path.join(repositoryRoot, "tests/fixtures/cli/invalid-event.json"),
  );
  const firstDocumentResult = validator.validateDocument(invalidEvent, "invalid-event.json");
  const secondDocumentResult = validator.validateDocument(invalidEvent, "invalid-event.json");
  assert.equal(JSON.stringify(firstDocumentResult), JSON.stringify(secondDocumentResult));

  const referenceCase = await readJson<NegativeReferenceCase>(
    path.join(referenceFixtureRoot, "negative/missing-gap-fragment.json"),
  );
  const base = await readJson(path.join(referenceFixtureRoot, referenceCase.base_fixture));
  const invalidBundle = applyMutations(base, referenceCase.mutations);
  assert.equal(
    JSON.stringify(validator.validateDocumentBundle(invalidBundle)),
    JSON.stringify(validator.validateDocumentBundle(invalidBundle)),
  );
});

test("Harness and Skill validate-artifact entries return structured success and failure", () => {
  const commands = [
    [
      "harness/src/cli.ts",
      "validate-artifact",
      "--file",
      "tests/fixtures/schemas/positive/event.json",
      "--json",
    ],
    [
      ".agents/skills/startup-opportunity/scripts/validate-artifact.ts",
      "--bundle",
      "tests/fixtures/references/valid-document-bundle.json",
      "--json",
    ],
  ];

  for (const args of commands) {
    const result = spawnSync(process.execPath, ["--import", "tsx", ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal((JSON.parse(result.stdout) as { valid?: boolean }).valid, true);
  }

  const invalid = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      ".agents/skills/startup-opportunity/scripts/validate-artifact.ts",
      "--file",
      "tests/fixtures/cli/invalid-event.json",
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(invalid.status, 1, invalid.stderr);
  const failure = JSON.parse(invalid.stdout) as { valid?: boolean; errors?: ValidationIssue[] };
  assert.equal(failure.valid, false);
  assert.ok(
    failure.errors?.some(
      (issue) => issue.keyword === "enum" && issue.instancePath === "/event_type",
    ),
  );
});

test("validator rejects unpublished schema versions and malformed command arguments", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const unknown = validator.validateDocument({ schema_version: "startup_opportunity.future.v1" });
  assert.equal(unknown.valid, false);
  assert.equal(unknown.errors[0]?.code, "schema.unknown_version");

  const invalidCommand = spawnSync(
    process.execPath,
    ["--import", "tsx", "harness/src/cli.ts", "validate-artifact", "--unknown"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(invalidCommand.status, 64);
  const response = JSON.parse(invalidCommand.stderr) as { status?: string };
  assert.equal(response.status, "invalid_arguments");
});

test("G2.2 Scheme A bundle installs a closed pre-thesis candidate contract", async () => {
  const schema = await inspectSchemaBundle(repositoryRoot);
  assert.equal(schema.schemaBundleVersion, "14.0.0");
  assert.equal(schema.schemaCount, 155);
  assert.equal(schema.documentSchemaCount, 146);

  const validator = await createArtifactValidator(repositoryRoot);
  const policy = await readJson<Record<string, unknown>>(
    path.join(repositoryRoot, "harness/policies/discovery-candidates.v1.json"),
  );
  const policyResult = validator.validateDocument(
    policy,
    "harness/policies/discovery-candidates.v1.json",
  );
  assert.equal(policyResult.valid, true, JSON.stringify(policyResult.errors));

  const bundle = await createDiscoveryCandidateFixture();
  const result = validator.validateDocumentBundle(bundle);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(
    result.documents.filter(
      (entry) => entry.artifactSchemaVersion === "startup_opportunity.artifact_envelope.v9",
    ).length,
    24,
  );
  const candidateKinds = bundle.documents
    .map((entry) => fixtureEffective(bundle, entry.path))
    .filter((document) => document.schema_version === "startup_opportunity.discovery_candidate.v1")
    .map((document) => String(document.candidate_kind));
  assert.deepEqual([...new Set(candidateKinds)].sort(), [
    "baseline_seed",
    "demand_seed",
    "solution_seed",
  ]);
});

test("G2.2 blocker mutations fail for their declared deterministic contract code", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const cases = await readJson<readonly G22NegativeCase[]>(
    path.join(g22FixtureRoot, "discovery-candidate-cases.json"),
  );
  assert.equal(cases.length, 36);

  for (const fixtureCase of cases) {
    const bundle = await createDiscoveryCandidateFixture();
    applyG22Mutation(bundle, fixtureCase);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, false, `${fixtureCase.case_id} unexpectedly passed`);
    assert.ok(
      allIssueCodes(result).includes(fixtureCase.expected_code),
      `${fixtureCase.case_id} missing ${fixtureCase.expected_code}: ${JSON.stringify(result)}`,
    );
  }
});

test("G2.2 lane terminal classes preserve partial results and exclude failed or late influence", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  const classificationField: Readonly<Record<string, string>> = {
    partial: "partial_refs",
    insufficient_evidence: "insufficient_evidence_refs",
    failed: "failed_refs",
    ignored_late: "ignored_late_refs",
    superseded: "superseded_refs",
  };

  for (const status of Object.keys(classificationField)) {
    const bundle = await createDiscoveryCandidateFixture();
    const lane = fixtureEffective(bundle, G22_EVALUATION_LANE);
    const fanIn = fixtureEffective(bundle, G22_FAN_IN);
    const classification = fanIn.lane_result_classification as Record<string, unknown>;
    lane.status = status;
    classification.completed_refs = [
      ...(classification.completed_refs as string[]).filter((ref) => ref !== G22_EVALUATION_LANE),
    ];
    classification[classificationField[status] ?? ""] = [G22_EVALUATION_LANE];

    const excluded = ["failed", "ignored_late", "superseded"].includes(status);
    if (excluded) {
      lane.scored_candidates = [];
      lane.pre_kill_decisions = [];
      lane.retained_candidate_refs = [];
      lane.watchlist_candidate_refs = [];
      lane.rejected_candidate_refs = [];
      const decisions = fanIn.candidate_dispositions as Record<string, unknown>[];
      for (const decision of decisions) {
        decision.supporting_lane_result_refs = (
          decision.supporting_lane_result_refs as string[]
        ).filter((ref) => ref !== G22_EVALUATION_LANE);
      }
    }

    fixtureEntry(bundle, G22_EVALUATION_LANE).content_hash = canonicalContentHash(lane);
    fixtureEntry(bundle, G22_FAN_IN).content_hash = canonicalContentHash(fanIn);
    const result = validator.validateDocumentBundle(bundle);
    if (excluded) {
      assert.equal(result.valid, false, `${status} influenced current candidate unexpectedly`);
      assert.ok(
        allIssueCodes(result).includes("discovery_candidate.fan_in_candidate_lineage_mismatch"),
        JSON.stringify(result),
      );
    } else {
      assert.equal(result.valid, true, `${status}: ${JSON.stringify(result)}`);
    }
  }
});

test("v9 remains validation-only while v10 owns G2.2 runtime publication", async () => {
  const validator = await createArtifactValidator(repositoryRoot);
  assert.throws(
    () => validator.publicationAdapter("startup_opportunity.artifact_envelope.v9"),
    (error: unknown) =>
      error instanceof StoreError && error.code === "artifact.envelope_unsupported",
  );

  const candidate = fixtureEntry(await createDiscoveryCandidateFixture(), G22_DEMAND_R2);
  const result = validator.validateDocument(candidate, G22_DEMAND_R2);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(validator.publicationPolicy.document.current_schema_bundle_version, "14.0.0");
  assert.equal(validator.publicationPolicy.document.adapters.length, 14);
  assert.equal(
    validator.publicationAdapter("startup_opportunity.artifact_envelope.v10")
      .document_bundle_version,
    "startup_opportunity.document_bundle.v10",
  );
});

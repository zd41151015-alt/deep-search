import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  inspectCurrentContract,
  inspectCurrentContractSource,
} from "../harness/src/validators/current-contract.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

test("production exposes one current schema graph without version-selection structures", async () => {
  const result = await inspectCurrentContract(repositoryRoot);
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  assert.equal(result.schemaReferenceClosureCount, result.manifestSchemaCount);
  assert.ok(result.schemaRootCount > 0);
  assert.ok(result.artifactTypeCount > 0);
  assert.ok(result.activePolicyCount > 0);
});

test("architecture guard rejects retired Store compatibility and version-selection structures", () => {
  const cases = [
    [
      "numbered receipt",
      'const receipt = "startup_opportunity.artifact_store_operation.v17";',
      "numbered Artifact Store operation receipt",
    ],
    [
      "numbered publication policy",
      'const policy = "startup_opportunity.research_publication_policy.v14";',
      "numbered research publication policy",
    ],
    ["adapter registry", "const adaptersByEnvelope = new Map();", "Store publication adapter"],
    [
      "adapter policy field",
      'const policy = { "adapters": [currentAdapter] };',
      "Store publication adapter",
    ],
    [
      "base publication policy chain",
      'const base_policy_binding = { policy_ref: "research-publication.v13.json" };',
      "publication policy base chain",
    ],
    [
      "compatibility fallback",
      "const compatibilityFallback = selectOldEnvelope;",
      "Store compatibility fallback",
    ],
    [
      "compatibility publication requirement",
      'const policy = { "publish_requires_compatible_envelope": true };',
      "Store compatibility fallback",
    ],
    [
      "highest bundle selector",
      "function highestBundleForEnvelopes() {}",
      "highest Store contract version selection",
    ],
    [
      "Store version union",
      'type StoreEnvelopeVersion = "startup_opportunity.artifact_envelope.current";',
      "Store contract version registry or selector",
    ],
    [
      "Store version selector",
      "function selectDocumentBundleVersion() {}",
      "Store contract version registry or selector",
    ],
    [
      "Store version registry",
      "const publicationPolicyVersions = new Set<string>();",
      "Store contract version registry or selector",
    ],
  ] as const;

  for (const [name, source, expectedStructure] of cases) {
    const issues = inspectCurrentContractSource(`negative/${name}.ts`, source);
    assert.ok(
      issues.some((candidate) => candidate.details.structure === expectedStructure),
      `${name}: ${JSON.stringify(issues, null, 2)}`,
    );
  }
});

test("architecture guard permits numbered contracts with distinct current business semantics", () => {
  const source = `
    const candidate = "startup_opportunity.discovery_candidate.v2";
    const base_policy_bindings = ["adaptation.v1.json"];
    const latestRevisionById = new Map<string, number>();
  `;

  assert.deepEqual(inspectCurrentContractSource("positive/domain-contract.ts", source), []);
});

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type ContractFileChange,
  changedJsonPointers,
  inspectContractImpact,
} from "../harness/src/validators/contract-impact.js";
import {
  inspectCurrentContract,
  inspectCurrentContractSource,
} from "../harness/src/validators/current-contract.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const ownershipRegistryPath = "harness/contracts/current-ownership.json";

interface MutableRegistryFamily {
  id: string;
  artifactTypeSelectors: { prefix: string }[];
  directRuntimeRoots: string[];
  ownerModules: string[];
  testScripts: string[];
}

interface MutableOwnershipRegistry {
  families: MutableRegistryFamily[];
}

async function copyCurrentContractSurface(context: TestContext): Promise<string> {
  const copyRoot = await mkdtemp(path.join(tmpdir(), "startup-opportunity-ownership-registry-"));
  context.after(() => rm(copyRoot, { recursive: true, force: true }));
  await Promise.all([
    cp(path.join(repositoryRoot, "harness"), path.join(copyRoot, "harness"), { recursive: true }),
    cp(path.join(repositoryRoot, "tests"), path.join(copyRoot, "tests"), { recursive: true }),
    cp(path.join(repositoryRoot, "package.json"), path.join(copyRoot, "package.json")),
  ]);
  return copyRoot;
}

async function mutateOwnershipRegistry(
  root: string,
  mutate: (registry: MutableOwnershipRegistry) => void,
): Promise<void> {
  const registryFile = path.join(root, ownershipRegistryPath);
  const registry = JSON.parse(await readFile(registryFile, "utf8")) as MutableOwnershipRegistry;
  mutate(registry);
  await writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
}

interface EnvelopeRule {
  readonly if: {
    readonly properties: {
      readonly artifact_type: {
        readonly const?: string;
        readonly enum?: readonly string[];
      };
    };
  };
  readonly then: {
    readonly required?: readonly string[];
    readonly properties?: {
      readonly producer_role?: { readonly const?: string };
      readonly artifact_path?: Readonly<Record<string, unknown>>;
    };
  };
}

function rulesFor(rules: readonly EnvelopeRule[], artifactType: string): readonly EnvelopeRule[] {
  return rules.filter((rule) => {
    const condition = rule.if.properties.artifact_type;
    return condition.const === artifactType || condition.enum?.includes(artifactType) === true;
  });
}

test("production exposes one current schema graph without version-selection structures", async () => {
  const result = await inspectCurrentContract(repositoryRoot);
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  assert.equal(result.schemaReferenceClosureCount, result.manifestSchemaCount);
  assert.ok(result.schemaRootCount > 0);
  assert.ok(result.artifactTypeCount > 0);
  assert.ok(result.activePolicyCount > 0);
  assert.ok(result.registryFamilyCount > 0);
  assert.equal(result.registeredArtifactTypeCount, result.artifactTypeCount);
  assert.equal(result.registeredDirectRuntimeRootCount, 13);
});

test("ownership registry rejects a missing formal Artifact type owner", async (context) => {
  const copyRoot = await copyCurrentContractSurface(context);
  await mutateOwnershipRegistry(copyRoot, (registry) => {
    const family = registry.families.find((candidate) => candidate.id === "assessment_research");
    assert.ok(family);
    family.artifactTypeSelectors = [{ prefix: "current/unregistered/" }];
  });

  const result = await inspectCurrentContract(copyRoot);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (candidate) => candidate.code === "current_contract.registry_artifact_type_unowned",
    ),
    JSON.stringify(result, null, 2),
  );
});

test("ownership registry rejects duplicate formal Artifact type owners", async (context) => {
  const copyRoot = await copyCurrentContractSurface(context);
  await mutateOwnershipRegistry(copyRoot, (registry) => {
    const family = registry.families.find((candidate) => candidate.id === "ai_research");
    assert.ok(family);
    family.artifactTypeSelectors.push({ prefix: "current/assessment/" });
  });

  const result = await inspectCurrentContract(copyRoot);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (candidate) => candidate.code === "current_contract.registry_artifact_type_overlap",
    ),
    JSON.stringify(result, null, 2),
  );
});

test("ownership registry rejects a stale production module", async (context) => {
  const copyRoot = await copyCurrentContractSurface(context);
  await mutateOwnershipRegistry(copyRoot, (registry) => {
    const family = registry.families.find((candidate) => candidate.id === "store_publication");
    assert.ok(family);
    family.ownerModules.push("harness/src/artifact-store/removed-owner.ts");
  });

  const result = await inspectCurrentContract(copyRoot);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (candidate) =>
        candidate.code === "current_contract.registry_path_stale" &&
        candidate.details.path === "harness/src/artifact-store/removed-owner.ts",
    ),
    JSON.stringify(result, null, 2),
  );
});

test("ownership registry rejects a stale focused test command", async (context) => {
  const copyRoot = await copyCurrentContractSurface(context);
  await mutateOwnershipRegistry(copyRoot, (registry) => {
    const family = registry.families.find((candidate) => candidate.id === "discovery_research");
    assert.ok(family);
    family.testScripts.push("test:removed-contract-suite");
  });

  const result = await inspectCurrentContract(copyRoot);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (candidate) =>
        candidate.code === "current_contract.registry_test_command_stale" &&
        candidate.details.script === "test:removed-contract-suite",
    ),
    JSON.stringify(result, null, 2),
  );
});

test("ownership registry rejects an unregistered direct Runtime root", async (context) => {
  const copyRoot = await copyCurrentContractSurface(context);
  const missingRoot = "startup_opportunity.evidence_store_record.v2";
  await mutateOwnershipRegistry(copyRoot, (registry) => {
    const family = registry.families.find((candidate) => candidate.id === "assessment_research");
    assert.ok(family);
    family.directRuntimeRoots = family.directRuntimeRoots.filter((root) => root !== missingRoot);
  });

  const result = await inspectCurrentContract(copyRoot);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (candidate) =>
        candidate.code === "current_contract.registry_runtime_root_unowned" &&
        candidate.details.schemaVersion === missingRoot,
    ),
    JSON.stringify(result, null, 2),
  );
});

const unknownContractChange: ContractFileChange = {
  status: "modified",
  path: "harness/src/unregistered-contract-surface.ts",
  changedJsonPointers: [],
  structuralComparison: "not_json",
};

test("unknown contract impact is explicit and conservatively broad", async () => {
  const result = await inspectContractImpact({
    root: repositoryRoot,
    baseRef: "synthetic-base",
    baseRevision: "synthetic-base-revision",
    currentRevision: "synthetic-current-revision",
    changes: [unknownContractChange],
  });

  assert.equal(result.topologyValid, true, JSON.stringify(result.topologyIssues, null, 2));
  assert.equal(result.unknownImpact.length, 1);
  assert.equal(result.unknownImpact[0]?.path, unknownContractChange.path);
  assert.equal(result.affectedFamilies.length, 7);
  assert.deepEqual(result.recommendedFocusedTests, [
    "npm run lint",
    "npm run typecheck",
    "npm test",
    "npm run validate:schemas",
    "npm run validate:current-contract",
    "npm run validate:fixtures",
    "npm run verify:skeleton",
    "git diff --check",
  ]);
});

test("contract impact and structural JSON pointers are deterministic", async () => {
  const structuralChange: ContractFileChange = {
    status: "modified",
    path: "harness/schemas/current/core/definitions.schema.json",
    changedJsonPointers: ["/$defs/evidence_role/enum/2"],
    structuralComparison: "compared",
  };
  const options = {
    root: repositoryRoot,
    baseRef: "synthetic-base",
    baseRevision: "synthetic-base-revision",
    currentRevision: "synthetic-current-revision",
    changes: [structuralChange],
  } as const;
  const first = await inspectContractImpact(options);
  const second = await inspectContractImpact(options);

  assert.deepEqual(second, first);
  assert.deepEqual(
    changedJsonPointers(
      { properties: { state: { enum: ["partial", "unknown"] } } },
      { properties: { state: { enum: ["partial", "unavailable", "unknown"] } } },
    ),
    ["/properties/state/enum/1", "/properties/state/enum/2"],
  );
  assert.ok((first.changedSchemas[0]?.reverseReferences.length ?? 0) > 0);
  assert.ok(first.affectedFamilies.some((family) => family.id === "run_control_planning"));
  assert.equal(first.unknownImpact.length, 0);
});

test("current contract rejects missing and unlisted policy files", async (context) => {
  const copyRoot = await mkdtemp(path.join(tmpdir(), "startup-opportunity-current-contract-"));
  context.after(() => rm(copyRoot, { recursive: true, force: true }));
  await cp(path.join(repositoryRoot, "harness"), path.join(copyRoot, "harness"), {
    recursive: true,
  });
  await rm(path.join(copyRoot, "harness/policies/adaptation.current.json"));
  await writeFile(
    path.join(copyRoot, "harness/policies/unlisted.current.json"),
    `${JSON.stringify({ schema_version: "startup_opportunity.adaptation_policy.current" })}\n`,
  );

  const result = await inspectCurrentContract(copyRoot);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (candidate) =>
        candidate.code === "current_contract.policy_set_mismatch" &&
        Array.isArray(candidate.details.missingPolicies) &&
        candidate.details.missingPolicies.includes("harness/policies/adaptation.current.json") &&
        Array.isArray(candidate.details.unlistedPolicies) &&
        candidate.details.unlistedPolicies.includes("harness/policies/unlisted.current.json"),
    ),
    JSON.stringify(result, null, 2),
  );
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

test("architecture guard permits ordinary domain compatibility fields", () => {
  const source = JSON.stringify({
    type: "object",
    properties: { compatibility: { type: "string" } },
  });

  assert.deepEqual(inspectCurrentContractSource("positive/domain-schema.json", source), []);
});

test("current Envelope retains grouped ownership, path, and required-field constraints", async () => {
  const envelope = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "harness/schemas/current/store/artifact-envelope.schema.json"),
      "utf8",
    ),
  ) as { readonly allOf: readonly EnvelopeRule[] };

  const ownershipGroups = {
    lane_researcher: [
      "startup_opportunity.ai_adoption_trust.v1",
      "startup_opportunity.ai_capability_benchmark.v1",
      "startup_opportunity.ai_data_dependency.v1",
      "startup_opportunity.ai_evaluation_reliability.v1",
      "startup_opportunity.ai_inference_unit_economics.v1",
      "startup_opportunity.capability_commoditization_risk.v1",
      "startup_opportunity.capability_evidence.v1",
      "startup_opportunity.evidence.discovery_evaluation.current",
      "startup_opportunity.claim.discovery_evaluation.current",
      "startup_opportunity.finding.discovery_evaluation.current",
      "startup_opportunity.insight.discovery_evaluation.current",
      "startup_opportunity.judgment_assessment.discovery_evaluation.current",
      "startup_opportunity.source_manifest.discovery_evaluation.current",
      "startup_opportunity.enrichment_branch_result.v1",
    ],
    main_agent: [
      "startup_opportunity.decision_subject_snapshot.current",
      "startup_opportunity.enrichment_fan_in.v1",
      "startup_opportunity.business_engine_thesis.discovery_evaluation.current",
      "startup_opportunity.buyer_purchase_language.v1",
      "startup_opportunity.portfolio_view.v1",
      "startup_opportunity.sensitivity.v1",
      "startup_opportunity.user_state_context_model.v1",
      "startup_opportunity.value_layer_analysis.v1",
      "startup_opportunity.opportunity_comparison.v1",
      "startup_opportunity.decision_recommendation.v1",
      "startup_opportunity.traceability.discovery.current",
      "startup_opportunity.report.v1",
    ],
    harness: [
      "startup_opportunity.decision_brief.discovery.current",
      "startup_opportunity.discovery_report_view.v1",
      "startup_opportunity.report_consistency_evaluation.discovery.current",
      "startup_opportunity.checkpoint.v1",
      "startup_opportunity.commercial_research_audit.current",
    ],
  } as const;
  for (const [role, artifactTypes] of Object.entries(ownershipGroups)) {
    for (const artifactType of artifactTypes) {
      assert.ok(
        rulesFor(envelope.allOf, artifactType).some(
          (rule) => rule.then.properties?.producer_role?.const === role,
        ),
        `${artifactType} must retain ${role} ownership`,
      );
    }
  }

  const pathConstraints = {
    "startup_opportunity.decision_subject_snapshot.current": {
      type: "string",
      pattern: "^artifacts/reporting/decision-subject-snapshot\\.r[1-9][0-9]*\\.json$",
    },
    "startup_opportunity.adaptation_decision.discovery.current": {
      type: "string",
      pattern: "^adaptations/decisions/.+\\.json$",
    },
    "startup_opportunity.assessment_evidence.v1": {
      type: "string",
      pattern: "^evidence/records/ev_[a-f0-9]{64}\\.json$",
    },
    "startup_opportunity.assessment_followup_decision.v1": {
      type: "string",
      pattern: "^adaptations/decisions/[A-Za-z0-9][A-Za-z0-9._-]*\\.json$",
    },
    "startup_opportunity.assessment_lane_result.v1": {
      type: "string",
      pattern:
        "^artifacts/assessment/lanes/[A-Za-z0-9][A-Za-z0-9._-]*\\.attempt-[1-9][0-9]*\\.json$",
    },
    "startup_opportunity.assessment_stage_gate.v1": {
      type: "string",
      pattern: "^artifacts/assessment/gates/[A-Za-z0-9][A-Za-z0-9._-]*\\.r[1-9][0-9]*\\.json$",
    },
    "startup_opportunity.candidate_neutral_evidence.v1": {
      type: "string",
      pattern: "^evidence/discovery/generation/.+\\.json$",
    },
    "startup_opportunity.commercial_research_audit.current": {
      type: "string",
      pattern: "^artifacts/research-audits/[A-Za-z0-9][A-Za-z0-9._-]*\\.json$",
    },
    "startup_opportunity.concept_hypothesis.assessment_intake.current": {
      const: "concept-hypothesis.json",
    },
    "startup_opportunity.discovery_generation_result.v1": {
      type: "string",
      pattern: "^artifacts/discovery/generation/.+\\.json$",
    },
    "startup_opportunity.discovery_stage_readiness.v1": {
      type: "string",
      pattern: "^artifacts/discovery/readiness/.+\\.r[1-9][0-9]*\\.json$",
    },
    "startup_opportunity.dispatch_batch.discovery.current": {
      type: "string",
      pattern: "^tasks/dispatch/[A-Za-z0-9][A-Za-z0-9._-]*\\.r1\\.json$",
    },
    "startup_opportunity.dispatch_batch.assessment.current": {
      type: "string",
      pattern: "^tasks/dispatch/[A-Za-z0-9][A-Za-z0-9._-]*\\.r1\\.json$",
    },
    "startup_opportunity.gap_snapshot.discovery.readiness.current": {
      type: "string",
      pattern: "^adaptations/gap-snapshots/.+\\.json$",
    },
    "startup_opportunity.lane_lifecycle.v1": {
      type: "string",
      pattern: "^artifacts/runtime/lane-lifecycle/.+\\.r[1-9][0-9]*\\.json$",
    },
    "startup_opportunity.research_execution_plan.discovery.current": {
      type: "string",
      pattern: "^plans/research-execution\\.r[1-9][0-9]*\\.json$",
    },
    "startup_opportunity.research_execution_plan.assessment.current": {
      type: "string",
      pattern: "^plans/research-execution\\.r[1-9][0-9]*\\.json$",
    },
    "startup_opportunity.source_manifest.discovery_runtime.current": {
      type: "string",
      pattern: "^evidence/source-manifests/discovery/.+\\.json$",
    },
    "startup_opportunity.terminal_report_source.v1": {
      type: "string",
      pattern: "^artifacts/reporting/terminal-report-source\\.r[1-9][0-9]*\\.json$",
    },
  } as const;
  for (const [artifactType, expected] of Object.entries(pathConstraints)) {
    const actual = rulesFor(envelope.allOf, artifactType)
      .map((rule) => rule.then.properties?.artifact_path)
      .find((constraint) => constraint !== undefined);
    assert.deepEqual(actual, expected, `${artifactType} path constraint drifted`);
  }

  const producerRole = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "harness/schemas/current/store/artifact-envelope.schema.json"),
      "utf8",
    ),
  ) as { properties: { producer_role: { enum: readonly string[] } } };
  assert.ok(producerRole.properties.producer_role.enum.includes("lane_researcher"));
  assert.ok(!producerRole.properties.producer_role.enum.includes("lane-researcher"));

  for (const artifactType of [
    "startup_opportunity.opportunity_comparison.v1",
    "startup_opportunity.decision_recommendation.v1",
    "startup_opportunity.traceability.discovery.current",
    "startup_opportunity.report.v1",
    "startup_opportunity.decision_brief.discovery.current",
    "startup_opportunity.discovery_report_view.v1",
    "startup_opportunity.report_consistency_evaluation.discovery.current",
  ]) {
    assert.ok(
      rulesFor(envelope.allOf, artifactType).some((rule) =>
        rule.then.required?.includes("ai_bundle_binding"),
      ),
      `${artifactType} must require ai_bundle_binding`,
    );
  }
});

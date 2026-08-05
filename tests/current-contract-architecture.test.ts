import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  inspectCurrentContract,
  inspectCurrentContractSource,
} from "../harness/src/validators/current-contract.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

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
      path.join(repositoryRoot, "harness/schemas/current/artifact-envelope.schema.json"),
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
      "startup_opportunity.evidence.v3",
      "startup_opportunity.claim.v3",
      "startup_opportunity.finding.v3",
      "startup_opportunity.insight.v3",
      "startup_opportunity.judgment_assessment.v3",
      "startup_opportunity.source_manifest.v3",
      "startup_opportunity.enrichment_branch_result.v1",
      "startup_opportunity.commercial_research_audit.current",
    ],
    main_agent: [
      "startup_opportunity.enrichment_fan_in.v1",
      "startup_opportunity.business_engine_thesis.v2",
      "startup_opportunity.buyer_purchase_language.v1",
      "startup_opportunity.portfolio_view.v1",
      "startup_opportunity.sensitivity.v1",
      "startup_opportunity.user_state_context_model.v1",
      "startup_opportunity.value_layer_analysis.v1",
      "startup_opportunity.opportunity_comparison.v1",
      "startup_opportunity.decision_recommendation.v1",
      "startup_opportunity.traceability.v2",
      "startup_opportunity.report.v1",
    ],
    harness: [
      "startup_opportunity.decision_brief.v2",
      "startup_opportunity.discovery_report_view.v1",
      "startup_opportunity.report_consistency_evaluation.v3",
      "startup_opportunity.checkpoint.v1",
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
    "startup_opportunity.concept_hypothesis.v2": { const: "concept-hypothesis.json" },
    "startup_opportunity.discovery_generation_result.v1": {
      type: "string",
      pattern: "^artifacts/discovery/generation/.+\\.json$",
    },
    "startup_opportunity.discovery_stage_readiness.v1": {
      type: "string",
      pattern: "^artifacts/discovery/readiness/.+\\.r[1-9][0-9]*\\.json$",
    },
    "startup_opportunity.dispatch_batch.v1": {
      type: "string",
      pattern: "^tasks/dispatch/[A-Za-z0-9][A-Za-z0-9._-]*\\.r1\\.json$",
    },
    "startup_opportunity.dispatch_batch.v2": {
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
    "startup_opportunity.research_execution_plan.v1": {
      type: "string",
      pattern: "^plans/research-execution\\.r[1-9][0-9]*\\.json$",
    },
    "startup_opportunity.research_execution_plan.v2": {
      type: "string",
      pattern: "^plans/research-execution\\.r[1-9][0-9]*\\.json$",
    },
    "startup_opportunity.source_manifest.v4": {
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
      path.join(repositoryRoot, "harness/schemas/current/artifact-envelope.schema.json"),
      "utf8",
    ),
  ) as { properties: { producer_role: { enum: readonly string[] } } };
  assert.ok(producerRole.properties.producer_role.enum.includes("lane_researcher"));
  assert.ok(!producerRole.properties.producer_role.enum.includes("lane-researcher"));

  for (const artifactType of [
    "startup_opportunity.opportunity_comparison.v1",
    "startup_opportunity.decision_recommendation.v1",
    "startup_opportunity.traceability.v2",
    "startup_opportunity.report.v1",
    "startup_opportunity.decision_brief.v2",
    "startup_opportunity.discovery_report_view.v1",
    "startup_opportunity.report_consistency_evaluation.v3",
  ]) {
    assert.ok(
      rulesFor(envelope.allOf, artifactType).some((rule) =>
        rule.then.required?.includes("ai_bundle_binding"),
      ),
      `${artifactType} must require ai_bundle_binding`,
    );
  }
});

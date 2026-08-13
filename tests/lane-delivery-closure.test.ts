import assert from "node:assert/strict";
import test from "node:test";
import { canonicalContentHash, deriveLaneScopeFormalClosure } from "../harness/src/index.js";

const evidence = {
  artifact_ref: "evidence/records/ev_scope.json",
  artifact_type: "startup_opportunity.evidence.assessment.current",
  content_hash: "",
  document: {
    schema_version: "startup_opportunity.evidence.assessment.current",
    evidence_id: "ev_scope",
    mechanical_binding: {
      substrate_record_ref: "evidence/manifest.jsonl#ev_scope",
    },
  },
};
evidence.content_hash = canonicalContentHash(evidence.document);

const auditDocument = {
  schema_version: "startup_opportunity.commercial_research_audit.current",
  coverage: {
    purchase_signal: {
      state: "observed",
      content_covered: true,
      evidence_refs: [evidence.artifact_ref],
    },
  },
  quantitative_coverage: [
    {
      subject_id: "subject_1",
      metric_family: "demand_scale",
      state: "observed",
      observation_ids: ["observation_demand"],
    },
  ],
  quantitative_observations: [
    {
      observation_id: "observation_demand",
      evidence_refs: [evidence.artifact_ref],
    },
  ],
  competitive_coverage: [
    {
      subject_id: "subject_1",
      competitor_type: "direct_product",
      state: "observed",
      competitive_object_ids: ["competitor_direct"],
    },
  ],
  competitive_objects: [
    {
      competitive_object_id: "competitor_direct",
      source_refs: [evidence.artifact_ref],
    },
  ],
  incumbent_response_coverage: [
    {
      subject_id: "subject_1",
      state: "assessed",
      assessment_ids: ["incumbent_assessment_1"],
    },
  ],
  incumbent_response_assessments: [
    {
      assessment_id: "incumbent_assessment_1",
      semantic: {
        supporting_evidence_refs: [evidence.artifact_ref],
        opposing_evidence_refs: [],
        background_evidence_refs: [],
      },
    },
  ],
  search_closure: { remaining_gaps: [] },
};
const audit = {
  artifact_ref: "artifacts/research-audits/unit_scope.json",
  artifact_type: "startup_opportunity.commercial_research_audit.current",
  content_hash: canonicalContentHash(auditDocument),
  document: auditDocument,
};

test("commercial scope closure binds exact typed Evidence and field identities", () => {
  const scopeKeys = [
    "purchase_signal",
    "quantitative:demand_scale",
    "competitive:direct_product",
    "incumbent_response",
  ];
  const result = deriveLaneScopeFormalClosure(
    scopeKeys.map((scopeKey) => ({
      scope_key: scopeKey,
      status: "covered" as const,
      evidence_refs: ["evidence/manifest.jsonl#ev_scope"],
    })),
    [audit, evidence],
    [audit.artifact_ref],
  );
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.closure.map((entry) => [entry.scope_key, entry.disposition]),
    [
      ["competitive:direct_product", "covered"],
      ["incumbent_response", "covered"],
      ["purchase_signal", "covered"],
      ["quantitative:demand_scale", "covered"],
    ],
  );
  for (const entry of result.closure) {
    assert.deepEqual(entry.evidence_bindings, [
      {
        evidence_ref: evidence.artifact_ref,
        artifact_type: evidence.artifact_type,
        content_hash: evidence.content_hash,
        substrate_record_ref: "evidence/manifest.jsonl#ev_scope",
      },
    ]);
    assert.ok(
      entry.semantic_bindings.some(
        (binding) =>
          binding.artifact_ref === audit.artifact_ref &&
          binding.content_hash === audit.content_hash &&
          binding.semantic_path !== "/",
      ),
    );
  }
});

test("commercial scope closure preserves Evidence traceability without overstating incomplete coverage", () => {
  const incompleteAuditDocument = structuredClone(auditDocument);
  incompleteAuditDocument.coverage.purchase_signal = {
    ...incompleteAuditDocument.coverage.purchase_signal,
    state: "unknown",
    content_covered: false,
  };
  const quantitativeCoverage = incompleteAuditDocument.quantitative_coverage[0];
  const competitiveCoverage = incompleteAuditDocument.competitive_coverage[0];
  assert.ok(quantitativeCoverage);
  assert.ok(competitiveCoverage);
  quantitativeCoverage.state = "partial";
  competitiveCoverage.state = "unavailable";
  const incompleteAudit = {
    ...audit,
    content_hash: canonicalContentHash(incompleteAuditDocument),
    document: incompleteAuditDocument,
  };
  const result = deriveLaneScopeFormalClosure(
    ["purchase_signal", "quantitative:demand_scale", "competitive:direct_product"].map(
      (scopeKey) => ({
        scope_key: scopeKey,
        status: "partial" as const,
        evidence_refs: ["evidence/manifest.jsonl#ev_scope"],
      }),
    ),
    [incompleteAudit, evidence],
    [incompleteAudit.artifact_ref],
  );
  assert.deepEqual(result.issues, []);
  assert.ok(result.closure.every((entry) => entry.disposition === "partial"));
  assert.ok(result.closure.every((entry) => entry.evidence_bindings.length === 1));
});

test("commercial inferred content remains partial rather than becoming observed coverage", () => {
  const inferredDocument = structuredClone(auditDocument);
  inferredDocument.coverage.purchase_signal = {
    state: "inferred",
    content_covered: true,
    evidence_refs: [evidence.artifact_ref],
  };
  const inferredAudit = {
    ...audit,
    content_hash: canonicalContentHash(inferredDocument),
    document: inferredDocument,
  };
  const result = deriveLaneScopeFormalClosure(
    [
      {
        scope_key: "purchase_signal",
        status: "partial",
        evidence_refs: ["evidence/manifest.jsonl#ev_scope"],
      },
    ],
    [inferredAudit, evidence],
    [inferredAudit.artifact_ref],
  );
  assert.deepEqual(result.issues, []);
  assert.equal(result.closure[0]?.disposition, "partial");
});

test("commercial unavailable coverage remains partial even when no Evidence was acquired", () => {
  const unavailableDocument = structuredClone(auditDocument);
  const originalCoverage = unavailableDocument.quantitative_coverage[0];
  assert.ok(originalCoverage);
  unavailableDocument.quantitative_coverage[0] = {
    ...originalCoverage,
    state: "unavailable",
    observation_ids: [],
  };
  unavailableDocument.quantitative_observations = [];
  const unavailableAudit = {
    ...audit,
    content_hash: canonicalContentHash(unavailableDocument),
    document: unavailableDocument,
  };
  const result = deriveLaneScopeFormalClosure(
    [
      {
        scope_key: "quantitative:demand_scale",
        status: "partial",
        evidence_refs: [],
      },
    ],
    [unavailableAudit],
    [unavailableAudit.artifact_ref],
  );
  assert.deepEqual(result.issues, []);
  assert.equal(result.closure[0]?.disposition, "partial");
  assert.deepEqual(result.closure[0]?.evidence_bindings, []);
});

test("Discovery scope closure binds authored per-scope semantics without spreading aggregate lineage", () => {
  const secondEvidenceDocument = {
    ...evidence.document,
    evidence_id: "ev_other",
    mechanical_binding: { substrate_record_ref: "evidence/manifest.jsonl#ev_other" },
  };
  const secondEvidence = {
    artifact_ref: "evidence/records/ev_other.json",
    artifact_type: evidence.artifact_type,
    content_hash: canonicalContentHash(secondEvidenceDocument),
    document: secondEvidenceDocument,
  };
  const laneDocument = {
    schema_version: "startup_opportunity.discovery_lane_result.v1",
    evidence_lineage: {
      evidence_refs: [evidence.artifact_ref, secondEvidence.artifact_ref],
    },
    scope_outcomes: [
      {
        scope_key: "demand",
        disposition: "covered",
        evidence_refs: [evidence.artifact_ref],
        claim_refs: [],
        finding_refs: [],
        judgment_assessment_refs: [],
      },
      {
        scope_key: "buyer",
        disposition: "partial",
        evidence_refs: [secondEvidence.artifact_ref],
        claim_refs: [],
        finding_refs: [],
        judgment_assessment_refs: [],
      },
    ],
  };
  const lane = {
    artifact_ref: "artifacts/discovery/lanes/unit_scope.json",
    artifact_type: "startup_opportunity.discovery_lane_result.v1",
    content_hash: canonicalContentHash(laneDocument),
    document: laneDocument,
  };
  const result = deriveLaneScopeFormalClosure(
    [
      {
        scope_key: "demand",
        status: "covered",
        evidence_refs: ["evidence/manifest.jsonl#ev_scope"],
      },
      {
        scope_key: "buyer",
        status: "partial",
        evidence_refs: ["evidence/manifest.jsonl#ev_other"],
      },
    ],
    [lane, evidence, secondEvidence],
    [lane.artifact_ref],
  );
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.closure.map((entry) => [
      entry.scope_key,
      entry.disposition,
      entry.evidence_bindings.map((binding) => binding.evidence_ref),
    ]),
    [
      ["buyer", "partial", [secondEvidence.artifact_ref]],
      ["demand", "covered", [evidence.artifact_ref]],
    ],
  );
});

test("Discovery partial scope may disclose unavailable research without claiming no Evidence was found", () => {
  const laneDocument = {
    schema_version: "startup_opportunity.discovery_lane_result.v1",
    evidence_lineage: {
      evidence_refs: [],
      claim_refs: [],
      finding_refs: [],
      judgment_assessment_refs: [],
    },
    scope_outcomes: [
      {
        scope_key: "buyer",
        disposition: "partial",
        evidence_refs: [],
        claim_refs: [],
        finding_refs: [],
        judgment_assessment_refs: [],
        notes: "The assigned route was unavailable; no complete buyer conclusion was formed.",
      },
    ],
  };
  const lane = {
    artifact_ref: "artifacts/discovery/lanes/unit_unavailable.json",
    artifact_type: "startup_opportunity.discovery_lane_result.v1",
    content_hash: canonicalContentHash(laneDocument),
    document: laneDocument,
  };
  const result = deriveLaneScopeFormalClosure(
    [{ scope_key: "buyer", status: "partial", evidence_refs: [] }],
    [lane],
    [lane.artifact_ref],
  );
  assert.deepEqual(result.issues, []);
  assert.equal(result.closure[0]?.disposition, "partial");
  assert.deepEqual(result.closure[0]?.evidence_bindings, []);
});

test("Assessment dimension closure rejects a no-Evidence claim contradicted by formal Evidence", () => {
  const laneDocument = {
    schema_version: "startup_opportunity.assessment_lane_result.v1",
    dimension_results: [
      {
        dimension_id: "demand_and_behavior",
        evidence_refs: [evidence.artifact_ref],
        supporting_claim_refs: [],
        opposing_claim_refs: [],
        judgment_assessment_refs: [],
        dimension_decision: "supports",
        decision_sufficiency: "sufficient",
      },
    ],
  };
  const lane = {
    artifact_ref: "artifacts/runtime/assessment-results/unit_scope.json",
    artifact_type: "startup_opportunity.assessment_lane_result.v1",
    content_hash: canonicalContentHash(laneDocument),
    document: laneDocument,
  };
  const result = deriveLaneScopeFormalClosure(
    [
      {
        scope_key: "demand_and_behavior",
        status: "no_evidence_found",
        evidence_refs: [],
      },
    ],
    [lane, evidence],
    [lane.artifact_ref],
  );
  assert.ok(
    result.issues.some((issue) => issue.code === "lane_delivery.scope_formal_disposition_mismatch"),
  );
  assert.equal(result.closure[0]?.disposition, "covered");
  assert.deepEqual(result.closure[0]?.evidence_bindings, [
    {
      evidence_ref: evidence.artifact_ref,
      artifact_type: evidence.artifact_type,
      content_hash: evidence.content_hash,
      substrate_record_ref: "evidence/manifest.jsonl#ev_scope",
    },
  ]);
  assert.equal(
    result.closure[0]?.semantic_bindings[0]?.semantic_identity,
    "dimension:demand_and_behavior",
  );
});

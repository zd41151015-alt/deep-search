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
  const result = deriveLaneScopeFormalClosure(scopeKeys, [audit, evidence], [audit.artifact_ref]);
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
    ["purchase_signal", "quantitative:demand_scale", "competitive:direct_product"],
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
    ["purchase_signal"],
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
    ["quantitative:demand_scale"],
    [unavailableAudit],
    [unavailableAudit.artifact_ref],
  );
  assert.deepEqual(result.issues, []);
  assert.equal(result.closure[0]?.disposition, "partial");
  assert.deepEqual(result.closure[0]?.evidence_bindings, []);
});

test("commercial multi-subject reducers treat observed or assessed plus not-applicable as complete", () => {
  const mixedDocument = structuredClone(auditDocument);
  mixedDocument.quantitative_coverage.push({
    subject_id: "subject_2",
    metric_family: "demand_scale",
    state: "not_applicable",
    observation_ids: [],
  });
  mixedDocument.competitive_coverage.push({
    subject_id: "subject_2",
    competitor_type: "direct_product",
    state: "not_applicable",
    competitive_object_ids: [],
  });
  mixedDocument.incumbent_response_coverage.push({
    subject_id: "subject_2",
    state: "not_applicable",
    assessment_ids: [],
  });
  const mixedAudit = {
    ...audit,
    content_hash: canonicalContentHash(mixedDocument),
    document: mixedDocument,
  };
  const result = deriveLaneScopeFormalClosure(
    ["quantitative:demand_scale", "competitive:direct_product", "incumbent_response"],
    [mixedAudit, evidence],
    [mixedAudit.artifact_ref],
  );
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.closure.map((entry) => [entry.scope_key, entry.disposition]),
    [
      ["competitive:direct_product", "covered"],
      ["incumbent_response", "covered"],
      ["quantitative:demand_scale", "covered"],
    ],
  );
  for (const entry of result.closure) {
    assert.equal(entry.semantic_bindings.length, 3);
    assert.ok(
      entry.semantic_bindings.some(
        (binding) =>
          binding.semantic_identity.includes("subject_2") &&
          binding.semantic_identity.endsWith(":not_applicable"),
      ),
    );
  }

  const partialDocument = structuredClone(mixedDocument);
  const quantitative = partialDocument.quantitative_coverage[1];
  const competitive = partialDocument.competitive_coverage[1];
  const incumbent = partialDocument.incumbent_response_coverage[1];
  assert.ok(quantitative);
  assert.ok(competitive);
  assert.ok(incumbent);
  quantitative.state = "unavailable";
  competitive.state = "partial";
  incumbent.state = "unknown";
  const partialAudit = {
    ...audit,
    content_hash: canonicalContentHash(partialDocument),
    document: partialDocument,
  };
  const partial = deriveLaneScopeFormalClosure(
    ["quantitative:demand_scale", "competitive:direct_product", "incumbent_response"],
    [partialAudit, evidence],
    [partialAudit.artifact_ref],
  );
  assert.deepEqual(partial.issues, []);
  assert.ok(partial.closure.every((entry) => entry.disposition === "partial"));

  const notApplicableDocument = structuredClone(mixedDocument);
  for (const entry of notApplicableDocument.quantitative_coverage) {
    entry.state = "not_applicable";
    entry.observation_ids = [];
  }
  for (const entry of notApplicableDocument.competitive_coverage) {
    entry.state = "not_applicable";
    entry.competitive_object_ids = [];
  }
  for (const entry of notApplicableDocument.incumbent_response_coverage) {
    entry.state = "not_applicable";
    entry.assessment_ids = [];
  }
  const notApplicableAudit = {
    ...audit,
    content_hash: canonicalContentHash(notApplicableDocument),
    document: notApplicableDocument,
  };
  const notApplicable = deriveLaneScopeFormalClosure(
    ["quantitative:demand_scale", "competitive:direct_product", "incumbent_response"],
    [notApplicableAudit, evidence],
    [notApplicableAudit.artifact_ref],
  );
  assert.deepEqual(notApplicable.issues, []);
  assert.ok(notApplicable.closure.every((entry) => entry.disposition === "not_applicable"));
  assert.ok(
    notApplicable.closure.every((entry) =>
      entry.semantic_bindings.every((binding) =>
        binding.semantic_identity.endsWith(":not_applicable"),
      ),
    ),
  );
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
    ["demand", "buyer"],
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
  const result = deriveLaneScopeFormalClosure(["buyer"], [lane], [lane.artifact_ref]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.closure[0]?.disposition, "partial");
  assert.deepEqual(result.closure[0]?.evidence_bindings, []);
});

test("Assessment dimension closure derives covered from one formal semantic authority", () => {
  const laneDocument = {
    schema_version: "startup_opportunity.assessment_lane_result.v1",
    dimension_results: [
      {
        dimension_id: "demand_and_behavior",
        evidence_refs: [evidence.artifact_ref],
        supporting_claim_refs: [],
        opposing_claim_refs: [],
        judgment_assessment_refs: [],
        coverage_disposition: "covered",
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
    ["demand_and_behavior"],
    [lane, evidence],
    [lane.artifact_ref],
  );
  assert.deepEqual(result.issues, []);
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

test("Assessment coverage and decision sufficiency remain orthogonal with reachable typed Evidence", () => {
  const dispatchEvidenceDocument = {
    schema_version: "startup_opportunity.assessment_evidence.v1",
    evidence_id: "ev_dispatch_scope",
    mechanical_binding: {
      substrate_record_ref: "evidence/manifest.jsonl#ev_dispatch_scope",
    },
  };
  const dispatchEvidence = {
    artifact_ref: "evidence/records/ev_dispatch_scope.json",
    artifact_type: "startup_opportunity.assessment_evidence.v1",
    content_hash: canonicalContentHash(dispatchEvidenceDocument),
    document: dispatchEvidenceDocument,
  };
  for (const [coverageDisposition, decisionSufficiency] of [
    ["covered", "insufficient"],
    ["partial", "sufficient"],
  ] as const) {
    const document = {
      schema_version: "startup_opportunity.assessment_lane_result.v1",
      dimension_results: [
        {
          dimension_id: "demand_and_behavior",
          evidence_refs: [dispatchEvidence.artifact_ref],
          supporting_claim_refs: [],
          opposing_claim_refs: [],
          judgment_assessment_refs: [],
          coverage_disposition: coverageDisposition,
          dimension_decision:
            decisionSufficiency === "sufficient" ? "opposes" : "insufficient_evidence",
          decision_sufficiency: decisionSufficiency,
        },
      ],
    };
    const lane = {
      artifact_ref: `artifacts/runtime/assessment-results/${coverageDisposition}-${decisionSufficiency}.json`,
      artifact_type: "startup_opportunity.assessment_lane_result.v1",
      content_hash: canonicalContentHash(document),
      document,
    };
    const result = deriveLaneScopeFormalClosure(
      ["demand_and_behavior"],
      [lane, dispatchEvidence],
      [lane.artifact_ref],
    );
    assert.deepEqual(result.issues, []);
    assert.equal(result.closure[0]?.disposition, coverageDisposition);
    assert.equal(result.closure[0]?.evidence_bindings.length, 1);
  }
});

test("Assessment blocked and insufficient remain partial unless formal semantics say no Evidence was found", () => {
  const dimension = (coverageDisposition: string, decisionSufficiency: string) => ({
    dimension_id: "demand_and_behavior",
    evidence_refs: [],
    supporting_claim_refs: [],
    opposing_claim_refs: [],
    judgment_assessment_refs: [],
    coverage_disposition: coverageDisposition,
    dimension_decision: "insufficient_evidence",
    decision_sufficiency: decisionSufficiency,
  });
  for (const [coverageDisposition, decisionSufficiency, expected] of [
    ["partial", "blocked", "partial"],
    ["partial", "insufficient", "partial"],
    ["no_evidence_found", "insufficient", "no_evidence_found"],
  ] as const) {
    const document = {
      schema_version: "startup_opportunity.assessment_lane_result.v1",
      dimension_results: [dimension(coverageDisposition, decisionSufficiency)],
    };
    const lane = {
      artifact_ref: `artifacts/runtime/assessment-results/${coverageDisposition}-${decisionSufficiency}.json`,
      artifact_type: "startup_opportunity.assessment_lane_result.v1",
      content_hash: canonicalContentHash(document),
      document,
    };
    const result = deriveLaneScopeFormalClosure(
      ["demand_and_behavior"],
      [lane],
      [lane.artifact_ref],
    );
    assert.deepEqual(result.issues, []);
    assert.equal(result.closure[0]?.disposition, expected);
    assert.deepEqual(result.closure[0]?.evidence_bindings, []);
  }
});

test("Assessment no-Evidence semantics cannot hide typed Evidence reachable through a Judgment", () => {
  const claimDocument = {
    schema_version: "startup_opportunity.claim.assessment.current",
    claim_id: "claim_no_evidence_conflict",
    evidence_refs: [evidence.artifact_ref],
  };
  const claim = {
    artifact_ref: "claims/no-evidence-conflict.json",
    artifact_type: "startup_opportunity.claim.assessment.current",
    content_hash: canonicalContentHash(claimDocument),
    document: claimDocument,
  };
  const judgmentDocument = {
    schema_version: "startup_opportunity.judgment_assessment.assessment.current",
    judgment_id: "judgment_no_evidence_conflict",
    supporting_claim_refs: [claim.artifact_ref],
    opposing_claim_refs: [],
  };
  const judgment = {
    artifact_ref: "judgments/no-evidence-conflict.json",
    artifact_type: "startup_opportunity.judgment_assessment.assessment.current",
    content_hash: canonicalContentHash(judgmentDocument),
    document: judgmentDocument,
  };
  const laneDocument = {
    schema_version: "startup_opportunity.assessment_lane_result.v1",
    dimension_results: [
      {
        dimension_id: "demand_and_behavior",
        evidence_refs: [],
        supporting_claim_refs: [],
        opposing_claim_refs: [],
        judgment_assessment_refs: [judgment.artifact_ref],
        coverage_disposition: "no_evidence_found",
        dimension_decision: "insufficient_evidence",
        decision_sufficiency: "insufficient",
      },
    ],
  };
  const lane = {
    artifact_ref: "artifacts/runtime/assessment-results/no-evidence-conflict.json",
    artifact_type: "startup_opportunity.assessment_lane_result.v1",
    content_hash: canonicalContentHash(laneDocument),
    document: laneDocument,
  };
  const result = deriveLaneScopeFormalClosure(
    ["demand_and_behavior"],
    [lane, judgment, claim, evidence],
    [lane.artifact_ref],
  );
  assert.equal(result.closure[0]?.disposition, "no_evidence_found");
  assert.deepEqual(result.closure[0]?.evidence_bindings, [
    {
      evidence_ref: evidence.artifact_ref,
      artifact_type: evidence.artifact_type,
      content_hash: evidence.content_hash,
      substrate_record_ref: "evidence/manifest.jsonl#ev_scope",
    },
  ]);
  assert.ok(
    result.issues.some((issue) => issue.code === "lane_delivery.scope_formal_disposition_invalid"),
  );
});

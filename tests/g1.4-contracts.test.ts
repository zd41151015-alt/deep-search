import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  canonicalContentHash,
  createArtifactValidator,
  type DocumentBundle,
  inspectSchemaBundle,
} from "../harness/src/index.js";
import {
  createG14ContractBundle,
  G14_ASSESSMENT_REF,
  G14_AUDIT_REF,
  G14_REPORT_REF,
  G14_REVIEW_REF,
  G14_TRACEABILITY_REF,
  refreshG14Bundle,
} from "./fixtures/g1.4/assessment-report-fixture.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function entry(bundle: DocumentBundle, artifactPath: string): Record<string, unknown> {
  const found = bundle.documents.find((candidate) => candidate.path === artifactPath)?.document;
  assert.ok(found, `missing fixture path ${artifactPath}`);
  return found;
}

function effective(bundle: DocumentBundle, artifactPath: string): Record<string, unknown> {
  const found = entry(bundle, artifactPath);
  return found.schema_version === "startup_opportunity.artifact_envelope.v7"
    ? (found.document as Record<string, unknown>)
    : found;
}

function rehash(bundle: DocumentBundle, artifactPath: string): void {
  const envelope = entry(bundle, artifactPath);
  if (envelope.schema_version === "startup_opportunity.artifact_envelope.v7") {
    envelope.content_hash = canonicalContentHash(envelope.document);
  }
}

async function codes(bundle: DocumentBundle): Promise<readonly string[]> {
  const validator = await createArtifactValidator(repositoryRoot);
  const result = validator.validateDocumentBundle(bundle);
  return [
    ...result.bundleErrors,
    ...result.documents.flatMap((document) => document.errors),
    ...result.referenceErrors,
  ].map((issue) => issue.code);
}

test("G1.4 publishes bundle 6.0.0 and validates all four closed Assessment results", async () => {
  const schema = await inspectSchemaBundle(repositoryRoot);
  assert.equal(schema.valid, true, JSON.stringify(schema.errors));
  assert.equal(schema.schemaBundleVersion, "6.0.0");
  assert.equal(schema.schemaCount, 67);
  assert.equal(schema.documentSchemaCount, 63);

  const validator = await createArtifactValidator(repositoryRoot);
  for (const assessmentResult of [
    "prioritize",
    "investigate_further",
    "deprioritize",
    "insufficient_evidence",
  ] as const) {
    const bundle = await createG14ContractBundle(assessmentResult);
    const result = validator.validateDocumentBundle(bundle);
    assert.equal(result.valid, true, `${assessmentResult}: ${JSON.stringify(result)}`);
    assert.equal(effective(bundle, G14_ASSESSMENT_REF).assessment_result, assessmentResult);
  }
});

test("Evidence audit fails closed for stale, single-source, unavailable, and unsupported inputs", async () => {
  const stale = await createG14ContractBundle("prioritize");
  const staleEvidencePath = stale.documents.find(
    (candidate) =>
      effective(stale, candidate.path).schema_version === "startup_opportunity.evidence.v1",
  )?.path;
  assert.ok(staleEvidencePath);
  effective(stale, staleEvidencePath).evidence_lifecycle_status = "stale";
  const staleAudit = effective(stale, G14_AUDIT_REF);
  const staleEvidenceReview = (staleAudit.evidence_reviews as Record<string, unknown>[])[0];
  assert.ok(staleEvidenceReview);
  staleEvidenceReview.freshness_status = "stale";
  rehash(stale, G14_AUDIT_REF);
  assert.ok((await codes(stale)).includes("audit.ceiling_mismatch"));

  const singleSource = await createG14ContractBundle("prioritize");
  const singleAudit = effective(singleSource, G14_AUDIT_REF);
  const singleClaimReview = (singleAudit.claim_reviews as Record<string, unknown>[])[0];
  assert.ok(singleClaimReview);
  const retainedEvidenceRef = String((singleClaimReview.evidence_refs as string[])[0]);
  singleClaimReview.evidence_refs = [retainedEvidenceRef];
  effective(singleSource, String(singleClaimReview.claim_ref)).evidence_refs = [
    retainedEvidenceRef,
  ];
  assert.ok((await codes(refreshG14Bundle(singleSource))).includes("audit.ceiling_mismatch"));

  const unavailable = await createG14ContractBundle("prioritize");
  const unavailableManifestPath = String(
    (effective(unavailable, G14_AUDIT_REF).source_manifest_refs as string[])[0],
  );
  const sourceManifest = effective(unavailable, unavailableManifestPath);
  sourceManifest.unavailable_source_records = [
    {
      source: { kind: "public_url", canonical_url: "https://unavailable.synthetic.invalid/source" },
      reason: "SYNTHETIC unavailable-source scenario.",
      attempted_at: "2026-07-25T18:30:00Z",
    },
  ];
  assert.ok((await codes(unavailable)).includes("audit.source_record_count_mismatch"));

  const unsupported = await createG14ContractBundle("insufficient_evidence");
  const unsupportedAudit = effective(unsupported, G14_AUDIT_REF);
  const unsupportedClaimReview = (unsupportedAudit.claim_reviews as Record<string, unknown>[])[0];
  assert.ok(unsupportedClaimReview);
  unsupportedClaimReview.support_fidelity = "unsupported";
  unsupportedAudit.evaluator_result = "needs_revision";
  unsupportedAudit.revision_requests = [
    {
      request_id: "revision_unsupported_claim",
      field: "claim_reviews[0].support_fidelity",
      artifact_ref: "claims/unit_demand-support.json",
      reason: "The synthetic claim support is unsupported.",
      severity: "blocking",
      requested_action: "Revise or remove the unsupported Claim.",
    },
  ];
  unsupportedAudit.evaluation_issues = [
    {
      code: "unsupported_claim",
      field: "claim_reviews[0].support_fidelity",
      artifact_ref: "claims/unit_demand-support.json",
      revision_request: "Revise or remove the unsupported Claim.",
    },
  ];
  const retained: DocumentBundle = {
    ...clone(unsupported),
    documents: unsupported.documents.filter((candidate) => {
      const schemaVersion = effective(unsupported, candidate.path).schema_version;
      return (
        !String(schemaVersion).startsWith("startup_opportunity.adversarial_review") &&
        schemaVersion !== "startup_opportunity.concept_evidence_assessment.v2" &&
        schemaVersion !== "startup_opportunity.traceability.v1" &&
        schemaVersion !== "startup_opportunity.concept_evidence_report.v1" &&
        schemaVersion !== "startup_opportunity.decision_brief.v1" &&
        schemaVersion !== "startup_opportunity.concept_evidence_report_view.v1" &&
        schemaVersion !== "startup_opportunity.report_consistency_evaluation.v1"
      );
    }),
  };
  rehash(retained, G14_AUDIT_REF);
  const validator = await createArtifactValidator(repositoryRoot);
  const unsupportedResult = validator.validateDocumentBundle(retained);
  assert.equal(unsupportedResult.valid, true, JSON.stringify(unsupportedResult));
});

test("G1.R closes decisive Audit, Matrix, Traceability, and final-plan lineage bypasses", async () => {
  const falseDecisive = await createG14ContractBundle("prioritize");
  const falseClaimReview = (
    effective(falseDecisive, G14_AUDIT_REF).claim_reviews as Record<string, unknown>[]
  )[0];
  assert.ok(falseClaimReview);
  falseClaimReview.decisive = false;
  assert.ok(
    (await codes(refreshG14Bundle(falseDecisive))).includes("assessment.decisive_audit_mismatch"),
  );

  const matrixDrift = await createG14ContractBundle("prioritize");
  const matrix = effective(matrixDrift, "artifacts/synthesis/hypothesis-evidence-matrix.json");
  matrix.decisive_evidence_refs = [];
  assert.ok(
    (await codes(refreshG14Bundle(matrixDrift))).includes("assessment.decisive_matrix_mismatch"),
  );

  const missingTrace = await createG14ContractBundle("prioritize");
  const traceability = effective(missingTrace, G14_TRACEABILITY_REF);
  const retainedChains: Record<string, unknown>[] = [];
  traceability.chains = retainedChains;
  const report = effective(missingTrace, G14_REPORT_REF);
  const statement = (report.statements as Record<string, unknown>[])[0];
  assert.ok(statement);
  statement.traceability_chain_refs = retainedChains.map((chain) => chain.chain_id);
  assert.ok(
    (await codes(refreshG14Bundle(missingTrace))).includes(
      "traceability.decisive_evidence_coverage_mismatch",
    ),
  );

  const lineageBase = await createG14ContractBundle("prioritize");
  const staleAssessmentPlanRef = "plans/concept-evidence-assessment-plan-stale.r1.json";
  const staleLineage: DocumentBundle = {
    ...lineageBase,
    documents: [
      ...lineageBase.documents,
      {
        path: staleAssessmentPlanRef,
        document: clone(entry(lineageBase, "plans/concept-evidence-assessment-plan.r1.json")),
      },
    ],
  };
  const staleReport = effective(staleLineage, G14_REPORT_REF);
  staleReport.evidence_assessment_plan_ref = staleAssessmentPlanRef;
  const staleMetadata = staleReport.report_metadata as Record<string, unknown>;
  staleMetadata.input_artifact_hashes = (
    staleMetadata.input_artifact_hashes as Record<string, unknown>[]
  ).map((binding) =>
    binding.ref === "plans/concept-evidence-assessment-plan.r1.json"
      ? { ...binding, ref: staleAssessmentPlanRef }
      : binding,
  );
  const lineageCodes = await codes(refreshG14Bundle(staleLineage));
  assert.ok(lineageCodes.includes("report.final_input_lineage_mismatch"));
  assert.equal(lineageCodes.includes("reference.type_mismatch"), false);
});

test("G1.R validates nested report input hashes", async () => {
  const bundle = await createG14ContractBundle("prioritize");
  const report = effective(bundle, G14_REPORT_REF);
  const metadata = report.report_metadata as Record<string, unknown>;
  const binding = (metadata.input_artifact_hashes as Record<string, unknown>[])[0];
  assert.ok(binding);
  binding.content_hash = `sha256:${"0".repeat(64)}`;
  rehash(bundle, G14_REPORT_REF);
  assert.ok((await codes(bundle)).includes("g1_4.input_hash_mismatch"));

  const omitted = await createG14ContractBundle("prioritize");
  const omittedReport = effective(omitted, G14_REPORT_REF);
  const omittedMetadata = omittedReport.report_metadata as Record<string, unknown>;
  omittedMetadata.input_artifact_hashes = (
    omittedMetadata.input_artifact_hashes as Record<string, unknown>[]
  ).filter((candidate) => candidate.ref !== G14_REVIEW_REF);
  rehash(omitted, G14_REPORT_REF);
  assert.ok((await codes(omitted)).includes("report.input_hash_coverage_incomplete"));
});

test("adversarial review enforces challenger independence and formal revision requests", async () => {
  const overlap = await createG14ContractBundle("prioritize");
  const overlapReview = effective(overlap, G14_REVIEW_REF);
  const independence = overlapReview.source_group_independence as Record<string, unknown>;
  independence.challenger_groups = ["source_group_unit_demand_1"];
  rehash(overlap, G14_REVIEW_REF);
  assert.ok((await codes(overlap)).includes("review.source_independence_mismatch"));

  const gap = await createG14ContractBundle("prioritize");
  const gapReview = effective(gap, G14_REVIEW_REF);
  gapReview.decision_relevant_gaps = [
    {
      gap_id: "gap_new_research",
      summary: "A synthetic decision-relevant gap requires bounded new research.",
      decision_impact: "hard_gate",
      requires_new_research: true,
      revision_request_ref: null,
    },
  ];
  rehash(gap, G14_REVIEW_REF);
  assert.ok((await codes(gap)).includes("review.gap_revision_request_missing"));
});

test("Assessment applies AI bundle, thesis-killing opposition, and external-evidence boundaries", async () => {
  const ai = await createG14ContractBundle("prioritize");
  const aiAssessment = effective(ai, G14_ASSESSMENT_REF);
  aiAssessment.assessment_profile = "ai";
  aiAssessment.ai_mandatory_bundle_status = "incomplete";
  rehash(ai, G14_ASSESSMENT_REF);
  assert.ok((await codes(ai)).includes("assessment.result_mismatch"));

  const opposition = await createG14ContractBundle("prioritize");
  const challenge = (
    effective(opposition, G14_REVIEW_REF).challenges as Record<string, unknown>[]
  ).find((candidate) => candidate.dimension === "thesis_killing_opposition");
  assert.ok(challenge);
  challenge.resolved = false;
  rehash(opposition, G14_REVIEW_REF);
  assert.ok((await codes(opposition)).includes("assessment.result_mismatch"));

  const boundary = await createG14ContractBundle("prioritize");
  const boundaryAssessment = effective(boundary, G14_ASSESSMENT_REF);
  assert.equal(boundaryAssessment.assessment_result, "prioritize");
  assert.equal(
    boundaryAssessment.external_evidence_absence_effect,
    "conclusion_ceiling_or_limitation_only",
  );
});

test("Traceability rejects a broken Judgment-to-Evidence chain", async () => {
  const bundle = await createG14ContractBundle("insufficient_evidence");
  const traceability = effective(bundle, G14_TRACEABILITY_REF);
  const brokenChain = (traceability.chains as Record<string, unknown>[])[0];
  assert.ok(brokenChain);
  brokenChain.finding_ref = "claims/unit_demand-support.json";
  rehash(bundle, G14_TRACEABILITY_REF);
  const issues = await codes(bundle);
  assert.ok(issues.includes("traceability.chain_broken"));
  assert.ok(issues.includes("reference.type_mismatch"));
});

test("three-output consistency rejects report drift and forbidden success language", async () => {
  const briefDrift = await createG14ContractBundle("prioritize");
  const briefEntry = briefDrift.documents.find(
    (candidate) =>
      effective(briefDrift, candidate.path).schema_version ===
      "startup_opportunity.decision_brief.v1",
  );
  assert.ok(briefEntry);
  effective(briefDrift, briefEntry.path).current_recommendation =
    "A new conclusion absent from report.json.";
  rehash(briefDrift, briefEntry.path);
  assert.ok((await codes(briefDrift)).includes("report.decision_brief_drift"));

  const forbidden = await createG14ContractBundle("prioritize");
  const report = effective(forbidden, G14_REPORT_REF);
  (report.report_sections as Record<string, unknown>).decision_recommendation = [
    "The market validated this synthetic concept.",
  ];
  rehash(forbidden, G14_REPORT_REF);
  assert.ok((await codes(forbidden)).includes("report.forbidden_claim"));

  const limitationDrift = await createG14ContractBundle("prioritize");
  const driftBrief = limitationDrift.documents.find(
    (candidate) =>
      effective(limitationDrift, candidate.path).schema_version ===
      "startup_opportunity.decision_brief.v1",
  );
  assert.ok(driftBrief);
  effective(limitationDrift, driftBrief.path).limitations = ["Invented limitation drift."];
  rehash(limitationDrift, driftBrief.path);
  assert.ok((await codes(limitationDrift)).includes("report.decision_brief_drift"));
});

test("G1.4 fixtures remain explicitly synthetic and never claim external validation", async () => {
  for (const assessmentResult of [
    "prioritize",
    "investigate_further",
    "deprioritize",
    "insufficient_evidence",
  ] as const) {
    const text = JSON.stringify(await createG14ContractBundle(assessmentResult));
    assert.match(text, /SYNTHETIC/);
    assert.doesNotMatch(text, /https?:\/\/(?![^"/]*\.invalid(?:[/:"?]|$))/);
    assert.doesNotMatch(text, /"external_validation_claimed":true/);
    assert.doesNotMatch(text, /"market_validation_claimed":true/);
  }
});

test("audit-traceability CLI returns structured success and fail-closed exit status", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-g1-4-cli-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const validPath = path.join(root, "valid-bundle.json");
  const invalidPath = path.join(root, "invalid-bundle.json");
  const validBundle = await createG14ContractBundle("insufficient_evidence");
  await writeFile(validPath, `${JSON.stringify(validBundle)}\n`);
  const valid = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "harness/src/cli.ts",
      "audit-traceability",
      "--bundle",
      validPath,
      "--json",
    ],
    { cwd: repositoryRoot },
  );
  const validResult = JSON.parse(valid.stdout) as Record<string, unknown>;
  assert.equal(validResult.valid, true);
  assert.equal(validResult.reportSetEvaluated, true);

  const invalidBundle: DocumentBundle = {
    ...validBundle,
    documents: validBundle.documents.filter((entry) => entry.path !== G14_TRACEABILITY_REF),
  };
  await writeFile(invalidPath, `${JSON.stringify(invalidBundle)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "harness/src/cli.ts",
        "audit-traceability",
        "--bundle",
        invalidPath,
        "--json",
      ],
      { cwd: repositoryRoot },
    ),
    (error: unknown) => {
      const failure = error as { code?: number; stdout?: string };
      assert.equal(failure.code, 1);
      const result = JSON.parse(failure.stdout ?? "{}") as Record<string, unknown>;
      assert.equal(result.valid, false);
      return true;
    },
  );
});

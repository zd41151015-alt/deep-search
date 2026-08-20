import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalContentHash,
  createArtifactValidator,
  LaneResultMaterializer,
  StoreError,
} from "../harness/src/index.js";
import {
  deriveLaneScopeFormalClosure,
  laneScopeCoverageFromClosure,
} from "../harness/src/runtime/lane-delivery-closure.js";
import {
  createDiscoveryCandidateFixture,
  fixtureEffective,
  fixtureEntry,
  G22_GENERATION_EVIDENCE,
  G22_GENERATION_LANE,
} from "./fixtures/g2.2/discovery-candidate-fixture.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function snapshotTree(root: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else snapshot[path.relative(root, absolute)] = await readFile(absolute, "utf8");
    }
  }
  await visit(root);
  return snapshot;
}

test("Discovery Lane scope states and additional observations remain distinct", async () => {
  const bundle = await createDiscoveryCandidateFixture();
  const validator = await createArtifactValidator(repositoryRoot);
  const laneDocument = structuredClone(fixtureEffective(bundle, G22_GENERATION_LANE));
  const evidenceEnvelope = fixtureEntry(bundle, G22_GENERATION_EVIDENCE);
  const evidenceArtifact = {
    artifact_ref: G22_GENERATION_EVIDENCE,
    artifact_type: String(evidenceEnvelope.artifact_type),
    content_hash: String(evidenceEnvelope.content_hash),
    document: evidenceEnvelope.document as Record<string, unknown>,
  };
  laneDocument.scope_outcomes = [
    {
      scope_key: "buyer_unknown",
      disposition: "unknown",
      evidence_refs: [],
      claim_refs: [],
      finding_refs: [],
      judgment_assessment_refs: [],
      notes: "The Lane could not determine the buyer state from current material.",
    },
    {
      scope_key: "route_unavailable",
      disposition: "unavailable",
      evidence_refs: [],
      claim_refs: [],
      finding_refs: [],
      judgment_assessment_refs: [],
      notes: "The declared acquisition route was unavailable during this attempt.",
    },
    {
      scope_key: "demand_inferred",
      disposition: "inferred",
      evidence_refs: [G22_GENERATION_EVIDENCE],
      claim_refs: [],
      finding_refs: [],
      judgment_assessment_refs: [],
      notes: "The result is an inference and is not promoted to observed coverage.",
    },
    {
      scope_key: "contradictory_context",
      disposition: "partial",
      evidence_refs: [G22_GENERATION_EVIDENCE],
      claim_refs: [],
      finding_refs: [],
      judgment_assessment_refs: [],
      notes: "Additional contradictory context remains visible outside the minimum checklist.",
    },
  ];

  const validation = validator.validateDocument(laneDocument);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors, null, 2));
  const laneArtifact = {
    artifact_ref: G22_GENERATION_LANE,
    artifact_type: "startup_opportunity.discovery_lane_result.v1",
    content_hash: canonicalContentHash(laneDocument),
    document: laneDocument,
  };
  const assignedScope = ["buyer_unknown", "route_unavailable", "demand_inferred"];
  const closure = deriveLaneScopeFormalClosure(
    assignedScope,
    [laneArtifact, evidenceArtifact],
    [laneArtifact.artifact_ref],
  );

  assert.deepEqual(closure.issues, []);
  assert.deepEqual(
    closure.closure.map((entry) => [entry.scope_key, entry.disposition]),
    [
      ["buyer_unknown", "unknown"],
      ["demand_inferred", "inferred"],
      ["route_unavailable", "unavailable"],
    ],
  );
  assert.deepEqual(
    laneScopeCoverageFromClosure(closure.closure).map((entry) => [entry.scope_key, entry.status]),
    [
      ["buyer_unknown", "unknown"],
      ["demand_inferred", "inferred"],
      ["route_unavailable", "unavailable"],
    ],
  );
  assert.equal(
    closure.closure.find((entry) => entry.scope_key === "demand_inferred")?.evidence_bindings
      .length,
    1,
  );
  assert.ok(
    (laneDocument.scope_outcomes as Record<string, unknown>[]).some(
      (entry) => entry.scope_key === "contradictory_context" && entry.disposition === "partial",
    ),
  );
});

test("Lane staging aggregates JSON Pointer diagnostics without writing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-opportunity-lane-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const validator = await createArtifactValidator(repositoryRoot);
  const materializer = new LaneResultMaterializer(runsRoot, validator, repositoryRoot);
  const failedBeforeSearch = {
    schema_version: "startup_opportunity.lane_staging_document.current",
    staging_id: "staging_failed_before_search",
    run_id: "lane-diagnostics-synthetic",
    task_ref: "tasks/discovery/unit_diagnostics.attempt-1.json",
    created_at: "2026-08-19T00:00:00Z",
    producer_role: "lane_researcher",
    operation: "validate_only",
    evidence_receipt_refs: [],
    delivery_contract: {
      search_closure: {
        status: "failed_before_search",
        acquisition_routes_attempted: ["none"],
        unresolved_gaps: ["Search could not start."],
        stop_reason: "The attempt failed before any acquisition route ran.",
      },
    },
    agent_documents: [{ artifact_family: "lane_result", document: {} }],
  };
  assert.equal(validator.validateDocument(failedBeforeSearch).valid, true);

  const malformed = structuredClone(failedBeforeSearch) as Record<string, unknown>;
  malformed.created_at = "not-a-timestamp";
  malformed.producer_role = "harness";
  const deliveryContract = malformed.delivery_contract as Record<string, unknown>;
  const searchClosure = deliveryContract.search_closure as Record<string, unknown>;
  searchClosure.status = "collapsed_unknown_state";
  searchClosure.acquisition_routes_attempted = [];
  const before = await snapshotTree(root);

  await assert.rejects(materializer.materialize(malformed), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, "runtime.lane_staging_invalid");
    const paths = (error.details.issues as Record<string, unknown>[]).map((entry) => entry.path);
    assert.ok(paths.length >= 4, JSON.stringify(error.details, null, 2));
    assert.ok(paths.includes("/created_at"));
    assert.ok(paths.includes("/producer_role"));
    assert.ok(paths.includes("/delivery_contract/search_closure/status"));
    assert.ok(paths.includes("/delivery_contract/search_closure/acquisition_routes_attempted"));
    return true;
  });
  assert.deepEqual(await snapshotTree(root), before);
});

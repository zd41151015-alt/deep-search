#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { EvidenceStore } from "../evidence-store/evidence-store.js";
import { RunStore } from "../run-store/run-store.js";
import { createArtifactValidator } from "../validators/artifact-validator.js";

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("public_url"),
    canonical_url: z.string().url(),
  }),
  z.object({
    kind: z.literal("user_provided"),
    canonical_uri: z.string(),
  }),
]);

const recordShape = z.record(z.string(), z.unknown());
const scopeShape = z.object({
  geography: z.string(),
  customer_model: z.enum(["b2c", "b2b", "b2b2c", "mixed"]),
  target_users: z.array(z.string()).min(1),
  decision_goal: z.string(),
  research_language: z.string(),
});

export function createEvidenceMcpServer(
  runsRoot: string,
  repositoryRoot = process.cwd(),
): McpServer {
  const store = new EvidenceStore(runsRoot);
  const runStore = createArtifactValidator(repositoryRoot).then(
    (validator) => new RunStore(runsRoot, validator),
  );
  const server = new McpServer({
    name: "startup-opportunity-evidence",
    version: "1.0.0",
  });

  server.registerTool(
    "create_run",
    {
      description:
        "Create a Run with an exact Scope proposal awaiting separate confirmation. This operation never asserts that a user confirmed the proposal.",
      inputSchema: {
        run_id: z.string(),
        mode: z.enum(["opportunity_discovery", "concept_evidence_assessment"]),
        scope_proposal: scopeShape,
        created_at: z.string().optional(),
        parent_run_id: z.string().nullable().optional(),
      },
      outputSchema: { result: recordShape },
      annotations: {
        title: "Create Run Scope Proposal",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ run_id, mode, scope_proposal, created_at, parent_run_id }) => {
      const result = await (await runStore).create({
        runId: run_id,
        mode,
        scopeProposal: {
          geography: scope_proposal.geography,
          customerModel: scope_proposal.customer_model,
          targetUsers: scope_proposal.target_users,
          decisionGoal: scope_proposal.decision_goal,
          researchLanguage: scope_proposal.research_language,
        },
        ...(created_at === undefined ? {} : { createdAt: created_at }),
        ...(parent_run_id === undefined ? {} : { parentRunId: parent_run_id }),
      });
      const structuredContent = { result };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "propose_scope",
    {
      description:
        "Append a corrected Scope proposal for review. Research remains blocked until a separate exact-bound confirmation.",
      inputSchema: {
        run_id: z.string(),
        expected_scope_revision: z.number().int().positive(),
        scope_proposal: scopeShape,
        reason: z.string(),
        proposed_at: z.string().optional(),
      },
      outputSchema: { result: recordShape },
      annotations: {
        title: "Propose Scope Correction",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ run_id, expected_scope_revision, scope_proposal, reason, proposed_at }) => {
      const result = await (await runStore).proposeScope({
        runId: run_id,
        expectedScopeRevision: expected_scope_revision,
        scopeProposal: {
          geography: scope_proposal.geography,
          customerModel: scope_proposal.customer_model,
          targetUsers: scope_proposal.target_users,
          decisionGoal: scope_proposal.decision_goal,
          researchLanguage: scope_proposal.research_language,
        },
        reason,
        ...(proposed_at === undefined ? {} : { proposedAt: proposed_at }),
      });
      const structuredContent = { result };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "confirm_scope",
    {
      description:
        "Persist caller-attested user confirmation bound to an exact Scope proposal revision/ref/hash. The Harness cannot authenticate chat identity and reports that boundary explicitly.",
      inputSchema: {
        run_id: z.string(),
        expected_scope_proposal_revision: z.number().int().positive(),
        expected_scope_proposal_ref: z.string(),
        expected_scope_proposal_hash: z.string(),
        user_confirmation_attestation: z.string(),
        confirmed_at: z.string().optional(),
      },
      outputSchema: { result: recordShape },
      annotations: {
        title: "Confirm Exact Scope Proposal",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      run_id,
      expected_scope_proposal_revision,
      expected_scope_proposal_ref,
      expected_scope_proposal_hash,
      user_confirmation_attestation,
      confirmed_at,
    }) => {
      const result = await (await runStore).confirmScope({
        runId: run_id,
        expectedScopeProposalRevision: expected_scope_proposal_revision,
        expectedScopeProposalRef: expected_scope_proposal_ref,
        expectedScopeProposalHash: expected_scope_proposal_hash,
        userConfirmationAttestation: user_confirmation_attestation,
        ...(confirmed_at === undefined ? {} : { confirmedAt: confirmed_at }),
      });
      const structuredContent = { result };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "record_evidence",
    {
      description:
        "Record caller-supplied Evidence bytes in one existing Startup Opportunity Run. This tool does not fetch a URL, judge the Evidence, or create a recommendation.",
      inputSchema: {
        run_id: z.string(),
        unit_id: z.string(),
        research_goal: z.string(),
        source: sourceSchema,
        raw_content: z.string().max(10_000_000),
        recorded_at: z.string().optional(),
      },
      outputSchema: {
        schemaVersion: z.literal("startup_opportunity.record_evidence_result.v1"),
        status: z.enum(["recorded", "idempotent_replay"]),
        record: recordShape,
      },
      annotations: {
        title: "Record Evidence",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ run_id, unit_id, research_goal, source, raw_content, recorded_at }) => {
      await (await runStore).assertResearchExecutionAllowed(run_id);
      const result = await store.record({
        runId: run_id,
        unitId: unit_id,
        researchGoal: research_goal,
        source,
        rawContent: raw_content,
        ...(recorded_at === undefined ? {} : { recordedAt: recorded_at }),
      });
      const structuredContent = {
        schemaVersion: result.schemaVersion,
        status: result.status,
        record: result.record,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "get_evidence_manifest",
    {
      description:
        "Read the validated Evidence manifest for one existing Startup Opportunity Run. Records are substrate metadata, not a truth or sufficiency judgment.",
      inputSchema: { run_id: z.string() },
      outputSchema: {
        schemaVersion: z.literal("startup_opportunity.mcp_evidence_manifest.v1"),
        runId: z.string(),
        records: z.array(recordShape),
      },
      annotations: {
        title: "Get Evidence Manifest",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ run_id }) => {
      const result = {
        schemaVersion: "startup_opportunity.mcp_evidence_manifest.v1" as const,
        runId: run_id,
        records: await store.listRecords(run_id),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}

export async function runEvidenceMcpServer(
  runsRoot = process.env.STARTUP_OPPORTUNITY_RUNS_ROOT ?? path.join(process.cwd(), "runs"),
): Promise<void> {
  const server = createEvidenceMcpServer(runsRoot, process.cwd());
  await server.connect(new StdioServerTransport());
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  runEvidenceMcpServer().catch((error: unknown) => {
    process.stderr.write(
      `startup-opportunity evidence MCP failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

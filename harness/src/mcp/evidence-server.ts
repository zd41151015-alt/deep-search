#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { EvidenceStore } from "../evidence-store/evidence-store.js";

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

export function createEvidenceMcpServer(runsRoot: string): McpServer {
  const store = new EvidenceStore(runsRoot);
  const server = new McpServer({
    name: "startup-opportunity-evidence",
    version: "1.0.0",
  });

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
  const server = createEvidenceMcpServer(runsRoot);
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

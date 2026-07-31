# Operations

## Clean Checkout

1. Check out the repository without copying an existing `runs/` directory, `.env`, or local credentials.
2. Activate Node.js `24.18.0` and npm `11.16.0`; `.node-version` records the exact Node release.
3. Run `npm ci` from the repository root. Do not use another package manager or generate another lockfile.
4. Run `npm run harness -- doctor --json` and require `ok=true`.
5. Open the repository as a trusted Codex project before relying on `.codex/config.toml`, custom agents, hooks, or the local MCP server.

The project configuration forwards no credentials. The local Evidence server uses `node --import tsx`, stdio, repository-local `runs/`, and a two-tool allow-list.

## Codex Surfaces

Codex Desktop, CLI, and IDE integrations use the same entry contract:

```text
$startup-opportunity

action: discover | assess | resume | status
...
```

- Desktop: open the repository as the current project, approve project trust, and invoke the Skill in the task composer.
- CLI: start Codex from this repository, review project hooks with `/hooks`, and invoke the Skill in the prompt.
- IDE: open this repository as the workspace, use its Codex task surface, and invoke the same Skill text.

There is no custom slash command, alternate prompt, UI-only action, or separate IDE workflow. Explicit action wins over implicit natural-language routing. New Runs use one primary market and one primary research language.

## Hooks Optionality

Hooks are auxiliary. A user or administrator may disable the `hooks` feature, decline project hook trust, or disable an individual project hook. In every case, follow the Skill's explicit sequence and run the deterministic commands directly. At minimum:

```sh
npm run harness -- doctor --json
npm run harness -- create-run --run-id RUN_ID --mode MODE
npm run harness -- status-run --run-id RUN_ID
npm run harness -- load-run --run-id RUN_ID
```

Evidence can use `record-evidence` directly when MCP is disabled. Artifact validation/publication, Plan validation/adaptation, checkpoints, traceability, and report checks are always explicit Harness steps. Hook output is never a formal Artifact or a substitute for these commands.

## Run Recovery

`status-run` reads and schema-validates the current manifest without recovery or mutation. Use it for `action: status`. For terminal Runs, require `terminalReportDisposition=ready` and an empty `terminalReportIssues` list before presenting delivery as complete; `missing` and `invalid` distinguish report delivery from the raw execution disposition.

`load-run` is the recovery boundary for `action: resume`. It acquires the Run lock, validates manifest/checkpoint/plan lineage, verifies Evidence and Artifact receipts and hashes, repairs only supported incomplete JSONL tails and completed operation intents, reconciles orphan active units, and returns the last valid checkpoint. Integrity conflicts fail closed.

After recovery:

1. Read the returned validated manifest and checkpoint.
2. Load only the reference for the persisted Run mode.
3. Recreate missing subagent work from the current typed task envelope; do not depend on an old thread.
4. Validate any returned Artifact from its assigned output path before synthesis.
5. Continue through explicit Gap Snapshot, Adaptation Decision, policy validation, immutable Plan Revision, and checkpoint steps when the plan must change.

Completed Runs are immutable. Use a continuation Run to refresh stale sources, add user material, change scope, or convert discovery output into a concept assessment.

## Evidence Adapter

`record_evidence` accepts one existing Run id, unit id, research goal, canonical public URL or reserved user-provided URN, and caller-supplied UTF-8 content. It does not fetch the URL. Its append is deterministic and idempotent for the canonical source/content/goal tuple.

`get_evidence_manifest` returns validated substrate metadata only. Tool success does not attest source availability, quote fidelity, provenance, independence, bias, freshness, representativeness, sufficiency, or truth. Agents must declare those fields in formal Evidence Artifacts and bind them to exact substrate refs.

## Delivery Checks

From a clean checkout, run:

```sh
npm ci
npm run harness -- doctor --json
npm run verify:skeleton
npm run lint
npm run typecheck
npm test
npm run validate:schemas
npm run validate:fixtures
npm run test:g4
npm run test:g4:clean
```

These are deterministic implementation checks. They are not formal research, external validation, or a whole-G4 boundary acceptance.

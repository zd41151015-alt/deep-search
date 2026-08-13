# Operations

## Clean Checkout

1. Check out the repository without copying an existing `runs/` directory, `.env`, or local credentials.
2. Activate Node.js `24.18.0` and npm `11.16.0`; `.node-version` records the exact Node release, while npm `devEngines` fails commands before execution when either active version drifts.
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
npm run harness -- create-run --run-id RUN_ID --mode MODE --geography GEO --customer-model b2c --target-user USER --decision-goal GOAL --research-language LANG
npm run harness -- confirm-scope --run-id RUN_ID --expected-scope-proposal-revision N --expected-scope-proposal-ref REF --expected-scope-proposal-hash HASH --user-confirmation-attestation TEXT
npm run harness -- propose-scope --run-id RUN_ID --expected-scope-revision N --geography GEO --customer-model MODEL --target-user USER --decision-goal GOAL --research-language LANG --reason REASON
npm run harness -- status-run --run-id RUN_ID
npm run harness -- load-run --run-id RUN_ID
```

Evidence can use `record-evidence` directly when MCP is disabled. Artifact validation/publication, Plan validation/adaptation, checkpoints, traceability, and report checks are always explicit Harness steps. Hook output is never a formal Artifact or a substitute for these commands.

## Run Recovery

`status-run` reads and schema-validates the current manifest without recovery or mutation. Use it for `action: status`. Its minimal `resumeContext` is sufficient after a context transition; do not reload the complete Skill, all fixtures, or the full closure, and do not treat a chat summary as formal state. Run `doctor` once per task, not once per lane or resume. For terminal Runs, require `terminalReportDisposition=ready` and an empty `terminalReportIssues` list before presenting delivery as complete; `missing` and `invalid` distinguish report delivery from the raw execution disposition.

`observability.stageTimings`, `laneTimings`, and `operationTimings` are descriptive timestamps and durations, not deadline enforcement. Lane `attemptCount` is the number of distinct `execution_attempt_id` values across the full lifecycle history and `retryCount=max(0, attemptCount-1)`. Runtime compile/publish attempts are appended automatically as Harness engineering Events; a failed attempt followed by recovery or successful publication increments the operation retry count. Exact receipt replay after a recorded success, checkpoint reads, status refreshes, and revisions inside one attempt do not count as retries. Validation/publication failure classifications, Artifact/Evidence counts, and blocking reasons remain engineering diagnostics and are not inserted into user report prose.

For live progress on long deterministic operations, add `--observe` to `compile-artifacts`, `materialize-lane-result`, `build-report`, or `load-run`. The command keeps its ordinary result on stdout and writes low-noise JSONL observations to stderr. Each observation uses a Harness-generated opaque correlation ID and names the operation, current phase, state, sequence, elapsed/phase duration, non-sensitive counts, and an error code when applicable. Caller-supplied request, staging, Artifact-path, and Run identifiers are never reused as the correlation ID. These observations are process-local engineering diagnostics: they are not Evidence or formal Artifacts, are not persisted into research conclusions, contain no raw research bytes or secrets, and do not change validation, publication, Manifest, or recovery ordering. Omitting `--observe` preserves the same workflow and result contract.

Every new dispatch wave publishes its execution overlay and complete Dispatch batch through one bundle. Discovery research lanes also include every canonical task envelope in that same bundle. The Store persists a whole-wave intent before member publication; reopen completes every intended member before projecting the Manifest, so a crash cannot leave a Dispatch-visible half-wave.

Scope confirmation is durable Run state, not a CLI-only boolean. `create-run` atomically appends revision 1 as a Scope proposal, binds its ref/hash in the Manifest, and leaves the Run at `awaiting_scope_confirmation`. The caller must show that exact proposal to the user before a separate `confirm-scope` call binds its revision/ref/hash. The confirmation record states that it is caller-attested and that the Harness cannot authenticate chat identity. A correction first uses `propose-scope`, then a separate exact-bound `confirm-scope`; both append without replacing prior records. Before confirmation, every research entrypoint is blocked. After a corrected Scope is confirmed, research remains blocked until Gap, Adaptation Decision, and immutable Plan Revision reconcile it. Reopen validates the same persisted proposal and confirmation history.

`load-run` is the recovery boundary for `action: resume`. It acquires the Run lock, validates manifest/checkpoint/plan lineage, verifies Evidence and Artifact receipts and hashes, repairs only supported incomplete JSONL tails and completed operation intents, reconciles orphan active units, and returns the last valid checkpoint. Integrity conflicts fail closed.

Recovery applies only to a Run created and operated by the same current contract. After code or contract changes, start with a new `run_id`; the Harness does not identify, migrate, adapt, or restore old Run formats. An old Run may simply fail current Manifest, receipt, or Artifact validation. This cross-update boundary is separate from same-Run crash recovery.

When the user explicitly authorizes research reuse from another Run created under the current contract, first create and confirm the target Scope. Discovery requires its current Plan before `create-research-handoff`; Assessment may create a Harness-marked pre-Plan handoff only to form its initial intake Concept, then publishes the Plan through the ordinary exact closure. Submit exact source byte/content hashes and item roles. Reusable Evidence is copied into the target Evidence Store; prior synthesis remains hypothesis-only or revalidation-required context. Use `read-research-handoff` to read selected captured items from the target Artifact. Direct source-Run reads, schema adaptation, Plan/Task/Gate/ranking/execution inheritance, and source-dependent target recovery remain prohibited.

If an active formal Run exposes a production blocker, finish the original Run through the `record_runtime_failure` terminal path before editing Harness code, schemas, policies, the Skill/hooks, or toolchain metadata. Never hot-fix production and then continue, recover, or revalidate that same `run_id`. The optional research guard enforces this boundary when `STARTUP_OPPORTUNITY_ACTIVE_RUN_ID` is set; the Skill rule remains authoritative when hooks are disabled.

After recovery:

1. Read the returned validated manifest and checkpoint.
2. Load only the reference for the persisted Run mode.
3. Recreate missing subagent work from the current typed task envelope; do not depend on an old thread.
4. Validate any returned Artifact from its assigned output path before synthesis.
5. Continue through explicit Gap Snapshot, Adaptation Decision, policy validation, immutable Plan Revision, and checkpoint steps when the plan must change.

Completed Runs are immutable. Terminal reporting is completed on the original research Run; a continuation Run cannot be used to bypass an insufficient-evidence or runtime-failure state. A correction within an active Run uses `propose-scope` followed by `confirm-scope`; a genuinely new research question, market, language, or later refresh starts a new current-contract Run with a new `run_id`.

## Evidence Adapter

`record_evidence` accepts one existing Run id, unit id, research goal, canonical public URL or reserved user-provided URN, and caller-supplied UTF-8 content. It does not fetch the URL. Its append is deterministic and idempotent for the canonical source/content/goal tuple.

`get_evidence_manifest` returns validated substrate metadata only. Tool success does not attest source availability, quote fidelity, provenance, independence, bias, freshness, representativeness, sufficiency, or truth. Agents must declare those fields in formal Evidence Artifacts and bind them to exact substrate refs.

## Normal Research Checks

A normal research Run does not execute repository engineering suites. Run doctor once per task, then only the deterministic checks required by the current workflow: Artifact and Plan validation, Gap/adaptation policy validation, traceability/report freshness and consistency, and final `status-run`. Do not run `npm test`, lint, typecheck, schema/fixture suites, or clean-checkout tests unless repository code or contracts changed.

## Engineering Delivery Checks

For repository code, schema, policy, Skill/hook, documentation-command, or toolchain changes, use a clean checkout and run:

```sh
npm ci
npm run harness -- doctor --json
npm run verify:skeleton
npm run lint
npm run typecheck
npm test
npm run validate:schemas
npm run validate:current-contract
npm run validate:fixtures
npm run test:g4
npm run test:g4:clean
```

These are deterministic implementation checks. They are not formal research, external validation, or a whole-G4 boundary acceptance.

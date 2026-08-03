# Repository Guidance

## Scope

- This repository implements the domain-specific Startup Opportunity Research Harness described in `startup-opportunity-codex-research-harness.md`.
- `startup-opportunity-implementation-progress.md` is the historical construction ledger. Consult it only when tracing implementation history or accepted verification evidence; its former Gate, controller, and `READY` slice state does not gate maintenance, bug fixes, or later product iteration.
- Keep the implementation on the frozen TypeScript 7.0.2 / Node.js 24.18 / npm 11.16 stack. Do not add another package manager, lockfile, or implementation language.
- The deterministic Harness must not make hidden LLM calls or reimplement Codex's agent loop, permissions, or thread lifecycle.

## Research Contracts

- Formal research enters through `$startup-opportunity` or a compatible invocation of that Skill. The Skill is a Runtime entry, not an authority for repository architecture or contract version strategy.
- Runtime support is current-only. `harness/schemas/current.json` is the single editable schema manifest; it has no base manifest, release number, or historical bundle selection role.
- Do not add adapters, fallbacks, migrations, old-Run detection protocols, or fixtures solely to keep retired Run bytes readable. After a code or contract update, use a new `run_id`; an old Run may fail ordinary current Manifest/schema validation and is not recovered, continued, or revalidated.
- Ordinary fixes update the current manifest, producers, consumers, validators, policies, and current fixtures atomically. Keep a numbered domain contract only while a current producer or consumer reaches its distinct business shape; do not use numbering as a Store compatibility mechanism.
- Current-only support does not weaken recovery inside one current Run: immutable revisions and refs/hashes, atomic Manifest publication, exact receipt replay, checkpoint/reopen, and crash recovery remain mandatory.
- Chat messages and subagent completion summaries are not formal artifacts.
- Never fabricate evidence references, URLs, user quotes, market data, or successful external validation.
- A subagent writes only its assigned output path and Evidence Store operations; it must not edit another lane's output, the current plan, manifest, comparison policy, decision brief, or report.
- Persist user scope or candidate corrections through the G0.3 `decisions.jsonl` append contract.
- Runtime plan changes must follow Gap Snapshot -> Adaptation Decision -> policy validation -> immutable Plan Revision. Never overwrite the current plan directly.
- Do not execute or track interviews, landing pages, deposits, advertising, paid experiments, MVP tests, or other external validation actions.
- When report outputs exist, `report.json`, `decision-brief.md`, and `report.md` must pass schema, traceability, freshness, and consistency checks before delivery.

## Development

- Use Node.js `24.18.x` and npm `11.16.x`; install exactly from `package-lock.json` with `npm ci`.
- Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run validate:schemas`, `npm run validate:current-contract`, `npm run validate:fixtures`, and `npm run verify:skeleton` for repository/toolchain/schema changes.
- Add production behavior only in the domain module that owns it. A directory, empty schema, mock-only path, or deferred-command entry is not evidence that downstream behavior is implemented.
- Keep generated output under ignored paths such as `dist/`; do not commit research raw data or secrets.
- Treat `manifest.json` as the atomically replaced current index; publish formal envelopes and checkpoints immutably, and recover only from validated on-disk state.

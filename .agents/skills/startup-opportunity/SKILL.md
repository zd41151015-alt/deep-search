---
name: startup-opportunity
description: Discover and evaluate consumer startup opportunities, assess the current evidence for a concrete product or feature thesis, or inspect and resume a repository-backed research Run. Use for startup direction research, concept evidence assessment, alternatives, buyer and acquisition evidence, AI baseline comparison, and existing Run status.
---

# Startup Opportunity

Use this Skill as the single repo-local entry for Startup Opportunity research. Treat the RFC as the business and artifact authority and the implementation progress ledger as the authority for which execution slice is currently available.

## Current Execution Gate

Run `npm run harness -- doctor --json` before relying on this repository. At G0.2, repository inspection plus closed core schema and typed-reference validation are implemented. Do not create a Run, publish an artifact, dispatch research, or claim that `discover`, `assess`, `resume`, or `status` completed. Reserved scripts exit non-zero and identify the future slice that owns their implementation.

## Action Routing

- `discover` maps to `opportunity_discovery`; read `references/opportunity-discovery.md` only for that mode.
- `assess` maps to `concept_evidence_assessment`; read `references/concept-evidence-assessment.md` only for that mode.
- `resume` and `status` require a persisted `run_id`; read `references/artifact-contracts.md` before handling stored state. `status` is read-only and never starts a subagent.
- If a request mixes broad discovery and a concrete thesis and the choice changes the output contract, ask for clarification before creating a Run.
- A Run never changes mode silently and contains one primary market and one primary research language.

## Non-Negotiable Rules

- Read mode and phase references progressively; do not load both complete workflows by default.
- Create formal conclusions only from validated repository artifacts, never from chat or a subagent completion message.
- Never fabricate evidence, source provenance, user language, market data, validation outcomes, or references.
- Give every subagent a typed task envelope and one unique output path. The main agent remains the only orchestrator.
- Keep semantic judgment in agents and deterministic validation, storage, versioning, and reporting mechanics in the Harness.
- Never overwrite the current plan. Runtime adjustment requires a Gap Snapshot, one or more validated Adaptation Decisions, and an immutable Plan Revision.
- External validation may be suggested with explicit user ownership and unsupported execution/tracking flags; this system does not execute it.

## Progressive References

- Research method and context hygiene: `references/research-kernel.md`.
- Lane roles and typed handoff: `references/lane-catalog.md`.
- Formal source, ownership, and publication rules: `references/artifact-contracts.md`.
- Comparison boundaries: `references/comparison-policy.md`.
- JSON, decision brief, and full report relationship: `references/report-contract.md`.

## Script Surface

`scripts/doctor.ts` and `scripts/validate-artifact.ts` are operational in G0.2. `validate-artifact` accepts one JSON document, an explicitly supplied typed document bundle, or the schema bundle self-check; schema success is not publication, evidence sufficiency, decision readiness, or a completed research action. The remaining RFC-named scripts deliberately fail closed until the ledger opens their owning slice. A non-zero reserved-command response is not a Harness failure and must not be converted into a mock artifact or success result.

# Contract Change Impact Governance

## Status

This document defines the approved engineering design and staged acceptance plan for reducing current-contract change amplification. It does not change Runtime research contracts by itself.

Implementation must follow root `AGENTS.md`, the owning production modules, `harness/schemas/current.json`, active current policies, and `docs/current-contract-maintenance.md`. `$startup-opportunity` is a business Runtime entry and must not be used as coding, architecture, review, delegation, or test guidance.

## Problem

The current contract graph is intentionally broad because the Harness must preserve exact research meaning across authored input, deterministic compilation, validation, policy, publication, recovery, and user-visible reporting. A meaningful field change can legitimately affect several of those layers.

The maintenance problem is not that every field must always change every layer. It is that the applicable producer, consumer, validator, policy, report projection, fixture, and focused-test relationships are only partly machine-visible. The existing current-contract validator proves schema installation, Runtime-root reference closure, Envelope dispatch agreement, active policy registration, and current-only structural constraints. It does not prove executable producer, consumer, report, or test coverage for each contract family.

This creates three costs:

1. Engineers must discover the impact graph repeatedly and may miss a consumer whose behavior remains stale.
2. Schema identifiers, Artifact types, policy paths, closed enums, and fixture mechanics are repeated in TypeScript and test data.
3. High-change domains such as commercial research, planning/adaptation, and terminal reporting have large manually coordinated change surfaces.

## Goals

- Make the applicable contract impact graph machine-readable and machine-checked.
- Produce a deterministic change-impact report that identifies affected contract families, production owners, report and policy surfaces, and focused tests.
- Remove selected mechanical duplication without introducing a second business authority.
- Reduce fixture maintenance for mechanical identity, ref/hash, Envelope, and lineage fields while keeping research semantics explicit.
- Preserve atomic updates across every layer that is actually affected by a business change.
- Preserve or improve research expressiveness, information breadth, semantic fidelity, workflow reachability, conclusion quality, recovery, and user-visible reporting.
- Support focused verification during development and a single repository-required full acceptance run once an implementation stage is believed complete.

## Non-Goals

- Reducing the number of schemas merely to reduce file count.
- Merging distinct states such as `partial`, `unavailable`, `unknown`, `inferred`, `not_applicable`, and `no_evidence_found`.
- Allowing arbitrary fields through permissive `additionalProperties` or generic JSON payloads.
- Generating Evidence weights, coverage dispositions, Gate outcomes, rankings, confidence, readiness, recommendation ceilings, or source/provider allowlists.
- Replacing semantic validators with schema-only validation.
- Adding historical contract bundles, migrations, compatibility adapters, or old-Run recovery.
- Building a second compiler, Runtime, Store, test runner, or workflow authority.
- Using impact analysis to skip the final acceptance matrix required by repository guidance.

## Authority Model

`harness/schemas/current.json`, the schemas it installs, active current policies, and owning production modules remain the only Runtime business authorities.

The proposed ownership registry is engineering topology metadata. It may describe where a contract is produced, interpreted, projected, and tested, but it must not redefine fields, allowable values, decision semantics, publication rules, or research policy. Where the registry conflicts with an owning schema, policy, or production module, validation must fail rather than select the registry as a fallback authority.

Generated source must be a deterministic projection of existing current authorities. It must be reproducible byte-for-byte and checked for drift. Generated output must never become an independently editable source of business truth.

## Research Non-Degradation

Research Non-Degradation is an independent acceptance dimension for this governance work and every implementation stage. Contract integrity, deterministic output, and passing tests do not establish it by themselves.

The implementation must preserve all lawfully accessible research inputs and roles, including news, reviews, forums, vendor and regulatory material, APIs, datasets, proxies, estimates, supporting Evidence, opposing Evidence, background material, rejected material, and contradictory material. Weaker or non-canonical material may be constrained through provenance, limitations, freshness, roles, confidence, and conclusion ceilings, but it must not be filtered merely for implementation convenience.

The implementation must not:

- infer that an unregistered field or consumer has no research impact;
- convert incomplete or weak Evidence into `no_evidence_found`;
- add a provider, endpoint, source-kind, or Evidence-role allowlist;
- make an honest partial, unavailable, inferred, conflicting, or terminal outcome unreachable;
- hide previously visible material from the appropriate user or audit report surface;
- change Gate, ranking, confidence, readiness, recommendation ceilings, Lane success, publication, or recovery as an incidental effect of engineering metadata;
- let fixture helpers silently manufacture completeness or stronger conclusions.

When impact is unknown or registry coverage is incomplete, engineering checks must fail with an actionable diagnostic or conservatively broaden the recommended test matrix. Runtime research inputs must not be rejected because engineering topology metadata is incomplete.

Each affected semantic behavior requires focused positive and negative regressions. The positive case must prove continued acceptance and faithful projection of a legitimate representative result. The negative case must prove the exact integrity or conclusion-ceiling conflict being prevented. Tests must assert decision-visible and user-visible effects where applicable, not only schema acceptance.

Every implementation and independent review must report two separate results:

```text
Contract integrity: PASS | FAIL
Research Non-Degradation: PASS | FAIL
```

## Target Architecture

### 1. Current Contract Ownership Registry

Add one machine-readable engineering registry under `harness/contracts/`. Its exact filename and structural representation may be selected during Phase 1, but it must be clearly outside the Runtime schema manifest and must identify itself as engineering metadata.

The registry must organize current schemas and Artifact types into non-overlapping contract families. Each family must declare, as applicable:

- stable family identifier and owning domain;
- schema file selectors and any explicit exceptions;
- formal Artifact types resolved through the current Envelope;
- direct non-Envelope Runtime roots;
- production owner modules;
- producer modules;
- semantic consumer and validator modules;
- active policy paths;
- report projection modules and user-visible outputs;
- primary focused test files and npm test scripts;
- whether Store identity, atomic publication, exact replay, checkpoint/reopen, or crash recovery are affected;
- research inputs and roles whose preservation is relevant;
- semantic states whose distinction is relevant;
- possible decision effects such as Gate, ranking, confidence, readiness, or recommendation ceiling.

Registry selectors must be deterministic. Every current formal Artifact type and direct Runtime root must resolve to exactly one owning family. Shared definitions may be referenced by multiple families for impact propagation but must have one structural owner. Overlapping owners, unowned roots, missing paths, nonexistent test scripts, and stale entries must fail validation.

Field ownership uses these categories:

- `agent_authored`: necessary research meaning supplied by the caller or research Agent;
- `harness_derived`: mechanically derived by the Harness from exact current inputs;
- `policy_derived`: selected or constrained by an active domain policy;
- `store_identity`: path, ref, hash, Run ownership, immutable lineage, or publication identity;
- `report_projected`: a projection of existing formal truth, never a new authored authority.

Phase 1 may establish family-level ownership first. Field-level ownership must be added for a high-change family before Phase 3 introduces or replaces fixture builders for that family. An unclassified changed field is an unknown impact, not permission to omit consumers or tests.

### 2. Contract Impact Inspection

Extend the existing `inspectCurrentContract()` implementation instead of adding a parallel validator. The validator must retain all existing current-only, reference-closure, Envelope, policy, and forbidden-structure checks.

Add checks for:

- complete and unique registry ownership of formal Artifact types and direct Runtime roots;
- installed schema and Envelope agreement with registry selectors;
- existing producer, consumer, validator, projection, policy, and test paths;
- existing npm scripts named by the registry;
- no stale registry entries or ownership overlap;
- generated projections being current once Phase 2 exists.

Add a read-only impact command, exposed through an npm script such as:

```bash
npm run contract:impact -- --base <git-ref>
```

The command must compute impact from changed files and structural JSON changes, the forward and reverse schema `$ref` graph, Envelope dispatch, active policy registration, and the ownership registry. It must provide deterministic JSON output and a concise human-readable projection containing:

- changed schemas, policies, or owner modules;
- changed JSON pointers when a schema can be structurally compared;
- directly and transitively affected contract families;
- registered producers, consumers, validators, and report projections;
- research-impact dimensions and recovery boundaries;
- recommended focused test commands;
- unresolved or unknown impact that requires broader review.

The command is advisory for test selection but strict about topology completeness. It must not edit files, infer research semantics, make Runtime decisions, or claim that tests prove Evidence truth.

### 3. Selective Mechanical Generation

After Phase 1 is independently accepted, add deterministic generation only for stable facts already owned by current schemas or policies:

- installed schema-version identifiers;
- formal Artifact-type identifiers;
- Envelope Artifact-to-document dispatch metadata;
- active policy paths and identifiers;
- selected closed enum unions where one exact schema location is the authority.

Provide generation and check modes. The check mode must fail when committed generated bytes differ from a fresh deterministic projection.

Do not begin with whole-schema-to-TypeScript object generation. Conditional schemas, semantic narrowing, and cross-Artifact closure are still enforced by AJV plus owning semantic validators. Full object code generation requires a separate demonstrated benefit and independent design review.

Generated enums must preserve the complete authoritative set. They may support exhaustive TypeScript switching, but they must not assign weights, merge states, invent defaults, or define fallback values for unknown future inputs.

### 4. Domain Fixture Builders

After Phases 1 and 2 are accepted, introduce builders incrementally for high-change domains in this order unless impact data supports a different order:

1. commercial research;
2. planning/adaptation;
3. terminal reporting.

Builders must use owning production derivation functions where practical. They must not reimplement canonical hashing, publication, recovery, compilation, or semantic reduction algorithms in tests.

Builders may derive only mechanical fields such as:

- Envelope shape and producer identity;
- deterministic paths and identifiers;
- exact refs, hashes, and same-Run lineage;
- publication records and receipts produced through existing production helpers.

Builders must require explicit test input for research semantics, including Evidence role and quality, coverage state, partiality, availability, inference, applicability, contradiction, confidence, limitations, Gate or recommendation meaning, and user-visible conclusions. They must not default those fields to a successful, complete, observed, supporting, or decision-grade state.

Literal negative fixtures remain appropriate when the malformed bytes are the behavior under test. Every builder output must still pass through the real current schema and owning semantic validator.

## Change Classification

The impact report and code review must distinguish these change classes. The listed layers are typical, not an exhaustive substitute for the computed graph.

| Change class | Typical applicable surfaces |
| --- | --- |
| Optional record-only research field | schema, actual producer, preserving consumer or audit projection, focused positive fixture |
| User-visible research field | schema, producer, semantic consumer, report projection, localization as applicable, focused behavior tests |
| Harness-derived mechanical field | owning derivation, schema, validator, receipt/replay as applicable, projection, mechanical tests |
| New or changed semantic state/enum | schema, all exhaustive consumers, validator, policy if decision-affecting, report mapping, positive and negative tests |
| Gate/ranking/confidence/readiness/ceiling change | owning policy, semantic validator/compiler, report, positive/negative non-degradation and ceiling regressions |
| Artifact identity/ref/hash/lifecycle change | Store, Envelope/Manifest, publication, replay, checkpoint/reopen, crash recovery, integration and full acceptance |

The objective is to identify all applicable surfaces, not to require all surfaces for every change and not to waive an applicable surface for convenience.

## Staged Delivery

### Phase 1: Topology And Impact Visibility

Deliver:

- engineering ownership registry;
- registry loader and validation integrated into `inspectCurrentContract()`;
- reverse `$ref` and Envelope-to-family impact graph;
- read-only `contract:impact` command with deterministic JSON and human output;
- architecture regressions for missing owner, duplicate owner, stale module, stale test command, unregistered Runtime root, and conservative unknown impact;
- documentation updates for the stable commands and review procedure.

Phase 1 must not alter Runtime schemas, policies, research compilation, validation semantics, publication, reporting, or recovery behavior.

Acceptance:

- every formal Artifact type and direct Runtime root has exactly one owner;
- every registered path and npm script resolves;
- existing current-contract validation remains byte/decision equivalent apart from added diagnostics and result fields;
- impact output is deterministic and recommends the owning focused suites;
- an unknown change cannot silently produce an empty impact set;
- focused positive and negative architecture tests pass;
- Contract integrity and Research Non-Degradation are reviewed independently.

### Phase 2: Mechanical Authority Deduplication

Deliver:

- deterministic generator and drift check for the approved identifier, dispatch, policy, and selected enum projections;
- replacement of only the duplicated literals selected by the Phase 1 impact audit;
- exhaustive-switch regressions for selected closed enums;
- no generated research weighting or decision policy.

Acceptance additionally requires proof that all semantic states and Artifact types are preserved exactly and that invalid generated drift fails before Runtime execution.

### Phase 3: High-Change Fixture Simplification

Deliver one owning domain at a time. Each domain change must be a separately reviewable commit or handoff.

Acceptance additionally requires:

- a before/after inventory of removed mechanical duplication;
- explicit semantic inputs with no success/completeness defaults;
- literal malformed fixtures retained where necessary;
- schema, semantic, decision-visible, report-visible, and recovery parity for the affected behavior;
- no reduction in lawful Evidence categories or honest state expressiveness.

## Test Strategy

During implementation, run the smallest owning tests identified by the registry and impact report, plus lint, typecheck, architecture tests, and `git diff --check` as appropriate. Focused tests must include the required positive and negative Research Non-Degradation pair whenever observable research behavior is touched.

Once an implementation stage is believed complete, run the repository-required acceptance matrix exactly once on the final candidate tree:

```bash
npm run lint
npm run typecheck
npm test
npm run validate:schemas
npm run validate:current-contract
npm run validate:fixtures
npm run verify:skeleton
git diff --check
```

Independent review must inspect the implementation and Research Non-Degradation separately. A failed review returns to the same implementation task for a narrow repair and focused verification. Repeat the full matrix only after the stage is again believed complete and the repair could affect broad acceptance; do not run it after every local edit.

## Review Checklist

For each phase and repair, the implementation handoff and independent review must answer:

1. Which existing authority owns each new fact?
2. Does the change turn engineering metadata into a second Runtime/business registry, compiler, semantic reducer, test runner, or workflow authority?
3. Can an unmapped impact lead to fewer checks or an empty test recommendation?
4. Are all lawful Evidence categories and distinct semantic states still representable and visible?
5. Are Agent-authored and Harness-derived fields still correctly separated?
6. Did any Gate, ranking, confidence, readiness, recommendation ceiling, Lane outcome, or report emphasis change?
7. Are exact refs/hashes, current-Run ownership, atomic publication, replay, checkpoint/reopen, and recovery unchanged unless explicitly in scope?
8. Do positive and negative regressions assert observable research and user effects?
9. Was `$startup-opportunity` excluded from coding-agent guidance?
10. Did focused verification and the required final acceptance matrix pass on the exact reviewed tree?

## Completion Criteria

This optimization is complete only when:

- current contract ownership and impact are machine-visible without redefining business contracts;
- high-risk unknown impact fails or broadens engineering checks rather than disappearing;
- selected mechanical identifiers and fixtures no longer require repeated manual synchronization;
- semantic validators, policies, and reports retain their owning responsibilities;
- contract changes still update every applicable layer atomically;
- development feedback is more focused without weakening final acceptance;
- independent review records both Contract integrity and Research Non-Degradation as passing.

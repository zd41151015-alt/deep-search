# Current Contract Maintenance

## Authority And Schema Graph

`harness/schemas/current.json` is the only production schema manifest. The machine-checked schema graph starts from the current Store contracts, the current Envelope (whose dispatch rules reference artifact document schemas), every active policy document, and the direct non-Envelope Runtime contracts for Evidence records, continuation lineage, and Runtime compilation requests/results. It then computes their transitive `$ref` closure.

The table below summarizes the Runtime surface from producers through schema families to consumers and primary tests. The machine-readable engineering topology is `harness/contracts/current-ownership.json`; the architecture validator verifies its registered modules, policies, projections, tests, and npm scripts instead of inferring executable ownership from Envelope membership. Code review and the mapped domain tests remain required.

| Current root | Producers | Schemas | Consumers | Primary regression |
| --- | --- | --- | --- | --- |
| Run control | CLI, RunStore, Plan Runtime | Manifest, Plan, Planning Context, current AI trigger source policy, Gap, Adaptation, Checkpoint | RunStore, planning/adaptation validators | `g0.4`, planning, Store recovery/faults |
| Evidence | EvidenceStore, MCP/CLI input | Evidence record plus Assessment/Discovery Evidence families | branch, evaluation, AI, reporting validators | `g1.2`, `g2.2`, `g3.*`, Store CLI/recovery |
| Assessment | main-agent and lane Runtime inputs | framing, execution, branch/fan-in, audit/review, terminal report families | Assessment execution/report validators and Report Runtime | `g1.*`, `p2`, reporting recovery |
| Discovery | main-agent and lane Runtime inputs | maps, candidates, synthesis, enrichment, comparison/report families | Discovery validators, RunStore projections, Report Runtime | `g2.*`, `g4` integration |
| AI | caller-supplied G3 inputs | baseline, reliability, data, economics, trust, mandatory coverage | AI validator and bound report/evaluation consumers | `g3.*` |
| Declarative execution | Runtime compiler | compilation request/result, dispatch, lane lifecycle | declarative and Assessment execution validators | `p1`, `p2` |
| Store publication | ArtifactStore and RunStore | current Envelope, Document Bundle, Store receipt, publication policy | ArtifactStore recovery and all semantic validators | schema, Store, fault, recovery, integration |

## G2.3 Readiness Boundary

Discovery synthesis has a mandatory post-fan-in entry boundary. Before any G2.3 conversion or synthesis Artifact is published, the current Run must contain the immutable exact pair `startup_opportunity.discovery_stage_readiness.v1` and `startup_opportunity.gap_snapshot.discovery.readiness.current`. The pair must bind the current Plan, the current discovery fan-in, and the current discovery execution overlay whose dependent stage is `discovery_synthesis`; that stage must name the exact Readiness path in `gate_before`.

The boundary is satisfied only when Readiness is `next_stage_readiness: "ready"`, has no blockers, and every current Plan question is covered as `answered` by at least one same-Run formal discovery Judgment. A Judgment may be supporting, opposing, unknown, partial, or `decision_sufficiency: "insufficient"`; positive Evidence is not required for the formal disposition. Unresolved, `method_boundary`, `runtime_blocked`, and terminal states remain explicit in Readiness blockers and the readiness Gap projection and can continue through their bounded follow-up or insufficient-evidence termination paths.

The generic `startup_opportunity.gap_snapshot.discovery.plan.current` remains the Gap Analyzer input for Plan adaptation. An empty generic Gap is not a post-fan-in readiness result and must never substitute for the exact readiness Gap at the G2.3 boundary. This is a current-only publication rule; it does not add adapters or recovery behavior for retired Run bytes.

## G2.3 Opportunity Family Boundary

The current `startup_opportunity.merge.v1` is the single G2.3 authority for both merge/preserve/split decisions and the main Agent's opportunity-family declarations. It distinguishes an independent Opportunity, a segment variant of a shared Opportunity family, a delivery or implementation variant, and an unknown relationship. It retains stable family identity and title, shared value or solution mechanism, shared assumptions and failure risks, member-specific differences, supporting/opposing/background/unknown refs, limitations, and unresolved questions. A family may contain one member; no family count or mechanism-diversity quota applies.

`deriveOpportunityFamilyProjection()` is the deterministic projection authority. It resolves each exact frozen Opportunity and selected Solution to project immutable hashes plus `uses_ai`, `solution_type`, and `delivery_form`. Semantic validators require every frozen Opportunity exactly once, same-Run and exact ref/hash lineage, and identical projection through Portfolio, Recommendation, Traceability, `report.json`, Decision Brief, and full report. The Harness does not infer similarity, form families, or alter merge/split/retain/rank decisions.

Merge and family declarations must not create competing authorities. Any explicit multi-member `decision: "merge"` must stay inside one `shared_opportunity_family`, and every merged member must be a `segment_variant` or `delivery_or_implementation_variant`; it cannot cross family IDs or use independent/unknown family relations. The reverse is not enforced: split or preserve decisions may still share a family when the Agent declares a segment or delivery relationship.

Family grouping never deletes an Opportunity or Evidence and never changes its hard gates, comparison, ranking, confidence, readiness, or conclusion ceiling. Reports state the number of distinguishable Opportunity families and concrete directions separately. Multiple segments of one family are not described as multiple independent startup opportunities, while every segment retains its own comparison and report disposition. Unknown, partial, unavailable, inferred, not-applicable, and no-evidence-found states remain distinct and visible.

`npm run validate:current-contract` fails if a manifest schema is outside that Runtime-root `$ref` closure. It also verifies exact Envelope enum/dispatch agreement, exact agreement between the Policy directory and the current Policy registry, active policy schema installation, absence of Store compatibility/version-selection structures, and ownership-registry completeness and freshness. Every installed schema has one structural owner, every formal Artifact type and direct Runtime root has one family owner, every shared definitions schema has one structural owner, every active Policy has one family owner, and all registered repository paths and npm scripts must resolve. Each family must declare its applicable production, validation, test, field-ownership, and research-impact topology; required declarations cannot be replaced with empty arrays. Every focused test must appear as an exact command token in at least one of that family's registered npm scripts, and every registered script must execute at least one of the family's focused tests. The schema loader rejects manifest files outside `harness/schemas/current/`. Its negative architecture regressions prove those structural guards fire. Remaining numbered domain IDs are single current business contracts, not historical bundle generations or Store compatibility selectors.

`harness/policies/ai-trigger-source-binding.current.json` is the single source-binding policy root for both Discovery and Assessment planning. Its schema is installed directly by the current manifest; workflow mode changes the validated artifacts, not the selected policy generation. The Artifact Envelope continues to dispatch the runtime-produced `startup_opportunity.ai_trigger_source_attestation.v1`; static policy documents are validator roots rather than Store artifacts.

Removed compatibility-only material includes historical `bundle.vN` manifests, numbered Store Envelope/Document Bundle schemas, publication policy base chains and adapters, the retired Adaptation Decision v1 schema, frozen old-bundle fixtures, and the old Plan receipt replay case. Retained material includes current positive/negative semantic fixtures plus same-Run immutable revision, exact replay, atomic Manifest, checkpoint/reopen, and crash-recovery coverage.

## Engineering Ownership And Impact

`harness/contracts/current-ownership.json` is engineering topology metadata, not a Runtime manifest or business authority. Families use deterministic current-schema directory selectors and declare production owners, producers, consumers, semantic validators, active Policies, report projections, focused tests, research-impact dimensions, and recovery boundaries. The registry must not define fields, enums, Evidence eligibility, weights, Gate behavior, confidence, readiness, ranking, recommendation ceilings, publication rules, or fallback Runtime behavior. Conflicts with a current schema, Policy, or owning module fail validation rather than selecting the registry as an alternative authority.

Shared production modules must be registered in every family whose semantics they directly consume or project. The registry's `cross_family_modules` audit must exactly match family role registration, and every module registered in multiple families must have one such declaration. ArtifactStore, RunStore, publication-policy, EvidenceStore, the generic Artifact validator/ref resolver, and ReportRuntime are conservatively cross-family because partial registration could suppress required recovery, domain, or report tests. Shared commercial/reporting helpers are registered according to their direct semantic consumers across Assessment, Discovery, and Terminal surfaces. The dedicated Batch 5 suite covers validator caching, commercial projection caching and responder context, and ReportRuntime observer/result parity; each applicable family binds that file to the exact `test:batch5` script.

Use the read-only impact inspector during contract maintenance:

```bash
npm run contract:impact -- --base <git-ref>
npm run --silent contract:impact -- --base <git-ref> --json
```

The human view is concise. The JSON view includes changed files and structural JSON Pointers, immediate forward and reverse `$ref` edges, transitive reverse dependents, Envelope-to-family propagation, affected owners/consumers/validators/projections, research-impact dimensions, recovery boundaries, and focused test commands. Known impacts recommend the exact registered family scripts, globally deduplicated and stably sorted; they do not recommend the generic full `npm test` command. Unknown or incomplete impact still expands conservatively to the full acceptance matrix. Output contains no timestamps and is deterministic for the same repository bytes, Git base, and arguments. `--silent` suppresses npm's command banner when the output is consumed as JSON.

Impact inspection is strict about topology but advisory about test selection. An invalid current-contract inspection exits nonzero with topology diagnostics. A changed file or structural comparison that cannot be mapped does not yield an empty impact set: it is reported under `unknownImpact`, conservatively affects every family, and recommends the full acceptance matrix. Registry gaps are engineering failures only; they must never reject a Runtime research input or narrow eligible Evidence.

For review, run the inspector from the proposed base, inspect changed JSON Pointers and every affected family, and verify that the listed owners, semantic consumers, report projections, research dimensions, recovery boundaries, and focused tests are appropriate. Add any domain-specific positive and negative regressions required by the semantic change. The impact report never replaces the final repository acceptance matrix below and never claims that passing tests establish Evidence truth.

Phase 1 contains no generated TypeScript projection and no fixture builder. Those remain separate Phase 2 and Phase 3 work and must not be introduced through registry maintenance.

## Research Non-Degradation Checklist

Apply this checklist to every implementation iteration and every independent review. Review completion must explicitly state whether each applicable area passed or identify the unresolved research impact. Schema validity, deterministic replay, and passing tests do not by themselves establish non-degradation.

### Engineering Authority And Delegation

- Does the implementation or review follow root `AGENTS.md`, the owning production module, the current contract, and applicable engineering documentation rather than invoking or following `$startup-opportunity` as a coding workflow?
- Has the task distinguished using the Skill as engineering guidance from reading it as a Runtime consumer/orchestration surface? A blanket prohibition on reading is not required.
- If the change may affect the end-to-end Runtime entry, public instructions, command sequence, Agent or Lane responsibilities, reachable workflow, or user-visible outputs, were the relevant Skill sections inspected for consistency?
- When the Skill is inspected, is engineering truth still resolved from the owning current contract, policy, production module, and tests, with the Skill updated atomically only when its public Runtime surface is in scope?
- Does every prompt delegated to another coding task explicitly state both that `$startup-opportunity` is not coding-agent guidance and that relevant inspection is required when end-to-end Runtime behavior may be affected?
- Does every delegated implementation and review task explicitly include research non-degradation as an acceptance condition, including preservation of legitimate inputs, semantic states, workflows, conclusions, and user-visible reporting?

### Research Inputs And Breadth

- Does the change continue to accept every lawful source and Evidence role relevant to the affected workflow, including news, reviews, forums, vendor and regulatory material, APIs, datasets, proxies, estimates, supporting, opposing, background, and contradictory material?
- Does it avoid a provider, endpoint, source-kind, or Evidence-role allowlist unless an external security or access-control boundary specifically requires one?
- Are weaker materials retained with provenance, limitations, and appropriate weight rather than filtered out or treated as nonexistent?

### Semantic Fidelity

- Are `partial`, `unavailable`, `unknown`, `inferred`, `not_applicable`, and `no_evidence_found` kept distinct throughout authored input, compiled Artifact, validation, receipt, aggregation, and report projection?
- Can incomplete or conflicting research be submitted honestly without fabricating completeness, a number, a direct observation, or a stronger conclusion?
- If a formal Artifact cannot represent a legitimate result, does the change improve the owning current contract instead of adding a fallback guess or rejecting the result?
- Do Harness-derived fields remain mechanically derived? Does any new Agent-authored field capture necessary research semantics rather than implementation bookkeeping?

### Workflow And Decision Effects

- Does every previously supported research action, honest terminal outcome, Plan transition, checkpoint/reopen path, and report delivery path remain reachable, or is an intentional removal applied atomically to every producer, consumer, schema, policy, document, and test?
- Does the change avoid turning coverage or source weakness into Lane, bundle, or report failure when an honest partial/unknown outcome is sufficient?
- Are any changes to Gate outcomes, ranking eligibility, Claim confidence, recommendation ceilings, or report emphasis intentional, domain-owned, and supported by explicit policy rather than an incidental validator or storage side effect?
- Are context-only inputs still context-only, and are historical, partial, weak, and contradictory findings still visible in the appropriate user-facing or audit surface?

### Engineering Cost And Failure Behavior

- Does the change reduce or at least avoid increasing repeated Agent JSON construction, format-repair loops, duplicate compilation, and manually authored mechanical refs/hashes?
- Are new fail-closed conditions limited to authenticity, security, access control, exact identity/lineage, immutable publication/recovery, or unsupported conclusion strength?
- Are diagnostics actionable enough to correct all mechanically detectable issues in one pass without forcing research-semantic trial and error?
- Is the implementation complexity proportional to the research benefit, with no second compiler, builder, parser, Store, or workflow authority introduced for the same responsibility?

### Observable Regression Requirements

- Add a positive regression for each affected legitimate case. Depending on the change, this should demonstrate continued acceptance and faithful projection of a representative weak, partial, unavailable, inferred, background, opposing, or contradictory input.
- Add a negative regression for the exact integrity conflict being prevented, such as fabricated coverage, broken ref/hash, cross-Run ownership, unsupported conclusion strength, or incomplete atomic publication.
- Assert the user-visible and decision-visible effects, not only schema acceptance: retained Evidence, exact disposition, Gate/ranking/confidence neutrality or intended ceiling, report visibility, supported terminal reachability, and recovery behavior as applicable.
- Reuse the smallest owning domain suite during development. Before final acceptance, apply the repository test matrix below; broad tests do not replace the focused positive/negative semantic pair.

## Test Selection

Use the smallest relevant domain test while developing, then apply these repository rules:

| Change | Required tests |
| --- | --- |
| Research semantics, coverage, Gate, Lane delivery, or report projection | Owning focused positive/negative non-degradation regressions, then the owning `test:g*`/`p*` suites |
| One domain schema, producer, consumer, or policy | owning `test:g*`/`p*` tests, `validate:schemas`, `validate:fixtures` |
| Store, Manifest, canonical hash, typed refs, current Envelope/Bundle/receipt, schema loader, or current manifest | `validate:current-contract`, schema tests, Store tests, fault tests, recovery tests, integration tests, then full `npm test` |
| Repository/toolchain/skeleton | lint, typecheck, full tests, schema/current-contract/fixture validation, skeleton doctor |
| Documentation only | lint, `verify:skeleton`, `git diff --check`; broaden when commands or contract rules changed |

Before committing a contract change, run `npm run lint`, `npm run typecheck`, `npm test`, `npm run validate:schemas`, `npm run validate:current-contract`, `npm run validate:fixtures`, `npm run verify:skeleton`, and `git diff --check`.

## Run Boundary

After code or contract changes, create a new `run_id`. The repository does not migrate or restore Runs written by older code, and it does not need a stable old-Run classification protocol. This does not relax recovery inside one current Run: immutable refs and hashes, no-replace publication, atomic Manifest replacement, exact receipt replay, checkpoint/reopen, and crash recovery remain required.

If a defect is discovered during an active formal Run, terminate that Run through `record_runtime_failure` before changing production code or contracts. Engineering verification uses synthetic fixtures and the full checks above; it never resumes the pre-fix `run_id`. Conversely, a normal research Run with no repository change does not run the full engineering suite.

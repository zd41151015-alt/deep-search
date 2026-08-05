# Current Contract Maintenance

## Authority And Schema Graph

`harness/schemas/current.json` is the only production schema manifest. The machine-checked schema graph starts from the current Store contracts, the current Envelope (whose dispatch rules reference artifact document schemas), every active policy document, and the direct non-Envelope Runtime contracts for Evidence records, continuation lineage, and Runtime compilation requests/results. It then computes their transitive `$ref` closure.

The table below is the maintained ownership map from Runtime producers through schema families to consumers and primary tests. The architecture validator does not infer executable producer, consumer, or test coverage from Envelope membership; those links require code review plus the mapped domain tests.

| Current root | Producers | Schemas | Consumers | Primary regression |
| --- | --- | --- | --- | --- |
| Run control | CLI, RunStore, Plan Runtime | Manifest, Plan, Planning Context, current AI trigger source policy, Gap, Adaptation, Checkpoint | RunStore, planning/adaptation validators | `g0.4`, planning, Store recovery/faults |
| Evidence | EvidenceStore, MCP/CLI input | Evidence record plus Assessment/Discovery Evidence families | branch, evaluation, AI, reporting validators | `g1.2`, `g2.2`, `g3.*`, Store CLI/recovery |
| Assessment | main-agent and lane Runtime inputs | framing, execution, branch/fan-in, audit/review, terminal report families | Assessment execution/report validators and Report Runtime | `g1.*`, `p2`, reporting recovery |
| Discovery | main-agent and lane Runtime inputs | maps, candidates, synthesis, enrichment, comparison/report families | Discovery validators, RunStore projections, Report Runtime | `g2.*`, `g4` integration |
| AI | caller-supplied G3 inputs | baseline, reliability, data, economics, trust, mandatory coverage | AI validator and bound report/evaluation consumers | `g3.*` |
| Declarative execution | Runtime compiler | compilation request/result, dispatch, lane lifecycle | declarative and Assessment execution validators | `p1`, `p2` |
| Store publication | ArtifactStore and RunStore | current Envelope, Document Bundle, Store receipt, publication policy | ArtifactStore recovery and all semantic validators | schema, Store, fault, recovery, integration |

`npm run validate:current-contract` fails if a manifest schema is outside that Runtime-root `$ref` closure. This proves schema installation and graph inclusion, not that every included schema has an independently observed producer, consumer, and test. The command also verifies exact Envelope enum/dispatch agreement, exact agreement between the Policy directory and the current Policy registry, active policy schema installation, and absence of Store compatibility/version-selection structures. The schema loader rejects manifest files outside `harness/schemas/current/`. Its negative architecture regressions prove those structural guards fire. Remaining numbered domain IDs are single current business contracts, not historical bundle generations or Store compatibility selectors.

`harness/policies/ai-trigger-source-binding.current.json` is the single source-binding policy root for both Discovery and Assessment planning. Its schema is installed directly by the current manifest; workflow mode changes the validated artifacts, not the selected policy generation. The Artifact Envelope continues to dispatch the runtime-produced `startup_opportunity.ai_trigger_source_attestation.v1`; static policy documents are validator roots rather than Store artifacts.

Removed compatibility-only material includes historical `bundle.vN` manifests, numbered Store Envelope/Document Bundle schemas, publication policy base chains and adapters, the retired Adaptation Decision v1 schema, frozen old-bundle fixtures, and the old Plan receipt replay case. Retained material includes current positive/negative semantic fixtures plus same-Run immutable revision, exact replay, atomic Manifest, checkpoint/reopen, and crash-recovery coverage.

## Test Selection

Use the smallest relevant domain test while developing, then apply these repository rules:

| Change | Required tests |
| --- | --- |
| One domain schema, producer, consumer, or policy | owning `test:g*`/`p*` tests, `validate:schemas`, `validate:fixtures` |
| Store, Manifest, canonical hash, typed refs, current Envelope/Bundle/receipt, schema loader, or current manifest | `validate:current-contract`, schema tests, Store tests, fault tests, recovery tests, integration tests, then full `npm test` |
| Repository/toolchain/skeleton | lint, typecheck, full tests, schema/current-contract/fixture validation, skeleton doctor |
| Documentation only | lint, `verify:skeleton`, `git diff --check`; broaden when commands or contract rules changed |

Before committing a contract change, run `npm run lint`, `npm run typecheck`, `npm test`, `npm run validate:schemas`, `npm run validate:current-contract`, `npm run validate:fixtures`, `npm run verify:skeleton`, and `git diff --check`.

## Run Boundary

After code or contract changes, create a new `run_id`. The repository does not migrate or restore Runs written by older code, and it does not need a stable old-Run classification protocol. This does not relax recovery inside one current Run: immutable refs and hashes, no-replace publication, atomic Manifest replacement, exact receipt replay, checkpoint/reopen, and crash recovery remain required.

If a defect is discovered during an active formal Run, terminate that Run through `record_runtime_failure` before changing production code or contracts. Engineering verification uses synthetic fixtures and the full checks above; it never resumes the pre-fix `run_id`. Conversely, a normal research Run with no repository change does not run the full engineering suite.

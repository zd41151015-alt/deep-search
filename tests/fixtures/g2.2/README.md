# G2.2 Scheme A contract fixtures

`discovery-candidate-fixture.ts` produces one synthetic `document_bundle.v9` with three
pre-thesis candidate kinds, exact G2.1 map-fragment lineage, candidate revision enrichment,
separate generation/evaluation source groups, typed Evidence-to-Judgment refs, two lane results,
six task- and subject-bound demand/baseline/solution Judgments, reference-only fan-in with exact
Judgment closure, and a non-executable G2.3 conversion proposal. It performs no research, network
access, external validation, or Store publication.

`discovery-candidate-cases.json` contains closed negative mutations for the original identity
blocker: map ref/fragment/hash/revision, Run/Scope/profile/market/language, parent/revision and
append-only drift, subject-kind relations, Decision-backed user correction, untyped
Evidence/Judgment, disposition identity/overlap/missing targets, non-candidate fan-in refs, source
separation, candidate material whose task omits the exact source revision, lane/fan-in cross-candidate
Judgments, fan-in Judgment closure drift, conversion path/parent lineage, and old-bundle fail-closed
behavior.

`discovery-runtime-fixture.ts` 把同一 accepted contract 物化为 v10 runtime bundle，并用测试中真实 EvidenceStore v2 records 替换固定 substrate identity。它只验证显式 Artifact publication、Manifest projection、checkpoint/reopen/recovery 与 CLI/Skill compatibility，不执行 lane、fan-in orchestration、G2.3 conversion runtime、真实 research 或 external validation。

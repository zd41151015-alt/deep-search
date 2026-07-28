# Core Schema Bundle

既有 bundles 继续作为 immutable compatibility bundles。默认 `bundle.v10.json` 复用已接受的 `bundle.v9.json` 与全部 v1-v10 schema bytes，只新增 v11 G2.3 conversion/formal thesis/evaluation/snapshot/merge、Envelope/Document Bundle、synthesis policy 和 publication policy v6 schema，共 108 个 schemas、101 个 document validators。`research_plan.v1`、`run_manifest.v1`、v9 contract、v10 G2.2 runtime 和 G0-G2.2 contracts 不做无版本改写。

G2.2 runtime 继续通过 v10/receipt v8 adapter 发布显式 candidate/lane/fan-in Artifact；v9 仍为 validation-only。G2.3 通过 v11/receipt v9 adapter 发布调用方显式给出的 executable conversion、formal thesis、solution evaluation、pre-enrichment snapshot 和 semantic merge；G2.4+ schema 未安装且被 v11 adapter显式阻止。

`npm run validate:schemas` compiles the complete bundle and verifies that every internal `$ref`, including its JSON Pointer, resolves without network access. `npm run validate:fixtures` exercises representative positive and negative documents, including G1.1/G1.2 lineage and G1.3 buyer/acquisition adaptation, stop, stale, duplicate, conflict, and recovery invariants. A schema-valid Artifact still has no publication or decision-readiness status; Store publication also requires a supported envelope adapter, exact Plan output ownership, references, and canonical hash.

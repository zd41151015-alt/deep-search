# Core Schema Bundle

既有 bundles 继续作为 immutable compatibility bundles。默认 `bundle.v9.json` 复用已接受的 `bundle.v8.json` 与全部 v1-v9 schema bytes，只新增 v10 runtime Envelope/Document Bundle、`discovery_fan_in.v2` 和 publication policy v5 schema，共 95 个 schemas、89 个 document validators。`research_plan.v1`、`run_manifest.v1`、v9 contract Envelope/Document Bundle 和 G0/G1/G2.1 contracts 不做无版本改写。

G2.2 runtime 通过 v10/receipt v8 adapter 发布显式 candidate/lane/fan-in Artifact；v9 仍为 validation-only。G2.3+ schema 未安装且被 v10 adapter 显式阻止。

`npm run validate:schemas` compiles the complete bundle and verifies that every internal `$ref`, including its JSON Pointer, resolves without network access. `npm run validate:fixtures` exercises representative positive and negative documents, including G1.1/G1.2 lineage and G1.3 buyer/acquisition adaptation, stop, stale, duplicate, conflict, and recovery invariants. A schema-valid Artifact still has no publication or decision-readiness status; Store publication also requires a supported envelope adapter, exact Plan output ownership, references, and canonical hash.

# Core Schema Bundle

`v1/bundle.json`、`bundle.v2.json`、`bundle.v2.1.json`、`bundle.v2.2.json`、`bundle.v3.json`、`bundle.v4.json`、`bundle.v5.json` 与 `bundle.v6.json` 继续作为 immutable compatibility bundles。默认 `bundle.v7.json` 复用全部既有 schema bytes，并新增 `v8/` 的 G2.1 discovery Scope Frame、Seed/Opportunity/Solution maps、closed map/publication policies、Artifact Envelope v8 与 Document Bundle v8，共 76 个 schemas、71 个 document validators。`research_plan.v1`、`run_manifest.v1` 和 G0/G1 contracts 不做无版本改写。

G2.1 通过单独 versioned policy 增加 v8/receipt v7 map publication/recovery；旧 envelope/bundle/policy adapters 保持兼容。所有已发布 v1-v7 schema、bundle 与 policy bytes 不变。G2.2+ owning-slice schema 仍未安装。

`npm run validate:schemas` compiles the complete bundle and verifies that every internal `$ref`, including its JSON Pointer, resolves without network access. `npm run validate:fixtures` exercises representative positive and negative documents, including G1.1/G1.2 lineage and G1.3 buyer/acquisition adaptation, stop, stale, duplicate, conflict, and recovery invariants. A schema-valid Artifact still has no publication or decision-readiness status; Store publication also requires a supported envelope adapter, exact Plan output ownership, references, and canonical hash.

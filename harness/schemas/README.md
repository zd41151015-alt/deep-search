# Core Schema Bundle

`v1/bundle.json`、`bundle.v2.json`、`bundle.v2.1.json`、`bundle.v2.2.json`、`bundle.v3.json`、`bundle.v4.json` 与 `bundle.v5.json` 继续作为 immutable compatibility bundles。默认 `bundle.v6.json` 复用全部既有 schema bytes，并新增 `v7/` 的 G1.4 audit/review/Assessment/Traceability/report contracts、policies、Artifact Envelope v7 与 Document Bundle v7，共 67 个 schemas、63 个 document validators。`research_plan.v1`、`run_manifest.v1` 和 G1.1-G1.3 contracts 不做无版本改写。

G1.4 通过单独 versioned policy 增加 v7/receipt v6 publication、Assessment/reporting gate 与 report materialization/recovery；旧 envelope/bundle/policy adapters 保持兼容。所有已发布 v1-v6 schema、bundle 与 policy bytes 不变。G2+ owning-slice schema 仍未安装。

`npm run validate:schemas` compiles the complete bundle and verifies that every internal `$ref`, including its JSON Pointer, resolves without network access. `npm run validate:fixtures` exercises representative positive and negative documents, including G1.1/G1.2 lineage and G1.3 buyer/acquisition adaptation, stop, stale, duplicate, conflict, and recovery invariants. A schema-valid Artifact still has no publication or decision-readiness status; Store publication also requires a supported envelope adapter, exact Plan output ownership, references, and canonical hash.

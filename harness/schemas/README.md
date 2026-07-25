# Core Schema Bundle

`v1/bundle.json`、`bundle.v2.json`、`bundle.v2.1.json`、`bundle.v2.2.json`、`bundle.v3.json` 与 `bundle.v4.json` 继续作为 immutable compatibility bundles。默认 `bundle.v5.json` 复用全部既有 schema bytes，并新增 `v6/` 的 Gap Snapshot v2、Adaptation Decision v3、assessment adaptation policy、AI source-binding policy v2、research publication policy v2、Artifact Envelope v6 与 Document Bundle v6，共 54 个 schemas、51 个 document validators。`research_plan.v1`、`run_manifest.v1` 和 G1.1/G1.2 contracts 不做无版本改写。

G1.3 通过单独 versioned policy 增加 v6/receipt v5 publication 与 assessment Plan operation receipt v2；旧 envelope/bundle/policy adapters 保持兼容。`adaptation.v1.json`、`ai-trigger-source-binding.v1.json` 与 `plan-revision-apply.v1.json` 的历史 bytes 不变。G1.4 与 G2+ owning-slice schema 仍未安装。

`npm run validate:schemas` compiles the complete bundle and verifies that every internal `$ref`, including its JSON Pointer, resolves without network access. `npm run validate:fixtures` exercises representative positive and negative documents, including G1.1/G1.2 lineage and G1.3 buyer/acquisition adaptation, stop, stale, duplicate, conflict, and recovery invariants. A schema-valid Artifact still has no publication or decision-readiness status; Store publication also requires a supported envelope adapter, exact Plan output ownership, references, and canonical hash.

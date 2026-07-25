# Core Schema Bundle

`v1/bundle.json`、`bundle.v2.json`、`bundle.v2.1.json`、`bundle.v2.2.json` 与 `bundle.v3.json` 继续作为 immutable compatibility bundles。默认 `bundle.v4.json` 复用全部既有 schema bytes，并新增 `v5/` 的 Evidence substrate v2、Research Task、Evidence、Claim、Finding、Insight、Source Manifest、publication policy、Artifact Envelope 与 Document Bundle，共 47 个 schemas、44 个 document validators。`research_plan.v1`、`run_manifest.v1` 和 G1.1 v4 contracts 不做无版本改写。

G1.2 通过单独 versioned publication policy 增加 v4/v5 receipt adapter；v4 branch result 被明确阻止，v5 才能发布 research branch。`adaptation.v1.json` 的历史 catalog bytes 不变。其余 G2/G1.4 owning-slice schema 仍未安装。

`npm run validate:schemas` compiles the complete bundle and verifies that every internal `$ref`, including its JSON Pointer, resolves without network access. `npm run validate:fixtures` exercises representative positive and negative documents, including G1.1 same-Run/lineage/identity and branch/fan-in invariants. A schema-valid Artifact still has no publication or decision-readiness status; Store publication also requires a supported envelope adapter, exact Plan output ownership, references, and canonical hash.

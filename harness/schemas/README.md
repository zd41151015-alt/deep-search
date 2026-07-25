# Core Schema Bundle

`v1/bundle.json`、`bundle.v2.json`、`bundle.v2.1.json` 与 `bundle.v2.2.json` 继续作为 immutable compatibility bundles。默认 `bundle.v3.json` 复用全部既有 schema bytes，并新增 `v4/` 的 11 个 G1.1 Assess domain document schemas、共享 definitions、Artifact Envelope 与 Document Bundle，共 36 个 schemas、34 个 document validators。Planning Context v1 与 Adaptation Decision v1 只读兼容，不能进入新的 policy execution；`research_plan.v1` 与 `run_manifest.v1` 不做无版本改写。

G0.4 Store 保留 v1 receipt 对 v1 envelope 的支持，并仅为 v2/v3 envelope 发布 v2 receipt；这项精确 adapter 不会泛化 Store。G1.1 v4 Envelope 只提供离线 contract validation，Store 以 `artifact.envelope_unsupported` 拒绝 publication，避免在 G1.2 之前私自选择 durable adapter、Evidence 或 branch execution 语义。`adaptation.v1.json` 中 G1.1 branch result 的历史 catalog entry 保持 `future_declared` bytes 不变，但 bundle `3.0.0` 已安装该 schema；其余 G2/G1.4 owning-slice schema 仍未安装。

`npm run validate:schemas` compiles the complete bundle and verifies that every internal `$ref`, including its JSON Pointer, resolves without network access. `npm run validate:fixtures` exercises representative positive and negative documents, including G1.1 same-Run/lineage/identity and branch/fan-in invariants. A schema-valid Artifact still has no publication or decision-readiness status; Store publication also requires a supported envelope adapter, exact Plan output ownership, references, and canonical hash.

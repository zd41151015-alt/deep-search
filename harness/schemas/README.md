# Core Schema Bundle

`v1/bundle.json` 保留 immutable schema bundle `1.0.0`，`bundle.v2.json` 保留 immutable bundle `2.0.0`，`bundle.v2.1.json` 保留 accepted compatibility bundle `2.1.0`。默认 `bundle.v2.2.json` 在不修改旧 schema 的前提下新增 v3 control envelope、v3 Document Bundle 和 Plan Revision apply policy schema。Planning Context v1 与 Adaptation Decision v1 只读兼容，不能进入新的 policy execution。`research_plan.v1` 与 `run_manifest.v1` 不做无版本改写。

G0.4 Store 保留 v1 receipt 对 v1 envelope 的支持，并仅为 v2/v3 envelope 发布 v2 receipt；首次发布 v2/v3 control Artifact 时 manifest bundle version 升至 `2.2.0`。这项精确 adapter 不会泛化 Store。Planning Context v2 将 AI trigger source 绑定到显式 bundle document、installed attestation schema、canonical hash、Run/mode/context revision、subject 和 trigger。Policy 可将尚未由 G1/G2 owning slice 发布的 output schema 标为 `future_declared`，但 trigger source 不允许 future declaration；正式 Artifact 仍必须使用 bundle 中已安装且被兼容 Envelope 和 Store contract 允许的 schema。

`npm run validate:schemas` compiles the complete bundle and verifies that every internal `$ref`, including its JSON Pointer, resolves without network access. `npm run validate:fixtures` exercises representative positive and negative documents. A schema-valid Artifact still has no publication or decision-readiness status; Store publication also enforces installed schema, envelope, exact Plan output ownership, references, and canonical hash.

# Core Schema Bundle

`v1/bundle.json` 保留 immutable schema bundle `1.0.0`，供既有 G0.2/G0.3 Run 读取和恢复。默认 `bundle.v2.json` 发布兼容读取超集 `2.0.0`，新增 Planning Context v1、Coverage Attestation v1、Adaptation Decision v2、Adaptation Policy v1、Artifact Envelope v2 和 Document Bundle v2；`research_plan.v1` 与 `run_manifest.v1` 不做无版本改写。

G0.3 Store 继续使用既有 v1 records，不做隐式 migration。Planning Context 绑定 Run/Plan identity、ref、canonical hash、revision 和 AI mandatory coverage trigger。Policy 可将尚未由 G1/G2 owning slice 发布的 output schema 标为 `future_declared`，但这只允许 Plan declaration；正式 Artifact 仍必须使用 bundle 中已安装且被兼容 Envelope 允许的 schema。

`npm run validate:schemas` compiles the complete bundle and verifies that every internal `$ref`, including its JSON Pointer, resolves without network access. `npm run validate:fixtures` exercises representative positive and negative documents. A schema-valid artifact still has no publication or decision-readiness status; G0.3 owns storage/publication and later evaluators own business sufficiency.

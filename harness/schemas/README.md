# Core Schema Bundle

`v1/bundle.json` 保留 immutable schema bundle `1.0.0`，`bundle.v2.json` 保留 immutable bundle `2.0.0`。默认 `bundle.v2.1.json` 发布兼容读取超集 `2.1.0`：在 v2.0 contracts 上新增 Planning Context v2、AI Trigger Source Attestation v1 和 AI Trigger Source Binding Policy v1；Planning Context v1 只读兼容，不能进入新的 planning policy validation。`research_plan.v1` 与 `run_manifest.v1` 不做无版本改写。

G0.3 Store 继续使用既有 v1 envelope/receipt/document-bundle records，不做隐式 migration。`artifact_envelope.v2` schema-valid 不等于 Store 可发布；当前 publish reference validation 会以 v1 bundle fail closed。Planning Context v2 将 AI trigger source 绑定到显式 bundle document、installed attestation schema、canonical hash、Run/mode/context revision、subject 和 trigger。Policy 可将尚未由 G1/G2 owning slice 发布的 output schema 标为 `future_declared`，但 trigger source 不允许 future declaration；正式 Artifact 仍必须使用 bundle 中已安装且被兼容 Envelope 和 Store contract 允许的 schema。

`npm run validate:schemas` compiles the complete bundle and verifies that every internal `$ref`, including its JSON Pointer, resolves without network access. `npm run validate:fixtures` exercises representative positive and negative documents. A schema-valid artifact still has no publication or decision-readiness status; G0.3 owns storage/publication and later evaluators own business sufficiency.

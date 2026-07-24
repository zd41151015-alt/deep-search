# Artifact Contracts

正式研究状态位于 `runs/<run_id>/`；chat 历史和 subagent 响应都不是权威来源。每个正式 Artifact envelope 都记录 schema version、typed document version、Run-relative path、创建时间、producer role、input references 和 content hash。Store 对 canonical document JSON 计算 SHA-256，验证 schema 与已知 typed ref，写入同一 Run 内的临时文件，并在不替换已占用正式路径的前提下发布。operation-key/content 一致的 replay 是幂等的；冲突 replay 会失败。

Evidence、Claim、Finding、Insight 和 Judgment Assessment 是相互分离的层。决定性事实、引文、Hard Gate 输入、反对 Evidence 和建议必须沿这些层追溯到真实 Evidence。Evidence lifecycle、judgment direction 和 decision sufficiency 使用不同字段。来源独立性、共享数据集、拒绝原因、不可用来源、偏差、地域、语言和 freshness 必须保持可审计。

已发布的 Research Plan、Gap Snapshot 和 Adaptation Decision 均不可变。被下游引用的 Artifact 必须在新路径修订，不得覆盖。每个 subagent 只拥有一个 branch path；只有 main agent 可以串行更新 manifest index、应用获批 Plan Revision、创建 checkpoint 并组装最终输出。

`manifest.json` 是原子替换的 current index，不是不可变的正式发布路径。checkpoint 包含不可变 manifest snapshot。Event 和 Decision JSONL 记录必须 schema-valid、append-only，并由 operation key 标识；只有不完整尾部可以自动修复。G0.4 通过 v3 control envelope 和 v2 Store receipt 精确支持 Planning Context v2、Adaptation Decision v2、Plan Revision 与 checkpoint，同时保持 v1 envelope/receipt 可 reopen；这不是通用 Store migration。Evidence 存储当前发布不可变原始字节、canonical source/content hash 和去重 substrate record。完整 Evidence provenance、freshness、独立性、偏差、拒绝/不可用、Claim/Finding/Insight 和研究 judgment 仍属于 G1.2。Artifact 验证或发布成功并不能证明研究质量或决策就绪。

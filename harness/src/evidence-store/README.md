# Evidence Store Ownership

G0.3 的 `evidence_store_record.v1` 与 operation receipt v1 保持 immutable：HTTP(S) URL 去 fragment、拒绝 credential，operation identity 为 `(canonical_url, content_hash, research_goal)`。G1.2 新增 `evidence_store_record.v2` 与 receipt v2；source 必须是 canonical `public_url` object，或 `urn:startup-opportunity:user-provided:*` 保留命名空间。v2 operation identity 为 `(canonical source object, content_hash, research_goal)`，`source_hash` 只覆盖 canonical source object；raw bytes 仍按 content hash 共享 immutable path。

Harness 只计算和验证 `evidence_id`、Run/unit、canonical source、source/content hash、raw ref、operation key 与 timestamp。`startup_opportunity.evidence.v1` 的 `source_type`、`evidence_origin`、provenance、independence、bias、tier、role、representativeness、freshness 与 limitations 必须由 Agent 显式声明；Harness 只校验闭集 shape 和 substrate exact binding，不从 URL、文本或模型记忆推断。

`record-evidence` 只接收调用方提供的 bytes，不抓取网页。`--url` 保留 v1 compatibility；`--source-url` 与 `--source-uri` 显式选择 v2。Reopen 会验证每条 JSONL record、receipt、raw hash、stable identity、唯一性和 exact fragment；完整损坏 fail closed，只有不完整尾部可截断。Store 成功不代表 Evidence 真实、独立、新鲜、有代表性或足以支持 thesis。

# Artifact Contracts

正式研究状态位于 `runs/<run_id>/`；chat 历史和 subagent 响应都不是权威来源。每个正式 Artifact envelope 都记录 schema version、typed document version、Run-relative path、创建时间、producer role、input references 和 content hash。Store 对 canonical document JSON 计算 SHA-256，验证 schema 与已知 typed ref，写入同一 Run 内的临时文件，并在不替换已占用正式路径的前提下发布。operation-key/content 一致的 replay 是幂等的；冲突 replay 会失败。

Evidence、Claim、Finding、Insight 和 Judgment Assessment 是相互分离的层。决定性事实、引文、Hard Gate 输入、反对 Evidence 和建议必须沿这些层追溯到真实 Evidence。Evidence lifecycle、judgment direction 和 decision sufficiency 使用不同字段。来源独立性、共享数据集、拒绝原因、不可用来源、偏差、地域、语言和 freshness 必须保持可审计。

已发布的 Research Plan、Gap Snapshot 和 Adaptation Decision 均不可变。被下游引用的 Artifact 必须在新路径修订，不得覆盖。每个 subagent 只拥有一个 branch path；只有 main agent 可以串行更新 manifest index、应用获批 Plan Revision、创建 checkpoint 并组装最终输出。

`manifest.json` 是原子替换的 current index，不是不可变的正式发布路径。checkpoint 包含不可变 manifest snapshot。Event、Decision 与 Evidence substrate JSONL 必须 schema-valid、append-only，并由 operation key 标识；只有不完整尾部可以自动修复。G1.2 的 versioned adapter 保持 v1-v4 历史 contract immutable，并为 v4/v5 envelope 分配 receipt v3/v4。v4 branch result 禁止发布；v5 research branch 必须绑定 exact v2 substrate record。

G1.3 增加 v6 envelope/document bundle 与 Store receipt v5，既有 adapter bytes 不改写。Gap Snapshot 与 Adaptation Decision 先 immutable publish；合法 `add_unit` 再把 Research Plan r2、assessment plan r2、Planning Context r2 作为一个 pending control bundle 发布，并只在全部验证通过后 CAS 替换 Manifest。Plan operation receipt v2 绑定 base/result Research Plan 与 assessment plan hashes；reopen 只从已验证 on-disk state 恢复，冲突 replay 或 Artifact drift 必须 fail closed。

G1.4 增加 v7 envelope/document bundle 与 receipt v6 adapter，不改写 v1-v6 bytes。Audit、Review、final Assessment、Traceability 与四个 reporting sidecar 都是 same-Run immutable Artifact；`report.json`、`decision-brief.md`、`report.md` 只是由 sidecar 确定性 materialize 的 view。reopen 可从 validated report sidecar 补齐缺失 view/derived sidecar，但不能覆盖冲突 bytes、修补语义或从 chat/task summary 重建结论。

G2.1 增加 v8 envelope/document bundle 与 receipt v7 adapter，不改写 v1-v7 bytes。首次 Seed/Opportunity/Solution map publication 必须显式同批通过 same-Run/current discovery Plan/profile/locale/path/ref/hash/producer 和 no-Evidence/no-thesis validation；reopen 只消费 validated on-disk envelope/temp/receipt。Harness 不从 map 启动 lane、agent 或 research。

G2.2 增加 v10 envelope/document bundle、receipt v8、typed pre-thesis candidate、Research Task v2、lane material/result 与 reference-only fan-in runtime；accepted v9 contract envelope 继续不可写。G2.3 增加 v11 envelope/document bundle、receipt v9 和 executable conversion v2，不改写 v9/v10 bytes。Demand/Baseline/Solution/Opportunity Thesis、Solution Evaluation、pre-enrichment Snapshot 与 Merge 必须绑定 retained/current candidate ancestry、typed task material、generation/evaluation source separation 和 exact input closure。G2.4 首版 v12/receipt v10/bundle `11.0.0` bytes 保持 immutable；repair 另增 v13 envelope/document bundle、receipt v11、bundle `12.0.0`、evaluation policy v2、adaptation binding v1、Consistency v3 和 publication v8。Research Task v3 必须匹配 current immutable Plan 的 exact enabled unit tuple，不能只引用 Plan path；selected Solution AI gate、recommendation ceiling、三表面 report scan 与 shared candidate pre-kill 必须在 publication/replay/reopen/recovery 使用同一 closed contract。v11 继续在写入前 block G2.4 types，v13 继续 block G3 AI bundle。Harness 只发布 caller-supplied 语义并确定性派生 report views，publication/report success 不表示 Evidence 充分、validation 或市场成功。

默认 bundle `16.0.0` 增加 v17 envelope/document bundle、receipt v15、terminal report source、Decision Brief v3、terminal report view 和 Consistency v4。正式 termination apply 必须携带 caller-supplied main-agent source；Harness 不从 Manifest、chat 或 completion summary 生成结论。v17 validation context 保留已验证 Envelope 身份，三视图 exact replay/reopen 只消费 immutable on-disk source。

Evidence 的机械层包括 stable id、Run/unit、canonical source、source/content hash、raw ref、operation key 与 timestamp；业务层的 origin、provenance、freshness、independence、bias、tier、role、representativeness 与 limitations 由 Agent 明示。Harness 不从内容推断这些判断。Artifact 验证或发布成功只证明机械 contract，不证明来源真实、研究质量、Evidence 充分或决策就绪。

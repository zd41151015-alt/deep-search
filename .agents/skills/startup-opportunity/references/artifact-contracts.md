# Artifact Contracts

本仓库只支持 `harness/schemas/current.json` 指定的 current contract。代码、schema、policy、template 或 fixture 更新后必须使用新的 `run_id`；旧 Run 可以在普通 current Manifest/schema 校验中失败，不得检测、迁移、适配、降级读取或选择历史 bundle。

同一个 current Run 内仍保持强恢复保证：`manifest.json` 是原子替换的 current index；正式 envelope、checkpoint、Plan revision、Gap Snapshot 和 Adaptation Decision 都按不可变路径发布；Event、Decision 与 Evidence substrate JSONL append-only；receipt replay、checkpoint/reopen 和 crash recovery 只消费已验证的 on-disk bytes。

Scope 是 Run Store 领域不变量。`create-run` 只能把 main agent 提出的 Scope proposal 作为 revision 1 原子追加到 `decisions.jsonl`，Manifest 绑定 proposal 的 exact ref/hash 并进入 `awaiting_scope_confirmation`。调用方把该精确 proposal 展示给用户后，必须以独立 `confirm-scope` 操作绑定 revision/ref/hash；确认记录明确标为 caller-attested，Harness 不具备聊天身份认证能力。用户修正使用 `propose-scope` 追加新 proposal，再独立确认，绝不覆盖旧记录。确认前所有执行入口拒绝计划、搜索、Evidence 写入与普通下游发布；修正确认后继续拒绝执行，直到 Plan 对账完成。`status-run` 和 reopen 都从持久化记录证明当前绑定，调用方布尔值不能代替确认。

正式研究状态位于 `runs/<run_id>/`。chat、任务摘要、subagent 完成消息以及 `dist/research-working/<run_id>/` 的临时 JSON 都不是正式 Artifact。安全工作目录用于 caller staging；`materialize-lane-result` 消费 caller-supplied staging document、exact Evidence receipts 和 current Manifest，并通过与 `compile-artifacts` 相同的 ref resolver、closure、publication plan 和 Store 路径生成正式 envelope。

正式 ref 分类只有以下权威语义：Run Artifact、Run Artifact fragment、JSON Pointer、exact Evidence/Event/Decision record、repo policy JSON ref 和外部 HTTP(S) URL。Evidence raw bytes 由 exact Evidence substrate record 的 hash/ref 绑定，不伪装成 JSON Artifact。编译 validate-only 输出不可变 publication plan；publish 必须消费同一 plan，并在 current Manifest 或 closure 漂移时失败。

Evidence、Claim、Finding、Insight 和 Judgment Assessment 是不同层。决定性事实、引文、反对材料和建议必须追溯到真实 Evidence。来源需显式记录 provenance、independence、bias、retrieved_at、published_at、observed_at、data_period_end、evidence character 和 limitations；valid_as_of 由 current 规则推导。Harness 不从 URL、内容或聊天推断这些判断。

`startup_opportunity.commercial_research_audit.current` 是 discovery 与 assessment research task 的量化/竞争正式 Artifact，不是 API 专用旁路。Acquisition provider 为开放字符串，但 raw response ref/hash、exact Evidence substrate、脱敏和 access-control const 必须闭合。每个 covered subject 精确覆盖八个 metric family 和七类 broad substitute；observation/object 只能引用 adopted Evidence，coverage gap 不能静默省略。

producer role 使用 `main_agent`、`lane_researcher`、`evidence_auditor`、`adversarial_reviewer` 或 `harness`；agent 配置名仍使用仓库文件名 `lane-researcher` 等。正式 Evidence JSON 位于 `evidence/records/`，raw bytes 位于 `evidence/raw/`，exact substrate ref 使用 `evidence/manifest.jsonl#<evidence_id>`。每个 lane 只拥有 task 指定的唯一 output path。

每次候选、fan-in、conversion、下游综合和终态报告发布前，Run transition guard 必须拒绝未完成 operation、未处置 blocking Gap、pending Adaptation Decision 或仍有 active unit 的 fan-in。Plan 变更只能按 Gap Snapshot -> Adaptation Decision -> policy validation -> immutable Plan Revision -> checkpoint 顺序执行。

终态报告必须在原研究 Run 上生成。`insufficient_evidence`、部分执行、runtime degraded/blocked/failed 都可以如实报告，但不能创建 reporting continuation Run 绕过原 Run 状态。所有 validated Evidence 必须在 source 中采用或明确排除；用户 Markdown view 与结构化工程审计数据分离。

`report.json`/terminal source 的 `commercial_research_audit_refs` 必须闭合所有当前 task audit；`quantitative_signal_rows`、`competitive_substitute_rows` 和 `research_coverage_gaps` 是这些 audit 的 exact complete projection。Report publication、replay 和 recovery 发现 projection/hash 漂移时 fail closed。

Artifact、Store、schema、report 或 recovery 成功都只证明机械 contract，不证明来源真实、Evidence 充分、市场已验证、产品可行或建议正确。

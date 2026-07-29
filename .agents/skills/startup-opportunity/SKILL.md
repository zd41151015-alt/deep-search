---
name: startup-opportunity
description: 发现并评估消费级 Startup Opportunity，评估具体产品或功能 thesis 的当前 Evidence，或检查并恢复仓库支持的研究 Run。适用于 Startup Opportunity 方向研究、concept evidence assessment、替代方案、买方与获客 Evidence、AI baseline 比较和现有 Run 状态。
---

# Startup Opportunity

将此 Skill 作为 Startup Opportunity 研究唯一的 repo-local 入口。RFC 是业务与 Artifact contract 的权威来源，implementation progress 账本是当前可执行切片的权威来源。

## Current Execution Gate

依赖此仓库前，先运行 `npm run harness -- doctor --json`。G2.4 已实现 caller-supplied discovery evaluation/report lifecycle；G3.1-G3.3已形成等待whole-Stage boundary review的caller-supplied AI baseline/reliability/data/economics/commoditization/trust/mandatory-bundle deterministic surface。Harness不会分派agent、调用LLM、执行lane、benchmark或network research，也不会自行形成coverage、baseline、comparison、recommendation或AI bundle判断。

## Action Routing

- `discover` 映射到 `opportunity_discovery`；仅在该 mode 下读取 `references/opportunity-discovery.md`。
- `assess` 映射到 `concept_evidence_assessment`；仅在该 mode 下读取 `references/concept-evidence-assessment.md`。
- `resume` 和 `status` 需要持久化的 `run_id`；处理存储状态前读取 `references/artifact-contracts.md`。`status` 只读，绝不启动 subagent。
- 如果请求混合宽泛 discovery 与具体 thesis，且选择会改变输出 contract，则在创建 Run 前要求澄清。
- Run 不得静默改变 mode，并且只包含一个主要市场和一种主要研究语言。

## Non-Negotiable Rules

- 按需渐进读取 mode 与 phase reference；默认不得同时加载两套完整工作流。
- 正式结论只能来自已经验证的仓库 Artifact，绝不能来自 chat 或 subagent 完成消息。
- 绝不伪造 Evidence、来源 provenance、用户原话、市场数据、验证结果或引用。
- 为每个 subagent 提供 typed task envelope 和唯一 output path。main agent 始终是唯一 orchestrator。
- 语义判断留给 agent；deterministic 验证、存储、版本控制和报告机制留给 Harness。
- 绝不覆盖 current plan。Runtime 调整必须依次经过 Gap Snapshot、一个或多个已验证 Adaptation Decision 和不可变 Plan Revision。
- G1 concept assessment 的 buyer/acquisition follow-up 只能消费 exact same-Run/current Plan/assessment plan/subject/scope/coverage_key/observed Artifact 与 unit-attempt state 绑定的 `gap_snapshot.v2`。Decision 只允许 `add_unit` 或 `stop_followup`；前者发布 Research Plan、assessment plan 和 Planning Context 的同批 immutable revision 后执行 Manifest CAS，后者不创建新 revision。
- 可以建议外部验证，但必须明确由用户负责并标记为不支持执行/跟踪；本系统不执行外部验证。

## Progressive References

- 研究方法与 context hygiene：`references/research-kernel.md`。
- Lane role 与 typed handoff：`references/lane-catalog.md`。
- 正式来源、ownership 和发布规则：`references/artifact-contracts.md`。
- 比较边界：`references/comparison-policy.md`。
- JSON、decision brief 与完整 report 的关系：`references/report-contract.md`。

## Script Surface

`scripts/doctor.ts`、`validate-artifact.ts`、`create-run.ts`、`load-run.ts`、`record-evidence.ts`、`publish-artifact.ts`、`checkpoint-run.ts`、`validate-plan.ts`、`analyze-gaps.ts`、`validate-adaptation.ts`、`apply-plan-revision.ts`、`calculate-comparison.ts`、`calculate-sensitivity.ts`、`audit-traceability.ts` 和 `build-report.ts` 已可运行。G2.4保留immutable v12/v1与v13/v2 evaluation语义；v14/receipt v12、v15/receipt v13、v16/receipt v14分别安装G3.1、G3.2与G3.3 caller-supplied contract，只有document bundle v16 dispatch evaluation policy v3。`build-report`只确定性派生并继承v16 binding；没有research、benchmark、agent/LLM dispatch或hidden judgment command。Store/schema success不代表Evidence真实/充分、决策就绪、research完成、产品可行或validation success。

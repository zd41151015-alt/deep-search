# 真实研究 Run 复盘与待修复项

状态：`DRAFT_REPAIR_BACKLOG`

日期：2026-07-30

本文记录一次真实 `opportunity_discovery` Run 暴露的工程、研究方法和用户交付问题，并静态审计 `concept_evidence_assessment` 是否存在同类风险。本文不是正式研究 Artifact；修复工作以当前代码、RFC、已发布 contract 和本文记录的未解决问题为依据，不受历史施工账本中的 Gate、controller 或 `READY` slice 状态约束。

## 1. 复盘范围与证据边界

主要对象：

- 原始研究任务：`019fb289-2c24-7023-b836-a7a3f9dd1cb1`
- 工程排查任务：`019fb5bb-d63f-7720-b506-30adcad957f5`
- 业务复盘任务：`019fb5c1-b394-7900-bc2f-53f5336c2666`
- 首个正式 Run：`education-cn-consumer-discovery-20260730`
- continuation Run：`education-cn-consumer-discovery-20260730-r2`
- 最终状态：`insufficient_evidence`

结论证据分级：

- `CONFIRMED_RUNTIME`：由真实 Run 文件、mtime、Manifest 或任务时间确认。
- `CONFIRMED_CODE`：由当前 schema、policy、validator 或 report renderer 确认。
- `NEEDS_REAL_RUN`：只完成静态合同审计，尚无真实 Run 验证。

仓库当前没有真实 `concept_evidence_assessment` Run，因此 assessment 的耗时、agent 行为和恢复稳定性仍属于 `NEEDS_REAL_RUN`。

修复状态与问题证据分开记录：

- `UNRESOLVED`：当前代码尚未修复。
- `PARTIALLY_FIXED_CODE`：当前工作树修复了部分路径，但仍有明确残余问题或表示依赖。
- `FIXED_CODE_TESTED`：当前工作树已有生产代码和永久回归测试，尚未由修复后的真实 Run 验证。

工程修复任务 `019fb5bb-d63f-7720-b506-30adcad957f5` 已完成 `POST-G4-003..010` 的候选实现，并在冻结 Node `24.18.0` / npm `11.16.0` 环境通过 `npm test` 354/354、`validate:fixtures` 223/223、store/fault/recovery 11/11、10/10、11/11，以及 lint、typecheck、schema validation、doctor 和 H14。该批候选与接手时已有维修已由 `c4b025a` 建立基线提交；本轮 P0 维修仍在当前 working tree，正式 research Run bytes 没有更新。因此以下“已修复”只表示代码与测试状态，不表示真实 Run 已验证。

本轮 P0 维修在同一冻结工具链下通过 `npm test` 362/362、`validate:fixtures` 223/223、store/fault/recovery 12/12、10/10、11/11，以及 lint、typecheck、schema validation 161 schemas、repository doctor 和 `git diff --check`。验证只使用 synthetic fixtures 和临时目录，没有执行正式市场调研、外部验证或旧 Run 迁移。

本轮 terminal reporting P1 批次新增 schema bundle `16.0.0`、v17 terminal source/Brief/view/Consistency contract、publication v12/receipt v15、共享 Report Runtime finalizer 和 terminal apply/status 集成。永久回归覆盖中文 primary brief、内部枚举翻译、可读来源、产品假设与验证顺序、虚假完成/freshness/derived drift 拒绝、合法 termination 缺失 source 零写入拒绝、Plan/report fault replay/reopen，以及 `terminalReportDisposition` 的 `missing -> ready` 转换。该批在冻结工具链下通过 `npm test` 368/368、`validate:fixtures` 223/223、lint、typecheck、schema validation 168 schemas 和 skeleton doctor；仍未经过新真实 Run，因此以下 `FIXED_CODE_TESTED` 不表示真实研究验证。

| 工程 finding | 本文条目 | 当前修复状态 | 代码审计结论 |
| --- | --- | --- | --- |
| `POST-G4-001` | `RR-ENG-001` | `FIXED_CODE_TESTED` | Create Run 已在隐藏 staging 中完整构建，并通过同 Run ID 创建锁和 atomic rename 发布 |
| `POST-G4-002` | `RR-ENG-002` | `FIXED_CODE_TESTED` | `RunStore.buildValidationContext` 和 `validate-plan --run-id` 已自动装配 validated Run authority 与 exact records |
| `POST-G4-003` | `RR-ENG-003` | `FIXED_CODE_TESTED` | 仅 Planning Context leaf 绑定 live Manifest，历史 revision 使用 immutable binding |
| `POST-G4-004` | `RR-ENG-004` | `FIXED_CODE_TESTED` | Plan output path 与共享 typed fragment resolver 均已有跨层正负回归 |
| `POST-G4-005` | `RR-ENG-007` | `FIXED_CODE_TESTED` | ordinary post-G2 revision 已从 durable candidates 建立 v3 historical binding |
| `POST-G4-006` | `RR-ENG-007`、`RR-ENG-011` | `FIXED_CODE_TESTED` | divergent pending operation 继续 fail closed；completed no-revision receipt 由 durable lifecycle/checkpoint/control/event 闭包识别 |
| `POST-G4-007` | `RR-ENG-008` | `FIXED_CODE_TESTED` | v5 Gap v1 / Decision v2 已投影 Manifest lifecycle；旧正式 Run 不会被追溯改写 |
| `POST-G4-008` | `RR-DISC-008`、`RR-ENG-012` | `FIXED_CODE_TESTED` | follow-up-available guard 与 apply preflight 的正式 Decision Envelope hydration 均已有回归 |
| `POST-G4-009` | `RR-ENG-009` | `PARTIALLY_FIXED_CODE` | freshness/stance 已重算，ISO 日期边界已校验；opaque `time_coverage` 仍不可确定性验证 |
| `POST-G4-010` | `RR-ENG-010` | `PARTIALLY_FIXED_CODE` | `status-run` 已派生 continuation；parent Manifest 仍是 `planned`，child 读取错误还会被静默忽略 |

本次复核补齐了此前 backlog 遗漏的 `POST-G4-009/010`。其余真实 Run 中可独立确认的问题已经分别由 `RR-ENG-001..012`、`RR-DISC-001..008` 和 `RR-UX-001..004` 覆盖；执行中出现的枚举、hash、Envelope、bundle 和 exact-record 返工不再拆成重复 issue，统一归入 `RR-ENG-002/004/006`。

## 2. 执行结果摘要

本次任务总耗时约 `2:01:34`。Run 写入 41 条 Evidence records，完成 5 条 discovery research lane，但没有进入正式 Opportunity Thesis、候选比较和报告阶段。最终没有生成 `report.json`、`decision-brief.md` 或 `report.md`，用户只收到两个模糊需求区和若干 JSON 路径。

最终 `insufficient_evidence` 不能被解释为“完整调研后确认没有足够证据”。Gap policy 先要求追加一条 buyer/acquisition follow-up，但该 Plan Revision 因 Harness 故障未能应用，follow-up 实际没有执行；Run 随后仍使用旧 Gap 进入终止。因此更准确的状态是：初轮 discovery 已完成，追加调研和 solution generation/evaluation 尚未完成，Run 因工程故障提前收口。

业务上可得出的诚实结论是：

- 当前没有证据足够、可建议直接投入的教育创业方向。
- 如果只能选择下一步验证，应优先验证成人职业转型结果服务，暂缓家庭非教学学习协调。
- 普通课程、内容聚合、题库、通用学习工作台和独立培训机构核验工具不应成为优先方向。

该判断没有被交付为清晰的决策简报，这是本次最主要的产品失败。

## 3. 时间线与主要耗时

以下时间为真实任务相对阶段，绝对时间使用 UTC。

| 时间点 | 事件 | 判断 |
| --- | --- | --- |
| 10:20:20 | 任务开始 | - |
| 10:24:09 | 首个 Run initial checkpoint | 纯 Run 初始化约 4 分钟，已包含工具链切换、失败创建和恢复 |
| 10:35:25 | Intake、DecisionContext、Scope、Plan、Planning Context 发布 | 手工合同装配约 11 分钟 |
| 10:36:28 | planned checkpoint | - |
| 10:41:22 | 三张 discovery map 发布 | 约 5 分钟生成和返工 |
| 10:48:59 | 首个 Run 标记 continuation required | Plan 路径和 Planning Context 生命周期冲突使 Run 无法继续 |
| 10:49:00 | continuation Run 创建 | 不应成为正常路径 |
| 10:57:28 | 5 个 candidate 和 5 个 task 发布 | r2 创建到任务就绪约 8 分 28 秒 |
| 10:58:31-11:03:35 | 5 个 research agent 依次启动 | 未批量启动，最后一条晚约 5 分钟 |
| 11:15:06-11:16:52 | 前 4 条 lane 完成 | 单条约 15-17 分钟 |
| 11:52:43 | 监管/反证 lane 完成 | 单条约 49 分钟，是主要 straggler |
| 11:56:39 | 监管/反证 typed lane 发布 | handoff 到正式 lane 约 3 分 56 秒 |
| 11:59:49 | discovery fan-in 发布 | - |
| 12:09:11 | Gap Snapshot 发布 | - |
| 12:14:29 | buyer/acquisition follow-up 决定发布 | 后续 Plan Revision 未能应用 |
| 12:19:11 | insufficient evidence 终止决定发布 | - |
| 12:21:54 | 任务结束 | 没有正式人类可读报告 |

关键耗时判断：

- 约 54 分钟处于 5 条 research lane 的关键阶段。
- 监管/反证 lane 比其他 lane 多约 32-34 分钟，并且最后启动，直接扩大关键路径。
- 最后一条 lane 完成到 fan-in 发布约 7 分 06 秒；其中 Harness 校验和 Store 发布只占较小部分，主要时间用于 Runtime 临时编写和修正 typed Artifact、验证闭包与 fan-in 装配。
- 前 4 条 lane 的转换和发布另用了约 10-11 分钟，但与监管 lane 运行重叠，因此没有完整反映在最后 7 分钟的关键路径中。
- fan-in 到 Gap Snapshot 约 9 分 22 秒，用于临时编写 Gap 装配、反复收窄 validation bundle 和处理 analyzer/Store 引用不一致，没有新增研究 Evidence。
- Gap Snapshot 到 follow-up decision 约 5 分 18 秒，用于 `stop_followup` 被 policy 拒绝后改写 `add_unit`、候选 Plan r2 和 Planning Context；后续发布仍失败。
- Plan Revision 失败到 termination 约 4 分 23 秒，用于重新构造终止闭包，没有执行被要求的 buyer/acquisition follow-up。
- 总时长中约一半不是网络研究，而是 Run 重建、合同装配、引用闭包、验证返工和终止流程。

## 4. 跨工作流工程问题

### RR-ENG-001 Create Run 原子性不足

状态：`CONFIRMED_RUNTIME`

首次使用非法版本参数时，创建流程留下没有 `manifest.json` 的可见目录。合法重试因目录已存在而进入 load 路径，并泄漏为缺失 manifest 的底层错误。

期望修复：

- 所有输入和 schema 校验必须在公开 Run 目录出现前完成。
- 使用 staging directory 和 atomic rename 发布新 Run。
- 任意失败不得占用 Run ID 或留下可见半成品。
- 相同合法请求可以安全重试；错误必须分类为稳定的领域错误。

当前修复状态：`FIXED_CODE_TESTED`。Create Run 在公开 Run 路径出现前完成 Manifest、initial Event、checkpoint 和目录结构校验，通过按 Run ID 隔离的创建锁串行化发布，并以同一 filesystem 内的 atomic rename 发布；校验失败和 `before_publish` fault 均不会占用 Run ID 或留下 staging 目录。Store 回归覆盖合法重试、失败清理和预存不完整目录的稳定 `run.incomplete` 错误。

### RR-ENG-002 缺少基于 run_id 的验证闭包装配

状态：`CONFIRMED_RUNTIME`

`validate-plan` 等入口要求调用方手工拼装 Manifest、checkpoint、exact event、Plan 和 Planning Context。缺失初始 checkpoint/event 时，Plan 本身已通过 schema 和语义校验，仍因引用闭包不完整而失败。

期望修复：

- 提供基于 `run_id` 的 deterministic context builder。
- 自动读取 validated current Manifest、checkpoint 和 exact append-only records。
- 调用方只提供待验证的语义 Artifact，不手工复制持久化 authority。
- 增加真实 `create-run -> publish core -> validate plan` 端到端测试。

当前修复状态：`FIXED_CODE_TESTED`。`RunStore.buildValidationContext(run_id, bundle)` 会读取并校验 current Manifest、传递闭包中的正式 Artifact、checkpoint 和 exact Event/Decision/Evidence records；v1-v16 Store Envelope 在验证后以 typed bare document 进入原版本 bundle，v17 为 terminal producer/version 校验保留正式 Envelope 身份。exact records 通过 `DocumentBundleReferenceContext` 传递，不会向不支持该字段的 v2 bundle 注入额外属性。`validate-plan --run-id [--runs-root]` 已接入，并有 authority drift、v17 Envelope closure negative test 和 CLI 端到端回归。

### RR-ENG-003 Planning Context 生命周期冲突

状态：`CONFIRMED_RUNTIME`

首个 Run 发布的 `initial_plan` Planning Context 在 Plan 激活后变为 stale；后续 current-plan validation 又沿 immutable lineage 检查旧 revision，导致正常 Run 永久无法进入 task materialization，只能创建 continuation Run。

期望修复：

- 明确 initial validation context 与 current runtime context 的生命周期和消费者。
- 已完成其职责的历史 Context 不得阻塞后续 current Plan。
- clean Run 不得因为 Context stage 转换而必须创建 continuation。

当前修复状态：`FIXED_CODE_TESTED`。当前工作树已只对 Planning Context lineage 的 leaf 强制 live Manifest binding，并保留历史 Context 的 immutable binding 校验；仍需新真实 Run 证明不再需要 continuation workaround。

### RR-ENG-004 上下游 validator 对路径和引用的合同不一致

状态：`CONFIRMED_RUNTIME`

已观察到：

- Plan validator 接受 `artifacts/lanes/...`，下游 discovery task contract 只接受 `artifacts/discovery/lanes/...`。
- Gap analyzer 接受 Plan question fragment，Artifact Store 的持久化引用解析器不识别该 fragment。

期望修复：

- 上游 validator 必须验证所有已知下游可执行约束。
- fragment 语义必须由统一 resolver 定义，不能由 analyzer 与 Store 各自维护不同集合。
- 增加从 Plan 到 Task、Gap、publish 的跨层 negative fixtures。

当前修复状态：`FIXED_CODE_TESTED`。Plan 已对 discovery/enrichment 的 `unit_id + attempt` canonical output path 做语义校验；Gap analyzer、Artifact validator 与 Artifact Store 现复用同一个 typed fragment resolver，Plan `question_id` 的 analyze/publish 正例和 missing fragment 反例均有永久回归。

### RR-ENG-005 Agent dispatch 未批量并行

状态：`CONFIRMED_RUNTIME`

5 个 task 在 10:57:28 已全部就绪，但 agent 从 10:58:31 到 11:03:35 依次启动。最后启动的监管 lane 同时也是最慢 lane，使约 5 分钟启动差直接进入关键路径。

期望修复：

- 同 wave 独立 task 应在任务发布后批量 dispatch。
- dispatch 过程不应逐个重新读取和解释相同 Run context。
- 记录 task ready、dispatch requested、agent started、handoff ready 的时间指标。

### RR-ENG-006 缺少 Declarative Research Runtime 与全流程 Artifact Compilation

状态：`CONFIRMED_RUNTIME`

本次 parent Run 与 continuation Run 共留下 13 个临时 TypeScript 程序，约 3,696 行、162 KB；continuation Run 单独约 2,992 行。另有 53 个 submission JSON，总体约 6 MB。Runtime 不只是提供研究语义，而是在 Core、Plan、Maps、Candidate、Task、Lane、Fan-in、Gap、Adaptation 和 Termination 阶段持续编写一次性装配程序。

按阶段统计：

| 阶段 | 临时代码量 | 主要越界职责 |
| --- | ---: | --- |
| Core、Plan、Planning Context | 371 行 | hash、envelope、Run-state binding、validation bundle |
| Discovery Maps | 990 行 | 把研究假设与确定性发布装配混写进 TypeScript |
| Candidate、Task | 371 行 | candidate lineage、task path、Plan tuple 和 publication bundle |
| Lane、Fan-in | 1,416 行 | typed material graph、closure、disposition bundle 和 fan-in publication |
| Gap、Adaptation、Termination | 548 行 | Gap input、Plan transform、candidate context、apply input 和终态 closure |

两个 495 行的 `build-maps.ts` 除 `run_id` 与时间外几乎相同，说明它不是一次性研究推理，而是缺失的可复用 compiler。更严重的是，Runtime 在 `build-gap.ts` 中直接导入内部 `createGapAnalyzer`，在 `build-adaptation.ts` 中直接导入 `transformPlan` 和 `planningRunStateHash`，自行构造候选 Plan、Planning Context、全 Run closure 和 apply input。

当前 CLI 虽提供 validate、publish、analyze、apply 和 build-report 等命令，但仍要求 caller 自己构造完整 Artifact、Envelope、bundle 和 exact reference closure。Harness 保持 deterministic 并不意味着 Runtime 必须写代码；工程层应接收 Agent 提供的语义 JSON，再确定性完成路径、hash、closure、validation、publication 和 recovery。

Lane/Fan-in 阶段已经观察到的具体后果包括：

- standalone validation bundle 首先遗漏 Scope、Plan、Candidate 和 Task，导致引用闭包失败；
- 后续 builder 带入全部已发布 Evidence 文档，却只带当前 lane 的 exact records，导致 28 条既有 Evidence substrate refs 被判 missing；
- 修复后 5 个 lane validation bundle 每个包含 92-106 个文档和全部 41 条 exact records，单个约 470-551 KB；
- fan-in validation bundle 再次包含 107 个文档和 41 条 exact records，约 570 KB；
- 监管 handoff 迟到时，main Agent 已开始从 raw Evidence 构造 fallback partial lane，handoff 到达后又重新对照和修改 builder。

这说明当前流程把 Runtime 变成了临时集成工程师。验证和发布本身主要是秒级操作，耗时与风险来自 per-Run 代码生成、全量闭包装配、状态竞态和失败后的人工诊断。

期望修复：

- 建立声明式 Runtime 合同：Agent 只提交版本化语义 JSON，Harness 根据 `run_id` 和当前 validated state 确定性编译正式 Artifact。
- 为 Core/Plan publication、Planning Context derivation、Discovery Maps、Candidate/Task materialization、Lane submission、Fan-in、Gap、Adaptation/Termination 和 terminal report 提供公开、版本化的 compiler/orchestrator surface。
- 定义标准 `lane submission package`，让 lane agent 在唯一待发布路径提交结构化材料和 Evidence operations；完成消息仍不作为正式 Artifact。
- 复用 `RR-ENG-002` 的 run_id context builder，自动计算当前发布所需的最小传递引用闭包和 exact records；不得让调用方复制整个 Run。
- 明确 `researching -> evidence_recorded -> handoff_ready -> formalization_validated -> published` 状态机，并为迟到、partial、failed 和 retry 定义稳定转换。
- 允许同 wave lane 并行做 schema/reference validation；Manifest 和 Artifact Store 的最终写入继续遵守单写者和原子发布边界。
- 提供可复用的 fan-in submission/validation surface，自动装配已发布 lane refs、candidate lineage 和 Judgment closure，但不自动生成业务 disposition 或 rationale。
- 记录 handoff、compilation、validation、publication、fan-in synthesis 和返工时间，避免把整段耗时误判为 validator 性能。

职责边界：

- Runtime/main Agent 可以负责研究问题、来源选择与可信度、Evidence stance、Claim/Insight/Judgment、Map/Candidate 语义、candidate disposition、Gap/Adaptation intent、rationale 和最终研究建议。
- Runtime/main Agent 可以调用公开 Harness CLI/API，也可以提交 schema-valid JSON；这不属于编程越界。
- 重复、确定性的 hash、Envelope、closure、Plan transform 和 publication 装配逻辑应由 Harness 的公开工程能力承接。
- Harness 只负责结构化装配、引用解析、policy validation、不可变发布、状态投影和恢复；不得增加隐藏 LLM 调用或自行生成研究语义。

### RR-ENG-007 G2.2 后 Plan Revision 与失败恢复无法闭合

状态：`CONFIRMED_RUNTIME / CONFIRMED_CODE`

本次 `add_buyer_acquisition_followup` 生成的 Plan r2 已通过 schema 和语义验证，但 Store 在最终发布时把 r1 与 r2 同时交给 discovery cardinality validator，因“Plan 数量 2”拒绝发布。正式 `plans/research-plan.r2.json` 没有产生，follow-up task 也没有物化。

失败同时留下 `.store/operations/plan-revision-56ec....json`：该 receipt 声明 `revision_created=true`、`result_plan_ref=plans/research-plan.r2.json`，其投影 Manifest 也指向 r2；最终公开 Manifest 却保持 r1 并进入 `insufficient_evidence`。该 legacy v1 receipt 是原 post-G2 revision bug 留下的历史坏状态和复现证据，不作为前向修复必须迁移或恢复的数据。

期望修复：

- 普通 `add_unit` 必须支持 G2.1/G2.2 Artifact 已发布后的合法 Plan Revision，并为历史 Plan 建立确定性的 candidate/Artifact binding。
- 所有 deterministic semantic、candidate binding 和 cross-generation validation 必须在 durable receipt 出现前完成；会被确定性拒绝的操作不得留下 intent。
- durable receipt 一旦发布，exact replay 必须可以幂等完成；不同 adaptation 不得跨越真正未闭合的 intent 继续修改同一 base Plan。
- 存在 unresolved Plan operation 时不得进入研究终态；若无法恢复，必须以显式工程阻塞状态关闭该 operation，而不是把它转写为研究证据不足。
- 增加 `post-G2 add_unit -> plan r2 -> task materialization -> reopen` 和发布失败恢复的端到端测试。

当前修复状态：`FIXED_CODE_TESTED`。ordinary post-G2 Plan revision 的 durable candidate binding 和 exact replay 已有实现及测试，真正 pending 的 divergent operation 也会在新写入前拒绝；`RR-ENG-011` 已进一步让 completed no-revision operation 不再被归类为 pending。原真实 Run 的 legacy v1 receipt 不要求向后迁移。

### RR-ENG-008 Gap 与 Adaptation 生命周期投影不完整

状态：`CONFIRMED_RUNTIME / CONFIRMED_CODE`

最终 Manifest 的 `artifact_refs` 同时包含 Gap Snapshot、follow-up decision 和 termination decision，但 `latest_gap_snapshot_ref=null`；follow-up decision 不在 pending、validated、applied 或 rejected 任一集合，只有 termination decision 被标为 applied。Run 对外呈现为干净终态，内部却保留未归类 decision 和 pending Plan operation。

期望修复：

- Store 接受的每个 Gap/Adaptation envelope 版本都必须得到完整 Manifest 生命周期投影；如果不能投影，应在发布前拒绝该版本。
- 每个已发布 adaptation decision 必须且只能处于 pending、validated、applied 或 rejected 等一个明确状态；扩展新状态时仍必须保持互斥和可恢复。
- `latest_gap_snapshot_ref` 必须随 Gap 原子发布更新，并由后续 adaptation 和 terminal checkpoint 引用同一最新 Gap lineage。
- terminal apply 和 reopen 必须验证不存在未分类 decision、未闭合 Plan intent 或彼此冲突的状态投影。

当前修复状态：`FIXED_CODE_TESTED`。当前工作树已让 v5 Gap v1 和 Decision v2 与 v6 当前版本一样投影 Manifest lifecycle，并增加 fault/reopen 回归，原 Run 中实际观察到的版本漏投影已修。现有正式 Run 保持历史原貌，不要求追溯修正。

### RR-ENG-009 Source Manifest freshness 与 Evidence 实际日期不一致

状态：`CONFIRMED_RUNTIME / CONFIRMED_CODE`

本次 5 个 Source Manifest 都把 `time_coverage` 写成“来源发布日期跨度至 2026-07-30”，但 accepted Evidence 的实际最大 `valid_as_of` 中，family lane 为 `2024-11-04`、adult lane 为 `2026-02-05`、buyer lane 为 `2026-05-18`。正式汇总元数据与所引用 Evidence 不一致，原 validator 没有拒绝。

当前修复状态：`PARTIALLY_FIXED_CODE`。当前工作树会从 accepted Evidence 重算 `freshness_summary` 和 `stance_coverage`，并在 `time_coverage` 含 ISO 日期时校验声明的最小/最大日期；对应 negative tests 已通过。但新写入仍可使用不含 ISO 日期的 opaque 文本绕过时间边界校验，且旧正式 Run 不会被追溯修正。

期望修复：

- Source Manifest 使用结构化、由 Harness 确定性派生的 Evidence 最早/最晚 `valid_as_of`，自由文本只能作为说明，不能作为权威 coverage。
- freshness、stance 和 time coverage 必须只从 `accepted_evidence_refs` 的已验证 Evidence 计算，caller 不得自行声明不同结果。
- primary report 的 freshness 提示必须读取该确定性汇总，不得把研究执行日期当成来源最新日期。
- 增加真实 lane publication、reopen 和 terminal report 对 freshness 汇总的一致性测试。

### RR-ENG-010 Continuation 后 parent Run 仍表现为可执行 `planned`

状态：`CONFIRMED_RUNTIME / CONFIRMED_CODE`

首个 Run 已明确要求转入 continuation Run，但 parent `manifest.json` 仍是 `planned` 且 limitations 为空；只有 checkpoint 文本记录 continuation required。原 `status-run` 因而会把不可继续的 parent 展示为正常 current Run。

当前修复状态：`PARTIALLY_FIXED_CODE`。当前工作树的 `status-run` 会只读扫描 validated child Manifests，返回 `continuationRunIds` 和 `derivedExecutionDisposition=continued`；测试确认不改写 parent/child bytes。但 parent Manifest 本身仍为 `planned`，直接读取 Manifest 的 Runtime、报告或其他消费者仍可能误判。实现还会捕获并忽略所有 child 读取/校验错误：真实 continuation 如果损坏、暂时不可读或发生 I/O 错误，parent 可能退回 `current` 而不是 fail closed；每次 status 也会线性扫描整个 runs root。

期望修复：

- 定义唯一权威的 Run execution disposition 读取面，所有 Runtime、CLI、报告和恢复入口不得绕过 continuation lineage 直接解释 raw `manifest.status`。
- parent、child 和 continuation chain 必须可确定性解析当前 leaf；多 child、invalid child 和 terminal child 的规则必须明确。
- 已识别的 child 无法读取或校验时必须返回 `indeterminate/invalid continuation` 或明确错误，不得静默忽略后把 parent 标为 current。
- continuation 查询应有可扩展的 lineage index 或等价的有界实现，避免 Run 数量增长后每次 status 全目录扫描。
- 新真实 continuation Run 中，用户和 Runtime 不得把 parent 作为可继续执行的 current Run。

### RR-ENG-011 Pending intent 扫描会误阻塞已完成的 no-revision operation

状态：`CONFIRMED_CODE`

`assertNoDivergentPendingOperation` 当前把“存在不同 operation key、receipt 的 `base_plan_ref` 等于当前 Plan”直接解释为 pending。它没有检查 receipt 对应 Manifest、checkpoint、control artifacts 和 exact events 是否已经完整落盘。对于 `stop_followup`、`request_clarification` 等不创建 Plan revision 的已完成 operation，`result_plan_ref` 仍等于 base Plan，因此后续同一 Plan 上的合法 adaptation 可能被错误拒绝为 `apply.pending_operation_conflict`。

该风险是在 `POST-G4-006` 修复中引入的。工程任务曾尝试区分 completed/pending，随后因既有 selected-batch closure 约束撤回；当前永久测试只覆盖真实 pending intent 拒绝 divergent operation，没有覆盖 completed no-revision operation 后的下一次合法动作。

期望修复：

- pending 判定必须基于 durable completion：Manifest lifecycle、checkpoint、control Artifact 和 exact events 全部闭合的 receipt 不得继续阻塞。
- 为 revision-created completed、completed no-revision、crashed pending 和 exact replay 定义互斥状态。
- 增加 `stop_followup -> later Gap -> next legal adaptation` 与 `request_clarification -> user decision -> resume` 回归链路。
- 不得通过放宽 selected Decision batch 或跳过 immutable receipt 校验来解决该问题。

当前修复状态：`FIXED_CODE_TESTED`。pending 扫描会验证 receipt 的 Manifest lifecycle、checkpoint、control Artifact 和 exact Event durable completion；真正 crashed intent 仍阻止 divergent apply。回归覆盖 `stop_followup -> later same-Plan Gap -> next adaptation`，以及 `request_clarification -> user Decision -> load-run resume boundary`，同时保持 exact replay 幂等和 immutable receipt 校验。

### RR-ENG-012 Termination basis closure 依赖 Decision 是否以 Envelope 表示

状态：`CONFIRMED_CODE`

当前 `termination_basis_unclosed` 检查只在 validator 收到的 Decision 保留 formal envelope 且存在 `input_refs` 时执行。`plan_revision_apply_input` 仍允许 adaptation bundle 提供 bare Decision document，本次真实 Run 也使用了该形式；在该路径中 `decision.envelope=null`，termination input refs closure 会被完全跳过。新增测试只验证了显式把 Decision 包成 v5 envelope 的 negative case。

这不影响已修复的 `termination_followup_available` 检查，但意味着“终止理由不得引入 Gap basis 之外的新依据”还不是表示无关的不变量。

期望修复：

- apply preflight 必须从 Artifact Store 解析已发布的 exact formal Decision envelope，或要求 adaptation bundle 始终携带 envelope；不得由 bare/enveloped 表示选择是否执行安全检查。
- termination basis closure 必须校验正式 Decision 的 input refs、reason 所依赖的 typed subjects，以及 latest Gap lineage。
- bare Decision 与 formal envelope 对同一已发布 decision 必须产生完全相同的 policy 结果，增加等价性测试。
- 未闭合 termination 不得生成 receipt、checkpoint、Manifest 变化或 terminal report。

当前修复状态：`FIXED_CODE_TESTED`。apply preflight 会从 Store 读取、验证并注入 selected Decision 的正式 Envelope，再执行 policy validation；planning validation 使用等价 typed document 视图，因此 Envelope 不会改变 Plan 语义结果。bare 与 enveloped Decision 的同一未闭合 termination 均以 `adaptation.termination_basis_unclosed` 拒绝，且 receipt、checkpoint、Manifest 和 report sidecar 均保持不变。

## 5. Discovery 工作流问题

### RR-DISC-001 Lane 混合了机会方向与横向评估维度

状态：`CONFIRMED_RUNTIME`

本次 5 条 lane 不是 5 个创业方向：

| Lane | 语义角色 |
| --- | --- |
| `family_demand` | 家庭需求方向 |
| `adult_transition` | 成人需求方向 |
| `alternative_failures` | 横向替代方案与失败模式 |
| `buyer_content_gap` | 横向买方、支付和获客证据 |
| `counterfactual_regulation` | 横向监管、强替代和反证 |

代码只强制至少一个独立需求 unit 和一个不同的 counter-evidence unit。具体 5 条 lane 是本次 Agent 对宽泛教育行业请求的动态规划结果。

期望修复：

- 明确区分 `opportunity lane`、`evaluation lane` 和 `risk lane`。
- 用户报告不得把执行 lane 数量描述为机会方向数量。
- Research Plan 为每条 lane 标记语义角色和目标候选范围。

### RR-DISC-002 先创建候选壳，再运行 candidate-generation lane

状态：`CONFIRMED_RUNTIME`

当前真实顺序是：

```text
Scope
-> no-Evidence Maps
-> pre-thesis candidate shells
-> candidate_generation Research Tasks
-> fan-in dispositions
-> formal Thesis conversion
```

`family_demand` 和 `adult_transition` Task 标记为 `source_phase=candidate_generation`，但 Task 已经绑定预先存在的 target candidate refs。该命名和方法会把“开放发现需求”变成“围绕预设候选补证”。

更严重的是，被声明为 seed-independent 的 family task 还绑定了 `candidate_service_assisted_solution`，削弱了需求研究对方案 seed 的独立性。

期望修复：

- 开放需求发现 task 只读取 Scope、Plan 和中性研究问题，不绑定 candidate 或 solution refs。
- generation fan-in 后再物化 candidate。
- candidate 创建后才运行 alternatives、buyer、regulation 等 evaluation lanes。
- 如果保留 hypothesis-first 设计，应把阶段改名为 `candidate_evidence_collection`，并明确其偏差边界。

### RR-DISC-003 Discovery 的生成和评估没有顺序 Gate

状态：`CONFIRMED_RUNTIME`

本次同一 wave 同时包含：

- family/adult 需求发现；
- alternatives/buyer/regulation 候选评估。

评估 lane 因而必须提前绑定尚未经过需求 Evidence 筛选的 candidate shells。

建议流程：

```text
Wave A: 开放需求发现
-> Gate A: 形成和筛选候选
-> Wave B: 替代、买方、支付、获客、监管和反证
-> Gate B: retained/watchlist/rejected
-> Wave C: formal Thesis、enrichment、comparison 和 recommendation
```

Wave 之间顺序执行并设置 Gate；同一 Wave 内部并行。

### RR-DISC-004 监管/反证 lane 过载

状态：`CONFIRMED_RUNTIME`

监管 lane 同时覆盖 5 个候选、中央法规、地方分类风险、未成年人数据、官方平台、App 评论、MOOC 研究和企业披露，最终包含 13 个来源、37 段精确引文和 5 个候选判断。该 lane 用时约 49 分钟，其他 lane 约 15-17 分钟。

期望修复：

- 首轮只进行限时 hard-gate scan，判断是否存在明显不可做边界。
- 候选收敛后，只对 retained candidate 做深入监管审查。
- 监管、公共 baseline 和用户反信号必要时拆成不同 research tasks。
- 为每条 lane 设置时间预算、最大来源数和 straggler policy。

### RR-DISC-005 缺少研究时间预算和渐进深度

状态：`CONFIRMED_RUNTIME`

宽泛的“教育行业”请求直接生成 5 条高覆盖 lane，没有显式总预算、per-lane 预算或先浅后深策略。

期望修复：

- Intake 增加 research depth 或时间预算。
- 默认 quick discovery 先执行 2-3 条最具信息增益的 lane。
- 只有首轮 fan-in 改变候选边界时才追加深度研究。
- 超时 lane 可正式降级为 partial，不阻塞全部候选的阶段性简报。

### RR-DISC-006 Fan-in 缺少下一阶段可执行性 Gate

状态：`CONFIRMED_RUNTIME / CONFIRMED_CODE`

本次 fan-in 成功通过 schema、reference 和 candidate disposition validation，但 retained 集合实际包含两个 `demand_seed` 和一个 `baseline_seed`，没有 retained `solution_seed`；同时 fan-in 只记录 `solution_evaluation_required=true`。直到后续 G2.3 闭包审查，main Agent 才发现 watchlist solution 不能转换为 Solution Hypothesis，Run 因而无法进入 Opportunity Thesis、comparison 或 report。

fan-in 的机械成功不应被理解为下一阶段可执行。当前统一的 `retained/watchlist/rejected` 还混合了需求方向、比较 baseline 和 solution option，容易让用户把“保留三个对象”误解为“发现三个机会”。

期望修复：

- fan-in 输出显式 `next_stage_readiness`：`ready | blocked | terminal`。
- readiness 必须列出下一阶段要求的 candidate kinds、当前缺失类型、阻塞 refs 和允许的下一动作。
- 当 `solution_evaluation_required=true` 且没有可转换的 retained `solution_seed` 时，不得返回 `ready`。
- 分开输出 retained opportunity directions、required comparison baselines、watchlist solution hypotheses 和 rejected candidates。
- fan-in 发布后立即执行 readiness Gate；不得等到后续 conversion builder 才发现当前 Run 无法继续。
- Gate 只验证 caller 提供的 candidate roles、lineage 和 disposition，不由 Harness 发明 solution 或替代 main Agent 的研究判断。

### RR-DISC-007 Gap Snapshot 没有基于 fan-in 和 Evidence 判断真实阻塞

状态：`CONFIRMED_RUNTIME`

本次 Gap Snapshot 的 `observed_artifact_refs` 只有 `manifest.json` 和当前 Plan，`evidence_refs=[]`，却在说明中引用了未进入正式 basis 的 fan-in。它只生成一个 buyer/acquisition `mandatory_dimension_missing`，并把 5 个 research question 全部列为 unresolved；没有识别 fan-in 中缺少 retained `solution_seed` 这一下一阶段结构性阻塞。该问题直到 Runtime 后续人工检查 G2.3 转换合同时才被发现。

这使 Gap 更像“Plan 维度检查”，而不是“研究完成后的下一步决策分析”。它既不能准确解释哪些 Evidence 已经回答了问题，也不能区分证据缺口、candidate-kind 缺口、方法边界和工程阻塞。

期望修复：

- wave-completed Gap 必须以已发布 fan-in、相关 lane、Judgment、candidate dispositions 和 Evidence refs 为正式 basis，不能只观察 Manifest/Plan。
- Gap 输出区分 `evidence_missing`、`candidate_kind_missing`、`method_boundary`、`no_information_gain` 和 `runtime_blocked`，并说明各自允许的下一动作。
- 自动检查 fan-in 的 `next_stage_readiness`；缺少 required candidate kind 必须在当前 Gap 中显式出现，不得留到后续 builder 才发现。
- `unresolved_decision_relevant_questions` 必须从已有 Judgment 和 Evidence coverage 确定性计算，不能把所有 Plan 问题机械标为未解决。
- 每个 blocking gap 的 subject、basis、evidence 和触发说明必须引用闭合且彼此一致。

### RR-DISC-008 证据不足被错误用于跳过追加调研并掩盖工程失败

状态：`CONFIRMED_RUNTIME / CONFIRMED_CODE`

本次 Gap 标记 `material_new_evidence_observed=true`、`stop_signals=[]`，推荐新增 `search_content_gap`，follow-up round 仍为 `0/1`。Policy 因此拒绝 `stop_followup`，要求执行一条有界 buyer/acquisition follow-up；但该轮因 `RR-ENG-007` 未能发布和执行，系统随后仍允许基于同一个旧 Gap 直接 `terminate_insufficient_evidence`。

终止理由还新增“没有 retained solution seed”，但该理由不在触发 Gap 的 basis/evidence refs 中。最终状态因而混合了三种不同事实：初轮公开 Evidence 确实有限、追加调研尚未执行、Plan Revision 工程失败。

证据不足通常应触发 decision-relevant follow-up，而不是自动停止。只有以下条件之一被正式证明时，才可以结束当前研究：

- 有界 follow-up 已执行，新增来源重复或信息增益不足；
- 缺口超出允许的方法边界，继续公开研究无法回答；
- follow-up 预算或轮次已耗尽；
- 补齐该证据也不会改变候选 disposition 或建议；
- 已有决定性反证足以淘汰方向。

期望修复：

- `terminate_insufficient_evidence` 必须完全闭合到 latest Gap；终止理由不得引入 Gap 未记录的新阻塞。
- latest Gap 要求且仍允许执行的 follow-up 未完成时，不得进入 `insufficient_evidence` 终态。
- adaptation/apply 失败必须投影为显式工程阻塞，不能被研究终止动作覆盖或解释为 Evidence ceiling。
- 对“已有新证据，但剩余问题只能通过当前禁用的外部验证回答”提供正式 `method_boundary` 停止依据，避免被迫重复公开搜索。
- 缺少 retained `solution_seed` 时，默认动作是进入有界 solution generation/evaluation wave；只有该 wave 已执行、明确越界或预算耗尽后，才能据此终止。
- 终止前重新生成 Gap Snapshot，记录 follow-up 执行结果、stop signals、剩余缺口和下一步验证；不得复用已被后续失败改变语境的旧 Gap。

当前修复状态：`PARTIALLY_FIXED_CODE`。当前 policy 已拒绝在仍有预算、存在 recommended unit、已有 material Evidence 且无 stop signal 时直接终止，`RR-ENG-012` 的表示无关 closure 也已修复；method-boundary 表达、solution generation/evaluation 衔接和 latest Gap 重建仍未完成。

## 6. Assessment 工作流静态审计

### RR-ASSESS-001 十个评估维度被硬编码为十个必需 enabled unit

状态：`CONFIRMED_CODE`

Assessment validator 固定要求以下十个维度恰好各一次：

1. target user 与 JTBD；
2. demand 与 behavior；
3. alternatives 与 solution failure；
4. competitor saturation 与 differentiation；
5. buyer language 与 willingness to pay；
6. acquisition 与 distribution；
7. business engine viability；
8. delivery feasibility；
9. compliance 与 platform risk；
10. counter-evidence。

每个维度还必须绑定一个 enabled Research Plan unit。最终报告覆盖十维是合理的，但不应自动等价为十个独立 research agent。

期望修复：

- 分离 `reporting coverage dimensions` 与 `execution lanes`。
- 允许一条综合 research lane 为多个维度提供 typed outputs，同时保持逐维 Judgment。
- 默认把十维压缩为 4-5 条证据工作流，而不是十条重复检索任务。

### RR-ASSESS-002 缺少显式 early-kill staging

状态：`CONFIRMED_CODE`

当前合同允许 fan-in 记录 skipped/missing branch，也允许 thesis-killing opposition 导致 `deprioritize`，但初始 Assessment Plan 仍要求十个维度和对应 enabled unit。没有默认规则先验证需求、强替代、反证或关键合规，再决定是否投入买方、获客、商业模型和交付研究。

建议流程：

```text
Thesis clarification and user confirmation
-> Wave 1: demand, JTBD, alternatives, counter-evidence, risk-sensitive compliance
-> Early Gate: deprioritize or continue
-> Wave 2: competitor, buyer, acquisition
-> Commercial Gate
-> Wave 3: business engine, delivery, remaining compliance
-> audit, assessment and report
```

### RR-ASSESS-003 动态补证只覆盖 buyer 和 acquisition

状态：`CONFIRMED_CODE`

专用 assessment adaptation policy 只允许为以下缺口新增 unit：

- `buyer_language_and_willingness_to_pay`
- `acquisition_and_distribution`

需求、竞品、交付或合规出现决定性但可补证的缺口时，没有同等级的动态追加入口。

期望修复：

- 评估是否扩展为受控的 decision-relevant follow-up 集合。
- 保持 closed policy，不开放任意 DAG。
- 每种新增类型都必须有明确 gap type、上限、停止条件和 plan revision 绑定。

### RR-ASSESS-004 不完整 Thesis 可能被过早固化

状态：`CONFIRMED_CODE / NEEDS_REAL_RUN`

ConceptHypothesis 要求 product thesis、target user、buyer、entry scene、claimed value、current alternatives、delivery form、business model 和 acquisition hypothesis 均非空。如果用户只提供粗略想法，Agent 可能被迫补全并冻结未经用户确认的关键商业假设。

期望修复：

- 对影响研究方向的缺失字段先请求用户确认。
- 为关键字段记录 `user_provided`、`agent_assumed` 或 `unknown` provenance。
- 未确认字段不得在报告中表现为用户已接受的前提。

### RR-ASSESS-005 报告出口完整，但仍偏技术化

状态：`CONFIRMED_CODE`

Assessment 已覆盖 `prioritize`、`investigate_further`、`deprioritize` 和 `insufficient_evidence` 四种结果，并能为 `insufficient_evidence` 生成三个报告视图。

仓库并非没有 Discovery 报告能力。G2.4 已复用 Assessment 的 structured-source、traceability、consistency 和 materialization 机制，Discovery 也有 `report.json`、`decision-brief.md` 和 `report.md` 三个出口。差异在于：

- Assessment 报告合同可以表达证据不足的评估终态；
- Discovery 当前报告合同依赖已完成的 comparison、portfolio、sensitivity、decision recommendation、traceability 等完整下游闭包；
- 本次 Run 在 fan-in 和 Gap Snapshot 后提前终止，没有进入上述阶段，因此无法构造当前 Discovery report source，也没有触发报告物化。

因此，Assessment 比本次 Discovery 做得好的不是 renderer 是否存在，而是“证据不足也能进入正式报告出口”的终态覆盖。

但当前 Decision Brief renderer：

- 固定使用英文标题和标签；
- 直接输出 `insufficient_evidence` 等内部枚举；
- 把 Artifact refs 放在主要论据文本中；
- 输出 raw boolean 和执行边界字段。

期望修复：

- 使用 Run research language 本地化标题、结果标签和固定文案。
- primary brief 只保留人类可读来源名和链接；内部 refs 移入审计附录。
- 把机器枚举翻译为明确行动建议。

当前修复状态：`FIXED_CODE_TESTED`。Decision Brief v3 由共享 terminal source 确定性派生，按 `research_language` 本地化标题、标签和枚举；primary brief 使用来源名称、URL、有效日期、stance/strength 和具体 claim，内部 refs 只进入审计附录。永久测试覆盖中文 `insufficient_evidence`、raw enum/boolean 不泄漏、三视图一致性与 reopen recovery；新真实 assessment Run 仍由 `RR-ASSESS-006` 验证。

### RR-ASSESS-006 需要真实 Run 验证

状态：`NEEDS_REAL_RUN`

仓库当前没有真实 assessment Run。完成上述静态修复设计后，至少执行一次具体、边界清晰的真实 thesis assessment，验证：

- 初始化与 Plan 装配耗时；
- 十维 task 的实际 dispatch 和来源重复率；
- early-kill 是否真正停止后续工作；
- buyer/acquisition follow-up 是否可恢复；
- `insufficient_evidence` 是否仍交付清晰中文 Decision Brief。

## 7. 用户交付问题

### RR-UX-001 共享终态报告闭环，并覆盖 Discovery 提前终止

状态：`CONFIRMED_RUNTIME / CONFIRMED_CODE`

本次 discovery 以 `insufficient_evidence` 终止，未生成正式报告。用户被引导查看 fan-in、termination decision 和 Manifest JSON。

根因不是缺少 Discovery renderer，而是当前 `terminate_insufficient_evidence` 路径只改变 Run 状态并记录 limitation，没有要求生成终态 report source；同时完整 Discovery report schema 又要求尚未产生的 comparison、portfolio、sensitivity、recommendation 和 traceability refs。

应反向复用 Assessment 的终态报告闭环，但不能为了通过完整 Discovery schema 而伪造未执行阶段的 Artifact。

期望修复：

- 抽取两个工作流共享的 terminal reporting core：决策问题、当前建议、结果含义、决定性支持、决定性反证、关键未知、改变决定所需证据、freshness、limitations 和 external-action boundary。
- 为 Discovery 增加 early-exit/terminal report source，可引用已有 fan-in、Gap Snapshot、Adaptation Decision、Evidence 和 Plan lineage，不要求不存在的 comparison 或 portfolio。
- 完整 Discovery Run 继续使用当前 portfolio/comparison report 合同；提前终止 Run 使用显式标注 completeness 和未执行阶段的 terminal report 合同。
- `completed`、`insufficient_evidence`、`deprioritize`、`blocked` 和其他受支持终态都必须进入 reporting finalizer；终态交付不得只停在 Manifest 状态变更。
- 复用现有 deterministic materialization、三视图一致性检查、immutable sidecar 和 reopen recovery，不另建一套非审计报告路径。
- 研究判断仍由 main agent 通过正式 report source 提供；Harness 只做校验、派生视图、发布和恢复，不引入隐藏 LLM 调用。
- Brief 必须先回答“现在应该做什么”，再解释证据。
- 没有可投资机会也是合法结论，但必须说明下一步验证优先级。

当前修复状态：`FIXED_CODE_TESTED`。v17 `terminal_report_source.v1` 不依赖未执行的 comparison/portfolio，可用于 Discovery 或 Assessment 的完整/提前收口。正式 `terminate_insufficient_evidence` apply 在任何 receipt/Manifest 写入前要求显式 main-agent source，随后复用既有 immutable sidecar、三路径 materialization、consistency scan、exact replay 和 reopen recovery。缺失 source 的合法 termination 零写入拒绝；Plan/report fault 均有永久恢复测试。Harness 不生成研究判断。

### RR-UX-002 JSON 是审计层，不是用户入口

状态：`CONFIRMED_RUNTIME`

Evidence Store、Manifest、typed Artifact 和 receipt 应继续作为可审计事实层，但默认交付不得要求创业者理解 schema、refs、fan-in 或 plan revision。

Decision Brief 至少回答：

1. 当前应该做什么决定；
2. 最值得关注的方向或当前 thesis 是什么；
3. 用户、场景、问题和具体产品假设是什么；
4. 支持与反对依据分别是什么；
5. 为什么没有选择其他方向；
6. 当前动作是投入、继续验证、暂缓还是淘汰；
7. 什么新证据会改变决定。

期望修复：

- primary brief 直接列出关键来源名称、可访问链接、有效时间和其支持或反对的具体判断，不以内部 Artifact 路径代替业务依据。
- 对每个优先方向分别呈现决定性支持、决定性反证、证据强弱和仍无法回答的问题。
- JSON path、content hash、schema version 和完整 refs 保留在审计附录，不进入主要结论段落。
- 用户不打开任何 JSON，也能理解方向为何保留、为何暂缓、为何淘汰以及结论的可信边界。

当前修复状态：`FIXED_CODE_TESTED`。Decision Brief v3 是 materialized primary view，先给当前动作与结论含义，再展示每个方向的可读 Evidence 支持/反证、strength、未知项和 freshness；JSON path、schema/hash 和完整 refs 留在 `report.json` 与 Brief 审计附录。测试断言主要结论段不出现内部 `artifacts/` 路径。

### RR-UX-003 结论必须具体到可测试产品假设

状态：`CONFIRMED_RUNTIME`

“成人职业转型结果链”和“家庭非教学学习协调”仍是问题空间描述，不是可执行的创业建议。

本次 Run 更可读的表达应类似：

- 成人方向：针对一个窄职业转型场景，测试“目标岗位 -> 能力差距 -> 实践任务 -> 反馈 -> 雇主可读工作样本”的结果闭环，而不是新增课程。
- 家庭方向：只测试“把已有教师反馈转换为家庭待办、提醒、分工和复盘”的非教学、低数据协调工具；当前优先级低于成人方向。

这些仍是待验证产品假设，不能被表述为市场已经成立。

期望修复：

- 报告区分问题空间、需求假设、solution seed、可测试产品假设和已获得支持的 Opportunity Thesis，不得混用为“创业机会”。
- 每个建议方向必须包含目标用户、窄场景、当前替代、具体产品/服务形态、核心价值、关键风险和最先验证的假设。
- 输出明确的方向优先级和比较理由；不能只并列列出多个模糊需求区。
- 下一步必须是有顺序的验证计划，说明先验证什么、为何先验证、通过/失败信号是什么，以及结果如何改变继续、暂缓或淘汰决定。

当前修复状态：`FIXED_CODE_TESTED`。terminal source/Brief v3 强制区分 problem space、demand hypothesis、solution seed、testable product hypothesis 和 supported opportunity thesis；每个方向包含优先级、目标用户、窄场景、当前替代、产品形态、核心价值、风险、首个可测试假设和比较理由。`ordered_validation_plan` 要求连续顺序、why-now、pass/fail signal 和 decision effect，并对用户自主管理的外部验证保持不执行/不跟踪边界。

### RR-UX-004 最终回复混淆研究完成、证据结论和工程阻塞

状态：`CONFIRMED_RUNTIME`

本次最终回复以“调研已完成”开头，但 required buyer/acquisition follow-up 没有执行，solution generation/evaluation、Opportunity Thesis、comparison 和 report 均未完成；Plan Revision 还因 Harness 故障失败。回复只把终态解释为买方证据不足和缺少 retained solution seed，没有披露系统先要求追加调研、追加调研因工程故障未执行、随后才被允许终止。

这会让用户把“当前 Run 没有完成研究流程”误解为“完整研究已经证明方向没有足够证据”。聊天回复还成为事实上的唯一交付，但它不是经过 traceability、freshness 和 consistency 检查的正式 Artifact。

期望修复：

- 最终交付必须分别声明 `execution completeness`、`research conclusion` 和 `runtime health`，三者不得合并为一个笼统的“完成/失败”。
- 只有所有 required Gate 和 follow-up 已执行或被 latest Gap 合法关闭，且不存在 pending operation、工程阻塞或缺失终态报告时，才能使用“调研已完成”。
- 因工程故障未执行的阶段必须列出阶段、失败原因及其对结论可信度和允许措辞的影响；不得将其改写为 Evidence ceiling。
- 最终聊天回复必须从已验证 terminal report source 派生，结论强度不得高于正式 Artifact；聊天消息不能替代缺失的 Decision Brief。
- 部分完成时，首屏先说明“已完成什么、未完成什么、为什么未完成”，再给出当前仍可成立的业务判断和恢复后的下一步。
- 对本次场景，合格措辞应为：“初轮 discovery 已完成；buyer/acquisition follow-up 和 solution generation/evaluation 尚未完成，Run 因 Harness 故障提前收口。当前只能保留两个待验证需求区，不能形成、排序或推荐 Startup Opportunity。”

当前修复状态：`FIXED_CODE_TESTED`。terminal source、Brief 和完整 report 分别呈现 `execution`、`research_conclusion` 与 `runtime_health`；false completion、blocked runtime 下的强结论、伪 freshness 和 derived drift 均 fail closed。`status-run` 新增 `terminalReportDisposition` 与稳定 `terminalReportIssues`，因此 post-Manifest 故障窗口会显示 `terminal + missing`，精确重放并完成正式 Brief 后才显示 `ready`。最终聊天仍必须由 main agent 从该已验证 source/Brief 摘要，不能替代 Artifact。

## 8. 建议修复顺序

### 已实现候选修复，待真实 Run 验证

1. `RR-ENG-003` Planning Context leaf/live binding。
2. `RR-ENG-004` 中 Plan 到 Task canonical output path。
3. `RR-ENG-007` 中 ordinary post-G2 durable candidate binding 和 pending divergent fail-closed。
4. `RR-ENG-008` v5 Gap/Decision Manifest lifecycle projection。
5. `RR-DISC-008` 中 follow-up-available termination guard。
6. `RR-ENG-009` 中 freshness/stance 重算和 ISO time-bound 校验。
7. `RR-ENG-010` 中 `status-run` continuation derived disposition。

### 本轮已完成的 P0 代码修复

1. `RR-ENG-001` Create Run staging + atomic publish：`FIXED_CODE_TESTED`。
2. `RR-ENG-002` 基于 run_id 的验证闭包装配：`FIXED_CODE_TESTED`。
3. `RR-ENG-004` 统一 Gap analyzer、Artifact validator 和 Store fragment resolver：`FIXED_CODE_TESTED`。
4. `RR-ENG-011` completed no-revision receipt 与真正 pending intent 的区分：`FIXED_CODE_TESTED`。
5. `RR-ENG-012` 表示无关的 termination basis closure：`FIXED_CODE_TESTED`。

### P1：保证用户一定收到决策产品

1. `RR-UX-001`：`FIXED_CODE_TESTED`。
2. `RR-UX-004`：`FIXED_CODE_TESTED`。
3. `RR-UX-002`：`FIXED_CODE_TESTED`。
4. `RR-ASSESS-005`：`FIXED_CODE_TESTED`。
5. `RR-UX-003`：`FIXED_CODE_TESTED`。

### P1：修复研究方法和关键路径

1. `RR-ENG-006` 建立 Declarative Research Runtime 与全流程 Artifact compilation，不允许正式 Run 依赖 per-Run 临时程序。
2. `RR-DISC-006` 增加 fan-in 下一阶段 readiness Gate 和按角色分类的 dispositions。
3. `RR-DISC-007` 让 Gap 基于 fan-in/Evidence 判断真实阻塞和允许动作。
4. `RR-DISC-008` 修复 follow-up、方法边界、工程阻塞和终止语义。
5. `RR-ENG-009` 把 time coverage 收敛为确定性结构化派生值。
6. `RR-ENG-010` 为所有消费者提供权威 continuation/current-leaf 读取面。
7. `RR-DISC-002` 开放需求研究不预绑 candidate/solution。
8. `RR-DISC-003` discovery Wave A/B/C Gate。
9. `RR-DISC-004` 监管 hard-gate scan 与候选收敛后的深审分离。
10. `RR-ENG-005` 同 wave task 批量 dispatch。
11. `RR-DISC-005` 时间预算、渐进深度和 straggler policy。

### P2：重构 Assessment 执行模型

1. `RR-ASSESS-001` 十维报告覆盖与执行 lane 解耦。
2. `RR-ASSESS-002` early-kill staging。
3. `RR-ASSESS-003` 受控扩展 decision-relevant follow-up。
4. `RR-ASSESS-004` Thesis 字段 provenance 和用户确认。
5. `RR-ASSESS-006` 真实 assessment Run 验证。

## 9. 性能与交付验收目标

以下是产品目标，实施前需要转成正式测试和可观测指标：

| 环节 | 目标 |
| --- | --- |
| `doctor + create-run` | 秒级；失败不留可见 Run |
| clean Run 到 Plan 激活 | 2-5 分钟 |
| Plan 激活到同 wave 全部 agent 启动 | 1-2 分钟 |
| clean discovery 启动前总准备 | 5-8 分钟以内 |
| 初始普通 research lane | 默认 15-20 分钟时间箱 |
| 监管/反证首轮 | 只做 hard-gate scan，不做全候选深审 |
| `handoff_ready` 到 typed lane 发布 | 无语义返工时 1-2 分钟 |
| 同 wave 全部 typed lane 发布到 fan-in | 无语义返工时 2-3 分钟 |
| validation closure | 由 run_id 自动解析最小传递闭包，不重复携带整个 Run |
| fan-in publication | 必须同时给出下一阶段 readiness、缺失 candidate kinds 和允许动作 |
| fan-in 到 Gap Snapshot | 无语义返工时 1-2 分钟；Gap basis 必须包含实际 fan-in/Judgment/Evidence closure |
| Plan Revision apply | 无研究语义返工时秒级原子完成；deterministic rejection 不留 receipt，已发布 intent 可 exact replay |
| Plan operation state | 只有真正未完成的 receipt 阻塞 divergent operation；completed no-revision receipt 不误阻塞 |
| follow-up 与终止 | 未执行的 required follow-up 或工程失败不得投影为 `insufficient_evidence` |
| termination closure | bare/enveloped Decision 得到相同结果，所有终止依据由 latest Gap basis 闭合 |
| terminal consistency | 不存在 pending Plan operation、未分类 adaptation 或缺失 latest Gap lineage |
| Source Manifest | freshness、stance 和结构化时间边界全部从 accepted Evidence 确定性派生 |
| continuation status | parent、child 和 current leaf 在 CLI、Runtime、报告和恢复入口得到一致 disposition |
| 任意终态 | 必须存在人类可读 Decision Brief |
| 完成状态措辞 | 与已执行 Gate、follow-up、pending operation 和 runtime health 一致；部分执行不得称为“调研已完成” |
| primary brief | 用户无需打开 JSON 即可理解结论、关键来源、支持与反证、证据强弱和下一步 |
| 行动建议 | 明确方向优先级、具体可测试产品假设、验证顺序及通过/失败信号 |

## 10. 非目标与约束

- 不因优化耗时而降低 Evidence、引用、freshness、counter-evidence 或 traceability 要求。
- 不让 Harness 发起隐藏 LLM 调用或重实现 Codex agent loop。
- 不让 Harness 自动判断来源可信度、Evidence stance、candidate disposition、rationale 或研究建议；工程化的是装配和验证，不是研究语义。
- 不把“Harness 不生成研究语义”解释为“Runtime 必须编写装配程序”；Runtime 与 Harness 之间必须是声明式数据合同。
- 不执行访谈、广告、落地页、押金、付费实验或 MVP 外部验证。
- 不把 schema、Store 或 report materialization 成功解释为市场验证成功。
- 不在本文中直接修改当前 Plan、Manifest、policy 或 implementation progress 状态。

## 11. 下一步

1. 五项 P0 与 terminal Brief P1 已达到 `FIXED_CODE_TESTED`；下一优先项是公开、版本化的 declarative compiler/orchestrator surface，以及其依赖的 Discovery readiness、Gap 和 execution model 修复。
2. 为其余 P1/P2 项形成最小、可排序的 repair slices，按依赖和风险顺序实施，并在每项完成后更新本文的修复状态与验证证据。
3. P0 与终态 Brief 已完成，可在剩余关键路径修复闭合后重放同一 discovery 场景，验证 `FIXED_CODE_TESTED` 项、时间、追加调研和交付质量。
4. 新真实 discovery Run 通过后，再把相应条目标记为真实运行已修复；旧 Run 不属于修复或迁移范围，可在不再需要复盘证据时删除。
5. 再执行一个窄范围真实 assessment Run，验证十维执行模型和 early-kill 设计。

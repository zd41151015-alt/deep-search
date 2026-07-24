# Startup Opportunity Research Harness 实施进度

> **状态**: IN_PROGRESS / G0_FOUNDATION_IN_PROGRESS
> **当前 Gate**: G0 Foundation Harness=`IN_PROGRESS`；G1-G4=`NOT_READY`
> **下一独立会话**: 中控验收本次 contract 修正提交后，恢复 G0.4 implementation；验收前不得创建 G0.R 或开放 G1
> **最后更新**: 2026-07-23
> **规范权威**: `startup-opportunity-codex-research-harness.md`

## 文档职责

本文是 Startup Opportunity Research Harness 的跨会话实施状态账本，负责记录详细施工步骤、当前 Gate、已完成切片、真实交付物、验证证据、提交、阻塞和下一独立会话。

本文不重新定义业务语义、artifact 含义、比较政策或研究方法。发生冲突时按以下顺序处理：

```text
用户当前明确指令
  -> startup-opportunity-codex-research-harness.md
  -> 已发布 schema / policy / deterministic contract
  -> 本进度账本
  -> 单次施工会话 prompt
```

如果实现发现 RFC 存在歧义、冲突或不可执行约束，当前切片必须标记 `BLOCKED_BY_SPEC`，记录最小复现和受影响章节；先修正规范及相关 contract，再恢复实现。不得让代码、fixture 或施工 prompt 私自选择业务语义。

RFC 第 30 节只维护稳定阶段；本文件维护详细、可变的施工切片。已完成切片的证据只追加或更正，不用未来计划覆盖历史结果。

## 中控与施工会话模式

- 中控会话只负责读取账本、检查当前施工任务、验收结果、处理返修和创建下一独立任务；有施工任务 active 时保持只读，不与施工任务并发写仓库。
- 一个施工会话只完成一个原子业务目标；不得在同一会话顺手进入下一个切片或 Gate。
- 所有施工直接使用本地项目和当前分支，不创建 worktree，不 Handoff，不推送。
- 同一时刻只允许一个写入型施工会话。中控、回归会话和人工操作都必须遵守单写者约束。
- 施工任务原则上不再创建 subagent；需要独立性时由中控创建新的 Codex 任务，而不是在同一任务内自审。
- 每个 Gate 的实现会话只产生 `EXIT_CANDIDATE_PENDING_INDEPENDENT_REGRESSION`；下一任务必须是独立 whole-gate regression。回归通过后才可标记 `DONE` 并开放下游 Gate。
- 任务失败或证据不足时优先向原任务发送一次定向返修消息，保留其工作区和上下文；不得直接创建重复替代任务。

## 强制施工协议

每个新施工会话开始前必须：

1. 完整阅读 `startup-opportunity-codex-research-harness.md`，不得用 prompt 摘要或本账本替代 RFC。
2. 完整阅读本文，确认 current Gate、唯一下一切片、上游证据、禁止边界和当前工作树说明。
3. 执行 `git status --short`、`git branch --show-current`、`git log -5 --oneline`，阅读本文记录的最后施工提交；遇到未说明改动必须保留并判断归属。
4. 使用 `rg` 建立本切片涉及的 schema、policy、script、artifact、test 和文档引用索引。
5. 明确本次允许修改路径、禁止范围、退出条件和验证命令后再编辑文件。
6. 如果工具链或实现语言尚未由已完成上游切片冻结，只能在当前明确负责该决策的切片中选择并记录依据，不得由下游临时引入第二套栈。

每个施工切片结束前必须：

1. 完成该切片定义的生产目标代码、schema/policy、fixture 和测试，不用 skeleton、mock-only 或 TODO 冒充完成。
2. 运行专项测试以及所有真正受影响的上游回归；记录真实命令、数量和结果，未运行项必须说明原因。
3. 更新本文的 Gate、工作包、切片状态、交付物、风险、决策、提交占位和下一独立会话。
4. 执行 `git diff --check` 和 `git status --short`，确认没有覆盖其他改动或遗留无关生成物。
5. 将实现、测试和本文形成一个原子提交；提交信息应能定位 Gate/切片。保持工作树 clean，不 amend/rebase/reset 或改写历史，不推送。
6. 最终回复报告 commit、parent、验证证据、边界和下一任务建议；不得自行创建下一施工任务。

独立 whole-gate regression 会话必须从实现候选提交开始，只做审查、真实重放、故障/负例验证和必要的同 Gate 最小修复。它不能依赖实现会话的口头结论，也不能提前施工下游 Gate。

## 中控自动化协议

定时中控每 10 分钟执行一次。每次 heartbeat 必须先读取本文，再读取当前 automation rule 中记录的 active task 和 gate：

1. 没有 active task 且存在唯一 `READY` 切片时，创建一个本地独立施工任务。
2. 当前任务为 `active/inProgress` 时视为正常，不发送消息、不创建重复任务、不修改仓库。
3. 当前任务明确 `failed/error/cancelled/stopped` 或异常 idle 且未完成时，只向原任务发送一次保留现有改动的定向恢复消息。
4. 当前任务 completed 后，检查提交、parent、工作树、进度账本和测试证据；不合格时让原任务返修，合格时接受退出候选或创建下一任务。
5. Gate 实现候选之后只创建独立 whole-gate regression；回归通过前不得开放下一 Gate。
6. 连续两次状态查询卡住只记录 `UNKNOWN`，不干预；连续第三次仍卡住时尝试其他精确任务状态入口。仍不可用时，使用 Git、相关进程、账本/测试证据至少两类一致信号进行 `INFERRED` 推断；证据冲突保持 `UNKNOWN`。
7. 不使用额外的 600 秒门禁；每次定时 heartbeat 最多执行一次正常状态检查。普通 active/unknown 检查不算有效操作。

以下属于“有效操作”：

```text
create_worker
send_recovery_or_repair
accept_or_reject_completion
create_whole_gate_regression
mark_gate_done_or_blocked
advance_to_next_slice_or_gate
change_active_task
```

每次有效操作后，中控必须立即调用 automation update，完整重写下一次规则，至少包含：

```text
controller thread id
current gate and slice
active task id or none
expected base/head commit
required outcome and forbidden scope
latest accepted evidence
next allowed action
consecutive state-query failure count
last effective operation
```

不得只追加一条模糊说明或依赖旧 heartbeat 记忆。没有发生有效操作时保留当前规则，不做无意义 rewrite。自动化通知默认只报告失败或需要用户决定的阻塞；正常 active heartbeat 不打扰用户。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| `NOT_READY` | 上游 Gate 未完成，禁止开始 |
| `READY` | 依赖满足，可以创建唯一施工任务 |
| `IN_PROGRESS` | 当前切片正在施工，尚未满足退出条件 |
| `REPAIR_CANDIDATE_PENDING_ACCEPTANCE` | 被拒绝候选已定向修复并提交，等待中控独立复验 |
| `EXIT_CANDIDATE_PENDING_INDEPENDENT_REGRESSION` | 实现候选已提交，等待独立整体回归 |
| `BLOCKED_BY_SPEC` | RFC/contract 存在不可唯一决定的阻塞 |
| `BLOCKED_BY_ENV` | 工具链、平台或外部依赖持续阻塞 |
| `DONE` | 独立回归通过，交付物、证据和提交完整 |

状态只能根据仓库事实、正式 artifact 和验证证据更新。目录存在、类型 skeleton、happy-path、跳过测试、聊天摘要或未提交工作树均不构成 `DONE`。

## 固定实施原则

- 优先完成可运行的纵向切片，不继续用文档细化替代实现反馈。
- 先实现 `assess`，再实现 `discover`；单 thesis 合同未闭环前不建设多候选发现流程。
- Gap Snapshot、Adaptation Decision 和 Plan Revision 必须在 G1 中真实跑通，不能推迟到 discovery 后补。
- Agent 负责开放式语义判断；Harness 负责 schema、refs、policy、幂等、原子发布、恢复和 evaluator。确定性脚本不得隐藏 LLM 调用。
- 所有正式 artifact 采用临时写入、校验后原子发布；已被 checkpoint 引用的 artifact 不原地覆盖。
- 测试强度随风险增长：schema 需要正反 fixtures，存储需要 crash/reopen，adaptation 需要 idempotency/stale-base/late-artifact，报告需要 traceability/一致性。
- 不实现通用 Workflow Runtime、任意 DAG/DSL、Web 工作台、外部验证执行、跨国家统一排名、运行时人工调权或 Agent 成本账本。
- 每个工作包都必须保留 RFC 规定的消费者产品边界、单一 primary market/language、证据结论上限和 abstention。

## 初始仓库基线

创建本账本时：

| 项目 | 状态 |
| --- | --- |
| 分支 | `main` |
| HEAD | `62e02b7` |
| 已有实现 | 无；仓库只有占位 README 和 RFC |
| 已知工作树 | `startup-opportunity-codex-research-harness.md` 包含已确认但未提交的动态扩展完善；本账本为新增文件 |
| 允许的首任务 | 只执行 G0.1，并保留、审阅和纳入上述文档改动 |
| 禁止 | 在 G0.1 内实现 Run Store、完整 schema bundle、assessment 或 discovery |

G0.1 完成后必须把真实工具链、提交和 clean baseline 回写到本节。

中控初始化期间检测到上述 setup 改动已由同一条本地 `main` 提交链原子保存，并完成对账：

| 提交 | Parent | 内容 | 状态 |
| --- | --- | --- | --- |
| `124e458` | `62e02b7` | 数据驱动动态扩展 RFC 完善 | accepted |
| `4033ae5` | `124e458` | 新增实施进度账本并建立 RFC 施工职责引用 | accepted current baseline |

G0.1 的真实 clean 起点更新为 `main@4033ae5`；不得再把 `62e02b7` 当作 current HEAD 或重复提交上述文档。

### G0.1 工具链冻结

| 决策 | 冻结值 | 依据 |
| --- | --- | --- |
| 实现语言 | TypeScript `7.0.2` | Harness 以 typed JSON artifact、CLI 和跨平台文件操作为主；严格类型检查可在 schema/store 实现前先约束入口和路径合同 |
| 运行时 | Node.js `24.18.x` LTS；`.node-version=24.18.0` | 本机已有 LTS 运行时；后续确定性脚本、Node test runner 和 JSON 工具可共用一个 runtime |
| 包管理器 | npm `11.16.x`；`packageManager=npm@11.16.0` | 随目标 Node 工具链提供，不引入 pnpm/yarn/bun/uv 等第二套安装面 |
| Lockfile | `package-lock.json` v3 | `npm ci` 可从 clean dependency tree 重放；package 和 transitive version 均已锁定 |
| 质量入口 | Biome `2.5.5`、TypeScript compiler、Node test runner + tsx | 分别提供真实 lint、typecheck 和 TypeScript test；不依赖第二种实现语言 |
| 安装脚本策略 | 仅批准 `esbuild@0.28.1`、`fsevents@2.3.3` | npm `allowScripts` 使用精确版本，不允许后续未审阅版本自动继承权限 |
| G0.1 提交 | `4fb428d54ea1656fe8a15ffdc1d4e963d4a4609e`；parent=`4033ae504219bfc6d616d76a1b2c44143e83cb42` | 实现、测试、本文和启动前 reconciliation 已由一个 clean 原子提交保存 |

## Gate 总览

| Gate | 状态 | 依赖 | 退出证据 |
| --- | --- | --- | --- |
| G0 Foundation Harness | `IN_PROGRESS` | RFC v1 | 工具链与仓库骨架、核心 schema、Run/Artifact Store、validator、checkpoint、Gap/Adaptation/Plan Revision、完整 foundation regression |
| G1 Concept Evidence Assessment | `NOT_READY` | G0 | 单 thesis 从 intake 到 report 的端到端闭环，buyer gap 触发 plan r2，独立 G1 回归 |
| G2 Opportunity Discovery | `NOT_READY` | G1 | discovery lanes、Demand/Solution synthesis、pre-kill/enrichment、比较/portfolio 和独立 G2 回归 |
| G3 AI Bundle | `NOT_READY` | G2 | 六维 AI mandatory bundle、baseline/reliability/data/economics/risk gates 和独立 G3 回归 |
| G4 Distribution / Operational Exit | `NOT_READY` | G3 | repo-local Skill/agents/hooks/MCP 完整入口、安装与恢复文档、端到端 fixture；Plugin 是否打包按 RFC 条件判断 |

## 工作包总览

| 工作包 | 范围 | 状态 |
| --- | --- | --- |
| W0 | Repository、toolchain、Skill/agent/Harness skeleton、测试入口 | `DONE` |
| W1 | Schema bundle、reference validator、artifact envelopes | `DONE` |
| W2 | Run Store、Artifact/Evidence Store、events/decisions/checkpoint/recovery | `DONE` |
| W3 | Research Plan、Gap Snapshot、Adaptation Decision、Plan Revision | `IN_PROGRESS`；contract 已修正，runtime 未实现 |
| W4 | Assess domain contracts、research branches、matrix、audit/review/report | `NOT_READY` |
| W5 | Discovery lanes、maps、synthesis、enrichment、comparison/portfolio | `NOT_READY` |
| W6 | AI mandatory bundle 和 gates | `NOT_READY` |
| W7 | Codex Skill、custom agents、hooks/MCP、分发和端到端运营 | `NOT_READY` |

## G0 Foundation Harness 施工切片

| 切片 | 内容 | 状态 | 主要退出条件 |
| --- | --- | --- | --- |
| G0.1 | Repository / Toolchain / Skill Skeleton | `DONE` | 冻结单一实现工具链和 lockfile；替换占位 README；建立 `AGENTS.md`、Skill references/scripts、custom agent、Harness/test 目录；最小 lint/typecheck/test 命令可运行；只建 skeleton，不提前实现 G0.2+ 业务逻辑 |
| G0.2 | Core Artifact Schema Bundle | `DONE` | artifact envelope、Run Manifest、Research Plan、Gap Snapshot、Adaptation Decision、Event/Decision、Checkpoint closed schemas；positive/negative fixtures；deterministic schema validation |
| G0.3 | Run / Artifact Store and Recovery | `DONE` | create/load run、atomic artifact publish、refs/hash、event/decision append、checkpoint、reopen/recovery、path traversal/write-conflict/idempotency fixtures |
| G0.4 implementation | Plan / Adaptation Runtime | `READY` | plan validator、machine gap draft、adaptation validator、immutable plan revision、stale-base/CAS、retry/supersede/late artifact、crash-boundary fixtures |
| G0.R | Independent Foundation Whole-Gate Regression | `NOT_READY` | 从 clean G0 candidate 独立重放全部 G0 tests、negative/fault/crash fixtures、determinism、git diff/check；通过后 G0=`DONE` |

## G1 Concept Evidence Assessment 施工切片

| 切片 | 内容 | 状态 | 主要退出条件 |
| --- | --- | --- | --- |
| G1.1 | Assess Domain Contract | `NOT_READY` | intake、DecisionContext、ScopeFrame、ConceptHypothesis、assessment plan/branch/fan-in、JudgmentAssessment、Evidence Matrix、BusinessEngine、Assessment closed schemas 和 fixtures |
| G1.2 | Evidence Store / Research Branch Vertical Slice | `NOT_READY` | public/user-provided evidence origin、canonical URL/hash/dedup、Claim/Finding/Insight refs、typed task envelope、至少需求/替代/buyer/counter-evidence branches 的可运行 fixture |
| G1.3 | Dynamic Buyer-Gap Adaptation | `NOT_READY` | plan r1 运行后 buyer gap 形成 Snapshot；validated `add_unit` 生成 plan r2；重复/stale/illegal adaptation 拒绝；无新证据 `stop_followup`；crash/reopen 可恢复 |
| G1.4 | Audit / Adversarial Review / Assessment / Report | `NOT_READY` | evidence audit、独立 challenger、assessment gate、四类 result、report.json/decision brief/full report 一致性与 traceability |
| G1.R | Independent Assess Whole-Gate Regression | `NOT_READY` | 端到端 assess fixture、正反结论、insufficient evidence、动态 adaptation、报告与恢复独立重放；通过后 G1=`DONE` |

## G2 Opportunity Discovery 施工切片

| 切片 | 内容 | 状态 | 主要退出条件 |
| --- | --- | --- | --- |
| G2.1 | Seed / Opportunity / Solution Space Maps | `NOT_READY` | industry/ai/hybrid profiles、seed-independent 和 counterfactual units、solution-neutral maps、initial questions |
| G2.2 | Discovery Lanes / Fan-in | `NOT_READY` | 用户语言、JTBD、替代、solution failure、pre-kill、多样候选保留、partial/failed/skipped/ignored-late fan-in |
| G2.3 | Demand / Solution / Thesis Synthesis | `NOT_READY` | Demand Thesis 先于 Solution、Baseline、solution evaluation、thesis freeze、dedupe/clustering、generation/evaluation source separation |
| G2.4 | Enrichment / Business Engine / Comparison | `NOT_READY` | buyer/market/acquisition/feasibility/counter evidence、BusinessEngine、hard gates、四面板、sensitivity、partial order、portfolio/report |
| G2.R | Independent Discovery Whole-Gate Regression | `NOT_READY` | general/industry/ai/hybrid fixtures、pre-kill skip、candidate diversity、comparison/report 全链独立回归；通过后 G2=`DONE` |

## G3 AI Bundle 施工切片

| 切片 | 内容 | 状态 | 主要退出条件 |
| --- | --- | --- | --- |
| G3.1 | AI Baseline / Reliability / Data Contracts | `NOT_READY` | generic model、platform、open-source baseline；代表性 evaluation、failure/human boundary、data rights/feedback、portability |
| G3.2 | AI Economics / Commoditization / Trust Gates | `NOT_READY` | product inference economics、bundle/substitution risk、capability half-life、adoption/trust、regulated-AI boundary |
| G3.3 | Mandatory Bundle Dynamic Coverage | `NOT_READY` | `uses_ai=true` 自动补齐六维 unit；not_applicable/insufficient 分离；缺失 bundle 限制结论；freshness continuation |
| G3.R | Independent AI Whole-Gate Regression | `NOT_READY` | technical、data、human review、economics、provider、trust 全 fixture 和动态 coverage 独立回归；通过后 G3=`DONE` |

## G4 Distribution / Operational Exit 施工切片

| 切片 | 内容 | 状态 | 主要退出条件 |
| --- | --- | --- | --- |
| G4.1 | Repo-local Skill / Agent / Hook / MCP Integration | `NOT_READY` | `$startup-opportunity` discover/assess/resume/status 路由；三类 agent；hook 降级可运行；MCP evidence adapter 边界 |
| G4.2 | Documentation / Installation / End-to-End Fixtures | `NOT_READY` | README、安装/使用/恢复、sample runs、clean checkout 验证、Codex 桌面/CLI/IDE 一致入口 |
| G4.3 | Plugin Decision and Packaging | `NOT_READY` | 只有满足跨仓库分发条件才打包 Plugin；否则记录 repo-local operational exit，不为完成 Gate 强行引入 Plugin |
| G4.R | Independent Operational Exit Regression | `NOT_READY` | 从 clean checkout 执行核心入口、恢复、报告和边界扫描；给出 repo-local release candidate 或明确 blocker |

## 当前中控状态

| 字段 | 当前值 |
| --- | --- |
| Controller thread | `019f91c5-be6f-7fc2-bf87-7f8418f49a8f` |
| Automation | `startup-opportunity-research-harness`；10-minute heartbeat；`ACTIVE` |
| Active task | G0.4 AI trigger source-binding contract follow-up；等待中控验收，不是 G0.4 runtime implementation |
| Current slice | `G0.4 implementation=READY` 但受中控验收 gate 约束；尚未启动；G0.R、G1-G4 未开放 |
| Expected base | follow-up 候选 `<G0.4_AI_TRIGGER_SOURCE_FIX_COMMIT>`；parent=`30b31754684ee83cc132ee4d3362307b98e27e23` |
| Consecutive state-query failures | `0` |
| Last effective operation | `g0_4_ai_trigger_source_followup_recorded` |
| Next allowed action | 中控从 clean candidate 独立验收 contract/version/tests；接受后只能创建 G0.4 implementation，不能创建 G0.R 或开放 G1 |

## 已完成切片与证据

| 切片 | 状态 | Commit | Parent |
| --- | --- | --- | --- |
| G0.1 Repository / Toolchain / Skill Skeleton | `DONE` | `4fb428d54ea1656fe8a15ffdc1d4e963d4a4609e` | `4033ae504219bfc6d616d76a1b2c44143e83cb42` |
| G0.2 Core Artifact Schema Bundle | `DONE` | `da820615af2c2b821cdb46a9130286e3e9575f59` | `4fb428d54ea1656fe8a15ffdc1d4e963d4a4609e` |
| G0.3 rejected implementation candidate | `REJECTED_BY_CONTROLLER` | `bcf84cdbda1d5e16c8ec039548ee2ef487d054ff` | `da820615af2c2b821cdb46a9130286e3e9575f59` |
| G0.3 accepted repair | `DONE` | `004ecc088027166a53ec44a647bb2a5564eeeba0` | `bcf84cdbda1d5e16c8ec039548ee2ef487d054ff` |

G0.1 交付物：

- 冻结 TypeScript/Node/npm 单一实现栈、engine guard、精确依赖和 `package-lock.json` v3；repository doctor 拒绝第二 lockfile 和工具链 metadata drift。
- 替换占位 README，增加 repo-local `AGENTS.md`，记录开发命令、正式 artifact、subagent ownership、受控 plan change 和外部动作边界。
- 建立 `$startup-opportunity` Skill、7 份 progressive-disclosure references、1 个可运行 doctor script 和 13 个按真实后续切片 fail-closed 的 RFC 命令入口。
- 建立 lane researcher、evidence auditor、adversarial reviewer 三类 project-scoped custom agent；字段符合 Codex standalone TOML contract，model/reasoning/权限默认继承父线程。
- 建立 Harness source entry、schemas/policies/templates/evals 和 store/validator/adaptation/comparison/reporting 责任目录；未发布空 schema、空 policy 或伪业务实现。
- 建立 Node test runner 入口和 9 个 skeleton/负例测试，覆盖 Skill YAML、agent TOML、doctor、reserved command 非零退出、缺失入口、metadata drift、第二 lockfile 和 lockfile/runtime 冻结。

G0.1 验证证据（Node.js `24.18.0` / npm `11.16.0`）：

| 命令 | 结果 |
| --- | --- |
| `npm ci` | PASS；12 packages installed，0 vulnerabilities；精确 `allowScripts` 策略后无未审阅脚本告警 |
| `npm run lint` | PASS；Biome checked 23 files，0 diagnostics |
| `npm run typecheck` | PASS；`tsc --noEmit` |
| `npm test` | PASS；9 tests，9 passed，0 failed/skipped/todo |
| `npm run verify:skeleton` | PASS；所有 required path、单一 lockfile、package metadata 和 Node runtime checks 通过 |
| `git diff --check` | PASS；提交前复核 |

提交后 `git status --short` 必须为空；实际 commit hash、parent 和 clean status 在本切片最终回报中给出，不通过 amend/rebase 回写占位。

G0.2 交付物：

- 发布 schema bundle `1.0.0`（JSON Schema Draft 2020-12）：10 个 `.schema.json` 文件和 1 个 bundle manifest；其中 8 个核心正式 artifact contract 覆盖 Artifact Envelope、Run Manifest、Research Plan、Gap Snapshot、Adaptation Decision、Event、Decision 和 Checkpoint，另含 validation-only Document Bundle 与共享定义。
- 所有对象边界 closed；required fields、RFC closed enum、Run-relative path/ref/version/hash、plan/snapshot revision lineage 与 Adaptation Decision action-discriminated `oneOf` 均由 schema 拒绝非法 shape。
- 精确加入 Ajv `8.20.0` 和 `ajv-formats` `3.0.1`；Ajv `8.17.1` 因已知 `$data` ReDoS advisory 未保留，最终 lockfile audit 为 0 vulnerabilities。没有第二实现栈、包管理器或 lockfile。
- 实现可复用 `ArtifactValidator`、完整 bundle `$ref`/JSON Pointer 编译检查、排序稳定的结构化 validation issues，以及仅对显式提供 Document Bundle 执行的 typed target、fragment、Run boundary、path/revision 和 parent-lineage 检查。
- `validate-artifact` 同时成为 Harness CLI 与 Skill script 的真实入口；支持 `--file`、`--bundle`、`--schema-bundle`。其他 12 个未开放 Skill 命令继续结构化 fail-closed 并报告 owning slice。
- 新增 29 个 JSON fixtures：8 个核心正例、15 个 schema 负例、1 个有效 reference bundle、4 个 reference 负例和 1 个 raw CLI 负例。负例覆盖 required、额外字段、closed enum、action shape、path、version/revision、typed target/type 和 fragment。
- 新增 9 个 schema/reference/CLI 测试，并保留更新后的 9 个 G0.1 repository/Skill/agent/toolchain 回归；测试断言具体 keyword、instance path、missing/additional property 或 reference error code，不只断言非零退出。

G0.2 schema/validator 决策：

- Formal Artifact Envelope 包含 typed document、Run-relative `artifact_path`、producer、input refs 和 supplied `sha256` 字段；G0.2 只验证 shape，不计算 hash、不写临时文件、不发布 artifact。
- Document Bundle 是显式 validation input，不是 Run Store 或恢复格式。Reference evaluator 只检查 bundle 中 RFC 已知的 typed refs，不扫描 `runs/`，不把任意 ID ref 误判为必须存在的文件。
- Research Plan schema 固化已发布 shape、closed unit/action vocabulary 和 revision fields；DAG、mode allowlist、完整 AI coverage、调度与 policy semantics 仍由 G0.4 拥有。
- Gap Snapshot/Adaptation Decision schema 固化数据形状和 closed action branch；Gap analyzer、状态前置条件、CAS、幂等 apply、retry/supersede/late-artifact runtime 未实现。

G0.2 验证证据（Node.js `24.18.0` / npm `11.16.0`）：

| 命令 | 结果 |
| --- | --- |
| `npm ci` | PASS；18 packages installed from package-lock v3；0 vulnerabilities |
| `npm run lint` | PASS；Biome checked 67 files，0 diagnostics |
| `npm run typecheck` | PASS；`tsc --noEmit` |
| `npm test` | PASS；18 tests，18 passed，0 failed/skipped/todo |
| `npm run validate:schemas` | PASS；10 schemas compiled，9 document validators，0 unresolved refs |
| `npm run validate:fixtures` | PASS；9 tests，9 passed；全部 29 JSON fixtures 被专项 suite 覆盖 |
| `npm run verify:skeleton` | PASS；required paths、单一 lockfile、package metadata、Node runtime 和 G0.2 bundle/validator paths 通过 |
| `git diff --check` | PASS；提交前复核 |

提交后 `git status --short` 必须为空；实际 G0.2 commit hash、parent 和 clean status 在本切片最终回报中给出，不通过 amend/rebase 回写占位。

G0.3 交付物：

- 实现 Run Store 的 create/load/reopen：严格校验 run id 和 Run-relative path，拒绝绝对路径、`..`、反斜杠混淆、symlink escape、跨 Run document/ref；每个新 Run 具有 schema-valid manifest、Event/Decision/Evidence JSONL、目录边界和初始 immutable checkpoint。
- 实现 formal Artifact Store：对 `document` 的递归键排序 UTF-8 canonical JSON 计算 SHA-256；同 Run temp 写入、G0.2 schema/typed-reference 和额外 artifact/input ref 存在性检查、fsync、no-replace atomic publish；formal path 不覆盖，相同 operation key/content 幂等，不同内容或占用 path 冲突。
- 明确 `manifest.json` 是 schema-valid、原子替换的当前索引，不是 immutable formal publish path；checkpoint 保存 immutable manifest snapshot。Adaptation/unit status 集合在写入和 reopen 时强制互斥。
- 实现 schema-valid Event/Decision JSONL append 和 immutable operation receipt；每条记录由已发布 schema 强制 timestamp、actor、reason、artifact refs。恢复只截断不完整尾部；完整损坏记录或 ID/content 冲突 fail closed。
- 实现 checkpoint/reopen/recovery：验证 formal envelope schema、canonical hash、refs、manifest snapshot、current plan revision/lineage 和引用存在；完成有 receipt 的 temp publish、对账 publish 后未索引 artifact、补写缺失 checkpoint event、处理 manifest/checkpoint divergence，并回退到最后有效 checkpoint。
- 实现 Evidence Store substrate：HTTP(S) canonical URL、canonical source hash、raw content hash、full-hash stable evidence id、`(canonical_url, content_hash, research_goal)` operation key、immutable raw path、dedup 和 receipt recovery。没有发布或私自选择 G1.2 完整 Evidence business schema、provenance judgment、Claim/Finding/Insight 语义。
- `create-run`、`load-run`、`record-evidence`、`checkpoint-run` 的 Harness/Skill 入口真实运行；G0.4 及下游 8 个命令继续结构化 fail-closed。
- 保留 3 个 committed Store 输入 fixtures，并扩展为 31 个 G0.3 测试：10 个 store/CLI、10 个 fault、11 个 recovery；测试使用真实临时 filesystem 并检查文件字节、manifest/log/checkpoint/reopen 结果。保留 G0.1/G0.2 18 个回归，总计 49 个测试。

G0.3 存储、hash 与恢复决策：

- G0.2 schema bundle `1.0.0` 保持原样；Store operation receipt 与 Evidence substrate record 使用独立、内部机械版本，不冒充 formal research artifact schema，因此没有无版本 schema 改写或迁移。
- Formal envelope `content_hash` 只覆盖 canonical `document`，不包含 envelope metadata 或 hash 字段本身；array 顺序保留，object key 按 code unit 递归排序，非 JSON value 拒绝。
- Immutable publish 使用同 Run、同 filesystem 的 synced temp 和 exclusive hard-link publication，避免 POSIX rename 覆盖既有 formal path；manifest current index 使用 synced temp + atomic replace，并由 checkpoint snapshot 提供恢复锚点。
- Operation receipt 在 publish/append 前固定 canonical operation key 与内容；reopen 在 receipt-driven 写入前校验 exact shape、filename hash、operation key、Run/log/path/id、metadata 和完整 payload/envelope 一致性。无 receipt 的残留 temp 删除；duplicate identity、receipt drift、中间 JSONL corruption、non-checkpoint formal artifact hash 冲突和引用/lineage 不闭合 fail closed。
- 非 initial checkpoint 的 `created_at` 必须严格晚于 current manifest 和最后一个 valid published checkpoint 的 durable timestamp；initial checkpoint 可等于 Run creation time。Reopen 只从该严格序列的最后有效 snapshot 继续；最新 checkpoint hash/schema/ref 无效时不覆盖旧 checkpoint。
- Reopen 报告 orphan active units，但 retry、supersede、late artifact 和 current-plan CAS/Plan Revision 完成或回滚语义仍由 G0.4 决定。

G0.3 验证证据（Node.js `24.18.0` / npm `11.16.0`）：

| 命令 | 结果 |
| --- | --- |
| `npm ci` | PASS；18 packages installed from package-lock v3；0 vulnerabilities |
| `npm run lint` | PASS；Biome checked 83 files，0 diagnostics |
| `npm run typecheck` | PASS；`tsc --noEmit` |
| `npm test` | PASS；49 tests，49 passed，0 failed/skipped/todo |
| `npm run validate:schemas` | PASS；bundle `1.0.0`，10 schemas，9 document validators，0 unresolved refs |
| `npm run validate:fixtures` | PASS；9 tests，9 passed |
| `npm run validate:store` | PASS；10 tests，10 passed |
| `npm run test:faults` | PASS；10 tests，10 passed |
| `npm run test:recovery` | PASS；11 tests，11 passed |
| `npm run verify:skeleton` | PASS；G0.3 required paths、单一 lockfile、package metadata 和 Node runtime checks 通过 |
| `npm audit` | PASS；0 vulnerabilities |
| `git diff --check` | PASS；提交前复核 |

G0.3 定向返修验收证据：

- 中控复现 1：candidate 接受早于 Run/current durable time 的 checkpoint，成功后 reopen 回滚。Repair 在发布前对 current manifest 与所有 valid published checkpoint 做只读 durable-order 检查，stale/equal 结构化拒绝；覆盖成功后立即 reopen、stale/equal、publish 后 direct equal retry、`after_checkpoint_publish` 和 `after_manifest_update`。
- 中控复现 2：candidate 未校验 Evidence manifest 的机械 identity，损坏 operation key 后 reopen 保留坏记录并补写正确记录。Repair 对 manifest/receipt 的 canonical URL、source/content hash、raw ref、Run/unit/goal/timestamp、stable evidence id、canonical tuple operation key、filename 和唯一性完整 fail closed；损坏记录测试确认未追加 replacement。
- 中控复现 3：candidate 接受完整重复 Event/Decision id。Repair 对两类 JSONL 强制 ID 唯一与 receipt filename/key/run/log/record/payload 一致；相同完整重复记录报 `log.duplicate_id`，不同内容同 ID 报 conflict，既有尾部截断和中间损坏语义保持。
- Receipt 最小负例覆盖 Artifact metadata drift、Evidence filename hash drift 和 JSONL record-id drift；所有 identity 校验在同类 receipt-driven publish/append 前完成。
- `bcf84cdbda1d5e16c8ec039548ee2ef487d054ff` 保留为 rejected candidate；定向 repair 已由 `004ecc088027166a53ec44a647bb2a5564eeeba0` 接受，parent 为 `bcf84cdbda1d5e16c8ec039548ee2ef487d054ff`，历史未 amend/rebase。

`004ecc088027166a53ec44a647bb2a5564eeeba0` 验收时工作树 clean；G0.4 以该提交为唯一施工基线。

## G0.4 `BLOCKED_BY_SPEC` 历史记录

以下四个最小复现是 `main@da820811` 的阻塞事实，保留用于说明本次 contract 修正必须解决的输入；它们不再表示下述修正候选的当前状态。

G0.4 启动期按强制施工协议完整阅读 RFC、账本并建立 schema/policy/Store/CLI/test 引用索引后，发现以下语义无法由 RFC 与已发布 G0.2 contract 唯一决定。施工不得通过内部常量、fixture 或未发布 policy 私自选择答案。

### 最小复现 1：AI mandatory coverage 触发信号缺失

1. 使用已发布 `startup_opportunity.research_plan.v1` 创建两个 byte-identical、schema-valid 的 Research Plan。
2. 第一个 Run 的未发布 Scope/Solution 语义为 `uses_ai=false`；第二个为 `uses_ai=true` 或 `assessment_profile=ai`。
3. RFC 第 12.3、12.4 节要求第二个 plan aggregate 覆盖全部六个 AI dimensions，但 Research Plan schema 没有 `uses_ai`、`assessment_profile`、typed scope ref 或 validator context 字段。
4. 因此 deterministic validator 对相同正式输入无法分别返回 PASS/FAIL；通过 CLI flag、路径命名或自由文本推断都会创建 RFC 未发布的隐藏 contract。

规范修正必须唯一规定 AI coverage trigger 的正式、版本化输入，以及该输入与 Research Plan/Run 的引用和 stale 校验方式；不得顺手发布 G3 AI business schema。

### 最小复现 2：mode closed allowlist 未发布

1. 已发布 `unitType` enum 给出全局 unit vocabulary，RFC 第 12.4 节另要求 discover/assess 只能使用各自允许的 unit 组合。
2. RFC、G0.2 schema 和仓库 policy 没有列出 `mode + phase + unit_type + agent_role + required_artifact_schema` 的 closed mapping。
3. 例如 `user_language_mining`、`market_space`、`bounded_domain_research` 与 `startup_opportunity.enrichment_branch_result.v1` 在两个 mode 中的允许关系无法唯一判定。

规范修正必须发布明确的 mode/phase allowlist，并说明 G1/G2 尚未发布的 output schema 名称在 G0.4 是允许计划、还是必须 fail closed。

### 最小复现 3：`continue_existing_plan` 无法机械验证 coverage

1. RFC 第 12.7、12.8 节要求 `continue_existing_plan` 引用确实覆盖同一 subject 和研究目标的 pending/active unit。
2. Gap 有结构化 `subject_ref`，但 Research Unit 只有自由文本 `research_goal` 和通用 `input_refs`，没有 subject/coverage relation；Adaptation Decision 也没有声明被覆盖目标的结构化字段。
3. 两个 schema-valid unit 可以使用相同 input refs、不同自然语言目标，或不同 input refs、等价自然语言目标。确定性脚本无法在不隐藏 LLM/字符串启发式的情况下判断“同一研究目标”。

规范修正必须加入可机械比较的版本化 coverage relation，或把这一前置条件明确拆成 Agent attestation 与 Harness 可验证字段；不得让脚本做开放式语义判断。

### 最小复现 4：`retry_unit` 的 partial 状态无确定映射

1. RFC 第 12.7 节允许 retry failed 或 partial artifact。
2. Run Manifest unit 状态只有 `completed/active/failed/invalidated/skipped/cancelled/superseded`，没有 `partial`；第 24.4 节的 branch `partial` 是下游 artifact 语义，G0.4 又禁止实现 G1/G2 branch schema。
3. 因此 G0.4 policy 无法唯一决定 partial unit 应位于 `completed_units`、`failed_units` 还是其他集合，也无法在不读取未发布业务 artifact 的情况下验证 retry 前置条件。

规范修正必须定义 partial 到 G0 Manifest 状态的机械映射或明确将 partial retry 延后到拥有 branch schema 的切片，同时保持 G0.4 fail-closed。

### 原阻塞边界

以下边界记录阻塞发现时的仓库状态，不覆盖后文的 contract 修正交付：

- 未创建 `harness/policies/adaptation.v1.json`，未实现或接通 G0.4 CLI/Skill scripts，未修改 G0.2 schemas 或 G0.3 Store。
- 未开始 prompt/Skill 业务说明中文化；该改动仍须与恢复后的完整 G0.4 实现、tests 和账本形成同一原子提交，避免产生不符合用户要求的部分候选。
- G0.R 保持 `NOT_READY`，G0 Foundation Harness 保持 `IN_PROGRESS`，G1-G4 保持 `NOT_READY`。
- 下一任务只能是独立 contract 修正规范会话；修正被接受后才能从新的 clean baseline 恢复 G0.4，不能直接进入 whole-gate regression。

### 阻塞点发现后的基线验证

使用 Node.js `24.18.0` / npm `11.16.0` 重放当前 accepted G0.1-G0.3 基线；这些结果只证明既有 Foundation substrate 未被 blocker 账本记录破坏，不是 G0.4 专项或退出证据。

| 命令 | 结果 |
| --- | --- |
| `npm ci` | PASS；18 packages installed from `package-lock.json` v3；0 vulnerabilities |
| `npm run lint` | PASS；Biome checked 83 files，0 diagnostics |
| `npm run typecheck` | PASS；`tsc --noEmit` |
| `npm test` | PASS；49 tests，49 passed，0 failed/skipped/todo |
| `npm run validate:schemas` | PASS；bundle `1.0.0`，10 schemas，9 document validators，0 unresolved refs |
| `npm run validate:fixtures` | PASS；9 tests，9 passed |
| `npm run validate:store` | PASS；10 tests，10 passed |
| `npm run test:faults` | PASS；10 tests，10 passed |
| `npm run test:recovery` | PASS；11 tests，11 passed |
| `npm run verify:skeleton` | PASS；required paths、单一 lockfile、package metadata 和 Node runtime checks 通过 |
| `npm audit` | PASS；0 vulnerabilities |
| G0.4 专项 | NOT RUN；实现被 contract 缺口阻塞，当前专项数量为 0，不得冒充 PASS |

## G0.4 初始 contract 修正候选

本次提交只修正规范与 versioned contracts，不实现 G0.4 runtime。交付版本：

- 保留 `harness/schemas/v1` / schema bundle `1.0.0` immutable；初始候选曾默认发布兼容读取超集 schema bundle `2.0.0`：16 schemas、15 document validators。
- 新增 `startup_opportunity.planning_context.v1`，包含 immutable context revision、Run/Plan identity/ref/hash/revision、`initial_plan | current_plan | candidate_revision` stale rules，以及 closed AI mandatory trigger。它只表达 G0 planning context，不包含 G3 business artifact。
- 新增 `startup_opportunity.coverage_attestation.v1` 和 canonical `coverage_key`/唯一 relation；新增 `startup_opportunity.adaptation_decision.v2`，要求 `continue_existing_plan.coverage_attestation_ref` 与 `retry_unit.retry_basis`。
- 发布 `startup_opportunity.adaptation_policy.v1` / policy `1.0.0`：5 个 mode/phase、49 个 exact unit tuples、23 个 unit types、4 个 `future_declared` output schema ids。Plan 可以声明 policy 已知但尚未安装的 output schema；Artifact validation/publish 仍要求 installed schema 和 compatible envelope。
- 新增 `artifact_envelope.v2` 与 `document_bundle.v2`；v1 documents 和 Adaptation Decision v1 继续 schema-compatible read。Adaptation Decision v1 不能进入 policy `1.0.0` execution，必须由 main Agent 发布带 provenance 的 v2 proposal。
- `PlanningContractEvaluator` 只读验证显式 bundle；不扫描 Run、不写状态、不调度 unit、不接通任何 reserved G0.4 CLI。

初始候选对四项阻塞的处理：

| 原阻塞 | Contract 结果 |
| --- | --- |
| AI trigger 缺失 | 候选要求 Planning Context 必填 `required | not_required` trigger，但 `source_ref/source_schema_version/source_content_hash` 只有 shape；后续独立复现证明 fake/missing source 仍会通过，因此本行未真正闭合 |
| mode allowlist 缺失 | `adaptation.v1.json` 是 exact mode/phase/type/role/schema tuple 的唯一数据源；`future_declared` 只影响 plan declaration |
| coverage 无法判断 | Main Agent 发布 semantic attestation；Harness 只验证 canonical key、exact relation/ref/subject/goal、pending/active state、plan lineage/stale |
| partial retry 无映射 | G0.4 retry 只认 `manifest.failed_units`；completed/active/pending/partial 均 fail closed，partial adapter 延后到 owning G1/G2 schema/policy |

Contract fixture 交付：1 个完整正例 bundle、1 个 future-declared Artifact publish 负例和 21 个 mutation 负例，覆盖 missing/wrong trigger、stale Run/Plan identity/ref/hash/revision、非法 tuple、current plan 与 Adaptation target 未声明 output schema、coverage key/ref/subject/state、retry completed/active/partial 和 v1 read-compatible/policy-rejected。

初始候选提交：`30b31754684ee83cc132ee4d3362307b98e27e23`；parent=`da820811d0fa7495fd28dc127e1d1ff91adbdc97`。中控因下述 AI trigger source-binding 漏检拒绝该候选；提交与测试记录保留，不 amend/rebase/reset。

### Contract 修正验证证据

以下结果必须使用 Node.js `24.18.0` / npm `11.16.0` 在最终提交前真实重放；数量以本节最终记录为准，不沿用历史 G0.3 数字。

| 命令 | 结果 |
| --- | --- |
| `npm ci` | PASS；18 packages installed，19 packages audited，0 vulnerabilities |
| `npm run lint` | PASS；Biome checked 97 files，0 diagnostics |
| `npm run typecheck` | PASS；`tsc --noEmit` |
| `npm test` | PASS；57 tests，57 passed，0 failed/skipped/todo |
| `npm run validate:schemas` | PASS；bundle `2.0.0`，16 schemas，15 document validators，0 unresolved refs |
| `npm run validate:fixtures` | PASS；17 tests，17 passed；8 个 contract tests 覆盖 1 个完整正例、21 个 mutation 负例和 future Artifact publish boundary |
| `npm run validate:store` | PASS；10 tests，10 passed |
| `npm run test:faults` | PASS；10 tests，10 passed |
| `npm run test:recovery` | PASS；11 tests，11 passed |
| `npm run verify:skeleton` | PASS；required paths、单一 lockfile、package metadata 和 Node `24.18.0` runtime checks 通过 |
| `npm audit` | PASS；0 vulnerabilities |
| `git diff --check` | PASS；提交前复核 |

## G0.4 AI trigger source-binding follow-up

中控对 `30b31754684ee83cc132ee4d3362307b98e27e23` 的独立最小复现：在正例 Planning Context 中把 `source_ref` 改为 `missing/source.json`、`source_schema_version` 改为 `startup_opportunity.fake_source.v1`、`source_content_hash` 改为 64 个 `b`，旧 `PlanningContractEvaluator` 仍返回 `valid=true`、`documentBundle.valid=true`、空 contract/reference errors。根因是 Planning Context v1 只校验三个字段的 shape，没有 source identity、存在性、schema、canonical hash 或 stale binding。

Follow-up contract 交付：

- 保留 bundle `1.0.0`、bundle `2.0.0`、Planning Context v1、adaptation policy `1.0.0` 及全部 v1 schemas immutable；默认新增兼容读取超集 bundle `2.1.0`：19 schemas、18 document validators。
- 发布 `startup_opportunity.planning_context.v2` 与 `startup_opportunity.ai_trigger_source_attestation.v1`。Planning Context v1 只读兼容，不能进入新 planning policy validation；v2 的 required trigger 只允许 installed attestation schema。
- 发布 `startup_opportunity.ai_trigger_source_binding_policy.v1` / `1.0.0`，用 exact ref/schema/version/canonical hash 绑定 `adaptation.v1.json`，固定 `explicit_document_bundle_path` resolution、`canonical_json_sha256.v1` 和 8 个 exact Run/mode/context revision/subject/trigger bindings，并将 future-declared trigger source 固定为 `forbidden`。
- Reference evaluator 只从调用方显式 Document Bundle 解析 whole-document `source_ref`；不使用 fragment、CLI flag、路径启发式、Run 扫描、自由文本或隐藏 LLM。Planning evaluator 继续校验 source canonical hash 与 exact bindings，任一 source 内容或 binding 变化都使旧 Planning Context stale。
- 正例 bundle 新增一个 source attestation；mutation 负例从 21 增至 29，新增 missing source、wrong ref/schema/hash、subject mismatch、source content stale、context revision stale 和 trigger mismatch。中控的原三字段最小复现另有独立 test，现稳定返回 invalid。
- 同步确认 G0.3 Store 的 `FormalArtifactEnvelope`、operation receipt recovery 和 publish reference bundle 仍为 v1-only。`artifact_envelope.v2` schema-valid 只表示可做显式 contract validation；真实 `RunStore.publishArtifact` regression 证明它在当前 `document_bundle.v1` reference-validation boundary 以 `artifact.reference_invalid` fail closed。本 follow-up 不实现 v2 Store runtime。

Follow-up 提交占位：`<G0.4_AI_TRIGGER_SOURCE_FIX_COMMIT>`；parent 必须为 `30b31754684ee83cc132ee4d3362307b98e27e23`。只有中控从 clean tree 接受后才能恢复 G0.4 implementation；不得标记 G0.4 `DONE`、创建 G0.R 或开放 G1。

### Follow-up 验证证据

以下结果使用 Node.js `24.18.0` / npm `11.16.0` 在 follow-up 最终提交前真实重放：

| 命令 | 结果 |
| --- | --- |
| `npm ci` | PASS；18 packages installed，19 packages audited，0 vulnerabilities |
| `npm run lint` | PASS；Biome checked 102 files，0 diagnostics |
| `npm run typecheck` | PASS；`tsc --noEmit` |
| `npm test` | PASS；59 tests，59 passed，0 failed/skipped/todo |
| `npm run validate:schemas` | PASS；bundle `2.1.0`，19 schemas，18 document validators，0 unresolved refs |
| `npm run validate:fixtures` | PASS；18 tests，18 passed；9 个 contract tests 覆盖 1 个完整正例、29 个 mutation 负例、原最小复现和 future Artifact boundary |
| `npm run validate:store` | PASS；11 tests，11 passed；包含 v2 Store publish fail-closed regression |
| `npm run test:faults` | PASS；10 tests，10 passed |
| `npm run test:recovery` | PASS；11 tests，11 passed |
| `npm run verify:skeleton` | PASS；required paths、单一 lockfile、package metadata 和 Node `24.18.0` runtime checks 通过 |
| `npm audit` | PASS；0 vulnerabilities |
| `git diff --check` | PASS；提交前复核 |

## 当前阻塞与风险

- G0.3 Store 成功只证明机械持久化、hash/ref/index/checkpoint/recovery 合同；不证明 Evidence 充分、业务 policy 通过、decision ready 或 G0 Foundation 完成。
- 初始候选的 AI trigger source-binding 漏检由 follow-up contract 修复，当前等待中控独立验收；G0.4 runtime 仍未开始。Research Plan DAG validator、Gap analyzer、Adaptation runtime validator、CAS/idempotent Plan Revision apply、retry/supersede/late-artifact runtime 均保持未实现，对应 Skill 入口继续结构化失败，不能被调用方转成成功或 mock artifact。
- G0.3 Evidence substrate 不包含完整 Evidence Record、origin/provenance/freshness/independence/bias 或 Claim/Finding/Insight；这些仍由 G1.2 拥有，不得从 raw record 推导研究结论。
- `discover`、`assess`、comparison 和 reporting 只有职责/reference 落点，没有业务闭环；G1-G4 保持 `NOT_READY`。
- 目标 runtime 是精确 Node.js `24.18.0`；PATH 上其他 Node 版本会被 engine guard 或 repository doctor 拒绝，开发者需先切换版本。
- Codex task status 工具可能暂时不可用；中控按三次失败后的多证据降级规则处理，不能仅凭超时判断任务失败。

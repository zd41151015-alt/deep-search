# Startup Opportunity Research Harness 实施进度

> **状态**: READY / G0_FOUNDATION_DONE
> **当前 Gate**: G0 Foundation Harness=`DONE`；G1 Concept Evidence Assessment=`READY`（仅 G1.1）；G2-G4=`NOT_READY`
> **下一独立会话**: 只可从 clean G0.R commit 执行 G1.1 Assess Domain Contract；本 G0.R 会话不启动或创建后续任务
> **最后更新**: 2026-07-24
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
| G0 Foundation Harness | `DONE` | RFC v1 | 工具链与仓库骨架、核心 schema、Run/Artifact Store、validator、checkpoint、Gap/Adaptation/Plan Revision、完整 foundation regression |
| G1 Concept Evidence Assessment | `READY` | G0 | 单 thesis 从 intake 到 report 的端到端闭环，buyer gap 触发 plan r2，独立 G1 回归；当前只开放 G1.1 |
| G2 Opportunity Discovery | `NOT_READY` | G1 | discovery lanes、Demand/Solution synthesis、pre-kill/enrichment、比较/portfolio 和独立 G2 回归 |
| G3 AI Bundle | `NOT_READY` | G2 | 六维 AI mandatory bundle、baseline/reliability/data/economics/risk gates 和独立 G3 回归 |
| G4 Distribution / Operational Exit | `NOT_READY` | G3 | repo-local Skill/agents/hooks/MCP 完整入口、安装与恢复文档、端到端 fixture；Plugin 是否打包按 RFC 条件判断 |

## 工作包总览

| 工作包 | 范围 | 状态 |
| --- | --- | --- |
| W0 | Repository、toolchain、Skill/agent/Harness skeleton、测试入口 | `DONE` |
| W1 | Schema bundle、reference validator、artifact envelopes | `DONE` |
| W2 | Run Store、Artifact/Evidence Store、events/decisions/checkpoint/recovery | `DONE` |
| W3 | Research Plan、Gap Snapshot、Adaptation Decision、Plan Revision | `DONE` |
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
| G0.4 implementation | Plan / Adaptation Runtime | `DONE` | plan validator、machine gap draft、adaptation validator、immutable plan revision、stale-base/CAS、retry/supersede/late artifact、crash-boundary fixtures |
| G0.R | Independent Foundation Whole-Gate Regression | `DONE` | 从 clean G0 candidate 独立重放全部 G0 tests、negative/fault/crash fixtures、determinism、git diff/check；通过后 G0=`DONE` |

## G1 Concept Evidence Assessment 施工切片

| 切片 | 内容 | 状态 | 主要退出条件 |
| --- | --- | --- | --- |
| G1.1 | Assess Domain Contract | `READY` | intake、DecisionContext、ScopeFrame、ConceptHypothesis、assessment plan/branch/fan-in、JudgmentAssessment、Evidence Matrix、BusinessEngine、Assessment closed schemas 和 fixtures |
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
| Active task | G0.R Independent Foundation Whole-Gate Regression 已通过；等待本原子 commit 与中控接受，不创建后续任务 |
| Current slice | `G0 Foundation=DONE`；`G0.R=DONE`；仅 `G1.1=READY`，尚未启动 |
| Expected base | `e4d5a0d649c8dc39cbf3ea5df7eaf603ffa880ce`；G0.R commit parent 必须为同一提交 |
| Consecutive state-query failures | `0` |
| Last effective operation | `g0_r_foundation_regression_passed` |
| Next allowed action | 中控接受 clean G0.R commit 后，可由新的独立任务执行 G1.1；本任务不得启动 G1.1 |

## 已完成切片与证据

| 切片 | 状态 | Commit | Parent |
| --- | --- | --- | --- |
| G0.1 Repository / Toolchain / Skill Skeleton | `DONE` | `4fb428d54ea1656fe8a15ffdc1d4e963d4a4609e` | `4033ae504219bfc6d616d76a1b2c44143e83cb42` |
| G0.2 Core Artifact Schema Bundle | `DONE` | `da820615af2c2b821cdb46a9130286e3e9575f59` | `4fb428d54ea1656fe8a15ffdc1d4e963d4a4609e` |
| G0.3 rejected implementation candidate | `REJECTED_BY_CONTROLLER` | `bcf84cdbda1d5e16c8ec039548ee2ef487d054ff` | `da820615af2c2b821cdb46a9130286e3e9575f59` |
| G0.3 accepted repair | `DONE` | `004ecc088027166a53ec44a647bb2a5564eeeba0` | `bcf84cdbda1d5e16c8ec039548ee2ef487d054ff` |
| G0.4 initial planning contract candidate | `REJECTED_BY_CONTROLLER` | `30b31754684ee83cc132ee4d3362307b98e27e23` | `da820811d0fa7495fd28dc127e1d1ff91adbdc97` |
| G0.4 accepted AI source-binding repair | `DONE` | `7f8c0c935c894dd56eb50937741ceb9e9971d8c0` | `30b31754684ee83cc132ee4d3362307b98e27e23` |
| G0.4 Plan / Adaptation Runtime rejected candidate | `REJECTED_BY_CONTROLLER` | `eee8dea4115f1448c092306921894ec2e573f822` | `7f8c0c935c894dd56eb50937741ceb9e9971d8c0` |
| G0.4 Plan / Adaptation Runtime directed repair | `REJECTED_BY_CONTROLLER` | `274337f8efd34fbadbf3d0babab13bf551100393` | `eee8dea4115f1448c092306921894ec2e573f822` |
| G0.4 Plan / Adaptation Runtime second directed repair | `REJECTED_BY_CONTROLLER` | `be78ea969fcbccbfda38f242f5ddb03016db7a16` | `274337f8efd34fbadbf3d0babab13bf551100393` |
| G0.4 accepted Plan / Adaptation Runtime implementation candidate | `DONE` | `e4d5a0d649c8dc39cbf3ea5df7eaf603ffa880ce` | `be78ea969fcbccbfda38f242f5ddb03016db7a16` |
| G0.R Independent Foundation Whole-Gate Regression | `DONE` | `<G0_R_FOUNDATION_REGRESSION_COMMIT>` | `e4d5a0d649c8dc39cbf3ea5df7eaf603ffa880ce` |

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

Follow-up 提交：`7f8c0c935c894dd56eb50937741ceb9e9971d8c0`；parent=`30b31754684ee83cc132ee4d3362307b98e27e23`。该 contract 修正已由中控接受为 G0.4 implementation 的 clean baseline；本段保留其历史退出条件。

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

## G0.4 Plan / Adaptation Runtime 实现候选

初始实现候选以 clean `main@7f8c0c935c894dd56eb50937741ceb9e9971d8c0` 为唯一基线，提交为 `eee8dea4115f1448c092306921894ec2e573f822`，parent=`7f8c0c935c894dd56eb50937741ceb9e9971d8c0`。中控因 apply 信任 caller-only policy document content、Gap cycle identity 缺少 base Plan/event ref、event/fragment 解析不精确而拒绝该候选；提交和历史验证证据保留，不 amend/rebase/reset。

### 生产交付

- 新增 deterministic Research Plan semantic validator：检查 wave/unit DAG、依赖存在和 ancestor-wave 合法性、unit/output 唯一性、attempt/supersede lineage、manifest disposition、candidate parent retention、completed unit immutability，以及 exact mode/phase/unit_type/agent_role/required_artifact_schema tuple、Planning Context v2/source binding 和 AI mandatory coverage。
- 新增 machine Gap Snapshot draft：只消费显式且已验证的 Document Bundle，机械生成 failed-unit、no-new-evidence、source-repetition、max-followup 和显式 closed machine-check gap；不使用字符串启发式、Run 扫描或隐藏 LLM。
- 新增 Adaptation Decision v2 policy validator：覆盖 10 个 closed action 的状态、ref、coverage、retry、supersede、batch conflict、follow-up ceiling 和 stale 前置条件。`retry_unit` 只接受 `failed_units`；partial retry 继续 fail closed。
- 新增 immutable Plan Revision runtime：operation identity 为 canonical parent Plan hash 加 sorted Adaptation Decision refs；先发布 immutable receipt，再发布 control Artifact，执行 manifest CAS，最后发布 checkpoint/Event。相同 replay 返回同一结果；operation content conflict、stale input/base 和 candidate transform drift 均拒绝。
- 新增 retry/supersede/late Artifact/crash/reopen 语义：retry/supersede 保留 parent Plan 并发布新路径；late Artifact 保存但只进入 `ignored_late_artifact_refs`，reopen 不允许其重新进入 current `artifact_refs`；`after_intent`、`after_control_artifacts`、`after_manifest_update`、`after_checkpoint_publish` 均有恢复测试。
- `validate-plan`、`analyze-gaps`、`validate-adaptation`、`apply-plan-revision` 已同时成为 Harness CLI 和 repo-local Skill script 的真实入口，返回结构化成功/失败。G1+ reserved command 继续 fail closed。

### Schema / Store 迁移边界

- 保留已接受的 bundle `1.0.0`、`2.0.0`、`2.1.0` 与全部旧 schema/policy 不变；默认新增 bundle `2.2.0`，共 22 schemas、21 document validators，只加入 G0.4 所需 v3 control envelope、v3 Document Bundle 和 Plan Revision apply policy schema。
- v1 envelope 继续使用 v1 Store receipt；v2/v3 envelope 精确使用 v2 receipt，并将 Run manifest bundle version 升至 `2.2.0`。checkpoint 在 `2.2.0` Run 上使用 v3 envelope；reopen 同时接受 v1/v2/v3 envelope。
- 显式 v2 planning bundle 继续执行 Planning Context v2 live stale binding；v3 Store bundle 只验证历史 context self-binding/lineage，避免用最新 manifest 重解释不可变历史 Artifact。
- Planning Context v1 与 Adaptation Decision v1 只读，不能进入新 policy execution。`future_declared` output schema 可以进入 Plan，但正式 Artifact 发布仍要求 schema 已安装、envelope 兼容、reference/hash 有效且与 Plan `required_artifact_schema` 精确一致。
- 迁移没有泛化 Store、引入第二引擎或改写 G0.3 durability contract；late Artifact 的 manifest 时间使用单调最大值，不能倒退 durable Run time。

### Fixture 与验证证据

- `tests/fixtures/g0.4/plan-adaptation-cases.json` 固定 10 个 valid action、4 个 negative Plan case、5 个 negative apply case 和 4 个 crash boundary；`tests/g0.4-runtime.test.ts` 使用真实临时 filesystem 运行 12 个测试。
- G0.4 专项覆盖 DAG/output/allowlist/current binding、deterministic Gap、全部 closed action、failed-only retry、CAS、idempotency、stale input、operation-content conflict、candidate-transform mismatch、retry、supersede、late Artifact、future-declared publish rejection、四个 crash boundary、receipt drift/reopen，以及四个 Harness/Skill 入口的结构化成功/失败。
- 原 fake/missing AI source 最小复现仍由 contract fixture suite 独立执行并 fail closed；accepted 29 mutation negatives 保持通过。

| 命令 | 结果 |
| --- | --- |
| `npm ci` | PASS；Node.js `24.18.0` / npm `11.16.0`；18 packages installed，19 packages audited，0 vulnerabilities |
| `npm run lint` | PASS；Biome checked 117 files，0 diagnostics |
| `npm run typecheck` | PASS；`tsc --noEmit` |
| `npm test` | PASS；71 tests，71 passed，0 failed/skipped/todo |
| `npm run validate:schemas` | PASS；bundle `2.2.0`，22 schemas，21 document validators，0 unresolved refs |
| `npm run validate:fixtures` | PASS；18 tests，18 passed；包含 accepted 29 mutation negatives、fake/missing source 和 future Artifact boundary |
| `npm run validate:store` | PASS；11 tests，11 passed |
| `npm run test:faults` | PASS；10 tests，10 passed |
| `npm run test:recovery` | PASS；11 tests，11 passed |
| `npm run test:g0.4` | PASS；12 tests，12 passed |
| `npm run verify:skeleton` | PASS；G0.4 required paths、单一 lockfile、package metadata 和 Node `24.18.0` runtime checks 通过 |
| `npm audit` | PASS；0 vulnerabilities |
| `git diff --check` | PASS；提交前复核 |

### 中文化与禁止边界

- `.codex/agents/*.toml` 的 `description`/`developer_instructions`、`.agents/skills/startup-opportunity/SKILL.md` 和 7 份 `references/*.md` 的业务说明已翻译为自然中文；保留 Startup Opportunity、Harness、Run、Artifact、Evidence、Claim、Finding、Insight、Gap Snapshot、Adaptation Decision、Plan Revision、Hard Gate、Planning Context、coverage_key、JSON Schema、CLI、代码标识、closed literal、命令、路径和文件名，未改变 role、ownership、权限或路由。
- 未进入 G0.R implementation 或 G1+；未实现 `assess`/`discover`、comparison/reporting、G1 Evidence/Claim/Finding/Insight、G4 distribution/hook/MCP/Plugin、通用 Workflow Runtime、任意 DAG DSL、daemon、UI、DB 或隐藏 LLM。
- 未执行或跟踪访谈、landing page、定金、广告、付费实验、MVP 测试或其他外部验证。

## G0.4 Plan / Adaptation Runtime 定向返修候选

返修以 clean `main@eee8dea4115f1448c092306921894ec2e573f822` 为唯一基线，提交为 `274337f8efd34fbadbf3d0babab13bf551100393`，parent=`eee8dea4115f1448c092306921894ec2e573f822`。中控以跨 Run Gap ref 可进入 Snapshot、`requested_by=user` 的合法 `decisions.jsonl#decision_id` 无法进入 apply 为由拒绝该候选；提交与历史验证证据保留，不 amend/rebase/reset。

### 定向修复

- `PlanRevisionRuntime.applyLocked` 在任何 Plan operation receipt、control Artifact publish 或 manifest CAS 之前，对显式 `adaptationBundle` 中除 live `manifest.json` 外的每个 policy input 逐项解析当前 Run 的 immutable formal envelope，验证 envelope/schema/ref/hash/Run boundary，并要求 supplied envelope（如有）和 effective document 与磁盘 canonical content exact 一致。该过程只访问 bundle 明示路径，不扫描无关 Run 内容；首次 apply、pending receipt replay 和已应用 idempotent replay 都 fail closed。
- `GapAnalyzer.snapshot_cycle_key` 改为 canonical `base Plan ref + base Plan content hash + trigger kind + exact wave id 或 event ref/id + sorted observed Artifact refs/content hashes` identity。相同输入重放稳定；不同 event ref 或 base Plan identity 进入不同 cycle，revision 均从 1 开始。
- event-driven Gap analysis 要求 `trigger_event_ref` exact resolve 到当前 Run 的 `startup_opportunity.event.v1`；JSONL fragment 必须等于目标 `event_id`。Observed、repeated-source、machine subject/basis/evidence 等 path-like refs 必须命中显式 Document Bundle 的 exact target，带 fragment 时必须命中对应 closed document record。
- 未修改 bundle `1.0.0`、`2.0.0`、`2.1.0`、`2.2.0`、任何已发布 schema 或 policy；Store migration、receipt version、Planning Context/Adaptation Decision compatibility 和 `future_declared` publish fail-closed 边界保持不变。

### 定向回归与验证证据

- `tests/fixtures/g0.4/plan-adaptation-cases.json` 现固定 10 个 valid action、4 个 negative Plan case、7 个 negative apply case、3 个 Gap cycle identity case、3 个 negative Gap reference case 和 4 个 crash boundary。
- `tests/g0.4-runtime.test.ts` 使用真实临时 filesystem 运行 15 个测试。新增两个 apply 负例分别篡改同 path Gap Snapshot 和 Planning Context，旧实现会继续 apply；返修在 receipt/control/manifest 前返回 `adaptation.stored_content_mismatch`，并逐字节断言 manifest、plans、checkpoints 和 Plan receipt 列表均未变化。
- Gap 专项新增相同输入稳定、不同 event ref 独立 cycle/revision 1、base Plan hash 变化独立 cycle/revision 1，以及 trigger event wrong document type、missing event fragment、missing observed fragment 负例。

| 命令 | 结果 |
| --- | --- |
| `npm ci` | PASS；Node.js `24.18.0` / npm `11.16.0`；18 packages installed，19 packages audited，0 vulnerabilities |
| `npm run lint` | PASS；Biome checked 117 files，0 diagnostics |
| `npm run typecheck` | PASS；`tsc --noEmit` |
| `npm test` | PASS；74 tests，74 passed，0 failed/skipped/todo |
| `npm run validate:schemas` | PASS；bundle `2.2.0`，22 schemas，21 document validators，0 unresolved refs |
| `npm run validate:fixtures` | PASS；18 tests，18 passed；accepted 29 mutation negatives、fake/missing source 和 future Artifact boundary 保持通过 |
| `npm run validate:store` | PASS；11 tests，11 passed |
| `npm run test:faults` | PASS；10 tests，10 passed |
| `npm run test:recovery` | PASS；11 tests，11 passed |
| `npm run test:g0.4` | PASS；15 tests，15 passed |
| `npm run verify:skeleton` | PASS；G0.4 required paths、单一 lockfile、package metadata 和 Node `24.18.0` runtime checks 通过 |
| `npm audit` | PASS；0 vulnerabilities |
| `git diff --check` | PASS；follow-up 提交前复核 |

## G0.4 Plan / Adaptation Runtime 第二次定向返修候选

第二次返修以 clean `main@274337f8efd34fbadbf3d0babab13bf551100393` 为唯一基线，提交为 `be78ea969fcbccbfda38f242f5ddb03016db7a16`，parent=`274337f8efd34fbadbf3d0babab13bf551100393`。中控因同一 JSONL log 的多个 typed fragment 在 Artifact publish/reopen 中被折叠为单个 last record 而拒绝该候选；提交和历史验证证据保留，不 amend/rebase/reset。

### 中控失败复现

- schema-valid `startup_opportunity.event.v1` 以显式 path 进入 Document Bundle，但其 `run_id=run_foreign_001`；旧 `GapAnalyzer` 只验证 target/fragment，作为另一 Run 的 `observedArtifactRef` 仍返回 `valid=true` 并把跨 Run ref 写入新 Gap Snapshot。Observed、repeated source、machine subject/basis/evidence 都存在同类缺口。
- 旧 `assertAdaptationBundleMatchesStoredArtifacts` 把除 `manifest.json` 外的每个 bundle entry 都当 formal Artifact envelope。`requested_by=user` 按已发布 contract 必须通过 `user_decision_ref` 回连 `decisions.jsonl#decision_id`，而 G0.3 append log 不能作为 formal Artifact target，导致 schema/policy-valid user action 无法进入 apply。

### 第二次定向修复

- `GapAnalyzer` 对 observed Artifact、repeated source、machine subject/basis/evidence 和 trigger Event 的全部 path-like refs，在显式 Document Bundle 内验证 exact target、适用 fragment、document type 和 Run boundary；目标 document 带 `run_id` 时必须等于当前 `manifest.run_id`。`events.jsonl` trigger 必须使用 exact `#event_id`；schema 已发布的独立 `events/<id>.json` 继续以 whole-document ref 表达。
- `JsonlStore.readExactRecord` 只读取 ref 明示的 `events.jsonl` 或 `decisions.jsonl`，要求完整 JSONL tail、唯一 exact fragment、closed Event/Decision schema、当前 Run、canonical record、确定性 `append_jsonl` operation key、receipt 文件名和 receipt payload 全部一致。Append 与 repair 复用同一 closed log-type/receipt identity 校验。
- `ArtifactStore` 为 `trigger_event_ref` / `user_decision_ref` 增加窄化 JSONL adapter：formal envelope、schema、hash、Run 与普通 ref 仍按原路径验证；typed JSONL record 由 exact log/receipt reader 注入显式验证 bundle，`events.jsonl` / `decisions.jsonl` 仍禁止成为 formal Artifact target。
- `PlanRevisionRuntime` 在首次 apply 的 Plan receipt/control/manifest 之前，对 caller bundle 中 JSONL effective record 和 formal policy input 分别与磁盘 exact 对账；pending receipt replay、applied replay 和 reopen 从 immutable Adaptation Decision/Gap refs 重新验证 user Decision/Event log binding。Caller-only content、missing fragment、wrong log type/Run、receipt/log drift 均 fail closed。
- `RunStore` 在既有 reopen 顺序中先 repair 两个 JSONL log，再只为 formal documents 明示的 typed JSONL refs 加入 exact record；不依赖聊天、路径启发式、隐藏 LLM 或无关 Run 内容。
- 未修改 bundle `1.0.0`、`2.0.0`、`2.1.0`、`2.2.0`、任何已发布 schema/policy、envelope/receipt version 或 G0.3 durability contract；本次只增加 G0.4 必需的 JSONL typed-ref compatibility。

### 第二次定向回归与验证证据

- `tests/fixtures/g0.4/plan-adaptation-cases.json` 固定 10 个 valid action、4 个 negative Plan case、16 个 negative apply case、3 个 Gap cycle identity case、8 个 negative Gap reference case 和 4 个 crash boundary。
- `tests/g0.4-runtime.test.ts` 使用真实临时 filesystem 运行 18 个测试。Gap negative 覆盖 cross-Run observed/basis/evidence/repeated-source/trigger Event；相同输入、不同 event ref 和不同 base Plan 的 cycle identity 仍稳定。
- User-requested 正例把真实 `Decision` 与 trigger `Event` 通过 Run Store append/receipt contract 写盘，正式发布引用它们的 Adaptation Decision/Gap Snapshot，完成 apply、idempotent replay 和 reopen。负例覆盖 caller same-id content 篡改、missing fragment、wrong log type、wrong Run、receipt drift、log drift，并逐项断言 Plan receipt、control path、checkpoint 和 manifest 在拒绝前后不变。
- Recovery negative 覆盖 `after_intent` pending receipt replay、applied replay 和 reopen 的 JSONL receipt/log drift；原 formal Gap/Planning Context tamper、CAS/idempotency、retry/supersede/late Artifact、四个 crash boundary、fake/missing AI source 和 accepted 29 mutation negatives 保持通过。

| 命令 | 结果 |
| --- | --- |
| `npm ci` | PASS；Node.js `24.18.0` / npm `11.16.0`；18 packages installed，19 packages audited，0 vulnerabilities |
| `npm run lint` | PASS；Biome checked 117 files，0 diagnostics |
| `npm run typecheck` | PASS；`tsc --noEmit` |
| `npm test` | PASS；77 tests，77 passed，0 failed/skipped/todo |
| `npm run validate:schemas` | PASS；bundle `2.2.0`，22 schemas，21 document validators，0 unresolved refs |
| `npm run validate:fixtures` | PASS；18 tests，18 passed；accepted 29 mutation negatives、fake/missing source 和 future Artifact boundary 保持通过 |
| `npm run validate:store` | PASS；11 tests，11 passed |
| `npm run test:faults` | PASS；10 tests，10 passed |
| `npm run test:recovery` | PASS；11 tests，11 passed |
| `npm run test:g0.4` | PASS；18 tests，18 passed |
| `npm run verify:skeleton` | PASS；G0.4 required paths、单一 lockfile、package metadata 和 Node `24.18.0` runtime checks 通过 |
| `npm audit` | PASS；0 vulnerabilities |
| `git diff --check` | PASS；second follow-up 提交前复核 |

## G0.4 Plan / Adaptation Runtime 第三次定向返修候选

第三次返修以 clean `main@be78ea969fcbccbfda38f242f5ddb03016db7a16` 为唯一基线，提交为 `e4d5a0d649c8dc39cbf3ea5df7eaf603ffa880ce`，parent=`be78ea969fcbccbfda38f242f5ddb03016db7a16`。该候选已由独立 G0.R 接受。

### 中控失败复现

- 同一 Run 先 append `event_multi_1` 并发布引用 `events.jsonl#event_multi_1` 的 immutable Gap Snapshot，再 append `event_multi_2` 并发布第二个 Snapshot。旧 Artifact publish 把同 path exact records 逐次写入 `documents[path]`，只保留排序后的最后一个 record；第二次 publish 因旧 Snapshot 的 fragment 无法在新 record 中解析而返回 `artifact.reference_invalid` / `reference.fragment_missing`。
- Run reopen 对全部 formal documents 收集 `trigger_event_ref` / `user_decision_ref` 时采用相同的单 path 替换，Event 与 Decision 都会发生 last-record collapse。长期保留的旧 Gap/Adaptation Artifact 因而不能与 append-only JSONL 的多个 exact fragment 共存。

### 第三次定向修复

- `ArtifactValidator` 增加只供受控调用链使用的 fragment-aware reference context，以完整 `events.jsonl#event_id` / `decisions.jsonl#decision_id` 为 key。Typed ref 仍逐项验证目标 schema、exact fragment/id 和 same-Run；supplemental record 本身也必须 schema-valid。普通 Document Bundle 继续按 path 唯一，duplicate-path、普通 fragment/type/Run 规则未放宽。
- `ArtifactStore.validateEnvelopeReferences` 与 `RunStore.recoverLocked` 不再把 JSONL record 注入或替换普通 `documents[path]`；它们对 formal documents 明示的每个 distinct exact ref 独立调用 `JsonlStore.readExactRecord`，并把完整 map 交给 reference evaluator。未扫描无关 Run 内容，完整 tail、closed schema、Run、canonical record、operation key、receipt filename/payload 对账保持不变。
- `PlanRevisionRuntime` 从所有已与磁盘 immutable Artifact 对账的 Gap/Adaptation inputs 构造相同 exact-ref context，并沿 Planning Contract、Plan 与 Adaptation validator 传递。首次 apply 与 candidate validation 可同时解析两个 user Decision fragments；pending/applied replay 及 reopen 继续从 receipt 和 immutable source refs 独立调用 `readExactRecord`，不信任 caller-only record。
- 未修改 bundle `1.0.0`、`2.0.0`、`2.1.0`、`2.2.0`、任何已发布 JSON Schema/policy、Artifact envelope/receipt version、`JsonlStore.readExactRecord` 或 G0.3 durability contract。未改变 future-declared output publish、partial retry、AI source binding、CAS、late Artifact 或 crash boundary。

### 第三次定向回归与验证证据

- `tests/fixtures/g0.4/plan-adaptation-cases.json` 现记录 10 个 valid action、4 个 negative Plan case、24 个 negative apply case、3 个 multi-JSONL positive case、3 个 Gap cycle identity case、8 个 negative Gap reference case 和 4 个 crash boundary。
- `tests/g0.4-runtime.test.ts` 使用真实临时 filesystem 运行 29 个测试：同 Run 两个 Event record 对应两个 immutable event-driven Gap Snapshot，第二次 publish 与 immediate reopen 成功；两个 Decision record 对应两个 user-requested Adaptation Decision，publish/reopen 成功；两个 exact user Decision 在同一 Plan Revision 中分别执行 retry/supersede，首次 apply、idempotent replay 和 reopen 成功。
- Multi-record negatives 保留同 log 的新 record/receipt 有效，只篡改或删除旧 record/receipt，或把旧 ref 改为 missing fragment、wrong log type、wrong record type、wrong Run；全部在 Plan operation receipt、control Artifact、checkpoint 和 manifest CAS 写入前 fail closed，并断言上述边界未变化。旧 formal input tamper、Gap cycle identity、CAS/idempotency、late Artifact 和四个 crash boundary 继续通过。
- 冻结环境使用 `PATH=/opt/homebrew/Cellar/node@24/24.18.0/bin:$PATH` 的 Node.js `24.18.0`；因该 Cellar 当前捆绑 npm `11.17.0`，所有合格 npm 命令均显式通过 `npx --yes npm@11.16.0` 执行，版本检查输出 `11.16.0`，未增加 package manager、lockfile 或依赖。

| 命令 | 结果 |
| --- | --- |
| `npm ci` | PASS；npm `11.16.0`；18 packages installed，19 packages audited，0 vulnerabilities |
| `npm run lint` | PASS；Biome checked 117 files，0 diagnostics |
| `npm run typecheck` | PASS；`tsc --noEmit` |
| `npm test` | PASS；88 tests，88 passed，0 failed/skipped/todo |
| `npm run validate:schemas` | PASS；bundle `2.2.0`，22 schemas，21 document validators，0 unresolved refs |
| `npm run validate:fixtures` | PASS；18 tests，18 passed；29 contract mutations、fake/missing AI source 和 future Artifact boundary 保持通过 |
| `npm run validate:store` | PASS；11 tests，11 passed |
| `npm run test:faults` | PASS；10 tests，10 passed |
| `npm run test:recovery` | PASS；11 tests，11 passed |
| `npm run test:g0.4` | PASS；29 tests，29 passed |
| `npm run verify:skeleton` | PASS；G0.4 required paths、单一 lockfile、package metadata 和 Node `24.18.0` runtime checks 通过 |
| `npm audit` | PASS；0 vulnerabilities |
| `git diff --check` | PASS；third follow-up 提交前复核 |

## G0.R Independent Foundation Whole-Gate Regression

G0.R 以 clean `main@e4d5a0d649c8dc39cbf3ea5df7eaf603ffa880ce` 为唯一基线，parent=`be78ea969fcbccbfda38f242f5ddb03016db7a16`。独立会话完整读取 RFC、进度账本、`AGENTS.md`、`$startup-opportunity` Skill 及 7 份 references，并核对从 repository root 到 `e4d5a0d` 的单 parent 完整提交链。未创建 worktree、Handoff 或 subagent，未推送、amend、rebase 或 reset。

### 独立 whole-gate 审查

- G0.1：确认 `package.json`/`package-lock.json`、`.node-version`、`.npmrc`、repository doctor、Skill/custom agents 和 CLI skeleton 仍冻结为 Node.js `24.18.x`、npm `11.16.x`、TypeScript `7.0.2` 的单一 npm 栈。4 个 G0.4 CLI/Skill 入口真实执行；下游 comparison/reporting 命令仍由 reserved fail-closed 路由拥有。
- G0.2：审查 22-schema closed bundle、21 个 document validators、typed refs、positive/negative fixtures 和 byte-stable validation。`harness/schemas/v1` 自 `da820615af2c2b821cdb46a9130286e3e9575f59`、`adaptation.v1.json` 自 `30b31754684ee83cc132ee4d3362307b98e27e23`、完整 `v2` 与 AI source-binding policy 自 `7f8c0c935c894dd56eb50937741ceb9e9971d8c0`、`v3` 与 Plan apply policy 自 `eee8dea4115f1448c092306921894ec2e573f822` 到当前逐字节无差异。
- G0.3：逐函数复核 Run/Artifact/Evidence Store、canonical hash、atomic replace、immutable publish、Event/Decision append receipts、checkpoint/reopen/recovery、path/symlink/write-conflict、fault/crash/idempotency。正式 envelope 的 schema/path/hash/Run/canonical disk binding、JSONL closed record/operation key/receipt filename/payload binding 和 recovery fail-closed 顺序均保持生效。
- G0.4：复核 Research Plan DAG/依赖与 output uniqueness、closed mode/unit tuple allowlist、AI mandatory coverage/source attestation、machine Gap Snapshot、Adaptation Decision policy、immutable Plan Revision、CAS/幂等、retry/supersede/late Artifact、四个 crash/reopen 边界，以及中文 Skill/custom agent/CLI 入口。
- 第三次 repair：确认 `exactJsonlRecords` 只以完整 `path#fragment` 提供逐 ref context；Artifact publish、Run reopen、Adaptation validate/apply 与 pending/applied replay/reopen 均从当前 Run 磁盘调用 `JsonlStore.readExactRecord`。同一 log 的 zero/one/many refs 不再发生 last-record collapse，普通 Document Bundle duplicate path 仍返回 `reference.duplicate_path`。
- Cross-Run observed/basis/evidence/repeated-source/trigger refs 全部 fail closed；Gap cycle identity包含 base Plan ref/hash、trigger kind、exact wave id 或 Event ref/id，以及排序后的 observed Artifact refs/content hashes。同输入 byte-stable，不同 base Plan 或 Event 形成不同 cycle。

### 独立 filesystem regression

- `tests/g0.4-runtime.test.ts` 新增 2 个 G0.R regression，未修改 production runtime、JSON Schema 或 policy。Filesystem 场景 append 两个 Event 并发布两个 immutable event-driven Gap Snapshot，再 append 两个 Decision 并发布两个 user-requested Adaptation Decision；四个 exact records 分别解析到四个不同 durable receipts。
- 同一批两个 Adaptation Decision 完成一次 Plan Revision apply、idempotent replay 和 Run reopen；两个 parent Gap/Adaptation Artifact 在 apply/replay/reopen 前后逐字节不变，最终 manifest 同时记录两个 applied refs 和两个 superseded units。
- Fixture 的 event-driven `snapshot_cycle_key` 改为与 Harness 相同的 canonical identity，不再使用手写弱 key；两个 cycle 均绑定同一 base Plan hash 与各自 exact Event ref/id，并且互不相等。
- 新负例删除较新 Event 的 durable receipt，保留旧 Event/receipt；reopen 返回 `recovery.missing_operation`，且 Plan receipt/control paths、checkpoint 和 manifest 在调用前后逐字节不变。既有负例继续覆盖旧/新 record 或 receipt tamper/missing、wrong log/record type、wrong Run、missing/wrong fragment，以及 pending/applied replay/reopen 写前拒绝。

### 冻结环境与真实验证

Cellar Node 路径实际提供 Node.js `v24.18.0`，但直接 `npm --version` 为 `11.17.0`；因此以下所有合格 npm 命令均通过 `npx --yes npm@11.16.0` 执行，显式版本为 `11.16.0`。未修改 package metadata、lockfile 或依赖。

| 命令 | 独立 G0.R 结果 |
| --- | --- |
| `npm ci` | PASS；18 packages installed，19 packages audited，0 vulnerabilities |
| `npm run lint` | PASS；Biome checked 117 files，0 diagnostics |
| `npm run typecheck` | PASS；`tsc --noEmit`，0 errors |
| `npm test` | PASS；90 tests，90 passed，0 failed/skipped/todo |
| `npm run validate:schemas` | PASS；bundle `2.2.0`，22 schemas，21 document validators，0 unresolved refs |
| `npm run validate:fixtures` | PASS；18 tests，18 passed，0 failed/skipped/todo |
| `npm run validate:store` | PASS；11 tests，11 passed，0 failed/skipped/todo |
| `npm run test:faults` | PASS；10 tests，10 passed，0 failed/skipped/todo |
| `npm run test:recovery` | PASS；11 tests，11 passed，0 failed/skipped/todo |
| `npm run test:g0.4` | PASS；31 tests，31 passed，0 failed/skipped/todo |
| `npm run verify:skeleton` | PASS；107 doctor checks，单一 lockfile、package metadata 和 Node `24.18.0` runtime checks 通过 |
| `npm audit` | PASS；0 vulnerabilities |
| `git diff --check` | PASS；G0.R commit 前复核 |
| `git status --short` | PASS；commit 前仅本文与 `tests/g0.4-runtime.test.ts` 两个预期 tracked modifications；commit 后必须为空 |

### 禁止边界与结论

- 扫描确认仓库只有 `package-lock.json` 一个实现 lockfile，没有第二实现语言、未审阅依赖、隐藏 LLM/network agent loop、Workflow Runtime、任意 DAG DSL、daemon、UI 或 DB。
- 未实现或执行 G1+ 的 `assess`/`discover`、完整 Evidence/Claim/Finding/Insight、comparison/reporting、distribution/hook/MCP/Plugin，也未执行或跟踪访谈、landing page、定金、广告、付费实验、MVP 测试或其他外部验证。
- 未发现需要修改 production code 的 G0 blocker。`e4d5a0d649c8dc39cbf3ea5df7eaf603ffa880ce` 接受为 G0.4 implementation candidate；G0 Foundation、W3 与 G0.R 标记 `DONE`，只把 G1.1 标记 `READY`，本任务不启动或创建 G1.1。
- Store/Plan/Adaptation 成功只证明 deterministic mechanical contracts，不证明 Evidence 充分、decision ready 或研究结论成立。G0.3 Evidence substrate 仍不包含 G1.2 拥有的完整 Evidence Record、origin/provenance/freshness/independence/bias 或 Claim/Finding/Insight。

## 当前边界与后续状态

- G0 Foundation 已通过独立 whole-gate regression；当前没有 G0 blocker。
- G1.1 是唯一 `READY` 切片，但尚未启动；G1.2-G1.R 和 G2-G4 保持 `NOT_READY`。
- `discover`、`assess`、comparison 和 reporting 仍只有职责/reference 落点，没有业务闭环。
- 目标 runtime 是精确 Node.js `24.18.0`；Cellar 直接 npm 为 `11.17.0` 时必须使用 `npx --yes npm@11.16.0` 执行 npm 命令，开发者不得用错误版本证据替代冻结验证。

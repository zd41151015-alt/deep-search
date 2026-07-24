# Startup Opportunity Research Harness 实施进度

> **状态**: IN_PROGRESS / G0_FOUNDATION_IN_PROGRESS
> **当前 Gate**: G0 Foundation Harness=`IN_PROGRESS`；G1-G4=`NOT_READY`
> **下一独立会话**: G0.3 Run / Artifact Store and Recovery
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
| W2 | Run Store、Artifact/Evidence Store、events/decisions/checkpoint/recovery | `READY` |
| W3 | Research Plan、Gap Snapshot、Adaptation Decision、Plan Revision | `NOT_READY` |
| W4 | Assess domain contracts、research branches、matrix、audit/review/report | `NOT_READY` |
| W5 | Discovery lanes、maps、synthesis、enrichment、comparison/portfolio | `NOT_READY` |
| W6 | AI mandatory bundle 和 gates | `NOT_READY` |
| W7 | Codex Skill、custom agents、hooks/MCP、分发和端到端运营 | `NOT_READY` |

## G0 Foundation Harness 施工切片

| 切片 | 内容 | 状态 | 主要退出条件 |
| --- | --- | --- | --- |
| G0.1 | Repository / Toolchain / Skill Skeleton | `DONE` | 冻结单一实现工具链和 lockfile；替换占位 README；建立 `AGENTS.md`、Skill references/scripts、custom agent、Harness/test 目录；最小 lint/typecheck/test 命令可运行；只建 skeleton，不提前实现 G0.2+ 业务逻辑 |
| G0.2 | Core Artifact Schema Bundle | `DONE` | artifact envelope、Run Manifest、Research Plan、Gap Snapshot、Adaptation Decision、Event/Decision、Checkpoint closed schemas；positive/negative fixtures；deterministic schema validation |
| G0.3 | Run / Artifact Store and Recovery | `READY` | create/load run、atomic artifact publish、refs/hash、event/decision append、checkpoint、reopen/recovery、path traversal/write-conflict/idempotency fixtures |
| G0.4 | Plan / Adaptation Runtime | `NOT_READY` | plan validator、machine gap draft、adaptation validator、immutable plan revision、stale-base/CAS、retry/supersede/late artifact、crash-boundary fixtures |
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
| Active task | `none`（G0.2 原子提交后交回中控验收） |
| Current slice | `G0.3` (`READY`，未开始) |
| Expected base | `PENDING_G0_2_ATOMIC_COMMIT`；其 parent 必须为 `4fb428d54ea1656fe8a15ffdc1d4e963d4a4609e` |
| Consecutive state-query failures | `0` |
| Last effective operation | `g0_2_exit_recorded` |
| Next allowed action | 中控验收 G0.2 commit/parent/clean status 后创建 G0.3 独立施工任务；不得开始 G0.4 |

## 已完成切片与证据

| 切片 | 状态 | Commit | Parent |
| --- | --- | --- | --- |
| G0.1 Repository / Toolchain / Skill Skeleton | `DONE` | `4fb428d54ea1656fe8a15ffdc1d4e963d4a4609e` | `4033ae504219bfc6d616d76a1b2c44143e83cb42` |
| G0.2 Core Artifact Schema Bundle | `DONE` | `PENDING_G0_2_ATOMIC_COMMIT` | `4fb428d54ea1656fe8a15ffdc1d4e963d4a4609e` |

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

## 当前阻塞与风险

- G0.2 schema/reference validation 只证明结构和显式 bundle 引用闭合；它不证明 artifact 已发布、Evidence 充分、业务 policy 通过、decision ready 或 G0 Foundation 完成。
- G0.3 Run/Artifact/Evidence Store、event/decision append、hash/atomic publish、checkpoint/recovery 与 G0.4 adaptation runtime 均未开始；对应 Skill 入口继续结构化失败，不能被调用方转成成功或 mock artifact。
- `discover`、`assess`、comparison 和 reporting 只有职责/reference 落点，没有业务闭环；G1-G4 保持 `NOT_READY`。
- 目标 runtime 是精确 Node.js `24.18.0`；PATH 上其他 Node 版本会被 engine guard 或 repository doctor 拒绝，开发者需先切换版本。
- Codex task status 工具可能暂时不可用；中控按三次失败后的多证据降级规则处理，不能仅凭超时判断任务失败。

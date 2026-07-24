# Report Contract

每个完成的 Run 都有一个结构化事实来源和两个 Markdown view：

```text
validated artifacts -> report.json -> decision-brief.md -> report.md
```

decision brief 是默认用户入口。它说明决策问题、当前建议及其含义、决定性的支持与反对 Evidence、未选替代方案、关键未知项、能够改变决策的 Evidence、belief update、有效日期、scope 和局限。不能为了简短而省略强 counter-evidence。

完整 report 在相同 judgment context 上展开 Evidence chain、domain object、comparison 或 assessment dimension、风险、kill criteria、来源审计，以及可选的用户自主管理验证建议。它不得引入 `report.json` 中不存在的结论，也不得把 assessment 描述为已完成的市场验证。

生成过程由已经验证的引用和 policy version deterministic 驱动。consistency evaluator 必须拒绝三个输出之间的不一致。concept assessment 的 reporting 实现属于 G1.4，discovery 的 reporting 实现属于 G2.4；G0.4 只提供该 routing contract。

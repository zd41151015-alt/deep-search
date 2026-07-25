# Report Contract

每个完成的 Run 都有一个结构化事实来源和两个 Markdown view：

```text
validated artifacts -> report.json -> decision-brief.md -> report.md -> consistency evaluation
```

decision brief 是默认用户入口。它说明决策问题、当前建议及其含义、决定性的支持与反对 Evidence、未选替代方案、关键未知项、能够改变决策的 Evidence、belief update、有效日期、scope 和局限。不能为了简短而省略强 counter-evidence。

完整 report 在相同 judgment context 上展开 Evidence chain、domain object、comparison 或 assessment dimension、风险、kill criteria、来源审计，以及可选的用户自主管理验证建议。它不得引入 `report.json` 中不存在的结论，也不得把 assessment 描述为已完成的市场验证。

生成过程由已经验证的引用和 policy version deterministic 驱动。G1.4 使用 immutable JSON sidecar、receipt 和 fixed materialized paths；exact replay 必须保持字节不变，冲突或 receipt/source/hash drift 必须 fail closed。consistency evaluator 拒绝 result/ref/hash/freshness/limitations/counter-evidence/decision meaning/external boundary 漂移、新结论、市场验证或成功概率表述。G2.4 才可扩展 discovery reporting；G1.4 不开放 comparison 或 portfolio。

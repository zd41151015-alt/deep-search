# Report Contract

Every completed Run has one structured fact source and two Markdown views:

```text
validated artifacts -> report.json -> decision-brief.md -> report.md
```

The decision brief is the default user entry. It states the decision question, current recommendation and its meaning, decisive support and opposition, alternatives not selected, critical unknowns, evidence that would change the decision, belief update, validity date, scope, and limitations. It must not omit strong counter-evidence to stay short.

The full report expands the same judgment context with evidence chains, domain objects, comparisons or assessment dimensions, risks, kill criteria, source audit, and optional user-owned validation suggestions. It does not introduce a conclusion absent from `report.json` or present an assessment as completed market validation.

Generation is deterministic from validated references and policy versions. A consistency evaluator must reject disagreement among the three outputs. Reporting implementation belongs to G1.4 for concept assessment and G2.4 for discovery; G0.1 provides only this routing contract.

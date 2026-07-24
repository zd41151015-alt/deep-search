# Lane Catalog And Handoff

Research units use published unit types and one of three stable custom-agent roles. The planner may not invent roles, artifact schemas, permissions, or output locations.

The lane researcher owns bounded source discovery, supporting and opposing claims, findings, limitations, unresolved questions, and exactly one assigned branch artifact. The evidence auditor independently checks reference existence, quote fidelity, support, independence, bias, freshness, and stance balance. The adversarial reviewer attacks the synthesis with independent challenger queries and records revision requests or conclusion-changing gaps.

Every subagent receives a task envelope containing run id, unit id, mode, research goal, input references, one allowed output path, required artifact schema, required support/opposition stances, tool guidance, stop conditions, and completion-message contract. The completion message contains only the artifact path, validation status, limitations, and unresolved questions; it is not a formal branch result.

Units in the same wave must be independent and have unique output paths. Subagents never write the manifest, plans, adaptations, comparison policy, decision brief, or report. Fan-in consumes only validated artifacts and preserves partial, failed, cancelled, skipped, ignored-late, and superseded status instead of treating missing work as neutral evidence.

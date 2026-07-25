# Reporting Ownership

G1.4 owns concept-assessment `report.json`, decision brief, full report, traceability, and consistency evaluation. G2.4 extends the same structured-source rule to discovery comparison and portfolio outputs.

`audit-traceability` consumes one explicit `document_bundle.v7` and returns a structured, non-zero-on-failure audit. `build-report` consumes one explicit v7 main-agent report envelope, then publishes `report-json`, decision brief, report Markdown, and consistency sidecars in fixed order. It materializes `report.json`, `decision-brief.md`, and `report.md` from those immutable sidecars. Exact replay is byte-stable; same-path, receipt, source/hash, or materialized drift fails closed. Reopen may complete a validated partial publish, but it cannot invent or revise judgment content.

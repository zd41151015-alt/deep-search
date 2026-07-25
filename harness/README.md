# Deterministic Harness

This tree contains repository-controlled mechanics for Startup Opportunity research. It may validate, persist, version, compare, checkpoint, and render typed artifacts, but it never performs open-ended research judgment or hidden model calls.

G1.4 默认发布 schema bundle `6.0.0`，保留既有 v1-v6 schema/policy bytes，并加入 v7 Evidence audit、Adversarial Review、final Assessment、Traceability、report/brief/view/consistency contracts，以及 v7 Envelope/Document Bundle。Assessment result、Hard Gate、Evidence ceiling、producer ownership、same-Run/final-plan lineage 和 report consistency 都由 deterministic validator fail closed。

The public developer entry is `npm run harness -- <command>`. `audit-traceability` validates an explicit closed bundle; `build-report` publishes one explicit report envelope and deterministically materializes the three report outputs. The Harness does not start lanes, obtain Evidence, or make research judgments. Discovery, comparison, portfolio, and G2+ behavior remain unavailable.

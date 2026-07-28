# Deterministic Harness

This tree contains repository-controlled mechanics for Startup Opportunity research. It may validate, persist, version, compare, checkpoint, and render typed artifacts, but it never performs open-ended research judgment or hidden model calls.

G2.2 默认加载 schema bundle `9.0.0`。已接受的 v9/bundle `8.0.0` 方案 A contract bytes 保持 immutable；runtime 另用 v10 Envelope/Document Bundle、`discovery_fan_in.v2`、receipt v8 和 publication policy v5。Candidate/task/material/lane/pre-kill/fan-in 由调用方显式提供并经 deterministic validator/Store fail closed，v9 envelope 继续不可写。

The public developer entry is `npm run harness -- <command>`. G2.1 maps and G2.2 runtime artifacts use the existing generic `validate-artifact`, `record-evidence`, `publish-artifact`, `checkpoint-run`, and `load-run` commands. The Harness does not start lanes, obtain Evidence, infer dispositions, or make research judgments. Discover orchestration, formal thesis synthesis, comparison, portfolio, discovery reporting, and G2.3+ behavior remain unavailable.

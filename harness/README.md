# Deterministic Harness

This tree contains repository-controlled mechanics for Startup Opportunity research. It may validate, persist, version, compare, checkpoint, and render typed artifacts, but it never performs open-ended research judgment or hidden model calls.

G2.3 默认加载 schema bundle `10.0.0`。已接受的 v9/bundle `8.0.0` contract 与 v10/bundle `9.0.0` G2.2 runtime bytes 保持 immutable；G2.3 另用 v11 Envelope/Document Bundle、executable conversion v2、receipt v9 和 publication policy v6。Conversion、formal thesis、solution evaluation、freeze snapshot 与 semantic merge 由调用方显式提供并经 deterministic validator/Store fail closed。

The public developer entry is `npm run harness -- <command>`. G2.1 maps, G2.2 runtime artifacts, and caller-supplied G2.3 synthesis artifacts use the existing generic `validate-artifact`, `record-evidence`, `publish-artifact`, `checkpoint-run`, and `load-run` commands. The Harness does not start lanes, obtain Evidence, synthesize thesis semantics, infer dispositions, or make research judgments. Discover orchestration and G2.4 enrichment, comparison, portfolio, and discovery reporting remain unavailable.

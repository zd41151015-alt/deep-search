# Deterministic Harness

This tree contains repository-controlled mechanics for Startup Opportunity research. It may validate, persist, version, compare, checkpoint, and render typed artifacts, but it never performs open-ended research judgment or hidden model calls.

G1.3 默认发布 schema bundle `5.0.0`，保留既有 v1-v5 schema/policy bytes，并加入 `gap_snapshot.v2`、`adaptation_decision.v3`、assessment adaptation policy 和 v6 Envelope/Document Bundle。buyer/acquisition Gap analysis 绑定 exact current Run、subject/scope、Research Plan、assessment plan、coverage_key、observed Artifact/hash 与 unit/attempt state；合法 `add_unit` 只生成 bounded Research Plan/assessment plan revision，`stop_followup` 不创建 revision。

The public developer entry is `npm run harness -- <command>`. In addition to the Store commands, `validate-plan`, `analyze-gaps`, `validate-adaptation`, and `apply-plan-revision` are available for explicit G0/G1.3 inputs. The Harness does not start lanes or make research judgments; audit, comparison, and reporting commands remain fail closed until their owning slices are implemented with fixtures and ledger evidence.

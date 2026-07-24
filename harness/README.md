# Deterministic Harness

This tree contains repository-controlled mechanics for Startup Opportunity research. It may validate, persist, version, compare, checkpoint, and render typed artifacts, but it never performs open-ended research judgment or hidden model calls.

G0.4 保留原有 v1/`2.0.0`/`2.1.0` contracts，并默认发布 schema bundle `2.2.0`。Store 通过 v2 receipt 精确发布 v2/v3 control envelope，支持 Planning Context v2、Adaptation Decision v2、Plan Revision 和 checkpoint；v1 Store record 继续可 reopen。Plan validator、machine Gap Snapshot draft、Adaptation validator 和 immutable Plan Revision runtime 已接通，downstream research judgment 仍 fail closed。

The public developer entry is `npm run harness -- <command>`. In addition to the Store commands, `validate-plan`, `analyze-gaps`, `validate-adaptation`, and `apply-plan-revision` are available. Research, comparison, and reporting commands remain fail closed until their implementation, positive and negative fixtures, and ledger status are committed together.

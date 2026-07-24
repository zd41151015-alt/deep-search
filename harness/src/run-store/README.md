# Run Store Ownership

G0.3 owns creation and loading of Run directories, manifest indexing, event and decision append semantics, checkpoints, reopen reconciliation, and crash recovery. Writes must be confined to the selected Run, preserve immutable history, and use atomic publication.

No Run Store operation is implemented in G0.1. The `create-run` and `load-run` Skill entries fail closed until this contract has real storage and recovery tests.

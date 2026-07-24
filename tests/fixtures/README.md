# Fixture Ownership

G0.2 fixtures include one valid document for each of the eight core artifact contracts, structured negative mutations for required/extra/enum/action/path/version/revision boundaries, an explicit valid typed-reference bundle, negative reference mutations, and a raw CLI failure document. Tests execute every mutation against the production validator and assert the exact rejection category.

G0.3 adds three committed Store input fixtures plus real temporary-filesystem tests for Run creation/reopen, formal publication, hash/ref/path/symlink rejection, idempotency/conflict, Event/Decision append, Evidence raw bytes/dedup, JSONL corruption, checkpoint divergence, plan lineage, and injected crash boundaries. G0.4 still owns adaptation policy, stale-base, retry, supersede, and late-artifact fixtures. Fixtures do not claim research quality, policy behavior, or downstream Gate completion.

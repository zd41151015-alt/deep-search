# Artifact Store Ownership

G0.3 owns path confinement, typed artifact envelopes, content hashes, temporary-file validation, atomic publication, immutable revisions, and write-conflict/idempotency behavior. Downstream-referenced artifacts are never overwritten in place.

G0.1 provides only repository structure. No script response or chat message is accepted as a stored artifact.

# Artifact Store Ownership

G0.2 publishes the typed artifact-envelope schema and validates its closed metadata/document shape. G0.3 owns path confinement, content-hash computation, temporary-file validation, atomic publication, immutable revisions, and write-conflict/idempotency behavior. Downstream-referenced artifacts are never overwritten in place.

G0.1 provides only repository structure. No script response or chat message is accepted as a stored artifact.

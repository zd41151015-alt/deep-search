# Artifact Store Ownership

G0.2 publishes the typed artifact-envelope schema and validates its closed metadata/document shape. G0.3 implements path confinement, same-Run temp writes, schema/reference checks, fsync, no-replace atomic publication, immutable formal paths, operation receipts, idempotent replay, and explicit write conflicts. Downstream-referenced artifacts are never overwritten in place.

The envelope `content_hash` basis is the SHA-256 of UTF-8 canonical `document` JSON: object keys are recursively sorted by code unit, arrays keep order, and only JSON values are accepted. The hash excludes envelope metadata, including the `content_hash` field itself. No script response or chat message is accepted as a stored artifact.

# Evidence Store Ownership

G0.3 implements the Evidence Store substrate: HTTP(S) URL canonicalization without fragments or credentials, canonical source hash, immutable raw-content hash/path, stable operation key and evidence id, deduplication, and append-only substrate manifest persistence. Reopen verifies raw bytes against every recorded content hash and replays interrupted raw publication from immutable receipts.

This slice does not fetch sources and does not publish the full `startup_opportunity.evidence.v1` business object. Evidence origin, provenance method, freshness, independence, bias, rejection/unavailability, Claim/Finding/Insight refs, and research judgment remain G1.2. `record-evidence` records only caller-supplied bytes and the RFC-defined deduplication basis.

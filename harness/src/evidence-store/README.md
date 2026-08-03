# Evidence Store Ownership

The Evidence Store accepts the one current structured source input and writes `startup_opportunity.evidence_store_record.v2` plus the current Store operation receipt. Source identity is either a canonical public URL object or the reserved `urn:startup-opportunity:user-provided:*` namespace. Operation identity binds the canonical source object, raw content hash, and research goal; raw bytes are immutable and content-addressed.

`record-evidence` stores caller-supplied bytes and never fetches a URL. The Store computes and validates IDs, source/content hashes, raw refs, operation keys, Run/unit identity, and timestamps. Evidence origin, provenance, independence, bias, tier, role, representativeness, freshness, and limitations remain explicit formal Artifact fields supplied by the research Runtime.

Reopen validates every current record, receipt, raw hash, exact JSONL fragment, and uniqueness constraint. It can truncate an incomplete append tail inside the same current Run; it does not read legacy record or receipt formats after a contract update. Store success does not attest truth, sufficiency, independence, freshness, or market validation.

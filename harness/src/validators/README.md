# Deterministic Schema And Reference Validator

G0.2 implements deterministic schema and reference validation against `harness/schemas/v1/bundle.json`. The reusable API returns sorted structured issues. The CLI validates one document, checks the bundle itself, or validates known typed refs and revision lineage among documents explicitly supplied in a `startup_opportunity.document_bundle.v1` input.

The validator does not discover Run files, publish artifacts, compute content hashes, append logs, recover state, evaluate Plan DAG/policy semantics, or judge freshness, research quality, evidence sufficiency, decision readiness, adaptation policy, and report consistency. Those remain with their owning slices. The repository doctor remains a separate repository/toolchain check.

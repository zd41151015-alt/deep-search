# Deterministic Schema And Reference Validator

G0.2 implements deterministic schema and reference validation against `harness/schemas/v1/bundle.json`. The reusable API returns sorted structured issues. The CLI validates one document, checks the bundle itself, or validates known typed refs and revision lineage among documents explicitly supplied in a `startup_opportunity.document_bundle.v1` input.

The validator itself still does not discover Run files, publish artifacts, compute content hashes, append logs, or recover state. G0.3 Store modules compose this unchanged validator with filesystem/hash/recovery checks. Neither layer evaluates Plan DAG/policy semantics, freshness, research quality, evidence sufficiency, decision readiness, adaptation policy, or report consistency. The repository doctor remains a separate repository/toolchain check.

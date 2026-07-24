# Core Schema Bundle

`v1/bundle.json` publishes schema bundle `1.0.0` on JSON Schema Draft 2020-12. It contains closed schemas for the formal artifact envelope, Run Manifest, Research Plan, Gap Snapshot, action-discriminated Adaptation Decision, Event, Decision, Checkpoint, and explicit validation document bundle. Shared definitions close version, path, reference, enum, and research-unit shapes.

`npm run validate:schemas` compiles the complete bundle and verifies that every internal `$ref`, including its JSON Pointer, resolves without network access. `npm run validate:fixtures` exercises representative positive and negative documents. A schema-valid artifact still has no publication or decision-readiness status; G0.3 owns storage/publication and later evaluators own business sufficiency.

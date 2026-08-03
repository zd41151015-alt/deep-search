# Current Schema Contract

`current.json` is the only schema manifest loaded by production code. It is edited in place with the current producers, consumers, policies, and fixtures. It has no release number, `base_bundle`, inheritance chain, historical selection, or compatibility role.

The directories named `v1/` through `v19/` are source organization inherited from construction. A numbered domain schema remains installed only when a current producer, consumer, policy, or `$ref` reaches its distinct business shape. The directory number does not make it an old-Run contract and must not be used for Store dispatch. New naming should describe business semantics when current incompatible shapes must coexist; do not mechanically rename all existing domain IDs.

The current Store surface is:

- `startup_opportunity.artifact_envelope.current`
- `startup_opportunity.document_bundle.current`
- `startup_opportunity.artifact_store_operation.current`
- `startup_opportunity.research_publication_policy.current`

`schema-bundle.ts` validates manifest shape, local paths, duplicate IDs/files/document versions, schema `$id`, complete local `$ref` and JSON Pointer resolution, and AJV compilation. `npm run validate:current-contract` additionally checks Envelope dispatch completeness, active policy roots, full manifest reachability, and forbidden version-selection structures. Neither check freezes schema counts or bytes.

Schema validity is only structural validity. Publication still requires current Envelope metadata, canonical content hash, typed reference closure, Plan ownership, policy checks, and same-Run state.

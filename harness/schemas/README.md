# Current Schema Contract

`current.json` is the only schema manifest loaded by production code. It is edited in place with the current producers, consumers, policies, and fixtures. It has no release number, `base_bundle`, inheritance chain, historical selection, or compatibility role.

Every production schema lives under `current/`, grouped by the domain that owns it. The manifest rejects files outside that tree. Numbered construction directories are not part of the current contract layout.

Current incompatible business shapes use descriptive identities such as Assessment, Discovery Candidate, Discovery Evaluation, and Terminal rather than a shared name with increasing version numbers. A remaining numbered domain identity is a single current business contract, not a historical bundle or Store compatibility surface; change it only with its current producers, consumers, policies, and fixtures.

The current Store surface is:

- `startup_opportunity.artifact_envelope.current`
- `startup_opportunity.document_bundle.current`
- `startup_opportunity.artifact_store_operation.current`
- `startup_opportunity.research_publication_policy.current`

`schema-bundle.ts` validates manifest shape, local paths, duplicate IDs/files/document versions, schema `$id`, complete local `$ref` and JSON Pointer resolution, and AJV compilation. `npm run validate:current-contract` additionally checks Envelope dispatch completeness, active policy roots, full manifest reachability, and forbidden version-selection structures. Neither check freezes schema counts or bytes.

Schema validity is only structural validity. Publication still requires current Envelope metadata, canonical content hash, typed reference closure, Plan ownership, policy checks, and same-Run state.

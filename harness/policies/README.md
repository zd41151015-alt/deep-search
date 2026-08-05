# Current Policy Boundary

Every JSON file in this directory is an active `.current.json` policy document and must be listed by `CURRENT_POLICY_PATHS`. The architecture validator rejects missing or unlisted policy JSON. Production loaders open those exact paths and validate them against `harness/schemas/current.json`; callers cannot select a historical or alternate policy path.

The policies own closed deterministic rules for planning/adaptation, AI trigger binding, Assessment execution/reporting, Discovery maps/candidates/synthesis/evaluation, candidate pre-kill binding, and publication. Discovery and Assessment share `ai-trigger-source-binding.current.json`; workflow mode does not select historical trigger policies. `research-publication.current.json` directly selects the one current Artifact Envelope, Document Bundle, and Store receipt. It has no base policy, adapter list, highest-version selection, or compatibility fallback.

Policy changes must update the policy document, its schema, every producer and consumer of the changed field, canonical hash bindings, and current positive/negative fixtures in one change. Policy success does not perform research, call a model, infer evidence quality, or establish external validation.

# Deterministic Validators

All validators use `harness/schemas/current.json` and the exact active policy files. `validate-artifact` validates explicit caller input; it does not scan or migrate old Runs, start agents, access the network, or infer research quality.

`ArtifactValidator` first validates the one current Document Bundle and unwraps only the current Artifact Envelope. It dispatches semantic validators by `artifact_type`, workflow mode, and the artifact families actually present, not by Envelope/Bundle version ranges. Current domain shapes with numbered IDs remain distinct where producers and consumers still use different Assessment, Discovery, reporting, or execution semantics.

The semantic validators cover:

- Planning Context, Plan DAG/state, adaptation, immutable revision, stale binding, and policy tuples.
- Assessment framing, branch material, fan-in, evidence ceilings, audit/review, terminal gates, and reports.
- Discovery maps, candidates, source separation, synthesis, enrichment, comparison, sensitivity, portfolio, traceability, and reports.
- AI baseline, reliability, data, economics, commoditization, trust, mandatory coverage, and consumer binding.
- Declarative Runtime and Assessment execution task/output ownership.

Typed refs must resolve to the expected same-Run artifact and fragment, and exact JSONL refs must replay the exact stored record. `npm run validate:current-contract` checks that all current Envelope dispatch rules and active policy schemas reach every manifest entry and prevents historical Store version-selection structures from returning.

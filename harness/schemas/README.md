# Schema Bundle Boundary

G0.2 owns closed JSON Schemas for artifact envelopes, Run Manifest, Research Plan, Gap Snapshot, Adaptation Decision, Event, Decision, and Checkpoint, together with positive and negative fixtures. No schema is published in G0.1 because an empty or permissive schema would falsely claim a contract.

Published schemas must carry stable version identifiers, reject unknown closed-enum values where required, and be consumed by the deterministic validator rather than copied into agent prompts.

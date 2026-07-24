# Policy Boundary

Versioned domain policies live here. G0.4 owns `adaptation.v1.json` and its deterministic enforcement after the G0.2 schemas and G0.3 stores exist.

A published adaptation policy must allow only RFC-defined gap, action, unit, phase, and mode combinations. It must reject mode/market changes, comparison reweighting, stale base plans, path escapes, invalid unit state transitions, and follow-up beyond the published limit. G0.1 intentionally publishes no permissive placeholder policy.

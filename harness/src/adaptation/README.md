# Adaptation Runtime Ownership

G0.4 implements deterministic machine Gap Snapshot drafts, Adaptation Decision v2 policy checks, immutable Plan Revision application, stale-base compare-and-swap behavior, retry/supersede lineage, late Artifact exclusion, idempotency, and crash-boundary recovery.

`PlanSemanticValidator` enforces one domain-specific closed Research Plan contract: DAG and dependency legality, unique unit/output ownership, exact mode/phase/unit_type/agent_role/required_artifact_schema tuples, Planning Context v2/source bindings, AI mandatory coverage, manifest dispositions, and immutable parent constraints. It is not a general DAG language or workflow runtime.

`GapAnalyzer` consumes an explicit validated Document Bundle and only emits machine-observable gaps. Semantic gap selection remains with the main agent. `AdaptationPolicyValidator` accepts only v2 closed actions; retry requires `failed_units`, partial retry fails closed, and `continue_existing_plan` verifies rather than interprets the main agent's Coverage Attestation.

`PlanRevisionRuntime` writes an immutable operation receipt, publishes control Artifact paths, performs manifest CAS, then publishes a checkpoint and append-only events. Replay is idempotent by canonical parent Plan hash plus sorted Adaptation Decision refs. Recovery completes only validated on-disk receipt state; late Artifact files persist but remain outside current `artifact_refs`.

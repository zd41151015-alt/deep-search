# Plugin Packaging Decision

## Decision

The G4 operational decision is `REPO_LOCAL_NOT_PACKAGED`. Exact candidate `060029fbcfc6e4b543873642b7e3657c67c913af` received an independent whole-G4 PASS, and it does not package a Codex Plugin. The current documentation descendant does not change this packaging decision and remains subject to fresh independent whole-G4 acceptance created by the controller.

## RFC Criteria

| Packaging trigger | Current requirement | Result |
| --- | --- | --- |
| Install across multiple repositories | No. The current user requirement targets this repository. | Not met |
| Publish Skill, MCP, hooks, and assets as one distributable unit | No. Project-local paths and the npm lockfile are the required installation boundary. | Not met |
| Provide stable versioned distribution and a shared team entry | No cross-team distribution or marketplace lifecycle is requested. | Not met |

Creating a Plugin only to mark G4 complete would add a second installation/versioning surface without a consumer. The committed `.agents/`, `.codex/`, Harness, docs, and lockfile already form the auditable repo-local unit required by the RFC.

This decision closes only the repo-local packaging question. It is not evidence that the project-wide RFC sections 29 and 30 completion scope is complete.

## Invariants

- Run state remains under repository-local `runs/`; a future Plugin must never store or own Run state.
- A future Plugin would distribute the Skill, agents, MCP registration, hooks, and static assets only. It would not replace the Evidence Store or deterministic Harness.
- Plugin packaging must not broaden MCP tools, permissions, network access, credential forwarding, or agent ownership.
- Formal research must still enter through `$startup-opportunity` or a compatible Skill invocation.

Revisit this decision only after a concrete multi-repository installation, team distribution, or stable release-channel requirement exists.

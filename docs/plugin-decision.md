# Plugin Packaging Decision

## Decision

The current operational decision is `REPO_LOCAL_NOT_PACKAGED`. This repository does not package a Codex Plugin because there is no multi-repository or team-distribution requirement.

## RFC Criteria

| Packaging trigger | Current requirement | Result |
| --- | --- | --- |
| Install across multiple repositories | No. The current user requirement targets this repository. | Not met |
| Publish Skill, MCP, hooks, and assets as one distributable unit | No. Project-local paths and the npm lockfile are the required installation boundary. | Not met |
| Provide a shared team distribution entry | No cross-team distribution or marketplace lifecycle is requested. | Not met |

Creating a Plugin without a distribution consumer would add a second installation surface. The committed `.agents/`, `.codex/`, Harness, docs, and lockfile form the auditable repo-local unit.

## Invariants

- Run state remains under repository-local `runs/`; a future Plugin must never store or own Run state.
- A future Plugin would distribute the Skill, agents, MCP registration, hooks, and static assets only. It would not replace the Evidence Store or deterministic Harness.
- Plugin packaging must not broaden MCP tools, permissions, network access, credential forwarding, or agent ownership.
- Formal research must still enter through `$startup-opportunity` or a compatible Skill invocation.

Revisit this decision only after a concrete multi-repository installation or team-distribution requirement exists.

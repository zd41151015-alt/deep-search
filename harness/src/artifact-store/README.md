# Artifact Store Ownership

The Artifact Store accepts one current Artifact Envelope and one current Store operation receipt contract under `research-publication.current.json`. Publication validates the closed Envelope/document shape, same-Run identity, canonical document hash, typed references, current policy, and Plan-owned output before writing.

Formal paths are immutable. Publication uses same-Run temporary files, fsync, no-replace atomic installation, and an exact operation receipt. Identical replay is idempotent; the same identity with divergent bytes is rejected. A multi-artifact publication validates the complete pending/current closure before installing each immutable path. `manifest.json` remains the separately atomically replaced current index.

There is no historical Envelope union, publication adapter, base policy chain, migration, or fallback. A Run from before a code/contract update is not a recovery target. Crash recovery within one current Run remains mandatory and revalidates exact on-disk Envelope, hash, ref, receipt, and Manifest state.

The Store never dispatches agents, calls an LLM, accesses the network, or treats chat and completion summaries as formal Artifacts.

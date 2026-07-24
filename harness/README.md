# Deterministic Harness

This tree contains repository-controlled mechanics for Startup Opportunity research. It may validate, persist, version, compare, checkpoint, and render typed artifacts, but it never performs open-ended research judgment or hidden model calls.

G0.1 implements only `harness/src/cli.ts` and the repository doctor. The remaining directories establish explicit ownership boundaries for later ledger slices; their README contracts prevent an empty directory from being mistaken for completed behavior.

The public developer entry is `npm run harness -- <command>`. `help` and `doctor` are currently available. Research commands must remain fail-closed until their implementation, positive and negative fixtures, and ledger status are committed together.

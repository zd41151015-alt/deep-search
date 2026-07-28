# G2.4 Discovery Evaluation Fixtures

`discovery-evaluation-fixture.ts` builds a closed synthetic discovery Run through enrichment,
Business Engine, hard gates, four-panel comparison, sensitivity, partial order, portfolio,
recommendation, traceability, and reporting. Its user-provided substrate bytes are test inputs only;
they are explicitly marked unverified and are not real Evidence or validation success.

The G2.4 test mutates exact task/material lineage, Evidence substrate binding, branch/fan-in closure,
hard gates, panel closure, evidence ceiling, sensitivity, portfolio, freshness, report closure, and
bundle version. Runtime tests exercise immutable publication, receipt recovery, terminal branch
projection, report materialization/reopen, and the v11 fail-closed boundary.

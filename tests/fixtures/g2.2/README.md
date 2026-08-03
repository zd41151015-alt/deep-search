# G2.2 Current Fixtures

`discovery-candidate-fixture.ts` produces a synthetic current Document Bundle with typed demand, baseline, and solution candidates plus the exact current G2.1 map and Plan closure.

`discovery-runtime-fixture.ts` adds current Research Tasks, structured Evidence Store records, typed lane material/results, pre-kill judgments, and `discovery_fan_in.v2`. Tests cover staged publication, Manifest task/terminal projection, immutable replay, checkpoint/reopen, and fault recovery.

The fixture does not dispatch lanes, perform research, call a model, fetch a source, or establish Evidence truth or external validation.

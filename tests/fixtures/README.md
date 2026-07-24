# Fixture Ownership

G0.2 fixtures include one valid document for each of the eight core artifact contracts, structured negative mutations for required/extra/enum/action/path/version/revision boundaries, an explicit valid typed-reference bundle, negative reference mutations, and a raw CLI failure document. Tests execute every mutation against the production validator and assert the exact rejection category.

G0.3 adds storage, publication path, idempotency, reopen, and crash fixtures; G0.4 adds adaptation policy, stale-base, retry, supersede, and late-artifact fixtures. G0.1 repository negatives remain active and separate. Fixtures do not claim that research, Store, or policy behavior exists.

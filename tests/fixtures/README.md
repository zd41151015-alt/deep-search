# Fixture Ownership

Fixtures are introduced with the production contract they test. G0.2 adds positive and negative schema/reference fixtures; G0.3 adds storage, path, idempotency, reopen, and crash fixtures; G0.4 adds adaptation, stale-base, retry, supersede, and late-artifact fixtures.

The G0.1 skeleton suite constructs temporary negative repositories at runtime so it can prove missing files, empty files, metadata drift, and a second lockfile fail validation without publishing fake research artifacts.

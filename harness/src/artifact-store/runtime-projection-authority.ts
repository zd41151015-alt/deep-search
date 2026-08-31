import type { DocumentBundleReferenceContext } from "../validators/artifact-validator.js";

const RUNTIME_PROJECTION_PUBLICATION_AUTHORITY = Symbol(
  "startup_opportunity.runtime_projection_publication_authority",
);

interface RuntimeProjectionPublicationAuthorityCarrier {
  readonly [RUNTIME_PROJECTION_PUBLICATION_AUTHORITY]?: {
    readonly trustedProspectiveRuntimeAuthorityPaths: readonly string[];
  };
}

function authenticatedRuntimeProjectionAuthorityPaths(value: unknown): ReadonlySet<string> {
  if (typeof value !== "object" || value === null) return new Set();
  const authority = (value as RuntimeProjectionPublicationAuthorityCarrier)[
    RUNTIME_PROJECTION_PUBLICATION_AUTHORITY
  ];
  if (authority === undefined) return new Set();
  return new Set(
    authority.trustedProspectiveRuntimeAuthorityPaths
      .filter((path): path is string => typeof path === "string")
      .sort(),
  );
}

export function hasAuthenticatedRuntimeProjectionAuthority(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (
    (value as RuntimeProjectionPublicationAuthorityCarrier)[
      RUNTIME_PROJECTION_PUBLICATION_AUTHORITY
    ] !== undefined
  );
}

export function withAuthenticatedRuntimeProjectionAuthority<T extends object>(
  value: T,
  trustedProspectiveRuntimeAuthorityPaths: Iterable<string>,
): T {
  return Object.assign({}, value, {
    [RUNTIME_PROJECTION_PUBLICATION_AUTHORITY]: {
      trustedProspectiveRuntimeAuthorityPaths: [
        ...new Set(trustedProspectiveRuntimeAuthorityPaths),
      ].sort(),
    },
  });
}

export function publicationRuntimeProjectionReferenceContext(
  referenceContext: DocumentBundleReferenceContext = {},
): DocumentBundleReferenceContext {
  return {
    ...referenceContext,
    requireRuntimeProjectionAuthority: true,
    trustedProspectiveRuntimeAuthorityPaths:
      authenticatedRuntimeProjectionAuthorityPaths(referenceContext),
  };
}

export function runtimeProjectionPublicationAuthorityPaths(value: unknown): ReadonlySet<string> {
  return authenticatedRuntimeProjectionAuthorityPaths(value);
}

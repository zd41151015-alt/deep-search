import { canonicalContentHash } from "./artifact-store/canonical.js";
import { StoreError } from "./artifact-store/store-error.js";

export interface OpportunityFamilyDocument {
  readonly path: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
  readonly contentHash?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function exactHash(document: OpportunityFamilyDocument): string {
  return document.contentHash ?? canonicalContentHash(document.document);
}

function fail(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new StoreError(code, message, details);
}

function exactSet(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (values: readonly string[]) => [...new Set(values)].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function opportunityFamilyEvidenceRefs(merge: Record<string, unknown>): readonly string[] {
  return records(merge.opportunity_families).flatMap((family) => {
    const basis = isRecord(family.evidence_basis) ? family.evidence_basis : {};
    return [
      ...strings(basis.supporting_refs),
      ...strings(basis.opposing_refs),
      ...strings(basis.background_refs),
      ...strings(basis.unknown_refs),
    ];
  });
}

export function deriveOpportunityFamilyProjection(
  sourceMergeRef: string,
  documentsByPath: ReadonlyMap<string, OpportunityFamilyDocument>,
): Record<string, unknown> {
  const merge = documentsByPath.get(sourceMergeRef);
  if (merge?.schemaVersion !== "startup_opportunity.merge.v1") {
    fail(
      "opportunity_family.merge_authority_invalid",
      "opportunity-family projection requires the exact current Merge authority",
      { sourceMergeRef },
    );
  }
  const families = records(merge.document.opportunity_families);
  if (families.length === 0) {
    fail(
      "opportunity_family.declaration_missing",
      "Merge must contain at least one Agent-declared opportunity family",
      { sourceMergeRef },
    );
  }
  const familyIds = families.map((family) => String(family.family_id));
  if (new Set(familyIds).size !== familyIds.length) {
    fail(
      "opportunity_family.identity_duplicate",
      "opportunity family identities must be unique within one Merge revision",
      { familyIds },
    );
  }

  const sourceOpportunityRefs = strings(merge.document.source_thesis_refs);
  const declaredMemberRefs = families.flatMap((family) =>
    records(family.members).map((member) => String(member.opportunity_ref)),
  );
  if (
    new Set(declaredMemberRefs).size !== declaredMemberRefs.length ||
    !exactSet(declaredMemberRefs, sourceOpportunityRefs)
  ) {
    fail(
      "opportunity_family.member_closure_mismatch",
      "every frozen Opportunity must be declared exactly once as independent, a family variant, or unknown",
      { sourceOpportunityRefs, declaredMemberRefs },
    );
  }

  const projectedFamilies = families
    .map((family) => {
      const members = records(family.members);
      const memberRefs = members.map((member) => String(member.opportunity_ref));
      const differences = records(family.member_specific_differences);
      const differenceRefs = differences.map((difference) => String(difference.opportunity_ref));
      if (
        new Set(differenceRefs).size !== differenceRefs.length ||
        !exactSet(memberRefs, differenceRefs)
      ) {
        fail(
          "opportunity_family.difference_closure_mismatch",
          "each family member must have exactly one member-specific difference declaration",
          { familyId: family.family_id, memberRefs, differenceRefs },
        );
      }
      const projectedMembers = members
        .map((member) => {
          const opportunityRef = String(member.opportunity_ref);
          const opportunity = documentsByPath.get(opportunityRef);
          if (
            opportunity?.schemaVersion !== "startup_opportunity.opportunity_thesis.v1" ||
            opportunity.document.run_id !== merge.document.run_id
          ) {
            fail(
              "opportunity_family.member_authority_invalid",
              "family members must resolve to exact same-Run Opportunity revisions",
              { familyId: family.family_id, opportunityRef },
            );
          }
          const selectedSolutionRef = String(opportunity.document.selected_solution_ref);
          const solution = documentsByPath.get(selectedSolutionRef);
          if (
            solution?.schemaVersion !== "startup_opportunity.solution_hypothesis.v1" ||
            solution.document.run_id !== merge.document.run_id ||
            solution.document.delivery_form !== opportunity.document.selected_delivery_form
          ) {
            fail(
              "opportunity_family.selected_solution_authority_invalid",
              "family projection must resolve the exact selected Solution and delivery form for each Opportunity",
              { familyId: family.family_id, opportunityRef, selectedSolutionRef },
            );
          }
          return {
            opportunity_ref: opportunityRef,
            opportunity_content_hash: exactHash(opportunity),
            opportunity_title: opportunity.document.title,
            relation_to_family: member.relation_to_family,
            selected_solution_ref: selectedSolutionRef,
            selected_solution_content_hash: exactHash(solution),
            uses_ai: solution.document.uses_ai,
            solution_type: solution.document.solution_type,
            delivery_form: solution.document.delivery_form,
          };
        })
        .sort((left, right) => left.opportunity_ref.localeCompare(right.opportunity_ref));
      return {
        family_id: family.family_id,
        title: family.title,
        family_relation: family.family_relation,
        shared_value_or_solution_mechanism: structuredClone(
          family.shared_value_or_solution_mechanism,
        ),
        shared_assumptions: structuredClone(family.shared_assumptions),
        shared_failure_risks: structuredClone(family.shared_failure_risks),
        member_specific_differences: [...differences]
          .sort((left, right) =>
            String(left.opportunity_ref).localeCompare(String(right.opportunity_ref)),
          )
          .map((difference) => structuredClone(difference)),
        evidence_basis: structuredClone(family.evidence_basis),
        members: projectedMembers,
      };
    })
    .sort((left, right) => String(left.family_id).localeCompare(String(right.family_id)));

  return {
    source_merge_ref: sourceMergeRef,
    source_merge_content_hash: exactHash(merge),
    independent_opportunity_family_count: projectedFamilies.filter(
      (family) => family.family_relation !== "unknown",
    ).length,
    concrete_direction_count: declaredMemberRefs.length,
    unknown_family_relation_count: projectedFamilies
      .filter((family) => family.family_relation === "unknown")
      .reduce((count, family) => count + family.members.length, 0),
    families: projectedFamilies,
  };
}

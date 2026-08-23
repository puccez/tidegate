/**
 * Shared internals for `ScopedInteractionRegistry` persistence backends.
 *
 * A backend (in-memory, Drizzle/Postgres, ...) re-implements storage and
 * transaction boundaries, but the domain rules — scope derivation, owner
 * fields, artifact/record invariants, version numbering, visibility sort —
 * must stay identical across backends. This subpath exports exactly those
 * rules so a new backend composes them instead of re-deriving them; the
 * conformance suite (`@tidegate/runtime/interaction-registry-conformance`)
 * then proves the composition behaves like the reference implementation.
 *
 * Not part of the public `@tidegate/runtime` barrel on purpose: handlers and
 * app code depend on `ScopedInteractionRegistry`, never on these internals.
 */
export {
  assertNoCallerSuppliedOwnerFields,
  createdBySubjectIdFromAuth,
  deriveInteractionDraftRegistryScope,
  deriveInteractionRegistryScope,
  draftOwnerFieldsForScope,
  interactionBranchKey,
  interactionDraftKey,
  interactionDraftScopeKey,
  interactionRecordKey,
  interactionRegistryScopeFromDraftScope,
  interactionScopeKey,
  INTERACTION_VISIBILITIES,
  OWNER_FIELD_NAMES,
  ownerFieldsForScope,
} from "./interaction-registry-scope.ts";
export type {
  InteractionDraftRegistryScope,
  InteractionOwnerField,
  InteractionRegistryScope,
} from "./interaction-registry-scope.ts";
export {
  createRegistryId,
  immutableClone,
  toIsoTimestamp,
} from "./interaction-registry-storage.ts";
export {
  assertArtifactMatchesRecord,
  assertAvailabilityTransitionAllowed,
  assertRecordCanReceivePublishedVersion,
  compareScopedInteractionResolutions,
  nextArtifactVersion,
} from "./interaction-published-ledger.ts";
export {
  DEFAULT_INTERACTION_DRAFT_SOURCE,
  publishRequestSnapshotFromArtifact,
} from "./interaction-registry.ts";

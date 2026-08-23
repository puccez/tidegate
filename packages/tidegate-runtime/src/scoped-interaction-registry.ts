/**
 * Explicit persistence seam for the scoped interaction registry.
 *
 * `ScopedInteractionRegistry` is the executable contract behind every
 * registry backend: the in-memory implementation used by tests and DB-less
 * local dev (`createScopedInteractionRegistry`) and the Drizzle/Postgres
 * implementation the agent app uses in production. Handlers, the published
 * ledger, and the draft/branch workflows depend on this type — never on a
 * concrete backend — so the storage support is interchangeable.
 *
 * Every operation returns `ScopedInteractionRegistryResult<T>` (`T` or
 * `Promise<T>`): the in-memory backend stays synchronous, database-backed
 * backends are async, and every consumer awaits the result either way. A
 * backend is correct iff it passes the conformance suite in
 * `interaction-registry-conformance.ts`.
 */
import type {
  InteractionRecord,
  PublishedInteractionArtifact,
} from "@tidegate/contracts";
import type {
  PublishValidatedInteractionDraftRegistryInput,
  PublishValidatedInteractionDraftResult,
} from "./interaction-draft-publication.ts";
import type {
  CreateInteractionBranchInput,
  CreateInteractionDraftInput,
  CreatePublishedInteractionArtifactVersionInput,
  CreateScopedInteractionRecordInput,
  ListVisibleScopedInteractionsInput,
  MoveActiveInteractionVersionInput,
  PublishInteractionArtifactVersionInput,
  PublishInteractionArtifactVersionResult,
  PublishInteractionBranchDraftArtifactVersionInput,
  PublishInteractionBranchDraftArtifactVersionResult,
  PublishInteractionDraftArtifactVersionInput,
  PublishInteractionDraftArtifactVersionResult,
  RecordInteractionDraftProvenanceInput,
  ResolveInteractionBranchForDraftInput,
  ResolveInteractionBranchInput,
  ResolveInteractionDraftInput,
  ResolveScopedInteractionInput,
  ResolveScopedInteractionVersionInput,
  ResolveVisibleScopedInteractionInput,
  ScopedInteractionBranchResolution,
  ScopedInteractionDraftResolution,
  ScopedInteractionRecordResolution,
  ScopedInteractionResolution,
  SetInteractionAvailabilityStatusInput,
  SetInteractionDraftStatusInput,
  UpdateInteractionDraftSourceInput,
} from "./interaction-registry.ts";

/** `T` for synchronous backends, `Promise<T>` for database-backed ones. */
export type ScopedInteractionRegistryResult<T> = T | Promise<T>;

export type ScopedInteractionRegistry = {
  // Published records and artifact versions.
  createInteractionRecord(
    input: CreateScopedInteractionRecordInput,
  ): ScopedInteractionRegistryResult<InteractionRecord>;
  createArtifactVersion(
    input: CreatePublishedInteractionArtifactVersionInput,
  ): ScopedInteractionRegistryResult<PublishedInteractionArtifact>;
  resolveActiveVersion(
    input: ResolveScopedInteractionInput,
  ): ScopedInteractionRegistryResult<ScopedInteractionResolution | undefined>;
  resolveVersion(
    input: ResolveScopedInteractionVersionInput,
  ): ScopedInteractionRegistryResult<ScopedInteractionResolution | undefined>;
  listVisibleActiveVersions(
    input: ListVisibleScopedInteractionsInput,
  ): ScopedInteractionRegistryResult<ScopedInteractionResolution[]>;
  resolveVisibleInteraction(
    input: ResolveVisibleScopedInteractionInput,
  ): ScopedInteractionRegistryResult<
    ScopedInteractionRecordResolution | undefined
  >;
  moveActiveVersion(
    input: MoveActiveInteractionVersionInput,
  ): ScopedInteractionRegistryResult<InteractionRecord>;
  publishArtifactVersion(
    input: PublishInteractionArtifactVersionInput,
  ): ScopedInteractionRegistryResult<PublishInteractionArtifactVersionResult>;
  setInteractionAvailabilityStatus(
    input: SetInteractionAvailabilityStatusInput,
  ): ScopedInteractionRegistryResult<InteractionRecord>;

  // Drafts.
  createDraft(
    input: CreateInteractionDraftInput,
  ): ScopedInteractionRegistryResult<ScopedInteractionDraftResolution>;
  resolveDraft(
    input: ResolveInteractionDraftInput,
  ): ScopedInteractionRegistryResult<
    ScopedInteractionDraftResolution | undefined
  >;
  updateDraftSource(
    input: UpdateInteractionDraftSourceInput,
  ): ScopedInteractionRegistryResult<ScopedInteractionDraftResolution>;
  setDraftStatus(
    input: SetInteractionDraftStatusInput,
  ): ScopedInteractionRegistryResult<ScopedInteractionDraftResolution>;
  recordDraftProvenance(
    input: RecordInteractionDraftProvenanceInput,
  ): ScopedInteractionRegistryResult<ScopedInteractionDraftResolution>;

  // Branches.
  createBranch(
    input: CreateInteractionBranchInput,
  ): ScopedInteractionRegistryResult<ScopedInteractionBranchResolution>;
  resolveBranch(
    input: ResolveInteractionBranchInput,
  ): ScopedInteractionRegistryResult<
    ScopedInteractionBranchResolution | undefined
  >;
  resolveBranchForDraft(
    input: ResolveInteractionBranchForDraftInput,
  ): ScopedInteractionRegistryResult<
    ScopedInteractionBranchResolution | undefined
  >;

  // Draft/branch publication paths.
  publishDraftArtifactVersion(
    input: PublishInteractionDraftArtifactVersionInput,
  ): ScopedInteractionRegistryResult<PublishInteractionDraftArtifactVersionResult>;
  publishBranchDraftArtifactVersion(
    input: PublishInteractionBranchDraftArtifactVersionInput,
  ): ScopedInteractionRegistryResult<PublishInteractionBranchDraftArtifactVersionResult>;
  publishValidatedInteractionDraft(
    input: PublishValidatedInteractionDraftRegistryInput,
  ): ScopedInteractionRegistryResult<PublishValidatedInteractionDraftResult>;
};

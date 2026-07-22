export type InteractionRegistryErrorCode =
  | "interaction_record_missing"
  | "interaction_branch_exists"
  | "interaction_branch_missing"
  | "interaction_draft_exists"
  | "interaction_draft_missing"
  | "interaction_draft_source_conflict"
  | "branch_base_changed"
  | "interaction_version_exists"
  | "interaction_version_missing"
  | "interaction_version_conflict"
  | "interaction_unavailable"
  | "owner_scope_from_body"
  | "scope_unavailable"
  | "source_hash_collision"
  | "unsafe_interaction_id_reuse";

export class InteractionRegistryError extends Error {
  readonly code: InteractionRegistryErrorCode;

  constructor(code: InteractionRegistryErrorCode, message: string) {
    super(message);
    this.name = "InteractionRegistryError";
    this.code = code;
  }
}

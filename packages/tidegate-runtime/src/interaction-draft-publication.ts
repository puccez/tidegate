import type {
  InteractionBranchPublishTarget,
  PublishInteractionRequest,
} from "@tidegate/contracts";
import type { RuntimeAuthContext } from "./action-catalog.ts";
import type {
  createScopedInteractionRegistry,
  PublishInteractionBranchDraftArtifactVersionResult,
  PublishInteractionDraftArtifactVersionInput,
  PublishInteractionDraftArtifactVersionResult,
  ScopedInteractionBranchResolution,
  ScopedInteractionDraftResolution,
} from "./interaction-registry.ts";

export type InteractionDraftPublicationOptions = {
  publishTarget?: InteractionBranchPublishTarget;
  requestedInteractionId?: string;
  title?: string;
  description?: string;
};

export type InteractionDraftPublicationPlan =
  | {
      branch?: ScopedInteractionBranchResolution;
      ok: true;
      publishTarget?: InteractionBranchPublishTarget;
      validationDraft: ScopedInteractionDraftResolution;
    }
  | {
      ok: false;
      message: string;
      reason:
        | "branch_publish_options_without_branch"
        | "missing_requested_interaction_id"
        | "new_interaction_requires_distinct_id"
        | "same_interaction_requested_id_override";
    };

export type InteractionDraftPublicationRegistry = Pick<
  ReturnType<typeof createScopedInteractionRegistry>,
  | "publishBranchDraftArtifactVersion"
  | "publishDraftArtifactVersion"
  | "setDraftStatus"
>;

export type ValidatedInteractionDraftPublication = {
  artifact: PublishInteractionDraftArtifactVersionInput["artifact"];
  publishRequest: Pick<
    PublishInteractionRequest,
    "description" | "requestedInteractionId" | "title"
  >;
};

export type PublishValidatedInteractionDraftResult =
  | PublishInteractionDraftArtifactVersionResult
  | PublishInteractionBranchDraftArtifactVersionResult;

export type PublishValidatedInteractionDraftRegistryInput = {
  allowReviewerAccess?: boolean;
  auth: RuntimeAuthContext;
  draftId: string;
  now?: Date | string;
  plan: Extract<InteractionDraftPublicationPlan, { ok: true }>;
  publication: ValidatedInteractionDraftPublication;
};

export type PublishValidatedInteractionDraftInput =
  PublishValidatedInteractionDraftRegistryInput & {
    registry: InteractionDraftPublicationRegistry;
  };

export function createInteractionDraftPublicationPlan({
  branch,
  draft,
  options,
}: {
  branch: ScopedInteractionBranchResolution | undefined;
  draft: ScopedInteractionDraftResolution;
  options: InteractionDraftPublicationOptions;
}): InteractionDraftPublicationPlan {
  if (branch === undefined) {
    if (!hasBranchPublishOptions(options)) {
      return {
        ok: true,
        validationDraft: draft,
      };
    }

    return {
      ok: false,
      message:
        "Draft publish target overrides are only available for branch-backed drafts.",
      reason: "branch_publish_options_without_branch",
    };
  }

  const publishTarget = options.publishTarget ?? branch.publishTarget;
  const requestedInteractionId =
    publishTarget === "same-interaction"
      ? branch.source.interactionId
      : (options.requestedInteractionId ?? branch.targetInteractionId);

  if (
    publishTarget === "same-interaction" &&
    options.requestedInteractionId !== undefined &&
    options.requestedInteractionId !== branch.source.interactionId
  ) {
    return {
      ok: false,
      message:
        "A same-interaction branch publish cannot override requestedInteractionId.",
      reason: "same_interaction_requested_id_override",
    };
  }

  if (
    publishTarget === "new-interaction" &&
    (requestedInteractionId === undefined ||
      requestedInteractionId === branch.source.interactionId)
  ) {
    return {
      ok: false,
      message:
        "A new-interaction branch publish requires a requestedInteractionId distinct from the source interaction.",
      reason: "new_interaction_requires_distinct_id",
    };
  }

  if (requestedInteractionId === undefined) {
    return {
      ok: false,
      message: "A branch publish requires a requestedInteractionId.",
      reason: "missing_requested_interaction_id",
    };
  }

  return {
    branch,
    ok: true,
    publishTarget,
    validationDraft: {
      ...draft,
      publishRequest: {
        ...draft.publishRequest,
        requestedInteractionId,
        title: options.title ?? draft.publishRequest.title,
        description: options.description ?? draft.publishRequest.description,
      },
    },
  };
}

export function publishValidatedInteractionDraft({
  allowReviewerAccess,
  auth,
  draftId,
  now,
  plan,
  publication,
  registry,
}: PublishValidatedInteractionDraftInput): PublishValidatedInteractionDraftResult {
  const commonInput = {
    allowReviewerAccess,
    artifact: publication.artifact,
    auth,
    description: publication.publishRequest.description,
    draftId,
    now,
    title: publication.publishRequest.title,
  };
  const published =
    plan.branch === undefined
      ? registry.publishDraftArtifactVersion({
          ...commonInput,
          expectedActiveVersion: null,
        })
      : registry.publishBranchDraftArtifactVersion({
          ...commonInput,
          publishTarget: plan.publishTarget ?? plan.branch.publishTarget,
          requestedInteractionId: publication.publishRequest.requestedInteractionId,
        });

  registry.setDraftStatus({
    allowReviewerAccess,
    auth,
    draftId,
    now,
    status: "publishable",
  });

  return published;
}

function hasBranchPublishOptions(options: InteractionDraftPublicationOptions) {
  return (
    options.publishTarget !== undefined ||
    options.requestedInteractionId !== undefined ||
    options.title !== undefined ||
    options.description !== undefined
  );
}

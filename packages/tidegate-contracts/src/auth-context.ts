import { z } from "zod";

export const TidegateAuthModeSchema = z.enum([
  "api-key",
  "delegated",
  "user",
  "m2m",
  "local-dev",
]);

export const TidegateSubjectTypeSchema = z.enum([
  "user",
  "service_account",
  "api_key",
  "agent",
]);

export const TidegateCredentialTypeSchema = z.enum([
  "api_key",
  "m2m_access_token",
  "oauth_access_token",
  "session",
  "local_dev",
]);

export const TidegateResourceGrantSchema = z.object({
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
  permissions: z.array(z.string().min(1)).default([]),
});

export const TidegateAuthContextSchema = z.object({
  organizationId: z.string().min(1).optional(),
  organizationExternalId: z.string().min(1).optional(),
  subjectId: z.string().min(1).optional(),
  subjectType: TidegateSubjectTypeSchema.optional(),
  subjectExternalId: z.string().min(1).optional(),
  credentialId: z.string().min(1).optional(),
  credentialType: TidegateCredentialTypeSchema.optional(),
  scopes: z.array(z.string().min(1)).default([]),
  authorization: z
    .object({
      permissions: z.array(z.string().min(1)).default([]),
      resourceGrants: z.array(TidegateResourceGrantSchema).default([]),
    })
    .optional(),
  userId: z.string().min(1).optional(),
  workosUserId: z.string().min(1).optional(),
  orgId: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
  salonId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  machineClientId: z.string().min(1).optional(),
  permissions: z.array(z.string().min(1)).default([]),
  authMode: TidegateAuthModeSchema,
});

export type TidegateAuthContext = z.infer<typeof TidegateAuthContextSchema>;

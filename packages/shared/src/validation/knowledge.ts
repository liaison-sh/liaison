// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

export {
  expandKnowledgeSensitivityGrants,
  type KnowledgeSensitivityTier,
  SENSITIVITY_ORDER,
} from "./knowledge-sensitivity"

export const knowledgeSensitivitySchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
])
export const knowledgeReviewStatusSchema = z.enum([
  "unverified",
  "verified",
  "needs_review",
  "stale",
])
export const knowledgeSourceStatusSchema = z.enum([
  "available",
  "partial",
  "unavailable",
  "unauthorized",
  "stale",
  "unsupported",
])
export const knowledgeSourceStateSchema = z.enum([
  "skipped",
  "loading",
  "complete",
  "partial",
  "unavailable",
  "unauthorized",
  "rate-limited",
  "error",
])

const uuidStringSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid UUID")
const uuidArray = z.array(uuidStringSchema).max(500).default([])

export const knowledgeOrgAccessSchema = z.enum(["none", "viewer", "editor"])

const knowledgeDocumentBaseSchema = z.object({
  documentScope: z.enum(["personal", "organization"]),
  title: z.string().trim().min(1).max(240),
  summary: z.string().max(1000).optional().nullable(),
  body: z.string().max(1_000_000).default(""),
  collectionIds: uuidArray,
  ownerUserId: uuidStringSchema.optional(),
  tagNames: z.array(z.string().trim().min(1).max(64)).max(100).default([]),
  team: z.array(z.string().trim().min(1)).max(500).default([]),
  sensitivity: knowledgeSensitivitySchema.default("internal"),
  orgAccess: knowledgeOrgAccessSchema.optional(),
  // Scoped edit: when set, editing the doc additionally requires the caller to hold
  // this EXACT scope (e.g. "clevel") — see has_exact_scope in the 0003 migration and
  // assertCanWriteDocumentRow. `null` clears the gate; `undefined`/omitted leaves it
  // untouched on update.
  editScope: z.string().max(128).nullable().optional(),
  verifyNow: z.boolean().default(false),
  reviewDueAt: z.string().datetime().optional().nullable(),
})

const validatePersonalDocumentDimensions = (
  value: { documentScope?: "personal" | "organization"; collectionIds?: string[]; team?: string[] },
  ctx: z.RefinementCtx,
) => {
  if (value.documentScope !== "personal") return
  if ((value.collectionIds?.length ?? 0) > 0) {
    ctx.addIssue({
      code: "custom",
      message: "Personal documents cannot belong to organization collections",
      path: ["collectionIds"],
    })
  }
  if ((value.team?.length ?? 0) > 0) {
    ctx.addIssue({
      code: "custom",
      message: "Personal documents cannot have team dimensions",
      path: ["team"],
    })
  }
}

export const knowledgeCreateDocumentSchema = knowledgeDocumentBaseSchema.superRefine(
  (value, ctx) => {
    validatePersonalDocumentDimensions(value, ctx)
  },
)

// BC-7: `documentScope` is immutable after create. Strip it from the update
// schema so a forged PATCH cannot flip personal→organization (or vice versa)
// and bypass the dimension floor / sensitivity CHECK.
// A PATCH changes only what it names. `.partial()` keeps the create defaults
// (zod applies a default inside an optional), so a body-only edit used to
// reset sensitivity to internal and clear the team, collections and tags:
// those fields are re-declared here without defaults.
export const knowledgeUpdateDocumentSchema = knowledgeDocumentBaseSchema
  .omit({ documentScope: true })
  .partial()
  .extend({
    body: z.string().max(1_000_000).optional(),
    collectionIds: z.array(uuidStringSchema).max(500).optional(),
    tagNames: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
    team: z.array(z.string().trim().min(1)).max(500).optional(),
    sensitivity: knowledgeSensitivitySchema.optional(),
    verifyNow: z.boolean().optional(),
    revision: z.number().int().nonnegative(),
  })

export const knowledgeVerifyDocumentSchema = z
  .object({ revision: z.number().int().nonnegative() })
  .strict()

export const knowledgeDocumentSharingSchema = z
  .object({
    orgAccess: knowledgeOrgAccessSchema,
    // Scoped edit gate (nullable): null = no scoped-edit restriction on this doc.
    // Superseded by role shares for new UI, kept for backward-compat.
    editScope: z.string().max(128).nullable(),
    shares: z
      .array(z.object({ userId: uuidStringSchema, role: z.enum(["viewer", "editor"]) }))
      .max(200),
    // Per-ROLE ACL (share a doc with an org role as viewer/editor). Optional:
    // OMITTED = leave the doc's role shares unchanged (backward-compatible with
    // pre-role-sharing clients); an ARRAY (even empty) REPLACES them wholesale.
    roleShares: z
      .array(z.object({ roleId: uuidStringSchema, role: z.enum(["viewer", "editor"]) }))
      .max(200)
      .optional(),
  })
  .strict()

export type KnowledgeDocumentSharing = z.infer<typeof knowledgeDocumentSharingSchema>

export const knowledgeFederatedSearchSchema = z.object({
  query: z.string().max(1000).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  mode: z.enum(["blended", "per_source", "both"]).default("blended"),
  sources: z.array(z.string()).max(100).optional(),
  cursors: z.record(z.string(), z.string()).default({}),
  filters: z.record(z.string(), z.unknown()).default({}),
})

// http(s) only — reject javascript:, data:, vbscript:, file:, etc.
// Regex-only validator (not z.string().url()) so the scheme contract does not
// depend on Zod's WHATWG URL parser, which currently accepts non-http schemes.
const httpUrlSchema = z
  .string()
  .regex(/^https?:\/\/\S+$/i, { message: "url must use http or https" })

export const knowledgeLinkRemoteSchema = z.object({
  source: z.string().min(1),
  externalId: z.string().min(1),
  collectionId: uuidStringSchema.optional(),
  title: z.string().trim().min(1).max(240),
  url: httpUrlSchema.optional(),
  summary: z.string().max(1000).optional(),
})

export type KnowledgeCreateDocument = z.infer<typeof knowledgeCreateDocumentSchema>
export type KnowledgeUpdateDocument = z.infer<typeof knowledgeUpdateDocumentSchema>
export type KnowledgeVerifyDocument = z.infer<typeof knowledgeVerifyDocumentSchema>
export type KnowledgeFederatedSearch = z.infer<typeof knowledgeFederatedSearchSchema>
export type KnowledgeLinkRemote = z.infer<typeof knowledgeLinkRemoteSchema>

// ---------------------------------------------------------------------------
// Phase 11 finish: schemas for routes/services that previously type-cast input.
// All schemas are strict so caller-supplied `orgId`/extras are rejected — the
// server derives org context from the actor.
// ---------------------------------------------------------------------------

const trimmedString = (max: number) => z.string().trim().min(1).max(max)

export const knowledgeCollectionSchema = z
  .object({
    name: trimmedString(120),
    description: z.string().max(1000).nullable().optional(),
    parentCollectionId: uuidStringSchema.nullable().optional(),
    ownerUserId: uuidStringSchema.nullable().optional(),
    maintainerUserIds: uuidArray.optional(),
  })
  .strict()

export const knowledgeCollectionPatchSchema = knowledgeCollectionSchema.partial().strict()

export const knowledgeCollectionMembershipSchema = z
  .object({
    targetType: z.enum(["document", "source_link"]),
    targetId: uuidStringSchema,
  })
  .strict()

export const knowledgeTagSchema = z
  .object({
    name: trimmedString(64),
    description: z.string().max(500).nullable().optional(),
  })
  .strict()

export const knowledgeSourcePolicyPatchSchema = z
  .object({
    policy: z.enum(["disabled", "remote_search", "metadata_only", "content_cache"]).optional(),
    connectionMode: z.enum(["selected", "org-owned", "shared"]).optional(),
    broadSearchEnabled: z.boolean().optional(),
    cacheBytes: z.number().int().nonnegative().optional(),
    retainedChunks: z.number().int().nonnegative().optional(),
    retentionDays: z.number().int().nonnegative().optional(),
  })
  .strict()

export const knowledgeSourceLinkVerifySchema = z
  .object({ revision: z.number().int().nonnegative() })
  .strict()

export const knowledgeBacklinkSchema = z.object({
  app: z.string(),
  entityType: z.string(),
  entityId: uuidStringSchema,
  title: z.string(),
  url: z.string().optional(),
})

export type KnowledgeCollection = z.infer<typeof knowledgeCollectionSchema>
export type KnowledgeCollectionPatch = z.infer<typeof knowledgeCollectionPatchSchema>
export type KnowledgeCollectionMembership = z.infer<typeof knowledgeCollectionMembershipSchema>
export type KnowledgeTag = z.infer<typeof knowledgeTagSchema>
export type KnowledgeSourcePolicyPatch = z.infer<typeof knowledgeSourcePolicyPatchSchema>
export type KnowledgeSourceLinkVerify = z.infer<typeof knowledgeSourceLinkVerifySchema>
export type KnowledgeBacklink = z.infer<typeof knowledgeBacklinkSchema>

// ---------------------------------------------------------------------------
// Search hit + source status shared types
// (Mirror of `apps/api/src/apps/knowledge/source-protocol.ts`; pulled into
// shared so the web frontend can stop redeclaring local duplicates — IF-1/IF-2.)
// ---------------------------------------------------------------------------

export type KnowledgeSourceState = z.infer<typeof knowledgeSourceStateSchema>

export interface KnowledgeSourceStatus {
  source: string
  state: KnowledgeSourceState
  retryable: boolean
  message?: string
  cursor?: string
  durationMs?: number
  hitCount?: number
}

export interface KnowledgeSearchHit {
  source: string
  sourceEntityId: string
  title: string
  url?: string
  type?: string
  scope?: string
  snippet?: string
  modifiedAt?: string
  sourceRank?: number
  fusedRank?: number
  badges?: string[]
  canFetchContent?: boolean
  status?: string
  duplicateKeys?: string[]
  cursor?: string
  /** When the hit is a knowledge document mirrored from an external synced
   *  source, the source connector's app name (e.g. "gitlab", "google-drive").
   *  Lets discovery surfaces (search) mark the document's provenance — the
   *  document body is read-only and kept in sync by that connector. */
  syncedSourceApp?: string
}

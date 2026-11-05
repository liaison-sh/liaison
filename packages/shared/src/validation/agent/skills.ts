// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

// kebab-case: starts/ends with lowercase alnum, may contain '-' internally.
const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export const skillNameSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(NAME, "kebab-case required (lowercase alnum + hyphens)")
export const skillDescriptionSchema = z.string().min(1).max(100)
export const skillBodySchema = z.string().min(1).max(100_000)

export const skillVisibilitySchema = z.enum(["personal", "org"])

// Optional routing domain slug (e.g. "shipping", "finance"). Lowercase alnum +
// internal hyphens, 1-40 chars. Drives which kernel:skills:approve holders (by
// their kernel:skills_domain dimension grant) can decide this skill's approvals.
const DOMAIN_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
export const skillDomainSchema = z
  .string()
  .regex(DOMAIN_SLUG, "domain must be a slug: lowercase alnum and hyphens, 1 to 40 chars")

/**
 * When a skill is put in an agent's context WITHOUT a skill_read, the same shape the column
 * `kernel.skills.auto_attach` and an app manifest's `skills.<name>.autoAttach` carry:
 *   keywords  the task words that surface it (one clear match per turn);
 *   apps      the apps that surface it once the conversation uses one of their tools;
 *   owner     always inject its full text into its OWNER agent's context (in app turns and
 *             the MCP connection bound to that agent), within the owner-skill budget.
 * Unknown keys are refused, so a typo is an error rather than a silent no-op.
 */
export const skillAutoAttachSchema = z
  .object({
    keywords: z.array(z.string().min(2)).max(100).optional(),
    apps: z.array(z.string().min(1)).max(100).optional(),
    owner: z.boolean().optional(),
  })
  .strict()
export type SkillAutoAttach = z.infer<typeof skillAutoAttachSchema>

export const createSkillRequestSchema = z.object({
  name: skillNameSchema,
  description: skillDescriptionSchema,
  body: skillBodySchema,
  requiredScopes: z.array(z.string().min(1).max(120)).max(1000).default([]),
  visibility: skillVisibilitySchema,
  domain: skillDomainSchema.optional(),
  // Author this skill FOR a named agent (the agent page's Skills tab, P4c-T32b).
  // Absent → the skill lands on the caller's own personal agent, which is the
  // only behaviour there was before. Present → the create path resolves the
  // agent under the caller's own visibility and applies the A15 write rule (a
  // role or system agent needs `kernel:agents:admin`; a personal agent must be
  // the caller's own; either way the caller's scopes must cover the agent's
  // ceiling). A refusal is an explicit error, never a silent reassignment to
  // the caller's own agent.
  ownerAgentId: z.string().uuid().optional(),
  // Provisioning sets this through the API (it used to need psql). Null clears it.
  autoAttach: skillAutoAttachSchema.nullable().optional(),
})
export type CreateSkillRequest = z.infer<typeof createSkillRequestSchema>

// `ownerAgentId` is omitted alongside `visibility`: moving a skill between
// agents is PATCH /:id (reassignAssetOwner), not a field of the edit form.
// requiredScopes is re-declared WITHOUT the create default: zod applies a
// `.default([])` even under `.partial()`, so an edit that only changes the body
// would silently clear the skill's scopes.
export const updateSkillRequestSchema = createSkillRequestSchema
  .partial()
  .omit({ visibility: true, ownerAgentId: true })
  .extend({ requiredScopes: z.array(z.string().min(1).max(120)).max(1000).optional() })
export type UpdateSkillRequest = z.infer<typeof updateSkillRequestSchema>

export const skillResponseSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  authorUserId: z.string().uuid().nullable(),
  name: skillNameSchema,
  description: skillDescriptionSchema,
  body: skillBodySchema,
  requiredScopes: z.array(z.string()),
  domain: skillDomainSchema.nullable(),
  forkedFrom: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SkillResponse = z.infer<typeof skillResponseSchema>

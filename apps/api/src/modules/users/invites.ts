// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq, isNull } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { invitations, organizations, roleScopeGrants, roles, users } from "~/db/schema/kernel"
import { getSystemEmailProvider, recipientDomain } from "~/infra/email"
import { renderBrandedEmail } from "~/infra/email-layout"
import { generateToken, hashToken } from "~/lib/crypto"
import { env } from "~/lib/env"
import { authLogger as log } from "~/lib/logger"
import { assertSeatRoomSoft } from "~/modules/org/caps"
import { getOrgEmailConfig } from "~/modules/org/email-from"
import { hasScope } from "~/modules/permissions/permissions"
import { actorCoversRoleDimensions } from "~/modules/permissions/roles"

interface CreateInvitationParams {
  orgId: string
  email: string
  /** The target role to grant on accept. Identify it by `roleId` (a real role uuid) OR by
   *  `roleName` — the latter is resolved to the role at EXECUTION time. roleName is what makes
   *  the gated onboarding flow (create_role + invite_user raised in the SAME turn) work: the role
   *  does not exist when the agent raises the invite — it materializes only when the create_role
   *  approval is acted on — so the agent has no uuid to pass yet. Naming the role lets the invite's
   *  own approval resolve it AFTER the role has been created. Exactly one of the two must be set. */
  roleId?: string
  roleName?: string
  invitedBy: string
  actorScopes: string[]
  /** The inviter's own data-visibility grants; the target role may not widen them. */
  actorDimensionGrants: Readonly<Record<string, readonly string[]>>
}

export async function createInvitation(
  db: RlsClient,
  params: CreateInvitationParams,
): Promise<
  | { inviteToken: string; inviteUrl: string }
  | { error: "USER_EXISTS" | "SCOPE_ESCALATION" | "DIMENSION_ESCALATION" | "INVITE_PENDING" }
  | null
> {
  const { orgId, email, roleId, roleName, invitedBy, actorScopes, actorDimensionGrants } = params
  const normalizedEmail = email.toLowerCase()

  // Resolve the target role by uuid OR by name. Name-resolution is org-scoped and runs HERE — at
  // execution (gated-approval) time — so an invite raised alongside a still-pending create_role
  // resolves the freshly-created role once that role's approval has run. A name that matches no
  // role returns null (NOT_FOUND), same as an unknown uuid — never silently invite to "no role".
  const [role] = roleId
    ? await db.select().from(roles).where(eq(roles.id, roleId)).limit(1)
    : roleName
      ? await db
          .select()
          .from(roles)
          .where(and(eq(roles.orgId, orgId), eq(roles.name, roleName)))
          .limit(1)
      : []
  if (!role || role.orgId !== orgId) return null
  // From here on, the role's real id is authoritative (the caller may have passed only a name).
  const resolvedRoleId = role.id

  // Verify the inviting user holds all scopes granted by the target role.
  // Prevents privilege escalation via invitation (e.g., admin without audit:read
  // inviting a user with a role that grants audit:read).
  // Wildcard scope holders can invite any role.
  if (!actorScopes.includes("*")) {
    const targetScopes = await db
      .select({ scope: roleScopeGrants.scope })
      .from(roleScopeGrants)
      .where(eq(roleScopeGrants.roleId, resolvedRoleId))
    for (const { scope } of targetScopes) {
      if (!hasScope(scope, actorScopes)) {
        return { error: "SCOPE_ESCALATION" as const }
      }
    }
  }

  // Data-visibility escalation: holding every scope (or the `*` wildcard scope)
  // does not imply holding every dimension value, so this is checked
  // independently, exactly as assignRole does.
  if (!(await actorCoversRoleDimensions(db, resolvedRoleId, actorDimensionGrants))) {
    return { error: "DIMENSION_ESCALATION" as const }
  }

  const [existing] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, normalizedEmail), eq(users.orgId, orgId)))
    .limit(1)
  if (existing) return { error: "USER_EXISTS" as const }

  // Pre-check for a pending (unaccepted) invitation to the same address so
  // a re-invite attempt surfaces a 409 instead of propagating a 23505 from
  // the unique partial index on (org_id, email) WHERE accepted_at IS NULL.
  const [pendingInvite] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.orgId, orgId),
        eq(invitations.email, normalizedEmail),
        isNull(invitations.acceptedAt),
      ),
    )
    .limit(1)
  if (pendingInvite) return { error: "INVITE_PENDING" as const }

  // Every seat taken (modules/org/caps.ts): refused now, so the admin learns
  // before the invitation goes out. The accept re-checks under the seats lock.
  await assertSeatRoomSoft(db, orgId)

  const token = generateToken()
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  await db.insert(invitations).values({
    orgId,
    email: normalizedEmail,
    roleId: resolvedRoleId,
    tokenHash,
    invitedBy,
    expiresAt,
  })

  log.info({ email: normalizedEmail, invitedBy }, "Invitation created")

  await db.queueEvent({
    app: "kernel",
    entity: "invitation",
    action: "create",
    orgId,
    actorId: invitedBy,
    data: { email: normalizedEmail },
  })

  const inviteUrl = `${env.BASE_URL}/register?token=${token}`

  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  const orgName = (org?.name ?? "Liaison").replace(/[\r\n\t]/g, " ").trim()

  const emailConfig = await getOrgEmailConfig(orgId)
  const subject = `You're invited to ${orgName}`
  const { html, text } = renderBrandedEmail({
    subject,
    eyebrow: "Invitation",
    heading: `Join ${orgName}`,
    paragraphs: [
      `You've been invited to join ${orgName} on Liaison, the workspace for your team's support and communication.`,
      "Click the button below to accept your invitation and set up your account. This invitation expires in 7 days.",
    ],
    cta: { label: "Accept invitation", href: inviteUrl },
    footer: ["If you weren't expecting this invitation, you can safely ignore this email."],
  })
  try {
    await getSystemEmailProvider().send({
      to: normalizedEmail,
      from: emailConfig.from,
      replyTo: emailConfig.replyTo,
      subject,
      html,
      text,
      template: "users.invitation",
    })
  } catch (err) {
    log.error(
      { err, toDomain: recipientDomain(normalizedEmail) },
      "Failed to send invitation email",
    )
  }

  return { inviteToken: token, inviteUrl }
}

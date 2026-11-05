// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Users provisioner (Task 6). Provisions `users[]` in two modes:
 *  - `mode:invite` (default) → `createInvitation` under the admin RLS context
 *    (`ctx.rls`). Idempotent via `createInvitation`'s own `USER_EXISTS` /
 *    `INVITE_PENDING` precheck — never pre-insert.
 *  - `mode:create` → the `ensureUser` primitive (Task 5), idempotent by
 *    `(orgId, lower(email))`.
 *    A re-run that gives an existing user a role they did not hold reports
 *    them under `changed` (their access and their agent's ceiling moved), and
 *    the plan says so (`exists: grant role X`); an identical re-run is unchanged.
 *
 * Handles:
 *  - invite: `withRlsContext` (branded RlsClient) via `ctx.rls` — `createInvitation`
 *    enforces the scope-escalation + pending guards;
 *  - create: `withSystemDb` (inside `ensureUser`).
 *
 * Plan-time validation (`user-roles.ts`): every `role` NAME must exist in the
 * org or be created by this run (a same-file `roles` entry, a new org's default
 * app roles, the roles of an app the file enables). An unknown role →
 * `ConfigError(exitCode:2)` naming it and the valid roles, BEFORE any write.
 * A role of a catalog app that `apps` installs later in the run is resolved by
 * `applyLate`, once every section applied.
 *
 * The `createInvitation` return is a UNION INCLUDING `null` (correction #12). We
 * narrow it EXHAUSTIVELY without a cast: `null` is treated as a runtime error
 * (the role vanished between plan and apply, or another invariant broke).
 */
import { and, eq, inArray, isNull } from "drizzle-orm"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import {
  type ProvisionContext,
  type Provisioner,
  type ProvisionPlan,
  type ProvisionResult,
  resolvePlanOrgId,
} from "~/cli/provisioners/types"
import {
  expectUserRoles,
  orgRoleNames,
  unknownRoleError,
  validateUserRoles,
} from "~/cli/provisioners/user-roles"
import { invitations, roles, userRoles, users } from "~/db/schema/kernel"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { createInvitation } from "~/modules/users/invites"

/** Per-user report entry. Discriminated by `mode`. */
type UserResult =
  | { email: string; mode: "invite"; invited: boolean; inviteUrl?: string }
  | { email: string; mode: "create"; created: boolean; roleGranted: boolean }

interface UsersSection {
  users: UserResult[]
}

export const usersProvisioner: Provisioner<ProvisioningConfig> = {
  key: "users",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const list = config.users
    if (!list || list.length === 0) return { actions: [] }

    // Every role must exist or be created by this run (same-file roles, app
    // roles of a new org's default apps or of apps this file enables);
    // otherwise a ConfigError names it, before any write.
    await validateUserRoles(ctx, config)

    const orgId = await resolvePlanOrgId(ctx, config.org.slug, "cli-users-plan")
    const emails = list.map((u) => u.email.toLowerCase())
    const held =
      orgId !== "" ? await heldRolesByEmail(ctx, orgId, emails) : new Map<string, Set<string>>()
    const pending = orgId !== "" ? await pendingInviteEmails(ctx, orgId, emails) : new Set<string>()
    const actions: string[] = []
    let changes = 0
    // An invite to a member who holds another role is skipped at apply
    // (createInvitation's USER_EXISTS) without being a no-op the person asked
    // for: that plan is not called a diff, so it goes to the approval card.
    let diffed = true
    for (const u of list) {
      const email = u.email.toLowerCase()
      const roles = held.get(email)
      if (roles?.has(u.role)) {
        actions.push(`user '${u.email}' role ${u.role} unchanged`)
        continue
      }
      if (u.mode !== "create") {
        if (roles) {
          diffed = false
          actions.push(
            `user '${u.email}' is already a member: invite skipped, role ${u.role} not granted`,
          )
        } else if (pending.has(email)) {
          actions.push(`user '${u.email}' invite already pending, unchanged`)
        } else {
          changes += 1
          actions.push(`invite user '${u.email}' (role ${u.role})`)
        }
        continue
      }
      changes += 1
      actions.push(
        roles
          ? `user '${u.email}' exists: grant role ${u.role}`
          : `create user '${u.email}' (role ${u.role})`,
      )
    }
    return diffed ? { actions, changes } : { actions }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const list = config.users
    if (!list || list.length === 0) return {}

    // A user whose role this run creates later (a catalog app the `apps`
    // section installs) waits for `applyLate`; any other missing role is
    // refused, naming the valid ones.
    const existing = await orgRoleNames(ctx, ctx.orgId)
    const expected = await expectUserRoles(ctx, config)
    const now: UserEntry[] = []
    const later: UserEntry[] = []
    for (const u of list) {
      if (existing.has(u.role)) now.push(u)
      else if (expected.later.has(u.role) || expected.known.has(u.role)) {
        ctx.log(
          `user '${u.email}': role '${u.role}' is created later in this run, invited after it`,
        )
        later.push(u)
      } else throw unknownRoleError(u.role, u.email, [...existing, ...expected.later])
    }
    deferredUsers.set(ctx, later)
    return provisionUsers(ctx, now)
  },

  async applyLate(ctx): Promise<ProvisionResult> {
    const later = deferredUsers.get(ctx) ?? []
    deferredUsers.delete(ctx)
    if (later.length === 0) return {}
    const existing = await orgRoleNames(ctx, ctx.orgId)
    for (const u of later) {
      if (!existing.has(u.role)) throw unknownRoleError(u.role, u.email, existing)
    }
    return provisionUsers(ctx, later)
  },
}

type UserEntry = NonNullable<ProvisioningConfig["users"]>[number]

/** The role names each of these existing users holds, keyed by lowercased email. */
async function heldRolesByEmail(
  ctx: ProvisionContext,
  orgId: string,
  emails: string[],
): Promise<Map<string, Set<string>>> {
  const rows = await ctx.sys("cli-users-plan-roles", (db) =>
    db
      .select({ email: users.email, role: roles.name })
      .from(users)
      .leftJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.orgId, orgId)))
      .leftJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(eq(users.orgId, orgId), inArray(users.email, emails))),
  )
  const held = new Map<string, Set<string>>()
  for (const r of rows) {
    const set = held.get(r.email) ?? new Set<string>()
    if (r.role !== null) set.add(r.role)
    held.set(r.email, set)
  }
  return held
}

/** Which of these addresses already have an invitation waiting in the org. */
async function pendingInviteEmails(
  ctx: ProvisionContext,
  orgId: string,
  emails: string[],
): Promise<Set<string>> {
  const rows = await ctx.sys("cli-users-plan-invites", (db) =>
    db
      .select({ email: invitations.email })
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, orgId),
          inArray(invitations.email, emails),
          isNull(invitations.acceptedAt),
        ),
      ),
  )
  return new Set(rows.map((r) => r.email))
}

/** Users the apply left for `applyLate`, per run. */
const deferredUsers = new WeakMap<ProvisionContext, UserEntry[]>()

async function provisionUsers(ctx: ProvisionContext, list: UserEntry[]): Promise<ProvisionResult> {
  if (list.length === 0) return {}

  const results: UserResult[] = []
  const changed: string[] = []
  const unchanged: string[] = []

  for (const u of list) {
    if (u.mode === "create") {
      const password = u.password
      if (password === undefined || password.length === 0) {
        // Shape-validated by the schema refine, but narrow defensively (no cast).
        throw new ConfigError(`users: password required to create '${u.email}'`)
      }
      const { created, roleGranted } = await ensureUser({
        orgId: ctx.orgId,
        email: u.email,
        name: u.name,
        password,
        role: u.role,
      })
      ctx.log(
        created
          ? `user '${u.email}' created (role ${u.role})`
          : roleGranted
            ? `user '${u.email}' already exists, role ${u.role} granted`
            : `user '${u.email}' already exists`,
      )
      results.push({ email: u.email, mode: "create", created, roleGranted })
      // A role granted to an existing user is a change (their access and their
      // agent's ceiling moved), not a no-op.
      if (created || roleGranted) changed.push(`users.${u.email}`)
      else unchanged.push(`users.${u.email}`)
      continue
    }

    // mode:invite — createInvitation under the admin RLS context.
    const outcome = await ctx.rls((rls) =>
      createInvitation(rls, {
        orgId: ctx.orgId,
        email: u.email,
        roleName: u.role,
        invitedBy: ctx.actor.userId,
        actorScopes: ctx.actor.scopes,
        actorDimensionGrants: ctx.actor.dimensionGrants,
      }),
    )

    // Exhaustive narrowing of the union (incl. null) — no cast.
    if (outcome === null) {
      // null means the role could not be resolved at apply time (it existed at
      // plan time → a genuine runtime inconsistency) — fail loudly.
      throw new Error(
        `users: createInvitation returned null for '${u.email}' (role '${u.role}' unresolved at apply time)`,
      )
    }
    if ("error" in outcome) {
      if (outcome.error === "SCOPE_ESCALATION" || outcome.error === "DIMENSION_ESCALATION") {
        throw new Error(
          `users: invite for '${u.email}' rejected (${outcome.error} — actor lacks a scope or data grant the role '${u.role}' grants)`,
        )
      }
      // USER_EXISTS or INVITE_PENDING → idempotent no-op.
      ctx.log(`user '${u.email}' already provisioned (${outcome.error}) — invite skipped`)
      results.push({ email: u.email, mode: "invite", invited: false })
      unchanged.push(`users.${u.email}`)
      continue
    }

    // Success — { inviteToken, inviteUrl }.
    ctx.log(`user '${u.email}' invited (role ${u.role})`)
    results.push({
      email: u.email,
      mode: "invite",
      invited: true,
      inviteUrl: outcome.inviteUrl,
    })
    changed.push(`users.${u.email}`)
  }

  const section: UsersSection = { users: results }
  return {
    section,
    ...(changed.length > 0 ? { changed } : {}),
    ...(unchanged.length > 0 ? { unchanged } : {}),
  }
}

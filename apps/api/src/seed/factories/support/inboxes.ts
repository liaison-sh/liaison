// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ticket inboxes and categories factory: written through the tickets
// app's own admin operations (`runAdminOp`), adopted by name on a re-run.
//
// Privileged: the admin operations run on the privileged connection in the
// product too (the tickets admin routes call them after their scope check),
// with a system actor reference naming the org's admin.
import { sql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { SeedContext } from "~/seed/context"
import { rowsOf } from "~/seed/factories/people/actors"

export interface TicketInboxSpec {
  name: string
  /** The team a ticket created in this inbox defaults to. */
  team: string
}

/** What every inbox signs its replies with. */
export interface TicketInboxSender {
  fromDisplayName: string
  replyFromEmail: string
  slaPromisePhrase: string
}

/** Create the API inboxes, or adopt the ones a previous run made. Ids by name. */
export async function ensureTicketInboxes(
  ctx: SeedContext,
  adminUserId: string,
  specs: readonly TicketInboxSpec[],
  sender: TicketInboxSender,
): Promise<Record<string, string>> {
  const { orgId } = ctx
  const actorRef = { actorType: "system" as const, userId: adminUserId }
  return withPrivilegedDb(orgId, "seed-tickets:inboxes", async (tx) => {
    const byName: Record<string, string> = {}
    for (const spec of specs) {
      const found = rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM ${sql.raw(schemaRef("app_tickets"))}.inboxes
              WHERE org_id = ${orgId} AND name = ${spec.name} AND archived_at IS NULL
              LIMIT 1`,
        ),
      )
      if (found[0]) {
        byName[spec.name] = found[0].id
        continue
      }
      // `kind: "api"` is the only inbox a seeder can honestly create: a mailbox
      // inbox must be bound to a real OAuth-connected account whose identifier
      // matches its address, which a seeded org has no way to produce.
      const created = (await runAdminOp(
        tx as never,
        orgId,
        "inboxesCreate",
        {
          name: spec.name,
          kind: "api",
          defaultTeam: spec.team,
          defaultSensitivity: "internal",
          fromDisplayName: sender.fromDisplayName,
          replyFromEmail: sender.replyFromEmail,
          slaPromisePhrase: sender.slaPromisePhrase,
        },
        actorRef,
      )) as { id?: string; error?: { message: string } }
      if (!created.id) {
        throw new Error(`tickets seed: inbox '${spec.name}' refused: ${created.error?.message}`)
      }
      byName[spec.name] = created.id
    }
    // No default-for-create flag is set here, and none can be: the
    // `inboxes_kind_shape_check` constraint reserves that flag for a `mailbox`
    // inbox bound to a real connected account, because a ticket created without
    // an explicit inbox has to stay repliable. Every seeded ticket names its
    // `sourceInboxId` outright, so the fallback is never reached.
    return byName
  })
}

/** Create the topic categories (sort order = position), or adopt them by name. Ids by name. */
export async function ensureTicketCategories(
  ctx: SeedContext,
  adminUserId: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  const { orgId } = ctx
  const actorRef = { actorType: "system" as const, userId: adminUserId }
  return withPrivilegedDb(orgId, "seed-tickets:categories", async (tx) => {
    const byName: Record<string, string> = {}
    for (let i = 0; i < names.length; i++) {
      const name = names[i] as string
      const found = rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM ${sql.raw(schemaRef("app_tickets"))}.categories
              WHERE org_id = ${orgId} AND name = ${name} AND archived_at IS NULL LIMIT 1`,
        ),
      )
      if (found[0]) {
        byName[name] = found[0].id
        continue
      }
      const created = (await runAdminOp(
        tx as never,
        orgId,
        "categoriesCreate",
        { name, sortOrder: i },
        actorRef,
      )) as { id?: string; error?: { message: string } }
      if (!created.id) {
        throw new Error(`tickets seed: category '${name}' refused: ${created.error?.message}`)
      }
      byName[name] = created.id
    }
    return byName
  })
}

/**
 * A mailbox inbox at `emailAddress`, bound to a placeholder account id (a
 * resting row, as the standard tier seeds its inboxes): the admin operation
 * binds a mailbox inbox only to a real OAuth-connected account, which a seeded
 * org cannot produce, and an `api` inbox has no address to reply from.
 * Privileged, named. The ids derive from `key`, so a repeated call adopts the row.
 */
export async function ensureTicketMailboxInbox(
  ctx: SeedContext,
  input: {
    key: string
    name: string
    emailAddress: string
    /**
     * Make it the org's default inbox for new tickets when the org has none yet,
     * through the admin operation the inbox settings call (as `adminUserId`).
     */
    isDefault?: {
      adminUserId: string
      /** Take the flag over from the current default (the settings page's "make default"). */
      replace?: boolean
    }
    /** The connected account the mailbox reads and sends through. Default: a placeholder id. */
    connectedAccountId?: string
    /** The team a ticket arriving here is filed under. */
    defaultTeam?: string | null
    defaultSensitivity?: "internal" | "confidential" | "restricted"
    /** The name replies are signed with. */
    fromDisplayName?: string | null
  },
): Promise<{ id: string; name: string }> {
  const { orgId } = ctx
  const id = ctx.id("ticket-mailbox-inbox", input.key)
  const accountId = input.connectedAccountId ?? ctx.id("ticket-mailbox-inbox-account", input.key)
  const at = ctx.now.toISOString()
  await withPrivilegedDb(orgId, "seed-tickets:mailbox-inbox", (tx) =>
    tx.execute(
      sql`INSERT INTO ${ticketsRel("inboxes")} (
            id, org_id, connected_account_id, name, email_address, default_team,
            default_sensitivity, from_display_name, is_default_for_create, created_at, updated_at
          ) VALUES (${id}::uuid, ${orgId}::uuid, ${accountId}::uuid, ${input.name},
                    ${input.emailAddress}, ${input.defaultTeam ?? null},
                    ${input.defaultSensitivity ?? "internal"}, ${input.fromDisplayName ?? null},
                    false, ${at}, ${at})
          ON CONFLICT (id) DO NOTHING`,
    ),
  )
  const asDefault = input.isDefault
  if (asDefault) {
    await withPrivilegedDb(orgId, "seed-tickets:mailbox-inbox-default", async (tx) => {
      const current = rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM ${ticketsRel("inboxes")}
              WHERE org_id = ${orgId}::uuid AND is_default_for_create = true AND archived_at IS NULL
              LIMIT 1`,
        ),
      )
      if (current[0] && (!asDefault.replace || current[0].id === id)) return
      const updated = (await runAdminOp(
        tx as never,
        orgId,
        "inboxesUpdate",
        { id, isDefaultForCreate: true },
        { actorType: "system", userId: asDefault.adminUserId },
      )) as { error?: { message: string } }
      if (updated.error) {
        throw new Error(
          `tickets seed: default inbox '${input.name}' refused: ${updated.error.message}`,
        )
      }
    })
  }
  return { id, name: input.name }
}

/**
 * The active mail account a seeded mailbox inbox sends through: an org-owned
 * Gmail connection row at `emailAddress`, with a placeholder token (nothing
 * reaches a provider unless the caller sends for real). Pass its id as the
 * inbox's `connectedAccountId`. Privileged; the id derives from `key`, so a
 * repeated call adopts the row.
 */
export async function ensureTicketMailboxAccount(
  ctx: SeedContext,
  input: { key: string; emailAddress: string; createdBy: string },
): Promise<string> {
  const { orgId } = ctx
  const id = ctx.id("ticket-mailbox-inbox-account", input.key)
  await withPrivilegedDb(orgId, "seed-tickets:mailbox-account", (tx) =>
    tx.execute(
      sql`INSERT INTO ${kernelRel("connected_accounts")} (
            id, org_id, app_name, connection_name, owner_type, owner_id, provider_type,
            identifier, status, created_by, access_token_encrypted
          ) VALUES (${id}::uuid, ${orgId}::uuid, 'tickets', 'gmail', 'org', null, 'oauth2',
                    ${input.emailAddress}, 'active', ${input.createdBy}::uuid, 'placeholder')
          ON CONFLICT (id) DO NOTHING`,
    ),
  )
  return id
}

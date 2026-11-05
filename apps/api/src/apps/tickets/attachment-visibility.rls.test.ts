// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Regression: a support-bundle agent (scopes `tickets:tickets:*`, NO
 * `tickets:messages:*`, NO dimension grants — the real shape of the "support"
 * role bundle) must be able to SEE ticket messages and their `kernel.files`
 * attachments under a PLAIN request RLS context.
 *
 * The bug: the generated `messages_rls_select` policy gated on the
 * `tickets:messages` scope family (derived from the physical table name), a
 * scope no role bundle grants. The tickets tool bridge papered over it with
 * the `tickets:tickets:read → tickets:messages:read` scope alias
 * (runtime-helpers.ts), so `tickets:get` LISTED attachments fine — but the
 * kernel file routes (`/api/files/:id/inline`, `/download-url`) run under the
 * raw JWT scopes with no alias, so the `files_select` EXISTS join through
 * `app_tickets.messages` failed and downloads 404'd for every non-admin.
 * Fix: `rlsScope: "tickets"` on the messages entity, so the generated policy
 * gates on the `tickets:tickets` family the bundles actually grant.
 */
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { ensureAppsForOrg, reloadInstalledApps } from "~/modules/apps/init"

/** The "support" role bundle's scopes, verbatim from app.manifest.json. */
const SUPPORT_BUNDLE_SCOPES = [
  "tickets:tickets:read",
  "tickets:tickets:write",
  "tickets:tickets:reply",
  "tickets:approve",
  "tickets:inboxes:read",
  "tickets:categories:read",
]

describe("tickets.attachment-visibility.rls", () => {
  it("support-bundle scopes see messages + message-parented files without the tool-bridge scope alias", async () => {
    const slug = `att-vis-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    let orgId = ""
    let userId = ""
    let ticketId = ""
    let messageId = ""
    let fileId = ""
    await withSystemDb("attachment-visibility-fixture", async (tx) => {
      const orgRows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'Attachment Visibility Org', ${slug})
          RETURNING id
        `),
      )
      orgId = orgRows[0].id
      const userRows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}, ${`att-vis-${slug}@test.com`}, 'Att Visibility', 'active', 'hash', 1, 1)
          RETURNING id
        `),
      )
      userId = userRows[0].id
      // team NULL + sensitivity 'internal' — the default shape of an inbound
      // customer ticket, and exactly the row the bug hid.
      const ticketRows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO app_tickets.tickets (
            id, org_id, handle, subject, status, priority, channel, sensitivity,
            reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
            sla_elapsed_seconds, message_count, created_at, updated_at
          ) VALUES
            (gen_random_uuid(), ${orgId}, ${`ticket-${slug}`}, 'Att Vis', 'open', 'normal', 'email', 'internal', ${`T${slug}`}, 3600, now() + interval '1 hour', now(), 0, 1, now(), now())
          RETURNING id
        `),
      )
      ticketId = ticketRows[0].id
      const messageRows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, from_email, sent_at, created_at)
          VALUES (gen_random_uuid(), ${orgId}, ${ticketId}, 'inbound', ${`cust-${slug}@test.com`}, now(), now())
          RETURNING id
        `),
      )
      messageId = messageRows[0].id
      const fileRows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key)
          VALUES (gen_random_uuid(), ${orgId}, 'tickets', 'message', ${messageId}, 'invoice.pdf', 'application/pdf', 1234, ${`orgs/${orgId}/tickets/message/${messageId}/x/invoice.pdf`})
          RETURNING id
        `),
      )
      fileId = fileRows[0].id
    })
    // Installs the tickets app for the org: regenerates the app RLS policies
    // AND rebuilds the kernel.files SELECT policy from the fileParent registry.
    await ensureAppsForOrg(orgId, {})
    // Registration fills manifestFileParentRegistry; the kernel.files SELECT
    // policy is only rebuilt from it at boot — force the rebuild here.
    await reloadInstalledApps(orgId)

    // Plain request context — raw bundle scopes, NO dimension grants, NO
    // tool-bridge scope aliases. This is what /api/files/:id/inline runs under.
    const actor = {
      actorType: "user" as const,
      userId,
      orgId,
      scopes: SUPPORT_BUNDLE_SCOPES,
      dimensionGrants: {},
    }

    const messageRows = await withRlsContext(actor, async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`SELECT id FROM app_tickets.messages WHERE id = ${messageId}`),
      ),
    )
    expect(messageRows.map((r) => r.id)).toContain(messageId)

    const fileRows = await withRlsContext(actor, async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`SELECT id FROM kernel.files WHERE id = ${fileId}`),
      ),
    )
    expect(fileRows.map((r) => r.id)).toContain(fileId)
  })
})

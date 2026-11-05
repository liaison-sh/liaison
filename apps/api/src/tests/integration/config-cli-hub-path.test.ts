// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration test — the Hub deploy path, end-to-end (spec §8.6). THE headline
 * proof that `config apply` stands up an org whose public ticket-create webhook
 * accepts an api-keyed POST with NO `sourceInboxId` and resolves the default
 * inbox — i.e. a Hub front-end can deliver tickets immediately after deploy.
 *
 * This exercises the EVENT-COUPLED ticket inbox chain for real:
 *
 *   1. `runConfigApply` provisions org + admin + a SUPPLIED api key + an IMAP
 *      `tickets.inboxes` entry marked default. The provisioner inserts a
 *      TICKETS-owned `kernel.connected_accounts` row (queuing
 *      `kernel/connected_account:create`) and polls for the inbox.
 *   2. We drain the outbox CONCURRENTLY (`processOutboxBatch` in a loop) so the
 *      LIVE tickets app's `ticketsOnAccountConnected` fires in-process and creates
 *      the inbox, exactly as the running server's outbox worker would. The
 *      provisioner's poll then resolves and applies the inbox settings.
 *   3. The connection belongs to the tickets app and no Mail app connection
 *      exists: a ticket inbox never rides on a Mail app mailbox.
 *   4. `POST /webhooks/:orgId/tickets/create` with `Authorization: Bearer <key>`
 *      and NO `sourceInboxId` → 200 (NOT 422 inbox_required). A ticket row exists.
 *   5. Re-POST the SAME `externalRef` → idempotent: same ticket id, no duplicate.
 *
 * Driving `processOutboxBatch()` directly (rather than `startOutboxWorker()`)
 * keeps the test deterministic and leaks no `setInterval` timer past the run.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { ticketsSettingsDefaults } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { runConfigApply } from "~/cli/config/apply"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { acquireTestLock, releaseTestLockKeepRows } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLockKeepRows)

/** Narrow `unknown` → `string` by asserting, never casting (no `as`). */
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}: expected string, got ${typeof value}`)
  return value
}

/** Read `data.ticketId` off a parsed webhook response body without a cast. */
function ticketIdOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("data" in body)) return undefined
  const data = Reflect.get(body, "data")
  if (typeof data !== "object" || data === null || !("ticketId" in data)) return undefined
  const id = Reflect.get(data, "ticketId")
  return typeof id === "string" ? id : undefined
}

/** Drain the outbox until `stop()` is set — the in-process stand-in for the
 *  live server's outbox worker, so the tickets app's reactive
 *  `ticketsOnAccountConnected` runs while the provisioner polls for the inbox. */
function startOutboxDrain(): { stop: () => Promise<void> } {
  let running = true
  const loop = (async () => {
    while (running) {
      try {
        await processOutboxBatch()
      } catch {
        // best-effort: a transient failure releases the claim for the next pass.
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  })()
  return {
    stop: async () => {
      running = false
      await loop
    },
  }
}

describe("config apply — Hub end-to-end path (§8.6)", () => {
  test("api-keyed ticket create with no sourceInboxId resolves the default inbox (200 not 422) and is externalRef-idempotent", async () => {
    const suffix = crypto.randomUUID().slice(0, 12)
    const slug = `cli-hub-${suffix}`
    const suppliedKey = `sk-hub-${crypto.randomUUID().replace(/-/g, "")}`
    const address = `support-${suffix}@fabrikam.example`

    const config: ProvisioningConfig = {
      org: { slug, name: "Hub Path Org" },
      admin: {
        email: `admin-${suffix}@fabrikam.example`,
        name: "Hub Admin",
        password: "Hub-Admin-Pw-1!",
      },
      apiKeys: [{ label: "hub-ingest", key: suppliedKey, allowedOrigins: [] }],
      tickets: {
        inboxes: [
          {
            address,
            provider: "imap",
            imap: {
              email: address,
              imapHost: "imap.fabrikam.example",
              imapPort: 993,
              smtpHost: "smtp.fabrikam.example",
              smtpPort: 587,
              username: address,
              password: "imap-app-password-1",
            },
            name: "Support",
            fromDisplayName: "Fabrikam Support",
            default: true,
          },
        ],
      },
    }

    // Drive the outbox concurrently so the tickets connection's reactive inbox
    // creation completes while the provisioner polls.
    const drain = startOutboxDrain()
    let orgId: string
    try {
      const run = await runConfigApply({
        config,
        format: "json",
        dryRun: false,
        validateByok: false,
        echoSupplied: false,
      })
      expect(run.exitCode).toBe(0)
      const orgSection = run.report.sections.org
      const resolvedId =
        orgSection && typeof orgSection === "object" && "id" in orgSection
          ? Reflect.get(orgSection, "id")
          : undefined
      orgId = requireString(resolvedId, "org.id")
    } finally {
      await drain.stop()
    }

    // The connection is owned by the TICKETS app, and the Mail app got nothing.
    const connections = await withPrivilegedDb(orgId, "hub-connections", (tx) =>
      tx.execute(drizzleSql`
        SELECT id, app_name, connection_name FROM kernel.connected_accounts
        WHERE org_id = ${orgId}::uuid AND lower(identifier) = lower(${address})
          AND status = 'active'
      `),
    )
    const connectionRows = extractRows<{ id: string; app_name: string; connection_name: string }>(
      connections,
    )
    expect(connectionRows.map((c) => `${c.app_name}/${c.connection_name}`)).toEqual([
      "tickets/imap",
    ])
    const mailConnections = await withPrivilegedDb(orgId, "hub-mail-connections", (tx) =>
      tx.execute(drizzleSql`
        SELECT id FROM kernel.connected_accounts
        WHERE org_id = ${orgId}::uuid AND app_name = 'mail'
      `),
    )
    expect(extractRows(mailConnections).length).toBe(0)

    // The provisioner's inbox is the DEFAULT one, bound to that tickets
    // connection, with the configured settings applied: the precondition for the
    // api-keyed create resolving an inbox without `sourceInboxId`.
    const defaultInboxes = await withPrivilegedDb(orgId, "hub-default-inbox", (tx) =>
      tx.execute(drizzleSql`
        SELECT id, connected_account_id, name, from_display_name FROM app_tickets.inboxes
        WHERE org_id = ${orgId}::uuid AND is_default_for_create = true AND archived_at IS NULL
      `),
    )
    const defaultInboxRows = extractRows<{
      id: string
      connected_account_id: string
      name: string
      from_display_name: string | null
    }>(defaultInboxes)
    expect(defaultInboxRows.length).toBe(1)
    expect(defaultInboxRows[0]?.connected_account_id).toBe(connectionRows[0]?.id)
    expect(defaultInboxRows[0]?.name).toBe("Support")
    expect(defaultInboxRows[0]?.from_display_name).toBe("Fabrikam Support")

    // tickets:create needs the org's tickets settings (SLA targets). The config
    // CLI does not seed app settings, so seed the defaults the way every tickets
    // integration test does.
    await withSystemDb("hub-tickets-settings", (tx) =>
      tx.execute(drizzleSql`
        UPDATE kernel.organizations
        SET settings = COALESCE(settings, '{}'::jsonb)
          || jsonb_build_object('tickets', ${JSON.stringify(ticketsSettingsDefaults)}::jsonb)
        WHERE id = ${orgId}::uuid
      `),
    )

    const externalRef = `hub-ext-${suffix}`
    const body = {
      subject: "Hub front-end ticket",
      fromEmail: "customer@example.com",
      fromName: "A Customer",
      textBody: "My order has not arrived.",
      externalRef,
      // NOTE: deliberately NO sourceInboxId — the default inbox must resolve.
    }

    // ── POST #1 — must be 200 (NOT 422 inbox_required). ───────────────────
    const res1 = await app.request(`/webhooks/${orgId}/tickets/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${suppliedKey}`,
      },
      body: JSON.stringify(body),
    })
    const json1: unknown = await res1.json()
    // The headline assertion: the default inbox resolved → 200, never 422.
    expect(
      res1.status,
      `expected 200 (default inbox resolves), got ${res1.status}: ${JSON.stringify(json1)}`,
    ).toBe(200)
    expect(res1.status).not.toBe(422)
    const ticketId = requireString(ticketIdOf(json1), "POST#1 data.ticketId")

    // The ticket row exists and is bound to the default inbox.
    const ticketRows = await withPrivilegedDb(orgId, "hub-ticket-row", (tx) =>
      tx.execute(drizzleSql`
        SELECT id, external_ref, source_inbox_id FROM app_tickets.tickets
        WHERE org_id = ${orgId}::uuid AND external_ref = ${externalRef}
      `),
    )
    const ticketRowList = extractRows<{
      id: string
      external_ref: string
      source_inbox_id: string | null
    }>(ticketRows)
    expect(ticketRowList.length).toBe(1)
    expect(ticketRowList[0]?.id).toBe(ticketId)
    expect(ticketRowList[0]?.source_inbox_id).not.toBeNull()

    // ── POST #2 — SAME externalRef → idempotent (same id, no dup). ────────
    const res2 = await app.request(`/webhooks/${orgId}/tickets/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${suppliedKey}`,
      },
      body: JSON.stringify(body),
    })
    const json2: unknown = await res2.json()
    expect(res2.status).toBe(200)
    expect(ticketIdOf(json2)).toBe(ticketId)

    // Exactly ONE ticket carries this externalRef (no duplicate row).
    const dupCount = await withPrivilegedDb(orgId, "hub-ticket-dup", (tx) =>
      tx.execute(drizzleSql`
        SELECT count(*)::int AS n FROM app_tickets.tickets
        WHERE org_id = ${orgId}::uuid AND external_ref = ${externalRef}
      `),
    )
    expect(extractRows<{ n: number }>(dupCount)[0]?.n).toBe(1)
  }, 120_000)
})

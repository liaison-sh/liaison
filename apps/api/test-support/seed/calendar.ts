// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A connected Google Calendar for browser tests, made by the REAL sync engine
// (`~/apps/calendar/sync.ts`, the functions calendar-e2e.test.ts exercises)
// with Google stubbed only at the fixture-pages boundary. Calendar is in-tree
// and registered for every org at boot, so there is no install step.
//
// The OAuth callback writes `kernel.connected_accounts` before the calendar
// subscriber (`onAccountConnected`) runs, and the connections list the
// settings page reads queries that table, so the account row is written here
// first, in the same transaction; `onAccountConnected` then does the
// `calendar:calaccess` dimension-grant bookkeeping a raw insert would miss.
import { sql } from "drizzle-orm"
import { applyInitialSyncPages, onAccountConnected, runCalendarImport } from "~/apps/calendar/sync"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel/connected-accounts"
import { schemaRef } from "~/db/schema-ref"
import type { SeedContext } from "~/seed/context"
import { rowsOf } from "~/seed/factories/people/actors"

export interface CalendarAccountInput {
  /** The person who connects it. */
  userId: string
  ownerType: "org" | "user"
  /** A personal calendar's owner (default: `userId`); ignored for the org's. */
  ownerId?: string | null
  identifier: string
  /** False leaves the calendar without events (the empty state). */
  populate: boolean
}

export interface SeededCalendarAccount {
  accountId: string
  calendarId: string
}

/** Connect, import one calendar and (unless `populate: false`) push an initial-sync page of three events. */
export async function seedCalendarAccount(
  ctx: SeedContext,
  input: CalendarAccountInput,
): Promise<SeededCalendarAccount> {
  const { orgId } = ctx
  return withPrivilegedDb(orgId, "seed-route:calendar-account", async (tx) => {
    const ownerId = input.ownerType === "org" ? null : (input.ownerId ?? input.userId)
    const [row] = await tx
      .insert(connectedAccounts)
      .values({
        orgId,
        appName: "calendar",
        connectionName: "google-calendar",
        ownerType: input.ownerType,
        ownerId,
        providerType: "oauth2",
        identifier: input.identifier,
        displayName: input.identifier,
        status: "active",
        createdBy: input.userId,
      })
      .returning({ id: connectedAccounts.id })
    if (!row) throw new Error("calendar account: connected account not written")

    const connectEvent = {
      orgId,
      actorId: input.userId,
      data: {
        id: row.id,
        appName: "calendar",
        ownerType: input.ownerType,
        ownerId,
        identifier: input.identifier,
        connectionName: "google-calendar",
      },
    }
    const { accountId } = await onAccountConnected(
      tx as never,
      orgId,
      connectEvent as never,
      async () => {},
    )
    const { calendarIds } = await runCalendarImport(
      tx as never,
      orgId,
      accountId,
      async () => [{ id: `gcal-seed-${accountId}`, summary: "Seeded Calendar" }],
      async () => {},
    )
    const calendarId = calendarIds[0]
    if (!calendarId) throw new Error("calendar account: no calendar imported")

    if (input.populate) {
      const now = ctx.now
      const day = (offsetDays: number, hour: number, minute = 0) => {
        const d = new Date(now)
        d.setUTCDate(d.getUTCDate() + offsetDays)
        d.setUTCHours(hour, minute, 0, 0)
        return d.toISOString()
      }
      await applyInitialSyncPages(tx as never, orgId, calendarId, accountId, [
        {
          items: [
            {
              id: `evt-seed-${calendarId}-1`,
              status: "confirmed",
              etag: '"seed-1"',
              summary: "Team Standup",
              start: { dateTime: day(0, 9) },
              end: { dateTime: day(0, 9, 30) },
              updated: now.toISOString(),
            },
            {
              id: `evt-seed-${calendarId}-2`,
              status: "confirmed",
              etag: '"seed-2"',
              summary: "Roadmap Review",
              description: "Quarterly roadmap review with the product team.",
              location: "Meeting Room 2",
              start: { dateTime: day(1, 14) },
              end: { dateTime: day(1, 15) },
              updated: now.toISOString(),
            },
            {
              id: `evt-seed-${calendarId}-3`,
              status: "confirmed",
              etag: '"seed-3"',
              summary: "Design Sync",
              start: { dateTime: day(2, 11) },
              end: { dateTime: day(2, 11, 30) },
              updated: now.toISOString(),
            },
          ],
          nextSyncToken: `seed-tok-${calendarId}`,
        },
      ])
    }
    return { accountId, calendarId }
  })
}

/**
 * The account's sync status set to `reauth-required`, the state a failed push
 * or token refresh leaves (the settings page's reauth banner). Throws when the
 * account is not the org's.
 */
export async function forceCalendarReauth(
  ctx: SeedContext,
  accountId: string,
): Promise<{ ok: true }> {
  const rows = await withPrivilegedDb(ctx.orgId, "seed-route:calendar-reauth", async (tx) =>
    rowsOf<{ id: string }>(
      await tx.execute(
        sql`UPDATE ${sql.raw(`${schemaRef("app_calendar")}.accounts`)}
          SET sync_status = 'reauth-required'
          WHERE id = ${accountId}::uuid AND org_id = ${ctx.orgId}::uuid
          RETURNING id`,
      ),
    ),
  )
  if (rows.length === 0) throw new Error(`calendar account ${accountId} not found`)
  return { ok: true }
}

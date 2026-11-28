// SPDX-License-Identifier: FSL-1.1-ALv2

import type { RsvpResponse, SendUpdates } from "~/apps/calendar/sync"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { hasScope } from "~/modules/permissions/permissions"

/**
 * Whether the caller may manage org calendar connections. Scopes reach the bridge unexpanded:
 * an org admin holds the literal '*' (or 'calendar:*' / 'calendar'), so a literal includes()
 * refused them. hasScope applies the same wildcard and prefix rules as the RLS scope check.
 */
export function isCalendarAdmin(callerScopes: string[] | undefined): boolean {
  return hasScope("calendar:accounts:admin", callerScopes ?? [])
}

/**
 * Calendar create/update-event tools declare `start`/`end` as plain ISO strings in their
 * manifest param schema (matching the frontend's `CreateEventInput`/`UpdateEventInput`), but
 * `~/apps/calendar/sync.ts`'s `createLocalEvent`/`updateLocalEvent` persist the `start`/`end`
 * JSONB columns in Google's `{dateTime}`/`{date}` point shape (the same shape `listEventsForCaller`
 * reads back with `toDate()`). Passing the bare string straight through silently JSON-stringifies
 * it into a scalar JSONB value instead of a point object — `toDate()` then fails to parse it,
 * so the event vanishes from every window-scoped read (list/search) without ever erroring.
 * Converts at the bridge boundary so `sync.ts` always receives the point shape it expects.
 */
function isoStringToCalendarPoint(
  iso: string | undefined,
  allDay: boolean | undefined,
  timeZone?: string | null,
): { dateTime: string; timeZone?: string } | { date: string } | undefined {
  if (!iso) return undefined
  if (allDay) return { date: iso.slice(0, 10) }
  // A timed point names its zone (the calendar's): Google requires it on a recurring event, and
  // the series expands in it, so a weekly 09:00 stays at 09:00 across a daylight saving change.
  return timeZone ? { dateTime: iso, timeZone } : { dateTime: iso }
}

/** The day after a YYYY-MM-DD date. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * The start and end points of an edit. An all-day event's end is exclusive (Google's rule): an
 * end on or before the start day (a one-day event given as start = end) becomes the day after
 * the start, never the empty range Google refuses.
 */
function eventPoints(
  params: { start?: string; end?: string; allDay?: boolean },
  timeZone: string | null | undefined,
): {
  start: ReturnType<typeof isoStringToCalendarPoint>
  end: ReturnType<typeof isoStringToCalendarPoint>
} {
  const start = isoStringToCalendarPoint(params.start, params.allDay, timeZone)
  let end = isoStringToCalendarPoint(params.end, params.allDay, timeZone)
  if (params.allDay && start && "date" in start) {
    if (!end || ("date" in end && end.date <= start.date)) end = { date: nextDay(start.date) }
  }
  return { start, end }
}

/** Google lets an account write only to calendars it owns or may edit. */
const WRITABLE_ACCESS_ROLES = new Set(["owner", "writer"])

/** Refuses a write on a calendar the account may only read (a holiday or a shared calendar):
 * Google would refuse it (403), leaving a local event that never reaches Google. */
function assertWritableCalendar(
  calendar: { id: string; name?: string | null; access_role?: string | null },
  tool: string,
): void {
  const role = calendar.access_role
  if (!role || WRITABLE_ACCESS_ROLES.has(role)) return
  throw Object.assign(
    new Error(
      `${tool}: calendar "${calendar.name ?? calendar.id}" is read-only for this account (access ${role}). Call list_calendars and pick a calendar whose accessRole is owner or writer.`,
    ),
    { status: 422, code: "invalid_params" },
  )
}

/** A person's id, or undefined for a system or agent actor id. */
function personId(userId: string | undefined): string | undefined {
  return userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : undefined
}

/** A create/update carrying a conference change is pushed by the tool handler itself, so the
 * Meet link can be returned; its queued push job waits this long and only acts if that
 * immediate push did not land. */
const CONFERENCE_PUSH_BACKUP_DELAY_MS = 60_000

/** What the calendar surface reads from the run's bridge context. */
export type CalendarBridgeContext = Pick<
  BridgeContext,
  "appName" | "callerScopes" | "orgId" | "requireApp" | "txDb" | "userId"
> &
  // Optional: a harness without a socket fan-out simply announces nothing.
  Partial<Pick<BridgeContext, "queueAppEvent">>

const RSVP_RESPONSES: RsvpResponse[] = ["accepted", "declined", "tentative"]

/** How the calendar surface queues its jobs: the job queue in production; a test harness
 * passes its own queue to run the jobs in process (`apps/calendar/__fixtures__/google`). */
export interface CalendarBridgeDeps {
  enqueue?: typeof enqueueAppJob
}

/** The calendar app surface. */
export function createCalendarMethods(
  ctx: CalendarBridgeContext,
  deps: CalendarBridgeDeps = {},
): Record<string, any> {
  const { callerScopes, orgId, requireApp, txDb, userId } = ctx
  const enqueue = deps.enqueue ?? enqueueAppJob

  /** Whether this calendar's writes reach Google (an active connection): what a write tells the
   * agent, so it never says "synced" or "invited" for a calendar kept in Liaison only. */
  async function reachesGoogle(calendarId: string): Promise<boolean> {
    const { calendarReachesGoogle } = await import("~/apps/calendar/sync")
    const { withPrivilegedDb } = await import("~/db/privileged")
    return withPrivilegedDb(orgId, "calendar-reaches-google", (tx) =>
      calendarReachesGoogle(tx, orgId, calendarId),
    )
  }

  /**
   * Tells the open calendar views that a calendar's events changed (a sync page, a push result,
   * a write by an agent), so a visible week refetches instead of waiting for a navigation. One
   * `calendar/event:changed` frame per write, queued in the write's transaction so it goes out
   * after the commit. It names the calendar and nothing of the events; its `calendar:calaccess`
   * value holds the socket fan-out to the readers of that account, as the rows' RLS does.
   * Deliberately not `event:update`: it names a calendar, not an event, so no event routine
   * keyed on an event fires on it.
   */
  async function announceEventsChanged(ref: { calendarId: string } | { eventId: string }) {
    const { sql } = await import("drizzle-orm")
    const { schemaRef } = await import("~/db/schema-ref")
    const schema = sql.raw(schemaRef("app_calendar"))
    const result = (await txDb.execute(
      "calendarId" in ref
        ? sql`SELECT id AS calendar_id, calaccess FROM ${schema}.calendars
              WHERE org_id = ${orgId}::uuid AND id = ${ref.calendarId}::uuid`
        : sql`SELECT calendar_id, calaccess FROM ${schema}.events
              WHERE org_id = ${orgId}::uuid AND id = ${ref.eventId}::uuid`,
    )) as unknown as { rows?: unknown[] } | unknown[]
    const rows = (Array.isArray(result) ? result : (result.rows ?? [])) as Array<{
      calendar_id: string
      calaccess: string | null
    }>
    const row = rows[0]
    if (!row || !ctx.queueAppEvent) return
    await ctx.queueAppEvent("calendar", "event", "changed", row.calendar_id, {
      calendarId: row.calendar_id,
      ...(row.calaccess ? { "calendar:calaccess": row.calaccess } : {}),
    })
  }

  /** The signed-in person's own address (lowercase), or null (a system caller). */
  let callerEmailCache: Promise<string | null> | undefined
  function callerEmail(): Promise<string | null> {
    callerEmailCache ??= (async () => {
      const caller = personId(userId)
      if (!caller) return null
      const { withPrivilegedDb } = await import("~/db/privileged")
      const { sql } = await import("drizzle-orm")
      const { schemaRef } = await import("~/db/schema-ref")
      return withPrivilegedDb(orgId, "calendar-caller-email", async (tx) => {
        const result = (await tx.execute(
          sql`SELECT email FROM ${sql.raw(schemaRef("kernel"))}.users WHERE id = ${caller}::uuid`,
        )) as unknown as { rows?: unknown[] } | unknown[]
        const rows = (Array.isArray(result) ? result : (result.rows ?? [])) as Array<{
          email: string | null
        }>
        return rows[0]?.email ? rows[0].email.trim().toLowerCase() : null
      })
    })()
    return callerEmailCache
  }

  /** The caller's own guest entry reads as `self`, as Google marks the account's: on a calendar
   * Google does not flag (a Liaison-only one, a team calendar) the person still sees their own
   * invitation and can answer it. Per viewer, never stored. */
  async function markCallerSelf<T>(events: T): Promise<T> {
    const email = await callerEmail()
    if (!email) return events
    const mark = (e: unknown) => {
      const ev = e as { attendees?: Array<{ email?: string; self?: boolean }> } | null
      if (!ev || !Array.isArray(ev.attendees) || ev.attendees.some((a) => a.self === true)) return
      for (const a of ev.attendees) {
        if (typeof a.email === "string" && a.email.trim().toLowerCase() === email) a.self = true
      }
    }
    if (Array.isArray(events)) for (const e of events) mark(e)
    else mark(events)
    return events
  }

  async function accountEmailOf(accountId: string): Promise<string | null> {
    const { getAccountById } = await import("~/apps/calendar/sync")
    const account = await getAccountById(txDb, orgId, accountId)
    return account?.email_address ?? null
  }

  return {
    /** Rows for a company's or a contact's timeline, read under the caller's row security. */
    calendar_activityRead: async (paramsJson: string): Promise<string> => {
      if (ctx.appName !== "calendar")
        throw new Error("calendar_activityRead is only available to the calendar app")
      const { hasScope } = await import("~/modules/permissions/permissions")
      if (!hasScope("calendar:events:read", ctx.callerScopes ?? [])) {
        throw new Error("forbidden: missing scope calendar:events:read")
      }
      const { calendarActivityRows } = await import("~/apps/calendar/activity-source")
      const { withReadOnlySource } = await import("~/modules/contacts/activity")
      const params = JSON.parse(paramsJson)
      return JSON.stringify(
        await withReadOnlySource(ctx.txDb as never, (tx) =>
          calendarActivityRows(tx, ctx.orgId, params),
        ),
      )
    },
    // --- Calendar-specific bridge methods (gated; only meaningful when appName === "calendar") ---
    // Host-side sync logic lives in ~/apps/calendar/*.ts (plain host modules, not sandboxed);
    // these methods are the only seam the calendar app's sandboxed handlers.ts can reach it
    // through — see spec-plan Amendment 1 (calendar is trusted:true but handlers.ts stays a
    // thin sandboxed delegator, mirroring tickets).
    calendar_onAccountConnected: async (eventJson: string): Promise<void> => {
      requireApp("calendar", "calendar_onAccountConnected")
      const { onAccountConnected } = await import("~/apps/calendar/sync")
      const event = JSON.parse(eventJson)
      await onAccountConnected(txDb, orgId, event, async (jobName, payload) => {
        await enqueue("calendar", jobName, payload)
      })
    },

    calendar_grantOrgAccess: async (userId: string): Promise<void> => {
      requireApp("calendar", "calendar_grantOrgAccess")
      const { grantOrgCalendarAccessToUser } = await import("~/apps/calendar/sync")
      await grantOrgCalendarAccessToUser(txDb, orgId, userId)
    },

    calendar_onAccountDisconnected: async (eventJson: string): Promise<void> => {
      requireApp("calendar", "calendar_onAccountDisconnected")
      const { onAccountDisconnected } = await import("~/apps/calendar/sync")
      const event = JSON.parse(eventJson)
      await onAccountDisconnected(txDb, orgId, event)
    },

    calendar_runJob: async (_jobName: string, _payloadJson: string): Promise<void> => {
      requireApp("calendar", "calendar_runJob")
      // calendar-import is handled directly by the sandboxed calendarImport handler (needs
      // ctx.fetch/connections_getToken) via calendar_importCalendars below. Tasks 5-6 fill in
      // push / watch-renewal / poll-fallback here.
    },

    calendar_getCalendar: async (calendarId: string): Promise<string> => {
      requireApp("calendar", "calendar_getCalendar")
      const { getCalendarById } = await import("~/apps/calendar/sync")
      const calendar = await getCalendarById(txDb, orgId, calendarId)
      return JSON.stringify(calendar ?? null)
    },

    calendar_applyInitialSyncPages: async (
      calendarId: string,
      calaccess: string,
      pagesJson: string,
    ): Promise<string> => {
      requireApp("calendar", "calendar_applyInitialSyncPages")
      const { applyInitialSyncPages } = await import("~/apps/calendar/sync")
      const pages = JSON.parse(pagesJson)
      const result = await applyInitialSyncPages(txDb, orgId, calendarId, calaccess, pages)
      if (pages.some((p: { items?: unknown[] }) => (p.items?.length ?? 0) > 0)) {
        await announceEventsChanged({ calendarId })
      }
      return JSON.stringify(result)
    },

    calendar_applyIncrementalSyncPages: async (
      calendarId: string,
      pagesJson: string,
    ): Promise<string> => {
      requireApp("calendar", "calendar_applyIncrementalSyncPages")
      const { applyIncrementalSyncPages } = await import("~/apps/calendar/sync")
      const pages = JSON.parse(pagesJson)
      const result = await applyIncrementalSyncPages(txDb, orgId, calendarId, pages)
      if (pages.some((p: { items?: unknown[] }) => (p.items?.length ?? 0) > 0)) {
        await announceEventsChanged({ calendarId })
      }
      return JSON.stringify(result)
    },

    calendar_recoverFromSyncTokenGone: async (calendarId: string): Promise<void> => {
      requireApp("calendar", "calendar_recoverFromSyncTokenGone")
      const { recoverFromSyncTokenGone } = await import("~/apps/calendar/sync")
      await recoverFromSyncTokenGone(txDb, orgId, calendarId, async (jobName, payload) => {
        await enqueue("calendar", jobName, payload)
      })
      await announceEventsChanged({ calendarId })
    },

    calendar_getAccount: async (accountId: string): Promise<string> => {
      requireApp("calendar", "calendar_getAccount")
      const { getAccountById } = await import("~/apps/calendar/sync")
      const account = await getAccountById(txDb, orgId, accountId)
      return JSON.stringify(account ?? null)
    },

    calendar_importCalendars: async (accountId: string, entriesJson: string): Promise<string> => {
      requireApp("calendar", "calendar_importCalendars")
      const { runCalendarImport } = await import("~/apps/calendar/sync")
      const entries = JSON.parse(entriesJson) as Array<{
        id: string
        summary?: string
        backgroundColor?: string
        timeZone?: string
        accessRole?: string
        primary?: boolean
      }>
      const result = await runCalendarImport(
        txDb,
        orgId,
        accountId,
        async () => entries,
        async (jobName, payload) => {
          await enqueue("calendar", jobName, payload)
        },
      )
      return JSON.stringify(result)
    },

    calendar_recordImportFailure: async (
      accountId: string,
      status: number,
      bodyText: string,
    ): Promise<string> => {
      requireApp("calendar", "calendar_recordImportFailure")
      const { recordCalendarImportFailure } = await import("~/apps/calendar/sync")
      const result = await recordCalendarImportFailure(txDb, orgId, accountId, status, bodyText)
      return JSON.stringify(result)
    },

    calendar_retryImport: async (paramsJson: string): Promise<void> => {
      requireApp("calendar", "calendar_retryImport")
      const { requestCalendarReimport } = await import("~/apps/calendar/sync")
      const params = JSON.parse(paramsJson) as { accountId: string }
      await requestCalendarReimport(
        txDb,
        orgId,
        params.accountId,
        async (jobName, payload) => {
          await enqueue("calendar", jobName, payload)
        },
        {
          isAdmin: isCalendarAdmin(callerScopes),
          userId: userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null,
        },
      )
    },

    calendar_setSelected: async (paramsJson: string): Promise<void> => {
      requireApp("calendar", "calendar_setSelected")
      const { setCalendarSelectedAndSync } = await import("~/apps/calendar/sync")
      const params = JSON.parse(paramsJson) as { calendarId: string; selected: boolean }
      await setCalendarSelectedAndSync(
        txDb,
        orgId,
        params.calendarId,
        params.selected,
        async (jobName, payload) => {
          await enqueue("calendar", jobName, payload)
        },
        {
          isAdmin: isCalendarAdmin(callerScopes),
          userId: userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null,
        },
      )
    },

    calendar_handleWebhook: async (headersJson: string): Promise<void> => {
      requireApp("calendar", "calendar_handleWebhook")
      const { handleGooglePushNotification } = await import("~/apps/calendar/sync")
      const headers = JSON.parse(headersJson) as Record<string, string>
      const channelId = headers["x-goog-channel-id"] ?? headers["X-Goog-Channel-ID"] ?? ""
      const resourceId = headers["x-goog-resource-id"] ?? headers["X-Goog-Resource-ID"] ?? ""
      const state = headers["x-goog-resource-state"] ?? headers["X-Goog-Resource-State"] ?? ""
      if (!channelId || !resourceId) return
      // The handshake Google posts once a channel is created: no change to fetch.
      if (state === "sync") return
      await handleGooglePushNotification(
        txDb,
        orgId,
        channelId,
        resourceId,
        async (jobName, payload, opts) => {
          await enqueue(
            "calendar",
            jobName,
            payload,
            opts ? { jobId: opts.jobId as string } : undefined,
          )
        },
      )
    },

    // The push token for ONE watch channel: HMAC(org push secret, channel id). The DB-less
    // verify seam recomputes it from the channel id Google echoes, so a token learned from
    // (or leaked for) one channel authenticates nothing else, and the org secret itself
    // never leaves the app.
    calendar_channelToken: async (secret: string, channelId: string): Promise<string> => {
      requireApp("calendar", "calendar_channelToken")
      const { createHmac } = await import("node:crypto")
      return createHmac("sha256", secret).update(channelId, "utf8").digest("base64")
    },

    calendar_recordWatchChannel: async (calendarId: string, infoJson: string): Promise<void> => {
      requireApp("calendar", "calendar_recordWatchChannel")
      const { recordWatchChannel } = await import("~/apps/calendar/sync")
      const info = JSON.parse(infoJson)
      await recordWatchChannel(txDb, orgId, calendarId, info)
    },

    calendar_findCalendarsForWatchRenewal: async (withinHours: number): Promise<string> => {
      requireApp("calendar", "calendar_findCalendarsForWatchRenewal")
      const { findCalendarsForWatchRenewal } = await import("~/apps/calendar/sync")
      const rows = await findCalendarsForWatchRenewal(txDb, orgId, withinHours)
      return JSON.stringify(rows)
    },

    calendar_stopWatchChannelOnly: async (calendarId: string, channelId: string): Promise<void> => {
      requireApp("calendar", "calendar_stopWatchChannelOnly")
      const { stopWatchChannelOnly } = await import("~/apps/calendar/sync")
      await stopWatchChannelOnly(txDb, orgId, calendarId, channelId)
    },

    calendar_findCalendarsForPollFallback: async (staleMinutes: number): Promise<string> => {
      requireApp("calendar", "calendar_findCalendarsForPollFallback")
      const { findCalendarsForPollFallback } = await import("~/apps/calendar/sync")
      const rows = await findCalendarsForPollFallback(txDb, orgId, staleMinutes)
      return JSON.stringify(rows)
    },

    calendar_claimSyncPending: async (calendarId: string): Promise<string> => {
      requireApp("calendar", "calendar_claimSyncPending")
      const { claimCalendarSyncPending } = await import("~/apps/calendar/sync")
      return JSON.stringify(await claimCalendarSyncPending(txDb, orgId, calendarId))
    },

    calendar_purgeLongDeselectedEvents: async (): Promise<string> => {
      requireApp("calendar", "calendar_purgeLongDeselectedEvents")
      const { purgeLongDeselectedEvents } = await import("~/apps/calendar/sync")
      return JSON.stringify({ purged: await purgeLongDeselectedEvents(txDb, orgId) })
    },
    calendar_findAccountsForListRefresh: async (): Promise<string> => {
      requireApp("calendar", "calendar_findAccountsForListRefresh")
      const { findAccountsForListRefresh } = await import("~/apps/calendar/sync")
      return JSON.stringify(await findAccountsForListRefresh(txDb, orgId))
    },

    calendar_recordSyncFailure: async (
      calendarId: string,
      operation: string,
      errorKind: string,
      detail: string,
    ): Promise<void> => {
      requireApp("calendar", "calendar_recordSyncFailure")
      const { recordSyncFailure } = await import("~/apps/calendar/sync")
      await recordSyncFailure(txDb, orgId, calendarId, operation, errorKind, detail)
    },

    calendar_markCalendarPolled: async (calendarId: string): Promise<void> => {
      requireApp("calendar", "calendar_markCalendarPolled")
      const { markCalendarPolled } = await import("~/apps/calendar/sync")
      await markCalendarPolled(txDb, orgId, calendarId)
    },

    calendar_listCalendars: async (): Promise<string> => {
      requireApp("calendar", "calendar_listCalendars")
      const { listCalendarsForCaller } = await import("~/apps/calendar/tools")
      const rows = await listCalendarsForCaller(txDb, orgId)
      return JSON.stringify(rows)
    },

    calendar_listAccounts: async (): Promise<string> => {
      requireApp("calendar", "calendar_listAccounts")
      const { listAccountsForCaller } = await import("~/apps/calendar/tools")
      // Ensure-on-read: a calendar connection the caller holds must have its app account row
      // (bound, owned, granted) before the list answers, else the calendar home asks to connect
      // an account Settings shows connected. Privileged: the faulty row may be invisible to the
      // caller. Import jobs are queued after that transaction commits (the job reads the row).
      // A one-SELECT health check runs first: the repair transaction (row locks, upserts) opens
      // only when a row is missing, mis-bound, disconnected, or the caller's grant is absent.
      const { withPrivilegedDb } = await import("~/db/privileged")
      if (userId && /^[0-9a-f-]{36}$/i.test(userId)) {
        const { callerCalendarAccountsNeedRepair, ensureCallerCalendarAccounts } = await import(
          "~/apps/calendar/sync"
        )
        const needsRepair = await withPrivilegedDb(orgId, "calendar-check-accounts", (tx) =>
          callerCalendarAccountsNeedRepair(tx, orgId, userId),
        )
        if (needsRepair) {
          const { jobs } = await withPrivilegedDb(orgId, "calendar-ensure-accounts", (tx) =>
            ensureCallerCalendarAccounts(tx, orgId, userId),
          )
          for (const payload of jobs) await enqueue("calendar", "calendar-import", payload)
        }
      }
      // A disconnect reaches the app through an asynchronous event: catch it up, so the list
      // Settings re-reads right after Disconnect no longer shows the account (one SELECT when
      // nothing is pending). After the rebind above, and never for an address that still has
      // an active connection (a re-auth): that account is kept.
      const { reconcileDisconnectedCalendarAccounts } = await import("~/apps/calendar/sync")
      await withPrivilegedDb(orgId, "calendar-reconcile-disconnected", (tx) =>
        reconcileDisconnectedCalendarAccounts(tx, orgId),
      )
      const rows = await listAccountsForCaller(txDb, orgId)
      return JSON.stringify(rows)
    },

    calendar_listEvents: async (paramsJson: string): Promise<string> => {
      requireApp("calendar", "calendar_listEvents")
      const { listEventsForCaller } = await import("~/apps/calendar/tools")
      const params = JSON.parse(paramsJson) as {
        calendarId?: string
        timeMin: string
        timeMax: string
      }
      const rows = await listEventsForCaller(txDb, orgId, params)
      return JSON.stringify(await markCallerSelf(rows))
    },

    calendar_getEventForCaller: async (eventId: string): Promise<string> => {
      requireApp("calendar", "calendar_getEventForCaller")
      if (!hasScope("calendar:events:read", callerScopes ?? [])) {
        throw new Error("forbidden: missing scope calendar:events:read")
      }
      const { getEventForCaller } = await import("~/apps/calendar/tools")
      return JSON.stringify(await markCallerSelf(await getEventForCaller(txDb, orgId, eventId)))
    },

    /**
     * What `find_free_slots` needs from the host: the caller's own events over the window, their
     * addresses (to read "declined" and "attends"), their zone (profile, else primary calendar),
     * and the personal Google account the free/busy query runs as, with whether its recorded
     * grant holds the free/busy scope (null: the grant was never recorded, so only Google knows).
     */
    calendar_freeBusyContext: async (paramsJson: string): Promise<string> => {
      requireApp("calendar", "calendar_freeBusyContext")
      if (!hasScope("calendar:events:read", callerScopes ?? [])) {
        throw new Error("forbidden: missing scope calendar:events:read")
      }
      const params = JSON.parse(paramsJson) as {
        timeMin: string
        timeMax: string
        /** Guests to look up among the organization's people (their events Liaison holds). */
        attendees?: string[]
      }
      const caller = personId(userId)
      const { withPrivilegedDb } = await import("~/db/privileged")
      const { sql } = await import("drizzle-orm")
      const { schemaRef } = await import("~/db/schema-ref")
      const profile = caller
        ? await withPrivilegedDb(orgId, "calendar-free-busy-profile", async (tx) => {
            const result = (await tx.execute(
              sql`SELECT email, timezone FROM ${sql.raw(schemaRef("kernel"))}.users WHERE id = ${caller}::uuid`,
            )) as unknown as { rows?: unknown[] } | unknown[]
            const rows = (Array.isArray(result) ? result : (result.rows ?? [])) as Array<{
              email: string | null
              timezone: string | null
            }>
            return rows[0] ?? null
          })
        : null
      const { ownBusyEventsForCaller } = await import("~/apps/calendar/tools")
      const selfEmails = new Set<string>()
      if (profile?.email) selfEmails.add(profile.email.toLowerCase())
      // The account addresses are known only after the read; read once, then add them.
      const first = await ownBusyEventsForCaller(txDb, orgId, params, selfEmails)
      for (const a of first.personalAccounts) selfEmails.add(a.identifier.toLowerCase())
      const own =
        first.personalAccounts.length > 0
          ? await ownBusyEventsForCaller(txDb, orgId, params, selfEmails)
          : first
      const account = own.personalAccounts[0] ?? null
      let hasFreeBusyScope: boolean | null = null
      if (account) {
        const { recordedGrant } = await import("~/modules/apps/connections/protected-scopes")
        const grant = await withPrivilegedDb(orgId, "calendar-free-busy-grant", async (tx) => {
          const result = (await tx.execute(
            sql`SELECT metadata FROM ${sql.raw(schemaRef("kernel"))}.connected_accounts
                WHERE id = ${account.connectedAccountId}::uuid AND org_id = ${orgId}::uuid`,
          )) as unknown as { rows?: unknown[] } | unknown[]
          const rows = (Array.isArray(result) ? result : (result.rows ?? [])) as Array<{
            metadata: unknown
          }>
          return rows[0] ? recordedGrant(rows[0].metadata) : "unknown"
        })
        const { FREE_BUSY_SCOPE } = await import("~/apps/calendar/free-slots")
        hasFreeBusyScope = grant === "unknown" ? null : grant.includes(FREE_BUSY_SCOPE)
      }
      // Guests who are people of this organization: the events Liaison already holds for them
      // (on calendars the caller sees) count as busy too, besides Google's free/busy.
      const guestEmails = (Array.isArray(params.attendees) ? params.attendees : [])
        .filter((a): a is string => typeof a === "string" && a.includes("@"))
        .map((a) => a.trim().toLowerCase())
        .filter((a) => !selfEmails.has(a))
        .slice(0, 50)
      const members =
        guestEmails.length > 0
          ? await withPrivilegedDb(orgId, "calendar-free-busy-members", async (tx) => {
              const result = (await tx.execute(
                sql`SELECT lower(email) AS email FROM ${sql.raw(schemaRef("kernel"))}.users
                    WHERE org_id = ${orgId}::uuid AND status = 'active'
                      AND lower(email) IN (${sql.join(
                        guestEmails.map((e) => sql`${e}`),
                        sql.raw(", "),
                      )})`,
              )) as unknown as { rows?: unknown[] } | unknown[]
              return (
                (Array.isArray(result) ? result : (result.rows ?? [])) as Array<{ email: string }>
              ).map((r) => r.email)
            })
          : []
      const { teammateBusyEventsForCaller } = await import("~/apps/calendar/tools")
      const teammates = await teammateBusyEventsForCaller(
        txDb,
        orgId,
        { timeMin: params.timeMin, timeMax: params.timeMax },
        members,
      )
      return JSON.stringify({
        events: own.events,
        teammates,
        selfEmails: [...selfEmails],
        timeZone: profile?.timezone ?? own.primaryTimeZone ?? null,
        account: account ? { identifier: account.identifier, hasFreeBusyScope } : null,
      })
    },

    calendar_searchEvents: async (paramsJson: string): Promise<string> => {
      requireApp("calendar", "calendar_searchEvents")
      const { searchEventsForCaller } = await import("~/apps/calendar/tools")
      const params = JSON.parse(paramsJson) as { query: string; limit?: number }
      const rows = await searchEventsForCaller(txDb, orgId, params.query, params.limit)
      return JSON.stringify(rows)
    },

    calendar_createEvent: async (paramsJson: string): Promise<string> => {
      requireApp("calendar", "calendar_createEvent")
      const { createLocalEvent, getCalendarById } = await import("~/apps/calendar/sync")
      const { isWellFormedEmail, resolveConferenceIntent } = await import("~/apps/calendar/tools")
      const params = JSON.parse(paramsJson) as {
        calendarId: string
        title?: string
        description?: string
        location?: string
        attendees?: string[]
        recurrence?: string[]
        start?: string
        end?: string
        allDay?: boolean
        conference?: string
        sendUpdates?: SendUpdates
      }
      const { conference, location } = resolveConferenceIntent(params, "create")
      for (const email of params.attendees ?? []) {
        if (!isWellFormedEmail(email)) {
          throw new Error(`calendar_createEvent: malformed attendee email "${email}"`)
        }
      }
      const calendar = await getCalendarById(txDb, orgId, params.calendarId)
      if (!calendar) throw new Error(`calendar ${params.calendarId} not found`)
      assertWritableCalendar(calendar, "create_event")
      const points = eventPoints(params, calendar.time_zone)
      const { eventId } = await createLocalEvent(
        txDb,
        orgId,
        params.calendarId,
        calendar.calaccess,
        {
          title: params.title,
          description: params.description,
          location,
          attendees: params.attendees,
          recurrence: params.recurrence,
          allDay: params.allDay,
          start: points.start,
          end: points.end,
          conference,
          sendUpdates: params.sendUpdates,
        },
      )
      // One job per row version: a duplicate request does not push twice. A conference change
      // is pushed by the tool handler right away (to return the Meet link); the job then only
      // backs it up.
      await enqueue(
        "calendar",
        "calendar-push",
        { orgId, eventId },
        {
          jobId: `calendar-push:${eventId}:v1:a0`,
          ...(conference ? { delay: CONFERENCE_PUSH_BACKUP_DELAY_MS } : {}),
        },
      )
      await announceEventsChanged({ eventId })
      return JSON.stringify({
        eventId,
        conference: conference ?? null,
        google: (await reachesGoogle(calendar.id)) ? "syncing" : "not_connected",
      })
    },

    calendar_updateEvent: async (paramsJson: string): Promise<string> => {
      requireApp("calendar", "calendar_updateEvent")
      const { resolveUpdateTarget, updateLocalEvent } = await import("~/apps/calendar/sync")
      const { isWellFormedEmail, resolveConferenceIntent } = await import("~/apps/calendar/tools")
      const params = JSON.parse(paramsJson) as {
        eventId: string
        title?: string
        description?: string
        location?: string
        attendees?: string[]
        recurrence?: string[]
        start?: string
        end?: string
        allDay?: boolean
        conference?: string
        calendarId?: string
        scope?: "occurrence" | "following" | "series"
        occurrenceStart?: string
        sendUpdates?: SendUpdates
      }
      const { conference, location } = resolveConferenceIntent(params, "update")
      for (const email of params.attendees ?? []) {
        if (!isWellFormedEmail(email)) {
          throw new Error(`calendar_updateEvent: malformed attendee email "${email}"`)
        }
      }
      // A recurring meeting needs an explicit scope: one occurrence (its own row, created for
      // Google's instance when needed) or the whole series (the master row).
      const target = await resolveUpdateTarget(txDb, orgId, {
        eventId: params.eventId,
        calendarId: params.calendarId,
        scope: params.scope,
        occurrenceStart: params.occurrenceStart,
        changesRecurrence: params.recurrence !== undefined,
      })
      const { getCalendarById, getEventById, splitSeriesAt } = await import("~/apps/calendar/sync")
      const row = await getEventById(txDb, orgId, target.eventId)
      const calendar = row ? await getCalendarById(txDb, orgId, row.calendar_id) : undefined
      if (calendar) assertWritableCalendar(calendar, "update_event")
      const points = eventPoints(params, calendar?.time_zone)
      const edit = {
        title: params.title,
        description: params.description,
        location,
        attendees: params.attendees,
        recurrence: params.recurrence,
        allDay: params.allDay,
        start: points.start,
        // A start alone on an all-day event keeps its own end (not a one-day default).
        end: params.end !== undefined || params.allDay === undefined ? points.end : undefined,
        conference,
        editorId: personId(userId),
        sendUpdates: params.sendUpdates,
      }
      let scope = target.scope
      if (target.scope === "following" && target.splitAt) {
        // This and the following occurrences: the series ends before this one and a new series
        // with the edit starts there. Both rows are pushed.
        const split = await splitSeriesAt(txDb, orgId, target.eventId, target.splitAt, edit)
        if (split.kind === "split") {
          await enqueue(
            "calendar",
            "calendar-push",
            { orgId, eventId: split.oldEventId },
            { jobId: `calendar-push:${split.oldEventId}:v${split.oldSyncVersion}:a0` },
          )
          const newEventId = split.newEventId as string
          await enqueue(
            "calendar",
            "calendar-push",
            { orgId, eventId: newEventId },
            {
              jobId: `calendar-push:${newEventId}:v1:a0`,
              ...(conference ? { delay: CONFERENCE_PUSH_BACKUP_DELAY_MS } : {}),
            },
          )
          await announceEventsChanged({ eventId: newEventId })
          return JSON.stringify({
            eventId: newEventId,
            scope: "following",
            previousSeriesId: split.oldEventId,
            conference: conference ?? null,
            ...(calendar
              ? { google: (await reachesGoogle(calendar.id)) ? "syncing" : "not_connected" }
              : {}),
          })
        }
        scope = "series"
      }
      const eventId = target.eventId
      const { syncVersion } = await updateLocalEvent(txDb, orgId, eventId, edit)
      await enqueue(
        "calendar",
        "calendar-push",
        { orgId, eventId },
        {
          jobId: `calendar-push:${eventId}:v${syncVersion}:a0`,
          ...(conference ? { delay: CONFERENCE_PUSH_BACKUP_DELAY_MS } : {}),
        },
      )
      await announceEventsChanged({ eventId })
      return JSON.stringify({
        eventId,
        ...(scope ? { scope } : {}),
        conference: conference ?? null,
        ...(calendar
          ? { google: (await reachesGoogle(calendar.id)) ? "syncing" : "not_connected" }
          : {}),
      })
    },

    calendar_deleteEvent: async (paramsJson: string): Promise<string> => {
      requireApp("calendar", "calendar_deleteEvent")
      const { deleteLocalEvent, resolveUpdateTarget } = await import("~/apps/calendar/sync")
      const params = JSON.parse(paramsJson) as {
        eventId: string
        calendarId?: string
        scope?: "occurrence" | "following" | "series"
        occurrenceStart?: string
        sendUpdates?: SendUpdates
      }
      // A recurring meeting needs an explicit scope, as for update_event: one occurrence (Google
      // cancels that instance only), this and the following ones (the series ends before it),
      // or the whole series (the master is deleted).
      const { splitSeriesAt } = await import("~/apps/calendar/sync")
      let target: Awaited<ReturnType<typeof resolveUpdateTarget>>
      try {
        target = await resolveUpdateTarget(txDb, orgId, { ...params, tool: "delete_event" })
      } catch (err) {
        // Already gone (a repeated delete): nothing to do, as before.
        if ((err as { status?: number }).status === 404) {
          return JSON.stringify({ eventId: params.eventId, needsGooglePush: false, notFound: true })
        }
        throw err
      }
      const eventId = target.eventId
      {
        const { getCalendarById, getEventById } = await import("~/apps/calendar/sync")
        const row = await getEventById(txDb, orgId, eventId)
        const calendar = row ? await getCalendarById(txDb, orgId, row.calendar_id) : undefined
        if (calendar) assertWritableCalendar(calendar, "delete_event")
      }
      if (target.exdate) {
        // One occurrence of a series Google does not have yet: it leaves the series' rule.
        const { getEventById, updateLocalEvent } = await import("~/apps/calendar/sync")
        const row = await getEventById(txDb, orgId, eventId)
        const lines = Array.isArray(row?.recurrence) ? (row.recurrence as string[]) : []
        const day = target.exdate.toISOString()
        const exdate = row?.all_day
          ? `EXDATE;VALUE=DATE:${day.slice(0, 10).replace(/-/g, "")}`
          : `EXDATE:${day.slice(0, 19).replace(/[-:]/g, "")}Z`
        const { syncVersion } = await updateLocalEvent(txDb, orgId, eventId, {
          recurrence: [...lines, exdate],
          editorId: personId(userId),
        })
        await enqueue(
          "calendar",
          "calendar-push",
          { orgId, eventId },
          { jobId: `calendar-push:${eventId}:v${syncVersion}:a0` },
        )
        await announceEventsChanged({ eventId })
        return JSON.stringify({ eventId, scope: "occurrence", needsGooglePush: true })
      }
      if (target.scope === "following" && target.splitAt) {
        const split = await splitSeriesAt(txDb, orgId, eventId, target.splitAt, null, {
          sendUpdates: params.sendUpdates,
        })
        if (split.kind === "split") {
          await enqueue(
            "calendar",
            "calendar-push",
            { orgId, eventId: split.oldEventId },
            { jobId: `calendar-push:${split.oldEventId}:v${split.oldSyncVersion}:a0` },
          )
          await announceEventsChanged({ eventId: split.oldEventId })
          return JSON.stringify({ eventId, scope: "following", needsGooglePush: true })
        }
        // From the first occurrence on: the whole series goes.
        target = { eventId, scope: "series" }
      }
      // An event Google has (or may have: a create in flight) becomes a tombstone that the push
      // deletes on Google, retrying like any push; the import cannot resurrect it meanwhile.
      const { needsGooglePush, syncVersion } = await deleteLocalEvent(txDb, orgId, eventId, {
        sendUpdates: params.sendUpdates,
      })
      if (needsGooglePush && syncVersion !== null) {
        await enqueue(
          "calendar",
          "calendar-push",
          { orgId, eventId },
          { jobId: `calendar-push:${eventId}:v${syncVersion}:a0` },
        )
      }
      await announceEventsChanged({ eventId })
      return JSON.stringify({
        eventId,
        ...(target.scope ? { scope: target.scope } : {}),
        needsGooglePush,
      })
    },

    calendar_respondToEvent: async (paramsJson: string): Promise<string> => {
      requireApp("calendar", "calendar_respondToEvent")
      const { getCalendarById, getEventById, resolveUpdateTarget, updateLocalEvent } = await import(
        "~/apps/calendar/sync"
      )
      const params = JSON.parse(paramsJson) as {
        eventId: string
        response: string
        calendarId?: string
        scope?: "occurrence" | "series"
        occurrenceStart?: string
      }
      if (!RSVP_RESPONSES.includes(params.response as RsvpResponse)) {
        throw Object.assign(
          new Error(`response must be one of ${RSVP_RESPONSES.join(", ")} (yes, no, maybe).`),
          { status: 422, code: "invalid_params" },
        )
      }
      const response = params.response as RsvpResponse
      const target = await resolveUpdateTarget(txDb, orgId, {
        eventId: params.eventId,
        calendarId: params.calendarId,
        scope: params.scope,
        occurrenceStart: params.occurrenceStart,
        tool: "respond_to_invitation",
      })
      const row = await getEventById(txDb, orgId, target.eventId)
      if (!row) throw new Error(`calendar event ${params.eventId} not found`)
      // The account's own entry is the attendee Google marks `self`; else the account's address.
      const calendar = await getCalendarById(txDb, orgId, row.calendar_id)
      const accountEmail = calendar ? await accountEmailOf(calendar.account_id) : null
      const attendees = Array.isArray(row.attendees)
        ? (row.attendees as Array<Record<string, unknown>>)
        : []
      const isAccount = (a: Record<string, unknown>) =>
        a.self === true ||
        (accountEmail !== null &&
          typeof a.email === "string" &&
          a.email.toLowerCase() === accountEmail.toLowerCase())
      // Else the signed-in person's own entry (a calendar Google does not flag for them).
      const own = attendees.some(isAccount) ? null : await callerEmail()
      const isCaller = (a: Record<string, unknown>) =>
        own !== null && typeof a.email === "string" && a.email.trim().toLowerCase() === own
      const isSelf = (a: Record<string, unknown>) => isAccount(a) || isCaller(a)
      if (!attendees.some(isSelf)) {
        throw Object.assign(
          new Error(
            `${row.title ? `"${row.title}"` : "This event"} has no invitation for this calendar's account to answer: only a guest can reply yes, no or maybe.`,
          ),
          { status: 422, code: "not_a_guest" },
        )
      }
      // Only the account's entry is stored as `self` (what Google means by it); a person's own
      // entry on a shared calendar keeps no flag, so it does not read as every viewer's.
      const next = attendees.map((a) =>
        isAccount(a)
          ? { ...a, self: true, responseStatus: response }
          : isCaller(a)
            ? { ...a, responseStatus: response }
            : a,
      )
      const { syncVersion } = await updateLocalEvent(txDb, orgId, row.id, {
        attendees: next,
        rsvp: response,
        editorId: personId(userId),
      })
      await enqueue(
        "calendar",
        "calendar-push",
        { orgId, eventId: row.id },
        { jobId: `calendar-push:${row.id}:v${syncVersion}:a0` },
      )
      await announceEventsChanged({ eventId: row.id })
      return JSON.stringify({
        eventId: row.id,
        response,
        ...(target.scope ? { scope: target.scope } : {}),
      })
    },

    calendar_restoreRefusedDelete: async (
      eventId: string,
      message: string,
      syncVersion: number,
      remoteJson: string,
    ): Promise<string> => {
      requireApp("calendar", "calendar_restoreRefusedDelete")
      const { restoreRefusedDelete } = await import("~/apps/calendar/sync")
      const restored = await restoreRefusedDelete(
        txDb,
        orgId,
        eventId,
        message,
        syncVersion,
        JSON.parse(remoteJson || "null"),
      )
      await announceEventsChanged({ eventId })
      return JSON.stringify(restored)
    },

    calendar_finalizeRemoteDelete: async (eventId: string): Promise<void> => {
      requireApp("calendar", "calendar_finalizeRemoteDelete")
      const { finalizeRemoteDelete } = await import("~/apps/calendar/sync")
      await finalizeRemoteDelete(txDb, orgId, eventId)
    },

    calendar_getEvent: async (eventId: string): Promise<string> => {
      requireApp("calendar", "calendar_getEvent")
      const { getEventById } = await import("~/apps/calendar/sync")
      const event = await getEventById(txDb, orgId, eventId)
      return JSON.stringify(event ?? null)
    },

    calendar_applyPushResult: async (eventId: string, resultJson: string): Promise<string> => {
      requireApp("calendar", "calendar_applyPushResult")
      const { applyPushResult, pendingOccurrencesOf } = await import("~/apps/calendar/sync")
      const result = JSON.parse(resultJson)
      const applied = await applyPushResult(txDb, orgId, eventId, result)
      // A series that just reached Google: the occurrences edited before it did push now.
      for (const pending of await pendingOccurrencesOf(txDb, orgId, eventId)) {
        await enqueue(
          "calendar",
          "calendar-push",
          { orgId, eventId: pending.id },
          { jobId: `calendar-push:${pending.id}:v${pending.version}:after-series` },
        )
      }
      await announceEventsChanged({ eventId })
      return JSON.stringify(applied)
    },

    calendar_handlePushConflict: async (eventId: string, inputJson: string): Promise<string> => {
      requireApp("calendar", "calendar_handlePushConflict")
      const { handlePushConflict } = await import("~/apps/calendar/sync")
      const input = JSON.parse(inputJson)
      const result = await handlePushConflict(txDb, orgId, eventId, input)
      return JSON.stringify(result)
    },

    calendar_findStalePendingPushes: async (staleMinutes: number): Promise<string> => {
      requireApp("calendar", "calendar_findStalePendingPushes")
      const { findStalePendingPushes } = await import("~/apps/calendar/sync")
      return JSON.stringify(await findStalePendingPushes(txDb, orgId, staleMinutes))
    },

    calendar_applyRemoteDeletion: async (eventId: string, syncVersion: number): Promise<void> => {
      requireApp("calendar", "calendar_applyRemoteDeletion")
      const { applyRemoteDeletion } = await import("~/apps/calendar/sync")
      await applyRemoteDeletion(txDb, orgId, eventId, syncVersion)
    },

    calendar_markPushRejected: async (
      eventId: string,
      message: string,
      syncVersion: number,
    ): Promise<void> => {
      requireApp("calendar", "calendar_markPushRejected")
      const { markPushRejected } = await import("~/apps/calendar/sync")
      await markPushRejected(txDb, orgId, eventId, message, syncVersion)
      await announceEventsChanged({ eventId })
    },

    calendar_notePushFailure: async (eventId: string, syncVersion: number): Promise<string> => {
      requireApp("calendar", "calendar_notePushFailure")
      const { notePushFailure } = await import("~/apps/calendar/sync")
      return JSON.stringify(await notePushFailure(txDb, orgId, eventId, syncVersion))
    },

    calendar_revertToRemote: async (
      eventId: string,
      remoteJson: string,
      detail: string,
      syncVersion: number,
    ): Promise<void> => {
      requireApp("calendar", "calendar_revertToRemote")
      const { revertEventToGoogle } = await import("~/apps/calendar/sync")
      await revertEventToGoogle(txDb, orgId, eventId, JSON.parse(remoteJson), detail, syncVersion)
      await announceEventsChanged({ eventId })
    },

    calendar_recordPushFailure: async (
      eventId: string,
      calendarId: string,
      errorKind: string,
      detail: string,
    ): Promise<void> => {
      requireApp("calendar", "calendar_recordPushFailure")
      const { recordPushFailure } = await import("~/apps/calendar/sync")
      await recordPushFailure(txDb, orgId, eventId, calendarId, errorKind, detail)
    },
  }
}

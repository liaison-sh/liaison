// SPDX-License-Identifier: FSL-1.1-ALv2
// `calendar.event` imports an ICS file into a local "Imported" calendar of an
// account of the importing person that no connection backs: it is created once
// and reused, granted to that person only, and never synced. Nothing is pushed to
// Google, no sync entry point picks it up, and the reconciler never purges it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  findCalendarsForPollFallback,
  findCalendarsForWatchRenewal,
  findStalePendingPushes,
  grantOrgCalendarAccessToUser,
  reconcileDisconnectedCalendarAccounts,
} from "~/apps/calendar/sync"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { runImport } from "~/modules/imports/runner"
import { importServiceClient } from "~/modules/imports/service-client"
import { undoImportRun } from "~/modules/imports/undo"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let adminId = ""
const tmpDirs: string[] = []
const tag = () => crypto.randomUUID().slice(0, 8)

function admin(): UserContext {
  return {
    actorType: "user",
    userId: adminId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
}

function icsFile(body: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ics-import-"))
  tmpDirs.push(dir)
  const path = join(dir, "calendar.ics")
  writeFileSync(path, ["BEGIN:VCALENDAR", "VERSION:2.0", ...body, "END:VCALENDAR"].join("\r\n"))
  return path
}

const event = (uid: string, start: string, summary: string, extra: string[] = []) => [
  "BEGIN:VEVENT",
  `UID:${uid}`,
  `DTSTART:${start}`,
  "DURATION:PT1H",
  `SUMMARY:${summary}`,
  ...extra,
  "END:VEVENT",
]

function importIcs(path: string, label: string, calendarName?: string) {
  return runImport({
    orgId,
    actor: admin(),
    kinds: ["calendar.event"],
    source: { type: "path", path, format: "ics" },
    sourceLabel: label,
    mode: "cli",
    ...(calendarName ? { kindOptions: { "calendar.event": { calendarName } } } : {}),
  })
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `imp-cal-${tag()}`, name: "Calendar Import" })).orgId
  adminId = (
    await ensureUser({
      orgId,
      email: `owner-${tag()}@fabrikam.example`,
      name: "Owner",
      password: "pw-import-1!",
      role: "admin",
    })
  ).userId
  await ensureAppsForOrg(orgId)
}, 300_000)

async function mkUser(role: string): Promise<string> {
  return (
    await ensureUser({
      orgId,
      email: `${role}-${tag()}@fabrikam.example`,
      name: role,
      password: "pw-import-1!",
      role: "admin",
    })
  ).userId
}

afterAll(async () => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  await releaseTestLock()
})

describe("calendar.event (ICS)", () => {
  it("imports into an Imported calendar it creates once, granted to the importer; a re-run skips", async () => {
    const label = `ics${tag()}`
    const path = icsFile([
      ...event("a@ex", "20250310T090000Z", "Review", ["RRULE:FREQ=WEEKLY;COUNT=4"]),
      ...event("b@ex", "20250311T090000Z", "Planning", [
        "ATTENDEE;CN=Ann:mailto:ann@fabrikam.example",
      ]),
    ])
    const first = await importIcs(path, label, `Archive ${label}`)
    expect(first.counts["calendar.event"]).toEqual({ created: 2, skipped: 0, failed: 0 })

    const [account] = await sql`
      SELECT id, owner_type, owner_id, sync_status, email_address, display_name, connected_account_id
      FROM app_calendar.accounts WHERE org_id = ${orgId} AND display_name = ${`Archive ${label}`}`
    // The importer's own: a personal account, never fanned out to the org.
    expect([account!.owner_type, account!.owner_id, account!.sync_status]).toEqual([
      "user",
      adminId,
      "imported",
    ])
    expect(String(account!.email_address)).toContain(adminId)
    expect(String(account!.email_address)).toEndWith("@calendar.invalid")
    const conn =
      await sql`SELECT 1 FROM kernel.connected_accounts WHERE id = ${account!.connected_account_id}`
    expect(conn.length).toBe(0)
    const [calendar] = await sql`
      SELECT id, google_calendar_id, selected, calaccess FROM app_calendar.calendars
      WHERE account_id = ${account!.id}`
    expect(String(calendar!.google_calendar_id)).toStartWith("local:")
    expect(calendar!.selected).toBe(false)
    expect(calendar!.calaccess).toBe(String(account!.id))
    const [grant] = await sql`
      SELECT dimension_values FROM kernel.user_dimension_grants
      WHERE user_id = ${adminId} AND dimension_key = 'calendar:calaccess'`
    expect(grant!.dimension_values as string[]).toContain(String(account!.id))

    const events = await sql`
      SELECT title, pending_push, google_event_id, recurrence, attendees, external_ref, calaccess
      FROM app_calendar.events WHERE calendar_id = ${calendar!.id} ORDER BY title`
    expect(events.map((e) => [e.title, e.pending_push, e.google_event_id, e.external_ref])).toEqual(
      [
        ["Planning", "none", null, `${label}:b@ex`],
        ["Review", "none", null, `${label}:a@ex`],
      ],
    )
    expect(events[1]!.recurrence).toEqual(["RRULE:FREQ=WEEKLY;COUNT=4"])
    expect(events[0]!.attendees).toEqual([{ email: "ann@fabrikam.example", displayName: "Ann" }])

    const again = await importIcs(path, label, `Archive ${label}`)
    expect(again.counts["calendar.event"]).toEqual({ created: 0, skipped: 2, failed: 0 })
    const accounts = await sql`
      SELECT 1 FROM app_calendar.accounts WHERE org_id = ${orgId} AND display_name = ${`Archive ${label}`}`
    expect(accounts.length).toBe(1)
  })

  it("no sync entry point picks the imported calendar up, and the reconciler keeps it", async () => {
    const label = `sy${tag()}`
    const run = await importIcs(
      icsFile(event("c@ex", "20250312T090000Z", "Sync check")),
      label,
      `Quiet ${label}`,
    )
    expect(run.counts["calendar.event"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const [account] = await sql`
      SELECT id FROM app_calendar.accounts WHERE org_id = ${orgId} AND display_name = ${`Quiet ${label}`}`
    // Even a calendar someone selected, with an event owed to Google, stays out.
    await sql`UPDATE app_calendar.calendars SET selected = true WHERE account_id = ${account!.id}`
    await sql`
      UPDATE app_calendar.events SET pending_push = 'update', updated_at = now() - interval '1 day'
      WHERE calendar_id IN (SELECT id FROM app_calendar.calendars WHERE account_id = ${account!.id})`
    await withPrivilegedDb(orgId, "t", async (tx) => {
      const db = importServiceClient(tx)
      const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id)
      const [cal] =
        await sql`SELECT id FROM app_calendar.calendars WHERE account_id = ${account!.id}`
      expect(ids(await findCalendarsForPollFallback(db, orgId, 0))).not.toContain(cal!.id)
      expect(ids(await findCalendarsForWatchRenewal(db, orgId, 10_000))).not.toContain(cal!.id)
      expect((await findStalePendingPushes(db, orgId, 1)).length).toBe(0)
      expect(await reconcileDisconnectedCalendarAccounts(db, orgId)).not.toContain(account!.id)
    })
    const kept = await sql`SELECT sync_status FROM app_calendar.accounts WHERE id = ${account!.id}`
    expect(kept[0]!.sync_status).toBe("imported")
  })

  it("undo of the first run keeps the calendar once a second run added events to it", async () => {
    const label = `ud${tag()}`
    const name = `Kept ${label}`
    const first = await importIcs(icsFile(event("d@ex", "20250313T090000Z", "One")), label, name)
    const second = await importIcs(icsFile(event("e@ex", "20250314T090000Z", "Two")), label, name)
    expect(second.counts["calendar.event"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const report = await undoImportRun(orgId, first.runId, { userId: adminId })
    expect(report.refused.map((r) => [r.table, r.reason])).toContainEqual([
      "app_calendar.calendars",
      "has_new_children",
    ])
    const left = await sql`
      SELECT e.title FROM app_calendar.events e JOIN app_calendar.calendars c ON c.id = e.calendar_id
      JOIN app_calendar.accounts a ON a.id = c.account_id WHERE a.display_name = ${name}
      ORDER BY e.title`
    expect(left.map((r) => r.title)).toEqual(["One", "Two"])
  })

  it("an imported calendar stays private: a later member and a second importer do not see it", async () => {
    const label = `pv${tag()}`
    const name = `Private ${label}`
    await importIcs(icsFile(event("p@ex", "20250315T090000Z", "Mine")), label, name)
    const [mine] = await sql`
      SELECT id FROM app_calendar.accounts WHERE org_id = ${orgId} AND owner_id = ${adminId}
        AND display_name = ${name}`
    const grantsOf = async (userId: string) =>
      (
        await sql`
          SELECT dimension_values FROM kernel.user_dimension_grants
          WHERE user_id = ${userId} AND org_id = ${orgId} AND dimension_key = 'calendar:calaccess'`
      ).flatMap((r) => r.dimension_values as string[])

    const late = await mkUser("late")
    await withPrivilegedDb(orgId, "t", (tx) =>
      grantOrgCalendarAccessToUser(importServiceClient(tx), orgId, late),
    )
    expect(await grantsOf(late)).not.toContain(String(mine!.id))

    const second = await mkUser("second")
    const run = await runImport({
      orgId,
      actor: { ...admin(), userId: second },
      kinds: ["calendar.event"],
      source: {
        type: "path",
        path: icsFile(event("q@ex", "20250316T090000Z", "Theirs")),
        format: "ics",
      },
      sourceLabel: label,
      mode: "cli",
      kindOptions: { "calendar.event": { calendarName: name } },
    })
    expect(run.counts["calendar.event"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const [theirs] = await sql`
      SELECT id FROM app_calendar.accounts WHERE org_id = ${orgId} AND owner_id = ${second}
        AND display_name = ${name}`
    expect(theirs!.id).not.toBe(mine!.id)
    expect(await grantsOf(second)).not.toContain(String(mine!.id))
    expect(await grantsOf(adminId)).not.toContain(String(theirs!.id))

    // The second importer had no calendar grant: the run made it, ledgered it,
    // and its undo takes it back.
    const ledger = await sql`
      SELECT 1 FROM kernel.import_ledger
      WHERE run_id = ${run.runId} AND table_name = 'kernel.user_dimension_grants'`
    expect(ledger.length).toBe(1)
    await undoImportRun(orgId, run.runId, { userId: second })
    expect(await grantsOf(second)).toEqual([])
  })

  it("undo keeps a grant row that gained other calendars since", async () => {
    const label = `gk${tag()}`
    const user = await mkUser("keeper")
    const run = await runImport({
      orgId,
      actor: { ...admin(), userId: user },
      kinds: ["calendar.event"],
      source: {
        type: "path",
        path: icsFile(event("k@ex", "20250317T090000Z", "K")),
        format: "ics",
      },
      sourceLabel: label,
      mode: "cli",
    })
    expect(run.counts["calendar.event"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const other = crypto.randomUUID()
    await sql`
      UPDATE kernel.user_dimension_grants SET dimension_values = dimension_values || ${JSON.stringify([other])}::jsonb
      WHERE user_id = ${user} AND dimension_key = 'calendar:calaccess'`
    const report = await undoImportRun(orgId, run.runId, { userId: user })
    expect(report.refused.map((r) => [r.table, r.reason])).toContainEqual([
      "kernel.user_dimension_grants",
      "changed_after_import",
    ])
    const [grant] = await sql`
      SELECT dimension_values FROM kernel.user_dimension_grants
      WHERE user_id = ${user} AND dimension_key = 'calendar:calaccess'`
    expect(grant!.dimension_values as string[]).toContain(other)
  })

  it("an ICS source carries only the calendar.event kind", async () => {
    const err = await runImport({
      orgId,
      actor: admin(),
      kinds: ["tickets.ticket"],
      source: { type: "path", path: icsFile([]), format: "ics" },
      sourceLabel: "x",
      mode: "cli",
    }).catch((e: unknown) => e)
    expect(String(err)).toMatch(/calendar\.event/)
  })
})

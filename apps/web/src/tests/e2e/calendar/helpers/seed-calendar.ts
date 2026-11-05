// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Calendar fixtures for the UI journey, through the seed route's
// `calendar.account` and `calendar.forceReauth` factories. Calendar is in-tree
// and registered for every org at boot, so there is no install step: the
// server drives the real sync engine (connect, import, initial sync), since
// the Playwright worker runs in another process than the API under test.
import { seedFactory } from "../../helpers/seed"

export interface SeedCalendarOptions {
  serverUrl: string
  orgId: string
  actorId: string
  ownerType: "org" | "user"
  ownerId?: string | null
  identifier: string
  /** Set false to leave the connected calendar empty (empty-state screenshot). */
  populate?: boolean
}

export interface SeededCalendar {
  accountId: string
  calendarId: string
}

export function seedCalendar(opts: SeedCalendarOptions): Promise<SeededCalendar> {
  return seedFactory<SeededCalendar>(opts, opts.orgId, "calendar.account", {
    userId: opts.actorId,
    ownerType: opts.ownerType,
    ownerId: opts.ownerId ?? null,
    identifier: opts.identifier,
    populate: opts.populate ?? true,
  })
}

export async function forceCalendarReauth(
  serverUrl: string,
  orgId: string,
  accountId: string,
): Promise<void> {
  await seedFactory({ serverUrl }, orgId, "calendar.forceReauth", { accountId })
}

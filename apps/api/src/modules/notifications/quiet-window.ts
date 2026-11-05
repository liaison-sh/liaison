// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Quiet hours by default (notification etiquette rule 8). Quiet hours are the
 * complement of the person's work window (kernel.user_preferences work hours).
 * Until the person sets their own (`workHoursExplicit`, or stored hours that
 * differ from the column defaults 09:00-17:00 Mon-Fri, saved before that flag
 * existed), the window is
 * 08:00-20:00 Monday to Friday: quiet from 20:00 to 08:00 on weekdays and all
 * of Saturday and Sunday.
 *
 * The clock is the person's stored time zone when they have one (anything but
 * the column default `UTC`, or any zone once they saved their hours), else the
 * org's, else UTC. `source` says which one was used.
 */
import { env } from "~/lib/env"
import type { WorkHoursPrefs } from "~/modules/attention/work-hours"

/**
 * Default quiet hours on (`NOTIFICATIONS_DEFAULT_QUIET_HOURS`, default on; off
 * under NODE_ENV=test). Read at call time so a test can switch it.
 */
export function defaultQuietHoursOn(): boolean {
  const raw = process.env.NOTIFICATIONS_DEFAULT_QUIET_HOURS
  if (raw === "on" || raw === "off") return raw === "on"
  return env.NOTIFICATIONS_DEFAULT_QUIET_HOURS === "on"
}

/** The default work window: quiet hours are everything outside it. */
export const DEFAULT_QUIET_WORK_WINDOW = {
  workHoursStart: "08:00",
  workHoursEnd: "20:00",
  workDays: [1, 2, 3, 4, 5],
} as const

/** The column defaults of kernel.user_preferences: hours nobody chose. */
function isColumnDefault(w: WorkHoursPrefs): boolean {
  return (
    w.workHoursStart === "09:00" &&
    w.workHoursEnd === "17:00" &&
    w.workDays.length === 5 &&
    [1, 2, 3, 4, 5].every((d) => w.workDays.includes(d))
  )
}

/** The person chose their own hours. */
export function hasOwnWorkHours(stored: WorkHoursPrefs, explicit: boolean): boolean {
  return explicit || !isColumnDefault(stored)
}

export type QuietTimezoneSource = "user" | "org" | "unknown"

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** What is known of the person's and the org's clocks. */
export interface QuietClock {
  /** `user_preferences.timezone` (column default `UTC`). */
  prefsTimezone: string | null | undefined
  /** The person set `prefsTimezone` (settings, the agent, or their browser reported it). */
  prefsTimezoneSet?: boolean
  /** `users.timezone`, set from the profile; null until then. */
  profileTimezone?: string | null
  orgTimezone?: string | null
  /** The org's admin set its time zone. */
  orgTimezoneSet?: boolean
}

/**
 * The time zone default quiet hours are read in, or `unknown`: then the
 * default quiet hours do not apply (rule 8 never guesses UTC). Known, in order:
 * the person's own (set explicitly, or reported by their browser, or a non-UTC
 * value from before the flag existed), their profile's, the org's (set
 * explicitly, or a non-UTC value).
 */
export function resolveQuietTimezone(clock: QuietClock): {
  timezone: string | null
  source: QuietTimezoneSource
} {
  const prefs = clock.prefsTimezone
  if (isValidTimezone(prefs) && (clock.prefsTimezoneSet === true || prefs !== "UTC")) {
    return { timezone: prefs, source: "user" }
  }
  if (isValidTimezone(clock.profileTimezone)) {
    return { timezone: clock.profileTimezone, source: "user" }
  }
  const org = clock.orgTimezone
  if (isValidTimezone(org) && (clock.orgTimezoneSet === true || org !== "UTC")) {
    return { timezone: org, source: "org" }
  }
  return { timezone: null, source: "unknown" }
}

/**
 * The work window the router reads quiet time from. The person's own hours
 * apply in the zone they chose (`stored.timezone`). Without own hours, the
 * default window applies in the resolved zone; with no known zone, or with
 * default quiet hours switched off, there is no quiet time on phone and
 * computer and email follows the stored hours, as before the rule.
 */
export function effectiveQuietWindow(args: {
  stored: WorkHoursPrefs
  explicit: boolean
  clock?: Omit<QuietClock, "prefsTimezone">
  /** Default quiet hours are on (`NOTIFICATIONS_DEFAULT_QUIET_HOURS`). */
  defaultOn?: boolean
}): WorkHoursPrefs & { timezoneSource: QuietTimezoneSource; quietLive: boolean } {
  const tz = resolveQuietTimezone({ prefsTimezone: args.stored.timezone, ...(args.clock ?? {}) })
  if (hasOwnWorkHours(args.stored, args.explicit)) {
    return { ...args.stored, timezoneSource: "user", quietLive: true }
  }
  if (args.defaultOn === false || tz.timezone === null) {
    return { ...args.stored, timezoneSource: tz.source, quietLive: false }
  }
  return {
    workHoursStart: DEFAULT_QUIET_WORK_WINDOW.workHoursStart,
    workHoursEnd: DEFAULT_QUIET_WORK_WINDOW.workHoursEnd,
    workDays: [...DEFAULT_QUIET_WORK_WINDOW.workDays],
    timezone: tz.timezone,
    timezoneSource: tz.source,
    quietLive: true,
  }
}

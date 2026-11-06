// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one place the issue date and number year of a document are computed: the civil date, in the
// issuer's time zone, of the instant its number is taken. The zone table lives on the host: the
// sandbox has no `Intl`, so `new Date()` here only ever knows UTC, and a date taken from it is a
// day behind (and a year behind on New Year's Eve) between local midnight and the UTC offset.
//
// The stored `issuer.timezone` carries the choice:
//  - `UTC` (or nothing) is the column default, so nobody chose: the host answers with the org's
//    zone, then UTC. `issuerTimezoneUnset` reports it, and the readiness surfaces ask once.
//  - anything else is a choice, `Etc/UTC` included: that is how UTC chosen on purpose is stored
//    (`normalizeIssuerTimezone`), and the host answers with it as it stands.
import type { ErrorEnvelope } from "./mutations/shared"

export const DEFAULT_ZONE = "UTC"
export const CHOSEN_UTC = "Etc/UTC"

export interface CivilTime {
  date: string
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
  zone: string
}

/** The host's `ctx.time`; see `AppContext.time` in `@liaison/app-sdk`. */
export interface TimeSurface {
  time: {
    civil(params: { timezone: string; at?: string | number }): Promise<CivilTime>
  }
}

export interface IssueDateParts {
  year_of_issue: number
  issued_at: string
}

function isInvalidTimezone(err: unknown): err is { code: string; message?: string } {
  return (err as { code?: unknown } | null | undefined)?.code === "invalid_timezone"
}

function timezoneInvalid(detail: string): ErrorEnvelope {
  return {
    status: "error",
    error: {
      code: "issuer_timezone_invalid",
      message:
        `${detail}. Nothing was issued and no number was used. Set the issuer's time zone with ` +
        'settings_issuer_profile_update, for example "Europe/Paris".',
    },
  }
}

/** The number year and issue date of a document whose number is taken now, or the typed refusal. */
export async function issueDateParts(
  ctx: TimeSurface,
  issuer: { timezone?: string | null },
): Promise<({ ok: true } & IssueDateParts) | { ok: false; error: ErrorEnvelope }> {
  try {
    const now = await ctx.time.civil({ timezone: issuer.timezone || DEFAULT_ZONE })
    return { ok: true, year_of_issue: now.year, issued_at: now.date }
  } catch (err) {
    if (isInvalidTimezone(err)) return { ok: false, error: timezoneInvalid(String(err.message ?? "Unknown time zone")) }
    throw err
  }
}

/** True while nobody chose this issuer's zone: dates follow the org's zone, or UTC without one. */
export function issuerTimezoneUnset(issuer: { timezone?: unknown }): boolean {
  return !issuer.timezone || issuer.timezone === DEFAULT_ZONE
}

/** What a profile write stores. A `UTC` someone sends is a choice, not the column default. */
export function normalizeIssuerTimezone(zone: string): string {
  return zone === DEFAULT_ZONE ? CHOSEN_UTC : zone
}

/** Refuse a zone the host does not know, when the profile is saved. Null when it may be saved. */
export async function checkIssuerTimezone(ctx: TimeSurface, zone: string): Promise<ErrorEnvelope | null> {
  try {
    await ctx.time.civil({ timezone: normalizeIssuerTimezone(zone) })
    return null
  } catch (err) {
    if (isInvalidTimezone(err)) return timezoneInvalid(String(err.message ?? "Unknown time zone"))
    throw err
  }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `ctx.time.civil`: the wall clock of an instant in a named IANA zone. It lives on the host because
// the sandbox has no `Intl` and no zone table: `Intl.DateTimeFormat` in a handler throws.

/** What `ctx.time.civil` answers: the date and clock a person in `zone` reads at that instant. */
export interface CivilTime {
  /** `YYYY-MM-DD` */
  date: string
  year: number
  month: number
  day: number
  /** 0 to 23 */
  hour: number
  minute: number
  /** ISO weekday: 1 is Monday, 7 is Sunday. */
  weekday: number
  /** The zone the answer was computed in. */
  zone: string
}

/** A name, never an offset: `+01:00` would format, then drift at the next clock change. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/

const ISO_WEEKDAY: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
}

/** The typed refusal reaching the handler: it can read `.code` off the rejection it catches. */
function refusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { status: 422, code })
}

function formatterFor(zone: string): Intl.DateTimeFormat {
  const unknown = refusal("invalid_timezone", `"${zone}" is not a known IANA time zone name`)
  if (!ZONE_NAME.test(zone)) throw unknown
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    })
  } catch {
    throw unknown
  }
}

/** The instant a caller named, or now. A value that names no instant is refused, never "now". */
export function instantOf(at: unknown): Date {
  if (at === undefined || at === null) return new Date()
  const d = typeof at === "string" || typeof at === "number" ? new Date(at) : null
  if (!d || Number.isNaN(d.getTime())) {
    throw refusal(
      "invalid_instant",
      `at must be an ISO date-time or epoch milliseconds, got ${JSON.stringify(at)}`,
    )
  }
  return d
}

/** The civil date and clock of `at` in `zone`. Refuses an unknown zone with `invalid_timezone`. */
export function civilTimeAt(zone: string, at: Date): CivilTime {
  const parts = new Map(
    formatterFor(zone)
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  )
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.get(type) ?? ""
  const date = `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`
  return {
    date,
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    weekday: ISO_WEEKDAY[part("weekday")] ?? 0,
    zone,
  }
}

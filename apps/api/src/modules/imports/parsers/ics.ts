// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * iCalendar (RFC 5545) reader for the `calendar.event` import, host-side: an
 * ICS file is a standard, not a vendor shape, so it is read here rather than
 * by a sandboxed transform.
 *
 * - Content lines are unfolded (a line starting with a space or a tab
 *   continues the previous one) and TEXT values unescaped.
 * - DTSTART/DTEND (or DURATION): `VALUE=DATE` is an all-day date; a `Z` time is
 *   UTC; a `TZID` is resolved as an IANA zone, else through the file's own
 *   `VTIMEZONE` (its STANDARD/DAYLIGHT observances and their yearly rules); a
 *   floating time is read as UTC.
 * - RRULE, RDATE and EXDATE lines are kept verbatim as the event's recurrence.
 *   An override (`RECURRENCE-ID`) becomes its own event (`<UID>#<id>`) and the
 *   series gains an EXDATE for it, so the occurrence is not shown twice.
 * - VALARM is ignored. An event without a UID or a start is reported, not read.
 */

export interface IcsDateTime {
  dateTime?: string
  date?: string
  timeZone?: string
}

export interface IcsEvent {
  externalRef: string
  title?: string
  description?: string
  location?: string
  start: IcsDateTime
  end: IcsDateTime
  allDay: boolean
  status?: string
  recurrence?: string[]
  attendees?: Array<{ email: string; name?: string }>
  organizerEmail?: string
  originalStartTime?: IcsDateTime
}

interface ContentLine {
  name: string
  params: Record<string, string>
  value: string
  raw: string
}

/** Unfold, then split each content line into name, parameters and value. */
function contentLines(text: string): ContentLine[] {
  const physical = text.replace(/\r\n?/g, "\n").split("\n")
  const logical: string[] = []
  for (const line of physical) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && logical.length > 0) {
      logical[logical.length - 1] += line.slice(1)
    } else if (line.length > 0) {
      logical.push(line)
    }
  }
  const out: ContentLine[] = []
  for (const raw of logical) {
    // The value starts at the first colon outside a quoted parameter value.
    let inQuotes = false
    let colon = -1
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]
      if (ch === '"') inQuotes = !inQuotes
      else if (ch === ":" && !inQuotes) {
        colon = i
        break
      }
    }
    if (colon < 0) continue
    const head = raw.slice(0, colon)
    const value = raw.slice(colon + 1)
    const [name = "", ...paramParts] = head.split(";")
    const params: Record<string, string> = {}
    for (const p of paramParts) {
      const eq = p.indexOf("=")
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "")
    }
    out.push({ name: name.toUpperCase(), params, value, raw })
  }
  return out
}

function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c))
}

// ── Time zones ───────────────────────────────────────────────────────────

interface Observance {
  offsetMinutes: number
  /** Local onset time of day (minutes) and its rule. */
  onsetMinutes: number
  month: number | null
  /** BYDAY ordinal and weekday (0 = Sunday), e.g. -1 SU. */
  ordinal: number | null
  weekday: number | null
  /** An observance without a yearly rule: its fixed local start (ms). */
  fixedStart: number | null
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

function parseOffset(v: string): number {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(v.trim())
  if (!m) return 0
  const minutes = Number(m[2]) * 60 + Number(m[3])
  return m[1] === "-" ? -minutes : minutes
}

/** "YYYYMMDD[THHMMSS[Z]]" as local wall-clock ms (UTC-based arithmetic). */
function wallClockMs(v: string): { ms: number; utc: boolean; dateOnly: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v.trim())
  if (!m) return null
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
  )
  return { ms, utc: m[7] === "Z", dateOnly: m[4] === undefined }
}

/** The day of the month of the `ordinal`th `weekday` of a month (-1 = last). */
function nthWeekday(year: number, month: number, ordinal: number, weekday: number): number {
  if (ordinal > 0) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay()
    return 1 + ((weekday - first + 7) % 7) + (ordinal - 1) * 7
  }
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const last = new Date(Date.UTC(year, month, lastDay)).getUTCDay()
  return lastDay - ((last - weekday + 7) % 7) + (ordinal + 1) * 7
}

function onsetIn(o: Observance, year: number): number | null {
  if (o.month !== null && o.ordinal !== null && o.weekday !== null) {
    const day = nthWeekday(year, o.month, o.ordinal, o.weekday)
    return Date.UTC(year, o.month, day) + o.onsetMinutes * 60_000
  }
  return o.fixedStart
}

/** The UTC offset (minutes) a VTIMEZONE gives a local wall-clock time. */
function vtimezoneOffset(observances: Observance[], localMs: number): number {
  const year = new Date(localMs).getUTCFullYear()
  let best: { at: number; offset: number } | null = null
  for (const o of observances) {
    for (const y of [year - 1, year]) {
      const at = onsetIn(o, y)
      if (at !== null && at <= localMs && (!best || at > best.at)) {
        best = { at, offset: o.offsetMinutes }
      }
    }
  }
  return best?.offset ?? observances[0]?.offsetMinutes ?? 0
}

function isIanaZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The UTC offset (minutes) of an IANA zone at a UTC instant. */
function ianaOffset(tz: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  )
  return Math.round((asUtc - utcMs) / 60_000)
}

// ── Events ───────────────────────────────────────────────────────────────

/** ISO 8601 duration (days, hours, minutes, seconds, weeks) in ms. */
function durationMs(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim())
  if (!m) return null
  const ms =
    (Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 86_400_000 +
    Number(m[4] ?? 0) * 3_600_000 +
    Number(m[5] ?? 0) * 60_000 +
    Number(m[6] ?? 0) * 1000
  return m[1] === "-" ? -ms : ms
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function parseIcs(text: string): { events: IcsEvent[]; errors: string[] } {
  const lines = contentLines(text)
  const errors: string[] = []

  // Time zones first: an event may name one defined after it.
  const zones = new Map<string, Observance[]>()
  {
    let tzid: string | null = null
    let current: Partial<Observance> & { rrule?: string; dtstart?: string } = {}
    let inObservance = false
    for (const l of lines) {
      if (l.name === "BEGIN" && l.value.toUpperCase() === "VTIMEZONE") tzid = null
      else if (l.name === "TZID" && !inObservance) tzid = l.value
      else if (l.name === "BEGIN" && /^(STANDARD|DAYLIGHT)$/i.test(l.value)) {
        inObservance = true
        current = {}
      } else if (inObservance && l.name === "TZOFFSETTO")
        current.offsetMinutes = parseOffset(l.value)
      else if (inObservance && l.name === "DTSTART") current.dtstart = l.value
      else if (inObservance && l.name === "RRULE") current.rrule = l.value
      else if (l.name === "END" && /^(STANDARD|DAYLIGHT)$/i.test(l.value) && tzid) {
        inObservance = false
        const start = current.dtstart ? wallClockMs(current.dtstart) : null
        const rule = Object.fromEntries(
          (current.rrule ?? "").split(";").map((kv) => kv.split("=") as [string, string]),
        )
        const byday = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(rule.BYDAY ?? "")
        const obs: Observance = {
          offsetMinutes: current.offsetMinutes ?? 0,
          onsetMinutes: start
            ? new Date(start.ms).getUTCHours() * 60 + new Date(start.ms).getUTCMinutes()
            : 0,
          month: rule.BYMONTH ? Number(rule.BYMONTH) - 1 : null,
          ordinal: byday ? Number(byday[1] ?? 1) : null,
          weekday: byday ? (WEEKDAYS[byday[2] as string] ?? null) : null,
          fixedStart: start?.ms ?? null,
        }
        const list = zones.get(tzid) ?? []
        list.push(obs)
        zones.set(tzid, list)
      }
    }
  }

  /** One DATE / DATE-TIME property value as an event time. */
  const timeOf = (l: ContentLine): { t: IcsDateTime; ms: number; allDay: boolean } | null => {
    const wall = wallClockMs(l.value)
    if (!wall) return null
    if (l.params.VALUE === "DATE" || wall.dateOnly) {
      return { t: { date: isoDate(wall.ms) }, ms: wall.ms, allDay: true }
    }
    if (wall.utc)
      return { t: { dateTime: new Date(wall.ms).toISOString() }, ms: wall.ms, allDay: false }
    const tzid = l.params.TZID
    if (tzid && zones.has(tzid)) {
      const ms = wall.ms - vtimezoneOffset(zones.get(tzid) ?? [], wall.ms) * 60_000
      return { t: { dateTime: new Date(ms).toISOString(), timeZone: tzid }, ms, allDay: false }
    }
    if (tzid && isIanaZone(tzid)) {
      // Two passes settle the offset around a transition.
      let ms = wall.ms - ianaOffset(tzid, wall.ms) * 60_000
      ms = wall.ms - ianaOffset(tzid, ms) * 60_000
      return { t: { dateTime: new Date(ms).toISOString(), timeZone: tzid }, ms, allDay: false }
    }
    // A floating time (or an unknown zone) is read as UTC.
    return { t: { dateTime: new Date(wall.ms).toISOString() }, ms: wall.ms, allDay: false }
  }

  const events: IcsEvent[] = []
  const overrideIdsByUid = new Map<string, string[]>()
  let block: ContentLine[] | null = null
  let depth = 0
  for (const l of lines) {
    if (l.name === "BEGIN" && l.value.toUpperCase() === "VEVENT") {
      block = []
      depth = 0
      continue
    }
    if (!block) continue
    if (l.name === "BEGIN") depth++
    else if (l.name === "END" && depth > 0) depth--
    else if (l.name === "END" && l.value.toUpperCase() === "VEVENT") {
      const props = block
      block = null
      const one = (n: string) => props.find((p) => p.name === n)
      const uid = one("UID")?.value.trim()
      const dtstart = one("DTSTART")
      const start = dtstart ? timeOf(dtstart) : null
      if (!uid || !start) {
        errors.push(
          `an event without ${!uid ? "a UID" : "a start"} was not read${uid ? ` (${uid})` : ""}`,
        )
        continue
      }
      const dtend = one("DTEND")
      let end = dtend ? timeOf(dtend) : null
      if (!end) {
        const dur = one("DURATION")
        const d = dur ? durationMs(dur.value) : null
        const ms = start.ms + (d ?? (start.allDay ? 86_400_000 : 0))
        end = {
          t: start.allDay
            ? { date: isoDate(ms) }
            : {
                dateTime: new Date(ms).toISOString(),
                ...(start.t.timeZone ? { timeZone: start.t.timeZone } : {}),
              },
          ms,
          allDay: start.allDay,
        }
      }
      const recurrenceId = one("RECURRENCE-ID")
      const recurrence = props
        .filter((p) => ["RRULE", "RDATE", "EXDATE"].includes(p.name))
        .map((p) => p.raw)
      const attendees = props
        .filter((p) => p.name === "ATTENDEE")
        .map((p) => ({ email: p.value.replace(/^mailto:/i, "").trim(), name: p.params.CN }))
        .filter((a) => a.email.includes("@"))
        .map((a) => (a.name ? { email: a.email, name: a.name } : { email: a.email }))
      const organizer = one("ORGANIZER")
        ?.value.replace(/^mailto:/i, "")
        .trim()
      const summary = one("SUMMARY")
      const description = one("DESCRIPTION")
      const location = one("LOCATION")
      const status = one("STATUS")?.value.trim().toLowerCase()
      const event: IcsEvent = {
        externalRef: recurrenceId ? `${uid}#${recurrenceId.value.trim()}` : uid,
        ...(summary ? { title: unescapeText(summary.value) } : {}),
        ...(description ? { description: unescapeText(description.value) } : {}),
        ...(location ? { location: unescapeText(location.value) } : {}),
        start: start.t,
        end: end.t,
        allDay: start.allDay,
        ...(status ? { status } : {}),
        ...(recurrence.length > 0 && !recurrenceId ? { recurrence } : {}),
        ...(attendees.length > 0 ? { attendees } : {}),
        ...(organizer?.includes("@") ? { organizerEmail: organizer } : {}),
      }
      if (recurrenceId) {
        const original = timeOf(recurrenceId)
        if (original) event.originalStartTime = original.t
        const list = overrideIdsByUid.get(uid) ?? []
        // The same date and zone as an EXDATE; RANGE is a RECURRENCE-ID
        // parameter only.
        const head = recurrenceId.raw.slice(0, recurrenceId.raw.length - recurrenceId.value.length)
        list.push(
          `${head.replace(/^RECURRENCE-ID/i, "EXDATE").replace(/;RANGE=[^;:]*/i, "")}${recurrenceId.value}`,
        )
        overrideIdsByUid.set(uid, list)
      }
      events.push(event)
    } else {
      block.push(l)
    }
  }
  // A series excludes the occurrences its overrides replace.
  for (const e of events) {
    const extra = overrideIdsByUid.get(e.externalRef)
    if (extra && e.recurrence) e.recurrence = [...e.recurrence, ...extra]
  }
  return { events, errors }
}

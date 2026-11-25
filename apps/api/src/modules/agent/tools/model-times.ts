// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE TIMES A MODEL READS, IN THE READER'S ZONE. Tools return instants as stored, in UTC
 * (`2026-11-19T06:05:00.000Z`), and a model reading one repeats it as the time: "the request came
 * at 06:05" while the screen in Paris says 07:05. What the model reads of a tool result (live, and
 * when a stored turn is replayed) and the current time it is given go through `timesForModel`: each
 * instant becomes the same instant in the person's zone, its offset written out
 * (`2026-11-19T07:05:00+01:00`), still a valid ISO 8601 instant the model can pass back to a tool.
 * A date with no time is a civil date and stays as it is; in UTC an instant keeps its `Z`, which
 * names UTC. Stored results, APIs and tool cards never change: this is only the model's copy.
 */
import { eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel/organizations"
import { users } from "~/db/schema/kernel/users"

/** An ISO 8601 instant: a date, a time and a zone (`Z` or an offset). */
const INSTANT =
  /\b(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})(?![\d:])/g

const pad = (n: number) => String(n).padStart(2, "0")

/** The zone's offset from UTC at `instant`, in minutes, or null for a zone the runtime cannot read. */
function offsetMinutes(instant: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant)
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value)
    const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"))
    return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000)
  } catch {
    return null
  }
}

/** One instant in the zone, its offset written out; null when it cannot be read. */
export function instantInZone(instant: Date, timeZone: string): string | null {
  if (Number.isNaN(instant.getTime())) return null
  const offset = offsetMinutes(instant, timeZone)
  if (offset === null) return null
  const local = new Date(instant.getTime() + offset * 60_000)
  const sign = offset < 0 ? "-" : "+"
  const abs = Math.abs(offset)
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

function inText(text: string, timeZone: string): string {
  return text.replace(INSTANT, (match) => instantInZone(new Date(match), timeZone) ?? match)
}

/** A value the model reads, with every instant in it moved to `timeZone` (see the module comment). */
export function timesForModel<T>(value: T, timeZone: string | undefined): T {
  if (!timeZone || timeZone === "UTC" || offsetMinutes(new Date(0), timeZone) === null) return value
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return inText(v, timeZone)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, item] of Object.entries(v)) out[k] = walk(item)
      return out
    }
    return v
  }
  return walk(value) as T
}

/**
 * The zone a person's agent reads times in: their own, else their organization's, else UTC.
 * With no person (a system actor's run), the organization's, else UTC.
 * Read privileged: the person's own row and their organization's zone only.
 */
export async function modelTimeZoneOf(orgId: string, userId: string | null): Promise<string> {
  return withPrivilegedDb(orgId, "agent-model-time-zone", async (tx) => {
    if (!userId) {
      const [org] = await tx
        .select({ tz: organizations.timezone })
        .from(organizations)
        .where(eq(organizations.id, orgId))
      return org?.tz || "UTC"
    }
    const [row] = await tx
      .select({ tz: users.timezone, orgTz: organizations.timezone })
      .from(users)
      .leftJoin(organizations, eq(organizations.id, users.orgId))
      .where(eq(users.id, userId))
    return row?.tz || row?.orgTz || "UTC"
  })
}

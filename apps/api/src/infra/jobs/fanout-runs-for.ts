// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `runsFor`: which orgs a scheduled app job is for (the pure half; the tick's
// query is in fanout-runtime.ts).
//
// A scheduled job runs in a sandbox worker, and the pool is small and shared by
// every app. Most orgs have nothing for most crons to do (no mailbox, no store
// connected, no parked event), yet every run held a worker for its whole bundle
// load. So a job says in its manifest what an org needs before a run can do
// anything, and the fan-out tick checks it for all orgs at once, in the kernel,
// before it enqueues. One of:
//
//   "runsFor": { "everyOrg": "<why every org needs a run>" }
//   "runsFor": { "connection": "gmail" }                 // this app's connection
//   "runsFor": { "connection": ["shopify:shop"] }        // another app's: "<app>:<connection>"
//   "runsFor": { "rows": { "entity": "deferred_events", "where": { "status": { "in": ["open"] } } } }
//
// `connection` and `rows` may both be given, and each may be a list: an org
// gets a run when ANY of them holds. A connection counts when the org has an
// active connected account for it (any owner), the same accounts a handler can
// get a token for; a demo fixture account (`metadata.demo`) has no upstream to
// poll and does not count. A `rows` condition holds when the app's own entity
// has a row matching `where`: a value matches by equality, `null` is IS NULL,
// `{ "in": [...] }` a set, `{ "not": null }` IS NOT NULL. The condition only
// has to be NECESSARY for the run to do work: the handler still decides.
//
// Narrow it as far as the handler allows. Every org a tick enqueues is set up
// in the worker that runs the job (its whole app runtime, jobs.ts), and that
// run counts as a touch, so an org a cron reaches every hour is never idle long
// enough to be released (org-runtime-release.ts): a too-wide `runsFor` on an
// hourly job keeps every org of the cell set up in the worker for good.

/** One `rows` condition: the app's entity has a row matching `where`. */
export interface RunsForRows {
  entity: string
  where?: Record<string, unknown>
}

/** The normalized precondition a fan-out template carries (absent = every org). */
export interface RunsForCheck {
  /** `<app>:<connection>` pairs. */
  connections?: string[]
  rows?: RunsForRows[]
}

const WHERE_IN_MAX = 50

const asList = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v]

/**
 * The check a job's `runsFor` asks the tick to make, or undefined when every
 * org gets a run (`everyOrg`, or no `runsFor`: an app outside this repo that
 * declares none keeps the old behaviour). Assumes a manifest that validated.
 */
export function runsForCheckOf(app: string, raw: unknown): RunsForCheck | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as { everyOrg?: unknown; connection?: unknown; rows?: unknown }
  if (r.everyOrg !== undefined) return undefined
  const connections = asList(r.connection as string | string[] | undefined).map((c) =>
    c.includes(":") ? c : `${app}:${c}`,
  )
  const rows = asList(r.rows as RunsForRows | RunsForRows[] | undefined).map((x) =>
    x.where && Object.keys(x.where).length > 0
      ? { entity: x.entity, where: x.where }
      : { entity: x.entity },
  )
  if (connections.length === 0 && rows.length === 0) return undefined
  return {
    ...(connections.length > 0 ? { connections } : {}),
    ...(rows.length > 0 ? { rows } : {}),
  }
}

/** How a `where` value reads: equality, IS NULL, IS NOT NULL or a set. */
export type RunsForWhereOp =
  | { op: "eq"; value: string | number | boolean }
  | { op: "null" }
  | { op: "notNull" }
  | { op: "in"; values: Array<string | number | boolean> }

const isPrimitive = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean"

/** The operator of one `where` value, or an error message. */
export function runsForWhereOp(value: unknown): RunsForWhereOp | string {
  if (value === null) return { op: "null" }
  if (isPrimitive(value)) return { op: "eq", value }
  if (typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value)
    const v = value as { in?: unknown; not?: unknown }
    if (keys.length === 1 && keys[0] === "not" && v.not === null) return { op: "notNull" }
    if (keys.length === 1 && keys[0] === "in" && Array.isArray(v.in)) {
      if (v.in.length === 0 || v.in.length > WHERE_IN_MAX || !v.in.every(isPrimitive)) {
        return `"in" takes 1 to ${WHERE_IN_MAX} strings, numbers or booleans`
      }
      return { op: "in", values: v.in }
    }
  }
  return 'a value is a string, number, boolean, null, { "in": [...] } or { "not": null }'
}

/** Implicit columns every entity table has (ddl.ts), usable in `where`. */
const BASE_FIELDS = new Set(["id", "createdAt", "updatedAt", "created_at", "updated_at"])

/**
 * Manifest errors of every job's `runsFor`. `requireDeclared` (this repo's own
 * apps, via the guard test) also makes it mandatory on every scheduled job.
 */
export function runsForErrors(
  manifest: unknown,
  opts: { requireDeclared?: boolean } = {},
): string[] {
  const m = manifest as {
    name?: string
    jobs?: Record<string, unknown>
    connections?: unknown
    schema?: Record<string, { fields?: Record<string, unknown> }>
  }
  if (!m?.jobs || typeof m.jobs !== "object") return []
  const ownConnections = new Set(
    Array.isArray(m.connections)
      ? (m.connections as Array<{ name?: string }>).map((c) => c?.name ?? "")
      : Object.keys((m.connections as Record<string, unknown>) ?? {}),
  )
  const errors: string[] = []
  for (const [job, raw] of Object.entries(m.jobs)) {
    const def = (raw ?? {}) as { schedule?: unknown; runsFor?: unknown }
    const at = `jobs.${job}.runsFor`
    const scheduled = typeof def.schedule === "string" && def.schedule !== ""
    if (def.runsFor === undefined) {
      if (scheduled && opts.requireDeclared) {
        errors.push(
          `${at}: a scheduled job says which orgs it is for: { "connection": ... }, { "rows": ... } or { "everyOrg": "<reason>" }`,
        )
      }
      continue
    }
    if (!scheduled) {
      errors.push(`${at}: only a scheduled job (one with a "schedule") takes runsFor`)
      continue
    }
    const r = def.runsFor as Record<string, unknown>
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      errors.push(`${at}: must be an object`)
      continue
    }
    for (const key of Object.keys(r)) {
      if (!["everyOrg", "connection", "rows"].includes(key))
        errors.push(`${at}.${key}: unknown key`)
    }
    if (r.everyOrg !== undefined) {
      if (typeof r.everyOrg !== "string" || r.everyOrg.trim().length < 10) {
        errors.push(`${at}.everyOrg: say why every org needs a run (a sentence)`)
      }
      if (r.connection !== undefined || r.rows !== undefined) {
        errors.push(`${at}: everyOrg cannot be combined with connection or rows`)
      }
      continue
    }
    const connections = asList(r.connection as unknown)
    const rows = asList(r.rows as unknown)
    if (connections.length === 0 && rows.length === 0) {
      errors.push(`${at}: give a connection, rows or everyOrg`)
    }
    for (const c of connections) {
      if (typeof c !== "string" || !/^([a-z0-9-]+:)?[A-Za-z0-9_-]+$/.test(c)) {
        errors.push(
          `${at}.connection: "${String(c)}" is not "<connection>" or "<app>:<connection>"`,
        )
      } else if (!c.includes(":") && !ownConnections.has(c)) {
        errors.push(`${at}.connection: "${c}" is not one of this app's connections`)
      }
    }
    for (const row of rows) {
      const x = row as RunsForRows
      if (!x || typeof x !== "object" || typeof x.entity !== "string") {
        errors.push(`${at}.rows: each condition is { "entity": "<entity>", "where"?: {...} }`)
        continue
      }
      const entity = m.schema?.[x.entity]
      if (!entity) {
        errors.push(`${at}.rows: "${x.entity}" is not one of this app's entities`)
        continue
      }
      for (const [field, value] of Object.entries(x.where ?? {})) {
        if (!BASE_FIELDS.has(field) && !(field in (entity.fields ?? {}))) {
          errors.push(`${at}.rows.where.${field}: not a field of "${x.entity}"`)
        }
        const op = runsForWhereOp(value)
        if (typeof op === "string") errors.push(`${at}.rows.where.${field}: ${op}`)
      }
    }
  }
  return errors
}

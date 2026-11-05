// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The counters that say whether a deploy only delayed work (the owner's bar):
// over a deploy window, how many requests the edge failed, how many agent turns
// were cut, and how many outside effects ran twice. Every one must be 0.
//
//   edge5xx          Caddy JSON access-log lines with status >= 500 in the window.
//   cutTurns         kernel.agent_turns rows that started in the window and were
//                    cut: `interrupted` or `failed` because the process running
//                    them stopped or died (`failure_reason = 'process'`, or no
//                    reason on a row older than migration 0228), still not
//                    finished 15 min after they started, or (scripted load
//                    turns) a stored reply that is not the script's final text.
//                    A turn that failed on its own (a model error) or whose
//                    caller left is not a deploy's doing and is not counted.
//   effectDuplicates `effect_duplicate` lines in the app's JSON log: the effect
//                    ledger saw a second attempt of an effect already done
//                    (apps/api/src/lib/effect-once.ts).
//   doubledEffects   effect-sink keys recorded more than once (a load run's sink
//                    counts; the caller reads them).
//
// Pure functions over log lines and rows, plus a reader for the turn rows, so
// the same counters run in tests, in `scripts/deploy-counters.ts` against a
// real deployment, and in a deploy-under-load driver.
import type postgres from "postgres"
import { expectedLoadReply } from "../../apps/api/src/modules/agent/providers/load-script-catalog"

export interface Window {
  /** Inclusive, ms since the epoch. */
  start: number
  /** Inclusive, ms since the epoch. */
  end: number
}

function parseJson(line: string): Record<string, unknown> | null {
  const t = line.trim()
  if (!t.startsWith("{")) return null
  try {
    const v: unknown = JSON.parse(t)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A log line's time in ms: Caddy writes `ts` in seconds, pino `time` in ms (or ISO). */
function lineTimeMs(rec: Record<string, unknown>): number | null {
  if (typeof rec.ts === "number") return rec.ts * 1000
  if (typeof rec.time === "number") return rec.time
  if (typeof rec.time === "string") {
    const ms = Date.parse(rec.time)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

const inWindow = (ms: number | null, w: Window): boolean =>
  ms !== null && ms >= w.start && ms <= w.end

/** Caddy access-log lines (JSON) with a status >= 500 inside the window. */
export function edge5xx(lines: Iterable<string>, window: Window): number {
  let n = 0
  for (const line of lines) {
    const rec = parseJson(line)
    if (!rec || typeof rec.status !== "number") continue
    if (rec.status >= 500 && inWindow(lineTimeMs(rec), window)) n++
  }
  return n
}

/**
 * `edge5xx`, or null when the source was not measured: no line of it was an
 * access-log record with a status inside the window (an empty file, a wrong
 * format, the wrong container). A source that read nothing never says 0.
 */
export function edge5xxMeasured(lines: Iterable<string>, window: Window): number | null {
  let seen = 0
  let n = 0
  for (const line of lines) {
    const rec = parseJson(line)
    if (!rec || typeof rec.status !== "number" || !inWindow(lineTimeMs(rec), window)) continue
    seen++
    if (rec.status >= 500) n++
  }
  return seen === 0 ? null : n
}

/**
 * `effectDuplicates`, or null when no JSON log line with a time fell inside
 * the window (an empty or unparseable app log is not a measured 0).
 */
export function effectDuplicatesMeasured(lines: Iterable<string>, window: Window): number | null {
  let seen = 0
  let n = 0
  for (const line of lines) {
    const rec = parseJson(line)
    if (!rec || !inWindow(lineTimeMs(rec), window)) continue
    seen++
    if (rec.msg === "effect_duplicate") n++
  }
  return seen === 0 ? null : n
}

/** `effect_duplicate` lines of the app's JSON log inside the window. */
export function effectDuplicates(lines: Iterable<string>, window: Window): number {
  let n = 0
  for (const line of lines) {
    const rec = parseJson(line)
    if (rec?.msg === "effect_duplicate" && inWindow(lineTimeMs(rec), window)) n++
  }
  return n
}

/** Sink keys counted more than once. */
export function doubledEffects(counts: Iterable<[string, number]>): number {
  let n = 0
  for (const [, count] of counts) if (count > 1) n++
  return n
}

export const TURN_FINISH_DEADLINE_MS = 15 * 60 * 1000

export interface TurnRow {
  id: string
  state: string
  createdAt: Date
  /** The stored agent reply, when the turn wrote one. */
  reply: string | null
  /**
   * Why a `failed` / `interrupted` turn ended (migration 0228): `process` (the
   * process running it stopped or died and it could not be carried on),
   * `turn` (it failed on its own), `client` (its caller left). Null on a row
   * written before the reason existed.
   */
  failureReason: string | null
  /** The thread the turn answered in (readTurns fills it). */
  threadId?: string
  /** The org is a load org (`settings.loadHarness`): its turn ran on the scripted load model. */
  loadOrg?: boolean
  /** How many turns the thread had before this one. */
  ordinal?: number
}

/**
 * The reply a load org's turn must have stored (the load model's catalog,
 * apps/api/src/modules/agent/providers/load-script-catalog.ts): undefined for
 * a turn of any other org, which is judged by state only.
 */
export function loadExpectedReply(row: TurnRow): string | undefined {
  if (!row.loadOrg || !row.threadId || row.ordinal === undefined) return undefined
  return expectedLoadReply(row.threadId, row.ordinal)
}

/** `cutTurns` with every load org's turn judged against its expected reply. */
export function cutTurnsWithLoadReplies(rows: TurnRow[], now: number): CutTurn[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return cutTurns(rows, now, (id) => {
    const row = byId.get(id)
    return row ? loadExpectedReply(row) : undefined
  })
}

export interface CutTurn {
  id: string
  reason: "interrupted" | "failed" | "unfinished" | "reply-mismatch"
}

/**
 * The cut turns among `rows`. `expectedReply` gives the script's final text for
 * a scripted turn (by turn id); turns it does not name are judged by state only.
 */
export function cutTurns(
  rows: Iterable<TurnRow>,
  now: number,
  expectedReply: (turnId: string) => string | undefined = () => undefined,
): CutTurn[] {
  const out: CutTurn[] = []
  for (const row of rows) {
    if (row.state === "interrupted" || row.state === "failed") {
      // Unknown (null) counts: a counter that must read 0 never guesses low.
      if (row.failureReason === null || row.failureReason === "process") {
        out.push({ id: row.id, reason: row.state })
      }
    } else if (row.state !== "done") {
      if (now - row.createdAt.getTime() >= TURN_FINISH_DEADLINE_MS) {
        out.push({ id: row.id, reason: "unfinished" })
      }
    } else {
      const expected = expectedReply(row.id)
      if (expected !== undefined && row.reply !== expected) {
        out.push({ id: row.id, reason: "reply-mismatch" })
      }
    }
  }
  return out
}

/** The agent turns started inside the window, with their stored reply (privileged connection). */
export async function readTurns(sql: postgres.Sql, window: Window): Promise<TurnRow[]> {
  const rows = await sql<
    {
      id: string
      state: string
      created_at: Date
      reply: string | null
      failure_reason: string | null
      thread_id: string
      load_org: boolean
      ordinal: number
    }[]
  >`SELECT t.id, t.state, t.created_at, m.content AS reply, t.failure_reason, t.thread_id,
           COALESCE((o.settings->'loadHarness') = 'true'::jsonb, false) AS load_org,
           (SELECT count(*) FROM kernel.agent_turns p
             WHERE p.thread_id = t.thread_id AND p.created_at < t.created_at)::int AS ordinal
      FROM kernel.agent_turns t
      JOIN kernel.organizations o ON o.id = t.org_id
      LEFT JOIN kernel.messages m ON m.id = t.agent_message_id
     WHERE t.created_at >= ${new Date(window.start)} AND t.created_at <= ${new Date(window.end)}`
  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    createdAt: r.created_at,
    reply: r.reply,
    failureReason: r.failure_reason,
    threadId: r.thread_id,
    loadOrg: r.load_org,
    ordinal: r.ordinal,
  }))
}

export interface DeployReport {
  window: { start: string; end: string }
  edge5xx: number | null
  cutTurns: CutTurn[] | null
  effectDuplicates: number | null
  doubledEffects: number | null
  /** True when every counter that was measured is 0 (and at least one was). */
  ok: boolean
  summary: string
}

/** One report from whichever counters were measured (null = not measured). */
export function report(
  window: Window,
  counters: {
    edge5xx?: number
    cutTurns?: CutTurn[]
    effectDuplicates?: number
    doubledEffects?: number
  },
): DeployReport {
  const measured: Array<[string, number]> = []
  if (counters.edge5xx !== undefined) measured.push(["edge 5xx", counters.edge5xx])
  if (counters.cutTurns !== undefined) measured.push(["cut turns", counters.cutTurns.length])
  if (counters.effectDuplicates !== undefined)
    measured.push(["duplicate effects (ledger)", counters.effectDuplicates])
  if (counters.doubledEffects !== undefined)
    measured.push(["doubled effects (sink)", counters.doubledEffects])
  const ok = measured.length > 0 && measured.every(([, n]) => n === 0)
  const start = new Date(window.start).toISOString()
  const end = new Date(window.end).toISOString()
  const parts = measured.map(([name, n]) => `${n} ${name}`)
  const summary =
    measured.length === 0
      ? `Deploy window ${start} to ${end}: nothing measured.`
      : `Deploy window ${start} to ${end}: ${parts.join(", ")}. ${
          ok ? "The deploy only delayed work." : "The deploy stopped or doubled work."
        }`
  return {
    window: { start, end },
    edge5xx: counters.edge5xx ?? null,
    cutTurns: counters.cutTurns ?? null,
    effectDuplicates: counters.effectDuplicates ?? null,
    doubledEffects: counters.doubledEffects ?? null,
    ok,
    summary,
  }
}

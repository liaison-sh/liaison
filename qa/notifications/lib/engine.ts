// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE JUDGE. Pure: given a phase's expectations and what the log answered
// (delivery rows + receipts), say per cell whether it matches. The runner
// (matrix.ts) only gathers; every verdict is made here, so the rules are the
// ones engine.test.ts pins:
//
//  - Receipts for one notification on one surface collapse by the server's
//    precedence, suppressed > shown > received (A3): a final outcome always
//    beats `received`, and nothing downgrades.
//  - `received` counts as shown only where the phase says so (A3: an iOS app in
//    the background or killed; the NSE returned the content to the OS, which
//    displays it). Anywhere else it is not a display.
//  - A receipt counts only if it arrived within the window of the
//    notification's first delivery row (server clock on both sides).
//  - No receipt by the end of the window is `none`.
//  - A surface whose controller is not in the run is `skipped`, never a pass.

import {
  type CellResult,
  type CellStatus,
  type Controller,
  channelOf,
  controllerOf,
  type Expect,
  type Observed,
  type Phase,
  type PhaseObservation,
  type ReceiptRow,
  type RouterExpect,
  type Surface,
} from "./types"

export const DEFAULT_WINDOW_MS = 30_000

const RANK: Record<ReceiptRow["outcome"], number> = { received: 0, shown: 1, suppressed: 2 }

/** The receipt that wins under suppressed > shown > received. Null for none. */
export function strongestReceipt(rows: ReceiptRow[]): ReceiptRow | null {
  let best: ReceiptRow | null = null
  for (const r of rows) {
    if (!best || RANK[r.outcome] > RANK[best.outcome]) best = r
  }
  return best
}

function windowStart(obs: PhaseObservation, notificationId: string): number {
  let first = Number.POSITIVE_INFINITY
  for (const d of obs.deliveries) {
    if (d.notificationId !== notificationId) continue
    const t = Date.parse(d.attemptedAt)
    if (t < first) first = t
  }
  return Number.isFinite(first) ? first : obs.triggeredAt
}

/**
 * The notifications a surface is judged on. A test send (channel `test`) is
 * one notification per device of the user, so a copy addressed to another
 * surface, or to a device the run does not pin, is not this surface's to show
 * (TF-test-button, 2026-10-12: 11 copies, the pinned iPhone showed its own and
 * the other 10 read as "none" on iOS). Any other notification is judged on
 * every surface.
 */
export function idsForSurface(obs: PhaseObservation, surface: Surface): string[] {
  const pinned = obs.deviceIds?.[surface]
  return obs.notificationIds.filter((id) => {
    const rows = obs.deliveries.filter((d) => d.notificationId === id)
    if (rows.length === 0 || rows.some((d) => d.channel !== "test")) return true
    return rows.some(
      (d) =>
        d.surface === surface && (!pinned || (d.deviceId !== null && pinned.includes(d.deviceId))),
    )
  })
}

/** What one surface did with one notification, within the window. */
export function observeSurface(
  obs: PhaseObservation,
  notificationId: string,
  surface: Surface,
  windowMs: number = DEFAULT_WINDOW_MS,
): Observed {
  const first = windowStart(obs, notificationId)
  const start = obs.windowFrom === undefined ? first : Math.max(first, obs.windowFrom)
  const pinned = obs.deviceIds?.[surface]
  const rows = obs.receipts.filter(
    (r) =>
      r.notificationId === notificationId &&
      r.surface === surface &&
      (!pinned || pinned.includes(r.deviceId)) &&
      Date.parse(r.receivedAt) - start <= windowMs,
  )
  const best = strongestReceipt(rows)
  const deliveryEvidence = obs.deliveries
    .filter((d) => d.notificationId === notificationId && d.surface === surface)
    .map((d) => `delivery:${d.id}:${d.result}`)
  if (!best) return { kind: "none", evidence: deliveryEvidence }
  return {
    kind: best.outcome,
    ...(best.reason ? { reason: best.reason } : {}),
    evidence: [`receipt:${best.id}:${best.outcome}`, ...deliveryEvidence],
  }
}

export function formatExpect(e: Expect): string {
  if (e.kind === "suppressed") return e.reason ? `suppressed(${e.reason})` : "suppressed"
  return e.kind
}

export function formatObserved(o: Observed): string {
  if (o.kind === "suppressed") return o.reason ? `suppressed(${o.reason})` : "suppressed"
  return o.kind
}

/** Whether an observation satisfies an expectation. */
export function matches(expect: Expect, observed: Observed, receivedIsShown: boolean): boolean {
  switch (expect.kind) {
    case "none":
      return observed.kind === "none"
    case "shown":
      return observed.kind === "shown" || (receivedIsShown && observed.kind === "received")
    case "suppressed":
      return (
        observed.kind === "suppressed" &&
        (expect.reason === undefined || expect.reason === observed.reason)
      )
  }
}

/** True once nothing later in the window can change this cell's verdict. */
function cellDecided(
  expect: Expect,
  observed: Observed,
  receivedIsShown: boolean,
  routerHeld: boolean,
): boolean {
  if (expect.kind === "none") {
    // A receipt already broke it; or the router held the channel back, so
    // nothing was sent anywhere on it.
    return observed.kind !== "none" || routerHeld
  }
  if (observed.kind === "suppressed" || observed.kind === "shown") return true
  return observed.kind === "received" && receivedIsShown && expect.kind === "shown"
}

const HELD_RESULTS = new Set(["suppressed", "no_device", "no_target"])

function routerHeld(obs: PhaseObservation, notificationId: string, surface: Surface): boolean {
  const channel = channelOf(surface)
  return obs.deliveries.some(
    (d) =>
      d.notificationId === notificationId &&
      d.deviceId === null &&
      d.channel === channel &&
      HELD_RESULTS.has(d.result),
  )
}

function routerRowFor(obs: PhaseObservation, notificationId: string, r: RouterExpect) {
  return obs.deliveries.find(
    (d) =>
      d.notificationId === notificationId &&
      d.deviceId === null &&
      d.channel === r.channel &&
      d.result === r.result &&
      (r.reason === undefined || d.reason === r.reason),
  )
}

function formatRouter(r: RouterExpect): string {
  return `${r.channel}:${r.result}${r.reason ? `/${r.reason}` : ""}`
}

function expectedCount(phase: Phase): number {
  return phase.repeat ?? 1
}

/**
 * True when the phase can stop polling: every cell is decided, or the window
 * is over. The runner calls it after each poll.
 */
export function isSettled(
  phase: Phase,
  obs: PhaseObservation,
  elapsedMs: number,
  enabled: readonly Controller[],
): boolean {
  const windowMs = phase.windowMs ?? DEFAULT_WINDOW_MS
  if (elapsedMs >= windowMs) return true
  if (phase.deviceCheck) return obs.deviceCheck?.ok === true
  const shownOk = new Set(obs.receivedCountsAsShown ?? [])
  // Shown/suppressed expectations need every expected notification present.
  const wantsSome = Object.values(phase.expect).some((e) => e && e.kind !== "none")
  // A repeated trigger waits for all of its notifications, whatever it expects.
  const repeated = (phase.repeat ?? 1) > 1 && phase.trigger.type !== "none"
  if ((wantsSome || repeated) && obs.notificationIds.length < expectedCount(phase)) return false
  for (const [surface, expect] of Object.entries(phase.expect) as Array<[Surface, Expect]>) {
    if (!enabled.includes(controllerOf(surface))) continue
    if (expect.kind === "none" && obs.notificationIds.length === 0) return false
    const ids = idsForSurface(obs, surface)
    if (expect.kind !== "none" && ids.length < expectedCount(phase)) return false
    for (const id of ids) {
      const o = observeSurface(obs, id, surface, windowMs)
      if (!cellDecided(expect, o, shownOk.has(surface), routerHeld(obs, id, surface))) return false
    }
  }
  for (const r of phase.router ?? []) {
    if (obs.notificationIds.length === 0) return false
    if (!obs.notificationIds.every((id) => routerRowFor(obs, id, r))) return false
  }
  return true
}

/** Every cell of one phase, judged. Called once the phase is settled. */
export function evaluatePhase(
  caseId: string,
  phase: Phase,
  obs: PhaseObservation,
  enabled: readonly Controller[],
): CellResult[] {
  const windowMs = phase.windowMs ?? DEFAULT_WINDOW_MS
  const shownOk = new Set(obs.receivedCountsAsShown ?? [])
  const cells: CellResult[] = []
  const base = { caseId, phase: phase.label }

  if (phase.deviceCheck) {
    const check = obs.deviceCheck
    cells.push({
      ...base,
      cell: `registration:${phase.deviceCheck.surface}`,
      expected: `registered within ${Math.round(phase.deviceCheck.withinMs / 1000)}s`,
      observed: check ? check.detail : "not checked",
      status: check?.ok ? "match" : "mismatch",
      evidence: check?.evidence ?? [],
    })
  }

  const wanted = expectedCount(phase)
  for (const [surface, expect] of Object.entries(phase.expect) as Array<[Surface, Expect]>) {
    const expected = formatExpect(expect)
    if (!enabled.includes(controllerOf(surface))) {
      cells.push({
        ...base,
        cell: surface,
        expected,
        observed: "-",
        status: "skipped",
        evidence: [],
        note: `surface ${controllerOf(surface)} not in this run`,
      })
      continue
    }
    const per = idsForSurface(obs, surface).map((id) => ({
      id,
      o: observeSurface(obs, id, surface, windowMs),
    }))
    let ok = per.every(({ o }) => matches(expect, o, shownOk.has(surface)))
    let note: string | undefined
    if (expect.kind !== "none" && per.length < wanted) {
      ok = false
      note = `expected ${wanted} notification(s), the log shows ${per.length}`
    }
    const observedKinds = [...new Set(per.map(({ o }) => formatObserved(o)))]
    const receivedAsShown =
      expect.kind === "shown" && shownOk.has(surface) && per.some(({ o }) => o.kind === "received")
    cells.push({
      ...base,
      cell: surface,
      expected: wanted > 1 ? `${expected} x${wanted}` : expected,
      observed: per.length === 0 ? "none (no notification in the log)" : observedKinds.join(" | "),
      status: ok ? "match" : "mismatch",
      evidence: [
        ...per.map(({ id }) => `notification:${id}`),
        ...per.flatMap(({ o }) => o.evidence),
      ],
      ...(note
        ? { note }
        : receivedAsShown
          ? { note: "received + OS presentation counts as shown (A3)" }
          : {}),
    })
  }

  for (const r of phase.router ?? []) {
    const rows = obs.notificationIds.map((id) => routerRowFor(obs, id, r))
    const ok = obs.notificationIds.length > 0 && rows.every(Boolean)
    const seen = obs.deliveries
      .filter(
        (d) =>
          obs.notificationIds.includes(d.notificationId) &&
          d.deviceId === null &&
          d.channel === r.channel,
      )
      .map((d) => `${d.channel}:${d.result}${d.reason ? `/${d.reason}` : ""}`)
    cells.push({
      ...base,
      cell: `router:${r.channel}`,
      expected: formatRouter(r),
      observed: seen.length > 0 ? [...new Set(seen)].join(" | ") : "no router row",
      status: ok ? "match" : "mismatch",
      evidence: rows.filter((d) => d !== undefined).map((d) => `delivery:${d.id}`),
    })
  }
  return cells
}

/** One status for a list of cells: any mismatch/error wins, then gaps. */
export function rollUp(cells: CellResult[]): CellStatus {
  const has = (s: CellStatus) => cells.some((c) => c.status === s)
  if (has("error")) return "error"
  if (has("mismatch")) return "mismatch"
  if (has("human-pending")) return "human-pending"
  if (cells.length === 0 || cells.every((c) => c.status === "skipped")) return "skipped"
  if (has("skipped")) return "skipped"
  return "match"
}

/**
 * The notifications a phase raised: the ids the trigger answered when it
 * answers them (QA inject, test route), otherwise every notification the log
 * shows for the recipient since the trigger.
 */
export function notificationIdsFrom(
  answered: string[],
  deliveries: PhaseObservation["deliveries"],
  sinceMs: number,
  /** Ids already in the log just before the trigger: never this phase's (cases run back to back). */
  before: ReadonlySet<string> = new Set(),
): string[] {
  if (answered.length > 0) return [...new Set(answered)]
  const ids: string[] = []
  for (const d of deliveries) {
    if (Date.parse(d.attemptedAt) < sinceMs) continue
    if (before.has(d.notificationId)) continue
    if (!ids.includes(d.notificationId)) ids.push(d.notificationId)
  }
  return ids
}

/**
 * Where a judging phase (`observePhase`) opens its window: when it starts
 * changing the surfaces, minus the clock slack. The state change can itself be
 * what delivers (a desktop relaunch replays what it missed, A5), so a window
 * opened at the trigger, after the relaunch, would miss those receipts.
 */
export function observeWindowFrom(
  phaseStartedAt: number,
  _triggeredAt: number,
  slackMs: number,
): number {
  return phaseStartedAt - slackMs
}

/**
 * Whether the human is the phase's trigger: the first phase of a human cell
 * that fires nothing itself (he taps "Send me a test" on the phone).
 */
export function humanIsTrigger(phase: Phase, human: boolean, index: number): boolean {
  return human && index === 0 && phase.trigger.type === "none"
}

/** How long before his signal a human trigger may have acted. */
export const HUMAN_LEAD_MS = 5 * 60_000

/**
 * Where a phase's log opens (before the clock slack). When the human is the
 * trigger he may act before signalling the runner (TF-test-button 2026-10-12:
 * tapped 20 s before the signal, the log opened at the signal and read 0), so
 * it opens when the cell was announced, but no more than `leadMs` before the
 * signal: the log route answers its oldest 500 rows first, and a cell may wait
 * an hour for its human.
 */
export function logOpensAt(
  humanTrigger: boolean,
  announcedAt: number,
  triggeredAt: number,
  leadMs: number = HUMAN_LEAD_MS,
): number {
  return humanTrigger ? Math.max(announcedAt, triggeredAt - leadMs) : triggeredAt
}

/**
 * Time elapsed in the window of a phase the human triggers, for isSettled.
 * Until the first delivery of its notifications shows up the phase is waiting
 * for the human (0), up to `humanWaitMs` after the signal; from then on the
 * window runs from that first delivery row (server clock).
 */
export function humanTriggeredElapsed(
  obs: PhaseObservation,
  now: number,
  signalledAt: number,
  humanWaitMs: number,
): number {
  let first = Number.POSITIVE_INFINITY
  for (const d of obs.deliveries) {
    if (!obs.notificationIds.includes(d.notificationId)) continue
    first = Math.min(first, Date.parse(d.attemptedAt))
  }
  if (Number.isFinite(first)) return Math.max(0, now - first)
  const waited = now - signalledAt
  return waited >= humanWaitMs ? Number.POSITIVE_INFINITY : 0
}

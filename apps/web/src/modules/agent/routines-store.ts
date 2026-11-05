// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent routines store — mirrors `/api/agent/routines*`. The cron preview
 * lives in `cron-preview.ts`, so `cron-parser` loads only with the views
 * that show it.
 */

import type { ReasoningLevel } from "@liaison/shared"
import { createStore, produce } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { englishT } from "~/modules/i18n/i18n-context"
import type { Message } from "~/modules/threads/message-store"

export type RoutineStatus =
  | "active"
  | "paused_scope_mismatch"
  | "paused_no_credits"
  | "paused_user"
  | "paused_app_disabled"
  | "completed"

export type RoutineKind = "recurring" | "scheduled" | "event"
export type RoutineVisibility = "personal" | "shared"

/** Where a routine runs (S21): the cloud, the owner's node, or the node else the cloud. */
export type RoutineRunsOn = "cloud" | "node" | "node_else_cloud"

/** Who approves a routine's drafts (S29): the default audience, or its owner alone. */
export type RoutineApprover = "default" | "owner"

/** Sender filter of a new-mail routine (S26): contact ids and contact group ids. */
export interface RoutineEventFilter {
  fromContactIds?: string[]
  fromGroupIds?: string[]
}

export interface RoutineRow {
  id: string
  orgId: string
  ownerUserId: string
  /** The agent this routine runs as. Its seats decide where the routine may
   *  post, which is what the destination picker filters on. */
  ownerAgentId: string | null
  name: string
  description: string
  kind: RoutineKind
  cron: string | null
  timezone: string | null
  runAt: string | null
  /** For kind:"event": the `app:entity:action` this routine fires on. */
  event: string | null
  prompt: string
  /** The routine's own run thread (internal: always its own, made on first run). */
  outputThreadId: string | null
  /** Where the routine posts its runs: a conversation or channel, null for only its own run thread. */
  reportThreadId?: string | null
  scopes: string[]
  visibility: RoutineVisibility
  /** Per-routine agent model + reasoning override — null falls back to the output thread's
   *  own setting, and finally the org auto-select / off. See RoutineDetail's model picker. */
  agentModelId: string | null
  agentReasoningLevel: ReasoningLevel | null
  /** Soft token budget told to the agent each run, and the hard stop (S17). Null = none.
   *  Optional on the row type: a server older than migration 0125 omits them. */
  tokenBudget?: number | null
  hardTokenLimit?: number | null
  /** Where each run happens (S21). Optional: a server older than 0129 omits it (= cloud). */
  runsOn?: RoutineRunsOn
  /** Where a node run works and on which model (L26): a shared folder's name, or a git
   *  URL the node clones, and a model id. Null = the agent's folder and model. */
  folder?: string | null
  repo?: string | null
  model?: string | null
  /** Sender filter of a mail:message:create routine (S26). Optional: older servers omit it. */
  eventFilter?: RoutineEventFilter | null
  /** Who approves its drafts (S29). Optional: older servers omit it (= default). */
  approver?: RoutineApprover
  enabled: boolean
  status: RoutineStatus
  lastRunAt: string | null
  lastRunStatus: string | null
  lastRunError: string | null
  createdAt: string
  updatedAt: string
  /** The server's A15 answer for THIS viewer (P4c-T32b). Never recomputed here. */
  canWrite?: boolean
}

export interface RoutineRunRow {
  id: string
  routineId: string
  ranAt: string
  status: string
  durationMs: number | null
  errorMessage: string | null
  scheduledAt?: string | null
  /** What started the run (0157); null on runs recorded before it was kept. */
  trigger?: "schedule" | "event" | "manual" | "retry" | null
  /** The event that fired an event run, as `app.entity.action`. */
  triggerLabel?: string | null
  startedAt?: string | null
  /** The run's last agent line. Absent (not null) on a row the socket pushed,
   *  which the history then reads again from the server. */
  summary?: string | null
  messageCount?: number
  hasTranscript?: boolean
  outputThreadId?: string | null
}

/** One run's transcript: its slice of the routine's output thread. */
export interface RoutineRunTranscript {
  run: RoutineRunRow
  outputThreadId: string | null
  messages: Message[]
}

/** An app-provided routine template (Component A §3.5). */
export interface RoutineTemplateRow {
  appName: string
  templateKey: string
  description: string
  kind: string
  /** True when an instance already exists for the org. */
  enabled: boolean
}

/** One subscribable event, as `/agent/routines/events` returns it. */
export interface RoutineEventRow {
  /** The whole `app:entity:action` string, which is what a routine stores. */
  event: string
  app: string
  entity: string
  action: string
  description?: string
}

interface RoutinesState {
  routines: RoutineRow[]
  loading: boolean
  error: string | null
  /** Run history per routine id (loaded lazily on detail open) */
  runs: Record<string, RoutineRunRow[]>
  /** Per routine: the server has runs older than the ones loaded. */
  runsHasMore: Record<string, boolean>
  openDetailId: string | null
  /** App-provided routine templates available to enable. */
  templates: RoutineTemplateRow[]
  /**
   * P4c-T36: the agent page's Routines tab asks "what does THIS agent own",
   * which is a different list from the flat screen's mine/shared union. It is
   * cached per ownerAgentId so the two surfaces, both mounted at once in the
   * shell, never clobber each other's rows.
   */
  byAgent: Record<string, RoutineRow[]>
  /** The subscribable event catalog, as `/agent/routines/events` returns it. */
  events: RoutineEventRow[]
}

const [routinesStore, setRoutinesStore] = createStore<RoutinesState>({
  routines: [],
  loading: false,
  error: null,
  runs: {},
  runsHasMore: {},
  openDetailId: null,
  templates: [],
  byAgent: {},
  events: [],
})

export { routinesStore }

export function setOpenRoutineDetailId(id: string | null): void {
  setRoutinesStore("openDetailId", id)
}

const CREATE_TIMEOUT_MS = 10_000

export async function loadRoutines(
  api: ApiClient,
  opts?: { visibility?: "mine" | "shared" | "all"; ownerAgentId?: string },
): Promise<void> {
  const ownerAgentId = opts?.ownerAgentId
  setRoutinesStore("loading", true)
  setRoutinesStore("error", null)
  try {
    if (ownerAgentId) {
      const data =
        (await api.get<RoutineRow[]>(
          `/agent/routines?ownerAgentId=${encodeURIComponent(ownerAgentId)}`,
        )) ?? []
      setRoutinesStore("byAgent", ownerAgentId, Array.isArray(data) ? data : [])
    } else if (opts?.visibility === "all") {
      // Fetch both buckets in parallel and dedupe by id — sub-tabs filter
      // client-side from a single union list rather than refetching per click.
      const [mine, shared] = await Promise.all([
        api.get<RoutineRow[]>("/agent/routines").then((d) => d ?? []),
        api.get<RoutineRow[]>("/agent/routines?visibility=shared").then((d) => d ?? []),
      ])
      const byId = new Map<string, RoutineRow>()
      for (const r of mine) byId.set(r.id, r)
      for (const r of shared) if (!byId.has(r.id)) byId.set(r.id, r)
      setRoutinesStore("routines", Array.from(byId.values()))
    } else {
      const query = opts?.visibility === "shared" ? "?visibility=shared" : ""
      const data = (await api.get<RoutineRow[]>(`/agent/routines${query}`)) ?? []
      setRoutinesStore("routines", Array.isArray(data) ? data : [])
    }
  } catch (err) {
    setRoutinesStore("error", err instanceof Error ? err.message : "Failed to load routines")
  } finally {
    setRoutinesStore("loading", false)
  }
}

/** The rows one surface reads: an agent's own list, or the flat listing. */
export function routinesForAgent(ownerAgentId?: string): RoutineRow[] {
  if (!ownerAgentId) return routinesStore.routines
  return routinesStore.byAgent[ownerAgentId] ?? []
}

/** Apply `fn` to the flat list AND to every per-agent bucket, so a mutation
 *  made on one surface is visible on the other without a refetch. */
function mapEveryRoutineList(fn: (rows: RoutineRow[]) => RoutineRow[]): void {
  setRoutinesStore("routines", (prev) => fn(prev))
  for (const key of Object.keys(routinesStore.byAgent)) {
    setRoutinesStore("byAgent", key, (prev) => fn(prev ?? []))
  }
}

/** The row behind an id, wherever it is cached. */
export function findRoutineRow(id: string): RoutineRow | undefined {
  const flat = routinesStore.routines.find((r) => r.id === id)
  if (flat) return flat
  for (const key of Object.keys(routinesStore.byAgent)) {
    const hit = (routinesStore.byAgent[key] ?? []).find((r) => r.id === id)
    if (hit) return hit
  }
  return undefined
}

/** One page of a run history, newest first. */
export const RUN_PAGE_SIZE = 50

/** The routine's latest runs (the first page). */
export async function loadRoutineRuns(api: ApiClient, routineId: string): Promise<void> {
  try {
    // The server's own page size is RUN_PAGE_SIZE, so the first page asks bare.
    const data = (await api.get<RoutineRunRow[]>(`/agent/routines/${routineId}/runs`)) ?? []
    const rows = Array.isArray(data) ? data.map(normalizeRunRow) : []
    setRoutinesStore("runs", routineId, rows)
    setRoutinesStore("runsHasMore", routineId, rows.length >= RUN_PAGE_SIZE)
  } catch {
    setRoutinesStore("runs", routineId, [])
    setRoutinesStore("runsHasMore", routineId, false)
  }
}

/** The page of runs older than the oldest one loaded, appended. */
export async function loadOlderRoutineRuns(api: ApiClient, routineId: string): Promise<void> {
  const loaded = routinesStore.runs[routineId] ?? []
  const oldest = loaded[loaded.length - 1]
  if (!oldest) return loadRoutineRuns(api, routineId)
  const data =
    (await api.get<RoutineRunRow[]>(
      `/agent/routines/${routineId}/runs?limit=${RUN_PAGE_SIZE}&before=${encodeURIComponent(oldest.id)}`,
    )) ?? []
  const rows = Array.isArray(data) ? data.map(normalizeRunRow) : []
  const seen = new Set(loaded.map((r) => r.id))
  setRoutinesStore("runs", routineId, [...loaded, ...rows.filter((r) => !seen.has(r.id))])
  setRoutinesStore("runsHasMore", routineId, rows.length >= RUN_PAGE_SIZE)
}

/** The server row names its failure `error`; the client reads `errorMessage`. */
function normalizeRunRow(row: RoutineRunRow & { error?: string | null }): RoutineRunRow {
  return { ...row, errorMessage: row.errorMessage ?? row.error ?? null }
}

/** One run's transcript, read on demand (never cached: a run is opened rarely,
 *  and its messages are the thread's, which the thread view owns). */
export async function loadRoutineRunTranscript(
  api: ApiClient,
  routineId: string,
  runId: string,
): Promise<RoutineRunTranscript> {
  const data = await api.get<RoutineRunTranscript>(
    `/agent/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(runId)}/messages`,
  )
  return {
    run: normalizeRunRow(data.run),
    outputThreadId: data.outputThreadId ?? null,
    messages: Array.isArray(data.messages) ? data.messages : [],
  }
}

/** Load app-provided routine templates the caller's org can enable. */
export async function loadRoutineTemplates(api: ApiClient): Promise<void> {
  try {
    const data = (await api.get<RoutineTemplateRow[]>("/agent/routines/templates")) ?? []
    setRoutinesStore("templates", Array.isArray(data) ? data : [])
  } catch {
    setRoutinesStore("templates", [])
  }
}

/**
 * The events a kind:"event" routine can subscribe to. Loaded on demand (the
 * event picker opening), never with the routines list: a person who never picks
 * the event kind never pays for the catalog.
 */
export async function loadRoutineEvents(
  api: ApiClient,
  opts?: { app?: string; entity?: string },
): Promise<void> {
  const params = new URLSearchParams()
  if (opts?.app) params.set("app", opts.app)
  if (opts?.entity) params.set("entity", opts.entity)
  const query = params.size > 0 ? `?${params.toString()}` : ""
  try {
    const data = (await api.get<RoutineEventRow[]>(`/agent/routines/events${query}`)) ?? []
    setRoutinesStore("events", Array.isArray(data) ? data : [])
  } catch {
    setRoutinesStore("events", [])
  }
}

/** Enable (instantiate) an app routine template; refreshes routines + templates. */
export async function enableRoutineTemplate(
  api: ApiClient,
  appName: string,
  templateKey: string,
): Promise<void> {
  await api.post(`/agent/routines/templates/${appName}/${templateKey}/enable`, {})
  // Reflect the new instance + flip the template's enabled flag.
  await Promise.all([loadRoutines(api, { visibility: "all" }), loadRoutineTemplates(api)])
}

export interface CreateRoutineInput {
  name: string
  description: string
  kind?: RoutineKind
  cron?: string
  timezone?: string
  runAt?: string
  /** For kind:"event" only, and then WITHOUT cron/timezone/runAt: the DB check
   *  constraint and the request schema both refuse a routine carrying both. */
  event?: string
  prompt: string
  scopes: string[]
  visibility?: RoutineVisibility
  enabled?: boolean
  agentModelId?: string | null
  agentReasoningLevel?: ReasoningLevel | null
  tokenBudget?: number | null
  hardTokenLimit?: number | null
  runsOn?: RoutineRunsOn
  eventFilter?: RoutineEventFilter | null
  approver?: RoutineApprover
  /** Create the routine FOR this agent (P4c-T32b). A15 decides on the server:
   *  a refusal is a 403 `agent_write_forbidden`, never a silent relocation. */
  ownerAgentId?: string
  /** A node routine's folder (or repo) and model, saved WITH the routine (m7, REST only). */
  nodePlacement?: RoutineNodePlacement
}

/** Promise.race wrapper that rejects after `ms` regardless of whether the inner
 *  promise respects an AbortSignal — so a fully-mocked API in tests still
 *  surfaces a timeout, not a hang. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export async function createRoutine(
  api: ApiClient,
  input: CreateRoutineInput,
): Promise<RoutineRow> {
  // No optimistic insert: the server fills owner+org+ids; the row is the
  // authority. Rollback by simply not appending if the request fails.
  const created = await withTimeout(
    api.post<RoutineRow>("/agent/routines", input),
    CREATE_TIMEOUT_MS,
    "createRoutine",
  )
  // The created row lands in the list the caller is looking at.
  if (input.ownerAgentId) {
    // The server just let this caller write for that agent (A15), so its row is writable by
    // them; without the flag the agent tab hid Edit (and the scope picker) until a reload.
    const row = { ...created, canWrite: true }
    setRoutinesStore("byAgent", input.ownerAgentId, (prev) => [row, ...(prev ?? [])])
  } else {
    setRoutinesStore("routines", (prev) => [created, ...prev])
  }
  return created
}

export interface UpdateRoutineInput {
  name?: string
  description?: string
  kind?: RoutineKind
  cron?: string
  timezone?: string
  runAt?: string
  event?: string
  prompt?: string
  scopes?: string[]
  visibility?: RoutineVisibility
  enabled?: boolean
  agentModelId?: string | null
  agentReasoningLevel?: ReasoningLevel | null
  tokenBudget?: number | null
  hardTokenLimit?: number | null
  runsOn?: RoutineRunsOn
  eventFilter?: RoutineEventFilter | null
  approver?: RoutineApprover
  /** Where this routine posts its runs (a conversation or channel). Null: only its own run thread. */
  reportThreadId?: string | null
  /** A node routine's folder (or repo) and model, saved WITH the edit (m7); the owner's only. */
  nodePlacement?: RoutineNodePlacement
}

export async function updateRoutine(
  api: ApiClient,
  id: string,
  input: UpdateRoutineInput,
): Promise<RoutineRow> {
  const snapshot = findRoutineRow(id)
  const { nodePlacement, ...fields } = input
  mapEveryRoutineList((prev) =>
    prev.map((r) =>
      r.id === id ? ({ ...r, ...fields, ...(nodePlacement ?? {}) } as RoutineRow) : r,
    ),
  )
  try {
    const updated = await api.put<RoutineRow>(`/agent/routines/${id}`, input)
    mapEveryRoutineList((prev) => prev.map((r) => (r.id === id ? { ...r, ...updated } : r)))
    return updated
  } catch (err) {
    if (snapshot) {
      mapEveryRoutineList((prev) => prev.map((r) => (r.id === id ? snapshot : r)))
    }
    throw err
  }
}

export async function deleteRoutine(api: ApiClient, id: string): Promise<void> {
  const snapshot = findRoutineRow(id)
  const owner = snapshot?.ownerAgentId ?? null
  mapEveryRoutineList((prev) => prev.filter((r) => r.id !== id))
  try {
    await api.delete(`/agent/routines/${id}`)
  } catch (err) {
    if (snapshot) {
      if (owner && routinesStore.byAgent[owner]) {
        setRoutinesStore("byAgent", owner, (prev) => [snapshot, ...(prev ?? [])])
      } else {
        setRoutinesStore("routines", (prev) => [snapshot, ...prev])
      }
    }
    throw err
  }
}

export async function runRoutineNow(api: ApiClient, id: string): Promise<void> {
  const nowIso = new Date().toISOString()
  // Optimistically bump lastRunAt — server will overwrite with the worker's
  // real ranAt on the next routine:status WS event.
  const snapshot = findRoutineRow(id)
  mapEveryRoutineList((prev) => prev.map((r) => (r.id === id ? { ...r, lastRunAt: nowIso } : r)))
  try {
    await api.post(`/agent/routines/${id}/run-now`, {})
  } catch (err) {
    if (snapshot) {
      mapEveryRoutineList((prev) => prev.map((r) => (r.id === id ? snapshot : r)))
    }
    throw err
  }
}

/** A node routine's folder (or repo, exclusive) and model (L26, P2-D6). */
export interface RoutineNodePlacement {
  folder: string | null
  repo: string | null
  model: string | null
}

// ---- Schedule-picker preset helpers -------------------------------------
// The SchedulePicker emits cron strings for recurring routines via a small set
// of human presets, plus a custom-cron escape hatch.

export type SchedulePreset = "daily" | "weekdays" | "weekly" | "monthly" | "custom"

// kebabCase lives in ~/lib/kebab-case — re-exported here for callers that
// still import from this module.
export { kebabCase } from "~/lib/kebab-case"

/** Local timezone resolved from the browser; falls back to UTC. */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/**
 * Build a 5-field cron string from a preset + a `HH:MM` time (+ optional
 * day-of-week 0–6 for the `weekly` preset). `custom` returns null — the picker
 * uses the raw cron input directly.
 */
export function cronFromPreset(preset: SchedulePreset, time: string, dayOfWeek = 1): string | null {
  const [hRaw, mRaw] = (time || "09:00").split(":")
  const h = Number.parseInt(hRaw ?? "9", 10)
  const m = Number.parseInt(mRaw ?? "0", 10)
  const hh = Number.isFinite(h) ? h : 9
  const mm = Number.isFinite(m) ? m : 0
  switch (preset) {
    case "daily":
      return `${mm} ${hh} * * *`
    case "weekdays":
      return `${mm} ${hh} * * 1-5`
    case "weekly":
      return `${mm} ${hh} * * ${dayOfWeek}`
    case "monthly":
      return `${mm} ${hh} 1 * *`
    case "custom":
      return null
  }
}

/**
 * Best-effort reverse: classify an existing cron string back into a preset +
 * time + day-of-week so the picker can pre-select when editing a routine.
 * Returns `custom` when the cron doesn't match a known preset shape.
 */
export function presetFromCron(cron: string): {
  preset: SchedulePreset
  time: string
  dayOfWeek: number
} {
  const parts = (cron ?? "").trim().split(/\s+/)
  if (parts.length !== 5) return { preset: "custom", time: "09:00", dayOfWeek: 1 }
  const [min, hr, dom, mon, dow] = parts
  const m = Number.parseInt(min, 10)
  const h = Number.parseInt(hr, 10)
  if (!Number.isFinite(m) || !Number.isFinite(h)) {
    return { preset: "custom", time: "09:00", dayOfWeek: 1 }
  }
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
  if (dom === "*" && mon === "*" && dow === "*") return { preset: "daily", time, dayOfWeek: 1 }
  if (dom === "*" && mon === "*" && dow === "1-5") {
    return { preset: "weekdays", time, dayOfWeek: 1 }
  }
  if (dom === "1" && mon === "*" && dow === "*") return { preset: "monthly", time, dayOfWeek: 1 }
  if (dom === "*" && mon === "*" && /^[0-6]$/.test(dow)) {
    return { preset: "weekly", time, dayOfWeek: Number.parseInt(dow, 10) }
  }
  return { preset: "custom", time, dayOfWeek: 1 }
}

// ---- Human-readable schedule descriptions -------------------------------
// Cron syntax is an implementation detail — it must never reach the user. The
// helpers below are the single source of truth for rendering a routine's
// schedule as plain English, shared by the list and the detail view.

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/**
 * `HH:MM` (24h) as the reader's clock: `9 AM`, `2:30 PM` in English, `09:00`,
 * `14:30` in French. A French schedule read "Every Monday at 8:30 AM".
 */
export function formatClockTime(time: string, locale = "en"): string {
  const [hRaw, mRaw] = (time || "09:00").split(":")
  let h = Number.parseInt(hRaw ?? "9", 10)
  let m = Number.parseInt(mRaw ?? "0", 10)
  if (!Number.isFinite(h)) h = 9
  if (!Number.isFinite(m)) m = 0
  if (!locale.startsWith("en")) {
    return new Date(2026, 0, 5, h, m).toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    })
  }
  const period = h < 12 ? "AM" : "PM"
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12} ${period}` : `${h12}:${String(m).padStart(2, "0")} ${period}`
}

/**
 * Turn a 5-field cron string into a plain-English phrase — "Every weekday at
 * 9 AM" rather than `0 9 * * 1-5`. Built on `presetFromCron`, so it covers the
 * preset shapes the SchedulePicker emits; an unrecognized (hand-typed custom)
 * cron falls back to the raw expression.
 */
export function describeCron(cron: string, i18n: ScheduleLocale = ENGLISH_SCHEDULE): string {
  const trimmed = (cron ?? "").trim()
  if (!trimmed) return i18n.t("kernel.agentUi.schedule.none")
  const { preset, time, dayOfWeek } = presetFromCron(trimmed)
  const at = formatClockTime(time, i18n.locale)
  switch (preset) {
    case "daily":
      return i18n.t("kernel.agentUi.schedule.daily", { time: at })
    case "weekdays":
      return i18n.t("kernel.agentUi.schedule.weekdays", { time: at })
    case "weekly":
      return i18n.t("kernel.agentUi.schedule.weekly", {
        day: weekdayName(dayOfWeek, i18n.locale),
        time: at,
      })
    case "monthly":
      return i18n.t("kernel.agentUi.schedule.monthly", { time: at })
    case "custom":
      return trimmed
  }
}

/** What the schedule wording needs: the reader's translator and locale. */
export interface ScheduleLocale {
  t: (key: string, params?: Record<string, string>) => string
  locale: string
}

const ENGLISH_SCHEDULE: ScheduleLocale = { t: englishT, locale: "en" }

/** 0 = Sunday. English keeps its capitalised names; other locales ask Intl. */
function weekdayName(dayOfWeek: number, locale: string): string {
  if (locale.startsWith("en")) return WEEKDAY_NAMES[dayOfWeek] ?? "week"
  return new Date(2026, 5, 7 + dayOfWeek).toLocaleDateString(locale, { weekday: "long" })
}

/**
 * Single source of truth for a routine's human-readable schedule line. Used by
 * both the routines list and the detail view so the wording never diverges.
 * Recurring routines describe their cadence; one-shot ("scheduled") routines
 * describe their absolute run time.
 */
/**
 * An `app:entity:action` event as a person reads it: "Tickets: ticket replied".
 * The raw string stays available beside it wherever the choice is being made,
 * because it is what the routine actually stores and what support will ask for.
 */
export function describeRoutineEvent(event: string): string {
  const parts = (event ?? "").split(":")
  if (parts.length !== 3) return event ?? ""
  const [app, entity, action] = parts
  const words = (s: string) => s.replace(/[_-]+/g, " ").trim()
  const appLabel = words(app)
  return `${appLabel.charAt(0).toUpperCase()}${appLabel.slice(1)}: ${words(entity)} ${words(action)}`
}

export function describeSchedule(
  r: Pick<RoutineRow, "kind" | "cron" | "timezone" | "runAt"> & { event?: string | null },
  opts?: { withTimezone?: boolean; i18n?: ScheduleLocale },
): string {
  const i18n = opts?.i18n ?? ENGLISH_SCHEDULE
  // An event routine has no cadence and no clock: it says what fires it.
  if (r.kind === "event") {
    return r.event
      ? i18n.t("kernel.agentUi.schedule.whenEvent", { event: describeRoutineEvent(r.event) })
      : i18n.t("kernel.agentUi.schedule.whenAnyEvent")
  }
  if (r.kind === "scheduled") {
    if (!r.runAt) return i18n.t("kernel.agentUi.schedule.once")
    return i18n.t("kernel.agentUi.schedule.onceAt", {
      when: new Date(r.runAt).toLocaleString(i18n.locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    })
  }
  const base = describeCron(r.cron ?? "", i18n)
  if (opts?.withTimezone && r.timezone) return `${base} · ${r.timezone}`
  return base
}

// ---- WebSocket handlers --------------------------------------------------
export interface RoutineStatusMessage {
  type: "routine:status"
  routineId: string
  status?: RoutineStatus
  lastRunAt?: string | null
  lastRunStatus?: string | null
  lastRunError?: string | null
}

export interface RoutineRunCompletedMessage {
  type: "routine:run_completed"
  routineId: string
  run: RoutineRunRow
}

export function onRoutineStatus(msg: RoutineStatusMessage): void {
  const patch = produce((arr: RoutineRow[]) => {
    const idx = arr.findIndex((r) => r.id === msg.routineId)
    if (idx >= 0) {
      if (msg.status !== undefined) arr[idx].status = msg.status
      if (msg.lastRunAt !== undefined) arr[idx].lastRunAt = msg.lastRunAt
      if (msg.lastRunStatus !== undefined) arr[idx].lastRunStatus = msg.lastRunStatus
      if (msg.lastRunError !== undefined) arr[idx].lastRunError = msg.lastRunError
    }
  })
  setRoutinesStore("routines", patch)
  for (const key of Object.keys(routinesStore.byAgent)) {
    setRoutinesStore("byAgent", key, patch)
  }
}

export function onRoutineRunCompleted(msg: RoutineRunCompletedMessage): void {
  // Append to the in-memory run history if we already have a list for this routine.
  // A node run is listed `dispatched` first and settles later under the same
  // id: replace that row rather than list the run twice.
  if (routinesStore.runs[msg.routineId]) {
    setRoutinesStore("runs", msg.routineId, (prev) =>
      prev.some((r) => r.id === msg.run.id)
        ? prev.map((r) => (r.id === msg.run.id ? msg.run : r))
        : [msg.run, ...prev],
    )
  }
  // Also reflect on the routine row's last-run fields.
  const patch = produce((arr: RoutineRow[]) => {
    const idx = arr.findIndex((r) => r.id === msg.routineId)
    if (idx >= 0) {
      arr[idx].lastRunAt = msg.run.ranAt
      arr[idx].lastRunStatus = msg.run.status
      arr[idx].lastRunError = msg.run.errorMessage
    }
  })
  setRoutinesStore("routines", patch)
  for (const key of Object.keys(routinesStore.byAgent)) {
    setRoutinesStore("byAgent", key, patch)
  }
}

export function resetRoutinesStore(): void {
  setRoutinesStore({
    routines: [],
    loading: false,
    error: null,
    runs: {},
    runsHasMore: {},
    openDetailId: null,
    templates: [],
    byAgent: {},
    events: [],
  })
}

onSessionTeardown(resetRoutinesStore)

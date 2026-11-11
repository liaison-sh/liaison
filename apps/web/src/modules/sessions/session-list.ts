// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSIONS LIST (P2-T06; S8 list, S10, S9). The groups the Sessions app
// shows, derived from every row the session store holds, so a live
// `node_session` frame for a session this page never fetched lands in its group
// with no fetch. A row's status is its true one, `state ?? status` (D14):
//
//   needs_you  waiting; needs_you ended within 30 days      oldest need first
//   running    queued, running, paused, any unknown status   newest start first
//   done       done, ended within 30 days                    newest end first
//   failed     failed, stopped, ended within 30 days         newest end first
//   older      any ended status, ended earlier               newest end first
//
// Each group loads its pages by cursor (`loadGroup`, `loadMore`) and keeps its
// own idle / loading / error / ready state, so a failed group says so instead
// of looking empty. An API older than S9 refuses the ids needs_you and failed
// (400): the list then reads its old ids (waiting, done) for the rest of the
// page; the rows still land in their groups by status. `ensureListLoaded`
// loads the four live groups once per page (the rail badge is right before the
// app is opened), and again on a socket resync and on window focus.
// `needsYouCount` is the rail badge.

import { createStore } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { log } from "~/lib/logger"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { sessionState } from "./display"
import {
  listSessions,
  type NodeSessionGroup,
  type NodeSessionGroupQuery,
  type NodeSessionRow,
} from "./session-api"
import { applyRow, sessionStore } from "./session-store"

export const OLDER_AFTER_MS = 30 * 86_400_000

export type GroupStatus = "idle" | "loading" | "error" | "ready"

export interface GroupState {
  status: GroupStatus
  nextCursor: string | null
}

const GROUPS: readonly NodeSessionGroup[] = ["needs_you", "running", "done", "failed", "older"]
/** The groups the list shows open, in display order (Older is collapsed below). */
export const LIVE_GROUPS: readonly NodeSessionGroup[] = ["needs_you", "running", "done", "failed"]

/** The ids an API older than S9 knows, for the groups it does not. */
const LEGACY_QUERY: Partial<Record<NodeSessionGroup, NodeSessionGroupQuery>> = {
  needs_you: "waiting",
  failed: "done",
}
/** Set once the API refused an S9 group id: read the old ids from then on. */
let legacyGroups = false

function queryOf(group: NodeSessionGroup): NodeSessionGroupQuery {
  return legacyGroups ? (LEGACY_QUERY[group] ?? group) : group
}

function initialGroups(): Record<NodeSessionGroup, GroupState> {
  return Object.fromEntries(GROUPS.map((g) => [g, { status: "idle", nextCursor: null }])) as Record<
    NodeSessionGroup,
    GroupState
  >
}

const [groups, setGroups] = createStore<Record<NodeSessionGroup, GroupState>>(initialGroups())

type Api = Pick<ApiClient, "get">
let apiOf: () => Api | null = () => null

/** Where the list's reads go (the kernel API client; null while signed out). */
export function setSessionListApi(getter: () => Api | null): void {
  apiOf = getter
}

function time(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(t) ? t : 0
}

/** The group a row belongs to at `now`; an unknown status is Running (S9). */
export function groupOf(row: NodeSessionRow, now: number = Date.now()): NodeSessionGroup {
  const status = sessionState(row)
  if (status === "waiting") return "needs_you"
  const ended = (group: NodeSessionGroup): NodeSessionGroup =>
    now - time(row.endedAt ?? row.updatedAt) > OLDER_AFTER_MS ? "older" : group
  switch (status) {
    case "needs_you":
      return ended("needs_you")
    case "done":
      return ended("done")
    case "failed":
    case "stopped":
      return ended("failed")
    default:
      return "running"
  }
}

const byEnd = (a: NodeSessionRow, b: NodeSessionRow) =>
  time(b.endedAt ?? b.updatedAt) - time(a.endedAt ?? a.updatedAt)

const SORT: Record<NodeSessionGroup, (a: NodeSessionRow, b: NodeSessionRow) => number> = {
  needs_you: (a, b) => time(a.updatedAt) - time(b.updatedAt),
  running: (a, b) => time(b.startedAt ?? b.createdAt) - time(a.startedAt ?? a.createdAt),
  done: byEnd,
  failed: byEnd,
  older: byEnd,
}

/** The rows of a group, sorted; reactive over the session store. */
export function groupRows(group: NodeSessionGroup, now: number = Date.now()): NodeSessionRow[] {
  return sessionStore
    .rows()
    .filter((r) => groupOf(r, now) === group)
    .sort(SORT[group])
}

export function groupState(group: NodeSessionGroup): GroupState {
  return { status: groups[group].status, nextCursor: groups[group].nextCursor }
}

/** Sessions in the Needs-you group (waiting and needs_you): the rail badge. */
export function needsYouCount(now: number = Date.now()): number {
  return sessionStore.rows().filter((r) => groupOf(r, now) === "needs_you").length
}

/** One computer's sessions running and in Needs you (the Computers page line). */
export function countsByNode(
  nodeId: string,
  now: number = Date.now(),
): { running: number; needsYou: number } {
  let running = 0
  let needsYou = 0
  for (const r of sessionStore.rows()) {
    if (r.nodeId !== nodeId) continue
    const g = groupOf(r, now)
    if (g === "running") running++
    else if (g === "needs_you") needsYou++
  }
  return { running, needsYou }
}

async function fetchPage(
  group: NodeSessionGroup,
  cursor: string | null,
  userInitiated: boolean,
): Promise<void> {
  const api = apiOf()
  if (!api) return
  setGroups(group, "status", "loading")
  const read = (query: NodeSessionGroupQuery) =>
    listSessions(api, query, cursor, userInitiated ? { userInitiated: true } : undefined)
  try {
    const query = queryOf(group)
    let page: Awaited<ReturnType<typeof read>>
    try {
      page = await read(query)
    } catch (err) {
      // An API older than S9: its list route refuses the new group ids.
      const legacy = LEGACY_QUERY[group]
      if (!legacy || query === legacy || !(err instanceof ApiError) || err.status !== 400) throw err
      legacyGroups = true
      page = await read(legacy)
    }
    for (const row of page.sessions) applyRow(row)
    setGroups(group, { status: "ready", nextCursor: page.nextCursor })
  } catch (err) {
    log.warn({ err, group }, "loading node sessions failed")
    setGroups(group, "status", "error")
  }
}

/** The first page of a group (a Retry is the person's own press). */
export function loadGroup(group: NodeSessionGroup, userInitiated = false): Promise<void> {
  return fetchPage(group, null, userInitiated)
}

/** The group's next page, after the cursor of the last one. */
export function loadMore(group: NodeSessionGroup): Promise<void> {
  const cursor = groups[group].nextCursor
  if (!cursor) return Promise.resolve()
  return fetchPage(group, cursor, true)
}

let loaded: Promise<void> | null = null
let uninstall: (() => void) | null = null

function reloadLoaded(): void {
  for (const g of GROUPS) {
    if (LIVE_GROUPS.includes(g) || groups[g].status !== "idle") void loadGroup(g)
  }
}

/** Load waiting, running and done once per page; again on resync and focus. */
export function ensureListLoaded(): Promise<void> {
  if (!uninstall) {
    const unsubscribe = subscribeResync(reloadLoaded)
    const win = typeof window !== "undefined" ? window : null
    win?.addEventListener("focus", reloadLoaded)
    uninstall = () => {
      unsubscribe()
      win?.removeEventListener("focus", reloadLoaded)
    }
  }
  if (!apiOf()) return Promise.resolve()
  if (!loaded) loaded = Promise.all(LIVE_GROUPS.map((g) => loadGroup(g))).then(() => {})
  return loaded
}

/** Sign-out: forget the groups' state (the store forgets the rows itself). */
export function resetSessionListData(): void {
  loaded = null
  legacyGroups = false
  setGroups(initialGroups())
}

onSessionTeardown(resetSessionListData)

/** Tests: forget everything, the wiring included. */
export function resetSessionList(): void {
  uninstall?.()
  uninstall = null
  apiOf = () => null
  resetSessionListData()
}

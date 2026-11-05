// SPDX-License-Identifier: FSL-1.1-ALv2
// @ts-nocheck
// FIXTURE: this file as it was at commit 03b1a52b4 (git show 03b1a52b4:apps/web/src/modules/sessions/session-list.ts),
// only its relative imports re-pointed. old-client.test.tsx runs it as an older client would.
//
//
// THE SESSIONS LIST (P2-T06; S8 list, S10). The groups the Sessions app shows,
// derived from every row the session store holds, so a live `node_session`
// frame for a session this page never fetched lands in its group with no fetch:
//
//   waiting  status waiting                                  oldest need first
//   running  queued, running, paused                         newest start first
//   done     done, stopped, failed, ended within 30 days     newest end first
//   older    the same, ended earlier                         newest end first
//
// Each group loads its pages by cursor (`loadGroup`, `loadMore`) and keeps its
// own idle / loading / error / ready state, so a failed group says so instead
// of looking empty. `ensureListLoaded` loads waiting, running and done once per
// page (the rail badge is right before the app is opened), and again on a
// socket resync and on window focus. `waitingCount` is the rail badge.

import { createStore } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import type { ApiClient } from "~/lib/api-client"
import { log } from "~/lib/logger"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { listSessions, type NodeSessionGroup, type NodeSessionRow } from "../../session-api"
import { applyRow, sessionStore } from "../../session-store"

export const OLDER_AFTER_MS = 30 * 86_400_000

export type GroupStatus = "idle" | "loading" | "error" | "ready"

export interface GroupState {
  status: GroupStatus
  nextCursor: string | null
}

const GROUPS: readonly NodeSessionGroup[] = ["waiting", "running", "done", "older"]
const LIVE_GROUPS: readonly NodeSessionGroup[] = ["waiting", "running", "done"]

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

/** The group a row belongs to at `now`. */
export function groupOf(row: NodeSessionRow, now: number = Date.now()): NodeSessionGroup {
  switch (row.status) {
    case "waiting":
      return "waiting"
    case "queued":
    case "running":
    case "paused":
      return "running"
    default: {
      const ended = time(row.endedAt ?? row.updatedAt)
      return now - ended > OLDER_AFTER_MS ? "older" : "done"
    }
  }
}

const SORT: Record<NodeSessionGroup, (a: NodeSessionRow, b: NodeSessionRow) => number> = {
  waiting: (a, b) => time(a.updatedAt) - time(b.updatedAt),
  running: (a, b) => time(b.startedAt ?? b.createdAt) - time(a.startedAt ?? a.createdAt),
  done: (a, b) => time(b.endedAt ?? b.updatedAt) - time(a.endedAt ?? a.updatedAt),
  older: (a, b) => time(b.endedAt ?? b.updatedAt) - time(a.endedAt ?? a.updatedAt),
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

/** Sessions waiting on the owner: the rail badge. */
export function waitingCount(): number {
  return sessionStore.rows().filter((r) => r.status === "waiting").length
}

/** One node's live sessions (the Nodes page link). */
export function countsByNode(nodeId: string): { running: number; waiting: number } {
  let running = 0
  let waiting = 0
  for (const r of sessionStore.rows()) {
    if (r.nodeId !== nodeId) continue
    const g = groupOf(r)
    if (g === "running") running++
    else if (g === "waiting") waiting++
  }
  return { running, waiting }
}

async function fetchPage(
  group: NodeSessionGroup,
  cursor: string | null,
  userInitiated: boolean,
): Promise<void> {
  const api = apiOf()
  if (!api) return
  setGroups(group, "status", "loading")
  try {
    const page = await listSessions(
      api,
      group,
      cursor,
      userInitiated ? { userInitiated: true } : undefined,
    )
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

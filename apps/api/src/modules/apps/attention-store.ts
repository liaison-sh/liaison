// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN APP'S ATTENTION ITEMS ARE STORED STATE.
//
// An app that declares an attention provider (`views.attentionItems` in its
// manifest) lists what needs a person's attention: their overdue tasks, the
// tickets at risk of breaching their SLA, the findings to triage. The provider
// is app code (a sandbox run for a sandboxed app), so the attention feed does
// not call it: the feed reads `kernel.app_attention_items` and runs no app
// code (attention-aggregator.ts).
//
// The platform runs the provider when what it lists can have changed, as each
// person who may see the app's items, and stores each person's whole list
// (replacing the last one, so an item the provider no longer lists is cleared):
//   - after the app was woken: any run of it through runApp (a tool, an event
//     handler, a job, a webhook, a poll) other than an attention run itself
//     (`onRunSettled`), in the process that ran it;
//   - after an event of the app was delivered (`onEvent`, once, in the outbox
//     leader), which covers the app's data written by server code with no run;
//   - on the attention minute tick (state-materializer.ts), which bounds what
//     time alone changes (an SLA closing in, a task falling overdue): the next
//     minute for an org that changed, within HEARTBEAT_MINUTES otherwise;
//   - when the feed finds no stored list for the reader (a new person, a new
//     app), in the background: that read shows nothing for the app until then.
// Refreshes of one (org, app) are debounced and never overlap in a process: a
// wake during a refresh runs one more refresh after it.
//
// When a person's list changed, their devices are told to reload the feed
// (an `attention` read-state frame, the one the feed already reloads on).

import type { AttentionItem, AttentionProviderError } from "@liaison/shared"
import { and, eq, inArray, sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type ActorContext, createRlsSession } from "~/db/rls"
import { appAttentionItems } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { onEvent } from "~/infra/events/event-bus"
import { appsLogger as log } from "~/lib/logger"
import { appBridgeManifest, attentionItemsRegistry } from "~/modules/apps/app-registries"
import { isAppUnavailableFor, primeOrgApps } from "~/modules/apps/org-apps"
import { withAppDimensionAliases } from "~/modules/apps/runtime-helpers"
import { isBundleLoadError, loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { exportOnlyBundle, useFullBundle } from "~/modules/apps/sandbox/bundle-shake"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { runApp } from "~/modules/apps/sandbox/run-app"
import { onRunSettled } from "~/modules/apps/workers/run-settled"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"
import { broadcastReadState } from "~/modules/threads/read-state-broadcast"

const K = sql.raw(schemaRef("kernel"))

/** How long one provider run for one person may take (a background run, not a feed poll). */
export const PROVIDER_RUN_TIMEOUT_MS = 15_000
/** The most items stored per (app, person). */
export const PROVIDER_ITEM_CAP = 200
/** Wakes of one (org, app) within this window share one refresh. */
export const REFRESH_DEBOUNCE_MS = 250
/** People of one org refreshed at once. */
const PEOPLE_CONCURRENCY = 4

const TIMEOUT_SENTINEL = "__attention_provider_timeout__"

/** The entry kind of an attention run (runApp `entry`): its own runs never wake a refresh. */
export const ATTENTION_ENTRY_PREFIX = "attention:"

interface ProviderRegistration {
  handler: string
  scope?: string
  bundlePath: string
  trusted: boolean
}

/** The (org, app) entries that are app providers: org-scoped, not the kernel's wildcard ones. */
function providerOf(orgId: string, appName: string): ProviderRegistration | undefined {
  return attentionItemsRegistry.get([orgId, appName]) as ProviderRegistration | undefined
}

export function compareAttentionItems(a: AttentionItem, b: AttentionItem): number {
  if (b.urgency !== a.urgency) return b.urgency - a.urgency
  return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
}

/** Runs one app's provider as one person (a sandbox run for a sandboxed app). */
export async function invokeAppProvider(
  reg: ProviderRegistration,
  appName: string,
  actor: ActorContext,
  orgId: string,
): Promise<AttentionItem[]> {
  const source = await loadBundle(reg.bundlePath)
  const aliasedActor = withAppDimensionAliases(actor, appName)
  const userId = aliasedActor.actorType === "user" ? aliasedActor.userId : "system"
  // The bridge must carry the app's REAL manifest: db_findMany validates every
  // entity/orderBy key against `manifest.schema`, so an empty stub makes every
  // provider db read fail ("Entity not found in app schema").
  const bridgeManifest = appBridgeManifest(orgId, appName)
  if (!bridgeManifest) {
    throw new Error(`No bridge manifest registered for app "${appName}" (org ${orgId})`)
  }
  // Bridge-owned transactions: the session bridge acquires a connection per
  // bridge db call, never for the whole sandbox run.
  const session = createRlsSession(aliasedActor)
  const bridge = createSessionRpcBridge(
    appName,
    userId,
    orgId,
    session,
    bridgeManifest,
    aliasedActor.scopes,
    aliasedActor.actorType,
    undefined,
    { actor: aliasedActor },
  )
  // A trusted provider runs the part of its bundle the provider needs (the
  // whole bundle until that is built): QuickJS compiles all of a bundle on
  // every evaluation. Still a fresh context per call; see bundle-shake.ts.
  const trusted = reg.trusted === true
  const bundleSource = trusted ? exportOnlyBundle(source, reg.handler) : source
  try {
    return (await runApp({
      trusted,
      appName,
      orgId,
      bundlePath: reg.bundlePath,
      bundleSource,
      exportName: reg.handler,
      entry: `${ATTENTION_ENTRY_PREFIX}${reg.handler}`,
      params: { actor: aliasedActor },
      bridge,
      holdsTx: false,
      appId: appName,
      timeoutMs: PROVIDER_RUN_TIMEOUT_MS,
    })) as AttentionItem[]
  } catch (err) {
    // The export-only bundle failed to load: the next run uses the full one.
    if (trusted && bundleSource !== source && isBundleLoadError(err)) {
      useFullBundle(source, reg.handler)
    }
    throw err
  }
}

/**
 * The provider's answer as stored: well-formed items only (a malformed one is
 * dropped and reported, never allowed to crash the feed UI), sorted, capped.
 */
export function normalizeProviderItems(raw: unknown): {
  items: AttentionItem[]
  error: Omit<AttentionProviderError, "app"> | null
} {
  if (!Array.isArray(raw)) {
    return {
      items: [],
      error: { reason: "error", message: "Provider returned non-array attention items" },
    }
  }
  const wellFormed = (raw as AttentionItem[]).filter(
    (i) =>
      i &&
      typeof i === "object" &&
      typeof i.id === "string" &&
      typeof i.entityId === "string" &&
      typeof i.kind === "string" &&
      typeof i.summary === "string" &&
      typeof i.urgency === "number" &&
      i.action &&
      typeof (i.action as { type?: unknown }).type === "string",
  )
  const sorted = [...wellFormed].sort(compareAttentionItems)
  const items = sorted.length > PROVIDER_ITEM_CAP ? sorted.slice(0, PROVIDER_ITEM_CAP) : sorted
  let error: Omit<AttentionProviderError, "app"> | null = null
  if (wellFormed.length < raw.length) {
    error = {
      reason: "error",
      message: `Dropped ${raw.length - wellFormed.length} malformed attention item(s)`,
    }
  } else if (items.length < wellFormed.length) {
    error = {
      reason: "error",
      message: `Provider returned ${wellFormed.length} items; truncated to ${PROVIDER_ITEM_CAP}`,
    }
  }
  return { items, error }
}

export interface AttentionStoreDeps {
  listActiveUsers: (orgId: string) => Promise<string[]>
  loadActor: (orgId: string, userId: string) => Promise<ActorContext>
  invoke: (
    reg: ProviderRegistration,
    appName: string,
    actor: ActorContext,
    orgId: string,
  ) => Promise<unknown>
  /** Tell a person's devices that their feed changed. */
  notify: (orgId: string, userId: string, appName: string) => Promise<void>
}

async function defaultListActiveUsers(orgId: string): Promise<string[]> {
  return withPrivilegedDb(orgId, "attention-store:list-users", async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT id::text AS id FROM ${K}.users WHERE org_id = ${orgId} AND status = 'active'`,
    )) as unknown as Array<{ id: string }>
    return rows.map((r) => r.id)
  })
}

async function defaultLoadActor(orgId: string, userId: string): Promise<ActorContext> {
  const { scopes, dimensionGrants } = await withPrivilegedDb(
    orgId,
    "attention-store:load-scopes",
    (tx) => loadEffectivePermissions(tx, userId, orgId),
  )
  return { actorType: "user", userId, orgId, scopes, dimensionGrants }
}

const defaultDeps: AttentionStoreDeps = {
  listActiveUsers: defaultListActiveUsers,
  loadActor: defaultLoadActor,
  invoke: invokeAppProvider,
  notify: (orgId, userId, appName) =>
    broadcastReadState(orgId, userId, { kind: "attention", app: appName }),
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        handle = setTimeout(() => rej(new Error(TIMEOUT_SENTINEL)), ms)
      }),
    ])
  } finally {
    if (handle) clearTimeout(handle)
  }
}

async function readStoredLists(
  orgId: string,
  appName: string,
): Promise<Map<string, { items: AttentionItem[]; error: unknown }>> {
  const rows = await withPrivilegedDb(orgId, "attention-store:read", (tx) =>
    tx
      .select({
        userId: appAttentionItems.userId,
        items: appAttentionItems.items,
        error: appAttentionItems.error,
      })
      .from(appAttentionItems)
      .where(and(eq(appAttentionItems.orgId, orgId), eq(appAttentionItems.app, appName))),
  )
  return new Map(rows.map((r) => [r.userId, { items: r.items ?? [], error: r.error }]))
}

async function writeStoredList(
  orgId: string,
  appName: string,
  userId: string,
  items: AttentionItem[] | null,
  error: Omit<AttentionProviderError, "app"> | null,
): Promise<void> {
  await withPrivilegedDb(orgId, "attention-store:write", async (tx) => {
    if (items === null) {
      // A failed run keeps the last good list, with the failure beside it.
      await tx
        .insert(appAttentionItems)
        .values({ orgId, app: appName, userId, items: [], error, computedAt: new Date() })
        .onConflictDoUpdate({
          target: [appAttentionItems.orgId, appAttentionItems.app, appAttentionItems.userId],
          set: { error, computedAt: new Date() },
        })
      return
    }
    await tx
      .insert(appAttentionItems)
      .values({ orgId, app: appName, userId, items, error, computedAt: new Date() })
      .onConflictDoUpdate({
        target: [appAttentionItems.orgId, appAttentionItems.app, appAttentionItems.userId],
        set: { items, error, computedAt: new Date() },
      })
  })
}

/**
 * Run one app's provider for every active person of the org who may see its
 * items, and store each list. A person without the provider's scope, or to
 * whom the app is not available, gets an empty list. One person's failure is
 * stored beside their last good list and does not stop the others. Returns
 * how many people's lists changed.
 */
export async function refreshAppAttention(
  orgId: string,
  appName: string,
  partial: Partial<AttentionStoreDeps> & { userIds?: string[] } = {},
): Promise<{ people: number; changed: number }> {
  const deps: AttentionStoreDeps = { ...defaultDeps, ...partial }
  const reg = providerOf(orgId, appName)
  if (!reg) return { people: 0, changed: 0 }
  await primeOrgApps(orgId)
  const people = partial.userIds ?? (await deps.listActiveUsers(orgId))
  const previous = await readStoredLists(orgId, appName)
  let changed = 0
  const refreshOne = async (userId: string): Promise<void> => {
    let items: AttentionItem[] | null = []
    let error: Omit<AttentionProviderError, "app"> | null = null
    try {
      const actor = await deps.loadActor(orgId, userId)
      const scopes = withAppDimensionAliases(actor, appName).scopes ?? []
      const allowed =
        !isAppUnavailableFor(orgId, appName, userId) && (!reg.scope || hasScope(reg.scope, scopes))
      if (allowed) {
        const raw = await withTimeout(
          deps.invoke(reg, appName, actor, orgId),
          PROVIDER_RUN_TIMEOUT_MS + 1_000,
        )
        const normalized = normalizeProviderItems(raw)
        items = normalized.items
        error = normalized.error
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === TIMEOUT_SENTINEL
      error = isTimeout
        ? { reason: "timeout", message: `Provider exceeded ${PROVIDER_RUN_TIMEOUT_MS / 1000}s` }
        : { reason: "error", message: err instanceof Error ? err.message : "unknown" }
      items = null
      log.warn({ app: appName, orgId, userId, ...error }, "Attention provider run failed")
    }
    const before = previous.get(userId)
    try {
      await writeStoredList(orgId, appName, userId, items, error)
    } catch (err) {
      log.warn({ err, app: appName, orgId, userId }, "Attention list could not be stored")
      return
    }
    const itemsChanged =
      items !== null && JSON.stringify(before?.items ?? []) !== JSON.stringify(items)
    if (itemsChanged || (before === undefined && items !== null)) {
      changed++
      await deps.notify(orgId, userId, appName).catch(() => {})
    }
  }
  let next = 0
  const lanes = Array.from({ length: Math.min(PEOPLE_CONCURRENCY, people.length) }, async () => {
    while (next < people.length) {
      const userId = people[next++]
      if (userId) await refreshOne(userId)
    }
  })
  await Promise.all(lanes)
  return { people: people.length, changed }
}

/** Every app provider of the org, refreshed one app after the other (the minute tick). */
export async function refreshAllAppAttention(
  orgId: string,
  partial: Partial<AttentionStoreDeps> & { userIds?: string[] } = {},
): Promise<void> {
  for (const [[entryOrg, appName]] of attentionItemsRegistry.entriesOf(orgId)) {
    if (entryOrg !== orgId) continue
    try {
      await refreshAppAttention(orgId, appName, partial)
    } catch (err) {
      log.warn({ err, orgId, app: appName }, "Attention refresh failed")
    }
  }
}

// --- Wakes: debounced, never overlapping per (org, app) in this process ------

interface RefreshState {
  timer: ReturnType<typeof setTimeout> | null
  running: Promise<void> | null
  again: boolean
}

const refreshes = new Map<string, RefreshState>()
/** What a woken refresh runs with: the defaults, unless a test set its doubles. */
let wakeDeps: Partial<AttentionStoreDeps> & { ensureOrgApps?: (orgId: string) => Promise<void> } =
  {}
const settledWaiters = new Set<() => void>()

function keyOf(orgId: string, appName: string): string {
  return `${orgId}\u0000${appName}`
}

function settleIfIdle(): void {
  if (refreshes.size > 0) return
  for (const resolve of settledWaiters) resolve()
  settledWaiters.clear()
}

async function runRefresh(key: string, orgId: string, appName: string): Promise<void> {
  const state = refreshes.get(key)
  if (!state) return
  state.timer = null
  state.again = false
  state.running = (async () => {
    try {
      if (wakeDeps.ensureOrgApps) await wakeDeps.ensureOrgApps(orgId)
      else {
        const { awaitOrgApps } = await import("~/modules/apps/init")
        await awaitOrgApps(orgId)
      }
      await refreshAppAttention(orgId, appName, wakeDeps)
    } catch (err) {
      log.warn({ err, orgId, app: appName }, "Attention refresh failed")
    }
  })()
  await state.running
  state.running = null
  if (state.again) {
    state.timer = setTimeout(() => void runRefresh(key, orgId, appName), REFRESH_DEBOUNCE_MS)
    return
  }
  refreshes.delete(key)
  settleIfIdle()
}

/**
 * Ask for the app's stored attention to be recomputed soon (after a wake).
 * Cheap and synchronous: a no-op for an app with no provider in the org.
 */
export function scheduleAttentionRefresh(orgId: string, appName: string): void {
  if (!providerOf(orgId, appName)) return
  const key = keyOf(orgId, appName)
  const state = refreshes.get(key)
  if (state) {
    // Waiting: it will read the new state. Running: one more pass after it.
    if (state.running) state.again = true
    return
  }
  const fresh: RefreshState = { timer: null, running: null, again: false }
  refreshes.set(key, fresh)
  fresh.timer = setTimeout(() => void runRefresh(key, orgId, appName), REFRESH_DEBOUNCE_MS)
}

/** Resolves once no refresh is waiting or running in this process (tests). */
export function attentionRefreshesSettled(): Promise<void> {
  if (refreshes.size === 0) return Promise.resolve()
  return new Promise((resolve) => settledWaiters.add(resolve))
}

let wired = false

/**
 * Wake the refresh after every run of an app (other than an attention run)
 * and after every delivered event of an app. Idempotent; called once at
 * module load.
 */
export function wireAttentionRefreshWakes(): void {
  if (wired) return
  wired = true
  onRunSettled((info) => {
    if (info.entry.startsWith(ATTENTION_ENTRY_PREFIX)) return
    scheduleAttentionRefresh(info.orgId, info.app)
  })
  onEvent(
    async (event) => {
      if (event.ephemeral || !event.orgId || !event.app || event.app === "kernel") return
      scheduleAttentionRefresh(event.orgId, event.app)
    },
    { delivery: "once", name: "app-attention-refresh" },
  )
}

// --- The feed's read -----------------------------------------------------------

export interface StoredAttention {
  items: AttentionItem[]
  error: Omit<AttentionProviderError, "app"> | null
}

/**
 * The reader's stored lists of these apps, under the reader's RLS context. An
 * app with no stored list for the reader is absent from the map (and is
 * scheduled for a refresh in the background).
 */
export async function readStoredAttention(
  tx: RlsClient,
  orgId: string,
  userId: string,
  apps: string[],
): Promise<Map<string, StoredAttention>> {
  const out = new Map<string, StoredAttention>()
  if (apps.length === 0 || !userId) return out
  const rows = await tx
    .select({
      app: appAttentionItems.app,
      items: appAttentionItems.items,
      error: appAttentionItems.error,
    })
    .from(appAttentionItems)
    .where(
      and(
        eq(appAttentionItems.orgId, orgId),
        eq(appAttentionItems.userId, userId),
        inArray(appAttentionItems.app, apps),
      ),
    )
  for (const r of rows) {
    out.set(r.app, {
      items: Array.isArray(r.items) ? r.items : [],
      error: (r.error as StoredAttention["error"]) ?? null,
    })
  }
  for (const app of apps) if (!out.has(app)) scheduleAttentionRefresh(orgId, app)
  return out
}

/** Test seams: the doubles a woken refresh runs with. */
export const AttentionStoreTestAccess = {
  setWakeDeps(deps: typeof wakeDeps): void {
    wakeDeps = deps
  },
  reset(): void {
    wakeDeps = {}
  },
}

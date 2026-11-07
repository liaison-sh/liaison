// SPDX-License-Identifier: FSL-1.1-ALv2
//
// RELEASING an org's runtime in this process.
//
// An org's runtime (its tools, manifests, handlers and event subscriptions in
// this process) is set up at its first touch (init.ts `awaitOrgApps`) and was
// never taken down. An org deleted while a process ran stayed in its
// registries until the process restarted, and every org a process ever served
// stayed set up for the process's life. On a box whose workspaces come and go
// all day (a public demo) that is a few megabytes per workspace ever touched,
// until the container hits its memory limit and is killed, over and over.
//
// A deleted org is released at once in every process: the deletion publishes
// its id on `org-runtime:release` (releaseOrgRuntimesEverywhere), and every
// process that started its sweeps subscribes. The 5-minute sweep below stays
// the fallback for a process that missed the message.
//
// Two sweeps release runtimes. Every process, every few minutes, releases the
// orgs whose organization row is gone (a later touch of one finds no row and
// is a no-op, `orgsKnownMissing`, as before). And every minute it releases the
// orgs nothing has touched for LIAISON_ORG_RUNTIME_IDLE_MINUTES (default 60, 0
// never): their next touch sets them up again, exactly as in a process that
// never saw them. On by default: a process serving orgs that come and go (a
// public demo, a hosted instance) otherwise holds every org it ever served.
//
// The idle release alone leaves a process's set-up orgs unbounded while they
// keep being touched (a system job that fans out to every org, a burst of
// first touches). So a process also holds at most LIAISON_ORG_RUNTIME_MAX_ORGS
// (default 2000, 0 no cap): past it, each new setup releases the least
// recently touched orgs that no live work holds (a request or socket,
// `orgRuntimeHolds`; a write, job or agent turn, or a move in progress, from
// the transfer state's accounting), through the same release as an idle one.
// Held orgs are never released: the cap may be exceeded until they end, and
// the minute sweep trims it then.
//
// A release first marks the org not set up, so a touch arriving meanwhile
// waits for the release (`orgRuntimeReleases`, init.ts) and then sets it up
// afresh; then it disposes the org's event subscriptions and deletes every
// registry entry under its id.
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { publishRedis, REDIS_PREFIX, redisSub } from "~/lib/redis"
import { UUID_RE } from "~/lib/uuid"
import {
  declaredEmits,
  eventSubscriptionDisposers,
  initializedOrgRuntimes,
  orgRuntimeHolds,
  orgRuntimeInitPromises,
  orgRuntimeLastTouch,
  orgRuntimeReleases,
  orgsRegistering,
  registeredApps,
  registeredAppVersions,
  rememberMissingOrg,
} from "~/modules/apps/app-registries"
import { deleteRegistryEntriesOfOrgs } from "~/modules/apps/registries"
import { orgRuntimePinnedByTransfer } from "~/modules/org/transfer-state/state"

/** How often a process looks for set-up orgs that are gone. */
export const ORG_RUNTIME_SWEEP_MS = 5 * 60_000

/**
 * Take down the runtimes of `orgIds` in this process. `gone`: their rows are
 * deleted (a later touch is a no-op); otherwise they exist and their next
 * touch sets them up again. An org being set up right now is skipped. Returns
 * the orgs released.
 */
export async function releaseOrgRuntimes(
  orgIds: Iterable<string>,
  opts: { gone?: boolean; reason?: string } = {},
): Promise<string[]> {
  const gone = opts.gone !== false
  const released = new Set<string>()
  for (const orgId of orgIds) {
    if (orgRuntimeInitPromises.has(orgId) || orgsRegistering.has(orgId)) continue
    if (orgRuntimeReleases.has(orgId)) continue
    released.add(orgId)
  }
  if (released.size === 0) return []
  let done = () => {}
  const finished = new Promise<void>((resolve) => {
    done = resolve
  })
  // Synchronously, before the first await: from here a touch waits for the
  // release instead of reading registries that are going away.
  const disposers: Array<{ orgId: string; app: string; dispose: () => Promise<void> }> = []
  for (const orgId of released) {
    orgRuntimeReleases.set(orgId, finished)
    initializedOrgRuntimes.delete(orgId)
  }
  for (const [key, list] of eventSubscriptionDisposers.entries()) {
    if (!released.has(key[0])) continue
    for (const dispose of list) disposers.push({ orgId: key[0], app: key[1], dispose })
  }
  try {
    // First, so no event reaches a handler while its registries are going.
    for (const d of disposers) {
      try {
        await d.dispose()
      } catch (err) {
        log.warn({ err, orgId: d.orgId, app: d.app }, "Event subscription disposer failed")
      }
    }
    const { unregisterExternalSearchHandler } = await import("~/modules/search/external-handlers")
    const { forgetOrgApps } = await import("~/modules/apps/org-apps")
    const { invalidateScopeCatalog } = await import("~/modules/permissions/scope-catalog")
    const { invalidateDimensionCatalog } = await import("~/modules/permissions/dimension-catalog")
    for (const key of [...registeredApps]) {
      const sep = key.indexOf(":")
      const orgId = key.slice(0, sep)
      if (!released.has(orgId)) continue
      unregisterExternalSearchHandler(orgId, key.slice(sep + 1))
      registeredApps.delete(key)
      registeredAppVersions.delete(key)
    }
    for (const key of [...declaredEmits.keys()]) {
      if (released.has(key.slice(0, key.indexOf(":")))) declaredEmits.delete(key)
    }
    const entries = deleteRegistryEntriesOfOrgs(released)
    for (const orgId of released) {
      forgetOrgApps(orgId)
      invalidateScopeCatalog(orgId)
      invalidateDimensionCatalog(orgId)
      orgRuntimeLastTouch.delete(orgId)
      if (gone) rememberMissingOrg(orgId)
    }
    log.info(
      {
        released: released.size,
        entries,
        remaining: initializedOrgRuntimes.size,
        reason: opts.reason ?? (gone ? "deleted" : "released"),
      },
      `released the runtimes of ${released.size} org(s)`,
    )
  } finally {
    for (const orgId of released) orgRuntimeReleases.delete(orgId)
    done()
  }
  return [...released]
}

/** The set-up orgs nothing has touched in this process for `idleMs`. */
export function idleOrgRuntimes(idleMs: number, now: number = Date.now()): string[] {
  const idle: string[] = []
  for (const orgId of initializedOrgRuntimes) {
    const last = orgRuntimeLastTouch.get(orgId)
    // Never touched through the ensure entry (set up some other way): from now.
    if (last === undefined) {
      orgRuntimeLastTouch.set(orgId, now)
      continue
    }
    if (now - last >= idleMs) idle.push(orgId)
  }
  return idle
}

/** Release every org idle for LIAISON_ORG_RUNTIME_IDLE_MINUTES. Never throws. */
export async function sweepIdleOrgRuntimes(now: number = Date.now()): Promise<string[]> {
  const minutes = env.LIAISON_ORG_RUNTIME_IDLE_MINUTES
  if (minutes <= 0) return []
  try {
    const idle = idleOrgRuntimes(minutes * 60_000, now)
    return idle.length > 0 ? await releaseOrgRuntimes(idle, { gone: false, reason: "idle" }) : []
  } catch (err) {
    log.warn({ err }, "idle org runtime sweep failed; the next one retries")
    return []
  }
}

/**
 * The set-up orgs to release so that at most `cap` stay set up: the least
 * recently touched first, never one being set up or released, held by live
 * work (`isHeld`), or moving. Fewer than the excess when too many are held.
 */
export function orgRuntimesOverCap(
  cap: number,
  isHeld: (orgId: string) => boolean = orgRuntimeHeld,
): string[] {
  const excess = initializedOrgRuntimes.size - cap
  if (cap <= 0 || excess <= 0) return []
  const candidates: Array<[string, number]> = []
  for (const orgId of initializedOrgRuntimes) {
    if (orgRuntimeInitPromises.has(orgId) || orgsRegistering.has(orgId)) continue
    if (orgRuntimeReleases.has(orgId) || isHeld(orgId)) continue
    candidates.push([orgId, orgRuntimeLastTouch.get(orgId) ?? 0])
  }
  candidates.sort((a, b) => a[1] - b[1])
  return candidates.slice(0, excess).map(([orgId]) => orgId)
}

/** Live work in this process holds the org's runtime, or the org is moving. */
function orgRuntimeHeld(orgId: string): boolean {
  return orgRuntimeHolds.has(orgId) || orgRuntimePinnedByTransfer(orgId)
}

/** Release the orgs past LIAISON_ORG_RUNTIME_MAX_ORGS (`orgRuntimesOverCap`). Never throws. */
export async function enforceOrgRuntimeCap(
  cap: number = env.LIAISON_ORG_RUNTIME_MAX_ORGS,
): Promise<string[]> {
  try {
    const over = orgRuntimesOverCap(cap)
    return over.length > 0 ? await releaseOrgRuntimes(over, { gone: false, reason: "cap" }) : []
  } catch (err) {
    log.warn({ err }, "org runtime cap enforcement failed; the next setup or sweep retries")
    return []
  }
}

/** The orgs set up in this process whose organization row is gone. */
export async function setUpOrgsThatAreGone(): Promise<string[]> {
  // Org ids are uuids (init.ts never sets up anything else), so the array
  // literal below needs no quoting.
  const initialized = [...initializedOrgRuntimes].filter((id) => UUID_RE.test(id))
  if (initialized.length === 0) return []
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = await withSystemDb("org-runtime-sweep", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${k}.organizations
      WHERE id = ANY(${`{${initialized.join(",")}}`}::uuid[])`)
    return (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Array<{
      id: string
    }>
  })
  const existing = new Set(rows.map((r) => String(r.id)))
  return initialized.filter((orgId) => !existing.has(orgId))
}

/** One sweep: release every set-up org whose row is gone. Never throws. */
export async function sweepDeletedOrgRuntimes(): Promise<string[]> {
  try {
    const gone = await setUpOrgsThatAreGone()
    return gone.length > 0 ? await releaseOrgRuntimes(gone, { gone: true }) : []
  } catch (err) {
    log.warn({ err }, "org runtime sweep failed; the next one retries")
    return []
  }
}

/** Every process releases the runtimes of the org ids published here (org deletion). */
export const ORG_RUNTIME_RELEASE_CHANNEL = `${REDIS_PREFIX}org-runtime:release`

/**
 * Release deleted orgs' runtimes in this process now, and in every other
 * process through `ORG_RUNTIME_RELEASE_CHANNEL`. A failed publish is logged:
 * the peers' 5-minute sweep releases them anyway. Never throws.
 */
export async function releaseOrgRuntimesEverywhere(orgIds: string[]): Promise<void> {
  const ids = orgIds.filter((id) => UUID_RE.test(id))
  if (ids.length === 0) return
  await releaseOrgRuntimes(ids, { gone: true, reason: "deleted" }).catch((err: unknown) =>
    log.warn({ err }, "releasing deleted orgs' runtimes in this process failed"),
  )
  await publishRedis(ORG_RUNTIME_RELEASE_CHANNEL, JSON.stringify({ orgIds: ids })).catch(
    (err: unknown) =>
      log.warn({ err }, "org runtime release publish failed; peers' sweeps release them"),
  )
}

let releaseSubscribed = false

/** Follow peers' releases (`ORG_RUNTIME_RELEASE_CHANNEL`). Idempotent; never throws. */
export async function subscribeOrgRuntimeRelease(): Promise<void> {
  if (releaseSubscribed) return
  releaseSubscribed = true
  redisSub.on("message", (channel, message) => {
    if (channel !== ORG_RUNTIME_RELEASE_CHANNEL) return
    try {
      const parsed = JSON.parse(message) as { orgIds?: unknown }
      const ids = Array.isArray(parsed.orgIds)
        ? parsed.orgIds.filter((id): id is string => typeof id === "string" && UUID_RE.test(id))
        : []
      if (ids.length > 0) {
        void releaseOrgRuntimes(ids, { gone: true, reason: "deleted" }).catch((err: unknown) =>
          log.warn({ err }, "releasing a peer's deleted orgs failed; the sweep retries"),
        )
      }
    } catch (err) {
      log.warn({ err, channel }, "unreadable org runtime release message")
    }
  })
  try {
    await redisSub.subscribe(ORG_RUNTIME_RELEASE_CHANNEL)
  } catch (err) {
    releaseSubscribed = false
    log.warn({ err }, "could not subscribe to org runtime releases; the sweep covers them")
  }
}

/** How often a process looks for idle orgs and orgs past the cap, when either is on. */
export const ORG_RUNTIME_IDLE_SWEEP_MS = 60_000

let sweepTimer: ReturnType<typeof setInterval> | null = null
let idleTimer: ReturnType<typeof setInterval> | null = null

/** Start the periodic sweeps in this process (the server, once booted). Idempotent. */
export function startOrgRuntimeSweep(): void {
  void subscribeOrgRuntimeRelease()
  if (!sweepTimer) {
    sweepTimer = setInterval(() => void sweepDeletedOrgRuntimes(), ORG_RUNTIME_SWEEP_MS)
    sweepTimer.unref?.()
  }
  const capped = env.LIAISON_ORG_RUNTIME_MAX_ORGS > 0
  if (!idleTimer && (env.LIAISON_ORG_RUNTIME_IDLE_MINUTES > 0 || capped)) {
    idleTimer = setInterval(() => {
      void sweepIdleOrgRuntimes().then(() => (capped ? enforceOrgRuntimeCap() : undefined))
    }, ORG_RUNTIME_IDLE_SWEEP_MS)
    idleTimer.unref?.()
  }
}

export function stopOrgRuntimeSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  if (idleTimer) clearInterval(idleTimer)
  sweepTimer = null
  idleTimer = null
}

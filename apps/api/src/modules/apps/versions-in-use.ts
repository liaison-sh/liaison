// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which app versions live processes load (M4 of the rolling deploy).
//
// During a rolling deploy, and for as long as an old generation keeps serving
// after a rolled-back one, processes of different releases share one install
// root. An old process keeps the app version its own catalog carries
// (`versionForThisRelease`), which can be neither the active nor the previous
// version once the row moved twice. The prune after an activation keeps only
// those two, so it would delete a directory an old process still loads (a lazy
// org setup, a re-registration) and that process fails with module_missing.
//
// Each process therefore announces, in one Redis hash keyed by its instance id,
// the versions it has registered and the ones its catalog may make it register,
// refreshed every VERSIONS_IN_USE_REFRESH_MS. An entry counts while its instance
// has a heartbeat record (infra/instance-registry.ts); the dead-instance sweep
// drops it. The prune keeps every version a live entry names; when the entries
// or the liveness cannot be read it keeps everything (a directory too many costs
// disk, one too few breaks a running process).
import { INSTANCE_ID } from "~/infra/instance-id"
import { liveInstanceSet, onDeadInstance, onInstanceRecovered } from "~/infra/instance-registry"
import { boundedBy } from "~/lib/bounded"
import { appsLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { registeredAppVersions } from "~/modules/apps/app-registries"

export const VERSIONS_IN_USE_KEY = "apps:versions-in-use"
/** How often a process rewrites its entry (its registrations change at runtime). */
export const VERSIONS_IN_USE_REFRESH_MS = 30_000
const READ_TIMEOUT_MS = 2_000

interface Entry {
  /** App name → versions this process loads or may load. */
  versions: Record<string, string[]>
}

/** The versions this process has registered (any org) plus its catalog's versions. */
export async function localVersionsInUse(): Promise<Record<string, string[]>> {
  const out = new Map<string, Set<string>>()
  const add = (name: string, version: string) => {
    let set = out.get(name)
    if (!set) {
      set = new Set()
      out.set(name, set)
    }
    set.add(version)
  }
  for (const [key, version] of registeredAppVersions) {
    // Keys are `<orgId>:<appName>`; an org id is a uuid (no colon).
    const name = key.slice(key.indexOf(":") + 1)
    if (name) add(name, version)
  }
  const { listCatalog } = await import("~/modules/apps/catalog")
  for (const entry of listCatalog()) add(entry.name, entry.version)
  return Object.fromEntries([...out].map(([name, set]) => [name, [...set].sort()]))
}

/** Write (or refresh) this process's entry. */
export async function announceVersionsInUse(): Promise<void> {
  const entry: Entry = { versions: await localVersionsInUse() }
  await redis.hset(VERSIONS_IN_USE_KEY, INSTANCE_ID, JSON.stringify(entry))
}

/**
 * Every version of `name` a live process announced, this process included.
 * Null when the announcements or the instances' liveness cannot be read: the
 * caller then deletes nothing. Entries of instances with no heartbeat record
 * (a process that died) are ignored.
 */
export async function versionsInUse(name: string): Promise<Set<string> | null> {
  let live: Set<string>
  let all: Record<string, string>
  try {
    all = await boundedBy(
      redis.hgetall(VERSIONS_IN_USE_KEY),
      READ_TIMEOUT_MS,
      () => new Error("reading the app version announcements timed out"),
    )
    live = await liveInstanceSet(Object.keys(all))
  } catch (err) {
    log.warn({ err, app: name }, "Reading the app versions live processes use failed")
    return null
  }
  const out = new Set<string>((await localVersionsInUse())[name] ?? [])
  for (const [instance, raw] of Object.entries(all)) {
    if (!live.has(instance)) continue
    let entry: Entry
    try {
      entry = JSON.parse(raw) as Entry
    } catch {
      // An entry nobody can read could name anything: keep every version.
      log.warn({ instance, app: name }, "An app version announcement is unreadable")
      return null
    }
    for (const v of entry.versions?.[name] ?? []) out.add(v)
  }
  return out
}

let timer: ReturnType<typeof setInterval> | undefined

/** Announce now and every VERSIONS_IN_USE_REFRESH_MS. Idempotent. */
export function startVersionsInUseHeartbeat(): void {
  if (timer) return
  const beat = () =>
    void announceVersionsInUse().catch((err) =>
      log.warn({ err }, "Announcing the app versions this process uses failed"),
    )
  beat()
  timer = setInterval(beat, VERSIONS_IN_USE_REFRESH_MS)
  timer.unref?.()
  onDeadInstance("app-versions-in-use", async (deadId) => {
    await redis.hdel(VERSIONS_IN_USE_KEY, deadId)
  })
  onInstanceRecovered("app-versions-in-use", announceVersionsInUse)
}

/** Stop announcing and remove this process's entry (shutdown). */
export async function stopVersionsInUseHeartbeat(): Promise<void> {
  if (timer) clearInterval(timer)
  timer = undefined
  await redis.hdel(VERSIONS_IN_USE_KEY, INSTANCE_ID).catch(() => {})
}

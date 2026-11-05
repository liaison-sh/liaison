// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A typed registry that enforces the same key shape at set() and get() sites.
 * Uses a tuple of segments instead of string concatenation — no key format mismatch possible.
 *
 * Usage:
 *   const dimReg = createTypedRegistry<[orgId: string, appName: string, dimKey: string], DimDef>()
 *   dimReg.set(["org1", "test", "team"], { type: "membership" })
 *   dimReg.get(["org1", "test", "team"]) // same shape enforced by TS
 */
/**
 * The keys written while a journal is open, as `<registry id>\u0001<raw key>`.
 * A version switch (activation.ts) registers the new version over the old one
 * and then deletes only the old keys the new version did not write, so every
 * reader sees the old entry or the new one, never a gap (A15).
 */
export type RegistryJournal = Set<string>

const openJournals = new Set<RegistryJournal>()
let nextRegistryId = 0

/** Raw access to every registry by id, for registration templates (below). */
interface RawRegistry {
  getRaw(raw: string): unknown
  setRaw(raw: string, value: unknown): void
  deleteRaw(raw: string): void
  /** Delete every entry whose first key segment is `first`; returns how many. */
  deleteFirst(first: string): number
  keys(): string[]
}
const registriesById = new Map<number, RawRegistry>()

/**
 * What one org-independent registration wrote, ready to be written again under
 * any org: each entry's registry, its key below the org segment, and the VALUE
 * itself, shared by every org it is replayed into.
 *
 * WHY. Registration used to build every definition again for every org a
 * process touches: the kernel's tools alone are some 1.7 MB of schemas,
 * closures and strings per org, identical from one org to the next, so a
 * process serving a thousand workspaces held gigabytes of copies. A template
 * is built once per process and replayed per org as plain map writes.
 */
export interface RegistrationTemplate {
  entries: Array<{ registryId: number; raw: string; value: unknown; orgSegment: boolean }>
}

/** The org segment a template is captured under: never a real org id (not a uuid). */
export const TEMPLATE_ORG = "registration-template"

/**
 * Run `register(TEMPLATE_ORG)` and capture what it wrote under that org (and
 * under the cross-org `*` segment) as a template, then remove the captured
 * org's entries again. `register` must be org-independent: nothing it writes
 * may depend on the org beyond the key's first segment.
 */
export async function captureRegistrationTemplate(
  register: (orgId: string) => Promise<void> | void,
): Promise<RegistrationTemplate> {
  const journal = openRegistryJournal()
  try {
    await register(TEMPLATE_ORG)
  } finally {
    closeRegistryJournal(journal)
  }
  const orgPrefix = `${TEMPLATE_ORG}\0`
  const entries: RegistrationTemplate["entries"] = []
  for (const written of journal) {
    const sep = written.indexOf("\u0001")
    const registryId = Number(written.slice(0, sep))
    const raw = written.slice(sep + 1)
    const registry = registriesById.get(registryId)
    if (!registry) continue
    const orgSegment = raw.startsWith(orgPrefix)
    if (!orgSegment && !raw.startsWith("*\0")) continue
    const value = registry.getRaw(raw)
    // Written then deleted during the registration: not part of it.
    if (value === undefined) continue
    entries.push({
      registryId,
      raw: orgSegment ? raw.slice(orgPrefix.length) : raw,
      value,
      orgSegment,
    })
  }
  for (const e of entries) {
    if (e.orgSegment) registriesById.get(e.registryId)?.deleteRaw(`${orgPrefix}${e.raw}`)
  }
  return { entries }
}

/**
 * Delete every entry, in every registry, whose first key segment is one of
 * `orgIds`: only those orgs' buckets are walked, whatever the number of other
 * orgs. What a released org runtime (org-runtime-release.ts) leaves in the
 * registries: nothing, as in a process that never touched the org.
 */
export function deleteRegistryEntriesOfOrgs(orgIds: ReadonlySet<string>): number {
  let deleted = 0
  for (const registry of registriesById.values()) {
    for (const orgId of orgIds) deleted += registry.deleteFirst(orgId)
  }
  return deleted
}

/** A raw key's first segment (the org id, `*`, or the template org). */
function firstSegment(raw: string): string {
  const sep = raw.indexOf("\0")
  return sep < 0 ? raw : raw.slice(0, sep)
}

/** Test seam: every registry's raw keys under `prefix` (an org id), by registry id, in order. */
export const RegistriesTestAccess = {
  keysUnder(prefix: string): Map<number, string[]> {
    const out = new Map<number, string[]>()
    for (const [id, registry] of registriesById) {
      const keys = registry.keys().filter((k) => k.startsWith(`${prefix}\0`))
      if (keys.length > 0)
        out.set(
          id,
          keys.map((k) => k.slice(prefix.length + 1)),
        )
    }
    return out
  },
  valueOf(registryId: number, raw: string): unknown {
    return registriesById.get(registryId)?.getRaw(raw)
  },
}

const templateResets = new Set<() => void>()

/** Register a template's reset, run by `resetRegistrationTemplates` (a test's registry reset). */
export function onRegistrationTemplatesReset(reset: () => void): void {
  templateResets.add(reset)
}

/**
 * Forget every built template, so the next registration builds it again (and
 * picks up whatever a test replaced since). Called by `resetAppRegistries`.
 */
export function resetRegistrationTemplates(): void {
  for (const reset of templateResets) reset()
}

/** Write a template's entries under `orgId` (its cross-org entries as they are). */
export function replayRegistrationTemplate(template: RegistrationTemplate, orgId: string): void {
  for (const e of template.entries) {
    registriesById.get(e.registryId)?.setRaw(e.orgSegment ? `${orgId}\0${e.raw}` : e.raw, e.value)
  }
}

export function openRegistryJournal(): RegistryJournal {
  const journal: RegistryJournal = new Set()
  openJournals.add(journal)
  return journal
}

export function closeRegistryJournal(journal: RegistryJournal): void {
  openJournals.delete(journal)
}

/**
 * Called with the org id when an org-scoped registry's lookup finds nothing
 * (H3, org-registry-guard.ts). Unset outside a booted server.
 */
let orgMissHook: ((orgId: string) => void) | undefined

export function setOrgRegistryMissHook(fn: ((orgId: string) => void) | undefined): void {
  orgMissHook = fn
}

export function createTypedRegistry<K extends string[], V>(
  options: {
    /** Runs on every set(); throw to refuse the registration. */
    validate?: (key: K, value: V) => void
    /** The first key segment is an org id: a lookup miss runs the org miss hook. */
    orgScoped?: boolean
  } = {},
) {
  const map = new Map<string, V>()
  /**
   * The same entries bucketed by first key segment, in the same relative
   * order as `map`: a per-org read or prefix operation walks one org's
   * entries instead of every org's a process holds.
   */
  const byFirst = new Map<string, Map<string, V>>()

  const put = (raw: string, value: V): void => {
    map.set(raw, value)
    const first = firstSegment(raw)
    let bucket = byFirst.get(first)
    if (!bucket) {
      bucket = new Map()
      byFirst.set(first, bucket)
    }
    bucket.set(raw, value)
  }
  const remove = (raw: string): boolean => {
    if (!map.delete(raw)) return false
    const first = firstSegment(raw)
    const bucket = byFirst.get(first)
    if (bucket) {
      bucket.delete(raw)
      if (bucket.size === 0) byFirst.delete(first)
    }
    return true
  }
  /** The entries whose raw key is `prefixStr` or below it: all in one bucket. */
  const entriesUnder = (prefixStr: string): Array<[string, V]> => {
    const bucket = byFirst.get(firstSegment(prefixStr))
    if (!bucket) return []
    const out: Array<[string, V]> = []
    for (const entry of bucket) {
      if (entry[0] === prefixStr || entry[0].startsWith(`${prefixStr}\0`)) out.push(entry)
    }
    return out
  }

  // Use NUL separator (\0) to prevent segment confusion ("a:b","c" vs "a","b:c")
  const toKey = (segments: K): string => segments.join("\0")
  const id = nextRegistryId++
  registriesById.set(id, {
    getRaw: (raw) => map.get(raw),
    setRaw: (raw, value) => {
      options.validate?.(raw.split("\0") as K, value as V)
      put(raw, value as V)
      for (const journal of openJournals) journal.add(`${id}\u0001${raw}`)
    },
    deleteRaw: (raw) => {
      remove(raw)
    },
    deleteFirst: (first) => {
      const bucket = byFirst.get(first)
      if (!bucket) return 0
      for (const raw of bucket.keys()) map.delete(raw)
      byFirst.delete(first)
      return bucket.size
    },
    keys: () => [...map.keys()],
  })

  return {
    set(key: K, value: V): void {
      options.validate?.(key, value)
      const raw = toKey(key)
      put(raw, value)
      for (const journal of openJournals) journal.add(`${id}\u0001${raw}`)
    },
    /** The entries under `prefix` (the prefix itself included), by raw key. */
    snapshotUnder(prefix: string[]): Map<string, V> {
      const out = new Map<string, V>()
      for (const [k, v] of entriesUnder(prefix.join("\0"))) out.set(k, v)
      return out
    },
    /** Delete the snapshot's keys that `journal` did not see written since. */
    pruneUnwritten(snapshot: Map<string, V>, journal: RegistryJournal): void {
      for (const raw of snapshot.keys()) {
        if (!journal.has(`${id}\u0001${raw}`)) remove(raw)
      }
    },
    /** Put back exactly the snapshot's entries under `prefix`. */
    restoreUnder(prefix: string[], snapshot: Map<string, V>): void {
      for (const [k] of entriesUnder(prefix.join("\0"))) remove(k)
      for (const [k, v] of snapshot) put(k, v)
    },
    get(key: K): V | undefined {
      const value = map.get(toKey(key))
      if (value === undefined && options.orgScoped && orgMissHook && key[0]) orgMissHook(key[0])
      return value
    },
    delete(key: K): boolean {
      return remove(toKey(key))
    },
    has(key: K): boolean {
      return map.has(toKey(key))
    },
    deleteByPrefix(prefix: string[]): void {
      for (const [key] of entriesUnder(prefix.join("\0"))) remove(key)
    },
    clear(): void {
      map.clear()
      byFirst.clear()
    },
    get size(): number {
      return map.size
    },
    values(): IterableIterator<V> {
      return map.values()
    },
    *entries(): IterableIterator<[K, V]> {
      for (const [key, value] of map.entries()) {
        yield [key.split("\0") as unknown as K, value]
      }
    },
    /**
     * The entries whose first key segment is `first` (an org id, or `*`), in
     * the order `entries()` yields them, without walking any other org's.
     */
    *entriesOf(first: string): IterableIterator<[K, V]> {
      const bucket = byFirst.get(first)
      if (!bucket) return
      for (const [key, value] of bucket) {
        yield [key.split("\0") as K, value]
      }
    },
  }
}

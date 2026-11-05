// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A35: "a conversation with a title is a channel, a DM has no title and is
// named by its participants". A channel's handle IS its name, so a channel
// created as "growth-experiments" answers to `#growth-experiments`, not to
// `#thread-15`. The sequence handle survives for exactly the rows that have
// no name of their own: untitled rooms, which the UI names by their seats.
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsTx } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { nextHandle } from "~/lib/handle"

/** `thread-15`: the sequence form, carried by every untitled room. */
const AUTO_HANDLE_RE = /^thread-\d+$/

export function isAutoThreadHandle(handle: string): boolean {
  return AUTO_HANDLE_RE.test(handle)
}

/**
 * Lowercase ascii, every run of anything else folded to a single hyphen.
 * Diacritics are stripped rather than dropped, so "Réunion équipe" becomes
 * "reunion-equipe" and not "r-union-quipe".
 */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "")
}

/**
 * True when `handle` is one this module would have derived: the sequence form,
 * or the slug of the title the row carries today (with or without the numeric
 * disambiguator). A handle someone chose by hand is left alone on a rename.
 */
export function isDerivedThreadHandle(handle: string, currentTitle: string | null): boolean {
  if (isAutoThreadHandle(handle)) return true
  if (!currentTitle) return false
  const base = slugifyTitle(currentTitle)
  if (!base) return false
  return handle === base || new RegExp(`^${escapeRe(base)}-\\d+$`).test(handle)
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The handles already taken in this org that could collide with `base`:
 * `base` itself and `base-N`. Read privileged on purpose — RLS shows a caller
 * only the rooms they sit in, so an RLS read would happily hand out a handle
 * another team already uses and the unique index would then reject the insert.
 * Handles only; no title, no membership, nothing else leaves the query.
 */
async function takenHandles(orgId: string, base: string): Promise<Set<string>> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = (await withPrivilegedDb(orgId, "thread-handle-collisions", (tx) =>
    tx.execute(drizzleSql`
      SELECT handle FROM ${k}.threads
      WHERE org_id = ${orgId}::uuid AND (handle = ${base} OR handle LIKE ${`${base}-%`})
    `),
  )) as unknown
  return new Set(extractRows<{ handle: string }>(rows).map((r) => r.handle))
}

/** `base`, else `base-2`, `base-3`, ... : the first one free in this org. */
function firstFree(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`No free handle for "${base}"`)
}

/**
 * The handle a room should carry. A title yields its slug; anything else (no
 * title, or a title that slugs to nothing, e.g. "???") falls back to the
 * sequence. The fallback re-draws when the drawn handle is taken, which is how
 * a title that itself slugs to `thread-5` stops poisoning a later create.
 */
export async function allocateThreadHandle(
  tx: RlsTx | PrivilegedDb,
  params: { orgId: string; title: string | null | undefined },
): Promise<string> {
  const base = params.title ? slugifyTitle(params.title) : ""
  if (base && !isAutoThreadHandle(base)) {
    return firstFree(base, await takenHandles(params.orgId, base))
  }
  const seq = `${schemaRef("kernel")}.thread_handle_seq`
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = await nextHandle(tx, seq, "thread")
    const taken = await takenHandles(params.orgId, candidate)
    if (!taken.has(candidate)) return candidate
  }
  throw new Error("No free sequence handle")
}

/**
 * The handle after a rename, or null to leave the row's handle alone. A room
 * whose handle nobody hand-picked follows its name; anything else keeps what
 * it has, because a handle people have been linking to is not ours to move.
 */
export async function handleForRetitle(params: {
  orgId: string
  currentHandle: string
  currentTitle: string | null
  nextTitle: string | null
}): Promise<string | null> {
  if (!isDerivedThreadHandle(params.currentHandle, params.currentTitle)) return null
  const base = params.nextTitle ? slugifyTitle(params.nextTitle) : ""
  if (!base || isAutoThreadHandle(base)) return null
  if (params.currentHandle === base) return null
  const taken = await takenHandles(params.orgId, base)
  taken.delete(params.currentHandle)
  return firstFree(base, taken)
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org purge outside Postgres: the search index, Redis, the job schedulers
// and object storage.
import { removeOrgJobSchedulers } from "~/infra/jobs/jobs"
import { deleteOrgPrefix, listOrgPrefixIter } from "~/infra/storage/object-storage"
import { bullPrefix, redisBullMQ } from "~/lib/redis"
import { countOrgLiveTurns, purgeOrgLiveTurns } from "~/modules/agent/runtime/stream-registry"
import { rawDeleteItem, sendIndexWrite } from "~/modules/search/index-writer"

const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertOrgUuid(orgId: string, what: string): void {
  if (!ORG_UUID_RE.test(orgId)) throw new Error(`${what}: not an org uuid`)
}

/** The Meili filter matching every document of the org (`org_id` is filterable, index-shape.ts). */
export function orgSearchFilter(orgId: string): string {
  assertOrgUuid(orgId, "orgSearchFilter")
  return `org_id = "${orgId}"`
}

/**
 * Delete every search document of the org (entity documents, messages and
 * windows, brief rows and episodes, mail fragments: one shared index, isolated
 * by `org_id`) with ONE filter delete, and note it for a running rebuild, whose
 * shadow index may hold documents from a page it streamed before the purge: the
 * rebuild replays the filter on the shadow (reindex.ts, replayTouched). Returns
 * the Meili task uids without waiting; a note that cannot be written throws
 * (index-writer.ts, noteIndexWrites), so the step is retried rather than lost.
 */
export async function deleteOrgSearchDocuments(orgId: string): Promise<number[]> {
  const filter = orgSearchFilter(orgId)
  return sendIndexWrite(
    { deleteFilters: [filter] },
    { replay: [rawDeleteItem(orgId, `org-purge:${orgId}`, { filter })] },
  )
}

/**
 * Buckets one SCAN call visits. A purge walks the WHOLE keyspace to find an
 * org's keys, so on a busy box (hundreds of thousands of keys) the walk's
 * round trips, not Redis, were most of a purge's Redis step: 500 a call was
 * over 400 calls and 1.6 s per org. 5000 keeps one call to a few ms of
 * Redis time while cutting the calls tenfold.
 */
export const PURGE_SCAN_COUNT = 5000

/** Every Redis key carrying the org's uuid, BullMQ's own keys left out (see deleteOrgRedisKeys). */
async function* orgRedisKeys(orgId: string): AsyncGenerator<string[]> {
  assertOrgUuid(orgId, "orgRedisKeys")
  const queuePrefix = `${bullPrefix}:`
  let cursor = "0"
  do {
    const [next, keys] = await redisBullMQ.scan(
      cursor,
      "MATCH",
      `*${orgId}*`,
      "COUNT",
      PURGE_SCAN_COUNT,
    )
    cursor = next
    const own = keys.filter((k) => !k.startsWith(queuePrefix))
    if (own.length > 0) yield own
  } while (cursor !== "0")
}

/**
 * Delete every Redis key that carries the org's uuid (presence, rate-limit
 * buckets, signup claims, provisioning records, ...). The uuid is unique, so a
 * substring match cannot touch another tenant. Uses the client WITHOUT
 * `keyPrefix` because SCAN does not apply one; the pattern therefore starts
 * with a wildcard and covers prefixed keys too.
 *
 * BullMQ's own keys are left alone: a job hash removed from under a queue
 * leaves its id dangling in the queue's lists and sorted sets, which BullMQ
 * then trips over for every other tenant. The org's job schedulers are removed
 * through BullMQ instead (`removeOrgJobSchedulers`), and a job of a deleted or
 * deleting org still queued is dropped when it is dispatched.
 */
export async function deleteOrgRedisKeys(orgId: string): Promise<number> {
  assertOrgUuid(orgId, "deleteOrgRedisKeys")
  let removed = 0
  for (const purge of ORG_STATE_NOT_NAMED_BY_ORG) removed += await purge.delete(orgId)
  for await (const keys of orgRedisKeys(orgId)) removed += await redisBullMQ.unlink(...keys)
  return removed
}

/**
 * Org state whose key name does not carry the org uuid, so the SCAN above cannot
 * see it: each entry finds the org's keys by its key builder's pattern and the
 * owner recorded in the value. Live agent turns are keyed by a hash of thread,
 * agent and turn and hold the turn's text and tool calls. Anything else keyed by
 * a non-org id names the org in its key instead (e.g. warm compaction's kept
 * request), and presence keys carry it already.
 */
const ORG_STATE_NOT_NAMED_BY_ORG: ReadonlyArray<{
  name: string
  delete: (orgId: string) => Promise<number>
  count: (orgId: string) => Promise<number>
}> = [{ name: "agent live turns", delete: purgeOrgLiveTurns, count: countOrgLiveTurns }]

/**
 * How many Redis keys still carry the org's uuid (BullMQ's own left out), plus
 * the org's state found by key-builder pattern (live agent turns).
 */
export async function countOrgRedisKeys(orgId: string): Promise<number> {
  let n = 0
  for (const purge of ORG_STATE_NOT_NAMED_BY_ORG) n += await purge.count(orgId)
  // The transfer ack record is each live process's note of the org's state and
  // expires by itself; a process still holding the org's last state rewrites it
  // after a purge deleted it, so it never counts as something the purge left.
  const ackSuffix = `org-transfer:ack:${orgId}`
  for await (const keys of orgRedisKeys(orgId))
    n += keys.filter((k) => !k.endsWith(ackSuffix)).length
  return n
}

/** How many objects are left under `orgs/<orgId>/`. */
export async function countOrgObjects(orgId: string): Promise<number> {
  let n = 0
  for await (const _ of listOrgPrefixIter({ orgId })) n += 1
  return n
}

/** What the purge removes outside Postgres; a seam so a test needs neither. */
export interface OrgExternalStateDeps {
  deleteObjects?: (orgId: string) => Promise<number>
  countObjects?: (orgId: string) => Promise<number>
  deleteRedisKeys?: (orgId: string) => Promise<number>
  deleteJobSchedulers?: (orgId: string) => Promise<number>
}

/** The org's objects under `orgs/<orgId>/` (exports included), through the seam. */
export function deleteOrgObjectsWith(
  deps: OrgExternalStateDeps,
): (orgId: string) => Promise<number> {
  return deps.deleteObjects ?? ((id) => deleteOrgPrefix({ orgId: id }))
}

/** The org's Redis keys, through the seam. */
export function deleteOrgRedisKeysWith(
  deps: OrgExternalStateDeps,
): (orgId: string) => Promise<number> {
  return deps.deleteRedisKeys ?? deleteOrgRedisKeys
}

/** The org's job schedulers, through the seam. */
export function deleteOrgJobSchedulersWith(
  deps: OrgExternalStateDeps,
): (orgId: string) => Promise<number> {
  return deps.deleteJobSchedulers ?? removeOrgJobSchedulers
}

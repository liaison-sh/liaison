// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which object store and search index an instance writes to. Two cells that
// share either one would make a move copy nothing and its purge delete the
// live copy's files or documents. Config strings cannot prove the two differ
// (one bucket has many endpoint spellings), so the move proves it: in `hello`
// the target writes a probe object, a probe search document and a probe Redis
// key, and the source looks for each in its own store, index and Redis (the
// purge of a moved copy deletes the org's Redis keys and job schedulers too).
// Seeing any means shared, and the move refuses. Every purge of a moved or incoming copy then requires the
// recorded proof: the source's peer record, the target's proof mark.
import { randomBytes } from "node:crypto"
import { effectiveIndexName, getMeili } from "~/infra/search/client"
import { deleteObject, getObjectBuffer, putObject } from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { writeIndexAndWait } from "~/modules/search/index-writer"

export interface StorageIdentity {
  /** Object store endpoint and bucket. */
  objects: string
  /** Search host and index name. */
  search: string
  /** Set on the source's record once the probes proved the two cells' stores differ. */
  proven?: boolean
}

/** What the target wrote in `hello` for the source to look for. */
export interface StorageProbe {
  objectKey: string
  searchId: string
  token: string
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\/+$/, "")

export function storageIdentity(): StorageIdentity {
  return {
    objects: `${norm(env.OBJECT_STORAGE_ENDPOINT)}|${norm(env.OBJECT_STORAGE_BUCKET)}`,
    search: `${norm(env.MEILISEARCH_HOST)}|${norm(effectiveIndexName())}`,
  }
}

/** What the two identities share (empty: nothing). */
export function sharedStorage(a: StorageIdentity, b: StorageIdentity): string[] {
  const out: string[] = []
  if (a.objects === b.objects) out.push(`the object store (${a.objects})`)
  if (a.search === b.search) out.push(`the search index (${a.search})`)
  return out
}

const peerKey = (transferId: string) => `org-transfer:peer-storage:${transferId}`
const PEER_TTL_S = 60 * 24 * 3600

/** Source: keep the target's storage identity the move was checked against. */
export async function recordPeerStorage(transferId: string, peer: StorageIdentity): Promise<void> {
  await redis.set(peerKey(transferId), JSON.stringify(peer), "EX", PEER_TTL_S)
}

export async function readPeerStorage(transferId: string): Promise<StorageIdentity | null> {
  const raw = await redis.get(peerKey(transferId))
  return raw === null ? null : (JSON.parse(raw) as StorageIdentity)
}

/** The org id of the probe search document: the nil uuid, never a tenant. */
export const PROBE_SEARCH_ORG_ID = "00000000-0000-0000-0000-000000000000"

/** Target, in `hello`: write a probe object and a probe search document of the org. */
export async function writeStorageProbe(orgId: string, transferId: string): Promise<StorageProbe> {
  const token = randomBytes(16).toString("hex")
  const probe = {
    objectKey: `orgs/${orgId}/.transfer-probe-${transferId}`,
    searchId: `transfer-probe-${transferId}`,
    token,
  }
  await putObject({ key: probe.objectKey, body: Buffer.from(token), contentType: "text/plain" })
  // Written under no tenant (the nil org id no org can hold): every search is
  // filtered on its org, so the probe never shows in the moving org's results,
  // even if it outlives a failed clear. The source reads it by id.
  await writeIndexAndWait({
    docs: [
      { id: probe.searchId, org_id: PROBE_SEARCH_ORG_ID, title: "transfer probe", probe: token },
    ],
  })
  await redis.set(redisProbeKey(transferId), token, "EX", REDIS_PROBE_TTL_S)
  return probe
}

const redisProbeKey = (transferId: string) => `org-transfer:probe:${transferId}`
const REDIS_PROBE_TTL_S = 24 * 3600
const transferIdOf = (probe: StorageProbe) =>
  /\.transfer-probe-([0-9a-f-]{36})$/.exec(probe.objectKey)?.[1] ?? null

/** Target: remove the probe (whatever the source found). */
export async function clearStorageProbe(probe: StorageProbe): Promise<void> {
  await deleteObject(probe.objectKey)
  await writeIndexAndWait({ deleteIds: [probe.searchId] })
  const transferId = transferIdOf(probe)
  if (transferId) await redis.del(redisProbeKey(transferId))
}

const notFound = (err: unknown, codes: string[]) => {
  const e = err as {
    name?: string
    code?: string
    cause?: { code?: string }
    $metadata?: { httpStatusCode?: number }
  }
  return (
    codes.includes(e?.name ?? "") ||
    codes.includes(e?.code ?? "") ||
    codes.includes(e?.cause?.code ?? "") ||
    e?.$metadata?.httpStatusCode === 404
  )
}

/**
 * Source: what of the target's probe this cell sees in its own object store
 * and search index (empty: the stores differ). An error other than "not
 * found" throws: the move cannot prove the stores differ, so it refuses.
 */
export async function probeVisibleHere(probe: StorageProbe): Promise<string[]> {
  const out: string[] = []
  if (!/^orgs\/[0-9a-f-]{36}\/\.transfer-probe-[0-9a-f-]{36}$/.test(probe.objectKey)) {
    throw new Error("org transfer: the target's storage probe names an unexpected key")
  }
  try {
    await getObjectBuffer(probe.objectKey, undefined, { maxBytes: 1024 })
    out.push("the object store (the target's probe object is visible here)")
  } catch (err) {
    if (!notFound(err, ["NoSuchKey", "NotFound"])) throw err
  }
  try {
    await getMeili()
      .index(effectiveIndexName())
      .getDocument(probe.searchId, { fields: ["id"] })
    out.push("the search index (the target's probe document is visible here)")
  } catch (err) {
    if (!notFound(err, ["document_not_found"])) throw err
  }
  const transferId = transferIdOf(probe)
  if (transferId && (await redis.get(redisProbeKey(transferId))) === probe.token) {
    out.push("Redis (the target's probe key is visible here)")
  }
  return out
}

const proofKey = (transferId: string) => `org-transfer:storage-proof:${transferId}`

/** Target: the source proved the two cells' stores differ for this move. */
export async function recordStorageProof(transferId: string): Promise<void> {
  await redis.set(proofKey(transferId), "distinct", "EX", PEER_TTL_S)
}

/**
 * Target, before purging an incoming copy: refuses unless the move proved the
 * stores differ (a shared store would make the purge delete the source's live
 * files and documents).
 */
export async function assertIncomingPurgeSafe(transferId: string): Promise<void> {
  if ((await redis.get(proofKey(transferId))) === "distinct") return
  throw new Error(
    `org transfer: no proof that this cell's storage differs from the source's for transfer ${transferId}; the incoming copy is not purged`,
  )
}

/**
 * Source, before purging the moved copy: refuses unless the move's record
 * proves (by the probe) that the target's stores differ from this cell's.
 * Equal config names are no evidence either way: every cell reaches its own
 * search service under one name.
 */
export async function assertMovedPurgeSafe(transferId: string): Promise<void> {
  const peer = await readPeerStorage(transferId)
  if (!peer?.proven) {
    throw new Error(
      `org transfer: no proof that the target's storage differs from this cell's for transfer ${transferId} (the record is missing or unproven); nothing is purged`,
    )
  }
}

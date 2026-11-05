// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sealing the client search index on the way to disk and opening it on the way
// back (blueprint task 10.2, spec section 5.5).
//
// The adapter serializes; the crypto worker seals; this module is the only
// thing that knows both. It holds no key material: a `ShardSealer` is two
// function calls into the worker.
//
// A shard that does not open is a REBUILD, never a throw and never a partial
// restore. Three ordinary things produce that outcome: the mailbox key was
// rotated, the browser evicted half the store, or this is a different mailbox
// on a shared device. None of them is damage, and none of them may leave a
// half-populated index that would answer a search with a wrong "no matches".

import type { MailboxCryptoClient } from "~/modules/mailbox/crypto-client"
import type { MailboxSession } from "~/modules/mailbox/crypto-session"
import type { IndexShard, SearchIndexAdapter } from "~/modules/mailbox/search-index/adapter"
import type { IndexBlobStore } from "~/modules/mailbox/search-index/index-blob-store"

/** Seals and opens one shard. Both calls land in the crypto worker. */
export interface ShardSealer {
  seal(shardId: string, plaintext: string): Promise<string>
  open(shardId: string, blob: string): Promise<string>
}

/** In-worker use: drives a session directly. */
export function sessionShardSealer(session: MailboxSession): ShardSealer {
  return {
    seal: (shardId, plaintext) => session.sealIndexShard(shardId, plaintext),
    open: (shardId, blob) => session.openIndexShard(shardId, blob),
  }
}

/** Page use: goes through the worker transport. */
export function clientShardSealer(client: MailboxCryptoClient): ShardSealer {
  return {
    seal: (shardId, plaintext) => client.sealIndexShard(shardId, plaintext),
    open: (shardId, blob) => client.openIndexShard(shardId, blob),
  }
}

const STORE_PREFIX = "shard:"
/** The cursor is a mailbox fact ("this device has read up to here"), so it is
 * sealed under its own shard id like everything else. */
const CURSOR_SHARD_ID = "cursor"
const CURSOR_KEY = `${STORE_PREFIX}${CURSOR_SHARD_ID}`
/** Which shard ids the last persist wrote, so a restore knows what to ask for. */
const MANIFEST_SHARD_ID = "manifest"
const MANIFEST_KEY = `${STORE_PREFIX}${MANIFEST_SHARD_ID}`

function storeKey(shardId: string): string {
  return `${STORE_PREFIX}${shardId}`
}

export interface PersistIndexInput {
  adapter: SearchIndexAdapter
  store: IndexBlobStore
  sealer: ShardSealer
}

/**
 * Seal every shard the adapter exports and replace what the store held.
 *
 * Stale shards are deleted AFTER the new ones are written: a crash between the
 * two leaves a store with more shards than the manifest names, which a restore
 * ignores, while the other order would leave a store with fewer.
 */
export async function persistIndex(input: PersistIndexInput): Promise<{ shards: number }> {
  const shards = await input.adapter.exportShards()
  const written: string[] = []
  for (const shard of shards) {
    await input.store.put(
      storeKey(shard.shardId),
      await input.sealer.seal(shard.shardId, shard.data),
    )
    written.push(shard.shardId)
  }
  await input.store.put(
    MANIFEST_KEY,
    await input.sealer.seal(MANIFEST_SHARD_ID, JSON.stringify(written)),
  )
  const keep = new Set([...written.map(storeKey), MANIFEST_KEY, CURSOR_KEY])
  for (const key of await input.store.keys()) {
    if (!keep.has(key)) await input.store.delete(key)
  }
  return { shards: written.length }
}

export type RestoreOutcome =
  | { restored: true; shards: number }
  | { restored: false; reason: "no-index" | "shard-did-not-open" }

/**
 * Open every shard the manifest names and load them into the adapter. Nothing
 * reaches the adapter until every shard has opened, so a failure halfway leaves
 * an EMPTY index rather than a plausible-looking incomplete one.
 */
export async function restoreIndex(input: PersistIndexInput): Promise<RestoreOutcome> {
  const manifestBlob = await input.store.get(MANIFEST_KEY)
  if (!manifestBlob) return { restored: false, reason: "no-index" }
  let ids: string[]
  try {
    ids = JSON.parse(await input.sealer.open(MANIFEST_SHARD_ID, manifestBlob)) as string[]
  } catch {
    return { restored: false, reason: "shard-did-not-open" }
  }
  const shards: IndexShard[] = []
  for (const shardId of ids) {
    const blob = await input.store.get(storeKey(shardId))
    if (!blob) return { restored: false, reason: "shard-did-not-open" }
    try {
      shards.push({ shardId, data: await input.sealer.open(shardId, blob) })
    } catch {
      return { restored: false, reason: "shard-did-not-open" }
    }
  }
  await input.adapter.importShards(shards)
  return { restored: true, shards: shards.length }
}

export interface CursorInput {
  store: IndexBlobStore
  sealer: ShardSealer
}

export async function saveIndexCursor(input: CursorInput & { cursor: string }): Promise<void> {
  await input.store.put(CURSOR_KEY, await input.sealer.seal(CURSOR_SHARD_ID, input.cursor))
}

/** `null` for "never indexed", which is also what an unopenable cursor means. */
export async function loadIndexCursor(input: CursorInput): Promise<string | null> {
  const blob = await input.store.get(CURSOR_KEY)
  if (!blob) return null
  try {
    return await input.sealer.open(CURSOR_SHARD_ID, blob)
  } catch {
    return null
  }
}

/** Eviction, rotation and logout all end here: the whole cache goes. */
export async function dropPersistedIndex(store: IndexBlobStore): Promise<void> {
  await store.clear()
}

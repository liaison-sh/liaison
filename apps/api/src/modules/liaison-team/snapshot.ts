// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The forward snapshot of one bug report forwarding attempt: the client logs
// and server error signatures as they were at the reporter's first tick, held
// 10 minutes in Redis under a random id scoped to the reporter
// (`liaison-team:fwd:<orgId>:<userId>:<snapshotId>`). Every later preview and
// the submit read the same frozen lines, so a log line or a server error that
// appears after the first tick never changes what the reporter approved.
// Server errors are captured only for a reporter of the operator org: other
// orgs on a shared server never see (or send) the instance's errors.

import { randomUUID } from "node:crypto"
import { redis } from "~/lib/redis"

const TTL_SECONDS = 600

export interface ServerErrorSignature {
  signature: string
  count1h: number
}

export interface ForwardSnapshot {
  clientLogs: string[]
  /** Present only when the reporter's org is the operator org. */
  serverErrors?: ServerErrorSignature[]
}

const key = (orgId: string, userId: string, snapshotId: string) =>
  `liaison-team:fwd:${orgId}:${userId}:${snapshotId}`

export async function createSnapshot(
  orgId: string,
  userId: string,
  snapshot: ForwardSnapshot,
): Promise<string> {
  const snapshotId = randomUUID()
  await redis.set(key(orgId, userId, snapshotId), JSON.stringify(snapshot), "EX", TTL_SECONDS)
  return snapshotId
}

/** The reporter's snapshot, or null when it expired or belongs to someone else. */
export async function readSnapshot(
  orgId: string,
  userId: string,
  snapshotId: string,
): Promise<ForwardSnapshot | null> {
  const raw = await redis.get(key(orgId, userId, snapshotId))
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<ForwardSnapshot>
    if (!Array.isArray(v.clientLogs)) return null
    return {
      clientLogs: v.clientLogs.filter((l): l is string => typeof l === "string"),
      ...(Array.isArray(v.serverErrors) ? { serverErrors: v.serverErrors } : {}),
    }
  } catch {
    return null
  }
}

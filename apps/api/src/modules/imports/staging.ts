// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Files a transform run stages for its handlers (extracted zip entries,
 * downloads) live under the run's own storage prefix,
 * `orgs/<org>/kernel/import_run/<runId>/`, and are deleted when the run ends.
 * While they exist they count against the org's storage quota: each run
 * records its staged bytes in a per-org Redis hash, so a quota check sees the
 * bytes every run of the org is holding, not only its own. A run whose worker
 * crashed leaves both behind; the stale-run sweep deletes them.
 */
import { deleteOrgPrefix } from "~/infra/storage/object-storage"
import { redis } from "~/lib/redis"

const STAGED_TTL_MS = 2 * 24 * 3600_000

function stagedKey(orgId: string): string {
  return `imports:staged:${orgId}`
}

/** A run's staging prefix below `orgs/<org>/`. */
export function stagingPrefixOf(runId: string): string {
  return `kernel/import_run/${runId}/`
}

/** Record the bytes a run holds staged (null: none any more). */
export async function noteStagedBytes(
  orgId: string,
  runId: string,
  bytes: number | null,
): Promise<void> {
  const key = stagedKey(orgId)
  if (bytes === null || bytes <= 0) {
    await redis.hdel(key, runId)
    return
  }
  await redis.hset(key, runId, String(bytes))
  await redis.pexpire(key, STAGED_TTL_MS)
}

/** The bytes every run of the org holds staged right now. */
export async function orgStagedBytes(orgId: string): Promise<number> {
  const values = await redis.hvals(stagedKey(orgId))
  return values.reduce((sum, v) => sum + (Number(v) || 0), 0)
}

/** Delete a run's staged objects and release its bytes (a crashed run). */
export async function deleteRunStaging(orgId: string, runId: string): Promise<number> {
  const deleted = await deleteOrgPrefix({ orgId, sub: stagingPrefixOf(runId) })
  await noteStagedBytes(orgId, runId, null)
  return deleted
}

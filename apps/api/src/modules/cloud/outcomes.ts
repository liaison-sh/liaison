// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The idempotency store of the signed Control→cell API (kernel.cloud_request_outcomes,
// migration 0247). Each endpoint names its key (spec §3.4): a request claims
// the row before it acts, then stores its reply; a repeat gets the stored reply
// back instead of acting twice. The claim also serialises two attempts on one
// key: the second answers `busy` until the first finishes, or takes over once
// the first's claim is stale (it died part way; the endpoint resumes).
//
// Replies are sealed with the instance encryption key, bound to the endpoint
// and key: a handoff reply carries a one-time sign-in link.

import { createHash } from "node:crypto"
import { and, sql as drizzleSql, eq, isNotNull, lt } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { cloudRequestOutcomes } from "~/db/schema/kernel"
import { decryptSecret, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"

/** The endpoint of `POST /orgs` (keyed by slug); the org purge clears its row. */
export const CLOUD_CREATE_ORG_ENDPOINT = "POST /orgs"

/** A claim older than this is taken to have died and may be taken over. */
const STALE_CLAIM_SECONDS = 60

export type OutcomeClaim =
  /** This attempt owns the key; `resumed` when it took over a stale claim. */
  | { kind: "claimed"; resumed: boolean }
  /** The key was answered before: return this reply. */
  | { kind: "done"; status: number; reply: unknown }
  /** The key is held for different request fields. */
  | { kind: "mismatch" }
  /** Another attempt is working on the key right now. */
  | { kind: "busy" }

const sealContext = (endpoint: string, key: string) => `cloud-request-outcome:${endpoint}:${key}`
const bindingHash = (binding: string) => createHash("sha256").update(binding).digest("hex")

/** Deletes every outcome past its `expires_at`. */
export async function purgeExpiredOutcomes(): Promise<void> {
  await withSystemDb("cloud-outcomes-purge", (db) =>
    db
      .delete(cloudRequestOutcomes)
      .where(
        and(
          isNotNull(cloudRequestOutcomes.expiresAt),
          lt(cloudRequestOutcomes.expiresAt, drizzleSql`now()`),
        ),
      ),
  )
}

/** Claims `(endpoint, key)` for a request whose matching fields are `binding`. */
export async function claimOutcome(
  endpoint: string,
  key: string,
  binding: string,
): Promise<OutcomeClaim> {
  const hash = bindingHash(binding)
  return withSystemDb("cloud-outcomes-claim", async (db) => {
    const inserted = await db
      .insert(cloudRequestOutcomes)
      .values({ endpoint, idemKey: key, bindingHash: hash })
      .onConflictDoNothing()
      .returning({ key: cloudRequestOutcomes.idemKey })
    if (inserted.length > 0) return { kind: "claimed", resumed: false }

    const [row] = await db
      .select({
        bindingHash: cloudRequestOutcomes.bindingHash,
        statusCode: cloudRequestOutcomes.statusCode,
        outcomeSealed: cloudRequestOutcomes.outcomeSealed,
        stale: drizzleSql<boolean>`${cloudRequestOutcomes.claimedAt} < now() - make_interval(secs => ${STALE_CLAIM_SECONDS}::double precision)`,
      })
      .from(cloudRequestOutcomes)
      .where(
        and(eq(cloudRequestOutcomes.endpoint, endpoint), eq(cloudRequestOutcomes.idemKey, key)),
      )
      .for("update")
    // Deleted between the insert and the read (a released claim): answer busy, the caller retries.
    if (!row) return { kind: "busy" }
    if (row.bindingHash !== hash) return { kind: "mismatch" }
    if (row.outcomeSealed !== null && row.statusCode !== null) {
      const reply: unknown = JSON.parse(
        decryptSecret(row.outcomeSealed, env.ENCRYPTION_KEY, sealContext(endpoint, key)),
      )
      return { kind: "done", status: row.statusCode, reply }
    }
    if (!row.stale) return { kind: "busy" }
    await db
      .update(cloudRequestOutcomes)
      .set({ claimedAt: drizzleSql`now()` })
      .where(
        and(eq(cloudRequestOutcomes.endpoint, endpoint), eq(cloudRequestOutcomes.idemKey, key)),
      )
    return { kind: "claimed", resumed: true }
  })
}

/**
 * Stores the reply of a claimed key. `ttlSeconds` set = the row is purged that
 * long after it was first claimed.
 */
export async function completeOutcome(
  endpoint: string,
  key: string,
  status: number,
  reply: unknown,
  ttlSeconds?: number,
): Promise<void> {
  const sealed = encryptSecret(
    JSON.stringify(reply),
    env.ENCRYPTION_KEY,
    sealContext(endpoint, key),
  )
  await withSystemDb("cloud-outcomes-complete", (db) =>
    db
      .update(cloudRequestOutcomes)
      .set({
        statusCode: status,
        outcomeSealed: sealed,
        completedAt: drizzleSql`now()`,
        expiresAt:
          ttlSeconds === undefined
            ? null
            : drizzleSql`${cloudRequestOutcomes.createdAt} + make_interval(secs => ${ttlSeconds}::double precision)`,
      })
      .where(
        and(eq(cloudRequestOutcomes.endpoint, endpoint), eq(cloudRequestOutcomes.idemKey, key)),
      ),
  )
}

/** Gives a claim up without a reply, when the attempt wrote nothing. */
export async function releaseClaim(endpoint: string, key: string): Promise<void> {
  await withSystemDb("cloud-outcomes-release", (db) =>
    db
      .delete(cloudRequestOutcomes)
      .where(
        and(
          eq(cloudRequestOutcomes.endpoint, endpoint),
          eq(cloudRequestOutcomes.idemKey, key),
          drizzleSql`${cloudRequestOutcomes.outcomeSealed} IS NULL`,
        ),
      ),
  )
}

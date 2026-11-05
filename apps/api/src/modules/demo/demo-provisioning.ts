// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The workspace's READINESS.
//
// WHY THIS EXISTS. Seeding a demo workspace takes up to two minutes. The signup
// route used to do it inside the request, under the global 30 s `/api/*`
// timeout, which Hono does NOT use to cancel the handler: the visitor got a 504
// while the seed ran to completion, marked an org and minted a session nobody
// ever received.
//
// So the route now answers in the time it takes to make an org, a user and a
// session, and the seed runs behind it. One fact has to outlive the request for
// that to be safe:
//
//   READY    how far the seed has got, so the UI can fill the workspace in while
//            the visitor watches instead of showing them a spinner.
//
// There used to be a second one, a signup CLAIM keyed on the socket peer and the
// typed address, which let a retry ADOPT the workspace instead of seeding a
// second one. Behind a reverse proxy every visitor shares the proxy's peer, so
// the claim reduced to the address alone and handed a visitor's workspace to
// whoever typed their address. It is gone: every signup is a new workspace.
//
// It lives in Redis, which the signup path already requires (the limiter fails
// CLOSED on a Redis outage). It carries no tenant data: a state word and two
// timestamps.
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"

const log = rootLogger.child({ module: "demo-provisioning" })

/** How long readiness stays readable. Comfortably longer than any seed. */
const READY_TTL_SECONDS = 6 * 60 * 60

/**
 * THE ONE DEADLINE. Every other number about how long a seed may take is
 * derived from this, here and in the two places that used to carry their own:
 * `demo-seeder.ts` waits exactly this long before giving up on the seeder, and
 * the web poll stops at the `pollUntil` the status route computes below.
 *
 * They disagreed. The seeder's own budget was raised to 900s once the domain
 * layers were added to the seed, and this was left at five minutes and the web
 * poll at ten. So a visitor whose seed legitimately took six minutes, which is
 * the exact case the 900s raise exists for, was told the seed had not finished, the poll stopped on that answer, and they were
 * never told the world had actually finished. One constant, three consumers.
 */
export const DEMO_SEED_DEADLINE_MS = 900_000

/**
 * A seed that has been "provisioning" longer than this is reported as
 * `failed`, not as still running: past the deadline the seeder itself has
 * already given up and written a terminal state, so the only way to still be
 * here is a process that died mid-seed, and a visitor must not poll a state
 * that will never change. The grace is what separates "the seeder is about to
 * write `failed` itself" from "nobody is going to write anything": without it
 * this would race the seeder's own terminal write and call a finished seed
 * stale.
 */
const STALE_GRACE_MS = 60_000
export const STALE_PROVISIONING_MS = DEMO_SEED_DEADLINE_MS + STALE_GRACE_MS

/**
 * How far the workspace has filled in.
 *  - `provisioning`: the seed is running; the org is already usable.
 *  - `ready`: the seed finished and the workspace is fully populated.
 *  - `failed`: a part of the seed failed, timed out or was interrupted. An
 *    error: logged at error level with the parts that failed, and shown to
 *    the visitor as one, never presented as a finished workspace. Never a
 *    wedged state, and never retried behind the visitor's back.
 */
export type DemoProvisioningState = "provisioning" | "ready" | "failed"

export interface DemoProvisioningRecord {
  orgId: string
  state: DemoProvisioningState
  startedAt: string
  finishedAt?: string
  /** On `failed`: the parts that failed, by name (`commerce`, `app:shopify`, `timeout`). */
  failedParts?: string[]
}

const readyRedisKey = (orgId: string): string => `demo:provisioning:${orgId}`

/** Record where the seed has got to. Best effort: never fails a request. */
export async function writeProvisioning(record: DemoProvisioningRecord): Promise<void> {
  try {
    await redis.set(readyRedisKey(record.orgId), JSON.stringify(record), "EX", READY_TTL_SECONDS)
  } catch (err) {
    log.warn({ err, orgId: record.orgId }, "failed to record demo provisioning state")
  }
}

/**
 * When a client watching this record should stop asking. The SERVER's own
 * answer, so the web poll no longer carries a second copy of the deadline that
 * can drift from this one. Null once the record is terminal: there is nothing
 * left to wait for.
 */
export function pollUntil(record: DemoProvisioningRecord): string | null {
  if (record.state !== "provisioning") return null
  return new Date(Date.parse(record.startedAt) + STALE_PROVISIONING_MS).toISOString()
}

/**
 * Where the seed has got to, with a stale `provisioning` reported as `failed`.
 * A record that has expired (or was never written, e.g. an org seeded before
 * this mechanism existed) reads as `ready`: there is nothing still running.
 */
export async function readProvisioning(
  orgId: string,
  now: Date = new Date(),
): Promise<DemoProvisioningRecord> {
  let raw: string | null = null
  try {
    raw = await redis.get(readyRedisKey(orgId))
  } catch (err) {
    log.warn({ err, orgId }, "failed to read demo provisioning state")
  }
  if (raw === null) {
    return { orgId, state: "ready", startedAt: now.toISOString() }
  }
  let record: DemoProvisioningRecord
  try {
    record = JSON.parse(raw) as DemoProvisioningRecord
  } catch {
    return { orgId, state: "ready", startedAt: now.toISOString() }
  }
  // A record the previous release wrote while two releases overlap.
  if ((record.state as string) === "partial") return { ...record, state: "failed" }
  if (
    record.state === "provisioning" &&
    now.getTime() - Date.parse(record.startedAt) > STALE_PROVISIONING_MS
  ) {
    return {
      ...record,
      state: "failed",
      failedParts: ["interrupted"],
      finishedAt: now.toISOString(),
    }
  }
  return record
}

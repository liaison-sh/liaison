// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The production-safe load harness: what lets a stress run drive a real box
 * (a public demo box included) without weakening it.
 *
 * Three parts, all off unless the box secret `LOAD_HARNESS_KEY` is set:
 *
 * - **The key.** `loadHarnessEnabled()` is true only with the key set (at
 *   least 32 characters, lib/env.ts). Unset, the harness routes answer 404 and
 *   the org flag below does nothing, whatever an org's settings say.
 * - **The org flag.** `isLoadOrg(orgId)` is `settings.loadHarness === true`
 *   on an org, with the key set. Only the signed demo-door start and the load
 *   seed tier (`liaison seed --tier load`, run on the box) set it, in the same
 *   statement as the org's demo marker, so every load org is also a visitor
 *   demo org under the demo egress lockdown (no customer mail, no real
 *   connector credentials). The org-settings PATCH schema is strict and
 *   refuses the key (packages/shared validation/org.ts), so no admin can turn
 *   it on. A load org's kernel mail, pushes, Web Push and demo codes are
 *   counted in the effect sink (lib/effect-sink.ts) instead of sent, and its
 *   agent turns run on the scripted load model
 *   (modules/agent/providers/load-scripts.ts). An unflagged org is untouched.
 * - **Signed requests.** `verifyHarnessSignature` checks an HMAC-SHA256 over
 *   the method, the path, a timestamp, a nonce and the body's SHA-256, made
 *   with the key. It refuses more than 30 s of clock skew and a nonce it saw
 *   before (Redis `SET NX`, so every process of the box shares the memory),
 *   and compares in constant time. A signed request is what the demo door's
 *   harness path accepts (modules/demo/routes.ts).
 *
 * This is a request signature with a box secret; it encrypts nothing.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { demoLeads, organizations } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"

const log = rootLogger.child({ module: "load-harness" })

export const HARNESS_HEADER_TIMESTAMP = "x-liaison-harness-timestamp"
export const HARNESS_HEADER_NONCE = "x-liaison-harness-nonce"
export const HARNESS_HEADER_SIGNATURE = "x-liaison-harness-signature"

/** A signed request older or newer than this is refused. */
export const HARNESS_MAX_SKEW_MS = 30_000

/** How long an org's flag is cached in this process. */
const FLAG_TTL_MS = 30_000

let keyOverride: string | null | undefined

function harnessKey(): string | undefined {
  if (keyOverride !== undefined) return keyOverride ?? undefined
  return env.LOAD_HARNESS_KEY
}

/** Is the harness on for this box (`LOAD_HARNESS_KEY` set)? */
export function loadHarnessEnabled(): boolean {
  const key = harnessKey()
  return typeof key === "string" && key.length >= 32
}

/** The load-org flag could not be read: the caller fails (and retries) rather than guess. */
export class LoadOrgFlagUnreadable extends Error {
  readonly orgId: string
  constructor(orgId: string, cause: unknown) {
    super(`the load-harness flag of org ${orgId} could not be read`, { cause })
    this.name = "LoadOrgFlagUnreadable"
    this.orgId = orgId
  }
}

const flagCache = new Map<string, { value: boolean; at: number }>()

/**
 * Is `orgId` a load org: the harness on, and the org's `settings.loadHarness`
 * exactly `true`? Cached per process for 30 s.
 *
 * A read failure has no safe guess: answering "real" would spend the box's
 * model budget on a load org's turn and send a load org's mail for real;
 * answering "load" would sink a real org's mail and give it the scripted
 * model. So it answers the last value this process read, if any, and
 * otherwise throws `LoadOrgFlagUnreadable`: the turn fails and the job
 * retries later, loudly, instead of guessing. Only boxes with the key read
 * the flag at all.
 */
export async function isLoadOrg(orgId: string | null | undefined): Promise<boolean> {
  if (!orgId || !loadHarnessEnabled()) return false
  const cached = flagCache.get(orgId)
  if (cached && Date.now() - cached.at < FLAG_TTL_MS) return cached.value
  let value = false
  try {
    const rows = await withPrivilegedDb(orgId, "load-harness:flag", (tx) =>
      tx
        .select({
          flag: drizzleSql<boolean>`COALESCE((${organizations.settings}->'loadHarness') = 'true'::jsonb, false)`,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1),
    )
    value = rows[0]?.flag === true
  } catch (err) {
    if (cached) return cached.value
    log.error({ err, orgId }, "load_harness_flag_unreadable")
    throw new LoadOrgFlagUnreadable(orgId, err)
  }
  flagCache.set(orgId, { value, at: Date.now() })
  if (flagCache.size > 10_000) {
    const oldest = flagCache.keys().next()
    if (!oldest.done) flagCache.delete(oldest.value)
  }
  return value
}

/**
 * The settings fragment that flags an org as a load org, for a caller that
 * writes it in the same statement that makes the org a demo org (the demo
 * door's signed start), so no process can ever read the org without its flag.
 * Refuses while the harness is off. Call `rememberLoadOrg` once it committed.
 */
export function loadOrgSettingsFragment(): { loadHarness: true } {
  if (!loadHarnessEnabled()) throw new Error("the load harness is off (LOAD_HARNESS_KEY unset)")
  return { loadHarness: true }
}

/**
 * Is any of `orgIds` a load org? Cached flags first, then one query for the
 * rest (a fan-out tick asks this for every org it runs). False while the
 * harness is off.
 */
export async function anyLoadOrg(orgIds: readonly string[]): Promise<boolean> {
  if (orgIds.length === 0 || !loadHarnessEnabled()) return false
  const unknown: string[] = []
  for (const orgId of orgIds) {
    const cached = flagCache.get(orgId)
    if (!cached || Date.now() - cached.at >= FLAG_TTL_MS) unknown.push(orgId)
    else if (cached.value) return true
  }
  if (unknown.length === 0) return false
  const rows = await withSystemDb("load-harness:any-flag", (db) =>
    db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          drizzleSql`${organizations.id} = ANY(${`{${unknown.join(",")}}`}::uuid[])`,
          drizzleSql`(${organizations.settings}->'loadHarness') = 'true'::jsonb`,
        ),
      )
      .limit(1),
  )
  return rows.length > 0
}

/** Cache the flag of an org whose `loadHarness` this process just wrote. */
export function rememberLoadOrg(orgId: string): void {
  flagCache.set(orgId, { value: true, at: Date.now() })
}

/**
 * The harness's own addresses: anything on the reserved `.invalid` TLD
 * (RFC 2606), which no mail can ever reach. A synthetic visitor must use one
 * and a person can never sign up with one.
 */
export function isLoadHarnessAddress(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@").pop() ?? ""
  return domain === "invalid" || domain.endsWith(".invalid")
}

/**
 * The same test over `kernel.demo_leads.email`, in SQL: a load-harness lead
 * (only a signed start may use such an address, so these rows are the load lane's).
 * Such a lead never counts against visitors' ceilings and is never sent to the
 * Liaison team.
 */
export const syntheticLead = drizzleSql`(lower(${demoLeads.email}) LIKE '%.invalid' OR lower(${demoLeads.email}) LIKE '%@invalid')`

/** Forget a cached flag (tests). */
export function forgetLoadOrgFlag(orgId?: string): void {
  if (orgId) flagCache.delete(orgId)
  else flagCache.clear()
}

export interface HarnessSignedFields {
  method: string
  /**
   * The request path, without the query string: the query is NOT signed, so a
   * harness route must never read one (the demo door reads none).
   */
  path: string
  timestamp: number
  nonce: string
  /** The exact bytes sent. */
  body: string | Uint8Array
}

function signWith(key: string, fields: HarnessSignedFields): string {
  const bodyHash = createHash("sha256").update(fields.body).digest("hex")
  return createHmac("sha256", key)
    .update(
      [
        fields.method.toUpperCase(),
        fields.path,
        String(fields.timestamp),
        fields.nonce,
        bodyHash,
      ].join("\n"),
    )
    .digest("hex")
}

/** The signature a harness client sends (hex). Throws when the harness is off. */
export function signHarnessRequest(fields: HarnessSignedFields, key = harnessKey()): string {
  if (!key) throw new Error("the load harness is off (LOAD_HARNESS_KEY unset)")
  return signWith(key, fields)
}

const SIGNATURE_RE = /^[0-9a-f]{64}$/
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/

export type HarnessVerdict =
  /** No harness header at all: an ordinary request. */
  | { kind: "absent" }
  | { kind: "valid" }
  | { kind: "refused"; reason: "harness_off" | "malformed" | "skew" | "bad_signature" | "replayed" }

/**
 * Check a request's harness signature. `absent` when it carries none of the
 * three headers; any harness header on a box without the key, or a bad,
 * stale or replayed one, is `refused`. The nonce is spent only once the
 * signature itself is valid, so a forger cannot burn a real client's nonces.
 */
export async function verifyHarnessSignature(req: {
  method: string
  path: string
  header: (name: string) => string | undefined
  body: string | Uint8Array
}): Promise<HarnessVerdict> {
  const ts = req.header(HARNESS_HEADER_TIMESTAMP)
  const nonce = req.header(HARNESS_HEADER_NONCE)
  const signature = req.header(HARNESS_HEADER_SIGNATURE)
  if (ts === undefined && nonce === undefined && signature === undefined) return { kind: "absent" }
  const key = harnessKey()
  if (!key || !loadHarnessEnabled()) return { kind: "refused", reason: "harness_off" }
  if (!ts || !nonce || !signature || !/^\d{1,16}$/.test(ts)) {
    return { kind: "refused", reason: "malformed" }
  }
  if (!SIGNATURE_RE.test(signature) || !NONCE_RE.test(nonce)) {
    return { kind: "refused", reason: "malformed" }
  }
  const timestamp = Number(ts)
  if (Math.abs(Date.now() - timestamp) > HARNESS_MAX_SKEW_MS) {
    return { kind: "refused", reason: "skew" }
  }
  const expected = Buffer.from(
    signWith(key, { method: req.method, path: req.path, timestamp, nonce, body: req.body }),
    "hex",
  )
  const given = Buffer.from(signature, "hex")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { kind: "refused", reason: "bad_signature" }
  }
  // A timestamp up to one skew in the future stays valid for two skews from
  // now; the nonce is kept a skew longer than that, so it can never come back
  // while its timestamp is valid. (A Redis failover that loses nonces lets one
  // replay through, which costs one more synthetic workspace in the load lane.)
  const fresh = await redis.set(
    `load-harness:nonce:${nonce}`,
    "1",
    "PX",
    HARNESS_MAX_SKEW_MS * 3,
    "NX",
  )
  if (fresh !== "OK") return { kind: "refused", reason: "replayed" }
  return { kind: "valid" }
}

/**
 * One verdict per request: the demo door's rate limiter and the route behind
 * it both ask, and a second check of the same request would read its own
 * nonce as a replay.
 */
const verdictByRequest = new WeakMap<object, Promise<HarnessVerdict>>()

/** Hono adapter: verify `c`'s request (reads the raw body, which Hono caches). */
export function verifyHarnessContext(c: {
  req: {
    method: string
    path: string
    header: (name: string) => string | undefined
    text: () => Promise<string>
    raw?: object
  }
}): Promise<HarnessVerdict> {
  const raw = c.req.raw
  const known = raw ? verdictByRequest.get(raw) : undefined
  if (known) return known
  const verdict = verifyContextOnce(c)
  if (raw) verdictByRequest.set(raw, verdict)
  return verdict
}

async function verifyContextOnce(c: {
  req: {
    method: string
    path: string
    header: (name: string) => string | undefined
    text: () => Promise<string>
  }
}): Promise<HarnessVerdict> {
  const anyHeader =
    c.req.header(HARNESS_HEADER_TIMESTAMP) !== undefined ||
    c.req.header(HARNESS_HEADER_NONCE) !== undefined ||
    c.req.header(HARNESS_HEADER_SIGNATURE) !== undefined
  if (!anyHeader) return { kind: "absent" }
  const body = await c.req.text()
  return verifyHarnessSignature({
    method: c.req.method,
    path: c.req.path,
    header: (name) => c.req.header(name),
    body,
  })
}

/** Test access: set (string), clear (null) or restore the env key (undefined). */
export const LoadHarnessTestAccess = {
  setKey(key: string | null | undefined): void {
    keyOverride = key
    flagCache.clear()
  },
}

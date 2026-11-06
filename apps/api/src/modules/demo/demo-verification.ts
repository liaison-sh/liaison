// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Demo email verification: who a demo org's visitor proved to be.
//
// The spend gate charges a visitor org's model calls to the email address its
// visitor confirmed and to the client network recorded at signup. Until a
// visitor confirms an address there is no identity, and nothing that needs one
// may run on this box's key.
//
// ONE ADDRESS PER ORG. The code goes to the address typed at Start (the lead's)
// and nowhere else: there is no "change address" here, so this box can never
// be aimed at a third party's inbox more than the Start form already allows,
// and those sends are capped (3 per IP per hour, 60 per hour box-wide, 3 per
// org for its life).
//
// THE CODE. Six digits from the CSPRNG, stored only as an HMAC in Redis
// (`demo:code:<org>`) with its own expiry (10 minutes) and a wrong-guess
// allowance (5): the sixth guess is refused whatever it is. A new send replaces
// the previous code.
//
// THE LINK. The same mail carries `/demo/verify?t=<token>`, the token an HMAC
// over (org, code id). It is single use (consumed on first presentation,
// success or not) and the page it opens NEVER verifies by itself: the visitor
// presses "Confirm my email", which runs a fresh Turnstile (`demo_verify`) and
// POSTs. A mail scanner that follows the link, even one that runs the page's
// JavaScript, confirms nothing.
//
// THE MAIL. Fixed template, no visitor-supplied text at all (not even the
// name), through the demo system mail channel (infra/email.ts).
//
// CAPS ON VERIFYING (decided in one transaction under an advisory lock, so two
// verifications cannot both take the last slot): box-wide per hour, per
// registrable domain (or alias relay) per day, per client network per hour and
// per day. The network is the one recorded at Start, never the verifying
// request's.
import crypto from "node:crypto"
import { and, eq, gte, isNotNull, isNull, like, type SQL, sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { demoLeads, users } from "~/db/schema/kernel"
import { getDemoSystemMailProvider } from "~/infra/email"
import { renderBrandedEmail } from "~/infra/email-layout"
import { recordSinkEffect, sinkDetail } from "~/lib/effect-sink"
import { env } from "~/lib/env"
import { isLoadOrg, syntheticLead } from "~/lib/load-harness"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { recordDemoCodeSendFailure } from "~/modules/demo/demo-alerts"
import { emailDomain, isDisposableDomain, maskDemoEmail } from "~/modules/demo/demo-email"
import { type DemoOrgLead, leadForDemoOrg } from "~/modules/demo/demo-leads"
import { loadDemoMarker } from "~/modules/demo/demo-org"
import { resumeWorldBeats } from "~/modules/demo/world/registry"
import { forwardDemoLeadUpdate, forwardOptedInLead } from "~/modules/liaison-team/lead-forwarding"

const log = rootLogger.child({ module: "demo-verification" })

/**
 * What a verified address is charged under in the spend budgets: a keyed hash,
 * never the address. The per-address budget is lifetime, so its counter outlives
 * the name and address the lead sweep deletes; the hash still finds a returning
 * address and cannot be read back without the server's secret.
 */
export function demoBudgetEmailKey(emailNormalized: string): string {
  return crypto.createHmac("sha256", env.JWT_SECRET).update(emailNormalized).digest("hex")
}

/** The identity a verified visitor org spends against. */
export interface DemoVerifiedIdentity {
  /** The confirmed address, normalized (one mailbox, one budget). */
  emailNormalized: string
  /** The client network recorded when the org was created. */
  network: string
}

/** A refusal the routes turn into `{status, code}` (and `attemptsLeft`, `retryAfter`). */
export class DemoVerifyError extends Error {
  constructor(
    readonly status: 400 | 404 | 410 | 422 | 429 | 503,
    readonly code:
      | "code_invalid"
      | "code_expired"
      | "code_attempts_exhausted"
      | "code_send_limited"
      | "verify_limited"
      | "disposable_email"
      | "demo_mail_unavailable"
      | "no_lead",
    readonly extra: { attemptsLeft?: number; retryAfter?: number } = {},
  ) {
    super(code)
    this.name = "DemoVerifyError"
  }
}

let nowFn: () => number = () => Date.now()
const now = () => nowFn()

const codeKey = (orgId: string) => `demo:code:${orgId}`
const linkUsedKey = (codeId: string) => `demo:link-used:${codeId}`
const orgSendsKey = (orgId: string) => `demo:code-sends:${orgId}`

function hmacKey(): Buffer {
  return crypto.createHmac("sha256", env.JWT_SECRET).update("liaison-demo-verification").digest()
}

function hmac(...parts: string[]): string {
  return crypto.createHmac("sha256", hmacKey()).update(parts.join("\u0000")).digest("base64url")
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

/** `<org>.<codeId>.<mac>`: names its org only through the MAC. */
export function demoLinkToken(orgId: string, codeId: string): string {
  return `${orgId}.${codeId}.${hmac("link", orgId, codeId)}`
}

function parseLinkToken(token: string): { orgId: string; codeId: string } | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [orgId, codeId, mac] = parts
  if (!orgId || !codeId || !mac) return null
  return safeEqual(mac, hmac("link", orgId, codeId)) ? { orgId, codeId } : null
}

export function demoVerifyUrl(token: string): string {
  const url = new URL("/demo/verify", env.BASE_URL)
  url.searchParams.set("t", token)
  return url.toString()
}

/**
 * The two fixed templates' first: code + link. No visitor text. Branded like
 * every other transactional mail (`renderBrandedEmail`, the sign-in code's
 * shape): the code in the card's code block, the link as the button.
 */
export function demoCodeMail(
  code: string,
  link: string,
): { subject: string; html: string; text: string } {
  const subject = `${code} is your Liaison demo code`
  const { html, text } = renderBrandedEmail({
    subject,
    eyebrow: "Demo",
    heading: "Your demo code",
    code,
    paragraphs: [
      `Enter it in the demo. The code expires in ${env.LIAISON_DEMO_CODE_TTL_MINUTES} minutes. You can also press the button below and then Confirm.`,
      "If you did not start a Liaison demo, you can safely ignore this email.",
    ],
    cta: { label: "Confirm my email", href: link },
    footer: ["You're receiving this because a Liaison demo was started with this email address."],
  })
  return { subject, html, text }
}

/**
 * Send (or re-send) the org's code to its lead's address. `ipBucket` is the
 * caller's per-IP bucket (demo-peer.ts). Throws {@link DemoVerifyError}.
 */
export async function sendDemoCode(
  orgId: string,
  ipBucket: string,
): Promise<
  { sent: true; emailMasked: string } | { sent: false; emailMasked: string; verified: true }
> {
  const lead = await leadForDemoOrg(orgId)
  if (!lead) throw new DemoVerifyError(404, "no_lead")
  const emailMasked = maskDemoEmail(lead.email)
  if (lead.verifiedAt) return { sent: false, emailMasked, verified: true }
  if (isDisposableDomain(emailDomain(lead.email)))
    throw new DemoVerifyError(422, "disposable_email")

  // A synthetic visitor's workspace (a load org, lib/load-harness.ts): its
  // code goes to the effect sink, where the harness reads it back, and the
  // per-network limit does not apply. It spends the load lane's own box-wide
  // budget, never the visitors' (a load run cannot use up the codes real
  // visitors need); the per-org cap still applies.
  const synthetic = await isLoadOrg(orgId)

  // A box with no channel says so before any budget is spent.
  const provider = synthetic ? null : getDemoSystemMailProvider()
  if (!synthetic && !provider) throw new DemoVerifyError(503, "demo_mail_unavailable")

  const limited = await checkRateLimit(redis, [
    ...(synthetic
      ? []
      : [
          {
            identifier: `demo-code-ip:${ipBucket}`,
            limit: env.LIAISON_DEMO_CODE_SENDS_PER_IP_HOUR,
            windowSeconds: 3600,
          },
        ]),
    synthetic
      ? {
          identifier: "demo-code-synthetic",
          limit: env.LIAISON_DEMO_SYNTHETIC_PER_HOUR,
          windowSeconds: 3600,
        }
      : {
          identifier: "demo-code-global",
          limit: env.LIAISON_DEMO_CODE_SENDS_PER_HOUR,
          windowSeconds: 3600,
        },
  ])
  if (!limited.allowed) {
    throw new DemoVerifyError(429, "code_send_limited", {
      retryAfter: limited.failed.retryAfterSeconds,
    })
  }
  const orgSends = await redis.incr(orgSendsKey(orgId))
  if (orgSends === 1) await redis.expire(orgSendsKey(orgId), 30 * 24 * 3600)
  if (orgSends > env.LIAISON_DEMO_CODE_SENDS_PER_ORG) {
    throw new DemoVerifyError(429, "code_send_limited")
  }

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0")
  const codeId = crypto.randomBytes(16).toString("hex")
  const ttlMs = env.LIAISON_DEMO_CODE_TTL_MINUTES * 60_000
  await redis
    .multi()
    .del(codeKey(orgId))
    .hset(codeKey(orgId), {
      mac: hmac("code", orgId, codeId, code),
      codeId,
      attempts: "0",
      expiresAt: String(now() + ttlMs),
    })
    // The hash outlives the code by an hour, so a late guess reads "expired"
    // rather than "no code".
    .pexpire(codeKey(orgId), ttlMs + 3_600_000)
    .exec()

  const mail = demoCodeMail(code, demoVerifyUrl(demoLinkToken(orgId, codeId)))
  if (!provider) {
    await recordSinkEffect(orgId, "demo-code", codeId, code)
    return { sent: true, emailMasked }
  }
  try {
    await provider.send({ to: lead.email, ...mail, template: "demo.verification-code" })
  } catch (err) {
    log.error({ err, orgId, alert: "demo_code_send_failed" }, "demo code mail failed")
    // The code never left: nothing is on record, so the page never says one
    // was sent (`demoCodeOnRecord`), and no guess can match a code nobody has.
    await redis
      .del(codeKey(orgId))
      .catch((delErr) => log.warn({ err: delErr, orgId }, "unsent demo code could not be dropped"))
    // Five refused sends in an hour mail the owner (demo-alerts.ts).
    await recordDemoCodeSendFailure().catch((alertErr) =>
      log.warn({ err: alertErr }, "demo code send failure could not be counted"),
    )
    throw new DemoVerifyError(503, "demo_mail_unavailable")
  }
  return { sent: true, emailMasked }
}

/**
 * Was a code mailed to this org's visitor, and is it still on record? False
 * when the box could not send one (no mail channel, a provider failure), so the
 * page says so instead of pointing at a mail that never left.
 */
export async function demoCodeOnRecord(orgId: string): Promise<boolean> {
  return (await redis.exists(codeKey(orgId))) === 1
}

/**
 * The load harness's read of a load org's current demo code, which went to
 * the effect sink instead of a mailbox (`sendDemoCode`). Null for any other
 * org, whatever is on record: a real visitor's code is never read back.
 */
export async function sunkDemoCode(orgId: string): Promise<string | null> {
  if (!(await isLoadOrg(orgId))) return null
  const codeId = await redis.hget(codeKey(orgId), "codeId")
  return codeId ? sinkDetail(orgId, "demo-code", codeId) : null
}

interface StoredCode {
  mac: string
  codeId: string
  attempts: number
  expiresAt: number
}

async function readCode(orgId: string): Promise<StoredCode | null> {
  const raw = await redis.hgetall(codeKey(orgId))
  if (!raw?.mac || !raw.codeId) return null
  return {
    mac: raw.mac,
    codeId: raw.codeId,
    attempts: Number(raw.attempts ?? 0),
    expiresAt: Number(raw.expiresAt ?? 0),
  }
}

// Take one attempt on a live code: the new attempt number, or -1 when the code
// is gone (expired or consumed; never recreates the hash without its TTL).
const TAKE_ATTEMPT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
return redis.call('HINCRBY', KEYS[1], 'attempts', 1)
`

/** Verify this org by the code its visitor typed. Throws {@link DemoVerifyError}. */
export async function verifyDemoCode(
  orgId: string,
  code: string,
  ownerUserId?: string,
): Promise<void> {
  const stored = await readCode(orgId)
  if (!stored || now() > stored.expiresAt) throw new DemoVerifyError(410, "code_expired")
  const max = env.LIAISON_DEMO_CODE_ATTEMPTS
  // Every guess, right or wrong, takes one attempt FIRST, atomically, and only
  // a guess whose attempt number is within the allowance is compared: N
  // parallel guesses can never all be checked on one reading of the counter.
  const attempt = Number(await redis.eval(TAKE_ATTEMPT_LUA, 1, codeKey(orgId)))
  if (attempt < 0) throw new DemoVerifyError(410, "code_expired")
  if (attempt > max) throw new DemoVerifyError(429, "code_attempts_exhausted")
  if (!safeEqual(hmac("code", orgId, stored.codeId, code.trim()), stored.mac)) {
    throw new DemoVerifyError(400, "code_invalid", { attemptsLeft: Math.max(0, max - attempt) })
  }
  await completeVerification(orgId, ownerUserId)
}

/**
 * Verify by the link token (the caller already checked a fresh Turnstile).
 * Single use: the token is consumed on first presentation, success or not.
 */
export async function verifyDemoLink(token: string): Promise<void> {
  const parsed = parseLinkToken(token)
  if (!parsed) throw new DemoVerifyError(410, "code_expired")
  const first = await redis.set(linkUsedKey(parsed.codeId), "1", "EX", 2 * 24 * 3600, "NX")
  if (first !== "OK") throw new DemoVerifyError(410, "code_expired")
  const stored = await readCode(parsed.orgId)
  if (!stored || stored.codeId !== parsed.codeId || now() > stored.expiresAt) {
    throw new DemoVerifyError(410, "code_expired")
  }
  await completeVerification(parsed.orgId)
}

async function completeVerification(orgId: string, ownerUserId?: string): Promise<void> {
  const lead = await leadForDemoOrg(orgId)
  if (!lead) throw new DemoVerifyError(404, "no_lead")
  if (!lead.verifiedAt) {
    await markVerifiedWithinCaps(lead, await isLoadOrg(orgId))
    await forwardDemoLeadUpdate(lead.id, { verified: true })
    await forwardOptedInLead(lead.id)
  }
  await redis.del(codeKey(orgId))
  verifiedCache.delete(orgId)
  // A verified visitor may search on the box key (metered per search), but the
  // org's tools were registered when its workspace was built, before this
  // moment, and `web_search` was rightly left out then. Re-evaluate it now, or
  // the agent goes on saying web search is not available in this workspace.
  // Imported here: kernel-tools reaches this module through the spend gate.
  try {
    const { refreshWebSearchToolRegistration } = await import("~/modules/agent/tools/kernel-tools")
    await refreshWebSearchToolRegistration(orgId)
  } catch (err) {
    log.error({ err, orgId }, "advertising web_search after verification failed")
  }
  const owner = ownerUserId ?? (await visitorOwnerId(orgId))
  if (owner) {
    try {
      await resumeWorldBeats(orgId, owner)
    } catch (err) {
      log.warn({ err, orgId }, "resuming world beats after verification failed")
    }
  }
}

/**
 * Mark the lead verified within the verification ceilings. A visitor's
 * verification counts against the box, its domain and its network, over
 * visitors' leads only; a synthetic visitor's (a load org) against the load
 * lane's own hourly ceiling alone, so a load run never uses up the
 * verifications real visitors need, nor trips their network's cap.
 */
async function markVerifiedWithinCaps(lead: DemoOrgLead, synthetic: boolean): Promise<void> {
  const hourAgo = new Date(now() - 3_600_000)
  const dayAgo = new Date(now() - 24 * 3_600_000)
  await withSystemDb("demo-lead-verify", async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('liaison-demo-verify'))`)
    const count = async (since: Date, scope?: SQL) => {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(demoLeads)
        .where(
          and(
            isNotNull(demoLeads.verifiedAt),
            gte(demoLeads.verifiedAt, since),
            synthetic ? syntheticLead : sql`NOT ${syntheticLead}`,
            scope,
          ),
        )
      return row?.n ?? 0
    }
    if (synthetic) {
      if ((await count(hourAgo)) >= env.LIAISON_DEMO_SYNTHETIC_PER_HOUR) {
        throw new DemoVerifyError(429, "verify_limited")
      }
    } else {
      if ((await count(hourAgo)) >= env.LIAISON_DEMO_VERIFIED_PER_HOUR) {
        throw new DemoVerifyError(429, "verify_limited")
      }
      if (
        lead.emailCapKey &&
        (await count(dayAgo, eq(demoLeads.emailCapKey, lead.emailCapKey))) >=
          env.LIAISON_DEMO_DOMAIN_VERIFIED_PER_DAY
      ) {
        throw new DemoVerifyError(429, "verify_limited")
      }
      if (lead.signupNetwork) {
        const net = eq(demoLeads.signupNetwork, lead.signupNetwork)
        if (
          (await count(hourAgo, net)) >= env.LIAISON_DEMO_NETWORK_VERIFIED_PER_HOUR ||
          (await count(dayAgo, net)) >= env.LIAISON_DEMO_NETWORK_VERIFIED_PER_DAY
        ) {
          throw new DemoVerifyError(429, "verify_limited")
        }
      }
    }
    await tx
      .update(demoLeads)
      .set({ verifiedAt: new Date(now()) })
      .where(and(eq(demoLeads.id, lead.id), isNull(demoLeads.verifiedAt)))
  })
}

/** The visitor's own account in a demo org (its generated internal login). */
async function visitorOwnerId(orgId: string): Promise<string | null> {
  const [row] = await withSystemDb("demo-visitor-owner", (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, orgId), like(users.email, "visitor-%@visitor.demo.invalid")))
      .limit(1),
  )
  return row?.id ?? null
}

/**
 * Positive answers only: a verification never un-happens. Bounded, least
 * recently used out first: a demo cell creates thousands of short-lived visitor
 * orgs, and an evicted org only pays one lead read on its next lookup.
 */
const VERIFIED_CACHE_MAX = 2000
const verifiedCache = new Map<string, DemoVerifiedIdentity>()

function rememberVerified(orgId: string, identity: DemoVerifiedIdentity): void {
  verifiedCache.delete(orgId)
  verifiedCache.set(orgId, identity)
  if (verifiedCache.size > VERIFIED_CACHE_MAX) {
    const oldest = verifiedCache.keys().next().value
    if (oldest !== undefined) verifiedCache.delete(oldest)
  }
}

/**
 * The verified identity of a demo visitor org, or `null` when its visitor has
 * not confirmed an email address (or the org is not a visitor org). Read from
 * the lead row only: nothing the visitor can write (org settings, the marker)
 * takes part.
 */
export async function demoVerifiedIdentity(orgId: string): Promise<DemoVerifiedIdentity | null> {
  const cached = verifiedCache.get(orgId)
  if (cached) {
    rememberVerified(orgId, cached)
    return cached
  }
  const marker = await loadDemoMarker(orgId)
  if (marker?.variant !== "visitor") return null
  const lead = await leadForDemoOrg(orgId)
  if (!lead?.verifiedAt || !lead.emailNormalized) return null
  const identity = {
    emailNormalized: demoBudgetEmailKey(lead.emailNormalized),
    network: lead.signupNetwork ?? "unknown-network",
  }
  rememberVerified(orgId, identity)
  return identity
}

/** Test seam: a fake clock, and a cache reset. */
export const DemoVerificationTestAccess = {
  setNow(fn: (() => number) | null): void {
    nowFn = fn ?? (() => Date.now())
  },
  reset(): void {
    verifiedCache.clear()
    nowFn = () => Date.now()
  },
  cacheMax: VERIFIED_CACHE_MAX,
  remember: rememberVerified,
  cachedOrgIds(): string[] {
    return [...verifiedCache.keys()]
  },
}

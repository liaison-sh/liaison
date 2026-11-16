// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client portal's sign-in: a link mailed to an active client of one
// organisation, opened by one click on the portal's page, used once, 15 minutes.
// Privileged on purpose: before sign-in there is no portal context, and the rows
// it reads (the org by slug, the client by address, the company's state) are
// exactly the ones the request names. Nothing here answers differently for an
// address that has access and one that has not.
import { createHash, timingSafeEqual } from "node:crypto"
import { toShippedLocale } from "@liaison/shared"
import { and, eq, sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { companies, organizations, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { sendSystemEmailObserved } from "~/infra/email"
import { renderBrandedEmail } from "~/infra/email-layout"
import { emailOutageHoldsBackSend } from "~/infra/email-outage"
import { CryptoContext, decryptSecret, generateToken } from "~/lib/crypto"
import { encryptionKey } from "~/lib/env"
import { authLogger as log } from "~/lib/logger"
import { orgAppBaseUrl, orgHostsEnabled } from "~/lib/org-public-url"
import { redis } from "~/lib/redis"
import { checkBruteForce, recordFailedAttempt, resetAttempts } from "~/middleware/brute-force"
import { AuthServiceError, createPortalSession, type TokenPair } from "~/modules/auth/auth"
import { consumePortalChallenge, mintChallenge } from "~/modules/auth/magic-link"
import { TOTP_PERIOD, verifyTotpCode } from "~/modules/auth/totp"
import { serverT } from "~/modules/i18n/server-i18n"
import { getOrgEmailConfig } from "~/modules/org/email-from"

/** Between two sign-in mails to one address of one org, and how many in an hour. */
const SEND_COOLDOWN_SECONDS = 60
const MAX_SENDS_PER_ADDRESS_PER_HOUR = 5
/** The second-factor step after the link: one challenge, five minutes. */
const TOTP_CHALLENGE_TTL_SECONDS = 300
const TOTP_CHALLENGE_PREFIX = "portal:totp-challenge"
/** A wrong second factor answers no sooner than this, so guessing is slow. */
export const PORTAL_TOTP_FAILURE_DELAY_MS = 1000

interface PortalPerson {
  id: string
  orgId: string
  email: string
  name: string
  locale: string | null
  totpEnabled: boolean
}

/** The active client of `orgId` with this id or address, whose company is open; else null. */
async function openPortalPerson(
  orgId: string,
  where: { id: string } | { email: string },
): Promise<PortalPerson | null> {
  const [row] = await withPrivilegedDb(orgId, "portal-sign-in-person", (tx) =>
    tx
      .select({
        id: users.id,
        orgId: users.orgId,
        email: users.email,
        name: users.name,
        locale: users.locale,
        totpEnabled: users.totpEnabled,
        status: users.status,
        closedAt: companies.closedAt,
      })
      .from(users)
      .innerJoin(companies, and(eq(companies.id, users.companyId), eq(companies.orgId, orgId)))
      .where(
        and(
          eq(users.orgId, orgId),
          eq(users.userType, "external"),
          "id" in where ? eq(users.id, where.id) : eq(users.email, where.email.toLowerCase()),
        ),
      )
      .limit(1),
  )
  if (!row || row.status !== "active" || row.closedAt !== null) return null
  return {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    name: row.name,
    locale: row.locale,
    totpEnabled: row.totpEnabled,
  }
}

async function orgBySlug(slug: string): Promise<{ id: string; name: string } | null> {
  const [org] = await withSystemDb("portal-org-by-slug", (db) =>
    db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1),
  )
  return org ?? null
}

/** Takes one sign-in mail for this address and org, as typed; false when over the budget. */
async function takeSend(orgSlug: string, email: string): Promise<boolean> {
  const who = createHash("sha256").update(`${orgSlug}\n${email.toLowerCase()}`).digest("hex")
  const free = await redis.set(
    `portal:signin:cooldown:${who}`,
    "1",
    "EX",
    SEND_COOLDOWN_SECONDS,
    "NX",
  )
  if (free !== "OK") return false
  const hourKey = `portal:signin:hour:${who}`
  const count = await redis.incr(hourKey)
  if (count === 1) await redis.expire(hourKey, 60 * 60)
  return count <= MAX_SENDS_PER_ADDRESS_PER_HOUR
}

/**
 * Mails a sign-in link to `email` when it is an active client of the org named by
 * `orgSlug` and its company is open. Answers nothing either way: the route gives
 * every caller the same reply, padded to the same time, and the mail is not
 * awaited (a send that only some addresses get would be measurable). A member's
 * address gets no mail: the portal never signs a member in.
 */
export async function requestPortalSignIn(orgSlug: string, email: string): Promise<void> {
  if (!(await takeSend(orgSlug, email))) return
  const org = await orgBySlug(orgSlug)
  if (!org) return
  const person = await openPortalPerson(org.id, { email })
  if (!person) return
  if (await emailOutageHoldsBackSend()) return

  const base = await orgAppBaseUrl(org.id)
  const minted = await mintChallenge(person, person.email, {
    portal: true,
    host: orgHostsEnabled() ? new URL(base).host : undefined,
  })
  // The secret travels in the fragment: never sent to a server, never in a log
  // or a referrer. The page posts it, on a click, to the verify route.
  const link = `${base}/portal/sign-in#c=${encodeURIComponent(minted.challengeId)}&t=${encodeURIComponent(minted.linkToken)}`
  const locale = toShippedLocale(person.locale) ?? "en"
  const t = (key: string) => serverT(locale, `portal-auth.mail.${key}`, { org: org.name })
  const subject = t("subject")
  const { html, text } = renderBrandedEmail({
    subject,
    eyebrow: t("eyebrow"),
    heading: t("heading"),
    paragraphs: [t("body"), t("ignore")],
    cta: { label: t("cta"), href: link },
    footer: [t("footer")],
  })
  const emailConfig = await getOrgEmailConfig(org.id)
  void sendSystemEmailObserved({
    to: person.email,
    from: emailConfig.from,
    replyTo: emailConfig.replyTo,
    subject,
    html,
    text,
    template: "portal.sign-in-link",
  }).catch((err) => log.error({ err, userId: person.id }, "Failed to send portal sign-in email"))
  log.info({ userId: person.id, orgId: org.id }, "Portal sign-in link issued")
}

export type PortalSignInResult = TokenPair | { totpRequired: true; challengeToken: string }

/**
 * Spends a sign-in link (one use) and signs the client in, or hands over to the
 * second factor when they set one up. Refused with the one 401 when the link is
 * unknown, used, past 15 minutes, or its person or company is no longer open.
 */
export async function verifyPortalSignIn(input: {
  challengeId: string
  token: string
  host?: string
}): Promise<PortalSignInResult> {
  const { userId, orgId } = await consumePortalChallenge(input)
  const person = await openPortalPerson(orgId, { id: userId })
  if (!person) throw new AuthServiceError("Invalid or expired code", 401)
  if (person.totpEnabled) {
    const challengeToken = generateToken(32)
    await redis.set(
      `${TOTP_CHALLENGE_PREFIX}:${challengeToken}`,
      userId,
      "EX",
      TOTP_CHALLENGE_TTL_SECONDS,
    )
    return { totpRequired: true, challengeToken }
  }
  return createPortalSession(userId, orgId)
}

/**
 * The second factor after the link. A wrong code answers after
 * PORTAL_TOTP_FAILURE_DELAY_MS and counts against the person; past the budget
 * the challenge is spent and they start again from a new link.
 */
export async function verifyPortalTotp(input: {
  challengeToken: string
  code: string
  ip: string
}): Promise<TokenPair> {
  const startedAt = performance.now()
  const fail = async (status: 401 | 429 = 401): Promise<never> => {
    const wait = PORTAL_TOTP_FAILURE_DELAY_MS - (performance.now() - startedAt)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    throw new AuthServiceError(status === 429 ? "Too many attempts" : "Invalid code", status)
  }
  const key = `${TOTP_CHALLENGE_PREFIX}:${input.challengeToken}`
  const userId = await redis.get(key)
  if (!userId) return fail()
  // The org is the client's own row's, read here, never carried in the challenge.
  const [client] = await withSystemDb("portal-totp-client", (db) =>
    db
      .select({ orgId: users.orgId })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.userType, "external")))
      .limit(1),
  )
  if (!client) return fail()
  const orgId = client.orgId
  const bruteKey = `portal-totp:${userId}`
  const check = await checkBruteForce(redis, bruteKey, input.ip)
  if (!check.allowed) {
    await redis.del(key)
    return fail(429)
  }
  const person = await openPortalPerson(orgId, { id: userId })
  if (!person || !person.totpEnabled) return fail()

  const ok = await withPrivilegedDb(orgId, "portal-totp-verify", async (tx) => {
    const K = sql.raw(schemaRef("kernel"))
    const [row] = await tx.execute(
      sql`SELECT totp_last_used_at, totp_secret FROM ${K}.users WHERE id = ${userId} AND user_type = 'external' FOR UPDATE`,
    )
    if (!row?.totp_secret) return false
    if (row.totp_last_used_at) {
      const last = Math.floor(
        new Date(row.totp_last_used_at as string).getTime() / 1000 / TOTP_PERIOD,
      )
      if (Math.floor(Date.now() / 1000 / TOTP_PERIOD) <= last) return false
    }
    const secret = decryptSecret(row.totp_secret as string, encryptionKey, CryptoContext.totpSecret)
    if (!verifyTotpCode(secret, input.code)) return false
    await tx.update(users).set({ totpLastUsedAt: new Date() }).where(eq(users.id, userId))
    return true
  })
  if (!ok) {
    await recordFailedAttempt(redis, bruteKey, input.ip)
    return fail()
  }
  // One use: only the caller whose delete removed the challenge signs in.
  if ((await redis.del(key)) !== 1) return fail()
  await resetAttempts(redis, bruteKey, input.ip).catch(() => {})
  return createPortalSession(userId, orgId)
}

/** What the portal's sign-in page shows: the org's name, logo and notice, nothing else. */
export interface PortalBranding {
  name: string | null
  logoUrl: string | null
  notice: string | null
}

/** An unknown slug answers the same shape, all empty: the generic sign-in page. */
export async function portalBranding(slug: string): Promise<PortalBranding> {
  const org = await orgBySlug(slug)
  return { name: org?.name ?? null, logoUrl: null, notice: null }
}

/** Constant-time string equality, for an Origin compared with the allowed list. */
export function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

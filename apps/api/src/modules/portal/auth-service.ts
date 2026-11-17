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
import { CryptoContext, decryptSecret, encryptSecret, generateToken } from "~/lib/crypto"
import { encryptionKey } from "~/lib/env"
import { authLogger as log } from "~/lib/logger"
import { orgAppBaseUrl, orgHostsEnabled } from "~/lib/org-public-url"
import { redis } from "~/lib/redis"
import { checkBruteForce, recordFailedAttempt, resetAttempts } from "~/middleware/brute-force"
import {
  AuthServiceError,
  createPortalSession,
  signPortalEnrolmentToken,
  type TokenPair,
} from "~/modules/auth/auth"
import { consumePortalChallenge, mintChallenge } from "~/modules/auth/magic-link"
import {
  generateTotpSecret,
  generateTotpUri,
  TOTP_PERIOD,
  verifyTotpCode,
} from "~/modules/auth/totp"
import { serverT } from "~/modules/i18n/server-i18n"
import { getOrgEmailConfig } from "~/modules/org/email-from"
import { recordPortalAccess } from "~/modules/portal/access"

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
  /** A second factor is needed: the person set one up or the company requires one. */
  secondFactorRequired: boolean
}

/**
 * The active client of `orgId` with this id or address, whose company is open
 * and whose portal access has not ended; else null.
 */
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
        portalEndedAt: companies.portalEndedAt,
        portalRequireTotp: companies.portalRequireTotp,
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
  if (!row || row.status !== "active" || row.closedAt !== null || row.portalEndedAt !== null) {
    return null
  }
  return {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    name: row.name,
    locale: row.locale,
    totpEnabled: row.totpEnabled,
    secondFactorRequired: row.totpEnabled || row.portalRequireTotp,
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
  // The org's slug (not a secret) in the query, so the page names the org.
  const link = `${base}/portal/sign-in?org=${encodeURIComponent(orgSlug)}#c=${encodeURIComponent(minted.challengeId)}&t=${encodeURIComponent(minted.linkToken)}`
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

/**
 * Tells a client a reply waits on their portal request: one system mail naming the
 * request's subject and nothing of the reply, with a link to the portal. The reply
 * itself is read only after sign-in. Nothing is sent when the address is not an
 * open portal person of the org (the company closed, the access ended), or while
 * the mail provider is refusing.
 */
export async function sendPortalReplyNotice(input: {
  orgId: string
  requesterEmail: string
  subject: string
}): Promise<void> {
  const person = await openPortalPerson(input.orgId, { email: input.requesterEmail })
  if (!person) return
  if (await emailOutageHoldsBackSend()) return
  const [org] = await withSystemDb("portal-reply-notice-org", (db) =>
    db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, input.orgId))
      .limit(1),
  )
  if (!org) return
  const base = await orgAppBaseUrl(input.orgId)
  const locale = toShippedLocale(person.locale) ?? "en"
  const t = (key: string) =>
    serverT(locale, `portal-auth.reply.${key}`, { org: org.name, subject: input.subject })
  const subject = t("subject")
  const { html, text } = renderBrandedEmail({
    subject,
    eyebrow: t("eyebrow"),
    heading: t("heading"),
    paragraphs: [t("body")],
    cta: { label: t("cta"), href: `${base}/portal` },
    footer: [t("footer")],
  })
  const emailConfig = await getOrgEmailConfig(input.orgId)
  await sendSystemEmailObserved({
    to: person.email,
    from: emailConfig.from,
    replyTo: emailConfig.replyTo,
    subject,
    html,
    text,
    template: "portal.request-reply",
  })
}

export type PortalSignInResult =
  | TokenPair
  | { totpRequired: true; challengeToken: string }
  | { enrolmentRequired: true; enrolmentToken: string }

/**
 * The token of a person who must set up a second factor and has none yet: it opens
 * the setup and confirm routes only, has no session behind it, and lasts as long
 * as any portal access token (15 minutes). A new link gives a new one.
 */
async function mintEnrolmentToken(userId: string, orgId: string): Promise<string> {
  const [row] = await withPrivilegedDb(orgId, "portal-enrolment-token", (tx) =>
    tx
      .select({
        name: users.name,
        authVersion: users.authVersion,
        permissionVersion: users.permissionVersion,
      })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.userType, "external")))
      .limit(1),
  )
  if (!row) throw new AuthServiceError("Invalid or expired code", 401)
  return signPortalEnrolmentToken({ userId, orgId }, row)
}

/**
 * Spends a sign-in link (one use) and signs the client in, or hands over to the
 * second factor when they set one up or their company requires one (a person
 * with none set up gets no token from the link). Refused with the one 401 when the link is
 * unknown, used, past 15 minutes, or its person or company is no longer open.
 */
export async function verifyPortalSignIn(input: {
  challengeId: string
  token: string
  host?: string
  /** The browser as it reported itself, for the access log only. */
  userAgent?: string | null
}): Promise<PortalSignInResult> {
  const { userId, orgId } = await consumePortalChallenge(input)
  const person = await openPortalPerson(orgId, { id: userId })
  if (!person) throw new AuthServiceError("Invalid or expired code", 401)
  if (person.secondFactorRequired && !person.totpEnabled) {
    return { enrolmentRequired: true, enrolmentToken: await mintEnrolmentToken(userId, orgId) }
  }
  if (person.secondFactorRequired) {
    const challengeToken = generateToken(32)
    await redis.set(
      `${TOTP_CHALLENGE_PREFIX}:${challengeToken}`,
      userId,
      "EX",
      TOTP_CHALLENGE_TTL_SECONDS,
    )
    return { totpRequired: true, challengeToken }
  }
  const tokens = await createPortalSession(userId, orgId)
  recordPortalAccess({ orgId, userId, action: "portal.sign_in", userAgent: input.userAgent })
  return tokens
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
  /** The browser as it reported itself, for the access log only. */
  userAgent?: string | null
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
    recordPortalAccess({
      orgId,
      userId,
      action: "portal.sign_in_failed",
      userAgent: input.userAgent,
    })
    return fail()
  }
  // One use: only the caller whose delete removed the challenge signs in.
  if ((await redis.del(key)) !== 1) return fail()
  await resetAttempts(redis, bruteKey, input.ip).catch(() => {})
  const tokens = await createPortalSession(userId, orgId, undefined, true)
  recordPortalAccess({ orgId, userId, action: "portal.sign_in", userAgent: input.userAgent })
  return tokens
}

const TOTP_SETUP_TTL_SECONDS = 600
const totpSetupKey = (userId: string) => `portal:totp-setup:${userId}`

/**
 * Starts (or resumes) a second-factor setup for a signed-in or enrolling client.
 * A pending setup returns the same secret, so a code already scanned stays good.
 * Refused for a person who already has one.
 */
export async function beginPortalTotpSetup(
  userId: string,
  orgId: string,
): Promise<{ secret: string; otpauthUri: string }> {
  const person = await openPortalPerson(orgId, { id: userId })
  if (!person) throw new AuthServiceError("Unauthorized", 401)
  if (person.totpEnabled) throw new AuthServiceError("A second factor is already set up", 409)
  const pending = await redis.get(totpSetupKey(userId))
  const secret = pending
    ? decryptSecret(pending, encryptionKey, CryptoContext.totpSetupSecret)
    : generateTotpSecret()
  if (!pending) {
    await redis.set(
      totpSetupKey(userId),
      encryptSecret(secret, encryptionKey, CryptoContext.totpSetupSecret),
      "EX",
      TOTP_SETUP_TTL_SECONDS,
    )
  }
  return { secret, otpauthUri: generateTotpUri(secret, person.email, "Liaison") }
}

/**
 * Confirms the setup with a code from the app: the factor is saved, and the
 * person gets a full session (an enrolment token becomes one here, and only here).
 */
export async function confirmPortalTotp(input: {
  userId: string
  orgId: string
  code: string
  ip: string
}): Promise<TokenPair> {
  const { userId, orgId } = input
  const bruteKey = `portal-totp-confirm:${userId}`
  const check = await checkBruteForce(redis, bruteKey, input.ip)
  if (!check.allowed) throw new AuthServiceError("Too many attempts", 429)
  const person = await openPortalPerson(orgId, { id: userId })
  if (!person) throw new AuthServiceError("Unauthorized", 401)
  if (person.totpEnabled) throw new AuthServiceError("A second factor is already set up", 409)
  const pending = await redis.get(totpSetupKey(userId))
  if (!pending) throw new AuthServiceError("No second-factor setup in progress", 400)
  const secret = decryptSecret(pending, encryptionKey, CryptoContext.totpSetupSecret)
  if (!verifyTotpCode(secret, input.code)) {
    await recordFailedAttempt(redis, bruteKey, input.ip)
    throw new AuthServiceError("Invalid code", 400)
  }
  await withPrivilegedDb(orgId, "portal-totp-confirm", (tx) =>
    tx
      .update(users)
      .set({
        totpSecret: encryptSecret(secret, encryptionKey, CryptoContext.totpSecret),
        totpEnabled: true,
        totpLastUsedAt: new Date(),
      })
      .where(and(eq(users.id, userId), eq(users.userType, "external"))),
  )
  await redis.del(totpSetupKey(userId))
  await resetAttempts(redis, bruteKey, input.ip).catch(() => {})
  return createPortalSession(userId, orgId, undefined, true)
}

/** Records that the client read the org's portal notice, in the version they saw. */
export async function ackPortalNotice(
  userId: string,
  orgId: string,
  version: number,
): Promise<{ noticeAckAt: string; noticeVersion: number }> {
  const at = new Date()
  const K = sql.raw(schemaRef("kernel"))
  // Only the notice the page showed counts: a version the org has since replaced (or never had)
  // records nothing, and the person reads the current text again.
  const [current] = await withPrivilegedDb(orgId, "portal-notice-version", (tx) =>
    tx
      .select({
        version: sql<string | null>`${organizations.settings} -> 'portal' ->> 'noticeVersion'`,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  if (Number(current?.version ?? 0) !== version)
    throw new AuthServiceError(
      "The notice changed since it was shown. Nothing was recorded: read the new notice, then acknowledge it.",
      409,
    )
  await withPrivilegedDb(orgId, "portal-notice-ack", (tx) =>
    tx.execute(sql`UPDATE ${K}.portal_people
      SET notice_ack_at = ${at.toISOString()}::timestamptz, notice_version = ${version}
      WHERE user_id = ${userId} AND org_id = ${orgId} AND removed_at IS NULL`),
  )
  return { noticeAckAt: at.toISOString(), noticeVersion: version }
}

/** What the portal's sign-in page shows: the org's name, logo and notice, nothing else. */
export interface PortalBranding {
  name: string | null
  logoUrl: string | null
  notice: string | null
  /** The notice's version: what the portal sends back when the person acknowledges it. */
  noticeVersion: number | null
}

/** An unknown slug answers the same shape, all empty: the generic sign-in page. */
export async function portalBranding(slug: string): Promise<PortalBranding> {
  const org = await orgBySlug(slug)
  if (!org) return { name: null, logoUrl: null, notice: null, noticeVersion: null }
  // The org's own notice (settings.portal.notice), shown with its name before sign-in.
  const [row] = await withSystemDb("portal-branding-notice", (db) =>
    db
      .select({
        notice: sql<string | null>`${organizations.settings} -> 'portal' ->> 'notice'`,
        version: sql<string | null>`${organizations.settings} -> 'portal' ->> 'noticeVersion'`,
      })
      .from(organizations)
      .where(eq(organizations.id, org.id))
      .limit(1),
  )
  const notice = row?.notice ?? null
  return {
    name: org.name,
    logoUrl: null,
    notice,
    noticeVersion: notice ? Number(row?.version ?? 0) || null : null,
  }
}

/** Constant-time string equality, for an Origin compared with the allowed list. */
export function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

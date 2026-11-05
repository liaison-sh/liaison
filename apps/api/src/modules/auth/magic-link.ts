// SPDX-License-Identifier: FSL-1.1-ALv2
import { timingSafeEqual } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { organizations, users } from "~/db/schema/kernel"
import { sendSystemEmailObserved } from "~/infra/email"
import { renderBrandedEmail } from "~/infra/email-layout"
import { generateNumericCode, generateToken, hashToken } from "~/lib/crypto"
import { authLogger as log } from "~/lib/logger"
import { orgHostsEnabled, orgPublicBaseUrl } from "~/lib/org-public-url"
import { redis } from "~/lib/redis"
import { issueToken as issueRedisToken } from "~/lib/token-store"
import { AuthServiceError, createSession } from "~/modules/auth/auth"
import { demoMagicLinkAllowed } from "~/modules/demo/demo-login"
import { getOrgEmailConfig } from "~/modules/org/email-from"
import { emitSecurityEvent } from "~/modules/security/security-events"

/**
 * The instance-wide refusal of an emailed sign-in code, on an instance that
 * sends no mail (demo mode). `status` + `code` is the shape `errorHandler`
 * turns into a response; the client keys on the code and opens the password
 * form. Never account-specific.
 */
export class EmailSignInUnavailableError extends Error {
  readonly status = 403
  readonly code = "EMAIL_SIGN_IN_UNAVAILABLE"
  constructor() {
    super("This demo can't send email. Sign in with your password.")
    this.name = "EmailSignInUnavailableError"
  }
}

/**
 * The mail provider is refusing this instance's mail as a whole (infra/email-outage.ts):
 * no sign-in email can be promised. About the instance, the same for every address.
 */
export class EmailProviderUnavailableError extends Error {
  readonly status = 403
  readonly code = "EMAIL_PROVIDER_UNAVAILABLE"
  constructor() {
    super(
      "We can't send email right now. Try again later, or sign in with your password if you have one.",
    )
    this.name = "EmailProviderUnavailableError"
  }
}

/** Challenge lifetime — the emailed link + code both expire after this window. */
const CHALLENGE_TTL_SECONDS = 10 * 60
/** Max wrong-code guesses before the challenge is burned (link path is single-use anyway). */
const MAX_CODE_ATTEMPTS = 5
/** TOTP first-factor challenge lifetime, matching the password-login path. */
const TOTP_CHALLENGE_TTL_SECONDS = 300

/**
 * Wrong codes one account accepts across ALL its challenges in
 * {@link WRONG_CODE_WINDOW_SECONDS}. The per-challenge cap alone does not bound
 * guessing: anyone can request a fresh challenge for a known address. Past the
 * budget the code path is refused for that account; the emailed link (a 256-bit
 * token) keeps working.
 */
const MAX_WRONG_CODES_PER_USER = 10
const WRONG_CODE_WINDOW_SECONDS = 24 * 60 * 60
/** Challenges issued per account per hour, whatever the requesting address. */
const MAX_CHALLENGES_PER_USER = 5
const CHALLENGE_WINDOW_SECONDS = 60 * 60

const CHALLENGE_PREFIX = "magic:challenge"
const WRONG_CODES_PREFIX = "magic:wrong"
const ISSUED_PREFIX = "magic:issued"
const ATTEMPTS_PREFIX = "magic:attempts"
/** One active challenge per user — a new request invalidates the previous. */
const USER_POINTER_PREFIX = "magic:user"

interface ChallengeRecord {
  userId: string
  orgId: string
  email: string
  /** Null for a handoff challenge: it has no code, only its link. */
  codeHash: string | null
  linkTokenHash: string
  /** The host (`name[:port]`) the challenge may be verified on; absent = any. */
  host?: string
  /** A sign-in link handed to the owner by the operator: verified only after a "Continue". */
  handoff?: boolean
}

export interface MintChallengeOptions {
  /** Bind the challenge to this host: verifying it on any other is refused. */
  host?: string
  /** A handoff challenge: no code, and the page asks for "Continue" before signing in. */
  handoff?: boolean
}

export interface MintedChallenge {
  challengeId: string
  linkToken: string
  /** The 6-digit code, null for a handoff challenge. */
  code: string | null
  expiresAt: Date
}

export interface MagicLinkRequestResult {
  challengeId: string
}

export type MagicLinkVerifyResult =
  | { accessToken: string; refreshToken: string; orgId: string; userId: string; admin: boolean }
  | { totpRequired: true; challengeToken: string }
  | MagicLinkConfirmRequired

/** A valid handoff link before "Continue": who and where, nothing signed in. */
export interface MagicLinkConfirmRequired {
  confirmRequired: true
  workspace: { name: string; slug: string }
  account: { email: string; name: string }
}

interface ResolvedUser {
  id: string
  orgId: string
  status: string
  totpEnabled: boolean
  /** The stored hash, or null. Read for the demo gate only, never compared. */
  passwordHash: string | null
}

/**
 * Resolve the single user an email refers to, mirroring the password-login
 * lookup: an explicit `orgSlug` scopes to one org; otherwise a bare email must
 * be unambiguous across orgs. Returns null when there is no unique active
 * candidate — the caller then produces an anti-enumeration success response
 * without sending anything.
 */
export async function resolveUser(email: string, orgSlug?: string): Promise<ResolvedUser | null> {
  const cols = {
    id: users.id,
    orgId: users.orgId,
    status: users.status,
    totpEnabled: users.totpEnabled,
    passwordHash: users.passwordHash,
  }
  const normalized = email.toLowerCase()

  if (orgSlug) {
    const [org] = await withSystemDb("magic-link-org-lookup", (db) =>
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, orgSlug))
        .limit(1),
    )
    if (!org) return null
    const [user] = await withSystemDb("magic-link-user-lookup", (db) =>
      db
        .select(cols)
        .from(users)
        .where(and(eq(users.email, normalized), eq(users.orgId, org.id)))
        .limit(1),
    )
    return user ?? null
  }

  const matches = await withSystemDb("magic-link-email-lookup", (db) =>
    db.select(cols).from(users).where(eq(users.email, normalized)).limit(2),
  )
  // Ambiguous (email in >1 org without an orgSlug) → unresolvable.
  if (matches.length !== 1) return null
  return matches[0]
}

/**
 * Issue a passwordless login challenge for `email`.
 *
 * Always returns a `challengeId` with a uniform shape so the endpoint never
 * reveals whether the address exists (anti-enumeration, mirroring
 * `/password-reset/request`). An email — carrying BOTH a 6-digit code and a
 * clickable magic link bound to the same challenge — is sent only when the
 * address resolves to a unique active user.
 */
export async function requestMagicLink(
  email: string,
  orgSlug: string | undefined,
): Promise<MagicLinkRequestResult> {
  const challengeId = generateToken(16)
  const user = await resolveUser(email, orgSlug)

  if (!user || user.status !== "active") {
    // Uniform response; nothing stored, nothing sent.
    log.info({ email: email.toLowerCase() }, "Magic-link requested for unresolved/inactive email")
    return { challengeId }
  }

  // In a DEMO org, only the one account that already has a door gets one. See
  // modules/demo/demo-login.ts: this is not a product-wide rule about password
  // hashes, and it returns true on its first line off a demo box. Same uniform
  // response, so the refusal reveals nothing either.
  if (!(await demoMagicLinkAllowed(user.orgId, user.id, user.passwordHash !== null))) {
    return { challengeId }
  }

  // Per-account issue cap, independent of the requesting address. Same uniform
  // response past it: nothing stored, nothing sent.
  const issuedKey = `${ISSUED_PREFIX}:${user.id}`
  const issued = await redis.incr(issuedKey)
  if (issued === 1) await redis.expire(issuedKey, CHALLENGE_WINDOW_SECONDS)
  if (issued > MAX_CHALLENGES_PER_USER) {
    log.warn({ userId: user.id, issued }, "Magic-link challenge cap reached for account")
    return { challengeId }
  }

  const base = await orgPublicBaseUrl(user.orgId)
  // With org hosts, the emailed link works on its org's host only.
  const minted = await mintChallenge(user, email, {
    host: orgHostsEnabled() ? new URL(base).host : undefined,
  })
  const code = minted.code ?? ""

  const magicUrl = `${base}/login/magic?challengeId=${encodeURIComponent(minted.challengeId)}&token=${encodeURIComponent(minted.linkToken)}`
  const emailConfig = await getOrgEmailConfig(user.orgId)
  const subject = `${code} is your Liaison sign-in code`
  const { html, text } = renderBrandedEmail({
    subject,
    eyebrow: "Sign in",
    heading: "Your sign-in code",
    code,
    paragraphs: [
      "Enter it to sign in. The code expires in 10 minutes and can be used once. You can also just tap the button below on this device.",
      "If you didn't try to sign in, you can safely ignore this email — no one can access your account without this code or link.",
    ],
    cta: { label: "Sign in to Liaison", href: magicUrl },
    footer: ["You're receiving this because a sign-in was requested for this email address."],
  })
  // Not awaited: an unknown address skips the send entirely, so waiting for the
  // mail server would tell a caller which addresses have an account. A provider
  // refusal becomes the instance's mail state, which the route reads for everybody.
  void sendSystemEmailObserved({
    to: email,
    from: emailConfig.from,
    replyTo: emailConfig.replyTo,
    subject,
    html,
    text,
    template: "auth.sign-in-code",
  }).catch((err) => log.error({ err, userId: user.id }, "Failed to send magic-link email"))

  log.info({ userId: user.id }, "Magic-link challenge issued")
  return { challengeId: minted.challengeId }
}

/**
 * Store a sign-in challenge for `user` (link token and, unless a handoff, a
 * 6-digit code; both hashed, 10 minutes, single use) and return its secrets.
 * One active challenge per user: this invalidates the previous one. No rate
 * cap here: the emailed path caps per account before calling it; a handoff is
 * a signed operator request.
 */
export async function mintChallenge(
  user: { id: string; orgId: string },
  email: string,
  opts: MintChallengeOptions = {},
): Promise<MintedChallenge> {
  const challengeId = generateToken(16)
  const code = opts.handoff ? null : generateNumericCode(6)
  const linkToken = generateToken(32)
  const record: ChallengeRecord = {
    userId: user.id,
    orgId: user.orgId,
    email: email.toLowerCase(),
    codeHash: code === null ? null : hashToken(code),
    linkTokenHash: hashToken(linkToken),
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.handoff ? { handoff: true } : {}),
  }

  // Invalidate any prior in-flight challenge for this user (single active challenge).
  const priorId = await redis.getdel(`${USER_POINTER_PREFIX}:${user.id}`)
  if (priorId) {
    await redis.del(`${CHALLENGE_PREFIX}:${priorId}`, `${ATTEMPTS_PREFIX}:${priorId}`)
  }
  await redis.set(
    `${CHALLENGE_PREFIX}:${challengeId}`,
    JSON.stringify(record),
    "EX",
    CHALLENGE_TTL_SECONDS,
  )
  await redis.set(`${USER_POINTER_PREFIX}:${user.id}`, challengeId, "EX", CHALLENGE_TTL_SECONDS)
  return {
    challengeId,
    linkToken,
    code,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000),
  }
}

/** Constant-time comparison of two hex-encoded SHA-256 digests. */
function hashesEqual(a: string, b: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  } catch {
    return false
  }
}

/**
 * Verify a magic-link challenge by either the 6-digit `code` (code-entry screen)
 * or the opaque `token` (clicked link). On success returns a full session — or,
 * when the user has TOTP enabled, the same `{ totpRequired, challengeToken }`
 * shape the password-login path produces, so the existing `/totp/verify` step is
 * reused unchanged.
 *
 * The link path is single-use (`GETDEL`-style delete on match). The code path is
 * non-destructive on a wrong guess so the challenge survives for retries, but is
 * capped at {@link MAX_CODE_ATTEMPTS} per challenge and
 * {@link MAX_WRONG_CODES_PER_USER} per account across challenges, then burned.
 */
export async function verifyMagicLink(input: {
  challengeId: string
  code?: string
  token?: string
  /** The host the request came to; checked against a host-bound challenge. */
  host?: string
  /** The person clicked "Continue" on a handoff link. */
  confirm?: boolean
}): Promise<MagicLinkVerifyResult> {
  const { challengeId, code, token } = input
  const challengeKey = `${CHALLENGE_PREFIX}:${challengeId}`
  const raw = await redis.get(challengeKey)
  if (!raw) throw new AuthServiceError("Invalid or expired code", 401)

  let record: ChallengeRecord
  try {
    record = JSON.parse(raw) as ChallengeRecord
  } catch {
    throw new AuthServiceError("Invalid or expired code", 401)
  }

  // A challenge bound to a host is refused anywhere else, and left intact: a
  // link opened on the wrong host cannot be burnt from there either.
  if (record.host !== undefined && input.host !== record.host) {
    log.warn({ userId: record.userId }, "Magic-link challenge presented on another host")
    throw new AuthServiceError("Invalid or expired code", 401)
  }
  // A handoff has no code: the code path is refused outright.
  if (record.handoff && token === undefined) {
    throw new AuthServiceError("Invalid or expired code", 401)
  }

  const burn = async () => {
    await redis.del(
      challengeKey,
      `${ATTEMPTS_PREFIX}:${challengeId}`,
      `${USER_POINTER_PREFIX}:${record.userId}`,
    )
  }

  if (token !== undefined) {
    if (!hashesEqual(hashToken(token), record.linkTokenHash)) {
      throw new AuthServiceError("Invalid or expired code", 401)
    }
    // A handoff signs in only once the person saw where and as whom, and clicked
    // "Continue" (no silent login from a link someone else sent them).
    if (record.handoff && input.confirm !== true) return handoffPreview(record)
    // Link is single-use — consume immediately.
    await burn()
  } else {
    // Count the attempt BEFORE checking so a wrong guess still burns budget.
    const attempts = await redis.incr(`${ATTEMPTS_PREFIX}:${challengeId}`)
    if (attempts === 1)
      await redis.expire(`${ATTEMPTS_PREFIX}:${challengeId}`, CHALLENGE_TTL_SECONDS)
    if (attempts > MAX_CODE_ATTEMPTS) {
      await burn()
      throw new AuthServiceError("Too many attempts", 429)
    }
    const wrongKey = `${WRONG_CODES_PREFIX}:${record.userId}`
    const wrongSoFar = Number((await redis.get(wrongKey)) ?? 0)
    if (wrongSoFar >= MAX_WRONG_CODES_PER_USER) {
      await burn()
      log.warn({ userId: record.userId }, "Magic-link code path locked for account")
      throw new AuthServiceError("Too many attempts", 429)
    }
    if (
      code === undefined ||
      record.codeHash === null ||
      !hashesEqual(hashToken(code), record.codeHash)
    ) {
      // Wrong code: counts against the challenge AND the account, and the
      // challenge stays alive for further attempts within both budgets.
      const wrong = await redis.incr(wrongKey)
      if (wrong === 1) await redis.expire(wrongKey, WRONG_CODE_WINDOW_SECONDS)
      if (wrong === MAX_WRONG_CODES_PER_USER) {
        await emitSecurityEvent({
          kind: "guess_ceiling",
          factor: "sign_in_code",
          userId: record.userId,
          orgId: record.orgId,
        })
      }
      throw new AuthServiceError("Invalid or expired code", 401)
    }
    await burn()
  }

  // Re-check the user is still active before minting anything.
  const [user] = await withSystemDb("magic-link-verify-user", (db) =>
    db
      .select({
        id: users.id,
        orgId: users.orgId,
        status: users.status,
        totpEnabled: users.totpEnabled,
      })
      .from(users)
      .where(eq(users.id, record.userId))
      .limit(1),
  )
  if (!user || user.status !== "active") throw new AuthServiceError("Invalid credentials", 401)

  if (user.totpEnabled) {
    // Hand off to the existing TOTP second-factor challenge — identical shape to login().
    const challengeToken = await issueRedisToken(
      redis,
      "challenge",
      { userId: user.id },
      TOTP_CHALLENGE_TTL_SECONDS,
    )
    return { totpRequired: true, challengeToken }
  }

  return createSession(user.id, user.orgId)
}

/** What a handoff page shows before "Continue": the workspace and the account. */
async function handoffPreview(record: ChallengeRecord): Promise<MagicLinkConfirmRequired> {
  const [row] = await withSystemDb("magic-link-handoff-preview", (db) =>
    db
      .select({
        orgName: organizations.name,
        orgSlug: organizations.slug,
        email: users.email,
        name: users.name,
        status: users.status,
      })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.orgId))
      .where(and(eq(users.id, record.userId), eq(users.orgId, record.orgId)))
      .limit(1),
  )
  if (row?.status !== "active") throw new AuthServiceError("Invalid credentials", 401)
  return {
    confirmRequired: true,
    workspace: { name: row.orgName, slug: row.orgSlug },
    account: { email: row.email, name: row.name },
  }
}

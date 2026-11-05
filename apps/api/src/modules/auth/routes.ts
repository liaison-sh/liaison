// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash as nodeCreateHash, timingSafeEqual } from "node:crypto"
import {
  loginSchema,
  magicLinkRequestSchema,
  magicLinkVerifySchema,
  passwordChangeSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerSchema,
  totpConfirmSchema,
  totpStepUpSchema,
  totpVerifySchema,
} from "@liaison/shared"
import { and, eq, gt, isNull, sql } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { invitations, passwordResets, sessions, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { sendSystemEmailObserved, systemEmailLeavesThisInstance } from "~/infra/email"
import { renderBrandedEmail } from "~/infra/email-layout"
import { emailOutageHoldsBackSend, readEmailOutage } from "~/infra/email-outage"
import { parseOriginAllowlist } from "~/lib/app-origins"
import {
  CryptoContext,
  decryptSecret,
  encryptSecret,
  generateNumericCode,
  generateToken,
  hashPassword,
  hashToken,
} from "~/lib/crypto"
import { isManagedEdition } from "~/lib/edition"
import { encryptionKey, env } from "~/lib/env"
import { authLogger as log } from "~/lib/logger"
import {
  hostAllowsOrg,
  hostBindingEnabled,
  orgIdForSlug,
  refreshOriginAllowed,
  requestHostBinding,
  signInOrgSlug,
} from "~/lib/org-host"
import { orgPublicBaseUrl } from "~/lib/org-public-url"
import { redis } from "~/lib/redis"
import { effectiveRequest, getClientIp } from "~/lib/request-context"
import {
  clearRefreshTokenCookie,
  getRefreshTokenFromCookie,
  getRefreshTokenFromHeader,
  isAppOriginRequest,
  REFRESH_TOKEN_HEADER,
  requestRefreshTokenDelivery,
  setRefreshTokenCookie,
  success,
} from "~/lib/response"
import { padToResponseFloor } from "~/lib/response-timing"
import { zValidator } from "~/lib/validate"
import {
  accountFailureBudgetExhausted,
  checkBruteForce,
  recordAccountFailure,
  recordFailedAttempt,
  resetAttempts,
} from "~/middleware/brute-force"
import {
  AccountDeletionError,
  deleteOwnAccount,
  isLastActiveAdmin,
  LAST_ADMIN_MESSAGE,
} from "~/modules/auth/account-delete"
import {
  AuthServiceError,
  bootstrapRegister,
  changePassword,
  createSession,
  InvalidSessionError,
  inviteRegister,
  isBootstrapped,
  login,
  logout,
  RefreshRaceError,
  refreshSession,
} from "~/modules/auth/auth"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import {
  EmailProviderUnavailableError,
  EmailSignInUnavailableError,
  requestMagicLink,
  resolveUser,
  verifyMagicLink,
} from "~/modules/auth/magic-link"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import { revokeSessions } from "~/modules/auth/session-revocation"
import { isSetupTokenRequired, setupTokenMatches } from "~/modules/auth/setup-token"
import {
  assertStepUp,
  isStepUpPurpose,
  stepUpCodeKey,
  stepUpEmailCopy,
  stepUpFailKey,
  stepUpResendCooldownKey,
  stepUpResendCooldownSeconds,
} from "~/modules/auth/step-up"
// consumeToken not used directly — challenge tokens use GET/DEL pattern for brute-force compat
import {
  generateRecoveryCodes,
  generateTotpSecret,
  generateTotpUri,
  TOTP_PERIOD,
  verifyTotpCode,
} from "~/modules/auth/totp"
import { isReservedDemoOrg } from "~/modules/demo/demo-spend"
import { revokeAllMcpConnectionsForUser } from "~/modules/mcp/end-user-connections"
import { getOrgEmailConfig } from "~/modules/org/email-from"
import { removeAllPushDeliveryForUser } from "~/modules/push/end-user-push"
import { noteSignIn } from "~/modules/security/admin-signin"
import { emitSecurityEvent } from "~/modules/security/security-events"

/** Return access token in body, refresh token wherever this caller can keep it.
 *  A browser gets the HttpOnly cookie; one of the wrapped shells' own origins
 *  gets the token in the body and NO cookie, because a SameSite=Strict cookie
 *  is never attached to a cross-site call and the shells make nothing else
 *  (lib/response.ts states the trade). EXPOSE_REFRESH_TOKEN_IN_BODY remains
 *  the separate escape hatch for non-browser clients. */
function respondWithTokens(c: Context, tokens: { accessToken: string; refreshToken: string }) {
  const delivery = requestRefreshTokenDelivery(c)
  if (delivery.cookie) setRefreshTokenCookie(c, tokens.refreshToken)
  if (delivery.body) {
    return success(c, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken })
  }
  return success(c, { accessToken: tokens.accessToken })
}

/** The presented refresh token: the cookie a browser sent, or the header a
 *  wrapped shell sent, or the body field the CLI and the tests use. */
function presentedRefreshToken(c: Context, bodyToken: unknown): string | undefined {
  const fromBody =
    typeof bodyToken === "string" && bodyToken.length <= 512 && bodyToken !== ""
      ? bodyToken
      : undefined
  return (
    getRefreshTokenFromCookie(c.req.header("cookie")) ??
    getRefreshTokenFromHeader(c.req.header(REFRESH_TOKEN_HEADER)) ??
    fromBody
  )
}

export const auth = new Hono<AppEnv>()

/**
 * Wrong answers one account accepts per day for each sign-in factor, whatever
 * the source address (`accountFailureBudgetExhausted`). Past the TOTP budget a
 * recovery code still completes sign-in; past the password budget the emailed
 * sign-in link still works.
 */
const MAX_WRONG_TOTP_CODES_PER_DAY = 10
const MAX_WRONG_PASSWORDS_PER_DAY = 30

/**
 * Whether a one-time token's org may redeem it on this request's host. Without
 * org hosts nothing is bound (no lookup). An unknown token passes: the redeem
 * path answers it as it always did.
 */
async function tokenOrgAllowedHere(
  c: Context<AppEnv>,
  kind: "invitation" | "password-reset",
  token: string,
): Promise<boolean> {
  if (!hostBindingEnabled()) return true
  const tokenHash = hashToken(token)
  const [row] = await withSystemDb(`${kind}-host-check`, (tx) =>
    kind === "invitation"
      ? tx
          .select({ orgId: invitations.orgId })
          .from(invitations)
          .where(eq(invitations.tokenHash, tokenHash))
          .limit(1)
      : tx
          .select({ orgId: passwordResets.orgId })
          .from(passwordResets)
          .where(eq(passwordResets.tokenHash, tokenHash))
          .limit(1),
  )
  return !row || (await hostAllowsOrg(c, row.orgId))
}

auth.post("/register", zValidator("json", registerSchema), async (c) => {
  const body = c.req.valid("json")
  const ip = getClientIp(c)

  const bootstrapped = await isBootstrapped()
  if (!bootstrapped) {
    // The managed edition provisions its operator org and admin from the CLI:
    // the web bootstrap does not exist there.
    if (isManagedEdition()) throw new HTTPException(404, { message: "Not found" })
    // Rate-limit bootstrap registration per IP to prevent rapid org creation
    // Skipped in test environment to avoid cross-test interference
    if (env.NODE_ENV !== "test") {
      const bootstrapKey = `bootstrap-rate:${ip}`
      const bootstrapCount = await redis.incr(bootstrapKey)
      if (bootstrapCount === 1) await redis.expire(bootstrapKey, 60)
      if (bootstrapCount > 5) throw new HTTPException(429, { message: "Too many attempts" })
    }

    // The one-time setup token: without it the first caller to arrive on a
    // fresh internet-exposed instance would become its admin.
    if (isSetupTokenRequired() && !setupTokenMatches(body.setupToken)) {
      log.warn({ ip }, "bootstrap registration refused: setup token missing or wrong")
      throw new HTTPException(403, {
        message:
          "A setup token is required to create the first account. It is printed in the app log at startup (look for 'Liaison setup token').",
      })
    }

    if (!body.email) throw new HTTPException(400, { message: "Email required for bootstrap" })
    const tokens = await bootstrapRegister(body.email, body.password, body.name)
    await withSystemDb("bootstrap-register-event", async (db) => {
      await db.queueEvent({
        app: "kernel",
        entity: "user",
        action: "registered",
        entityId: tokens.userId,
        orgId: tokens.orgId,
        actorType: "system",
        data: { method: "bootstrap", email: body.email },
      })
    })
    return respondWithTokens(c, tokens)
  }

  if (!body.inviteToken) {
    throw new HTTPException(400, { message: "Invitation required" })
  }

  // Under host binding an invitation is redeemed on its org's own host only
  // (the session it opens would be refused anywhere else); elsewhere it reads
  // as invalid and is not spent.
  if (!(await tokenOrgAllowedHere(c, "invitation", body.inviteToken))) {
    throw new HTTPException(400, { message: "Invalid or expired invitation" })
  }
  const result = await inviteRegister(body.inviteToken, body.password, body.name)
  if (!result.success) {
    throw new HTTPException(400, { message: result.error })
  }
  await withSystemDb("invite-register-event", async (db) => {
    await db.queueEvent({
      app: "kernel",
      entity: "user",
      action: "registered",
      entityId: result.data.userId,
      orgId: result.data.orgId,
      actorType: "system",
      data: { method: "invitation" },
    })
  })
  return respondWithTokens(c, result.data)
})

// Validate invite token (unauthenticated — called by Register page before showing the form)
auth.get("/invites/:token/validate", async (c) => {
  const token = c.req.param("token")
  if (!(await tokenOrgAllowedHere(c, "invitation", token))) {
    throw new HTTPException(404, { message: "Invalid or expired invitation" })
  }
  const tokenHash = hashToken(token)
  const [invite] = await withSystemDb("invite-validate", (tx) =>
    tx
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, tokenHash),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .limit(1),
  )
  if (!invite) throw new HTTPException(404, { message: "Invalid or expired invitation" })
  return success(c, { valid: true })
})

// Unauthenticated: lets the frontend decide whether to route to /register
// (zero users) before any session exists.
auth.get("/bootstrap-state", async (c) => {
  const bootstrapped = await isBootstrapped()
  return success(c, {
    bootstrapped,
    // Lets the register page ask for the token only when one is needed.
    setupTokenRequired: !bootstrapped && isSetupTokenRequired(),
  })
})

auth.post("/login", zValidator("json", loginSchema), async (c) => {
  const { email, password, orgSlug } = c.req.valid("json")
  // The org the host names, decided before any password is checked: a slug
  // that disagrees with the host (400) or a host that names no org (404) is
  // not a wrong password and spends none of the account's daily allowance.
  const signInSlug = signInOrgSlug(c, orgSlug)

  // Brute-force protection (read-only — does not increment counters)
  // Fail-closed: Redis failure blocks login to prevent brute-force bypass
  const ip = getClientIp(c)
  let bruteForceResult: { allowed: boolean; retryAfter?: number }
  let passwordBudgetExhausted: boolean
  try {
    bruteForceResult = await checkBruteForce(redis, email.toLowerCase(), ip)
    passwordBudgetExhausted = await accountFailureBudgetExhausted(
      redis,
      "password",
      email.toLowerCase(),
      MAX_WRONG_PASSWORDS_PER_DAY,
    )
  } catch (err) {
    log.error({ err }, "brute-force check failed — blocking request (fail-closed)")
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }
  if (!bruteForceResult.allowed) {
    c.header("Retry-After", String(bruteForceResult.retryAfter))
    throw new HTTPException(429, { message: "Too many attempts" })
  }
  if (passwordBudgetExhausted) {
    throw new HTTPException(429, {
      message: "Too many wrong passwords today. Sign in with an emailed link instead.",
    })
  }

  try {
    const result = await login(email, password, signInSlug)

    // TOTP challenge — don't reset brute-force counters yet (reset after TOTP completes)
    if ("totpRequired" in result) {
      return success(c, result)
    }

    // Full auth complete (no TOTP) — reset brute-force counters
    try {
      await resetAttempts(redis, email.toLowerCase(), ip)
    } catch (err) {
      log.warn({ err }, "brute-force reset failed")
    }

    await withSystemDb("login-event", async (db) => {
      await db.queueEvent({
        app: "kernel",
        entity: "auth",
        action: "login",
        entityId: result.userId,
        orgId: result.orgId,
        actorId: result.userId,
        data: { email: email.toLowerCase() },
      })
    })
    await noteSignIn(c, result, "password")
    return respondWithTokens(c, result)
  } catch (err) {
    // Record failed attempt AFTER authentication fails
    let wrongPasswordsToday = 0
    try {
      await recordFailedAttempt(redis, email.toLowerCase(), ip)
      wrongPasswordsToday = await recordAccountFailure(redis, "password", email.toLowerCase())
    } catch (recordErr) {
      log.warn({ err: recordErr }, "brute-force record failed")
    }

    // Try to resolve orgId for the audit event from the user's email
    try {
      const userRow = await withSystemDb("login-fail-audit", async (db) => {
        const [userRow] = await db
          .select({ id: users.id, orgId: users.orgId })
          .from(users)
          .where(eq(users.email, email.toLowerCase()))
          .limit(1)
        if (userRow?.orgId) {
          await db.queueEvent({
            app: "kernel",
            entity: "auth",
            action: "login_fail",
            entityId: userRow.id,
            orgId: userRow.orgId,
            actorId: undefined,
            data: {
              email: email.toLowerCase(),
              reason: err instanceof Error ? err.message : "unknown",
            },
          })
        }
        return userRow
      })
      // The answer that used up the account's daily password budget.
      if (wrongPasswordsToday === MAX_WRONG_PASSWORDS_PER_DAY) {
        await emitSecurityEvent({
          kind: "guess_ceiling",
          factor: "password",
          userId: userRow?.id ?? null,
          orgId: userRow?.orgId ?? null,
        })
      }
    } catch (auditErr) {
      log.warn({ err: auditErr }, "Failed to publish login failure audit event")
    }
    if (err instanceof AuthServiceError) {
      throw new HTTPException(err.status as 400 | 401 | 403 | 404 | 409 | 429 | 500, {
        message: err.message,
      })
    }
    throw err
  }
})

/** Mail state unreadable: as if the provider were fine, the send will say. */
const mailOutageNow = () => readEmailOutage().catch(() => null)

// ── Passwordless magic-link (primary login) ────────────────────────────────
// Request mints one challenge delivered by email as BOTH a 6-digit code and a
// clickable link; verify accepts either. Works for every account regardless of
// whether it has a password. Password login above is retained as an alternate.
auth.post("/magic-link/request", zValidator("json", magicLinkRequestSchema), async (c) => {
  const magicStartedAt = performance.now()
  const { email, orgSlug } = c.req.valid("json")
  const ip = getClientIp(c)

  // An instance that sends no mail at all (a demo box) cannot deliver a code,
  // so it says so instead of issuing one the user would wait on for ever. The
  // answer is about the INSTANCE, identical for every address, so it reveals
  // nothing about which accounts exist (anti-enumeration holds).
  if (!systemEmailLeavesThisInstance()) throw new EmailSignInUnavailableError()

  // Per-IP sliding-window cap (mirrors /password-reset/request): bounds email
  // bombing regardless of address validity. Fail-closed on Redis error.
  const ipKey = `magic-rate:${ip}`
  try {
    const count = await redis.incr(ipKey)
    if (count === 1) await redis.expire(ipKey, 3600)
    if (count > 15) throw new HTTPException(429, { message: "Too many requests" })
  } catch (err) {
    if (err instanceof HTTPException) throw err
    log.error({ err }, "magic-link rate-limit check failed — blocking (fail-closed)")
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }

  // Per-email brute-force check
  try {
    const bruteCheck = await checkBruteForce(redis, `magic:${email.toLowerCase()}`, ip)
    if (!bruteCheck.allowed) {
      c.header("Retry-After", String(bruteCheck.retryAfter))
      throw new HTTPException(429, { message: "Too many attempts" })
    }
  } catch (err) {
    if (err instanceof HTTPException) throw err
    log.error({ err }, "brute-force check failed — blocking request (fail-closed)")
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }

  // The provider is refusing mail: the answer below is the refusal, for any address, and only
  // the minute's one send tries (see infra/email-outage.ts). Nobody's attempt counts meanwhile,
  // or those who keep trying would be locked out when mail is back.
  const outageAtStart = await mailOutageNow()

  const result = await requestMagicLink(email, signInOrgSlug(c, orgSlug))

  // Record per-email attempt to throttle repeated requests (same as reset).
  if (!outageAtStart) {
    try {
      await recordFailedAttempt(redis, `magic:${email.toLowerCase()}`, ip)
    } catch (err) {
      log.warn({ err }, "brute-force record failed for magic-link")
    }
  }

  // Uniform response — never reveals whether the email exists, by body or by timing.
  await padToResponseFloor(magicStartedAt)
  if (await mailOutageNow()) throw new EmailProviderUnavailableError()
  return success(c, {
    challengeId: result.challengeId,
    message: "If the email matches an account, a sign-in code has been sent",
  })
})

auth.post("/magic-link/verify", zValidator("json", magicLinkVerifySchema), async (c) => {
  const { challengeId, code, token, confirm } = c.req.valid("json")
  const ip = getClientIp(c)

  // Light per-IP guard against challenge/code sweeping (the service also caps
  // per-challenge code attempts and burns the challenge on exhaustion).
  const ipKey = `magic-verify-rate:${ip}`
  try {
    const count = await redis.incr(ipKey)
    if (count === 1) await redis.expire(ipKey, 900)
    if (count > 60) throw new HTTPException(429, { message: "Too many attempts" })
  } catch (err) {
    if (err instanceof HTTPException) throw err
    log.error({ err }, "magic-link verify rate-limit failed — blocking (fail-closed)")
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }

  try {
    // The host the request came to: a challenge bound to an org's host is
    // refused anywhere else (a handoff link, and emailed links with org hosts).
    // The host the client asked for, as the edge reports it (signed edge mode
    // carries it in a header; the request URL then names the cell origin).
    const host = effectiveRequest(c).host ?? undefined
    const result = await verifyMagicLink({ challengeId, code, token, host, confirm })

    // A handoff link before "Continue": who and where, no session yet.
    if ("confirmRequired" in result) {
      return success(c, result)
    }

    // TOTP challenge — hand off to the existing second-factor step.
    if ("totpRequired" in result) {
      return success(c, result)
    }

    await withSystemDb("magic-link-login-event", async (db) => {
      await db.queueEvent({
        app: "kernel",
        entity: "auth",
        action: "login",
        entityId: result.userId,
        orgId: result.orgId,
        actorId: result.userId,
        data: { method: "magic_link" },
      })
    })
    await noteSignIn(c, result, "magic_link")
    return respondWithTokens(c, result)
  } catch (err) {
    if (err instanceof AuthServiceError) {
      throw new HTTPException(err.status as 400 | 401 | 403 | 404 | 409 | 429 | 500, {
        message: err.message,
      })
    }
    throw err
  }
})

auth.post("/refresh", async (c) => {
  const bodyToken = (await c.req.json().catch(() => ({}))).refreshToken
  // THE HEADER IS THE SHELLS' CHANNEL. Rotation off a header presented from
  // anywhere else answers with the new token in a SameSite=Strict cookie that
  // caller cannot keep across its own cross-site calls: the presented token is
  // spent and its replacement is unreachable, which ends the session in a way
  // no client can recover from. Refuse it loudly instead.
  if (
    getRefreshTokenFromHeader(c.req.header(REFRESH_TOKEN_HEADER)) !== undefined &&
    !isAppOriginRequest(c)
  ) {
    throw new HTTPException(400, { message: "Refresh header is for app origins only" })
  }
  // Host binding (lib/org-host.ts): a refresh comes from this org's own origin
  // (or a shell's, or a non-browser client with no Origin), and rotates only a
  // session of this host's org. A no-op without org hosts.
  if (!refreshOriginAllowed(c, parseOriginAllowlist(env.LIAISON_APP_ORIGINS))) {
    throw new HTTPException(403, { message: "Refresh from another origin" })
  }
  const binding = requestHostBinding(c)
  const expectedOrgId = binding.kind === "org" ? await orgIdForSlug(binding.slug) : undefined
  const refreshToken = presentedRefreshToken(c, bodyToken)
  if (!refreshToken) throw new HTTPException(401, { message: "No refresh token" })
  // A SPENT TOKEN IS JUDGED BY ITS SUCCESSOR (auth.ts refreshSession has the
  // full reasoning). Rotation spends the presented token and issues a
  // successor in the same family. When the response carrying that successor
  // is lost on the way (a flaky network), the client keeps presenting the
  // spent token:
  //  - under 30 s after the successor was issued: 409 REFRESH_RACE below
  //    (another tab, or a retry racing its first attempt), nothing changes;
  //  - within 3 minutes of the rotation, from the same User-Agent, with the
  //    successor never used (no request authenticated with its access token,
  //    no refresh of it): the response was lost, so the unused successor is
  //    replaced by a new one in the same family and that pair is answered.
  //    Never a second session; concurrent replays get one winner;
  //  - otherwise (successor used, another client, past the window): reuse of
  //    a spent token, the whole family is revoked and the answer is 401.
  try {
    const tokens = await refreshSession(refreshToken, {
      userAgent: c.req.header("User-Agent"),
      ...(binding.kind === "org" ? { expectedOrgId } : {}),
    })
    return respondWithTokens(c, tokens)
  } catch (err) {
    // A concurrent refresh of the same browser won the rotation: its fresh
    // cookie is already set, so clearing it here would sign every tab out. Only
    // the cookie is shared between tabs; a token a shell presents in the header
    // or the body is its own, and a replay of it stays a plain 401.
    const fromCookie =
      getRefreshTokenFromHeader(c.req.header(REFRESH_TOKEN_HEADER)) === undefined &&
      typeof bodyToken !== "string"
    if (err instanceof RefreshRaceError && fromCookie) {
      return c.json(
        {
          error: {
            message: "The session was refreshed by another tab; retry",
            code: "REFRESH_RACE",
          },
        },
        409,
      )
    }
    // Only a dead or spent token ends the sign-in (a shell's replayed token is
    // spent: the race answer above is the shared cookie's alone). Anything else
    // (a deadlock or a dropped connection inside the rotation) rolled the
    // consume back, so the presented token is still good: clearing its cookie
    // here signed the user out over a transient database error. It surfaces as
    // the error it is.
    if (!(err instanceof InvalidSessionError || err instanceof RefreshRaceError)) throw err
    clearRefreshTokenCookie(c)
    throw new HTTPException(401, { message: "Invalid session" })
  }
})

auth.post("/logout", async (c) => {
  const bodyJson = await c.req.json().catch(() => ({}))
  // A shell holds no cookie, so its sign-out presents the same header it
  // refreshes with: without this the stored token stayed valid for 30 days.
  const refreshToken = presentedRefreshToken(c, bodyJson.refreshToken)
  if (refreshToken) {
    const ended = await logout(refreshToken)
    // The device signing out names itself (A7): its receipt credential dies
    // with the session, so a signed-out NSE or service worker writes nothing.
    const deviceId = typeof bodyJson.deviceId === "string" ? bodyJson.deviceId : null
    if (ended && deviceId) {
      const { forgetPushDevice, revokeDeviceCredentials } = await import(
        "~/modules/notifications/devices"
      )
      const device = { orgId: ended.orgId, userId: ended.userId, deviceId }
      await revokeDeviceCredentials(device)
      // A phone's push row too: one leaving a server it is not on has no
      // bearer to DELETE it with, and would keep receiving a signed-out
      // session's notifications.
      await forgetPushDevice(device)
    }
  }
  clearRefreshTokenCookie(c)
  // Emit logout event if auth context is available (optional — middleware may not have run)
  try {
    const userId = c.get("userId")
    const orgId = c.get("orgId")
    if (orgId) {
      await withSystemDb("logout-event", async (db) => {
        await db.queueEvent({
          app: "kernel",
          entity: "auth",
          action: "logout",
          orgId,
          actorId: userId,
          actorType: "user",
        })
      })
    }
  } catch {
    // Auth context not available on this logout path — skip event
  }
  return success(c, { message: "Logged out" })
})

// TOTP Status (authenticated — check whether TOTP is enabled for current user)
auth.get("/totp/status", async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const [user] = await withPrivilegedDb(orgId, "totp-status", (db) =>
    db.select({ totpEnabled: users.totpEnabled }).from(users).where(eq(users.id, userId)).limit(1),
  )
  if (!user) throw new HTTPException(404, { message: "User not found" })
  return success(c, { totpEnabled: user.totpEnabled })
})

// Step-up: email a fresh 6-digit code used to re-confirm a sensitive change (a TOTP
// change, or the mailbox reset in `modules/mailbox-keys`).
// Passwordless accounts use this instead of the retained current-password check.
auth.post("/totp/step-up", async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")

  // Optional: what the code is for. A code for the mailbox reset is stored
  // apart from a two-factor code, and its email says what the reset deletes.
  const requested = (await c.req.json().catch(() => ({}))) as { purpose?: unknown }
  const purpose = isStepUpPurpose(requested?.purpose) ? requested.purpose : undefined

  // A page that sends its code by itself (the full-access MCP approvals) must
  // not send a second email on a reload, nor replace the code the first one
  // carried: within the cooldown the code already sent stands, and the answer
  // says when a new one can be sent. Checked before the hourly count, so a
  // reload does not spend it.
  const cooldown = stepUpResendCooldownSeconds(purpose)
  if (purpose && cooldown > 0) {
    const cooldownKey = stepUpResendCooldownKey(userId, purpose)
    const started = await redis.set(cooldownKey, "1", "EX", cooldown, "NX")
    if (started !== "OK") {
      const ttl = await redis.ttl(cooldownKey)
      return success(c, { sent: false, retryAfterSeconds: ttl > 0 ? ttl : cooldown })
    }
  }

  // Rate-limit step-up code emails per user.
  const rateKey = `totp-stepup-rate:${userId}`
  const count = await redis.incr(rateKey)
  if (count === 1) await redis.expire(rateKey, 3600)
  if (count > 10) {
    // No code went out, so no cooldown stands in the way of the next try.
    if (purpose && cooldown > 0) await redis.del(stepUpResendCooldownKey(userId, purpose))
    throw new HTTPException(429, { message: "Too many requests" })
  }

  const [user] = await withPrivilegedDb(orgId, "totp-stepup-lookup", (db) =>
    db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1),
  )
  if (!user) throw new HTTPException(404, { message: "User not found" })

  const code = generateNumericCode(6)
  await redis.set(stepUpCodeKey(userId, purpose), hashToken(code), "EX", 600)
  // A new code starts a new count of wrong attempts against it.
  await redis.del(stepUpFailKey(userId, purpose))

  // The App Review reviewer cannot read the reserved demo org's mailbox, so on
  // a demo box, for that org only and for the account deletion only, the code
  // comes back in the response for the dialog to show. Everywhere else the
  // email is the only way to the code (spec S19, S20). There the email is not
  // attempted at all: a demo box refuses every outgoing mail, and each request
  // logged that refusal as a failed send.
  if (purpose === "account_delete" && (await isReservedDemoOrg(orgId))) {
    return success(c, { sent: true, demoCode: code })
  }

  const emailConfig = await getOrgEmailConfig(orgId)
  const copy = stepUpEmailCopy(code, purpose)
  const subject = copy.subject
  const { html, text } = renderBrandedEmail({
    subject,
    eyebrow: "Security",
    heading: copy.heading,
    code,
    paragraphs: copy.paragraphs,
    footer: copy.footer,
  })
  try {
    await sendSystemEmailObserved({
      to: user.email,
      from: emailConfig.from,
      replyTo: emailConfig.replyTo,
      subject,
      html,
      text,
      template: "auth.step-up-code",
    })
  } catch (err) {
    log.error({ err, userId }, "Failed to send TOTP step-up code")
    if (await mailOutageNow()) {
      // No code went out, so no cooldown stands in the way of the next try.
      if (purpose && cooldown > 0) await redis.del(stepUpResendCooldownKey(userId, purpose))
      throw new EmailProviderUnavailableError()
    }
  }
  return success(c, cooldown > 0 ? { sent: true, retryAfterSeconds: cooldown } : { sent: true })
})

/**
 * Delete my account (spec S19). The emailed code is the ONLY confirmation
 * (step-up purpose `account_delete`; a password is refused, five wrong codes
 * void the code), behind a per-user limit on top of the auth routes' limiter.
 * The last admin is refused before the code is spent. On success the account
 * is erased in this org (account-delete.ts), its sessions are gone with it, and
 * the refresh cookie is cleared so this browser is signed out too.
 */
const ACCOUNT_DELETE_LIMIT = 10
const ACCOUNT_DELETE_WINDOW_SECONDS = 3600

auth.post("/account/delete", zValidator("json", totpStepUpSchema), async (c) => {
  assertUnrestrictedSession(c, "delete the account")
  const userId = c.get("userId")
  const orgId = c.get("orgId")

  const rateKey = `account-delete-rate:${userId}`
  const count = await redis.incr(rateKey)
  if (count === 1) await redis.expire(rateKey, ACCOUNT_DELETE_WINDOW_SECONDS)
  if (count > ACCOUNT_DELETE_LIMIT) {
    throw new HTTPException(429, { message: "Too many account deletion attempts" })
  }

  const [user] = await withPrivilegedDb(orgId, "account-delete-step-up", (db) =>
    db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )
  if (!user) throw new HTTPException(404, { message: "User not found" })
  if (await isLastActiveAdmin(orgId, userId)) {
    throw new HTTPException(409, { message: LAST_ADMIN_MESSAGE })
  }
  // A wrong code is a 422 (see assertStepUp): a 401 reads as a dead session.
  await assertStepUp(userId, user.passwordHash, c.req.valid("json"), "account_delete")

  try {
    const result = await deleteOwnAccount(orgId, userId)
    clearRefreshTokenCookie(c)
    return success(c, { deleted: true, ...result })
  } catch (err) {
    if (err instanceof AccountDeletionError) {
      throw new HTTPException(err.status, { message: err.message })
    }
    throw err
  }
})

// TOTP Disable (authenticated — requires step-up re-confirmation)
auth.delete("/totp", zValidator("json", totpStepUpSchema), async (c) => {
  assertUnrestrictedSession(c, "change two-factor sign-in")
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const body = c.req.valid("json")

  const [user] = await withPrivilegedDb(orgId, "totp-disable", (db) =>
    db
      .select({ passwordHash: users.passwordHash, totpEnabled: users.totpEnabled })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )
  if (!user) throw new HTTPException(404, { message: "User not found" })
  if (!user.totpEnabled) throw new HTTPException(400, { message: "TOTP is not enabled" })

  await assertStepUp(userId, user.passwordHash, body)

  await withPrivilegedDb(orgId, "totp-disable-update", (db) =>
    db
      .update(users)
      .set({
        totpEnabled: false,
        totpSecret: null,
        recoveryCodes: null,
        authVersion: sql`auth_version + 1`,
      })
      .where(eq(users.id, userId)),
  )

  // Disabling TOTP bumps auth_version, invalidating outstanding tokens; drop the
  // cached auth state across all nodes so the change takes effect immediately.
  invalidateAuthCache(userId)

  await withSystemDb("totp-disable-event", (db) =>
    db.queueEvent({
      app: "kernel",
      entity: "auth",
      action: "totp_disable",
      orgId,
      actorId: userId,
      entityId: userId,
    }),
  )

  return success(c, { success: true })
})

// TOTP Setup (authenticated — requires auth middleware on /api/auth/totp/*)
// Requires step-up re-confirmation (password or emailed code) to prevent
// stolen-token TOTP enrollment.
auth.post("/totp/setup", zValidator("json", totpStepUpSchema), async (c) => {
  assertUnrestrictedSession(c, "change two-factor sign-in", {
    secondFactorEnrollment: true,
  })
  const userId = c.get("userId")
  const body = c.req.valid("json")

  const orgId = c.get("orgId")
  const [user] = await withPrivilegedDb(orgId, "totp-setup", (db) =>
    db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )
  if (!user) throw new HTTPException(404, { message: "User not found" })

  await assertStepUp(userId, user.passwordHash, body)

  // reset=true aborts any in-progress setup and starts fresh
  if (c.req.query("reset") === "true") {
    await redis.del(`totp:setup:${userId}`)
  }

  // Return existing pending setup if one exists (prevents invalidating already-scanned QR codes)
  const existingSetup = await redis.get(`totp:setup:${userId}`)
  if (existingSetup) {
    const parsed = JSON.parse(existingSetup)
    // Re-setup: return the secret/URI but not recovery codes (stored as hashes).
    // User must complete setup or start fresh to see recovery codes again.
    const existingSecret = decryptSecret(
      parsed.secret,
      encryptionKey,
      CryptoContext.totpSetupSecret,
    )
    return success(c, {
      secret: existingSecret,
      otpauthUri: generateTotpUri(existingSecret, user.email, "Liaison"),
    })
  }

  const secret = generateTotpSecret()
  const uri = generateTotpUri(secret, user.email, "Liaison")
  const codes = generateRecoveryCodes()

  // Store hashed codes in Redis — plaintext was already returned to the user above.
  // Never store recovery codes as plaintext in an intermediate store.
  await redis.set(
    `totp:setup:${userId}`,
    JSON.stringify({
      secret: encryptSecret(secret, encryptionKey, CryptoContext.totpSetupSecret),
      codeHashes: codes.map((c: string) => hashToken(c)),
    }),
    "EX",
    600,
  )

  return success(c, { secret, otpauthUri: uri, recoveryCodes: codes })
})

// TOTP Confirm (authenticated)
auth.post("/totp/confirm", zValidator("json", totpConfirmSchema), async (c) => {
  assertUnrestrictedSession(c, "change two-factor sign-in", {
    secondFactorEnrollment: true,
  })
  const userId = c.get("userId")
  const ip = getClientIp(c)
  const bruteCheck = await checkBruteForce(redis, `totp-confirm:${userId}`, ip)
  if (!bruteCheck.allowed) {
    c.header("Retry-After", String(bruteCheck.retryAfter))
    throw new HTTPException(429, { message: "Too many attempts" })
  }

  const { code } = c.req.valid("json")
  const stored = await redis.get(`totp:setup:${userId}`)
  if (!stored) throw new HTTPException(400, { message: "No TOTP setup in progress" })
  const parsed = JSON.parse(stored)
  const secret = decryptSecret(parsed.secret, encryptionKey, CryptoContext.totpSetupSecret)
  // Recovery codes are stored as hashes in Redis (never plaintext)
  const hashedCodes: string[] =
    parsed.codeHashes ?? parsed.codes?.map((c: string) => hashToken(c)) ?? []

  if (!verifyTotpCode(secret, code)) {
    try {
      await recordFailedAttempt(redis, `totp-confirm:${userId}`, ip)
    } catch (recordErr) {
      log.warn({ err: recordErr }, "brute-force record failed")
    }
    throw new HTTPException(400, { message: "Invalid TOTP code" })
  }
  await withPrivilegedDb(c.get("orgId"), "totp-confirm", async (db) => {
    await db
      .update(users)
      .set({
        totpSecret: encryptSecret(secret, encryptionKey, CryptoContext.totpSecret),
        totpEnabled: true,
        recoveryCodes: hashedCodes,
      })
      .where(eq(users.id, userId))

    await db.queueEvent({
      app: "kernel",
      entity: "auth",
      action: "totp_enable",
      orgId: c.get("orgId"),
      actorId: userId,
      entityId: userId,
    })
  })
  await redis.del(`totp:setup:${userId}`)

  // Reset brute-force counter on successful TOTP confirm
  try {
    await resetAttempts(redis, `totp-confirm:${userId}`, ip)
  } catch (resetErr) {
    log.warn({ err: resetErr }, "brute-force reset failed")
  }

  return success(c, { message: "TOTP enabled" })
})

// TOTP Verify (unauthenticated — uses challenge token)
auth.post("/totp/verify", zValidator("json", totpVerifySchema), async (c) => {
  const { challengeToken, code, recoveryCode } = c.req.valid("json")
  // Validate challenge token (non-destructive GET — allows retries for brute-force tracking).
  // Token is consumed (deleted) only on successful verification below.
  const challengeKey = `challenge:${challengeToken}`
  const challengeRaw = await redis.get(challengeKey)
  if (!challengeRaw) {
    throw new HTTPException(401, { message: "Invalid or expired challenge token" })
  }
  let payload: { userId: string }
  try {
    payload = JSON.parse(challengeRaw)
  } catch {
    throw new HTTPException(401, { message: "Invalid or expired challenge token" })
  }
  const userId = payload.userId

  // Brute-force protection (read-only check) — runs BEFORE token consumption
  // so failed attempts still accumulate even though the token stays alive.
  // Fail-closed: Redis failure blocks TOTP to prevent brute-force bypass
  const totpIp = getClientIp(c)
  let totpBruteCheck: { allowed: boolean; retryAfter?: number }
  try {
    totpBruteCheck = await checkBruteForce(redis, `totp:${userId}`, totpIp)
  } catch (err) {
    log.error({ err }, "brute-force check failed — blocking request (fail-closed)")
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }
  if (!totpBruteCheck.allowed) {
    // Consume the challenge token on lockout — forces re-authentication from the
    // password step when the lockout expires, preventing indefinite TOTP enumeration.
    await redis.del(challengeKey)
    c.header("Retry-After", String(totpBruteCheck.retryAfter))
    throw new HTTPException(429, { message: "Too many attempts" })
  }

  const [user] = await withSystemDb("totp-verify-lookup", (db) =>
    db
      .select({ id: users.id, orgId: users.orgId, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )
  if (!user || user.status !== "active") {
    throw new HTTPException(401, { message: "Invalid credentials" })
  }

  // Malformed verify (no code, no recoveryCode) still burns brute-force budget
  if (!code && !recoveryCode) {
    try {
      await recordFailedAttempt(redis, `totp:${userId}`, totpIp)
    } catch {}
    throw new HTTPException(400, { message: "Code or recovery code required" })
  }

  // Per-account daily budget of wrong TOTP codes, across challenges and
  // source addresses. Past it the code path is refused for the day; a
  // recovery code still completes sign-in. Fail-closed like the check above.
  if (code) {
    let totpBudgetExhausted: boolean
    try {
      totpBudgetExhausted = await accountFailureBudgetExhausted(
        redis,
        "totp",
        userId,
        MAX_WRONG_TOTP_CODES_PER_DAY,
      )
    } catch (err) {
      log.error({ err }, "brute-force check failed — blocking request (fail-closed)")
      throw new HTTPException(503, { message: "Service temporarily unavailable" })
    }
    if (totpBudgetExhausted) {
      log.warn({ userId }, "TOTP code path locked for account")
      throw new HTTPException(429, {
        message: "Too many wrong codes today. Sign in with a recovery code instead.",
      })
    }
  }

  let tokens: Awaited<ReturnType<typeof createSession>>
  try {
    // Wrap TOTP verification in a privileged transaction (has orgId from user record)
    await withPrivilegedDb(user.orgId, "totp-verify", async (tx) => {
      const K = sql.raw(schemaRef("kernel"))
      if (code) {
        // Lock the user row to prevent concurrent TOTP replay; read secret from locked row
        const [lockedUser] = await tx.execute(
          sql`SELECT totp_last_used_at, totp_secret FROM ${K}.users WHERE id = ${userId} FOR UPDATE`,
        )

        // Reject replay: check both period index and exact code hash.
        // Period check prevents reuse within the same period. Code hash check
        // prevents reuse of codes valid across period boundaries (grace window).
        if (lockedUser.totp_last_used_at) {
          const lastUsedPeriod = Math.floor(
            new Date(lockedUser.totp_last_used_at as string).getTime() / 1000 / TOTP_PERIOD,
          )
          const currentPeriod = Math.floor(Date.now() / 1000 / TOTP_PERIOD)
          if (currentPeriod <= lastUsedPeriod) {
            throw new HTTPException(401, { message: "Invalid TOTP code" })
          }
        }
        // Reject exact code reuse across period boundaries via short-lived Redis key
        const codeHash = nodeCreateHash("sha256").update(code).digest("hex")
        const codeKey = `totp:used:${userId}:${codeHash}`
        const isNewCode = await redis.set(codeKey, "1", "EX", 90, "NX")
        if (!isNewCode) {
          throw new HTTPException(401, { message: "Invalid TOTP code" })
        }

        const decryptedSecret = decryptSecret(
          lockedUser.totp_secret as string,
          encryptionKey,
          CryptoContext.totpSecret,
        )
        if (!verifyTotpCode(decryptedSecret, code)) {
          // Clean up the code key since verification failed (not actually a replay)
          await redis.del(codeKey)
          throw new HTTPException(401, { message: "Invalid TOTP code" })
        }

        await tx.update(users).set({ totpLastUsedAt: new Date() }).where(eq(users.id, userId))
      } else if (recoveryCode) {
        // Lock the user row to prevent concurrent recovery code consumption (double-spend)
        const [lockedUser] = await tx.execute(
          sql`SELECT recovery_codes FROM ${K}.users WHERE id = ${userId} FOR UPDATE`,
        )
        const hashedCode = hashToken(recoveryCode)
        const codes = ((lockedUser as any).recovery_codes as string[]) ?? []
        // Iterate ALL codes with timing-safe comparison to avoid leaking position
        let matchIndex = -1
        for (let i = 0; i < codes.length; i++) {
          try {
            if (timingSafeEqual(Buffer.from(codes[i], "hex"), Buffer.from(hashedCode, "hex"))) {
              matchIndex = i
            }
          } catch {
            // length mismatch — not a match
          }
        }
        if (matchIndex === -1) throw new HTTPException(401, { message: "Invalid recovery code" })
        codes.splice(matchIndex, 1)
        await tx.update(users).set({ recoveryCodes: codes }).where(eq(users.id, userId))
      }
    })
    tokens = await createSession(user.id, user.orgId)
  } catch (err) {
    // Record failed attempt only for auth failures (401), not infrastructure errors
    if (err instanceof HTTPException && err.status === 401) {
      try {
        await recordFailedAttempt(redis, `totp:${userId}`, totpIp)
        if (code) {
          const wrongToday = await recordAccountFailure(redis, "totp", userId)
          if (wrongToday === MAX_WRONG_TOTP_CODES_PER_DAY) {
            await emitSecurityEvent({
              kind: "guess_ceiling",
              factor: "totp",
              userId,
              orgId: user.orgId,
            })
          }
        }
      } catch (recordErr) {
        log.warn({ err: recordErr }, "brute-force record failed")
      }
    }
    throw err
  }

  // Consume challenge token now that verification succeeded (single-use).
  // Token stays alive during failed attempts for brute-force tracking, but is
  // deleted on success to prevent reuse after a valid TOTP code is entered.
  await redis.del(challengeKey)

  try {
    await resetAttempts(redis, `totp:${userId}`, totpIp)
  } catch (err) {
    log.warn({ err }, "brute-force reset failed")
  }
  await withSystemDb("totp-verify-event", async (db) => {
    await db.queueEvent({
      app: "kernel",
      entity: "auth",
      action: "totp_verify",
      orgId: user.orgId,
      actorId: user.id,
      entityId: user.id,
    })
  })
  await noteSignIn(c, tokens, "totp")
  return respondWithTokens(c, tokens)
})

// Password Reset
auth.post("/password-reset/request", zValidator("json", passwordResetRequestSchema), async (c) => {
  const startedAt = performance.now()
  const { email, orgSlug } = c.req.valid("json")

  // Per-IP sliding-window rate limit: max 5 reset requests per hour.
  // Applied regardless of email validity to prevent unlimited reset emails.
  const ip = getClientIp(c)
  const resetIpKey = `reset-rate:${ip}`
  try {
    const resetCount = await redis.incr(resetIpKey)
    if (resetCount === 1) await redis.expire(resetIpKey, 3600)
    if (resetCount > 5) {
      throw new HTTPException(429, { message: "Too many reset requests" })
    }
  } catch (err) {
    if (err instanceof HTTPException) throw err
    log.error({ err }, "reset rate-limit check failed — blocking (fail-closed)")
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }

  // Per-email brute-force check
  try {
    const bruteCheck = await checkBruteForce(redis, `reset:${email.toLowerCase()}`, ip)
    if (!bruteCheck.allowed) {
      c.header("Retry-After", String(bruteCheck.retryAfter))
      throw new HTTPException(429, { message: "Too many attempts" })
    }
  } catch (err) {
    if (err instanceof HTTPException) throw err
    log.error({ err }, "brute-force check failed — blocking request (fail-closed)")
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }

  const outageAtStart = await mailOutageNow()

  // The same resolution login and magic-link use: an explicit orgSlug scopes to
  // one org, a bare email must be unambiguous across orgs, and only an active
  // account is reset. Anything else gets the same uniform answer and no mail.
  // While the provider refuses mail, so does all but the minute's one send (infra/email-outage.ts).
  const resolved = await resolveUser(email, signInOrgSlug(c, orgSlug))
  const user =
    resolved?.status === "active" && !(await emailOutageHoldsBackSend()) ? resolved : null

  if (user) {
    const token = generateToken()
    const tokenHash = hashToken(token)
    await withSystemDb("password-reset-create", async (db) => {
      // Invalidate any existing unused tokens for this user
      await db
        .update(passwordResets)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)))

      await db.insert(passwordResets).values({
        userId: user.id,
        orgId: user.orgId,
        tokenHash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
    })

    const resetUrl = `${await orgPublicBaseUrl(user.orgId)}/reset-password/confirm?token=${token}`
    const emailConfig = await getOrgEmailConfig(user.orgId)
    const subject = "Reset your password"
    const { html, text } = renderBrandedEmail({
      subject,
      eyebrow: "Security",
      heading: "Reset your password",
      paragraphs: [
        "We received a request to reset the password for your account. Click the button below to choose a new one.",
        "This link expires in 1 hour and can only be used once. If you didn't request a reset, you can safely ignore this email -- your password won't change.",
      ],
      cta: { label: "Reset your password", href: resetUrl },
      footer: [
        "You're receiving this because a password reset was requested for this email address.",
      ],
    })
    // Not awaited (see padToResponseFloor): waiting for the mail server would
    // tell a caller which addresses have an account.
    void sendSystemEmailObserved({
      to: email.toLowerCase(), // the lookup matched on exactly this address
      from: emailConfig.from,
      replyTo: emailConfig.replyTo,
      subject,
      html,
      text,
      template: "auth.password-reset",
    }).catch((err) => log.error({ err, userId: user.id }, "Failed to send password reset email"))

    log.info({ userId: user.id }, "Password reset token generated")
  }

  // Always record per-email attempt to prevent reset request bombing regardless of email validity.
  // Timing uniformity is maintained by always returning the same response. Not while mail is off:
  // those who keep trying would be locked out when it is back.
  if (!outageAtStart) {
    try {
      await recordFailedAttempt(redis, `reset:${email.toLowerCase()}`, ip)
    } catch (err) {
      log.warn({ err }, "brute-force record failed for password reset")
    }
  }

  await padToResponseFloor(startedAt)
  if (await mailOutageNow()) throw new EmailProviderUnavailableError()
  return success(c, { message: "If the email exists, a reset link has been sent" })
})

auth.post("/password-reset/confirm", zValidator("json", passwordResetConfirmSchema), async (c) => {
  const { token, newPassword } = c.req.valid("json")
  // Under host binding a reset link works on its org's own host only, and is
  // not spent anywhere else.
  if (!(await tokenOrgAllowedHere(c, "password-reset", token))) {
    throw new HTTPException(400, { message: "Invalid or expired token" })
  }
  const tokenHash = hashToken(token)

  let endedIds: string[] = []
  const reset = await withSystemDb("password-reset-confirm", async (tx) => {
    // Atomic claim: mark as used only if still unused and not expired
    const [claimed] = await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResets.tokenHash, tokenHash),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, new Date()),
        ),
      )
      .returning()

    if (!claimed) return null

    // Hash only once a live reset is claimed: the route is unauthenticated, and
    // a junk token must not buy its caller a password hash on the shared pool.
    const newHash = await hashPassword(newPassword)

    // Only an account that is still active: a token issued before the account
    // was deactivated must not set a password on it. The token is spent anyway.
    const [updated] = await tx
      .update(users)
      .set({ passwordHash: newHash, authVersion: sql`auth_version + 1` })
      .where(and(eq(users.id, claimed.userId), eq(users.status, "active")))
      .returning({ id: users.id })
    if (!updated) return null
    const ended = await tx
      .delete(sessions)
      .where(eq(sessions.userId, claimed.userId))
      .returning({ id: sessions.id })
    endedIds = ended.map((r) => r.id)
    // The person's MCP connections end with their sessions (end-user-connections.ts).
    await revokeAllMcpConnectionsForUser(tx, claimed.userId)
    // And their push delivery (push/end-user-push.ts).
    await removeAllPushDeliveryForUser(tx, claimed.userId)

    return claimed
  })

  if (!reset) {
    throw new HTTPException(400, { message: "Invalid or expired token" })
  }

  // The auth_version bump invalidates every token issued before the reset; drop
  // the cached auth state on all nodes so stolen/old tokens stop authenticating
  // immediately rather than after the per-process cache TTL.
  invalidateAuthCache(reset.userId)
  revokeSessions(endedIds, "password-reset")

  // Reset brute-force counters for the reset flow (both email and IP keys)
  try {
    const resetIp = getClientIp(c)
    const [resetUser] = await withSystemDb("password-reset-bruteforce-cleanup", (db) =>
      db.select({ email: users.email }).from(users).where(eq(users.id, reset.userId)).limit(1),
    )
    if (resetUser) {
      await resetAttempts(redis, `reset:${resetUser.email.toLowerCase()}`, resetIp)
    }
  } catch (err) {
    log.warn({ err }, "brute-force reset failed after password reset")
  }

  await withSystemDb("password-reset-event", async (db) => {
    await db.queueEvent({
      app: "kernel",
      entity: "auth",
      action: "password_reset",
      orgId: reset.orgId,
      actorId: reset.userId,
      entityId: reset.userId,
    })
  })

  return success(c, { message: "Password reset successful" })
})

// Password Change (authenticated — requires auth middleware on /api/auth/password/*)
auth.post("/password/change", zValidator("json", passwordChangeSchema), async (c) => {
  // A password change hands back a new, unrestricted session; a capped device
  // session must not be the way to one (session-ceiling.ts).
  assertUnrestrictedSession(c, "change the password")
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const { currentPassword, newPassword } = c.req.valid("json")

  // Brute-force protection on current password verification
  const pwChangeIp = getClientIp(c)
  try {
    const bruteCheck = await checkBruteForce(redis, `pwchange:${userId}`, pwChangeIp)
    if (!bruteCheck.allowed) {
      c.header("Retry-After", String(bruteCheck.retryAfter))
      throw new HTTPException(429, { message: "Too many attempts" })
    }
  } catch (err) {
    if (err instanceof HTTPException) throw err
    log.error({ err }, "brute-force check failed — blocking request (fail-closed)")
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }

  try {
    const tokens = await changePassword(userId, currentPassword, newPassword)

    // Reset brute-force counters on success
    try {
      await resetAttempts(redis, `pwchange:${userId}`, pwChangeIp)
    } catch {}

    await withSystemDb("password-change-event", async (db) => {
      await db.queueEvent({
        app: "kernel",
        entity: "auth",
        action: "password_change",
        orgId,
        actorId: userId,
        entityId: userId,
      })
    })

    return respondWithTokens(c, tokens)
  } catch (err) {
    // Record failed attempt on auth failure
    if (err instanceof AuthServiceError && err.status === 401) {
      try {
        await recordFailedAttempt(redis, `pwchange:${userId}`, pwChangeIp)
      } catch {}
    }
    if (err instanceof AuthServiceError) {
      throw new HTTPException(err.status as 400 | 401 | 403 | 404 | 409 | 429 | 500, {
        message: err.message,
      })
    }
    throw err
  }
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Step-up re-confirmation for a sensitive action by an already signed-in user.
//
// A stolen session token must not be enough on its own for the actions that
// change how an account is protected or that destroy the user's own data: a
// TOTP setup or disable, the mailbox reset, making a private mailbox
// transparent, deleting the account and connecting an AI tool (MCP client)
// with full access to the account. The caller proves it is the account
// holder again, either with the current password (password accounts) or with
// a 6-digit code emailed by `POST /api/auth/totp/step-up` (every account,
// including passwordless ones).
// Deleting the account takes the emailed code only: a password someone has
// seen over a shoulder or reused elsewhere must not be enough to erase it.
// Connecting an AI tool with full access takes the emailed code only as well:
// the approval pages have no password field, so a browser has nothing to
// autofill there, and accounts that sign in by link or Google have no password.

import { timingSafeEqual } from "node:crypto"
import type { ShippedLocale } from "@liaison/shared"
import { HTTPException } from "hono/http-exception"
import { hashToken, verifyPassword } from "~/lib/crypto"
import { redis } from "~/lib/redis"
import { accountFailureBudgetExhausted, recordAccountFailure } from "~/middleware/brute-force"
import { serverT } from "~/modules/i18n/server-i18n"
import { emitSecurityEvent } from "~/modules/security/security-events"

/**
 * What an emailed code is FOR. A code issued for one purpose confirms only that
 * purpose: a code the user received for a two-factor change cannot reset their
 * mailbox, and the email that carries a mailbox reset code says what the reset
 * does. `undefined` is the original two-factor purpose.
 */
export const STEP_UP_PURPOSES = [
  "mailbox_reset",
  "mailbox_rotate",
  "mailbox_transparent",
  "account_delete",
  "mcp_connect",
] as const
export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number]

export function isStepUpPurpose(value: unknown): value is StepUpPurpose {
  return typeof value === "string" && (STEP_UP_PURPOSES as readonly string[]).includes(value)
}

/** The Redis key the emailed step-up code is stored under (hashed). */
export function stepUpCodeKey(userId: string, purpose?: StepUpPurpose): string {
  return purpose ? `totp:stepup:${userId}:${purpose}` : `totp:stepup:${userId}`
}

/**
 * Wrong codes allowed against one emailed code. The fifth wrong code deletes
 * the stored code, so a stolen session cannot walk the million codes behind
 * the per-route rate limit; the holder asks for a new code.
 */
export const STEP_UP_MAX_WRONG_CODES = 5

/**
 * Wrong emailed codes one account accepts per day, across every code and
 * purpose. The per-code cap alone does not bound guessing: a session holder can
 * ask for a fresh code ten times an hour and each starts a new count. Past the
 * budget the emailed-code proof is refused for the day; the password proof
 * keeps its own count.
 */
export const STEP_UP_MAX_WRONG_CODES_PER_DAY = 10

/** The Redis key counting wrong codes against the current emailed code. */
export function stepUpFailKey(userId: string, purpose?: StepUpPurpose): string {
  return `totp:stepup-fail:${userId}:${purpose ?? "totp"}`
}

/**
 * Wrong passwords allowed as a step-up proof within the window. Login counts its
 * failures; without the same count here a stolen session could try passwords
 * against the step-up routes unthrottled. Past it, the password is refused for
 * the rest of the window (the emailed code still works).
 */
export const STEP_UP_MAX_WRONG_PASSWORDS = 5
const STEP_UP_PASSWORD_WINDOW_SECONDS = 15 * 60

/** The Redis key counting wrong step-up passwords for one user. */
export function stepUpPasswordFailKey(userId: string): string {
  return `totp:stepup-pwfail:${userId}`
}

/**
 * The refusal a step-up-protected action gives when the request carries no
 * proof at all: same status and message as before (400, "Provide
 * currentPassword or stepUpCode"), with a code a client can act on by asking
 * for the password or an emailed code and retrying.
 */
export class StepUpRequiredError extends HTTPException {
  readonly code = "STEP_UP_REQUIRED"
  constructor(message = "Provide currentPassword or stepUpCode") {
    super(400, { message })
  }
}

/** Purposes a password does not satisfy: the emailed code is the only proof. */
const CODE_ONLY_PURPOSES: ReadonlySet<StepUpPurpose> = new Set(["account_delete", "mcp_connect"])

/**
 * Purposes whose code a page sends by itself as soon as it shows the step-up
 * (the full-access MCP approvals). A reload must not send a second email, nor
 * replace the code the first one carried, so a send of such a purpose waits this
 * long after the previous one; the person can ask for a new code after it.
 */
export const STEP_UP_RESEND_COOLDOWN_SECONDS = 60
const COOLDOWN_PURPOSES: ReadonlySet<StepUpPurpose> = new Set(["mcp_connect"])

/** The cooldown that applies to sending a code for `purpose`, in seconds (0: none). */
export function stepUpResendCooldownSeconds(purpose: StepUpPurpose | undefined): number {
  return purpose !== undefined && COOLDOWN_PURPOSES.has(purpose)
    ? STEP_UP_RESEND_COOLDOWN_SECONDS
    : 0
}

/** The Redis key holding the resend cooldown of one user's code for `purpose`. */
export function stepUpResendCooldownKey(userId: string, purpose: StepUpPurpose): string {
  return `totp-stepup-cooldown:${userId}:${purpose}`
}

/** The `system-mail.stepUp.*` copy block of each purpose; absent: the generic one. */
const STEP_UP_COPY_KEY: Partial<Record<StepUpPurpose, string>> = {
  account_delete: "accountDelete",
  mailbox_rotate: "mailboxRotate",
  mailbox_transparent: "mailboxTransparent",
  mcp_connect: "mcpConnect",
  mailbox_reset: "mailboxReset",
}

/** The email that carries a step-up code, worded for what the code confirms, in `locale`. */
export function stepUpEmailCopy(
  code: string,
  purpose?: StepUpPurpose,
  locale: ShippedLocale = "en",
): { subject: string; eyebrow: string; heading: string; paragraphs: string[]; footer: string[] } {
  const block = (purpose && STEP_UP_COPY_KEY[purpose]) ?? "default"
  const key = (k: string) => `system-mail.stepUp.${block}.${k}`
  const t = (k: string) => serverT(locale, key(k), { code })
  // p3 exists for some purposes only: a missing key comes back as the key itself.
  const paragraphs = ["p1", "p2", "p3"].map(t).filter((p, i) => p !== key(`p${i + 1}`))
  return {
    subject: t("subject"),
    eyebrow: serverT(locale, "system-mail.stepUp.eyebrow"),
    heading: t("heading"),
    paragraphs,
    footer: [t("footer")],
  }
}

/**
 * Throws an HTTPException on any failure; returns normally when confirmed. An
 * emailed code is single use: it is deleted the moment it is accepted.
 *
 * A wrong code or password is a 422, never a 401. The caller is signed in; a
 * 401 tells the web client the session is dead, so it refreshes, resends the
 * same wrong code (a second counted attempt) and then signs the user out mid
 * dialog. A missing or expired session stays a 401 from the auth middleware.
 */
export async function assertStepUp(
  userId: string,
  passwordHash: string | null,
  body: { currentPassword?: string; stepUpCode?: string },
  purpose?: StepUpPurpose,
): Promise<void> {
  if (body.stepUpCode !== undefined) {
    const key = stepUpCodeKey(userId, purpose)
    const failKey = stepUpFailKey(userId, purpose)
    if (
      await accountFailureBudgetExhausted(
        redis,
        "step-up-code",
        userId,
        STEP_UP_MAX_WRONG_CODES_PER_DAY,
      )
    ) {
      await redis.del(key, failKey)
      throw new HTTPException(429, {
        message:
          purpose === "mcp_connect"
            ? "Too many wrong codes today. Try again tomorrow."
            : "Too many wrong codes today. Try again tomorrow, or confirm with your password.",
      })
    }
    const storedHash = await redis.get(key)
    const providedHash = hashToken(body.stepUpCode)
    const ok =
      !!storedHash &&
      storedHash.length === providedHash.length &&
      timingSafeEqual(Buffer.from(storedHash, "hex"), Buffer.from(providedHash, "hex"))
    if (!ok) {
      if (storedHash) {
        const wrongToday = await recordAccountFailure(redis, "step-up-code", userId)
        if (wrongToday === STEP_UP_MAX_WRONG_CODES_PER_DAY) {
          await emitSecurityEvent({ kind: "guess_ceiling", factor: "step_up_code", userId })
        }
        const wrong = await redis.incr(failKey)
        if (wrong === 1) await redis.expire(failKey, 600)
        if (wrong >= STEP_UP_MAX_WRONG_CODES) {
          await redis.del(key, failKey)
          throw new HTTPException(422, {
            message: "Too many wrong codes. This code no longer works; ask for a new one.",
          })
        }
      }
      throw new HTTPException(422, { message: "Invalid or expired step-up code" })
    }
    await redis.del(key, failKey)
    return
  }
  if (purpose && CODE_ONLY_PURPOSES.has(purpose)) {
    throw new HTTPException(400, {
      message: "This action is confirmed with the emailed code only. Ask for a code and enter it.",
    })
  }
  if (body.currentPassword !== undefined) {
    if (!passwordHash) {
      throw new HTTPException(400, {
        message: "This account has no password — request an email step-up code instead",
      })
    }
    const failKey = stepUpPasswordFailKey(userId)
    const failures = Number(await redis.get(failKey)) || 0
    if (failures >= STEP_UP_MAX_WRONG_PASSWORDS) {
      throw new HTTPException(429, {
        message: "Too many wrong passwords. Try again later, or ask for an emailed code.",
      })
    }
    const valid = await verifyPassword(body.currentPassword, passwordHash)
    if (!valid) {
      const wrong = await redis.incr(failKey)
      if (wrong === 1) await redis.expire(failKey, STEP_UP_PASSWORD_WINDOW_SECONDS)
      if (wrong === STEP_UP_MAX_WRONG_PASSWORDS) {
        await emitSecurityEvent({ kind: "guess_ceiling", factor: "step_up_password", userId })
      }
      throw new HTTPException(422, { message: "Invalid password" })
    }
    await redis.del(failKey)
    return
  }
  throw new StepUpRequiredError()
}

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
import { HTTPException } from "hono/http-exception"
import { hashToken, verifyPassword } from "~/lib/crypto"
import { redis } from "~/lib/redis"
import { accountFailureBudgetExhausted, recordAccountFailure } from "~/middleware/brute-force"
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

/** The email that carries a step-up code, worded for what the code confirms. */
export function stepUpEmailCopy(
  code: string,
  purpose?: StepUpPurpose,
): { subject: string; heading: string; paragraphs: string[]; footer: string[] } {
  if (purpose === "account_delete") {
    return {
      subject: `${code} is your code to delete your Liaison account`,
      heading: "Confirm deleting your account",
      paragraphs: [
        "Use the code above to delete your Liaison account.",
        "Deleting your account erases your profile, your private data and your connected devices in this organisation, and signs you out everywhere. What you shared with your team stays, without your name. Your accounts in other organisations are not affected. This cannot be undone.",
        "The code expires in 10 minutes. If you didn't ask for this, do not use it, and change your Liaison password.",
      ],
      footer: ["You're receiving this because deleting your account was requested."],
    }
  }
  if (purpose === "mailbox_rotate") {
    return {
      subject: `${code} is your code to change your Liaison mailbox key`,
      heading: "Confirm the mailbox key change",
      paragraphs: [
        "Use the code above to change the encryption key of your mailbox.",
        "From then on, new mail is sealed to the new key. If you didn't ask for this, do not use the code, and change your Liaison password.",
        "The code expires in 10 minutes.",
      ],
      footer: ["You're receiving this because a mailbox key change was requested on your account."],
    }
  }
  if (purpose === "mailbox_transparent") {
    return {
      subject: `${code} is your code to make your Liaison mailbox transparent`,
      heading: "Confirm making your mailbox transparent",
      paragraphs: [
        "Use the code above to make your private mailbox transparent.",
        "A transparent mailbox is encrypted with a key the server holds, so you and your agent read it without the mailbox password. If you didn't ask for this, do not use the code, and change your Liaison password.",
        "The code expires in 10 minutes.",
      ],
      footer: [
        "You're receiving this because making a private mailbox transparent was requested on your account.",
      ],
    }
  }
  if (purpose === "mcp_connect") {
    return {
      subject: `${code} is your code to connect an AI tool to Liaison`,
      heading: "Confirm connecting an AI tool",
      paragraphs: [
        "Use the code above to connect an AI tool to your Liaison account with full access.",
        "The tool will be able to act as you, with everything you can access, until you disconnect it in Settings. If you didn't ask for this, do not use the code, and change your Liaison password.",
        "The code expires in 10 minutes.",
      ],
      footer: [
        "You're receiving this because connecting an AI tool was requested on your account.",
      ],
    }
  }
  if (purpose === "mailbox_reset") {
    return {
      subject: `${code} is your code to reset your Liaison mailbox`,
      heading: "Confirm the mailbox reset",
      paragraphs: [
        "Use the code above to reset your encrypted mailbox.",
        "Resetting deletes the encrypted copy of your mail in Liaison; it downloads again from Gmail. Drafts written in Liaison and emails waiting for your approval are deleted for good, and you will choose a new mailbox password.",
        "The code expires in 10 minutes. If you didn't ask for this, do not use it, and change your Liaison password.",
      ],
      footer: ["You're receiving this because a mailbox reset was requested on your account."],
    }
  }
  return {
    subject: `${code} is your Liaison verification code`,
    heading: "Confirm it's you",
    paragraphs: [
      "Use the code above to continue.",
      "It expires in 10 minutes. If you didn't request this, you can safely ignore this email.",
    ],
    footer: ["You're receiving this because a two-factor change was requested on your account."],
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

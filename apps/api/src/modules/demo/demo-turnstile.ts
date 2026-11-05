// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cloudflare Turnstile for the demo's public forms.
//
// Every request that can make this box do something on a stranger's behalf
// (create a workspace, mail a code, verify through a link) carries a fresh
// invisible Turnstile token, checked here before anything else runs. A bot
// that cannot pass the challenge spends none of the budgets behind it: not the
// box-wide signup budget, not the per-IP counters, and not the brute-force
// counters login shares (routes.ts runs this FIRST).
//
// FAIL CLOSED. No secret configured, a network error, a timeout, a non-200,
// an unparseable body: all refused. There is no test-environment pass; tests
// answer the siteverify call through the outbound-fetch test seam, the way
// Cloudflare's published test secrets answer it.
//
// What a passing answer must also say: the token was issued on THIS
// deployment's hostname (from BASE_URL, never a hardcoded host) and for THIS
// action, so a token minted for one form cannot be replayed on another.
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { fetchWithRedirectValidation } from "~/lib/outbound-fetch"

const log = rootLogger.child({ module: "demo-turnstile" })

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

/**
 * Cloudflare's published test secrets (always pass, always fail, always
 * "already spent"). Public values from Cloudflare's docs; tests configure them.
 */
export const TURNSTILE_TEST_SECRETS = {
  pass: "1x0000000000000000000000000000000AA",
  fail: "2x0000000000000000000000000000000AA",
  duplicate: "3x0000000000000000000000000000000AA",
} as const

/** The forms that carry a token, one action each. */
export type DemoTurnstileAction = "demo_start" | "demo_code" | "demo_verify"

/** Why a token was refused; logged, never shown beyond `turnstile_failed`. */
export type TurnstileRefusal =
  | "not_configured"
  | "missing_token"
  | "network"
  | "bad_response"
  | "rejected"
  | "duplicate"
  | "hostname"
  | "action"

export type TurnstileResult = { ok: true } | { ok: false; reason: TurnstileRefusal }

const TIMEOUT_MS = 5_000

/** Is the secret configured? Without it every demo form refuses. */
export function isTurnstileConfigured(): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY)
}

interface SiteverifyBody {
  success?: unknown
  hostname?: unknown
  action?: unknown
  "error-codes"?: unknown
}

/** Check one Turnstile token for `action`. Never throws. */
export async function verifyTurnstile(
  token: string | undefined | null,
  opts: { action: DemoTurnstileAction; remoteIp?: string | null },
): Promise<TurnstileResult> {
  const secret = env.TURNSTILE_SECRET_KEY
  if (!secret) return refuse("not_configured", opts.action)
  if (!token || token.length > 2048) return refuse("missing_token", opts.action)

  const form = new URLSearchParams({ secret, response: token })
  if (opts.remoteIp) form.set("remoteip", opts.remoteIp)

  let body: SiteverifyBody
  try {
    const res = await fetchWithRedirectValidation(
      TURNSTILE_SITEVERIFY_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      { maxRedirects: 0 },
    )
    if (!res.ok) return refuse("bad_response", opts.action)
    body = (await res.json()) as SiteverifyBody
  } catch (err) {
    log.warn({ err, action: opts.action }, "turnstile siteverify failed")
    return refuse("network", opts.action)
  }

  if (body.success !== true) {
    const codes = Array.isArray(body["error-codes"]) ? body["error-codes"] : []
    return refuse(codes.includes("timeout-or-duplicate") ? "duplicate" : "rejected", opts.action)
  }
  if (body.hostname !== expectedHostname()) return refuse("hostname", opts.action)
  if (body.action !== opts.action) return refuse("action", opts.action)
  return { ok: true }
}

function expectedHostname(): string {
  return new URL(env.BASE_URL).hostname
}

function refuse(reason: TurnstileRefusal, action: DemoTurnstileAction): TurnstileResult {
  log.info({ reason, action }, "turnstile token refused")
  return { ok: false, reason }
}

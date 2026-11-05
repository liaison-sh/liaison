// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only: Cloudflare's siteverify answered in process, the way its
// published test secrets answer it, plus the demo-door env a test needs.
// Imported by tests only.
import { capturedDemoMail, setDemoSystemMailProvider } from "~/infra/email"
import { env } from "~/lib/env"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { TURNSTILE_TEST_SECRETS } from "~/modules/demo/demo-turnstile"

/** A token the fake siteverify accepts for `action`. */
export function passingTurnstileToken(action = "demo_start"): string {
  return `XXXX.DUMMY.TOKEN.XXXX:${action}`
}

/** What the fake siteverify was asked, newest last. */
export const siteverifyCalls: Array<{ secret: string; response: string }> = []

/**
 * Behaves like Cloudflare's test secrets: the always-pass secret answers
 * success for the action carried by the token, the always-fail secret refuses,
 * the duplicate secret answers `timeout-or-duplicate`. A token ending in
 * `:wrong-host` answers another hostname; `network-error` throws.
 */
export function installFakeSiteverify(): void {
  const fake = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const form = new URLSearchParams(String(init?.body ?? ""))
    const secret = form.get("secret") ?? ""
    const response = form.get("response") ?? ""
    siteverifyCalls.push({ secret, response })
    if (response === "network-error") throw new Error("connect ECONNREFUSED")
    const action = response.split(":")[1] ?? ""
    const hostname =
      response.split(":")[2] === "wrong-host" ? "elsewhere.example" : new URL(env.BASE_URL).hostname
    const body =
      secret === TURNSTILE_TEST_SECRETS.pass
        ? { success: true, hostname, action }
        : secret === TURNSTILE_TEST_SECRETS.duplicate
          ? { success: false, "error-codes": ["timeout-or-duplicate"] }
          : { success: false, "error-codes": ["invalid-input-response"] }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
  OutboundFetchTestAccess.setFetch(Object.assign(fake, { preconnect: fetch.preconnect }))
}

const saved: { secret?: string; capture: boolean } = { capture: false }

/** Demo door env for a test: the always-pass secret and the capture sender. */
export function enableDemoDoorForTest(): void {
  saved.secret = env.TURNSTILE_SECRET_KEY
  saved.capture = env.LIAISON_DEMO_MAIL_CAPTURE
  env.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRETS.pass
  env.LIAISON_DEMO_MAIL_CAPTURE = true
  setDemoSystemMailProvider(undefined)
  installFakeSiteverify()
}

export function restoreDemoDoorEnv(): void {
  env.TURNSTILE_SECRET_KEY = saved.secret
  env.LIAISON_DEMO_MAIL_CAPTURE = saved.capture
  setDemoSystemMailProvider(undefined)
  OutboundFetchTestAccess.setFetch(null)
}

/** The six-digit code and the link token of the last mail captured for `to`. */
export function lastCapturedCode(to: string): { code: string; token: string } | null {
  const mail = [...capturedDemoMail().sent].reverse().find((m) => m.to === to)
  if (!mail?.text) return null
  const code = mail.text.match(/\b(\d{6})\b/)?.[1]
  const token = mail.text.match(/[?&]t=([^\s&]+)/)?.[1]
  if (!code || !token) return null
  return { code, token: decodeURIComponent(token) }
}

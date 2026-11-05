// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SIGNING IN FROM THE DESKTOP APP, the RFC 8252 way ("OAuth 2.0 for Native
// Apps"): the system browser, a custom-scheme redirect back into the app, and
// PKCE binding the one-time code to the app that asked for it.
//
// The desktop app used to navigate its own embedded webview to the authorize
// route, so the identity provider's page ran INSIDE the app. Google refuses
// embedded user agents by policy (disallowed_useragent) and, in practice, its
// passkey sign-in cannot reach the platform passkey store from an embedded
// webview: it falls back to the cross-device "use your phone" flow and a user
// with a passkey or 2FA cannot sign in at all.
//
// So the app opens the authorize URL in the user's own browser, with
// `client=desktop` and an S256 `code_challenge` it derived from a verifier that
// never leaves the app. The callback, still in that browser, does not redirect
// to the web app's `/login/oauth-complete`: it answers a small self contained
// page that hands the browser to `liaison://oauth-complete?code=...&state=...`.
// The operating system gives that link to the app, and the app redeems the code
// at `/oauth/exchange` WITH the verifier. Anything that sees the link on the
// way (another app registered for the scheme, a log, a history entry) holds a
// code it cannot redeem.
//
// A code minted for the web flow carries no challenge and is redeemed exactly
// as before.
//
// THE PHONE RUNS THE SAME FLOW with `client=mobile`. The iOS shell opens the
// authorize URL in ASWebAuthenticationSession (Google refuses the app's own
// webview for the same reasons it refuses the desktop's) with `liaison` as the
// callback scheme, so the handoff link goes back to that session alone rather
// than through the system wide scheme dispatch. Same PKCE, same handoff page,
// same exchange; the exchange comes from the `capacitor://localhost` origin,
// which the shells' origin list already recognises (lib/app-origins.ts).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { Context } from "hono"
import { escapeHtml, hashedStyleCsp, localeFromAcceptLanguage } from "~/lib/html-page"
import { serverT } from "~/modules/i18n/server-i18n"

/** The desktop app's `client` value on the authorize route. */
export const DESKTOP_CLIENT = "desktop"

/** The mobile shell's `client` value: the same flow, its own name. */
export const MOBILE_CLIENT = "mobile"

/** Every `client` value the authorize route understands. */
const NATIVE_CLIENTS: ReadonlySet<string> = new Set([DESKTOP_CLIENT, MOBILE_CLIENT])

/** Where the handoff page sends the browser: the app's registered scheme. */
export const DESKTOP_OAUTH_COMPLETE_URL = "liaison://oauth-complete"

/**
 * How long a web code lives: the SPA redeems it on the very next page load.
 */
export const WEB_EXCHANGE_CODE_TTL_SECONDS = 30

/**
 * How long a DESKTOP code lives, and why it is longer. The hop is not a page
 * load: the browser first asks the user whether to open the Liaison app
 * (Safari, Chrome and Firefox all do, the first time and often every time),
 * and only after that click does the app start its exchange. Thirty seconds
 * is shorter than a person reading a dialog on a slow day. Two minutes costs
 * nothing: the code is useless without the PKCE verifier, which never left
 * the app, and it is still single use.
 */
export const DESKTOP_EXCHANGE_CODE_TTL_SECONDS = 120

/** base64url of a SHA-256 digest, unpadded: exactly 43 characters. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/
/** RFC 7636 section 4.1: 43 to 128 unreserved characters. */
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
/**
 * The app's own `state`. It rides in a custom-scheme URL and is matched by the
 * app, so it is held to a plain, unambiguous alphabet.
 */
const DESKTOP_STATE = /^[A-Za-z0-9_-]{16,128}$/

/**
 * What a native app flow (desktop or mobile) carries through the round trip,
 * in the state record.
 */
export interface DesktopFlow {
  codeChallenge: string
}

export type AuthorizeClient =
  | { kind: "web" }
  | { kind: "desktop"; flow: DesktopFlow }
  | { kind: "invalid"; message: string }

/**
 * Reads the authorize route's desktop parameters, strictly.
 *
 * None of them present is the web flow, untouched. Any of them present makes
 * it a native app request, and then every one has to be right: a `client`
 * other than `desktop` or `mobile`, a method other than `S256` (RFC 8252
 * section 8.1: `plain` protects nothing), a challenge that is not a SHA-256
 * digest, or a missing or malformed `state` is refused rather than quietly
 * downgraded to the web flow, which would drop the PKCE binding the app is
 * relying on.
 */
export function parseAuthorizeClient(query: {
  client?: string
  codeChallenge?: string
  codeChallengeMethod?: string
  state?: string
}): AuthorizeClient {
  const { client, codeChallenge, codeChallengeMethod, state } = query
  if (client === undefined && codeChallenge === undefined && codeChallengeMethod === undefined) {
    return { kind: "web" }
  }
  if (client === undefined || !NATIVE_CLIENTS.has(client)) {
    return { kind: "invalid", message: "Unsupported client" }
  }
  if (codeChallengeMethod !== "S256") {
    return { kind: "invalid", message: "code_challenge_method must be S256" }
  }
  if (codeChallenge === undefined || !S256_CHALLENGE.test(codeChallenge)) {
    return { kind: "invalid", message: "Invalid code_challenge" }
  }
  if (state === undefined || !DESKTOP_STATE.test(state)) {
    return { kind: "invalid", message: "Invalid state" }
  }
  return { kind: "desktop", flow: { codeChallenge } }
}

/** A desktop flow record read back from Redis, or null for the web flow. */
export function desktopFlowOf(value: unknown): DesktopFlow | null {
  if (!value || typeof value !== "object") return null
  const challenge = (value as { codeChallenge?: unknown }).codeChallenge
  return typeof challenge === "string" && S256_CHALLENGE.test(challenge)
    ? { codeChallenge: challenge }
    : null
}

/** The S256 transform (RFC 7636 section 4.2). */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

/**
 * Whether `verifier` is the one `challenge` was derived from. Constant time
 * over the digest; a verifier that is not even well formed fails before any
 * hashing.
 */
export function verifyS256(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !PKCE_VERIFIER.test(verifier)) return false
  const expected = Buffer.from(challenge)
  const actual = Buffer.from(s256(verifier))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** The outcome the handoff page carries back to the app. */
export type DesktopOutcome = { code: string } | { error: string }

/** `liaison://oauth-complete?code=...&state=...`, or `?error=...&state=...`. */
export function desktopHandoffUrl(outcome: DesktopOutcome, state: string | undefined): string {
  const params = new URLSearchParams()
  if ("code" in outcome) params.set("code", outcome.code)
  else params.set("error", outcome.error)
  if (state) params.set("state", state)
  return `${DESKTOP_OAUTH_COMPLETE_URL}?${params}`
}

/**
 * The page's only stylesheet, pinned by hash in its policy. No external asset
 * of any kind: the page is shown in whatever browser the user has, and the
 * one thing it has to do is work.
 */
const HANDOFF_STYLE =
  ":root{color-scheme:light dark}" +
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
  "font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
  "background:#f6f6f4;color:#1c1c1a}" +
  "main{max-width:380px;margin:24px;padding:32px;border-radius:12px;background:#fff;" +
  "border:1px solid #e3e3df;text-align:center}" +
  "h1{font-size:20px;margin:0 0 12px}p{margin:0 0 16px;color:#55554f}" +
  "a.button{display:inline-block;padding:10px 18px;border-radius:8px;background:#1c1c1a;" +
  "color:#fff;text-decoration:none;font-weight:600}" +
  "small{display:block;margin-top:16px;color:#8a8a84}" +
  "@media (prefers-color-scheme:dark){body{background:#161615;color:#ededea}" +
  "main{background:#1f1f1d;border-color:#33332f}p{color:#b5b5ae}" +
  "a.button{background:#ededea;color:#161615}}"

/**
 * The handoff page's own policy: nothing loads, nothing runs, nothing frames
 * it, and nothing is submitted from it. The browser is moved on by the meta
 * refresh and the link, neither of which needs a script.
 */
export const DESKTOP_HANDOFF_CSP = hashedStyleCsp(HANDOFF_STYLE)

/**
 * The page that hands the browser back to the app. It moves on by itself
 * (a meta refresh, which the browser turns into its "Open Liaison?" prompt)
 * and it says so, with a button to the same link for a browser that asks for
 * a click first or a user who dismissed the prompt.
 */
export function desktopHandoffResponse(
  c: Context,
  outcome: DesktopOutcome,
  state: string | undefined,
  /** What ends here: a sign-in, or an app connection the app finishes (shell-connect.ts). */
  purpose: "sign-in" | "connect" = "sign-in",
): Response {
  const locale = localeFromAcceptLanguage(c.req.header("accept-language"))
  const t = (key: string) => escapeHtml(serverT(locale, `kernel.auth.${key}`))
  const target = escapeHtml(desktopHandoffUrl(outcome, state))
  const lead =
    purpose === "connect"
      ? "code" in outcome
        ? t("desktopHandoffConnected")
        : t("desktopHandoffConnectFailed")
      : "code" in outcome
        ? t("desktopHandoffSignedIn")
        : t("desktopHandoffFailed")
  const html = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${target}">
<title>${t("desktopHandoffReturn")}</title>
<style>${HANDOFF_STYLE}</style>
</head>
<body>
<main>
<h1>${t("desktopHandoffReturn")}</h1>
<p>${lead}</p>
<a class="button" href="${target}">${t("desktopHandoffReturn")}</a>
<small>${t("desktopHandoffHint")}</small>
</main>
</body>
</html>
`
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": DESKTOP_HANDOFF_CSP,
      // The page's URL carries the provider's code and the page carries ours.
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  })
}

/** A fresh one-time code, the same shape for both flows. */
export function mintExchangeCode(): string {
  return randomBytes(32).toString("hex")
}

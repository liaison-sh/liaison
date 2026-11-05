// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash } from "node:crypto"
import type { MiddlewareHandler } from "hono"
import { browserStorageOrigin } from "~/infra/storage/delivery"
import { isManagedEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"

/** Cloudflare Turnstile's script and challenge frame origin (demo forms only). */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com"

export interface SecurityHeadersOptions {
  /**
   * The object store's origin when browsers talk to it directly (presigned PUT
   * uploads, presigned GET downloads and thumbnails), else null. It joins
   * `connect-src` (the PUT and the download fetch) and `img-src` (thumbnails;
   * already covered by `https:` except for a plain-http dev store). This
   * reaches API responses via the middleware below, and the web page and its
   * HTML assets via `webShellHeaders` (lib/server.ts serves those before Hono
   * runs). Defaults to
   * the deployment's own (infra/storage/delivery.ts), so the policy names the
   * store exactly when the delivery decision sends the browser there.
   */
  storageOrigin?: string | null
}

export interface ContentSecurityPolicyOptions extends SecurityHeadersOptions {
  /**
   * `'sha256-...'` sources for the page's inline scripts (the web shell's
   * pre-paint theme resolver and its import map). Set only for the web shell;
   * it also opens the few extra sources the SPA needs (blob: images for the
   * lightbox, data: fonts the bundler inlines).
   */
  scriptHashes?: string[]
  /**
   * Allow Cloudflare Turnstile (script + challenge frame) on the web shell.
   * Defaults to: demo mode is on AND a Turnstile site key is configured. Off
   * everywhere else, so no other deployment's policy names a third party.
   */
  turnstile?: boolean
  /**
   * The payment frame's origin on the web shell. Defaults to
   * LIAISON_PAY_FRAME_ORIGIN in the managed edition (read per call), else none.
   */
  payFrameOrigin?: string | null
}

function payFrameOrigin(explicit: string | null | undefined): string | null {
  if (explicit !== undefined) return explicit
  return isManagedEdition() ? (env.LIAISON_PAY_FRAME_ORIGIN ?? null) : null
}

export function contentSecurityPolicy(options: ContentSecurityPolicyOptions = {}): string {
  const storageOrigin =
    options.storageOrigin === undefined ? browserStorageOrigin() : options.storageOrigin
  const storageSource = storageOrigin ? ` ${storageOrigin}` : ""
  const shell = options.scriptHashes !== undefined
  const scriptHashes = (options.scriptHashes ?? []).map((h) => ` ${h}`).join("")
  const turnstile =
    shell && (options.turnstile ?? (isDemoModeEnabled() && Boolean(env.TURNSTILE_SITE_KEY)))
  const turnstileSource = turnstile ? ` ${TURNSTILE_ORIGIN}` : ""
  const payFrame = shell ? payFrameOrigin(options.payFrameOrigin) : null
  const frameSources = `${turnstileSource}${payFrame ? ` ${payFrame}` : ""}`
  return [
    "default-src 'self'",
    // The web shell compiles one WebAssembly module: the Argon2id that opens a
    // LEGACY mailbox password row (packages/mailbox-crypto,
    // legacy-passphrase-kdf.ts; new rows use PBKDF2 through WebCrypto). Without
    // it such a row could not be unlocked in the browser. 'wasm-unsafe-eval'
    // allows WASM compilation only; JavaScript eval stays blocked.
    `script-src 'self'${shell ? " 'wasm-unsafe-eval'" : ""}${scriptHashes}${turnstileSource}`,
    // The mailbox crypto worker (spec section 3.3). No browser can SRI-pin a
    // worker, so the page fetches its source, hashes it against a hash baked in
    // at build time and boots it from a blob URL on a match. That boot needs
    // `blob:` here: without an explicit worker-src it falls back to
    // `default-src 'self'` and the browser blocks it. `blob:` is scoped to
    // workers only, so it widens nothing for scripts on the page.
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${shell ? " blob:" : ""} https:${storageSource}`,
    `connect-src 'self' wss:${storageSource}`,
    `font-src 'self'${shell ? " data:" : ""}`,
    // The demo door's invisible Turnstile challenge runs in a frame from its
    // own origin. Only a demo deployment with a site key names it.
    // The managed edition's Billing page embeds its payment frame
    // (LIAISON_PAY_FRAME_ORIGIN); no other edition names it.
    ...(frameSources ? [`frame-src 'self'${frameSources}`] : []),
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ")
}

/** The header set every response carries, whatever its content type. */
export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Microphone for the app's own origin only: dictation records through
  // getUserMedia in the composer. Embedded frames get nothing.
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
}

/** CSP hash sources for each inline (src-less) `<script>` of an HTML document. */
export function inlineScriptHashes(html: string | Uint8Array): string[] {
  const text = typeof html === "string" ? html : new TextDecoder().decode(html)
  const hashes: string[] = []
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)) {
    if (/\bsrc\s*=/i.test(m[1] ?? "")) continue
    hashes.push(
      `'sha256-${createHash("sha256")
        .update(m[2] ?? "")
        .digest("base64")}'`,
    )
  }
  return hashes
}

/**
 * Headers for the web shell and static assets, which lib/server.ts answers
 * before Hono (and so before the middleware below) runs. An HTML document
 * also gets the CSP, with its own inline scripts pinned by hash; other assets
 * (js, css, images) carry the base set only, since a CSP governs documents.
 */
export function webShellHeaders(options: {
  html: string | Uint8Array | null
  storageOrigin?: string | null
}): Record<string, string> {
  const headers: Record<string, string> = { ...BASE_SECURITY_HEADERS }
  if (options.html !== null) {
    headers["Content-Security-Policy"] = contentSecurityPolicy({
      storageOrigin: options.storageOrigin,
      scriptHashes: inlineScriptHashes(options.html),
    })
  }
  return headers
}

export function securityHeaders(options: SecurityHeadersOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    await next()
    c.header("X-Content-Type-Options", BASE_SECURITY_HEADERS["X-Content-Type-Options"] as string)
    c.header(
      "Strict-Transport-Security",
      BASE_SECURITY_HEADERS["Strict-Transport-Security"] as string,
    )
    // A route that set its OWN policy or referrer rule set a stricter one on
    // purpose (a served upload is sandboxed, the desktop sign-in handoff page
    // allows exactly one hashed stylesheet), and the default below is looser
    // than either. Overwriting them silently undid that hardening. A route's own
    // framing rule is kept too: the app frame document (modules/apps/app-frame.ts)
    // is framed by this origin's pages, and pins that in its policy.
    const own = c.res.headers
    if (!own.has("X-Frame-Options"))
      c.header("X-Frame-Options", BASE_SECURITY_HEADERS["X-Frame-Options"] as string)
    if (!own.has("Referrer-Policy"))
      c.header("Referrer-Policy", BASE_SECURITY_HEADERS["Referrer-Policy"] as string)
    c.header("Permissions-Policy", BASE_SECURITY_HEADERS["Permissions-Policy"] as string)
    if (own.has("Content-Security-Policy")) return
    c.header("Content-Security-Policy", contentSecurityPolicy(options))
  }
}

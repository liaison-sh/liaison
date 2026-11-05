// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The page a person's browser lands on at the end of an MCP server sign-in: the
// success page (`/oauth/done`) and the failure page of the callback. It is styled
// like the app (the web theme's tokens from apps/web/src/styles/theme.css, light
// and dark through prefers-color-scheme, the favicon's mark as the wordmark) but
// loads nothing: no font, no script, no image. Its one stylesheet is pinned by
// hash in the page's own Content-Security-Policy, and every interpolated value
// (the server's name, the error text, the reason code) is HTML-escaped.

import type { ShippedLocale } from "@liaison/shared"
import { escapeHtml, hashedStyleCsp } from "~/lib/html-page"
import { serverT } from "~/modules/i18n/server-i18n"

// Values mirror apps/web/src/styles/theme.css (light `:root`, dark `@theme`).
const CALLBACK_STYLE =
  ":root{color-scheme:light dark;--color-bg:#fafafa;--color-surface:#f4f4f6;--color-card:#ffffff;" +
  "--color-border:#dfdfe5;--color-text:#2a2a32;--color-text-secondary:#5a5a64;" +
  "--color-text-tertiary:#92929c;--color-accent:#4a5468;--color-success:#1f9d55;" +
  "--color-error:#d14343;--mark-bg:#1f2937;--mark-fg:#f3f4f6;" +
  "--font-sans:'Geist Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
  "--font-display:'Clash Display','Geist Sans',system-ui,sans-serif;" +
  "--font-mono:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace}" +
  "@media (prefers-color-scheme:dark){:root{--color-bg:#111113;--color-surface:#1a1a1e;" +
  "--color-card:#1a1a1e;--color-border:#262630;--color-text:#cdcdd4;" +
  "--color-text-secondary:#888892;--color-text-tertiary:#65656e;--color-accent:#b0b8c8;" +
  "--color-success:#3dbf70;--color-error:#e86464;--mark-bg:#f3f4f6;--mark-fg:#1f2937}}" +
  "*{box-sizing:border-box}" +
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
  "padding:16px;background:var(--color-bg);color:var(--color-text);" +
  "font:15px/1.55 var(--font-sans)}" +
  "main{width:100%;max-width:420px;padding:32px;border-radius:12px;background:var(--color-card);" +
  "border:1px solid var(--color-border);text-align:center}" +
  ".brand{display:inline-flex;align-items:center;gap:8px;margin-bottom:24px;" +
  "color:var(--color-text-secondary);font:600 14px/1 var(--font-display);letter-spacing:.02em}" +
  ".brand svg{width:22px;height:22px}" +
  ".status{width:40px;height:40px;margin:0 auto 16px;border-radius:50%;display:flex;" +
  "align-items:center;justify-content:center;font-size:20px;font-weight:700}" +
  ".ok .status{color:var(--color-success);border:2px solid var(--color-success)}" +
  ".error .status{color:var(--color-error);border:2px solid var(--color-error)}" +
  "h1{margin:0 0 12px;font:600 20px/1.3 var(--font-display);overflow-wrap:anywhere}" +
  "p{margin:0 0 12px;color:var(--color-text-secondary);overflow-wrap:anywhere}" +
  ".close{margin-top:20px;color:var(--color-text-tertiary);font-size:13px}" +
  "code{font:12px var(--font-mono);color:var(--color-text-tertiary)}"

/**
 * The page's own policy: nothing loads, nothing runs, nothing frames it and
 * nothing is submitted from it. The one inline stylesheet is allowed by hash;
 * the inline SVG mark needs no source.
 */
export const CALLBACK_PAGE_CSP = hashedStyleCsp(CALLBACK_STYLE)

/** The Liaison mark (apps/web/public/favicon.svg), recoloured by the theme. */
const MARK_SVG =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--mark-bg)"/>' +
  '<path d="M10 8 V20 H22" stroke="var(--mark-fg)" stroke-width="2.75" stroke-linecap="round" ' +
  'stroke-linejoin="round" fill="none"/><circle cx="22" cy="20" r="2.5" fill="var(--mark-fg)"/></svg>'

export type CallbackPageInput =
  | { kind: "ok"; locale: ShippedLocale; serverName: string | null }
  | { kind: "error"; locale: ShippedLocale; message: string; code: string }

/** The full HTML document. Every dynamic value is escaped here, once. */
export function renderCallbackPage(input: CallbackPageInput): string {
  const t = (key: string, params?: Record<string, string>) =>
    escapeHtml(serverT(input.locale, `kernel.mcpUi.${key}`, params))
  const title =
    input.kind === "ok"
      ? input.serverName
        ? t("callbackConnectedTitle", { name: input.serverName })
        : t("callbackConnectedGeneric")
      : t("callbackFailedTitle")
  const body =
    input.kind === "ok"
      ? `<p>${t("callbackConnectedBody")}</p>`
      : `<p>${escapeHtml(input.message)}</p><p>${t("callbackFailedBody")}</p>` +
        `<p><code>${t("callbackReason", { code: input.code })}</code></p>`
  return `<!doctype html>
<html lang="${input.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>${CALLBACK_STYLE}</style>
</head>
<body>
<main class="${input.kind}" data-testid="mcp-oauth-callback-${input.kind}">
<div class="brand">${MARK_SVG}<span>Liaison</span></div>
<div class="status" aria-hidden="true">${input.kind === "ok" ? "&#10003;" : "!"}</div>
<h1>${title}</h1>
${body}
<p class="close">${t("callbackClose")}</p>
</main>
</body>
</html>
`
}

/** The headers every callback page carries. */
export const CALLBACK_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": CALLBACK_PAGE_CSP,
  "Referrer-Policy": "no-referrer",
}

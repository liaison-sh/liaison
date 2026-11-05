// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE PAGE A CONNECT CARD'S POPUP ENDS ON.
//
// A connect card in a conversation opens the provider's consent in a popup.
// The callback stores the account and sends the popup here
// (service.ts, connectCardReturnUrl): the page says how it went and closes
// itself. The card on the conversation has already been told by the server
// (the secret request's event), so this page passes nothing back: no code, no
// token, no account name, nothing but "connected" or "failed" and, for a
// failure, a reason code from a closed set (connect-failures.ts), shown as its
// fixed sentence: no text from the link is ever shown.
//
// Its policy lets exactly its own style and its own one-line script run.

import { connectFailureReason } from "@liaison/shared"
import type { Context } from "hono"
import { cspHash, escapeHtml, hashedStyleCsp, localeFromAcceptLanguage } from "~/lib/html-page"
import { serverT } from "~/modules/i18n/server-i18n"

const STYLE =
  ":root{color-scheme:light dark}" +
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
  "font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
  "background:#f6f6f4;color:#1c1c1a}" +
  "main{max-width:380px;margin:24px;padding:32px;border-radius:12px;background:#fff;" +
  "border:1px solid #e3e3df;text-align:center}" +
  "h1{font-size:20px;margin:0 0 12px}p{margin:0 0 16px;color:#55554f}" +
  "small{display:block;margin-top:16px;color:#8a8a84}" +
  "@media (prefers-color-scheme:dark){body{background:#161615;color:#ededea}" +
  "main{background:#1f1f1d;border-color:#33332f}p{color:#b5b5ae}}"

/** Close the popup once it is shown; a tab nobody opened stays open with its text. */
const SCRIPT = "setTimeout(function(){try{window.close()}catch(e){}},600)"

export const CONNECT_DONE_CSP = hashedStyleCsp(STYLE, [`script-src 'sha256-${cspHash(SCRIPT)}'`])

export function connectDonePage(c: Context): Response {
  const locale = localeFromAcceptLanguage(c.req.header("accept-language"))
  const t = (key: string) => escapeHtml(serverT(locale, `kernel.auth.${key}`))
  const connected = c.req.query("result") === "connected"
  // A known reason's fixed sentence; any other value reads as a plain failure.
  const reason = connected
    ? ""
    : t(`connectFailedReason.${connectFailureReason(c.req.query("reason"))}`)
  const html = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${connected ? t("connectDoneTitle") : t("connectFailedTitle")}</title>
<style>${STYLE}</style>
</head>
<body>
<main data-testid="connect-done" data-result="${connected ? "connected" : "failed"}">
<h1>${connected ? t("connectDoneTitle") : t("connectFailedTitle")}</h1>
<p>${connected ? t("connectDoneBody") : t("connectFailedBody")}</p>
${reason ? `<p data-testid="connect-done-reason">${reason}</p>` : ""}
<small>${t("connectDoneHint")}</small>
</main>
${connected ? `<script>${SCRIPT}</script>` : ""}
</body>
</html>
`
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CONNECT_DONE_CSP,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  })
}

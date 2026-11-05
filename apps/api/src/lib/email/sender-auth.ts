// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sender authentication verdict for an ingested message.
//
// A From header is whatever the sender typed. The only evidence that it is
// genuine is the verdict the RECEIVING provider (Gmail, Microsoft 365, ...)
// recorded in its `Authentication-Results` header (RFC 8601) after checking
// SPF, DKIM and DMARC. We never run those checks ourselves (we see the message
// after the provider did); we read the provider's result.
//
// Only the TOPMOST `Authentication-Results` header is read, and only when its
// authserv-id is one we trust for the way the message reached us. The receiving
// provider adds its header above everything the sender wrote, so the topmost
// one is the provider's own. A sender can add any number of look-alike headers
// of their own (claiming `mx.google.com; dmarc=pass`), but they always sit
// BELOW the provider's. When the provider adds none (some IMAP hosts), the
// topmost header is the sender's, which is why an id is trusted only for the
// path that is known to add it:
//
//   - a message fetched through the Gmail API: `mx.google.com` is always trusted
//     (Gmail stamps every message it receives from outside);
//   - any other path (IMAP): only the ids an operator lists in
//     INBOUND_TRUSTED_AUTHSERV_IDS (comma separated), after checking that their
//     provider adds its own header to every inbound message.
//
// Verdicts:
//   pass  the provider authenticated the From domain (DMARC pass, or an
//         aligned DKIM / SPF pass)
//   fail  the provider reported a failure (DMARC, DKIM or SPF fail)
//   none  no trusted provider verdict is present (IMAP without a configured id,
//         mail between two mailboxes of the same Google Workspace, an old
//         message); NOT evidence of forgery, but not evidence of authenticity
//         either

import type { ParsedEmail } from "./types"

export type SenderAuth = "pass" | "fail" | "none"

/** The authserv-id Gmail writes on messages it receives. */
export const GMAIL_AUTHSERV_ID = "mx.google.com"

/** Operator-configured authserv-ids, lowercased. Empty when unset. */
export function configuredAuthservIds(): string[] {
  const raw = process.env.INBOUND_TRUSTED_AUTHSERV_IDS
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** The authserv-ids trusted for a message, by how it reached us. */
export function trustedAuthservIdsFor(raw: Pick<ParsedEmail, "receivedVia">): string[] {
  const ids = configuredAuthservIds()
  if (raw.receivedVia === "gmail_api" && !ids.includes(GMAIL_AUTHSERV_ID)) {
    ids.push(GMAIL_AUTHSERV_ID)
  }
  return ids
}

function domainOf(address: string | undefined | null): string | null {
  if (!address) return null
  const at = address.lastIndexOf("@")
  return (
    (at >= 0 ? address.slice(at + 1) : address)
      .trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/g, "") || null
  )
}

/** Relaxed alignment: equal, or one is a subdomain of the other. */
function aligned(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

type Method = { method: string; result: string; props: Record<string, string> }

/** Remove RFC 5322 comments, nested ones included. */
function stripComments(value: string): string {
  let out = ""
  let depth = 0
  for (const ch of value) {
    if (ch === "(") depth += 1
    else if (ch === ")" && depth > 0) depth -= 1
    else if (depth === 0) out += ch
  }
  return out
}

function parseMethods(header: string): { authservId: string; methods: Method[] } {
  // `authserv-id [version] ; method=result (comment) prop.name=value ; ...`
  const parts = stripComments(header).split(";")
  const authservId = (parts[0] ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  const methods: Method[] = []
  for (const part of parts.slice(1)) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    const first = tokens[0]
    if (!first) continue
    const m = /^([a-z0-9-]+)=([a-z]+)$/i.exec(first)
    if (!m) continue
    const props: Record<string, string> = {}
    for (const t of tokens.slice(1)) {
      const kv = /^([a-z0-9-]+\.[a-z0-9-]+)=(.*)$/i.exec(t)
      if (kv) props[kv[1].toLowerCase()] = kv[2].replace(/^"|"$/g, "")
    }
    methods.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props })
  }
  return { authservId, methods }
}

/**
 * Evaluate the provider's verdict for the message's From domain. `headers` are
 * the raw `Authentication-Results` values in wire order, topmost first. Only the
 * topmost one is read, and only when its authserv-id is in `trusted`.
 */
export function evaluateAuthenticationResults(
  headers: readonly string[] | undefined,
  fromEmail: string | undefined | null,
  trusted: readonly string[],
): SenderAuth {
  const fromDomain = domainOf(fromEmail)
  const top = headers?.[0]
  if (!top || !fromDomain || trusted.length === 0) return "none"
  const { authservId, methods } = parseMethods(String(top))
  if (!trusted.some((t) => t.toLowerCase() === authservId)) return "none"

  const dmarc = methods.find((m) => m.method === "dmarc")
  if (dmarc?.result === "pass") {
    // The provider says WHICH From domain passed. Without that property its pass may be about a
    // different From than the one our parser read (two From addresses, an odd encoding), so it
    // proves nothing on its own: an aligned DKIM or SPF pass below still can.
    const hf = domainOf(dmarc.props["header.from"])
    if (hf) return aligned(hf, fromDomain) ? "pass" : "none"
  }
  if (dmarc?.result === "fail") return "fail"
  const dkim = methods.filter((m) => m.method === "dkim")
  const spf = methods.filter((m) => m.method === "spf")
  const dkimPass = dkim.some(
    (m) =>
      m.result === "pass" &&
      (aligned(domainOf(m.props["header.d"]), fromDomain) ||
        aligned(domainOf(m.props["header.i"]), fromDomain)),
  )
  const spfPass = spf.some(
    (m) => m.result === "pass" && aligned(domainOf(m.props["smtp.mailfrom"]), fromDomain),
  )
  if (dkimPass || spfPass) return "pass"
  if ([...dkim, ...spf].some((m) => m.result === "fail")) return "fail"
  return "none"
}

/** The verdict for a parsed message (read from its recorded headers). */
export function senderAuthOf(raw: ParsedEmail): SenderAuth {
  return evaluateAuthenticationResults(
    raw.authenticationResults,
    raw.from?.email,
    trustedAuthservIdsFor(raw),
  )
}

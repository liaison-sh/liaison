// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Auto-responder detection for inbound email matcher.
 *
 * Returns a metadata string (header:value) when the inbound email looks like
 * an auto-responder, vacation reply, or list/bulk delivery. Returns null
 * otherwise. Matcher callers always treat a non-null result as
 * `{ outcome: "dropped", reason: "auto_responder" }` — the returned string is
 * only used for logging.
 */
export function detectAutoResponder(headers: Record<string, string[]>): string | null {
  const norm = new Map<string, string[]>()
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (!k) continue
    norm.set(k.toLowerCase(), Array.isArray(v) ? v : [String(v)])
  }

  const autoSubmitted = norm.get("auto-submitted")
  if (autoSubmitted) {
    for (const raw of autoSubmitted) {
      const v = raw.trim().toLowerCase()
      if (v && v !== "no") return `auto_submitted:${v.split(/[;,\s]/)[0]}`
    }
  }

  const precedence = norm.get("precedence")
  if (precedence) {
    for (const raw of precedence) {
      const v = raw.trim().toLowerCase()
      if (v === "bulk" || v === "junk" || v === "list") return `precedence:${v}`
    }
  }

  if (norm.has("list-id")) return "list-id"
  if (norm.has("x-auto-response-suppress")) return "x-auto-response-suppress"

  return null
}

// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash } from "node:crypto"

/**
 * Shared, single-definition helpers used by BOTH the synchronous `analyze_media`
 * tool and the slow-path background job (and, for the host match, the link-ingest
 * scan + download). Centralising them here removes the prior verbatim copies that
 * could silently drift — a divergent `hashContext` would break the cross-path
 * cache; a divergent prompt would split behaviour between the two video paths.
 */

/** Stable hash over the (possibly empty) agent context — empty string for absent. */
export function hashContext(context: string | undefined | null): string {
  return createHash("sha256")
    .update(context ?? "")
    .digest("hex")
    .slice(0, 32)
}

/** Media flavor for the system instruction. `true`/`false` accepted as a legacy
 * alias for the video/image path (the video-only slow-path job still passes a
 * bare boolean). */
export type SystemInstructionKind = "image" | "video" | "document" | boolean

/**
 * Build the base diagnostic system instruction + the agent's context. One
 * definition for the image path (sync tool), the inline-video path (sync tool),
 * the Files-API slow-path job, and the PDF-document path. `kind` selects the
 * flavor; documents get a distinct extraction prompt (invoices/POs and any
 * business document), while image/video keep the terse hardware-diagnostic one.
 */
export function buildSystemInstruction(
  context: string | undefined,
  kind: SystemInstructionKind,
): string {
  const normalized = kind === true ? "video" : kind === false ? "image" : kind

  const lines =
    normalized === "document"
      ? [
          "You are a business-document extraction assistant. A customer or partner",
          "has sent a PDF document (commonly a purchase order or invoice, but it may",
          "be any business document) attached to a support request. Extract its",
          "content FAITHFULLY and structurally for the support agent. Cover, when present:",
          "- the sender/company (and recipient, if shown)",
          "- the line items as a table: SKU/reference, description, quantity, unit price, currency, line total",
          "- subtotal, tax, shipping, and grand total (with currency)",
          "- dates (order date, due date, delivery date)",
          "- reference numbers (PO number, invoice number, quote number, order id)",
          "- billing and shipping addresses",
          "- payment terms and any notes",
          "Quote exact figures and identifiers verbatim; NEVER invent or guess a",
          "missing value. If a field is absent, illegible, or ambiguous, say so",
          "explicitly rather than filling it in.",
        ]
      : [
          "You are a hardware-support diagnostic assistant. A customer has sent media",
          "attached to a support request. Describe it TERSELY and structurally for the",
          "support agent. Cover, when present:",
          "- what it shows (the device/object and its condition)",
          "- any visible text, error codes, model numbers, or serial numbers",
        ]

  if (normalized === "video") lines.push("- a one-line gist of any spoken audio")
  if (normalized !== "document") lines.push("- how it relates to a likely hardware issue")
  if (context && context.trim().length > 0) {
    lines.push("", `Agent context for this analysis: ${context.trim()}`)
  }
  return lines.join("\n")
}

/**
 * Case-insensitive whitelist host match. Matches the exact registrable host OR
 * a subdomain of it (provider download CDN hosts like `dlNN.swisstransfer.com`,
 * or a `www.` prefix). Anchored on a dot boundary so `evilswisstransfer.com`
 * does NOT match `swisstransfer.com`.
 *
 * NOTE (trust assumption): ANY subdomain of a whitelisted apex is trusted on the
 * initial URL AND every redirect hop. DNS-pinning (in `outbound-fetch.ts`) still
 * blocks private/loopback/metadata targets, so this is bounded to an
 * open-redirect-to-arbitrary-PUBLIC-host surface gated by the magic-byte
 * image/video check — not an SSRF-to-metadata pivot. Keep this in mind before
 * adding a user-controlled-subdomain provider (or a URL-shortener apex) to
 * `TRANSFER_HOST_WHITELIST`.
 */
export function hostInWhitelist(host: string, whitelist: string[]): boolean {
  const h = host.toLowerCase()
  return whitelist.some((raw) => {
    const w = raw.toLowerCase()
    return h === w || h.endsWith(`.${w}`)
  })
}

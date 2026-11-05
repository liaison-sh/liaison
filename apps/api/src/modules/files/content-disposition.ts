// SPDX-License-Identifier: FSL-1.1-ALv2
import { sanitizeFilename } from "~/infra/storage/object-storage"

// Strip characters that could break out of a quoted Content-Disposition value
// or smuggle additional headers. Combined with `sanitizeFilename` (which strips
// control bytes + path separators), this keeps the filename safely quotable.
function safeDispositionFilename(name: string): string {
  return sanitizeFilename(name).replace(/["\\\r\n]/g, "_")
}

/**
 * Build a Content-Disposition value that safely handles non-ASCII filenames.
 * Emits both the legacy `filename=` (ASCII fallback, quoted) and the RFC 5987
 * `filename*=UTF-8''<percent-encoded>` form. Modern browsers prefer filename*;
 * older or non-RFC-aware clients fall back to the quoted filename= value.
 */
export function contentDisposition(disposition: "inline" | "attachment", rawName: string): string {
  // The quoted filename= fallback must be pure ASCII: Bun's Response rejects
  // header values containing non-ISO-8859-1 bytes outright (TypeError → 500),
  // and non-ASCII in the quoted form is undefined behavior per RFC 6266
  // anyway. Non-ASCII names are carried by the filename*= form below.
  const asciiName = safeDispositionFilename(rawName).replace(/[^\x20-\x7e]/g, "_")
  // RFC 5987 percent-encoding: encode every byte except unreserved chars.
  // `encodeURIComponent` encodes all non-ASCII and most special chars; the
  // RFC 5987 attr-char set allows a broader set but encodeURIComponent is a
  // safe conservative subset.
  const encodedName = encodeURIComponent(rawName).replace(
    /['()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
}

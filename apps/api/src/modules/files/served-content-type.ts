// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Content-Type a stored file is served with on the app's own origin.
//
// The stored type is whatever the uploader declared. Served as is, a file
// declared as JavaScript is a same-origin script URL: the page CSP allows
// `script-src 'self'`, so any later markup injection could load it past the
// CSP (nosniff, `Content-Disposition: attachment` and the response's own
// `CSP: sandbox` do not stop a `<script src>`). Only types a browser never
// runs, renders as a document or applies as a stylesheet keep their declared
// type; everything else is served as opaque bytes. The download keeps its
// filename, so the saved file opens as before.

const OPAQUE = "application/octet-stream"

/** Exact types (lower case, without parameters) that are always inert. */
const INERT_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/json",
  "application/zip",
  "application/gzip",
  "application/x-zip-compressed",
  "application/msword",
  "application/rtf",
  OPAQUE,
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/calendar",
  "text/vcard",
])

/** Media families that are inert, minus the active members excluded below. */
const INERT_PREFIXES = ["image/", "audio/", "video/", "font/"]

/** Office document families (`application/vnd.ms-excel`, `…openxmlformats…`). */
const INERT_VENDOR_PREFIXES = [
  "application/vnd.openxmlformats-officedocument.",
  "application/vnd.oasis.opendocument.",
  "application/vnd.ms-",
]

export function servedContentType(declared: string): string {
  const base = declared.split(";")[0]?.trim().toLowerCase() ?? ""
  // SVG and every XML flavour can carry script or render as a document.
  if (base.includes("svg") || base.includes("xml")) {
    // The OOXML families carry "xml" in their name but are zip archives a
    // browser never renders.
    if (!base.startsWith("application/vnd.openxmlformats-officedocument.")) return OPAQUE
  }
  if (INERT_TYPES.has(base)) return declared
  if (INERT_PREFIXES.some((p) => base.startsWith(p))) return declared
  if (INERT_VENDOR_PREFIXES.some((p) => base.startsWith(p))) return declared
  return OPAQUE
}

/**
 * The Content-Type of the `/inline` route. An SVG keeps its own type there: that route always
 * answers with `CSP: sandbox` and serves an SVG as an attachment, so opened as a document it runs
 * nothing and navigating to it downloads it, while the app can still draw it as an image (which an
 * opaque type, under nosniff, would not). Nothing else differs from `servedContentType`; the
 * download relay, which sends no such policy, keeps the opaque type for an SVG too.
 */
export function inlineServedContentType(declared: string): string {
  const base = declared.split(";")[0]?.trim().toLowerCase() ?? ""
  if (base === "image/svg+xml") return declared
  return servedContentType(declared)
}

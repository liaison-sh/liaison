// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The offline checker page of an evidence file (check.html): one HTML file,
// its script inline, no external resource, and the package's own manifest,
// event list and timestamp reply embedded as base64 data. Base64 keeps every
// string from the evidence (typed names, capacities) out of the markup: the
// page decodes it and shows it through `textContent` only. The page's content
// security policy allows its one script by hash and no network at all.
import { PAGE_SCRIPT_BASE64, PAGE_SCRIPT_SHA256_BASE64 } from "./generated/page-script"

/** The page's script, bundled from src/page/ by build.ts. */
export const PAGE_SCRIPT = Buffer.from(PAGE_SCRIPT_BASE64, "base64").toString("utf8")

export type { EvidenceData } from "./check"

export interface CheckPageInput {
  /** manifest.json's exact bytes. */
  manifestBytes: Uint8Array
  /** trail.json's exact bytes (canonical JSON of the copy's event list). */
  trailBytes: Uint8Array
  trailKind: "full" | "signer_copy"
  /** timestamp.tsr's bytes, absent while the stamp is pending. */
  timestampReply?: Uint8Array
  /** The organization that keeps the full event list. */
  orgName: string
  lang: "en" | "fr"
}

export const CHECK_PAGE_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${PAGE_SCRIPT_SHA256_BASE64}'`,
  "style-src 'unsafe-inline'",
  "img-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ")

const STYLE = [
  "body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}",
  "code,pre{font:12px/1.4 ui-monospace,monospace;word-break:break-all;white-space:pre-wrap}",
  "section{margin:1.5rem 0}.muted{color:#666}.ok{color:#14532d}.bad{color:#8a1c1c}",
  ".drop{display:block;border:2px dashed #999;border-radius:8px;padding:1.5rem;text-align:center;cursor:pointer}",
  ".drop input{display:block;margin:.75rem auto 0}.result{border-radius:8px;padding:1rem;border:1px solid #ccc}",
  ".result.ok{background:#f0fdf4}.result.bad{background:#fef2f2}.fp{margin:.5rem 0}.label{font-size:13px;color:#555}",
].join("")

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

/** The check.html of one evidence zip (the staff file or one signer's copy). */
export function buildCheckPage(input: CheckPageInput): Uint8Array {
  const data = {
    v: 1,
    lang: input.lang === "fr" ? "fr" : "en",
    org: input.orgName,
    manifest: b64(input.manifestBytes),
    trail: b64(input.trailBytes),
    trailKind: input.trailKind,
    ...(input.timestampReply ? { token: b64(input.timestampReply) } : {}),
  }
  // Only base64 and fixed words reach the markup; the org name is the one free
  // string, so every character that could close the script element is escaped.
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
  const html = [
    "<!doctype html>",
    `<html lang="${data.lang}"><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${CHECK_PAGE_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    "<title>check.html</title>",
    `<style>${STYLE}</style></head><body>`,
    '<main id="app"></main>',
    `<script type="application/json" id="evidence-data">${json}</script>`,
    `<script>${PAGE_SCRIPT}</script>`,
    "</body></html>",
  ].join("")
  return new TextEncoder().encode(html)
}

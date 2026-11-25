// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The door of the offline checker page (check.html, inside every evidence
// file a signer or a portal person downloads): what clients and senders typed
// reaches it as base64 data and is shown as text only. The browser half
// (the page rendering those strings inert, offline) is the playwright
// scenario `agreements/evidence-check-offline.scenario.test.ts`.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildCheckPage, CHECK_PAGE_CSP } from "@liaison/evidence-check"
import { canonicalJsonBytes } from "~/modules/signing/canonical-json"
import { computeSeal } from "~/modules/signing/seal"

const PAGE_SRC = resolve(import.meta.dir, "../../../../../../packages/evidence-check/src")

const MARKUP_SINKS = [
  /\binnerHTML\b/,
  /\bouterHTML\b/,
  /\binsertAdjacentHTML\b/,
  /\bDOMParser\b/,
  /\bdocument\.write\b/,
  /\bcreateContextualFragment\b/,
  /\bsrcdoc\b/,
  /\beval\s*\(/,
  /\bnew Function\b/,
]

const SCRIPT = `<script>window.__xss=1</script>`
const IMG = `<img src=x onerror="window.__xss=1">`
const PAYLOAD = {
  typedName: `Paul ${SCRIPT}`,
  capacity: `Director ${IMG}`,
  reason: `</script><script>window.__xss=1</script>`,
  subject: `Proposal <svg onload="window.__xss=1">`,
  filename: `${IMG}.pdf`,
  requestText: `Please --> <!-- ${SCRIPT}`,
}

describe("offline checker page doors", () => {
  it("NT-55: the offline checker page renders typed names, capacities, reasons, subjects, filenames and request texts as text, never as markup", () => {
    // 1. Its script never turns a string into markup.
    const files = [
      ...readdirSync(join(PAGE_SRC, "page")).map((f) => join("page", f)),
      "check.ts",
      "index.ts",
    ]
    const hits: string[] = []
    for (const f of files) {
      const text = readFileSync(join(PAGE_SRC, f), "utf8")
      for (const re of MARKUP_SINKS) if (re.test(text)) hits.push(`${f}: ${re.source}`)
    }
    expect(hits).toEqual([])

    // 2. The strings reach the page as data that cannot close its element.
    const trail = {
      v: 1,
      agreement: PAYLOAD.subject,
      events: [
        {
          client_action_id: "a",
          typed_name: PAYLOAD.typedName,
          capacity: PAYLOAD.capacity,
          reason: PAYLOAD.reason,
          filename: PAYLOAD.filename,
          request_text: PAYLOAD.requestText,
          signed_at: "2026-11-10",
        },
      ],
    }
    const trailBytes = canonicalJsonBytes(trail)
    const sealed = computeSeal({
      documentSha256: "a".repeat(64),
      signedPdfSha256: "b".repeat(64),
      trailSha256: "c".repeat(64),
      level: "ses",
      agreement: PAYLOAD.subject,
      version: 1,
    })
    const html = new TextDecoder().decode(
      buildCheckPage({
        manifestBytes: sealed.manifestBytes,
        trailBytes,
        trailKind: "full",
        orgName: `Maison ${PAYLOAD.reason}`,
        lang: "en",
      }),
    )
    for (const p of Object.values(PAYLOAD)) expect(html).not.toContain(p)
    expect(html.match(/<script/g)?.length).toBe(2)
    expect(html.match(/<\/script>/g)?.length).toBe(2)
    expect(html).not.toMatch(/<(?:img|svg)\b/)
    // 3. And the page itself runs only its own script, with no network.
    expect(html).toContain(`content="${CHECK_PAGE_CSP}"`)
    expect(CHECK_PAGE_CSP).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/)
    expect(CHECK_PAGE_CSP).not.toContain("unsafe-eval")
    expect(CHECK_PAGE_CSP).toContain("connect-src 'none'")
  })
})

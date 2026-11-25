// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The offline checker page of an evidence file, opened from disk in a browser
// with the network off: given the frozen document or the signed PDF it says
// "This is the document they signed" with the fingerprint; given an edited
// copy it says "This is not the document they signed" with both fingerprints.
// What clients typed (names, capacities, a file's name) shows as text only.
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { expect, type Page, test } from "@playwright/test"
import { buildCheckPage } from "../../../../../../packages/evidence-check/src/index"

const enc = (s: string) => new TextEncoder().encode(s)
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")

const frozen = enc("%PDF-1.7 the frozen document")
const signed = enc("%PDF-1.7 the frozen document with its signature pages")
const edited = enc("%PDF-1.7 the frozen document, one word changed")
const HOSTILE_NAME = `Paul <img src=x onerror="window.__xss=1"><script>window.__xss=1</script>`
const HOSTILE_CAPACITY = `Director <svg onload="window.__xss=1">`
const HOSTILE_FILE = `<img src=x onerror="window.__xss=1">.pdf`

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`
  if (v && typeof v === "object") {
    const r = v as Record<string, unknown>
    return `{${Object.keys(r)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(v)
}

const trail = {
  v: 1,
  agreement: "AG-2026-001",
  version: 1,
  events: [
    {
      client_action_id: "a",
      typed_name: HOSTILE_NAME,
      capacity: HOSTILE_CAPACITY,
      signed_at: "2026-11-10",
      ip: "198.51.100.7",
      user_agent: "UA-of-Paul",
    },
  ],
}
const trailBytes = enc(canonical(trail))
const manifest = {
  v: 1,
  hash: "sha256",
  document_sha256: sha(frozen),
  signed_pdf_sha256: sha(signed),
  trail_sha256: sha(trailBytes),
  level: "ses",
  agreement: "AG-2026-001",
  version: 1,
}
const manifestBytes = enc(canonical(manifest))

let dir: string
const file = (name: string) => path.join(dir, name)

test.beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "liaison-evidence-check-"))
  writeFileSync(
    file("check.html"),
    buildCheckPage({
      manifestBytes,
      trailBytes,
      trailKind: "full",
      orgName: "Maison Example",
      lang: "en",
    }),
  )
  writeFileSync(file("document.pdf"), frozen)
  writeFileSync(file("signed.pdf"), signed)
  writeFileSync(file("edited.pdf"), edited)
  writeFileSync(file(HOSTILE_FILE.replace(/[/]/g, "_")), frozen)
})

test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function openOffline(page: Page) {
  await page.context().setOffline(true)
  const outside: string[] = []
  page.on("request", (r) => {
    if (!r.url().startsWith("file:")) outside.push(r.url())
  })
  await page.goto(pathToFileURL(file("check.html")).href)
  await expect(page.getByTestId("evidence-seal-value")).toHaveText(sha(manifestBytes))
  return outside
}

async function drop(page: Page, name: string) {
  await page.getByTestId("evidence-file-input").setInputFiles(file(name))
}

test.describe("offline evidence check", () => {
  test("the frozen document and the signed PDF are the document they signed, an edited copy is not", async ({
    page,
  }) => {
    const outside = await openOffline(page)
    await expect(page.getByTestId("evidence-hash-method")).toContainText("this browser's SHA-256")
    await expect(page.getByTestId("evidence-trail-status")).toHaveText(
      "The list of events is the sealed one: its fingerprint is the one in the manifest.",
    )

    await drop(page, "document.pdf")
    await expect(page.getByTestId("evidence-verdict")).toHaveText(
      "This is the document they signed",
    )
    await expect(page.getByTestId("evidence-file-fingerprint")).toHaveText(sha(frozen))

    await drop(page, "signed.pdf")
    await expect(page.getByTestId("evidence-verdict")).toHaveText(
      "This is the document they signed",
    )
    await expect(page.getByTestId("evidence-verdict-detail")).toContainText("signed.pdf")
    await expect(page.getByTestId("evidence-file-fingerprint")).toHaveText(sha(signed))

    await drop(page, "edited.pdf")
    await expect(page.getByTestId("evidence-verdict")).toHaveText(
      "This is not the document they signed",
    )
    await expect(page.getByTestId("evidence-file-fingerprint")).toHaveText(sha(edited))
    await expect(page.getByTestId("evidence-document-fingerprint")).toHaveText(sha(frozen))
    await expect(page.getByTestId("evidence-package-problem")).toHaveCount(0)
    expect(outside).toEqual([])
  })

  test("without the browser's SHA-256 the page hashes with its own and gives the same answer", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Crypto.prototype, "subtle", { get: () => undefined })
    })
    await openOffline(page)
    await expect(page.getByTestId("evidence-hash-method")).toContainText("computed by this page")
    await drop(page, "document.pdf")
    await expect(page.getByTestId("evidence-verdict")).toHaveText(
      "This is the document they signed",
    )
    await expect(page.getByTestId("evidence-file-fingerprint")).toHaveText(sha(frozen))
    await drop(page, "edited.pdf")
    await expect(page.getByTestId("evidence-verdict")).toHaveText(
      "This is not the document they signed",
    )
  })

  test("typed names, capacities and file names show as text and never run", async ({ page }) => {
    await openOffline(page)
    await expect(page.getByTestId("evidence-event")).toContainText(HOSTILE_NAME)
    await expect(page.getByTestId("evidence-event")).toContainText(HOSTILE_CAPACITY)
    await drop(page, HOSTILE_FILE.replace(/[/]/g, "_"))
    await expect(page.getByTestId("evidence-verdict-detail")).toContainText(
      HOSTILE_FILE.replace(/[/]/g, "_"),
    )
    expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined()
    await expect(page.locator("main img, main svg, main script")).toHaveCount(0)
  })
})

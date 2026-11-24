// SPDX-License-Identifier: FSL-1.1-ALv2
// The Notion import screen (S15, D6), headless, at 1440 and 390.
//
// The administrator opens Import from Notion on the Knowledge home and uploads
// the fixture export. The preview names what will not come across and starts
// on Only me. Imported, the tab is reloaded mid-way and finds its run again;
// the report names every loss. Amina sees none of it, and her own import tab
// says who to ask. Undo leaves nothing. Imported again for everyone to view,
// Amina sees the folder; Undo again removes it for her too.

import type { Browser, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { notionExportZip } from "./helpers/notion-export-fixture"

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900, suffix: "1440" },
  { name: "390", width: 390, height: 844, suffix: "0390" },
] as const

async function signedIn(
  browser: Browser,
  env: Parameters<typeof loginAs>[1],
  email: string,
  password: string,
  vp: { width: number; height: number },
) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await context.newPage()
  await loginAs(page, env, email, password)
  return { context, page }
}

/** Every folder name in the reader's Knowledge tree. */
async function treeOf(env: { serverUrl: string }, token: string): Promise<string> {
  const res = await fetch(`${env.serverUrl}/api/knowledge/collections/tree`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return JSON.stringify(await res.json())
}

async function upload(page: Page, zip: Buffer): Promise<void> {
  await page.getByTestId("knowledge-import-file").setInputFiles({
    name: "Export-harbor.zip",
    mimeType: "application/zip",
    buffer: zip,
  })
  await expect(page.getByTestId("knowledge-import-preview")).toBeVisible({ timeout: 90_000 })
}

async function undoAll(page: Page): Promise<void> {
  await page.getByTestId("knowledge-import-undo").click()
  await page.getByTestId("knowledge-import-undo-confirm").click()
  const undone = page.getByTestId("knowledge-import-undone")
  await expect(undone).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("knowledge-import-kept")).toHaveCount(0)
}

for (const vp of VIEWPORTS) {
  test(`[Knowledge] Notion import: Only me, then shared, undo (${vp.name})`, async ({
    browser,
    env,
    qa,
  }) => {
    test.setTimeout(300_000)
    const tag = `${env.schemaPrefix.replace(/_$/, "")}-${vp.name}`
    const folder = `Harbor Handbook ${tag}`
    const zip = notionExportZip(vp.suffix, tag)
    const base = `http://localhost:${env.ports[1]}`
    const admin = await signedIn(browser, env, "admin@test.com", "12345678", vp)
    const amina = await signedIn(browser, env, qa.amina.email, "QaPass1!", vp)
    try {
      // ── The administrator opens the import from the Knowledge home ──────────
      await admin.page.goto(`${base}/knowledge`)
      await admin.page.getByTestId("knowledge-home-import").click({ timeout: 20_000 })
      await expect(admin.page.getByTestId("knowledge-import-upload")).toBeVisible()
      await expect(admin.page.getByTestId("knowledge-import-upload")).toContainText(
        "Markdown & CSV",
      )

      // A PDF is refused before any upload, in words.
      await admin.page.getByTestId("knowledge-import-file").setInputFiles({
        name: "Export.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.7\n"),
      })
      await expect(admin.page.getByTestId("knowledge-import-refusal")).toContainText("PDF")

      // ── Preview: what comes, what does not, Only me first ──────────────────
      await upload(admin.page, zip)
      const pv = admin.page.getByTestId("knowledge-import-preview")
      await expect(admin.page.getByTestId("knowledge-import-count-pages")).not.toContainText(/^0/)
      await expect(admin.page.getByTestId("knowledge-import-preview-losses")).toContainText(
        "skyline.png",
      )
      await expect(admin.page.getByTestId("knowledge-import-access-private")).toBeChecked()
      await expect(pv).toContainText("their folders")
      await admin.page.getByTestId("knowledge-import-start").click()

      // ── The tab is left and found again: the run comes back from the server ─
      await admin.page.reload()
      const report = admin.page.getByTestId("knowledge-import-report")
      await expect(admin.page.getByTestId("knowledge-import-progress").or(report)).toBeVisible({
        timeout: 30_000,
      })
      await expect(report).toBeVisible({ timeout: 120_000 })
      await expect(admin.page.getByTestId("knowledge-import-everything")).toHaveCount(0)
      await expect(admin.page.getByTestId("knowledge-import-report-losses")).toContainText(
        "skyline.png",
      )
      expect(await treeOf(env, qa.admin.token)).toContain(folder)

      // ── Amina: nothing of it, and her own tab says who to ask ───────────────
      expect(await treeOf(env, qa.amina.token)).not.toContain(folder)
      await amina.page.goto(`${base}/knowledge/import`)
      await expect(
        amina.page
          .getByTestId("knowledge-import-no-scope")
          .or(amina.page.getByTestId("knowledge-import-upload")),
      ).toBeVisible({ timeout: 20_000 })

      // ── Undo leaves nothing ──────────────────────────────────────────────
      await undoAll(admin.page)
      expect(await treeOf(env, qa.admin.token)).not.toContain(folder)

      // ── Again, for everyone to view: Amina sees the folder ──────────────────
      await admin.page.getByTestId("knowledge-import-another").click()
      await upload(admin.page, zip)
      await admin.page.getByTestId("knowledge-import-access-view").check()
      await expect(admin.page.getByTestId("knowledge-import-checking")).toHaveCount(0, {
        timeout: 90_000,
      })
      await expect(admin.page.getByTestId("knowledge-import-start")).toBeEnabled()
      await admin.page.getByTestId("knowledge-import-start").click()
      await expect(report).toBeVisible({ timeout: 120_000 })
      await expect.poll(() => treeOf(env, qa.amina.token), { timeout: 20_000 }).toContain(folder)

      await undoAll(admin.page)
      expect(await treeOf(env, qa.amina.token)).not.toContain(folder)
    } finally {
      await admin.context.close()
      await amina.context.close()
    }
  })
}

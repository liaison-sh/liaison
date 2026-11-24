// SPDX-License-Identifier: FSL-1.1-ALv2
// The `/` block menu and checklists in a page (S20), two people, headless, at 1440
// and 390.
//
// Amina types `/che` in her page: Add a block opens over the text (on screen at both
// widths), Enter makes a checklist, she types an item and ticks its box: the page
// saves `- [x] ...` by itself. A slash in an address opens nothing. Lucas, who may
// only read the page, sees the item done and has no box to tick.

import type { Browser, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { createKnowledgeDocument } from "./helpers/knowledge-seed"

type Env = Parameters<typeof createKnowledgeDocument>[0]

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const

function view(page: Page, docId: string) {
  return page.locator(`[data-testid="knowledge-document-view"][data-document-id="${docId}"]`)
}

async function signedIn(
  browser: Browser,
  env: Env,
  email: string,
  vp: { width: number; height: number },
) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await context.newPage()
  await loginAs(page, env, email, "QaPass1!")
  return { context, page }
}

async function storedBody(env: Env, token: string, docId: string): Promise<string> {
  const res = await fetch(`${env.serverUrl}/api/knowledge/documents/${docId}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return ((await res.json()) as { data: { body: string } }).data.body
}

for (const vp of VIEWPORTS) {
  test(`[Knowledge] / block menu and checklists (${vp.name})`, async ({ browser, env, qa }) => {
    test.setTimeout(180_000)
    const suffix = `${env.schemaPrefix.replace(/_$/, "")}-${vp.name}`
    const doc = await createKnowledgeDocument(env, qa.amina.token, {
      title: `Packing ${suffix}`,
      body: "Before shipping.",
      documentScope: "organization",
      orgAccess: "viewer",
    })
    const amina = await signedIn(browser, env, qa.amina.email, vp)
    const lucas = await signedIn(browser, env, qa.lucas.email, vp)
    const url = `http://localhost:${env.ports[1]}/knowledge/documents/${doc.id}`
    try {
      await amina.page.goto(url)
      const field = view(amina.page, doc.id).getByTestId("knowledge-doc-body-editor")
      await expect(field).toBeVisible({ timeout: 20_000 })
      await field.click()
      await amina.page.keyboard.press("ControlOrMeta+End")

      // A slash in an address is text.
      await amina.page.keyboard.type(" https://example.com/x")
      await expect(amina.page.getByTestId("slash-suggest")).toHaveCount(0)

      // `/` on a new line opens the menu, on screen, and the keyboard drives it.
      await amina.page.keyboard.press("Enter")
      await amina.page.keyboard.type("/che")
      const menu = amina.page.getByTestId("slash-suggest")
      await expect(menu).toBeVisible()
      await expect(menu.getByRole("option", { selected: true })).toContainText("Checklist")
      const box = await menu.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width)
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height)
      await amina.page.keyboard.press("Enter")
      await expect(menu).toHaveCount(0)
      await amina.page.keyboard.type("Seal the box")

      const saveState = view(amina.page, doc.id).getByTestId("save-state")
      await expect(saveState).toHaveAttribute("data-state", "saved", { timeout: 15_000 })
      expect(await storedBody(env, qa.amina.token, doc.id)).toBe(
        "Before shipping. https://example.com/x\n\n- [ ] Seal the box",
      )

      // A click ticks it in place, saved like any edit.
      await field.locator('input[type="checkbox"]').click()
      await expect
        .poll(() => storedBody(env, qa.amina.token, doc.id), { timeout: 15_000 })
        .toBe("Before shipping. https://example.com/x\n\n- [x] Seal the box")

      // Lucas reads it: done, and nothing to tick.
      await lucas.page.goto(url)
      const rendered = view(lucas.page, doc.id).getByTestId("knowledge-doc-body-rendered")
      await expect(rendered.locator(".md-task-box.md-task-done")).toHaveCount(1, {
        timeout: 20_000,
      })
      await expect(rendered.locator("input")).toHaveCount(0)
      await expect(view(lucas.page, doc.id).getByTestId("knowledge-doc-body-editor")).toHaveCount(0)
    } finally {
      await amina.context.close()
      await lucas.context.close()
    }
  })
}

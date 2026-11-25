// SPDX-License-Identifier: FSL-1.1-ALv2
// Knowledge Trash (S19, D3, D4, B3), headless, at 1440 and 390.
//
//   1. A member moves a page to Trash from its menu, Undo brings it back within 10 s;
//      moved again, its tab shows the Trash card, and Restore there reopens it.
//   2. (1440) The Trash list shows the page with its days left and no Delete for
//      good to a member; Restore takes it out.
//   3. (1440) An administrator deletes a page for good from Trash, after a confirm:
//      the page and its Trash entry are gone.
// What the server holds is read back through the API.

import type { Browser, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { createKnowledgeDocument } from "./helpers/knowledge-seed"
import { seedFactory } from "./helpers/seed"

type Env = Parameters<typeof createKnowledgeDocument>[0]

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const

async function status(env: Env, token: string, path: string, method = "GET"): Promise<number> {
  const res = await fetch(`${env.serverUrl}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  })
  return res.status
}

async function sharedPage(env: Env, token: string, title: string) {
  return createKnowledgeDocument(env, token, {
    title,
    body: "Steps to follow.",
    documentScope: "organization",
    orgAccess: "editor",
  })
}

function view(page: Page, docId: string) {
  return page.locator(`[data-testid="knowledge-document-view"][data-document-id="${docId}"]`)
}

async function openPage(page: Page, env: Env, docId: string) {
  await page.goto(`http://localhost:${env.ports[1]}/knowledge/documents/${docId}`)
  await expect(view(page, docId).getByTestId("knowledge-doc-body-editor")).toBeVisible({
    timeout: 20_000,
  })
}

async function moveToTrash(page: Page, docId: string) {
  await view(page, docId).getByTestId("knowledge-doc-menu").click()
  await page.getByTestId("knowledge-doc-trash").click()
}

async function signedIn(
  browser: Browser,
  env: Env,
  email: string,
  password: string,
  vp: { width: number; height: number },
) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await context.newPage()
  await loginAs(page, env, email, password)
  return { context, page }
}

for (const vp of VIEWPORTS) {
  test(`[Knowledge] trash, undo and restore (${vp.name})`, async ({ browser, env, qa }) => {
    test.setTimeout(180_000)
    const suffix = `${env.schemaPrefix.replace(/_$/, "")}-${vp.name}`
    // Members move pages they can edit to Trash (knowledge member role).
    await seedFactory(env, qa.orgId, "roles.grantScopes", {
      userId: qa.amina.id,
      scopes: ["knowledge:documents:archive"],
      onlyMissing: true,
    })
    const amina = await signedIn(browser, env, qa.amina.email, "QaPass1!", vp)
    try {
      // ── 1. Move to trash, Undo, again, then Restore from the Trash card ──
      const p = await sharedPage(env, qa.admin.token, `Return procedure ${suffix}`)
      await openPage(amina.page, env, p.id)
      await moveToTrash(amina.page, p.id)
      const toast = amina.page.getByTestId("toast-info").filter({ hasText: p.title })
      await expect(toast).toBeVisible()
      await expect(amina.page.getByTestId("knowledge-doc-trash-card")).toBeVisible()
      await toast.getByRole("button", { name: "Undo" }).click()
      await expect(view(amina.page, p.id).getByTestId("knowledge-doc-body-editor")).toBeVisible({
        timeout: 15_000,
      })
      expect(await status(env, qa.admin.token, `/knowledge/documents/${p.id}`)).toBe(200)

      await moveToTrash(amina.page, p.id)
      const card = amina.page.getByTestId("knowledge-doc-trash-card")
      await expect(card).toBeVisible({ timeout: 15_000 })
      await expect(card).toContainText("30 days left")
      expect(await status(env, qa.admin.token, `/knowledge/documents/${p.id}`)).toBe(404)
      // B3: the page's link shows the Trash card, not a dead page.
      await amina.page.reload()
      await expect(amina.page.getByTestId("knowledge-doc-trash-card")).toBeVisible({
        timeout: 20_000,
      })
      await amina.page.getByTestId("knowledge-doc-trash-restore").click()
      await expect(view(amina.page, p.id).getByTestId("knowledge-doc-body-editor")).toBeVisible({
        timeout: 15_000,
      })
      expect(await status(env, qa.admin.token, `/knowledge/documents/${p.id}`)).toBe(200)

      if (vp.name !== "1440") return

      // ── 2. The Trash list: days left, no Delete for good for a member ────
      await moveToTrash(amina.page, p.id)
      await expect(amina.page.getByTestId("knowledge-doc-trash-card")).toBeVisible({
        timeout: 15_000,
      })
      await amina.page.goto(`http://localhost:${env.ports[1]}/knowledge`)
      await amina.page.getByTestId("knowledge-sidebar-trash").click()
      const row = amina.page.getByTestId(`knowledge-trash-row-${p.id}`)
      await expect(row).toBeVisible({ timeout: 15_000 })
      await expect(row.getByTestId("knowledge-trash-days")).toHaveText("30 days left")
      await expect(row).toContainText("You,")
      await expect(amina.page.getByTestId(`knowledge-trash-delete-${p.id}`)).toHaveCount(0)
      await amina.page.getByTestId(`knowledge-trash-restore-${p.id}`).click()
      await expect(row).toHaveCount(0, { timeout: 15_000 })
      expect(await status(env, qa.admin.token, `/knowledge/documents/${p.id}`)).toBe(200)
    } finally {
      await amina.context.close()
    }

    // ── 3. An administrator deletes a page for good, after a confirm ───────
    const q = await sharedPage(env, qa.admin.token, `Old price list ${suffix}`)
    expect(await status(env, qa.admin.token, `/knowledge/documents/${q.id}/trash`, "POST")).toBe(
      200,
    )
    const admin = await signedIn(browser, env, qa.admin.email, "12345678", vp)
    try {
      await admin.page.goto(`http://localhost:${env.ports[1]}/knowledge`)
      await admin.page.getByTestId("knowledge-sidebar-trash").click()
      await admin.page.getByTestId(`knowledge-trash-delete-${q.id}`).click()
      await expect(admin.page.getByTestId("knowledge-trash-delete-dialog")).toContainText(q.title)
      await admin.page.getByTestId("knowledge-trash-delete-confirm").click()
      await expect(admin.page.getByTestId(`knowledge-trash-row-${q.id}`)).toHaveCount(0, {
        timeout: 15_000,
      })
      expect(await status(env, qa.admin.token, `/knowledge/trash/${q.id}`)).toBe(404)
      expect(await status(env, qa.admin.token, `/knowledge/documents/${q.id}`)).toBe(404)
    } finally {
      await admin.context.close()
    }
  })
}

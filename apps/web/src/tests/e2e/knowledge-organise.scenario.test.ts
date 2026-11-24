// SPDX-License-Identifier: FSL-1.1-ALv2
// Knowledge, organise: one member makes, renames, moves and deletes folders and
// a page from the tree's own rows; a second member's tree, in another browser,
// follows each change within 3 s and never shows the first one's personal
// folder. Then the same menu at phone width.
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"

const FOLLOW_MS = 3_000

async function openKnowledge(page: Page) {
  await page.getByTestId("activity-knowledge").click()
  await expect(page.getByTestId("knowledge-sidebar")).toBeVisible({ timeout: 15_000 })
}

/** A folder's label in one person's tree, by its name. */
function folderLabel(page: Page, name: string) {
  return page.locator('[data-testid^="knowledge-tree-folder-"]', {
    hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  })
}

/** The tree row id of the folder with this exact name, as one person sees it. */
async function folderId(page: Page, name: string): Promise<string> {
  const label = folderLabel(page, name)
  await expect(label).toHaveCount(1, { timeout: 10_000 })
  const testid = await label.getAttribute("data-testid")
  return (testid ?? "").replace("knowledge-tree-folder-", "")
}

async function newFolder(page: Page, section: "personal" | "shared", name: string) {
  await page.getByTestId(`knowledge-sidebar-${section}-new-folder`).click()
  const input = page.getByTestId("knowledge-folder-name-input")
  await input.fill(name)
  await page.getByTestId("knowledge-folder-dialog-confirm").click()
  await expect(input).toHaveCount(0)
}

async function rowMenu(page: Page, triggerTestId: string, item: string) {
  const trigger = page.getByTestId(triggerTestId)
  await trigger.click()
  await page.getByTestId(`knowledge-tree-menu-${item}`).click()
}

test("organise: a member's folder and page changes reach the other member's tree", async ({
  browser,
  page,
  env,
  qa,
}, testInfo) => {
  const suffix = `${testInfo.workerIndex}-${Date.now().toString(36)}`
  const personalName = `Amina only ${suffix}`
  const policies = `Policies ${suffix}`
  const rules = `Rules ${suffix}`
  const handbook = `Handbook ${suffix}`

  await page.setViewportSize({ width: 1440, height: 900 })
  await loginAs(page, env, qa.amina.email, "QaPass1!")
  await openKnowledge(page)

  const lucasContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const lucas = await lucasContext.newPage()
  try {
    await loginAs(lucas, env, qa.lucas.email, "QaPass1!")
    await openKnowledge(lucas)

    // A personal folder: Amina's alone.
    await newFolder(page, "personal", personalName)
    await expect(folderLabel(page, personalName)).toBeVisible()

    // A shared folder appears in Lucas's tree.
    await newFolder(page, "shared", policies)
    await expect(folderLabel(lucas, policies)).toBeVisible({
      timeout: FOLLOW_MS,
    })
    await newFolder(page, "shared", handbook)
    await expect(folderLabel(lucas, handbook)).toBeVisible({
      timeout: FOLLOW_MS,
    })

    // Rename it from its row menu.
    const policiesId = await folderId(page, policies)
    await rowMenu(page, `knowledge-tree-menu-${policiesId}`, "rename")
    await page.getByTestId("knowledge-folder-name-input").fill(rules)
    await page.getByTestId("knowledge-folder-dialog-confirm").click()
    await expect(folderLabel(lucas, rules)).toBeVisible({ timeout: FOLLOW_MS })
    await expect(folderLabel(lucas, policies)).toHaveCount(0)

    // A new page in it, from the row's +: it opens, marked in the tree, with
    // its breadcrumb.
    const createPage = page.waitForResponse(
      (r) => r.url().endsWith("/api/knowledge/documents") && r.request().method() === "POST",
    )
    await page.getByTestId(`knowledge-tree-new-page-${policiesId}`).click()
    const created = await createPage
    expect(created.request().postDataJSON()).toMatchObject({ collectionIds: [policiesId] })
    const docId = ((await created.json()) as { data: { id: string } }).data.id
    await expect(page.getByTestId("knowledge-breadcrumb")).toContainText(rules)
    await expect(page.getByTestId(`knowledge-tree-doc-${docId}`)).toHaveAttribute(
      "aria-current",
      "page",
    )
    await page.screenshot({
      path: testInfo.outputPath("k1b-1440-open-page.png"),
      animations: "disabled",
    })

    // Lucas sees the page in the renamed folder.
    const lucasRulesId = await folderId(lucas, rules)
    await lucas.getByTestId(`knowledge-tree-toggle-${lucasRulesId}`).click()
    await expect(lucas.getByTestId(`knowledge-tree-doc-${docId}`)).toBeVisible({
      timeout: FOLLOW_MS,
    })
    // Lucas closes it again: the page should next show up in the Handbook.
    await lucas.getByTestId(`knowledge-tree-toggle-${lucasRulesId}`).click()
    await expect(lucas.getByTestId(`knowledge-tree-doc-${docId}`)).toHaveCount(0)

    // Move it with Move to…: one request.
    const moves: string[] = []
    page.on("request", (r) => {
      if (/\/api\/knowledge\/(documents\/[^/]+\/move|collections\/[^/]+\/members)/.test(r.url()))
        moves.push(`${r.method()} ${new URL(r.url()).pathname}`)
    })
    await page.getByTestId(`knowledge-tree-doc-menu-${docId}`).first().click()
    await expect(page.getByTestId("knowledge-tree-menu-copy-link")).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath("k1b-1440-row-menu.png"),
      animations: "disabled",
    })
    await page.getByTestId("knowledge-tree-menu-move").click()
    await page.getByTestId("knowledge-move-search").fill(handbook)
    const handbookId = await folderId(page, handbook)
    await page.screenshot({
      path: testInfo.outputPath("k1b-1440-move-dialog.png"),
      animations: "disabled",
    })
    await page.getByTestId(`knowledge-move-to-${handbookId}`).click()
    await expect.poll(() => moves).toEqual([`POST /api/knowledge/documents/${docId}/move`])
    const lucasHandbookId = await folderId(lucas, handbook)
    await lucas.getByTestId(`knowledge-tree-toggle-${lucasHandbookId}`).click()
    // Only the Handbook is open in Lucas's tree.
    await expect(lucas.getByTestId(`knowledge-tree-doc-${docId}`)).toHaveCount(1, {
      timeout: FOLLOW_MS,
    })

    // Delete the renamed folder: it leaves Lucas's tree.
    await rowMenu(page, `knowledge-tree-menu-${policiesId}`, "delete")
    await expect(page.getByTestId("knowledge-folder-delete-where")).toBeVisible()
    await page.getByTestId("knowledge-folder-dialog-confirm").click()
    await expect(folderLabel(lucas, rules)).toHaveCount(0, {
      timeout: FOLLOW_MS,
    })

    // Never, at any point: Amina's personal folder in Lucas's tree.
    await expect(folderLabel(lucas, personalName)).toHaveCount(0)
    await lucas.reload()
    await openKnowledge(lucas)
    await expect(folderLabel(lucas, handbook)).toBeVisible()
    await expect(folderLabel(lucas, personalName)).toHaveCount(0)
  } finally {
    await lucasContext.close()
  }
})

test("organise at 390: the row menu renames a folder from the phone navigator", async ({
  browser,
  page,
  env,
  qa,
}, testInfo) => {
  const suffix = `${testInfo.workerIndex}-${Date.now().toString(36)}`
  const before = `Returns ${suffix}`
  const after = `Refunds ${suffix}`

  await page.setViewportSize({ width: 390, height: 844 })
  await loginAs(page, env, qa.amina.email, "QaPass1!")
  const lucasContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const lucas = await lucasContext.newPage()
  try {
    await loginAs(lucas, env, qa.lucas.email, "QaPass1!")
    await openKnowledge(lucas)

    // Amina at phone width: Knowledge, then the navigator sheet.
    await page.goto(`http://localhost:${env.ports[1]}/knowledge`)
    await page.getByTestId("phone-navigator-opener").click()
    await expect(page.getByTestId("knowledge-sidebar")).toBeVisible({ timeout: 15_000 })
    await newFolder(page, "shared", before)
    await expect(folderLabel(lucas, before)).toBeVisible({ timeout: FOLLOW_MS })

    if (!(await page.getByTestId("knowledge-sidebar").isVisible())) {
      await page.getByTestId("phone-navigator-opener").click()
    }
    const id = await folderId(page, before)
    // On touch the row's buttons are always there, at a finger's size.
    const trigger = page.getByTestId(`knowledge-tree-menu-${id}`)
    await expect(trigger).toBeVisible()
    const box = await trigger.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    await trigger.click()
    await expect(page.getByTestId("knowledge-tree-menu-rename")).toBeVisible()
    // The menu opened over the navigator, which is still there.
    await expect(page.getByTestId("knowledge-sidebar")).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath("k1b-390-row-menu.png"),
      animations: "disabled",
    })
    await page.getByTestId("knowledge-tree-menu-rename").click()
    await page.getByTestId("knowledge-folder-name-input").fill(after)
    await page.getByTestId("knowledge-folder-dialog-confirm").click()
    await expect(folderLabel(lucas, after)).toBeVisible({ timeout: FOLLOW_MS })
  } finally {
    await lucasContext.close()
  }
})

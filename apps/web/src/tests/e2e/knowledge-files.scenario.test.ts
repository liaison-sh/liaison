// SPDX-License-Identifier: FSL-1.1-ALv2
// Images and files in a Knowledge page (S11, edge 9), headless, at 1440 and 390.
//
// Elodie (the admin, who holds the Attachments scopes) adds a picture with the Image
// tool: it is stored on the page, survives a reload and shows for Lucas, who may only
// read the page. She removes it from the text: the file stays listed under
// Attachments. She adds a file with "Add a file": listed, not put in the text. Lucas
// has no add control.

import type { Browser, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { createKnowledgeDocument, TINY_PNG } from "./helpers/knowledge-seed"

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
  password = "QaPass1!",
) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await context.newPage()
  await loginAs(page, env, email, password)
  return { context, page }
}

async function storedBody(env: Env, token: string, docId: string): Promise<string> {
  const res = await fetch(`${env.serverUrl}/api/knowledge/documents/${docId}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return ((await res.json()) as { data: { body: string } }).data.body
}

/** The page's Attachments: inline at desktop width, in the Sources sheet on a phone. */
async function attachments(page: Page, docId: string, phone: boolean) {
  if (phone) await view(page, docId).getByTestId("knowledge-doc-sources-open").click()
  return page.getByTestId("knowledge-attachment-list").last()
}

for (const vp of VIEWPORTS) {
  test(`[Knowledge] images and files on a page (${vp.name})`, async ({ browser, env, qa }) => {
    test.setTimeout(180_000)
    const phone = vp.width < 600
    const suffix = `${env.schemaPrefix.replace(/_$/, "")}-${vp.name}`
    // Elodie's page, which everyone may read and only she may edit.
    const doc = await createKnowledgeDocument(env, qa.admin.token, {
      title: `Return labels ${suffix}`,
      body: "How to print a return label.",
      documentScope: "organization",
      orgAccess: "viewer",
    })
    const elodie = await signedIn(browser, env, "admin@test.com", vp, "12345678")
    const lucas = await signedIn(browser, env, qa.lucas.email, vp)
    try {
      const url = `http://localhost:${env.ports[1]}/knowledge/documents/${doc.id}`
      await elodie.page.goto(url)
      const field = view(elodie.page, doc.id).getByTestId("knowledge-doc-body-editor")
      await expect(field).toBeVisible({ timeout: 20_000 })
      await field.click()
      await elodie.page.keyboard.press("ControlOrMeta+End")

      // The Image tool opens this picker; the file goes where the caret is.
      await view(elodie.page, doc.id)
        .getByTestId("rich-editor.pick-image")
        .setInputFiles({ name: "label.png", mimeType: "image/png", buffer: TINY_PNG })
      await expect(field.getByTestId("liaison-file-image")).toHaveAttribute("src", /^blob:/, {
        timeout: 20_000,
      })
      await expect(view(elodie.page, doc.id).getByTestId("save-state")).toHaveAttribute(
        "data-state",
        "saved",
        { timeout: 15_000 },
      )
      const body = await storedBody(env, qa.admin.token, doc.id)
      const fileId = /!\[\]\(liaison-file:([0-9a-f-]{36})\)/.exec(body)?.[1]
      expect(fileId).toBeTruthy()

      // It survives a reload.
      await elodie.page.reload()
      await expect(field.getByTestId("liaison-file-image")).toHaveAttribute("src", /^blob:/, {
        timeout: 20_000,
      })

      // Lucas reads the page: the picture shows, and there is no add control.
      await lucas.page.goto(url)
      const rendered = view(lucas.page, doc.id).getByTestId("knowledge-doc-body-rendered")
      await expect(rendered.getByTestId("liaison-file-image")).toHaveAttribute("src", /^blob:/, {
        timeout: 20_000,
      })
      await expect(lucas.page.getByTestId("knowledge-attachment-add")).toHaveCount(0)

      // Elodie removes the picture from the text: the file stays under Attachments.
      await field.getByTestId("liaison-file-image").click()
      await elodie.page.keyboard.press("Backspace")
      await expect(field.getByTestId("liaison-file")).toHaveCount(0)
      await expect(view(elodie.page, doc.id).getByTestId("save-state")).toHaveAttribute(
        "data-state",
        "saved",
        { timeout: 15_000 },
      )
      await expect
        .poll(() => storedBody(env, qa.admin.token, doc.id), { timeout: 15_000 })
        .not.toContain("liaison-file:")
      const files = await attachments(elodie.page, doc.id, phone)
      await expect(files.getByTestId(`file-list-item-${fileId}`)).toBeVisible({ timeout: 15_000 })

      // "Add a file": stored on the page and listed, never put in the text.
      await files
        .getByTestId("knowledge-attachment-input")
        .setInputFiles({ name: "terms.txt", mimeType: "text/plain", buffer: Buffer.from("terms") })
      await expect(files.locator('[data-testid^="file-list-item-"]')).toHaveCount(2, {
        timeout: 20_000,
      })
      expect(await storedBody(env, qa.admin.token, doc.id)).not.toContain("liaison-file:")
    } finally {
      await elodie.context.close()
      await lucas.context.close()
    }
  })
}

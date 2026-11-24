// SPDX-License-Identifier: FSL-1.1-ALv2
// A folder opened as a page (S20), two people, headless, at 1440 and 390.
//
// Amina's shared folder holds a subfolder, a page everyone reads and a page only she
// may open. She opens the folder: the list shows all three, each opening its tab.
// She writes the folder's first text: one page is made, saved by itself, and back
// after a reload. Lucas opens the folder: the text, the subfolder and the page he
// may read; the page he may not is named nowhere he can see or received.

import type { Browser, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { createKnowledgeDocument } from "./helpers/knowledge-seed"

type Env = Parameters<typeof createKnowledgeDocument>[0]

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const

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

async function api<T>(env: Env, token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${env.serverUrl}/api/knowledge${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, data: ((await res.json()) as { data: T }).data }
}

/** Everything the browser received: response bodies and WebSocket frames. */
function recordTraffic(page: Page): () => Promise<string> {
  const pending: Array<Promise<string>> = []
  page.on("response", (res) => {
    pending.push(res.text().catch(() => ""))
  })
  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      pending.push(Promise.resolve(String(frame.payload)))
    })
  })
  return async () => (await Promise.all(pending)).join("\n")
}

for (const vp of VIEWPORTS) {
  test(`[Knowledge] folder pages between two people (${vp.name})`, async ({ browser, env, qa }) => {
    test.setTimeout(180_000)
    const suffix = `${env.schemaPrefix.replace(/_$/, "")}-${vp.name}`
    const folder = await api<{ id: string }>(env, qa.amina.token, "POST", "/collections", {
      name: `Policies ${suffix}`,
      ownerUserId: null,
    })
    expect(folder.status).toBe(201)
    const sub = await api<{ id: string }>(env, qa.amina.token, "POST", "/collections", {
      name: `Returns ${suffix}`,
      ownerUserId: null,
      parentCollectionId: folder.data.id,
    })
    const open = await createKnowledgeDocument(env, qa.amina.token, {
      title: `Refund rules ${suffix}`,
      documentScope: "organization",
      orgAccess: "viewer",
      collectionIds: [folder.data.id],
    })
    const secret = await createKnowledgeDocument(env, qa.amina.token, {
      title: `Quokka margins ${suffix}`,
      documentScope: "organization",
      orgAccess: "none",
      collectionIds: [folder.data.id],
    })
    const amina = await signedIn(browser, env, qa.amina.email, vp)
    const lucas = await signedIn(browser, env, qa.lucas.email, vp)
    const url = `http://localhost:${env.ports[1]}/knowledge/folders/${folder.data.id}`
    try {
      // ── Amina: the folder name in the sidebar opens it (desktop), or its address ──
      if (vp.width >= 1024) {
        await amina.page.goto(`http://localhost:${env.ports[1]}/knowledge`)
        await amina.page
          .getByTestId(`knowledge-tree-folder-${folder.data.id}`)
          .click({ timeout: 20_000 })
      } else await amina.page.goto(url)
      const folderView = amina.page.locator(
        `[data-testid="knowledge-folder-view"][data-folder-id="${folder.data.id}"]`,
      )
      await expect(folderView).toBeVisible({ timeout: 20_000 })
      await expect(
        folderView.getByTestId(`knowledge-folder-item-folder-${sub.data.id}`),
      ).toBeVisible()
      await expect(folderView.getByTestId(`knowledge-folder-item-page-${open.id}`)).toBeVisible()
      await expect(folderView.getByTestId(`knowledge-folder-item-page-${secret.id}`)).toBeVisible()

      // She writes its first text: one page, saved by itself.
      const start = folderView.getByTestId("knowledge-folder-start-editor")
      await expect(start).toBeVisible({ timeout: 20_000 })
      await start.click()
      await amina.page.keyboard.type("What we promise customers.")
      const body = folderView.getByTestId("knowledge-doc-body-editor")
      await expect(body).toBeVisible({ timeout: 15_000 })
      await expect(folderView.getByTestId("save-state")).toHaveAttribute("data-state", "saved", {
        timeout: 15_000,
      })
      const made = await api<{ page: { id: string; body: string } | null }>(
        env,
        qa.amina.token,
        "GET",
        `/collections/${folder.data.id}/page`,
      )
      expect(made.data.page?.body).toBe("What we promise customers.")
      await amina.page.reload()
      await expect(folderView.getByTestId("knowledge-doc-body-editor")).toContainText(
        "What we promise customers.",
        { timeout: 20_000 },
      )
      // The folder's own page is the text, not a row of the list.
      await expect(
        folderView.getByTestId(`knowledge-folder-item-page-${made.data.page?.id}`),
      ).toHaveCount(0)

      // A row opens its page.
      await folderView.getByTestId(`knowledge-folder-item-page-${open.id}`).click()
      await expect(
        amina.page.locator(
          `[data-testid="knowledge-document-view"][data-document-id="${open.id}"]`,
        ),
      ).toBeVisible({ timeout: 15_000 })

      // ── Lucas: the text and what he may open, nothing else ─────────────────
      const traffic = recordTraffic(lucas.page)
      await lucas.page.goto(url)
      const his = lucas.page.locator(
        `[data-testid="knowledge-folder-view"][data-folder-id="${folder.data.id}"]`,
      )
      await expect(his.getByTestId(`knowledge-folder-item-page-${open.id}`)).toBeVisible({
        timeout: 20_000,
      })
      await expect(his.getByTestId(`knowledge-folder-item-folder-${sub.data.id}`)).toBeVisible()
      await expect(his).toContainText("What we promise customers.")
      await expect(his.getByTestId(`knowledge-folder-item-page-${secret.id}`)).toHaveCount(0)
      await lucas.page.waitForTimeout(1_000)
      expect(await lucas.page.content()).not.toContain("Quokka")
      expect(await traffic()).not.toContain("Quokka")
    } finally {
      await amina.context.close()
      await lucas.context.close()
    }
  })
}

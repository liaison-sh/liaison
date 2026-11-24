// SPDX-License-Identifier: FSL-1.1-ALv2
// Links between Knowledge pages (S13, S14), two people, headless, at 1440 and 390.
//
// Amina has a page only she may open ("Zephyr returns ...") and a page Lucas may read
// ("Policies ..."). In Policies she types `@Zephyr`, picks her page from the picker:
// the stored text holds the page id only, her chip shows the title, survives a
// reload and opens the page. Lucas opens Policies: the chip reads "Page you cannot
// open", and the title is nowhere in his DOM, nor in any response or WebSocket frame
// his browser received. Amina renames her page: the chip follows at once. Her page
// lists Policies under "Linked from", and the row opens it.

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

async function stored(env: Env, token: string, docId: string) {
  const res = await fetch(`${env.serverUrl}/api/knowledge/documents/${docId}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return ((await res.json()) as { data: { body: string; title: string; revision: number } }).data
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
  test(`[Knowledge] page links between two people (${vp.name})`, async ({ browser, env, qa }) => {
    test.setTimeout(180_000)
    const suffix = `${env.schemaPrefix.replace(/_$/, "")}-${vp.name}`
    const secretTitle = `Zephyr returns ${suffix}`
    // Only Amina may open it.
    const secret = await createKnowledgeDocument(env, qa.amina.token, {
      title: secretTitle,
      body: "Internal steps.",
      documentScope: "organization",
      orgAccess: "none",
    })
    // Everyone may read it; Amina writes it.
    const policies = await createKnowledgeDocument(env, qa.amina.token, {
      title: `Policies ${suffix}`,
      body: "Our policies.",
      documentScope: "organization",
      orgAccess: "viewer",
    })
    const amina = await signedIn(browser, env, qa.amina.email, vp)
    const lucas = await signedIn(browser, env, qa.lucas.email, vp)
    const base = `http://localhost:${env.ports[1]}/knowledge/documents`
    try {
      // ── Amina links her page with `@` ────────────────────────────────────
      await amina.page.goto(`${base}/${policies.id}`)
      const field = view(amina.page, policies.id).getByTestId("knowledge-doc-body-editor")
      await expect(field).toBeVisible({ timeout: 20_000 })
      await field.click()
      await amina.page.keyboard.press("ControlOrMeta+End")
      await amina.page.keyboard.type(" See @Zephyr")
      const option = amina.page.getByTestId("page-suggest-item").filter({ hasText: secretTitle })
      await expect(option).toBeVisible({ timeout: 10_000 })
      await amina.page.keyboard.press("Enter")
      const chip = field.locator(`[data-page-link="${secret.id}"]`)
      await expect(chip).toHaveText(secretTitle)
      await expect(view(amina.page, policies.id).getByTestId("save-state")).toHaveAttribute(
        "data-state",
        "saved",
        { timeout: 15_000 },
      )
      const saved = await stored(env, qa.amina.token, policies.id)
      expect(saved.body).toContain(`[](knowledge:document:${secret.id})`)
      expect(saved.body).not.toContain("Zephyr")

      // It survives a reload, and a click opens the page.
      await amina.page.reload()
      await expect(chip).toHaveText(secretTitle, { timeout: 20_000 })
      await chip.click()
      await expect(view(amina.page, secret.id)).toBeVisible({ timeout: 15_000 })

      // ── Lucas reads Policies: no title, anywhere ─────────────────────────
      const traffic = recordTraffic(lucas.page)
      await lucas.page.goto(`${base}/${policies.id}`)
      const rendered = view(lucas.page, policies.id).getByTestId("knowledge-doc-body-rendered")
      const lucasChip = rendered.locator(`[data-page-link="${secret.id}"]`)
      await expect(lucasChip).toHaveText("Page you cannot open", { timeout: 20_000 })
      await expect(lucasChip).toHaveAttribute("data-state", "unavailable")
      await lucasChip.click()
      await expect(view(lucas.page, secret.id)).toHaveCount(0)
      expect(await lucas.page.content()).not.toContain("Zephyr")

      // ── Amina renames her page: her chip follows at once ─────────────────
      await amina.page.goto(`${base}/${policies.id}`)
      await expect(chip).toHaveText(secretTitle, { timeout: 20_000 })
      const before = await stored(env, qa.amina.token, secret.id)
      const renamed = `Zephyr refunds ${suffix}`
      const res = await fetch(`${env.serverUrl}/api/knowledge/documents/${secret.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${qa.amina.token}`, "content-type": "application/json" },
        body: JSON.stringify({ title: renamed, revision: before.revision }),
      })
      expect(res.status).toBe(200)
      await expect(chip).toHaveText(renamed, { timeout: 15_000 })

      // Lucas still received nothing naming her page, old name or new.
      await lucas.page.waitForTimeout(1_500)
      const received = await traffic()
      expect(received).not.toContain("Zephyr")
      expect(await lucas.page.content()).not.toContain("Zephyr")

      // ── Her page lists Policies under "Linked from" ──────────────────────
      await amina.page.goto(`${base}/${secret.id}`)
      const refs = view(amina.page, secret.id).getByTestId("knowledge-backlinks-button")
      await expect(refs).toBeVisible({ timeout: 20_000 })
      await refs.click()
      const row = amina.page
        .getByTestId("knowledge-backlink-page")
        .filter({ hasText: `Policies ${suffix}` })
      await expect(row).toBeVisible()
      await row.click()
      await expect(view(amina.page, policies.id)).toBeVisible({ timeout: 15_000 })
    } finally {
      await amina.context.close()
      await lucas.context.close()
    }
  })
}

// SPDX-License-Identifier: FSL-1.1-ALv2
// Knowledge autosave and Page history (S6 to S8, S18, D7), headless, at 1440 and 390.
//
// No text is lost when two writers meet on one page:
//   1. two people: the second gets the conflict and leaves; both texts are found
//      afterwards, and the first restores the second's from Page history;
//   2. ONE person in two tabs, conflict, Keep mine: both texts in history;
//   3. two tabs of one person both left in conflict: both texts in history;
//   4. a tab reloads while the other types: no conflict with itself.
// What the server holds is read back through the version routes.

import type { Browser, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { createKnowledgeDocument } from "./helpers/knowledge-seed"

type Env = Parameters<typeof createKnowledgeDocument>[0]

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const

async function apiGet<T>(env: Env, token: string, path: string): Promise<T> {
  const res = await fetch(`${env.serverUrl}/api${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status !== 200) throw new Error(`GET ${path}: HTTP ${res.status}`)
  return ((await res.json()) as { data: T }).data
}

/** Every text the page has had: its current text and each version's. */
async function allTexts(env: Env, token: string, docId: string): Promise<string[]> {
  const page = await apiGet<{ body: string }>(env, token, `/knowledge/documents/${docId}`)
  const versions = await apiGet<{ id: string }[]>(
    env,
    token,
    `/knowledge/documents/${docId}/versions`,
  )
  const bodies = await Promise.all(
    versions.map(
      async (v) =>
        (
          await apiGet<{ body: string }>(
            env,
            token,
            `/knowledge/documents/${docId}/versions/${v.id}`,
          )
        ).body,
    ),
  )
  return [page.body, ...bodies]
}

async function expectTextsKept(env: Env, token: string, docId: string, texts: string[]) {
  await expect
    .poll(
      async () => {
        const all = (await allTexts(env, token, docId)).join("\n----\n")
        return texts.filter((t) => !all.includes(t))
      },
      { timeout: 20_000 },
    )
    .toEqual([])
}

/** A shared page everyone in the organization may edit. */
async function sharedPage(env: Env, token: string, title: string) {
  return createKnowledgeDocument(env, token, {
    title,
    body: "Start of the procedure.",
    documentScope: "organization",
    orgAccess: "editor",
  })
}

/** The view of one page (other pages stay open in hidden tabs). */
function view(page: Page, docId: string) {
  return page.locator(`[data-testid="knowledge-document-view"][data-document-id="${docId}"]`)
}

async function openPage(page: Page, env: Env, docId: string) {
  await page.goto(`http://localhost:${env.ports[1]}/knowledge/documents/${docId}`)
  await expect(view(page, docId).getByTestId("knowledge-doc-body-editor")).toBeVisible({
    timeout: 20_000,
  })
}

/** Type at the end of the page's text. */
async function typeAtEnd(page: Page, docId: string, text: string) {
  const field = view(page, docId).getByTestId("knowledge-doc-body-editor")
  await field.click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(text)
}

async function expectSaved(page: Page, docId: string) {
  await expect(view(page, docId).getByTestId("save-state")).toHaveAttribute("data-state", "saved", {
    timeout: 15_000,
  })
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
  test(`[Knowledge] autosave keeps every text when writers meet (${vp.name})`, async ({
    browser,
    env,
    qa,
  }) => {
    test.setTimeout(240_000)
    const suffix = `${env.schemaPrefix.replace(/_$/, "")}-${vp.name}`
    const amina = await signedIn(browser, env, qa.amina.email, "QaPass1!", vp)
    const lucas = await signedIn(browser, env, qa.lucas.email, "QaPass1!", vp)
    try {
      // ── 1. Two people ────────────────────────────────────────────────────
      const p1 = await sharedPage(env, qa.admin.token, `Returns ${suffix}`)
      await openPage(amina.page, env, p1.id)
      await openPage(lucas.page, env, p1.id)
      // No Edit, no Save: the text is editable at once.
      await expect(view(amina.page, p1.id).getByTestId("knowledge-doc-edit")).toHaveCount(0)
      await expect(view(amina.page, p1.id).getByTestId("knowledge-doc-save")).toHaveCount(0)

      // They write at the same time: Lucas's connection drops while he types, so
      // Amina's save reaches the server first and his own save meets it.
      await lucas.context.setOffline(true)
      await typeAtEnd(lucas.page, p1.id, " Lucas wrote this second.")
      await typeAtEnd(amina.page, p1.id, " Amina wrote this first.")
      await expectSaved(amina.page, p1.id)
      await lucas.context.setOffline(false)
      await expect(
        view(lucas.page, p1.id).getByTestId("knowledge-doc-conflict-banner"),
      ).toBeVisible({
        timeout: 15_000,
      })
      await expect(view(lucas.page, p1.id).getByTestId("save-state")).toHaveAttribute(
        "data-state",
        "conflict",
      )
      // Lucas leaves with the conflict open (D7): his text goes to Page history.
      await lucas.page.reload()
      await expectTextsKept(env, qa.amina.token, p1.id, [
        "Amina wrote this first.",
        "Lucas wrote this second.",
      ])

      // Amina finds Lucas's text in Page history and restores it.
      await view(amina.page, p1.id).getByTestId("knowledge-doc-menu").click()
      await amina.page.getByTestId("knowledge-doc-history").click()
      await expect(view(amina.page, p1.id).getByTestId("page-history")).toBeVisible()
      const lucasVersion = amina.page
        .getByTestId("history-version")
        .filter({ hasText: /Lucas/ })
        .first()
      await lucasVersion.click()
      await expect(view(amina.page, p1.id).getByTestId("history-diff")).toContainText(
        "Lucas wrote this second.",
      )
      await view(amina.page, p1.id).getByTestId("history-restore").click()
      await amina.page.getByTestId("history-restore-confirm").click()
      await expect(view(amina.page, p1.id).getByTestId("page-history")).toHaveCount(0)
      await expect(view(amina.page, p1.id).getByTestId("knowledge-doc-body-editor")).toContainText(
        "Lucas wrote this second.",
      )
      await expectTextsKept(env, qa.amina.token, p1.id, [
        "Amina wrote this first.",
        "Lucas wrote this second.",
      ])

      // ── 2. One person, two tabs, Keep mine ──────────────────────────────
      const p2 = await sharedPage(env, qa.admin.token, `Warranty ${suffix}`)
      const tab2 = await amina.context.newPage()
      await openPage(amina.page, env, p2.id)
      await openPage(tab2, env, p2.id)
      // Both tabs type before either save: the first save wins, the second meets it.
      await typeAtEnd(amina.page, p2.id, " First tab text.")
      await typeAtEnd(tab2, p2.id, " Second tab text.")
      await expectSaved(amina.page, p2.id)
      await expect(view(tab2, p2.id).getByTestId("knowledge-doc-conflict-banner")).toBeVisible({
        timeout: 15_000,
      })
      await view(tab2, p2.id).getByTestId("conflict-open").click()
      await tab2.getByTestId("conflict-mine").click()
      await expectSaved(tab2, p2.id)
      await expectTextsKept(env, qa.amina.token, p2.id, ["First tab text.", "Second tab text."])

      // ── 3. Two tabs of one person both left in conflict ─────────────────
      const p3 = await sharedPage(env, qa.admin.token, `Shipping ${suffix}`)
      await openPage(amina.page, env, p3.id)
      await openPage(tab2, env, p3.id)
      // Both tabs type offline while someone else saves first.
      await openPage(lucas.page, env, p3.id)
      await amina.context.setOffline(true)
      await typeAtEnd(amina.page, p3.id, " Left in tab one.")
      await typeAtEnd(tab2, p3.id, " Left in tab two.")
      await typeAtEnd(lucas.page, p3.id, " Lucas saved meanwhile.")
      await expectSaved(lucas.page, p3.id)
      await amina.context.setOffline(false)
      await expect(
        view(amina.page, p3.id).getByTestId("knowledge-doc-conflict-banner"),
      ).toBeVisible({
        timeout: 15_000,
      })
      await expect(view(tab2, p3.id).getByTestId("knowledge-doc-conflict-banner")).toBeVisible({
        timeout: 15_000,
      })
      await amina.page.reload()
      await tab2.reload()
      await expectTextsKept(env, qa.amina.token, p3.id, [
        "Lucas saved meanwhile.",
        "Left in tab one.",
        "Left in tab two.",
      ])

      // ── 4. A tab reloads while the other types: no conflict with itself ─
      const p4 = await sharedPage(env, qa.admin.token, `Onboarding ${suffix}`)
      await openPage(amina.page, env, p4.id)
      await openPage(tab2, env, p4.id)
      await typeAtEnd(amina.page, p4.id, " Typing on.")
      await tab2.reload()
      await expect(view(tab2, p4.id).getByTestId("knowledge-doc-body-editor")).toBeVisible({
        timeout: 20_000,
      })
      await typeAtEnd(amina.page, p4.id, " Still typing.")
      await expectSaved(amina.page, p4.id)
      await expect(
        view(amina.page, p4.id).getByTestId("knowledge-doc-conflict-banner"),
      ).toHaveCount(0)
      await expect(view(tab2, p4.id).getByTestId("knowledge-doc-conflict-banner")).toHaveCount(0)
      await expect(view(tab2, p4.id).getByTestId("knowledge-doc-body-editor")).toContainText(
        "Still typing.",
        {
          timeout: 15_000,
        },
      )
      await expectTextsKept(env, qa.amina.token, p4.id, ["Typing on. Still typing."])
    } finally {
      await amina.context.close()
      await lucas.context.close()
    }
  })
}

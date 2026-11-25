// SPDX-License-Identifier: FSL-1.1-ALv2
// No page makes the browser request another host (S12, D5), headless.
//
// A hostile page holds every way a text could load something: a web image in
// markdown, raw HTML `img`, `<picture>`, CSS `url()`, SVG with an href, `data:` in
// odd places, a token whose value is a URL, and file tokens naming a file of another
// page the reader cannot open and a file of no page of this organization. Every
// request of the browser is recorded while it is shown in the editor, in the reader,
// in Page history and its comparison, in search results and in the conflict dialog,
// and while web HTML is pasted into the editor. Every request goes to the app's own
// origins, and a file's bytes come only through the authenticated inline route.
// A control at the end proves the recorder sees a request to another host.

import type { Browser, BrowserContext, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import {
  createKnowledgeDocument,
  searchKnowledge,
  TINY_PNG,
  uploadPageFileApi,
} from "./helpers/knowledge-seed"

type Env = Parameters<typeof createKnowledgeDocument>[0]

const EVIL = "evil.example"
const NO_SUCH_FILE = "99999999-9999-4999-8999-999999999999"

function hostileBody(marker: string, ownFile: string, privateFile: string): string {
  return [
    `# Hostile ${marker}`,
    `Searchable ${marker} text.`,
    `![web](https://${EVIL}/md.png)`,
    `<img src="https://${EVIL}/raw.png" srcset="https://${EVIL}/set.png 2x">`,
    `<picture><source srcset="https://${EVIL}/pic.png"><img src="https://${EVIL}/pic2.png"></picture>`,
    `<p style="background-image:url(https://${EVIL}/css.png)">styled</p>`,
    `<svg><image href="https://${EVIL}/svg.png"/></svg>`,
    `![svg](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=)`,
    `<span data-page-file="https://${EVIL}/span.png">bad span</span>`,
    `<style>body{background:url(https://${EVIL}/style.png)}</style>`,
    `<link rel="stylesheet" href="https://${EVIL}/x.css">`,
    `<iframe src="https://${EVIL}/frame"></iframe>`,
    `Own file: ![](liaison-file:${ownFile})`,
    `Private page's file: ![](liaison-file:${privateFile})`,
    `No such file: ![](liaison-file:${NO_SUCH_FILE})`,
  ].join("\n\n")
}

const PASTED_HTML = [
  `<p>Pasted <img src="https://${EVIL}/paste.png"></p>`,
  `<picture><source srcset="https://${EVIL}/paste-pic.png"><img src="https://${EVIL}/paste-pic2.png"></picture>`,
  `<div style="background:url(https://${EVIL}/paste-css.png)">bg</div>`,
  `<svg><image href="https://${EVIL}/paste-svg.png"/></svg>`,
  `<img src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><image href='https://${EVIL}/data-svg.png'/></svg>">`,
].join("")

/** Every request any page of the context makes, with what it fetched. */
function record(context: BrowserContext, into: string[]) {
  context.on("request", (req) => into.push(req.url()))
  context.on("page", (page) => page.on("websocket", (ws) => into.push(ws.url())))
}

async function signedIn(browser: Browser, env: Env, email: string, log: string[]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  record(context, log)
  const page = await context.newPage()
  page.on("websocket", (ws) => log.push(ws.url()))
  await loginAs(page, env, email, "QaPass1!")
  return { context, page }
}

function view(page: Page, docId: string) {
  return page.locator(`[data-testid="knowledge-document-view"][data-document-id="${docId}"]`)
}

/** Inside the page's view, no element the browser fetches from: only this app's blobs. */
async function expectNothingFetchable(page: Page, docId: string) {
  const found = await view(page, docId).evaluate((root) => {
    const out: string[] = []
    for (const el of root.querySelectorAll("*")) {
      for (const attr of ["src", "srcset", "poster", "background", "data"]) {
        const v = el.getAttribute(attr)
        if (v && !(attr === "src" && v.startsWith("blob:"))) out.push(`${el.tagName}[${attr}]=${v}`)
      }
      const href = el.getAttribute("href")
      if (href && el.tagName !== "A") out.push(`${el.tagName}[href]=${href}`)
      if (/url\(/i.test(el.getAttribute("style") ?? "")) out.push(`${el.tagName}[style]`)
      if (["STYLE", "LINK", "IFRAME", "OBJECT", "EMBED", "PICTURE", "VIDEO"].includes(el.tagName))
        out.push(el.tagName)
    }
    return out
  })
  expect(found).toEqual([])
}

async function apiPatch(env: Env, token: string, docId: string, body: string, revision: number) {
  const res = await fetch(`${env.serverUrl}/api/knowledge/documents/${docId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ body, revision }),
  })
  if (res.status !== 200) throw new Error(`PATCH: HTTP ${res.status} ${await res.text()}`)
  return ((await res.json()) as { data: { revision: number } }).data
}

async function waitIndexed(env: Env, token: string, docId: string, q: string) {
  await expect
    .poll(
      async () => {
        const res = await searchKnowledge(env, token, q).catch(() => null)
        return !!res?.hits.some((h) => h.sourceEntityId === docId)
      },
      { timeout: 30_000 },
    )
    .toBe(true)
}

test("[Knowledge] a hostile page makes no request to another host", async ({
  browser,
  env,
  qa,
}) => {
  test.setTimeout(240_000)
  const marker = `noegress${env.schemaPrefix.replace(/[^a-z0-9]/gi, "")}`
  // A private page of the admin, with a picture nobody else may read.
  const priv = await createKnowledgeDocument(env, qa.admin.token, {
    title: `Private ${marker}`,
    body: "private",
    documentScope: "organization",
    orgAccess: "none",
  })
  const privateFile = await uploadPageFileApi(env, qa.admin.token, priv.id, {
    name: "secret.png",
    mimeType: "image/png",
    bytes: TINY_PNG,
  })
  // The hostile page everyone may edit, with a picture of its own; and a copy
  // everyone may only read.
  const hostile = await createKnowledgeDocument(env, qa.admin.token, {
    title: `Hostile ${marker}`,
    body: "draft",
    documentScope: "organization",
    orgAccess: "editor",
  })
  const ownFile = await uploadPageFileApi(env, qa.admin.token, hostile.id, {
    name: "own.png",
    mimeType: "image/png",
    bytes: TINY_PNG,
  })
  const body = hostileBody(marker, ownFile, privateFile)
  // Written by Amina, who cannot read the private page's file: its token is kept as
  // it is (a writer who can read it would have the save copy it onto this page).
  await apiPatch(env, qa.amina.token, hostile.id, body, hostile.revision)
  const readOnly = await createKnowledgeDocument(env, qa.amina.token, {
    title: `Hostile read only ${marker}`,
    body: hostileBody(marker, ownFile, privateFile),
    documentScope: "organization",
    orgAccess: "viewer",
  })

  const log: string[] = []
  const amina = await signedIn(browser, env, qa.amina.email, log)
  const lucas = await signedIn(browser, env, qa.lucas.email, log)
  try {
    // ── The editor ─────────────────────────────────────────────────────────
    await amina.page.goto(`http://localhost:${env.ports[1]}/knowledge/documents/${hostile.id}`)
    const field = view(amina.page, hostile.id).getByTestId("knowledge-doc-body-editor")
    await expect(field).toBeVisible({ timeout: 20_000 })
    // The page's own picture is drawn (from a blob); the others say they are not available.
    await expect(field.getByTestId("liaison-file-image")).toHaveAttribute("src", /^blob:/, {
      timeout: 15_000,
    })
    await expect(field.getByTestId("liaison-file-unavailable")).toHaveCount(2)
    await expectNothingFetchable(amina.page, hostile.id)

    // Web HTML pasted into the editor.
    await field.click()
    await amina.page.keyboard.press("ControlOrMeta+End")
    await field.evaluate((el, html) => {
      const data = new DataTransfer()
      data.setData("text/html", html)
      data.setData("text/plain", "Pasted")
      el.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      )
    }, PASTED_HTML)
    await expect(field).toContainText("Pasted")
    await expectNothingFetchable(amina.page, hostile.id)
    await expect(view(amina.page, hostile.id).getByTestId("save-state")).toHaveAttribute(
      "data-state",
      "saved",
      { timeout: 15_000 },
    )

    // ── Page history and its comparison ────────────────────────────────────
    await view(amina.page, hostile.id).getByTestId("knowledge-doc-menu").click()
    await amina.page.getByTestId("knowledge-doc-history").click()
    await expect(view(amina.page, hostile.id).getByTestId("page-history")).toBeVisible()
    const versions = amina.page.getByTestId("history-version")
    await expect(versions.first()).toBeVisible()
    for (let i = 0; i < Math.min(await versions.count(), 3); i++) {
      await versions.nth(i).click()
      await expect(view(amina.page, hostile.id).getByTestId("history-diff")).toBeVisible()
      await expectNothingFetchable(amina.page, hostile.id)
    }

    // ── The reader ─────────────────────────────────────────────────────────
    await lucas.page.goto(`http://localhost:${env.ports[1]}/knowledge/documents/${readOnly.id}`)
    const rendered = view(lucas.page, readOnly.id).getByTestId("knowledge-doc-body-rendered")
    await expect(rendered).toBeVisible({ timeout: 20_000 })
    await expect(rendered.getByTestId("liaison-file-image")).toHaveAttribute("src", /^blob:/, {
      timeout: 15_000,
    })
    await expect(rendered.getByTestId("liaison-file-unavailable")).toHaveCount(2)
    await expectNothingFetchable(lucas.page, readOnly.id)

    // ── Search results ─────────────────────────────────────────────────────
    await waitIndexed(env, qa.lucas.token, readOnly.id, marker)
    await lucas.page.getByTestId("activity-knowledge").click()
    await lucas.page.getByTestId("knowledge-sidebar-search-input").fill(marker)
    await expect(
      lucas.page.getByTestId(`knowledge-search-result-document-${readOnly.id}`),
    ).toBeVisible({ timeout: 15_000 })
    const snippets = await lucas.page
      .locator('[data-testid^="knowledge-search-result-document-"]')
      .allInnerTexts()
    for (const s of snippets) expect(s).not.toContain("liaison-file:")

    // ── The conflict dialog ────────────────────────────────────────────────
    await lucas.page.goto(`http://localhost:${env.ports[1]}/knowledge/documents/${hostile.id}`)
    const lucasField = view(lucas.page, hostile.id).getByTestId("knowledge-doc-body-editor")
    await expect(lucasField).toBeVisible({ timeout: 20_000 })
    await lucas.context.setOffline(true)
    await lucasField.click()
    await lucas.page.keyboard.press("ControlOrMeta+End")
    await lucas.page.keyboard.type(" Lucas wrote this.")
    await amina.page.reload()
    const aminaField = view(amina.page, hostile.id).getByTestId("knowledge-doc-body-editor")
    await expect(aminaField).toBeVisible({ timeout: 20_000 })
    await aminaField.click()
    await amina.page.keyboard.press("ControlOrMeta+End")
    await amina.page.keyboard.type(" Amina wrote this.")
    await expect(view(amina.page, hostile.id).getByTestId("save-state")).toHaveAttribute(
      "data-state",
      "saved",
      { timeout: 15_000 },
    )
    await lucas.context.setOffline(false)
    await expect(
      view(lucas.page, hostile.id).getByTestId("knowledge-doc-conflict-banner"),
    ).toBeVisible({ timeout: 20_000 })
    await lucas.page.getByTestId("conflict-open").click()
    await expect(lucas.page.getByTestId("conflict-dialog")).toBeVisible()
    const dialogFetchable = await lucas.page
      .getByTestId("conflict-dialog")
      .evaluate((root) =>
        [...root.querySelectorAll("img, picture, svg image, iframe, link, style")].map(
          (el) => el.outerHTML,
        ),
      )
    expect(dialogFetchable).toEqual([])

    // Let anything late (a picture, a socket frame) arrive before reading the log.
    await amina.page.waitForTimeout(1_500)

    // ── What the browser asked for ─────────────────────────────────────────
    const allowed = new Set([new URL(env.serverUrl).host, `localhost:${env.ports[1]}`])
    const network = log.filter((u) => /^(https?|wss?):/i.test(u))
    const foreign = network.filter((u) => !allowed.has(new URL(u).host))
    expect(foreign).toEqual([])
    expect(network.some((u) => u.includes(EVIL))).toBe(false)
    // A file's bytes only through the authenticated inline route; its description
    // through the metadata route. Never a download link or another store.
    const fileReads = network.filter((u) => /\/files\/[0-9a-f-]{36}\//i.test(u))
    expect(fileReads.length).toBeGreaterThan(0)
    for (const u of fileReads) {
      expect(new URL(u).pathname).toMatch(/^\/api\/files\/[0-9a-f-]{36}\/(inline|metadata)$/)
    }

    // ── Control: the recorder sees a request to another host ──────────────
    await amina.page.evaluate(() => {
      const img = document.createElement("img")
      // https: images are allowed by the CSP (img-src): only the page itself stops them.
      img.src = "https://egress-probe.invalid/probe.png"
      document.body.append(img)
    })
    await expect.poll(() => log.some((u) => u.includes("egress-probe.invalid"))).toBe(true)
  } finally {
    await amina.context.close()
    await lucas.context.close()
  }
})

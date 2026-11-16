// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The token page in a real browser, at 1440 and at 390 px: the whole flow from
// the mail's link to "You have signed", against the public client action routes
// answered at the page's boundary (their server half is proven by the api's own
// tests). Every request stays on this origin, no PDF library loads, nothing
// scrolls sideways on a phone, and once loaded the address and the history
// entry hold no token.
import type { Page, Request } from "@playwright/test"
import { expect, test } from "./fixtures/test"

const TOKEN = "e2e_token_".padEnd(43, "q")

const OPEN = {
  state: "open",
  kind: "sign",
  sender: { name: "Léa Roux", org: "Maison Alpha" },
  title: "Statement of work: booking and tracking",
  ref: "ab12cd34",
  valid_until: "2030-01-20",
  summary: [
    { k: "Work", v: "Booking and tracking system" },
    { k: "Price", v: "38,000 EUR excl. VAT" },
  ],
  invited_email_masked: "j•••@client.example",
  phrase: null,
  steps: ["read", "identity", "sign"],
}

const BLOCKS = [
  { type: "heading", text: "Statement of work", level: 1 },
  ...Array.from({ length: 30 }, (_, i) => ({
    type: "paragraph",
    text: `Clause ${i + 1}. The parties agree on the scope, the price and the dates of this work, as written here.`,
  })),
]

async function servePublicRoutes(page: Page) {
  await page.route("**/api/public/client-actions/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop()
    const body = route.request().postDataJSON() as Record<string, unknown>
    expect(body.t).toBe(TOKEN)
    const json = (status: number, payload: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) })
    switch (name) {
      case "open":
        return json(200, OPEN)
      case "seen":
        return route.fulfill({ status: 204 })
      case "document":
        return body.format === "blocks"
          ? json(200, { format: "blocks", content: BLOCKS })
          : json(404, { error: { code: "not_found" } })
      case "code":
        return json(202, { sent_to: "j•••@client.example", next_at: null })
      case "verify":
        return json(200, {
          proof: "p".repeat(43),
          words: `By entering my name and the code, I sign "${OPEN.title}" with a simple electronic signature.`,
          words_key: "client-action.words.sign",
        })
      case "decide":
        return json(200, { state: "signed", copy_to: "j•••@client.example" })
      default:
        return json(202, { accepted: true })
    }
  })
}

async function noSidewaysScroll(page: Page) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(widths.scroll).toBeLessThanOrEqual(widths.client)
}

for (const size of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`the token page signs end to end at ${size.width} px, on this origin only`, async ({
    page,
    env,
  }) => {
    const vitePort = env.ports[1]
    const origin = `http://localhost:${vitePort}`
    await page.setViewportSize({ width: size.width, height: size.height })
    const requests: Request[] = []
    page.on("request", (r) => requests.push(r))
    await servePublicRoutes(page)

    await page.goto(`${origin}/a#t=${TOKEN}`)
    await expect(page.getByTestId("client-action-title")).toBeVisible({ timeout: 30000 })

    // After load the URL has no fragment and the history entry holds no token.
    expect(page.url()).toBe(`${origin}/a`)
    const entry = await page.evaluate((): { href: string; state: string } => ({
      href: window.location.href,
      state: JSON.stringify(window.history.state) ?? "",
    }))
    expect(entry.href).not.toContain(TOKEN)
    expect(entry.state).not.toContain(TOKEN)

    await expect(page.getByTestId("level-sentence")).toContainText("Simple electronic signature")
    await expect(page.getByTestId("read-continue")).toBeDisabled()
    await noSidewaysScroll(page)

    await page.getByTestId("doc-end").scrollIntoViewIfNeeded()
    await page.mouse.wheel(0, 200)
    await expect(page.getByTestId("read-continue")).toBeEnabled()
    await page.getByTestId("read-continue").click()

    await expect(page.getByTestId("step-identity-panel")).toBeVisible()
    await noSidewaysScroll(page)
    await page.getByTestId("code-input").fill("123456")
    await page.getByTestId("identity-name").fill("Jean Tessier")
    await page.getByTestId("identity-capacity").fill("Director")
    await page.getByTestId("identity-continue").click()

    await expect(page.getByTestId("consent-words")).toContainText("simple electronic signature")
    await expect(page.getByTestId("sign-confirm")).toBeDisabled()
    await page.getByTestId("sign-name").fill("Jean Tessier")
    await page.getByTestId("sign-confirm").click()
    await expect(page.getByTestId("step-done-panel")).toBeVisible()
    await noSidewaysScroll(page)

    // Every request stayed on this origin, and no PDF library was fetched.
    const foreign = requests
      .map((r) => r.url())
      .filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:"))
    expect(foreign).toEqual([])
    expect(requests.map((r) => r.url()).filter((u) => /pdfjs|pdf\.worker/i.test(u))).toEqual([])
    // The token never appears in a URL the page requested.
    expect(requests.map((r) => r.url()).filter((u) => u.includes(TOKEN))).toEqual([])
  })
}

test("a link with no token shows the not-found page, which names nobody", async ({ page, env }) => {
  await page.goto(`http://localhost:${env.ports[1]}/a`)
  await expect(page.getByTestId("token-frame-notfound")).toBeVisible({ timeout: 30000 })
  await expect(page.getByTestId("token-frame-sender")).toHaveCount(0)
})

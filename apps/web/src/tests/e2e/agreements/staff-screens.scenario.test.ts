// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agreements app's staff screens in a real browser, from its frozen bundle: the list,
// one agreement, the editor where a person reads the clause an agent wrote and sets the
// price, then Prepare and Send. The app installs as the image installs it; its tools are
// answered at the page's boundary (their server half is proven by the app's own tests), and
// every call the screens make is checked for what it carries.
import type { Page, Route } from "@playwright/test"
import { expect, loginAs, test } from "../fixtures/test"

const ID = "0f8a2c1e-2222-4222-8222-222222222222"

function draft(over: { agentRead: boolean; priced: boolean; status?: string; links?: unknown[] }) {
  return {
    status: "ok",
    agreement: {
      id: ID,
      number: "AG-2026-014",
      title: "Booking and tracking system",
      kind: "sow",
      status: over.status ?? "draft",
      needs: "being drafted",
      company_id: null,
      renews_on: null,
      price_minor: over.priced ? "3800000" : null,
      currency: over.priced ? "EUR" : null,
      org_access: "editor",
      what_it_is: null,
      starts_on: null,
      ends_on: null,
      template_id: null,
      template_version: null,
    },
    draft: {
      lock_version: over.agentRead ? 2 : 1,
      source: {
        body: {
          blocks: [
            { type: "heading", level: 1, text: "Statement of work" },
            {
              type: "article",
              level: 1,
              heading: "In scope",
              text: "A booking screen for dispatchers, and a tracking page.",
              ...(over.agentRead ? {} : { agent_draft: true }),
            },
          ],
        },
      },
    },
    versions: [],
    shares: [],
    signing_links: over.links ?? [],
  }
}

interface Seen {
  tool: string
  params: Record<string, unknown>
}

async function answerTools(page: Page, seen: Seen[]) {
  const state = { agentRead: false, priced: false, sent: false }
  await page.route("**/api/apps/agreements/tools/*", async (route: Route) => {
    const tool = new URL(route.request().url()).pathname.split("/").pop() ?? ""
    const body = (route.request().postDataJSON() ?? {}) as { params?: Record<string, unknown> }
    const params = body.params ?? {}
    seen.push({ tool, params })
    const ok = (data: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data }),
      })
    const current = () =>
      draft({
        ...state,
        ...(state.sent
          ? {
              status: "sent",
              links: [
                {
                  client_action_id: "ca-1",
                  signer: "Jean Tessier",
                  email: "jean@client.example",
                  sign_order: 1,
                  state: "open",
                  expires_at: "2030-01-20",
                },
              ],
            }
          : {}),
      })
    switch (tool) {
      case "home_load":
        return ok({ status: "ok", items: [current().agreement], total: 1 })
      case "agreement_get":
        return ok(current())
      case "templates_list":
        return ok({ status: "ok", items: [] })
      case "agreement_update": {
        const blocks = (params.source as { body: { blocks: Array<Record<string, unknown>> } }).body
          .blocks
        state.agentRead = blocks.every((b) => b.agent_draft !== true)
        return ok({ status: "ok", message: "saved" })
      }
      case "agreement_price_set":
        state.priced = true
        return ok({ status: "ok", message: "set" })
      case "agreement_prepare":
        return ok({
          status: "ok",
          version_id: "v-1",
          version: 1,
          sha256: "e".repeat(64),
          page_count: 2,
        })
      case "agreement_send":
        state.sent = true
        return ok({ status: "ok", message: "sent" })
      default:
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: `no answer for ${tool}` } }),
        })
    }
  })
}

test.describe("Agreements staff screens", () => {
  test.setTimeout(180_000)

  test.beforeAll(async ({ env, world }) => {
    const res = await fetch(`${env.serverUrl}/api/_test/apps/install-bundled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId: world.org.id, app: "agreements" }),
    })
    expect(res.status, await res.text()).toBe(200)
  })

  test("list, open, read the agent's clause, set the price, prepare and send", async ({
    page,
    env,
    qa,
  }) => {
    const seen: Seen[] = []
    await answerTools(page, seen)
    await loginAs(page, env, qa.admin.email, "12345678")
    const vite = `http://localhost:${env.ports[1]}`

    // The list: the draft needs someone, the sentence says the order.
    await page.goto(`${vite}/agreements`)
    await expect(page.getByTestId("agreements-list")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("agreements-sidebar")).toBeVisible()
    await expect(page.getByTestId("agreements-sort-sentence")).toBeVisible()
    await page.getByTestId(`agreements-needs-${ID}`).click()

    // The agreement: a draft, edited from its page.
    await expect(page.getByTestId("agreement-detail")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("agreement-number")).toHaveText("AG-2026-014")
    await expect(page.getByTestId("agreement-read-and-sign")).toHaveCount(0)
    await page.getByTestId("agreement-edit").click()

    // The editor: the agent's clause is marked, Prepare is off until it is read and priced.
    await expect(page.getByTestId("agreement-editor")).toBeVisible({ timeout: 20_000 })
    const block = page.getByTestId("agreement-block-1")
    await expect(block).toHaveAttribute("data-agent", "true")
    await expect(page.getByTestId("agreement-editor-prepare")).toBeDisabled()
    await page.getByTestId("agreement-block-read-1").click()
    await expect(block).not.toHaveAttribute("data-agent", "true")
    await page.getByTestId("agreement-editor-save").click()
    await expect(page.getByTestId("agreement-editor-note")).toBeVisible()
    const saved = seen.find((s) => s.tool === "agreement_update")
    expect(saved?.params.lock_version).toBe(1)
    expect(JSON.stringify(saved?.params.source)).not.toContain("agent_draft")

    await page.getByTestId("agreement-price-input").fill("38 000")
    await page.getByTestId("agreement-price-set").click()
    await expect(page.getByTestId("agreement-price-current")).toContainText("38,000.00")
    expect(seen.find((s) => s.tool === "agreement_price_set")?.params).toEqual({
      id: ID,
      price_minor: "3800000",
      currency: "EUR",
    })

    // Every check passes now: Prepare opens the send tab.
    await expect(page.getByTestId("agreement-check-AGENT_TEXT_UNREAD")).toHaveAttribute(
      "data-ok",
      "true",
    )
    await expect(page.getByTestId("agreement-check-PRICE_NOT_SET")).toHaveAttribute(
      "data-ok",
      "true",
    )
    await page.getByTestId("agreement-editor-prepare").click()

    // Prepare freezes, then the person names the signer and sends.
    await expect(page.getByTestId("agreement-send")).toBeVisible({ timeout: 20_000 })
    await page.getByTestId("agreement-send-prepare").click()
    await expect(page.getByTestId("agreement-send-frozen")).toContainText("e".repeat(64))
    await page.getByTestId("agreement-send-signer-name-0").fill("Jean Tessier")
    await page.getByTestId("agreement-send-signer-email-0").fill("jean@client.example")
    await page.getByTestId("agreement-send-submit").click()

    // Back on the agreement: waiting for Jean, with no sign button for anyone else.
    await expect(page.getByTestId("agreement-status")).toHaveAttribute("data-variant", "sent", {
      timeout: 20_000,
    })
    await expect(page.getByTestId("agreement-signer-ca-1")).toContainText("Jean Tessier")
    await expect(page.getByTestId("agreement-read-and-sign")).toHaveCount(0)
    expect(seen.find((s) => s.tool === "agreement_send")?.params).toEqual({
      version_id: "v-1",
      sha256: "e".repeat(64),
      signers: [{ name: "Jean Tessier", email: "jean@client.example" }],
      order: "sequential",
      expires_in_days: 14,
    })
  })

  test("an agreement's link opens its page, not an unavailable app", async ({ page, env, qa }) => {
    const seen: Seen[] = []
    await answerTools(page, seen)
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/agreements/agreement/${ID}`)
    await expect(page.getByTestId("agreement-detail")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("agreement-title")).toHaveText("Booking and tracking system")
  })
})

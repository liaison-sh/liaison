// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client portal in a real browser, for two clients of the same org, at 1440
// and at 390 px: from the mailed link to the home, a project, invoices and
// requests, against `/api/portal/*` answered at the page's boundary (the server
// half, two companies' reads included, is proven by the api's door tests). Every
// request stays on this origin, nothing scrolls sideways on a phone, once loaded
// the address and the history entry hold no token, and another client's project
// reads exactly like a missing one.
import type { Page, Request, Route } from "@playwright/test"
import { expect, test } from "./fixtures/test"

interface Client {
  token: string
  access: string
  name: string
  projectId: string
  projectName: string
  invoice: string
}

const CLIENTS: Client[] = [
  {
    token: "e2e_portal_link_a".padEnd(43, "a"),
    access: "access-a",
    name: "Paul Garnier",
    projectId: "11111111-1111-4111-8111-111111111111",
    projectName: "Booking system",
    invoice: "INV-2026-004",
  },
  {
    token: "e2e_portal_link_b".padEnd(43, "b"),
    access: "access-b",
    name: "Anne Morel",
    projectId: "22222222-2222-4222-8222-222222222222",
    projectName: "Catalogue redesign",
    invoice: "INV-2026-009",
  },
]

async function servePortal(page: Page, me: Client) {
  const json = (route: Route, status: number, payload: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) })
  await page.route("**/api/portal/**", async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname.replace(/^\/api\/portal/, "")
    if (path === "/auth/branding/maison-alpha") {
      return json(route, 200, {
        data: {
          name: "Maison Alpha",
          logoUrl: null,
          notice: "Maison Alpha keeps this log 12 months.",
        },
      })
    }
    if (path === "/auth/refresh") return json(route, 401, { error: { message: "Invalid session" } })
    if (path === "/auth/verify") {
      const body = req.postDataJSON() as { token: string }
      return body.token === me.token
        ? json(route, 200, { data: { accessToken: me.access } })
        : json(route, 401, { error: { message: "This link or code no longer works" } })
    }
    // Every data route needs this client's own access token.
    if (req.headers().authorization !== `Bearer ${me.access}`) {
      return json(route, 401, { error: { message: "Unauthorized" } })
    }
    if (path === "/home") {
      return json(route, 200, {
        data: {
          me: {
            id: "u",
            name: me.name,
            email: "x@client.example",
            locale: "en",
            timezone: null,
            contactName: "Élodie Renard",
          },
          projects: [{ id: me.projectId, name: me.projectName, ownerName: "Léa Roux" }],
          invoices: [
            {
              id: "inv",
              type: "invoice",
              number: me.invoice,
              status: "issued",
              paymentStatus: "paid",
              currency: "EUR",
              grandTotalMinor: "5376000",
              issuedAt: "2026-10-01",
              dueAt: "2026-10-31",
              paidAt: "2026-10-20",
              originalDocumentId: null,
              label: "Milestone 1",
              hasPdf: false,
            },
          ],
          upcoming: [],
          requests: [],
          requestsOpen: true,
          unavailable: [],
        },
      })
    }
    if (path === "/documents") return json(route, 200, { data: [] })
    if (path === `/projects/${me.projectId}`) {
      return json(route, 200, {
        data: {
          id: me.projectId,
          name: me.projectName,
          ownerName: "Léa Roux",
          steps: [{ id: "s1", title: "Design", state: "done", doneShare: 100, dueOn: null }],
          hours: {
            kind: "so_far",
            usedMinutes: 1080,
            ofMinutes: 2400,
            period: "2026-11-01/2026-11-30",
          },
        },
      })
    }
    // Anything else, another client's project included, is the one 404.
    return json(route, 404, { error: { message: "Not found" } })
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
  test(`two clients each see only their own portal at ${size.width} px, on this origin only`, async ({
    page,
    env,
  }) => {
    const origin = `http://localhost:${env.ports[1]}`
    await page.setViewportSize({ width: size.width, height: size.height })
    for (const [i, me] of CLIENTS.entries()) {
      const other = CLIENTS[1 - i] as Client
      await page.unrouteAll({ behavior: "ignoreErrors" })
      const requests: Request[] = []
      page.on("request", (r) => requests.push(r))
      await servePortal(page, me)

      await page.goto(`${origin}/portal/sign-in?org=maison-alpha#c=ch-${i}&t=${me.token}`)
      await expect(page.getByTestId("portal-verify-continue")).toBeVisible({ timeout: 30000 })

      // After load the URL has no fragment and the history entry holds no token.
      expect(page.url()).toBe(`${origin}/portal/maison-alpha/verify`)
      const entry = await page.evaluate(() => ({
        href: window.location.href,
        state: JSON.stringify(window.history.state) ?? "",
      }))
      expect(entry.href).not.toContain(me.token)
      expect(entry.state).not.toContain(me.token)
      await noSidewaysScroll(page)

      await page.getByTestId("portal-verify-continue").click()
      await expect(page.getByTestId("portal-home")).toBeVisible()
      await expect(page.getByTestId("portal-org")).toHaveText("Maison Alpha")
      await expect(page.getByTestId("portal-contact")).toHaveText("Your contact: Élodie Renard")
      await expect(page.getByTestId("portal-home")).not.toContainText(other.projectName)
      await expect(page.getByTestId("portal-home-invoices")).toContainText(me.invoice)
      await expect(page.getByTestId("portal-notice")).toContainText("12 months")
      await noSidewaysScroll(page)

      await page.getByTestId(`portal-project-row-${me.projectId}`).click()
      await expect(page.getByTestId("portal-hours-line")).toHaveText(
        "Hours used: 18 of 40 h so far",
      )
      await noSidewaysScroll(page)

      // Another client's project and a missing one read the same, in this signed-in tab.
      const visit = (path: string) =>
        page.evaluate((p) => {
          window.history.pushState(null, "", p)
          window.dispatchEvent(new PopStateEvent("popstate"))
        }, path)
      await visit(`/portal/maison-alpha/projects/${other.projectId}`)
      const foreignText = await page.getByTestId("portal-not-available").textContent()
      await visit("/portal/maison-alpha/projects/33333333-3333-4333-8333-333333333333")
      await expect(page.getByTestId("portal-not-available")).toHaveText(foreignText ?? "")
      expect(foreignText).toBe("This page is not available.")

      const foreign = requests
        .map((r) => r.url())
        .filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:"))
      expect(foreign).toEqual([])
      expect(requests.map((r) => r.url()).filter((u) => u.includes(me.token))).toEqual([])
      page.removeAllListeners("request")
    }
  })
}

test("a portal page with no session is the sign-in form, with the same words for any address", async ({
  page,
  env,
}) => {
  await servePortal(page, CLIENTS[0] as Client)
  await page.route("**/api/portal/auth/request", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { requested: true } }),
    }),
  )
  await page.goto(`http://localhost:${env.ports[1]}/portal/maison-alpha`)
  await expect(page.getByTestId("portal-signin-title")).toHaveText("Sign in to Maison Alpha", {
    timeout: 30000,
  })
  await page.getByTestId("portal-signin-email").fill("anyone@else.example")
  await page.getByTestId("portal-signin-submit").click()
  await expect(page.getByTestId("portal-signin-sent")).toHaveText(
    "If this address has access, a sign-in link is on its way. Check your inbox.",
  )
})

test("a client acknowledges the notice they read, reads a changed one again, and a milestone project says it has no billed hours", async ({
  page,
  env,
}) => {
  const origin = `http://localhost:${env.ports[1]}`
  const me = CLIENTS[0] as Client
  await page.setViewportSize({ width: 390, height: 844 })
  await servePortal(page, me)
  // The org replaces its notice after the page loaded: version 2 is shown, version 3 is current.
  let current = { notice: "Maison Alpha keeps this log 12 months.", noticeVersion: 2 }
  const posted: unknown[] = []
  const json = (route: Route, status: number, payload: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) })
  await page.route("**/api/portal/auth/branding/maison-alpha", (route) =>
    json(route, 200, { data: { name: "Maison Alpha", logoUrl: null, ...current } }),
  )
  await page.route("**/api/portal/me/notice-ack", (route) => {
    const body = route.request().postDataJSON() as { version: number }
    posted.push(body)
    if (body.version !== 3) {
      current = { notice: "Maison Alpha keeps this log 24 months.", noticeVersion: 3 }
      return json(route, 409, { error: { code: "NOTICE_CHANGED", message: "Changed" } })
    }
    return json(route, 200, { data: { noticeVersion: 3 } })
  })
  await page.route(`**/api/portal/projects/${me.projectId}`, (route) =>
    json(route, 200, {
      data: {
        id: me.projectId,
        name: me.projectName,
        ownerName: "Léa Roux",
        steps: [],
        hours: null,
        hoursNote: "by_milestone",
      },
    }),
  )

  await page.goto(`${origin}/portal/sign-in?org=maison-alpha#c=ch-n&t=${me.token}`)
  await page.getByTestId("portal-verify-continue").click({ timeout: 30000 })
  const notice = page.getByTestId("portal-notice-read")
  await expect(notice).toContainText("12 months")
  await page.getByTestId("portal-notice-ack").click()
  await expect(page.getByTestId("portal-notice-changed")).toBeVisible()
  await expect(notice).toContainText("24 months")
  await page.getByTestId("portal-notice-ack").click()
  await expect(notice).toHaveCount(0)
  expect(posted).toEqual([{ version: 2 }, { version: 3 }])
  await noSidewaysScroll(page)

  await page.getByTestId(`portal-project-row-${me.projectId}`).click()
  await expect(page.getByTestId("portal-hours-note")).toHaveText(
    "This project bills by milestone, so it has no billed hours.",
  )
  await expect(page.getByTestId("portal-hours-line")).toHaveCount(0)
  await noSidewaysScroll(page)
})

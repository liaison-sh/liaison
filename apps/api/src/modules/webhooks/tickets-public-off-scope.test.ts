// SPDX-License-Identifier: FSL-1.1-ALv2
// Tickets Off gates only the tickets public paths, never another app's webhooks
// on the same org: the tickets router is mounted at `/webhooks` beside the
// generic per-app router (as in app.ts), and Hono merges a sub-router's
// middleware into the parent.
import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { APP_DISABLED_CODE } from "@liaison/shared"
import { Hono } from "hono"
import { forgetOrgApps, rememberOrgAppStates } from "~/modules/apps/org-apps"
import { webhookRoutes } from "./routes"
import { ticketsPublicRoutes } from "./tickets-public"

const ORG = "0a1b2c3d-0000-4000-8000-00000000f0ff"
const app = new Hono().route("/webhooks", ticketsPublicRoutes).route("/webhooks", webhookRoutes)

describe("tickets Off scope on /webhooks", () => {
  beforeEach(() => {
    rememberOrgAppStates(ORG, [{ app: "tickets", status: "disabled" }])
  })
  afterAll(() => forgetOrgApps(ORG))

  it("another app's POST webhook gets its normal handling (not 503)", async () => {
    const res = await app.fetch(
      new Request(`http://x/webhooks/${ORG}/shopify/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(res.status).not.toBe(503)
    expect(res.status).toBe(404) // no registration: the generic router's own answer
  })

  it("another app's GET challenge is not 503", async () => {
    const res = await app.fetch(new Request(`http://x/webhooks/${ORG}/social/verify?x=1`))
    expect(res.status).not.toBe(503)
  })

  it("ticket public create still answers 503 app_disabled", async () => {
    const res = await app.fetch(
      new Request(`http://x/webhooks/${ORG}/tickets/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe(APP_DISABLED_CODE)
  })

  it("the inbox-scoped ticket path is gated too", async () => {
    const res = await app.fetch(
      new Request(`http://x/webhooks/${ORG}/inboxes/${ORG}/tickets/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(res.status).toBe(503)
  })
})

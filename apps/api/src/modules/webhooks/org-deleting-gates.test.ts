// SPDX-License-Identifier: FSL-1.1-ALv2
// An org whose deletion has started (`deleting_at` set) is served nothing on
// its unauthenticated, org-keyed routes either (S2.5): an inbound webhook is
// acknowledged and dropped before any lookup or handler (a provider retrying a
// failure would only keep writing into a purge), and the tickets public routes
// answer 410 ORG_DELETED. The queued-webhook worker reads the same gate
// (`isAppOffForPathOrg`), so a delivery queued before the mark is dropped too.
import { afterAll, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { forgetOrgApps, isAppOffForPathOrg, rememberOrgAppStates } from "~/modules/apps/org-apps"
import { ORG_DELETED_CODE } from "~/modules/org/purge/deleting"
import { webhookRoutes } from "./routes"
import { ticketsPublicRoutes } from "./tickets-public"

const DELETING = "0a1b2c3d-0000-4000-8000-00000000d31e"
const LIVE = "0a1b2c3d-0000-4000-8000-00000000d31f"
const app = new Hono().route("/webhooks", ticketsPublicRoutes).route("/webhooks", webhookRoutes)

const on = [
  { app: "tickets", status: "active" as const },
  { app: "shopify", status: "active" as const },
]

function plant(): void {
  rememberOrgAppStates(DELETING, on, { deleting: true })
  rememberOrgAppStates(LIVE, on)
}

afterAll(() => {
  forgetOrgApps(DELETING)
  forgetOrgApps(LIVE)
})

describe("a deleting org on its unauthenticated routes", () => {
  it("the path-org gate treats every app of a deleting org as Off", async () => {
    plant()
    expect(await isAppOffForPathOrg(DELETING, "shopify")).toBe(true)
    expect(await isAppOffForPathOrg(LIVE, "shopify")).toBe(false)
  })

  it("an inbound webhook is acknowledged and dropped before the registration lookup", async () => {
    plant()
    const res = await app.fetch(
      new Request(`http://x/webhooks/${DELETING}/shopify/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { dropped?: string }).dropped).toBe(ORG_DELETED_CODE)
    // The live org reaches the registration lookup (none here: 404).
    const live = await app.fetch(
      new Request(`http://x/webhooks/${LIVE}/shopify/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(live.status).toBe(404)
  })

  it("a webhook verification challenge is dropped too", async () => {
    plant()
    const res = await app.fetch(
      new Request(
        `http://x/webhooks/${DELETING}/shopify/verify?hub.mode=subscribe&hub.challenge=c&hub.verify_token=t`,
      ),
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { dropped?: string }).dropped).toBe(ORG_DELETED_CODE)
  })

  it("the tickets public routes answer 410 ORG_DELETED", async () => {
    plant()
    for (const path of [
      `/webhooks/${DELETING}/tickets/create`,
      `/webhooks/${DELETING}/inboxes/${DELETING}/tickets/create`,
    ]) {
      const res = await app.fetch(
        new Request(`http://x${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      )
      expect(res.status).toBe(410)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(ORG_DELETED_CODE)
    }
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { slotRegistry } from "~/modules/apps/app-registries"
import type { Scope } from "~/modules/permissions/types"
import { slotsRoutes } from "./routes"

// Standalone Hono harness — we test the route handler in isolation by mounting
// it inside a fresh Hono instance and stubbing `orgId` + `scopes` (which auth
// middleware would normally set). This avoids dragging in full JWT / RLS
// bootstrapping that the schema-only `attention-routes.test.ts` style avoids.
function makeApp(orgId: string, scopes: string[]) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("orgId", orgId)
    c.set("scopes", scopes as Scope[])
    await next()
  })
  app.route("/api/v1/slots", slotsRoutes)
  return app
}

describe("GET /api/v1/slots/:slot (B9)", () => {
  const ORG = "org-slot-routes-1"

  beforeEach(() => slotRegistry.deleteByPrefix([ORG]))
  afterEach(() => slotRegistry.deleteByPrefix([ORG]))

  test("returns visible panels for the slot, scoped to the caller's org", async () => {
    slotRegistry.set([ORG, "invoicing", "contact_detail"], {
      panels: [
        {
          id: "invoicing-documents",
          label: "Documents",
          component: "ContactDocumentsPanel",
          visibility_scope: "invoicing:documents:read",
        },
      ],
    })

    const app = makeApp(ORG, ["invoicing:documents:read"])
    const res = await app.request("/api/v1/slots/contact_detail")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { panels: any[] } }
    expect(body.data.panels).toHaveLength(1)
    expect(body.data.panels[0]).toMatchObject({
      id: "invoicing-documents",
      app: "invoicing",
    })
  })

  test("filters out panels the user lacks scope for (silent — no 403)", async () => {
    slotRegistry.set([ORG, "invoicing", "contact_detail"], {
      panels: [
        {
          id: "invoicing-documents",
          label: "Documents",
          component: "ContactDocumentsPanel",
          visibility_scope: "invoicing:documents:read",
        },
      ],
    })

    const app = makeApp(ORG, []) // no scopes
    const res = await app.request("/api/v1/slots/contact_detail")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { panels: any[] } }
    expect(body.data.panels).toEqual([])
  })

  test("returns empty list for an unknown slot", async () => {
    const app = makeApp(ORG, ["*"])
    const res = await app.request("/api/v1/slots/does_not_exist")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { panels: any[] } }
    expect(body.data.panels).toEqual([])
  })
})

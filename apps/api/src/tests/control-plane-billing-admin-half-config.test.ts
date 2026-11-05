// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 14 spec, Track D matrix: when only one of CONTROL_PLANE_URL /
// CONTROL_PLANE_API_KEY is set in dev/test, the instance must behave as
// self-hosted — billing-admin routes mounted but 404 for every call.
// Production would have failed startup; this guards the dev/test path.

import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { validateControlPlaneEnv } from "~/lib/env"
import { createBillingAdminRoutes } from "~/modules/billing-admin"

function mountForEnv(e: { CONTROL_PLANE_URL?: string; CONTROL_PLANE_API_KEY?: string }) {
  const mode = validateControlPlaneEnv({ NODE_ENV: "development", ...e }, { warn: () => {} }).mode
  const key = mode === "managed" ? e.CONTROL_PLANE_API_KEY : undefined
  const app = new Hono()
  app.route("/api/admin/billing", createBillingAdminRoutes(key))
  return app
}

describe("control-plane half-config never exposes billing-admin", () => {
  test("only CONTROL_PLANE_API_KEY set → 404 even with correct bearer", async () => {
    const app = mountForEnv({ CONTROL_PLANE_API_KEY: "k".repeat(32) })
    const r = await app.request("/api/admin/billing/credits", {
      method: "POST",
      headers: { authorization: `Bearer ${"k".repeat(32)}`, "content-type": "application/json" },
      body: JSON.stringify({
        orgId: "00000000-0000-0000-0000-000000000000",
        amountCredits: "1",
        externalPaymentRef: "x",
      }),
    })
    expect(r.status).toBe(404)
  })

  test("only CONTROL_PLANE_URL set → 404 (no bearer required)", async () => {
    const app = mountForEnv({ CONTROL_PLANE_URL: "https://cp.example/" })
    const r = await app.request("/api/admin/billing/credits/reset", { method: "POST", body: "{}" })
    expect(r.status).toBe(404)
  })

  test("both unset → 404", async () => {
    const app = mountForEnv({})
    const r = await app.request("/api/admin/billing/org/x/tier", { method: "PATCH", body: "{}" })
    expect(r.status).toBe(404)
  })

  test("both set → bearer required (401 without, mounted)", async () => {
    const app = mountForEnv({
      CONTROL_PLANE_URL: "https://cp.example/",
      CONTROL_PLANE_API_KEY: "k".repeat(32),
    })
    const r = await app.request("/api/admin/billing/credits/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: "00000000-0000-0000-0000-000000000000", cycleId: "c1" }),
    })
    expect(r.status).toBe(401)
  })
})

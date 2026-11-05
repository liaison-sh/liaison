// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The OFF side of the demo gate, asserted against the real app.
//
// This file is the one that must keep passing forever on a normal deployment:
// with LIAISON_DEMO_MODE unset, the demo surface does not exist. Not guarded,
// not 403, not "mounted but refuses" -- absent, indistinguishable from a path
// nobody ever wrote. The ON side lives in routes.test.ts.
import { describe, expect, it } from "bun:test"
import { app } from "~/app"
import { env } from "~/lib/env"
import { envBoolean, parseEnvBoolean } from "~/lib/env-boolean"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"

describe("demo mode gate, off", () => {
  it("is off in a process that did not ask for it", () => {
    expect(env.LIAISON_DEMO_MODE).toBe(false)
    expect(isDemoModeEnabled()).toBe(false)
  })

  it("is independent of NODE_ENV: a test run is not a demo instance", () => {
    expect(env.NODE_ENV).toBe("test")
    expect(isDemoModeEnabled()).toBe(false)
  })

  it('reads the string "false" as false, which z.coerce.boolean would not', () => {
    // The whole reason LIAISON_DEMO_MODE goes through the strict parser: an
    // operator writing LIAISON_DEMO_MODE=false to be explicit must not thereby
    // turn the public signup route on.
    expect(parseEnvBoolean("false")).toBe(false)
    expect(envBoolean(false).parse("false")).toBe(false)
    expect(envBoolean(false).parse("0")).toBe(false)
    expect(envBoolean(false).parse(undefined)).toBe(false)
    expect(envBoolean(false).parse("true")).toBe(true)
  })

  it("does not mount POST /api/demo/orgs", async () => {
    const response = await app.request("/api/demo/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Acme", email: "visitor@example.com" }),
    })
    expect(response.status).toBe(404)
  })

  it("does not mount anything else under /api/demo", async () => {
    for (const path of ["/api/demo", "/api/demo/orgs", "/api/demo/anything"]) {
      const response = await app.request(path)
      expect(response.status).toBe(404)
    }
  })

  it("registers no route and no middleware under /api/demo at all", () => {
    // A 404 alone cannot tell "not mounted" from "mounted and refusing", and
    // the two are deliberately indistinguishable from outside. This reads the
    // router itself, which is the only place the difference is visible: with
    // the flag off, app.ts must never have called mountDemoRoutes or
    // useDemoRateLimit.
    const demoEntries = app.routes.filter((r) => r.path.startsWith("/api/demo"))
    expect(demoEntries).toEqual([])
  })
})

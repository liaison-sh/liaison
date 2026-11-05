// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { handleOpenApp } from "~/modules/agent/tools/navigation-tool"

const ctx = { userId: "u1", orgId: "o1" }

describe("open_app navigation tool", () => {
  it("acknowledges the requested app (effect is client-side)", async () => {
    expect(await handleOpenApp({ app: "tickets" }, ctx)).toEqual({ ok: true, app: "tickets" })
  })

  it("passes through an optional view and trims input", async () => {
    expect(await handleOpenApp({ app: "  mail ", view: " inbox " }, ctx)).toEqual({
      ok: true,
      app: "mail",
      view: "inbox",
    })
  })

  it("omits view when not provided", async () => {
    const res = (await handleOpenApp({ app: "knowledge" }, ctx)) as Record<string, unknown>
    expect(res).toEqual({ ok: true, app: "knowledge" })
    expect("view" in res).toBe(false)
  })
})

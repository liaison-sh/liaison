// SPDX-License-Identifier: FSL-1.1-ALv2
// einvoicing_settings_set: the PA provider binding must name an installed provider of the
// contract (checked before writing), and a change raises the binding-changed attention event.
import { describe, expect, it } from "bun:test"
import { createMockDb } from "../test-db"
import { einvoicingSettingsSet, type SettingsToolCtx } from "./settings-tool"

function ctxWith(providers: string[], kernelAccepts = true) {
  const events: Array<{ action: string; data: unknown }> = []
  const bindings: Array<string | null> = []
  const ctx: SettingsToolCtx = {
    db: createMockDb() as unknown as SettingsToolCtx["db"],
    getUserId: async () => "00000000-0000-4000-8000-0000000000a1",
    contracts: {
      providers: async () => JSON.stringify(providers),
      setBinding: async (_c, p) => {
        if (!kernelAccepts) {
          return JSON.stringify({ status: "error", error: { code: "contract_binding_forbidden", message: "Only an organisation administrator, acting in person, can choose the provider of a contract" } })
        }
        bindings.push(p)
        return JSON.stringify({ status: "ok", provider: p, previous: null })
      },
    },
    emit: async (e) => {
      events.push({ action: e.action, data: e.data })
    },
  }
  return { ctx, events, bindings }
}

describe("einvoicing_settings_set: transmission settings", () => {
  it("refuses a provider that is not an installed implementer, before writing", async () => {
    const { ctx, events } = ctxWith(["pennylane"])
    const r = (await einvoicingSettingsSet(ctx, { gate_mode: "enforce", provider_app: "otherpa" })) as { error: { code: string; message: string } }
    expect(r.error.code).toBe("provider_not_available")
    expect(r.error.message).toContain("Installed providers: pennylane")
    expect(await ctx.db.findMany("einvoicing_settings")).toHaveLength(0)
    expect(events).toHaveLength(0)
  })

  it("writes the binding, cut-over and switches; a provider change emits binding_changed once", async () => {
    const { ctx, events } = ctxWith(["pennylane"])
    const r = (await einvoicingSettingsSet(ctx, {
      gate_mode: "enforce",
      provider_app: "pennylane",
      cutover_date: "2026-11-01",
      send_enabled: true,
      book_enabled: false,
    })) as { status: string; settings: Record<string, unknown> }
    expect(r.status).toBe("ok")
    expect(r.settings).toMatchObject({ provider_app: "pennylane", cutover_date: "2026-11-01", send_enabled: true, book_enabled: false })
    expect(events).toEqual([{ action: "binding_changed", data: { from: "none", to: "pennylane", by: "00000000-0000-4000-8000-0000000000a1", source: "tool" } }])
    await einvoicingSettingsSet(ctx, { book_enabled: true })
    await einvoicingSettingsSet(ctx, { provider_app: "pennylane" })
    expect(events).toHaveLength(1)
    expect(((await ctx.db.findMany("einvoicing_settings")) as Array<Record<string, unknown>>)[0]?.book_enabled).toBe(true)
  })

  it("the provider binding goes to the kernel first; when the kernel refuses (not an administrator in person), nothing is written", async () => {
    const refused = ctxWith(["pennylane"], false)
    const r = (await einvoicingSettingsSet(refused.ctx, { gate_mode: "enforce", provider_app: "pennylane" })) as { error: { code: string } }
    expect(r.error.code).toBe("contract_binding_forbidden")
    expect(await refused.ctx.db.findMany("einvoicing_settings")).toHaveLength(0)
    expect(refused.events).toHaveLength(0)
    const ok = ctxWith(["pennylane"])
    await einvoicingSettingsSet(ok.ctx, { gate_mode: "enforce", provider_app: "pennylane" })
    await einvoicingSettingsSet(ok.ctx, { send_enabled: true }) // no provider change: the kernel is not asked again
    expect(ok.bindings).toEqual(["pennylane"])
  })

  it("a null (or empty) cut-over or switch date clears the stored value; an absent one keeps it", async () => {
    const { ctx } = ctxWith(["pennylane"])
    await einvoicingSettingsSet(ctx, { gate_mode: "enforce", cutover_date: "2027-01-01", cibs_switch_date: "2026-09-01" })
    const stored = async () => ((await ctx.db.findMany("einvoicing_settings")) as Array<Record<string, unknown>>)[0]
    await einvoicingSettingsSet(ctx, { send_enabled: true })
    expect(await stored()).toMatchObject({ cutover_date: "2027-01-01", cibs_switch_date: "2026-09-01" })
    const r = (await einvoicingSettingsSet(ctx, { cutover_date: null })) as { status: string; settings: Record<string, unknown> }
    expect(r.status).toBe("ok")
    expect(r.settings.cutover_date).toBeNull()
    expect(await stored()).toMatchObject({ cutover_date: null, cibs_switch_date: "2026-09-01" })
    await einvoicingSettingsSet(ctx, { cibs_switch_date: "" })
    expect(await stored()).toMatchObject({ cutover_date: null, cibs_switch_date: null })
  })

  it("a null (or empty) provider unbinds it in the kernel first, then here; an absent one keeps it", async () => {
    const { ctx, events, bindings } = ctxWith(["pennylane"])
    await einvoicingSettingsSet(ctx, { gate_mode: "enforce", provider_app: "pennylane" })
    const stored = async () => ((await ctx.db.findMany("einvoicing_settings")) as Array<Record<string, unknown>>)[0]
    await einvoicingSettingsSet(ctx, { send_enabled: true })
    expect((await stored())?.provider_app).toBe("pennylane")
    const r = (await einvoicingSettingsSet(ctx, { provider_app: null })) as { status: string; settings: Record<string, unknown> }
    expect(r.status).toBe("ok")
    expect(r.settings.provider_app).toBeNull()
    expect((await stored())?.provider_app).toBeNull()
    expect(bindings).toEqual(["pennylane", null])
    expect(events.at(-1)).toEqual({ action: "binding_changed", data: { from: "pennylane", to: "none", by: "00000000-0000-4000-8000-0000000000a1", source: "tool" } })
    await einvoicingSettingsSet(ctx, { provider_app: "" })
    expect(bindings).toEqual(["pennylane", null])
    expect(events).toHaveLength(2)
  })

  it("refuses a malformed cut-over date", async () => {
    const { ctx } = ctxWith(["pennylane"])
    const r = (await einvoicingSettingsSet(ctx, { gate_mode: "enforce", cutover_date: "2026-11-31" })) as { error: { code: string } }
    expect(r.error.code).toBe("invalid_input")
  })

  it("a first write without a gate mode (the settings page) keeps the org's default mode and saves", async () => {
    const { ctx } = ctxWith(["pennylane"])
    const r = (await einvoicingSettingsSet(ctx, { send_enabled: true })) as { status: string; settings: Record<string, unknown> }
    expect(r.status).toBe("ok")
    const rows = (await ctx.db.findMany("einvoicing_settings")) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ send_enabled: true, gate_mode: "enforce", gate_mode_source: "install_default" })
  })
})

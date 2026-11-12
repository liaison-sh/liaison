// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app's handlers over a fake `ctx.api`: the tools hand the platform exactly
// what they were given, provisioning writes only what differs (a dry run
// nothing), and verify reports each connection's failure.

import { describe, expect, it } from "bun:test"
import * as handlers from "./handlers"

type Call = { method: string; request: unknown }

function fakeApi(answers: Record<string, (request: unknown) => Record<string, unknown>> = {}) {
  const calls: Call[] = []
  const api = new Proxy(
    {},
    {
      get:
        (_t, method: string) =>
        async (request?: unknown): Promise<Record<string, unknown>> => {
          calls.push({ method, request })
          return answers[method]?.(request) ?? { ok: true }
        },
    },
  )
  return { ctx: { api } as never, calls }
}

describe("the tools", () => {
  it("hand the platform the call as given", async () => {
    const { ctx, calls } = fakeApi()
    const read = { connection: "crm", operation: "find_customers", params: { email: "a@b.example" } }
    await handlers.connectorRead(read, ctx)
    await handlers.connectorWrite({ ...read, target: { method: "POST" } }, ctx)
    await handlers.connectorWritePreflight(read, ctx)
    await handlers.connectorListOperations({}, ctx)
    expect(calls.map((c) => c.method)).toEqual(["read", "write", "writeValidate", "listOperations"])
    expect(calls[0]?.request).toEqual(read)
  })

  it("the agent's adapter test is fenced; only the settings screen asks for raw items", async () => {
    const { ctx, calls } = fakeApi()
    await handlers.connectorAdapterTest({ identifier: "crm", operation: "x", raw: true }, ctx)
    await handlers.settingsAdapterTest({ identifier: "crm", operation: "x" }, ctx)
    expect(calls[0]?.request).toEqual({ identifier: "crm", operation: "x" })
    expect(calls[1]?.request).toMatchObject({ identifier: "crm", operation: "x", raw: true })
  })

  it("the customer card names its subject, nothing else", async () => {
    const { ctx, calls } = fakeApi()
    await handlers.customerLookup({ ticketId: "t1", extra: "dropped" }, ctx)
    expect(calls[0]).toEqual({ method: "customer", request: { ticketId: "t1" } })
  })

  it("a settings save confirms a credential wipe only when asked", async () => {
    const { ctx, calls } = fakeApi()
    await handlers.settingsAdapterSave({ identifier: "crm", document: "id: x" }, ctx)
    await handlers.settingsAdapterSave(
      { identifier: "crm", document: "id: x", confirmCredentialWipe: true },
      ctx,
    )
    expect(calls.map((c) => (c.request as { confirmCredentialWipe: boolean }).confirmCredentialWipe)).toEqual([
      false,
      true,
    ])
  })
})

describe("provisioning", () => {
  const config = {
    connectors: [
      { identifier: "crm", adapter: { id: "crm" } },
      { identifier: "erp", adapter: "id: erp" },
    ],
  }

  it("writes only what differs, and says when credentials go", async () => {
    const { ctx, calls } = fakeApi({
      adapterPlan: (r) =>
        (r as { identifier: string }).identifier === "crm"
          ? { ok: true, unchanged: true }
          : { ok: true, unchanged: false, created: false, wipesCredentials: true },
    })
    const out = await handlers.provisionApiConnector({ config, dryRun: false }, ctx)
    expect(out.changed).toEqual([
      "connection 'erp': adapter updated (its API address or auth changed: stored credentials deleted)",
    ])
    expect(calls.filter((c) => c.method === "adapterPut").map((c) => c.request)).toEqual([
      { identifier: "erp", document: "id: erp", confirmCredentialWipe: true, skipUnchanged: true },
    ])
  })

  it("a dry run writes nothing and reports what would change", async () => {
    const { ctx, calls } = fakeApi({ adapterPlan: () => ({ ok: true, created: true }) })
    const out = await handlers.provisionApiConnector({ config, dryRun: true }, ctx)
    expect(out.changed).toEqual(["connection 'crm': adapter created", "connection 'erp': adapter created"])
    expect(calls.some((c) => c.method === "adapterPut")).toBe(false)
  })

  it("refuses an invalid adapter with its issues, and a slug declared twice", async () => {
    const { ctx } = fakeApi({
      adapterPlan: () => ({ ok: false, issues: [{ path: "baseUrl", message: "must be https" }] }),
    })
    await expect(handlers.provisionApiConnector({ config, dryRun: false }, ctx)).rejects.toThrow(
      "connectors[crm]: invalid adapter: baseUrl: must be https",
    )
    const twice = { connectors: [config.connectors[0], config.connectors[0]] } as typeof config
    await expect(
      handlers.provisionApiConnector({ config: twice, dryRun: true }, fakeApi().ctx),
    ).rejects.toThrow("'crm' is declared twice")
  })
})

describe("verify", () => {
  it("passes with each connection's identity, fails with each problem", async () => {
    const ok = fakeApi({
      verify: () => ({ results: [{ connection: "crm", status: "PASS", identity: "list: HTTP 200" }] }),
    })
    expect(await handlers.verifyApiConnector({}, ok.ctx)).toEqual({
      ok: true,
      identity: "crm (list: HTTP 200)",
    })
    const bad = fakeApi({
      verify: () => ({
        results: [
          { connection: "crm", status: "FAIL", error: "The API refused", httpStatus: 401 },
          { connection: "erp", status: "SKIPPED", reason: "no credentials stored" },
        ],
      }),
    })
    expect(await handlers.verifyApiConnector({}, bad.ctx)).toEqual({
      ok: false,
      problems: ["connection 'crm': The API refused (HTTP 401)"],
    })
  })
})

describe("the write's approval card", () => {
  it("reads as what happens, naming who it is about and the pinned request", async () => {
    const card = await handlers.summarizeConnectorWrite({
      connection: "crm",
      operation: "create_contact",
      params: { firstName: "Ines", lastName: "Duarte" },
      target: { method: "POST", host: "crm.example.com", path: "/v1/contacts" },
    })
    expect(card.title).toBe("Create contact in CRM: Ines Duarte")
    expect(card.lines[0]).toBe("POST crm.example.com/v1/contacts")
  })
})

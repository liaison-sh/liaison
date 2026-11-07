// SPDX-License-Identifier: FSL-1.1-ALv2
// The typed host calls an app's screens make (host API 1.3), answered by the
// page with the person's session and limited to the calling app.
import { afterEach, describe, expect, it, vi } from "vitest"

const confirm = vi.hoisted(() => ({ answer: true, asked: [] as unknown[] }))
vi.mock("~/modules/shell/app-approval-confirm", () => ({
  confirmAppApproval: vi.fn(async (request: unknown) => {
    confirm.asked.push(request)
    return confirm.answer
  }),
}))
const desktop = vi.hoisted(() => ({ native: false, opened: [] as string[] }))
vi.mock("~/modules/desktop/desktop-store", () => ({
  canOpenDownloadedFile: () => desktop.native,
  openDownloadedFile: vi.fn(async (_bytes: Uint8Array, name: string) => {
    desktop.opened.push(name)
    return true
  }),
}))

import {
  buildAppHostCalls,
  externalTarget,
  hostDeclared,
  setAppExternalHosts,
} from "./host-app-calls"

function deps(answers: Record<string, unknown> = {}) {
  // What the host fetched (a spy beside the generic fetch, which a mock would not keep generic).
  const calls = vi.fn((_path: string, _init?: RequestInit) => {})
  const fetch = <T>(path: string, init?: RequestInit): Promise<T> => {
    if (init === undefined) calls(path)
    else calls(path, init)
    return Promise.resolve((answers[path.split("?")[0] as string] ?? answers[path]) as T)
  }
  return {
    fetch,
    calls,
    fetchBlob: vi.fn(async (_path: string) => new Blob(["%PDF"], { type: "application/pdf" })),
    navigate: vi.fn((_path: string) => {}),
  }
}

afterEach(() => {
  confirm.answer = true
  confirm.asked = []
  desktop.native = false
  desktop.opened = []
  vi.restoreAllMocks()
})

describe("openExternal", () => {
  const declared = ["*.myshopify.com", "admin.shopify.com"]
  const page = "https://acme.liaison.test"

  it("opens only https pages of declared hosts, never the page's own origin", () => {
    expect(externalTarget("https://shop.myshopify.com/admin", declared, page)).toBe(
      "https://shop.myshopify.com/admin",
    )
    expect(externalTarget("https://admin.shopify.com/store/x", declared, page)).not.toBeNull()
    expect(externalTarget("javascript:alert(1)", declared, page)).toBeNull()
    expect(externalTarget("http://shop.myshopify.com/", declared, page)).toBeNull()
    expect(externalTarget("https://evil.test/", declared, page)).toBeNull()
    expect(externalTarget("https://myshopify.com/", declared, page)).toBeNull()
    expect(externalTarget(`${page}/approvals`, [...declared, "acme.liaison.test"], page)).toBeNull()
    expect(externalTarget("https://u:p@shop.myshopify.com/", declared, page)).toBeNull()
    expect(hostDeclared("a.b.myshopify.com", declared)).toBe(true)
  })

  it("opens with noopener and noreferrer, and refuses an undeclared host", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    setAppExternalHosts("shopify", ["*.myshopify.com"])
    const calls = buildAppHostCalls(deps())
    await calls.openExternal("shopify", "https://shop.myshopify.com/admin/orders")
    expect(open).toHaveBeenCalledWith(
      "https://shop.myshopify.com/admin/orders",
      "_blank",
      "noopener,noreferrer",
    )
    await expect(calls.openExternal("shopify", "javascript:alert(1)")).rejects.toThrow()
    await expect(calls.openExternal("boxtal", "https://shop.myshopify.com/")).rejects.toThrow()
    expect(open).toHaveBeenCalledTimes(1)
  })
})

describe("decideApproval", () => {
  it("refuses another app's approval, before any dialog", async () => {
    const d = deps({
      "/api/approvals/a1": { id: "a1", status: "pending", toolName: "invoicing:issue" },
    })
    await expect(
      buildAppHostCalls(d).decideApproval("boxtal", "a1", "approve", "h"),
    ).rejects.toThrow(/not an approval of this app/)
    expect(confirm.asked).toHaveLength(0)
    expect(d.calls).toHaveBeenCalledTimes(1)
  })

  it("asks the person in the host's dialog, and sends nothing when they cancel", async () => {
    const d = deps({
      "/api/approvals/a1": {
        id: "a1",
        status: "pending",
        toolName: "boxtal:create_shipment",
        summary: { title: "Buy a label", lines: ["Colissimo, 12.40 EUR"] },
      },
    })
    confirm.answer = false
    await expect(
      buildAppHostCalls(d).decideApproval("boxtal", "a1", "approve", "h"),
    ).rejects.toThrow(/cancelled/)
    expect(confirm.asked).toEqual([
      { app: "boxtal", decision: "approve", title: "Buy a label", lines: ["Colissimo, 12.40 EUR"] },
    ])
    expect(d.calls).toHaveBeenCalledTimes(1)
  })

  it("decides after the confirm, bound to the payload fingerprint the app showed", async () => {
    const d = deps({
      "/api/approvals/a1": { id: "a1", status: "pending", toolName: "boxtal:create_shipment" },
    })
    await buildAppHostCalls(d).decideApproval("boxtal", "a1", "approve", "hash-1")
    expect(d.calls).toHaveBeenLastCalledWith("/api/approvals/a1/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", payloadHash: "hash-1" }),
    })
  })
})

describe("listMyApprovals, print, records", () => {
  it("lists only the calling app's tools", async () => {
    const d = deps({
      "/api/approvals": [
        { id: "a", toolName: "boxtal:create_shipment" },
        { id: "b", toolName: "invoicing:issue" },
      ],
    })
    expect(await buildAppHostCalls(d).listMyApprovals("boxtal")).toEqual([
      { id: "a", toolName: "boxtal:create_shipment" },
    ])
    expect(d.calls).toHaveBeenCalledWith(
      "/api/approvals?status=pending&decidableByMe=true&app=boxtal",
    )
  })

  it("prints with the calling app pinned", async () => {
    const d = deps()
    await buildAppHostCalls(d).printDocuments("boxtal", {
      entity: "shipment",
      id: "s1",
      templateIds: ["t1", "../x"],
    })
    expect(d.calls).toHaveBeenCalledWith("/api/documents/print", {
      method: "POST",
      body: JSON.stringify({
        app: "boxtal",
        entity: "shipment",
        recordId: "s1",
        templateIds: ["t1"],
      }),
    })
  })

  it("opens a record of another app through its tab, or its detail page", () => {
    const d = deps()
    buildAppHostCalls(d).openRecord("shopify", "invoicing", "document", "doc-1")
    expect(d.navigate).toHaveBeenCalledWith("/detail/invoicing/document/doc-1")
    expect(() =>
      buildAppHostCalls(d).openRecord("shopify", "invoicing", "document", "../x"),
    ).toThrow()
    buildAppHostCalls(d).openApprovals()
    expect(d.navigate).toHaveBeenLastCalledWith("/approvals")
  })
})

describe("openFileById", () => {
  it("hands the bytes to the desktop viewer, never to the app", async () => {
    desktop.native = true
    const d = deps()
    await buildAppHostCalls(d).openFileById("boxtal", "file-0001", "label.pdf")
    expect(d.fetchBlob).toHaveBeenCalledWith("/api/files/file-0001/inline")
    expect(desktop.opened).toEqual(["label.pdf"])
  })

  it("opens a browser tab it pre-opened, and refuses a path-shaped id", async () => {
    const tab = { location: { href: "" }, closed: false, close: vi.fn(), opener: {} }
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window)
    URL.createObjectURL = vi.fn(() => "blob:x")
    URL.revokeObjectURL = vi.fn()
    const d = deps()
    await buildAppHostCalls(d).openFileById("boxtal", "file-0001", "label.pdf")
    expect(tab.location.href).toBe("blob:x")
    expect(tab.opener).toBeNull()
    await expect(buildAppHostCalls(d).openFileById("boxtal", "../x", "a")).rejects.toThrow()
  })
})

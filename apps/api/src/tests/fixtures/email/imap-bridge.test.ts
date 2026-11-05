// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { installImapFake } from "./imap-bridge"

let controller: ReturnType<typeof installImapFake> | null = null

afterEach(() => {
  controller?.uninstall()
  controller = null
})

describe("imap fake", () => {
  it("queueMessages returns staged messages from next fetch and records calls", async () => {
    controller = installImapFake()
    controller.queueMessages("a@x.test", [
      { messageId: "<i1>", subject: "Hi", from: { email: "a@x.test" } },
    ])
    const fetched = await controller.callFetch("a@x.test", { mode: "incremental" })
    expect(fetched.messages[0].messageId).toBe("<i1>")
    expect(controller.assertFetched("a@x.test")).toHaveLength(1)
  })

  it("messages drain on fetch (second call returns empty)", async () => {
    controller = installImapFake()
    controller.queueMessages("b@x.test", [{ messageId: "<i2>" }])
    await controller.callFetch("b@x.test", { mode: "incremental" })
    const second = await controller.callFetch("b@x.test", { mode: "incremental" })
    expect(second.messages).toHaveLength(0)
  })

  it("injectError throws once then clears", async () => {
    controller = installImapFake()
    controller.injectError("c@x.test", { code: "AUTH", message: "nope" })
    await expect(controller.callFetch("c@x.test", { mode: "incremental" })).rejects.toThrow("nope")
    const ok = await controller.callFetch("c@x.test", { mode: "incremental" })
    expect(ok.messages).toHaveLength(0)
  })

  it("setUidValidity surfaces in fetch result", async () => {
    controller = installImapFake()
    controller.setUidValidity("d@x.test", "9999")
    const r = await controller.callFetch("d@x.test", { mode: "incremental" })
    expect(r.uidValidity).toBe("9999")
  })

  it("uninstall blocks subsequent fetches", async () => {
    controller = installImapFake()
    controller.uninstall()
    const c2 = installImapFake()
    controller = c2
    const fresh = await c2.callFetch("e@x.test", { mode: "incremental" })
    expect(fresh.messages).toHaveLength(0)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createShare, type SharePayload, type SharePlugin } from "./share"

function recordingPlugin(behaviour?: () => Promise<unknown>): {
  plugin: SharePlugin
  sent: SharePayload[]
} {
  const sent: SharePayload[] = []
  return {
    sent,
    plugin: {
      share: async (options) => {
        sent.push(options)
        if (behaviour) return behaviour()
        return undefined
      },
    },
  }
}

describe("the platform share sheet", () => {
  it("passes the title, text and link through", async () => {
    const recorder = recordingPlugin()
    await createShare(recorder.plugin)({
      title: "Ticket 4821",
      text: "Ticket 4821",
      url: "https://acme.example.com/tickets/abc",
    })
    expect(recorder.sent).toEqual([
      {
        title: "Ticket 4821",
        text: "Ticket 4821",
        url: "https://acme.example.com/tickets/abc",
      },
    ])
  })

  it("drops empty fields rather than sending a blank line to the sheet", async () => {
    const recorder = recordingPlugin()
    await createShare(recorder.plugin)({ title: "", text: "", url: "https://example.com/x" })
    expect(recorder.sent).toEqual([{ url: "https://example.com/x" }])
  })

  it("passes a dismissal through, so the web side does not fall back to a copy", async () => {
    const abort = new Error("Share canceled")
    abort.name = "AbortError"
    const recorder = recordingPlugin(async () => {
      throw abort
    })
    await expect(createShare(recorder.plugin)({ url: "https://example.com" })).rejects.toThrow(
      "Share canceled",
    )
  })
})

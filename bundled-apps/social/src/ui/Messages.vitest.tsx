// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The DM compose box rendered: typing then "Approve & send" calls send_dm with
// the conversation and the text, clears the box and re-reads the thread so the
// sent message shows; a refused send shows the platform's reason; a send parked
// by an org policy says it waits for approval, never that it was sent; a
// human-agent window says so on the button.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createResource } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Call = { name: string; params: Record<string, unknown> }
const calls: Call[] = []
let sendResult: () => Promise<unknown> = () => Promise.resolve({ ok: true })
let messages: Array<Record<string, unknown>> = []
let lastInboundAt = new Date().toISOString()

vi.mock("@liaison/host", () => ({
  app: {
    invokeTool: (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params })
      if (name === "send_dm") return sendResult()
      if (name === "dm_get")
        return Promise.resolve({
          conversation: {
            id: "c1",
            platform: "instagram",
            participant_handle: "@fan",
            last_inbound_at: lastInboundAt,
            status: "open",
          },
          messages: [...messages],
        })
      return Promise.reject(new Error(`no ${name}`))
    },
    createResource: (fetcher: () => unknown) => createResource(fetcher),
    trackOpenRecord: () => {},
  },
  fetch: () => Promise.resolve([]),
  navigate: () => {},
}))

const conversation = {
  id: "c1",
  platform: "instagram" as const,
  participant_handle: "@fan",
  last_inbound_at: new Date().toISOString(),
  status: "open",
}

beforeEach(() => {
  calls.length = 0
  lastInboundAt = new Date().toISOString()
  messages = [{ id: "m1", conversation_id: "c1", direction: "inbound", body: "Hi there" }]
  sendResult = () => {
    messages.push({ id: "m2", conversation_id: "c1", direction: "outbound", body: "Thanks!" })
    return Promise.resolve({ ok: true })
  }
})
afterEach(() => cleanup())

async function mount() {
  const { ConversationDetailPanel } = await import("./Messages")
  render(() => <ConversationDetailPanel conversation={conversation} />)
  await screen.findByTestId("social-dm-message-m1")
}

function type(text: string) {
  const box = screen.getByTestId("social-dm-compose-box") as HTMLTextAreaElement
  fireEvent.input(box, { target: { value: text } })
  return box
}

describe("Social DM compose", () => {
  it("is disabled while the box is empty", async () => {
    await mount()
    const send = screen.getByTestId("social-dm-send") as HTMLButtonElement
    expect(send.textContent).toBe("Approve & send")
    expect(send.disabled).toBe(true)
    type("   ")
    expect(send.disabled).toBe(true)
  })

  it("sends send_dm with the conversation and text, clears the box and shows the sent message", async () => {
    await mount()
    const box = type("Thanks!")
    const send = screen.getByTestId("social-dm-send") as HTMLButtonElement
    expect(send.disabled).toBe(false)
    fireEvent.click(send)

    expect(await screen.findByTestId("social-dm-message-m2")).toBeTruthy()
    expect(calls.filter((c) => c.name === "send_dm")).toEqual([
      { name: "send_dm", params: { conversation_id: "c1", body: "Thanks!" } },
    ])
    expect(calls.filter((c) => c.name === "dm_get").length).toBe(2)
    expect(box.value).toBe("")
    expect(screen.getByTestId("social-dm-note").textContent).toBe("Message sent.")
  })

  it("shows the platform's refusal and keeps the text", async () => {
    sendResult = () =>
      Promise.reject(
        new Error("dm_window_closed: the reply window for this conversation has closed"),
      )
    await mount()
    const box = type("Late reply")
    fireEvent.click(screen.getByTestId("social-dm-send"))

    await waitFor(() =>
      expect(screen.getByTestId("social-dm-note").textContent).toContain("dm_window_closed"),
    )
    expect(box.value).toBe("Late reply")
    expect(screen.queryByTestId("social-dm-message-m2")).toBeNull()
  })

  it("says a parked send waits for approval, not that it was sent", async () => {
    sendResult = () => Promise.resolve({ blocked: true, approvalRequestId: "a1" })
    await mount()
    type("Thanks!")
    fireEvent.click(screen.getByTestId("social-dm-send"))

    await waitFor(() =>
      expect(screen.getByTestId("social-dm-note").textContent).toBe("Waiting for approval."),
    )
  })

  it("names the human-agent window on the button", async () => {
    lastInboundAt = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
    await mount()
    expect(screen.getByTestId("social-dm-send").textContent).toBe("Approve & send (human agent)")
  })
})

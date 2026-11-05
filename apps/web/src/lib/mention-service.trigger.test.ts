// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import { agentMentionHandle, searchMentions } from "~/lib/mention-service"

const directory = vi.hoisted(() => ({
  value: [] as Array<{ id: string; handle: string; name: string }>,
}))

vi.mock("~/modules/threads/agent-directory", () => ({
  listAgentDirectory: () => directory.value,
}))

function recordingApi() {
  const paths: string[] = []
  return {
    paths,
    get: async (path: string) => {
      paths.push(path)
      return { data: [] }
    },
  }
}

describe("mention search narrows by trigger", () => {
  it("asks for the addressable set on @, so tasks never crowd out an agent", async () => {
    directory.value = []
    const api = recordingApi()
    await searchMentions(api, "support", "@", 8)
    expect(api.paths[0]).toContain("type=addressable")
  })

  it("asks for the reference set on #, so a bare # is not a page of contacts", async () => {
    // `#` used to send no type at all. Unnarrowed, the page filled with
    // contacts before any channel, task or ticket, and the picker's cap on a
    // secondary kind then left three contact rows and nothing else.
    directory.value = []
    const api = recordingApi()
    await searchMentions(api, "", "#", 8)
    expect(api.paths[0]).toContain("type=reference")
  })

  it("lets an explicit type win over the trigger default", async () => {
    directory.value = []
    const api = recordingApi()
    await searchMentions(api, "support", "@", 8, "user")
    expect(api.paths[0]).toContain("type=user")
  })
})

describe("an agent row is titled by its name, handled underneath", () => {
  it("titles the row with the display name and puts the handle on the second line", async () => {
    directory.value = [{ id: "a-1", handle: "@support", name: "Support Desk" }]
    const api = recordingApi()
    const rows = await searchMentions(api, "sup", "@", 8)
    expect(rows[0]?.label).toBe("Support Desk")
    expect(rows[0]?.secondaryLabel).toBe("@support")
  })

  it("still writes the HANDLE into the message, never the display name", async () => {
    directory.value = [{ id: "a-1", handle: "@support", name: "Support Desk" }]
    const api = recordingApi()
    const rows = await searchMentions(api, "sup", "@", 8)
    expect(agentMentionHandle(rows[0])).toBe("support")
  })

  it("falls back to the handle when an agent carries no name", async () => {
    directory.value = [{ id: "a-2", handle: "@ops", name: "" }]
    const api = recordingApi()
    const rows = await searchMentions(api, "op", "@", 8)
    expect(rows[0]?.label).toBe("ops")
  })
})

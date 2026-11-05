// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Computers > <computer> > Agents: ONE table of the agents that can
// run there (attached ones, then those with only a profile, each once: walk
// D14). Each row: the level (D18, D24, D42, K6, K18), who may ask it, and
// Edit (who may ask, the daily caps, the Liaison tools, the risk note,
// Remove). Raising the level, or choosing Open (always, K18), opens the
// in-app confirmation naming the level, what it allows and the computers it
// applies to; nothing is saved until Confirm, which posts one profile_raise
// confirmation per such computer, then saves with their ids. A raise this
// computer has not confirmed says so, with Confirm.
import type { NodeLevel } from "@liaison/shared"
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import type {
  NodeAttachmentSummary,
  NodeProfileSummary,
  NodeSummary,
} from "~/modules/nodes/node-api"
import { applyNodeFrame, resetNodesStore } from "~/modules/nodes/nodes-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { ComputerAgentsTab } from "./ComputerAgentsTab"

const mac: NodeSummary = {
  id: "n-1",
  name: "Studio Mac",
  enabled: true,
  online: true,
  lastSeenAt: null,
  os: "macos",
  appVersion: null,
  deviceId: "d",
  queue: { queued: 0, running: 0 },
}

function profile(
  level: NodeLevel,
  nodes: Array<[string, string, NodeLevel]>,
  over: Partial<NodeProfileSummary> = {},
): NodeProfileSummary {
  return {
    id: "p-1",
    agentId: "agent-1",
    agentName: "Bug Fixer",
    level,
    liaisonTools: true,
    updatedAt: "2026-10-13T10:00:00.000Z",
    nodes: nodes.map(([nodeId, nodeName, confirmedLevel]) => ({
      nodeId,
      nodeName,
      confirmedLevel,
    })),
    ...over,
  }
}

function attachment(over: Partial<NodeAttachmentSummary> = {}): NodeAttachmentSummary {
  return {
    id: "att-1",
    agentId: "agent-1",
    agentName: "Bug Fixer",
    agentModel: "claude-haiku-4-5",
    allowedRequesters: [],
    maxJobsPerDay: 10,
    maxTokensPerDay: 2_000_000,
    ...over,
  }
}

interface World {
  attachments: NodeAttachmentSummary[]
  profiles: NodeProfileSummary[]
  agents: Array<{ id: string; name: string }>
  nodes?: unknown[]
  attachmentsFail?: boolean
}

interface Fakes {
  put: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  patch: ReturnType<typeof vi.fn>
  del: ReturnType<typeof vi.fn>
}

function renderTab(
  world: World,
  fakes: Partial<Fakes> = {},
  node: NodeSummary = mac,
  locale: "en" | "fr" = "en",
): Fakes {
  let n = 0
  const f: Fakes = {
    put:
      fakes.put ??
      vi.fn(async (_p: string, b: Record<string, unknown>) => ({ agentId: "agent-1", ...b })),
    post:
      fakes.post ??
      vi.fn(async (path: string, b: { nodeId?: string; agentId?: string }) => {
        if (path === "/nodes/me/attachments") {
          const created = attachment({
            id: "att-new",
            agentId: b.agentId as string,
            agentName: "Researcher",
          })
          world.attachments = [...world.attachments, created]
          return created
        }
        return {
          confirmationId: `c-${b.nodeId}-${++n}`,
          expiresAt: "2026-10-13T11:00:00.000Z",
        }
      }),
    get:
      fakes.get ??
      vi.fn(async (path: string) => {
        if (path === "/nodes/me/attachments") {
          if (world.attachmentsFail) throw new ApiError("boom", 500)
          return world.attachments
        }
        if (path === "/nodes/me/profiles") return world.profiles
        if (path === "/agents") return world.agents
        if (path === "/nodes/me") return { nodes: world.nodes ?? [] }
        return null
      }),
    patch:
      fakes.patch ??
      vi.fn(async (path: string, b: Record<string, unknown>) => {
        const id = path.split("/").at(-1)
        world.attachments = world.attachments.map((a) => (a.id === id ? { ...a, ...b } : a))
        return world.attachments.find((a) => a.id === id)
      }),
    del: fakes.del ?? vi.fn(async () => undefined),
  }
  const api = { get: f.get, post: f.post, patch: f.patch, put: f.put, delete: f.del } as never
  render(() => (
    <I18nProvider initialLocale={locale}>
      <ApiContext.Provider value={api}>
        <ComputerAgentsTab node={node} />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return f
}

const dialog = () => screen.queryByTestId("node-level-confirm")
const level = (agentId = "agent-1") =>
  screen.getByTestId(`computer-agent-level-${agentId}`) as HTMLSelectElement
const choose = (value: NodeLevel, agentId = "agent-1") =>
  fireEvent.change(level(agentId), { target: { value } })

afterEach(() => resetNodesStore())

describe("one table of the agents that can run on a computer (walk D14)", () => {
  it("attached agents first, then agents with a profile only, each once, with level and who may ask", async () => {
    renderTab({
      attachments: [
        attachment({
          allowedRequesters: [{ type: "agent", id: "a-sup", name: "Support" }],
        }),
      ],
      profiles: [
        profile("standard", []),
        profile("strict", [], { id: "p-2", agentId: "agent-2", agentName: "Researcher" }),
      ],
      agents: [],
    })
    const rows = await screen.findAllByTestId(/^computer-agent-agent-/)
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "computer-agent-agent-1",
      "computer-agent-agent-2",
    ])
    expect(rows[0].getAttribute("data-attached")).toBe("true")
    expect(rows[0].getAttribute("data-level")).toBe("standard")
    expect(level().value).toBe("standard")
    expect(screen.getByTestId("computer-agent-askers-agent-1").textContent).toBe("You, Support")
    expect(rows[1].getAttribute("data-attached")).toBe("false")
    expect(screen.getByTestId("computer-agent-askers-agent-2").textContent).toBe("Only you")
    // The two former lists are gone.
    expect(screen.queryByText("Agents with a profile, not attached")).toBeNull()
    expect(screen.getByTestId("computer-agents-legend").textContent).toContain(
      "Safest for agents that read mail",
    )
  })

  it("an attachment for another computer is not listed here", async () => {
    renderTab({
      attachments: [attachment({ nodeId: "n-other" })],
      profiles: [],
      agents: [],
    })
    expect(await screen.findByTestId("computer-agents-empty")).toBeTruthy()
  })

  it("in French, the personal agent's default name is said in French (walk D12)", async () => {
    renderTab(
      {
        attachments: [],
        profiles: [profile("strict", [], { agentId: "a-9", agentName: "Personal agent" })],
        agents: [
          { id: "a-9", name: "Personal agent" },
          { id: "a-2", name: "Researcher" },
        ],
      },
      {},
      mac,
      "fr",
    )
    await screen.findByTestId("computer-agent-a-9")
    const page = screen.getByTestId("computer-agents").textContent ?? ""
    expect(page).toContain("Agent personnel")
    expect(page).not.toContain("Personal agent")
  })

  it("a failed read says so with Try again, which reads again", async () => {
    const world: World = { attachments: [attachment()], profiles: [], agents: [] }
    world.attachmentsFail = true
    renderTab(world)
    expect(await screen.findByTestId("computer-agents-error")).toBeTruthy()
    world.attachmentsFail = false
    fireEvent.click(screen.getByText("Try again"))
    expect(await screen.findByTestId("computer-agent-agent-1")).toBeTruthy()
  })

  it("a profile frame reloads the table, and the row shows the new level", async () => {
    const world: World = {
      attachments: [attachment()],
      profiles: [profile("strict", [])],
      agents: [],
    }
    renderTab(world)
    await screen.findByTestId("computer-agent-agent-1")
    world.profiles = [profile("standard", [])]
    applyNodeFrame({ ownerUserId: "me", nodeId: "n-1", change: "profile" })
    await waitFor(() => expect(level().value).toBe("standard"))
  })

  it("Add an agent attaches one; Remove detaches it", async () => {
    const world: World = {
      attachments: [attachment()],
      profiles: [],
      agents: [
        { id: "agent-1", name: "Bug Fixer" },
        { id: "a-2", name: "Researcher" },
      ],
    }
    const f = renderTab(world)
    fireEvent.click(await screen.findByTestId("computer-agents-add"))
    const select = screen.getByTestId("computer-agents-attach-agent") as HTMLSelectElement
    // An agent already in the table is not offered again.
    expect([...select.options].map((o) => o.value)).toEqual(["", "a-2"])
    fireEvent.change(select, { target: { value: "a-2" } })
    fireEvent.click(screen.getByTestId("computer-agents-attach-submit"))
    await screen.findByTestId("computer-agent-a-2")
    expect(f.post).toHaveBeenCalledWith("/nodes/me/attachments", { agentId: "a-2" })
    fireEvent.click(screen.getByTestId("computer-agent-edit-agent-1"))
    fireEvent.click(screen.getByTestId("computer-agent-detach-att-1"))
    await waitFor(() => expect(screen.queryByTestId("computer-agent-agent-1")).toBeNull())
    expect(f.del).toHaveBeenCalledWith("/nodes/attachments/att-1")
  })

  it("Edit: who may ask it is saved, the row stays open, and the caps are there", async () => {
    const f = renderTab({
      attachments: [attachment()],
      profiles: [],
      agents: [
        { id: "agent-1", name: "Bug Fixer" },
        { id: "a-sup", name: "Support" },
      ],
    })
    fireEvent.click(await screen.findByTestId("computer-agent-edit-agent-1"))
    expect((screen.getByTestId("node-caps-jobs-att-1") as HTMLInputElement).value).toBe("10")
    fireEvent.click(screen.getByTestId("computer-requester-agent-1-a-sup"))
    fireEvent.click(screen.getByTestId("computer-requesters-save-agent-1"))
    await waitFor(() =>
      expect(f.patch).toHaveBeenCalledWith("/nodes/attachments/att-1", {
        allowedRequesters: [{ type: "agent", id: "a-sup" }],
      }),
    )
    expect(screen.getByTestId("computer-agent-editor-agent-1")).toBeTruthy()
  })

  it("keeps row buttons at their own width (a full-width button squeezed the row)", async () => {
    renderTab({ attachments: [attachment()], profiles: [], agents: [] })
    fireEvent.click(await screen.findByTestId("computer-agent-edit-agent-1"))
    const cls = screen.getByTestId("computer-agent-detach-att-1").className.split(/\s+/)
    expect(cls).not.toContain("w-full")
    expect(cls).toContain("shrink-0")
  })
})

describe("the level, set here only (D18, D24, D42, K6, K18)", () => {
  const one = (p: NodeProfileSummary | null, model = "claude-haiku-4-5"): World => ({
    attachments: [attachment({ agentModel: model })],
    profiles: p ? [p] : [],
    agents: [],
  })

  it("the risk note suggests Strict for a Haiku agent and never names an agent or GitHub", async () => {
    renderTab(one(null))
    fireEvent.click(await screen.findByTestId("computer-agent-edit-agent-1"))
    const note = screen.getByTestId("computer-agent-risk-agent-1").textContent ?? ""
    expect(note).toContain("Untrusted input (mail, tickets, web pages)")
    expect(note).toContain("Suggested for this agent's model: Strict")
    expect(note).not.toContain("Bug Fixer")
    expect(note).not.toContain("GitHub")
    const strict = [...level().options].find((o) => o.value === "strict")
    expect(strict?.textContent).toBe("Strict (suggested)")
    // No profile yet: it runs at Strict.
    expect(level().value).toBe("strict")
  })

  it("suggests Standard for an Opus agent, never Open", async () => {
    renderTab(one(null, "claude-opus-5-5"))
    await screen.findByTestId("computer-agent-agent-1")
    const labels = [...level().options].map((o) => o.textContent)
    expect(labels).toContain("Standard (suggested)")
    expect(labels).toContain("Open")
  })

  it("raising Strict to Standard opens the dialog and saves nothing until Confirm", async () => {
    const f = renderTab(one(profile("strict", [["n-1", "Studio Mac", "strict"]])))
    await screen.findByTestId("computer-agent-agent-1")
    choose("standard")
    const d = await screen.findByTestId("node-level-confirm")
    expect(d.textContent).toContain("Raise Bug Fixer to Standard?")
    expect(d.textContent).toContain(
      "Reads and writes anywhere outside your secrets, open network, in the sandbox.",
    )
    expect(d.textContent).toContain("Studio Mac")
    expect(f.post).not.toHaveBeenCalled()
    expect(f.put).not.toHaveBeenCalled()
  })

  it("Confirm posts one confirmation per enabled computer then saves with their ids", async () => {
    const f = renderTab(
      one(
        profile("strict", [
          ["n-1", "Studio Mac", "strict"],
          ["n-2", "Laptop", "strict"],
        ]),
      ),
    )
    await screen.findByTestId("computer-agent-agent-1")
    choose("standard")
    fireEvent.click(await screen.findByTestId("node-level-confirm-yes"))
    await waitFor(() => expect(f.put).toHaveBeenCalledTimes(1))
    expect(f.post.mock.calls.map((c) => c[1])).toEqual([
      { nodeId: "n-1", agentId: "agent-1", level: "standard", purpose: "profile_raise" },
      { nodeId: "n-2", agentId: "agent-1", level: "standard", purpose: "profile_raise" },
    ])
    expect(f.put.mock.calls[0]?.[0]).toBe("/nodes/me/profiles/agent-1")
    expect(f.put.mock.calls[0]?.[1]).toEqual({
      level: "standard",
      liaisonTools: true,
      confirmationIds: ["c-n-1-1", "c-n-2-2"],
    })
    await waitFor(() => expect(dialog()).toBeNull())
    expect(screen.getByTestId("computer-agent-saved-agent-1").textContent).toContain(
      "all your computers",
    )
  })

  it("a second Confirm click while the save is in flight posts nothing more (m8)", async () => {
    let release: (v: unknown) => void = () => {}
    const put = vi.fn(
      (_p: string, b: Record<string, unknown>) =>
        new Promise((resolve) => {
          release = () => resolve({ agentId: "agent-1", ...b })
        }),
    )
    const f = renderTab(one(profile("strict", [["n-1", "Studio Mac", "strict"]])), { put })
    await screen.findByTestId("computer-agent-agent-1")
    choose("standard")
    const yes = await screen.findByTestId("node-level-confirm-yes")
    fireEvent.click(yes)
    await waitFor(() => expect(f.put).toHaveBeenCalledTimes(1))
    const again = screen.queryByTestId("node-level-confirm-yes")
    if (again) {
      expect((again as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(again)
    }
    fireEvent.click(yes)
    await new Promise((r) => setTimeout(r, 20))
    expect(f.post).toHaveBeenCalledTimes(1)
    expect(f.put).toHaveBeenCalledTimes(1)
    release(undefined)
    await waitFor(() => expect(screen.getByTestId("computer-agent-saved-agent-1")).toBeTruthy())
  })

  it("Cancel saves nothing and puts the level back", async () => {
    const f = renderTab(one(profile("strict", [["n-1", "Studio Mac", "strict"]])))
    await screen.findByTestId("computer-agent-agent-1")
    choose("standard")
    fireEvent.click(await screen.findByTestId("node-level-confirm-cancel"))
    await waitFor(() => expect(dialog()).toBeNull())
    expect(f.post).not.toHaveBeenCalled()
    expect(f.put).not.toHaveBeenCalled()
    expect(level().value).toBe("strict")
  })

  it("lowering saves with no dialog", async () => {
    const f = renderTab(one(profile("standard", [["n-1", "Studio Mac", "standard"]])))
    await screen.findByTestId("computer-agent-agent-1")
    choose("strict")
    await waitFor(() => expect(f.put).toHaveBeenCalledTimes(1))
    expect(dialog()).toBeNull()
    expect(f.post).not.toHaveBeenCalled()
    expect(f.put.mock.calls[0]?.[1]).toEqual({ level: "strict", liaisonTools: true })
  })

  it("the Liaison tools switch (in Edit) is saved with the saved level", async () => {
    const f = renderTab(one(profile("strict", [["n-1", "Studio Mac", "strict"]])))
    fireEvent.click(await screen.findByTestId("computer-agent-edit-agent-1"))
    fireEvent.click(screen.getByTestId("computer-agent-tools-agent-1"))
    await waitFor(() => expect(f.put).toHaveBeenCalledTimes(1))
    expect(f.put.mock.calls[0]?.[1]).toEqual({ level: "strict", liaisonTools: false })
  })

  it("Open always asks, also when the saved level is already Open", async () => {
    const f = renderTab(one(profile("open", [["n-1", "Studio Mac", "open"]])))
    fireEvent.click(await screen.findByTestId("computer-agent-edit-agent-1"))
    fireEvent.click(screen.getByTestId("computer-agent-tools-agent-1"))
    const d = await screen.findByTestId("node-level-confirm")
    expect(d.textContent).toContain("Raise Bug Fixer to Open?")
    expect(d.textContent).toContain("A plain Claude Code session")
    expect(f.put).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("node-level-confirm-yes"))
    await waitFor(() => expect(f.put).toHaveBeenCalledTimes(1))
    expect(f.put.mock.calls[0]?.[1]).toMatchObject({ level: "open", confirmationIds: ["c-n-1-1"] })
  })

  it("this computer below the saved Standard says so with Confirm, which re-saves Standard with its confirmation alone", async () => {
    const f = renderTab(
      one(
        profile("standard", [
          ["n-2", "Laptop", "standard"],
          ["n-1", "Studio Mac", "strict"],
        ]),
      ),
    )
    const line = await screen.findByTestId("computer-agent-unconfirmed-agent-1")
    expect(line.textContent).toContain("Raised from Strict: confirm it for Studio Mac")
    fireEvent.click(screen.getByTestId("computer-agent-confirm-agent-1"))
    const d = await screen.findByTestId("node-level-confirm")
    expect(d.textContent).toContain("Studio Mac")
    expect(d.textContent).not.toContain("Laptop")
    fireEvent.click(screen.getByTestId("node-level-confirm-yes"))
    await waitFor(() => expect(f.put).toHaveBeenCalledTimes(1))
    expect(f.post.mock.calls[0]?.[1]).toEqual({
      nodeId: "n-1",
      agentId: "agent-1",
      level: "standard",
      purpose: "profile_raise",
    })
    expect(f.put.mock.calls[0]?.[1]).toEqual({
      level: "standard",
      liaisonTools: true,
      confirmationIds: ["c-n-1-1"],
    })
    await waitFor(() =>
      expect(screen.queryByTestId("computer-agent-unconfirmed-agent-1")).toBeNull(),
    )
  })

  it("another computer's missing confirmation is not this page's line", async () => {
    renderTab(
      one(
        profile("standard", [
          ["n-1", "Studio Mac", "standard"],
          ["n-2", "Laptop", "strict"],
        ]),
      ),
    )
    await screen.findByTestId("computer-agent-agent-1")
    expect(screen.queryByTestId("computer-agent-unconfirmed-agent-1")).toBeNull()
  })

  it("a computer already pinned at Standard is not asked again", async () => {
    const f = renderTab(
      one(
        profile("standard", [
          ["n-1", "Studio Mac", "standard"],
          ["n-2", "Laptop", "strict"],
        ]),
      ),
    )
    // Only the Liaison tools change: the Laptop still needs its confirmation,
    // the Studio Mac (pinned at Standard) is not asked.
    fireEvent.click(await screen.findByTestId("computer-agent-edit-agent-1"))
    fireEvent.click(screen.getByTestId("computer-agent-tools-agent-1"))
    const d = await screen.findByTestId("node-level-confirm")
    expect(d.textContent).toContain("Laptop")
    expect(d.textContent).not.toContain("Studio Mac")
    fireEvent.click(screen.getByTestId("node-level-confirm-yes"))
    await waitFor(() => expect(f.put).toHaveBeenCalledTimes(1))
    expect(f.post.mock.calls.map((c) => (c[1] as { nodeId: string }).nodeId)).toEqual(["n-2"])
  })

  it("a 403 confirmation_required (a computer enrolled meanwhile) asks again for the ones that need it", async () => {
    let first = true
    const put = vi.fn(async (_p: string, b: Record<string, unknown>) => {
      if (first) {
        first = false
        throw new ApiError("Confirm this level", 403, "confirmation_required")
      }
      return { agentId: "agent-1", ...b }
    })
    const world = one(profile("strict", [["n-1", "Studio Mac", "strict"]]))
    const f = renderTab(world, { put })
    await screen.findByTestId("computer-agent-agent-1")
    world.profiles = [
      profile("strict", [
        ["n-1", "Studio Mac", "strict"],
        ["n-3", "New Mini", "strict"],
      ]),
    ]
    choose("standard")
    fireEvent.click(await screen.findByTestId("node-level-confirm-yes"))
    await waitFor(() =>
      expect(screen.getByTestId("node-level-confirm").textContent).toContain("New Mini"),
    )
    fireEvent.click(screen.getByTestId("node-level-confirm-yes"))
    await waitFor(() => expect(f.put).toHaveBeenCalledTimes(2))
    expect(f.put.mock.calls[1]?.[1]).toMatchObject({ level: "standard" })
    expect((f.put.mock.calls[1][1] as { confirmationIds: string[] }).confirmationIds).toHaveLength(
      2,
    )
  })

  it("an agent with no saved profile yet asks for each of the owner's enabled computers", async () => {
    const world = one(null)
    world.nodes = [
      { id: "n-1", name: "Studio Mac", enabled: true },
      { id: "n-9", name: "Old box", enabled: false },
    ]
    const f = renderTab(world)
    await screen.findByTestId("computer-agent-agent-1")
    choose("standard")
    const d = await screen.findByTestId("node-level-confirm")
    expect(d.textContent).toContain("Studio Mac")
    expect(d.textContent).not.toContain("Old box")
    expect(f.put).not.toHaveBeenCalled()
  })

  it("a failed confirmation keeps the shared dialog open with the error", async () => {
    const post = vi.fn(async () => {
      throw new ApiError("expired", 410)
    })
    const f = renderTab(one(profile("strict", [["n-1", "Studio Mac", "strict"]])), { post })
    await screen.findByTestId("computer-agent-agent-1")
    choose("standard")
    const d = await screen.findByTestId("node-level-confirm")
    expect(d.getAttribute("data-purpose")).toBe("profile_raise")
    fireEvent.click(screen.getByTestId("node-level-confirm-yes"))
    expect((await screen.findByTestId("node-level-confirm-error")).textContent).toContain("expired")
    expect(dialog()).not.toBeNull()
    expect(f.put).not.toHaveBeenCalled()
  })
})

// P1-walk D6, D7: two computers both named "Mac": the dialog names this one
// so the two can be told apart, and Confirm on it saves for it alone.
describe("computers with the same name, confirmed one at a time (D6, D7)", () => {
  const now = Date.now()
  const twoMacs = () =>
    profile("standard", [], {
      nodes: [
        {
          nodeId: "n-old",
          nodeName: "Mac",
          confirmedLevel: "strict",
          lastSeenAt: "2026-10-12T09:00:00.000Z",
        },
        {
          nodeId: "n-new",
          nodeName: "Mac",
          confirmedLevel: "strict",
          lastSeenAt: new Date(now - 30_000).toISOString(),
        },
      ],
    })

  it("Confirm on this computer saves for it alone, named apart from the other Mac", async () => {
    const f = renderTab(
      { attachments: [attachment()], profiles: [twoMacs()], agents: [] },
      {
        put: vi.fn(async (_p: string, b: Record<string, unknown>) => ({
          agentId: "agent-1",
          ...b,
          unconfirmedNodeIds: ["n-old"],
        })),
      },
      { ...mac, id: "n-new", name: "Mac" },
    )
    fireEvent.click(await screen.findByTestId("computer-agent-confirm-agent-1"))
    const d = await screen.findByTestId("node-level-confirm")
    expect(within(d).getByText(/Mac \(active now\)/)).toBeTruthy()
    expect(d.textContent).not.toContain("Mac, Mac")
    fireEvent.click(screen.getByTestId("node-level-confirm-yes"))
    await waitFor(() => expect(f.put).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.queryByTestId("computer-agent-unconfirmed-agent-1")).toBeNull(),
    )
    expect(dialog()).toBeNull()
    expect(f.post).toHaveBeenCalledTimes(1)
  })
})

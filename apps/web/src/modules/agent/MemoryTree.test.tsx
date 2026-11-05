// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * P4m-T30: the memory tree file browser and the in place Markdown editor.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import {
  episodeDateOfPath,
  memoryRowLabel,
  memoryRowParts,
  resetAgentMemoryStore,
} from "~/modules/agent/agent-memory-store"
import MemoryTree from "~/modules/agent/MemoryTree"
import { resetMemoriesStore } from "~/modules/agent/memories-store"
import { setMarkdown } from "~/modules/editor/test-helpers"
import { ApiContext } from "~/modules/shell/ApiContext"

const AGENT = "11111111-1111-4111-8111-111111111111"

// `kernel:agents:admin` is the one scope these tests steer: it decides whether
// a memory row shows a raw scope name or its capability category (P4c FX-F3).
let scopeAdmin = false
vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: (scope: string) => (scope === "kernel:agents:admin" ? scopeAdmin : true),
  userFromToken: () => null,
}))

function file(path: string, extra: Record<string, unknown> = {}) {
  return {
    path,
    name: path.replace(/\.md$/, "").split("/").pop() ?? path,
    description: `desc ${path}`,
    type: path.startsWith("episodes/") ? "episode" : "project",
    modified: "2026-09-13",
    requiredScopes: [],
    ...extra,
  }
}

const DEFAULT_FILES = [
  file("checkpoints/logistics.md"),
  file("episodes/logistics/2026-09-01.md"),
  file("project/one.md"),
  file("MEMORY.md", { type: "_index", name: "MEMORY" }),
]

interface SetupOptions {
  files?: unknown[]
  index?: unknown
  bodies?: Record<string, string>
  /** P4m-T31: the search route's answer, and the status it refuses with. */
  hits?: unknown[]
  searchStatus?: number
  forgetStatus?: number
  agentName?: string
}

function setup(opts: SetupOptions = {}) {
  const bodies = opts.bodies ?? { "project/one.md": "Original body." }
  const api: any = {
    get: vi.fn(async (path: string) => {
      if (path.includes("/memory/search")) {
        if (opts.searchStatus) throw new ApiError("nope", opts.searchStatus)
        return { hits: opts.hits ?? [] }
      }
      if (path.includes("/memory/tree")) {
        return {
          files: opts.files ?? DEFAULT_FILES,
          index: opts.index ?? { lines: 4, nearLimit: false, full: false },
        }
      }
      if (path.includes("/memory/file")) {
        const wanted = decodeURIComponent(path.split("path=")[1] ?? "")
        return { path: wanted, content: bodies[wanted] ?? "" }
      }
      return null
    }),
    post: vi.fn(async (path: string) => {
      if (path.includes("/memory/forget")) {
        if (opts.forgetStatus) throw new ApiError("nope", opts.forgetStatus)
        return { episodesDeleted: 1, checkpointsDeleted: 1 }
      }
      return null
    }),
    put: vi.fn(),
    patch: vi.fn(async (_path: string, body: any) => ({ path: body.path, content: body.content })),
    delete: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <MemoryTree agentId={AGENT} agentName={opts.agentName ?? "Logistics"} />
    </ApiContext.Provider>
  ))
  return api
}

describe("MemoryTree (P4m-T30)", () => {
  beforeEach(() => resetAgentMemoryStore())
  afterEach(() => cleanup())

  it("the tree renders MEMORY.md first then type folders then episodes then checkpoints", async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId("agent-memory-group-index")).toBeInTheDocument())
    const headers = screen.getAllByTestId(/^agent-memory-group-/).map((el) => el.textContent)
    expect(headers).toEqual(["Index", "Topics", "Earlier chats", "Conversation summaries"])
  })

  // A14: the metadata list printed `requiredScopes` verbatim, so a memory row
  // carrying one put a literal `kernel:...` on screen for every reader.
  it("a member sees categories, never a scope name, on a skill, a routine and a memory row", async () => {
    scopeAdmin = false
    setup({
      files: [
        file("project/one.md", { requiredScopes: ["kernel:agents:read", "tickets:tickets:write"] }),
      ],
    })
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-file-project/one.md")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-project/one.md"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-scopes")).toBeInTheDocument())
    expect(screen.getByTestId("agent-memory-scopes").textContent).toBe("kernel, tickets")
    expect(document.body.textContent).not.toContain("kernel:agents:read")
  })

  it("an admin still sees the scope", async () => {
    scopeAdmin = true
    setup({ files: [file("project/one.md", { requiredScopes: ["kernel:agents:read"] })] })
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-file-project/one.md")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-project/one.md"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-scopes")).toBeInTheDocument())
    expect(screen.getByTestId("agent-memory-scopes").textContent).toBe("kernel:agents:read")
    scopeAdmin = false
  })

  it("editing a topic file in place saves it and stamps sourceKind human", async () => {
    const api = setup()
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-file-project/one.md")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-project/one.md"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-edit")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("agent-memory-edit"))
    setMarkdown(await screen.findByTestId("agent-memory-editor-input"), "# Corrected body")
    fireEvent.click(screen.getByTestId("agent-memory-save"))
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(api.patch.mock.calls[0][0]).toBe(`/agents/${AGENT}/memory/file`)
    expect(api.patch.mock.calls[0][1]).toEqual({
      path: "project/one.md",
      content: "# Corrected body",
      sourceKind: "human",
    })
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-body").textContent).toContain("Corrected body"),
    )
  })

  // Edit before the file had arrived opened an empty draft, and saving it wrote
  // the file over with only what was typed.
  it("Edit waits for the file's text before it opens", async () => {
    const api = setup()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const read = api.get.getMockImplementation()
    api.get.mockImplementation(async (path: string) => {
      if (path.includes("/memory/file")) await held
      return read(path)
    })
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-file-project/one.md")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-project/one.md"))
    const edit = (await screen.findByTestId("agent-memory-edit")) as HTMLButtonElement
    expect(edit.disabled).toBe(true)
    release()
    await waitFor(() => expect(edit.disabled).toBe(false))
    fireEvent.click(edit)
    const field = await screen.findByTestId("agent-memory-editor-input")
    expect(field.textContent).toContain("Original body.")
  })

  // The group used to be permanently empty: the tree route read `agent_memory`
  // only, and a checkpoint lives in `kernel.agent_thread_checkpoints`. The
  // server now sends one row per thread, carrying the THREAD's name and no
  // description, so the row reads as the conversation it summarizes.
  it("the conversation summaries group lists a row per thread, named by the thread", async () => {
    setup({
      files: [
        file("checkpoints/logistics.md", {
          type: "checkpoint",
          name: "Logistics room",
          description: "",
          threadHandle: "logistics",
        }),
        file("project/one.md"),
      ],
    })
    const section = await screen.findByTestId("agent-memory-section-checkpoints")
    const row = await screen.findByTestId("agent-memory-file-checkpoints/logistics.md")
    expect(section).toContainElement(row)
    expect(row.textContent).toContain("Logistics room")
    expect(screen.queryByTestId("agent-memory-group-empty-checkpoints")).toBeNull()
  })

  it("a checkpoint file renders read only", async () => {
    setup({ bodies: { "checkpoints/logistics.md": "A summary." } })
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-file-checkpoints/logistics.md")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-checkpoints/logistics.md"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-readonly")).toBeInTheDocument())
    expect(screen.queryByTestId("agent-memory-edit")).toBeNull()
    expect(screen.queryByTestId("agent-memory-editor-input")).toBeNull()
  })

  it("the index past the nag line renders the near limit notice", async () => {
    setup({ index: { lines: 172, nearLimit: true, full: false } })
    await waitFor(() => expect(screen.getByTestId("agent-memory-index-nag")).toBeInTheDocument())
    expect(screen.getByTestId("agent-memory-index-nag").textContent).toContain("172")
    expect(screen.queryByTestId("agent-memory-index-full")).toBeNull()
  })

  it("a full index renders the exact refusal copy", async () => {
    setup({ index: { lines: 200, nearLimit: true, full: true } })
    await waitFor(() => expect(screen.getByTestId("agent-memory-index-full")).toBeInTheDocument())
    expect(screen.getByTestId("agent-memory-index-full").textContent).toBe(
      "MEMORY.md is full. Merge or remove an entry before adding one.",
    )
    expect(screen.queryByTestId("agent-memory-index-nag")).toBeNull()
  })
})

/**
 * P4m-T31: the Memory tab search box and "Forget this conversation".
 *
 * The two backend calls this drives are the REST counterparts of the
 * `memory_search` verb and of the per thread forget; see the contract block on
 * `AgentProfile.tsx`. A backend without them answers 404, which is a VISIBLE
 * refusal here rather than a silent empty result: an empty answer would read
 * as "the agent remembers nothing about this", which is a different claim.
 */
describe("MemoryTree search and forget (P4m-T31)", () => {
  beforeEach(() => resetAgentMemoryStore())
  afterEach(() => cleanup())

  const HITS = [
    {
      kind: "file",
      key: "row:1",
      path: "project/carrier.md",
      description: "The carrier account",
      snippet: "account 55123",
      requiredScopes: [],
      rowId: "r1",
      fusedScore: 0.9,
    },
    {
      kind: "episode",
      key: "row:2",
      path: "episodes/logistics/2026-09-01.md",
      description: "Logistics, 1 September",
      snippet: "we agreed on the carrier",
      requiredScopes: [],
      rowId: "r2",
      fusedScore: 0.5,
    },
    {
      kind: "transcript",
      key: "message:m1",
      messageId: "m1",
      threadHandle: "@logistics",
      author: "Taylor",
      date: "2026-09-01",
      snippet: "the carrier account is 55123",
      requiredScopes: [],
      fusedScore: 0.3,
    },
  ]

  function runSearch(query: string) {
    const input = screen.getByTestId("agent-memory-search-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: query } })
    fireEvent.click(screen.getByTestId("agent-memory-search-run"))
  }

  it("the search box calls the search route and groups the hits by kind", async () => {
    const api = setup({ hits: HITS })
    await waitFor(() => expect(screen.getByTestId("agent-memory-group-index")).toBeInTheDocument())
    runSearch("carrier account")
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-search-results")).toBeInTheDocument(),
    )
    const searchCall = api.get.mock.calls.find((c: any[]) =>
      String(c[0]).includes("/memory/search"),
    )
    expect(searchCall).toBeDefined()
    expect(String(searchCall[0])).toBe(
      `/agents/${AGENT}/memory/search?q=${encodeURIComponent("carrier account")}`,
    )
    const groups = screen.getAllByTestId(/^agent-memory-search-group-/).map((el) => el.dataset.kind)
    expect(groups).toEqual(["file", "episode", "transcript"])
    // A memory hit cites its path; a transcript hit cites thread, date, author.
    expect(screen.getByTestId("agent-memory-search-hit-row:1").textContent).toContain(
      "project/carrier.md",
    )
    const transcript = screen.getByTestId("agent-memory-search-hit-message:m1").textContent ?? ""
    expect(transcript).toContain("@logistics")
    expect(transcript).toContain("2026-09-01")
    expect(transcript).toContain("the carrier account is 55123")
  })

  it("a backend without the search route says so instead of showing no results", async () => {
    setup({ searchStatus: 404 })
    await waitFor(() => expect(screen.getByTestId("agent-memory-group-index")).toBeInTheDocument())
    runSearch("carrier")
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-search-unavailable")).toBeInTheDocument(),
    )
    expect(screen.queryByTestId("agent-memory-search-results")).toBeNull()
  })

  it("the forget confirmation renders the exact normative string with the agent name", async () => {
    setup({ agentName: "Logistics" })
    await waitFor(() =>
      expect(
        screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-forget")).toBeInTheDocument())
    expect(screen.getByTestId("agent-memory-forget").textContent).toBe("Forget this conversation")
    fireEvent.click(screen.getByTestId("agent-memory-forget"))
    expect(screen.getByTestId("agent-memory-forget-confirm-text").textContent).toBe(
      "This removes what Logistics remembers from this conversation. Messages stay.",
    )
  })

  // Card 40 round 11: Cancelling the confirm stranded the whole tab. The
  // confirm was swapped for a flat list of EVERY remembered conversation, each
  // with its own destructive Forget link, and that list replaced the tree and
  // the open file until a reload. Cancel is a full step back now.
  it("cancelling the forget confirm restores the tree, the open file and the header control", async () => {
    setup({ agentName: "Logistics" })
    await waitFor(() =>
      expect(
        screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"),
      ).toBeInTheDocument(),
    )
    // Nothing open: no conversation is current, so the header offers nothing.
    expect(screen.queryByTestId("agent-memory-forget")).toBeNull()

    fireEvent.click(screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-forget")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("agent-memory-forget"))

    // The confirm renders in place of the header control.
    expect(screen.getByTestId("agent-memory-forget-confirm-text")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-memory-forget")).toBeNull()

    fireEvent.click(screen.getByTestId("agent-memory-forget-cancel"))

    // Back to exactly what was on screen before the click.
    expect(screen.queryByTestId("memory-forget-panel")).toBeNull()
    expect(screen.getByTestId("agent-memory-group-index")).toBeInTheDocument()
    expect(
      screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"),
    ).toBeInTheDocument()
    expect(screen.getByTestId("agent-memory-open-path").textContent).toBe(
      "episodes/logistics/2026-09-01.md",
    )
    expect(screen.getByTestId("agent-memory-forget")).toBeInTheDocument()
    // And no per conversation Forget link anywhere on screen.
    expect(screen.queryByTestId("memory-forget-thread-logistics")).toBeNull()
  })

  it("confirming the forget calls the route for that thread and renders what it removed", async () => {
    const api = setup({ agentName: "Logistics" })
    await waitFor(() =>
      expect(
        screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-forget")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("agent-memory-forget"))
    fireEvent.click(screen.getByTestId("agent-memory-forget-confirm"))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][0]).toBe(`/agents/${AGENT}/memory/forget`)
    expect(api.post.mock.calls[0][1]).toEqual({ threadHandle: "logistics" })
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-forget-result")).toBeInTheDocument(),
    )
    // The rows the forget removed are gone from the tree without a reload.
    expect(screen.queryByTestId("agent-memory-file-episodes/logistics/2026-09-01.md")).toBeNull()
    expect(screen.queryByTestId("agent-memory-file-checkpoints/logistics.md")).toBeNull()
  })

  it("a backend without the forget route refuses visibly and keeps the rows", async () => {
    setup({ agentName: "Logistics", forgetStatus: 404 })
    await waitFor(() =>
      expect(
        screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-forget")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("agent-memory-forget"))
    fireEvent.click(screen.getByTestId("agent-memory-forget-confirm"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-forget-error")).toBeInTheDocument())
    expect(
      screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"),
    ).toBeInTheDocument()
  })

  // Card 40: "here we have a 'Forget this conversation' button while a fresh
  // entry is being created, doesn't make sense."
  it("the New memory form hides Forget this conversation", async () => {
    setup({ agentName: "Logistics" })
    await waitFor(() =>
      expect(
        screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-forget")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("agent-memory-new"))

    await waitFor(() => expect(screen.getByTestId("agent-memory-create")).toBeInTheDocument())
    expect(screen.queryByTestId("agent-memory-forget")).toBeNull()
  })

  // Card 40 round 11: the form mounts at the top of the column that scrolls,
  // so with the tree scrolled down New memory looked dead: the form was there,
  // out of view. It brings itself into view on open.
  it("New memory scrolls its form into view when the tree column is scrolled", async () => {
    // `test-setup.ts` polyfills it on HTMLElement, so that is the prototype
    // the call actually resolves against.
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: () => void }
    const original = proto.scrollIntoView
    const spy = vi.fn()
    proto.scrollIntoView = spy
    try {
      setup()
      await waitFor(() => expect(screen.getByTestId("agent-memory-new")).toBeInTheDocument())
      const list = screen.getByTestId("agent-memory-list")
      list.scrollTop = 400
      spy.mockClear()

      fireEvent.click(screen.getByTestId("agent-memory-new"))

      const form = await screen.findByTestId("agent-memory-create")
      expect(form).toBeInTheDocument()
      await waitFor(() => expect(spy).toHaveBeenCalled())
      expect(spy.mock.instances).toContain(form)
      expect(list.scrollTop).toBe(0)
    } finally {
      proto.scrollIntoView = original
    }
  })

  // Card 40: with an episode open, "Forget this conversation" was on screen
  // TWICE, once in the header row and once in red above the file's body.
  it("offers Forget ONCE, and its confirm replaces the control rather than joining it", async () => {
    setup({ agentName: "Logistics" })
    await waitFor(() =>
      expect(
        screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-forget")).toBeInTheDocument())

    // ONE control on the screen, not one per surface.
    expect(screen.getAllByText("Forget this conversation")).toHaveLength(1)

    fireEvent.click(screen.getByTestId("agent-memory-forget"))
    // The confirm stands IN PLACE of it.
    expect(screen.queryByTestId("agent-memory-forget")).toBeNull()
    expect(screen.getByTestId("agent-memory-forget-confirm-text")).toBeInTheDocument()
    expect(screen.queryAllByText("Forget this conversation")).toHaveLength(0)
  })

  it("a topic file offers no forget action", async () => {
    setup()
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-file-project/one.md")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-project/one.md"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-edit")).toBeInTheDocument())
    expect(screen.queryByTestId("agent-memory-forget")).toBeNull()
  })
})

/**
 * P4c FX-F1: the create, the type pick, the delete and the `[[name]]` link
 * resolution the unmounted flat screens (`MemoriesList` / `MemoryDetail`) used
 * to be the only home for. They are the Memory tab's now, over the SAME typed
 * memory routes those screens called: `POST /api/agent/memories` and
 * `DELETE /api/agent/memories/:type/:name`. The tree is the reader of record,
 * so both mutations reload it.
 */
describe("MemoryTree create and delete (P4c FX-F1)", () => {
  beforeEach(() => {
    resetAgentMemoryStore()
    resetMemoriesStore()
  })
  afterEach(() => cleanup())

  interface CrudOptions {
    typed?: Array<Record<string, unknown>>
    selected?: string
  }

  /** A tree whose rows follow the typed memory rows, as the backend renders
   *  them (`<type>/<name>.md`), so a create and a delete are visible in it. */
  function setupCrud(opts: CrudOptions = {}) {
    const typed: Array<Record<string, unknown>> = [...(opts.typed ?? [])]
    const treeFiles = () =>
      typed.map((m) =>
        file(`${m.type}/${m.name}.md`, { type: m.type, name: m.name, description: m.description }),
      )
    const api: any = {
      get: vi.fn(async (path: string) => {
        if (path === "/agent/memories") return typed
        if (path.includes("/memory/search")) return { hits: [] }
        if (path.includes("/memory/tree")) {
          return { files: treeFiles(), index: { lines: 1, nearLimit: false, full: false } }
        }
        if (path.includes("/memory/file")) {
          const wanted = decodeURIComponent(path.split("path=")[1] ?? "")
          const row = typed.find((m) => `${m.type}/${m.name}.md` === wanted)
          return { path: wanted, content: (row?.content as string) ?? "" }
        }
        return null
      }),
      post: vi.fn(async (path: string, body: any) => {
        if (path === "/agent/memories") {
          typed.push({ ...body })
          return { ...body }
        }
        return null
      }),
      put: vi.fn(),
      patch: vi.fn(async (_path: string, body: any) => ({
        path: body.path,
        content: body.content,
      })),
      delete: vi.fn(async (path: string) => {
        const parts = path.split("/")
        const name = parts.pop()
        const type = parts.pop()
        const idx = typed.findIndex((m) => m.type === type && m.name === name)
        if (idx !== -1) typed.splice(idx, 1)
        return null
      }),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <MemoryTree agentId={AGENT} agentName="Logistics" selected={opts.selected} />
      </ApiContext.Provider>
    ))
    return api
  }

  it("the Memory tab creates a memory with a type and deletes it", async () => {
    const api = setupCrud()
    await waitFor(() => expect(screen.getByTestId("agent-memory-new")).toBeInTheDocument())

    // Create, with the type picked on the form the flat screen used to own.
    fireEvent.click(screen.getByTestId("agent-memory-new"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-create")).toBeInTheDocument())
    fireEvent.change(screen.getByTestId("agent-memory-create-type"), {
      target: { value: "feedback" },
    })
    fireEvent.input(screen.getByTestId("agent-memory-create-name"), { target: { value: "tone" } })
    fireEvent.input(screen.getByTestId("agent-memory-create-description"), {
      target: { value: "Keep replies terse" },
    })
    fireEvent.input(screen.getByTestId("agent-memory-create-content"), {
      target: { value: "Bullet points, no preamble." },
    })
    fireEvent.click(screen.getByTestId("agent-memory-create-save"))

    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][0]).toBe("/agent/memories")
    expect(api.post.mock.calls[0][1]).toEqual({
      type: "feedback",
      name: "tone",
      description: "Keep replies terse",
      content: "Bullet points, no preamble.",
    })
    // The tree is the reader of record: the new row is a file in it.
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-file-feedback/tone.md")).toBeInTheDocument(),
    )

    // Delete, two step inline, exactly as the flat detail screen confirmed it.
    fireEvent.click(screen.getByTestId("agent-memory-file-feedback/tone.md"))
    await waitFor(() => expect(screen.getByTestId("memory-delete")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("memory-delete"))
    fireEvent.click(screen.getByTestId("memory-delete-confirm"))
    await waitFor(() => expect(api.delete).toHaveBeenCalled())
    expect(api.delete.mock.calls[0][0]).toBe("/agent/memories/feedback/tone")
    await waitFor(() =>
      expect(screen.queryByTestId("agent-memory-file-feedback/tone.md")).toBeNull(),
    )
  })

  // The delete is a VISIBLE button that turns into its own confirmation, never
  // something a pointer has to find: step one is on screen from the moment the
  // file is open, and step two replaces it.
  it("the delete is visible in two steps, with no hover involved", async () => {
    setupCrud({
      typed: [
        {
          type: "feedback",
          name: "tone",
          description: "Keep replies terse",
          content: "Bullet points.",
        },
      ],
    })
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-file-feedback/tone.md")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-feedback/tone.md"))

    const step1 = await screen.findByTestId("memory-delete")
    // Present, not merely in the document behind an opacity-0 hover wrapper.
    expect(step1.className).not.toContain("opacity-0")
    expect(screen.queryByTestId("memory-delete-confirm")).toBeNull()

    fireEvent.click(step1)
    expect(screen.getByTestId("memory-delete-confirm")).toBeInTheDocument()
    expect(screen.queryByTestId("memory-delete")).toBeNull()

    // And it is reversible: cancel puts step one back without deleting.
    fireEvent.click(screen.getByTestId("memory-delete-cancel"))
    expect(screen.getByTestId("memory-delete")).toBeInTheDocument()
  })

  it("an episode file offers no delete: only a typed memory has one", async () => {
    setupCrud()
    await waitFor(() => expect(screen.getByTestId("agent-memory-new")).toBeInTheDocument())
    expect(screen.queryByTestId("memory-delete")).toBeNull()
  })

  it("a rendered file resolves its [[name]] links and dims the broken ones", async () => {
    setupCrud({
      typed: [
        {
          type: "user",
          name: "role",
          description: "What I do",
          content: "See [[tone]] and [[missing]].",
        },
        { type: "feedback", name: "tone", description: "Keep replies terse", content: "Terse." },
      ],
      selected: "user/role.md",
    })
    await waitFor(() => expect(screen.getByTestId("agent-memory-link-preview")).toBeInTheDocument())
    expect(screen.getByTestId("agent-memory-link-tone")).toBeInTheDocument()
    expect(screen.getByTestId("agent-memory-broken-link-missing")).toBeInTheDocument()

    // A resolved link opens the memory it names.
    fireEvent.click(screen.getByTestId("agent-memory-link-tone"))
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-open-path").textContent).toBe("feedback/tone.md"),
    )
  })

  it("a deep link's selected path opens that file", async () => {
    setupCrud({
      typed: [{ type: "user", name: "role", description: "What I do", content: "Body." }],
      selected: "user/role.md",
    })
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-open-path").textContent).toBe("user/role.md"),
    )
  })
})

// A screenshot pass found three group headers (Index, Earlier chats,
// Conversation summaries) standing over nothing: a bare rule the eye reads as a
// list that failed to load. The order is normative, so the header stays and the
// group says it is empty.
describe("MemoryTree: an empty group says so", () => {
  beforeEach(() => resetAgentMemoryStore())
  afterEach(() => cleanup())

  it("puts one empty line under a group with no files, beside a group that has some", async () => {
    setup({ files: [file("project/one.md")] })
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-file-project/one.md")).toBeInTheDocument(),
    )
    // The populated group carries its file and no empty line.
    expect(screen.queryByTestId("agent-memory-group-empty-topics")).toBeNull()
    // The three empty ones each say so, in words.
    for (const id of ["index", "episodes", "checkpoints"]) {
      expect(screen.getByTestId(`agent-memory-group-empty-${id}`)).toHaveTextContent(
        "Nothing here yet.",
      )
    }
  })

  it("stays quiet when the whole tree is empty: the tree's own empty state speaks", async () => {
    setup({ files: [] })
    await waitFor(() => expect(screen.getByTestId("agent-memory-empty")).toBeInTheDocument())
    for (const id of ["index", "topics", "episodes", "checkpoints"]) {
      expect(screen.queryByTestId(`agent-memory-group-empty-${id}`)).toBeNull()
    }
  })
})

/**
 * ws_09 QA: the Memory tab is a master/detail surface like Skills and
 * Routines. It was one long column instead: the editor rendered UNDER the whole
 * tree, no row said which file was open, and the Index group claimed to be
 * empty on an agent with thirteen files.
 */
describe("MemoryTree master and detail", () => {
  beforeEach(() => {
    resetAgentMemoryStore()
    resetMemoriesStore()
  })
  afterEach(() => cleanup())

  it("the editor sits beside the tree, not under it", async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId("agent-memory-panes")).toBeInTheDocument())
    const panes = screen.getByTestId("agent-memory-panes")
    const list = screen.getByTestId("agent-memory-list")
    const detail = screen.getByTestId("agent-memory-detail")
    // ONE row, two children: a column would stack the editor below the tree,
    // which is what read as a phone layout on a desktop window.
    expect(list.parentElement).toBe(panes)
    expect(detail.parentElement).toBe(panes)
    expect(panes.className).toContain("flex")
    expect(panes.className).not.toContain("flex-col")
    // The tab fills its panel, so the two panes have a height to split.
    expect(screen.getByTestId("agent-memory-tree").className).toContain("h-full")
  })

  it("the open file's row carries the selected state", async () => {
    setup()
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-file-project/one.md")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-project/one.md"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-open-path")).toBeInTheDocument())
    expect(screen.getByTestId("agent-memory-file-project/one.md")).toHaveClass("bg-surface-active")
    expect(screen.getByTestId("agent-memory-card-project/one.md")).toHaveClass("bg-surface-active")
    // Nothing else is marked: one open file, one selected row.
    expect(screen.getByTestId("agent-memory-file-checkpoints/logistics.md")).not.toHaveClass(
      "bg-surface-active",
    )
  })
})

/**
 * The column is 320 px wide and the row used to put the title and the whole
 * path on ONE line, with the path pinned right and refusing to shrink. The
 * title took whatever was left: a topic read "N…", and an episode, whose path
 * is the longest of all, was squeezed to nothing and showed only its path.
 */
describe("MemoryTree row titles", () => {
  beforeEach(() => resetAgentMemoryStore())
  afterEach(() => cleanup())

  it("names an episode by its conversation and the day, not by the seeded sentence", () => {
    expect(
      memoryRowLabel(
        {
          path: "episodes/logistics/2026-09-01.md",
          name: "logistics-2026-09-01",
          description: "Conversation in logistics on 2026-09-01",
          type: "episode",
          modified: "",
          requiredScopes: [],
        },
        "Logistics room",
      ),
    ).toBe("Logistics room, 2026-09-01")
  })

  it("falls back to the thread handle when no title is known", () => {
    expect(
      memoryRowLabel({
        path: "episodes/logistics/2026-09-01.md",
        name: "logistics-2026-09-01",
        description: "Conversation in logistics on 2026-09-01",
        type: "episode",
        modified: "",
        requiredScopes: [],
      }),
    ).toBe("logistics, 2026-09-01")
  })

  it("leaves a topic row on its description", () => {
    expect(
      memoryRowLabel({
        path: "project/one.md",
        name: "one",
        description: "How we ship the carton ladder",
        type: "project",
        modified: "",
        requiredScopes: [],
      }),
    ).toBe("How we ship the carton ladder")
  })

  it("renders an episode row as the thread it came from, with the date", async () => {
    setup({
      files: [
        file("checkpoints/logistics.md", {
          type: "checkpoint",
          name: "Logistics room",
          description: "",
          threadHandle: "logistics",
        }),
        file("episodes/logistics/2026-09-01.md", {
          type: "episode",
          name: "logistics-2026-09-01",
          description: "Conversation in logistics on 2026-09-01",
          threadHandle: "logistics",
        }),
      ],
    })
    const row = await screen.findByTestId("agent-memory-file-episodes/logistics/2026-09-01.md")
    expect(row.textContent).toContain("Logistics room, 2026-09-01")
  })

  // THE DATE IS NOT PART OF THE TITLE. It used to be glued onto it in one
  // string, in a 320 px column that truncates: a long conversation title took
  // the day away with it, which is the one thing the row was renamed to say.
  it("keeps the day out of the truncating title, as its own piece", () => {
    const parts = memoryRowParts(
      {
        path: "episodes/logistics/2026-09-01.md",
        name: "logistics-2026-09-01",
        description: "Conversation in logistics on 2026-09-01",
        type: "episode",
        modified: "",
        requiredScopes: [],
      },
      "A conversation title long enough to be truncated in a 320 pixel column",
    )
    expect(parts.title).toBe(
      "A conversation title long enough to be truncated in a 320 pixel column",
    )
    expect(parts.date).toBe("2026-09-01")
  })

  // The consolidation job writes a SECOND episode of the same day as
  // `<date>-2`. That suffix keeps the two paths apart; read out loud as a date
  // it is nonsense, so the row shows the day and the path shows the file.
  it("shows the day, not the same day disambiguator, for a second episode", () => {
    const f = {
      path: "episodes/thread-24/2026-09-17-2.md",
      name: "thread-24-2026-09-17-2",
      description: "Conversation in thread-24 on 2026-09-17",
      type: "episode" as const,
      modified: "",
      requiredScopes: [],
    }
    expect(episodeDateOfPath(f.path)).toBe("2026-09-17")
    expect(memoryRowParts(f).date).toBe("2026-09-17")
    expect(memoryRowLabel(f)).toBe("thread-24, 2026-09-17")
  })

  it("renders the day as its own non shrinking piece beside the truncating title", async () => {
    setup({
      files: [
        file("checkpoints/logistics.md", {
          type: "checkpoint",
          name: "A conversation title long enough to be truncated in a 320 pixel column",
          description: "",
          threadHandle: "logistics",
        }),
        file("episodes/logistics/2026-09-17-2.md", {
          type: "episode",
          name: "logistics-2026-09-17-2",
          description: "Conversation in logistics on 2026-09-17",
          threadHandle: "logistics",
        }),
      ],
    })
    const path = "episodes/logistics/2026-09-17-2.md"
    const title = await screen.findByTestId(`agent-memory-rowtitle-${path}`)
    const date = screen.getByTestId(`agent-memory-rowdate-${path}`)
    expect(title.textContent).toBe(
      "A conversation title long enough to be truncated in a 320 pixel column",
    )
    expect(title.getAttribute("class") ?? "").toContain("truncate")
    // The day survives the truncation because it is not inside it.
    expect(date.textContent).toBe(", 2026-09-17")
    expect(date.getAttribute("class") ?? "").toContain("shrink-0")
    expect(date.getAttribute("class") ?? "").not.toContain("truncate")
    // The path keeps the disambiguator: it is what names the file.
    expect(screen.getByTestId(`agent-memory-rowpath-${path}`).textContent).toBe(path)
  })

  it("reads as ONE label: the day follows the title instead of being pushed to the far edge", async () => {
    setup({
      files: [
        file("episodes/qa-approval-3417/2026-09-17.md", {
          type: "episode",
          name: "qa-approval-3417-2026-09-17",
          description: "Conversation in qa-approval-3417 on 2026-09-17",
          threadHandle: "qa-approval-3417",
        }),
      ],
    })
    const path = "episodes/qa-approval-3417/2026-09-17.md"
    const title = await screen.findByTestId(`agent-memory-rowtitle-${path}`)
    const date = screen.getByTestId(`agent-memory-rowdate-${path}`)
    // The title used to be `w-full`, which pushed the day against the opposite
    // edge and made the row read as two columns: "qa-approval-3417 , 2026-09-17".
    expect(title.getAttribute("class") ?? "").not.toContain("w-full")
    const line = title.parentElement as HTMLElement
    expect(line.getAttribute("class") ?? "").not.toContain("justify-between")
    expect(date.getAttribute("class") ?? "").not.toContain("ml-auto")
    // The day sits immediately after the title, muted, on the same baseline.
    expect(title.nextElementSibling).toBe(date)
    expect(date.getAttribute("class") ?? "").toContain("text-text-tertiary")
    expect(line.textContent).toBe("qa-approval-3417, 2026-09-17")
  })

  it("gives the title its own line, so the path can never squeeze it away", async () => {
    const long = "A very long topic title that would never survive being squeezed"
    setup({ files: [file("project/one.md", { description: long })] })
    const title = await screen.findByTestId("agent-memory-rowtitle-project/one.md")
    const path = screen.getByTestId("agent-memory-rowpath-project/one.md")
    expect(title.textContent).toBe(long)
    // The title is a line of its own inside a stacked row: nothing else on
    // that line competes for the 320 px, and the ellipsis is the title's own.
    expect(title.parentElement?.getAttribute("class") ?? "").toContain("flex-col")
    expect(title.getAttribute("class") ?? "").toContain("truncate")
    // The path is under it, never pinned beside it at a fixed width.
    expect(path.getAttribute("class") ?? "").not.toContain("shrink-0")
    expect(path.getAttribute("class") ?? "").not.toContain("ml-auto")
  })
})

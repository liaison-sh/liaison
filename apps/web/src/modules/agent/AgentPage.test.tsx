// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * P4m-T29: the agent profile surface and the Memory tab shell.
 *
 * The normative strings (spec-memory.md "User facing copy") are asserted byte
 * for byte, so a well meant rewording of a label is a failing test rather than
 * a silent product change.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import AgentPage from "~/modules/agent/AgentPage"
import { resetAgentMemoryStore } from "~/modules/agent/agent-memory-store"
import { resetRoutinesStore } from "~/modules/agent/routines-store"
import { resetSkillsStore } from "~/modules/agent/skills-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { openTab, resetTabStore, tabStore, updateTabRoutePath } from "~/modules/shell/tab-store"
import { addToast, resetToastStore, toasts } from "~/modules/shell/toast-store"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

const ROLE_AGENT = "11111111-1111-4111-8111-111111111111"
const PERSONAL_AGENT = "22222222-2222-4222-8222-222222222222"
const VIEWER = "33333333-3333-4333-8333-333333333333"
const SOMEONE_ELSE = "44444444-4444-4444-8444-444444444444"

const grants = new Set<string>()
let viewerId = VIEWER

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: (scope: string) => grants.has(scope),
  hasAppsAdmin: () => grants.has("kernel:apps:admin"),
  userFromToken: () => ({
    userId: viewerId,
    orgId: "org",
    scopes: [],
    roles: [],
    dimensionGrants: {},
    exp: 0,
    name: "Me",
  }),
}))

function file(path: string, requiredScopes: string[] = []) {
  return {
    path,
    name: path.replace(/\.md$/, "").split("/").pop() ?? path,
    description: `desc ${path}`,
    type: path.startsWith("episodes/") ? "episode" : "project",
    modified: "2026-09-13",
    requiredScopes,
  }
}

interface SetupOptions {
  agents?: unknown[]
  /** Holds the reads open, so a test can look at the page mid flight. */
  detailGate?: Promise<void>
  agentsGate?: Promise<void>
  files?: unknown[]
  treeError?: unknown
  entityId?: string
  detail?: Record<string, unknown> | null
  systemPrompt?: string
  /** P4c FX-F1: what the Skills / Routines tabs list for this agent. */
  skills?: unknown[]
  routines?: unknown[]
  /**
   * Path prefixes the server refuses with a 403. The mock raises the toast
   * itself because that is where the real one comes from: `ApiProvider`'s
   * `onError` turns EVERY denial into a red toast, whatever the calling store
   * does with the rejection afterwards.
   */
  forbid?: string[]
}

function setup(opts: SetupOptions = {}) {
  const api: any = {
    get: vi.fn(async (path: string) => {
      if ((opts.forbid ?? []).some((prefix) => path.startsWith(prefix))) {
        addToast({ type: "error", message: "Permission denied" })
        throw new ApiError("Permission denied", 403)
      }
      if (path.startsWith("/agent/skills")) return opts.skills ?? []
      if (path.startsWith("/agent/routines")) {
        return path.endsWith("/runs") ? [] : (opts.routines ?? [])
      }
      if (path === "/agent/memories") return []
      if (path === "/agents") {
        if (opts.agentsGate) await opts.agentsGate
        return (
          opts.agents ?? [
            { id: ROLE_AGENT, handle: "@logistics", displayName: "Logistics", kind: "role" },
          ]
        )
      }
      if (path.includes("/memory/tree")) {
        if (opts.treeError) throw opts.treeError
        return { files: opts.files ?? [], index: { lines: 4, nearLimit: false, full: false } }
      }
      if (path.endsWith("/definition")) {
        return { data: { systemPrompt: opts.systemPrompt ?? "You are Logistics." } }
      }
      if (/^\/agents\/[^/]+$/.test(path)) {
        if (opts.detailGate) await opts.detailGate
        return opts.detail === null ? null : { data: opts.detail ?? detailFor(ROLE_AGENT) }
      }
      return null
    }),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <AgentPage entityId={opts.entityId ?? ROLE_AGENT} />
    </ApiContext.Provider>
  ))
  return api
}

function detailFor(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    handle: "@logistics",
    displayName: "Logistics",
    kind: "role",
    ownerUserId: null,
    purpose: "Keeps the shipping queue moving.",
    avatarUrl: null,
    state: "active",
    lastActivityAt: "2026-09-13T10:00:00.000Z",
    channels: [{ id: "c-1", handle: "@shipping", name: "Shipping" }],
    counts: { skills: 2, routines: 1, memoryFiles: 3, knowledgePointers: 0 },
    capabilityCategories: ["kernel", "tickets"],
    runsOn: "liaison",
    ...over,
  }
}

/** The read scopes each tab's own fetches need. Granted by default so the
 *  suites written before the gate keep exercising the loaded tabs; the gate's
 *  own suite takes them away one at a time. */
const TAB_READ_SCOPES = ["kernel:skills:read", "kernel:routines:read", "kernel:agent:memory:read"]

function grantTabReads(): void {
  for (const scope of TAB_READ_SCOPES) grants.add(scope)
}

/** The tab strip, in DOM order, whatever the permission split leaves in it. */
function tabNames(): string[] {
  return Array.from(document.querySelectorAll("[data-agent-tab]")).map(
    (el) => el.getAttribute("data-agent-tab") ?? "",
  )
}

describe("AgentPage (P4m-T29)", () => {
  beforeEach(() => {
    grants.clear()
    grantTabReads()
    viewerId = VIEWER
    resetAgentMemoryStore()
  })
  afterEach(() => cleanup())

  it("the memory tab renders the four normative labels byte for byte", async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId("agent-profile-tab-memory")).toBeInTheDocument())
    expect(screen.getByTestId("agent-profile-tab-memory").textContent).toBe("Memory")
    expect(screen.getByTestId("agent-memory-group-index").textContent).toBe("Index")
    expect(screen.getByTestId("agent-memory-group-episodes").textContent).toBe("Earlier chats")
    expect(screen.getByTestId("agent-memory-group-checkpoints").textContent).toBe(
      "Conversation summaries",
    )
  })

  it("rows the viewer's scopes do not cover are hidden and counted", async () => {
    grants.add("kernel:tickets:read")
    setup({
      files: [
        file("project/one.md"),
        file("project/two.md", ["kernel:tickets:read"]),
        file("project/three.md", ["kernel:billing:admin"]),
        file("project/four.md", ["kernel:mail:read"]),
        file("episodes/logistics/2026-09-01.md"),
      ],
    })
    await waitFor(() =>
      expect(screen.getAllByTestId(/^agent-memory-file-/).length).toBeGreaterThan(0),
    )
    expect(screen.getAllByTestId(/^agent-memory-file-/)).toHaveLength(3)
    expect(screen.getByTestId("agent-memory-hidden-count").textContent).toBe("2 entries hidden")
  })

  // THE SHAPE A SERVER CAN ACTUALLY PRODUCE. `GET /api/agents` never lists a
  // colleague's personal agent (its predicate keeps personal rows to their
  // owner) and echoes an owner id only when it is the caller's own, while the
  // page read answers for one to a `kernel:agents:read` holder and discloses
  // the owner to them. That reader is not an agents ADMIN, so the Memory tab
  // is out of the document and the page says why.
  it("a personal agent's memory tab is refused to a non owner without agents admin", async () => {
    grants.add("kernel:agents:read")
    setup({
      entityId: PERSONAL_AGENT,
      agents: [],
      detail: detailFor(PERSONAL_AGENT, {
        handle: "@alex",
        displayName: "Alex",
        kind: "personal",
        ownerUserId: SOMEONE_ELSE,
      }),
    })
    // The notice waits for both reads: nothing is claimed about what this
    // viewer may see until the page can say it.
    await waitFor(() =>
      expect(screen.getByTestId("agent-profile-memory-denied")).toBeInTheDocument(),
    )
    expect(screen.queryByTestId("agent-profile-tab-memory")).toBeNull()
  })

  // THE PAGE READ IS THE AUTHORITY ON OWNERSHIP. It discloses the owner to the
  // owner and to an admin and answers `null` to everyone else, so that null is
  // an answer. Filling it in from the listing's echo handed the administration
  // half of the page (Activity, Settings) to a viewer the server just told the
  // page is not the owner.
  it("a page read that withholds the owner is not overruled by the listing", async () => {
    setup({
      entityId: PERSONAL_AGENT,
      agents: [
        {
          id: PERSONAL_AGENT,
          handle: "@alex",
          displayName: "Alex",
          kind: "personal",
          ownerUserId: VIEWER,
        },
      ],
      detail: detailFor(PERSONAL_AGENT, {
        handle: "@alex",
        displayName: "Alex",
        kind: "personal",
        ownerUserId: null,
      }),
    })
    await waitFor(() => expect(screen.getByTestId("agent-profile")).toBeInTheDocument())
    await waitFor(() => expect(tabNames().length).toBeGreaterThan(0))
    expect(tabNames()).not.toContain("settings")
    expect(tabNames()).not.toContain("activity")
  })

  it("the forget confirmation carries the agent's display name (P4m-T31)", async () => {
    setup({ files: [file("episodes/logistics/2026-09-01.md")] })
    await waitFor(() =>
      expect(
        screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-memory-file-episodes/logistics/2026-09-01.md"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-forget")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("agent-memory-forget"))
    expect(screen.getByTestId("agent-memory-forget-confirm-text").textContent).toBe(
      "This removes what Logistics remembers from this conversation. Messages stay.",
    )
  })

  it("a backend with no memory tree surface renders the empty state, not an error", async () => {
    setup({ treeError: new ApiError("Not Found", 404) })
    await waitFor(() => expect(screen.getByTestId("agent-memory-empty")).toBeInTheDocument())
    expect(screen.queryByTestId("agent-memory-error")).toBeNull()
  })
})

describe("AgentPage tabs (P4c-T35)", () => {
  beforeEach(() => {
    grants.clear()
    grantTabReads()
    viewerId = VIEWER
    resetAgentMemoryStore()
  })
  afterEach(() => cleanup())

  it("the page shows Overview, Skills, Routines, Memory and Knowledge to a member and hides Activity and Settings", async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId("agent-page-tab-overview")).toBeInTheDocument())
    expect(tabNames()).toEqual(["overview", "skills", "routines", "memory", "knowledge"])
    // Hidden, not disabled: the controls and their panels are absent.
    expect(screen.queryByTestId("agent-page-tab-activity")).toBeNull()
    expect(screen.queryByTestId("agent-page-tab-settings")).toBeNull()
    expect(screen.queryByTestId("agent-page-panel-activity")).toBeNull()
    expect(screen.queryByTestId("agent-page-panel-settings")).toBeNull()
  })

  it("an admin sees all seven tabs", async () => {
    grants.add("kernel:agents:admin")
    setup()
    await waitFor(() => expect(screen.getByTestId("agent-page-tab-settings")).toBeInTheDocument())
    expect(tabNames()).toEqual([
      "overview",
      "skills",
      "routines",
      "memory",
      "knowledge",
      "activity",
      "settings",
    ])
  })

  // The chips carried the CATEGORY key as their text, which is an app slug:
  // a name is what a person reads, `kernel` is what a developer greps.
  it("Overview shows capability categories by name and no scope names", async () => {
    setup()
    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-capability-kernel")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("agent-overview-capability-kernel").textContent).toBe("Workspace")
    expect(screen.getByTestId("agent-overview-capability-tickets").textContent).toBe("Tickets")
    const text = screen.getByTestId("agent-overview").textContent ?? ""
    expect(text).not.toMatch(/kernel:[a-z]/)
    expect(text).not.toMatch(/[a-z]+:[a-z]+:[a-z]+/)
  })

  // P4c-T37: the Activity placeholder is gone; the panel carries the real
  // timeline, and only for the half of the page that may administer the agent.
  it("the Activity panel mounts the timeline for an admin and nothing for a member", async () => {
    grants.add("kernel:agents:admin")
    setup()
    await waitFor(() => expect(screen.getByTestId("agent-page-panel-activity")).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId("agent-activity")).toBeInTheDocument())
    expect(screen.getByTestId("agent-page-panel-activity").textContent).not.toContain(
      "Activity lives here.",
    )
    cleanup()

    grants.clear()
    grantTabReads()
    setup()
    await waitFor(() => expect(screen.getByTestId("agent-profile")).toBeInTheDocument())
    expect(screen.queryByTestId("agent-activity")).toBeNull()
  })

  // The Memory tab is master/detail like Skills and Routines, and `h-full` on
  // the tab can only resolve against a panel that has a height of its own.
  it("the Memory panel has a definite height for the tab to split", async () => {
    setup({ files: [file("project/one.md")] })
    await waitFor(() => expect(screen.getByTestId("agent-page-panel-memory")).toBeInTheDocument())
    const panel = screen.getByTestId("agent-page-panel-memory")
    expect(panel.className).toContain("h-full")
    expect(panel.className).toContain("min-h-0")
  })

  it("the Memory tab still renders MemoryTree with ws_04m's gate", async () => {
    setup({ files: [file("project/one.md")] })
    await waitFor(() => expect(screen.getByTestId("agent-profile-tab-memory")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("agent-profile-tab-memory"))
    await waitFor(() => expect(screen.getByTestId("agent-memory-group-index")).toBeInTheDocument())
    expect(screen.getByTestId("agent-memory-file-project/one.md")).toBeInTheDocument()
    cleanup()

    // ws_04m: a personal agent someone else owns keeps its Memory tab OUT of
    // the document, and the page says so rather than going quiet. The reads
    // are shaped as the routes answer them: the listing keeps personal rows to
    // their owner, and the page read discloses the owner to the
    // `kernel:agents:read` holder who can open the page at all.
    grants.add("kernel:agents:read")
    setup({
      entityId: PERSONAL_AGENT,
      agents: [],
      detail: detailFor(PERSONAL_AGENT, {
        handle: "@alex",
        displayName: "Alex",
        kind: "personal",
        ownerUserId: SOMEONE_ELSE,
      }),
    })
    // The notice waits for BOTH reads: the page says nothing about what this
    // viewer may see until it can (the "not available" flash, same rule).
    await waitFor(() =>
      expect(screen.getByTestId("agent-profile-memory-denied")).toBeInTheDocument(),
    )
    expect(tabNames()).not.toContain("memory")
    expect(screen.queryByTestId("agent-page-panel-memory")).toBeNull()
  })
})

/**
 * P4c FX-F1: `?selected=<id>` is what a retired detail link becomes. The page
 * parses it off its own route, hands it to the tab it belongs to, and keeps it
 * in the URL only while that tab is the one showing. The flat memory screens
 * are gone: everything they could do is on the Memory tab.
 */
describe("AgentPage deep links (P4c FX-F1)", () => {
  const SKILL = {
    id: "sk-1",
    name: "triage-refunds",
    description: "How this agent triages a refund",
    body: "step one",
    source: "personal",
    requiredScopes: [],
    domain: null,
    ownerAgentId: ROLE_AGENT,
    canWrite: true,
  }

  const ROUTINE = {
    id: "rt-1",
    orgId: "org-1",
    ownerUserId: VIEWER,
    ownerAgentId: ROLE_AGENT,
    name: "morning-digest",
    description: "Digest every weekday",
    kind: "recurring" as const,
    cron: "0 9 * * 1-5",
    timezone: "UTC",
    runAt: null,
    prompt: "summarize",
    outputThreadId: null,
    scopes: [],
    visibility: "personal" as const,
    agentModelId: null,
    agentReasoningLevel: null,
    enabled: true,
    status: "active" as const,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    canWrite: true,
  }

  function openPageTab(tail: string) {
    openTab({
      type: "agents:agent",
      entityId: ROLE_AGENT,
      label: "Logistics",
      routePath: `/agents/${ROLE_AGENT}${tail}`,
    })
  }

  function ownRoutePath(): string | undefined {
    return tabStore.tabs.find((t) => t.entityId === ROLE_AGENT)?.routePath
  }

  beforeEach(() => {
    grants.clear()
    grantTabReads()
    viewerId = VIEWER
    resetAgentMemoryStore()
    resetSkillsStore()
    resetRoutinesStore()
    resetThreadStore()
    resetTabStore()
  })
  afterEach(() => {
    cleanup()
    resetTabStore()
  })

  it("a redirect with selected opens the Skills tab with that skill selected", async () => {
    openPageTab("/skills?selected=sk-1")
    setup({ skills: [SKILL] })

    await waitFor(() =>
      expect(screen.getByTestId("skill-detail").textContent).toContain("triage-refunds"),
    )
    expect(screen.getByTestId("agent-page-tab-skills").getAttribute("aria-selected")).toBe("true")
    // The page's URL effect keeps the param while the Skills tab is showing.
    expect(ownRoutePath()).toBe(`/agents/${ROLE_AGENT}/skills?selected=sk-1`)
  })

  it("a redirect with selected opens the Routines tab with that routine selected", async () => {
    openPageTab("/routines?selected=rt-1")
    setup({ routines: [ROUTINE] })

    await waitFor(() =>
      expect(screen.getByTestId("routine-detail").textContent).toContain("morning-digest"),
    )
    expect(screen.getByTestId("agent-page-tab-routines").getAttribute("aria-selected")).toBe("true")
    expect(ownRoutePath()).toBe(`/agents/${ROLE_AGENT}/routines?selected=rt-1`)
  })

  it("switching away from the tab the selection belongs to drops the param", async () => {
    openPageTab("/skills?selected=sk-1")
    setup({ skills: [SKILL] })
    await waitFor(() => expect(screen.getByTestId("skill-detail")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("agent-page-tab-overview"))
    await waitFor(() => expect(ownRoutePath()).toBe(`/agents/${ROLE_AGENT}`))
  })

  it("a route that arrives after mount still opens its tab", async () => {
    // The shell can set the tab's routePath AFTER this page has mounted (the
    // page is lazy, and a legacy link is rewritten a navigation later). Read
    // once, the deep link was dropped and the URL rewritten back to the base.
    openPageTab("")
    setup({ skills: [SKILL] })
    await waitFor(() => expect(screen.getByTestId("agent-page-tab-skills")).toBeInTheDocument())

    const own = tabStore.tabs.find((t) => t.entityId === ROLE_AGENT)
    updateTabRoutePath(own?.id ?? "", `/agents/${ROLE_AGENT}/skills?selected=sk-1`)

    await waitFor(() =>
      expect(screen.getByTestId("agent-page-tab-skills").getAttribute("aria-selected")).toBe(
        "true",
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("skill-detail").textContent).toContain("triage-refunds"),
    )
    expect(ownRoutePath()).toBe(`/agents/${ROLE_AGENT}/skills?selected=sk-1`)
  })

  it("a route opened while the page shows another tab lands on the route's tab, every time", async () => {
    // `/agents/self/routines`, then `/agents/self/memory` with the page open kept
    // Routines and rewrote the URL to it: the URL-follows-tab effect could run
    // before the route reader and write the old tab over the new route.
    openPageTab("/routines")
    setup({ skills: [SKILL], routines: [ROUTINE] })
    const selectedTab = () =>
      ["overview", "skills", "routines"].find(
        (t) =>
          screen.queryByTestId(`agent-page-tab-${t}`)?.getAttribute("aria-selected") === "true",
      )
    await waitFor(() => expect(selectedTab()).toBe("routines"))
    // The viewer clicks around first, so both effects have re-run.
    fireEvent.click(screen.getByTestId("agent-page-tab-overview"))
    await waitFor(() => expect(ownRoutePath()).toBe(`/agents/${ROLE_AGENT}`))

    for (const next of ["skills", "routines", "skills", "overview", "routines"] as const) {
      openPageTab(next === "overview" ? "" : `/${next}`)
      await waitFor(() => expect(selectedTab()).toBe(next))
      expect(ownRoutePath()).toBe(
        next === "overview" ? `/agents/${ROLE_AGENT}` : `/agents/${ROLE_AGENT}/${next}`,
      )
    }
  })

  it("a legacy redirect lands on the target tab with its selected item", async () => {
    // P4c FX-F2. `/agent/memory/project/carrier` is rewritten to
    // `/agents/:handle/memory?selected=project/carrier.md`, and Memory is the
    // tab whose visibility waits on the agent listing: judged before the
    // listing lands, Memory is "not visible", the page falls back to Overview
    // and its URL effect rewrites the route back to the bare page. Every
    // assertion here is about the state AFTER the listing has landed.
    openPageTab(`/memory?selected=${encodeURIComponent("project/carrier.md")}`)
    setup({ files: [file("project/carrier.md")] })

    await waitFor(() =>
      expect(screen.getByTestId("agent-profile-tab-memory").getAttribute("aria-selected")).toBe(
        "true",
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("agent-memory-open-path").textContent).toContain(
        "project/carrier.md",
      ),
    )
    expect(ownRoutePath()).toBe(`/agents/${ROLE_AGENT}/memory?selected=project%2Fcarrier.md`)
  })

  it("no tab panel fetches against an empty agent id", async () => {
    // A panel that loads once on mount must wait for the agent row: mounted
    // against the empty id, `/api/agents//settings` is a 404 that takes the
    // whole tab down with it.
    grants.add("kernel:agents:admin")
    openPageTab("")
    const api = setup({ skills: [SKILL], routines: [ROUTINE] })

    await waitFor(() => expect(screen.getByTestId("agent-page-tab-settings")).toBeInTheDocument())
    const emptyIdCalls = api.get.mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((p: string) => p.includes("/agents//") || p.endsWith("ownerAgentId="))
    expect(emptyIdCalls).toEqual([])
  })

  it("no module under apps/web/src imports MemoriesList or MemoryDetail", async () => {
    // Nothing reaches the flat screens any more: no module imports them, and
    // everything they could do (create with a type, delete, `[[name]]`) is on
    // the Memory tab. Their files are retired by the cleanup pass that owns
    // them; this guard is what stops one being wired back in.
    const { existsSync, readdirSync, readFileSync } = await import("node:fs")
    // Vitest roots at `apps/web`, so the tree to sweep is its own `src`.
    const src = `${process.cwd()}/src`
    expect(existsSync(src)).toBe(true)

    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry.name)) continue
        // The screens' own files are the cleanup pass's to delete.
        if (/^Memor(iesList|yDetail)(\.test)?\.tsx$/.test(entry.name)) continue
        if (
          /import[^\n]*["'][^"'\n]*\/(MemoriesList|MemoryDetail)["']/.test(
            readFileSync(full, "utf8"),
          )
        ) {
          offenders.push(full)
        }
      }
    }
    walk(src)
    expect(offenders).toEqual([])
  })
})

/**
 * P4c FX-F4: `self` is the spelling every retired list-screen bookmark lands on
 * when the agent directory has not loaded yet. The page is what resolves it, so
 * the resolution is asserted here rather than inferred from a browser run.
 */
describe("AgentPage self (P4c FX-F4)", () => {
  beforeEach(() => {
    grants.clear()
    grantTabReads()
    viewerId = VIEWER
    resetAgentMemoryStore()
    resetSkillsStore()
    resetRoutinesStore()
    resetTabStore()
  })
  afterEach(() => cleanup())

  it("a self entity id renders once the listing resolves", async () => {
    setup({
      entityId: "self",
      agents: [
        { id: ROLE_AGENT, handle: "@logistics", displayName: "Logistics", kind: "role" },
        {
          id: PERSONAL_AGENT,
          handle: "@me",
          displayName: "Liaison",
          kind: "personal",
          ownerUserId: VIEWER,
        },
      ],
      detail: detailFor(PERSONAL_AGENT, {
        handle: "@me",
        displayName: "Liaison",
        kind: "personal",
        ownerUserId: VIEWER,
      }),
    })

    // The body is there from the first frame, and names the viewer's own agent
    // once the listing has landed — not the "not found" fallback.
    expect(screen.getByTestId("agent-profile")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId("agent-profile-name").textContent).toBe("Liaison"),
    )
    expect(screen.getByTestId("agent-page-handle").textContent).toBe("@me")
    // Resolved to the personal ROW, so the tabs that need an agent id are there.
    await waitFor(() => expect(screen.getByTestId("agent-page-panel-skills")).toBeInTheDocument())
  })
})

/**
 * A tab the viewer may not read asks the server NOTHING. The page used to
 * mount every permitted tab and let each one fetch on arrival, so a plain
 * member landed on three separate red "Permission denied" toasts before they
 * had clicked anything: the denial is knowable from the session's own scopes,
 * so the page answers it itself and the tab renders a quiet no-access line.
 */
describe("AgentPage per tab read scopes", () => {
  beforeEach(() => {
    grants.clear()
    grantTabReads()
    viewerId = VIEWER
    resetAgentMemoryStore()
    resetSkillsStore()
    resetRoutinesStore()
    resetTabStore()
    resetToastStore()
  })
  afterEach(() => {
    cleanup()
    resetToastStore()
  })

  function pathsMatching(api: any, test: (p: string) => boolean): string[] {
    return api.get.mock.calls.map((c: any[]) => String(c[0])).filter(test)
  }

  it("a viewer without kernel:skills:read never asks for the skills list and sees no toast", async () => {
    grants.delete("kernel:skills:read")
    const api = setup({ forbid: ["/agent/skills"], skills: [{ id: "sk-1", name: "triage" }] })

    await waitFor(() => expect(screen.getByTestId("agent-page-panel-skills")).toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByTestId("agent-page-no-access-skills")).toBeInTheDocument(),
    )
    expect(pathsMatching(api, (p) => p.startsWith("/agent/skills"))).toEqual([])
    expect(screen.queryByTestId("agent-skills-tab")).toBeNull()
    expect(toasts()).toEqual([])
  })

  it("a viewer without kernel:routines:read never asks for the routines list and sees no toast", async () => {
    grants.delete("kernel:routines:read")
    const api = setup({ forbid: ["/agent/routines"], routines: [{ id: "rt-1", name: "digest" }] })

    await waitFor(() => expect(screen.getByTestId("agent-page-panel-routines")).toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByTestId("agent-page-no-access-routines")).toBeInTheDocument(),
    )
    expect(pathsMatching(api, (p) => p.startsWith("/agent/routines"))).toEqual([])
    expect(screen.queryByTestId("agent-routines-tab")).toBeNull()
    expect(toasts()).toEqual([])
  })

  it("a viewer without kernel:agent:memory:read asks for neither the tree nor the typed rows", async () => {
    grants.delete("kernel:agent:memory:read")
    const api = setup({
      forbid: [`/agents/${ROLE_AGENT}/memory`, "/agent/memories"],
      files: [file("project/one.md")],
    })

    await waitFor(() => expect(screen.getByTestId("agent-page-panel-memory")).toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByTestId("agent-page-no-access-memory")).toBeInTheDocument(),
    )
    expect(pathsMatching(api, (p) => p.includes("/memory/") || p === "/agent/memories")).toEqual([])
    expect(screen.queryByTestId("agent-memory-tree")).toBeNull()
    expect(toasts()).toEqual([])
  })

  it("the no-access line is the catalog string, in both halves of the page", async () => {
    grants.delete("kernel:skills:read")
    setup()
    await waitFor(() =>
      expect(screen.getByTestId("agent-page-no-access-skills")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("agent-page-no-access-skills").textContent).toBe(
      "You do not have access to this.",
    )
  })

  it("with the scopes granted every tab still fetches exactly as before", async () => {
    const api = setup({ files: [file("project/one.md")] })

    await waitFor(() => expect(screen.getByTestId("agent-memory-tree")).toBeInTheDocument())
    await waitFor(() =>
      expect(pathsMatching(api, (p) => p.startsWith("/agent/skills")).length).toBe(1),
    )
    expect(pathsMatching(api, (p) => p.startsWith("/agent/routines")).length).toBeGreaterThan(0)
    expect(pathsMatching(api, (p) => p.includes("/memory/tree")).length).toBe(1)
    expect(pathsMatching(api, (p) => p === "/agent/memories").length).toBe(1)
    expect(screen.queryByTestId("agent-page-no-access-skills")).toBeNull()
    expect(screen.queryByTestId("agent-page-no-access-routines")).toBeNull()
    expect(screen.queryByTestId("agent-page-no-access-memory")).toBeNull()
  })
  // @base is a TEMPLATE, never a correspondent (charter agent.md): its page
  // stays reachable by URL, which is how an admin inspects it, but the primary
  // Message action is ABSENT from the DOM, not disabled.
  it("the system agent's page offers no Message, and a role agent's still does", async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId("agent-page-message")).toBeInTheDocument())
    cleanup()

    const BASE = "44444444-4444-4444-8444-444444444444"
    setup({
      entityId: "@base",
      agents: [{ id: BASE, handle: "@base", displayName: "base", kind: "system" }],
      detail: detailFor(BASE, { handle: "@base", displayName: "base", kind: "system" }),
    })
    await waitFor(() => expect(screen.getByTestId("agent-page-handle")).toBeInTheDocument())
    expect(screen.queryByTestId("agent-page-message")).toBeNull()
  })
  // The listing carries the `kind='system'` row for an agents admin and for
  // NOBODY else (directory listing.ts), so a member who deep links @base
  // resolves no agent at all. Unknown is not "an ordinary correspondent":
  // neither control may be in the DOM.
  it("a member whose listing carries no such agent is offered neither control", async () => {
    grants.add("kernel:threads:admin")
    addThread({
      id: "c-11",
      handle: "@ops",
      title: "Ops",
      type: "thread",
      discoverable: true,
      createdBy: VIEWER,
      participants: [
        { id: VIEWER, name: "Me" },
        { id: "other", name: "Other" },
      ],
      updatedAt: "2026-09-13T10:00:00.000Z",
    })
    setup({ entityId: "@base", agents: [] })
    await waitFor(() => expect(screen.getByTestId("agent-overview")).toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-capabilities")).toBeInTheDocument(),
    )
    expect(screen.queryByTestId("agent-page-message")).toBeNull()
    expect(screen.queryByTestId("agent-overview-add-to-channel")).toBeNull()
  })

  // A cold deep link must not flash a Message button for the length of one
  // round trip: while nothing has said what kind of agent this is, neither
  // control is in the DOM.
  it("while the page read is pending neither control is in the DOM", async () => {
    grants.add("kernel:threads:admin")
    const PENDING = "66666666-6666-4666-8666-666666666666"
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    addThread({
      id: "c-12",
      handle: "@ops2",
      title: "Ops two",
      type: "thread",
      discoverable: true,
      createdBy: VIEWER,
      participants: [
        { id: VIEWER, name: "Me" },
        { id: "other", name: "Other" },
      ],
      updatedAt: "2026-09-13T10:00:00.000Z",
    })
    setup({
      entityId: "@ops-agent",
      agents: [{ id: PENDING, handle: "@ops-agent", displayName: "Ops agent", kind: "role" }],
      agentsGate: gate,
      detailGate: gate,
      detail: detailFor(PENDING, { kind: "role" }),
    })
    await waitFor(() => expect(screen.getByTestId("agent-overview")).toBeInTheDocument())
    expect(screen.queryByTestId("agent-page-message")).toBeNull()
    expect(screen.queryByTestId("agent-overview-add-to-channel")).toBeNull()

    release?.()
    // Once the read lands and says this is an ordinary agent, both come back.
    await waitFor(() => expect(screen.getByTestId("agent-page-message")).toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-add-to-channel")).toBeInTheDocument(),
    )
  })
  // THE LISTING WITHHOLDS a colleague's personal agent even from an agents
  // admin (directory/listing.ts), while the page read answers for it, and the
  // openers that have only an id route by the raw uuid. Keying the page read
  // on the listing alone turned that into "Agent not found" with an empty
  // header and no way to write to the agent.
  it("an agent only the page read knows still fills the header and offers Message", async () => {
    const COLLEAGUE = "77777777-7777-4777-8777-777777777777"
    grants.add("kernel:agents:admin")
    setup({
      entityId: COLLEAGUE,
      agents: [],
      detail: detailFor(COLLEAGUE, {
        handle: "@bob",
        displayName: "Bob's agent",
        kind: "personal",
        ownerUserId: SOMEONE_ELSE,
      }),
    })
    await waitFor(() =>
      expect(screen.getByTestId("agent-profile-name").textContent).toBe("Bob's agent"),
    )
    expect(screen.getByTestId("agent-page-handle").textContent).toBe("@bob")
    expect(screen.getByTestId("agent-page-kind").textContent).toBe("Personal agent")
    expect(screen.getByTestId("agent-page-message")).toBeInTheDocument()
    // The whole page, not half of it: the admin reads this agent's Memory
    // too, and the tab was silently absent because it asked the listing.
    expect(tabNames()).toContain("memory")
    expect(screen.getByTestId("agent-page-panel-memory")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-profile-memory-denied")).toBeNull()
  })

  // The same route, when the page read says this is the template: still no
  // Message and no Add to channel.
  it("an agent only the page read knows, and that is the template, offers neither control", async () => {
    const BASE_ID = "88888888-8888-4888-8888-888888888888"
    grants.add("kernel:agents:admin")
    grants.add("kernel:threads:admin")
    addThread({
      id: "c-13",
      handle: "@ops3",
      title: "Ops three",
      type: "thread",
      discoverable: true,
      createdBy: VIEWER,
      participants: [
        { id: VIEWER, name: "Me" },
        { id: "other", name: "Other" },
      ],
      updatedAt: "2026-09-13T10:00:00.000Z",
    })
    setup({
      entityId: BASE_ID,
      agents: [],
      detail: detailFor(BASE_ID, { handle: "@base", displayName: "base", kind: "system" }),
    })
    await waitFor(() => expect(screen.getByTestId("agent-profile-name").textContent).toBe("base"))
    expect(screen.queryByTestId("agent-page-message")).toBeNull()
    expect(screen.queryByTestId("agent-overview-add-to-channel")).toBeNull()
  })
  // A cold load said "This agent is not available." to everyone for as long as
  // the reads took, then replaced it with the agent.
  it("claims nothing about the agent while the reads are in flight", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setup({ agentsGate: gate, detailGate: gate })
    const name = await screen.findByTestId("agent-profile-name")
    expect(name.textContent).toBe("")
    expect(screen.queryByText("This agent is not available.")).toBeNull()

    release?.()
    await waitFor(() =>
      expect(screen.getByTestId("agent-profile-name").textContent).toBe("Logistics"),
    )
  })
})

/**
 * The sidebar's "+" opens `/agents/new/settings`: the create form, on a page
 * that has no agent behind it YET. Neither read can resolve `new`, and the page
 * used to take that as a missing agent: the header said "This agent is not
 * available." and the tab strip offered Overview and Knowledge of nobody.
 */
describe("AgentPage create mode", () => {
  beforeEach(() => {
    grants.clear()
    grantTabReads()
    grants.add("kernel:agents:admin")
    viewerId = VIEWER
    resetAgentMemoryStore()
    resetSkillsStore()
    resetRoutinesStore()
    resetTabStore()
    openTab({
      type: "agents:agent",
      entityId: "new",
      label: "New agent",
      routePath: "/agents/new/settings",
    })
  })
  afterEach(() => {
    cleanup()
    resetTabStore()
  })

  it("the new agent route lands on the create form, never on an agent that is not available", async () => {
    const api = setup({ entityId: "new" })

    const form = await screen.findByTestId("agent-settings-form")
    // Give both reads the time to settle: the failure only showed once they had.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/agents"))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(form).toBeVisible()
    expect(screen.getByTestId("agent-page-panel-settings")).toBeVisible()
    expect(screen.queryByText("This agent is not available.")).toBeNull()
    expect(screen.getByTestId("agent-profile-name").textContent).toBe("New agent")
    // No read addresses the placeholder as if it were an agent.
    const calls = api.get.mock.calls.map((c: any[]) => String(c[0]))
    expect(
      calls.filter((p: string) => p.startsWith("/agents/new") || p.includes("/agents//")),
    ).toEqual([])
    // Nothing to browse on an agent that does not exist yet: the create form is the page.
    expect(tabNames()).toEqual([])
    expect(tabStore.tabs.find((t) => t.entityId === "new")?.routePath).toBe("/agents/new/settings")
  })
})

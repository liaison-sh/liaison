// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S8-S18 (and the import rules it keeps: S40-S43, A44, A56, D47, D53): the
// Import sessions tab. The tree groups the shared folders with exact counts,
// the folder worked in first and open; a folder above its loaded rows lists
// itself alone; Not shared yet groups say a name, a path and a count, never a
// title, and Share re-lists; the skipped line; the detail pane's Follow, Take
// over and Open in Liaison; listings one at a time with one quiet retry on
// superseded; an older computer still renders; the phone pushes the detail.
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const tier = vi.hoisted(() => ({ current: "desktop" as "desktop" | "tablet" | "phone" }))

vi.mock("~/modules/shell/tab-store", () => ({ openTab: vi.fn() }))
vi.mock("~/modules/shell/shell-tier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/shell-tier")>()),
  shellTier: () => tier.current,
}))
// Flatten PopupMenu (no portal, no Kobalte focus handling) so its items are
// clickable in the DOM; as TicketFilterBar.test.tsx does.
vi.mock("~/ui/PopupMenu", () => {
  const Root = (props: any) => <>{props.children}</>
  const Trigger = (props: any) => <div data-testid={props["data-testid"]}>{props.children}</div>
  const Content = (props: any) => <div role="menu">{props.children}</div>
  const Item = (props: any) => (
    <button type="button" data-testid={props["data-testid"]} onClick={() => props.onSelect?.()}>
      {props.children}
    </button>
  )
  const Separator = () => <hr />
  const PopupMenu = Object.assign(Root, { Trigger, Content, Item, Separator })
  return { PopupMenu }
})

import { I18nProvider } from "~/modules/i18n/i18n-context"
import type { NodeSummary } from "~/modules/nodes/node-api"
import { resetNodesStore, setNodesStoreApi } from "~/modules/nodes/nodes-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import ImportSessionsView from "./ImportSessionsView"
import { importSupported, resetImportSupport } from "./import-support"
import type { ImportableRow } from "./session-api"

function node(over: Partial<NodeSummary> = {}): NodeSummary {
  return {
    id: "n1",
    name: "Studio Mac",
    enabled: true,
    online: true,
    lastSeenAt: "2026-10-13T10:00:00.000Z",
    os: "macos",
    appVersion: "0.1.30",
    deviceId: "d1",
    queue: { queued: 0, running: 0 },
    sharedFolderNames: ["repo"],
    models: [{ id: "claude-haiku-5-5", label: "Haiku 5.5" }],
    levelPins: [],
    ...over,
  }
}

const MIN = 60_000

function row(over: Partial<ImportableRow> = {}): ImportableRow {
  return {
    candidateId: "c-1",
    title: "Fix the build",
    firstPrompt: "fix it",
    folderName: "repo",
    worktreePath: null,
    cwdSubdir: "",
    branch: "main",
    lastModified: Date.now() - 5 * MIN,
    createdAt: null,
    sizeBytes: 4096,
    from: "cli",
    liveNow: false,
    inLiaison: null,
    ...over,
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const page = (data: Record<string, unknown>) => json(200, { data: { truncated: false, ...data } })

interface Setup {
  nodes?: NodeSummary[]
  /** Each listing GET's answer, in order; the last one repeats. A function sees the path. */
  listings?: Array<Response | ((path: string) => Response | Promise<Response>)>
  starts?: Response[]
  post?: (path: string, body: unknown) => unknown
}

function setup(opts: Setup = {}) {
  const nodes = opts.nodes ?? [node()]
  const get = vi.fn(async (path: string) => {
    if (path === "/nodes/me") return { nodes }
    throw new Error(`unexpected GET ${path}`)
  })
  const listings = [...(opts.listings ?? [page({ rows: [row()] })])]
  const rawGet = vi.fn(async (path: string, _init?: unknown) => {
    const next = listings.length > 1 ? listings.shift() : listings[0]
    const res = typeof next === "function" ? await next(path) : next
    return (res as Response).clone()
  })
  const starts = [...(opts.starts ?? [json(201, { data: { sessionId: "s-new" } })])]
  const rawPost = vi.fn(
    async (_path: string, _body: unknown, _init?: unknown) =>
      starts.shift() ?? json(201, { data: { sessionId: "s-new" } }),
  )
  const post = vi.fn(async (path: string, body: unknown) => opts.post?.(path, body))
  const api = { get, rawGet, rawPost, post, put: vi.fn(), delete: vi.fn() } as never
  setNodesStoreApi(() => api)
  render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api}>
        <ImportSessionsView />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return { get, rawGet, rawPost, post }
}

const listCalls = (rawGet: ReturnType<typeof vi.fn>) =>
  rawGet.mock.calls
    .map((c) => c[0] as string)
    .filter((p) => p.startsWith("/me/node-session-imports"))

const groupNames = () =>
  screen.getAllByTestId("import-folder-group").map((g) => g.getAttribute("data-name"))
const group = (name: string) =>
  screen
    .getAllByTestId("import-folder-group")
    .find((g) => g.getAttribute("data-name") === name) as HTMLElement

beforeEach(() => {
  vi.mocked(openTab).mockClear()
  resetImportSupport()
  tier.current = "desktop"
})

afterEach(() => {
  resetNodesStore()
  setNodesStoreApi(() => null)
})

describe("the tree (S9, S10, S12)", () => {
  it("S9, S12: one group per shared folder with its exact count; the newest folder first and open", async () => {
    setup({
      nodes: [node({ sharedFolderNames: ["repo", "docs", "empty"] })],
      listings: [
        page({
          rows: [
            row({ candidateId: "c-1", folderName: "repo", lastModified: Date.now() - 60 * MIN }),
            row({ candidateId: "c-2", folderName: "docs", title: "Write docs" }),
          ],
          folders: [
            { name: "repo", sessions: 1 },
            { name: "docs", sessions: 1 },
            { name: "empty", sessions: 0 },
          ],
        }),
      ],
    })
    await waitFor(() => expect(groupNames()).toEqual(["docs", "repo", "empty"]))
    expect(within(group("docs")).getByTestId("import-folder-count").textContent).toBe("1")
    expect(within(group("empty")).getByTestId("import-folder-count").textContent).toBe("0")
    expect(within(group("docs")).getByTestId("import-folder").getAttribute("aria-expanded")).toBe(
      "true",
    )
    expect(within(group("repo")).queryAllByTestId("import-row")).toHaveLength(0)
    expect(screen.getByTestId("import-working-in").textContent).toContain("docs")
  })

  it("S9: picking a folder in Working in leads the tree with it, opened", async () => {
    setup({
      nodes: [node({ sharedFolderNames: ["repo", "docs"] })],
      listings: [
        page({
          rows: [
            row({ candidateId: "c-1", folderName: "repo", lastModified: Date.now() - 60 * MIN }),
            row({ candidateId: "c-2", folderName: "docs" }),
          ],
          folders: [
            { name: "repo", sessions: 1 },
            { name: "docs", sessions: 1 },
          ],
        }),
      ],
    })
    await waitFor(() => expect(groupNames()).toEqual(["docs", "repo"]))
    fireEvent.click(screen.getByTestId("import-working-in-repo"))
    await waitFor(() => expect(groupNames()).toEqual(["repo", "docs"]))
    expect(within(group("repo")).getAllByTestId("import-row")).toHaveLength(1)
  })

  it("S10, D53: rows newest first; a worktree or subfolder row sits under its folder with the place in its meta", async () => {
    setup({
      listings: [
        page({
          rows: [
            row({ candidateId: "c-old", title: "Old", lastModified: Date.now() - 90 * MIN }),
            row({
              candidateId: "c-wt",
              title: "In the worktree",
              worktreePath: "/home/me/code/repo-wt",
              cwdSubdir: "pkg",
              branch: "feat",
            }),
            row({
              candidateId: "c-sub",
              title: "In a subfolder",
              cwdSubdir: "apps/web",
              lastModified: Date.now() - 30 * MIN,
            }),
          ],
        }),
      ],
    })
    await waitFor(() => expect(screen.getAllByTestId("import-row")).toHaveLength(3))
    const rows = screen.getAllByTestId("import-row")
    expect(rows.map((r) => r.textContent?.includes("In the worktree"))[0]).toBe(true)
    expect(rows[0]?.querySelector("[data-testid=import-row-meta]")?.textContent).toContain(
      "feat · repo-wt/pkg",
    )
    expect(rows[1]?.textContent).toContain("apps/web")
    expect(rows[2]?.textContent).toContain("Old")
    // Charter: the worktree's absolute path on the computer is never shown.
    fireEvent.click(rows[0] as HTMLElement)
    expect(screen.getByTestId("import-detail-place").textContent).toBe("repo-wt/pkg")
    expect(screen.getByTestId("import-sessions").textContent).not.toContain("/home/me")
  })

  it("S12: a folder's own listing replaces its rows, though the API names each row anew", async () => {
    const at = Date.now() - 5 * MIN
    setup({
      nodes: [node({ sharedFolderNames: ["repo", "docs"] })],
      listings: [
        page({
          rows: [
            row({ candidateId: "c-1", folderName: "repo" }),
            row({ candidateId: "c-d1", folderName: "docs", title: "Docs one", lastModified: at }),
          ],
          folders: [
            { name: "repo", sessions: 1 },
            { name: "docs", sessions: 2 },
          ],
        }),
        page({
          rows: [
            row({ candidateId: "c-x1", folderName: "docs", title: "Docs one", lastModified: at }),
            row({
              candidateId: "c-x2",
              folderName: "docs",
              title: "Docs two",
              lastModified: at + MIN,
            }),
          ],
          folders: [{ name: "docs", sessions: 2 }],
        }),
      ],
    })
    await waitFor(() => expect(screen.getAllByTestId("import-folder-group")).toHaveLength(2))
    const docs = () => group("docs")
    if (docs().querySelector("[aria-expanded=false]")) {
      fireEvent.click(within(docs()).getByTestId("import-folder"))
    }
    await waitFor(() =>
      expect(
        within(docs())
          .getAllByTestId("import-row")
          .map((r) => r.textContent),
      ).toEqual([expect.stringContaining("Docs two"), expect.stringContaining("Docs one")]),
    )
    expect(within(docs()).getByTestId("import-folder-count").textContent).toBe("2")
  })

  it("S12: a folder listing that fails says why, with Retry that lists the folder again", async () => {
    const { rawGet } = setup({
      nodes: [node({ sharedFolderNames: ["repo", "docs"] })],
      listings: [
        page({
          rows: [row({ candidateId: "c-1", folderName: "repo" })],
          folders: [
            { name: "repo", sessions: 1 },
            { name: "docs", sessions: 1 },
          ],
        }),
        json(409, { error: { code: "node_offline", message: "m" } }),
        page({
          rows: [row({ candidateId: "c-d1", folderName: "docs", title: "Docs one" })],
          folders: [{ name: "docs", sessions: 1 }],
        }),
      ],
    })
    await waitFor(() => expect(groupNames()).toEqual(["repo", "docs"]))
    fireEvent.click(within(group("docs")).getByTestId("import-folder"))
    const error = await waitFor(() => within(group("docs")).getByTestId("import-folder-error"))
    expect(error.textContent).toContain("This computer is offline.")
    fireEvent.click(within(group("docs")).getByTestId("import-folder-retry"))
    await waitFor(() => expect(within(group("docs")).getAllByTestId("import-row")).toHaveLength(1))
    expect(within(group("docs")).queryByTestId("import-folder-error")).toBeNull()
    expect(listCalls(rawGet)).toEqual([
      "/me/node-session-imports?nodeId=n1",
      "/me/node-session-imports?nodeId=n1&folder=docs",
      "/me/node-session-imports?nodeId=n1&folder=docs",
    ])
  })

  it("S12: opening a folder whose count is above its loaded rows lists that folder alone", async () => {
    const { rawGet } = setup({
      nodes: [node({ sharedFolderNames: ["repo", "docs"] })],
      listings: [
        page({
          rows: [row({ candidateId: "c-1", folderName: "repo" })],
          folders: [
            { name: "repo", sessions: 1 },
            { name: "docs", sessions: 2 },
          ],
        }),
        page({
          rows: [
            row({ candidateId: "c-d1", folderName: "docs", title: "Docs one" }),
            row({ candidateId: "c-d2", folderName: "docs", title: "Docs two" }),
          ],
          folders: [{ name: "docs", sessions: 2 }],
        }),
      ],
    })
    await waitFor(() => expect(groupNames()).toEqual(["repo", "docs"]))
    fireEvent.click(within(group("docs")).getByTestId("import-folder"))
    await waitFor(() => expect(within(group("docs")).getAllByTestId("import-row")).toHaveLength(2))
    expect(listCalls(rawGet)).toEqual([
      "/me/node-session-imports?nodeId=n1",
      "/me/node-session-imports?nodeId=n1&folder=docs",
    ])
    // Closed and opened again: no second listing.
    fireEvent.click(within(group("docs")).getByTestId("import-folder"))
    fireEvent.click(within(group("docs")).getByTestId("import-folder"))
    expect(listCalls(rawGet)).toHaveLength(2)
  })

  it("S12: a folder answer without counts (a plain fallback) keeps the loaded rows and says showing N of M", async () => {
    setup({
      nodes: [node({ sharedFolderNames: ["repo", "docs"] })],
      listings: [
        page({
          rows: [
            row({ candidateId: "c-1", folderName: "repo" }),
            row({ candidateId: "c-d1", folderName: "docs", title: "Docs one" }),
          ],
          folders: [
            { name: "repo", sessions: 1 },
            { name: "docs", sessions: 5 },
          ],
          truncated: true,
        }),
        page({
          rows: [
            row({ candidateId: "c-x", folderName: "docs", title: "From the fallback" }),
            row({ candidateId: "c-y", folderName: "repo", title: "Other folder" }),
          ],
        }),
      ],
    })
    await waitFor(() => expect(screen.getAllByTestId("import-folder-group")).toHaveLength(2))
    const docs = () => group("docs")
    if (docs().querySelector("[aria-expanded=false]")) {
      fireEvent.click(within(docs()).getByTestId("import-folder"))
    }
    await waitFor(() => expect(within(docs()).getByTestId("import-folder-more")).toBeTruthy())
    expect(
      within(docs())
        .getAllByTestId("import-row")
        .map((r) => r.textContent),
    ).toEqual([expect.stringContaining("Docs one")])
    expect(within(docs()).getByTestId("import-folder-more").textContent).toBe(
      "Showing 1 of 5. Search to find the rest.",
    )
    expect(screen.queryByText("From the fallback")).toBeNull()
    expect(screen.getByTestId("import-search")).toBeTruthy()
  })

  it("S16: an older computer's answer (no counts, no groups, no skipped) renders from its rows, and never lists per folder", async () => {
    const { rawGet } = setup({
      nodes: [node({ sharedFolderNames: ["repo", "docs"] })],
      listings: [
        page({
          rows: [
            row({ candidateId: "c-1", folderName: "repo" }),
            row({ candidateId: "c-2", folderName: "repo", title: "Two" }),
          ],
        }),
      ],
    })
    await waitFor(() => expect(groupNames()).toEqual(["repo", "docs"]))
    expect(within(group("repo")).getByTestId("import-folder-count").textContent).toBe("2")
    expect(within(group("docs")).getByTestId("import-folder-count").textContent).toBe("0")
    fireEvent.click(within(group("docs")).getByTestId("import-folder"))
    await new Promise((r) => setTimeout(r, 30))
    expect(listCalls(rawGet)).toHaveLength(1)
    expect(screen.queryByTestId("import-unshared")).toBeNull()
    expect(screen.queryByTestId("import-skipped")).toBeNull()
  })

  it("S14: sessions that could not be read are counted", async () => {
    setup({
      listings: [page({ rows: [row()], folders: [{ name: "repo", sessions: 1 }], skipped: 3 })],
    })
    expect((await screen.findByTestId("import-skipped")).textContent).toBe(
      "Sessions that could not be read: 3.",
    )
  })

  it("a repo inside a shared folder sits under it, with no empty one; the footer counts both apart", async () => {
    setup({
      nodes: [
        node({
          sharedFolderNames: ["mono", "site", "lab", "notes"],
          sharedFolderWithin: { site: "mono", lab: "mono" },
        }),
      ],
      listings: [
        page({
          rows: [
            row({ candidateId: "c-1", folderName: "mono", lastModified: Date.now() - 60 * MIN }),
            row({ candidateId: "c-2", folderName: "site", title: "Fix the site" }),
            row({ candidateId: "c-3", folderName: "notes", lastModified: Date.now() - 90 * MIN }),
          ],
          folders: [
            { name: "mono", sessions: 1 },
            { name: "site", sessions: 1 },
            { name: "lab", sessions: 0 },
            { name: "notes", sessions: 1 },
          ],
        }),
      ],
    })
    // site's newest row would lead the tree; it follows its folder instead.
    await waitFor(() => expect(groupNames()).toEqual(["mono", "site", "notes"]))
    expect(group("site").getAttribute("data-within")).toBe("mono")
    expect(within(group("site")).getByTestId("import-folder-repo-icon")).toBeTruthy()
    expect(within(group("site")).getByTestId("import-folder").getAttribute("title")).toBe(
      "A git repository inside mono",
    )
    expect(group("mono").getAttribute("data-within")).toBeNull()
    const summary = screen.getByTestId("import-shared-summary")
    expect(summary.textContent).toBe("Shared folders: 2 · Repositories inside: 2")
    expect(summary.getAttribute("title")).toContain("each git repository directly inside it")
  })

  it("picking a repo inside a folder leads with its folder, the repo first beneath it", async () => {
    setup({
      nodes: [
        node({
          sharedFolderNames: ["mono", "site", "notes"],
          sharedFolderWithin: { site: "mono" },
        }),
      ],
      listings: [
        page({
          rows: [
            row({ candidateId: "c-1", folderName: "mono", lastModified: Date.now() - 60 * MIN }),
            row({ candidateId: "c-2", folderName: "site", lastModified: Date.now() - 90 * MIN }),
            row({ candidateId: "c-3", folderName: "notes" }),
          ],
          folders: [
            { name: "mono", sessions: 1 },
            { name: "site", sessions: 1 },
            { name: "notes", sessions: 1 },
          ],
        }),
      ],
    })
    await waitFor(() => expect(groupNames()).toEqual(["notes", "mono", "site"]))
    fireEvent.click(screen.getByTestId("import-working-in-site"))
    await waitFor(() => expect(groupNames()).toEqual(["mono", "site", "notes"]))
    expect(screen.getByTestId("import-shared-summary").textContent).toBe(
      "Shared folders: 2 · Repositories inside: 1",
    )
  })

  it("no repo inside: the footer counts the shared folders alone", async () => {
    setup({ nodes: [node({ sharedFolderNames: ["repo", "docs"] })] })
    await waitFor(() =>
      expect(screen.getByTestId("import-shared-summary").textContent).toBe("Shared folders: 2"),
    )
  })

  it("edge: no session anywhere says so, with Manage folders", async () => {
    setup({
      listings: [page({ rows: [], folders: [{ name: "repo", sessions: 0 }], unshared: [] })],
    })
    expect((await screen.findByTestId("import-empty")).textContent).toContain(
      "No Claude Code sessions on this computer yet.",
    )
    expect(screen.getByTestId("import-manage-folders")).toBeTruthy()
  })
})

describe("Not shared yet (S13)", () => {
  const unshared = [
    {
      candidateId: "f-1",
      name: "side",
      display: "~/code/side",
      sessions: 3,
      lastModified: Date.now(),
      refusal: null,
    },
    {
      candidateId: null,
      name: "tmp",
      display: "tmp",
      sessions: 1,
      lastModified: Date.now(),
      refusal: "outside_search",
    },
  ]

  it("shows a name, a path and a count, never a title; Share calls the share route, then lists again", async () => {
    const { rawGet, post } = setup({
      listings: [
        page({ rows: [row()], folders: [{ name: "repo", sessions: 1 }], unshared }),
        page({
          rows: [row(), row({ candidateId: "c-s", folderName: "side", title: "Side work" })],
          folders: [
            { name: "repo", sessions: 1 },
            { name: "side", sessions: 3 },
          ],
          unshared: [unshared[1]],
        }),
      ],
      post: () => ({ shared: { roots: [] }, search: { roots: [] } }),
    })
    const groups = await screen.findAllByTestId("import-unshared-group")
    expect(groups).toHaveLength(2)
    expect(groups[0]?.textContent).toContain("side")
    expect(groups[0]?.textContent).toContain("~/code/side")
    expect(within(groups[0] as HTMLElement).getByTestId("import-unshared-count").textContent).toBe(
      "3",
    )
    expect(screen.getByTestId("import-unshared").textContent).not.toContain("Side work")
    fireEvent.click(within(groups[0] as HTMLElement).getByTestId("import-unshared-share"))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/nodes/n1/folders/share", { candidateId: "f-1" }),
    )
    await waitFor(() => expect(screen.getAllByTestId("import-unshared-group")).toHaveLength(1))
    expect(listCalls(rawGet)).toHaveLength(2)
    expect(groupNames()).toContain("side")
  })

  it("a group that cannot be shared says why; outside the search places links to Computers settings", async () => {
    setup({ listings: [page({ rows: [row()], unshared: [unshared[1]], unsharedPartial: true })] })
    const reason = await screen.findByTestId("import-unshared-reason")
    expect(reason.textContent).toContain("Outside the places Add a folder looks in.")
    expect(screen.queryByTestId("import-unshared-share")).toBeNull()
    expect(screen.getByTestId("import-unshared-more")).toBeTruthy()
    fireEvent.click(screen.getByTestId("import-unshared-settings"))
    expect(openTab).toHaveBeenCalledWith({
      type: "kernel:settings",
      entityId: "settings",
      label: "Settings",
      routePath: "/settings/computers/n1",
      preview: false,
    })
  })
})

describe("Not shared yet, without a fresh share proof", () => {
  const later = {
    candidateId: null,
    name: "side",
    display: "~/code/side",
    sessions: 2,
    lastModified: Date.now(),
    refusal: null,
  }

  it("a group with no proof and no refusal keeps Share; Share lists in full again, then shares with the fresh id", async () => {
    const { rawGet, post } = setup({
      listings: [
        page({ rows: [row()], folders: [{ name: "repo", sessions: 1 }], unshared: [later] }),
        page({
          rows: [row()],
          folders: [{ name: "repo", sessions: 1 }],
          unshared: [{ ...later, candidateId: "f-fresh" }],
        }),
        page({ rows: [row()], folders: [{ name: "repo", sessions: 1 }], unshared: [] }),
      ],
      post: () => ({ shared: { roots: [] }, search: { roots: [] } }),
    })
    fireEvent.click(await screen.findByTestId("import-unshared-share"))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/nodes/n1/folders/share", { candidateId: "f-fresh" }),
    )
    await waitFor(() => expect(screen.queryByTestId("import-unshared")).toBeNull())
    expect(listCalls(rawGet)).toEqual([
      "/me/node-session-imports?nodeId=n1",
      "/me/node-session-imports?nodeId=n1",
      "/me/node-session-imports?nodeId=n1",
    ])
  })

  it("a search answer's groups never replace the full listing's", async () => {
    setup({
      listings: [
        page({
          rows: [row()],
          truncated: true,
          unshared: [{ ...later, candidateId: "f-1" }],
          skipped: 2,
        }),
        page({
          rows: [row({ candidateId: "c-old", title: "Old migration" })],
          unshared: [{ ...later, name: "other", display: "~/other" }],
        }),
      ],
    })
    await screen.findByTestId("import-unshared-group")
    fireEvent.input(screen.getByTestId("import-search"), { target: { value: "migration" } })
    fireEvent.click(await screen.findByTestId("import-search-all"))
    await waitFor(() =>
      expect(screen.getByTestId("import-row").textContent).toContain("Old migration"),
    )
    const groups = screen.getAllByTestId("import-unshared-group")
    expect(groups).toHaveLength(1)
    expect(groups[0]?.textContent).toContain("~/code/side")
    expect(screen.getByTestId("import-skipped").textContent).toContain("2")
  })
})

describe("the detail pane (S11)", () => {
  it("S11: shows the picked row; Follow imports it, opens the session, and the row turns In Liaison", async () => {
    const { rawPost } = setup({
      listings: [page({ rows: [row({ firstPrompt: "please fix the build" })] })],
    })
    fireEvent.click(await screen.findByTestId("import-row"))
    const detail = screen.getByTestId("import-detail")
    expect(screen.getByTestId("import-detail-title").textContent).toBe("Fix the build")
    expect(screen.getByTestId("import-detail-status").textContent).toContain("Available")
    expect(screen.getByTestId("import-detail-folder").textContent).toBe("repo")
    expect(detail.textContent).toContain("main")
    expect(screen.getByTestId("import-detail-prompt").textContent).toBe("please fix the build")
    fireEvent.click(screen.getByTestId("import-follow"))
    await waitFor(() =>
      expect(rawPost).toHaveBeenCalledWith(
        "/me/node-session-imports",
        { candidateId: "c-1", mode: "follow" },
        { suppressGlobalError: true },
      ),
    )
    // A permanent tab: a preview one would replace this (preview) tab, and
    // the person could not see the row turn In Liaison or follow another.
    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "kernel:session",
          entityId: "s-new",
          routePath: "/sessions/s-new",
          preview: false,
        }),
      ),
    )
    await waitFor(() => expect(screen.getByTestId("import-row").dataset.status).toBe("imported"))
    expect(screen.getByTestId("import-row-pill").textContent).toBe("In Liaison")
    expect(screen.queryByTestId("import-follow")).toBeNull()
    expect(screen.getByTestId("import-in-liaison").textContent).toBe("Open in Liaison")
  })

  it("S10, S11: an imported row is muted with an In Liaison pill and opens its session", async () => {
    setup({ listings: [page({ rows: [row({ inLiaison: "s-held" })] })] })
    const r = await screen.findByTestId("import-row")
    expect(r.className).toContain("opacity-60")
    expect(screen.getByTestId("import-row-pill").textContent).toBe("In Liaison")
    fireEvent.click(r)
    expect(screen.queryByTestId("import-follow")).toBeNull()
    fireEvent.click(screen.getByTestId("import-in-liaison"))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "kernel:session", entityId: "s-held" }),
    )
  })

  it("S11: a live session's Take over says why and runs on the second click", async () => {
    const { rawPost } = setup({ listings: [page({ rows: [row({ liveNow: true })] })] })
    fireEvent.click(await screen.findByTestId("import-row"))
    expect(screen.getByTestId("import-row").dataset.status).toBe("running")
    expect(screen.getByTestId("import-detail-status").textContent).toContain("Open now")
    // The warning is said once Take over is armed, never before.
    expect(screen.queryByTestId("import-live-warning")).toBeNull()
    const take = screen.getByTestId("import-take-over") as HTMLButtonElement
    fireEvent.click(take)
    expect(rawPost).not.toHaveBeenCalled()
    expect(screen.getByTestId("import-live-warning").textContent).toContain(
      "open in another Claude Code",
    )
    fireEvent.click(take)
    await waitFor(() =>
      expect(rawPost).toHaveBeenCalledWith(
        "/me/node-session-imports",
        { candidateId: "c-1", mode: "take_over" },
        { suppressGlobalError: true },
      ),
    )
  })

  it("S11: the picked row stays picked when the computer lists again under fresh ids", async () => {
    const at = Date.now() - 5 * MIN
    const side = {
      candidateId: "f-1",
      name: "side",
      display: "~/code/side",
      sessions: 1,
      lastModified: Date.now(),
      refusal: null,
    }
    const { rawPost } = setup({
      listings: [
        page({ rows: [row({ candidateId: "c-1", lastModified: at })], unshared: [side] }),
        page({ rows: [row({ candidateId: "c-9", lastModified: at })], unshared: [] }),
      ],
      post: () => ({ shared: { roots: [] }, search: { roots: [] } }),
    })
    fireEvent.click(await screen.findByTestId("import-row"))
    expect(screen.getByTestId("import-detail-title").textContent).toBe("Fix the build")
    fireEvent.click(screen.getByTestId("import-unshared-share"))
    await waitFor(() => expect(screen.queryByTestId("import-unshared")).toBeNull())
    expect(screen.getByTestId("import-detail-title").textContent).toBe("Fix the build")
    fireEvent.click(screen.getByTestId("import-follow"))
    await waitFor(() =>
      expect(rawPost).toHaveBeenCalledWith(
        "/me/node-session-imports",
        { candidateId: "c-9", mode: "follow" },
        { suppressGlobalError: true },
      ),
    )
  })

  it("Take over imports a session not open elsewhere", async () => {
    const { rawPost } = setup()
    fireEvent.click(await screen.findByTestId("import-row"))
    fireEvent.click(screen.getByTestId("import-take-over"))
    await waitFor(() =>
      expect(rawPost).toHaveBeenCalledWith(
        "/me/node-session-imports",
        { candidateId: "c-1", mode: "take_over" },
        { suppressGlobalError: true },
      ),
    )
  })

  it("A56: a from-liaison row offers no Follow and no Take over", async () => {
    setup({
      listings: [page({ rows: [row({ candidateId: null, from: "liaison", title: "Ours" })] })],
    })
    fireEvent.click(await screen.findByTestId("import-row"))
    expect(screen.getByTestId("import-detail").textContent).toContain("Liaison")
    expect(screen.queryByTestId("import-follow")).toBeNull()
    expect(screen.queryByTestId("import-take-over")).toBeNull()
  })

  it("S42: a start refused already_in_liaison links to the holding session", async () => {
    setup({
      starts: [
        json(409, { error: { code: "already_in_liaison", message: "m", sessionId: "s-1" } }),
      ],
    })
    fireEvent.click(await screen.findByTestId("import-row"))
    fireEvent.click(screen.getByTestId("import-follow"))
    const error = await screen.findByTestId("import-error")
    expect(error.textContent).toContain("already in Liaison")
    fireEvent.click(screen.getByTestId("import-error-open"))
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ entityId: "s-1" }))
  })

  it.each([
    ["unsafe_subdir", "no longer inside the shared folder"],
    ["symlink", "is a link"],
    ["not_regular", "not a regular file"],
    ["ambiguous_transcript", "Two transcripts"],
    ["already_liaison", "started by Liaison"],
    ["model_unavailable", "offers no model"],
  ])(
    "A44, S42: a start the computer refuses %s says why, never the generic failure",
    async (code, words) => {
      setup({ starts: [json(422, { error: { code, message: "m" } })] })
      fireEvent.click(await screen.findByTestId("import-row"))
      fireEvent.click(screen.getByTestId("import-follow"))
      const error = await screen.findByTestId("import-error")
      expect(error.textContent).toContain(words)
      expect(error.textContent).not.toContain("did not start")
    },
  )

  it("S43: the redaction and outside-content statements are shown", async () => {
    setup()
    const statements = await screen.findByTestId("import-statements")
    expect(statements.textContent).toContain(
      "Liaison removes keys, tokens, private keys and secret lines before anything leaves this computer. This is best effort: check before sharing.",
    )
    expect(statements.textContent).toContain(
      "A transcript may contain content the session read from outside the folder.",
    )
  })
})

describe("listings (S40, D47, A14, S15, S16)", () => {
  it("S40: one listing on open; typing filters in the client with no new request", async () => {
    const { rawGet } = setup({
      listings: [
        page({
          rows: [
            row({ candidateId: "c-1", title: "Fix the build", branch: "main" }),
            row({ candidateId: "c-2", title: "Write docs", branch: "docs-pass" }),
          ],
        }),
      ],
    })
    await waitFor(() => expect(screen.getAllByTestId("import-row")).toHaveLength(2))
    fireEvent.input(screen.getByTestId("import-search"), { target: { value: "docs-p" } })
    await waitFor(() => expect(screen.getAllByTestId("import-row")).toHaveLength(1))
    expect(screen.getByTestId("import-row").textContent).toContain("Write docs")
    await new Promise((r) => setTimeout(r, 50))
    expect(listCalls(rawGet)).toEqual(["/me/node-session-imports?nodeId=n1"])
  })

  it("D47: a truncated listing with no client match offers one server search, sent once", async () => {
    const { rawGet } = setup({
      listings: [
        page({ rows: [row()], truncated: true }),
        page({ rows: [row({ candidateId: "c-old", title: "Old migration" })] }),
      ],
    })
    await waitFor(() => expect(screen.getAllByTestId("import-row")).toHaveLength(1))
    const search = screen.getByTestId("import-search") as HTMLInputElement
    fireEvent.input(search, { target: { value: "fix" } })
    expect(screen.queryByTestId("import-search-all")).toBeNull()
    fireEvent.input(search, { target: { value: "migration" } })
    fireEvent.click(await screen.findByTestId("import-search-all"))
    await waitFor(() =>
      expect(screen.getByTestId("import-row").textContent).toContain("Old migration"),
    )
    fireEvent.submit(search.form as HTMLFormElement)
    await new Promise((r) => setTimeout(r, 50))
    expect(listCalls(rawGet)).toEqual([
      "/me/node-session-imports?nodeId=n1",
      "/me/node-session-imports?nodeId=n1&query=migration",
    ])
  })

  it("D47: clearing the search after a server search returns to the full listing and its counts", async () => {
    const { rawGet } = setup({
      listings: [
        page({ rows: [row()], folders: [{ name: "repo", sessions: 1 }], truncated: true }),
        page({
          rows: [
            row({ candidateId: "c-old", title: "Old migration" }),
            row({ candidateId: "c-old2", title: "Older migration" }),
          ],
          folders: [{ name: "repo", sessions: 2 }],
        }),
      ],
    })
    await waitFor(() => expect(screen.getAllByTestId("import-row")).toHaveLength(1))
    const search = screen.getByTestId("import-search") as HTMLInputElement
    fireEvent.input(search, { target: { value: "migration" } })
    fireEvent.click(await screen.findByTestId("import-search-all"))
    await waitFor(() => expect(screen.getAllByTestId("import-row")).toHaveLength(2))
    expect(screen.getByTestId("import-folder-count").textContent).toBe("2")
    fireEvent.input(search, { target: { value: "" } })
    await waitFor(() =>
      expect(screen.getAllByTestId("import-row").map((r) => r.textContent)).toEqual([
        expect.stringContaining("Fix the build"),
      ]),
    )
    expect(screen.getByTestId("import-folder-count").textContent).toBe("1")
    // The same search can be sent again.
    fireEvent.input(search, { target: { value: "migration" } })
    expect(await screen.findByTestId("import-search-all")).toBeTruthy()
    expect(listCalls(rawGet)).toHaveLength(2)
  })

  it("A14: a superseded listing is asked once more, quietly", async () => {
    const { rawGet } = setup({
      listings: [
        json(409, { error: { code: "superseded", message: "m" } }),
        page({ rows: [row()] }),
      ],
    })
    await waitFor(() => expect(screen.getAllByTestId("import-row")).toHaveLength(1))
    expect(listCalls(rawGet)).toHaveLength(2)
    expect(screen.queryByTestId("import-error")).toBeNull()
  })

  it("A14: listings run one at a time (a search waits for the folder listing before it)", async () => {
    let release: (() => void) | undefined
    let inFlight = 0
    let most = 0
    const track = (res: Response, hold: boolean) => async () => {
      inFlight++
      most = Math.max(most, inFlight)
      if (hold) {
        await new Promise<void>((r) => {
          release = r
        })
      }
      inFlight--
      return res
    }
    const { rawGet } = setup({
      nodes: [node({ sharedFolderNames: ["repo", "docs"] })],
      listings: [
        page({
          rows: [row({ folderName: "repo" })],
          folders: [
            { name: "repo", sessions: 1 },
            { name: "docs", sessions: 3 },
          ],
          truncated: true,
        }),
        track(page({ rows: [], folders: [{ name: "docs", sessions: 3 }] }), true),
        track(page({ rows: [row({ candidateId: "c-z", title: "zzz found" })] }), false),
      ],
    })
    await waitFor(() => expect(groupNames()).toEqual(["repo", "docs"]))
    fireEvent.click(within(group("docs")).getByTestId("import-folder"))
    await waitFor(() => expect(listCalls(rawGet)).toHaveLength(2))
    fireEvent.input(screen.getByTestId("import-search"), { target: { value: "zzz" } })
    fireEvent.click(await screen.findByTestId("import-search-all"))
    await new Promise((r) => setTimeout(r, 30))
    // Queued behind the folder listing.
    expect(listCalls(rawGet)).toHaveLength(2)
    release?.()
    await waitFor(() => expect(screen.getByTestId("import-row").textContent).toContain("zzz found"))
    expect(listCalls(rawGet)[2]).toBe("/me/node-session-imports?nodeId=n1&query=zzz")
    expect(most).toBe(1)
  })

  it("S40: node_outdated says to update the computer, with Try again", async () => {
    setup({ listings: [json(409, { error: { code: "node_outdated", message: "m" } })] })
    expect((await screen.findByTestId("import-error")).textContent).toContain(
      "Update Liaison on this computer",
    )
    expect(screen.queryAllByTestId("import-row")).toHaveLength(0)
    expect(screen.getByTestId("import-retry")).toBeTruthy()
  })

  it("D42: an older API (404) says to update the server and hides the entry", async () => {
    setup({ listings: [json(404, { error: { code: "NOT_FOUND", message: "Not found" } })] })
    expect((await screen.findByTestId("import-error")).textContent).toContain("Update the server")
    expect(importSupported()).toBe(false)
  })

  it("S9: lists again when the owner picks another online computer", async () => {
    const { rawGet } = setup({
      nodes: [node(), node({ id: "n2", name: "Laptop" }), node({ id: "n3", online: false })],
    })
    const picker = (await screen.findByTestId("import-node")) as HTMLSelectElement
    expect([...picker.options].map((o) => o.value)).toEqual(["n1", "n2"])
    await waitFor(() => expect(listCalls(rawGet)).toHaveLength(1))
    fireEvent.change(picker, { target: { value: "n2" } })
    await waitFor(() =>
      expect(listCalls(rawGet)).toEqual([
        "/me/node-session-imports?nodeId=n1",
        "/me/node-session-imports?nodeId=n2",
      ]),
    )
  })

  it("S15: Manage folders and Add or find folders open the computer's Folders settings in their own tab", async () => {
    setup()
    await screen.findByTestId("import-row")
    const settings = {
      type: "kernel:settings",
      entityId: "settings",
      label: "Settings",
      routePath: "/settings/computers/n1",
      preview: false,
    }
    fireEvent.click(screen.getByTestId("import-manage-folders"))
    expect(openTab).toHaveBeenLastCalledWith(settings)
    fireEvent.click(screen.getByTestId("import-add-folders"))
    expect(openTab).toHaveBeenLastCalledWith(settings)
    expect(screen.getByTestId("import-row")).toBeTruthy()
  })
})

describe("the phone (S18)", () => {
  it("shows the tree; picking a row pushes the detail, Back returns to the tree", async () => {
    tier.current = "phone"
    setup()
    fireEvent.click(await screen.findByTestId("import-row"))
    expect(screen.queryByTestId("import-tree")).toBeNull()
    expect(screen.getByTestId("import-detail-title").textContent).toBe("Fix the build")
    fireEvent.click(screen.getByTestId("import-detail-back"))
    expect(screen.getByTestId("import-tree")).toBeTruthy()
    expect(screen.queryByTestId("import-detail")).toBeNull()
  })
})

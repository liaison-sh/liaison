// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Computers > <computer> > Folders, from any client: the places
// the OS refused (a banner with System Settings on this computer, and Check
// again), the one list of folders agents can work in (a repository and its
// branch or a folder, missing on disk, Remove; the recent-folders default,
// Back to the default and the dropped note on this computer), Add a folder
// (find by name, then Add after a confirmation; choose with the picker on
// this computer; clone), and under More: where Add a folder looks, and the
// folder for work that needs no folder (this computer). Offline: said, no
// action. Every refusal in words, never a code. Phone: 44 px targets.
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import type { DesktopBridge } from "~/lib/desktop-shell-contract"
import type { NodeSummary } from "~/modules/nodes/node-api"
import { ApiContext } from "~/modules/shell/ApiContext"
import { ComputerFoldersTab } from "./ComputerFoldersTab"
import type { ThisComputer } from "./this-computer"

const node = (over: Partial<NodeSummary> = {}): NodeSummary => ({
  id: "n-1",
  name: "Mac",
  enabled: true,
  online: true,
  lastSeenAt: null,
  os: "macos",
  appVersion: null,
  deviceId: "d",
  queue: { queued: 0, running: 0 },
  sharedFolderNames: ["Reports"],
  ...over,
})

interface State {
  shared: string[]
  missing: string[]
  search: string[]
  isDefault?: boolean
  refused?: string[]
  repos?: Array<{ path: string; defaultBranch: string | null }>
  /** Places the computer does not let Liaison read. */
  denied?: string[]
}

function fakeApi(state: State, opts: { lookup?: unknown; refuse?: Record<string, string> } = {}) {
  const list = () => ({
    shared: {
      roots: state.shared,
      isDefault: state.isDefault === true,
      missing: state.missing,
      refused: state.refused ?? [],
      ...(state.repos ? { repos: state.repos } : {}),
    },
    search: {
      roots: state.search,
      display: state.search.map((p) => p.replace("/Users/me", "~")),
      missing: [],
      denied: state.denied ?? [],
    },
  })
  const posts: Array<{ path: string; body: any }> = []
  const api = {
    get: vi.fn(async () => list()),
    post: vi.fn(async (path: string, body: any) => {
      posts.push({ path, body })
      const action = path.split("/folders")[1]
      const refusal = opts.refuse?.[action]
      if (refusal) throw new ApiError("refused", 422, refusal)
      if (action === "/lookup") return opts.lookup
      if (action === "/share") state.shared = [...state.shared, "/Users/me/Documents/app"]
      if (action === "/unshare") state.shared = state.shared.filter((p) => p !== body.path)
      if (action === "/search-roots")
        state.search = [...state.search, body.path.replace("~", "/Users/me")]
      if (action === "/search-roots/remove")
        state.search = state.search.filter((p) => p !== body.path)
      return list()
    }),
  }
  return { api, posts }
}

/** The page's view of this computer: only `shell` matters to the tab. */
function computer(shell: Partial<DesktopBridge> | null = null): ThisComputer {
  return { shell } as unknown as ThisComputer
}

function renderTab(
  api: unknown,
  n = node(),
  opts: { initialQuery?: string; isThis?: boolean; shell?: Partial<DesktopBridge> } = {},
) {
  return render(() => (
    <ApiContext.Provider value={api as never}>
      <ComputerFoldersTab
        node={n}
        isThis={opts.isThis === true}
        tc={computer(opts.shell ?? null)}
        initialQuery={opts.initialQuery ?? null}
      />
    </ApiContext.Provider>
  ))
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("the denied banner", () => {
  it("names the place and the OS steps, and Check again sees access given", async () => {
    const state: State = { shared: [], missing: [], search: ["/Users/me"], denied: ["~/Documents"] }
    const { api } = fakeApi(state)
    renderTab(api)
    const banner = await screen.findByTestId("computer-folders-denied")
    expect(banner.getAttribute("role")).toBe("alert")
    expect(banner.textContent).toContain("macOS does not let Liaison read Documents yet")
    expect(banner.textContent).toContain("Privacy & Security › Files and Folders › Liaison")
    // Another computer, or a browser: no System Settings button.
    expect(screen.queryByTestId("computer-folders-open-settings")).toBeNull()
    state.denied = []
    fireEvent.click(screen.getByTestId("computer-folders-check-again"))
    expect((await screen.findByTestId("computer-folders-notice")).textContent).toContain(
      "Mac now lets Liaison read every place it looks in",
    )
    expect(screen.queryByTestId("computer-folders-denied")).toBeNull()
  })

  it("follows the computer's OS", async () => {
    const { api } = fakeApi({
      shared: [],
      missing: [],
      search: ["/Users/me"],
      denied: ["~/Documents"],
    })
    renderTab(api, node({ os: "windows" }))
    expect((await screen.findByTestId("computer-folders-denied")).textContent).toContain(
      "Controlled folder access",
    )
  })

  it("on this computer, Open System Settings asks the shell", async () => {
    const openPrivacySettings = vi.fn(async () => true)
    const { api } = fakeApi({
      shared: [],
      missing: [],
      search: ["/Users/me"],
      denied: ["~/Documents"],
    })
    renderTab(api, node(), { isThis: true, shell: { openPrivacySettings } })
    fireEvent.click(await screen.findByTestId("computer-folders-open-settings"))
    expect(openPrivacySettings).toHaveBeenCalledTimes(1)
  })
})

describe("folders agents can work in", () => {
  it("offline: says so, keeps the last known names, offers no action and asks nothing", () => {
    const { api } = fakeApi({ shared: [], missing: [], search: [] })
    renderTab(api, node({ online: false }))
    const offline = screen.getByTestId("computer-folders-offline")
    expect(offline.textContent).toContain("Mac is offline")
    expect(offline.textContent).toContain("Reports")
    expect(screen.queryByTestId("computer-folders-add")).toBeNull()
    expect(api.get).not.toHaveBeenCalled()
  })

  it("a computer that does not answer: the reason in words and Try again", async () => {
    const api = {
      get: vi.fn(async () => {
        throw new ApiError("x", 504, "timeout")
      }),
      post: vi.fn(),
    }
    renderTab(api)
    const error = await screen.findByTestId("computer-folders-error")
    expect(error.textContent).toContain("Mac did not answer in time")
    expect(error.textContent).not.toContain("timeout")
  })

  it("one list: each folder with its kind, `~/…` path, missing on disk; Remove works on a missing one", async () => {
    const state: State = {
      shared: ["/Users/me/gone", "/Users/me/Documents/app", "/Users/me/Reports"],
      missing: ["/Users/me/gone"],
      search: ["/Users/me"],
      repos: [{ path: "/Users/me/Documents/app", defaultBranch: "main" }],
    }
    const { api, posts } = fakeApi(state)
    renderTab(api)
    const rows = await screen.findAllByTestId("computer-folder")
    expect(rows.map((r) => r.getAttribute("data-missing"))).toEqual(["true", "false", "false"])
    expect(rows[0].textContent).toContain("Missing on disk")
    expect(rows[1].textContent).toContain("Git repository · main")
    expect(rows[1].textContent).toContain("~/Documents/app")
    expect(rows[2].textContent).toContain("Folder")
    // The full path stays in the tooltip.
    expect(rows[2].querySelector("[title]")?.getAttribute("title")).toBe("/Users/me/Reports")
    const remove = screen.getByTestId("computer-folder-remove-gone")
    expect(remove.className).toContain("min-h-[44px]")
    fireEvent.click(remove)
    await waitFor(() => expect(screen.getAllByTestId("computer-folder")).toHaveLength(2))
    expect(posts).toEqual([
      { path: "/nodes/n-1/folders/unshare", body: { path: "/Users/me/gone" } },
    ])
  })

  it("a shared folder names the repositories inside it that the computer shares with it", async () => {
    const { api } = fakeApi({
      shared: ["/Users/me/mono", "/Users/me/Reports"],
      missing: [],
      search: [],
    })
    renderTab(
      api,
      node({
        sharedFolderNames: ["mono", "site", "lab", "Reports"],
        sharedFolderWithin: { site: "mono", lab: "mono" },
      }),
    )
    const rows = await screen.findAllByTestId("computer-folder")
    expect(within(rows[0]).getByTestId("computer-folder-repos").textContent).toBe(
      "Repositories inside, shared with it: lab, site",
    )
    expect(within(rows[1]).queryByTestId("computer-folder-repos")).toBeNull()
  })

  it("a computer that says nothing about repositories shows no kind tag", async () => {
    const { api } = fakeApi({ shared: ["/Users/me/Reports"], missing: [], search: [] })
    renderTab(api)
    await screen.findAllByTestId("computer-folder")
    expect(screen.queryByTestId("computer-folder-kind")).toBeNull()
  })

  it("two folders with one name show their parent folder to tell them apart", async () => {
    const { api } = fakeApi({
      shared: ["/Users/me/a/project", "/Volumes/Data/b/project", "/Users/me/notes"],
      missing: [],
      search: [],
    })
    renderTab(api)
    const rows = await screen.findAllByTestId("computer-folder")
    expect(rows.map((r) => r.querySelector("[title]")?.textContent)).toEqual([
      "a/project",
      "b/project",
      "notes",
    ])
  })

  it("a folder that confines nothing is marked, never offered", async () => {
    const { api } = fakeApi({
      shared: ["/Users/me", "/Users/me/code"],
      missing: [],
      search: [],
      isDefault: true,
      refused: ["/Users/me"],
    })
    renderTab(api)
    const rows = await screen.findAllByTestId("computer-folder")
    expect(rows[0].getAttribute("data-refused")).toBe("true")
    expect(rows[0].textContent).toContain("Never used: the home folder or a folder above it")
    expect(screen.getByTestId("computer-folders-default").textContent).toBe(
      "Your recent folders (default)",
    )
  })
})

describe("on this computer (the shell's own choices)", () => {
  function shellOf(answer: { dropped?: string[]; throws?: string } = {}) {
    const sets: Array<string[] | null> = []
    let picked: string | null = null
    const shell = {
      pickDirectory: vi.fn(async () => picked),
      setSharedRoots: vi.fn(async (roots: string[] | null) => {
        if (answer.throws) throw answer.throws
        sets.push(roots)
        return {
          roots: roots ?? [],
          isDefault: roots === null,
          missing: [],
          dropped: answer.dropped,
        }
      }),
      nodeRoot: vi.fn(async () => ({ path: "/Users/me/Liaison Node", isDefault: true })),
      setNodeRoot: vi.fn(async (path: string | null) => {
        if (path === "/busy") throw "JobRunning"
        return path
          ? { path, isDefault: false }
          : { path: "/Users/me/Liaison Node", isDefault: true }
      }),
    }
    return { shell, sets, pick: (p: string | null) => (picked = p) }
  }

  it("Back to the default sends null through the shell, then reads the list again", async () => {
    const { shell, sets } = shellOf()
    const { api } = fakeApi({ shared: ["/Users/me/code"], missing: [], search: [] })
    renderTab(api, node(), { isThis: true, shell })
    fireEvent.click(await screen.findByTestId("computer-folders-reset"))
    await waitFor(() => expect(sets).toEqual([null]))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
  })

  it("another computer has no Back to the default, no picker, no folder for work without a folder", async () => {
    const { shell } = shellOf()
    const { api } = fakeApi({ shared: ["/Users/me/code"], missing: [], search: [] })
    renderTab(api, node(), { isThis: false, shell })
    await screen.findAllByTestId("computer-folder")
    expect(screen.queryByTestId("computer-folders-reset")).toBeNull()
    expect(screen.queryByTestId("computer-folders-search-root-pick")).toBeNull()
    expect(screen.queryByTestId("computer-node-root")).toBeNull()
    fireEvent.click(screen.getByTestId("computer-folders-add"))
    await screen.findByTestId("add-folder-dialog")
    expect(screen.queryByTestId("add-folder-choose")).toBeNull()
  })

  it("Choose it on this computer adds the picked folder; a dropped root is noted", async () => {
    const { shell, sets, pick } = shellOf({ dropped: ["/Users/me"] })
    const { api } = fakeApi({ shared: ["/Users/me/recent"], missing: [], search: [] })
    renderTab(api, node(), { isThis: true, shell })
    fireEvent.click(await screen.findByTestId("computer-folders-add"))
    pick("/Users/me/code")
    fireEvent.click(await screen.findByTestId("add-folder-choose"))
    await waitFor(() => expect(sets).toEqual([["/Users/me/recent", "/Users/me/code"]]))
    const note = await screen.findByTestId("computer-folders-dropped")
    expect(note.textContent).toContain("never used")
    await waitFor(() => expect(screen.queryByTestId("add-folder-dialog")).toBeNull())
  })

  it("a refused pick says which rule it broke, in words, in the dialog", async () => {
    const { shell, pick } = shellOf({ throws: "SharedRootHome" })
    const { api } = fakeApi({ shared: [], missing: [], search: [] })
    renderTab(api, node(), { isThis: true, shell })
    fireEvent.click(await screen.findByTestId("computer-folders-add"))
    pick("/Users")
    fireEvent.click(await screen.findByTestId("add-folder-choose"))
    const error = await screen.findByTestId("add-folder-error")
    expect(error.textContent).toContain("your home folder or a folder that contains it")
    expect(error.textContent).not.toContain("SharedRoot")
  })

  it("the folder for work that needs no folder uses the picker, and a running session refuses a change", async () => {
    const { shell, pick } = shellOf()
    const { api } = fakeApi({ shared: [], missing: [], search: [] })
    renderTab(api, node(), { isThis: true, shell })
    const current = await screen.findByTestId("computer-node-root-path")
    await waitFor(() => expect(current.textContent).toContain("Liaison Node"))
    expect(current.textContent).toContain("(default)")
    pick("/Volumes/Data/Jobs")
    fireEvent.click(screen.getByTestId("computer-node-root-pick"))
    await waitFor(() => expect(current.textContent).toContain("Jobs"))
    expect(current.textContent).not.toContain("/Volumes/Data/Jobs")
    expect(current.querySelector("[title]")?.getAttribute("title")).toBe("/Volumes/Data/Jobs")
    pick("/busy")
    fireEvent.click(screen.getByTestId("computer-node-root-pick"))
    expect((await screen.findByTestId("computer-node-root-error")).textContent).toContain(
      "session is running",
    )
  })
})

describe("Add a folder", () => {
  const lookup = {
    partial: true,
    searchRoots: 1,
    denied: ["~/Documents"],
    candidates: [
      {
        id: "c-1",
        name: "app",
        display: "~/Code/app",
        isRepo: true,
        shared: false,
        shareable: true,
      },
      {
        id: "c-2",
        name: "app",
        display: "~/old/app",
        isRepo: false,
        shared: true,
        shareable: true,
      },
    ],
  }

  it("opened from a link with a name: searches at once; Add asks first, then adds", async () => {
    const { api, posts } = fakeApi({ shared: [], missing: [], search: ["/Users/me"] }, { lookup })
    renderTab(api, node(), { initialQuery: "app" })
    const candidates = await screen.findAllByTestId("add-folder-candidate")
    expect(candidates[0].textContent).toContain("~/Code/app")
    expect(candidates[0].textContent).toContain("Git repository")
    expect(candidates[1].textContent).toContain("Added")
    expect(screen.getByTestId("add-folder-partial").textContent).toContain("took too long")
    expect(screen.getByTestId("add-folder-denied").textContent).toContain(
      "macOS does not let Liaison read Documents yet",
    )
    expect(screen.getByTestId("add-folder-places").textContent).toContain(
      "Searched your home folder.",
    )
    fireEvent.click(screen.getByTestId("add-folder-add-app"))
    const confirm = await screen.findByTestId("add-folder-confirm")
    expect(confirm.textContent).toContain("Add “app”?")
    expect(confirm.textContent).toContain("read and change the files in ~/Code/app")
    // Nothing is added before the confirmation.
    expect(posts.map((p) => p.path)).toEqual(["/nodes/n-1/folders/lookup"])
    fireEvent.click(screen.getByTestId("add-folder-confirm-add"))
    await waitFor(() =>
      expect(screen.getByTestId("computer-folders-notice").textContent).toContain("“app” is added"),
    )
    expect(posts.at(-1)).toEqual({ path: "/nodes/n-1/folders/share", body: { candidateId: "c-1" } })
    expect(screen.getAllByTestId("computer-folder")).toHaveLength(1)
    await waitFor(() => expect(screen.queryByTestId("add-folder-dialog")).toBeNull())
  })

  it("a refused add stays in the dialog, said in words", async () => {
    const { api } = fakeApi(
      { shared: [], missing: [], search: ["/Users/me"] },
      { lookup, refuse: { "/share": "ShareOutsideSearchRoots" } },
    )
    renderTab(api, node(), { initialQuery: "app" })
    fireEvent.click((await screen.findAllByTestId("add-folder-add-app"))[0])
    fireEvent.click(await screen.findByTestId("add-folder-confirm-add"))
    const error = await screen.findByTestId("add-folder-error")
    expect(error.textContent).toContain("Mac refuses to add “app”")
    expect(screen.getByTestId("add-folder-dialog")).toBeTruthy()
  })

  it("the implicit home default skipped the protected folders: said, and Also look there adds ~ after the confirmation", async () => {
    const { api, posts } = fakeApi(
      { shared: [], missing: [], search: ["/Users/me"] },
      { lookup: { searchRoots: 1, skippedProtected: true, candidates: [] } },
    )
    renderTab(api, node(), { initialQuery: "app" })
    const line = await screen.findByTestId("add-folder-skipped")
    expect(line.textContent).toContain("Documents, Desktop and Downloads were skipped.")
    fireEvent.click(screen.getByTestId("add-folder-look-there"))
    await waitFor(() => expect(screen.queryByTestId("add-folder-dialog")).toBeNull())
    const confirm = await screen.findByTestId("computer-folders-search-root-confirm")
    expect(confirm.textContent).toContain("“~”")
    expect(confirm.textContent).toContain("may ask you to let Liaison read some folders")
    expect(posts.map((p) => p.path)).toEqual(["/nodes/n-1/folders/lookup"])
    fireEvent.click(screen.getByTestId("computer-folders-search-root-confirm-yes"))
    await waitFor(() =>
      expect(posts.at(-1)).toEqual({
        path: "/nodes/n-1/folders/search-roots",
        body: { path: "~" },
      }),
    )
  })

  it("an explicit search says nothing about skipped folders", async () => {
    const { api } = fakeApi(
      { shared: [], missing: [], search: ["/Users/me"] },
      { lookup: { searchRoots: 1, candidates: [] } },
    )
    renderTab(api, node(), { initialQuery: "app" })
    await screen.findByTestId("add-folder-not-found")
    expect(screen.queryByTestId("add-folder-skipped")).toBeNull()
  })

  it("nowhere to look: the empty state says what to add", async () => {
    const { api } = fakeApi(
      { shared: [], missing: [], search: [] },
      { lookup: { searchRoots: 0, candidates: [] } },
    )
    renderTab(api, node(), { initialQuery: "app" })
    expect((await screen.findByTestId("add-folder-no-places")).textContent).toContain(
      "your home folder (~)",
    )
  })

  it("Change where it looks closes the dialog and opens More", async () => {
    const { api } = fakeApi({ shared: [], missing: [], search: ["/Users/me"] })
    renderTab(api)
    fireEvent.click(await screen.findByTestId("computer-folders-add"))
    const more = screen.getByTestId("computer-folders-more") as HTMLDetailsElement
    expect(more.open).toBe(false)
    fireEvent.click(await screen.findByTestId("add-folder-change-where"))
    await waitFor(() => expect(screen.queryByTestId("add-folder-dialog")).toBeNull())
    expect(more.open).toBe(true)
  })

  it("Clone a repository: checked here, confirmed, followed while the computer clones, then added", async () => {
    const shared: string[] = []
    const list = () => ({
      shared: { roots: [...shared], isDefault: false, missing: [] },
      search: { roots: [], display: [], missing: [] },
    })
    let follows = 0
    const posts: Array<{ path: string; body: any }> = []
    const api = {
      get: vi.fn(async (path: string) => {
        if (path.includes("/requests/")) {
          follows++
          if (follows < 2) return { state: "cloning" }
          shared.push("/Users/me/Liaison Node/repos/liaison-monorepo")
          return list()
        }
        return list()
      }),
      post: vi.fn(async (path: string, body: any) => {
        posts.push({ path, body })
        return { state: "cloning", requestId: "r-1" }
      }),
    }
    renderTab(api)
    fireEvent.click(await screen.findByTestId("computer-folders-add"))
    const url = (await screen.findByTestId("add-folder-clone-url")) as HTMLInputElement
    expect(url.className).toContain("min-h-[44px]")
    // A URL no computer clones never leaves the phone.
    fireEvent.input(url, { target: { value: "file:///etc" } })
    fireEvent.click(screen.getByTestId("add-folder-clone-submit"))
    expect((await screen.findByTestId("add-folder-error")).textContent).toContain(
      "https, ssh:// or user@host:path",
    )
    expect(screen.queryByTestId("add-folder-clone-confirm")).toBeNull()
    fireEvent.input(url, { target: { value: "git@github.com:acme/liaison-monorepo.git" } })
    fireEvent.click(screen.getByTestId("add-folder-clone-submit"))
    const confirm = await screen.findByTestId("add-folder-clone-confirm")
    expect(confirm.textContent).toContain("Clone “liaison-monorepo” onto Mac?")
    expect(confirm.textContent).toContain(
      "with its own git login into Liaison Node/repos/liaison-monorepo",
    )
    expect(posts).toEqual([])
    fireEvent.click(screen.getByTestId("add-folder-clone-confirm-yes"))
    expect((await screen.findByTestId("computer-folders-cloning")).textContent).toContain(
      "Cloning “liaison-monorepo” on Mac",
    )
    expect(posts).toEqual([
      {
        path: "/nodes/n-1/folders/clone",
        body: { url: "git@github.com:acme/liaison-monorepo.git" },
      },
    ])
    await waitFor(
      () =>
        expect(screen.getByTestId("computer-folders-notice").textContent).toContain(
          "“liaison-monorepo” is cloned and added",
        ),
      { timeout: 6000 },
    )
    expect(screen.getAllByTestId("computer-folder")).toHaveLength(1)
    expect(screen.queryByTestId("computer-folders-cloning")).toBeNull()
  }, 10_000)

  for (const [code, words] of [
    ["CloneAuthFailed", "Check your git login on Mac"],
    ["CloneTooLarge", "too large"],
  ] as const) {
    it(`a clone refused with ${code} is said in words`, async () => {
      const api = {
        get: vi.fn(async () => ({
          shared: { roots: [], isDefault: false, missing: [] },
          search: { roots: [], display: [], missing: [] },
        })),
        post: vi.fn(async () => {
          throw new ApiError("refused", 422, code)
        }),
      }
      renderTab(api)
      fireEvent.click(await screen.findByTestId("computer-folders-add"))
      const url = (await screen.findByTestId("add-folder-clone-url")) as HTMLInputElement
      fireEvent.input(url, { target: { value: "https://github.com/acme/private.git" } })
      fireEvent.click(screen.getByTestId("add-folder-clone-submit"))
      fireEvent.click(await screen.findByTestId("add-folder-clone-confirm-yes"))
      const error = await screen.findByTestId("computer-folders-action-error")
      expect(error.textContent).toContain(words)
      expect(error.textContent).not.toContain(code)
    })
  }
})

describe("where Add a folder looks (under More)", () => {
  it("the home folder reads as such; add and remove a place; a refusal names the rule", async () => {
    const { api } = fakeApi({ shared: [], missing: [], search: ["/Users/me"] })
    renderTab(api)
    const roots = await screen.findAllByTestId("computer-folders-search-root")
    expect(roots[0].textContent).toContain("~ (your home folder)")
    const input = screen.getByTestId("computer-folders-search-root-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "~/Documents" } })
    fireEvent.click(screen.getByTestId("computer-folders-search-root-add"))
    // The owner confirms first: nothing is sent before.
    const confirm = await screen.findByTestId("computer-folders-search-root-confirm")
    expect(confirm.textContent).toContain("Let Add a folder look in “~/Documents” on Mac?")
    expect(confirm.textContent).toContain("never adds anything")
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("computer-folders-search-root-confirm-yes"))
    await waitFor(() =>
      expect(screen.getAllByTestId("computer-folders-search-root")).toHaveLength(2),
    )
    fireEvent.click(screen.getAllByTestId("computer-folders-search-root-remove")[1])
    await waitFor(() =>
      expect(screen.getAllByTestId("computer-folders-search-root")).toHaveLength(1),
    )

    document.body.innerHTML = ""
    const refusing = fakeApi(
      { shared: [], missing: [], search: [] },
      { refuse: { "/search-roots": "SearchRootAboveHome" } },
    )
    renderTab(refusing.api)
    expect((await screen.findByTestId("computer-folders-search-empty")).textContent).toContain(
      "Add your home folder",
    )
    const again = screen.getByTestId("computer-folders-search-root-input") as HTMLInputElement
    fireEvent.input(again, { target: { value: "/" } })
    fireEvent.click(screen.getByTestId("computer-folders-search-root-add"))
    fireEvent.click(await screen.findByTestId("computer-folders-search-root-confirm-yes"))
    const error = await screen.findByTestId("computer-folders-action-error")
    expect(error.textContent).toContain("above your home folder")
    expect(error.textContent).not.toContain("SearchRoot")
  })
})

describe("repository discovery (S1-S7)", () => {
  it("S2: Share selected in the scan adds the folders to the list above, with a notice", async () => {
    const state: State = { shared: [], missing: [], search: ["/Users/me"] }
    const { api, posts } = fakeApi(state)
    const base = api.post.getMockImplementation() as (p: string, b: any) => Promise<unknown>
    api.post.mockImplementation(async (path: string, body: any) => {
      if (path.endsWith("/scan")) {
        posts.push({ path, body })
        return {
          searchRoots: 1,
          candidates: [
            {
              candidateId: "c-a",
              name: "app",
              display: "~/Documents/app",
              shared: false,
              shareable: true,
              refusal: null,
            },
          ],
        }
      }
      if (path.endsWith("/share-many")) {
        posts.push({ path, body })
        state.shared = ["/Users/me/Documents/app"]
        return { ...((await base("/folders", {})) as object), refused: [] }
      }
      return base(path, body)
    })
    renderTab(api)
    fireEvent.click(await screen.findByTestId("repo-scan-run"))
    fireEvent.click(await screen.findByTestId("repo-scan-check"))
    fireEvent.click(screen.getByTestId("repo-scan-share"))
    await waitFor(() => expect(screen.getAllByTestId("computer-folder")).toHaveLength(1))
    expect(screen.getByTestId("computer-folders-notice").textContent).toContain("“app” is added")
    expect(posts.filter((p) => p.path.endsWith("/share-many"))).toHaveLength(1)
  })

  it("S6: Clone and share from the remote list clones through the tab and says it is added", async () => {
    const state: State = { shared: [], missing: [], search: ["/Users/me"] }
    const { api, posts } = fakeApi(state)
    const base = api.post.getMockImplementation() as (p: string, b: any) => Promise<unknown>
    api.post.mockImplementation(async (path: string, body: any) => {
      if (path.endsWith("/remotes")) {
        const here = state.shared.length > 0
        return {
          repos: [
            {
              source: "github",
              fullName: "me/away",
              host: "github.com",
              cloneUrl: "https://github.com/me/away.git",
              private: false,
              pushedAt: null,
              local: here
                ? { display: "~/Liaison Node/repos/away", shared: true, candidateId: null }
                : null,
            },
          ],
          sources: [{ tool: "gh", state: "ok" }],
          dropped: 0,
        }
      }
      if (path.endsWith("/clone")) state.shared = ["/Users/me/Liaison Node/repos/away"]
      return base(path, body)
    })
    renderTab(api)
    fireEvent.click(await screen.findByTestId("remote-repos-run"))
    fireEvent.click(await screen.findByTestId("remote-repos-clone"))
    await waitFor(() =>
      expect(screen.getByTestId("computer-folders-notice").textContent).toContain(
        "“away” is cloned and added",
      ),
    )
    expect(posts.find((p) => p.path.endsWith("/clone"))?.body).toEqual({
      url: "https://github.com/me/away.git",
    })
    // The remote list asks again: the row is now Shared.
    await waitFor(() => expect(screen.getByTestId("remote-repos-row").dataset.state).toBe("shared"))
  })

  it("S6: a Clone and share the computer refuses says why on the row, with Clone again", async () => {
    const state: State = { shared: [], missing: [], search: ["/Users/me"] }
    const { api } = fakeApi(state)
    const base = api.post.getMockImplementation() as (p: string, b: any) => Promise<unknown>
    api.post.mockImplementation(async (path: string, body: any) => {
      if (path.endsWith("/remotes")) {
        return {
          repos: [
            {
              source: "github",
              fullName: "me/private",
              host: "github.com",
              cloneUrl: "https://github.com/me/private.git",
              private: true,
              pushedAt: null,
              local: null,
            },
          ],
          sources: [{ tool: "gh", state: "ok" }],
          dropped: 0,
        }
      }
      if (path.endsWith("/clone")) throw new ApiError("refused", 422, "CloneAuthFailed")
      return base(path, body)
    })
    renderTab(api)
    fireEvent.click(await screen.findByTestId("remote-repos-run"))
    fireEvent.click(await screen.findByTestId("remote-repos-clone"))
    await waitFor(() =>
      expect(screen.getByTestId("remote-repos-row-error").textContent).toContain(
        "Check your git login on Mac",
      ),
    )
    expect(screen.getByTestId("remote-repos-row").dataset.state).toBe("remote")
    expect(screen.getByTestId("remote-repos-clone")).toBeTruthy()
  })
})

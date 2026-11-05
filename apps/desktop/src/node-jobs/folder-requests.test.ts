// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The node answers folder requests from any client: it pulls the request,
// runs it on the shell's folder settings, and puts the answer back; a share
// or unshare publishes the capabilities again; a refusal travels as its code.
import { describe, expect, it, vi } from "vitest"
import { createFolderRequests } from "./folder-requests"

const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"

function fakeShell(initial: { shared: string[]; search: string[] }) {
  const state = { ...initial }
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "node_shared_roots":
        return { roots: state.shared, isDefault: false, missing: [] }
      case "node_search_roots":
        return { roots: state.search, display: state.search, missing: [] }
      case "set_node_shared_roots": {
        const roots = args?.roots as string[]
        if (roots.includes("/Users/me")) throw "SharedRootHome"
        state.shared = roots
        return {}
      }
      case "set_node_search_roots":
        state.search = args?.roots as string[]
        return {}
      case "node_folder_unshare": {
        const before = state.shared.length
        state.shared = state.shared.filter((r) => r !== args?.path)
        return state.shared.length !== before
      }
      case "node_search_root_add":
        state.search = [...state.search, String(args?.path)]
        return {}
      case "node_search_root_remove":
        state.search = state.search.filter((r) => r !== args?.path)
        return {}
      case "node_folder_share": {
        if (args?.token === "f".repeat(32)) throw "ShareNotIssued"
        state.shared = [...state.shared, "/Users/me/b"]
        return {}
      }
      case "node_folder_clone":
        if (String(args?.url).includes("private")) throw "CloneAuthFailed"
        state.shared = [...state.shared, `/Users/me/Liaison Node/repos/${args?.name ?? "app"}`]
        return {}
      case "node_folder_scan":
        return { searchRoots: 1, candidates: [{ name: "r", path: "/Users/me/r", token: null }] }
      case "node_folder_share_many": {
        const tokens = args?.tokens as string[]
        if (tokens.includes("e".repeat(32))) throw "SharedRootsFull"
        const refused = tokens
          .filter((t) => t === "f".repeat(32))
          .map((token) => ({ token, code: "ShareNotIssued" }))
        const accepted = tokens.length - refused.length
        state.shared = [
          ...state.shared,
          ...tokens.slice(0, accepted).map((_, i) => `/Users/me/s${i}`),
        ]
        return { roots: state.shared, isDefault: false, missing: [], refused }
      }
      case "node_folder_remotes":
        return { repos: [], sources: [{ tool: "gh", state: "signed_out" }], dropped: 0 }
      case "node_folder_lookup":
        return { searchRoots: 1, candidates: [{ name: "x", path: "/Users/me/x" }] }
      default:
        throw new Error(`unexpected ${command}`)
    }
  })
  return { state, invoke }
}

function harness(op: unknown, shell = fakeShell({ shared: ["/Users/me/a"], search: [] })) {
  const put = vi.fn(async (_id: string, _claim: string, _result: unknown) => {})
  const republish = vi.fn(async () => {})
  const handle = createFolderRequests({
    http: { get: async () => (op === null ? null : { op, claim: "c-1" }), put },
    invoke: shell.invoke,
    republish,
  })
  return { handle, put, republish, shell }
}

describe("node folder requests", () => {
  it("share hands the node its own proof, republishes, and answers the new list", async () => {
    const h = harness({ kind: "share", token: "a".repeat(32) })
    await h.handle(ID)
    expect(h.shell.invoke).toHaveBeenCalledWith("node_folder_share", { token: "a".repeat(32) })
    expect(h.shell.state.shared).toEqual(["/Users/me/a", "/Users/me/b"])
    expect(h.republish).toHaveBeenCalledTimes(1)
    expect(h.put).toHaveBeenCalledWith(ID, "c-1", {
      ok: true,
      data: {
        shared: { roots: ["/Users/me/a", "/Users/me/b"], isDefault: false, missing: [] },
        search: { roots: [], display: [], missing: [] },
      },
    })
  })

  it("unshare removes it; an unknown path changes nothing and publishes nothing", async () => {
    const h = harness({ kind: "unshare", path: "/Users/me/a" })
    await h.handle(ID)
    expect(h.shell.state.shared).toEqual([])
    expect(h.republish).toHaveBeenCalledTimes(1)
    const none = harness({ kind: "unshare", path: "/elsewhere" })
    await none.handle(ID)
    expect(none.republish).not.toHaveBeenCalled()
  })

  it("a refusal from the shell travels as its code", async () => {
    const h = harness({ kind: "share", token: "f".repeat(32) })
    await h.handle(ID)
    expect(h.put).toHaveBeenCalledWith(ID, "c-1", { ok: false, code: "ShareNotIssued" })
    expect(h.republish).not.toHaveBeenCalled()
  })

  it("search roots are added and removed, lookups answered", async () => {
    const h = harness({ kind: "addSearchRoot", path: "~" })
    await h.handle(ID)
    expect(h.shell.state.search).toEqual(["~"])
    const lookup = harness({ kind: "lookup", query: "x" })
    await lookup.handle(ID)
    expect(lookup.shell.invoke).toHaveBeenCalledWith("node_folder_lookup", { query: "x" })
    expect(lookup.put.mock.calls[0]?.[2]).toMatchObject({ ok: true })
  })

  it("a malformed request is refused; a gone one, or a bad id, is not answered", async () => {
    const bad = harness({ kind: "lookup", query: "../x" })
    await bad.handle(ID)
    expect(bad.put).toHaveBeenCalledWith(ID, "c-1", { ok: false, code: "failed" })
    const gone = harness(null)
    await gone.handle(ID)
    expect(gone.put).not.toHaveBeenCalled()
    const id = harness({ kind: "list" })
    await id.handle("not-a-uuid")
    expect(id.put).not.toHaveBeenCalled()
  })

  it("clone runs the node's own clone, publishes, answers the list; a refusal is its code", async () => {
    const h = harness({ kind: "clone", url: "git@github.com:acme/app.git" })
    await h.handle(ID)
    expect(h.shell.invoke).toHaveBeenCalledWith("node_folder_clone", {
      url: "git@github.com:acme/app.git",
      name: null,
    })
    expect(h.republish).toHaveBeenCalledTimes(1)
    expect((h.put.mock.calls[0]?.[2] as any)?.data?.shared?.roots).toContain(
      "/Users/me/Liaison Node/repos/app",
    )
    const refused = harness({ kind: "clone", url: "https://example.com/acme/private.git" })
    await refused.handle(ID)
    expect(refused.put).toHaveBeenCalledWith(ID, "c-1", { ok: false, code: "CloneAuthFailed" })
    expect(refused.republish).not.toHaveBeenCalled()
  })

  it("a clone URL no node clones never reaches the shell", async () => {
    for (const url of ["file:///etc", "-uhttps://x/y", "ext::sh -c x", "/Users/me/repo"]) {
      const h = harness({ kind: "clone", url })
      await h.handle(ID)
      expect(h.put).toHaveBeenCalledWith(ID, "c-1", { ok: false, code: "failed" })
      expect(h.shell.invoke).not.toHaveBeenCalledWith("node_folder_clone", expect.anything())
    }
  })

  it("scan and remotes run the node's own commands with nothing from the request", async () => {
    const scan = harness({ kind: "scan", path: "/etc" })
    await scan.handle(ID)
    expect(scan.shell.invoke).toHaveBeenCalledWith("node_folder_scan")
    expect(scan.put.mock.calls[0]?.[2]).toMatchObject({
      ok: true,
      data: { searchRoots: 1, candidates: [{ name: "r", token: null }] },
    })
    expect(scan.republish).not.toHaveBeenCalled()
    const remotes = harness({ kind: "remotes", url: "https://x/y" })
    await remotes.handle(ID)
    expect(remotes.shell.invoke).toHaveBeenCalledWith("node_folder_remotes")
    expect(remotes.shell.invoke).toHaveBeenCalledTimes(1)
    expect(remotes.put).toHaveBeenCalledWith(ID, "c-1", {
      ok: true,
      data: { repos: [], sources: [{ tool: "gh", state: "signed_out" }], dropped: 0 },
    })
  })

  it("shareMany shares in one node call, republishes once, answers the list and the refused", async () => {
    const a = "a".repeat(32)
    const b = "b".repeat(32)
    const used = "f".repeat(32)
    const h = harness({ kind: "shareMany", tokens: [a, b, used, a] })
    await h.handle(ID)
    // Deduped before it reaches the node.
    expect(h.shell.invoke).toHaveBeenCalledWith("node_folder_share_many", { tokens: [a, b, used] })
    expect(h.shell.invoke.mock.calls.filter(([c]) => c === "node_folder_share_many")).toHaveLength(
      1,
    )
    expect(h.republish).toHaveBeenCalledTimes(1)
    expect(h.put).toHaveBeenCalledWith(ID, "c-1", {
      ok: true,
      data: {
        shared: {
          roots: ["/Users/me/a", "/Users/me/s0", "/Users/me/s1"],
          isDefault: false,
          missing: [],
        },
        search: { roots: [], display: [], missing: [] },
        refused: [{ token: used, code: "ShareNotIssued" }],
      },
    })
  })

  it("shareMany with every token refused publishes nothing; a whole refusal is its code", async () => {
    const none = harness({ kind: "shareMany", tokens: ["f".repeat(32)] })
    await none.handle(ID)
    expect(none.republish).not.toHaveBeenCalled()
    expect((none.put.mock.calls[0]?.[2] as any)?.data?.refused).toHaveLength(1)
    const full = harness({ kind: "shareMany", tokens: ["e".repeat(32)] })
    await full.handle(ID)
    expect(full.put).toHaveBeenCalledWith(ID, "c-1", { ok: false, code: "SharedRootsFull" })
    expect(full.republish).not.toHaveBeenCalled()
    // Not a token list the node issued: never reaches the shell.
    for (const tokens of [
      [],
      ["xyz"],
      Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(32, "0")),
    ]) {
      const bad = harness({ kind: "shareMany", tokens })
      await bad.handle(ID)
      expect(bad.put).toHaveBeenCalledWith(ID, "c-1", { ok: false, code: "failed" })
      expect(bad.shell.invoke).not.toHaveBeenCalled()
    }
  })

  it("a request another connection of this node claimed is left alone", async () => {
    const h = harness(null)
    await h.handle(ID)
    expect(h.shell.invoke).not.toHaveBeenCalled()
    expect(h.put).not.toHaveBeenCalled()
  })

  it("unshare and search roots go through the node's own locked commands", async () => {
    const h = harness({ kind: "unshare", path: "/Users/me/a" })
    await h.handle(ID)
    expect(h.shell.invoke).toHaveBeenCalledWith("node_folder_unshare", { path: "/Users/me/a" })
    expect(h.shell.invoke).not.toHaveBeenCalledWith("set_node_shared_roots", expect.anything())
    const add = harness({ kind: "addSearchRoot", path: "~" })
    await add.handle(ID)
    expect(add.shell.invoke).toHaveBeenCalledWith("node_search_root_add", { path: "~" })
    expect(add.shell.invoke).not.toHaveBeenCalledWith("set_node_search_roots", expect.anything())
  })
})

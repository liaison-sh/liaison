// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The clone URL a node accepts, checked the same way on the phone, the server
// and the node (node_folders.rs clone_url_ok): https, ssh:// or
// user@host:path only; never a local path, file://, a transport helper, an
// option, embedded credentials, or a loopback, link-local or private address.
import { describe, expect, it } from "bun:test"
import {
  nodeCloneDefaultName,
  nodeCloneUrlOk,
  parseNodeFolderList,
  parseNodeFolderLookup,
} from "./node-folders"

describe("nodeCloneUrlOk", () => {
  it("accepts the forms a node clones", () => {
    for (const url of [
      "https://github.com/acme/app.git",
      "https://gitlab.example.com:8443/group/sub/app",
      "ssh://git@github.com/acme/app.git",
      "git@github.com:acme/app.git",
      "https://8.8.8.8/acme/app.git",
      "https://172.32.0.1/acme/app.git",
      "https://token@github.com/acme/app.git",
    ]) {
      expect(nodeCloneUrlOk(url)).toBe(true)
    }
  })

  it("refuses local, option-like and transport-helper URLs", () => {
    for (const url of [
      "file:///etc",
      "/Users/me/repo",
      "-uhttps://x/y",
      "ext::sh -c x",
      "http://x/a/b",
    ]) {
      expect(nodeCloneUrlOk(url)).toBe(false)
    }
  })

  it("refuses embedded credentials and a user that reads as an option", () => {
    for (const url of [
      "https://user:secret@github.com/acme/app.git",
      "ssh://git:pw@github.com/acme/app.git",
      "https://-oProxyCommand@github.com/acme/app.git",
      "ssh://-oProxyCommand=x@github.com/acme/app.git",
      "-u@github.com:acme/app.git",
    ]) {
      expect(nodeCloneUrlOk(url)).toBe(false)
    }
  })

  it("refuses loopback, link-local and private addresses", () => {
    for (const url of [
      "https://localhost/acme/app.git",
      "https://127.0.0.1/acme/app.git",
      "https://[::1]/acme/app.git",
      "https://0.0.0.0/acme/app.git",
      "https://10.0.0.5/acme/app.git",
      "https://172.16.0.1/acme/app.git",
      "https://192.168.1.2/acme/app.git",
      "https://169.254.169.254/acme/app.git",
      "https://[fe80::1]/acme/app.git",
      "https://[fd00::1]/acme/app.git",
      "https://2130706433/acme/app.git",
      "https://0x7f000001/acme/app.git",
      "git@10.1.2.3:acme/app.git",
      "ssh://git@192.168.0.4/acme/app.git",
    ]) {
      expect(nodeCloneUrlOk(url)).toBe(false)
    }
  })
})

describe("parseNodeFolderList", () => {
  it("keeps which shared roots are repositories, with their default branch", () => {
    const list = parseNodeFolderList({
      shared: {
        roots: ["/u/app", "/u/notes"],
        isDefault: false,
        missing: [],
        repos: [
          { path: "/u/app", defaultBranch: "main" },
          { path: "/u/elsewhere", defaultBranch: "dev" },
          { path: 3 },
        ],
      },
      search: { roots: [], display: [], missing: [], denied: [] },
    })
    expect(list.shared.repos).toEqual([{ path: "/u/app", defaultBranch: "main" }])
  })

  it("a node that says nothing about repositories leaves repos unset", () => {
    const list = parseNodeFolderList({ shared: { roots: ["/u/app"] }, search: {} })
    expect(list.shared.repos).toBeUndefined()
  })
})

describe("parseNodeFolderLookup", () => {
  it("keeps that the implicit home default skipped the protected folders", () => {
    expect(
      parseNodeFolderLookup({ searchRoots: 1, candidates: [], skippedProtected: true }),
    ).toEqual({
      searchRoots: 1,
      candidates: [],
      skippedProtected: true,
    })
    expect(
      parseNodeFolderLookup({ searchRoots: 1, candidates: [] }).skippedProtected,
    ).toBeUndefined()
  })
})

describe("scan, shareMany and remotes (session import overhaul)", () => {
  const { parseNodeFolderOp, parseNodeFolderScan, parseNodeRemotes, parseNodeFolderShareMany } =
    require("./node-folders") as typeof import("./node-folders")
  const tok = (n: number) => n.toString(16).padStart(32, "0")

  it("parses the three new ops and refuses bad token lists", () => {
    expect(parseNodeFolderOp({ kind: "scan", path: "/etc" })).toEqual({ kind: "scan" })
    expect(parseNodeFolderOp({ kind: "remotes", url: "x" })).toEqual({ kind: "remotes" })
    expect(parseNodeFolderOp({ kind: "shareMany", tokens: [tok(1), tok(1), tok(2)] })).toEqual({
      kind: "shareMany",
      tokens: [tok(1), tok(2)],
    })
    expect(parseNodeFolderOp({ kind: "shareMany", tokens: [] })).toBeNull()
    expect(
      parseNodeFolderOp({
        kind: "shareMany",
        tokens: Array.from({ length: 101 }, (_, i) => tok(i)),
      }),
    ).toBeNull()
    expect(parseNodeFolderOp({ kind: "shareMany", tokens: ["/Users/x/.ssh"] })).toBeNull()
    expect(parseNodeFolderOp({ kind: "shareMany", tokens: ["A".repeat(32)] })).toBeNull()
  })

  it("a scan row has a token only when it can be shared, else a refusal", () => {
    const scan = parseNodeFolderScan({
      searchRoots: 1,
      partial: true,
      candidates: [
        { name: "app", path: "/h/code/app", display: "~/code/app", token: tok(3), shared: false },
        { name: "lib", path: "/h/code/lib", display: "~/code/lib", token: tok(4), shared: true },
        { name: "tmp", path: "/tmp/x", display: "x", token: null, refusal: "outside_search" },
        { name: "odd", path: "/h/odd", token: "not-a-token" },
      ],
    })
    expect(scan.partial).toBe(true)
    expect(scan.candidates.map((c) => [c.name, c.token, c.shareable, c.refusal])).toEqual([
      ["app", tok(3), true, null],
      ["lib", null, false, null],
      ["tmp", null, false, "outside_search"],
      ["odd", null, false, "outside_search"],
    ])
  })

  it("remotes drop a clone URL the node would refuse and keep the sources", () => {
    const r = parseNodeRemotes({
      dropped: 1,
      sources: [
        { tool: "gh", state: "ok" },
        { tool: "glab", state: "signed_out" },
        { tool: "curl", state: "ok" },
      ],
      repos: [
        {
          source: "github",
          fullName: "acme/app",
          host: "github.com",
          cloneUrl: "git@github.com:acme/app.git",
          private: true,
          pushedAt: 5,
          local: { display: "~/code/app", shared: false, token: tok(9) },
        },
        {
          source: "github",
          fullName: "acme/evil",
          host: "github.com",
          cloneUrl: "file:///etc",
          private: false,
        },
        { source: "gitlab", fullName: "g/sub/x", host: "gitlab.com", cloneUrl: "ext::sh -c id" },
        {
          source: "gitlab",
          fullName: "g/y",
          host: "gitlab.com",
          cloneUrl: "https://gitlab.com/g/y.git",
          local: { display: "~/y", shared: true, token: tok(1) },
        },
      ],
    })
    expect(r.dropped).toBe(3)
    expect(r.sources).toEqual([
      { tool: "gh", state: "ok" },
      { tool: "glab", state: "signed_out" },
    ])
    expect(r.repos.map((x) => [x.fullName, x.local?.token ?? null])).toEqual([
      ["acme/app", tok(9)],
      ["g/y", null],
    ])
  })

  it("shareMany keeps the refused tokens with known codes", () => {
    const a = parseNodeFolderShareMany({
      shared: { roots: ["/a"] },
      search: { roots: [] },
      refused: [
        { token: tok(1), code: "ShareNotIssued" },
        { token: tok(2), code: "weird" },
      ],
    })
    expect(a.shared.roots).toEqual(["/a"])
    expect(a.refused).toEqual([
      { token: tok(1), code: "ShareNotIssued" },
      { token: tok(2), code: "failed" },
    ])
  })
})

describe("nodeCloneDefaultName", () => {
  it("is the URL's last segment without trailing slashes or .git", () => {
    expect(nodeCloneDefaultName(" https://github.com/o/liaison.git// ")).toBe("liaison")
    expect(nodeCloneDefaultName("git@github.com:o/repo")).toBe("repo")
  })

  it("stays linear on a run of slashes", () => {
    const started = performance.now()
    expect(nodeCloneDefaultName(`https://h/o/r${"/".repeat(100_000)}x`)).toBe("x")
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

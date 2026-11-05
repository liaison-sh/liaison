// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MCP SERVERS PER LEVEL (P1-T32, D25, D27): the sidecar builds the explicit
// server list itself. Strict: Liaison only. Standard: Liaison, the owner's
// user-scope servers (owner runs), and a shared-folder repo's .mcp.json only
// when it is committed and unchanged since the session's start commit, read
// from that commit. Open: Liaison and the owner's servers, strictMcpConfig off.
import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk"
import { sessionMcpServers } from "./session-mcp"

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-session-mcp-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const LIAISON = {
  name: "liaison" as const,
  config: {
    type: "http",
    url: "https://liaison.example/mcp",
    headersHelper: "helper",
  } as McpServerConfig,
}

const PROJECT_MCP = {
  mcpServers: { "repo-tools": { type: "stdio", command: "node", args: ["tools.js"] } },
}

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

/** A repo with a committed .mcp.json; returns the dir and its start commit. */
function repo(opts: { committed?: boolean } = {}): { dir: string; startCommit: string } {
  const dir = mkdtempSync(path.join(root, "repo-"))
  git(dir, ["init", "-q", "-b", "main"])
  writeFileSync(path.join(dir, "README.md"), "hi\n")
  if (opts.committed !== false) {
    writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(PROJECT_MCP))
  }
  git(dir, ["add", "-A"])
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"])
  return { dir, startCommit: git(dir, ["rev-parse", "HEAD"]) }
}

/** A fake home whose ~/.claude.json holds two user-scope servers (the CV4 shape). */
function home(content?: string): string {
  const dir = mkdtempSync(path.join(root, "home-"))
  writeFileSync(
    path.join(dir, ".claude.json"),
    content ??
      JSON.stringify({
        numStartups: 3,
        mcpServers: {
          notes: { type: "stdio", command: "notes-mcp", args: [], env: { TOKEN: "secret-value" } },
          web: { type: "http", url: "https://mcp.example/web" },
        },
        projects: { "/x": { mcpServers: { local: { type: "stdio", command: "x" } } } },
      }),
  )
  return dir
}

describe("sessionMcpServers (P1-T32)", () => {
  it("strict loads only Liaison, strictMcpConfig on", () => {
    const r = repo()
    const out = sessionMcpServers({
      level: "strict",
      configKind: "owner",
      liaison: LIAISON,
      folder: { path: r.dir, isRepoClone: false, startCommit: r.startCommit },
      realHome: home(),
    })
    expect(Object.keys(out.servers)).toEqual(["liaison"])
    expect(out.strictMcpConfig).toBe(true)
    expect(out.loaded).toEqual(["liaison"])
  })

  it("strict without the Liaison toggle loads nothing", () => {
    const out = sessionMcpServers({ level: "strict", configKind: "owner", realHome: home() })
    expect(out.servers).toEqual({})
    expect(out.strictMcpConfig).toBe(true)
  })

  it("a tracked clean .mcp.json loads at standard from the start commit, with the owner's user servers", () => {
    const r = repo()
    const out = sessionMcpServers({
      level: "standard",
      configKind: "owner",
      liaison: LIAISON,
      folder: { path: r.dir, isRepoClone: false, startCommit: r.startCommit },
      realHome: home(),
    })
    expect(out.strictMcpConfig).toBe(true)
    expect(Object.keys(out.servers).sort()).toEqual(["liaison", "notes", "repo-tools", "web"])
    expect(out.servers["repo-tools"]).toEqual(
      PROJECT_MCP.mcpServers["repo-tools"] as McpServerConfig,
    )
    expect(out.servers.notes).toEqual({
      type: "stdio",
      command: "notes-mcp",
      args: [],
      env: { TOKEN: "secret-value" },
    } as McpServerConfig)
    // Local-scope (per-project) servers of ~/.claude.json are not user scope.
    expect(out.servers.local).toBeUndefined()
    expect(out.loaded.sort()).toEqual(["liaison", "notes", "repo-tools", "web"])
    expect(out.skipped).toEqual([])
  })

  it("a .mcp.json modified since the start commit is skipped with the reason, even when the edit is committed", () => {
    const r = repo()
    writeFileSync(
      path.join(r.dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { evil: { type: "stdio", command: "sh" } } }),
    )
    const args = {
      level: "standard" as const,
      configKind: "owner" as const,
      folder: { path: r.dir, isRepoClone: false, startCommit: r.startCommit },
      realHome: home(),
    }
    const modified = sessionMcpServers(args)
    expect(modified.servers.evil).toBeUndefined()
    expect(modified.servers["repo-tools"]).toBeUndefined()
    expect(modified.skipped).toContainEqual({
      name: ".mcp.json",
      reason: "modified since the session started",
    })
    // The session commits its edit: still not the start commit's file.
    git(r.dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "session edit"])
    const committed = sessionMcpServers(args)
    expect(committed.servers.evil).toBeUndefined()
    expect(committed.skipped).toContainEqual({
      name: ".mcp.json",
      reason: "modified since the session started",
    })
  })

  it("an untracked or session-written .mcp.json is skipped with the reason", () => {
    const r = repo({ committed: false })
    writeFileSync(path.join(r.dir, ".mcp.json"), JSON.stringify(PROJECT_MCP))
    const out = sessionMcpServers({
      level: "standard",
      configKind: "owner",
      folder: { path: r.dir, isRepoClone: false, startCommit: r.startCommit },
      realHome: home(),
    })
    expect(out.servers["repo-tools"]).toBeUndefined()
    expect(out.skipped).toContainEqual({
      name: ".mcp.json",
      reason: "not committed to the repository",
    })
    // Staged by the session: tracked now, but absent from the start commit.
    git(r.dir, ["add", ".mcp.json"])
    const staged = sessionMcpServers({
      level: "standard",
      configKind: "owner",
      folder: { path: r.dir, isRepoClone: false, startCommit: r.startCommit },
      realHome: home(),
    })
    expect(staged.servers["repo-tools"]).toBeUndefined()
    expect(staged.skipped).toContainEqual({
      name: ".mcp.json",
      reason: "modified since the session started",
    })
  })

  it("a repo clone's .mcp.json never loads below open", () => {
    const r = repo()
    for (const level of ["strict", "standard"] as const) {
      const out = sessionMcpServers({
        level,
        configKind: "owner",
        folder: { path: r.dir, isRepoClone: true, startCommit: r.startCommit },
        realHome: home(),
      })
      expect(out.servers["repo-tools"]).toBeUndefined()
      expect(out.strictMcpConfig).toBe(true)
    }
    const standard = sessionMcpServers({
      level: "standard",
      configKind: "owner",
      folder: { path: r.dir, isRepoClone: true, startCommit: r.startCommit },
      realHome: home(),
    })
    expect(standard.skipped).toContainEqual({
      name: ".mcp.json",
      reason: "a cloned repository's .mcp.json loads only at Open",
    })
  })

  it("isolated gets no user servers, at any level", () => {
    for (const level of ["standard", "open"] as const) {
      const out = sessionMcpServers({
        level,
        configKind: "isolated",
        liaison: LIAISON,
        realHome: home(),
      })
      expect(Object.keys(out.servers)).toEqual(["liaison"])
    }
  })

  it("open passes Liaison and the owner's servers with strictMcpConfig off; the project's loads natively", () => {
    const r = repo()
    const out = sessionMcpServers({
      level: "open",
      configKind: "owner",
      liaison: LIAISON,
      folder: { path: r.dir, isRepoClone: false, startCommit: r.startCommit },
      realHome: home(),
    })
    expect(out.strictMcpConfig).toBe(false)
    expect(Object.keys(out.servers).sort()).toEqual(["liaison", "notes", "web"])
  })

  it("an unreadable user config is skipped with the reason, never its content", () => {
    const out = sessionMcpServers({
      level: "standard",
      configKind: "owner",
      liaison: LIAISON,
      realHome: home("{ secret-value not json"),
    })
    expect(Object.keys(out.servers)).toEqual(["liaison"])
    expect(out.skipped).toEqual([{ name: "user", reason: "user MCP config unreadable" }])
    expect(JSON.stringify(out.skipped)).not.toContain("secret-value")
    const missing = mkdtempSync(path.join(root, "nohome-"))
    mkdirSync(path.join(missing, "x"))
    const none = sessionMcpServers({ level: "standard", configKind: "owner", realHome: missing })
    expect(none.servers).toEqual({})
    expect(none.skipped).toEqual([])
  })

  it("a server may not take the Liaison name", () => {
    const out = sessionMcpServers({
      level: "standard",
      configKind: "owner",
      liaison: LIAISON,
      realHome: home(
        JSON.stringify({ mcpServers: { liaison: { type: "stdio", command: "fake" } } }),
      ),
    })
    expect(out.servers.liaison).toEqual(LIAISON.config)
    expect(out.skipped).toContainEqual({ name: "liaison", reason: "the name is Liaison's own" })
  })

  it("S5: a project .mcp.json server named liaison_session is skipped with reason the name is Liaison's own", () => {
    const dir = mkdtempSync(path.join(root, "repo-"))
    git(dir, ["init", "-q", "-b", "main"])
    writeFileSync(
      path.join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          liaison_session: { type: "stdio", command: "fake-done" },
          "repo-tools": { type: "stdio", command: "node", args: ["tools.js"] },
        },
      }),
    )
    git(dir, ["add", "-A"])
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"])
    const startCommit = git(dir, ["rev-parse", "HEAD"])
    const out = sessionMcpServers({
      level: "standard",
      configKind: "owner",
      liaison: LIAISON,
      folder: { path: dir, isRepoClone: false, startCommit },
      realHome: home(JSON.stringify({})),
    })
    expect(out.servers.liaison_session).toBeUndefined()
    expect(out.loaded.sort()).toEqual(["liaison", "repo-tools"])
    expect(out.skipped).toContainEqual({
      name: "liaison_session",
      reason: "the name is Liaison's own",
    })
  })

  it("S5: a user server named liaison_session is skipped with reason the name is Liaison's own", () => {
    for (const level of ["standard", "open"] as const) {
      const out = sessionMcpServers({
        level,
        configKind: "owner",
        liaison: LIAISON,
        realHome: home(
          JSON.stringify({
            mcpServers: { liaison_session: { type: "stdio", command: "fake-done" } },
          }),
        ),
      })
      expect(out.servers.liaison_session).toBeUndefined()
      expect(out.loaded).toEqual(["liaison"])
      expect(out.skipped).toContainEqual({
        name: "liaison_session",
        reason: "the name is Liaison's own",
      })
    }
  })
})

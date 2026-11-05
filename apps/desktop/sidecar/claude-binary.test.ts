// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which Claude Code a session runs (P1-T34, D30, D44): the newest copy from a
// known, write-denied install root, else the bundled one. Fake homes, fake
// prefixes and fake executables only; nothing real is probed.
import { afterAll, describe, expect, it } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { chooseClaudeBinary, claudeInstallPaths } from "./claude-binary"

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** A fake machine: a home, two Homebrew prefixes, an npm prefix and a bundled copy. */
function machine() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "claude-binary-")))
  roots.push(root)
  const home = path.join(root, "home")
  const brew = path.join(root, "opt-homebrew")
  const usrLocal = path.join(root, "usr-local")
  const npmPrefix = path.join(root, "npm-global")
  for (const d of [home, brew, usrLocal, npmPrefix]) mkdirSync(d, { recursive: true })
  const bundledPath = exe(path.join(root, "bundled", "claude"), "echo 2.1.286")
  return { root, home, brew, usrLocal, npmPrefix, bundledPath, brewPrefixes: [brew, usrLocal] }
}

function exe(file: string, body: string): string {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

function link(launcher: string, target: string): void {
  mkdirSync(path.dirname(launcher), { recursive: true })
  symlinkSync(target, launcher)
}

/** The native installer's layout: ~/.local/bin/claude -> ~/.local/share/claude/versions/<v>. */
function native(home: string, version: string, out = `echo "${version} (Claude Code)"`): string {
  const target = exe(path.join(home, ".local", "share", "claude", "versions", version), out)
  link(path.join(home, ".local", "bin", "claude"), target)
  return target
}

describe("claudeInstallPaths", () => {
  it("an npm launcher resolves to the package dir as its install root; a Homebrew cask launcher to <prefix>/Caskroom/claude-code", () => {
    const m = machine()
    const pkg = path.join(m.npmPrefix, "lib", "node_modules", "@anthropic-ai", "claude-code")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@anthropic-ai/claude-code" }),
    )
    const cli = exe(path.join(pkg, "cli.js"), "echo 2.5.0")
    link(path.join(m.npmPrefix, "bin", "claude"), cli)
    const cask = exe(path.join(m.brew, "Caskroom", "claude-code", "2.6.0", "claude"), "echo 2.6.0")
    link(path.join(m.brew, "bin", "claude"), cask)

    const found = claudeInstallPaths({
      home: m.home,
      npmPrefix: m.npmPrefix,
      brewPrefixes: m.brewPrefixes,
    })
    expect(found.launchers).toEqual([
      path.join(m.home, ".local", "bin", "claude"),
      path.join(m.home, ".claude", "local", "claude"),
      path.join(m.npmPrefix, "bin", "claude"),
      path.join(m.brew, "bin", "claude"),
      path.join(m.usrLocal, "bin", "claude"),
    ])
    expect(found.candidates).toContainEqual({
      launcher: path.join(m.npmPrefix, "bin", "claude"),
      realPath: cli,
      installRoot: pkg,
    })
    expect(found.candidates).toContainEqual({
      launcher: path.join(m.brew, "bin", "claude"),
      realPath: cask,
      installRoot: path.join(m.brew, "Caskroom", "claude-code"),
    })
  })

  it("a Cellar formula and the local install resolve to their roots", () => {
    const m = machine()
    const cellar = exe(
      path.join(m.usrLocal, "Cellar", "claude-code", "2.6.0", "bin", "claude"),
      "echo 2.6.0",
    )
    link(path.join(m.usrLocal, "bin", "claude"), cellar)
    const local = exe(path.join(m.home, ".claude", "local", "claude"), "echo 2.4.0")
    const found = claudeInstallPaths({ home: m.home, brewPrefixes: m.brewPrefixes })
    expect(found.candidates).toContainEqual({
      launcher: path.join(m.usrLocal, "bin", "claude"),
      realPath: cellar,
      installRoot: path.join(m.usrLocal, "Cellar", "claude-code"),
    })
    expect(found.candidates).toContainEqual({
      launcher: local,
      realPath: local,
      installRoot: path.join(m.home, ".claude", "local"),
    })
  })
})

describe("chooseClaudeBinary", () => {
  it("a newer installed copy wins with its real path, version and install root", async () => {
    const m = machine()
    const target = native(m.home, "2.9.1")
    const chosen = await chooseClaudeBinary({
      home: m.home,
      bundledPath: m.bundledPath,
      bundledVersion: "2.1.286",
      brewPrefixes: m.brewPrefixes,
      writable: [path.join(m.root, "node-root")],
    })
    expect(chosen).toEqual({
      path: target,
      version: "2.9.1",
      source: "installed",
      installRoot: path.join(m.home, ".local", "share", "claude"),
    })
  })

  it("an older one loses to bundled", async () => {
    const m = machine()
    native(m.home, "2.0.5")
    const chosen = await chooseClaudeBinary({
      home: m.home,
      bundledPath: m.bundledPath,
      bundledVersion: "2.1.286",
      brewPrefixes: m.brewPrefixes,
      writable: [],
    })
    expect(chosen.source).toBe("bundled")
    expect(chosen.path).toBe(m.bundledPath)
    expect(chosen.version).toBe("2.1.286")
    expect(chosen.source === "bundled" && chosen.rejected).toContainEqual({
      launcher: path.join(m.home, ".local", "bin", "claude"),
      reason: "not_newer",
    })
  })

  // P1-walk D3: in the compiled sidecar the SDK's package.json cannot be
  // resolved, the bundled version read null, every installed copy was
  // rejected not_newer and the header said "Claude Code unknown (bundled)".
  it("an unreadable bundled version is probed from the bundled binary itself (D3)", async () => {
    const m = machine()
    const target = native(m.home, "2.9.1")
    const newer = await chooseClaudeBinary({
      home: m.home,
      bundledPath: m.bundledPath,
      bundledVersion: null,
      brewPrefixes: m.brewPrefixes,
      writable: [],
    })
    expect(newer).toMatchObject({ path: target, version: "2.9.1", source: "installed" })

    const same = machine()
    native(same.home, "2.1.286")
    const bundled = await chooseClaudeBinary({
      home: same.home,
      bundledPath: same.bundledPath,
      bundledVersion: null,
      brewPrefixes: same.brewPrefixes,
      writable: [],
    })
    expect(bundled).toMatchObject({ path: same.bundledPath, version: "2.1.286", source: "bundled" })
  })

  it("the newest of several newer copies wins", async () => {
    const m = machine()
    native(m.home, "2.3.0")
    const cask = exe(
      path.join(m.brew, "Caskroom", "claude-code", "2.10.0", "claude"),
      "echo 2.10.0",
    )
    link(path.join(m.brew, "bin", "claude"), cask)
    const chosen = await chooseClaudeBinary({
      home: m.home,
      bundledPath: m.bundledPath,
      bundledVersion: "2.1.286",
      brewPrefixes: m.brewPrefixes,
      writable: [],
    })
    expect(chosen.path).toBe(cask)
    expect(chosen.version).toBe("2.10.0")
  })

  it("a symlink resolving outside the install roots is ignored", async () => {
    const m = machine()
    const stray = exe(path.join(m.root, "elsewhere", "claude"), "echo 9.9.9")
    link(path.join(m.home, ".local", "bin", "claude"), stray)
    const chosen = await chooseClaudeBinary({
      home: m.home,
      bundledPath: m.bundledPath,
      bundledVersion: "2.1.286",
      brewPrefixes: m.brewPrefixes,
      writable: [],
    })
    expect(chosen.source).toBe("bundled")
    expect(chosen.source === "bundled" && chosen.rejected).toContainEqual({
      launcher: path.join(m.home, ".local", "bin", "claude"),
      reason: "outside_install_roots",
    })
  })

  it("planted binary: ~/.local/bin/claude re-pointed to a newer fake inside a shared folder is rejected writable_location and the bundled copy is chosen", async () => {
    const m = machine()
    const shared = path.join(m.root, "shared-folder")
    const planted = exe(path.join(shared, "tools", "claude"), "echo 9.9.9")
    link(path.join(m.home, ".local", "bin", "claude"), planted)
    const chosen = await chooseClaudeBinary({
      home: m.home,
      bundledPath: m.bundledPath,
      bundledVersion: "2.1.286",
      brewPrefixes: m.brewPrefixes,
      writable: [path.join(m.root, "node-root"), shared],
    })
    expect(chosen.path).toBe(m.bundledPath)
    expect(chosen.source === "bundled" && chosen.rejected).toContainEqual({
      launcher: path.join(m.home, ".local", "bin", "claude"),
      reason: "writable_location",
    })
  })

  it("a planted npm package (a package.json naming claude-code) inside a writable folder is rejected", async () => {
    const m = machine()
    const shared = path.join(m.root, "shared-folder")
    const pkg = path.join(shared, "node_modules", "@anthropic-ai", "claude-code")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@anthropic-ai/claude-code" }),
    )
    link(path.join(m.npmPrefix, "bin", "claude"), exe(path.join(pkg, "cli.js"), "echo 9.9.9"))
    const chosen = await chooseClaudeBinary({
      home: m.home,
      bundledPath: m.bundledPath,
      bundledVersion: "2.1.286",
      npmPrefix: m.npmPrefix,
      brewPrefixes: m.brewPrefixes,
      writable: [shared],
    })
    expect(chosen.source).toBe("bundled")
    expect(chosen.source === "bundled" && chosen.rejected).toContainEqual({
      launcher: path.join(m.npmPrefix, "bin", "claude"),
      reason: "writable_location",
    })
  })

  it("an install root that contains the node root is rejected", async () => {
    const m = machine()
    native(m.home, "2.9.1")
    const nodeRoot = path.join(m.home, ".local", "share", "claude", "node-root")
    mkdirSync(nodeRoot, { recursive: true })
    const chosen = await chooseClaudeBinary({
      home: m.home,
      bundledPath: m.bundledPath,
      bundledVersion: "2.1.286",
      brewPrefixes: m.brewPrefixes,
      writable: [nodeRoot],
    })
    expect(chosen.source).toBe("bundled")
    expect(chosen.source === "bundled" && chosen.rejected).toContainEqual({
      launcher: path.join(m.home, ".local", "bin", "claude"),
      reason: "writable_location",
    })
  })

  it("a probe that hangs past the timeout or prints garbage falls back to bundled", async () => {
    const hanging = machine()
    native(hanging.home, "2.9.1", "sleep 5")
    const started = Date.now()
    const slow = await chooseClaudeBinary({
      home: hanging.home,
      bundledPath: hanging.bundledPath,
      bundledVersion: "2.1.286",
      brewPrefixes: hanging.brewPrefixes,
      writable: [],
      probeTimeoutMs: 300,
    })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(slow.source).toBe("bundled")
    expect(slow.source === "bundled" && slow.rejected).toContainEqual({
      launcher: path.join(hanging.home, ".local", "bin", "claude"),
      reason: "probe_failed",
    })

    const garbage = machine()
    native(garbage.home, "2.9.1", "echo not a version")
    const bad = await chooseClaudeBinary({
      home: garbage.home,
      bundledPath: garbage.bundledPath,
      bundledVersion: "2.1.286",
      brewPrefixes: garbage.brewPrefixes,
      writable: [],
    })
    expect(bad.source).toBe("bundled")
  })

  it("a claude on PATH only is ignored", async () => {
    const m = machine()
    const onPath = path.join(m.root, "path-bin")
    exe(path.join(onPath, "claude"), "echo 9.9.9")
    const before = process.env.PATH
    process.env.PATH = `${onPath}:${before ?? ""}`
    try {
      const chosen = await chooseClaudeBinary({
        home: m.home,
        bundledPath: m.bundledPath,
        bundledVersion: "2.1.286",
        brewPrefixes: m.brewPrefixes,
        writable: [],
      })
      expect(chosen).toEqual({
        path: m.bundledPath,
        version: "2.1.286",
        source: "bundled",
        rejected: [],
      })
    } finally {
      process.env.PATH = before
    }
  })

  it("the probe runs the real path, never the launcher", async () => {
    const m = machine()
    const ran: string[] = []
    const target = native(m.home, "2.9.1")
    const chosen = await chooseClaudeBinary({
      home: m.home,
      bundledPath: m.bundledPath,
      bundledVersion: "2.1.286",
      brewPrefixes: m.brewPrefixes,
      writable: [],
      run: async (file) => {
        ran.push(file)
        return "2.9.1 (Claude Code)"
      },
    })
    expect(ran).toEqual([target])
    expect(chosen.path).toBe(target)
  })
})

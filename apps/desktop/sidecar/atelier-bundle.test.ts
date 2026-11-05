// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE BUNDLED ATELIER (P2-T12; S38, A33, D4): the vendored tree, its
// extraction, and who wins between the owner's Atelier and the bundled one.
import { afterAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ATELIER_VENDOR_DIR,
  atelierHooksStatus,
  atelierSourceFor,
  ensureBundledAtelier,
  settingsEnableAtelier,
  vendoredAtelier,
} from "./atelier-bundle"
import { buildRootPrefixes, scanFiles } from "./check-no-absolute-paths"

const root = mkdtempSync(path.join(tmpdir(), "liaison-atelier-bundle-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const TAG = "v0.4.0"
const COMMIT = "fe50da471ba54bac8e1ae80a5e983dcc7e2fc030"

function filesUnder(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name
    return e.isDirectory() ? filesUnder(dir, r) : [r]
  })
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")

describe("the vendored atelier-cc (S38, A33)", () => {
  it("S38: the vendored MANIFEST matches the files and VERSION names v0.4.0", () => {
    expect(readFileSync(path.join(ATELIER_VENDOR_DIR, "VERSION"), "utf8")).toBe(
      `${TAG} ${COMMIT}\n`,
    )
    const manifest = JSON.parse(
      readFileSync(path.join(ATELIER_VENDOR_DIR, "MANIFEST.json"), "utf8"),
    ) as Record<string, string>
    const onDisk = filesUnder(ATELIER_VENDOR_DIR)
      .filter((f) => f !== "VERSION" && f !== "MANIFEST.json")
      .sort()
    expect(Object.keys(manifest).sort()).toEqual(onDisk)
    for (const [rel, hash] of Object.entries(manifest)) {
      expect({ rel, hash: sha(path.join(ATELIER_VENDOR_DIR, rel)) }).toEqual({ rel, hash })
    }
    // Exactly the plugin's runtime: no tests, docs or CI of the upstream repo.
    expect(
      onDisk.every((f) =>
        /^(LICENSE|\.claude-plugin|commands|hooks|lib|skills|scripts|docs\/precepts\.md)(\/|$)/.test(
          f,
        ),
      ),
    ).toBe(true)
    expect(onDisk).toContain("commands/atelier.md")
    expect(onDisk).toContain("hooks/hooks.json")
    expect(readFileSync(path.join(ATELIER_VENDOR_DIR, "LICENSE"), "utf8")).toContain("MIT License")
    const plugin = JSON.parse(
      readFileSync(path.join(ATELIER_VENDOR_DIR, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string; version: string }
    expect(plugin).toMatchObject({ name: "atelier", version: "0.4.0" })
    expect(vendoredAtelier()).toMatchObject({ version: TAG, commit: COMMIT })
  })

  it("S38: every plugin-root path the vendored files name is vendored", () => {
    const named = new Set<string>()
    for (const rel of filesUnder(ATELIER_VENDOR_DIR)) {
      const text = readFileSync(path.join(ATELIER_VENDOR_DIR, rel), "utf8")
      for (const m of text.matchAll(/(?:\$P|\$\{CLAUDE_PLUGIN_ROOT\})\/([A-Za-z0-9_./-]+)/g)) {
        named.add((m[1] as string).replace(/[.]+$/, ""))
      }
    }
    expect(named.size).toBeGreaterThan(3)
    const missing = [...named].filter((rel) => {
      try {
        statSync(path.join(ATELIER_VENDOR_DIR, rel))
        return false
      } catch {
        return true
      }
    })
    expect(missing).toEqual([])
  })

  it("S38: no vendored file holds a build machine's absolute path", () => {
    const files = filesUnder(ATELIER_VENDOR_DIR).map((f) => path.join(ATELIER_VENDOR_DIR, f))
    expect(scanFiles(files, buildRootPrefixes(process.env))).toEqual([])
  })
})

describe("extracting the bundled Atelier (S38, A33)", () => {
  it("S38: extraction rewrites a tampered file and keeps an intact tree", () => {
    const data = path.join(root, "data-tamper")
    const dir = ensureBundledAtelier(data)
    expect(dir).toBe(path.join(data, "atelier", TAG))
    const embed = vendoredAtelier()
    for (const f of embed.files) expect(sha(path.join(dir, f.path))).toBe(f.sha256)
    // The hooks run as commands: executable; a plain file is not.
    expect(statSync(path.join(dir, "hooks", "stop.sh")).mode & 0o777).toBe(0o755)
    expect(statSync(path.join(dir, "commands", "atelier.md")).mode & 0o777).toBe(0o644)

    // Intact: the same tree is kept (no rewrite, same inode).
    const ino = statSync(path.join(dir, "commands", "atelier.md")).ino
    expect(ensureBundledAtelier(data)).toBe(dir)
    expect(statSync(path.join(dir, "commands", "atelier.md")).ino).toBe(ino)

    // Tampered: the file is put back as shipped.
    writeFileSync(path.join(dir, "hooks", "stop.sh"), "#!/bin/sh\necho tampered\n")
    expect(ensureBundledAtelier(data)).toBe(dir)
    const stop = embed.files.find((f) => f.path === "hooks/stop.sh")
    expect(sha(path.join(dir, "hooks", "stop.sh"))).toBe(stop?.sha256 as string)
    // A missing file too.
    rmSync(path.join(dir, "commands", "atelier.md"))
    ensureBundledAtelier(data)
    expect(readFileSync(path.join(dir, "commands", "atelier.md"), "utf8")).toContain("Atelier")
    // No temp dir is left behind.
    expect(readdirSync(path.join(data, "atelier"))).toEqual([TAG])
  })

  it("D44: a tree whose file list differs from the manifest (a planted file, a link) is extracted again", () => {
    const data = path.join(root, "data-planted")
    const dir = ensureBundledAtelier(data)
    // A file the manifest does not name: a hook the session could have planted.
    writeFileSync(path.join(dir, "hooks", "planted.sh"), "#!/bin/sh\necho planted\n")
    mkdirSync(path.join(dir, "extra"))
    expect(ensureBundledAtelier(data)).toBe(dir)
    expect(existsSync(path.join(dir, "hooks", "planted.sh"))).toBe(false)
    expect(existsSync(path.join(dir, "extra"))).toBe(false)
    // A shipped file replaced by a link to the same bytes elsewhere.
    const elsewhere = path.join(root, "elsewhere.md")
    writeFileSync(elsewhere, readFileSync(path.join(dir, "commands", "atelier.md")))
    rmSync(path.join(dir, "commands", "atelier.md"))
    symlinkSync(elsewhere, path.join(dir, "commands", "atelier.md"))
    ensureBundledAtelier(data)
    expect(lstatSync(path.join(dir, "commands", "atelier.md")).isSymbolicLink()).toBe(false)
    expect(readdirSync(path.join(data, "atelier"))).toEqual([TAG])
  })

  it("D44 (batch-2 F6): a shipped file that is also a hard link elsewhere is extracted again, unlinked", () => {
    const data = path.join(root, "data-hardlink")
    const dir = ensureBundledAtelier(data)
    const file = path.join(dir, "commands", "atelier.md")
    // Same inode, same bytes: whoever writes through the other name rewrites the bundle.
    const other = path.join(root, "hardlink.md")
    linkSync(file, other)
    expect(statSync(file).nlink).toBe(2)
    expect(ensureBundledAtelier(data)).toBe(dir)
    expect(statSync(file).nlink).toBe(1)
    expect(statSync(file).ino).not.toBe(statSync(other).ino)
    expect(readdirSync(path.join(data, "atelier"))).toEqual([TAG])
  })

  it("S38: an embedded file that does not match its manifest is refused and nothing is extracted", () => {
    const src = path.join(root, "bad-src")
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, "a.md"), "changed\n")
    const data = path.join(root, "data-bad")
    expect(() =>
      ensureBundledAtelier(data, {
        version: TAG,
        commit: COMMIT,
        files: [{ path: "a.md", source: path.join(src, "a.md"), sha256: "0".repeat(64) }],
      }),
    ).toThrow("does not match its manifest")
    expect(readdirSync(path.join(data, "atelier"))).toEqual([])
  })
})

describe("the owner's own Atelier wins (D4, S38)", () => {
  function settings(name: string, body: unknown): string {
    const file = path.join(root, `${name}.json`)
    writeFileSync(file, JSON.stringify(body))
    return file
  }

  it("D4: settings enabling atelier@<any marketplace> are the owner's own; disabled, another plugin or no file are not", () => {
    expect(
      settingsEnableAtelier(settings("s1", { enabledPlugins: { "atelier@atelier": true } })),
    ).toBe(true)
    expect(
      settingsEnableAtelier(settings("s2", { enabledPlugins: { "atelier@my-fork": true } })),
    ).toBe(true)
    expect(
      settingsEnableAtelier(settings("s3", { enabledPlugins: { "atelier@atelier": false } })),
    ).toBe(false)
    expect(settingsEnableAtelier(settings("s4", { enabledPlugins: { "atelier-x@a": true } }))).toBe(
      false,
    )
    expect(settingsEnableAtelier(settings("s5", { enabledPlugins: ["atelier@atelier"] }))).toBe(
      false,
    )
    expect(settingsEnableAtelier(path.join(root, "absent.json"))).toBe(false)
  })

  it("S38: an owner session gets the owner's Atelier when enabled, else the bundled one; an isolated one never", () => {
    const on = settings("on", { enabledPlugins: { "atelier@atelier": true } })
    const off = settings("off", { enabledPlugins: {} })
    expect(atelierSourceFor({ configKind: "owner", settingsFile: on })).toBe("user")
    expect(atelierSourceFor({ configKind: "owner", settingsFile: off })).toBe("bundled")
    expect(atelierSourceFor({ configKind: "isolated", settingsFile: on })).toBe("none")
    expect(atelierSourceFor({ configKind: "isolated", settingsFile: off })).toBe("none")
  })
  it("D41: an owner who installed Atelier and switched it off gets no bundled copy either", () => {
    const disabled = settings("disabled", { enabledPlugins: { "atelier@atelier": false } })
    const forkOff = settings("fork-off", { enabledPlugins: { "atelier@my-fork": false } })
    const other = settings("other", { enabledPlugins: { "ralph-loop@x": false } })
    expect(atelierSourceFor({ configKind: "owner", settingsFile: disabled })).toBe("none")
    expect(atelierSourceFor({ configKind: "owner", settingsFile: forkOff })).toBe("none")
    // No Atelier install named at all: the bundled one.
    expect(atelierSourceFor({ configKind: "owner", settingsFile: other })).toBe("bundled")
  })
})

describe("the hooks' requirements (GF-53)", () => {
  it("GF-53: bash 3 is bash<4, bash 5 without jq is no jq, bash 5 with jq is ok, measured once per PATH", () => {
    const calls: string[] = []
    const fake = (bashMajor: string, jq: boolean) => (cmd: string[]) => {
      calls.push(cmd.join(" "))
      if (cmd[2]?.startsWith("echo")) return { exitCode: 0, stdout: `${bashMajor}\n` }
      return { exitCode: jq ? 0 : 1, stdout: "" }
    }
    expect(atelierHooksStatus("/p3", fake("3", true))).toBe("bash<4")
    expect(atelierHooksStatus("/p5-nojq", fake("5", false))).toBe("no jq")
    expect(atelierHooksStatus("/p5", fake("5", true))).toBe("ok")
    const before = calls.length
    expect(atelierHooksStatus("/p5", fake("3", false))).toBe("ok")
    expect(calls.length).toBe(before)
    expect(atelierHooksStatus("/none", () => ({ exitCode: 127, stdout: "" }))).toBe("bash<4")
  })
})

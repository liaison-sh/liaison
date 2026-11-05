// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION CONFIG DIR (P1-T31, D26, D27, D48): an owner run reads the
// owner's ~/.claude only through a mirror the node builds, with the settings
// filtered below Open; an isolated run gets the credential and nothing else.
import { afterAll, describe, expect, it } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mirrorReads, prepareSessionConfig, sessionConfigDir } from "./session-config"

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-session-config-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const SESSION = "9f8e7d6c-5b4a-4321-8fed-cba987654321"

/** The owner's settings with every key D48 says never reaches a session below Open. */
const OWNER_SETTINGS = {
  $schema: "https://json.schemastore.org/claude-code-settings.json",
  outputStyle: "Explanatory",
  includeCoAuthoredBy: false,
  enabledPlugins: { "atelier@local": true },
  permissions: {
    allow: ["Bash(*)"],
    deny: ["Read(~/.aws/**)"],
    ask: ["WebFetch"],
    defaultMode: "bypassPermissions",
    additionalDirectories: ["/"],
  },
  sandbox: { filesystem: { allowWrite: ["~"] }, allowAppleEvents: true },
  hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo hi" }] }] },
  disableAllHooks: false,
  env: { GIT_SSH_COMMAND: "ssh -i ~/.ssh/other" },
  apiKeyHelper: "/usr/local/bin/key",
  statusLine: { type: "command", command: "echo status" },
  model: "opus",
}

/** A fake ~/.claude: the five mirrored entries (CLAUDE.md missing on request), a credential, junk. */
function realDir(opts: { withClaudeMd?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(root, "real-"))
  if (opts.withClaudeMd !== false) writeFileSync(path.join(dir, "CLAUDE.md"), "# owner notes\n")
  for (const sub of ["skills", "agents", "commands", "plugins"]) {
    mkdirSync(path.join(dir, sub, "x"), { recursive: true })
  }
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(OWNER_SETTINGS))
  writeFileSync(path.join(dir, ".credentials.json"), '{"claudeAiOauth":{}}')
  mkdirSync(path.join(dir, "projects", "-some-project"), { recursive: true })
  writeFileSync(path.join(dir, "history.jsonl"), "{}\n")
  return dir
}

function settingsOf(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"))
}

describe("prepareSessionConfig (P1-T31)", () => {
  it("an owner mirror links the five entries that exist and filters settings at strict", () => {
    const real = realDir()
    const dataDir = mkdtempSync(path.join(root, "data-"))
    const out = prepareSessionConfig({
      sessionId: SESSION,
      configKind: "owner",
      level: "strict",
      realConfigDir: real,
      dataDir,
    })
    expect(out.dir).toBe(path.join(dataDir, "session-config", SESSION))
    expect(out.dir).toBe(sessionConfigDir(SESSION, dataDir))
    expect(out.linked.sort()).toEqual(["CLAUDE.md", "agents", "commands", "plugins", "skills"])
    for (const name of out.linked) {
      const at = path.join(out.dir, name)
      expect(lstatSync(at).isSymbolicLink()).toBe(true)
      expect(readlinkSync(at)).toBe(path.join(real, name))
    }
    // Nothing else of the owner's config dir reaches the session (S49: plus
    // the link to the owner's projects).
    expect(readdirSync(out.dir).sort()).toEqual(
      [
        ".credentials.json",
        "CLAUDE.md",
        "agents",
        "commands",
        "plugins",
        "projects",
        "settings.json",
        "skills",
      ].sort(),
    )
    expect(lstatSync(path.join(out.dir, "settings.json")).isSymbolicLink()).toBe(false)
    expect(settingsOf(out.dir)).toEqual({
      $schema: OWNER_SETTINGS.$schema,
      outputStyle: "Explanatory",
      includeCoAuthoredBy: false,
      enabledPlugins: { "atelier@local": true },
      permissions: { deny: ["Read(~/.aws/**)"] },
    })
    // D48: the keys that widen a level are named, and never written.
    for (const key of [
      "sandbox",
      "permissions.allow",
      "permissions.defaultMode",
      "hooks",
      "disableAllHooks",
      "env",
      "apiKeyHelper",
    ]) {
      expect(out.filtered).toContain(key)
    }
    expect(out.filtered).toContain("statusLine")
    expect(out.filtered).toContain("model")
    expect(out.filtered).toContain("permissions.ask")
    expect(out.filtered).toContain("permissions.additionalDirectories")
    const written = readFileSync(path.join(out.dir, "settings.json"), "utf8")
    for (const needle of [
      "allowWrite",
      "Bash(*)",
      "bypassPermissions",
      "GIT_SSH",
      "apiKeyHelper",
    ]) {
      expect(written).not.toContain(needle)
    }
    // The real config dir is never written.
    expect(JSON.parse(readFileSync(path.join(real, "settings.json"), "utf8"))).toEqual(
      OWNER_SETTINGS,
    )
    expect(mirrorReads(out.dir).sort()).toEqual(
      ["CLAUDE.md", "agents", "commands", "plugins", "skills"]
        .map((n) => path.join(real, n))
        .sort(),
    )
  })

  it("standard filters the same way; a missing entry is not linked", () => {
    const real = realDir({ withClaudeMd: false })
    const out = prepareSessionConfig({
      sessionId: SESSION,
      configKind: "owner",
      level: "standard",
      realConfigDir: real,
      dataDir: mkdtempSync(path.join(root, "data-")),
    })
    expect(out.linked.sort()).toEqual(["agents", "commands", "plugins", "skills"])
    expect(existsSync(path.join(out.dir, "CLAUDE.md"))).toBe(false)
    expect(settingsOf(out.dir).sandbox).toBeUndefined()
    expect(settingsOf(out.dir).hooks).toBeUndefined()
  })

  it("open copies settings unfiltered", () => {
    const real = realDir()
    const out = prepareSessionConfig({
      sessionId: SESSION,
      configKind: "owner",
      level: "open",
      realConfigDir: real,
      dataDir: mkdtempSync(path.join(root, "data-")),
    })
    expect(lstatSync(path.join(out.dir, "settings.json")).isSymbolicLink()).toBe(false)
    expect(settingsOf(out.dir)).toEqual(OWNER_SETTINGS)
    expect(out.filtered).toEqual([])
    expect(out.linked.length).toBe(5)
  })

  it("isolated holds only the credential", () => {
    const real = realDir()
    for (const level of ["strict", "open"] as const) {
      const out = prepareSessionConfig({
        sessionId: SESSION,
        configKind: "isolated",
        level,
        realConfigDir: real,
        dataDir: mkdtempSync(path.join(root, "data-")),
      })
      expect(readdirSync(out.dir)).toEqual([".credentials.json"])
      expect(out.linked).toEqual([])
      expect(mirrorReads(out.dir)).toEqual([])
    }
  })

  it("a second call for the same session reuses the dir, keeps its transcript, refilters on a level change", () => {
    const real = realDir()
    const dataDir = mkdtempSync(path.join(root, "data-"))
    const args = { sessionId: SESSION, configKind: "owner" as const, realConfigDir: real, dataDir }
    const first = prepareSessionConfig({ ...args, level: "open" })
    const transcript = path.join(first.dir, "projects", "-session-cwd", "abc.jsonl")
    mkdirSync(path.dirname(transcript), { recursive: true })
    writeFileSync(transcript, "{}\n")
    expect(settingsOf(first.dir).hooks).toBeDefined()
    const second = prepareSessionConfig({ ...args, level: "strict" })
    expect(second.dir).toBe(first.dir)
    expect(readFileSync(transcript, "utf8")).toBe("{}\n")
    expect(second.linked.length).toBe(5)
    expect(settingsOf(second.dir).hooks).toBeUndefined()
    expect(settingsOf(second.dir).permissions).toEqual({ deny: ["Read(~/.aws/**)"] })
  })

  it("an unreadable owner settings file passes nothing below Open", () => {
    const real = realDir()
    writeFileSync(path.join(real, "settings.json"), "{ not json")
    const out = prepareSessionConfig({
      sessionId: SESSION,
      configKind: "owner",
      level: "strict",
      realConfigDir: real,
      dataDir: mkdtempSync(path.join(root, "data-")),
    })
    expect(settingsOf(out.dir)).toEqual({})
    expect(out.filtered).toEqual(["settings.json"])
  })
})

describe("the owner's transcripts (P1-T21, S49, owner D13, A18)", () => {
  it("S49: an owner run's config dir links projects to the owner's projects dir; an isolated run's does not", () => {
    const real = realDir()
    const dataDir = mkdtempSync(path.join(root, "data-"))
    const owner = prepareSessionConfig({
      sessionId: SESSION,
      configKind: "owner",
      level: "standard",
      realConfigDir: real,
      dataDir,
    })
    const link = path.join(owner.dir, "projects")
    expect(owner.projects).toBe("linked")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(path.join(real, "projects"))
    // The owner's existing projects are what the session sees, untouched.
    expect(readdirSync(link)).toEqual(["-some-project"])
    // The transcripts are not a sandbox read: the CLI writes them, not a command.
    expect(mirrorReads(owner.dir)).not.toContain(path.join(real, "projects"))

    const isolated = prepareSessionConfig({
      sessionId: "1a2b3c4d-5b4a-4321-8fed-cba987654321",
      configKind: "isolated",
      level: "standard",
      realConfigDir: real,
      dataDir,
    })
    expect(isolated.projects).toBe("own")
    expect(existsSync(path.join(isolated.dir, "projects"))).toBe(false)
  })

  it("S49: an owner without a projects dir gets one (0700); a resume keeps the link", () => {
    const real = realDir()
    rmSync(path.join(real, "projects"), { recursive: true, force: true })
    const dataDir = mkdtempSync(path.join(root, "data-"))
    const args = {
      sessionId: SESSION,
      configKind: "owner" as const,
      level: "strict" as const,
      realConfigDir: real,
      dataDir,
    }
    const first = prepareSessionConfig(args)
    expect(lstatSync(path.join(real, "projects")).isDirectory()).toBe(true)
    expect(lstatSync(path.join(real, "projects")).mode & 0o777).toBe(0o700)
    const transcript = path.join(first.dir, "projects", "-repo", `${SESSION}.jsonl`)
    mkdirSync(path.dirname(transcript), { recursive: true })
    writeFileSync(transcript, "{}\n")
    const second = prepareSessionConfig({ ...args, level: "open" })
    expect(second.projects).toBe("linked")
    // Written through the link: it is the owner's file now, and stays.
    expect(readFileSync(path.join(real, "projects", "-repo", `${SESSION}.jsonl`), "utf8")).toBe(
      "{}\n",
    )
  })

  it("S49: a legacy real projects dir is kept; an empty one or a stale link is replaced without following it", () => {
    const real = realDir()
    const dataDir = mkdtempSync(path.join(root, "data-"))
    const args = {
      configKind: "owner" as const,
      level: "standard" as const,
      realConfigDir: real,
      dataDir,
    }
    // Legacy: an older session's transcript in its own projects dir.
    const legacyId = "2b3c4d5e-5b4a-4321-8fed-cba987654321"
    const legacyDir = sessionConfigDir(legacyId, dataDir)
    const old = path.join(legacyDir, "projects", "-repo", `${legacyId}.jsonl`)
    mkdirSync(path.dirname(old), { recursive: true })
    writeFileSync(old, "{}\n")
    const legacy = prepareSessionConfig({ ...args, sessionId: legacyId })
    expect(legacy.projects).toBe("legacy")
    expect(lstatSync(path.join(legacyDir, "projects")).isSymbolicLink()).toBe(false)
    expect(readFileSync(old, "utf8")).toBe("{}\n")

    // An empty real dir becomes the link.
    const emptyId = "3c4d5e6f-5b4a-4321-8fed-cba987654321"
    mkdirSync(path.join(sessionConfigDir(emptyId, dataDir), "projects"), { recursive: true })
    expect(prepareSessionConfig({ ...args, sessionId: emptyId }).projects).toBe("linked")

    // A stale link elsewhere is unlinked, and what it pointed at stays whole.
    const staleId = "4d5e6f70-5b4a-4321-8fed-cba987654321"
    const elsewhere = mkdtempSync(path.join(root, "elsewhere-"))
    writeFileSync(path.join(elsewhere, "keep.jsonl"), "{}\n")
    const staleDir = sessionConfigDir(staleId, dataDir)
    mkdirSync(staleDir, { recursive: true })
    symlinkSync(elsewhere, path.join(staleDir, "projects"))
    const out = prepareSessionConfig({ ...args, sessionId: staleId })
    expect(out.projects).toBe("linked")
    expect(readlinkSync(path.join(staleDir, "projects"))).toBe(path.join(real, "projects"))
    expect(readFileSync(path.join(elsewhere, "keep.jsonl"), "utf8")).toBe("{}\n")
  })
})

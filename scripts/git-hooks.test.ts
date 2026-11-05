// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The secret and address gates in scripts/git-hooks, driven through real git in
// a throwaway repository. gitleaks itself is on developer machines and in the
// `gitleaks` CI job, not on every test runner: the cases about what it finds run
// where it is installed, and the rest use a stub that records how it was called.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const HOOKS = path.join(ROOT, "scripts/git-hooks")
const CONFIG = path.join(ROOT, ".gitleaks.toml")
const realGitleaks = Bun.which("gitleaks")
const ZERO = "0".repeat(40)

/** Shaped like a GitHub token and random, so no scanner ever finds it in this file. */
function fakeToken(): string {
  const alphabet = randomBytes(36).toString("base64url").replace(/[-_]/g, "a")
  return ["gh", "p_", alphabet.padEnd(36, "b").slice(0, 36)].join("")
}

let dir = ""
let repo = ""
let stubBin = ""
let stubLog = ""
let gitOnly = ""

type Tool = "real" | "stub" | "none"
/** PATH without gitleaks, which often shares a directory with git. */
const SYSTEM_PATH = (process.env.PATH ?? "")
  .split(":")
  .filter((d) => d && !Bun.which("gitleaks", { PATH: d }))

/** PATH with the system tools and git, plus gitleaks only when `tool` says so. */
function env(tool: Tool): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("GIT_")) clean[k] = v
  }
  const toolDirs = { real: [path.dirname(realGitleaks ?? "")], stub: [stubBin], none: [] }[tool]
  return {
    ...clean,
    PATH: [...toolDirs, gitOnly, ...SYSTEM_PATH].join(":"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "dev@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "dev@example.com",
  }
}

function git(args: string[], tool: Tool = "stub", extra = {}) {
  const r = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: { ...env(tool), ...extra },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` }
}

function ok(args: string[], tool: Tool = "stub", extra = {}): string {
  const r = git(args, tool, extra)
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.out}`)
  return r.out.trim()
}

function commitFile(name: string, content: string, message = `add ${name}`, extra = {}) {
  writeFileSync(path.join(repo, name), content)
  ok(["add", name])
  ok(["commit", "-qm", message, "--no-verify"], "stub", extra)
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "liaison-git-hooks-"))
  repo = path.join(dir, "work")
  mkdirSync(repo)
  gitOnly = path.join(dir, "git-only")
  mkdirSync(gitOnly)
  symlinkSync(Bun.which("git") as string, path.join(gitOnly, "git"))
  stubBin = path.join(dir, "stub-bin")
  stubLog = path.join(dir, "stub.log")
  mkdirSync(stubBin)
  const stub = path.join(stubBin, "gitleaks")
  writeFileSync(
    stub,
    `#!/bin/sh\necho "$*" >> "${stubLog}"\n[ "$1" = stdin ] && cat >/dev/null\nexit 0\n`,
  )
  chmodSync(stub, 0o755)
  writeFileSync(stubLog, "")

  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo], { env: env("stub") })
  Bun.spawnSync(["git", "init", "-q", "--bare", path.join(dir, "origin.git")], { env: env("stub") })
  ok(["config", "core.hooksPath", HOOKS])
  ok(["remote", "add", "origin", path.join(dir, "origin.git")])
  copyFileSync(CONFIG, path.join(repo, ".gitleaks.toml"))
  ok(["add", ".gitleaks.toml"])
  ok(["commit", "-qm", "init", "--no-verify"])
  ok(["push", "-q", "--no-verify", "origin", "main"])
  ok(["fetch", "-q", "origin"])
  ok(["checkout", "-qb", "topic"])
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const stubCalls = () => readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean)

describe("hook files", () => {
  for (const hook of ["pre-commit", "pre-push"]) {
    it(`${hook} is executable`, () => {
      expect(statSync(path.join(HOOKS, hook)).mode & 0o111).toBeTruthy()
    })
  }
})

describe("pre-commit", () => {
  it("stops the commit with the install command when gitleaks is missing", () => {
    writeFileSync(path.join(repo, "a.txt"), "hello\n")
    ok(["add", "a.txt"], "none")
    const r = git(["commit", "-qm", "a"], "none")
    expect(r.code).toBe(1)
    expect(r.out).toContain("brew install gitleaks")
    expect(ok(["rev-list", "--count", "topic", "^main"], "none")).toBe("0")
  })

  it("scans the staged diff with the repo's config", () => {
    writeFileSync(path.join(repo, "a.txt"), "hello\n")
    ok(["add", "a.txt"])
    ok(["commit", "-qm", "a"])
    const [call] = stubCalls()
    expect(call).toContain("git --pre-commit --staged")
    expect(call).toContain("--config .gitleaks.toml")
    expect(call).toContain("--ignore-gitleaks-allow")
  })

  describe.skipIf(!realGitleaks)("with gitleaks", () => {
    it("blocks a planted token and never prints it", () => {
      const token = fakeToken()
      writeFileSync(path.join(repo, "conf.txt"), `value = "${token}"\n`)
      ok(["add", "conf.txt"], "real")
      const r = git(["commit", "-qm", "planted"], "real")
      expect(r.code).toBe(1)
      expect(r.out).toContain("github-pat")
      expect(r.out).not.toContain(token)
      expect(ok(["rev-list", "--count", "topic", "^main"], "real")).toBe("0")
    })

    it("ignores an inline gitleaks:allow", () => {
      writeFileSync(path.join(repo, "conf.txt"), `value = "${fakeToken()}" # gitleaks:allow\n`)
      ok(["add", "conf.txt"], "real")
      expect(git(["commit", "-qm", "planted"], "real").code).toBe(1)
    })

    it("lets a clean commit through", () => {
      writeFileSync(path.join(repo, "clean.txt"), "nothing to see\n")
      ok(["add", "clean.txt"], "real")
      expect(git(["commit", "-qm", "clean"], "real").code).toBe(0)
    })
  })
})

describe("pre-push", () => {
  const push = (args: string[], tool: Tool = "stub") => git(["push", "-q", "origin", ...args], tool)

  it("stops the push with the install command when gitleaks is missing", () => {
    commitFile("a.txt", "a\n")
    const r = push(["topic"], "none")
    expect(r.code).toBe(1)
    expect(r.out).toContain("brew install gitleaks")
  })

  it("lets a branch deletion through, even without gitleaks", () => {
    commitFile("a.txt", "a\n")
    ok(["push", "-q", "--no-verify", "origin", "topic"])
    const r = push(["--delete", "topic"], "none")
    expect(r.code).toBe(0)
    expect(ok(["ls-remote", "--heads", "origin", "topic"], "none")).toBe("")
  })

  it("scans only the commits a new branch adds, by range and not --all", () => {
    const main = ok(["rev-parse", "main"])
    commitFile("a.txt", "a\n")
    const head = ok(["rev-parse", "HEAD"])
    ok(["branch", "unrelated", "HEAD~0"])
    expect(push(["topic"]).code).toBe(0)
    const scan = stubCalls().find((c) => c.startsWith("git "))
    expect(scan).toContain(`--log-opts=--diff-merges=first-parent ${head} --not --remotes=origin`)
    expect(scan).not.toContain("--all")
    expect(scan).not.toContain(main)
    expect(stubCalls().some((c) => c.startsWith("stdin "))).toBe(true)
  })

  it("scans from the replaced commit on an update", () => {
    commitFile("a.txt", "a\n")
    ok(["push", "-q", "--no-verify", "origin", "topic"])
    const before = ok(["rev-parse", "HEAD"])
    commitFile("b.txt", "b\n")
    const head = ok(["rev-parse", "HEAD"])
    expect(push(["topic"]).code).toBe(0)
    const scan = stubCalls().find((c) => c.startsWith("git "))
    expect(scan).toContain(`${head} ^${before} --not --remotes=origin`)
  })

  it("skips gitleaks when the push adds no commit", () => {
    expect(push(["main:already-there"], "none").code).toBe(0)
    expect(stubCalls()).toEqual([])
  })

  it("survives an all-zero remote sha and an empty ref list when called directly", () => {
    commitFile("a.txt", "a\n")
    const head = ok(["rev-parse", "HEAD"])
    const run = (stdin: string) =>
      Bun.spawnSync(["sh", path.join(HOOKS, "pre-push"), "origin", path.join(dir, "origin.git")], {
        cwd: repo,
        env: env("stub"),
        stdin: new TextEncoder().encode(stdin),
        stderr: "pipe",
      }).exitCode
    expect(run(`refs/heads/topic ${head} refs/heads/topic ${ZERO}\n`)).toBe(0)
    expect(run(`(delete) ${ZERO} refs/heads/gone ${head}\n`)).toBe(0)
    expect(run("")).toBe(0)
  })

  it("refuses a push to main on the product repo, and only there", () => {
    const main = ok(["rev-parse", "main"])
    const run = (url: string) =>
      Bun.spawnSync(["sh", path.join(HOOKS, "pre-push"), "origin", url], {
        cwd: repo,
        env: env("stub"),
        stdin: new TextEncoder().encode(`refs/heads/main ${main} refs/heads/main ${ZERO}\n`),
        stderr: "pipe",
      })
    const refused = run("git@github.com:mathieufro/liaison.git")
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr.toString()).toContain("push to main REFUSED")
    expect(run("git@gitlab.example:someone/liaison.git").exitCode).toBe(0)
  })

  describe("blocked addresses", () => {
    const BLOCKED = "private.person@example.org"

    it("ignores an unset list", () => {
      commitFile("a.txt", "a\n", "a", { GIT_AUTHOR_EMAIL: BLOCKED })
      expect(push(["topic"]).code).toBe(0)
    })

    it("blocks an author, whatever the case", () => {
      ok(["config", "--add", "liaison.blockedEmails", BLOCKED])
      commitFile("a.txt", "a\n", "a", { GIT_AUTHOR_EMAIL: "Private.Person@Example.org" })
      const r = push(["topic"])
      expect(r.code).toBe(1)
      expect(r.out).toContain("blocked address")
      expect(ok(["ls-remote", "--heads", "origin", "topic"])).toBe("")
    })

    it("blocks a committer", () => {
      ok(["config", "--add", "liaison.blockedEmails", BLOCKED])
      commitFile("a.txt", "a\n", "a", { GIT_COMMITTER_EMAIL: BLOCKED })
      expect(push(["topic"]).code).toBe(1)
    })

    it("blocks a trailer in a message", () => {
      ok(["config", "--add", "liaison.blockedEmails", BLOCKED])
      commitFile("a.txt", "a\n", `a\n\nCo-authored-by: Someone <${BLOCKED}>`)
      expect(push(["topic"]).code).toBe(1)
    })

    it("checks every value of the list, and an older commit of the push", () => {
      ok(["config", "--add", "liaison.blockedEmails", "other@example.org"])
      ok(["config", "--add", "liaison.blockedEmails", BLOCKED])
      commitFile("a.txt", "a\n", "a", { GIT_AUTHOR_EMAIL: BLOCKED })
      commitFile("b.txt", "b\n")
      expect(push(["topic"]).code).toBe(1)
    })

    it("does not block a longer address that contains a listed one", () => {
      ok(["config", "--add", "liaison.blockedEmails", "person@example.org"])
      commitFile("a.txt", "a\n", "a", { GIT_AUTHOR_EMAIL: "theperson@example.org" })
      expect(push(["topic"]).code).toBe(0)
    })

    it("does not look at commits already on the remote", () => {
      commitFile("a.txt", "a\n", "a", { GIT_AUTHOR_EMAIL: BLOCKED })
      ok(["push", "-q", "--no-verify", "origin", "topic"])
      ok(["config", "--add", "liaison.blockedEmails", BLOCKED])
      commitFile("b.txt", "b\n")
      expect(push(["topic"]).code).toBe(0)
    })
  })

  describe.skipIf(!realGitleaks)("with gitleaks", () => {
    it("blocks a token in any commit of the push, even one removed since", () => {
      const token = fakeToken()
      commitFile("conf.txt", `value = "${token}"\n`)
      ok(["rm", "-q", "conf.txt"])
      ok(["commit", "-qm", "remove", "--no-verify"])
      const r = push(["topic"], "real")
      expect(r.code).toBe(1)
      expect(r.out).toContain("github-pat")
      expect(r.out).not.toContain(token)
      expect(ok(["ls-remote", "--heads", "origin", "topic"])).toBe("")
    })

    it("blocks a token added inside a merge commit", () => {
      commitFile("a.txt", "a\n")
      ok(["checkout", "-qb", "side", "main"])
      commitFile("b.txt", "b\n")
      ok(["checkout", "-q", "topic"])
      ok(["merge", "-q", "--no-commit", "--no-ff", "side"])
      writeFileSync(path.join(repo, "conf.txt"), `value = "${fakeToken()}"\n`)
      ok(["add", "conf.txt"])
      ok(["commit", "-qm", "merge side", "--no-verify"])
      expect(push(["topic"], "real").code).toBe(1)
    })

    it("blocks a token in a commit message", () => {
      commitFile("a.txt", "a\n", `a\n\nused ${fakeToken()} while debugging`)
      const r = push(["topic"], "real")
      expect(r.code).toBe(1)
      expect(r.out).toContain("commit message")
    })

    it("lets clean commits through", () => {
      commitFile("a.txt", "a\n")
      expect(push(["topic"], "real").code).toBe(0)
      expect(ok(["ls-remote", "--heads", "origin", "topic"])).not.toBe("")
    })
  })
})

describe("the gitleaks config", () => {
  it("never pairs paths with pinned values without targetRules", () => {
    // Without targetRules gitleaks exempts the whole file for every rule, so the
    // values look pinned and pin nothing.
    const config = Bun.TOML.parse(readFileSync(CONFIG, "utf8")) as {
      allowlists: Array<{
        description: string
        paths?: string[]
        regexes?: string[]
        targetRules?: string[]
      }>
    }
    const unpinned = config.allowlists
      .filter((a) => a.paths && a.regexes && !a.targetRules)
      .map((a) => a.description)
    expect(unpinned).toEqual([])
  })
})

describe.skipIf(!realGitleaks)("the control plane vector allowlist", () => {
  const VECTORS = "packages/control-plane-contract/src/vectors.ts"
  const source = () => readFileSync(path.join(ROOT, VECTORS), "utf8")

  /** `cwd` matters: gitleaks matches allowlist paths as the scan target spells them. */
  function scan(target: string, cwd = dir) {
    const report = path.join(dir, "report.json")
    Bun.spawnSync(
      [
        realGitleaks as string,
        "dir",
        "--config",
        CONFIG,
        "--no-banner",
        "--log-level",
        "error",
        "--report-format",
        "json",
        "--report-path",
        report,
        target,
      ],
      { cwd, stdout: "ignore", stderr: "ignore" },
    )
    return (JSON.parse(readFileSync(report, "utf8")) as Array<{ RuleID: string }>).map(
      (f) => f.RuleID,
    )
  }

  function plantInVectors(line: string) {
    const copy = path.join(dir, VECTORS)
    mkdirSync(path.dirname(copy), { recursive: true })
    writeFileSync(copy, `${source()}\n${line}\n`)
  }

  it("holds on a relative scan target, as the hooks and CI use", () => {
    expect(scan(VECTORS, ROOT)).toEqual([])
  })

  it("holds on an absolute scan target", () => {
    expect(scan(path.join(ROOT, VECTORS))).toEqual([])
  })

  it("still reports another value in that file", () => {
    plantInVectors(`const apiKey = "${randomBytes(32).toString("hex")}"`)
    expect(scan(VECTORS)).toEqual(["generic-api-key"])
    expect(scan(path.join(dir, VECTORS))).toEqual(["generic-api-key"])
  })

  it("still reports another rule in that file", () => {
    plantInVectors(`const value = "${fakeToken()}"`)
    expect(scan(VECTORS)).toEqual(["github-pat"])
  })

  it("still reports a vector value in any other file", () => {
    const secret = source().match(/masterSecret: "([0-9a-f]{64})"/)?.[1]
    expect(secret).toBeTruthy()
    writeFileSync(path.join(dir, "elsewhere.ts"), `const apiKey = "${secret}"\n`)
    expect(scan("elsewhere.ts")).toEqual(["generic-api-key"])
  })
})

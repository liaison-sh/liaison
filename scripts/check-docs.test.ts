// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  type CoverageInputs,
  checkCoverage,
  checkDiff,
  checkFreshness,
  checkNav,
  classifyFile,
  type DocsMapConfig,
  loadPageTexts,
  REAL_CONFIG,
} from "./check-docs"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "check-docs-"))
  dirs.push(d)
  return d
}

function write(root: string, rel: string, content = "x\n"): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function git(root: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, encoding: "utf8" },
  )
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout
}

const CFG: DocsMapConfig = {
  map: [
    { glob: "apps/api/src/lib/env.ts", pages: ["reference/env"] },
    { glob: "apps/api/src/apps/tickets/**", pages: ["apps/tickets"] },
  ],
  exempt: [{ glob: "**/*.test.ts", reason: "tests" }],
  failsafeRoots: ["apps/"],
}

/** A fixture repo: `main` with the base files, then branch `feat` checked out. */
function fixtureRepo(): string {
  const root = tempDir()
  git(root, "init", "-q", "-b", "main")
  write(root, "apps/api/src/apps/tickets/index.ts", "export {}\n")
  write(root, "apps/api/src/lib/env.ts", "export {}\n")
  write(root, "docs/apps/tickets.md", "# Tickets\n")
  write(root, "docs/reference/env.md", "# Env\n")
  write(root, "README.md", "hi\n")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "base")
  git(root, "checkout", "-q", "-b", "feat")
  return root
}

function commit(root: string, files: Record<string, string>, message = "change"): void {
  for (const [rel, content] of Object.entries(files)) write(root, rel, content)
  git(root, "add", ...Object.keys(files))
  git(root, "commit", "-q", "-m", message)
}

describe("diff rule", () => {
  it("fails a mapped change without its page, naming the file and the page", () => {
    const root = fixtureRepo()
    commit(root, { "apps/api/src/apps/tickets/index.ts": "export const a = 1\n" })
    const r = checkDiff({ root, base: "main", prBody: "", cfg: CFG })
    expect(r.ok).toBe(false)
    const out = r.problems.join("\n")
    expect(out).toContain("apps/api/src/apps/tickets/index.ts")
    expect(out).toContain("docs/apps/tickets.md")
    expect(out).toContain("Docs-skip:")
  })

  it("passes a mapped change that also changes its page", () => {
    const root = fixtureRepo()
    commit(root, {
      "apps/api/src/apps/tickets/index.ts": "export const a = 1\n",
      "docs/apps/tickets.md": "# Tickets\n\nMore.\n",
    })
    const r = checkDiff({ root, base: "main", prBody: "", cfg: CFG })
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
  })

  it("passes with a valid Docs-skip in the PR body and prints the reason", () => {
    const root = fixtureRepo()
    commit(root, { "apps/api/src/apps/tickets/index.ts": "export const a = 1\n" })
    const r = checkDiff({
      root,
      base: "main",
      prBody: "Summary\r\n\r\nDocs-skip: internal refactor, no behaviour change\r\n",
      cfg: CFG,
    })
    expect(r.ok).toBe(true)
    expect(r.notes.join("\n")).toContain("internal refactor, no behaviour change")
  })

  it("passes with a valid Docs-skip in a commit message of the range", () => {
    const root = fixtureRepo()
    commit(
      root,
      { "apps/api/src/apps/tickets/index.ts": "export const a = 1\n" },
      "refactor tickets\n\nDocs-skip: rename a private helper only",
    )
    const r = checkDiff({ root, base: "main", prBody: "", cfg: CFG })
    expect(r.ok).toBe(true)
    expect(r.notes.join("\n")).toContain("rename a private helper only")
  })

  it("rejects a Docs-skip whose reason is under 10 characters", () => {
    const root = fixtureRepo()
    commit(root, { "apps/api/src/apps/tickets/index.ts": "export const a = 1\n" })
    const r = checkDiff({ root, base: "main", prBody: "Docs-skip: n/a", cfg: CFG })
    expect(r.ok).toBe(false)
    expect(r.problems.join("\n")).toContain("at least 10 characters")
  })

  it("ignores an exempt test file", () => {
    const root = fixtureRepo()
    commit(root, { "apps/api/src/apps/tickets/index.test.ts": "test\n" })
    const r = checkDiff({ root, base: "main", prBody: "", cfg: CFG })
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
  })

  it("fails an unmapped file under a fail-safe root", () => {
    const root = fixtureRepo()
    commit(root, { "apps/api/src/new-module/thing.ts": "export {}\n" })
    const r = checkDiff({ root, base: "main", prBody: "", cfg: CFG })
    expect(r.ok).toBe(false)
    const out = r.problems.join("\n")
    expect(out).toContain("apps/api/src/new-module/thing.ts")
    expect(out).toContain("add it to .claude/docs-map.ts")
  })

  it("leaves an unmapped file outside the fail-safe roots alone", () => {
    const root = fixtureRepo()
    commit(root, { "README.md": "changed\n" })
    const r = checkDiff({ root, base: "main", prBody: "", cfg: CFG })
    expect(r.ok).toBe(true)
  })

  it("counts both sides of a rename", () => {
    const root = fixtureRepo()
    // Move a file out of the mapped tickets app: the old (mapped) side needs its page.
    mkdirSync(join(root, "lib"), { recursive: true })
    git(root, "mv", "apps/api/src/apps/tickets/index.ts", "lib/tickets-index.ts")
    git(root, "commit", "-q", "-m", "move")
    const r = checkDiff({ root, base: "main", prBody: "", cfg: CFG })
    expect(r.ok).toBe(false)
    expect(r.problems.join("\n")).toContain("apps/api/src/apps/tickets/index.ts")
  })

  it("does not count an unchanged generated page, fresh or not", () => {
    const root = fixtureRepo()
    commit(root, { "apps/api/src/lib/env.ts": "export const x = 1\n" })
    const r = checkDiff({ root, base: "main", prBody: "", cfg: CFG })
    expect(r.ok).toBe(false)
    expect(r.problems.join("\n")).toContain("docs/reference/env.md")
  })

  it("counts a generated page that changed in the range", () => {
    const root = fixtureRepo()
    commit(root, {
      "apps/api/src/lib/env.ts": "export const x = 1\n",
      "docs/reference/env.md": "# Env\n\nX\n",
    })
    const r = checkDiff({ root, base: "main", prBody: "", cfg: CFG })
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
  })

  it("a provisioner change needs provisioning-cli or a regenerated reference/config (real map)", () => {
    const root = fixtureRepo()
    commit(root, { "apps/api/src/cli/provisioners/mail.ts": "export const m = 1\n" })
    const bare = checkDiff({ root, base: "main", prBody: "", cfg: REAL_CONFIG })
    expect(bare.ok).toBe(false)
    const out = bare.problems.join("\n")
    expect(out).toContain("apps/api/src/cli/provisioners/mail.ts changed")
    expect(out).toContain("docs/reference/config.md")
    expect(out).toContain("docs/provisioning-cli.md")
    commit(root, { "docs/reference/config.md": "# Config\n" })
    expect(checkDiff({ root, base: "main", prBody: "", cfg: REAL_CONFIG }).ok).toBe(true)
  })

  it("reads paths git would quote (a space and a non-ASCII character)", () => {
    const root = fixtureRepo()
    commit(root, { "apps/api/src/apps/tickets/my café.ts": "export {}\n" })
    const r = checkDiff({ root, base: "main", prBody: "", cfg: CFG })
    expect(r.ok).toBe(false)
    expect(r.problems.join("\n")).toContain(
      "apps/api/src/apps/tickets/my café.ts changed; update one of: docs/apps/tickets.md",
    )
  })

  it("skips with a notice when there is no base", () => {
    const root = fixtureRepo()
    commit(root, { "apps/api/src/apps/tickets/index.ts": "export const a = 1\n" })
    const r = checkDiff({ root, base: undefined, prBody: "", cfg: CFG })
    expect(r.ok).toBe(true)
    expect(r.skipped).toBe(true)
  })
})

describe("docs map (real)", () => {
  it("maps apps/api/src/lib/env.ts to reference/env (not swallowed by the lib exempt)", () => {
    const c = classifyFile("apps/api/src/lib/env.ts", REAL_CONFIG)
    expect(c.kind).toBe("mapped")
    expect(c.kind === "mapped" && c.pages).toContain("reference/env")
  })

  it("still exempts the other lib helpers", () => {
    for (const f of [
      "apps/api/src/lib/logger.ts",
      "apps/api/src/lib/edition.ts",
      "apps/api/src/lib/env-boolean.ts",
      "apps/api/src/lib/email/send.ts",
    ]) {
      expect(classifyFile(f, REAL_CONFIG).kind, f).toBe("exempt")
    }
  })
})

const LANDING = { id: "index", url: "" }
const PAGE = (title: string, body = "Body.\n") =>
  `---\ntitle: ${title}\ndescription: ${title} page.\n---\n\n${body}`

function navFixture(): string {
  const root = tempDir()
  write(root, "docs/index.md", PAGE("Home", "See [Tickets](apps/tickets.md).\n"))
  write(root, "docs/apps/tickets.md", PAGE("Run tickets"))
  write(root, "docs/.sources/apps/tickets.txt", "claim -> file:1\n")
  write(root, "docs/runbooks/rotate.md", PAGE("Rotate"))
  write(root, "docs/reference/env.md", PAGE("Env"))
  return root
}
const NAV = [
  {
    title: "Apps",
    pages: [
      { id: "apps/tickets", url: "apps/tickets" },
      { id: "reference/env", url: "reference/env" },
    ],
  },
]
const NAV_CFG: DocsMapConfig = { ...CFG, map: [{ glob: "x/**", pages: ["apps/tickets"] }] }

describe("nav integrity", () => {
  it("passes a consistent fixture (runbooks outside the nav are fine)", async () => {
    const r = await checkNav({
      root: navFixture(),
      nav: { landing: LANDING, sections: NAV },
      cfg: NAV_CFG,
    })
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
  })

  it("fails a nav page without a file", async () => {
    const root = navFixture()
    const nav = [
      { title: "Apps", pages: [...NAV[0]!.pages, { id: "apps/ghost", url: "apps/ghost" }] },
    ]
    const r = await checkNav({ root, nav: { landing: LANDING, sections: nav }, cfg: NAV_CFG })
    expect(r.ok).toBe(false)
    expect(r.problems.join("\n")).toContain("docs/apps/ghost.md")
  })

  it("fails a docs page that is not in the nav", async () => {
    const root = navFixture()
    write(root, "docs/apps/orphan.md", PAGE("Orphan"))
    const r = await checkNav({ root, nav: { landing: LANDING, sections: NAV }, cfg: NAV_CFG })
    expect(r.ok).toBe(false)
    expect(r.problems.join("\n")).toContain("docs/apps/orphan.md")
  })

  it("fails a docs-map page id missing from the nav", async () => {
    const cfg = { ...NAV_CFG, map: [{ glob: "x/**", pages: ["apps/nope"] }] }
    const r = await checkNav({ root: navFixture(), nav: { landing: LANDING, sections: NAV }, cfg })
    expect(r.ok).toBe(false)
    expect(r.problems.join("\n")).toContain("apps/nope")
  })

  it("fails a broken link (the build runs without smoke flags)", async () => {
    const root = navFixture()
    write(root, "docs/apps/tickets.md", PAGE("Run tickets", "See [gone](gone.md).\n"))
    const r = await checkNav({ root, nav: { landing: LANDING, sections: NAV }, cfg: NAV_CFG })
    expect(r.ok).toBe(false)
    expect(r.problems.join("\n")).toContain("gone.md")
  })

  it("fails an authored page without its sources sidecar", async () => {
    const root = navFixture()
    rmSync(join(root, "docs/.sources/apps/tickets.txt"))
    const r = await checkNav({ root, nav: { landing: LANDING, sections: NAV }, cfg: NAV_CFG })
    expect(r.ok).toBe(false)
    expect(r.problems.join("\n")).toContain("docs/.sources/apps/tickets.txt")
  })
})

describe("coverage", () => {
  const inputs = (): CoverageInputs => ({
    apps: [{ dir: "apps/api/src/apps/tickets", page: "apps/tickets" }],
    cliCommands: ["config apply"],
    envVars: ["DATABASE_URL", "SMTP_HOST"],
    settingsKeys: ["tickets.autoAssign"],
    scopes: ["tickets:read"],
  })

  function coverageFixture(
    envText: string,
    handText = "Run `liaison config apply`. Use `tickets.autoAssign` and `tickets:read`.\n",
  ): Map<string, string> {
    const root = tempDir()
    write(root, "docs/apps/tickets.md", handText)
    write(root, "docs/reference/env.md", envText)
    write(
      root,
      "docs/reference/cli.md",
      "`liaison config apply`\n`tickets.autoAssign` `tickets:read` DATABASE_URL SMTP_HOST\n",
    )
    return loadPageTexts(join(root, "docs"), {
      landing: LANDING,
      sections: [
        {
          title: "x",
          pages: [
            { id: "apps/tickets", url: "a" },
            { id: "reference/env", url: "b" },
            { id: "reference/cli", url: "c" },
          ],
        },
      ],
    })
  }

  it("passes when every item is mentioned", () => {
    const r = checkCoverage(inputs(), coverageFixture("DATABASE_URL SMTP_HOST\n"))
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.summary).toContain("env vars: 2/2 in the generated reference")
  })

  it("fails and names a missing env var", () => {
    const r = checkCoverage(inputs(), coverageFixture("DATABASE_URL only\n"))
    expect(r.ok).toBe(false)
    const out = r.problems.join("\n")
    expect(out).toContain("SMTP_HOST")
    expect(out).not.toContain("DATABASE_URL")
  })

  it("fails a CLI command only the generated reference lists", () => {
    const r = checkCoverage(
      inputs(),
      coverageFixture("DATABASE_URL SMTP_HOST\n", "Use `tickets.autoAssign` and `tickets:read`.\n"),
    )
    expect(r.ok).toBe(false)
    const out = r.problems.join("\n")
    expect(out).toContain("CLI commands not mentioned in any hand-written page (1):")
    expect(out).toContain("config apply")
  })

  it("fails a settings key or scope only a generated reference lists", () => {
    const r = checkCoverage(
      inputs(),
      coverageFixture("DATABASE_URL SMTP_HOST\n", "Run `liaison config apply`.\n"),
    )
    expect(r.ok).toBe(false)
    const out = r.problems.join("\n")
    expect(out).toContain("tickets.autoAssign")
    expect(out).toContain("tickets:read")
  })

  it("fails a group that collected nothing (a broken extractor)", () => {
    for (const key of ["cliCommands", "envVars", "settingsKeys", "scopes"] as const) {
      const i = inputs()
      i[key] = []
      const r = checkCoverage(i, coverageFixture("DATABASE_URL SMTP_HOST\n"))
      expect(r.ok, key).toBe(false)
      expect(r.problems.join("\n"), key).toContain("collected 0")
      expect(r.problems.join("\n"), key).toContain("the extractor is broken")
    }
    const i = inputs()
    i.apps = []
    expect(
      checkCoverage(i, coverageFixture("DATABASE_URL SMTP_HOST\n")).problems.join("\n"),
    ).toContain("collected 0 apps: the extractor is broken")
  })

  it("fails an app whose page does not exist", () => {
    const i = inputs()
    i.apps.push({ dir: "bundled-apps/boxtal", page: "apps/boxtal" })
    i.apps.push({ dir: "bundled-apps/unmapped", page: undefined })
    const r = checkCoverage(i, coverageFixture("DATABASE_URL SMTP_HOST\n"))
    expect(r.ok).toBe(false)
    const out = r.problems.join("\n")
    expect(out).toContain("bundled-apps/boxtal")
    expect(out).toContain("bundled-apps/unmapped")
  })
})

describe("freshness", () => {
  it("fails a stale generated page, naming it and the fix", () => {
    const root = tempDir()
    write(root, "docs/reference/env.md", "old\n")
    write(root, "docs/reference/cli.md", "same\n")
    const gen = () =>
      new Map([
        ["docs/reference/env.md", "new\n"],
        ["docs/reference/cli.md", "same\n"],
      ])
    const r = checkFreshness(root, gen)
    expect(r.ok).toBe(false)
    const out = r.problems.join("\n")
    expect(out).toContain("docs/reference/env.md")
    expect(out).not.toContain("docs/reference/cli.md")
    expect(out).toContain("bun run docs:gen")
  })

  it("passes when every generated page matches", () => {
    const root = tempDir()
    write(root, "docs/reference/env.md", "same\n")
    const r = checkFreshness(root, () => new Map([["docs/reference/env.md", "same\n"]]))
    expect(r.ok).toBe(true)
  })
})

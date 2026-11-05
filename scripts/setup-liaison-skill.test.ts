// SPDX-License-Identifier: FSL-1.1-ALv2
// The setup skill's teach mode (S25): it asks once, starts tours through the
// CLI in the app container, documents the exit codes, and names only tours
// that ship (a renamed tour fails here instead of a setup run).
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { TOURS } from "../packages/shared/src/tours/index"

const ROOT = join(import.meta.dir, "..")
const SKILL = join(ROOT, ".claude/skills/setup-liaison/SKILL.md")
const text = readFileSync(SKILL, "utf8")

describe("setup-liaison skill", () => {
  it("has the frontmatter the skill loader needs", () => {
    expect(text).toMatch(/^---\nname: setup-liaison\ndescription: \S/)
  })

  it("asks the teach-mode question once, in the interview", () => {
    const step1 = text.slice(text.indexOf("## Step 1."), text.indexOf("## Step 2."))
    expect(step1).toContain(
      "Do you want me to show you how each part works as I set it up? I'll open\n   a short guided tour in your browser after each step.",
    )
    expect(text.split("Do you want me to show you how each part works").length - 1).toBe(1)
  })

  it("starts a tour with the CLI inside the app container and documents its outcomes", () => {
    const teach = text.slice(text.indexOf("## Teach mode"), text.indexOf("## Step 8."))
    expect(teach).toContain("exec -T app")
    expect(teach).toMatch(/liaison tour start \S+ --user \S+/)
    expect(teach).toContain("deep link")
    for (const code of [
      "`0` completed",
      "`3` abandoned",
      "`4` timeout",
      "`2` is a usage problem",
    ]) {
      expect(teach).toContain(code)
    }
    expect(teach).toContain("skip")
  })

  it("maps every element step 5 configures to a shipped tour", () => {
    const step5 = text.slice(text.indexOf("## Step 5."), text.indexOf("## Step 6."))
    for (const id of [
      "tickets.basics",
      "mail.basics",
      "knowledge.basics",
      "kernel.agents",
      "kernel.routines",
      "api-connector.settings",
    ]) {
      expect(step5).toContain(`\`${id}\``)
    }
  })

  it("names only tours that ship", () => {
    const shipped = new Set(TOURS.map((t) => t.id))
    const named = new Set<string>()
    // The teach-mode section, and the tour column of step 5's table.
    const teach = text.slice(text.indexOf("## Teach mode"), text.indexOf("## Step 8."))
    for (const m of teach.matchAll(/`([a-z0-9-]+\.[a-z0-9-]+)`/g)) named.add(m[1] ?? "")
    for (const m of text.matchAll(/\| `([a-z0-9-]+\.[a-z0-9-]+)` \|$/gm)) named.add(m[1] ?? "")
    expect(named.size).toBeGreaterThanOrEqual(9)
    for (const id of named) expect({ id, shipped: shipped.has(id) }).toEqual({ id, shipped: true })
  })

  it("every repo path the skill cites exists", () => {
    const cited = new Set<string>()
    for (const m of text.matchAll(
      /`((?:apps|packages|docs|scripts|deploy|\.claude)\/[A-Za-z0-9_./-]+)`/g,
    )) {
      const path = (m[1] ?? "").replace(/\/$/, "")
      // deploy/setup/, the secrets file and deploy/backups/ (where backup.sh
      // writes) are created by the run itself.
      if (
        path.startsWith("deploy/setup") ||
        path.startsWith("deploy/.") ||
        path.startsWith("deploy/backups")
      )
        continue
      cited.add(path)
    }
    expect(cited.size).toBeGreaterThan(2)
    for (const path of cited)
      expect({ path, exists: existsSync(join(ROOT, path)) }).toEqual({ path, exists: true })
  })
})

// The onboarding shape (owner, live install 2026-10-31), in BOTH flows: the
// coding agent's skill and the in-product setup agent's prompt. A rewrite that
// drops one of these rules fails here instead of in the next install.
describe("onboarding shape, skill and in-product agent", () => {
  const PROMPT = readFileSync(
    join(ROOT, "apps/api/src/modules/agent/prompts/kernel/setup-guide.md"),
    "utf8",
  )
  const flat = (s: string) => s.replace(/\s+/g, " ").toLowerCase()
  const both: Array<[string, string]> = [
    ["skill", flat(text)],
    ["in-product prompt", flat(PROMPT)],
  ]
  const BOTH_RULES: Array<[string, RegExp]> = [
    ["asks which features first", /which features (the person|they|do you) want/],
    ["one human action per message", /one human action per message/],
    // The instruction itself, not the word: "come back any time" alone must not pass.
    ["each step starts with its time", /start it with (the step's|its) time/],
    ["skip and come back any time", /skip (it|this|any)[^.]*come back any time/],
    ["basics first: mail, Google sign-in, support inbox, imports", /basics first/],
    ["Jira and Freshdesk imports are in the basics", /jira[^.]*freshdesk/],
    ["advanced connectors only on request", /google ads[^.]*only when the (owner|person) asks/],
    ["a menu after the basics, each item with its time", /menu[^.]*(time|minutes)/],
    [
      "never a backlog list",
      /never (send a list of what the owner still owes|list what the person still)/,
    ],
    ["personal or shared, per mailbox and calendar", /personal or shared\?/],
    ["role addresses are the organization's", /support@/],
    ["screenshots of a named page", /screenshot/],
    ["third-party logins are run by the person", /shopify auth login/],
    ["what the config can write, the agent writes", /can write, you write/],
  ]
  for (const [name, rule] of BOTH_RULES) {
    it(`both carry: ${name}`, () => {
      for (const [where, body] of both)
        expect({ where, ok: rule.test(body) }).toEqual({ where, ok: true })
    })
  }

  it("the time and skip rules are checked apart: removing one sentence fails its rule only", () => {
    const rule = (name: string) => BOTH_RULES.find(([n]) => n === name)?.[1] as RegExp
    const time = rule("each step starts with its time")
    const skip = rule("skip and come back any time")
    for (const [where, body] of both) {
      const noTime = body.replace(/start it with (the step's|its) time[^.]*\./g, "")
      expect({ where, time: time.test(noTime), skip: skip.test(noTime) }).toEqual({
        where,
        time: false,
        skip: true,
      })
      const noSkip = body.replace(/skip (it|this|any)[^.]*come back any time/g, "")
      expect({ where, time: time.test(noSkip), skip: skip.test(noSkip) }).toEqual({
        where,
        time: true,
        skip: false,
      })
    }
  })

  it("the skill asks trial or server first, before any plan or question list", () => {
    const step0 = flat(text.slice(text.indexOf("## Step 0."), text.indexOf("## Step 1.")))
    expect(step0).toContain("try it on this machine, or set it up on a server?")
    expect(step0.indexOf("which features do you want?")).toBeGreaterThan(-1)
    expect(step0.indexOf("try it on this machine")).toBeLessThan(
      step0.indexOf("| step | who | time |"),
    )
  })

  it("the skill reads credentials files by path and never drives another tool's login", () => {
    const t = flat(text)
    expect(t).toContain("download json")
    expect(t).toContain("downloaded file's path")
    expect(t).toMatch(/never drive another tool's login/)
  })

  it("the skill's Google default is one client with both redirect URIs, Internal checked first", () => {
    const t = flat(text)
    expect(t).toContain("one web client serves sign in with google and every google connection")
    expect(t).toContain("/api/auth/oauth/callback")
    expect(t).toContain("/api/connections/callback")
    expect(t).toContain("https://console.cloud.google.com/auth/audience")
  })

  it("the skill notes macOS openrsync and points docs links at the repository", () => {
    const t = flat(text)
    expect(t).toContain("openrsync")
    expect(t).not.toMatch(/rsync[^`]*--chmod/)
    expect(t).toContain("https://github.com/mathieufro/liaison/blob/main/docs/")
    expect(t).not.toMatch(/point the owner at the published pages on liaison\.sh\/docs/)
  })
})

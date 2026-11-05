// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Supply-chain guard for the public repo's CI: every third-party action is
// pinned by full commit SHA, every workflow declares a top-level
// `permissions:` block, the release workflow keeps tests and `bun install`
// out of the jobs that hold write/id-token permissions, no workflow pipes a
// remote script into a shell, and every job runs on a GitHub-hosted runner.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")
const WORKFLOW_DIR = join(ROOT, ".github/workflows")
const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml"))

type Job = {
  "runs-on"?: string
  uses?: string
  permissions?: Record<string, string>
  steps?: Array<{ uses?: string; run?: string }>
}
type Workflow = { permissions?: Record<string, string>; jobs: Record<string, Job> }

const load = (f: string): Workflow =>
  Bun.YAML.parse(readFileSync(join(WORKFLOW_DIR, f), "utf8")) as Workflow

describe("workflow hardening", () => {
  it("finds the workflows", () => {
    expect(files).toContain("release.yml")
  })

  for (const f of files) {
    const raw = readFileSync(join(WORKFLOW_DIR, f), "utf8")
    const wf = load(f)

    it(`${f}: every action is pinned by full commit SHA`, () => {
      const unpinned: string[] = []
      for (const job of Object.values(wf.jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.uses || step.uses.startsWith("./")) continue
          if (!/@[0-9a-f]{40}$/.test(step.uses)) unpinned.push(step.uses)
        }
      }
      expect(unpinned).toEqual([])
    })

    it(`${f}: pinned actions carry the tag as a comment`, () => {
      for (const line of raw.split("\n")) {
        if (/^\s*(-\s+)?uses:\s*\S+@[0-9a-f]{40}/.test(line)) expect(line).toMatch(/#\s*v?\S+/)
      }
    })

    it(`${f}: declares a top-level permissions block`, () => {
      expect(wf.permissions).toBeDefined()
    })

    it(`${f}: never pipes a remote script into a shell`, () => {
      expect(raw).not.toMatch(/curl[^\n|]*\|\s*(sudo\s+)?(ba)?sh/)
      expect(raw).not.toMatch(/wget[^\n|]*\|\s*(sudo\s+)?(ba)?sh/)
    })

    it(`${f}: every job runs on a GitHub-hosted runner`, () => {
      for (const [name, job] of Object.entries(wf.jobs)) {
        if (job.uses) continue
        expect(`${name}: ${job["runs-on"]}`).toMatch(/: ubuntu-[\w.-]+$/)
      }
    })
  }

  it("release.yml defaults to read-only permissions", () => {
    expect(load("release.yml").permissions).toEqual({ contents: "read" })
  })

  it("release.yml: no job with write or id-token runs tests or bun install", () => {
    const wf = load("release.yml")
    const offenders: string[] = []
    for (const [name, job] of Object.entries(wf.jobs)) {
      const perms = job.permissions ?? {}
      const privileged =
        perms["id-token"] === "write" ||
        perms.contents === "write" ||
        perms["pull-requests"] === "write"
      if (!privileged) continue
      for (const step of job.steps ?? []) {
        if (step.run && /bun (install|run test|run check|run typecheck)|bun test/.test(step.run)) {
          offenders.push(`${name}: ${step.run.split("\n")[0]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("release.yml: only the publish job holds id-token", () => {
    const wf = load("release.yml")
    const holders = Object.entries(wf.jobs)
      .filter(([, j]) => j.permissions?.["id-token"] === "write")
      .map(([n]) => n)
    expect(holders).toEqual(["publish"])
  })

  it("operator-drills.yml: installs act from a pinned, checksum-verified release", () => {
    const raw = readFileSync(join(WORKFLOW_DIR, "operator-drills.yml"), "utf8")
    expect(raw).toContain("sha256sum -c")
    expect(raw).toMatch(/ACT_SHA256="[0-9a-f]{64}"/)
    expect(raw).not.toContain("install.sh")
  })
})

describe("ignore files", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8").split("\n")

  it(".gitignore ignores .chaos directories at any depth", () => {
    const lines = read(".gitignore")
    expect(lines).toContain(".chaos/")
    expect(lines).toContain("**/.chaos/")
  })

  it(".dockerignore excludes nested env files but keeps .env.example", () => {
    const lines = read(".dockerignore")
    expect(lines).toContain("**/.env")
    expect(lines).toContain("**/.env.*")
    expect(lines).toContain("!**/.env.example")
    expect(lines).toContain("**/.chaos")
    expect(lines).toContain("dump.rdb")
  })
})

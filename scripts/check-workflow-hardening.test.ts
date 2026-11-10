// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Supply-chain guard for the public repo's CI: every third-party action is
// pinned by full commit SHA, every workflow declares a top-level
// `permissions:` block, the workflows that publish an image keep tests and
// `bun install` out of the jobs that hold write/id-token permissions, no
// workflow pipes a remote script into a shell, and every job runs on a
// GitHub-hosted runner. The local composite actions are held to the same pins.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")
const WORKFLOW_DIR = join(ROOT, ".github/workflows")
const ACTIONS_DIR = join(ROOT, ".github/actions")
const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml"))
const compositeActions = readdirSync(ACTIONS_DIR).map((d) => join(ACTIONS_DIR, d, "action.yml"))
/** The workflows that publish an image: each signs in one job, with nothing checked out. */
const PUBLISHING = ["release.yml", "nightly.yml"]

type Job = {
  "runs-on"?: string
  uses?: string
  permissions?: Record<string, string>
  steps?: Array<{ uses?: string; run?: string }>
}
type Workflow = {
  on?: Record<string, unknown>
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

const load = (f: string): Workflow =>
  Bun.YAML.parse(readFileSync(join(WORKFLOW_DIR, f), "utf8")) as Workflow

describe("workflow hardening", () => {
  it("finds the workflows", () => {
    expect(files).toContain("release.yml")
    expect(files).toContain("nightly.yml")
    expect(compositeActions.map((p) => p.split("/").at(-2))).toContain("build-image")
  })

  for (const path of compositeActions) {
    const name = path.split("/").at(-2)
    const raw = readFileSync(path, "utf8")
    const action = Bun.YAML.parse(raw) as {
      runs: { steps: Array<{ uses?: string; run?: string }> }
    }

    it(`${name}: every action is pinned by full commit SHA, with the tag as a comment`, () => {
      const uses = action.runs.steps.flatMap((s) => (s.uses ? [s.uses] : []))
      expect(uses.filter((u) => !/@[0-9a-f]{40}$/.test(u))).toEqual([])
      for (const line of raw.split("\n")) {
        if (/^\s*(-\s+)?uses:\s*\S+@[0-9a-f]{40}/.test(line)) expect(line).toMatch(/#\s*v?\S+/)
      }
    })

    it(`${name}: runs no tests and no bun install`, () => {
      const runs = action.runs.steps.flatMap((s) => (s.run ? [s.run] : []))
      expect(
        runs.filter((r) => /bun (install|run test|run check|run typecheck)|bun test/.test(r)),
      ).toEqual([])
    })
  }

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

  for (const f of PUBLISHING) {
    it(`${f} defaults to read-only permissions`, () => {
      expect(load(f).permissions).toEqual({ contents: "read" })
    })

    it(`${f}: no job with write or id-token runs tests or bun install`, () => {
      const wf = load(f)
      const offenders: string[] = []
      for (const [name, job] of Object.entries(wf.jobs)) {
        const perms = job.permissions ?? {}
        const privileged =
          perms["id-token"] === "write" ||
          perms.contents === "write" ||
          perms.packages === "write" ||
          perms["pull-requests"] === "write"
        if (!privileged) continue
        for (const step of job.steps ?? []) {
          if (
            step.run &&
            /bun (install|run test|run check|run typecheck)|bun test/.test(step.run)
          ) {
            offenders.push(`${name}: ${step.run.split("\n")[0]}`)
          }
        }
      }
      expect(offenders).toEqual([])
    })

    it(`${f}: only the publish job holds id-token, and it checks out and installs nothing`, () => {
      const wf = load(f)
      const holders = Object.entries(wf.jobs)
        .filter(([, j]) => j.permissions?.["id-token"] === "write")
        .map(([n]) => n)
      expect(holders).toEqual(["publish"])
      const uses = (wf.jobs.publish?.steps ?? []).flatMap((s) => (s.uses ? [s.uses] : []))
      expect(uses.filter((u) => u.startsWith("./") || u.startsWith("actions/checkout@"))).toEqual(
        [],
      )
      expect(uses.filter((u) => u.startsWith("oven-sh/setup-bun@"))).toEqual([])
    })

    it(`${f}: builds natively through the shared action, on amd64 and arm64 runners`, () => {
      const wf = load(f)
      for (const [job, runner] of [
        ["build-amd64", "ubuntu-latest"],
        ["build-arm64", "ubuntu-24.04-arm"],
      ] as const) {
        expect(wf.jobs[job]?.["runs-on"]).toBe(runner)
        const uses = (wf.jobs[job]?.steps ?? []).flatMap((s) => (s.uses ? [s.uses] : []))
        expect(uses).toContain("./.github/actions/build-image")
      }
    })
  }

  describe("nightly.yml", () => {
    const raw = readFileSync(join(WORKFLOW_DIR, "nightly.yml"), "utf8")
    const wf = load("nightly.yml")
    const allRuns = Object.values(wf.jobs)
      .flatMap((j) => j.steps ?? [])
      .flatMap((s) => (s.run ? [s.run] : []))
      .join("\n")

    it("runs on a daily schedule and by hand", () => {
      expect(Object.keys(wf.on ?? {}).sort()).toEqual(["schedule", "workflow_dispatch"])
      expect(raw).toMatch(/cron: "\d+ \d+ \* \* \*"/)
    })

    it("publishes only from main of this repository", () => {
      expect(raw).toContain(
        "if: github.repository == 'liaison-sh/liaison' && github.ref == 'refs/heads/main'",
      )
    })

    it("builds only a commit whose ci run on main is green", () => {
      expect(allRuns).toContain(
        "actions/workflows/ci.yml/runs?branch=main&event=push&status=success",
      )
    })

    it("never touches the release tags, and never marks a release as latest", () => {
      expect(raw).not.toMatch(/\$\{IMAGE\}:(latest|stable)|\$IMAGE:(latest|stable)/)
      expect(raw).not.toMatch(/liaison:(latest|stable)/)
      expect(allRuns).toContain("--prerelease")
      expect(allRuns).toContain("--latest=false")
    })

    it("signs before the rolling tag moves, and publishes the pre-release last", () => {
      const steps = (wf.jobs.publish?.steps ?? []).flatMap((s) => (s.run ? [s.run] : []))
      const at = (needle: string) => steps.findIndex((r) => r.includes(needle))
      expect(at("cosign sign --yes")).toBeGreaterThan(-1)
      expect(at(`"\${IMAGE}:nightly"`)).toBeGreaterThan(at("cosign sign --yes"))
      expect(at("gh release create")).toBeGreaterThan(at(`"\${IMAGE}:nightly"`))
    })

    it("keeps 14 nightlies, and prunes with a job that cannot sign or push", () => {
      expect((wf.jobs.prune as unknown as { env: Record<string, string> }).env.KEEP).toBe("14")
      expect(wf.jobs.prune?.permissions).toEqual({ contents: "write" })
    })

    it("the image reports nightly-YYYYMMDD-<shortsha>", () => {
      expect(allRuns).toContain('tag="nightly-$day"')
      expect(allRuns).toContain(`version="$tag-\${sha:0:7}"`)
      expect(raw).toContain(`version: \${{ needs.resolve.outputs.version }}`)
    })
  })

  it("the compose pin both publishing workflows rewrite is in the compose file", () => {
    const compose = readFileSync(join(ROOT, "deploy/docker-compose.yml"), "utf8")
    expect(compose).toContain(`\${LIAISON_IMAGE:-ghcr.io/mathieufro/liaison:v0.1.0}`)
    expect(compose).toContain(`\${LIAISON_RELEASE_CHANNEL:-release}`)
    for (const f of PUBLISHING) {
      expect(readFileSync(join(WORKFLOW_DIR, f), "utf8")).toContain("s#liaison:v0.1.0}#liaison:")
    }
    expect(readFileSync(join(WORKFLOW_DIR, "nightly.yml"), "utf8")).toContain(
      "s#LIAISON_RELEASE_CHANNEL:-release}#LIAISON_RELEASE_CHANNEL:-nightly}#",
    )
  })

  it("both publishing workflows ship .env.example, which upload-artifact would drop as hidden", () => {
    for (const f of PUBLISHING) {
      const raw = readFileSync(join(WORKFLOW_DIR, f), "utf8")
      expect(raw).toContain("include-hidden-files: true")
      expect(raw).toContain("deploy/.env.example")
    }
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

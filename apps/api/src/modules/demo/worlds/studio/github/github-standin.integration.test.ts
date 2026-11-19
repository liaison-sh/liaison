// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The services world's GitHub stand-in, on the real kernel, sandbox egress and Postgres.
//
// The GitHub app's reads run through the real egress bridge (`createEgressMethods`), and once
// through the whole tool path (executeTool, the sandbox, the bridge). A recorder sits where the
// transport is: anything it did not see never left the box. The world's connection is the one
// the seed layer installs (`installDemoGithubConnection`), dated from a fixed anchor.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { keptProofUrl, repoHostsOf } from "~/apps/projects/service/reconcile-lines"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { connectedAccounts } from "~/db/schema/kernel"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { envelopeError, SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { DemoRestrictionError } from "~/modules/demo/demo-egress"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import type { FetchAnswer, GithubCtx } from "../../../../../../../../bundled-apps/github/src/client"
import {
  FINE_GRAINED_WARNING,
  verifyGithub,
} from "../../../../../../../../bundled-apps/github/src/provisioning"
import { githubListCommits } from "../../../../../../../../bundled-apps/github/src/tools"
import { demoGithubCredentials, installDemoGithubConnection } from "./connection"
import { maybeDemoGithubResponse } from "./provider"
import { buildStandInHistory } from "./fixture"
import { DEMO_GITHUB_OWNER, DEMO_GITHUB_SENTINEL_TOKEN, GITHUB_STANDIN_HOST } from "./sentinel"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..", "..", "..")
const MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, "bundled-apps", "github", "app.manifest.json"), "utf8"),
) as Record<string, unknown>
/** The board date of the services world, its seed's anchor here. */
const ANCHOR = new Date(Date.UTC(2026, 10, 9, 8, 30))
const REPO = `${DEMO_GITHUB_OWNER}/stock-data`
/** Last month, Paris time: the first of October to the first of November, both at midnight Paris. */
const OCTOBER = {
  since: new Date(Date.UTC(2026, 8, 30, 22)).toISOString(),
  until: new Date(Date.UTC(2026, 9, 31, 23) - 1000).toISOString(),
}

let worldOrg = ""
let worldAdmin = ""
let plainOrg = ""
let otherWorldOrg = ""
let defaultWorldOrg = ""
let onTheWire: string[] = []

function githubCtx(orgId: string, credentials: Record<string, string> | null): GithubCtx {
  const methods = createEgressMethods({
    orgId,
    userId: "00000000-0000-0000-0000-000000000001",
    appName: "github",
    actorType: "user",
    egress: async () => ({ allowedDomains: ["api.github.com"], manifest: MANIFEST }),
    callerScopes: [],
    inheritedActor: { actorType: "user" as const },
    manifest: MANIFEST,
    txDb: null,
    resolveCredentials: async () => {
      if (!credentials) throw new Error('No connected account for connection "github"')
      return credentials
    },
    requireCapability: () => {},
    errorEnvelope: (err: { code?: string; message?: string }) =>
      envelopeError(err?.code ?? "RPC_ERROR", err?.message ?? String(err)),
    bulkIteratorCursors: new Map(),
  } as unknown as BridgeContext) as unknown as {
    fetch: (url: string, opts: string) => Promise<string>
    connections_getSettings: (name: string) => Promise<string>
  }
  return {
    fetch: async (url, opts) =>
      JSON.parse(await methods.fetch(url, JSON.stringify(opts ?? {}))) as FetchAnswer,
    connections: { getSettings: (name: string) => methods.connections_getSettings(name) },
  }
}

type Listed = {
  commits?: Array<{ sha: string; title: string; date: string; url: string }>
  error?: { code: string; message: string }
}

const standIn = (orgId: string) => githubCtx(orgId, demoGithubCredentials())

function person(orgId: string, userId: string): UserContext {
  return { actorType: "user", userId, orgId, scopes: ["github:repo:read"], dimensionGrants: {} }
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  worldOrg = (await createTestOrg()).id
  worldAdmin = (await minimal.session(worldOrg, { role: "admin" })).userId
  plainOrg = (await ensureOrg({ slug: "github-standin-plain", name: "Plain Org" })).orgId
  otherWorldOrg = (await ensureOrg({ slug: "github-standin-other", name: "Other World" })).orgId
  await markOrgAsDemo(worldOrg, visitorMarker(24, new Date(), undefined, { worldId: "studio" }))
  await markOrgAsDemo(otherWorldOrg, visitorMarker(24, new Date(), undefined, { worldId: "saas" }))
  // A marker naming no world: the kernel reads it as the default world, never as this one.
  defaultWorldOrg = (await ensureOrg({ slug: "github-standin-default", name: "Default World" }))
    .orgId
  await markOrgAsDemo(defaultWorldOrg, visitorMarker(24))
  invalidateDemoMarker()
  await ensureAppsForOrg(worldOrg)
  await initSandboxPool()
  await initWorkerPool()
  const descriptor = {
    ...MANIFEST,
    trusted: false,
    _firstParty: true,
    _format: "manifest",
    _bundlePath: join(REPO_ROOT, "bundled-apps", "github", String(MANIFEST.version), "bundle.js"),
  }
  const { failedApps } = await registerApps([descriptor as never], worldOrg)
  expect(failedApps).toEqual([])
  await primeOrgApps(worldOrg, 0)
  await installDemoGithubConnection({
    orgId: worldOrg,
    createdByUserId: worldAdmin,
    anchor: ANCHOR,
  })
  SandboxBridgeTestAccess.setFetch((async (url: string | URL) => {
    onTheWire.push(String(url))
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch)
  SandboxBridgeTestAccess.setFetchInterceptsHost((hostname) => hostname === "api.github.com")
}, 300_000)

afterAll(async () => {
  SandboxBridgeTestAccess.setFetch(null)
  SandboxBridgeTestAccess.setFetchInterceptsHost(null)
  DemoModeTestAccess.set(null)
  forgetOrgApps(worldOrg)
  await withPrivilegedDb(worldOrg, "test-cleanup", (tx) =>
    tx.delete(connectedAccounts).where(eq(connectedAccounts.orgId, worldOrg)),
  )
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  await releaseTestLock()
})

afterEach(() => {
  onTheWire = []
  DemoModeTestAccess.set(null)
  invalidateDemoMarker()
})

describe("the services world's GitHub stand-in", () => {
  it("in a services demo workspace the commit list answers from the stand-in with links on the stand-in host", async () => {
    DemoModeTestAccess.set(true)
    const out = (await githubListCommits({ repo: REPO, ...OCTOBER }, standIn(worldOrg))) as Listed
    expect(out.error).toBeUndefined()
    expect(out.commits?.length).toBe(58)
    for (const c of out.commits ?? []) {
      expect(new URL(c.url).hostname).toBe(GITHUB_STANDIN_HOST)
    }
    expect(onTheWire).toEqual([])
  })

  it("a repository of another owner is refused and nothing leaves", async () => {
    DemoModeTestAccess.set(true)
    const byTool = (await githubListCommits(
      { repo: "someone-else/stock-data" },
      standIn(worldOrg),
    )) as Listed
    expect(byTool.error?.code).toBe("repo_outside_owner")
    const ctx = standIn(worldOrg)
    const direct = await ctx.fetch("https://api.github.com/repos/someone-else/site/commits", {
      auth: { connection: "github", scheme: "bearer", fields: ["token"] },
    })
    expect(direct.status).toBe(404)
    const unknown = await ctx.fetch(`https://api.github.com/repos/${DEMO_GITHUB_OWNER}/nothing`, {
      auth: { connection: "github", scheme: "bearer", fields: ["token"] },
    })
    expect(unknown.status).toBe(404)
    expect(onTheWire).toEqual([])
  })

  it("an organisation that is not a demo never reaches the stand-in", async () => {
    DemoModeTestAccess.set(true)
    const real = githubCtx(plainOrg, { token: "github_pat_realtoken", owner: DEMO_GITHUB_OWNER })
    const out = (await githubListCommits({ repo: REPO, ...OCTOBER }, real)) as Listed
    // Its request goes to GitHub as before (the recorder answers an empty list), never to the stand-in.
    expect(out.commits).toEqual([])
    expect(onTheWire.length).toBe(1)
    expect(onTheWire[0]).toContain(`/repos/${DEMO_GITHUB_OWNER}/stock-data/commits`)
  })

  it("the sentinel from a workspace that is not a demo is refused and never sent", async () => {
    for (const mode of [true, false]) {
      DemoModeTestAccess.set(mode)
      const out = (await githubListCommits({ repo: REPO }, standIn(plainOrg))) as Listed
      expect(out.commits).toBeUndefined()
      expect(out.error?.code).toBe("forbidden")
    }
    const raw = await standIn(plainOrg).fetch("https://api.github.com/user", {
      auth: { connection: "github", scheme: "bearer", fields: ["token"] },
    })
    expect(raw.status).toBe(403)
    expect(raw.body).toContain("demo fixture")
    expect(onTheWire).toEqual([])
  })

  it("a demo workspace of another world gets the not-connected answer", async () => {
    DemoModeTestAccess.set(true)
    const none = (await githubListCommits({ repo: REPO }, githubCtx(otherWorldOrg, null))) as Listed
    expect(none.error?.code).toBe("not_connected")
    const sentinel = (await githubListCommits({ repo: REPO }, standIn(otherWorldOrg))) as Listed
    expect(sentinel.error?.code).toBe("not_connected")
    const other = githubCtx(otherWorldOrg, { token: "github_pat_other", owner: DEMO_GITHUB_OWNER })
    expect(((await githubListCommits({ repo: REPO }, other)) as Listed).error?.code).toBe(
      "not_connected",
    )
    expect(onTheWire).toEqual([])
  })

  it("a demo workspace whose marker names no world is of the default world: the sentinel is refused in words before any answer", async () => {
    DemoModeTestAccess.set(true)
    const asked = maybeDemoGithubResponse({
      orgId: defaultWorldOrg,
      url: "https://api.github.com/user",
      method: "GET",
      headers: { authorization: `Bearer ${DEMO_GITHUB_SENTINEL_TOKEN}` },
    })
    await expect(asked).rejects.toBeInstanceOf(DemoRestrictionError)
    const sentinel = (await githubListCommits({ repo: REPO }, standIn(defaultWorldOrg))) as Listed
    expect(sentinel.commits).toBeUndefined()
    expect(onTheWire).toEqual([])
  })

  it("connecting a real token in a demo workspace is refused in words and stores nothing", async () => {
    DemoModeTestAccess.set(true)
    const attempt = withPrivilegedDb(worldOrg, "test-connect", (tx) =>
      createCredentialConnection(tx, worldOrg, worldAdmin, "github", "github", {
        identifier: "real",
        credentials: { token: "github_pat_realtoken", owner: DEMO_GITHUB_OWNER },
        ownerType: "org",
      }),
    )
    await expect(attempt).rejects.toBeInstanceOf(DemoRestrictionError)
    await expect(attempt).rejects.toThrow(/\S{10}/)
    const rows = await withPrivilegedDb(worldOrg, "test-read", (tx) =>
      tx
        .select({ identifier: connectedAccounts.identifier })
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.orgId, worldOrg), eq(connectedAccounts.appName, "github"))),
    )
    expect(rows).toEqual([{ identifier: "demo-github" }])
  })

  it("on a box not in demo mode the services workspace's commit list still answers from the stand-in and nothing leaves", async () => {
    DemoModeTestAccess.set(false)
    const out = (await githubListCommits({ repo: REPO, ...OCTOBER }, standIn(worldOrg))) as Listed
    expect(out.error).toBeUndefined()
    expect(out.commits?.length).toBe(58)
    expect(onTheWire).toEqual([])
  })

  it("a commit list for a window answers only that window's commits", async () => {
    DemoModeTestAccess.set(false)
    const since = Date.UTC(2026, 9, 12)
    const until = Date.UTC(2026, 9, 19)
    const out = (await githubListCommits(
      { repo: REPO, since: new Date(since).toISOString(), until: new Date(until).toISOString() },
      standIn(worldOrg),
    )) as Listed
    const expected = (buildStandInHistory(ANCHOR).commits.get("stock-data") ?? []).filter(
      (c) => c.date.getTime() >= since && c.date.getTime() <= until,
    )
    expect(expected.length).toBeGreaterThan(0)
    expect(out.commits?.map((c) => c.sha).sort()).toEqual(expected.map((c) => c.sha).sort())
    for (const c of out.commits ?? []) {
      expect(Date.parse(c.date)).toBeGreaterThanOrEqual(since)
      expect(Date.parse(c.date)).toBeLessThanOrEqual(until)
    }
    expect(onTheWire).toEqual([])
  })

  it("config verify of the services workspace's GitHub connection passes with the fine-grained warning", async () => {
    DemoModeTestAccess.set(true)
    const verdict = await verifyGithub({}, standIn(worldOrg))
    expect(verdict.problems).toEqual([])
    expect(verdict.ok).toBe(true)
    expect(verdict.identity).toContain(`@ ${DEMO_GITHUB_OWNER}`)
    expect(verdict.identity).toContain(FINE_GRAINED_WARNING)
    expect(onTheWire).toEqual([])
  })

  it("the commit list of the services repository for last month answers through the real tool path with fifty-eight commits naming eleven tasks", async () => {
    DemoModeTestAccess.set(true)
    const out = (await executeToolCore({
      toolName: "github:github_list",
      orgId: worldOrg,
      actor: person(worldOrg, worldAdmin),
      params: { kind: "commits", repo: REPO, ...OCTOBER },
      origin: "human-ui",
    } as never)) as { data?: Listed; error?: unknown }
    expect(out.error).toBeUndefined()
    const commits = out.data?.commits ?? []
    expect(commits.length).toBe(58)
    const keys = new Set(commits.flatMap((c) => c.title.match(/ALPINE-\d+/g) ?? []))
    expect(keys.size).toBe(11)
    expect(onTheWire).toEqual([])
  }, 120_000)

  it("a reconcile proposal holding a stand-in commit keeps the proof without a link", () => {
    const commit = buildStandInHistory(ANCHOR).commits.get("stock-data")?.[0]
    const url = `https://${GITHUB_STANDIN_HOST}/${REPO}/commit/${commit?.sha}`
    const hosts = repoHostsOf([{ provider: "github", repo: REPO }])
    expect(keptProofUrl({ kind: "commit", ref: commit?.sha ?? "", url } as never, hosts)).toBe(
      undefined,
    )
  })
})

describe("the stand-in token", () => {
  it("is not shaped like a GitHub token", () => {
    expect(DEMO_GITHUB_SENTINEL_TOKEN).not.toMatch(/^(gh[pousr]_|github_pat_)/)
  })
})

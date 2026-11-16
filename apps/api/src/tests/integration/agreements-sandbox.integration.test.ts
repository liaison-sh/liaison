// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agreements tools through the real path: the app registered from its manifest, its
// handlers run in the sandbox, its rows read under the caller's RLS. A person drafts and
// prices a proposal (the price comes back as a decimal string, never a bare number), an
// agent cannot reach the price tool, and an agreement closed to the organization is absent
// from another member's search.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { UserContext } from "~/db/rls"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const SCOPES = ["agreements:agreements:read", "agreements:agreements:write"]

let orgId = ""
let owner = ""
let other = ""

function person(userId: string): UserContext {
  return { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: {} }
}

function descriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "agreements", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(
      REPO_ROOT,
      "bundled-apps",
      "agreements",
      String(manifest.version),
      "bundle.js",
    ),
  }
}

type Out = { data?: Record<string, any>; error?: { code: string; message: string } }

async function call(userId: string, tool: string, params: unknown): Promise<Out> {
  return (await executeToolCore({
    toolName: `agreements:${tool}`,
    orgId,
    actor: person(userId),
    params,
    origin: "human-ui",
  } as never)) as Out
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  orgId = (await createTestOrg()).id
  owner = (await minimal.session(orgId, { role: "member" })).userId
  other = (await minimal.session(orgId, { role: "member" })).userId
  await ensureAppsForOrg(orgId)
  await initSandboxPool()
  await initWorkerPool()
  const { failedApps } = await registerApps([descriptor() as never], orgId)
  expect(failedApps).toEqual([])
  await primeOrgApps(orgId, 0)
}, 300_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("agreements through the sandbox", () => {
  it("a person drafts and prices a proposal; the price comes back as a decimal string", async () => {
    const created = await call(owner, "agreement_create", { kind: "proposal", title: "Website" })
    expect(created.error).toBeUndefined()
    const id = created.data?.agreement?.id as string
    expect(created.data?.agreement?.number).toMatch(/^PR-\d{4}-001$/)

    const unpriced = await call(owner, "agreement_prepare", { id })
    expect(JSON.stringify(unpriced)).toContain("PRICE_NOT_SET")

    const priced = await call(owner, "agreement_price_set", {
      id,
      price_minor: "900719925474099301",
      currency: "EUR",
    })
    expect(priced.error).toBeUndefined()
    const found = await call(owner, "agreements_search", {})
    const row = ((found.data?.items ?? []) as Array<Record<string, unknown>>).find(
      (r) => r.id === id,
    )
    expect(row?.price_minor).toBe("900719925474099301")
  }, 60_000)

  it("an agent acting for the person cannot reach the price tool", async () => {
    const created = await call(owner, "agreement_create", { kind: "proposal", title: "Retainer" })
    const id = created.data?.agreement?.id as string
    const out = (await executeToolCore({
      toolName: "agreements:agreement_price_set",
      orgId,
      actor: { actorType: "agent", orgId, agentId: owner, userId: owner, scopes: SCOPES } as never,
      params: { id, price_minor: "100", currency: "EUR" },
      origin: "in-app-agent",
    } as never)) as Out
    expect(out.error?.code).toBe("forbidden")
  }, 60_000)

  it("an agreement closed to the organization is absent from another member's search", async () => {
    const created = await call(owner, "agreement_create", {
      kind: "nda",
      title: "Closed NDA",
      org_access: "none",
    })
    expect(created.error).toBeUndefined()
    const id = created.data?.agreement?.id as string
    const mine = await call(owner, "agreements_search", {})
    expect(((mine.data?.items ?? []) as Array<{ id: string }>).some((r) => r.id === id)).toBe(true)
    const theirs = await call(other, "agreements_search", {})
    expect(Array.isArray(theirs.data?.items)).toBe(true)
    expect(((theirs.data?.items ?? []) as Array<{ id: string }>).some((r) => r.id === id)).toBe(
      false,
    )
    const read = await call(other, "agreement_get", { id })
    expect(JSON.stringify(read)).toContain("NOT_FOUND")
  }, 60_000)
})

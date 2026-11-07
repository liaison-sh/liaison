// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaisonTeam` section of `liaison config apply`: the two opt-ins (register,
// forward bug reports) go through the same service as Settings > System.
// Operator only; forwarding without registration is refused at plan time.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { validateConfig } from "~/cli/config/schema"
import { liaisonTeamProvisioner } from "~/cli/provisioners/liaison-team"
import { buildProvisionContext } from "~/cli/provisioners/types"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { resetOperatorOrgCache } from "~/modules/apps/operator-org"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { readIdentity } from "~/modules/liaison-team/identity"
import { readSharing } from "~/modules/liaison-team/settings"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const savedEndpoint = env.LIAISON_TEAM_ENDPOINT
const savedOperator = env.LIAISON_OPERATOR_ORG_ID
const setEndpoint = (v: string) => {
  ;(env as { LIAISON_TEAM_ENDPOINT: string }).LIAISON_TEAM_ENDPOINT = v
}
const setOperator = (v: string | undefined) => {
  ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = v
  resetOperatorOrgCache()
}

async function ctxFor(orgId: string, userId: string, toolPath = false) {
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
  ctx.orgId = orgId
  ctx.actor = { userId, scopes: ["*"], dimensionGrants: {} }
  ctx.toolPath = toolPath
  return ctx
}

const config = (liaisonTeam: unknown) => {
  const r = validateConfig({ org: { slug: "t", name: "T" }, liaisonTeam })
  if (!r.ok) throw new Error(r.message)
  return r.config
}

async function run(orgId: string, userId: string, liaisonTeam: unknown, toolPath = false) {
  const ctx = await ctxFor(orgId, userId, toolPath)
  const cfg = config(liaisonTeam)
  const plan = await liaisonTeamProvisioner.plan(ctx, cfg)
  const result = await liaisonTeamProvisioner.apply(ctx, plan, cfg)
  return { plan, result }
}

const identity = () => withSystemDb("test", (tx) => readIdentity(tx))
const sharing = () => withSystemDb("test", (tx) => readSharing(tx))

beforeAll(async () => {
  await acquireTestLock()
})
afterAll(async () => {
  setEndpoint(savedEndpoint)
  setOperator(savedOperator)
  _setEdition(null)
  DemoModeTestAccess.set(null)
  await releaseTestLock()
})
beforeEach(async () => {
  setEndpoint("http://127.0.0.1:9/hook")
  setOperator(undefined)
  _setEdition("self_hosted")
  DemoModeTestAccess.set(false)
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
})
afterEach(async () => {
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
})

describe("config apply: liaisonTeam", () => {
  // Discriminator: a provisioner that stores the flag without the service
  // leaves no identity and no queued register message.
  it("{register: true} registers through the service", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    const { result } = await run(admin.orgId, admin.userId, { register: true })
    expect(result.changed).toEqual(["liaisonTeam"])
    expect((await identity())?.state).toBe("pending")
    expect(await sharing()).toMatchObject({ register: true, forwardBugReports: false })
    const [row] = await sql`SELECT type, status FROM kernel.control_plane_outbox`
    expect(row).toMatchObject({ type: "register", status: "pending" })
  })

  it("forwardBugReports without register is refused at plan time with the message", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    const ctx = await ctxFor(admin.orgId, admin.userId)
    const cfg = config({ forwardBugReports: true })
    const err = await liaisonTeamProvisioner.plan(ctx, cfg).catch((e) => e)
    expect(String(err?.message)).toContain("turn on registration with the Liaison team")
    expect(await sharing()).toMatchObject({ decidedAt: null })
  })

  it("both on, then the same section again changes nothing", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    await run(admin.orgId, admin.userId, { register: true, forwardBugReports: true })
    expect(await sharing()).toMatchObject({ register: true, forwardBugReports: true })
    const again = await run(admin.orgId, admin.userId, { register: true, forwardBugReports: true })
    expect(again.result.unchanged).toEqual(["liaisonTeam"])
    expect(again.plan.changes).toBeUndefined()
    const rows = await sql`SELECT 1 FROM kernel.control_plane_outbox`
    expect(rows.length).toBe(1)
  })

  // Discriminator: "no" and "no" is an answer; it must be recorded (decidedAt)
  // so the setup item turns done, though nothing else changes.
  it("{register: false, forwardBugReports: false} records the answer", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    const { result } = await run(admin.orgId, admin.userId, {
      register: false,
      forwardBugReports: false,
    })
    expect(result.changed).toEqual(["liaisonTeam"])
    const s = await sharing()
    expect(s.decidedAt).not.toBeNull()
    expect(s).toMatchObject({ register: false, forwardBugReports: false })
    expect(await identity()).toBeNull()
  })

  it("is not available when the endpoint is disabled", async () => {
    setEndpoint("")
    const admin = await minimal.adminSession((await createTestOrg()).id)
    const err = await run(admin.orgId, admin.userId, { register: true }).catch((e) => e)
    expect(String(err?.message)).toContain("not available")
  })

  // Discriminator: R17, a demo visitor's admin must never opt the instance in.
  it("refuses an org that is not the instance operator's on a multi-tenant instance", async () => {
    const operator = await minimal.adminSession((await createTestOrg()).id)
    const OTHER = "00000000-0000-4000-8000-0000000bad03"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${OTHER}, 'Visitor', 'liaison-team-cfg-visitor')`
    try {
      DemoModeTestAccess.set(true)
      setOperator(operator.orgId)
      const err = await run(OTHER, operator.userId, { register: true }).catch((e) => e)
      expect(String(err?.message)).toContain("instance operator")
      expect(await identity()).toBeNull()
      await run(operator.orgId, operator.userId, { register: true })
      expect((await identity())?.state).toBe("pending")
    } finally {
      await sql`DELETE FROM kernel.organizations WHERE id = ${OTHER}`
    }
  })
})

describe("config apply: liaisonTeam in the managed edition", () => {
  // Discriminator: a provisioner that calls the service for a first answer
  // fails on a managed server, where the switches are fixed on.
  it("asking for sharing on is already true and queues nothing; asking for off is refused", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    _setEdition("managed")
    setOperator(admin.orgId)
    const { result } = await run(admin.orgId, admin.userId, {
      register: true,
      forwardBugReports: true,
    })
    expect(result.unchanged).toEqual(["liaisonTeam"])
    expect((await sql`SELECT 1 FROM kernel.control_plane_outbox`).length).toBe(0)
    const err = await run(admin.orgId, admin.userId, { register: false }).catch((e) => e)
    expect(String(err?.message)).toContain("managed edition")
    expect(await identity()).toBeNull()
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
// The end of a managed subscription on the cell (spec S26), driven by
// signed billing pushes against the real database:
//  - suspended within accessUntil: an admin's session keeps Billing, the
//    billing state and the exports; any other route, a member, an admin on a
//    cell host, the websocket ticket: 403 `org_suspended` {accessUntil, contact};
//  - past accessUntil, or closed: admins refused too, export included;
//  - sign-in (createSession): admins only while suspended, nobody once closed;
//  - websocket re-check fails and closes with the suspended code;
//  - signed Control calls pass: an `active` push via the cell host resumes it;
//  - an org webhook answers 200 and is dropped, a job is skipped (exempt ones
//    run), both resume after the `active` push;
//  - self-hosted with a stale suspended row: unaffected.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { deriveControlToCellKey, signControlRequest } from "@liaison/control-plane-contract/node"
import {
  ORG_SUSPENDED_CODE,
  ORG_SUSPENDED_WS_CLOSE,
  orgSuspendedErrorSchema,
} from "@liaison/shared"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { oauthProviders } from "~/db/schema/kernel"
import {
  JobsTestAccess,
  jobsSkippedOrgSuspendedCount,
  registerJobWorker,
  SUSPENDED_ORG_EXEMPT_JOBS,
} from "~/infra/jobs/jobs"
import { KERNEL_JOBS } from "~/infra/jobs/queue-classes"
import { _setEdition, customAppsEnabled } from "~/lib/edition"
import { env } from "~/lib/env"
import { webhookHandlers } from "~/modules/apps/app-registries"
import { createSession } from "~/modules/auth/auth"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { signAccessToken } from "~/modules/auth/jwt"
import { revokeSessions } from "~/modules/auth/session-revocation"
import { isWsAuthStillValid } from "~/modules/auth/ws-ticket"
import { clearOrgBillingStatusCache } from "~/modules/cloud/billing-status"
import { ORG_SUSPENDED_CLOSE, OrgSuspendedError, orgAccessOf } from "~/modules/cloud/suspension"
import {
  deleteIdentity,
  encryptInstanceKey,
  mintIdentity,
  writeIdentity,
} from "~/modules/liaison-team/identity"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { webhooksDroppedOrgSuspendedCount } from "~/modules/webhooks/routes"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const INSTANCE_KEY = "e5".repeat(32)
const CONTROL_KEY = deriveControlToCellKey(INSTANCE_KEY)
const TEMPLATE = "https://{slug}.cells.test"
const CELL = "https://cell-3-origin.cells.test"
const CONTACT = "billing@control.test"

const mutableEnv = env as { LIAISON_EDITION?: string; LIAISON_ORG_HOST_TEMPLATE?: string }
const savedEdition = mutableEnv.LIAISON_EDITION
const savedTemplate = mutableEnv.LIAISON_ORG_HOST_TEMPLATE

const nowSec = () => Math.floor(Date.now() / 1000)
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString()

async function signed(method: "POST" | "DELETE", path: string, body: unknown) {
  const raw = JSON.stringify(body)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...signControlRequest(CONTROL_KEY, {
      method,
      path,
      body: raw,
      messageId: randomUUID(),
      ts: nowSec(),
    }),
  }
  return app.request(`${CELL}${path}`, { method, headers, body: raw })
}

async function createOrg(slug: string) {
  const res = await signed("POST", "/api/cloud/orgs", {
    slug,
    name: `Org ${slug}`,
    ownerEmail: `owner@${slug}.test`,
    ownerName: "Owner",
    plan: "base",
    locale: "en",
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { orgId: string }).orgId
}

let version = 1
async function push(orgId: string, status: string, over: Record<string, unknown> = {}) {
  const res = await signed("POST", `/api/cloud/orgs/${orgId}/billing`, {
    orgId,
    version: version++,
    plan: "base",
    status,
    periodEnd: "2026-12-01T00:00:00.000Z",
    includedCredits: "100",
    caps: {},
    previewEndsAt: null,
    autoTopUp: { enabled: false, thresholdCredits: 10, amountCredits: 50 },
    billingContact: CONTACT,
    ...over,
  })
  expect(res.status).toBe(200)
  expect(((await res.json()) as { applied: boolean }).applied).toBe(true)
}

interface Org {
  id: string
  slug: string
  ownerId: string
  admin: string
  member: string
  memberId: string
  /** A second member, created before any suspension (a suspended org admits no new one). */
  spareMemberId: string
  origin: string
}

async function setUpOrg(slug: string): Promise<Org> {
  const id = await createOrg(slug)
  const [owner] = await sql`SELECT id FROM kernel.users WHERE org_id = ${id} LIMIT 1`
  const memberUser = await minimal.person(id, { role: "member" })
  const spare = await minimal.person(id, { role: "member" })
  return {
    id,
    slug,
    ownerId: owner.id as string,
    admin: await minimal.token(owner.id as string),
    member: await minimal.token(memberUser.id),
    memberId: memberUser.id,
    spareMemberId: spare.id,
    origin: `https://${slug}.cells.test`,
  }
}

const get = (origin: string, path: string, token: string) =>
  app.request(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}` } })

/** A token of the org's owner with extra claims (an agent's, a device-flow session's, a sid). */
async function ownerToken(
  org: Org,
  claims: { agentId?: string; restricted?: boolean; sid?: string },
) {
  const [u] =
    await sql`SELECT name, auth_version, permission_version FROM kernel.users WHERE id = ${org.ownerId}`
  const perms = await withPrivilegedDb(org.id, "test-suspension-token", (tx) =>
    loadEffectivePermissions(tx, org.ownerId, org.id),
  )
  return signAccessToken(
    {
      userId: org.ownerId,
      orgId: org.id,
      name: u.name as string,
      authVersion: u.auth_version as number,
      permissionVersion: u.permission_version as number,
      roles: perms.roles,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
      ...claims,
    },
    env.JWT_SECRET,
    900,
  )
}

async function expectSuspended(res: Response, accessUntil: string | null) {
  expect(res.status).toBe(403)
  const body = (await res.json()) as { error: unknown }
  const error = orgSuspendedErrorSchema.parse(body.error)
  expect(error.code).toBe(ORG_SUSPENDED_CODE)
  expect(error.contact).toBe(CONTACT)
  expect(error.accessUntil).toBe(accessUntil)
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`DELETE FROM kernel.cloud_request_outcomes`
  _setEdition(null)
  mutableEnv.LIAISON_EDITION = "managed"
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = TEMPLATE
  const identity = {
    ...mintIdentity(),
    keyCiphertext: encryptInstanceKey(INSTANCE_KEY),
    state: "registered" as const,
    registeredAt: new Date().toISOString(),
  }
  await withSystemDb("test-cloud-identity", (db) => writeIdentity(db, identity))
})

afterAll(async () => {
  mutableEnv.LIAISON_EDITION = savedEdition
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = savedTemplate
  _setEdition(null)
  clearOrgBillingStatusCache()
  await sql`DELETE FROM kernel.cloud_request_outcomes`
  await withSystemDb("test-cloud-identity", (db) => deleteIdentity(db))
  await releaseTestLock()
})

beforeEach(async () => {
  mutableEnv.LIAISON_EDITION = "managed"
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = TEMPLATE
  _setEdition(null)
  clearOrgBillingStatusCache()
  await clearRedisPatterns(["cloud:*", "ratelimit:*"])
})

afterEach(() => clearOrgBillingStatusCache())

describe("orgAccessOf", () => {
  const s = (status: string, accessUntil: string | null = null) => ({
    status: status as "active",
    accessUntil,
    closedAt: null,
    contact: null,
  })
  test("statuses and the access window", () => {
    expect(orgAccessOf(null)).toBe("served")
    expect(orgAccessOf(s("active"))).toBe("served")
    expect(orgAccessOf(s("past_due"))).toBe("served")
    expect(orgAccessOf(s("suspended", inDays(3)))).toBe("admins")
    expect(orgAccessOf(s("suspended", null))).toBe("admins")
    expect(orgAccessOf(s("suspended", inDays(-1)))).toBe("refused")
    expect(orgAccessOf(s("closed"))).toBe("refused")
  })
  test("the websocket close is the shared suspended code", () => {
    expect(ORG_SUSPENDED_CLOSE).toEqual({
      code: ORG_SUSPENDED_WS_CLOSE,
      reason: ORG_SUSPENDED_CODE,
    })
  })
})

describe("suspended within accessUntil", () => {
  let org: Org
  const until = inDays(20)
  beforeAll(async () => {
    org = await setUpOrg("susp-window")
    await push(org.id, "suspended", { accessUntil: until })
  })

  test("admin keeps the billing state and the export list", async () => {
    expect((await get(org.origin, "/api/billing/state", org.admin)).status).toBe(200)
    expect((await get(org.origin, "/api/org/export", org.admin)).status).toBe(200)
  })

  test("admin on any other route: 403 with the contact and the window", async () => {
    await expectSuspended(await get(org.origin, "/api/threads", org.admin), until)
    await expectSuspended(await get(org.origin, "/api/users", org.admin), until)
  })

  test("a member is refused everywhere, Billing included", async () => {
    await expectSuspended(await get(org.origin, "/api/billing/state", org.member), until)
    await expectSuspended(await get(org.origin, "/api/threads", org.member), until)
  })

  test("an admin session on a cell host is refused", async () => {
    // The host routing refuses it before any credential is read (404
    // HOST_NOT_ORG); the gate would refuse it too (403) on a host the routing passed.
    const res = await get(CELL, "/api/billing/state", org.admin)
    expect([403, 404]).toContain(res.status)
  })

  test("no websocket: the ticket mint is refused and a live socket's re-check fails", async () => {
    const res = await app.request(`${org.origin}/api/auth/ws-ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${org.admin}` },
    })
    await expectSuspended(res, until)
    const [u] =
      await sql`SELECT auth_version, permission_version FROM kernel.users WHERE id = ${org.ownerId}`
    expect(
      await isWsAuthStillValid({
        userId: org.ownerId,
        orgId: org.id,
        authVersion: u.auth_version as number,
        permissionVersion: u.permission_version as number,
      }),
    ).toBe(false)
  })

  test("an admin-scoped agent token is refused on the admin paths", async () => {
    const token = await ownerToken(org, { agentId: randomUUID() })
    await expectSuspended(await get(org.origin, "/api/billing/managed/summary", token), until)
    await expectSuspended(await get(org.origin, "/api/org/export", token), until)
  })

  test("an admin's device-flow (restricted) session is refused on the admin paths", async () => {
    const token = await ownerToken(org, { restricted: true })
    await expectSuspended(await get(org.origin, "/api/billing/managed/summary", token), until)
    await expectSuspended(await get(org.origin, "/api/org/export", token), until)
  })

  test("a revoked session's token gets 401, not the suspension 403", async () => {
    const sid = randomUUID()
    const token = await ownerToken(org, { sid })
    revokeSessions([sid], "test")
    expect((await get(org.origin, "/api/threads", token)).status).toBe(401)
  })

  test("a deactivated user's token gets 401, not the suspension 403", async () => {
    const token = await minimal.token(org.spareMemberId)
    await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${org.spareMemberId}`
    invalidateAuthCache(org.spareMemberId)
    expect((await get(org.origin, "/api/threads", token)).status).toBe(401)
  })

  test("the public tickets routes refuse a ticket create and an upload", async () => {
    const create = await app.request(`/webhooks/${org.id}/tickets/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "Hi", fromEmail: "c@x.test", textBody: "hello" }),
    })
    await expectSuspended(create, until)
    const form = new FormData()
    form.append("file", new File(["x"], "a.txt", { type: "text/plain" }))
    const upload = await app.request(`/webhooks/${org.id}/tickets/attachments`, {
      method: "POST",
      body: form,
    })
    await expectSuspended(upload, until)
  })

  test("sign-in: the admin may, a member may not", async () => {
    const pair = await createSession(org.ownerId, org.id)
    expect(pair.accessToken.length).toBeGreaterThan(0)
    await expect(createSession(org.memberId, org.id)).rejects.toBeInstanceOf(OrgSuspendedError)
  })
})

describe("past accessUntil, then closed", () => {
  test("every credential refused, admin export included; nobody signs in", async () => {
    const org = await setUpOrg("susp-past")
    await push(org.id, "suspended", { accessUntil: inDays(-1) })
    await expectSuspended(await get(org.origin, "/api/org/export", org.admin), null)
    await expectSuspended(await get(org.origin, "/api/billing/state", org.admin), null)
    await expect(createSession(org.ownerId, org.id)).rejects.toBeInstanceOf(OrgSuspendedError)

    await push(org.id, "closed", { accessUntil: null, closedAt: new Date().toISOString() })
    await expectSuspended(await get(org.origin, "/api/org/export", org.admin), null)
    const create = await app.request(`/webhooks/${org.id}/tickets/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "Hi", fromEmail: "c@x.test", textBody: "hello" }),
    })
    await expectSuspended(create, null)
    await expect(createSession(org.ownerId, org.id)).rejects.toBeInstanceOf(OrgSuspendedError)
  })
})

describe("the login page of a managed workspace", () => {
  const onHost = (origin: string, path: string) =>
    app.request(`${origin}${path}`, { headers: { host: new URL(origin).host } })
  // A managed workspace offers its own apps unless LIAISON_CUSTOM_APPS turns them off.
  const closedEntryFlags = () => ({
    noAccountEntry: true,
    ...(customAppsEnabled() ? { customApps: true } : {}),
  })
  const flags = async (origin: string) =>
    (
      (await (await onHost(origin, "/api/settings/branding")).json()) as {
        data: { flags: unknown }
      }
    ).data.flags
  const providers = async (origin: string) =>
    ((await (await onHost(origin, "/api/auth/oauth/providers")).json()) as { data: unknown[] }).data
  async function withGoogle(slug: string): Promise<Org> {
    const org = await setUpOrg(slug)
    await withPrivilegedDb(org.id, "test-suspension-oauth-provider", (tx) =>
      tx.insert(oauthProviders).values({
        orgId: org.id,
        name: "Google",
        issuerUrl: "https://accounts.google.com",
        clientId: "cid",
        clientSecretEncrypted: "sealed",
        scopes: "{}",
      }),
    )
    return org
  }

  test("open, and suspended inside the admins' window: providers offered, account creation never", async () => {
    // A managed /register takes invitations only, and an invite link goes straight to it.
    const org = await withGoogle("login-open")
    expect(await flags(org.origin)).toEqual(closedEntryFlags())
    expect(await providers(org.origin)).toHaveLength(1)
    await push(org.id, "suspended", { accessUntil: inDays(5) })
    expect(await flags(org.origin)).toEqual(closedEntryFlags())
    expect(await providers(org.origin)).toHaveLength(1)
  })

  test("suspended past the window, and closed: no account creation, no provider sign-in", async () => {
    const org = await withGoogle("login-closed")
    await push(org.id, "suspended", { accessUntil: inDays(-1) })
    expect(await flags(org.origin)).toEqual(closedEntryFlags())
    expect(await providers(org.origin)).toEqual([])
    await push(org.id, "closed", { accessUntil: null, closedAt: new Date().toISOString() })
    expect(await flags(org.origin)).toEqual(closedEntryFlags())
    expect(await providers(org.origin)).toEqual([])
  })

  test("a host that names no org here (a retired workspace): the same", async () => {
    expect(await flags("https://no-such-workspace.cells.test")).toEqual(closedEntryFlags())
  })
})

describe("signed Control calls pass the gate", () => {
  test("an `active` push via the cell host resumes the org at once", async () => {
    const org = await setUpOrg("susp-resume")
    await push(org.id, "suspended", { accessUntil: inDays(10) })
    await expectSuspended(
      await get(org.origin, "/api/threads", org.member),
      await stateUntil(org.id),
    )
    await push(org.id, "active", { accessUntil: null })
    expect((await get(org.origin, "/api/billing/state", org.member)).status).toBe(200)
    expect((await get(org.origin, "/api/threads", org.member)).status).not.toBe(403)
  })
})

async function stateUntil(orgId: string): Promise<string | null> {
  const [r] = await sql`SELECT access_until FROM kernel.org_billing_state WHERE org_id = ${orgId}`
  return r?.access_until ? new Date(r.access_until as string).toISOString() : null
}

describe("webhooks of a suspended org", () => {
  test("answered 200 and dropped, processed again after resume; 410/drop when deleting unchanged", async () => {
    const org = await setUpOrg("susp-hooks")
    const handler = mock(async () => ({ status: 200 }))
    webhookHandlers.set([org.id, "kernel", "probe"], {
      appName: "kernel",
      orgId: org.id,
      verify: async () => ({ valid: true as const }),
      handler,
    } as never)
    const deliver = () =>
      app.request(`/webhooks/${org.id}/kernel/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    try {
      await push(org.id, "suspended", { accessUntil: inDays(10) })
      const before = webhooksDroppedOrgSuspendedCount(org.id)
      const dropped = await deliver()
      expect(dropped.status).toBe(200)
      expect(await dropped.json()).toEqual({ ok: true, dropped: ORG_SUSPENDED_CODE })
      expect(handler).not.toHaveBeenCalled()
      expect(webhooksDroppedOrgSuspendedCount(org.id)).toBe(before + 1)

      await push(org.id, "active", { accessUntil: null })
      const after = await deliver()
      const body = (await after.json().catch(() => ({}))) as { dropped?: string }
      expect(body.dropped).toBeUndefined()
      expect(webhooksDroppedOrgSuspendedCount(org.id)).toBe(before + 1)
    } finally {
      webhookHandlers.delete([org.id, "kernel", "probe"])
    }
  })
})

describe("jobs of a suspended org", () => {
  test("the exempt list names real kernel jobs, export and deletion included", () => {
    for (const name of SUSPENDED_ORG_EXEMPT_JOBS) expect(KERNEL_JOBS[name]).toBeDefined()
    expect(SUSPENDED_ORG_EXEMPT_JOBS.has("org-export")).toBe(true)
    expect(SUSPENDED_ORG_EXEMPT_JOBS.has("org-delete")).toBe(true)
    expect(SUSPENDED_ORG_EXEMPT_JOBS.has("routine-tick")).toBe(false)
  })

  test("a routine-like job is skipped while suspended and runs after resume; exempt jobs run", async () => {
    const org = await setUpOrg("susp-jobs")
    const tick = mock(async (_p: unknown) => {})
    const exempt = mock(async (_p: unknown) => {})
    registerJobWorker("kernel", "load-synthetic", tick, { txMode: "session" })
    registerJobWorker("kernel", "org-export-sweep", exempt, { txMode: "session" })

    await push(org.id, "suspended", { accessUntil: inDays(10) })
    const before = jobsSkippedOrgSuspendedCount()
    await JobsTestAccess.processJob("kernel", "load-synthetic", { orgId: org.id })
    expect(tick).not.toHaveBeenCalled()
    expect(jobsSkippedOrgSuspendedCount()).toBe(before + 1)
    await JobsTestAccess.processJob("kernel", "org-export-sweep", { orgId: org.id })
    expect(exempt).toHaveBeenCalledTimes(1)

    await push(org.id, "active", { accessUntil: null })
    await JobsTestAccess.processJob("kernel", "load-synthetic", { orgId: org.id })
    expect(tick).toHaveBeenCalledTimes(1)
  }, 60_000)
})

describe("self-hosted (S19)", () => {
  test("a stale suspended row changes nothing", async () => {
    const org = await setUpOrg("susp-selfhosted")
    await push(org.id, "closed", { closedAt: new Date().toISOString() })
    mutableEnv.LIAISON_EDITION = "self_hosted"
    _setEdition(null)
    clearOrgBillingStatusCache()
    expect((await get(org.origin, "/api/threads", org.member)).status).not.toBe(403)
    const pair = await createSession(org.ownerId, org.id)
    expect(pair.accessToken.length).toBeGreaterThan(0)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
// The org's own sender (S29), against the real database:
//  - `PUT /api/cloud/orgs/:id/mail-sender` signed as Control signs it stores
//    `settings.cloudSender {domain, fromAddress, version}` and the key encrypted
//    (never in clear in the row), and never touches `settings.email.from`;
//  - an older or equal version is not applied (`applied:false`, the held
//    version); `sender:null` clears the sender and the key, the version stays;
//    an unknown org → 404; GET /api/org never shows the key, admins included;
//  - the org-scoped sends: an invite of a verified org goes out with the org's
//    key and `"<Org>" <fromAddress>`; of an unverified managed org with
//    `"<Org> via Liaison" <notifications@<EMAIL_FROM host>>` on the global
//    transport; the attention digest and the CSAT survey follow the same rule;
//  - auth mail does not: a verified org's magic-link mail has From =
//    EMAIL_FROM (no email.from set) on the global system transport;
//  - self-hosted: the invite is sent exactly as before, whatever is stored.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { deriveControlToCellKey, signControlRequest } from "@liaison/control-plane-contract/node"
import { app } from "~/app"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as rawDb } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import {
  ConsoleEmailProvider,
  type EmailMessage,
  type EmailProvider,
  setEmailProvider,
  setOrgSenderProviderFactory,
  setSystemEmailProvider,
} from "~/infra/email"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { emailConnectLink } from "~/modules/apps/connections/connect-links"
import { requestMagicLink } from "~/modules/auth/magic-link"
import {
  deleteIdentity,
  encryptInstanceKey,
  mintIdentity,
  writeIdentity,
} from "~/modules/liaison-team/identity"
import { cellMailDomain, getOrgSenderTransport } from "~/modules/org/email-from"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { createInvitation } from "~/modules/users/invites"
import { seedRoleRow, seedUserRow } from "~/seed/factories/org/rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const INSTANCE_KEY = "c9".repeat(32)
const CONTROL_KEY = deriveControlToCellKey(INSTANCE_KEY)
const CELL = "https://cell-9-origin.cells.test"
const ORG_KEY = "re_test_domainkey_0123456789"

const mutableEnv = env as {
  LIAISON_EDITION?: string
  LIAISON_ORG_HOST_TEMPLATE?: string
  EMAIL_FROM: string
}
const saved = { ...mutableEnv }

async function put(orgId: string, body: unknown) {
  const path = `/api/cloud/orgs/${orgId}/mail-sender`
  const raw = JSON.stringify(body)
  const headers = {
    "Content-Type": "application/json",
    ...signControlRequest(CONTROL_KEY, {
      method: "PUT",
      path,
      body: raw,
      messageId: randomUUID(),
      ts: Math.floor(Date.now() / 1000),
    }),
  }
  return app.request(`${CELL}${path}`, { method: "PUT", headers, body: raw })
}

async function freshOrg(name = "Fabrikam Labs"): Promise<string> {
  const { orgId } = await ensureOrg({ slug: `sender-${randomUUID().slice(0, 12)}`, name })
  return orgId
}

async function settingsOf(orgId: string): Promise<Record<string, unknown>> {
  const [row] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${orgId}::uuid`
  const v = row?.settings ?? {}
  return (typeof v === "string" ? JSON.parse(v) : v) as Record<string, unknown>
}

const sender = (domain = "mail.fabrikam.example") => ({
  domain,
  fromAddress: `hello@${domain}`,
  key: ORG_KEY,
})

// createInvitation runs on an RlsClient; the privileged db with a no-op event
// queue stands in (as infra/email-from.test.ts does).
const rlsDb = rawDb as unknown as RlsClient
{
  const d = rlsDb as unknown as {
    queueEvent?: unknown
    transaction: (fn: unknown) => Promise<unknown>
  }
  d.queueEvent = async () => {}
  const orig = d.transaction.bind(d)
  d.transaction = async (fn: unknown) =>
    orig(async (tx: { queueEvent?: unknown }) => {
      tx.queueEvent = async () => {}
      return (fn as (t: unknown) => unknown)(tx)
    })
}

async function invite(orgId: string) {
  await seedRoleRow(orgId, "member")
  const inviter = {
    id: await seedUserRow({
      orgId,
      email: `inviter-${randomUUID().slice(0, 8)}@fabrikam.example`,
      name: "Inviter",
      status: "active",
    }),
  }
  const result = await createInvitation(rlsDb, {
    orgId,
    email: `invitee-${randomUUID().slice(0, 8)}@example.com`,
    roleName: "member",
    invitedBy: inviter.id,
    actorScopes: ["*"],
    actorDimensionGrants: {},
  })
  expect(result).toHaveProperty("inviteToken")
}

/** The org-key transports built, and what each sent. */
let orgProviders: { apiKey: string; from: string; sent: EmailMessage[] }[] = []
let system: ConsoleEmailProvider

beforeAll(async () => {
  await acquireTestLock()
  await sql`DELETE FROM kernel.cloud_request_outcomes`
  const identity = {
    ...mintIdentity(),
    keyCiphertext: encryptInstanceKey(INSTANCE_KEY),
    state: "registered" as const,
    registeredAt: new Date().toISOString(),
  }
  await withSystemDb("test-mail-sender-identity", (db) => writeIdentity(db, identity))
})

afterAll(async () => {
  Object.assign(mutableEnv, saved)
  _setEdition(null)
  setOrgSenderProviderFactory(null)
  setSystemEmailProvider(null)
  await sql`DELETE FROM kernel.cloud_request_outcomes`
  await withSystemDb("test-mail-sender-identity", (db) => deleteIdentity(db))
  await releaseTestLock()
})

beforeEach(async () => {
  mutableEnv.LIAISON_EDITION = "managed"
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = undefined
  mutableEnv.EMAIL_FROM = "Liaison <no-reply@cells.example>"
  _setEdition("managed")
  orgProviders = []
  setOrgSenderProviderFactory((cfg) => {
    const p = { ...cfg, sent: [] as EmailMessage[] }
    orgProviders.push(p)
    return {
      send: async (m) => {
        p.sent.push(m)
      },
      verify: async () => true,
    } satisfies EmailProvider
  })
  system = new ConsoleEmailProvider()
  setSystemEmailProvider(system)
  setEmailProvider(new ConsoleEmailProvider())
  await clearRedisPatterns(["cloud:*"])
})

afterEach(() => {
  setOrgSenderProviderFactory(null)
  setSystemEmailProvider(null)
})

describe("PUT /api/cloud/orgs/:id/mail-sender", () => {
  test("stores cloudSender and the encrypted key; email.from untouched", async () => {
    const orgId = await freshOrg()
    await sql`UPDATE kernel.organizations SET settings = COALESCE(settings, '{}'::jsonb) ||
      '{"email":{"from":"Support <support@self.example>"}}'::jsonb WHERE id = ${orgId}::uuid`
    const res = await put(orgId, { orgId, version: 3, sender: sender() })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, applied: true, version: 3 })

    const s = await settingsOf(orgId)
    expect(s.email).toEqual({ from: "Support <support@self.example>" })
    const cs = s.cloudSender as Record<string, unknown>
    expect(cs.domain).toBe("mail.fabrikam.example")
    expect(cs.fromAddress).toBe("hello@mail.fabrikam.example")
    expect(cs.version).toBe(3)
    expect(JSON.stringify(s)).not.toContain(ORG_KEY)
    expect(
      decryptSecret(String(cs.keyCiphertext), env.ENCRYPTION_KEY, CryptoContext.orgSettingsSecret),
    ).toBe(ORG_KEY)
  })

  test("versions are monotonic; null clears sender and key, keeps the version", async () => {
    const orgId = await freshOrg()
    expect(await (await put(orgId, { orgId, version: 5, sender: sender() })).json()).toEqual({
      ok: true,
      applied: true,
      version: 5,
    })
    for (const v of [5, 4]) {
      const stale = await put(orgId, { orgId, version: v, sender: sender("other.example") })
      expect(await stale.json()).toEqual({ ok: true, applied: false, version: 5 })
    }
    expect(((await settingsOf(orgId)).cloudSender as { domain: string }).domain).toBe(
      "mail.fabrikam.example",
    )
    const cleared = await put(orgId, { orgId, version: 6, sender: null })
    expect(await cleared.json()).toEqual({ ok: true, applied: true, version: 6 })
    expect((await settingsOf(orgId)).cloudSender).toEqual({ version: 6 })
    // A late push of the older sender does not come back.
    const late = await put(orgId, { orgId, version: 5, sender: sender() })
    expect(await late.json()).toEqual({ ok: true, applied: false, version: 6 })
    expect(await getOrgSenderTransport(orgId)).toMatchObject({ provider: null })
  })

  test("GET /api/org never serializes the key, not even to an admin", async () => {
    const a = await minimal.adminSession((await createTestOrg()).id)
    await put(a.orgId, { orgId: a.orgId, version: 1, sender: sender() })
    const res = await app.request("http://localhost/api/org", {
      headers: { Authorization: `Bearer ${a.bearer}` },
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("mail.fabrikam.example")
    expect(text).not.toContain("keyCiphertext")
    expect(text).not.toContain(ORG_KEY)
  })

  test("unknown org → 404", async () => {
    const orgId = randomUUID()
    const res = await put(orgId, { orgId, version: 1, sender: null })
    expect(res.status).toBe(404)
  })
})

describe("org-scoped mail uses the org sender; auth mail does not", () => {
  test("cell mail domain is the host part of EMAIL_FROM", () => {
    expect(cellMailDomain("Liaison <no-reply@cells.example>")).toBe("cells.example")
    expect(cellMailDomain("no-reply@Other.Example")).toBe("other.example")
  })

  test("verified org: the invite goes out with the org key and its own From", async () => {
    const orgId = await freshOrg("Fabrikam Labs")
    await put(orgId, { orgId, version: 1, sender: sender() })
    await invite(orgId)
    expect(system.sent).toHaveLength(0)
    expect(orgProviders).toHaveLength(1)
    const [p] = orgProviders as [(typeof orgProviders)[number]]
    expect(p.apiKey).toBe(ORG_KEY)
    expect(p.sent).toHaveLength(1)
    expect(p.sent[0]?.from).toBe('"Fabrikam Labs" <hello@mail.fabrikam.example>')
  })

  test("unverified managed org: the invite says 'via Liaison' on the global transport", async () => {
    const orgId = await freshOrg('Acme "Best" Co')
    await invite(orgId)
    expect(orgProviders).toHaveLength(0)
    expect(system.sent).toHaveLength(1)
    expect(system.sent[0]?.from).toBe(
      '"Acme \\"Best\\" Co via Liaison" <notifications@cells.example>',
    )
  })

  test("a connect link goes out like an invite: the org's sender, else 'via Liaison'", async () => {
    const link = (email: string) => ({
      url: "https://example.com/connect/link?t=x",
      token: "x",
      expiresAt: new Date(Date.now() + 10 * 60_000),
      user: { id: randomUUID(), email, name: "Member" },
    })
    const verified = await freshOrg("Linked Org")
    await put(verified, { orgId: verified, version: 1, sender: sender() })
    await emailConnectLink({
      orgId: verified,
      link: link("member@example.com"),
      appName: "mail",
      connectionName: "gmail",
      senderName: "Admin",
    })
    expect(system.sent).toHaveLength(0)
    expect(orgProviders).toHaveLength(1)
    expect(orgProviders[0]?.sent[0]?.from).toBe('"Linked Org" <hello@mail.fabrikam.example>')
    const plain = await freshOrg("Plain Link Org")
    await emailConnectLink({
      orgId: plain,
      link: link("other@example.com"),
      appName: "mail",
      connectionName: "gmail",
      senderName: null,
    })
    expect(system.sent).toHaveLength(1)
    expect(system.sent[0]?.from).toBe('"Plain Link Org via Liaison" <notifications@cells.example>')
  })

  test("the digest and CSAT transports follow the same resolution", async () => {
    const verified = await freshOrg("Verified Org")
    await put(verified, { orgId: verified, version: 1, sender: sender() })
    const t = await getOrgSenderTransport(verified)
    expect(t?.from).toBe('"Verified Org" <hello@mail.fabrikam.example>')
    expect(t?.provider).not.toBeNull()
    const plain = await freshOrg("Plain Org")
    expect(await getOrgSenderTransport(plain)).toEqual({
      from: '"Plain Org via Liaison" <notifications@cells.example>',
      provider: null,
    })
  })

  test("verified org: magic-link mail keeps EMAIL_FROM on the global system transport", async () => {
    const orgId = await freshOrg("Signin Org")
    await put(orgId, { orgId, version: 1, sender: sender() })
    const email = `signin-${randomUUID().slice(0, 8)}@example.com`
    await seedUserRow({ orgId, email, name: "Signin", status: "active" })
    const [org] = await sql`SELECT slug FROM kernel.organizations WHERE id = ${orgId}::uuid`
    await requestMagicLink(email, org.slug)
    for (let i = 0; i < 50 && system.sent.length === 0; i++) await Bun.sleep(20)
    expect(system.sent).toHaveLength(1)
    expect(system.sent[0]?.from).toBe(mutableEnv.EMAIL_FROM)
    expect(orgProviders.every((p) => p.sent.length === 0)).toBe(true)
  })

  test("self-hosted: the invite is sent as before, whatever is stored", async () => {
    const orgId = await freshOrg("Self Org")
    await put(orgId, { orgId, version: 1, sender: sender() })
    _setEdition("self_hosted")
    expect(await getOrgSenderTransport(orgId)).toBeNull()
    await invite(orgId)
    expect(orgProviders).toHaveLength(0)
    expect(system.sent).toHaveLength(1)
    expect(system.sent[0]?.from).toBe(mutableEnv.EMAIL_FROM)
  })
})

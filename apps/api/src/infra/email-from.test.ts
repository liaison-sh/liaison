// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB test for the per-org email-identity resolvers (Task 7) and their
 * threading into a transactional send.
 *
 * Assertions:
 * - `getOrgEmailFrom` returns the per-org `settings.email.from` when set, and
 *   falls back to the EXACT `env.EMAIL_FROM` string when absent;
 * - `getOrgEmailReplyTo` returns the per-org value when set, `undefined` when not;
 * - an invitation send for an org WITH `email.from`/`replyTo` records the override
 *   `from` AND `replyTo` on the ConsoleEmailProvider; an org WITHOUT records the
 *   env-default `from` and an undefined `replyTo`;
 * - a display name containing a SPACE round-trips through the setting unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as rawDb } from "~/db/connection"
import { ConsoleEmailProvider, setEmailProvider } from "~/infra/email"
import { env } from "~/lib/env"
import { getOrgEmailFrom, getOrgEmailReplyTo } from "~/modules/org/email-from"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { createInvitation } from "~/modules/users/invites"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

// A queueEvent-stubbed RlsClient for createInvitation (mirrors invites.test.ts):
// the privileged db is used directly with a no-op event queue + tx wrapper.
const rlsDb = rawDb as unknown as RlsClient
const events: unknown[] = []
function patchEvents(db: unknown): void {
  const d = db as { queueEvent?: unknown; transaction: (fn: unknown) => Promise<unknown> }
  d.queueEvent = async (e: unknown) => {
    events.push(e)
  }
  const orig = d.transaction.bind(d)
  d.transaction = async (fn: unknown) =>
    orig(async (tx: { queueEvent?: unknown }) => {
      tx.queueEvent = async (e: unknown) => {
        events.push(e)
      }
      return (fn as (t: unknown) => unknown)(tx)
    })
}
patchEvents(rlsDb)

async function freshOrg(): Promise<string> {
  const { orgId } = await ensureOrg({
    slug: `cli-emailfrom-${crypto.randomUUID().slice(0, 12)}`,
    name: "EmailFromOrg",
  })
  return orgId
}

/** Write settings.email via the same jsonb-merge shape the provisioner uses. */
async function setOrgEmail(
  orgId: string,
  email: { from?: string; replyTo?: string },
): Promise<void> {
  await sql`
    UPDATE kernel.organizations
    SET settings = COALESCE(settings, '{}'::jsonb) ||
      jsonb_build_object('email', ${JSON.stringify(email)}::jsonb)
    WHERE id = ${orgId}::uuid
  `
}

/** Seed a member role so createInvitation can resolve a target role by name. */
async function seedMemberRole(orgId: string): Promise<void> {
  await sql`
    INSERT INTO kernel.roles (org_id, name) VALUES (${orgId}, 'member')
    ON CONFLICT (org_id, name) DO NOTHING
  `
}

/** Create a real inviter user so the invitations FK (invited_by → users) holds. */
async function seedInviter(orgId: string): Promise<string> {
  const [row] = await sql`
    INSERT INTO kernel.users (org_id, email, name, status)
    VALUES (${orgId}, ${`inviter-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`}, 'Inviter', 'active')
    RETURNING id
  `
  return row.id
}

describe("getOrgEmailFrom / getOrgEmailReplyTo resolvers (Task 7)", () => {
  test("returns per-org settings.email.from when set", async () => {
    const orgId = await freshOrg()
    await setOrgEmail(orgId, { from: "Fabrikam Support <support@fabrikam.example>" })
    expect(await getOrgEmailFrom(orgId)).toBe("Fabrikam Support <support@fabrikam.example>")
  })

  test("falls back to the EXACT env.EMAIL_FROM when no per-org from is set", async () => {
    const orgId = await freshOrg()
    expect(await getOrgEmailFrom(orgId)).toBe(env.EMAIL_FROM)
  })

  test("returns per-org replyTo when set, undefined when absent", async () => {
    const withReply = await freshOrg()
    await setOrgEmail(withReply, { replyTo: "reply@fabrikam.example" })
    expect(await getOrgEmailReplyTo(withReply)).toBe("reply@fabrikam.example")

    const without = await freshOrg()
    expect(await getOrgEmailReplyTo(without)).toBeUndefined()
  })

  test("display name with a SPACE round-trips unchanged", async () => {
    const orgId = await freshOrg()
    const from = "Acme Widgets Co <noreply@acme.example>"
    await setOrgEmail(orgId, { from })
    expect(await getOrgEmailFrom(orgId)).toBe(from)
  })
})

describe("transactional send threads per-org from/replyTo (Task 7)", () => {
  test("an invite send records the override from AND replyTo when the org has them", async () => {
    const orgId = await freshOrg()
    await seedMemberRole(orgId)
    const inviterId = await seedInviter(orgId)
    const from = "Fabrikam <hello@fabrikam.example>"
    const replyTo = "support@fabrikam.example"
    await setOrgEmail(orgId, { from, replyTo })

    const provider = new ConsoleEmailProvider()
    setEmailProvider(provider)

    const result = await createInvitation(rlsDb, {
      orgId,
      email: `invitee-${crypto.randomUUID().slice(0, 8)}@example.com`,
      roleName: "member",
      invitedBy: inviterId,
      actorScopes: ["*"],
      actorDimensionGrants: {},
    })
    expect(result).toHaveProperty("inviteToken")
    expect(provider.sent.length).toBe(1)
    expect(provider.sent[0].from).toBe(from)
    expect(provider.sent[0].replyTo).toBe(replyTo)
  })

  test("an invite send for an org WITHOUT settings uses env.EMAIL_FROM and undefined replyTo", async () => {
    const orgId = await freshOrg()
    await seedMemberRole(orgId)
    const inviterId = await seedInviter(orgId)

    const provider = new ConsoleEmailProvider()
    setEmailProvider(provider)

    const result = await createInvitation(rlsDb, {
      orgId,
      email: `invitee-${crypto.randomUUID().slice(0, 8)}@example.com`,
      roleName: "member",
      invitedBy: inviterId,
      actorScopes: ["*"],
      actorDimensionGrants: {},
    })
    expect(result).toHaveProperty("inviteToken")
    expect(provider.sent.length).toBe(1)
    expect(provider.sent[0].from).toBe(env.EMAIL_FROM)
    expect(provider.sent[0].replyTo).toBeUndefined()
  })
})

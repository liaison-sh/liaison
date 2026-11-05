// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import {
  isMentionableAgent,
  listDirectoryAgents,
  listDmableAgents,
  listMentionableAgents,
} from "./listing"

const ORG = "00000000-0000-0000-0000-d00000000001"
const USER = "00000000-0000-0000-0000-d00000000002"
const OTHER_USER = "00000000-0000-0000-0000-d00000000006"

const BASE_AGENT = "00000000-0000-0000-0000-d00000000003"
const ROLE_AGENT = "00000000-0000-0000-0000-d00000000004"
const ARCHIVED_ROLE_AGENT = "00000000-0000-0000-0000-d00000000005"
const MY_PERSONAL_AGENT = "00000000-0000-0000-0000-d00000000007"
const THEIR_PERSONAL_AGENT = "00000000-0000-0000-0000-d00000000008"

function rlsCtx(userId: string, orgId: string): UserContext {
  return { actorType: "user", userId, orgId, scopes: [], dimensionGrants: {} }
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Agent Listing Org', 'agent-listing-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER}, ${ORG}, 'agent-listing-user@test.com', 'Agent Listing User', 'active', 1) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${OTHER_USER}, ${ORG}, 'agent-listing-other@test.com', 'Agent Listing Colleague', 'active', 1) ON CONFLICT DO NOTHING`

  await withPrivilegedDb(ORG, "test-seed", async (tx) => {
    await tx
      .insert(agents)
      .values({
        id: BASE_AGENT,
        orgId: ORG,
        kind: "system",
        handle: "@base",
        displayName: "Base",
      })
      .onConflictDoNothing()

    await tx
      .insert(agents)
      .values({
        id: ROLE_AGENT,
        orgId: ORG,
        kind: "role",
        handle: "support",
        displayName: "Support Agent",
      })
      .onConflictDoNothing()

    await tx
      .insert(agents)
      .values({
        id: ARCHIVED_ROLE_AGENT,
        orgId: ORG,
        kind: "role",
        handle: "retired-support",
        displayName: "Retired Support Agent",
        archivedAt: new Date(),
      })
      .onConflictDoNothing()

    await tx
      .insert(agents)
      .values({
        id: MY_PERSONAL_AGENT,
        orgId: ORG,
        kind: "personal",
        handle: "mine",
        displayName: "My Liaison",
        ownerUserId: USER,
      })
      .onConflictDoNothing()

    await tx
      .insert(agents)
      .values({
        id: THEIR_PERSONAL_AGENT,
        orgId: ORG,
        kind: "personal",
        handle: "theirs",
        displayName: "Their Liaison",
        ownerUserId: OTHER_USER,
      })
      .onConflictDoNothing()
  })
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("AGENT LISTING", () => {
  it("@base is absent from listDmableAgents", async () => {
    const unfiltered = await withRlsContext(rlsCtx(USER, ORG), async (tx) => {
      return tx.select().from(agents).where(eq(agents.orgId, ORG))
    })
    expect(unfiltered.map((a) => a.handle)).toContain("@base")

    const dmable = await listDmableAgents(ORG, USER)
    expect(dmable.map((a) => a.handle)).not.toContain("@base")

    const mentionable = await listMentionableAgents(ORG, USER)
    expect(mentionable.map((a) => a.handle)).not.toContain("@base")
  })

  // P4c FX-F3: the directory is the roster, not an addressing surface, so the
  // `kind='system'` row belongs on it for an admin (dimmed, no actions) and
  // for nobody else. Without this `/agents/@base` resolved to nothing.
  it("an admin's directory listing carries @base, a member's does not", async () => {
    const admin = await listDirectoryAgents(ORG, USER, { includeSystem: true })
    expect(admin.map((a) => a.handle)).toContain("@base")
    // Everything the member sees is still there.
    expect(admin.map((a) => a.handle)).toContain("support")
    expect(admin.map((a) => a.handle)).toContain("mine")
    // The admin flag widens nothing else: another colleague's Liaison and an
    // archived agent stay out.
    expect(admin.map((a) => a.handle)).not.toContain("theirs")
    expect(admin.map((a) => a.handle)).not.toContain("retired-support")

    const member = await listDirectoryAgents(ORG, USER)
    expect(member.map((a) => a.handle)).not.toContain("@base")
    expect(member.map((a) => a.handle)).toContain("support")
  })

  it("mention completion and the DM picker never carry @base", async () => {
    // Not even for the admin: `includeSystem` is the directory's flag and the
    // addressable listings have no such widening to offer.
    expect((await listMentionableAgents(ORG, USER)).map((a) => a.handle)).not.toContain("@base")
    expect((await listDmableAgents(ORG, USER)).map((a) => a.handle)).not.toContain("@base")
    expect(await isMentionableAgent(ORG, USER, BASE_AGENT)).toBe(false)
  })

  it("a role agent IS present in listDmableAgents", async () => {
    const dmable = await listDmableAgents(ORG, USER)
    expect(dmable.map((a) => a.handle)).toContain("support")

    const mentionable = await listMentionableAgents(ORG, USER)
    expect(mentionable.map((a) => a.handle)).toContain("support")
  })

  it("an archived agent is absent from listDmableAgents and listMentionableAgents", async () => {
    const unfiltered = await withRlsContext(rlsCtx(USER, ORG), async (tx) => {
      return tx.select().from(agents).where(eq(agents.orgId, ORG))
    })
    expect(unfiltered.map((a) => a.handle)).toContain("retired-support")

    const dmable = await listDmableAgents(ORG, USER)
    expect(dmable.map((a) => a.handle)).not.toContain("retired-support")

    const mentionable = await listMentionableAgents(ORG, USER)
    expect(mentionable.map((a) => a.handle)).not.toContain("retired-support")
  })

  // A41: a personal agent is one colleague's own Liaison. Nobody else may DM
  // it, mention it, or learn that it exists from these listings; an admin
  // reaches it through `kernel:agents:read` at the route, never here.
  it("a personal agent is listed for its owner and for nobody else", async () => {
    const unfiltered = await withRlsContext(rlsCtx(USER, ORG), async (tx) => {
      return tx.select().from(agents).where(eq(agents.orgId, ORG))
    })
    expect(unfiltered.map((a) => a.handle)).toContain("theirs")

    const dmable = await listDmableAgents(ORG, USER)
    expect(dmable.map((a) => a.handle)).toContain("mine")
    expect(dmable.map((a) => a.handle)).not.toContain("theirs")

    const mentionable = await listMentionableAgents(ORG, USER)
    expect(mentionable.map((a) => a.handle)).toContain("mine")
    expect(mentionable.map((a) => a.handle)).not.toContain("theirs")

    // The single-agent form cannot drift from the roster form.
    expect(await isMentionableAgent(ORG, USER, MY_PERSONAL_AGENT)).toBe(true)
    expect(await isMentionableAgent(ORG, USER, THEIR_PERSONAL_AGENT)).toBe(false)
    expect(await isMentionableAgent(ORG, OTHER_USER, THEIR_PERSONAL_AGENT)).toBe(true)
  })
})

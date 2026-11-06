// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `open_app` under real row security. Every view of the core apps and the kernel that names a
// record has a row here; a record view with none fails, so a new core tab cannot skip this.
// Bundled apps have no schema in the test database: their tabs are walked in
// `modules/agent/tools/open-targets.test.ts` and read through the same label reader.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { handleOpenApp } from "~/modules/agent/tools/navigation-tool"
import { openViewsOf } from "~/modules/agent/tools/open-targets"
import { listGatewayTools } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const sqlOne = drizzleSql`SELECT 1 AS one`
const uid = () => crypto.randomUUID()
const tag = () => crypto.randomUUID().slice(0, 8)

let orgId: string
let otherOrgId: string
let viewer: string
let stranger: string
let strangerElsewhere: string
let dmId: string
const ids = new Map<string, { id: string; label: string }>()

const everything = (userId: string, org = orgId): UserContext => ({
  actorType: "user",
  userId,
  orgId: org,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
})

/** The call as the tool runs it: the actor's RLS transaction, the record's org from the turn. */
function open(actor: UserContext, app: string, view: string, id: string, scopes = actor.scopes) {
  return withRlsContext(actor, (tx) =>
    handleOpenApp({ app, view, id }, { userId: actor.userId, orgId, db: tx, scopes }),
  )
}

async function seed(): Promise<void> {
  const put = (key: string, id: string, label: string) => ids.set(key, { id, label })

  const [channel] = await sql`
    INSERT INTO kernel.threads (org_id, handle, title, type, created_by, discoverable)
    VALUES (${orgId}, ${`ch-${tag()}`}, 'Support channel', 'thread', ${viewer}, true)
    RETURNING id`
  put("kernel:thread", channel.id, "Support channel")
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
            VALUES (${channel.id}, ${viewer}, ${orgId})`

  const [dm] = await sql`
    INSERT INTO kernel.threads (org_id, handle, title, type, created_by, discoverable)
    VALUES (${orgId}, ${`dm-${tag()}`}, 'Just us', 'thread', ${viewer}, false)
    RETURNING id`
  dmId = dm.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
            VALUES (${dmId}, ${viewer}, ${orgId})`

  const [routine] = await sql`
    INSERT INTO kernel.routines
      (org_id, owner_user_id, name, description, prompt, scopes, created_by_actor_type)
    VALUES (${orgId}, ${viewer}, 'Weekly digest', 'd', 'p', ARRAY[]::text[], 'user')
    RETURNING id`
  put("kernel:routine", routine.id, "Weekly digest")

  const [skill] = await sql`
    INSERT INTO kernel.skills (org_id, name, description, body, created_by_actor_type)
    VALUES (${orgId}, ${`refunds-${tag()}`}, 'd', 'b', 'user')
    RETURNING id, name`
  put("kernel:skill", skill.id, skill.name)

  const [agent] = await sql`
    INSERT INTO kernel.agents (org_id, kind, handle, display_name)
    VALUES (${orgId}, 'role', ${`finance-${tag()}`}, 'Finance desk')
    RETURNING id`
  put("kernel:agent", agent.id, "Finance desk")

  const [session] = await sql`
    INSERT INTO kernel.node_sessions
      (org_id, owner_user_id, agent_id, source, config_kind, title, prompt, model, level)
    VALUES (${orgId}, ${viewer}, ${agent.id}, 'app', 'owner', 'Fix the build', 'p', 'm', 'standard')
    RETURNING id`
  put("kernel:session", session.id, "Fix the build")

  const [contact] = await sql`
    INSERT INTO kernel.contacts (org_id, handle, name, email)
    VALUES (${orgId}, ${`c-${tag()}`}, 'Ada Lane', 'ada@example.com')
    RETURNING id`
  put("contacts:contact-detail", contact.id, "Ada Lane")

  const [ticket] = await sql`
    INSERT INTO app_tickets.tickets
      (id, org_id, subject, handle, channel, reply_token, sla_deadline, sla_target_seconds)
    VALUES (${uid()}, ${orgId}, 'Pump is leaking', ${`ticket-${tag()}`}, 'manual',
            ${`rt-${tag()}`}, now() + interval '1 day', 86400)
    RETURNING id`
  put("tickets:ticket", ticket.id, "Pump is leaking")

  const [project] = await sql`
    INSERT INTO app_projects.projects (org_id, name, owner_id, key)
    VALUES (${orgId}, 'Spring launch', ${viewer}, ${`K${tag().toUpperCase()}`})
    RETURNING id`
  put("projects:project", project.id, "Spring launch")

  const [status] = await sql`
    INSERT INTO app_projects.project_statuses (org_id, project_id, label, "order")
    VALUES (${orgId}, ${project.id}, 'To do', 0)
    RETURNING id`
  const [taskThread] = await sql`
    INSERT INTO kernel.threads (org_id, handle, type, created_by, discoverable)
    VALUES (${orgId}, ${`tt-${tag()}`}, 'thread', ${viewer}, true)
    RETURNING id`
  const [task] = await sql`
    INSERT INTO app_projects.tasks
      (org_id, project_id, status_id, title, thread_id, created_by, number)
    VALUES (${orgId}, ${project.id}, ${status.id}, 'Fix the pump', ${taskThread.id},
            ${viewer}, 1)
    RETURNING id`
  put("projects:task", task.id, "Fix the pump")

  const [doc] = await sql`
    INSERT INTO app_knowledge.documents (org_id, title, created_by, required_scopes)
    VALUES (${orgId}, 'Returns policy', ${viewer}, ARRAY[]::text[])
    RETURNING id`
  put("knowledge:document", doc.id, "Returns policy")

  const [identity] = await sql`
    INSERT INTO app_knowledge.source_identities (org_id, source, external_id)
    VALUES (${orgId}, 'drive', ${`ext-${tag()}`})
    RETURNING id`
  const [link] = await sql`
    INSERT INTO app_knowledge.source_links (org_id, source_identity_id, source, external_id, title)
    VALUES (${orgId}, ${identity.id}, 'drive', ${`ext-${tag()}`}, 'Linked sheet')
    RETURNING id`
  put("knowledge:source_link", link.id, "Linked sheet")

  const connection = async (app: string) => {
    const [row] = await sql`
      INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, provider_type, identifier, created_by)
      VALUES (${orgId}, ${app}, ${`google-${tag()}`}, 'org', 'oauth2',
              ${`${tag()}@example.com`}, ${viewer})
      RETURNING id`
    return row.id as string
  }

  const [account] = await sql`
    INSERT INTO app_mail.accounts
      (org_id, connected_account_id, provider, email_address, sync_status, owner_id)
    VALUES (${orgId}, ${await connection("mail")}, 'gmail', ${`m${tag()}@example.com`}, 'active',
            ${viewer})
    RETURNING id`
  const [conversation] = await sql`
    INSERT INTO app_mail.conversations
      (org_id, account_id, external_thread_id, status, subject, owner_id)
    VALUES (${orgId}, ${account.id}, ${`x-${tag()}`}, 'open', 'Quote request', ${viewer})
    RETURNING id`
  put("mail:conversation", conversation.id, "Quote request")

  const [calAccount] = await sql`
    INSERT INTO app_calendar.accounts (org_id, connected_account_id, owner_type, email_address)
    VALUES (${orgId}, ${await connection("calendar")}, 'org', ${`c${tag()}@example.com`})
    RETURNING id`
  const [calendar] = await sql`
    INSERT INTO app_calendar.calendars (org_id, account_id, google_calendar_id, name, calaccess)
    VALUES (${orgId}, ${calAccount.id}, ${`g-${tag()}`}, 'Team', ${calAccount.id})
    RETURNING id`
  const [event] = await sql`
    INSERT INTO app_calendar.events (org_id, calendar_id, calaccess, title, start)
    VALUES (${orgId}, ${calendar.id}, ${calAccount.id}, 'Quarter review',
            ${sql.json({ dateTime: "2026-12-03T10:00:00Z" })})
    RETURNING id`
  put("calendar:event", event.id, "Quarter review")
}

describe("open_app under real row security", () => {
  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    viewer = (await minimal.person(orgId)).id
    stranger = (await minimal.person(orgId)).id
    const [other] = await sql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Elsewhere', ${`else-${tag()}`})
      RETURNING id`
    otherOrgId = other.id
    const [elsewhere] = await sql`
      INSERT INTO kernel.users (org_id, email, name)
      VALUES (${otherOrgId}, ${`e${tag()}@example.com`}, 'Elsewhere')
      RETURNING id`
    strangerElsewhere = elsewhere.id
    await seed()
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  /** The apps whose tables exist here, and the kernel. */
  const CORE = ["kernel", "contacts", "tickets", "projects", "knowledge", "mail", "calendar"]

  test("every record view of the core apps and the kernel has a row in this test", () => {
    const missing: string[] = []
    for (const app of CORE) {
      for (const view of openViewsOf(orgId, app) ?? []) {
        if (view.record && !ids.has(`${app}:${view.view}`)) missing.push(`${app}:${view.view}`)
      }
    }
    expect(missing).toEqual([])
  })

  const KEYS = [
    "kernel:thread",
    "kernel:routine",
    "kernel:skill",
    "kernel:agent",
    "kernel:session",
    "contacts:contact-detail",
    "tickets:ticket",
    "projects:project",
    "projects:task",
    "knowledge:document",
    "knowledge:source_link",
    "mail:conversation",
    "calendar:event",
  ]

  for (const key of KEYS) {
    const [app, view] = key.split(":") as [string, string]

    test(`${key} opens for a viewer who can see the row, named by it`, async () => {
      const row = ids.get(key)!
      const res = await open(everything(viewer), app, view, row.id)
      expect(res).toMatchObject({ ok: true, app, view, id: row.id, label: row.label })
      expect((res as { tab?: { type: string } }).tab?.type).toBeString()
    })

    test(`${key} answers NOT_FOUND where row security hides the row`, async () => {
      const row = ids.get(key)!
      const res = await open(everything(strangerElsewhere, otherOrgId), app, view, row.id)
      expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" })
      expect("tab" in res).toBe(false)
    })

    test(`${key} answers NOT_FOUND for an id that does not exist`, async () => {
      const res = await open(everything(viewer), app, view, uid())
      expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" })
    })

    test(`${key} survives an id of the wrong shape, and the transaction stays usable`, async () => {
      const actor = everything(viewer)
      await withRlsContext(actor, async (tx) => {
        const res = await handleOpenApp(
          { app, view, id: "not-a-uuid" },
          { userId: viewer, orgId, db: tx, scopes: actor.scopes },
        )
        expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" })
        expect(extractRows<{ one: number }>(await tx.execute(sqlOne))[0]?.one).toBe(1)
      })
    })
  }

  test("a direct conversation opens for its member and is hidden from a colleague outside it", async () => {
    expect(await open(everything(viewer), "kernel", "thread", dmId)).toMatchObject({
      ok: true,
      label: "Just us",
    })
    expect(await open(everything(stranger), "kernel", "thread", dmId)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    })
  })

  test("a discoverable channel opens for a colleague who has not joined it", async () => {
    const channel = ids.get("kernel:thread")!
    expect(await open(everything(stranger), "kernel", "thread", channel.id)).toMatchObject({
      ok: true,
      label: "Support channel",
    })
  })

  test("a viewer without the record's reading scope gets NOT_FOUND, row visible or not", async () => {
    const ticket = ids.get("tickets:ticket")!
    const res = await open(everything(viewer), "tickets", "ticket", ticket.id, [
      "kernel:threads:read",
    ])
    expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  test("a routine opens on the page of the agent that owns it, selected", async () => {
    const routine = ids.get("kernel:routine")!
    const res = await open(everything(viewer), "kernel", "routine", routine.id)
    expect(res).toMatchObject({
      tab: {
        type: "agents:agent",
        entityId: "self",
        routePath: `/agents/self/routines?selected=${routine.id}`,
      },
    })
  })

  test("a calendar event opens the calendar tab on the event's day", async () => {
    const event = ids.get("calendar:event")!
    const res = await open(everything(viewer), "calendar", "event", event.id)
    expect(res).toMatchObject({
      tab: { type: "calendar:month", entityId: `event-${event.id}@2026-12-03` },
    })
  })

  test("the tool is registered for the agent and absent from the MCP catalog", () => {
    const tool = toolRegistry.get([orgId, "kernel", "open_app"]) as { gatewayHidden?: boolean }
    expect(tool.gatewayHidden).toBe(true)
    const names = listGatewayTools(orgId, everything(viewer)).map((t) => t.toolName)
    expect(names).not.toContain("kernel:open_app")
    expect(names.length).toBeGreaterThan(0)
  })
})

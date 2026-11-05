// SPDX-License-Identifier: FSL-1.1-ALv2
// The field setters (setCategory, setLanguage, setTeam, setAudience,
// setPriority, assign, setStatus) must accept the `ticket-<n>` handle an agent
// sees everywhere, exactly like get/addNote/reply do. They used to bind the
// handle straight into the uuid column: Postgres threw "invalid input syntax
// for type uuid" and the caller got an error-level 500.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string
let ticketId: string
let ticketHandle: string
let actor: ActorContext

beforeAll(async () => {
  const slug = `ref-setters-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("ref-setters-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Ref Setters', ${slug}) RETURNING id
    `)) as any
    orgId = (orgRows.rows ?? orgRows)[0].id
    const userRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@test.com`}, 'RS', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userId = (userRows.rows ?? userRows)[0].id
    ticketId = crypto.randomUUID()
    ticketHandle = `ticket-${Math.floor(Math.random() * 1e9)}`
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        last_inbound_at, last_message_at,
        created_at, updated_at
      ) VALUES (
        ${ticketId}, ${orgId}, ${ticketHandle}, 'Hello', 'open', 'normal', 'manual', 'internal',
        ${`RT${slug.replace(/-/g, "").slice(0, 14)}`}, 3600, now() + interval '1 hour',
        now(), 0, 1,
        now(), now(), now(), now()
      )
    `)
  })
  await ensureAppsForOrg(orgId, {})
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets", "tickets:approve"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext
})

async function readRow(): Promise<Record<string, unknown>> {
  return withSystemDb("ref-setters-read", async (tx) => {
    const r = (await tx.execute(drizzleSql`
      SELECT language, team, audience, priority, assigned_to::text AS assigned_to
      FROM app_tickets.tickets WHERE id = ${ticketId}
    `)) as any
    return (r.rows ?? r)[0]
  })
}

function call(toolName: string, params: Record<string, unknown>) {
  return executeTool({ toolName, orgId, actor, origin: "human-ui", params } as never).then(
    (out) => ({
      out: out as any,
      err: null as null | (Error & { code?: string; status?: number }),
    }),
    (e) => ({ out: null as any, err: e as Error & { code?: string; status?: number } }),
  )
}

describe("tickets field setters resolve a ticket handle", () => {
  it("setLanguage accepts the handle and writes the resolved ticket", async () => {
    const { out, err } = await call("tickets:setLanguage", {
      ticketId: ticketHandle,
      language: "French",
    })
    expect(err?.message).toBeUndefined()
    expect(out.data.ticketId).toBe(ticketId)
    expect((await readRow()).language).toBe("French")
  })

  it("setCategory accepts the handle", async () => {
    const { out, err } = await call("tickets:setCategory", {
      ticketId: ticketHandle,
      categoryId: null,
    })
    expect(err?.message).toBeUndefined()
    expect(out.data.ticketId).toBe(ticketId)
  })

  it("setTeam accepts the handle", async () => {
    const { out, err } = await call("tickets:setTeam", { ticketId: ticketHandle, team: "EU" })
    expect(err?.message).toBeUndefined()
    expect(out.data.ticketId).toBe(ticketId)
    expect((await readRow()).team).toBe("EU")
  })

  it("setAudience accepts the handle", async () => {
    const { out, err } = await call("tickets:setAudience", {
      ticketId: ticketHandle,
      audience: "b2b",
    })
    expect(err?.message).toBeUndefined()
    expect(out.data.ticketId).toBe(ticketId)
    expect((await readRow()).audience).toBe("b2b")
  })

  it("setPriority accepts the handle", async () => {
    const { err } = await call("tickets:setPriority", { ticketId: ticketHandle, priority: "high" })
    expect(err?.message).toBeUndefined()
    expect((await readRow()).priority).toBe("high")
  })

  it("assign accepts the handle", async () => {
    const { out, err } = await call("tickets:assign", { ticketId: ticketHandle, assignedTo: "me" })
    expect(err?.message).toBeUndefined()
    expect(out.data.ticketId).toBe(ticketId)
    expect((await readRow()).assigned_to).toBe(userId)
  })

  it("setStatus accepts the handle", async () => {
    const { out, err } = await call("tickets:setStatus", {
      ticketId: ticketHandle,
      status: "awaiting_customer",
    })
    expect(err?.message).toBeUndefined()
    expect(out.data.ticketId).toBe(ticketId)
  })

  it("an unknown handle is a typed not_found, never a uuid-cast 500", async () => {
    const { err } = await call("tickets:setLanguage", {
      ticketId: "ticket-999999999",
      language: "German",
    })
    expect(err).not.toBeNull()
    expect(err?.code).toBe("not_found")
    expect(err?.message).not.toContain("invalid input syntax")
  })

  it("a bad uuid inside an atomic tool's bridge call is a typed invalid_params, not a 500", async () => {
    // tickets:assign is `atomic: true`, so it runs on the ambient bridge, not
    // the session one. A teammate NAME where a user uuid belongs makes the
    // bridge's user lookup raise 22P02; before the ambient bridge inlined the
    // pg cause, only the bare "Failed query" text crossed the sandbox IPC and
    // the classifier logged it at error level as an opaque db_error.
    const { err } = await call("tickets:assign", { ticketId, assignedTo: "Priya" })
    expect(err).not.toBeNull()
    expect(err?.code).toBe("invalid_params")
    expect(err?.status).toBe(400)
  })

  it("a value that is neither a uuid nor a handle is a typed invalid_params", async () => {
    const { err } = await call("tickets:setCategory", { ticketId: "62dc710d", categoryId: null })
    expect(err).not.toBeNull()
    expect(err?.code).toBe("invalid_params")
    expect(err?.message).not.toContain("invalid input syntax")
  })
})

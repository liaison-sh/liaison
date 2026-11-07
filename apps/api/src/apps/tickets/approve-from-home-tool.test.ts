// SPDX-License-Identifier: FSL-1.1-ALv2
// The tickets `approveFromHome.get` / `approveFromHome.set` tools: the org
// setting settings.tickets.approveRepliesFromHome (absent = off), reachable by
// an agent or an MCP client. Before them only the web settings page and the CLI
// provisioner could write it. Admin-only like PATCH /api/org, and the rest of
// settings.tickets is left alone.
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { summarizeTicketApproveFromHomeSet } from "~/apps/tickets/summarizers"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { asOrgMember } from "~/tests/helpers/org-caller"
import manifest from "./app.manifest.json"

async function freshOrg(tickets: Record<string, unknown> = {}): Promise<string> {
  const slug = `afh-tool-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug, settings)
      VALUES (gen_random_uuid(), 'AFH Org', ${slug},
              ${JSON.stringify({ tickets: { sla: { firstResponseMinutes: 30 }, ...tickets } })}::jsonb)
      RETURNING id
    `),
  )
  await ensureAppsForOrg(org.id, {})
  return org.id
}

const actor = (scopes: string[]) => ({
  actorType: "user" as const,
  userId: "00000000-0000-0000-0000-000000000001",
  scopes,
})

const op = (orgId: string, name: string, params: Record<string, unknown>, scopes: string[]) =>
  asOrgMember(orgId, "00000000-0000-0000-0000-000000000001", (tx) =>
    runAdminOp(tx as never, orgId, name, params, actor(scopes)),
  ) as Promise<any>

const storedTickets = async (orgId: string) =>
  extractRows<{ t: any }>(
    await db.execute(
      drizzleSql`SELECT settings->'tickets' AS t FROM kernel.organizations WHERE id = ${orgId}`,
    ),
  )[0].t

const ADMIN = ["tickets:settings:admin"]

describe("tickets approveFromHome tools", () => {
  it("set is a gated approval with a preflight and a summary; get is a read", async () => {
    const tools = (manifest as any).tools
    expect(tools["approveFromHome.set"].gated).toBe(true)
    expect(tools["approveFromHome.set"].requiredScopes).toEqual(["tickets:settings:admin"])
    expect(tools["approveFromHome.set"].preflight).toBe("approveFromHomeSetPreflight")
    expect(tools["approveFromHome.set"].params.required).toEqual(["enabled"])
    expect(tools["approveFromHome.get"].readOnly).toBe(true)
    expect(tools["approveFromHome.get"].gated).toBeUndefined()
    expect(tools["approveFromHome.get"].requiredScopes).toEqual(["tickets:settings:admin"])
    const off = await summarizeTicketApproveFromHomeSet({ enabled: false })
    expect(off.title).toBe("Approve ticket replies from Home: off")
    expect(off.impact).toBe("internal")
    const on = await summarizeTicketApproveFromHomeSet({ enabled: true })
    expect(on.title).toBe("Approve ticket replies from Home: on")
  })

  it("get reads false when the key is absent and true when it is stored", async () => {
    const absent = await freshOrg()
    expect(await op(absent, "approveFromHomeGet", {}, ADMIN)).toEqual({ enabled: false })
    const stored = await freshOrg({ approveRepliesFromHome: true })
    expect(await op(stored, "approveFromHomeGet", {}, ADMIN)).toEqual({ enabled: true })
  })

  it("set turns it on then off, keeps the sibling tickets settings, and get reads it back", async () => {
    const orgId = await freshOrg({ idSegment: { by: "audience", codes: { b2b: "B2B" } } })
    const on = await op(orgId, "approveFromHomeSet", { enabled: true }, ADMIN)
    expect(on).toEqual({ enabled: true })
    let stored = await storedTickets(orgId)
    expect(stored.approveRepliesFromHome).toBe(true)
    expect(stored.sla).toEqual({ firstResponseMinutes: 30 })
    expect(stored.idSegment).toEqual({ by: "audience", codes: { b2b: "B2B" } })
    expect((await op(orgId, "approveFromHomeGet", {}, ADMIN)).enabled).toBe(true)

    // Setting the value it already holds is a no-op that still answers.
    expect(await op(orgId, "approveFromHomeSet", { enabled: true }, ADMIN)).toEqual({
      enabled: true,
    })

    const off = await op(orgId, "approveFromHomeSet", { enabled: false }, ADMIN)
    expect(off).toEqual({ enabled: false })
    stored = await storedTickets(orgId)
    expect(stored.approveRepliesFromHome).toBe(false)
    expect(stored.sla).toEqual({ firstResponseMinutes: 30 })
    expect(stored.idSegment).toEqual({ by: "audience", codes: { b2b: "B2B" } })
    expect((await op(orgId, "approveFromHomeGet", {}, ADMIN)).enabled).toBe(false)
  })

  it("refuses a caller without tickets:settings:admin, and changes nothing", async () => {
    const orgId = await freshOrg()
    const set = await op(orgId, "approveFromHomeSet", { enabled: true }, [
      "tickets:tickets:write",
      "kernel:org:admin",
    ])
    expect(set.error.code).toBe("forbidden")
    const get = await op(orgId, "approveFromHomeGet", {}, ["tickets:tickets:read"])
    expect(get.error.code).toBe("forbidden")
    expect((await storedTickets(orgId)).approveRepliesFromHome).toBeUndefined()
  })

  it("set and its preflight refuse a missing or non-boolean enabled, and change nothing", async () => {
    const orgId = await freshOrg()
    for (const name of ["approveFromHomeSet", "approveFromHomeSetPreflight"]) {
      for (const params of [{}, { enabled: "yes" }, { enabled: 1 }]) {
        const r = await op(orgId, name, params, ADMIN)
        expect([name, r.error?.code]).toEqual([name, "invalid_params"])
      }
    }
    expect(await op(orgId, "approveFromHomeSetPreflight", { enabled: false }, ADMIN)).toEqual({
      ok: true,
    })
    expect((await storedTickets(orgId)).approveRepliesFromHome).toBeUndefined()
  })
})

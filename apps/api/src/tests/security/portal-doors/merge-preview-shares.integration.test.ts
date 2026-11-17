// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Three ways staff could put on a client's portal what it must not show: a ticket merge that
// copies another company's (or a more sensitive ticket's) messages into the client's request,
// the panel's preview showing a member what their own reads hide, and a share opening a
// record its maker cannot read. Each door test fails when its check is taken out.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { mergeTickets } from "~/apps/tickets/merge"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { registerApps } from "~/modules/apps/runtime"
import { createSession } from "~/modules/auth/auth"
import { PortalAccessError, setPortalShare } from "~/modules/portal/access"
import { handlePortalShareSet } from "~/modules/portal/tools"
import { ensurePortalViews } from "~/modules/portal/views"
import { reparentPortalStagedFiles } from "~/modules/tickets/ingest-core"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import agreementsManifest from "../../../../../../bundled-apps/agreements/app.manifest.json"
import {
  adminContext,
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
  insertShare,
  memberContext,
} from "./fixture"
import {
  dropReadsWorld,
  insertCurrentTimebox,
  insertFile,
  insertProject,
  insertTicket,
  insertTime,
  registerInvoicingSchema,
} from "./reads-world"

const k = (table: string) => `"${schemaRef("kernel")}".${table}`

let w: DoorWorld
let adminToken = ""
let memberToken = ""

async function registerAgreementsSchema(orgId: string): Promise<void> {
  const desc = {
    ...agreementsManifest,
    _format: "manifest" as const,
    _firstParty: true,
    _bundlePath: new URL(
      `../../../../../../bundled-apps/.source/agreements/${agreementsManifest.version}/bundle.js`,
      import.meta.url,
    ).pathname,
  } as unknown as Parameters<typeof registerApps>[0][number]
  const { failedApps } = await registerApps([desc], orgId, { skipOrgRows: true })
  if (failedApps.length > 0)
    throw new Error(`agreements did not register: ${failedApps.join(", ")}`)
}

/** Gives the world's member exactly these scopes, through a role of their own. */
async function setMemberScopes(scopes: string[]): Promise<void> {
  await sql.unsafe(`DELETE FROM ${k("user_roles")} WHERE user_id = $1`, [w.member.userId])
  const role = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.roles", { id: role, org_id: w.orgId, name: `member-${role.slice(0, 8)}` }),
  )
  for (const scope of scopes) {
    await sql.unsafe(insertSql("kernel.role_scope_grants", { role_id: role, scope }))
  }
  await sql.unsafe(
    insertSql("kernel.user_roles", { user_id: w.member.userId, role_id: role, org_id: w.orgId }),
  )
  memberToken = (await createSession(w.member.userId, w.orgId)).accessToken
}

const get = (path: string, token: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${token}` } })

const merge = (target: string, source: string) =>
  withRlsContext(adminContext(w), (tx) =>
    mergeTickets(
      tx as never,
      w.orgId,
      { targetTicketId: target, sourceTicketIds: [source] },
      { actorType: "user", userId: w.admin.userId },
    ),
  )

async function messageCount(ticketId: string): Promise<number> {
  const [r] = await sql.unsafe(
    `SELECT count(*)::int AS n FROM app_tickets.messages WHERE ticket_id = $1`,
    [ticketId],
  )
  return Number((r as unknown as { n: number } | undefined)?.n ?? 0)
}

beforeAll(async () => {
  await acquireTestLock()
  w = await createDoorWorld()
  await registerAgreementsSchema(w.orgId)
  await registerInvoicingSchema(w.orgId)
  // The views as the code holds them now, as boot puts them back.
  await withSystemDb("portal-preview-test-views", (tx) =>
    ensurePortalViews(tx, "invoicing", "compare"),
  )
  adminToken = (await createSession(w.admin.userId, w.orgId)).accessToken
  for (const company of [w.companyA, w.companyB]) {
    await insertShare(w, { company_id: company, kind: "requests" })
  }
}, 300_000)

afterAll(async () => {
  if (w) {
    await sql.unsafe(`UPDATE ${k("organizations")} SET deleting_at = now() WHERE id = $1`, [
      w.orgId,
    ])
    // The versions are kept for years; the org's purge is the one way they go.
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE liaison_admin")
      await tx.unsafe("SELECT set_config('liaison.demo_purge_org', $1, true)", [w.orgId])
      await tx.unsafe("DELETE FROM app_agreements.agreement_shares WHERE org_id = $1", [w.orgId])
      await tx.unsafe("DELETE FROM app_agreements.agreement_versions WHERE org_id = $1", [w.orgId])
      await tx.unsafe("DELETE FROM app_agreements.agreements WHERE org_id = $1", [w.orgId])
    })
    await dropReadsWorld(w)
    await dropDoorWorld(w)
  }
  await releaseTestLock()
})

describe("portal doors: a ticket merge", () => {
  it("a merge into a client's portal request brings nothing of another company's ticket", async () => {
    const request = await insertTicket(w, {
      company_id: w.companyA,
      contact_id: w.clientA.contactId,
      channel: "portal",
    })
    const other = await insertTicket(w, {
      company_id: w.companyB,
      contact_id: w.clientB.contactId,
      channel: "email",
    })
    const out = (await merge(request.id, other.id)) as { error?: { code: string } }
    expect(out.error?.code).toBe("merge_other_company")
    expect(await messageCount(request.id)).toBe(3)
    const [src] = await sql.unsafe(
      `SELECT merged_into_ticket_id FROM app_tickets.tickets WHERE id = $1`,
      [other.id],
    )
    expect(
      (src as unknown as { merged_into_ticket_id: string | null }).merged_into_ticket_id,
    ).toBeNull()
  })

  it("a merge into a portal request brings nothing of a ticket with no company", async () => {
    const request = await insertTicket(w, {
      company_id: w.companyA,
      contact_id: w.clientA.contactId,
      channel: "portal",
    })
    const loose = await insertTicket(w, {
      company_id: null,
      contact_id: w.clientB.contactId,
      channel: "email",
    })
    const out = (await merge(request.id, loose.id)) as { error?: { code: string } }
    expect(out.error?.code).toBe("merge_other_company")
    expect(await messageCount(request.id)).toBe(3)
  })

  it("a merge never moves a confidential ticket's messages into a ticket read more widely; the other way it merges", async () => {
    const open = await insertTicket(w, {
      company_id: w.companyA,
      contact_id: w.clientA.contactId,
      channel: "email",
    })
    const closed = await insertTicket(w, {
      company_id: w.companyA,
      contact_id: w.clientA.contactId,
      channel: "email",
      sensitivity: "confidential",
    })
    const refused = (await merge(open.id, closed.id)) as { error?: { code: string } }
    expect(refused.error?.code).toBe("merge_more_sensitive")
    expect(await messageCount(open.id)).toBe(3)
    const merged = (await merge(closed.id, open.id)) as { copiedMessageCount?: number }
    expect(merged.copiedMessageCount).toBe(3)
  })
})

describe("portal doors: the panel's preview", () => {
  it("the portal preview shows a member nothing their own reads would not", async () => {
    const ticket = await insertTicket(w, {
      company_id: w.companyB,
      contact_id: w.clientB.contactId,
      channel: "portal",
      subject: "Preview scope probe",
    })
    const path = `/api/contacts/companies/${w.companyB}/portal/preview/${w.clientB.userId}`
    type Body = {
      data: {
        signedInWouldSee: Record<string, Array<{ id: string }> | null>
        hiddenParts?: Record<string, string>
      }
    }
    // The portal admin scope alone: the person's own line, and no part it cannot read.
    await setMemberScopes(["kernel:portal:admin", "kernel:contacts:read"])
    const bare = await get(path, memberToken)
    expect(bare.status).toBe(200)
    const seen = ((await bare.json()) as Body).data
    expect(seen.signedInWouldSee.me).not.toBeNull()
    for (const part of ["projects", "invoices", "upcoming", "requests"]) {
      expect({ part, rows: seen.signedInWouldSee[part] }).toEqual({ part, rows: null })
    }
    expect(seen.hiddenParts?.requests).toBe("tickets:tickets:read")
    expect(JSON.stringify(seen)).not.toContain("Preview scope probe")
    // With the tickets read scope, the request shows; the admin sees it as before.
    await setMemberScopes(["kernel:portal:admin", "kernel:contacts:read", "tickets:tickets:read"])
    const withRead = ((await (await get(path, memberToken)).json()) as Body).data
    expect((withRead.signedInWouldSee.requests ?? []).map((r) => r.id)).toContain(ticket.id)
    const asAdmin = ((await (await get(path, adminToken)).json()) as Body).data
    expect((asAdmin.signedInWouldSee.requests ?? []).map((r) => r.id)).toContain(ticket.id)
    expect(asAdmin.hiddenParts).toBeUndefined()
  })

  it("the portal preview shows a member none of a project's upcoming billing when their own reads cannot see that project", async () => {
    const project = await insertProject(w, {
      company_id: w.companyB,
      name: "Preview billing probe",
    })
    const stepId = crypto.randomUUID()
    await sql.unsafe(
      insertSql("app_invoicing.billing_steps", {
        id: stepId,
        org_id: w.orgId,
        billing_project_id: project.id,
        position: 1,
        kind: "milestone",
        label: "Preview step probe",
        amount_minor: 125_000,
        currency: "EUR",
        state: "planned",
      }),
    )
    await insertShare(w, { company_id: w.companyB, kind: "invoices" })
    const path = `/api/contacts/companies/${w.companyB}/portal/preview/${w.clientB.userId}`
    type Body = { data: { signedInWouldSee: Record<string, Array<{ id: string }> | null> } }
    // The invoicing read scope without the projects one: the step's project is not theirs to read.
    await setMemberScopes([
      "kernel:portal:admin",
      "kernel:contacts:read",
      "invoicing:documents:read",
    ])
    const blind = await get(path, memberToken)
    expect(blind.status).toBe(200)
    const seen = ((await blind.json()) as Body).data
    expect(seen.signedInWouldSee.upcoming).toEqual([])
    expect(JSON.stringify(seen)).not.toContain("Preview step probe")
    // With the projects read scope too, the step shows: the check hides only what they cannot read.
    await setMemberScopes([
      "kernel:portal:admin",
      "kernel:contacts:read",
      "invoicing:documents:read",
      "projects:projects:read",
    ])
    const both = ((await (await get(path, memberToken)).json()) as Body).data
    expect((both.signedInWouldSee.upcoming ?? []).map((r) => r.id)).toEqual([stepId])
    const asAdmin = ((await (await get(path, adminToken)).json()) as Body).data
    expect((asAdmin.signedInWouldSee.upcoming ?? []).map((r) => r.id)).toEqual([stepId])
  })

  it("the portal preview shows a project's hours as the portal does, and names hours opened on a project the portal does not list", async () => {
    const project = await insertProject(w, {
      company_id: w.companyB,
      basis: "retainer",
      name: "Hours preview probe",
    })
    await insertCurrentTimebox(w, project.id, 2400)
    await insertTime(w, project, project.childOpenId, 300)
    const path = `/api/contacts/companies/${w.companyB}/portal/preview/${w.clientB.userId}`
    type Body = {
      data: {
        signedInWouldSee: Record<string, Array<Record<string, unknown>> | null>
        hoursNotShown: Array<{ id: string; name: string }>
      }
    }
    const read = async () => ((await (await get(path, adminToken)).json()) as Body).data
    // Hours alone: the portal lists no project, so the client sees none of its hours.
    const share = await withRlsContext(adminContext(w), (tx) =>
      handlePortalShareSet(
        { company_id: w.companyB, kind: "project_hours", object_id: project.id, open: true },
        { userId: w.admin.userId, orgId: w.orgId, db: tx as never, scopes: ["*"] },
      ),
    )
    expect(JSON.stringify(share)).toContain("does not see Hours preview probe's hours yet")
    const alone = await read()
    expect((alone.signedInWouldSee.projects ?? []).map((r) => r.id)).not.toContain(project.id)
    expect(alone.hoursNotShown).toEqual([{ id: project.id, name: "Hours preview probe" }])
    // With its progress open too, the project shows with the same hours line the portal reads.
    await insertShare(w, {
      company_id: w.companyB,
      kind: "project_progress",
      object_id: project.id,
    })
    const both = await read()
    const row = (both.signedInWouldSee.projects ?? []).find((r) => r.id === project.id)
    expect(row?.hours).toMatchObject({ kind: "so_far", usedMinutes: 300, ofMinutes: 2400 })
    expect(both.hoursNotShown).toEqual([])
  })
})

describe("portal doors: what a share opens", () => {
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (err: unknown) => (err instanceof PortalAccessError ? err.code : String(err)),
    )

  async function restrictedAgreement(listed: string): Promise<{ id: string; versionId: string }> {
    const id = crypto.randomUUID()
    const versionId = crypto.randomUUID()
    await sql.unsafe(
      insertSql("app_agreements.agreements", {
        id,
        org_id: w.orgId,
        number: `AG-${id.slice(0, 6)}`,
        kind: "sow",
        status: "sent",
        title: "Closed terms",
        company_id: w.companyA,
        org_access: "none",
        language: "fr",
      }),
    )
    await sql.unsafe(
      insertSql("app_agreements.agreement_versions", {
        id: versionId,
        org_id: w.orgId,
        agreement_id: id,
        number: 1,
        source: { raw: `'{"body":{"blocks":[]}}'::jsonb` },
        sha256: "d".repeat(64),
        status: "frozen",
        frozen_at: { raw: "now()" },
      }),
    )
    await sql.unsafe(
      insertSql("app_agreements.agreement_shares", {
        org_id: w.orgId,
        agreement_id: id,
        user_id: listed,
        role: "editor",
      }),
    )
    return { id, versionId }
  }

  const share = (
    as: "member" | "admin",
    kind: "agreement" | "change_request" | "invoices",
    objectId: string | null,
    scopes: string[],
  ) => {
    const ctx = as === "admin" ? adminContext(w) : memberContext(w, scopes)
    return withRlsContext(ctx, (tx) =>
      setPortalShare({
        orgId: w.orgId,
        actorId: ctx.userId,
        db: tx,
        scopes: ctx.scopes,
        companyId: w.companyA,
        kind,
        objectId,
        open: true,
        onlyUserIds: kind === "invoices" ? null : [w.clientA.userId],
      }),
    )
  }

  async function shareRows(objectId: string): Promise<number> {
    const rows = await sql.unsafe(
      `SELECT 1 FROM ${k("portal_shares")} WHERE org_id = $1 AND object_id = $2`,
      [w.orgId, objectId],
    )
    return rows.length
  }

  it("a share opens only what the person making it reads: a restricted agreement off their list is refused, by id or by version", async () => {
    const read = ["kernel:portal:share", "agreements:agreements:read"]
    const a = await restrictedAgreement(w.admin.userId)
    for (const kind of ["agreement", "change_request"] as const) {
      for (const objectId of [a.id, a.versionId]) {
        expect({ kind, code: await refusal(share("member", kind, objectId, read)) }).toEqual({
          kind,
          code: "SHARE_NOT_THIS_COMPANY",
        })
      }
    }
    expect(await shareRows(a.id)).toBe(0)
    expect(await shareRows(a.versionId)).toBe(0)
    // The person on the list opens it.
    expect(await refusal(share("admin", "agreement", a.id, []))).toBe("ok")
    expect(await shareRows(a.id)).toBe(1)
  })

  it("a share opens only what the person making it reads: the company's invoices need the invoicing read scope", async () => {
    const before = await sql.unsafe(
      `SELECT 1 FROM ${k("portal_shares")} WHERE org_id = $1 AND company_id = $2 AND kind = 'invoices' AND closed_at IS NULL`,
      [w.orgId, w.companyA],
    )
    expect(before.length).toBe(0)
    expect(await refusal(share("member", "invoices", null, ["kernel:portal:share"]))).toBe(
      "SHARE_NOT_THIS_COMPANY",
    )
    expect(
      await refusal(
        share("member", "invoices", null, ["kernel:portal:share", "invoicing:documents:read"]),
      ),
    ).toBe("ok")
  })
})

describe("portal doors: staged attachments", () => {
  const staged = (userId: string) =>
    insertFile(w, { app: "tickets", entity_type: "portal_staged", entity_id: userId })

  async function parentOf(fileId: string) {
    const [r] = await sql.unsafe(`SELECT entity_type, entity_id FROM ${k("files")} WHERE id = $1`, [
      fileId,
    ])
    return r as unknown as { entity_type: string; entity_id: string }
  }

  it("two messages naming the same staged files at once: one takes them all, the other none", async () => {
    const files = [await staged(w.clientA.userId), await staged(w.clientA.userId)]
    const [m1, m2] = [crypto.randomUUID(), crypto.randomUUID()]
    const results = await Promise.all([
      reparentPortalStagedFiles(w.orgId, w.clientA.userId, m1, files, "test-portal-files"),
      reparentPortalStagedFiles(w.orgId, w.clientA.userId, m2, files, "test-portal-files"),
    ])
    expect(results.filter(Boolean).length).toBe(1)
    const winner = results[0] ? m1 : m2
    for (const f of files)
      expect(await parentOf(f)).toEqual({ entity_type: "message", entity_id: winner })
  })

  it("a file another person staged, or one already sent, moves nothing, not even the person's own", async () => {
    const mine = await staged(w.clientA.userId)
    const theirs = await staged(w.clientB.userId)
    const ok = await reparentPortalStagedFiles(
      w.orgId,
      w.clientA.userId,
      crypto.randomUUID(),
      [mine, theirs],
      "test-portal-files",
    )
    expect(ok).toBe(false)
    expect(await parentOf(mine)).toEqual({
      entity_type: "portal_staged",
      entity_id: w.clientA.userId,
    })
    expect(await parentOf(theirs)).toEqual({
      entity_type: "portal_staged",
      entity_id: w.clientB.userId,
    })
  })
})

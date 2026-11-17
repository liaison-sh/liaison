// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A company merge never widens a portal: company A merged into company B, each
// company's portal people read exactly what they read before (shares, projects,
// invoices, requests and the open links), B's shares reach A's people only once a
// person clears their lists, and the merge signs every portal person out. The
// rows that named A name B, and a share B already had open is closed on A's side.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { ensureInstalledAppPortalViews } from "~/infra/boot-phase10"
import { summarizeCompaniesMerge } from "~/modules/agent/tools/company-tools"
import { createPortalSession, createSession } from "~/modules/auth/auth"
import { mergeCompanies } from "~/modules/contacts/companies"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  adminContext,
  asPortalRole,
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
  insertClientAction,
  insertShare,
  rowsOf,
} from "./fixture"
import {
  dropReadsWorld,
  insertDocument,
  insertIssuer,
  insertProject,
  insertTicket,
  registerInvoicingSchema,
} from "./reads-world"

let w: DoorWorld
const ids: Record<string, string> = {}

/** Everything one portal person reads, as sorted id lists per surface. */
async function readsOf(userId: string) {
  return asPortalRole(w.orgId, userId, async (tx) => {
    const list = async (statement: string) =>
      (await rowsOf(tx, statement)).map((r) => String(r.id)).sort()
    return {
      shares: (await rowsOf(tx, "SELECT kind, object_id FROM portal.shares"))
        .map((r) => `${r.kind}:${r.object_id ?? ""}`)
        .sort(),
      projects: await list("SELECT id FROM portal.projects"),
      invoices: await list("SELECT id FROM portal.invoices"),
      tickets: await list("SELECT id FROM portal.tickets"),
      actions: await list("SELECT id FROM portal.client_actions"),
    }
  })
}

let before: Record<string, Awaited<ReturnType<typeof readsOf>>> = {}
let token = ""
let adminToken = ""
let cardLines: string[] = []
let mergeMessage: { keptNames: string[]; signedOut: number; closedShares: number }

beforeAll(async () => {
  await acquireTestLock()
  w = await createDoorWorld()
  await registerInvoicingSchema(w.orgId)
  // The views as the code holds them, as every boot makes them.
  await ensureInstalledAppPortalViews()
  const issuer = await insertIssuer(w)
  const projectA = await insertProject(w, { company_id: w.companyA, name: "Alpha site" })
  const projectB = await insertProject(w, { company_id: w.companyB, name: "Beta site" })
  ids.projectA = projectA.id
  ids.projectB = projectB.id
  for (const [company, project] of [
    [w.companyA, projectA.id],
    [w.companyB, projectB.id],
  ] as const) {
    await insertShare(w, { company_id: company, kind: "project_progress", object_id: project })
    await insertShare(w, { company_id: company, kind: "invoices" })
    await insertShare(w, { company_id: company, kind: "requests" })
  }
  for (const [key, company, person] of [
    ["docA", w.companyA, w.clientA],
    ["docB", w.companyB, w.clientB],
  ] as const) {
    const doc = await insertDocument(w, issuer, { company_id: company })
    await sql`UPDATE app_invoicing.documents SET counterparty_contact_id = ${person.contactId} WHERE id = ${doc.id}`
    ids[key] = doc.id
  }
  // The contacts belong to their companies, as a portal person's contact does.
  for (const [person, company] of [
    [w.clientA, w.companyA],
    [w.clientA2, w.companyA],
    [w.clientB, w.companyB],
  ] as const) {
    await sql`UPDATE kernel.contacts SET company_id = ${company} WHERE id = ${person.contactId}`
  }
  ids.ticketA = (
    await insertTicket(w, { company_id: w.companyA, contact_id: w.clientA.contactId })
  ).id
  ids.ticketB = (
    await insertTicket(w, { company_id: w.companyB, contact_id: w.clientB.contactId })
  ).id
  const targetA = crypto.randomUUID()
  await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: targetA })
  ids.actionA = await insertClientAction(w, { company_id: w.companyA, target_id: targetA })
  const targetB = crypto.randomUUID()
  await insertShare(w, { company_id: w.companyB, kind: "agreement", object_id: targetB })
  ids.actionB = await insertClientAction(w, {
    company_id: w.companyB,
    target_id: targetB,
    invited_email: w.clientB.email,
    invited_name: w.clientB.name,
  })

  for (const p of [w.clientA, w.clientA2, w.clientB]) before[p.userId] = await readsOf(p.userId)
  cardLines = (
    await withRlsContext(adminContext(w), (tx) =>
      summarizeCompaniesMerge(
        { sourceId: w.companyA, targetId: w.companyB },
        { tx, orgId: w.orgId, userId: w.admin.userId },
      ),
    )
  ).lines
  adminToken = (await createSession(w.admin.userId, w.orgId)).accessToken
  token = (await createPortalSession(w.clientA.userId, w.orgId)).accessToken
  const r = await withRlsContext(adminContext(w), (tx) =>
    mergeCompanies(tx, {
      orgId: w.orgId,
      userId: w.admin.userId,
      sourceId: w.companyA,
      targetId: w.companyB,
    }),
  )
  mergeMessage = r.portal
})

afterAll(async () => {
  await dropReadsWorld(w)
  await dropDoorWorld(w)
  before = {}
  await releaseTestLock()
})

describe("a company merge and the portal", () => {
  it("the world reads something different on each side before the merge", () => {
    expect(before[w.clientA.userId]?.invoices).toEqual([ids.docA])
    expect(before[w.clientB.userId]?.invoices).toEqual([ids.docB])
    expect(before[w.clientA.userId]?.projects).toEqual([ids.projectA])
    expect(before[w.clientA.userId]?.actions).toEqual([ids.actionA])
  })

  it("NT-57 each portal person of either company reads exactly what they read before", async () => {
    for (const p of [w.clientA, w.clientA2, w.clientB]) {
      expect(await readsOf(p.userId)).toEqual(before[p.userId] as never)
    }
  })

  it("NT-57 every row that named the merged company names the survivor", async () => {
    const [people] = await sql`
      SELECT count(*)::int AS n FROM kernel.portal_people
       WHERE org_id = ${w.orgId} AND company_id = ${w.companyB}`
    expect(people?.n).toBe(3)
    const [left] = await sql`
      SELECT (SELECT count(*) FROM kernel.portal_shares WHERE company_id = ${w.companyA})
           + (SELECT count(*) FROM kernel.client_actions WHERE company_id = ${w.companyA})
           + (SELECT count(*) FROM app_invoicing.documents WHERE company_id = ${w.companyA})
           + (SELECT count(*) FROM app_tickets.tickets WHERE company_id = ${w.companyA}) AS n`
    expect(Number(left?.n)).toBe(0)
  })

  it("NT-57 a company-wide share the survivor already had is closed on the merged side", async () => {
    const open = await sql`
      SELECT kind FROM kernel.portal_shares
       WHERE company_id = ${w.companyB} AND closed_at IS NULL AND object_id IS NULL
       ORDER BY kind`
    expect(open.map((r) => r.kind)).toEqual(["invoices", "requests"])
    expect(mergeMessage.closedShares).toBe(2)
  })

  it("NT-57 the survivor's shares reach the merged company's people only once a person clears their lists on the client access panel", async () => {
    const path = `/api/contacts/companies/${w.companyB}/portal/people/${w.clientA2.userId}/show-whole-company`
    const asMember = await app.request(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(await createSession(w.member.userId, w.orgId)).accessToken}`,
      },
    })
    expect(asMember.status).toBe(403)
    const people = await app.request(`/api/contacts/companies/${w.companyB}/portal/people`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const listed = ((await people.json()) as { data: Array<Record<string, unknown>> }).data
    expect(listed.every((p) => p.keepsWhatTheySawBefore === true)).toBe(true)
    const click = await app.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(click.status).toBe(200)
    expect(((await click.json()) as { data: { widened: boolean } }).data.widened).toBe(true)
    const widened = await readsOf(w.clientA2.userId)
    expect(widened.projects).toEqual([ids.projectA, ids.projectB].sort())
    expect(widened.invoices).toEqual([ids.docA, ids.docB].sort())
    // Clearing one person's lists widens nobody else.
    expect(await readsOf(w.clientA.userId)).toEqual(before[w.clientA.userId] as never)
  })

  it("NT-57 the merge signs every portal person out and says who keeps what they saw", async () => {
    const [sessions] = await sql`
      SELECT count(*)::int AS n FROM kernel.sessions s JOIN kernel.users u ON u.id = s.user_id
       WHERE u.org_id = ${w.orgId} AND u.user_type = 'external'`
    expect(sessions?.n).toBe(0)
    const res = await app.request("/api/portal/me", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
    expect(mergeMessage.signedOut).toBe(3)
    const names = [w.clientA.name, w.clientA2.name, w.clientB.name].sort().join(", ")
    expect(cardLines).toContain(
      `Nobody on the portal sees more: ${names} keep what they saw before.`,
    )
    expect([...mergeMessage.keptNames].sort()).toEqual(
      [w.clientA.name, w.clientA2.name, w.clientB.name].sort(),
    )
  })
})

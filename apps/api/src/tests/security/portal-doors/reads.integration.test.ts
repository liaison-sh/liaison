// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The portal's read doors: what a client reads of projects, hours, invoices,
// requests and files, through the real routes on the portal's own login. Each
// door test fails when the predicate it names is taken out of its view.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { createPortalSession } from "~/modules/auth/auth"
import { portalFileStorage } from "~/modules/portal/file-stream"
import { PORTAL_ROUTES } from "~/modules/portal/routes-list"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createDoorWorld, type DoorWorld, dropDoorWorld, insertShare } from "./fixture"
import {
  dropReadsWorld,
  insertBilledLine,
  insertCurrentTimebox,
  insertDocument,
  insertFile,
  insertIssuer,
  insertProject,
  insertTicket,
  insertTime,
  type ProjectSeed,
  registerInvoicingSchema,
} from "./reads-world"

let w: DoorWorld
const tokens: Record<string, string> = {}
let issuer: string
let projectA: ProjectSeed
let projectB: ProjectSeed

async function tokenOf(userId: string): Promise<string> {
  if (!tokens[userId]) {
    tokens[userId] = (await createPortalSession(userId, w.orgId)).accessToken
  }
  return tokens[userId] as string
}

async function get(path: string, userId = w.clientA.userId) {
  return app.request(`/api/portal${path}`, {
    headers: { Authorization: `Bearer ${await tokenOf(userId)}` },
  })
}

async function data<T = unknown>(path: string, userId?: string): Promise<T> {
  const res = await get(path, userId)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

beforeAll(async () => {
  await acquireTestLock()
  w = await createDoorWorld()
  await registerInvoicingSchema(w.orgId)
  issuer = await insertIssuer(w)
  projectA = await insertProject(w, { company_id: w.companyA, basis: "hourly" })
  projectB = await insertProject(w, { company_id: w.companyB, basis: "hourly" })
  for (const company of [w.companyA, w.companyB]) {
    await insertShare(w, { company_id: company, kind: "invoices" })
    await insertShare(w, { company_id: company, kind: "requests" })
  }
  await insertShare(w, { company_id: w.companyA, kind: "project_progress", object_id: projectA.id })
  await insertShare(w, { company_id: w.companyB, kind: "project_progress", object_id: projectB.id })
}, 180_000)

afterAll(async () => {
  if (w) {
    await dropReadsWorld(w)
    await dropDoorWorld(w)
  }
  await sql.unsafe("REVOKE liaison_portal FROM liaison_request GRANTED BY liaison").catch(() => {})
  await releaseTestLock()
})

describe("portal reads", () => {
  it("NT-20 every portal route with an id gives company B's ids the same 404 as a random id", async () => {
    const ticketB = await insertTicket(w, {
      company_id: w.companyB,
      contact_id: w.clientB.contactId,
    })
    const invoiceB = await insertDocument(w, issuer, { company_id: w.companyB })
    const fileB = await insertFile(w, {
      app: "tickets",
      entity_type: "message",
      entity_id: ticketB.inboundId,
    })
    // Company B reads its own: the ids are real and readable by their owner.
    expect((await get(`/projects/${projectB.id}`, w.clientB.userId)).status).toBe(200)
    const open = spyOn(portalFileStorage, "open").mockResolvedValue({
      stream: new Blob(["b"]).stream(),
      contentType: "application/pdf",
      contentLength: 1,
    })
    try {
      expect((await get(`/files/${fileB}`, w.clientB.userId)).status).toBe(200)
    } finally {
      open.mockRestore()
    }
    const bIds: Record<string, string> = {
      "/projects/:id": projectB.id,
      "/projects/:id/reports": projectB.id,
      "/invoices/:id/pdf": invoiceB.id,
      "/documents/:id": invoiceB.id,
      "/documents/:id/pages/:n": invoiceB.id,
      "/files/:id": fileB,
    }
    const withId = PORTAL_ROUTES.filter(
      (r) => r.access === "token" && r.method === "GET" && r.path.includes(":id"),
    )
    expect(withId.length).toBeGreaterThan(0)
    for (const route of withId) {
      const rel = route.path.slice("/api/portal".length)
      const b = bIds[rel]
      expect(b).toBeDefined()
      const asB = await get(rel.replace(":id", String(b)).replace(":n", "1"))
      const random = await get(rel.replace(":id", crypto.randomUUID()).replace(":n", "1"))
      expect({ route: rel, status: asB.status }).toEqual({ route: rel, status: 404 })
      expect(await asB.text()).toBe(await random.text())
      expect(random.status).toBe(404)
    }
  })

  it("NT-23 a row with no company is nobody's", async () => {
    const p = await insertProject(w, { company_id: null, name: "Unstamped project" })
    await insertShare(w, { company_id: w.companyA, kind: "project_progress", object_id: p.id })
    const t = await insertTicket(w, {
      company_id: null,
      contact_id: w.clientA.contactId,
      subject: "Unstamped",
    })
    const d = await insertDocument(w, issuer, { company_id: null })
    expect((await get(`/projects/${p.id}`)).status).toBe(404)
    const requests = await data<Array<{ id: string }>>("/requests")
    expect(requests.map((r) => r.id)).not.toContain(t.id)
    const invoices = await data<Array<{ id: string }>>("/invoices")
    expect(invoices.map((i) => i.id)).not.toContain(d.id)
    expect((await get(`/invoices/${d.id}/pdf`)).status).toBe(404)
  })

  it("NT-48 a draft invoice and another client's invoice give 404, their PDFs too", async () => {
    const mine = await insertDocument(w, issuer, { company_id: w.companyA })
    const draft = await insertDocument(w, issuer, {
      company_id: w.companyA,
      status: "draft",
      issued: false,
    })
    const theirs = await insertDocument(w, issuer, { company_id: w.companyB })
    const credit = await insertDocument(w, issuer, {
      company_id: w.companyA,
      type: "credit_note",
      original_document_id: mine.id,
    })
    const quote = await insertDocument(w, issuer, { company_id: w.companyA, type: "quote" })
    const invoices = await data<Array<Record<string, unknown>>>("/invoices")
    const ids = invoices.map((i) => i.id)
    expect(ids).toContain(mine.id)
    expect(ids).toContain(credit.id)
    expect(ids).not.toContain(draft.id)
    expect(ids).not.toContain(theirs.id)
    expect(ids).not.toContain(quote.id)
    expect(invoices.find((i) => i.id === credit.id)?.originalDocumentId).toBe(mine.id)
    expect(invoices.find((i) => i.id === mine.id)?.label).toBe("Design sprint")
    expect(JSON.stringify(invoices)).not.toContain("late payer")
    const open = spyOn(portalFileStorage, "open").mockResolvedValue({
      stream: new Blob(["%PDF-1.7 x"]).stream(),
      contentType: "application/pdf",
      contentLength: 10,
    })
    try {
      expect((await get(`/invoices/${draft.id}/pdf`)).status).toBe(404)
      expect((await get(`/invoices/${theirs.id}/pdf`)).status).toBe(404)
      expect(open).not.toHaveBeenCalled()
      const pdf = await get(`/invoices/${mine.id}/pdf`)
      expect(pdf.status).toBe(200)
      expect(pdf.headers.get("content-disposition")).toStartWith("attachment")
      expect(pdf.headers.get("cache-control")).toBe("no-store")
    } finally {
      open.mockRestore()
    }
  })

  it("NT-24 a file the portal function refuses is never read from storage", async () => {
    const ticketA = await insertTicket(w, {
      company_id: w.companyA,
      contact_id: w.clientA.contactId,
    })
    const ticketB = await insertTicket(w, {
      company_id: w.companyB,
      contact_id: w.clientB.contactId,
    })
    const restricted = await insertTicket(w, {
      company_id: w.companyA,
      contact_id: w.clientA.contactId,
      sensitivity: "restricted",
    })
    const allowed = await insertFile(w, {
      app: "tickets",
      entity_type: "message",
      entity_id: ticketA.inboundId,
    })
    const onNote = await insertFile(w, {
      app: "tickets",
      entity_type: "message",
      entity_id: ticketA.noteId,
    })
    const otherCompany = await insertFile(w, {
      app: "tickets",
      entity_type: "message",
      entity_id: ticketB.inboundId,
    })
    const internal = await insertFile(w, {
      app: "kernel",
      entity_type: "company",
      entity_id: w.companyA,
    })
    const sharedOnRestricted = await insertFile(w, {
      app: "tickets",
      entity_type: "ticket",
      entity_id: restricted.id,
    })
    await insertShare(w, { company_id: w.companyA, kind: "file", object_id: sharedOnRestricted })
    const sealed = await insertFile(
      w,
      { app: "tickets", entity_type: "message", entity_id: ticketA.outboundId },
      { enc_version: 2 },
    )
    const draft = await insertDocument(w, issuer, {
      company_id: w.companyA,
      status: "draft",
      issued: false,
    })
    const open = spyOn(portalFileStorage, "open").mockResolvedValue({
      stream: new Blob(["hello portal"]).stream(),
      contentType: "application/pdf",
      contentLength: 12,
    })
    try {
      const random = await get(`/files/${crypto.randomUUID()}`)
      const randomBody = await random.text()
      for (const id of [
        onNote,
        otherCompany,
        internal,
        sharedOnRestricted,
        sealed,
        draft.pdfFileId,
      ]) {
        const res = await get(`/files/${id}`)
        expect(res.status).toBe(404)
        expect(await res.text()).toBe(randomBody)
      }
      expect(open).not.toHaveBeenCalled()
      const ok = await get(`/files/${allowed}`)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toBe("hello portal")
      expect(ok.headers.get("content-disposition")).toStartWith("attachment")
      expect(ok.headers.get("cache-control")).toBe("no-store")
      const headerText = JSON.stringify([...ok.headers.entries()])
      expect(headerText).not.toMatch(/X-Amz|Signature=|portal-doors\//i)
      expect(open).toHaveBeenCalledTimes(1)
    } finally {
      open.mockRestore()
    }
  })

  it("a sealed file is refused by the portal and never read from storage", async () => {
    const ticket = await insertTicket(w, {
      company_id: w.companyA,
      contact_id: w.clientA.contactId,
    })
    const sealed = await insertFile(
      w,
      { app: "tickets", entity_type: "message", entity_id: ticket.inboundId },
      { enc_version: 1 },
    )
    const open = spyOn(portalFileStorage, "open")
    try {
      const res = await get(`/files/${sealed}`)
      const random = await get(`/files/${crypto.randomUUID()}`)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe(await random.text())
      expect(open).not.toHaveBeenCalled()
    } finally {
      open.mockRestore()
    }
  })

  it("NT-38 hourly shows billed, retainer shows so far, fixed and a project turned off show nothing, 100 h of time spent change no step's done share, no person id in any body", async () => {
    const hourly = projectA
    const retainer = await insertProject(w, {
      company_id: w.companyA,
      basis: "retainer",
      name: "Retainer",
    })
    const fixed = await insertProject(w, { company_id: w.companyA, basis: "fixed", name: "Fixed" })
    const off = await insertProject(w, {
      company_id: w.companyA,
      basis: "hourly",
      time_budgets_on: false,
      name: "Off",
    })
    for (const p of [retainer, fixed, off]) {
      await insertShare(w, { company_id: w.companyA, kind: "project_progress", object_id: p.id })
    }
    await insertBilledLine(w, hourly.id, 90)
    await insertBilledLine(w, off.id, 90)
    await insertCurrentTimebox(w, retainer.id, 2400)
    await insertTime(w, retainer, retainer.childOpenId, 300)
    // Hours closed: nothing, whatever the basis.
    expect((await data<{ hours: unknown }>(`/projects/${hourly.id}`)).hours).toBeNull()
    for (const p of [hourly, retainer, fixed, off]) {
      await insertShare(w, { company_id: w.companyA, kind: "project_hours", object_id: p.id })
    }
    const before = await data<{ hours: unknown; steps: Array<{ doneShare: number }> }>(
      `/projects/${hourly.id}`,
    )
    expect(before.hours).toEqual({ kind: "billed", usedMinutes: 90, ofMinutes: null, period: null })
    expect(before.steps.map((s) => s.doneShare)).toEqual([50])
    const so = await data<{ hours: { kind: string; usedMinutes: number; ofMinutes: number } }>(
      `/projects/${retainer.id}`,
    )
    expect(so.hours).toMatchObject({ kind: "so_far", usedMinutes: 300, ofMinutes: 2400 })
    expect((await data<{ hours: unknown }>(`/projects/${fixed.id}`)).hours).toBeNull()
    expect((await data<{ hours: unknown }>(`/projects/${off.id}`)).hours).toBeNull()
    // 100 hours recorded on the open child change nothing the client reads but the total.
    await insertTime(w, hourly, hourly.childOpenId, 6000)
    const after = await data<{ hours: unknown; steps: Array<{ doneShare: number }> }>(
      `/projects/${hourly.id}`,
    )
    expect(after.steps.map((s) => s.doneShare)).toEqual([50])
    expect(after.hours).toEqual(before.hours)
    const bodies = JSON.stringify([
      await data("/home"),
      await data("/projects"),
      after,
      so,
      await data("/requests"),
    ])
    for (const id of [...w.staffIds, w.member.userId]) expect(bodies).not.toContain(id)
  })

  it("a retainer with only its hours open is listed and its page shows the hours alone; with nothing open it is not listed", async () => {
    const p = await insertProject(w, {
      company_id: w.companyA,
      basis: "retainer",
      name: "Hours only",
    })
    await insertCurrentTimebox(w, p.id, 2400)
    await insertTime(w, p, p.childOpenId, 1080)
    const listed = async () => (await data<Array<{ id: string }>>("/projects")).map((r) => r.id)
    // Nothing open: not listed, and its page is the same 404 as a random id.
    expect(await listed()).not.toContain(p.id)
    expect((await get(`/projects/${p.id}`)).status).toBe(404)
    // Hours alone: listed, on the home page too, and the page shows the hours so far.
    await insertShare(w, { company_id: w.companyA, kind: "project_hours", object_id: p.id })
    expect(await listed()).toContain(p.id)
    const home = await data<{ projects: Array<{ id: string }> }>("/home")
    expect(home.projects.map((r) => r.id)).toContain(p.id)
    const page = await data<{
      hours: unknown
      steps: unknown[]
      stepsShown: boolean
    }>(`/projects/${p.id}`)
    expect(page.hours).toMatchObject({ kind: "so_far", usedMinutes: 1080, ofMinutes: 2400 })
    // Its progress stays closed: no step, and the page says the steps are not shown.
    expect(page.steps).toEqual([])
    expect(page.stepsShown).toBe(false)
    // Progress opened too: the steps show as before.
    await insertShare(w, { company_id: w.companyA, kind: "project_progress", object_id: p.id })
    const both = await data<{ steps: unknown[]; stepsShown: boolean }>(`/projects/${p.id}`)
    expect(both.stepsShown).toBe(true)
    expect(both.steps.length).toBeGreaterThan(0)
  })

  it("NT-41 a colleague's request, a restricted mail ticket, a confidential portal ticket and a past mail ticket are absent; after a person shares the mail ticket it appears for the people it names", async () => {
    const own = await insertTicket(w, { company_id: w.companyA, contact_id: w.clientA.contactId })
    const colleague = await insertTicket(w, {
      company_id: w.companyA,
      contact_id: w.clientA2.contactId,
    })
    const restrictedMail = await insertTicket(w, {
      company_id: w.companyA,
      contact_id: w.clientA.contactId,
      channel: "email",
      sensitivity: "restricted",
    })
    const confidential = await insertTicket(w, {
      company_id: w.companyA,
      contact_id: w.clientA.contactId,
      sensitivity: "confidential",
    })
    const pastMail = await insertTicket(w, {
      company_id: w.companyA,
      contact_id: w.clientA.contactId,
      channel: "email",
      subject: "Last year's mail",
    })
    const list =
      await data<Array<{ id: string; messages: Array<{ id: string; kind: string }> }>>("/requests")
    const ids = list.map((t) => t.id)
    expect(ids).toContain(own.id)
    for (const absent of [colleague.id, restrictedMail.id, confidential.id, pastMail.id]) {
      expect(ids).not.toContain(absent)
    }
    const mine = list.find((t) => t.id === own.id)
    expect(mine?.messages.map((m) => m.kind).sort()).toEqual(["inbound", "outbound"])
    expect(JSON.stringify(list)).not.toContain("slow to pay")
    expect(JSON.stringify(list)).not.toContain("<p>")
    // A person shares the past mail ticket with client A only.
    await insertShare(w, {
      company_id: w.companyA,
      kind: "ticket",
      object_id: pastMail.id,
      only_user_ids: [w.clientA.userId],
    })
    expect((await data<Array<{ id: string }>>("/requests")).map((t) => t.id)).toContain(pastMail.id)
    const forColleague = await data<Array<{ id: string }>>("/requests", w.clientA2.userId)
    expect(forColleague.map((t) => t.id)).not.toContain(pastMail.id)
    expect(forColleague.map((t) => t.id)).toContain(colleague.id)
  })

  it("NT-37 closing a share makes the next read the same 404", async () => {
    const p = await insertProject(w, { company_id: w.companyA, name: "Closing" })
    const share = await insertShare(w, {
      company_id: w.companyA,
      kind: "project_progress",
      object_id: p.id,
    })
    expect((await get(`/projects/${p.id}`)).status).toBe(200)
    await sql`UPDATE kernel.portal_shares SET closed_at = now(), closed_by_user_id = ${w.admin.userId} WHERE id = ${share}`
    const res = await get(`/projects/${p.id}`)
    const random = await get(`/projects/${crypto.randomUUID()}`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(await random.text())
  })

  it("NT-69 a contact moved from one client to another moves nothing on either portal", async () => {
    const ticket = await insertTicket(w, {
      company_id: w.companyA,
      contact_id: w.clientA2.contactId,
    })
    const invoice = await insertDocument(w, issuer, { company_id: w.companyA })
    await sql.unsafe(
      insertSql("kernel.contacts", {
        id: crypto.randomUUID(),
        org_id: w.orgId,
        handle: `moved-${ticket.id.slice(0, 8)}`,
        name: "Moved person",
      }),
    )
    const readA = async () => ({
      tickets: (await data<Array<{ id: string }>>("/requests", w.clientA2.userId)).map((t) => t.id),
      invoices: (await data<Array<{ id: string }>>("/invoices")).map((i) => i.id),
    })
    const readB = async () => ({
      tickets: (await data<Array<{ id: string }>>("/requests", w.clientB.userId)).map((t) => t.id),
      invoices: (await data<Array<{ id: string }>>("/invoices", w.clientB.userId)).map((i) => i.id),
    })
    const beforeA = await readA()
    const beforeB = await readB()
    expect(beforeA.tickets).toContain(ticket.id)
    expect(beforeA.invoices).toContain(invoice.id)
    // The contact behind the ticket and the invoice moves to company B.
    await sql`UPDATE kernel.contacts SET company_id = ${w.companyB} WHERE id = ${w.clientA2.contactId}`
    try {
      expect(await readA()).toEqual(beforeA)
      expect(await readB()).toEqual(beforeB)
    } finally {
      await sql`UPDATE kernel.contacts SET company_id = NULL WHERE id = ${w.clientA2.contactId}`
    }
  })

  it("your contact is the company's manager by name, and nothing about being away", async () => {
    await sql`UPDATE kernel.companies SET owner_user_id = ${w.member.userId} WHERE id = ${w.companyA}`
    const me = await data<Record<string, unknown>>("/me")
    expect(me.contactName).toBe(w.member.name)
    const home = JSON.stringify(await data("/home"))
    expect(home).toContain(w.member.name)
    expect(home).not.toMatch(/away|absent|until/i)
    expect(home).not.toContain(w.member.userId)
    await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${w.member.userId}`
    try {
      expect((await data<Record<string, unknown>>("/me")).contactName).toBeNull()
    } finally {
      await sql`UPDATE kernel.users SET status = 'active' WHERE id = ${w.member.userId}`
      await sql`UPDATE kernel.companies SET owner_user_id = NULL WHERE id = ${w.companyA}`
    }
  })

  it("a part whose view is missing answers as unavailable and the other parts still answer", async () => {
    await sql.unsafe("ALTER VIEW portal.billing_upcoming RENAME TO billing_upcoming_away")
    try {
      const home = await data<{ unavailable: string[]; projects: unknown[] | null }>("/home")
      expect(home.unavailable).toEqual(["upcoming"])
      expect(Array.isArray(home.projects)).toBe(true)
    } finally {
      await sql.unsafe("ALTER VIEW portal.billing_upcoming_away RENAME TO billing_upcoming")
    }
  })
})

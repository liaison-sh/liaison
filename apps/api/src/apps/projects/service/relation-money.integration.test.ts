// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The money links between invoicing and projects, against the events that can break them (the
// relation matrix's classes, tests/relations/classes.ts):
// - an invoice to the project it bills (`documents.billing_project_id`): the project archived
//   closes nothing and leaves the invoice naming it, with the project's archived state visible;
//   restored, it reads as before; a reader who loses invoicing's read sees no invoice and no
//   count for the project, and sees it again once the read is back;
// - a retainer schedule to its project (`recurring_schedules.retainer_project_id`): the project's
//   archive is refused while the retainer still holds a month to bill, with a sentence and nothing
//   changed; a reader who loses invoicing's read sees no schedule;
// - an annex to its invoice (`document_attachments.document_id`): the invoice cannot be deleted
//   while an annex points at it; a reader who loses invoicing's read sees no annex.
// Each case reads before the event (the link resolves, an admin of another org sees nothing), runs
// the event through the product's own path, and reads again.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { insertAppRow, jsonCell } from "~/seed/factories/app-tables"
import * as minimal from "~/seed/tiers/minimal"
import {
  type ClaimsWorld,
  claimsWorld,
  forgetClaimsWorld,
  invoiceCarrying,
} from "~/tests/helpers/projects-claims"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const inv = (table: string) => drizzleSql.raw(`${schemaRef("app_invoicing")}.${table}`)
const READ = "invoicing:documents:read"

let w: ClaimsWorld
let outsiderOrg = ""
let outsiderId = ""

beforeAll(async () => {
  await acquireTestLock()
  w = await claimsWorld("LINK", 2)
  const outsider = await minimal.secondOrg({ name: "Maison Ailleurs" })
  outsiderOrg = outsider.orgId
  outsiderId = outsider.adminUserId
}, 180_000)

afterAll(async () => {
  forgetClaimsWorld(w)
  await releaseTestLock()
})

/** A reader of the org holding exactly `scopes` (an admin: every scope). */
function reader(scopes: string[], who: "inside" | "outsider" = "inside"): UserContext {
  return {
    actorType: "user",
    userId: who === "inside" ? w.owner.userId : outsiderId,
    orgId: who === "inside" ? w.orgId : outsiderOrg,
    scopes,
    dimensionGrants: { "*": ["*"] },
  } as UserContext
}

/** The documents billing `projectId` as `ctx` reads them, with the project they name. */
async function invoicesOfProject(ctx: UserContext, projectId: string) {
  return withRlsContext(ctx, async (tx) =>
    extractRows<{ id: string; billing_project_id: string | null }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, billing_project_id::text AS billing_project_id
          FROM ${inv("documents")} WHERE billing_project_id = ${projectId}::uuid`),
    ),
  )
}

/** One row of an invoicing table as `ctx` reads it, or null. */
async function rowAs(ctx: UserContext, table: string, id: string) {
  return withRlsContext(ctx, async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`SELECT id::text AS id FROM ${inv(table)} WHERE id = ${id}::uuid`),
    )
    return rows[0] ?? null
  })
}

async function projectState(projectId: string) {
  const row = extractRows<{ archived: boolean }>(
    await db.execute(drizzleSql`
      SELECT archived_at IS NOT NULL AS archived FROM app_projects.projects WHERE id = ${projectId}::uuid`),
  )[0]
  return row ? (row.archived ? "archived" : "open") : "gone"
}

async function post(path: string) {
  const res = await app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${w.owner.bearer}`, accept: "application/json" },
  })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

/** A second project of the org, so each case has its own. */
async function newProject(key: string): Promise<string> {
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${w.owner.bearer}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ name: `Maison Lien ${key.toLowerCase()}`, key }),
  })
  expect(res.status).toBeLessThan(300)
  const body = (await res.json()) as { data?: { id?: string }; id?: string }
  const id = body.data?.id ?? body.id
  if (!id) throw new Error("no project id")
  return id
}

const day = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)

async function issuerId(): Promise<string> {
  const row = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      SELECT id::text AS id FROM ${inv("issuer_profiles")} WHERE org_id = ${w.orgId}::uuid LIMIT 1`),
  )[0]
  if (!row) throw new Error("no issuer profile")
  return row.id
}

/** A monthly retainer schedule on `projectId`, and its month on the project from `from` to `to`. */
async function retainerOn(projectId: string, from: string, to: string): Promise<string> {
  const id = randomUUID()
  await insertAppRow(db as never, "invoicing", "recurring_schedules", {
    id,
    org_id: w.orgId,
    issuer_profile_id: await issuerId(),
    status: "active",
    repeats: "month",
    billing_day: "last",
    lines: jsonCell([
      { description: "Monthly retainer", qty: 1, unit_price_minor: 450000, vat_bp: 2000 },
    ]),
    created_by: w.owner.userId,
    retainer_project_id: projectId,
    retainer_minutes: 2400,
  })
  await insertAppRow(db as never, "projects", "project_timeboxes", {
    id: randomUUID(),
    org_id: w.orgId,
    project_id: projectId,
    period_start: from,
    period_end: to,
    minutes: 2400,
    source: "retainer",
    source_ref: id,
    created_by: w.owner.userId,
  })
  return id
}

describe("money links between invoicing and projects", () => {
  it("an invoice keeps its project through the project's archive and restore, and a reader who loses invoicing's read sees none of it", async () => {
    const doc = await invoiceCarrying(w, { externalRef: `link:${randomUUID()}`, status: "issued" })
    const admin = reader(["*"])
    const clerk = reader([READ])

    // Before: the link resolves for the admin and the clerk; another org's admin sees nothing.
    expect(await invoicesOfProject(admin, w.projectId)).toEqual([
      { id: doc.id, billing_project_id: w.projectId },
    ])
    expect((await invoicesOfProject(clerk, w.projectId)).map((r) => r.id)).toEqual([doc.id])
    expect(await invoicesOfProject(reader(["*"], "outsider"), w.projectId)).toEqual([])

    // Archive: the invoice still names its project, which reads archived; nothing dangles.
    const archived = await post(`/api/projects/${w.projectId}/archive`)
    expect(archived.status).toBe(200)
    expect(await projectState(w.projectId)).toBe("archived")
    expect(await invoicesOfProject(admin, w.projectId)).toEqual([
      { id: doc.id, billing_project_id: w.projectId },
    ])

    // Restore: the same reading as before the archive.
    expect((await post(`/api/projects/${w.projectId}/restore`)).status).toBe(200)
    expect(await projectState(w.projectId)).toBe("open")
    expect((await invoicesOfProject(clerk, w.projectId)).map((r) => r.id)).toEqual([doc.id])

    // A lost read: no invoice, no count for the project; back, the same invoice.
    expect(await invoicesOfProject(reader([]), w.projectId)).toEqual([])
    expect(await rowAs(reader(["projects:projects:read"]), "documents", doc.id)).toBeNull()
    expect((await invoicesOfProject(clerk, w.projectId)).map((r) => r.id)).toEqual([doc.id])
  }, 120_000)

  it("a retainer schedule refuses its project's archive while it holds a month to bill, and a reader who loses invoicing's read sees no schedule", async () => {
    const live = await newProject("LINKR")
    const schedule = await retainerOn(live, day(-10), day(20))
    expect((await rowAs(reader([READ]), "recurring_schedules", schedule))?.id).toBe(schedule)
    expect(await rowAs(reader(["*"], "outsider"), "recurring_schedules", schedule)).toBeNull()

    const refused = await post(`/api/projects/${live}/archive`)
    expect(refused.status).toBe(409)
    expect(refused.body.error?.code).toBe("retainer_live")
    expect(String(refused.body.error?.message)).toContain("Nothing was changed")
    expect(String(refused.body.error?.message)).toContain(day(20))
    expect(await projectState(live)).toBe("open")

    // A lost read hides the schedule; the link itself is untouched.
    expect(await rowAs(reader([]), "recurring_schedules", schedule)).toBeNull()
    expect((await rowAs(reader([READ]), "recurring_schedules", schedule))?.id).toBe(schedule)

    // Once the retainer's months are all past, the project archives.
    const past = await newProject("LINKP")
    await retainerOn(past, day(-60), day(-31))
    expect((await post(`/api/projects/${past}/archive`)).status).toBe(200)
    expect(await projectState(past)).toBe("archived")
  }, 120_000)

  it("an invoice cannot be deleted while an annex points at it, and a reader who loses invoicing's read sees no annex", async () => {
    const doc = await invoiceCarrying(w, { externalRef: `link:${randomUUID()}`, status: "issued" })
    const annex = randomUUID()
    await insertAppRow(db as never, "invoicing", "document_attachments", {
      id: annex,
      org_id: w.orgId,
      document_id: doc.id,
      file_id: randomUUID(),
      kind: "timesheet",
      filename: "timesheet.pdf",
    })
    expect((await rowAs(reader([READ]), "document_attachments", annex))?.id).toBe(annex)
    expect(await rowAs(reader(["*"], "outsider"), "document_attachments", annex)).toBeNull()

    let refused = ""
    try {
      await db.execute(drizzleSql`DELETE FROM ${inv("documents")} WHERE id = ${doc.id}::uuid`)
    } catch (err) {
      refused = String((err as { cause?: unknown }).cause ?? err)
    }
    expect(refused).toContain("foreign key")
    expect(await rowAs(reader(["*"]), "documents", doc.id)).not.toBeNull()
    expect((await rowAs(reader([READ]), "document_attachments", annex))?.id).toBe(annex)

    expect(await rowAs(reader([]), "document_attachments", annex)).toBeNull()
    expect((await rowAs(reader([READ]), "document_attachments", annex))?.id).toBe(annex)
  }, 120_000)
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client report's doors: an agent may write anything into a draft, so nothing of a
// draft, its sources or what it left out reaches a client; a client reads only what a
// person sent, of their own company, behind an open reports share; the report's one
// project read takes no note and returns none; a section of a closed kind is refused.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import projectsManifest from "~/apps/projects/app.manifest.json"
import { clientReportSaveDraft } from "~/apps/projects/service/client-reports"
import { extractRows, sql } from "~/db"
import { __privileged_db__ as privileged } from "~/db/connection"
import { withPortalContext } from "~/db/portal-rls"
import { withRlsContext } from "~/db/rls"
import { repointPortalForCompanyMerge } from "~/modules/portal/company-merge"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createDoorWorld, type DoorWorld, dropDoorWorld, insertShare } from "./fixture"
import { dropReadsWorld, insertProject, type ProjectSeed } from "./reads-world"

let w: DoorWorld
let projectA: ProjectSeed
let projectB: ProjectSeed
let sentA = ""
let draftA = ""
let sentB = ""

const SECRET = "the margin on this client is forty percent"

async function report(
  projectId: string,
  companyId: string,
  status: "draft" | "sent",
  periodEnd: string,
): Promise<string> {
  const id = crypto.randomUUID()
  const sections = JSON.stringify([{ kind: "project_reports", heading: "Summary", text: SECRET }])
  await sql.unsafe(
    insertSql("app_projects.client_reports", {
      id,
      org_id: w.orgId,
      project_id: projectId,
      company_id: companyId,
      period_end: periodEnd,
      status,
      sections: { raw: `'${sections}'::jsonb` },
      sections_sent: status === "sent" ? { raw: `'${sections}'::jsonb` } : null,
      left_out: { raw: `'[{"what":"${SECRET}","why":"internal"}]'::jsonb` },
      sources: { raw: `'{"notes":"${SECRET}"}'::jsonb` },
      approved_by_user_id: status === "sent" ? w.admin.userId : null,
      sent_at: status === "sent" ? { raw: "now()" } : null,
    }),
  )
  return id
}

async function portalRows(userId: string, statement: string) {
  return withPortalContext({ orgId: w.orgId, userId } as never, async (tx) =>
    extractRows<Record<string, unknown>>(await tx.execute(drizzleSql.raw(statement))),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  w = await createDoorWorld()
  projectA = await insertProject(w, { company_id: w.companyA })
  projectB = await insertProject(w, { company_id: w.companyB })
  await insertShare(w, { company_id: w.companyA, kind: "project_reports", object_id: projectA.id })
  await insertShare(w, { company_id: w.companyB, kind: "project_reports", object_id: projectB.id })
  sentA = await report(projectA.id, w.companyA, "sent", "2031-03-07")
  draftA = await report(projectA.id, w.companyA, "draft", "2031-03-14")
  sentB = await report(projectB.id, w.companyB, "sent", "2031-03-07")
}, 180_000)

afterAll(async () => {
  if (w) {
    await dropReadsWorld(w)
    await dropDoorWorld(w)
  }
  await releaseTestLock()
})

describe("client report doors", () => {
  it("NT-47 a client reads only the sent reports of their own company, never a draft, its sources or what was left out", async () => {
    const a = await portalRows(w.clientA.userId, "SELECT * FROM portal.client_reports")
    expect(a.map((r) => r.id)).toEqual([sentA])
    expect(a.map((r) => r.id)).not.toContain(draftA)
    expect(a.map((r) => r.id)).not.toContain(sentB)
    expect(Object.keys(a[0] ?? {})).not.toContain("sources")
    expect(Object.keys(a[0] ?? {})).not.toContain("left_out")
    expect(JSON.stringify(a)).not.toContain('"why"')
    const b = await portalRows(w.clientB.userId, "SELECT * FROM portal.client_reports")
    expect(b.map((r) => r.id)).toEqual([sentB])
    // A closed company's person does not get a portal transaction at all.
    await expect(
      portalRows(w.clientC.userId, "SELECT * FROM portal.client_reports"),
    ).rejects.toThrow()
  })

  it("NT-47 the portal login has no grant on the reports table itself", async () => {
    const [grant] = await sql<{ select: boolean }[]>`
      SELECT has_table_privilege('liaison_portal', 'app_projects.client_reports', 'SELECT') AS select`
    expect(grant?.select).toBe(false)
    const cols = await sql<{ name: string }[]>`
      SELECT attname AS name FROM pg_attribute
       WHERE attrelid = 'portal.client_reports'::regclass AND attnum > 0 AND NOT attisdropped`
    expect(cols.map((c) => c.name).sort()).toEqual(
      ["id", "period_end", "project_id", "sections_sent", "sent_at", "sent_by_name"].sort(),
    )
  })

  it("NT-47 closing the reports share hides a sent report on the next read", async () => {
    await sql.unsafe(
      `UPDATE kernel.portal_shares SET closed_at = now()
        WHERE org_id = '${w.orgId}' AND kind = 'project_reports' AND object_id = '${projectA.id}'`,
    )
    try {
      expect(await portalRows(w.clientA.userId, "SELECT id FROM portal.client_reports")).toEqual([])
    } finally {
      await sql.unsafe(
        `UPDATE kernel.portal_shares SET closed_at = NULL
          WHERE org_id = '${w.orgId}' AND kind = 'project_reports' AND object_id = '${projectA.id}'`,
      )
    }
  })

  it("NT-47 the report's project read takes no note, comment or person as input", () => {
    const params = (projectsManifest as any).tools.client_report_sources_get.params
    expect(Object.keys(params.properties).sort()).toEqual(["projectId", "since", "until"])
    expect(params.additionalProperties).toBe(false)
  })

  it("NT-47 a draft section of a kind that is not shared is refused and nothing is saved", async () => {
    const ctx = {
      actorType: "user" as const,
      userId: w.admin.userId,
      orgId: w.orgId,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    }
    await expect(
      withRlsContext(ctx, (tx) =>
        clientReportSaveDraft({
          tx,
          orgId: w.orgId,
          userId: w.admin.userId,
          human: true,
          input: {
            projectId: projectA.id,
            periodEnd: "2031-03-21",
            sections: [{ kind: "project_hours", heading: "Hours", text: "Forty hours." }],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "SHARE_CLOSED" })
    const [n] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app_projects.client_reports
       WHERE project_id = ${projectA.id}::uuid AND period_end = '2031-03-21'`
    expect(n?.n).toBe(0)
  })

  it("a company merge moves its client reports to the survivor, and what was sent stays as it went out", async () => {
    const merged = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.companies", {
        id: merged,
        org_id: w.orgId,
        handle: `merged-${merged.slice(0, 8)}`,
        name: "Maison Fusion",
        closed_at: null,
      }),
    )
    const project = await insertProject(w, { company_id: merged })
    const sent = await report(project.id, merged, "sent", "2031-04-04")
    const [before] = await sql<{ body: unknown }[]>`
      SELECT sections_sent AS body FROM app_projects.client_reports WHERE id = ${sent}::uuid`
    await privileged.transaction((tx) =>
      repointPortalForCompanyMerge(tx, {
        orgId: w.orgId,
        sourceId: merged,
        targetId: w.companyA,
        actorId: w.admin.userId,
      }),
    )
    const [after] = await sql<{ company: string; body: unknown; status: string }[]>`
      SELECT company_id::text AS company, sections_sent AS body, status
        FROM app_projects.client_reports WHERE id = ${sent}::uuid`
    expect(after).toEqual({ company: w.companyA, body: before!.body, status: "sent" })
  })
})

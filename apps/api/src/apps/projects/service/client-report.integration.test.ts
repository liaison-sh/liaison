// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Friday client report on the real database: a draft follows the portal shares, only a
// person's approved send writes what went out (once), the same words reach the mail and the
// portal, its sources hold no comment, note, person or real time, and the approving person
// is warned on text that matches an internal note or a member's name.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPortalContext } from "~/db/portal-rls"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { type EmailMessage, type EmailProvider, setSystemEmailProvider } from "~/infra/email"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { clientReportWarnings, reportText } from "./client-reports"

const REPORT_SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "projects:reports:read",
  "projects:reports:write",
]

class Capture implements EmailProvider {
  sent: EmailMessage[] = []
  async send(m: EmailMessage) {
    this.sent.push(m)
  }
  async verify() {
    return true
  }
}

let orgId = ""
let owner: minimal.Session
let lead = ""
let leadName = ""
let companyId = ""
let otherCompanyId = ""
let clientContact = ""
let clientEmail = ""
let projectId = ""
let reportsShare = ""
let progressShare = ""
const mail = new Capture()

function actorOf(userId: string, scopes: string[] = REPORT_SCOPES): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function call<T = Record<string, any>>(
  method: string,
  input: unknown,
  opts: { userId?: string; origin?: string; approval?: Record<string, unknown> } = {},
): Promise<T> {
  const a = actorOf(opts.userId ?? lead)
  return withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      { name: "projects" },
      a.scopes,
      "user",
      opts.approval as never,
      { origin: opts.origin ?? "human-ui" } as never,
    )
    return JSON.parse(await bridge[method](JSON.stringify(input))) as T
  })
}

const week = (n: number) => `2031-0${n}-07`

async function draft(periodEnd: string, sections: unknown[], extra: Record<string, unknown> = {}) {
  return call("projects_clientReportSaveDraft", {
    projectId,
    periodEnd,
    sections,
    recipientContactId: clientContact,
    ...extra,
  })
}

const progress = (text: string) => ({ kind: "project_progress", heading: "This week", text })
const summary = (text: string) => ({ kind: "project_reports", heading: "Summary", text })

beforeAll(async () => {
  await acquireTestLock()
  setSystemEmailProvider(mail)
  orgId = (await createTestOrg()).id
  owner = await minimal.adminSession(orgId)
  const l = await minimal.session(orgId, { role: "member" })
  lead = l.userId
  for (const s of REPORT_SCOPES) await minimal.grantScope(lead, s)
  leadName =
    extractRows<{ name: string }>(
      await db.execute(drizzleSql`SELECT name FROM kernel.users WHERE id = ${lead}::uuid`),
    )[0]?.name ?? ""
  const tag = crypto.randomUUID().slice(0, 8)
  companyId = crypto.randomUUID()
  otherCompanyId = crypto.randomUUID()
  await db.execute(drizzleSql`
    INSERT INTO kernel.companies (id, org_id, handle, name) VALUES
      (${companyId}::uuid, ${orgId}::uuid, ${`rep-${tag}`}, 'Maison Corail'),
      (${otherCompanyId}::uuid, ${orgId}::uuid, ${`rep2-${tag}`}, 'Maison Sable')`)
  clientContact = crypto.randomUUID()
  clientEmail = `claire-${tag}@corail.example.com`
  await db.execute(drizzleSql`
    INSERT INTO kernel.contacts (id, org_id, handle, name, email, company_id)
    VALUES (${clientContact}::uuid, ${orgId}::uuid, ${`claire-${tag}`}, 'Claire Fontaine',
            ${clientEmail}, ${companyId}::uuid)`)
  const made = await call<{ id: string }>("projects_createProject", { name: "Maison Corail site" })
  projectId = made.id
  await db.execute(drizzleSql`
    UPDATE app_projects.projects SET company_id = ${companyId}::uuid WHERE id = ${projectId}::uuid`)
  reportsShare = crypto.randomUUID()
  progressShare = crypto.randomUUID()
  await db.execute(drizzleSql`
    INSERT INTO kernel.portal_shares (id, org_id, company_id, kind, object_id, shared_by_user_id) VALUES
      (${reportsShare}::uuid, ${orgId}::uuid, ${companyId}::uuid, 'project_reports', ${projectId}::uuid, ${owner.userId}::uuid),
      (${progressShare}::uuid, ${orgId}::uuid, ${companyId}::uuid, 'project_progress', ${projectId}::uuid, ${owner.userId}::uuid)`)
}, 180_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("a client report waits for a person", () => {
  it("a draft says nothing went out, and a routine's or an agent's send is refused without a person's approval", async () => {
    const saved = await draft(week(1), [summary("The home page is live.")])
    expect(saved.status).toBe("draft")
    expect(saved.message).toContain("Nothing was sent")
    for (const origin of ["in-app-agent", "system", "mcp"]) {
      const out = await call<{ error?: { code: string }; status?: string }>(
        "projects_clientReportSend",
        { reportId: saved.reportId },
        { origin },
      )
      expect({ origin, code: out.error?.code ?? out.status }).toEqual({
        origin,
        code: "APPROVAL_REQUIRED",
      })
    }
    const [row] = extractRows<{ status: string; sections_sent: unknown }>(
      await db.execute(drizzleSql`
        SELECT status, sections_sent FROM app_projects.client_reports WHERE id = ${saved.reportId}::uuid`),
    )
    expect(row).toEqual({ status: "draft", sections_sent: null })
    expect(mail.sent.filter((m) => m.template === "projects.client-report")).toHaveLength(0)
  })

  it("a person's approved send writes what went out once, mails the same text and shows it on the portal", async () => {
    const saved = await draft(week(2), [
      summary("The home page is live."),
      progress("Checkout moved to review."),
    ])
    const out = await call<{ status: string; message: string }>(
      "projects_clientReportSend",
      { reportId: saved.reportId },
      {
        origin: "in-app-agent",
        approval: {
          approvalRequestId: crypto.randomUUID(),
          approvalDeciderId: lead,
          toolName: "projects:client_report_send",
        },
      },
    )
    expect(out.status).toBe("sent")
    const sentMail = mail.sent.find(
      (m) => m.template === "projects.client-report" && m.to === clientEmail,
    )
    expect(sentMail).toBeDefined()
    const [row] = extractRows<{ sections_sent: Array<{ heading: string; text: string }> }>(
      await db.execute(drizzleSql`
        SELECT sections_sent FROM app_projects.client_reports WHERE id = ${saved.reportId}::uuid`),
    )
    for (const s of row!.sections_sent) {
      expect(sentMail!.text).toContain(s.text)
      expect(sentMail!.text).toContain(s.heading)
    }
    // The client of the company reads the same sections, and nothing of the draft's sources.
    const portalPerson = crypto.randomUUID()
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, user_type, company_id)
      VALUES (${portalPerson}::uuid, ${orgId}::uuid, ${`p-${portalPerson.slice(0, 8)}@corail.example.com`},
              'Claire Portail', 'external', ${companyId}::uuid)`)
    await db.execute(drizzleSql`
      INSERT INTO kernel.portal_people (user_id, org_id, company_id, contact_id, title)
      VALUES (${portalPerson}::uuid, ${orgId}::uuid, ${companyId}::uuid, ${clientContact}::uuid, 'Client')`)
    const seen = await withPortalContext({ orgId, userId: portalPerson } as never, async (tx) =>
      extractRows<Record<string, unknown>>(
        await tx.execute(drizzleSql`SELECT * FROM portal.client_reports`),
      ),
    )
    const mine = seen.find((r) => r.id === saved.reportId)
    expect(mine?.sections_sent).toEqual(row!.sections_sent)
    expect(mine?.sent_by_name).toBe(leadName)
    expect(Object.keys(mine ?? {}).sort()).toEqual(
      ["id", "period_end", "project_id", "sections_sent", "sent_at", "sent_by_name"].sort(),
    )
    // Written once: neither a second save nor a direct update changes what went out.
    const again = await draft(week(2), [summary("Rewritten after the fact.")])
    expect((again as { error?: { code: string } }).error?.code).toBe("REPORT_SENT")
    const rewrite = async () => {
      await db.execute(drizzleSql`
        UPDATE app_projects.client_reports SET sections_sent = '[]'::jsonb WHERE id = ${saved.reportId}::uuid`)
    }
    await expect(rewrite()).rejects.toThrow()
  })

  it("the send tool parks for a person and no auto-approve policy can take it", async () => {
    const manifest = (await import("~/apps/projects/app.manifest.json")).default as {
      tools: Record<string, Record<string, unknown>>
      routines: Record<string, { promptTemplate: string; scopes: string[] }>
    }
    const send = manifest.tools.client_report_send!
    expect(send.gated).toBe(true)
    expect(send.noAutoApprove).toBe(true)
    expect(send.approvalExpiryHours).toBe(72)
    // The routine template drafts only: it holds no tool that sends.
    const routine = manifest.routines["client-reports"]!
    expect(routine.promptTemplate).not.toContain("client_report_send")
  })
})

describe("what a report may say follows the shares", () => {
  it("a section of a kind not shared is refused when saved, and a share closed after the draft stops the send", async () => {
    const hours = { kind: "project_hours", heading: "Hours", text: "Twelve hours so far." }
    const refused = await draft(week(3), [summary("Fine."), hours])
    expect((refused as { error?: { code: string } }).error?.code).toBe("SHARE_CLOSED")
    const saved = await draft(week(3), [summary("Fine."), progress("Design approved.")])
    await db.execute(drizzleSql`
      UPDATE kernel.portal_shares SET closed_at = now() WHERE id = ${progressShare}::uuid`)
    try {
      const out = await call<{ error?: { code: string } }>("projects_clientReportSendPreflight", {
        reportId: saved.reportId,
      })
      expect(out.error?.code).toBe("SHARE_CLOSED")
      const sent = await call<{ error?: { code: string } }>("projects_clientReportSend", {
        reportId: saved.reportId,
      })
      expect(sent.error?.code).toBe("SHARE_CLOSED")
    } finally {
      await db.execute(drizzleSql`
        UPDATE kernel.portal_shares SET closed_at = NULL WHERE id = ${progressShare}::uuid`)
    }
  })
})

describe("the sources of a report", () => {
  it("hold task titles and statuses, never a task's comments, a person or real time", async () => {
    const task = await call<{ id: string }>("projects_createTask", {
      projectId,
      title: "Ship the checkout page",
    })
    await call("projects_addComment", {
      taskId: task.id,
      body: "Internal: the client underpaid last month, keep this quiet",
    })
    const today = new Date().toISOString().slice(0, 10)
    const out = await call<Record<string, any>>("projects_clientReportSources", {
      projectId,
      until: today,
    })
    expect(out.tasks.map((t: { title: string }) => t.title)).toContain("Ship the checkout page")
    const text = JSON.stringify(out)
    expect(text).not.toContain("underpaid")
    expect(text).not.toContain(lead)
    expect(text).not.toContain(leadName)
    expect(text).not.toMatch(/assignee|minutes_by|userId/i)
    expect(out.hours).toBeNull()
  })

  it("a project with time and budgets off gives no hours, even with the hours share open", async () => {
    const share = crypto.randomUUID()
    await db.execute(drizzleSql`
      INSERT INTO kernel.portal_shares (id, org_id, company_id, kind, object_id, shared_by_user_id)
      VALUES (${share}::uuid, ${orgId}::uuid, ${companyId}::uuid, 'project_hours', ${projectId}::uuid, ${owner.userId}::uuid)`)
    try {
      await db.execute(drizzleSql`
        INSERT INTO app_projects.project_time_plan (org_id, project_id, basis)
        VALUES (${orgId}::uuid, ${projectId}::uuid, 'retainer') ON CONFLICT DO NOTHING`)
      const off = await call<Record<string, any>>("projects_clientReportSources", { projectId })
      expect(off.openKinds).toContain("project_hours")
      expect(off.hours).toBeNull()
    } finally {
      await db.execute(drizzleSql`
        UPDATE kernel.portal_shares SET closed_at = now() WHERE id = ${share}::uuid`)
    }
  })

  it("without a project, lists only the projects whose reports are shared", async () => {
    const out = await call<{ projects: Array<{ projectId: string }> }>(
      "projects_clientReportSources",
      {},
    )
    expect(out.projects.map((p) => p.projectId)).toEqual([projectId])
  })
})

describe("the card warns the person approving", () => {
  async function warningsFor(text: string) {
    return withRlsContext(actorOf(lead), (tx) =>
      clientReportWarnings(
        { tx, orgId },
        {
          project_id: projectId,
          company_id: companyId,
          sections: [{ kind: "project_reports", heading: "Summary", text }],
        },
      ),
    )
  }

  it("on text matching an internal note of the project, naming the words", async () => {
    const w = await warningsFor("Good week. The client underpaid last month, as we know.")
    expect(w).toContainEqual({ kind: "internal_note", words: "the client underpaid last" })
  })

  it("on a member's name, once, and never on the client's own contact", async () => {
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, user_type)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`cf-${crypto.randomUUID().slice(0, 6)}@team.example.com`},
              'Claire Fontaine', 'member')`)
    const w = await warningsFor(
      `${leadName} finished the page. ${leadName} also reviewed it with Claire Fontaine.`,
    )
    expect(w.filter((x) => x.kind === "member_name")).toEqual([
      { kind: "member_name", words: leadName },
    ])
  })

  it("a clean report raises no warning, and the warning is on the card before Approve", async () => {
    expect(await warningsFor("The home page is live and checkout moved to review.")).toEqual([])
    const saved = await draft(week(4), [summary(`${leadName} shipped the page.`)])
    const { summarizeClientReportSend } = await import("~/apps/projects/summarizers")
    const card = await withRlsContext(actorOf(lead), (tx) =>
      summarizeClientReportSend({ reportId: saved.reportId }, { tx, orgId, userId: lead }),
    )
    expect(card.lines?.[0]).toBe(`Warning: names a member of your team: ${leadName}`)
    expect(reportText([{ kind: "project_reports", heading: "A", text: "B" }])).toBe("A\n\nB")
  })
})

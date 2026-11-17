// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the kernel's events change for client reports, on the real database: a send card a
// person rejects, or that expires, closes the draft and sends nothing; a person opening a
// project's reports share turns the Friday routine on once, in the org's own time zone; a
// waiting draft is a Home row for the project's lead; a client's milestone answer moves nothing.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  onClientReportCardClosed,
  onMilestoneClientActionDecided,
  onReportsShareOpened,
} from "~/apps/projects/handlers"
import { extractRows, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { type EmailMessage, type EmailProvider, setSystemEmailProvider } from "~/infra/email"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { CLIENT_REPORT_WAITING_KIND, computeAttentionItems } from "../attention"

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
let companyId = ""
let clientContact = ""
let projectId = ""
let threadId = ""
const mail = new Capture()

function actorOf(userId: string, scopes: string[] = REPORT_SCOPES): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function call<T = Record<string, any>>(method: string, input: unknown): Promise<T> {
  const a = actorOf(lead)
  return withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      { name: "projects" },
      a.scopes,
      "user",
      undefined,
      { origin: "human-ui" } as never,
    )
    return JSON.parse(await bridge[method](JSON.stringify(input))) as T
  })
}

/** Runs a projects subscriber as a cross-app kernel event runs it: privileged, as the app. */
async function asEvent<T>(fn: (ctx: any) => Promise<T>): Promise<T> {
  return withPrivilegedDb(orgId, "test-projects-event", async (tx) =>
    fn(
      createRpcBridge(
        "projects",
        "system:projects",
        orgId,
        tx as never,
        { name: "projects" },
        [],
        "system",
      ),
    ),
  )
}

async function draft(periodEnd: string) {
  const out = await call<{ reportId: string }>("projects_clientReportSaveDraft", {
    projectId,
    periodEnd,
    sections: [{ kind: "project_reports", heading: "Summary", text: "The home page is live." }],
    recipientContactId: clientContact,
  })
  return out.reportId
}

async function card(reportId: string, status: string): Promise<string> {
  const id = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.approval_requests", {
      id,
      org_id: orgId,
      handle: `ap-${id.slice(0, 8)}`,
      thread_id: threadId,
      originating_thread_id: threadId,
      tool_name: "projects:client_report_send",
      tool_params: { raw: `'${JSON.stringify({ reportId })}'::jsonb` },
      current_payload: { raw: `'${JSON.stringify({ reportId })}'::jsonb` },
      expires_at: { raw: "now() + interval '1 day'" },
      requested_by: lead,
      status,
      reason: "gated",
      summary: { raw: `'{"kind":"client_report_send","title":"Send","lines":[]}'::jsonb` },
    }),
  )
  return id
}

async function statusOf(reportId: string): Promise<string> {
  const [r] = extractRows<{ status: string }>(
    await db.execute(
      drizzleSql`SELECT status FROM app_projects.client_reports WHERE id = ${reportId}::uuid`,
    ),
  )
  return r?.status ?? ""
}

async function homeRows(userId = lead, scopes = REPORT_SCOPES) {
  const items = await withRlsContext(actorOf(userId, scopes), (tx) =>
    computeAttentionItems(tx, orgId, userId),
  )
  return items.filter((i) => (i.kind as string) === CLIENT_REPORT_WAITING_KIND)
}

async function openShare(kind: string, by: string): Promise<string> {
  const { setPortalShare } = await import("~/modules/portal/access")
  const out = await withRlsContext(actorOf(by, ["*"]), (tx) =>
    setPortalShare({
      orgId,
      actorId: by,
      db: tx,
      companyId,
      kind: kind as never,
      objectId: projectId,
      open: true,
    }),
  )
  return out.id as string
}

async function reportRoutines() {
  return extractRows<{ owner: string; timezone: string; cron: string }>(
    await db.execute(drizzleSql`
      SELECT owner_user_id::text AS owner, timezone, cron FROM kernel.routines
       WHERE org_id = ${orgId}::uuid AND app_name = 'projects' AND template_key = 'client-reports'`),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  setSystemEmailProvider(mail)
  orgId = (await createTestOrg()).id
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET timezone = 'Europe/Paris' WHERE id = ${orgId}::uuid`,
  )
  owner = await minimal.adminSession(orgId)
  const l = await minimal.session(orgId, { role: "member" })
  lead = l.userId
  for (const s of REPORT_SCOPES) await minimal.grantScope(lead, s)
  threadId = await minimal.thread(orgId, lead)
  const tag = crypto.randomUUID().slice(0, 8)
  companyId = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.companies", {
      id: companyId,
      org_id: orgId,
      handle: `ev-${tag}`,
      name: "Maison Ocre",
    }),
  )
  clientContact = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.contacts", {
      id: clientContact,
      org_id: orgId,
      handle: `jeanne-${tag}`,
      name: "Jeanne Ocre",
      email: `jeanne-${tag}@ocre.example.com`,
      company_id: companyId,
    }),
  )
  projectId = (await call<{ id: string }>("projects_createProject", { name: "Maison Ocre site" }))
    .id
  await db.execute(drizzleSql`
    UPDATE app_projects.projects SET company_id = ${companyId}::uuid, owner_id = ${lead}::uuid
     WHERE id = ${projectId}::uuid`)
}, 180_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("a person opening a project's reports share", () => {
  it("turns the report routine on once, owned by that person, at Friday 15:00 in the org's own time zone", async () => {
    expect(await reportRoutines()).toEqual([])
    // A progress share is not a reports share: nothing is turned on.
    const progress = await openShare("project_progress", owner.userId)
    expect(
      await asEvent((ctx) =>
        onReportsShareOpened({ data: { shareId: progress, kind: "project_progress" } }, ctx),
      ),
    ).toEqual({ status: "ignored" })
    const reports = await openShare("project_reports", owner.userId)
    const out = (await asEvent((ctx) =>
      onReportsShareOpened({ data: { shareId: reports, kind: "project_reports" } }, ctx),
    )) as { status: string; timezone?: string }
    expect(out.status).toBe("enabling")
    // Created once the event's transaction ends.
    for (let i = 0; i < 50 && (await reportRoutines()).length === 0; i++) await Bun.sleep(100)
    expect(await reportRoutines()).toEqual([
      { owner: owner.userId, timezone: "Europe/Paris", cron: "0 15 * * 5" },
    ])
    // The same event again, or another person's share, adds no second routine.
    const again = (await asEvent((ctx) =>
      onReportsShareOpened({ data: { shareId: reports, kind: "project_reports" } }, ctx),
    )) as { status: string }
    expect(again.status).toBe("ignored")
    expect(await reportRoutines()).toHaveLength(1)
  })

  it("a share id the event names but nobody opened turns nothing on", async () => {
    const out = (await asEvent((ctx) =>
      onReportsShareOpened(
        { data: { shareId: crypto.randomUUID(), kind: "project_reports" } },
        ctx,
      ),
    )) as { status: string }
    expect(out.status).toBe("ignored")
  })
})

describe("a waiting client report draft", () => {
  it("is a Home row for the project's lead until its card is rejected, which closes it and sends nothing", async () => {
    const reportId = await draft("2031-03-07")
    const rows = await homeRows()
    expect(rows.map((r) => r.entityId)).toContain(reportId)
    const row = rows.find((r) => r.entityId === reportId)!
    expect(row.summary).toContain("week ending 2031-03-07")
    expect(row.summary).toContain("Nothing has gone to the client")
    expect(row.action).toEqual({
      type: "open_entity",
      tabType: "projects:project",
      entityId: projectId,
    })
    // A colleague who does not lead the project gets no row.
    expect(await homeRows(owner.userId, ["*"])).toEqual([])
    // A pending card changes nothing; a rejected one closes the draft.
    const pending = await card(reportId, "pending")
    expect(
      await asEvent((ctx) =>
        onClientReportCardClosed(
          { data: { id: pending, toolName: "projects:client_report_send", status: "pending" } },
          ctx,
        ),
      ),
    ).toEqual({ status: "ignored" })
    const denied = await card(reportId, "denied")
    const out = (await asEvent((ctx) =>
      onClientReportCardClosed(
        { data: { id: denied, toolName: "projects:client_report_send", status: "denied" } },
        ctx,
      ),
    )) as { status: string }
    expect(out.status).toBe("rejected")
    expect(await statusOf(reportId)).toBe("rejected")
    expect((await homeRows()).map((r) => r.entityId)).not.toContain(reportId)
    expect(mail.sent.filter((m) => m.template === "projects.client-report")).toHaveLength(0)
  })

  it("an expired card closes the draft as expired and sends nothing", async () => {
    const reportId = await draft("2031-03-14")
    const expired = await card(reportId, "expired")
    const out = (await asEvent((ctx) =>
      onClientReportCardClosed(
        { data: { id: expired, toolName: "projects:client_report_send", status: "expired" } },
        ctx,
      ),
    )) as { status: string }
    expect(out.status).toBe("expired")
    expect(await statusOf(reportId)).toBe("expired")
    expect(mail.sent.filter((m) => m.template === "projects.client-report")).toHaveLength(0)
  })

  it("an event's words are not trusted: a card still pending, another tool's card or a sent report stay as they are", async () => {
    const reportId = await draft("2031-03-21")
    const pending = await card(reportId, "pending")
    // The event claims the card was denied; the card itself is still pending.
    await asEvent((ctx) =>
      onClientReportCardClosed(
        { data: { id: pending, toolName: "projects:client_report_send", status: "denied" } },
        ctx,
      ),
    )
    expect(await statusOf(reportId)).toBe("draft")
    expect(
      await asEvent((ctx) =>
        onClientReportCardClosed(
          { data: { id: pending, toolName: "projects:update_project", status: "denied" } },
          ctx,
        ),
      ),
    ).toEqual({ status: "ignored" })
    await db.execute(drizzleSql`
      UPDATE app_projects.client_reports SET sections_sent = sections, status = 'sent', sent_at = now()
       WHERE id = ${reportId}::uuid`)
    const denied = await card(reportId, "denied")
    await asEvent((ctx) =>
      onClientReportCardClosed(
        { data: { id: denied, toolName: "projects:client_report_send", status: "denied" } },
        ctx,
      ),
    )
    expect(await statusOf(reportId)).toBe("sent")
  })
})

describe("a client's answer on a milestone", () => {
  // Any call on the run's methods is a write this subscriber must not make.
  const noCalls = new Proxy(
    {},
    {
      get(_t, name) {
        throw new Error(`the milestone subscriber called ${String(name)}`)
      },
    },
  )

  it("moves nothing by itself, and another app's or type's decision is left alone at once", async () => {
    expect(
      await onMilestoneClientActionDecided(
        {
          data: {
            decision: "approved",
            target: { app: "projects", type: "milestone", id: crypto.randomUUID() },
          },
        },
        noCalls as never,
      ),
    ).toEqual({ status: "recorded", decision: "approved" })
    for (const target of [
      { app: "invoicing", type: "document" },
      { app: "agreements", type: "milestone" },
      { app: "projects", type: "task" },
    ]) {
      expect(
        await onMilestoneClientActionDecided(
          { data: { decision: "approved", target } },
          noCalls as never,
        ),
      ).toEqual({ status: "ignored" })
    }
  })
})

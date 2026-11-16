// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The rows the portal read doors need on top of the door world: projects with
// milestones and time, tickets with their messages, files, and invoicing documents.
// Written on the privileged connection; every read under test runs on the portal's
// own login. `dropReadsWorld` removes them before the door world is dropped.
import { sql } from "~/db"
import { registerApps } from "~/modules/apps/runtime"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"
import invoicingManifest from "../../../../../../bundled-apps/invoicing/app.manifest.json"
import type { DoorWorld } from "./fixture"

/** Registers the invoicing app's schema (and with it its portal views) for one org. */
export async function registerInvoicingSchema(orgId: string): Promise<void> {
  const desc = {
    ...invoicingManifest,
    _format: "manifest" as const,
    _firstParty: true,
    _bundlePath: new URL(
      `../../../../../../bundled-apps/.source/invoicing/${invoicingManifest.version}/bundle.js`,
      import.meta.url,
    ).pathname,
  } as unknown as Parameters<typeof registerApps>[0][number]
  const { failedApps } = await registerApps([desc], orgId, { skipOrgRows: true })
  if (failedApps.length > 0) throw new Error(`invoicing did not register: ${failedApps.join(", ")}`)
}

async function insert(table: string, rows: Record<string, RowValue> | Record<string, RowValue>[]) {
  await sql.unsafe(insertSql(table, rows))
}

let keySeq = 0
function projectKey(): string {
  keySeq += 1
  return `P${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 6)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "X")}${keySeq % 10}`
}

export interface ProjectSeed {
  id: string
  milestoneId: string
  childDoneId: string
  childOpenId: string
  doneStatusId: string
  openStatusId: string
  threadId: string
}

/** A work project of a company with one milestone and two child tasks (one done). */
export async function insertProject(
  w: DoorWorld,
  values: { company_id: string | null; basis?: string; time_budgets_on?: boolean; name?: string },
): Promise<ProjectSeed> {
  const id = crypto.randomUUID()
  const threadId = crypto.randomUUID()
  const doneStatusId = crypto.randomUUID()
  const openStatusId = crypto.randomUUID()
  const milestoneId = crypto.randomUUID()
  const childDoneId = crypto.randomUUID()
  const childOpenId = crypto.randomUUID()
  await insert("kernel.threads", {
    id: threadId,
    org_id: w.orgId,
    handle: `thread-${threadId.slice(0, 8)}`,
    created_by: w.admin.userId,
  })
  await insert("app_projects.projects", {
    id,
    org_id: w.orgId,
    name: values.name ?? "Site redesign",
    key: projectKey(),
    owner_id: w.admin.userId,
    kind: "work",
    company_id: values.company_id,
    time_budgets_on: values.time_budgets_on ?? true,
  })
  await insert("app_projects.project_statuses", [
    {
      id: openStatusId,
      org_id: w.orgId,
      project_id: id,
      label: "Doing",
      '"order"': 1,
      terminal: false,
    },
    {
      id: doneStatusId,
      org_id: w.orgId,
      project_id: id,
      label: "Done",
      '"order"': 2,
      terminal: true,
    },
  ])
  const task = (
    tid: string,
    title: string,
    status: string,
    n: number,
    extra: Record<string, RowValue>,
  ) => ({
    id: tid,
    org_id: w.orgId,
    project_id: id,
    status_id: status,
    title,
    thread_id: threadId,
    created_by: w.admin.userId,
    number: n,
    is_milestone: false,
    parent_task_id: null,
    due_date: null,
    ...extra,
  })
  await insert("app_projects.tasks", [
    task(milestoneId, "Design approved", openStatusId, 1, {
      is_milestone: true,
      due_date: "2026-12-01",
    }),
  ])
  await insert("app_projects.tasks", [
    task(childDoneId, "Wireframes", doneStatusId, 2, { parent_task_id: milestoneId }),
    task(childOpenId, "Mockups", openStatusId, 3, { parent_task_id: milestoneId }),
  ])
  if (values.basis) {
    await insert("app_projects.project_time_plan", {
      project_id: id,
      org_id: w.orgId,
      basis: values.basis,
    })
  }
  return { id, milestoneId, childDoneId, childOpenId, doneStatusId, openStatusId, threadId }
}

/** A timebox around today: the retainer's current period. */
export async function insertCurrentTimebox(w: DoorWorld, projectId: string, minutes: number) {
  await insert("app_projects.project_timeboxes", {
    org_id: w.orgId,
    project_id: projectId,
    period_start: { raw: "date_trunc('month', current_date)::date" },
    period_end: { raw: "(date_trunc('month', current_date) + interval '1 month - 1 day')::date" },
    minutes,
    source: "retainer",
  })
}

/** Time recorded on a task today, by a member. */
export async function insertTime(w: DoorWorld, p: ProjectSeed, taskId: string, minutes: number) {
  await insert("app_projects.task_time", {
    org_id: w.orgId,
    task_id: taskId,
    project_id: p.id,
    user_id: w.member.userId,
    work_date: { raw: "current_date" },
    minutes,
    entered_via: "field",
  })
}

/** A billed reconciliation line of `minutes` on the project. */
export async function insertBilledLine(w: DoorWorld, projectId: string, minutes: number) {
  const recId = crypto.randomUUID()
  const lineId = crypto.randomUUID()
  await insert("app_projects.reconciliations", {
    id: recId,
    org_id: w.orgId,
    project_id: projectId,
    basis: "hourly",
    state: "invoiced",
    created_by: w.admin.userId,
  })
  await insert("app_projects.reconciliation_lines", {
    id: lineId,
    org_id: w.orgId,
    reconciliation_id: recId,
    position: 1,
    bill_minutes: minutes,
  })
  await insert("app_projects.billing_claims", {
    org_id: w.orgId,
    project_id: projectId,
    reconciliation_id: recId,
    line_id: lineId,
    source_kind: "line",
    source_ref: lineId,
    period_key: "2026-11",
    state: "billed",
  })
}

/** A ticket of a contact, stamped or not, with one inbound, one outbound and one note. */
export async function insertTicket(
  w: DoorWorld,
  values: {
    company_id: string | null
    contact_id: string
    channel?: string
    sensitivity?: string
    subject?: string
  },
): Promise<{ id: string; inboundId: string; outboundId: string; noteId: string }> {
  const id = crypto.randomUUID()
  await insert("app_tickets.tickets", {
    id,
    org_id: w.orgId,
    handle: `ticket-${id.slice(0, 8)}`,
    subject: values.subject ?? "A question about the site",
    status: "open",
    channel: values.channel ?? "portal",
    sensitivity: values.sensitivity ?? "internal",
    contact_id: values.contact_id,
    company_id: values.company_id,
    sla_target_seconds: 86400,
    reply_token: crypto.randomUUID(),
  })
  const msg = (kind: string, text: string, extra: Record<string, RowValue> = {}) => ({
    id: crypto.randomUUID(),
    org_id: w.orgId,
    ticket_id: id,
    kind,
    from_name: kind === "inbound" ? "The client" : "Studio",
    text_body: text,
    html_body: `<p>${text}</p>`,
    sent_at: { raw: "now()" },
    author_label: null,
    author_agent_id: null,
    ...extra,
  })
  const inbound = msg("inbound", "Could you look at the header?")
  const outbound = msg("outbound", "Done, have a look.", { author_label: "Elodie" })
  const note = msg("note", "internal: client is slow to pay")
  await insert("app_tickets.messages", [inbound, outbound, note])
  return {
    id,
    inboundId: String(inbound.id),
    outboundId: String(outbound.id),
    noteId: String(note.id),
  }
}

/** A file row on a parent; its bytes are never read in these tests unless allowed. */
export async function insertFile(
  w: DoorWorld,
  parent: { app: string; entity_type: string; entity_id: string },
  values: { enc_version?: number } = {},
): Promise<string> {
  const id = crypto.randomUUID()
  await insert("kernel.files", {
    id,
    org_id: w.orgId,
    ...parent,
    filename: "brief.pdf",
    mime_type: "application/pdf",
    size_bytes: 12,
    storage_key: `${w.orgId}/portal-doors/${id}`,
    enc_version: values.enc_version ?? 0,
  })
  return id
}

/** Removes the rows above for the world's first org. */
export async function dropReadsWorld(w: DoorWorld): Promise<void> {
  const org = w.orgId
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE liaison_admin")
    await tx.unsafe("SELECT set_config('liaison.demo_purge_org', $1, true)", [org])
    for (const table of [
      "app_projects.task_time",
      "app_projects.billing_claims",
      "app_projects.reconciliation_lines",
      "app_projects.reconciliations",
      "app_projects.project_timeboxes",
      "app_projects.project_time_plan",
    ]) {
      await tx.unsafe(`DELETE FROM ${table} WHERE org_id = $1`, [org])
    }
    await tx.unsafe(
      "DELETE FROM app_projects.tasks WHERE org_id = $1 AND parent_task_id IS NOT NULL",
      [org],
    )
    await tx.unsafe("DELETE FROM app_projects.tasks WHERE org_id = $1", [org])
    await tx.unsafe("DELETE FROM app_projects.project_statuses WHERE org_id = $1", [org])
    await tx.unsafe("DELETE FROM app_projects.projects WHERE org_id = $1", [org])
    await tx.unsafe("DELETE FROM app_tickets.messages WHERE org_id = $1", [org])
    await tx.unsafe("DELETE FROM app_tickets.tickets WHERE org_id = $1", [org])
    await tx.unsafe("DELETE FROM kernel.threads WHERE org_id = $1", [org])
    await tx.unsafe("DELETE FROM kernel.files WHERE org_id = $1", [org])
    const [inv] = await tx.unsafe(
      "SELECT to_regclass('app_invoicing.documents') IS NOT NULL AS present",
    )
    if (inv?.present) {
      await tx.unsafe("DELETE FROM app_invoicing.billing_steps WHERE org_id = $1", [org])
      await tx.unsafe("DELETE FROM app_invoicing.document_lines WHERE org_id = $1", [org])
      await tx.unsafe("DELETE FROM app_invoicing.documents WHERE org_id = $1", [org])
      await tx.unsafe("DELETE FROM app_invoicing.issuer_profiles WHERE org_id = $1", [org])
    }
  })
}

/** An invoicing document of the world's first org, with one line and a PDF file. */
export async function insertDocument(
  w: DoorWorld,
  issuerId: string,
  values: {
    company_id: string | null
    type?: string
    status?: string
    issued?: boolean
    notes?: string
    original_document_id?: string | null
  },
): Promise<{ id: string; pdfFileId: string }> {
  const id = crypto.randomUUID()
  const pdfFileId = await insertFile(w, { app: "invoicing", entity_type: "pdf", entity_id: id })
  await insert("app_invoicing.documents", {
    id,
    org_id: w.orgId,
    type: values.type ?? "invoice",
    status: values.status ?? "issued",
    issuer_profile_id: issuerId,
    currency: "EUR",
    number: values.issued === false ? null : `INV-${id.slice(0, 6)}`,
    issued_at: values.issued === false ? null : { raw: "now()" },
    subtotal_minor: 10000,
    tax_total_minor: 2000,
    grand_total_minor: 12000,
    pdf_file_id: pdfFileId,
    notes: values.notes ?? "internal note: late payer",
    company_id: values.company_id,
    original_document_id: values.original_document_id ?? null,
  })
  await insert("app_invoicing.document_lines", {
    org_id: w.orgId,
    document_id: id,
    position: 1,
    description: "Design sprint",
    quantity: 1,
    unit_price_minor: 10000,
    subtotal_minor: 10000,
    tax_minor: 2000,
    total_minor: 12000,
  })
  return { id, pdfFileId }
}

/** The issuer profile every document of the world is issued by. */
export async function insertIssuer(w: DoorWorld): Promise<string> {
  const id = crypto.randomUUID()
  await insert("app_invoicing.issuer_profiles", {
    id,
    org_id: w.orgId,
    legal_name: w.orgName,
    country: "FR",
    default_currency: "EUR",
  })
  return id
}

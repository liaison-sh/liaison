// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `tickets:create` and `tickets:addNote` take Liaison file ids in `attachments`,
// like `tickets:reply`: the files land on the new message (the initial message
// or the note), and the same checks apply. A file is attachable only when the
// caller can read it under its own RLS context, in its own org, and its type is
// not on the stored-file denylist; at most 10 files per call. A refused call
// creates nothing.
//
// Driven through the real tool dispatch (executeTool -> sandbox handler ->
// tickets bridge) as a plain support member: scopes `tickets:tickets:*`, no
// dimension grants, so only team-less tickets (and their files) are visible.

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { putObject } from "~/infra/storage/object-storage"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg, reloadInstalledApps } from "~/modules/apps/init"

const SUPPORT_SCOPES = ["tickets:tickets:read", "tickets:tickets:write", "tickets:tickets:reply"]

let orgId = ""
let userId = ""
let otherOrgFileId = ""
let visibleTicketId = ""
const ids: Record<"pdf" | "png" | "csv" | "exe" | "hidden", string> = {
  pdf: "",
  png: "",
  csv: "",
  exe: "",
  hidden: "",
}

async function seedOrg(label: string) {
  const slug = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let org = ""
  let user = ""
  await withSystemDb(`${label}-fixture`, async (tx) => {
    org = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Create Attachments Org', ${slug}) RETURNING id`),
    )[0]!.id
    user = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${org}, ${`${slug}@test.com`}, 'Support Member', 'active', 'hash', 1, 1)
        RETURNING id`),
    )[0]!.id
  })
  return { org, user, slug }
}

/** A ticket with one inbound message, in `team` (null = visible to everyone). */
async function seedSourceMessage(org: string, slug: string, team: string | null) {
  return withSystemDb("create-attachments-source", async (tx) => {
    const ticketId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, team, sensitivity,
          reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
          sla_elapsed_seconds, message_count, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${org}, ${`ticket-${slug}-${team ?? "none"}`}, 'Source', 'open', 'normal',
          'email', ${team}, 'internal', ${`S${slug}${team ?? "n"}`.slice(0, 40)}, 3600,
          now() + interval '1 hour', now(), 0, 1, now(), now()
        ) RETURNING id`),
    )[0]!.id
    const messageId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, from_email, sent_at, created_at)
        VALUES (gen_random_uuid(), ${org}, ${ticketId}, 'inbound', 'customer@test.com', now(), now())
        RETURNING id`),
    )[0]!.id
    return { ticketId, messageId }
  })
}

async function seedFile(
  org: string,
  messageId: string,
  filename: string,
  mimeType: string,
): Promise<string> {
  const body = Buffer.from(`bytes of ${filename}\n`)
  const storageKey = `orgs/${org}/tickets/message/${messageId}/${crypto.randomUUID()}/${filename}`
  await putObject({ key: storageKey, body, contentType: mimeType })
  return withSystemDb(
    "create-attachments-file",
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
        INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key)
        VALUES (gen_random_uuid(), ${org}, 'tickets', 'message', ${messageId}, ${filename}, ${mimeType},
                ${body.byteLength}, ${storageKey})
        RETURNING id::text AS id`),
      )[0]!.id,
  )
}

beforeAll(async () => {
  const a = await seedOrg("create-att")
  orgId = a.org
  userId = a.user
  const visible = await seedSourceMessage(orgId, a.slug, null)
  visibleTicketId = visible.ticketId
  const hidden = await seedSourceMessage(orgId, a.slug, "support-us")
  ids.pdf = await seedFile(orgId, visible.messageId, "report.pdf", "application/pdf")
  ids.png = await seedFile(orgId, visible.messageId, "screenshot.png", "image/png")
  ids.csv = await seedFile(orgId, visible.messageId, "logs.csv", "text/csv")
  ids.exe = await seedFile(orgId, visible.messageId, "setup.exe", "application/x-msdownload")
  ids.hidden = await seedFile(orgId, hidden.messageId, "secret.pdf", "application/pdf")

  const b = await seedOrg("create-att-other")
  const otherSource = await seedSourceMessage(b.org, b.slug, null)
  otherOrgFileId = await seedFile(b.org, otherSource.messageId, "other.pdf", "application/pdf")

  for (const org of [orgId, b.org]) {
    await ensureAppsForOrg(org, {})
    // The kernel.files SELECT policy is rebuilt from the fileParent registry
    // at boot; force the rebuild (attachment-visibility.rls.test.ts).
    await reloadInstalledApps(org)
  }
})

function actor() {
  return {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: SUPPORT_SCOPES,
    dimensionGrants: {},
  }
}

async function call<T>(toolName: string, params: Record<string, unknown>): Promise<T> {
  const out = await executeTool<T>({ toolName, orgId, actor: actor(), params })
  return out.data
}

async function ticketCountWithSubject(subject: string): Promise<number> {
  return withSystemDb("create-attachments-count", async (tx) => {
    const rows = extractRows<{ n: string }>(
      await tx.execute(drizzleSql`
        SELECT COUNT(*)::text AS n FROM app_tickets.tickets
        WHERE org_id = ${orgId} AND subject = ${subject}`),
    )
    return Number(rows[0]!.n)
  })
}

async function noteCount(ticketId: string): Promise<number> {
  return withSystemDb("create-attachments-notes", async (tx) => {
    const rows = extractRows<{ n: string }>(
      await tx.execute(drizzleSql`
        SELECT COUNT(*)::text AS n FROM app_tickets.messages
        WHERE org_id = ${orgId} AND ticket_id = ${ticketId} AND kind = 'note'`),
    )
    return Number(rows[0]!.n)
  })
}

type Attachment = { id: string; filename: string; sizeBytes: number }
type GetResult = {
  messages: { items: { id: string; kind: string; attachments?: Attachment[] }[] }
}

/** A refused call rejects with the error envelope's code. */
async function expectRefused(
  toolName: string,
  params: Record<string, unknown>,
  code: string,
): Promise<void> {
  await expect(call(toolName, params)).rejects.toMatchObject({ code })
}

describe("tickets:create / tickets:addNote attachments", () => {
  it("create with two visible files -> initial message lists both attachments", async () => {
    const created = await call<{ ticketId: string; initialMessageId: string }>("tickets:create", {
      subject: `two files ${crypto.randomUUID()}`,
      initialMessage: { kind: "note", textBody: "Report with attachments" },
      attachments: [ids.pdf, ids.png],
    })
    expect(created.initialMessageId).toBeTruthy()
    const got = await call<GetResult>("tickets:get", { ticketId: created.ticketId })
    const first = got.messages.items.find((m) => m.id === created.initialMessageId)
    expect(first?.attachments?.map((a) => a.filename).sort()).toEqual([
      "report.pdf",
      "screenshot.png",
    ])
  })

  it("addNote with one file -> note carries it", async () => {
    const note = await call<{ messageId: string; ticketId: string }>("tickets:addNote", {
      ticketId: visibleTicketId,
      text: "Attachment 1: logs.csv",
      attachments: [ids.csv],
    })
    const got = await call<GetResult>("tickets:get", { ticketId: visibleTicketId })
    const added = got.messages.items.find((m) => m.id === note.messageId)
    expect(added?.kind).toBe("note")
    expect(added?.attachments?.map((a) => a.filename)).toEqual(["logs.csv"])
  })

  it("an id from another org -> parent_not_found, nothing created", async () => {
    const subject = `other org ${crypto.randomUUID()}`
    await expectRefused(
      "tickets:create",
      { subject, initialMessage: { kind: "note", textBody: "x" }, attachments: [otherOrgFileId] },
      "parent_not_found",
    )
    expect(await ticketCountWithSubject(subject)).toBe(0)
    const before = await noteCount(visibleTicketId)
    await expectRefused(
      "tickets:addNote",
      { ticketId: visibleTicketId, text: "x", attachments: [otherOrgFileId] },
      "parent_not_found",
    )
    expect(await noteCount(visibleTicketId)).toBe(before)
  })

  it("a denylisted type -> unsafe_file_type", async () => {
    const subject = `exe ${crypto.randomUUID()}`
    await expectRefused(
      "tickets:create",
      { subject, initialMessage: { kind: "note", textBody: "x" }, attachments: [ids.exe] },
      "unsafe_file_type",
    )
    expect(await ticketCountWithSubject(subject)).toBe(0)
    const before = await noteCount(visibleTicketId)
    await expectRefused(
      "tickets:addNote",
      { ticketId: visibleTicketId, text: "x", attachments: [ids.exe] },
      "unsafe_file_type",
    )
    expect(await noteCount(visibleTicketId)).toBe(before)
  })

  it("11 ids -> refused", async () => {
    const subject = `eleven ${crypto.randomUUID()}`
    const eleven = Array.from({ length: 11 }, () => ids.pdf)
    // The manifest caps the array at 10 (maxItems), so the dispatch refuses it
    // before the handler; either way nothing is created.
    await expect(
      call("tickets:create", {
        subject,
        initialMessage: { kind: "note", textBody: "x" },
        attachments: eleven,
      }),
    ).rejects.toBeDefined()
    expect(await ticketCountWithSubject(subject)).toBe(0)
    const before = await noteCount(visibleTicketId)
    await expect(
      call("tickets:addNote", { ticketId: visibleTicketId, text: "x", attachments: eleven }),
    ).rejects.toBeDefined()
    expect(await noteCount(visibleTicketId)).toBe(before)
  })

  it("an id the caller cannot read under RLS -> refused", async () => {
    const subject = `hidden ${crypto.randomUUID()}`
    await expectRefused(
      "tickets:create",
      { subject, initialMessage: { kind: "note", textBody: "x" }, attachments: [ids.hidden] },
      "parent_not_found",
    )
    expect(await ticketCountWithSubject(subject)).toBe(0)
    const before = await noteCount(visibleTicketId)
    await expectRefused(
      "tickets:addNote",
      { ticketId: visibleTicketId, text: "x", attachments: [ids.hidden] },
      "parent_not_found",
    )
    expect(await noteCount(visibleTicketId)).toBe(before)
  })

  it("attachments without an initial message -> invalid_params, nothing created", async () => {
    const subject = `no message ${crypto.randomUUID()}`
    await expectRefused("tickets:create", { subject, attachments: [ids.pdf] }, "invalid_params")
    expect(await ticketCountWithSubject(subject)).toBe(0)
  })
})

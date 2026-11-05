// SPDX-License-Identifier: FSL-1.1-ALv2
// Undo of an import run (P3a T8, A14, R5, R6): rows the run created go, a
// record edited or answered after the import is kept and listed, storage
// objects are removed, a placeholder is deleted only when nothing else uses
// it, and a run that is not final cannot be undone.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { headObject } from "~/infra/storage/object-storage"
import { insertLedgerRows } from "~/modules/imports/ledger"
import { runImport } from "~/modules/imports/runner"
import { createImportRun } from "~/modules/imports/runs"
import type { SourceItem } from "~/modules/imports/source"
import { ImportError } from "~/modules/imports/types"
import { NON_FK_PERSON_COLUMNS, undoImportRun } from "~/modules/imports/undo"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let adminId = ""
let otherOrgId = ""
let memberId = ""
const tag = () => crypto.randomUUID().slice(0, 8)

function operator(): UserContext {
  return {
    actorType: "user",
    userId: adminId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
}

function recordsOf(records: Array<Record<string, unknown>>) {
  const items: SourceItem[] = records.map((record, i) => ({ line: i + 1, record }))
  return { type: "records" as const, records: items }
}

function ticket(ref: string, withFile = false) {
  return {
    subject: `Ticket ${ref}`,
    externalRef: ref,
    messages: [
      {
        kind: "inbound",
        textBody: "first",
        ...(withFile
          ? {
              attachments: [
                {
                  filename: "log.txt",
                  mimeType: "text/plain",
                  bytesBase64: Buffer.from(`log ${ref}`).toString("base64"),
                },
              ],
            }
          : {}),
      },
      { kind: "outbound", textBody: "second", sentAt: "2025-03-01T10:00:00Z" },
    ],
  }
}

async function ticketId(label: string, ref: string): Promise<string | null> {
  const rows = await sql`
    SELECT id FROM app_tickets.tickets WHERE org_id = ${orgId} AND external_ref = ${`${label}:${ref}`}`
  return rows[0] ? String(rows[0].id) : null
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `imp-undo-${tag()}`, name: "Import Undo Org" })).orgId
  adminId = (
    await ensureUser({
      orgId,
      email: `owner-${tag()}@fabrikam.example`,
      name: "Owner",
      password: "pw-import-1!",
      role: "admin",
    })
  ).userId
  memberId = (
    await ensureUser({
      orgId,
      email: `member-${tag()}@fabrikam.example`,
      name: "Member",
      password: "pw-import-1!",
      role: "member",
    })
  ).userId
  otherOrgId = (await ensureOrg({ slug: `imp-undo-b-${tag()}`, name: "Other Org" })).orgId
}, 120_000)
afterAll(releaseTestLock)

describe("undoImportRun", () => {
  it("deletes the run's rows, keeps an edited ticket and an answered one, and lists both", async () => {
    const label = `u${tag()}`
    const [edited, answered, plain] = [`A-${tag()}`, `B-${tag()}`, `C-${tag()}`]
    const run = await runImport({
      orgId,
      actor: operator(),
      kinds: ["tickets.ticket"],
      source: recordsOf([ticket(edited), ticket(answered), ticket(plain, true)]),
      sourceLabel: label,
      mode: "cli",
    })
    expect(run.counts["tickets.ticket"]).toEqual({ created: 3, skipped: 0, failed: 0 })
    const editedId = (await ticketId(label, edited))!
    const answeredId = (await ticketId(label, answered))!
    const plainId = (await ticketId(label, plain))!
    const plainFile = await sql`
      SELECT f.storage_key FROM kernel.files f
      JOIN app_tickets.messages m ON m.id::text = f.entity_id
      WHERE m.ticket_id = ${plainId}`
    expect(plainFile.length).toBe(1)
    const storageKey = String(plainFile[0]!.storage_key)
    await headObject(storageKey)

    // After the import: someone edits one ticket and replies on another.
    await sql`UPDATE app_tickets.tickets SET subject = 'edited', updated_at = now() + interval '1 second'
              WHERE id = ${editedId}`
    await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${answeredId}::uuid, 'outbound', 'a later reply', now(), now(), now())`),
    )

    const report = await undoImportRun(orgId, run.runId, { userId: adminId })
    expect(report.refused).toEqual(
      expect.arrayContaining([
        { table: "app_tickets.tickets", id: editedId, reason: "changed_after_import" },
        { table: "app_tickets.tickets", id: answeredId, reason: "has_new_children" },
      ]),
    )
    expect(await ticketId(label, plain)).toBeNull()
    expect(await ticketId(label, edited)).toBe(editedId)
    expect(await ticketId(label, answered)).toBe(answeredId)
    // The kept tickets keep their imported messages; the deleted one's are gone.
    expect(
      (await sql`SELECT id FROM app_tickets.messages WHERE ticket_id = ${editedId}`).length,
    ).toBe(2)
    expect(
      (await sql`SELECT id FROM app_tickets.messages WHERE ticket_id = ${plainId}`).length,
    ).toBe(0)
    expect(
      await headObject(storageKey).then(
        () => "present",
        () => "gone",
      ),
    ).toBe("gone")
    const status = await sql`SELECT status FROM kernel.import_runs WHERE id = ${run.runId}`
    expect(status[0]?.status).toBe("undone")
  }, 120_000)

  it("refuses a run that is not final", async () => {
    const run = await createImportRun({
      orgId,
      kinds: ["tickets.ticket"],
      sourceLabel: "x",
      source: {},
      mode: "api",
      dryRun: false,
      placeholders: false,
      startedBy: adminId,
      status: "running",
    })
    const err = await undoImportRun(orgId, run.id, { userId: adminId }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).code).toBe("not_final")
  })

  it("deletes a placeholder only when nothing else uses it", async () => {
    const label = `p${tag()}`
    const project = `Undo ${tag()}`
    const reporter = `leaver-${tag()}@contoso.example`
    const task = (ref: string) => ({
      externalRef: ref,
      project: { name: project },
      title: `Task ${ref}`,
      reporterEmail: reporter,
      reporterName: "Former Colleague",
    })
    const importTasks = (ref: string) =>
      runImport({
        orgId,
        actor: operator(),
        kinds: ["projects.task"],
        source: recordsOf([task(ref)]),
        sourceLabel: label,
        mode: "cli",
        placeholders: true,
        kindOptions: { "projects.task": { deferIndexing: true } },
      })
    const placeholder = async () =>
      (await sql`SELECT id FROM kernel.users WHERE org_id = ${orgId} AND email = ${reporter}`)
        .length

    // Run 1 creates the placeholder, run 2 reuses it: undoing run 1 keeps it.
    const run1 = await importTasks(`P1-${tag()}`)
    const run2 = await importTasks(`P2-${tag()}`)
    expect(await placeholder()).toBe(1)
    const r1 = await undoImportRun(orgId, run1.runId, { userId: adminId })
    expect(r1.refused.some((r) => r.table === "kernel.users")).toBe(true)
    expect(await placeholder()).toBe(1)
    // Undoing run 2 removes its task; the placeholder, now unused, is in run 1's
    // ledger only (already undone), so it stays until that ledger is gone.
    await undoImportRun(orgId, run2.runId, { userId: adminId })

    // A placeholder only its own run's rows reference goes with that run.
    const solo = `solo-${tag()}@contoso.example`
    const run3 = await runImport({
      orgId,
      actor: operator(),
      kinds: ["projects.task"],
      source: recordsOf([{ ...task(`P3-${tag()}`), reporterEmail: solo }]),
      sourceLabel: label,
      mode: "cli",
      placeholders: true,
      kindOptions: { "projects.task": { deferIndexing: true } },
    })
    expect((await sql`SELECT id FROM kernel.users WHERE email = ${solo}`).length).toBe(1)
    const r3 = await undoImportRun(orgId, run3.runId, { userId: adminId })
    expect(r3.refused.filter((r) => r.table === "kernel.users")).toEqual([])
    expect((await sql`SELECT id FROM kernel.users WHERE email = ${solo}`).length).toBe(0)
  }, 120_000)

  it("pins the non-foreign-key person columns it checks", () => {
    expect(NON_FK_PERSON_COLUMNS["kernel.users"]).toEqual(
      expect.arrayContaining(["author_id", "created_by", "assignee_id", "reporter_id"]),
    )
    expect(NON_FK_PERSON_COLUMNS["kernel.contacts"]).toContain("contact_id")
  })
})

describe("undoImportRun: boundaries (skeptic CRIT 1, MAJOR 2-4, MINOR 8)", () => {
  async function doneRun(kind: string) {
    return createImportRun({
      orgId,
      kinds: [kind],
      sourceLabel: "x",
      source: {},
      mode: "cli",
      dryRun: false,
      placeholders: false,
      startedBy: adminId,
      status: "done",
    })
  }

  it("never deletes another org's row or a table without org_id, whatever the ledger says", async () => {
    // A ticket of ANOTHER org, and a ledger (as a hostile bundle could write it)
    // naming that ticket and the other org's own organizations row.
    const foreign = await withPrivilegedDb(otherOrgId, "t", async (tx) => {
      const rows = await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (id, org_id, handle, subject, status, priority, channel, reply_token, sla_target_seconds)
        VALUES (gen_random_uuid(), ${otherOrgId}::uuid, ${`ticket-x${tag()}`}, 'not yours', 'open', 'normal', 'api', ${tag() + tag()}, 3600)
        RETURNING id`)
      return extractRows<{ id: string }>(rows)[0]!.id
    })
    const run = await doneRun("tickets.ticket")
    await withPrivilegedDb(orgId, "t", (tx) =>
      insertLedgerRows(tx, {
        orgId,
        runId: run.id,
        kind: "tickets.ticket",
        recordKey: "evil",
        rows: [
          { table: "kernel.organizations", id: otherOrgId },
          { table: "app_tickets.tickets", id: foreign },
        ],
      }),
    )
    const report = await undoImportRun(orgId, run.id, { userId: adminId })
    expect(report.deleted).toBe(0)
    expect(report.refused).toContainEqual({
      table: "kernel.organizations",
      id: otherOrgId,
      reason: "not_org_scoped",
    })
    expect((await sql`SELECT id FROM kernel.organizations WHERE id = ${otherOrgId}`).length).toBe(1)
    expect((await sql`SELECT id FROM app_tickets.tickets WHERE id = ${foreign}`).length).toBe(1)
  })

  it("keeps a contact edited after the import", async () => {
    const label = `c${tag()}`
    const email = `kept-${tag()}@contoso.example`
    const run = await runImport({
      orgId,
      actor: operator(),
      kinds: ["contacts.contact"],
      source: recordsOf([{ externalId: `C-${tag()}`, name: "Kim Kept", email }]),
      sourceLabel: label,
      mode: "cli",
    })
    expect(run.counts["contacts.contact"]?.created).toBe(1)
    await sql`UPDATE kernel.contacts SET name = 'Kim Edited', updated_at = now() + interval '1 second'
              WHERE org_id = ${orgId} AND email = ${email}`
    const report = await undoImportRun(orgId, run.runId, { userId: adminId })
    expect(report.refused.map((r) => r.reason)).toEqual(["changed_after_import"])
    expect(
      (await sql`SELECT id FROM kernel.contacts WHERE org_id = ${orgId} AND email = ${email}`)
        .length,
    ).toBe(1)
  })

  it("keeps a task that gained a checklist item after the import", async () => {
    const label = `k${tag()}`
    const ref = `CK-${tag()}`
    const run = await runImport({
      orgId,
      actor: operator(),
      kinds: ["projects.task"],
      source: recordsOf([
        { externalRef: ref, project: { name: `Check ${tag()}` }, title: "Has a list" },
      ]),
      sourceLabel: label,
      mode: "cli",
      kindOptions: { "projects.task": { deferIndexing: true } },
    })
    const task =
      await sql`SELECT id FROM app_projects.tasks WHERE org_id = ${orgId} AND external_ref = ${`${label}:${ref}`}`
    const taskId = String(task[0]!.id)
    await sql`INSERT INTO app_projects.task_checklist_items (org_id, task_id, title, created_by)
              VALUES (${orgId}, ${taskId}, 'later work', ${adminId})`
    const report = await undoImportRun(orgId, run.runId, { userId: adminId })
    expect(report.refused).toContainEqual({
      table: "app_projects.tasks",
      id: taskId,
      reason: "has_new_children",
    })
    expect((await sql`SELECT id FROM app_projects.tasks WHERE id = ${taskId}`).length).toBe(1)
  })

  it("refuses a member who neither started the run nor administers the org", async () => {
    const run = await doneRun("contacts.contact")
    const err = await undoImportRun(orgId, run.id, { userId: memberId }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).code).toBe("forbidden")
  })
})

describe("undoImportRun: one savepoint per record", () => {
  it("a record whose task cannot be deleted (a later subtask holds it) keeps ALL its rows", async () => {
    const label = `sv${tag()}`
    const devEmail = `dev-${tag()}@fabrikam.example`
    await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${devEmail}, 'Dana Dev', 'active')`),
    )
    const project = `Parents ${tag()}`
    const parentRef = `PA-${tag()}`
    const opts = {
      orgId,
      actor: operator(),
      kinds: ["projects.task"],
      sourceLabel: label,
      mode: "cli" as const,
      kindOptions: { "projects.task": { deferIndexing: true } },
    }
    const run1 = await runImport({
      ...opts,
      source: recordsOf([
        {
          externalRef: parentRef,
          project: { name: project },
          title: "Parent",
          comments: [
            { authorEmail: devEmail, body: "a comment", createdAt: "2025-01-01T00:00:00Z" },
          ],
        },
      ]),
    })
    // Another run files a subtask under it: tasks.parent_task_id is ON DELETE
    // RESTRICT, so the parent's delete fails on the foreign key.
    await runImport({
      ...opts,
      source: recordsOf([
        {
          externalRef: `CH-${tag()}`,
          project: { name: project },
          title: "Child",
          parentExternalRef: parentRef,
        },
      ]),
    })
    const parent = (
      await sql`SELECT id, thread_id FROM app_projects.tasks WHERE org_id = ${orgId} AND external_ref = ${`${label}:${parentRef}`}`
    )[0]!
    const before = await sql`SELECT id FROM kernel.messages WHERE thread_id = ${parent.thread_id}`
    expect(before.length).toBe(1)

    const report = await undoImportRun(orgId, run1.runId, { userId: adminId })
    expect(report.refused.map((r) => r.reason)).toContain("still_referenced")
    // Nothing of the parent's record went: task, thread, participants, comment.
    expect((await sql`SELECT id FROM app_projects.tasks WHERE id = ${parent.id}`).length).toBe(1)
    expect((await sql`SELECT id FROM kernel.threads WHERE id = ${parent.thread_id}`).length).toBe(1)
    expect(
      (await sql`SELECT id FROM kernel.messages WHERE thread_id = ${parent.thread_id}`).length,
    ).toBe(1)
    expect(
      (await sql`SELECT id FROM kernel.thread_participants WHERE thread_id = ${parent.thread_id}`)
        .length,
    ).toBeGreaterThan(0)
  }, 120_000)
})

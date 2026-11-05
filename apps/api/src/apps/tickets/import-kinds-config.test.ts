// SPDX-License-Identifier: FSL-1.1-ALv2
// The tickets configuration import kinds: `tickets.category` (a "Parent /
// Child" path, each missing segment created top-down, existing ones reused and
// never touched) and `tickets.reply-template` (insert, an existing name is
// skipped). Imports only create (A14).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { runImport } from "~/modules/imports/runner"
import type { SourceItem } from "~/modules/imports/source"
import { undoImportRun } from "~/modules/imports/undo"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let adminId = ""
const tmpDirs: string[] = []

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

function recordsOf(records: Array<Record<string, unknown>>): {
  type: "records"
  records: SourceItem[]
} {
  return { type: "records", records: records.map((record, i) => ({ line: i + 1, record })) }
}

function importCategories(records: Array<Record<string, unknown>>, label = "cfg") {
  return runImport({
    orgId,
    actor: operator(),
    kinds: ["tickets.category"],
    source: recordsOf(records),
    sourceLabel: label,
    mode: "cli",
  })
}

async function categories(prefix: string) {
  return sql`
    SELECT c.id, c.name, p.name AS parent, c.sort_order, c.archived_at, c.updated_at
    FROM app_tickets.categories c LEFT JOIN app_tickets.categories p ON p.id = c.parent_id
    WHERE c.org_id = ${orgId} AND c.name LIKE ${`${prefix}%`}
    ORDER BY c.name`
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `imp-tcfg-${tag()}`, name: "Tickets Config Import" })).orgId
  adminId = (
    await ensureUser({
      orgId,
      email: `owner-${tag()}@fabrikam.example`,
      name: "Owner",
      password: "pw-import-1!",
      role: "admin",
    })
  ).userId
}, 120_000)

afterAll(async () => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  await releaseTestLock()
})

describe("tickets.category", () => {
  it("creates each missing segment once, top-down; a second run skips everything", async () => {
    const p = `Hw${tag()}`
    const first = await importCategories([
      { path: `${p} / Power`, sortOrder: 3 },
      { path: ` ${p}/Power ` },
      { path: `${p} / Display` },
    ])
    expect(first.counts["tickets.category"]).toEqual({ created: 2, skipped: 1, failed: 0 })
    const rows = await categories(p)
    expect(rows.map((r) => [r.name, r.parent])).toEqual([[p, null]])
    const children = await sql`
      SELECT c.name, c.sort_order FROM app_tickets.categories c
      JOIN app_tickets.categories p ON p.id = c.parent_id
      WHERE c.org_id = ${orgId} AND p.name = ${p} ORDER BY c.name`
    expect(children.map((r) => [r.name, r.sort_order])).toEqual([
      ["Display", 0],
      ["Power", 3],
    ])
    const ledger = await sql`
      SELECT table_name FROM kernel.import_ledger WHERE run_id = ${first.runId}`
    expect(ledger.length).toBe(3)

    const again = await importCategories([{ path: `${p} / Power` }, { path: `${p} / Display` }])
    expect(again.counts["tickets.category"]).toEqual({ created: 0, skipped: 2, failed: 0 })
  })

  it("reuses an existing parent without touching it, and creates only the child", async () => {
    const p = `Sw${tag()}`
    const [parent] = await sql`
      INSERT INTO app_tickets.categories (org_id, name, updated_at)
      VALUES (${orgId}, ${p}, now() - interval '3 days') RETURNING id, updated_at`
    const run = await importCategories([{ path: `${p.toLowerCase()} / Firmware`, archived: true }])
    expect(run.counts["tickets.category"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const [after] =
      await sql`SELECT updated_at, name FROM app_tickets.categories WHERE id = ${parent!.id}`
    expect(after!.updated_at).toEqual(parent!.updated_at)
    expect(after!.name).toBe(p)
    const [child] = await sql`
      SELECT archived_at FROM app_tickets.categories
      WHERE org_id = ${orgId} AND parent_id = ${parent!.id} AND name = 'Firmware'`
    expect(child!.archived_at).not.toBeNull()
    const ledger = await sql`SELECT row_id FROM kernel.import_ledger WHERE run_id = ${run.runId}`
    expect(ledger.map((r) => r.row_id)).not.toContain(parent!.id)
  })

  it("a path deeper than the category tree allows fails the record and writes nothing", async () => {
    const p = `Deep${tag()}`
    const run = await importCategories([{ path: `${p} / B / C` }])
    expect(run.counts["tickets.category"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    expect(String(run.errors[0]?.error)).toMatch(/category_depth_limit/)
    expect((await categories(p)).length).toBe(0)
  })

  it("undo removes the run's categories but refuses one a ticket was filed under later", async () => {
    const p = `Undo${tag()}`
    const run = await importCategories([{ path: `${p} / Used` }, { path: `${p}x / Unused` }])
    expect(run.counts["tickets.category"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    const [used] = await sql`
      SELECT c.id FROM app_tickets.categories c JOIN app_tickets.categories p ON p.id = c.parent_id
      WHERE c.org_id = ${orgId} AND p.name = ${p} AND c.name = 'Used'`
    // A ticket filed under it afterwards, by another run.
    const later = await runImport({
      orgId,
      actor: operator(),
      kinds: ["tickets.ticket"],
      source: recordsOf([
        {
          subject: "Filed later",
          externalRef: `L-${tag()}`,
          channel: "manual",
          categoryPath: `${p} / Used`,
          messages: [{ kind: "note", textBody: "Later." }],
        },
      ]),
      sourceLabel: "later",
      mode: "cli",
    })
    expect(later.counts["tickets.ticket"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const report = await undoImportRun(orgId, run.runId, { userId: adminId })
    expect(report.refused.map((r) => [r.id, r.reason])).toEqual([[used!.id, "has_new_children"]])
    expect((await categories(`${p}x`)).length).toBe(0)
    expect((await categories(p)).map((r) => r.name)).toEqual([p])
    const [still] = await sql`SELECT id FROM app_tickets.categories WHERE id = ${used!.id}`
    expect(still).toBeDefined()
  })

  it("one run imports categories before the tickets filed under them", async () => {
    const p = `Run${tag()}`
    const dir = mkdtempSync(join(tmpdir(), "tickets-cfg-"))
    tmpDirs.push(dir)
    const file = join(dir, "export.ndjson")
    const ref = `T-${tag()}`
    writeFileSync(
      file,
      [
        // The ticket line comes first: the runner orders kinds, not lines.
        {
          kind: "tickets.ticket",
          record: {
            subject: "Screen flickers",
            externalRef: ref,
            channel: "manual",
            categoryPath: `${p} / Display`,
            messages: [{ kind: "note", textBody: "Flickers at boot." }],
          },
        },
        { kind: "tickets.category", record: { path: `${p} / Display` } },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    )
    const run = await runImport({
      orgId,
      actor: operator(),
      kinds: ["tickets.ticket", "tickets.category"],
      source: { type: "path", path: file },
      sourceLabel: "cfgrun",
      mode: "cli",
    })
    expect(run.counts["tickets.category"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    expect(run.counts["tickets.ticket"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const [t] = await sql`
      SELECT c.name FROM app_tickets.tickets t JOIN app_tickets.categories c ON c.id = t.category_id
      WHERE t.org_id = ${orgId} AND t.external_ref = ${`cfgrun:${ref}`}`
    expect(t!.name).toBe("Display")
  })
})

describe("tickets.reply-template", () => {
  it("creates a template attributed to the importer; an existing name is skipped untouched", async () => {
    const name = `Driver setup ${tag()}`
    const [existing] = await sql`
      INSERT INTO app_tickets.reply_templates (org_id, name, body_text, updated_at)
      VALUES (${orgId}, ${name}, 'Original body', now() - interval '1 day')
      RETURNING id, updated_at`
    const fresh = `RMA steps ${tag()}`
    const run = await runImport({
      orgId,
      actor: operator(),
      kinds: ["tickets.reply-template"],
      source: recordsOf([
        { name, bodyText: "Imported body" },
        { name: fresh, bodyText: "Ship it back.", category: "rma" },
      ]),
      sourceLabel: "cfg",
      mode: "cli",
    })
    expect(run.counts["tickets.reply-template"]).toEqual({ created: 1, skipped: 1, failed: 0 })
    const [kept] = await sql`
      SELECT body_text, updated_at FROM app_tickets.reply_templates WHERE id = ${existing!.id}`
    expect(kept!.body_text).toBe("Original body")
    expect(kept!.updated_at).toEqual(existing!.updated_at)
    const [created] = await sql`
      SELECT body_text, category, created_by FROM app_tickets.reply_templates
      WHERE org_id = ${orgId} AND name = ${fresh}`
    expect([created!.body_text, created!.category, created!.created_by]).toEqual([
      "Ship it back.",
      "rma",
      adminId,
    ])
    const report = await undoImportRun(orgId, run.runId, { userId: adminId })
    expect(report).toEqual({ deleted: 1, refused: [] })
  })
})

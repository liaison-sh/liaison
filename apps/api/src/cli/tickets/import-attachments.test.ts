// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB test for `tickets import` attachment ingestion (per-message
 * `attachments: [{filename, mimeType, bytesBase64 | filePath}]`):
 *
 * - bytesBase64 + filePath variants persist via the persistInboundAttachments
 *   path: object storage receives the EXACT bytes, `kernel.files` rows land
 *   with entity_type='message' parented to the right message id, ordinals in
 *   array order, the storage key follows the inbound-mail convention.
 * - attachments on a SUBSEQUENT message parent onto that appended message.
 * - STRICT (default): an unreadable filePath fails the WHOLE record loudly —
 *   the per-record transaction rolls back (no half-imported ticket), the line
 *   lands in failed[], exit 1.
 * - --lenient-attachments: the bad attachment is skipped with a LOUD entry in
 *   report.attachmentsSkipped naming file + reason; the record still imports.
 * - schema: exactly one of bytesBase64 | filePath is required.
 * - re-import idempotency: skipped record ⇒ no duplicate files rows.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
// HERMETICITY (mock.module global-leak class, see
// inbound-attachments.integration.test.ts): spread the REAL module so the stub
// is COMPLETE (only `putObject` overridden), and re-install the real module in
// afterAll so the override never leaks to later test files.
import * as realObjectStorage from "~/infra/storage/object-storage"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Eager snapshot: `realObjectStorage` is a LIVE namespace view, so mock.module
// patches it in place — spreading it inside the restore factory would re-install
// the mock. Snapshot the real exports BEFORE the mock so afterAll truly restores.
const realObjectStorageModule = { ...realObjectStorage }

const putObjectCalls: Array<{ key: string; body: Buffer; contentType: string }> = []
mock.module("~/infra/storage/object-storage", () => ({
  ...realObjectStorageModule,
  putObject: async (args: { key: string; body: Buffer; contentType: string }) => {
    putObjectCalls.push({ key: args.key, body: args.body, contentType: args.contentType })
  },
}))
afterAll(() => {
  mock.module("~/infra/storage/object-storage", () => realObjectStorageModule)
})

// Import the SUT AFTER the mock so persistInboundAttachments resolves the stub.
const { runTicketsImport } = await import("~/cli/tickets/import")

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-import-att-"))
  tmpDirs.push(dir)
  return dir
}

function writeNdjson(records: unknown[]): string {
  const file = join(tmpDir(), "tickets.ndjson")
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`)
  return file
}

async function freshOrg(): Promise<{ orgId: string; slug: string }> {
  const slug = `cli-import-att-${crypto.randomUUID().slice(0, 12)}`
  const { orgId } = await ensureOrg({ slug, name: "ImportAttachmentsTestOrg" })
  await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-import-1!",
    role: "admin",
  })
  return { orgId, slug }
}

type FileRow = {
  id: string
  entity_type: string
  entity_id: string
  filename: string
  mime_type: string
  size_bytes: number | string
  storage_key: string
  disposition: string
  ordinal: number
}

async function filesForTicket(orgId: string, externalRef: string): Promise<FileRow[]> {
  const KS = drizzleSql.raw("kernel")
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT f.id, f.entity_type, f.entity_id, f.filename, f.mime_type, f.size_bytes,
             f.storage_key, f.disposition, f.ordinal
      FROM ${KS}.files f
      JOIN ${ticketsRel("messages")} m ON m.id::text = f.entity_id
      JOIN ${ticketsRel("tickets")} t ON t.id = m.ticket_id
      WHERE t.org_id = ${orgId}::uuid AND t.external_ref = ${externalRef}
      ORDER BY m.sent_at ASC, f.ordinal ASC
    `),
  )
  return extractRows<FileRow>(rows)
}

async function countTickets(orgId: string, externalRef: string): Promise<number> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT id FROM ${ticketsRel("tickets")}
      WHERE org_id = ${orgId}::uuid AND external_ref = ${externalRef}
    `),
  )
  return extractRows(rows).length
}

describe("tickets import — attachment ingestion", () => {
  test("bytesBase64 + filePath variants persist files rows parented to the initial message", async () => {
    const { orgId, slug } = await freshOrg()
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`

    // Real small fixture files: a PNG-ish binary blob (filePath variant) and
    // an inline base64 text document.
    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      crypto.randomBytes(64),
    ])
    const pngPath = join(tmpDir(), "capture d'écran.png")
    writeFileSync(pngPath, pngBytes)
    const txtBytes = Buffer.from("relevé de compte — janvier 2021\n", "utf8")

    const file = writeNdjson([
      {
        subject: "Pièces jointes",
        externalRef: extRef,
        contactEmail: "cust@example.com",
        messages: [
          {
            kind: "inbound",
            textBody: "voir pièces jointes",
            sentAt: "2021-05-01T10:00:00.000Z",
            attachments: [
              {
                filename: "releve.txt",
                mimeType: "text/plain",
                bytesBase64: txtBytes.toString("base64"),
              },
              { filename: "capture d'écran.png", mimeType: "image/png", filePath: pngPath },
            ],
          },
        ],
      },
    ])

    putObjectCalls.length = 0
    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(0)
    expect(report.created).toBe(1)
    expect(report.failed.length).toBe(0)

    // Object storage received the EXACT bytes of both variants.
    expect(putObjectCalls).toHaveLength(2)
    expect(putObjectCalls[0]!.body.equals(txtBytes)).toBe(true)
    expect(putObjectCalls[0]!.contentType).toBe("text/plain")
    expect(putObjectCalls[1]!.body.equals(pngBytes)).toBe(true)
    expect(putObjectCalls[1]!.contentType).toBe("image/png")

    // kernel.files rows parented to the initial message, ordinals in array order,
    // storage key follows the inbound-mail convention.
    const files = await filesForTicket(orgId, extRef)
    expect(files).toHaveLength(2)
    const [txt, png] = files
    expect(txt!.entity_type).toBe("message")
    expect(txt!.filename).toBe("releve.txt")
    expect(txt!.mime_type).toBe("text/plain")
    expect(Number(txt!.size_bytes)).toBe(txtBytes.byteLength)
    expect(txt!.disposition).toBe("attachment")
    expect(txt!.ordinal).toBe(0)
    expect(txt!.storage_key).toBe(
      `orgs/${orgId}/tickets/message/${txt!.entity_id}/${txt!.id}/releve.txt`,
    )
    expect(png!.ordinal).toBe(1)
    expect(png!.mime_type).toBe("image/png")
    expect(Number(png!.size_bytes)).toBe(pngBytes.byteLength)
    // Both parent onto the SAME (initial) message.
    expect(png!.entity_id).toBe(txt!.entity_id)

    // The parent message is the ticket's initial inbound message.
    const msgs = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT m.id FROM ${ticketsRel("messages")} m
        JOIN ${ticketsRel("tickets")} t ON t.id = m.ticket_id
        WHERE t.org_id = ${orgId}::uuid AND t.external_ref = ${extRef}
      `),
    )
    const msgIds = extractRows<{ id: string }>(msgs).map((r) => r.id)
    expect(msgIds).toHaveLength(1)
    expect(txt!.entity_id).toBe(msgIds[0]!)
  })

  test("attachments on a subsequent message parent onto THAT appended message", async () => {
    const { orgId, slug } = await freshOrg()
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const attBytes = Buffer.from("agent reply attachment", "utf8")
    const file = writeNdjson([
      {
        subject: "Two messages, second carries the file",
        externalRef: extRef,
        contactEmail: "cust@example.com",
        messages: [
          { kind: "inbound", textBody: "first", sentAt: "2021-01-01T10:00:00.000Z" },
          {
            kind: "outbound",
            textBody: "second with attachment",
            sentAt: "2021-01-02T10:00:00.000Z",
            attachments: [
              {
                filename: "reply.pdf",
                mimeType: "application/pdf",
                bytesBase64: attBytes.toString("base64"),
              },
            ],
          },
        ],
      },
    ])

    putObjectCalls.length = 0
    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(0)
    expect(report.created).toBe(1)

    const files = await filesForTicket(orgId, extRef)
    expect(files).toHaveLength(1)
    // Parented to the SECOND (appended, outbound) message — not the initial one.
    const msgs = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT m.id, m.kind FROM ${ticketsRel("messages")} m
        JOIN ${ticketsRel("tickets")} t ON t.id = m.ticket_id
        WHERE t.org_id = ${orgId}::uuid AND t.external_ref = ${extRef}
        ORDER BY m.sent_at ASC
      `),
    )
    const rows = extractRows<{ id: string; kind: string }>(msgs)
    expect(rows).toHaveLength(2)
    expect(rows[1]!.kind).toBe("outbound")
    expect(files[0]!.entity_id).toBe(rows[1]!.id)
    expect(files[0]!.filename).toBe("reply.pdf")
  })

  test("STRICT (default): unreadable filePath fails the whole record — transaction rolls back", async () => {
    const { orgId, slug } = await freshOrg()
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const goodBytes = Buffer.from("good", "utf8")
    const file = writeNdjson([
      {
        subject: "Attachment missing on disk",
        externalRef: extRef,
        contactEmail: "cust@example.com",
        messages: [
          {
            kind: "inbound",
            textBody: "x",
            attachments: [
              {
                filename: "good.txt",
                mimeType: "text/plain",
                bytesBase64: goodBytes.toString("base64"),
              },
              {
                filename: "gone.png",
                mimeType: "image/png",
                filePath: join(tmpDir(), "does-not-exist.png"),
              },
            ],
          },
        ],
      },
    ])

    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(1)
    expect(report.created).toBe(0)
    expect(report.failed.length).toBe(1)
    expect(report.failed[0]?.error).toContain("gone.png")
    // No half-imported ticket: the record's transaction rolled back entirely.
    expect(await countTickets(orgId, extRef)).toBe(0)
    expect(await filesForTicket(orgId, extRef)).toHaveLength(0)
  })

  test("--lenient-attachments: bad attachment skipped LOUDLY, record still imports", async () => {
    const { orgId, slug } = await freshOrg()
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const goodBytes = Buffer.from("still here", "utf8")
    const file = writeNdjson([
      {
        subject: "Lenient import",
        externalRef: extRef,
        contactEmail: "cust@example.com",
        messages: [
          {
            kind: "inbound",
            textBody: "x",
            attachments: [
              { filename: "gone.png", mimeType: "image/png", filePath: join(tmpDir(), "nope.png") },
              {
                filename: "kept.txt",
                mimeType: "text/plain",
                bytesBase64: goodBytes.toString("base64"),
              },
            ],
          },
        ],
      },
    ])

    const { exitCode, report } = await runTicketsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      lenientAttachments: true,
    })
    expect(exitCode).toBe(0)
    expect(report.created).toBe(1)
    expect(report.failed.length).toBe(0)
    // The skip is LOUD: named in the report with file + reason.
    expect(report.attachmentsSkipped).toHaveLength(1)
    expect(report.attachmentsSkipped[0]!.externalRef).toBe(extRef)
    expect(report.attachmentsSkipped[0]!.filename).toBe("gone.png")
    expect(report.attachmentsSkipped[0]!.reason.length).toBeGreaterThan(0)
    // The good attachment persisted.
    const files = await filesForTicket(orgId, extRef)
    expect(files).toHaveLength(1)
    expect(files[0]!.filename).toBe("kept.txt")
  })

  test("schema: exactly one of bytesBase64 | filePath is required", async () => {
    const { slug } = await freshOrg()
    const mk = (attachments: unknown[]) => ({
      subject: "Bad attachment shape",
      externalRef: `ext-${crypto.randomUUID().slice(0, 8)}`,
      contactEmail: "cust@example.com",
      messages: [{ kind: "inbound", textBody: "x", attachments }],
    })
    const file = writeNdjson([
      mk([
        { filename: "both.txt", mimeType: "text/plain", bytesBase64: "aGk=", filePath: "/tmp/x" },
      ]),
      mk([{ filename: "neither.txt", mimeType: "text/plain" }]),
    ])
    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(1)
    expect(report.created).toBe(0)
    expect(report.failed).toHaveLength(2)
    for (const f of report.failed) {
      expect(f.error).toContain("invalid record")
    }
  })

  test("re-import idempotency: skipped record ⇒ no duplicate files rows", async () => {
    const { orgId, slug } = await freshOrg()
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const bytes = Buffer.from("once only", "utf8")
    const file = writeNdjson([
      {
        subject: "Idempotent attachments",
        externalRef: extRef,
        contactEmail: "cust@example.com",
        messages: [
          {
            kind: "inbound",
            textBody: "x",
            attachments: [
              {
                filename: "once.txt",
                mimeType: "text/plain",
                bytesBase64: bytes.toString("base64"),
              },
            ],
          },
        ],
      },
    ])

    const r1 = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(r1.report.created).toBe(1)
    expect(await filesForTicket(orgId, extRef)).toHaveLength(1)

    const r2 = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
    expect(r2.report.skipped).toBe(1)
    expect(await filesForTicket(orgId, extRef)).toHaveLength(1)
  })

  test("dry-run validates attachment filePath readability without writing", async () => {
    const { orgId, slug } = await freshOrg()
    const extRef = `ext-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        subject: "Dry-run attachment check",
        externalRef: extRef,
        contactEmail: "cust@example.com",
        messages: [
          {
            kind: "inbound",
            textBody: "x",
            attachments: [
              {
                filename: "ghost.bin",
                mimeType: "application/octet-stream",
                filePath: join(tmpDir(), "ghost.bin"),
              },
            ],
          },
        ],
      },
    ])
    putObjectCalls.length = 0
    const { exitCode, report } = await runTicketsImport({ file, orgSlug: slug, dryRun: true })
    expect(exitCode).toBe(1)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.error).toContain("ghost.bin")
    expect(putObjectCalls).toHaveLength(0)
    expect(await countTickets(orgId, extRef)).toBe(0)
  })
})

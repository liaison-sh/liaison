// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import kind `contacts.contact` (modules/imports): one contact per record,
 * inserted for the organisation (never through the resolve/merge path), its
 * source id kept in
 * `external_ids[<source>]` (`import` for a run with no source label).
 *
 * Imports only create (A14): a contact already known by the same source id or
 * the same email or phone (org-visible) is reported `skipped` and left untouched; no
 * second external id is merged into it. Concurrent runs of this kind are
 * serialized by the runner's per-kind lock, which with this precheck keeps
 * them from creating the same contact twice.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { extractRows, type PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { nextHandle } from "~/lib/handle"
import { UUID_RE } from "~/lib/uuid"
import type { HostImportContext, HostImportHandler } from "~/modules/imports/types"

export const contactImportRecordSchema = z.object({
  externalId: z.string().min(1),
  name: z.string().min(1),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  company: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})

/** The `external_ids` key a run's source ids live under. */
export function contactSourceKey(sourceLabel: string): string {
  return sourceLabel || "import"
}

async function importContact(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
) {
  const record = contactImportRecordSchema.parse(raw)
  const { orgId } = ctx
  const K = drizzleSql.raw(schemaRef("kernel"))
  const sourceKey = contactSourceKey(ctx.sourceLabel)
  const email = record.email?.trim().toLowerCase() || null
  const phone = record.phone?.trim() || null
  const byId = JSON.stringify({ [sourceKey]: record.externalId })
  // Imports only create (A14): a contact the org already knows by this source
  // id, this email or this phone is skipped and never touched (the resolve
  // path would merge into it, and undo would then delete someone's contact).
  const existing = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${K}.contacts
      WHERE org_id = ${orgId}::uuid
        AND (external_ids @> ${byId}::jsonb
             ${email ? drizzleSql`OR (lower(email) = ${email} AND org_access <> 'none')` : drizzleSql``}
             ${phone ? drizzleSql`OR (phone = ${phone} AND org_access <> 'none')` : drizzleSql``})
      LIMIT 1
    `),
  )
  if (existing.length > 0) return { status: "skipped" as const, rows: [] }

  const handle = await nextHandle(tx, `${schemaRef("kernel")}.contact_handle_seq`, "@contact")
  const createdBy = UUID_RE.test(ctx.actorUserId) ? ctx.actorUserId : null
  const metadata = record.notes ? JSON.stringify({ notes: record.notes }) : null
  const inserted = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      INSERT INTO ${K}.contacts
        (org_id, handle, email, name, phone, company, external_ids, metadata, created_by, org_access)
      VALUES (${orgId}::uuid, ${handle}, ${email}, ${record.name}, ${phone},
              ${record.company ?? null}, ${byId}::jsonb,
              ${metadata}::jsonb, ${createdBy}::uuid, 'editor')
      RETURNING id
    `),
  )
  const id = inserted[0]?.id
  if (!id) throw new Error("contact insert returned no row")
  await tx.queueEvent({
    app: "kernel",
    entity: "contact",
    action: "create",
    orgId,
    actorId: createdBy ?? "00000000-0000-0000-0000-000000000000",
    entityId: id,
    data: { email, name: record.name, handle },
  })
  return { status: "created" as const, rows: [{ table: "kernel.contacts", id }] }
}

export const contactImportHandler: HostImportHandler = { importRecord: importContact }

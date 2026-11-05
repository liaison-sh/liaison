// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { boolean, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { files } from "./files"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/** What a template is made of: an uploaded PDF form, or text blocks with placeholders. */
export type DocumentTemplateKind = "pdf_form" | "rich_text"

/**
 * A field the template offers, as stored in `fields`: for a PDF form, one entry
 * of the field list read at upload (modules/documents/pdf-form.ts, which also
 * stores page, rect, options and tooltip).
 */
export interface DocumentTemplateField {
  name: string
  type: string
  maxLength?: number
}

/**
 * Where one template field's value comes from: a path into the printed record,
 * a constant, or an image file of the template; `placeholder` is what a blank
 * value prints as.
 */
export interface DocumentTemplateMappingEntry {
  path?: string
  const?: string | boolean
  image_file_id?: string
  placeholder?: string
}

/**
 * An organisation's document template (migration 0255). A `pdf_form` keeps its
 * sanitized PDF as a kernel file parented to the row (`file_id`); a `rich_text`
 * keeps its blocks in `body`. `record_type` ("<app>:<entity>") names the
 * records it prints from. Org-scoped under FORCE RLS; changed by an org admin
 * through /api/document-templates (modules/documents/routes.ts).
 */
export const documentTemplates = kernel.table(
  "document_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<DocumentTemplateKind>().notNull(),
    recordType: text("record_type"),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    body: jsonb("body").$type<Record<string, unknown>>(),
    fields: jsonb("fields").$type<DocumentTemplateField[]>().notNull().default([]),
    mapping: jsonb("mapping")
      .$type<Record<string, DocumentTemplateMappingEntry>>()
      .notNull()
      .default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("document_templates_org_record_type_idx")
      .on(table.orgId, table.recordType)
      .where(sql`${table.archivedAt} IS NULL`),
    index("document_templates_file_fk_idx")
      .on(table.fileId)
      .where(sql`${table.fileId} IS NOT NULL`),
    index("document_templates_created_by_fk_idx")
      .on(table.createdBy)
      .where(sql`${table.createdBy} IS NOT NULL`),
    index("document_templates_updated_by_fk_idx")
      .on(table.updatedBy)
      .where(sql`${table.updatedBy} IS NOT NULL`),
  ],
)

export type DocumentTemplateRow = typeof documentTemplates.$inferSelect

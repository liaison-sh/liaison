// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { buildFilesSelectPolicy, type FileParentRegistration } from "./rls-builder"

const parents: FileParentRegistration[] = [
  {
    app: "tickets",
    entityType: "ticket",
    schemaRef: "app_tickets",
    tableName: "tickets",
    joinOn: "id",
  },
  {
    app: "kernel",
    entityType: "thread",
    schemaRef: "kernel",
    tableName: "threads",
    joinOn: "id",
  },
]

describe("buildFilesSelectPolicy", () => {
  it("emits DROP IF EXISTS + CREATE POLICY scaffolding", () => {
    const sql = buildFilesSelectPolicy(parents)
    expect(sql).toContain(`DROP POLICY IF EXISTS files_select ON "kernel".files`)
    expect(sql).toContain(`CREATE POLICY files_select ON "kernel".files FOR SELECT`)
    expect(sql).toContain("TO liaison_rls")
  })

  it("composes one EXISTS branch per registered fileParent, joined by OR", () => {
    const sql = buildFilesSelectPolicy(parents)
    expect(sql).toContain(`EXISTS (SELECT 1 FROM "app_tickets"."tickets" p WHERE p."id" = (CASE`)
    expect(sql).toContain(`"kernel".files.app = 'tickets'`)
    expect(sql).toContain(`"kernel".files.entity_type = 'ticket'`)
    expect(sql).toContain(`EXISTS (SELECT 1 FROM "kernel"."threads" p WHERE p."id" = (CASE`)
    expect(sql).toContain(`"kernel".files.app = 'kernel'`)
    expect(sql).toContain(`"kernel".files.entity_type = 'thread'`)
    expect(sql).toMatch(/\)\s*OR\s*\(/)
  })

  it("casts entity_id on the files side, CASE-guarded against non-UUID text", () => {
    const sql = buildFilesSelectPolicy(parents)
    // The parent column must be compared bare (leakproof uuid = uuid against its
    // pkey index) — never cast to text, which forces a per-row seq scan under
    // the parent's own RLS.
    expect(sql).not.toContain(`::text`)
    expect(sql).toContain(
      `(CASE WHEN "kernel".files.entity_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN "kernel".files.entity_id::uuid END)`,
    )
  })

  it("legacyTextJoin option regenerates the text-cast join form", () => {
    const sql = buildFilesSelectPolicy(parents, "kernel", { legacyTextJoin: true })
    expect(sql).toContain(
      `EXISTS (SELECT 1 FROM "app_tickets"."tickets" p WHERE p."id"::text = "kernel".files.entity_id`,
    )
    expect(sql).not.toContain("CASE WHEN")
  })

  it("a soft-deletable parent hides its files once deleted", () => {
    const sql = buildFilesSelectPolicy([
      {
        app: "kernel",
        entityType: "message",
        schemaRef: "kernel",
        tableName: "messages",
        joinOn: "id",
        softDeleteColumn: "deleted_at",
      },
      ...parents,
    ])
    expect(sql).toContain(`"kernel".files.org_id = p.org_id AND p."deleted_at" IS NULL)`)
    // Only the parent that declares it.
    expect(sql.match(/IS NULL\)/g)).toHaveLength(1)
  })

  it("scopes EXISTS join by org_id", () => {
    const sql = buildFilesSelectPolicy(parents)
    expect(sql).toContain(`"kernel".files.org_id = p.org_id`)
  })

  it("rejects invalid identifiers in schema/table/joinOn", () => {
    expect(() =>
      buildFilesSelectPolicy([
        {
          app: "t",
          entityType: "x",
          schemaRef: "s; DROP TABLE x",
          tableName: "t",
          joinOn: "id",
        },
      ]),
    ).toThrow(/invalid identifier/)
    expect(() =>
      buildFilesSelectPolicy([
        { app: "t", entityType: "x", schemaRef: "s", tableName: "t'; --", joinOn: "id" },
      ]),
    ).toThrow(/invalid identifier/)
    expect(() =>
      buildFilesSelectPolicy([
        { app: "t", entityType: "x", schemaRef: "s", tableName: "t", joinOn: "id;" },
      ]),
    ).toThrow(/invalid identifier/)
  })

  it("escapes single quotes in app/entityType literals", () => {
    const sql = buildFilesSelectPolicy([
      {
        app: "t'app",
        entityType: "e'kind",
        schemaRef: "s",
        tableName: "t",
        joinOn: "id",
      },
    ])
    expect(sql).toContain(`"kernel".files.app = 't''app'`)
    expect(sql).toContain(`"kernel".files.entity_type = 'e''kind'`)
  })

  it("an uploader-only kind is readable by its uploader in its org, with no parent join", () => {
    const sql = buildFilesSelectPolicy([
      {
        app: "kernel",
        entityType: "thread",
        schemaRef: "kernel",
        tableName: "threads",
        joinOn: "id",
      },
    ])
    expect(sql).toContain(
      `( "kernel".files.app = 'kernel' AND "kernel".files.entity_type = 'data_subject_export' ` +
        `AND "kernel".files.org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid ` +
        `AND "kernel".files.uploaded_by = NULLIF((SELECT rls_ctx.user_id()), '')::uuid )`,
    )
  })

  it("empty parents → policy denies all", () => {
    const sql = buildFilesSelectPolicy([])
    expect(sql).toContain("USING (false)")
  })

  it("includes mail and ticket message parents in generated files policy", () => {
    const ddl = buildFilesSelectPolicy(
      [
        {
          app: "mail",
          entityType: "message",
          schemaRef: "app_mail",
          tableName: "messages",
          joinOn: "id",
        },
        {
          app: "mail",
          entityType: "draft",
          schemaRef: "app_mail",
          tableName: "drafts",
          joinOn: "id",
        },
        {
          app: "tickets",
          entityType: "message",
          schemaRef: "app_tickets",
          tableName: "messages",
          joinOn: "id",
        },
      ],
      "kernel",
    )

    expect(ddl).toContain(`"kernel".files.app = 'mail'`)
    expect(ddl).toContain(`"kernel".files.entity_type = 'message'`)
    expect(ddl).toContain(`"kernel".files.entity_type = 'draft'`)
    expect(ddl).toContain(`"kernel".files.app = 'tickets'`)
    expect(ddl).toContain(`FROM "app_tickets"."messages"`)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { buildFilesSelectPolicy } from "~/modules/files/rls-builder"

// Lightweight smoke-test: the boot module is wired around register* sites that
// rely on Redis / Meili / Postgres which are unavailable in unit tests. We assert
// the kernel built-in file parents flow into a SELECT policy that contains the
// expected `EXISTS` branches.

describe("boot generates the file SELECT policy", () => {
  it("kernel built-ins produce expected EXISTS branches", () => {
    const sql = buildFilesSelectPolicy([
      {
        app: "kernel",
        entityType: "thread",
        schemaRef: "kernel",
        tableName: "threads",
        joinOn: "id",
      },
      {
        app: "kernel",
        entityType: "thread_message",
        schemaRef: "kernel",
        tableName: "thread_messages",
        joinOn: "id",
      },
    ])
    expect(sql).toContain(`DROP POLICY IF EXISTS files_select ON "kernel".files`)
    expect(sql).toContain(`CREATE POLICY files_select ON "kernel".files FOR SELECT TO liaison_rls`)
    expect(sql).toContain('FROM "kernel"."threads"')
    expect(sql).toContain('FROM "kernel"."thread_messages"')
    expect(sql).toContain(`"kernel".files.app = 'kernel'`)
    expect(sql).toContain(`"kernel".files.entity_type = 'thread'`)
    expect(sql).toContain(`"kernel".files.entity_type = 'thread_message'`)
  })

  it("manifest fileParent entries widen the union", () => {
    const sql = buildFilesSelectPolicy([
      {
        app: "tickets",
        entityType: "ticket",
        schemaRef: "app_tickets",
        tableName: "tickets",
        joinOn: "id",
      },
    ])
    expect(sql).toContain('FROM "app_tickets"."tickets"')
    expect(sql).toContain(`"kernel".files.app = 'tickets'`)
  })
})

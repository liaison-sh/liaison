// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-169 #9: reply-template (canned-response macro) CRUD admin ops + RLS.
// Proves: templatesCreate inserts an org-scoped macro (returns id/name/category/body),
// templatesList returns it, a duplicate name reports name_exists (not a 500), and the
// write is RLS-gated by tickets:tickets:write (a read-only actor is denied).

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string

beforeAll(async () => {
  const slug = `tmpl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("reply-tmpl-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Tmpl Test', ${slug}) RETURNING id
    `)) as any
    orgId = (orgRows.rows ?? orgRows)[0].id
    const u = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userId = (u.rows ?? u)[0].id
  })
  await ensureAppsForOrg(orgId, {})
})

function writer() {
  return {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: ["tickets:tickets:read", "tickets:tickets:write"],
    dimensionGrants: {},
  }
}
function reader() {
  return {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: ["tickets:tickets:read"],
    dimensionGrants: {},
  }
}

describe("reply-templates admin ops (BL-169 #9)", () => {
  it("templatesCreate persists an org-scoped macro and templatesList returns it (under RLS write scope)", async () => {
    const created = (await withRlsContext(writer(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "templatesCreate",
        {
          name: "USB driver setup",
          category: "firmware",
          bodyText: "1. Download the Kestrel 6 USB driver. 2. Install. 3. Reboot.",
        },
        { actorType: "user", userId, scopes: writer().scopes },
      ),
    )) as Record<string, unknown>
    expect(created.id).toBeTruthy()
    expect(created.name).toBe("USB driver setup")
    expect(created.category).toBe("firmware")
    expect(String(created.body_text)).toContain("USB driver")

    const list = (await withRlsContext(reader(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "templatesList",
        {},
        { actorType: "user", userId, scopes: reader().scopes },
      ),
    )) as Array<Record<string, unknown>>
    expect(Array.isArray(list)).toBe(true)
    expect(list.some((r) => r.name === "USB driver setup")).toBe(true)
  })

  it("duplicate name reports name_exists (not a crash)", async () => {
    await withRlsContext(writer(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "templatesCreate",
        { name: "RMA return-label", bodyText: "Steps to return." },
        { actorType: "user", userId, scopes: writer().scopes },
      ),
    )
    const dup = (await withRlsContext(writer(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "templatesCreate",
        { name: "RMA return-label", bodyText: "Other body." },
        { actorType: "user", userId, scopes: writer().scopes },
      ),
    )) as { error?: { code?: string } }
    expect(dup.error?.code).toBe("name_exists")
  })

  it("requires name + bodyText", async () => {
    const noName = (await withRlsContext(writer(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "templatesCreate",
        { bodyText: "x" },
        { actorType: "user", userId, scopes: writer().scopes },
      ),
    )) as { error?: { code?: string } }
    expect(noName.error?.code).toBe("invalid_params")
    const noBody = (await withRlsContext(writer(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "templatesCreate",
        { name: "x" },
        { actorType: "user", userId, scopes: writer().scopes },
      ),
    )) as { error?: { code?: string } }
    expect(noBody.error?.code).toBe("invalid_params")
  })

  it("templatesUpdate edits body/category and templatesDelete removes a macro", async () => {
    const created = (await withRlsContext(writer(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "templatesCreate",
        { name: "Customs/VAT delay", category: "shipping", bodyText: "Original body." },
        { actorType: "user", userId, scopes: writer().scopes },
      ),
    )) as Record<string, unknown>
    const id = String(created.id)
    const updated = (await withRlsContext(writer(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "templatesUpdate",
        { id, bodyText: "Updated customs/VAT body." },
        { actorType: "user", userId, scopes: writer().scopes },
      ),
    )) as Record<string, unknown>
    expect(String(updated.body_text)).toBe("Updated customs/VAT body.")
    expect(updated.category).toBe("shipping")

    const del = (await withRlsContext(writer(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "templatesDelete",
        { id },
        { actorType: "user", userId, scopes: writer().scopes },
      ),
    )) as { deleted?: boolean }
    expect(del.deleted).toBe(true)

    const list = (await withRlsContext(reader(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "templatesList",
        {},
        { actorType: "user", userId, scopes: reader().scopes },
      ),
    )) as Array<Record<string, unknown>>
    expect(list.some((r) => r.id === id)).toBe(false)
  })

  it("write is RLS-gated by tickets:tickets:write — a read-only actor is denied the insert", async () => {
    await expect(
      withRlsContext(reader(), (tx) =>
        runAdminOp(
          tx as never,
          orgId,
          "templatesCreate",
          { name: "should-fail", bodyText: "nope" },
          { actorType: "user", userId, scopes: reader().scopes },
        ),
      ),
    ).rejects.toThrow()
  })
})

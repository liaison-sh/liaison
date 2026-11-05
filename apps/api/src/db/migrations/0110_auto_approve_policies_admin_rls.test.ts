// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pins what migration 0110 establishes: writing an auto-approve policy (a rule
// that LOOSENS a gate) is an admin authority at the RLS layer too, exactly like
// approval_policies. `kernel:policies:write` and `kernel:approve` no longer
// insert, update or delete a row; `kernel:policies:admin` and `*` do. Reads
// keep every scope they had and gain the admin one (an admin must see the row
// it updates or deletes).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string

function as(scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
}

async function insertAs(scopes: string[], toolName: string): Promise<string | null> {
  try {
    await withRlsContext(as(scopes), (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.auto_approve_policies (org_id, tool_name)
        VALUES (${orgId}::uuid, ${toolName})`),
    )
    return null
  } catch (err) {
    const e = err as { cause?: { code?: string }; code?: string }
    return e.cause?.code ?? e.code ?? "error"
  }
}

async function seedRow(toolName: string): Promise<void> {
  await db.execute(drizzleSql`
    INSERT INTO kernel.auto_approve_policies (org_id, tool_name, enabled)
    VALUES (${orgId}::uuid, ${toolName}, true)`)
}

async function updateAs(scopes: string[], toolName: string): Promise<number> {
  const rows = await withRlsContext(as(scopes), (tx) =>
    tx.execute(drizzleSql`
      UPDATE kernel.auto_approve_policies SET enabled = false
       WHERE org_id = ${orgId}::uuid AND tool_name = ${toolName} RETURNING id`),
  )
  return extractRows(rows).length
}

async function deleteAs(scopes: string[], toolName: string): Promise<number> {
  const rows = await withRlsContext(as(scopes), (tx) =>
    tx.execute(drizzleSql`
      DELETE FROM kernel.auto_approve_policies
       WHERE org_id = ${orgId}::uuid AND tool_name = ${toolName} RETURNING id`),
  )
  return extractRows(rows).length
}

async function selectAs(scopes: string[], toolName: string): Promise<number> {
  const rows = await withRlsContext(as(scopes), (tx) =>
    tx.execute(drizzleSql`
      SELECT id FROM kernel.auto_approve_policies
       WHERE org_id = ${orgId}::uuid AND tool_name = ${toolName}`),
  )
  return extractRows(rows).length
}

beforeAll(async () => {
  await acquireTestLock()
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), '0110 auto-approve', ${`migration-0110-${stamp}`}) RETURNING id`),
  )
  orgId = org!.id
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`0110-${stamp}@t.co`}, '0110', 'active', 'hash', 1, 1)
      RETURNING id`),
  )
  userId = u!.id
})

afterAll(async () => {
  await db.execute(
    drizzleSql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${orgId}::uuid`,
  )
  await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}::uuid`)
  await releaseTestLock()
})

describe("0110: auto_approve_policies writes are admin-only under RLS", () => {
  it("insert: policies:write and approve are refused; policies:admin and * are allowed", async () => {
    expect(await insertAs(["kernel:policies:write"], "t:ins_write")).toBe("42501")
    expect(await insertAs(["kernel:approve"], "t:ins_approve")).toBe("42501")
    expect(await insertAs(["kernel:policies:admin"], "t:ins_admin")).toBeNull()
    expect(await insertAs(["*"], "t:ins_star")).toBeNull()
  })

  it("update: only policies:admin and * reach the row", async () => {
    await seedRow("t:upd")
    expect(await updateAs(["kernel:policies:write"], "t:upd")).toBe(0)
    expect(await updateAs(["kernel:approve"], "t:upd")).toBe(0)
    expect(await updateAs(["kernel:policies:admin"], "t:upd")).toBe(1)
    expect(await updateAs(["*"], "t:upd")).toBe(1)
  })

  it("delete: policies:write and approve delete nothing; policies:admin deletes", async () => {
    await seedRow("t:del")
    expect(await deleteAs(["kernel:policies:write"], "t:del")).toBe(0)
    expect(await deleteAs(["kernel:approve"], "t:del")).toBe(0)
    expect(await deleteAs(["kernel:policies:admin"], "t:del")).toBe(1)
    await seedRow("t:del_star")
    expect(await deleteAs(["*"], "t:del_star")).toBe(1)
  })

  it("reads: every scope that read before still reads; policies:admin now reads too", async () => {
    await seedRow("t:read")
    for (const scope of [
      "kernel:policies:read",
      "kernel:policies:write",
      "kernel:approve",
      "kernel:*",
      "*",
      "kernel:policies:admin",
    ]) {
      expect(await selectAs([scope], "t:read"), scope).toBe(1)
    }
    expect(await selectAs(["kernel:threads:read"], "t:read")).toBe(0)
  })

  it("no write policy names kernel:approve or kernel:policies:write any more", async () => {
    const rows = extractRows<{
      policyname: string
      qual: string | null
      with_check: string | null
    }>(
      await db.execute(drizzleSql`
        SELECT policyname, qual, with_check FROM pg_policies
         WHERE schemaname = 'kernel' AND tablename = 'auto_approve_policies'
           AND cmd IN ('INSERT', 'UPDATE', 'DELETE')`),
    )
    expect(rows.map((r) => r.policyname).sort()).toEqual([
      "auto_approve_policies_delete",
      "auto_approve_policies_insert",
      "auto_approve_policies_update",
    ])
    for (const r of rows) {
      const text = `${r.qual ?? ""} ${r.with_check ?? ""}`
      expect(text, r.policyname).not.toContain("kernel:approve")
      expect(text, r.policyname).not.toContain("kernel:policies:write")
      expect(text, r.policyname).toContain("kernel:policies:admin")
    }
  })
})

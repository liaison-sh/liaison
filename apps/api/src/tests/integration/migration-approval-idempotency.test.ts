// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db/connection"
import { withRlsContext } from "~/db/rls"

describe("migration: approval columns and idempotency table", () => {
  it("approval_requests has the new columns with correct types and nullability", async () => {
    const rows = await sql`
      SELECT column_name, data_type, is_nullable, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'kernel' AND table_name = 'approval_requests'
        AND column_name IN ('originating_thread_id', 'current_payload', 'expires_at', 'notify_user_ids', 'approving_started_at')
      ORDER BY column_name
    `
    expect(rows.map((r: any) => [r.column_name, r.data_type, r.is_nullable, r.udt_name])).toEqual([
      ["approving_started_at", "timestamp with time zone", "YES", "timestamptz"],
      ["current_payload", "jsonb", "NO", "jsonb"],
      ["expires_at", "timestamp with time zone", "NO", "timestamptz"],
      ["notify_user_ids", "ARRAY", "NO", "_uuid"],
      ["originating_thread_id", "uuid", "NO", "uuid"],
    ])
  })

  it("approval_requests has the new indexes", async () => {
    const idxs = await sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'kernel' AND tablename = 'approval_requests'
        AND indexname IN ('approval_requests_org_status_expires_idx', 'approval_requests_notify_users_idx')
      ORDER BY indexname
    `
    expect(idxs.map((r: any) => r.indexname)).toEqual([
      "approval_requests_notify_users_idx",
      "approval_requests_org_status_expires_idx",
    ])
  })

  it("approval_requests notify_users index is GIN", async () => {
    const [row] = await sql`
      SELECT am.amname AS access_method
      FROM pg_indexes pi
      JOIN pg_class c ON c.relname = pi.indexname
      JOIN pg_am am ON am.oid = c.relam
      WHERE pi.indexname = 'approval_requests_notify_users_idx'
    `
    expect(row.access_method).toBe("gin")
  })

  it("originating_thread_id has ON DELETE RESTRICT to kernel.threads", async () => {
    const [row] = await sql`
      SELECT confdeltype FROM pg_constraint
      WHERE conname = 'approval_requests_originating_thread_fk'
    `
    expect(row.confdeltype).toBe("r")
  })

  it("kernel.approved_handler_executions table exists with expected columns", async () => {
    const rows = await sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'kernel' AND table_name = 'approved_handler_executions'
      ORDER BY column_name
    `
    const expected = [
      ["actor_id", "uuid", "NO"],
      ["approval_request_id", "uuid", "NO"],
      ["attempts", "integer", "NO"],
      ["error", "jsonb", "YES"],
      ["external_ref", "jsonb", "YES"],
      ["finished_at", "timestamp with time zone", "YES"],
      ["id", "uuid", "NO"],
      ["last_attempt_at", "timestamp with time zone", "YES"],
      ["org_id", "uuid", "NO"],
      ["result", "jsonb", "YES"],
      ["started_at", "timestamp with time zone", "NO"],
      ["status", "text", "NO"],
      ["tool_name", "text", "NO"],
    ]
    expect(rows.map((r: any) => [r.column_name, r.data_type, r.is_nullable])).toEqual(expected)
  })

  it("approved_handler_executions has unique (approval_request_id, tool_name) and CHECK status", async () => {
    const [uniq] = await sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'kernel.approved_handler_executions'::regclass
        AND contype = 'u'
        AND conname = 'approved_handler_executions_approval_request_id_tool_name_key'
    `
    expect(uniq?.conname).toBeTruthy()

    const [chk] = await sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'kernel.approved_handler_executions'::regclass AND contype = 'c'
    `
    expect(String(chk.def)).toContain("'started'")
    expect(String(chk.def)).toContain("'succeeded'")
    expect(String(chk.def)).toContain("'failed_no_effect'")
    expect(String(chk.def)).toContain("'ambiguous'")
  })

  it("approved_handler_executions has the request and status indexes", async () => {
    const idxs = await sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'kernel' AND tablename = 'approved_handler_executions'
        AND indexname IN ('approved_handler_executions_request_idx', 'approved_handler_executions_status_idx')
      ORDER BY indexname
    `
    expect(idxs.map((r: any) => r.indexname)).toEqual([
      "approved_handler_executions_request_idx",
      "approved_handler_executions_status_idx",
    ])
  })

  it("approved_handler_executions has RLS enabled and forced with no liaison_rls policies", async () => {
    // bootstrap-env grants ALL on schema kernel to liaison_rls; the actual access guard
    // is FORCE ROW LEVEL SECURITY plus the absence of any policy targeting liaison_rls.
    const [tbl] = await sql`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'kernel' AND c.relname = 'approved_handler_executions'
    `
    expect(tbl.relrowsecurity).toBe(true)
    expect(tbl.relforcerowsecurity).toBe(true)

    const policies = await sql`
      SELECT polname FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'kernel' AND c.relname = 'approved_handler_executions'
    `
    expect(policies.length).toBe(0)
  })

  it("approved_handler_executions has the spec-required foreign keys", async () => {
    const rows = await sql`
      SELECT conname, confdeltype
      FROM pg_constraint
      WHERE conname IN (
        'approved_handler_executions_approval_request_fk',
        'approved_handler_executions_org_fk',
        'approved_handler_executions_actor_fk'
      )
      ORDER BY conname
    `
    expect(rows.map((r: any) => [r.conname, r.confdeltype])).toEqual([
      ["approved_handler_executions_actor_fk", "a"],
      ["approved_handler_executions_approval_request_fk", "r"],
      ["approved_handler_executions_org_fk", "c"],
    ])
  })

  it("approval_requests_select policy implements hasScope-equivalent admin and snapshot-approver branches", async () => {
    const [pol] = await sql`
      SELECT pg_get_expr(p.polqual, p.polrelid) AS def
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE p.polname = 'approval_requests_select'
        AND n.nspname = 'kernel'
    `
    const def = String(pol.def)
    expect(def).toContain("notify_user_ids")
    expect(def).toContain("tool_name")
    expect(def).toContain("split_part(approval_requests.tool_name")
    expect(def).toContain("kernel:approvals:admin")
    expect(def).toContain("'*'")
    expect(def).toMatch(/"?left"?\(required\.scope, \(length\(g\.scope\) \+ 1\)\)/)
    expect(def).toMatch(/"?left"?\(required\.scope, \(length\(rsg\.scope\) \+ 1\)\)/)
    expect(def).not.toMatch(/required\.scope\s+(~~|LIKE)\s+/i)
  })

  it("notified users still need the derived <app>:approve scope to see snapshot-approver rows", async () => {
    const org = "00000000-0000-4000-8000-000000066001"
    const requester = "00000000-0000-4000-8000-000000066002"
    const notified = "00000000-0000-4000-8000-000000066003"
    const thread = "00000000-0000-4000-8000-000000066004"
    const request = "00000000-0000-4000-8000-000000066005"
    await seedRlsApproval(org, requester, notified, thread, request, "mail:reply")
    try {
      expect(await countVisible(org, notified)).toBe(0)
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${notified}, ${org}, 'mail:approve') ON CONFLICT DO NOTHING`
      expect(await countVisible(org, notified)).toBe(1)
    } finally {
      await cleanupRlsApproval(org)
    }
  })

  it("admin and snapshot-approver RLS grants honor exact, wildcard, parent-prefix, and near-prefix semantics", async () => {
    const org = "00000000-0000-4000-8000-000000066101"
    const requester = "00000000-0000-4000-8000-000000066102"
    const actor = "00000000-0000-4000-8000-000000066103"
    const thread = "00000000-0000-4000-8000-000000066104"
    const request = "00000000-0000-4000-8000-000000066105"
    await seedRlsApproval(org, requester, actor, thread, request, "mail:reply")
    try {
      for (const scope of ["mail:approve", "mail", "*"]) {
        await replaceScopes(org, actor, [scope])
        expect(await countVisible(org, actor)).toBe(1)
      }
      for (const scope of ["mailer", "mailbox", "mail:approved"]) {
        await replaceScopes(org, actor, [scope])
        expect(await countVisible(org, actor)).toBe(0)
      }
      for (const scope of ["kernel:approvals:admin", "kernel", "*"]) {
        await replaceScopes(org, actor, [scope])
        expect(await countVisible(org, actor)).toBe(1)
      }
      for (const scope of ["kernel:approval", "kernelx"]) {
        await replaceScopes(org, actor, [scope])
        expect(await countVisible(org, actor)).toBe(0)
      }
    } finally {
      await cleanupRlsApproval(org)
    }
  })
})

async function seedRlsApproval(
  org: string,
  requester: string,
  notified: string,
  thread: string,
  request: string,
  toolName: string,
) {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${org}, ${`RLS Org ${org.slice(-4)}`}, ${`rls-org-${org.slice(-4)}`}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${requester}, ${org}, ${`requester-${org.slice(-4)}@test.com`}, 'Requester', 'active', 'hash') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${notified}, ${org}, ${`notified-${org.slice(-4)}@test.com`}, 'Notified', 'active', 'hash') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${thread}, ${org}, ${`rls-thread-${org.slice(-4)}`}, 'agent_chat', ${requester}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.approval_requests (
    id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
    current_payload, expires_at, notify_user_ids, requested_by, status, reason
  ) VALUES (
    ${request}, ${org}, ${`rls-request-${org.slice(-4)}`}, ${thread}, ${thread}, ${toolName}, '{}'::jsonb,
    '{}'::jsonb, now() + interval '1 hour', ARRAY[${notified}]::uuid[], ${requester}, 'pending', 'gated'
  ) ON CONFLICT DO NOTHING`
}

async function replaceScopes(org: string, user: string, scopes: string[]) {
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${org} AND user_id = ${user}`
  for (const scope of scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${user}, ${org}, ${scope}) ON CONFLICT DO NOTHING`
  }
}

async function countVisible(org: string, user: string): Promise<number> {
  const [row] = await withRlsContext(
    { actorType: "user", userId: user, orgId: org, scopes: [], dimensionGrants: {} },
    async (tx) =>
      tx.execute(drizzleSql`SELECT COUNT(*)::int AS count FROM kernel.approval_requests`),
  )
  return row.count as number
}

async function cleanupRlsApproval(org: string) {
  await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${org}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${org}`
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${org}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${org}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${org}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
}

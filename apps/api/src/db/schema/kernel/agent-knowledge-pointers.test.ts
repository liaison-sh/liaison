// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"

describe("AGENT KNOWLEDGE POINTERS", () => {
  it("table exists with FORCE RLS and a select-only policy for liaison_rls", async () => {
    const rls = extractRows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      await db.execute(drizzleSql`
        SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'kernel' AND c.relname = 'agent_knowledge_pointers'
      `),
    )
    expect(rls.length).toBe(1)
    expect(rls[0].relrowsecurity).toBe(true)
    expect(rls[0].relforcerowsecurity).toBe(true)

    const policies = extractRows<{ policyname: string; cmd: string; roles: string[] }>(
      await db.execute(drizzleSql`
        SELECT policyname, cmd, roles
        FROM pg_policies
        WHERE schemaname = 'kernel' AND tablename = 'agent_knowledge_pointers'
      `),
    )

    const selectPolicies = policies.filter((p) => p.cmd === "SELECT")
    const insertPolicies = policies.filter((p) => p.cmd === "INSERT")
    const updatePolicies = policies.filter((p) => p.cmd === "UPDATE")
    const deletePolicies = policies.filter((p) => p.cmd === "DELETE")

    expect(selectPolicies.length).toBe(1)
    expect(selectPolicies[0].policyname).toBe("agent_knowledge_pointers_select")
    expect(insertPolicies.length).toBe(0)
    expect(updatePolicies.length).toBe(0)
    expect(deletePolicies.length).toBe(0)
  })
})

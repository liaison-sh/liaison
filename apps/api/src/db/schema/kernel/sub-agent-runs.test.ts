// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"

// Migration 0004_sub_agent_dispatch adds two kernel tables and a partial GIN
// index on audit_log.metadata. These information_schema / pg_catalog checks
// assert the DDL landed without coupling to runtime semantics — the
// implementation tests (Tasks 2+) exercise behavior.

describe("kernel.agent_runs schema (0004)", () => {
  it("creates the table with the expected columns and types", async () => {
    const rows = extractRows<{
      column_name: string
      data_type: string
      is_nullable: string
    }>(
      await db.execute(drizzleSql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'kernel' AND table_name = 'agent_runs'
        ORDER BY column_name
      `),
    )
    const cols = new Map(rows.map((r) => [r.column_name, r]))

    expect(cols.has("id")).toBe(true)
    expect(cols.has("org_id")).toBe(true)
    expect(cols.has("parent_run_id")).toBe(true)
    expect(cols.has("root_run_id")).toBe(true)
    expect(cols.has("thread_id")).toBe(true)
    expect(cols.has("subagent_type")).toBe(true)
    expect(cols.has("actor")).toBe(true)
    expect(cols.has("effective_scopes")).toBe(true)
    expect(cols.has("status")).toBe(true)
    expect(cols.has("prompt")).toBe(true)
    expect(cols.has("input")).toBe(true)
    expect(cols.has("output")).toBe(true)
    expect(cols.has("output_schema")).toBe(true)
    expect(cols.has("summary")).toBe(true)
    expect(cols.has("error_code")).toBe(true)
    expect(cols.has("error_message")).toBe(true)
    expect(cols.has("usage_prompt_tokens")).toBe(true)
    expect(cols.has("usage_completion_tokens")).toBe(true)
    expect(cols.has("credit_cost")).toBe(true)
    expect(cols.has("max_steps")).toBe(true)
    expect(cols.has("timeout_ms")).toBe(true)
    expect(cols.has("schema_retry_budget")).toBe(true)
    expect(cols.has("schema_retry_count")).toBe(true)
    expect(cols.has("attempt_count")).toBe(true)
    expect(cols.has("nesting_depth")).toBe(true)
    expect(cols.has("started_at")).toBe(true)
    expect(cols.has("finished_at")).toBe(true)
    expect(cols.has("created_at")).toBe(true)

    // Nullability spot-checks
    expect(cols.get("org_id")?.is_nullable).toBe("NO")
    expect(cols.get("thread_id")?.is_nullable).toBe("NO")
    expect(cols.get("actor")?.is_nullable).toBe("NO")
    expect(cols.get("prompt")?.is_nullable).toBe("NO")
    expect(cols.get("parent_run_id")?.is_nullable).toBe("YES")
    expect(cols.get("subagent_type")?.is_nullable).toBe("YES")
    expect(cols.get("output")?.is_nullable).toBe("YES")

    // JSONB columns
    expect(cols.get("actor")?.data_type).toBe("jsonb")
    expect(cols.get("input")?.data_type).toBe("jsonb")
    expect(cols.get("output")?.data_type).toBe("jsonb")
    expect(cols.get("output_schema")?.data_type).toBe("jsonb")
  })

  it("enforces the status CHECK constraint", async () => {
    const rows = extractRows<{ definition: string }>(
      await db.execute(drizzleSql`
        SELECT pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'kernel'
          AND t.relname = 'agent_runs'
          AND c.contype = 'c'
      `),
    )
    const statusCheck = rows.find((r) => r.definition.includes("status"))
    expect(statusCheck).toBeDefined()
    expect(statusCheck?.definition).toContain("queued")
    expect(statusCheck?.definition).toContain("running")
    expect(statusCheck?.definition).toContain("done")
    expect(statusCheck?.definition).toContain("failed")
    expect(statusCheck?.definition).toContain("cancelled")
  })

  it("has the expected indexes", async () => {
    const rows = extractRows<{ indexname: string }>(
      await db.execute(drizzleSql`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'kernel' AND tablename = 'agent_runs'
      `),
    )
    const names = new Set(rows.map((r) => r.indexname))
    expect(names.has("agent_runs_org_parent_idx")).toBe(true)
    expect(names.has("agent_runs_org_root_idx")).toBe(true)
    expect(names.has("agent_runs_org_status_idx")).toBe(true)
    expect(names.has("agent_runs_org_thread_idx")).toBe(true)
  })

  it("has RLS enabled and the select policy installed", async () => {
    const rls = extractRows<{ relrowsecurity: boolean }>(
      await db.execute(drizzleSql`
        SELECT c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'kernel' AND c.relname = 'agent_runs'
      `),
    )
    expect(rls[0]?.relrowsecurity).toBe(true)

    const policies = extractRows<{ policyname: string }>(
      await db.execute(drizzleSql`
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'kernel' AND tablename = 'agent_runs'
      `),
    )
    expect(policies.some((p) => p.policyname === "agent_runs_select")).toBe(true)
  })

  it("has a deferred self-referential root_run_id FK", async () => {
    const rows = extractRows<{ conname: string; condeferrable: boolean; condeferred: boolean }>(
      await db.execute(drizzleSql`
        SELECT conname, condeferrable, condeferred
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'kernel'
          AND t.relname = 'agent_runs'
          AND c.contype = 'f'
          AND c.conname = 'agent_runs_root_run_fk'
      `),
    )
    expect(rows.length).toBe(1)
    expect(rows[0].condeferrable).toBe(true)
    expect(rows[0].condeferred).toBe(true)
  })
})

describe("kernel.sub_agent_definitions schema (0004)", () => {
  it("creates the table with the expected columns", async () => {
    const rows = extractRows<{ column_name: string; data_type: string; is_nullable: string }>(
      await db.execute(drizzleSql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'kernel' AND table_name = 'sub_agent_definitions'
        ORDER BY column_name
      `),
    )
    const cols = new Map(rows.map((r) => [r.column_name, r]))
    expect(cols.has("id")).toBe(true)
    expect(cols.has("org_id")).toBe(true)
    expect(cols.has("app_name")).toBe(true)
    expect(cols.has("agent_type")).toBe(true)
    expect(cols.has("when_to_use")).toBe(true)
    expect(cols.has("scope_ceiling")).toBe(true)
    expect(cols.has("tool_allowlist")).toBe(true)
    expect(cols.has("tool_denylist")).toBe(true)
    expect(cols.has("skills")).toBe(true)
    expect(cols.has("mcp_servers")).toBe(true)
    expect(cols.has("system_prompt")).toBe(true)
    expect(cols.has("default_max_steps")).toBe(true)
    expect(cols.has("default_timeout_ms")).toBe(true)
    expect(cols.has("default_schema_retry_budget")).toBe(true)
    expect(cols.has("context_profile")).toBe(true)
    expect(cols.has("created_at")).toBe(true)
    expect(cols.has("updated_at")).toBe(true)
  })

  it("enforces a unique (org_id, agent_type) index", async () => {
    const rows = extractRows<{ indexname: string; indexdef: string }>(
      await db.execute(drizzleSql`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'kernel' AND tablename = 'sub_agent_definitions'
      `),
    )
    const unique = rows.find((r) => r.indexname === "sub_agent_definitions_org_type_idx")
    expect(unique).toBeDefined()
    expect(unique?.indexdef).toContain("UNIQUE")
    expect(unique?.indexdef).toMatch(/org_id.*agent_type|agent_type.*org_id/i)
  })

  it("enforces the context_profile CHECK constraint", async () => {
    const rows = extractRows<{ definition: string }>(
      await db.execute(drizzleSql`
        SELECT pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'kernel'
          AND t.relname = 'sub_agent_definitions'
          AND c.contype = 'c'
      `),
    )
    const check = rows.find((r) => r.definition.includes("context_profile"))
    expect(check).toBeDefined()
    expect(check?.definition).toContain("minimal")
    expect(check?.definition).toContain("standard")
    expect(check?.definition).toContain("full")
  })

  it("has RLS enabled and the select policy installed", async () => {
    const rls = extractRows<{ relrowsecurity: boolean }>(
      await db.execute(drizzleSql`
        SELECT c.relrowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'kernel' AND c.relname = 'sub_agent_definitions'
      `),
    )
    expect(rls[0]?.relrowsecurity).toBe(true)

    const policies = extractRows<{ policyname: string }>(
      await db.execute(drizzleSql`
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'kernel' AND tablename = 'sub_agent_definitions'
      `),
    )
    expect(policies.some((p) => p.policyname === "sub_agent_definitions_select")).toBe(true)
  })
})

describe("kernel.audit_log run-metadata index (0004)", () => {
  it("installs a partial GIN index on metadata for rows with runId", async () => {
    const rows = extractRows<{ indexname: string; indexdef: string }>(
      await db.execute(drizzleSql`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'kernel'
          AND tablename = 'audit_log'
          AND indexname = 'audit_log_run_metadata_idx'
      `),
    )
    expect(rows.length).toBe(1)
    expect(rows[0].indexdef.toLowerCase()).toContain("gin")
    expect(rows[0].indexdef.toLowerCase()).toContain("metadata")
    // Partial predicate
    expect(rows[0].indexdef).toContain("'runId'")
  })
})

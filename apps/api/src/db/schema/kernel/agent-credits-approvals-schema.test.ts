// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"

describe("agent credits, memory and approvals migration: tables and constraints", () => {
  it("all 6 new tables exist in kernel schema", async () => {
    const result = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'kernel'
        AND table_name IN (
          'credit_balances', 'credit_transactions', 'model_pricing',
          'agent_memory', 'approval_requests', 'system_config'
        )
      ORDER BY table_name
    `
    expect(result.length).toBe(6)
    expect(result.map((r: any) => r.table_name)).toEqual([
      "agent_memory",
      "approval_requests",
      "credit_balances",
      "credit_transactions",
      "model_pricing",
      "system_config",
    ])
  })

  it("threads table has type column with CHECK constraint", async () => {
    const result = await sql`
      SELECT column_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'kernel' AND table_name = 'threads' AND column_name = 'type'
    `
    expect(result.length).toBe(1)
    expect(result[0].column_default).toContain("thread")
    expect(result[0].is_nullable).toBe("NO")
  })

  it("messages table has metadata column (nullable jsonb)", async () => {
    const result = await sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'kernel' AND table_name = 'messages' AND column_name = 'metadata'
    `
    expect(result.length).toBe(1)
    expect(result[0].data_type).toBe("jsonb")
    expect(result[0].is_nullable).toBe("YES")
  })

  it("credit_balances uses org_id as primary key", async () => {
    const result = await sql`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'kernel'
        AND tc.table_name = 'credit_balances'
        AND tc.constraint_type = 'PRIMARY KEY'
    `
    expect(result.length).toBe(1)
    expect(result[0].column_name).toBe("org_id")
  })

  it("model_pricing has unique constraint on (provider, model_id)", async () => {
    const result = await sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'kernel'
        AND tablename = 'model_pricing'
        AND indexname = 'model_pricing_provider_model_idx'
    `
    expect(result.length).toBe(1)
  })

  it("agent_memory has unique constraint on (org_id, owner_agent_id, type, name)", async () => {
    const result = await sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'kernel'
        AND tablename = 'agent_memory'
        AND indexname = 'agent_memory_org_owner_type_name_idx'
    `
    expect(result.length).toBe(1)
  })

  it("approval_requests has unique constraint on (org_id, handle)", async () => {
    const result = await sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'kernel'
        AND tablename = 'approval_requests'
        AND indexname = 'approval_requests_org_handle_idx'
    `
    expect(result.length).toBe(1)
  })

  it("approval_request_handle_seq sequence exists", async () => {
    const result = await sql`
      SELECT sequencename FROM pg_sequences
      WHERE schemaname = 'kernel' AND sequencename = 'approval_request_handle_seq'
    `
    expect(result.length).toBe(1)
  })

  it("threads_org_type_updated_idx index exists", async () => {
    const result = await sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'kernel'
        AND tablename = 'threads'
        AND indexname = 'threads_org_type_updated_idx'
    `
    expect(result.length).toBe(1)
  })

  it("system_config has text primary key on key column", async () => {
    const result = await sql`
      SELECT kcu.column_name, c.data_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.columns c
        ON c.table_schema = kcu.table_schema AND c.table_name = kcu.table_name AND c.column_name = kcu.column_name
      WHERE tc.table_schema = 'kernel'
        AND tc.table_name = 'system_config'
        AND tc.constraint_type = 'PRIMARY KEY'
    `
    expect(result.length).toBe(1)
    expect(result[0].column_name).toBe("key")
    expect(result[0].data_type).toBe("text")
  })
})

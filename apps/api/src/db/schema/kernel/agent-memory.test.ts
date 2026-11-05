// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"

describe("AGENT MEMORY SCHEMA: agent_memory table exists with owner_agent_id and required_scopes columns", () => {
  it("has both columns in information_schema", async () => {
    const result = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'kernel' AND table_name = 'agent_memory'
        AND column_name IN ('owner_agent_id', 'required_scopes')
      ORDER BY column_name
    `
    expect(result.map((r: any) => r.column_name)).toEqual(["owner_agent_id", "required_scopes"])
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0152: agent memory and Knowledge documents no longer carry a mark of the turn that wrote them:
// the columns 0150 and 0151 added are gone.
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"

describe("0152 drops the untrusted-provenance columns", () => {
  it("leaves neither agent_memory nor knowledge documents with from_untrusted", async () => {
    const rows = await sql`
      SELECT table_schema, table_name FROM information_schema.columns
      WHERE column_name = 'from_untrusted'
        AND ((table_schema = 'kernel' AND table_name = 'agent_memory')
          OR (table_schema = 'app_knowledge' AND table_name = 'documents'))`
    expect(rows).toHaveLength(0)
  })
})

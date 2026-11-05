// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Meilisearch candidate filter takes a caller-supplied thread id and scope
// strings. Every value must stay inside its string literal.
import { describe, expect, test } from "bun:test"
import { MemorySearchParamsSchema } from "@liaison/shared"
import type { RlsClient } from "~/db"
import { candidateFilter, type MemorySearchContext } from "./memory-search"

const ctx = (scopes: string[]): MemorySearchContext => ({
  userId: "u",
  orgId: "11111111-1111-1111-1111-111111111111",
  db: {} as RlsClient,
  scopes,
})

describe("memory search candidate filter", () => {
  test("a thread id with quotes or backslashes cannot leave its literal", () => {
    const evil = `x" OR org_id != "z`
    const filter = candidateFilter({ query: "q", preferThreadId: evil }, ctx([]), ["message"], null)
    expect(filter).toContain(`thread_id = "x\\" OR org_id != \\"z"`)
    // A trailing backslash must not escape the closing quote.
    const trailing = candidateFilter({ query: "q", threadId: "abc\\" }, ctx([]), ["message"], null)
    expect(trailing).toContain(`thread_id = "abc\\\\"`)
  })

  test("a backslash before a quote in a scope is escaped on both characters", () => {
    const filter = candidateFilter({ query: "q" }, ctx([`a\\" OR x`]), ["message"], null)
    expect(filter).toContain(`required_scopes IN ["a\\\\\\" OR x"]`)
  })

  test("the tool schema accepts a UUID thread id and rejects anything else", () => {
    const id = "22222222-2222-4222-8222-222222222222"
    expect(MemorySearchParamsSchema.safeParse({ query: "q", threadId: id }).success).toBe(true)
    expect(MemorySearchParamsSchema.safeParse({ query: "q", threadId: `x" OR 1` }).success).toBe(
      false,
    )
  })
})

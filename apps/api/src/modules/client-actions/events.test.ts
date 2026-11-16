// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A client action's trail never holds a secret: the one writer refuses a meta
// with a key named token, proof or code at any depth, before any statement runs.
import { describe, expect, it } from "bun:test"
import type { PrivilegedDb } from "~/db"
import { secretKeyIn, writeClientActionEvent } from "./events"

const base = {
  orgId: "00000000-0000-0000-0000-000000000001",
  actionId: "00000000-0000-0000-0000-000000000002",
  event: "code_sent" as const,
  actorKind: "system" as const,
}

function recordingTx() {
  const statements: unknown[] = []
  const execute = async (q: unknown) => {
    statements.push(q)
    return [{ id: "00000000-0000-0000-0000-000000000003" }]
  }
  // A recording stand-in for the privileged handle: only `execute` is ever called.
  const tx = { execute: execute as unknown as PrivilegedDb["execute"] }
  return { statements, tx }
}

describe("client action event meta", () => {
  it("refuses a meta holding a token, a proof or a code, at any depth, and writes nothing", async () => {
    for (const meta of [
      { token: "x" },
      { proof: "x" },
      { code: "123456" },
      { nested: { Token: "x" } },
      { list: [{ ok: 1 }, { code: "1" }] },
      { t: "x" },
      { raw_token: "x" },
    ]) {
      const { tx, statements } = recordingTx()
      await expect(writeClientActionEvent(tx, { ...base, meta })).rejects.toThrow(/cannot hold/)
      expect(statements).toHaveLength(0)
    }
  })

  it("names the path of the secret key it found", () => {
    expect(secretKeyIn({ a: { b: [{ proof: 1 }] } })).toBe("a.b[0].proof")
    expect(secretKeyIn({ format: "pages", pages_sha256: "ab" })).toBeNull()
  })

  it("writes a meta with no secret key", async () => {
    const { tx, statements } = recordingTx()
    await writeClientActionEvent(tx, { ...base, meta: { format: "blocks", left: 3 } })
    expect(statements).toHaveLength(1)
  })
})

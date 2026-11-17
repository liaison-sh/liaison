// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Silence is not acceptance, and no invoice waits on a client: nothing on the
// invoice path reads a client action, an answer on a quote's link creates no
// invoice, and a link that only expired sets no outcome.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { onQuoteClientActionDecided } from "./quote-outcome"
import { createMockDb } from "./test-db"

const SRC = import.meta.dir

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "__fixtures__") continue
      out.push(...sources(full))
    } else if (name.endsWith(".ts") && !name.includes(".test") && !name.endsWith(".testutil.ts")) {
      out.push(full)
    }
  }
  return out
}

describe("no invoice waits on a client action", () => {
  it("the only invoicing source that reads a client action is the quote outcome, which issues nothing", () => {
    const readers = sources(SRC)
      .filter((f) => /client_action/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1))
    expect(readers).toEqual(["quote-outcome.ts"])
    const outcome = readFileSync(join(SRC, "quote-outcome.ts"), "utf8")
    expect(outcome).not.toMatch(/insert\(|invoiceIssue|createAndIssue|convert_to_invoice\(/)
  })

  it("a link that expired unanswered sets no outcome on the quote", async () => {
    const quote = "00000000-0000-4000-8000-00000000c001"
    const db = createMockDb({
      seed: { documents: [{ id: quote, type: "quote", status: "sent", lifecycle_log: [] }] },
    })
    const out = await onQuoteClientActionDecided(
      {
        db,
        client_actions_record: async () => ({
          status: "ok",
          record: { kind: "accept", decision: null, target_id: quote, replaced: false },
        }),
      } as never,
      {
        data: {
          id: "00000000-0000-4000-8000-00000000c002",
          target: { app: "invoicing", type: "document", id: quote },
        },
      },
    )
    expect(out.status).toBe("ignored")
    expect(((await db.findOne("documents", quote)) as { status: string }).status).toBe("sent")
  })
})

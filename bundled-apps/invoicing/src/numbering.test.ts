// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The numbering spec (numbering.ts) and what it does once the batch that writes a document runs
// it: here on the in-memory batch (@liaison/test-helpers/mock-db, the bridge's semantics); the
// real-database proof, concurrency included, is apps/api tests/integration/sandbox-bridge-batch.test.ts.
import { describe, expect, test } from "bun:test"
import { type DocumentType, type IssuerProfileForNumbering, numberingSequence } from "./numbering"
import { createMockDb, type MockDb } from "./test-db"

/** Issue one numbered document of `type` the way issue.ts does: number and row in one batch. */
async function issue(
  db: MockDb,
  issuer: IssuerProfileForNumbering,
  type: DocumentType,
  year = 2026,
  fail = false,
): Promise<{ value: number; formatted: string }> {
  const r = await db.batch({
    sequence: numberingSequence({ issuer_profile: issuer, type, year_of_issue: year }),
    ops: [
      {
        insert: "documents",
        as: "document",
        data: {
          type,
          issuer_profile_id: issuer.id,
          year_of_issue: year,
          number: { $seq: "formatted" },
          number_int: { $seq: "value" },
        },
      },
      ...(fail ? [{ update: "documents", id: "missing-row", data: {} }] : []),
    ],
  })
  return r.sequence as { value: number; formatted: string }
}

describe("numberingSequence", () => {
  test("keys the sequence per (issuer, type, year) and formats with the issuer's prefix", () => {
    const seq = numberingSequence({
      issuer_profile: { id: "iss_42", prefix_invoice: "INV-{YYYY}-" },
      type: "invoice",
      year_of_issue: 2026,
    })
    expect(seq).toEqual({
      key: "invoicing:doc_number:iss_42:invoice:2026",
      format: { prefix: "INV-2026-", pad: 4 },
      unique: {
        entity: "documents",
        field: "number_int",
        where: { issuer_profile_id: "iss_42", type: "invoice", year_of_issue: 2026 },
      },
    })
  })

  test("a prefix with no {YYYY} token is used as is", () => {
    const seq = numberingSequence({
      issuer_profile: { id: "i", prefix_invoice: "INV-" },
      type: "invoice",
      year_of_issue: 2026,
    })
    expect(seq.format.prefix).toBe("INV-")
  })

  test("throws if the issuer is missing the per-type prefix", () => {
    expect(() =>
      numberingSequence({ issuer_profile: { id: "x" }, type: "invoice", year_of_issue: 2026 }),
    ).toThrow(/prefix_invoice/)
  })
})

describe("numbering through the issuing batch", () => {
  test("pads to 4 digits and never truncates past 9999", async () => {
    const db = createMockDb()
    const issuer = { id: "iss_1", prefix_invoice: "INV-{YYYY}-" }
    expect((await issue(db, issuer, "invoice")).formatted).toBe("INV-2026-0001")
    db.__sequences.set("invoicing:doc_number:iss_1:invoice:2026", 9999)
    expect((await issue(db, issuer, "invoice")).formatted).toBe("INV-2026-10000")
  })

  test("each type and each year is its own series, all starting at 1", async () => {
    const db = createMockDb()
    const issuer = {
      id: "iss_all",
      prefix_invoice: "INV-{YYYY}-",
      prefix_quote: "QUO-{YYYY}-",
      prefix_proforma: "PRO-{YYYY}-",
      prefix_po: "PO-{YYYY}-",
      prefix_credit_note: "CN-{YYYY}-",
    }
    expect((await issue(db, issuer, "invoice")).formatted).toBe("INV-2026-0001")
    expect((await issue(db, issuer, "invoice")).formatted).toBe("INV-2026-0002")
    expect((await issue(db, issuer, "credit_note")).formatted).toBe("CN-2026-0001")
    expect((await issue(db, issuer, "quote")).formatted).toBe("QUO-2026-0001")
    expect((await issue(db, issuer, "proforma")).formatted).toBe("PRO-2026-0001")
    expect((await issue(db, issuer, "purchase_order")).formatted).toBe("PO-2026-0001")
    expect((await issue(db, issuer, "invoice", 2025)).formatted).toBe("INV-2025-0001")
  })

  test("steps past numbers documents written another way already hold", async () => {
    // A seed or an import wrote QUO-2026-0001..0003 and left the sequence at 0: the next quote
    // is 0004, never a second 0001 (which the number's unique index refuses).
    const issuer = { id: "iss_seeded", prefix_quote: "QUO-{YYYY}-" }
    const db = createMockDb({
      seed: {
        documents: [1, 2, 3].map((n) => ({
          type: "quote",
          issuer_profile_id: "iss_seeded",
          year_of_issue: 2026,
          number_int: n,
        })),
      },
    })
    expect(await issue(db, issuer, "quote")).toEqual({ value: 4, formatted: "QUO-2026-0004" })
    // The sequence now counts the taken numbers, so the next issue is one allocation.
    expect(db.__sequences.get("invoicing:doc_number:iss_seeded:quote:2026")).toBe(4)
  })

  test("a failed issue consumes no number: the next one takes it", async () => {
    const db = createMockDb()
    const issuer = { id: "iss_gap", prefix_invoice: "INV-{YYYY}-" }
    await issue(db, issuer, "invoice")
    await expect(issue(db, issuer, "invoice", 2026, true)).rejects.toThrow()
    expect((await issue(db, issuer, "invoice")).formatted).toBe("INV-2026-0002")
    expect(db.__all("documents").map((d) => d.number)).toEqual(["INV-2026-0001", "INV-2026-0002"])
  })
})

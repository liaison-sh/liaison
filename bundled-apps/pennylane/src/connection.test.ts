// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { runConnectProbe } from "./connection"
import { PennylaneApiError } from "./lib/pennylane-client"
import type { Page } from "./types"

/** A minimal client surface: list() 200 returns a Page, non-200 throws PennylaneApiError. */
function client(supplierStatus: number, bankStatus: number) {
  const page = <T>(items: T[]): Page<T> => ({ items, next_cursor: null, has_more: false })
  return {
    list: async <T>(path: string): Promise<Page<T>> => {
      if (path.includes("/supplier_invoices")) {
        if (supplierStatus !== 200)
          throw new PennylaneApiError(supplierStatus, "supplier_invoices forbidden")
        return page([{ id: "si_1" } as unknown as T])
      }
      if (path.includes("/bank_accounts")) {
        if (bankStatus !== 200) throw new PennylaneApiError(bankStatus, "bank_accounts forbidden")
        return page([{ id: "ba_1" } as unknown as T])
      }
      return page<T>([])
    },
  }
}

describe("pennylane connect probe (Mission-0 scope test → 3-way verdict)", () => {
  it("both 200 → full scope, cash live", async () => {
    expect(await runConnectProbe(client(200, 200))).toEqual({
      ok: true,
      scope: "full",
      cash_status: "live",
    })
  })
  it("bank 403 → invoice-only degrade, cash unavailable, NOT blocked", async () => {
    expect(await runConnectProbe(client(200, 403))).toEqual({
      ok: true,
      scope: "invoice_only",
      cash_status: "unavailable",
    })
  })
  it("supplier-invoice 403 → throws scoped to finance (blocked_finance)", async () => {
    await expect(runConnectProbe(client(403, 200))).rejects.toThrow(/supplier_invoices/)
  })
  it("non-403 bank error (500) re-throws (transient, not a degrade)", async () => {
    await expect(runConnectProbe(client(200, 500))).rejects.toThrow()
  })
})

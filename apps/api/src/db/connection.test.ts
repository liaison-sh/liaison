// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"

describe("db module exports", () => {
  it("~/db does NOT export db", async () => {
    const dbModule = await import("~/db")
    expect("db" in dbModule).toBe(false)
  })

  it("~/db does NOT export _privilegedDb", async () => {
    const dbModule = await import("~/db")
    expect("_privilegedDb" in dbModule).toBe(false)
  })

  it("~/db still exports sql", async () => {
    const dbModule = await import("~/db")
    expect("sql" in dbModule).toBe(true)
  })

  it("~/db still exports TransactionSql type (module loads)", async () => {
    const dbModule = await import("~/db")
    expect(dbModule).toBeDefined()
  })
})

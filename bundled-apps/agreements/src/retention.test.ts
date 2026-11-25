// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { retentionUntil, sealVersion } from "./seal"
import { signedWorld } from "./seal.testutil"

describe("retention", () => {
  it("is ten years from the seal, or the contract end plus the org's years when later", () => {
    expect(retentionUntil("2026-11-10", null, 5)).toBe("2036-11-10")
    expect(retentionUntil("2026-11-10", "2034-01-31", 5)).toBe("2039-01-31")
    // Never below five years after the end.
    expect(retentionUntil("2026-11-10", "2034-01-31", 2)).toBe("2039-01-31")
  })

  it("sealing sets the agreement's retention date", async () => {
    const w = await signedWorld({ endsOn: "2035-06-30" })
    await w.db.insert("agreements_settings", { retention_years_after_end: 7 })
    await sealVersion(w.ctx, w.versionId)
    const a = await w.db.findOne("agreements", w.agreementId)
    expect((a as { retention_until?: string } | null)?.retention_until).toBe("2042-06-30")
  })

  it("no code of the app deletes a row", () => {
    const dir = join(import.meta.dir)
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.includes(".test.") && !f.includes(".testutil."))
      .filter((f) =>
        /\bDELETE\b|\.delete\(|deleteMany|db_delete/.test(readFileSync(join(dir, f), "utf8")),
      )
    expect(offenders).toEqual([])
  })
})

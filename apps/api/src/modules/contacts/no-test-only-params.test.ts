// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Production code carries no test-only parameters.
//
// `mergeContactsWithMailReferences` took a `failAfterContactMergeForTest`
// boolean in its public parameter object and threw on it mid-transaction. That
// is a test fixture living on the surface the agent tools, the routes and every
// future caller use, and a caller that passes it gets a half-done merge in
// production. Fault injection belongs behind a seam nothing in production
// reaches (`merge-failpoint.ts`), not in a signature.
//
// Fails-without-fix: `service.ts` still declares the parameter.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DIR = join(import.meta.dir)

/** Matches `somethingForTest` / `something_for_test` used as a parameter or field name. */
const TEST_ONLY_FIELD = /\b[a-zA-Z0-9_]*(?:ForTest|_for_test)\??\s*:/g

function productionFiles(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort()
}

describe("contacts module production surface", () => {
  it("declares no test-only parameter or field on a production function", () => {
    const offenders: string[] = []
    for (const file of productionFiles()) {
      // The failpoint module IS the seam: its own exports are named for the
      // role, and it declares no parameter on a production signature.
      if (file === "merge-failpoint.ts") continue
      const source = readFileSync(join(DIR, file), "utf8")
      for (const match of source.matchAll(TEST_ONLY_FIELD)) {
        offenders.push(`${file}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("the merge failpoint seam", () => {
  it("is a no-op until a test arms it, and refuses to arm in production", async () => {
    const { armAfterContactMergeFailpoint, runAfterContactMergeFailpoint } = await import(
      "~/modules/contacts/merge-failpoint"
    )

    // Unarmed: nothing happens, which is every production call.
    await runAfterContactMergeFailpoint()

    let fired = 0
    const disarm = armAfterContactMergeFailpoint(() => {
      fired++
    })
    try {
      await runAfterContactMergeFailpoint()
      expect(fired).toBe(1)
    } finally {
      disarm()
    }
    await runAfterContactMergeFailpoint()
    expect(fired).toBe(1)

    const priorEnv = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      expect(() => armAfterContactMergeFailpoint(() => {})).toThrow("cannot be armed in production")
    } finally {
      process.env.NODE_ENV = priorEnv
    }
  })
})

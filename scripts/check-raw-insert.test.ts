// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { compare, rawInsertFiles } from "./check-raw-insert"

// Built from parts so this file is not itself one of the files it counts.
const INS = ["INSERT", "INTO"].join(" ")

describe("check:raw-insert", () => {
  const files: Record<string, string> = {
    "apps/api/src/a.test.ts": `await sql\`${INS} \${K}.users (id) VALUES (1)\``,
    "apps/api/src/b.test.ts": `tx.execute("${INS} kernel.threads (id) VALUES (1)")`,
    "apps/api/src/c.test.ts": `${INS.toLowerCase()} app_mail.messages values (1)`,
    "apps/api/src/d.test.ts": "await seed.person(orgId)",
    "apps/api/src/tests/helpers/e.ts": `${INS} "kernel.x"`,
    "apps/api/src/product.ts": `${INS} kernel.users (id) VALUES (1)`,
  }

  test("counts test files with a raw insert into a kernel or app table, not product code", () => {
    expect(rawInsertFiles(Object.keys(files), (f) => files[f] as string)).toEqual([
      "apps/api/src/a.test.ts",
      "apps/api/src/b.test.ts",
      "apps/api/src/c.test.ts",
      "apps/api/src/tests/helpers/e.ts",
    ])
  })

  test("fails above the baseline and below it, passes at it", () => {
    expect(compare(11, { files: 10 }).exitCode).toBe(1)
    expect(compare(9, { files: 10 }).exitCode).toBe(1)
    expect(compare(9, { files: 10 }).message).toContain("--write")
    expect(compare(10, { files: 10 }).exitCode).toBe(0)
  })
})

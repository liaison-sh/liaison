// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { compare, formatBaseline, rawInsertFiles, readBaseline } from "./check-raw-insert"

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

  test("fails a file the list does not name and a listed file that is clean, passes on an exact list", () => {
    const added = compare(["a.test.ts", "b.test.ts"], { files: ["a.test.ts"] })
    expect(added.exitCode).toBe(1)
    expect(added.message).toContain("b.test.ts")
    const cleaned = compare(["a.test.ts"], { files: ["a.test.ts", "b.test.ts"] })
    expect(cleaned.exitCode).toBe(1)
    expect(cleaned.message).toContain("--write")
    expect(cleaned.message).toContain("b.test.ts")
    expect(compare(["a.test.ts"], { files: ["a.test.ts"] }).exitCode).toBe(0)
  })

  test("reads and writes one path per line, in name order", () => {
    const text = formatBaseline(["b.test.ts", "a.test.ts"])
    expect(text).toBe('{\n  "files": [\n    "a.test.ts",\n    "b.test.ts"\n  ]\n}\n')
    expect(readBaseline(text).files).toEqual(["a.test.ts", "b.test.ts"])
    expect(() => readBaseline('{"files": 3}')).toThrow()
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, test } from "vitest"
import { pluralFormFor } from "~/modules/projects/plural"

describe("pluralFormFor", () => {
  test("en: only count 1 is 'one'", () => {
    expect(pluralFormFor("en", 0)).toBe("other")
    expect(pluralFormFor("en", 1)).toBe("one")
    expect(pluralFormFor("en", 2)).toBe("other")
  })

  test("fr: 0 and 1 are both 'one'", () => {
    // French takes the singular for 0 as well as 1 -- a 0-task project must
    // read "0 tache", not "0 taches".
    expect(pluralFormFor("fr", 0)).toBe("one")
    expect(pluralFormFor("fr", 1)).toBe("one")
    expect(pluralFormFor("fr", 2)).toBe("other")
  })
})

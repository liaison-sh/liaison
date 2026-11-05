// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The effect sink counts every occurrence of an effect. Regression: its logs
// are sorted sets, and two effects recorded in the same millisecond shared one
// member, so a doubled effect read back as a single one.

import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { recordSinkEffect, sinkEntriesForOrg } from "~/lib/effect-sink"

describe("the effect sink", () => {
  let clock: ReturnType<typeof spyOn> | null = null

  afterEach(() => {
    clock?.mockRestore()
    clock = null
  })

  it("keeps two occurrences recorded in the same millisecond", async () => {
    const orgId = crypto.randomUUID()
    const at = Date.now()
    clock = spyOn(Date, "now").mockReturnValue(at)
    await recordSinkEffect(orgId, "mail", "twice")
    await recordSinkEffect(orgId, "mail", "twice")
    clock.mockRestore()
    clock = null
    const entries = await sinkEntriesForOrg(orgId)
    expect(entries).toEqual([{ kind: "mail", key: "twice", count: 2, firstAt: at, lastAt: at }])
  })
})

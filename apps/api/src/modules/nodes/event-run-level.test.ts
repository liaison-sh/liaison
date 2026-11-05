// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { env } from "~/lib/env"
import { capEventRunLevel } from "./routine-dispatch"

describe("capEventRunLevel", () => {
  it("never lets an event-started node run above strict by default", () => {
    expect(env.NODE_EVENT_RUN_MAX_LEVEL).toBe("strict")
    expect(capEventRunLevel("open")).toBe("strict")
    expect(capEventRunLevel("standard")).toBe("strict")
    expect(capEventRunLevel("strict")).toBe("strict")
  })
})

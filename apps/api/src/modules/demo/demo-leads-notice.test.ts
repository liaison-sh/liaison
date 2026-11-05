// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { DEMO_LEAD_NOTICE_VERSION } from "~/modules/demo/demo-leads"

describe("DEMO_LEAD_NOTICE_VERSION", () => {
  it("is the date of the notice that names the door's company question", () => {
    expect(DEMO_LEAD_NOTICE_VERSION).toBe("2026-11-05")
  })
})

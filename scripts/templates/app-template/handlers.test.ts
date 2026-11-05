// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { mockAppContext } from "~/modules/apps/test-helpers"
import { items_list } from "./handlers"

describe("__APP_NAME__ handlers", () => {
  it("items_list returns an empty array initially", async () => {
    // mockAppContext() is assignable to AppContext — no cast needed.
    const ctx = mockAppContext({ orgId: "test-org" })
    const res = await items_list({}, ctx)
    expect(res.data).toEqual([])
  })
})

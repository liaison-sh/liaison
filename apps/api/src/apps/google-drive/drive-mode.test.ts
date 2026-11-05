// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  DRIVE_READONLY_SCOPE,
  driveModeOf,
  MAX_PICKED_ITEMS,
  mergePickedItems,
  pickedItemsOf,
  pickerConfigured,
} from "~/apps/google-drive/drive-mode"

const FILE = "https://www.googleapis.com/auth/drive.file"
const item = (n: number) => ({
  id: `file-${String(n).padStart(8, "0")}`,
  name: `F${n}`,
  mimeType: "text/plain",
})

describe("Drive mode", () => {
  test("from the recorded grant", () => {
    expect(driveModeOf({ grantedOAuthScopes: ["openid", FILE] })).toBe("picked")
    expect(driveModeOf({ grantedOAuthScopes: [DRIVE_READONLY_SCOPE, FILE] })).toBe("full")
    expect(driveModeOf({ grantedOAuthScopes: ["https://www.googleapis.com/auth/drive"] })).toBe(
      "full",
    )
    // An account older than grant tracking keeps the whole Drive.
    expect(driveModeOf(null)).toBe("full")
    expect(driveModeOf({})).toBe("full")
  })

  test("picked items: malformed and duplicate entries dropped", () => {
    expect(
      pickedItemsOf({ pickedItems: [item(1), item(1), { id: "x", name: "bad" }, "nope", item(2)] }),
    ).toEqual([item(1), item(2)])
    expect(pickedItemsOf({ pickedItems: "nope" })).toEqual([])
  })

  test("merging adds, renames in place, removes, and caps the list", () => {
    const renamed = { ...item(1), name: "Renamed" }
    expect(mergePickedItems([item(1), item(2)], [renamed, item(3)], [item(2).id])).toEqual([
      renamed,
      item(3),
    ])
    const many = Array.from({ length: MAX_PICKED_ITEMS + 5 }, (_, i) => item(i))
    const merged = mergePickedItems([], many, [])
    expect(merged.length).toBe(MAX_PICKED_ITEMS)
    expect(merged.at(-1)).toEqual(item(MAX_PICKED_ITEMS + 4))
  })

  test("the picker needs both the API key and the project number", () => {
    expect(pickerConfigured({})).toBe(false)
    expect(pickerConfigured({ GOOGLE_PICKER_API_KEY: "k" })).toBe(false)
    expect(
      pickerConfigured({ GOOGLE_PICKER_API_KEY: "k", GOOGLE_CLOUD_PROJECT_NUMBER: "123" }),
    ).toBe(true)
  })
})

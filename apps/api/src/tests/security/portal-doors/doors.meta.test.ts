// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every door is negative-tested, strictly. A test title in this folder that starts
// with a door's id closes it. The owed list (`owed.d/`) is closed: it holds no file,
// and a file in it fails here, so a door is never recorded as owed instead of tested.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DOOR_IDS } from "./doors"

const HERE = import.meta.dir
const OWED_DIR = join(HERE, "owed.d")
const ID = /NT-\d+[a-z]?(?![a-z0-9])/
const TITLE = /\b(?:it|test|describe)(?:\.\w+)?\(\s*(["'`])(NT-\d+[a-z]?)(?![a-z0-9])/g

export function titledIds(source: string): string[] {
  const ids: string[] = []
  for (const m of source.matchAll(TITLE)) if (m[2]) ids.push(m[2])
  return ids
}

function testedIds(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of readdirSync(HERE)) {
    if (!file.endsWith(".test.ts") || file === "doors.meta.test.ts") continue
    for (const id of titledIds(readFileSync(join(HERE, file), "utf8"))) {
      found.set(id, [...(found.get(id) ?? []), file])
    }
  }
  return found
}

describe("the door table", () => {
  const doors = new Set<string>(DOOR_IDS)
  const tested = testedIds()

  it("every door in the table has a test whose title starts with its id", () => {
    expect(DOOR_IDS.filter((id) => !tested.has(id))).toEqual([])
  })

  it("the owed list is empty: no door is owed", () => {
    expect(readdirSync(OWED_DIR).filter((f) => f !== ".gitkeep")).toEqual([])
  })

  it("every door id in a test title is in the table", () => {
    expect([...tested.keys()].filter((id) => !doors.has(id))).toEqual([])
  })

  it("the table lists each door once", () => {
    expect(doors.size).toBe(DOOR_IDS.length as number)
  })

  it("the title scan reads the forms the door files use", () => {
    const sample = `it("NT-33b pickers", () => {})\ntest("NT-10 denied")\ndescribe('NT-22 ended', () => {})\nit("names NT-40 later")`
    expect(titledIds(sample)).toEqual(["NT-33b", "NT-10", "NT-22"])
    expect(ID.test("NT-33c")).toBe(true)
  })
})

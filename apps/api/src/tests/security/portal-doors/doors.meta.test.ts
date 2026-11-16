// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every door is negative-tested, or someone is named as owing its test. A test
// title in this folder that starts with a door's id closes it; a file in owed.d/
// (`<id>.json`: `{ id, owner, part? }`) says who still owes it. An owed file
// without `part` beside a test of the same id is stale and fails: the closer
// deletes it in the same change. One with `part` names the half still to come.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DOOR_IDS } from "./doors"

const HERE = import.meta.dir
const OWED_DIR = join(HERE, "owed.d")
const ID = /NT-\d+[a-z]?(?![a-z0-9])/
const TITLE = /\b(?:it|test|describe)(?:\.\w+)?\(\s*(["'`])(NT-\d+[a-z]?)(?![a-z0-9])/g

interface Owed {
  id: string
  owner: string
  part?: string
}

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

function owedFiles(): Array<{ file: string; owed: Owed }> {
  return readdirSync(OWED_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({ file, owed: JSON.parse(readFileSync(join(OWED_DIR, file), "utf8")) as Owed }))
}

describe("the door table", () => {
  const doors = new Set<string>(DOOR_IDS)
  const tested = testedIds()
  const owed = owedFiles()
  const owedIds = new Map(owed.map((o) => [o.owed.id, o.owed]))

  it("every door in the table has a test or an owner in the owed list", () => {
    expect(DOOR_IDS.filter((id) => !tested.has(id) && !owedIds.has(id))).toEqual([])
  })

  it("a door with a test and a whole-door owed file is stale: the closer deletes the file", () => {
    expect(owed.filter((o) => tested.has(o.owed.id) && !o.owed.part).map((o) => o.file)).toEqual([])
  })

  it("every owed file names one door of the table, by its own file name, with an owner", () => {
    const bad = owed.filter(
      (o) =>
        o.file !== `${o.owed.id}.json` ||
        !doors.has(o.owed.id) ||
        typeof o.owed.owner !== "string" ||
        o.owed.owner.trim() === "" ||
        (o.owed.part !== undefined && o.owed.part.trim() === ""),
    )
    expect(bad.map((o) => o.file)).toEqual([])
  })

  it("every door id in a test title is in the table", () => {
    expect([...tested.keys()].filter((id) => !doors.has(id))).toEqual([])
  })

  it("the title scan reads the forms the door files use", () => {
    const sample = `it("NT-33b pickers", () => {})\ntest("NT-10 denied")\ndescribe('NT-22 ended', () => {})\nit("names NT-40 later")`
    expect(titledIds(sample)).toEqual(["NT-33b", "NT-10", "NT-22"])
    expect(ID.test("NT-33c")).toBe(true)
  })
})

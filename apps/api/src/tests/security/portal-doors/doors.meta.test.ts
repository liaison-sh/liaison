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
// Only a test that runs closes a door: a plain or serial/concurrent form, never a parked one.
const TITLE =
  /\b(?:it|test|describe)(?:\.(?:serial|concurrent))?\(\s*(["'`])(NT-\d+[a-z]?)(?![a-z0-9])/g
const PARKED =
  /\b(?:it|test|describe)\.(?:skip|todo|only|failing|if|skipIf|todoIf|runIf)\b|\bx(?:it|test|describe)\(/g

export function titledIds(source: string): string[] {
  const ids: string[] = []
  for (const m of source.matchAll(TITLE)) if (m[2]) ids.push(m[2])
  return ids
}

/** Every parked test form in a source: a skip, todo, only, failing or conditional test. */
export function parkedTests(source: string): string[] {
  return [...source.matchAll(PARKED)].map((m) => m[0])
}

function doorFiles(): string[] {
  return readdirSync(HERE).filter((f) => f.endsWith(".test.ts") && f !== "doors.meta.test.ts")
}

function testedIds(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of doorFiles()) {
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

  it("a skipped, todo or conditional test closes no door", () => {
    const sample = [
      `it.skip("NT-10 parked", () => {})`,
      `it.todo("NT-11 later")`,
      `test.skipIf(true)("NT-12 off")`,
      `test.if(false)("NT-13 off")`,
      `describe.skip("NT-14 parked", () => {})`,
      `describe.todo("NT-15 later")`,
      `it.failing("NT-16 inverted", () => {})`,
    ].join("\n")
    expect(titledIds(sample)).toEqual([])
    expect(parkedTests(sample)).toHaveLength(7)
  })

  it("no door file parks a test: no skip, todo, only, failing or conditional form", () => {
    const parked: string[] = []
    for (const file of doorFiles()) {
      for (const form of parkedTests(readFileSync(join(HERE, file), "utf8"))) {
        parked.push(`${file}: ${form}`)
      }
    }
    expect(parked).toEqual([])
  })
})

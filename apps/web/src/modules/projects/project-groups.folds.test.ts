// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "vitest"
import { loadFoldedGroups, saveFoldedGroups } from "~/modules/projects/project-groups"

const LEGACY = "liaison:projects:folded-groups"
const alice = { orgId: "org-1", userId: "user-a" }
const bob = { orgId: "org-1", userId: "user-b" }
const aliceElsewhere = { orgId: "org-2", userId: "user-a" }

afterEach(() => localStorage.clear())

describe("folded project groups", () => {
  it("are kept per org and per person on a shared device", () => {
    saveFoldedGroups(alice, ["Product"])
    saveFoldedGroups(bob, ["Legal"])
    expect(loadFoldedGroups(alice)).toEqual(["Product"])
    expect(loadFoldedGroups(bob)).toEqual(["Legal"])
    expect(loadFoldedGroups(aliceElsewhere)).toEqual([])
    expect(localStorage.getItem(LEGACY)).toBeNull()
  })

  it("the device-wide key of earlier builds moves to the first person who reads it, once", () => {
    localStorage.setItem(LEGACY, JSON.stringify(["Product"]))
    expect(loadFoldedGroups(alice)).toEqual(["Product"])
    expect(localStorage.getItem(LEGACY)).toBeNull()
    expect(loadFoldedGroups(alice)).toEqual(["Product"])
    expect(loadFoldedGroups(bob)).toEqual([])
  })

  it("no session keeps nothing", () => {
    saveFoldedGroups(null, ["Product"])
    expect(loadFoldedGroups(null)).toEqual([])
    expect(localStorage.length).toBe(0)
  })
})

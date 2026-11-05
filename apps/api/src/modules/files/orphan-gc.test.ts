// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "bun:test"

type Mod = typeof import("./orphan-gc")
let mod: Mod

beforeAll(async () => {
  mod = await import("./orphan-gc")
})

const ORG = "00000000-0000-0000-0000-000000000001"

describe("collectOrphanKeysForOrg", () => {
  it("returns keys older than 24h not present in referenced set", async () => {
    const now = new Date("2026-05-13T10:00:00Z")
    const oldKey = "orgs/o/old.bin"
    const recentKey = "orgs/o/recent.bin"
    const referencedKey = "orgs/o/ref.bin"
    async function* listIter() {
      yield { Key: oldKey, LastModified: new Date("2026-05-10T00:00:00Z") }
      yield { Key: recentKey, LastModified: new Date("2026-05-13T09:00:00Z") }
      yield { Key: referencedKey, LastModified: new Date("2026-05-10T00:00:00Z") }
    }
    const orphans = await mod.collectOrphanKeysForOrg(ORG, new Set([referencedKey]), {
      now,
      listOrgPrefixIter: listIter as any,
    })
    expect(orphans).toEqual([oldKey])
  })

  it("excludes objects within 24h grace window", async () => {
    const now = new Date("2026-05-13T10:00:00Z")
    async function* listIter() {
      yield { Key: "orgs/o/k", LastModified: new Date("2026-05-13T00:00:00Z") }
    }
    const orphans = await mod.collectOrphanKeysForOrg(ORG, new Set(), {
      now,
      listOrgPrefixIter: listIter as any,
    })
    expect(orphans).toEqual([])
  })

  it("preserves keys present in either storage_key or thumbnail_key set", async () => {
    const now = new Date("2026-05-13T10:00:00Z")
    async function* listIter() {
      yield { Key: "orgs/o/a", LastModified: new Date("2026-05-10T00:00:00Z") }
      yield { Key: "orgs/o/a.thumb.webp", LastModified: new Date("2026-05-10T00:00:00Z") }
    }
    const orphans = await mod.collectOrphanKeysForOrg(
      ORG,
      new Set(["orgs/o/a", "orgs/o/a.thumb.webp"]),
      { now, listOrgPrefixIter: listIter as any },
    )
    expect(orphans).toEqual([])
  })
})

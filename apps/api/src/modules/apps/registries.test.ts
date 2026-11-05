// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  captureRegistrationTemplate,
  closeRegistryJournal,
  createTypedRegistry,
  deleteRegistryEntriesOfOrgs,
  openRegistryJournal,
  replayRegistrationTemplate,
  TEMPLATE_ORG,
} from "~/modules/apps/registries"

describe("createTypedRegistry", () => {
  it("round-trips: get returns what was set", () => {
    const reg = createTypedRegistry<
      [orgId: string, appName: string, dimKey: string],
      { type: string }
    >()
    reg.set(["org1", "test", "team"], { type: "membership" })
    expect(reg.get(["org1", "test", "team"])).toEqual({ type: "membership" })
  })

  it("returns undefined for missing key", () => {
    const reg = createTypedRegistry<[orgId: string, dimKey: string], string>()
    expect(reg.get(["org1", "team"])).toBeUndefined()
  })

  it("different key shapes produce different keys (no collision)", () => {
    const reg = createTypedRegistry<[a: string, b: string, c: string], string>()
    reg.set(["a", "b:c", "d"], "wrong")
    reg.set(["a", "b", "c:d"], "right")
    expect(reg.get(["a", "b", "c:d"])).toBe("right")
    expect(reg.get(["a", "b:c", "d"])).toBe("wrong")
  })

  it("delete removes entry", () => {
    const reg = createTypedRegistry<[orgId: string, app: string], number>()
    reg.set(["o", "a"], 1)
    reg.delete(["o", "a"])
    expect(reg.get(["o", "a"])).toBeUndefined()
  })

  it("clear removes all entries", () => {
    const reg = createTypedRegistry<[k: string], number>()
    reg.set(["a"], 1)
    reg.set(["b"], 2)
    reg.clear()
    expect(reg.get(["a"])).toBeUndefined()
  })

  it("prunes only the keys a journal did not see written (a version switch)", () => {
    const reg = createTypedRegistry<[orgId: string, app: string, tool: string], string>()
    reg.set(["o", "a", "kept"], "v1")
    reg.set(["o", "a", "same"], "v1")
    reg.set(["o", "a", "dropped"], "v1")
    reg.set(["o", "b", "other"], "v1")
    const before = reg.snapshotUnder(["o", "a"])
    const journal = openRegistryJournal()
    reg.set(["o", "a", "kept"], "v2")
    // The same value written again still counts as written.
    reg.set(["o", "a", "same"], "v1")
    closeRegistryJournal(journal)
    reg.set(["o", "a", "late"], "after close")
    reg.pruneUnwritten(before, journal)
    expect(reg.get(["o", "a", "kept"])).toBe("v2")
    expect(reg.get(["o", "a", "same"])).toBe("v1")
    expect(reg.get(["o", "a", "dropped"])).toBeUndefined()
    expect(reg.get(["o", "a", "late"])).toBe("after close")
    expect(reg.get(["o", "b", "other"])).toBe("v1")
  })

  it("restores exactly the snapshot under a prefix (a failed version switch)", () => {
    const reg = createTypedRegistry<[orgId: string, app: string, tool: string], string>()
    reg.set(["o", "a", "kept"], "v1")
    reg.set(["o", "b", "other"], "v1")
    const before = reg.snapshotUnder(["o", "a"])
    reg.set(["o", "a", "kept"], "v2")
    reg.set(["o", "a", "new"], "v2")
    reg.restoreUnder(["o", "a"], before)
    expect(reg.get(["o", "a", "kept"])).toBe("v1")
    expect(reg.get(["o", "a", "new"])).toBeUndefined()
    expect(reg.get(["o", "b", "other"])).toBe("v1")
  })

  it("entriesOf(org) is always entries() filtered to that org, in the same order", async () => {
    type Key = [orgId: string, app: string, tool: string]
    const reg = createTypedRegistry<Key, number>()
    // Org ids unique to this test: deleteRegistryEntriesOfOrgs reaches every registry.
    const orgs = ["eo-1", "eo-2", "eo-3", "*"]
    const apps = ["a", "b"]
    const tools = ["t1", "t2", "t3"]
    let seed = 42
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const pick = <T>(xs: T[]): T => xs[rand(xs.length)] as T
    const template = await captureRegistrationTemplate((orgId) => {
      reg.set([orgId, "a", "t1"], 100)
      reg.set([orgId, "tpl", "t9"], 101)
      reg.set(["*", "tpl", "shared"], 102)
    })
    const check = (step: string): void => {
      const all = [...reg.entries()]
      let total = 0
      for (const org of [...orgs, TEMPLATE_ORG]) {
        const bucket = [...reg.entriesOf(org)]
        total += bucket.length
        expect(bucket, `${step} / ${org}`).toEqual(all.filter(([k]) => k[0] === org))
      }
      expect(total, step).toBe(reg.size)
    }
    let value = 0
    for (let i = 0; i < 2000; i++) {
      const org = pick(orgs)
      const op = rand(9)
      if (op <= 2) {
        reg.set([org, pick(apps), pick(tools)], value++)
      } else if (op === 3) {
        reg.delete([org, pick(apps), pick(tools)])
      } else if (op === 4) {
        reg.deleteByPrefix(rand(2) === 0 ? [org] : [org, pick(apps)])
      } else if (op === 5) {
        const prefix = [org, pick(apps)]
        const before = reg.snapshotUnder(prefix)
        expect([...before.keys()]).toEqual(
          [...reg.entries()]
            .filter(([k]) => k[0] === prefix[0] && k[1] === prefix[1])
            .map(([k]) => k.join("\0")),
        )
        reg.set([org, pick(apps), pick(tools)], value++)
        reg.restoreUnder(prefix, before)
      } else if (op === 6) {
        const before = reg.snapshotUnder([org])
        const journal = openRegistryJournal()
        reg.set([org, pick(apps), pick(tools)], value++)
        closeRegistryJournal(journal)
        reg.pruneUnwritten(before, journal)
      } else if (op === 7) {
        replayRegistrationTemplate(template, org)
      } else {
        deleteRegistryEntriesOfOrgs(new Set([org]))
      }
      check(`step ${i} op ${op}`)
    }
    reg.clear()
    check("clear")
  })
})

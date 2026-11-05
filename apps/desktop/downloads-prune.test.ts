// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pruning old version folders off the downloads host after a release: the
// order (semver, prerelease aware), what is never deleted (the version just
// published, anything a manifest names, anything outside a version folder of
// the channel), --keep 0, the dry run, and a failing delete that stays a
// warning.
import { describe, expect, it } from "bun:test"
import { MANIFEST_KEY, TEST_MANIFEST_KEY } from "./ci/downloads"
import {
  compareVersions,
  DEFAULT_KEEP,
  type ListedObject,
  type PruneIo,
  parseKeep,
  planPrune,
  runPrune,
  versionsReferencedBy,
} from "./ci/prune-downloads"

const MB = 1024 * 1024

function release(version: string, test = false): ListedObject[] {
  const root = test ? `desktop/test/${version}` : `desktop/${version}`
  return [
    { key: `${root}/Liaison_${version}_universal.dmg`, size: 400 * MB },
    { key: `${root}/Liaison_${version}_universal.app.tar.gz`, size: 300 * MB },
    { key: `${root}/Liaison_${version}_universal.app.tar.gz.sig`, size: 1024 },
  ]
}

function manifest(version: string, test = false): string {
  const root = test ? `desktop/test/${version}` : `desktop/${version}`
  return JSON.stringify({
    version,
    notes: "n",
    pub_date: "2026-10-23T00:00:00Z",
    platforms: {
      "darwin-aarch64": {
        signature: "s",
        url: `https://downloads.liaison.sh/${root}/Liaison_${version}_universal.app.tar.gz`,
      },
    },
  })
}

function fakeIo(input: {
  objects: ListedObject[]
  manifests?: Record<string, string>
  failKeys?: Set<string>
}) {
  const logs: string[] = []
  const deleteCalls: string[][] = []
  const listed: string[] = []
  const io: PruneIo = {
    async list(prefix) {
      listed.push(prefix)
      return input.objects.filter((object) => object.key.startsWith(prefix))
    },
    async readText(key) {
      return input.manifests?.[key]
    },
    async deleteKeys(keys) {
      deleteCalls.push(keys)
      const failed = keys
        .filter((key) => input.failKeys?.has(key))
        .map((key) => ({ key, error: "500 InternalError" }))
      return { deleted: keys.filter((key) => !input.failKeys?.has(key)), failed }
    },
    log: (message) => logs.push(message),
  }
  return { io, logs, deleteCalls, listed }
}

describe("semver ordering", () => {
  it("orders numerically, never lexically", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0)
    expect(compareVersions("0.2.0", "0.1.99")).toBeGreaterThan(0)
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0)
  })

  it("is prerelease aware", () => {
    expect(compareVersions("0.1.33-test.2", "0.1.33-test.1")).toBeGreaterThan(0)
    expect(compareVersions("0.1.33-test.10", "0.1.33-test.9")).toBeGreaterThan(0)
    expect(compareVersions("0.1.33", "0.1.33-test.9")).toBeGreaterThan(0)
    expect(compareVersions("0.1.33-test.1", "0.1.32")).toBeGreaterThan(0)
    expect(compareVersions("0.1.33-alpha", "0.1.33-1")).toBeGreaterThan(0)
    expect(compareVersions("0.1.33-test", "0.1.33-test.1")).toBeLessThan(0)
    expect(compareVersions("0.1.33", "0.1.33")).toBe(0)
  })

  it("keeps the newest by semver whatever order the listing came in", () => {
    const objects = ["0.1.9", "0.1.10", "0.1.8", "0.1.11", "0.1.7"].flatMap((v) => release(v))
    const plan = planPrune({ objects, published: "0.1.11", keep: 3, referenced: [] })
    expect(plan.versions).toEqual(["0.1.11", "0.1.10", "0.1.9", "0.1.8", "0.1.7"])
    expect(plan.kept.map((k) => k.version)).toEqual(["0.1.11", "0.1.10", "0.1.9"])
    expect(plan.deleted.map((d) => d.version)).toEqual(["0.1.8", "0.1.7"])
    expect(plan.bytes).toBe(2 * (700 * MB + 1024))
  })

  it("orders test builds by their prerelease number", () => {
    const objects = ["0.1.33-test.1", "0.1.33-test.10", "0.1.33-test.2", "0.1.32-test.4"].flatMap(
      (v) => release(v, true),
    )
    const plan = planPrune({ objects, published: "0.1.33-test.10", keep: 2, referenced: [] })
    expect(plan.kept.map((k) => k.version)).toEqual(["0.1.33-test.10", "0.1.33-test.2"])
    expect(plan.deleted.map((d) => d.version)).toEqual(["0.1.33-test.1", "0.1.32-test.4"])
  })
})

describe("what is never deleted", () => {
  it("keeps a test version the test latest.json points at", async () => {
    const objects = [
      "0.1.30-test.1",
      "0.1.31-test.1",
      "0.1.32-test.1",
      "0.1.33-test.1",
      "0.1.34-test.1",
    ].flatMap((v) => release(v, true))
    const { io, deleteCalls } = fakeIo({
      objects,
      manifests: { [TEST_MANIFEST_KEY]: manifest("0.1.30-test.1", true) },
    })
    const result = await runPrune({ published: "0.1.34-test.1", keep: 3, dryRun: false, io })
    expect(result.ok).toBe(true)
    const kept = result.plan?.kept.find((k) => k.version === "0.1.30-test.1")
    expect(kept?.reasons).toContain("named by a latest.json")
    expect(deleteCalls.flat().every((key) => key.startsWith("desktop/test/0.1.31-test.1/"))).toBe(
      true,
    )
  })

  it("keeps the version just published even when it is not the newest", () => {
    const objects = ["0.1.5", "0.1.6", "0.1.7", "0.1.8", "0.1.2"].flatMap((v) => release(v))
    const plan = planPrune({ objects, published: "0.1.2", keep: 3, referenced: [] })
    expect(plan.kept.map((k) => k.version)).toEqual(["0.1.8", "0.1.7", "0.1.6", "0.1.2"])
    expect(plan.kept.at(-1)?.reasons).toEqual(["just published"])
    expect(plan.deleted.map((d) => d.version)).toEqual(["0.1.5"])
  })

  it("leaves foreign prefixes, root files, aliases and the other channel alone", () => {
    const foreign: ListedObject[] = [
      { key: MANIFEST_KEY, size: 1 },
      { key: TEST_MANIFEST_KEY, size: 1 },
      { key: "desktop/latest/Liaison-macos.dmg", size: 400 * MB },
      { key: "desktop/README.txt", size: 10 },
      { key: "desktop/nightly/0.0.1/x.dmg", size: 10 },
      { key: "desktop/0.1.1+build/x.dmg", size: 10 },
      { key: "desktop/0.1.1-test.1/x.dmg", size: 10 },
      { key: "other/0.0.1/x.dmg", size: 10 },
    ]
    const objects = [
      ...foreign,
      ...["0.1.1", "0.1.2", "0.1.3", "0.1.4"].flatMap((v) => release(v)),
      ...["0.1.0-test.1"].flatMap((v) => release(v, true)),
    ]
    const production = planPrune({ objects, published: "0.1.4", keep: 1, referenced: [] })
    const deletedKeys = production.deleted.flatMap((d) => d.keys)
    expect(production.deleted.map((d) => d.version)).toEqual(["0.1.3", "0.1.2", "0.1.1"])
    for (const key of deletedKeys) expect(key).toMatch(/^desktop\/0\.1\.[123]\//)
    for (const object of foreign) expect(deletedKeys).not.toContain(object.key)
    expect(deletedKeys.some((key) => key.startsWith("desktop/test/"))).toBe(false)

    // And the test channel never reaches outside desktop/test/.
    const test = planPrune({ objects, published: "0.1.5-test.1", keep: 1, referenced: [] })
    expect(test.versions).toEqual(["0.1.0-test.1"])
    expect(test.kept.map((k) => k.version)).toEqual(["0.1.0-test.1"])
    expect(test.deleted).toEqual([])
    expect(test.ignored).toContain(TEST_MANIFEST_KEY)
  })

  it("reads every version a manifest names, in either channel", () => {
    expect(versionsReferencedBy(manifest("0.1.9"))).toEqual(["0.1.9"])
    const mixed = JSON.stringify({
      version: "0.1.10",
      platforms: {
        a: { url: "https://downloads.liaison.sh/desktop/0.1.8/x.tar.gz" },
        b: { url: "https://downloads.liaison.sh/desktop/test/0.1.7-test.1/x.tar.gz" },
      },
    })
    expect(versionsReferencedBy(mixed).sort()).toEqual(["0.1.10", "0.1.7-test.1", "0.1.8"])
  })

  it("prunes nothing when a manifest cannot be parsed", async () => {
    const objects = ["0.1.1", "0.1.2", "0.1.3", "0.1.4", "0.1.5"].flatMap((v) => release(v))
    const { io, deleteCalls } = fakeIo({ objects, manifests: { [MANIFEST_KEY]: "{not json" } })
    const result = await runPrune({ published: "0.1.5", keep: 3, dryRun: false, io })
    expect(result.ok).toBe(false)
    expect(deleteCalls).toEqual([])
    expect(result.warnings[0]).toContain("cannot be parsed")
  })
})

describe("--keep", () => {
  it("defaults to 3 and refuses a value that is not a whole number", () => {
    expect(DEFAULT_KEEP).toBe(3)
    expect(parseKeep([])).toBe(3)
    expect(parseKeep(["--keep", "5"])).toBe(5)
    expect(parseKeep(["--keep", "0"])).toBe(0)
    expect(() => parseKeep(["--keep", "-1"])).toThrow()
    expect(() => parseKeep(["--keep"])).toThrow()
  })

  it("--keep 0 disables pruning, touching nothing", async () => {
    const objects = ["0.1.1", "0.1.2", "0.1.3", "0.1.4", "0.1.5"].flatMap((v) => release(v))
    const { io, deleteCalls, listed, logs } = fakeIo({ objects })
    const result = await runPrune({ published: "0.1.5", keep: 0, dryRun: false, io })
    expect(result.ok).toBe(true)
    expect(deleteCalls).toEqual([])
    expect(listed).toEqual([])
    expect(logs.join("\n")).toContain("pruning disabled")
    expect(planPrune({ objects, published: "0.1.5", keep: 0, referenced: [] }).deleted).toEqual([])
  })
})

describe("running it", () => {
  const objects = ["0.1.1", "0.1.2", "0.1.3", "0.1.4", "0.1.5"].flatMap((v) => release(v))

  it("dry run prints what would go and deletes nothing", async () => {
    const { io, deleteCalls, logs } = fakeIo({
      objects,
      manifests: { [MANIFEST_KEY]: manifest("0.1.5") },
    })
    const result = await runPrune({ published: "0.1.5", keep: 3, dryRun: true, io })
    expect(result.ok).toBe(true)
    expect(deleteCalls).toEqual([])
    expect(result.deletedKeys).toEqual([])
    const out = logs.join("\n")
    expect(out).toContain("would delete 0.1.2")
    expect(out).toContain("would delete 0.1.1")
    expect(out).toContain("keep 0.1.5")
    expect(out).toContain("would free 1.4 GB")
  })

  it("deletes the old folders, one batch per version, and logs the bytes freed", async () => {
    const { io, deleteCalls, logs } = fakeIo({
      objects,
      manifests: { [MANIFEST_KEY]: manifest("0.1.5") },
    })
    const result = await runPrune({ published: "0.1.5", keep: 3, dryRun: false, io })
    expect(result.ok).toBe(true)
    expect(deleteCalls.map((keys) => keys.length)).toEqual([3, 3])
    expect(result.deletedKeys.every((key) => /^desktop\/0\.1\.[12]\//.test(key))).toBe(true)
    expect(result.bytesFreed).toBe(2 * (700 * MB + 1024))
    expect(logs.join("\n")).toContain("freed 1.4 GB")
  })

  it("a failing delete is a warning, never a throw", async () => {
    const failing = "desktop/0.1.1/Liaison_0.1.1_universal.dmg"
    const { io } = fakeIo({ objects, failKeys: new Set([failing]) })
    const result = await runPrune({ published: "0.1.5", keep: 3, dryRun: false, io })
    expect(result.ok).toBe(false)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("0.1.1 only partly deleted")
    expect(result.warnings[0]).toContain(failing)
    // The other version still went, and only bytes actually deleted count.
    expect(result.deletedKeys).toContain("desktop/0.1.2/Liaison_0.1.2_universal.dmg")
    expect(result.bytesFreed).toBe(700 * MB + 1024 + 300 * MB + 1024)
  })

  it("a listing that throws is a warning, never a throw", async () => {
    const { io } = fakeIo({ objects })
    io.list = async () => {
      throw new Error("403 AccessDenied")
    }
    const result = await runPrune({ published: "0.1.5", keep: 3, dryRun: false, io })
    expect(result.ok).toBe(false)
    expect(result.warnings[0]).toContain("403 AccessDenied")
  })
})

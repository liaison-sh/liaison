// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bundle framing: a reader yields only verified sections and refuses a
// changed line, a cut stream, a missing or altered manifest, data after it.
import { describe, expect, it } from "bun:test"
import { BundleError, BundleWriter, readBundle } from "./bundle"

function bundle(): string[] {
  const w = new BundleWriter()
  w.section("header", [JSON.stringify({ a: 1 })])
  w.section("rows:kernel.users", ['{"id":"1"}', '{"id":"2"}'])
  w.section("empty", [])
  return w.finish({ "kernel.users": 2 })
}

async function readAll(lines: string[]) {
  const out: string[] = []
  const it = readBundle(lines)
  for (;;) {
    const n = await it.next()
    if (n.done) return { sections: out, manifest: n.value }
    out.push(`${n.value.name}:${n.value.data.length}`)
  }
}

describe("org transfer bundle", () => {
  it("round-trips sections and the manifest", async () => {
    const r = await readAll(bundle())
    expect(r.sections).toEqual(["header:1", "rows:kernel.users:2", "empty:0"])
    expect(r.manifest.counts).toEqual({ "kernel.users": 2 })
  })

  it("refuses a changed data line", async () => {
    const lines = bundle()
    lines[4] = '{"id":"3"}'
    await expect(readAll(lines)).rejects.toThrow(/sha256 mismatch/)
  })

  it("refuses a stream cut before the manifest, or inside a section", async () => {
    const lines = bundle()
    await expect(readAll(lines.slice(0, -1))).rejects.toThrow(/before the manifest/)
    await expect(readAll(lines.slice(0, 5))).rejects.toThrow(BundleError)
  })

  it("refuses an altered manifest and data after it", async () => {
    const lines = bundle()
    const m = JSON.parse(lines.at(-1) as string)
    m.counts["kernel.users"] = 3
    await expect(readAll([...lines.slice(0, -1), JSON.stringify(m)])).rejects.toThrow(
      /manifest sha256/,
    )
    await expect(readAll([...lines, '{"k":"begin"}'])).rejects.toThrow(/after the manifest/)
  })

  it("refuses a data line holding a newline at write time", () => {
    expect(() => new BundleWriter().section("x", ["a\nb"])).toThrow(BundleError)
  })
})

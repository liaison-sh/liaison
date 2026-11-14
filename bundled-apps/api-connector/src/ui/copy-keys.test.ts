// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app's screens run in the app frame, where only the app's own copy
// (en.json / fr.json) is loaded: a host key such as `kernel.common.delete`
// would show as its raw key on a button. Every key the screens read must be
// one of the app's own, present in both languages.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import EN from "./en.json"
import FR from "./fr.json"

function lookup(tree: unknown, path: string[]): string | null {
  let node = tree
  for (const seg of path) {
    if (!node || typeof node !== "object") return null
    node = (node as Record<string, unknown>)[seg]
  }
  return typeof node === "string" ? node : null
}

const dir = import.meta.dir
const keys = new Set<string>()
for (const file of readdirSync(dir)) {
  if (!file.endsWith(".tsx")) continue
  const source = readFileSync(join(dir, file), "utf8")
  for (const m of source.matchAll(/\bt\(\s*"([^"]+)"/g)) keys.add(m[1] as string)
}

describe("api-connector screen copy", () => {
  it("reads keys from the screens", () => {
    expect(keys.size).toBeGreaterThan(10)
  })

  it("reads only the app's own keys, each in English and French", () => {
    const foreign = [...keys].filter((k) => !k.startsWith("api-connector."))
    expect(foreign).toEqual([])
    const missing = [...keys].filter((k) => {
      const path = k.replace(/^api-connector\./, "").split(".")
      return lookup(EN, path) === null || lookup(FR, path) === null
    })
    expect(missing).toEqual([])
  })
})

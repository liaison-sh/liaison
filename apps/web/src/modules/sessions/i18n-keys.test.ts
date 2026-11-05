// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every `kernel.nodeSessions.*` key the Sessions app names in its source must
// exist in BOTH shipped catalogues. A cleanup once deleted three keys the
// transcript still read (view.type.model_changed, level_changed, resumed), so
// the screen showed the raw key. The guard scans the source, not a list.
//
// A key built with a template literal (`kernel.nodeSessions.status.${s}`)
// counts by its static prefix: that prefix must be an object in the catalogue.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"

const DIR = import.meta.dirname

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

function lookup(catalogue: unknown, key: string): unknown {
  let cur: unknown = catalogue
  for (const seg of key.split(".").slice(1)) {
    if (cur === null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function referencedKeys(): { key: string; dynamic: boolean }[] {
  const found = new Map<string, boolean>()
  for (const file of sourceFiles(DIR)) {
    const src = readFileSync(file, "utf8")
    for (const m of src.matchAll(/kernel\.nodeSessions\.[A-Za-z0-9_.]+(\$\{)?/g)) {
      const dynamic = m[1] !== undefined
      const key = m[0].replace(/\$\{$/, "").replace(/\.$/, "")
      found.set(key, (found.get(key) ?? false) || dynamic)
    }
  }
  return [...found].map(([key, dynamic]) => ({ key, dynamic }))
}

describe("Sessions app i18n keys", () => {
  const keys = referencedKeys()

  test("the scan finds the keys the app reads", () => {
    expect(keys.length).toBeGreaterThan(40)
    expect(keys.map((k) => k.key)).toContain("kernel.nodeSessions.view.type.model_changed")
  })

  for (const [name, catalogue] of [
    ["en", en],
    ["fr", fr],
  ] as const) {
    test(`every referenced key exists in ${name}`, () => {
      const missing = keys
        .filter(({ key, dynamic }) => {
          const v = lookup(catalogue, key)
          return dynamic ? v === undefined || typeof v !== "object" : typeof v !== "string"
        })
        .map(({ key }) => key)
      expect(missing).toEqual([])
    })
  }
})

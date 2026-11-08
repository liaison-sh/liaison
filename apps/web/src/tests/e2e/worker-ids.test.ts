// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every profiled Playwright fixture owns its worker ids modulo 100: the ids
// pick the worker's ports, the ports wrap at 100 ids inside a run namespace,
// and a worker that boots kills whatever already listens on its ports. Two
// profiles that met modulo 100 (180 and 280, 30 and 230, 140 and 240) killed
// each other's servers whenever their files ran at once in one shard.
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PROFILE_WORKER_SLOTS } from "./fixtures/worker-slots"

const E2E_DIR = __dirname
/** The API runner's workers (0-4) and the shared lanes (pw-lanes.ts, 10-14). */
const RESERVED = [
  { owner: "api e2e runner", start: 0 },
  { owner: "shared lanes", start: 10 },
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(full)
    return e.name.endsWith(".ts") ? [full] : []
  })
}

describe("profiled fixture worker ids", () => {
  it("every profile's range is its own modulo 100", () => {
    const ranges = [...RESERVED]
    for (const file of sources(E2E_DIR)) {
      for (const m of readFileSync(file, "utf8").matchAll(/workerIdOffset: (\d+),/g)) {
        ranges.push({ owner: path.relative(E2E_DIR, file), start: Number(m[1]) })
      }
    }
    expect(ranges.length).toBeGreaterThan(RESERVED.length + 5)
    const owners = new Map<number, string>()
    const clashes: string[] = []
    for (const { owner, start } of ranges) {
      for (let i = 0; i < PROFILE_WORKER_SLOTS; i++) {
        const slot = (start + i) % 100
        const prev = owners.get(slot)
        if (prev) clashes.push(`${owner} (${start}) meets ${prev} at id ${slot} modulo 100`)
        else owners.set(slot, `${owner} (${start})`)
      }
    }
    expect(clashes).toEqual([])
  })
})

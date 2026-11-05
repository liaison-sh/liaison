#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Home route's chunk, measured inside the Capacitor build rather than
// argued about. Home is the app's lazy boundary
// (apps/web/src/framework/bootstrap.ts, `lazy(() => import("~/modules/shell/Home"))`),
// which makes it the first thing a phone downloads after the entry, on whatever
// connection the user happens to have.
//
// The budget below was DERIVED from a measurement, not guessed: the synced iOS
// build measured 12,177 bytes gzipped on 2026-09-13, and the gate sits at
// 20,480 bytes, about 69 percent of headroom. That is deliberately far tighter
// than the 1.5 MB ceiling the epic's budget section names: a ceiling nothing
// can reach catches nothing, and the point of this check is to notice the day
// Home doubles.
//
// Usage: bun run scripts/check-bundle-size.ts [--dir <synced asset tree>]

import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { SYNCED_ASSET_DIRS } from "./build-mobile"

/** Gzipped bytes. Derived from the measurement in the header comment. */
export const HOME_CHUNK_BUDGET_BYTES = 20_480

const MOBILE_ROOT = path.resolve(import.meta.dir, "..")
/** Vite names the chunk after the module: `assets/Home-<hash>.js`. */
const HOME_CHUNK = /^Home-[A-Za-z0-9_-]+\.js$/

export interface ChunkMeasurement {
  file: string
  raw: number
  gzipped: number
}

/** The Home chunk in one built asset tree. Throws when there is not exactly one. */
export function measureHomeChunk(assetTree: string): ChunkMeasurement {
  const assets = path.join(assetTree, "assets")
  let entries: string[]
  try {
    entries = readdirSync(assets)
  } catch {
    throw new Error(`no assets directory in ${assetTree}: nothing was measured`)
  }
  const matches = entries.filter((entry) => HOME_CHUNK.test(entry))
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one Home chunk in ${assets}, found ${matches.length}. The lazy ` +
        "boundary this budget measures has moved or is gone.",
    )
  }
  const file = path.join(assets, matches[0])
  const bytes = readFileSync(file)
  return {
    file,
    raw: bytes.byteLength,
    gzipped: Bun.gzipSync(bytes).byteLength,
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const index = argv.indexOf("--dir")
  const trees =
    index === -1
      ? SYNCED_ASSET_DIRS.map((dir) => path.join(MOBILE_ROOT, dir))
      : [path.resolve(argv[index + 1])]
  let over = false
  for (const tree of trees) {
    let measured: ChunkMeasurement
    try {
      measured = measureHomeChunk(tree)
    } catch (error) {
      console.log(`${tree}: ${(error as Error).message}`)
      process.exit(1)
    }
    console.log(
      `${path.relative(MOBILE_ROOT, measured.file)}: ${measured.gzipped} bytes gzipped ` +
        `(${measured.raw} raw), budget ${HOME_CHUNK_BUDGET_BYTES}`,
    )
    if (measured.gzipped > HOME_CHUNK_BUDGET_BYTES) {
      console.log("  over the budget")
      over = true
    }
  }
  if (over) {
    console.log(
      "The Home chunk is over the budget. Either the code split boundary took on something " +
        "it should lazy load of its own, or the budget needs a measured, argued increase.",
    )
    process.exit(1)
  }
}

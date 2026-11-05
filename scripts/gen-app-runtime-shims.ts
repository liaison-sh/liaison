#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regenerate the Solid runtime shims under apps/web/public/_app-runtime/ from
// the host's installed solid-js. See scripts/lib/app-runtime-shims.ts for why
// a hand-maintained export list is a production outage waiting to happen.
//
// Usage:
//   bun run scripts/gen-app-runtime-shims.ts           # write
//   bun run scripts/gen-app-runtime-shims.ts --check   # verify, exit 1 on drift
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  readHostModuleExports,
  renderShim,
  SHIM_SPECIFIERS,
  shimPath,
} from "./lib/app-runtime-shims"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

export async function generateShims(repoRoot: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const specifier of SHIM_SPECIFIERS) {
    out[specifier] = renderShim(specifier, await readHostModuleExports(repoRoot, specifier))
  }
  return out
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check")
  const generated = await generateShims(REPO_ROOT)
  let drift = 0
  for (const specifier of SHIM_SPECIFIERS) {
    const target = shimPath(REPO_ROOT, specifier)
    const wanted = generated[specifier]
    const current = readFileSync(target, "utf8")
    if (current === wanted) continue
    drift += 1
    if (check) {
      console.error(`[gen-app-runtime-shims] DRIFT: ${target} is not what solid-js exports`)
    } else {
      writeFileSync(target, wanted)
      console.log(`[gen-app-runtime-shims] wrote ${target}`)
    }
  }
  if (check && drift > 0) {
    console.error("[gen-app-runtime-shims] run `bun run scripts/gen-app-runtime-shims.ts`")
    process.exit(1)
  }
  console.log(check ? "[gen-app-runtime-shims] shims in sync" : "[gen-app-runtime-shims] done")
}

if (import.meta.main) await main()

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regenerates apps/api/src/lib/manifest-regex-proven.json after a manifest's pattern
// changes: `bun run manifest-regex:prove`. It refuses to list a pattern it cannot
// prove; rewrite that pattern rather than the check.
import { writeFileSync } from "node:fs"
import { provePatternUnbounded } from "../apps/api/src/lib/manifest-regex"
import { PROVEN_LIST_PATH, shippedManifestPatterns } from "./lib/shipped-manifest-patterns"

const shipped = shippedManifestPatterns()
let refused = 0
for (const { flags, pattern, where } of shipped) {
  const reason = provePatternUnbounded(pattern, flags)
  if (reason !== null) {
    refused++
    console.error(`${where}: ${JSON.stringify(pattern)}: ${reason}`)
  }
}
if (refused > 0) process.exit(1)

const patterns = shipped.map(({ flags, pattern }) => ({ flags, pattern }))
writeFileSync(PROVEN_LIST_PATH, `${JSON.stringify({ patterns }, null, 2)}\n`)
console.log(`${patterns.length} patterns proven and listed in ${PROVEN_LIST_PATH}`)
process.exit(0)

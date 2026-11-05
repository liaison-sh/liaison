// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Refresh the demo door's committed email-domain snapshots:
//   apps/api/src/modules/demo/disposable-domains.txt  (CC0 disposable list)
//   apps/api/src/modules/demo/public-suffix.dat       (PSL, ICANN section)
// Run by hand, review the diff, commit. Never fetched at run time.
//
//   bun run scripts/refresh-demo-email-lists.ts
import { writeFileSync } from "node:fs"
import path from "node:path"

const DIR = path.resolve(import.meta.dir, "../apps/api/src/modules/demo")
const DISPOSABLE_URL =
  "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf"
const PSL_URL = "https://publicsuffix.org/list/public_suffix_list.dat"

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}

const today = new Date().toISOString().slice(0, 10)

const disposable = [
  ...new Set(
    (await fetchText(DISPOSABLE_URL))
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l !== "" && !l.startsWith("#")),
  ),
].sort()
writeFileSync(
  path.join(DIR, "disposable-domains.txt"),
  `# Disposable email domains. Snapshot of disposable_email_blocklist.conf from
# https://github.com/disposable-email-domains/disposable-email-domains (CC0 1.0), fetched ${today}.
# Refresh: bun run scripts/refresh-demo-email-lists.ts
${disposable.join("\n")}\n`,
)

const psl: string[] = []
let icann = false
for (const raw of (await fetchText(PSL_URL)).split("\n")) {
  if (raw.includes("===BEGIN ICANN DOMAINS===")) icann = true
  else if (raw.includes("===END ICANN DOMAINS===")) break
  else if (icann) {
    const line = raw.trim()
    if (line !== "" && !line.startsWith("//")) psl.push(line)
  }
}
writeFileSync(
  path.join(DIR, "public-suffix.dat"),
  `// Public Suffix List, ICANN section only, comments stripped.
// Source: ${PSL_URL} (fetched ${today}).
// License: Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/).
// Refresh: bun run scripts/refresh-demo-email-lists.ts
${psl.join("\n")}\n`,
)
console.log(`disposable: ${disposable.length} domains, public suffixes: ${psl.length} rules`)

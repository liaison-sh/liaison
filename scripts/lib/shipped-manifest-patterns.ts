// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every regular expression the repo itself ships to the manifest pattern check,
// exactly as it compiles there. `manifest-regex-proven.json` is generated from this
// list (scripts/gen-manifest-regex-proven.ts) and a guard holds the two equal.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { collectManifestPatterns, wholeValueSource } from "../../apps/api/src/lib/manifest-regex"
import { KERNEL_IMPORT_KINDS } from "../../apps/api/src/modules/imports/kernel-kinds"

export const REPO_ROOT = join(import.meta.dir, "..", "..")
export const PROVEN_LIST_PATH = join(REPO_ROOT, "apps/api/src/lib/manifest-regex-proven.json")

export interface ShippedPattern {
  flags: string
  pattern: string
  /** Where the repo declares it, for a failure message. */
  where: string
}

function manifestPaths(): string[] {
  const paths = [join(REPO_ROOT, "scripts/templates/app-template/app.manifest.json")]
  for (const dir of ["bundled-apps", "apps/api/src/apps"]) {
    for (const name of readdirSync(join(REPO_ROOT, dir))) {
      paths.push(join(REPO_ROOT, dir, name, "app.manifest.json"))
    }
  }
  return paths.filter((p) => statSync(p, { throwIfNoEntry: false })?.isFile())
}

/** Sorted, one entry per distinct flags and text. */
export function shippedManifestPatterns(): ShippedPattern[] {
  const found = new Map<string, ShippedPattern>()
  const add = (flags: string, pattern: string, where: string) => {
    found.set(`${flags}/${pattern}`, { flags, pattern, where })
  }
  for (const path of manifestPaths()) {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { name: string }
    for (const { where, pattern, flags } of collectManifestPatterns(manifest)) {
      add(flags, pattern, `${manifest.name}: ${where}`)
      // connections/oauth-manifest-knobs.ts matches these as the whole value.
      if (where.includes(".authorizeConfigParams.")) {
        add(flags, wholeValueSource(pattern), `${manifest.name}: ${where}, whole value`)
      }
    }
  }
  for (const [kind, decl] of Object.entries(KERNEL_IMPORT_KINDS)) {
    for (const { where, pattern, flags } of collectManifestPatterns({
      import: { kinds: { [kind]: decl } },
    })) {
      add(flags, pattern, `kernel import kind: ${where}`)
    }
  }
  return [...found.values()].sort(
    (a, b) => a.flags.localeCompare(b.flags) || a.pattern.localeCompare(b.pattern),
  )
}

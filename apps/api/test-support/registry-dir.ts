// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Review registries that many pull requests add to (allowlists, reviewed
// sources) also read one JSON file per change from a directory beside them.
// Two PRs that each add an entry then add two different files instead of two
// lines at the same end of one list, so neither has to merge the other.
// Entries already in a registry's literal stay there; new ones go in
// `<dir>/<feature>.json`. Every rule the registry's test applies (staleness:
// an entry nothing needs any more fails) applies to these entries the same.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const REPO = join(import.meta.dir, "..", "..", "..")

function files(dir: string): { name: string; data: unknown }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      name: relative(REPO, join(dir, f)),
      data: JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown,
    }))
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)

/**
 * Merge `<dir>/*.json` (`{ "<section>": { "<key>": "<why>" } }`) into the registry's sections:
 * a record gains `key → why`, a set gains `key`. An unknown section, a reason that is not a
 * sentence (under 10 characters) or a key the registry already holds throws.
 */
export function mergeRegistryDir(
  dir: string,
  sections: Record<string, Record<string, string> | Set<string>>,
): void {
  for (const { name, data } of files(dir)) {
    if (!isRecord(data)) throw new Error(`${name}: expected an object of sections`)
    for (const [section, entries] of Object.entries(data)) {
      const target = sections[section]
      if (!target) {
        throw new Error(
          `${name}: unknown section "${section}" (one of ${Object.keys(sections).join(", ")})`,
        )
      }
      if (!isRecord(entries)) throw new Error(`${name}: "${section}" must map keys to reasons`)
      for (const [key, why] of Object.entries(entries)) {
        if (typeof why !== "string" || why.trim().length < 10) {
          throw new Error(`${name}: ${section} "${key}" needs a reason of at least 10 characters`)
        }
        const held = target instanceof Set ? target.has(key) : key in target
        if (held) throw new Error(`${name}: ${section} "${key}" is already in the registry`)
        if (target instanceof Set) target.add(key)
        else target[key] = why
      }
    }
  }
}

/** Every tuple of `<dir>/*.json` (each file a JSON array of `width`-string arrays). */
export function readRegistryTuples(dir: string, width: number): string[][] {
  const out: string[][] = []
  for (const { name, data } of files(dir)) {
    if (!Array.isArray(data)) throw new Error(`${name}: expected an array of entries`)
    for (const entry of data) {
      if (
        !Array.isArray(entry) ||
        entry.length !== width ||
        !entry.every((v) => typeof v === "string")
      ) {
        throw new Error(`${name}: every entry is an array of ${width} strings`)
      }
      out.push(entry as string[])
    }
  }
  return out
}

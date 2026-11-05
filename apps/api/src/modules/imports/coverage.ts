// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import coverage (S13): which org-scoped tables no import kind writes and no
 * registry entry exempts. Pure, so the guard's discriminator can feed it a
 * fixture manifest.
 */
import type { CoverageEntry } from "~/modules/imports/coverage-registry"
import { KERNEL_IMPORT_KINDS } from "~/modules/imports/kernel-kinds"

export interface CoverageManifest {
  name: string
  schema?: Record<string, unknown>
  import?: { kinds: Record<string, { tables: string[] }> }
}

/** `app_<name>` for an app name (dashes become underscores). */
export function appSchemaName(app: string): string {
  return `app_${app.replace(/-/g, "_")}`
}

/** Tables an app declares in its manifest `schema`, schema-qualified. */
export function manifestTables(m: CoverageManifest): string[] {
  return Object.keys(m.schema ?? {}).map((t) => `${appSchemaName(m.name)}.${t}`)
}

/** The kernel kinds (kernel-kinds.ts) as one coverage manifest: no app owns them. */
export function kernelKindsCoverageManifest(): CoverageManifest {
  return { name: "kernel", import: { kinds: { ...KERNEL_IMPORT_KINDS } } }
}

/** Tables some import kind of these manifests writes. */
export function kindTables(manifests: CoverageManifest[]): Set<string> {
  const out = new Set<string>()
  for (const m of manifests) {
    for (const k of Object.values(m.import?.kinds ?? {})) for (const t of k.tables) out.add(t)
  }
  return out
}

export interface CoverageResult {
  /** Tables neither written by a kind nor in the registry. */
  uncovered: string[]
  /** Registry entries for a table a kind now writes (drop the entry). */
  redundant: string[]
}

export function checkCoverage(args: {
  tables: Iterable<string>
  manifests: CoverageManifest[]
  registry: Readonly<Record<string, CoverageEntry>>
}): CoverageResult {
  const written = kindTables(args.manifests)
  const all = new Set(args.tables)
  for (const m of args.manifests) for (const t of manifestTables(m)) all.add(t)
  const uncovered = [...all].filter((t) => !written.has(t) && !(t in args.registry)).sort()
  const redundant = Object.keys(args.registry)
    .filter((t) => written.has(t))
    .sort()
  return { uncovered, redundant }
}

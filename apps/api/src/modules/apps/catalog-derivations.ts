// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Instance-wide derivations of the installed catalog.
 *
 * The `kernel.files` SELECT policy (its file parents) and the unified search
 * index (its settings and shape fingerprint) are instance-wide, and every org
 * runs the same app set. So they are computed from the catalog
 * (`getDefaultApps()`) plus the kernel's own declarations, never from the orgs
 * a process happens to have registered: a process that registered no org
 * derives exactly what one that registered all of them derives.
 *
 * The per-entity mappings below are the same ones an org's registration uses
 * (`registerSingleApp` in runtime.ts, `collectSearchableRegistrations`), so
 * the two paths cannot drift apart.
 */

import { isRecord } from "~/lib/guards"
import { manifestFileParentRegistry } from "~/modules/apps/app-registries"
import type { AppDescriptor } from "~/modules/apps/runtime"
import type { FileParentRegistration } from "~/modules/files/rls-builder"
import {
  type SettingsInputs,
  searchShapeFingerprintOf,
  settingsInputsOf,
} from "~/modules/search/index-shape"
import {
  type SearchableEntityDecl,
  type SearchableEntitySource,
  type SearchableRegistrations,
  searchableRegistrationsFrom,
} from "~/modules/search/searchable-entities"

/** The kernel's own file parents: always first in the policy, in this order. */
export const KERNEL_FILE_PARENTS: readonly FileParentRegistration[] = [
  {
    app: "kernel",
    entityType: "thread",
    schemaRef: "kernel",
    tableName: "threads",
    joinOn: "id",
  },
  {
    app: "kernel",
    entityType: "message",
    schemaRef: "kernel",
    tableName: "messages",
    joinOn: "id",
    // A deleted message's attachments are never readable.
    softDeleteColumn: "deleted_at",
  },
  // A document template's files (migration 0255): visible with the template.
  {
    app: "kernel",
    entityType: "document_template",
    schemaRef: "kernel",
    tableName: "document_templates",
    joinOn: "id",
  },
  // file_upload_session staging parent. The session row itself is gated by
  // `file_upload_sessions_owner`, so the EXISTS join through the policy only
  // matches the session owner — that is the intended permission model.
  {
    app: "kernel",
    entityType: "file_upload_session",
    schemaRef: "kernel",
    tableName: "file_upload_sessions",
    joinOn: "id",
  },
]

/** A manifest entity's `fileParent`, with its parent table's retention when immutable. */
export interface ManifestFileParentDecl {
  tableName: string
  schemaRef: string
  joinOn: string
  readScope: string
  writeScope: string
  /** Delete: the uploader, or a holder of this scope. Absent: writeScope alone. */
  deleteScope?: string
  retention?: { retentionYears: number; anchor: string }
}

/** A file parent of the policy; an app's carries its retention when its table is immutable. */
export type CatalogFileParent = FileParentRegistration & {
  retention?: ManifestFileParentDecl["retention"]
}

/**
 * The file parent one manifest entity declares, or undefined. A parent row in
 * an immutable table carries its retention, so the kernel file delete path
 * refuses to delete the row's files within it.
 */
export function manifestFileParentOf(
  desc: AppDescriptor,
  entityDef: unknown,
): ManifestFileParentDecl | undefined {
  if (!isRecord(entityDef) || !isRecord(entityDef.fileParent)) return undefined
  const fp = entityDef.fileParent
  const str = (k: string): string => (typeof fp[k] === "string" ? fp[k] : "")
  const fileParent: ManifestFileParentDecl = {
    ...fp,
    tableName: str("tableName"),
    schemaRef: str("schemaRef"),
    joinOn: str("joinOn"),
    readScope: str("readScope"),
    writeScope: str("writeScope"),
    ...(typeof fp.deleteScope === "string" && fp.deleteScope
      ? { deleteScope: fp.deleteScope }
      : {}),
  }
  const schema = isRecord(desc.schema) ? desc.schema : undefined
  const table = schema?.[fileParent.tableName]
  const immutable = isRecord(table) && isRecord(table.immutable) ? table.immutable : undefined
  if (!immutable || typeof immutable.retentionYears !== "number") return fileParent
  return {
    ...fileParent,
    retention: {
      retentionYears: immutable.retentionYears,
      anchor: typeof immutable.anchor === "string" ? immutable.anchor : "created_at",
    },
  }
}

/**
 * The policy's parents: the kernel's first, then each app entity's, sorted by
 * `app:entity` so the policy statement does not depend on registration or
 * catalog order. The first declaration of a key wins.
 */
function fileParentsFrom(
  entries: Iterable<{ app: string; entityType: string; decl: ManifestFileParentDecl }>,
): CatalogFileParent[] {
  const byKey = new Map<string, CatalogFileParent>()
  for (const { app, entityType, decl } of entries) {
    const key = `${app}:${entityType}`
    if (byKey.has(key)) continue
    byKey.set(key, {
      app,
      entityType,
      schemaRef: decl.schemaRef,
      tableName: decl.tableName,
      joinOn: decl.joinOn,
      ...(decl.retention ? { retention: decl.retention } : {}),
    })
  }
  const kernelKeys = new Set(KERNEL_FILE_PARENTS.map((p) => `${p.app}:${p.entityType}`))
  const apps = [...byKey.entries()]
    .filter(([key]) => !kernelKeys.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, p]) => p)
  return [...KERNEL_FILE_PARENTS.map((p) => ({ ...p })), ...apps]
}

function entitiesOf(desc: AppDescriptor): Array<[string, SearchableEntityDecl]> {
  // A manifest's `entities` is the same JSON the registration stores per org.
  const entities: Record<string, SearchableEntityDecl> | undefined =
    desc.entities && typeof desc.entities === "object" && !Array.isArray(desc.entities)
      ? desc.entities
      : undefined
  return entities ? Object.entries(entities).filter(([, d]) => isRecord(d)) : []
}

/** The files SELECT policy's parents for this catalog. */
export function catalogFileParents(apps: readonly AppDescriptor[]): CatalogFileParent[] {
  const entries: Array<{ app: string; entityType: string; decl: ManifestFileParentDecl }> = []
  for (const desc of apps) {
    for (const [entityType, entityDef] of entitiesOf(desc)) {
      const decl = manifestFileParentOf(desc, entityDef)
      if (decl) entries.push({ app: desc.name, entityType, decl })
    }
  }
  return fileParentsFrom(entries)
}

/** What the unified search index should be for this catalog. */
export interface CatalogSearchInputs {
  registrations: SearchableRegistrations
  settings: Required<SettingsInputs>
  /** The shape fingerprint (`index-shape.ts`): the stored derivation the checks compare first. */
  fingerprint: string
  /** The catalog's app versions, stored with the built index (`catalogVersions`). */
  versions: CatalogVersions
}

/** The search settings inputs and shape fingerprint for this catalog. */
export function catalogSearchInputs(apps: readonly AppDescriptor[]): CatalogSearchInputs {
  const sources: SearchableEntitySource[] = []
  for (const desc of apps) {
    for (const [entityType, decl] of entitiesOf(desc)) {
      sources.push({ app: desc.name, entityType, decl })
    }
  }
  sources.sort((a, b) => {
    const ka = `${a.app}:${a.entityType}`
    const kb = `${b.app}:${b.entityType}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  const registrations = searchableRegistrationsFrom(sources)
  return {
    registrations,
    settings: settingsInputsOf(registrations),
    fingerprint: searchShapeFingerprintOf(registrations),
    versions: catalogVersions(apps),
  }
}

/** Each catalog app's version, by name: recorded with every derivation applied. */
export type CatalogVersions = Record<string, string>

export function catalogVersions(apps: readonly AppDescriptor[]): CatalogVersions {
  const out: CatalogVersions = {}
  for (const desc of [...apps].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    out[desc.name] ??= desc.version
  }
  return out
}

/**
 * The first app that `stored` (the catalog a derivation was applied from) holds
 * at a newer version than `ours`, or undefined. A process whose catalog is
 * older than the applied one (an old release restarting during a rolling
 * deploy) must not write its derivation over the newer one. Apps only one side
 * has are not compared: an app removed from the catalog never blocks later writes.
 */
export async function supersedingApp(
  stored: CatalogVersions,
  ours: CatalogVersions,
): Promise<string | undefined> {
  const { isNewerVersion } = await import("~/modules/apps/activation")
  for (const [name, version] of Object.entries(stored)) {
    const mine = ours[name]
    if (mine !== undefined && isNewerVersion(version, mine)) return name
  }
  return undefined
}

/** `CatalogVersions` from stored JSON; undefined when it is not one. */
export function parseCatalogVersions(raw: unknown): CatalogVersions | undefined {
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!isRecord(value)) return undefined
  const out: CatalogVersions = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v
  return out
}

/** The installed catalog's derivations, read now. */
export async function currentCatalog(): Promise<AppDescriptor[]> {
  const { getDefaultApps } = await import("~/modules/apps/init")
  return getDefaultApps()
}

/**
 * Test access, grouped in one object so the production surface carries a single
 * named door. Production code never calls it.
 */
export const CatalogDerivationsTestAccess = {
  /**
   * The parents the per-org registries hold, through the same mapping the
   * catalog uses: what the policy was built from before it came from the
   * catalog. Tests that register a fixture parent pass this to
   * `rebuildFilesSelectPolicy({ parents })`.
   */
  registryFileParents(): CatalogFileParent[] {
    const entries: Array<{ app: string; entityType: string; decl: ManifestFileParentDecl }> = []
    for (const [[, app, entityType], decl] of manifestFileParentRegistry.entries()) {
      entries.push({ app, entityType, decl })
    }
    return fileParentsFrom(entries)
  },
}

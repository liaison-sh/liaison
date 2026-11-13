// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import kinds visible to an org: every `import.kinds` entry of the apps
 * registered for it, plus the kernel kinds (kernel-kinds.ts), which every org
 * has. A kind's full name is `<app>.<kind>` (`tickets.ticket`).
 */
import { spawnSync } from "node:child_process"
import { importRegistry } from "~/modules/apps/app-registries"
import { bridgeManifestOf } from "~/modules/apps/bridge-manifest"
import { bakedCatalogPackage } from "~/modules/apps/catalog"
import { ensureAppsForOrg } from "~/modules/apps/init"
import type { ParentResolution } from "~/modules/files/service"
import { BUILTIN_IMPORT_KINDS } from "~/modules/imports/builtin-kinds"
import { KERNEL_IMPORT_KINDS } from "~/modules/imports/kernel-kinds"
import {
  type ImportDecl,
  type ImportKindDecl,
  importDeclarationErrors,
  importKindRestrictionErrors,
  ownAppSchema,
} from "~/modules/imports/kind-schema"

export interface ImportKindInfo {
  /** `<app>.<name>`, e.g. `tickets.ticket`. */
  kind: string
  app: string
  name: string
  decl: ImportKindDecl
  /** Set when the app has a handler bundle (installed apps). */
  bundle?: { bundlePath: string; core: boolean }
  /** The app's file parents, for a kind resolved without registering the app
   *  (the CLI); a registered app's come from the file-parent registry. */
  fileParents?: Record<string, ParentResolution>
  manifest?: Record<string, unknown>
}

/** Split `<app>.<name>`; `null` when the name has no app part. */
export function splitKindName(kind: string): { app: string; name: string } | null {
  const dot = kind.indexOf(".")
  if (dot <= 0 || dot === kind.length - 1) return null
  return { app: kind.slice(0, dot), name: kind.slice(dot + 1) }
}

/** A kernel kind by full name: no app registration, no bundle. */
function kernelKind(kind: string): ImportKindInfo | null {
  const decl = KERNEL_IMPORT_KINDS[kind]
  const parts = splitKindName(kind)
  return decl && parts ? { kind, app: parts.app, name: parts.name, decl } : null
}

/** Every import kind registered for the org, and the kernel kinds, sorted by full name. */
export async function listImportKinds(orgId: string): Promise<ImportKindInfo[]> {
  await ensureAppsForOrg(orgId)
  const out: ImportKindInfo[] = []
  for (const name of Object.keys(KERNEL_IMPORT_KINDS)) {
    const k = kernelKind(name)
    if (k) out.push(k)
  }
  for (const [[regOrgId, app], entry] of importRegistry.entriesOf(orgId)) {
    if (regOrgId !== orgId) continue
    for (const [name, decl] of Object.entries(entry.kinds)) {
      // A kernel kind's name is never taken over by an app's kind.
      if (`${app}.${name}` in KERNEL_IMPORT_KINDS) continue
      out.push({
        kind: `${app}.${name}`,
        app,
        name,
        decl,
        ...(entry.bundle && !(`${app}.${name}` in BUILTIN_IMPORT_KINDS)
          ? { bundle: entry.bundle }
          : {}),
        ...(entry._manifest ? { manifest: entry._manifest } : {}),
      })
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind))
}

/**
 * One kind by full name: a kernel kind, else what is registered right now, or
 * the built-in manifests' declaration when `builtinFallback` is set. Never
 * registers apps.
 */
export function lookupImportKind(
  orgId: string,
  kind: string,
  builtinFallback: boolean,
): ImportKindInfo | null {
  const kernel = kernelKind(kind)
  if (kernel) return kernel
  const parts = splitKindName(kind)
  if (!parts) return null
  const entry = importRegistry.get([orgId, parts.app])
  const decl = entry?.kinds[parts.name]
  if (!entry || !decl) {
    const builtin = builtinFallback ? BUILTIN_IMPORT_KINDS[kind] : undefined
    return builtin ? { kind, app: parts.app, name: parts.name, decl: builtin } : null
  }
  // A built-in app's kind runs its host handler: its handler bundle (the
  // app's tools) does not make the kind a bundled one.
  const bundled = entry.bundle && !(kind in BUILTIN_IMPORT_KINDS)
  return {
    kind,
    app: parts.app,
    name: parts.name,
    decl,
    ...(bundled ? { bundle: entry.bundle } : {}),
    ...(entry._manifest ? { manifest: entry._manifest } : {}),
  }
}

/** The file parents a manifest's entities declare (`entities.<x>.fileParent`). */
function fileParentsOf(app: string, entities: unknown): Record<string, ParentResolution> {
  const out: Record<string, ParentResolution> = {}
  if (entities === null || typeof entities !== "object") return out
  for (const [entityType, entity] of Object.entries(entities)) {
    const fp =
      entity !== null && typeof entity === "object"
        ? (entity as Record<string, unknown>).fileParent
        : undefined
    if (fp === null || typeof fp !== "object") continue
    const f = fp as Record<string, unknown>
    if (
      typeof f.tableName === "string" &&
      typeof f.joinOn === "string" &&
      typeof f.readScope === "string" &&
      typeof f.writeScope === "string"
    ) {
      out[entityType] = {
        // An installed app's parent always lives in its own schema.
        schemaRef: ownAppSchema(app),
        tableName: f.tableName,
        joinOn: f.joinOn,
        readScope: f.readScope,
        writeScope: f.writeScope,
      }
    }
  }
  return out
}

/**
 * An installed (`.liaisonapp`) app's kind, read from its active version's
 * manifest and bundle without registering the app: the same descriptor
 * registration builds (`readInstalledAppDescriptor`), the same table rule
 * (its own `app_<name>` schema only). Always sandboxed.
 */
async function installedImportKind(kind: string): Promise<ImportKindInfo | null> {
  const parts = splitKindName(kind)
  if (!parts) return null
  const { readInstalledAppDescriptor } = await import("~/modules/apps/init")
  const desc = await readInstalledAppDescriptor(parts.app)
  if (!desc) return null
  const fields = new Map<string, unknown>(Object.entries(desc))
  const importDecl = fields.get("import")
  const bundlePath = fields.get("_bundlePath")
  if (typeof bundlePath !== "string" || bundlePath.length === 0) return null
  if (importDeclarationErrors(importDecl, parts.app).length > 0) return null
  const kinds = (importDecl as ImportDecl).kinds
  const decl = Object.hasOwn(kinds, parts.name) ? kinds[parts.name] : undefined
  if (!decl) return null
  if (importKindRestrictionErrors(parts.app, parts.name, decl, { builtin: false }).length > 0) {
    return null
  }
  return {
    kind,
    app: parts.app,
    name: parts.name,
    decl,
    bundle: { bundlePath, core: false },
    manifest: { ...bridgeManifestOf(desc) },
    fileParents: fileParentsOf(parts.app, fields.get("entities")),
  }
}

/**
 * One kind by full name, or `null` when the org has no such kind. The API
 * resolves kinds from the org's registered apps (registering them first); the
 * CLI (`ensureApps: false`) never registers apps: it falls back to the
 * built-in manifests, then to an installed app's active manifest.
 */
export async function getImportKind(
  orgId: string,
  kind: string,
  opts: { ensureApps?: boolean } = {},
): Promise<ImportKindInfo | null> {
  const ensure = opts.ensureApps !== false
  const found = lookupImportKind(orgId, kind, !ensure)
  if (found) return found
  if (!ensure) return installedImportKind(kind)
  await ensureAppsForOrg(orgId)
  return lookupImportKind(orgId, kind, false)
}

/** The largest manifest read out of a baked catalog tarball. */
const CATALOG_MANIFEST_MAX_BYTES = 2 * 1024 * 1024

/**
 * The import kind names a BAKED catalog app's manifest declares (`document`,
 * not `invoicing.document`), read from its tarball without installing it;
 * null when the catalog bakes no such app or its manifest cannot be read.
 * The tarball is the image's own first-party content.
 */
export function catalogAppImportKinds(app: string): string[] | null {
  let tarballPath: string
  try {
    tarballPath = bakedCatalogPackage(app).tarballPath
  } catch {
    return null
  }
  for (const member of ["app.manifest.json", "./app.manifest.json"]) {
    const out = spawnSync("tar", ["-xzOf", tarballPath, member], {
      maxBuffer: CATALOG_MANIFEST_MAX_BYTES,
    })
    if (out.status !== 0 || !out.stdout) continue
    try {
      const manifest: unknown = JSON.parse(out.stdout.toString("utf8"))
      const decl =
        manifest !== null && typeof manifest === "object"
          ? (manifest as Record<string, unknown>).import
          : undefined
      const kinds =
        decl !== null && typeof decl === "object"
          ? (decl as Record<string, unknown>).kinds
          : undefined
      return kinds !== null && typeof kinds === "object" ? Object.keys(kinds) : []
    } catch {
      return null
    }
  }
  return null
}

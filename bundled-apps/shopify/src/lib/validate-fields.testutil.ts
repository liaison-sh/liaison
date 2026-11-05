// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-fidelity helper mirroring the sandbox bridge's write-path field
// validation (apps/api/src/modules/apps/sandbox/rpc-bridge.ts#validateFields).
//
// The job/handler test mocks historically used a PERMISSIVE `db.insert`/
// `db.update` that recorded whatever payload it was given. That is exactly why
// undeclared-field drift shipped: a write carrying `updatedAt`/`createdAt` (or
// any column not in the manifest's `fields` allowlist) silently "worked" in the
// unit test while throwing `Unknown field` at runtime.
//
// Important: the kernel's WRITE path validates against the declared `fields`
// allowlist ONLY — it does NOT consult the base-entity fields (id/createdAt/
// updatedAt) the read path tolerates. The kernel auto-manages created_at /
// updated_at, so a handler must never pass them. This helper reproduces that
// exact contract from the REAL app.manifest.json so a drifting write fails the
// unit test instead of at runtime.
import { readFileSync } from "node:fs"
import { join } from "node:path"

interface ManifestSchema {
  schema?: Record<string, { fields?: Record<string, unknown> }>
}

let cachedManifest: ManifestSchema | null = null

function loadManifest(): ManifestSchema {
  if (cachedManifest) return cachedManifest
  const manifestPath = join(import.meta.dir, "..", "..", "app.manifest.json")
  cachedManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestSchema
  return cachedManifest
}

/**
 * Throw exactly as the bridge does when a write payload carries a field not in
 * the entity's declared `fields` map. Mirrors rpc-bridge.ts#validateFields: an
 * entity with no `fields` map is not writable, and undeclared keys are rejected
 * (base entity columns like `id`/`createdAt`/`updatedAt` are NOT exempt on the
 * write path — the kernel sets them).
 */
export function validateFields(
  entity: string,
  data: Record<string, unknown>,
): void {
  const entityDef = loadManifest().schema?.[entity]
  if (!entityDef?.fields) {
    throw new Error(
      `Entity "${entity}" declares no fields and is not writable. Declare a "fields" map for "${entity}" in the manifest schema to allow db_insert/db_update.`,
    )
  }
  const declared = new Set(Object.keys(entityDef.fields))
  for (const key of Object.keys(data)) {
    if (!declared.has(key)) {
      throw new Error(
        `Unknown field "${key}" on entity "${entity}". Declared fields: ${[...declared].join(", ")}`,
      )
    }
  }
}

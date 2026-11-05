// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Oracle: every bundled app's declared `schema` must survive the SAME descriptor
// validation the kernel applies at install time.
//
// Why this exists. A bundled app once shipped a table whose indexes included
// `created_at`. That column is real (the kernel adds id/org_id/created_at/
// updated_at to every app table) but it is IMPLICIT, not a declared field, and
// `validateAppManifest` only permits indexes over declared fields. The
// descriptor was rejected, so the table was never created.
//
// The dangerous part was the silence: the install call answered 200 with the
// app's name and version and logged "Installed catalog app"; the rejection
// appeared only as an "Invalid app descriptor" error line in the server log.
// An operator trusting the API response would believe the app installed while
// every read and write against its storage was about to fail at runtime.
//
// So: validate the shipped manifests here, where a red test is unmissable,
// instead of trusting a 200 that does not mean what it says.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { validateAppManifest } from "./contract"

const BUNDLED_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "bundled-apps")

function bundledManifests(): Array<{ app: string; manifest: unknown }> {
  return readdirSync(BUNDLED_DIR)
    .filter((d) => {
      try {
        return statSync(join(BUNDLED_DIR, d)).isDirectory()
      } catch {
        return false
      }
    })
    .map((app) => ({ app, path: join(BUNDLED_DIR, app, "app.manifest.json") }))
    .filter(({ path }) => {
      try {
        statSync(path)
        return true
      } catch {
        return false
      }
    })
    .map(({ app, path }) => ({ app, manifest: JSON.parse(readFileSync(path, "utf8")) }))
}

describe("bundled app descriptors", () => {
  it("finds the bundled apps (guards against a vacuously passing sweep)", () => {
    expect(bundledManifests().length).toBeGreaterThan(0)
  })

  it("every bundled manifest passes install-time descriptor validation", () => {
    const failures: string[] = []
    for (const { app, manifest } of bundledManifests()) {
      const result = validateAppManifest(manifest)
      if (!result.success) failures.push(`${app}: ${result.error ?? "invalid"}`)
    }
    expect(failures).toEqual([])
  })

  it("no schema indexes or unique constraints reference an implicit kernel column", () => {
    // id/org_id/created_at/updated_at are added by generateTableDdl, never
    // declared, so indexing them is always the rejected-descriptor bug above.
    const IMPLICIT = new Set(["id", "org_id", "created_at", "updated_at"])
    const offenders: string[] = []
    for (const { app, manifest } of bundledManifests()) {
      const schema = (
        manifest as {
          schema?: Record<
            string,
            {
              indexes?: Array<string[] | { columns?: string[] }>
              constraints?: { unique?: Array<{ columns?: string[] }> }
            }
          >
        }
      ).schema
      for (const [entity, def] of Object.entries(schema ?? {})) {
        const cols = [
          ...(def.indexes ?? []).flatMap((i) => (Array.isArray(i) ? i : (i.columns ?? []))),
          ...(def.constraints?.unique ?? []).flatMap((u) => u.columns ?? []),
        ]
        for (const c of cols) {
          if (IMPLICIT.has(c)) offenders.push(`${app}.${entity} indexes implicit column "${c}"`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Guard: every manifest entity declared `searchable: true` must also declare
// `indexFields.title`, naming a real column to index as the document title.
//
// Without this, a searchable entity with no indexFields still gets a
// document written to MeiliSearch (the indexer only gates on `searchable`),
// but doc-builder.ts only ever sets `doc.title` from `indexFields.title`
// (search/doc-builder.ts) -- so the document lands with a null title and
// null body: present in global search, but blank and effectively
// unfindable by its own text. This bit bundled-apps/social's `finding`
// entity: `searchable: true` with no `indexFields` at all, invisible only
// because its create/update events used to fall through the indexer's
// action-alias table; once those aliases were added every finding started
// writing a blank document.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const BUNDLED_DIR = join(REPO_ROOT, "bundled-apps")
const API_APPS_DIR = join(REPO_ROOT, "apps", "api", "src", "apps")

// Kernel-contract fixture apps, never installed for a real org or served to
// users. `test` and `example` exist to exercise the manifest/tool-execution
// contract itself and predate the indexFields requirement; excluded here by
// name rather than silently skipped everywhere else.
const FIXTURE_APPS_WITHOUT_INDEX_FIELDS = new Set(["test", "example"])

function manifestPaths(): Array<{ app: string; path: string }> {
  const dirs = [BUNDLED_DIR, API_APPS_DIR]
  const out: Array<{ app: string; path: string }> = []
  for (const dir of dirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name, "app.manifest.json")
      try {
        readFileSync(path)
      } catch {
        continue
      }
      out.push({ app: entry.name, path })
    }
  }
  return out
}

describe("searchable entities declare indexFields.title", () => {
  const manifests = manifestPaths()

  it("finds manifests to check at all", () => {
    expect(manifests.length).toBeGreaterThan(3)
    expect(manifests.map((m) => m.app)).toContain("social")
  })

  for (const { app, path } of manifests) {
    if (FIXTURE_APPS_WITHOUT_INDEX_FIELDS.has(app)) continue

    it(`${app}: every searchable entity declares indexFields.title`, () => {
      const manifest = JSON.parse(readFileSync(path, "utf8"))
      const entities = manifest.entities ?? {}
      for (const [entityName, entity] of Object.entries(entities) as [string, any][]) {
        if (!entity?.searchable) continue
        const title = entity.indexFields?.title
        if (typeof title !== "string" || title.length === 0) {
          throw new Error(
            `${app}.${entityName} is searchable but has no indexFields.title naming a column`,
          )
        }
      }
    })
  }
})
